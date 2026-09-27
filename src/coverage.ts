/** How much of a story the reader already has — the number that decides how
 *  hard it will be to read. */

/** What a word of the text is to the reader. `skip` is anything that is not
 *  vocabulary: character names, ignored words, bare numerals. */
export type WordKind = 'known' | 'learning' | 'new' | 'skip'

export interface Coverage {
  /** Running words counted — every occurrence, `skip` left out. */
  total: number
  /** Running words of each kind. Repeats count: a word met ten times is ten
   *  words the reader has to get through, which is what difficulty is. */
  known: number
  learning: number
  new: number
  /** Distinct words of each kind — the number of things to learn. */
  distinct: { known: number; learning: number; new: number }
}

/** Sort every word of the text, in order, into known / learning / new. */
export function coverage(keys: Iterable<string>, kindOf: (key: string) => WordKind): Coverage {
  const c: Coverage = { total: 0, known: 0, learning: 0, new: 0, distinct: { known: 0, learning: 0, new: 0 } }
  const seen = new Set<string>()
  for (const key of keys) {
    const kind = kindOf(key)
    if (kind === 'skip') continue
    c.total++
    c[kind]++
    if (!seen.has(key)) {
      seen.add(key)
      c.distinct[kind]++
    }
  }
  return c
}

/** Shares of the running text, in whole percents that add up to 100 —
 *  rounded by largest remainder, so the bar and the labels never disagree
 *  by the odd point. All zero for an empty text. */
export function coverageShares(c: Coverage): { known: number; learning: number; new: number } {
  if (c.total === 0) return { known: 0, learning: 0, new: 0 }
  const kinds = ['known', 'learning', 'new'] as const
  const exact = kinds.map((k) => (c[k] / c.total) * 100)
  const floors = exact.map(Math.floor)
  let left = 100 - floors.reduce((a, b) => a + b, 0)
  const order = kinds.map((_, i) => i).sort((a, b) => exact[b] - floors[b] - (exact[a] - floors[a]))
  for (const i of order) {
    if (left <= 0) break
    floors[i]++
    left--
  }
  return { known: floors[0], learning: floors[1], new: floors[2] }
}

/** How the text will read, from the share of it that comes from the reader's
 *  own bank. The cut-offs are the reading-research ones (Hu & Nation, 2000):
 *  at 98% a text reads unassisted, around 95% it can be followed with some
 *  help, and below 90% most readers lose the thread. Words still in study
 *  count as the reader's — the stories are written to put them there. */
export function difficulty(c: Coverage): { label: string; hint: string } | null {
  if (c.total === 0) return null
  const own = (c.known + c.learning) / c.total
  if (own >= 0.98) return { label: 'Easy', hint: 'Almost every word is yours — reads without stopping' }
  if (own >= 0.95)
    return { label: 'Comfortable', hint: 'Enough new words to learn from, few enough to guess from context' }
  if (own >= 0.9) return { label: 'A stretch', hint: 'Expect to tap a word most sentences' }
  return { label: 'Hard', hint: 'More than one word in ten is new — the plot will be hard to follow' }
}
