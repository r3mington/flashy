import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useDeck } from '../useDeck'
import { db, newCardDefaults, statusPatch } from '../db'
import {
  COMMON_BANDS,
  bandProgress,
  commonStatuses,
  entriesOf,
  type CommonEntry,
  type CommonList,
} from '../commonWords'
import { useSettings } from '../useSettings'

interface Props {
  deckId: number
  /** Unused for now: the top bar's Back already returns to the deck. */
  onExit?: () => void
}

/** How many missing words one "add the next ones" tap puts into study. */
const ADD_BATCH = 10

/** The 4,000 most common words of the deck's language, each coloured by
 *  whether the deck has it — known, in study, or not yet. */
export function CommonWordsPage({ deckId }: Props) {
  const { deck, cards, langCode } = useDeck(deckId)
  const settings = useSettings()
  const [list, setList] = useState<CommonList | null>(null)
  const [loadError, setLoadError] = useState('')
  const [adding, setAdding] = useState<Set<string>>(new Set())
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

  if (!deck || !cards) return null

  // Three steps that read apart at night: missing words dim, studying in the
  // colour it wears in stories, known in full-strength ink. (Two hues side by
  // side — teal and green — were indistinguishable on the dark ground.)
  // A study colour of 'plain' would match known, so it falls back to green.
  const studyHue = settings.storyColors.study
  const colors = {
    '--cw-known': 'var(--ink)',
    '--cw-study': `var(--hue-${studyHue === 'plain' ? 'green' : studyHue})`,
  } as CSSProperties

  async function addToStudy(words: CommonEntry[]) {
    const fresh = words.filter((e) => !statuses.has(e.word) && !adding.has(e.word))
    if (fresh.length === 0) return
    setAdding((s) => new Set([...s, ...fresh.map((e) => e.word)]))
    await db.cards.bulkAdd(
      fresh.map((e) => ({
        deckId,
        word: e.word,
        meaning: e.meaning,
        example: '',
        ...newCardDefaults(),
        ...statusPatch('inStudy'),
      })),
    )
    setAdding((s) => {
      const next = new Set(s)
      for (const e of fresh) next.delete(e.word)
      return next
    })
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

  return (
    <div className="common-page" style={colors}>
      {head}
      <p className="note">
        The {entries.length.toLocaleString()} most common words of everyday Indonesian, checked
        against this deck. A word counts as yours when you have it, one of its forms, or a word
        built on it.
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
                <span>{(b.size - b.known - b.study).toLocaleString()} to go</span>
              </span>
            </button>
          )
        })}
      </div>

      {COMMON_BANDS.map((size, i) => {
        const from = i === 0 ? 0 : COMMON_BANDS[i - 1]
        const slice = entries.slice(from, size)
        const missing = slice.filter((e) => !statuses.has(e.word))
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
              </div>
              {missing.length > 0 && (
                <button
                  className="btn small"
                  onClick={() => addToStudy(missing.slice(0, ADD_BATCH))}
                  title={`Put the ${Math.min(ADD_BATCH, missing.length)} most common words you don't have yet from this band into study`}
                >
                  + Study the next {Math.min(ADD_BATCH, missing.length)}
                </button>
              )}
            </div>
            <ol className="cw-list">
              {slice.map((e) => {
                const s = statuses.get(e.word)
                return (
                  <li key={e.word} className={`cw-row is-${s ?? 'missing'}`}>
                    <span className="cw-rank">{e.rank}</span>
                    <span className="cw-word">{e.word}</span>
                    <span className="cw-meaning">{e.meaning}</span>
                    {s === 'known' ? (
                      <span className="cw-status">✓ known</span>
                    ) : s === 'study' ? (
                      <span className="cw-status">studying</span>
                    ) : (
                      <button
                        className="cw-add"
                        disabled={adding.has(e.word)}
                        onClick={() => addToStudy([e])}
                        title={`Put “${e.word}” into study`}
                        aria-label={`Put ${e.word} into study`}
                      >
                        +
                      </button>
                    )}
                  </li>
                )
              })}
            </ol>
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
