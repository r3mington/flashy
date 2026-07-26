import { useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, newCardDefaults, type Card, type SavedStory } from '../db'
import { defineWord, generateStory, ApiError } from '../ai'
import {
  clearMediaSession,
  holdAudioFocus,
  keepSpeechAlive,
  langCodeFor,
  loadVoices,
  preferredVoice,
  setMediaPlaybackState,
  setMediaSession,
  speak,
  speechSupported,
  stopSpeaking,
} from '../speech'
import { rootCandidates } from '../lemma'
import { useSettings, saveSettings } from '../useSettings'

const FONT_SCALE_MIN = 0.8
const FONT_SCALE_MAX = 1.8

/** Split text into sentences, keeping terminators and trailing space so the
 *  pieces re-join into the original. Works for . ! ? … across scripts. */
function splitSentences(text: string): string[] {
  return text.match(/[^.!?…]+[.!?…]*\s*/gu) ?? (text.trim() ? [text] : [])
}

function startOfToday(): number {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

interface Props {
  deckId: number
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
}

/** Lowercase and strip surrounding punctuation so tokens match glossary entries. */
function defKey(token: string): string {
  return token
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
}

export function StoryPage({ deckId, onExit }: Props) {
  const [topic, setTopic] = useState('')
  const [length, setLength] = useState(150)
  const [newPercent, setNewPercent] = useState(10)
  // 'all' — draw on every word in the deck; 'learning' — only words not yet
  // marked known (the ones you haven't learnt yet).
  const [scope, setScope] = useState<'all' | 'learning'>('all')
  const [loading, setLoading] = useState(false)
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

  // Daily reading timer: seconds already logged today (base) plus this session's
  // ticks; the sum is persisted periodically and on unmount.
  const [readBaseSecs, setReadBaseSecs] = useState(0)
  const [sessionSecs, setSessionSecs] = useState(0)
  const readDayRef = useRef(startOfToday())
  const baseRef = useRef(0)
  baseRef.current = readBaseSecs
  const sessRef = useRef(0)
  sessRef.current = sessionSecs
  // Deck words at the moment the story was opened — keeps the "new words" chip
  // list stable while words are added (added ones show a ✓ instead of vanishing).
  const [baselineKeys, setBaselineKeys] = useState<Set<string>>(new Set())

  const settings = useSettings()
  const deck = useLiveQuery(() => db.decks.get(deckId), [deckId])
  const cards = useLiveQuery(() => db.cards.where('deckId').equals(deckId).toArray(), [deckId])
  const savedStories = useLiveQuery(
    () => db.stories.where('deckId').equals(deckId).reverse().sortBy('createdAt'),
    [deckId],
  )

  const langCode = deck ? langCodeFor(deck.language) : null

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

  // Tap-to-define lookup: glossary from the model, plus the word bank as fallback.
  const defs = useMemo(() => {
    const map = new Map<string, Definition>()
    for (const c of cards ?? []) {
      map.set(defKey(c.word), { word: c.word, meaning: c.meaning, isNew: false })
    }
    for (const g of story?.glossary ?? []) {
      const key = defKey(g.word)
      map.set(key, { word: g.word, meaning: g.meaning, isNew: isNewWord(key) })
    }
    return map
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cards, story, deckKeys, resolveDeckKey])

  // Sentences of the open story — the read-aloud unit and highlight granularity.
  const sentences = useMemo(() => (story ? splitSentences(story.story) : []), [story])

  // Tokenize into sentences → chunks, numbering each word with a story-global
  // index (the bookmark unit) and recording which sentence each word is in.
  // Also flag tokens inside quotation marks so dialogue can be italicised.
  const layout = useMemo(() => {
    let w = -1
    let inQuote = false // running quote-mark parity across the whole story
    const QUOTE = /["“”„‟«»]/g
    const wordToSentence: number[] = []
    const rows = sentences.map((s, si) =>
      s.split(/(\s+)/).map((tok) => {
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
    return { rows, wordToSentence }
  }, [sentences])

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

  // Reading timer — load today's total, tick while a story is open and the tab
  // is visible, and persist the running total periodically and on unmount.
  useEffect(() => {
    db.reading.get(readDayRef.current).then((r) => setReadBaseSecs(r?.seconds ?? 0))
  }, [])
  const storyOpen = !!story
  useEffect(() => {
    if (!storyOpen) return
    const id = setInterval(() => {
      if (!document.hidden) setSessionSecs((s) => s + 1)
    }, 1000)
    return () => clearInterval(id)
  }, [storyOpen])
  useEffect(() => {
    const flush = () => {
      if (sessRef.current > 0) {
        db.reading.put({ day: readDayRef.current, seconds: baseRef.current + sessRef.current })
      }
    }
    const onHide = () => document.hidden && flush()
    const id = setInterval(flush, 15000)
    document.addEventListener('visibilitychange', onHide)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', onHide)
      flush()
    }
  }, [])
  useEffect(() => {
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

  // "Only unlearned" needs at least one card that isn't marked known.
  const scopeEmpty = scope === 'learning' && cards.every((c) => c.known)

  async function run() {
    setLoading(true)
    setError('')
    try {
      const result = await generateStory({
        deck: deck!,
        // In 'learning' mode, don't seed the story with already-known words —
        // build it only from the ones still being learned.
        knownWords: scope === 'all' ? cards!.filter((c) => c.known).map((c) => c.word) : [],
        learningWords: cards!.filter((c) => !c.known).map((c) => c.word),
        newWordPercent: newPercent,
        topic: continuing ? undefined : topic || undefined,
        lengthWords: length,
        // Steer fresh stories away from themes already covered (recent first).
        avoidThemes: continuing
          ? undefined
          : (savedStories ?? []).slice(0, 8).map((s) => (s.topic ? `${s.title} (${s.topic})` : s.title)),
        continueFrom: continuing
          ? { title: continuing.title, story: continuing.story, direction: direction.trim() || undefined }
          : undefined,
      })
      const record: Omit<SavedStory, 'id'> = {
        deckId,
        title: result.title,
        story: result.story,
        translation: result.translation,
        glossary: result.glossary,
        topic: continuing ? undefined : topic.trim() || undefined,
        // Parts always attach to the thread's root, never to another part.
        parentId: continuing ? (continuing.parentId ?? continuing.id) : undefined,
        createdAt: Date.now(),
      }
      const id = await db.stories.add(record)
      setContinuing(null)
      setDirection('')
      openStory({ ...record, id })
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
    }
  }

  function openStory(s: SavedStory) {
    setStory(s)
    setShowTranslation(false)
    setSelected(null)
    // Land on the saved reading marker so "resume where I left off" is one tap.
    setActiveSentence(s.bookmark ?? null)
    setBaselineKeys(new Set((cards ?? []).map((c) => defKey(c.word))))
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
    const voices = await loadVoices()
    await speak(text, { voice: preferredVoice(voices, langCode), lang: langCode ?? undefined })
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
      setSelected({ word: display, meaning: rootCard.meaning, isNew: false, root: rootCard.word })
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
          ? { word: display, meaning: res.meaning, isNew: true }
          : sel,
      )
    } catch {
      setSelected((sel) =>
        sel?.loading && defKey(sel.word) === key ? { ...sel, loading: false, failed: true } : sel,
      )
    }
  }

  async function addWord(word: string, meaning: string, known = false) {
    await db.cards.add({
      deckId,
      word,
      meaning,
      example: '',
      ...newCardDefaults(),
      known,
    })
  }

  // Toggle the known flag on the deck card matching a tapped word.
  async function setWordKnown(word: string, known: boolean) {
    const card = (cards ?? []).find((c) => defKey(c.word) === defKey(word))
    if (card) await db.cards.update(card.id, { known })
  }

  // Words worth surfacing under the story. The glossary now holds EVERY word
  // (function words included), so require the model's content-word isNew flag —
  // otherwise "ke", "dan" etc. would flood the list — and still drop anything
  // already in the deck when the story was opened.
  const newWords = (story?.glossary ?? []).filter((g) => {
    if (!g.isNew) return false
    // Drop words whose surface form OR morphological root was already in the
    // bank when the story opened (e.g. "menjawab" when "jawab" is known).
    return !rootCandidates(defKey(g.word), langCode).some((c) => baselineKeys.has(c))
  })

  // Header stats for the open story. "new" counts the distinct highlighted
  // words (those not in the deck) straight from the text, so it always matches
  // what's highlighted regardless of glossary completeness.
  const storyWords = story ? story.story.trim().split(/\s+/).filter(Boolean) : []
  const uniqueKeys = new Set(storyWords.map(defKey).filter(Boolean))
  const stats = {
    words: storyWords.length,
    unique: uniqueKeys.size,
    newWords: [...uniqueKeys].filter((k) => isNewWord(k)).length,
    readMin: Math.max(1, Math.round(storyWords.length / 130)),
  }

  const selectedCard = selected
    ? (cards ?? []).find((c) => defKey(c.word) === defKey(selected.word))
    : undefined
  const selectedInDeck = !!selectedCard

  return (
    <>
      <div className="page-head">
        <h1>Story</h1>
        <span className="sub">
          {deck.name} · built from your {cards.length} {cards.length === 1 ? 'word' : 'words'}
        </span>
        <span className="read-timer" title="Time spent reading stories today">
          ⏱ {formatDuration(readBaseSecs + sessionSecs)} today
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
              Tap any word in the result for its meaning.
            </p>
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
                onClick={run}
                disabled={loading || cards.length === 0 || scopeEmpty}
              >
                {loading ? 'Writing…' : continuing ? 'Continue story' : 'Generate story'}
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
                  {parts.map((p, i) => (
                    <div className="story-saved-row story-part-row" key={p.id}>
                      <button className="story-saved-open" onClick={() => openStory(p)}>
                        <span className="story-saved-title">
                          <span className="story-part-label">Part {i + 2}</span> {p.title}
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
          <h2 className="story-title">{story.title}</h2>
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

          <div className="story-read-bar">
            {canRead && (
              <div className="story-play-group">
                <button
                  className="btn small ghost"
                  onClick={() => skip(-1)}
                  title="Previous sentence"
                  disabled={(activeSentence ?? 0) <= 0}
                >
                  ⏮
                </button>
                <button
                  className={`btn small${reading ? ' accent' : ' primary'}`}
                  onClick={toggleReading}
                  title={reading ? 'Pause reading' : 'Read the story aloud'}
                >
                  {reading ? '⏸ Pause' : activeSentence != null ? '▶ Resume' : '🔊 Read aloud'}
                </button>
                <button
                  className="btn small ghost"
                  onClick={() => skip(1)}
                  title="Next sentence"
                  disabled={(activeSentence ?? 0) >= sentences.length - 1}
                >
                  ⏭
                </button>
                <button
                  className="btn small ghost"
                  onClick={() => readAloud(0)}
                  title="Play the whole story from the start — with lock-screen and headphone controls, so it keeps going with the screen off"
                >
                  🎧 Podcast
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
              {marking ? '✕ Tap a word' : story.bookmark != null ? '🔖 Move marker' : '🔖 Mark spot'}
            </button>
            {!marking && story.bookmark != null && (
              <>
                <button className="btn small ghost" onClick={jumpToBookmark} title="Go to your marker">
                  ↩ Go to marker
                </button>
                <button
                  className="btn small ghost"
                  onClick={() => setBookmark(undefined)}
                  title="Remove the reading marker"
                >
                  ✕
                </button>
              </>
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

          {marking && (
            <p className="note story-mark-hint">Tap the word in the story where you stopped reading.</p>
          )}
          <div
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
                  // Highlight straight from deck membership so ANY word not in
                  // the bank is orange — even ones the glossary missed. Deck
                  // words (known or learning) read as plain, tappable text.
                  const cls = isNewWord(defKey(t.tok)) ? ' new-word' : ' plain'
                  return (
                    <span key={ti} className={marked ? 'story-marked-word' : undefined}>
                      {marked && (
                        <span className="story-bookmark-marker" aria-hidden="true">
                          🔖
                        </span>
                      )}
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
                        {t.tok}
                      </button>
                    </span>
                  )
                })}
              </span>
            ))}
          </div>
          {showTranslation && <div className="story-translation">{story.translation}</div>}
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
                    <em>{w.meaning}</em>
                    {deckKeys.has(defKey(w.word)) ? (
                      <b className="chip-added">✓</b>
                    ) : (
                      <button
                        className="add-word"
                        title={`Add “${w.word}” to the deck`}
                        onClick={() => addWord(w.word, w.meaning)}
                      >
                        +
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
                  🔊
                </button>
              )}
              {selected.isNew && !selectedInDeck && !selected.loading && !selected.failed && (
                <span className="state-pill new">new</span>
              )}
              {selected.root && (
                <span className="state-pill root" title={`Form of “${selected.root}”, in your deck`}>
                  form of {selected.root}
                </span>
              )}
            </div>
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
                  <span className="s-tag added">{selectedCard.known ? 'Known ✓' : 'In deck ✓'}</span>
                  <button
                    className="btn small"
                    onClick={() => setWordKnown(selected.word, !selectedCard.known)}
                  >
                    {selectedCard.known ? 'Unmark known' : 'Mark as known'}
                  </button>
                </>
              ) : (
                <>
                  <button
                    className="btn small primary"
                    disabled={!selected.meaning}
                    onClick={() => addWord(selected.word, selected.meaning)}
                  >
                    Add to deck
                  </button>
                  <button
                    className="btn small"
                    disabled={!selected.meaning}
                    title="Add to the deck already marked as known"
                    onClick={() => addWord(selected.word, selected.meaning, true)}
                  >
                    Add as known
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

