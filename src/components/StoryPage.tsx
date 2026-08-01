import { useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useDeck } from '../useDeck'
import { useReadingTimer } from '../useReadingTimer'
import {
  db,
  inRotation,
  newCardDefaults,
  type Card,
  type SavedStory,
} from '../db'
import { defineWord, generateStory, pickBeat, ApiError } from '../ai'
import { leeches } from '../stats'
import { formatDuration } from '../time'
import {
  clearMediaSession,
  holdAudioFocus,
  keepSpeechAlive,
  loadVoices,
  preferredVoice,
  speakIn,
  setMediaPlaybackState,
  setMediaSession,
  speak,
  speechSupported,
  stopSpeaking,
} from '../speech'
import { Icon } from './Icon'
import { rootCandidates } from '../lemma'
import { defKey, splitSentences, tokenizeWords } from '../text'
import { useSettings, saveSettings } from '../useSettings'

/** What a deck card is, from the reader's point of view: still being learned,
 *  known, or ignored — a word that isn't vocabulary at all (a brand, a place)
 *  and should count as neither. */
type WordStatus = 'unknown' | 'known' | 'ignored'

const cardStatusOf = (c: Card): WordStatus =>
  c.ignored ? 'ignored' : c.known ? 'known' : 'unknown'

const WORD_STATUSES: { key: WordStatus; label: string; title: string }[] = [
  { key: 'unknown', label: 'Unknown', title: 'Back into the study rotation' },
  { key: 'known', label: 'Known', title: 'Out of study, counted as a word you know' },
  {
    key: 'ignored',
    label: 'Ignore',
    title: 'Not vocabulary — out of study, and never counted as known',
  },
]

/** What the generate button says during each pass of a story generation —
 *  writing, topping up a short draft, then glossing the result. */
const PHASE_LABEL: Record<'writing' | 'extending' | 'glossary', string> = {
  writing: 'Writing…',
  extending: 'Making it longer…',
  glossary: 'Looking up the words…',
}

const FONT_SCALE_MIN = 0.8
const FONT_SCALE_MAX = 1.8

interface Props {
  deckId: number
  /** Deep link: open this saved story (at its reading marker) on mount. */
  initialStoryId?: number
  onExit: () => void
}

interface Definition {
  word: string
  meaning: string
  isNew: boolean
  /** Root word this is an inflected form of, when the surface word itself isn't
   *  in the deck but its root is (e.g. "menjawab" → root "jawab"). */
  root?: string
  /** Definition being fetched on demand (word absent from this story's glossary). */
  loading?: boolean
  /** The on-demand lookup failed. */
  failed?: boolean
  /** Romanization (non-Latin scripts). */
  roman?: string
  /** The word is a character's personal name. */
  isName?: boolean
}

