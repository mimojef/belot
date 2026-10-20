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
  // Bounded retry diagnostics (кумулативни броячи, без roomId ключове).
  scheduledRetries: number
  assignRetryCount: number
  releaseRetryCount: number
  assignFailureCount: number
  releaseFailureCount: number
  retriesExhaustedCount: number
}

export type RoomShadowSynchronizer = {
  desireRoom(roomId: string): void
  forgetRoom(roomId: string): void
  forgetRoomAndWait(roomId: string): Promise<void>
  getHealth(): RoomShadowSynchronizerHealth
  shutdown(): Promise<void>
}

type RetryTimerHandle = ReturnType<typeof setTimeout>

export type RoomShadowSynchronizerConfig = {
  client: RoomShadowWorkerClient
  shutdownTimeoutMs?: number
  // Backoff преди всеки retry; дължината е максималният брой retries.
  retryDelaysMs?: readonly number[]
  // Injectable за детерминистични тестове.
  setTimer?: (callback: () => void, delayMs: number) => RetryTimerHandle
  clearTimer?: (handle: RetryTimerHandle) => void
}

type ReleaseWaiter = {
  roomId: string
  resolve: () => void
  reject: (error: Error) => void
}

type SyncAction = 'assign' | 'release'

type RetryState = {
  // Брой вече планирани retries в текущия неуспешен цикъл.
  attempts: number
  timer: RetryTimerHandle | null
  exhausted: boolean
}

type ReconcileTrigger = 'external' | 'retry' | 'followup'

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
export const DEFAULT_ROOM_SHADOW_RETRY_DELAYS_MS: readonly number[] = [1000, 2000, 4000]

