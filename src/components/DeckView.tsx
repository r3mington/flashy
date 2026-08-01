import { useEffect, useState } from 'react'
import { useDeck } from '../useDeck'
import { db, inRotation, type Card } from '../db'
import { CardEditor } from './CardEditor'
import { ContinueReading } from './ContinueReading'
import { Icon } from './Icon'
import { ImportCsv } from './ImportCsv'
import { ExportCards } from './ExportCards'
import { GenerateCards } from './GenerateCards'
import { generateEmojis, generateExamples } from '../ai'
import {
  speakIn,
  speechSupported,
  stopSpeaking,
} from '../speech'

interface Props {
  deckId: number
  onStudySrs: () => void
  onStudyFlip: () => void
  onStory: () => void
  /** Jump straight into a saved story (the "continue reading" shortcut). */
  onOpenStory: (deckId: number, storyId: number) => void
  onListen: () => void
  onTranslate: () => void
  onDeleted: () => void
}

type StateFilter = 'all' | 'new' | 'learning' | 'review' | 'known' | 'ignored'
type SortBy = 'default' | 'lookups'

const FILTER_DEFS: { key: StateFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'new', label: 'New' },
  { key: 'learning', label: 'Learning' },
  { key: 'review', label: 'Review' },
  { key: 'known', label: 'Known' },
  { key: 'ignored', label: 'Ignored' },
]

/** How many cards one example-writing request covers. Sentences are a lot more
 *  output per word than emoji, so a big deck goes in batches. */
const EXAMPLE_BATCH = 25

