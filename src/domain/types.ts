/**
 * 领域模型：排口污染负荷离线复核
 *
 * 统一语义（全工程共用，UI 不得另作解释）：
 * - 对齐时间轴：alignedAt = sampledAt + instrument.clockOffsetMs（毫秒）。
 *   自然日按 alignedAt 在 Asia/Shanghai（固定 UTC+8）划分；receivedAt 保留平台接收证据。
 * - 点位编号可复用；binding(instrumentId, metric, from, to) 决定读数归属，设备交接处切开片段。
 * - 校准按“仪表实例 + effectiveAt”描述，自生效时刻起作用于后续读数；
 *   校准中途生效必须切片段，两侧分别引用各自校准记录与系数，不跨系数插值。
 * - 状态按“仪表实例 + [from,to)”描述；OK 以外的冲洗、校准、旁路、故障一律不得并入排放。
 * - 采样空档：同一实例相邻有效读数间隔超过 nominalInterval × 2.5 的区间，显式从积分扣除并量化影响。
 * - 申报版本 FILED 后不可改写；迟到读数只能形成锁定来源窗口的重算候选与差异说明。
 */

export type Pollutant = 'COD' | 'NH3N';
export type Metric = Pollutant | 'FLOW';

export type DeviceState = 'OK' | 'FLUSH' | 'CALIB' | 'BYPASS' | 'FAULT';

export const EXCLUDING_STATES: ReadonlySet<DeviceState> = new Set([
  'FLUSH',
  'CALIB',
  'BYPASS',
  'FAULT',
]);

export const STATE_LABELS: Record<DeviceState, string> = {
  OK: '正常',
  FLUSH: '冲洗',
  CALIB: '校准中',
  BYPASS: '旁路',
  FAULT: '故障',
};

export const METRIC_LABELS: Record<Metric, string> = {
  COD: 'COD',
  NH3N: '氨氮',
  FLOW: '流量',
};

export const POLLUTANTS: Pollutant[] = ['COD', 'NH3N'];

export const ENGINE_VERSION = '1.0.0';

export interface Plant {
  plantId: string;
  name: string;
  shortName: string;
  timezone: string;
  dischargeStandard: { COD: number; NH3N: number };
}

/* ------------------------------------------------------------------ *
 * 标准适用库：排口 × 因子 × 时段 × 限值生效日期
 * 限值不在代码里写死；任何中途调整都必须在标准库形成新版本，
 * 事件与阈值穿越都按限值窗口分别判定，绝不用一个常数覆盖全天。
 * ------------------------------------------------------------------ */

export interface StandardRule {
  standardId: string;
  pointCode: string;
  pollutant: Pollutant;
  /** 排放限值 mg/L */
  limitValue: number;
  /** 生效时刻（含），对齐时间轴 */
  effectiveFrom: number;
  /** 失效时刻（不含）；null 表示持续有效 */
  effectiveTo: number | null;
  /** 标准依据，例如《城镇污水处理厂污染物排放标准》 */
  basis: string;
  /** 等级/类别，例如 一级A、地方加严值 */
  grade: string;
  issuedBy: string;
  note: string;
  /** 录入/调整时刻：同起点多规则时作为确定性裁决依据 */
  createdAt: number;
  sourceFileId?: string;
}

/** 标准窗口：一天内按生效边界切开的单一限值区间 */
export interface StandardWindow {
  standardId: string;
  pollutant: Pollutant;
  limit: number;
  from: number;
  to: number;
  basis: string;
  grade: string;
  /** 同一窗口内被裁决掉的其他规则（多个标准同时适用时） */
  conflictIds: string[];
}

export interface StandardConflict {
  at: number;
  pollutant: Pollutant;
  ruleIds: string[];
  resolvedTo: string;
  reason: string;
}

/* ------------------------------------------------------------------ *
 * 处置关联簿：加药、旁路、维护、清洗记录。
 * 只登记“时间上落在事件附近”的记录，causalClaim 恒为 false：
 * 同现不等于因果，处置记录不能直接宣判事件消失。
 * ------------------------------------------------------------------ */

