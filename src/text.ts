/** Text utilities shared by the story reader and the deck list: word/sentence
 *  tokenization that also works for scripts written without spaces. */

/** Languages whose scripts don't separate words with spaces — these need
 *  Intl.Segmenter to find word boundaries (Thai, Chinese, Japanese, Khmer,
 *  Lao, Burmese). Korean uses spaces and is excluded. */
const SPACELESS_LANGS = new Set(['th', 'zh', 'ja', 'km', 'lo', 'my'])

function needsSegmentation(langCode: string | null): boolean {
  return !!langCode && SPACELESS_LANGS.has(langCode) && typeof Intl.Segmenter === 'function'
}

/** Lowercase and strip surrounding punctuation so tokens match glossary entries. */
export function defKey(token: string): string {
  return token
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
}

/** Split a chunk of text into word/whitespace/punctuation tokens that re-join
 *  into the original. Spaced scripts split on whitespace; spaceless scripts
 *  (Thai etc.) go through Intl.Segmenter's word boundaries. */
export function tokenizeWords(text: string, langCode: string | null): string[] {
  if (!needsSegmentation(langCode)) return text.split(/(\s+)/)
  const seg = new Intl.Segmenter(langCode ?? undefined, { granularity: 'word' })
  return [...seg.segment(text)].map((s) => s.segment)
}

/** Split text into sentences whose pieces re-join into the original. Spaced
 *  scripts split on terminators (. ! ? …); spaceless scripts use
 *  Intl.Segmenter's sentence boundaries (Thai marks sentences with spaces,
 *  not full stops). */
export function splitSentences(text: string, langCode: string | null): string[] {
  if (needsSegmentation(langCode)) {
    const seg = new Intl.Segmenter(langCode ?? undefined, { granularity: 'sentence' })
    const parts = [...seg.segment(text)].map((s) => s.segment)
    if (parts.length > 0) return parts
  }
  return text.match(/[^.!?…]+[.!?…]*\s*/gu) ?? (text.trim() ? [text] : [])
}

/** Number of words in a text — segmentation-aware, so Thai counts words, not
 *  space-separated phrases. */
export function countWords(text: string, langCode: string | null): number {
  let n = 0
  for (const tok of tokenizeWords(text, langCode)) if (defKey(tok)) n++
  return n
}
