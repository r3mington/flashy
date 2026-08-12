import { describe, expect, it } from 'vitest'
import { pickEnding } from './ai'

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
