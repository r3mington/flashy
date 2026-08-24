/** Story lab: run the real story pipeline from src/ai.ts locally, against the
 *  real Gemini API, and print what it makes — so prompt changes can be judged
 *  by reading their output instead of by staring at the prompt.
 *
 *  `vercel dev` cannot serve the API functions locally (the cloud Development
 *  env is empty and overrides local .env files), so this replaces
 *  globalThis.fetch and forwards /api/generate calls straight to Gemini,
 *  replicating api/generate.ts's model and thinking choices. The key comes
 *  from .env.production.local (`vercel env pull --environment=production`).
 *
 *  Usage:
 *    npx tsx scripts/story-lab.mts full "a love story"   # the whole pipeline
 *    npx tsx scripts/story-lab.mts bare "a love story"   # one bare prompt, no machinery
 *    npx tsx scripts/story-lab.mts continue <file.json> "steer"  # next part, full pipeline
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'

// ---- key ----
const envFile = readFileSync(new URL('../.env.production.local', import.meta.url), 'utf-8')
const keyLine = envFile.split('\n').find((l) => l.startsWith('GEMINI_API_KEY='))
if (!keyLine) throw new Error('GEMINI_API_KEY not in .env.production.local')
const API_KEY = keyLine.slice('GEMINI_API_KEY='.length).trim().replace(/^"|"$/g, '')

const BASE = 'https://generativelanguage.googleapis.com/v1beta'
const MODEL: Record<string, string> = { fast: 'gemini-flash-latest', pro: 'gemini-pro-latest' }

// Same chains as api/generate.ts: try a config, fall back on 400.
const CHAINS: Record<string, (object | null)[]> = {
  fast: [{ thinkingLevel: 'MINIMAL' }, { thinkingLevel: 'LOW' }, { thinkingBudget: 0 }, null],
  quality: [{ thinkingLevel: 'HIGH' }, null],
}
const working: Record<string, number> = {}

async function callGemini(body: {
  prompt: string
  schema: object
  tier?: string
  effort?: string
  label?: string
}) {
  const tier = body.tier === 'pro' ? 'pro' : 'fast'
  const mode = body.effort === 'high' ? 'quality' : 'fast'
  const chain = CHAINS[mode]
  const chainKey = `${tier}:${mode}`
  const started = Date.now()
  for (let i = working[chainKey] ?? 0; i < chain.length; i++) {
    const thinking = chain[i]
    const res = await fetch(`${BASE}/models/${MODEL[tier]}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEY },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: body.prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: body.schema,
          ...(thinking ? { thinkingConfig: thinking } : {}),
        },
      }),
    })
    if (res.status === 400 && i < chain.length - 1) continue
    if (!res.ok) throw new Error(`${body.label}: ${res.status} ${(await res.text()).slice(0, 300)}`)
    working[chainKey] = i
    const json = (await res.json()) as any
    const text = json.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? '').join('') ?? ''
    const usage = json.usageMetadata ?? {}
    console.error(
      `  · ${body.label ?? 'call'} ${((Date.now() - started) / 1000).toFixed(1)}s  ` +
        `[${MODEL[tier]} ${JSON.stringify(thinking)}] out=${usage.candidatesTokenCount ?? '?'} thought=${usage.thoughtsTokenCount ?? 0}`,
    )
    return {
      data: JSON.parse(text),
      meta: { model: MODEL[tier], ms: Date.now() - started },
    }
  }
  throw new Error('unreachable')
}

// ---- intercept the app's endpoint ----
const realFetch = globalThis.fetch
globalThis.fetch = (async (url: any, init?: any) => {
  if (String(url).includes('/api/generate')) {
    const body = JSON.parse(init.body)
    try {
      const out = await callGemini(body)
      return new Response(JSON.stringify(out), { status: 200 })
    } catch (e) {
      console.error('  ! ' + (e as Error).message)
      return new Response(JSON.stringify({ error: (e as Error).message }), { status: 502 })
    }
  }
  return realFetch(url, init)
}) as typeof fetch

// ---- scenarios ----
const { generateStory, pickAngle, pickEnding } = await import('../src/ai.ts')

const deck: any = { id: 1, name: 'Indonesian', language: 'Indonesian' }
const OUT = new URL('../.story-lab/', import.meta.url).pathname
mkdirSync(OUT, { recursive: true })

const [, , cmd, arg1, arg2] = process.argv
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)

function save(name: string, obj: unknown) {
  const path = `${OUT}${stamp}-${name}.json`
  writeFileSync(path, JSON.stringify(obj, null, 2))
  console.error(`  → ${path}`)
}

if (cmd === 'full' || cmd === 'continue') {
  const prev = cmd === 'continue' ? JSON.parse(readFileSync(arg1!, 'utf-8')) : undefined
  const angle = pickAngle()
  const ending = pickEnding({
    partsSoFar: prev ? 1 : 0,
    openThreads: prev?.bible?.openThreads?.length ?? 0,
  })
  console.error(`angle: ${JSON.stringify(angle, null, 1)}\nending: ${ending}`)
  const story = await generateStory({
    deck,
    knownWords: [],
    learningWords: [],
    vocabLevel: 2,
    topic: prev ? undefined : arg1 || undefined,
    lengthWords: 300,
    angle: prev ? undefined : angle,
    ending,
    continueFrom: prev
      ? { title: prev.title, story: prev.story, direction: arg2 || undefined, bible: prev.bible }
      : undefined,
    onProgress: () => {},
  })
  save(cmd, { angle: prev ? undefined : angle, ending, ...story })
  console.log(`\n===== ${story.title} =====\n\n${story.story}\n\n----- summary -----\n${story.summary}\n\n----- translation -----\n${story.translation}`)
} else if (cmd === 'bare') {
  // The stripped pipeline the user proposes: one prompt, no plan, no angle,
  // no beats — just "a story on this theme at this level".
  const { data } = await callGemini({
    label: 'bare',
    tier: 'pro',
    effort: 'minimal',
    prompt: [
      `Write a short story in Indonesian for a language learner at CEFR A2 (beginner).`,
      arg1 ? `Theme: ${arg1}.` : '',
      `About 300 words. Use only common, everyday vocabulary a beginner would know — roughly the 1000 most frequent Indonesian words. Simple sentences. Casual spoken register ("aku", not formal written Indonesian). Mostly dialogue, wrapped in “…” quotation marks.`,
      `Make it feel like a real story: characters who want something, events that follow from each other, and an ending that lands.`,
      `Return JSON: {"title": ..., "story": ...}.`,
    ]
      .filter(Boolean)
      .join('\n'),
    schema: {
      type: 'OBJECT',
      properties: { title: { type: 'STRING' }, story: { type: 'STRING' } },
      required: ['title', 'story'],
    },
  })
  save('bare', data)
  console.log(`\n===== ${data.title} =====\n\n${data.story}`)
} else {
  console.error('usage: story-lab.mts full|bare "topic"  OR  continue <file.json> "steer"')
  process.exit(1)
}
