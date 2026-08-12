import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

/** Which build this is, stamped in at build time so the running app can say so.
 *  Vercel sets these during the build; locally they are absent and it reads as
 *  a dev build. Injected explicitly rather than through Vite's envPrefix, which
 *  would expose every VERCEL_* variable to the browser — some of them secret. */
const BUILD_INFO = {
  commit: (process.env.VERCEL_GIT_COMMIT_SHA ?? '').slice(0, 7),
  deployment: (process.env.VERCEL_DEPLOYMENT_ID ?? '').replace(/^dpl_/, '').slice(0, 8),
  env: process.env.VERCEL_ENV ?? 'local',
  builtAt: new Date().toISOString(),
}

export default defineConfig({
  define: { __BUILD__: JSON.stringify(BUILD_INFO) },
  // Respect PORT when the harness assigns one; fall back to Vite's default.
  server: process.env.PORT ? { port: Number(process.env.PORT), strictPort: true } : undefined,
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'Flashy',
        short_name: 'Flashy',
        description: 'Minimal flashcards with spaced repetition',
        theme_color: '#fafaf8',
        background_color: '#fafaf8',
        display: 'standalone',
        icons: [
          {
            src: 'icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any maskable',
          },
        ],
      },
    }),
  ],
})
