/** Indonesian affixes, and which ones turn a given root into a given word.
 *
 *  The TABLE is hardcoded on purpose. Indonesian's affix inventory is closed,
 *  small and stable — these facts have not changed in decades and will not —
 *  so a lookup beats asking a model every time a word is tapped: it is free,
 *  it works offline, and above all it says the SAME thing every time. A model
 *  paraphrases, and a learner meeting "meN-" for the tenth time should be
 *  reading the tenth repetition of one sentence, not a tenth variation on it.
 *
 *  What is deliberately NOT hardcoded is the DECOMPOSITION. Guessing affixes
 *  from the surface form alone is exactly where a table like this goes wrong,
 *  and Indonesian is full of traps: "meja" (table) is not me- + ja, "bulan"
 *  (month) is not bul- + -an, "punya" (to have) is not pu- + -nya, "berita"
 *  (news) is not ber- + ita. Every one of those would produce a confident,
 *  wrong grammar lesson — worse for a learner than no lesson at all.
 *
 *  So nothing here strips speculatively. The caller passes the root the model
 *  already identified for the word, and these rules only VERIFY which affixes
 *  rebuild that word from that root. A decomposition that does not reconstruct
 *  the word exactly explains nothing and returns nothing. Silence is the
 *  correct answer whenever we are not sure. */

/** One affix, as it is explained to the reader. */
export interface Affix {
  /** How the affix is written when spoken about — "meN-", "-kan", "ke-…-an".
   *  The capital N in meN-/peN- is the standard way of writing the nasal that
   *  changes shape with the root's first sound (mem-, men-, meng-, meny-). */
  label: string
  /** What it does to the root, in one short phrase. */
  gloss: string
  /** A worked example, shown on hover. The tapped word is itself the live
   *  example, so this is reinforcement rather than the main event. */
  example: string
}

/** A prefix and the surface shapes it takes.
 *
 *  `restore` exists because the nasal prefixes absorb the root's first letter:
 *  meN- + tulis is "menulis", not "mentulis". Each surface form therefore
 *  lists the initial letters the root may have lost, and '' for the case where
 *  it lost nothing. Over-generating here is safe — every candidate is checked
 *  against the real root, so a wrong restoration simply fails to match. */
interface PrefixRule extends Affix {
  forms: { form: string; restore: string[] }[]
}

const ID_PREFIXES: PrefixRule[] = [
  {
    label: 'meN-',
    gloss: 'makes an active verb — the subject does it',
    example: 'baca (read) → membaca (to read)',
    forms: [
      { form: 'menge', restore: [''] }, // one-syllable root: mengecat ← cat
      { form: 'meng', restore: ['', 'k'] }, // mengambil ← ambil, mengirim ← kirim
      { form: 'meny', restore: ['s'] }, // menyapu ← sapu
      { form: 'mem', restore: ['', 'p'] }, // membaca ← baca, memakai ← pakai
      { form: 'men', restore: ['', 't'] }, // mendengar ← dengar, menulis ← tulis
      { form: 'me', restore: [''] }, // melihat ← lihat
    ],
  },
  {
    label: 'di-',
    gloss: 'makes a passive verb — it is done TO the subject',
    example: 'tulis (write) → ditulis (is written)',
    forms: [{ form: 'di', restore: [''] }],
  },
  {
    label: 'ber-',
    gloss: 'to have, use or do something',
    example: 'sepeda (bike) → bersepeda (to cycle)',
    forms: [
      { form: 'ber', restore: [''] }, // bermain ← main
      { form: 'bel', restore: [''] }, // belajar ← ajar (irregular)
      { form: 'be', restore: [''] }, // bekerja ← kerja
    ],
  },
  {
    label: 'ter-',
    gloss: 'by accident, already done, or the most',
    example: 'buka (open) → terbuka (left open)',
    forms: [
      { form: 'ter', restore: [''] },
      { form: 'te', restore: [''] },
    ],
  },
  {
    label: 'peN-',
    gloss: 'the person or thing that does it',
    example: 'jual (sell) → penjual (seller)',
    forms: [
      { form: 'penge', restore: [''] },
      { form: 'peng', restore: ['', 'k'] }, // pengirim ← kirim
      { form: 'peny', restore: ['s'] }, // penyapu ← sapu
      { form: 'pem', restore: ['', 'p'] }, // pembaca ← baca
      { form: 'pen', restore: ['', 't'] }, // penjual ← jual, penulis ← tulis
      { form: 'pe', restore: [''] }, // penyanyi ← nyanyi
    ],
  },
  {
    label: 'se-',
    gloss: 'one, the same, or as … as',
    example: 'rumah (house) → serumah (in the same house)',
    forms: [{ form: 'se', restore: [''] }],
  },
  {
    label: 'ke-',
    gloss: 'makes a number ordinal, or a group',
    example: 'dua (two) → kedua (the second, both)',
    forms: [{ form: 'ke', restore: [''] }],
  },
]

interface SuffixRule extends Affix {
  form: string
}

/** Longest first, so "-kan" is tried before "-an" and "-nya" before "-a".
 *  Order is only a tie-breaker though: a wrong split fails the root check. */
