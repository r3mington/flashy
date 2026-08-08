import Dexie, { type EntityTable } from 'dexie'
import { startOfToday } from './time'

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
  /** Romanization for non-Latin scripts (Thai RTGS, pinyin, romaji…). */
  roman?: string
  createdAt: number
  /** Marked as known — excluded from study modes. */
  known?: boolean
  /** Marked as ignored — a word that shows up in stories but isn't vocabulary
   *  (brand names, place names, loanwords). It sits in the deck only so stories
   *  stop flagging it as new: out of study, and counted as neither known nor
   *  learning anywhere in the stats. Mutually exclusive with `known`. */
  ignored?: boolean
  /** How many times this word was tapped for its definition while reading a
   *  story — a "struggle" signal for sorting the deck. Plain, non-indexed. */
  lookups?: number
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

/** Time and volume of story reading on a given day. Keyed by `day`. */
export interface ReadingLog {
  day: number // start-of-day timestamp (ms)
  seconds: number
  /** Story words scrolled through. Counted once per story (see
   *  `SavedStory.wordsRead`), so re-reading doesn't inflate it. Absent on rows
   *  logged before this was tracked. */
  words?: number
}

/** Seconds spent in the Listen player on a given day. Keyed by `day`. */
export interface ListeningLog {
  day: number // start-of-day timestamp (ms)
  seconds: number
}

export interface Review {
  id: number
  cardId: number
  deckId: number
  grade: 'again' | 'hard' | 'good' | 'easy'
  ts: number
  /** The card's state and interval *before* this answer. Recorded so true
   *  retention (pass rate on already-learned cards) can be measured; absent
   *  on rows logged before this was tracked. Plain, non-indexed. */
  state?: CardState
  interval?: number
}

/** What the story world knows about itself: carried from part to part so a
 *  thread keeps its cast, its places and its unresolved questions straight
 *  instead of drifting. Written by the model with each part. */
export interface StoryBible {
  /** One-sentence English recap, shown as "Previously…" on the next part. */
  logline: string
  cast: { name: string; role: string; wants: string }[]
  places: string[]
  /** Established details the next part must not contradict. */
  facts: string[]
  /** Questions the story has raised and not yet answered. */
  openThreads: string[]
}

export interface SavedStory {
  id: number
  deckId: number
  title: string
  story: string
  translation: string
  glossary: { word: string; meaning: string; isNew: boolean; roman?: string }[]
  /** World state after this part — fed back when continuing. Plain. */
  bible?: StoryBible
  /** The dramatic turn this part was built around. Kept so a thread doesn't
   *  reuse a turn it has already played. Plain, not indexed. */
  beat?: string
  /** Words the learner keeps forgetting that were seeded into this part. */
  focusWords?: string[]
  /** What the reader asked to happen next in this part, if they steered it.
   *  Plain, not indexed. */
  chosen?: string
  /** Personal names of the story's characters — rendered in their own colour
   *  and excluded from new-word highlighting/chips. */
  characterNames?: string[]
  topic?: string
  /** Root story this one continues (always the first part's id) — parts are
   *  grouped under that root in the saved-stories list. Unset for standalone
   *  stories and roots. Plain property, not indexed. */
  parentId?: number
  /** Reading marker: index of the word (Nth tappable word in the story) the
   *  reader stopped at. One per story. Plain property, not indexed. */
  bookmark?: number
  /** When the story was last opened for reading — drives the homepage
   *  "continue reading" shortcut. Plain property, not indexed. */
  lastOpenedAt?: number
  /** When the reader declared themselves done with this part. A finished story
   *  drops out of "continue reading" — otherwise the shortcut keeps offering
   *  back the thing you just closed. Plain property, not indexed. */
  finishedAt?: number
  /** High-water mark of how many words of this story have been scrolled
   *  through. Only growth past this counts towards the daily words-read
   *  total, so re-reading an old story doesn't count twice. */
  wordsRead?: number
  createdAt: number
}

