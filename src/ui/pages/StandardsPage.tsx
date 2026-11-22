import { useMemo, useState } from 'react';
import type { AppActions, AppState } from '../useAppState';
import type { Pollutant } from '../../domain/types';
import { STANDARD_LABEL } from '../format';
import { fmtDateTime, fmtNum, shortTime, trimId } from '../format';
import { dayStartMs } from '../../domain/time';

interface Props {
  state: AppState;
  actions: AppActions;
}

/** 标准适用库：排口 × 因子 × 时段 × 限值生效日期 */
export function StandardsPage({ state, actions }: Props) {
  const { dataset, pointCode, eventSummary, actor } = state;
  const [pollutant, setPollutant] = useState<Pollutant>('COD');
  const [limit, setLimit] = useState('');
  const [at, setAt] = useState('');
  const [basis, setBasis] = useState('澄川市地方加严排放限值');
  const [grade, setGrade] = useState('地方加严');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const rules = useMemo(
    () => dataset.standards.filter((s) => s.pointCode === pointCode).sort((a, b) => a.effectiveFrom - b.effectiveFrom),
    [dataset.standards, pointCode],
  );
  const windows = eventSummary?.windows.filter((w) => w.pollutant === pollutant) ?? [];
  const dayStart = dayStartMs(state.day);
  const defaultAt = new Date(dayStart + 12 * 3_600_000 + 8 * 3_600_000).toISOString().slice(0, 16);

  const submit = async () => {
    const value = Number(limit);
    const when = Date.parse(`${at || defaultAt}:00+08:00`);
    if (!Number.isFinite(value) || value <= 0) {
      actions.toast('warn', '请输入有效的限值 mg/L');
      return;
    }
    if (Number.isNaN(when)) {
      actions.toast('warn', '请选择生效时刻');
      return;
    }
    setBusy(true);
    await actions.addStandardRevision({ pollutant, limit: value, at: when, basis, grade, note });
    setLimit('');
    setNote('');
    setBusy(false);
  };

  return (
    <div className="stack">
      <div className="card">
        <div className="card-head">
          <h2>标准适用库</h2>
          <span className="sub">排口 × 因子 × 时段 × 限值生效日期；限值不写死在代码里</span>
          <div className="spacer" />
          <span className="badge neutral">{rules.length} 条规则</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>标准 ID</th>
                <th>因子</th>
                <th className="num">限值 mg/L</th>
                <th>生效</th>
                <th>失效</th>
                <th>依据 / 等级</th>
                <th>录入</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.standardId}>
                  <td className="mono tiny">{trimId(r.standardId, 26, 6)}</td>
                  <td className="tiny">{r.pollutant === 'COD' ? 'COD' : '氨氮'}</td>
                  <td className="num">{r.limitValue}</td>
                  <td className="mono tiny">{fmtDateTime(r.effectiveFrom)}</td>
                  <td className="mono tiny">{r.effectiveTo === null ? '持续有效' : fmtDateTime(r.effectiveTo)}</td>
                  <td className="tiny">
                    {r.basis}（{r.grade}）
                    <div className="muted tiny">{r.issuedBy}</div>
                  </td>
                  <td className="mono tiny">{fmtDateTime(r.createdAt)}</td>
                  <td className="tiny muted">{r.note}</td>
                </tr>
              ))}
              {rules.length === 0 && (
                <tr><td colSpan={8} className="muted small">该排口尚无标准规则，事件将使用厂站台账兜底限值（并标注待复核）。</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <div className="card-head">
            <h2>当日限值窗口</h2>
            <span className="sub">{state.day} · 按生效边界切分，窗口内限值唯一</span>
            <div className="spacer" />
            <select value={pollutant} onChange={(e) => setPollutant(e.target.value as Pollutant)} style={{ maxWidth: 120 }}>
              <option value="COD">COD</option>
              <option value="NH3N">氨氮</option>
            </select>
          </div>
          <div className="card-pad stack">
            {windows.length === 0 && <div className="small muted">请先推导事件，再查看当日窗口。</div>}
            {windows.map((w) => (
              <div key={`${w.standardId}-${w.from}`} className="row" style={{ justifyContent: 'space-between' }}>
                <div>
                  <strong className="mono">{w.limit} mg/L</strong> <span className="tiny muted">{w.standardId}</span>
                  <div className="tiny muted">{w.basis}（{w.grade}）</div>
                </div>
                <span className="mono tiny">
                  {shortTime(w.from)} → {shortTime(w.to)}
                </span>
              </div>
            ))}
            {windows.length > 1 && (
              <div className="note warn small">
                当日存在多个标准窗口（限值中途调整）。事件在这些时刻必须切开，申报按窗口分别披露。
              </div>
            )}
            {eventSummary && eventSummary.conflicts.length > 0 && (
              <div className="note bad small">
                同日同时段存在多条规则，已按确定性规则裁决；被压制的规则已在事件页列出。
              </div>
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h2>调整限值</h2>
            <span className="sub">生成新规则并把旧规则截止；事件与申报草稿随之失效</span>
          </div>
          <div className="card-pad stack">
            <div className="rule-row">
              <div className="field" style={{ minWidth: 110 }}>
                <label>因子</label>
                <select value={pollutant} onChange={(e) => setPollutant(e.target.value as Pollutant)}>
                  <option value="COD">COD</option>
                  <option value="NH3N">氨氮</option>
                </select>
              </div>
              <div className="field" style={{ minWidth: 120 }}>
                <label>新限值 mg/L</label>
                <input type="number" value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="例如 40" />
              </div>
              <div className="field" style={{ minWidth: 190 }}>
                <label>生效时刻（本地）</label>
                <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
              </div>
            </div>
            <div className="rule-row">
              <div className="field" style={{ flex: 1 }}>
                <label>依据</label>
                <input type="text" value={basis} onChange={(e) => setBasis(e.target.value)} />
              </div>
              <div className="field" style={{ minWidth: 120 }}>
                <label>等级</label>
                <input type="text" value={grade} onChange={(e) => setGrade(e.target.value)} />
              </div>
            </div>
            <div className="field">
              <label>说明</label>
              <input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="例如：按市局 2026 年加严通知，19:00 起执行 40 mg/L" />
            </div>
            <div className="row">
              <button className="btn primary" onClick={() => void submit()} disabled={busy || !dataset.points.length}>
                {busy ? '保存中…' : '保存限值调整'}
              </button>
              <span className="tiny muted">操作人：{actor}</span>
            </div>
            <div className="note small">
              调整限值会改变事件切分与申报值。所有基于旧限值的申报草稿将自动转入“待复核”，
              不能用旧事件或旧草稿替代当前证据。
            </div>
            <div className="note small">
              常用参照：{STANDARD_LABEL('GB18918')} 一级A COD 50 / 氨氮 5；一级B COD 60 / 氨氮 8。
            </div>
          </div>
        </div>
      </div>

      <div className="card card-pad">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div className="small muted">
            当日默认生效时刻建议：{defaultAt.replace('T', ' ')}（上海时间）。同起点多规则时按“起点更晚 → 录入更晚 → 编号”裁决，
            并在事件页显式披露被压制规则。
          </div>
          <span className="badge neutral">{fmtNum(rules.length, 0)} 条规则</span>
        </div>
      </div>
    </div>
  );
}
