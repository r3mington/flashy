import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { sessionCookie } from '../api/_lib/auth.js'

// Lives outside api/ deliberately: Vercel compiles everything under api/ as a
// deployable function, and a test file has no business being one.
async function handler() {
  vi.resetModules()
  return (await import('../api/generate.js')).default
}

const SECRET = 'test-secret'

function reqRes(body: unknown, cookie = sessionCookie(SECRET)) {
  const sent: { status?: number; body?: any } = {}
  const res = {
    status(code: number) {
      sent.status = code
      return this
    },
    json(payload: any) {
      sent.body = payload
      return this
    },
  }
  const req = { method: 'POST', headers: { cookie }, body }
  return { req: req as any, res: res as any, sent }
}

const ask = (extra: Record<string, unknown> = {}) => ({
  prompt: 'write',
  schema: { type: 'OBJECT' },
  ...extra,
})

const ok = (text = '{"title":"t"}') => ({
  ok: true,
  json: async () => ({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: {} }),
})

const fail = (status: number, message = 'nope') => ({
  ok: false,
  status,
  json: async () => ({ error: { message } }),
})

/** What fetch throws when an AbortSignal.timeout fires. */
const timedOut = () => {
  const e = new Error('The operation was aborted due to timeout')
  e.name = 'TimeoutError'
  throw e
}

/** Records every call: which model, with what thinking config. */
function stubFetch(reply: (model: string) => any) {
  const calls: { model: string; thinking: any }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: any) => {
      const model = /models\/(.+):generateContent$/.exec(String(url))![1]
      calls.push({ model, thinking: JSON.parse(init.body).generationConfig.thinkingConfig })
      return reply(model)
    }),
  )
  return calls
}

beforeEach(() => {
  process.env.SESSION_SECRET = SECRET
  process.env.GEMINI_API_KEY = 'key'
  delete process.env.STORY_MODEL
  delete process.env.FAST_MODEL
  delete process.env.FALLBACK_MODEL
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('model and thinking', () => {
  it('writes the story on the story model, thinking at medium', async () => {
    const calls = stubFetch(() => ok())
    const { req, res, sent } = reqRes(ask({ tier: 'story', effort: 'medium' }))
    await (await handler())(req, res)
    expect(sent.status).toBe(200)
    expect(calls).toEqual([{ model: 'gemini-3.8-flash', thinking: { thinkingLevel: 'MEDIUM' } }])
    expect(sent.body.data).toEqual({ title: 't' })
  })

  it('runs a minimal-effort call with no thinking at all', async () => {
    const calls = stubFetch(() => ok())
    const { req, res } = reqRes(ask({ effort: 'minimal' }))
    await (await handler())(req, res)
    expect(calls[0].thinking).toEqual({ thinkingBudget: 0 })
  })

  it('follows the reader\'s "think harder" setting when the caller names no effort', async () => {
    const calls = stubFetch(() => ok())
    const { req, res } = reqRes(ask({ thinking: true }))
    await (await handler())(req, res)
    expect(calls[0].thinking).toEqual({ thinkingLevel: 'HIGH' })
  })

  it('takes its models from the environment when they are set', async () => {
    process.env.STORY_MODEL = 'gemini-9-pro'
    process.env.FAST_MODEL = 'gemini-9-flash'
    const calls = stubFetch(() => ok())
    const h = await handler()
    for (const tier of ['story', 'fast']) {
      const { req, res } = reqRes(ask({ tier }))
      await h(req, res)
    }
    expect(calls.map((c) => c.model)).toEqual(['gemini-9-pro', 'gemini-9-flash'])
  })
})

describe('fallback', () => {
  it('moves to the fallback model when the first one times out, and says so', async () => {
    const calls = stubFetch((model) => (model === 'gemini-3.8-flash' ? timedOut() : ok()))
    const { req, res, sent } = reqRes(ask({ tier: 'story', effort: 'medium' }))
    await (await handler())(req, res)
    expect(calls.map((c) => c.model)).toEqual(['gemini-3.8-flash', 'gemini-3.7-flash'])
    expect(sent.status).toBe(200)
    expect(sent.body.meta).toMatchObject({ model: 'gemini-3.7-flash', rescued: true })
  })

  it('falls back on a busy, overloaded or retired model', async () => {
    for (const status of [404, 429, 500, 503]) {
      const calls = stubFetch((model) => (model === 'gemini-3.8-flash' ? fail(status) : ok()))
      const { req, res, sent } = reqRes(ask())
      await (await handler())(req, res)
      expect(calls).toHaveLength(2)
      expect(sent.status).toBe(200)
    }
  })

  it('does not fall back on a request the model rejected', async () => {
    const calls = stubFetch(() => fail(400, 'Invalid schema'))
    const { req, res, sent } = reqRes(ask())
    await (await handler())(req, res)
    expect(calls).toHaveLength(1)
    expect(sent.status).toBe(400)
    expect(sent.body.error).toBe('Invalid schema')
  })

  it('reports the failure once the fallback has failed too', async () => {
    const calls = stubFetch(() => fail(503, 'overloaded'))
    const { req, res, sent } = reqRes(ask())
    await (await handler())(req, res)
    expect(calls).toHaveLength(2)
    expect(sent.status).toBe(503)
  })

  it('tries once when the fallback is the same model', async () => {
    process.env.FALLBACK_MODEL = 'gemini-3.8-flash'
    const calls = stubFetch(() => fail(503))
    const { req, res } = reqRes(ask())
    await (await handler())(req, res)
    expect(calls).toHaveLength(1)
  })

  it('hides an upstream key problem behind a server error', async () => {
    stubFetch(() => fail(403, 'API key not valid'))
    const { req, res, sent } = reqRes(ask())
    await (await handler())(req, res)
    expect(sent.status).toBe(500)
  })
})

describe('the request', () => {
  it('refuses a caller that is not signed in', async () => {
    const calls = stubFetch(() => ok())
    const { req, res, sent } = reqRes(ask(), '')
    await (await handler())(req, res)
    expect(sent.status).toBe(401)
    expect(calls).toHaveLength(0)
  })

  it('refuses a body without a prompt and a schema', async () => {
    stubFetch(() => ok())
    const { req, res, sent } = reqRes({ prompt: 'write' })
    await (await handler())(req, res)
    expect(sent.status).toBe(400)
  })
})
