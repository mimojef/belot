import type {
  CalculateBaseRoundScoreResult,
  ScoringSeat,
  ScoringTeam,
} from './calculateBaseRoundScore'

export type RoundOutcomeResult = {
  bidderTeam: ScoringTeam | null
  defenderTeam: ScoringTeam | null
  bidderPoints: number
  defenderPoints: number
  isTie: boolean
  isInside: boolean
  isMade: boolean
  winningTeam: ScoringTeam | null
  outcome: 'made' | 'inside' | 'tie' | 'unknown'
}

type CalculateRoundOutcomeInput = {
  baseRoundScore: CalculateBaseRoundScoreResult
  bidderSeat: ScoringSeat | null
  declarationsTeamA?: number
  declarationsTeamB?: number
  beloteTeamA?: number
  beloteTeamB?: number
}

function getTeamBySeat(seat: ScoringSeat): ScoringTeam {
  return seat === 'bottom' || seat === 'top' ? 'A' : 'B'
}

function getOpponentTeam(team: ScoringTeam): ScoringTeam {
  return team === 'A' ? 'B' : 'A'
}

function getTeamTotalPoints(params: {
  basePoints: number
  declarationsPoints?: number
  belotePoints?: number
}): number {
  return (
    params.basePoints +
    (params.declarationsPoints ?? 0) +
    (params.belotePoints ?? 0)
  )
}

export function calculateRoundOutcome(
  input: CalculateRoundOutcomeInput
): RoundOutcomeResult {
  if (!input.bidderSeat) {
    return {
      bidderTeam: null,
      defenderTeam: null,
      bidderPoints: 0,
      defenderPoints: 0,
      isTie: false,
      isInside: false,
      isMade: false,
      winningTeam: null,
      outcome: 'unknown',
    }
  }

  const bidderTeam = getTeamBySeat(input.bidderSeat)
  const defenderTeam = getOpponentTeam(bidderTeam)

  const teamATotalPoints = getTeamTotalPoints({
    basePoints: input.baseRoundScore.teamA.rawPoints,
    declarationsPoints: input.declarationsTeamA,
    belotePoints: input.beloteTeamA,
  })

  const teamBTotalPoints = getTeamTotalPoints({
    basePoints: input.baseRoundScore.teamB.rawPoints,
    declarationsPoints: input.declarationsTeamB,
    belotePoints: input.beloteTeamB,
  })

  const bidderPoints = bidderTeam === 'A' ? teamATotalPoints : teamBTotalPoints
  const defenderPoints = defenderTeam === 'A' ? teamATotalPoints : teamBTotalPoints

  const isTie = bidderPoints === defenderPoints
  const isInside = bidderPoints < defenderPoints
  const isMade = bidderPoints > defenderPoints

  if (isTie) {
    return {
      bidderTeam,
      defenderTeam,
      bidderPoints,
      defenderPoints,
      isTie: true,
      isInside: false,
      isMade: false,
      winningTeam: defenderTeam,
      outcome: 'tie',
    }
  }

  if (isInside) {
    return {
      bidderTeam,
      defenderTeam,
      bidderPoints,
      defenderPoints,
      isTie: false,
      isInside: true,
      isMade: false,
      winningTeam: defenderTeam,
      outcome: 'inside',
    }
  }

  return {
    bidderTeam,
    defenderTeam,
    bidderPoints,
    defenderPoints,
    isTie: false,
    isInside: false,
    isMade,
    winningTeam: bidderTeam,
    outcome: 'made',
  }
}