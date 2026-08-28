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

/** Every model this key can actually call right now: alive, story-shaped, and
 *  not currently benched. */
async function listModels(apiKey: string): Promise<string[]> {
  const res = await fetch(`${BASE}/models?pageSize=1000`, {
    headers: { 'x-goog-api-key': apiKey },
  })
  if (!res.ok) throw new UpstreamError(res.status, `Could not list available models (${res.status})`)
  const data = await res.json()
  const models: { name: string; supportedGenerationMethods?: string[] }[] = data.models ?? []
  return models
    .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
    .map((m) => m.name.replace(/^models\//, ''))
    .filter((n) => /^gemini/.test(n) && !deadModels.has(n) && !isCool(n))
}

const byRank = (pool: string[]) => [...pool].sort((a, b) => rank(b) - rank(a))

/** Models OF THIS CLASS, newest first. Strictly this class: a flash model is
 *  not a slow pro model's understudy here, whatever the ranking says — the
 *  caller decides when to change class, and it has to know that it did. */
async function rankedModels(apiKey: string, tier: Tier): Promise<string[]> {
  const usable = await listModels(apiKey)
  const want = tier === 'pro' ? /pro/ : /flash/
  return [
    ...new Set([
      ...byRank(usable.filter((n) => want.test(n) && !NOT_FOR_STORIES.test(n))),
      ...byRank(usable.filter((n) => want.test(n))),
    ]),
  ]
}

async function pickAvailableModel(apiKey: string, tier: Tier): Promise<string> {
  const pick =
    (await rankedModels(apiKey, tier))[0] ??
    // Only here, at the end of the line: a key with no pro access still gets a
    // story, because a flash one beats an error the reader can do nothing about.
    byRank((await listModels(apiKey)).filter((n) => !NOT_FOR_STORIES.test(n)))[0]
  if (!pick) throw new UpstreamError(500, 'No usable Gemini model found for this API key.')
  console.log(
    JSON.stringify({
      at: 'generate/repick',
      tier,
      pick,
      dead: [...deadModels],
      benched: Object.keys(coolUntil).filter(isCool),
    }),
  )
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

/** A model that has answered a real request in this instance. Until there is
 *  one, the handler doesn't know which models are healthy right now — and the
 *  expensive way to find out is to hand one a story and wait. */
const proven: Record<Tier, string | null> = { fast: null, pro: null }

/** How long the warm-up race waits. A healthy model answers a one-line prompt
 *  in well under a second; anything still quiet at this point is queueing,
 *  which is exactly what we are trying not to find out the expensive way. */
const PING_MS = 12_000

/** Ask several models for almost nothing, at once, and take whoever answers
 *  first. Two dozen tokens buys what used to cost a minute of the budget and a
 *  thrown-away story: proof that the model about to be given the real work is
 *  awake. Losers are abandoned, not benched — being second to answer "hi" is
 *  not evidence of anything. */
/** How quickly the winner of a race has to answer for its class to be worth
 *  using. A healthy model returns one short sentence in well under a second.
 *  Measured: on a day when the pro fleet was loaded, the best pro model took
 *  3.3s to answer the ping and then failed to write a story inside a minute —
 *  the ping had already said so, and the story paid for it anyway. */
const PING_HEALTHY_MS = 2_000

async function raceForModel(
  apiKey: string,
  tier: Tier,
  label: string,
): Promise<{ model: string; ms: number } | null> {
  let candidates: string[]
  try {
    candidates = await rankedModels(apiKey, tier)
  } catch {
    return null // Can't list models; the caller's existing pick still stands.
  }
  const first = resolvedModel[tier] ?? PREFERRED_MODEL[tier]
  const field = [first, ...candidates.filter((m) => m !== first)]
    .filter((m) => !deadModels.has(m) && !isCool(m))
    .slice(0, 3)
  if (field.length === 0) return null

  const started = Date.now()
  const stop = new AbortController()
  const ping = async (model: string) => {
    const res = await fetch(`${BASE}/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'Write one short sentence.' }] }],
        // Enough output that a model queueing real work has to reveal it, and
        // few enough tokens that racing three of them costs nothing.
        generationConfig: { maxOutputTokens: 24 },
      }),
      signal: AbortSignal.any([stop.signal, AbortSignal.timeout(PING_MS)]),
    })
    // Nothing but a clean answer counts. An earlier version let anything that
    // wasn't a 5xx through, and promptly handed a story to a retired model
    // that had answered the ping with a 404.
    if (!res.ok) throw new UpstreamError(res.status, `${model} answered ${res.status}`)
    return model
  }

  try {
    const winner = await Promise.any(field.map(ping))
    stop.abort()
    const ms = Date.now() - started
    console.log(JSON.stringify({ at: 'generate/warm', label, tier, winner, field, ms }))
    return { model: winner, ms }
  } catch {
    stop.abort()
    console.warn(JSON.stringify({ at: 'generate/warm-none', label, tier, field }))
    return null
  }
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
 *  MINIMAL. The last rung, `null`, is no thinking config at all — the model's
 *  DEFAULT thinking, which on a pro model is slow enough to eat the entire
 *  function budget. So the pro chain stops one rung short: a request that runs
 *  out of cheap configs there is better off on the fast model than on a pro
 *  model left to think for as long as it likes. */
// Order matters, and it is about tokens: MINIMAL where a model takes it, then
// the 2.5-era way of saying the same thing, and only then LOW — which is real
// reasoning and bills for it (a top-up pass was measured at 10,592 thought
// tokens on LOW). A model that rejects a rung costs one 400 and half a second,
// remembered for the rest of the instance.
const CHEAP_THINKING = [{ thinkingLevel: 'MINIMAL' }, { thinkingBudget: 0 }, { thinkingLevel: 'LOW' }]

function chainFor(tier: Tier, mode: 'fast' | 'quality'): (object | null)[] {
  if (mode === 'quality') return [{ thinkingLevel: 'HIGH' }, null]
  return tier === 'pro' ? CHEAP_THINKING : [...CHEAP_THINKING, null]
}

/** The one real constraint here is the platform's: the function is killed at
 *  its maxDuration (300s — see vercel.json, and the ceiling of the plan), and a
 *  killed function returns an opaque 504 having spent its tokens on output we
 *  never receive. So the budget is set as high as the platform allows and cut a
 *  few seconds short of the wall, purely so the handler — not the platform —
 *  decides what happens when a model runs long. Waiting longer is cheaper than
 *  timing out: a timeout bills for a story nobody reads, and then pays again
 *  for the fallback that replaces it. */
const FUNCTION_BUDGET_MS = 290_000

/** Held back from a pro call so a flash-tier rescue still fits. Sized well past
 *  what the pipeline's flash passes actually take (a 1,000-word story has run
 *  to ~50s): a rescue that gets cut off itself is the one failure this whole
 *  arrangement exists to prevent, and the pro attempt still keeps the lion's
 *  share of the budget. */
const RESCUE_MS = 70_000

/** Nothing useful comes back from a slice this short — better to say the budget
 *  is spent than to start a call that cannot finish. */
const MIN_SLICE_MS = 8_000

/** The longest one attempt may run while another is still affordable. Measured:
 *  a healthy model writes a 1,000-word story in 33–37s, while the overloaded
 *  ones simply never answered. The cap sits between those, so a bad day is
 *  spotted in a minute and the budget buys a different model instead of more
 *  waiting. Without it, one busy model can spend everything before the second
 *  gets a turn — which is exactly what happened at 290s. */
const MAX_ATTEMPT_MS = 60_000

/** How long a model stays skipped after it proves it can't answer inside the
 *  budget. A story is a dozen calls; paying the same model's full slice on
 *  every one of them, to time out every time, is how one slow model turns into
 *  a failed generation.
 *
 *  Per MODEL, not per tier, because that is where the problem actually lives:
 *  measured against this key, `gemini-flash-latest` took 101 seconds over two
 *  sentences (and 503'd on the next try) while `gemini-3.6-flash` answered the
 *  same prompt in 2.2. Nothing about the tier was wrong — one model was busy. */
const SLOW_COOLDOWN_MS = 10 * 60_000

/** When each model is worth trying again. */
const coolUntil: Record<string, number> = {}

/** What an alias turned out to point at, learned from `modelVersion` on a
 *  successful response. Without it, cooling `gemini-flash-latest` and then
 *  picking `gemini-3.7-flash` just queues behind the same busy model. */
const resolvesTo: Record<string, string> = {}

function isCool(model: string): boolean {
  return (coolUntil[model] ?? 0) > Date.now()
}

/** Bench a model, and with it every name known to mean the same model. */
function coolDown(model: string, label: string, why: string) {
  const until = Date.now() + SLOW_COOLDOWN_MS
  const same = new Set([model, resolvesTo[model]].filter(Boolean) as string[])
  for (const [alias, target] of Object.entries(resolvesTo)) {
    if (target === model || target === resolvesTo[model]) same.add(alias)
  }
  for (const name of same) coolUntil[name] = until
  console.warn(JSON.stringify({ at: 'generate/cooldown', label, benched: [...same], why }))
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
      throw new UpstreamError(
        504,
        `${model} did not answer within ${Math.round(timeoutMs / 1000)}s.`,
      )
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

  const { prompt, schema, thinking, tier: rawTier, effort, budgetMs, preferModel } = req.body ?? {}
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
  // A caller that knows its ask is small can say so, and get its failure back
  // in time to do something about it. Clamped: the budget is ours to enforce.
  const budget = Math.min(
    FUNCTION_BUDGET_MS,
    Math.max(MIN_SLICE_MS, Number(budgetMs) || FUNCTION_BUDGET_MS),
  )
  const started = Date.now()
  // Logged before the work starts, so a request that times out still leaves a
  // record of what it was attempting — the completion line never gets to run.
  console.log(
    JSON.stringify({ at: 'generate/start', label, tier, mode, budget, promptChars: prompt.length }),
  )

  // Outside the try: a failure needs to tell the client whether the fast-tier
  // fallback was already spent, so it doesn't go and spend it a second time.
  // A pro model still benched starts on the fast tier instead — the toll it
  // charges to fail again is the whole point of remembering.
  // A model the caller has seen answer quickly, from an earlier session this
  // instance knows nothing about. Cold starts otherwise begin every time on the
  // `-latest` alias — the most-used endpoint, and so the likeliest to be under
  // load. Ignored if it has since died or been benched here.
  if (typeof preferModel === 'string' && /^[\w.-]{1,64}$/.test(preferModel)) {
    const wanted = tier === 'pro' ? /pro/ : /flash/
    if (wanted.test(preferModel) && !deadModels.has(preferModel) && !isCool(preferModel)) {
      resolvedModel[tier] ??= preferModel
    }
  }
  let rescued = tier === 'pro' && isCool(resolvedModel.pro ?? PREFERRED_MODEL.pro)
  if (rescued) console.warn(JSON.stringify({ at: 'generate/skip-pro', label }))

  try {
    let data
    let model = resolvedModel[tier] ?? PREFERRED_MODEL[tier]
    let thinkingUsed: object | null = null
    let retries = 0
    // A pro call that runs long has somewhere to go, but only while there is
    // budget left to go there: once we fall back, `configs` and `chain` follow
    // the model down to the fast tier so a rejected config is remembered
    // against the model that actually rejected it.
    let configs = chainFor(rescued ? 'fast' : tier, mode)
    let chain = `${rescued ? 'fast' : tier}:${mode}`

    // Nothing here has answered a real request yet, so nothing here knows which
    // models are healthy today. Find out for twenty tokens rather than for a
    // story: the race commits the expensive call to a model that has just
    // spoken. Once one has, later requests skip this entirely.
    if (!proven[rescued ? 'fast' : tier]) {
      let useTier: Tier = rescued ? 'fast' : tier
      let winner = await raceForModel(apiKey, useTier, label)
      // The race measures as well as chooses. A pro field whose quickest
      // member is sluggish is a loaded pro field, and the story is better off
      // on the fast tier than finding that out a minute from now.
      if (useTier === 'pro' && (!winner || winner.ms > PING_HEALTHY_MS)) {
        console.warn(
          JSON.stringify({ at: 'generate/pro-loaded', label, ms: winner?.ms ?? null }),
        )
        rescued = true
        useTier = 'fast'
        configs = chainFor('fast', mode)
        chain = `fast:${mode}`
        winner = proven.fast ? null : await raceForModel(apiKey, 'fast', label)
      }
      if (winner) resolvedModel[useTier] = winner.model
    }

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
      if (isCool(model)) {
        // Benched since we last resolved this tier: find something else rather
        // than queue behind a model already known to be struggling.
        try {
          model = resolvedModel[useTier] = await pickAvailableModel(apiKey, useTier)
        } catch {
          // Nothing else on this tier. Better a slow answer than none: serve
          // the benched model and let the deadline decide.
        }
      }
      thinkingUsed = configs[i]
      retries = attempt
      const left = budget - (Date.now() - started)
      // Hold a slice back while a fallback is still possible — never more than
      // half of what's left, so a small budget still splits in two rather than
      // handing everything to the attempt most likely to overrun.
      const reserve = Math.min(RESCUE_MS, Math.floor(left / 2))
      const holdBack = tier === 'pro' && !rescued && left - reserve >= MIN_SLICE_MS
      const share = holdBack ? left - reserve : left
      // Cap it while there would still be time for another attempt afterwards.
      const slice =
        left > MAX_ATTEMPT_MS + MIN_SLICE_MS ? Math.min(share, MAX_ATTEMPT_MS) : share
      if (slice < MIN_SLICE_MS) {
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
        } else if (e instanceof UpstreamError && e.status === 400 && i < configs.length - 1) {
          workingConfig[chain] = i + 1
        } else if (tooSlow) {
          // Not the tier's fault and not the request's: this model is busy, or
          // slower right now than the work deserves. Bench it — for this call
          // and for the rest of the story — and let the next attempt pick
          // something else. Dropping a pro request to the fast class at the
          // same time, since the story is late already.
          coolDown(model, label, e.message)
          if (!rescued && tier === 'pro') {
            rescued = true
            configs = chainFor('fast', mode)
            chain = `fast:${mode}`
          } else {
            // Already on the fast class, so the only move left is a different
            // model. If there isn't one, retrying the benched model is just the
            // same wait again — give the caller the error instead.
            try {
              resolvedModel[useTier] = await pickAvailableModel(apiKey, useTier)
            } catch {
              throw e
            }
          }
        } else if (!rescued && tier === 'pro' && e instanceof UpstreamError && e.status === 400) {
          // Out of cheap thinking configs on pro, and the only rung left there
          // is the expensive one. A plainer story from the fast model beats a
          // slow one that never arrives.
          console.warn(JSON.stringify({ at: 'generate/rescue', label, model, why: e.message }))
          rescued = true
          configs = chainFor('fast', mode)
          chain = `fast:${mode}`
        } else {
          throw e
        }
      }
    }
    const text: string | undefined = data?.candidates?.[0]?.content?.parts?.[0]?.text
    if (!text) return res.status(502).json({ error: 'The model returned no usable output.' })

    proven[rescued ? 'fast' : tier] = model
    // `modelVersion` names what actually served the request, so an alias can be
    // benched together with the model behind it.
    if (typeof data?.modelVersion === 'string' && data.modelVersion !== model) {
      resolvesTo[model] = data.modelVersion
    }
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
