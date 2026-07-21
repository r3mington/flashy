import { useRef, useState } from 'react'
import { db, newCardDefaults } from '../db'
import { CARD_FIELDS, guessMapping, parseCsv, type CardField, type ParsedCsv } from '../csv'

interface Props {
  deckId: number
  onClose: () => void
}

export function ImportCsv({ deckId, onClose }: Props) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const [csv, setCsv] = useState<ParsedCsv | null>(null)
  const [mapping, setMapping] = useState<CardField[]>([])
  const [firstRowIsHeader, setFirstRowIsHeader] = useState(true)
  const [importing, setImporting] = useState(false)

  async function loadFile(file: File) {
    const text = await file.text()
    const parsed = parseCsv(text)
    setCsv(parsed)
    setMapping(guessMapping(parsed.headers))
  }

  const rows = csv ? (firstRowIsHeader ? csv.rows : [csv.headers, ...csv.rows]) : []
  const wordCol = mapping.indexOf('word')
  const meaningCol = mapping.indexOf('meaning')
  const canImport = wordCol !== -1 && meaningCol !== -1 && rows.length > 0

  async function runImport() {
    if (!csv || !canImport) return
    setImporting(true)
    const get = (row: string[], field: CardField) => {
      const i = mapping.indexOf(field)
      return i === -1 ? '' : (row[i] ?? '').trim()
    }
    const cards = rows
      .filter((row) => get(row, 'word') && get(row, 'meaning'))
      .map((row) => ({
        deckId,
        word: get(row, 'word'),
        meaning: get(row, 'meaning'),
        example: get(row, 'example'),
        exampleTranslation: get(row, 'exampleTranslation') || undefined,
        notes: get(row, 'notes') || undefined,
        ...newCardDefaults(),
      }))
    await db.cards.bulkAdd(cards)
    onClose()
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <h2>Import CSV</h2>

        {!csv ? (
          <>
            <div
              className={`drop-zone${over ? ' over' : ''}`}
              onClick={() => fileRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault()
                setOver(true)
              }}
              onDragLeave={() => setOver(false)}
              onDrop={(e) => {
                e.preventDefault()
                setOver(false)
                const file = e.dataTransfer.files[0]
                if (file) loadFile(file)
              }}
            >
              Drop a CSV file here, or click to choose one
            </div>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.tsv,text/csv"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) loadFile(file)
              }}
            />
            <p className="note">
              Any columns work — you'll map them to card fields in the next step. A word and a
              meaning column are required; example sentence is recommended.
            </p>
          </>
        ) : (
          <>
            <label className="note" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={firstRowIsHeader}
                onChange={(e) => setFirstRowIsHeader(e.target.checked)}
              />
              First row is a header
            </label>
            <div style={{ overflowX: 'auto' }}>
              <table className="import-table">
                <thead>
                  <tr>
                    {csv.headers.map((h, i) => (
                      <th key={i}>
                        <select
                          value={mapping[i]}
                          onChange={(e) => {
                            const next = [...mapping]
                            next[i] = e.target.value as CardField
                            setMapping(next)
                          }}
                        >
                          {CARD_FIELDS.map((f) => (
                            <option key={f.value} value={f.value}>
                              {f.label}
                            </option>
                          ))}
                        </select>
                        {firstRowIsHeader && <div style={{ marginTop: 4 }}>{h}</div>}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 5).map((row, ri) => (
                    <tr key={ri}>
                      {csv.headers.map((_, ci) => (
                        <td key={ci}>{row[ci]}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!canImport && (
              <p className="note">Map at least one column to Word and one to Meaning.</p>
            )}
            <div className="modal-actions">
              <button className="btn ghost left" onClick={() => setCsv(null)}>
                Choose another file
              </button>
              <button className="btn ghost" onClick={onClose}>
                Cancel
              </button>
              <button className="btn primary" onClick={runImport} disabled={!canImport || importing}>
                {importing ? 'Importing…' : `Import ${rows.length} rows`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
