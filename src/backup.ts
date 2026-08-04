/** Whole-database backup. `export.ts` writes cards for reading elsewhere — a
 *  spreadsheet, another app — and deliberately flattens them. This is the other
 *  thing entirely: every row of every table, ids intact, so a database can be
 *  put back exactly as it was.
 *
 *  It exists because everything Flashy knows lives in one browser's IndexedDB.
 *  Cards can be reconstructed from a CSV; a year of review timestamps, reading
 *  seconds and daily snapshots cannot be reconstructed from anything. */

import { db } from './db'
import { DAY, startOfDay } from './time'

/** Every table in the schema. Adding a store to `db.ts` and forgetting it here
 *  would silently drop it from backups, so the type ties the two together: this
 *  must name exactly the keys of the database object. */
export const TABLES = [
  'decks',
  'cards',
  'reviews',
  'blacklist',
  'settings',
  'stories',
  'snapshots',
  'reading',
  'listening',
  'translations',
] as const

export type TableName = (typeof TABLES)[number]

export interface Backup {
  /** Identifies the file as ours before we let it near the database. */
  format: 'flashy-backup'
  version: 1
  exportedAt: string
  tables: Record<TableName, unknown[]>
}

export const BACKUP_FORMAT = 'flashy-backup'

/** Read every table out of IndexedDB. */
export async function readBackup(): Promise<Backup> {
  const arrays = await Promise.all(TABLES.map((name) => db[name].toArray()))
  const tables = Object.fromEntries(
    TABLES.map((name, i) => [name, arrays[i]]),
  ) as Record<TableName, unknown[]>
  return {
    format: BACKUP_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    tables,
  }
}

export function backupFilename(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}`
  return `flashy-backup-${stamp}.json`
}

// ------------------------------------------------------------------ diagnosis

/** What a table looks like at a glance: how many rows, and — for the tables
 *  keyed or stamped by day — how many distinct days they cover and how far back
 *  they reach. A row count alone can't tell you whether a history is intact;
 *  "412 reviews across 3 days" and "412 reviews across 60 days" are the same
 *  count and completely different situations. */
export interface TableSummary {
  name: TableName
  rows: number
  /** Distinct local days the rows fall on, where the table has a day at all. */
  days?: number
  /** Oldest and newest day covered, as start-of-day timestamps. */
  first?: number
  last?: number
}

/** The field each table's day is derived from. Tables absent from this map
 *  carry no time dimension worth summarising. */
const DAY_OF: Partial<Record<TableName, (row: never) => number>> = {
  reviews: (r: { ts: number }) => startOfDay(r.ts),
  reading: (r: { day: number }) => r.day,
  listening: (r: { day: number }) => r.day,
  snapshots: (r: { day: number }) => r.day,
  stories: (r: { createdAt: number }) => startOfDay(r.createdAt),
  cards: (r: { createdAt: number }) => startOfDay(r.createdAt),
}

export function summarise(backup: Backup): TableSummary[] {
  return TABLES.map((name) => {
    const rows = backup.tables[name] ?? []
    const dayOf = DAY_OF[name] as ((row: unknown) => number) | undefined
    if (!dayOf || rows.length === 0) return { name, rows: rows.length }
    const days = new Set<number>()
    for (const row of rows) {
      const d = dayOf(row)
      if (Number.isFinite(d)) days.add(d)
    }
    if (days.size === 0) return { name, rows: rows.length }
    const sorted = [...days].sort((a, b) => a - b)
    return {
      name,
      rows: rows.length,
      days: days.size,
      first: sorted[0],
      last: sorted[sorted.length - 1],
    }
  })
}

/** Days between the first and last day a table covers, inclusive — the span a
 *  history *could* have filled, against which its distinct-day count reads as
 *  dense or full of holes. */
export function spanDays(summary: TableSummary): number | null {
  if (summary.first === undefined || summary.last === undefined) return null
  return Math.round((summary.last - summary.first) / DAY) + 1
}

// -------------------------------------------------------------------- restore

export class BackupError extends Error {}

/** Parse and check a file's text before anything touches the database. Throws
 *  `BackupError` with something a person can act on. */
export function parseBackup(text: string): Backup {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new BackupError('That file isn’t JSON.')
  }
  if (!raw || typeof raw !== 'object') throw new BackupError('That file is not a backup.')
  const obj = raw as Partial<Backup>
  if (obj.format !== BACKUP_FORMAT) {
    throw new BackupError(
      'That file is not a Flashy backup. (A card export from the deck screen is a different, ' +
        'card-only format and cannot restore your history.)',
    )
  }
  if (obj.version !== 1) {
    throw new BackupError(`Unsupported backup version: ${String(obj.version)}.`)
  }
  if (!obj.tables || typeof obj.tables !== 'object') {
    throw new BackupError('The backup has no tables in it.')
  }
  const tables = {} as Record<TableName, unknown[]>
  for (const name of TABLES) {
    const rows = (obj.tables as Record<string, unknown>)[name]
    // A backup taken before a table existed simply has nothing for it.
    if (rows === undefined || rows === null) {
      tables[name] = []
      continue
    }
    if (!Array.isArray(rows)) throw new BackupError(`The “${name}” table is malformed.`)
    tables[name] = rows
  }
  return { format: BACKUP_FORMAT, version: 1, exportedAt: String(obj.exportedAt ?? ''), tables }
}

export type RestoreMode = 'merge' | 'replace'

/** Put a backup back.
 *
 *  `merge` writes every row over whatever shares its primary key and leaves
 *  everything else alone — right for restoring onto the device the backup came
 *  from, where ids still mean the same rows. `replace` empties each table
 *  first, making the database exactly the backup.
 *
 *  Merging a backup from a *different* device is the one case to avoid: card
 *  and deck ids are auto-increment and both devices started at 1, so rows would
 *  land on top of unrelated ones. */
export async function restoreBackup(backup: Backup, mode: RestoreMode): Promise<void> {
  const stores = TABLES.map((name) => db[name])
  await db.transaction('rw', stores, async () => {
    for (const name of TABLES) {
      const rows = backup.tables[name]
      if (mode === 'replace') await db[name].clear()
      if (rows.length > 0) {
        // `settings` is keyed by an inline `key`, the rest by inline ids; every
        // store in this schema carries its own key, so a plain put is enough.
        await (db[name] as { bulkPut: (rows: unknown[]) => Promise<unknown> }).bulkPut(rows)
      }
    }
  })
}

/** Row counts as they stand right now, without building a whole backup —
 *  cheap enough to show live on the options screen. */
export async function currentCounts(): Promise<Record<TableName, number>> {
  const counts = await Promise.all(TABLES.map((name) => db[name].count()))
  return Object.fromEntries(TABLES.map((name, i) => [name, counts[i]])) as Record<
    TableName,
    number
  >
}
