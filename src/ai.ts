import { db, type Deck, type StoryBible } from './db'
import { langCodeFor } from './speech'
import { countWords, tokenizeWords } from './text'

export interface Suggestion {
  word: string
  meaning: string
  example: string
  exampleTranslation: string
  emoji?: string
  /** Romanization, present for languages not written in the Latin alphabet. */
  roman?: string
}

/** Whether the user has opted into slower, higher-quality "thinking" for AI
 *  calls. Read straight from the settings store so callers don't have to thread
 *  it through. Defaults to off (fast) if unset or unreadable. */
async function thinkingEnabled(): Promise<boolean> {
  try {
    return !!(await db.settings.get('app'))?.aiThinking
  } catch {
    return false
  }
}

/** All AI calls go through our /api/generate proxy — the Gemini key lives server-side.
 *  `tier` picks the class of model: everything defaults to the fast one, and the
 *  calls that have to plan rather than transcribe ask for 'pro' explicitly. */
/** What one model call actually did, as reported by the server. Attached to the
 *  trace so a slow or failed generation can be read after the fact. */
export interface CallMeta {
  model?: string
  thinking?: object | string
  /** Time the server spent on the upstream call, excluding our own network hop. */
  ms?: number
  promptTokens?: number
  outputTokens?: number
  /** Reasoning tokens burned before any output — usually why a call was slow. */
  thoughtTokens?: number
  finishReason?: string
  retries?: number
  /** How many calls the pass took, when it was split into parallel pieces. */
  passes?: number
}

async function callGeminiJson<T>(
  prompt: string,
  schema: object,
  opts: {
    tier?: 'fast' | 'pro'
    effort?: 'minimal' | 'high'
    /** Name for this call in the server log and the on-screen trace. */
    label?: string
    onMeta?: (meta: CallMeta) => void
  } = {},
): Promise<T> {
  const tier = opts.tier ?? 'fast'
  try {
    return await postJson<T>(prompt, schema, { ...opts, tier })
  } catch (e) {
    // The function has a hard 60-second budget, and the pro model's latency
    // does not respect it reliably. A pro call that runs out of time still has
    // somewhere to go: the same prompt on the fast model. A plainer story beats
    // no story, and the trace records which model actually answered.
    const ranOutOfTime = e instanceof ApiError && (e.status === 504 || e.status === 502)
    if (ranOutOfTime && tier === 'pro') {
      console.warn(`[story] ${opts.label ?? 'call'} timed out on pro — retrying on fast`)
      return postJson<T>(prompt, schema, { ...opts, tier: 'fast' })
    }
    throw e
  }
}

async function postJson<T>(
  prompt: string,
  schema: object,
  opts: {
    tier: 'fast' | 'pro'
    effort?: 'minimal' | 'high'
    label?: string
    onMeta?: (meta: CallMeta) => void
  },
): Promise<T> {
  const thinking = await thinkingEnabled()
  let res: Response
  try {
    res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        schema,
        thinking,
        tier: opts.tier,
        effort: opts.effort,
        label: opts.label,
      }),
    })
  } catch {
    // Offline is the ordinary case here (a plane, a tunnel), and it deserves a
    // plainer explanation than the dev-setup one.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      throw new Error('You’re offline — this needs a connection.')
    }
    throw new Error(
      'Could not reach the AI endpoint. If you are running locally, use `npm run dev:vercel` so the API functions are served.',
    )
  }
  if (!res.ok) {
    let message = `Request failed (${res.status})`
    try {
      const err = await res.json()
      message = err?.error ?? message
    } catch {
      /* keep generic message */
    }
    throw new ApiError(res.status, message)
  }
  const body = await res.json()
  if (body.meta) opts.onMeta?.(body.meta as CallMeta)
  return body.data as T
}

/** One pass of a story generation, as it happens. The UI renders these live and
 *  they are logged to the console when each finishes, so a generation that is
 *  slow or dies partway can be read rather than guessed at. */
export interface StoryStep {
  key: string
  label: string
  startedAt: number
  /** Wall-clock for the step, set when it finishes. */
  ms?: number
  ok?: boolean
  /** What the step produced, in the terms that matter — words, beats, entries. */
  detail?: string
  error?: string
  meta?: CallMeta
}

const CARDS_SCHEMA = {
  type: 'OBJECT',
  properties: {
    cards: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          word: { type: 'STRING' },
          meaning: { type: 'STRING' },
          example: { type: 'STRING' },
          exampleTranslation: { type: 'STRING' },
          emoji: { type: 'STRING' },
          roman: { type: 'STRING' },
        },
        required: ['word', 'meaning', 'example', 'exampleTranslation', 'emoji'],
      },
    },
  },
  required: ['cards'],
}

export async function generateCards(opts: {
  deck: Deck
  existingWords: string[]
  blacklistedWords: string[]
  topic?: string
  count?: number
}): Promise<Suggestion[]> {
  const { deck, existingWords, blacklistedWords, topic, count = 20 } = opts

  const exclusions = [...existingWords, ...blacklistedWords]
  const prompt = [
    `Generate ${count} vocabulary flashcards for a learner of ${deck.language}.`,
    `The deck is called "${deck.name}". Meanings and example translations are in English.`,
    topic?.trim()
      ? `All words must relate to this topic: "${topic.trim()}".`
      : `Pick genuinely useful, common words a learner should know, at a difficulty consistent with the existing deck.`,
    `Each card needs: the word in ${deck.language}, a concise English meaning, a natural example sentence in ${deck.language} that uses the word, an English translation of that sentence, and an "emoji" field with 1-2 emoji that visually evoke the word's meaning (a memory aid).`,
    `Use casual, everyday conversational ${deck.language} — the register people actually speak in daily life, not formal or literary language.`,
    ROMAN_RULE(deck.language, 'each word'),
    exclusions.length > 0
      ? `Do NOT include any of these words (already known or unwanted): ${exclusions.join(', ')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n')

  const parsed = await callGeminiJson<{ cards: Suggestion[] }>(prompt, CARDS_SCHEMA)

  // Belt-and-suspenders: filter exclusions client-side too
  const excluded = new Set(exclusions.map((w) => w.toLowerCase()))
  return parsed.cards.filter((c) => c.word && !excluded.has(c.word.toLowerCase()))
}

const EMOJI_SCHEMA = {
  type: 'OBJECT',
  properties: {
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          word: { type: 'STRING' },
          emoji: { type: 'STRING' },
        },
        required: ['word', 'emoji'],
      },
    },
  },
  required: ['items'],
}

/** Pick 1–2 mnemonic emoji for each word. Returns a lowercase word → emoji map. */
export async function generateEmojis(
  deck: Deck,
  words: { word: string; meaning: string }[],
): Promise<Map<string, string>> {
  const prompt = [
    `For each ${deck.language} vocabulary word below, pick 1-2 emoji that best visually evoke its meaning, as a memory aid for a language learner.`,
    `Prefer concrete, instantly recognizable emoji over abstract ones. Return every word exactly as given, each with its emoji.`,
    `Words:`,
    ...words.map((w) => `${w.word} — ${w.meaning}`),
  ].join('\n')

  const parsed = await callGeminiJson<{ items: { word: string; emoji: string }[] }>(
    prompt,
    EMOJI_SCHEMA,
  )
  const map = new Map<string, string>()
  for (const item of parsed.items) {
    if (item.word && item.emoji) map.set(item.word.trim().toLowerCase(), item.emoji.trim())
  }
  return map
}

const EXAMPLES_SCHEMA = {
  type: 'OBJECT',
  properties: {
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          word: { type: 'STRING' },
          example: { type: 'STRING' },
          exampleTranslation: { type: 'STRING' },
        },
        required: ['word', 'example', 'exampleTranslation'],
      },
    },
  },
  required: ['items'],
}

export interface GeneratedExample {
  example: string
  exampleTranslation: string
}

/** Write an example sentence (plus its English translation) for each word.
 *  Returns a lowercase word → sentence map, like `generateEmojis`. */
export async function generateExamples(
  deck: Deck,
  words: { word: string; meaning: string }[],
): Promise<Map<string, GeneratedExample>> {
  const prompt = [
    `For each ${deck.language} vocabulary word below, write one natural example sentence in ${deck.language} that uses the word, plus an English translation of that sentence.`,
    `Use casual, everyday conversational ${deck.language} — the register people actually speak in daily life, not formal or literary language.`,
    `Keep sentences short (roughly 6–12 words) and make the word's meaning clear from the context. Use the word in the exact sense given.`,
    `Return every word exactly as given, each with its sentence.`,
    `Words:`,
    ...words.map((w) => `${w.word} — ${w.meaning}`),
  ].join('\n')

  const parsed = await callGeminiJson<{
    items: { word: string; example: string; exampleTranslation: string }[]
  }>(prompt, EXAMPLES_SCHEMA)
  const map = new Map<string, GeneratedExample>()
  for (const item of parsed.items) {
    if (item.word && item.example)
      map.set(item.word.trim().toLowerCase(), {
        example: item.example.trim(),
        exampleTranslation: (item.exampleTranslation ?? '').trim(),
      })
  }
  return map
}

export interface GlossaryEntry {
  word: string
  meaning: string
  isNew: boolean
  /** Romanization, present for languages not written in the Latin alphabet. */
  roman?: string
  /** 1–2 mnemonic emoji, on content words concrete enough to picture. */
  emoji?: string
  /** The base word this one is built from ("makanya" → "makan"), when the
   *  surface form is derived or inflected. Absent when the word IS its base. */
  root?: string
  /** What that base word means on its own. */
  rootMeaning?: string
  /** How common the word is, 1 (top 500) to 5 (rare) — see `FREQ_BANDS`. */
  band?: number
}

