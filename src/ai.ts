import { db, type Deck } from './db'

export interface Suggestion {
  word: string
  meaning: string
  example: string
  exampleTranslation: string
  emoji?: string
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
}

export interface Story {
  title: string
  story: string
  translation: string
  glossary: GlossaryEntry[]
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
        },
        required: ['word', 'meaning', 'isNew'],
      },
    },
  },
  required: ['title', 'story', 'translation', 'glossary'],
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
  /** Continue this existing story instead of starting a fresh one. */
  continueFrom?: { title: string; story: string }
}): Promise<Story> {
  const { deck, knownWords, learningWords, newWordPercent, topic, lengthWords } = opts
  const { avoidThemes = [], continueFrom } = opts

  const prompt = [
    continueFrom
      ? `Below is a story in ${deck.language} that a language learner has been reading. Write the NEXT PART of it: continue seamlessly from where it ends, keeping the same characters, setting, tone and register. Advance the plot — don't recap or repeat what already happened.`
      : `Write a story in ${deck.language} for a language learner.`,
    continueFrom ? `Previous part, titled "${continueFrom.title}":\n${continueFrom.story}` : '',
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
    `The learner's word bank is below. Build the story primarily from these words (plus basic function words like articles, pronouns and common connectives, which are always allowed).`,
    knownWords.length > 0
      ? `Known words — use these freely and often: ${knownWords.join(', ')}`
      : '',
    learningWords.length > 0
      ? `Words being learned — weave in as many of these as possible for practice: ${learningWords.join(', ')}`
      : '',
    `At most ${newWordPercent}% of the content words (nouns, verbs, adjectives, adverbs) may be NEW words outside the word bank. ${newWordPercent === 0 ? 'Use no new content words at all.' : 'Prefer common, useful new words at the learner’s level.'}`,
    `Return: a short title in ${deck.language}${continueFrom ? ' for this new part' : ''}, the story, a full English translation, and a glossary.`,
    `The glossary must list EVERY distinct word that appears in the story — content words AND function words (pronouns, prepositions, particles, connectives, numbers, everything). List each word in the exact surface form used in the story (including inflected/conjugated forms), with a concise English meaning matching how it is used there. A reader must be able to look up any single word of the story in this glossary. Set isNew=true only for content words outside the word bank.`,
  ]
    .filter(Boolean)
    .join('\n')

  return callGeminiJson<Story>(prompt, STORY_SCHEMA)
}

export class ApiError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}
