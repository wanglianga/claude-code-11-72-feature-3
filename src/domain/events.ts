/**
 * 事件推导器 + 间隔证据评估器
 *
 * 超标事件 ≠ “某一行读数大于阈值”。事件由以下证据共同推出：
 *   - 有效浓度片段：同一仪表实例、同一校准体制、OK 状态下的分段线性浓度；
 *   - 标准窗口：按限值生效边界切开，窗口内限值唯一；
 *   - 状态边界：清洗/校准/旁路/故障一开始，插值链立即终止，事件记 OPEN；
 *   - 间隔证据：相邻有效读数之间按线性插值推算穿越点；
 *     采样空档只允许在“两侧都实测超限且空档足够短”时并入同一事件，
 *     并以 UNKNOWN 证据段显式标注，绝不断言该段持续超标；
 *     清洗/校准/旁路/故障造成的空档不并入，事件直接终止。
 *
 * 两种派生策略共用本模块的全部规则：
 *   PERSIST_SNAPSHOT：调用方把结果连同输入签名物化为缓存；
 *   DERIVE_ON_DEMAND：调用方在查询/申报时现算。
 * 对同一冻结输入，两者必须给出完全相同的事件集合（见 compareDerivations）。
 */

import {
  Calibration,
  Dataset,
  DerivationStrategy,
  DeviceState,
  EVIDENCE_END_LABELS,
  EventBoundary,
  EventStatus,
  EvidenceEndReason,
  EvidenceKind,
  EvidenceSegment,
  ExceedanceEvent,
  GapKind,
  Instrument,
  IntervalEvidence,
  IntervalGap,
  LoadBounds,
  Pollutant,
  PollutantEventStats,
  Reading,
  ScopeOptions,
  StandardWindow,
  DayEventSummary,
  InputSignature,
} from './types';
import { DayContext, makeDayContext, Piece, Series } from './pieces';
import { buildIndex, TimelineIndex } from './weave';
import { combineRelative } from './stats';
import { EPS } from './stats';

export const EVENT_ENGINE_VERSION = '2.0.0';
/** 允许并入事件的纯采样空档上限（秒）；超过则分别成立两个开放事件 */
export const MAX_GAP_MERGE_SECONDS = 900;

interface Run {
  piece: Piece;
  series: Series;
  /** 该片段的浓度覆盖（已裁剪到 [piece.from, piece.to]） */
  coverage: [number, number][];
  calibration: Calibration | null;
}

interface Blocked {
  from: number;
  to: number;
  kind: GapKind;
  reason: string;
  state: DeviceState | null;
  stateId: string | null;
  refIds: string[];
}

interface Episode {
  run: Run;
  window: StandardWindow;
  limit: number;
  from: number;
  to: number;
  startCensored: boolean;
  endCensored: boolean;
  boundaryEnd: boolean;
  startBoundary: boolean;
  startCause: EvidenceEndReason | 'CENSOR_START';
  endCause: EvidenceEndReason;
  segments: SubSeg[];
  peak: number;
  peakAt: number;
  excessArea: number;
}

function calibrationAtMid(ctx: DayContext, instrumentId: string, at: number): Calibration | null {
  const list = ctx.index.calibrationsByInstrument.get(instrumentId) ?? [];
  let found: Calibration | null = null;
  for (const c of list) {
    if (c.effectiveAt <= at) found = c;
    else break;
  }
  return found;
}

/**
 * 构造浓度证据链：只接受“浓度状态 OK + 有实例 + 有校准体制”的片段。
 * 流量旁路/故障不影响浓度证据（超标只看浓度），但这类片段的超额负荷会缺流量证据。
 */
function concentrationRuns(ctx: DayContext, pollutant: Pollutant): { runs: Run[]; blocked: Blocked[] } {
  const runs: Run[] = [];
  const blocked: Blocked[] = [];
  const pieces = ctx.pieces.get(pollutant) ?? [];
  for (const piece of pieces) {
    const inst: Instrument | null = piece.concInstrument;
    const state = piece.state;
    const baseRefs = [piece.stateId, piece.flowStateId].filter((v): v is string => Boolean(v));
    if (!inst) {
      blocked.push({
        from: piece.from,
        to: piece.to,
        kind: piece.category === 'NO_INSTRUMENT' ? 'INSTRUMENT_GAP' : 'NO_EFFECTIVE_STATE',
        reason: piece.category === 'NO_INSTRUMENT' ? '缺少浓度仪表绑定/实例有效期' : '缺少可用状态记录',
        state,
        stateId: piece.stateId,
        refIds: baseRefs,
      });
      continue;
    }
    if (state !== 'OK') {
      blocked.push({
        from: piece.from,
        to: piece.to,
        kind: 'EXCLUDED_STATE',
        reason:
          piece.category === 'EXCLUDED_STATE'
            ? `浓度/流量状态 ${state ?? '无'}（${piece.stateReason ?? piece.flowStateReason ?? '未注明'}）；清洗/校准/旁路/故障一开始即终止插值链`
            : '缺少状态记录，无法证明非清洗/旁路',
        state,
        stateId: piece.stateId,
        refIds: baseRefs,
      });
      continue;
    }
    const calibration = piece.calibration ?? calibrationAtMid(ctx, inst.instrumentId, (piece.from + piece.to) / 2);
    // VALID 片段直接复用编织结果；因流量状态被排除、但浓度状态仍 OK 的片段，现建浓度序列
    const series = piece.conc && piece.category === 'VALID' ? piece.conc : buildLocalSeries(ctx, inst, calibration, piece);
    const coverage = (series.coverage ?? [])
      .map(([a, b]) => [Math.max(a, piece.from), Math.min(b, piece.to)] as [number, number])
      .filter(([a, b]) => b - a > EPS);
    if (coverage.length === 0) {
      blocked.push({
        from: piece.from,
        to: piece.to,
        kind: 'SAMPLING_GAP',
        reason: '该片段内没有可配对的浓度/流量有效读数',
        state,
        stateId: piece.stateId,
        refIds: baseRefs,
      });
      continue;
    }
    runs.push({ piece, series, coverage, calibration });
    // 片段内缺口（有效读数之间的长间隔）
    let cursor = piece.from;
    for (const [a, b] of coverage) {
      if (a - cursor > EPS) {
        blocked.push({
          from: cursor,
          to: a,
          kind: 'SAMPLING_GAP',
          reason: '相邻有效读数间隔超过 nominal×2.5，空档不参与插值',
          state,
          stateId: piece.stateId,
          refIds: baseRefs,
        });
      }
      cursor = b;
    }
    if (piece.to - cursor > EPS) {
      blocked.push({
        from: cursor,
        to: piece.to,
        kind: 'SAMPLING_GAP',
        reason: '有效读数结束到片段终点之间缺少证据（段端最多保持一个标称间隔）',
        state,
        stateId: piece.stateId,
        refIds: baseRefs,
      });
    }
  }
  return { runs, blocked: blocked.sort((a, b) => a.from - b.from) };
}

