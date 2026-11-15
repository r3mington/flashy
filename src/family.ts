/** The word family panel: one root's words, grouped by what their affixes do,
 *  with what the reader's own data says about each. */

import { explainAffixes } from './affixes'
import type { FamilyForm, FamilyGroup } from './db'
import { defKey } from './text'

/** The word families that go with the common-words list, built offline by
 *  `scripts/build-word-families.mts`: every counted form of a root that is a
 *  word of its own, with its meaning — and the list's other entries built on
 *  it (pekerjaan under kerja). */
export interface FamilyList {
  source: string
  license: string
  /** root → [word, meaning, group][] */
  families: Record<string, [string, string, string][]>
}

const GROUPS = new Set<string>([
  'doing', 'done', 'accidental', 'state', 'thing', 'person', 'mutual', 'casual', 'other',
])

/** One root's family from the list, as the panel's forms. The affix note is
 *  the hardcoded table's (see `explainAffixes`), so it reads the same as the
 *  word pop-up, and is left blank where the table cannot rebuild the word
 *  (memperbaiki: two prefixes) rather than guessed. */
export function listFamily(list: FamilyList, root: string, langCode: string | null): FamilyForm[] {
  return (list.families[root] ?? []).map(([word, meaning, group]) => ({
    word,
    meaning,
    group: (GROUPS.has(group) ? group : 'other') as FamilyGroup,
    affix: explainAffixes(word, root, langCode)
      .map((a) => a.label)
      .join(' + '),
  }))
}

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
