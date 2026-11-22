import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Dataset, SampleManifest, StandardRule } from '../src/domain/types';
import { parseSampleFromDisk } from '../scripts/sampleIo';
import { mergeDataset } from '../src/sample/ingest';
import { deriveDayEvents, compareDerivations, computeSignatureLight } from '../src/domain/events';
import { buildStandardContext } from '../src/domain/standards';
import { buildDraft, checkReportDraft, reopenDraft } from '../src/domain/dailyReport';
import { linkDispositions, lateDispositionEffect } from '../src/domain/dispositions';
import { resolveDayEvents, makeSnapshotRecord, diffCaches, truncatePriorStandards, reviseStandard } from '../src/domain/eventService';
import { dayStartMs } from '../src/domain/time';

const sampleDir = resolve(__dirname, '../public/sample');
const manifest = JSON.parse(readFileSync(resolve(sampleDir, 'manifest.json'), 'utf8')) as SampleManifest;
const { baseDataset, lateReadings, lateDispositions } = parseSampleFromDisk(sampleDir, manifest);
const DAY = manifest.focus.day;
const POINT = manifest.focus.pointCode;
const at = (h: number, m = 0, s = 0) => dayStartMs(DAY) + h * 3_600_000 + m * 60_000 + s * 1000;

const base = deriveDayEvents(baseDataset, POINT, DAY, { strategy: 'DERIVE_ON_DEMAND' });
const augmented: Dataset = mergeDataset(baseDataset, { readings: lateReadings, dispositions: lateDispositions });

function eventAt(summary: ReturnType<typeof deriveDayEvents>, from: number, pollutant = 'COD' as const) {
  return summary.events.find((e) => e.pollutant === pollutant && Math.abs(e.startAt - from) < 60_000);
}

describe('事件推导：不是逐行阈值比较', () => {
  it('40 秒冲击按插值穿越给出恰好 40 秒', () => {
    const shock = eventAt(base, at(9, 15, 0));
    expect(shock).toBeDefined();
    expect(shock!.measuredSeconds + shock!.interpolatedSeconds).toBeCloseTo(40, 1);
    expect(shock!.interpolatedSeconds).toBeGreaterThan(0);
    expect(shock!.limit).toBe(50);
    expect(shock!.status).toBe('CLOSED');
    expect(shock!.peak).toBeCloseTo(145, 1);
  });

  it('持续平台有实测连续超限证据', () => {
    const plateau = eventAt(base, at(17, 0, 0));
    expect(plateau).toBeDefined();
    expect(plateau!.measuredSeconds).toBeGreaterThan(200);
    expect(plateau!.evidence.segments.some((s) => s.kind === 'MEASURED')).toBe(true);
  });

  it('清洗开始立即终止插值链，事件保持开放', () => {
    const rising = base.events.find((e) => e.startAt > at(20, 30) && e.startAt < at(21, 1));
    expect(rising).toBeDefined();
    expect(rising!.status).toBe('OPEN_DATA_GAP');
    expect(rising!.endAt).toBeNull();
    const flush = base.gaps.find((g) => g.kind === 'EXCLUDED_STATE' && Math.abs(g.from - at(21, 0)) < 1000);
    expect(flush).toBeDefined();
    expect(flush!.possibleExceedance).toBe(true);
    expect(flush!.insideEvent).toBe(false);
  });

  it('限值调整切开事件，两侧分别引用各自标准窗口', () => {
    const before = base.events.find((e) => e.limit === 50 && e.startAt > at(18, 30) && e.startAt < at(19, 0));
    const after = eventAt(base, at(19, 0, 0));
    expect(before).toBeDefined();
    expect(before!.status).toBe('OPEN_LIMIT_CHANGE');
    expect(before!.limitChangeAt).toBe(at(19, 0));
    expect(after).toBeDefined();
    expect(after!.limit).toBe(40);
    expect(after!.standardId).toContain('LOCAL');
  });

  it('采样空档嵌在事件中：未知时长单列，不算作超标', () => {
    const ev = eventAt(base, at(22, 0, 0));
    expect(ev).toBeDefined();
    expect(ev!.unknownSeconds).toBeCloseTo(240, 0);
    expect(ev!.evidence.continuous).toBe(false);
    const gap = base.gaps.find((g) => g.kind === 'SAMPLING_GAP' && Math.abs(g.from - at(22, 4)) < 1000);
    expect(gap).toBeDefined();
    expect(gap!.insideEvent).toBe(true);
    expect(gap!.possibleExceedance).toBe(true);
    expect(gap!.effect).toMatch(/不得据相邻高值臆造持续超标|空档内不计入超标时长/);
  });

  it('边界读数恰在限值上只能判为开放（HX-E03）', () => {
    const hx = deriveDayEvents(baseDataset, 'HX-E03', DAY);
    const ev = hx.events.find((e) => e.pollutant === 'COD');
    expect(ev).toBeDefined();
    expect(ev!.status).toBe('OPEN_BOUNDARY');
    expect(ev!.endAt).toBeNull();
    expect(ev!.evidence.segments[ev!.evidence.segments.length - 1].endReason).toBe('CENSOR_BOUNDARY');
  });
});

