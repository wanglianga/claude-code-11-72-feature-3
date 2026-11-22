/**
 * WebWorker：所有重计算（日/月负荷、双路线对比、导出申报、迟到重算）在 Worker 内完成，
 * 主线程只负责 IndexedDB 读写与渲染。Worker 不直接访问 IndexedDB —
 * 数据集由主线程一次性投递，避免结构化克隆与事务并发问题。
 */

import {
  DEFAULT_SCOPE,
  DailyReportDraft,
  Dataset,
  DayEventSummary,
  DayLoadSnapshot,
  Declaration,
  DerivationStrategy,
  IntegrationMethod,
  MonthLoad,
  RecalcCandidate,
  ScopeOptions,
} from '../domain/types';
import { compareRoutes, computeDayLoad, computeMonthLoad } from '../domain/engine';
import { buildDeclaration, buildRecalcCandidate, detectLateReadings } from '../domain/service';
import { deriveDayEvents, computeSignatureLight } from '../domain/events';
import { checkReportDraft } from '../domain/dailyReport';

export interface EventDeriveResult {
  summary: DayEventSummary;
  currentSignature: string;
  strategies: { strategy: DerivationStrategy; eventCount: number; ms: number }[];
  equivalent: boolean;
  mismatches: string[];
}

export type WorkerRequest =
  | { id: string; type: 'computeDay'; dataset: Dataset; pointCode: string; day: string; method: IntegrationMethod; scope?: Partial<ScopeOptions>; withChart?: boolean }
  | { id: string; type: 'compareRoutes'; dataset: Dataset; pointCode: string; day: string; scope?: Partial<ScopeOptions> }
  | { id: string; type: 'computeMonth'; dataset: Dataset; pointCode: string; month: string; method: IntegrationMethod; scope?: Partial<ScopeOptions> }
  | { id: string; type: 'buildDeclaration'; dataset: Dataset; pointCode: string; day: string; method: IntegrationMethod; createdBy: string; scope?: Partial<ScopeOptions>; cutoffReceivedAt?: number }
  | { id: string; type: 'buildRecalc'; dataset: Dataset; declaration: Declaration; createdBy: string; scope?: Partial<ScopeOptions>; autoDetected?: boolean }
  | { id: string; type: 'deriveEvents'; dataset: Dataset; pointCode: string; day: string; strategy: DerivationStrategy; scope?: Partial<ScopeOptions> }
  | { id: string; type: 'proveStrategies'; dataset: Dataset; pointCode: string; day: string; scope?: Partial<ScopeOptions> }
  | { id: string; type: 'checkDraft'; dataset: Dataset; draft: DailyReportDraft; cacheStale: boolean }
  | { id: string; type: 'signature'; dataset: Dataset; pointCode: string; day: string };

export interface WorkerResponseOk {
  id: string;
  ok: true;
  type: WorkerRequest['type'];
  payload:
    | DayLoadSnapshot
    | ReturnType<typeof compareRoutes>
    | MonthLoad
    | Declaration
    | RecalcCandidate
    | EventDeriveResult
    | ReturnType<typeof checkReportDraft>
    | ReturnType<typeof computeSignatureLight>;
  tookMs: number;
}

export interface WorkerResponseError {
  id: string;
  ok: false;
  message: string;
}

export type WorkerResponse = WorkerResponseOk | WorkerResponseError;

