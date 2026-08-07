import { describe, expect, it } from 'vitest'
import { statusOf, statusPatch, type Card } from './db'

function card(over: Partial<Card> = {}): Card {
  return {
    id: 1,
    deckId: 1,
    word: 'jawab',
    meaning: 'answer',
    example: '',
    state: 'new',
    due: 0,
    interval: 0,
    ease: 2.5,
    reps: 0,
    lapses: 0,
    createdAt: 0,
    ...over,
  }
}

describe('statusOf', () => {
  it('treats every scheduler state as one in-study bucket', () => {
    // new, learning and review are the scheduler's business — the reader sees
    // one status, not three.
    expect(statusOf(card({ state: 'new' }))).toBe('inStudy')
    expect(statusOf(card({ state: 'learning' }))).toBe('inStudy')
    expect(statusOf(card({ state: 'review' }))).toBe('inStudy')
  })

  it('lets the out-of-study flags win over the scheduler state', () => {
    expect(statusOf(card({ state: 'review', known: true }))).toBe('known')
    expect(statusOf(card({ state: 'learning', ignored: true }))).toBe('ignored')
    // Both set is a corrupt row, but it must still resolve to one answer.
    expect(statusOf(card({ known: true, ignored: true }))).toBe('ignored')
  })
})

describe('statusPatch', () => {
  it('never leaves a card both known and ignored', () => {
    for (const status of ['inStudy', 'known', 'ignored'] as const) {
      const p = statusPatch(status)
      expect(p.known && p.ignored).toBeFalsy()
    }
  })

  it('round-trips through every status', () => {
    expect(statusPatch('known')).toEqual({ known: true, ignored: false })
    expect(statusPatch('ignored')).toEqual({ known: false, ignored: true })
    expect(statusPatch('inStudy')).toEqual({ known: false, ignored: false })
  })

  it('leaves the schedule alone — the way out of a state is to answer the card', () => {
    // A 180-day review card put back in study keeps its interval and due date;
    // nothing here may quietly reset a card's memory.
    for (const status of ['inStudy', 'known', 'ignored'] as const) {
      const p = statusPatch(status)
      expect(p.state).toBeUndefined()
      expect(p.due).toBeUndefined()
      expect(p.interval).toBeUndefined()
      expect(p.reps).toBeUndefined()
    }
  })
})
