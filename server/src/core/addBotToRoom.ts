import { createBotParticipant } from './createBotParticipant.js'
import { findFirstOpenSeat } from './findFirstOpenSeat.js'
import { isRoomFull } from './isRoomFull.js'
import { seatParticipantInRoom } from './seatParticipantInRoom.js'
import type {
  BotDifficulty,
  BotRoomParticipant,
  PlayerId,
  PlayerIdentitySnapshot,
  Seat,
  ServerRoom,
} from './serverTypes.js'

type AddBotToRoomOptions = {
  playerId?: PlayerId
  botCode?: string
  difficulty?: BotDifficulty
  identity?: Partial<PlayerIdentitySnapshot>
}

export type AddBotToRoomResult = {
  room: ServerRoom
  seat: Seat
  participant: BotRoomParticipant
}

export function addBotToRoom(
  room: ServerRoom,
  options: AddBotToRoomOptions = {},
): AddBotToRoomResult {
  if (isRoomFull(room)) {
    throw new Error(`Room "${room.id}" is already full.`)
  }

  const seat = findFirstOpenSeat(room)

  if (seat === null) {
    throw new Error(`Room "${room.id}" has no open seat.`)
  }

  const participant = createBotParticipant({
    playerId: options.playerId,
    botCode: options.botCode,
    difficulty: options.difficulty,
    identity: options.identity,
  })

  const nextRoom = seatParticipantInRoom(room, seat, participant)

  return {
    room: nextRoom,
    seat,
    participant,
  }
}