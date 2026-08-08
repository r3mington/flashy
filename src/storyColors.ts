import type { CSSProperties } from 'react'
import type { StoryColors } from './db'

/** Turn the reader's palette choice into the `--c-*` variables the story-word
 *  CSS rules read. Set on any element wrapping coloured words — the story body
 *  itself, or the swatch preview in Options. Keeping the mapping here means
 *  the preview and the real thing can't drift apart. */
export function storyColorVars(colors: StoryColors): CSSProperties {
  return {
    '--c-new': `var(--hue-${colors.new})`,
    '--c-study': `var(--hue-${colors.study})`,
    '--c-name': `var(--hue-${colors.name})`,
    '--c-known': `var(--hue-${colors.known})`,
  } as CSSProperties
}
