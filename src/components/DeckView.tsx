import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, type Card } from '../db'
import { CardEditor } from './CardEditor'
import { ImportCsv } from './ImportCsv'
import { GenerateCards } from './GenerateCards'
import { generateEmojis } from '../ai'
import {
  langCodeFor,
  loadVoices,
  preferredVoice,
  speak,
  speechSupported,
  stopSpeaking,
} from '../speech'

interface Props {
  deckId: number
  onStudySrs: () => void
  onStudyFlip: () => void
  onStory: () => void
  onListen: () => void
  onDeleted: () => void
}

type StateFilter = 'all' | 'new' | 'learning' | 'review' | 'known'

const FILTER_DEFS: { key: StateFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'new', label: 'New' },
  { key: 'learning', label: 'Learning' },
  { key: 'review', label: 'Review' },
  { key: 'known', label: 'Known' },
]

export function DeckView({ deckId, onStudySrs, onStudyFlip, onStory, onListen, onDeleted }: Props) {
  const [search, setSearch] = useState('')
  const [stateFilter, setStateFilter] = useState<StateFilter>('all')
  const [editing, setEditing] = useState<Card | 'new' | null>(null)
  const [importing, setImporting] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [editingDeck, setEditingDeck] = useState(false)
  const [deckName, setDeckName] = useState('')
  const [deckLang, setDeckLang] = useState('')
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [emojiLoading, setEmojiLoading] = useState(false)

  const deck = useLiveQuery(() => db.decks.get(deckId), [deckId])
  const cards = useLiveQuery(() => db.cards.where('deckId').equals(deckId).toArray(), [deckId])

  // Stop any pronunciation when leaving the deck view.
  useEffect(() => () => stopSpeaking(), [])

  if (!deck || !cards) return null

  const langCode = langCodeFor(deck.language)
  const canSpeak = speechSupported && !!langCode

  async function speakWord(word: string) {
    stopSpeaking()
    const voices = await loadVoices()
    await speak(word, {
      voice: preferredVoice(voices, langCode),
      lang: langCode ?? undefined,
    })
  }

  const now = Date.now()
  const due = cards.filter((c) => c.due <= now && !c.known).length

  const counts: Record<StateFilter, number> = {
    all: cards.length,
    new: cards.filter((c) => !c.known && c.state === 'new').length,
    learning: cards.filter((c) => !c.known && c.state === 'learning').length,
    review: cards.filter((c) => !c.known && c.state === 'review').length,
    known: cards.filter((c) => c.known).length,
  }

  const byState =
    stateFilter === 'all'
      ? cards
      : stateFilter === 'known'
        ? cards.filter((c) => c.known)
        : cards.filter((c) => !c.known && c.state === stateFilter)

  const q = search.trim().toLowerCase()
  const filtered = q
    ? byState.filter(
        (c) =>
          c.word.toLowerCase().includes(q) ||
          c.meaning.toLowerCase().includes(q) ||
          c.example.toLowerCase().includes(q),
      )
    : byState

  async function deleteDeck() {
    if (!confirm(`Delete deck “${deck!.name}” and its ${cards!.length} cards? This cannot be undone.`))
      return
    await db.cards.where('deckId').equals(deckId).delete()
    await db.reviews.where('deckId').equals(deckId).delete()
    await db.blacklist.where('deckId').equals(deckId).delete()
    await db.decks.delete(deckId)
    onDeleted()
  }

  async function deleteCard(card: Card) {
    if (!confirm(`Delete “${card.word}”?`)) return
    await db.cards.delete(card.id)
    await db.reviews.where('cardId').equals(card.id).delete()
    setSelected((prev) => {
      const next = new Set(prev)
      next.delete(card.id)
      return next
    })
  }

  function toggleSelect(id: number) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const allVisibleSelected = filtered.length > 0 && filtered.every((c) => selected.has(c.id))
  const everySelectedKnown =
    selected.size > 0 && cards.filter((c) => selected.has(c.id)).every((c) => c.known)

  function toggleSelectAll() {
    setSelected(allVisibleSelected ? new Set() : new Set(filtered.map((c) => c.id)))
  }

  const selectedIds = () => [...selected]

  async function setKnown(ids: number[], known: boolean) {
    await db.cards.where('id').anyOf(ids).modify({ known })
  }

  async function resetStats(ids: number[]) {
    if (
      !confirm(
        `Reset study stats for ${ids.length} ${ids.length === 1 ? 'card' : 'cards'}? They go back to “new” and their review history is cleared.`,
      )
    )
      return
    await db.cards.where('id').anyOf(ids).modify({
      state: 'new',
      due: Date.now(),
      interval: 0,
      ease: 2.5,
      reps: 0,
      lapses: 0,
    })
    await db.reviews.where('cardId').anyOf(ids).delete()
  }

  async function deleteMany(ids: number[]) {
    if (!confirm(`Delete ${ids.length} ${ids.length === 1 ? 'card' : 'cards'}? This cannot be undone.`))
      return
    await db.cards.bulkDelete(ids)
    await db.reviews.where('cardId').anyOf(ids).delete()
    setSelected(new Set())
  }

  async function fillEmojis() {
    const missing = cards!.filter((c) => !c.emoji)
    if (missing.length === 0) return
    setEmojiLoading(true)
    try {
      const map = await generateEmojis(
        deck!,
        missing.map((c) => ({ word: c.word, meaning: c.meaning })),
      )
      for (const c of missing) {
        const emoji = map.get(c.word.trim().toLowerCase())
        if (emoji) await db.cards.update(c.id, { emoji })
      }
    } catch (e) {
      alert((e instanceof Error && e.message) || 'Emoji generation failed. Please try again.')
    } finally {
      setEmojiLoading(false)
    }
  }

  async function saveDeck() {
    if (!deckName.trim()) return
    await db.decks.update(deckId, {
      name: deckName.trim(),
      language: deckLang.trim() || deck!.language,
    })
    setEditingDeck(false)
  }

  return (
    <>
      <div className="page-head">
        <h1>{deck.name}</h1>
        <span className="sub">
          {deck.language} · {cards.length} cards{due > 0 ? ` · ${due} due` : ''}
        </span>
        <div className="actions">
          <button
            className="btn ghost small"
            onClick={() => {
              setDeckName(deck.name)
              setDeckLang(deck.language)
              setEditingDeck(true)
            }}
          >
            Edit deck
          </button>
          <button className="btn danger ghost small" onClick={deleteDeck}>
            Delete
          </button>
        </div>
      </div>

      <div className="mode-row">
        <button className="btn accent" onClick={onStudySrs} disabled={cards.length === 0}>
          Review {due > 0 ? `(${due})` : ''}
        </button>
        <button className="btn" onClick={onStudyFlip} disabled={cards.length === 0}>
          Flip through
        </button>
        <button className="btn" onClick={onListen} disabled={cards.length === 0}>
          🔊 Listen
        </button>
      </div>

      <div className="toolbar">
        <input
          className="search"
          placeholder="Search cards…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button className="btn" onClick={() => setGenerating(true)}>
          ✦ Suggest
        </button>
        <button className="btn" onClick={onStory} disabled={cards.length === 0}>
          ✦ Story
        </button>
        {cards.some((c) => !c.emoji) && (
          <button
            className="btn"
            title="AI-pick a mnemonic emoji for every card that doesn't have one"
            onClick={fillEmojis}
            disabled={emojiLoading}
          >
            {emojiLoading ? 'Picking…' : '✦ Emoji'}
          </button>
        )}
        <button className="btn" onClick={() => setImporting(true)}>
          Import CSV
        </button>
        <button className="btn primary" onClick={() => setEditing('new')}>
          Add card
        </button>
      </div>

      {cards.length > 0 && (
        <div className="filter-chips">
          {FILTER_DEFS.filter(
            (f) => f.key === 'all' || f.key === stateFilter || counts[f.key] > 0,
          ).map((f) => (
            <button
              key={f.key}
              className={`filter-chip${stateFilter === f.key ? ' active' : ''}`}
              onClick={() => setStateFilter(f.key)}
            >
              {f.label}
              <span className="filter-chip-count">{counts[f.key]}</span>
            </button>
          ))}
        </div>
      )}

      {selected.size > 0 && (
        <div className="bulk-bar">
          <label className="check-wrap" title="Select all visible">
            <input type="checkbox" checked={allVisibleSelected} onChange={toggleSelectAll} />
          </label>
          <span className="bulk-count">{selected.size} selected</span>
          <div className="bulk-actions">
            <button
              className="btn small"
              onClick={() => setKnown(selectedIds(), !everySelectedKnown)}
            >
              {everySelectedKnown ? 'Unmark known' : 'Mark as known'}
            </button>
            <button className="btn small" onClick={() => resetStats(selectedIds())}>
              Reset stats
            </button>
            <button className="btn small danger" onClick={() => deleteMany(selectedIds())}>
              Delete
            </button>
            <button className="btn small ghost" onClick={() => setSelected(new Set())}>
              Clear
            </button>
          </div>
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="empty">
          {cards.length === 0
            ? 'No cards yet. Add one by hand, import a CSV, or let AI suggest some.'
            : 'No cards match the current filter.'}
        </div>
      ) : (
        <div className="card-list">
          <label className="select-all-row check-wrap">
            <input type="checkbox" checked={allVisibleSelected} onChange={toggleSelectAll} />
            <span>
              Select all{q || stateFilter !== 'all' ? ' shown' : ''} ({filtered.length})
            </span>
          </label>
          {filtered.map((card, i) => (
            <div
              className={`card-row${selected.has(card.id) ? ' selected' : ''}${card.known ? ' is-known' : ''}`}
              key={card.id}
              style={{ animationDelay: `${Math.min(i, 12) * 25}ms` }}
            >
              <label className="check-wrap row-check">
                <input
                  type="checkbox"
                  checked={selected.has(card.id)}
                  onChange={() => toggleSelect(card.id)}
                />
              </label>
              <div className="card-body">
                <div className="word">
                  {card.emoji && <span className="row-emoji">{card.emoji}</span>}
                  {card.word}
                  {canSpeak && (
                    <button
                      className="speak-btn"
                      title="Pronounce"
                      aria-label={`Pronounce ${card.word}`}
                      onClick={() => speakWord(card.word)}
                    >
                      🔊
                    </button>
                  )}
                  {card.known ? (
                    <span className="state-pill known">known</span>
                  ) : (
                    <span className={`state-pill ${card.state}`}>{card.state}</span>
                  )}
                </div>
                <div className="meaning">{card.meaning}</div>
                {card.example && <div className="example">{card.example}</div>}
              </div>
              <div className="row-actions">
                <button className="btn ghost small" onClick={() => setEditing(card)}>
                  Edit
                </button>
                <button
                  className="btn ghost small"
                  title={card.known ? 'Include in study again' : 'Exclude from study'}
                  onClick={() => setKnown([card.id], !card.known)}
                >
                  {card.known ? 'Unknown' : 'Known'}
                </button>
                <button
                  className="btn ghost small"
                  title="Back to new, clear review history"
                  onClick={() => resetStats([card.id])}
                >
                  Reset
                </button>
                <button className="btn ghost small danger" onClick={() => deleteCard(card)}>
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <CardEditor
          deckId={deckId}
          card={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      )}
      {importing && <ImportCsv deckId={deckId} onClose={() => setImporting(false)} />}
      {generating && <GenerateCards deck={deck} onClose={() => setGenerating(false)} />}

      {editingDeck && (
        <div className="overlay" onClick={() => setEditingDeck(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Edit deck</h2>
            <div className="field">
              <label htmlFor="edit-deck-name">Name</label>
              <input
                id="edit-deck-name"
                autoFocus
                value={deckName}
                onChange={(e) => setDeckName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && saveDeck()}
              />
            </div>
            <div className="field">
              <label htmlFor="edit-deck-lang">Language</label>
              <input
                id="edit-deck-lang"
                value={deckLang}
                onChange={(e) => setDeckLang(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && saveDeck()}
              />
            </div>
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setEditingDeck(false)}>
                Cancel
              </button>
              <button className="btn primary" onClick={saveDeck} disabled={!deckName.trim()}>
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
