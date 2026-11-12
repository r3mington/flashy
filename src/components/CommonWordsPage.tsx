import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useDeck } from '../useDeck'
import { db, newCardDefaults, setCardStatus, statusPatch, type WordStatus } from '../db'
import {
  COMMON_BANDS,
  bandProgress,
  commonStatuses,
  entriesOf,
  entryCards,
  type CommonEntry,
  type CommonList,
  type CommonStatus,
} from '../commonWords'
import { useSettings } from '../useSettings'

interface Props {
  deckId: number
  /** Unused for now: the top bar's Back already returns to the deck. */
  onExit?: () => void
}

/** How many missing words one "add the next ones" tap puts into study. */
const ADD_BATCH = 10

type Filter = 'all' | CommonStatus

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'missing', label: 'To learn' },
  { key: 'study', label: 'Studying' },
  { key: 'known', label: 'Known' },
  { key: 'ignored', label: 'Ignored' },
]

/** The choices a word's row opens to — the same three statuses the story
 *  reader's pop-up offers. */
const CHOICES: { key: WordStatus; status: CommonStatus; label: string; title: string }[] = [
  { key: 'inStudy', status: 'study', label: 'Studying', title: 'Put it into study' },
  { key: 'known', status: 'known', label: 'Known', title: 'You know it — out of study, counted as known' },
  { key: 'ignored', status: 'ignored', label: 'Ignore', title: 'Not worth learning — never counted as known or to learn' },
]

const FILTER_KEY = 'flashy:common-filter'

/** The 4,000 most common words of the deck's language, each coloured by
 *  whether the deck has it — known, in study, ignored, or not yet. */
