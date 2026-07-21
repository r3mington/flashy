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
