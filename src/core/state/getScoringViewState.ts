import type { GameState, BaseRoundScoreResult, RoundOutcomeResult, RoundScore, Team } from './gameTypes'
import { buildBeloteScore, buildComparableDeclarationsScore } from '../rules/declarationsRules'
import { calculateRoundOutcome } from '../rules/calculateRoundOutcome'
import { buildOfficialRoundScore } from '../rules/buildOfficialRoundScore'

type BaseRoundScore = BaseRoundScoreResult
type Outcome = RoundOutcomeResult

const SCORING_AUTO_ADVANCE_MS = 5000

export type ScoringViewState = {
  isVisible: boolean
  hasBaseRoundScore: boolean
  hasOutcome: boolean
  winningBidLabel: string
  winningBidOwnerLabel: string
  teamARawPoints: number
  teamBRawPoints: number
  teamATricksWon: number
  teamBTricksWon: number
  teamADeclarationPoints: number
  teamBDeclarationPoints: number
  teamABelotePoints: number
  teamBBelotePoints: number
  teamASumPoints: number
  teamBSumPoints: number
  expectedTotalPoints: number
  actualTotalPoints: number
  isComplete: boolean
  isPointTotalValid: boolean
  lastTrickWinnerLabel: string
  bidderTeamLabel: string
  defenderTeamLabel: string
  bidderPoints: number
  defenderPoints: number
  winningTeamLabel: string
  outcomeLabel: string
  outcomeShortLabel: string
  isInside: boolean
  isMade: boolean
  isTie: boolean
  officialRoundTeamA: number
  officialRoundTeamB: number
  matchTotalTeamA: number
  matchTotalTeamB: number
  carryOverTeamA: number
  carryOverTeamB: number
  hasDouble: boolean
  hasRedouble: boolean
  counterMultiplier: number
  countdownSeconds: number
  autoAdvanceCountdownSeconds: number
}

function createZeroRoundScore(): RoundScore {
  return {
    teamA: 0,
    teamB: 0,
  }
}

function formatSuitLabel(suit: string | null | undefined): string {
  if (suit === 'spades') return 'Пика'
  if (suit === 'hearts') return 'Купа'
  if (suit === 'diamonds') return 'Каро'
  if (suit === 'clubs') return 'Спатия'
  return '—'
}

function formatSeatLabel(seat: string | null | undefined): string {
  if (seat === 'bottom') return 'Долу'
  if (seat === 'right') return 'Дясно'
  if (seat === 'top') return 'Горе'
  if (seat === 'left') return 'Ляво'
  return '—'
}

function formatTeamLabel(team: 'A' | 'B' | null | undefined): string {
  if (team === 'A') return 'Отбор A'
  if (team === 'B') return 'Отбор B'
  return '—'
}

function resolveWinningBidLabel(
  winningBid: GameState['bidding']['winningBid']
): string {
  if (!winningBid) {
    return 'Няма обява'
  }

  if (winningBid.contract === 'suit') {
    return formatSuitLabel(winningBid.trumpSuit)
  }

  if (winningBid.contract === 'all-trumps') {
    return 'Всичко коз'
  }

  if (winningBid.contract === 'no-trumps') {
    return 'Без коз'
  }

  return 'Няма обява'
}

function resolveOutcomeLabel(
  outcome: 'made' | 'inside' | 'tie' | 'unknown'
): string {
  if (outcome === 'made') return 'Обявилият е изкарал'
  if (outcome === 'inside') return 'Обявилият е вътре'
  if (outcome === 'tie') return 'Равна игра'
  return 'Неизвестен резултат'
}

function resolveOutcomeShortLabel(
  outcome: 'made' | 'inside' | 'tie' | 'unknown'
): string {
  if (outcome === 'made') return 'Изкарана'
  if (outcome === 'inside') return 'Вътре'
  if (outcome === 'tie') return 'Равна'
  return '—'
}

function getTeamBySeat(
  seat: GameState['bidding']['winningBid'] extends infer T ? T : never
): Team | null {
  if (!seat || typeof seat !== 'object' || !('seat' in seat)) {
    return null
  }

  const winningBidSeat = seat.seat

  if (winningBidSeat === 'bottom' || winningBidSeat === 'top') {
    return 'A'
  }

  if (winningBidSeat === 'left' || winningBidSeat === 'right') {
    return 'B'
  }

  return null
}

function resolveWinningBidOwnerLabel(
  winningBid: GameState['bidding']['winningBid']
): string {
  const team = getTeamBySeat(winningBid)

  if (team === 'A') {
    return 'НИЕ'
  }

  if (team === 'B') {
    return 'ВИЕ'
  }

  return '—'
}

function resolveCounterMultiplier(
  winningBid: GameState['bidding']['winningBid']
): number {
  if (!winningBid) {
    return 1
  }

  if (winningBid.redoubled) {
    return 4
  }

  if (winningBid.doubled) {
    return 2
  }

  return 1
}

function getNowForTimestamp(timestamp: number | null | undefined): number {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return performance.now()
    }

    return Date.now()
  }

  if (timestamp > 1_000_000_000_000) {
    return Date.now()
  }

  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now()
  }

  return Date.now()
}

