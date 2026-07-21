import Papa from 'papaparse'

export interface ParsedCsv {
  headers: string[]
  rows: string[][]
}

export type CardField = 'word' | 'meaning' | 'example' | 'exampleTranslation' | 'notes' | 'skip'

export const CARD_FIELDS: { value: CardField; label: string }[] = [
  { value: 'word', label: 'Word' },
  { value: 'meaning', label: 'Meaning' },
  { value: 'example', label: 'Example sentence' },
  { value: 'exampleTranslation', label: 'Example translation' },
  { value: 'notes', label: 'Notes' },
  { value: 'skip', label: '— ignore —' },
]

export function parseCsv(text: string): ParsedCsv {
  const result = Papa.parse<string[]>(text.trim(), { skipEmptyLines: true })
  const data = result.data.filter((r) => r.some((c) => c.trim() !== ''))
  if (data.length === 0) return { headers: [], rows: [] }
  return { headers: data[0], rows: data.slice(1) }
}

/** Guess a mapping from header names. */
export function guessMapping(headers: string[]): CardField[] {
  return headers.map((h) => {
    const l = h.toLowerCase()
    if (/word|term|kata|front|vocab/.test(l)) return 'word'
    if (/(example|sentence|contoh|kalimat).*(trans|arti|terjemah)/.test(l)) return 'exampleTranslation'
    if (/example|sentence|contoh|kalimat/.test(l)) return 'example'
    if (/meaning|definition|translation|arti|back|english/.test(l)) return 'meaning'
    if (/note|catatan|comment/.test(l)) return 'notes'
    return 'skip'
  })
}
