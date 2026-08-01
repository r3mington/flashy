import Papa from 'papaparse'
import type { Card, Deck } from './db'

/** A card's status as the deck view shows it — "known" and "ignored" win over
 *  the SRS state, because such a card is out of study whatever its state says. */
export function cardStatus(card: Card): 'new' | 'learning' | 'review' | 'known' | 'ignored' {
  return card.ignored ? 'ignored' : card.known ? 'known' : card.state
}

export type ExportColumn =
  | 'word'
  | 'roman'
  | 'meaning'
  | 'example'
  | 'exampleTranslation'
  | 'notes'
  | 'emoji'
  | 'status'
  | 'known'
  | 'ignored'
  | 'lookups'
  | 'addedAt'
  | 'dueAt'
  | 'lastReviewAt'
  | 'reps'
  | 'lapses'
  | 'interval'
  | 'ease'

export const EXPORT_COLUMNS: { key: ExportColumn; label: string; hint?: string }[] = [
  { key: 'word', label: 'Word' },
  { key: 'roman', label: 'Romanization' },
  { key: 'meaning', label: 'Meaning' },
  { key: 'example', label: 'Example' },
  { key: 'exampleTranslation', label: 'Example translation' },
  { key: 'notes', label: 'Notes' },
  { key: 'emoji', label: 'Emoji' },
  { key: 'status', label: 'Status', hint: 'new / learning / review / known / ignored' },
  { key: 'known', label: 'Known', hint: 'yes / no' },
  { key: 'ignored', label: 'Ignored', hint: 'yes / no' },
  { key: 'lookups', label: 'Look-ups', hint: 'times tapped while reading' },
  { key: 'addedAt', label: 'Date added' },
  { key: 'dueAt', label: 'Next due' },
  { key: 'lastReviewAt', label: 'Last reviewed' },
  { key: 'reps', label: 'Reps' },
  { key: 'lapses', label: 'Lapses' },
  { key: 'interval', label: 'Interval (days)' },
  { key: 'ease', label: 'Ease' },
]

export const DEFAULT_COLUMNS: ExportColumn[] = [
  'word',
  'meaning',
  'example',
  'status',
  'lookups',
  'addedAt',
]

/** ISO-8601 in local time (`2026-07-29T14:03:00+02:00`) — spreadsheets read it
 *  and it doesn't shift a card's "added" day across the date line. */
function isoLocal(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const zone = `${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${zone}`
  )
}

/** The value of one column for one card. `null` where the card has nothing —
 *  it becomes an empty CSV cell and a JSON null. */
export function cellValue(card: Card, col: ExportColumn): string | number | null {
  switch (col) {
    case 'word':
      return card.word
    case 'roman':
      return card.roman ?? null
    case 'meaning':
      return card.meaning
    case 'example':
      return card.example || null
    case 'exampleTranslation':
      return card.exampleTranslation ?? null
    case 'notes':
      return card.notes ?? null
    case 'emoji':
      return card.emoji ?? null
    case 'status':
      return cardStatus(card)
    case 'known':
      return card.known ? 'yes' : 'no'
    case 'ignored':
      return card.ignored ? 'yes' : 'no'
    case 'lookups':
      return card.lookups ?? 0
    case 'addedAt':
      return isoLocal(card.createdAt)
    case 'dueAt':
      return isoLocal(card.due)
    case 'lastReviewAt':
      return card.lastReview ? isoLocal(card.lastReview) : null
    case 'reps':
      return card.reps
    case 'lapses':
      return card.lapses
    case 'interval':
      return card.interval
    case 'ease':
      return card.ease
  }
}

const LABELS = new Map(EXPORT_COLUMNS.map((c) => [c.key, c.label]))

export function toCsv(cards: Card[], columns: ExportColumn[]): string {
  const header = columns.map((c) => LABELS.get(c) ?? c)
  const rows = cards.map((card) => columns.map((c) => cellValue(card, c) ?? ''))
  return Papa.unparse([header, ...rows])
}

export function toJson(deck: Deck, cards: Card[], columns: ExportColumn[]): string {
  const payload = {
    deck: { name: deck.name, language: deck.language },
    exportedAt: isoLocal(Date.now()),
    count: cards.length,
    cards: cards.map((card) =>
      Object.fromEntries(columns.map((c) => [c, cellValue(card, c)])),
    ),
  }
  return JSON.stringify(payload, null, 2)
}

/** Kick off a browser download of `text`. */
export function downloadFile(name: string, text: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

/** `thai-basics-known-2026-07-29.csv` */
export function exportFilename(deckName: string, scope: string, ext: string): string {
  const slug =
    deckName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'deck'
  return `${slug}-${scope}-${new Date().toISOString().slice(0, 10)}.${ext}`
}
