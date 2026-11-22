/**
 * 处置关联簿：把加药、旁路、维护、清洗记录挂到事件上。
 *
 * 铁律：同现不等于因果。这里只做“时间上重叠/邻近”的关联，causalClaim 恒为 false；
 * 处置记录不能把已成立的事件判为消失，也不能替代实测回落证据。
 * 迟到（晚于申报截止）的处置记录只能作为补充证据，标注 late=true。
 */

import type {
  DispositionRecord,
  ExceedanceEvent,
  LoadBounds,
  Pollutant,
} from './types';

export interface DispositionLink {
  disposition: DispositionRecord;
  overlapSeconds: number;
  /** 与事件开始/结束的最近距离（秒），0 表示重叠 */
  distanceSeconds: number;
  relation: 'OVERLAPS' | 'BEFORE' | 'AFTER';
  /** 是否为申报截止后到达的迟到记录 */
  late: boolean;
  /** 恒为 false：只登记关联，不宣称因果 */
  causalClaim: false;
  /** 该记录能否“解释”事件（只用于提示，不修改事件结论） */
  explanatoryOnly: boolean;
  note: string;
}

export function dispositionsFor(dataset: { dispositions: DispositionRecord[] }, pointCode: string): DispositionRecord[] {
  return dataset.dispositions.filter((d) => d.pointCode === pointCode).sort((a, b) => a.from - b.from);
}

export function dispositionAppliesTo(d: DispositionRecord, pollutant: Pollutant): boolean {
  return d.pollutant === 'ANY' || d.pollutant === pollutant;
}

/** 处置记录与事件的关联（不改变事件本身） */
export function linkDispositions(
  event: ExceedanceEvent,
  dispositions: DispositionRecord[],
  cutoffReceivedAt: number,
): DispositionLink[] {
  const eventFrom = event.startAt;
  const eventTo = event.endAt ?? event.startAt + event.spanSeconds * 1000;
  const links: DispositionLink[] = [];
  for (const d of dispositions) {
    if (!dispositionAppliesTo(d, event.pollutant)) continue;
    const overlap = Math.max(0, Math.min(eventTo, d.to) - Math.max(eventFrom, d.from));
    const distance = overlap > 0 ? 0 : Math.min(Math.abs(d.from - eventTo), Math.abs(d.to - eventFrom));
    if (overlap <= 0 && distance > 30 * 60_000) continue; // 30 分钟以内才登记为邻近
    const relation: DispositionLink['relation'] =
      overlap > 0 ? 'OVERLAPS' : d.to <= eventFrom ? 'BEFORE' : 'AFTER';
    const late = d.receivedAt > cutoffReceivedAt;
    links.push({
      disposition: d,
      overlapSeconds: overlap / 1000,
      distanceSeconds: distance / 1000,
      relation,
      late,
      causalClaim: false,
      explanatoryOnly: true,
      note:
        relation === 'OVERLAPS'
          ? '与事件时段重叠；只登记同现，不能据此判定事件由该处置造成或已消失。'
          : relation === 'BEFORE'
            ? '事件发生前有处置记录；可能相关，但不构成因果，也不改变事件起止。'
            : '事件结束后有处置记录；只能视为后续处置，不能追溯抹除已发生的超标。',
    });
  }
  return links.sort((a, b) => a.distanceSeconds - b.distanceSeconds || a.disposition.from - b.disposition.from);
}

/** 迟到处置记录的补证说明：只补充解释，不修改事件 */
export function lateDispositionEffect(links: DispositionLink[]): string[] {
  const notes: string[] = [];
  const late = links.filter((l) => l.late);
  if (late.length === 0) return notes;
  notes.push(
    `有 ${late.length} 条处置记录在申报截止后到达（迟到）；按规则只补充证据与解释，不得据此宣布超标已消失。`,
  );
  for (const l of late) {
    notes.push(
      `迟到处置 ${l.disposition.dispositionId}（${l.disposition.kind}）：${l.note}`,
    );
  }
  return notes;
}

/** 事件超额负荷的旁路/加药上下文（仅展示） */
export function dispositionContext(links: DispositionLink[]): { kinds: string[]; summary: string } {
  const kinds = [...new Set(links.map((l) => l.disposition.kind))];
  if (links.length === 0) return { kinds, summary: '事件周边没有登记的处置记录。' };
  return {
    kinds,
    summary: `事件周边登记 ${links.length} 条处置记录（${kinds.join('、')}）；同现不代表因果，处置不能替代实测回落证据。`,
  };
}

export function emptyLoad(): LoadBounds {
  return { min: 0, best: 0, max: 0 };
}
