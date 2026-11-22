import type { CSSProperties } from 'react'
import { DEFAULT_STORY_COLORS, type StoryColors } from './db'

/** A saved palette with any kind it predates filled in — settings saved
 *  before "rare" existed have no colour for it. */
export function withDefaults(colors: Partial<StoryColors> | undefined): StoryColors {
  return { ...DEFAULT_STORY_COLORS, ...colors }
}

/** Turn the reader's palette choice into the `--c-*` variables the story-word
 *  CSS rules read. Set on any element wrapping coloured words — the story body
 *  itself, or the swatch preview in Options. Keeping the mapping here means
 *  the preview and the real thing can't drift apart. */
export function storyColorVars(saved: StoryColors): CSSProperties {
  const colors = withDefaults(saved)
  return {
    '--c-new': `var(--hue-${colors.new})`,
    '--c-rare': `var(--hue-${colors.rare})`,
    '--c-study': `var(--hue-${colors.study})`,
    '--c-name': `var(--hue-${colors.name})`,
    '--c-known': `var(--hue-${colors.known})`,
  } as CSSProperties
}
