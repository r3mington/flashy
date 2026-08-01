import { useState } from 'react'
import type { Card, Deck } from '../db'
import {
  DEFAULT_COLUMNS,
  EXPORT_COLUMNS,
  cardStatus,
  cellValue,
  downloadFile,
  exportFilename,
  toCsv,
  toJson,
  type ExportColumn,
} from '../export'

interface Props {
  deck: Deck
  cards: Card[]
  onClose: () => void
}

type Status = 'new' | 'learning' | 'review' | 'known' | 'ignored'
type Format = 'csv' | 'json'

const STATUSES: { key: Status; label: string }[] = [
  { key: 'new', label: 'New' },
  { key: 'learning', label: 'Learning' },
  { key: 'review', label: 'Review' },
  { key: 'known', label: 'Known' },
  { key: 'ignored', label: 'Ignored' },
]

const UNKNOWN: Status[] = ['new', 'learning', 'review']
/** Everything that is actually vocabulary — the default selection. Ignored
 *  words (brand names, place names…) are deck bookkeeping, not words to export. */
const VOCAB: Status[] = ['new', 'learning', 'review', 'known']

export function ExportCards({ deck, cards, onClose }: Props) {
  const [statuses, setStatuses] = useState<Set<Status>>(new Set(VOCAB))
  const [columns, setColumns] = useState<ExportColumn[]>(DEFAULT_COLUMNS)
  const [format, setFormat] = useState<Format>('csv')
  const [minLookups, setMinLookups] = useState(0)

  const counts = STATUSES.reduce<Record<Status, number>>(
    (acc, s) => {
      acc[s.key] = cards.filter((c) => cardStatus(c) === s.key).length
      return acc
    },
    { new: 0, learning: 0, review: 0, known: 0, ignored: 0 },
  )

  const selected = cards
    .filter((c) => statuses.has(cardStatus(c)) && (c.lookups ?? 0) >= minLookups)
    .sort((a, b) => a.createdAt - b.createdAt)

  // Keep the export in the order the column list shows, not the order they
  // happened to be ticked in.
  const orderedColumns = EXPORT_COLUMNS.map((c) => c.key).filter((k) => columns.includes(k))

  const canExport = selected.length > 0 && orderedColumns.length > 0

  function toggleStatus(s: Status) {
    setStatuses((prev) => {
      const next = new Set(prev)
      if (next.has(s)) next.delete(s)
      else next.add(s)
      return next
    })
  }

  function toggleColumn(c: ExportColumn) {
    setColumns((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]))
  }

  const sameSet = (a: Status[]) =>
    a.length === statuses.size && a.every((s) => statuses.has(s))

  /** A short word for the filename: what this selection actually is. */
  function scopeName(): string {
    if (statuses.size === STATUSES.length) return 'all'
    if (sameSet(VOCAB)) return 'words'
    if (sameSet(UNKNOWN)) return 'unknown'
    if (sameSet(['known'])) return 'known'
    return [...statuses].join('-')
  }

  function runExport() {
    if (!canExport) return
    const scope = scopeName()
    if (format === 'csv') {
      downloadFile(
        exportFilename(deck.name, scope, 'csv'),
        toCsv(selected, orderedColumns),
        'text/csv',
      )
    } else {
      downloadFile(
        exportFilename(deck.name, scope, 'json'),
        toJson(deck, selected, orderedColumns),
        'application/json',
      )
    }
    onClose()
  }

  const preview = selected.slice(0, 4)

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h2>Export cards</h2>

        <div className="export-block">
          <div className="eyebrow">Which words</div>
          <div className="filter-chips">
            {STATUSES.map((s) => (
              <button
                key={s.key}
                className={`filter-chip${statuses.has(s.key) ? ' active' : ''}`}
                onClick={() => toggleStatus(s.key)}
              >
                {s.label}
                <span className="filter-chip-count">{counts[s.key]}</span>
              </button>
            ))}
          </div>
          <div className="export-presets">
            <button
              className="btn ghost small"
              onClick={() => setStatuses(new Set(STATUSES.map((s) => s.key)))}
            >
              Everything
            </button>
            <button className="btn ghost small" onClick={() => setStatuses(new Set(VOCAB))}>
              All words
            </button>
            <button className="btn ghost small" onClick={() => setStatuses(new Set(UNKNOWN))}>
              Unknown only
            </button>
            <button className="btn ghost small" onClick={() => setStatuses(new Set(['known']))}>
              Known only
            </button>
          </div>
          <label className="export-lookup-filter">
            <span>Only words looked up at least</span>
            <input
              type="number"
              min={0}
              value={minLookups}
              onChange={(e) => setMinLookups(Math.max(0, Number(e.target.value) || 0))}
            />
            <span>time(s)</span>
          </label>
        </div>

        <div className="export-block">
          <div className="eyebrow">Columns</div>
          <div className="export-columns">
            {EXPORT_COLUMNS.map((c) => (
              <label key={c.key} className="check-wrap export-column" title={c.hint}>
                <input
                  type="checkbox"
                  checked={columns.includes(c.key)}
                  onChange={() => toggleColumn(c.key)}
                />
                <span>{c.label}</span>
              </label>
            ))}
          </div>
          <div className="export-presets">
            <button className="btn ghost small" onClick={() => setColumns(DEFAULT_COLUMNS)}>
              Reset
            </button>
            <button
              className="btn ghost small"
              onClick={() => setColumns(EXPORT_COLUMNS.map((c) => c.key))}
            >
              Select all
            </button>
          </div>
        </div>

        <div className="export-block">
          <div className="eyebrow">Format</div>
          <div className="seg-control">
            <button className={format === 'csv' ? 'on' : ''} onClick={() => setFormat('csv')}>
              CSV
            </button>
            <button className={format === 'json' ? 'on' : ''} onClick={() => setFormat('json')}>
              JSON
            </button>
          </div>
        </div>

        {canExport && (
          <div className="export-preview">
            <div style={{ overflowX: 'auto' }}>
              <table className="import-table">
                <thead>
                  <tr>
                    {orderedColumns.map((c) => (
                      <th key={c}>{EXPORT_COLUMNS.find((x) => x.key === c)?.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.map((card) => (
                    <tr key={card.id}>
                      {orderedColumns.map((c) => (
                        <td key={c}>{cellValue(card, c) ?? ''}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {selected.length > preview.length && (
              <p className="note">…and {selected.length - preview.length} more rows.</p>
            )}
          </div>
        )}

        {selected.length === 0 && <p className="note">Nothing matches this selection.</p>}
        {orderedColumns.length === 0 && <p className="note">Pick at least one column.</p>}

        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={runExport} disabled={!canExport}>
            Export {selected.length} {selected.length === 1 ? 'card' : 'cards'}
          </button>
        </div>
      </div>
    </div>
  )
}
