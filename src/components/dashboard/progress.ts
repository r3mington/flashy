import type { Card, ReadingLog, Review, SavedStory } from '../../db'
import { definable } from '../../glossary'
import { rootCandidates } from '../../lemma'
import { langCodeFor } from '../../speech'
import { defKey, tokenizeWords } from '../../text'
import { nextDay, normalizeDay, startOfDay } from '../../time'

/** The first day the reading clock counted only active reading (see
 *  `countsAsReading`). Before it, a story left on screen kept the clock running,
 *  so minutes from earlier days would make any speed worked out from them look
 *  far slower than it was. The fix shipped part-way through 27 October 2026, so
 *  the first whole clean day is the 28th. */
export const CLEAN_READING_FROM = new Date(2026, 9, 28).getTime()

/** The day this view's history begins: the deck's creation, or the oldest
 *  deck's for all of them — pulled earlier by anything that predates it, since
 *  a deck restored from a backup or rebuilt from a CSV can be younger than its
 *  own cards and reviews. */
export function inceptionDay(
  raw: { decks: { id: number; createdAt: number }[]; cards: Card[]; reviews: Review[]; reading: ReadingLog[] },
  deckFilter: number | 'all',
  today: number,
): number {
  const inScope = <T extends { deckId: number }>(xs: T[]) =>
    deckFilter === 'all' ? xs : xs.filter((x) => x.deckId === deckFilter)
  const times = [
    ...(deckFilter === 'all' ? raw.decks : raw.decks.filter((d) => d.id === deckFilter)).map(
      (d) => d.createdAt,
    ),
    ...inScope(raw.cards).map((c) => c.createdAt),
    ...inScope(raw.reviews).map((r) => r.ts),
    // Reading isn't split per deck, so it only moves the start for all decks.
    ...(deckFilter === 'all' ? raw.reading.map((r) => r.day) : []),
  ].filter((t) => Number.isFinite(t) && t > 0)
  if (times.length === 0) return today
  return Math.min(today, startOfDay(Math.min(...times)))
}

/** Days from `start` to `today`, both included, walked midnight to midnight. */
export function daysBetween(start: number, today: number): number {
  let n = 1
  for (let d = start; d < today; d = nextDay(d)) n++
  return n
}

/** The first day story words were counted. Every row written since then
 *  carries a `words` field, even a zero; rows from before it have none. */
export function wordsTrackedFrom(reading: ReadingLog[]): number | null {
  const days = reading.filter((r) => r.words !== undefined).map((r) => normalizeDay(r.day))
  return days.length > 0 ? Math.min(...days) : null
}

/** Reading speed over the days given, counting only days from
 *  `CLEAN_READING_FROM` on that have both words and time. A day spent
 *  re-reading adds minutes and no new words, so this is a floor on speed
 *  rather than an exact one. */
export function readingSpeed(
  reading: ReadingLog[],
  from: number,
  to: number,
): { wpm: number; days: number } | null {
  let words = 0
  let secs = 0
  let days = 0
  for (const r of reading) {
    const day = normalizeDay(r.day)
    if (day < Math.max(from, CLEAN_READING_FROM) || day > to) continue
    if (!r.words || r.seconds < 60) continue
    words += r.words
    secs += r.seconds
    days++
  }
  return secs > 0 ? { wpm: Math.round(words / (secs / 60)), days } : null
}

/** Words per minute, one point per calendar week from the clean start —
 *  weeks with nothing read are left out rather than drawn as zero. */
export function weeklySpeed(
  reading: ReadingLog[],
  from: number,
  today: number,
): { weekStart: number; wpm: number }[] {
  const weeks = new Map<number, { words: number; secs: number }>()
  for (const r of reading) {
    const day = normalizeDay(r.day)
    if (day < Math.max(from, CLEAN_READING_FROM) || day > today) continue
    if (!r.words || r.seconds < 60) continue
    const d = new Date(day)
    d.setDate(d.getDate() - d.getDay())
    const week = startOfDay(d.getTime())
    const w = weeks.get(week) ?? { words: 0, secs: 0 }
    w.words += r.words
    w.secs += r.seconds
    weeks.set(week, w)
  }
  return [...weeks.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([weekStart, w]) => ({ weekStart, wpm: Math.round(w.words / (w.secs / 60)) }))
}

/** How many words in every hundred of a story were not yet in the reader's
 *  bank when it was written. Measured against the cards that existed then, not
 *  now: against today's bank every old story would read as easy, and the
 *  number would say nothing about how reading has changed. Names, ignored
 *  words and numerals are nobody's vocabulary and count on neither side. */
export function newPer100(
  story: SavedStory,
  /** Deck word → when it entered the bank, for one deck. */
  addedAt: Map<string, number>,
  ignored: Set<string>,
  langCode: string | null,
): number | null {
  const names = new Set(
    (story.characterNames ?? []).flatMap((n) => tokenizeWords(n, langCode).map(defKey)),
  )
  const cache = new Map<string, 'own' | 'new' | 'skip'>()
  let total = 0
  let fresh = 0
  for (const tok of tokenizeWords(story.story, langCode)) {
    const key = defKey(tok)
    let kind = cache.get(key)
    if (kind === undefined) {
      if (!definable(key) || names.has(key)) kind = 'skip'
      else {
        const match = rootCandidates(key, langCode).find((c) => addedAt.has(c) || ignored.has(c))
        kind =
          match === undefined
            ? 'new'
            : ignored.has(match)
              ? 'skip'
              : addedAt.get(match)! <= story.createdAt
                ? 'own'
                : 'new'
      }
      cache.set(key, kind)
    }
    if (kind === 'skip') continue
    total++
    if (kind === 'new') fresh++
  }
  return total > 0 ? Math.round((fresh / total) * 1000) / 10 : null
}

/** New-words-per-hundred for every story in the window, oldest first. */
export function storyEase(
  stories: SavedStory[],
  cards: Card[],
  languageOf: (deckId: number) => string | undefined,
  from: number,
): { story: SavedStory; newPer100: number }[] {
  const byDeck = new Map<number, { addedAt: Map<string, number>; ignored: Set<string> }>()
  for (const c of cards) {
    const d = byDeck.get(c.deckId) ?? { addedAt: new Map(), ignored: new Set() }
    const key = defKey(c.word)
    if (c.ignored) d.ignored.add(key)
    else d.addedAt.set(key, Math.min(d.addedAt.get(key) ?? Infinity, c.createdAt))
    byDeck.set(c.deckId, d)
  }
  const out: { story: SavedStory; newPer100: number }[] = []
  for (const s of [...stories].sort((a, b) => a.createdAt - b.createdAt)) {
    if (s.createdAt < from) continue
    const deck = byDeck.get(s.deckId) ?? { addedAt: new Map(), ignored: new Set() }
    const n = newPer100(s, deck.addedAt, deck.ignored, langCodeFor(languageOf(s.deckId) ?? ''))
    if (n !== null) out.push({ story: s, newPer100: n })
  }
  return out
}
