import { describe, expect, it } from 'vitest'
import { DAY, formatAgo, formatDuration, startOfDay, startOfToday } from './time'

describe('startOfDay', () => {
  it('zeroes the clock and is idempotent', () => {
    const t = startOfDay(Date.now())
    expect(new Date(t).getHours()).toBe(0)
    expect(startOfDay(t)).toBe(t)
  })

  it('puts any moment of a day on the same key', () => {
    const morning = new Date(2026, 6, 31, 6, 30).getTime()
    const night = new Date(2026, 6, 31, 23, 59).getTime()
    expect(startOfDay(morning)).toBe(startOfDay(night))
  })

  it('separates adjacent days by exactly one DAY', () => {
    const d = startOfDay(new Date(2026, 6, 31, 12).getTime())
    const next = startOfDay(new Date(2026, 7, 1, 12).getTime())
    expect(next - d).toBe(DAY)
  })
})

describe('startOfToday', () => {
  it('agrees with startOfDay(now)', () => {
    expect(startOfToday()).toBe(startOfDay(Date.now()))
  })
})

describe('formatDuration', () => {
  // These used to differ by screen: the stats copy rounded, the story copy
  // floored, so 110s read as "2m" in one place and "1m" in the other.
  it.each([
    [0, '0s'],
    [45, '45s'],
    [59, '59s'],
    [90, '2m'],
    [110, '2m'],
    [3600, '1h 0m'],
    [3900, '1h 5m'],
  ])('%is → %s', (secs, want) => expect(formatDuration(secs)).toBe(want))
})

describe('formatAgo', () => {
  const now = new Date(2026, 6, 31, 12).getTime()
  it.each([
    [0, 'today'],
    [1, 'yesterday'],
    [3, '3d ago'],
    [10, '1w ago'],
    [60, '2mo ago'],
    [400, '1y ago'],
  ])('%i days back → %s', (days, want) => expect(formatAgo(now - days * DAY, now)).toBe(want))

  it('counts whole days, so late last night is still yesterday', () => {
    const lateLastNight = new Date(2026, 6, 30, 23, 50).getTime()
    expect(formatAgo(lateLastNight, now)).toBe('yesterday')
  })
})
