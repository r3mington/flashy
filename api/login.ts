import type { VercelRequest, VercelResponse } from '@vercel/node'
import { safeEqual, sessionCookie } from './_lib/auth.js'

export default function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const expected = process.env.APP_PASSWORD
  const secret = process.env.SESSION_SECRET
  if (!expected || !secret) {
    return res
      .status(500)
      .json({ error: 'Server is missing APP_PASSWORD or SESSION_SECRET.' })
  }
  const password = typeof req.body?.password === 'string' ? req.body.password : ''
  if (!safeEqual(password, expected)) {
    return res.status(401).json({ error: 'Wrong password.' })
  }
  res.setHeader('Set-Cookie', sessionCookie(secret))
  return res.status(200).json({ ok: true })
}
