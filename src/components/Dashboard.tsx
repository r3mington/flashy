import { useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, type Card, type Review } from '../db'
import { useSettings } from '../useSettings'
import {
  DAY,
  MATURE_DAYS,
  type BankPoint,
  buildBankSeries,
  countByDay,
  currentStreak,
  deckStats,
  dueForecast,
  formatAgo,
  formatDuration,
  inferSessions,
  leeches,
  longestStreak,
  maturity,
  nextMilestone,
  retention,
  secondsPerAnswer,
  startOfDay,
  studySecondsByDay,
} from '../stats'

const RANGES = [
  { days: 7, label: '7d' },
  { days: 30, label: '30d' },
  { days: 90, label: '90d' },
  { days: 365, label: '1y' },
] as const

const GRADES = ['again', 'hard', 'good', 'easy'] as const
const GRADE_LABEL: Record<(typeof GRADES)[number], string> = {
  again: 'Again',
  hard: 'Hard',
  good: 'Good',
  easy: 'Easy',
}

interface Props {
  onOpenDeck?: (deckId: number) => void
  onStudy?: (deckId: number) => void
  onDrill?: (cardIds: number[]) => void
  onOpenStory?: (deckId: number, storyId: number) => void
}

export function Dashboard({ onOpenDeck, onStudy, onDrill, onOpenStory }: Props) {
  const settings = useSettings()
  const [rangeDays, setRangeDays] = useState<number>(30)
  const [deckFilter, setDeckFilter] = useState<number | 'all'>('all')

  const data = useLiveQuery(async () => {
    const [cards, reviews, decks, snapshots, stories, reading, listening] = await Promise.all([
      db.cards.toArray(),
      db.reviews.toArray(),
      db.decks.toArray(),
      db.snapshots.toArray(),
      db.stories.toArray(),
      db.reading.toArray(),
      db.listening.toArray(),
    ])
    return { cards, reviews, decks, snapshots, stories, reading, listening }
  })

  const stats = useMemo(() => (data ? compute(data, rangeDays, deckFilter) : null), [
    data,
    rangeDays,
    deckFilter,
  ])

  if (!data || !stats) return null
  const { decks } = data
  const scoped = deckFilter !== 'all'
  const deckName = scoped ? decks.find((d) => d.id === deckFilter)?.name : null

  return (
    <>
      <div className="page-head">
        <h1>Dashboard</h1>
      </div>

      {decks.length > 1 && (
        <div className="filter-chips">
          <button
            className={`filter-chip${deckFilter === 'all' ? ' active' : ''}`}
            onClick={() => setDeckFilter('all')}
          >
            All decks
          </button>
          {decks.map((d) => (
            <button
              key={d.id}
              className={`filter-chip${deckFilter === d.id ? ' active' : ''}`}
              onClick={() => setDeckFilter(d.id)}
            >
              {d.name}
            </button>
          ))}
        </div>
      )}

      <TodayCard
        stats={stats}
        goal={settings.dailyGoal}
        deckId={scoped ? (deckFilter as number) : stats.topDueDeckId}
        onStudy={onStudy}
        onDrill={onDrill}
      />

      <div className="stat-grid">
        <Stat label="Words" value={stats.cards.length} hint={`${stats.states.known} known`} />
        <Stat
          label="Reviews today"
          value={stats.reviewsToday}
          hint={stats.studyTodaySecs > 0 ? formatDuration(stats.studyTodaySecs) : undefined}
        />
        <Stat
          label="Day streak"
          value={stats.streak}
          suffix={stats.streak > 0 ? ' 🔥' : ''}
          hint={stats.bestStreak > stats.streak ? `best ${stats.bestStreak}` : undefined}
        />
        <Stat
          label={`Retention (${rangeDays}d)`}
          value={stats.ret.overall === null ? '—' : `${stats.ret.overall}%`}
          hint={stats.ret.overallCount > 0 ? `${stats.ret.overallCount} answers` : undefined}
        />
        <Stat
          label="Time invested"
          value={formatDuration(stats.totalTimeSecs)}
          hint="reviewing · reading · listening"
        />
      </div>

      <RangeBar value={rangeDays} onChange={setRangeDays} />

      {/* ---------- consistency ---------- */}

      <section className="dash-section">
        <div className="eyebrow">Activity · last 12 weeks</div>
        <Heatmap days={stats.heatmap} today={stats.today} />
      </section>

      {stats.byHour.some((h) => h.count > 0) && (
        <section className="dash-section">
          <div className="eyebrow">
            When you study
            {stats.bestHour !== null && (
              <span className="eyebrow-note">
                sharpest around {formatHour(stats.bestHour.hour)} · {stats.bestHour.accuracy}%
                correct
              </span>
            )}
          </div>
          <HourChart hours={stats.byHour} />
        </section>
      )}

      {/* ---------- growth ---------- */}

      {!scoped && (
        <section className="dash-section">
          <div className="eyebrow">Word bank · the learning pipeline</div>
          <PipelineChart series={stats.bankSeries} today={stats.today} />
          {stats.historyDays < 2 && (
            <p className="note">
              History is recorded once a day from the first time you opened the app — this fills in
              as you keep coming back.
            </p>
          )}
        </section>
      )}

      <section className="dash-section">
        <div className="eyebrow">
          Words added
          <span className="eyebrow-note">
            {stats.addedInRange} in the last {rangeDays}d · {stats.addedPerWeek}/week
          </span>
        </div>
        <BarChart
          data={stats.addedSeries}
          labelStart={`${rangeDays}d ago`}
          labelEnd="today"
          describe={(i, v) =>
            `${formatBankDay(stats.days[i], stats.today)} · ${v} ${v === 1 ? 'word' : 'words'} added`
          }
        />
        {stats.projection && (
          <p className="note">
            At this pace you reach <strong>{stats.projection.target} words</strong> around{' '}
            {stats.projection.when}.
          </p>
        )}
      </section>

      {/* ---------- effort ---------- */}

      <section className="dash-section">
        <div className="eyebrow">
          Reviews per day
          <span className="eyebrow-note">
            {stats.reviewsInRange} answers · {stats.activeDays} active days
          </span>
        </div>
        <StackedBarChart
          series={stats.gradeSeries}
          keys={GRADES}
          labels={GRADES.map((g) => GRADE_LABEL[g])}
          colors={['var(--red)', 'var(--amber)', 'var(--green)', 'var(--violet)']}
          labelStart={`${rangeDays}d ago`}
          labelEnd="today"
        />
        <div className="state-legend">
          {GRADES.map((g, i) => (
            <span key={g}>
              <i
                className="dot"
                style={{
                  background: ['var(--red)', 'var(--amber)', 'var(--green)', 'var(--violet)'][i],
                }}
              />
              {GRADE_LABEL[g]} · {stats.gradeTotals[g]}
              {stats.reviewsInRange > 0 &&
                ` (${Math.round((stats.gradeTotals[g] / stats.reviewsInRange) * 100)}%)`}
            </span>
          ))}
        </div>
        {stats.gradeTotals.easy / Math.max(1, stats.reviewsInRange) > 0.45 && (
          <p className="note">
            Nearly half your answers are “Easy” — the scheduler may be pushing intervals out faster
            than your memory can back up. Reserve Easy for words that took no effort at all.
          </p>
        )}
      </section>

      <section className="dash-section">
        <div className="eyebrow">
          Time invested
          <span className="eyebrow-note">
            {formatDuration(stats.timeTotals.study)} reviewing ·{' '}
            {formatDuration(stats.timeTotals.read)} reading ·{' '}
            {formatDuration(stats.timeTotals.listen)} listening
          </span>
        </div>
        <StackedBarChart
          series={stats.timeSeries}
          keys={['study', 'read', 'listen'] as const}
          labels={['reviewing', 'reading', 'listening']}
          colors={['var(--accent)', 'var(--green)', 'var(--violet)']}
          labelStart={`${rangeDays}d ago`}
          labelEnd="today"
          format={(v) => formatDuration(v)}
        />
        <div className="state-legend">
          <span>
            <i className="dot" style={{ background: 'var(--accent)' }} /> Reviewing
          </span>
          <span>
            <i className="dot" style={{ background: 'var(--green)' }} /> Reading
          </span>
          <span>
            <i className="dot" style={{ background: 'var(--violet)' }} /> Listening
          </span>
        </div>
        <p className="note">
          Review time is estimated from the gaps between your answers; reading and listening are
          timed directly. Time isn't split per deck.
        </p>
      </section>

      {stats.readWordsTotal > 0 && (
        <section className="dash-section">
          <div className="eyebrow">
            Words read
            <span className="eyebrow-note">
              {stats.readWordsInRange.toLocaleString()} in the last {rangeDays}d ·{' '}
              {stats.readWordsPerReadingDay.toLocaleString()}/day on the{' '}
              {stats.readingDaysInRange} {stats.readingDaysInRange === 1 ? 'day' : 'days'} you read
            </span>
          </div>
          <BarChart
            data={stats.readWordsSeries}
            labelStart={`${rangeDays}d ago`}
            labelEnd="today"
            describe={(i, v) =>
              `${formatBankDay(stats.days[i], stats.today)} · ${v.toLocaleString()} ${v === 1 ? 'word' : 'words'} read`
            }
          />
          <p className="note">
            Counted as you scroll through a story, once per story — re-reading one doesn't count its
            words again. Reading isn't split per deck.
          </p>
        </section>
      )}

      {/* ---------- what's coming ---------- */}

      <section className="dash-section">
        <div className="eyebrow">
          Due forecast · next 30 days
          <span className="eyebrow-note">
            {stats.forecastTotal} cards
            {stats.secsPerAnswer !== null &&
              ` · about ${formatDuration(stats.forecastTotal * stats.secsPerAnswer)} of reviewing`}
          </span>
        </div>
        <BarChart
          data={stats.forecast.map((d) => d.count)}
          labelStart="today"
          labelEnd="in 30d"
          accent
          hint="Tap the chart to read a day"
          describe={(i, v) =>
            `${formatBankDay(stats.forecast[i].day, stats.today)} · ${v} ${v === 1 ? 'card' : 'cards'} due`
          }
        />
      </section>

      {/* ---------- what needs attention ---------- */}

      {stats.leeches.length > 0 && (
        <section className="dash-section">
          <div className="eyebrow">
            Words fighting back
            <span className="eyebrow-note">ranked by lapses, failed answers and story lookups</span>
          </div>
          <div className="leech-list">
            {stats.leeches.map(({ card, reasons }) => (
              <button
                key={card.id}
                className="leech-row"
                onClick={() => onOpenDeck?.(card.deckId)}
                title="Open this word's deck"
              >
                <span className="leech-word">
                  {card.emoji && <span className="leech-emoji">{card.emoji}</span>}
                  {card.word}
                </span>
                <span className="leech-meaning">{card.meaning}</span>
                <span className="leech-reasons">{reasons.join(' · ')}</span>
              </button>
            ))}
          </div>
          {onDrill && (
            <button
              className="btn primary drill-btn"
              onClick={() => onDrill(stats.leeches.map((l) => l.card.id))}
            >
              Drill these {stats.leeches.length} words
            </button>
          )}
        </section>
      )}

      {stats.overdue.length > 0 && (
        <section className="dash-section">
          <div className="eyebrow">
            Slipping away
            <span className="eyebrow-note">
              {stats.overdue.length} cards overdue by more than their own interval
            </span>
          </div>
          <p className="note no-top">
            The longer these wait, the more of them you'll have forgotten outright. Oldest:{' '}
            {stats.overdue
              .slice(0, 6)
              .map((c) => c.word)
              .join(', ')}
            {stats.overdue.length > 6 ? '…' : ''}
          </p>
          {onDrill && (
            <button
              className="btn drill-btn"
              onClick={() => onDrill(stats.overdue.slice(0, 30).map((c) => c.id))}
            >
              Rescue the {Math.min(30, stats.overdue.length)} most overdue
            </button>
          )}
        </section>
      )}

      {/* ---------- composition ---------- */}

      <section className="dash-section">
        <div className="eyebrow">Card states</div>
        <StateBar states={stats.states} total={stats.cards.length} />
        <div className="state-legend">
          <span>
            <i className="dot new" /> New · {stats.states.new}
          </span>
          <span>
            <i className="dot learning" /> Learning · {stats.states.learning}
          </span>
          <span>
            <i className="dot review" /> Review · {stats.states.review}
          </span>
          <span>
            <i className="dot known" /> Known · {stats.states.known}
          </span>
        </div>
      </section>

      {stats.maturity.some((b) => b.count > 0) && (
        <section className="dash-section">
          <div className="eyebrow">
            How well it's sticking
            <span className="eyebrow-note">
              {stats.matureCount} mature ({MATURE_DAYS}d+ interval) of {stats.inRotation} in
              rotation
            </span>
          </div>
          <Histogram buckets={stats.maturity} />
          {(stats.ret.youngCount > 0 || stats.ret.matureCount > 0) && (
            <div className="state-legend">
              <span>
                Young retention ·{' '}
                <strong>{stats.ret.young === null ? '—' : `${stats.ret.young}%`}</strong> (
                {stats.ret.youngCount})
              </span>
              <span>
                Mature retention ·{' '}
                <strong>{stats.ret.mature === null ? '—' : `${stats.ret.mature}%`}</strong> (
                {stats.ret.matureCount})
              </span>
            </div>
          )}
        </section>
      )}

      {/* ---------- decks ---------- */}

      {decks.length > 0 && (
        <section className="dash-section">
          <div className="eyebrow">Decks</div>
          <div className="deck-table-wrap">
            <table className="deck-table">
              <thead>
                <tr>
                  <th>Deck</th>
                  <th>Words</th>
                  <th>Known</th>
                  <th>Due</th>
                  <th>7d</th>
                  <th>Retention</th>
                  <th>Last studied</th>
                </tr>
              </thead>
              <tbody>
                {stats.deckRows.map((r) => (
                  <tr
                    key={r.deck.id}
                    onClick={() => onOpenDeck?.(r.deck.id)}
                    className={onOpenDeck ? 'clickable' : undefined}
                  >
                    <td>
                      <span className="deck-cell-name">{r.deck.name}</span>
                      <span className="deck-cell-lang">{r.deck.language}</span>
                    </td>
                    <td>{r.cards}</td>
                    <td>
                      {r.cards > 0 ? `${Math.round((r.known / r.cards) * 100)}%` : '—'}
                      <span className="cell-sub">{r.known}</span>
                    </td>
                    <td className={r.dueNow > 0 ? 'hot' : undefined}>{r.dueNow || '—'}</td>
                    <td>{r.reviews7d || '—'}</td>
                    <td>{r.retention === null ? '—' : `${r.retention}%`}</td>
                    <td>{r.lastStudied === null ? 'never' : formatAgo(r.lastStudied)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {stats.languages.length > 1 && (
            <div className="state-legend">
              {stats.languages.map((l) => (
                <span key={l.language}>
                  <strong>{l.language}</strong> · {l.cards} {l.cards === 1 ? 'word' : 'words'},{' '}
                  {l.known} known
                </span>
              ))}
            </div>
          )}
        </section>
      )}

      {/* ---------- stories ---------- */}

      {stats.stories.length > 0 && (
        <section className="dash-section">
          <div className="eyebrow">
            Stories
            <span className="eyebrow-note">
              {stats.stories.length} written · {stats.storyWords.toLocaleString()} words ·{' '}
              {stats.distinctGlossary} distinct words met
            </span>
          </div>
          {stats.inProgress.length > 0 && (
            <div className="story-progress-list">
              {stats.inProgress.map((s) => (
                <button
                  key={s.id}
                  className="story-progress-row"
                  onClick={() => onOpenStory?.(s.deckId, s.id)}
                >
                  <span className="story-progress-title">{s.title}</span>
                  <span className="story-progress-meta">
                    {s.lastOpenedAt ? formatAgo(s.lastOpenedAt) : formatAgo(s.createdAt)}
                    {s.topic ? ` · ${s.topic}` : ''}
                  </span>
                </button>
              ))}
            </div>
          )}
          <div className="state-legend">
            <span>
              <strong>{stats.threadCount}</strong> serialised{' '}
              {stats.threadCount === 1 ? 'thread' : 'threads'}
            </span>
            <span>
              <strong>{stats.glossaryToCards}</strong> story words became flashcards
            </span>
            {stats.topTopics.length > 0 && <span>Topics · {stats.topTopics.join(', ')}</span>}
          </div>
        </section>
      )}

      {/* ---------- records & gaps ---------- */}

      <section className="dash-section">
        <div className="eyebrow">Records</div>
        <div className="stat-grid">
          <Stat label="Longest streak" value={stats.bestStreak} suffix=" days" />
          <Stat
            label="Best day"
            value={stats.bestDay ? stats.bestDay.count : 0}
            hint={stats.bestDay ? formatAgo(stats.bestDay.day) : undefined}
          />
          <Stat label="Lifetime answers" value={stats.allReviews.length} />
          {stats.readWordsTotal > 0 && (
            <Stat
              label="Words read"
              value={stats.readWordsTotal.toLocaleString()}
              hint="in stories"
            />
          )}
          <Stat
            label="Next milestone"
            value={`${stats.states.known}/${stats.milestone}`}
            hint="words known"
          />
        </div>
        <div className="progress-track goal-track milestone-track">
          <div
            className="progress-fill"
            style={{ width: `${Math.min(100, (stats.states.known / stats.milestone) * 100)}%` }}
          />
        </div>
      </section>

      {stats.gaps.length > 0 && (
        <section className="dash-section">
          <div className="eyebrow">
            Card gaps
            <span className="eyebrow-note">missing fields worth filling in</span>
          </div>
          <div className="gap-row">
            {stats.gaps.map((g) => (
              <div className="gap-chip" key={g.label}>
                <span className="gap-count">{g.count}</span>
                <span className="gap-label">{g.label}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {stats.allReviews.length === 0 && (
        <p className="note">
          No reviews recorded yet — most of this fills in as you study{deckName ? ` ${deckName}` : ''}.
        </p>
      )}
    </>
  )
}

// ---------------------------------------------------------------- computation

type RawData = {
  cards: Card[]
  reviews: Review[]
  decks: import('../db').Deck[]
  snapshots: import('../db').Snapshot[]
  stories: import('../db').SavedStory[]
  reading: import('../db').ReadingLog[]
  listening: import('../db').ListeningLog[]
}

function compute(raw: RawData, rangeDays: number, deckFilter: number | 'all') {
  const now = Date.now()
  const today = startOfDay(now)
  const windowStart = today - (rangeDays - 1) * DAY

  const cards = deckFilter === 'all' ? raw.cards : raw.cards.filter((c) => c.deckId === deckFilter)
  const allReviews =
    deckFilter === 'all' ? raw.reviews : raw.reviews.filter((r) => r.deckId === deckFilter)
  const stories =
    deckFilter === 'all' ? raw.stories : raw.stories.filter((s) => s.deckId === deckFilter)
  const rangeReviews = allReviews.filter((r) => r.ts >= windowStart)

  const days = Array.from({ length: rangeDays }, (_, i) => windowStart + i * DAY)
  const reviewsPerDay = countByDay(allReviews, (r) => r.ts)
  const activeDaySet = new Set(reviewsPerDay.keys())

  // --- grades per day, stacked
  const gradeSeries = days.map((day) => ({
    day,
    again: 0,
    hard: 0,
    good: 0,
    easy: 0,
  }))
  const gradeIndex = new Map(gradeSeries.map((p, i) => [p.day, i]))
  const gradeTotals = { again: 0, hard: 0, good: 0, easy: 0 }
  for (const r of rangeReviews) {
    const i = gradeIndex.get(startOfDay(r.ts))
    if (i !== undefined) gradeSeries[i][r.grade]++
    gradeTotals[r.grade]++
  }

  // --- time: study inferred from review gaps, reading/listening logged directly
  const sessions = inferSessions(allReviews)
  const studyByDay = studySecondsByDay(allReviews)
  const readByDay = new Map(raw.reading.map((r) => [r.day, r.seconds]))
  const listenByDay = new Map(raw.listening.map((r) => [r.day, r.seconds]))
  const timeSeries = days.map((day) => ({
    day,
    study: studyByDay.get(day) ?? 0,
    read: readByDay.get(day) ?? 0,
    listen: listenByDay.get(day) ?? 0,
  }))
  // Story words scrolled through — logged app-wide, so not split per deck.
  const readWordsByDay = new Map(raw.reading.map((r) => [r.day, r.words ?? 0]))
  const readWordsSeries = days.map((day) => readWordsByDay.get(day) ?? 0)
  const readWordsInRange = readWordsSeries.reduce((a, b) => a + b, 0)
  const readingDaysInRange = readWordsSeries.filter((w) => w > 0).length
  const timeTotals = timeSeries.reduce(
    (a, p) => ({ study: a.study + p.study, read: a.read + p.read, listen: a.listen + p.listen }),
    { study: 0, read: 0, listen: 0 },
  )
  const totalTimeSecs =
    [...studyByDay.values()].reduce((a, b) => a + b, 0) +
    raw.reading.reduce((a, r) => a + r.seconds, 0) +
    raw.listening.reduce((a, r) => a + r.seconds, 0)

  // --- 12-week heatmap, aligned so each column is a calendar week
  const heatDays: { day: number; reviews: number; seconds: number }[] = []
  const heatStart = today - (83 + new Date(today - 83 * DAY).getDay()) * DAY
  for (let d = heatStart; d <= today; d += DAY) {
    heatDays.push({
      day: d,
      reviews: reviewsPerDay.get(d) ?? 0,
      seconds: (studyByDay.get(d) ?? 0) + (readByDay.get(d) ?? 0) + (listenByDay.get(d) ?? 0),
    })
  }

  // --- hour of day
  const byHour = Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0, pass: 0 }))
  for (const r of allReviews) {
    const h = byHour[new Date(r.ts).getHours()]
    h.count++
    if (r.grade !== 'again') h.pass++
  }
  const hourCandidates = byHour.filter((h) => h.count >= 20)
  const bestHour =
    hourCandidates.length > 0
      ? hourCandidates
          .map((h) => ({ hour: h.hour, accuracy: Math.round((h.pass / h.count) * 100) }))
          .sort((a, b) => b.accuracy - a.accuracy)[0]
      : null

  // --- growth
  const addedByDay = countByDay(cards, (c) => c.createdAt)
  const addedSeries = days.map((d) => addedByDay.get(d) ?? 0)
  const addedInRange = addedSeries.reduce((a, b) => a + b, 0)
  const addedPerWeek = Math.round((addedInRange / rangeDays) * 7)

  const known = cards.filter((c) => c.known).length
  const milestone = nextMilestone(known)
  // Only project when there's real momentum behind the number.
  const knownPerDay = countKnownVelocity(cards, today)
  const projection =
    knownPerDay > 0.2
      ? {
          target: milestone.toLocaleString(),
          when: new Date(now + ((milestone - known) / knownPerDay) * DAY).toLocaleDateString(
            undefined,
            { month: 'long', year: 'numeric' },
          ),
        }
      : null

  // --- attention
  const overdue = cards
    .filter(
      (c) =>
        !c.known &&
        c.state === 'review' &&
        c.interval >= 1 &&
        now - c.due > c.interval * DAY,
    )
    .sort((a, b) => (now - b.due) / b.interval - (now - a.due) / a.interval)

  const forecast = dueForecast(cards, today, 30, now)
  const inRotation = cards.filter((c) => !c.known && c.state !== 'new').length
  const buckets = maturity(cards)

  // --- stories
  const glossaryWords = new Set<string>()
  let storyWords = 0
  for (const s of stories) {
    storyWords += s.story.trim().split(/\s+/).length
    for (const g of s.glossary) glossaryWords.add(g.word)
  }
  const cardWords = new Set(cards.map((c) => c.word))
  const glossaryToCards = [...glossaryWords].filter((w) => cardWords.has(w)).length
  const topicCounts = new Map<string, number>()
  for (const s of stories) if (s.topic) topicCounts.set(s.topic, (topicCounts.get(s.topic) ?? 0) + 1)
  const inProgress = stories
    .filter((s) => s.bookmark !== undefined)
    .sort((a, b) => (b.lastOpenedAt ?? b.createdAt) - (a.lastOpenedAt ?? a.createdAt))
    .slice(0, 5)

  // --- gaps
  const anyRoman = cards.some((c) => c.roman)
  const gaps = [
    { label: 'no example', count: cards.filter((c) => !c.example?.trim()).length },
    {
      label: 'no example translation',
      count: cards.filter((c) => c.example?.trim() && !c.exampleTranslation?.trim()).length,
    },
    { label: 'no emoji', count: cards.filter((c) => !c.emoji).length },
    ...(anyRoman ? [{ label: 'no romanization', count: cards.filter((c) => !c.roman).length }] : []),
  ].filter((g) => g.count > 0)

  const bestDayEntry = [...reviewsPerDay.entries()].sort((a, b) => b[1] - a[1])[0]
  const deckRows = deckStats(raw.decks, raw.cards, raw.reviews, raw.stories, now)

  const languages = [...new Set(raw.decks.map((d) => d.language))].map((language) => {
    const ids = new Set(raw.decks.filter((d) => d.language === language).map((d) => d.id))
    const lc = raw.cards.filter((c) => ids.has(c.deckId))
    return { language, cards: lc.length, known: lc.filter((c) => c.known).length }
  })

  const topDue = [...deckRows].sort((a, b) => b.dueNow - a.dueNow)[0]

  return {
    today,
    days,
    cards,
    allReviews,
    stories,
    states: {
      new: cards.filter((c) => c.state === 'new' && !c.known).length,
      learning: cards.filter((c) => c.state === 'learning' && !c.known).length,
      review: cards.filter((c) => c.state === 'review' && !c.known).length,
      known,
    },
    reviewsToday: reviewsPerDay.get(today) ?? 0,
    reviewsInRange: rangeReviews.length,
    activeDays: days.filter((d) => activeDaySet.has(d)).length,
    streak: currentStreak(activeDaySet, today),
    bestStreak: longestStreak(activeDaySet),
    bestDay: bestDayEntry ? { day: bestDayEntry[0], count: bestDayEntry[1] } : null,
    ret: retention(rangeReviews),
    studyTodaySecs: studyByDay.get(today) ?? 0,
    totalTimeSecs,
    secsPerAnswer: secondsPerAnswer(sessions),
    heatmap: heatDays,
    byHour,
    bestHour,
    bankSeries: buildBankSeries(raw.snapshots, raw.cards, today, Math.max(rangeDays, 14)),
    historyDays: new Set(raw.snapshots.map((s) => s.day)).size,
    addedSeries,
    addedInRange,
    addedPerWeek,
    projection,
    gradeSeries,
    gradeTotals,
    timeSeries,
    timeTotals,
    readWordsSeries,
    readWordsInRange,
    readWordsTotal: raw.reading.reduce((a, r) => a + (r.words ?? 0), 0),
    readWordsPerReadingDay:
      readingDaysInRange > 0 ? Math.round(readWordsInRange / readingDaysInRange) : 0,
    readingDaysInRange,
    forecast,
    forecastTotal: forecast.reduce((a, d) => a + d.count, 0),
    dueNow: forecast[0]?.count ?? 0,
    leeches: leeches(cards, allReviews),
    overdue,
    maturity: buckets,
    matureCount: buckets.filter((b) => b.mature).reduce((a, b) => a + b.count, 0),
    inRotation,
    deckRows,
    languages,
    milestone,
    storyWords,
    distinctGlossary: glossaryWords.size,
    glossaryToCards,
    threadCount: new Set(stories.filter((s) => s.parentId).map((s) => s.parentId)).size,
    topTopics: [...topicCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([t]) => t),
    inProgress,
    gaps,
    topDueDeckId: topDue && topDue.dueNow > 0 ? topDue.deck.id : undefined,
  }
}

type Stats = ReturnType<typeof compute>

/** Words marked known per day, averaged over however much history exists —
 *  used to project when the next milestone lands. */
function countKnownVelocity(cards: Card[], today: number): number {
  const knownCards = cards.filter((c) => c.known)
  if (knownCards.length < 5) return 0
  const oldest = Math.min(...knownCards.map((c) => c.createdAt))
  const days = Math.max(7, (today - startOfDay(oldest)) / DAY)
  return knownCards.length / days
}

// ------------------------------------------------------------------ pieces

function TodayCard({
  stats,
  goal,
  deckId,
  onStudy,
  onDrill,
}: {
  stats: Stats
  goal: number
  deckId?: number
  onStudy?: (deckId: number) => void
  onDrill?: (cardIds: number[]) => void
}) {
  const goalMet = goal > 0 && stats.reviewsToday >= goal
  const message = goalMet
    ? 'Daily goal met — anything more is a bonus.'
    : stats.dueNow > 0
      ? `${stats.dueNow} ${stats.dueNow === 1 ? 'card is' : 'cards are'} waiting for you.`
      : stats.states.new > 0
        ? `Nothing due — but ${stats.states.new} new ${stats.states.new === 1 ? 'word is' : 'words are'} untouched.`
        : 'All caught up. Nothing due, nothing new.'

  return (
    <div className="today-card">
      <div className="today-main">
        <div className="today-headline">{message}</div>
        {goal > 0 && (
          <div className="goal-wrap dash-goal">
            <div className="goal-label">
              Daily goal · {stats.reviewsToday}/{goal}
              {goalMet ? ' — met! 🎯' : ''}
            </div>
            <div className="progress-track goal-track">
              <div
                className="progress-fill"
                style={{ width: `${Math.min(100, (stats.reviewsToday / goal) * 100)}%` }}
              />
            </div>
          </div>
        )}
      </div>
      <div className="today-actions">
        {deckId !== undefined && onStudy && (
          <button className="btn primary" onClick={() => onStudy(deckId)}>
            Study now
          </button>
        )}
        {stats.leeches.length > 0 && onDrill && (
          <button className="btn" onClick={() => onDrill(stats.leeches.map((l) => l.card.id))}>
            Drill {stats.leeches.length} hard words
          </button>
        )}
      </div>
    </div>
  )
}

function RangeBar({ value, onChange }: { value: number; onChange: (days: number) => void }) {
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

function Stat({
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

/** Bar charts are too narrow to tap a single bar on a phone, so the whole
 *  plot area is the target: whichever column the x position lands in wins. */
function useColumnPick(n: number) {
  const [sel, setSel] = useState<number | null>(null)
  const ref = useRef<SVGSVGElement>(null)
  const pick = (clientX: number) => {
    const el = ref.current
    if (!el || n < 1) return
    const rect = el.getBoundingClientRect()
    const frac = (clientX - rect.left) / rect.width
    setSel(Math.max(0, Math.min(n - 1, Math.floor(frac * n))))
  }
  return { sel, ref, pick }
}

function BarChart({
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
function StackedBarChart<K extends string>({
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

function formatBankDay(day: number, today: number): string {
  if (day === today) return 'Today'
  if (day === today - DAY) return 'Yesterday'
  return new Date(day).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

const PIPELINE: { key: keyof BankPoint; label: string; color: string }[] = [
  { key: 'new', label: 'new', color: 'var(--accent)' },
  { key: 'learning', label: 'learning', color: 'var(--amber)' },
  { key: 'review', label: 'review', color: 'var(--green)' },
  { key: 'known', label: 'known', color: 'var(--ink-3)' },
]

/** Stacked area of the four card states over time: words flow from new
 *  through learning and review into known. */
function PipelineChart({ series, today }: { series: BankPoint[]; today: number }) {
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

function Heatmap({
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

function formatHour(h: number): string {
  return new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric' })
}

function HourChart({ hours }: { hours: { hour: number; count: number; pass: number }[] }) {
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

function Histogram({ buckets }: { buckets: { label: string; count: number; mature: boolean }[] }) {
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
