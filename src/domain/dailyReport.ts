/**
 * 申报核对：自然日申报值由事件汇总，而不是逐行读数。
 *
 * 规则：
 *  - 上报时长只计“实测 + 可插值”的超限时长；未知空档单列，不并入上报值；
 *  - 事件跨越限值窗口时，按窗口分别披露；
 *  - 草稿创建时冻结事件集合与输入签名；
 *  - 补传读数 / 限值调整改变签名或事件 → 草稿自动转入 NEEDS_RECHECK（复核），
 *    并逐项列出变化；绝不以旧草稿替代当前证据；
 *  - 迟到处置记录只能补证（写进说明与关联簿），不能把超标事件删除。
 */

import type {
  DailyReportCheck,
  DailyReportDraft,
  DailyReportRow,
  DayEventSummary,
  DerivationStrategy,
  ExceedanceEvent,
  IntervalGap,
  LoadBounds,
  Pollutant,
  ReportChange,
} from './types';
import { fmtDateTime } from './time';

const POLLUTANTS: Pollutant[] = ['COD', 'NH3N'];

function sumLoad(a: LoadBounds | null, b: LoadBounds | null): LoadBounds | null {
  if (!a) return b;
  if (!b) return a;
  return { min: a.min + b.min, best: a.best + b.best, max: a.max + b.max };
}

export function buildReportRows(events: ExceedanceEvent[], gaps: IntervalGap[]): DailyReportRow[] {
  return POLLUTANTS.map((pollutant) => {
    const list = events.filter((e) => e.pollutant === pollutant);
    const eventGaps = gaps.filter((g) => g.pollutant === pollutant && g.possibleExceedance);
    const limitWindows = new Map<string, DailyReportRow['limitWindows'][number]>();
    for (const e of list) {
      const key = `${e.standardId}:${e.limit}`;
      if (!limitWindows.has(key))
        limitWindows.set(key, {
          limit: e.limit,
          from: e.standardWindow.from,
          to: e.standardWindow.to,
          standardId: e.standardId,
        });
    }
    const measured = list.reduce((a, e) => a + e.measuredSeconds, 0);
    const interpolated = list.reduce((a, e) => a + e.interpolatedSeconds, 0);
    const unknownInEvents = list.reduce((a, e) => a + e.unknownSeconds, 0);
    const unknownOutside = eventGaps.filter((g) => !g.insideEvent).reduce((a, g) => a + g.seconds, 0);
    const peakEvent = list.reduce<ExceedanceEvent | null>((a, e) => (!a || e.peak > a.peak ? e : a), null);
    const notes: string[] = [];
    if (unknownInEvents + unknownOutside > 0)
      notes.push(`未知空档 ${((unknownInEvents + unknownOutside) / 60).toFixed(1)} 分钟单列，未计入上报时长。`);
    if (list.some((e) => e.status !== 'CLOSED'))
      notes.push(`有 ${list.filter((e) => e.status !== 'CLOSED').length} 个未闭合事件，不能简单按“已结束”上报。`);
    if (limitWindows.size > 1) notes.push('当日限值有调整：各窗口分别列示，不得合并成一个限值。');
    if (list.some((e) => e.limitChangeAt !== null)) notes.push('存在因限值调整切开的事件；后段另立事件。');
    return {
      pollutant,
      eventIds: list.map((e) => e.eventId),
      reportableSeconds: measured + interpolated,
      measuredSeconds: measured,
      interpolatedSeconds: interpolated,
      unknownSeconds: unknownInEvents + unknownOutside,
      peak: peakEvent?.peak ?? 0,
      peakAt: peakEvent?.peakAt ?? 0,
      limitWindows: [...limitWindows.values()].sort((a, b) => a.from - b.from),
      excessAreaMgLs: list.reduce((a, e) => a + e.excessAreaMgLs, 0),
      excessLoadKg: list.reduce<LoadBounds | null>((a, e) => sumLoad(a, e.excessLoadKg), null),
      notes,
    };
  });
}

export function buildDraft(
  summary: DayEventSummary,
  input: { createdBy: string; now: number; cutoffReceivedAt: number; strategy: DerivationStrategy; serial: number },
): DailyReportDraft {
  return {
    draftId: `RPT-${summary.pointCode}-${summary.day}-${input.serial}`,
    pointCode: summary.pointCode,
    plantId: summary.plantId,
    day: summary.day,
    createdAt: input.now,
    createdBy: input.createdBy,
    status: 'DRAFT',
    strategy: input.strategy,
    snapshotSignature: summary.inputSignature.signature,
    cutoffReceivedAt: input.cutoffReceivedAt,
    rows: buildReportRows(summary.events, summary.gaps),
    events: summary.events,
    gaps: summary.gaps,
    notes: [
      '申报值按事件汇总：上报超标时长 = 实测时长 + 可插值时长；未知空档单列。',
      summary.notes[0] ?? '事件由有效浓度片段 × 标准窗口 × 状态边界 × 间隔证据推导。',
    ],
  };
}

function eventLabel(e: ExceedanceEvent): string {
  return `${e.pollutant} ${fmtDateTime(e.startAt).slice(11, 19)} 起，限值 ${e.limit} mg/L，${e.status}`;
}

/**
 * 核对草稿与当前事件摘要，给出变化清单与状态。
 * 当前摘要为 null（缓存过旧且不允许现算）时 → STALE_CACHE_BLOCKED，禁止用旧结果出具。
 */
