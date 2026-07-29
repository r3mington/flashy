import { db, type Deck, type StoryBible, type StoryChoice } from './db'
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
    glossary: STORY_SCHEMA.properties.glossary,
    characterNames: STORY_SCHEMA.properties.characterNames,
    choices: STORY_SCHEMA.properties.choices,
    bible: STORY_SCHEMA.properties.bible,
  },
  required: ['story', 'translation', 'glossary', 'choices', 'bible'],
}

/** Merge glossaries, keeping the first meaning given for a word. */
function mergeGlossary(a: GlossaryEntry[], b: GlossaryEntry[]): GlossaryEntry[] {
  const seen = new Set(a.map((e) => e.word.trim().toLowerCase()))
  return [...a, ...b.filter((e) => !seen.has(e.word.trim().toLowerCase()))]
}

/** Grow a story that came back short: hand the draft back and ask for the
 *  missing stretch, then splice it on. The continuation carries its own
 *  ending, so the choices and bible from this pass replace the earlier ones. */
async function extendStory(opts: {
  deck: Deck
  story: Story
  missingWords: number
  newWordPercent: number
}): Promise<Story> {
  const { deck, story, missingWords, newWordPercent } = opts
  const prompt = [
    `Below is a story in ${deck.language} written for a language learner. It stopped too early — it needs about ${missingWords} more words.`,
    `Story so far, titled "${story.title}":\n${story.story}`,
    `Write ONLY the continuation: the text that follows on directly from the last line, in the same voice, tense and register, with the same characters. Do not repeat, recap or rewrite any of the above, and do not start a new story.`,
    lengthSpec(missingWords),
    `The continuation must carry the story forward with real events — a new turn, a complication, an arrival — not filler description or small talk stretched out.`,
    `IMPORTANT — register: casual, everyday spoken ${deck.language}, matching the story above. Keep dialogue inside quotation marks “…”.`,
    `At most ${newWordPercent}% of the content words may be new words the learner has not met; prefer the vocabulary already used above.`,
    `ENDING — the continuation must end on a hook, unresolved: an interruption, a reveal, an arrival, or a question the reader cannot answer. Never wrap the story up.`,
    `Return: "story" (the continuation text only), "translation" (an English translation of the continuation only), "glossary" (every distinct word used in the continuation, in the surface form it appears in, with a concise English meaning; isNew=true only for content words outside the learner's bank; names are never isNew), "characterNames" (any personal names appearing in the continuation), "choices" (exactly TWO short phrases in ${deck.language}, 3–8 words each, with English translations, for how the story could go next from this new ending), and "bible" (the world state after the continuation: logline, cast, places, facts, openThreads).`,
    ROMAN_RULE(deck.language, 'every glossary entry'),
  ].join('\n')

  const more = await callGeminiJson<Omit<Story, 'title'>>(prompt, EXTEND_SCHEMA)
  return {
    ...story,
    story: `${story.story.trimEnd()}\n\n${more.story.trim()}`,
    translation: `${story.translation.trimEnd()}\n\n${more.translation.trim()}`,
    glossary: mergeGlossary(story.glossary, more.glossary ?? []),
    characterNames: [
      ...new Set([...(story.characterNames ?? []), ...(more.characterNames ?? [])]),
    ],
    choices: more.choices ?? story.choices,
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
  /** Called when the draft came back short and is being extended, so the UI
   *  can say what the extra wait is for. */
  onProgress?: (info: { words: number; target: number; pass: number }) => void
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
    lengthSpec(lengthWords),
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

  let story = await callGeminiJson<Story>(prompt, STORY_SCHEMA)

  // Models can't count their own words, so a draft routinely lands well under
  // the requested length. Measure it the same way the reader does and, while
  // it's short, ask for the missing stretch and splice it on.
  const langCode = langCodeFor(deck.language)
  for (let pass = 0; pass < MAX_EXTENSIONS; pass++) {
    const have = countWords(story.story, langCode)
    if (have >= lengthWords * LENGTH_TOLERANCE) break
    opts.onProgress?.({ words: have, target: lengthWords, pass: pass + 1 })
    try {
      story = await extendStory({
        deck,
        story,
        missingWords: Math.max(40, lengthWords - have),
        newWordPercent,
      })
    } catch {
      // A failed top-up shouldn't cost the reader the story they already have.
      break
    }
  }
  return story
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
