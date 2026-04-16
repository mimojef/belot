import { createHumanParticipant } from './createHumanParticipant.js'
import { findFirstOpenSeat } from './findFirstOpenSeat.js'
import { isRoomFull } from './isRoomFull.js'
import { seatParticipantInRoom } from './seatParticipantInRoom.js'
import type {
  ConnectionId,
  HumanRoomParticipant,
  PlayerId,
  PlayerIdentitySnapshot,
  Seat,
  ServerRoom,
} from './serverTypes.js'

type AddHumanToRoomOptions = {
  playerId?: PlayerId
  connectionId?: ConnectionId | null
  reconnectToken?: string | null
  identity?: Partial<PlayerIdentitySnapshot>
}

export type AddHumanToRoomResult = {
  room: ServerRoom
  seat: Seat
  participant: HumanRoomParticipant
}

export function addHumanToRoom(
  room: ServerRoom,
  options: AddHumanToRoomOptions = {},
): AddHumanToRoomResult {
  if (isRoomFull(room)) {
    throw new Error(`Room "${room.id}" is already full.`)
  }

  const seat = findFirstOpenSeat(room)

  if (seat === null) {
    throw new Error(`Room "${room.id}" has no open seat.`)
  }

  const participant = createHumanParticipant({
    playerId: options.playerId,
    connectionId: options.connectionId ?? null,
    reconnectToken: options.reconnectToken ?? null,
    identity: options.identity,
  })

  const nextRoom = seatParticipantInRoom(room, seat, participant)

  return {
    room: nextRoom,
    seat,
    participant,
  }
}