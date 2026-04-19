import { createBotParticipant } from './createBotParticipant.js'
import { findFirstOpenSeat } from './findFirstOpenSeat.js'
import { isRoomFull } from './isRoomFull.js'
import { seatParticipantInRoom } from './seatParticipantInRoom.js'
import type {
  BotBehaviorPreset,
  BotDifficulty,
  BotLogicSource,
  BotRoomParticipant,
  PlayerId,
  PlayerIdentitySnapshot,
  ProfileId,
  Seat,
  ServerRoom,
} from './serverTypes.js'

type AddBotToRoomOptions = {
  playerId?: PlayerId
  botProfileId?: ProfileId
  botCode?: string
  difficulty?: BotDifficulty
  behaviorPreset?: BotBehaviorPreset
  logicSource?: BotLogicSource
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
    botProfileId: options.botProfileId,
    botCode: options.botCode,
    difficulty: options.difficulty,
    behaviorPreset: options.behaviorPreset,
    logicSource: options.logicSource,
    identity: options.identity,
  })

  const nextRoom = seatParticipantInRoom(room, seat, participant)

  return {
    room: nextRoom,
    seat,
    participant,
  }
}