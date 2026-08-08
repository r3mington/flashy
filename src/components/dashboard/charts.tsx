import type { BankPoint } from '../../stats'
import { useRef, useState } from 'react'
import { formatDuration } from '../../time'
import { formatBankDay, formatHour, useColumnPick } from './chartUtils'

const RANGES = [
  { days: 7, label: '7d' },
  { days: 30, label: '30d' },
  { days: 90, label: '90d' },
  { days: 365, label: '1y' },
]

export function RangeBar({ value, onChange }: { value: number; onChange: (days: number) => void }) {
  return (
    <div className="range-bar">
      <span className="range-label">Range</span>
      {RANGES.map((r) => (
        <button
          key={r.days}
          className={`range-btn${value === r.days ? ' active' : ''}`}
          onClick={() => onChange(r.days)}
        >
          {r.label}
        </button>
      ))}
    </div>
  )
}

export function Stat({
  label,
  value,
  suffix = '',
  hint,
}: {
  label: string
  value: number | string
  suffix?: string
  hint?: string
}) {
  return (
    <div className="stat-tile">
      <div className="stat-value">
        {value}
        {suffix}
      </div>
      <div className="stat-label">{label}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  )
}


export function BarChart({
  data,
  labelStart,
  labelEnd,
  accent = false,
  describe,
  hint,
}: {
  data: number[]
  labelStart: string
  labelEnd: string
  accent?: boolean
  /** Readout text for the tapped column. */
  describe?: (i: number, v: number) => string
  /** Shown until something is tapped. */
  hint?: string
}) {
  const max = Math.max(...data, 1)
  const W = 600
  const H = 120
  const gap = data.length > 120 ? 0.5 : 3
  const barW = (W - gap * (data.length - 1)) / data.length
  const { sel, ref, pick } = useColumnPick(data.length)

  return (
    <div className="chart-wrap">
      <div className="line-readout">
        {sel === null ? (
          <span className="line-readout-hint">{hint ?? 'Tap the chart to read a day'}</span>
        ) : (
          <span className="line-readout-total">
            {describe ? describe(sel, data[sel]) : String(data[sel])}
          </span>
        )}
      </div>
      <svg
        ref={ref}
        viewBox={`0 0 ${W} ${H}`}
        className="bar-chart pickable"
        preserveAspectRatio="none"
        onClick={(e) => pick(e.clientX)}
        onPointerMove={(e) => e.buttons === 1 && pick(e.clientX)}
      >
        {data.map((v, i) => {
          const h = v === 0 ? 2 : Math.max(4, (v / max) * (H - 20))
          const base = v === 0 ? 'bar zero' : accent ? 'bar accent' : 'bar'
          return (
            <rect
              key={i}
              x={i * (barW + gap)}
              y={H - h}
              width={barW}
              height={h}
              rx={barW > 3 ? 2 : 0}
              className={i === sel ? `${base} sel` : base}
            >
              <title>{v}</title>
            </rect>
          )
        })}
        {sel !== null && (
          <line
            x1={sel * (barW + gap) + barW / 2}
            x2={sel * (barW + gap) + barW / 2}
            y1={0}
            y2={H}
            className="line-marker"
          />
        )}
      </svg>
      <div className="chart-labels">
        <span>{labelStart}</span>
        <span>max {max}</span>
        <span>{labelEnd}</span>
      </div>
    </div>
  )
}

