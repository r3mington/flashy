# Flashy

Learn a language by reading stories written from your own words.

Flashy is a flashcard app with an AI story writer built in. You collect words
in a deck, and Flashy writes short stories (or explains real topics) using the
words you are learning, at the level you choose. Tap any word while reading to
see its meaning, add it to your deck, or mark it as known. It was built for
Indonesian but works with any language Gemini can write.

It installs on a phone as an app (a PWA) and keeps all your data **on your
device** — there is no account and no database on a server.

## What it does

- **Decks and flashcards** with spaced repetition (it schedules each word for
  review just before you would forget it), plus an AI that suggests new words,
  examples and emoji.
- **Stories** written from your word bank: pick a topic, length, difficulty,
  and *Standard* or *Casual* speech. Continue a story part by part, steering
  what happens next. A *Learn* mode explains a real topic in a short series.
- **A reader built for learning**: new words and words in study are coloured,
  meanings can sit above words, a pop-up dictionary shows root words, word
  families and how often you've met a word, and the story can be read aloud.
  On phones there is a one-handed mode for the pop-up.
- **Listen** and **Translate** practice: hear your words, and translate short
  English dialogues into your language with hints and grading.
- **A dashboard**: words known, reading progress and speed, time spent,
  streaks, what's due, and the words you keep forgetting.
- **Backups**: download everything as one file and restore it on another
  device, export words as CSV, or keep a copy in a Google Sheet.

## Set up your own copy

You need three free accounts: **GitHub**, **Vercel** (hosting) and
**Google AI Studio** (for the Gemini API key). No coding is needed.

1. **Get a Gemini API key.** Go to
   [aistudio.google.com](https://aistudio.google.com), sign in, and choose
   *Get API key → Create API key*. Copy it. Gemini has a free tier; heavy use
   of stories may cost a little, billed by Google to your key.
2. **Copy the code.** On this project's GitHub page, press **Fork**. You now
   have your own copy.
3. **Put it online.** In [vercel.com](https://vercel.com), choose
   *Add New → Project*, pick your fork, and before pressing *Deploy* open
   **Environment Variables** and add these three:

   | Name | What to put |
   |---|---|
   | `GEMINI_API_KEY` | The key from step 1. |
   | `APP_PASSWORD` | Any password. Flashy asks for it once per device, so strangers who find your site can't use your key. |
   | `SESSION_SECRET` | A long random string, e.g. from `openssl rand -hex 32`, or just mash the keyboard for 40+ characters. It signs the login. |

   Press **Deploy**. After a minute Vercel gives you an address such as
   `your-flashy.vercel.app`.
4. **Open it on your phone**, enter your password, and add it to your home
   screen (Safari: *Share → Add to Home Screen*; Chrome: *⋮ → Install app*).

Vercel redeploys by itself whenever your fork on GitHub changes.

### Things to know

- **Your data lives in the browser** on each device. Two phones mean two
  separate word banks. Use **Options → Backup** to move everything to another
  device, and download a backup now and then — clearing the browser's data
  would erase it.
- **Everyone with your password shares your Gemini key** (and its costs), but
  each person's words stay on their own device.
- **Google Sheets export (optional).** Options → Google Sheets has the steps:
  you paste a small script into your own sheet and give Flashy its link.
- **Content filters.** Flashy switches off Gemini's adjustable safety filters
  so stories can include romance, violence and darker plots. Some content is
  still refused by Google whatever the settings; Flashy then says why.

## For developers

```bash
npm install
npm run dev      # the app at http://localhost:5173 (no password locally)
npm test         # unit tests
npm run build    # type-check and build
npm run lint
```

- **Stack:** React + TypeScript + Vite, IndexedDB via Dexie, deployed on
  Vercel. The only server code is in `api/`: a password login and
  `api/generate.ts`, which forwards prompts to Gemini so the key never
  reaches the browser.
- **AI features don't run locally.** `npm run dev` serves no API, so story
  and card generation fail there. `vercel dev` is meant to run the API, but it
  loads environment variables from the Vercel project rather than a local
  `.env`, so it only works if the *Development* environment on Vercel has the
  three variables set.
- **Trying prompt changes:** `scripts/story-lab.mts` runs the real story
  pipeline from the terminal against Gemini and prints the result. It reads
  the key from `.env.production.local`
  (`npx vercel env pull --environment=production .env.production.local`):

  ```bash
  npx tsx scripts/story-lab.mts full "a ride to the beach"
  REGISTER=casual LENGTH=300 npx tsx scripts/story-lab.mts full "buying coffee"
  ```
- **Models** are pinned in `api/generate.ts` and can be changed without code
  through the `STORY_MODEL`, `FAST_MODEL` and `FALLBACK_MODEL` environment
  variables (see `.env.example`).

## Licence

[MIT](LICENSE) — use it, change it, share it.
