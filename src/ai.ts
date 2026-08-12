import { db, type Deck, type StoryBible } from './db'
import { langCodeFor } from './speech'
import { countWords } from './text'

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
async function callGeminiJson<T>(
  prompt: string,
  schema: object,
  opts: { tier?: 'fast' | 'pro' } = {},
): Promise<T> {
  const thinking = await thinkingEnabled()
  let res: Response
  try {
    res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, schema, thinking, tier: opts.tier ?? 'fast' }),
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
  return body.data as T
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
    },
    required: ['word', 'meaning', 'isNew'],
  },
}

const GLOSSARY_SCHEMA = {
  type: 'OBJECT',
  properties: { glossary: GLOSSARY_ARRAY },
  required: ['glossary'],
}

/** The prose call's shape — no glossary. Glossing every word of a story is
 *  several times more output than the story itself, and asking for both at
 *  once makes the two compete: the model that has to gloss what it writes
 *  writes less. The glossary is a separate pass over the finished text. */
const STORY_SCHEMA = {
  type: 'OBJECT',
  properties: {
    title: { type: 'STRING' },
    story: { type: 'STRING' },
    translation: { type: 'STRING' },
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
  required: ['title', 'story', 'translation', 'characterNames', 'bible'],
}

/** The prose half of a story — what the writing call returns. */
type StoryProse = Omit<Story, 'glossary'>

/** Most named characters a first part may introduce. Reading in a second
 *  language is slow enough that a fourth name costs more than it adds. */
const MAX_CAST = 4

/** Dramatic turns a story can be built around. A genre is only a setting —
 *  what makes a short piece land is the turn inside it, so one of these is
 *  drawn at random for every part instead of leaving the shape to chance. */
const STORY_BEATS = [
  'someone tells a small lie, and it snowballs',
  'the reader learns something one of the characters does not know',
  'a stranger turns up who already knows the main character’s name',
  'there is a deadline, and it is closer than anyone thought',
  'someone makes a promise they cannot keep',
  'something precious goes missing, and suspicion lands on the wrong person',
  'a conversation is overheard and only half understood',
  'a favour turns out to cost far more than expected',
  'someone comes back who was supposed to be gone for good',
  'a tiny mistake has a consequence out of all proportion',
  'two characters want the same thing and only one can have it',
  'a secret is hiding in plain sight, mentioned early and ignored',
  'an offer arrives that is too good to be honest',
  'a message reaches the wrong person',
  'someone recognises a face they were not supposed to see',
  'a character is caught somewhere they should not be',
  'the plan works, and that is exactly the problem',
]

/** Draw a beat, avoiding ones this thread has already played. */
export function pickBeat(used: string[] = []): string {
  const fresh = STORY_BEATS.filter((b) => !used.includes(b))
  const pool = fresh.length > 0 ? fresh : STORY_BEATS
  return pool[Math.floor(Math.random() * pool.length)]
}

/** How a part ends. 'hook' leaves everything open; 'payoff' closes one running
 *  question before opening another. */
export type StoryEnding = 'hook' | 'payoff'

/** Every part ending on a cliffhanger teaches the reader that nothing will ever
 *  be answered, and the hooks stop counting for anything. So every third part of
 *  a thread pays one thread off — provided there are at least two open, since
 *  closing the only one would end the story. */
export function pickEnding(opts: { partsSoFar: number; openThreads: number }): StoryEnding {
  const { partsSoFar, openThreads } = opts
  if (partsSoFar < 2 || openThreads < 2) return 'hook'
  return (partsSoFar + 1) % 3 === 0 ? 'payoff' : 'hook'
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

const EXTEND_SCHEMA = {
  type: 'OBJECT',
  properties: {
    story: { type: 'STRING' },
    translation: { type: 'STRING' },
    characterNames: STORY_SCHEMA.properties.characterNames,
    bible: STORY_SCHEMA.properties.bible,
  },
  required: ['story', 'translation', 'bible'],
}

/** Gloss a finished story: every word of it, in the surface form it appears
 *  in, so a reader can tap anything. Split out of the writing call — annotating
 *  a text that already exists is a different, easier job than predicting the
 *  glossary of a text being written, and it leaves the writing call free to
 *  spend its whole output on prose. */
async function glossaryFor(opts: {
  deck: Deck
  story: StoryProse
  bankWords: string[]
}): Promise<GlossaryEntry[]> {
  const { deck, story, bankWords } = opts
  const prompt = [
    `Below is a finished story in ${deck.language}, written for a language learner who reads it by tapping words for their meanings. Build the lookup glossary for it.`,
    `Story:\n${story.story}`,
    `List EVERY distinct word that appears in the text above — content words AND function words (pronouns, prepositions, particles, connectives, numbers, everything), including character names. Use the exact surface form used in the text (keep inflected, conjugated and affixed forms as they appear; do not reduce them to dictionary form). Give each a concise English meaning matching the sense it carries in that sentence, not its most common sense in isolation.`,
    `The reader must be able to look up any single word of the story and find it here. Do not skip words that seem obvious, and do not add words that do not appear in the text.`,
    bankWords.length > 0
      ? `The learner's word bank: ${bankWords.join(', ')}. Set isNew=true only for content words (nouns, verbs, adjectives, adverbs) outside this bank. Function words are never isNew, and neither are personal names${story.characterNames?.length ? ` (${story.characterNames.join(', ')})` : ''}.`
      : `Set isNew=true only for content words (nouns, verbs, adjectives, adverbs); function words and personal names are never isNew.`,
    ROMAN_RULE(deck.language, 'every glossary entry'),
  ]
    .filter(Boolean)
    .join('\n')

  const parsed = await callGeminiJson<{ glossary: GlossaryEntry[] }>(prompt, GLOSSARY_SCHEMA)
  return parsed.glossary ?? []
}

/** Grow a story that came back short: hand the draft back and ask for the
 *  missing stretch, then splice it on. The continuation carries its own
 *  ending, so the bible from this pass replaces the earlier one. */
async function extendStory(opts: {
  deck: Deck
  story: StoryProse
  missingWords: number
  newWordPercent: number
  /** The ending the part was planned for — the continuation becomes the new
   *  ending, so it has to land the same way. */
  ending: StoryEnding
}): Promise<StoryProse> {
  const { deck, story, missingWords, newWordPercent, ending } = opts
  const prompt = [
    `Below is a story in ${deck.language} written for a language learner. It stopped too early — it needs about ${missingWords} more words.`,
    `Story so far, titled "${story.title}":\n${story.story}`,
    `Write ONLY the continuation: the text that follows on directly from the last line, in the same voice, tense and register, with the same characters. Do not repeat, recap or rewrite any of the above, and do not start a new story.`,
    lengthSpec(missingWords),
    `The continuation must carry the story forward with real events — a new turn, a complication, an arrival — not filler description or small talk stretched out.`,
    // This is a top-up of one part, not a new part: length is the only thing
    // missing, so it has no licence to grow the cast.
    `Do NOT introduce any new named character. Work with the people already in the story above.`,
    `IMPORTANT — register: casual, everyday spoken ${deck.language}, matching the story above. Keep dialogue inside quotation marks “…”.`,
    `At most ${newWordPercent}% of the content words may be new words the learner has not met; prefer the vocabulary already used above.`,
    ending === 'payoff'
      ? `ENDING — the continuation must answer ONE of the questions the story has been carrying, shown as a scene rather than explained, and then raise a new one in its last line. Never wrap the story up.`
      : `ENDING — the continuation must end on a hook, unresolved: an interruption, a reveal, an arrival, or a question the reader cannot answer. Never wrap the story up.`,
    `Return: "story" (the continuation text only), "translation" (an English translation of the continuation only), "characterNames" (any personal names appearing in the continuation), and "bible" (the world state after the continuation: logline, cast, places, facts, openThreads).`,
  ].join('\n')

  const more = await callGeminiJson<Omit<StoryProse, 'title'>>(prompt, EXTEND_SCHEMA)
  return {
    ...story,
    story: `${story.story.trimEnd()}\n\n${more.story.trim()}`,
    translation: `${story.translation.trimEnd()}\n\n${more.translation.trim()}`,
    characterNames: [
      ...new Set([...(story.characterNames ?? []), ...(more.characterNames ?? [])]),
    ],
    bible: more.bible ?? story.bible,
  }
}

/** The plot, decided before a word of the story is written. */
export interface StoryPlan {
  /** The situation, in one English sentence. */
  premise: string
  cast: { name: string; role: string; wants: string }[]
  /** The ordinary-looking detail that carries the turn, planted early. */
  plant: string
  /** What happens, in order — the events the prose has to render. */
  spine: string[]
  /** The final image, and what it leaves the reader wanting. */
  ending: string
}

const PLAN_SCHEMA = {
  type: 'OBJECT',
  properties: {
    premise: { type: 'STRING' },
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
    plant: { type: 'STRING' },
    spine: { type: 'ARRAY', items: { type: 'STRING' } },
    ending: { type: 'STRING' },
  },
  required: ['premise', 'cast', 'plant', 'spine', 'ending'],
}

/** Plot the story before writing it. Two things make this worth a separate
 *  round-trip. A model composing under this many constraints at once — a word
 *  bank, a cast cap, a register, a length, a dialogue ratio — has nothing left
 *  over for plot, and spends it on satisfying the constraints instead. And a
 *  planted twist requires knowing the ending before writing the first line,
 *  which a single forward pass cannot do.
 *
 *  The plan is made in ENGLISH and deliberately ignores the learner's
 *  vocabulary: the word bank is a ceiling on what the story can SAY, and left
 *  in place at this stage it silently becomes a ceiling on what can HAPPEN.
 *  Invent freely here; the writing pass renders it under constraint. */
async function planStory(opts: {
  deck: Deck
  lengthWords: number
  topic?: string
  avoidThemes: string[]
  beat?: string
  ending: StoryEnding
  continueFrom?: { title: string; story: string; direction?: string; bible?: StoryBible }
}): Promise<StoryPlan> {
  const { deck, lengthWords, topic, avoidThemes, beat, ending, continueFrom } = opts
  const bible = continueFrom?.bible
  // Enough beats to fill the length with events rather than with padding.
  const beats = Math.max(4, Math.min(7, Math.round(lengthWords / 150)))

  const prompt = [
    `Plan a short story that will afterwards be written in ${deck.language} for a language learner. PLAN ONLY — do not write any prose.`,
    `Plan in English, and plan freely: this stage is NOT limited by the learner's vocabulary. Decide what would make the best story; rendering it in simple ${deck.language} is a later problem.`,
    continueFrom
      ? `This is the NEXT PART of a story already under way. Plan what happens next — do not re-plan what already happened.`
      : '',
    continueFrom ? `Previous part, titled "${continueFrom.title}":\n${continueFrom.story}` : '',
    bible
      ? [
          `THE WORLD SO FAR — all of it is already true and must not be contradicted.`,
          `Cast: ${bible.cast.map((c) => `${c.name} (${c.role}; wants ${c.wants})`).join('; ')}`,
          bible.places.length > 0 ? `Places: ${bible.places.join('; ')}` : '',
          bible.facts.length > 0 ? `Established facts: ${bible.facts.join('; ')}` : '',
          bible.openThreads.length > 0
            ? `Unanswered questions: ${bible.openThreads.join('; ')}`
            : '',
        ]
          .filter(Boolean)
          .join('\n')
      : '',
    continueFrom?.direction?.trim()
      ? `THE READER CHOSE THIS — the plan must follow it, and it must start happening in the first beat, not the last: "${continueFrom.direction.trim()}"`
      : '',
    beat
      ? `THE TURN — build the plot around exactly this: ${beat}. Do NOT take the first, most obvious instantiation of it that comes to mind; find the version with a specific situation and a specific reason behind it. The turn must be something the reader works out, never something the story announces.`
      : '',
    continueFrom
      ? ''
      : topic?.trim()
        ? `Topic: "${topic.trim()}".`
        : `Invent a fresh premise: an unexpected combination of setting, characters and situation. Vary widely across genres — a mystery, a trip gone wrong, an animal's point of view, a storm, a market, a game, a misunderstanding, a small adventure. Do NOT default to everyday hangout scenes.`,
    !continueFrom && avoidThemes.length > 0
      ? `The learner's previous stories were about the following — pick a clearly DIFFERENT theme, setting and cast: ${avoidThemes.join('; ')}`
      : '',
    `Return:`,
    `• "premise" — the situation in ONE English sentence.`,
    continueFrom
      ? `• "cast" — the people in this part, carrying forward the names already established above. You may add AT MOST ONE new named character, and only if the plot genuinely needs them.`
      : `• "cast" — at most ${MAX_CAST} named characters, ideally two or three, each with their role and what they want. Give every one a personal name that is natural and common for a native ${deck.language} speaker. A learner reading in a second language cannot hold more names than that.`,
    `• "plant" — the ordinary-looking detail that carries the turn: something mentioned early that looks like scenery and later turns out to matter. Say what it is and where it goes.`,
    `• "spine" — exactly ${beats} beats, in order, each one sentence: what actually HAPPENS. Events, not moods — someone does something, someone finds something out, something arrives. Each beat must change the situation the one before it left behind. No beat may be two characters discussing how they feel.`,
    ending === 'payoff'
      ? `• "ending" — this part answers ONE of the unanswered questions above. Say which one, and describe the final image that shows the answer happening (shown as a scene, never explained in summary). Then say which question is left open, and what NEW question the last line raises.`
      : `• "ending" — the final image, landing on a hook: an interruption, a reveal, an arrival, or a decision whose outcome cannot be guessed. Do NOT resolve the story: nobody goes home, nothing turns out fine, nobody learns a lesson.`,
  ]
    .filter(Boolean)
    .join('\n')

  const plan = await callGeminiJson<StoryPlan>(prompt, PLAN_SCHEMA, { tier: 'pro' })
  return { ...plan, cast: plan.cast ?? [], spine: plan.spine ?? [] }
}

/** How close to the requested length is close enough to stop topping up. */
const LENGTH_TOLERANCE = 0.9
/** Cap on top-up passes — each one is another round-trip. */
const MAX_EXTENSIONS = 2

export async function generateStory(opts: {
  deck: Deck
  knownWords: string[]
  learningWords: string[]
  /** 0–100: share of the story's content vocabulary allowed to be outside the word bank. */
  newWordPercent: number
  topic?: string
  lengthWords: number
  /** Titles/topics of the learner's previous stories — steer clear of their themes. */
  avoidThemes?: string[]
  /** Continue this existing story instead of starting a fresh one. `direction`
   *  is the reader's optional steer for what should happen next, `bible` the
   *  world state the previous part left behind. */
  continueFrom?: { title: string; story: string; direction?: string; bible?: StoryBible }
  /** The dramatic turn to build this part around (see `pickBeat`). */
  beat?: string
  /** Whether this part lands on a hook or pays one thread off (see `pickEnding`). */
  ending?: StoryEnding
  /** Words the learner keeps forgetting — worked into the plot on purpose so
   *  they're met repeatedly, in context, instead of only on a flashcard. */
  focusWords?: string[]
  /** Progress across the passes, so the UI can say what each wait is for:
   *  plotting, writing, extending a short draft, then glossing the text. */
  onProgress?: (info: {
    phase: 'planning' | 'writing' | 'extending' | 'glossary'
    words?: number
    target?: number
    pass?: number
  }) => void
}): Promise<Story> {
  const { deck, knownWords, learningWords, newWordPercent, topic, lengthWords } = opts
  const { avoidThemes = [], continueFrom, beat, focusWords = [], ending = 'hook' } = opts

  const bible = continueFrom?.bible

  // Plot first, in English and unconstrained — then write to the plan.
  opts.onProgress?.({ phase: 'planning' })
  const plan = await planStory({
    deck,
    lengthWords,
    topic,
    avoidThemes,
    beat,
    ending,
    continueFrom,
  })

  opts.onProgress?.({ phase: 'writing' })
  const prompt = [
    continueFrom
      ? `Below is a story in ${deck.language} that a language learner has been reading. Write the NEXT PART of it: continue seamlessly from where it ends, keeping the same characters, setting, tone and register. Advance the plot — don't recap or repeat what already happened.`
      : `Write a story in ${deck.language} for a language learner.`,
    continueFrom ? `Previous part, titled "${continueFrom.title}":\n${continueFrom.story}` : '',
    bible
      ? [
          `STORY BIBLE — the world so far. All of it is already true: don't contradict it, and don't re-introduce these characters as though the reader were meeting them for the first time.`,
          `Cast: ${bible.cast.map((c) => `${c.name} (${c.role}; wants ${c.wants})`).join('; ')}`,
          bible.places.length > 0 ? `Places: ${bible.places.join('; ')}` : '',
          bible.facts.length > 0 ? `Established facts: ${bible.facts.join('; ')}` : '',
          bible.openThreads.length > 0
            ? ending === 'payoff'
              ? `Unanswered questions so far — this part answers ONE of them (the plan says which) and leaves at least one still open: ${bible.openThreads.join('; ')}`
              : `Unanswered questions so far — keep them alive. You may edge closer to one, but do not answer any outright: ${bible.openThreads.join('; ')}`
            : '',
        ]
          .filter(Boolean)
          .join('\n')
      : '',
    // The plot was decided in a separate pass — premise, cast, turn, ending and
    // the reader's steer are all already settled inside it. This call's whole
    // job is to render it as prose the learner can read.
    `THE PLAN — follow it. It was made for this story: do not invent a different premise, a different cast or a different ending.`,
    `Premise: ${plan.premise}`,
    plan.cast.length > 0
      ? `Cast — use exactly these people, with exactly these names, and name nobody else: ${plan.cast.map((c) => `${c.name} (${c.role}; wants ${c.wants})`).join('; ')}`
      : '',
    plan.spine.length > 0
      ? `What happens — work through these beats IN ORDER, giving each roughly equal space, and make sure every one of them actually reaches the page:\n${plan.spine.map((b, i) => `${i + 1}. ${b}`).join('\n')}`
      : '',
    plan.plant
      ? `PLANT: ${plan.plant} Put it in early, inside an ordinary-looking detail, and never draw attention to it — the reader should walk past it and only realise later.`
      : '',
    lengthSpec(lengthWords),
    `IMPORTANT — register: use casual, everyday conversational ${deck.language}, the way people actually talk in daily life. Prefer informal forms over formal ones (for example, in Indonesian say "aku", not "saya"). No formal, literary, or textbook language.`,
    `STYLE — dialogue-first: tell the story mainly through conversation. At least half of the words should be inside spoken lines, as short, natural back-and-forth exchanges between the characters; keep narration to brief connective sentences. Always wrap spoken lines in quotation marks “…” (never dashes), so dialogue is machine-detectable.`,
    `TEXTURE: each scene gets exactly ONE concrete physical detail — a smell, a sound, a texture, a temperature, something someone is holding — in a single short sentence. One per scene, never a descriptive paragraph, and make it specific ("the rice was still too hot to hold") rather than general ("it was a nice day").`,
    // A learner reading in a second language cannot hold a large cast in their
    // head: every extra name is another thing to decode. The plan already caps
    // it; this keeps the writing pass from quietly adding walk-on names.
    `CHARACTERS: refer to the people above by the names the plan gives them — never as "the man", "my friend", "the seller" and so on. Do NOT name anyone the plan does not name: everyone else stays unnamed and off-stage, mentioned in passing at most. Return every personal name used in the story in the characterNames array.`,
    `The learner's word bank is below. Build the story primarily from these words (plus basic function words like articles, pronouns and common connectives, which are always allowed).`,
    knownWords.length > 0
      ? `Known words — use these freely and often: ${knownWords.join(', ')}`
      : '',
    learningWords.length > 0
      ? `Words being learned — weave in as many of these as possible for practice: ${learningWords.join(', ')}`
      : '',
    `At most ${newWordPercent}% of the content words (nouns, verbs, adjectives, adverbs) may be NEW words outside the word bank. ${newWordPercent === 0 ? 'Use no new content words at all.' : 'Prefer common, useful new words at the learner’s level.'}`,
    focusWords.length > 0
      ? `PLOT-CRITICAL VOCABULARY: these are words the learner keeps forgetting — ${focusWords.join(', ')}. Each one must appear at least three times, in different sentences and different situations, and at least one of them must matter to the plot (it names the thing that goes missing, the place they must reach, the thing someone wants). Never draw attention to them or define them in the text; just make the story impossible to follow without them.`
      : '',
    ending === 'payoff'
      ? `ENDING — this part pays something off: ${plan.ending} Show the answer HAPPENING, as a scene the reader watches — never as a character explaining it or a narrator summarising it. Then let the very last line raise a new question. Do not wrap the whole story up: nobody goes home, nothing turns out fine, nobody learns a lesson.`
      : `ENDING — do NOT resolve the story. Land it here: ${plan.ending} The last line must be a hook — an interruption, a reveal, an arrival, an unanswered question, or a decision whose outcome the reader cannot guess. Never end with everyone going home, everything turning out fine, a lesson learned, or a summary of what happened. Stop at the moment of maximum "wait, what?" — mid-scene is good, mid-sentence is not.`,
    `THE BIBLE: also return "bible" — the state of the story world after this part${continueFrom ? ', updated from the bible above (carry forward everything still true, add what this part established, and drop questions this part answered)' : ''}. "logline" is ONE English sentence recapping what happened, written so it can be shown to the reader as "Previously…" before the next part. "cast" lists every named character with their role and what they want; "places" the locations used; "facts" the concrete details a later part must stay consistent with; "openThreads" the questions this part leaves unanswered — including the one your ending hook just raised.`,
    `Return: a short title in ${deck.language}${continueFrom ? ' for this new part' : ''}, the story, a full English translation and the bible. Spend your effort on the story itself — the words will be glossed separately afterwards, so you do not need to define anything here.`,
  ]
    .filter(Boolean)
    .join('\n')

  let prose = await callGeminiJson<StoryProse>(prompt, STORY_SCHEMA, { tier: 'pro' })

  // Models can't count their own words, so a draft routinely lands well under
  // the requested length. Measure it the same way the reader does and, while
  // it's short, ask for the missing stretch and splice it on.
  const langCode = langCodeFor(deck.language)
  for (let pass = 0; pass < MAX_EXTENSIONS; pass++) {
    const have = countWords(prose.story, langCode)
    if (have >= lengthWords * LENGTH_TOLERANCE) break
    opts.onProgress?.({ phase: 'extending', words: have, target: lengthWords, pass: pass + 1 })
    try {
      prose = await extendStory({
        deck,
        story: prose,
        missingWords: Math.max(40, lengthWords - have),
        newWordPercent,
        ending,
      })
    } catch {
      // A failed top-up shouldn't cost the reader the story they already have.
      break
    }
  }

  // Gloss last, once, over the text as it finally stands — so extensions cost
  // nothing extra here and no word of the story goes unglossed.
  opts.onProgress?.({ phase: 'glossary' })
  const glossary = await glossaryFor({
    deck,
    story: prose,
    bankWords: [...knownWords, ...learningWords],
  })
  return { ...prose, glossary }
}

const DEFINE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    meaning: { type: 'STRING' },
    isContentWord: { type: 'BOOLEAN' },
    roman: { type: 'STRING' },
  },
  required: ['meaning', 'isContentWord'],
}

