import type { RoomId, ServerRoom, ServerState } from './serverTypes.js'

export function updateServerRoomInState(
  serverState: ServerState,
  roomId: RoomId,
  room: ServerRoom,
): ServerState {
  if (!(roomId in serverState.rooms)) {
    throw new Error(`Room "${roomId}" does not exist in server state.`)
  }

  if (room.id !== roomId) {
    throw new Error(`Room id mismatch. Expected "${roomId}", got "${room.id}".`)
  }

  return {
    ...serverState,
    rooms: {
      ...serverState.rooms,
      [roomId]: room,
    },
  }
}