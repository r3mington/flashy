import type { VercelRequest, VercelResponse } from '@vercel/node'
import { isAuthed } from './_lib/auth.js'

const BASE = 'https://generativelanguage.googleapis.com/v1beta'

/** Which class of model a request wants. Nearly everything runs on `fast` —
 *  it is cheap and the job is mechanical. `pro` is for the two calls where the
 *  model has to actually plan: inventing a story's plot, and writing it. */
type Tier = 'fast' | 'pro'

/** Aliases Google keeps pointed at the current generation, so a model retiring
 *  doesn't need a code change here. If one of these ever stops working the
 *  handler discovers a replacement at runtime. */
const PREFERRED_MODEL: Record<Tier, string> = {
  fast: 'gemini-flash-latest',
  pro: 'gemini-pro-latest',
}

// Resolved lazily per warm instance; falls back to whatever model of that class
// the key can actually access.
const resolvedModel: Record<Tier, string | null> = { fast: null, pro: null }

/** Models this instance has watched refuse a request — retired, or never
 *  enabled for this key. A re-pick must never hand one of these back, which is
 *  the difference between recovering and retrying the same dead name forever. */
const deadModels = new Set<string>()

/** Shapes of model that can't write a story, whatever their tier. */
const NOT_FOR_STORIES = /lite|image|tts|live|audio|embedding|vision|robotics|computer-use/

/** Roughly how new a model is, from its name: gemini-3.1-pro → 3.1. Used to
 *  rank, so discovery lands on the newest model the key can reach rather than
 *  whichever one the list happens to mention first. */
function generation(name: string): number {
  const m = /(\d+)(?:[.-](\d+))?/.exec(name.replace(/^gemini-?/, ''))
  if (!m) return 0
  return Number(m[1]) + Number(m[2] ?? 0) / 10
}

function rank(name: string): number {
  let score = generation(name) * 10
  // A `-latest` alias tracks whatever Google promotes next, so it stays right
  // for longer than any pinned id — worth more than being one version ahead.
  if (/-latest$/.test(name)) score += 1000
  if (/preview|-exp|experimental/.test(name)) score -= 50
  if (/-\d{3}$/.test(name)) score -= 5 // dated snapshots are the first to retire
  return score
}

const newestFirst = (pool: string[]): string | undefined =>
  [...pool].sort((a, b) => rank(b) - rank(a))[0]