/** Shared instruction for the two fields that exist to make a word stick: an
 *  emoji to picture it by, and the base word it was built from. Both are
 *  optional on purpose — an emoji forced onto "however" is noise, and a root
 *  that just repeats the word is worse than none. */
/** The frequency bands a word can be placed in. Mirrors `VOCAB_BANDS`, so
 *  the badge in the dictionary and the difficulty dial on the story form
 *  speak the same scale. A model's placement is an estimate, but a usefully
 *  honest one: it has read enough of the language to know "rumah" is not
 *  "rumpun", and that is all the badge needs to say — whether this word is
 *  worth a card, or a curiosity to let go of. */
export const FREQ_BANDS: { band: number; label: string; hint: string }[] = [
  { band: 1, label: 'top 500', hint: 'among the 500 commonest words — worth knowing cold' },
  { band: 2, label: 'top 1,000', hint: 'everyday conversation — well worth a card' },
  { band: 3, label: 'top 2,000', hint: 'ordinary vocabulary — worth a card' },
  { band: 4, label: 'top 4,000', hint: 'a fuller vocabulary — useful, not urgent' },
  { band: 5, label: 'rare', hint: 'uncommon — fine to look up and let go' },
]

function FREQ_RULE(language: string): string {
  return `Give every entry a "band" — how common the word is in everyday ${language}, as an integer: 1 if it is among the 500 most frequent words, 2 within the top 1,000, 3 within the top 2,000, 4 within the top 4,000, 5 if rarer than that. Judge the dictionary form's frequency, not the inflected one's. Personal names get 5.`
}

function MEMORY_RULE(language: string): string {
  return [
    `Give an "emoji" field (1-2 emoji) ONLY to content words concrete enough to picture instantly — a thing, an action, a vivid quality. Leave it off function words, names, numbers, and abstractions no emoji really depicts.`,
    `Where a word is derived or inflected from a simpler ${language} base word, give "root" (that base word, in its dictionary form) and "rootMeaning" (its English meaning) — e.g. Indonesian "makanya" from "makan" (to eat), "berjalan" from "jalan" (road, to walk). Omit both when the word already IS its own base, or when the base is not itself a real ${language} word.`,
  ].join('\n')
}

/** Shared instruction for the optional "roman" field: standard learner
 *  romanization for non-Latin scripts, omitted entirely for Latin ones. */
function ROMAN_RULE(language: string, what: string): string {
  return `If ${language} is NOT written in the Latin alphabet (e.g. Thai, Chinese, Japanese, Korean, Russian, Arabic…), give ${what} a "roman" field with its romanization, using the standard learner system for the language (Thai: Royal Thai General System with tone-friendly vowels; Chinese: Hanyu Pinyin with tone marks; Japanese: Hepburn; Korean: Revised Romanization). If ${language} uses the Latin alphabet, omit the "roman" field entirely.`
}

export interface Story {
  title: string
  story: string
  translation: string
  glossary: GlossaryEntry[]
  characterNames: string[]
  bible: StoryBible
  /** The plot in English, at most `SUMMARY_MAX_WORDS`, shown before the text.
   *  Also fed back as `avoidThemes` on later stories — a title says nothing
   *  about what a story actually did, which is the part that repeats. */
  summary?: string
}

const GLOSSARY_ARRAY = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      word: { type: 'STRING' },
      meaning: { type: 'STRING' },
      isNew: { type: 'BOOLEAN' },
      roman: { type: 'STRING' },
      emoji: { type: 'STRING' },
      root: { type: 'STRING' },
      rootMeaning: { type: 'STRING' },
      band: { type: 'INTEGER' },
    },
    required: ['word', 'meaning', 'isNew'],
  },
}

const GLOSSARY_SCHEMA = {
  type: 'OBJECT',
  properties: { glossary: GLOSSARY_ARRAY },
  required: ['glossary'],
}

/** The prose call's shape — no glossary, and no translation. Glossing every
 *  word of a story is several times more output than the story itself, and
 *  asking for both at once makes the two compete: the model that has to gloss
 *  what it writes writes less. The translation was split out for a blunter
 *  reason — it doubles the longest call's output, and on a 60-second function
 *  that is the difference between a story and a timeout. Both are separate
 *  passes over the finished text. */
const STORY_SCHEMA = {
  type: 'OBJECT',
  properties: {
    title: { type: 'STRING' },
    story: { type: 'STRING' },
    characterNames: { type: 'ARRAY', items: { type: 'STRING' } },
    bible: {
      type: 'OBJECT',
      properties: {
        logline: { type: 'STRING' },
        cast: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              name: { type: 'STRING' },
              role: { type: 'STRING' },
              wants: { type: 'STRING' },
            },
            required: ['name', 'role', 'wants'],
          },
        },
        places: { type: 'ARRAY', items: { type: 'STRING' } },
        facts: { type: 'ARRAY', items: { type: 'STRING' } },
        openThreads: { type: 'ARRAY', items: { type: 'STRING' } },
      },
      required: ['logline', 'cast', 'places', 'facts', 'openThreads'],
    },
  },
  required: ['title', 'story', 'characterNames', 'bible'],
}

/** The prose half of a story — what the writing call returns. Translation and
 *  glossary are added afterwards, each by its own pass. */
type StoryProse = Omit<Story, 'glossary' | 'translation' | 'summary'>

/** Most named characters a first part may introduce. Reading in a second
 *  language is slow enough that a fourth name costs more than it adds. */
const MAX_CAST = 4

/** How a serial part ends: on tension, or by settling it.
 *
 *  The reader reads serials, so the cadence is a TV season's: most parts end
 *  on something genuinely unresolved, roughly every third part pays the
 *  tension off, and a part that follows a resolution opens NEW trouble —
 *  which is why zero open threads always hooks. The roll is one number
 *  because the old ending machinery's mistake was not the idea but the
 *  elaboration: three modes, planned endings, and rules that outranked the
 *  reader's own steer. Here the steer always wins (the prompt says so), and
 *  the whole mechanism is this function. */
export type SerialEnding = 'hook' | 'resolve'

/** `troubleAge` is how many consecutive parts the current tension has been
 *  open, counting the part being continued. Trouble that opened only last
 *  part always survives this one — the eleven-part test run resolved its
 *  mother-in-law arc a single part after raising it, and an arc needs at
 *  least two parts of tension before paying off feels like anything. */
export function pickSerialEnding(openThreads: number, troubleAge = 2): SerialEnding {
  if (openThreads === 0) return 'hook'
  if (troubleAge < 2) return 'hook'
  return Math.random() < 1 / 3 ? 'resolve' : 'hook'
}

/** Roughly how many words a sentence of dialogue-led prose runs to. Used to
 *  turn a word target into a sentence count, which models hit far more
 *  reliably than a word count they can't actually compute. */
const WORDS_PER_SENTENCE = 9

/** The length instruction. A bare word count is the one thing a language model
 *  cannot verify about its own draft, so it reliably lands short; anchoring the
 *  target to countable structure — sentences and scenes — and asking a little
 *  above target is what actually moves the length. */
function lengthSpec(lengthWords: number): string {
  const sentences = Math.round(lengthWords / WORDS_PER_SENTENCE)
  const scenes = Math.max(2, Math.round(lengthWords / 120))
  return [
    `LENGTH — a hard requirement, and the one writers of these stories most often get wrong by stopping early.`,
    `Target: ${lengthWords}–${Math.round(lengthWords * 1.25)} words.`,
    `Because words are hard to count, hit it structurally instead: write about ${sentences} sentences (never fewer than ${Math.round(sentences * 0.9)}), spread over ${scenes} ${scenes === 1 ? 'scene' : 'distinct scenes'} — a change of place, of time, or of who is present marks a new scene.`,
    `A story of two or three exchanges is far too short. Give the plot enough turns to fill the length: keep the scene going past the first answer, let characters disagree, interrupt, change their minds.`,
    `When you think you are finished, check the sentence count and keep writing if it is short.`,
  ].join(' ')
}

/** How hard the story's vocabulary may be.
 *
 *  This replaced a "at most N% of the content words may be new" quota, which
 *  asked the model for the one thing it cannot do: count content words as it
 *  writes, diff each against a several-hundred-word bank, and hold a running
 *  ratio. Nothing measured the result either, so the number was simply ignored
 *  — a story asked for 2% new words came back with a tenth of its vocabulary
 *  outside the bank, and a plot to match.
 *
 *  A frequency band asks for a register instead. It applies at each individual
 *  word choice, locally, with no bookkeeping, and it is a register the model
 *  has seen an enormous amount of: graded readers, CEFR-levelled material,
 *  simple-language encyclopaedias. It cannot promise that word #1001 never
 *  appears — but a miss at this level is another easy word, where a missed
 *  quota was a story the reader could not read at all. */
export type VocabLevel = 1 | 2 | 3 | 4

export interface VocabBand {
  level: VocabLevel
  /** Button label in the story form. */
  label: string
  /** Size of the frequency band, in words — quoted to the model directly. */
  commonWords: number
  /** CEFR level. An anchor the model knows by name, and on its own a stronger
   *  signal than the word count: "A2" is a register it has read; "the top 1000
   *  words of Indonesian" is a list it does not actually hold. */
  cefr: string
  /** What picking this feels like to read. */
  hint: string
}

