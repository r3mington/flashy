import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db'
import { useSettings } from '../useSettings'
import { formatAgo, formatDuration } from '../time'
import { type Stats, compute } from './dashboard/compute'
import {
  BarChart,
  Heatmap,
  Histogram,
  HourChart,
  PipelineChart,
  RangeBar,
  StackedBarChart,
  Stat,
  StateBar,
} from './dashboard/charts'
import { formatBankDay, formatHour } from './dashboard/chartUtils'
import { MATURE_DAYS } from '../stats'

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

      {/* ---------- reading ---------- */}

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

