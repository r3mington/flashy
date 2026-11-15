/** The most common words of a language, checked against a deck.
 *
 *  The list itself is built offline by `scripts/build-common-words.mts` from a
 *  subtitle word count (CC BY-SA 4.0 — the data file carries the credit). It
 *  is ordered by how often each entry turns up, every form of it counted. */

import type { Card } from './db'
import { rootCandidates } from './lemma'
import { defKey } from './text'

export interface CommonEntry {
  /** Place in the list, from 1. */
  rank: number
  word: string
  meaning: string
  /** Other forms of it seen in the source (bukunya, buku-buku…). */
  forms: string[]
}

/** The shape the data file is stored in: one row per entry, rank by position. */
export interface CommonList {
  language: string
  source: string
  license: string
  words: [string, string, string[]][]
}

export function entriesOf(list: CommonList): CommonEntry[] {
  return list.words.map(([word, meaning, forms], i) => ({ rank: i + 1, word, meaning, forms }))
}

export type CommonStatus = 'known' | 'study' | 'ignored' | 'missing'

/** The bands the page counts in. Each includes the ones above it — the top
 *  2,000 is the top 1,000 and the next thousand. */
export const COMMON_BANDS = [1000, 2000, 3000, 4000] as const

function cardStatus(c: Card): Exclude<CommonStatus, 'missing'> {
  return c.ignored ? 'ignored' : c.known ? 'known' : 'study'
}

const RANK: Record<CommonStatus, number> = { missing: 0, ignored: 1, study: 2, known: 3 }

/** Which of the entries the deck has, and how far along each one is.
 *  Entries the deck does not cover are simply absent from the map.
 *
 *  A card covers an entry when it IS the entry or one of its listed forms, or
 *  when the entry is the root the card is built on — a card for "makanan"
 *  covers "makan". Not the other way round: the list gives derived words
 *  that mean something new ("pekerjaan", a job) their own entry, and a card
 *  for "kerja" does not mean you know it.
 *
 *  A card for the entry word itself decides its status outright, so marking
 *  "makan" known, studying or ignored on the page always shows. Otherwise the
 *  furthest-along covering card wins: known, then studying, then ignored. */
export function commonStatuses(
  entries: CommonEntry[],
  cards: Card[],
  langCode: string | null,
): Map<string, Exclude<CommonStatus, 'missing'>> {
  const byKey = new Map<string, string[]>()
  const note = (key: string, word: string) => {
    const k = defKey(key)
    if (!k) return
    const list = byKey.get(k)
    if (list) {
      if (!list.includes(word)) list.push(word)
    } else byKey.set(k, [word])
  }
  for (const e of entries) {
    note(e.word, e.word)
    for (const f of e.forms) note(f, e.word)
  }
  const entryWords = new Set(entries.map((e) => defKey(e.word)))

  const own = new Map<string, Exclude<CommonStatus, 'missing'>>()
  const best = new Map<string, Exclude<CommonStatus, 'missing'>>()
  const mark = (word: string, s: Exclude<CommonStatus, 'missing'>) => {
    const was = best.get(word)
    if (!was || RANK[s] > RANK[was]) best.set(word, s)
  }
  for (const c of cards) {
    const key = defKey(c.word)
    if (!key) continue
    const status = cardStatus(c)
    if (entryWords.has(key)) {
      const was = own.get(key)
      if (!was || RANK[status] > RANK[was]) own.set(key, status)
    }
    for (const w of byKey.get(key) ?? []) mark(w, status)
    for (const root of rootCandidates(key, langCode)) {
      if (root !== key && entryWords.has(root)) mark(root, status)
    }
  }
  for (const [w, s] of own) best.set(w, s)
  return best
}

/** The cards that ARE this entry — its own word, or one of its listed forms.
 *  What a status change on the page rewrites; a card that only covers the
 *  entry through its root ("makanan" for "makan") is a different word and is
 *  left alone. */
export function entryCards(entry: CommonEntry, cards: Card[]): Card[] {
  const keys = new Set([entry.word, ...entry.forms].map(defKey))
  return cards.filter((c) => keys.has(defKey(c.word)))
}

