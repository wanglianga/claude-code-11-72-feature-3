/**
 * 事件时间线：把标准窗口、超标区间、证据分段（实测/插值/未知空档）画在同一条时间轴上。
 *
 * 视图范围：默认聚焦到当日事件区间（前后各留 20 分钟），避免 40 秒级事件在 24 小时轴上不可见；
 * 可切换“全天”。所有时间为对齐时间轴毫秒，显示按 Asia/Shanghai。
 */

import { useMemo, useState } from 'react';
import type { DayEventSummary, ExceedanceEvent, Pollutant } from '../../domain/types';
import { dayEndMs, dayStartMs, fmtTime } from '../../domain/time';

interface Props {
  summary: DayEventSummary;
  pollutant: Pollutant;
  selectedEventId?: string | null;
  onSelectEvent?: (eventId: string | null) => void;
}

export function EventTimeline({ summary, pollutant, selectedEventId, onSelectEvent }: Props) {
  const [zoom, setZoom] = useState<'focus' | 'day'>('focus');
  const windows = summary.windows.filter((w) => w.pollutant === pollutant);
  const events = summary.events.filter((e) => e.pollutant === pollutant);
  const gaps = summary.gaps.filter((g) => g.pollutant === pollutant);
  const stateBlocks = gaps.filter((g) => g.kind === 'EXCLUDED_STATE' || g.kind === 'NO_EFFECTIVE_STATE');
  const dayFrom = dayStartMs(summary.day);
  const dayTo = dayEndMs(summary.day);

  const range = useMemo(() => {
    if (zoom === 'day' || events.length === 0) return { from: dayFrom, to: dayTo };
    const starts = events.map((e) => e.startAt);
    const ends = events.map((e) => (e.endAt ?? e.startAt + Math.max(1, e.spanSeconds * 1000)));
    const pad = 20 * 60_000;
    const from = Math.max(dayFrom, Math.min(...starts) - pad);
    const to = Math.min(dayTo, Math.max(...ends) + pad);
    return { from, to: Math.max(to, from + 10 * 60_000) };
  }, [zoom, events, dayFrom, dayTo]);

  const span = Math.max(1, range.to - range.from);
  const pct = (t: number) => `${Math.max(0, Math.min(100, ((t - range.from) / span) * 100))}%`;
  const width = (a: number, b: number) => `${Math.max(0.05, Math.min(100, ((Math.min(b, range.to) - Math.max(a, range.from)) / span) * 100))}%`;
  const visible = (a: number, b: number) => b > range.from && a < range.to;

  const ticks = useMemo(() => {
    const count = 8;
    return Array.from({ length: count + 1 }, (_, i) => range.from + (span * i) / count);
  }, [range.from, span]);

  return (
    <div className="event-timeline">
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 2 }}>
        <div className="evidence-legend">
          <span>
            <i style={{ background: 'var(--danger)' }} /> 实测超限
          </span>
          <span>
            <i style={{ backgroundImage: 'repeating-linear-gradient(45deg, rgba(163,49,44,.85), rgba(163,49,44,.85) 3px, rgba(163,49,44,.3) 3px, rgba(163,49,44,.3) 7px)' }} />{' '}
            插值超限
          </span>
          <span>
            <i style={{ background: 'repeating-linear-gradient(90deg, rgba(215,178,106,.95), rgba(215,178,106,.95) 2px, transparent 2px, transparent 6px)' }} />{' '}
            未知空档（不判定持续超标）
          </span>
          <span>
            <i style={{ background: 'rgba(184,164,143,.55)' }} /> 清洗/校准/旁路/故障
          </span>
          <span>
            <i style={{ background: 'rgba(39,93,140,.18)' }} /> 标准窗口
          </span>
          <span>
            <i style={{ background: 'var(--info)', height: 10, width: 2 }} /> 限值调整
          </span>
        </div>
        <div className="row">
          <span className="tiny muted mono">
            {fmtTime(range.from)} – {fmtTime(range.to)}
          </span>
          <button className={`btn small ${zoom === 'focus' ? 'primary' : ''}`} onClick={() => setZoom('focus')}>
            聚焦事件
          </button>
          <button className={`btn small ${zoom === 'day' ? 'primary' : ''}`} onClick={() => setZoom('day')}>
            全天
          </button>
        </div>
      </div>

      <div className="timeline-row">
        <div className="timeline-label">
          <strong>标准窗口</strong>
          <span>{windows.length} 段</span>
        </div>
        <div className="timeline-track short">
          {windows
            .filter((w) => visible(w.from, w.to))
            .map((w, i) => (
              <div
                key={w.standardId}
                className={`timeline-span ${i % 2 === 0 ? 'limit-a' : 'limit-b'}`}
                style={{ left: pct(w.from), width: width(w.from, w.to) }}
                title={`${w.limit} mg/L · ${w.basis}（${w.grade}） ${fmtTime(w.from)}–${fmtTime(w.to)}`}
              />
            ))}
          {windows.map((w) => (
            <span
              key={`lbl-${w.standardId}`}
              className="tiny mono"
              style={{
                position: 'absolute',
                left: `calc(${pct(w.from)} + 4px)`,
                top: 2,
                color: 'var(--info)',
                fontSize: 10,
              }}
            >
              {w.limit}
            </span>
          ))}
          {windows.slice(1).map((w) => (
            <div key={`cut-${w.standardId}`} className="timeline-tick limit-cut" style={{ left: pct(w.from) }} title={`限值 ${w.limit} 起生效`} />
          ))}
        </div>
      </div>

      <div className="timeline-row">
        <div className="timeline-label">
          <strong>排除状态</strong>
          <span>插值链终止</span>
        </div>
        <div className="timeline-track short">
          {stateBlocks
            .filter((g) => visible(g.from, g.to))
            .map((g) => (
              <div
                key={g.gapId}
                className="timeline-span state-cut"
                style={{ left: pct(g.from), width: width(g.from, g.to) }}
                title={`${g.kind} ${(g.seconds / 60).toFixed(1)} 分钟`}
              />
            ))}
        </div>
      </div>

      <div className="timeline-row">
        <div className="timeline-label">
          <strong>超标事件</strong>
          <span>{events.length} 个</span>
        </div>
        <div className="timeline-track">
          {events
            .filter((e) => visible(e.startAt, (e.evidence.segments[e.evidence.segments.length - 1]?.to ?? e.startAt) + 1))
            .map((e) => (
              <EventSpans key={e.eventId} event={e} pct={pct} width={width} selected={selectedEventId === e.eventId} onSelect={onSelectEvent} />
            ))}
          {gaps
            .filter((g) => g.insideEvent)
            .map((g) => (
              <div key={`gapmark-${g.gapId}`} className="timeline-tick gap-cut" style={{ left: pct(g.from) }} title="事件内采样空档" />
            ))}
        </div>
      </div>

      <div className="timeline-axis" style={{ paddingLeft: 84 }}>
        {ticks.map((t, i) => (
          <span key={i}>{fmtTime(t).slice(0, 5)}</span>
        ))}
      </div>
      <div className="tiny muted">
        点击事件条选定该事件；证据段严格按“实测 / 插值 / 未知”区分，未知段不计入超标时长。
        {zoom === 'focus' && events.length > 0 && ' 当前聚焦到事件区间（前后各 20 分钟），可切“全天”。'}
      </div>
    </div>
  );
}

