import type { RoomId, ServerRoom, ServerState } from './serverTypes.js'

export function getRoomById(
  serverState: ServerState,
  roomId: RoomId,
): ServerRoom | null {
  return serverState.rooms[roomId] ?? null
}