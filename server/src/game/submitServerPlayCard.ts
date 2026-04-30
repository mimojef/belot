import type { Seat } from '../core/serverTypes.js'
import type {
  ServerAuthoritativeGameState,
  ServerPlayingState,
  ServerTrickPlay,
} from './serverGameTypes.js'
import { getNextSeat } from './serverPhaseHelpers.js'
import { getTeamBySeat } from './serverStateHelpers.js'
import { getServerTrickWinner } from './getServerTrickWinner.js'
import { getServerValidPlayCards } from './getServerValidPlayCards.js'
import {
  clearServerTimerState,
  createServerPlayingTimerState,
} from './serverTimerStateHelpers.js'

const TRICKS_PER_ROUND = 8

function applyTrickCompletion(
  state: ServerAuthoritativeGameState,
  playing: ServerPlayingState,
  completedPlays: ServerTrickPlay[],
): ServerAuthoritativeGameState {
  const winningPlay = getServerTrickWinner(completedPlays, state.bidding.winningBid)

  if (!winningPlay) {
    return {
      ...state,
      playing: {
        ...playing,
        currentTurnSeat: null,
        currentTrick: {
          ...playing.currentTrick,
          plays: completedPlays,
          currentSeat: null,
        },
      },
      timer: clearServerTimerState(),
    }
  }

  const winnerSeat = winningPlay.seat
  const winnerTeam = getTeamBySeat(winnerSeat)
  const trickCards = completedPlays.map((p) => p.card)
  const trickIndex = playing.currentTrick.trickIndex

  const completedTrick = {
    trickIndex,
    leaderSeat: playing.currentTrick.leaderSeat ?? winnerSeat,
    plays: completedPlays,
    winnerSeat,
    winningTeam: winnerTeam,
  }

  const nextCompletedTricks = [...playing.completedTricks, completedTrick]
  const isRoundComplete = nextCompletedTricks.length >= TRICKS_PER_ROUND

  const nextPlaying: ServerPlayingState = {
    ...playing,
    currentTurnSeat: isRoundComplete ? null : winnerSeat,
    completedTricks: nextCompletedTricks,
    lastCompletedTrickWinnerSeat: winnerSeat,
    lastCompletedTrickWinnerTeam: winnerTeam,
    currentTrick: {
      leaderSeat: winnerSeat,
      currentSeat: isRoundComplete ? null : winnerSeat,
      plays: [],
      winnerSeat: null,
      trickIndex: trickIndex + 1,
    },
    wonTricksBySeat: {
      ...playing.wonTricksBySeat,
      [winnerSeat]: [...playing.wonTricksBySeat[winnerSeat], trickCards],
    },
    wonTricksByTeam: {
      ...playing.wonTricksByTeam,
      [winnerTeam]: [...playing.wonTricksByTeam[winnerTeam], trickCards],
    },
  }

  if (isRoundComplete) {
    return {
      ...state,
      phase: 'playing',
      phaseEnteredAt: Date.now(),
      playing: nextPlaying,
      timer: clearServerTimerState(),
    }
  }

  const nextState: ServerAuthoritativeGameState = {
    ...state,
    playing: nextPlaying,
  }

  return {
    ...nextState,
    timer: createServerPlayingTimerState(nextState, winnerSeat),
  }
}

export function submitServerPlayCard(
  state: ServerAuthoritativeGameState,
  seat: Seat,
  cardId: string,
): ServerAuthoritativeGameState {
  const playing = state.playing

  if (playing === null || !playing.hasStarted) {
    return state
  }

  if (playing.currentTurnSeat !== seat) {
    return state
  }

  const hand = state.hands[seat]
  const cardIndex = hand.findIndex((c) => c.id === cardId)

  if (cardIndex === -1) {
    return state
  }

  const card = hand[cardIndex]

  const validCards = getServerValidPlayCards(state, seat)
  const isValidCard = validCards.some((c) => c.id === cardId)

  if (!isValidCard) {
    return state
  }
  const nextHand = hand.filter((_, i) => i !== cardIndex)

  const updatedPlays = [...playing.currentTrick.plays, { seat, card }]
  const trickComplete = updatedPlays.length >= 4

  const stateWithCard: ServerAuthoritativeGameState = {
    ...state,
    hands: { ...state.hands, [seat]: nextHand },
  }

  if (trickComplete) {
    return applyTrickCompletion(stateWithCard, playing, updatedPlays)
  }

  const nextSeat = getNextSeat(seat)

  return {
    ...stateWithCard,
    playing: {
      ...playing,
      currentTurnSeat: nextSeat,
      currentTrick: {
        ...playing.currentTrick,
        plays: updatedPlays,
        currentSeat: nextSeat,
      },
    },
    timer: createServerPlayingTimerState(stateWithCard, nextSeat),
  }
}
