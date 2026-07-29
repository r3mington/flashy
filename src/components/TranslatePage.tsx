import { useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, type Card, type Reveal, type TranslationSession } from '../db'
import { ApiError, alignDialogue, gradeTranslation, writeDialogue } from '../ai'
import { defKey } from '../text'
import { rootCandidates } from '../lemma'
import { langCodeFor, loadVoices, preferredVoice, speak, speechSupported, stopSpeaking } from '../speech'
import { Icon } from './Icon'

interface Props {
  deckId: number
  initialSessionId?: number
  onExit: () => void
}

const PHASE_LABEL: Record<'writing' | 'aligning' | 'grading', string> = {
  writing: 'Writing the dialogue…',
  aligning: 'Working out the hints…',
  grading: 'Reading your translation…',
}

const LEVEL_LABEL: Record<1 | 2 | 3, string> = {
  1: 'Base forms',
  2: 'Prefixes',
  3: 'Full spoken',
}

/** What each grammar level opens up, in the learner's own terms. */
const LEVEL_BLURB: Record<1 | 2 | 3, string> = {
  1: 'Bare verbs, one clause a line, tidak / bukan, time by adverb. No affixes at all.',
  2: 'Adds ber- and me- verbs, the -nya clitic, simple yang, one subordinate clause.',
  3: 'Adds di- passives, -kan / -i, particles (kok, sih, dong) and colloquial forms.',
}

/** Letters of the root the half reveal shows. A flat three is too generous on
 *  short words — "gat—" hands you "gato" — so it scales with length. */
function halfReveal(root: string): string {
  const n = Math.min(3, Math.ceil(root.length / 2))
  return root.slice(0, n) + '—'.repeat(Math.max(1, root.length - n))
}

interface Tok {
  text: string
  /** Index into the turn's hints, or null where nothing is revealable. */
  hint: number | null
  /** Inside a square-bracket disambiguation note — shown, never tappable. */
  bracket: boolean
}

const isSpace = (s: string) => /^\s+$/.test(s)

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** Split an English line into tokens and mark which hint covers each one, so a
 *  tap anywhere in "fried rice" reveals the one word behind the whole phrase.
 *  Longer hints claim their words first; anything unmatched stays untappable. */
function alignEnglish(english: string, hints: { en: string }[]): Tok[] {
  const raw = english.split(/(\s+)/).filter((t) => t !== '')
  let open = false
  const toks: Tok[] = raw.map((text) => {
    const starts = text.includes('[')
    const bracket = open || starts
    if (starts) open = true
    if (text.includes(']')) open = false
    return { text, hint: null, bracket }
  })

  const words = (s: string) => s.split(/\s+/).map(defKey).filter(Boolean)
  const order = hints
    .map((_, i) => i)
    .sort((a, b) => words(hints[b].en).length - words(hints[a].en).length)

  for (const hi of order) {
    const want = words(hints[hi].en)
    if (want.length === 0) continue
    for (let start = 0; start < toks.length; start++) {
      if (isSpace(toks[start].text)) continue
      let k = start
      let w = 0
      let last = start
      while (k < toks.length && w < want.length) {
        const t = toks[k]
        if (isSpace(t.text)) {
          k++
          continue
        }
        if (t.bracket || t.hint !== null || defKey(t.text) !== want[w]) break
        last = k
        w++
        k++
      }
      if (w === want.length) {
        // Claim the whitespace inside the span too, so the phrase renders as
        // one tappable unit rather than three.
        for (let i = start; i <= last; i++) toks[i].hint = hi
        break
      }
    }
  }
  return toks
}

/** Merge adjacent tokens sharing a hint (or sharing none) into render groups. */
function groupTokens(toks: Tok[]): { text: string; hint: number | null }[] {
  const out: { text: string; hint: number | null }[] = []
  for (const t of toks) {
    const prev = out[out.length - 1]
    if (prev && prev.hint === t.hint) prev.text += t.text
    else out.push({ text: t.text, hint: t.hint })
  }
  return out
}

