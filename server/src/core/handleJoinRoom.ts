import { addHumanToRoom } from './addHumanToRoom.js'
import { attachConnectionToRoomSeat } from './attachConnectionToRoomSeat.js'
import { createDisplayNameIdentityPatch } from './createDisplayNameIdentityPatch.js'
import { getConnectionById } from './getConnectionById.js'
import { getRoomById } from './getRoomById.js'
import { updateServerConnectionInState } from './updateServerConnectionInState.js'
import { updateServerRoomInState } from './updateServerRoomInState.js'
import type {
  ConnectionId,
  RoomId,
  Seat,
  ServerConnection,
  ServerRoom,
  ServerState,
} from './serverTypes.js'

export type HandleJoinRoomResult = {
  serverState: ServerState
  room: ServerRoom
  seat: Seat
  connection: ServerConnection
}

export function handleJoinRoom(
  serverState: ServerState,
  connectionId: ConnectionId,
  roomId: RoomId,
  displayName?: string,
): HandleJoinRoomResult {
  const connection = getConnectionById(serverState, connectionId)

  if (connection === null) {
    throw new Error(`Connection "${connectionId}" was not found.`)
  }

  if (connection.currentRoomId !== null) {
    throw new Error(
      `Connection "${connectionId}" is already attached to room "${connection.currentRoomId}".`,
    )
  }

  const room = getRoomById(serverState, roomId)

  if (room === null) {
    throw new Error(`Room "${roomId}" was not found.`)
  }

  const joinResult = addHumanToRoom(room, {
    playerId: connection.playerId ?? undefined,
    connectionId,
    identity: createDisplayNameIdentityPatch(displayName),
  })

  let nextServerState = updateServerRoomInState(
    serverState,
    room.id,
    joinResult.room,
  )

  const nextConnection = attachConnectionToRoomSeat(
    connection,
    connectionId,
    joinResult.room,
    joinResult.seat,
  )

  nextServerState = updateServerConnectionInState(
    nextServerState,
    connectionId,
    nextConnection,
  )

  return {
    serverState: nextServerState,
    room: joinResult.room,
    seat: joinResult.seat,
    connection: nextConnection,
  }
}