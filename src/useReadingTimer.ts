import { useEffect, useRef, useState } from 'react'
import { bumpReading, db } from './db'
import { startOfToday } from './time'
import { useFlushLoop } from './useFlushLoop'

export interface ReadingTimer {
  /** Seconds read today, this session included — for the header clock. */
  todaySecs: number
  /** Best position reached in the open story, in words. The scroll measurer
   *  raises this; nothing else should lower it. */
  seen: React.RefObject<number>
  /** Credit whatever has been read so far and persist it. Safe to call often. */
  flush: () => void
  /** Point the word counters at a different story (or none, when leaving the
   *  reader). Flushes the outgoing story first. */
  adopt: (story: { id: number; wordsRead?: number } | null) => void
}

/** How long the reader can go without scrolling, tapping or typing before the
 *  clock stops. A phone screen holds 100–150 words, which at a learner's pace
 *  is a couple of minutes of reading with nothing to touch. */
export const IDLE_MS = 2 * 60 * 1000

/** Whether this second is reading. A story on screen is not enough: the clock
 *  used to run whenever one was open and visible, so a phone put down on a
 *  story counted until the screen locked itself, and a story left in a desktop
 *  window counted while its reader worked in another. Now the window must be
 *  the one in use and the reader must have done something in the last
 *  `IDLE_MS` — or be having the story read to them, which needs no touch. */
export function countsAsReading(o: {
  hidden: boolean
  focused: boolean
  sinceActivityMs: number
  readingAloud: boolean
}): boolean {
  if (o.hidden || !o.focused) return false
  return o.readingAloud || o.sinceActivityMs < IDLE_MS
}

/** What tells us someone is there. Scroll is captured, because the story can
 *  scroll inside its own box rather than the page. */
const ACTIVITY_EVENTS = ['scroll', 'wheel', 'pointerdown', 'touchstart', 'keydown'] as const

/** The daily reading log: how long the reader spent, and how many story words
 *  they got through. Ticks only while `active` and the reader is actually
 *  there — see `countsAsReading`.
 *
 *  Words are credited from a high-water mark per story, so re-reading an old
 *  one never counts its words twice. */
export function useReadingTimer(active: boolean, readingAloud = false): ReadingTimer {
  const [baseSecs, setBaseSecs] = useState(0)
  const [sessionSecs, setSessionSecs] = useState(0)

  const dayRef = useRef(startOfToday())
  const baseRef = useRef(0)
  baseRef.current = baseSecs
  const sessRef = useRef(0)
  sessRef.current = sessionSecs

  // `high` is the mark already banked for this story, `seen` the best reached
  // now; only the difference is ever credited.
  const highRef = useRef(0)
  const seenRef = useRef(0)
  const storyRef = useRef<number | null>(null)

  useEffect(() => {
    db.reading.get(dayRef.current).then((r) => setBaseSecs(r?.seconds ?? 0))
  }, [])

  const lastActivityRef = useRef(Date.now())
  const aloudRef = useRef(readingAloud)
  aloudRef.current = readingAloud

  useEffect(() => {
    if (!active) return
    // Opening a story is itself a tap.
    lastActivityRef.current = Date.now()
    const touch = () => {
      lastActivityRef.current = Date.now()
    }
    for (const e of ACTIVITY_EVENTS) window.addEventListener(e, touch, { capture: true, passive: true })
    const id = setInterval(() => {
      const reading = countsAsReading({
        hidden: document.hidden,
        focused: document.hasFocus(),
        sinceActivityMs: Date.now() - lastActivityRef.current,
        readingAloud: aloudRef.current,
      })
      if (reading) setSessionSecs((s) => s + 1)
    }, 1000)
    return () => {
      clearInterval(id)
      for (const e of ACTIVITY_EVENTS) window.removeEventListener(e, touch, { capture: true })
    }
  }, [active])

  // The app can live across midnight for days — a PWA is rarely relaunched —
  // and the day this timer writes to was fixed once at mount. Every session
  // after the first midnight then piled its seconds and words onto that stale
  // day: whole weeks of reading recorded as a handful of giant days, and the
  // days actually read on left empty. Checked before every write instead:
  // settle what has been counted onto the day it belongs to, then restart the
  // counters for the new day.
  const rollDay = () => {
    const today = startOfToday()
    if (today === dayRef.current) return
    if (sessRef.current > 0) {
      bumpReading(dayRef.current, { seconds: baseRef.current + sessRef.current })
    }
    dayRef.current = today
    baseRef.current = 0
    sessRef.current = 0
    setBaseSecs(0)
    setSessionSecs(0)
    void db.reading.get(today).then((r) => setBaseSecs(r?.seconds ?? 0))
  }

  // Only refs are read, so this closure's identity never matters to callers.
  const flush = () => {
    rollDay()
    const id = storyRef.current
    const gained = seenRef.current - highRef.current
    // The 5s floor keeps a story opened and immediately closed — which reads as
    // 100% progress when it fits on one screen — from counting.
    if (id == null || gained <= 0 || sessRef.current < 5) return
    const mark = seenRef.current
    highRef.current = mark
    db.stories.update(id, { wordsRead: mark })
    bumpReading(dayRef.current, { addWords: gained })
  }

  useFlushLoop(() => {
    flush()
    if (sessRef.current > 0) {
      bumpReading(dayRef.current, { seconds: baseRef.current + sessRef.current })
    }
  })

  const adopt = (story: { id: number; wordsRead?: number } | null) => {
    flush()
    storyRef.current = story?.id ?? null
    highRef.current = story?.wordsRead ?? 0
    seenRef.current = story?.wordsRead ?? 0
  }

  return { todaySecs: baseSecs + sessionSecs, seen: seenRef, flush, adopt }
}
