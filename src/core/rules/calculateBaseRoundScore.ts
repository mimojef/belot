export type ScoringSeat = 'bottom' | 'right' | 'top' | 'left'
export type ScoringTeam = 'A' | 'B'
export type ScoringSuit = 'clubs' | 'diamonds' | 'hearts' | 'spades'
export type ScoringContract = 'color' | 'all-trumps' | 'no-trumps'

export type ScoringCard = {
  suit: ScoringSuit
  rank: string
}

export type CompletedTrick = {
  winner: ScoringSeat
  cards: ScoringCard[]
}

export type CalculateBaseRoundScoreInput = {
  tricks: CompletedTrick[]
  contract: ScoringContract
  trumpSuit: ScoringSuit | null
}

export type TeamBaseScore = {
  team: ScoringTeam
  rawPoints: number
  tricksWon: number
}

export type CalculateBaseRoundScoreResult = {
  teamA: TeamBaseScore
  teamB: TeamBaseScore
  lastTrickWinner: ScoringSeat | null
  expectedTotalPoints: number
  actualTotalPoints: number
  isComplete: boolean
  isPointTotalValid: boolean
}

const CAPOT_BONUS_POINTS = 90

function getTeamBySeat(seat: ScoringSeat): ScoringTeam {
  return seat === 'bottom' || seat === 'top' ? 'A' : 'B'
}

function normalizeRank(rank: string): string {
  return String(rank).trim().toUpperCase()
}

function getNonTrumpCardPoints(rank: string): number {
  const normalizedRank = normalizeRank(rank)

  if (normalizedRank === 'A' || normalizedRank === 'ACE') return 11
  if (normalizedRank === '10') return 10
  if (normalizedRank === 'K' || normalizedRank === 'KING') return 4
  if (normalizedRank === 'Q' || normalizedRank === 'QUEEN') return 3
  if (normalizedRank === 'J' || normalizedRank === 'JACK') return 2

  return 0
}

function getTrumpCardPoints(rank: string): number {
  const normalizedRank = normalizeRank(rank)

  if (normalizedRank === 'J' || normalizedRank === 'JACK') return 20
  if (normalizedRank === '9') return 14
  if (normalizedRank === 'A' || normalizedRank === 'ACE') return 11
  if (normalizedRank === '10') return 10
  if (normalizedRank === 'K' || normalizedRank === 'KING') return 4
  if (normalizedRank === 'Q' || normalizedRank === 'QUEEN') return 3

  return 0
}

function getCardPoints(
  card: ScoringCard,
  contract: ScoringContract,
  trumpSuit: ScoringSuit | null
): number {
  if (contract === 'all-trumps') {
    return getTrumpCardPoints(card.rank)
  }

  if (contract === 'no-trumps') {
    return getNonTrumpCardPoints(card.rank)
  }

  if (contract === 'color' && trumpSuit && card.suit === trumpSuit) {
    return getTrumpCardPoints(card.rank)
  }

  return getNonTrumpCardPoints(card.rank)
}

function getBaseExpectedTotalPoints(contract: ScoringContract): number {
  if (contract === 'all-trumps') return 258
  if (contract === 'no-trumps') return 260
  return 162
}

function getCapotWinnerTeam(
  isComplete: boolean,
  teamATricksWon: number,
  teamBTricksWon: number
): ScoringTeam | null {
  if (!isComplete) {
    return null
  }

  if (teamATricksWon === 8) {
    return 'A'
  }

  if (teamBTricksWon === 8) {
    return 'B'
  }

  return null
}

export function calculateBaseRoundScore(
  input: CalculateBaseRoundScoreInput
): CalculateBaseRoundScoreResult {
  const teamA: TeamBaseScore = {
    team: 'A',
    rawPoints: 0,
    tricksWon: 0,
  }

  const teamB: TeamBaseScore = {
    team: 'B',
    rawPoints: 0,
    tricksWon: 0,
  }

  const completedTricks = input.tricks ?? []
  const lastTrick = completedTricks[completedTricks.length - 1] ?? null

  for (const trick of completedTricks) {
    const winnerTeam = getTeamBySeat(trick.winner)
    const trickPoints = (trick.cards ?? []).reduce((sum, card) => {
      return sum + getCardPoints(card, input.contract, input.trumpSuit)
    }, 0)

    if (winnerTeam === 'A') {
      teamA.rawPoints += trickPoints
      teamA.tricksWon += 1
    } else {
      teamB.rawPoints += trickPoints
      teamB.tricksWon += 1
    }
  }

  if (lastTrick) {
    const lastTrickWinnerTeam = getTeamBySeat(lastTrick.winner)

    if (lastTrickWinnerTeam === 'A') {
      teamA.rawPoints += 10
    } else {
      teamB.rawPoints += 10
    }
  }

  if (input.contract === 'no-trumps') {
    teamA.rawPoints *= 2
    teamB.rawPoints *= 2
  }

  const isComplete = completedTricks.length === 8
  const capotWinnerTeam = getCapotWinnerTeam(isComplete, teamA.tricksWon, teamB.tricksWon)

  if (capotWinnerTeam === 'A') {
    teamA.rawPoints += CAPOT_BONUS_POINTS
  } else if (capotWinnerTeam === 'B') {
    teamB.rawPoints += CAPOT_BONUS_POINTS
  }

  const actualTotalPoints = teamA.rawPoints + teamB.rawPoints
  const expectedTotalPoints =
    getBaseExpectedTotalPoints(input.contract) +
    (capotWinnerTeam ? CAPOT_BONUS_POINTS : 0)

  return {
    teamA,
    teamB,
    lastTrickWinner: lastTrick?.winner ?? null,
    expectedTotalPoints,
    actualTotalPoints,
    isComplete,
    isPointTotalValid: actualTotalPoints === expectedTotalPoints,
  }
}