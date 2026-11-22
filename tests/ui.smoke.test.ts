/**
 * 界面冒烟：在没有浏览器的环境下用 react-dom/server 渲染新增页面，
 * 捕获运行期异常（空引用、未定义字段、错误分支）。交互行为由构件测试与 verify 脚本覆盖。
 */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SampleManifest } from '../src/domain/types';
import { parseSampleFromDisk } from '../scripts/sampleIo';
import { deriveDayEvents } from '../src/domain/events';
import { buildDraft } from '../src/domain/dailyReport';
import type { AppActions, AppState } from '../src/ui/useAppState';
import { EventsPage } from '../src/ui/pages/EventsPage';
import { StandardsPage } from '../src/ui/pages/StandardsPage';
import { DerivationPage } from '../src/ui/pages/DerivationPage';
import { DispositionsPage } from '../src/ui/pages/DispositionsPage';
import { ReportPage } from '../src/ui/pages/ReportPage';

const sampleDir = resolve(__dirname, '../public/sample');
const manifest = JSON.parse(readFileSync(resolve(sampleDir, 'manifest.json'), 'utf8')) as SampleManifest;
const { baseDataset } = parseSampleFromDisk(sampleDir, manifest);
const summary = deriveDayEvents(baseDataset, manifest.focus.pointCode, manifest.focus.day);

const actions = new Proxy({} as AppActions, {
  get: () => async () => undefined,
});

function makeState(overrides: Partial<AppState> = {}): AppState {
  const draft = buildDraft(summary, {
    createdBy: '测试',
    now: Date.now(),
    cutoffReceivedAt: 0,
    strategy: summary.strategy,
    serial: 1,
  });
  return {
    ready: true,
    loading: false,
    progress: null,
    dataset: baseDataset,
    manifest,
    pointCode: manifest.focus.pointCode,
    day: manifest.focus.day,
    month: manifest.focus.day.slice(0, 7),
    method: 'SEGMENT',
    scope: { includeSuspect: true, gridSeconds: 15, uncertaintyMultiplier: 2, coverageThreshold: 0.9 },
    actor: '测试',
    snapshot: null,
    comparison: null,
    computing: false,
    computeError: null,
    declarations: [],
    candidates: [],
    audits: [],
    files: [],
    lateCount: 0,
    fingerprints: [],
    toasts: [],
    lastComputeMs: null,
    eventStrategy: 'PERSIST_SNAPSHOT',
    eventSummary: summary,
    eventSignatures: { current: summary.inputSignature.signature, cached: null, cacheFresh: false, servedFromCache: false },
    eventNotes: [],
    eventDeriving: false,
    eventEquivalence: null,
    eventCache: null,
    eventCaches: [],
    eventDrafts: [draft],
    lastInvalidation: null,
    ...overrides,
  };
}

describe('新增页面冒烟渲染', () => {
  it('事件时间线', () => {
    const html = renderToStaticMarkup(createElement(EventsPage, { state: makeState(), actions }));
    expect(html).toContain('事件时间线');
    expect(html).toContain('事件清单');
    expect(html).toContain('间隔证据');
  });

  it('标准适用库', () => {
    const html = renderToStaticMarkup(createElement(StandardsPage, { state: makeState(), actions }));
    expect(html).toContain('标准适用库');
    expect(html).toContain('STD-CC-E01-COD-2026');
  });

  it('派生影响', () => {
    const html = renderToStaticMarkup(createElement(DerivationPage, { state: makeState(), actions }));
    expect(html).toContain('两种派生方案');
    expect(html).toContain('查询时推导');
  });

  it('处置关联簿', () => {
    const html = renderToStaticMarkup(createElement(DispositionsPage, { state: makeState(), actions }));
    expect(html).toContain('处置记录');
    expect(html).toContain('同现不等于因果');
  });

  it('申报核对', () => {
    const html = renderToStaticMarkup(createElement(ReportPage, { state: makeState(), actions }));
    expect(html).toContain('申报草稿');
    expect(html).toContain('上报超标');
  });

  it('空事件（缓存过旧）也不抛错', () => {
    const state = makeState({ eventSummary: null, eventSignatures: { current: 'a', cached: 'b', cacheFresh: false, servedFromCache: false } });
    for (const page of [EventsPage, DerivationPage, DispositionsPage, ReportPage]) {
      const html = renderToStaticMarkup(createElement(page, { state, actions }));
      expect(html.length).toBeGreaterThan(0);
    }
  });
});
