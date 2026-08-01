import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, inRotation, type Card } from '../db'
import { Flashcard } from './Flashcard'
import { useSettings } from '../useSettings'

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

export function StudyFlip({ deckId, onExit }: { deckId: number; onExit: () => void }) {
  const settings = useSettings()
  const deck = useLiveQuery(() => db.decks.get(deckId), [deckId])
  const [cards, setCards] = useState<Card[] | null>(null)
  const [index, setIndex] = useState(0)
  const [flipped, setFlipped] = useState(false)

  useEffect(() => {
    let cancelled = false
    db.cards
      .where('deckId')
      .equals(deckId)
      .toArray()
      .then((all) => {
        if (!cancelled) setCards(shuffle(all.filter(inRotation)))
      })
    return () => {
      cancelled = true
    }
  }, [deckId])

  function go(delta: number) {
    if (!cards) return
    setFlipped(false)
    setIndex((i) => Math.min(Math.max(i + delta, 0), cards.length))
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === ' ') {
        e.preventDefault()
        setFlipped((f) => !f)
      } else if (e.key === 'ArrowRight') go(1)
      else if (e.key === 'ArrowLeft') go(-1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!cards) return null

  const current = cards[index]

  if (!current) {
    return (
      <div className="study-done">
        <div className="big">✦</div>
        <h2>{cards.length === 0 ? 'Empty deck' : 'End of deck'}</h2>
        <p>
          {cards.length === 0
            ? 'Add some cards first.'
            : `You flipped through all ${cards.length} cards.`}
        </p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
          {cards.length > 0 && (
            <button
              className="btn"
              onClick={() => {
                setCards(shuffle(cards))
                setIndex(0)
                setFlipped(false)
              }}
            >
              Shuffle again
            </button>
          )}
          <button className="btn primary" onClick={onExit}>
            Back to deck
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="study-wrap">
      <div className="study-progress">
        <span>{index + 1}</span>
        <div className="progress-track">
          <div
            className="progress-fill"
            style={{ width: `${((index + 1) / cards.length) * 100}%` }}
          />
        </div>
        <span>{cards.length}</span>
      </div>

      <Flashcard
        card={current}
        flipped={flipped}
        onFlip={() => setFlipped((f) => !f)}
        dealKey={current.id}
        front={settings.reviewFront}
        mask={settings.maskExample}
        language={deck?.language}
      />

      <div className="grade-row">
        <button className="btn" onClick={() => go(-1)} disabled={index === 0}>
          ← Previous
        </button>
        <button className="btn primary" onClick={() => go(1)}>
          Next →
        </button>
      </div>
    </div>
  )
}
