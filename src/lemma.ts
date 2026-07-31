/** Morphology helpers: reduce an inflected surface word to candidate root
 *  forms, so a derived word in a story can be linked to the root card the
 *  learner already owns (e.g. Indonesian "menjawab" → "jawab").
 *
 *  These are CANDIDATE generators, not a precise stemmer: every candidate is
 *  tested against the real word bank by the caller, so over-generating is
 *  harmless — spurious stems simply match no card. That trades a perfect
 *  stemmer for a short, liberal rule set that still catches the common cases.
 *
 *  What is deliberately NOT peeled matters just as much. The answer these
 *  callers want is "does the learner already know this word?", so only affixes
 *  that leave the word recognisably the same come off: clitics, particles,
 *  reduplication and the verbal prefixes. Indonesian's derivational affixes
 *  build genuinely different words — "dekat" (near) does not hand you
 *  "dekatkan" (to move closer), nor "makan" (eat) "makanan" (food), nor
 *  "kerja" (work) "pekerja" (worker) — and collapsing those told the reader
 *  they already knew vocabulary they had never met. */

// Clitics only: particles first, then the possessive pronouns.
const ID_PARTICLES = ['lah', 'kah', 'tah', 'pun']
const ID_POSSESSIVES = ['ku', 'mu', 'nya']

/** Each rule removes a prefix and offers one or more restored initial
 *  consonants — Indonesian nasal prefixes assimilate and often drop the root's
 *  first letter (memukul → pukul, menulis → tulis, menyapu → sapu). We emit a
 *  candidate for every restoration; only real roots survive the bank check.
 *
 *  Verbal prefixes only. The noun-forming pe(N)-, per-, ke- and se- are absent
 *  on purpose: they derive new vocabulary rather than inflect existing words. */
const ID_PREFIX_RULES: { prefix: string; restore: string[] }[] = [
  { prefix: 'menge', restore: [''] }, // monosyllabic root: mengecat → cat
  { prefix: 'meng', restore: ['', 'k'] }, // mengambil → ambil, mengukur → (k)ukur
  { prefix: 'meny', restore: ['s'] }, // menyapu → sapu
  { prefix: 'mem', restore: ['', 'p'] }, // membaca → baca, memukul → pukul
  { prefix: 'men', restore: ['', 't'] }, // mendengar → dengar, menulis → tulis
  { prefix: 'me', restore: [''] }, // melihat → lihat
  { prefix: 'ber', restore: [''] }, // bermain → main
  { prefix: 'bel', restore: [''] }, // belajar → ajar (irregular)
  { prefix: 'be', restore: [''] }, // bekerja → kerja
  { prefix: 'ter', restore: [''] }, // terbuka → buka
  { prefix: 'te', restore: [''] },
  { prefix: 'di', restore: [''] }, // dibaca → baca
]

const MIN_ROOT = 2

function idStripClitics(word: string): Set<string> {
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
  // Clitics first, then prefixes off each clitic-stripped form, so a word
  // carrying both (dibacanya → dibaca → baca) still reaches its root.
  for (const s of [...out]) {
    for (const bare of idStripClitics(s)) {
      for (const root of idStripPrefixes(bare)) out.add(root)
    }
  }
  return [...out]
}
