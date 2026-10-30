import type { Seat, Team } from '../core/serverTypes.js'
import type {
  ServerAuthoritativeGameState,
  ServerCarryOverPoints,
  ServerCompletedTrick,
  ServerRoundScore,
  ServerScoringState,
  ServerScoreBreakdown,
  ServerSuit,
  ServerWinningBid,
} from './serverGameTypes.js'
import { scoreServerDeclarations } from './declarations/scoreServerDeclarations.js'

export type ServerScoringContract = 'suit' | 'all-trumps' | 'no-trumps'

type ServerTeamBaseScore = {
  team: Team
  rawPoints: number
  tricksWon: number
}

type ServerBaseRoundScore = {
  teamA: ServerTeamBaseScore
  teamB: ServerTeamBaseScore
  lastTrickWinner: Seat | null
  expectedTotalPoints: number
  actualTotalPoints: number
  isComplete: boolean
  isPointTotalValid: boolean
}

type ServerRoundOutcome = {
  bidderTeam: Team | null
  defenderTeam: Team | null
  bidderPoints: number
  defenderPoints: number
  isTie: boolean
  isInside: boolean
  isMade: boolean
  winningTeam: Team | null
  outcome: 'made' | 'inside' | 'tie' | 'unknown'
}

type OfficialRoundScoreResult = {
  roundBreakdown: ServerScoreBreakdown
  nextCarryOver: ServerCarryOverPoints
  // Висящи точки, реално присъдени в ТОВА раздаване, по получил отбор.
  awardedCarryOver: ServerRoundScore
  trace: ServerOfficialScoreTrace
}

// ─── Diagnostic trace (само за belot hand journal-а) ───────────────────────
// Записва междинните стойности и избрания клон на правилата, докато
// buildOfficialRoundScore смята — НЕ участва в изчислението и не променя
// резултата. Чете се единствено от explainServerScoring по-долу.

export type ServerScoringRoundingTrace = {
  teamARaw: number
  teamBRaw: number
  threshold: number
  recordedTotal: number
  roundedTeamA: number
  roundedTeamB: number
  adjustment: 'none' | 'equal_raw_split' | 'decrement_higher_raw' | 'increment_lower_raw'
  adjustedTeam: Team | null
  teamA: number
  teamB: number
}

export type ServerScoringRuleBranch =
  | 'made_points_split_by_rounding'
  | 'made_with_counter_all_points_to_bidder_team'
  | 'inside_all_points_to_defenders'
  | 'tie_equal_split_bidder_points_held'
  | 'tie_rounded_split_bidder_points_held'
  | 'unknown_outcome_no_points'

export type ServerCarryOverResolutionTrace = {
  ownerTeam: Team
  points: number
  awardedTo: Team
  reason: 'owner_team_won_round' | 'owner_team_did_not_win_round'
}

export type ServerOfficialScoreTrace = {
  ruleBranch: ServerScoringRuleBranch
  counterMultiplier: number
  expectedTotalWithPremiums: number
  recordedTotalWithPremiums: number
  declarationsRecordedByOwner: ServerRoundScore
  beloteRecordedByOwner: ServerRoundScore
  rounding: ServerScoringRoundingTrace | null
  awardedBeforeMultiplier: ServerRoundScore
  awardedAfterMultiplier: ServerRoundScore
  carryOverIn: ServerCarryOverPoints
  carryOverResolutions: ServerCarryOverResolutionTrace[]
  nextCarryOver: ServerCarryOverPoints
  nextCarryOverReason: 'no_tie_nothing_held' | 'tie_bidder_recorded_points_times_multiplier_held'
}

export type ServerScoringResolution = {
  roundBreakdown: ServerScoreBreakdown
  matchTotals: ServerRoundScore
  carryOver: ServerCarryOverPoints
  scoring: ServerScoringState
}

const CAPOT_BONUS_POINTS = 90

function createZeroRoundScore(): ServerRoundScore {
  return {
    teamA: 0,
    teamB: 0,
  }
}

function createZeroBreakdown(): ServerScoreBreakdown {
  return {
    tricks: createZeroRoundScore(),
    declarations: createZeroRoundScore(),
    belote: createZeroRoundScore(),
    lastTen: createZeroRoundScore(),
    capot: createZeroRoundScore(),
    total: createZeroRoundScore(),
  }
}

function getTeamBySeat(seat: Seat): Team {
  return seat === 'bottom' || seat === 'top' ? 'A' : 'B'
}

function getOpponentTeam(team: Team): Team {
  return team === 'A' ? 'B' : 'A'
}

