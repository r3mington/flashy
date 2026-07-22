import type { VercelRequest, VercelResponse } from '@vercel/node'
import { isAuthed } from './_lib/auth.js'

const BASE = 'https://generativelanguage.googleapis.com/v1beta'
const PREFERRED_MODEL = 'gemini-flash-latest'

// Resolved lazily per warm instance; falls back to whatever flash model the key can access.
let resolvedModel: string | null = null

async function pickAvailableModel(apiKey: string): Promise<string> {
  const res = await fetch(`${BASE}/models?pageSize=200`, {
    headers: { 'x-goog-api-key': apiKey },
  })
  if (!res.ok) throw new UpstreamError(res.status, `Could not list available models (${res.status})`)
  const data = await res.json()
  const models: { name: string; supportedGenerationMethods?: string[] }[] = data.models ?? []
  const usable = models
    .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
    .map((m) => m.name.replace(/^models\//, ''))
  const pick =
    usable.find((n) => /flash/.test(n) && !/lite|preview|image|tts|live|exp/.test(n)) ??
    usable.find((n) => /flash/.test(n)) ??
    usable[0]
  if (!pick) throw new UpstreamError(500, 'No usable Gemini model found for this API key.')
  return pick
}

class UpstreamError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function callModel(
  apiKey: string,
  model: string,
  prompt: string,
  schema: object,
  // 2.5-era flash models "think" before answering by default, which multiplies
  // latency; skip it for these structured generation tasks. Models that reject
  // the field get one retry without it (see handler).
  disableThinking = true,
) {
  const res = await fetch(`${BASE}/models/${model}:generateContent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: schema,
        ...(disableThinking ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
      },
    }),
  })
  if (!res.ok) {
    let message = `Request failed (${res.status})`
    try {
      const err = await res.json()
      message = err?.error?.message ?? message
    } catch {
      /* keep generic message */
    }
    throw new UpstreamError(res.status, message)
  }
  return res.json()
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  if (!isAuthed(req.headers.cookie)) return res.status(401).json({ error: 'Not signed in' })

  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) return res.status(500).json({ error: 'Server is missing GEMINI_API_KEY.' })

  const { prompt, schema, thinking } = req.body ?? {}
  if (typeof prompt !== 'string' || !prompt || typeof schema !== 'object' || !schema) {
    return res.status(400).json({ error: 'Expected { prompt, schema }.' })
  }
  // Default fast: only "think" when the client explicitly opts in.
  const disableThinking = thinking !== true

  try {
    let data
    try {
      data = await callModel(apiKey, resolvedModel ?? PREFERRED_MODEL, prompt, schema, disableThinking)
    } catch (e) {
      const thinkingProblem =
        e instanceof UpstreamError && e.status === 400 && /think/i.test(e.message)
      const modelProblem =
        e instanceof UpstreamError && (e.status === 404 || /model/i.test(e.message))
      if (thinkingProblem) {
        // This model doesn't accept thinkingConfig — retry without it.
        data = await callModel(apiKey, resolvedModel ?? PREFERRED_MODEL, prompt, schema, true)
      } else if (modelProblem) {
        // Model not available for this account? Discover one that is and retry once.
        resolvedModel = await pickAvailableModel(apiKey)
        data = await callModel(apiKey, resolvedModel, prompt, schema, disableThinking)
      } else {
        throw e
      }
    }
    const text: string | undefined = data?.candidates?.[0]?.content?.parts?.[0]?.text
    if (!text) return res.status(502).json({ error: 'The model returned no usable output.' })
    return res.status(200).json({ data: JSON.parse(text) })
  } catch (e) {
    if (e instanceof UpstreamError) {
      // Don't leak upstream auth details; map key problems to a server error.
      const status = e.status === 401 || e.status === 403 ? 500 : e.status
      return res.status(status).json({ error: e.message })
    }
    return res.status(500).json({ error: 'Generation failed.' })
  }
}
