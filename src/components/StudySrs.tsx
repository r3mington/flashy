import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, type Card } from '../db'
import { DAY, startOfDay } from '../time'
import { schedule, previewInterval, type Grade } from '../srs'
import { Flashcard } from './Flashcard'
import { useSettings } from '../useSettings'
import { updateAppBadge } from '../badge'

const GRADES: { grade: Grade; label: string }[] = [
  { grade: 'again', label: 'Again' },
  { grade: 'hard', label: 'Hard' },
  { grade: 'good', label: 'Good' },
  { grade: 'easy', label: 'Easy' },
]

interface SessionEntry {
  cardId: number
  word: string
  meaning: string
  grade: Grade
}

export function StudySrs({
  deckId,
  drillIds,
  onExit,
}: {
  deckId?: number
  /** Study exactly these cards, in this order, ignoring due dates — used by
   *  the dashboard's "drill the hard ones" shortcut. */
  drillIds?: number[]
  onExit: () => void
}) {
  const settings = useSettings()
  const deck = useLiveQuery(() => (deckId === undefined ? undefined : db.decks.get(deckId)), [deckId])
  const newPerSession = settings.newPerSession
  const [queue, setQueue] = useState<Card[] | null>(null)
  const [total, setTotal] = useState(0)
  const [done, setDone] = useState(0)
  const [flipped, setFlipped] = useState(false)
  const [log, setLog] = useState<SessionEntry[]>([])
  const [knownCount, setKnownCount] = useState(0)
  // Snapshot of the card before the last grade, so a mis-tap can be reverted.
  const [lastAction, setLastAction] = useState<{
    card: Card
    reviewId: number
    grade: Grade
  } | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const now = Date.now()
      let q: Card[]
      if (drillIds) {
        const found = await db.cards.bulkGet(drillIds)
        q = found.filter((c): c is Card => !!c && !c.known)
      } else if (deckId !== undefined) {
        const all = (await db.cards.where('deckId').equals(deckId).toArray()).filter(
          (c) => !c.known,
        )
        const dueCards = all.filter((c) => c.state !== 'new' && c.due <= now)
        const newCards = all.filter((c) => c.state === 'new').slice(0, newPerSession)
        dueCards.sort((a, b) => a.due - b.due)
        q = [...dueCards, ...newCards]
      } else {
        q = []
      }
      if (!cancelled) {
        setQueue(q)
        setTotal(q.length)
      }
    })()
    return () => {
      cancelled = true
    }
    // drillIds is a stable per-mount list; identity changes shouldn't refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deckId, newPerSession, drillIds?.join(',')])

  const current = queue?.[0]

  async function grade(g: Grade) {
    if (!current || !queue) return
    const updates = schedule(current, g, settings.scheduler)
    await db.cards.update(current.id, updates)
    const reviewId = await db.reviews.add({
      cardId: current.id,
      deckId: current.deckId,
      grade: g,
      ts: Date.now(),
      // The state the card was in when asked — lets the dashboard separate
      // true retention from learning-step re-reps.
      state: current.state,
      interval: current.interval,
    })
    setLastAction({ card: current, reviewId, grade: g })
    updateAppBadge()
    const updated = { ...current, ...updates }
    setLog((l) => [...l, { cardId: current.id, word: current.word, meaning: current.meaning, grade: g }])
    setFlipped(false)
    if (g === 'again') {
      // Re-queue at the end of this session
      setQueue([...queue.slice(1), updated])
    } else {
      setQueue(queue.slice(1))
      setDone((d) => d + 1)
    }
  }

  async function undo() {
    if (!lastAction || !queue) return
    await db.cards.put(lastAction.card)
    await db.reviews.delete(lastAction.reviewId)
    updateAppBadge()
    setLog((l) => l.slice(0, -1))
    if (lastAction.grade === 'again') {
      // The graded copy was re-queued at the end; pull it out and bring the
      // original back to the front.
      setQueue([lastAction.card, ...queue.filter((c) => c.id !== lastAction.card.id)])
    } else {
      setQueue([lastAction.card, ...queue])
      setDone((d) => d - 1)
    }
    setFlipped(false)
    setLastAction(null)
  }

  async function markKnown() {
    if (!current || !queue) return
    await db.cards.update(current.id, { known: true })
    updateAppBadge()
    setKnownCount((k) => k + 1)
    setFlipped(false)
    setQueue(queue.slice(1))
    setTotal((t) => t - 1)
  }

  // Keyboard shortcuts: space = flip, 1-4 = grade, k = known
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === ' ') {
        e.preventDefault()
        setFlipped((f) => !f)
      } else if (flipped && ['1', '2', '3', '4'].includes(e.key)) {
        grade(GRADES[Number(e.key) - 1].grade)
      } else if (e.key === 'k') {
        markKnown()
      } else if (e.key === 'z' || e.key === 'u') {
        undo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const previews = useMemo(
    () =>
      current
        ? GRADES.map(({ grade: g }) => previewInterval(current, g, settings.scheduler))
        : [],
    [current, settings.scheduler],
  )

  if (!queue) return null

  if (!current) {
    if (total === 0 && log.length === 0 && knownCount === 0) {
      return (
        <div className="study-done">
          <div className="big">✦</div>
          <h2>{drillIds ? 'Nothing to drill' : 'Nothing due'}</h2>
          <p>
            {drillIds
              ? 'These cards have all been marked known.'
              : 'No cards are due for review right now. Come back later.'}
          </p>
          <button className="btn primary" onClick={onExit}>
            {drillIds ? 'Back to dashboard' : 'Back to deck'}
          </button>
        </div>
      )
    }
    return (
      <SessionSummary
        log={log}
        knownCount={knownCount}
        onExit={onExit}
        onUndo={lastAction ? undo : undefined}
      />
    )
  }

  return (
    <div className="study-wrap">
      <div className="study-progress">
        <span>{done}</span>
        <div className="progress-track">
          <div className="progress-fill" style={{ width: `${total ? (done / total) * 100 : 0}%` }} />
        </div>
        <span>{queue.length} left</span>
      </div>

      <Flashcard
        card={current}
        flipped={flipped}
        onFlip={() => setFlipped((f) => !f)}
        dealKey={current.id}
        front={settings.reviewFront}
        mask={settings.maskExample}
        language={deck?.language}
      />

      <div className="grade-row">
        {flipped ? (
          GRADES.map(({ grade: g, label }, i) => (
            <button
              key={g}
              className={`grade-btn ${g}`}
              style={{ animationDelay: `${i * 40}ms` }}
              onClick={() => grade(g)}
            >
              {label}
              <span className="ivl">{previews[i]}</span>
            </button>
          ))
        ) : (
          <button className="btn" onClick={() => setFlipped(true)}>
            Show answer
          </button>
        )}
      </div>

      <div className="study-extra">
        <button
          className="btn ghost small"
          title="Mark this card as known — it leaves the study rotation (k)"
          onClick={markKnown}
        >
          ✓ I know this
        </button>
        {lastAction && (
          <button
            className="btn ghost small"
            title="Revert the last grade and bring the card back (z)"
            onClick={undo}
          >
            ↩ Undo
          </button>
        )}
      </div>
    </div>
  )
}

