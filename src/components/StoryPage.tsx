import { useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, newCardDefaults, type SavedStory } from '../db'
import { generateStory, ApiError } from '../ai'
import { langCodeFor, loadVoices, preferredVoice, speak, speechSupported, stopSpeaking } from '../speech'

/** Split text into sentences, keeping terminators and trailing space so the
 *  pieces re-join into the original. Works for . ! ? … across scripts. */
function splitSentences(text: string): string[] {
  return text.match(/[^.!?…]+[.!?…]*\s*/gu) ?? (text.trim() ? [text] : [])
}

interface Props {
  deckId: number
  onExit: () => void
}

interface Definition {
  word: string
  meaning: string
  isNew: boolean
  /** Word absent from this story's glossary (stories saved before full glossaries). */
  missing?: boolean
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
  // Read-aloud state. The play loop reads live rate/voice through refs and an
  // incremented run id cancels a superseded loop.
  const [reading, setReading] = useState(false)
  const [activeSentence, setActiveSentence] = useState<number | null>(null)
  const [rate, setRate] = useState(0.9)
  const runRef = useRef(0)
  const rateRef = useRef(rate)
  rateRef.current = rate
  const sentenceRefs = useRef<(HTMLSpanElement | null)[]>([])
  // Deck words at the moment the story was opened — keeps the "new words" chip
  // list stable while words are added (added ones show a ✓ instead of vanishing).
  const [baselineKeys, setBaselineKeys] = useState<Set<string>>(new Set())

  const deck = useLiveQuery(() => db.decks.get(deckId), [deckId])
  const cards = useLiveQuery(() => db.cards.where('deckId').equals(deckId).toArray(), [deckId])
  const savedStories = useLiveQuery(
    () => db.stories.where('deckId').equals(deckId).reverse().sortBy('createdAt'),
    [deckId],
  )

  // Words already in the deck. Whether a story word is "new" (offer to add it)
  // is decided against this set — not the model's isNew flag, which is unreliable.
  const deckKeys = useMemo(
    () => new Set((cards ?? []).map((c) => defKey(c.word))),
    [cards],
  )

  // Tap-to-define lookup: glossary from the model, plus the word bank as fallback.
  // The glossary now holds every word (function words included), so a word counts
  // as "new" only when the model flagged it a new content word AND it isn't
  // already in the deck — otherwise every "the/and/to" would light up.
  const defs = useMemo(() => {
    const map = new Map<string, Definition>()
    for (const c of cards ?? []) {
      map.set(defKey(c.word), { word: c.word, meaning: c.meaning, isNew: false })
    }
    for (const g of story?.glossary ?? []) {
      const key = defKey(g.word)
      map.set(key, { word: g.word, meaning: g.meaning, isNew: g.isNew && !deckKeys.has(key) })
    }
    return map
  }, [cards, story, deckKeys])

  // Sentences of the open story — the read-aloud unit and highlight granularity.
  const sentences = useMemo(() => (story ? splitSentences(story.story) : []), [story])
  const langCode = deck ? langCodeFor(deck.language) : null
  const canRead = speechSupported && !!story

