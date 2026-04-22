import type { Seat, ServerRoom } from '../core/serverTypes.js'
import type { ClientBidAction } from '../protocol/messageTypes.js'
import { getRoomAuthoritativeGameState } from './getRoomAuthoritativeGameState.js'
import { getValidServerBidActions } from './getValidServerBidActions.js'
import { submitServerBidAction } from './submitServerBidAction.js'
import { syncRoomWithAuthoritativeState } from './syncRoomWithAuthoritativeState.js'

type SubmitHumanBidActionForRoomResult =
  | {
      ok: true
      room: ServerRoom
    }
  | {
      ok: false
      message: string
    }

function isBidActionAllowed(
  seat: Seat,
  room: ServerRoom,
  action: ClientBidAction,
): boolean {
  const state = getRoomAuthoritativeGameState(room)

  if (state === null || state.phase !== 'bidding') {
    return false
  }

  const validActions = getValidServerBidActions(seat, state.bidding.winningBid)

  if (action.type === 'pass') {
    return validActions.pass
  }

  if (action.type === 'suit') {
    return validActions.suits[action.suit]
  }

  if (action.type === 'no-trumps') {
    return validActions.noTrumps
  }

  if (action.type === 'all-trumps') {
    return validActions.allTrumps
  }

  if (action.type === 'double') {
    return validActions.double
  }

  if (action.type === 'redouble') {
    return validActions.redouble
  }

  return false
}

export function submitHumanBidActionForRoom(
  room: ServerRoom,
  seat: Seat,
  action: ClientBidAction,
): SubmitHumanBidActionForRoomResult {
  const state = getRoomAuthoritativeGameState(room)

  if (state === null) {
    return {
      ok: false,
      message: 'Authoritative game state was not found.',
    }
  }

  if (state.phase !== 'bidding') {
    return {
      ok: false,
      message: 'Наддаването не е активно.',
    }
  }

  if (state.bidding.currentSeat !== seat) {
    return {
      ok: false,
      message: 'Не е ред на този играч да обявява.',
    }
  }

  if (!isBidActionAllowed(seat, room, action)) {
    return {
      ok: false,
      message: 'Невалидна обява.',
    }
  }

  const nextState = submitServerBidAction(state, action)
  const nextRoom = syncRoomWithAuthoritativeState(room, nextState)

  return {
    ok: true,
    room: nextRoom,
  }
}