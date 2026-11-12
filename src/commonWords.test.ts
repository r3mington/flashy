import { describe, expect, it } from 'vitest'
import type { Card } from './db'
import { bandProgress, commonStatuses, entriesOf, type CommonList } from './commonWords'

function card(word: string, over: Partial<Card> = {}): Card {
  return {
    id: 1,
    deckId: 1,
    word,
    meaning: '',
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

const list: CommonList = {
  language: 'Indonesian',
  source: '',
  license: '',
  words: [
    ['makan', 'to eat', ['dimakan', 'makannya']],
    ['kerja', 'to work', ['bekerja']],
    ['pekerjaan', 'job', ['pekerjaanmu']],
    ['buku', 'book', ['bukunya']],
    ['rumah', 'house', []],
  ],
}
const entries = entriesOf(list)

describe('commonStatuses', () => {
  it('matches the entry itself and its listed forms', () => {
    const s = commonStatuses(entries, [card('Makan'), card('bukunya', { known: true })], 'id')
    expect(s.get('makan')).toBe('study')
    expect(s.get('buku')).toBe('known')
    expect(s.get('rumah')).toBeUndefined()
  })

  it('lets a card for a derived word cover its root', () => {
    expect(commonStatuses(entries, [card('bekerja')], 'id').get('kerja')).toBe('study')
  })

  it('never lets a root cover a derived word with its own entry', () => {
    const s = commonStatuses(entries, [card('kerja', { known: true })], 'id')
    expect(s.get('kerja')).toBe('known')
    expect(s.get('pekerjaan')).toBeUndefined()
  })

  it('prefers known over in study, and ignores ignored cards', () => {
    const s = commonStatuses(
      entries,
      [card('makan'), card('dimakan', { known: true }), card('rumah', { ignored: true })],
      'id',
    )
    expect(s.get('makan')).toBe('known')
    expect(s.get('rumah')).toBeUndefined()
  })
})

describe('bandProgress', () => {
  it('counts known and in-study words inside the band only', () => {
    const s = commonStatuses(entries, [card('makan', { known: true }), card('kerja'), card('rumah')], 'id')
    expect(bandProgress(entries, s, 2)).toEqual({ size: 2, known: 1, study: 1 })
    expect(bandProgress(entries, s, 10)).toEqual({ size: 5, known: 1, study: 2 })
  })
})
