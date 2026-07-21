import { useState } from 'react'
import { login } from '../auth'

export function Login({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit() {
    if (!password || busy) return
    setBusy(true)
    setError('')
    const result = await login(password)
    setBusy(false)
    if (result.ok) onSuccess()
    else setError(result.error ?? 'Sign-in failed.')
  }

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="brand login-brand">
          <span className="brand-dot" />
          Flashy
        </div>
        <p className="note login-note">This app is private. Enter the password to continue.</p>
        <input
          className="search login-input"
          type="password"
          autoFocus
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        {error && <p className="note error-note">{error}</p>}
        <button className="btn primary login-btn" onClick={submit} disabled={busy || !password}>
          {busy ? 'Checking…' : 'Enter'}
        </button>
      </div>
    </div>
  )
}
