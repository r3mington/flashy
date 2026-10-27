import { useEffect, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  db,
  DEFAULT_STORY_COLORS,
  STORY_HUES,
  type StoryColors,
  type StoryHue,
} from '../db'
import { useSettings, saveSettings } from '../useSettings'
import { storyColorVars } from '../storyColors'
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
import { APPS_SCRIPT, SHEET_TAB, isAppsScriptUrl, saveToSheet } from '../sheets'

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

/** Connect a Google Sheet, see how the last save went, and save on demand.
 *  The setup steps sit here rather than in a help page because they are only
 *  ever read once, while doing them. */
function SheetSection() {
  const settings = useSettings()
  const connected = settings.sheetUrl !== ''
  const [draft, setDraft] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const link = draft ?? settings.sheetUrl
  // The last failure, if nothing has worked since.
  const lastError =
    settings.sheetLastError && settings.sheetLastAttempt > settings.sheetLastSync
      ? settings.sheetLastError
      : null

  async function save(url: string) {
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      const words = await saveToSheet(url)
      setNote(`Saved ${words.toLocaleString()} words to the “${SHEET_TAB}” tab.`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The save failed.')
    } finally {
      setBusy(false)
    }
  }

  async function connect() {
    const url = link.trim()
    if (!isAppsScriptUrl(url)) {
      setError(
        'That isn’t a Web app link. It should start with https://script.google.com/macros/s/ and end with /exec.',
      )
      return
    }
    await saveSettings({ sheetUrl: url })
    setDraft(null)
    // Save straight away: the first save is the test that the link works.
    await save(url)
  }

  async function disconnect() {
    if (!confirm('Stop saving to this Google Sheet? The sheet itself is left as it is.')) return
    await saveSettings({ sheetUrl: '', sheetLastError: '' })
    setDraft(null)
    setNote(null)
    setError(null)
  }

  async function copyScript() {
    try {
      await navigator.clipboard.writeText(APPS_SCRIPT)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setError('Couldn’t copy. Select the script in the box below and copy it by hand.')
    }
  }

  return (
    <section className="dash-section">
      <div className="eyebrow">Google Sheets</div>
      <p className="note">
        Keeps a copy of every word from every deck, with all its details, in one tab
        (“{SHEET_TAB}”) of a Google Sheet you own. Flashy saves once a day, the first time you
        open it, and each save replaces the whole tab. Other tabs are never touched.
      </p>

      {connected && (
        <div className="option-row">
          <div>
            <div className="option-name">Save now</div>
            <div className="option-desc">
              {settings.sheetLastSync
                ? `Last saved ${new Date(settings.sheetLastSync).toLocaleString()} — ${settings.sheetLastCount.toLocaleString()} words.`
                : 'Not saved yet.'}
            </div>
          </div>
          <button className="btn small primary" disabled={busy} onClick={() => save(settings.sheetUrl)}>
            {busy ? 'Saving…' : 'Save now'}
          </button>
        </div>
      )}
      {lastError && !error && <p className="note error">Last save failed: {lastError}</p>}

      <details className="sheet-setup" open={!connected}>
        <summary>{connected ? 'How it was set up' : 'Set it up — once, about five minutes'}</summary>
        <ol className="sheet-steps">
          <li>
            On a computer, open the Google Sheet you want to use, or make a new one at{' '}
            <a href="https://sheets.new" target="_blank" rel="noreferrer">sheets.new</a>.
          </li>
          <li>In the sheet’s menu, choose <b>Extensions → Apps Script</b>.</li>
          <li>
            Delete what’s in the editor, paste in the helper script below, and press the save
            icon.
          </li>
          <li>
            Press <b>Deploy → New deployment</b>. Click the gear next to “Select type” and choose{' '}
            <b>Web app</b>. Set “Execute as” to <b>Me</b> and “Who has access” to{' '}
            <b>Anyone</b>, then press <b>Deploy</b>.
          </li>
          <li>
            Google asks for permission. Choose your account. If it warns that Google hasn’t
            verified the app, press <b>Advanced</b>, then <b>Go to</b> your project — it’s your
            own script. Then <b>Allow</b>.
          </li>
          <li>
            Copy the <b>Web app</b> link (it ends in <code>/exec</code>). Send it to the device
            you use Flashy on, paste it below, and press <b>Connect</b>.
          </li>
        </ol>
        <p className="note">
          Anyone who has the link could replace the tab, so keep it private, like a password.
        </p>
        <div className="backup-actions">
          <button className="btn small" onClick={copyScript}>
            {copied ? 'Copied' : 'Copy helper script'}
          </button>
        </div>
        <div className="field">
          <textarea className="sheet-script" readOnly value={APPS_SCRIPT} rows={8} />
        </div>
      </details>

      <div className="field">
        <label htmlFor="sheet-url">Web app link</label>
        <input
          id="sheet-url"
          value={link}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="https://script.google.com/macros/s/…/exec"
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      <div className="backup-actions">
        <button
          className="btn small primary"
          disabled={busy || link.trim() === '' || link.trim() === settings.sheetUrl}
          onClick={connect}
        >
          {busy ? 'Saving…' : 'Connect'}
        </button>
        {connected && (
          <button className="btn small ghost" disabled={busy} onClick={disconnect}>
            Disconnect
          </button>
        )}
      </div>

      {error && <p className="note error">{error}</p>}
      {note && <p className="note">{note}</p>}
    </section>
  )
}

