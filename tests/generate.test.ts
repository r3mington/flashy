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

describe('the caller\'s remembered model', () => {
  it('starts there instead of on the busy alias', async () => {
    const calls = stubFetch(() => ok('{"ok":true}'))
    const { req, res, sent } = reqRes({
      prompt: 'x',
      schema: { type: 'object' },
      tier: 'fast',
      preferModel: 'gemini-3.6-flash',
    })
    await (await freshHandler())(req, res)
    expect(sent.status).toBe(200)
    expect(calls).toEqual(['gemini-3.6-flash'])
  })

  it('ignores a hint for the wrong class, or one this instance has benched', async () => {
    const calls = stubFetch(() => ok('{"ok":true}'))
    const handler = await freshHandler()
    // A flash model cannot answer a pro request.
    const wrong = reqRes({
      prompt: 'x',
      schema: { type: 'object' },
      tier: 'pro',
      preferModel: 'gemini-3.6-flash',
    })
    await handler(wrong.req, wrong.res)
    expect(calls).toEqual(['gemini-pro-latest'])
  })

  it('refuses a hint that isn\'t a model name', async () => {
    const calls = stubFetch(() => ok('{"ok":true}'))
    const { req, res } = reqRes({
      prompt: 'x',
      schema: { type: 'object' },
      tier: 'fast',
      preferModel: '../../etc/passwd:generateContent?key=',
    })
    await (await freshHandler())(req, res)
    expect(calls).toEqual(['gemini-flash-latest'])
  })
})

describe('a model that is merely busy', () => {
  it('moves to another model of the same class, and stays moved', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const gen = /models\/(.+):generateContent$/.exec(String(url))
        if (!gen) {
          return {
            ok: true,
            json: async () => ({
              models: ['gemini-flash-latest', 'gemini-3.6-flash', 'gemini-3.5-flash'].map((n) => ({
                name: `models/${n}`,
                supportedGenerationMethods: ['generateContent'],
              })),
            }),
          }
        }
        calls.push(gen[1])
        // What the real API was doing when this was written: the newest flash
        // sat for a minute and a half, an older one answered at once.
        if (gen[1] === 'gemini-flash-latest') timedOut()
        return ok('{"ok":true}')
      }),
    )
    const handler = await freshHandler()
    const first = reqRes({ prompt: 'x', schema: { type: 'object' }, tier: 'fast' })
    await handler(first.req, first.res)
    expect(first.sent.status).toBe(200)
    expect(calls).toEqual(['gemini-flash-latest', 'gemini-3.6-flash'])

    // The bench outlives the request: the next call doesn't pay the wait again.
    const second = reqRes({ prompt: 'x', schema: { type: 'object' }, tier: 'fast' })
    await handler(second.req, second.res)
    expect(second.sent.status).toBe(200)
    expect(calls).toEqual(['gemini-flash-latest', 'gemini-3.6-flash', 'gemini-3.6-flash'])
  })

  it('benches the model behind an alias too, once it knows what it is', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const gen = /models\/(.+):generateContent$/.exec(String(url))
        if (!gen) {
          return {
            ok: true,
            json: async () => ({
              models: ['gemini-flash-latest', 'gemini-3.7-flash', 'gemini-3.6-flash'].map((n) => ({
                name: `models/${n}`,
                supportedGenerationMethods: ['generateContent'],
              })),
            }),
          }
        }
        calls.push(gen[1])
        // The alias answers once, naming what served it — then goes slow.
        if (gen[1] === 'gemini-flash-latest') {
          if (calls.filter((c) => c === 'gemini-flash-latest').length === 1) {
            return {
              ok: true,
              json: async () => ({
                candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }],
                modelVersion: 'gemini-3.7-flash',
                usageMetadata: {},
              }),
            }
          }
          timedOut()
        }
        return ok('{"ok":true}')
      }),
    )
    const handler = await freshHandler()
    for (let i = 0; i < 3; i++) {
      const r = reqRes({ prompt: 'x', schema: { type: 'object' }, tier: 'fast' })
      await handler(r.req, r.res)
      expect(r.sent.status).toBe(200)
    }
    // Call 1 learns the alias is 3.7. Call 2 times out on it and benches both,
    // so 3.7 is never tried on its own merits — it is the same busy model.
    expect(calls).toEqual([
      'gemini-flash-latest',
      'gemini-flash-latest',
      'gemini-3.6-flash',
      'gemini-3.6-flash',
    ])
  })
})

describe('a pro model that can only think expensively', () => {
  it('moves to the fast model rather than letting it think by default', async () => {
    const tried: { model: string; thinking: object | null }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: any) => {
        const model = /models\/(.+):generateContent$/.exec(String(url))![1]
        tried.push({ model, thinking: JSON.parse(init.body).generationConfig.thinkingConfig ?? null })
        if (/pro/.test(model)) return fail(400, 'Unknown name "thinkingLevel": Cannot find field.')
        return ok('{"ok":true}')
      }),
    )
    const { req, res, sent } = reqRes({ prompt: 'x', schema: { type: 'object' }, tier: 'pro', effort: 'minimal' })
    await (await freshHandler())(req, res)
    expect(sent.status).toBe(200)
    // Every pro attempt asked for cheap thinking; none fell through to the
    // model's default, which is the config that eats the whole budget.
    const onPro = tried.filter((t) => /pro/.test(t.model))
    expect(onPro.length).toBeGreaterThan(1)
    expect(onPro.every((t) => t.thinking !== null)).toBe(true)
    expect(tried.at(-1)!.model).toBe('gemini-flash-latest')
  })

  it('stops paying the pro toll for the rest of the story once it has timed out', async () => {
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
    const handler = await freshHandler()
    const first = reqRes()
    await handler(first.req, first.res)
    const second = reqRes()
    await handler(second.req, second.res)
    expect(second.sent.status).toBe(200)
    // The second call never touches pro: one timeout is enough to learn from.
    expect(calls).toEqual(['gemini-pro-latest', 'gemini-flash-latest', 'gemini-flash-latest'])
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
