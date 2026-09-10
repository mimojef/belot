import { WebSocket } from 'ws'
import { sendJsonMessage } from './sendJsonMessage.js'
import {
  SERVER_SEAT_ORDER,
  type ConnectionId,
  type ServerRoom,
} from './serverTypes.js'

/**
 * Праща ЕДИН споделен payload до всички свързани human места в стаята.
 *
 * За разлика от broadcastRoomSnapshots (който строи ПЕР-SEAT персонализиран
 * snapshot), тук съдържанието е идентично за всички получатели — ползва се за
 * room-wide събития без per-seat тайни (table gift broadcast, виж
 * TableGiftItemSentMessage). Итерационната/skip логиката е огледална на
 * broadcastRoomSnapshots: ботове, празни места, невързани участници и
 * незаписващи сокети се пропускат тихо.
 *
 * Връща броя реално изпратени съобщения (диагностика/тестове).
 */
export function broadcastToRoomConnections(
  room: ServerRoom,
  socketRegistry: Map<ConnectionId, WebSocket>,
  payload: unknown,
): number {
  let sentCount = 0

  for (const seat of SERVER_SEAT_ORDER) {
    const participant = room.seats[seat].participant

    if (participant === null || participant.kind !== 'human') {
      continue
    }

    if (!participant.isConnected || participant.connectionId === null) {
      continue
    }

    const socket = socketRegistry.get(participant.connectionId)

    if (!socket || socket.readyState !== WebSocket.OPEN) {
      continue
    }

    try {
      sendJsonMessage(socket, payload)
      sentCount += 1
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(
        `[room-broadcast] send failed room=${room.id} connection=${participant.connectionId}: ${message}`,
      )
    }
  }

  return sentCount
}
