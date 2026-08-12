/** Stamped in by Vite at build time — see `BUILD_INFO` in vite.config.ts. */
declare const __BUILD__: {
  /** Short git SHA of the commit this build came from. Empty outside Vercel. */
  commit: string
  /** Vercel deployment id, without its `dpl_` prefix. Empty outside Vercel. */
  deployment: string
  /** 'production', 'preview', or 'local' for a build made off Vercel. */
  env: string
  builtAt: string
}

export const BUILD = __BUILD__

/** The build in one short line, for showing to a human: the commit that is
 *  running, and the deployment serving it. Reads "dev build" off Vercel. */
export function buildLabel(): string {
  if (!BUILD.commit && !BUILD.deployment) return 'dev build'
  return [BUILD.commit, BUILD.deployment].filter(Boolean).join(' · ')
}
