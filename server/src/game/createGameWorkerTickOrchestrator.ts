import type { ServerRoom } from '../core/serverTypes.js'
import type { GameWorkerTickClient } from './createGameWorkerTickClient.js'
import type { RoomRevisionRegistry } from './createRoomRevisionRegistry.js'
import type { TickRoomsInput, TickRoomsResult } from './activeRoomRuntime.js'

// ─── Public types ─────────────────────────────────────────────────────────────

export type GameWorkerTickCandidateResult =
  | {
      roomId: string
      baseRevision: number
      kind: 'unchanged'
    }
  | {
      roomId: string
      baseRevision: number
      kind: 'advanced'
      room: ServerRoom
    }
  | {
      roomId: string
      baseRevision: number
      kind: 'stale'
    }
  | {
      roomId: string
      baseRevision: number
      kind: 'not_assigned'
      message: string
    }
  | {
      roomId: string
      baseRevision: number
      kind: 'compute_failed'
      message: string
    }

export type GameWorkerTickBatchResult =
  | {
      status: 'completed'
      results: GameWorkerTickCandidateResult[]
    }
  | {
      status: 'busy'
      results: []
    }
  | {
      status: 'failed'
      results: []
      message: string
    }

// ─── Narrow dependency types ──────────────────────────────────────────────────

type TickClientTarget = Pick<GameWorkerTickClient, 'computeTickRooms'>

type SyncTickTarget = {
  tickRooms(input: TickRoomsInput): TickRoomsResult
}

// ─── Config ───────────────────────────────────────────────────────────────────

export type GameWorkerTickOrchestratorConfig =
  | {
      mode: 'worker-candidate'
      revisionRegistry: RoomRevisionRegistry
      tickClient: TickClientTarget
    }
  | {
      mode: 'in-process'
      revisionRegistry: RoomRevisionRegistry
      syncTickTarget: SyncTickTarget
    }

// ─── Public interface ─────────────────────────────────────────────────────────

