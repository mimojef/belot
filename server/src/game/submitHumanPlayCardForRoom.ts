import type { Seat, ServerRoom } from '../core/serverTypes.js'
import { getRoomAuthoritativeGameState } from './getRoomAuthoritativeGameState.js'
import { syncRoomWithAuthoritativeState } from './syncRoomWithAuthoritativeState.js'
import { getNextSeat } from './serverPhaseHelpers.js'
import { getTeamBySeat } from './serverStateHelpers.js'
import { getServerTrickWinner } from './getServerTrickWinner.js'
import { runServerPhaseTransition } from './runServerPhaseTransition.js'
import {
  clearServerTimerState,
  createServerPlayingTimerState,
} from './serverTimerStateHelpers.js'
import type {
  ServerAuthoritativeGameState,
  ServerPlayingState,
  ServerTrickPlay,
} from './serverGameTypes.js'

type SubmitHumanPlayCardForRoomResult =
  | { ok: true; room: ServerRoom }
  | { ok: false; message: string }

const TRICKS_PER_ROUND = 8

function applyTrickCompletion(
  state: ServerAuthoritativeGameState,
  playing: ServerPlayingState,
  completedPlays: ServerTrickPlay[],
): ServerAuthoritativeGameState {
  const winningBid = state.bidding.winningBid
  const winningPlay = getServerTrickWinner(completedPlays, winningBid)

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

  const nextPlayingBase: ServerPlayingState = {
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
    const stateBeforeTransition: ServerAuthoritativeGameState = {
      ...state,
      playing: nextPlayingBase,
      timer: clearServerTimerState(),
    }
    return runServerPhaseTransition(stateBeforeTransition)
  }

  const nextState: ServerAuthoritativeGameState = {
    ...state,
    playing: nextPlayingBase,
  }

  return {
    ...nextState,
    timer: createServerPlayingTimerState(nextState, winnerSeat),
  }
}

export function submitHumanPlayCardForRoom(
  room: ServerRoom,
  seat: Seat,
  cardId: string,
): SubmitHumanPlayCardForRoomResult {
  const state = getRoomAuthoritativeGameState(room)

  if (state === null) {
    return { ok: false, message: 'Authoritative game state was not found.' }
  }

  if (state.phase !== 'playing') {
    return { ok: false, message: 'Играта не е в playing фаза.' }
  }

  const playing = state.playing

  if (playing === null || !playing.hasStarted) {
    return { ok: false, message: 'Playing state не е инициализиран.' }
  }

  if (playing.currentTurnSeat !== seat) {
    return { ok: false, message: 'Не е ред на този играч да играе.' }
  }

  const hand = state.hands[seat]
  const cardIndex = hand.findIndex((c) => c.id === cardId)

  if (cardIndex === -1) {
    return { ok: false, message: 'Картата не е намерена в ръката на играча.' }
  }

  const card = hand[cardIndex]
  const nextHand = hand.filter((_, i) => i !== cardIndex)

  const updatedPlays = [...playing.currentTrick.plays, { seat, card }]
  const trickComplete = updatedPlays.length >= 4

  const stateWithRemovedCard: ServerAuthoritativeGameState = {
    ...state,
    hands: { ...state.hands, [seat]: nextHand },
    playing,
  }

  let nextState: ServerAuthoritativeGameState

  if (trickComplete) {
    nextState = applyTrickCompletion(stateWithRemovedCard, playing, updatedPlays)
  } else {
    const nextSeat = getNextSeat(seat)
    nextState = {
      ...stateWithRemovedCard,
      playing: {
        ...playing,
        currentTurnSeat: nextSeat,
        currentTrick: {
          ...playing.currentTrick,
          plays: updatedPlays,
          currentSeat: nextSeat,
        },
      },
      timer: createServerPlayingTimerState(stateWithRemovedCard, nextSeat),
    }
  }

  const nextRoom = syncRoomWithAuthoritativeState(room, nextState)

  return { ok: true, room: nextRoom }
}
