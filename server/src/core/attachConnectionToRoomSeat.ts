import type {
  ConnectionId,
  Seat,
  ServerConnection,
  ServerRoom,
} from './serverTypes.js'

export function attachConnectionToRoomSeat(
  connection: ServerConnection,
  connectionId: ConnectionId,
  room: ServerRoom,
  seat: Seat,
): ServerConnection {
  if (connection.id !== connectionId) {
    throw new Error(`Connection id mismatch. Expected "${connection.id}", got "${connectionId}".`)
  }

  const participant = room.seats[seat].participant

  if (participant === null) {
    throw new Error(`Seat "${seat}" in room "${room.id}" is empty.`)
  }

  if (participant.kind !== 'human') {
    throw new Error(`Seat "${seat}" in room "${room.id}" is not occupied by a human participant.`)
  }

  return {
    ...connection,
    status: 'connected',
    lastSeenAt: Date.now(),
    currentRoomId: room.id,
    currentSeat: seat,
    playerId: participant.playerId,
    profileId: participant.identity.profileId,
  }
}