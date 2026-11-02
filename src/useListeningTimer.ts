import { useEffect, useRef } from 'react'
import { db } from './db'
import { startOfToday } from './time'
import { useFlushLoop } from './useFlushLoop'

/** Log seconds spent actually playing audio, so the dashboard can show
 *  listening alongside reviewing and reading. Mirrors the story read timer:
 *  tick while playing, flush the running total periodically and on unmount. */
export function useListeningTimer(playing: boolean) {
  const dayRef = useRef(startOfToday())
  const baseRef = useRef(0)
  const sessRef = useRef(0)

  useEffect(() => {
    db.listening.get(dayRef.current).then((r) => {
      baseRef.current = r?.seconds ?? 0
    })
  }, [])

  useEffect(() => {
    if (!playing) return
    const id = setInterval(() => sessRef.current++, 1000)
    return () => clearInterval(id)
  }, [playing])

  useFlushLoop(() => {
    if (sessRef.current > 0) {
      db.listening.put({ day: dayRef.current, seconds: baseRef.current + sessRef.current })
    }
    // Same midnight rollover as the reading timer: the mounted day goes stale
    // once the clock passes midnight, and everything after would pile onto it.
    const today = startOfToday()
    if (today !== dayRef.current) {
      dayRef.current = today
      sessRef.current = 0
      baseRef.current = 0
      void db.listening.get(today).then((r) => {
        baseRef.current = r?.seconds ?? 0
      })
    }
  })
}
