import { Worker } from 'node:worker_threads'
import {
  GAME_WORKER_PROTOCOL_VERSION,
  type WorkerRequestId,
  type GameWorkerToGatewayMessage,
  type GameWorkerAssignRoomAckMessage,
  type GameWorkerReleaseRoomAckMessage,
} from './workerProtocol.js'
import type { GameWorkerTickMessageEndpoint } from './createGameWorkerTickClient.js'

// ─── Public types ─────────────────────────────────────────────────────────────

export type GameWorkerLifecycleState =
  | 'idle'
  | 'starting'
  | 'ready'
  | 'stopping'
  | 'stopped'
  | 'failed'

export type GameWorkerLifecycleHealth = {
  workerId: string
  startedAt: number
  uptimeMs: number
  activeRooms: number
}

export type GameWorkerLifecycleClientConfig = {
  workerId: string
  workerEntryUrl: URL
  readyTimeoutMs?: number
  requestTimeoutMs?: number
}

export type GameWorkerLifecycleClient = {
  start(): Promise<void>
  ping(): Promise<number>
  getHealth(): Promise<GameWorkerLifecycleHealth>
  assignRoom(roomId: string): Promise<GameWorkerAssignRoomAckMessage>
  releaseRoom(roomId: string): Promise<GameWorkerReleaseRoomAckMessage>
  shutdown(): Promise<void>
  getState(): GameWorkerLifecycleState
  getMessageEndpoint(): GameWorkerTickMessageEndpoint
  // Monitoring-only, best-effort: worker-scoped CPU usage (node:worker_threads
  // Worker#cpuUsage()). Feature-detected — връща null ако API-то липсва на
  // текущия Node runtime, ако worker-ът не е ready, или при каквато и да е
  // грешка. НИКОГА не хвърля и никога не влияе на gameplay/protocol пътя.
  getWorkerCpuUsage(): Promise<NodeJS.CpuUsage | null>
}

// ─── Internal types ───────────────────────────────────────────────────────────

