import { useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, type Card } from '../db'
import { useSettings } from '../useSettings'

const DAY = 24 * 60 * 60 * 1000

function startOfDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function Dashboard() {
  const settings = useSettings()
  const data = useLiveQuery(async () => {
    const [cards, reviews, decks, snapshots] = await Promise.all([
      db.cards.toArray(),
      db.reviews.toArray(),
      db.decks.toArray(),
      db.snapshots.toArray(),
    ])
    return { cards, reviews, decks, snapshots }
  })

  if (!data) return null
  const { cards, reviews, decks, snapshots } = data
  const today = startOfDay(Date.now())

  // Reviews per day, last 30 days
  const perDay = new Map<number, number>()
  for (const r of reviews) {
    const day = startOfDay(r.ts)
    perDay.set(day, (perDay.get(day) ?? 0) + 1)
  }
  const last30 = Array.from({ length: 30 }, (_, i) => {
    const day = today - (29 - i) * DAY
    return { day, count: perDay.get(day) ?? 0 }
  })

  // Streak: consecutive days ending today (or yesterday) with ≥1 review
  let streak = 0
  let cursor = perDay.has(today) ? today : today - DAY
  while (perDay.has(cursor)) {
    streak++
    cursor -= DAY
  }

  // Retention: % of non-"again" grades on review-state cards, last 30 days
  const recent = reviews.filter((r) => r.ts >= today - 29 * DAY)
  const retention =
    recent.length > 0
      ? Math.round((recent.filter((r) => r.grade !== 'again').length / recent.length) * 100)
      : null

  // Due forecast, next 30 days
  const next30 = dueForecast(cards, today, 30)

  const known = cards.filter((c) => c.known).length
  // Word bank over time: snapshots carried forward, today shown live.
  const bankSeries = buildBankSeries(snapshots, cards.length, known, today)
  const historyDays = new Set(snapshots.map((s) => s.day)).size
  const states = {
    new: cards.filter((c) => c.state === 'new' && !c.known).length,
    learning: cards.filter((c) => c.state === 'learning' && !c.known).length,
    review: cards.filter((c) => c.state === 'review' && !c.known).length,
    known,
  }
  const reviewsToday = perDay.get(today) ?? 0
  const goal = settings.dailyGoal
  const goalMet = goal > 0 && reviewsToday >= goal

  // Per-deck due forecast, next 14 days
  const deckForecasts = decks.map((deck) => {
    const deckCards = cards.filter((c) => c.deckId === deck.id)
    return { deck, data: dueForecast(deckCards, today, 14) }
  })

  return (
    <>
      <div className="page-head">
        <h1>Dashboard</h1>
      </div>

      <div className="stat-grid">
        <Stat label="Cards" value={cards.length} />
        <Stat label="Known" value={known} suffix={known > 0 ? ' ✓' : ''} />
        <Stat label="Reviews today" value={reviewsToday} />
        <Stat label="Day streak" value={streak} suffix={streak > 0 ? ' 🔥' : ''} />
        <Stat label="Retention (30d)" value={retention === null ? '—' : `${retention}%`} />
      </div>

      {goal > 0 && (
        <div className="goal-wrap dash-goal">
          <div className="goal-label">
            Daily goal · {reviewsToday}/{goal}
            {goalMet ? ' — met! 🎯' : ''}
          </div>
          <div className="progress-track goal-track">
            <div
              className="progress-fill"
              style={{ width: `${Math.min(100, (reviewsToday / goal) * 100)}%` }}
            />
          </div>
        </div>
      )}

      <section className="dash-section">
        <div className="eyebrow">Word bank · over time</div>
        <LineChart series={bankSeries} today={today} />
        {historyDays < 2 && (
          <p className="note">
            Your word bank is tracked from today — this chart fills in as you keep adding words and
            open the app on more days.
          </p>
        )}
      </section>

      <section className="dash-section">
        <div className="eyebrow">Reviews · last 30 days</div>
        <BarChart data={last30.map((d) => d.count)} labelStart="30d ago" labelEnd="today" />
      </section>

      <section className="dash-section">
        <div className="eyebrow">Due forecast · next 30 days</div>
        <BarChart
          data={next30.map((d) => d.count)}
          labelStart="today"
          labelEnd="in 30d"
          accent
        />
      </section>

      {deckForecasts.length > 0 && (
        <section className="dash-section">
          <div className="eyebrow">Due by deck · next 14 days</div>
          <div className="deck-forecasts">
            {deckForecasts.map(({ deck, data: fc }) => (
              <div className="deck-forecast" key={deck.id}>
                <div className="deck-forecast-name">
                  {deck.name}
                  <span className="deck-forecast-total">
                    {fc.reduce((a, d) => a + d.count, 0)} due
                  </span>
                </div>
                <BarChart data={fc.map((d) => d.count)} labelStart="today" labelEnd="in 14d" accent />
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="dash-section">
        <div className="eyebrow">Card states</div>
        <StateBar states={states} total={cards.length} />
        <div className="state-legend">
          <span>
            <i className="dot new" /> New · {states.new}
          </span>
          <span>
            <i className="dot learning" /> Learning · {states.learning}
          </span>
          <span>
            <i className="dot review" /> Review · {states.review}
          </span>
          <span>
            <i className="dot known" /> Known · {states.known}
          </span>
        </div>
      </section>

      {reviews.length === 0 && (
        <p className="note">
          No reviews recorded yet — stats fill in as you study. Only sessions from now on are
          tracked.
        </p>
      )}
    </>
  )
}

function Stat({ label, value, suffix = '' }: { label: string; value: number | string; suffix?: string }) {
  return (
    <div className="stat-tile">
      <div className="stat-value">
        {value}
        {suffix}
      </div>
      <div className="stat-label">{label}</div>
    </div>
  )
}

function BarChart({
  data,
  labelStart,
  labelEnd,
  accent = false,
}: {
  data: number[]
  labelStart: string
  labelEnd: string
  accent?: boolean
}) {
  const max = Math.max(...data, 1)
  const W = 600
  const H = 120
  const gap = 3
  const barW = (W - gap * (data.length - 1)) / data.length

  return (
    <div className="chart-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} className="bar-chart" preserveAspectRatio="none">
        {data.map((v, i) => {
          const h = v === 0 ? 2 : Math.max(4, (v / max) * (H - 20))
          return (
            <g key={i}>
              <rect
                x={i * (barW + gap)}
                y={H - h}
                width={barW}
                height={h}
                rx={2}
                className={v === 0 ? 'bar zero' : accent ? 'bar accent' : 'bar'}
              >
                <title>{v}</title>
              </rect>
            </g>
          )
        })}
      </svg>
      <div className="chart-labels">
        <span>{labelStart}</span>
        <span>max {max}</span>
        <span>{labelEnd}</span>
      </div>
    </div>
  )
}

interface BankPoint {
  day: number
  total: number
  known: number
}

/** Continuous daily word-bank series: snapshots carried forward across gap
 *  days, capped to the last 90 days, with today shown from the live counts. */
function buildBankSeries(
  snapshots: { day: number; total: number; known: number }[],
  liveTotal: number,
  liveKnown: number,
  today: number,
): BankPoint[] {
  if (snapshots.length === 0) return [{ day: today, total: liveTotal, known: liveKnown }]
  const sorted = [...snapshots].sort((a, b) => a.day - b.day)
  const byDay = new Map(sorted.map((s) => [s.day, s]))
  const start = Math.max(sorted[0].day, today - 89 * DAY)
  // Carry forward from the last snapshot on or before the window start.
  let lastTotal = sorted[0].total
  let lastKnown = sorted[0].known
  for (const s of sorted) {
    if (s.day <= start) {
      lastTotal = s.total
      lastKnown = s.known
    }
  }
  const out: BankPoint[] = []
  for (let d = start; d <= today; d += DAY) {
    const s = byDay.get(d)
    if (s) {
      lastTotal = s.total
      lastKnown = s.known
    }
    out.push(
      d === today
        ? { day: d, total: liveTotal, known: liveKnown }
        : { day: d, total: lastTotal, known: lastKnown },
    )
  }
  return out
}

function formatBankDay(day: number, today: number): string {
  if (day === today) return 'Today'
  if (day === today - DAY) return 'Yesterday'
  return new Date(day).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: startOfDay(Date.now()) - day > 300 * DAY ? 'numeric' : undefined,
  })
}

function LineChart({ series, today }: { series: BankPoint[]; today: number }) {
  // Tap/hover a day to read its values; defaults to the latest day.
  const [sel, setSel] = useState<number | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const W = 600
  const H = 120
  const pad = 10
  const max = Math.max(...series.map((p) => p.total), 1)
  const n = series.length
  const x = (i: number) => (n === 1 ? W / 2 : (i / (n - 1)) * W)
  const y = (v: number) => H - pad - (v / max) * (H - 2 * pad)
  const line = (key: 'total' | 'known') => series.map((p, i) => `${x(i)},${y(p[key])}`).join(' ')
  const area = `${x(0)},${H} ${line('total')} ${x(n - 1)},${H}`
  const cur = sel ?? n - 1
  const point = series[cur]

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
        <span>
          <i className="dot" style={{ background: 'var(--accent)' }} /> {point.total} total
        </span>
        <span>
          <i className="dot known" /> {point.known} known
        </span>
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="line-chart"
        preserveAspectRatio="none"
        onClick={(e) => pick(e.clientX)}
        onPointerMove={(e) => e.buttons === 1 && pick(e.clientX)}
      >
        <polygon points={area} className="line-area" />
        <polyline points={line('total')} className="line total" />
        <polyline points={line('known')} className="line known" />
        {/* Selected-day marker: vertical guide + a dot on each series. */}
        <line x1={x(cur)} x2={x(cur)} y1={0} y2={H} className="line-marker" />
        <circle cx={x(cur)} cy={y(point.total)} r={3.5} className="line-dot total" />
        <circle cx={x(cur)} cy={y(point.known)} r={3.5} className="line-dot known" />
      </svg>
      <div className="chart-labels">
        <span>{formatBankDay(series[0].day, today)}</span>
        <span>max {max}</span>
        <span>today</span>
      </div>
    </div>
  )
}

function StateBar({
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

/** Due cards per day for the next `days` days; overdue cards land on day 0. */
function dueForecast(cards: Card[], today: number, days: number) {
  const dueByDay = new Map<number, number>()
  let backlog = 0
  for (const c of cards) {
    if (c.state === 'new' || c.known) continue
    if (c.due <= Date.now()) {
      backlog++
      continue
    }
    const day = startOfDay(c.due)
    dueByDay.set(day, (dueByDay.get(day) ?? 0) + 1)
  }
  return Array.from({ length: days }, (_, i) => {
    const day = today + i * DAY
    return { day, count: (dueByDay.get(day) ?? 0) + (i === 0 ? backlog : 0) }
  })
}
