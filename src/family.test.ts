import { describe, expect, it } from 'vitest'
import type { FamilyForm } from './db'
import { familySections } from './family'

const form = (word: string, group: FamilyForm['group']): FamilyForm => ({
  word,
  meaning: word,
  group,
  affix: '',
})

describe('familySections', () => {
  const forms = [
    form('pegangan', 'thing'),
    form('Memegang', 'doing'),
    form('dipegang', 'done'),
    form('megang', 'casual'),
  ]

  it('groups in the panel order and drops empty headings', () => {
    const sections = familySections(forms, () => 'none', () => 0)
    expect(sections.map((s) => s.group)).toEqual(['doing', 'done', 'thing', 'casual'])
  })

  it("gives each word the reader's own status and encounters, by its exact form", () => {
    const status = new Map([['memegang', 'known' as const]])
    const met = new Map([['dipegang', 4]])
    const rows = familySections(
      forms,
      (k) => status.get(k) ?? 'none',
      (k) => met.get(k) ?? 0,
    ).flatMap((s) => s.rows)
    expect(rows.map((r) => [r.key, r.status, r.met])).toEqual([
      ['memegang', 'known', 0],
      ['dipegang', 'none', 4],
      ['pegangan', 'none', 0],
      ['megang', 'none', 0],
    ])
  })
})
