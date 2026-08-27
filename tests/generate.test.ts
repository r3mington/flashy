import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { sessionCookie } from '../api/_lib/auth.js'

/** The handler keeps what it learned for the life of a warm instance, so each
 *  test needs its own copy. */
async function freshHandler() {
  // Lives outside api/ deliberately: Vercel compiles everything under api/ as a
  // deployable function, and a test file has no business being one.
  vi.resetModules()
  return (await import('../api/generate.js')).default
}

const SECRET = 'test-secret'

function reqRes(body: unknown = { prompt: 'write', schema: { type: 'object' }, tier: 'pro', thinking: true }) {
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
  const req = { method: 'POST', headers: { cookie: sessionCookie(SECRET) }, body }
  return { req: req as any, res: res as any, sent }
}

const ok = (text: string) => ({
  ok: true,
  json: async () => ({
    candidates: [{ content: { parts: [{ text }] } }],
    usageMetadata: {},
  }),
})

const fail = (status: number, message: string) => ({
  ok: false,
  status,
  json: async () => ({ error: { message } }),
})

const RETIRED =
  'This model models/gemini-2.5-pro is no longer available to new users. Please update your code to use models/gemini-3.1-pro-preview for the latest features.'

/** Records every model id the handler tried to generate with, in order. */
function stubFetch(reply: (model: string, calls: string[]) => any, models: string[] = []) {
  const calls: string[] = []
  const listed = { ok: true, json: async () => ({ models: models.map((n) => ({ name: `models/${n}`, supportedGenerationMethods: ['generateContent'] })) }) }
  const fetchMock = vi.fn(async (url: string) => {
    const gen = /models\/(.+):generateContent$/.exec(String(url))
    if (!gen) return listed
    calls.push(gen[1])
    return reply(gen[1], calls)
  })
  vi.stubGlobal('fetch', fetchMock)
  return calls
}

beforeEach(() => {
  process.env.SESSION_SECRET = SECRET
  process.env.GEMINI_API_KEY = 'key'
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** What fetch throws when an AbortSignal.timeout fires. */
const timedOut = () => {
  const e = new Error('The operation was aborted due to timeout')
  e.name = 'TimeoutError'
  throw e
}

describe('timeout resilience', () => {
  it('rescues a too-slow pro call on the fast model rather than dying at the wall', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const model = /models\/(.+):generateContent$/.exec(String(url))![1]
        calls.push(model)
        if (/pro/.test(model)) timedOut()
        return ok('{"ok":true}')
      }),
    )
    const { req, res, sent } = reqRes()
    await (await freshHandler())(req, res)
    expect(sent.status).toBe(200)
    expect(calls).toEqual(['gemini-pro-latest', 'gemini-flash-latest'])
    expect(sent.body.meta.rescued).toBe(true)
  })

  it('gives up once the fast model has had its turn too, and says so', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(/models\/(.+):generateContent$/.exec(String(url))![1])
        return timedOut()
      }),
    )
    const { req, res, sent } = reqRes()
    await (await freshHandler())(req, res)
    expect(sent.status).toBe(504)
    // The flag is what stops the client spending another minute on the same
    // fallback the server just tried.
    expect(sent.body.rescued).toBe(true)
    expect(calls).toEqual(['gemini-pro-latest', 'gemini-flash-latest'])
  })

  it('leaves a fast-tier request to use the whole budget', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(/models\/(.+):generateContent$/.exec(String(url))![1])
        return timedOut()
      }),
    )
    const { req, res, sent } = reqRes({ prompt: 'x', schema: { type: 'object' }, tier: 'fast' })
    await (await freshHandler())(req, res)
    expect(sent.status).toBe(504)
    expect(calls).toEqual(['gemini-flash-latest'])
    expect(sent.body.rescued).toBeUndefined()
  })
})

describe('model resilience', () => {
  it('takes the replacement the error names when a model is retired', async () => {
    const calls = stubFetch((model) =>
      model === 'gemini-3.1-pro-preview' ? ok('{"ok":true}') : fail(400, RETIRED),
    )
    const { req, res, sent } = reqRes()
    await (await freshHandler())(req, res)
    expect(sent.status).toBe(200)
    expect(calls.at(-1)).toBe('gemini-3.1-pro-preview')
    expect(sent.body.meta.model).toBe('gemini-3.1-pro-preview')
  })

  it('discovers the newest model of the right class when no replacement is named', async () => {
    const calls = stubFetch(
      (model) => (model === 'gemini-3-pro' ? ok('{"ok":true}') : fail(404, 'models/x is not found')),
      ['gemini-1.5-pro', 'gemini-3-pro', 'gemini-2.5-pro-preview', 'gemini-3-flash', 'gemini-3-pro-image'],
    )
    const { req, res, sent } = reqRes()
    await (await freshHandler())(req, res)
    expect(sent.status).toBe(200)
    expect(calls.at(-1)).toBe('gemini-3-pro')
  })

  it('never retries a model it has already seen refuse', async () => {
    const calls = stubFetch(() => fail(400, RETIRED), ['gemini-2.5-pro', 'gemini-3.1-pro-preview'])
    const { req, res, sent } = reqRes()
    await (await freshHandler())(req, res)
    expect(sent.status).toBe(400)
    expect(new Set(calls).size).toBe(calls.length)
  })

  it('still steps down the thinking chain for a config the model rejects', async () => {
    const seen: object[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: any) => {
        const cfg = JSON.parse(init.body).generationConfig.thinkingConfig ?? null
        seen.push(cfg)
        if (cfg) return fail(400, 'Unknown name "thinkingLevel": Cannot find field.')
        return ok('{"ok":true}')
      }),
    )
    const { req, res, sent } = reqRes()
    await (await freshHandler())(req, res)
    expect(sent.status).toBe(200)
    expect(seen).toEqual([{ thinkingLevel: 'HIGH' }, null])
  })
})
