import { describe, expect, it } from 'vitest'
import { coverage, coverageShares, difficulty, type WordKind } from './coverage'

const kinds: Record<string, WordKind> = {
  saya: 'known',
  makan: 'known',
  jawab: 'learning',
  kucing: 'new',
  rina: 'skip',
}
const kindOf = (k: string) => kinds[k] ?? 'new'

describe('coverage', () => {
  it('counts every occurrence, and each word once for distinct', () => {
    const c = coverage(['saya', 'makan', 'saya', 'jawab', 'kucing', 'kucing'], kindOf)
    expect(c).toEqual({
      total: 6,
      known: 3,
      learning: 1,
      new: 2,
      distinct: { known: 2, learning: 1, new: 1 },
    })
  })

  it('leaves names and other non-vocabulary out of the total', () => {
    const c = coverage(['rina', 'saya', 'rina'], kindOf)
    expect(c.total).toBe(1)
    expect(c.known).toBe(1)
  })
})

describe('coverageShares', () => {
  it('always adds up to 100', () => {
    // Thirds: 33.3 each, which naive rounding makes 99.
    const s = coverageShares(coverage(['saya', 'jawab', 'kucing'], kindOf))
    expect(s.known + s.learning + s.new).toBe(100)
  })

  it('is all zero for an empty text', () => {
    expect(coverageShares(coverage([], kindOf))).toEqual({ known: 0, learning: 0, new: 0 })
  })
})

describe('difficulty', () => {
  const text = (own: number, fresh: number) =>
    coverage([...Array(own).fill('saya'), ...Array(fresh).fill('kucing')], kindOf)

  it('grades by the share of the text from the reader’s bank', () => {
    expect(difficulty(text(99, 1))?.label).toBe('Easy')
    expect(difficulty(text(96, 4))?.label).toBe('Comfortable')
    expect(difficulty(text(92, 8))?.label).toBe('A stretch')
    expect(difficulty(text(80, 20))?.label).toBe('Hard')
  })

  it('counts words still in study as the reader’s own', () => {
    const c = coverage([...Array(50).fill('jawab'), ...Array(50).fill('saya')], kindOf)
    expect(difficulty(c)?.label).toBe('Easy')
  })

  it('has nothing to say about an empty text', () => {
    expect(difficulty(coverage([], kindOf))).toBeNull()
  })
})
