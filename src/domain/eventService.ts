/**
 * 事件派生服务：把两种方案（物化快照 / 查询时推导）接到同一套规则上。
 *
 *  - DERIVE_ON_DEMAND：每次调用都以当前数据现算；
 *  - PERSIST_SNAPSHOT：读取物化快照；若输入签名与当前数据不一致，快照即被判为“过旧”，
 *    必须显式刷新，禁止用旧事件替代当前证据。
 * 无论哪条路线，最终事件都来自 events.deriveDayEvents，规则完全一致。
 */

import type {
  DailyReportCheck,
  DailyReportDraft,
  DayEventSummary,
  DerivationStrategy,
  EventSnapshotRecord,
  ExceedanceEvent,
  InputSignature,
  Pollutant,
  StandardRule,
  StandardWindow,
} from './types';
import { deriveDayEvents, compareDerivations, diffEventSummaries, computeSignatureLight } from './events';
import { makeDayContext } from './pieces';
import { buildStandardContext } from './standards';
import { checkReportDraft } from './dailyReport';

export interface EventResolution {
  summary: DayEventSummary | null;
  /** 当前数据签名（无论是否使用缓存都计算，用于判旧） */
  currentSignature: string;
  strategy: DerivationStrategy;
  /** 缓存是否存在 */
  cachePresent: boolean;
  /** 缓存是否与当前输入一致 */
  cacheFresh: boolean;
  /** 是否直接使用了缓存（未现算） */
  servedFromCache: boolean;
  cacheDerivedAt: number | null;
  notes: string[];
}

export function signatureOf(dataset: Parameters<typeof deriveDayEvents>[0], pointCode: string, day: string): string {
  return computeSignatureLight(dataset, pointCode, day).signature;
}

export function summarySignature(summary: DayEventSummary): string {
  return summary.inputSignature.signature;
}

/**
 * 解析当日事件。
 * PERSIST_SNAPSHOT 且缓存新鲜 → 用缓存；缓存缺失或过旧且 allowRefresh=false → 返回 null + 说明。
 */
export function resolveDayEvents(
  dataset: Parameters<typeof deriveDayEvents>[0],
  pointCode: string,
  day: string,
  strategy: DerivationStrategy,
  cached: EventSnapshotRecord | null,
  options: { allowRefresh?: boolean } = {},
): EventResolution {
  const currentSignature = signatureOf(dataset, pointCode, day);
  const notes: string[] = [];
  if (strategy === 'DERIVE_ON_DEMAND') {
    const summary = deriveDayEvents(dataset, pointCode, day, { strategy: 'DERIVE_ON_DEMAND' });
    return {
      summary,
      currentSignature,
      strategy,
      cachePresent: Boolean(cached),
      cacheFresh: Boolean(cached && cached.inputSignature === currentSignature),
      servedFromCache: false,
      cacheDerivedAt: cached?.derivedAt ?? null,
      notes: ['查询时推导：只持久化原始有效片段与法规条件，事件在查询/申报时现算。'],
    };
  }
  if (cached && cached.inputSignature === currentSignature) {
    notes.push(`使用物化快照（${new Date(cached.derivedAt).toISOString()} 派生），输入签名与当前数据一致。`);
    return {
      summary: cached.summary,
      currentSignature,
      strategy,
      cachePresent: true,
      cacheFresh: true,
      servedFromCache: true,
      cacheDerivedAt: cached.derivedAt,
      notes,
    };
  }
  notes.push(
    cached
      ? '物化快照的输入签名与当前数据不一致（补传读数或限值调整），快照视为过旧，不能用于当前证据。'
      : '尚无物化快照；读数到达后应物化事件片段。',
  );
  if (options.allowRefresh) {
    const summary = deriveDayEvents(dataset, pointCode, day, { strategy: 'PERSIST_SNAPSHOT' });
    notes.push('已用当前证据重新物化事件快照（旧快照被替换）。');
    return {
      summary,
      currentSignature,
      strategy,
      cachePresent: Boolean(cached),
      cacheFresh: false,
      servedFromCache: false,
      cacheDerivedAt: cached?.derivedAt ?? null,
      notes,
    };
  }
  notes.push('当前策略禁止以旧缓存代替当前证据；请刷新快照或切换为查询时推导。');
  return {
    summary: null,
    currentSignature,
    strategy,
    cachePresent: Boolean(cached),
    cacheFresh: false,
    servedFromCache: false,
    cacheDerivedAt: cached?.derivedAt ?? null,
    notes,
  };
}