export function DeckView({
  deckId,
  onStudySrs,
  onStudyFlip,
  onStory,
  onOpenStory,
  onListen,
  onTranslate,
  onDeleted,
}: Props) {
  const [search, setSearch] = useState('')
  const [stateFilter, setStateFilter] = useState<StateFilter>('all')
  const [sortBy, setSortBy] = useState<SortBy>('default')
  const [editing, setEditing] = useState<Card | 'new' | null>(null)
  const [importing, setImporting] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [editingDeck, setEditingDeck] = useState(false)
  const [deckName, setDeckName] = useState('')
  const [deckLang, setDeckLang] = useState('')
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [emojiLoading, setEmojiLoading] = useState(false)
  /** How far the example backfill has got, as `done/total`; null when idle. */
  const [exampleProgress, setExampleProgress] = useState<[number, number] | null>(null)

  const { deck, cards, langCode } = useDeck(deckId)

  // Stop any pronunciation when leaving the deck view.
  useEffect(() => () => stopSpeaking(), [])

  if (!deck || !cards) return null
  const canSpeak = speechSupported && !!langCode

  async function speakWord(word: string) {
    stopSpeaking()
    await speakIn(word, langCode)
  }

  const now = Date.now()
  const due = cards.filter((c) => c.due <= now && inRotation(c)).length

  const counts: Record<StateFilter, number> = {
    all: cards.length,
    new: cards.filter((c) => inRotation(c) && c.state === 'new').length,
    learning: cards.filter((c) => inRotation(c) && c.state === 'learning').length,
    review: cards.filter((c) => inRotation(c) && c.state === 'review').length,
    known: cards.filter((c) => c.known && !c.ignored).length,
    ignored: cards.filter((c) => c.ignored).length,
  }

  const byState =
    stateFilter === 'all'
      ? cards
      : stateFilter === 'known'
        ? cards.filter((c) => c.known && !c.ignored)
        : stateFilter === 'ignored'
          ? cards.filter((c) => c.ignored)
          : cards.filter((c) => inRotation(c) && c.state === stateFilter)

  const q = search.trim().toLowerCase()
  const matched = q
    ? byState.filter(
        (c) =>
          c.word.toLowerCase().includes(q) ||
          c.meaning.toLowerCase().includes(q) ||
          c.example.toLowerCase().includes(q),
      )
    : byState

  // "Most looked up" surfaces the words you kept tapping to define while
  // reading stories — the ones worth reviewing. Ties fall back to word order.
  const filtered =
    sortBy === 'lookups'
      ? [...matched].sort(
          (a, b) => (b.lookups ?? 0) - (a.lookups ?? 0) || a.word.localeCompare(b.word),
        )
      : matched

  const anyLookups = cards.some((c) => (c.lookups ?? 0) > 0)
  // Cards the example backfill would write for — ignored words aren't
  // vocabulary, so they never need one.
  const missingExamples = cards.filter((c) => !c.example?.trim() && !c.ignored).length

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
  const selectedCards = cards.filter((c) => selected.has(c.id))
  const everySelectedKnown = selected.size > 0 && selectedCards.every((c) => c.known)
  const everySelectedIgnored = selected.size > 0 && selectedCards.every((c) => c.ignored)

  function toggleSelectAll() {
    setSelected(allVisibleSelected ? new Set() : new Set(filtered.map((c) => c.id)))
  }

  const selectedIds = () => [...selected]

  // The two out-of-study flags are always written together, so a card can never
  // end up both known and ignored.
  async function setStatus(ids: number[], status: 'unknown' | 'known' | 'ignored') {
    await db.cards
      .where('id')
      .anyOf(ids)
      .modify({ known: status === 'known', ignored: status === 'ignored' })
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
    const missing = cards!.filter((c) => !c.emoji && !c.ignored)
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

  // Write an example sentence for every card that has none — the same idea as
  // the emoji backfill, but batched: sentences are far more output per word.
  async function fillExamples() {
    const missing = cards!.filter((c) => !c.example?.trim() && !c.ignored)
    if (missing.length === 0) return
    setExampleProgress([0, missing.length])
    try {
      for (let i = 0; i < missing.length; i += EXAMPLE_BATCH) {
        const batch = missing.slice(i, i + EXAMPLE_BATCH)
        const map = await generateExamples(
          deck!,
          batch.map((c) => ({ word: c.word, meaning: c.meaning })),
        )
        for (const c of batch) {
          const got = map.get(c.word.trim().toLowerCase())
          if (got?.example)
            await db.cards.update(c.id, {
              example: got.example,
              exampleTranslation: got.exampleTranslation || undefined,
            })
        }
        setExampleProgress([Math.min(i + EXAMPLE_BATCH, missing.length), missing.length])
      }
    } catch (e) {
      alert((e instanceof Error && e.message) || 'Example generation failed. Please try again.')
    } finally {
      setExampleProgress(null)
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
          <Icon name="volume" /> Listen
        </button>
      </div>

      <ContinueReading deckId={deckId} onOpen={onOpenStory} />

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
        <button
          className="btn"
          title="Translate a dialogue built from the words you know"
          onClick={onTranslate}
          disabled={cards.length === 0}
        >
          ✦ Translate
        </button>
        {cards.some((c) => !c.emoji && !c.ignored) && (
          <button
            className="btn"
            title="AI-pick a mnemonic emoji for every card that doesn't have one"
            onClick={fillEmojis}
            disabled={emojiLoading}
          >
            {emojiLoading ? 'Picking…' : '✦ Emoji'}
          </button>
        )}
        {/* Always on show, so the control can be found before it is needed —
            it just goes quiet once every card has an example. */}
        <button
          className="btn"
          title={
            missingExamples > 0
              ? `AI-write an example sentence for the ${missingExamples} ${missingExamples === 1 ? 'card' : 'cards'} without one`
              : 'Every card already has an example sentence'
          }
          onClick={fillExamples}
          disabled={exampleProgress !== null || missingExamples === 0}
        >
          {exampleProgress
            ? `Writing ${exampleProgress[0]}/${exampleProgress[1]}…`
            : missingExamples > 0
              ? `✦ Examples (${missingExamples})`
              : '✦ Examples'}
        </button>
        <button className="btn" onClick={() => setImporting(true)}>
          Import CSV
        </button>
        <button className="btn" onClick={() => setExporting(true)} disabled={cards.length === 0}>
          Export
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

      {anyLookups && (
        <div className="sort-row">
          <span className="sort-label">Sort</span>
          <button
            className={`filter-chip${sortBy === 'default' ? ' active' : ''}`}
            onClick={() => setSortBy('default')}
          >
            Default
          </button>
          <button
            className={`filter-chip${sortBy === 'lookups' ? ' active' : ''}`}
            title="Words you looked up most while reading stories"
            onClick={() => setSortBy('lookups')}
          >
            Most looked up
          </button>
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
              onClick={() => setStatus(selectedIds(), everySelectedKnown ? 'unknown' : 'known')}
            >
              {everySelectedKnown ? 'Unmark known' : 'Mark as known'}
            </button>
            <button
              className="btn small"
              title="Not vocabulary — out of study, and counted as neither known nor learning"
              onClick={() => setStatus(selectedIds(), everySelectedIgnored ? 'unknown' : 'ignored')}
            >
              {everySelectedIgnored ? 'Unignore' : 'Ignore'}
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
              className={`card-row${selected.has(card.id) ? ' selected' : ''}${card.known ? ' is-known' : ''}${card.ignored ? ' is-ignored' : ''}`}
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
                  {/* Romanization for non-Latin scripts, right beside the word. */}
                  {card.roman && <span className="row-roman">{card.roman}</span>}
                  {canSpeak && (
                    <button
                      className="speak-btn"
                      title="Pronounce"
                      aria-label={`Pronounce ${card.word}`}
                      onClick={() => speakWord(card.word)}
                    >
                      <Icon name="volume" />
                    </button>
                  )}
                  {card.ignored ? (
                    <span className="state-pill ignored" title="Not vocabulary — out of study, counted as neither known nor learning">
                      ignored
                    </span>
                  ) : card.known ? (
                    <span className="state-pill known">known</span>
                  ) : (
                    <span className={`state-pill ${card.state}`}>{card.state}</span>
                  )}
                  {(card.lookups ?? 0) > 0 && (
                    <span
                      className="lookups-badge"
                      title={`Looked up ${card.lookups}× while reading stories`}
                    >
                      👁 {card.lookups}
                    </span>
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
                  onClick={() => setStatus([card.id], card.known ? 'unknown' : 'known')}
                >
                  {card.known ? 'Unknown' : 'Known'}
                </button>
                <button
                  className="btn ghost small"
                  title={
                    card.ignored
                      ? 'Treat as vocabulary again'
                      : 'Not vocabulary — keep it in the deck, but out of study and out of the counts'
                  }
                  onClick={() => setStatus([card.id], card.ignored ? 'unknown' : 'ignored')}
                >
                  {card.ignored ? 'Unignore' : 'Ignore'}
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
      {exporting && (
        <ExportCards deck={deck} cards={cards} onClose={() => setExporting(false)} />
      )}
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