export type DispositionKind = 'DOSING' | 'BYPASS' | 'MAINTENANCE' | 'CLEANING' | 'OTHER';

export const DISPOSITION_LABELS: Record<DispositionKind, string> = {
  DOSING: '加药',
  BYPASS: '旁路',
  MAINTENANCE: '维护',
  CLEANING: '清洗',
  OTHER: '其他',
};

export interface DispositionRecord {
  dispositionId: string;
  pointCode: string;
  /** 针对的因子；ANY 表示不限因子 */
  pollutant: Pollutant | 'ANY';
  kind: DispositionKind;
  from: number;
  to: number;
  /** 平台接收时刻：晚于申报截止即为迟到 */
  receivedAt: number;
  recordedBy: string;
  summary: string;
  workOrder: string;
  sourceFileId: string;
  note: string;
}

export interface OutfallPoint {
  pointCode: string;
  plantId: string;
  name: string;
  /** 点位编号是否复用（同一编码先后承载不同物理排口/仪表链） */
  reused: boolean;
  designFlowM3h: number;
  note: string;
}

export interface Instrument {
  instrumentId: string;
  pointCode: string;
  plantId: string;
  kind: 'CONCENTRATION' | 'FLOW';
  /** 浓度仪为 COD 或 NH3N；流量仪为 FLOW */
  metric: Metric;
  model: string;
  serial: string;
  /** 基础系数：值 = raw * scale + offset（有校准记录时以校准为准） */
  scale: number;
  offset: number;
  /** 无校准记录时的默认相对不确定度（折算为区间半宽） */
  valueUncertainty: number;
  /** 标称上报间隔（秒）；空档阈值 = nominal × 2.5，片段边缘保持 = nominal × 0.75 */
  nominalIntervalSeconds: number;
  /** 设备实例在该点位上的有效区间 [installedAt, removedAt)，半开 */
  installedAt: number;
  removedAt: number | null;
  /** 时钟校正量：alignedAt = sampledAt + clockOffsetMs（毫秒） */
  clockOffsetMs: number;
  clockOffsetUncertaintyMs: number;
  note: string;
}

export interface Calibration {
  calibrationId: string;
  instrumentId: string;
  /** 生效时刻（对齐时间轴），参数自此时刻起作用于后续读数 */
  effectiveAt: number;
  /** 输出 = raw * scale + offset */
  scale: number;
  offset: number;
  /** 系数相对不确定度（折算为区间半宽） */
  coefficientUncertainty: number;
  operator: string;
  certificate: string;
  note: string;
}

export interface StatePeriod {
  stateId: string;
  instrumentId: string;
  state: DeviceState;
  from: number;
  /** null 表示开放式（到查询窗口末尾） */
  to: number | null;
  reason: string;
  workOrder: string;
}

/** 仪表实例与点位/指标的绑定有效期（点位编号复用靠它衔接） */
export interface Binding {
  bindingId: string;
  pointCode: string;
  instrumentId: string;
  metric: Metric;
  from: number;
  to: number | null;
}

export interface Reading {
  readingId: string;
  pointCode: string;
  plantId: string;
  instrumentId: string;
  metric: Metric;
  /** 采样时刻（设备时钟） */
  sampledAt: number;
  /** 对齐后的采样时刻 = sampledAt + clockOffsetMs */
  alignedAt: number;
  /** alignedAt 所属自然日（Asia/Shanghai） */
  dayKey: string;
  /** 接收时刻（平台时钟） */
  receivedAt: number;
  /** 原始值：浓度 mg/L，流量 m³/h */
  rawValue: number;
  qualityFlag: 'VALID' | 'SUSPECT' | 'INVALID';
  sourceFileId: string;
  sourceRow: number;
  /** 原始 CSV 行，用于回溯 */
  rawText?: string;
}

export type FileKind =
  | 'PLANT_REGISTER'
  | 'POINT_REGISTER'
  | 'INSTRUMENT_REGISTER'
  | 'BINDING_REGISTER'
  | 'CALIBRATION_REGISTER'
  | 'STATE_LOG'
  | 'STANDARD_REGISTER'
  | 'DISPOSITION_REGISTER'
  | 'READINGS'
  | 'LATE_BATCH';

