import { describe, expect, it } from 'vitest'
import type { Card } from './db'
import { autoKnownChanges, listLookup } from './autoKnown'

let nextId = 1
const card = (word: string, extra: Partial<Card> = {}): Card => ({
  id: nextId++,
  deckId: 1,
  word,
  meaning: word,
  example: '',
  createdAt: 0,
  state: 'review',
  due: 0,
  interval: 1,
  ease: 2.5,
  reps: 1,
  lapses: 0,
  ...extra,
})

// A slice of the common-words list: nama with its forms, and masalah and buku
// as entries of their own.
const list = listLookup([
  ['nama', 'name', ['namanya', 'namamu', 'namaku', 'namamulah']],
  ['masa', 'time; period', ['masanya']],
  ['masalah', 'problem', ['masalahnya']],
  ['bu', "ma'am", []],
  ['buku', 'book', ['bukunya']],
])

const ids = (changes: { id: number; changes: Partial<Card> }[]) => changes.map((c) => c.id)

describe('autoKnownChanges', () => {
  it('marks the clitic forms of a known word known', () => {
    const nama = card('nama', { known: true })
    const namamu = card('namamu')
    const namaku = card('namaku')
    const kupegang = card('kupegang')
    const pegang = card('pegang', { known: true })
    const out = autoKnownChanges([nama, namamu, namaku, kupegang, pegang], 'id', list)
    expect(ids(out)).toEqual([namamu.id, namaku.id, kupegang.id])
    expect(out[0].changes).toEqual({ known: true, auto: 'known' })
  })

  it('leaves forms alone while the word is still in study', () => {
    expect(autoKnownChanges([card('nama'), card('namamu')], 'id', list)).toEqual([])
  })

  it('never marks a word the list holds as its own entry', () => {
    // masalah is "problem", not masa + -lah; buku is "book", not bu + -ku.
    const out = autoKnownChanges(
      [card('masa', { known: true }), card('masalah'), card('bu', { known: true }), card('buku')],
      'id',
      list,
    )
    expect(out).toEqual([])
  })

  it('never marks a derived word, only clitics', () => {
    const out = autoKnownChanges([card('makan', { known: true }), card('makanan'), card('memakan')], 'id', list)
    expect(out).toEqual([])
  })

  it('puts an auto-known form back when its word is no longer known', () => {
    const namamu = card('namamu', { known: true, auto: 'known' })
    const out = autoKnownChanges([card('nama'), namamu], 'id', list)
    expect(out).toEqual([{ id: namamu.id, changes: { known: false, auto: undefined } }])
  })

  it("never moves a card the reader set by hand, or one they ignored", () => {
    const out = autoKnownChanges(
      [card('nama', { known: true }), card('namamu', { auto: 'off' }), card('namaku', { ignored: true })],
      'id',
      list,
    )
    expect(out).toEqual([])
  })

  it('follows a chain of forms: namamulah through namamu to nama', () => {
    const namamu = card('namamu', { known: true, auto: 'known' })
    const namamulah = card('namamulah')
    const out = autoKnownChanges([card('nama', { known: true }), namamu, namamulah], 'id', list)
    expect(ids(out)).toEqual([namamulah.id])
  })

  it('does nothing for other languages', () => {
    expect(autoKnownChanges([card('nama', { known: true }), card('namamu')], 'es', list)).toEqual([])
  })

  it('settles: a second pass after the first finds nothing to change', () => {
    const cards = [card('nama', { known: true }), card('namamu'), card('namaku')]
    for (const { id, changes } of autoKnownChanges(cards, 'id', list))
      Object.assign(cards.find((c) => c.id === id)!, changes)
    expect(autoKnownChanges(cards, 'id', list)).toEqual([])
  })
})
