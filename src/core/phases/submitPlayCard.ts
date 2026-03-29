import type { Card, GameState, RoundScore, TrickPlay } from '../state/gameTypes'
import {
  getNextSeatCounterClockwise,
  getTeamBySeat,
} from '../state/createInitialState'
import { getValidCardsForSeat } from '../rules/getValidCardsForSeat'
import { getWinningTrickPlay } from '../rules/getWinningTrickPlay'
import { calculateBaseRoundScore } from '../rules/calculateBaseRoundScore'
import { calculateRoundOutcome } from '../rules/calculateRoundOutcome'
import { buildOfficialRoundScore } from '../rules/buildOfficialRoundScore'
import {
  buildBeloteScore,
  buildComparableDeclarationsScore,
  resolveDeclarations,
} from '../rules/declarationsRules'

function removeCardFromHand(hand: Card[], cardId: string): Card[] {
  return hand.filter((card) => card.id !== cardId)
}

function addRoundScore(current: RoundScore, added: RoundScore): RoundScore {
  return {
    teamA: current.teamA + added.teamA,
    teamB: current.teamB + added.teamB,
  }
}

function resolveScoringContract(
  winningBid: GameState['bidding']['winningBid']
): 'color' | 'all-trumps' | 'no-trumps' | null {
  if (!winningBid) {
    return null
  }

  if (winningBid.contract === 'suit') {
    return 'color'
  }

  if (winningBid.contract === 'all-trumps') {
    return 'all-trumps'
  }

  if (winningBid.contract === 'no-trumps') {
    return 'no-trumps'
  }

  return null
}

function resolveScoringTrumpSuit(
  winningBid: GameState['bidding']['winningBid']
): 'clubs' | 'diamonds' | 'hearts' | 'spades' | null {
  if (!winningBid) {
    return null
  }

  const rawTrumpSuit = winningBid.trumpSuit

  if (
    rawTrumpSuit === 'clubs' ||
    rawTrumpSuit === 'diamonds' ||
    rawTrumpSuit === 'hearts' ||
    rawTrumpSuit === 'spades'
  ) {
    return rawTrumpSuit
  }

  return null
}

function resolveBidderSeat(
  winningBid: GameState['bidding']['winningBid']
): 'bottom' | 'right' | 'top' | 'left' | null {
  if (!winningBid) {
    return null
  }

  return winningBid.seat
}