export interface IntakeFile {
  fileId: string;
  fileName: string;
  sha256: string;
  sizeBytes: number;
  kind: FileKind;
  /** 平台接收时刻 */
  receivedAt: number;
  rowCount: number;
  acceptedRows: number;
  rejectedRows: number;
  rejectedReasons: string[];
  note: string;
  ingestedAt: number;
  ingestedBy: string;
  sample: boolean;
}

export type IntegrationMethod = 'SEGMENT' | 'RESAMPLE';

export interface LoadBounds {
  min: number;
  best: number;
  max: number;
}

export type ExceedanceInterval = {
  from: number;
  to: number;
  seconds: number;
  peak: number;
  peakAt: number;
  /** 该段所适用的限值（标准中途调整时不同段不同） */
  limit?: number;
};

/* ------------------------------------------------------------------ *
 * 事件推导：超标事件不是“某一行读数大于阈值”，而是
 *   有效浓度片段 × 标准窗口 × 状态边界 × 间隔证据 共同推出的时间区间。
 * 同一套规则同时服务于两种派生策略：
 *   PERSIST_SNAPSHOT  读数到达即物化带来源索引的事件片段（快，但补传/限值调整会成批失效）
 *   DERIVE_ON_DEMAND  只持久化原始有效片段与法规条件，查询时推导（修订影响小，计算移到查询端）
 * 两者必须对同一冻结输入给出同一事件集合；缓存过旧不得替代当前证据。
 * ------------------------------------------------------------------ */

export type DerivationStrategy = 'PERSIST_SNAPSHOT' | 'DERIVE_ON_DEMAND';

export const STRATEGY_LABELS: Record<DerivationStrategy, string> = {
  PERSIST_SNAPSHOT: '读数到达即物化（缓存）',
  DERIVE_ON_DEMAND: '查询时推导（按需）',
};

export type EventKind = 'EXCEEDANCE' | 'DATA_GAP';

export type EventStatus =
  | 'CLOSED'
  /** 边界读数恰在限值上/下、无法根本判定何时停止 */
  | 'OPEN_BOUNDARY'
  /** 自然日窗口结束时仍在限值之上 */
  | 'OPEN_END_OF_WINDOW'
  /** 断在清洗/校准/故障/采样空档，不能臆造持续超标 */
  | 'OPEN_DATA_GAP'
  /** 因标准中途调整被切开，后半段另立事件 */
  | 'OPEN_LIMIT_CHANGE';

export const EVENT_STATUS_LABELS: Record<EventStatus, string> = {
  CLOSED: '已闭合（实测回落）',
  OPEN_BOUNDARY: '开放：边界未落到限值以下',
  OPEN_END_OF_WINDOW: '开放：跨自然日',
  OPEN_DATA_GAP: '开放：证据中断',
  OPEN_LIMIT_CHANGE: '切开：限值调整',
};

export type EvidenceKind = 'MEASURED' | 'INTERPOLATED' | 'GAP_UNKNOWN' | 'UNMODELLED';

export const EVIDENCE_LABELS: Record<EvidenceKind, string> = {
  MEASURED: '实测超限',
  INTERPOLATED: '可插值超限',
  GAP_UNKNOWN: '未知空档',
  UNMODELLED: '未建模',
};

export type EvidenceEndReason =
  | 'BELOW_LIMIT'
  | 'CENSOR_BOUNDARY'
  | 'STATE_CHANGE'
  | 'CALIBRATION_CUT'
  | 'GAP_START'
  | 'LIMIT_CHANGE'
  | 'INSTRUMENT_SWAP'
  | 'WINDOW_END';

export const EVIDENCE_END_LABELS: Record<EvidenceEndReason, string> = {
  BELOW_LIMIT: '实测回落到限值以下',
  CENSOR_BOUNDARY: '边界读数恰在限值上，无法判定何时回落',
  STATE_CHANGE: '状态切换（清洗/校准/旁路/故障）终止插值链',
  CALIBRATION_CUT: '校准体制切换，证据链换校准系数',
  GAP_START: '采样空档开始，终止插值链',
  LIMIT_CHANGE: '标准限值调整，事件切开',
  INSTRUMENT_SWAP: '仪表交接，证据链换实例',
  WINDOW_END: '到达自然日/查询窗口终点',
};

