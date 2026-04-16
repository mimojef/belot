import { attachConnectionToRoomSeat } from './attachConnectionToRoomSeat.js'
import { createDisplayNameIdentityPatch } from './createDisplayNameIdentityPatch.js'
import { createRoomWithHumanHost } from './createRoomWithHumanHost.js'
import { getConnectionById } from './getConnectionById.js'
import { updateServerConnectionInState } from './updateServerConnectionInState.js'
import { upsertServerRoom } from './upsertServerRoom.js'
import type {
  ConnectionId,
  Seat,
  ServerConnection,
  ServerRoom,
  ServerState,
} from './serverTypes.js'

export type HandleCreateRoomResult = {
  serverState: ServerState
  room: ServerRoom
  seat: Seat
  connection: ServerConnection
}

export function handleCreateRoom(
  serverState: ServerState,
  connectionId: ConnectionId,
  displayName?: string,
): HandleCreateRoomResult {
  const connection = getConnectionById(serverState, connectionId)

  if (connection === null) {
    throw new Error(`Connection "${connectionId}" was not found.`)
  }

  if (connection.currentRoomId !== null) {
    throw new Error(
      `Connection "${connectionId}" is already attached to room "${connection.currentRoomId}".`,
    )
  }

  const roomResult = createRoomWithHumanHost({
    playerId: connection.playerId ?? undefined,
    connectionId,
    identity: createDisplayNameIdentityPatch(displayName),
  })

  let nextServerState = upsertServerRoom(serverState, roomResult.room)

  const nextConnection = attachConnectionToRoomSeat(
    connection,
    connectionId,
    roomResult.room,
    roomResult.seat,
  )

  nextServerState = updateServerConnectionInState(
    nextServerState,
    connectionId,
    nextConnection,
  )

  return {
    serverState: nextServerState,
    room: roomResult.room,
    seat: roomResult.seat,
    connection: nextConnection,
  }
}