import {
  createEmptyCard,
  fsrs,
  Rating,
  State,
  type Card as FsrsCard,
  type Grade as FsrsGrade,
} from 'ts-fsrs'
import type { Card, CardState, Scheduler } from './db'

export type Grade = 'again' | 'hard' | 'good' | 'easy'

const DAY = 24 * 60 * 60 * 1000
const MIN = 60 * 1000

/** Returns the fields to merge into the card after grading. */
export function schedule(
  card: Card,
  grade: Grade,
  scheduler: Scheduler = 'sm2',
  now = Date.now(),
): Partial<Card> {
  return scheduler === 'fsrs' ? scheduleFsrs(card, grade, now) : scheduleSm2(card, grade, now)
}

const f = fsrs()

const RATING: Record<Grade, FsrsGrade> = {
  again: Rating.Again,
  hard: Rating.Hard,
  good: Rating.Good,
  easy: Rating.Easy,
}

const FSRS_STATE: Record<CardState, State> = {
  new: State.New,
  learning: State.Learning,
  review: State.Review,
}

/** Build an FSRS card from ours. Cards graded so far under SM-2 get their
 *  memory state seeded from the SM-2 interval (stability ≈ interval). */
function toFsrsCard(card: Card, now: number): FsrsCard {
  const empty = createEmptyCard(new Date(card.createdAt))
  if (card.state === 'new') return empty
  const hasFsrsState = card.stability !== undefined && card.difficulty !== undefined
  return {
    ...empty,
    due: new Date(card.due),
    stability: hasFsrsState ? card.stability! : Math.max(0.1, card.interval),
    difficulty: hasFsrsState ? card.difficulty! : 5,
    elapsed_days: card.lastReview ? Math.max(0, (now - card.lastReview) / DAY) : 0,
    scheduled_days: card.interval,
    learning_steps: card.fsrsSteps ?? 0,
    reps: card.reps,
    lapses: card.lapses,
    state: FSRS_STATE[card.state],
    last_review: card.lastReview ? new Date(card.lastReview) : undefined,
  }
}

function scheduleFsrs(card: Card, grade: Grade, now: number): Partial<Card> {
  const next = f.next(toFsrsCard(card, now), new Date(now), RATING[grade]).card
  const state: CardState =
    next.state === State.Review ? 'review' : next.state === State.New ? 'new' : 'learning'
  return {
    state,
    due: next.due.getTime(),
    interval: next.scheduled_days,
    ease: card.ease, // untouched by FSRS; kept so switching back to SM-2 works
    reps: next.reps,
    lapses: next.lapses,
    stability: next.stability,
    difficulty: next.difficulty,
    fsrsSteps: next.learning_steps,
    lastReview: now,
  }
}

/** SM-2 style scheduler. Returns the fields to merge into the card. */
function scheduleSm2(card: Card, grade: Grade, now = Date.now()): Partial<Card> {
  let { interval, ease, reps, lapses } = card
  let state = card.state
  let due: number

  if (grade === 'again') {
    if (state === 'review') lapses += 1
    reps = 0
    interval = 0
    ease = Math.max(1.3, ease - 0.2)
    state = 'learning'
    due = now + 10 * MIN
  } else if (state === 'new' || state === 'learning' || interval < 1) {
    // Graduating from learning
    reps += 1
    state = 'review'
    if (grade === 'hard') {
      interval = 1
      ease = Math.max(1.3, ease - 0.15)
    } else if (grade === 'good') {
      interval = 1
    } else {
      interval = 4
      ease += 0.15
    }
    due = now + interval * DAY
  } else {
    // Review card
    reps += 1
    if (grade === 'hard') {
      interval = Math.max(interval + 1, Math.round(interval * 1.2))
      ease = Math.max(1.3, ease - 0.15)
    } else if (grade === 'good') {
      interval = Math.round(interval * ease)
    } else {
      interval = Math.round(interval * ease * 1.3)
      ease += 0.15
    }
    interval = Math.min(interval, 365 * 10)
    due = now + interval * DAY
  }

  return { interval, ease, reps, lapses, state, due, lastReview: now }
}

/** Human preview of the next interval for a grade, shown on the buttons. */
export function previewInterval(card: Card, grade: Grade, scheduler: Scheduler = 'sm2'): string {
  const next = schedule(card, grade, scheduler)
  const ms = (next.due ?? Date.now()) - Date.now()
  if (ms < 60 * MIN) return `${Math.round(ms / MIN)}m`
  if (ms < DAY) return `${Math.round(ms / (60 * MIN))}h`
  const days = Math.round(ms / DAY)
  if (days < 30) return `${days}d`
  if (days < 365) return `${(days / 30).toFixed(1).replace(/\.0$/, '')}mo`
  return `${(days / 365).toFixed(1).replace(/\.0$/, '')}y`
}