function SessionSummary({
  log,
  knownCount,
  onExit,
  onUndo,
}: {
  log: SessionEntry[]
  knownCount: number
  onExit: () => void
  onUndo?: () => void
}) {
  const settings = useSettings()

  // Streak + today's total from the whole review log (this session included)
  const stats = useLiveQuery(async () => {
    const reviews = await db.reviews.toArray()
    const days = new Set(reviews.map((r) => startOfDay(r.ts)))
    const today = startOfDay(Date.now())
    let streak = 0
    let cursor = days.has(today) ? today : today - DAY
    while (days.has(cursor)) {
      streak++
      cursor -= DAY
    }
    const reviewsToday = reviews.filter((r) => startOfDay(r.ts) === today).length
    return { streak, reviewsToday }
  })

  const uniqueCards = new Set(log.map((e) => e.cardId)).size
  const accuracy =
    log.length > 0
      ? Math.round((log.filter((e) => e.grade !== 'again').length / log.length) * 100)
      : null

  // Hardest cards: most "again" grades this session
  const againByCard = new Map<number, { word: string; meaning: string; count: number }>()
  for (const e of log) {
    if (e.grade !== 'again') continue
    const prev = againByCard.get(e.cardId)
    againByCard.set(e.cardId, {
      word: e.word,
      meaning: e.meaning,
      count: (prev?.count ?? 0) + 1,
    })
  }
  const hardest = [...againByCard.values()].sort((a, b) => b.count - a.count).slice(0, 5)

  const goal = settings.dailyGoal
  const goalDone = stats ? Math.min(stats.reviewsToday, goal) : 0
  const goalMet = stats !== undefined && goal > 0 && stats.reviewsToday >= goal

  return (
    <div className="study-done summary">
      <div className="big">{goalMet ? '🎉' : '✦'}</div>
      <h2>Session complete</h2>
      <p>
        {uniqueCards} {uniqueCards === 1 ? 'card' : 'cards'} reviewed
        {knownCount > 0 ? ` · ${knownCount} marked known` : ''}
      </p>

      <div className="stat-grid summary-stats">
        <div className="stat-tile">
          <div className="stat-value">{log.length}</div>
          <div className="stat-label">Answers</div>
        </div>
        <div className="stat-tile">
          <div className="stat-value">{accuracy === null ? '—' : `${accuracy}%`}</div>
          <div className="stat-label">Accuracy</div>
        </div>
        <div className="stat-tile">
          <div className="stat-value">
            {stats?.streak ?? '—'}
            {stats && stats.streak > 0 ? ' 🔥' : ''}
          </div>
          <div className="stat-label">Day streak</div>
        </div>
      </div>

      {goal > 0 && stats && (
        <div className="goal-wrap">
          <div className="goal-label">
            Daily goal · {stats.reviewsToday}/{goal}
            {goalMet ? ' — met! 🎯' : ''}
          </div>
          <div className="progress-track goal-track">
            <div
              className="progress-fill"
              style={{ width: `${goal ? (goalDone / goal) * 100 : 0}%` }}
            />
          </div>
        </div>
      )}

      {hardest.length > 0 && (
        <div className="hard-list">
          <div className="eyebrow">Hardest this session</div>
          {hardest.map((h) => (
            <div className="hard-row" key={h.word}>
              <span className="word">{h.word}</span>
              <span className="meaning">{h.meaning}</span>
              <span className="again-count">
                ×{h.count} again
              </span>
            </div>
          ))}
        </div>
      )}

      <button className="btn primary" onClick={onExit}>
        Back to deck
      </button>
      {onUndo && (
        <button className="btn ghost small" onClick={onUndo}>
          ↩ Undo last grade
        </button>
      )}
    </div>
  )
}
