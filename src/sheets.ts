/** Google Sheets export: every word of every deck, written into one tab of the
 *  reader's own spreadsheet, replacing what was there — so another app can
 *  read the sheet as a live copy of the word bank.
 *
 *  Flashy cannot write to a spreadsheet by itself. A short Apps Script, pasted
 *  into the sheet and deployed as a web app, does the writing: Flashy posts it
 *  the rows and the script swaps them in. That needs no Google Cloud project,
 *  no sign-in inside Flashy and no secret on our server; the web app's URL is
 *  the only key, and it lives in this device's settings.
 *
 *  Like everything else here it is per device. Two devices pointed at the same
 *  sheet would each overwrite it with their own words. */

import { db, DEFAULT_SETTINGS, type Card, type Deck } from './db'
import { cellValue, EXPORT_COLUMNS } from './export'
import { saveSettings } from './useSettings'
import { startOfDay } from './time'

/** The tab the script writes. Created on first export; nothing else in the
 *  spreadsheet is touched. */
export const SHEET_TAB = 'Flashy words'

/** After a failed daily save, how long to wait before trying again on the
 *  next open — so a broken link doesn't make every launch wait on it. */
const RETRY_AFTER_MS = 60 * 60 * 1000

/** The helper the reader pastes into their spreadsheet. Kept as plain ES5:
 *  Apps Script runs it as is. The lock stops two saves landing at once from
 *  interleaving their rows. */
export const APPS_SCRIPT = `// Flashy → this spreadsheet. Writes every word into the "${SHEET_TAB}" tab,
// replacing what was there. Nothing else in the spreadsheet is touched.
function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var data = JSON.parse(e.postData.contents);
    var rows = data.rows;
    var book = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = book.getSheetByName(data.tab) || book.insertSheet(data.tab);
    sheet.clearContents();
    sheet.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
    sheet.setFrozenRows(1);
    return reply({ ok: true, words: rows.length - 1 });
  } catch (err) {
    return reply({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function reply(out) {
  return ContentService.createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}
`

/** Whether `url` looks like a deployed Apps Script web app — the link the
 *  Deploy dialog gives, not the editor's. */
export function isAppsScriptUrl(url: string): boolean {
  return /^https:\/\/script\.google\.com\/(a\/[^/]+\/)?macros\/s\/[\w-]+\/exec\/?$/.test(url.trim())
}

/** A cell as the sheet should hold it. Sheets reads a typed value the way it
 *  reads typing, so a meaning such as "-nya: his, her" would arrive as a broken
 *  formula. A leading apostrophe makes it text, and the apostrophe itself is
 *  neither shown nor returned to anything reading the sheet. */
function cell(v: string | number | null): string | number {
  if (v == null) return ''
  if (typeof v === 'string' && /^[=+\-@]/.test(v)) return `'${v}`
  return v
}

/** Header plus one row per card: the deck it belongs to, then every column the
 *  card export knows, in its order. Grouped by deck, oldest word first, so
 *  the sheet reads the way the bank grew. */
export function sheetRows(decks: Deck[], cards: Card[]): (string | number)[][] {
  const deckById = new Map(decks.map((d) => [d.id, d]))
  const header = ['Deck', 'Language', ...EXPORT_COLUMNS.map((c) => c.label)]
  const deckOrder = new Map(decks.map((d, i) => [d.id, i]))
  const sorted = [...cards].sort(
    (a, b) =>
      (deckOrder.get(a.deckId) ?? 0) - (deckOrder.get(b.deckId) ?? 0) || a.createdAt - b.createdAt,
  )
  const rows = sorted.map((card) => {
    const deck = deckById.get(card.deckId)
    return [
      cell(deck?.name ?? null),
      cell(deck?.language ?? null),
      ...EXPORT_COLUMNS.map((c) => cell(cellValue(card, c.key))),
    ]
  })
  return [header, ...rows]
}

export class SheetError extends Error {}

/** Write every word to the sheet behind `url`, and record how it went. Returns
 *  the number of words written. */
export async function saveToSheet(url: string): Promise<number> {
  const attemptedAt = Date.now()
  try {
    const [decks, cards] = await Promise.all([db.decks.toArray(), db.cards.toArray()])
    // An empty bank is a new or wiped device, not a reader who deleted every
    // word. Writing it would empty the sheet the other app relies on.
    if (cards.length === 0) throw new SheetError('There are no words on this device to save.')
    let res: Response
    try {
      res = await fetch(url.trim(), {
        method: 'POST',
        // text/plain keeps this a "simple" request: Apps Script answers no
        // CORS preflight, so a JSON content type would never reach it.
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ tab: SHEET_TAB, rows: sheetRows(decks, cards) }),
      })
    } catch {
      throw new SheetError('Could not reach the sheet. Check your connection and the link.')
    }
    let out: { ok?: boolean; words?: number; error?: string }
    try {
      out = await res.json()
    } catch {
      // A wrong link, or a deployment not open to "Anyone", answers with
      // Google's HTML sign-in or error page rather than our JSON.
      throw new SheetError(
        'The link didn’t answer like the Flashy helper. Check it is the Web app link and that access is set to “Anyone”.',
      )
    }
    if (!out.ok) throw new SheetError(`The sheet said: ${out.error ?? 'unknown error'}`)
    const words = out.words ?? cards.length
    await saveSettings({
      sheetLastSync: Date.now(),
      sheetLastAttempt: attemptedAt,
      sheetLastCount: words,
      sheetLastError: '',
    })
    return words
  } catch (e) {
    const message = e instanceof Error ? e.message : 'The save failed.'
    await saveSettings({ sheetLastAttempt: attemptedAt, sheetLastError: message })
    throw e
  }
}

/** Whether today's automatic save is still owed: a link is set, nothing has
 *  been saved since midnight, and no attempt failed within the last hour. */
export function dailySaveDue(
  s: { sheetUrl: string; sheetLastSync: number; sheetLastAttempt: number },
  now = Date.now(),
): boolean {
  if (!s.sheetUrl) return false
  if (s.sheetLastSync >= startOfDay(now)) return false
  return now - s.sheetLastAttempt >= RETRY_AFTER_MS
}

let running = false

/** The once-a-day save, run whenever the app opens or comes back to the
 *  front. Quiet: a failure is recorded for the Options screen, not thrown. */
export async function dailySheetSave(): Promise<void> {
  if (running) return
  running = true
  try {
    // Merged with the defaults: settings saved before these fields existed
    // have none of them, and a missing attempt time must read as "never".
    const s = { ...DEFAULT_SETTINGS, ...(await db.settings.get('app')) }
    if (!dailySaveDue(s)) return
    await saveToSheet(s.sheetUrl).catch((e) => console.warn('[sheets] daily save failed', e))
  } finally {
    running = false
  }
}
