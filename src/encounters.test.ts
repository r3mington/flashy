import { describe, expect, it } from 'vitest'
import type { SavedStory } from './db'
import { dueForRecurrence, encounterStats, fadeLevel, MAX_FADE } from './encounters'

let nextId = 1
function story(
  text: string,
  opts: { wordsRead?: number; createdAt?: number; lastOpenedAt?: number } = {},
): SavedStory {
  return {
    id: nextId++,
    deckId: 1,
    title: 't',
    story: text,
    translation: '',
    glossary: [],
    createdAt: opts.createdAt ?? 1000,
    wordsRead: opts.wordsRead,
    lastOpenedAt: opts.lastOpenedAt,
  }
}

describe('encounterStats', () => {
  it('credits a word only in stories the reader scrolled past it in', () => {
    // "kucing" is word #2 (0-based) in each story.
    const read = story('Dia lihat kucing itu.', { wordsRead: 4 })
    const abandoned = story('Aku suka kucing kecil.', { wordsRead: 2 }) // stopped before it
    const untouched = story('Ada kucing di sini.')
    const stats = encounterStats([read, abandoned, untouched], 'id')
    expect(stats.get('kucing')?.seen).toBe(1)
    // The abandoned story still credits what WAS read.
    expect(stats.get('aku')?.seen).toBe(1)
    expect(stats.get('suka')?.seen).toBe(1)
    expect(stats.has('ada')).toBe(false)
  })

  it('counts a story once however often the word appears in it', () => {
    const s = story('Kucing, kucing, kucing!', { wordsRead: 3 })
    expect(encounterStats([s], 'id').get('kucing')?.seen).toBe(1)
  })

  it('leaves the open story out', () => {
    const a = story('Nasi enak.', { wordsRead: 2 })
    const b = story('Nasi lagi.', { wordsRead: 2 })
    expect(encounterStats([a, b], 'id', b.id).get('nasi')?.seen).toBe(1)
    expect(encounterStats([a, b], 'id').get('nasi')?.seen).toBe(2)
  })

  it('matches words the way the reader does — case and punctuation aside', () => {
    const s = story('“Kucing!” kata dia.', { wordsRead: 3 })
    const e = encounterStats([s], 'id').get('kucing')
    expect(e?.seen).toBe(1)
    expect(e?.word).toBe('Kucing')
  })

  it('remembers the newest story the word was read in', () => {
    const old = story('Nasi.', { wordsRead: 1, createdAt: 100 })
    const newer = story('Nasi.', { wordsRead: 1, createdAt: 300 })
    const between = story('Nasi.', { wordsRead: 1, createdAt: 200 })
    expect(encounterStats([old, newer, between], 'id').get('nasi')?.lastStoryAt).toBe(300)
  })

  it('dates a reading by the story’s last opening, falling back to creation', () => {
    const reopened = story('Nasi.', { wordsRead: 1, createdAt: 100, lastOpenedAt: 900 })
    const fresh = story('Nasi.', { wordsRead: 1, createdAt: 500 })
    const e = encounterStats([reopened, fresh], 'id').get('nasi')
    expect(e?.times.sort()).toEqual([500, 900])
  })
})

describe('fadeLevel', () => {
  const e = { seen: 3, times: [100, 200, 300], lastStoryAt: 300, word: 'nasi' }

  it('is the number of readings, never tapped', () => {
    expect(fadeLevel(e, undefined)).toBe(3)
  })

  it('counts only readings after the last tap', () => {
    expect(fadeLevel(e, 150)).toBe(2)
    expect(fadeLevel(e, 250)).toBe(1)
    expect(fadeLevel(e, 300)).toBe(0)
  })

  it('caps, and is zero for a word never met', () => {
    const many = { seen: 9, times: [1, 2, 3, 4, 5, 6, 7, 8, 9], lastStoryAt: 9, word: 'x' }
    expect(fadeLevel(many, undefined)).toBe(MAX_FADE)
    expect(fadeLevel(undefined, undefined)).toBe(0)
  })
})

describe('dueForRecurrence', () => {
  const stats = new Map([
    // Met once, one story ago: due (interval 1).
    ['satu', { seen: 1, times: [1], lastStoryAt: 150, word: 'satu' }],
    // Met twice, one story ago: not due (interval 2).
    ['dua', { seen: 2, times: [1, 2], lastStoryAt: 150, word: 'dua' }],
    // Met twice, three stories ago: due, and more overdue than "satu".
    ['tiga', { seen: 2, times: [1, 2], lastStoryAt: 10, word: 'tiga' }],
    // Met five times, four stories ago: interval 16, not due.
    ['lima', { seen: 5, times: [1, 2, 3, 4, 5], lastStoryAt: 10, word: 'lima' }],
  ])
  const storyTimes = [10, 50, 100, 150, 200]

  it('returns only words whose interval has elapsed, most overdue first', () => {
    expect(dueForRecurrence(stats, storyTimes, () => true)).toEqual(['tiga', 'satu'])
  })

  it('skips words the caller does not want back', () => {
    expect(dueForRecurrence(stats, storyTimes, (k) => k !== 'tiga')).toEqual(['satu'])
  })

  it('honours the limit', () => {
    expect(dueForRecurrence(stats, storyTimes, () => true, 1)).toEqual(['tiga'])
  })

  it('is empty with no stories read', () => {
    expect(dueForRecurrence(new Map(), [], () => true)).toEqual([])
  })
})
