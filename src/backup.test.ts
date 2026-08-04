import { describe, expect, it } from 'vitest'
import {
  BACKUP_FORMAT,
  BackupError,
  TABLES,
  backupFilename,
  parseBackup,
  spanDays,
  summarise,
  type Backup,
} from './backup'
import { DAY, startOfDay } from './time'

const DAY0 = startOfDay(new Date('2026-07-01T12:00:00').getTime())

function makeBackup(tables: Partial<Record<string, unknown[]>> = {}): Backup {
  const full = Object.fromEntries(TABLES.map((t) => [t, tables[t] ?? []]))
  return {
    format: BACKUP_FORMAT,
    version: 1,
    exportedAt: '2026-08-04T12:00:00.000Z',
    tables: full as Backup['tables'],
  }
}

describe('parseBackup', () => {
  it('accepts a backup and keeps its rows', () => {
    const text = JSON.stringify(makeBackup({ decks: [{ id: 1, name: 'Bahasa' }] }))
    const parsed = parseBackup(text)
    expect(parsed.tables.decks).toHaveLength(1)
    expect(parsed.tables.cards).toEqual([])
  })

  it('fills in tables the backup predates', () => {
    const partial = { format: BACKUP_FORMAT, version: 1, tables: { decks: [] } }
    const parsed = parseBackup(JSON.stringify(partial))
    for (const name of TABLES) expect(parsed.tables[name]).toEqual([])
  })

  it('rejects text that is not JSON', () => {
    expect(() => parseBackup('not json at all')).toThrow(BackupError)
  })

  it('rejects a card export, which is the easy file to reach for by mistake', () => {
    // The shape src/export.ts writes: no `format`, cards flattened under a deck.
    const cardExport = JSON.stringify({
      deck: { name: 'Bahasa', language: 'Indonesian' },
      count: 1,
      cards: [{ word: 'hujan', meaning: 'rain' }],
    })
    expect(() => parseBackup(cardExport)).toThrow(/not a Flashy backup/)
  })

  it('rejects an unknown version rather than guessing', () => {
    const text = JSON.stringify({ format: BACKUP_FORMAT, version: 99, tables: {} })
    expect(() => parseBackup(text)).toThrow(/version/)
  })

  it('rejects a malformed table', () => {
    const text = JSON.stringify({ format: BACKUP_FORMAT, version: 1, tables: { cards: 'nope' } })
    expect(() => parseBackup(text)).toThrow(/cards/)
  })
})

describe('summarise', () => {
  it('counts distinct days, not rows — the number that shows a history with holes', () => {
    const reviews = [
      { ts: DAY0 + 3600e3 },
      { ts: DAY0 + 7200e3 }, // same day
      { ts: DAY0 + 5 * DAY },
      { ts: DAY0 + 9 * DAY },
    ]
    const s = summarise(makeBackup({ reviews })).find((t) => t.name === 'reviews')!
    expect(s.rows).toBe(4)
    expect(s.days).toBe(3)
    expect(s.first).toBe(DAY0)
    expect(s.last).toBe(DAY0 + 9 * DAY)
    // Three days of activity spread over a ten-day window.
    expect(spanDays(s)).toBe(10)
  })

  it('reads day-keyed tables straight off their key', () => {
    const reading = [
      { day: DAY0, seconds: 60 },
      { day: DAY0 + DAY, seconds: 90 },
    ]
    const s = summarise(makeBackup({ reading })).find((t) => t.name === 'reading')!
    expect(s.days).toBe(2)
    expect(spanDays(s)).toBe(2)
  })

  it('leaves an empty table without a day range', () => {
    const s = summarise(makeBackup()).find((t) => t.name === 'reviews')!
    expect(s.rows).toBe(0)
    expect(s.days).toBeUndefined()
    expect(spanDays(s)).toBeNull()
  })

  it('reports every table, so a missing one is visible as a zero', () => {
    expect(summarise(makeBackup()).map((t) => t.name)).toEqual([...TABLES])
  })

  it('ignores rows whose timestamp is unusable instead of throwing', () => {
    const reviews = [{ ts: DAY0 }, { ts: NaN }, {}]
    const s = summarise(makeBackup({ reviews })).find((t) => t.name === 'reviews')!
    expect(s.rows).toBe(3)
    expect(s.days).toBe(1)
  })
})

describe('backupFilename', () => {
  it('stamps to the minute, so two backups the same day do not collide', () => {
    const name = backupFilename(new Date('2026-08-04T09:05:00'))
    expect(name).toBe('flashy-backup-2026-08-04-0905.json')
  })
})
