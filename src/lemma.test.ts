import { describe, expect, it } from 'vitest'
import { rootCandidates } from './lemma'

/** The question every caller actually asks: does this surface word belong to
 *  the card the learner already owns? */
const reaches = (surface: string, root: string) =>
  rootCandidates(surface, 'id').includes(root)

describe('rootCandidates — Indonesian', () => {
  it('always offers the word itself', () => {
    expect(reaches('buku', 'buku')).toBe(true)
    expect(reaches('dekatkan', 'dekatkan')).toBe(true)
  })

  describe('collapses inflection — the same word, just marked', () => {
    it.each([
      ['membaca', 'baca'],
      ['memukul', 'pukul'],
      ['menulis', 'tulis'],
      ['mendengar', 'dengar'],
      ['menyapu', 'sapu'],
      ['mengambil', 'ambil'],
      ['mengecat', 'cat'],
      ['melihat', 'lihat'],
      ['bermain', 'main'],
      ['belajar', 'ajar'],
      ['bekerja', 'kerja'],
      ['terbuka', 'buka'],
      ['ditulis', 'tulis'],
    ])('%s → %s', (surface, root) => expect(reaches(surface, root)).toBe(true))

    it.each([
      ['rumahnya', 'rumah'],
      ['bukuku', 'buku'],
      ['rumahmu', 'rumah'],
      ['ambillah', 'ambil'],
      ['apakah', 'apa'],
    ])('clitic %s → %s', (surface, root) => expect(reaches(surface, root)).toBe(true))

    it('handles reduplicated plurals', () => {
      expect(reaches('buku-buku', 'buku')).toBe(true)
      expect(reaches('jalan-jalan', 'jalan')).toBe(true)
    })

    it('handles a prefix and a clitic together', () => {
      expect(reaches('dibacanya', 'baca')).toBe(true)
    })
  })

  describe('keeps derivation apart — a genuinely different word', () => {
    // Regression: "dekatkan" (to move closer) was silently treated as known
    // whenever "dekat" (near) was in the bank, so it never highlighted and its
    // lookups were charged to the root card.
    it('dekat (near) does not cover dekatkan (to move closer)', () => {
      expect(reaches('dekatkan', 'dekat')).toBe(false)
    })

    it.each([
      ['makanan', 'makan'], // food ≠ eat
      ['pekerja', 'kerja'], // worker ≠ work
      ['pekerjaan', 'kerja'], // job ≠ work
      ['kedinginan', 'dingin'], // feeling cold ≠ cold
      ['tunjukkan', 'tunjuk'], // show it ≠ point
      ['perbaikan', 'baik'], // repair ≠ good
      ['mengerjakan', 'kerja'], // work on ≠ work
      ['jatuhi', 'jatuh'], // drop onto ≠ fall
      ['sebuah', 'buah'], // a/an ≠ fruit
      ['sekali', 'kali'], // very/once ≠ time
    ])('%s is not covered by %s', (surface, root) =>
      expect(reaches(surface, root)).toBe(false),
    )
  })

  it('leaves non-Indonesian languages alone, bar lowercasing', () => {
    expect(rootCandidates('Bonjour', 'fr')).toEqual(['bonjour'])
    expect(rootCandidates('membaca', null)).toEqual(['membaca'])
  })

  it('never emits a stem below the minimum length', () => {
    for (const w of ['ada', 'ke', 'di', 'beli', 'itu', 'menge']) {
      for (const c of rootCandidates(w, 'id')) expect(c.length).toBeGreaterThanOrEqual(2)
    }
  })
})
