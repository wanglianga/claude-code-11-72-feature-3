import { useMemo, useState } from 'react';
import type { AppActions, AppState } from '../useAppState';
import type { DerivationStrategy, Pollutant } from '../../domain/types';
import { STRATEGY_LABELS, DISPOSITION_LABELS, EVIDENCE_END_LABELS } from '../../domain/types';
import { EventTimeline } from '../charts/EventTimeline';
import { dispositionsFor, linkDispositions, lateDispositionEffect, dispositionContext } from '../../domain/dispositions';
import {
  fmtDateTime,
  fmtNum,
  eventStatusBadge,
  EVIDENCE_KIND_LABEL,
  EVENT_BOUNDARY_LABEL,
  kgRange,
  pct,
  shortTime,
  trimId,
} from '../format';

interface Props {
  state: AppState;
  actions: AppActions;
  /** 同一页面既作“事件时间线”又作“证据分段”入口，evidence 时默认展开首个事件 */
  initialTab?: 'timeline' | 'evidence';
}

export function EventsPage({ state, actions, initialTab = 'timeline' }: Props) {
  const { eventSummary, eventStrategy, eventSignatures, eventNotes, eventDeriving, dataset, eventEquivalence } = state;
  const [pollutant, setPollutant] = useState<Pollutant>('COD');
  const [selectedEventId, setSelectedEventId] = useState<string | null>(
    initialTab === 'evidence' ? state.eventSummary?.events[0]?.eventId ?? null : null,
  );

  const dispositions = useMemo(() => dispositionsFor(dataset, state.pointCode), [dataset, state.pointCode]);
  const effectiveSelectedId =
    selectedEventId ?? (initialTab === 'evidence' ? eventSummary?.events[0]?.eventId ?? null : null);
  const selected = eventSummary?.events.find((e) => e.eventId === effectiveSelectedId) ?? null;
  const cutoff = dataset.files
    .filter((f) => f.kind !== 'LATE_BATCH')
    .reduce((a, f) => Math.max(a, f.receivedAt), 0);

  const links = selected ? linkDispositions(selected, dispositions, cutoff) : [];
  const lateNotes = selected ? lateDispositionEffect(links) : [];
  const context = dispositionContext(links);

  const stats = eventSummary?.perPollutant.find((p) => p.pollutant === pollutant) ?? null;

  return (
    <div className="stack">
      <div className="card card-pad">
        <div className="toolbar" style={{ justifyContent: 'space-between' }}>
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <div className="field" style={{ minWidth: 220 }}>
              <label>派生方案</label>
              <select value={eventStrategy} onChange={(e) => actions.setEventStrategy(e.target.value as DerivationStrategy)}>
                {(Object.keys(STRATEGY_LABELS) as DerivationStrategy[]).map((s) => (
                  <option key={s} value={s}>
                    {STRATEGY_LABELS[s]}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>污染物</label>
              <select value={pollutant} onChange={(e) => setPollutant(e.target.value as Pollutant)}>
                <option value="COD">COD</option>
                <option value="NH3N">氨氮</option>
              </select>
            </div>
            <button className="btn" onClick={() => void actions.deriveEvents({ refresh: true })} disabled={eventDeriving}>
              {eventDeriving ? '推导中…' : '重新推导'}
            </button>
            <button className="btn" onClick={() => void actions.deriveEvents({ prove: true })} disabled={eventDeriving}>
              双方案一致性校验
            </button>
            {eventStrategy === 'PERSIST_SNAPSHOT' && (
              <>
                <button className="btn" onClick={() => void actions.persistSnapshot()} disabled={eventDeriving}>
                  物化当前事件
                </button>
                <button className="btn" onClick={() => void actions.refreshEventCache()} disabled={eventDeriving}>
                  刷新物化快照
                </button>
              </>
            )}
          </div>
          <div className="row">
            <span className="badge neutral">
              <span className={`status-dot ${eventSignatures.cacheFresh ? 'ok' : eventSignatures.cached ? 'stale' : 'warn'}`} />
              {eventStrategy === 'PERSIST_SNAPSHOT'
                ? eventSignatures.cached
                  ? eventSignatures.cacheFresh
                    ? '快照与当前证据一致'
                    : '快照已过旧'
                  : '尚无快照'
                : '查询时推导'}
            </span>
            {eventSignatures.current && (
              <span className="mono tiny muted" title="输入签名（读数/状态/校准/限值）">
                签名 {eventSignatures.current.slice(0, 10)}
              </span>
            )}
          </div>
        </div>
        {eventNotes.length > 0 && (
          <ul className="list-reset stack" style={{ gap: 4, marginTop: 10 }}>
            {eventNotes.map((n, i) => (
              <li key={i} className="small muted">· {n}</li>
            ))}
          </ul>
        )}
        {eventEquivalence && (
          <div className={`note ${eventEquivalence.equivalent ? 'ok' : 'bad'}`} style={{ marginTop: 10 }}>
            {eventEquivalence.equivalent ? '两种派生方案对同一冻结输入给出同一事件集合。' : '两种方案结果不一致，禁止用于申报。'}
            {' '}
            {eventEquivalence.strategies.map((s) => `${STRATEGY_LABELS[s.strategy]}：${s.eventCount} 个事件 / ${fmtNum(s.ms, 1)} ms`).join('；')}
          </div>
        )}
        {eventStrategy === 'PERSIST_SNAPSHOT' && eventSignatures.cached && !eventSignatures.cacheFresh && (
          <div className="note bad" style={{ marginTop: 10 }}>
            物化快照的输入签名与当前数据不一致（补传或限值调整）。按规则，旧事件不得替代当前证据：
            请点“刷新物化快照”，或切换到“查询时推导”。
          </div>
        )}
      </div>

      {!eventSummary && (
        <div className="card card-pad empty">
          {eventDeriving ? '正在推导事件…' : '当前没有可用的事件摘要。请在“概览”装载样例资料，或刷新物化快照 / 切换为查询时推导。'}
        </div>
      )}

      {eventStrategy === 'PERSIST_SNAPSHOT' && (
        <div className="card card-pad">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div className="small muted">
              当前为“读数到达即物化”：上表来自物化快照，查询快，但<b>补传读数或限值调整会让一段来源窗口的派生片段成批失效</b>。
              任何一次刷新都会重新派生并记录影响（见“派生影响”）。
            </div>
            <div className="row">
              <button className="btn small" onClick={() => void actions.loadEventCache()}>
                读取已物化快照
              </button>
              <button className="btn small" onClick={() => void actions.refreshEventCache()}>
                刷新快照并比对影响
              </button>
            </div>
          </div>
        </div>
      )}

      {eventSummary && (
        <>
          <div className="card">
            <div className="card-head">
              <h2>事件时间线</h2>
              <span className="sub">
                {eventSummary.pointCode} · {eventSummary.day} · {STRATEGY_LABELS[eventSummary.strategy]} · 引擎 {eventSummary.engineVersion}
              </span>
              <div className="spacer" />
              {stats && (
                <div className="row">
                  <span className="badge neutral">事件 {stats.eventCount}</span>
                  <span className="badge neutral">未闭合 {stats.openEvents}</span>
                  <span className="badge warn">未知 {fmtNum(stats.unknownSeconds, 0)} s</span>
                </div>
              )}
            </div>
            <EventTimeline summary={eventSummary} pollutant={pollutant} selectedEventId={effectiveSelectedId} onSelectEvent={setSelectedEventId} />
          </div>

          <div className="card">
            <div className="card-head">
              <h2>事件清单</h2>
              <span className="sub">开始/结束、实测 / 插值 / 未知时长分开列示；点击行展开证据</span>
            </div>
            <div className="table-wrap" style={{ maxHeight: 360 }}>
              <table>
                <thead>
                  <tr>
                    <th>污染物</th>
                    <th>开始</th>
                    <th>结束</th>
                    <th>状态</th>
                    <th className="num">限值</th>
                    <th className="num">实测 s</th>
                    <th className="num">插值 s</th>
                    <th className="num">未知 s</th>
                    <th className="num">峰值</th>
                    <th className="num">超额负荷 kg</th>
                    <th>标准</th>
                  </tr>
                </thead>
                <tbody>
                  {eventSummary.events.map((e) => {
                    const b = eventStatusBadge(e.status);
                    return (
                      <tr
                        key={e.eventId}
                        className={effectiveSelectedId === e.eventId ? 'selected' : ''}
                        style={{ cursor: 'pointer' }}
                        onClick={() => setSelectedEventId(e.eventId)}
                      >
                        <td>{e.pollutant === 'COD' ? 'COD' : '氨氮'}</td>
                        <td className="mono tiny">{fmtDateTime(e.startAt).slice(5, 19)}</td>
                        <td className="mono tiny">{e.endAt ? fmtDateTime(e.endAt).slice(5, 19) : <span className="badge warn">未闭合</span>}</td>
                        <td>
                          <span className={`badge ${b.cls}`}>{b.label}</span>
                        </td>
                        <td className="num">{e.limit}</td>
                        <td className="num">{fmtNum(e.measuredSeconds, 1)}</td>
                        <td className="num">{fmtNum(e.interpolatedSeconds, 1)}</td>
                        <td className="num">{e.unknownSeconds > 0 ? <strong style={{ color: 'var(--warn)' }}>{fmtNum(e.unknownSeconds, 0)}</strong> : '0'}</td>
                        <td className="num">{fmtNum(e.peak, 2)}</td>
                        <td className="num">{e.excessLoadKg ? fmtNum(e.excessLoadKg.best, 3) : '流量缺失'}</td>
                        <td className="tiny muted">{e.standardId}</td>
                      </tr>
                    );
                  })}
                  {eventSummary.events.length === 0 && (
                    <tr>
                      <td colSpan={11} className="muted small">当日没有推导出的超标事件。</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {selected && (
            <div className="grid cols-2">
              <div className="card">
                <div className="card-head">
                  <h2>证据分段</h2>
                  <span className="sub mono">{trimId(selected.eventId, 28, 8)}</span>
                  <div className="spacer" />
                  <span className={`badge ${eventStatusBadge(selected.status).cls}`}>{eventStatusBadge(selected.status).label}</span>
                </div>
                <div className="card-pad stack">
                  <dl className="kv">
                    <dt>事件区间</dt>
                    <dd className="mono">
                      {fmtDateTime(selected.startAt)} → {selected.endAt ? fmtDateTime(selected.endAt) : '未闭合'}
                    </dd>
                    <dt>持续判定</dt>
                    <dd>
                      {selected.evidence.continuous ? (
                        <span className="badge ok">全程有证据</span>
                      ) : (
                        <span className="badge warn">存在未知空档，未证实连续</span>
                      )}
                    </dd>
                    <dt>时长拆分</dt>
                    <dd>
                      实测 {fmtNum(selected.measuredSeconds, 1)} s · 插值 {fmtNum(selected.interpolatedSeconds, 1)} s · 未知{' '}
                      {fmtNum(selected.unknownSeconds, 1)} s
                    </dd>
                    <dt>限值 / 标准</dt>
                    <dd>
                      {selected.limit} mg/L · {selected.limitBasis} <span className="mono tiny muted">[{selected.standardId}]</span>
                    </dd>
                    <dt>结束原因</dt>
                    <dd className="small">{EVIDENCE_END_LABELS[selected.endReason as keyof typeof EVIDENCE_END_LABELS] ?? selected.endReason}</dd>
                    <dt>超额面积</dt>
                    <dd className="mono">{fmtNum(selected.excessAreaMgLs, 1)} mg/L·s</dd>
                    <dt>超额负荷</dt>
                    <dd className="mono">{selected.excessLoadKg ? `${kgRange(selected.excessLoadKg, 3)} kg` : '该段流量缺失，不计超额负荷'}</dd>
                    <dt>来源</dt>
                    <dd className="tiny muted">
                      {selected.sourceReadingIds.length} 读数 · {selected.sourceFileIds.length} 文件 · {selected.sourceStateIds.length} 状态
                    </dd>
                  </dl>
                  <div className="hr" />
                  <div className="sev-grid">
                    {selected.evidence.segments.map((s) => (
                      <div
                        key={s.evidenceId}
                        className={`sev-cell ${s.kind === 'MEASURED' ? 'measured' : s.kind === 'INTERPOLATED' ? 'interpolated' : 'gap'}`}
                      >
                        <span className="t">
                          {EVIDENCE_KIND_LABEL[s.kind]} · {shortTime(s.from)}–{shortTime(s.to)}
                        </span>
                        <span className="v">
                          {s.kind === 'GAP_UNKNOWN'
                            ? `${fmtNum(s.seconds, 0)} s 无证据`
                            : `${fmtNum(s.startValue ?? 0, 1)} → ${fmtNum(s.endValue ?? 0, 1)} mg/L`}
                        </span>
                        <span className="tiny muted">
                          {s.kind === 'GAP_UNKNOWN'
                            ? '不计入超标时长'
                            : s.peak !== null
                              ? `峰值 ${fmtNum(s.peak, 1)} · ${fmtNum(s.seconds, 1)} s`
                              : `${fmtNum(s.seconds, 1)} s`}
                        </span>
                        <span className="tiny muted">{EVIDENCE_END_LABELS[s.endReason] ?? s.endReason}</span>
                      </div>
                    ))}
                  </div>
                  <div className="note small">{selected.evidence.interpolationRule}</div>
                  <div className="note small">{selected.evidence.unknownPolicy}</div>
                </div>
              </div>

              <div className="card">
                <div className="card-head">
                  <h2>边界与处置关联</h2>
                  <span className="sub">处置记录只登记，不宣称因果</span>
                </div>
                <div className="card-pad stack">
                  <div className="small muted">事件边界（来源链）：</div>
                  <ul className="list-reset stack" style={{ gap: 5 }}>
                    {selected.boundaries.map((b, i) => (
                      <li key={`${b.kind}-${i}`} className="small">
                        <span className="badge neutral">{EVENT_BOUNDARY_LABEL[b.kind] ?? b.kind}</span>{' '}
                        <span className="mono tiny">{fmtDateTime(b.at)}</span> · {b.label}
                        {b.interpolated && <span className="badge info" style={{ marginLeft: 6 }}>插值推算</span>}
                      </li>
                    ))}
                  </ul>
                  <div className="hr" />
                  <div className="small muted">处置关联簿（{links.length} 条）：</div>
                  {links.length === 0 && <div className="small muted">事件周边 30 分钟内没有登记的处置记录。</div>}
                  <ul className="list-reset stack" style={{ gap: 6 }}>
                    {links.map((l) => (
                      <li key={l.disposition.dispositionId} className="small">
                        <span className="badge neutral">{DISPOSITION_LABELS[l.disposition.kind]}</span>{' '}
                        <span className="mono tiny">{shortTime(l.disposition.from)}–{shortTime(l.disposition.to)}</span>
                        {l.late && <span className="badge warn" style={{ marginLeft: 6 }}>迟到</span>}
                        <span className="badge info" style={{ marginLeft: 6 }}>同现≠因果</span>
                        <div className="tiny muted">{l.disposition.summary}（{l.disposition.recordedBy}）· {l.note}</div>
                      </li>
                    ))}
                  </ul>
                  {lateNotes.length > 0 && (
                    <div className="note warn small">
                      {lateNotes.map((n, i) => (
                        <div key={i}>{n}</div>
                      ))}
                    </div>
                  )}
                  <div className="note small">{context.summary}</div>
                </div>
              </div>
            </div>
          )}

          <div className="card">
            <div className="card-head">
              <h2>时间线图例</h2>
              <span className="sub">证据段的颜色与线型含义</span>
            </div>
            <div className="card-pad evidence-legend">
              <span><i style={{ background: 'var(--danger)' }} /> 实测超限（两端实测读数均高于限值）</span>
              <span><i style={{ backgroundImage: 'repeating-linear-gradient(45deg, rgba(163,49,44,.85), rgba(163,49,44,.85) 3px, rgba(163,49,44,.3) 3px, rgba(163,49,44,.3) 7px)' }} /> 插值超限（穿越点由线性插值推算）</span>
              <span><i style={{ background: 'repeating-linear-gradient(90deg, rgba(215,178,106,.95), rgba(215,178,106,.95) 2px, transparent 2px, transparent 6px)' }} /> 未知空档（不计入超标时长）</span>
              <span><i style={{ background: 'rgba(184,164,143,.55)' }} /> 清洗 / 校准 / 旁路 / 故障（插值链终止）</span>
              <span><i style={{ background: 'rgba(39,93,140,.18)' }} /> 标准窗口（限值生效期）</span>
              <span><i style={{ background: 'var(--info)', height: 10, width: 2 }} /> 限值调整切分</span>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <h2>间隔证据与未知空档</h2>
              <span className="sub">跨越空档不能凭相邻高值臆造持续超标</span>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>污染物</th>
                    <th>时段</th>
                    <th>类型</th>
                    <th className="num">秒</th>
                    <th className="num">前值</th>
                    <th className="num">后值</th>
                    <th>在事件内</th>
                    <th>可能超限</th>
                    <th>处理</th>
                  </tr>
                </thead>
                <tbody>
                  {eventSummary.gaps.map((g) => (
                    <tr key={g.gapId}>
                      <td className="tiny">{g.pollutant === 'COD' ? 'COD' : '氨氮'}</td>
                      <td className="mono tiny">{shortTime(g.from)} → {shortTime(g.to)}</td>
                      <td><span className="badge info">{g.kind}</span></td>
                      <td className="num">{fmtNum(g.seconds, 0)}</td>
                      <td className="num">{g.beforeValue === null ? '—' : fmtNum(g.beforeValue, 1)}</td>
                      <td className="num">{g.afterValue === null ? '—' : fmtNum(g.afterValue, 1)}</td>
                      <td>{g.insideEvent ? <span className="badge warn">是</span> : <span className="muted tiny">否</span>}</td>
                      <td>{g.possibleExceedance ? <span className="badge warn">是</span> : <span className="muted tiny">否</span>}</td>
                      <td className="tiny muted">{g.effect}</td>
                    </tr>
                  ))}
                  {eventSummary.gaps.length === 0 && (
                    <tr><td colSpan={9} className="muted small">当日没有需要披露的间隔证据缺口。</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {eventSummary.conflicts.length > 0 && (
            <div className="card card-pad">
              <div className="note warn">
                <strong>标准适用库冲突：</strong>
                {eventSummary.conflicts.map((c) => (
                  <div key={`${c.at}-${c.pollutant}`} className="small">
                    {fmtDateTime(c.at)} · {c.pollutant} · {c.reason}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="card card-pad">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div className="small muted">
                事件 = 有效浓度片段 × 标准窗口 × 状态边界 × 间隔证据。清洗开始即终止插值链；限值调整必切开；
                未知空档单列且不计入超标时长。当前覆盖率口径与负荷计算共享同一片段编织结果。
              </div>
              <span className="badge neutral">当前点位覆盖率 {pct(state.snapshot?.coverage ?? 0)}</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
