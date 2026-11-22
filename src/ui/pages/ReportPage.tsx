import { useMemo, useState } from 'react';
import type { AppActions, AppState } from '../useAppState';
import type { DailyReportCheck, DailyReportDraft } from '../../domain/types';
import { DRAFT_STATUS_LABELS, STRATEGY_LABELS } from '../../domain/types';
import { buildReportRows } from '../../domain/dailyReport';
import { dispositionsFor, linkDispositions, lateDispositionEffect } from '../../domain/dispositions';
import { fmtDateTime, fmtNum, kgRange, shortTime, trimId } from '../format';

interface Props {
  state: AppState;
  actions: AppActions;
}

export function ReportPage({ state, actions }: Props) {
  const { eventSummary, eventDrafts, eventSignatures, dataset, actor } = state;
  const mine = useMemo(
    () =>
      eventDrafts
        .filter((d) => d.pointCode === state.pointCode && d.day === state.day)
        .sort((a, b) => b.createdAt - a.createdAt),
    [eventDrafts, state.pointCode, state.day],
  );
  const [selectedDraftId, setSelectedDraftId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [check, setCheck] = useState<DailyReportCheck | null>(null);
  const [busy, setBusy] = useState(false);

  const active = mine.find((d) => d.draftId === selectedDraftId) ?? mine[0] ?? null;
  const cutoff = dataset.files.filter((f) => f.kind !== 'LATE_BATCH').reduce((a, f) => Math.max(a, f.receivedAt), 0);
  const dispositions = useMemo(() => dispositionsFor(dataset, state.pointCode), [dataset, state.pointCode]);
  const lateDispositionEffects = useMemo(
    () => (active ? [...new Set(active.events.flatMap((e) => lateDispositionEffect(linkDispositions(e, dispositions, cutoff))))] : []),
    [active, dispositions, cutoff],
  );

  const preview = eventSummary ? buildReportRows(eventSummary.events, eventSummary.gaps) : null;

  const runCheck = async (draftId: string) => {
    setBusy(true);
    const result = await actions.checkReport(draftId);
    setCheck(result);
    setBusy(false);
  };

  return (
    <div className="stack">
      <div className="card card-pad">
        <div className="toolbar" style={{ justifyContent: 'space-between' }}>
          <div className="small muted">
            自然日申报值由事件汇总：上报超标时长 = 实测时长 + 可插值时长；未知空档单列，不计入上报值。
            补传或限值调整使草稿转入复核，不能以旧草稿替代当前证据。
          </div>
          <div className="row">
            <span className={`badge ${eventSummary ? 'ok' : 'warn'}`}>
              {eventSummary ? `当前事件 ${eventSummary.events.length} 个` : '当前事件不可用'}
            </span>
            <button className="btn small" onClick={() => void actions.deriveEvents({ refresh: true })}>
              重新推导事件
            </button>
            <button className="btn primary" onClick={() => void actions.createReportDraft()} disabled={!eventSummary}>
              生成申报草稿
            </button>
          </div>
        </div>
        {!eventSummary && (
          <div className="note warn" style={{ marginTop: 10 }}>
            当前没有可用的事件摘要（快照可能已过旧或被限值调整改变）。请先刷新事件，再生成申报草稿；
            系统不会用旧事件代替当前证据。
          </div>
        )}
        {eventSummary && (
          <div className="tiny muted" style={{ marginTop: 8 }}>
            当前事件签名 {eventSignatures.current?.slice(0, 12)} · 数据 {dataset.readings.length.toLocaleString('zh-CN')} 条读数 ·{' '}
            {STRATEGY_LABELS[eventSummary.strategy]}
          </div>
        )}
      </div>

      {preview && (
        <div className="card">
          <div className="card-head">
            <h2>当前事件汇总（待生成草稿）</h2>
            <span className="sub">{state.pointCode} · {state.day} · 按标准窗口分别披露</span>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>污染物</th>
                  <th className="num">事件数</th>
                  <th className="num">上报超标 s</th>
                  <th className="num">实测 s</th>
                  <th className="num">插值 s</th>
                  <th className="num">未知空档 s</th>
                  <th className="num">峰值 mg/L</th>
                  <th className="num">超额负荷 kg</th>
                  <th>限值窗口</th>
                </tr>
              </thead>
              <tbody>
                {preview.map((r) => (
                  <tr key={r.pollutant}>
                    <td>{r.pollutant === 'COD' ? 'COD' : '氨氮'}</td>
                    <td className="num">{r.eventIds.length}</td>
                    <td className="num"><strong>{fmtNum(r.reportableSeconds, 1)}</strong></td>
                    <td className="num">{fmtNum(r.measuredSeconds, 1)}</td>
                    <td className="num">{fmtNum(r.interpolatedSeconds, 1)}</td>
                    <td className="num">{r.unknownSeconds > 0 ? <span style={{ color: 'var(--warn)' }}>{fmtNum(r.unknownSeconds, 0)}</span> : '0'}</td>
                    <td className="num">{fmtNum(r.peak, 2)}</td>
                    <td className="num">{r.excessLoadKg ? kgRange(r.excessLoadKg, 3) : '流量缺失'}</td>
                    <td className="tiny">
                      {r.limitWindows.map((w) => `${w.limit} mg/L（${shortTime(w.from)}–${shortTime(w.to)}）`).join('；')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {mine.length === 0 && (
        <div className="card card-pad empty">
          该点位当日尚无申报草稿。生成后会冻结事件集合与输入签名；补传或限值调整会让草稿转入“待复核”。
        </div>
      )}

      {mine.length > 0 && (
        <div className="card">
          <div className="card-head">
            <h2>申报草稿</h2>
            <span className="sub">草稿冻结事件与输入签名；出具前必须与当前证据核对</span>
            <div className="spacer" />
            <select value={active?.draftId ?? ''} onChange={(e) => { setSelectedDraftId(e.target.value); setCheck(null); }} style={{ maxWidth: 300 }}>
              {mine.map((d) => (
                <option key={d.draftId} value={d.draftId}>
                  {fmtDateTime(d.createdAt)} · {DRAFT_STATUS_LABELS[d.status]} · {d.draftId.slice(-8)}
                </option>
              ))}
            </select>
          </div>
          {active && (
            <div className="card-pad stack">
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <div>
                  <span className={`badge ${active.status === 'NEEDS_RECHECK' ? 'warn' : active.status === 'FILED' ? 'ok' : 'neutral'}`}>
                    {DRAFT_STATUS_LABELS[active.status]}
                  </span>
                  <span className="mono tiny" style={{ marginLeft: 8 }}>{active.draftId}</span>
                  <div className="tiny muted" style={{ marginTop: 4 }}>
                    生成 {fmtDateTime(active.createdAt)} · {active.createdBy} · 策略 {STRATEGY_LABELS[active.strategy]} · 截止接收{' '}
                    {active.cutoffReceivedAt ? fmtDateTime(active.cutoffReceivedAt) : '—'}
                  </div>
                  <div className="tiny muted">
                    草稿签名 {active.snapshotSignature.slice(0, 12)} · 当前签名 {eventSignatures.current?.slice(0, 12) ?? '—'}
                  </div>
                </div>
                <div className="row">
                  <button className="btn" onClick={() => void runCheck(active.draftId)} disabled={busy}>
                    {busy ? '核对中…' : '与当前证据核对'}
                  </button>
                  {active.status === 'NEEDS_RECHECK' && (
                    <button
                      className="btn"
                      disabled={busy || !note.trim()}
                      title={note.trim() ? '复核人确认后恢复为可核对' : '请先填写复核附注'}
                      onClick={async () => {
                        setBusy(true);
                        await actions.reopenReport(active.draftId, note);
                        setBusy(false);
                        setCheck(null);
                      }}
                    >
                      复核人确认恢复
                    </button>
                  )}
                </div>
              </div>

              {active.invalidatedBy && (
                <div className="note warn small">
                  已转入复核：{active.invalidatedBy.reason}（{fmtDateTime(active.invalidatedBy.at)}）
                  <div className="tiny">{active.invalidatedBy.detail}</div>
                </div>
              )}

              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>污染物</th>
                      <th className="num">上报超标 s</th>
                      <th className="num">实测 s</th>
                      <th className="num">插值 s</th>
                      <th className="num">未知 s</th>
                      <th className="num">峰值</th>
                      <th className="num">超额负荷</th>
                      <th>附注</th>
                    </tr>
                  </thead>
                  <tbody>
                    {active.rows.map((r) => (
                      <tr key={r.pollutant}>
                        <td>{r.pollutant === 'COD' ? 'COD' : '氨氮'}</td>
                        <td className="num">{fmtNum(r.reportableSeconds, 1)}</td>
                        <td className="num">{fmtNum(r.measuredSeconds, 1)}</td>
                        <td className="num">{fmtNum(r.interpolatedSeconds, 1)}</td>
                        <td className="num">{fmtNum(r.unknownSeconds, 0)}</td>
                        <td className="num">{fmtNum(r.peak, 2)}</td>
                        <td className="num">{r.excessLoadKg ? kgRange(r.excessLoadKg, 3) : '—'}</td>
                        <td className="tiny muted">{r.notes[0] ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="small muted">草稿事件：</div>
              <div className="table-wrap" style={{ maxHeight: 220 }}>
                <table>
                  <thead>
                    <tr>
                      <th>事件</th>
                      <th>开始</th>
                      <th>结束</th>
                      <th>限值</th>
                      <th className="num">上报 s</th>
                      <th className="num">未知 s</th>
                      <th>状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {active.events.map((e) => (
                      <tr key={e.eventId}>
                        <td className="mono tiny">{trimId(e.eventId, 22, 6)}</td>
                        <td className="mono tiny">{shortTime(e.startAt)}</td>
                        <td className="mono tiny">{e.endAt ? shortTime(e.endAt) : '未闭合'}</td>
                        <td className="num">{e.limit}</td>
                        <td className="num">{fmtNum(e.measuredSeconds + e.interpolatedSeconds, 1)}</td>
                        <td className="num">{fmtNum(e.unknownSeconds, 0)}</td>
                        <td className="tiny">{e.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {lateDispositionEffects.length > 0 && (
                <div className="note warn small">
                  <strong>迟到处置仅可补证：</strong>
                  {lateDispositionEffects.slice(0, 6).map((n, i) => (
                    <div key={i}>{n}</div>
                  ))}
                </div>
              )}

              {check && (
                <div className={`note ${check.status === 'MATCH' ? 'ok' : 'bad'}`}>
                  <div>
                    <strong>
                      {check.status === 'MATCH' ? '一致' : check.status === 'NEEDS_RECHECK' ? '需要复核' : '缓存过旧，禁止出具'}
                    </strong>
                    ：{check.message}
                  </div>
                  {check.changes.length > 0 && (
                    <div className="table-wrap" style={{ marginTop: 8 }}>
                      <table>
                        <thead>
                          <tr>
                            <th>变化</th>
                            <th>污染物</th>
                            <th>事件</th>
                            <th>字段</th>
                            <th>草稿</th>
                            <th>当前</th>
                          </tr>
                        </thead>
                        <tbody>
                          {check.changes.map((c, i) => (
                            <tr key={`${c.eventId}-${c.field}-${i}`}>
                              <td>
                                <span className={`diff-pill ${c.kind === 'ADDED' ? 'added' : c.kind === 'REMOVED' ? 'removed' : 'changed'}`}>{c.kind}</span>
                              </td>
                              <td className="tiny">{c.pollutant}</td>
                              <td className="mono tiny">{c.eventId ? trimId(c.eventId, 18, 6) : '—'}</td>
                              <td className="tiny">{c.field}</td>
                              <td className="tiny">{c.before}</td>
                              <td className="tiny">{c.after}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-end' }}>
                <div className="field" style={{ flex: 1 }}>
                  <label>复核附注</label>
                  <input
                    type="text"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="例如：已核对限值调整后事件切分，22:00 事件含 4 分钟未知空档单列"
                  />
                </div>
                <div className="row" style={{ marginTop: 18 }}>
                  <span className="tiny muted">操作人 {actor}</span>
                  <button
                    className="btn primary"
                    disabled={busy || active.status === 'FILED'}
                    onClick={async () => {
                      setBusy(true);
                      await actions.fileReport(active.draftId, note);
                      setBusy(false);
                      setCheck(null);
                    }}
                  >
                    {active.status === 'FILED' ? '已出具' : '核对并出具'}
                  </button>
                </div>
              </div>

              {active.status === 'FILED' && (
                <div className="note ok small">
                  已出具：{active.reviewedBy} · {active.reviewedAt ? fmtDateTime(active.reviewedAt) : ''} · {active.reviewNote || '无附注'}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="card card-pad">
        <div className="tiny muted">
          申报核对口径：自然日申报值只汇总实测与可插值超限时长；未知空档（采样断档、清洗、校准、旁路、故障）不计入上报值，
          但必须在附注中披露。补传读数或限值调整改变输入签名后，草稿自动转入复核；迟到处置记录只能补证，不能宣布超标已消失。
        </div>
      </div>
    </div>
  );
}

export type { DailyReportDraft };
