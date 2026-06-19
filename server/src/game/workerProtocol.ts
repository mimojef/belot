import type { ServerRoom } from '../core/serverTypes.js'

export const GAME_WORKER_PROTOCOL_VERSION = 3

export type WorkerRequestId = string

// ─── Gateway → Worker ─────────────────────────────────────────────────────────

export type GameWorkerPingMessage = {
  type: 'ping'
  requestId: WorkerRequestId
  sentAt: number
}

export type GameWorkerHealthRequestMessage = {
  type: 'health_request'
  requestId: WorkerRequestId
}

export type GameWorkerShutdownMessage = {
  type: 'shutdown'
  requestId: WorkerRequestId
}

export type GameWorkerAssignRoomMessage = {
  type: 'assign_room'
  requestId: WorkerRequestId
  roomId: string
}

export type GameWorkerReleaseRoomMessage = {
  type: 'release_room'
  requestId: WorkerRequestId
  roomId: string
}

export type GameWorkerTickRoomInput = {
  roomId: string
  baseRevision: number
  room: ServerRoom
}

export type GameWorkerComputeTickRoomsRequestMessage = {
  protocolVersion: typeof GAME_WORKER_PROTOCOL_VERSION
  type: 'compute_tick_rooms'
  requestId: WorkerRequestId
  now: number
  rooms: GameWorkerTickRoomInput[]
}

export type GatewayToGameWorkerMessage =
  | GameWorkerPingMessage
  | GameWorkerHealthRequestMessage
  | GameWorkerShutdownMessage
  | GameWorkerAssignRoomMessage
  | GameWorkerReleaseRoomMessage
  | GameWorkerComputeTickRoomsRequestMessage

// ─── Worker → Gateway ─────────────────────────────────────────────────────────

export type GameWorkerReadyMessage = {
  type: 'ready'
  workerId: string
  protocolVersion: number
  startedAt: number
}

export type GameWorkerPongMessage = {
  type: 'pong'
  requestId: WorkerRequestId
  receivedAt: number
}

export type GameWorkerHealthResponseMessage = {
  type: 'health_response'
  requestId: WorkerRequestId
  workerId: string
  startedAt: number
  uptimeMs: number
  activeRooms: number
}

export type GameWorkerShutdownCompleteMessage = {
  type: 'shutdown_complete'
  requestId: WorkerRequestId
}

export type GameWorkerErrorMessage = {
  type: 'worker_error'
  requestId?: WorkerRequestId
  message: string
}

export type AssignRoomResult =
  | 'assigned'
  | 'already_assigned'

export type ReleaseRoomResult =
  | 'released'
  | 'not_assigned'

export type GameWorkerAssignRoomAckMessage = {
  type: 'assign_room_ack'
  requestId: WorkerRequestId
  roomId: string
  result: AssignRoomResult
  activeRooms: number
}

export type GameWorkerReleaseRoomAckMessage = {
  type: 'release_room_ack'
  requestId: WorkerRequestId
  roomId: string
  result: ReleaseRoomResult
  activeRooms: number
}

export type GameWorkerTickRoomResult =
  | {
      roomId: string
      baseRevision: number
      result: 'unchanged'
    }
  | {
      roomId: string
      baseRevision: number
      result: 'advanced'
      room: ServerRoom
    }
  | {
      roomId: string
      baseRevision: number
      result: 'error'
      code: 'not_assigned' | 'compute_failed'
      message: string
    }

export type GameWorkerComputeTickRoomsResponseMessage = {
  protocolVersion: typeof GAME_WORKER_PROTOCOL_VERSION
  type: 'compute_tick_rooms_response'
  requestId: WorkerRequestId
  results: GameWorkerTickRoomResult[]
}

export type GameWorkerToGatewayMessage =
  | GameWorkerReadyMessage
  | GameWorkerPongMessage
  | GameWorkerHealthResponseMessage
  | GameWorkerShutdownCompleteMessage
  | GameWorkerErrorMessage
  | GameWorkerAssignRoomAckMessage
  | GameWorkerReleaseRoomAckMessage
  | GameWorkerComputeTickRoomsResponseMessage

// ─── Response type guard ──────────────────────────────────────────────────────

export function isGameWorkerComputeTickRoomsResponseMessage(
  value: unknown,
): value is GameWorkerComputeTickRoomsResponseMessage {
  if (value === null || typeof value !== 'object') return false

  const msg = value as Record<string, unknown>

  if (msg['type'] !== 'compute_tick_rooms_response') return false
  if (msg['protocolVersion'] !== GAME_WORKER_PROTOCOL_VERSION) return false
  if (typeof msg['requestId'] !== 'string' || (msg['requestId'] as string).trim() === '') return false
  if (!Array.isArray(msg['results'])) return false

  const seenIds = new Set<string>()

  for (const item of msg['results'] as unknown[]) {
    if (item === null || typeof item !== 'object') return false

    const r = item as Record<string, unknown>

    if (typeof r['roomId'] !== 'string' || (r['roomId'] as string).trim() === '') return false
    if (seenIds.has(r['roomId'] as string)) return false
    seenIds.add(r['roomId'] as string)

    if (
      typeof r['baseRevision'] !== 'number' ||
      !Number.isInteger(r['baseRevision']) ||
      (r['baseRevision'] as number) < 0 ||
      !Number.isSafeInteger(r['baseRevision'])
    ) return false

    const res = r['result']

    if (res === 'unchanged') {
      // valid
    } else if (res === 'advanced') {
      if (r['room'] === null || typeof r['room'] !== 'object') return false
      const room = r['room'] as Record<string, unknown>
      if (room['id'] !== r['roomId']) return false
    } else if (res === 'error') {
      if (r['code'] !== 'not_assigned' && r['code'] !== 'compute_failed') return false
      if (typeof r['message'] !== 'string' || (r['message'] as string).trim() === '') return false
    } else {
      return false
    }
  }

  return true
}