describe('两种派生方案一致性', () => {
  it('同一冻结输入给出完全相同的事件集合', () => {
    const a = deriveDayEvents(baseDataset, POINT, DAY, { strategy: 'PERSIST_SNAPSHOT' });
    const b = deriveDayEvents(baseDataset, POINT, DAY, { strategy: 'DERIVE_ON_DEMAND' });
    const eq = compareDerivations(a, b);
    expect(eq.equal).toBe(true);
    expect(eq.signatureEqual).toBe(true);
    expect(eq.eventCount).toBe(base.events.length);
  });

  it('LH-E03 / 其他点位同样一致', () => {
    for (const point of baseDataset.points.map((p) => p.pointCode)) {
      const a = deriveDayEvents(baseDataset, point, DAY, { strategy: 'PERSIST_SNAPSHOT' });
      const b = deriveDayEvents(baseDataset, point, DAY, { strategy: 'DERIVE_ON_DEMAND' });
      expect(compareDerivations(a, b).equal, point).toBe(true);
    }
  });
});

describe('缓存失效与派生影响', () => {
  it('迟到补传改变输入签名，旧快照被判过旧且不得用于当前证据', () => {
    const before = deriveDayEvents(baseDataset, POINT, DAY, { strategy: 'PERSIST_SNAPSHOT' });
    const record = makeSnapshotRecord(before);
    const sigAfter = computeSignatureLight(augmented, POINT, DAY);
    expect(sigAfter.signature).not.toBe(before.inputSignature.signature);

    const stale = resolveDayEvents(augmented, POINT, DAY, 'PERSIST_SNAPSHOT', record, { allowRefresh: false });
    expect(stale.summary).toBeNull();
    expect(stale.cacheFresh).toBe(false);
    expect(stale.notes.join('')).toContain('代替当前证据');

    const refreshed = resolveDayEvents(augmented, POINT, DAY, 'PERSIST_SNAPSHOT', record, { allowRefresh: true });
    expect(refreshed.summary).not.toBeNull();
    expect(refreshed.servedFromCache).toBe(false);
  });

  it('查询时推导始终以当前证据现算', () => {
    const record = makeSnapshotRecord(deriveDayEvents(baseDataset, POINT, DAY));
    const res = resolveDayEvents(augmented, POINT, DAY, 'DERIVE_ON_DEMAND', record);
    expect(res.servedFromCache).toBe(false);
    expect(res.summary?.inputSignature.signature).toBe(computeSignatureLight(augmented, POINT, DAY).signature);
  });

  it('刷新影响逐项说明新增/删除/变更', () => {
    const before = makeSnapshotRecord(deriveDayEvents(baseDataset, POINT, DAY));
    const after = makeSnapshotRecord(deriveDayEvents(augmented, POINT, DAY));
    const diff = diffCaches(before, after);
    expect(diff.reasons.length).toBeGreaterThan(0);
    expect(diff.reasons.join('')).toMatch(/读数数量|迟到|签名/);
  });
});

describe('限值调整的派生影响', () => {
  it('新增更严限值后旧快照成批失效，并切出新的事件', () => {
    const before = deriveDayEvents(baseDataset, POINT, DAY);
    const cut = at(10, 0);
    const truncated = truncatePriorStandards(baseDataset, { pointCode: POINT, pollutant: 'COD', effectiveFrom: cut }, 'test');
    const rule = reviseStandard({
      pointCode: POINT,
      pollutant: 'COD',
      limit: 30,
      effectiveFrom: cut,
      basis: '测试加严',
      grade: '测试',
      by: 'test',
      note: '测试',
    });
    const revised = mergeDataset(baseDataset, { standards: [...truncated, rule] });
    const after = deriveDayEvents(revised, POINT, DAY);
    expect(after.windows.filter((w) => w.pollutant === 'COD').map((w) => w.limit)).toEqual([50, 30, 40]);
    const diff = diffCaches(makeSnapshotRecord(before), makeSnapshotRecord(after));
    expect(diff.reasons.join('')).toContain('限值');
    expect(diff.added.length + diff.removed.length).toBeGreaterThan(0);
    expect(after.inputSignature.standardRevision).not.toBe(before.inputSignature.standardRevision);
  });
});

