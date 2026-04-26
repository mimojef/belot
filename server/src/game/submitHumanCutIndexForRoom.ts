import type { Seat, ServerRoom } from '../core/serverTypes.js'
import { advanceExpiredServerCuttingState } from './advanceExpiredServerCuttingState.js'
import { getRoomAuthoritativeGameState } from './getRoomAuthoritativeGameState.js'
import { selectServerCutIndex } from './selectServerCutIndex.js'
import { syncRoomWithAuthoritativeState } from './syncRoomWithAuthoritativeState.js'

type SubmitHumanCutIndexForRoomResult =
  | {
      ok: true
      room: ServerRoom
    }
  | {
      ok: false
      message: string
    }

export function submitHumanCutIndexForRoom(
  room: ServerRoom,
  seat: Seat,
  cutIndex: number,
): SubmitHumanCutIndexForRoomResult {
  const state = getRoomAuthoritativeGameState(room)

  if (state === null) {
    return {
      ok: false,
      message: 'Authoritative game state was not found.',
    }
  }

  if (state.phase !== 'cutting') {
    return {
      ok: false,
      message: 'Cutting phase is not active.',
    }
  }

  if (state.round.cutterSeat !== seat) {
    return {
      ok: false,
      message: 'It is not this seat\'s turn to cut.',
    }
  }

  if (state.round.selectedCutIndex !== null) {
    return {
      ok: false,
      message: 'A cut index has already been selected.',
    }
  }

  if (!Number.isInteger(cutIndex) || cutIndex < 1 || cutIndex >= state.deck.length) {
    return {
      ok: false,
      message: 'Invalid cut index.',
    }
  }

  const selectedState = selectServerCutIndex(state, cutIndex)
  const eventAt = Date.now()
  const resolvedCut = advanceExpiredServerCuttingState(selectedState, eventAt)
  const nextRoom = syncRoomWithAuthoritativeState(room, resolvedCut.state, eventAt)

  return {
    ok: true,
    room: nextRoom,
  }
}
