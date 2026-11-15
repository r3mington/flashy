import { describe, expect, it } from 'vitest'
import type { Card } from './db'
import {
  bandProgress,
  commonStatuses,
  entriesOf,
  entryCards,
  ordinal,
  rankBand,
  rankIndex,
  rankOf,
  unmetCommon,
  type CommonList,
} from './commonWords'

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

  it('prefers known over in study over ignored among covering cards', () => {
    const s = commonStatuses(
      entries,
      [card('dimakan', { known: true }), card('makannya'), card('rumah', { ignored: true })],
      'id',
    )
    expect(s.get('makan')).toBe('known')
    expect(s.get('rumah')).toBe('ignored')
  })

  it('lets the card for the entry word itself decide', () => {
    // A known "pekerjaan"-style cover through a root must not hide that the
    // reader set "kerja" itself to ignored.
    const s = commonStatuses(entries, [card('bekerja', { known: true }), card('kerja', { ignored: true })], 'id')
    expect(s.get('kerja')).toBe('ignored')
  })
})

describe('bandProgress', () => {
  it('counts known and in-study words inside the band only', () => {
    const s = commonStatuses(entries, [card('makan', { known: true }), card('kerja'), card('rumah')], 'id')
    expect(bandProgress(entries, s, 2)).toEqual({ size: 2, known: 1, study: 1, ignored: 0 })
    expect(bandProgress(entries, s, 10)).toEqual({ size: 5, known: 1, study: 2, ignored: 0 })
  })
})

describe('entryCards', () => {
  it('finds the entry word and its forms, never a word that only shares the root', () => {
    const cards = [card('makan', { id: 1 }), card('dimakan', { id: 2 }), card('makanan', { id: 3 })]
    expect(entryCards(entries[0], cards).map((c) => c.id)).toEqual([1, 2])
  })
})

describe('unmetCommon', () => {
  const entries = entriesOf({
    language: 'Indonesian',
    source: '',
    license: '',
    words: [
      ['yang', 'that', []],
      ['makan', 'to eat', ['dimakan']],
      ['kerja', 'to work', ['bekerja']],
      ['pasar', 'market', []],
      ['hujan', 'rain', []],
    ],
  })

  it('leaves out words in the deck and words already read, in any form', () => {
    const statuses = commonStatuses(entries, [card('kerja')], 'id')
    const read = new Set(['yang', 'dimakan'])
    const out = unmetCommon(entries, statuses, (k) => read.has(k))
    expect(out.sort()).toEqual(['hujan', 'pasar'])
  })

  it('draws only from the commonest few, and no more than asked', () => {
    const out = unmetCommon(entries, new Map(), () => false, { limit: 2, window: 3 })
    expect(out).toHaveLength(2)
    expect(out.every((w) => ['yang', 'makan', 'kerja'].includes(w))).toBe(true)
  })

  it('skips words the story should not use', () => {
    const out = unmetCommon(entries, new Map(), () => false, { skip: (w) => w !== 'pasar' })
    expect(out).toEqual(['pasar'])
  })
})

describe('rankOf', () => {
  const index = rankIndex(entriesOf(list))

  it('gives a listed word its own place', () => {
    expect(rankOf(index, 'Kerja,', 'id')).toEqual({ rank: 2, word: 'kerja', via: 'word' })
  })

  it('gives a listed form the place of its entry', () => {
    expect(rankOf(index, 'bukunya', 'id')).toEqual({ rank: 4, word: 'buku', via: 'word' })
  })

  it('keeps a derived word with its own entry apart from its root', () => {
    expect(rankOf(index, 'pekerjaan', 'id')).toEqual({ rank: 3, word: 'pekerjaan', via: 'word' })
  })

  it('falls back to the root, and says so', () => {
    expect(rankOf(index, 'memakannya', 'id')).toEqual({ rank: 1, word: 'makan', via: 'root' })
    expect(rankOf(index, 'xyzzy', 'id', 'rumah')).toEqual({ rank: 5, word: 'rumah', via: 'root' })
  })

  it('is null for a word the list does not reach', () => {
    expect(rankOf(index, 'rumpun', 'id')).toBeNull()
  })
})

describe('rankBand and ordinal', () => {
  it('steps at 500, 1,000, 2,000 and 4,000', () => {
    expect([1, 500, 501, 1000, 1001, 2000, 2001, 4000].map(rankBand)).toEqual([1, 1, 2, 2, 3, 3, 4, 4])
  })

  it('writes places the way they are said', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 112, 164, 1013].map(ordinal)).toEqual([
      '1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '112th', '164th', '1,013th',
    ])
  })
})
