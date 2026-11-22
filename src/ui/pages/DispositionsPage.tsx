import { useMemo, useState } from 'react';
import type { AppActions, AppState } from '../useAppState';
import { DISPOSITION_LABELS } from '../../domain/types';
import { dispositionsFor, linkDispositions } from '../../domain/dispositions';
import { fmtDateTime, fmtNum, shortTime, trimId } from '../format';

interface Props {
  state: AppState;
  actions: AppActions;
}

/**
 * 处置关联簿：加药、旁路、维护、清洗记录。
 * 把记录挂到事件上只是“同现”登记，causalClaim 恒为 false。
 * 迟到记录只能补证，不能宣布超标已消失。
 */
export function DispositionsPage({ state, actions }: Props) {
  const { dataset, eventSummary, eventStrategy } = state;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [eventId, setEventId] = useState<string | null>(null);

  const dispositions = useMemo(() => dispositionsFor(dataset, state.pointCode), [dataset, state.pointCode]);
  const cutoff = dataset.files
    .filter((f) => f.kind !== 'LATE_BATCH')
    .reduce((a, f) => Math.max(a, f.receivedAt), 0);
  const selected = dispositions.find((d) => d.dispositionId === selectedId) ?? null;
  const events = eventSummary?.events ?? [];
  const activeEvent = events.find((e) => e.eventId === eventId) ?? null;
  const activeLinks = activeEvent ? linkDispositions(activeEvent, dispositions, cutoff) : [];

  const lateCount = dispositions.filter((d) => d.receivedAt > cutoff).length;

  return (
    <div className="stack">
      <div className="card card-pad">
        <div className="toolbar" style={{ justifyContent: 'space-between' }}>
          <div className="small muted">
            处置记录按时间落在事件附近登记；<strong>同现不等于因果</strong>。处置不能删除事件、也不能把已发生的超标判为消失；
            申报后才到达的处置只能补证。
          </div>
          <div className="row">
            <span className="badge neutral">{dispositions.length} 条记录</span>
            <span className="badge warn">{lateCount} 条迟到</span>
            <button className="btn small" onClick={() => void actions.importLate()} disabled={state.loading}>
              导入迟到补录（含迟到处置）
            </button>
          </div>
        </div>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <div className="card-head">
            <h2>处置记录</h2>
            <span className="sub">加药 / 旁路 / 维护 / 清洗</span>
          </div>
          <div className="table-wrap" style={{ maxHeight: 420 }}>
            <table>
              <thead>
                <tr>
                  <th>记录</th>
                  <th>类型</th>
                  <th>时段</th>
                  <th>接收</th>
                  <th>摘要</th>
                </tr>
              </thead>
              <tbody>
                {dispositions.map((d) => {
                  const late = d.receivedAt > cutoff;
                  return (
                    <tr
                      key={d.dispositionId}
                      className={selectedId === d.dispositionId ? 'selected' : ''}
                      style={{ cursor: 'pointer' }}
                      onClick={() => setSelectedId(d.dispositionId)}
                    >
                      <td className="mono tiny">{trimId(d.dispositionId, 22, 6)}</td>
                      <td>
                        <span className="badge neutral">{DISPOSITION_LABELS[d.kind]}</span>
                        {d.pollutant !== 'ANY' && <span className="tiny muted"> {d.pollutant}</span>}
                      </td>
                      <td className="mono tiny">{shortTime(d.from)}–{shortTime(d.to)}</td>
                      <td>
                        <span className="mono tiny">{fmtDateTime(d.receivedAt).slice(5, 16)}</span>
                        {late && <span className="badge warn" style={{ marginLeft: 6 }}>迟到</span>}
                      </td>
                      <td className="tiny">{d.summary}</td>
                    </tr>
                  );
                })}
                {dispositions.length === 0 && (
                  <tr><td colSpan={5} className="muted small">该点位尚无处置记录。</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h2>事件 × 处置关联</h2>
            <span className="sub">causalClaim 恒为 false；只登记时间关系</span>
            <div className="spacer" />
            <select value={eventId ?? ''} onChange={(e) => setEventId(e.target.value || null)} style={{ maxWidth: 260 }}>
              <option value="">选择事件…</option>
              {events.map((e) => (
                <option key={e.eventId} value={e.eventId}>
                  {e.pollutant} {shortTime(e.startAt)} · {e.limit} mg/L
                </option>
              ))}
            </select>
          </div>
          <div className="card-pad stack">
            {!eventSummary && (
              <div className="note warn small">
                {eventStrategy === 'PERSIST_SNAPSHOT'
                  ? '当前没有可用事件（快照可能已过旧）。请刷新物化快照或切换到查询时推导。'
                  : '当前没有事件摘要。'}
              </div>
            )}
            {activeEvent && (
              <>
                <dl className="kv">
                  <dt>事件</dt>
                  <dd className="mono tiny">{trimId(activeEvent.eventId, 28, 8)}</dd>
                  <dt>时段</dt>
                  <dd className="mono tiny">{fmtDateTime(activeEvent.startAt)} → {activeEvent.endAt ? fmtDateTime(activeEvent.endAt) : '未闭合'}</dd>
                  <dt>关联记录</dt>
                  <dd>{activeLinks.length} 条</dd>
                </dl>
                <div className="table-wrap" style={{ maxHeight: 260 }}>
                  <table>
                    <thead>
                      <tr>
                        <th>记录</th>
                        <th>关系</th>
                        <th className="num">重叠 s</th>
                        <th>迟到</th>
                        <th>说明</th>
                      </tr>
                    </thead>
                    <tbody>
                      {activeLinks.map((l) => (
                        <tr key={l.disposition.dispositionId}>
                          <td className="mono tiny">{trimId(l.disposition.dispositionId, 20, 6)}</td>
                          <td className="tiny">{l.relation === 'OVERLAPS' ? '重叠' : l.relation === 'BEFORE' ? '事件前' : '事件后'}</td>
                          <td className="num">{fmtNum(l.overlapSeconds, 0)}</td>
                          <td>{l.late ? <span className="badge warn">迟到</span> : <span className="muted tiny">否</span>}</td>
                          <td className="tiny muted">{l.note}</td>
                        </tr>
                      ))}
                      {activeLinks.length === 0 && (
                        <tr><td colSpan={5} className="muted small">事件周边 30 分钟内没有处置记录（没有可登记的关联）。</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
                <div className="note warn small">
                  迟到处置记录只补充解释，不改变事件起止与申报值；任何“处置后超标已消失”的结论都必须由实测回落证据支持。
                </div>
              </>
            )}
            {!activeEvent && eventSummary && <div className="small muted">请选择上方事件查看关联。</div>}
          </div>
        </div>
      </div>

      {selected && (
        <div className="card card-pad">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div>
              <strong className="mono">{selected.dispositionId}</strong>
              <span className="badge neutral" style={{ marginLeft: 8 }}>{DISPOSITION_LABELS[selected.kind]}</span>
              {selected.receivedAt > cutoff && <span className="badge warn" style={{ marginLeft: 6 }}>迟到</span>}
              <div className="small muted" style={{ marginTop: 4 }}>{selected.note}</div>
            </div>
            <dl className="kv" style={{ minWidth: 320 }}>
              <dt>点位 / 因子</dt>
              <dd className="mono">{selected.pointCode} / {selected.pollutant}</dd>
              <dt>处置时段</dt>
              <dd className="mono tiny">{fmtDateTime(selected.from)} → {fmtDateTime(selected.to)}</dd>
              <dt>接收时刻</dt>
              <dd className="mono tiny">{fmtDateTime(selected.receivedAt)}</dd>
              <dt>记录人 / 工单</dt>
              <dd className="tiny">{selected.recordedBy} · {selected.workOrder}</dd>
              <dt>来源文件</dt>
              <dd className="mono tiny">{trimId(selected.sourceFileId, 30, 8)}</dd>
            </dl>
          </div>
        </div>
      )}
    </div>
  );
}
