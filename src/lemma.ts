/** Morphology helpers: reduce an inflected surface word to candidate root
 *  forms, so a derived word in a story can be linked to the root card the
 *  learner already owns (e.g. Indonesian "menjawab" → "jawab").
 *
 *  These are CANDIDATE generators, not a precise stemmer: every candidate is
 *  tested against the real word bank by the caller, so over-generating is
 *  harmless — spurious stems simply match no card. That trades a perfect
 *  stemmer for a short, liberal rule set that still catches the common cases. */

// Indonesian derivational/inflectional suffixes, stripped in the usual order:
// clitic particles, then possessive pronouns, then the derivational suffixes.
const ID_PARTICLES = ['lah', 'kah', 'tah', 'pun']
const ID_POSSESSIVES = ['ku', 'mu', 'nya']
const ID_SUFFIXES = ['i', 'kan', 'an']

/** Each rule removes a prefix and offers one or more restored initial
 *  consonants — Indonesian nasal prefixes assimilate and often drop the root's
 *  first letter (memukul → pukul, menulis → tulis, menyapu → sapu). We emit a
 *  candidate for every restoration; only real roots survive the bank check. */
const ID_PREFIX_RULES: { prefix: string; restore: string[] }[] = [
  { prefix: 'menge', restore: [''] }, // monosyllabic root: mengecat → cat
  { prefix: 'penge', restore: [''] },
  { prefix: 'meng', restore: ['', 'k'] }, // mengambil → ambil, mengukur → (k)ukur
  { prefix: 'peng', restore: ['', 'k'] },
  { prefix: 'meny', restore: ['s'] }, // menyapu → sapu
  { prefix: 'peny', restore: ['s'] },
  { prefix: 'mem', restore: ['', 'p'] }, // membaca → baca, memukul → pukul
  { prefix: 'pem', restore: ['', 'p'] },
  { prefix: 'men', restore: ['', 't'] }, // mendengar → dengar, menulis → tulis
  { prefix: 'pen', restore: ['', 't'] },
  { prefix: 'me', restore: [''] }, // melihat → lihat
  { prefix: 'pe', restore: [''] },
  { prefix: 'ber', restore: [''] }, // bermain → main
  { prefix: 'bel', restore: [''] }, // belajar → ajar (irregular)
  { prefix: 'be', restore: [''] }, // bekerja → kerja
  { prefix: 'ter', restore: [''] }, // terbuka → buka
  { prefix: 'te', restore: [''] },
  { prefix: 'per', restore: [''] },
  { prefix: 'di', restore: [''] }, // dibaca → baca
  { prefix: 'ke', restore: [''] },
  { prefix: 'se', restore: [''] }, // sebuah → buah
]

const MIN_ROOT = 2

function idStripSuffixes(word: string): Set<string> {
  const out = new Set<string>([word])
  const peel = (groups: string[]) => {
    for (const w of [...out]) {
      for (const suf of groups) {
        if (w.endsWith(suf) && w.length - suf.length >= MIN_ROOT) out.add(w.slice(0, -suf.length))
      }
    }
  }
  peel(ID_PARTICLES)
  peel(ID_POSSESSIVES)
  peel(ID_SUFFIXES)
  return out
}

function idStripPrefixes(word: string): Set<string> {
  const out = new Set<string>([word])
  for (const { prefix, restore } of ID_PREFIX_RULES) {
    if (!word.startsWith(prefix)) continue
    const rest = word.slice(prefix.length)
    for (const c of restore) {
      const stem = c + rest
      if (stem.length >= MIN_ROOT) out.add(stem)
    }
  }
  return out
}

/** Candidate root forms for a surface word, including the word itself. For
 *  languages without rules here, just the word (lowercased). */
export function rootCandidates(word: string, langCode: string | null): string[] {
  const w = word.toLowerCase()
  if (langCode !== 'id') return [w]

  const out = new Set<string>([w])
  // Reduplication (buku-buku, jalan-jalan): the base is one half.
  if (w.includes('-')) {
    for (const half of w.split('-')) if (half.length >= MIN_ROOT) out.add(half)
  }
  // Suffixes first, then prefixes off each suffix-stripped form — covers
  // circumfixes (me-…-kan, ke-…-an) without a separate pass.
  for (const s of [...out]) {
    for (const noSuffix of idStripSuffixes(s)) {
      for (const root of idStripPrefixes(noSuffix)) out.add(root)
    }
  }
  return [...out]
}
