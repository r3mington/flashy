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

// ---- the real endpoint, in-process ----
// The lab used to reimplement api/generate.ts's model and thinking choices,
// which meant the two drifted apart exactly where it mattered — the recovery
// paths. It now calls the handler itself, so a story generated here goes
// through the same model picking, the same deadlines and the same fallbacks
// production does. The key and a session come from the environment.
process.env.GEMINI_API_KEY = API_KEY
process.env.SESSION_SECRET ||= 'story-lab'
const { sessionCookie } = await import('../api/_lib/auth.ts')
const handler = (await import('../api/generate.ts')).default
const cookie = sessionCookie(process.env.SESSION_SECRET)

const realFetch = globalThis.fetch
globalThis.fetch = (async (url: any, init?: any) => {
  if (!String(url).includes('/api/generate')) return realFetch(url, init)
  const body = JSON.parse(init.body)
  const started = Date.now()
  let status = 200
  let payload: any
  const res: any = {
    status(code: number) {
      status = code
      return res
    },
    json(out: any) {
      payload = out
      return res
    },
  }
  await handler({ method: 'POST', headers: { cookie }, body } as any, res)
  const secs = ((Date.now() - started) / 1000).toFixed(1)
  if (status === 200) {
    const m = payload.meta ?? {}
    console.error(
      `  · ${body.label ?? 'call'} ${secs}s  [${m.model} ${JSON.stringify(m.thinking)}]` +
        ` out=${m.outputTokens ?? '?'} thought=${m.thoughtTokens ?? 0}${m.rescued ? ' RESCUED' : ''}`,
    )
  } else {
    console.error(`  ! ${body.label ?? 'call'} ${secs}s  ${status} ${payload?.error}`)
  }
  return new Response(JSON.stringify(payload), { status })
}) as typeof fetch

/** Post one prompt through the same endpoint the app uses. */
async function post(body: Record<string, unknown>) {
  const res = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const out = (await res.json()) as any
  if (!res.ok) throw new Error(out?.error ?? `HTTP ${res.status}`)
  return out
}

// ---- scenarios ----
const { generateStory } = await import('../src/ai.ts')

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
  // AVOID/RECUR simulate what StoryPage passes from the reader's history.
  const avoidThemes = (process.env.AVOID ?? '').split('|').filter(Boolean)
  const avoidNames = (process.env.NAMES ?? '').split(',').filter(Boolean)
  const story = await generateStory({
    deck,
    knownWords: [],
    learningWords: [],
    vocabLevel: 2,
    topic: prev ? undefined : arg1 || undefined,
    lengthWords: Number(process.env.LENGTH ?? 300),
    avoidThemes: prev ? undefined : avoidThemes,
    avoidNames: prev ? undefined : avoidNames,
    continueFrom: prev
      ? {
          title: prev.title,
          story: prev.story,
          direction: arg2 || undefined,
          bible: prev.bible,
          topic: process.env.TOPIC || prev.topic || undefined,
        }
      : undefined,
    // What the app passes from the thread's earlier parts: entries the reader
    // already has, reused instead of bought again.
    knownGlossary: prev?.glossary ?? undefined,
    ending: (process.env.ENDING as 'hook' | 'resolve' | undefined) || undefined,
    troubleAge: prev
      ? (prev.openStreak ?? ((prev.bible?.openThreads?.length ?? 0) > 0 ? 1 : 0))
      : undefined,
    onProgress: () => {},
  })
  const prevStreak = prev ? (prev.openStreak ?? ((prev.bible?.openThreads?.length ?? 0) > 0 ? 1 : 0)) : 0
  const openStreak = (story.bible?.openThreads?.length ?? 0) > 0 ? prevStreak + 1 : 0
  save(cmd, { topic: prev ? ((process.env.TOPIC || prev.topic) ?? null) : (arg1 ?? null), openStreak, ...story })
  console.log(`\n===== ${story.title} =====\n\n${story.story}\n\n----- summary -----\n${story.summary}\n\n----- translation -----\n${story.translation}`)
} else if (cmd === 'bare') {
  // The stripped pipeline the user proposes: one prompt, no plan, no angle,
  // no beats — just "a story on this theme at this level".
  const { data } = await post({
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