export const VOCAB_BANDS: VocabBand[] = [
  {
    level: 1,
    label: 'Simplest',
    commonWords: 500,
    cefr: 'CEFR A1',
    hint: 'Only the most basic everyday words, in short plain sentences.',
  },
  {
    level: 2,
    label: 'Easy',
    commonWords: 1000,
    cefr: 'CEFR A2',
    hint: 'The words of ordinary daily conversation — a beginner graded reader.',
  },
  {
    level: 3,
    label: 'Medium',
    commonWords: 2000,
    cefr: 'CEFR B1',
    hint: 'Everyday vocabulary with room for a little more range.',
  },
  {
    level: 4,
    label: 'Richer',
    commonWords: 4000,
    cefr: 'CEFR B2',
    hint: 'A fuller vocabulary — expect words you have not met.',
  },
]

/** Easy by default: the band someone reading a story built from their own word
 *  bank actually wants. */
export const DEFAULT_VOCAB_LEVEL: VocabLevel = 2

export function bandFor(level: VocabLevel): VocabBand {
  return VOCAB_BANDS.find((b) => b.level === level) ?? VOCAB_BANDS[1]
}

/** Bookish Indonesian: the register a model slides into when it is asked for a
 *  "story" rather than for speech. The generic register line asks for casual
 *  language and names one example (aku/saya), which turned out not to reach any
 *  of these. Every item here is a form that actually came back in a story
 *  generated at the easiest band. */
const ID_STORY_BANNED = [
  `Never use the honorific "beliau" — "dia" for everyone, whatever their age or standing.`,
  `Never use "tersebut" or other written-register back-references. Repeat the noun, or use "itu".`,
  `Never use written-register connectives: sehingga, namun, oleh karena itu, adapun, dengan demikian, seraya, sembari.`,
  `Never use reduplication for plurals or for "the gaps in" (buku-buku, sela-sela) — say it a plainer way.`,
  `Take the commonest synonym every single time, never the more exact or more elegant one: "tiba-tiba" not "mendadak", "sepi" not "sunyi", "melihat" not "menatap", "orang tua" not "tetua", "pintu" not "gerbang", "tas" not "ransel", "keluar dari" not "menyembul".`,
]

/** The writing pass's vocabulary line: the band, stated plainly and briefly.
 *
 *  Deliberately NOT the full `vocabSpec`. That block — six rules and a
 *  re-read ritual — is enforcement machinery, and enforcement while writing
 *  bends the prose: the writer reaches for a circumlocution mid-sentence and
 *  the sentence shows it. Writing gets the register; the simplify pass, which
 *  edits one word at a time with nothing to trade against, gets the rules. */
function vocabHint(language: string, band: VocabBand): string {
  return `VOCABULARY — ${band.cefr}: build the story from roughly the ${band.commonWords} most common words of ${language}, in simple sentences — the register of a graded reader. Where two words mean nearly the same thing, take the commoner one. A few words above the band are acceptable when the story needs them; a plainer word is always preferred.`
}

/** The vocabulary instruction: a ceiling on which words may exist at all, never
 *  a quota over how many are new.
 *
 *  Three of these lines exist because of specific words that got through at the
 *  easiest band. Narration, because the dialogue came back simple and the prose
 *  around it did not. Physical description, because a story told to make its
 *  details SPECIFIC will reach for the exact word for a thing, and the exact
 *  word for a thing is nearly always a rare one — that single pull produced
 *  most of the hard vocabulary in the story that prompted this. And the
 *  re-read, because the same self-check is what makes the dialogue writer's
 *  much stricter word-bank rule hold. */
function vocabSpec(language: string, band: VocabBand): string {
  const rules = [
    `Build the story from the ${band.commonWords} most common words of ${language} — the everyday words a native speaker uses in ordinary conversation, the vocabulary of a graded reader at this level.`,
    `Whenever a word would be literary, formal, technical, bookish or merely uncommon, it is out of bounds: say the same thing with a plainer word, or with several simple words in place of one hard one. A story that says something a little more plainly than you intended is correct; a story with a word the reader cannot read is not.`,
    `Where two words mean nearly the same thing, always take the commoner one — the word a child would use, not the more precise or more literary one.`,
    `This applies to NARRATION as much as to dialogue. Narration is where hard words creep back in once the dialogue is simple.`,
    `PHYSICAL DETAIL is where this rule is usually lost. Naming an object, texture or gesture exactly nearly always means a rare word. Do not reach for the exact word: describe the thing in simple words, or choose a different detail that common words can name. A precise description is never worth a word the reader cannot read.`,
    `Test every word: would someone a few months into learning ${language} know it? If not, replace it.`,
  ]
  if (langCodeFor(language) === 'id') rules.push(...ID_STORY_BANNED)
  return [
    `VOCABULARY — ${band.cefr}. The difficulty dial for this story, and the requirement most easily lost while writing.`,
    ...rules.map((r) => `• ${r}`),
    `• BEFORE YOU RETURN: re-read the finished story word by word and replace every word that breaks these rules. Do this last, and do it properly — it matters more than any other check.`,
  ].join('\n')
}

const EXTEND_SCHEMA = {
  type: 'OBJECT',
  properties: {
    story: { type: 'STRING' },
    characterNames: STORY_SCHEMA.properties.characterNames,
    bible: STORY_SCHEMA.properties.bible,
  },
  required: ['story', 'bible'],
}

const TRANSLATION_SCHEMA = {
  type: 'OBJECT',
  properties: { translation: { type: 'STRING' }, summary: { type: 'STRING' } },
  required: ['translation', 'summary'],
}

/** Longest the plot summary may run. Short enough to be read before the
 *  story without becoming a second story. */
export const SUMMARY_MAX_WORDS = 50

/** Translate the finished story into English, in one pass over the final text.
 *  Split out of the writing call because it doubled that call's output for
 *  something mechanical — and doing it last means extensions cost nothing here
 *  and the English reads as one piece rather than as spliced fragments. */
async function translateStory(
  deck: Deck,
  story: string,
  onMeta?: (m: CallMeta) => void,
): Promise<{ translation: string; summary: string }> {
  const prompt = [
    `Translate this ${deck.language} story into natural English. Return the whole translation as one string in "translation".`,
    `Keep the paragraph breaks of the original, keep dialogue inside quotation marks “…”, and translate every line — do not summarise, abridge or add anything.`,
    `Write English a person would actually write: idiomatic, not a word-for-word calque of the ${deck.language}.`,
    // The summary is made here, from the text as it finally stands, rather
    // than in the writing pass: extensions and the vocabulary edit both
    // change the story after it is written, and a summary of the draft can
    // end up describing a scene that was cut.
    `Also return "summary": the plot of this story in English, at most ${SUMMARY_MAX_WORDS} words. It is shown to the learner BEFORE they read, so they can spend their attention on the language rather than on working out what is happening. Plain and concrete — who, where, what happens — naming the characters. No suspense-building, no questions, no commentary on the story.`,
    `Story:\n${story}`,
  ].join('\n')

  const parsed = await callGeminiJson<{ translation: string; summary: string }>(
    prompt,
    TRANSLATION_SCHEMA,
    { label: 'translate', onMeta },
  )
  return { translation: parsed.translation ?? '', summary: clipWords(parsed.summary ?? '', SUMMARY_MAX_WORDS) }
}

/** Cut a text to its first `max` words. The model is asked for the limit and
 *  usually keeps it; this is for the times it doesn't. */
export function clipWords(text: string, max: number): string {
  const words = text.trim().split(/\s+/).filter(Boolean)
  if (words.length <= max) return words.join(' ')
  return `${words.slice(0, max).join(' ')}…`
}

/** Roughly how much story one glossary call can cover inside the function's
 *  time budget. The glossary is by far the largest output in the pipeline —
 *  every distinct word of the story paired with a meaning runs to several times
 *  the token count of the story itself — so this is the call that reaches the
 *  60-second limit first, and the only thing that shrinks it is covering less
 *  text per call. Lowered from 300 when entries grew an emoji and a root. */
export const GLOSSARY_CHUNK_WORDS = 250

/** Break a story into pieces small enough to gloss in one call each, preferring
 *  paragraph boundaries, falling back to sentence boundaries for a paragraph
 *  oversized on its own, then grouping back up so short paragraphs share a
 *  call. Sense comes from the surrounding sentence, which stays intact either
 *  way, so splitting costs the glossary nothing. */
