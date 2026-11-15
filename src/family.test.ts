import { describe, expect, it } from 'vitest'
import type { FamilyForm } from './db'
import { familySections, listFamily } from './family'

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

describe('listFamily', () => {
  const list = {
    source: '',
    license: '',
    families: {
      pegang: [
        ['memegang', 'to hold', 'doing'],
        ['dipegang', 'held', 'done'],
        ['memperpegangkan', 'made up', 'nonsense'],
      ] as [string, string, string][],
    },
  }

  it("gives the root's members with the affix table's labels", () => {
    expect(listFamily(list, 'pegang', 'id')).toEqual([
      { word: 'memegang', meaning: 'to hold', group: 'doing', affix: 'meN-' },
      { word: 'dipegang', meaning: 'held', group: 'done', affix: 'di-' },
      // An unknown heading falls under "Other forms", and a word the table
      // cannot rebuild from the root gets no note rather than a guess.
      { word: 'memperpegangkan', meaning: 'made up', group: 'other', affix: '' },
    ])
  })

  it('is empty for a root the list has no family for', () => {
    expect(listFamily(list, 'rumah', 'id')).toEqual([])
  })
})