function getTeamKey(team: Team): 'teamA' | 'teamB' {
  return team === 'A' ? 'teamA' : 'teamB'
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

// Canonical per-card point value for a given contract/trump — the single
// source of truth shared by gameplay scoring and the training recorder.
export function getServerCardPoints(
  suit: ServerSuit,
  rank: string,
  contract: ServerScoringContract,
  trumpSuit: ServerSuit | null,
): number {
  if (contract === 'all-trumps') {
    return getTrumpCardPoints(rank)
  }

  if (contract === 'no-trumps') {
    return getNonTrumpCardPoints(rank)
  }

  if (trumpSuit !== null && suit === trumpSuit) {
    return getTrumpCardPoints(rank)
  }

  return getNonTrumpCardPoints(rank)
}

// Canonical raw trick points (no last-trick or capot bonus) — shared by
// gameplay scoring and the training recorder so the two never drift apart.
export function getServerTrickCardPoints(
  trick: { plays: { card: { suit: ServerSuit; rank: string } }[] },
  contract: ServerScoringContract,
  trumpSuit: ServerSuit | null,
): number {
  const rawPoints = trick.plays.reduce(
    (sum, play) => sum + getServerCardPoints(play.card.suit, play.card.rank, contract, trumpSuit),
    0,
  )

  return contract === 'no-trumps' ? rawPoints * 2 : rawPoints
}

function getBaseExpectedTotalPoints(contract: ServerScoringContract): number {
  if (contract === 'all-trumps') return 258
  if (contract === 'no-trumps') return 260
  return 162
}

function getCapotWinnerTeam(
  isComplete: boolean,
  teamATricksWon: number,
  teamBTricksWon: number,
): Team | null {
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

function getCapotBonusPoints(contract: ServerScoringContract): number {
  return contract === 'no-trumps'
    ? CAPOT_BONUS_POINTS * 2
    : CAPOT_BONUS_POINTS
}

function calculateBaseRoundScore(input: {
  tricks: ServerCompletedTrick[]
  contract: ServerScoringContract
  trumpSuit: ServerSuit | null
}): ServerBaseRoundScore {
  const teamA: ServerTeamBaseScore = {
    team: 'A',
    rawPoints: 0,
    tricksWon: 0,
  }
  const teamB: ServerTeamBaseScore = {
    team: 'B',
    rawPoints: 0,
    tricksWon: 0,
  }

  const completedTricks = input.tricks
  const lastTrick = completedTricks[completedTricks.length - 1] ?? null

  for (const trick of completedTricks) {
    const winnerTeam = getTeamBySeat(trick.winnerSeat)
    const trickPoints = trick.plays.reduce((sum, play) => {
      return sum + getServerCardPoints(
        play.card.suit,
        play.card.rank,
        input.contract,
        input.trumpSuit,
      )
    }, 0)

    if (winnerTeam === 'A') {
      teamA.rawPoints += trickPoints
      teamA.tricksWon += 1
    } else {
      teamB.rawPoints += trickPoints
      teamB.tricksWon += 1
    }
  }

  if (lastTrick !== null) {
    if (getTeamBySeat(lastTrick.winnerSeat) === 'A') {
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
  const capotWinnerTeam = getCapotWinnerTeam(
    isComplete,
    teamA.tricksWon,
    teamB.tricksWon,
  )
  const capotBonusPoints = getCapotBonusPoints(input.contract)

  if (capotWinnerTeam === 'A') {
    teamA.rawPoints += capotBonusPoints
  } else if (capotWinnerTeam === 'B') {
    teamB.rawPoints += capotBonusPoints
  }

  const actualTotalPoints = teamA.rawPoints + teamB.rawPoints
  const expectedTotalPoints =
    getBaseExpectedTotalPoints(input.contract) +
    (capotWinnerTeam === null ? 0 : capotBonusPoints)

  return {
    teamA,
    teamB,
    lastTrickWinner: lastTrick?.winnerSeat ?? null,
    expectedTotalPoints,
    actualTotalPoints,
    isComplete,
    isPointTotalValid: actualTotalPoints === expectedTotalPoints,
  }
}

function getTeamTotalPoints(params: {
  basePoints: number
  declarationsPoints: number
  belotePoints: number
}): number {
  return params.basePoints + params.declarationsPoints + params.belotePoints
}

function calculateRoundOutcome(input: {
  baseRoundScore: ServerBaseRoundScore
  bidderSeat: Seat
  declarationsTeamA: number
  declarationsTeamB: number
  beloteTeamA: number
  beloteTeamB: number
}): ServerRoundOutcome {
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

function addRoundScores(
  left: ServerRoundScore,
  right: ServerRoundScore,
): ServerRoundScore {
  return {
    teamA: left.teamA + right.teamA,
    teamB: left.teamB + right.teamB,
  }
}

function subtractRoundScores(
  left: ServerRoundScore,
  right: ServerRoundScore,
): ServerRoundScore {
  return {
    teamA: left.teamA - right.teamA,
    teamB: left.teamB - right.teamB,
  }
}

function setTeamPoints(
  score: ServerRoundScore,
  team: Team,
  value: number,
): ServerRoundScore {
  const key = getTeamKey(team)

  return {
    ...score,
    [key]: value,
  }
}

function addTeamPoints(
  score: ServerRoundScore,
  team: Team,
  value: number,
): ServerRoundScore {
  const key = getTeamKey(team)

  return {
    ...score,
    [key]: score[key] + value,
  }
}

function multiplyRoundScore(
  score: ServerRoundScore,
  multiplier: number,
): ServerRoundScore {
  if (multiplier <= 1) {
    return score
  }

  return {
    teamA: score.teamA * multiplier,
    teamB: score.teamB * multiplier,
  }
}

function getRecordedRoundTotal(expectedTotalPoints: number): number {
  return Math.round(expectedTotalPoints / 10)
}

function getRecordedPremiumPoints(rawPoints: number): number {
  return Math.round(rawPoints / 10)
}

function getRoundingThreshold(contract: ServerScoringContract): number {
  if (contract === 'all-trumps') {
    return 4
  }

  if (contract === 'no-trumps') {
    return 5
  }

  return 6
}

function roundRawPointsWithThreshold(
  rawPoints: number,
  contract: ServerScoringContract,
): number {
  const threshold = getRoundingThreshold(contract)
  const base = Math.floor(rawPoints / 10)
  const remainder = rawPoints % 10

  return base + (remainder >= threshold ? 1 : 0)
}

function convertRawPairToRecordedPair(
  teamARaw: number,
  teamBRaw: number,
  expectedTotalPoints: number,
  contract: ServerScoringContract,
  trace?: { value: ServerScoringRoundingTrace | null },
): ServerRoundScore {
  const recordedTotal = getRecordedRoundTotal(expectedTotalPoints)
  const threshold = getRoundingThreshold(contract)

  if (teamARaw === teamBRaw) {
    const lowerHalf = Math.floor(recordedTotal / 2)

    if (trace) {
      trace.value = {
        teamARaw,
        teamBRaw,
        threshold,
        recordedTotal,
        roundedTeamA: lowerHalf,
        roundedTeamB: recordedTotal - lowerHalf,
        adjustment: 'equal_raw_split',
        adjustedTeam: null,
        teamA: lowerHalf,
        teamB: recordedTotal - lowerHalf,
      }
    }

    return {
      teamA: lowerHalf,
      teamB: recordedTotal - lowerHalf,
    }
  }

  let teamARecorded = roundRawPointsWithThreshold(teamARaw, contract)
  let teamBRecorded = roundRawPointsWithThreshold(teamBRaw, contract)
  const roundedTeamA = teamARecorded
  const roundedTeamB = teamBRecorded
  const currentTotal = teamARecorded + teamBRecorded
  let adjustment: ServerScoringRoundingTrace['adjustment'] = 'none'
  let adjustedTeam: Team | null = null

  if (currentTotal > recordedTotal) {
    adjustment = 'decrement_higher_raw'
    if (teamARaw > teamBRaw) {
      teamARecorded -= 1
      adjustedTeam = 'A'
    } else {
      teamBRecorded -= 1
      adjustedTeam = 'B'
    }
  } else if (currentTotal < recordedTotal) {
    adjustment = 'increment_lower_raw'
    if (teamARaw < teamBRaw) {
      teamARecorded += 1
      adjustedTeam = 'A'
    } else {
      teamBRecorded += 1
      adjustedTeam = 'B'
    }
  }

  if (trace) {
    trace.value = {
      teamARaw,
      teamBRaw,
      threshold,
      recordedTotal,
      roundedTeamA,
      roundedTeamB,
      adjustment,
      adjustedTeam,
      teamA: teamARecorded,
      teamB: teamBRecorded,
    }
  }

  return {
    teamA: teamARecorded,
    teamB: teamBRecorded,
  }
}

function getRecordedScoreForEqualTie(expectedTotalPoints: number): {
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

function getCarryOverForTeam(
  carryOver: ServerCarryOverPoints,
  team: Team,
): number {
  return team === 'A' ? carryOver.teamA : carryOver.teamB
}

function setCarryOverForTeam(
  carryOver: ServerCarryOverPoints,
  team: Team,
  value: number,
): ServerCarryOverPoints {
  const key = team === 'A' ? 'teamA' : 'teamB'

  return {
    ...carryOver,
    [key]: value,
  }
}

function applyResolvedCarryOver(
  totalScore: ServerRoundScore,
  carryOverTeam: Team,
  carryOverPoints: number,
  roundWinningTeam: Team | null,
): ServerRoundScore {
  if (carryOverPoints <= 0) {
    return totalScore
  }

  if (roundWinningTeam === carryOverTeam) {
    return addTeamPoints(totalScore, carryOverTeam, carryOverPoints)
  }

  return addTeamPoints(totalScore, getOpponentTeam(carryOverTeam), carryOverPoints)
}

function getRecordedScoreForTeam(score: ServerRoundScore, team: Team): number {
  return team === 'A' ? score.teamA : score.teamB
}

function getCombinedRecordedScore(score: ServerRoundScore): number {
  return score.teamA + score.teamB
}

function normalizeCounterMultiplier(value: number): number {
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
  declarationsRecordedByOwner: ServerRoundScore
  beloteRecordedByOwner: ServerRoundScore
}): {
  awardedTricks: ServerRoundScore
  awardedDeclarations: ServerRoundScore
  awardedBelote: ServerRoundScore
} {
  const transferredDeclarationsRecorded = getCombinedRecordedScore(
    params.declarationsRecordedByOwner,
  )
  const transferredBeloteRecorded = getCombinedRecordedScore(
    params.beloteRecordedByOwner,
  )

  const awardedDeclarations = setTeamPoints(
    createZeroRoundScore(),
    params.winningTeam,
    transferredDeclarationsRecorded,
  )
  const awardedBelote = setTeamPoints(
    createZeroRoundScore(),
    params.winningTeam,
    transferredBeloteRecorded,
  )
  const awardedTricks = setTeamPoints(
    createZeroRoundScore(),
    params.winningTeam,
    params.recordedTotalWithPremiums -
      transferredDeclarationsRecorded -
      transferredBeloteRecorded,
  )

  return {
    awardedTricks,
    awardedDeclarations,
    awardedBelote,
  }
}

function buildOfficialRoundScore(input: {
  baseRoundScore: ServerBaseRoundScore
  roundOutcome: ServerRoundOutcome
  currentCarryOver: ServerCarryOverPoints
  declarationsScore: ServerRoundScore
  beloteScore: ServerRoundScore
  counterMultiplier: number
  contract: ServerScoringContract
}): OfficialRoundScoreResult {
  const declarationsScore = input.declarationsScore
  const beloteScore = input.beloteScore
  const counterMultiplier = normalizeCounterMultiplier(input.counterMultiplier)
  const expectedTotalWithPremiums =
    input.baseRoundScore.expectedTotalPoints +
    declarationsScore.teamA +
    declarationsScore.teamB +
    beloteScore.teamA +
    beloteScore.teamB
  const recordedTotalWithPremiums = getRecordedRoundTotal(expectedTotalWithPremiums)
  const declarationsRecordedByOwner: ServerRoundScore = {
    teamA: getRecordedPremiumPoints(declarationsScore.teamA),
    teamB: getRecordedPremiumPoints(declarationsScore.teamB),
  }
  const beloteRecordedByOwner: ServerRoundScore = {
    teamA: getRecordedPremiumPoints(beloteScore.teamA),
    teamB: getRecordedPremiumPoints(beloteScore.teamB),
  }

  let awardedTricks = createZeroRoundScore()
  let awardedDeclarations = createZeroRoundScore()
  let awardedBelote = createZeroRoundScore()
  let ruleBranch: ServerScoringRuleBranch = 'unknown_outcome_no_points'
  const roundingTrace: { value: ServerScoringRoundingTrace | null } = { value: null }

  if (input.roundOutcome.outcome === 'made') {
    ruleBranch = 'made_points_split_by_rounding'
    if (counterMultiplier > 1 && input.roundOutcome.winningTeam !== null) {
      ruleBranch = 'made_with_counter_all_points_to_bidder_team'
      const awardedAll = awardEverythingToTeam({
        winningTeam: input.roundOutcome.winningTeam,
        recordedTotalWithPremiums,
        declarationsRecordedByOwner,
        beloteRecordedByOwner,
      })

      awardedTricks = awardedAll.awardedTricks
      awardedDeclarations = awardedAll.awardedDeclarations
      awardedBelote = awardedAll.awardedBelote
    } else {
      const totalRecorded = convertRawPairToRecordedPair(
        input.baseRoundScore.teamA.rawPoints +
          declarationsScore.teamA +
          beloteScore.teamA,
        input.baseRoundScore.teamB.rawPoints +
          declarationsScore.teamB +
          beloteScore.teamB,
        expectedTotalWithPremiums,
        input.contract,
        roundingTrace,
      )

      awardedDeclarations = { ...declarationsRecordedByOwner }
      awardedBelote = { ...beloteRecordedByOwner }
      awardedTricks = subtractRoundScores(
        totalRecorded,
        addRoundScores(awardedDeclarations, awardedBelote),
      )
    }
  }

  if (input.roundOutcome.outcome === 'inside' && input.roundOutcome.defenderTeam !== null) {
    ruleBranch = 'inside_all_points_to_defenders'
    const awardedAll = awardEverythingToTeam({
      winningTeam: input.roundOutcome.defenderTeam,
      recordedTotalWithPremiums,
      declarationsRecordedByOwner,
      beloteRecordedByOwner,
    })

    awardedTricks = awardedAll.awardedTricks
    awardedDeclarations = awardedAll.awardedDeclarations
    awardedBelote = awardedAll.awardedBelote
  }

  let nextCarryOver: ServerCarryOverPoints = {
    teamA: 0,
    teamB: 0,
  }
  // Равна игра не е решено раздаване — вече висящите точки не се присъждат,
  // а се пренасят заедно с новите (натрупване при поредни равни игри).
  const isTieOutcome = input.roundOutcome.outcome === 'tie'

  if (
    isTieOutcome &&
    input.roundOutcome.defenderTeam !== null &&
    input.roundOutcome.bidderTeam !== null
  ) {
    let defenderRecordedPoints = 0
    let bidderRecordedPoints = 0

    if (input.roundOutcome.defenderPoints === input.roundOutcome.bidderPoints) {
      ruleBranch = 'tie_equal_split_bidder_points_held'
      const equalTieScore = getRecordedScoreForEqualTie(expectedTotalWithPremiums)
      defenderRecordedPoints = equalTieScore.defenderRecorded
      bidderRecordedPoints = equalTieScore.bidderRecorded
    } else {
      ruleBranch = 'tie_rounded_split_bidder_points_held'
      const recordedPair = convertRawPairToRecordedPair(
        input.roundOutcome.defenderTeam === 'A'
          ? input.roundOutcome.defenderPoints
          : input.roundOutcome.bidderPoints,
        input.roundOutcome.defenderTeam === 'B'
          ? input.roundOutcome.defenderPoints
          : input.roundOutcome.bidderPoints,
        expectedTotalWithPremiums,
        input.contract,
        roundingTrace,
      )

      defenderRecordedPoints = getRecordedScoreForTeam(
        recordedPair,
        input.roundOutcome.defenderTeam,
      )
      bidderRecordedPoints = recordedTotalWithPremiums - defenderRecordedPoints
    }

    const defenderOwnedDeclarationsRecorded = getRecordedScoreForTeam(
      declarationsRecordedByOwner,
      input.roundOutcome.defenderTeam,
    )
    const defenderOwnedBeloteRecorded = getRecordedScoreForTeam(
      beloteRecordedByOwner,
      input.roundOutcome.defenderTeam,
    )

    awardedDeclarations = setTeamPoints(
      awardedDeclarations,
      input.roundOutcome.defenderTeam,
      defenderOwnedDeclarationsRecorded,
    )
    awardedBelote = setTeamPoints(
      awardedBelote,
      input.roundOutcome.defenderTeam,
      defenderOwnedBeloteRecorded,
    )
    awardedTricks = setTeamPoints(
      awardedTricks,
      input.roundOutcome.defenderTeam,
      defenderRecordedPoints -
        defenderOwnedDeclarationsRecorded -
        defenderOwnedBeloteRecorded,
    )

    nextCarryOver = setCarryOverForTeam(
      { ...input.currentCarryOver },
      input.roundOutcome.bidderTeam,
      getCarryOverForTeam(input.currentCarryOver, input.roundOutcome.bidderTeam) +
        bidderRecordedPoints * counterMultiplier,
    )
  }

  let totalScore = addRoundScores(
    addRoundScores(awardedTricks, awardedDeclarations),
    awardedBelote,
  )
  const awardedBeforeMultiplier = totalScore

  totalScore = multiplyRoundScore(totalScore, counterMultiplier)
  const awardedAfterMultiplier = totalScore
  if (!isTieOutcome) {
    totalScore = applyResolvedCarryOver(
      totalScore,
      'A',
      getCarryOverForTeam(input.currentCarryOver, 'A'),
      input.roundOutcome.winningTeam,
    )
    totalScore = applyResolvedCarryOver(
      totalScore,
      'B',
      getCarryOverForTeam(input.currentCarryOver, 'B'),
      input.roundOutcome.winningTeam,
    )
  }

  const carryOverResolutions: ServerCarryOverResolutionTrace[] = []
  for (const ownerTeam of isTieOutcome ? [] : (['A', 'B'] as const)) {
    const points = getCarryOverForTeam(input.currentCarryOver, ownerTeam)
    if (points <= 0) continue
    const ownerWon = input.roundOutcome.winningTeam === ownerTeam
    carryOverResolutions.push({
      ownerTeam,
      points,
      awardedTo: ownerWon ? ownerTeam : getOpponentTeam(ownerTeam),
      reason: ownerWon ? 'owner_team_won_round' : 'owner_team_did_not_win_round',
    })
  }

  return {
    roundBreakdown: {
      ...createZeroBreakdown(),
      tricks: awardedTricks,
      declarations: awardedDeclarations,
      belote: awardedBelote,
      total: totalScore,
    },
    nextCarryOver,
    // Точно това, което applyResolvedCarryOver е добавил горе (0/0 при равна).
    awardedCarryOver: subtractRoundScores(totalScore, awardedAfterMultiplier),
    trace: {
      ruleBranch,
      counterMultiplier,
      expectedTotalWithPremiums,
      recordedTotalWithPremiums,
      declarationsRecordedByOwner,
      beloteRecordedByOwner,
      rounding: roundingTrace.value,
      awardedBeforeMultiplier,
      awardedAfterMultiplier,
      carryOverIn: { ...input.currentCarryOver },
      carryOverResolutions,
      nextCarryOver,
      nextCarryOverReason:
        input.roundOutcome.outcome === 'tie'
          ? 'tie_bidder_recorded_points_times_multiplier_held'
          : 'no_tie_nothing_held',
    },
  }
}

export function getServerCounterMultiplier(
  winningBid: NonNullable<ServerWinningBid>,
): number {
  if (winningBid.redoubled) {
    return 4
  }

  if (winningBid.doubled) {
    return 2
  }

  return 1
}

export function getServerOutcomeLabel(
  outcome: ServerRoundOutcome['outcome'],
): string {
  if (outcome === 'made') return 'Обявилият е изкарал'
  if (outcome === 'inside') return 'Обявилият е вътре'
  if (outcome === 'tie') return 'Равна игра'
  return 'Неизвестен резултат'
}

export function getServerOutcomeShortLabel(
  outcome: ServerRoundOutcome['outcome'],
): string {
  if (outcome === 'made') return 'Изкарана'
  if (outcome === 'inside') return 'Вътре'
  if (outcome === 'tie') return 'Равна'
  return '—'
}

export function resolveServerScoring(
  state: ServerAuthoritativeGameState,
): ServerScoringResolution | null {
  const winningBid = state.bidding.winningBid
  const playing = state.playing

  if (winningBid === null || playing === null) {
    return null
  }

  const baseRoundScore = calculateBaseRoundScore({
    tricks: playing.completedTricks,
    contract: winningBid.contract,
    trumpSuit: winningBid.trumpSuit,
  })
  const { declarationPoints, belotePoints } = scoreServerDeclarations(
    state.declarations,
  )
  const roundOutcome = calculateRoundOutcome({
    baseRoundScore,
    bidderSeat: winningBid.seat,
    declarationsTeamA: declarationPoints.teamA,
    declarationsTeamB: declarationPoints.teamB,
    beloteTeamA: belotePoints.teamA,
    beloteTeamB: belotePoints.teamB,
  })
  const counterMultiplier = getServerCounterMultiplier(winningBid)
  const officialRoundScore = buildOfficialRoundScore({
    baseRoundScore,
    roundOutcome,
    currentCarryOver: state.score.carryOver,
    declarationsScore: declarationPoints,
    beloteScore: belotePoints,
    counterMultiplier,
    contract: winningBid.contract,
  })
  const rawHandPoints: ServerRoundScore = {
    teamA: baseRoundScore.teamA.rawPoints,
    teamB: baseRoundScore.teamB.rawPoints,
  }
  const rawHandTricksWon: ServerRoundScore = {
    teamA: baseRoundScore.teamA.tricksWon,
    teamB: baseRoundScore.teamB.tricksWon,
  }
  const sumPoints: ServerRoundScore = {
    teamA: rawHandPoints.teamA + declarationPoints.teamA + belotePoints.teamA,
    teamB: rawHandPoints.teamB + declarationPoints.teamB + belotePoints.teamB,
  }
  const officialRoundPoints = officialRoundScore.roundBreakdown.total
  const matchTotals = addRoundScores(state.score.match, officialRoundPoints)
  const carryOver = officialRoundScore.nextCarryOver
  const isCapotRound =
    baseRoundScore.isComplete &&
    (baseRoundScore.teamA.tricksWon === 8 || baseRoundScore.teamB.tricksWon === 8)
  const isNonCapotRound =
    baseRoundScore.isComplete &&
    baseRoundScore.teamA.tricksWon > 0 &&
    baseRoundScore.teamB.tricksWon > 0

  return {
    roundBreakdown: officialRoundScore.roundBreakdown,
    matchTotals,
    carryOver,
    scoring: {
      winningBid,
      rawHandPoints,
      rawHandTricksWon,
      declarationPoints,
      belotePoints,
      sumPoints,
      officialRoundPoints,
      matchTotals,
      carryOver,
      awardedCarryOver: officialRoundScore.awardedCarryOver,
      isCapotRound,
      isNonCapotRound,
      outcomeLabel: getServerOutcomeLabel(roundOutcome.outcome),
      outcomeShortLabel: getServerOutcomeShortLabel(roundOutcome.outcome),
      // Semantic outcome for programmatic consumers (e.g. training recorder) —
      // roundOutcome.outcome is never 'unknown' in practice (calculateRoundOutcome
      // always resolves to one of the three), 'tie' is a defensive fallback only.
      outcome: roundOutcome.outcome === 'unknown' ? 'tie' : roundOutcome.outcome,
      counterMultiplier,
    },
  }
}

// ─── Diagnostic explanation (belot hand journal) ───────────────────────────
// Минава през ТОЧНО същия pipeline като resolveServerScoring (същите
// функции, същия вход), но връща и междинните стойности + избрания клон на
// правилата, за да може журналът да обясни всяко число. Не се ползва от
// gameplay-а; резултатът му се сравнява с вече приложения state.scoring.

export type ServerScoringTeamExplanation = {
  tricksWon: number
  // Сума на точките на картите във взетите взятки (без ×2 за Без коз).
  cardPoints: number
  // 10 за отбора с последната взятка (преди ×2 за Без коз), иначе 0.
  lastTrickBonus: number
  noTrumpsMultiplier: number
  // 90 (180 при Без коз) само при реално капо, иначе 0.
  capotBonus: number
  // (cardPoints + lastTrickBonus) × noTrumpsMultiplier + capotBonus.
  rawPoints: number
}

export type ServerScoringTrickExplanation = {
  trickIndex: number
  winnerSeat: Seat
  winnerTeam: Team
  cardPoints: number
  isLastTrick: boolean
}

export type ServerScoringExplanation = {
  contract: ServerScoringContract
  trumpSuit: ServerSuit | null
  bidderSeat: Seat
  bidderTeam: Team
  defenderTeam: Team
  doubled: boolean
  redoubled: boolean
  tricks: ServerScoringTrickExplanation[]
  teams: { teamA: ServerScoringTeamExplanation; teamB: ServerScoringTeamExplanation }
  lastTrickWinnerSeat: Seat | null
  isComplete: boolean
  capotTeam: Team | null
  expectedTotalPoints: number
  actualTotalPoints: number
  isPointTotalValid: boolean
  declarationPoints: ServerRoundScore
  belotePoints: ServerRoundScore
  outcome: {
    outcome: ServerRoundOutcome['outcome']
    bidderPoints: number
    defenderPoints: number
    winningTeam: Team | null
  }
  official: ServerOfficialScoreTrace
  roundBreakdown: ServerScoreBreakdown
  isCapotRound: boolean
  isNonCapotRound: boolean
  matchBefore: ServerRoundScore
  matchAfter: ServerRoundScore
  carryOverBefore: ServerCarryOverPoints
  carryOverAfter: ServerCarryOverPoints
}

export function explainServerScoring(
  state: ServerAuthoritativeGameState,
): ServerScoringExplanation | null {
  const winningBid = state.bidding.winningBid
  const playing = state.playing

  if (winningBid === null || playing === null) {
    return null
  }

  const contract = winningBid.contract
  const trumpSuit = winningBid.trumpSuit
  const completedTricks = playing.completedTricks
  const baseRoundScore = calculateBaseRoundScore({
    tricks: completedTricks,
    contract,
    trumpSuit,
  })
  const { declarationPoints, belotePoints } = scoreServerDeclarations(
    state.declarations,
  )
  const roundOutcome = calculateRoundOutcome({
    baseRoundScore,
    bidderSeat: winningBid.seat,
    declarationsTeamA: declarationPoints.teamA,
    declarationsTeamB: declarationPoints.teamB,
    beloteTeamA: belotePoints.teamA,
    beloteTeamB: belotePoints.teamB,
  })
  const counterMultiplier = getServerCounterMultiplier(winningBid)
  const officialRoundScore = buildOfficialRoundScore({
    baseRoundScore,
    roundOutcome,
    currentCarryOver: state.score.carryOver,
    declarationsScore: declarationPoints,
    beloteScore: belotePoints,
    counterMultiplier,
    contract,
  })

  const noTrumpsMultiplier = contract === 'no-trumps' ? 2 : 1
  const capotTeam = getCapotWinnerTeam(
    baseRoundScore.isComplete,
    baseRoundScore.teamA.tricksWon,
    baseRoundScore.teamB.tricksWon,
  )
  const lastTrickIndex = completedTricks.length - 1
  const tricks: ServerScoringTrickExplanation[] = completedTricks.map((trick, index) => ({
    trickIndex: trick.trickIndex,
    winnerSeat: trick.winnerSeat,
    winnerTeam: getTeamBySeat(trick.winnerSeat),
    cardPoints: trick.plays.reduce(
      (sum, play) => sum + getServerCardPoints(play.card.suit, play.card.rank, contract, trumpSuit),
      0,
    ),
    isLastTrick: index === lastTrickIndex,
  }))

  function explainTeam(team: Team): ServerScoringTeamExplanation {
    const teamTricks = tricks.filter((trick) => trick.winnerTeam === team)
    const cardPoints = teamTricks.reduce((sum, trick) => sum + trick.cardPoints, 0)
    const lastTrickBonus =
      baseRoundScore.lastTrickWinner !== null && getTeamBySeat(baseRoundScore.lastTrickWinner) === team
        ? 10
        : 0
    const capotBonus = capotTeam === team ? getCapotBonusPoints(contract) : 0
    return {
      tricksWon: teamTricks.length,
      cardPoints,
      lastTrickBonus,
      noTrumpsMultiplier,
      capotBonus,
      rawPoints: (cardPoints + lastTrickBonus) * noTrumpsMultiplier + capotBonus,
    }
  }

  const bidderTeam = getTeamBySeat(winningBid.seat)

  return {
    contract,
    trumpSuit,
    bidderSeat: winningBid.seat,
    bidderTeam,
    defenderTeam: getOpponentTeam(bidderTeam),
    doubled: winningBid.doubled,
    redoubled: winningBid.redoubled,
    tricks,
    teams: { teamA: explainTeam('A'), teamB: explainTeam('B') },
    lastTrickWinnerSeat: baseRoundScore.lastTrickWinner,
    isComplete: baseRoundScore.isComplete,
    capotTeam,
    expectedTotalPoints: baseRoundScore.expectedTotalPoints,
    actualTotalPoints: baseRoundScore.actualTotalPoints,
    isPointTotalValid: baseRoundScore.isPointTotalValid,
    declarationPoints,
    belotePoints,
    outcome: {
      outcome: roundOutcome.outcome,
      bidderPoints: roundOutcome.bidderPoints,
      defenderPoints: roundOutcome.defenderPoints,
      winningTeam: roundOutcome.winningTeam,
    },
    official: officialRoundScore.trace,
    roundBreakdown: officialRoundScore.roundBreakdown,
    isCapotRound:
      baseRoundScore.isComplete &&
      (baseRoundScore.teamA.tricksWon === 8 || baseRoundScore.teamB.tricksWon === 8),
    isNonCapotRound:
      baseRoundScore.isComplete &&
      baseRoundScore.teamA.tricksWon > 0 &&
      baseRoundScore.teamB.tricksWon > 0,
    matchBefore: { ...state.score.match },
    matchAfter: addRoundScores(state.score.match, officialRoundScore.roundBreakdown.total),
    carryOverBefore: { ...state.score.carryOver },
    carryOverAfter: officialRoundScore.nextCarryOver,
  }
}
