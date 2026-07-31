import { describe, expect, it } from 'vitest'
import { countByDay, currentStreak, longestStreak, nextMilestone, retention } from './stats'
import { DAY, startOfDay } from './time'
import type { Review } from './db'

const today = startOfDay(Date.UTC(2026, 6, 31, 12))

describe('currentStreak', () => {
  it('counts back from today', () => {
    const days = new Set([today, today - DAY, today - 2 * DAY])
    expect(currentStreak(days, today)).toBe(3)
  })

  it("survives a today that hasn't been studied yet", () => {
    const days = new Set([today - DAY, today - 2 * DAY])
    expect(currentStreak(days, today)).toBe(2)
  })

  it('breaks on a genuine gap', () => {
    expect(currentStreak(new Set([today, today - 2 * DAY]), today)).toBe(1)
    expect(currentStreak(new Set([today - 2 * DAY]), today)).toBe(0)
  })

  it('is 0 with no activity', () => {
    expect(currentStreak(new Set(), today)).toBe(0)
  })
})

describe('longestStreak', () => {
  it('finds the best run, not the latest', () => {
    const days = new Set([
      today - 10 * DAY, today - 9 * DAY, today - 8 * DAY, today - 7 * DAY,
      today,
    ])
    expect(longestStreak(days)).toBe(4)
  })

  it('is 0 when empty and 1 for a single day', () => {
    expect(longestStreak(new Set())).toBe(0)
    expect(longestStreak(new Set([today]))).toBe(1)
  })
})

describe('retention', () => {
  const rev = (over: Partial<Review>): Review =>
    ({ id: 1, cardId: 1, deckId: 1, grade: 'good', ts: today, ...over }) as Review

  it('keeps still-new cards out of young/mature, the numbers people quote', () => {
    const r = retention([rev({ state: 'new', interval: 0 })])
    expect(r.overallCount).toBe(1)
    expect(r.youngCount).toBe(0)
    expect(r.matureCount).toBe(0)
    expect(r.young).toBeNull()
    expect(r.mature).toBeNull()
  })

  it('treats only "again" as a failure — hard still passes', () => {
    const rs = [
      rev({ state: 'review', interval: 30, grade: 'good' }),
      rev({ state: 'review', interval: 30, grade: 'hard' }),
      rev({ state: 'review', interval: 30, grade: 'again' }),
    ]
    const r = retention(rs)
    expect(r.matureCount).toBe(3)
    expect(r.mature).toBe(67) // 2 of 3
  })

  it('splits young from mature at the 21-day boundary', () => {
    const r = retention([
      rev({ state: 'review', interval: 20 }),
      rev({ state: 'review', interval: 21 }),
    ])
    expect(r.youngCount).toBe(1)
    expect(r.matureCount).toBe(1)
  })
})

describe('countByDay', () => {
  it('buckets by local day', () => {
    const m = countByDay(
      [{ t: today + 3600_000 }, { t: today + 7200_000 }, { t: today + DAY }],
      (x) => x.t,
    )
    expect(m.get(today)).toBe(2)
    expect(m.get(today + DAY)).toBe(1)
  })
})

describe('nextMilestone', () => {
  it('always looks ahead, never at or behind', () => {
    for (const n of [0, 1, 9, 10, 99, 100, 4999]) {
      expect(nextMilestone(n)).toBeGreaterThan(n)
    }
  })
})