export function CommonWordsPage({ deckId }: Props) {
  const { deck, cards, langCode } = useDeck(deckId)
  const settings = useSettings()
  const [list, setList] = useState<CommonList | null>(null)
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState<Set<string>>(new Set())
  const [open, setOpen] = useState<string | null>(null)
  const [filter, setFilterState] = useState<Filter>(() => {
    try {
      const saved = localStorage.getItem(FILTER_KEY) as Filter | null
      return saved && FILTERS.some((f) => f.key === saved) ? saved : 'all'
    } catch {
      return 'all'
    }
  })
  const setFilter = (f: Filter) => {
    setFilterState(f)
    try {
      localStorage.setItem(FILTER_KEY, f)
    } catch {
      // A private window: the filter just isn't remembered.
    }
  }
  const sectionRefs = useRef<(HTMLElement | null)[]>([])

  // The list is a large file; it loads when the page opens, not with the app.
  useEffect(() => {
    if (langCode !== 'id') return
    let live = true
    import('../data/common-words-id.json')
      .then((m) => live && setList(m.default as unknown as CommonList))
      .catch(() => live && setLoadError('The word list could not be loaded.'))
    return () => {
      live = false
    }
  }, [langCode])

  const entries = useMemo(() => (list ? entriesOf(list) : []), [list])
  const statuses = useMemo(
    () => commonStatuses(entries, cards ?? [], langCode),
    [entries, cards, langCode],
  )
  const statusOfEntry = (e: CommonEntry): CommonStatus => statuses.get(e.word) ?? 'missing'

  if (!deck || !cards) return null

  // Steps that read apart at night: missing words dim, studying in the colour
  // it wears in stories, known in full-strength ink, ignored struck through.
  // (Teal and green side by side were indistinguishable on the dark ground.)
  // A study colour of 'plain' would match known, so it falls back to green.
  const studyHue = settings.storyColors.study
  const colors = {
    '--cw-known': 'var(--ink)',
    '--cw-study': `var(--hue-${studyHue === 'plain' ? 'green' : studyHue})`,
  } as CSSProperties

  /** Give these entries a status. A word the deck already has — itself or one
   *  of its forms — has those cards moved; a word it lacks gets a new card. */
  async function setStatus(words: CommonEntry[], status: WordStatus) {
    const todo = words.filter((e) => !busy.has(e.word))
    if (todo.length === 0) return
    setBusy((s) => new Set([...s, ...todo.map((e) => e.word)]))
    try {
      const move: number[] = []
      const add: CommonEntry[] = []
      for (const e of todo) {
        const own = entryCards(e, cards ?? [])
        if (own.length > 0) move.push(...own.map((c) => c.id))
        else add.push(e)
      }
      if (move.length > 0) await setCardStatus(move, status)
      if (add.length > 0)
        await db.cards.bulkAdd(
          add.map((e) => ({
            deckId,
            word: e.word,
            meaning: e.meaning,
            example: '',
            ...newCardDefaults(),
            ...statusPatch(status),
          })),
        )
    } finally {
      setBusy((s) => {
        const next = new Set(s)
        for (const e of todo) next.delete(e.word)
        return next
      })
    }
  }

  const head = (
    <div className="page-head">
      <h1>Common words</h1>
      <span className="sub">{deck.name}</span>
    </div>
  )

  if (langCode !== 'id')
    return (
      <>
        {head}
        <p className="note">
          The common-words list exists for Indonesian only so far. This deck is in {deck.language}.
        </p>
      </>
    )

  if (!list)
    return (
      <>
        {head}
        <p className="note">{loadError || 'Loading the word list…'}</p>
      </>
    )

  const bands = COMMON_BANDS.map((size) => bandProgress(entries, statuses, size))
  const filterCounts = new Map<Filter, number>([['all', entries.length]])
  for (const e of entries) {
    const s = statusOfEntry(e)
    filterCounts.set(s, (filterCounts.get(s) ?? 0) + 1)
  }

  return (
    <div className="common-page" style={colors}>
      {head}
      <p className="note">
        The {entries.length.toLocaleString()} most common words of everyday Indonesian, checked
        against this deck. A word counts as yours when you have it, one of its forms, or a word
        built on it. Tap a word to mark it known, studying or ignored.
      </p>

      <div className="cw-bands">
        {bands.map((b, i) => {
          const pct = (n: number) => (n / Math.max(1, b.size)) * 100
          const total = Math.round(pct(b.known + b.study))
          return (
            <button
              key={b.size}
              className="cw-band"
              onClick={() =>
                sectionRefs.current[i]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }
              title={`Go to words ${i * 1000 + 1}–${b.size}`}
            >
              <span className="cw-band-head">
                <b>Top {b.size.toLocaleString()}</b>
                <span className="cw-band-pct">{total}%</span>
              </span>
              <span className="cw-bar" aria-hidden="true">
                <span className="cw-bar-known" style={{ width: `${pct(b.known)}%` }} />
                <span className="cw-bar-study" style={{ width: `${pct(b.study)}%` }} />
              </span>
              <span className="cw-band-counts">
                <span className="cw-known">{b.known.toLocaleString()} known</span>
                <span className="cw-study">{b.study.toLocaleString()} studying</span>
                {b.ignored > 0 && <span>{b.ignored.toLocaleString()} ignored</span>}
                <span>{(b.size - b.known - b.study - b.ignored).toLocaleString()} to learn</span>
              </span>
            </button>
          )
        })}
      </div>

      <div className="cw-filter" role="group" aria-label="Show words">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            className={`cw-chip${filter === f.key ? ' on' : ''}`}
            aria-pressed={filter === f.key}
            onClick={() => setFilter(f.key)}
          >
            {f.label} <span className="cw-filter-count">{(filterCounts.get(f.key) ?? 0).toLocaleString()}</span>
          </button>
        ))}
      </div>

      {COMMON_BANDS.map((size, i) => {
        const from = i === 0 ? 0 : COMMON_BANDS[i - 1]
        const slice = entries.slice(from, size)
        const shown = filter === 'all' ? slice : slice.filter((e) => statusOfEntry(e) === filter)
        const missing = slice.filter((e) => statusOfEntry(e) === 'missing')
        return (
          <section
            key={size}
            className="cw-section"
            ref={(el) => {
              sectionRefs.current[i] = el
            }}
          >
            <div className="cw-section-head">
              <div className="eyebrow">
                Words {(from + 1).toLocaleString()}–{size.toLocaleString()}
                {filter !== 'all' && ` · ${shown.length.toLocaleString()}`}
              </div>
              {missing.length > 0 && (filter === 'all' || filter === 'missing') && (
                <button
                  className="btn small"
                  onClick={() => setStatus(missing.slice(0, ADD_BATCH), 'inStudy')}
                  title={`Put the ${Math.min(ADD_BATCH, missing.length)} most common words you don't have yet from this band into study`}
                >
                  + Study the next {Math.min(ADD_BATCH, missing.length)}
                </button>
              )}
            </div>
            {shown.length === 0 ? (
              <p className="note cw-empty">None here.</p>
            ) : (
              <ol className="cw-list">
                {shown.map((e) => {
                  const s = statusOfEntry(e)
                  const isOpen = open === e.word
                  return (
                    <li key={e.word} className={`cw-row is-${s}${isOpen ? ' is-open' : ''}`}>
                      <button
                        type="button"
                        className="cw-row-main"
                        onClick={() => setOpen(isOpen ? null : e.word)}
                        aria-expanded={isOpen}
                      >
                        <span className="cw-rank">{e.rank}</span>
                        <span className="cw-word">{e.word}</span>
                        <span className="cw-meaning">{e.meaning}</span>
                      </button>
                      {s === 'missing' ? (
                        <span className="cw-quick">
                          <button
                            className="cw-add"
                            disabled={busy.has(e.word)}
                            onClick={() => setStatus([e], 'inStudy')}
                            title={`Put “${e.word}” into study`}
                            aria-label={`Put ${e.word} into study`}
                          >
                            +
                          </button>
                          <button
                            className="cw-add"
                            disabled={busy.has(e.word)}
                            onClick={() => setStatus([e], 'known')}
                            title={`Mark “${e.word}” as known`}
                            aria-label={`Mark ${e.word} as known`}
                          >
                            ✓
                          </button>
                        </span>
                      ) : (
                        <span className="cw-status">
                          {s === 'known' ? '✓ known' : s === 'study' ? 'studying' : 'ignored'}
                        </span>
                      )}
                      {isOpen && (
                        <div className="cw-choices seg-control">
                          {CHOICES.map((c) => (
                            <button
                              key={c.key}
                              type="button"
                              className={s === c.status ? 'on' : ''}
                              title={c.title}
                              disabled={busy.has(e.word) || s === c.status}
                              onClick={() => setStatus([e], c.key)}
                            >
                              {c.label}
                            </button>
                          ))}
                        </div>
                      )}
                    </li>
                  )
                })}
              </ol>
            )}
          </section>
        )
      })}

      <p className="note cw-credit">
        Word list built from{' '}
        <a href="https://github.com/hermitdave/FrequencyWords" target="_blank" rel="noreferrer">
          FrequencyWords
        </a>{' '}
        by Hermit Dave (OpenSubtitles 2018), licensed{' '}
        <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noreferrer">
          CC BY-SA 4.0
        </a>
        . Forms merged into words and meanings added with Gemini.
      </p>
    </div>
  )
}