export function splitForGlossary(text: string, langCode: string | null): string[] {
  const pieces: string[] = []
  for (const para of text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)) {
    if (countWords(para, langCode) <= GLOSSARY_CHUNK_WORDS) {
      pieces.push(para)
      continue
    }
    let buf = ''
    for (const sentence of para.split(/(?<=[.!?…”"])\s+/)) {
      if (buf && countWords(`${buf} ${sentence}`, langCode) > GLOSSARY_CHUNK_WORDS) {
        pieces.push(buf)
        buf = sentence
      } else {
        buf = buf ? `${buf} ${sentence}` : sentence
      }
    }
    if (buf) pieces.push(buf)
  }

  const chunks: string[] = []
  let current = ''
  for (const piece of pieces) {
    if (current && countWords(`${current}\n\n${piece}`, langCode) > GLOSSARY_CHUNK_WORDS) {
      chunks.push(current)
      current = piece
    } else {
      current = current ? `${current}\n\n${piece}` : piece
    }
  }
  if (current) chunks.push(current)
  return chunks.length > 0 ? chunks : [text]
}

/** Gloss a finished story: every word of it, in the surface form it appears
 *  in, so a reader can tap anything. Split out of the writing call — annotating
 *  a text that already exists is a different, easier job than predicting the
 *  glossary of a text being written, and it leaves the writing call free to
 *  spend its whole output on prose.
 *
 *  Long stories are glossed in parallel pieces, so the pass costs about as much
 *  wall-clock as its slowest piece rather than the sum of all of them. */
async function glossaryFor(opts: {
  deck: Deck
  story: StoryProse
  bankWords: string[]
  onMeta?: (m: CallMeta) => void
}): Promise<GlossaryEntry[]> {
  const { deck, story, bankWords, onMeta } = opts
  const chunks = splitForGlossary(story.story, langCodeFor(deck.language))

  const promptFor = (chunk: string) =>
    [
      chunks.length > 1
        ? `Below is an EXTRACT from a story in ${deck.language}, written for a language learner who reads it by tapping words for their meanings. Build the lookup glossary for this extract. Other extracts are handled separately — cover only the words below.`
        : `Below is a finished story in ${deck.language}, written for a language learner who reads it by tapping words for their meanings. Build the lookup glossary for it.`,
      `Text:\n${chunk}`,
      `List EVERY distinct word that appears in the text above — content words AND function words (pronouns, prepositions, particles, connectives, numbers, everything), including character names. Use the exact surface form used in the text (keep inflected, conjugated and affixed forms as they appear; do not reduce them to dictionary form). Give each a concise English meaning matching the sense it carries in that sentence, not its most common sense in isolation.`,
      `The reader must be able to look up any single word of the text and find it here. Do not skip words that seem obvious, and do not add words that do not appear in the text.`,
      bankWords.length > 0
        ? `The learner's word bank: ${bankWords.join(', ')}. Set isNew=true only for content words (nouns, verbs, adjectives, adverbs) outside this bank. Function words are never isNew, and neither are personal names${story.characterNames?.length ? ` (${story.characterNames.join(', ')})` : ''}.`
        : `Set isNew=true only for content words (nouns, verbs, adjectives, adverbs); function words and personal names are never isNew.`,
      ROMAN_RULE(deck.language, 'every glossary entry'),
      MEMORY_RULE(deck.language),
      FREQ_RULE(deck.language),
    ]
      .filter(Boolean)
      .join('\n')

  const metas: CallMeta[] = []
  const lists = await Promise.all(
    chunks.map((chunk, i) =>
      callGeminiJson<{ glossary: GlossaryEntry[] }>(promptFor(chunk), GLOSSARY_SCHEMA, {
        label: chunks.length > 1 ? `glossary-${i + 1}/${chunks.length}` : 'glossary',
        onMeta: (m) => metas.push(m),
      }).then((p) => p.glossary ?? []),
    ),
  )

  const sum = (pick: (m: CallMeta) => number | undefined) =>
    metas.reduce((n, m) => n + (pick(m) ?? 0), 0)
  onMeta?.({
    model: metas[0]?.model,
    thinking: metas[0]?.thinking,
    // The pieces ran together, so the pass cost the slowest of them, not the sum.
    ms: Math.max(0, ...metas.map((m) => m.ms ?? 0)),
    promptTokens: sum((m) => m.promptTokens),
    outputTokens: sum((m) => m.outputTokens),
    thoughtTokens: sum((m) => m.thoughtTokens),
    passes: chunks.length,
  })

  // First mention of a word wins: the pieces share one bank list, so they agree
  // about what is new, and the earliest use is the one the reader meets first.
  const merged = new Map<string, GlossaryEntry>()
  for (const list of lists) {
    for (const entry of list) {
      const key = entry.word?.trim().toLowerCase()
      if (key && !merged.has(key)) merged.set(key, entry)
    }
  }
  return [...merged.values()]
}

const SIMPLIFY_SCHEMA = {
  type: 'OBJECT',
  properties: { text: { type: 'STRING' } },
  required: ['text'],
}

/** Words per simplification call. Comfortably larger than the glossary's chunk:
 *  the output here is the text itself, where the glossary's is an entry per
 *  distinct word, several times longer than what it covers. */
export const SIMPLIFY_CHUNK_WORDS = 400

/** A chunk that comes back under this share of its original length dropped
 *  something rather than simplifying it, and is thrown away. */
const SIMPLIFY_MIN_KEPT = 0.6

/** Group whole paragraphs into chunks of at most `maxWords`.
 *
 *  Unlike `splitForGlossary` this never breaks a paragraph, so joining the
 *  chunks back with blank lines reproduces the story exactly. The glossary
 *  splitter cannot promise that and does not need to — it only reads the text.
 *  This one's output replaces it. A single paragraph over the budget becomes an
 *  oversized chunk of its own rather than being split. */
export function groupParagraphs(
  text: string,
  langCode: string | null,
  maxWords: number,
): string[] {
  const paras = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)
  const chunks: string[] = []
  let current = ''
  for (const para of paras) {
    if (current && countWords(`${current}\n\n${para}`, langCode) > maxWords) {
      chunks.push(current)
      current = para
    } else {
      current = current ? `${current}\n\n${para}` : para
    }
  }
  if (current) chunks.push(current)
  return chunks.length > 0 ? chunks : [text]
}

/** Distinct words that were in the prose before this pass and are gone after
 *  it — the trace's one-number answer to "did that actually change anything?". */
export function swappedWords(before: string, after: string, langCode: string | null): number {
  const keys = (t: string) => {
    const set = new Set<string>()
    for (const tok of tokenizeWords(t, langCode)) {
      const k = tok.trim().toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
      if (k) set.add(k)
    }
    return set
  }
  const had = keys(before)
  const has = keys(after)
  let n = 0
  for (const k of had) if (!has.has(k)) n++
  return n
}

/** Second pass over the finished prose: replace every word above the band and
 *  change nothing else.
 *
 *  Writing under a vocabulary ceiling and checking one afterwards are different
 *  jobs, and the model is far better at the second. While generating it holds a
 *  plot, a cast, a length, a register and an ending all at once, and vocabulary
 *  is the constraint that quietly loses to the others — asking harder did not
 *  fix that, because the instruction was never what was missing. Editing, the
 *  text already exists: the judgement is one word at a time, local, with
 *  nothing to trade it against. It is the same reason the length loop works by
 *  measuring the draft rather than by asking for length more firmly.
 *
 *  Pieces run in parallel, and any piece that fails or comes back truncated
 *  falls back to its original text — a paragraph that is too hard beats a
 *  paragraph that is missing. */
async function simplifyStory(opts: {
  deck: Deck
  story: string
  band: VocabBand
  characterNames: string[]
  onMeta?: (m: CallMeta) => void
}): Promise<string> {
  const { deck, story, band, characterNames, onMeta } = opts
  const langCode = langCodeFor(deck.language)
  const chunks = groupParagraphs(story, langCode, SIMPLIFY_CHUNK_WORDS)

  const promptFor = (chunk: string) =>
    [
      chunks.length > 1
        ? `Below is an EXTRACT from a story in ${deck.language} written for a language learner. Some of its words are above the reader's level. Rewrite the extract so every word is inside the vocabulary below, and change nothing else. Other extracts are handled separately — edit only the text below.`
        : `Below is a story in ${deck.language} written for a language learner. Some of its words are above the reader's level. Rewrite it so every word is inside the vocabulary below, and change nothing else.`,
      vocabSpec(deck.language, band),
      `HOW TO EDIT — this is a vocabulary edit, not a rewrite:`,
      `• Keep the events, the people, the order and the meaning exactly as they are. Add nothing, cut nothing, and improve nothing.`,
      `• Keep every paragraph break, and keep all dialogue inside “…”.`,
      characterNames.length > 0
        ? `• Keep these names spelled exactly as they are: ${characterNames.join(', ')}.`
        : '',
      `• Keep the length. Replacing one hard word with three easy ones is right; dropping the sentence is not.`,
      `• Where a sentence can only be said with a hard word, change what is DESCRIBED rather than what happens — a plainer object, a different detail — so the plot still runs exactly as before.`,
      `• Where a sentence is already simple enough, leave it alone word for word.`,
      `Return the complete edited text in "text": the whole extract, not a summary, and not only the parts you changed.`,
      `Text:\n${chunk}`,
    ]
      .filter(Boolean)
      .join('\n')

  const metas: CallMeta[] = []
  const edited = await Promise.all(
    chunks.map((chunk, i) =>
      callGeminiJson<{ text: string }>(promptFor(chunk), SIMPLIFY_SCHEMA, {
        label: chunks.length > 1 ? `simplify-${i + 1}/${chunks.length}` : 'simplify',
        onMeta: (m) => metas.push(m),
      })
        .then((r) => {
          const text = (r.text ?? '').trim()
          if (countWords(text, langCode) < countWords(chunk, langCode) * SIMPLIFY_MIN_KEPT) {
            console.warn(`[story] simplify piece ${i + 1} came back short — keeping the original`)
            return chunk
          }
          return text
        })
        .catch((e) => {
          console.warn(`[story] simplify piece ${i + 1} failed — keeping the original`, e)
          return chunk
        }),
    ),
  )

  const sum = (pick: (m: CallMeta) => number | undefined) =>
    metas.reduce((n, m) => n + (pick(m) ?? 0), 0)
  onMeta?.({
    model: metas[0]?.model,
    thinking: metas[0]?.thinking,
    ms: Math.max(0, ...metas.map((m) => m.ms ?? 0)),
    promptTokens: sum((m) => m.promptTokens),
    outputTokens: sum((m) => m.outputTokens),
    thoughtTokens: sum((m) => m.thoughtTokens),
    passes: chunks.length,
  })

  return edited.join('\n\n')
}

/** Grow a story that came back short: hand the draft back and ask for the
 *  missing stretch, then splice it on. The continuation carries its own
 *  ending, so the bible from this pass replaces the earlier one. */
async function extendStory(opts: {
  deck: Deck
  story: StoryProse
  missingWords: number
  band: VocabBand
  /** The ending mode the part was written for — the continuation becomes the
   *  new ending, so it has to land the same way. */
  ending: SerialEnding
  onMeta?: (m: CallMeta) => void
}): Promise<StoryProse> {
  const { deck, story, missingWords, band, ending, onMeta } = opts
  const prompt = [
    `Below is a story in ${deck.language} written for a language learner. It stopped too early — it needs about ${missingWords} more words.`,
    `Story so far, titled "${story.title}":\n${story.story}`,
    `Write ONLY the continuation: the text that follows on directly from the last line, in the same voice, tense and register, with the same characters. Do not repeat, recap or rewrite any of the above, and do not start a new story. Write it in ${deck.language} only — no English.`,
    lengthSpec(missingWords),
    `The continuation must carry the story forward with real events — a new turn, a complication, an arrival — not filler description or small talk stretched out.`,
    // This is a top-up of one part, not a new part: length is the only thing
    // missing, so it has no licence to grow the cast.
    `Do NOT introduce any new named character. Work with the people already in the story above.`,
    `IMPORTANT — register: casual, everyday spoken ${deck.language}, matching the story above. Keep dialogue inside quotation marks “…”.`,
    vocabSpec(deck.language, band),
    `Lean on the vocabulary the story above already uses — the reader has just read it.`,
    ending === 'resolve'
      ? `ENDING — the continuation settles the story: answer what it has been carrying and land it properly, concrete and earned. No moral, no summary.`
      : `ENDING — the continuation must still end on genuine unresolved tension, at a natural beat: the reader must be left needing the next part.`,
    `Return: "story" (the continuation text only), "characterNames" (any personal names appearing in the continuation), and "bible" (the world state after the continuation: logline, cast, places, facts, openThreads).`,
  ].join('\n')

  const more = await callGeminiJson<Omit<StoryProse, 'title'>>(prompt, EXTEND_SCHEMA, {
    tier: 'pro',
    effort: 'minimal',
    label: 'extend',
    onMeta,
  })
  return {
    ...story,
    story: `${story.story.trimEnd()}\n\n${more.story.trim()}`,
    characterNames: [
      ...new Set([...(story.characterNames ?? []), ...(more.characterNames ?? [])]),
    ],
    bible: more.bible ?? story.bible,
  }
}

/** How close to the requested length is close enough to stop topping up. */
const LENGTH_TOLERANCE = 0.9
/** Cap on top-up passes — each one is another round-trip. */
const MAX_EXTENSIONS = 2

export async function generateStory(opts: {
  deck: Deck
  knownWords: string[]
  learningWords: string[]
  /** How hard the story's vocabulary may be (see `VOCAB_BANDS`). */
  vocabLevel: VocabLevel
  topic?: string
  lengthWords: number
  /** Premises/topics of the learner's previous stories — steer clear of their themes. */
  avoidThemes?: string[]
  /** Character names the learner's recent stories used — the plan picks new ones. */
  avoidNames?: string[]
  /** Continue this existing story instead of starting a fresh one. `direction`
   *  is the reader's optional steer for what should happen next, `bible` the
   *  world state the previous part left behind, `topic` what the reader asked
   *  for when the thread began — the genre anchor. */
  continueFrom?: {
    title: string
    story: string
    direction?: string
    bible?: StoryBible
    topic?: string
  }
  /** How this part ends. Rolled from the thread's open tension when not
   *  given (see `pickSerialEnding`); a caller (or the lab) may force it. */
  ending?: SerialEnding
  /** Consecutive parts the current trouble has been open (see
   *  `pickSerialEnding`). Omitted = old enough to resolve. */
  troubleAge?: number
  /** Words the learner keeps forgetting — worked into the plot on purpose so
   *  they're met repeatedly, in context, instead of only on a flashcard. */
  focusWords?: string[]
  /** Words the learner met in earlier stories and is due to meet again (see
   *  `dueForRecurrence`). Unlike focus words these are a preference only: the
   *  spacing is what matters, and a story bent to fit a word in teaches the
   *  word worse than a story that left it out. */
  recurWords?: string[]
  /** Called with the running trace whenever a pass starts or finishes, so the
   *  UI can show what the wait is for and what each pass cost. */
  onProgress?: (steps: StoryStep[]) => void
}): Promise<Story> {
  const { deck, knownWords, learningWords, vocabLevel, topic, lengthWords } = opts
  const { avoidThemes = [], avoidNames = [], continueFrom, focusWords = [] } = opts
  const ending =
    opts.ending ??
    pickSerialEnding(continueFrom?.bible?.openThreads?.length ?? 0, opts.troubleAge)
  const { recurWords = [] } = opts

  const bible = continueFrom?.bible
  const langCode = langCodeFor(deck.language)
  const band = bandFor(vocabLevel)

  const steps: StoryStep[] = []
  const emit = () => opts.onProgress?.(steps.map((s) => ({ ...s })))

  /** Run one pass inside the trace: time it, record what it produced, and log
   *  it. A pass that throws is recorded before the error propagates, so a
   *  failed generation still says which pass died and how long it took. */
  async function step<T>(
    key: string,
    label: string,
    run: (onMeta: (m: CallMeta) => void) => Promise<T>,
    detail?: (result: T) => string,
  ): Promise<T> {
    const s: StoryStep = { key, label, startedAt: Date.now() }
    steps.push(s)
    emit()
    try {
      const result = await run((m) => {
        s.meta = m
      })
      s.ms = Date.now() - s.startedAt
      s.ok = true
      s.detail = detail?.(result)
      emit()
      console.log(`[story] ${key} ${(s.ms / 1000).toFixed(1)}s`, {
        detail: s.detail,
        ...s.meta,
      })
      return result
    } catch (e) {
      s.ms = Date.now() - s.startedAt
      s.ok = false
      s.error = e instanceof Error ? e.message : String(e)
      emit()
      console.error(`[story] ${key} failed after ${(s.ms / 1000).toFixed(1)}s`, s.error)
      throw e
    }
  }

  // One writing call, and the topic — or the thread being continued — is the
  // whole brief. This replaced a planning pass and a rolled four-way "angle"
  // that were injected as binding constraints: they bought variety, but they
  // also overrode the reader's own topic, derailed continuations with random
  // unrelated dimensions, and their enforcement showed in the prose. Variety
  // is now asked for with two non-binding avoid-lists instead, and judged by
  // reading the output (scripts/story-lab.mts).
  const prompt = [
    continueFrom
      ? `Below is a story in ${deck.language} that a language learner has been reading. Write the NEXT PART of it: continue seamlessly from where it ends, with the same people, the same world and the same feel. Advance the story — something new happens; do not re-tell, recap or pad.`
      : `Write a short story in ${deck.language} for a language learner.`,
    continueFrom ? `Previous part, titled "${continueFrom.title}":\n${continueFrom.story}` : '',
    bible
      ? [
          `STORY BIBLE — the world so far. All of it is already true: don't contradict it, and don't re-introduce these characters as though the reader were meeting them for the first time.`,
          `Cast: ${bible.cast.map((c) => `${c.name} (${c.role}; wants ${c.wants})`).join('; ')}`,
          bible.places.length > 0 ? `Places: ${bible.places.join('; ')}` : '',
          bible.facts.length > 0 ? `Established facts: ${bible.facts.join('; ')}` : '',
          bible.openThreads.length > 0
            ? `Open questions the reader is carrying — move the ones this part naturally moves, keep the rest alive: ${bible.openThreads.join('; ')}`
            : '',
        ]
          .filter(Boolean)
          .join('\n')
      : '',
    continueFrom?.direction?.trim()
      ? `THE READER ASKED FOR THIS NEXT: "${continueFrom.direction.trim()}". It must actually happen in this part — starting early, not teased for the end.`
      : '',
    continueFrom && (bible?.openThreads?.length ?? 0) === 0
      ? `The previous part settled its story. This part starts NEW trouble for these people — a fresh want, problem or arrival — and it should start early, not in the final lines. It must be a DIFFERENT KIND of trouble from what this thread has already played: reread the part above, and if its tension came from a secret, an illness or a message, find another door in.`
      : '',
    // Serials drift, and some drift is the fun — but six parts in, "a love
    // story" had become a kidnapping thriller, and the model's cheapest
    // escalation (news withheld, then delivered by phone) had run twice.
    // Both lines are soft; the reader's steer still outranks everything.
    continueFrom?.topic?.trim()
      ? `THE KIND OF STORY: the reader asked for "${continueFrom.topic.trim()}" when this began, and every part stays that kind of story — the trouble, the turns and the pleasures should all belong to it.`
      : '',
    continueFrom
      ? `VARY THE MACHINERY: if this thread has already delivered a twist by phone call, message or photo, deliver this part's turn another way — in person, in the room, in something the reader watches happen.`
      : '',
    !continueFrom && topic?.trim()
      ? `THE READER ASKED FOR: "${topic.trim()}". This is the whole brief — the story must genuinely BE this, not merely mention it. If it names a genre (a love story, a mystery, a ghost story), deliver that genre's real pleasures at this reading level.`
      : '',
    !continueFrom && !topic?.trim()
      ? `Write a story you would actually want to read: specific people who want something, events that follow from each other, and an ending that lands. Any genre, any mood.`
      : '',
    // Both lists are requests, not rules — the machinery that used to enforce
    // variety also overrode the brief, which is a worse failure than a repeat.
    !continueFrom && avoidThemes.length > 0
      ? `The reader's recent stories, for variety: make this one clearly different in subject and in kind. Recent: ${avoidThemes.join('; ')}`
      : '',
    !continueFrom && avoidNames.length > 0
      ? `Recent stories used these character names — pick different ones: ${avoidNames.join(', ')}.`
      : '',
    continueFrom
      ? `You may introduce at most ONE new named character, and only if this part genuinely needs them.`
      : `Use at most ${MAX_CAST} named characters — two or three is better. Give them names natural for native ${deck.language} speakers, and refer to them by name, never as "the man" or "my friend". Return every personal name used in the characterNames array.`,
    lengthSpec(lengthWords),
    vocabHint(deck.language, band),
    continueFrom
      ? `The previous part above may use words harder than this band allows — do NOT match its vocabulary; the band wins, even where that makes this part plainer than the last.`
      : '',
    `REGISTER — casual, everyday conversational ${deck.language}, the way people actually talk in daily life (in Indonesian say "aku", not "saya"). No formal, literary or textbook language. Wrap all spoken lines in quotation marks “…”, never dashes.`,
    `THE LEARNER'S WORD BANK — a preference, not a limit: within the band, reach for these words first.`,
    knownWords.length > 0 ? `Known words — use freely: ${knownWords.join(', ')}` : '',
    learningWords.length > 0
      ? `Words being learned — weave in as many as fit naturally: ${learningWords.join(', ')}`
      : '',
    recurWords.length > 0
      ? `Words the reader is due to meet again — use whichever fall naturally into the story, and leave out any that don't. Never bend a sentence around one: ${recurWords.join(', ')}`
      : '',
    focusWords.length > 0
      ? `Words the learner keeps forgetting — each should appear a few times, in different sentences, and at least one should matter to the story. Never draw attention to them or define them: ${focusWords.join(', ')}`
      : '',
    // This is a serial: most parts end on tension, every third or so pays it
    // off, and the reader's own steer outranks either.
    ending === 'resolve'
      ? `ENDING — this part SETTLES things: answer the questions the story has been carrying, shown as a scene the reader watches, and land the part properly. A resolution changes something or costs something — a truth admitted, a promise made, a price paid; nobody simply turns out to have been nice all along. No moral, no summary, no looking back. Nothing needs saving for later — the next part will bring something new. (If the reader's request above asks for something else, the request wins.)`
      : `ENDING — this is a serial part: end on genuine unresolved tension. Something has just happened, arrived or been discovered, and the reader must not yet learn how it lands. Stop at the moment the next part becomes necessary — but end at a natural beat, never cut mid-scene for effect. (If the reader's request above asks for something else, the request wins.)`,
    `THE BIBLE: also return "bible" — the state of the story world after this part${continueFrom ? ', updated from the bible above (carry forward everything still true, add what this part established, drop questions it answered)' : ''}. "logline" is ONE English sentence recapping what happened, shown to the reader as "Previously…" before the next part. "cast" lists every named character with role and want; "places" the locations; "facts" the concrete details a later part must stay consistent with; "openThreads" the questions left open${
      ending === 'resolve'
        ? ', if any — after a part that settles its story this is often empty, and empty is correct: never invent a question just to have one'
        : ' — including the one your ending just raised'
    }. Keep the bible lean: list in "cast" only the people who still matter to the story (drop walk-ons), and keep "facts" to at most the 8 a later part must not contradict.`,
    `Return: a short title in ${deck.language}${continueFrom ? ' for this new part' : ''}, the story and the bible. Write the story in ${deck.language} only — it is translated and glossed separately afterwards. Spend everything on the story itself.`,
  ]
    .filter(Boolean)
    .join('\n')

  // The one creative call: pro model, story in one go.
  let prose = await step(
    'write',
    'Writing',
    (onMeta) =>
      callGeminiJson<StoryProse>(prompt, STORY_SCHEMA, {
        tier: 'pro',
        effort: 'minimal',
        label: 'write',
        onMeta,
      }),
    (p) => `${countWords(p.story, langCode)} of ${lengthWords} words`,
  )

  // Models can't count their own words, so a draft routinely lands well under
  // the requested length. Measure it the same way the reader does and, while
  // it's short, ask for the missing stretch and splice it on.
  for (let pass = 0; pass < MAX_EXTENSIONS; pass++) {
    const have = countWords(prose.story, langCode)
    if (have >= lengthWords * LENGTH_TOLERANCE) break
    try {
      prose = await step(
        `extend-${pass + 1}`,
        `Making it longer (${have} of ${lengthWords} words)`,
        (onMeta) =>
          extendStory({
            deck,
            story: prose,
            missingWords: Math.max(40, lengthWords - have),
            band,
            ending,
            onMeta,
          }),
        (p) => `${countWords(p.story, langCode)} of ${lengthWords} words`,
      )
    } catch {
      // A failed top-up shouldn't cost the reader the story they already have.
      break
    }
  }

  // Now bring the vocabulary down to the band. This has to happen before the
  // translation and the glossary, which both read the final text — and after
  // the extensions, so a spliced-on stretch is checked too.
  //
  // Best-effort, like the glossary: a story that is written and readable should
  // never be lost to the pass that was only meant to polish it.
  const written = prose.story
  try {
    const simpler = await step(
      'simplify',
      'Making the words easier',
      (onMeta) =>
        simplifyStory({
          deck,
          story: written,
          band,
          characterNames: prose.characterNames ?? [],
          onMeta,
        }),
      (after) => `${swappedWords(written, after, langCode)} words swapped out`,
    )
    prose = { ...prose, story: simpler }
  } catch {
    console.warn('[story] simplify failed — the story stands as written')
  }

  // Translate and gloss last, once each, over the text as it finally stands —
  // so extensions cost nothing extra here, the English reads as one piece, and
  // no word of the story goes unglossed.
  const { translation, summary } = await step(
    'translate',
    'Translating',
    (onMeta) => translateStory(deck, prose.story, onMeta),
    (t) => `${countWords(t.translation, 'en')} words`,
  )

  // The glossary is the one pass that may fail without costing the reader the
  // story. It is the largest output and it runs last, so a story that is fully
  // written and translated would otherwise be thrown away over its lookup
  // table — and the reader can still tap any word, because `defineWords` fills
  // in whatever the glossary is missing, on demand, as they read.
  let glossary: GlossaryEntry[] = []
  try {
    glossary = await step(
      'glossary',
      'Looking up the words',
      (onMeta) =>
        glossaryFor({ deck, story: prose, bankWords: [...knownWords, ...learningWords], onMeta }),
      (g) => `${g.length} entries`,
    )
  } catch {
    console.warn('[story] glossary failed — the story stands, words resolve on tap instead')
  }

  const total = steps.reduce((sum, s) => sum + (s.ms ?? 0), 0)
  console.log(`[story] done in ${(total / 1000).toFixed(1)}s`, steps)
  return { ...prose, translation, glossary, summary }
}

const MNEMONIC_SCHEMA = {
  type: 'OBJECT',
  properties: { keyword: { type: 'STRING' }, mnemonic: { type: 'STRING' } },
  required: ['keyword', 'mnemonic'],
}

export interface Mnemonic {
  /** The English sound-alike the image hangs on — "pin to" for pintu. */
  keyword: string
  /** One sentence tying the sound-alike to the meaning. */
  mnemonic: string
}

/** A keyword-method mnemonic for one stubborn word.
 *
 *  The keyword method (Atkinson, 1975) is among the best-evidenced techniques
 *  for vocabulary: find a first-language word that SOUNDS like the foreign
 *  one, then a vivid image in which that sound-alike does the foreign word's
 *  meaning. "pintu" → "pin to" → pin a note TO the door. The sound carries
 *  the reader to the keyword, the image carries the keyword to the meaning.
 *
 *  Asked for on demand, for words the reader keeps needing to look up — a
 *  mnemonic on a word that is sticking by itself is clutter. */
export async function generateMnemonic(opts: {
  deck: Deck
  word: string
  meaning: string
  roman?: string
}): Promise<Mnemonic> {
  const { deck, word, meaning, roman } = opts
  const prompt = [
    `Make a keyword-method mnemonic for an English speaker learning ${deck.language} who keeps forgetting the word "${word}"${roman ? ` (pronounced roughly "${roman}")` : ''}, meaning "${meaning}".`,
    `Step 1 — "keyword": an English word or short phrase that SOUNDS like "${word}" (or like its first syllables) when said aloud. Sound is everything here: pick by ear, not by spelling, and prefer something concrete that can be pictured.`,
    `Step 2 — "mnemonic": ONE short sentence (at most 20 words) in which the keyword's image does the thing the word means, so vividly it is hard to forget — absurd, physical, specific. Write the sound-alike part in CAPITALS so the reader can hear it. Example for pintu / door: "PIN a note TO the door and slam it."`,
    `Rules: the sentence must contain the meaning plainly (the reader should get from the picture to "${meaning}" without guessing). Do not explain the technique, do not add options, do not mention ${deck.language}. Return only the two fields.`,
  ].join('\n')
  const m = await callGeminiJson<Mnemonic>(prompt, MNEMONIC_SCHEMA, { label: 'mnemonic' })
  return { keyword: (m.keyword ?? '').trim(), mnemonic: (m.mnemonic ?? '').trim() }
}

const DEFINE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    meaning: { type: 'STRING' },
    isContentWord: { type: 'BOOLEAN' },
    roman: { type: 'STRING' },
    emoji: { type: 'STRING' },
    root: { type: 'STRING' },
    rootMeaning: { type: 'STRING' },
    band: { type: 'INTEGER' },
  },
  required: ['meaning', 'isContentWord'],
}

