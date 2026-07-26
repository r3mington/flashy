/** Web Speech API helpers — system voices, no server or network involved. */

/** Deck languages are free text ("Indonesian", "Bahasa Indonesia", "Español"…);
 *  map English and native names to BCP-47 codes. Substring matching, so order
 *  matters where one name contains another (malayalam before malay, etc.). */
const LANG_CODES: Record<string, string> = {
  // "indonesia" also covers "indonesian" and "bahasa indonesia"
  indonesia: 'id',
  malayalam: 'ml',
  malay: 'ms',
  melayu: 'ms',
  spanish: 'es',
  español: 'es',
  espanol: 'es',
  french: 'fr',
  français: 'fr',
  francais: 'fr',
  german: 'de',
  deutsch: 'de',
  italian: 'it',
  italiano: 'it',
  portuguese: 'pt',
  português: 'pt',
  portugues: 'pt',
  dutch: 'nl',
  nederlands: 'nl',
  japanese: 'ja',
  日本語: 'ja',
  korean: 'ko',
  한국어: 'ko',
  mandarin: 'zh',
  chinese: 'zh',
  中文: 'zh',
  cantonese: 'yue',
  russian: 'ru',
  русский: 'ru',
  ukrainian: 'uk',
  arabic: 'ar',
  العربية: 'ar',
  hindi: 'hi',
  turkish: 'tr',
  türkçe: 'tr',
  vietnamese: 'vi',
  'tiếng việt': 'vi',
  thai: 'th',
  ไทย: 'th',
  polish: 'pl',
  polski: 'pl',
  swedish: 'sv',
  svenska: 'sv',
  norwegian: 'nb',
  norsk: 'nb',
  danish: 'da',
  dansk: 'da',
  finnish: 'fi',
  suomi: 'fi',
  greek: 'el',
  ελληνικά: 'el',
  hebrew: 'he',
  עברית: 'he',
  czech: 'cs',
  čeština: 'cs',
  romanian: 'ro',
  română: 'ro',
  hungarian: 'hu',
  magyar: 'hu',
  tagalog: 'fil',
  filipino: 'fil',
  swahili: 'sw',
  english: 'en',
}

export function langCodeFor(language: string): string | null {
  const norm = language.trim().toLowerCase()
  for (const [name, code] of Object.entries(LANG_CODES)) {
    if (norm.includes(name)) return code
  }
  return null
}

/** getVoices() is empty until the async voiceschanged event on some browsers,
 *  and Android's system TTS can take several seconds to report its list —
 *  poll patiently and also resolve on voiceschanged. */
export function loadVoices(): Promise<SpeechSynthesisVoice[]> {
  const now = speechSynthesis.getVoices()
  if (now.length > 0) return Promise.resolve(now)
  return new Promise((resolve) => {
    let settled = false
    const finish = (voices: SpeechSynthesisVoice[]) => {
      if (settled) return
      settled = true
      clearInterval(poll)
      clearTimeout(deadline)
      resolve(voices)
    }
    const poll = setInterval(() => {
      const v = speechSynthesis.getVoices()
      if (v.length > 0) finish(v)
    }, 300)
    const deadline = setTimeout(() => finish(speechSynthesis.getVoices()), 6000)
    speechSynthesis.addEventListener(
      'voiceschanged',
      () => finish(speechSynthesis.getVoices()),
      { once: true },
    )
  })
}

/** Notify when the browser updates its voice list (can happen well after load,
 *  e.g. when Android finishes downloading a language). Returns an unsubscribe. */
export function onVoicesChanged(cb: () => void): () => void {
  speechSynthesis.addEventListener('voiceschanged', cb)
  return () => speechSynthesis.removeEventListener('voiceschanged', cb)
}

/** Android reports some languages under Java's legacy ISO codes. */
const LEGACY_CODES: Record<string, string[]> = {
  id: ['id', 'in'], // Indonesian
  he: ['he', 'iw'], // Hebrew
  fil: ['fil', 'tl'], // Filipino/Tagalog
  yi: ['yi', 'ji'], // Yiddish
}

function langMatches(voiceLang: string, code: string): boolean {
  // Normalize "in_ID" → "in-id" so underscore locales match too.
  const norm = voiceLang.toLowerCase().replace(/_/g, '-')
  return (LEGACY_CODES[code] ?? [code]).some(
    (c) => norm === c || norm.startsWith(`${c}-`),
  )
}

/** Voices matching a language code, e.g. "id" matches "id-ID", "in_ID". Some
 *  platforms list the same voice name twice — dedupe, since we identify voices
 *  by name. */
export function voicesFor(voices: SpeechSynthesisVoice[], code: string | null) {
  if (!code) return []
  const seen = new Set<string>()
  return voices.filter((v) => {
    if (!langMatches(v.lang, code.toLowerCase()) || seen.has(v.name)) return false
    seen.add(v.name)
    return true
  })
}

const voicePrefKey = (code: string) => `flashy-voice-${code}`

export function savePreferredVoice(code: string, name: string) {
  localStorage.setItem(voicePrefKey(code), name)
}