/** How much of the top `size` the deck covers. */
export function bandProgress(
  entries: CommonEntry[],
  statuses: Map<string, CommonStatus>,
  size: number,
): { size: number; known: number; study: number; ignored: number } {
  let known = 0
  let study = 0
  let ignored = 0
  for (const e of entries.slice(0, size)) {
    const s = statuses.get(e.word)
    if (s === 'known') known++
    else if (s === 'study') study++
    else if (s === 'ignored') ignored++
  }
  return { size: Math.min(size, entries.length), known, study, ignored }
}

/** Common words the reader has never met: not in the deck in any form, and
 *  not read in any story — handed to the story writer so the next story
 *  closes a gap in what everyone says, rather than only drawing on whatever
 *  the deck happens to hold.
 *
 *  "Never read" is what keeps this honest. A deck rarely has a card for
 *  "yang" or "di", but anyone who has read one story has met them, and they
 *  need no help turning up in the next. Once a word here has been read, the
 *  story page's own spacing (`dueForRecurrence`) is what brings it back.
 *
 *  A random few from the commonest `window` rather than the very first ones:
 *  a writer told to use the same six words every time writes the same story. */
export function unmetCommon(
  entries: CommonEntry[],
  statuses: Map<string, CommonStatus>,
  met: (key: string) => boolean,
  opts: {
    limit?: number
    window?: number
    random?: () => number
    /** Words wrong for this story whatever their frequency — the formal
     *  "saya" in a story told in casual speech (see `unsuitableForStory`). */
    skip?: (word: string) => boolean
  } = {},
): string[] {
  const { limit = 6, window = 24, random = Math.random, skip } = opts
  const pool: string[] = []
  for (const e of entries) {
    if (pool.length >= window) break
    if (statuses.has(e.word)) continue
    if (skip?.(e.word)) continue
    if ([e.word, ...e.forms].some((f) => met(defKey(f)))) continue
    pool.push(e.word)
  }
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
  }
  return pool.slice(0, limit)
}

/** Where a word sits in the list, and how it was found there. */
export interface RankHit {
  /** Place in the list, from 1. */
  rank: number
  /** The entry the place belongs to. */
  word: string
  /** `word`: it is the entry, or one of the forms counted into it.
   *  `root`: only the word it is built on is listed — the place is the
   *  root's, not the word's own, and has to be shown as such. */
  via: 'word' | 'root'
}

/** Every spelling the list knows, pointing at the entry it was counted into.
 *  An entry's own word beats a form of some other entry ("pekerjaan" is its
 *  own entry before it is a form of "kerja"); between two entries claiming
 *  the same form, the commoner one keeps it. */
export function rankIndex(entries: CommonEntry[]): Map<string, CommonEntry> {
  const index = new Map<string, CommonEntry>()
  for (const e of entries) {
    const k = defKey(e.word)
    if (k) index.set(k, e)
  }
  for (const e of entries) {
    for (const f of e.forms) {
      const k = defKey(f)
      if (k && !index.has(k)) index.set(k, e)
    }
  }
  return index
}

/** The place of a tapped word in the list, or null when neither it nor the
 *  word it is built on is there.
 *
 *  The word itself (or a listed form of it) first. Failing that its root:
 *  the one the dictionary named if there is one — it read the sentence —
 *  and otherwise whatever stripping affixes turns up, the commonest match. */
export function rankOf(
  index: Map<string, CommonEntry>,
  word: string,
  langCode: string | null,
  root?: string,
): RankHit | null {
  const key = defKey(word)
  if (!key) return null
  const own = index.get(key)
  if (own) return { rank: own.rank, word: own.word, via: 'word' }

  const named = root ? index.get(defKey(root)) : undefined
  if (named) return { rank: named.rank, word: named.word, via: 'root' }

  let best: CommonEntry | undefined
  for (const c of rootCandidates(key, langCode)) {
    const e = c === key ? undefined : index.get(c)
    if (e && (!best || e.rank < best.rank)) best = e
  }
  return best ? { rank: best.rank, word: best.word, via: 'root' } : null
}

/** Which colour of badge a place earns — the same five steps as the
 *  dictionary's own estimate (`FREQ_BANDS`), so both read alike. */
export function rankBand(rank: number): number {
  return rank <= 500 ? 1 : rank <= 1000 ? 2 : rank <= 2000 ? 3 : rank <= 4000 ? 4 : 5
}

/** "164th", "2nd", "1,013th". */
export function ordinal(n: number): string {
  const tens = n % 100
  const suffix = tens >= 11 && tens <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')
  return `${n.toLocaleString('en-US')}${suffix}`
}
