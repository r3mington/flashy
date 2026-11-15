import { useState } from 'react'
import { bandFor, type StoryBrief, type writeStoryDraft } from '../ai'
import { countWords } from '../text'

type DraftInput = Parameters<typeof writeStoryDraft>[0]

/** A debugging view of the story writer: the exact prompt the next story
 *  would be written from, built from the same inputs the Generate button
 *  uses, without sending anything. Shows what went into it — the words, the
 *  rolls — above the prompt itself, so a change to either can be read
 *  rather than guessed at. */
export function PromptPreview(props: {
  brief: StoryBrief
  input: DraftInput
  /** Build it again: the ending, cliffhanger and word handful are re-rolled. */
  onReroll: () => void
  onClose: () => void
}) {
  const { brief, input, onReroll, onClose } = props
  const [copied, setCopied] = useState(false)
  const kind = input.kind ?? 'story'
  const register = input.register ?? 'standard'
  const band = bandFor(input.vocabLevel)

  async function copy() {
    try {
      await navigator.clipboard.writeText(brief.prompt)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard blocked: the text is selectable anyway.
    }
  }

  const facts: [string, string][] = [
    ['Kind', kind === 'learn' ? 'Learn (explains a real topic)' : 'Story'],
    [
      'Speech',
      register === 'friend' ? 'Told by a friend' : register === 'casual' ? 'Casual' : 'Standard',
    ],
    ['Difficulty', `${band.label} · ${band.cefr} · ~${band.commonWords} commonest words`],
    ['Length asked for', `about ${input.lengthWords} words`],
    ...(kind === 'story'
      ? ([['Ending rolled', brief.ending === 'resolve' ? 'Settle the trouble' : 'Cliffhanger']] as [
          string,
          string,
        ][])
      : []),
    ...(input.continueFrom
      ? ([['Continuing', `“${input.continueFrom.title}”`]] as [string, string][])
      : []),
  ]

  const wordRows: [string, string, string[] | undefined][] = [
    ['Keeps forgetting', 'first in line', input.focusWords],
    ['Common, never met', 'next', input.commonWords],
    ['Due to come back', 'then', input.recurWords],
  ]

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal prompt-preview" onClick={(e) => e.stopPropagation()}>
        <h2>Prompt preview</h2>
        <p className="note no-top">
          The exact instructions the story writer would get if you pressed Generate now. Nothing is
          sent. The ending, the cliffhanger style and the handful of your words are picked at random,
          so they change each time.
        </p>

        <dl className="prompt-facts">
          {facts.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>

        <div className="eyebrow">Words handed to the writer</div>
        <dl className="prompt-facts">
          {wordRows.map(([label, when, words]) => (
            <div key={label}>
              <dt>
                {label} <span className="prompt-when">({when})</span>
              </dt>
              <dd>{words && words.length > 0 ? words.join(', ') : '—'}</dd>
            </div>
          ))}
          <div>
            <dt>
              Sent, after trimming to 20 <span className="prompt-when">(the rest at random)</span>
            </dt>
            <dd>{brief.wanted.length > 0 ? brief.wanted.join(', ') : '—'}</dd>
          </div>
        </dl>

        {brief.needsPlan && (
          <p className="note">
            A new Learn series is planned by a separate call first. The plan then appears in this
            prompt; it is shown here without one.
          </p>
        )}

        <div className="prompt-head">
          <div className="eyebrow">
            The prompt · {countWords(brief.prompt, 'en')} words · {brief.prompt.length} characters
          </div>
          <button className="btn small ghost" onClick={copy}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <pre className="prompt-text">{brief.prompt}</pre>

        {brief.retryPrompt && (
          <details className="prompt-retry">
            <summary>Fallback prompt, used only if the AI refuses the one above</summary>
            <p className="note">
              Same instructions with the previous part cut to its last few paragraphs and the
              characters’ secrets left out.
            </p>
            <pre className="prompt-text">{brief.retryPrompt}</pre>
          </details>
        )}

        <p className="note">
          After the story is written, separate calls make it longer if it came out short, swap hard
          words for easier ones, update the series notes, translate it and look up the words. Those
          prompts are not shown here.
        </p>

        <div className="modal-actions">
          <button className="btn ghost left" onClick={onReroll}>
            Roll again
          </button>
          <button className="btn accent" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