/** Bars split into coloured segments — used for grade mix and time split. */
export function StackedBarChart<K extends string>({
  series,
  keys,
  labels,
  colors,
  labelStart,
  labelEnd,
  format = (v) => String(v),
}: {
  series: (Record<K, number> & { day: number })[]
  keys: readonly K[]
  /** Display names for each key, in the same order — used in the tap readout. */
  labels: readonly string[]
  colors: string[]
  labelStart: string
  labelEnd: string
  format?: (v: number) => string
}) {
  const totals = series.map((p) => keys.reduce((a, k) => a + p[k], 0))
  const max = Math.max(...totals, 1)
  const W = 600
  const H = 120
  const gap = series.length > 120 ? 0.5 : 3
  const barW = (W - gap * (series.length - 1)) / series.length
  const { sel, ref, pick } = useColumnPick(series.length)
  const point = sel === null ? null : series[sel]

  return (
    <div className="chart-wrap">
      <div className="line-readout">
        {point === null ? (
          <span className="line-readout-hint">Tap the chart to read a day</span>
        ) : (
          <>
            <span className="line-readout-day">
              {new Date(point.day).toLocaleDateString(undefined, {
                month: 'short',
                day: 'numeric',
              })}
            </span>
            <span className="line-readout-total">{format(totals[sel!])}</span>
            {keys.map((k, ki) => (
              <span key={k}>
                <i className="dot" style={{ background: colors[ki] }} />
                {format(point[k])} {labels[ki]}
              </span>
            ))}
          </>
        )}
      </div>
      <svg
        ref={ref}
        viewBox={`0 0 ${W} ${H}`}
        className="bar-chart pickable"
        preserveAspectRatio="none"
        onClick={(e) => pick(e.clientX)}
        onPointerMove={(e) => e.buttons === 1 && pick(e.clientX)}
      >
        {series.map((p, i) => {
          const total = totals[i]
          if (total === 0) {
            return (
              <rect
                key={i}
                x={i * (barW + gap)}
                y={H - 2}
                width={barW}
                height={2}
                className="bar zero"
              />
            )
          }
          let y = H
          return (
            <g key={i}>
              <title>{`${new Date(p.day).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · ${format(total)}`}</title>
              {keys.map((k, ki) => {
                const h = (p[k] / max) * (H - 20)
                y -= h
                return h <= 0 ? null : (
                  <rect
                    key={k}
                    x={i * (barW + gap)}
                    y={y}
                    width={barW}
                    height={h}
                    fill={colors[ki]}
                    opacity={sel === null || sel === i ? 0.9 : 0.45}
                  />
                )
              })}
            </g>
          )
        })}
        {sel !== null && (
          <line
            x1={sel * (barW + gap) + barW / 2}
            x2={sel * (barW + gap) + barW / 2}
            y1={0}
            y2={H}
            className="line-marker"
          />
        )}
      </svg>
      <div className="chart-labels">
        <span>{labelStart}</span>
        <span>max {format(max)}</span>
        <span>{labelEnd}</span>
      </div>
    </div>
  )
}


const PIPELINE: { key: keyof BankPoint; label: string; color: string }[] = [
  { key: 'new', label: 'new', color: 'var(--accent)' },
  { key: 'learning', label: 'learning', color: 'var(--amber)' },
  { key: 'review', label: 'review', color: 'var(--green)' },
  { key: 'known', label: 'known', color: 'var(--ink-3)' },
]

/** Stacked area of the four card states over time: words flow from new
 *  through learning and review into known. */
export function PipelineChart({ series, today }: { series: BankPoint[]; today: number }) {
  const [sel, setSel] = useState<number | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const W = 600
  const H = 140
  const pad = 8
  const max = Math.max(...series.map((p) => p.total), 1)
  const n = series.length
  const x = (i: number) => (n === 1 ? W / 2 : (i / (n - 1)) * W)
  const y = (v: number) => H - pad - (v / max) * (H - 2 * pad)
  const cur = sel ?? n - 1
  const point = series[cur]

  // Cumulative upper edge of each band, bottom band first.
  const tops = series.map((p) => {
    let acc = 0
    return PIPELINE.map(({ key }) => (acc += p[key] as number))
  })

  const pick = (clientX: number) => {
    const el = svgRef.current
    if (!el || n < 2) return
    const rect = el.getBoundingClientRect()
    const frac = (clientX - rect.left) / rect.width
    setSel(Math.max(0, Math.min(n - 1, Math.round(frac * (n - 1)))))
  }

  return (
    <div className="chart-wrap">
      <div className="line-readout">
        <span className="line-readout-day">{formatBankDay(point.day, today)}</span>
        <span className="line-readout-total">{point.total} words</span>
        {PIPELINE.map(({ key, label, color }) => (
          <span key={key}>
            <i className="dot" style={{ background: color }} />
            {point[key]} {label}
          </span>
        ))}
        {/* Reading a past day looks exactly like reading the current one, and
            the axis underneath still says "today" — so say plainly that these
            are historical numbers, and give the way back. */}
        {cur !== n - 1 && (
          <button className="line-readout-reset" onClick={() => setSel(null)}>
            back to today
          </button>
        )}
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="line-chart pipeline"
        preserveAspectRatio="none"
        onClick={(e) => pick(e.clientX)}
        onPointerMove={(e) => e.buttons === 1 && pick(e.clientX)}
      >
        {PIPELINE.map(({ key, color }, bi) => {
          const upper = series.map((_, i) => `${x(i)},${y(tops[i][bi])}`).join(' ')
          const lower = series
            .map((_, i) => `${x(n - 1 - i)},${y(bi === 0 ? 0 : tops[n - 1 - i][bi - 1])}`)
            .join(' ')
          return <polygon key={key} points={`${upper} ${lower}`} fill={color} opacity={0.75} />
        })}
        <line x1={x(cur)} x2={x(cur)} y1={0} y2={H} className="line-marker" />
      </svg>
      <div className="chart-labels">
        <span>{formatBankDay(series[0].day, today)}</span>
        <span>max {max}</span>
        <span>today</span>
      </div>
    </div>
  )
}