function resolveScoringCountdownSeconds(state: GameState): number {
  if (state.phase !== 'scoring') {
    return 5
  }

  const phaseEnteredAt =
    typeof state.phaseEnteredAt === 'number' && Number.isFinite(state.phaseEnteredAt)
      ? state.phaseEnteredAt
      : null

  if (phaseEnteredAt === null) {
    return 5
  }

  const now = getNowForTimestamp(phaseEnteredAt)
  const elapsedMs = Math.max(0, now - phaseEnteredAt)
  const remainingMs = Math.max(0, SCORING_AUTO_ADVANCE_MS - elapsedMs)

  return Math.ceil(remainingMs / 1000)
}

export function getScoringViewState(state: GameState): ScoringViewState {
  const scoringState = state.scoring
  const baseRoundScore: BaseRoundScore | null = scoringState?.baseRoundScore ?? null
  const storedOutcome: Outcome | null = scoringState?.roundOutcome ?? null

  const declarationsScore = baseRoundScore
    ? buildComparableDeclarationsScore(state.declarations)
    : createZeroRoundScore()

  const beloteScore = baseRoundScore
    ? buildBeloteScore(state.declarations)
    : createZeroRoundScore()

  const computedOutcome =
    baseRoundScore && state.bidding.winningBid?.seat
      ? calculateRoundOutcome({
          baseRoundScore,
          bidderSeat: state.bidding.winningBid.seat,
          declarationsTeamA: declarationsScore.teamA,
          declarationsTeamB: declarationsScore.teamB,
          beloteTeamA: beloteScore.teamA,
          beloteTeamB: beloteScore.teamB,
        })
      : null

  const outcome: Outcome | null = computedOutcome ?? storedOutcome
  const counterMultiplier = resolveCounterMultiplier(state.bidding.winningBid)

  const officialRoundResult =
    baseRoundScore && outcome
      ? buildOfficialRoundScore({
          baseRoundScore,
          roundOutcome: outcome,
          currentCarryOver: state.score.carryOver,
          declarationsScore,
          beloteScore,
          counterMultiplier,
        })
      : null

  const premiumPointsTotal =
    declarationsScore.teamA +
    declarationsScore.teamB +
    beloteScore.teamA +
    beloteScore.teamB

  const teamASumPoints =
    (baseRoundScore?.teamA.rawPoints ?? 0) +
    declarationsScore.teamA +
    beloteScore.teamA

  const teamBSumPoints =
    (baseRoundScore?.teamB.rawPoints ?? 0) +
    declarationsScore.teamB +
    beloteScore.teamB

  const countdownSeconds = resolveScoringCountdownSeconds(state)

  return {
    isVisible: state.phase === 'scoring',
    hasBaseRoundScore: Boolean(baseRoundScore),
    hasOutcome: Boolean(outcome),
    winningBidLabel: resolveWinningBidLabel(state.bidding.winningBid),
    winningBidOwnerLabel: resolveWinningBidOwnerLabel(state.bidding.winningBid),
    teamARawPoints: baseRoundScore?.teamA.rawPoints ?? 0,
    teamBRawPoints: baseRoundScore?.teamB.rawPoints ?? 0,
    teamATricksWon: baseRoundScore?.teamA.tricksWon ?? 0,
    teamBTricksWon: baseRoundScore?.teamB.tricksWon ?? 0,
    teamADeclarationPoints: declarationsScore.teamA,
    teamBDeclarationPoints: declarationsScore.teamB,
    teamABelotePoints: beloteScore.teamA,
    teamBBelotePoints: beloteScore.teamB,
    teamASumPoints,
    teamBSumPoints,
    expectedTotalPoints: (baseRoundScore?.expectedTotalPoints ?? 0) + premiumPointsTotal,
    actualTotalPoints: (baseRoundScore?.actualTotalPoints ?? 0) + premiumPointsTotal,
    isComplete: baseRoundScore?.isComplete ?? false,
    isPointTotalValid:
      baseRoundScore
        ? (baseRoundScore.actualTotalPoints + premiumPointsTotal) ===
          (baseRoundScore.expectedTotalPoints + premiumPointsTotal)
        : false,
    lastTrickWinnerLabel: formatSeatLabel(baseRoundScore?.lastTrickWinner ?? null),
    bidderTeamLabel: formatTeamLabel(outcome?.bidderTeam ?? null),
    defenderTeamLabel: formatTeamLabel(outcome?.defenderTeam ?? null),
    bidderPoints: outcome?.bidderPoints ?? 0,
    defenderPoints: outcome?.defenderPoints ?? 0,
    winningTeamLabel: formatTeamLabel(outcome?.winningTeam ?? null),
    outcomeLabel: resolveOutcomeLabel(outcome?.outcome ?? 'unknown'),
    outcomeShortLabel: resolveOutcomeShortLabel(outcome?.outcome ?? 'unknown'),
    isInside: outcome?.isInside ?? false,
    isMade: outcome?.isMade ?? false,
    isTie: outcome?.isTie ?? false,
    officialRoundTeamA:
      officialRoundResult?.roundBreakdown.total.teamA ?? state.score.round.total.teamA,
    officialRoundTeamB:
      officialRoundResult?.roundBreakdown.total.teamB ?? state.score.round.total.teamB,
    matchTotalTeamA: state.score.match.teamA,
    matchTotalTeamB: state.score.match.teamB,
    carryOverTeamA: state.score.carryOver.teamA,
    carryOverTeamB: state.score.carryOver.teamB,
    hasDouble: state.bidding.winningBid?.doubled ?? false,
    hasRedouble: state.bidding.winningBid?.redoubled ?? false,
    counterMultiplier,
    countdownSeconds,
    autoAdvanceCountdownSeconds: countdownSeconds,
  }
}