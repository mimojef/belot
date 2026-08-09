import { WebSocket } from 'ws'
import { createRoomSnapshotMessage } from '../protocol/createRoomSnapshotMessage.js'
import { sendJsonMessage } from './sendJsonMessage.js'
import {
  SERVER_SEAT_ORDER,
  type ConnectionId,
  type ServerRoom,
} from './serverTypes.js'

export function broadcastRoomSnapshots(
  room: ServerRoom,
  socketRegistry: Map<ConnectionId, WebSocket>,
): void {
  for (const seat of SERVER_SEAT_ORDER) {
    const participant = room.seats[seat].participant

    if (participant === null || participant.kind !== 'human') {
      continue
    }

    if (!participant.isConnected || participant.connectionId === null) {
      // Диагностика: room-level participant.isConnected е десинхронизирано
      // от connection-level status (виж submit_bid_action handler-а) —
      // snapshot никога не стига до този играч, без никаква грешка другаде.
      // Не логваме profileId/displayName — само roomId/seat/технически флаг.
      console.warn(
        `[room-snapshot] skip room=${room.id} seat=${seat}: participant not marked connected (isConnected=${participant.isConnected}, hasConnectionId=${participant.connectionId !== null})`,
      )
      continue
    }

    const socket = socketRegistry.get(participant.connectionId)

    if (!socket || socket.readyState !== WebSocket.OPEN) {
      console.warn(
        `[room-snapshot] skip room=${room.id} seat=${seat}: socket not sendable (found=${socket !== undefined}, readyState=${socket?.readyState ?? 'n/a'})`,
      )
      continue
    }

    try {
      sendJsonMessage(socket, createRoomSnapshotMessage(room, seat))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(
        `[room-snapshot] broadcast failed room=${room.id} connection=${participant.connectionId}: ${message}`,
      )
    }
  }
}