export function Heatmap({
  days,
  today,
}: {
  days: { day: number; reviews: number; seconds: number }[]
  today: number
}) {
  const max = Math.max(...days.map((d) => d.reviews), 1)
  // Columns are calendar weeks; the first entry is always a Sunday.
  const weeks: (typeof days)[] = []
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7))
  const activeDays = days.filter((d) => d.reviews > 0 || d.seconds > 0).length
  const [sel, setSel] = useState<number | null>(null)
  const picked = sel === null ? null : days.find((d) => d.day === sel)

  return (
    <div className="chart-wrap">
      <div className="line-readout">
        {picked ? (
          <>
            <span className="line-readout-day">{formatBankDay(picked.day, today)}</span>
            <span className="line-readout-total">
              {picked.reviews} {picked.reviews === 1 ? 'review' : 'reviews'}
            </span>
            {picked.seconds > 0 && <span>{formatDuration(picked.seconds)}</span>}
          </>
        ) : (
          <span className="line-readout-total">
            {activeDays} active {activeDays === 1 ? 'day' : 'days'} of {days.length}
          </span>
        )}
      </div>
      <div className="heatmap">
        {weeks.map((week, wi) => (
          <div className="heat-col" key={wi}>
            {week.map((d) => {
              const level =
                d.reviews === 0
                  ? d.seconds > 0
                    ? 1
                    : 0
                  : Math.min(4, 1 + Math.floor((d.reviews / max) * 3.99))
              return (
                <button
                  type="button"
                  key={d.day}
                  onClick={() => setSel((s) => (s === d.day ? null : d.day))}
                  className={`heat-cell l${level}${d.day === today ? ' is-today' : ''}${d.day === sel ? ' is-sel' : ''}`}
                  title={`${new Date(d.day).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · ${d.reviews} reviews${d.seconds > 0 ? ` · ${formatDuration(d.seconds)}` : ''}`}
                />
              )
            })}
          </div>
        ))}
      </div>
      <div className="chart-labels">
        <span>12 weeks ago</span>
        <span className="heat-scale">
          less
          {[0, 1, 2, 3, 4].map((l) => (
            <i className={`heat-cell l${l}`} key={l} />
          ))}
          more
        </span>
        <span>today</span>
      </div>
    </div>
  )
}


export function HourChart({ hours }: { hours: { hour: number; count: number; pass: number }[] }) {
  const max = Math.max(...hours.map((h) => h.count), 1)
  const [sel, setSel] = useState<number | null>(null)
  const picked = sel === null ? null : hours[sel]
  return (
    <div className="chart-wrap">
      <div className="line-readout">
        {picked ? (
          <>
            <span className="line-readout-day">{formatHour(picked.hour)}</span>
            <span className="line-readout-total">
              {picked.count} {picked.count === 1 ? 'answer' : 'answers'}
            </span>
            {picked.count > 0 && (
              <span>{Math.round((picked.pass / picked.count) * 100)}% correct</span>
            )}
          </>
        ) : (
          <span className="line-readout-hint">Tap an hour to read its numbers</span>
        )}
      </div>
      <div className="hour-chart">
        {hours.map((h) => (
          <button
            type="button"
            className={`hour-col${h.hour === sel ? ' is-sel' : ''}`}
            key={h.hour}
            onClick={() => setSel((s) => (s === h.hour ? null : h.hour))}
            title={`${formatHour(h.hour)} · ${h.count} answers${h.count > 0 ? ` · ${Math.round((h.pass / h.count) * 100)}% correct` : ''}`}
          >
            <div className="hour-bar" style={{ height: `${(h.count / max) * 100}%` }} />
          </button>
        ))}
      </div>
      <div className="chart-labels">
        <span>12am</span>
        <span>12pm</span>
        <span>11pm</span>
      </div>
    </div>
  )
}

export function Histogram({ buckets }: { buckets: { label: string; count: number; mature: boolean }[] }) {
  const max = Math.max(...buckets.map((b) => b.count), 1)
  return (
    <div className="chart-wrap">
      <div className="histogram">
        {buckets.map((b) => (
          <div className="hist-col" key={b.label}>
            <div className="hist-count">{b.count}</div>
            <div className="hist-track">
              <div
                className={`hist-bar${b.mature ? ' mature' : ''}`}
                style={{ height: `${(b.count / max) * 100}%` }}
              />
            </div>
            <div className="hist-label">{b.label}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

export function StateBar({
  states,
  total,
}: {
  states: { new: number; learning: number; review: number; known: number }
  total: number
}) {
  if (total === 0) return <div className="state-track empty-track" />
  return (
    <div className="state-track">
      <div className="seg new" style={{ width: `${(states.new / total) * 100}%` }} />
      <div className="seg learning" style={{ width: `${(states.learning / total) * 100}%` }} />
      <div className="seg review" style={{ width: `${(states.review / total) * 100}%` }} />
      <div className="seg known" style={{ width: `${(states.known / total) * 100}%` }} />
    </div>
  )
}

