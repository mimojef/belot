import type { ConnectionId, ServerRoom, ServerState } from './serverTypes.js'
import { findHumanParticipantByConnectionId } from './findHumanParticipantByConnectionId.js'

export function findRoomByConnectionId(
  serverState: ServerState,
  connectionId: ConnectionId,
): ServerRoom | null {
  for (const room of Object.values(serverState.rooms)) {
    const participant = findHumanParticipantByConnectionId(room, connectionId)

    if (participant !== null) {
      return room
    }
  }

  return null
}