/** 事件内的一段证据。只允许在相邻实测结点之间做线性插值，绝不跨状态/空档/校准/实例边界。 */
export interface EvidenceSegment {
  evidenceId: string;
  kind: EvidenceKind;
  from: number;
  to: number;
  seconds: number;
  startValue: number | null;
  endValue: number | null;
  peak: number | null;
  peakAt: number | null;
  instrumentId: string | null;
  calibrationId: string | null;
  state: DeviceState | null;
  readingIds: string[];
  boundaryRefs: string[];
  endReason: EvidenceEndReason;
  note: string;
}

export type EventBoundaryKind =
  | 'CROSS_UP'
  | 'CROSS_DOWN'
  | 'STATE_CUT'
  | 'GAP_START'
  | 'GAP_END'
  | 'LIMIT_CHANGE'
  | 'INSTRUMENT_SWAP'
  | 'WINDOW_END'
  | 'CENSOR_START';

export interface EventBoundary {
  at: number;
  kind: EventBoundaryKind;
  refId: string | null;
  label: string;
  /** 穿越点是否由插值推算（非实测读数） */
  interpolated: boolean;
}

export interface IntervalEvidence {
  /** 相邻实测结点均超限的时长（扣除穿越点之间的插值段） */
  measuredSeconds: number;
  /** 由两端实测读数插值推算的穿越点之间时长 */
  interpolatedSeconds: number;
  /** 证据中断且无法判定的时长（清洗、空档、缺测） */
  unknownSeconds: number;
  /** 超出限值的面积 ∫(c−limit)+ dt，单位 mg/L·s */
  excessAreaMgLs: number;
  segments: EvidenceSegment[];
  /** 是否可以在“不臆造”的前提下断言整段持续超标 */
  continuous: boolean;
  interpolationRule: string;
  unknownPolicy: string;
  notes: string[];
}

export interface IntervalGap {
  gapId: string;
  pollutant: Pollutant;
  from: number;
  to: number;
  seconds: number;
  kind: GapKind;
  /** 缺口两侧最近的实测浓度（若有） */
  beforeValue: number | null;
  afterValue: number | null;
  /** 该空档是否嵌在一个超标事件中间（两侧都超限） */
  insideEvent: boolean;
  /** 不能据相邻高值断言持续超标 */
  possibleExceedance: boolean;
  limit: number;
  effect: string;
  refIds: string[];
}

export interface StandardWindowLite {
  limit: number;
  from: number;
  to: number;
  standardId: string;
}

export interface ExceedanceEvent {
  eventId: string;
  pointCode: string;
  plantId: string;
  day: string;
  pollutant: Pollutant;
  kind: EventKind;
  startAt: number;
  /** 结束时刻；null 表示仍未闭合 */
  endAt: number | null;
  status: EventStatus;
  limit: number;
  standardId: string;
  limitBasis: string;
  /** 限值中途调整造成切分的时刻 */
  limitChangeAt: number | null;
  measuredSeconds: number;
  interpolatedSeconds: number;
  unknownSeconds: number;
  /** 事件已确证覆盖的时长（= 实测 + 插值），不含未知空档 */
  durationSeconds: number;
  /** 事件从开始到最后一个证据端点的跨度（含未知空档） */
  spanSeconds: number;
  peak: number;
  peakAt: number;
  excessAreaMgLs: number;
  /** 超出限值的污染负荷估计 kg（需要该时段流量证据） */
  excessLoadKg: LoadBounds | null;
  evidence: IntervalEvidence;
  endReason: string;
  boundaries: EventBoundary[];
  standardWindow: StandardWindow;
  sourceReadingIds: string[];
  sourceStateIds: string[];
  sourceFileIds: string[];
  dispositionIds: string[];
  strategy: DerivationStrategy;
  derivedAt: number;
  engineVersion: string;
  notes: string[];
}

