import type { WebSocket } from 'ws'
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

    if (
      participant === null ||
      participant.kind !== 'human' ||
      !participant.isConnected ||
      participant.connectionId === null
    ) {
      continue
    }

    const socket = socketRegistry.get(participant.connectionId)

    if (!socket) {
      continue
    }

    sendJsonMessage(socket, createRoomSnapshotMessage(room, seat))
  }
}
