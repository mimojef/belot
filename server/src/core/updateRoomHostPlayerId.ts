import { SERVER_SEAT_ORDER, type ServerRoom } from './serverTypes.js'

function findNextHostPlayerId(room: ServerRoom): string | null {
  for (const seat of SERVER_SEAT_ORDER) {
    const participant = room.seats[seat].participant

    if (participant !== null && participant.kind === 'human') {
      return participant.playerId
    }
  }

  return null
}

export function updateRoomHostPlayerId(room: ServerRoom): ServerRoom {
  const nextHostPlayerId = findNextHostPlayerId(room)

  if (room.hostPlayerId === nextHostPlayerId) {
    return room
  }

  return {
    ...room,
    updatedAt: Date.now(),
    hostPlayerId: nextHostPlayerId,
  }
}