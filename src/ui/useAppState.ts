/**
 * 应用状态：数据集、选中点位/日期、作用域、计算结果、申报与重算候选。
 * 所有重计算经 Worker；IndexedDB 为主存储，刷新后自动恢复。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  DailyReportCheck,
  DailyReportDraft,
  Dataset,
  DayEventSummary,
  DayLoadSnapshot,
  Declaration,
  DerivationStrategy,
  EventSnapshotRecord,
  IntegrationMethod,
  Pollutant,
  RecalcCandidate,
  SampleManifest,
  ScopeOptions,
} from '../domain/types';
import { DEFAULT_SCOPE } from '../domain/types';
import type { ComparisonResult } from '../domain/engine';
import {
  clearAll,
  fileDeclaration,
  getAllKv,
  getEventSnapshot,
  getMeta,
  intakeFiles,
  isSampleImported,
  listAudits,
  listDeclarations,
  listEventSnapshots,
  listRecalcCandidates,
  listReportDrafts,
  readingsByFile,
  saveEventSnapshot,
  saveRecalcCandidate,
  saveReportDraft,
  setMeta,
  addAudit,
  putBatch,
} from '../db/db';
import type { AuditEntry } from '../db/db';
import { createWorkerClient, type WorkerClient } from '../worker/client';
import { buildRecalcCandidate, detectLateReadings } from '../domain/service';
import { fetchSampleManifest, importLateBatch, loadSampleBase, type LoadProgress } from '../sample/loadSample';
import { dayKeyFromMs } from '../domain/time';
import { makeSnapshotRecord, reviseStandard, truncatePriorStandards } from '../domain/eventService';
import { buildDraft, fileDraft, invalidateDraft, reopenDraft } from '../domain/dailyReport';
import type { EventDeriveResult } from '../worker/compute.worker';

export interface Toast {
  id: string;
  kind: 'info' | 'success' | 'warn' | 'error';
  text: string;
}

export interface AppState {
  ready: boolean;
  loading: boolean;
  progress: LoadProgress | null;
  dataset: Dataset;
  manifest: SampleManifest | null;
  pointCode: string;
  day: string;
  month: string;
  method: IntegrationMethod;
  scope: ScopeOptions;
  actor: string;
  snapshot: DayLoadSnapshot | null;
  comparison: ComparisonResult | null;
  computing: boolean;
  computeError: string | null;
  declarations: Declaration[];
  candidates: RecalcCandidate[];
  audits: AuditEntry[];
  files: Awaited<ReturnType<typeof intakeFiles>>;
  lateCount: number;
  fingerprints: { fileName: string; expected: string; actual: string; ok: boolean }[];
  toasts: Toast[];
  lastComputeMs: number | null;
  /* 事件监控 */
  eventStrategy: DerivationStrategy;
  eventSummary: DayEventSummary | null;
  eventSignatures: { current: string | null; cached: string | null; cacheFresh: boolean; servedFromCache: boolean };
  eventNotes: string[];
  eventDeriving: boolean;
  eventEquivalence: { equivalent: boolean; strategies: { strategy: DerivationStrategy; eventCount: number; ms: number }[] } | null;
  eventCache: EventSnapshotRecord | null;
  eventCaches: EventSnapshotRecord[];
  eventDrafts: DailyReportDraft[];
  lastInvalidation: import('../domain/eventService').InvalidationReport | null;
}

export interface AppActions {
  reload: () => Promise<void>;
  loadSample: () => Promise<void>;
  importLate: () => Promise<void>;
  setPointCode: (code: string) => void;
  setDay: (day: string) => void;
  setMethod: (m: IntegrationMethod) => void;
  setScope: (patch: Partial<ScopeOptions>) => void;
  setActor: (name: string) => void;
  recompute: (opts?: { compare?: boolean }) => Promise<void>;
  fileCurrent: () => Promise<void>;
  reviewCandidate: (candidateId: string, note: string) => Promise<void>;
  createCandidate: (declarationId: string) => Promise<void>;
  reset: () => Promise<void>;
  toast: (kind: Toast['kind'], text: string) => void;
  dismissToast: (id: string) => void;
  lookupFileReadings: (fileId: string) => Promise<number>;
  refreshLedgers: () => Promise<void>;
  /* 事件监控 */
  setEventStrategy: (strategy: DerivationStrategy) => void;
  deriveEvents: (opts?: { refresh?: boolean; prove?: boolean }) => Promise<void>;
  persistSnapshot: () => Promise<void>;
  refreshEventCache: () => Promise<void>;
  loadEventCache: () => Promise<void>;
  addStandardRevision: (input: { pollutant: Pollutant; limit: number; at: number; basis: string; grade: string; note: string }) => Promise<void>;
  createReportDraft: () => Promise<void>;
  checkReport: (draftId: string) => Promise<DailyReportCheck | null>;
  fileReport: (draftId: string, note: string) => Promise<void>;
  reopenReport: (draftId: string, note: string) => Promise<void>;
}

