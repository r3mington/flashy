import { db } from './db'

/** Set the PWA app-icon badge to the number of due cards (where supported). */
export async function updateAppBadge() {
  if (!('setAppBadge' in navigator)) return
  try {
    const now = Date.now()
    const due = await db.cards
      .where('due')
      .belowOrEqual(now)
      .filter((c) => !c.known && c.state !== 'new')
      .count()
    if (due > 0) await navigator.setAppBadge(due)
    else await navigator.clearAppBadge()
  } catch {
    /* badge is best-effort */
  }
}
