/** Day arithmetic and duration formatting. A dependency-free leaf module, so
 *  anything — including `db` itself — can use it without dragging in the stats
 *  layer. Five separate copies of "start of today" used to live across the
 *  components, and two subtly different `formatDuration`s (one rounding, one
 *  flooring) reported the same number differently on different screens. */

export const DAY = 24 * 60 * 60 * 1000

/** Local midnight for a timestamp. The keys of every per-day table are these. */
export function startOfDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function startOfToday(): number {
  return startOfDay(Date.now())
}

/** Re-key a stored start-of-day timestamp onto the current midnight grid.
 *  The per-day tables key rows by the local midnight in force when the row was
 *  written; once the UTC offset changes — travel, DST, a backup restored from a
 *  device in another timezone — those keys sit hours off today's midnights and
 *  every exact-key join silently drops them. Reading a key as "the calendar day
 *  whose midnight this was" (tolerant of offsets up to ±12h) puts it back on
 *  the grid. */
export function normalizeDay(day: number): number {
  return startOfDay(day + DAY / 2)
}

/** The local midnight before a start-of-day timestamp. Walking days this way
 *  rather than by `- DAY` keeps the walk on real midnights across DST, where
 *  a calendar day is 23 or 25 hours long. */
export function prevDay(day: number): number {
  return startOfDay(day - DAY / 2)
}

/** The local midnight after a start-of-day timestamp. */
export function nextDay(day: number): number {
  return startOfDay(day + DAY * 1.5)
}

/** Compact duration for headers and stat tiles: 45s, 2m, 1h 5m. */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`
  const m = Math.round(seconds / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

/** Coarse "when was this" for list rows — counted in whole days, so something
 *  from late last night reads as "yesterday" rather than "12h ago". */
export function formatAgo(ts: number, now = Date.now()): string {
  const days = Math.floor((startOfDay(now) - startOfDay(ts)) / DAY)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days}d ago`
  if (days < 30) return `${Math.floor(days / 7)}w ago`
  if (days < 365) return `${Math.floor(days / 30)}mo ago`
  return `${Math.floor(days / 365)}y ago`
}