function countReveals(session: TranslationSession) {
  let half = 0
  let open = 0
  for (const turn of session.reveals ?? []) {
    for (const r of turn ?? []) {
      if (r === 1) half++
      else if (r === 2) open++
    }
  }
  return { half, open, shown: (session.shown ?? []).filter(Boolean).length }
}

export function TranslatePage({ deckId, initialSessionId, onExit }: Props) {
  const [topic, setTopic] = useState('')
  const [level, setLevel] = useState<1 | 2 | 3>(1)
  const [turnCount, setTurnCount] = useState(10)
  const [coverage, setCoverage] = useState(20)
  const [scope, setScope] = useState<'known' | 'all'>('known')
  const [loading, setLoading] = useState(false)
  const [phase, setPhase] = useState<'writing' | 'aligning' | 'grading'>('writing')
  const [error, setError] = useState('')
  const [session, setSession] = useState<TranslationSession | null>(null)
  const [draft, setDraft] = useState('')
  const [voice, setVoice] = useState<SpeechSynthesisVoice | null>(null)
  const answerRef = useRef<HTMLTextAreaElement | null>(null)
  const autoOpenedRef = useRef<number | null>(null)

  const deck = useLiveQuery(() => db.decks.get(deckId), [deckId])
  const cards = useLiveQuery(() => db.cards.where('deckId').equals(deckId).toArray(), [deckId])
  const saved = useLiveQuery(
    () => db.translations.where('deckId').equals(deckId).reverse().sortBy('createdAt'),
    [deckId],
  )

  const langCode = deck ? langCodeFor(deck.language) : null

  useEffect(() => {
    if (!speechSupported || !langCode) return
    loadVoices().then((vs) => setVoice(preferredVoice(vs, langCode)))
  }, [langCode])

  useEffect(() => () => stopSpeaking(), [])

  const bankCards = useMemo(
    () => (cards ?? []).filter((c) => (scope === 'known' ? c.known : true)),
    [cards, scope],
  )

  // Cards keyed by their word, plus by every root form, so a revealed target
  // word can be traced back to the card it came from.
  const cardByKey = useMemo(() => {
    const map = new Map<string, Card>()
    for (const c of cards ?? []) map.set(defKey(c.word), c)
    return map
  }, [cards])

  const findCard = (word: string): Card | undefined => {
    const key = defKey(word)
    if (!key) return undefined
    const direct = cardByKey.get(key)
    if (direct) return direct
    for (const r of rootCandidates(key, langCode)) {
      const hit = cardByKey.get(r)
      if (hit) return hit
    }
    return undefined
  }

  // Resume a session linked to directly (deep link or the saved list).
  useEffect(() => {
    if (initialSessionId == null || autoOpenedRef.current === initialSessionId || !saved) return
    const s = saved.find((x) => x.id === initialSessionId)
    if (s) {
      autoOpenedRef.current = initialSessionId
      setSession(s)
      setDraft(s.answers[s.at] ?? '')
    }
  }, [initialSessionId, saved])

  const maxCoverage = Math.max(5, Math.min(60, bankCards.length))
  const effectiveCoverage = Math.min(coverage, maxCoverage)

  if (!deck || !cards) return null

  const bankEmpty = bankCards.length === 0

  /** Persist a change to the open session and keep it on screen. */
  function patch(changes: Partial<TranslationSession>) {
    if (!session) return
    const next = { ...session, ...changes }
    setSession(next)
    db.translations.put(next)
  }

  async function run() {
    setLoading(true)
    setPhase('writing')
    setError('')
    try {
      const dialogue = await writeDialogue({
        deck: deck!,
        knownWords: bankCards.map((c) => c.word),
        level,
        turns: turnCount,
        coverage: effectiveCoverage,
        topic: topic.trim() || undefined,
        avoidThemes: (saved ?? []).slice(0, 6).map((s) => s.title),
      })
      if (dialogue.turns.length === 0) throw new Error('The dialogue came back empty — try again.')

      setPhase('aligning')
      let aligned: Awaited<ReturnType<typeof alignDialogue>> = []
      try {
        aligned = await alignDialogue({ deck: deck!, dialogue })
      } catch {
        // Hints are a convenience; losing them shouldn't cost the dialogue.
      }
      const hintsFor = new Map(aligned.map((a) => [a.index, a.hints ?? []]))

      const turns = dialogue.turns.map((t, i) => ({
        speaker: t.speaker,
        english: t.english,
        target: t.target,
        hints: (hintsFor.get(i) ?? []).filter((h) => h.en && h.target),
      }))

      // Which bank words the dialogue really used — coverage as fact.
      const usedKeys = new Set<string>()
      for (const t of turns) {
        for (const w of t.target.split(/\s+/)) {
          const card = findCard(w)
          if (card) usedKeys.add(card.word)
        }
      }

      const record: Omit<TranslationSession, 'id'> = {
        deckId,
        title: dialogue.title,
        scene: dialogue.scene,
        level,
        turns,
        answers: turns.map(() => ''),
        reveals: turns.map((t) => t.hints.map(() => 0 as Reveal)),
        shown: turns.map(() => false),
        at: 0,
        bankWords: [...usedKeys],
        topic: topic.trim() || undefined,
        createdAt: Date.now(),
      }
      const id = await db.translations.add(record as TranslationSession)
      setSession({ ...record, id } as TranslationSession)
      setDraft('')
    } catch (e) {
      setError(
        e instanceof ApiError || e instanceof Error
          ? e.message
          : 'Something went wrong generating the dialogue.',
      )
    } finally {
      setLoading(false)
    }
  }

  /** Bump the struggle counter on every card the learner needed help with.
   *  Nothing else about the card changes — a revealed word is recorded, not
   *  demoted. */
  async function recordLookups(s: TranslationSession) {
    const hits = new Map<number, number>()
    s.turns.forEach((turn, ti) => {
      turn.hints.forEach((h, hi) => {
        if ((s.reveals[ti]?.[hi] ?? 0) === 0) return
        const card = findCard(h.root) ?? findCard(h.target)
        if (card) hits.set(card.id, (hits.get(card.id) ?? 0) + 1)
      })
    })
    await db.transaction('rw', db.cards, async () => {
      for (const [id, n] of hits) {
        const card = await db.cards.get(id)
        if (card) await db.cards.update(id, { lookups: (card.lookups ?? 0) + n })
      }
    })
  }

  async function finish(value = draft) {
    if (!session) return
    const answers = session.answers.slice()
    answers[session.at] = value
    setLoading(true)
    setPhase('grading')
    setError('')
    try {
      const grade = await gradeTranslation({
        deck: deck!,
        scene: session.scene,
        level: session.level,
        lines: session.turns.map((t, i) => ({
          speaker: t.speaker,
          english: t.english,
          reference: t.target,
          answer: answers[i] ?? '',
          shown: session.shown[i] ?? false,
          revealed: t.hints
            .filter((_, hi) => (session.reveals[i]?.[hi] ?? 0) > 0)
            .map((h) => h.target),
        })),
      })
      const lines = session.turns.map((_, i) => {
        const found = grade.lines?.find((l) => l.index === i)
        const skipped = !(answers[i] ?? '').trim()
        return {
          verdict: skipped ? ('skipped' as const) : (found?.verdict ?? 'missed'),
          note: found?.note ?? (skipped ? 'Skipped.' : 'No feedback came back for this line.'),
          corrected: found?.corrected,
        }
      })
      await patch({
        answers,
        grade: { lines, overall: grade.overall, pattern: grade.pattern },
        completedAt: Date.now(),
      })
      await recordLookups({ ...session, answers })
    } catch (e) {
      setError(
        e instanceof ApiError || e instanceof Error ? e.message : 'Grading failed — try again.',
      )
    } finally {
      setLoading(false)
    }
  }

  function commit(next: number, value = draft) {
    if (!session) return
    const answers = session.answers.slice()
    answers[session.at] = value
    patch({ answers, at: next })
    setDraft(answers[next] ?? '')
    answerRef.current?.focus()
  }

  function tapHint(hintIndex: number) {
    if (!session) return
    const reveals = session.reveals.map((r) => r.slice())
    const row = reveals[session.at] ?? []
    row[hintIndex] = Math.min(2, (row[hintIndex] ?? 0) + 1) as Reveal
    reveals[session.at] = row
    patch({ reveals })
  }

  function showLine() {
    if (!session) return
    const shown = session.shown.slice()
    shown[session.at] = true
    patch({ shown })
  }

  const speakLine = (text: string) => {
    stopSpeaking()
    speak(text, { voice, lang: langCode ?? undefined, rate: 0.9 })
  }

  // ─── Setup ────────────────────────────────────────────────────────────────

  if (session === null) {
    return (
      <>
        <div className="page-head">
          <h1>Translate</h1>
          <span className="sub">
            {deck.name} · {bankCards.length}{' '}
            {scope === 'known' ? 'known words' : 'words'} to draw on
          </span>
        </div>

        <div className="story-form">
          <div className="field">
            <label htmlFor="tr-topic">Situation (optional)</label>
            <input
              id="tr-topic"
              autoFocus
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !loading && !bankEmpty && run()}
              placeholder="e.g. haggling over a price at the market"
            />
          </div>

          <div className="field">
            <label>Build from</label>
            <div className="seg-control">
              <button
                type="button"
                className={scope === 'known' ? 'on' : ''}
                onClick={() => setScope('known')}
              >
                Words I know
              </button>
              <button
                type="button"
                className={scope === 'all' ? 'on' : ''}
                onClick={() => setScope('all')}
              >
                All my words
              </button>
            </div>
          </div>

          <div className="field">
            <label>Grammar level</label>
            <div className="seg-control">
              {([1, 2, 3] as const).map((l) => (
                <button key={l} type="button" className={level === l ? 'on' : ''} onClick={() => setLevel(l)}>
                  {l} · {LEVEL_LABEL[l]}
                </button>
              ))}
            </div>
            <p className="note no-top">{LEVEL_BLURB[level]}</p>
          </div>

          <div className="field">
            <label htmlFor="tr-turns">Length · {turnCount} lines to translate</label>
            <input
              id="tr-turns"
              type="range"
              min={4}
              max={24}
              step={2}
              value={turnCount}
              onChange={(e) => setTurnCount(Number(e.target.value))}
            />
          </div>

          <div className="field">
            <label htmlFor="tr-coverage">
              Cover at least {effectiveCoverage} of my words
              {effectiveCoverage > turnCount * 2.5 ? ' · ambitious for this length' : ''}
            </label>
            <input
              id="tr-coverage"
              type="range"
              min={5}
              max={maxCoverage}
              step={1}
              value={effectiveCoverage}
              onChange={(e) => setCoverage(Number(e.target.value))}
            />
          </div>

          <p className="note">
            Writes a {deck.language} dialogue from your word bank, then shows you only the English.
            You write the {deck.language} back, line by line. Tap an English word for the first
            letters of its root, tap again for the whole word — every peek is recorded, nothing in
            your deck changes.
          </p>
          {bankEmpty && (
            <p className="note error-note">
              {scope === 'known'
                ? 'No words marked known in this deck yet. Switch to “All my words”, or mark some cards known first.'
                : 'This deck has no cards yet.'}
            </p>
          )}
          {error && <p className="note error-note">{error}</p>}

          <div className="story-form-actions">
            <button className="btn ghost" onClick={onExit}>
              Cancel
            </button>
            <button className="btn accent" onClick={() => run()} disabled={loading || bankEmpty}>
              {loading ? PHASE_LABEL[phase] : <>✦ Write the dialogue</>}
            </button>
          </div>
        </div>

        {(saved ?? []).length > 0 && (
          <div className="story-saved">
            <div className="eyebrow">Earlier dialogues</div>
            {(saved ?? []).map((s) => {
              const done = s.grade != null
              return (
                <div className="story-saved-row" key={s.id}>
                  <button
                    className="story-saved-open"
                    onClick={() => {
                      setSession(s)
                      setDraft(s.answers[s.at] ?? '')
                    }}
                  >
                    <span className="story-saved-title">{s.title}</span>
                    <span className="story-saved-meta">
                      {s.turns.length} lines · level {s.level} ·{' '}
                      {done ? 'graded' : `stopped at line ${s.at + 1}`}
                    </span>
                  </button>
                  <button
                    className="btn ghost small"
                    title="Delete this dialogue"
                    onClick={() => db.translations.delete(s.id)}
                  >
                    <Icon name="x" />
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </>
    )
  }

  // ─── Results ──────────────────────────────────────────────────────────────

  const counts = countReveals(session)

  if (session.grade) {
    const grade = session.grade
    const helped = session.turns.flatMap((t, ti) =>
      t.hints
        .map((h, hi) => ({ ...h, level: session.reveals[ti]?.[hi] ?? 0 }))
        .filter((h) => h.level > 0),
    )
    const byWord = new Map<string, { target: string; root: string; level: number; n: number }>()
    for (const h of helped) {
      const prev = byWord.get(h.target)
      if (prev) {
        prev.n++
        prev.level = Math.max(prev.level, h.level)
      } else byWord.set(h.target, { target: h.target, root: h.root, level: h.level, n: 1 })
    }
    const tally = [...byWord.values()].sort((a, b) => b.level - a.level || b.n - a.n)

    return (
      <div className="translate-page">
        <div className="page-head">
          <h1>{session.title}</h1>
          <span className="sub">{session.scene}</span>
        </div>

        <div className="tr-tally">
          <span>
            <b>{session.turns.length}</b> {session.turns.length === 1 ? 'line' : 'lines'}
          </span>
          <span>
            <b>{counts.half}</b> {counts.half === 1 ? 'half-peek' : 'half-peeks'}
          </span>
          <span>
            <b>{counts.open}</b> opened
          </span>
          <span>
            <b>{counts.shown}</b> shown
          </span>
        </div>

        <p className="tr-overall">{grade.overall}</p>
        {grade.pattern && (
          <p className="tr-pattern">
            <span className="eyebrow">Work on next</span>
            {grade.pattern}
          </p>
        )}

        <div className="tr-results">
          {session.turns.map((turn, i) => {
            const line = grade.lines[i]
            const answer = (session.answers[i] ?? '').trim()
            return (
              <div className={`tr-result v-${line?.verdict ?? 'missed'}`} key={i}>
                <div className="tr-result-head">
                  <span className="tr-speaker">{turn.speaker}</span>
                  <span className={`tr-verdict v-${line?.verdict ?? 'missed'}`}>
                    {line?.verdict ?? 'missed'}
                  </span>
                </div>
                <div className="tr-en">{turn.english}</div>
                <div className="tr-yours">{answer || <em>skipped</em>}</div>
                {line?.corrected && line.corrected.trim() !== answer && (
                  <div className="tr-fixed">{line.corrected}</div>
                )}
                {line?.note && <div className="tr-note">{line.note}</div>}
                <div className="tr-ref">
                  <span>{turn.target}</span>
                  {speechSupported && (
                    <button
                      className="btn ghost small"
                      title="Hear it"
                      onClick={() => speakLine(turn.target)}
                    >
                      <Icon name="volume" />
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>

        {tally.length > 0 && (
          <div className="tr-helped">
            <div className="eyebrow">Words you needed help with</div>
            <p className="note no-top">
              Recorded against these cards as lookups. Nothing has been unmarked — your deck is
              exactly as you left it.
            </p>
            <div className="chip-list">
              {tally.map((h) => (
                <span className={`chip${h.level === 2 ? ' tr-opened' : ''}`} key={h.target}>
                  {h.target}
                  {h.root !== h.target && <em> · {h.root}</em>}
                  {h.n > 1 && <em> ×{h.n}</em>}
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="story-form-actions">
          <button className="btn ghost" onClick={onExit}>
            Done
          </button>
          <button
            className="btn"
            onClick={() => {
              setSession(null)
              setDraft('')
            }}
          >
            New dialogue
          </button>
        </div>
      </div>
    )
  }

  // ─── Translating ──────────────────────────────────────────────────────────

  const turn = session.turns[session.at]
  const reveals = session.reveals[session.at] ?? []
  const toks = groupTokens(alignEnglish(turn.english, turn.hints))
  const last = session.at === session.turns.length - 1

  return (
    <div className="translate-page">
      <div className="page-head">
        <h1>{session.title}</h1>
        <span className="sub">
          Line {session.at + 1} of {session.turns.length} · level {session.level}
        </span>
      </div>

      <p className="tr-scene">{session.scene}</p>

      <div className="tr-done">
        {session.turns.slice(0, session.at).map((t, i) => (
          <div className="tr-done-turn" key={i}>
            <span className="tr-speaker">{t.speaker}</span>
            <span className="tr-done-en">{t.english}</span>
            <span className="tr-done-mine">{session.answers[i]?.trim() || '—'}</span>
          </div>
        ))}
      </div>

      <div className="tr-current">
        <div className="tr-speaker">{turn.speaker}</div>
        <div className="tr-prompt">
          {toks.map((g, i) =>
            g.hint === null ? (
              <span key={i}>{g.text}</span>
            ) : (
              <button
                key={i}
                className={`tr-word r${reveals[g.hint] ?? 0}`}
                onClick={() => tapHint(g.hint!)}
                title={
                  (reveals[g.hint] ?? 0) === 0
                    ? 'Show the first letters of the root'
                    : (reveals[g.hint] ?? 0) === 1
                      ? 'Show the whole word'
                      : undefined
                }
              >
                <span className="tr-word-en">{g.text}</span>
                {(reveals[g.hint] ?? 0) > 0 && (
                  <span className="tr-word-hint">
                    {reveals[g.hint] === 1
                      ? halfReveal(turn.hints[g.hint].root)
                      : turn.hints[g.hint].target}
                  </span>
                )}
              </button>
            ),
          )}
        </div>

        <textarea
          className="tr-answer"
          ref={answerRef}
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !loading) {
              e.preventDefault()
              if (last) finish()
              else commit(session.at + 1)
            }
          }}
          placeholder={`In ${deck.language}…`}
          rows={2}
        />

        {session.shown[session.at] && <div className="tr-shown">{turn.target}</div>}

        <div className="tr-actions">
          <button
            className="btn ghost small"
            onClick={() => commit(session.at - 1)}
            disabled={session.at === 0}
          >
            ← Back
          </button>
          {!session.shown[session.at] && (
            <button className="btn ghost small" onClick={showLine}>
              Show me
            </button>
          )}
          <div className="spacer" />
          <button
            className="btn ghost small"
            title="Leave this line blank and move on"
            onClick={() => (last ? finish('') : commit(session.at + 1, ''))}
          >
            Skip
          </button>
          <button
            className="btn accent"
            onClick={() => (last ? finish() : commit(session.at + 1))}
            disabled={loading}
          >
            {loading ? PHASE_LABEL[phase] : last ? 'Finish & grade' : 'Next'}
          </button>
        </div>
        {error && <p className="note error-note">{error}</p>}
      </div>

      <div className="tr-footer">
        <span>
          {plural(counts.half, 'half-peek')} · {counts.open} opened · {counts.shown} shown
        </span>
        <button
          className="btn ghost small"
          onClick={() => {
            setSession(null)
            setDraft('')
          }}
        >
          Save & close
        </button>
      </div>
    </div>
  )
}