/** One speaker turn of a translation dialogue. The learner sees `speaker` and
 *  `english` and writes the target line themselves; `target` is the reference
 *  rendering, kept hidden until they ask for it. */
export interface DialogueTurn {
  speaker: string
  /** The English prompt to translate. May carry square-bracket notes where
   *  English underdetermines the target ("we [you and me]"). */
  english: string
  /** One acceptable rendering in the target language — a reference, not the
   *  only right answer. */
  target: string
  /** English span → target word, from the alignment pass. `root` is the
   *  dictionary form the target word is built on (Indonesian strips its
   *  affixes: membeli → beli), which is what the half reveal shows. */
  hints: { en: string; target: string; root: string }[]
}

export interface LineGrade {
  verdict: 'right' | 'close' | 'missed' | 'skipped'
  /** What was wrong, or what was notable about a right answer. */
  note: string
  /** The learner's line, repaired — absent when nothing needed fixing. */
  corrected?: string
}

export interface TranslationGrade {
  /** Index-aligned with the session's turns. */
  lines: LineGrade[]
  overall: string
  /** The single habit worth working on next. */
  pattern?: string
}

/** How much help a learner took on one aligned word: sealed, the root's first
 *  letters, or the whole target word. */
export type Reveal = 0 | 1 | 2

export interface TranslationSession {
  id: number
  deckId: number
  title: string
  /** One English line fixing the place and who is talking. Never translated —
   *  without it half the turns would have a dozen valid renderings. */
  scene: string
  /** Grammar ceiling the dialogue was written to (1 simplest, 3 loosest). */
  level: 1 | 2 | 3
  turns: DialogueTurn[]
  /** Learner answers, index-aligned with `turns`. */
  answers: string[]
  /** Reveal state per turn, index-aligned with that turn's `hints`. */
  reveals: Reveal[][]
  /** Turns where the learner asked for the whole reference line BEFORE
   *  answering. Fed to the grader as help taken — kept strictly separate from
   *  `checked`, which every line ends up in and means nothing about effort. */
  shown: boolean[]
  /** Turns the learner has committed and compared against the reference. Their
   *  answer is locked from here on: having seen the reference, an edit would be
   *  copying rather than recall. Absent on sessions from before compare existed. */
  checked?: boolean[]
  /** Turn the learner stopped at, so a half-finished dialogue resumes. */
  at: number
  /** Deck words the dialogue actually used — coverage as fact, not hope. */
  bankWords?: string[]
  grade?: TranslationGrade
  topic?: string
  createdAt: number
  completedAt?: number
}

export interface BlacklistEntry {
  id: number
  deckId: number
  word: string
  createdAt: number
}

export type Scheduler = 'sm2' | 'fsrs'

/** The palette story word colours are picked from. Names, not hex codes — each
 *  one resolves to a `--hue-*` CSS variable carrying its own light and dark
 *  value, so a choice made in daylight still reads at night. 'plain' is the
 *  body text colour: the way to say "don't colour this kind of word at all". */
export const STORY_HUES = [
  'plain',
  'amber',
  'green',
  'teal',
  'blue',
  'violet',
  'pink',
  'red',
] as const
export type StoryHue = (typeof STORY_HUES)[number]

/** What each kind of word in a story is coloured. The four kinds are the only
 *  distinctions the reader can act on: a word is outside your bank, inside it
 *  and still being studied, a character's name, or finished with. */
export interface StoryColors {
  /** Not in your word bank at all. Also the only kind to get a background wash. */
  new: StoryHue
  /** In the bank and still in the study rotation. */
  study: StoryHue
  /** A character's personal name — not vocabulary. */
  name: StoryHue
  /** Marked known or ignored: nothing left to do with it. */
  known: StoryHue
}