function nowMs(): number {
  return Date.now();
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;
  const started = nowMs();
  try {
    switch (req.type) {
      case 'computeDay': {
        const payload = computeDayLoad(req.dataset, req.pointCode, req.day, req.method, {
          scope: req.scope,
          withChart: req.withChart ?? true,
        });
        post({ id: req.id, ok: true, type: req.type, payload, tookMs: nowMs() - started });
        break;
      }
      case 'compareRoutes': {
        const payload = compareRoutes(req.dataset, req.pointCode, req.day, {
          scope: req.scope,
          withChart: true,
        });
        post({ id: req.id, ok: true, type: req.type, payload, tookMs: nowMs() - started });
        break;
      }
      case 'computeMonth': {
        const payload = computeMonthLoad(req.dataset, req.pointCode, req.month, req.method, {
          scope: req.scope,
        });
        post({ id: req.id, ok: true, type: req.type, payload, tookMs: nowMs() - started });
        break;
      }
      case 'buildDeclaration': {
        const payload = buildDeclaration(
          req.dataset,
          {
            pointCode: req.pointCode,
            day: req.day,
            method: req.method,
            createdBy: req.createdBy,
            scope: req.scope ?? DEFAULT_SCOPE,
            cutoffReceivedAt: req.cutoffReceivedAt,
          },
          nowMs(),
        );
        post({ id: req.id, ok: true, type: req.type, payload, tookMs: nowMs() - started });
        break;
      }
      case 'buildRecalc': {
        const payload = buildRecalcCandidate(req.dataset, {
          declaration: req.declaration,
          createdBy: req.createdBy,
          now: nowMs(),
          scope: req.scope,
          autoDetected: req.autoDetected,
        });
        post({ id: req.id, ok: true, type: req.type, payload, tookMs: nowMs() - started });
        break;
      }
      case 'deriveEvents': {
        const summary = deriveDayEvents(req.dataset, req.pointCode, req.day, {
          strategy: req.strategy,
          scope: req.scope,
        });
        const payload: EventDeriveResult = {
          summary,
          currentSignature: summary.inputSignature.signature,
          strategies: [{ strategy: req.strategy, eventCount: summary.events.length, ms: summary.computeMs }],
          equivalent: true,
          mismatches: [],
        };
        post({ id: req.id, ok: true, type: req.type, payload, tookMs: nowMs() - started });
        break;
      }
      case 'proveStrategies': {
        const items = (['PERSIST_SNAPSHOT', 'DERIVE_ON_DEMAND'] as DerivationStrategy[]).map((strategy) => {
          const s = deriveDayEvents(req.dataset, req.pointCode, req.day, { strategy, scope: req.scope });
          return { strategy, summary: s, ms: s.computeMs };
        });
        const [a, b] = items;
        const payload: EventDeriveResult = {
          summary: b.summary,
          currentSignature: b.summary.inputSignature.signature,
          strategies: items.map((i) => ({ strategy: i.strategy, eventCount: i.summary.events.length, ms: i.ms })),
          equivalent:
            a.summary.events.length === b.summary.events.length &&
            a.summary.events.every((e, idx) => {
              const other = b.summary.events[idx];
              return (
                e.eventId === other.eventId &&
                e.startAt === other.startAt &&
                e.endAt === other.endAt &&
                Math.abs(e.measuredSeconds - other.measuredSeconds) < 1e-6 &&
                Math.abs(e.interpolatedSeconds - other.interpolatedSeconds) < 1e-6 &&
                Math.abs(e.unknownSeconds - other.unknownSeconds) < 1e-6 &&
                Math.abs(e.limit - other.limit) < 1e-9 &&
                e.status === other.status
              );
            }),
          mismatches: [],
        };
        post({ id: req.id, ok: true, type: req.type, payload, tookMs: nowMs() - started });
        break;
      }
      case 'checkDraft': {
        const summary = deriveDayEvents(req.dataset, req.draft.pointCode, req.draft.day, {
          strategy: 'DERIVE_ON_DEMAND',
        });
        const payload = checkReportDraft(req.draft, summary, { cacheStale: req.cacheStale, allowDerive: true });
        post({ id: req.id, ok: true, type: req.type, payload, tookMs: nowMs() - started });
        break;
      }
      case 'signature': {
        const payload = computeSignatureLight(req.dataset, req.pointCode, req.day);
        post({ id: req.id, ok: true, type: req.type, payload, tookMs: nowMs() - started });
        break;
      }
      default: {
        const exhaustive: never = req;
        throw new Error(`未知请求：${JSON.stringify(exhaustive)}`);
      }
    }
  } catch (error) {
    post({ id: req.id, ok: false, message: error instanceof Error ? error.message : String(error) });
  }
};

function post(response: WorkerResponse): void {
  (self as unknown as { postMessage: (v: WorkerResponse) => void }).postMessage(response);
}

export { detectLateReadings };
