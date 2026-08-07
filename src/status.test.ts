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
  it('reads the learning bucket off the scheduler state', () => {
    expect(statusOf(card({ state: 'learning' }))).toBe('learning')
    expect(statusOf(card({ state: 'new' }))).toBe('unknown')
    expect(statusOf(card({ state: 'review' }))).toBe('unknown')
  })

  it('lets the out-of-study flags win over a stale scheduler state', () => {
    expect(statusOf(card({ state: 'learning', known: true }))).toBe('known')
    expect(statusOf(card({ state: 'learning', ignored: true }))).toBe('ignored')
    // Both set is a corrupt row, but it must still resolve to one answer.
    expect(statusOf(card({ known: true, ignored: true }))).toBe('ignored')
  })
})

describe('statusPatch', () => {
  it('never leaves a card both known and ignored', () => {
    for (const status of ['unknown', 'learning', 'known', 'ignored'] as const) {
      const p = statusPatch(status, card({ known: true, ignored: true }))
      expect(p.known && p.ignored).toBeFalsy()
    }
  })

  it('pulls a long-interval review card back to the front of the queue', () => {
    const p = statusPatch('learning', card({ state: 'review', interval: 180, reps: 9 }))
    expect(p.state).toBe('learning')
    expect(p.interval).toBe(0)
    expect(p.due).toBeLessThanOrEqual(Date.now())
  })

  it('leaves an already-learning card where it is', () => {
    const p = statusPatch('learning', card({ state: 'learning', due: 123 }))
    expect(p.state).toBeUndefined()
    expect(p.due).toBeUndefined()
  })

  it('hands an ungraded learning card back to new when the claim is released', () => {
    const p = statusPatch('unknown', card({ state: 'learning', reps: 0 }))
    expect(p.state).toBe('new')
  })

  it('will not relabel a learning card the scheduler earned', () => {
    // reps > 0 means it got there by being answered "again" — the way out is
    // to answer it, not to flip a label.
    const p = statusPatch('unknown', card({ state: 'learning', reps: 3 }))
    expect(p.state).toBeUndefined()
    expect(p.known).toBe(false)
    expect(p.ignored).toBe(false)
  })

  it('restores a known card to study without touching its schedule', () => {
    const p = statusPatch('unknown', card({ state: 'review', interval: 42, known: true }))
    expect(p.known).toBe(false)
    expect(p.state).toBeUndefined()
    expect(p.interval).toBeUndefined()
  })

  it('marks a brand-new card as learning when it is added straight from a story', () => {
    // No card argument — the add path patches the row before it exists.
    const p = statusPatch('learning')
    expect(p.state).toBe('learning')
    expect(p.known).toBe(false)
  })
})
