import type { Card, Deck, ListeningLog, ReadingLog, Review, SavedStory, Snapshot } from '../../db'
import { DAY, startOfDay } from '../../time'
import {
  buildBankSeries,
  countByDay,
  currentStreak,
  deckStats,
  dueForecast,
  inferSessions,
  leeches,
  longestStreak,
  maturity,
  nextMilestone,
  retention,
  secondsPerAnswer,
  studySecondsByDay,
} from '../../stats'

// ---------------------------------------------------------------- computation

export type RawData = {
  cards: Card[]
  reviews: Review[]
  decks: Deck[]
  snapshots: Snapshot[]
  stories: SavedStory[]
  reading: ReadingLog[]
  listening: ListeningLog[]
}

export function compute(rawInput: RawData, rangeDays: number, deckFilter: number | 'all') {
  // Ignored words (brand names, place names…) live in the deck only to keep
  // stories from flagging them as new. They are not vocabulary, so they are
  // dropped before anything here counts them — as known or as anything else.
  const raw: RawData = { ...rawInput, cards: rawInput.cards.filter((c) => !c.ignored) }
  const now = Date.now()
  const today = startOfDay(now)
  const windowStart = today - (rangeDays - 1) * DAY

  const cards = deckFilter === 'all' ? raw.cards : raw.cards.filter((c) => c.deckId === deckFilter)
  const allReviews =
    deckFilter === 'all' ? raw.reviews : raw.reviews.filter((r) => r.deckId === deckFilter)
  const stories =
    deckFilter === 'all' ? raw.stories : raw.stories.filter((s) => s.deckId === deckFilter)
  const rangeReviews = allReviews.filter((r) => r.ts >= windowStart)

  const days = Array.from({ length: rangeDays }, (_, i) => windowStart + i * DAY)
  const reviewsPerDay = countByDay(allReviews, (r) => r.ts)
  const activeDaySet = new Set(reviewsPerDay.keys())

  // --- grades per day, stacked
  const gradeSeries = days.map((day) => ({
    day,
    again: 0,
    hard: 0,
    good: 0,
    easy: 0,
  }))
  const gradeIndex = new Map(gradeSeries.map((p, i) => [p.day, i]))
  const gradeTotals = { again: 0, hard: 0, good: 0, easy: 0 }
  for (const r of rangeReviews) {
    const i = gradeIndex.get(startOfDay(r.ts))
    if (i !== undefined) gradeSeries[i][r.grade]++
    gradeTotals[r.grade]++
  }

  // --- time: study inferred from review gaps, reading/listening logged directly
  const sessions = inferSessions(allReviews)
  const studyByDay = studySecondsByDay(allReviews)
  const readByDay = new Map(raw.reading.map((r) => [r.day, r.seconds]))
  const listenByDay = new Map(raw.listening.map((r) => [r.day, r.seconds]))
  const timeSeries = days.map((day) => ({
    day,
    study: studyByDay.get(day) ?? 0,
    read: readByDay.get(day) ?? 0,
    listen: listenByDay.get(day) ?? 0,
  }))
  // Story words scrolled through — logged app-wide, so not split per deck.
  const readWordsByDay = new Map(raw.reading.map((r) => [r.day, r.words ?? 0]))
  const readWordsSeries = days.map((day) => readWordsByDay.get(day) ?? 0)
  const readWordsInRange = readWordsSeries.reduce((a, b) => a + b, 0)
  const readingDaysInRange = readWordsSeries.filter((w) => w > 0).length
  const timeTotals = timeSeries.reduce(
    (a, p) => ({ study: a.study + p.study, read: a.read + p.read, listen: a.listen + p.listen }),
    { study: 0, read: 0, listen: 0 },
  )
  const totalTimeSecs =
    [...studyByDay.values()].reduce((a, b) => a + b, 0) +
    raw.reading.reduce((a, r) => a + r.seconds, 0) +
    raw.listening.reduce((a, r) => a + r.seconds, 0)

  // --- 12-week heatmap, aligned so each column is a calendar week
  const heatDays: { day: number; reviews: number; seconds: number }[] = []
  const heatStart = today - (83 + new Date(today - 83 * DAY).getDay()) * DAY
  for (let d = heatStart; d <= today; d += DAY) {
    heatDays.push({
      day: d,
      reviews: reviewsPerDay.get(d) ?? 0,
      seconds: (studyByDay.get(d) ?? 0) + (readByDay.get(d) ?? 0) + (listenByDay.get(d) ?? 0),
    })
  }

  // --- hour of day
  const byHour = Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0, pass: 0 }))
  for (const r of allReviews) {
    const h = byHour[new Date(r.ts).getHours()]
    h.count++
    if (r.grade !== 'again') h.pass++
  }
  const hourCandidates = byHour.filter((h) => h.count >= 20)
  const bestHour =
    hourCandidates.length > 0
      ? hourCandidates
          .map((h) => ({ hour: h.hour, accuracy: Math.round((h.pass / h.count) * 100) }))
          .sort((a, b) => b.accuracy - a.accuracy)[0]
      : null

  // --- growth
  const addedByDay = countByDay(cards, (c) => c.createdAt)
  const addedSeries = days.map((d) => addedByDay.get(d) ?? 0)
  const addedInRange = addedSeries.reduce((a, b) => a + b, 0)
  const addedPerWeek = Math.round((addedInRange / rangeDays) * 7)

  const known = cards.filter((c) => c.known).length
  const milestone = nextMilestone(known)
  // Only project when there's real momentum behind the number.
  const knownPerDay = countKnownVelocity(cards, today)
  const projection =
    knownPerDay > 0.2
      ? {
          target: milestone.toLocaleString(),
          when: new Date(now + ((milestone - known) / knownPerDay) * DAY).toLocaleDateString(
            undefined,
            { month: 'long', year: 'numeric' },
          ),
        }
      : null

  // --- attention
  const overdue = cards
    .filter(
      (c) =>
        !c.known &&
        c.state === 'review' &&
        c.interval >= 1 &&
        now - c.due > c.interval * DAY,
    )
    .sort((a, b) => (now - b.due) / b.interval - (now - a.due) / a.interval)

  const forecast = dueForecast(cards, today, 30, now)
  const inRotation = cards.filter((c) => !c.known && c.state !== 'new').length
  const buckets = maturity(cards)

  // --- stories
  const glossaryWords = new Set<string>()
  let storyWords = 0
  for (const s of stories) {
    storyWords += s.story.trim().split(/\s+/).length
    for (const g of s.glossary) glossaryWords.add(g.word)
  }
  const cardWords = new Set(cards.map((c) => c.word))
  const glossaryToCards = [...glossaryWords].filter((w) => cardWords.has(w)).length
  const topicCounts = new Map<string, number>()
  for (const s of stories) if (s.topic) topicCounts.set(s.topic, (topicCounts.get(s.topic) ?? 0) + 1)
  const inProgress = stories
    .filter((s) => s.bookmark !== undefined)
    .sort((a, b) => (b.lastOpenedAt ?? b.createdAt) - (a.lastOpenedAt ?? a.createdAt))
    .slice(0, 5)

  // --- gaps
  const anyRoman = cards.some((c) => c.roman)
  const gaps = [
    { label: 'no example', count: cards.filter((c) => !c.example?.trim()).length },
    {
      label: 'no example translation',
      count: cards.filter((c) => c.example?.trim() && !c.exampleTranslation?.trim()).length,
    },
    { label: 'no emoji', count: cards.filter((c) => !c.emoji).length },
    ...(anyRoman ? [{ label: 'no romanization', count: cards.filter((c) => !c.roman).length }] : []),
  ].filter((g) => g.count > 0)

  const bestDayEntry = [...reviewsPerDay.entries()].sort((a, b) => b[1] - a[1])[0]
  const deckRows = deckStats(raw.decks, raw.cards, raw.reviews, raw.stories, now)

  const languages = [...new Set(raw.decks.map((d) => d.language))].map((language) => {
    const ids = new Set(raw.decks.filter((d) => d.language === language).map((d) => d.id))
    const lc = raw.cards.filter((c) => ids.has(c.deckId))
    return { language, cards: lc.length, known: lc.filter((c) => c.known).length }
  })

  const topDue = [...deckRows].sort((a, b) => b.dueNow - a.dueNow)[0]

  return {
    today,
    days,
    cards,
    allReviews,
    stories,
    states: {
      new: cards.filter((c) => c.state === 'new' && !c.known).length,
      learning: cards.filter((c) => c.state === 'learning' && !c.known).length,
      review: cards.filter((c) => c.state === 'review' && !c.known).length,
      known,
    },
    reviewsToday: reviewsPerDay.get(today) ?? 0,
    reviewsInRange: rangeReviews.length,
    activeDays: days.filter((d) => activeDaySet.has(d)).length,
    streak: currentStreak(activeDaySet, today),
    bestStreak: longestStreak(activeDaySet),
    bestDay: bestDayEntry ? { day: bestDayEntry[0], count: bestDayEntry[1] } : null,
    ret: retention(rangeReviews),
    studyTodaySecs: studyByDay.get(today) ?? 0,
    totalTimeSecs,
    secsPerAnswer: secondsPerAnswer(sessions),
    heatmap: heatDays,
    byHour,
    bestHour,
    bankSeries: buildBankSeries(raw.snapshots, raw.cards, today, Math.max(rangeDays, 14)),
    historyDays: new Set(raw.snapshots.map((s) => s.day)).size,
    addedSeries,
    addedInRange,
    addedPerWeek,
    projection,
    gradeSeries,
    gradeTotals,
    timeSeries,
    timeTotals,
    readWordsSeries,
    readWordsInRange,
    readWordsTotal: raw.reading.reduce((a, r) => a + (r.words ?? 0), 0),
    readWordsPerReadingDay:
      readingDaysInRange > 0 ? Math.round(readWordsInRange / readingDaysInRange) : 0,
    readingDaysInRange,
    forecast,
    forecastTotal: forecast.reduce((a, d) => a + d.count, 0),
    dueNow: forecast[0]?.count ?? 0,
    leeches: leeches(cards, allReviews),
    overdue,
    maturity: buckets,
    matureCount: buckets.filter((b) => b.mature).reduce((a, b) => a + b.count, 0),
    inRotation,
    deckRows,
    languages,
    milestone,
    storyWords,
    distinctGlossary: glossaryWords.size,
    glossaryToCards,
    threadCount: new Set(stories.filter((s) => s.parentId).map((s) => s.parentId)).size,
    topTopics: [...topicCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([t]) => t),
    inProgress,
    gaps,
    topDueDeckId: topDue && topDue.dueNow > 0 ? topDue.deck.id : undefined,
  }
}

export type Stats = ReturnType<typeof compute>

/** Words marked known per day, averaged over however much history exists —
 *  used to project when the next milestone lands. */
function countKnownVelocity(cards: Card[], today: number): number {
  const knownCards = cards.filter((c) => c.known)
  if (knownCards.length < 5) return 0
  const oldest = Math.min(...knownCards.map((c) => c.createdAt))
  const days = Math.max(7, (today - startOfDay(oldest)) / DAY)
  return knownCards.length / days
}