// Retry модел (виж audit-а на fe8694b): assign/release заявка може да изтече
// (5000 ms lifecycle timeout), докато worker-ът реално я е изпълнил — късният
// ACK се игнорира от lifecycle client-а. Затова всеки неуспех води до bounded
// retry с backoff, а при изтичане на backoff-а решението се взема НАНОВО от
// текущото desired/confirmed състояние (никога replay на старата операция).
// assign_room/release_room са идемпотентни в worker-а (already_assigned /
// not_assigned ack), затова retry след "успял, но ненаблюдаван" request е
// безопасен.
//
// uncertainRoomIds: стаи, чийто assign се е провалил с неизвестен изход
// (worker-ът може да ги има). Ако такава стая вече не е desired, се изпраща
// идемпотентен cleanup release, за да не остане тя при worker-а.
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

  const retryDelaysMs = config.retryDelaysMs ?? DEFAULT_ROOM_SHADOW_RETRY_DELAYS_MS

  if (
    !Array.isArray(retryDelaysMs) ||
    retryDelaysMs.some((delay) => !Number.isFinite(delay) || delay < 0)
  ) {
    throw new Error('[room-shadow-sync] retryDelaysMs must be an array of finite non-negative numbers')
  }

  const setTimer = config.setTimer ?? ((callback: () => void, delayMs: number): RetryTimerHandle => {
    const handle = setTimeout(callback, delayMs)
    handle.unref?.()
    return handle
  })
  const clearTimer = config.clearTimer ?? ((handle: RetryTimerHandle) => clearTimeout(handle))

  // ─── Internal state ──────────────────────────────────────────────────────────

  const desiredRoomIds = new Set<string>()
  const confirmedRoomIds = new Set<string>()
  const uncertainRoomIds = new Set<string>()

  // Най-много една in-flight операция на стая; opId пази срещу stale completion.
  const pendingByRoomId = new Map<string, { action: SyncAction; opId: number }>()
  const retryByRoomId = new Map<string, RetryState>()
  const inFlightPromises = new Set<Promise<void>>()
  const releaseWaiters = new Set<ReleaseWaiter>()

  // Неразрешени sync грешки по стая — изчистват се само когато ТАЗИ стая
  // convergне. Несвързан успех не ги скрива.
  const unresolvedErrorByRoomId = new Map<string, Error>()
  // Грешки без стая (невалиден roomId и т.н.) — старата семантика.
  let generalError: Error | null = null

  let nextOpId = 0
  let assignRetryCount = 0
  let releaseRetryCount = 0
  let assignFailureCount = 0
  let releaseFailureCount = 0
  let retriesExhaustedCount = 0

  let isShuttingDown = false
  let shutdownPromise: Promise<void> | null = null

  function recordRoomError(roomId: string, error: Error): void {
    // delete + set → най-новата грешка е последна (за lastError).
    unresolvedErrorByRoomId.delete(roomId)
    unresolvedErrorByRoomId.set(roomId, error)
  }

  function currentLastError(): Error | null {
    let latest: Error | null = null
    for (const error of unresolvedErrorByRoomId.values()) latest = error
    return latest ?? generalError
  }

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

  // Release waiter-ите чакат само докато стаята е confirmed или има in-flight
  // assign/release на confirmed стая — същата семантика като преди. Cleanup
  // release на uncertain стая е фонов и не задържа waiter-а.
  function settleReleasedIfConfirmed(roomId: string): void {
    if (confirmedRoomIds.has(roomId)) return
    const pending = pendingByRoomId.get(roomId)
    if (pending === undefined || (pending.action === 'release' && uncertainRoomIds.has(roomId))) {
      resolveReleaseWaiters(roomId)
    }
  }

  function clearRetry(roomId: string): void {
    const retry = retryByRoomId.get(roomId)
    if (retry === undefined) return
    if (retry.timer !== null) clearTimer(retry.timer)
    retryByRoomId.delete(roomId)
  }

  function decideAction(roomId: string): SyncAction | null {
    const desired = desiredRoomIds.has(roomId)
    const confirmed = confirmedRoomIds.has(roomId)
    if (desired && !confirmed) return 'assign'
    if (!desired && (confirmed || uncertainRoomIds.has(roomId))) return 'release'
    return null
  }

  function markConverged(roomId: string): void {
    clearRetry(roomId)
    unresolvedErrorByRoomId.delete(roomId)
    if (confirmedRoomIds.has(roomId)) uncertainRoomIds.delete(roomId)
    settleReleasedIfConfirmed(roomId)
  }

  // ─── Retry scheduling ─────────────────────────────────────────────────────────

  function scheduleRetry(roomId: string, failedAction: SyncAction, error: Error): void {
    let retry = retryByRoomId.get(roomId)
    if (retry === undefined) {
      retry = { attempts: 0, timer: null, exhausted: false }
      retryByRoomId.set(roomId, retry)
    }
    if (retry.timer !== null) return

    if (retry.attempts >= retryDelaysMs.length) {
      if (!retry.exhausted) {
        retry.exhausted = true
        retriesExhaustedCount += 1
      }
      // Bounded stop. Release waiter на confirmed стая получава грешката
      // (старата семантика при неуспешен release, само след retries).
      if (failedAction === 'release' && confirmedRoomIds.has(roomId)) {
        rejectReleaseWaiters(roomId, error)
      }
      settleReleasedIfConfirmed(roomId)
      return
    }

    const delayMs = retryDelaysMs[retry.attempts]!
    retry.attempts += 1
    const state = retry
    state.timer = setTimer(() => {
      state.timer = null
      if (isShuttingDown) return
      reconcileRoom(roomId, 'retry')
    }, delayMs)
  }

  // ─── Operation dispatch ───────────────────────────────────────────────────────

  function runOperation(roomId: string, action: SyncAction, isRetry: boolean): void {
    const opId = (nextOpId += 1)
    pendingByRoomId.set(roomId, { action, opId })
    if (isRetry) {
      if (action === 'assign') assignRetryCount += 1
      else releaseRetryCount += 1
    }

    const operation = Promise.resolve()
      .then((): Promise<unknown> => (action === 'assign'
        ? config.client.assignRoom(roomId)
        : config.client.releaseRoom(roomId)))
      .then(
        () => {
          if (pendingByRoomId.get(roomId)?.opId !== opId) return
          pendingByRoomId.delete(roomId)
          if (action === 'assign') {
            confirmedRoomIds.add(roomId)
            uncertainRoomIds.delete(roomId)
          } else {
            confirmedRoomIds.delete(roomId)
            uncertainRoomIds.delete(roomId)
          }
          // Успех = прогрес: нов retry цикъл, ако потрябва.
          clearRetry(roomId)
          generalError = null

          if (!isShuttingDown) {
            reconcileRoom(roomId, 'followup')
          } else {
            settleReleasedIfConfirmed(roomId)
          }
        },
        (error: unknown) => {
          if (pendingByRoomId.get(roomId)?.opId !== opId) return
          pendingByRoomId.delete(roomId)
          const err = normalizeError(error)
          handleOperationFailure(roomId, action, err)
        },
      )
      .catch((error: unknown) => {
        // Defensive catch за неочаквана грешка в нашите handlers.
        const err = normalizeError(error)
        if (pendingByRoomId.get(roomId)?.opId === opId) pendingByRoomId.delete(roomId)
        recordRoomError(roomId, err)
        settleReleasedIfConfirmed(roomId)
      })

    inFlightPromises.add(operation)

    void operation.then(() => {
      inFlightPromises.delete(operation)
    })
  }

  function handleOperationFailure(roomId: string, action: SyncAction, error: Error): void {
    if (action === 'assign') {
      assignFailureCount += 1
      // Изходът е неизвестен (напр. timeout с късен ACK) — worker-ът може да
      // има стаята.
      uncertainRoomIds.add(roomId)
    } else {
      releaseFailureCount += 1
    }
    recordRoomError(roomId, error)

    if (isShuttingDown) {
      settleReleasedIfConfirmed(roomId)
      return
    }

    // Ако междувременно няма нужда от действие (напр. desired се е върнал
    // при confirmed стая), стаята вече е convergнала.
    if (decideAction(roomId) === null) {
      markConverged(roomId)
      return
    }

    scheduleRetry(roomId, action, error)
    settleReleasedIfConfirmed(roomId)
  }

  // ─── reconcileRoom ───────────────────────────────────────────────────────────

  function reconcileRoom(roomId: string, trigger: ReconcileTrigger): void {
    try {
      // [1] Без действие при shutdown
      if (isShuttingDown) return

      // [2] Най-много една in-flight операция на стая; completion-ът ще
      // извика reconcile отново с актуалното състояние.
      if (pendingByRoomId.has(roomId)) return

      // [3] Решение САМО от текущото desired/confirmed състояние
      const action = decideAction(roomId)

      if (action === null) {
        markConverged(roomId)
        return
      }

      const retry = retryByRoomId.get(roomId)

      // [4] Чакащ backoff: външни desire/forget не пращат нищо и не създават
      // втори timer — таймерът ще реши наново, когато изтече.
      if (retry !== undefined && retry.timer !== null && trigger !== 'retry') return

      // [5] След изчерпани retries само ново външно събитие започва нов цикъл.
      if (retry !== undefined && retry.exhausted) {
        if (trigger !== 'external') return
        retryByRoomId.delete(roomId)
      }

      // [6] Worker трябва да е ready (non-ready е terminal — без retry)
      const workerState = config.client.getState()

      if (workerState !== 'ready') {
        const error = new Error(
          `[room-shadow-sync] Cannot reconcile room=${roomId}: worker state=${workerState}`,
        )
        recordRoomError(roomId, error)
        clearRetry(roomId)
        if (action === 'release' && confirmedRoomIds.has(roomId)) {
          rejectReleaseWaiters(roomId, error)
        }
        settleReleasedIfConfirmed(roomId)
        return
      }

      runOperation(roomId, action, trigger === 'retry')
    } catch (error: unknown) {
      // Defensive: неочаквана синхронна грешка не трябва да достига caller-а
      recordRoomError(roomId, normalizeError(error))
    }
  }

  // ─── desireRoom ───────────────────────────────────────────────────────────────

  function desireRoom(roomId: string): void {
    if (isShuttingDown) return

    if (!isValidRoomId(roomId)) {
      generalError = new Error(
        `[room-shadow-sync] desireRoom() received invalid roomId: ${String(roomId)}`,
      )
      return
    }

    desiredRoomIds.add(roomId)
    reconcileRoom(roomId, 'external')
  }

  // ─── forgetRoom ───────────────────────────────────────────────────────────────

  function forgetRoom(roomId: string): void {
    if (isShuttingDown) return

    if (!isValidRoomId(roomId)) {
      generalError = new Error(
        `[room-shadow-sync] forgetRoom() received invalid roomId: ${String(roomId)}`,
      )
      return
    }

    desiredRoomIds.delete(roomId)
    reconcileRoom(roomId, 'external')
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
      generalError = error
      return Promise.reject(error)
    }

    desiredRoomIds.delete(roomId)

    if (!confirmedRoomIds.has(roomId) && !pendingByRoomId.has(roomId)) {
      // Не е потвърдена и няма in-flight операция — release-ът е завършен от
      // гледна точка на caller-а; евентуален cleanup на uncertain стая тече
      // във фонов режим.
      reconcileRoom(roomId, 'external')
      return Promise.resolve()
    }

    const promise = new Promise<void>((resolve, reject) => {
      releaseWaiters.add({ roomId, resolve, reject })
    })

    reconcileRoom(roomId, 'external')
    settleReleasedIfConfirmed(roomId)

    return promise
  }

  // ─── getHealth ───────────────────────────────────────────────────────────────

  function getHealth(): RoomShadowSynchronizerHealth {
    const workerState = config.client.getState()

    let scheduledRetries = 0
    for (const retry of retryByRoomId.values()) {
      if (retry.timer !== null) scheduledRetries += 1
    }

    const isConsistent =
      !isShuttingDown &&
      pendingByRoomId.size === 0 &&
      uncertainRoomIds.size === 0 &&
      workerState === 'ready' &&
      setsEqual(desiredRoomIds, confirmedRoomIds)

    return {
      desiredRooms: desiredRoomIds.size,
      confirmedRooms: confirmedRoomIds.size,
      pendingOperations: pendingByRoomId.size,
      workerState,
      isConsistent,
      isShuttingDown,
      lastError: currentLastError()?.message ?? null,
      scheduledRetries,
      assignRetryCount,
      releaseRetryCount,
      assignFailureCount,
      releaseFailureCount,
      retriesExhaustedCount,
    }
  }

  // ─── shutdown ────────────────────────────────────────────────────────────────

  function shutdown(): Promise<void> {
    if (shutdownPromise !== null) return shutdownPromise

    isShuttingDown = true

    // Retry timer-ите се чистят веднага — нищо ново не тръгва след shutdown.
    for (const roomId of [...retryByRoomId.keys()]) clearRetry(roomId)

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
          generalError = err
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
            generalError = err
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