export interface PollutantEventStats {
  pollutant: Pollutant;
  eventCount: number;
  measuredSeconds: number;
  interpolatedSeconds: number;
  unknownSeconds: number;
  maxPeak: number;
  excessAreaMgLs: number;
  excessLoadKg: LoadBounds | null;
  openEvents: number;
  limitSegments: StandardWindowLite[];
}

/** 事件推导的输入签名：任何来源读数、状态、校准、限值、处置变化都会改变它 */
export interface InputSignature {
  readingIdsHash: string;
  stateIdsHash: string;
  calibrationIdsHash: string;
  standardIdsHash: string;
  /** 读数数量与最大接收时刻，捕捉迟到补传/修订 */
  readingCount: number;
  latestReceivedAt: number;
  standardRevision: string;
  signature: string;
}

export interface DayEventSummary {
  day: string;
  pointCode: string;
  plantId: string;
  strategy: DerivationStrategy;
  computedAt: number;
  computeMs: number;
  engineVersion: string;
  windows: StandardWindow[];
  conflicts: StandardConflict[];
  events: ExceedanceEvent[];
  gaps: IntervalGap[];
  perPollutant: PollutantEventStats[];
  inputSignature: InputSignature;
  sourceReadingIds: string[];
  sourceFileIds: string[];
  sourceStateIds: string[];
  sourceCalibrationIds: string[];
  sourceStandardIds: string[];
  sourceDispositionIds: string[];
  notes: string[];
}

/** 物化缓存：带来源索引的事件片段与输入签名 */
export interface EventSnapshotRecord {
  cacheKey: string;
  pointCode: string;
  day: string;
  strategy: DerivationStrategy;
  inputSignature: string;
  derivedAt: number;
  engineVersion: string;
  windowFrom: number;
  windowTo: number;
  summary: DayEventSummary;
}

export interface CacheInvalidation {
  before: EventSnapshotRecord;
  after: EventSnapshotRecord | null;
  signatureChanged: boolean;
  beforeEventIds: string[];
  afterEventIds: string[];
  addedEventIds: string[];
  removedEventIds: string[];
  changedEventIds: string[];
  reasons: string[];
  /** 仍未失效的事件（来源窗口不含变化点时保留） */
  unchangedEventIds: string[];
}

/* ------------------------------------------------------------------ *
 * 申报核对：自然日申报值由事件汇总，补传/限值调整使草稿转入复核；
 * 迟到处置记录只能补证，不能宣布超标已消失。
 * ------------------------------------------------------------------ */

export type DraftStatus = 'DRAFT' | 'FILED' | 'NEEDS_RECHECK' | 'SUPERSEDED';

export const DRAFT_STATUS_LABELS: Record<DraftStatus, string> = {
  DRAFT: '草稿',
  FILED: '已出具',
  NEEDS_RECHECK: '待复核',
  SUPERSEDED: '已被替代',
};

export interface ReportLimitWindow {
  limit: number;
  from: number;
  to: number;
  standardId: string;
}

export interface DailyReportRow {
  pollutant: Pollutant;
  eventIds: string[];
  /** 只计实测与可插值的超出时长；未知空档单列 */
  reportableSeconds: number;
  measuredSeconds: number;
  interpolatedSeconds: number;
  unknownSeconds: number;
  peak: number;
  peakAt: number;
  limitWindows: ReportLimitWindow[];
  excessAreaMgLs: number;
  excessLoadKg: LoadBounds | null;
  notes: string[];
}

export interface DailyReportDraft {
  draftId: string;
  pointCode: string;
  plantId: string;
  day: string;
  createdAt: number;
  createdBy: string;
  status: DraftStatus;
  strategy: DerivationStrategy;
  snapshotSignature: string;
  cutoffReceivedAt: number;
  rows: DailyReportRow[];
  events: ExceedanceEvent[];
  gaps: IntervalGap[];
  notes: string[];
  invalidatedBy?: { reason: string; at: number; detail: string };
  reviewedBy?: string;
  reviewedAt?: number;
  reviewNote?: string;
}

export interface ReportChange {
  pollutant: Pollutant;
  eventId: string | null;
  field: string;
  before: string;
  after: string;
  kind: 'ADDED' | 'REMOVED' | 'CHANGED' | 'EVIDENCE' | 'LIMIT';
}

