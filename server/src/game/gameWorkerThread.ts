import { parentPort, workerData } from 'node:worker_threads'
import {
  GAME_WORKER_PROTOCOL_VERSION,
  type GatewayToGameWorkerMessage,
  type GameWorkerToGatewayMessage,
  type GameWorkerComputeTickRoomsRequestMessage,
  type GameWorkerTickRoomResult,
} from './workerProtocol.js'
import { advanceRoomAuthoritativeGame } from './advanceRoomAuthoritativeGame.js'

// ─── Startup validation ───────────────────────────────────────────────────────

type GameWorkerThreadData = {
  workerId: string
}

if (parentPort === null) {
  throw new Error(
    '[game-worker] parentPort is null — file must be run as a worker_thread, not directly.',
  )
}

const data = workerData as GameWorkerThreadData

if (typeof data?.workerId !== 'string' || data.workerId.trim() === '') {
  throw new Error(
    '[game-worker] Invalid workerData: workerId must be a non-empty string.',
  )
}

const workerId = data.workerId
const startedAt = Date.now()

// ─── Shadow room registry ─────────────────────────────────────────────────────

const roomIds = new Set<string>()

// ─── Message sender ───────────────────────────────────────────────────────────

function sendMessage(message: GameWorkerToGatewayMessage): void {
  parentPort!.postMessage(message)
}

// ─── Runtime validation ───────────────────────────────────────────────────────

function isGatewayToGameWorkerMessage(
  value: unknown,
): value is GatewayToGameWorkerMessage {
  if (value === null || typeof value !== 'object') {
    return false
  }

  const msg = value as Record<string, unknown>

  if (msg['type'] === 'ping') {
    return (
      typeof msg['requestId'] === 'string' &&
      typeof msg['sentAt'] === 'number' &&
      Number.isFinite(msg['sentAt'])
    )
  }

  if (msg['type'] === 'health_request') {
    return typeof msg['requestId'] === 'string'
  }

  if (msg['type'] === 'shutdown') {
    return typeof msg['requestId'] === 'string'
  }

  if (msg['type'] === 'assign_room') {
    return (
      typeof msg['requestId'] === 'string' &&
      msg['requestId'].trim() !== '' &&
      typeof msg['roomId'] === 'string' &&
      msg['roomId'].trim() !== ''
    )
  }

  if (msg['type'] === 'release_room') {
    return (
      typeof msg['requestId'] === 'string' &&
      msg['requestId'].trim() !== '' &&
      typeof msg['roomId'] === 'string' &&
      msg['roomId'].trim() !== ''
    )
  }

  if (msg['type'] === 'compute_tick_rooms') {
    return isValidComputeTickRoomsMessage(msg)
  }

  return false
}

function isValidComputeTickRoomsMessage(
  msg: Record<string, unknown>,
): msg is GameWorkerComputeTickRoomsRequestMessage {
  if (msg['protocolVersion'] !== GAME_WORKER_PROTOCOL_VERSION) return false
  if (typeof msg['requestId'] !== 'string' || (msg['requestId'] as string).trim() === '') return false
  if (typeof msg['now'] !== 'number' || !Number.isFinite(msg['now'])) return false
  if (!Array.isArray(msg['rooms'])) return false

  const seenIds = new Set<string>()

  for (const item of msg['rooms'] as unknown[]) {
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

    if (r['room'] === null || typeof r['room'] !== 'object') return false

    const room = r['room'] as Record<string, unknown>
    if (room['id'] !== r['roomId']) return false
  }

  return true
}

function normalizeWorkerErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

// ─── Message handler ──────────────────────────────────────────────────────────

parentPort.on('message', (raw: unknown) => {
  if (!isGatewayToGameWorkerMessage(raw)) {
    let maybeRequestId: string | undefined = undefined

    if (raw !== null && typeof raw === 'object') {
      const msg = raw as Record<string, unknown>
      const isCorrelatedCommand =
        msg['type'] === 'assign_room' ||
        msg['type'] === 'release_room' ||
        msg['type'] === 'compute_tick_rooms'
      if (
        isCorrelatedCommand &&
        typeof msg['requestId'] === 'string' &&
        msg['requestId'].trim() !== ''
      ) {
        maybeRequestId = msg['requestId'] as string
      }
    }

    sendMessage({
      type: 'worker_error',
      requestId: maybeRequestId,
      message: 'Invalid game worker message.',
    })
    return
  }

  const message = raw

  if (message.type === 'ping') {
    sendMessage({
      type: 'pong',
      requestId: message.requestId,
      receivedAt: Date.now(),
    })
    return
  }

  if (message.type === 'health_request') {
    sendMessage({
      type: 'health_response',
      requestId: message.requestId,
      workerId,
      startedAt,
      uptimeMs: Math.max(0, Date.now() - startedAt),
      activeRooms: roomIds.size,
    })
    return
  }

  if (message.type === 'assign_room') {
    const alreadyPresent = roomIds.has(message.roomId)
    if (!alreadyPresent) {
      roomIds.add(message.roomId)
    }
    sendMessage({
      type: 'assign_room_ack',
      requestId: message.requestId,
      roomId: message.roomId,
      result: alreadyPresent ? 'already_assigned' : 'assigned',
      activeRooms: roomIds.size,
    })
    return
  }

  if (message.type === 'release_room') {
    const wasPresent = roomIds.delete(message.roomId)
    sendMessage({
      type: 'release_room_ack',
      requestId: message.requestId,
      roomId: message.roomId,
      result: wasPresent ? 'released' : 'not_assigned',
      activeRooms: roomIds.size,
    })
    return
  }

  if (message.type === 'compute_tick_rooms') {
    const results: GameWorkerTickRoomResult[] = []

    for (const input of message.rooms) {
      const { roomId, baseRevision, room } = input

      if (!roomIds.has(roomId)) {
        results.push({
          roomId,
          baseRevision,
          result: 'error',
          code: 'not_assigned',
          message: 'Room is not assigned to this worker.',
        })
        continue
      }

      try {
        const nextRoom = advanceRoomAuthoritativeGame(room, message.now)
        if (nextRoom === room) {
          results.push({ roomId, baseRevision, result: 'unchanged' })
        } else {
          results.push({ roomId, baseRevision, result: 'advanced', room: nextRoom })
        }
      } catch (error: unknown) {
        results.push({
          roomId,
          baseRevision,
          result: 'error',
          code: 'compute_failed',
          message: normalizeWorkerErrorMessage(error),
        })
      }
    }

    sendMessage({
      type: 'compute_tick_rooms_response',
      protocolVersion: GAME_WORKER_PROTOCOL_VERSION,
      requestId: message.requestId,
      results,
    })
    return
  }

  if (message.type === 'shutdown') {
    roomIds.clear()
    sendMessage({
      type: 'shutdown_complete',
      requestId: message.requestId,
    })
    parentPort!.close()
  }
})

// ─── Ready signal ─────────────────────────────────────────────────────────────

sendMessage({
  type: 'ready',
  workerId,
  protocolVersion: GAME_WORKER_PROTOCOL_VERSION,
  startedAt,
})
