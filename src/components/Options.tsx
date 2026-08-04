import { useEffect, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db'
import { useSettings, saveSettings } from '../useSettings'
import { downloadFile } from '../export'
import {
  BackupError,
  backupFilename,
  parseBackup,
  readBackup,
  restoreBackup,
  spanDays,
  summarise,
  type RestoreMode,
  type TableSummary,
} from '../backup'

async function exportJson() {
  const [decks, cards] = await Promise.all([db.decks.toArray(), db.cards.toArray()])
  const payload = {
    exportedAt: new Date().toISOString(),
    decks: decks.map((d) => ({
      ...d,
      cards: cards.filter((c) => c.deckId === d.id),
    })),
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `flashy-export-${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  URL.revokeObjectURL(url)
}

const TABLE_LABELS: Record<string, string> = {
  decks: 'Decks',
  cards: 'Cards',
  reviews: 'Review answers',
  blacklist: 'Blacklisted words',
  settings: 'Settings',
  stories: 'Stories',
  snapshots: 'Daily snapshots',
  reading: 'Reading log',
  listening: 'Listening log',
  translations: 'Translation sessions',
}

function shortDay(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/** Rows, and — where the table has a time dimension — how many distinct days
 *  those rows cover against how many days they span. "5 days across 87" is the
 *  shape of a history with holes in it; the raw row count hides that. */
function TableRows({ summary }: { summary: TableSummary[] }) {
  return (
    <div className="backup-tables">
      {summary.map((t) => {
        const span = spanDays(t)
        return (
          <div key={t.name} className="backup-table-row">
            <span className="backup-table-name">{TABLE_LABELS[t.name] ?? t.name}</span>
            <span className="backup-table-count">{t.rows.toLocaleString()}</span>
            <span className="backup-table-span">
              {t.days !== undefined && span !== null
                ? `${t.days} ${t.days === 1 ? 'day' : 'days'} across ${span}` +
                  ` · ${shortDay(t.first!)} – ${shortDay(t.last!)}`
                : ''}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function BackupSection() {
  const [summary, setSummary] = useState<TableSummary[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // A parsed, validated file waiting for the user to choose how to apply it.
  const [pending, setPending] = useState<{
    backup: Awaited<ReturnType<typeof readBackup>>
    summary: TableSummary[]
    name: string
  } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // Summarise on mount so the numbers are visible without having to download
  // anything — this is the screen you come to when you suspect data is missing.
  useEffect(() => {
    readBackup().then((b) => setSummary(summarise(b)))
  }, [])

  async function download() {
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      const backup = await readBackup()
      setSummary(summarise(backup))
      downloadFile(backupFilename(), JSON.stringify(backup), 'application/json')
      setNote('Backup downloaded. Keep it somewhere off this device.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read the database.')
    } finally {
      setBusy(false)
    }
  }

  async function pickFile(file: File) {
    setError(null)
    setNote(null)
    try {
      const backup = parseBackup(await file.text())
      setPending({ backup, summary: summarise(backup), name: file.name })
    } catch (e) {
      setPending(null)
      setError(e instanceof BackupError ? e.message : 'Could not read that file.')
    }
    if (fileRef.current) fileRef.current.value = ''
  }

  async function apply(mode: RestoreMode) {
    if (!pending) return
    const warning =
      mode === 'replace'
        ? `Replace the whole database with “${pending.name}”? Everything currently on this device — including anything added since the backup — is deleted first. This cannot be undone.`
        : `Merge “${pending.name}” into this device? Rows from the backup overwrite any row with the same id; anything else is left alone. Only do this with a backup taken from this same device.`
    if (!confirm(warning)) return
    setBusy(true)
    setError(null)
    try {
      await restoreBackup(pending.backup, mode)
      const fresh = await readBackup()
      setSummary(summarise(fresh))
      setPending(null)
      setNote('Restored. Reload the app to see it everywhere.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The restore failed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="dash-section">
      <div className="eyebrow">Backup</div>

      <p className="note">
        Everything Flashy knows — your decks, every review answer, reading and listening time,
        saved stories — lives only in this browser’s storage on this one device. Nothing is on a
        server. Clearing site data, reinstalling, or a browser evicting storage takes all of it.
        A backup is the only copy.
      </p>

      {summary && (
        <>
          <div className="eyebrow" style={{ marginTop: '1.25rem' }}>
            In the database now
          </div>
          <TableRows summary={summary} />
        </>
      )}

      <div className="option-row">
        <div>
          <div className="option-name">Download a full backup</div>
          <div className="option-desc">
            Every table, as one JSON file. Unlike the card export on the deck screen, this
            includes your review history, reading log and daily snapshots — the things nothing
            else can rebuild.
          </div>
        </div>
        <button className="btn small primary" disabled={busy} onClick={download}>
          {busy ? 'Working…' : 'Download'}
        </button>
      </div>

      <div className="option-row">
        <div>
          <div className="option-name">Restore from a backup</div>
          <div className="option-desc">
            Reads the file and shows you what’s in it before anything is written.
          </div>
        </div>
        <>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void pickFile(f)
            }}
          />
          <button className="btn small" disabled={busy} onClick={() => fileRef.current?.click()}>
            Choose file
          </button>
        </>
      </div>

      {error && <p className="note error">{error}</p>}
      {note && <p className="note">{note}</p>}

      {pending && (
        <div className="backup-pending">
          <div className="option-name">{pending.name}</div>
          <div className="option-desc">
            Taken {pending.backup.exportedAt ? new Date(pending.backup.exportedAt).toLocaleString() : 'at an unknown time'}. Nothing has been written yet.
          </div>
          <TableRows summary={pending.summary} />
          <div className="backup-actions">
            <button className="btn small" disabled={busy} onClick={() => apply('merge')}>
              Merge into this device
            </button>
            <button className="btn small danger" disabled={busy} onClick={() => apply('replace')}>
              Replace everything
            </button>
            <button className="btn small ghost" disabled={busy} onClick={() => setPending(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  )
}

export function Options() {
  const settings = useSettings()
  const decks = useLiveQuery(() => db.decks.toArray())
  const blacklist = useLiveQuery(() => db.blacklist.toArray())

  return (
    <>
      <div className="page-head">
        <h1>Options</h1>
      </div>

      <section className="dash-section">
        <div className="eyebrow">Appearance</div>

        <div className="option-row">
          <div>
            <div className="option-name">Theme</div>
            <div className="option-desc">
              Night mode. “System” follows your device’s light/dark setting.
            </div>
          </div>
          <div className="seg-control">
            {(['system', 'light', 'dark'] as const).map((t) => (
              <button
                key={t}
                className={settings.theme === t ? 'on' : ''}
                onClick={() => saveSettings({ theme: t })}
              >
                {t === 'system' ? 'System' : t === 'light' ? 'Light' : 'Dark'}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="dash-section">
        <div className="eyebrow">Review</div>

        <div className="option-row">
          <div>
            <div className="option-name">Front of card</div>
            <div className="option-desc">Which side you see first during study.</div>
          </div>
          <div className="seg-control">
            <button
              className={settings.reviewFront === 'word' ? 'on' : ''}
              onClick={() => saveSettings({ reviewFront: 'word' })}
            >
              Word
            </button>
            <button
              className={settings.reviewFront === 'meaning' ? 'on' : ''}
              onClick={() => saveSettings({ reviewFront: 'meaning' })}
            >
              Meaning
            </button>
          </div>
        </div>

        <div className="option-row">
          <div>
            <div className="option-name">Hide word in example</div>
            <div className="option-desc">
              Blanks out the word in the front-side example sentence (____).
            </div>
          </div>
          <button
            className={`toggle${settings.maskExample ? ' on' : ''}`}
            role="switch"
            aria-checked={settings.maskExample}
            onClick={() => saveSettings({ maskExample: !settings.maskExample })}
          >
            <span className="knob" />
          </button>
        </div>

        <div className="option-row">
          <div>
            <div className="option-name">Speak words aloud</div>
            <div className="option-desc">
              Pronounces the word when it appears during study. Uses your device's system voices.
            </div>
          </div>
          <button
            className={`toggle${settings.autoSpeak ? ' on' : ''}`}
            role="switch"
            aria-checked={settings.autoSpeak}
            onClick={() => saveSettings({ autoSpeak: !settings.autoSpeak })}
          >
            <span className="knob" />
          </button>
        </div>

        <div className="option-row">
          <div>
            <div className="option-name">Show emoji on cards</div>
            <div className="option-desc">
              Displays each card's emoji mnemonic with the word during study and listening.
            </div>
          </div>
          <button
            className={`toggle${settings.showEmoji ? ' on' : ''}`}
            role="switch"
            aria-checked={settings.showEmoji}
            onClick={() => saveSettings({ showEmoji: !settings.showEmoji })}
          >
            <span className="knob" />
          </button>
        </div>

        <div className="option-row">
          <div>
            <div className="option-name">New cards per session</div>
            <div className="option-desc">Max unseen cards introduced per review session.</div>
          </div>
          <input
            className="num-input"
            type="number"
            min={0}
            max={200}
            value={settings.newPerSession}
            onChange={(e) =>
              saveSettings({
                newPerSession: Math.max(0, Math.min(200, Number(e.target.value) || 0)),
              })
            }
          />
        </div>

        <div className="option-row">
          <div>
            <div className="option-name">Scheduler</div>
            <div className="option-desc">
              FSRS is the modern algorithm with noticeably better-spaced intervals. Existing
              cards carry over either way.
            </div>
          </div>
          <div className="seg-control">
            <button
              className={settings.scheduler === 'sm2' ? 'on' : ''}
              onClick={() => saveSettings({ scheduler: 'sm2' })}
            >
              SM-2
            </button>
            <button
              className={settings.scheduler === 'fsrs' ? 'on' : ''}
              onClick={() => saveSettings({ scheduler: 'fsrs' })}
            >
              FSRS
            </button>
          </div>
        </div>

        <div className="option-row">
          <div>
            <div className="option-name">Daily goal</div>
            <div className="option-desc">
              Target reviews per day, shown on the dashboard and session summary. 0 disables it.
            </div>
          </div>
          <input
            className="num-input"
            type="number"
            min={0}
            max={1000}
            value={settings.dailyGoal}
            onChange={(e) =>
              saveSettings({
                dailyGoal: Math.max(0, Math.min(1000, Number(e.target.value) || 0)),
              })
            }
          />
        </div>
      </section>

      <section className="dash-section">
        <div className="eyebrow">AI</div>

        <div className="option-row">
          <div>
            <div className="option-name">Extended thinking</div>
            <div className="option-desc">
              Lets the model reason before answering when suggesting cards, writing stories, and
              picking emoji. Higher quality, but noticeably slower. Off favours speed.
            </div>
          </div>
          <button
            className={`toggle${settings.aiThinking ? ' on' : ''}`}
            role="switch"
            aria-checked={settings.aiThinking}
            onClick={() => saveSettings({ aiThinking: !settings.aiThinking })}
          >
            <span className="knob" />
          </button>
        </div>
      </section>

      <BackupSection />

      <section className="dash-section">
        <div className="eyebrow">Data</div>
        <div className="option-row">
          <div>
            <div className="option-name">Export as JSON</div>
            <div className="option-desc">
              Downloads all decks and their cards, including study state, as a JSON file.
            </div>
          </div>
          <button className="btn small" onClick={exportJson}>
            Export
          </button>
        </div>
      </section>

      <section className="dash-section">
        <div className="eyebrow">Blacklisted words</div>
        {!blacklist || blacklist.length === 0 ? (
          <p className="note">
            Nothing blacklisted. When generating cards, blacklist a suggestion to never see
            it again.
          </p>
        ) : (
          <div className="chip-list">
            {blacklist.map((b) => (
              <span key={b.id} className="chip">
                {b.word}
                <em>{decks?.find((d) => d.id === b.deckId)?.name}</em>
                <button
                  aria-label={`Remove ${b.word} from blacklist`}
                  onClick={() => db.blacklist.delete(b.id)}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
      </section>
    </>
  )
}
