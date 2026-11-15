/** Build the word families that go with the "Common words" list.
 *
 *  The list (`src/data/common-words-id.json`, from `build-common-words.mts`)
 *  already says which counted forms belong to each root — pegang: memegang,
 *  dipegang, berpegangan… — but gives a meaning for the root alone. This reads
 *  the list as it is, without changing a word or a rank of it, and asks Gemini
 *  once, offline, for:
 *
 *  - each listed form worth learning: its own short meaning and what its
 *    affixes make of the root (the family panel's headings). Forms that only
 *    add "my", "your", "the", a softener or a question mark (memegangku,
 *    peganglah) are dropped, and so are misspellings and fused words.
 *  - for an entry that is itself built on a simpler root (pekerjaan on kerja,
 *    pegangan on pegang), that root — so the entry joins its root's family.
 *
 *  So a family is only ever words the subtitle count actually turned up; the
 *  model glosses them but adds none. The output is a file of its own, loaded
 *  only by the reader, so the Common words page stays as light as it was.
 *
 *    npx tsx scripts/build-word-families.mts <cache dir>
 *
 *  Answers are cached per batch in the cache dir, so a rerun only pays for the
 *  batches that failed. Needs GEMINI_API_KEY in .env.production.local, and an
 *  unsandboxed shell (outbound POSTs). */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [cacheDir] = process.argv.slice(2)
if (!cacheDir) throw new Error('usage: build-word-families.mts <cache dir>')
mkdirSync(cacheDir, { recursive: true })

const env = readFileSync('.env.production.local', 'utf-8')
const apiKey = env.match(/^GEMINI_API_KEY=(.*)$/m)?.[1]?.trim().replace(/^"|"$/g, '')
if (!apiKey) throw new Error('GEMINI_API_KEY missing from .env.production.local')

const MODEL = process.env.MODEL || 'gemini-3.8-flash'
const BATCH = 80
const PARALLEL = 6

const GROUPS = ['doing', 'done', 'accidental', 'state', 'thing', 'person', 'mutual', 'casual', 'other']

const list = JSON.parse(readFileSync('src/data/common-words-id.json', 'utf-8')) as {
  words: [string, string, string[]][]
}
const entries = list.words.map(([word, meaning, forms]) => ({ word, meaning, forms }))
const entryWords = new Set(entries.map((e) => e.word))

interface Answer {
  word: string
  /** The simpler root this entry is built on, when it is a derived word. */
  base?: string
  /** What the entry's own affixes make of that base — its heading there. */
  group?: string
  forms?: { form: string; meaning: string; group: string }[]
}

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          word: { type: 'STRING' },
          base: { type: 'STRING' },
          group: { type: 'STRING', enum: GROUPS },
          forms: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                form: { type: 'STRING' },
                meaning: { type: 'STRING' },
                group: { type: 'STRING', enum: GROUPS },
              },
              required: ['form', 'meaning', 'group'],
            },
          },
        },
        required: ['word', 'forms'],
      },
    },
  },
  required: ['items'],
}

const GROUP_RULE = `"group" — what the affixes make of the root: doing (an active verb: memegang, mengerjakan, bekerja when it means to do the work), done (passive: dipegang, dikerjakan), accidental (by accident, already done, or able to: terpegang, termakan, ketahuan), state (being in a state, reflexive or intransitive: berjalan, membaik, terbaik), thing (a noun for a thing, place, result or tool: pegangan, makanan, perjalanan), person (a noun for a person who does it: pemegang, pekerja, pelajar), mutual (doing it to each other or together: berpegangan, berpelukan), casual (a casual spoken form: tau for tahu, megang for memegang, kerjain for kerjakan), or other.`

function prompt(batch: typeof entries): string {
  return [
    `Below are ${batch.length} entries from a list of the commonest Indonesian words, each with its English meaning and other forms of it found in film subtitles. For EACH entry, in the same order, return one item with "word" copied exactly.`,
    `"forms": the listed forms a learner should meet as words of their own — the root with a prefix, suffix, both, or reduplication that changes what it means or does (memegang, dipegang, berpegangan, pegangi, jalan-jalan). Copy each "form" exactly from the entry's list; never add a form that is not listed. For each give "meaning": a short English meaning of that form, at most six words, its commonest sense first; and ${GROUP_RULE}`,
    `Leave OUT of "forms": a form that only adds a clitic to the root or to another listed form — -nya, -ku, -mu, -lah, -kah, -pun, ku-, kau- (memegangnya, memegangku, kupegang, peganglah, kerjanya); misspellings and spelling slips (berkerja, bs, tida); two words run together (dijalan for "di jalan"). An entry may well have no forms left; return [] then.`,
    `"base": when the entry word ITSELF is built on a simpler Indonesian root with an affix — pekerjaan → "kerja", pegangan → "pegang", makanan → "makan", perjalanan → "jalan", pengetahuan → "tahu", ketahuan → "tahu", belajar → "ajar" — give that root, lowercase, and "group": what the affixes make of it (same choices as above). Leave both off when the entry is itself a root (makan, rumah, nggak), or is only a function word or a casual word with no affixed root.`,
    `Entries:\n${batch.map((e) => `${e.word} — ${e.meaning} — forms: ${e.forms.join(', ') || '(none)'}`).join('\n')}`,
  ].join('\n')
}

