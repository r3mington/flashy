import { useLiveQuery } from 'dexie-react-hooks'
import { db, type Card, type Deck } from './db'
import { langCodeFor } from './speech'

export interface DeckData {
  deck: Deck | undefined
  cards: Card[] | undefined
  /** Speech/segmentation code for the deck's language, null until it loads. */
  langCode: string | null
}

/** The deck, its cards and its language code — the trio every deck-scoped
 *  screen opens with. Live: edits elsewhere in the app re-render the caller.
 *
 *  Both stay `undefined` until Dexie answers, which is not the same as an empty
 *  deck. Guard with `if (!deck || !cards) return null` rather than a `ready`
 *  flag: only the direct check narrows the types for the rest of the render. */
export function useDeck(deckId: number): DeckData {
  const deck = useLiveQuery(() => db.decks.get(deckId), [deckId])
  const cards = useLiveQuery(() => db.cards.where('deckId').equals(deckId).toArray(), [deckId])
  return { deck, cards, langCode: deck ? langCodeFor(deck.language) : null }
}