export interface DailyReportCheck {
  draft: DailyReportDraft;
  currentSummary: DayEventSummary | null;
  currentSignature: string | null;
  status: 'MATCH' | 'NEEDS_RECHECK' | 'STALE_CACHE_BLOCKED';
  changes: ReportChange[];
  canFile: boolean;
  message: string;
}


export interface PeakWindow {
  /** 1 小时滑动负荷峰值（kg） */
  loadKg: number;
  from: number;
  to: number;
  center: number;
}

export type EligibilityStatus = 'ELIGIBLE' | 'CONDITIONAL' | 'INELIGIBLE';

export interface QualityVerdict {
  status: EligibilityStatus;
  coverage: number;
  threshold: number;
  reasons: string[];
  /** 可以申报但需附注的事项 */
  caveats: string[];
}

export interface SegmentBoundary {
  kind:
    | 'DAY_START'
    | 'DAY_END'
    | 'CALIBRATION'
    | 'STATE'
    | 'INSTRUMENT_SWAP'
    | 'STANDARD_CHANGE'
    | 'GAP';
  at: number;
  refId: string | null;
  label: string;
}

export type SegmentCategory =
  | 'VALID'
  | 'EXCLUDED_STATE'
  | 'SAMPLING_GAP'
  | 'NO_INSTRUMENT'
  | 'NO_STATE';

export interface SegmentSummary {
  segmentId: string;
  pollutant: Pollutant;
  from: number;
  to: number;
  durationSeconds: number;
  /** 有效积分域（浓度∩流量且非排除） */
  effectiveFrom: number | null;
  effectiveTo: number | null;
  instrumentId: string | null;
  flowInstrumentId: string | null;
  calibrationId: string | null;
  flowCalibrationId: string | null;
  calibrationScale: number | null;
  calibrationOffset: number | null;
  flowCalibrationScale: number | null;
  flowCalibrationOffset: number | null;
  state: DeviceState | null;
  flowState: DeviceState | null;
  category: SegmentCategory;
  excluded: boolean;
  excludeReason: string | null;
  readingCount: number;
  meanConcentration: number | null;
  meanFlow: number | null;
  loadKg: LoadBounds | null;
  /** 片段内有效积分覆盖比例 0..1 */
  coverage: number;
  /** 片段切口是否由校准生效造成 */
  calibrationCut: boolean;
  sourceReadingIds: string[];
  sourceStateIds: string[];
  sourceCalibrationIds: string[];
  sourceFileIds: string[];
  boundaries: SegmentBoundary[];
  quality: 'COMPLETE' | 'PARTIAL' | 'EMPTY';
  readingWindow: { from: number; to: number } | null;
}

export type GapKind =
  | 'SAMPLING_GAP'
  | 'INSTRUMENT_GAP'
  | 'NO_EFFECTIVE_STATE'
  | 'CALIBRATION_EDGE'
  | 'EXCLUDED_STATE';

export interface GapSummary {
  from: number;
  to: number;
  seconds: number;
  kind: GapKind;
  metric: Metric;
  metricLabel: string;
  /** 缺口内各污染物的估计负荷 */
  impacts: { pollutant: Pollutant; impactKg: LoadBounds; note: string }[];
  reason: string;
  refIds: string[];
  /** 该空档可由迟到读数填补时的相关读数 ID */
  pendingLateReadings?: string[];
}

export interface ExclusionSummary {
  state: DeviceState;
  seconds: number;
  from: number;
  to: number;
  stateId: string;
  instrumentId: string;
  metric: Metric;
  metricLabel: string;
  reason: string;
  /** 排除时段若以邻近读数估算的影响（不并入排放） */
  impactKg: LoadBounds;
  impactNote: string;
}

export interface ResampleGridResult {
  gridSeconds: number;
  totalLoad: Record<Pollutant, LoadBounds>;
  peakWindow: Record<Pollutant, PeakWindow | null>;
  exceedanceSeconds: Record<Pollutant, number>;
  /** 与逐片段精确积分相比的最大相对偏差 */
  loadBestDriftPercent: number;
  peakShiftSeconds: number;
  exceedanceSymmetricDiffSeconds: number;
  /** 梯形法解析误差界（kg，各污染物最大值） */
  errorBoundKg: number;
  accepted: boolean;
}

