/** Build the "Common words" list: the most common Indonesian root words, with
 *  meanings, from a published subtitle word count.
 *
 *  Source: FrequencyWords by Hermit Dave (OpenSubtitles 2018), id_50k.txt —
 *  https://github.com/hermitdave/FrequencyWords — content licensed CC BY-SA 4.0.
 *  The list this writes is a derivative of it and carries the same licence.
 *
 *  The raw list counts every surface form apart (makan, makanan, dimakan), and
 *  subtitles bring names and English with them. Gemini reads it in batches and
 *  says, for each form, whether it is Indonesian vocabulary and which root word
 *  it belongs to; the counts of a root's forms are then added up and the roots
 *  ranked by that total.
 *
 *    npx tsx scripts/build-common-words.mts <path/to/id_50k.txt> <cache dir>
 *
 *  Answers are cached per batch in the cache dir, so a rerun only pays for the
 *  batches that failed. Needs GEMINI_API_KEY in .env.production.local, and an
 *  unsandboxed shell (outbound POSTs). */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [srcPath, cacheDir] = process.argv.slice(2)
if (!srcPath || !cacheDir) throw new Error('usage: build-common-words.mts <id_50k.txt> <cache dir>')
mkdirSync(cacheDir, { recursive: true })

const env = readFileSync('.env.production.local', 'utf-8')
const apiKey = env.match(/^GEMINI_API_KEY=(.*)$/m)?.[1]?.trim().replace(/^"|"$/g, '')
if (!apiKey) throw new Error('GEMINI_API_KEY missing from .env.production.local')

const MODEL = process.env.MODEL || 'gemini-3.8-flash'
/** Surface forms read. Indonesian builds many forms on each root, so several
 *  forms go into every root kept; this is enough to rank well past 4,000. */
const FORMS = Number(process.env.FORMS ?? 14000)
const TARGET = 4000
const BATCH = 200
const PARALLEL = 6

const rows = readFileSync(srcPath, 'utf-8')
  .split('\n')
  .map((l) => l.trim().split(/\s+/))
  .filter((p) => p.length === 2)
  .map(([form, n]) => ({ form: form.toLowerCase(), count: Number(n) }))
  // Digits, punctuation and stray letters are not words. "a" and "o" are
  // interjections at best; nothing worth a slot.
  .filter((r) => /^\p{L}[\p{L}-]*\p{L}$/u.test(r.form))
  .slice(0, FORMS)

interface Verdict {
  form: string
  /** word = Indonesian vocabulary; name; foreign = not Indonesian (English
   *  in a subtitle, say); junk = a typo, a fragment, a sound. */
  kind: 'word' | 'name' | 'foreign' | 'junk'
  root?: string
  rootMeaning?: string
}

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          form: { type: 'STRING' },
          kind: { type: 'STRING', enum: ['word', 'name', 'foreign', 'junk'] },
          root: { type: 'STRING' },
          rootMeaning: { type: 'STRING' },
        },
        required: ['form', 'kind'],
      },
    },
  },
  required: ['items'],
}

function prompt(forms: string[]): string {
  return [
    `Below are ${forms.length} lowercase word forms from a word count of Indonesian film subtitles. For EACH form, in the same order, return one item.`,
    `"kind": "word" if it is Indonesian vocabulary (standard or casual spoken, including established loanwords like "oke", "polisi", "mobil"); "name" if it is a personal name, a place, a brand or a title; "foreign" if it is a word of another language that is not used as Indonesian (English "the", "you", "baby"); "junk" if it is a typo, a fragment or a mere sound.`,
    `For a "word", give "root": the base word a dictionary lists it under, in lowercase — strip affixes and clitics and undo reduplication: "makanan" → "makan", "dimakan" → "makan", "pergilah" → "pergi", "bukunya" → "buku", "berjalan" → "jalan", "anak-anak" → "anak", "keadaan" → "ada", "kau" → "kau". A form that is already a base word is its own root.`,
    `Casual spoken forms are their OWN root, not the standard word's: "nggak" → "nggak", "gak" → "nggak", "udah" → "udah", "aja" → "aja", "ngomong" → "omong". Spelling variants of the same casual word share one root (gak, ga, nggak, enggak → "nggak").`,
    `And "rootMeaning": a short English meaning of the ROOT (not of the form), at most six words, its commonest senses separated by "; " — e.g. "to eat", "already; done", "no; not (casual)".`,
    `Leave root and rootMeaning off anything that is not a "word".`,
    `Forms:\n${forms.join('\n')}`,
  ].join('\n')
}

