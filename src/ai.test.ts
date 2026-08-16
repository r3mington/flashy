import { describe, expect, it } from 'vitest'
import {
  GLOSSARY_CHUNK_WORDS,
  SIMPLIFY_CHUNK_WORDS,
  groupParagraphs,
  pickEnding,
  splitForGlossary,
  swappedWords,
} from './ai'
import { countWords } from './text'

/** A paragraph of roughly `n` words, distinct enough to spot in a chunk. */
function para(n: number, tag: string): string {
  return Array.from({ length: n }, (_, i) => `${tag}${i}`).join(' ') + '.'
}

describe('splitForGlossary', () => {
  it('leaves a short story in one piece', () => {
    const story = `${para(40, 'a')}\n\n${para(40, 'b')}`
    expect(splitForGlossary(story, 'id')).toEqual([story])
  })

  it('keeps every chunk within the budget', () => {
    const story = Array.from({ length: 8 }, (_, i) => para(180, `p${i}_`)).join('\n\n')
    const chunks = splitForGlossary(story, 'id')
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(countWords(chunk, 'id')).toBeLessThanOrEqual(GLOSSARY_CHUNK_WORDS)
    }
  })

  it('loses no words — every chunk word is in the original, and none go missing', () => {
    const story = Array.from({ length: 6 }, (_, i) => para(150, `p${i}_`)).join('\n\n')
    const chunks = splitForGlossary(story, 'id')
    expect(chunks.reduce((n, c) => n + countWords(c, 'id'), 0)).toBe(countWords(story, 'id'))
  })

  it('splits a single oversized paragraph on sentence boundaries', () => {
    // One paragraph, no blank lines, far past the budget — the fallback path.
    const sentences = Array.from({ length: 12 }, (_, i) => para(90, `s${i}_`)).join(' ')
    const chunks = splitForGlossary(sentences, 'id')
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(countWords(chunk, 'id')).toBeLessThanOrEqual(GLOSSARY_CHUNK_WORDS)
    }
  })

  it('never returns nothing, whatever it is handed', () => {
    expect(splitForGlossary('', 'id')).toEqual([''])
    expect(splitForGlossary('halo', 'id')).toEqual(['halo'])
  })
})

describe('groupParagraphs', () => {
  // The simplification pass replaces the story with the joined chunks, so a
  // split that cannot be rejoined faithfully would silently reshape the prose.
  it('rejoins to exactly the original story', () => {
    const story = Array.from({ length: 9 }, (_, i) => para(120, `p${i}_`)).join('\n\n')
    expect(groupParagraphs(story, 'id', SIMPLIFY_CHUNK_WORDS).join('\n\n')).toBe(story)
  })

  it('never splits a paragraph, even one over the budget', () => {
    // A single paragraph past the budget has to survive whole: half a paragraph
    // handed to the editor would come back edited as if it were the end of one.
    const huge = para(900, 'big')
    expect(groupParagraphs(huge, 'id', SIMPLIFY_CHUNK_WORDS)).toEqual([huge])
  })

  it('stays inside the budget wherever the paragraphs allow it', () => {
    const story = Array.from({ length: 9 }, (_, i) => para(120, `p${i}_`)).join('\n\n')
    const chunks = groupParagraphs(story, 'id', SIMPLIFY_CHUNK_WORDS)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(countWords(chunk, 'id')).toBeLessThanOrEqual(SIMPLIFY_CHUNK_WORDS)
    }
  })

  it('never returns nothing, whatever it is handed', () => {
    expect(groupParagraphs('', 'id', SIMPLIFY_CHUNK_WORDS)).toEqual([''])
    expect(groupParagraphs('halo', 'id', SIMPLIFY_CHUNK_WORDS)).toEqual(['halo'])
  })
})

describe('swappedWords', () => {
  it('counts the distinct words the pass removed', () => {
    const before = 'Mata tetua itu menatap tajam ke arah tas.'
    const after = 'Mata orang tua itu melihat ke arah tas.'
    // tetua, menatap and tajam are gone; "orang" arriving does not count.
    expect(swappedWords(before, after, 'id')).toBe(3)
  })

  it('reports nothing when the pass changed nothing', () => {
    const text = 'Dia pergi ke pasar dan membeli nasi.'
    expect(swappedWords(text, text, 'id')).toBe(0)
  })

  it('ignores punctuation and case', () => {
    expect(swappedWords('Dia pergi.', 'dia pergi!', 'id')).toBe(0)
  })
})

describe('pickEnding', () => {
  it('leaves a fresh story open — there is nothing to pay off yet', () => {
    expect(pickEnding({ partsSoFar: 0, openThreads: 0 })).toBe('hook')
    expect(pickEnding({ partsSoFar: 0, openThreads: 5 })).toBe('hook')
  })

  it('pays off every third part', () => {
    const endings = [2, 3, 4, 5, 6, 7, 8].map((partsSoFar) =>
      pickEnding({ partsSoFar, openThreads: 3 }),
    )
    // Parts 3, 6 and 9 — i.e. after 2, 5 and 8 existing parts.
    expect(endings).toEqual(['payoff', 'hook', 'hook', 'payoff', 'hook', 'hook', 'payoff'])
  })

  it('never closes the only open question — that would end the story', () => {
    expect(pickEnding({ partsSoFar: 2, openThreads: 1 })).toBe('hook')
    expect(pickEnding({ partsSoFar: 2, openThreads: 0 })).toBe('hook')
    expect(pickEnding({ partsSoFar: 2, openThreads: 2 })).toBe('payoff')
  })

  it('holds off until a thread has parts behind it', () => {
    expect(pickEnding({ partsSoFar: 1, openThreads: 3 })).toBe('hook')
  })
})