/** 为流量被排除、但浓度仍 OK 的片段现建浓度序列（规则与 pieces.buildSeries 一致） */
function buildLocalSeries(ctx: DayContext, inst: Instrument, calibration: Calibration | null, piece: Piece): Series {
  const hold = inst.nominalIntervalSeconds * 1000;
  const gapMs = inst.nominalIntervalSeconds * 1000 * 2.5;
  const calId = calibration?.calibrationId ?? null;
  const scale = calibration?.scale ?? inst.scale;
  const offset = calibration?.offset ?? inst.offset;
  const readings = (ctx.readingsByInstrument.get(inst.instrumentId) ?? []).filter(
    (r) =>
      r.alignedAt >= piece.from - hold &&
      r.alignedAt <= piece.to + hold &&
      r.qualityFlag !== 'INVALID' &&
      (r.qualityFlag !== 'SUSPECT' || ctx.scope.includeSuspect) &&
      (calibrationAtMid(ctx, inst.instrumentId, r.alignedAt)?.calibrationId ?? null) === calId,
  );
  const knots = readings
    .sort((a, b) => a.alignedAt - b.alignedAt)
    .map((r) => ({ at: r.alignedAt, value: r.rawValue * scale + offset, readingId: r.readingId }));
  const coverage: [number, number][] = [];
  for (let i = 1; i < knots.length; i += 1) {
    const t1 = knots[i - 1].at;
    const t2 = knots[i].at;
    if (t2 - t1 > EPS && t2 - t1 <= gapMs) coverage.push([t1, t2]);
  }
  if (knots.length > 0) {
    if (knots[0].at > piece.from && knots[0].at - piece.from <= hold) coverage.push([piece.from, knots[0].at]);
    const last = knots[knots.length - 1];
    if (last.at < piece.to && piece.to - last.at <= hold) coverage.push([last.at, piece.to]);
  }
  const clipped = coverage
    .map(([a, b]) => [Math.max(a, piece.from), Math.min(b, piece.to)] as [number, number])
    .filter(([a, b]) => b - a > EPS);
  const valueAt = (t: number): number | null => {
    if (knots.length === 0) return null;
    if (knots.length === 1) return Math.abs(t - knots[0].at) <= hold ? knots[0].value : null;
    if (t < knots[0].at) return knots[0].at - t <= hold ? knots[0].value : null;
    if (t > knots[knots.length - 1].at) return t - knots[knots.length - 1].at <= hold ? knots[knots.length - 1].value : null;
    let lo = 0;
    let hi = knots.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (knots[mid].at <= t) lo = mid;
      else hi = mid;
    }
    const p = knots[lo];
    const q = knots[hi];
    const span = q.at - p.at;
    if (span <= 0) return q.value;
    return p.value + ((q.value - p.value) * (t - p.at)) / span;
  };
  const nearest = (t: number) =>
    knots.length === 0
      ? null
      : knots.reduce((best, k) => (Math.abs(k.at - t) < Math.abs(best.at - t) ? k : best), knots[0]);
  let maxSlope = 0;
  for (let i = 1; i < knots.length; i += 1) {
    const dt = (knots[i].at - knots[i - 1].at) / 1000;
    if (dt > EPS) maxSlope = Math.max(maxSlope, Math.abs(knots[i].value - knots[i - 1].value) / dt);
  }
  return { knots, coverage: clipped, valueAt, maxSlope, nearest };
}

/** 片段在某时刻的边界说明 */
function cutReason(pieces: Piece[], at: number, side: 'START' | 'END'): EvidenceEndReason {
  const eps = 1;
  const next = pieces.find((p) => p.from >= at - eps);
  const prev = [...pieces].reverse().find((p) => p.to <= at + eps);
  if (side === 'END' && next) {
    if (next.category === 'EXCLUDED_STATE' || next.category === 'NO_STATE') return 'STATE_CHANGE';
    if (next.category === 'NO_INSTRUMENT') return 'INSTRUMENT_SWAP';
  }
  if (side === 'START' && prev) {
    if (prev.category === 'EXCLUDED_STATE' || prev.category === 'NO_STATE') return 'STATE_CHANGE';
    if (prev.category === 'NO_INSTRUMENT') return 'INSTRUMENT_SWAP';
  }
  const boundary = (next?.boundaries ?? prev?.boundaries ?? []).find(
    (b) => Math.abs(b.at - at) <= eps,
  );
  if (boundary?.kind === 'CALIBRATION') return 'CALIBRATION_CUT';
  if (boundary?.kind === 'GAP') return 'GAP_START';
  if (boundary?.kind === 'STATE') return 'STATE_CHANGE';
  if (boundary?.kind === 'INSTRUMENT_SWAP') return 'INSTRUMENT_SWAP';
  return 'WINDOW_END';
}

function statusOf(cause: EvidenceEndReason, atWindowEnd: boolean, windowTo: number, dayTo: number): EventStatus {
  if (!atWindowEnd) {
    if (cause === 'BELOW_LIMIT') return 'CLOSED';
    if (cause === 'GAP_START') return 'OPEN_DATA_GAP';
    if (cause === 'STATE_CHANGE') return 'OPEN_DATA_GAP';
    if (cause === 'INSTRUMENT_SWAP' || cause === 'CALIBRATION_CUT') return 'OPEN_BOUNDARY';
    if (cause === 'LIMIT_CHANGE') return 'OPEN_LIMIT_CHANGE';
    return 'OPEN_BOUNDARY';
  }
  if (windowTo < dayTo) return 'OPEN_LIMIT_CHANGE';
  return 'OPEN_END_OF_WINDOW';
}

interface SubSeg {
  kind: EvidenceKind;
  from: number;
  to: number;
  valueAtStart: number | null;
  valueAtEnd: number | null;
  peak: number;
  peakAt: number;
}