const SAFETY = [
  'HARM_CATEGORY_HARASSMENT',
  'HARM_CATEGORY_HATE_SPEECH',
  'HARM_CATEGORY_SEXUALLY_EXPLICIT',
  'HARM_CATEGORY_DANGEROUS_CONTENT',
].map((category) => ({ category, threshold: 'BLOCK_NONE' }))

async function ask(forms: string[]): Promise<Verdict[]> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey! },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt(forms) }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: SCHEMA,
          thinkingConfig: { thinkingBudget: 0 },
        },
        safetySettings: SAFETY,
      }),
      signal: AbortSignal.timeout(180_000),
    },
  )
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`)
  const body = await res.json()
  const text = body?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? '').join('')
  if (!text) throw new Error(`empty answer: ${JSON.stringify(body).slice(0, 200)}`)
  return (JSON.parse(text).items ?? []) as Verdict[]
}

const batches: string[][] = []
for (let i = 0; i < rows.length; i += BATCH) batches.push(rows.slice(i, i + BATCH).map((r) => r.form))

const verdicts = new Map<string, Verdict>()
let next = 0
let failed = 0
async function worker() {
  while (next < batches.length) {
    const i = next++
    const file = join(cacheDir, `batch-${String(i).padStart(3, '0')}.json`)
    let items: Verdict[]
    if (existsSync(file)) {
      items = JSON.parse(readFileSync(file, 'utf-8'))
    } else {
      try {
        items = await ask(batches[i])
        writeFileSync(file, JSON.stringify(items))
        process.stdout.write(`batch ${i + 1}/${batches.length} ✓\n`)
      } catch (e) {
        failed++
        process.stdout.write(`batch ${i + 1}/${batches.length} failed: ${(e as Error).message}\n`)
        continue
      }
    }
    for (const v of items) if (v?.form) verdicts.set(v.form.toLowerCase().trim(), v)
  }
}
await Promise.all(Array.from({ length: PARALLEL }, worker))
if (failed > 0) {
  console.log(`\n${failed} batch(es) failed — run again to retry them.`)
  process.exit(1)
}

// ---------- derived words ----------
//
// The dictionary files "pekerjaan" (job) under "kerja" and "keadaan"
// (situation) under "ada", which hides about 800 words a learner wants on
// their own. Find the derived words common enough to rank by themselves, ask
// which of them mean something new, and give those their own entry.

const countOf = new Map(rows.map((r) => [r.form, r.count]))
const CLITIC = /(nya|mu|ku|lah|kah|pun)$/

/** A form with its small add-ons taken off (pekerjaannya → pekerjaan), but
 *  only while what is left is itself in the list — so "setelah" never
 *  becomes "sete". */
function stem(form: string): string {
  let w = form
  for (let i = 0; i < 2; i++) {
    const n = w.replace(CLITIC, '')
    if (n === w || n.length < 4 || !countOf.has(n)) break
    w = n
  }
  const n = w.replace(/^(ku|kau)/, '')
  return w.length > 6 && countOf.has(n) ? n : w
}

const DERIVED: RegExp[] = [
  /^(pe|pem|pen|peng|peny|per)\p{L}+an$/u,
  /^ke\p{L}+an$/u,
  /^(pem|pen|peng|peny|pe)\p{L}+$/u,
  /^ter\p{L}+/u,
  /^se\p{L}+/u,
  /^\p{L}+an$/u,
]
function looksDerived(s: string, root: string): boolean {
  if (s === root || s.endsWith('kan')) return false
  return DERIVED.some((rx, i) => {
    if (!rx.test(s)) return false
    if (i === 5) return s.startsWith(root) // a plain -an noun: makan → makanan
    if (i === 2 || i === 4) return !s.endsWith('i') // not a verb in -i
    return true
  })
}

const rootTotals = new Map<string, number>()
const groups = new Map<string, { word: string; root: string; count: number; forms: string[] }>()
for (const r of rows) {
  const v = verdicts.get(r.form)
  if (v?.kind !== 'word' || !v.root?.trim()) continue
  const root = v.root.trim().toLowerCase()
  rootTotals.set(root, (rootTotals.get(root) ?? 0) + r.count)
  const s = stem(r.form)
  if (!looksDerived(s, root)) continue
  const k = `${root}|${s}`
  const g = groups.get(k) ?? { word: s, root, count: 0, forms: [] }
  g.count += r.count
  g.forms.push(r.form)
  groups.set(k, g)
}
const cutoff = [...rootTotals.values()].sort((a, b) => b - a)[TARGET - 1] ?? 0
// Half the cut-off, not the cut-off: splitting moves the line, and a word
// just under it today may be over it once its root has given words away.
const candidates = [...groups.values()]
  .filter((g) => g.count >= cutoff / 2)
  .sort((a, b) => b.count - a.count)

interface DerivedVerdict {
  word: string
  separate: boolean
  headword?: string
  meaning?: string
}
const DERIVED_SCHEMA = {
  type: 'OBJECT',
  properties: {
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          word: { type: 'STRING' },
          separate: { type: 'BOOLEAN' },
          headword: { type: 'STRING' },
          meaning: { type: 'STRING' },
        },
        required: ['word', 'separate'],
      },
    },
  },
  required: ['items'],
}
function derivedPrompt(batch: typeof candidates): string {
  return [
    `Below are Indonesian derived words, each with the root a dictionary files it under and some forms it appears in. For EACH, in the same order, decide whether a learner should learn it as a word of its OWN.`,
    `"separate": true when its meaning is not simply the root plus a predictable affix — a learner who knows the root would not guess it, or it is a common everyday word in its own right: pekerjaan (job, from kerja), keadaan (situation, from ada), sehingga (so that), setelah (after), terlalu (too), pengangguran (unemployment), pakaian (clothes), makanan (food), seseorang (someone), kesehatan (health).`,
    `"separate": false when it is the root with a transparent affix that adds nothing to learn: seminggu (a week), perencanaan (planning), terlihat (visible), kelihatan (looks; seems) is TRUE because it is a common everyday word, but sebaik (as good as) is false. If the word is a fragment, a misspelling or not a real word, false.`,
    `For a true one, give "headword": the word as a dictionary or learner would list it, lowercase (sebenarnya, not sebenar; setidaknya, not setidak), and "meaning": a short English meaning, at most six words.`,
    `Words:\n${batch.map((g) => `${g.word} — root "${g.root}" — forms: ${g.forms.slice(0, 5).join(', ')}`).join('\n')}`,
  ].join('\n')
}
async function askDerived(batch: typeof candidates): Promise<DerivedVerdict[]> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey! },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: derivedPrompt(batch) }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: DERIVED_SCHEMA,
          thinkingConfig: { thinkingBudget: 0 },
        },
        safetySettings: SAFETY,
      }),
      signal: AbortSignal.timeout(180_000),
    },
  )
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`)
  const body = await res.json()
  const text = body?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? '').join('')
  if (!text) throw new Error(`empty answer: ${JSON.stringify(body).slice(0, 200)}`)
  return (JSON.parse(text).items ?? []) as DerivedVerdict[]
}

