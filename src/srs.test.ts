import { describe, expect, it } from 'vitest'
import { previewInterval, schedule, type Grade } from './srs'
import { newCardDefaults, type Card, type Scheduler } from './db'

const NOW = Date.UTC(2026, 6, 31, 9)

const card = (over: Partial<Card> = {}): Card =>
  ({ id: 1, deckId: 1, word: 'beli', meaning: 'buy', example: '', ...newCardDefaults(), ...over }) as Card

const review = (over: Partial<Card> = {}) =>
  card({ state: 'review', interval: 10, ease: 2.5, reps: 3, ...over })

describe.each<Scheduler>(['sm2', 'fsrs'])('schedule (%s) — invariants', (scheduler) => {
  const grades: Grade[] = ['again', 'hard', 'good', 'easy']

  it.each(grades)('%s always schedules into the future', (grade) => {
    for (const c of [card(), card({ state: 'learning' }), review()]) {
      expect(schedule(c, grade, scheduler, NOW).due!).toBeGreaterThan(NOW)
    }
  })

  it.each(grades)('%s never returns a negative interval', (grade) => {
    expect(schedule(review(), grade, scheduler, NOW).interval!).toBeGreaterThanOrEqual(0)
  })

  it('orders the grades: again ≤ hard ≤ good ≤ easy', () => {
    const due = (g: Grade) => schedule(review(), g, scheduler, NOW).due!
    expect(due('again')).toBeLessThanOrEqual(due('hard'))
    expect(due('hard')).toBeLessThanOrEqual(due('good'))
    expect(due('good')).toBeLessThanOrEqual(due('easy'))
  })

  it('sends a lapsed review card back to learning', () => {
    const next = schedule(review(), 'again', scheduler, NOW)
    expect(next.state).not.toBe('review')
  })
})

describe('schedule (sm2) — specifics', () => {
  it('graduates a new card and counts the rep', () => {
    const next = schedule(card(), 'good', 'sm2', NOW)
    expect(next.state).toBe('review')
    expect(next.reps).toBe(1)
    expect(next.interval).toBe(1)
  })

  it('gives an easy new card a 4-day head start', () => {
    expect(schedule(card(), 'easy', 'sm2', NOW).interval).toBe(4)
  })

  it('multiplies the interval by ease on a good review', () => {
    const next = schedule(review({ interval: 10, ease: 2.5 }), 'good', 'sm2', NOW)
    expect(next.interval).toBe(25)
  })

  it('counts a lapse only when a review card fails', () => {
    expect(schedule(review({ lapses: 2 }), 'again', 'sm2', NOW).lapses).toBe(3)
    // A learning card that fails was never "known", so it isn't a lapse.
    expect(schedule(card({ state: 'learning', lapses: 0 }), 'again', 'sm2', NOW).lapses).toBe(0)
  })

  it('never lets ease fall below the 1.3 floor', () => {
    let c = review({ ease: 1.35 })
    for (let i = 0; i < 10; i++) c = { ...c, ...schedule(c, 'again', 'sm2', NOW) } as Card
    expect(c.ease).toBeGreaterThanOrEqual(1.3)
  })

  it('caps the interval at ten years', () => {
    const next = schedule(review({ interval: 365 * 9, ease: 2.5 }), 'easy', 'sm2', NOW)
    expect(next.interval).toBeLessThanOrEqual(365 * 10)
  })
})

describe('schedule (fsrs)', () => {
  it('records the memory state SM-2 does not track', () => {
    const next = schedule(card(), 'good', 'fsrs', NOW)
    expect(next.stability).toBeGreaterThan(0)
    expect(next.difficulty).toBeGreaterThan(0)
    expect(next.lastReview).toBe(NOW)
  })

  it('leaves ease alone so switching back to SM-2 still works', () => {
    expect(schedule(review({ ease: 2.42 }), 'good', 'fsrs', NOW).ease).toBe(2.42)
  })

  it('seeds stability from the SM-2 interval on a card with no FSRS state', () => {
    const next = schedule(review({ interval: 40, stability: undefined }), 'good', 'fsrs', NOW)
    expect(next.stability).toBeGreaterThan(0)
  })
})

describe('previewInterval', () => {
  it('renders each magnitude with the right unit', () => {
    expect(previewInterval(card(), 'again', 'sm2')).toMatch(/m$/)
    expect(previewInterval(card(), 'good', 'sm2')).toBe('1d')
    expect(previewInterval(review({ interval: 20, ease: 2.5 }), 'good', 'sm2')).toMatch(/mo$/)
    expect(previewInterval(review({ interval: 300, ease: 2.5 }), 'good', 'sm2')).toMatch(/y$/)
  })
})