function scanCoverage(
  run: Run,
  limit: number,
  from: number,
  to: number,
): { segs: SubSeg[]; startCensored: boolean; endCensored: boolean; boundaryEnd: boolean; startBoundary: boolean } {
  const series = run.series;
  const knots = series.knots.filter((k) => k.at > from && k.at < to);
  const cuts = [...new Set([from, to, ...knots.map((k) => k.at)])].sort((a, b) => a - b);
  const segs: SubSeg[] = [];
  for (let i = 1; i < cuts.length; i += 1) {
    const u = cuts[i - 1];
    const v = cuts[i];
    const c0 = series.valueAt(u);
    const c1 = series.valueAt(v);
    if (c0 === null || c1 === null) continue;
    if (c0 > limit && c1 > limit) {
      const peak = Math.max(c0, c1);
      segs.push({
        kind: 'MEASURED',
        from: u,
        to: v,
        valueAtStart: c0,
        valueAtEnd: c1,
        peak,
        peakAt: c0 >= c1 ? u : v,
      });
    } else if (c0 <= limit && c1 > limit) {
      const tc = u + ((limit - c0) / (c1 - c0)) * (v - u);
      if (v - tc > EPS) {
        segs.push({
          kind: 'INTERPOLATED',
          from: tc,
          to: v,
          valueAtStart: limit,
          valueAtEnd: c1,
          peak: c1,
          peakAt: v,
        });
      }
    } else if (c0 > limit && Math.abs(c1 - limit) <= 1e-9) {
      // 右端恰在限值上：实测超限但“是否已回落”无法证明；保留为 MEASURED，
      // 由下方边界截断判断把事件记为开放，绝不当成已下穿。
      segs.push({
        kind: 'MEASURED',
        from: u,
        to: v,
        valueAtStart: c0,
        valueAtEnd: c1,
        peak: c0,
        peakAt: u,
      });
    } else if (c0 > limit && c1 < limit) {
      const tc = u + ((limit - c0) / (c1 - c0)) * (v - u);
      if (tc - u > EPS) {
        segs.push({
          kind: 'INTERPOLATED',
          from: u,
          to: tc,
          valueAtStart: c0,
          valueAtEnd: limit,
          peak: c0,
          peakAt: u,
        });
      }
    }
  }
  if (segs.length === 0) {
    return { segs, startCensored: false, endCensored: false, boundaryEnd: false, startBoundary: false };
  }
  // 截断只看“覆盖区间的两个端点”：端点处的实测值若仍不低于限值，
  // 就没有证据证明越限从何时开始/到何时结束。恰好等于限值时记边界截断。
  const eps = 1e-6;
  const startVal = series.valueAt(from);
  const endVal = series.valueAt(to);
  const startCensored = startVal !== null && startVal >= limit - eps;
  const startBoundary = startCensored && Math.abs(startVal - limit) <= eps;
  const endCensored = endVal !== null && endVal >= limit - eps;
  const boundaryEnd = endCensored && Math.abs(endVal - limit) <= eps;
  // 末段如果停在覆盖端点之前而端点仍高于限值（例如端点被零阶保持抬到限值），
  // 把末段延伸到端点，避免把“未判定”误写成“已下穿”。
  const lastSeg = segs[segs.length - 1];
  if (endCensored && lastSeg.to < to - 1 && lastSeg.kind === 'MEASURED') {
    lastSeg.to = to;
    lastSeg.valueAtEnd = endVal;
  }
  // 起点若从覆盖端点就已超限，首段从端点起算（不伪造穿越点）
  if (startCensored) {
    segs[0].from = Math.min(segs[0].from, from);
    segs[0].valueAtStart = startVal;
  }
  return { segs, startCensored, endCensored, boundaryEnd, startBoundary };
}

function excessArea(segs: SubSeg[], limit: number): number {
  let area = 0;
  for (const s of segs) {
    const a = Math.max(0, (s.valueAtStart ?? limit) - limit);
    const b = Math.max(0, (s.valueAtEnd ?? limit) - limit);
    area += ((a + b) / 2) * ((s.to - s.from) / 1000);
  }
  return area;
}

function readingSourceIds(run: Run, from: number, to: number): string[] {
  return run.series.knots.filter((k) => k.at >= from - 1 && k.at <= to + 1).map((k) => k.readingId);
}

function buildEvidenceSegments(episode: Episode, limit: number): EvidenceSegment[] {
  const out: EvidenceSegment[] = [];
  for (let i = 0; i < episode.segments.length; i += 1) {
    const s = episode.segments[i];
    const isLast = i === episode.segments.length - 1;
    // 末段是“实测段且终点恰在限值上”：没有“已回落”的证据，改记边界截断
    const atBoundary =
      isLast && episode.endCensored && s.kind === 'MEASURED' && Math.abs((s.valueAtEnd ?? Number.NaN) - limit) <= 1e-6;
    const endReason: EvidenceEndReason = atBoundary
      ? 'CENSOR_BOUNDARY'
      : isLast && episode.endCensored
        ? episode.endCause
        : 'BELOW_LIMIT';
    if (s.kind === 'GAP_UNKNOWN') {
      out.push({
        evidenceId: `evd-gap-${episode.window.pollutant}-${Math.round(s.from)}`,
        kind: 'GAP_UNKNOWN',
        from: s.from,
        to: s.to,
        seconds: (s.to - s.from) / 1000,
        startValue: s.valueAtStart,
        endValue: s.valueAtEnd,
        peak: null,
        peakAt: null,
        instrumentId: episode.run.piece.concInstrument?.instrumentId ?? null,
        calibrationId: episode.run.calibration?.calibrationId ?? null,
        state: episode.run.piece.state,
        readingIds: [],
        boundaryRefs: [episode.run.piece.stateId].filter((v): v is string => Boolean(v)),
        endReason: 'GAP_START',
        note: '采样空档：两侧读数均超限，但空档内无证据；该段不计实测也不计插值，只标记为未知。',
      });
      continue;
    }
    out.push({
      evidenceId: `evd-${episode.window.pollutant}-${episode.window.standardId}-${Math.round(s.from)}-${s.kind}`,
      kind: s.kind,
      from: s.from,
      to: s.to,
      seconds: (s.to - s.from) / 1000,
      startValue: s.valueAtStart,
      endValue: s.valueAtEnd,
      peak: s.peak,
      peakAt: s.peakAt,
      instrumentId: episode.run.piece.concInstrument?.instrumentId ?? null,
      calibrationId: episode.run.calibration?.calibrationId ?? null,
      state: episode.run.piece.state,
      readingIds: readingSourceIds(episode.run, s.from, s.to),
      boundaryRefs: [episode.run.piece.stateId, episode.run.calibration?.calibrationId].filter(
        (v): v is string => Boolean(v),
      ),
      endReason,
      note:
        s.kind === 'MEASURED'
          ? '两端实测读数都高于限值，区间内持续超限有实测证据'
          : '一端实测高于限值、另一端不高于限值，穿越点由线性插值推算',
    });
  }
  return out;
}

function startSegIsBoundary(seg: EvidenceSegment | undefined, limit: number): boolean {
  return Boolean(seg && seg.kind === 'MEASURED' && Math.abs((seg.startValue ?? Number.NaN) - limit) <= 1e-6);
}

