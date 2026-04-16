import { addHumanToRoom } from './addHumanToRoom.js'
import { createServerRoom } from './createServerRoom.js'
import { updateRoomHostPlayerId } from './updateRoomHostPlayerId.js'
import type {
  ConnectionId,
  HumanRoomParticipant,
  PlayerId,
  PlayerIdentitySnapshot,
  RoomId,
  Seat,
  ServerRoom,
  ServerRoomConfig,
} from './serverTypes.js'

type CreateRoomWithHumanHostOptions = {
  roomId?: RoomId
  playerId?: PlayerId
  connectionId?: ConnectionId | null
  reconnectToken?: string | null
  identity?: Partial<PlayerIdentitySnapshot>
  config?: Partial<ServerRoomConfig>
}

export type CreateRoomWithHumanHostResult = {
  room: ServerRoom
  seat: Seat
  hostParticipant: HumanRoomParticipant
}

export function createRoomWithHumanHost(
  options: CreateRoomWithHumanHostOptions = {},
): CreateRoomWithHumanHostResult {
  const room = createServerRoom({
    roomId: options.roomId,
    config: options.config,
  })

  const addHumanResult = addHumanToRoom(room, {
    playerId: options.playerId,
    connectionId: options.connectionId ?? null,
    reconnectToken: options.reconnectToken ?? null,
    identity: options.identity,
  })

  const nextRoom = updateRoomHostPlayerId(addHumanResult.room)

  return {
    room: nextRoom,
    seat: addHumanResult.seat,
    hostParticipant: addHumanResult.participant,
  }
}