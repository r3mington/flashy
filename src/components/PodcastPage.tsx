import { useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, type PodcastStyle } from '../db'
import { useDeck } from '../useDeck'
import { useSettings, saveSettings } from '../useSettings'
import { useListeningTimer } from '../useListeningTimer'
import { splitSentences, countWords } from '../text'
import { formatAgo } from '../time'
import { clearMediaSession, setMediaPlaybackState, setMediaSession } from '../speech'
import {
  PODCAST_STYLES,
  PODCAST_VOICES,
  clipKey,
  ensureClips,
  fetchClip,
  markAt,
  parseWav,
  stitch,
  touchAndEvict,
  type Mark,
  type Pcm,
} from '../podcast'
import { Icon } from './Icon'

interface Props {
  deckId: number
  storyId?: number
  onPick: (storyId: number) => void
  onOpenStory: (storyId: number) => void
}

const RATE_MIN = 0.5
const RATE_MAX = 1.5
const RATE_STEP = 0.05
const PAUSE_MAX = 5
const PAUSE_STEP = 0.5

/** The podcast: pick a story, or play one in an AI voice. */
export function PodcastPage({ deckId, storyId, onPick, onOpenStory }: Props) {
  return storyId == null ? (
    <PodcastList deckId={deckId} onPick={onPick} />
  ) : (
    <PodcastPlayer deckId={deckId} storyId={storyId} onOpenStory={onOpenStory} />
  )
}

function PodcastList({ deckId, onPick }: { deckId: number; onPick: (id: number) => void }) {
  const { deck, langCode } = useDeck(deckId)
  const stories = useLiveQuery(
    () => db.stories.where('deckId').equals(deckId).reverse().sortBy('createdAt'),
    [deckId],
  )
  // Stories whose audio is already on the phone play straight away.
  const saved = useLiveQuery(async () => new Set(await db.podcastClips.orderBy('storyId').uniqueKeys()), [])
  if (!deck || !stories) return null
  return (
    <>
      <div className="page-head">
        <h1>Podcast</h1>
        <span className="sub">{deck.name} · your stories, read by an AI voice</span>
      </div>
      {stories.length === 0 ? (
        <p className="note">No stories yet. Write one from the deck screen, then come back to listen.</p>
      ) : (
        <div className="podcast-list">
          {stories.map((s) => (
            <button key={s.id} className="podcast-list-row" onClick={() => onPick(s.id)}>
              <span className="podcast-list-title">{s.title}</span>
              <span className="podcast-list-meta">
                {countWords(s.story, langCode).toLocaleString()} words · {formatAgo(s.createdAt)}
                {saved?.has(s.id) && ' · audio saved'}
              </span>
            </button>
          ))}
        </div>
      )}
    </>
  )
}

type Phase = 'idle' | 'making' | 'ready' | 'error'

