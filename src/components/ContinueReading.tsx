import { useLiveQuery } from 'dexie-react-hooks'
import { db, type SavedStory } from '../db'
import { Icon } from './Icon'
import { langCodeFor } from '../speech'
import { countWords } from '../text'

interface Props {
  /** Scope to a single deck's stories; omit for the latest across all decks. */
  deckId?: number
  onOpen: (deckId: number, storyId: number) => void
}

/** One-tap shortcut back into the story you were last reading, resuming at its
 *  reading marker. Renders nothing when there are no stories in scope. */
export function ContinueReading({ deckId, onOpen }: Props) {
  const latest = useLiveQuery(async () => {
    const stories =
      deckId != null
        ? await db.stories.where('deckId').equals(deckId).toArray()
        : await db.stories.toArray()
    if (stories.length === 0) return null
    // Generating a story opens it, so "last opened" also covers "last written".
    const recency = (s: SavedStory) => s.lastOpenedAt ?? s.createdAt
    const story = stories.reduce((a, b) => (recency(a) >= recency(b) ? a : b))
    const deck = await db.decks.get(story.deckId)
    if (!deck) return null
    const total = Math.max(1, countWords(story.story, langCodeFor(deck.language)))
    const pct =
      story.bookmark != null ? Math.min(100, Math.round(((story.bookmark + 1) / total) * 100)) : null
    return { story, deck, pct }
  }, [deckId])

  if (!latest) return null
  const { story, deck, pct } = latest
  // On a deck page the deck name is redundant — show when it was written instead.
  const meta = [
    deckId != null ? new Date(story.createdAt).toLocaleDateString() : deck.name,
    pct != null ? `${pct}% read` : null,
  ].filter(Boolean)

  return (
    <button
      className="continue-reading"
      title="Pick up where you left off — opens at your reading marker"
      onClick={() => onOpen(story.deckId, story.id)}
    >
      <span className="cr-label">
        <Icon name="book" /> Continue reading
      </span>
      <span className="cr-title">{story.title}</span>
      <span className="cr-meta">{meta.join(' · ')}</span>
      {pct != null && (
        <span className="cr-bar">
          <span style={{ width: `${pct}%` }} />
        </span>
      )}
    </button>
  )
}
