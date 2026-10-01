import type { Seat, ServerRoom } from '../core/serverTypes.js'
import { getRoomAuthoritativeGameState } from './getRoomAuthoritativeGameState.js'
import { syncRoomWithAuthoritativeState } from './syncRoomWithAuthoritativeState.js'
import { submitServerSweepDecision } from './submitServerSweepDecision.js'

type SubmitHumanSweepDecisionForRoomResult =
  | { ok: true; room: ServerRoom }
  | { ok: false; message: string }

export function submitHumanSweepDecisionForRoom(
  room: ServerRoom,
  seat: Seat,
  decision: 'accept' | 'decline',
): SubmitHumanSweepDecisionForRoomResult {
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

  if (playing.sweepOffer === null) {
    return { ok: false, message: 'Няма чакаща оферта "Долу картите".' }
  }

  if (playing.sweepOffer.seat !== seat) {
    return { ok: false, message: 'Не е ред на този играч да реши "Долу картите".' }
  }

  const nextState = submitServerSweepDecision(state, seat, decision)

  if (nextState === state) {
    return { ok: false, message: 'Решението за "Долу картите" вече е обработено или е невалидно.' }
  }

  const nextRoom = syncRoomWithAuthoritativeState(room, nextState)

  return { ok: true, room: nextRoom }
}
