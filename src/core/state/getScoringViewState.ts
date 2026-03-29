import type { GameState, BaseRoundScoreResult, RoundOutcomeResult, RoundScore } from './gameTypes'
import { buildBeloteScore, buildComparableDeclarationsScore } from '../rules/declarationsRules'
import { calculateRoundOutcome } from '../rules/calculateRoundOutcome'
import { buildOfficialRoundScore } from '../rules/buildOfficialRoundScore'

type BaseRoundScore = BaseRoundScoreResult
type Outcome = RoundOutcomeResult

export type ScoringViewState = {
  isVisible: boolean
  hasBaseRoundScore: boolean
  hasOutcome: boolean
  winningBidLabel: string
  teamARawPoints: number
  teamBRawPoints: number
  teamATricksWon: number
  teamBTricksWon: number
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
  isInside: boolean
  isMade: boolean
  isTie: boolean
  officialRoundTeamA: number
  officialRoundTeamB: number
  matchTotalTeamA: number
  matchTotalTeamB: number
  carryOverTeamA: number
  carryOverTeamB: number
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

  const officialRoundResult =
    baseRoundScore && outcome
      ? buildOfficialRoundScore({
          baseRoundScore,
          roundOutcome: outcome,
          currentCarryOver: state.score.carryOver,
          declarationsScore,
          beloteScore,
        })
      : null

  const premiumPointsTotal =
    declarationsScore.teamA +
    declarationsScore.teamB +
    beloteScore.teamA +
    beloteScore.teamB

  return {
    isVisible: state.phase === 'scoring' || state.phase === 'summary',
    hasBaseRoundScore: Boolean(baseRoundScore),
    hasOutcome: Boolean(outcome),
    winningBidLabel: resolveWinningBidLabel(state.bidding.winningBid),
    teamARawPoints: baseRoundScore?.teamA.rawPoints ?? 0,
    teamBRawPoints: baseRoundScore?.teamB.rawPoints ?? 0,
    teamATricksWon: baseRoundScore?.teamA.tricksWon ?? 0,
    teamBTricksWon: baseRoundScore?.teamB.tricksWon ?? 0,
    expectedTotalPoints: (baseRoundScore?.expectedTotalPoints ?? 0) + premiumPointsTotal,
    actualTotalPoints: (baseRoundScore?.actualTotalPoints ?? 0) + premiumPointsTotal,
    isComplete: baseRoundScore?.isComplete ?? false,
    isPointTotalValid:
      baseRoundScore ? (baseRoundScore.actualTotalPoints + premiumPointsTotal) ===
        (baseRoundScore.expectedTotalPoints + premiumPointsTotal) : false,
    lastTrickWinnerLabel: formatSeatLabel(baseRoundScore?.lastTrickWinner ?? null),
    bidderTeamLabel: formatTeamLabel(outcome?.bidderTeam ?? null),
    defenderTeamLabel: formatTeamLabel(outcome?.defenderTeam ?? null),
    bidderPoints: outcome?.bidderPoints ?? 0,
    defenderPoints: outcome?.defenderPoints ?? 0,
    winningTeamLabel: formatTeamLabel(outcome?.winningTeam ?? null),
    outcomeLabel: resolveOutcomeLabel(outcome?.outcome ?? 'unknown'),
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
  }
}