/** The four word kinds, in the order they matter while reading: what you don't
 *  know yet, what you're working on, who's in it, what you're done with. */
const COLOR_ROLES: { key: keyof StoryColors; label: string; sample: string }[] = [
  { key: 'new', label: 'New', sample: 'hilang' },
  { key: 'study', label: 'In study', sample: 'pasar' },
  { key: 'name', label: 'Names', sample: 'Dewi' },
  { key: 'known', label: 'Known', sample: 'kunci' },
]

/** Pick a colour per kind of word in a story. The preview above the swatches
 *  is the actual story markup under the actual CSS, so what you see is what
 *  the reader renders — no second implementation to keep in step. */
function StoryColorPicker({ colors }: { colors: StoryColors }) {
  const set = (key: keyof StoryColors, hue: StoryHue) =>
    saveSettings({ storyColors: { ...colors, [key]: hue } })

  return (
    <div className="option-row stacked">
      <div>
        <div className="option-name">Story word colours</div>
        <div className="option-desc">
          How each kind of word is coloured while reading. New words also get a soft background —
          they're the ones worth stopping for.
        </div>
      </div>
      <div className="story-colors">
        <p className="story-body story-colors-preview" style={storyColorVars(colors)}>
          <span className="story-word story-name">Dewi</span> tidak menemukan{' '}
          <span className="story-word plain">kunci</span> di{' '}
          <span className="story-word study-word">pasar</span> — sudah{' '}
          <span className="story-word new-word">hilang</span>.
        </p>
        {COLOR_ROLES.map((role) => (
          <div className="story-color-row" key={role.key}>
            <span className="story-color-label">{role.label}</span>
            <div className="swatches">
              {STORY_HUES.map((hue) => (
                <button
                  key={hue}
                  className={`swatch${colors[role.key] === hue ? ' on' : ''}`}
                  style={{ background: `var(--hue-${hue})` }}
                  title={hue === 'plain' ? 'Plain — same as the body text' : hue}
                  aria-label={`${role.label} words: ${hue}`}
                  aria-pressed={colors[role.key] === hue}
                  onClick={() => set(role.key, hue)}
                />
              ))}
            </div>
          </div>
        ))}
        <button
          className="btn ghost small"
          disabled={COLOR_ROLES.every((r) => colors[r.key] === DEFAULT_STORY_COLORS[r.key])}
          onClick={() => saveSettings({ storyColors: DEFAULT_STORY_COLORS })}
        >
          Reset to defaults
        </button>
      </div>
    </div>
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

        <StoryColorPicker colors={settings.storyColors} />
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
              Lets the model reason before answering when suggesting cards, picking emoji and
              grading translations. Higher quality, but noticeably slower. Off favours speed.
              Stories always reason, whatever this is set to — it is what makes the plot hold
              together.
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

      <SheetSection />

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