function eventBoundaries(episode: Episode, status: EventStatus): EventBoundary[] {
  const list: EventBoundary[] = [];
  const startBoundary = startSegIsBoundary(
    episode.segments[0] ? ({ kind: episode.segments[0].kind, startValue: episode.segments[0].valueAtStart } as unknown as EvidenceSegment) : undefined,
    episode.limit,
  );
  list.push({
    at: episode.from,
    kind: startBoundary ? 'CENSOR_START' : episode.startCensored ? 'CENSOR_START' : 'CROSS_UP',
    refId: episode.run.piece.stateId,
    label: startBoundary
      ? `起点读数恰为限值 ${episode.limit} mg/L，不能判定何时已越限`
      : episode.startCensored
        ? `证据接管时已高于限值 ${episode.limit} mg/L（起点由${EVIDENCE_END_LABELS[episode.startCause as EvidenceEndReason] ?? '窗口边界'}决定）`
        : `线性插值推算上穿 ${episode.limit} mg/L`,
    interpolated: !episode.startCensored,
  });
  let prevKind: EvidenceKind | null = null;
  for (const s of episode.segments) {
    if (prevKind === 'MEASURED' && s.kind === 'INTERPOLATED') {
      // 同一次穿越后的插值段，不额外记边界
    }
    prevKind = s.kind;
  }
  const endKind: EventBoundary['kind'] =
    episode.boundaryEnd
      ? 'CENSOR_START'
      : status === 'OPEN_LIMIT_CHANGE'
        ? 'LIMIT_CHANGE'
        : status === 'OPEN_DATA_GAP'
          ? 'STATE_CUT'
          : 'CROSS_DOWN';
  list.push({
    at: episode.to,
    kind: endKind,
    refId: episode.run.piece.stateId,
    label: episode.endCensored
      ? `${EVIDENCE_END_LABELS[episode.endCause] ?? '证据结束'}（未能实测回落）`
      : `线性插值推算下穿 ${episode.limit} mg/L`,
    interpolated: !episode.endCensored,
  });
  return list;
}

function valuesAround(
  runs: Run[],
  at: number,
  side: 'BEFORE' | 'AFTER',
): { value: number; readingId: string; at: number } | null {
  let best: { value: number; readingId: string; at: number } | null = null;
  for (const run of runs) {
    for (const k of run.series.knots) {
      if (side === 'BEFORE' && k.at > at) continue;
      if (side === 'AFTER' && k.at < at) continue;
      if (!best) best = { value: k.value, readingId: k.readingId, at: k.at };
      else if (side === 'BEFORE' ? k.at > best.at : k.at < best.at) best = { value: k.value, readingId: k.readingId, at: k.at };
    }
  }
  return best;
}

function limitAt(windows: StandardWindow[], at: number): StandardWindow | null {
  for (const w of windows) if (w.from <= at && at < w.to) return w;
  return null;
}

function buildGaps(
  runs: Run[],
  blocked: Blocked[],
  windows: StandardWindow[],
  from: number,
  to: number,
): IntervalGap[] {
  const gaps: IntervalGap[] = [];
  for (const b of blocked) {
    const gFrom = Math.max(from, b.from);
    const gTo = Math.min(to, b.to);
    if (gTo - gFrom <= EPS) continue;
    const mid = (gFrom + gTo) / 2;
    const w = limitAt(windows, mid);
    const limit = w?.limit ?? 0;
    const before = valuesAround(runs, gFrom, 'BEFORE');
    const after = valuesAround(runs, gFrom, 'AFTER');
    const possible =
      (before !== null && w !== null && before.value > limit) || (after !== null && w !== null && after.value > limit);
    gaps.push({
      gapId: `GAP-${mid}-${b.kind}`,
      pollutant: (w?.pollutant ?? 'COD') as Pollutant,
      from: gFrom,
      to: gTo,
      seconds: (gTo - gFrom) / 1000,
      kind: b.kind,
      beforeValue: before?.value ?? null,
      afterValue: after?.value ?? null,
      insideEvent: false,
      possibleExceedance: possible,
      limit,
      effect:
        b.kind === 'SAMPLING_GAP'
          ? possible
            ? '空档两侧均偏高：不得据相邻高值臆造持续超标；该段时长不计入任何事件的实测/插值时长'
            : '空档无超限迹象；仅从覆盖与负荷中扣除'
          : b.kind === 'EXCLUDED_STATE'
            ? '排除状态（清洗/校准/旁路/故障）：插值链在此终止，事件只能以“开放”结束'
            : '缺少可归属证据：不得跨该段插值',
      refIds: b.refIds,
    });
  }
  return gaps;
}

export interface DeriveOptions {
  scope?: Partial<ScopeOptions>;
  strategy?: DerivationStrategy;
}

