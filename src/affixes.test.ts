import { describe, expect, it } from 'vitest'
import { explainAffixes } from './affixes'

const labels = (word: string, root: string) =>
  explainAffixes(word, root, 'id').map((a) => a.label)

describe('explainAffixes', () => {
  it('reads the nasal prefix through every shape it takes', () => {
    // The root's first letter survives…
    expect(labels('membaca', 'baca')).toEqual(['meN-'])
    expect(labels('mendengar', 'dengar')).toEqual(['meN-'])
    expect(labels('mengambil', 'ambil')).toEqual(['meN-'])
    expect(labels('melihat', 'lihat')).toEqual(['meN-'])
    // …or the prefix swallows it, which is the part a plain strip gets wrong.
    expect(labels('menulis', 'tulis')).toEqual(['meN-'])
    expect(labels('memukul', 'pukul')).toEqual(['meN-'])
    expect(labels('mengirim', 'kirim')).toEqual(['meN-'])
    expect(labels('menyapu', 'sapu')).toEqual(['meN-'])
    expect(labels('mengecat', 'cat')).toEqual(['meN-'])
  })

  it('reads the other prefixes', () => {
    expect(labels('ditulis', 'tulis')).toEqual(['di-'])
    expect(labels('bersepeda', 'sepeda')).toEqual(['ber-'])
    expect(labels('bekerja', 'kerja')).toEqual(['ber-'])
    expect(labels('belajar', 'ajar')).toEqual(['ber-'])
    expect(labels('terbuka', 'buka')).toEqual(['ter-'])
    expect(labels('penjual', 'jual')).toEqual(['peN-'])
    expect(labels('penulis', 'tulis')).toEqual(['peN-'])
    expect(labels('penyanyi', 'nyanyi')).toEqual(['peN-'])
    expect(labels('serumah', 'rumah')).toEqual(['se-'])
    expect(labels('kedua', 'dua')).toEqual(['ke-'])
  })

  it('reads the suffixes', () => {
    expect(labels('makanan', 'makan')).toEqual(['-an'])
    expect(labels('buatkan', 'buat')).toEqual(['-kan'])
    expect(labels('datangi', 'datang')).toEqual(['-i'])
    expect(labels('mobilnya', 'mobil')).toEqual(['-nya'])
    expect(labels('apakah', 'apa')).toEqual(['-kah'])
    expect(labels('duduklah', 'duduk')).toEqual(['-lah'])
    expect(labels('bukuku', 'buku')).toEqual(['-ku'])
    expect(labels('namamu', 'nama')).toEqual(['-mu'])
  })

  it('reports a prefix and a suffix that merely stack', () => {
    expect(labels('dibacakan', 'baca')).toEqual(['di-', '-kan'])
    expect(labels('bacalah', 'baca')).toEqual(['-lah'])
    expect(labels('dibukanya', 'buka')).toEqual(['di-', '-nya'])
  })

  it('names a circumfix rather than adding up its halves', () => {
    // ke- (ordinal) plus -an (a noun) would be two truths making a falsehood.
    expect(labels('kebersihan', 'bersih')).toEqual(['ke-…-an'])
    expect(labels('pekerjaan', 'kerja')).toEqual(['peN-…-an'])
    expect(labels('pembangunan', 'bangun')).toEqual(['peN-…-an'])
    expect(labels('bersalaman', 'salam')).toEqual(['ber-…-an'])
    expect(labels('mendatangi', 'datang')).toEqual(['meN-…-i'])
    expect(labels('membesarkan', 'besar')).toEqual(['meN-…-kan'])
  })

  it('says nothing about words that only look affixed', () => {
    // The traps: every one of these would fool a stripper working from the
    // surface alone, and every one is a real, common word.
    expect(labels('meja', 'meja')).toEqual([]) // not me- + ja
    expect(labels('bulan', 'bulan')).toEqual([]) // not bul- + -an
    expect(labels('punya', 'punya')).toEqual([]) // not pu- + -nya
    expect(labels('berita', 'berita')).toEqual([]) // not ber- + ita
    expect(labels('kertas', 'kertas')).toEqual([]) // not ke- + rtas
    expect(labels('sekolah', 'sekolah')).toEqual([]) // not se- + kolah
    expect(labels('hanya', 'hanya')).toEqual([]) // not ha- + -nya
  })

  it('says nothing when the root cannot rebuild the word', () => {
    // Stacked prefixes are beyond a single prefix + single suffix, and a
    // half-right answer is worse than none.
    expect(labels('memperbaiki', 'baik')).toEqual([])
    // A root the model reported loosely, or plain nonsense.
    expect(labels('membaca', 'tulis')).toEqual([])
    expect(labels('makanan', '')).toEqual([])
    expect(labels('', 'makan')).toEqual([])
  })

  it('only speaks for Indonesian', () => {
    expect(explainAffixes('membaca', 'baca', 'th')).toEqual([])
    expect(explainAffixes('membaca', 'baca', null)).toEqual([])
  })

  it('ignores case and the punctuation a story word arrives with', () => {
    expect(labels('Membaca', 'baca')).toEqual(['meN-'])
    expect(labels('membaca.', 'Baca')).toEqual(['meN-'])
    expect(labels('“menulis”', 'tulis')).toEqual(['meN-'])
  })

  it('carries a gloss and an example for everything it reports', () => {
    for (const [word, root] of [
      ['membaca', 'baca'],
      ['makanan', 'makan'],
      ['kebersihan', 'bersih'],
      ['dibacakan', 'baca'],
    ] as const) {
      for (const a of explainAffixes(word, root, 'id')) {
        expect(a.gloss.length).toBeGreaterThan(0)
        expect(a.example).toContain('→')
      }
    }
  })
})