const DBATCH = 100
const dbatches: (typeof candidates)[] = []
for (let i = 0; i < candidates.length; i += DBATCH) dbatches.push(candidates.slice(i, i + DBATCH))
/** stem → its own entry, for the derived words judged worth one. */
const ownEntry = new Map<string, { headword: string; meaning: string }>()
const derivedJudged: DerivedVerdict[] = []
let dnext = 0
let dfailed = 0
async function dworker() {
  while (dnext < dbatches.length) {
    const i = dnext++
    const file = join(cacheDir, `derived-${String(i).padStart(3, '0')}.json`)
    let items: DerivedVerdict[]
    if (existsSync(file)) items = JSON.parse(readFileSync(file, 'utf-8'))
    else {
      try {
        items = await askDerived(dbatches[i])
        writeFileSync(file, JSON.stringify(items))
        process.stdout.write(`derived ${i + 1}/${dbatches.length} ✓\n`)
      } catch (e) {
        dfailed++
        process.stdout.write(`derived ${i + 1}/${dbatches.length} failed: ${(e as Error).message}\n`)
        continue
      }
    }
    for (const v of items) {
      if (!v?.word) continue
      derivedJudged.push(v)
      const headword = (v.headword ?? '').trim().toLowerCase()
      if (v.separate && headword && v.meaning?.trim())
        ownEntry.set(v.word.trim().toLowerCase(), { headword, meaning: v.meaning.trim() })
    }
  }
}
await Promise.all(Array.from({ length: PARALLEL }, dworker))
if (dfailed > 0) {
  console.log(`\n${dfailed} derived batch(es) failed — run again to retry them.`)
  process.exit(1)
}
console.log(`${candidates.length} derived candidates → ${ownEntry.size} given their own entry.`)

