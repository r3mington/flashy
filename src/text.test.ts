import { describe, expect, it } from 'vitest'
import { countWords, defKey, splitSentences, tokenizeWords } from './text'

describe('defKey', () => {
  it('lowercases and strips surrounding punctuation', () => {
    expect(defKey('Halo,')).toBe('halo')
    expect(defKey('“Budi”')).toBe('budi')
    expect(defKey('mother.')).toBe('mother')
  })

  it('keeps word-internal punctuation, which Indonesian needs', () => {
    expect(defKey('buku-buku')).toBe('buku-buku')
    expect(defKey("I'll")).toBe("i'll")
  })

  it('returns empty for tokens with no letters or digits', () => {
    expect(defKey('—')).toBe('')
    expect(defKey('   ')).toBe('')
    expect(defKey('...')).toBe('')
  })
})

describe('tokenizeWords', () => {
  it('round-trips a spaced language exactly', () => {
    const text = 'Halo, saya mau beli buah sekarang.'
    expect(tokenizeWords(text, 'id').join('')).toBe(text)
  })

  it('round-trips a spaceless script exactly', () => {
    const text = 'ผมชอบกินข้าว'
    expect(tokenizeWords(text, 'th').join('')).toBe(text)
  })
})

describe('splitSentences', () => {
  it('round-trips, losing nothing', () => {
    const text = 'Saya mau beli buah. Berapa harganya? Mahal sekali!'
    expect(splitSentences(text, 'id').join('')).toBe(text)
  })

  it('splits on terminators', () => {
    expect(splitSentences('Satu. Dua? Tiga!', 'id')).toHaveLength(3)
  })

  it('returns nothing for empty input', () => {
    expect(splitSentences('', 'id')).toEqual([])
  })

  // Round-tripping is the contract, so whitespace-only input comes back as it
  // went in rather than being swallowed.
  it('preserves whitespace-only input', () => {
    expect(splitSentences('   ', 'id').join('')).toBe('   ')
  })
})

describe('countWords', () => {
  it('counts words, not whitespace or punctuation', () => {
    expect(countWords('Halo, saya mau beli buah sekarang.', 'id')).toBe(6)
    expect(countWords('  ', 'id')).toBe(0)
    expect(countWords('— … —', 'id')).toBe(0)
  })
})
