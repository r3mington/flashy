import { describe, expect, it } from 'vitest'
import type { Card, ReadingLog, SavedStory } from '../../db'
import { nextDay, startOfDay } from '../../time'
import {
  CLEAN_READING_FROM,
  daysBetween,
  inceptionDay,
  newPer100,
  readingSpeed,
  storyEase,
  weeklySpeed,
  wordsTrackedFrom,
} from './progress'

const day = (y: number, m: number, d: number) => new Date(y, m - 1, d).getTime()
const TODAY = day(2026, 11, 20)

function card(word: string, createdAt: number, over: Partial<Card> = {}): Card {
  return { id: 0, deckId: 1, word, meaning: '', example: '', createdAt, state: 'new', due: 0, interval: 0, ease: 2.5, reps: 0, lapses: 0, ...over } as Card
}

function story(text: string, createdAt: number, over: Partial<SavedStory> = {}): SavedStory {
  return { id: 1, deckId: 1, title: 't', story: text, translation: '', glossary: [], createdAt, ...over }
}

describe('inceptionDay', () => {
  const raw = {
    decks: [
      { id: 1, createdAt: day(2026, 7, 10) + 5000 },
      { id: 2, createdAt: day(2026, 9, 1) },
    ],
    cards: [card('a', day(2026, 9, 3), { deckId: 2 })],
    reviews: [],
    reading: [{ day: day(2026, 7, 1), seconds: 60 }],
  }

  it('starts all decks at the oldest thing on record', () => {
    expect(inceptionDay(raw, 'all', TODAY)).toBe(day(2026, 7, 1))
  })

  it('starts one deck at its own creation, ignoring reading', () => {
    expect(inceptionDay(raw, 1, TODAY)).toBe(day(2026, 7, 10))
    expect(inceptionDay(raw, 2, TODAY)).toBe(day(2026, 9, 1))
  })

  it('moves earlier for cards older than their deck', () => {
    const r = { ...raw, cards: [card('a', day(2026, 8, 20), { deckId: 2 })] }
    expect(inceptionDay(r, 2, TODAY)).toBe(day(2026, 8, 20))
  })

  it('is today when there is nothing yet', () => {
    expect(inceptionDay({ decks: [], cards: [], reviews: [], reading: [] }, 'all', TODAY)).toBe(TODAY)
  })
})

describe('daysBetween', () => {
  it('counts both ends', () => {
    expect(daysBetween(TODAY, TODAY)).toBe(1)
    expect(daysBetween(day(2026, 11, 1), TODAY)).toBe(20)
  })
})

describe('wordsTrackedFrom', () => {
  it('is the first day a row carries a word count', () => {
    const rows: ReadingLog[] = [
      { day: day(2026, 7, 1), seconds: 100 },
      { day: day(2026, 7, 28), seconds: 100, words: 0 },
      { day: day(2026, 8, 2), seconds: 100, words: 400 },
    ]
    expect(wordsTrackedFrom(rows)).toBe(day(2026, 7, 28))
    expect(wordsTrackedFrom([{ day: day(2026, 7, 1), seconds: 1 }])).toBeNull()
  })
})

describe('readingSpeed', () => {
  const clean = CLEAN_READING_FROM
  const rows: ReadingLog[] = [
    // Before the clock fix: inflated time, never used.
    { day: day(2026, 10, 20), seconds: 3600, words: 300 },
    { day: clean, seconds: 600, words: 600 },
    { day: nextDay(clean), seconds: 300, words: 300 },
    // Under a minute, or no words: not a reading day.
    { day: nextDay(nextDay(clean)), seconds: 30, words: 100 },
  ]

  it('divides words by minutes over clean days only', () => {
    expect(readingSpeed(rows, day(2026, 1, 1), TODAY)).toEqual({ wpm: 60, days: 2 })
  })

  it('keeps to the window', () => {
    expect(readingSpeed(rows, nextDay(clean), TODAY)).toEqual({ wpm: 60, days: 1 })
    expect(readingSpeed(rows, TODAY, TODAY)).toBeNull()
  })

  it('groups by calendar week', () => {
    const weeks = weeklySpeed(
      [...rows, { day: day(2026, 11, 9), seconds: 600, words: 1200 }],
      day(2026, 1, 1),
      TODAY,
    )
    expect(weeks.map((w) => w.wpm)).toEqual([60, 120])
    expect(new Date(weeks[0].weekStart).getDay()).toBe(0)
  })
})

describe('newPer100', () => {
  const at = startOfDay(day(2026, 9, 1))
  const bank = new Map([
    ['kopi', at - 1],
    ['minum', at - 1],
    ['warung', at + 1], // added after the story: still new to it
  ])

  it('counts words that were not in the bank when the story was written', () => {
    // minum kopi di warung → "di" and "warung" are new: 2 in 4
    expect(newPer100(story('Minum kopi di warung.', at), bank, new Set(), 'id')).toBe(50)
  })

  it('credits a word through its root, and skips names and ignored words', () => {
    const s = story('Rian meminum kopi Grab.', at, { characterNames: ['Rian'] })
    expect(newPer100(s, bank, new Set(['grab']), 'id')).toBe(0)
  })

  it('measures each story against the bank of its own day', () => {
    const cards = [card('kopi', at - 1), card('warung', at + 1)]
    const ease = storyEase(
      [story('kopi warung', at + 2, { id: 2 }), story('kopi warung', at, { id: 1 })],
      cards,
      () => 'Indonesian',
      0,
    )
    expect(ease.map((e) => [e.story.id, e.newPer100])).toEqual([
      [1, 50],
      [2, 0],
    ])
  })
})
