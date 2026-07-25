import Dexie, { type EntityTable } from 'dexie'

export interface Deck {
  id: number
  name: string
  language: string
  createdAt: number
}

export type CardState = 'new' | 'learning' | 'review'

export interface Card {
  id: number
  deckId: number
  word: string
  meaning: string
  example: string
  exampleTranslation?: string
  notes?: string
  /** 1–2 emoji used as a visual mnemonic for the word. */
  emoji?: string
  createdAt: number
  /** Marked as known — excluded from study modes. */
  known?: boolean
  // SRS state
  state: CardState
  due: number // timestamp ms
  interval: number // days
  ease: number
  reps: number
  lapses: number
  // FSRS state (present once a card has been graded under the FSRS scheduler)
  stability?: number
  difficulty?: number
  fsrsSteps?: number
  lastReview?: number // timestamp ms
}

/** A once-a-day count of the whole word bank, so growth can be charted over
 *  time (the live tables only hold the current state). Keyed by `day`. */
export interface Snapshot {
  day: number // start-of-day timestamp (ms)
  total: number
  new: number
  learning: number
  review: number
  known: number
}

/** Seconds spent reading stories on a given day. Keyed by `day`. */
export interface ReadingLog {
  day: number // start-of-day timestamp (ms)
  seconds: number
}

export interface Review {
  id: number
  cardId: number
  deckId: number
  grade: 'again' | 'hard' | 'good' | 'easy'
  ts: number
}

export interface SavedStory {
  id: number
  deckId: number
  title: string
  story: string
  translation: string
  glossary: { word: string; meaning: string; isNew: boolean }[]
  topic?: string
  /** Root story this one continues (always the first part's id) — parts are
   *  grouped under that root in the saved-stories list. Unset for standalone
   *  stories and roots. Plain property, not indexed. */
  parentId?: number
  /** Reading marker: index of the word (Nth tappable word in the story) the
   *  reader stopped at. One per story. Plain property, not indexed. */
  bookmark?: number
  createdAt: number
}

export interface BlacklistEntry {
  id: number
  deckId: number
  word: string
  createdAt: number
}

export type Scheduler = 'sm2' | 'fsrs'

export interface AppSettings {
  key: 'app'
  apiKey: string
  reviewFront: 'word' | 'meaning'
  maskExample: boolean
  newPerSession: number
  scheduler: Scheduler
  dailyGoal: number // target reviews per day
  /** Pronounce the word aloud when it appears during study. */
  autoSpeak: boolean
  /** Show the card's emoji mnemonic alongside the word during study. */
  showEmoji: boolean
  /** Let the model "think" before answering AI requests — higher quality,
   *  noticeably slower. Off by default (favours speed). */
  aiThinking: boolean
  /** App colour theme. 'system' follows the OS setting. */
  theme: 'system' | 'light' | 'dark'
  /** Reading text-size multiplier for stories (1 = default). */
  storyFontScale: number
}

export const DEFAULT_SETTINGS: AppSettings = {
  key: 'app',
  apiKey: '',
  reviewFront: 'word',
  maskExample: true,
  newPerSession: 20,
  scheduler: 'sm2',
  dailyGoal: 30,
  autoSpeak: true,
  showEmoji: true,
  aiThinking: false,
  theme: 'system',
  storyFontScale: 1,
}

export const db = new Dexie('flashy') as Dexie & {
  decks: EntityTable<Deck, 'id'>
  cards: EntityTable<Card, 'id'>
  reviews: EntityTable<Review, 'id'>
  blacklist: EntityTable<BlacklistEntry, 'id'>
  settings: EntityTable<AppSettings, 'key'>
  stories: EntityTable<SavedStory, 'id'>
  snapshots: EntityTable<Snapshot, 'day'>
  reading: EntityTable<ReadingLog, 'day'>
}

db.version(1).stores({
  decks: '++id, name',
  cards: '++id, deckId, due, [deckId+due], word',
})

db.version(2).stores({
  decks: '++id, name',
  cards: '++id, deckId, due, [deckId+due], word',
  reviews: '++id, cardId, deckId, ts',
  blacklist: '++id, deckId, word',
  settings: 'key',
})

db.version(3).stores({
  decks: '++id, name',
  cards: '++id, deckId, due, [deckId+due], word',
  reviews: '++id, cardId, deckId, ts',
  blacklist: '++id, deckId, word',
  settings: 'key',
  stories: '++id, deckId, createdAt',
})

db.version(4).stores({
  decks: '++id, name',
  cards: '++id, deckId, due, [deckId+due], word',
  reviews: '++id, cardId, deckId, ts',
  blacklist: '++id, deckId, word',
  settings: 'key',
  stories: '++id, deckId, createdAt',
  snapshots: 'day',
  reading: 'day',
})

/** Record (or refresh) today's word-bank snapshot. Idempotent — one row per
 *  day, overwritten with the latest counts each time it runs. */
export async function recordDailySnapshot(): Promise<void> {
  const cards = await db.cards.toArray()
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  await db.snapshots.put({
    day: d.getTime(),
    total: cards.length,
    new: cards.filter((c) => !c.known && c.state === 'new').length,
    learning: cards.filter((c) => !c.known && c.state === 'learning').length,
    review: cards.filter((c) => !c.known && c.state === 'review').length,
    known: cards.filter((c) => c.known).length,
  })
}

export function newCardDefaults(): Pick<
  Card,
  'state' | 'due' | 'interval' | 'ease' | 'reps' | 'lapses' | 'createdAt'
> {
  return {
    state: 'new',
    due: Date.now(),
    interval: 0,
    ease: 2.5,
    reps: 0,
    lapses: 0,
    createdAt: Date.now(),
  }
}
