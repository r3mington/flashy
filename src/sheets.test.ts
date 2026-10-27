import { describe, expect, it } from 'vitest'
import type { Card, Deck } from './db'
import { APPS_SCRIPT, dailySaveDue, isAppsScriptUrl, sheetRows, SHEET_TAB } from './sheets'
import { EXPORT_COLUMNS } from './export'
import { startOfDay } from './time'

const deck = (id: number, name: string): Deck => ({ id, name, language: 'Indonesian', createdAt: 0 })

function card(over: Partial<Card>): Card {
  return {
    id: 1,
    deckId: 1,
    word: 'pantai',
    meaning: 'beach',
    example: '',
    createdAt: 0,
    state: 'new',
    due: 0,
    interval: 0,
    ease: 2.5,
    reps: 0,
    lapses: 0,
    ...over,
  } as Card
}

describe('sheetRows', () => {
  it('starts with a header naming the deck, then every export column', () => {
    const [header] = sheetRows([], [])
    expect(header).toEqual(['Deck', 'Language', ...EXPORT_COLUMNS.map((c) => c.label)])
  })

  it('gives every row the same width as the header', () => {
    const rows = sheetRows([deck(1, 'Bahasa')], [card({}), card({ id: 2, word: 'kopi' })])
    for (const r of rows) expect(r).toHaveLength(rows[0].length)
  })

  it('groups by deck, oldest word first', () => {
    const rows = sheetRows(
      [deck(1, 'A'), deck(2, 'B')],
      [
        card({ id: 1, deckId: 2, word: 'b-new', createdAt: 5 }),
        card({ id: 2, deckId: 1, word: 'a-new', createdAt: 9 }),
        card({ id: 3, deckId: 1, word: 'a-old', createdAt: 1 }),
      ],
    )
    expect(rows.slice(1).map((r) => r[2])).toEqual(['a-old', 'a-new', 'b-new'])
  })

  it('keeps text that Sheets would read as a formula as text', () => {
    const [, row] = sheetRows([deck(1, 'Bahasa')], [card({ word: '-nya', meaning: '=his' })])
    expect(row[2]).toBe("'-nya")
    expect(row[4]).toBe("'=his")
  })

  it('writes an empty cell, not null, where a card has nothing', () => {
    const [, row] = sheetRows([deck(1, 'Bahasa')], [card({})])
    expect(row).not.toContain(null)
    expect(row[3]).toBe('') // romanization
  })
})

describe('isAppsScriptUrl', () => {
  it.each([
    'https://script.google.com/macros/s/AKfycbx-abc_123/exec',
    'https://script.google.com/a/example.com/macros/s/AKfycbx/exec',
    '  https://script.google.com/macros/s/AKfycbx/exec  ',
  ])('accepts %s', (url) => expect(isAppsScriptUrl(url)).toBe(true))

  it.each([
    'https://script.google.com/macros/s/AKfycbx/dev', // the test link, not the deployment
    'https://script.google.com/home/projects/abc/edit', // the editor
    'https://docs.google.com/spreadsheets/d/abc/edit', // the sheet itself
    'http://script.google.com/macros/s/AKfycbx/exec',
  ])('rejects %s', (url) => expect(isAppsScriptUrl(url)).toBe(false))
})

describe('dailySaveDue', () => {
  const now = new Date('2026-10-27T09:00:00').getTime()
  const today = startOfDay(now)
  const s = { sheetUrl: 'https://x', sheetLastSync: 0, sheetLastAttempt: 0 }

  it('is due once a day when connected', () => {
    expect(dailySaveDue(s, now)).toBe(true)
    expect(dailySaveDue({ ...s, sheetLastSync: today - 1 }, now)).toBe(true)
    expect(dailySaveDue({ ...s, sheetLastSync: today + 1 }, now)).toBe(false)
  })

  it('never runs without a link', () => {
    expect(dailySaveDue({ ...s, sheetUrl: '' }, now)).toBe(false)
  })

  it('waits an hour after a failed attempt', () => {
    expect(dailySaveDue({ ...s, sheetLastAttempt: now - 10 * 60_000 }, now)).toBe(false)
    expect(dailySaveDue({ ...s, sheetLastAttempt: now - 61 * 60_000 }, now)).toBe(true)
  })
})

/** The helper runs in Google's Apps Script, out of reach of these tests — so
 *  run it here against a stand-in spreadsheet, to catch a typo before the
 *  reader has pasted it and deployed it. */
describe('APPS_SCRIPT', () => {
  function run(rows: unknown[][], existing: Record<string, unknown[][]> = {}) {
    const sheets = new Map(Object.entries(existing).map(([k, v]) => [k, { data: v, frozen: 0 }]))
    const sheetApi = (name: string) => {
      const s = sheets.get(name)!
      return {
        clearContents: () => void (s.data = []),
        getRange: (r: number, c: number, nr: number, nc: number) => ({
          setValues: (v: unknown[][]) => {
            expect([r, c, nr, nc]).toEqual([1, 1, v.length, v[0].length])
            s.data = v
          },
        }),
        setFrozenRows: (n: number) => void (s.frozen = n),
      }
    }
    const SpreadsheetApp = {
      getActiveSpreadsheet: () => ({
        getSheetByName: (n: string) => (sheets.has(n) ? sheetApi(n) : null),
        insertSheet: (n: string) => {
          sheets.set(n, { data: [], frozen: 0 })
          return sheetApi(n)
        },
      }),
    }
    let released = false
    const LockService = {
      getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => void (released = true) }),
    }
    const ContentService = {
      MimeType: { JSON: 'json' },
      createTextOutput: (text: string) => ({ setMimeType: () => text }),
    }
    const doPost = new Function(
      'SpreadsheetApp',
      'LockService',
      'ContentService',
      `${APPS_SCRIPT}; return doPost`,
    )(SpreadsheetApp, LockService, ContentService)
    const out = JSON.parse(doPost({ postData: { contents: JSON.stringify({ tab: SHEET_TAB, rows }) } }))
    return { out, sheets, released }
  }

  it('creates the tab and writes the rows', () => {
    const { out, sheets, released } = run([['Word'], ['pantai'], ['kopi']])
    expect(out).toEqual({ ok: true, words: 2 })
    expect(sheets.get(SHEET_TAB)).toEqual({ data: [['Word'], ['pantai'], ['kopi']], frozen: 1 })
    expect(released).toBe(true)
  })

  it('replaces what was there and leaves other tabs alone', () => {
    const { sheets } = run([['Word'], ['kopi']], {
      [SHEET_TAB]: [['Word'], ['old'], ['older']],
      Notes: [['mine']],
    })
    expect(sheets.get(SHEET_TAB)!.data).toEqual([['Word'], ['kopi']])
    expect(sheets.get('Notes')!.data).toEqual([['mine']])
  })
})
