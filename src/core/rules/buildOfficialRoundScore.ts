import type {
  BaseRoundScoreResult,
  CarryOverPoints,
  RoundOutcomeResult,
  RoundScore,
  ScoreBreakdown,
  Team,
} from '../state/gameTypes'

export type OfficialRoundScoreResult = {
  roundBreakdown: ScoreBreakdown
  nextCarryOver: CarryOverPoints
}

function createZeroRoundScore(): RoundScore {
  return {
    teamA: 0,
    teamB: 0,
  }
}

function createZeroBreakdown(): ScoreBreakdown {
  return {
    tricks: createZeroRoundScore(),
    declarations: createZeroRoundScore(),
    belote: createZeroRoundScore(),
    lastTen: createZeroRoundScore(),
    capot: createZeroRoundScore(),
    total: createZeroRoundScore(),
  }
}

function getTeamKey(team: Team): 'teamA' | 'teamB' {
  return team === 'A' ? 'teamA' : 'teamB'
}

function getOpponentTeam(team: Team): Team {
  return team === 'A' ? 'B' : 'A'
}

function setTeamPoints(score: RoundScore, team: Team, value: number): RoundScore {
  const key = getTeamKey(team)

  return {
    ...score,
    [key]: value,
  }
}

function addTeamPoints(score: RoundScore, team: Team, value: number): RoundScore {
  const key = getTeamKey(team)

  return {
    ...score,
    [key]: score[key] + value,
  }
}

function addRoundScores(first: RoundScore, second: RoundScore): RoundScore {
  return {
    teamA: first.teamA + second.teamA,
    teamB: first.teamB + second.teamB,
  }
}

function subtractRoundScores(first: RoundScore, second: RoundScore): RoundScore {
  return {
    teamA: first.teamA - second.teamA,
    teamB: first.teamB - second.teamB,
  }
}

function multiplyRoundScore(score: RoundScore, multiplier: number): RoundScore {
  if (multiplier <= 1) {
    return score
  }

  return {
    teamA: score.teamA * multiplier,
    teamB: score.teamB * multiplier,
  }
}

function getCarryOverForTeam(carryOver: CarryOverPoints, team: Team): number {
  return team === 'A' ? carryOver.teamA : carryOver.teamB
}

function setCarryOverForTeam(
  carryOver: CarryOverPoints,
  team: Team,
  value: number
): CarryOverPoints {
  const key = team === 'A' ? 'teamA' : 'teamB'

  return {
    ...carryOver,
    [key]: value,
  }
}

function getRecordedRoundTotal(expectedTotalPoints: number): number {
  return Math.round(expectedTotalPoints / 10)
}

function getRecordedPremiumPoints(rawPoints: number): number {
  return Math.round(rawPoints / 10)
}

function convertRawPairToRecordedPair(
  teamARaw: number,
  teamBRaw: number,
  expectedTotalPoints: number
): RoundScore {
  const recordedTotal = getRecordedRoundTotal(expectedTotalPoints)

  if (teamARaw === teamBRaw) {
    const equalRecorded = Math.floor(recordedTotal / 2)

    return {
      teamA: equalRecorded,
      teamB: recordedTotal - equalRecorded,
    }
  }

  if (teamARaw > teamBRaw) {
    const teamARecorded = Math.round(teamARaw / 10)

    return {
      teamA: teamARecorded,
      teamB: recordedTotal - teamARecorded,
    }
  }

  const teamBRecorded = Math.round(teamBRaw / 10)

  return {
    teamA: recordedTotal - teamBRecorded,
    teamB: teamBRecorded,
  }
}

function getRecordedPointsForSingleTeam(
  rawPoints: number,
  expectedTotalPoints: number
): number {
  const recordedPair = convertRawPairToRecordedPair(
    rawPoints,
    expectedTotalPoints - rawPoints,
    expectedTotalPoints
  )

  const rawOpponentPoints = expectedTotalPoints - rawPoints

  return rawPoints >= rawOpponentPoints
    ? Math.max(recordedPair.teamA, recordedPair.teamB)
    : Math.min(recordedPair.teamA, recordedPair.teamB)
}

function applyResolvedCarryOver(
  totalScore: RoundScore,
  carryOverTeam: Team,
  carryOverPoints: number,
  roundWinningTeam: Team | null
): RoundScore {
  if (carryOverPoints <= 0) {
    return totalScore
  }

  if (roundWinningTeam === carryOverTeam) {
    return addTeamPoints(totalScore, carryOverTeam, carryOverPoints)
  }

  return addTeamPoints(totalScore, getOpponentTeam(carryOverTeam), carryOverPoints)
}

function getRecordedScoreForTeam(score: RoundScore, team: Team): number {
  return team === 'A' ? score.teamA : score.teamB
}

function getCombinedRecordedScore(score: RoundScore): number {
  return score.teamA + score.teamB
}

function normalizeCounterMultiplier(value: number | undefined): number {
  if (value === 4) {
    return 4
  }

  if (value === 2) {
    return 2
  }

  return 1
}

