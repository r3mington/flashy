/** Client side of the shared-password gate. Plain `vite` dev serves no API
 *  functions, so there is nothing to sign in to and the gate is bypassed.
 *  `vercel dev` and production do serve them, and there the password applies —
 *  bypassing it in dev would just make every /api call fail with a 401. */

export async function checkAuth(): Promise<boolean> {
  let res: Response
  try {
    res = await fetch('/api/me')
  } catch {
    // Couldn't reach the API at all — only expected in dev without functions.
    return import.meta.env.DEV
  }
  if (res.ok) return true
  // 404: the functions aren't served (plain `vite`), so there's no gate.
  // Anything else (401) means they are, and the user has to sign in.
  return import.meta.env.DEV && res.status === 404
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
