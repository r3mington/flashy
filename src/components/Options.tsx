import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db'
import { useSettings, saveSettings } from '../useSettings'

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
