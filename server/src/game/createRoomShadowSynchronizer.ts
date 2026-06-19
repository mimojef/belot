import type {
  GameWorkerLifecycleClient,
  GameWorkerLifecycleState,
} from './createGameWorkerLifecycleClient.js'

// ─── Public types ─────────────────────────────────────────────────────────────

export type RoomShadowWorkerClient = Pick<
  GameWorkerLifecycleClient,
  'assignRoom' | 'releaseRoom' | 'getState'
>

export type RoomShadowSynchronizerHealth = {
  desiredRooms: number
  confirmedRooms: number
  pendingOperations: number
  workerState: GameWorkerLifecycleState
  isConsistent: boolean
  isShuttingDown: boolean
  lastError: string | null
}

export type RoomShadowSynchronizer = {
  desireRoom(roomId: string): void
  forgetRoom(roomId: string): void
  forgetRoomAndWait(roomId: string): Promise<void>
  getHealth(): RoomShadowSynchronizerHealth
  shutdown(): Promise<void>
}

export type RoomShadowSynchronizerConfig = {
  client: RoomShadowWorkerClient
  shutdownTimeoutMs?: number
}

type ReleaseWaiter = {
  roomId: string
  resolve: () => void
  reject: (error: Error) => void
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeError(error: unknown): Error {
  if (error instanceof Error) return error
  return new Error(String(error))
}

function isValidRoomId(roomId: unknown): roomId is string {
  return typeof roomId === 'string' && roomId.trim() !== ''
}

function setsEqual(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): boolean {
  if (left.size !== right.size) return false
  for (const id of left) {
    if (!right.has(id)) return false
  }
  return true
}

// ─── Factory ──────────────────────────────────────────────────────────────────

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5000

export function createRoomShadowSynchronizer(
  config: RoomShadowSynchronizerConfig,
): RoomShadowSynchronizer {
  const shutdownTimeoutMs = config.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS

  if (
    !Number.isFinite(shutdownTimeoutMs) ||
    !Number.isInteger(shutdownTimeoutMs) ||
    shutdownTimeoutMs <= 0
  ) {
    throw new Error(
      `[room-shadow-sync] shutdownTimeoutMs must be a finite positive integer, got ${String(config.shutdownTimeoutMs)}`,
    )
  }

  // ─── Internal state ──────────────────────────────────────────────────────────

  const desiredRoomIds = new Set<string>()
  const confirmedRoomIds = new Set<string>()

  const pendingByRoomId = new Map<string, 'assign' | 'release'>()
  const inFlightPromises = new Set<Promise<void>>()
  const releaseWaiters = new Set<ReleaseWaiter>()

  let lastError: Error | null = null
  let isShuttingDown = false
  let shutdownPromise: Promise<void> | null = null

  function resolveReleaseWaiters(roomId: string): void {
    for (const waiter of [...releaseWaiters]) {
      if (waiter.roomId === roomId) {
        releaseWaiters.delete(waiter)
        waiter.resolve()
      }
    }
  }

  function rejectReleaseWaiters(roomId: string, error: Error): void {
    for (const waiter of [...releaseWaiters]) {
      if (waiter.roomId === roomId) {
        releaseWaiters.delete(waiter)
        waiter.reject(error)
      }
    }
  }

  function settleReleasedIfConfirmed(roomId: string): void {
    if (!confirmedRoomIds.has(roomId) && !pendingByRoomId.has(roomId)) {
      resolveReleaseWaiters(roomId)
    }
  }

  // ─── reconcileRoom ───────────────────────────────────────────────────────────

  function reconcileRoom(roomId: string): void {
    try {
      // [1] Без действие при shutdown
      if (isShuttingDown) return

      // [2] Без действие ако вече има pending за тази room
      if (pendingByRoomId.has(roomId)) return

      // [3] Прочети worker state точно веднъж
      const workerState = config.client.getState()

      // [4] Worker трябва да е ready
      if (workerState !== 'ready') {
        const error = new Error(
          `[room-shadow-sync] Cannot reconcile room=${roomId}: worker state=${workerState}`,
        )
        lastError = error
        if (!desiredRoomIds.has(roomId) && confirmedRoomIds.has(roomId)) {
          rejectReleaseWaiters(roomId, error)
        }
        return
      }

      const desired = desiredRoomIds.has(roomId)
      const confirmed = confirmedRoomIds.has(roomId)

      // [5] Вече консистентно — без команда
      if (desired === confirmed) return

      if (desired && !confirmed) {
        // [6] Трябва assign
        pendingByRoomId.set(roomId, 'assign')

        const operation = Promise.resolve()
          .then(() => config.client.assignRoom(roomId))
          .then(
            (_ack) => {
              confirmedRoomIds.add(roomId)
              lastError = null
              pendingByRoomId.delete(roomId)

              if (!isShuttingDown) {
                reconcileRoom(roomId)
              }
            },
            (error: unknown) => {
              const err = normalizeError(error)
              lastError = err
              pendingByRoomId.delete(roomId)
              if (!desiredRoomIds.has(roomId)) {
                settleReleasedIfConfirmed(roomId)
              }
              // Без reconcileRoom — без автоматичен retry
            },
          )
          .catch((error: unknown) => {
            // Defensive catch за неочаквана грешка в нашите handlers
            const err = normalizeError(error)
            lastError = err
            pendingByRoomId.delete(roomId)
            if (!desiredRoomIds.has(roomId)) {
              settleReleasedIfConfirmed(roomId)
            }
          })

        inFlightPromises.add(operation)

        void operation.then(() => {
          inFlightPromises.delete(operation)
        })

        return
      }

      // !desired && confirmed
      // [7] Трябва release
      pendingByRoomId.set(roomId, 'release')

      const operation = Promise.resolve()
        .then(() => config.client.releaseRoom(roomId))
        .then(
          (_ack) => {
            confirmedRoomIds.delete(roomId)
            lastError = null
            pendingByRoomId.delete(roomId)
            settleReleasedIfConfirmed(roomId)

            if (!isShuttingDown) {
              reconcileRoom(roomId)
            }
          },
          (error: unknown) => {
            const err = normalizeError(error)
            lastError = err
            pendingByRoomId.delete(roomId)
            rejectReleaseWaiters(roomId, err)
            // Без reconcileRoom — без автоматичен retry
          },
        )
        .catch((error: unknown) => {
          // Defensive catch за неочаквана грешка в нашите handlers
          const err = normalizeError(error)
          lastError = err
          pendingByRoomId.delete(roomId)
          rejectReleaseWaiters(roomId, err)
        })

      inFlightPromises.add(operation)

      void operation.then(() => {
        inFlightPromises.delete(operation)
      })
    } catch (error: unknown) {
      // Defensive: неочаквана синхронна грешка не трябва да достига caller-а
      lastError = normalizeError(error)
    }
  }

  // ─── desireRoom ───────────────────────────────────────────────────────────────

  function desireRoom(roomId: string): void {
    if (isShuttingDown) return

    if (!isValidRoomId(roomId)) {
      lastError = new Error(
        `[room-shadow-sync] desireRoom() received invalid roomId: ${String(roomId)}`,
      )
      return
    }

    desiredRoomIds.add(roomId)
    reconcileRoom(roomId)
  }

  // ─── forgetRoom ───────────────────────────────────────────────────────────────

  function forgetRoom(roomId: string): void {
    if (isShuttingDown) return

    if (!isValidRoomId(roomId)) {
      lastError = new Error(
        `[room-shadow-sync] forgetRoom() received invalid roomId: ${String(roomId)}`,
      )
      return
    }

    desiredRoomIds.delete(roomId)
    reconcileRoom(roomId)
  }

  function forgetRoomAndWait(roomId: string): Promise<void> {
    if (isShuttingDown) {
      return Promise.reject(
        new Error('[room-shadow-sync] forgetRoomAndWait() called after shutdown.'),
      )
    }

    if (!isValidRoomId(roomId)) {
      const error = new Error(
        `[room-shadow-sync] forgetRoomAndWait() received invalid roomId: ${String(roomId)}`,
      )
      lastError = error
      return Promise.reject(error)
    }

    desiredRoomIds.delete(roomId)

    if (!confirmedRoomIds.has(roomId) && !pendingByRoomId.has(roomId)) {
      return Promise.resolve()
    }

    const promise = new Promise<void>((resolve, reject) => {
      releaseWaiters.add({ roomId, resolve, reject })
    })

    reconcileRoom(roomId)
    settleReleasedIfConfirmed(roomId)

    return promise
  }

  // ─── getHealth ───────────────────────────────────────────────────────────────

  function getHealth(): RoomShadowSynchronizerHealth {
    const workerState = config.client.getState()

    const isConsistent =
      !isShuttingDown &&
      pendingByRoomId.size === 0 &&
      workerState === 'ready' &&
      setsEqual(desiredRoomIds, confirmedRoomIds)

    return {
      desiredRooms: desiredRoomIds.size,
      confirmedRooms: confirmedRoomIds.size,
      pendingOperations: pendingByRoomId.size,
      workerState,
      isConsistent,
      isShuttingDown,
      lastError: lastError?.message ?? null,
    }
  }

  // ─── shutdown ────────────────────────────────────────────────────────────────

  function shutdown(): Promise<void> {
    if (shutdownPromise !== null) return shutdownPromise

    isShuttingDown = true

    const shutdownError = new Error(
      '[room-shadow-sync] Shutting down before release acknowledgement.',
    )
    for (const waiter of [...releaseWaiters]) {
      releaseWaiters.delete(waiter)
      waiter.reject(shutdownError)
    }

    // Snapshot на текущите in-flight promises.
    // isShuttingDown е вече true — follow-up reconcile след успешен ack
    // не стартира нова IPC операция.
    const snapshot = [...inFlightPromises]

    shutdownPromise = new Promise<void>((resolve, reject) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | null = null

      function settle(fn: () => void): void {
        if (settled) return
        settled = true
        if (timer !== null) {
          clearTimeout(timer)
          timer = null
        }
        fn()
      }

      timer = setTimeout(() => {
        settle(() => {
          const err = new Error(
            `[room-shadow-sync] Shutdown timed out after ${shutdownTimeoutMs}ms` +
              ` with ${inFlightPromises.size} unresolved operation(s)`,
          )
          lastError = err
          reject(err)
        })
      }, shutdownTimeoutMs)

      Promise.all(snapshot).then(
        () => {
          settle(() => resolve())
        },
        (error: unknown) => {
          // Неочакван reject от snapshot promise — defensive
          settle(() => {
            const err = normalizeError(error)
            lastError = err
            reject(err)
          })
        },
      )
    })

    return shutdownPromise
  }

  // ─── Public interface ─────────────────────────────────────────────────────────

  return {
    desireRoom,
    forgetRoom,
    forgetRoomAndWait,
    getHealth,
    shutdown,
  }
}
