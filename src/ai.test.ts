import { describe, expect, it } from 'vitest'
import {
  ApiError,
  MIN_STORY_WORDS,
  writeLadder,
  worthRetrying,
  GLOSSARY_CHUNK_WORDS,
  SIMPLIFY_CHUNK_WORDS,
  groupParagraphs,
  clipWords,
  pickSerialEnding,
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

describe('clipWords', () => {
  it('leaves a text within the limit alone', () => {
    expect(clipWords('a cat eats rice', 50)).toBe('a cat eats rice')
  })

  it('cuts at the limit and says so', () => {
    expect(clipWords('one two three four five', 3)).toBe('one two three…')
  })

  it('normalises stray whitespace and survives an empty summary', () => {
    expect(clipWords('  one   two  ', 5)).toBe('one two')
    expect(clipWords('', 5)).toBe('')
  })
})

describe('pickSerialEnding', () => {
  it('always builds new tension when nothing is open — a fresh part, or one after a resolution', () => {
    for (let i = 0; i < 100; i++) expect(pickSerialEnding(0)).toBe('hook')
  })

  it('never resolves trouble that opened only last part — arcs get room to breathe', () => {
    for (let i = 0; i < 100; i++) expect(pickSerialEnding(3, 1)).toBe('hook')
  })

  it('sometimes resolves and sometimes hooks once tension has aged', () => {
    const drawn = new Set(Array.from({ length: 300 }, () => pickSerialEnding(2, 2)))
    expect(drawn).toEqual(new Set(['hook', 'resolve']))
    // Omitted age counts as old enough.
    const bare = new Set(Array.from({ length: 300 }, () => pickSerialEnding(2)))
    expect(bare).toEqual(new Set(['hook', 'resolve']))
  })
})

describe('writeLadder', () => {
  it('gives ground in stages, on a faster model each time', () => {
    const rungs = writeLadder(1000)
    expect(rungs).toEqual([
      { words: 1000, tier: 'pro' },
      { words: 500, tier: 'fast' },
      { words: 300, tier: 'fast' },
    ])
  })

  it('never asks for a story too short to read', () => {
    for (const length of [300, 500, 800, 1200, 2000]) {
      for (const rung of writeLadder(length)) {
        expect(rung.words).toBeGreaterThanOrEqual(Math.min(length, MIN_STORY_WORDS))
      }
    }
  })

  it('still gives a short request a second try, on the fast model', () => {
    // Halving 400 lands under the floor, so there is no shorter ask to make —
    // but a first attempt that timed out still deserves a second chance.
    const rungs = writeLadder(400)
    expect(rungs).toEqual([
      { words: 400, tier: 'pro' },
      { words: 400, tier: 'fast' },
    ])
  })

  it('shrinks strictly — no rung repeats the ask above it', () => {
    for (const length of [600, 900, 1500]) {
      const words = writeLadder(length).map((r) => r.words)
      expect(words).toEqual([...new Set(words)])
      expect([...words].sort((a, b) => b - a)).toEqual(words)
    }
  })
})

describe('worthRetrying', () => {
  it('retries what time or load caused', () => {
    for (const status of [429, 500, 502, 503, 504]) {
      expect(worthRetrying(new ApiError(status, 'nope'))).toBe(true)
    }
    // A network blip never reached the server — worth one more go.
    expect(worthRetrying(new TypeError('Failed to fetch'))).toBe(true)
  })

  it('does not make the reader wait through a failure that will repeat', () => {
    for (const status of [400, 401, 403, 404]) {
      expect(worthRetrying(new ApiError(status, 'nope'))).toBe(false)
    }
  })
})
