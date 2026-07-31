import type { Card, Deck, Review, SavedStory, Snapshot } from './db'
import { DAY, startOfDay } from './time'

/** A run of consecutive days ending today (or yesterday, so a day that hasn't
 *  been studied yet doesn't break the chain). */
export function currentStreak(days: Set<number>, today: number): number {
  let streak = 0
  let cursor = days.has(today) ? today : today - DAY
  while (days.has(cursor)) {
    streak++
    cursor -= DAY
  }
  return streak
}

/** Longest run of consecutive active days ever recorded. */
export function longestStreak(days: Set<number>): number {
  const sorted = [...days].sort((a, b) => a - b)
  let best = 0
  let run = 0
  let prev: number | null = null
  for (const d of sorted) {
    run = prev !== null && d - prev === DAY ? run + 1 : 1
    prev = d
    if (run > best) best = run
  }
  return best
}

// ---------- study time (inferred from review timestamps) ----------

/** Answers more than this far apart belong to different sittings. */
const SESSION_GAP = 5 * 60 * 1000
/** A single answer never counts for more than this (thinking ≠ walking away). */
const MAX_ANSWER = 60 * 1000
/** The first answer of a sitting has no preceding gap to measure. */
const FIRST_ANSWER = 8 * 1000

export interface Session {
  start: number
  end: number
  answers: number
  ms: number
}

/** Group reviews into sittings and estimate their duration. The review log
 *  stores no per-answer duration, so time is inferred from the gaps between
 *  consecutive answers — good enough for "how long do I actually study". */
export function inferSessions(reviews: Pick<Review, 'ts'>[]): Session[] {
  const ts = reviews.map((r) => r.ts).sort((a, b) => a - b)
  const out: Session[] = []
  let cur: Session | null = null
  for (const t of ts) {
    if (cur && t - cur.end <= SESSION_GAP) {
      cur.ms += Math.min(t - cur.end, MAX_ANSWER)
      cur.end = t
      cur.answers++
    } else {
      cur = { start: t, end: t, answers: 1, ms: FIRST_ANSWER }
      out.push(cur)
    }
  }
  return out
}

/** Estimated study seconds keyed by start-of-day. */
export function studySecondsByDay(reviews: Pick<Review, 'ts'>[]): Map<number, number> {
  const out = new Map<number, number>()
  for (const s of inferSessions(reviews)) {
    const day = startOfDay(s.start)
    out.set(day, (out.get(day) ?? 0) + Math.round(s.ms / 1000))
  }
  return out
}

/** Mean seconds an answer takes, used to price the upcoming workload. */
export function secondsPerAnswer(sessions: Session[]): number | null {
  const answers = sessions.reduce((a, s) => a + s.answers, 0)
  if (answers < 20) return null // too little data to be meaningful
  const ms = sessions.reduce((a, s) => a + s.ms, 0)
  return ms / answers / 1000
}

// ---------- retention ----------

export interface Retention {
  /** Every answer in the window, learning re-reps included. */
  overall: number | null
  overallCount: number
  /** Answers on cards that were already in the review state — the number
   *  people mean by "retention". Only available for reviews logged since the
   *  card state started being recorded. */
  young: number | null
  youngCount: number
  mature: number | null
  matureCount: number
}

/** Cards with an interval at or beyond this are considered mature. */
export const MATURE_DAYS = 21

export function retention(reviews: Review[]): Retention {
  const pass = (rs: Review[]) =>
    rs.length === 0 ? null : Math.round((rs.filter((r) => r.grade !== 'again').length / rs.length) * 100)
  const reviewState = reviews.filter((r) => r.state === 'review')
  const young = reviewState.filter((r) => (r.interval ?? 0) < MATURE_DAYS)
  const mature = reviewState.filter((r) => (r.interval ?? 0) >= MATURE_DAYS)
  return {
    overall: pass(reviews),
    overallCount: reviews.length,
    young: pass(young),
    youngCount: young.length,
    mature: pass(mature),
    matureCount: mature.length,
  }
}

// ---------- struggle / leeches ----------

export interface Leech {
  card: Card
  score: number
  againCount: number
  reasons: string[]
}

/** Cards that keep costing you: forgotten after graduating (lapses), failed
 *  repeatedly, looked up mid-story, or driven down to a punishing ease. */
export function leeches(cards: Card[], reviews: Review[], limit = 12): Leech[] {
  const againByCard = new Map<number, number>()
  for (const r of reviews) {
    if (r.grade === 'again') againByCard.set(r.cardId, (againByCard.get(r.cardId) ?? 0) + 1)
  }
  const scored: Leech[] = []
  for (const card of cards) {
    if (card.known) continue
    const againCount = againByCard.get(card.id) ?? 0
    const lookups = card.lookups ?? 0
    const easePenalty = card.ease < 2.3 ? (2.5 - card.ease) * 6 : 0
    const diffPenalty = card.difficulty !== undefined && card.difficulty > 7 ? card.difficulty - 7 : 0
    const score =
      card.lapses * 3 + againCount * 2 + lookups * 1.5 + easePenalty + diffPenalty * 2
    if (score < 3) continue
    const reasons: string[] = []
    if (card.lapses > 0) reasons.push(`${card.lapses} lapse${card.lapses === 1 ? '' : 's'}`)
    if (againCount > 0) reasons.push(`${againCount}× again`)
    if (lookups > 0) reasons.push(`${lookups} lookup${lookups === 1 ? '' : 's'}`)
    if (easePenalty > 0) reasons.push(`ease ${card.ease.toFixed(2)}`)
    scored.push({ card, score, againCount, reasons })
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit)
}

