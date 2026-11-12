/** The most common words of a language, checked against a deck.
 *
 *  The list itself is built offline by `scripts/build-common-words.mts` from a
 *  subtitle word count (CC BY-SA 4.0 — the data file carries the credit). It
 *  is ordered by how often each entry turns up, every form of it counted. */

import { inRotation, type Card } from './db'
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

export type CommonStatus = 'known' | 'study' | 'missing'

/** The bands the page counts in. Each includes the ones above it — the top
 *  2,000 is the top 1,000 and the next thousand. */
export const COMMON_BANDS = [1000, 2000, 3000, 4000] as const

/** Which of the entries the deck has, and how far along each one is.
 *
 *  A card covers an entry when it IS the entry or one of its listed forms, or
 *  when the entry is the root the card is built on — a card for "makanan"
 *  covers "makan". Not the other way round: the list gives derived words
 *  that mean something new ("pekerjaan", a job) their own entry, and a card
 *  for "kerja" does not mean you know it. Known beats in study when several
 *  cards cover one entry; ignored cards cover nothing. */
export function commonStatuses(
  entries: CommonEntry[],
  cards: Card[],
  langCode: string | null,
): Map<string, CommonStatus> {
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

  const out = new Map<string, CommonStatus>()
  const mark = (word: string, s: CommonStatus) => {
    if (out.get(word) !== 'known') out.set(word, s)
  }
  for (const c of cards) {
    if (c.ignored) continue
    const status: CommonStatus = c.known ? 'known' : inRotation(c) ? 'study' : 'missing'
    if (status === 'missing') continue
    const key = defKey(c.word)
    if (!key) continue
    for (const w of byKey.get(key) ?? []) mark(w, status)
    for (const root of rootCandidates(key, langCode)) {
      if (root !== key && entryWords.has(root)) mark(root, status)
    }
  }
  return out
}

/** How much of the top `size` the deck covers. */
export function bandProgress(
  entries: CommonEntry[],
  statuses: Map<string, CommonStatus>,
  size: number,
): { size: number; known: number; study: number } {
  let known = 0
  let study = 0
  for (const e of entries.slice(0, size)) {
    const s = statuses.get(e.word)
    if (s === 'known') known++
    else if (s === 'study') study++
  }
  return { size: Math.min(size, entries.length), known, study }
}