/** Define a single word on demand — fallback for story words the glossary missed. */
export async function defineWord(opts: {
  deck: Deck
  word: string
  /** Sentence the word was tapped in, to pin down the sense used. */
  sentence?: string
}): Promise<WordDefinition> {
  const { deck, word, sentence } = opts
  const prompt = [
    `Give a concise English meaning for the ${deck.language} word "${word}", as a glossary entry for a language learner.`,
    sentence?.trim() ? `It appears in this sentence — define the sense used here: "${sentence.trim()}"` : '',
    `Also report whether it is a content word (noun, verb, adjective or adverb) rather than a function word.`,
    ROMAN_RULE(deck.language, 'the word'),
    MEMORY_RULE(deck.language),
    FREQ_RULE(deck.language),
  ]
    .filter(Boolean)
    .join('\n')
  return callGeminiJson<WordDefinition>(prompt, DEFINE_SCHEMA)
}

const DEFINE_MANY_SCHEMA = {
  type: 'OBJECT',
  properties: {
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          word: { type: 'STRING' },
          meaning: { type: 'STRING' },
          isContentWord: { type: 'BOOLEAN' },
          roman: { type: 'STRING' },
          emoji: { type: 'STRING' },
          root: { type: 'STRING' },
          rootMeaning: { type: 'STRING' },
          band: { type: 'INTEGER' },
        },
        required: ['word', 'meaning', 'isContentWord'],
      },
    },
  },
  required: ['items'],
}

