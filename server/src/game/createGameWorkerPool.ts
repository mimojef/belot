import {
  createGameWorkerLifecycleClient,
  type GameWorkerLifecycleClient,
  type GameWorkerLifecycleState,
} from './createGameWorkerLifecycleClient.js'
import {
  createGameWorkerTickClient,
  type GameWorkerTickClient,
} from './createGameWorkerTickClient.js'
import {
  createRoomShadowSynchronizer,
  type RoomShadowSynchronizer,
  type RoomShadowSynchronizerHealth,
} from './createRoomShadowSynchronizer.js'
import type {
  GameWorkerTickRoomInput,
  GameWorkerTickRoomResult,
} from './workerProtocol.js'

export type GameWorkerPoolState =
  | 'idle'
  | 'starting'
  | 'ready'
  | 'stopping'
  | 'stopped'
  | 'failed'

export type EnsurePoolRoomResult =
  | {
      ok: true
      workerId: string
      newlyAssigned: boolean
    }
  | {
      ok: false
      reason: 'no_capacity' | 'worker_unavailable'
    }

export type GameWorkerPoolConfig = {
  workerCount: number
  maxRoomsPerWorker: number
  workerEntryUrl: URL
  requestTimeoutMs?: number
}

export type GameWorkerPoolWorkerHealth = {
  workerId: string
  state: GameWorkerLifecycleState
  assignedRooms: number
  maxRooms: number
  shadow: RoomShadowSynchronizerHealth
  lastError: string | null
}

export type GameWorkerPoolHealth = {
  state: GameWorkerPoolState
  workerCount: number
  readyWorkers: number
  failedWorkers: number
  totalAssignedRooms: number
  maxRoomsPerWorker: number
  workers: GameWorkerPoolWorkerHealth[]
}

export type GameWorkerPool = {
  start(): Promise<void>
  ensureRoom(roomId: string): EnsurePoolRoomResult
  releaseRoom(roomId: string): Promise<void>
  getWorkerIdForRoom(roomId: string): string | null
  computeTickRooms(
    rooms: GameWorkerTickRoomInput[],
    now: number,
  ): Promise<GameWorkerTickRoomResult[]>
  getHealth(): GameWorkerPoolHealth
  shutdown(): Promise<void>
}

type WorkerBundle = {
  workerId: string
  index: number
  maxRooms: number
  lifecycleClient: GameWorkerLifecycleClient
  tickClient: GameWorkerTickClient
  shadowSynchronizer: RoomShadowSynchronizer
  assignedRoomIds: Set<string>
  lastError: Error | null
}

type WorkerGroupEntry = {
  input: GameWorkerTickRoomInput
  originalIndex: number
}

function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(
      `[worker-pool] Configuration error: ${name} must be a finite number, got ${value}`,
    )
  }

  if (!Number.isInteger(value)) {
    throw new Error(
      `[worker-pool] Configuration error: ${name} must be an integer, got ${value}`,
    )
  }

  if (value < 1) {
    throw new Error(
      `[worker-pool] Configuration error: ${name} must be at least 1, got ${value}`,
    )
  }

  return value
}

function requireValidWorkerEntryUrl(value: URL): URL {
  if (!(value instanceof URL)) {
    throw new Error(
      '[worker-pool] Configuration error: workerEntryUrl must be an instance of URL.',
    )
  }

  return value
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) return error
  return new Error(String(error))
}

function isValidRoomId(roomId: unknown): roomId is string {
  return typeof roomId === 'string' && roomId.trim() !== ''
}

function createComputeFailedResult(
  input: GameWorkerTickRoomInput,
  message: string,
): GameWorkerTickRoomResult {
  return {
    roomId: input.roomId,
    baseRevision: input.baseRevision,
    result: 'error',
    code: 'compute_failed',
    message,
  }
}

function createNotAssignedResult(
  input: GameWorkerTickRoomInput,
  message: string,
): GameWorkerTickRoomResult {
  return {
    roomId: input.roomId,
    baseRevision: input.baseRevision,
    result: 'error',
    code: 'not_assigned',
    message,
  }
}

async function cleanupBundle(bundle: WorkerBundle): Promise<void> {
  let firstError: Error | null = null

  try {
    await bundle.shadowSynchronizer.shutdown()
  } catch (error: unknown) {
    firstError = firstError ?? normalizeError(error)
  }

  try {
    await bundle.tickClient.shutdown()
  } catch (error: unknown) {
    firstError = firstError ?? normalizeError(error)
  }

  try {
    await bundle.lifecycleClient.shutdown()
  } catch (error: unknown) {
    firstError = firstError ?? normalizeError(error)
  }

  if (firstError !== null) {
    throw firstError
  }
}

