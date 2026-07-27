import { useEffect, useState } from 'react'
import { updateAppBadge } from './badge'
import { checkAuth } from './auth'
import { recordDailySnapshot } from './db'
import { useSettings } from './useSettings'
import { DeckList } from './components/DeckList'
import { DeckView } from './components/DeckView'
import { StudySrs } from './components/StudySrs'
import { StudyFlip } from './components/StudyFlip'
import { Dashboard } from './components/Dashboard'
import { Options } from './components/Options'
import { StoryPage } from './components/StoryPage'
import { ListenPage } from './components/ListenPage'
import { Login } from './components/Login'

export type Route =
  | { name: 'decks' }
  | { name: 'dashboard' }
  | { name: 'options' }
  | { name: 'deck'; deckId: number }
  | { name: 'study-srs'; deckId: number }
  | { name: 'study-flip'; deckId: number }
  | { name: 'story'; deckId: number; storyId?: number }
  | { name: 'listen'; deckId: number }

const ROUTE_KEY = 'flashy:route'

function routeToHash(r: Route): string {
  switch (r.name) {
    case 'decks':
      return '#/'
    case 'dashboard':
      return '#/dashboard'
    case 'options':
      return '#/options'
    case 'deck':
      return `#/deck/${r.deckId}`
    case 'study-srs':
      return `#/deck/${r.deckId}/review`
    case 'study-flip':
      return `#/deck/${r.deckId}/flip`
    case 'story':
      return `#/deck/${r.deckId}/story${r.storyId != null ? `/${r.storyId}` : ''}`
    case 'listen':
      return `#/deck/${r.deckId}/listen`
  }
}