export const DEFAULT_STORY_COLORS: StoryColors = {
  new: 'amber',
  study: 'green',
  name: 'violet',
  known: 'plain',
}

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
  /** Ruby romanization above story words (non-Latin scripts): none, only
   *  new/highlighted words, or every word. */
  storyRoman: 'off' | 'new' | 'all'
  /** Whether the reader's control bar is expanded (it collapses to a slim
   *  play + progress strip so the story gets the screen). */
  storyControlsOpen: boolean
  /** Colour per kind of word in a story. */
  storyColors: StoryColors
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
  storyRoman: 'new',
  storyControlsOpen: true,
  storyColors: DEFAULT_STORY_COLORS,
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
  listening: EntityTable<ListeningLog, 'day'>
  translations: EntityTable<TranslationSession, 'id'>
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

db.version(5).stores({
  decks: '++id, name',
  cards: '++id, deckId, due, [deckId+due], word',
  reviews: '++id, cardId, deckId, ts',
  blacklist: '++id, deckId, word',
  settings: 'key',
  stories: '++id, deckId, createdAt',
  snapshots: 'day',
  reading: 'day',
  listening: 'day',
})

db.version(6).stores({
  decks: '++id, name',
  cards: '++id, deckId, due, [deckId+due], word',
  reviews: '++id, cardId, deckId, ts',
  blacklist: '++id, deckId, word',
  settings: 'key',
  stories: '++id, deckId, createdAt',
  snapshots: 'day',
  reading: 'day',
  listening: 'day',
  translations: '++id, deckId, createdAt',
})

/** Update a day's reading log without clobbering the field the other writer
 *  owns — the timer sets `seconds` outright, the scroll tracker adds words. */
export function bumpReading(
  day: number,
  patch: { seconds?: number; addWords?: number },
): Promise<void> {
  return db.transaction('rw', db.reading, async () => {
    const row = await db.reading.get(day)
    await db.reading.put({
      day,
      seconds: patch.seconds ?? row?.seconds ?? 0,
      words: (row?.words ?? 0) + (patch.addWords ?? 0),
    })
  })
}

/** Record (or refresh) today's word-bank snapshot. Idempotent — one row per
 *  day, overwritten with the latest counts each time it runs. */
export async function recordDailySnapshot(): Promise<void> {
  // Ignored words aren't vocabulary — they never enter the bank counts.
  const cards = (await db.cards.toArray()).filter((c) => !c.ignored)
  await db.snapshots.put({
    day: startOfToday(),
    total: cards.length,
    new: cards.filter((c) => inRotation(c) && c.state === 'new').length,
    learning: cards.filter((c) => inRotation(c) && c.state === 'learning').length,
    review: cards.filter((c) => inRotation(c) && c.state === 'review').length,
    known: cards.filter((c) => c.known).length,
  })
}

/** Cards that take part in study: neither marked known nor ignored. Everything
 *  that counts due cards, new cards or learning states goes through this. */
export function inRotation(c: Card): boolean {
  return !c.known && !c.ignored
}

/** Where a word sits, from the learner's point of view — the one vocabulary of
 *  status shared by the deck list, the story reader and the export filters.
 *  'inStudy' is every card the scheduler is driving, whatever SRS state it
 *  happens to be in: new, learning and review are the scheduler's business,
 *  not a label the reader has to choose between. */
export type WordStatus = 'inStudy' | 'known' | 'ignored'

export function statusOf(c: Card): WordStatus {
  if (c.ignored) return 'ignored'
  if (c.known) return 'known'
  return 'inStudy'
}

/** The fields that move a card to `status`. The two out-of-study flags are
 *  always written together, so a card can never end up as both. The scheduler
 *  state is never touched: the way out of a state is to answer the card. */
export function statusPatch(status: WordStatus): Partial<Card> {
  return { known: status === 'known', ignored: status === 'ignored' }
}

/** Move cards between statuses. The one writer for the whole app. */
export async function setCardStatus(ids: number[], status: WordStatus): Promise<void> {
  await db.cards.where('id').anyOf(ids).modify(statusPatch(status))
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