export function deriveDayEvents(
  dataset: Dataset,
  pointCode: string,
  day: string,
  options: DeriveOptions = {},
): DayEventSummary {
  const started = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const strategy: DerivationStrategy = options.strategy ?? 'DERIVE_ON_DEMAND';
  const ctx = makeDayContext(dataset, pointCode, day, options.scope ?? {});
  const windows: StandardWindow[] = [...ctx.standardWindows.COD, ...ctx.standardWindows.NH3N].sort(
    (a, b) => a.from - b.from || a.pollutant.localeCompare(b.pollutant),
  );
  const conflicts = ctx.standardConflicts;
  const readingMap = new Map(dataset.readings.map((r) => [r.readingId, r]));
  const events: ExceedanceEvent[] = [];
  const allGaps: IntervalGap[] = [];

  for (const pollutant of ['COD', 'NH3N'] as Pollutant[]) {
    const pWindows = ctx.standardWindows[pollutant];
    const { runs, blocked } = concentrationRuns(ctx, pollutant);
    const pollutantGaps = buildGaps(runs, blocked, pWindows, ctx.windowFrom, ctx.windowTo);
    for (const g of pollutantGaps) g.pollutant = pollutant;
    allGaps.push(...pollutantGaps);

    const episodes: Episode[] = [];
    for (const w of pWindows) {
      for (const run of runs) {
        // 片段窗口与标准窗口求交
        for (const [ca, cb] of run.coverage) {
          const from = Math.max(ca, w.from, ctx.windowFrom);
          const to = Math.min(cb, w.to, ctx.windowTo);
          if (to - from <= EPS) continue;
          const scan = scanCoverage(run, w.limit, from, to);
          if (scan.segs.length === 0) continue;
          let current: SubSeg[] = [];
          const flushEpisode = (nextSeg: SubSeg | null) => {
            if (current.length === 0) return;
            const epFrom = current[0].from;
            const epTo = current[current.length - 1].to;
            const startCensored = scan.startCensored && Math.abs(epFrom - from) <= 1;
            const endCensored =
              scan.endCensored && Math.abs(epTo - to) <= 1 && (nextSeg === null || nextSeg.from - epTo > 1);
            let endCause: EvidenceEndReason = 'BELOW_LIMIT';
            if (endCensored) {
              if (w.to < ctx.windowTo && Math.abs(to - w.to) <= 1 && Math.abs(w.to - ctx.windowTo) > 1) endCause = 'LIMIT_CHANGE';
              else if (Math.abs(to - ctx.windowTo) <= 1) endCause = 'WINDOW_END';
              else endCause = cutReason(ctx.pieces.get(pollutant) ?? [], to, 'END');
            }
            // 末段终点恰在限值上：即使存在后续低于限值的点，也无法证明“已回落”
            const lastEpSeg = current[current.length - 1];
            const boundaryEnd = endCensored && Math.abs((lastEpSeg.valueAtEnd ?? 0) - w.limit) <= 0.001;
            if (boundaryEnd) endCause = 'CENSOR_BOUNDARY';
            let startCause: EvidenceEndReason | 'CENSOR_START' = 'BELOW_LIMIT';
            if (startCensored) {
              if (w.from > ctx.windowFrom && Math.abs(from - w.from) <= 1) startCause = 'LIMIT_CHANGE';
              else if (Math.abs(from - ctx.windowFrom) <= 1) startCause = 'WINDOW_END';
              else startCause = cutReason(ctx.pieces.get(pollutant) ?? [], from, 'START');
            }
            const peakSeg = current.reduce((a, b) => (b.peak > a.peak ? b : a), current[0]);
            episodes.push({
              run,
              window: w,
              limit: w.limit,
              from: epFrom,
              to: epTo,
              startCensored,
              endCensored,
              boundaryEnd,
              startBoundary: scan.startBoundary && Math.abs(epFrom - from) <= 1,
              startCause,
              endCause,
              segments: current,
              peak: peakSeg.peak,
              peakAt: peakSeg.peakAt,
              excessArea: excessArea(current, w.limit),
            });
            current = [];
          };
          for (const seg of scan.segs) {
            const last = current[current.length - 1];
            if (last && seg.from - last.to > 1) flushEpisode(seg);
            current.push(seg);
          }
          flushEpisode(null);
        }
      }
    }

    // 跨采样空档合并：仅当纯采样空档、两侧都超限、空档足够短、且限值窗口相同
    episodes.sort((a, b) => a.from - b.from);
    const merged: Episode[] = [];
    for (const ep of episodes) {
      const prev = merged[merged.length - 1];
      if (prev && prev.window.standardId === ep.window.standardId && prev.endCensored) {
        const gap = pollutantGaps.find(
          (g) =>
            g.kind === 'SAMPLING_GAP' &&
            Math.abs(g.from - prev.to) <= 1 &&
            Math.abs(g.to - ep.from) <= 1 &&
            g.seconds <= MAX_GAP_MERGE_SECONDS,
        );
        const prevVal = prev.run.series.valueAt(prev.to);
        const nextVal = ep.run.series.valueAt(ep.from);
        if (
          gap &&
          prevVal !== null &&
          nextVal !== null &&
          prevVal > prev.limit &&
          nextVal > ep.limit &&
          Math.abs(prev.limit - ep.limit) < EPS
        ) {
          // 合并为同一事件，并显式插入 UNKNOWN 证据段
          const unknownSeg: SubSeg = {
            kind: 'GAP_UNKNOWN',
            from: prev.to,
            to: ep.from,
            valueAtStart: prevVal,
            valueAtEnd: nextVal,
            peak: Math.max(prevVal, nextVal),
            peakAt: prev.peakAt,
          };
          prev.segments = [...prev.segments, unknownSeg, ...ep.segments];
          prev.to = ep.to;
          prev.endCensored = ep.endCensored;
          prev.boundaryEnd = ep.boundaryEnd;
          prev.startBoundary = prev.startBoundary;
          prev.endCause = ep.endCause;
          if (ep.peak > prev.peak) {
            prev.peak = ep.peak;
            prev.peakAt = ep.peakAt;
          }
          prev.excessArea += ep.excessArea;
          gap.insideEvent = true;
          gap.effect = '采样空档嵌在本事件中间：两侧实测均超限，空档内不计入超标时长（UNKNOWN），事件保持“未证实连续”。';
          continue;
        }
      }
      merged.push(ep);
    }

    for (const ep of merged) {
      const evidenceSegments = buildEvidenceSegments(ep, ep.limit);
      // 为未合并的纯采样空档在事件之后标注“事件之间”，已合并的已在证据段内
      const measured = evidenceSegments.filter((s) => s.kind === 'MEASURED');
      const interpolated = evidenceSegments.filter((s) => s.kind === 'INTERPOLATED');
      const unknown = evidenceSegments.filter((s) => s.kind === 'GAP_UNKNOWN');
      const atWindowEnd = Math.abs(ep.to - ep.window.to) <= 1 && ep.endCensored && !ep.boundaryEnd;
      const evidentiary = evidentiaryFromSegments(ctx, ep, evidenceSegments, readingMap);
      const readingsInEvent = new Set(evidenceSegments.flatMap((s) => s.readingIds));
      const sourceFileIds = [...new Set([...readingsInEvent].map((id) => readingMap.get(id)?.sourceFileId).filter((v): v is string => Boolean(v)))];
      const overlapPieces = (ctx.pieces.get(pollutant) ?? []).filter((p) => p.to > ep.from && p.from < ep.to);
      const sourceStateIds = [...new Set(overlapPieces.flatMap((p) => [p.stateId, p.flowStateId]).filter((v): v is string => Boolean(v)))];

      const evidenceEnd = evidenceSegments[evidenceSegments.length - 1]?.to ?? ep.to;
      const eventStart = evidenceSegments[0]?.from ?? ep.from;
      const eventEnd = ep.endCensored || ep.boundaryEnd ? null : evidenceEnd;
      const startBoundary = ep.startBoundary || startSegIsBoundary(evidenceSegments[0], ep.limit);
      const status: EventStatus =
        !atWindowEnd && (ep.boundaryEnd || startBoundary)
          ? 'OPEN_BOUNDARY'
          : statusOf(ep.endCause, atWindowEnd, ep.window.to, ctx.windowTo);
      const unknownSeconds = unknown.reduce((a, s) => a + s.seconds, 0);
      const measuredSeconds = measured.reduce((a, s) => a + s.seconds, 0);
      const interpolatedSeconds = interpolated.reduce((a, s) => a + s.seconds, 0);
      const durationSeconds = measuredSeconds + interpolatedSeconds;
      const spanSeconds = (evidenceEnd - eventStart) / 1000;
      const boundaryList = eventBoundaries(ep, status);
      for (const u of unknown) {
        boundaryList.push(
          { at: u.from, kind: 'STATE_CUT', refId: null, label: '采样空档开始：插值链终止（此处不判定持续超标）', interpolated: false },
          { at: u.to, kind: 'GAP_END', refId: null, label: '采样空档结束：证据恢复，事件跨空档延续为“未证实连续”', interpolated: false },
        );
      }
      boundaryList.sort((a, b) => a.at - b.at);

      const intervalEvidence: IntervalEvidence = {
        measuredSeconds,
        interpolatedSeconds,
        unknownSeconds,
        excessAreaMgLs: ep.excessArea,
        segments: evidenceSegments,
        continuous: unknownSeconds <= 0,
        interpolationRule:
          '相邻实测结点间线性插值；只在同一实例、同一校准体制、OK 状态、标称间隔内进行，绝不跨状态/校准/实例/采样空档插值（采样空档只在两侧均实测超限且 ≤15 分钟时并入事件并标注 UNKNOWN）。',
        unknownPolicy:
          '未知空档不计入超标时长；事件跨空档时状态保持开放/未证实连续，须由迟到读数或人工复核补充证据，不得以相邻高值推定。',
        notes: [
          unknownSeconds > 0
            ? `事件内有 ${(unknownSeconds / 60).toFixed(1)} 分钟未知空档；该段既不计实测也不计插值，持续超标结论不覆盖该段。`
            : '事件内无可插值以外的未知空档。',
          measuredSeconds > 0 ? `实测连续超限 ${measuredSeconds.toFixed(0)} 秒（两端实测读数均高于限值）。` : '无两端实测均超限的区段，全部由插值给出。',
        ],
      };
      const eventId = `EV-${pollutant}-${Math.round(ep.from)}-${Math.round(ep.limit * 100)}`;
      const excessLoad = excessLoadFor(ctx, ep, pollutant, evidenceSegments);
      events.push({
        eventId,
        pointCode,
        plantId: ctx.point.plantId,
        day,
        pollutant,
        kind: 'EXCEEDANCE',
        startAt: eventStart,
        endAt: eventEnd,
        status,
        limit: ep.limit,
        standardId: ep.window.standardId,
        limitBasis: `${ep.window.basis}（${ep.window.grade}）`,
        limitChangeAt: status === 'OPEN_LIMIT_CHANGE' ? ep.window.to : null,
        measuredSeconds,
        interpolatedSeconds,
        unknownSeconds,
        durationSeconds,
        spanSeconds,
        peak: ep.peak,
        peakAt: ep.peakAt,
        excessAreaMgLs: ep.excessArea,
        excessLoadKg: excessLoad.bounds,
        evidence: intervalEvidence,
        endReason: ep.endCensored ? ep.endCause : 'BELOW_LIMIT',
        boundaries: boundaryList,
        standardWindow: ep.window,
        sourceReadingIds: [...readingsInEvent].sort(),
        sourceStateIds,
        sourceFileIds,
        dispositionIds: [],
        strategy,
        derivedAt: Date.now(),
        engineVersion: EVENT_ENGINE_VERSION,
        notes: [
          ...evidentiary.notes,
          `限值 ${ep.limit} mg/L 来自 ${ep.window.standardId}；证据段 ${evidenceSegments.length} 个。`,
        ],
      });
    }
  }

  // 缺口与事件关联（两侧各有一个开放边界）
  for (const g of allGaps) {
    if (g.insideEvent) continue;
    const evidenceEnd = (e: ExceedanceEvent) => e.endAt ?? e.startAt + e.spanSeconds * 1000;
    const beforeEvent = events.find((e) => e.endAt === null && Math.abs(evidenceEnd(e) - g.from) <= 1);
    const afterEvent = events.find((e) => Math.abs(e.startAt - g.to) <= 1);
    if (beforeEvent && afterEvent) g.insideEvent = true;
  }

  events.sort((a, b) => a.startAt - b.startAt || a.pollutant.localeCompare(b.pollutant));
  allGaps.sort((a, b) => a.from - b.from || a.pollutant.localeCompare(b.pollutant));
  for (const e of events) e.notes.push(...eventNotes(e));

  const perPollutant: PollutantEventStats[] = (['COD', 'NH3N'] as Pollutant[]).map((pollutant) => {
    const list = events.filter((e) => e.pollutant === pollutant);
    const gaps = allGaps.filter((g) => g.pollutant === pollutant);
    const load = list.map((e) => e.excessLoadKg).filter((v): v is LoadBounds => Boolean(v));
    return {
      pollutant,
      eventCount: list.length,
      measuredSeconds: list.reduce((a, e) => a + e.measuredSeconds, 0),
      interpolatedSeconds: list.reduce((a, e) => a + e.interpolatedSeconds, 0),
      unknownSeconds: list.reduce((a, e) => a + e.unknownSeconds, 0) + gaps.reduce((a, g) => a + g.seconds, 0),
      maxPeak: list.reduce((a, e) => Math.max(a, e.peak), 0),
      excessAreaMgLs: list.reduce((a, e) => a + e.excessAreaMgLs, 0),
      excessLoadKg:
        load.length > 0
          ? {
              min: load.reduce((a, b) => a + b.min, 0),
              best: load.reduce((a, b) => a + b.best, 0),
              max: load.reduce((a, b) => a + b.max, 0),
            }
          : null,
      openEvents: list.filter((e) => e.status !== 'CLOSED').length,
      limitSegments: ctx.standardWindows[pollutant].map((w) => ({
        limit: w.limit,
        from: w.from,
        to: w.to,
        standardId: w.standardId,
      })),
    };
  });

  const readings = new Set(events.flatMap((e) => e.sourceReadingIds));
  const signature = computeInputSignature(dataset, pointCode, day, ctx);
  const computeMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - started;
  const notes: string[] = [
    '事件由“有效浓度片段 × 标准窗口 × 状态边界 × 间隔证据”推出；不是逐行阈值比较。',
    '穿越点由相邻实测读数线性插值推算；插值只在同一实例、同一校准体制、OK 状态内进行。',
    '清洗/校准/旁路/故障开始的时刻立即终止插值链；采样空档不凭相邻高值臆造持续超标。',
    '限值中途调整处事件必须切开，两侧分别引用各自标准窗口。',
  ];
  if (ctx.standardConflicts.length > 0) notes.push(`标准适用库存在 ${ctx.standardConflicts.length} 处同时适用的规则，已按确定性规则裁决并披露。`);
  if (events.some((e) => e.unknownSeconds > 0)) notes.push('存在跨采样空档延续的事件：未知段单独计量，未计入超标时长。');
  if (events.some((e) => e.status === 'OPEN_LIMIT_CHANGE')) notes.push('存在因限值调整被切开的事件；后一段另立事件并重新判定。');
  if (['COD', 'NH3N'].some((p) => ctx.standardWindows[p as Pollutant].length > 1))
    notes.push('当日标准窗口多于一个（限值有调整）；请核对申报日报是否分别覆盖各窗口。');

  return {
    day,
    pointCode,
    plantId: ctx.point.plantId,
    strategy,
    computedAt: Date.now(),
    computeMs,
    engineVersion: EVENT_ENGINE_VERSION,
    windows,
    conflicts,
    events,
    gaps: allGaps,
    perPollutant,
    inputSignature: signature,
    sourceReadingIds: [...readings].sort(),
    sourceFileIds: [...new Set(events.flatMap((e) => e.sourceFileIds))].sort(),
    sourceStateIds: [...new Set(events.flatMap((e) => e.sourceStateIds))].sort(),
    sourceCalibrationIds: [...new Set(events.flatMap((e) => e.evidence.segments.map((s) => s.calibrationId)).filter((v): v is string => Boolean(v)))].sort(),
    sourceStandardIds: [...new Set(windows.map((w) => w.standardId))].sort(),
    sourceDispositionIds: [],
    notes,
  };
}

