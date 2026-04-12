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

type RoundingMode = 'suit' | 'all-trumps' | 'no-trumps'

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

function resolveRoundingMode(expectedTotalPoints: number): RoundingMode {
  if (expectedTotalPoints === 258) {
    return 'all-trumps'
  }

  if (expectedTotalPoints === 260) {
    return 'no-trumps'
  }

  return 'suit'
}

function getRoundingThreshold(mode: RoundingMode): number {
  if (mode === 'all-trumps') {
    return 4
  }

  if (mode === 'no-trumps') {
    return 5
  }

  return 6
}

function roundRawPointsWithThreshold(rawPoints: number, mode: RoundingMode): number {
  const threshold = getRoundingThreshold(mode)
  const base = Math.floor(rawPoints / 10)
  const remainder = rawPoints % 10

  return base + (remainder >= threshold ? 1 : 0)
}

function convertRawPairToRecordedPair(
  teamARaw: number,
  teamBRaw: number,
  expectedTotalPoints: number,
  mode: RoundingMode
): RoundScore {
  const recordedTotal = getRecordedRoundTotal(expectedTotalPoints)

  if (teamARaw === teamBRaw) {
    const lowerHalf = Math.floor(recordedTotal / 2)

    return {
      teamA: lowerHalf,
      teamB: recordedTotal - lowerHalf,
    }
  }

  let teamARecorded = roundRawPointsWithThreshold(teamARaw, mode)
  let teamBRecorded = roundRawPointsWithThreshold(teamBRaw, mode)

  const currentTotal = teamARecorded + teamBRecorded

  if (currentTotal > recordedTotal) {
    if (teamARaw > teamBRaw) {
      teamARecorded -= 1
    } else {
      teamBRecorded -= 1
    }
  } else if (currentTotal < recordedTotal) {
    if (teamARaw < teamBRaw) {
      teamARecorded += 1
    } else {
      teamBRecorded += 1
    }
  }

  return {
    teamA: teamARecorded,
    teamB: teamBRecorded,
  }
}

function getRecordedScoreForEqualTie(
  expectedTotalPoints: number
): {
  defenderRecorded: number
  bidderRecorded: number
} {
  const recordedTotal = getRecordedRoundTotal(expectedTotalPoints)
  const defenderRecorded = Math.floor(recordedTotal / 2)
  const bidderRecorded = recordedTotal - defenderRecorded

  return {
    defenderRecorded,
    bidderRecorded,
  }
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

function awardEverythingToTeam(params: {
  winningTeam: Team
  recordedTotalWithPremiums: number
  declarationsRecordedByOwner: RoundScore
  beloteRecordedByOwner: RoundScore
}): {
  awardedTricks: RoundScore
  awardedDeclarations: RoundScore
  awardedBelote: RoundScore
} {
  const transferredDeclarationsRecorded = getCombinedRecordedScore(
    params.declarationsRecordedByOwner
  )
  const transferredBeloteRecorded = getCombinedRecordedScore(
    params.beloteRecordedByOwner
  )

  const awardedDeclarations = setTeamPoints(
    createZeroRoundScore(),
    params.winningTeam,
    transferredDeclarationsRecorded
  )

  const awardedBelote = setTeamPoints(
    createZeroRoundScore(),
    params.winningTeam,
    transferredBeloteRecorded
  )

  const awardedTricks = setTeamPoints(
    createZeroRoundScore(),
    params.winningTeam,
    params.recordedTotalWithPremiums -
      transferredDeclarationsRecorded -
      transferredBeloteRecorded
  )

  return {
    awardedTricks,
    awardedDeclarations,
    awardedBelote,
  }
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
  const roundingMode = resolveRoundingMode(baseRoundScore.expectedTotalPoints)

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
    if (counterMultiplier > 1 && roundOutcome.winningTeam) {
      const awardedAll = awardEverythingToTeam({
        winningTeam: roundOutcome.winningTeam,
        recordedTotalWithPremiums,
        declarationsRecordedByOwner,
        beloteRecordedByOwner,
      })

      awardedTricks = awardedAll.awardedTricks
      awardedDeclarations = awardedAll.awardedDeclarations
      awardedBelote = awardedAll.awardedBelote
    } else {
      const totalRecorded = convertRawPairToRecordedPair(
        baseRoundScore.teamA.rawPoints +
          declarationsScore.teamA +
          beloteScore.teamA,
        baseRoundScore.teamB.rawPoints +
          declarationsScore.teamB +
          beloteScore.teamB,
        expectedTotalWithPremiums,
        roundingMode
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
  }

  if (roundOutcome.outcome === 'inside') {
    if (roundOutcome.defenderTeam) {
      const awardedAll = awardEverythingToTeam({
        winningTeam: roundOutcome.defenderTeam,
        recordedTotalWithPremiums,
        declarationsRecordedByOwner,
        beloteRecordedByOwner,
      })

      awardedTricks = awardedAll.awardedTricks
      awardedDeclarations = awardedAll.awardedDeclarations
      awardedBelote = awardedAll.awardedBelote
    }
  }

  let nextCarryOver: CarryOverPoints = {
    teamA: 0,
    teamB: 0,
  }

  if (roundOutcome.outcome === 'tie' && roundOutcome.defenderTeam && roundOutcome.bidderTeam) {
    let defenderRecordedPoints = 0
    let bidderRecordedPoints = 0

    if (roundOutcome.defenderPoints === roundOutcome.bidderPoints) {
      const equalTieScore = getRecordedScoreForEqualTie(expectedTotalWithPremiums)
      defenderRecordedPoints = equalTieScore.defenderRecorded
      bidderRecordedPoints = equalTieScore.bidderRecorded
    } else {
      const recordedPair = convertRawPairToRecordedPair(
        roundOutcome.defenderTeam === 'A' ? roundOutcome.defenderPoints : roundOutcome.bidderPoints,
        roundOutcome.defenderTeam === 'B' ? roundOutcome.defenderPoints : roundOutcome.bidderPoints,
        expectedTotalWithPremiums,
        roundingMode
      )

      defenderRecordedPoints = getRecordedScoreForTeam(
        recordedPair,
        roundOutcome.defenderTeam
      )
      bidderRecordedPoints = recordedTotalWithPremiums - defenderRecordedPoints
    }

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