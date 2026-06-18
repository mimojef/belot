import { parentPort, workerData } from 'node:worker_threads'
import {
  GAME_WORKER_PROTOCOL_VERSION,
  type GatewayToGameWorkerMessage,
  type GameWorkerToGatewayMessage,
} from './workerProtocol.js'

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

  return false
}

// ─── Message handler ──────────────────────────────────────────────────────────

parentPort.on('message', (raw: unknown) => {
  if (!isGatewayToGameWorkerMessage(raw)) {
    let maybeRequestId: string | undefined = undefined

    if (raw !== null && typeof raw === 'object') {
      const msg = raw as Record<string, unknown>
      const isRoomCommand = msg['type'] === 'assign_room' || msg['type'] === 'release_room'
      if (
        isRoomCommand &&
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
