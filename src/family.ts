/** The word family panel: one root's words, grouped by what their affixes do,
 *  with what the reader's own data says about each. */

import type { FamilyForm, FamilyGroup } from './db'
import { defKey } from './text'

/** The headings, in the order the panel shows them. */
export const FAMILY_GROUP_LABELS: { group: FamilyGroup; label: string }[] = [
  { group: 'doing', label: 'Doing it' },
  { group: 'done', label: 'Having it done' },
  { group: 'accidental', label: 'By accident, or able to' },
  { group: 'state', label: 'Being in that state' },
  { group: 'thing', label: 'Things' },
  { group: 'person', label: 'People' },
  { group: 'mutual', label: 'Each other, together' },
  { group: 'casual', label: 'Casual speech' },
  { group: 'other', label: 'Other forms' },
]

/** Where a family member stands for this reader. */
export type FamilyStatus = 'known' | 'study' | 'ignored' | 'none'

export interface FamilyRow extends FamilyForm {
  key: string
  status: FamilyStatus
  /** Earlier stories it was read in. */
  met: number
}

/** The family's forms under their headings, empty headings dropped. Status is
 *  looked up by the exact word: memegang is a word of its own, and the card
 *  for pegang says nothing about whether the reader knows it. */
export function familySections(
  forms: FamilyForm[],
  statusOf: (key: string) => FamilyStatus,
  metOf: (key: string) => number,
): { group: FamilyGroup; label: string; rows: FamilyRow[] }[] {
  return FAMILY_GROUP_LABELS.map(({ group, label }) => ({
    group,
    label,
    rows: forms
      .filter((f) => f.group === group)
      .map((f) => {
        const key = defKey(f.word)
        return { ...f, key, status: statusOf(key), met: metOf(key) }
      }),
  })).filter((s) => s.rows.length > 0)
}