  // Stop audio when leaving the page or switching stories.
  useEffect(
    () => () => {
      runRef.current++
      stopSpeaking()
    },
    [],
  )
  useEffect(() => {
    // A new story (or list view) cancels any in-progress reading.
    runRef.current++
    stopSpeaking()
    setReading(false)
    setActiveSentence(null)
  }, [story])
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
          ? { title: continuing.title, story: continuing.story }
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
  async function readAloud(startIdx: number) {
    const my = ++runRef.current
    stopSpeaking()
    setReading(true)
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
    }
  }

  function pauseReading() {
    runRef.current++
    stopSpeaking()
    setReading(false) // keep activeSentence so play resumes from here
  }

  function toggleReading() {
    if (reading) pauseReading()
    else readAloud(activeSentence ?? 0)
  }

  // Tap any word: definition comes from the story's glossary (or the deck) —
  // instant, fully offline, no AI call.
  function lookup(token: string) {
    const key = defKey(token)
    if (!key) return
    const def = defs.get(key)
    if (def) {
      setSelected(def)
      return
    }
    const display = token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    setSelected({ word: display, meaning: '', isNew: !deckKeys.has(key), missing: true })
  }

  async function addWord(word: string, meaning: string) {
    await db.cards.add({
      deckId,
      word,
      meaning,
      example: '',
      ...newCardDefaults(),
    })
  }

  // Words worth surfacing under the story. The glossary now holds EVERY word
  // (function words included), so require the model's content-word isNew flag —
  // otherwise "ke", "dan" etc. would flood the list — and still drop anything
  // already in the deck when the story was opened.
  const newWords = (story?.glossary ?? []).filter(
    (g) => g.isNew && !baselineKeys.has(defKey(g.word)),
  )

  // Header stats for the open story. New count is genuine new vocabulary
  // (content words flagged by the model that aren't already in the deck).
  const storyWords = story ? story.story.trim().split(/\s+/).filter(Boolean) : []
  const stats = {
    words: storyWords.length,
    unique: new Set(storyWords.map(defKey).filter(Boolean)).size,
    newWords: (story?.glossary ?? []).filter((g) => g.isNew && !deckKeys.has(defKey(g.word))).length,
    readMin: Math.max(1, Math.round(storyWords.length / 130)),
  }

  const selectedInDeck = selected ? deckKeys.has(defKey(selected.word)) : false

  return (
    <>
      <div className="page-head">
        <h1>Story</h1>
        <span className="sub">
          {deck.name} · built from your {cards.length} {cards.length === 1 ? 'word' : 'words'}
        </span>
      </div>

      {story === null ? (
        <>
          <div className="story-form">
            {continuing ? (
              <div className="continue-banner">
                <span>
                  Continuing <b>“{continuing.title}”</b>
                </span>
                <button
                  className="btn ghost small"
                  title="Start a fresh story instead"
                  onClick={() => setContinuing(null)}
                >
                  ✕
                </button>
              </div>
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
                max={500}
                step={25}
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
                max={50}
                step={5}
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
              <span className="story-stat-new" title="Words new to you, highlighted below">
                {stats.newWords} new
              </span>
            )}
            <span title="Estimated time to read">~{stats.readMin} min read</span>
          </div>
          {canRead && (
            <div className="story-read-bar">
              <button
                className={`btn small${reading ? ' accent' : ' primary'}`}
                onClick={toggleReading}
                title={reading ? 'Pause reading' : 'Read the story aloud'}
              >
                {reading ? '⏸ Pause' : activeSentence != null ? '▶ Resume' : '🔊 Read aloud'}
              </button>
              {activeSentence != null && !reading && (
                <button
                  className="btn small ghost"
                  onClick={() => {
                    runRef.current++
                    stopSpeaking()
                    setActiveSentence(null)
                  }}
                  title="Stop and reset to the start"
                >
                  ⏹
                </button>
              )}
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
            </div>
          )}
          <div className="story-body">
            {sentences.map((s, i) => (
              <span
                key={i}
                ref={(el) => {
                  sentenceRefs.current[i] = el
                }}
                className={`story-sentence${i === activeSentence ? ' active' : ''}`}
              >
                <TappableText text={s} defs={defs} onTap={lookup} />
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
              {selected.isNew && !selected.missing && <span className="state-pill new">new</span>}
            </div>
            <div className="word-sheet-meaning">
              {selected.missing
                ? 'No definition in this story’s glossary — stories generated from now on include every word.'
                : selected.meaning}
            </div>
            <div className="word-sheet-actions">
              {selectedInDeck ? (
                <span className="s-tag added">In deck ✓</span>
              ) : (
                <button
                  className="btn small primary"
                  disabled={!selected.meaning}
                  onClick={() => addWord(selected.word, selected.meaning)}
                >
                  Add to deck
                </button>
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

function TappableText({
  text,
  defs,
  onTap,
}: {
  text: string
  defs: Map<string, Definition>
  onTap: (token: string) => void
}) {
  // Split into word / non-word chunks; keep whitespace and punctuation as-is.
  const tokens = text.split(/(\s+)/)
  return (
    <>
      {tokens.map((token, i) => {
        // Every token containing a letter/number is tappable.
        if (!defKey(token)) return <span key={i}>{token}</span>
        const def = defs.get(defKey(token))
        // In glossary → underlined; new vocabulary → highlighted; otherwise plain.
        const cls = def ? (def.isNew ? ' new-word' : '') : ' plain'
        return (
          <button key={i} className={`story-word${cls}`} onClick={() => onTap(token)}>
            {token}
          </button>
        )
      })}
    </>
  )
}
