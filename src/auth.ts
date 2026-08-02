/** Client side of the shared-password gate. Plain `vite` dev serves no API
 *  functions, so there is nothing to sign in to and the gate is bypassed.
 *  `vercel dev` and production do serve them, and there the password applies —
 *  bypassing it in dev would just make every /api call fail with a 401. */

/** A sign-in that has been confirmed by the server at least once. The session
 *  cookie itself is HttpOnly and unreadable here, so this flag is what lets an
 *  offline launch (a plane, the underground) open the app instead of a login
 *  form it could never submit. Reading stories is entirely local; the gate
 *  exists to protect the AI endpoint, which is unreachable offline anyway.
 *  A real 401 from the server clears it. */
const AUTHED_KEY = 'flashy:authed'

function remember(authed: boolean) {
  try {
    if (authed) localStorage.setItem(AUTHED_KEY, '1')
    else localStorage.removeItem(AUTHED_KEY)
  } catch {
    // ignore storage failures (e.g. private mode)
  }
}

function wasAuthed(): boolean {
  try {
    return localStorage.getItem(AUTHED_KEY) === '1'
  } catch {
    return false
  }
}

export async function checkAuth(): Promise<boolean> {
  let res: Response
  try {
    res = await fetch('/api/me')
  } catch {
    // Couldn't reach the API at all: offline, or dev without functions. Trust a
    // sign-in the server confirmed earlier rather than locking the reader out.
    return wasAuthed() || import.meta.env.DEV
  }
  if (res.ok) {
    remember(true)
    return true
  }
  // 404: the functions aren't served (plain `vite`), so there's no gate.
  // Anything else (401) means they are, and the user has to sign in.
  if (res.status !== 404) remember(false)
  return import.meta.env.DEV && res.status === 404
}

export async function login(password: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    })
    if (res.ok) {
      remember(true)
      return { ok: true }
    }
    const body = await res.json().catch(() => null)
    return { ok: false, error: body?.error ?? `Sign-in failed (${res.status})` }
  } catch {
    return { ok: false, error: 'Could not reach the server.' }
  }
}