export type GameWorkerTickOrchestrator = {
  computeCandidates(input: {
    now: number
    rooms: ServerRoom[]
  }): Promise<GameWorkerTickBatchResult>

  shutdown(): Promise<void>
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function failed(message: string): GameWorkerTickBatchResult {
  return { status: 'failed', results: [], message }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createGameWorkerTickOrchestrator(
  config: GameWorkerTickOrchestratorConfig,
): GameWorkerTickOrchestrator {
  // Runtime config validation (fail-fast)
  if (config.mode === 'worker-candidate') {
    if (typeof config.tickClient?.computeTickRooms !== 'function') {
      throw new Error(
        '[tick-orchestrator] worker-candidate mode requires tickClient.computeTickRooms to be a function',
      )
    }
  } else {
    if (typeof config.syncTickTarget?.tickRooms !== 'function') {
      throw new Error(
        '[tick-orchestrator] in-process mode requires syncTickTarget.tickRooms to be a function',
      )
    }
  }

  const { revisionRegistry } = config

  let isShuttingDown = false
  let shutdownPromise: Promise<void> | null = null
  let inFlightBatch: Promise<GameWorkerTickBatchResult> | null = null

  // ─── Input validation ──────────────────────────────────────────────────────

  function validateInput(input: { now: number; rooms: ServerRoom[] }): string | null {
    if (!Number.isFinite(input.now)) {
      return `[tick-orchestrator] now must be a finite number, got ${String(input.now)}`
    }

    if (!Array.isArray(input.rooms) || input.rooms.length === 0) {
      return '[tick-orchestrator] rooms must be a non-empty array'
    }

    const seenIds = new Set<string>()

    for (const room of input.rooms) {
      if (room === null || typeof room !== 'object') {
        return '[tick-orchestrator] each room must be a non-null object'
      }

      const id: unknown = (room as Record<string, unknown>)['id']

      if (typeof id !== 'string' || id.trim() === '') {
        return `[tick-orchestrator] room.id must be a non-empty string`
      }

      if (seenIds.has(id)) {
        return `[tick-orchestrator] duplicate roomId=${id} in input`
      }

      seenIds.add(id)

      if (!revisionRegistry.has(id)) {
        return `[tick-orchestrator] roomId=${id} is not registered in revision registry. Call registry.ensure() first.`
      }
    }

    return null
  }

  // ─── Worker-candidate path ─────────────────────────────────────────────────

  async function runWorkerCandidate(
    rooms: ServerRoom[],
    now: number,
    tickClient: TickClientTarget,
  ): Promise<GameWorkerTickBatchResult> {
    // Capture baseRevisions before the async round-trip
    const inputs = rooms.map((room) => ({
      roomId: room.id,
      baseRevision: revisionRegistry.get(room.id)!,
      room,
    }))

    let workerResults
    try {
      workerResults = await tickClient.computeTickRooms(inputs, now)
    } catch (err) {
      return failed(normalizeError(err))
    }

    const results: GameWorkerTickCandidateResult[] = []

    for (const workerResult of workerResults) {
      const { roomId, baseRevision } = workerResult

      if (workerResult.result === 'error') {
        if (workerResult.code === 'not_assigned') {
          results.push({ roomId, baseRevision, kind: 'not_assigned', message: workerResult.message })
        } else {
          results.push({ roomId, baseRevision, kind: 'compute_failed', message: workerResult.message })
        }
        continue
      }

      // Post-response stale check: has revision changed since we sent the request?
      const currentRevision = revisionRegistry.get(roomId)
      if (currentRevision !== baseRevision) {
        results.push({ roomId, baseRevision, kind: 'stale' })
        continue
      }

      if (workerResult.result === 'unchanged') {
        results.push({ roomId, baseRevision, kind: 'unchanged' })
      } else {
        results.push({ roomId, baseRevision, kind: 'advanced', room: workerResult.room })
      }
    }

    return { status: 'completed', results }
  }

  // ─── Sync in-process path ──────────────────────────────────────────────────

  function runSyncCandidate(
    rooms: ServerRoom[],
    now: number,
    syncTarget: SyncTickTarget,
  ): GameWorkerTickBatchResult {
    let syncResult: TickRoomsResult
    try {
      syncResult = syncTarget.tickRooms({ now, rooms })
    } catch (err) {
      return failed(normalizeError(err))
    }

    const results: GameWorkerTickCandidateResult[] = []

    for (const tickResult of syncResult.results) {
      const baseRevision = revisionRegistry.get(tickResult.roomId)

      if (baseRevision === null) {
        return failed(
          `[tick-orchestrator] sync tick returned unregistered roomId=${tickResult.roomId}`,
        )
      }

      if (tickResult.kind === 'unchanged') {
        results.push({ roomId: tickResult.roomId, baseRevision, kind: 'unchanged' })
      } else {
        results.push({ roomId: tickResult.roomId, baseRevision, kind: 'advanced', room: tickResult.room })
      }
    }

    return { status: 'completed', results }
  }

  // ─── computeCandidates ─────────────────────────────────────────────────────

  async function computeCandidates(input: {
    now: number
    rooms: ServerRoom[]
  }): Promise<GameWorkerTickBatchResult> {
    if (isShuttingDown) {
      return failed('[tick-orchestrator] computeCandidates() called after shutdown')
    }

    // In-flight guard: skip if a batch is already running
    if (inFlightBatch !== null) {
      return { status: 'busy', results: [] }
    }

    const validationError = validateInput(input)
    if (validationError !== null) {
      return failed(validationError)
    }

    const { now, rooms } = input

    if (config.mode === 'in-process') {
      const batchPromise = Promise.resolve(runSyncCandidate(rooms, now, config.syncTickTarget))
      inFlightBatch = batchPromise

      try {
        return await batchPromise
      } finally {
        inFlightBatch = null
      }
    }

    // Worker-candidate mode
    const batchPromise = runWorkerCandidate(rooms, now, config.tickClient)
    inFlightBatch = batchPromise

    try {
      return await batchPromise
    } finally {
      inFlightBatch = null
    }
  }

  // ─── shutdown ──────────────────────────────────────────────────────────────

  function shutdown(): Promise<void> {
    if (shutdownPromise !== null) return shutdownPromise

    isShuttingDown = true

    shutdownPromise = (async () => {
      if (inFlightBatch !== null) {
        await inFlightBatch.catch(() => {})
      }
    })()

    return shutdownPromise
  }

  // ─── Public interface ──────────────────────────────────────────────────────

  return {
    computeCandidates,
    shutdown,
  }
}
