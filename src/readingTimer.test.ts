import { describe, expect, it } from 'vitest'
import { countsAsReading, IDLE_MS } from './useReadingTimer'

const here = { hidden: false, focused: true, sinceActivityMs: 0, readingAloud: false }

describe('countsAsReading', () => {
  it('counts while the reader is active', () => {
    expect(countsAsReading(here)).toBe(true)
    expect(countsAsReading({ ...here, sinceActivityMs: IDLE_MS - 1000 })).toBe(true)
  })

  it('stops once nothing has happened for the idle limit', () => {
    expect(countsAsReading({ ...here, sinceActivityMs: IDLE_MS })).toBe(false)
  })

  it('keeps counting while the story is read aloud, touch or no touch', () => {
    expect(countsAsReading({ ...here, sinceActivityMs: 10 * IDLE_MS, readingAloud: true })).toBe(true)
  })

  it('never counts a hidden or unfocused window, even mid read-aloud', () => {
    expect(countsAsReading({ ...here, hidden: true, readingAloud: true })).toBe(false)
    expect(countsAsReading({ ...here, focused: false, readingAloud: true })).toBe(false)
  })
})