export function buildOfficialRoundScore(input: {
  baseRoundScore: BaseRoundScoreResult
  roundOutcome: RoundOutcomeResult
  currentCarryOver: CarryOverPoints
  declarationsScore?: RoundScore
  beloteScore?: RoundScore
  counterMultiplier?: number
}): OfficialRoundScoreResult {
  const { baseRoundScore, roundOutcome, currentCarryOver } = input
  const declarationsScore = input.declarationsScore ?? createZeroRoundScore()
  const beloteScore = input.beloteScore ?? createZeroRoundScore()
  const counterMultiplier = normalizeCounterMultiplier(input.counterMultiplier)
  const roundBreakdown = createZeroBreakdown()

  const expectedTotalWithPremiums =
    baseRoundScore.expectedTotalPoints +
    declarationsScore.teamA +
    declarationsScore.teamB +
    beloteScore.teamA +
    beloteScore.teamB

  const recordedTotalWithPremiums = getRecordedRoundTotal(expectedTotalWithPremiums)

  const declarationsRecordedByOwner: RoundScore = {
    teamA: getRecordedPremiumPoints(declarationsScore.teamA),
    teamB: getRecordedPremiumPoints(declarationsScore.teamB),
  }

  const beloteRecordedByOwner: RoundScore = {
    teamA: getRecordedPremiumPoints(beloteScore.teamA),
    teamB: getRecordedPremiumPoints(beloteScore.teamB),
  }

  let awardedTricks = createZeroRoundScore()
  let awardedDeclarations = createZeroRoundScore()
  let awardedBelote = createZeroRoundScore()

  if (roundOutcome.outcome === 'made') {
    const totalRecorded = convertRawPairToRecordedPair(
      baseRoundScore.teamA.rawPoints +
        declarationsScore.teamA +
        beloteScore.teamA,
      baseRoundScore.teamB.rawPoints +
        declarationsScore.teamB +
        beloteScore.teamB,
      expectedTotalWithPremiums
    )

    awardedDeclarations = {
      ...declarationsRecordedByOwner,
    }

    awardedBelote = {
      ...beloteRecordedByOwner,
    }

    awardedTricks = subtractRoundScores(
      totalRecorded,
      addRoundScores(awardedDeclarations, awardedBelote)
    )
  }

  if (roundOutcome.outcome === 'inside') {
    if (roundOutcome.defenderTeam) {
      const transferredDeclarationsRecorded = getCombinedRecordedScore(
        declarationsRecordedByOwner
      )
      const transferredBeloteRecorded = getCombinedRecordedScore(
        beloteRecordedByOwner
      )

      awardedDeclarations = setTeamPoints(
        awardedDeclarations,
        roundOutcome.defenderTeam,
        transferredDeclarationsRecorded
      )

      awardedBelote = setTeamPoints(
        awardedBelote,
        roundOutcome.defenderTeam,
        transferredBeloteRecorded
      )

      awardedTricks = setTeamPoints(
        awardedTricks,
        roundOutcome.defenderTeam,
        recordedTotalWithPremiums -
          transferredDeclarationsRecorded -
          transferredBeloteRecorded
      )
    }
  }

  let nextCarryOver: CarryOverPoints = {
    teamA: 0,
    teamB: 0,
  }

  if (roundOutcome.outcome === 'tie' && roundOutcome.defenderTeam && roundOutcome.bidderTeam) {
    const defenderRecordedPoints = getRecordedPointsForSingleTeam(
      roundOutcome.defenderPoints,
      expectedTotalWithPremiums
    )

    const bidderRecordedPoints = recordedTotalWithPremiums - defenderRecordedPoints

    const defenderOwnedDeclarationsRecorded = getRecordedScoreForTeam(
      declarationsRecordedByOwner,
      roundOutcome.defenderTeam
    )

    const defenderOwnedBeloteRecorded = getRecordedScoreForTeam(
      beloteRecordedByOwner,
      roundOutcome.defenderTeam
    )

    awardedDeclarations = setTeamPoints(
      awardedDeclarations,
      roundOutcome.defenderTeam,
      defenderOwnedDeclarationsRecorded
    )

    awardedBelote = setTeamPoints(
      awardedBelote,
      roundOutcome.defenderTeam,
      defenderOwnedBeloteRecorded
    )

    awardedTricks = setTeamPoints(
      awardedTricks,
      roundOutcome.defenderTeam,
      defenderRecordedPoints -
        defenderOwnedDeclarationsRecorded -
        defenderOwnedBeloteRecorded
    )

    nextCarryOver = setCarryOverForTeam(
      nextCarryOver,
      roundOutcome.bidderTeam,
      bidderRecordedPoints * counterMultiplier
    )
  }

  let totalScore = addRoundScores(
    addRoundScores(awardedTricks, awardedDeclarations),
    awardedBelote
  )

  totalScore = multiplyRoundScore(totalScore, counterMultiplier)

  totalScore = applyResolvedCarryOver(
    totalScore,
    'A',
    getCarryOverForTeam(currentCarryOver, 'A'),
    roundOutcome.winningTeam
  )

  totalScore = applyResolvedCarryOver(
    totalScore,
    'B',
    getCarryOverForTeam(currentCarryOver, 'B'),
    roundOutcome.winningTeam
  )

  return {
    roundBreakdown: {
      ...roundBreakdown,
      tricks: awardedTricks,
      declarations: awardedDeclarations,
      belote: awardedBelote,
      total: totalScore,
    },
    nextCarryOver,
  }
}