import { useEffect, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db'
import { Icon } from './Icon'
import {
  langCodeFor,
  loadVoices,
  onVoicesChanged,
  preferredVoice,
  savePreferredVoice,
  speak,
  speechSupported,
  stopSpeaking,
  voicesFor,
} from '../speech'

interface Props {
  deckId: number
  onExit: () => void
}

type Scope = 'all' | 'learning'

/** One beat of a listening sequence: a string names what to speak, a number is
 *  a pause in milliseconds. */
type Step = 'meaning' | 'word' | 'example' | number

interface Sequence {
  id: string
  name: string
  steps: readonly Step[]
}

/** The sequences offered in the picker — add a new one by appending a row. */
const SEQUENCES: readonly Sequence[] = [
  {
    id: 'classic',
    name: 'Classic (with example)',
    steps: ['meaning', 'word', 'word', 'word', 'example', 600],
  },
  {
    id: 'en-3x',
    name: 'English, then 3×',
    steps: ['meaning', 'word', 'word', 'word', 2000],
  },
  {
    id: 'alt-4x',
    name: 'Alternating',
    steps: [
      'meaning',
      'word',
      'meaning',
      'word',
      'meaning',
      'word',
      'meaning',
      'word',
      2000,
    ],
  },
]

const DEFAULT_SEQUENCE = SEQUENCES[0]

function sequenceById(id: string): Sequence {
  return SEQUENCES.find((s) => s.id === id) ?? DEFAULT_SEQUENCE
}

/** Human-readable preview of a sequence, using the deck's own language name. */
function describeSequence(seq: Sequence, language: string): string {
  const label = (step: Step) =>
    typeof step === 'number'
      ? `${step >= 1000 ? `${step / 1000}s` : `${step}ms`} pause`
      : step === 'meaning'
        ? 'English'
        : step === 'word'
          ? language
          : 'example'
  // Collapse runs of the same part into "×n" so long sequences stay readable.
  const parts: string[] = []
  let run = 0
  seq.steps.forEach((step, i) => {
    run++
    if (seq.steps[i + 1] === step && typeof step !== 'number') return
    parts.push(run > 1 ? `${label(step)} ×${run}` : label(step))
    run = 0
  })
  return parts.join(' → ')
}

interface ListenOptions {
  rate: number
  /** 0 means infinite. */
  cycles: number
  scope: Scope
  /** Which of SEQUENCES to play for each card. */
  sequenceId: string
}

const DEFAULT_OPTIONS: ListenOptions = {
  rate: 0.9,
  cycles: 0,
  scope: 'all',
  sequenceId: DEFAULT_SEQUENCE.id,
}

const optionsKey = (deckId: number) => `flashy-listen-${deckId}`

function loadOptions(deckId: number): ListenOptions {
  try {
    return { ...DEFAULT_OPTIONS, ...JSON.parse(localStorage.getItem(optionsKey(deckId)) ?? '{}') }
  } catch {
    return DEFAULT_OPTIONS
  }
}

const delay = (ms: number) => new Promise((res) => setTimeout(res, ms))

const WAVE_BARS = 28

function Waveform({ playing }: { playing: boolean }) {
  return (
    <div className={`waveform${playing ? ' playing' : ''}`} aria-hidden="true">
      {Array.from({ length: WAVE_BARS }, (_, i) => (
        <span
          key={i}
          style={{
            // Deterministic pseudo-random rhythm per bar
            animationDuration: `${0.9 + ((i * 37) % 40) / 60}s`,
            animationDelay: `${-((i * 53) % 90) / 100}s`,
          }}
        />
      ))}
    </div>
  )
}

export function ListenPage({ deckId, onExit }: Props) {
  const deck = useLiveQuery(() => db.decks.get(deckId), [deckId])
  const cards = useLiveQuery(() => db.cards.where('deckId').equals(deckId).toArray(), [deckId])

  const [options, setOptions] = useState<ListenOptions>(() => loadOptions(deckId))
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])
  const [playing, setPlaying] = useState(false)
  const [pos, setPos] = useState({ cycle: 0, idx: 0 })

  // The playback loop reads live values through refs so option changes apply
  // mid-session, and an incremented run id cancels a superseded loop.
  const runRef = useRef(0)
  const optionsRef = useRef(options)
  optionsRef.current = options
  const voicesRef = useRef(voices)
  voicesRef.current = voices

  const langCode = deck ? langCodeFor(deck.language) : null

  useEffect(() => {
    loadVoices().then(setVoices)
    // Voice lists can change well after load (e.g. Android finishing a
    // language download) — pick that up without a reload.
    return onVoicesChanged(() => setVoices(speechSynthesis.getVoices()))
  }, [])

  function refreshVoices() {
    // A speak() call is what nudges some Android engines into (down)loading a
    // language; a brief utterance also repopulates the voice list.
    speak(' ', { lang: langCode ?? 'en' })
    loadVoices().then(setVoices)
  }

  // Stop the audio when leaving the page.
  useEffect(
    () => () => {
      runRef.current++
      stopSpeaking()
    },
    [],
  )

  function saveOptions(patch: Partial<ListenOptions>) {
    setOptions((prev) => {
      const next = { ...prev, ...patch }
      localStorage.setItem(optionsKey(deckId), JSON.stringify(next))
      return next
    })
  }

  const scoped = (cards ?? []).filter((c) => (options.scope === 'all' ? true : !c.known))

  if (!deck || !cards) return null

  const targetVoices = voicesFor(voices, langCode)
  const englishVoices = voicesFor(voices, 'en')
  const targetVoice = preferredVoice(voices, langCode)
  const englishVoice = preferredVoice(voices, 'en')

  async function playFrom(startCycle: number, startIdx: number) {
    const my = ++runRef.current
    stopSpeaking()
    setPlaying(true)
    const list = scoped
    for (let c = startCycle; optionsRef.current.cycles === 0 || c < optionsRef.current.cycles; c++) {
      for (let i = c === startCycle ? startIdx : 0; i < list.length; i++) {
        if (runRef.current !== my) return
        setPos({ cycle: c, idx: i })
        const card = list[i]
        const opts = optionsRef.current
        const v = voicesRef.current
        // Walk the chosen sequence: numbers are pauses, everything else is
        // spoken in the voice its content belongs to.
        for (const step of sequenceById(opts.sequenceId).steps) {
          if (runRef.current !== my) return
          if (typeof step === 'number') {
            await delay(step)
            continue
          }
          const text =
            step === 'meaning' ? card.meaning : step === 'word' ? card.word : card.example
          // Cards missing an example just skip that beat rather than pausing.
          if (!text.trim()) continue
          await delay(300)
          if (runRef.current !== my) return
          await speak(text, {
            voice: step === 'meaning' ? preferredVoice(v, 'en') : preferredVoice(v, langCode),
            lang: step === 'meaning' ? 'en' : (langCode ?? undefined),
            rate: opts.rate,
          })
        }
        if (runRef.current !== my) return
        await delay(600)
      }
      startIdx = 0
    }
    if (runRef.current === my) {
      setPlaying(false)
      setPos({ cycle: 0, idx: 0 })
    }
  }

  function pause() {
    runRef.current++
    stopSpeaking()
    setPlaying(false)
  }

  function stop() {
    runRef.current++
    stopSpeaking()
    setPlaying(false)
    setPos({ cycle: 0, idx: 0 })
  }

  function skip(delta: number) {
    const next = pos.idx + delta
    let { cycle, idx } = pos
    if (next < 0) {
      idx = 0
    } else if (next >= scoped.length) {
      cycle += 1
      idx = 0
      if (options.cycles !== 0 && cycle >= options.cycles) {
        stop()
        return
      }
    } else {
      idx = next
    }
    if (playing) {
      playFrom(cycle, idx)
    } else {
      setPos({ cycle, idx })
    }
  }

  const current = scoped[pos.idx]

  if (!speechSupported) {
    return (
      <div className="study-done">
        <div className="big">🔇</div>
        <h2>No speech support</h2>
        <p>This browser doesn't support the Web Speech API, so audio mode isn't available.</p>
        <button className="btn primary" onClick={onExit}>
          Back to deck
        </button>
      </div>
    )
  }

  return (
    <>
      <div className="page-head">
        <h1>Listen</h1>
        <span className="sub">
          {deck.name} · {scoped.length} {scoped.length === 1 ? 'word' : 'words'} in rotation
        </span>
      </div>

      <div className="listen-page">
        <div className="listen-stage">
          {current ? (
            <>
              {current.emoji && <div className="listen-emoji">{current.emoji}</div>}
              <div className="listen-word">{current.word}</div>
              <div className="listen-meaning">{current.meaning}</div>
              {current.example.trim() && <div className="listen-example">{current.example}</div>}
              <Waveform playing={playing} />
              <div className="listen-pos">
                word {pos.idx + 1}/{scoped.length} · cycle {pos.cycle + 1}
                {options.cycles === 0 ? ' of ∞' : ` of ${options.cycles}`}
              </div>
            </>
          ) : (
            <div className="listen-meaning">No words in scope.</div>
          )}
        </div>

        <div className="listen-controls">
          <button
            className="btn ghost"
            onClick={() => skip(-1)}
            disabled={!current}
            title="Previous word"
            aria-label="Previous word"
          >
            <Icon name="skipBack" />
          </button>
          {playing ? (
            <button className="btn accent listen-main" onClick={pause}>
              <Icon name="pause" /> Pause
            </button>
          ) : (
            <button
              className="btn accent listen-main"
              onClick={() => playFrom(pos.cycle, pos.idx)}
              disabled={!current}
            >
              <Icon name="play" /> {pos.idx > 0 || pos.cycle > 0 ? 'Resume' : 'Play'}
            </button>
          )}
          <button
            className="btn ghost"
            onClick={() => skip(1)}
            disabled={!current}
            title="Next word"
            aria-label="Next word"
          >
            <Icon name="skipForward" />
          </button>
          {(playing || pos.idx > 0 || pos.cycle > 0) && (
            <button
              className="btn ghost small icon-btn"
              onClick={stop}
              title="Stop and restart from the top"
              aria-label="Stop and restart from the top"
            >
              <Icon name="stop" />
            </button>
          )}
        </div>

        <div className="listen-options">
          <div className="field">
            <label htmlFor="listen-rate">Speech speed · {options.rate.toFixed(1)}×</label>
            <input
              id="listen-rate"
              type="range"
              min={0.5}
              max={1.5}
              step={0.1}
              value={options.rate}
              onChange={(e) => saveOptions({ rate: Number(e.target.value) })}
            />
          </div>

          <div className="field">
            <label htmlFor="listen-sequence">Sequence per word</label>
            <select
              id="listen-sequence"
              value={options.sequenceId}
              onChange={(e) => saveOptions({ sequenceId: e.target.value })}
            >
              {SEQUENCES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <p className="note sequence-preview">
              {describeSequence(sequenceById(options.sequenceId), deck.language)}
            </p>
          </div>

          <div className="field">
            <label htmlFor="listen-cycles">Cycles</label>
            <select
              id="listen-cycles"
              value={options.cycles}
              onChange={(e) => saveOptions({ cycles: Number(e.target.value) })}
            >
              <option value={0}>∞ (until stopped)</option>
              <option value={1}>1</option>
              <option value={2}>2</option>
              <option value={3}>3</option>
              <option value={5}>5</option>
              <option value={10}>10</option>
            </select>
          </div>

          <div className="field">
            <label htmlFor="listen-scope">Words in scope</label>
            <select
              id="listen-scope"
              value={options.scope}
              onChange={(e) => {
                stop()
                saveOptions({ scope: e.target.value as Scope })
              }}
            >
              <option value="all">All words</option>
              <option value="learning">Learning only (skip known)</option>
            </select>
          </div>

          <div className="field">
            <label htmlFor="listen-voice-target">{deck.language} voice</label>
            {targetVoices.length > 0 ? (
              <select
                id="listen-voice-target"
                value={targetVoice?.name ?? ''}
                onChange={(e) => {
                  if (langCode) savePreferredVoice(langCode, e.target.value)
                  setVoices([...voices]) // re-render with the new preference
                }}
              >
                {targetVoices.map((v) => (
                  <option key={v.name} value={v.name}>
                    {v.name} ({v.lang})
                  </option>
                ))}
              </select>
            ) : (
              <>
                <p className="note">
                  No {deck.language} voice detected — playback will still request {deck.language} by
                  language code, so the system default may handle it. Installing a {deck.language}{' '}
                  system voice (on Android: the Google Text-to-speech engine) works best.
                </p>
                <button className="btn ghost small" onClick={refreshVoices}>
                  ↻ Retry voice detection
                </button>
              </>
            )}
          </div>

          <details className="listen-voice-debug">
            <summary>
              {voices.length} system {voices.length === 1 ? 'voice' : 'voices'} detected
            </summary>
            {voices.length === 0 ? (
              <p className="note">
                The browser reports no speech voices at all. On Android, install/enable the Google
                Text-to-speech engine and reload.
              </p>
            ) : (
              <ul className="voice-debug-list">
                {[...voices]
                  .sort((a, b) => a.lang.localeCompare(b.lang))
                  .map((v, i) => (
                    <li key={`${v.name}-${v.lang}-${i}`}>
                      <code>{v.lang}</code> {v.name}
                      {v.localService ? '' : ' (network)'}
                    </li>
                  ))}
              </ul>
            )}
          </details>

          <div className="field">
            <label htmlFor="listen-voice-en">English voice</label>
            {englishVoices.length > 0 ? (
              <select
                id="listen-voice-en"
                value={englishVoice?.name ?? ''}
                onChange={(e) => {
                  savePreferredVoice('en', e.target.value)
                  setVoices([...voices])
                }}
              >
                {englishVoices.map((v) => (
                  <option key={v.name} value={v.name}>
                    {v.name} ({v.lang})
                  </option>
                ))}
              </select>
            ) : (
              <>
                <p className="note">No English voice detected — the browser default will be used.</p>
                <button className="btn ghost small" onClick={refreshVoices}>
                  ↻ Retry voice detection
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