// ---------- maturity ----------

export interface MaturityBucket {
  label: string
  count: number
  mature: boolean
}

/** Review-state cards grouped by how long their current interval is. */
export function maturity(cards: Card[]): MaturityBucket[] {
  const edges: [string, number, boolean][] = [
    ['<1d', 1, false],
    ['1–7d', 7, false],
    ['1–3w', MATURE_DAYS, false],
    ['3w–3mo', 90, true],
    ['3–12mo', 365, true],
    ['1y+', Infinity, true],
  ]
  const buckets = edges.map(([label, , mature]) => ({ label, count: 0, mature }))
  for (const c of cards) {
    if (c.known || c.state === 'new') continue
    const i = edges.findIndex(([, max]) => c.interval < max)
    buckets[i === -1 ? buckets.length - 1 : i].count++
  }
  return buckets
}

// ---------- forecast ----------

export interface ForecastDay {
  day: number
  count: number
}

/** Due cards per day for the next `days` days; overdue cards land on day 0. */
export function dueForecast(cards: Card[], today: number, days: number, now = Date.now()): ForecastDay[] {
  const byDay = new Map<number, number>()
  let backlog = 0
  for (const c of cards) {
    if (c.state === 'new' || c.known) continue
    if (c.due <= now) {
      backlog++
      continue
    }
    const day = startOfDay(c.due)
    byDay.set(day, (byDay.get(day) ?? 0) + 1)
  }
  return Array.from({ length: days }, (_, i) => ({
    day: today + i * DAY,
    count: (byDay.get(today + i * DAY) ?? 0) + (i === 0 ? backlog : 0),
  }))
}

// ---------- per-deck rollup ----------

export interface DeckStats {
  deck: Deck
  cards: number
  known: number
  dueNow: number
  newCards: number
  reviews7d: number
  retention: number | null
  lastStudied: number | null
  stories: number
}

export function deckStats(
  decks: Deck[],
  cards: Card[],
  reviews: Review[],
  stories: SavedStory[],
  now = Date.now(),
): DeckStats[] {
  const since = now - 7 * DAY
  return decks
    .map((deck) => {
      const dc = cards.filter((c) => c.deckId === deck.id)
      const dr = reviews.filter((r) => r.deckId === deck.id)
      const recent = dr.filter((r) => r.ts >= now - 30 * DAY)
      return {
        deck,
        cards: dc.length,
        known: dc.filter((c) => c.known).length,
        dueNow: dc.filter((c) => !c.known && c.state !== 'new' && c.due <= now).length,
        newCards: dc.filter((c) => !c.known && c.state === 'new').length,
        reviews7d: dr.filter((r) => r.ts >= since).length,
        retention:
          recent.length === 0
            ? null
            : Math.round((recent.filter((r) => r.grade !== 'again').length / recent.length) * 100),
        lastStudied: dr.length === 0 ? null : Math.max(...dr.map((r) => r.ts)),
        stories: stories.filter((s) => s.deckId === deck.id).length,
      }
    })
    .sort((a, b) => b.cards - a.cards)
}

// ---------- word bank history ----------

export interface BankPoint {
  day: number
  total: number
  new: number
  learning: number
  review: number
  known: number
}

/** Continuous daily word-bank series: snapshots carried forward across gap
 *  days, with today taken from the live card table. */
export function buildBankSeries(
  snapshots: Snapshot[],
  cards: Card[],
  today: number,
  windowDays: number,
): BankPoint[] {
  const live: BankPoint = {
    day: today,
    total: cards.length,
    new: cards.filter((c) => !c.known && c.state === 'new').length,
    learning: cards.filter((c) => !c.known && c.state === 'learning').length,
    review: cards.filter((c) => !c.known && c.state === 'review').length,
    known: cards.filter((c) => c.known).length,
  }
  if (snapshots.length === 0) return [live]
  const sorted = [...snapshots].sort((a, b) => a.day - b.day)
  const byDay = new Map(sorted.map((s) => [s.day, s]))
  const start = Math.max(sorted[0].day, today - (windowDays - 1) * DAY)
  let last: Snapshot = sorted[0]
  for (const s of sorted) if (s.day <= start) last = s
  const out: BankPoint[] = []
  for (let d = start; d <= today; d += DAY) {
    const s = byDay.get(d)
    if (s) last = s
    out.push(d === today ? live : { ...last, day: d })
  }
  return out
}

// ---------- misc ----------

/** Counts keyed by start-of-day for anything with a timestamp. */
export function countByDay<T>(items: T[], ts: (item: T) => number): Map<number, number> {
  const out = new Map<number, number>()
  for (const item of items) {
    const day = startOfDay(ts(item))
    out.set(day, (out.get(day) ?? 0) + 1)
  }
  return out
}


/** The next round number worth chasing, for the milestone bar. */
export function nextMilestone(n: number): number {
  const steps = [10, 25, 50, 100, 250, 500, 1000, 2000, 3000, 5000, 7500, 10000]
  return steps.find((s) => s > n) ?? Math.ceil((n + 1) / 5000) * 5000
}