function PodcastPlayer({
  deckId,
  storyId,
  onOpenStory,
}: {
  deckId: number
  storyId: number
  onOpenStory: (id: number) => void
}) {
  const { deck, langCode } = useDeck(deckId)
  const story = useLiveQuery(() => db.stories.get(storyId), [storyId])
  const settings = useSettings()
  const voice = settings.podcastVoice
  const style = settings.podcastStyle
  const rate = settings.podcastRate
  const pause = settings.podcastPause

  const sentences = useMemo(
    () => (story ? splitSentences(story.story, langCode).map((s) => s.trim()).filter(Boolean) : []),
    [story, langCode],
  )

  const audioRef = useRef<HTMLAudioElement | null>(null)
  const urlRef = useRef<string | null>(null)
  const pcmRef = useRef<Pcm[] | null>(null)
  const marksRef = useRef<Mark[]>([])
  const cancelRef = useRef(false)
  const [phase, setPhase] = useState<Phase>('idle')
  const [progress, setProgress] = useState({ ready: 0, total: 0 })
  const [error, setError] = useState('')
  const [playing, setPlaying] = useState(false)
  const [current, setCurrent] = useState(0)
  const [trying, setTrying] = useState<string | null>(null)
  const sentenceRefs = useRef<(HTMLButtonElement | null)[]>([])
  useListeningTimer(playing)

  // How much of this story is already made in the chosen voice and style.
  useEffect(() => {
    cancelRef.current = false
    let stale = false
    pcmRef.current = null
    stopTrack()
    setPhase('idle')
    if (sentences.length === 0) return
    void db.podcastClips
      .bulkGet(sentences.map((s) => clipKey(storyId, voice, style, s)))
      .then((rows) => {
        if (!stale) setProgress({ ready: rows.filter(Boolean).length, total: sentences.length })
      })
    return () => {
      stale = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storyId, voice, style, sentences])

  // Leaving the page stops everything, including clips still being made.
  useEffect(
    () => () => {
      cancelRef.current = true
      stopTrack()
      clearMediaSession()
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  function stopTrack() {
    const a = audioRef.current
    if (a) {
      a.pause()
      a.removeAttribute('src')
      a.load()
    }
    if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    urlRef.current = null
    setPlaying(false)
  }

  /** Stitch the clips with the current pause and load the track, keeping the
   *  place: it resumes at the start of the sentence it was on. */
  function loadTrack(at: number) {
    const pcm = pcmRef.current
    const a = audioRef.current
    if (!pcm || !a) return
    const { wav, marks } = stitch(pcm, pause)
    marksRef.current = marks
    if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    urlRef.current = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }))
    a.src = urlRef.current
    a.playbackRate = rate
    a.preservesPitch = true
    a.currentTime = marks[at]?.start ?? 0
  }

  async function prepare(): Promise<boolean> {
    setPhase('making')
    setError('')
    try {
      const blobs = await ensureClips({
        storyId,
        sentences,
        voice,
        style,
        onProgress: (ready, total) => setProgress({ ready, total }),
        cancelled: () => cancelRef.current,
      })
      pcmRef.current = await Promise.all(
        blobs.map(async (b) => parseWav(new Uint8Array(await b.arrayBuffer()))),
      )
      loadTrack(current)
      setPhase('ready')
      void touchAndEvict(storyId)
      return true
    } catch (e) {
      if (cancelRef.current) return false
      setError(e instanceof Error ? e.message : 'Could not make the audio.')
      setPhase('error')
      return false
    }
  }

  async function play(from?: number) {
    if (from != null) setCurrent(from)
    if (phase !== 'ready' && !(await prepare())) return
    const a = audioRef.current
    if (!a) return
    if (from != null) a.currentTime = marksRef.current[from]?.start ?? 0
    a.playbackRate = rate
    try {
      await a.play()
    } catch {
      /* the browser wants a tap first — the button is right there */
    }
  }

  function seek(idx: number) {
    const i = Math.max(0, Math.min(sentences.length - 1, idx))
    setCurrent(i)
    const a = audioRef.current
    if (a && phase === 'ready') a.currentTime = marksRef.current[i]?.start ?? 0
  }

  // Speed changes the playing track in place; the pause needs a re-stitch.
  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = rate
  }, [rate])
  useEffect(() => {
    if (phase !== 'ready') return
    const wasPlaying = playing
    loadTrack(current)
    if (wasPlaying) void audioRef.current?.play()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pause])

  // Lock-screen and headphone controls.
  useEffect(() => {
    if (!story) return
    setMediaSession({
      title: story.title,
      artist: deck?.name,
      onPlay: () => void play(),
      onPause: () => audioRef.current?.pause(),
      onPrev: () => seek(current - 1),
      onNext: () => seek(current + 1),
    })
  })

  // Keep the sentence being read in view.
  useEffect(() => {
    if (playing) sentenceRefs.current[current]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [current, playing])

  async function tryVoice(name: string) {
    setTrying(name)
    try {
      const sample = sentences[0] ?? 'Halo, apa kabar?'
      const blob = await fetchClip(sample.slice(0, 200), name, style)
      const a = new Audio(URL.createObjectURL(blob))
      a.playbackRate = rate
      a.preservesPitch = true
      await a.play()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not try that voice.')
    } finally {
      setTrying(null)
    }
  }

  if (!story || !deck) return null
  const madeAll = progress.total > 0 && progress.ready >= progress.total
  const changeRate = (d: number) =>
    saveSettings({ podcastRate: Math.round(Math.min(RATE_MAX, Math.max(RATE_MIN, rate + d)) * 100) / 100 })
  const changePause = (d: number) =>
    saveSettings({ podcastPause: Math.min(PAUSE_MAX, Math.max(0, pause + d)) })

  return (
    <>
      <div className="page-head">
        <h1>{story.title}</h1>
        <span className="sub">
          Podcast · {sentences.length} sentences ·{' '}
          <button className="link-btn" onClick={() => onOpenStory(story.id)}>
            open in the reader
          </button>
        </span>
      </div>

      <div className="podcast-page">
        <div className="podcast-controls">
          <div className="podcast-transport">
            <button
              className="btn ghost icon-btn"
              aria-label="Previous sentence"
              onClick={() => seek(current - 1)}
              disabled={current <= 0}
            >
              <Icon name="skipBack" />
            </button>
            {playing ? (
              <button className="btn primary podcast-play" onClick={() => audioRef.current?.pause()}>
                <Icon name="pause" /> Pause
              </button>
            ) : (
              <button
                className="btn primary podcast-play"
                onClick={() => play()}
                disabled={phase === 'making' || sentences.length === 0}
              >
                <Icon name="play" /> {phase === 'making' ? 'Making audio…' : 'Play'}
              </button>
            )}
            <button
              className="btn ghost icon-btn"
              aria-label="Next sentence"
              onClick={() => seek(current + 1)}
              disabled={current >= sentences.length - 1}
            >
              <Icon name="skipForward" />
            </button>
          </div>

          <p className="note podcast-status">
            {phase === 'making'
              ? `Making the audio: ${progress.ready} of ${progress.total} sentences. It plays as soon as all are ready, and is saved for next time.`
              : madeAll
                ? `Sentence ${current + 1} of ${sentences.length} · audio saved on this phone`
                : progress.ready > 0
                  ? `${progress.ready} of ${progress.total} sentences already made. Play makes the rest.`
                  : `The first play makes the audio, about ${Math.max(1, Math.round(sentences.length / 4) * 5)} seconds for this story, then it's saved.`}
          </p>
          {error && <p className="note error">{error}</p>}

          <div className="podcast-dials">
            <div className="story-rate" title="Playback speed">
              <span className="podcast-dial-label">Speed</span>
              <button className="btn small ghost" aria-label="Slower" onClick={() => changeRate(-RATE_STEP)} disabled={rate <= RATE_MIN}>
                −
              </button>
              <span>{Math.round(rate * 100)}%</span>
              <button className="btn small ghost" aria-label="Faster" onClick={() => changeRate(RATE_STEP)} disabled={rate >= RATE_MAX}>
                +
              </button>
            </div>
            <div className="story-rate" title="Silence after each sentence">
              <span className="podcast-dial-label">Pause</span>
              <button className="btn small ghost" aria-label="Shorter pause" onClick={() => changePause(-PAUSE_STEP)} disabled={pause <= 0}>
                −
              </button>
              <span>{pause.toFixed(1)} s</span>
              <button className="btn small ghost" aria-label="Longer pause" onClick={() => changePause(PAUSE_STEP)} disabled={pause >= PAUSE_MAX}>
                +
              </button>
            </div>
          </div>

          <div className="field">
            <label>Voice style</label>
            <div className="seg-control">
              {PODCAST_STYLES.map((s) => (
                <button
                  key={s.key}
                  className={style === s.key ? 'on' : ''}
                  title={s.hint}
                  disabled={phase === 'making'}
                  onClick={() => saveSettings({ podcastStyle: s.key as PodcastStyle })}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <label>Voice</label>
            <div className="podcast-voices">
              {PODCAST_VOICES.map((v) => (
                <div key={v.name} className={`podcast-voice${voice === v.name ? ' on' : ''}`}>
                  <button
                    className="podcast-voice-pick"
                    disabled={phase === 'making'}
                    onClick={() => saveSettings({ podcastVoice: v.name })}
                  >
                    <b>{v.name}</b> <span>{v.feel}</span>
                  </button>
                  <button
                    className="podcast-voice-try"
                    aria-label={`Try ${v.name}`}
                    title="Hear the first sentence in this voice"
                    disabled={trying !== null}
                    onClick={() => tryVoice(v.name)}
                  >
                    {trying === v.name ? '…' : <Icon name="volume" />}
                  </button>
                </div>
              ))}
            </div>
            <p className="note">Changing the voice or style makes new audio for the story the next time you play it.</p>
          </div>
        </div>

        <div className="podcast-text">
          {sentences.map((s, i) => (
            <button
              key={i}
              ref={(el) => {
                sentenceRefs.current[i] = el
              }}
              className={`podcast-sentence${i === current ? ' on' : ''}`}
              onClick={() => play(i)}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      <audio
        ref={audioRef}
        onPlay={() => {
          setPlaying(true)
          setMediaPlaybackState('playing')
        }}
        onPause={() => {
          setPlaying(false)
          setMediaPlaybackState('paused')
        }}
        onEnded={() => {
          setPlaying(false)
          setMediaPlaybackState('none')
        }}
        onTimeUpdate={(e) => {
          const i = markAt(marksRef.current, e.currentTarget.currentTime)
          setCurrent((c) => (c === i ? c : i))
        }}
      />
    </>
  )
}
