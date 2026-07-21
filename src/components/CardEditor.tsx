import { useState } from 'react'
import { db, newCardDefaults, type Card } from '../db'

interface Props {
  deckId: number
  card?: Card // present when editing
  onClose: () => void
}

export function CardEditor({ deckId, card, onClose }: Props) {
  const [word, setWord] = useState(card?.word ?? '')
  const [meaning, setMeaning] = useState(card?.meaning ?? '')
  const [example, setExample] = useState(card?.example ?? '')
  const [exampleTranslation, setExampleTranslation] = useState(card?.exampleTranslation ?? '')
  const [notes, setNotes] = useState(card?.notes ?? '')
  const [emoji, setEmoji] = useState(card?.emoji ?? '')
  const [savedFlash, setSavedFlash] = useState(false)

  const valid = word.trim() && meaning.trim()

  async function save(addAnother: boolean) {
    if (!valid) return
    const fields = {
      word: word.trim(),
      meaning: meaning.trim(),
      example: example.trim(),
      exampleTranslation: exampleTranslation.trim() || undefined,
      notes: notes.trim() || undefined,
      emoji: emoji.trim() || undefined,
    }
    if (card) {
      await db.cards.update(card.id, fields)
    } else {
      await db.cards.add({ deckId, ...fields, ...newCardDefaults() })
    }
    if (addAnother) {
      setWord('')
      setMeaning('')
      setExample('')
      setExampleTranslation('')
      setNotes('')
      setEmoji('')
      setSavedFlash(true)
      setTimeout(() => setSavedFlash(false), 1200)
    } else {
      onClose()
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{card ? 'Edit card' : 'New card'}</h2>
        <div className="field">
          <label htmlFor="card-word">Word</label>
          <input
            id="card-word"
            autoFocus
            value={word}
            onChange={(e) => setWord(e.target.value)}
            placeholder="e.g. berjalan"
          />
        </div>
        <div className="field">
          <label htmlFor="card-meaning">Meaning</label>
          <input
            id="card-meaning"
            value={meaning}
            onChange={(e) => setMeaning(e.target.value)}
            placeholder="e.g. to walk"
          />
        </div>
        <div className="field">
          <label htmlFor="card-example">Example sentence</label>
          <textarea
            id="card-example"
            value={example}
            onChange={(e) => setExample(e.target.value)}
            placeholder="e.g. Saya berjalan ke pasar setiap pagi."
          />
        </div>
        <div className="field">
          <label htmlFor="card-example-tr">Example translation (optional)</label>
          <input
            id="card-example-tr"
            value={exampleTranslation}
            onChange={(e) => setExampleTranslation(e.target.value)}
            placeholder="e.g. I walk to the market every morning."
          />
        </div>
        <div className="field">
          <label htmlFor="card-notes">Notes (optional)</label>
          <input id="card-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="card-emoji">Emoji mnemonic (optional)</label>
          <input
            id="card-emoji"
            value={emoji}
            onChange={(e) => setEmoji(e.target.value)}
            placeholder="e.g. 🚶"
          />
        </div>
        <div className="modal-actions">
          {savedFlash && <span className="note left">Saved ✓</span>}
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          {!card && (
            <button className="btn" onClick={() => save(true)} disabled={!valid}>
              Save & add another
            </button>
          )}
          <button className="btn primary" onClick={() => save(false)} disabled={!valid}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
