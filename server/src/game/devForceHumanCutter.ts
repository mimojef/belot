import {
  SERVER_SEAT_ORDER,
  type Seat,
  type ServerRoom,
} from '../core/serverTypes.js'
import type { ServerAuthoritativeGameState } from './serverGameTypes.js'

function isDevForceHumanCutterEnabled(): boolean {
  return (
    process.env.NODE_ENV !== 'production' &&
    process.env.BELOT_DEV_FORCE_HUMAN_CUTTER === '1'
  )
}

function logForcedCutter(seat: Seat): void {
  console.log(`[dev] forcing human cutter: ${seat}`)
}

export function getDevForcedHumanCutterSeatFromRoom(room: ServerRoom): Seat | null {
  if (!isDevForceHumanCutterEnabled()) {
    return null
  }

  // Dev-only helper: prefer the room host, otherwise the first connected human.
  if (room.hostPlayerId !== null) {
    const hostSeat = SERVER_SEAT_ORDER.find((seat) => {
      const participant = room.seats[seat].participant
      return participant?.kind === 'human' && participant.playerId === room.hostPlayerId
    })

    if (hostSeat) {
      logForcedCutter(hostSeat)
      return hostSeat
    }
  }

  const connectedHumanSeat = SERVER_SEAT_ORDER.find((seat) => {
    const participant = room.seats[seat].participant
    return participant?.kind === 'human' && participant.isConnected
  })

  if (connectedHumanSeat) {
    logForcedCutter(connectedHumanSeat)
    return connectedHumanSeat
  }

  const humanSeat = SERVER_SEAT_ORDER.find((seat) => {
    return room.seats[seat].participant?.kind === 'human'
  })

  if (humanSeat) {
    logForcedCutter(humanSeat)
    return humanSeat
  }

  return null
}

export function getDevForcedHumanCutterSeatFromState(
  state: ServerAuthoritativeGameState,
): Seat | null {
  if (!isDevForceHumanCutterEnabled()) {
    return null
  }

  const humanSeat = SERVER_SEAT_ORDER.find((seat) => {
    return state.players[seat]?.mode === 'human'
  })

  if (humanSeat) {
    logForcedCutter(humanSeat)
    return humanSeat
  }

  return null
}