// Add each kept form's count to its root, and remember which forms did.
interface Root {
  root: string
  meaning: string
  count: number
  /** The meaning came from this form's count — the commonest form wins. */
  meaningFrom: number
  forms: { form: string; count: number }[]
}
const roots = new Map<string, Root>()
const dropped: { form: string; count: number; kind: string }[] = []
let unanswered = 0
for (const r of rows) {
  const v = verdicts.get(r.form)
  if (!v) {
    unanswered++
    continue
  }
  if (v.kind !== 'word' || !v.root?.trim()) {
    dropped.push({ form: r.form, count: r.count, kind: v.kind })
    continue
  }
  // A derived word judged worth its own entry is filed under itself, with its
  // own meaning — which no root's meaning may then replace.
  const own = ownEntry.get(stem(r.form))
  const key = own ? own.headword : v.root.trim().toLowerCase()
  const meaning = own ? own.meaning : (v.rootMeaning ?? '').trim()
  const e = roots.get(key)
  if (own && e && e.meaningFrom !== Infinity) {
    e.meaning = own.meaning
    e.meaningFrom = Infinity
  }
  if (!e) {
    roots.set(key, {
      root: key,
      meaning,
      count: r.count,
      meaningFrom: own ? Infinity : r.count,
      forms: [r],
    })
  } else {
    e.count += r.count
    e.forms.push(r)
    if (meaning && (!e.meaning || r.count > e.meaningFrom)) {
      e.meaning = meaning
      e.meaningFrom = r.count
    }
  }
}

const ranked = [...roots.values()].sort((a, b) => b.count - a.count).slice(0, TARGET)
const out = {
  language: 'Indonesian',
  source:
    'Built from FrequencyWords by Hermit Dave (OpenSubtitles 2018), https://github.com/hermitdave/FrequencyWords — CC BY-SA 4.0. Forms merged into root words and glossed by Gemini.',
  license: 'CC BY-SA 4.0',
  // [root, meaning, forms seen in the list (commonest first, root itself left out)]
  words: ranked.map((r) => [
    r.root,
    r.meaning,
    r.forms
      .sort((a, b) => b.count - a.count)
      .map((f) => f.form)
      .filter((f) => f !== r.root)
      .slice(0, 12),
  ]),
}
mkdirSync('src/data', { recursive: true })
writeFileSync('src/data/common-words-id.json', JSON.stringify(out))

// The review report: what was kept, merged and dropped, for a human to check.
const report = {
  formsRead: rows.length,
  unanswered,
  rootsFound: roots.size,
  kept: ranked.length,
  droppedByKind: dropped.reduce<Record<string, number>>((m, d) => ((m[d.kind] = (m[d.kind] ?? 0) + 1), m), {}),
  topDropped: dropped.sort((a, b) => b.count - a.count).slice(0, 120),
  bigMerges: ranked
    .filter((r) => r.forms.length > 1)
    .slice(0, 400)
    .map((r) => ({ root: r.root, forms: r.forms.map((f) => f.form) })),
  ranked: ranked.map((r, i) => ({ rank: i + 1, root: r.root, meaning: r.meaning, forms: r.forms.length })),
  derivedCandidates: candidates.length,
  derivedKept: derivedJudged.filter((v) => v.separate).map((v) => `${v.headword} — ${v.meaning}`),
  derivedRejected: derivedJudged.filter((v) => !v.separate).map((v) => v.word),
}
writeFileSync(join(cacheDir, 'report.json'), JSON.stringify(report, null, 1))
console.log(
  `\n${rows.length} forms → ${roots.size} roots, kept the top ${ranked.length}. Dropped: ${JSON.stringify(report.droppedByKind)}. Unanswered: ${unanswered}.`,
)