export function createGameWorkerPool(
  config: GameWorkerPoolConfig,
): GameWorkerPool {
  const workerCount = requirePositiveInteger(config.workerCount, 'workerCount')
  const maxRoomsPerWorker = requirePositiveInteger(
    config.maxRoomsPerWorker,
    'maxRoomsPerWorker',
  )
  const workerEntryUrl = requireValidWorkerEntryUrl(config.workerEntryUrl)
  const { requestTimeoutMs } = config

  if (
    requestTimeoutMs !== undefined &&
    (!Number.isFinite(requestTimeoutMs) ||
      !Number.isInteger(requestTimeoutMs) ||
      requestTimeoutMs <= 0)
  ) {
    throw new Error(
      `[worker-pool] Configuration error: requestTimeoutMs must be a finite positive integer, got ${String(requestTimeoutMs)}`,
    )
  }

  let state: GameWorkerPoolState = 'idle'
  let startPromise: Promise<void> | null = null
  let shutdownPromise: Promise<void> | null = null

  const bundles: WorkerBundle[] = []
  const bundleByWorkerId = new Map<string, WorkerBundle>()
  const roomAssignments = new Map<string, string>()
  const releasePromisesByRoomId = new Map<string, Promise<void>>()

  function getWorkerId(index: number): string {
    return `game-worker-${index + 1}`
  }

  function pickWorker(): WorkerBundle | null {
    let selected: WorkerBundle | null = null

    for (const bundle of bundles) {
      if (bundle.lifecycleClient.getState() !== 'ready') {
        continue
      }

      if (bundle.assignedRoomIds.size >= bundle.maxRooms) {
        continue
      }

      if (
        selected === null ||
        bundle.assignedRoomIds.size < selected.assignedRoomIds.size ||
        (bundle.assignedRoomIds.size === selected.assignedRoomIds.size &&
          bundle.index < selected.index)
      ) {
        selected = bundle
      }
    }

    return selected
  }

  function hasReadyWorker(): boolean {
    return bundles.some((bundle) => bundle.lifecycleClient.getState() === 'ready')
  }

  function sanitizeWorkerError(error: Error | null): string | null {
    return error === null ? null : 'Worker operation failed.'
  }

  function sanitizeShadowHealth(
    health: RoomShadowSynchronizerHealth,
  ): RoomShadowSynchronizerHealth {
    return {
      ...health,
      lastError: health.lastError === null ? null : 'Shadow synchronization failed.',
    }
  }

  async function createBundle(index: number): Promise<WorkerBundle> {
    const workerId = getWorkerId(index)
    const lifecycleClient = createGameWorkerLifecycleClient({
      workerId,
      workerEntryUrl,
      requestTimeoutMs,
    })
    let tickClient: GameWorkerTickClient | null = null
    let shadowSynchronizer: RoomShadowSynchronizer | null = null

    try {
      await lifecycleClient.start()
      tickClient = createGameWorkerTickClient({
        endpoint: lifecycleClient.getMessageEndpoint(),
        requestTimeoutMs,
      })
      shadowSynchronizer = createRoomShadowSynchronizer({
        client: lifecycleClient,
      })

      return {
        workerId,
        index,
        maxRooms: maxRoomsPerWorker,
        lifecycleClient,
        tickClient,
        shadowSynchronizer,
        assignedRoomIds: new Set<string>(),
        lastError: null,
      }
    } catch (error: unknown) {
      if (shadowSynchronizer !== null) {
        await shadowSynchronizer.shutdown().catch(() => {})
      }
      if (tickClient !== null) {
        await tickClient.shutdown().catch(() => {})
      }
      await lifecycleClient.shutdown().catch(() => {})
      throw error
    }
  }

  async function cleanupStartedBundles(): Promise<void> {
    const cleanupErrors: Error[] = []

    for (let i = bundles.length - 1; i >= 0; i -= 1) {
      try {
        await cleanupBundle(bundles[i])
      } catch (error: unknown) {
        cleanupErrors.push(normalizeError(error))
      }
    }

    bundles.length = 0
    bundleByWorkerId.clear()
    roomAssignments.clear()
    releasePromisesByRoomId.clear()

    if (cleanupErrors.length > 0) {
      throw cleanupErrors[0]
    }
  }

  function start(): Promise<void> {
    if (state === 'ready') {
      return Promise.resolve()
    }

    if (state === 'starting' && startPromise !== null) {
      return startPromise
    }

    if (state !== 'idle') {
      return Promise.reject(
        new Error(`[worker-pool] Cannot start() from state=${state}.`),
      )
    }

    state = 'starting'

    startPromise = (async () => {
      try {
        for (let index = 0; index < workerCount; index += 1) {
          const bundle = await createBundle(index)
          bundles.push(bundle)
          bundleByWorkerId.set(bundle.workerId, bundle)
        }

        state = 'ready'
      } catch (error: unknown) {
        state = 'failed'
        await cleanupStartedBundles().catch(() => {})
        throw error
      }
    })()

    return startPromise
  }

  function ensureRoom(roomId: string): EnsurePoolRoomResult {
    if (!isValidRoomId(roomId)) {
      throw new Error(
        `[worker-pool] ensureRoom() requires a non-empty roomId, got ${String(roomId)}`,
      )
    }

    const existingWorkerId = roomAssignments.get(roomId) ?? null

    if (existingWorkerId !== null) {
      return {
        ok: true,
        workerId: existingWorkerId,
        newlyAssigned: false,
      }
    }

    if (state !== 'ready') {
      return { ok: false, reason: 'worker_unavailable' }
    }

    const worker = pickWorker()

    if (worker === null) {
      return {
        ok: false,
        reason: hasReadyWorker() ? 'no_capacity' : 'worker_unavailable',
      }
    }

    roomAssignments.set(roomId, worker.workerId)
    worker.assignedRoomIds.add(roomId)

    try {
      worker.shadowSynchronizer.desireRoom(roomId)
    } catch (error: unknown) {
      worker.lastError = normalizeError(error)
    }

    return {
      ok: true,
      workerId: worker.workerId,
      newlyAssigned: true,
    }
  }

  function releaseRoom(roomId: string): Promise<void> {
    if (!isValidRoomId(roomId)) {
      return Promise.resolve()
    }

    const existingRelease = releasePromisesByRoomId.get(roomId) ?? null

    if (existingRelease !== null) {
      return existingRelease
    }

    const workerId = roomAssignments.get(roomId) ?? null

    if (workerId === null) {
      return Promise.resolve()
    }

    const bundle = bundleByWorkerId.get(workerId) ?? null

    if (bundle === null) {
      return Promise.reject(
        new Error(`[worker-pool] Assigned worker=${workerId} is not available.`),
      )
    }

    const releasePromise = bundle.shadowSynchronizer
      .forgetRoomAndWait(roomId)
      .then(() => {
        roomAssignments.delete(roomId)
        bundle.assignedRoomIds.delete(roomId)
        bundle.lastError = null
      })
      .catch((error: unknown) => {
        const normalized = normalizeError(error)
        bundle.lastError = normalized
        throw normalized
      })
      .finally(() => {
        releasePromisesByRoomId.delete(roomId)
      })

    releasePromisesByRoomId.set(roomId, releasePromise)

    return releasePromise
  }

  function getWorkerIdForRoom(roomId: string): string | null {
    return roomAssignments.get(roomId) ?? null
  }

  function validateTickInputs(
    rooms: GameWorkerTickRoomInput[],
    now: number,
  ): void {
    if (state !== 'ready') {
      throw new Error(`[worker-pool] computeTickRooms() requires state=ready, got state=${state}.`)
    }

    if (!Number.isFinite(now)) {
      throw new Error(`[worker-pool] now must be a finite number, got ${String(now)}`)
    }

    if (!Array.isArray(rooms) || rooms.length === 0) {
      throw new Error('[worker-pool] rooms must be a non-empty array.')
    }

    const seenIds = new Set<string>()

    for (const input of rooms) {
      if (!isValidRoomId(input.roomId)) {
        throw new Error('[worker-pool] Each room input must have a non-empty roomId.')
      }

      if (seenIds.has(input.roomId)) {
        throw new Error(`[worker-pool] Duplicate roomId=${input.roomId} in input.`)
      }

      seenIds.add(input.roomId)

      if (
        typeof input.baseRevision !== 'number' ||
        !Number.isInteger(input.baseRevision) ||
        input.baseRevision < 0 ||
        !Number.isSafeInteger(input.baseRevision)
      ) {
        throw new Error(
          `[worker-pool] baseRevision for roomId=${input.roomId} must be a non-negative safe integer.`,
        )
      }

      if (
        input.room === null ||
        typeof input.room !== 'object' ||
        (input.room as Record<string, unknown>)['id'] !== input.roomId
      ) {
        throw new Error(
          `[worker-pool] room.id must equal roomId for roomId=${input.roomId}.`,
        )
      }
    }
  }

  async function computeTickRooms(
    rooms: GameWorkerTickRoomInput[],
    now: number,
  ): Promise<GameWorkerTickRoomResult[]> {
    validateTickInputs(rooms, now)

    const orderedResults = new Array<GameWorkerTickRoomResult>(rooms.length)
    const groupsByWorkerId = new Map<string, WorkerGroupEntry[]>()

    for (let i = 0; i < rooms.length; i += 1) {
      const input = rooms[i]
      const workerId = roomAssignments.get(input.roomId) ?? null

      if (workerId === null) {
        orderedResults[i] = createNotAssignedResult(
          input,
          'Room has no worker assignment.',
        )
        continue
      }

      const bundle = bundleByWorkerId.get(workerId) ?? null

      if (bundle === null) {
        orderedResults[i] = createComputeFailedResult(
          input,
          `Assigned worker=${workerId} is not available.`,
        )
        continue
      }

      const workerState = bundle.lifecycleClient.getState()

      if (workerState !== 'ready') {
        orderedResults[i] = createComputeFailedResult(
          input,
          `Assigned worker=${workerId} is not ready: state=${workerState}.`,
        )
        continue
      }

      const group = groupsByWorkerId.get(workerId) ?? []
      group.push({ input, originalIndex: i })
      groupsByWorkerId.set(workerId, group)
    }

    await Promise.all(
      [...groupsByWorkerId.entries()].map(async ([workerId, group]) => {
        const bundle = bundleByWorkerId.get(workerId)

        if (bundle === undefined) {
          for (const entry of group) {
            orderedResults[entry.originalIndex] = createComputeFailedResult(
              entry.input,
              `Assigned worker=${workerId} is not available.`,
            )
          }
          return
        }

        try {
          const workerResults = await bundle.tickClient.computeTickRooms(
            group.map((entry) => entry.input),
            now,
          )
          const inputByRoomId = new Map(
            group.map((entry) => [entry.input.roomId, entry.input] as const),
          )
          const resultByRoomId = new Map<string, GameWorkerTickRoomResult>()

          for (const result of workerResults) {
            const expectedInput = inputByRoomId.get(result.roomId) ?? null

            if (expectedInput === null) {
              continue
            }

            if (
              result.roomId !== expectedInput.roomId ||
              result.baseRevision !== expectedInput.baseRevision
            ) {
              resultByRoomId.set(
                expectedInput.roomId,
                createComputeFailedResult(
                  expectedInput,
                  `Worker=${workerId} returned mismatched roomId or baseRevision.`,
                ),
              )
              continue
            }

            resultByRoomId.set(expectedInput.roomId, result)
          }

          for (const entry of group) {
            const result = resultByRoomId.get(entry.input.roomId) ?? null
            orderedResults[entry.originalIndex] =
              result ??
              createComputeFailedResult(
                entry.input,
                `Worker=${workerId} did not return a result for room=${entry.input.roomId}.`,
              )
          }

          bundle.lastError = null
        } catch (error: unknown) {
          const normalized = normalizeError(error)
          bundle.lastError = normalized

          for (const entry of group) {
            orderedResults[entry.originalIndex] = createComputeFailedResult(
              entry.input,
              normalized.message,
            )
          }
        }
      }),
    )

    for (let i = 0; i < orderedResults.length; i += 1) {
      if (orderedResults[i] === undefined) {
        orderedResults[i] = createComputeFailedResult(
          rooms[i],
          `[worker-pool] Missing tick result at index=${i}.`,
        )
      }
    }

    return orderedResults
  }

  function getHealth(): GameWorkerPoolHealth {
    const workers = bundles.map((bundle) => {
      const workerState = bundle.lifecycleClient.getState()

      return {
        workerId: bundle.workerId,
        state: workerState,
        assignedRooms: bundle.assignedRoomIds.size,
        maxRooms: bundle.maxRooms,
        shadow: sanitizeShadowHealth(bundle.shadowSynchronizer.getHealth()),
        lastError: sanitizeWorkerError(bundle.lastError),
      }
    })

    return {
      state,
      workerCount,
      readyWorkers: workers.filter((worker) => worker.state === 'ready').length,
      failedWorkers: workers.filter((worker) => worker.state === 'failed').length,
      totalAssignedRooms: roomAssignments.size,
      maxRoomsPerWorker,
      workers,
    }
  }

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

    if (state === 'starting' && startPromise !== null) {
      shutdownPromise = startPromise
        .catch(() => {})
        .then(() => shutdown())
      return shutdownPromise
    }

    state = 'stopping'

    shutdownPromise = (async () => {
      const errors: Error[] = []

      for (let i = bundles.length - 1; i >= 0; i -= 1) {
        try {
          await cleanupBundle(bundles[i])
        } catch (error: unknown) {
          errors.push(normalizeError(error))
        }
      }

      roomAssignments.clear()
      releasePromisesByRoomId.clear()
      bundleByWorkerId.clear()
      bundles.length = 0

      if (errors.length > 0) {
        state = 'failed'
        throw errors[0]
      }

      state = 'stopped'
    })()

    return shutdownPromise
  }

  return {
    start,
    ensureRoom,
    releaseRoom,
    getWorkerIdForRoom,
    computeTickRooms,
    getHealth,
    shutdown,
  }
}
