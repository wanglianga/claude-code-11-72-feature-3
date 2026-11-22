/**
 * 标准适用库：排口 × 因子 × 时段 × 限值生效日期
 *
 * 限值不是常量。任何中途调整都在这里形成一条带 [effectiveFrom, effectiveTo) 的规则；
 * 查询时把自然日按生效边界切成"标准窗口"，每个窗口内限值唯一。
 *
 * 裁决（当同一时刻有多条规则同时适用，例如新旧标准交叠一天）：
 *   1. 起点更晚者优先（更具体的近期规定）；
 *   2. 起点相同则 createdAt 更晚者优先（后录入的修订）；
 *   3. 仍相同则 standardId 字典序较大者优先，保证结果确定、可复现。
 * 被压制的规则记入 conflictIds，并在页面上显式披露，绝不静默取值。
 */

import type { Pollutant, StandardConflict, StandardRule, StandardWindow } from './types';
import { EPS } from './stats';

export interface StandardContext {
  pointCode: string;
  pollutant: Pollutant;
  /** 兜底限值（来自厂站台账），仅在标准库完全没有覆盖该窗口时使用 */
  fallbackLimit: number;
  /** 规则按生效时刻升序 */
  rules: StandardRule[];
  windows: StandardWindow[];
  conflicts: StandardConflict[];
  notes: string[];
}

function covers(rule: StandardRule, at: number): boolean {
  return rule.effectiveFrom <= at && (rule.effectiveTo === null || at < rule.effectiveTo);
}

export function ruleCovers(rule: StandardRule, at: number): boolean {
  return covers(rule, at);
}

/** 同一时刻多条规则同时适用时的确定性裁决 */
function resolveAt(rules: StandardRule[]): StandardRule {
  return [...rules].sort(
    (a, b) =>
      b.effectiveFrom - a.effectiveFrom ||
      b.createdAt - a.createdAt ||
      b.standardId.localeCompare(a.standardId),
  )[0];
}

export function rulesForPoint(dataset: { standards: StandardRule[] }, pointCode: string, pollutant: Pollutant): StandardRule[] {
  return dataset.standards
    .filter((r) => r.pointCode === pointCode && r.pollutant === pollutant)
    .sort((a, b) => a.effectiveFrom - b.effectiveFrom || a.createdAt - b.createdAt || a.standardId.localeCompare(b.standardId));
}

/**
 * 构造 [windowFrom, windowTo) 内的标准窗口。
 * 窗口边界来自所有规则的起止时刻（含跨日规则），窗口内限值唯一。
 */
export function buildStandardContext(
  dataset: { standards: StandardRule[] },
  pointCode: string,
  pollutant: Pollutant,
  windowFrom: number,
  windowTo: number,
  fallbackLimit: number,
): StandardContext {
  const all = dataset.standards.filter((r) => r.pointCode === pointCode && r.pollutant === pollutant);
  const rules = all.sort(
    (a, b) => a.effectiveFrom - b.effectiveFrom || a.createdAt - b.createdAt || a.standardId.localeCompare(b.standardId),
  );
  const cuts = new Set<number>([windowFrom, windowTo]);
  for (const r of rules) {
    for (const t of [r.effectiveFrom, r.effectiveTo]) {
      if (t !== null && t > windowFrom && t < windowTo) cuts.add(t);
    }
  }
  const sorted = [...cuts].sort((a, b) => a - b);
  const windows: StandardWindow[] = [];
  const conflicts: StandardConflict[] = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const from = sorted[i - 1];
    const to = sorted[i];
    if (to - from <= EPS) continue;
    const mid = (from + to) / 2;
    const applicable = rules.filter((r) => covers(r, mid));
    if (applicable.length === 0) {
      windows.push({
        standardId: `FALLBACK-${pollutant}`,
        pollutant,
        limit: fallbackLimit,
        from,
        to,
        basis: '厂站台账兜底限值（标准库未覆盖该时段）',
        grade: '兜底',
        conflictIds: [],
      });
      continue;
    }
    const winner = resolveAt(applicable);
    const losers = applicable.filter((r) => r.standardId !== winner.standardId);
    if (losers.length > 0) {
      conflicts.push({
        at: from,
        pollutant,
        ruleIds: applicable.map((r) => r.standardId),
        resolvedTo: winner.standardId,
        reason: `同一时段 ${applicable.length} 条标准同时适用，按“起点更晚 → 录入更晚 → 编号”裁决为 ${winner.standardId}`,
      });
    }
    windows.push({
      standardId: winner.standardId,
      pollutant,
      limit: winner.limitValue,
      from,
      to,
      basis: winner.basis,
      grade: winner.grade,
      conflictIds: losers.map((r) => r.standardId),
    });
  }
  const notes: string[] = [];
  if (windows.some((w) => w.standardId.startsWith('FALLBACK'))) {
    notes.push('存在标准库未覆盖的时段，暂用厂站台账兜底限值；此类时段必须复核。');
  }
  const revoked = rules.filter((r) => r.effectiveTo !== null && r.effectiveTo > windowFrom && r.effectiveFrom < windowTo);
  if (revoked.length > 0) {
    notes.push(`当日有 ${revoked.length} 条标准规则参与切分（含已失效版本）；限值调整处事件必须切开。`);
  }
  return { pointCode, pollutant, fallbackLimit, rules, windows, conflicts, notes };
}

/** 某时刻适用的限值（窗口已裁决） */
export function windowAt(windows: StandardWindow[], at: number): StandardWindow | null {
  for (const w of windows) if (w.from <= at && at < w.to) return w;
  return null;
}

/** 一段时间可能跨越多个限值窗口：返回全部命中窗口 */
export function windowsIn(windows: StandardWindow[], from: number, to: number): StandardWindow[] {
  return windows.filter((w) => w.from < to && w.to > from);
}

/** 有效限值调整时刻（严格落在窗口内部） */
export function limitChangeTimes(windows: StandardWindow[], windowFrom: number, windowTo: number): number[] {
  const out: number[] = [];
  for (const w of windows) {
    if (w.from > windowFrom && w.from < windowTo) out.push(w.from);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}
