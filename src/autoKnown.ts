/** Auto-known: a card for a word with only a clitic on it — namamu, namaku,
 *  kupegang, sudahlah — counts as known while the word it is built on is.
 *  Knowing "nama" is knowing "your name"; a card asking you to learn it again
 *  is noise in the study queue and an undercount on the dashboard.
 *
 *  Only clitics (see `cliticBases`). A word that a prefix or suffix makes —
 *  makanan from makan, pekerja from kerja — is new vocabulary and is never
 *  marked here.
 *
 *  The common-words list settles the look-alikes: a word that is an entry of
 *  its own (masalah, problem — not masa + -lah; buku, book — not bu + -ku) is
 *  never a clitic form, and a word the list files under some other root is
 *  not one of this root's forms either. Words the list does not hold are
 *  judged by the clitic rules alone. */

import { liveQuery } from 'dexie'
import { db, type Card } from './db'
import { cliticBases } from './lemma'
import { langCodeFor } from './speech'
import { defKey } from './text'

/** What the common-words list says about a word's standing. */
export interface ListLookup {
  /** Words that are entries of their own. */
  entries: Set<string>
  /** A listed form → the entry it is filed under. */
  formOf: Map<string, string>
}

export function listLookup(words: [string, string, string[]][]): ListLookup {
  const entries = new Set(words.map(([w]) => defKey(w)))
  const formOf = new Map<string, string>()
  for (const [w, , forms] of words) {
    for (const f of forms) {
      const k = defKey(f)
      if (!formOf.has(k)) formOf.set(k, defKey(w))
    }
  }
  return { entries, formOf }
}

/** The deck card a card is a clitic form of, or undefined. Nearest base first,
 *  so namamulah finds namamu before nama when the deck holds both. */
export function cliticBaseCard(
  card: Card,
  byKey: Map<string, Card>,
  langCode: string | null,
  list: ListLookup | null,
): Card | undefined {
  const key = defKey(card.word)
  if (list?.entries.has(key)) return undefined
  const filed = list?.formOf.get(key)
  for (const b of cliticBases(key, langCode)) {
    const base = byKey.get(b)
    if (!base || base.id === card.id) continue
    // Filed by the list under another root: the clitic reading is the wrong one.
    if (filed && filed !== b && filed !== defKey(base.word)) {
      // namamulah may be filed under nama while its nearest base is namamu:
      // accept a base that is itself a clitic form of what the list names.
      if (!cliticBases(b, langCode).includes(filed)) continue
    }
    return base
  }
  return undefined
}

/** Whether a card counts as known for the cards built on it: known by hand,
 *  or auto-known through its own base (namamulah through namamu, through
 *  nama), followed until it settles. */
function knownThroughChain(
  card: Card,
  byKey: Map<string, Card>,
  langCode: string | null,
  list: ListLookup | null,
  seen = new Set<number>(),
): boolean {
  if (card.ignored) return false
  if (card.known && card.auto !== 'known') return true
  if (seen.has(card.id)) return false
  seen.add(card.id)
  const base = cliticBaseCard(card, byKey, langCode, list)
  return !!base && knownThroughChain(base, byKey, langCode, list, seen)
}

/** The changes that bring one deck's cards in line: forms of known words
 *  marked known, and forms marked earlier whose word is no longer known put
 *  back into study. Cards the reader set by hand (`auto: 'off'`), ignored
 *  cards and cards already known by hand are never touched. */
export function autoKnownChanges(
  cards: Card[],
  langCode: string | null,
  list: ListLookup | null,
): { id: number; changes: Partial<Card> }[] {
  if (langCode !== 'id') return []
  const byKey = new Map<string, Card>()
  for (const c of cards) byKey.set(defKey(c.word), c)
  const out: { id: number; changes: Partial<Card> }[] = []
  for (const c of cards) {
    if (c.auto === 'off' || c.ignored) continue
    if (c.known && c.auto !== 'known') continue
    const base = cliticBaseCard(c, byKey, langCode, list)
    const should = !!base && knownThroughChain(base, byKey, langCode, list)
    if (should && c.auto !== 'known') out.push({ id: c.id, changes: { known: true, auto: 'known' } })
    else if (!should && c.auto === 'known') out.push({ id: c.id, changes: { known: false, auto: undefined } })
  }
  return out
}

/** Apply `autoKnownChanges` to one deck. Returns how many cards moved. */
export async function applyAutoKnown(
  cards: Card[],
  langCode: string | null,
  list: ListLookup | null,
): Promise<number> {
  const changes = autoKnownChanges(cards, langCode, list)
  if (changes.length === 0) return 0
  await db.transaction('rw', db.cards, async () => {
    for (const { id, changes: ch } of changes) await db.cards.update(id, ch)
  })
  return changes.length
}

/** Keep every deck in line from now on: once at start (which also catches up
 *  cards from before this existed), then after any change to the cards —
 *  marking nama known, un-marking it, adding namamu. Debounced, since a bulk
 *  change writes many cards; and safe to re-run, since a second pass finds
 *  nothing to change. Returns the stop function. */
export function watchAutoKnown(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  let list: Promise<ListLookup | null> | null = null
  const run = async () => {
    const decks = await db.decks.toArray()
    for (const deck of decks) {
      const langCode = langCodeFor(deck.language)
      if (langCode !== 'id') continue
      // The list rules out look-alikes (masalah), so nothing is marked until
      // it has loaded — or, if it can't load, on the clitic rules alone.
      list ??= import('./data/common-words-id.json')
        .then((m) => listLookup((m.default as unknown as { words: [string, string, string[]][] }).words))
        .catch(() => null)
      const lookup = await list
      if (stopped) return
      const cards = await db.cards.where('deckId').equals(deck.id).toArray()
      await applyAutoKnown(cards, langCode, lookup)
    }
  }
  const schedule = () => {
    clearTimeout(timer)
    timer = setTimeout(() => void run().catch(() => {}), 800)
  }
  const sub = liveQuery(() => db.cards.toArray()).subscribe({ next: schedule, error: () => {} })
  return () => {
    stopped = true
    clearTimeout(timer)
    sub.unsubscribe()
  }
}