function EventSpans({
  event,
  pct,
  width,
  selected,
  onSelect,
}: {
  event: ExceedanceEvent;
  pct: (t: number) => string;
  width: (a: number, b: number) => string;
  selected: boolean;
  onSelect?: (id: string | null) => void;
}) {
  const spans = event.evidence.segments;
  const end = spans[spans.length - 1]?.to ?? event.startAt;
  return (
    <div
      style={{ position: 'absolute', inset: 0, cursor: 'pointer' }}
      onClick={() => onSelect?.(selected ? null : event.eventId)}
      title={`${event.eventId} ${event.status}`}
    >
      <div
        className="timeline-span exceed"
        style={{
          left: pct(event.startAt),
          width: width(event.startAt, end),
          outline: selected ? '2px solid var(--accent)' : 'none',
        }}
      />
      {spans.map((s) => (
        <div
          key={s.evidenceId}
          className={
            s.kind === 'MEASURED'
              ? 'timeline-span ev-measured'
              : s.kind === 'INTERPOLATED'
                ? 'timeline-span ev-interpolated'
                : 'timeline-span ev-gap'
          }
          style={{ left: pct(s.from), width: width(s.from, s.to) }}
          title={`${s.kind} ${fmtTime(s.from)}–${fmtTime(s.to)}（${s.seconds.toFixed(1)} s）`}
        />
      ))}
    </div>
  );
}
