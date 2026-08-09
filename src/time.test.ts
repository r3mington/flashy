import { describe, expect, it } from 'vitest'
import {
  DAY,
  formatAgo,
  formatDuration,
  nextDay,
  normalizeDay,
  prevDay,
  startOfDay,
  startOfToday,
} from './time'

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

describe('normalizeDay', () => {
  const midnight = startOfDay(new Date(2026, 6, 31, 12).getTime())

  it('leaves a key already on the grid alone', () => {
    expect(normalizeDay(midnight)).toBe(midnight)
  })

  it('pulls a key written under another UTC offset back onto the grid', () => {
    // A row written at UTC+7 and read at UTC+2 sits 5h before today's
    // midnight; one written the other way round sits hours after. Both still
    // belong to the same calendar day.
    expect(normalizeDay(midnight - 5 * 3600_000)).toBe(midnight)
    expect(normalizeDay(midnight + 7 * 3600_000)).toBe(midnight)
  })
})

describe('prevDay / nextDay', () => {
  const d = startOfDay(new Date(2026, 6, 31, 12).getTime())

  it('walk one calendar day at a time', () => {
    expect(prevDay(d)).toBe(startOfDay(new Date(2026, 6, 30, 12).getTime()))
    expect(nextDay(d)).toBe(startOfDay(new Date(2026, 7, 1, 12).getTime()))
    expect(nextDay(prevDay(d))).toBe(d)
  })

  it('stays on midnights across a DST transition', () => {
    // Harmless in fixed-offset zones (a plain 24h step); in a DST zone the
    // last Sunday of October 2026 is 25h long and `+ DAY` would land at 23:00.
    let cursor = startOfDay(new Date(2026, 9, 20, 12).getTime())
    for (let i = 0; i < 14; i++) {
      cursor = nextDay(cursor)
      expect(new Date(cursor).getHours()).toBe(0)
    }
    for (let i = 0; i < 14; i++) {
      cursor = prevDay(cursor)
      expect(new Date(cursor).getHours()).toBe(0)
    }
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