export interface ResampleCheck {
  method: IntegrationMethod;
  gridSeconds: number;
  loadBestDriftPercent: number;
  peakWindowShiftSeconds: number;
  exceedanceSymmetricDiffSeconds: number;
  errorBoundKg: number;
  verified: boolean;
  notes: string[];
  gridResults: ResampleGridResult[];
  /** 朴素中点重采样（不切读数、不切边界）的失败证据 */
  naiveCheck: {
    gridSeconds: number;
    loadErrorPercent: number;
    missedExceedanceSeconds: number;
    note: string;
  };
  chosenGridSeconds: number;
}

export interface PollutantTrace {
  pollutant: Pollutant;
  /** 主限值 mg/L（限值中途调整时取首个窗口；逐段限值见 exceedances[].limit） */
  standard: number;
  /** 当日限值窗口（标准适用库按生效边界切分） */
  standardWindows?: StandardWindow[];
  load: LoadBounds;
  effectiveSeconds: number;
  excludedSeconds: number;
  gapSeconds: number;
  uncoveredSeconds: number;
  coverage: number;
  eligibility: QualityVerdict;
  flowWeightedMean: number;
  peakConcentration: number;
  peakConcentrationAt: number;
  exceedances: ExceedanceInterval[];
  exceedanceSeconds: number;
  peakWindow: PeakWindow | null;
  segments: SegmentSummary[];
  gaps: GapSummary[];
  exclusions: ExclusionSummary[];
  sourceReadingIds: string[];
  sourceFileIds: string[];
  /** 读数结点数（逐片段路线的查询负担指标） */
  knotCount: number;
  /** 网格单元数（重采样路线的汇总负担指标） */
  gridCellCount: number;
}

export interface ChartPoint {
  at: number;
  cod: number | null;
  nh3n: number | null;
  flow: number | null;
  /** kg/h = 浓度 mg/L × 流量 m³/h / 1000 */
  codRateKgH: number | null;
  nh3nRateKgH: number | null;
  codSegmentId: string | null;
  nh3nSegmentId: string | null;
  excluded: boolean;
  gap: boolean;
}

export interface DayLoadSnapshot {
  day: string;
  pointCode: string;
  plantId: string;
  method: IntegrationMethod;
  gridSeconds: number;
  windowFrom: number;
  windowTo: number;
  pollutants: PollutantTrace[];
  /** 全窗口覆盖率：各污染物最小值 */
  coverage: number;
  eligibility: QualityVerdict;
  uncertaintyNotes: string[];
  resampleCheck?: ResampleCheck;
  computeMs: number;
  engineVersion: string;
  /** 本次计算实际纳入的读数（指纹化来源） */
  sourceReadingIds: string[];
  sourceFileIds: string[];
  instrumentChain: {
    metric: Metric;
    instrumentId: string;
    from: number;
    to: number;
    bindingId: string;
    installedAt: number;
    removedAt: number | null;
  }[];
  clockNotes: string[];
  routingStats: {
    segmentCount: number;
    readingKnots: number;
    gridCells: number;
  };
  /** 展示曲线（不持久化） */
  chart?: ChartPoint[];
  chartResolutionSeconds?: number;
}

export interface MethodComparison {
  pointCode: string;
  plantId: string;
  day: string;
  segment: DayLoadSnapshot;
  resample: DayLoadSnapshot;
  agreement: {
    pollutant: Pollutant;
    segment: LoadBounds;
    resample: LoadBounds;
    overlapRatio: number;
    withinTolerance: boolean;
    peakShiftSeconds: number;
  }[];
  gapConsistency: {
    consistent: boolean;
    segmentGapSeconds: number;
    resampleGapSeconds: number;
    differingKinds: string[];
  };
  provenanceComplete: boolean;
  verified: boolean;
  notes: string[];
}

