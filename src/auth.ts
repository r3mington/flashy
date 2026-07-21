/** Client side of the shared-password gate. In local dev (plain `vite`) there are
 *  no API functions, so the gate is bypassed. */

export const AUTH_ENABLED = !import.meta.env.DEV

export async function checkAuth(): Promise<boolean> {
  if (!AUTH_ENABLED) return true
  try {
    const res = await fetch('/api/me')
    return res.ok
  } catch {
    return false
  }
}

export async function login(password: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    })
    if (res.ok) return { ok: true }
    const body = await res.json().catch(() => null)
    return { ok: false, error: body?.error ?? `Sign-in failed (${res.status})` }
  } catch {
    return { ok: false, error: 'Could not reach the server.' }
  }
}