export function submitPlayCard(state: GameState, cardId: string): GameState {
  if (state.phase !== 'playing') {
    return state
  }

  const currentSeat = state.playing?.currentTurnSeat ?? state.currentTrick.currentSeat

  if (!currentSeat) {
    return state
  }

  const currentHand = state.hands[currentSeat] ?? []
  const selectedCard = currentHand.find((card) => card.id === cardId)

  if (!selectedCard) {
    return state
  }

  const validCards = getValidCardsForSeat(state, currentSeat)
  const isValidCard = validCards.some((card) => card.id === cardId)

  if (!isValidCard) {
    return state
  }

  const nextHands = {
    ...state.hands,
    [currentSeat]: removeCardFromHand(currentHand, cardId),
  }

  const nextPlay: TrickPlay = {
    seat: currentSeat,
    card: selectedCard,
  }

  const nextPlays = [...state.currentTrick.plays, nextPlay]
  const isTrickComplete = nextPlays.length === 4

  if (!isTrickComplete) {
    const nextCurrentSeat = getNextSeatCounterClockwise(currentSeat)

    const nextCurrentTrick = {
      ...state.currentTrick,
      currentSeat: nextCurrentSeat,
      plays: nextPlays,
    }

    return {
      ...state,
      hands: nextHands,
      currentTrick: nextCurrentTrick,
      playing: state.playing
        ? {
            ...state.playing,
            currentTurnSeat: nextCurrentSeat,
            currentTrick: nextCurrentTrick,
          }
        : state.playing,
    }
  }

  const winningPlay = getWinningTrickPlay(nextPlays, state.bidding.winningBid)

  if (!winningPlay) {
    return {
      ...state,
      hands: nextHands,
    }
  }

  const winnerSeat = winningPlay.seat
  const winnerTeam = getTeamBySeat(winnerSeat)
  const trickCards = nextPlays.map((play) => play.card)
  const completedTrickIndex = state.currentTrick.trickIndex

  const completedTrick = {
    trickIndex: completedTrickIndex,
    leaderSeat: state.currentTrick.leaderSeat ?? winnerSeat,
    plays: nextPlays,
    winnerSeat,
    winningTeam: winnerTeam,
  }

  const nextWonTricks = {
    ...state.wonTricks,
    [winnerTeam]: [...state.wonTricks[winnerTeam], trickCards],
  }

  const nextCompletedTricks = [...(state.playing?.completedTricks ?? []), completedTrick]

  const nextCurrentTrick = {
    leaderSeat: winnerSeat,
    currentSeat: winnerSeat,
    plays: [],
    winnerSeat: null,
    trickIndex: completedTrickIndex + 1,
  }

  const nextPlaying = state.playing
    ? {
        ...state.playing,
        currentTurnSeat: winnerSeat,
        currentTrick: nextCurrentTrick,
        completedTricks: nextCompletedTricks,
        lastCompletedTrickWinnerSeat: winnerSeat,
        lastCompletedTrickWinnerTeam: winnerTeam,
        wonTricksBySeat: {
          ...state.playing.wonTricksBySeat,
          [winnerSeat]: [...state.playing.wonTricksBySeat[winnerSeat], trickCards],
        },
        wonTricksByTeam: {
          ...state.playing.wonTricksByTeam,
          [winnerTeam]: [...state.playing.wonTricksByTeam[winnerTeam], trickCards],
        },
      }
    : state.playing

  const isRoundComplete = nextCompletedTricks.length === 8

  if (isRoundComplete) {
    const scoringContract = resolveScoringContract(state.bidding.winningBid)
    const scoringTrumpSuit = resolveScoringTrumpSuit(state.bidding.winningBid)
    const bidderSeat = resolveBidderSeat(state.bidding.winningBid)

    if (!scoringContract) {
      return {
        ...state,
        hands: nextHands,
        currentTrick: nextCurrentTrick,
        wonTricks: nextWonTricks,
        playing: nextPlaying,
      }
    }

    const baseRoundScore = calculateBaseRoundScore({
      tricks: nextCompletedTricks.map((trick) => ({
        winner: trick.winnerSeat,
        cards: trick.plays.map((play) => ({
          suit: play.card.suit,
          rank: play.card.rank,
        })),
      })),
      contract: scoringContract,
      trumpSuit: scoringTrumpSuit,
    })

    const declarationResolution = resolveDeclarations(state.declarations)
    const resolvedDeclarations = declarationResolution.resolvedDeclarations
    const declarationsScore = buildComparableDeclarationsScore(resolvedDeclarations)
    const beloteScore = buildBeloteScore(resolvedDeclarations)

    const roundOutcome = calculateRoundOutcome({
      baseRoundScore,
      bidderSeat,
      declarationsTeamA: declarationsScore.teamA,
      declarationsTeamB: declarationsScore.teamB,
      beloteTeamA: beloteScore.teamA,
      beloteTeamB: beloteScore.teamB,
    })

    const officialRoundScore = buildOfficialRoundScore({
      baseRoundScore,
      roundOutcome,
      currentCarryOver: state.score.carryOver,
      declarationsScore,
      beloteScore,
    })

    return {
      ...state,
      phase: 'scoring',
      hands: nextHands,
      declarations: resolvedDeclarations,
      currentTrick: nextCurrentTrick,
      wonTricks: nextWonTricks,
      playing: nextPlaying,
      scoring: {
        baseRoundScore,
        roundOutcome,
      },
      score: {
        ...state.score,
        round: officialRoundScore.roundBreakdown,
        match: addRoundScore(state.score.match, officialRoundScore.roundBreakdown.total),
        carryOver: officialRoundScore.nextCarryOver,
      },
    }
  }

  return {
    ...state,
    hands: nextHands,
    currentTrick: nextCurrentTrick,
    wonTricks: nextWonTricks,
    playing: nextPlaying,
  }
}