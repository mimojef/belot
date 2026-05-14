export type RankProgressSnapshot = {
  rankLevel: number
  completedGamesCount: number
  currentRankGames: number
  nextRankGames: number
  gamesUntilNextRank: number
  progressRatio: number
}

// [rankLevel, totalGamesRequired] — интерполира се линейно между котвите
const RANK_ANCHORS: [number, number][] = [
  [1,   0],
  [5,   15],
  [10,  40],
  [20,  150],
  [30,  400],
  [40,  900],
  [50,  1800],
]

export function getCompletedGamesRequiredForRank(rankLevel: number): number {
  const safeRank = Math.max(1, Math.trunc(rankLevel))

  for (let i = 0; i < RANK_ANCHORS.length - 1; i++) {
    const [r1, g1] = RANK_ANCHORS[i]!
    const [r2, g2] = RANK_ANCHORS[i + 1]!

    if (safeRank >= r1 && safeRank <= r2) {
      const t = (safeRank - r1) / (r2 - r1)
      return Math.round(g1 + t * (g2 - g1))
    }
  }

  // След последната котва — линейна екстраполация
  const [r1, g1] = RANK_ANCHORS[RANK_ANCHORS.length - 2]!
  const [r2, g2] = RANK_ANCHORS[RANK_ANCHORS.length - 1]!
  const step = (g2 - g1) / (r2 - r1)
  return Math.round(g2 + (safeRank - r2) * step)
}

export function getRankLevelForCompletedGames(completedGamesCount: number): number {
  const safeCount = Math.max(0, Math.trunc(completedGamesCount))
  let rankLevel = 1

  while (safeCount >= getCompletedGamesRequiredForRank(rankLevel + 1)) {
    rankLevel += 1
  }

  return rankLevel
}

const ELO_K = 32

export function computeEloChange(
  myRating: number,
  opponentRating: number,
  didWin: boolean,
): number {
  const expected = 1 / (1 + Math.pow(10, (opponentRating - myRating) / 400))
  const score = didWin ? 1 : 0
  return Math.round(ELO_K * (score - expected))
}

const RANK_TIERS: [number, string][] = [
  [50, 'Легенда'],
  [40, 'Гросмайстор'],
  [30, 'Майстор'],
  [20, 'Напреднал'],
  [10, 'Любител'],
  [5,  'Новак'],
  [1,  'Начинаещ'],
]

export function getRankTitleForLevel(rankLevel: number): string {
  for (const [minLevel, title] of RANK_TIERS) {
    if (rankLevel >= minLevel) return title
  }
  return 'Начинаещ'
}

export function createRankProgressSnapshot(
  completedGamesCount: number,
): RankProgressSnapshot {
  const safeCount = Math.max(0, Math.trunc(completedGamesCount))
  const rankLevel = getRankLevelForCompletedGames(safeCount)
  const currentRankGames = getCompletedGamesRequiredForRank(rankLevel)
  const nextRankGames = getCompletedGamesRequiredForRank(rankLevel + 1)
  const rankSpan = Math.max(1, nextRankGames - currentRankGames)
  const gamesIntoRank = Math.max(0, safeCount - currentRankGames)

  return {
    rankLevel,
    completedGamesCount: safeCount,
    currentRankGames,
    nextRankGames,
    gamesUntilNextRank: Math.max(0, nextRankGames - safeCount),
    progressRatio: Math.min(1, gamesIntoRank / rankSpan),
  }
}
