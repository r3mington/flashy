import { useEffect, useRef } from 'react'
import type { Card } from '../db'
import { useSettings } from '../useSettings'
import {
  langCodeFor,
  loadVoices,
  preferredVoice,
  speak,
  speechSupported,
  stopSpeaking,
} from '../speech'

interface Props {
  card: Card
  flipped: boolean
  onFlip: () => void
  /** Changes when a new card is dealt, to retrigger the deal animation. */
  dealKey: number | string
  /** Which side shows first. */
  front: 'word' | 'meaning'
  /** Blank out the word in the front-side example sentence. */
  mask: boolean
  /** Deck language, e.g. "Indonesian" — enables pronunciation. */
  language?: string
}

export function Flashcard({ card, flipped, onFlip, dealKey, front, mask, language }: Props) {
  const settings = useSettings()
  const frontIsWord = front === 'word'
  const langCode = language ? langCodeFor(language) : null
  const canSpeak = speechSupported && !!language

  async function speakWord() {
    stopSpeaking()
    const voices = await loadVoices()
    await speak(card.word, {
      voice: preferredVoice(voices, langCode),
      lang: langCode ?? undefined,
    })
  }

  // Auto-pronounce the word once per card, when it first becomes visible
  // (immediately if the word side is the front, otherwise on flip).
  const wordVisible = frontIsWord || flipped
  const spokenFor = useRef<number | string | null>(null)
  useEffect(() => {
    if (!canSpeak || !settings.autoSpeak || !wordVisible) return
    if (spokenFor.current === dealKey) return
    spokenFor.current = dealKey
    speakWord()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wordVisible, dealKey, canSpeak, settings.autoSpeak])

  // Don't keep talking after leaving the study screen.
  useEffect(() => () => stopSpeaking(), [])

  const speakBtn = canSpeak && (
    <button
      className="speak-btn"
      title="Pronounce"
      aria-label={`Pronounce ${card.word}`}
      onClick={(e) => {
        e.stopPropagation()
        speakWord()
      }}
    >
      🔊
    </button>
  )

  return (
    <div className="flashcard-scene" onClick={onFlip}>
      <div className={`flashcard dealt${flipped ? ' flipped' : ''}`} key={dealKey}>
        <div className="face front">
          {frontIsWord && settings.showEmoji && card.emoji && (
            <div className="card-emoji">{card.emoji}</div>
          )}
          <div className="word">
            {frontIsWord ? card.word : card.meaning}
            {frontIsWord && speakBtn}
          </div>
          {frontIsWord && card.example && (
            <div className="example">{mask ? maskWord(card.example, card.word) : card.example}</div>
          )}
          <div className="hint">tap or press space to flip</div>
        </div>
        <div className="face back">
          {settings.showEmoji && card.emoji && <div className="card-emoji">{card.emoji}</div>}
          <div className="word">
            {card.word}
            {speakBtn}
          </div>
          <div className="divider-line" />
          <div className="meaning">{card.meaning}</div>
          {card.example && <div className="example">{card.example}</div>}
          {card.exampleTranslation && (
            <div className="example-translation">{card.exampleTranslation}</div>
          )}
        </div>
      </div>
    </div>
  )
}

/** Blank out the target word in the example so the front doesn't give it away. */
function maskWord(example: string, word: string): string {
  if (!word.trim()) return example
  const escaped = word.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return example.replace(new RegExp(escaped, 'gi'), '____')
}
