/** The AI-voice podcast: a story read by a Gemini voice, one clip per
 *  sentence, stitched on the device into a single track with the reader's
 *  chosen silence between sentences.
 *
 *  One clip per sentence rather than one per story because everything the
 *  reader controls lives between sentences — the pause, where a skip lands,
 *  which sentence is lit — and a single generated track has no seams to find
 *  them by. One track to play rather than a clip at a time because a phone
 *  with its screen off stops running the page's timers, and a gap between two
 *  clips would be where playback died. */

import { db, type PodcastStyle } from './db'

export type { PodcastStyle }

/** Gemini's prebuilt voices offered here, with the feel Google gives each.
 *  Must match `VOICES` in api/speak.ts. */
export const PODCAST_VOICES: { name: string; feel: string }[] = [
  { name: 'Kore', feel: 'firm' },
  { name: 'Aoede', feel: 'breezy' },
  { name: 'Leda', feel: 'youthful' },
  { name: 'Zephyr', feel: 'bright' },
  { name: 'Puck', feel: 'upbeat' },
  { name: 'Charon', feel: 'informative' },
  { name: 'Orus', feel: 'steady' },
  { name: 'Fenrir', feel: 'lively' },
]

export const PODCAST_STYLES: { key: PodcastStyle; label: string; hint: string }[] = [
  { key: 'natural', label: 'Natural', hint: 'Everyday speed and rhythm' },
  { key: 'clear', label: 'Clear', hint: 'Slower, with space between words' },
  { key: 'veryclear', label: 'Very clear', hint: 'Slowest, a pause after every word' },
]

/** Stories whose audio is kept. Each minute of it is about 3 MB, and a story
 *  read a month ago is rarely played again. */
export const KEEP_STORIES = 10

/** Clips asked for at once. Enough to keep ahead of a listener, few enough
 *  not to trip the speech model's rate limit. */
const CONCURRENCY = 4

/** FNV-1a: a short, stable fingerprint of a sentence, so a story edited after
 *  its audio was made never plays a clip of the old words. */
export function textHash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

export function clipKey(storyId: number, voice: string, style: PodcastStyle, text: string): string {
  return `${storyId}|${voice}|${style}|${textHash(text.trim())}`
}

export class SpeakError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** One sentence, spoken. Retried twice on the failures that pass — a busy
 *  model, a dropped connection — with a growing wait between tries. */
export async function fetchClip(text: string, voice: string, style: PodcastStyle): Promise<Blob> {
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1500 * attempt * attempt))
    let res: Response
    try {
      res = await fetch('/api/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice, style }),
      })
    } catch {
      lastError =
        typeof navigator !== 'undefined' && navigator.onLine === false
          ? new SpeakError(0, 'You’re offline — making new audio needs a connection.')
          : new SpeakError(0, 'Could not reach the voice.')
      continue
    }
    if (res.ok) {
      const { audio } = (await res.json()) as { audio: string }
      const bytes = Uint8Array.from(atob(audio), (c) => c.charCodeAt(0))
      return new Blob([bytes], { type: 'audio/wav' })
    }
    let message = `Request failed (${res.status})`
    try {
      message = (await res.json())?.error ?? message
    } catch {
      /* keep generic message */
    }
    lastError = new SpeakError(res.status, message)
    if (res.status !== 429 && res.status < 500) break
  }
  throw lastError
}

/** Every sentence's clip, from the device where it is kept and from the voice
 *  where it isn't, saved as it arrives so a failure halfway loses nothing.
 *  `onProgress` gets how many of the story's clips are ready. */
export async function ensureClips(opts: {
  storyId: number
  sentences: string[]
  voice: string
  style: PodcastStyle
  onProgress?: (ready: number, total: number) => void
  /** Stop asking for more when this turns true — the reader left. */
  cancelled?: () => boolean
}): Promise<Blob[]> {
  const { storyId, sentences, voice, style, onProgress, cancelled } = opts
  const keys = sentences.map((s) => clipKey(storyId, voice, style, s))
  const stored = await db.podcastClips.bulkGet(keys)
  const clips: (Blob | undefined)[] = stored.map((r) => r?.audio)
  let ready = clips.filter(Boolean).length
  onProgress?.(ready, sentences.length)

  const missing = sentences.map((_, i) => i).filter((i) => !clips[i] && sentences[i].trim())
  let next = 0
  const worker = async () => {
    while (next < missing.length) {
      if (cancelled?.()) return
      const i = missing[next++]
      const audio = await fetchClip(sentences[i], voice, style)
      clips[i] = audio
      await db.podcastClips.put({ key: keys[i], storyId, usedAt: Date.now(), audio })
      onProgress?.(++ready, sentences.length)
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, missing.length) }, worker))
  if (cancelled?.()) throw new SpeakError(0, 'Cancelled.')
  // A blank sentence has no clip; it stitches as nothing.
  return clips.map((c) => c ?? new Blob([], { type: 'audio/wav' }))
}

