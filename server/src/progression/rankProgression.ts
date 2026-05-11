export type RankProgressSnapshot = {
  rankLevel: number
  completedGamesCount: number
  currentRankGames: number
  nextRankGames: number
  gamesUntilNextRank: number
  progressRatio: number
}

const BASE_GAMES_PER_RANK = 5
const RANK_GROWTH_POWER = 1.35

function getGamesNeededFromRankToNext(rankLevel: number): number {
  const safeRankLevel = Math.max(1, Math.trunc(rankLevel))

  return Math.max(
    BASE_GAMES_PER_RANK,
    Math.ceil(BASE_GAMES_PER_RANK * safeRankLevel ** RANK_GROWTH_POWER),
  )
}

export function getCompletedGamesRequiredForRank(rankLevel: number): number {
  const safeRankLevel = Math.max(1, Math.trunc(rankLevel))
  let total = 0

  for (let rank = 1; rank < safeRankLevel; rank += 1) {
    total += getGamesNeededFromRankToNext(rank)
  }

  return total
}

export function getRankLevelForCompletedGames(completedGamesCount: number): number {
  const safeCompletedGamesCount = Math.max(0, Math.trunc(completedGamesCount))
  let rankLevel = 1

  while (
    safeCompletedGamesCount >= getCompletedGamesRequiredForRank(rankLevel + 1)
  ) {
    rankLevel += 1
  }

  return rankLevel
}

export function createRankProgressSnapshot(
  completedGamesCount: number,
): RankProgressSnapshot {
  const safeCompletedGamesCount = Math.max(0, Math.trunc(completedGamesCount))
  const rankLevel = getRankLevelForCompletedGames(safeCompletedGamesCount)
  const currentRankGames = getCompletedGamesRequiredForRank(rankLevel)
  const nextRankGames = getCompletedGamesRequiredForRank(rankLevel + 1)
  const rankSpan = Math.max(1, nextRankGames - currentRankGames)
  const gamesIntoRank = Math.max(0, safeCompletedGamesCount - currentRankGames)

  return {
    rankLevel,
    completedGamesCount: safeCompletedGamesCount,
    currentRankGames,
    nextRankGames,
    gamesUntilNextRank: Math.max(0, nextRankGames - safeCompletedGamesCount),
    progressRatio: Math.min(1, gamesIntoRank / rankSpan),
  }
}

