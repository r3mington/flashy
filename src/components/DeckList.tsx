import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db'
import { langCodeFor } from '../speech'
import { countWords } from '../text'

interface Props {
  onOpen: (deckId: number) => void
  /** Open a saved story directly (the "continue reading" shortcut). */
  onOpenStory: (deckId: number, storyId: number) => void
}

export function DeckList({ onOpen, onOpenStory }: Props) {
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [language, setLanguage] = useState('Bahasa Indonesia')

  const decks = useLiveQuery(() => db.decks.toArray())
  const stats = useLiveQuery(async () => {
    const now = Date.now()
    const cards = await db.cards.toArray()
    const byDeck = new Map<number, { total: number; due: number }>()
    for (const c of cards) {
      const s = byDeck.get(c.deckId) ?? { total: 0, due: 0 }
      s.total += 1
      if (c.due <= now && !c.known) s.due += 1
      byDeck.set(c.deckId, s)
    }
    return byDeck
  })

  // Most recently read (or generated — generation opens the story) story,
  // for the one-tap "continue reading" shortcut. Resumes at the marker.
  const lastRead = useLiveQuery(async () => {
    const stories = await db.stories.toArray()
    if (stories.length === 0) return null
    const recency = (s: (typeof stories)[number]) => s.lastOpenedAt ?? s.createdAt
    const story = stories.reduce((a, b) => (recency(a) >= recency(b) ? a : b))
    const deck = await db.decks.get(story.deckId)
    if (!deck) return null
    const pct =
      story.bookmark != null
        ? Math.min(
            100,
            Math.round(((story.bookmark + 1) / Math.max(1, countWords(story.story, langCodeFor(deck.language)))) * 100),
          )
        : null
    return { story, deck, pct }
  })

  async function createDeck() {
    const trimmed = name.trim()
    if (!trimmed) return
    const id = await db.decks.add({
      name: trimmed,
      language: language.trim() || 'Unknown',
      createdAt: Date.now(),
    })
    setCreating(false)
    setName('')
    onOpen(id)
  }

  if (!decks) return null

  return (
    <>
      <div className="page-head">
        <h1>Decks</h1>
        <span className="sub">
          {decks.length === 0 ? '' : `${decks.length} ${decks.length === 1 ? 'deck' : 'decks'}`}
        </span>
        <div className="actions">
          <button className="btn primary" onClick={() => setCreating(true)}>
            New deck
          </button>
        </div>
      </div>

      {lastRead && (
        <button
          className="continue-reading"
          title="Pick up where you left off — opens at your reading marker"
          onClick={() => onOpenStory(lastRead.story.deckId, lastRead.story.id)}
        >
          <span className="cr-label">📖 Continue reading</span>
          <span className="cr-title">{lastRead.story.title}</span>
          <span className="cr-meta">
            {lastRead.deck.name}
            {lastRead.pct != null ? ` · ${lastRead.pct}% read` : ''}
          </span>
          {lastRead.pct != null && (
            <span className="cr-bar">
              <span style={{ width: `${lastRead.pct}%` }} />
            </span>
          )}
        </button>
      )}

      {decks.length === 0 ? (
        <div className="empty">
          No decks yet. Create one to start collecting words.
          <br />
          <button className="btn primary" onClick={() => setCreating(true)}>
            Create your first deck
          </button>
        </div>
      ) : (
        <div className="deck-grid">
          {decks.map((deck) => {
            const s = stats?.get(deck.id)
            return (
              <button key={deck.id} className="deck-card" onClick={() => onOpen(deck.id)}>
                <span className="name">{deck.name}</span>
                <span className="lang">{deck.language}</span>
                <span className="counts">
                  <span>{s?.total ?? 0} cards</span>
                  {s && s.due > 0 && <span className="due-badge">{s.due} due</span>}
                </span>
              </button>
            )
          })}
        </div>
      )}

      {creating && (
        <div className="overlay" onClick={() => setCreating(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>New deck</h2>
            <div className="field">
              <label htmlFor="deck-name">Name</label>
              <input
                id="deck-name"
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && createDeck()}
                placeholder="e.g. Everyday verbs"
              />
            </div>
            <div className="field">
              <label htmlFor="deck-lang">Language</label>
              <input
                id="deck-lang"
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && createDeck()}
              />
            </div>
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setCreating(false)}>
                Cancel
              </button>
              <button className="btn primary" onClick={createDeck} disabled={!name.trim()}>
                Create
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
