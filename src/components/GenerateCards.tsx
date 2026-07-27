import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, newCardDefaults, type Deck } from '../db'
import { generateCards, ApiError, type Suggestion } from '../ai'

interface Props {
  deck: Deck
  onClose: () => void
}

type SuggestionState = 'pending' | 'added' | 'blacklisted'

export function GenerateCards({ deck, onClose }: Props) {
  const [topic, setTopic] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null)
  const [states, setStates] = useState<SuggestionState[]>([])

  const existing = useLiveQuery(
    () => db.cards.where('deckId').equals(deck.id).toArray(),
    [deck.id],
  )
  const blacklist = useLiveQuery(
    () => db.blacklist.where('deckId').equals(deck.id).toArray(),
    [deck.id],
  )

  async function run() {
    setLoading(true)
    setError('')
    try {
      const cards = await generateCards({
        deck,
        existingWords: (existing ?? []).map((c) => c.word),
        blacklistedWords: (blacklist ?? []).map((b) => b.word),
        topic: topic || undefined,
      })
      setSuggestions(cards)
      setStates(cards.map(() => 'pending'))
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

  async function add(i: number) {
    const s = suggestions![i]
    await db.cards.add({
      deckId: deck.id,
      word: s.word,
      meaning: s.meaning,
      example: s.example,
      exampleTranslation: s.exampleTranslation || undefined,
      emoji: s.emoji?.trim() || undefined,
      roman: s.roman?.trim() || undefined,
      ...newCardDefaults(),
    })
    setStates((prev) => prev.map((st, j) => (j === i ? 'added' : st)))
  }

  async function blacklistWord(i: number) {
    const s = suggestions![i]
    await db.blacklist.add({ deckId: deck.id, word: s.word, createdAt: Date.now() })
    setStates((prev) => prev.map((st, j) => (j === i ? 'blacklisted' : st)))
  }

  async function addAllPending() {
    for (let i = 0; i < suggestions!.length; i++) {
      if (states[i] === 'pending') await add(i)
    }
  }

  const pendingCount = states.filter((s) => s === 'pending').length

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h2>Suggest cards</h2>

        {suggestions === null ? (
          <>
            <div className="field">
              <label htmlFor="gen-topic">Topic (optional)</label>
              <input
                id="gen-topic"
                autoFocus
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && !loading && run()}
                placeholder="e.g. going to the restaurant"
              />
            </div>
            <p className="note">
              Suggests 20 new {deck.language} words with example sentences, skipping words
              already in your deck and blacklisted words.
            </p>
            {error && <p className="note error-note">{error}</p>}
            <div className="modal-actions">
              <button className="btn ghost" onClick={onClose}>
                Cancel
              </button>
              <button className="btn accent" onClick={run} disabled={loading}>
                {loading ? 'Thinking…' : 'Generate 20 cards'}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="note" style={{ marginTop: 0 }}>
              {topic ? `Topic: “${topic}” · ` : ''}
              Add the ones you want, or blacklist words you never want suggested again.
            </p>
            <div className="suggestion-list">
              {suggestions.map((s, i) => (
                <div
                  key={i}
                  className={`suggestion${states[i] !== 'pending' ? ` ${states[i]}` : ''}`}
                  style={{ animationDelay: `${Math.min(i, 12) * 30}ms` }}
                >
                  <div className="s-main">
                    <div className="word">
                      {s.word}
                      {s.roman?.trim() && <span className="s-roman"> {s.roman.trim()}</span>}{' '}
                      <span className="s-meaning">— {s.meaning}</span>
                    </div>
                    <div className="example">{s.example}</div>
                    {s.exampleTranslation && (
                      <div className="s-translation">{s.exampleTranslation}</div>
                    )}
                  </div>
                  <div className="s-actions">
                    {states[i] === 'pending' ? (
                      <>
                        <button className="btn small primary" onClick={() => add(i)}>
                          Add
                        </button>
                        <button
                          className="btn small ghost danger"
                          title="Never suggest this word again"
                          onClick={() => blacklistWord(i)}
                        >
                          Blacklist
                        </button>
                      </>
                    ) : (
                      <span className={`s-tag ${states[i]}`}>
                        {states[i] === 'added' ? 'Added ✓' : 'Blacklisted'}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <div className="modal-actions">
              <button
                className="btn ghost left"
                onClick={() => {
                  setSuggestions(null)
                  setStates([])
                }}
              >
                ← New generation
              </button>
              {pendingCount > 0 && (
                <button className="btn" onClick={addAllPending}>
                  Add all remaining ({pendingCount})
                </button>
              )}
              <button className="btn primary" onClick={onClose}>
                Done
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