/** Keep a band only if it is one of ours. */
export function bandOf(n: unknown): number | undefined {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 5 ? n : undefined
}

export interface WordDefinition {
  meaning: string
  isContentWord: boolean
  roman?: string
  emoji?: string
  root?: string
  rootMeaning?: string
  band?: number
}

/** Define a batch of words at once, each in the sentence it was used in — the
 *  same job as `defineWord`, done ahead of time for every word a story's
 *  glossary missed, so nothing is left needing the network mid-read.
 *  Returns a lowercase word → definition map. */
export async function defineWords(opts: {
  deck: Deck
  words: { word: string; sentence?: string }[]
}): Promise<Map<string, WordDefinition>> {
  const { deck, words } = opts
  const prompt = [
    `Below are ${deck.language} words a learner tapped while reading. Give each a concise English meaning, as a glossary entry.`,
    `Each word is listed with the sentence it appears in — define the sense it carries THERE, not its most common sense in isolation. Keep the word in the exact surface form given; do not reduce it to its dictionary form.`,
    `Also report, for each, whether it is a content word (noun, verb, adjective or adverb) rather than a function word. Personal names are not content words.`,
    `Return every word exactly as given, each with its meaning.`,
    ROMAN_RULE(deck.language, 'every entry'),
    MEMORY_RULE(deck.language),
    FREQ_RULE(deck.language),
    `Words:`,
    ...words.map((w) => (w.sentence ? `${w.word} — in: "${w.sentence.trim()}"` : w.word)),
  ]
    .filter(Boolean)
    .join('\n')

  const parsed = await callGeminiJson<{
    items: ({ word: string } & WordDefinition)[]
  }>(prompt, DEFINE_MANY_SCHEMA)
  const map = new Map<string, WordDefinition>()
  for (const item of parsed.items ?? []) {
    if (item.word && item.meaning)
      map.set(item.word.trim().toLowerCase(), {
        meaning: item.meaning.trim(),
        isContentWord: !!item.isContentWord,
        roman: item.roman?.trim() || undefined,
        emoji: item.emoji?.trim() || undefined,
        root: item.root?.trim() || undefined,
        rootMeaning: item.rootMeaning?.trim() || undefined,
        band: bandOf(item.band),
      })
  }
  return map
}