const SAFETY = [
  'HARM_CATEGORY_HARASSMENT',
  'HARM_CATEGORY_HATE_SPEECH',
  'HARM_CATEGORY_SEXUALLY_EXPLICIT',
  'HARM_CATEGORY_DANGEROUS_CONTENT',
].map((category) => ({ category, threshold: 'BLOCK_NONE' }))

async function ask(batch: typeof entries): Promise<Answer[]> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey! },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt(batch) }] }],
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
  return (JSON.parse(text).items ?? []) as Answer[]
}

const batches: (typeof entries)[] = []
for (let i = 0; i < entries.length; i += BATCH) batches.push(entries.slice(i, i + BATCH))

const answers = new Map<string, Answer>()
let next = 0
let failed = 0
async function worker() {
  while (next < batches.length) {
    const i = next++
    const file = join(cacheDir, `family-${String(i).padStart(3, '0')}.json`)
    let items: Answer[]
    if (existsSync(file)) items = JSON.parse(readFileSync(file, 'utf-8'))
    else {
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
    for (const a of items) if (a?.word) answers.set(a.word.trim().toLowerCase(), a)
  }
}
await Promise.all(Array.from({ length: PARALLEL }, worker))
if (failed > 0) {
  console.log(`\n${failed} batch(es) failed — run again to retry them.`)
  process.exit(1)
}

const groupOf = (g: string | undefined) => (g && GROUPS.includes(g) ? g : 'other')
const CLITIC = /^(ku|kau)|(nya|ku|mu|lah|kah|pun)$/

/** root → its members, as [word, meaning, group]. */
const families = new Map<string, [string, string, string][]>()
const add = (root: string, word: string, meaning: string, group: string) => {
  const fam = families.get(root) ?? []
  if (word === root || fam.some((m) => m[0] === word)) return
  fam.push([word, meaning, group])
  families.set(root, fam)
}

let unanswered = 0
let invented = 0
for (const e of entries) {
  const a = answers.get(e.word)
  if (!a) {
    unanswered++
    continue
  }
  const listed = new Set(e.forms)
  for (const f of a.forms ?? []) {
    const form = (f.form ?? '').trim().toLowerCase()
    const meaning = (f.meaning ?? '').trim()
    if (!form || !meaning) continue
    // Only counted forms: anything the model offers that the list does not
    // hold is its own idea, not the subtitles'.
    if (!listed.has(form)) {
      invented++
      continue
    }
    // A clitic on another member says nothing new (memegangnya beside
    // memegang), whatever the model let through.
    const bare = form.replace(CLITIC, '')
    if (bare !== form && (bare === e.word || listed.has(bare))) continue
    add(e.word, form, meaning, groupOf(f.group))
  }
}
// Entries built on another entry join its family, with their own meaning.
let joined = 0
for (const e of entries) {
  const base = answers.get(e.word)?.base?.trim().toLowerCase()
  if (!base || base === e.word || !entryWords.has(base)) continue
  add(base, e.word, e.meaning, groupOf(answers.get(e.word)?.group))
  joined++
}

// In list order, so a family's members come out commonest-root first and the
// file reads alongside the list.
const out: Record<string, [string, string, string][]> = {}
for (const e of entries) {
  const fam = families.get(e.word)
  if (fam?.length) out[e.word] = fam
}
writeFileSync(
  'src/data/word-families-id.json',
  JSON.stringify({
    source:
      'Forms from the Common words list (FrequencyWords by Hermit Dave, OpenSubtitles 2018, CC BY-SA 4.0), glossed by Gemini.',
    license: 'CC BY-SA 4.0',
    // root → [word, meaning, group][]
    families: out,
  }),
)
console.log(
  `${Object.keys(out).length} families, ${[...families.values()].reduce((n, f) => n + f.length, 0)} members ` +
    `(${joined} entries joined to their root). ${unanswered} entries unanswered, ${invented} unlisted forms refused.`,
)
