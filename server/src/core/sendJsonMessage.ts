import type { WebSocket } from 'ws'

export function sendJsonMessage<T>(socket: WebSocket, payload: T): void {
  socket.send(JSON.stringify(payload))
}
