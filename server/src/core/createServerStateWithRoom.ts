import { createInitialServerState } from './createInitialServerState.js'
import {
  createRoomWithHumanHost,
  type CreateRoomWithHumanHostResult,
} from './createRoomWithHumanHost.js'
import type {
  ConnectionId,
  PlayerId,
  PlayerIdentitySnapshot,
  RoomId,
  ServerRoomConfig,
  ServerState,
} from './serverTypes.js'

type CreateServerStateWithRoomOptions = {
  roomId?: RoomId
  playerId?: PlayerId
  connectionId?: ConnectionId | null
  reconnectToken?: string | null
  identity?: Partial<PlayerIdentitySnapshot>
  config?: Partial<ServerRoomConfig>
}

export type CreateServerStateWithRoomResult = CreateRoomWithHumanHostResult & {
  serverState: ServerState
}

export function createServerStateWithRoom(
  options: CreateServerStateWithRoomOptions = {},
): CreateServerStateWithRoomResult {
  const serverState = createInitialServerState()

  const roomResult = createRoomWithHumanHost({
    roomId: options.roomId,
    playerId: options.playerId,
    connectionId: options.connectionId ?? null,
    reconnectToken: options.reconnectToken ?? null,
    identity: options.identity,
    config: options.config,
  })

  const nextServerState: ServerState = {
    ...serverState,
    rooms: {
      ...serverState.rooms,
      [roomResult.room.id]: roomResult.room,
    },
  }

  return {
    serverState: nextServerState,
    room: roomResult.room,
    seat: roomResult.seat,
    hostParticipant: roomResult.hostParticipant,
  }
}