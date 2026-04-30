import type { Seat, ServerRoom } from '../core/serverTypes.js'
import { getRoomAuthoritativeGameState } from './getRoomAuthoritativeGameState.js'
import { syncRoomWithAuthoritativeState } from './syncRoomWithAuthoritativeState.js'
import {
  submitServerPlayCard,
  validateServerDeclarationKeysForPlay,
} from './submitServerPlayCard.js'

type SubmitHumanPlayCardForRoomResult =
  | { ok: true; room: ServerRoom }
  | { ok: false; message: string }

export function submitHumanPlayCardForRoom(
  room: ServerRoom,
  seat: Seat,
  cardId: string,
  declarationKeys: string[] = [],
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

  if (!hand.some((c) => c.id === cardId)) {
    return { ok: false, message: 'Картата не е намерена в ръката на играча.' }
  }

  const declarationValidation = validateServerDeclarationKeysForPlay(
    state,
    seat,
    declarationKeys,
  )

  if (!declarationValidation.ok) {
    return { ok: false, message: declarationValidation.message }
  }

  const nextState = submitServerPlayCard(state, seat, cardId, declarationKeys)
  const nextRoom = syncRoomWithAuthoritativeState(room, nextState)

  return { ok: true, room: nextRoom }
}