type PendingRequest = {
  expectedType: 'pong' | 'health_response' | 'shutdown_complete' | 'assign_room_ack' | 'release_room_ack'
  resolve: (message: GameWorkerToGatewayMessage) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

// ─── Runtime validation ───────────────────────────────────────────────────────

function isGameWorkerToGatewayMessage(
  value: unknown,
): value is GameWorkerToGatewayMessage {
  if (value === null || typeof value !== 'object') {
    return false
  }

  const msg = value as Record<string, unknown>

  if (msg['type'] === 'ready') {
    return (
      typeof msg['workerId'] === 'string' &&
      typeof msg['protocolVersion'] === 'number' &&
      typeof msg['startedAt'] === 'number'
    )
  }

  if (msg['type'] === 'pong') {
    return (
      typeof msg['requestId'] === 'string' &&
      typeof msg['receivedAt'] === 'number'
    )
  }

  if (msg['type'] === 'health_response') {
    return (
      typeof msg['requestId'] === 'string' &&
      typeof msg['workerId'] === 'string' &&
      typeof msg['startedAt'] === 'number' &&
      typeof msg['uptimeMs'] === 'number' &&
      typeof msg['activeRooms'] === 'number'
    )
  }

  if (msg['type'] === 'shutdown_complete') {
    return typeof msg['requestId'] === 'string'
  }

  if (msg['type'] === 'worker_error') {
    return (
      typeof msg['message'] === 'string' &&
      (msg['requestId'] === undefined || typeof msg['requestId'] === 'string')
    )
  }

  if (msg['type'] === 'assign_room_ack') {
    return (
      typeof msg['requestId'] === 'string' &&
      msg['requestId'].trim() !== '' &&
      typeof msg['roomId'] === 'string' &&
      msg['roomId'].trim() !== '' &&
      (msg['result'] === 'assigned' || msg['result'] === 'already_assigned') &&
      typeof msg['activeRooms'] === 'number' &&
      Number.isInteger(msg['activeRooms']) &&
      (msg['activeRooms'] as number) >= 0
    )
  }

  if (msg['type'] === 'release_room_ack') {
    return (
      typeof msg['requestId'] === 'string' &&
      msg['requestId'].trim() !== '' &&
      typeof msg['roomId'] === 'string' &&
      msg['roomId'].trim() !== '' &&
      (msg['result'] === 'released' || msg['result'] === 'not_assigned') &&
      typeof msg['activeRooms'] === 'number' &&
      Number.isInteger(msg['activeRooms']) &&
      (msg['activeRooms'] as number) >= 0
    )
  }

  return false
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createGameWorkerLifecycleClient(
  config: GameWorkerLifecycleClientConfig,
): GameWorkerLifecycleClient {
  const readyTimeoutMs = config.readyTimeoutMs ?? 5000
  const requestTimeoutMs = config.requestTimeoutMs ?? 5000

  if (typeof config.workerId !== 'string' || config.workerId.trim() === '') {
    throw new Error(
      '[lifecycle-client] workerId must be a non-empty string.',
    )
  }

  if (!(config.workerEntryUrl instanceof URL)) {
    throw new Error(
      '[lifecycle-client] workerEntryUrl must be an instance of URL.',
    )
  }

  if (!Number.isFinite(readyTimeoutMs) || readyTimeoutMs <= 0) {
    throw new Error(
      '[lifecycle-client] readyTimeoutMs must be a finite positive number.',
    )
  }

  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new Error(
      '[lifecycle-client] requestTimeoutMs must be a finite positive number.',
    )
  }

  const { workerId } = config

  let state: GameWorkerLifecycleState = 'idle'
  let worker: Worker | null = null
  let requestSequence = 0
  const pending = new Map<WorkerRequestId, PendingRequest>()

  let startPromise: Promise<void> | null = null
  let shutdownPromise: Promise<void> | null = null

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  function nextRequestId(): WorkerRequestId {
    requestSequence += 1
    return `${workerId}-request-${requestSequence}`
  }

  function rejectAllPending(error: Error): void {
    for (const [, req] of pending) {
      clearTimeout(req.timeout)
      req.reject(error)
    }
    pending.clear()
  }

  function terminateWorker(): void {
    if (worker !== null) {
      void worker.terminate()
      worker = null
    }
  }

  // ─── Runtime message handler (active after ready) ────────────────────────────

  function handleMessage(raw: unknown): void {
    if (!isGameWorkerToGatewayMessage(raw)) {
      return
    }

    const msg = raw

    if (msg.type === 'worker_error') {
      if (msg.requestId !== undefined) {
        const req = pending.get(msg.requestId) ?? null
        if (req !== null) {
          clearTimeout(req.timeout)
          pending.delete(msg.requestId)
          req.reject(
            new Error(
              `[lifecycle-client] worker_error for requestId=${msg.requestId}: ${msg.message}`,
            ),
          )
        }
      } else {
        const error = new Error(
          `[lifecycle-client] Unsolicited worker_error: ${msg.message}`,
        )
        state = 'failed'
        rejectAllPending(error)
        terminateWorker()
      }
      return
    }

    if (msg.type === 'ready') {
      return
    }

    if (msg.requestId === undefined) {
      return
    }

    const req = pending.get(msg.requestId) ?? null

    if (req === null) {
      return
    }

    if (msg.type !== req.expectedType) {
      clearTimeout(req.timeout)
      pending.delete(msg.requestId)
      req.reject(
        new Error(
          `[lifecycle-client] Expected ${req.expectedType} but got ${msg.type} for requestId=${msg.requestId}`,
        ),
      )
      return
    }

    clearTimeout(req.timeout)
    pending.delete(msg.requestId)
    req.resolve(msg)
  }

  function handleRuntimeWorkerError(error: Error): void {
    state = 'failed'
    rejectAllPending(
      new Error(`[lifecycle-client] Worker error: ${error.message}`),
    )
    worker = null
  }

  function handleRuntimeWorkerExit(code: number): void {
    const wasExpectedExit = state === 'stopping' && code === 0

    if (!wasExpectedExit) {
      const error = new Error(
        `[lifecycle-client] Worker exited unexpectedly with code=${code}`,
      )
      state = 'failed'
      rejectAllPending(error)
    }

    worker = null
  }

  // ─── sendRequest ──────────────────────────────────────────────────────────────

  function sendRequest<T extends GameWorkerToGatewayMessage>(
    message: Parameters<Worker['postMessage']>[0],
    expectedType: PendingRequest['expectedType'],
    timeoutMs: number,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const requestId = (message as Record<string, unknown>)['requestId']

      if (typeof requestId !== 'string') {
        reject(new Error('[lifecycle-client] Message missing requestId.'))
        return
      }

      const timeout = setTimeout(() => {
        pending.delete(requestId)
        reject(
          new Error(
            `[lifecycle-client] Request ${requestId} timed out after ${timeoutMs}ms`,
          ),
        )
      }, timeoutMs)

      pending.set(requestId, {
        expectedType,
        resolve: (msg) => resolve(msg as T),
        reject,
        timeout,
      })

      // Fix 3: guard postMessage against synchronous throw
      try {
        worker!.postMessage(message)
      } catch (err) {
        clearTimeout(timeout)
        pending.delete(requestId)
        reject(
          new Error(
            `[lifecycle-client] Failed to send request ${requestId}: ${err instanceof Error ? err.message : String(err)}`,
          ),
        )
      }
    })
  }

  // ─── start() ─────────────────────────────────────────────────────────────────

  function start(): Promise<void> {
    if (state === 'starting' && startPromise !== null) {
      return startPromise
    }

    if (state === 'ready') {
      return Promise.resolve()
    }

    if (state !== 'idle') {
      return Promise.reject(
        new Error(`[lifecycle-client] Cannot start() from state=${state}.`),
      )
    }

    state = 'starting'

    startPromise = new Promise<void>((resolve, reject) => {
      // Fix 1: guard Worker constructor against synchronous throw
      let spawnedWorker: Worker

      try {
        spawnedWorker = new Worker(config.workerEntryUrl, {
          workerData: { workerId },
        })
      } catch (err) {
        state = 'failed'
        worker = null
        reject(
          new Error(
            `[lifecycle-client] Failed to create worker: ${err instanceof Error ? err.message : String(err)}`,
          ),
        )
        return
      }

      worker = spawnedWorker

      let startupSettled = false
      let readyTimer: ReturnType<typeof setTimeout> | null = null

      function settleStartup(fn: () => void): void {
        if (startupSettled) return
        startupSettled = true
        if (readyTimer !== null) {
          clearTimeout(readyTimer)
          readyTimer = null
        }
        fn()
      }

      readyTimer = setTimeout(() => {
        settleStartup(() => {
          state = 'failed'
          terminateWorker()
          reject(
            new Error(
              `[lifecycle-client] Worker did not send ready within ${readyTimeoutMs}ms`,
            ),
          )
        })
      }, readyTimeoutMs)

      // Fix 2: named startup listeners for precise removal

      function handleStartupMessage(raw: unknown): void {
        if (!isGameWorkerToGatewayMessage(raw)) {
          return
        }

        const msg = raw

        if (msg.type !== 'ready') {
          return
        }

        if (startupSettled) {
          return
        }

        const validWorkerId = msg.workerId === workerId
        const validProtocol =
          msg.protocolVersion === GAME_WORKER_PROTOCOL_VERSION
        const validStartedAt =
          Number.isFinite(msg.startedAt) && msg.startedAt > 0

        if (!validWorkerId || !validProtocol || !validStartedAt) {
          settleStartup(() => {
            state = 'failed'
            terminateWorker()
            reject(
              new Error(
                `[lifecycle-client] Invalid ready message: workerId=${msg.workerId} protocolVersion=${msg.protocolVersion} startedAt=${msg.startedAt}`,
              ),
            )
          })
          return
        }

        settleStartup(() => {
          // Remove startup listener and install runtime listener
          spawnedWorker.off('message', handleStartupMessage)
          spawnedWorker.on('message', handleMessage)
          state = 'ready'
          resolve()
        })
      }

      function handleStartupError(err: Error): void {
        if (!startupSettled) {
          settleStartup(() => {
            state = 'failed'
            worker = null
            reject(
              new Error(
                `[lifecycle-client] Worker error during start: ${err.message}`,
              ),
            )
          })
        } else {
          handleRuntimeWorkerError(err)
        }
      }

      function handleStartupExit(code: number): void {
        if (!startupSettled) {
          settleStartup(() => {
            state = 'failed'
            worker = null
            reject(
              new Error(
                `[lifecycle-client] Worker exited during start with code=${code}`,
              ),
            )
          })
        } else {
          handleRuntimeWorkerExit(code)
        }
      }

      spawnedWorker.on('message', handleStartupMessage)
      spawnedWorker.on('error', handleStartupError)
      spawnedWorker.on('exit', handleStartupExit)
    })

    return startPromise
  }

  // ─── ping() ───────────────────────────────────────────────────────────────────

  function ping(): Promise<number> {
    if (state !== 'ready') {
      return Promise.reject(
        new Error(
          `[lifecycle-client] ping() requires state=ready, got state=${state}.`,
        ),
      )
    }

    const sentAt = Date.now()
    const requestId = nextRequestId()

    return sendRequest<{ type: 'pong'; requestId: string; receivedAt: number }>(
      { type: 'ping', requestId, sentAt },
      'pong',
      requestTimeoutMs,
    ).then((msg) => {
      if (!Number.isFinite(msg.receivedAt)) {
        throw new Error('[lifecycle-client] pong receivedAt is not finite.')
      }
      return Math.max(0, Date.now() - sentAt)
    })
  }

  // ─── getHealth() ──────────────────────────────────────────────────────────────

  function getHealth(): Promise<GameWorkerLifecycleHealth> {
    if (state !== 'ready') {
      return Promise.reject(
        new Error(
          `[lifecycle-client] getHealth() requires state=ready, got state=${state}.`,
        ),
      )
    }

    const requestId = nextRequestId()

    return sendRequest<{
      type: 'health_response'
      requestId: string
      workerId: string
      startedAt: number
      uptimeMs: number
      activeRooms: number
    }>(
      { type: 'health_request', requestId },
      'health_response',
      requestTimeoutMs,
    ).then((msg) => {
      if (msg.workerId !== workerId) {
        throw new Error(
          `[lifecycle-client] health_response workerId mismatch: expected=${workerId} got=${msg.workerId}`,
        )
      }

      if (!Number.isFinite(msg.startedAt) || msg.startedAt <= 0) {
        throw new Error(
          `[lifecycle-client] health_response startedAt is invalid: ${msg.startedAt}`,
        )
      }

      if (!Number.isFinite(msg.uptimeMs) || msg.uptimeMs < 0) {
        throw new Error(
          `[lifecycle-client] health_response uptimeMs is invalid: ${msg.uptimeMs}`,
        )
      }

      if (
        !Number.isFinite(msg.activeRooms) ||
        !Number.isInteger(msg.activeRooms) ||
        msg.activeRooms < 0
      ) {
        throw new Error(
          `[lifecycle-client] health_response activeRooms is invalid: ${msg.activeRooms}`,
        )
      }

      return {
        workerId: msg.workerId,
        startedAt: msg.startedAt,
        uptimeMs: msg.uptimeMs,
        activeRooms: msg.activeRooms,
      }
    })
  }

  // ─── assignRoom() ─────────────────────────────────────────────────────────────

  function assignRoom(roomId: string): Promise<GameWorkerAssignRoomAckMessage> {
    if (state !== 'ready') {
      return Promise.reject(
        new Error(
          `[lifecycle-client] assignRoom() requires state=ready, got state=${state}.`,
        ),
      )
    }

    if (typeof roomId !== 'string' || roomId.trim() === '') {
      return Promise.reject(
        new Error(
          `[lifecycle-client] assignRoom() requires a non-empty roomId.`,
        ),
      )
    }

    const requestId = nextRequestId()

    return sendRequest<GameWorkerAssignRoomAckMessage>(
      { type: 'assign_room', requestId, roomId },
      'assign_room_ack',
      requestTimeoutMs,
    ).then((msg) => {
      if (msg.roomId !== roomId) {
        throw new Error(
          `[lifecycle-client] assign_room_ack roomId mismatch: expected=${roomId} got=${msg.roomId}`,
        )
      }
      return msg
    })
  }

  // ─── releaseRoom() ────────────────────────────────────────────────────────────

  function releaseRoom(roomId: string): Promise<GameWorkerReleaseRoomAckMessage> {
    if (state !== 'ready') {
      return Promise.reject(
        new Error(
          `[lifecycle-client] releaseRoom() requires state=ready, got state=${state}.`,
        ),
      )
    }

    if (typeof roomId !== 'string' || roomId.trim() === '') {
      return Promise.reject(
        new Error(
          `[lifecycle-client] releaseRoom() requires a non-empty roomId.`,
        ),
      )
    }

    const requestId = nextRequestId()

    return sendRequest<GameWorkerReleaseRoomAckMessage>(
      { type: 'release_room', requestId, roomId },
      'release_room_ack',
      requestTimeoutMs,
    ).then((msg) => {
      if (msg.roomId !== roomId) {
        throw new Error(
          `[lifecycle-client] release_room_ack roomId mismatch: expected=${roomId} got=${msg.roomId}`,
        )
      }
      return msg
    })
  }

  // ─── shutdown() ───────────────────────────────────────────────────────────────

  function shutdown(): Promise<void> {
    if (state === 'idle') {
      state = 'stopped'
      return Promise.resolve()
    }

    if (state === 'stopped') {
      return Promise.resolve()
    }

    if (state === 'stopping' && shutdownPromise !== null) {
      return shutdownPromise
    }

    if (state === 'failed') {
      terminateWorker()
      return Promise.resolve()
    }

    if (state === 'starting' && startPromise !== null) {
      shutdownPromise = startPromise
        .then(() => shutdown())
        .catch(() => {
          // start failed — already in failed state, nothing more to do
        })
      return shutdownPromise
    }

    // state === 'ready'
    state = 'stopping'

    shutdownPromise = new Promise<void>((resolve, reject) => {
      const requestId = nextRequestId()

      const shutdownTimer = setTimeout(() => {
        pending.delete(requestId)
        state = 'failed'
        terminateWorker()
        reject(
          new Error(
            `[lifecycle-client] shutdown() timed out after ${requestTimeoutMs}ms`,
          ),
        )
      }, requestTimeoutMs)

      const currentWorker = worker!

      const completePending: PendingRequest = {
        expectedType: 'shutdown_complete',
        resolve: () => {
          clearTimeout(shutdownTimer)
          currentWorker.once('exit', (code: number) => {
            worker = null
            if (code === 0) {
              state = 'stopped'
              resolve()
            } else {
              state = 'failed'
              reject(
                new Error(
                  `[lifecycle-client] Worker exited after shutdown with code=${code}`,
                ),
              )
            }
          })
        },
        reject: (err: Error) => {
          clearTimeout(shutdownTimer)
          state = 'failed'
          terminateWorker()
          reject(err)
        },
        timeout: shutdownTimer,
      }

      pending.set(requestId, completePending)

      // Fix 3: guard shutdown postMessage against synchronous throw
      try {
        worker!.postMessage({ type: 'shutdown', requestId })
      } catch (err) {
        clearTimeout(shutdownTimer)
        pending.delete(requestId)
        state = 'failed'
        terminateWorker()
        reject(
          new Error(
            `[lifecycle-client] Failed to send shutdown: ${err instanceof Error ? err.message : String(err)}`,
          ),
        )
      }
    })

    return shutdownPromise
  }

  // ─── getMessageEndpoint() ─────────────────────────────────────────────────────

  function getMessageEndpoint(): GameWorkerTickMessageEndpoint {
    if (state !== 'ready') {
      throw new Error(
        `[lifecycle-client] getMessageEndpoint() requires state=ready, got state=${state}`,
      )
    }
    if (worker === null) {
      throw new Error(
        '[lifecycle-client] getMessageEndpoint() called with state=ready but worker is null (internal invariant violated)',
      )
    }
    return worker
  }

  // ─── getWorkerCpuUsage() (monitoring-only, best-effort) ────────────────────────

  async function getWorkerCpuUsage(): Promise<NodeJS.CpuUsage | null> {
    if (state !== 'ready' || worker === null) return null
    // Feature-detect: worker.cpuUsage() е добавена в по-нови Node версии.
    // Repo-то не гарантира production Node версия — никога не приемаме, че
    // методът съществува.
    const cpuUsageFn = (worker as unknown as { cpuUsage?: unknown }).cpuUsage
    if (typeof cpuUsageFn !== 'function') return null
    try {
      const usage = await (worker.cpuUsage as () => Promise<NodeJS.CpuUsage>)()
      return usage
    } catch {
      return null
    }
  }

  // ─── Public interface ─────────────────────────────────────────────────────────

  return {
    start,
    ping,
    getHealth,
    assignRoom,
    releaseRoom,
    shutdown,
    getState(): GameWorkerLifecycleState {
      return state
    },
    getMessageEndpoint,
    getWorkerCpuUsage,
  }
}
