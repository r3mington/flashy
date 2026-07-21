import { createHmac, timingSafeEqual } from 'node:crypto'

export const COOKIE_NAME = 'flashy_session'
const MAX_AGE = 60 * 60 * 24 * 180 // 180 days

export function sessionToken(secret: string): string {
  return createHmac('sha256', secret).update('flashy-session-v1').digest('hex')
}

export function sessionCookie(secret: string): string {
  return `${COOKIE_NAME}=${sessionToken(secret)}; HttpOnly; Path=/; Max-Age=${MAX_AGE}; SameSite=Lax; Secure`
}

export function clearCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax; Secure`
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

export function isAuthed(cookieHeader: string | undefined): boolean {
  const secret = process.env.SESSION_SECRET
  if (!secret || !cookieHeader) return false
  const match = cookieHeader
    .split(/;\s*/)
    .find((c) => c.startsWith(`${COOKIE_NAME}=`))
  if (!match) return false
  return safeEqual(match.slice(COOKIE_NAME.length + 1), sessionToken(secret))
}