/** 申报版本：出具后锁定来源窗口，不因迟到数据而改变 */
export interface Declaration {
  declarationId: string;
  pointCode: string;
  plantId: string;
  /** YYYY-MM-DD（Asia/Shanghai） */
  day: string;
  method: IntegrationMethod;
  gridSeconds: number;
  createdAt: number;
  createdBy: string;
  status: 'FILED';
  /** 锁定来源窗口 [windowFrom, windowTo) */
  windowFrom: number;
  windowTo: number;
  /** 统计截至接收时刻：此后到达的读数视为迟到 */
  cutoffReceivedAt: number;
  sourceReadingIds: string[];
  sourceFileHashes: string[];
  result: DayLoadSnapshot;
}

export interface LoadDiff {
  byPollutant: {
    pollutant: Pollutant;
    baseline: LoadBounds;
    recomputed: LoadBounds;
    deltaKg: number;
    deltaPercent: number;
    overlapKg: LoadBounds;
  }[];
  coverageDelta: number;
  gapSecondsDelta: number;
  note: string;
}

export interface RecalcCandidate {
  candidateId: string;
  declarationId: string;
  pointCode: string;
  plantId: string;
  day: string;
  method: IntegrationMethod;
  gridSeconds: number;
  createdAt: number;
  createdBy: string;
  status: 'PENDING' | 'REVIEWED';
  /** 锁定的来源范围：只能引用申报窗口内的读数 */
  windowFrom: number;
  windowTo: number;
  cutoffReceivedAt: number;
  /** 申报后到达、但采样时刻落在已锁定窗口内的迟到读数 */
  lateReadingIds: string[];
  lateFileIds: string[];
  /** 迟到读数是否落在原缺口内 */
  fillsGapSeconds: number;
  baseline: DayLoadSnapshot;
  recomputed: DayLoadSnapshot;
  diff: LoadDiff;
  autoDetected: boolean;
  reviewNote?: string;
  reviewedBy?: string;
  reviewedAt?: number;
  /** 申报版本是否被改写（必须始终为 false） */
  declarationOverwritten: false;
}

export interface MonthLoad {
  month: string;
  pointCode: string;
  plantId: string;
  method: IntegrationMethod;
  daysInMonth: number;
  daysWithData: number;
  daysComputed: string[];
  missingDays: string[];
  pollutants: {
    pollutant: Pollutant;
    load: LoadBounds;
    coverageMean: number;
    effectiveSeconds: number;
  }[];
  coverage: number;
  eligibility: EligibilityStatus;
  notes: string[];
}

export interface ScopeOptions {
  /** 是否纳入 qualityFlag=SUSPECT（会拉宽不确定范围） */
  includeSuspect: boolean;
  /** 重采样主网格（秒） */
  gridSeconds: number;
  /** 不确定度膨胀系数（1σ → kσ） */
  uncertaintyMultiplier: number;
  /** 覆盖率合格线 */
  coverageThreshold: number;
}

export const DEFAULT_SCOPE: ScopeOptions = {
  includeSuspect: true,
  gridSeconds: 15,
  uncertaintyMultiplier: 2,
  coverageThreshold: 0.9,
};

export interface Dataset {
  plants: Plant[];
  points: OutfallPoint[];
  instruments: Instrument[];
  calibrations: Calibration[];
  states: StatePeriod[];
  bindings: Binding[];
  readings: Reading[];
  files: IntakeFile[];
  standards: StandardRule[];
  dispositions: DispositionRecord[];
}

export interface SampleManifest {
  name: string;
  description: string;
  generatedAt: string;
  timezone: string;
  baseFiles: {
    fileName: string;
    kind: FileKind;
    receivedAt: string;
    rowCount: number;
    sha256: string;
    note: string;
  }[];
  lateFile: {
    fileName: string;
    kind: FileKind;
    receivedAt: string;
    rowCount: number;
    sha256: string;
    note: string;
  };
  /** 申报后到达的处置记录（晚于申报截止，只能补证） */
  lateDispositionFile?: {
    fileName: string;
    kind: FileKind;
    receivedAt: string;
    rowCount: number;
    sha256: string;
    note: string;
  };
  focus: {
    pointCode: string;
    day: string;
    declarationCutoff: string;
    scenario: string[];
  };
}