export function preferredVoice(
  voices: SpeechSynthesisVoice[],
  code: string | null,
): SpeechSynthesisVoice | null {
  if (!code) return null
  const matching = voicesFor(voices, code)
  if (matching.length === 0) return null
  const saved = localStorage.getItem(voicePrefKey(code))
  return matching.find((v) => v.name === saved) ?? matching.find((v) => v.default) ?? matching[0]
}

export interface SpeakOptions {
  voice?: SpeechSynthesisVoice | null
  /** Fallback language when no explicit voice is set. */
  lang?: string
  rate?: number
}

/** Resolves when the utterance finishes (or is cancelled / fails). */
export function speak(text: string, opts: SpeakOptions = {}): Promise<void> {
  if (!('speechSynthesis' in window) || !text.trim()) return Promise.resolve()
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text)
    // Always set lang, even with an explicit voice: Android Chrome routinely
    // ignores utterance.voice and picks the engine voice by lang instead.
    if (opts.voice) {
      u.voice = opts.voice
      u.lang = opts.voice.lang
    } else if (opts.lang) {
      u.lang = opts.lang
    }
    u.rate = opts.rate ?? 1
    u.onend = () => resolve()
    u.onerror = () => resolve()
    speechSynthesis.speak(u)
  })
}

export function stopSpeaking() {
  if ('speechSynthesis' in window) speechSynthesis.cancel()
}

export const speechSupported = typeof window !== 'undefined' && 'speechSynthesis' in window

/** Some Chromium builds silently stop speechSynthesis after ~15s, and
 *  backgrounding a tab can pause it. resume() is a no-op while actively
 *  speaking, so pinging it on a timer keeps long, screen-off playback alive.
 *  Returns a stop function. */
export function keepSpeechAlive(): () => void {
  if (!('speechSynthesis' in window)) return () => {}
  const id = setInterval(() => {
    if (speechSynthesis.speaking) speechSynthesis.resume()
  }, 8000)
  return () => clearInterval(id)
}

/** A few seconds of genuine silence as a WAV blob URL, built once. Played (not
 *  muted) at normal volume, it emits no sound but marks the tab as "audible". */
let silenceUrl: string | null = null
function silenceSrc(): string {
  if (silenceUrl) return silenceUrl
  const rate = 8000
  const samples = rate * 5 // 5s, looped
  const buf = new ArrayBuffer(44 + samples)
  const view = new DataView(buf)
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i))
  }
  str(0, 'RIFF')
  view.setUint32(4, 36 + samples, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, rate, true)
  view.setUint32(28, rate, true) // byte rate
  view.setUint16(32, 1, true) // block align
  view.setUint16(34, 8, true) // bits/sample
  str(36, 'data')
  view.setUint32(40, samples, true)
  for (let i = 0; i < samples; i++) view.setUint8(44 + i, 128) // 8-bit silence
  silenceUrl = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }))
  return silenceUrl
}

let silenceEl: HTMLAudioElement | null = null

/** Hold audio focus for background playback. Android/Chrome freezes a
 *  backgrounded (screen-locked) tab's timers and speech unless the tab is
 *  "audible", so we loop silent audio at full volume — inaudible, but it keeps
 *  the tab alive so speechSynthesis keeps talking with the screen off, and
 *  anchors the media session for lock-screen controls. Must be called from a
 *  user gesture (autoplay). iOS/WebKit suspends speech regardless. Returns a
 *  release function. */
export function holdAudioFocus(): () => void {
  if (typeof Audio === 'undefined') return () => {}
  try {
    if (!silenceEl) {
      silenceEl = new Audio(silenceSrc())
      silenceEl.loop = true
    }
    silenceEl.currentTime = 0
    void silenceEl.play().catch(() => {})
  } catch {
    /* autoplay blocked or unsupported */
  }
  return () => {
    try {
      silenceEl?.pause()
    } catch {
      /* ignore */
    }
  }
}

export interface MediaSessionConfig {
  title: string
  artist?: string
  onPlay?: () => void
  onPause?: () => void
  onNext?: () => void
  onPrev?: () => void
}

const MEDIA_ACTIONS: MediaSessionAction[] = ['play', 'pause', 'previoustrack', 'nexttrack']

/** Publish now-playing info and lock-screen / headphone control handlers so a
 *  story read-aloud behaves like a podcast. No-op where unsupported. */
export function setMediaSession(cfg: MediaSessionConfig): void {
  if (!('mediaSession' in navigator)) return
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: cfg.title,
      artist: cfg.artist ?? 'Flashy',
    })
    const bind = (action: MediaSessionAction, handler?: () => void) => {
      try {
        navigator.mediaSession.setActionHandler(action, handler ? () => handler() : null)
      } catch {
        /* action unsupported on this platform */
      }
    }
    bind('play', cfg.onPlay)
    bind('pause', cfg.onPause)
    bind('previoustrack', cfg.onPrev)
    bind('nexttrack', cfg.onNext)
  } catch {
    /* MediaMetadata unsupported */
  }
}

export function setMediaPlaybackState(state: MediaSessionPlaybackState): void {
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = state
}

export function clearMediaSession(): void {
  if (!('mediaSession' in navigator)) return
  navigator.mediaSession.playbackState = 'none'
  for (const a of MEDIA_ACTIONS) {
    try {
      navigator.mediaSession.setActionHandler(a, null)
    } catch {
      /* ignore */
    }
  }
  navigator.mediaSession.metadata = null
}
