/** Inline stroke icons, sized to the surrounding text (1em) and inheriting its
 *  colour — a consistent replacement for emoji glyphs, which render differently
 *  on every platform and sit awkwardly next to button labels. */

export type IconName =
  | 'play'
  | 'pause'
  | 'stop'
  | 'skipBack'
  | 'skipForward'
  | 'headphones'
  | 'bookmark'
  | 'bookmarkGo'
  | 'x'
  | 'volume'
  | 'book'
  | 'clock'
  | 'chevronUp'
  | 'chevronDown'
  | 'sparkle'

/** Paths are drawn on a 24×24 grid, stroked (not filled) unless noted. */
const PATHS: Record<IconName, React.ReactNode> = {
  play: <path d="M8 5.6v12.8a.5.5 0 0 0 .77.42l9.9-6.4a.5.5 0 0 0 0-.84l-9.9-6.4a.5.5 0 0 0-.77.42Z" />,
  pause: (
    <>
      <path d="M9.25 5.5v13" />
      <path d="M14.75 5.5v13" />
    </>
  ),
  stop: <rect x="6.25" y="6.25" width="11.5" height="11.5" rx="1.75" />,
  skipBack: (
    <>
      <path d="M18.5 6.3v11.4a.5.5 0 0 1-.77.42l-8.6-5.7a.5.5 0 0 1 0-.84l8.6-5.7a.5.5 0 0 1 .77.42Z" />
      <path d="M5.75 5.75v12.5" />
    </>
  ),
  skipForward: (
    <>
      <path d="M5.5 6.3v11.4a.5.5 0 0 0 .77.42l8.6-5.7a.5.5 0 0 0 0-.84l-8.6-5.7a.5.5 0 0 0-.77.42Z" />
      <path d="M18.25 5.75v12.5" />
    </>
  ),
  headphones: (
    <>
      <path d="M3.75 14.5V12a8.25 8.25 0 0 1 16.5 0v2.5" />
      <path d="M3.75 14.5h1.9a1 1 0 0 1 1 1v2.75a1 1 0 0 1-1 1h-.9a1 1 0 0 1-1-1Z" />
      <path d="M20.25 14.5h-1.9a1 1 0 0 0-1 1v2.75a1 1 0 0 0 1 1h.9a1 1 0 0 0 1-1Z" />
    </>
  ),
  bookmark: (
    <path d="M6.75 5.25a.75.75 0 0 1 .75-.75h9a.75.75 0 0 1 .75.75v13.9a.4.4 0 0 1-.62.33L12 16.1l-4.63 3.38a.4.4 0 0 1-.62-.33Z" />
  ),
  bookmarkGo: (
    <>
      <path d="M19.25 5.5v5.25a3.5 3.5 0 0 1-3.5 3.5H5.5" />
      <path d="m9 10.75-3.5 3.5 3.5 3.5" />
    </>
  ),
  x: (
    <>
      <path d="m6.75 6.75 10.5 10.5" />
      <path d="m17.25 6.75-10.5 10.5" />
    </>
  ),
  volume: (
    <>
      <path d="M11.5 5.4 7.1 9.1H4a.5.5 0 0 0-.5.5v4.8a.5.5 0 0 0 .5.5h3.1l4.4 3.7a.4.4 0 0 0 .65-.31V5.71a.4.4 0 0 0-.65-.31Z" />
      <path d="M15.5 9.5a3.5 3.5 0 0 1 0 5" />
      <path d="M18.25 7a7 7 0 0 1 0 10" />
    </>
  ),
  book: (
    <>
      <path d="M12 7c-1.05-.95-2.8-1.75-4.9-1.75H4.25a.75.75 0 0 0-.75.75v10.5c0 .41.34.75.75.75H7.6c2 0 3.5.7 4.4 1.5.9-.8 2.4-1.5 4.4-1.5h3.35a.75.75 0 0 0 .75-.75V6a.75.75 0 0 0-.75-.75H16.9c-2.1 0-3.85.8-4.9 1.75Z" />
      <path d="M12 7v11.75" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.25" />
      <path d="M12 7.25V12l3 1.9" />
    </>
  ),
  chevronUp: <path d="m6.5 14.5 5.5-5.5 5.5 5.5" />,
  chevronDown: <path d="m6.5 9.5 5.5 5.5 5.5-5.5" />,
  sparkle: (
    <path d="M12 4.25c.55 3.6 2.15 5.2 5.75 5.75-3.6.55-5.2 2.15-5.75 5.75-.55-3.6-2.15-5.2-5.75-5.75 3.6-.55 5.2-2.15 5.75-5.75Z" />
  ),
}

/** Icons that read better solid than outlined. */
const FILLED = new Set<IconName>([
  'play',
  'stop',
  'skipBack',
  'skipForward',
  'bookmark',
  'volume',
  'sparkle',
])

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      className={`icon${className ? ` ${className}` : ''}`}
      viewBox="0 0 24 24"
      fill={FILLED.has(name) ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  )
}
