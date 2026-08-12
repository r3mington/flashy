import type { VercelRequest, VercelResponse } from '@vercel/node'
import { isAuthed } from './_lib/auth.js'

const BASE = 'https://generativelanguage.googleapis.com/v1beta'

/** Which class of model a request wants. Nearly everything runs on `fast` —
 *  it is cheap and the job is mechanical. `pro` is for the two calls where the
 *  model has to actually plan: inventing a story's plot, and writing it. */
type Tier = 'fast' | 'pro'

const PREFERRED_MODEL: Record<Tier, string> = {
  fast: 'gemini-flash-latest',
  pro: 'gemini-pro-latest',
}

// Resolved lazily per warm instance; falls back to whatever model of that class
// the key can actually access.
const resolvedModel: Record<Tier, string | null> = { fast: null, pro: null }

async function pickAvailableModel(apiKey: string, tier: Tier): Promise<string> {
  const res = await fetch(`${BASE}/models?pageSize=200`, {
    headers: { 'x-goog-api-key': apiKey },
  })
  if (!res.ok) throw new UpstreamError(res.status, `Could not list available models (${res.status})`)
  const data = await res.json()
  const models: { name: string; supportedGenerationMethods?: string[] }[] = data.models ?? []
  const usable = models
    .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
    .map((m) => m.name.replace(/^models\//, ''))
  const want = tier === 'pro' ? /pro/ : /flash/
  const pick =
    usable.find((n) => want.test(n) && !/lite|preview|image|tts|live|exp/.test(n)) ??
    usable.find((n) => want.test(n)) ??
    // A key with no pro access still gets a story — a flash one is better than
    // an error the reader can do nothing about.
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

/** Gemini models "think" before answering by default, which multiplies latency.
 *  How thinking is controlled differs by model generation: Gemini 3-era models
 *  take thinkingLevel (and reject thinkingBudget), 2.5-era models take
 *  thinkingBudget (and reject thinkingLevel). Each mode lists configs to try in
 *  order; on a 400 the handler advances down the chain and remembers what stuck
 *  for the rest of the warm instance. */
const THINKING_CONFIGS: Record<'fast' | 'quality', (object | null)[]> = {
  fast: [{ thinkingLevel: 'MINIMAL' }, { thinkingBudget: 0 }, null],
  quality: [{ thinkingLevel: 'HIGH' }, null],
}
const workingConfig: Record<'fast' | 'quality', number> = { fast: 0, quality: 0 }

async function callModel(
  apiKey: string,
  model: string,
  prompt: string,
  schema: object,
  thinkingConfig: object | null,
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
        ...(thinkingConfig ? { thinkingConfig } : {}),
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

  const { prompt, schema, thinking, tier: rawTier } = req.body ?? {}
  if (typeof prompt !== 'string' || !prompt || typeof schema !== 'object' || !schema) {
    return res.status(400).json({ error: 'Expected { prompt, schema }.' })
  }
  const tier: Tier = rawTier === 'pro' ? 'pro' : 'fast'
  // Default fast: only "think" when the client explicitly opts in. A pro-tier
  // request is one that asked for reasoning by asking for that tier at all —
  // plotting is the job thinking exists for, so it never runs without it.
  const mode: 'fast' | 'quality' = thinking === true || tier === 'pro' ? 'quality' : 'fast'
  const configs = THINKING_CONFIGS[mode]

  try {
    let data
    // Walk the thinking-config chain: a 400 usually means this model generation
    // doesn't accept that config shape, so advance to the next and remember it.
    for (let attempt = 0; ; attempt++) {
      const i = Math.min(workingConfig[mode], configs.length - 1)
      try {
        const model = resolvedModel[tier] ?? PREFERRED_MODEL[tier]
        data = await callModel(apiKey, model, prompt, schema, configs[i])
        break
      } catch (e) {
        const badArgument = e instanceof UpstreamError && e.status === 400 && i < configs.length - 1
        const modelProblem =
          e instanceof UpstreamError && (e.status === 404 || /model/i.test(e.message))
        if (badArgument && attempt < configs.length) {
          workingConfig[mode] = i + 1
        } else if (modelProblem && attempt < configs.length + 1) {
          // Model not available for this account? Discover one that is and retry.
          resolvedModel[tier] = await pickAvailableModel(apiKey, tier)
        } else {
          throw e
        }
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
