/** Which words of a saved story still need the network.
 *
 *  Tapping a word is answered from three offline sources, in order: the story's
 *  own glossary, a deck card for the word itself, and a deck card for one of its
 *  morphological roots. Anything none of them covers falls through to an AI
 *  lookup — fine at a desk, useless on a plane. This is that gap, computed
 *  ahead of time so it can be filled while there is still a connection. */

import type { Card, SavedStory } from './db'
import { rootCandidates } from './lemma'
import { defKey, splitSentences, tokenizeWords } from './text'

export interface MissingWord {
  /** Surface form as it appears in the story, punctuation stripped. */
  word: string
  key: string
  /** The sentence it was first met in, so the sense can be pinned down. */
  sentence?: string
}

/** Words with no letters at all (bare numerals, symbols) are tappable but have
 *  nothing to define — never worth a round trip. */
export function definable(key: string): boolean {
  return /\p{L}/u.test(key)
}

const strip = (token: string) => token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')

/** Every distinct word of the story that would need an on-demand lookup,
 *  in first-appearance order. */
export function missingDefinitions(
  story: SavedStory,
  cards: Card[],
  langCode: string | null,
): MissingWord[] {
  const covered = new Set<string>()
  for (const c of cards) covered.add(defKey(c.word))
  const deckKeys = new Set(covered)
  for (const g of story.glossary ?? []) covered.add(defKey(g.word))

  const out: MissingWord[] = []
  const seen = new Set<string>()
  for (const sentence of splitSentences(story.story, langCode)) {
    for (const token of tokenizeWords(sentence, langCode)) {
      const key = defKey(token)
      if (!key || seen.has(key) || !definable(key)) continue
      seen.add(key)
      if (covered.has(key)) continue
      // An inflected form of a card the learner already owns resolves offline.
      if (rootCandidates(key, langCode).some((c) => deckKeys.has(c))) continue
      out.push({ word: strip(token), key, sentence })
    }
  }
  return out
}
