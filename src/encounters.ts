/** How often the reader has met each word, worked out from the stories they
 *  have read — and, from that, which words are due to come round again.
 *
 *  Nothing here is logged separately. A story already records its text, when
 *  it was opened and how far into it the reader scrolled (`wordsRead`, the
 *  high-water mark that drives the daily count), and those three facts are
 *  the whole answer: a word was ENCOUNTERED in a story if it sits before the
 *  mark. Deriving it keeps a single source of truth — there is no counter to
 *  fall out of step with the stories, nothing to migrate, and a story the
 *  reader abandoned at the second paragraph honestly credits only its first
 *  paragraph's words.
 *
 *  The one thing a story cannot tell us is whether the reader TAPPED a word,
 *  which is the signal that it had not stuck. That lives in `wordTaps`, and
 *  `fadeLevel` combines the two: encounters since the last tap. */

import type { SavedStory } from './db'
import { defKey, tokenizeWords } from './text'

/** What the stories say about one word. */
export interface Encounter {
  /** Stories the word was read in. Each story counts once, however often it
   *  was reopened or the word appeared in it. */
  seen: number
  /** When each of those readings happened (the story's last opening, or its
   *  creation when it has never been reopened), for counting encounters that
   *  came after a tap. */
  times: number[]
  /** `createdAt` of the newest story the word was read in — the yardstick for
   *  "how many stories ago", which is what spacing is measured in. */
  lastStoryAt: number
  /** Surface form the word was first met as, for showing or prompting with. */
  word: string
}

/** Word index of each distinct word's first appearance — numbered the way the
 *  reader's layout numbers them, so the index is comparable with `wordsRead`.
 *  Cached by story, since a live query hands back fresh objects for the same
 *  story every few seconds while reading. */
const firstIndexCache = new Map<number, { text: string; index: Map<string, [number, string]> }>()

function firstIndexByKey(story: SavedStory, langCode: string | null): Map<string, [number, string]> {
  const hit = firstIndexCache.get(story.id)
  if (hit && hit.text === story.story) return hit.index
  const index = new Map<string, [number, string]>()
  let w = -1
  for (const tok of tokenizeWords(story.story, langCode)) {
    const key = defKey(tok)
    if (!key) continue
    w++
    if (!index.has(key)) index.set(key, [w, tok.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')])
  }
  firstIndexCache.set(story.id, { text: story.story, index })
  return index
}

/** Every word the reader has read, across the stories given, with how often.
 *  `exclude` leaves one story out — the one open now, whose words are being
 *  met as we speak and must not count towards their own highlighting. */
export function encounterStats(
  stories: SavedStory[],
  langCode: string | null,
  exclude?: number,
): Map<string, Encounter> {
  const out = new Map<string, Encounter>()
  for (const s of stories) {
    if (s.id === exclude) continue
    const mark = s.wordsRead ?? 0
    if (mark <= 0) continue
    const at = s.lastOpenedAt ?? s.createdAt
    for (const [key, [idx, word]] of firstIndexByKey(s, langCode)) {
      if (idx >= mark) continue
      const e = out.get(key)
      if (e) {
        e.seen++
        e.times.push(at)
        if (s.createdAt > e.lastStoryAt) e.lastStoryAt = s.createdAt
      } else {
        out.set(key, { seen: 1, times: [at], lastStoryAt: s.createdAt, word })
      }
    }
  }
  return out
}

/** How far a word's highlight has faded: the number of stories it has been
 *  read in since the reader last tapped it, capped. Zero is the full colour.
 *
 *  A tap resets the fade because a tap means the word had not stuck — the
 *  reader needed the meaning again — and the colour should come back to say
 *  so. Reading past it without tapping, story after story, is the evidence
 *  that it has. */
export const MAX_FADE = 4

export function fadeLevel(e: Encounter | undefined, lastTapAt: number | undefined): number {
  if (!e) return 0
  const since = lastTapAt == null ? e.seen : e.times.filter((t) => t > lastTapAt).length
  return Math.min(MAX_FADE, since)
}

/** Stories between readings before a word is due again: 1, 2, 4, 8, 16 —
 *  expanding with each reading, the way spaced repetition does, so a word the
 *  reader has met once comes straight back and one met five times is left
 *  alone for a while. */
function intervalFor(seen: number): number {
  return [1, 2, 4, 8, 16][Math.min(seen, 5) - 1]
}

/** Words due to come round again in the next story, most overdue first.
 *
 *  `storyTimes` is every story's `createdAt`, so "stories since" can be
 *  counted; `wanted` says which words are worth bringing back at all — the
 *  caller knows which are still being learned, and a word long since known
 *  is not a re-encounter, just a word. */
export function dueForRecurrence(
  stats: Map<string, Encounter>,
  storyTimes: number[],
  wanted: (key: string) => boolean,
  limit = 8,
): string[] {
  const scored: { word: string; score: number }[] = []
  for (const [key, e] of stats) {
    if (!wanted(key)) continue
    const since = storyTimes.filter((t) => t > e.lastStoryAt).length
    const interval = intervalFor(e.seen)
    if (since < interval) continue
    scored.push({ word: e.word, score: since / interval })
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.word)
}
