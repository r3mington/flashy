import { useEffect, useRef } from 'react'

const FLUSH_MS = 15000

/** Persist something periodically, when the tab is hidden, and on unmount —
 *  the three moments a running total can be lost. The daily reading and
 *  listening timers both need exactly this; what they *count* differs (reading
 *  pauses when you look away, listening keeps going behind a locked screen),
 *  so only the saving is shared.
 *
 *  `flush` is re-read through a ref on every call, so callers can pass a fresh
 *  closure each render without restarting the loop. */
export function useFlushLoop(flush: () => void): void {
  const ref = useRef(flush)
  ref.current = flush

  useEffect(() => {
    const run = () => ref.current()
    const onHide = () => document.hidden && run()
    const id = setInterval(run, FLUSH_MS)
    document.addEventListener('visibilitychange', onHide)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', onHide)
      run()
    }
  }, [])
}
