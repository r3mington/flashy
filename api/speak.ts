import type { VercelRequest, VercelResponse } from '@vercel/node'
import { isAuthed } from './_lib/auth.js'

const BASE = 'https://generativelanguage.googleapis.com/v1beta'

/** Gemini's speech models: one sentence of text in, one clip of audio out.
 *  Pinned like the text models in generate.ts, overridable per environment. */
function models(): string[] {
  const primary = process.env.TTS_MODEL || 'gemini-3.8-flash-tts'
  const fallback = process.env.TTS_FALLBACK_MODEL || 'gemini-3.8-flash-lite-tts'
  return fallback === primary ? [primary] : [primary, fallback]
}

/** The prebuilt voices the podcast offers. Anything else is refused rather
 *  than passed on, so a typo is a clear error here instead of a vague one
 *  from Google. */
export const VOICES = ['Kore', 'Aoede', 'Leda', 'Zephyr', 'Puck', 'Charon', 'Orus', 'Fenrir']

/** How the voice is asked to speak. "Clear" and "Very clear" stand in for
 *  word gaps, which a generated clip can't have exactly: there is no way to
 *  say where in the audio one word ends. Asking for space between words is
 *  the nearest thing.
 *
 *  The notes and the transcript are marked off as sections because the
 *  speech model reads a plain "Say slowly:" prefix out loud as part of the
 *  text — checked by transcribing what came back. */
const STYLES: Record<string, string> = {
  natural: 'Relaxed, natural and everyday, the way a native speaker would say it to a friend.',
  clear: 'Slow and clear, for a language learner, with a small pause between words. Keep a natural tone.',
  veryclear: 'Very slow and very clear, for a beginner, with a short pause after every word.',
}

function speechPrompt(text: string, style: string): string {
  return `### DIRECTOR'S NOTES\nStyle: ${STYLES[style] ?? STYLES.natural}\n\n### TRANSCRIPT\n${text.trim()}`
}

/** Google returns ready WAV from some models and bare 16-bit PCM from others.
 *  The app only ever gets WAV. */
function asWav(bytes: Buffer, mimeType: string): Buffer {
  if (/wav/i.test(mimeType) || bytes.subarray(0, 4).toString('ascii') === 'RIFF') return bytes
  const rate = Number(/rate=(\d+)/.exec(mimeType)?.[1] ?? 24000)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + bytes.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(bytes.length, 40)
  return Buffer.concat([header, bytes])
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  if (!isAuthed(req.headers.cookie)) return res.status(401).json({ error: 'Not signed in' })
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) return res.status(500).json({ error: 'Server is missing GEMINI_API_KEY.' })

  const { text, voice, style } = req.body ?? {}
  if (typeof text !== 'string' || !text.trim() || text.length > 2000) {
    return res.status(400).json({ error: 'Expected { text } of up to 2000 characters.' })
  }
  if (!VOICES.includes(voice)) return res.status(400).json({ error: `Unknown voice "${voice}".` })

  let lastError = 'The voice returned no audio.'
  let lastStatus = 502
  for (const model of models()) {
    const started = Date.now()
    let r: Response
    try {
      r = await fetch(`${BASE}/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: speechPrompt(text, style) }] }],
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
          },
        }),
        signal: AbortSignal.timeout(45_000),
      })
    } catch (e) {
      lastError = `${model} did not answer in time.`
      lastStatus = 504
      console.warn(JSON.stringify({ at: 'speak/fail', model, message: (e as Error).message }))
      continue
    }
    if (!r.ok) {
      let message = `Request failed (${r.status})`
      try {
        message = (await r.json())?.error?.message ?? message
      } catch {
        /* keep generic message */
      }
      console.warn(JSON.stringify({ at: 'speak/fail', model, status: r.status, message }))
      lastError = message
      lastStatus = r.status === 401 || r.status === 403 ? 500 : r.status
      // A bad request is ours, and the other model would reject it too.
      if (r.status === 400) break
      continue
    }
    const data = await r.json()
    const blocked = data?.promptFeedback?.blockReason
    const part = data?.candidates?.[0]?.content?.parts?.find((p: any) => p?.inlineData?.data)
    if (!part) {
      const reason = blocked ?? data?.candidates?.[0]?.finishReason
      console.warn(JSON.stringify({ at: 'speak/empty', model, reason }))
      if (blocked) return res.status(422).json({ error: `Gemini refused to read this (${String(reason).toLowerCase()}).` })
      lastError = 'The voice returned no audio.'
      continue
    }
    const wav = asWav(Buffer.from(part.inlineData.data, 'base64'), part.inlineData.mimeType ?? '')
    console.log(
      JSON.stringify({ at: 'speak/done', model, voice, style, ms: Date.now() - started, chars: text.length, bytes: wav.length }),
    )
    return res.status(200).json({ audio: wav.toString('base64'), model })
  }
  return res.status(lastStatus).json({ error: lastError })
}
