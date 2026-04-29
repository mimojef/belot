import type { Seat, ServerRoom } from '../core/serverTypes.js'
import { getRoomAuthoritativeGameState } from './getRoomAuthoritativeGameState.js'
import {
  createServerBiddingTimerState,
  createServerCuttingTimerState,
  createServerPlayingTimerState,
} from './serverTimerStateHelpers.js'
import type { ServerAuthoritativeGameState } from './serverGameTypes.js'
import { syncRoomWithAuthoritativeState } from './syncRoomWithAuthoritativeState.js'

type ResumeHumanControlForRoomResult =
  | { ok: true; room: ServerRoom }
  | { ok: false; message: string }

function refreshActiveHumanTimer(
  state: ServerAuthoritativeGameState,
  seat: Seat,
): ServerAuthoritativeGameState {
  if (
    state.phase === 'cutting' &&
    state.round.cutterSeat === seat &&
    state.round.selectedCutIndex === null
  ) {
    return {
      ...state,
      timer: createServerCuttingTimerState(state, seat),
    }
  }

  if (
    state.phase === 'bidding' &&
    !state.bidding.hasEnded &&
    state.bidding.currentSeat === seat
  ) {
    return {
      ...state,
      timer: createServerBiddingTimerState(state, seat),
    }
  }

  if (
    state.phase === 'playing' &&
    state.playing?.hasStarted &&
    state.playing.currentTurnSeat === seat
  ) {
    return {
      ...state,
      timer: createServerPlayingTimerState(state, seat),
    }
  }

  return state
}

export function resumeHumanControlForRoom(
  room: ServerRoom,
  seat: Seat,
): ResumeHumanControlForRoomResult {
  const state = getRoomAuthoritativeGameState(room)

  if (state === null) {
    return { ok: false, message: 'Authoritative game state was not found.' }
  }

  const player = state.players[seat]

  if (!player || player.mode !== 'human') {
    return { ok: false, message: 'Human player was not found for this seat.' }
  }

  const stateWithHumanControl: ServerAuthoritativeGameState = {
    ...state,
    players: {
      ...state.players,
      [seat]: {
        ...player,
        controlledByBot: false,
      },
    },
  }

  const nextState = refreshActiveHumanTimer(stateWithHumanControl, seat)
  const nextRoom = syncRoomWithAuthoritativeState(room, nextState)

  return { ok: true, room: nextRoom }
}
