import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, newCardDefaults, type SavedStory } from '../db'
import { generateStory, ApiError } from '../ai'

interface Props {
  deckId: number
  onExit: () => void
}

interface Definition {
  word: string
  meaning: string
  isNew: boolean
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
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [story, setStory] = useState<SavedStory | null>(null)
  const [showTranslation, setShowTranslation] = useState(false)
  const [selected, setSelected] = useState<Definition | null>(null)
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
  const defs = useMemo(() => {
    const map = new Map<string, Definition>()
    for (const c of cards ?? []) {
      map.set(defKey(c.word), { word: c.word, meaning: c.meaning, isNew: false })
    }
    for (const g of story?.glossary ?? []) {
      const key = defKey(g.word)
      map.set(key, { word: g.word, meaning: g.meaning, isNew: !deckKeys.has(key) })
    }
    return map
  }, [cards, story, deckKeys])

  if (!deck || !cards) return null

  async function run() {
    setLoading(true)
    setError('')
    try {
      const result = await generateStory({
        deck: deck!,
        knownWords: cards!.filter((c) => c.known).map((c) => c.word),
        learningWords: cards!.filter((c) => !c.known).map((c) => c.word),
        newWordPercent: newPercent,
        topic: topic || undefined,
        lengthWords: length,
      })
      const record: Omit<SavedStory, 'id'> = {
        deckId,
        title: result.title,
        story: result.story,
        translation: result.translation,
        glossary: result.glossary,
        topic: topic.trim() || undefined,
        createdAt: Date.now(),
      }
      const id = await db.stories.add(record)
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
    await db.stories.delete(id)
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

  // Words worth surfacing under the story: flagged new by the model, or outside
  // the deck when the story was opened (the model's isNew flag alone is unreliable).
  const newWords = (story?.glossary ?? []).filter(
    (g) => g.isNew || !baselineKeys.has(defKey(g.word)),
  )

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
              Writes a casual, everyday {deck.language} story leaning on the words you know and
              weaving in the ones you're learning. Tap any word in the result for its meaning.
            </p>
            {error && <p className="note error-note">{error}</p>}
            <div className="story-form-actions">
              <button className="btn ghost" onClick={onExit}>
                Cancel
              </button>
              <button className="btn accent" onClick={run} disabled={loading || cards.length === 0}>
                {loading ? 'Writing…' : 'Generate story'}
              </button>
            </div>
          </div>

          {savedStories && savedStories.length > 0 && (
            <div className="story-saved">
              <div className="eyebrow">Saved stories</div>
              {savedStories.map((s) => (
                <div className="story-saved-row" key={s.id}>
                  <button className="story-saved-open" onClick={() => openStory(s)}>
                    <span className="story-saved-title">{s.title}</span>
                    <span className="story-saved-meta">
                      {s.topic ? `${s.topic} · ` : ''}
                      {new Date(s.createdAt).toLocaleDateString()}
                    </span>
                  </button>
                  <button
                    className="btn ghost small"
                    title="Delete this story"
                    onClick={() => deleteStory(s.id)}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <div className="story-page">
          <h2 className="story-title">{story.title}</h2>
          <div className="story-body">
            <TappableText text={story.story} defs={defs} onTap={setSelected} />
          </div>
          {showTranslation && <div className="story-translation">{story.translation}</div>}
          <div className="story-toolbar">
            <button className="btn ghost small" onClick={() => setShowTranslation((s) => !s)}>
              {showTranslation ? 'Hide translation' : 'Show translation'}
            </button>
            <button className="btn ghost small" onClick={() => setStory(null)}>
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
              {!selectedInDeck && <span className="state-pill new">new</span>}
            </div>
            <div className="word-sheet-meaning">{selected.meaning}</div>
            <div className="word-sheet-actions">
              {selectedInDeck ? (
                <span className="s-tag added">In deck ✓</span>
              ) : (
                <button
                  className="btn small primary"
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
  onTap: (d: Definition) => void
}) {
  // Split into word / non-word chunks; keep whitespace and punctuation as-is.
  const tokens = text.split(/(\s+)/)
  return (
    <>
      {tokens.map((token, i) => {
        const def = defs.get(defKey(token))
        if (!def) return <span key={i}>{token}</span>
        return (
          <button key={i} className="story-word" onClick={() => onTap(def)}>
            {token}
          </button>
        )
      })}
    </>
  )
}