function evidentiaryFromSegments(ctx: DayContext, ep: Episode, segs: EvidenceSegment[], readingMap: Map<string, Reading>) {
  const notes: string[] = [];
  const missingFlow = segs.some((s) => {
    const piece = ctx.pieces.get(ep.window.pollutant)?.find((p) => p.to > s.from && p.from < s.to);
    return !piece || piece.flowState !== 'OK';
  });
  if (missingFlow) notes.push('事件部分时段流量证据缺失（旁路/故障），超额负荷只能标记为不可计。');
  const sus = segs.some((s) => s.readingIds.some((id) => readingMap.get(id)?.qualityFlag === 'SUSPECT'));
  if (sus) notes.push('事件证据包含 SUSPECT 读数，相关时长与峰值应结合不确定度复核。');
  return { notes };
}

/** 超额负荷：∫(c−limit)+ q dt /3.6e6；流量缺失时返回 null */
function excessLoadFor(
  ctx: DayContext,
  ep: Episode,
  pollutant: Pollutant,
  segs: EvidenceSegment[],
): { bounds: LoadBounds | null } {
  const pieces = ctx.pieces.get(pollutant) ?? [];
  const flowPieces = pieces.filter((p) => p.to > ep.from && p.from < ep.to);
  if (flowPieces.length === 0 || flowPieces.some((p) => !p.flow || p.flowState !== 'OK')) return { bounds: null };
  const times = new Set<number>([ep.from, ep.to]);
  for (const s of segs) {
    times.add(s.from);
    times.add(s.to);
  }
  for (const p of flowPieces) for (const k of p.flow?.knots ?? []) if (k.at > ep.from && k.at < ep.to) times.add(k.at);
  const sorted = [...times].sort((a, b) => a - b);
  let best = 0;
  let rel = 0;
  let counted = 0;
  for (let i = 1; i < sorted.length; i += 1) {
    const a = sorted[i - 1];
    const b = sorted[i];
    if (b - a <= EPS) continue;
    const concPiece = pieces.find((p) => p.to > a && p.from < b) ?? ep.run.piece;
    const flowPiece = flowPieces.find((p) => p.to > a && p.from < b);
    if (!concPiece.conc || !flowPiece?.flow) continue;
    const ca = concPiece.conc.valueAt(a);
    const cb = concPiece.conc.valueAt(b);
    const qa = flowPiece.flow.valueAt(a);
    const qb = flowPiece.flow.valueAt(b);
    if (ca === null || cb === null || qa === null || qb === null) continue;
    const ea = Math.max(0, ca - ep.limit);
    const eb = Math.max(0, cb - ep.limit);
    const seconds = (b - a) / 1000;
    best += (((ea + eb) / 2) * ((qa + qb) / 2) * seconds) / 3_600_000;
    rel = Math.max(
      rel,
      combineRelative(
        concPiece.calibration?.coefficientUncertainty ?? concPiece.concInstrument?.valueUncertainty ?? 0.02,
        flowPiece.flowCalibration?.coefficientUncertainty ?? flowPiece.flowInstrument?.valueUncertainty ?? 0.02,
      ),
    );
    counted += seconds;
  }
  if (counted <= 0) return { bounds: null };
  const unc = best * rel * ctx.scope.uncertaintyMultiplier;
  return { bounds: { min: Math.max(0, best - unc), best, max: best + unc } };
}