function hashToRoute(hash: string): Route | null {
  const path = hash.replace(/^#\/?/, '')
  if (path === '' || path === 'decks') return { name: 'decks' }
  if (path === 'dashboard') return { name: 'dashboard' }
  if (path === 'options') return { name: 'options' }
  const m = path.match(/^deck\/(\d+)(?:\/(review|flip|story|listen)(?:\/(\d+))?)?$/)
  if (m) {
    const deckId = Number(m[1])
    switch (m[2]) {
      case 'review':
        return { name: 'study-srs', deckId }
      case 'flip':
        return { name: 'study-flip', deckId }
      case 'story':
        return { name: 'story', deckId, storyId: m[3] ? Number(m[3]) : undefined }
      case 'listen':
        return { name: 'listen', deckId }
      default:
        return { name: 'deck', deckId }
    }
  }
  return null
}

// Cold-start fallback: the deck the user was last in, so reopening the
// app (where the URL hash may be gone) returns them there.
function loadRoute(): Route {
  try {
    const raw = localStorage.getItem(ROUTE_KEY)
    if (!raw) return { name: 'decks' }
    const saved = JSON.parse(raw) as Route
    // Restore the deck view itself, not a deep study/story/listen session.
    if ('deckId' in saved && typeof saved.deckId === 'number') {
      return { name: 'deck', deckId: saved.deckId }
    }
    if (saved.name === 'dashboard' || saved.name === 'options' || saved.name === 'decks') {
      return saved
    }
  } catch {
    // ignore malformed storage
  }
  return { name: 'decks' }
}

function initialRoute(): Route {
  // An explicit, non-root hash (a shared/bookmarked link) wins; otherwise
  // fall back to where the user last was.
  const fromHash = hashToRoute(window.location.hash)
  if (fromHash && fromHash.name !== 'decks') return fromHash
  return loadRoute()
}

export default function App() {
  const [route, setRoute] = useState<Route>(initialRoute)
  const [authed, setAuthed] = useState<boolean | null>(null)
  const settings = useSettings()

  useEffect(() => {
    checkAuth().then(setAuthed)
    // Capture today's word-bank size so growth can be charted over time.
    recordDailySnapshot()
  }, [])

  // Force light/dark, or clear the override to follow the OS (the default CSS
  // already reacts to prefers-color-scheme).
  useEffect(() => {
    const root = document.documentElement
    if (settings.theme === 'system') delete root.dataset.theme
    else root.dataset.theme = settings.theme
  }, [settings.theme])

  // Reflect the route in the URL hash (for back/forward + shareable links)
  // and remember it so reopening the app returns the user where they were.
  useEffect(() => {
    const desired = routeToHash(route)
    if (window.location.hash !== desired) window.location.hash = desired
    try {
      localStorage.setItem(ROUTE_KEY, JSON.stringify(route))
    } catch {
      // ignore storage failures (e.g. private mode)
    }
  }, [route])

  // React to back/forward and manual hash edits.
  useEffect(() => {
    const onHash = () => {
      const r = hashToRoute(window.location.hash)
      if (r) setRoute((prev) => (routeToHash(prev) === routeToHash(r) ? prev : r))
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  // Keep the PWA icon badge in sync with the due count
  useEffect(() => {
    updateAppBadge()
  }, [route])

  if (authed === null) return null
  if (!authed) return <Login onSuccess={() => setAuthed(true)} />

  const navLink = (name: 'decks' | 'dashboard' | 'options', label: string) => (
    <button
      className={`nav-link${route.name === name ? ' active' : ''}`}
      onClick={() => setRoute({ name } as Route)}
    >
      {label}
    </button>
  )

  const inDeckFlow =
    route.name === 'deck' ||
    route.name === 'study-srs' ||
    route.name === 'study-flip' ||
    route.name === 'story' ||
    route.name === 'listen'

  return (
    <div className="shell">
      <header className="topbar">
        <button className="brand" onClick={() => setRoute({ name: 'decks' })}>
          <span className="brand-dot" />
          Flashy
        </button>
        <nav className="nav">
          {navLink('decks', 'Decks')}
          {navLink('dashboard', 'Dashboard')}
          {navLink('options', 'Options')}
        </nav>
        <div className="spacer" />
        {inDeckFlow && (
          <button
            className="btn ghost small"
            onClick={() =>
              route.name === 'deck'
                ? setRoute({ name: 'decks' })
                : setRoute({ name: 'deck', deckId: (route as { deckId: number }).deckId })
            }
          >
            ← Back
          </button>
        )}
      </header>

      {route.name === 'decks' && (
        <div className="view" key="decks">
          <DeckList
            onOpen={(deckId) => setRoute({ name: 'deck', deckId })}
            onOpenStory={(deckId, storyId) => setRoute({ name: 'story', deckId, storyId })}
          />
        </div>
      )}
      {route.name === 'dashboard' && (
        <div className="view" key="dashboard">
          <Dashboard />
        </div>
      )}
      {route.name === 'options' && (
        <div className="view" key="options">
          <Options />
        </div>
      )}
      {route.name === 'deck' && (
        <div className="view" key={`deck-${route.deckId}`}>
          <DeckView
            deckId={route.deckId}
            onStudySrs={() => setRoute({ name: 'study-srs', deckId: route.deckId })}
            onStudyFlip={() => setRoute({ name: 'study-flip', deckId: route.deckId })}
            onStory={() => setRoute({ name: 'story', deckId: route.deckId })}
            onListen={() => setRoute({ name: 'listen', deckId: route.deckId })}
            onDeleted={() => setRoute({ name: 'decks' })}
          />
        </div>
      )}
      {route.name === 'study-srs' && (
        <div className="view" key={`srs-${route.deckId}`}>
          <StudySrs deckId={route.deckId} onExit={() => setRoute({ name: 'deck', deckId: route.deckId })} />
        </div>
      )}
      {route.name === 'study-flip' && (
        <div className="view" key={`flip-${route.deckId}`}>
          <StudyFlip deckId={route.deckId} onExit={() => setRoute({ name: 'deck', deckId: route.deckId })} />
        </div>
      )}
      {route.name === 'story' && (
        <div className="view" key={`story-${route.deckId}`}>
          <StoryPage
            deckId={route.deckId}
            initialStoryId={route.storyId}
            onExit={() => setRoute({ name: 'deck', deckId: route.deckId })}
          />
        </div>
      )}
      {route.name === 'listen' && (
        <div className="view" key={`listen-${route.deckId}`}>
          <ListenPage
            deckId={route.deckId}
            onExit={() => setRoute({ name: 'deck', deckId: route.deckId })}
          />
        </div>
      )}
    </div>
  )
}
