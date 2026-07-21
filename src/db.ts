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
}

export const db = new Dexie('flashy') as Dexie & {
  decks: EntityTable<Deck, 'id'>
  cards: EntityTable<Card, 'id'>
  reviews: EntityTable<Review, 'id'>
  blacklist: EntityTable<BlacklistEntry, 'id'>
  settings: EntityTable<AppSettings, 'key'>
  stories: EntityTable<SavedStory, 'id'>
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
