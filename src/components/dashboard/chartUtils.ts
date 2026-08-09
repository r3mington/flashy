/** Non-component helpers for the dashboard charts. Kept out of charts.tsx so
 *  that file exports only components and Fast Refresh keeps working. */
import { useRef, useState } from 'react'
import { prevDay } from '../../time'

/** Bar charts are too narrow to tap a single bar on a phone, so the whole
 *  plot area is the target: whichever column the x position lands in wins. */
export function useColumnPick(n: number) {
  const [sel, setSel] = useState<number | null>(null)
  const ref = useRef<SVGSVGElement>(null)
  const pick = (clientX: number) => {
    const el = ref.current
    if (!el || n < 1) return
    const rect = el.getBoundingClientRect()
    const frac = (clientX - rect.left) / rect.width
    setSel(Math.max(0, Math.min(n - 1, Math.floor(frac * n))))
  }
  return { sel, ref, pick }
}

export function formatBankDay(day: number, today: number): string {
  if (day === today) return 'Today'
  if (day === prevDay(today)) return 'Yesterday'
  return new Date(day).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function formatHour(h: number): string {
  return new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric' })
}