function emptyDataset(): Dataset {
  return {
    plants: [],
    points: [],
    instruments: [],
    calibrations: [],
    states: [],
    bindings: [],
    readings: [],
    files: [],
    standards: [],
    dispositions: [],
  };
}

const DEFAULT_POINT_STORAGE = 'ui:pointCode';
const DEFAULT_DAY_STORAGE = 'ui:day';
const ACTOR_STORAGE = 'ui:actor';

export function useAppState(): { state: AppState; actions: AppActions } {
  const workerRef = useRef<WorkerClient | null>(null);
  const [dataset, setDataset] = useState<Dataset>(emptyDataset);
  const [manifest, setManifest] = useState<SampleManifest | null>(null);
  const [pointCode, setPointCode] = useState('CC-E01');
  const [day, setDay] = useState('2026-11-18');
  const [method, setMethod] = useState<IntegrationMethod>('SEGMENT');
  const [scope, setScopeState] = useState<ScopeOptions>({ ...DEFAULT_SCOPE });
  const [actor, setActorState] = useState('复核员');
  const [snapshot, setSnapshot] = useState<DayLoadSnapshot | null>(null);
  const [comparison, setComparison] = useState<ComparisonResult | null>(null);
  const [computing, setComputing] = useState(false);
  const [computeError, setComputeError] = useState<string | null>(null);
  const [declarations, setDeclarations] = useState<Declaration[]>([]);
  const [candidates, setCandidates] = useState<RecalcCandidate[]>([]);
  const [audits, setAudits] = useState<AuditEntry[]>([]);
  const [files, setFiles] = useState<Awaited<ReturnType<typeof intakeFiles>>>([]);
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);
  const [progress, setProgress] = useState<LoadProgress | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [fingerprints, setFingerprints] = useState<AppState['fingerprints']>([]);
  const [lastComputeMs, setLastComputeMs] = useState<number | null>(null);
  const [eventStrategy, setEventStrategyState] = useState<DerivationStrategy>('PERSIST_SNAPSHOT');
  const [eventSummary, setEventSummary] = useState<DayEventSummary | null>(null);
  const [eventSignatures, setEventSignatures] = useState<AppState['eventSignatures']>({
    current: null,
    cached: null,
    cacheFresh: false,
    servedFromCache: false,
  });
  const [eventNotes, setEventNotes] = useState<string[]>([]);
  const [eventDeriving, setEventDeriving] = useState(false);
  const [eventEquivalence, setEventEquivalence] = useState<AppState['eventEquivalence']>(null);
  const [eventCache, setEventCache] = useState<EventSnapshotRecord | null>(null);
  const [eventCaches, setEventCaches] = useState<EventSnapshotRecord[]>([]);
  const [eventDrafts, setEventDrafts] = useState<DailyReportDraft[]>([]);
  const [lastInvalidation, setLastInvalidation] = useState<AppState['lastInvalidation']>(null);
  const eventCacheRef = useRef<EventSnapshotRecord | null>(null);

  const toast = useCallback((kind: Toast['kind'], text: string) => {
    const id = `t-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setToasts((prev) => [...prev, { id, kind, text }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), kind === 'error' ? 9000 : 5200);
  }, []);
  const dismissToast = useCallback((id: string) => setToasts((prev) => prev.filter((t) => t.id !== id)), []);

  const setEventCacheSafe = useCallback((record: EventSnapshotRecord | null) => {
    eventCacheRef.current = record;
    setEventCache(record);
  }, []);

  const refreshLedgers = useCallback(async () => {
    const [decls, recs, auditList, intake, mf, caches, drafts] = await Promise.all([
      listDeclarations(),
      listRecalcCandidates(),
      listAudits(),
      intakeFiles(),
      fetchSampleManifest().catch(() => null),
      listEventSnapshots(),
      listReportDrafts(),
    ]);
    setDeclarations(decls);
    setCandidates(recs);
    setAudits(auditList);
    setFiles(intake);
    setEventCaches(caches);
    setEventDrafts(drafts);
    if (mf) setManifest(mf);
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getAllKv();
      const ds: Dataset = {
        plants: data.plants,
        points: data.points,
        instruments: data.instruments,
        calibrations: data.calibrations,
        states: data.states,
        bindings: data.bindings,
        readings: data.readings,
        files: data.files,
        standards: data.standards,
        dispositions: data.dispositions,
      };
      setDataset(ds);
      const storedPoint = await getMeta<string>(DEFAULT_POINT_STORAGE);
      const storedDay = await getMeta<string>(DEFAULT_DAY_STORAGE);
      const storedActor = await getMeta<string>(ACTOR_STORAGE);
      if (storedActor) setActorState(storedActor);
      if (mfHasPoints(ds)) {
        const point = storedPoint && ds.points.some((p) => p.pointCode === storedPoint) ? storedPoint : ds.points[0].pointCode;
        setPointCode(point);
        const days = pickDays(ds, point);
        const chosenDay = storedDay && days.includes(storedDay) ? storedDay : days[0] ?? day;
        setDay(chosenDay);
      }
      await refreshLedgers();
      const imported = await isSampleImported();
      setReady(true);
      if (imported) toast('info', `已从本地库恢复 ${ds.readings.length.toLocaleString('zh-CN')} 条读数`);
    } catch (error) {
      toast('error', `恢复本地库失败：${(error as Error).message}`);
      setReady(true);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshLedgers, toast]);

  const loadSample = useCallback(async () => {
    setLoading(true);
    setProgress({ step: '准备装载', done: 0, total: 1 });
    try {
      const loaded = await loadSampleBase((p) => setProgress(p), actor);
      setDataset(loaded.dataset);
      setManifest(loaded.manifest);
      setFingerprints(loaded.fingerprintMatches);
      const focusPoint = loaded.manifest.focus.pointCode;
      setPointCode(focusPoint);
      setDay(loaded.manifest.focus.day);
      await setMeta(DEFAULT_POINT_STORAGE, focusPoint);
      await setMeta(DEFAULT_DAY_STORAGE, loaded.manifest.focus.day);
      await refreshLedgers();
      await addAudit({
        at: Date.now(),
        actor,
        action: 'LOAD_SAMPLE',
        detail: `装载样例：${loaded.dataset.files.length} 份文件，${loaded.dataset.readings.length} 条读数；指纹校验 ${loaded.fingerprintMatches.filter((f) => f.ok).length}/${loaded.fingerprintMatches.length} 通过`,
        refIds: loaded.dataset.files.map((f) => f.fileId),
      });
      if (loaded.warnings.length > 0) toast('warn', loaded.warnings.join('；'));
      else toast('success', `样例装载完成：${loaded.fingerprintMatches.length} 份文件指纹全部匹配`);
      setReady(true);
    } catch (error) {
      toast('error', `装载样例失败：${(error as Error).message}`);
    } finally {
      setLoading(false);
      setProgress(null);
    }
  }, [actor, refreshLedgers, toast]);

  const importLate = useCallback(async () => {
    if (!manifest) {
      toast('warn', '尚未装载样例清单');
      return;
    }
    setLoading(true);
    try {
      const result = await importLateBatch(dataset, manifest, actor);
      setDataset(result.dataset);
      if (!result.fingerprint.ok) toast('warn', '迟到补录文件指纹与清单不一致');
      else
        toast(
          'success',
          `迟到补录已入库：${result.readingsAdded} 条读数、${result.dispositionsAdded} 条处置记录（接收时刻晚于申报截止）`,
        );
      const cached = await getEventSnapshot(pointCode, day);
      if (cached) {
        toast('warn', '读数到达：现有物化快照的输入签名已改变，旧事件视为过旧，请到“派生影响”刷新或改用查询时推导');
      }
      // 补传改变证据边界：该点位所有未出具有草稿立即转入复核（绝不以旧草稿替代当前证据）
      let invalidated = 0;
      for (const draft of eventDrafts.filter((d) => d.pointCode === pointCode && d.status !== 'SUPERSEDED')) {
        await saveReportDraft(
          invalidateDraft(
            draft,
            '迟到读数补传',
            `导入迟到批次 ${result.filesAdded.length} 个文件、${result.readingsAdded} 条读数；事件边界可能改变，草稿转入复核`,
            Date.now(),
          ),
        );
        invalidated += 1;
      }
      if (invalidated > 0) toast('warn', `${invalidated} 份申报草稿因补传转入复核`);
      await addAudit({
        at: Date.now(),
        actor,
        action: 'IMPORT_LATE_BATCH',
        detail: `导入迟到补录 ${result.filesAdded.join('，')}：${result.readingsAdded} 条读数、${result.dispositionsAdded} 条迟到处置；物化快照 ${cached ? '已失效' : '不存在'}`,
        refIds: result.filesAdded,
      });
      await refreshLedgers();
    } catch (error) {
      toast('error', `导入迟到补录失败：${(error as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [actor, dataset, eventDrafts, manifest, pointCode, refreshLedgers, toast]);

  const setPointCodePersist = useCallback((code: string) => {
    setPointCode(code);
    void setMeta(DEFAULT_POINT_STORAGE, code);
    setSnapshot(null);
    setComparison(null);
  }, []);
  const setDayPersist = useCallback((next: string) => {
    setDay(next);
    void setMeta(DEFAULT_DAY_STORAGE, next);
    setSnapshot(null);
    setComparison(null);
  }, []);
  const setActorPersist = useCallback((name: string) => {
    setActorState(name);
    void setMeta(ACTOR_STORAGE, name);
  }, []);
  const setScope = useCallback((patch: Partial<ScopeOptions>) => {
    setScopeState((prev) => ({ ...prev, ...patch }));
  }, []);

  const recompute = useCallback(
    async (opts: { compare?: boolean } = {}) => {
      if (!dataset.points.length) {
        toast('warn', '本地库为空，请先装载样例资料或导入文件');
        return;
      }
      setComputing(true);
      setComputeError(null);
      try {
        if (!workerRef.current) workerRef.current = createWorkerClient();
        const client = workerRef.current;
        if (opts.compare) {
          const comp = await client.request<ComparisonResult>({
            type: 'compareRoutes',
            dataset,
            pointCode,
            day,
            scope,
          });
          setComparison(comp);
          setSnapshot(comp.segment);
          setLastComputeMs(comp.segment.computeMs);
        } else {
          const snap = await client.request<DayLoadSnapshot>({
            type: 'computeDay',
            dataset,
            pointCode,
            day,
            method,
            scope,
            withChart: true,
          });
          setSnapshot(snap);
          setComparison(null);
          setLastComputeMs(snap.computeMs);
        }
      } catch (error) {
        const message = (error as Error).message;
        setComputeError(message);
        toast('error', `计算失败：${message}`);
      } finally {
        setComputing(false);
      }
    },
    [dataset, day, method, pointCode, scope, toast],
  );

  const fileCurrent = useCallback(async () => {
    if (!dataset.points.length) return;
    if (!workerRef.current) workerRef.current = createWorkerClient();
    try {
      const declaration = await workerRef.current.request<Declaration>({
        type: 'buildDeclaration',
        dataset,
        pointCode,
        day,
        method,
        createdBy: actor,
        scope,
      });
      const { existing } = await fileDeclaration(declaration);
      if (existing) {
        toast('warn', `该点位当日已有申报版本 ${existing.declarationId}，未覆盖；如需修订请生成重算候选`);
      } else {
        toast('success', `已出具申报版本 ${declaration.declarationId}，来源窗口已锁定`);
        await addAudit({
          at: Date.now(),
          actor,
          action: 'FILE_DECLARATION',
          detail: `出具 ${pointCode} ${day} 申报版本，方法 ${method}，来源 ${declaration.sourceReadingIds.length} 条`,
          refIds: [declaration.declarationId],
        });
      }
      await refreshLedgers();
    } catch (error) {
      toast('error', `出具申报失败：${(error as Error).message}`);
    }
  }, [actor, dataset, day, method, pointCode, refreshLedgers, scope, toast]);

  const createCandidate = useCallback(
    async (declarationId: string) => {
      const declaration = declarations.find((d) => d.declarationId === declarationId);
      if (!declaration) {
        toast('warn', '未找到该申报版本');
        return;
      }
      const late = detectLateReadings(dataset, declaration);
      if (late.lateReadings.length === 0) {
        toast('info', '未发现申报截止后到达的迟到读数；仍可生成对照候选（差异应为 0）');
      }
      try {
        const candidate = buildRecalcCandidate(dataset, {
          declaration,
          createdBy: actor,
          now: Date.now(),
          scope,
          autoDetected: late.lateReadings.length > 0,
        });
        await saveRecalcCandidate(candidate);
        toast(
          late.lateReadings.length > 0 ? 'success' : 'info',
          late.lateReadings.length > 0
            ? `已生成重算候选：纳入 ${late.lateReadings.length} 条迟到读数，申报版本保持不变`
            : '已生成重算候选（无迟到读数）',
        );
        await refreshLedgers();
      } catch (error) {
        toast('error', `生成重算候选失败：${(error as Error).message}`);
      }
    },
    [actor, dataset, declarations, refreshLedgers, scope, toast],
  );

  const reviewCandidate = useCallback(
    async (candidateId: string, note: string) => {
      const target = candidates.find((c) => c.candidateId === candidateId);
      if (!target) return;
      const updated: RecalcCandidate = {
        ...target,
        status: 'REVIEWED',
        reviewedBy: actor,
        reviewedAt: Date.now(),
        reviewNote: note,
      };
      await saveRecalcCandidate(updated);
      await addAudit({
        at: Date.now(),
        actor,
        action: 'REVIEW_RECALC',
        detail: `复核重算候选 ${candidateId}：${note || '无附注'}；申报版本 ${target.declarationId} 保持 FILED`,
        refIds: [candidateId, target.declarationId],
      });
      toast('success', '候选已标记复核完成，申报版本未被改写');
      await refreshLedgers();
    },
    [actor, candidates, refreshLedgers, toast],
  );

  /* ---------------- 事件监控：派生、缓存、限值调整、申报草稿 ---------------- */

  const setEventStrategy = useCallback((strategy: DerivationStrategy) => {
    setEventStrategyState(strategy);
    setEventSummary(null);
    setEventEquivalence(null);
  }, []);

  const deriveEvents = useCallback(
    async (opts: { refresh?: boolean; prove?: boolean } = {}) => {
      if (!dataset.points.length) {
        toast('warn', '本地库为空，请先装载样例资料');
        return;
      }
      setEventDeriving(true);
      try {
        if (!workerRef.current) workerRef.current = createWorkerClient();
        const client = workerRef.current;
        const cached = await getEventSnapshot(pointCode, day);
        setEventCacheSafe(cached ?? null);
        if (opts.prove) {
          const result = await client.request<EventDeriveResult>({
            type: 'proveStrategies',
            dataset,
            pointCode,
            day,
            scope,
          });
          setEventSummary(result.summary);
          setEventSignatures({
            current: result.currentSignature,
            cached: cached?.inputSignature ?? null,
            cacheFresh: Boolean(cached && cached.inputSignature === result.currentSignature),
            servedFromCache: false,
          });
          setEventEquivalence({ equivalent: result.equivalent, strategies: result.strategies });
          setEventNotes([
            result.equivalent
              ? '两种派生方案在本次冻结输入上给出同一事件集合（事件 ID、起止、实测/插值/未知时长、限值、状态全部一致）。'
              : '两种派生方案结果不一致，禁止用于申报，需排查规则实现。',
          ]);
          return;
        }
        if (eventStrategy === 'PERSIST_SNAPSHOT' && !opts.refresh && cached) {
          // 判断快照是否仍与当前输入一致：只算签名，不先现算事件
          const sig = await client.request<{ signature: string }>({
            type: 'signature',
            dataset,
            pointCode,
            day,
          });
          const fresh = cached.inputSignature === sig.signature;
          if (!fresh) {
            setEventSummary(null);
            setEventSignatures({
              current: sig.signature,
              cached: cached.inputSignature,
              cacheFresh: false,
              servedFromCache: false,
            });
            setEventNotes([
              `物化快照（${new Date(cached.derivedAt).toLocaleString('zh-CN')} 派生）的输入签名与当前数据不一致。`,
              '快照已过旧：补传读数或限值调整改变了来源窗口，旧事件不能替代当前证据。',
              '请点“刷新物化快照”，或切换到“查询时推导”以当前证据现算。',
            ]);
            setEventEquivalence(null);
            return;
          }
          setEventSummary(cached.summary);
          setEventSignatures({
            current: sig.signature,
            cached: cached.inputSignature,
            cacheFresh: true,
            servedFromCache: true,
          });
          setEventNotes([`使用物化快照（${new Date(cached.derivedAt).toLocaleString('zh-CN')} 派生），输入签名与当前数据一致。`]);
          setEventEquivalence(null);
          return;
        }
        const result = await client.request<EventDeriveResult>({
          type: 'deriveEvents',
          dataset,
          pointCode,
          day,
          strategy: eventStrategy,
          scope,
        });
        setEventSummary(result.summary);
        setEventSignatures({
          current: result.currentSignature,
          cached: cached?.inputSignature ?? null,
          cacheFresh: Boolean(cached && cached.inputSignature === result.currentSignature),
          servedFromCache: false,
        });
        setEventEquivalence(null);
        setEventNotes(
          eventStrategy === 'PERSIST_SNAPSHOT'
            ? ['已按当前证据重新物化事件片段。']
            : ['查询时推导：未使用任何旧事件缓存，全部以当前证据现算。'],
        );
      } catch (error) {
        toast('error', `事件推导失败：${(error as Error).message}`);
      } finally {
        setEventDeriving(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dataset, day, pointCode, scope, toast, eventStrategy, eventCaches],
  );

  const persistSnapshotRef = useRef<null | (() => Promise<void>)>(null);

  const afterDeriveTick = useCallback(async () => {
    if (!ready || !dataset.points.length) return;
    if (!workerRef.current) workerRef.current = createWorkerClient();
    const cached = eventCacheRef.current ?? (await getEventSnapshot(pointCode, day));
    if (eventStrategy === 'DERIVE_ON_DEMAND') {
      await deriveEvents({ refresh: true });
      return;
    }
    if (!cached) {
      // 读数到达即物化：首次没有快照时直接派生并写入缓存
      await persistSnapshotRef.current?.();
      return;
    }
    const sig = await workerRef.current.request<{ signature: string }>({ type: 'signature', dataset, pointCode, day });
    if (cached.inputSignature === sig.signature) {
      setEventSummary(cached.summary);
      setEventCacheSafe(cached);
      setEventSignatures({ current: sig.signature, cached: cached.inputSignature, cacheFresh: true, servedFromCache: true });
      setEventNotes([`使用物化快照（${new Date(cached.derivedAt).toLocaleString('zh-CN')} 派生），输入签名与当前数据一致。`]);
      return;
    }
    setEventSummary(null);
    setEventSignatures({ current: sig.signature, cached: cached.inputSignature, cacheFresh: false, servedFromCache: false });
    setEventNotes([
      `物化快照（${new Date(cached.derivedAt).toLocaleString('zh-CN')} 派生）的输入签名与当前数据不一致。`,
      '快照已过旧：补传读数或限值调整改变了来源窗口，旧事件不能替代当前证据。',
      '请点“刷新物化快照”，或切换到“查询时推导”以当前证据现算。',
    ]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, dataset, day, eventStrategy, pointCode, deriveEvents]);

  const persistSnapshot = useCallback(async () => {
    if (!workerRef.current) workerRef.current = createWorkerClient();
    const result = await workerRef.current.request<EventDeriveResult>({
      type: 'deriveEvents',
      dataset,
      pointCode,
      day,
      strategy: 'PERSIST_SNAPSHOT',
      scope,
    });
    const record = makeSnapshotRecord(result.summary);
    await saveEventSnapshot(record);
    // 已有草稿若签名变了，自动转入复核
    let invalidated = 0;
    for (const draft of eventDrafts.filter((d) => d.pointCode === pointCode && d.day === day && d.status !== 'SUPERSEDED')) {
      if (draft.snapshotSignature !== record.inputSignature) {
        await saveReportDraft(
          invalidateDraft(
            draft,
            '补传或限值调整',
            `事件输入签名由 ${draft.snapshotSignature.slice(0, 8)} 变为 ${record.inputSignature.slice(0, 8)}，草稿转入复核`,
            Date.now(),
          ),
        );
        invalidated += 1;
      }
    }
    setEventSummary(record.summary);
    setEventCacheSafe(record);
    setEventSignatures({ current: record.inputSignature, cached: record.inputSignature, cacheFresh: true, servedFromCache: false });
    setEventNotes(['已物化事件片段（带来源索引）。补传或限值调整会使对应来源窗口的派生片段成批失效，需刷新。']);
    if (invalidated > 0) toast('warn', `${invalidated} 份申报草稿因签名变化转入复核`);
    else toast('success', '事件快照已物化');
    await refreshLedgers();
  }, [dataset, day, eventDrafts, pointCode, refreshLedgers, scope, toast]);

  persistSnapshotRef.current = persistSnapshot;

  const refreshEventCache = useCallback(async () => {
    const before = await getEventSnapshot(pointCode, day);
    await persistSnapshot();
    const after = await getEventSnapshot(pointCode, day);
    if (before && after) {
      const { diffCaches } = await import('../domain/eventService');
      const report = diffCaches(before, after);
      setLastInvalidation(report);
      if (report.added.length + report.removed.length + report.changed.length > 0) {
        toast('warn', `快照刷新：新增 ${report.added.length}、删除 ${report.removed.length}、变更 ${report.changed.length} 个事件；请复核申报草稿`);
      }
    }
  }, [persistSnapshot, pointCode, day, toast]);

  const loadEventCache = useCallback(async () => {
    const cached = await getEventSnapshot(pointCode, day);
    setEventCacheSafe(cached ?? null);
    if (cached) {
      setEventSummary(cached.summary);
      setEventSignatures({ current: cached.inputSignature, cached: cached.inputSignature, cacheFresh: true, servedFromCache: true });
      setEventNotes([`已读取物化快照（${new Date(cached.derivedAt).toLocaleString('zh-CN')}），请用“派生影响”核对是否仍与当前证据一致。`]);
    } else {
      toast('info', '本地库中没有该点位当日的事件快照');
    }
    await refreshLedgers();
  }, [pointCode, day, refreshLedgers, toast]);

  const addStandardRevision = useCallback(
    async (input: { pollutant: Pollutant; limit: number; at: number; basis: string; grade: string; note: string }) => {
      const newRule = reviseStandard({
        pointCode,
        pollutant: input.pollutant,
        limit: input.limit,
        effectiveFrom: input.at,
        basis: input.basis,
        grade: input.grade,
        by: actor,
        note: input.note,
      });
      const truncated = truncatePriorStandards(dataset, { pointCode, pollutant: input.pollutant, effectiveFrom: input.at }, actor);
      await putBatch({ standards: [newRule, ...truncated] });
      setDataset({
        ...dataset,
        standards: [
          ...dataset.standards.filter((s) => !truncated.some((t) => t.standardId === s.standardId)),
          ...truncated,
          newRule,
        ],
      });
      await addAudit({
        at: Date.now(),
        actor,
        action: 'STANDARD_REVISION',
        detail: `${pointCode} ${input.pollutant} 限值自 ${new Date(input.at).toLocaleString('zh-CN')} 调整为 ${input.limit} mg/L；${truncated.length} 条旧规则被截止。`,
        refIds: [newRule.standardId, ...truncated.map((t) => t.standardId)],
      });
      // 草稿一律转入复核：限值调整会改变事件与申报值
      for (const draft of eventDrafts.filter((d) => d.pointCode === pointCode && d.day === day && d.status !== 'SUPERSEDED')) {
        await saveReportDraft(
          invalidateDraft(draft, '限值调整', `${input.pollutant} 限值调整为 ${input.limit} mg/L（${new Date(input.at).toLocaleString('zh-CN')}）`, Date.now()),
        );
      }
      setEventSummary(null);
      toast('success', '标准限值已调整；事件与草稿将按新窗口重新判定');
      await refreshLedgers();
    },
    [actor, dataset, day, eventDrafts, pointCode, refreshLedgers, toast],
  );

  const createReportDraft = useCallback(async () => {
    if (!eventSummary) {
      toast('warn', '请先推导当日事件');
      return;
    }
    const serial = eventDrafts.filter((d) => d.pointCode === pointCode && d.day === day).length + 1;
    // 申报截止：基础批次最后一份文件的接收时刻（样例 2026-11-19 07:20）。
    // 导入迟到批次后，平台接收时刻不会因文件重读而改变，因此从文件接收时刻取
    // 早于迟到批次的样本值：若存在多批文件，取排除迟到补录文件后的最大接收时刻。
    const lateFileIds = new Set(
      dataset.files.filter((f) => f.kind === 'LATE_BATCH').map((f) => f.fileId),
    );
    const baseCutoff = dataset.files
      .filter((f) => !lateFileIds.has(f.fileId) && f.receivedAt > 0)
      .reduce((a, f) => Math.max(a, f.receivedAt), 0);
    const cutoff = baseCutoff > 0 ? baseCutoff : 0;
    const draft = buildDraft(eventSummary, {
      createdBy: actor,
      now: Date.now(),
      cutoffReceivedAt: cutoff,
      strategy: eventStrategy,
      serial,
    });
    await saveReportDraft(draft);
    await addAudit({
      at: Date.now(),
      actor,
      action: 'REPORT_DRAFT_CREATE',
      detail: `${pointCode} ${day} 生成申报草稿 ${draft.draftId}（${draft.rows.map((r) => `${r.pollutant} ${r.reportableSeconds.toFixed(0)}s`).join('，')}）`,
      refIds: [draft.draftId],
    });
    toast('success', `申报草稿已生成：${draft.rows.map((r) => `${r.pollutant} 上报 ${r.reportableSeconds.toFixed(0)} s`).join('，')}`);
    await refreshLedgers();
  }, [actor, dataset.readings, day, eventDrafts, eventStrategy, eventSummary, pointCode, refreshLedgers, toast]);

  const checkReport = useCallback(
    async (draftId: string): Promise<DailyReportCheck | null> => {
      const draft = eventDrafts.find((d) => d.draftId === draftId);
      if (!draft) return null;
      if (!workerRef.current) workerRef.current = createWorkerClient();
      const cached = await getEventSnapshot(draft.pointCode, draft.day);
      const stale = !cached;
      const result = await workerRef.current.request<DailyReportCheck>({
        type: 'checkDraft',
        dataset,
        draft,
        cacheStale: stale,
      });
      const needs = result.status !== 'MATCH';
      if (needs && draft.status !== 'NEEDS_RECHECK' && draft.status !== 'FILED') {
        await saveReportDraft(
          invalidateDraft(draft, '与当前事件不一致', result.message, Date.now()),
        );
        await refreshLedgers();
      }
      return result;
    },
    [dataset, eventDrafts, refreshLedgers],
  );

  const reopenReport = useCallback(
    async (draftId: string, note: string) => {
      const draft = eventDrafts.find((d) => d.draftId === draftId);
      if (!draft) return;
      await saveReportDraft(reopenDraft(draft, { by: actor, now: Date.now(), note }));
      await addAudit({
        at: Date.now(),
        actor,
        action: 'REPORT_DRAFT_REOPEN',
        detail: `${draft.pointCode} ${draft.day} 复核人确认草稿 ${draftId} 可重新核对：${note || '无附注'}`,
        refIds: [draftId],
      });
      toast('success', '草稿已恢复为可核对状态，请再次与当前证据核对');
      await refreshLedgers();
    },
    [actor, eventDrafts, refreshLedgers, toast],
  );

  const fileReport = useCallback(
    async (draftId: string, note: string) => {
      const draft = eventDrafts.find((d) => d.draftId === draftId);
      if (!draft) return;
      const check = await checkReport(draftId);
      if (!check || !check.canFile) {
        toast('warn', '草稿与当前事件不一致或仍在复核中；请处理变化后重新生成草稿');
        return;
      }
      await saveReportDraft({
        ...fileDraft(draft, { by: actor, now: Date.now(), note }),
        status: 'FILED',
        invalidatedBy: undefined,
      });
      await addAudit({
        at: Date.now(),
        actor,
        action: 'REPORT_DRAFT_FILE',
        detail: `${draft.pointCode} ${draft.day} 出具申报草稿 ${draftId}：${note || '无附注'}`,
        refIds: [draftId],
      });
      toast('success', '申报草稿已核对并出具');
      await refreshLedgers();
    },
    [actor, checkReport, eventDrafts, refreshLedgers, toast],
  );

  const reset = useCallback(async () => {
    await clearAll();
    setDataset(emptyDataset());
    setDeclarations([]);
    setCandidates([]);
    setAudits([]);
    setFiles([]);
    setSnapshot(null);
    setComparison(null);
    toast('info', '本地库已清空（需重新装载样例）');
  }, [toast]);

  const lookupFileReadings = useCallback(async (fileId: string) => {
    const list = await readingsByFile(fileId);
    return list.length;
  }, []);

  useEffect(() => {
    void reload();
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 自动计算：点位/日期/方法/作用域变化后重算
  useEffect(() => {
    if (!ready || dataset.points.length === 0) return;
    const timer = setTimeout(() => {
      void recompute({ compare: false });
    }, 120);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, dataset.readings.length, pointCode, day, method, scope, dataset.instruments.length]);

  // 事件推导：跟随数据集/点位/日期/策略自动刷新（不阻塞负荷计算）。
  // 查询时推导每次随证据现算；物化快照只在“尚无快照”时派生一次，
  // 快照过旧时只提示、不自动覆盖（是否刷新由“派生影响”页显式决定）。
  useEffect(() => {
    if (!ready || dataset.points.length === 0) return;
    const timer = setTimeout(() => {
      void afterDeriveTick();
    }, 200);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, dataset.readings.length, dataset.standards.length, dataset.dispositions.length, pointCode, day, eventStrategy, scope]);

  const days = useMemo(() => pickDays(dataset, pointCode), [dataset, pointCode]);
  const month = day.slice(0, 7);

  const lateCount = useMemo(() => {
    let count = 0;
    for (const decl of declarations) {
      count += detectLateReadings(dataset, decl).lateReadings.length;
    }
    return count;
  }, [dataset, declarations]);

  const state: AppState = {
    ready,
    loading,
    progress,
    dataset,
    manifest,
    pointCode,
    day,
    month,
    method,
    scope,
    actor,
    snapshot,
    comparison,
    computing,
    computeError,
    declarations,
    candidates,
    audits,
    files,
    lateCount,
    fingerprints,
    toasts,
    lastComputeMs,
    eventStrategy,
    eventSummary,
    eventSignatures,
    eventNotes,
    eventDeriving,
    eventEquivalence,
    eventCache,
    eventCaches,
    eventDrafts,
    lastInvalidation,
  };
  const actions: AppActions = {
    reload,
    loadSample,
    importLate,
    setPointCode: setPointCodePersist,
    setDay: setDayPersist,
    setMethod,
    setScope,
    setActor: setActorPersist,
    recompute,
    fileCurrent,
    reviewCandidate,
    createCandidate,
    reset,
    toast,
    dismissToast,
    lookupFileReadings,
    refreshLedgers,
    setEventStrategy,
    deriveEvents,
    persistSnapshot,
    refreshEventCache,
    loadEventCache,
    addStandardRevision,
    createReportDraft,
    checkReport,
    fileReport,
    reopenReport,
  };
  void days;
  void month;
  return { state, actions };
}

function mfHasPoints(ds: Dataset): boolean {
  return ds.points.length > 0;
}

export function pickDays(dataset: Dataset, pointCode: string): string[] {
  const set = new Set<string>();
  for (const r of dataset.readings) {
    if (r.pointCode === pointCode) set.add(r.dayKey || dayKeyFromMs(r.alignedAt));
  }
  return [...set].sort();
}