/** Define a single word on demand — fallback for story words the glossary missed. */
export async function defineWord(opts: {
  deck: Deck
  word: string
  /** Sentence the word was tapped in, to pin down the sense used. */
  sentence?: string
}): Promise<{ meaning: string; isContentWord: boolean; roman?: string }> {
  const { deck, word, sentence } = opts
  const prompt = [
    `Give a concise English meaning for the ${deck.language} word "${word}", as a glossary entry for a language learner.`,
    sentence?.trim() ? `It appears in this sentence — define the sense used here: "${sentence.trim()}"` : '',
    `Also report whether it is a content word (noun, verb, adjective or adverb) rather than a function word.`,
    ROMAN_RULE(deck.language, 'the word'),
  ]
    .filter(Boolean)
    .join('\n')
  return callGeminiJson<{ meaning: string; isContentWord: boolean; roman?: string }>(
    prompt,
    DEFINE_SCHEMA,
  )
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
        },
        required: ['word', 'meaning', 'isContentWord'],
      },
    },
  },
  required: ['items'],
}

export interface WordDefinition {
  meaning: string
  isContentWord: boolean
  roman?: string
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
    `Words:`,
    ...words.map((w) => (w.sentence ? `${w.word} — in: "${w.sentence.trim()}"` : w.word)),
  ]
    .filter(Boolean)
    .join('\n')

  const parsed = await callGeminiJson<{
    items: { word: string; meaning: string; isContentWord: boolean; roman?: string }[]
  }>(prompt, DEFINE_MANY_SCHEMA)
  const map = new Map<string, WordDefinition>()
  for (const item of parsed.items ?? []) {
    if (item.word && item.meaning)
      map.set(item.word.trim().toLowerCase(), {
        meaning: item.meaning.trim(),
        isContentWord: !!item.isContentWord,
        roman: item.roman?.trim() || undefined,
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
