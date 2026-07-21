import { useLiveQuery } from 'dexie-react-hooks'
import { db, DEFAULT_SETTINGS, type AppSettings } from './db'

export function useSettings(): AppSettings {
  // Merge with defaults so settings saved before a new field existed still get it.
  return (
    useLiveQuery(async () => ({
      ...DEFAULT_SETTINGS,
      ...((await db.settings.get('app')) ?? {}),
    })) ?? DEFAULT_SETTINGS
  )
}

export async function saveSettings(patch: Partial<AppSettings>) {
  const current = (await db.settings.get('app')) ?? DEFAULT_SETTINGS
  await db.settings.put({ ...current, ...patch, key: 'app' })
}
