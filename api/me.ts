import type { VercelRequest, VercelResponse } from '@vercel/node'
import { isAuthed } from './_lib/auth.js'

export default function handler(req: VercelRequest, res: VercelResponse) {
  if (!isAuthed(req.headers.cookie)) return res.status(401).json({ error: 'Not signed in' })
  return res.status(200).json({ ok: true })
}
