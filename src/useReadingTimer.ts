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

/** The daily reading log: how long the reader spent, and how many story words
 *  they got through. Ticks only while `active` and the tab is visible — time
 *  spent in another app isn't reading.
 *
 *  Words are credited from a high-water mark per story, so re-reading an old
 *  one never counts its words twice. */
export function useReadingTimer(active: boolean): ReadingTimer {
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

  useEffect(() => {
    if (!active) return
    const id = setInterval(() => {
      if (!document.hidden) setSessionSecs((s) => s + 1)
    }, 1000)
    return () => clearInterval(id)
  }, [active])

  // Only refs are read, so this closure's identity never matters to callers.
  const flush = () => {
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
