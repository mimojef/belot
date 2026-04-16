import { findHumanParticipantByConnectionId } from './findHumanParticipantByConnectionId.js'
import { findParticipantSeat } from './findParticipantSeat.js'
import { findRoomByConnectionId } from './findRoomByConnectionId.js'
import { getConnectionById } from './getConnectionById.js'
import { markConnectionDisconnected } from './markConnectionDisconnected.js'
import { markHumanParticipantDisconnected } from './markHumanParticipantDisconnected.js'
import { updateHumanParticipantInRoom } from './updateHumanParticipantInRoom.js'
import { updateServerConnectionInState } from './updateServerConnectionInState.js'
import { updateServerRoomInState } from './updateServerRoomInState.js'
import type {
  ConnectionId,
  ServerConnection,
  ServerRoom,
  ServerState,
} from './serverTypes.js'

export type HandleDisconnectResult = {
  serverState: ServerState
  connection: ServerConnection
  room: ServerRoom | null
}

export function handleDisconnect(
  serverState: ServerState,
  connectionId: ConnectionId,
): HandleDisconnectResult {
  const connection = getConnectionById(serverState, connectionId)

  if (connection === null) {
    throw new Error(`Connection "${connectionId}" was not found.`)
  }

  const disconnectedConnection = markConnectionDisconnected(connection, connectionId)
  let nextServerState = updateServerConnectionInState(
    serverState,
    connectionId,
    disconnectedConnection,
  )

  const room = findRoomByConnectionId(serverState, connectionId)

  if (room === null) {
    return {
      serverState: nextServerState,
      connection: disconnectedConnection,
      room: null,
    }
  }

  const participant = findHumanParticipantByConnectionId(room, connectionId)

  if (participant === null) {
    return {
      serverState: nextServerState,
      connection: disconnectedConnection,
      room,
    }
  }

  const seat = findParticipantSeat(room, participant.playerId)

  if (seat === null) {
    throw new Error(
      `Could not find seat for participant "${participant.playerId}" in room "${room.id}".`,
    )
  }

  const disconnectedParticipant = markHumanParticipantDisconnected(
    participant,
    connectionId,
  )

  const nextRoom = updateHumanParticipantInRoom(room, seat, disconnectedParticipant)

  nextServerState = updateServerRoomInState(nextServerState, room.id, nextRoom)

  return {
    serverState: nextServerState,
    connection: disconnectedConnection,
    room: nextRoom,
  }
}