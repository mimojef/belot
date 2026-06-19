import { randomUUID } from 'node:crypto'
import {
  GAME_WORKER_PROTOCOL_VERSION,
  isGameWorkerComputeTickRoomsResponseMessage,
  type GameWorkerTickRoomInput,
  type GameWorkerTickRoomResult,
} from './workerProtocol.js'

// ─── Public types ─────────────────────────────────────────────────────────────

export type GameWorkerTickMessageEndpoint = {
  postMessage(message: unknown): void
  on(event: 'message', listener: (message: unknown) => void): unknown
  off(event: 'message', listener: (message: unknown) => void): unknown
}

export type GameWorkerTickClientConfig = {
  endpoint: GameWorkerTickMessageEndpoint
  requestTimeoutMs?: number
}

export type GameWorkerTickClient = {
  computeTickRooms(
    rooms: GameWorkerTickRoomInput[],
    now: number,
  ): Promise<GameWorkerTickRoomResult[]>

  shutdown(): Promise<void>
}

// ─── Internal types ───────────────────────────────────────────────────────────

type PendingTickRequest = {
  expectedRoomIds: Set<string>
  expectedRevisionByRoomId: Map<string, number>
  resolve: (results: GameWorkerTickRoomResult[]) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

// ─── Factory ──────────────────────────────────────────────────────────────────

const DEFAULT_REQUEST_TIMEOUT_MS = 3000

export function createGameWorkerTickClient(
  config: GameWorkerTickClientConfig,
): GameWorkerTickClient {
  const requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS

  if (
    !Number.isFinite(requestTimeoutMs) ||
    !Number.isInteger(requestTimeoutMs) ||
    requestTimeoutMs <= 0
  ) {
    throw new Error(
      `[tick-client] requestTimeoutMs must be a finite positive integer, got ${String(config.requestTimeoutMs)}`,
    )
  }

  const { endpoint } = config

  let isShuttingDown = false
  let shutdownPromise: Promise<void> | null = null

  const pending = new Map<string, PendingTickRequest>()

  // ─── Message handler ────────────────────────────────────────────────────────

  function handleMessage(raw: unknown): void {
    // Handle correlated worker_error
    if (raw !== null && typeof raw === 'object') {
      const msg = raw as Record<string, unknown>

      if (msg['type'] === 'worker_error') {
        const requestId = typeof msg['requestId'] === 'string' ? msg['requestId'] : null

        if (requestId !== null) {
          const req = pending.get(requestId) ?? null

          if (req !== null) {
            clearTimeout(req.timeout)
            pending.delete(requestId)
            req.reject(
              new Error(
                `[tick-client] worker_error for requestId=${requestId}: ${String(msg['message'])}`,
              ),
            )
          }
        }
        return
      }

      // Immediate reject for malformed correlated compute_tick_rooms_response
      if (msg['type'] === 'compute_tick_rooms_response') {
        const requestId = typeof msg['requestId'] === 'string' ? msg['requestId'] : null
        if (requestId !== null) {
          const correlated = pending.get(requestId) ?? null
          if (correlated !== null && !isGameWorkerComputeTickRoomsResponseMessage(raw)) {
            clearTimeout(correlated.timeout)
            pending.delete(requestId)
            correlated.reject(
              new Error(
                `[tick-client] malformed compute_tick_rooms_response for requestId=${requestId}`,
              ),
            )
            return
          }
        }
      }
    }

    if (!isGameWorkerComputeTickRoomsResponseMessage(raw)) {
      // Ignore unrelated lifecycle messages (ready, pong, assign_room_ack, etc.)
      return
    }

    const msg = raw
    const req = pending.get(msg.requestId) ?? null

    if (req === null) {
      // Late response after timeout — ignore
      return
    }

    // Validate result count
    if (msg.results.length !== req.expectedRoomIds.size) {
      clearTimeout(req.timeout)
      pending.delete(msg.requestId)
      req.reject(
        new Error(
          `[tick-client] requestId=${msg.requestId}: expected ${req.expectedRoomIds.size} results, got ${msg.results.length}`,
        ),
      )
      return
    }

    // Validate result room IDs and revisions
    const seenResultIds = new Set<string>()

    for (const result of msg.results) {
      if (seenResultIds.has(result.roomId)) {
        clearTimeout(req.timeout)
        pending.delete(msg.requestId)
        req.reject(
          new Error(
            `[tick-client] requestId=${msg.requestId}: duplicate result roomId=${result.roomId}`,
          ),
        )
        return
      }

      seenResultIds.add(result.roomId)

      if (!req.expectedRoomIds.has(result.roomId)) {
        clearTimeout(req.timeout)
        pending.delete(msg.requestId)
        req.reject(
          new Error(
            `[tick-client] requestId=${msg.requestId}: unexpected result roomId=${result.roomId}`,
          ),
        )
        return
      }

      const expectedRevision = req.expectedRevisionByRoomId.get(result.roomId) ?? null

      if (expectedRevision === null || result.baseRevision !== expectedRevision) {
        clearTimeout(req.timeout)
        pending.delete(msg.requestId)
        req.reject(
          new Error(
            `[tick-client] requestId=${msg.requestId}: revision mismatch for roomId=${result.roomId} expected=${String(expectedRevision)} got=${result.baseRevision}`,
          ),
        )
        return
      }
    }

    // Check no missing room IDs
    for (const expectedId of req.expectedRoomIds) {
      if (!seenResultIds.has(expectedId)) {
        clearTimeout(req.timeout)
        pending.delete(msg.requestId)
        req.reject(
          new Error(
            `[tick-client] requestId=${msg.requestId}: missing result for roomId=${expectedId}`,
          ),
        )
        return
      }
    }

    clearTimeout(req.timeout)
    pending.delete(msg.requestId)
    req.resolve(msg.results)
  }

  endpoint.on('message', handleMessage)

  // ─── computeTickRooms ───────────────────────────────────────────────────────

  function computeTickRooms(
    rooms: GameWorkerTickRoomInput[],
    now: number,
  ): Promise<GameWorkerTickRoomResult[]> {
    if (isShuttingDown) {
      return Promise.reject(
        new Error('[tick-client] computeTickRooms() called after shutdown.'),
      )
    }

    if (!Number.isFinite(now)) {
      return Promise.reject(
        new Error(`[tick-client] now must be a finite number, got ${String(now)}`),
      )
    }

    if (!Array.isArray(rooms) || rooms.length === 0) {
      return Promise.reject(
        new Error('[tick-client] rooms must be a non-empty array.'),
      )
    }

    // Validate each input
    const seenIds = new Set<string>()
    const revisionByRoomId = new Map<string, number>()

    for (const input of rooms) {
      if (typeof input.roomId !== 'string' || input.roomId.trim() === '') {
        return Promise.reject(
          new Error('[tick-client] Each room input must have a non-empty roomId.'),
        )
      }

      if (seenIds.has(input.roomId)) {
        return Promise.reject(
          new Error(`[tick-client] Duplicate roomId=${input.roomId} in input.`),
        )
      }

      seenIds.add(input.roomId)

      if (
        typeof input.baseRevision !== 'number' ||
        !Number.isInteger(input.baseRevision) ||
        input.baseRevision < 0 ||
        !Number.isSafeInteger(input.baseRevision)
      ) {
        return Promise.reject(
          new Error(
            `[tick-client] baseRevision for roomId=${input.roomId} must be a non-negative safe integer.`,
          ),
        )
      }

      if (
        input.room === null ||
        typeof input.room !== 'object' ||
        (input.room as Record<string, unknown>)['id'] !== input.roomId
      ) {
        return Promise.reject(
          new Error(
            `[tick-client] room.id must equal roomId for roomId=${input.roomId}.`,
          ),
        )
      }

      revisionByRoomId.set(input.roomId, input.baseRevision)
    }

    const requestId = randomUUID()

    return new Promise<GameWorkerTickRoomResult[]>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(requestId)
        reject(
          new Error(
            `[tick-client] Request ${requestId} timed out after ${requestTimeoutMs}ms`,
          ),
        )
      }, requestTimeoutMs)

      pending.set(requestId, {
        expectedRoomIds: seenIds,
        expectedRevisionByRoomId: revisionByRoomId,
        resolve,
        reject,
        timeout,
      })

      const message = {
        protocolVersion: GAME_WORKER_PROTOCOL_VERSION,
        type: 'compute_tick_rooms',
        requestId,
        now,
        rooms,
      }

      try {
        endpoint.postMessage(message)
      } catch (err) {
        clearTimeout(timeout)
        pending.delete(requestId)
        reject(
          new Error(
            `[tick-client] Failed to send compute_tick_rooms: ${err instanceof Error ? err.message : String(err)}`,
          ),
        )
      }
    })
  }

  // ─── shutdown ───────────────────────────────────────────────────────────────

  function shutdown(): Promise<void> {
    if (shutdownPromise !== null) return shutdownPromise

    isShuttingDown = true

    endpoint.off('message', handleMessage)

    const error = new Error('[tick-client] Shutting down — pending requests rejected.')

    for (const [, req] of pending) {
      clearTimeout(req.timeout)
      req.reject(error)
    }

    pending.clear()

    shutdownPromise = Promise.resolve()
    return shutdownPromise
  }

  // ─── Public interface ─────────────────────────────────────────────────────────

  return {
    computeTickRooms,
    shutdown,
  }
}
