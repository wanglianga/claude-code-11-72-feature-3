import { fmtDateTime, fmtDuration, fmtNum, fmtRange } from '../domain/time';
import type { EligibilityStatus, LoadBounds } from '../domain/types';

export { fmtDateTime, fmtDuration, fmtNum, fmtRange };

export function pct(n: number, digits = 2): string {
  return `${(n * 100).toFixed(digits)}%`;
}

export function kg(bounds: LoadBounds, digits = 3): string {
  return fmtNum(bounds.best, digits);
}

export function kgRange(bounds: LoadBounds, digits = 3): string {
  return `${fmtNum(bounds.min, digits)} – ${fmtNum(bounds.max, digits)}`;
}

export function eligibilityBadge(status: EligibilityStatus): { cls: string; label: string } {
  if (status === 'ELIGIBLE') return { cls: 'ok', label: '可申报' };
  if (status === 'CONDITIONAL') return { cls: 'warn', label: '有条件申报' };
  return { cls: 'bad', label: '不可申报' };
}

export const METHOD_LABEL: Record<string, string> = {
  SEGMENT: '逐有效片段积分',
  RESAMPLE: '误差界重采样积分',
};

export const GAP_LABEL: Record<string, string> = {
  SAMPLING_GAP: '采样空档',
  INSTRUMENT_GAP: '无仪表归属',
  NO_EFFECTIVE_STATE: '无有效状态',
  CALIBRATION_EDGE: '校准边沿',
  EXCLUDED_STATE: '排除状态',
};

export const CATEGORY_LABEL: Record<string, string> = {
  VALID: '有效',
  EXCLUDED_STATE: '排除状态',
  SAMPLING_GAP: '采样空档',
  NO_INSTRUMENT: '无仪表',
  NO_STATE: '无状态',
};

export const BOUNDARY_LABEL: Record<string, string> = {
  DAY_START: '自然日起点',
  DAY_END: '自然日终点',
  CALIBRATION: '校准生效',
  STATE: '状态切换',
  INSTRUMENT_SWAP: '设备交接',
  STANDARD_CHANGE: '限值调整',
  GAP: '采样空档端点',
};

export const EVENT_STATUS_LABEL: Record<string, string> = {
  CLOSED: '已闭合',
  OPEN_BOUNDARY: '开放：边界未回落',
  OPEN_END_OF_WINDOW: '开放：跨自然日',
  OPEN_DATA_GAP: '开放：证据中断',
  OPEN_LIMIT_CHANGE: '切开：限值调整',
};

export function eventStatusBadge(status: string): { cls: string; label: string } {
  if (status === 'CLOSED') return { cls: 'ok', label: EVENT_STATUS_LABEL.CLOSED };
  if (status === 'OPEN_LIMIT_CHANGE') return { cls: 'info', label: EVENT_STATUS_LABEL.OPEN_LIMIT_CHANGE };
  return { cls: 'warn', label: EVENT_STATUS_LABEL[status] ?? status };
}

export const EVIDENCE_KIND_LABEL: Record<string, string> = {
  MEASURED: '实测',
  INTERPOLATED: '插值',
  GAP_UNKNOWN: '未知空档',
  UNMODELLED: '未建模',
};

export const EVENT_BOUNDARY_LABEL: Record<string, string> = {
  CROSS_UP: '上穿限值',
  CROSS_DOWN: '下穿限值',
  STATE_CUT: '状态切断',
  GAP_START: '空档开始',
  GAP_END: '空档结束',
  LIMIT_CHANGE: '限值调整',
  INSTRUMENT_SWAP: '仪表交接',
  WINDOW_END: '窗口终点',
  CENSOR_START: '边界/截断',
};

/** 标准依据的简称（用于提示） */
export function STANDARD_LABEL(key: string): string {
  if (key === 'GB18918') return '《城镇污水处理厂污染物排放标准》GB 18918-2002';
  return key;
}

export function shortTime(ms: number): string {
  return fmtDateTime(ms).slice(11);
}

export function shortDate(ms: number): string {
  return fmtDateTime(ms).slice(5, 10);
}

export function hashShort(sha: string): string {
  return `${sha.slice(0, 12)}…${sha.slice(-6)}`;
}

export function trimId(id: string, head = 18, tail = 10): string {
  if (id.length <= head + tail + 1) return id;
  return `${id.slice(0, head)}…${id.slice(-tail)}`;
}