describe('申报核对与草稿', () => {
  const draft = buildDraft(base, {
    createdBy: 'test',
    now: at(0),
    cutoffReceivedAt: Date.UTC(2026, 10, 18, 23, 20, 0),
    strategy: 'DERIVE_ON_DEMAND',
    serial: 1,
  });

  it('上报值只计实测 + 插值，未知空档单列', () => {
    const cod = draft.rows.find((r) => r.pollutant === 'COD')!;
    const unknown = cod.unknownSeconds;
    expect(unknown).toBeGreaterThanOrEqual(240);
    expect(cod.reportableSeconds).toBeCloseTo(cod.measuredSeconds + cod.interpolatedSeconds, 6);
    const ev = eventAt(base, at(22, 0, 0))!;
    expect(cod.reportableSeconds).toBeGreaterThan(ev.measuredSeconds + ev.interpolatedSeconds - 1);
  });

  it('限值窗口分别披露', () => {
    const cod = draft.rows.find((r) => r.pollutant === 'COD')!;
    expect(cod.limitWindows.map((w) => w.limit)).toEqual([50, 40]);
  });

  it('补传后草稿转入待复核，并列出变化', () => {
    const after = deriveDayEvents(augmented, POINT, DAY);
    const check = checkReportDraft(draft, after, { cacheStale: false, allowDerive: true });
    expect(check.status).toBe('NEEDS_RECHECK');
    expect(check.canFile).toBe(false);
    expect(check.changes.length).toBeGreaterThan(0);
  });

  it('无变化时可核对出具', () => {
    const same = deriveDayEvents(baseDataset, POINT, DAY);
    const check = checkReportDraft(draft, same, { cacheStale: false, allowDerive: true });
    expect(check.status).toBe('MATCH');
    expect(check.canFile).toBe(true);
  });

  it('复核人确认后可重新核对出具', () => {
    const same = deriveDayEvents(baseDataset, POINT, DAY);
    const blocked = checkReportDraft({ ...draft, status: 'NEEDS_RECHECK' }, same, { cacheStale: false, allowDerive: true });
    expect(blocked.status).toBe('NEEDS_RECHECK');
    const reopened = reopenDraft({ ...draft, status: 'NEEDS_RECHECK' }, { by: 'test', now: 1, note: '已确认补传影响' });
    const ok = checkReportDraft(reopened, same, { cacheStale: false, allowDerive: true });
    expect(ok.status).toBe('MATCH');
    expect(ok.canFile).toBe(true);
  });

  it('缓存过旧且不允许现算 → 禁止出具', () => {
    const check = checkReportDraft(draft, null, { cacheStale: true, allowDerive: false });
    expect(check.status).toBe('STALE_CACHE_BLOCKED');
    expect(check.canFile).toBe(false);
  });

  it('迟到处置只补证，不删除事件', () => {
    const before = deriveDayEvents(baseDataset, POINT, DAY);
    const after = deriveDayEvents(augmented, POINT, DAY);
    expect(after.events.length).toBe(before.events.length);
    const cutoff = Date.UTC(2026, 10, 18, 23, 20, 0);
    const ev = after.events.find((e) => e.startAt > at(20, 30) && e.startAt < at(21, 1))!;
    const links = linkDispositions(ev, augmented.dispositions, cutoff);
    const late = links.filter((l) => l.late);
    expect(late.length).toBeGreaterThan(0);
    expect(late.every((l) => l.causalClaim === false)).toBe(true);
    const notes = lateDispositionEffect(links);
    expect(notes.join('')).toContain('不得据此宣布超标已消失');
    expect(after.events.some((e) => e.eventId === ev.eventId)).toBe(true);
  });
});

describe('标准适用库', () => {
  it('同一窗口多规则时按确定性规则裁决并披露', () => {
    const rules: StandardRule[] = [
      { standardId: 'A', pointCode: 'X', pollutant: 'COD', limitValue: 50, effectiveFrom: 0, effectiveTo: null, basis: 'a', grade: 'g', issuedBy: 'i', note: '', createdAt: 1 },
      { standardId: 'B', pointCode: 'X', pollutant: 'COD', limitValue: 40, effectiveFrom: 1000, effectiveTo: null, basis: 'b', grade: 'g', issuedBy: 'i', note: '', createdAt: 2 },
    ];
    const ctx = buildStandardContext({ standards: rules }, 'X', 'COD', 0, 3000, 50);
    expect(ctx.windows.map((w) => w.limit)).toEqual([50, 40]);
    const overlapping = rules.map((r) => ({ ...r, effectiveTo: null }));
    const ctx2 = buildStandardContext({ standards: overlapping }, 'X', 'COD', 0, 3000, 50);
    expect(ctx2.windows[1].standardId).toBe('B');
    expect(ctx2.conflicts.length).toBeGreaterThan(0);
    expect(ctx2.conflicts[0].reason).toContain('裁决');
  });

  it('标准库完全缺失时使用兜底限值并标注', () => {
    const ctx = buildStandardContext({ standards: [] }, 'X', 'COD', 0, 3000, 50);
    expect(ctx.windows).toHaveLength(1);
    expect(ctx.windows[0].standardId).toContain('FALLBACK');
    expect(ctx.notes.join('')).toContain('兜底');
  });
});
