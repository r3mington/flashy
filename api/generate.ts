import type { VercelRequest, VercelResponse } from '@vercel/node'
import { isAuthed } from './_lib/auth.js'

const BASE = 'https://generativelanguage.googleapis.com/v1beta'

/** Which job a request is for. `story` is the one creative call — writing the
 *  story itself. `fast` is everything else: translating, glossing, auditing,
 *  extracting — mechanical work over text that already exists. */
type Tier = 'story' | 'fast'

/** Pinned model ids, overridable per environment. Pinned on purpose: the
 *  `-latest` aliases moved under us and pulled in runtime discovery, warm-up
 *  races, cooldowns and alias tracking to cope. A pinned id either answers or
 *  fails with an error that names it, and changing it is one env var.
 *
 *  Checked against this key on 2026-09-23: `gemini-flash-latest` resolved to
 *  gemini-3.8-flash, and neither it nor 3.7 accepts thinkingLevel MINIMAL. */
function modelFor(tier: Tier): string {
  return tier === 'story'
    ? process.env.STORY_MODEL || 'gemini-3.8-flash'
    : process.env.FAST_MODEL || 'gemini-3.8-flash'
}

/** Where a request goes when its model is down, busy or too slow. Different
 *  from the primary so a bad day on one model isn't a bad day for the app. */
function fallbackModel(): string {
  return process.env.FALLBACK_MODEL || 'gemini-3.7-flash'
}

/** How hard the model thinks before answering.
 *  - minimal: no thinking. Right for mechanical passes, and by far the fastest.
 *  - medium: the story. Inventing something worth reading needs a moment of
 *    planning; writing it at no thinking gave the model's first, flattest idea.
 *  - high: what the reader's "think harder" setting asks for. */
type Effort = 'minimal' | 'medium' | 'high'

const THINKING: Record<Effort, object> = {
  minimal: { thinkingBudget: 0 },
  medium: { thinkingLevel: 'MEDIUM' },
  high: { thinkingLevel: 'HIGH' },
}

/** The function is killed at its maxDuration (300s — see vercel.json). The
 *  budget stops a few seconds short so the handler, not the platform, decides
 *  what happens when a model runs long. */
const FUNCTION_BUDGET_MS = 290_000

/** Held back from the first model so the fallback still has time to answer.
 *  Never more than half of what's left. */
const FALLBACK_RESERVE_MS = 70_000

/** Nothing useful comes back from a slice shorter than this. */
const MIN_SLICE_MS = 8_000

class UpstreamError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** Failures another model might not have: gone, busy, overloaded or too slow.
 *  A 400 is the request itself, and the fallback would reject it too. */
function worthFallingBack(e: unknown): boolean {
  if (!(e instanceof UpstreamError)) return true // network trouble
  return e.status === 404 || e.status === 429 || e.status >= 500
}

async function callModel(
  apiKey: string,
  model: string,
  prompt: string,
  schema: object,
  thinkingConfig: object,
  timeoutMs: number,
) {
  let res: Response
  try {
    res = await fetch(`${BASE}/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: schema,
          thinkingConfig,
        },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (e) {
    const name = (e as Error)?.name
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new UpstreamError(504, `${model} did not answer within ${Math.round(timeoutMs / 1000)}s.`)
    }
    throw e
  }
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

  const { prompt, schema, thinking, tier: rawTier, effort: rawEffort, budgetMs } = req.body ?? {}
  if (typeof prompt !== 'string' || !prompt || typeof schema !== 'object' || !schema) {
    return res.status(400).json({ error: 'Expected { prompt, schema }.' })
  }
  const tier: Tier = rawTier === 'story' ? 'story' : 'fast'
  // An explicit effort wins; otherwise the reader's "think harder" setting.
  const effort: Effort =
    rawEffort === 'minimal' || rawEffort === 'medium' || rawEffort === 'high'
      ? rawEffort
      : thinking === true
        ? 'high'
        : 'minimal'
  const label = typeof req.body?.label === 'string' ? req.body.label : 'call'
  // A caller that knows its ask is small can say so, and get its failure back
  // in time to retry. Clamped: the budget is ours to enforce.
  const budget = Math.min(
    FUNCTION_BUDGET_MS,
    Math.max(MIN_SLICE_MS, Number(budgetMs) || FUNCTION_BUDGET_MS),
  )
  const started = Date.now()
  // Logged before the work starts, so a request killed at the wall still
  // leaves a record of what it was attempting.
  console.log(
    JSON.stringify({ at: 'generate/start', label, tier, effort, budget, promptChars: prompt.length }),
  )

  const primary = modelFor(tier)
  const fallback = fallbackModel()
  const models = fallback === primary ? [primary] : [primary, fallback]
  let fellBack = false

  try {
    let data
    let model = primary
    for (const [i, m] of models.entries()) {
      model = m
      fellBack = i > 0
      const left = budget - (Date.now() - started)
      const last = i === models.length - 1
      const slice = last ? left : left - Math.min(FALLBACK_RESERVE_MS, Math.floor(left / 2))
      if (slice < MIN_SLICE_MS) {
        throw new UpstreamError(504, 'Ran out of time before the model answered.')
      }
      try {
        data = await callModel(apiKey, m, prompt, schema, THINKING[effort], slice)
        break
      } catch (e) {
        if (last || !worthFallingBack(e)) throw e
        console.warn(
          JSON.stringify({
            at: 'generate/fallback',
            label,
            from: m,
            to: models[i + 1],
            why: e instanceof Error ? e.message : String(e),
          }),
        )
      }
    }
    const text: string | undefined = data?.candidates?.[0]?.content?.parts?.[0]?.text
    if (!text) return res.status(502).json({ error: 'The model returned no usable output.' })

    const usage = data?.usageMetadata ?? {}
    // What the call actually cost. `thoughtTokens` is the reasoning done
    // before writing anything — invisible in the output, and usually why a
    // call was slow.
    const meta = {
      model,
      thinking: THINKING[effort],
      ms: Date.now() - started,
      promptTokens: usage.promptTokenCount,
      outputTokens: usage.candidatesTokenCount,
      thoughtTokens: usage.thoughtsTokenCount,
      finishReason: data?.candidates?.[0]?.finishReason,
      ...(fellBack ? { rescued: true } : {}),
    }
    console.log(JSON.stringify({ at: 'generate/done', label, tier, ...meta }))
    return res.status(200).json({ data: JSON.parse(text), meta })
  } catch (e) {
    const ms = Date.now() - started
    const message = e instanceof Error ? e.message : String(e)
    console.error(JSON.stringify({ at: 'generate/fail', label, tier, ms, message }))
    if (e instanceof UpstreamError) {
      // Don't leak upstream auth details; map key problems to a server error.
      const status = e.status === 401 || e.status === 403 ? 500 : e.status
      return res.status(status).json({ error: e.message })
    }
    return res.status(500).json({ error: 'Generation failed.' })
  }
}
