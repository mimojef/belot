import type { RoomId, ServerRoom, Seat } from './serverTypes.js'
import { SERVER_SEAT_ORDER } from './serverTypes.js'

export type ActiveRoomSeatCategory = 'human' | 'disconnected' | 'bot'

/**
 * Праг за визуално маркиране на изоставена (bots-only) стая в admin панела.
 * Не се ползва за никаква lifecycle/cleanup логика.
 *
 * Избран много над всеки нормален runtime delay, за да не маркира bot-only
 * игра, която реално напредва:
 *  - playHumanTimeoutMs / bidHumanTimeoutMs / cutHumanTimeoutMs = 20s (най-дългият единичен delay)
 *  - reconnectGraceMs = 30s (см. createServerRoom.ts)
 *  - playBotDelayMs = 800ms между ходове на бот (room.updatedAt се обновява при всеки)
 * 5 минути дава >10x margin над най-дългия единичен timeout, докато все още
 * хваща реално зависнали/изоставени стаи.
 */
export const STALE_ACTIVE_ROOM_THRESHOLD_MS = 5 * 60 * 1000

export type ActiveRoomSnapshot = {
  roomId: RoomId
  phase: string
  connectedHumans: number
  disconnectedHumans: number
  bots: number
  occupiedSeats: number
  workerId: string | null
  createdAt: number
  lastActivityAt: number
}

function classifySeat(
  room: ServerRoom,
  seat: Seat,
): ActiveRoomSeatCategory | null {
  const slot = room.seats[seat]
  const participant = slot.participant

  if (participant === null) return null
  if (participant.kind === 'bot') return 'bot'

  const authoritativeState = room.game.authoritativeState
  const playerState =
    authoritativeState !== null && !('kind' in authoritativeState)
      ? authoritativeState.players[seat]
      : null

  if (playerState?.controlledByBot === true) return 'bot'
  if (!participant.isConnected) return 'disconnected'
  return 'human'
}

function getRoomPhase(room: ServerRoom): string {
  const authoritativeState = room.game.authoritativeState
  return authoritativeState !== null && !('kind' in authoritativeState)
    ? authoritativeState.phase
    : (room.game.phase ?? 'bootstrap')
}

export function computeActiveRoomSnapshot(
  room: ServerRoom,
  getWorkerIdForRoom: (roomId: RoomId) => string | null,
): ActiveRoomSnapshot {
  let connectedHumans = 0
  let disconnectedHumans = 0
  let bots = 0
  let occupiedSeats = 0

  for (const seat of SERVER_SEAT_ORDER) {
    const category = classifySeat(room, seat)
    if (category === null) continue
    occupiedSeats += 1
    if (category === 'human') connectedHumans += 1
    else if (category === 'disconnected') disconnectedHumans += 1
    else bots += 1
  }

  return {
    roomId: room.id,
    phase: getRoomPhase(room),
    connectedHumans,
    disconnectedHumans,
    bots,
    occupiedSeats,
    workerId: getWorkerIdForRoom(room.id),
    createdAt: room.createdAt,
    lastActivityAt: room.updatedAt,
  }
}

export function isBotsOnlyActiveRoom(room: ActiveRoomSnapshot): boolean {
  return room.connectedHumans === 0 && room.disconnectedHumans === 0
}

export function isStaleActiveRoom(
  room: ActiveRoomSnapshot,
  nowMs: number = Date.now(),
): boolean {
  return (
    isBotsOnlyActiveRoom(room) &&
    nowMs - room.lastActivityAt > STALE_ACTIVE_ROOM_THRESHOLD_MS
  )
}

function compareActiveRoomSnapshots(
  a: ActiveRoomSnapshot,
  b: ActiveRoomSnapshot,
): number {
  const aHasHumans = a.connectedHumans > 0 || a.disconnectedHumans > 0
  const bHasHumans = b.connectedHumans > 0 || b.disconnectedHumans > 0
  if (aHasHumans !== bHasHumans) return aHasHumans ? -1 : 1

  if (a.lastActivityAt !== b.lastActivityAt) {
    return b.lastActivityAt - a.lastActivityAt
  }

  return a.roomId < b.roomId ? -1 : a.roomId > b.roomId ? 1 : 0
}

export function computeActiveRoomsSnapshot(
  rooms: Record<RoomId, ServerRoom>,
  getWorkerIdForRoom: (roomId: RoomId) => string | null,
): ActiveRoomSnapshot[] {
  const snapshots = Object.values(rooms).map((room) =>
    computeActiveRoomSnapshot(room, getWorkerIdForRoom),
  )
  snapshots.sort(compareActiveRoomSnapshots)
  return snapshots
}