export function StoryPage({ deckId, initialStoryId, onExit }: Props) {
  const [topic, setTopic] = useState('')
  const [length, setLength] = useState(150)
  const [newPercent, setNewPercent] = useState(10)
  // 'all' — draw on every word in the deck; 'learning' — only words not yet
  // marked known (the ones you haven't learnt yet).
  const [scope, setScope] = useState<'all' | 'learning'>('all')
  const [loading, setLoading] = useState(false)
  /** Which generation pass is running, so the wait has a visible reason
   *  rather than just a spinner that won't stop. */
  const [phase, setPhase] = useState<'writing' | 'extending' | 'glossary'>('writing')
  const [error, setError] = useState('')
  const [story, setStory] = useState<SavedStory | null>(null)
  const [showTranslation, setShowTranslation] = useState(false)
  const [selected, setSelected] = useState<Definition | null>(null)
  // Story being continued — the generate form runs in "next part" mode.
  const [continuing, setContinuing] = useState<SavedStory | null>(null)
  // Optional reader steer for how a continuation should go.
  const [direction, setDirection] = useState('')
  // Read-aloud state. The play loop reads live rate/voice through refs and an
  // incremented run id cancels a superseded loop.
  const [reading, setReading] = useState(false)
  const [activeSentence, setActiveSentence] = useState<number | null>(null)
  const [rate, setRate] = useState(0.9)
  // "Mark mode": the next word tapped becomes the reading marker instead of
  // showing its definition.
  const [marking, setMarking] = useState(false)
  const runRef = useRef(0)
  // Stops the background speech keep-alive timer (podcast playback).
  const keepAliveRef = useRef<(() => void) | null>(null)
  // Releases the silent-audio hold that keeps screen-off playback alive.
  const audioFocusRef = useRef<(() => void) | null>(null)
  const rateRef = useRef(rate)
  rateRef.current = rate
  const sentenceRefs = useRef<(HTMLSpanElement | null)[]>([])
  const bookmarkWordRef = useRef<HTMLElement | null>(null)
  // Scroll-through-the-story progress, shown in the (collapsible) read bar.
  const storyBodyRef = useRef<HTMLDivElement | null>(null)
  const [progress, setProgress] = useState(0)

  // Deck words at the moment the story was opened — keeps the "new words" chip
  // list stable while words are added (added ones show a ✓ instead of vanishing).
  const [baselineKeys, setBaselineKeys] = useState<Set<string>>(new Set())

  // Daily reading log — ticks only while a story is open.
  const timer = useReadingTimer(!!story)

  const settings = useSettings()
  const { deck, cards, langCode } = useDeck(deckId)
  const savedStories = useLiveQuery(
    () => db.stories.where('deckId').equals(deckId).reverse().sortBy('createdAt'),
    [deckId],
  )
  const reviews = useLiveQuery(() => db.reviews.where('deckId').equals(deckId).toArray(), [deckId])

  // Words this deck keeps failing on — handed to the writer so they carry the
  // plot instead of only ever being met on a flashcard.
  const focusWords = useMemo(
    () => leeches(cards ?? [], reviews ?? [], 6).map((l) => l.card.word),
    [cards, reviews],
  )


  // Cards keyed by defKey(word) — for resolving a tapped word to its card.
  const cardByKey = useMemo(() => {
    const map = new Map<string, Card>()
    for (const c of cards ?? []) map.set(defKey(c.word), c)
    return map
  }, [cards])

  // Words already in the deck (known or learning alike). Highlighting is decided
  // against this set.
  const deckKeys = useMemo(() => new Set((cards ?? []).map((c) => defKey(c.word))), [cards])

  // Resolve a surface-word key to the deck word it belongs to: the word itself
  // if it's a card, otherwise a morphological root that is (e.g. Indonesian
  // "menjawab" → "jawab"). Returns null when nothing in the bank matches.
  // Memoised with a cache since it runs per token during render.
  const resolveDeckKey = useMemo(() => {
    const cache = new Map<string, string | null>()
    return (key: string): string | null => {
      if (!key) return null
      const cached = cache.get(key)
      if (cached !== undefined) return cached
      let hit: string | null = deckKeys.has(key) ? key : null
      if (hit === null) {
        for (const c of rootCandidates(key, langCode)) {
          if (deckKeys.has(c)) {
            hit = c
            break
          }
        }
      }
      cache.set(key, hit)
      return hit
    }
  }, [deckKeys, langCode])

  // A word is "new" (highlighted) when neither it nor its root is in the deck —
  // ground truth from the word bank, not the model's unreliable isNew flag.
  const isNewWord = (key: string) => !!key && !resolveDeckKey(key)

  // Character names (every word of multi-word names) — rendered in their own
  // colour and kept out of the new-word highlighting and chips.
  const nameKeys = useMemo(() => {
    const set = new Set<string>()
    for (const name of story?.characterNames ?? []) {
      for (const part of tokenizeWords(name, langCode)) {
        const k = defKey(part)
        if (k) set.add(k)
      }
    }
    return set
  }, [story?.characterNames, langCode])

  // Tap-to-define lookup: glossary from the model, plus the word bank as fallback.
  const defs = useMemo(() => {
    const map = new Map<string, Definition>()
    for (const c of cards ?? []) {
      map.set(defKey(c.word), { word: c.word, meaning: c.meaning, isNew: false, roman: c.roman })
    }
    for (const g of story?.glossary ?? []) {
      const key = defKey(g.word)
      const isName = nameKeys.has(key)
      map.set(key, {
        word: g.word,
        meaning: g.meaning,
        isNew: !isName && isNewWord(key),
        roman: g.roman,
        isName,
      })
    }
    return map
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cards, story, deckKeys, resolveDeckKey, nameKeys])

  // Sentences of the open story — the read-aloud unit and highlight granularity.
  const sentences = useMemo(
    () => (story ? splitSentences(story.story, langCode) : []),
    [story, langCode],
  )

  // Tokenize into sentences → chunks, numbering each word with a story-global
  // index (the bookmark unit) and recording which sentence each word is in.
  // Also flag tokens inside quotation marks so dialogue can be italicised.
  const layout = useMemo(() => {
    let w = -1
    let inQuote = false // running quote-mark parity across the whole story
    const QUOTE = /["“”„‟«»]/g
    const wordToSentence: number[] = []
    const rows = sentences.map((s, si) =>
      tokenizeWords(s, langCode).map((tok) => {
        const before = inQuote
        const marks = tok.match(QUOTE)
        if (marks) for (let k = 0; k < marks.length; k++) inQuote = !inQuote
        const quoted = before || !!marks
        if (!defKey(tok)) return { tok, wordIdx: -1, quoted }
        w++
        wordToSentence[w] = si
        return { tok, wordIdx: w, quoted }
      }),
    )
    return { rows, wordToSentence, wordCount: w + 1 }
  }, [sentences, langCode])
  // Read by the scroll handler, which is bound once per story.
  const wordCountRef = useRef(0)
  wordCountRef.current = layout.wordCount

  const canRead = speechSupported && !!story

  // Stop audio (and drop the lock-screen controls) when leaving the page.
  useEffect(
    () => () => {
      runRef.current++
      stopSpeaking()
      releaseBackgroundAudio()
      clearMediaSession()
    },
    [],
  )

  useEffect(() => {
    // Credit whatever was read in the story being left, then hand the word
    // counters over to the new one.
    timer.adopt(story ?? null)
    // A new story (or list view) cancels any in-progress reading, exits mark
    // mode, and lands on the sentence holding the saved marker word, if any.
    runRef.current++
    stopSpeaking()
    setReading(false)
    setMarking(false)
    const b = story?.bookmark
    setActiveSentence(b != null ? (layout.wordToSentence[b] ?? null) : null)
    if (b != null) {
      // Scroll the marked word into view once it has rendered.
      requestAnimationFrame(() =>
        bookmarkWordRef.current?.scrollIntoView({ block: 'center', behavior: 'auto' }),
      )
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [story?.id])
  useEffect(() => {
    if (activeSentence == null) return
    sentenceRefs.current[activeSentence]?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [activeSentence])

  // Reading progress = how much of the story text has scrolled past the bottom
  // of the viewport. A story shorter than one screen counts as fully shown.
  const storyId = story?.id
  const wordsSeenRef = timer.seen
  useEffect(() => {
    if (storyId == null) return
    let frame = 0
    const measure = () => {
      frame = 0
      const el = storyBodyRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      if (rect.height <= 0) return
      const seen = window.innerHeight - rect.top
      const frac = Math.min(1, Math.max(0, seen / rect.height))
      setProgress(frac)
      wordsSeenRef.current = Math.max(wordsSeenRef.current, Math.round(frac * wordCountRef.current))
    }
    const onScroll = () => {
      if (frame === 0) frame = requestAnimationFrame(measure)
    }
    measure()
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
    }
  }, [storyId, wordsSeenRef])

  // Deep link (homepage "continue reading"): open the requested story once the
  // data is in. Guarded so closing the story afterwards doesn't reopen it.
  const autoOpenedRef = useRef<number | null>(null)
  useEffect(() => {
    if (initialStoryId == null || autoOpenedRef.current === initialStoryId) return
    if (!savedStories || !cards) return
    const s = savedStories.find((x) => x.id === initialStoryId)
    if (s) {
      autoOpenedRef.current = initialStoryId
      openStory(s)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialStoryId, savedStories, cards])

  // Saved stories grouped into threads: each root (or orphan) followed by its
  // continuation parts in reading order. Threads sorted by newest activity.
  const threads = useMemo(() => {
    const all = savedStories ?? []
    const roots = all.filter((s) => !s.parentId || !all.some((r) => r.id === s.parentId))
    const groups = roots.map((root) => ({
      root,
      parts: all
        .filter((s) => s.parentId === root.id)
        .sort((a, b) => a.createdAt - b.createdAt),
    }))
    const latest = (g: (typeof groups)[number]) =>
      Math.max(g.root.createdAt, ...g.parts.map((p) => p.createdAt))
    return groups.sort((a, b) => latest(b) - latest(a))
  }, [savedStories])

  if (!deck || !cards) return null

  // The pool the writer can draw on — ignored words are not vocabulary.
  const bankSize = cards.filter((c) => !c.ignored).length

  // "Only unlearned" needs at least one card that isn't marked known.
  // Ignored words are never vocabulary the writer should build on.
  const scopeEmpty = scope === 'learning' && !cards.some(inRotation)

  /** Generate a story — a fresh one, or the next part of the thread being
   *  continued, optionally steered by what the reader asked for. */
  async function run() {
    const from = continuing
    const steer = direction.trim()
    setLoading(true)
    setPhase('writing')
    setError('')
    try {
      // Don't replay a dramatic turn this thread has already used.
      const usedBeats = from
        ? (savedStories ?? [])
            .filter(
              (s) =>
                s.id === (from.parentId ?? from.id) || s.parentId === (from.parentId ?? from.id),
            )
            .map((s) => s.beat)
            .filter((b): b is string => !!b)
        : []
      const beat = pickBeat(usedBeats)
      const result = await generateStory({
        deck: deck!,
        // In 'learning' mode, don't seed the story with already-known words —
        // build it only from the ones still being learned.
        knownWords: scope === 'all' ? cards!.filter((c) => c.known).map((c) => c.word) : [],
        learningWords: cards!.filter(inRotation).map((c) => c.word),
        newWordPercent: newPercent,
        topic: from ? undefined : topic || undefined,
        lengthWords: length,
        onProgress: (info) => setPhase(info.phase),
        beat,
        focusWords,
        // Steer fresh stories away from themes already covered (recent first).
        avoidThemes: from
          ? undefined
          : (savedStories ?? []).slice(0, 8).map((s) => (s.topic ? `${s.title} (${s.topic})` : s.title)),
        continueFrom: from
          ? {
              title: from.title,
              story: from.story,
              direction: steer || undefined,
              bible: from.bible,
            }
          : undefined,
      })
      const record: Omit<SavedStory, 'id'> = {
        deckId,
        title: result.title,
        story: result.story,
        translation: result.translation,
        glossary: result.glossary,
        characterNames: result.characterNames,
        bible: result.bible,
        beat,
        focusWords: focusWords.length > 0 ? focusWords : undefined,
        chosen: from && steer ? steer : undefined,
        topic: from ? undefined : topic.trim() || undefined,
        // Parts always attach to the thread's root, never to another part.
        parentId: from ? (from.parentId ?? from.id) : undefined,
        createdAt: Date.now(),
      }
      const id = await db.stories.add(record)
      setContinuing(null)
      setDirection('')
      openStory({ ...record, id })
      window.scrollTo({ top: 0 })
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setError('Your session expired — reload the page and sign in again.')
      } else if (e instanceof ApiError && e.status === 429) {
        setError('Rate limited by the API — wait a moment and try again.')
      } else {
        setError((e instanceof Error && e.message) || 'Generation failed. Please try again.')
      }
    } finally {
      setLoading(false)
      setPhase('writing')
    }
  }

  function openStory(s: SavedStory) {
    setStory(s)
    setShowTranslation(false)
    setSelected(null)
    // Land on the saved reading marker so "resume where I left off" is one tap.
    setActiveSentence(s.bookmark ?? null)
    setBaselineKeys(new Set((cards ?? []).map((c) => defKey(c.word))))
    // Remember it as the most recently read story (homepage shortcut).
    void db.stories.update(s.id, { lastOpenedAt: Date.now() })
  }

  async function deleteStory(id: number) {
    // Deleting a thread root removes its continuation parts too.
    await db.stories.where('parentId').equals(id).delete()
    await db.stories.delete(id)
  }

  // Continue a thread: new parts always pick up from its latest part.
  function continueThread(root: SavedStory, parts: SavedStory[]) {
    setContinuing(parts.length > 0 ? parts[parts.length - 1] : root)
    setStory(null)
    setError('')
  }

  // Read the story aloud, sentence by sentence, highlighting the current one.
  // Uses the deck-language system voice — same voices as study/listen, offline.
  // Publishes a media session so lock-screen / headphone controls drive it and
  // a keep-alive timer holds playback through a screen-off / backgrounded tab.
  async function readAloud(startIdx: number) {
    const my = ++runRef.current
    stopSpeaking()
    setReading(true)
    // Hold the tab audible + ping speech, so playback survives a locked screen.
    // Started synchronously here so the silent audio inherits the tap's gesture.
    keepAliveRef.current?.()
    keepAliveRef.current = keepSpeechAlive()
    audioFocusRef.current?.()
    audioFocusRef.current = holdAudioFocus()
    if (story) {
      setMediaSession({
        title: story.title,
        artist: deck?.name,
        onPlay: () => readAloud(activeSentence ?? 0),
        onPause: pauseReading,
        onPrev: () => skip(-1),
        onNext: () => skip(1),
      })
      setMediaPlaybackState('playing')
    }
    const voices = await loadVoices()
    const voice = preferredVoice(voices, langCode)
    for (let i = startIdx; i < sentences.length; i++) {
      if (runRef.current !== my) return
      setActiveSentence(i)
      const text = sentences[i].trim()
      if (text) {
        await speak(text, { voice, lang: langCode ?? undefined, rate: rateRef.current })
      }
      if (runRef.current !== my) return
    }
    if (runRef.current === my) {
      setReading(false)
      setActiveSentence(null)
      releaseBackgroundAudio()
      setMediaPlaybackState('none')
    }
  }

  // Release the background-playback holds (silent audio + speech ping).
  function releaseBackgroundAudio() {
    keepAliveRef.current?.()
    keepAliveRef.current = null
    audioFocusRef.current?.()
    audioFocusRef.current = null
  }

  function pauseReading() {
    runRef.current++
    stopSpeaking()
    setReading(false) // keep activeSentence so play resumes from here
    releaseBackgroundAudio()
    setMediaPlaybackState('paused')
  }

  // Speak a single word (used by the definition popup's pronounce button).
  async function pronounce(text: string) {
    stopSpeaking()
    await speakIn(text, langCode)
  }

  // Sentence that holds the marker word (for read-aloud resume alignment).
  const bookmarkSentence =
    story?.bookmark != null ? (layout.wordToSentence[story.bookmark] ?? 0) : null

  function toggleReading() {
    if (reading) pauseReading()
    else readAloud(activeSentence ?? bookmarkSentence ?? 0)
  }

  // Move the active sentence; restart playback there if currently reading.
  function skip(delta: number) {
    const from = activeSentence ?? bookmarkSentence ?? 0
    const next = Math.max(0, Math.min(sentences.length - 1, from + delta))
    if (reading) readAloud(next)
    else setActiveSentence(next)
  }

  async function setBookmark(wordIdx: number | undefined) {
    if (!story) return
    await db.stories.update(story.id, { bookmark: wordIdx })
    setStory({ ...story, bookmark: wordIdx })
  }

  function jumpToBookmark() {
    if (bookmarkSentence == null) return
    setActiveSentence(bookmarkSentence)
    bookmarkWordRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }

  function changeFontScale(delta: number) {
    const next = Math.round(
      Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, settings.storyFontScale + delta)) * 100,
    ) / 100
    saveSettings({ storyFontScale: next })
  }

  // Tap a word. In mark mode it drops the reading marker there; otherwise it
  // shows the definition (from the glossary/deck — instant, offline, no AI).
  // Words the glossary missed get an on-demand AI lookup, cached into the story.
  // Every tap that resolves to a card also bumps that card's lookup count — the
  // "struggle" signal used to sort the deck.
  function onWordTap(token: string, wordIdx: number) {
    if (marking) {
      setMarking(false)
      setBookmark(wordIdx)
      setActiveSentence(layout.wordToSentence[wordIdx] ?? null)
      return
    }
    const key = defKey(token)
    if (!key) return
    const display = token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    // The deck word this token belongs to (itself or a morphological root).
    const deckKey = resolveDeckKey(key)
    const rootCard = deckKey ? cardByKey.get(deckKey) : undefined
    if (rootCard) recordLookup(rootCard.id)

    const def = defs.get(key)
    if (def) {
      // Exact glossary/deck entry — its own meaning is authoritative. Trust the
      // bank (surface or root) over the model's isNew flag for the "new" pill.
      setSelected({ ...def, isNew: !deckKey })
      return
    }
    if (rootCard) {
      // No exact entry, but the word is an inflected form of a known card — show
      // that card's meaning and flag which root it came from.
      setSelected({
        word: display,
        meaning: rootCard.meaning,
        isNew: false,
        root: rootCard.word,
        roman: rootCard.roman,
      })
      return
    }
    setSelected({ word: display, meaning: '', isNew: true, loading: true })
    const si = layout.wordToSentence[wordIdx]
    void lookupMissing(display, key, si != null ? sentences[si] : undefined)
  }

  // Bump a card's story lookup counter (the deck "struggle" sort metric).
  // Uses modify() so the read-and-increment happens inside one transaction —
  // rapid taps on the same card can't lose an increment to a read/write race.
  async function recordLookup(cardId: number) {
    await db.cards.where('id').equals(cardId).modify((c) => {
      c.lookups = (c.lookups ?? 0) + 1
    })
  }

  // Fetch a definition the glossary missed and persist it into the saved
  // story's glossary so every future tap is instant and offline.
  async function lookupMissing(display: string, key: string, sentence?: string) {
    const sid = story?.id
    try {
      const res = await defineWord({ deck: deck!, word: display, sentence })
      const entry = {
        word: display,
        meaning: res.meaning,
        // Reached only when the word has no card or known root, so "new" hinges
        // purely on it being a content word (keeps function words off the chips).
        isNew: res.isContentWord,
        roman: res.roman || undefined,
      }
      if (sid != null) {
        const rec = await db.stories.get(sid)
        if (rec) {
          const glossary = [...(rec.glossary ?? []), entry]
          await db.stories.update(sid, { glossary })
          setStory((cur) => (cur && cur.id === sid ? { ...cur, glossary } : cur))
        }
      }
      setSelected((sel) =>
        sel?.loading && defKey(sel.word) === key
          ? { word: display, meaning: res.meaning, isNew: true, roman: res.roman || undefined }
          : sel,
      )
    } catch {
      setSelected((sel) =>
        sel?.loading && defKey(sel.word) === key ? { ...sel, loading: false, failed: true } : sel,
      )
    }
  }

  async function addWord(
    word: string,
    meaning: string,
    status: WordStatus = 'unknown',
    roman?: string,
  ) {
    await db.cards.add({
      deckId,
      word,
      meaning,
      example: '',
      roman: roman || undefined,
      ...newCardDefaults(),
      known: status === 'known',
      ignored: status === 'ignored',
    })
  }

  // Move the deck card matching a tapped word between the three statuses. The
  // two flags are set together so a card can never be both known and ignored.
  async function setWordStatus(word: string, status: WordStatus) {
    const card = (cards ?? []).find((c) => defKey(c.word) === defKey(word))
    if (card)
      await db.cards.update(card.id, {
        known: status === 'known',
        ignored: status === 'ignored',
      })
  }

  // Words worth surfacing under the story. The glossary now holds EVERY word
  // (function words included), so require the model's content-word isNew flag —
  // otherwise "ke", "dan" etc. would flood the list — and still drop anything
  // already in the deck when the story was opened.
  const newWords = (story?.glossary ?? []).filter((g) => {
    if (!g.isNew) return false
    // Names aren't vocabulary — keep them off the chips.
    if (nameKeys.has(defKey(g.word))) return false
    // Drop words whose surface form OR morphological root was already in the
    // bank when the story opened (e.g. "menjawab" when "jawab" is known).
    return !rootCandidates(defKey(g.word), langCode).some((c) => baselineKeys.has(c))
  })

  // Header stats for the open story. Counted from the tokenized layout (so
  // spaceless scripts like Thai count words, not phrases). "new" counts the
  // distinct highlighted words — names excluded — straight from the text, so
  // it always matches what's highlighted regardless of glossary completeness.
  const uniqueKeys = new Set(
    layout.rows.flatMap((row) => row.filter((t) => t.wordIdx >= 0).map((t) => defKey(t.tok))),
  )
  const stats = {
    words: layout.wordCount,
    unique: uniqueKeys.size,
    newWords: [...uniqueKeys].filter((k) => isNewWord(k) && !nameKeys.has(k)).length,
    readMin: Math.max(1, Math.round(layout.wordCount / 130)),
  }

  // Ruby romanization: available when the glossary carries romanizations
  // (non-Latin scripts only); shown per the storyRoman setting.
  const hasRoman = (story?.glossary ?? []).some((g) => g.roman)
  const romanMode = settings.storyRoman
  const controlsOpen = settings.storyControlsOpen
  const progressPct = Math.round(progress * 100)
  // Where the saved marker sits along the story, as a tick on the progress bar.
  const bookmarkPct =
    story?.bookmark != null && layout.wordCount > 0
      ? Math.min(100, Math.round(((story.bookmark + 1) / layout.wordCount) * 100))
      : null
  function cycleRomanMode() {
    const next = romanMode === 'off' ? 'new' : romanMode === 'new' ? 'all' : 'off'
    saveSettings({ storyRoman: next })
  }

  const selectedCard = selected
    ? (cards ?? []).find((c) => defKey(c.word) === defKey(selected.word))
    : undefined
  const selectedInDeck = !!selectedCard

  // The open story's place in its thread: what came before (for the recap) and
  // whether a next part already exists (which the reader gets a link to).
  const chainGroup = story ? threads.find((t) => t.root.id === (story.parentId ?? story.id)) : null
  const chain = chainGroup ? [chainGroup.root, ...chainGroup.parts] : story ? [story] : []
  const chainIdx = story ? chain.findIndex((s) => s.id === story.id) : -1
  const prevPart = chainIdx > 0 ? chain[chainIdx - 1] : null
  const nextPart = chainIdx >= 0 && chainIdx < chain.length - 1 ? chain[chainIdx + 1] : null

  return (
    <>
      <div className="page-head">
        <h1>Story</h1>
        <span className="sub">
          {deck.name} · built from your {bankSize} {bankSize === 1 ? 'word' : 'words'}
        </span>
        <span className="read-timer" title="Time spent reading stories today">
          <Icon name="clock" /> {formatDuration(timer.todaySecs)} today
        </span>
      </div>

      {story === null ? (
        <>
          <div className="story-form">
            {continuing ? (
              <>
                <div className="continue-banner">
                  <span>
                    Continuing <b>“{continuing.title}”</b>
                  </span>
                  <button
                    className="btn ghost small"
                    title="Start a fresh story instead"
                    onClick={() => {
                      setContinuing(null)
                      setDirection('')
                    }}
                  >
                    ✕
                  </button>
                </div>
                <div className="field">
                  <label htmlFor="story-direction">What happens next? (optional)</label>
                  <textarea
                    id="story-direction"
                    autoFocus
                    value={direction}
                    onChange={(e) => setDirection(e.target.value)}
                    placeholder="e.g. something surprising happens, or the main character feels sad"
                  />
                </div>
              </>
            ) : (
              <div className="field">
                <label htmlFor="story-topic">Topic (optional)</label>
                <input
                  id="story-topic"
                  autoFocus
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && !loading && run()}
                  placeholder="e.g. a lost dog finds its way home"
                />
              </div>
            )}
            <div className="field">
              <label>Build from</label>
              <div className="seg-control">
                <button
                  type="button"
                  className={scope === 'all' ? 'on' : ''}
                  onClick={() => setScope('all')}
                >
                  All my words
                </button>
                <button
                  type="button"
                  className={scope === 'learning' ? 'on' : ''}
                  onClick={() => setScope('learning')}
                >
                  Only unlearned
                </button>
              </div>
            </div>
            <div className="field">
              <label htmlFor="story-length">Length · about {length} words</label>
              <input
                id="story-length"
                type="range"
                min={50}
                max={2000}
                step={50}
                value={length}
                onChange={(e) => setLength(Number(e.target.value))}
              />
            </div>
            <div className="field">
              <label htmlFor="story-new">
                New words allowed · {newPercent}% {newPercent === 0 ? '(word bank only)' : ''}
              </label>
              <input
                id="story-new"
                type="range"
                min={0}
                max={30}
                step={1}
                value={newPercent}
                onChange={(e) => setNewPercent(Number(e.target.value))}
              />
            </div>
            <p className="note">
              {continuing
                ? `Writes the next part of the story, picking up where it left off.`
                : scope === 'all'
                  ? `Writes a casual, everyday ${deck.language} story leaning on the words you know and weaving in the ones you're learning.`
                  : `Writes a casual, everyday ${deck.language} story built only from the words you haven't learnt yet.`}{' '}
              Tap any word in the result for its meaning. It ends on a cliffhanger with two ways to
              go next.
            </p>
            {focusWords.length > 0 && (
              <p className="note">
                Building the plot around {focusWords.length} words you keep forgetting —{' '}
                <b>{focusWords.join(', ')}</b> — so you meet each of them several times in context.
              </p>
            )}
            {scopeEmpty && (
              <p className="note error-note">
                No unlearned words in this deck — every card is marked known. Switch to “All my
                words”, or unmark some cards.
              </p>
            )}
            {error && <p className="note error-note">{error}</p>}
            <div className="story-form-actions">
              <button className="btn ghost" onClick={onExit}>
                Cancel
              </button>
              <button
                className="btn accent"
                onClick={() => run()}
                disabled={loading || bankSize === 0 || scopeEmpty}
              >
                {loading
                  ? PHASE_LABEL[phase]
                  : continuing
                    ? 'Continue story'
                    : 'Generate story'}
              </button>
            </div>
          </div>

          {threads.length > 0 && (
            <div className="story-saved">
              <div className="eyebrow">Saved stories</div>
              {threads.map(({ root, parts }) => (
                <div className="story-thread" key={root.id}>
                  <div className="story-saved-row">
                    <button className="story-saved-open" onClick={() => openStory(root)}>
                      <span className="story-saved-title">{root.title}</span>
                      <span className="story-saved-meta">
                        {root.topic ? `${root.topic} · ` : ''}
                        {new Date(root.createdAt).toLocaleDateString()}
                      </span>
                    </button>
                    <button
                      className="btn ghost small"
                      title="Write the next part of this story"
                      onClick={() => continueThread(root, parts)}
                    >
                      ✦ Continue
                    </button>
                    <button
                      className="btn ghost small"
                      title={
                        parts.length > 0
                          ? 'Delete this story and all its parts'
                          : 'Delete this story'
                      }
                      onClick={() => deleteStory(root.id)}
                    >
                      ✕
                    </button>
                  </div>
                  {/* Newest part first — the one you're most likely to want is
                      right under the thread, not buried below every older part.
                      `parts` stays in reading order for the numbering. */}
                  {parts
                    .map((p, i) => ({ part: p, number: i + 2 }))
                    .reverse()
                    .map(({ part: p, number }) => (
                      <div className="story-saved-row story-part-row" key={p.id}>
                        <button className="story-saved-open" onClick={() => openStory(p)}>
                          <span className="story-saved-title">
                            <span className="story-part-label">Part {number}</span> {p.title}
                          </span>
                          <span className="story-saved-meta">
                            {new Date(p.createdAt).toLocaleDateString()}
                          </span>
                        </button>
                        <button
                          className="btn ghost small"
                          title="Delete this part"
                          onClick={() => db.stories.delete(p.id)}
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <div className="story-page">
          {chainIdx > 0 && <div className="story-part-badge">Part {chainIdx + 1}</div>}
          <h2 className="story-title">{story.title}</h2>
          {prevPart?.bible?.logline && (
            <p className="story-previously">
              <b>Previously</b> {prevPart.bible.logline}
              {story.chosen && <em> You chose: {story.chosen}.</em>}
            </p>
          )}
          <div className="story-stats">
            <span title="Words in the story">{stats.words} words</span>
            <span title="Distinct words">{stats.unique} unique</span>
            {stats.newWords > 0 && (
              <span className="story-stat-new" title="Words not in your deck, highlighted below">
                {stats.newWords} new
              </span>
            )}
            <span title="Estimated time to read">~{stats.readMin} min read</span>
          </div>

          <div className={`story-read-bar${controlsOpen ? '' : ' collapsed'}`}>
            {/* Always-visible strip: play, how far through you are, and the
                collapse toggle — everything else folds away behind it. */}
            <div className="story-bar-head">
              {canRead && (
                <button
                  className={`btn small icon-btn${reading ? ' accent' : ' primary'}`}
                  onClick={toggleReading}
                  title={reading ? 'Pause reading' : 'Read the story aloud'}
                  aria-label={reading ? 'Pause reading' : 'Read the story aloud'}
                >
                  <Icon name={reading ? 'pause' : 'play'} />
                </button>
              )}
              <div
                className="story-progress"
                title={`${progressPct}% of the way through this story`}
              >
                <span className="story-progress-track">
                  <span className="story-progress-fill" style={{ width: `${progressPct}%` }} />
                  {bookmarkPct != null && (
                    <span
                      className="story-progress-mark"
                      style={{ left: `${bookmarkPct}%` }}
                      title={`Your marker is at ${bookmarkPct}%`}
                    />
                  )}
                </span>
                <span className="story-progress-pct">{progressPct}%</span>
              </div>
              <button
                className="btn small ghost icon-btn"
                onClick={() => saveSettings({ storyControlsOpen: !controlsOpen })}
                aria-expanded={controlsOpen}
                title={controlsOpen ? 'Hide the reading controls' : 'Show the reading controls'}
                aria-label={controlsOpen ? 'Hide the reading controls' : 'Show the reading controls'}
              >
                <Icon name={controlsOpen ? 'chevronUp' : 'chevronDown'} />
              </button>
            </div>

            {controlsOpen && (
            <div className="story-bar-controls">
            {canRead && (
              <div className="story-play-group">
                <button
                  className="btn small ghost icon-btn"
                  onClick={() => skip(-1)}
                  title="Previous sentence"
                  aria-label="Previous sentence"
                  disabled={(activeSentence ?? 0) <= 0}
                >
                  <Icon name="skipBack" />
                </button>
                <button
                  className="btn small ghost icon-btn"
                  onClick={() => skip(1)}
                  title="Next sentence"
                  aria-label="Next sentence"
                  disabled={(activeSentence ?? 0) >= sentences.length - 1}
                >
                  <Icon name="skipForward" />
                </button>
                <button
                  className="btn small ghost"
                  onClick={() => readAloud(0)}
                  title="Play the whole story from the start — with lock-screen and headphone controls, so it keeps going with the screen off"
                >
                  <Icon name="headphones" /> Podcast
                </button>
              </div>
            )}

            <button
              className={`btn small ${marking ? 'accent' : 'ghost'}${
                !marking && story.bookmark != null ? ' bookmarked' : ''
              }`}
              onClick={() => setMarking((m) => !m)}
              title={
                marking
                  ? 'Cancel — or tap a word in the story'
                  : story.bookmark != null
                    ? 'Move your reading marker'
                    : 'Mark your place — then tap a word'
              }
            >
              {marking ? (
                <>
                  <Icon name="x" /> Tap a word
                </>
              ) : (
                <>
                  <Icon name="bookmark" /> {story.bookmark != null ? 'Move marker' : 'Mark spot'}
                </>
              )}
            </button>
            {!marking && story.bookmark != null && (
              <>
                <button className="btn small ghost" onClick={jumpToBookmark} title="Go to your marker">
                  <Icon name="bookmarkGo" /> Go to marker
                </button>
                <button
                  className="btn small ghost icon-btn"
                  onClick={() => setBookmark(undefined)}
                  title="Remove the reading marker"
                  aria-label="Remove the reading marker"
                >
                  <Icon name="x" />
                </button>
              </>
            )}

            {hasRoman && (
              <button
                className={`btn small ${romanMode === 'off' ? 'ghost' : ''}`}
                onClick={cycleRomanMode}
                title="Romanization above the words — off, new words only, or all words"
              >
                <span className="roman-glyph">Aa</span> {romanMode}
              </button>
            )}

            <div className="story-size">
              <button
                className="btn small ghost"
                onClick={() => changeFontScale(-0.1)}
                disabled={settings.storyFontScale <= FONT_SCALE_MIN}
                title="Smaller text"
                aria-label="Smaller text"
              >
                A−
              </button>
              <button
                className="btn small ghost"
                onClick={() => changeFontScale(0.1)}
                disabled={settings.storyFontScale >= FONT_SCALE_MAX}
                title="Larger text"
                aria-label="Larger text"
              >
                A+
              </button>
            </div>

            {canRead && (
              <label className="story-rate" title="Reading speed">
                <span>{rate.toFixed(2)}×</span>
                <input
                  type="range"
                  min={0.5}
                  max={1.25}
                  step={0.05}
                  value={rate}
                  onChange={(e) => setRate(Number(e.target.value))}
                />
              </label>
            )}
            </div>
            )}
          </div>

          {marking && (
            <p className="note story-mark-hint">Tap the word in the story where you stopped reading.</p>
          )}
          <div
            ref={storyBodyRef}
            className={`story-body${marking ? ' marking' : ''}`}
            style={{ fontSize: `${17 * settings.storyFontScale}px` }}
          >
            {layout.rows.map((tokens, i) => (
              <span
                key={i}
                ref={(el) => {
                  sentenceRefs.current[i] = el
                }}
                className={`story-sentence${i === activeSentence ? ' active' : ''}`}
              >
                {tokens.map((t, ti) => {
                  if (t.wordIdx < 0)
                    return (
                      <span key={ti} className={t.quoted ? 'story-quoted' : undefined}>
                        {t.tok}
                      </span>
                    )
                  const marked = t.wordIdx === story.bookmark
                  const key = defKey(t.tok)
                  // Highlight straight from deck membership so ANY word not in
                  // the bank is orange — even ones the glossary missed. Deck
                  // words (known or learning) read as plain, tappable text.
                  // Character names get their own colour instead.
                  const isName = nameKeys.has(key)
                  const isNew = !isName && isNewWord(key)
                  const cls = isName ? ' story-name' : isNew ? ' new-word' : ' plain'
                  // Ruby romanization above the word, per the setting.
                  const roman =
                    romanMode === 'all' || (romanMode === 'new' && isNew)
                      ? defs.get(key)?.roman
                      : undefined
                  return (
                    <span key={ti} className={marked ? 'story-marked-word' : undefined}>
                      {marked && <Icon name="bookmark" className="story-bookmark-marker" />}
                      <button
                        ref={
                          marked
                            ? (el) => {
                                bookmarkWordRef.current = el
                              }
                            : undefined
                        }
                        className={`story-word${cls}${t.quoted ? ' story-quoted' : ''}`}
                        onClick={() => onWordTap(t.tok, t.wordIdx)}
                      >
                        {roman ? (
                          <ruby>
                            {t.tok}
                            <rt>{roman}</rt>
                          </ruby>
                        ) : (
                          t.tok
                        )}
                      </button>
                    </span>
                  )
                })}
              </span>
            ))}
          </div>
          {showTranslation && <div className="story-translation">{story.translation}</div>}

          {nextPart && (
            <div className="story-next">
              <div className="eyebrow">Next part</div>
              <button className="story-next-link" onClick={() => openStory(nextPart)}>
                <span className="story-next-title">{nextPart.title}</span>
                <span className="story-next-meta">
                  Part {chainIdx + 2}
                  {nextPart.chosen ? ` · you asked for: ${nextPart.chosen}` : ''}
                </span>
              </button>
            </div>
          )}

          <div className="story-toolbar">
            <button className="btn ghost small" onClick={() => setShowTranslation((s) => !s)}>
              {showTranslation ? 'Hide translation' : 'Show translation'}
            </button>
            <button
              className="btn ghost small"
              title="Write the next part of this story"
              onClick={() => {
                const g = threads.find((t) => t.root.id === (story.parentId ?? story.id))
                if (g) continueThread(g.root, g.parts)
              }}
            >
              ✦ Continue story
            </button>
            <button
              className="btn ghost small"
              onClick={() => {
                setStory(null)
                setContinuing(null)
              }}
            >
              ← All stories
            </button>
          </div>

          {newWords.length > 0 && (
            <div className="story-new-words">
              <div className="eyebrow">New words in this story</div>
              <div className="chip-list">
                {newWords.map((w) => (
                  <span key={w.word} className="chip">
                    {w.word}
                    {w.roman && <span className="chip-roman">{w.roman}</span>}
                    <em>{w.meaning}</em>
                    {deckKeys.has(defKey(w.word)) ? (
                      <b className="chip-added">✓</b>
                    ) : (
                      <button
                        className="add-word"
                        title={`Add “${w.word}” to the deck`}
                        onClick={() => addWord(w.word, w.meaning, 'unknown', w.roman)}
                      >
                        +
                      </button>
                    )}
                    {!deckKeys.has(defKey(w.word)) && (
                      <button
                        className="add-word ignore"
                        title={`Ignore “${w.word}” — not vocabulary, just stop flagging it as new`}
                        onClick={() => addWord(w.word, w.meaning, 'ignored', w.roman)}
                      >
                        ⊘
                      </button>
                    )}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {selected && (
        <div className="word-sheet-backdrop" onClick={() => setSelected(null)}>
          <div className="word-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="word-sheet-word">
              {selected.word}
              {canRead && (
                <button
                  className="speak-btn"
                  title="Pronounce"
                  aria-label={`Pronounce ${selected.word}`}
                  onClick={() => pronounce(selected.word)}
                >
                  <Icon name="volume" />
                </button>
              )}
              {selected.isName && <span className="state-pill name">name</span>}
              {selected.isNew &&
                !selected.isName &&
                !selectedInDeck &&
                !selected.loading &&
                !selected.failed && <span className="state-pill new">new</span>}
              {selected.root && (
                <span className="state-pill root" title={`Form of “${selected.root}”, in your deck`}>
                  form of {selected.root}
                </span>
              )}
            </div>
            {(selected.roman || selectedCard?.roman) && (
              <div className="word-sheet-roman">{selected.roman ?? selectedCard?.roman}</div>
            )}
            <div className="word-sheet-meaning">
              {selected.loading
                ? 'Looking it up…'
                : selected.failed
                  ? 'Couldn’t fetch a definition — check your connection and tap the word again.'
                  : selected.meaning}
            </div>
            <div className="word-sheet-actions">
              {selectedCard ? (
                <>
                  <span className="s-tag added">
                    {selectedCard.ignored
                      ? 'Ignored ✓'
                      : selectedCard.known
                        ? 'Known ✓'
                        : 'In deck ✓'}
                  </span>
                  {/* All three statuses at once, so a word can always go back to
                      unknown — not just out of whichever one it is in. */}
                  <div className="seg-control small">
                    {WORD_STATUSES.map((s) => (
                      <button
                        key={s.key}
                        className={cardStatusOf(selectedCard) === s.key ? 'on' : ''}
                        title={s.title}
                        onClick={() => setWordStatus(selected.word, s.key)}
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <>
                  <button
                    className="btn small primary"
                    disabled={!selected.meaning}
                    onClick={() => addWord(selected.word, selected.meaning, 'unknown', selected.roman)}
                  >
                    Add to deck
                  </button>
                  <button
                    className="btn small"
                    disabled={!selected.meaning}
                    title="Add to the deck already marked as known"
                    onClick={() => addWord(selected.word, selected.meaning, 'known', selected.roman)}
                  >
                    Add as known
                  </button>
                  <button
                    className="btn small"
                    disabled={!selected.meaning}
                    title="Not vocabulary (a name, a brand…) — add it so the story stops flagging it as new, without counting it as a word you know"
                    onClick={() => addWord(selected.word, selected.meaning, 'ignored', selected.roman)}
                  >
                    Ignore
                  </button>
                </>
              )}
              <button className="btn small ghost" onClick={() => setSelected(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