const ID_SUFFIXES: SuffixRule[] = [
  {
    form: 'kan',
    label: '-kan',
    gloss: 'do it TO something, or FOR someone',
    example: 'buat (make) → buatkan (make it for someone)',
  },
  {
    form: 'nya',
    label: '-nya',
    gloss: 'his, her, its — or just "the"',
    example: 'mobil (car) → mobilnya (his/her car)',
  },
  {
    form: 'kah',
    label: '-kah',
    gloss: 'turns the sentence into a question',
    example: 'apa (what) → apakah (is it that…)',
  },
  {
    form: 'lah',
    label: '-lah',
    gloss: 'softens an order into a polite one',
    example: 'duduk (sit) → duduklah (do sit down)',
  },
  {
    form: 'an',
    label: '-an',
    gloss: 'makes a noun — the thing, place or result',
    example: 'makan (eat) → makanan (food)',
  },
  {
    form: 'ku',
    label: '-ku',
    gloss: 'my',
    example: 'buku (book) → bukuku (my book)',
  },
  {
    form: 'mu',
    label: '-mu',
    gloss: 'your',
    example: 'nama (name) → namamu (your name)',
  },
  {
    form: 'i',
    label: '-i',
    gloss: 'do it to a place or target, or do it repeatedly',
    example: 'datang (come) → datangi (to go up to)',
  },
]

/** Prefix + suffix pairs that mean something other than the sum of their
 *  parts. Explaining "kebersihan" as ke- (ordinal) plus -an (a noun) would be
 *  two true statements adding up to a false one, so the pair is named instead.
 *
 *  peN-…-an is knowingly approximate: per-…-an is a separate circumfix that
 *  looks identical once the root is stripped ("perumahan" splits as pe|rumah|an
 *  either way), and telling them apart needs lexical knowledge we do not have
 *  here. The gloss is therefore written wide enough to be true of both. */
const ID_CIRCUMFIXES: (Affix & { prefix: string; suffix: string })[] = [
  {
    prefix: 'ke-',
    suffix: '-an',
    label: 'ke-…-an',
    gloss: 'makes an abstract noun — the quality of being it',
    example: 'bersih (clean) → kebersihan (cleanliness)',
  },
  {
    prefix: 'peN-',
    suffix: '-an',
    label: 'peN-…-an',
    gloss: 'makes a noun from the action — the process, result or place',
    example: 'bangun (build) → pembangunan (development)',
  },
  {
    prefix: 'ber-',
    suffix: '-an',
    label: 'ber-…-an',
    gloss: 'doing it to one another, or all over the place',
    example: 'salam (greeting) → bersalaman (to shake hands)',
  },
  {
    prefix: 'meN-',
    suffix: '-i',
    label: 'meN-…-i',
    gloss: 'act on a place or target, or do it again and again',
    example: 'datang (come) → mendatangi (to go up to)',
  },
  {
    prefix: 'meN-',
    suffix: '-kan',
    label: 'meN-…-kan',
    gloss: 'make it happen, or do it for someone',
    example: 'besar (big) → membesarkan (to enlarge)',
  },
]

const clean = (s: string) => s.trim().toLowerCase().replace(/[^\p{L}\p{N}-]/gu, '')

/** The affixes that turn `root` into `word`, or an empty list when the two
 *  cannot be reconciled by a single prefix and a single suffix.
 *
 *  Empty is the honest answer for plenty of real words — stacked prefixes
 *  ("memperbaiki" is meN- + per- + baik + -i), irregular pairs, and any root
 *  the model reported loosely. The caller shows nothing in that case, which is
 *  what it already did before this existed. */
export function explainAffixes(word: string, root: string, langCode: string | null): Affix[] {
  if (langCode !== 'id') return []
  const w = clean(word)
  const r = clean(root)
  if (!w || !r || w === r) return []

  // Every prefix × suffix pairing, including "no prefix" and "no suffix", so
  // the first combination that rebuilds the word exactly is the answer. Nulls
  // come first: a word needing no affix to explain says nothing.
  const prefixes: (PrefixRule | null)[] = [null, ...ID_PREFIXES]
  const suffixes: (SuffixRule | null)[] = [null, ...ID_SUFFIXES]

  for (const suffix of suffixes) {
    // Peel the suffix off the WORD, leaving the prefixed stem to check.
    let stem = w
    if (suffix) {
      if (!w.endsWith(suffix.form)) continue
      stem = w.slice(0, -suffix.form.length)
      if (!stem) continue
    }
    for (const prefix of prefixes) {
      if (!prefix) {
        if (stem !== r) continue
        return suffix ? [affixOf(suffix)] : []
      }
      // The stem must be one of the prefix's surface shapes wrapped around the
      // root, allowing for the initial letter a nasal prefix swallowed.
      const hit = prefix.forms.some(
        ({ form, restore }) =>
          stem.startsWith(form) && restore.some((c) => c + stem.slice(form.length) === r),
      )
      if (!hit) continue
      if (!suffix) return [affixOf(prefix)]
      const circumfix = ID_CIRCUMFIXES.find(
        (c) => c.prefix === prefix.label && c.suffix === suffix.label,
      )
      return circumfix ? [affixOf(circumfix)] : [affixOf(prefix), affixOf(suffix)]
    }
  }
  return []
}

/** Drop the matching machinery, keep what the reader is shown. */
function affixOf(rule: Affix): Affix {
  return { label: rule.label, gloss: rule.gloss, example: rule.example }
}