export function makeSnapshotRecord(summary: DayEventSummary): EventSnapshotRecord {
  return {
    cacheKey: `EVSNAP:${summary.pointCode}:${summary.day}`,
    pointCode: summary.pointCode,
    day: summary.day,
    strategy: 'PERSIST_SNAPSHOT',
    inputSignature: summary.inputSignature.signature,
    derivedAt: summary.computedAt,
    engineVersion: summary.engineVersion,
    windowFrom: summary.events[0]?.standardWindow.from ?? summary.windows[0]?.from ?? 0,
    windowTo: summary.events[0]?.standardWindow.to ?? summary.windows[0]?.to ?? 0,
    summary,
  };
}

export interface InvalidationReport {
  before: EventSnapshotRecord;
  after: EventSnapshotRecord | null;
  reasons: string[];
  added: ExceedanceEvent[];
  removed: ExceedanceEvent[];
  changed: { before: ExceedanceEvent; after: ExceedanceEvent }[];
  unchanged: ExceedanceEvent[];
}

/** 比较缓存与刷新后的差异，用于“派生影响”页 */
export function diffCaches(before: EventSnapshotRecord, after: EventSnapshotRecord | null): InvalidationReport {
  if (!after) {
    return { before, after, reasons: ['快照被删除'], added: [], removed: before.summary.events, changed: [], unchanged: [] };
  }
  const d = diffEventSummaries(before.summary, after.summary);
  return {
    before,
    after,
    reasons: d.reasons.length > 0 ? d.reasons : ['输入签名未变化（不应刷新）'],
    added: d.added,
    removed: d.removed,
    changed: d.changed,
    unchanged: d.unchanged,
  };
}

/** 两种方案对同一冻结输入的一致性证明 */
export function proveEquivalence(dataset: Parameters<typeof deriveDayEvents>[0], pointCode: string, day: string) {
  const a = deriveDayEvents(dataset, pointCode, day, { strategy: 'PERSIST_SNAPSHOT' });
  const b = deriveDayEvents(dataset, pointCode, day, { strategy: 'DERIVE_ON_DEMAND' });
  return compareDerivations(a, b);
}

/**
 * 限值调整：给某排口某因子新增一条标准规则，并把原规则的 effectiveTo 截到调整时刻。
 * 这是唯一会改变法规条件并造成事件成批失效的入口（与迟到补传并列）。
 */
export function reviseStandard(
  input: { pointCode: string; pollutant: Pollutant; limit: number; effectiveFrom: number; basis: string; grade: string; by: string; note: string },
): StandardRule {
  const rule: StandardRule = {
    standardId: `STD-${input.pointCode}-${input.pollutant}-REV-${input.effectiveFrom}`,
    pointCode: input.pointCode,
    pollutant: input.pollutant,
    limitValue: input.limit,
    effectiveFrom: input.effectiveFrom,
    effectiveTo: null,
    basis: input.basis,
    grade: input.grade,
    issuedBy: input.by,
    note: input.note,
    createdAt: Date.now(),
  };
  return rule;
}

/** 把原限值规则截断到调整时刻（若调整时刻落在其有效期内） */
export function truncatePriorStandards(
  dataset: Parameters<typeof deriveDayEvents>[0],
  input: { pointCode: string; pollutant: Pollutant; effectiveFrom: number },
  by: string,
): StandardRule[] {
  const cut = input.effectiveFrom;
  return dataset.standards
    .filter(
      (s) =>
        s.pointCode === input.pointCode &&
        s.pollutant === input.pollutant &&
        s.effectiveFrom < cut &&
        (s.effectiveTo === null || s.effectiveTo > cut),
    )
    .map((s) => ({
      ...s,
      effectiveTo: cut,
      note: `${s.note}｜${by} 于录入时将有效期截至 ${new Date(cut).toISOString()}（限值调整）。`.trim(),
    }));
}

export function windowsFor(dataset: Parameters<typeof deriveDayEvents>[0], pointCode: string, pollutant: Pollutant, day: string): StandardWindow[] {
  const ctx = makeDayContext(dataset, pointCode, day);
  const fallback = ctx.standards[pollutant];
  return buildStandardContext(dataset, pointCode, pollutant, ctx.windowFrom, ctx.windowTo, fallback).windows;
}

export function checkDraft(
  draft: DailyReportDraft,
  current: DayEventSummary | null,
  cacheStale: boolean,
): DailyReportCheck {
  return checkReportDraft(draft, current, { cacheStale, allowDerive: false });
}

export type { InputSignature };