async function pickAvailableModel(apiKey: string, tier: Tier): Promise<string> {
  const res = await fetch(`${BASE}/models?pageSize=1000`, {
    headers: { 'x-goog-api-key': apiKey },
  })
  if (!res.ok) throw new UpstreamError(res.status, `Could not list available models (${res.status})`)
  const data = await res.json()
  const models: { name: string; supportedGenerationMethods?: string[] }[] = data.models ?? []
  const usable = models
    .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
    .map((m) => m.name.replace(/^models\//, ''))
    .filter((n) => /^gemini/.test(n) && !deadModels.has(n))
  const want = tier === 'pro' ? /pro/ : /flash/
  const pick =
    newestFirst(usable.filter((n) => want.test(n) && !NOT_FOR_STORIES.test(n))) ??
    newestFirst(usable.filter((n) => want.test(n))) ??
    // A key with no pro access still gets a story — a flash one is better than
    // an error the reader can do nothing about.
    newestFirst(usable.filter((n) => /flash/.test(n) && !NOT_FOR_STORIES.test(n))) ??
    newestFirst(usable)
  if (!pick) throw new UpstreamError(500, 'No usable Gemini model found for this API key.')
  console.log(JSON.stringify({ at: 'generate/repick', tier, pick, dead: [...deadModels] }))
  return pick
}

/** Upstream's way of saying "that model isn't yours to call": retired, renamed,
 *  or not on this key's allowlist. Deliberately narrower than "mentions a
 *  model" — a rejected thinking config also names the model, and mistaking one
 *  for the other sends the retry down the wrong branch. */
const MODEL_GONE = /no longer available|is not available|not found|does not exist|unknown model|deprecated|has been retired/i

function isModelUnavailable(e: unknown): boolean {
  if (!(e instanceof UpstreamError)) return false
  if (e.status === 404) return true
  return (e.status === 400 || e.status === 403) && /model/i.test(e.message) && MODEL_GONE.test(e.message)
}

/** Upstream usually names both halves of the story: the model that died and the
 *  one to use instead ("...no longer available. Please update your code to use
 *  models/x"). Everything before that hand-off is dead — including the id an
 *  alias resolved to, which is often the only place the real name appears — and
 *  the first id after it is a hint worth taking before going to discovery.
 *  Returns that hint, if there is a usable one of the right class. */
const HANDOFF = /update your code|please use|switch to|instead|we recommend/i

function noteDeadModel(called: string, tier: Tier, e: unknown): string | null {
  deadModels.add(called)
  if (!(e instanceof UpstreamError)) return null
  const at = e.message.search(HANDOFF)
  const gone = at === -1 ? e.message : e.message.slice(0, at)
  const handoff = at === -1 ? '' : e.message.slice(at)
  for (const m of gone.matchAll(/models\/([\w.-]+)/g)) deadModels.add(m[1])
  const hint = /models\/([\w.-]+)/.exec(handoff)?.[1]
  const wanted = tier === 'pro' ? /pro/ : /flash/
  return hint && !deadModels.has(hint) && wanted.test(hint) ? hint : null
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

/** The platform kills the function at its maxDuration (90s — see vercel.json),
 *  and a killed function returns an opaque 504 having burned the whole budget
 *  on nothing. Stop short of that ourselves, so what's left can still be spent
 *  on an answer. Keep this a few seconds under the vercel.json figure. */
const FUNCTION_BUDGET_MS = 85_000

/** Held back from a pro call so a flash-tier rescue still fits. Generous
 *  against the ~16s a flash story actually takes, because a rescue that gets
 *  cut off itself is the one failure this whole arrangement exists to avoid. */
const RESCUE_MS = 25_000

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
  timeoutMs: number,
) {
  let res: Response
  try {
    res = await fetch(`${BASE}/models/${model}:generateContent`, {
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
      // Cutting the call off ourselves is the whole point: a call left to run
      // into the platform's wall takes the function down with it, and there is
      // nothing left to fall back with.
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
  const label = typeof req.body?.label === 'string' ? req.body.label : 'call'
  const started = Date.now()
  // Logged before the work starts, so a request that times out still leaves a
  // record of what it was attempting — the completion line never gets to run.
  console.log(
    JSON.stringify({ at: 'generate/start', label, tier, mode, promptChars: prompt.length }),
  )

  // Outside the try: a failure needs to tell the client whether the fast-tier
  // fallback was already spent, so it doesn't go and spend it a second time.
  let rescued = false

  try {
    let data
    let model = resolvedModel[tier] ?? PREFERRED_MODEL[tier]
    let thinkingUsed: object | null = null
    let retries = 0
    // A pro call that runs long has somewhere to go, but only while there is
    // budget left to go there: once we fall back, `configs` and `chain` follow
    // the model down to the fast tier so a rejected config is remembered
    // against the model that actually rejected it.
    let configs = THINKING_CONFIGS[mode]
    let chain = `${tier}:${mode}`
    // Two independent things can be wrong with a request: the model, and the
    // thinking config. Each has its own recovery — re-pick, or step down the
    // chain — and the model is checked first, because an unavailable model also
    // returns a 400 and would otherwise burn the whole chain (and poison it for
    // every later request on this instance) without touching the real problem.
    const maxAttempts = configs.length + 3
    for (let attempt = 0; ; attempt++) {
      const useTier: Tier = rescued ? 'fast' : tier
      const i = Math.min(workingConfig[chain] ?? 0, configs.length - 1)
      model = resolvedModel[useTier] ?? PREFERRED_MODEL[useTier]
      thinkingUsed = configs[i]
      retries = attempt
      const left = FUNCTION_BUDGET_MS - (Date.now() - started)
      // Hold a flash-sized slice back while a fallback is still possible; once
      // there's nothing left to fall back to, spend everything on this call.
      const holdBack = tier === 'pro' && !rescued && left > RESCUE_MS * 2
      const slice = holdBack ? left - RESCUE_MS : left
      if (slice < 2_000) {
        throw new UpstreamError(504, 'Ran out of time before the model answered.')
      }
      try {
        data = await callModel(apiKey, model, prompt, schema, configs[i], slice)
        break
      } catch (e) {
        const tooSlow =
          e instanceof UpstreamError && (e.status === 504 || e.status === 503 || e.status === 429)
        if (attempt >= maxAttempts) throw e
        if (isModelUnavailable(e)) {
          const hint = noteDeadModel(model, useTier, e)
          try {
            resolvedModel[useTier] = hint ?? (await pickAvailableModel(apiKey, useTier))
          } catch {
            throw e // Discovery failed too; the original error is the useful one.
          }
        } else if (tooSlow && !rescued && tier === 'pro') {
          // The pro model ate its slice, or won't take the request at all right
          // now. A plainer story from the fast model beats a 504 the reader can
          // do nothing with, and there is still time in the budget for one.
          console.warn(JSON.stringify({ at: 'generate/rescue', label, model, why: e.message }))
          rescued = true
          configs = THINKING_CONFIGS.fast
          chain = 'fast:fast'
        } else if (e instanceof UpstreamError && e.status === 400 && i < configs.length - 1) {
          workingConfig[chain] = i + 1
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
      ...(rescued ? { rescued: true } : {}),
    }
    console.log(JSON.stringify({ at: 'generate/done', label, tier, ...meta }))
    return res.status(200).json({ data: JSON.parse(text), meta })
  } catch (e) {
    const ms = Date.now() - started
    if (e instanceof UpstreamError) {
      // Don't leak upstream auth details; map key problems to a server error.
      const status = e.status === 401 || e.status === 403 ? 500 : e.status
      console.error(JSON.stringify({ at: 'generate/fail', label, tier, ms, status, message: e.message }))
      return res.status(status).json({ error: e.message, ...(rescued ? { rescued: true } : {}) })
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
    return res.status(500).json({ error: 'Generation failed.', ...(rescued ? { rescued: true } : {}) })
  }
}