// ─── Translate: English → target-language dialogue ──────────────────────────

/** Grammar ceilings for Indonesian, written as three cumulative levels. The
 *  vocabulary is already pinned to the learner's word bank, so this is the only
 *  difficulty dial left — and left to itself a model writes literary prose no
 *  beginner can produce, so every level is spelled out rather than implied. */
const ID_LEVELS: string[][] = [
  [
    `Verbs in BASE FORM only — makan, minum, pergi, beli, lihat, tahu, bawa, kasih. No me-, ber-, di-, ter- prefixes and no -kan, -i or -an suffixes anywhere.`,
    `One clause per turn. Subject–verb–object, and the subject is always stated (never dropped).`,
    `No copula before an adjective: "Saya lapar", never "Saya adalah lapar".`,
    `Possessor follows the noun — "nama saya", "rumah kamu". No -ku / -mu / -nya clitics.`,
    `Negation: "tidak" before verbs and adjectives, "bukan" ONLY before a noun. "Harga itu tidak murah" — never "bukan murah". Use "bukan" only where a noun negation arises naturally; do not force one in to show it off.`,
    `Questions keep the question word in place — "Kamu mau apa?", "Dia di mana?", "Berapa harganya?" — and never use "apakah".`,
    `Time is carried by adverbs only, never by the verb: sudah, belum, akan, sedang, tadi, nanti, besok, kemarin.`,
    `Allowed modals: mau, bisa, harus, boleh. Allowed existential: ada.`,
    `4–10 words per turn.`,
  ],
  [
    `Verbs may take ber- and me- prefixes (bekerja, berangkat, membaca, membeli). Still no di- passive and no -kan / -i suffixes.`,
    `The clitics -ku, -mu and -nya are allowed for possession.`,
    `Simple "yang" relative clauses are allowed, at most one per turn.`,
    `Also allowed: masih, pernah, lagi, juga, saja, sekali.`,
    `At most one subordinate clause per turn, introduced by kalau, karena or waktu.`,
    `4–14 words per turn.`,
  ],
  [
    `The di- passive is allowed and encouraged where a native speaker would use it — Indonesian reaches for it far more often than English does.`,
    `The -kan and -i suffixes and the ke-…-an circumfix are allowed.`,
    `Conversational particles are allowed: -lah, kok, sih, dong, deh, ya, nih.`,
    `Colloquial contractions are allowed: nggak, udah, gimana, gitu, aja, banget, kayak.`,
    `4–18 words per turn.`,
  ],
]

const ID_ALWAYS_BANNED = [
  `Never use reduplication to mark a plural (buku-buku, anak-anak) — Indonesian does not need it and it confuses beginners.`,
  `Never use written-register connectives: sehingga, namun, oleh karena itu, adapun, dengan demikian.`,
  `No idioms, proverbs or figurative language. Every line must mean the sum of its words.`,
  `No Jakarta slang pronouns (gue, gua, lo, loe) and no regional dialect.`,
]

/** The grammar block for a dialogue: the cumulative Indonesian levels where we
 *  have them, a plain graded fallback everywhere else. */
function grammarSpec(language: string, level: 1 | 2 | 3): string {
  if (langCodeFor(language) === 'id') {
    const rules = ID_LEVELS.slice(0, level).flat()
    return [
      `GRAMMAR — level ${level} of 3. These are hard limits, not preferences. A line that breaks one is wrong even if it is beautiful ${language}.`,
      ...rules.map((r) => `• ${r}`),
      ...ID_ALWAYS_BANNED.map((r) => `• ${r}`),
    ].join('\n')
  }
  const generic = [
    [
      `One clause per sentence — no relative clauses, no subordination.`,
      `Present tense only. Subject always explicit. Subject–verb–object order.`,
      `4–10 words per turn.`,
    ],
    [`Past and future tenses are allowed. At most one subordinate clause per turn.`, `4–14 words per turn.`],
    [`Any everyday spoken construction is allowed, including conditionals and passives.`, `4–18 words per turn.`],
  ]
  return [
    `GRAMMAR — level ${level} of 3. These are hard limits, not preferences.`,
    ...generic.slice(0, level).flat().map((r) => `• ${r}`),
    `• No idioms, proverbs or figurative language. Every line must mean the sum of its words.`,
    `• Concrete over abstract: people doing things in places, not feelings about them.`,
  ].join('\n')
}

/** Register instruction. Standard spoken is the teachable middle — it is what
 *  most decks are built from — and level 3 is where the colloquial forms open
 *  up as a deliberate choice rather than as noise. */
function registerSpec(language: string, level: 1 | 2 | 3): string {
  if (langCodeFor(language) !== 'id') {
    return `REGISTER — casual, everyday spoken ${language}, the way people actually talk. Not formal, literary or textbook language.`
  }
  return [
    `REGISTER — standard spoken Indonesian. Use "saya" for I and "kamu" for you; "Anda" only if the scene is genuinely formal (an official, a stranger at a counter).`,
    level === 3
      ? `At this level colloquial forms (nggak, udah, aja) may appear, but keep them consistent within a speaker.`
      : `Write "tidak", "sudah" and "tidak ada" in full — no nggak, udah or gak at this level.`,
  ].join(' ')
}

export interface Dialogue {
  title: string
  scene: string
  turns: { speaker: string; english: string; target: string }[]
}

const DIALOGUE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    title: { type: 'STRING' },
    scene: { type: 'STRING' },
    turns: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          speaker: { type: 'STRING' },
          english: { type: 'STRING' },
          target: { type: 'STRING' },
        },
        required: ['speaker', 'english', 'target'],
      },
    },
  },
  required: ['title', 'scene', 'turns'],
}

/** Write the dialogue. Composed in the target language first and glossed into
 *  English second — the other order produces English-shaped sentences that only
 *  translate back word for word. */