export function checkReportDraft(
  draft: DailyReportDraft,
  current: DayEventSummary | null,
  opts: { cacheStale: boolean; allowDerive: boolean },
): DailyReportCheck {
  if (!current) {
    return {
      draft,
      currentSummary: null,
      currentSignature: null,
      status: 'STALE_CACHE_BLOCKED',
      changes: [],
      canFile: false,
      message: opts.cacheStale
        ? '缓存的事件快照与当前输入签名不一致，且当前策略不允许现算；禁止以旧事件出具申报。请先刷新缓存或切换为查询时推导。'
        : '尚无当前事件摘要，无法核对。',
    };
  }
  const changes: ReportChange[] = [];
  const before = new Map(draft.events.map((e) => [e.eventId, e]));
  const after = new Map(current.events.map((e) => [e.eventId, e]));
  for (const e of current.events) {
    if (!before.has(e.eventId)) changes.push({ pollutant: e.pollutant, eventId: e.eventId, field: '事件', before: '—', after: eventLabel(e), kind: 'ADDED' });
  }
  for (const e of draft.events) {
    if (!after.has(e.eventId)) changes.push({ pollutant: e.pollutant, eventId: e.eventId, field: '事件', before: eventLabel(e), after: '已不存在', kind: 'REMOVED' });
  }
  for (const [id, a] of before) {
    const b = after.get(id);
    if (!b) continue;
    if (Math.abs(a.measuredSeconds - b.measuredSeconds) > 0.5 || Math.abs(a.interpolatedSeconds - b.interpolatedSeconds) > 0.5) {
      changes.push({
        pollutant: a.pollutant,
        eventId: id,
        field: '超标时长',
        before: `${(a.measuredSeconds + a.interpolatedSeconds).toFixed(1)} s`,
        after: `${(b.measuredSeconds + b.interpolatedSeconds).toFixed(1)} s`,
        kind: 'CHANGED',
      });
    }
    if (Math.abs(a.unknownSeconds - b.unknownSeconds) > 0.5 || a.unknownSeconds !== b.unknownSeconds) {
      changes.push({
        pollutant: a.pollutant,
        eventId: id,
        field: '未知空档',
        before: `${(a.unknownSeconds / 60).toFixed(1)} min`,
        after: `${(b.unknownSeconds / 60).toFixed(1)} min`,
        kind: 'EVIDENCE',
      });
    }
    if (a.standardId !== b.standardId || Math.abs(a.limit - b.limit) > 1e-9) {
      changes.push({
        pollutant: a.pollutant,
        eventId: id,
        field: '限值',
        before: `${a.limit} (${a.standardId})`,
        after: `${b.limit} (${b.standardId})`,
        kind: 'LIMIT',
      });
    }
    if (a.status !== b.status) {
      changes.push({ pollutant: a.pollutant, eventId: id, field: '状态', before: a.status, after: b.status, kind: 'CHANGED' });
    }
  }
  const signatureChanged = draft.snapshotSignature !== current.inputSignature.signature;
  if (signatureChanged && changes.length === 0) {
    changes.push({
      pollutant: 'COD',
      eventId: null,
      field: '输入签名',
      before: draft.snapshotSignature.slice(0, 12),
      after: current.inputSignature.signature.slice(0, 12),
      kind: 'EVIDENCE',
    });
    if (current.inputSignature.readingCount !== undefined) {
      changes.push({
        pollutant: 'COD',
        eventId: null,
        field: '证据',
        before: `读数 ${draft.events.length} 个事件`,
        after: `读数 ${current.inputSignature.readingCount} 条；已按当前证据重算，事件结论未变`,
        kind: 'EVIDENCE',
      });
    }
  }
  // 出具前必须复核：草稿一旦被标记转入复核，不能仅因“再次核对无差异”就自动恢复可出具
  const status =
    changes.length === 0 && !signatureChanged && draft.status === 'DRAFT' ? 'MATCH' : 'NEEDS_RECHECK';
  const message =
    status === 'MATCH'
      ? '草稿与当前事件摘要一致，可核对上报。'
      : changes.length === 0 && !signatureChanged
        ? '事件与签名一致，但该草稿此前已转入复核（补传/限值调整）；请确认后重新生成草稿或由复核人确认。'
      : signatureChanged
        ? `输入签名变化（补传读数或限值调整）：草稿已转入复核，需逐项确认 ${changes.length} 处变化。`
        : `事件推导结果与草稿不一致：${changes.length} 处变化需复核。`;
  return {
    draft,
    currentSummary: current,
    currentSignature: current.inputSignature.signature,
    status,
    changes,
    canFile: status === 'MATCH',
    message,
  };
}

/** 草稿转入复核时写回状态与原因 */
export function invalidateDraft(draft: DailyReportDraft, reason: string, detail: string, now: number): DailyReportDraft {
  if (draft.status === 'SUPERSEDED') return draft;
  return {
    ...draft,
    status: 'NEEDS_RECHECK',
    invalidatedBy: { reason, at: now, detail },
  };
}

/** 复核人确认后把草稿恢复为可核对状态（清空失效标记，保留复核附注） */
export function reopenDraft(draft: DailyReportDraft, input: { by: string; now: number; note: string }): DailyReportDraft {
  return {
    ...draft,
    status: 'DRAFT',
    invalidatedBy: undefined,
    reviewedBy: input.by,
    reviewedAt: input.now,
    reviewNote: input.note,
  };
}

export function fileDraft(draft: DailyReportDraft, input: { by: string; now: number; note: string }): DailyReportDraft {
  return {
    ...draft,
    status: 'FILED',
    reviewedBy: input.by,
    reviewedAt: input.now,
    reviewNote: input.note,
  };
}