/** Mark a story's audio as just played, then drop the audio of all but the
 *  `KEEP_STORIES` most recently played stories. */
export async function touchAndEvict(storyId: number): Promise<void> {
  const now = Date.now()
  await db.podcastClips.where('storyId').equals(storyId).modify({ usedAt: now })
  const last = new Map<number, number>()
  await db.podcastClips.each((c) => last.set(c.storyId, Math.max(last.get(c.storyId) ?? 0, c.usedAt)))
  const drop = [...last.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(KEEP_STORIES)
    .map(([id]) => id)
  if (drop.length > 0) await db.podcastClips.where('storyId').anyOf(drop).delete()
}

// ---------------------------------------------------------------- stitching

export interface Pcm {
  rate: number
  /** 16-bit little-endian mono samples. */
  samples: Uint8Array
}

/** The samples inside a 16-bit mono PCM WAV — what the speech model sends.
 *  Walks the chunks rather than assuming a 44-byte header. */
export function parseWav(bytes: Uint8Array): Pcm {
  if (bytes.length === 0) return { rate: 24000, samples: new Uint8Array() }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (o: number) => String.fromCharCode(...bytes.subarray(o, o + 4))
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a WAV file.')
  let rate = 24000
  let o = 12
  while (o + 8 <= bytes.length) {
    const id = tag(o)
    const size = view.getUint32(o + 4, true)
    if (id === 'fmt ') {
      const channels = view.getUint16(o + 10, true)
      rate = view.getUint32(o + 12, true)
      const bits = view.getUint16(o + 22, true)
      if (channels !== 1 || bits !== 16) throw new Error('Expected 16-bit mono audio.')
    } else if (id === 'data') {
      return { rate, samples: bytes.subarray(o + 8, Math.min(bytes.length, o + 8 + size)) }
    }
    o += 8 + size + (size % 2)
  }
  throw new Error('The WAV file has no audio data.')
}

/** Where each sentence sits in the stitched track, in seconds. */
export interface Mark {
  start: number
  end: number
}

/** All the clips as one WAV, `pauseSec` of silence after each sentence but the
 *  last, with the time span of every sentence. Clips at another sample rate
 *  than the first are refused rather than played at the wrong pitch. */
export function stitch(clips: Pcm[], pauseSec: number): { wav: Uint8Array<ArrayBuffer>; marks: Mark[] } {
  const rate = clips.find((c) => c.samples.length > 0)?.rate ?? 24000
  const pauseBytes = Math.round(pauseSec * rate) * 2
  const total = clips.reduce(
    (n, c, i) => n + c.samples.length + (i < clips.length - 1 ? pauseBytes : 0),
    0,
  )
  const out = new Uint8Array(44 + total)
  const view = new DataView(out.buffer)
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i)
  }
  str(0, 'RIFF')
  view.setUint32(4, 36 + total, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  str(36, 'data')
  view.setUint32(40, total, true)

  const marks: Mark[] = []
  let o = 44
  for (const [i, c] of clips.entries()) {
    if (c.samples.length > 0 && c.rate !== rate) throw new Error('The clips were made at different sample rates.')
    const start = (o - 44) / 2 / rate
    out.set(c.samples, o)
    o += c.samples.length
    marks.push({ start, end: (o - 44) / 2 / rate })
    // The silence is already there: a fresh array is all zeros.
    if (i < clips.length - 1) o += pauseBytes
  }
  return { wav: out, marks }
}

/** The sentence playing at `t` seconds — or, in a pause, the one just read. */
export function markAt(marks: Mark[], t: number): number {
  let idx = 0
  for (let i = 0; i < marks.length; i++) if (marks[i].start <= t + 1e-6) idx = i
  return idx
}
