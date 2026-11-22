import { useMemo, useState } from 'react';
import type { AppActions, AppState } from '../useAppState';
import type { DerivationStrategy, ExceedanceEvent } from '../../domain/types';
import { STRATEGY_LABELS } from '../../domain/types';
import { fmtDateTime, fmtNum, shortTime, trimId } from '../format';

interface Props {
  state: AppState;
  actions: AppActions;
}

/**
 * 派生影响：什么时候可以用缓存、什么时候必须重算。
 * - 补传（迟到读数）与限值调整都会改变输入签名，使来源窗口内的派生片段成批失效；
 * - 查询时推导只持久化原始有效片段与法规条件，修订影响小，但计算压力移到调查与月末。
 */
export function DerivationPage({ state, actions }: Props) {
  const { eventSummary, eventSignatures, eventCaches, eventStrategy, dataset, lastInvalidation, eventEquivalence } = state;
  const [busy, setBusy] = useState(false);

  const mine = useMemo(
    () => eventCaches.filter((c) => c.pointCode === state.pointCode && c.day === state.day),
    [eventCaches, state.pointCode, state.day],
  );
  const latest = mine[0] ?? null;
  const cachedEvents = latest?.summary.events ?? [];
  const current = eventSummary?.events ?? [];
  const currentById = new Map(current.map((e) => [e.eventId, e]));

  const affected = useMemo(() => {
    if (!latest) return [];
    return cachedEvents.filter((e) => {
      const now = currentById.get(e.eventId);
      return !now || now.startAt !== e.startAt || now.endAt !== e.endAt || Math.abs(now.limit - e.limit) > 1e-9;
    });
  }, [cachedEvents, currentById]);

  const lateFileIds = dataset.files.filter((f) => f.kind === 'LATE_BATCH').map((f) => f.fileId);
  const lateReadings = dataset.readings.filter((r) => lateFileIds.includes(r.sourceFileId));
  const cacheWarmDays = eventCaches.length;

  return (
    <div className="stack">
      <div className="grid cols-4">
        <div className="card stat">
          <div className="stat-label">当前策略</div>
          <div className="stat-value small">{STRATEGY_LABELS[eventStrategy]}</div>
          <div className="stat-foot">{eventStrategy === 'PERSIST_SNAPSHOT' ? '读到达即物化，查询快但补传/限值调整会成批失效' : '查询时推导，修订影响小，计算压力在查询/月末'}</div>
        </div>
        <div className="card stat">
          <div className="stat-label">输入签名</div>
          <div className="stat-value small mono">{eventSignatures.current?.slice(0, 12) ?? '—'}</div>
          <div className="stat-foot">
            缓存 {eventSignatures.cached ? eventSignatures.cached.slice(0, 12) : '无'} ·{' '}
            {eventSignatures.cacheFresh ? '一致' : '不一致'}
          </div>
        </div>
        <div className="card stat">
          <div className="stat-label">物化快照</div>
          <div className="stat-value">
            {mine.length}
            <span className="stat-unit">份</span>
          </div>
          <div className="stat-foot">{latest ? `最新 ${fmtDateTime(latest.derivedAt)}` : '该点位当日尚无快照'}</div>
        </div>
        <div className="card stat">
          <div className="stat-label">受影响事件</div>
          <div className="stat-value">
            {affected.length}
            <span className="stat-unit">个</span>
          </div>
          <div className="stat-foot">基于最新快照与当前证据比对</div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>两种派生方案</h2>
          <span className="sub">必须用同一套实测/插值/未知判定规则，对同一冻结输入给出相同结论</span>
          <div className="spacer" />
          <button
            className="btn small"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await actions.deriveEvents({ prove: true });
              setBusy(false);
            }}
          >
            运行一致性校验
          </button>
        </div>
        <div className="card-pad strategy-tabs">
          {(Object.keys(STRATEGY_LABELS) as DerivationStrategy[]).map((s) => (
            <button
              key={s}
              className="strategy-card"
              aria-pressed={eventStrategy === s}
              onClick={() => actions.setEventStrategy(s)}
            >
              <strong>{STRATEGY_LABELS[s]}</strong>
              <span>
                {s === 'PERSIST_SNAPSHOT'
                  ? '读数到达时物化带来源索引的事件片段。报表响应快；但补传或限值调整会让一段来源窗口的派生片段成批失效，必须刷新，不能用旧事件替代当前证据。'
                  : '只持久化原始有效片段与法规条件，在查询或申报时推导事件。修订影响小；计算压力移到调查与月末汇总。'}
              </span>
              <span className="tiny muted">
                适用：{s === 'PERSIST_SNAPSHOT' ? '查询负载高、补传密度低' : '补传/限值调整频繁、查询量中等'}
              </span>
            </button>
          ))}
        </div>
        {eventEquivalence && (
          <div className={`note ${eventEquivalence.equivalent ? 'ok' : 'bad'}`} style={{ margin: '0 18px 14px' }}>
            {eventEquivalence.equivalent
              ? '对同一冻结输入，两种方案事件集合完全一致（ID、起止、实测/插值/未知时长、限值、状态）。'
              : '两种方案出现差异，禁止用于申报。'}
            <div className="tiny" style={{ marginTop: 4 }}>
              {eventEquivalence.strategies.map((s) => `${STRATEGY_LABELS[s.strategy]}：${s.eventCount} 事件 / ${fmtNum(s.ms, 1)} ms`).join('；')}
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <h2>缓存新鲜度与操作</h2>
          <span className="sub">补传或限值调整后，来源窗口内的事件片段自动失效</span>
        </div>
        <div className="card-pad stack">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div className="small">
              <span className={`status-dot ${eventSignatures.cacheFresh ? 'ok' : eventSignatures.cached ? 'stale' : 'warn'}`} />
              {latest
                ? eventSignatures.cacheFresh
                  ? '物化快照与当前输入一致，可直接用于报表。'
                  : '物化快照与当前输入不一致：补传或限值调整已改变来源窗口，旧事件不得替代当前证据。'
                : '尚无物化快照。'}
            </div>
            <div className="row">
              <button className="btn" disabled={busy} onClick={() => void actions.loadEventCache()}>
                读取快照
              </button>
              <button className="btn primary" disabled={busy} onClick={() => void actions.refreshEventCache()}>
                刷新物化快照（重新派生）
              </button>
            </div>
          </div>
          <div className="note small">
            当前数据集中有 {lateReadings.length} 条迟到读数（{lateFileIds.length} 个迟到文件）。只要它们落在已物化的来源窗口内，
            该窗口的派生片段即视为成批失效；刷新后必须重新核对申报草稿。
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>快照清单</h2>
          <span className="sub">每个点位 × 自然日一份；记录派生时刻、引擎版本与输入签名</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>点位</th>
                <th>自然日</th>
                <th>派生时刻</th>
                <th>策略</th>
                <th>事件数</th>
                <th>输入签名</th>
                <th>引擎</th>
                <th>是否与当前一致</th>
              </tr>
            </thead>
            <tbody>
              {eventCaches.map((c) => (
                <tr key={c.cacheKey}>
                  <td className="mono tiny">{c.pointCode}</td>
                  <td className="mono tiny">{c.day}</td>
                  <td className="mono tiny">{fmtDateTime(c.derivedAt)}</td>
                  <td className="tiny">{STRATEGY_LABELS[c.strategy]}</td>
                  <td className="num">{c.summary.events.length}</td>
                  <td className="mono tiny">{c.inputSignature.slice(0, 12)}…</td>
                  <td className="mono tiny">{c.engineVersion}</td>
                  <td>
                    {c.pointCode === state.pointCode && c.day === state.day ? (
                      eventSignatures.cacheFresh ? <span className="badge ok">一致</span> : <span className="badge bad">过旧</span>
                    ) : (
                      <span className="muted tiny">非当前窗口</span>
                    )}
                  </td>
                </tr>
              ))}
              {eventCaches.length === 0 && (
                <tr><td colSpan={8} className="muted small">尚无物化快照。</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="card-pad tiny muted">共 {cacheWarmDays} 份快照 · 物化缓存只保存派生结果与来源索引，不保存原始读数副本。</div>
      </div>

      {lastInvalidation && (
        <div className="card">
          <div className="card-head">
            <h2>最近一次刷新影响</h2>
            <span className="sub">新增 / 删除 / 变更逐项列出</span>
          </div>
          <div className="card-pad stack">
            <ul className="list-reset stack" style={{ gap: 4 }}>
              {lastInvalidation.reasons.map((r, i) => (
                <li key={i} className="small muted">· {r}</li>
              ))}
            </ul>
            <div className="row">
              <span className="diff-pill added">新增 {lastInvalidation.added.length}</span>
              <span className="diff-pill removed">删除 {lastInvalidation.removed.length}</span>
              <span className="diff-pill changed">变更 {lastInvalidation.changed.length}</span>
              <span className="diff-pill">未受影响 {lastInvalidation.unchanged.length}</span>
            </div>
            <table>
              <thead>
                <tr>
                  <th>变化</th>
                  <th>事件</th>
                  <th>开始</th>
                  <th>限值</th>
                  <th>说明</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ...lastInvalidation.added.map((e) => ({ kind: 'added', e, note: '刷新后新增' })),
                  ...lastInvalidation.removed.map((e) => ({ kind: 'removed', e, note: '刷新后消失' })),
                  ...lastInvalidation.changed.map((c) => ({ kind: 'changed', e: c.after, note: `原 ${fmtNum(c.before.durationSeconds, 1)}s → ${fmtNum(c.after.durationSeconds, 1)}s` })),
                ].map((row, i) => (
                  <tr key={`${row.kind}-${row.e.eventId}-${i}`}>
                    <td><span className={`diff-pill ${row.kind}`}>{row.kind}</span></td>
                    <td className="mono tiny">{trimId(row.e.eventId, 22, 8)}</td>
                    <td className="mono tiny">{fmtDateTime(row.e.startAt).slice(5, 19)}</td>
                    <td className="num">{row.e.limit}</td>
                    <td className="tiny muted">{row.note}</td>
                  </tr>
                ))}
                {lastInvalidation.added.length + lastInvalidation.removed.length + lastInvalidation.changed.length === 0 && (
                  <tr><td colSpan={5} className="muted small">本次刷新没有改变任何事件。</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {eventSummary && affected.length > 0 && (
        <div className="card">
          <div className="card-head">
            <h2>来源窗口受影响事件</h2>
            <span className="sub">这些事件必须重新推导，不能沿用快照结论</span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>污染物</th>
                  <th>开始</th>
                  <th>缓存结束</th>
                  <th>当前结束</th>
                  <th className="num">缓存限值</th>
                  <th className="num">当前限值</th>
                  <th className="num">缓存时长 s</th>
                  <th className="num">当前时长 s</th>
                </tr>
              </thead>
              <tbody>
                {affected.map((before) => {
                  const now = currentById.get(before.eventId);
                  return (
                    <tr key={before.eventId}>
                      <td className="tiny">{before.pollutant}</td>
                      <td className="mono tiny">{shortTime(before.startAt)}</td>
                      <td className="mono tiny">{before.endAt ? shortTime(before.endAt) : '未闭合'}</td>
                      <td className="mono tiny">{now?.endAt ? shortTime(now.endAt) : now ? '未闭合' : '已不存在'}</td>
                      <td className="num">{before.limit}</td>
                      <td className="num">{now?.limit ?? '—'}</td>
                      <td className="num">{fmtNum(before.durationSeconds, 1)}</td>
                      <td className="num">{now ? fmtNum(now.durationSeconds, 1) : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

export type { ExceedanceEvent };