function eventNotes(e: ExceedanceEvent): string[] {
  const out: string[] = [];
  if (e.unknownSeconds > 0) out.push(`含未知空档 ${(e.unknownSeconds / 60).toFixed(1)} 分钟：持续超标不覆盖该段。`);
  if (e.status === 'OPEN_LIMIT_CHANGE') out.push('结束于限值调整时刻：后半段另立事件，不能合并为一次超标。');
  if (e.status === 'OPEN_DATA_GAP') out.push('证据在清洗/空档/故障处中断：事件保持开放，不得推定持续超标已消失或继续。');
  if (e.status === 'OPEN_END_OF_WINDOW') out.push('到达窗口终点仍高于限值：需跨日证据或人工判断。');
  if (e.status === 'OPEN_BOUNDARY') out.push('结束于证据链/仪表边界，未能实测回落。');
  return out;
}

/* ------------------------------------------------------------------ *
 * 输入签名：任何读数、状态、校准、标准的变化都会改变它
 * ------------------------------------------------------------------ */

function fnv1a(input: string, seed = 0x811c9dc5): string {
  let h = seed >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function stableHash(parts: string[]): string {
  const text = parts.join('|');
  return `${fnv1a(text)}${fnv1a(text, 0x9e3779b9)}`;
}

/** 轻量签名：只建索引，不编织片段（用于判断缓存是否过旧） */
export function computeSignatureLight(dataset: Dataset, pointCode: string, day: string): InputSignature {
  const index = buildIndex(dataset.readings, dataset.instruments, dataset.calibrations, dataset.states, dataset.bindings);
  return computeInputSignatureWith(dataset, pointCode, day, index);
}

export function computeInputSignature(dataset: Dataset, pointCode: string, day: string, ctx: DayContext): InputSignature {
  return computeInputSignatureWith(dataset, pointCode, day, ctx.index);
}

function computeInputSignatureWith(dataset: Dataset, pointCode: string, day: string, index: TimelineIndex): InputSignature {
  const readings = dataset.readings.filter((r) => r.pointCode === pointCode && r.dayKey === day);
  const readingIds = readings.map((r) => r.readingId).sort();
  const latestReceivedAt = readings.reduce((a, r) => Math.max(a, r.receivedAt), 0);
  const states = index.statesByInstrument;
  const stateIds: string[] = [];
  for (const inst of dataset.instruments.filter((i) => i.pointCode === pointCode)) {
    for (const s of states.get(inst.instrumentId) ?? []) stateIds.push(`${s.stateId}:${s.state}:${s.from}:${s.to ?? 'open'}`);
  }
  const calibrationParts: string[] = [];
  for (const inst of dataset.instruments.filter((i) => i.pointCode === pointCode)) {
    for (const c of index.calibrationsByInstrument.get(inst.instrumentId) ?? [])
      calibrationParts.push(`${c.calibrationId}:${c.scale}:${c.offset}:${c.effectiveAt}`);
  }
  const standardParts = dataset.standards
    .filter((s) => s.pointCode === pointCode)
    .map((s) => `${s.standardId}:${s.pollutant}:${s.limitValue}:${s.effectiveFrom}:${s.effectiveTo ?? 'open'}:${s.createdAt}`)
    .sort();
  const signature = stableHash([
    ...readingIds,
    String(latestReceivedAt),
    ...stateIds.sort(),
    ...calibrationParts.sort(),
    ...standardParts,
  ]);
  return {
    readingIdsHash: stableHash(readingIds),
    stateIdsHash: stableHash(stateIds.sort()),
    calibrationIdsHash: stableHash(calibrationParts.sort()),
    standardIdsHash: stableHash(standardParts),
    readingCount: readings.length,
    latestReceivedAt,
    standardRevision: stableHash(standardParts),
    signature,
  };
}

/* ------------------------------------------------------------------ *
 * 两种派生方案的一致性证明
 * ------------------------------------------------------------------ */

export interface DerivationEquivalence {
  equal: boolean;
  eventCount: number;
  mismatches: string[];
  signatureEqual: boolean;
}

/** 对同一冻结输入，两种策略必须给出相同事件集合 */
export function compareDerivations(a: DayEventSummary, b: DayEventSummary): DerivationEquivalence {
  const mismatches: string[] = [];
  const key = (e: ExceedanceEvent) => e.eventId;
  const mapA = new Map(a.events.map((e) => [key(e), e]));
  const mapB = new Map(b.events.map((e) => [key(e), e]));
  for (const id of mapA.keys()) if (!mapB.has(id)) mismatches.push(`仅方案 A 有事件 ${id}`);
  for (const id of mapB.keys()) if (!mapA.has(id)) mismatches.push(`仅方案 B 有事件 ${id}`);
  for (const [id, ea] of mapA) {
    const eb = mapB.get(id);
    if (!eb) continue;
    const fields: (keyof ExceedanceEvent)[] = [
      'startAt',
      'endAt',
      'measuredSeconds',
      'interpolatedSeconds',
      'unknownSeconds',
      'peak',
      'limit',
      'status',
    ];
    for (const f of fields) {
      const va = ea[f];
      const vb = eb[f];
      const equal = typeof va === 'number' && typeof vb === 'number' ? Math.abs(va - vb) < 1e-6 : va === vb;
      if (!equal) mismatches.push(`${id}.${String(f)}: ${String(va)} ≠ ${String(vb)}`);
    }
  }
  return {
    equal: mismatches.length === 0,
    eventCount: a.events.length,
    mismatches,
    signatureEqual: a.inputSignature.signature === b.inputSignature.signature,
  };
}

/* ------------------------------------------------------------------ *
 * 派生影响：缓存何时成批失效
 * ------------------------------------------------------------------ */

function eventChanged(a: ExceedanceEvent, b: ExceedanceEvent): boolean {
  return (
    a.startAt !== b.startAt ||
    a.endAt !== b.endAt ||
    Math.abs(a.limit - b.limit) > EPS ||
    a.status !== b.status ||
    Math.abs(a.durationSeconds - b.durationSeconds) > 1e-6 ||
    a.sourceReadingIds.join(',') !== b.sourceReadingIds.join(',')
  );
}

export interface SnapshotDiff {
  added: ExceedanceEvent[];
  removed: ExceedanceEvent[];
  changed: { before: ExceedanceEvent; after: ExceedanceEvent }[];
  unchanged: ExceedanceEvent[];
  reasons: string[];
}

export function diffEventSummaries(before: DayEventSummary, after: DayEventSummary): SnapshotDiff {
  const mapA = new Map(before.events.map((e) => [e.eventId, e]));
  const mapB = new Map(after.events.map((e) => [e.eventId, e]));
  const added = after.events.filter((e) => !mapA.has(e.eventId));
  const removed = before.events.filter((e) => !mapB.has(e.eventId));
  const changed: { before: ExceedanceEvent; after: ExceedanceEvent }[] = [];
  const unchanged: ExceedanceEvent[] = [];
  for (const [id, a] of mapA) {
    const b = mapB.get(id);
    if (!b) continue;
    if (eventChanged(a, b)) changed.push({ before: a, after: b });
    else unchanged.push(b);
  }
  const reasons: string[] = [];
  if (before.inputSignature.signature !== after.inputSignature.signature) {
    reasons.push(`输入签名变化：${before.inputSignature.signature.slice(0, 8)} → ${after.inputSignature.signature.slice(0, 8)}`);
    if (before.inputSignature.readingCount !== after.inputSignature.readingCount)
      reasons.push(`读数数量 ${before.inputSignature.readingCount} → ${after.inputSignature.readingCount}（补传/修订）`);
    if (before.inputSignature.latestReceivedAt !== after.inputSignature.latestReceivedAt)
      reasons.push('存在更晚接收时刻的读数（迟到补传）');
    if (before.inputSignature.standardRevision !== after.inputSignature.standardRevision)
      reasons.push('标准适用库限值版本变化（限值调整）');
    if (before.inputSignature.stateIdsHash !== after.inputSignature.stateIdsHash) reasons.push('状态台账变化');
    if (before.inputSignature.calibrationIdsHash !== after.inputSignature.calibrationIdsHash) reasons.push('校准台账变化');
  }
  if (removed.length + changed.length > 0)
    reasons.push(`受影响的来源窗口 ${removed.length + changed.length} 个：这些事件必须重新推导，不能以旧缓存代替当前证据`);
  return { added, removed, changed, unchanged, reasons };
}
