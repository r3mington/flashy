import { db, type Deck, type StoryBible, type StoryChoice } from './db'

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

/** All AI calls go through our /api/generate proxy — the Gemini key lives server-side. */
async function callGeminiJson<T>(prompt: string, schema: object): Promise<T> {
  const thinking = await thinkingEnabled()
  let res: Response
  try {
    res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, schema, thinking }),
    })
  } catch {
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
  choices: StoryChoice[]
  bible: StoryBible
}

const STORY_SCHEMA = {
  type: 'OBJECT',
  properties: {
    title: { type: 'STRING' },
    story: { type: 'STRING' },
    translation: { type: 'STRING' },
    glossary: {
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
    },
    characterNames: { type: 'ARRAY', items: { type: 'STRING' } },
    choices: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          text: { type: 'STRING' },
          translation: { type: 'STRING' },
        },
        required: ['text', 'translation'],
      },
    },
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
  required: [
    'title',
    'story',
    'translation',
    'glossary',
    'characterNames',
    'choices',
    'bible',
  ],
}

/** Dramatic turns a story can be built around. A genre is only a setting —
 *  what makes a short piece land is the turn inside it, so one of these is
 *  drawn at random for every part instead of leaving the shape to chance. */
export const STORY_BEATS = [
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
  /** Words the learner keeps forgetting — worked into the plot on purpose so
   *  they're met repeatedly, in context, instead of only on a flashcard. */
  focusWords?: string[]
}): Promise<Story> {
  const { deck, knownWords, learningWords, newWordPercent, topic, lengthWords } = opts
  const { avoidThemes = [], continueFrom, beat, focusWords = [] } = opts

  const bible = continueFrom?.bible
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
            ? `Unanswered questions so far — answer ONE of these in this part, and leave at least one still open: ${bible.openThreads.join('; ')}`
            : '',
        ]
          .filter(Boolean)
          .join('\n')
      : '',
    continueFrom?.direction?.trim()
      ? `THE READER CHOSE THIS — the next part must follow it, and it must start happening within the first few lines, not at the end: "${continueFrom.direction.trim()}"`
      : '',
    beat
      ? `THE TURN — build this part around exactly this dramatic turn: ${beat}. Plant it early inside an ordinary-looking detail, then let it land. Never announce or explain the turn; let the reader notice it.`
      : '',
    continueFrom
      ? ''
      : topic?.trim()
        ? `Topic: "${topic.trim()}".`
        : `Invent a FRESH premise. Before writing, pick an unexpected combination of setting, characters and situation — vary widely across genres (a mystery, a trip gone wrong, an animal's point of view, a storm, a market, a game, a misunderstanding, a small adventure…). Do NOT default to everyday hangout scenes.`,
    !continueFrom && avoidThemes.length > 0
      ? `The learner's previous stories were about the following — choose a clearly DIFFERENT theme, setting and cast: ${avoidThemes.join('; ')}`
      : '',
    `LENGTH — important: the story must be AT LEAST ${lengthWords} words long (aim for ${lengthWords}–${Math.round(lengthWords * 1.15)} words). Count words before answering; if the draft is short, extend the plot until it reaches the target.`,
    `IMPORTANT — register: use casual, everyday conversational ${deck.language}, the way people actually talk in daily life. Prefer informal forms over formal ones (for example, in Indonesian say "aku", not "saya"). No formal, literary, or textbook language.`,
    `STYLE — dialogue-first: tell the story mainly through conversation. At least half of the words should be inside spoken lines, as short, natural back-and-forth exchanges between the characters; keep narration to brief connective sentences. Always wrap spoken lines in quotation marks “…” (never dashes), so dialogue is machine-detectable.`,
    `TEXTURE: each scene gets exactly ONE concrete physical detail — a smell, a sound, a texture, a temperature, something someone is holding — in a single short sentence. One per scene, never a descriptive paragraph, and make it specific ("the rice was still too hot to hold") rather than general ("it was a nice day").`,
    `CHARACTERS: give every character a personal name that is natural and common for a native ${deck.language} speaker — never refer to anyone only as "the man", "my friend", "the seller" and so on.${continueFrom ? ' Keep the names already used in the previous part.' : ''} Return every personal name used in the story in the characterNames array.`,
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
    `ENDING — do NOT resolve the story. The last line must land on a hook: an interruption, a reveal, an arrival, an unanswered question, or a decision whose outcome the reader cannot guess. Never end with everyone going home, everything turning out fine, a lesson learned, or a summary of what happened. Stop at the moment of maximum "wait, what?" — mid-scene is good, mid-sentence is not.`,
    `THE CHOICE: after the story, offer the reader exactly TWO ways it could go next, as the "choices" array. Each choice is one short phrase (3–8 words) in ${deck.language}, written in the same casual register as the story, plus its English translation. The two must lead somewhere genuinely different, both must be plausible from where the story stopped, and neither may be the obviously "correct" or safe one. Write them as things that could happen next ("follow him to the market", "open the letter instead"), not as questions.`,
    `THE BIBLE: also return "bible" — the state of the story world after this part${continueFrom ? ', updated from the bible above (carry forward everything still true, add what this part established, and drop questions this part answered)' : ''}. "logline" is ONE English sentence recapping what happened, written so it can be shown to the reader as "Previously…" before the next part. "cast" lists every named character with their role and what they want; "places" the locations used; "facts" the concrete details a later part must stay consistent with; "openThreads" the questions this part leaves unanswered — including the one your ending hook just raised.`,
    `Return: a short title in ${deck.language}${continueFrom ? ' for this new part' : ''}, the story, a full English translation, a glossary, the two choices and the bible.`,
    `The glossary must list EVERY distinct word that appears in the story — content words AND function words (pronouns, prepositions, particles, connectives, numbers, everything), including character names. List each word in the exact surface form used in the story (including inflected/conjugated forms), with a concise English meaning matching how it is used there. A reader must be able to look up any single word of the story in this glossary. It must cover the words used in the two choices too. Set isNew=true only for content words outside the word bank; names are never isNew.`,
    ROMAN_RULE(deck.language, 'every glossary entry'),
  ]
    .filter(Boolean)
    .join('\n')

  return callGeminiJson<Story>(prompt, STORY_SCHEMA)
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

export class ApiError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}
