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
 *  for the rest of the warm instance.
 *
 *  'fast' tries LOW before giving up on the level: not every model accepts
 *  MINIMAL, and the end of this chain is `null` — no thinking config at all,
 *  which means the model's DEFAULT thinking. On the pro model that default is
 *  slow enough to time the function out, so falling all the way through is the
 *  one outcome worth spending an extra rung to avoid. */
const THINKING_CONFIGS: Record<'fast' | 'quality', (object | null)[]> = {
  fast: [{ thinkingLevel: 'MINIMAL' }, { thinkingLevel: 'LOW' }, { thinkingBudget: 0 }, null],
  quality: [{ thinkingLevel: 'HIGH' }, null],
}

/** Which rung of the chain currently works, per model class — the tiers are
 *  different model generations and don't necessarily accept the same configs,
 *  so one tier's 400 must not push the other down its chain. */
const workingConfig: Record<string, number> = {}

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

  const { prompt, schema, thinking, tier: rawTier, effort } = req.body ?? {}
  if (typeof prompt !== 'string' || !prompt || typeof schema !== 'object' || !schema) {
    return res.status(400).json({ error: 'Expected { prompt, schema }.' })
  }
  const tier: Tier = rawTier === 'pro' ? 'pro' : 'fast'
  // Model class and reasoning effort are independent. The story is written in
  // two pro-tier passes that want opposite things: plotting needs to think and
  // returns almost nothing, while writing returns a whole story and has already
  // been told what happens. Thinking through the second one only buys a
  // timeout. Callers that say nothing keep the old behaviour — think only when
  // the user's toggle asks for it.
  const mode: 'fast' | 'quality' =
    effort === 'high' ? 'quality' : effort === 'minimal' ? 'fast' : thinking === true ? 'quality' : 'fast'
  const configs = THINKING_CONFIGS[mode]
  const chain = `${tier}:${mode}`
  const label = typeof req.body?.label === 'string' ? req.body.label : 'call'
  const started = Date.now()
  // Logged before the work starts, so a request that times out still leaves a
  // record of what it was attempting — the completion line never gets to run.
  console.log(
    JSON.stringify({ at: 'generate/start', label, tier, mode, promptChars: prompt.length }),
  )

  try {
    let data
    let model = resolvedModel[tier] ?? PREFERRED_MODEL[tier]
    let thinkingUsed: object | null = null
    let retries = 0
    // Walk the thinking-config chain: a 400 usually means this model generation
    // doesn't accept that config shape, so advance to the next and remember it.
    for (let attempt = 0; ; attempt++) {
      const i = Math.min(workingConfig[chain] ?? 0, configs.length - 1)
      try {
        model = resolvedModel[tier] ?? PREFERRED_MODEL[tier]
        thinkingUsed = configs[i]
        retries = attempt
        data = await callModel(apiKey, model, prompt, schema, configs[i])
        break
      } catch (e) {
        const badArgument = e instanceof UpstreamError && e.status === 400 && i < configs.length - 1
        const modelProblem =
          e instanceof UpstreamError && (e.status === 404 || /model/i.test(e.message))
        if (badArgument && attempt < configs.length) {
          workingConfig[chain] = i + 1
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

    const usage = data?.usageMetadata ?? {}
    // What the call actually cost and how it was configured. `thoughtTokens` is
    // the one that explains a slow call: it is the reasoning the model did
    // before writing anything, and it is invisible in the output.
    const meta = {
      model,
      thinking: thinkingUsed ?? 'model default',
      ms: Date.now() - started,
      promptTokens: usage.promptTokenCount,
      outputTokens: usage.candidatesTokenCount,
      thoughtTokens: usage.thoughtsTokenCount,
      finishReason: data?.candidates?.[0]?.finishReason,
      retries,
    }
    console.log(JSON.stringify({ at: 'generate/done', label, tier, ...meta }))
    return res.status(200).json({ data: JSON.parse(text), meta })
  } catch (e) {
    const ms = Date.now() - started
    if (e instanceof UpstreamError) {
      // Don't leak upstream auth details; map key problems to a server error.
      const status = e.status === 401 || e.status === 403 ? 500 : e.status
      console.error(JSON.stringify({ at: 'generate/fail', label, tier, ms, status, message: e.message }))
      return res.status(status).json({ error: e.message })
    }
    console.error(
      JSON.stringify({
        at: 'generate/fail',
        label,
        tier,
        ms,
        message: e instanceof Error ? e.message : String(e),
      }),
    )
    return res.status(500).json({ error: 'Generation failed.' })
  }
}