export async function writeDialogue(opts: {
  deck: Deck
  knownWords: string[]
  level: 1 | 2 | 3
  turns: number
  /** How many distinct bank words the dialogue must actually use. */
  coverage: number
  topic?: string
  /** Titles of recent dialogues, so a new one doesn't replay the same scene. */
  avoidThemes?: string[]
}): Promise<Dialogue> {
  const { deck, knownWords, level, turns, coverage, topic, avoidThemes = [] } = opts
  const lang = deck.language
  const prompt = [
    `Write a short two-person dialogue in ${lang} for a language learner. The learner will be shown the ENGLISH of each line and must produce the ${lang} themselves, so the ${lang} has to be something a beginner could plausibly write.`,
    `Exactly ${turns} turns, alternating between two speakers. Give both speakers personal names that are natural and common for a native ${lang} speaker, and use the same two names throughout.`,
    topic?.trim()
      ? `Situation: "${topic.trim()}".`
      : `Invent an ordinary, concrete everyday situation with something small at stake — a disagreement, a request, a plan being made, a misunderstanding being cleared up. Not a bare greeting exchange, and not two people simply describing what they see.`,
    avoidThemes.length > 0
      ? `The learner's recent dialogues were: ${avoidThemes.join('; ')}. Pick a clearly different situation.`
      : '',
    `SCENE — return "scene": ONE short English line giving the place and who is talking (e.g. "At a food stall — Budi is ordering lunch from Sari"). It is shown to the learner untranslated. Without it, individual lines have too many valid renderings.`,
    grammarSpec(lang, level),
    registerSpec(lang, level),
    `VOCABULARY — the point of the whole exercise, and the constraint most easily broken. EVERY content word (noun, verb, adjective, adverb) must come from the learner's word bank below. If a line cannot be said with the bank, change what the character says — never reach outside it for a better word.`,
    knownWords.length > 0 ? `Word bank: ${knownWords.join(', ')}` : '',
    `The ONLY words allowed from outside the bank are function words: pronouns, prepositions, articles, question words, numbers, demonstratives, greetings, and common connectives. Every other word in the dialogue must appear in the bank above.`,
    `Before returning, re-read every line and replace any content word that is not in the bank.`,
    `COVERAGE — the dialogue must use at least ${coverage} DIFFERENT words from that bank. Spread them out; don't cram them into one turn.`,
    `ENGLISH — return "english" for every turn: natural, idiomatic English of what the speaker says, the kind a person would actually write. Do not word-for-word calque the ${lang}, and do not include the ${lang} in it.`,
    `DISAMBIGUATION — where English genuinely underdetermines the ${lang}, append a short square-bracket note to the English word, and nowhere else. Use exactly this style: "you [one person, casual]", "you [polite]", "you [all of you]", "we [you and me]", "we [not you]". Add a note only when the choice is truly undecidable from the English; never annotate anything else.`,
    `Return "title": a short English title for the scene.`,
  ]
    .filter(Boolean)
    .join('\n')

  const dialogue = await callGeminiJson<Dialogue>(prompt, DIALOGUE_SCHEMA)
  return { ...dialogue, turns: (dialogue.turns ?? []).filter((t) => t.english && t.target) }
}

const ALIGN_SCHEMA = {
  type: 'OBJECT',
  properties: {
    turns: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          index: { type: 'NUMBER' },
          hints: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                en: { type: 'STRING' },
                target: { type: 'STRING' },
                root: { type: 'STRING' },
              },
              required: ['en', 'target', 'root'],
            },
          },
        },
        required: ['index', 'hints'],
      },
    },
  },
  required: ['turns'],
}

/** Align each English line to the target line word by word, so tapping an
 *  English word can reveal the target word behind it. Split from the writing
 *  call for the same reason the story glossary is: annotating a finished text
 *  is an easier job than predicting it while composing. */
export async function alignDialogue(opts: {
  deck: Deck
  dialogue: Dialogue
}): Promise<{ index: number; hints: { en: string; target: string; root: string }[] }[]> {
  const { deck, dialogue } = opts
  const lang = deck.language
  const lines = dialogue.turns
    .map((t, i) => `${i}. EN: ${t.english}\n   ${lang.toUpperCase()}: ${t.target}`)
    .join('\n')
  const prompt = [
    `Below are pairs of lines: an English sentence and its ${lang} rendering. Align them word by word, so a learner stuck on an English word can be shown the ${lang} word that carries it.`,
    lines,
    `For each turn, return its "index" and a "hints" array. Each hint is: "en" — the English word or short phrase, copied EXACTLY as it appears in that English line, including its capitalisation; "target" — the ${lang} word or words that render it, copied exactly from the ${lang} line; "root" — the dictionary form "target" is built on.`,
    langCodeFor(lang) === 'id'
      ? `ROOT — strip every Indonesian affix to reach the base word a dictionary would list: membeli → beli, mengambil → ambil, berangkat → angkat, kedinginan → dingin, rumahnya → rumah, dimakan → makan. A word with no affix is its own root.`
      : `ROOT — the dictionary/citation form of the target word. A word already in that form is its own root.`,
    `Cover every content word (noun, verb, adjective, adverb) and every pronoun in the English line. Skip English function words that have no counterpart in the ${lang} ("the", "a", "do" in questions, "is" before an adjective).`,
    `"en" must be a run of consecutive words that really occurs in that English line — never invent or reorder. If a square-bracket note follows a word ("we [you and me]"), the "en" is the word alone, without the bracket.`,
    `Where several English words map to one ${lang} word, or one English word to several, make that a single hint pairing the whole spans.`,
  ].join('\n')

  const parsed = await callGeminiJson<{
    turns: { index: number; hints: { en: string; target: string; root: string }[] }[]
  }>(prompt, ALIGN_SCHEMA)
  return parsed.turns ?? []
}

const GRADE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    lines: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          index: { type: 'NUMBER' },
          verdict: { type: 'STRING', enum: ['right', 'close', 'missed'] },
          note: { type: 'STRING' },
          corrected: { type: 'STRING' },
        },
        required: ['index', 'verdict', 'note'],
      },
    },
    overall: { type: 'STRING' },
    pattern: { type: 'STRING' },
  },
  required: ['lines', 'overall'],
}

/** Indonesian's free variation. Without this list a grader marks perfectly good
 *  spoken Indonesian wrong, which is the fastest way to make the whole feature
 *  untrustworthy — and the paired list of real errors is where the useful
 *  feedback actually comes from. */
function acceptanceSpec(language: string): string {
  if (langCodeFor(language) !== 'id') {
    return `Accept any register or phrasing a native speaker would use for the same meaning. Only mark an answer wrong when the MEANING differs from the prompt.`
  }
  return [
    `ACCEPT SILENTLY — these are free variation in Indonesian, never errors:`,
    `• saya / aku, and kamu / Anda, unless the scene clearly fixes the register.`,
    `• tidak / nggak / gak / tak, and sudah / udah.`,
    `• A dropped subject where it is recoverable from context ("Mau ke mana?").`,
    `• The bare verb where the affixed form is textbook — "beli" for "membeli", "kasih" for "memberikan". This is how people actually speak.`,
    `• Adverb position: "besok saya pergi" and "saya pergi besok" are both fine.`,
    `• Any word order or word choice a native speaker would use for the same meaning.`,
    `ALWAYS CORRECT — these are real errors and must be marked:`,
    `• "tidak" where the negated word is a noun (needs "bukan"), and the reverse.`,
    `• "kita" (you and me) where the meaning is "kami" (not you), and the reverse.`,
    `• "adalah" placed before an adjective.`,
    `• Possessor before the noun ("saya nama" for "nama saya").`,
    `• English word order in questions ("Apa kamu mau?" for "Kamu mau apa?"), or a missing question word.`,
    `• A verb affix that changes the meaning (di- passive where the sense is active).`,
  ].join('\n')
}

/** Grade a finished dialogue in one call. Meaning is what is graded; the
 *  reference line is handed over as ONE acceptable answer, because a grader
 *  that treats it as ground truth marks good paraphrases wrong. */
export async function gradeTranslation(opts: {
  deck: Deck
  scene: string
  level: 1 | 2 | 3
  lines: {
    speaker: string
    english: string
    reference: string
    answer: string
    /** Whether the learner was shown the whole reference line. */
    shown: boolean
    /** Target words they half-revealed or fully opened. */
    revealed: string[]
  }[]
}): Promise<{
  lines: { index: number; verdict: 'right' | 'close' | 'missed'; note: string; corrected?: string }[]
  overall: string
  pattern?: string
}> {
  const { deck, scene, level, lines } = opts
  const lang = deck.language
  const body = lines
    .map((l, i) =>
      [
        `${i}. ${l.speaker} — EN: ${l.english}`,
        `   REFERENCE: ${l.reference}`,
        `   LEARNER WROTE: ${l.answer.trim() || '(nothing)'}`,
        l.shown ? `   (the learner was shown the reference for this line)` : '',
        l.revealed.length > 0 ? `   (took help on: ${l.revealed.join(', ')})` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n')

  const prompt = [
    `A learner of ${lang} translated an English dialogue into ${lang}, line by line. Grade it.`,
    `Scene: ${scene}`,
    body,
    `GRADE MEANING, NOT WORDING. The REFERENCE line is one acceptable answer among many — it is not the only correct rendering, and an answer that differs from it while carrying the same meaning is fully correct.`,
    acceptanceSpec(lang),
    `The dialogue was written to grammar level ${level} of 3, but do not penalise a learner for using a construction ABOVE that level correctly.`,
    `For each line return: its "index", a "verdict" of "right" (the meaning lands), "close" (meaning lands, but something is off — a wrong tense marker, an awkward word choice, a small grammar slip) or "missed" (the meaning changed, or nothing usable was written), and a "note" of one short sentence in plain English saying what happened. Point at the specific word that caused it. For "close" and "missed", also return "corrected": the learner's own line repaired, staying as close to what they wrote as possible rather than swapping in the reference.`,
    `Where the learner wrote nothing, verdict "missed" and note that it was skipped. Where they were shown the reference, grade what they wrote anyway but say the line was revealed.`,
    `"overall": two or three sentences addressed to the learner, in a warm, plain voice — what they did well and the one habit costing them most. No scores, no percentages, no bullet lists.`,
    `"pattern": the single grammar or vocabulary habit worth drilling next, in one short phrase (e.g. "using tidak where the negated word is a noun"). Omit it if there is no clear pattern.`,
  ].join('\n')

  return callGeminiJson(prompt, GRADE_SCHEMA)
}

export class ApiError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}
