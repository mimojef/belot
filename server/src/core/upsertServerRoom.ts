import type { ServerRoom, ServerState } from './serverTypes.js'

export function upsertServerRoom(
  serverState: ServerState,
  room: ServerRoom,
): ServerState {
  return {
    ...serverState,
    rooms: {
      ...serverState.rooms,
      [room.id]: room,
    },
  }
}