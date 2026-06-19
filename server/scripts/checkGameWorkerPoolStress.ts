import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import type { ServerRoom } from '../src/core/serverTypes.js'
import { addBotToRoom } from '../src/core/addBotToRoom.js'
import { addHumanToRoom } from '../src/core/addHumanToRoom.js'
import { createRoomWithHumanHost } from '../src/core/createRoomWithHumanHost.js'
import { createGameWorkerPool, type GameWorkerPool } from '../src/game/createGameWorkerPool.js'
import {
  createGameWorkerTickOrchestrator,
  type GameWorkerTickCandidateResult,
} from '../src/game/createGameWorkerTickOrchestrator.js'
import { createRoomRevisionRegistry } from '../src/game/createRoomRevisionRegistry.js'
import { initializeRoomAuthoritativeGameState } from '../src/game/initializeRoomAuthoritativeGameState.js'
import { resolveGameWorkerEntryUrl } from '../src/game/resolveGameWorkerEntryUrl.js'

type RoomRecord = {
  room: ServerRoom
}

type HealthSummary = {
  state: string
  workerCount: number
  readyWorkers: number
  failedWorkers: number
  totalAssignedRooms: number
  maxRoomsPerWorker: number
  workers: Array<{
    workerId: string
    state: string
    assignedRooms: number
    maxRooms: number
    pendingShadow: number
    lastError: string | null
  }>
}

type MemorySummary = {
  rssMb: number
  heapUsedMb: number
  heapTotalMb: number
  externalMb: number
}

type StressLevelSummary = {
  rooms: number
  distribution: Record<string, number>
  tickLatenciesMs: number[]
  avgTickLatencyMs: number
  maxTickLatencyMs: number
  totalBatchTimeMs: number
  roomsPerSecond: number
  resultsPerSecond: number
  memoryBefore: MemorySummary
  memoryAfter: MemorySummary
  healthBeforeRelease: HealthSummary
  healthAfterRelease: HealthSummary
  shutdownHealth: HealthSummary
}

const ROOM_LEVELS = [20, 50, 100, 200] as const
const WORKER_COUNT = 2
const MAX_ROOMS_PER_WORKER = 100
const TICK_BATCHES_PER_LEVEL = 3
const LEVEL_TIMEOUT_MS = 60_000

let passCount = 0
let failCount = 0
const unhandledErrors: string[] = []

process.on('unhandledRejection', (reason) => {
  unhandledErrors.push(reason instanceof Error ? reason.message : String(reason))
})

process.on('uncaughtException', (error) => {
  unhandledErrors.push(error.message)
  throw error
})

function pass(label: string): void {
  passCount += 1
  console.log(`  PASS ${label}`)
}

function fail(label: string, error: unknown): void {
  failCount += 1
  const msg = error instanceof Error ? error.message : String(error)
  console.error(`  FAIL ${label}: ${msg}`)
}

async function check(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    pass(label)
  } catch (error: unknown) {
    fail(label, error)
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

function memorySummary(): MemorySummary {
  const memory = process.memoryUsage()

  return {
    rssMb: round(memory.rss / 1024 / 1024),
    heapUsedMb: round(memory.heapUsed / 1024 / 1024),
    heapTotalMb: round(memory.heapTotal / 1024 / 1024),
    externalMb: round(memory.external / 1024 / 1024),
  }
}

function buildRealisticRoom(id: string): ServerRoom {
  const { room: r1 } = createRoomWithHumanHost({
    roomId: id,
    connectionId: `conn-${id}-1`,
    identity: { displayName: 'Player 1' },
  })
  const { room: r2 } = addHumanToRoom(r1, {
    connectionId: `conn-${id}-2`,
    identity: { displayName: 'Player 2' },
  })
  const { room: r3 } = addBotToRoom(r2, {
    difficulty: 'normal',
    behaviorPreset: 'balanced',
    identity: { displayName: 'Bot 3' },
  })
  const { room: r4 } = addBotToRoom(r3, {
    difficulty: 'normal',
    behaviorPreset: 'balanced',
    identity: { displayName: 'Bot 4' },
  })
  return initializeRoomAuthoritativeGameState(r4)
}

function buildRooms(prefix: string, count: number): Map<string, RoomRecord> {
  const rooms = new Map<string, RoomRecord>()

  for (let index = 1; index <= count; index += 1) {
    const roomId = `${prefix}-${String(index).padStart(3, '0')}`
    rooms.set(roomId, { room: buildRealisticRoom(roomId) })
  }

  return rooms
}

function getFarFutureNow(rooms: Iterable<RoomRecord>): number {
  let now = Date.now()

  for (const record of rooms) {
    now = Math.max(
      now,
      record.room.game.timerDeadlineAt ?? record.room.updatedAt,
    )
  }

  return now + 60_000
}

function summarizeHealth(pool: GameWorkerPool): HealthSummary {
  const health = pool.getHealth()

  return {
    state: health.state,
    workerCount: health.workerCount,
    readyWorkers: health.readyWorkers,
    failedWorkers: health.failedWorkers,
    totalAssignedRooms: health.totalAssignedRooms,
    maxRoomsPerWorker: health.maxRoomsPerWorker,
    workers: health.workers.map((worker) => ({
      workerId: worker.workerId,
      state: worker.state,
      assignedRooms: worker.assignedRooms,
      maxRooms: worker.maxRooms,
      pendingShadow: worker.shadow.pendingOperations,
      lastError: worker.lastError,
    })),
  }
}

function assertHealthyPool(health: HealthSummary, expectedRooms: number): void {
  assert.equal(health.state, 'ready')
  assert.equal(health.workerCount, WORKER_COUNT)
  assert.equal(health.readyWorkers, WORKER_COUNT)
  assert.equal(health.failedWorkers, 0)
  assert.equal(health.totalAssignedRooms, expectedRooms)
  assert.equal(health.workers.length, WORKER_COUNT)

  for (const worker of health.workers) {
    assert.equal(worker.state, 'ready')
    assert.equal(worker.assignedRooms <= worker.maxRooms, true)
    assert.equal(worker.assignedRooms <= MAX_ROOMS_PER_WORKER, true)
    assert.equal(worker.pendingShadow, 0)
    assert.equal(worker.lastError, null)
  }
}

function getDistributionCounts(
  pool: GameWorkerPool,
  roomIds: readonly string[],
): Record<string, number> {
  const ownerByRoomId = new Map<string, string>()
  const distribution: Record<string, number> = {}

  for (const roomId of roomIds) {
    const workerId = pool.getWorkerIdForRoom(roomId)
    assert.notEqual(workerId, null, `room=${roomId} should have an owner`)
    assert.equal(ownerByRoomId.has(roomId), false, `duplicate room owner for room=${roomId}`)
    ownerByRoomId.set(roomId, workerId!)
    distribution[workerId!] = (distribution[workerId!] ?? 0) + 1
  }

  assert.equal(ownerByRoomId.size, roomIds.length)
  assert.deepStrictEqual(Object.keys(distribution), ['game-worker-1', 'game-worker-2'])

  return distribution
}

function assertDeterministicBalancedDistribution(
  distribution: Record<string, number>,
  expectedRooms: number,
): void {
  assert.equal(distribution['game-worker-1'], Math.ceil(expectedRooms / 2))
  assert.equal(distribution['game-worker-2'], Math.floor(expectedRooms / 2))
}

function summarizeResultKinds(
  results: readonly GameWorkerTickCandidateResult[],
): Record<string, number> {
  const summary: Record<string, number> = {}

  for (const result of results) {
    summary[result.kind] = (summary[result.kind] ?? 0) + 1
  }

  return summary
}

function validateTickResults(
  results: readonly GameWorkerTickCandidateResult[],
  expectedRooms: readonly ServerRoom[],
  revisionRegistry: ReturnType<typeof createRoomRevisionRegistry>,
): void {
  assert.equal(results.length, expectedRooms.length)

  const expectedRoomIds = expectedRooms.map((room) => room.id)
  const expectedRoomIdSet = new Set(expectedRoomIds)
  const seenResultIds = new Set<string>()

  for (let index = 0; index < results.length; index += 1) {
    const result = results[index]
    const expectedRoom = expectedRooms[index]

    assert.equal(
      result.roomId,
      expectedRoom.id,
      `result at index=${index} was mapped to the wrong room`,
    )
    assert.equal(
      result.baseRevision,
      revisionRegistry.get(result.roomId),
      `baseRevision mismatch for room=${result.roomId}`,
    )
    assert.equal(
      expectedRoomIdSet.has(result.roomId),
      true,
      `unexpected result roomId=${result.roomId}`,
    )
    assert.equal(
      seenResultIds.has(result.roomId),
      false,
      `duplicate result roomId=${result.roomId}`,
    )
    assert.notEqual(result.kind, 'not_assigned')
    assert.notEqual(result.kind, 'compute_failed')

    if (result.kind === 'advanced') {
      assert.equal(result.room.id, result.roomId)
    }

    seenResultIds.add(result.roomId)
  }

  for (const expectedRoomId of expectedRoomIds) {
    assert.equal(
      seenResultIds.has(expectedRoomId),
      true,
      `missing result for room=${expectedRoomId}`,
    )
  }
}

function applyAdvancedResults(
  roomsById: Map<string, RoomRecord>,
  results: readonly GameWorkerTickCandidateResult[],
  revisionRegistry: ReturnType<typeof createRoomRevisionRegistry>,
): void {
  for (const result of results) {
    if (result.kind !== 'advanced') {
      continue
    }

    roomsById.set(result.roomId, { room: result.room })
    revisionRegistry.bump(result.roomId)
  }
}

async function waitFor(
  label: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return
    }

    await new Promise((resolve) => setTimeout(resolve, 25))
  }

  throw new Error(`Timed out waiting for ${label}`)
}

async function waitForShadowIdle(pool: GameWorkerPool): Promise<void> {
  await waitFor(
    'all worker shadow synchronizers to become idle',
    () =>
      pool.getHealth().workers.every(
        (worker) => worker.shadow.pendingOperations === 0,
      ),
  )
}

async function withTimeout<T>(
  label: string,
  timeoutMs: number,
  action: () => Promise<T>,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null

  try {
    return await Promise.race([
      action(),
      new Promise<T>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        )
      }),
    ])
  } finally {
    if (timeout !== null) {
      clearTimeout(timeout)
    }
  }
}

async function runStressLevel(
  workerEntryUrl: URL,
  roomCount: number,
): Promise<StressLevelSummary> {
  const memoryBefore = memorySummary()
  const pool = createGameWorkerPool({
    workerCount: WORKER_COUNT,
    maxRoomsPerWorker: MAX_ROOMS_PER_WORKER,
    workerEntryUrl,
    requestTimeoutMs: 20_000,
  })
  const revisionRegistry = createRoomRevisionRegistry()
  const orchestrator = createGameWorkerTickOrchestrator({
    mode: 'worker-candidate',
    revisionRegistry,
    tickClient: pool,
  })
  let shutdownHealth: HealthSummary | null = null

  try {
    await pool.start()
    const roomsById = buildRooms(`stress-${roomCount}-room`, roomCount)
    const roomIds = [...roomsById.keys()]

    for (const roomId of roomIds) {
      revisionRegistry.ensure(roomId)
      const result = pool.ensureRoom(roomId)
      assert.equal(result.ok, true, `ensureRoom failed for room=${roomId}`)
    }

    await waitForShadowIdle(pool)

    const distribution = getDistributionCounts(pool, roomIds)
    assertDeterministicBalancedDistribution(distribution, roomCount)

    const healthAfterAssign = summarizeHealth(pool)
    assertHealthyPool(healthAfterAssign, roomCount)

    const tickLatenciesMs: number[] = []
    const batchStartedAt = performance.now()
    let totalResults = 0

    for (let batchIndex = 0; batchIndex < TICK_BATCHES_PER_LEVEL; batchIndex += 1) {
      const rooms = [...roomsById.values()].map((record) => record.room)
      const tickStartedAt = performance.now()
      const batch = await orchestrator.computeCandidates({
        now: getFarFutureNow(roomsById.values()),
        rooms,
      })
      const tickLatencyMs = performance.now() - tickStartedAt

      tickLatenciesMs.push(tickLatencyMs)
      assert.equal(batch.status, 'completed')

      validateTickResults(batch.results, rooms, revisionRegistry)
      applyAdvancedResults(roomsById, batch.results, revisionRegistry)
      totalResults += batch.results.length

      console.log(
        `  stress ${roomCount} batch ${batchIndex + 1}: ` +
          JSON.stringify({
            latencyMs: round(tickLatencyMs),
            results: batch.results.length,
            kinds: summarizeResultKinds(batch.results),
          }),
      )
    }

    const totalBatchTimeMs = performance.now() - batchStartedAt
    const avgTickLatencyMs =
      tickLatenciesMs.reduce((sum, value) => sum + value, 0) / tickLatenciesMs.length
    const maxTickLatencyMs = Math.max(...tickLatenciesMs)

    const healthBeforeRelease = summarizeHealth(pool)
    assertHealthyPool(healthBeforeRelease, roomCount)

    await Promise.all(roomIds.map((roomId) => pool.releaseRoom(roomId)))
    await waitForShadowIdle(pool)

    const healthAfterRelease = summarizeHealth(pool)
    assertHealthyPool({ ...healthAfterRelease, totalAssignedRooms: 0 }, 0)
    assert.equal(healthAfterRelease.totalAssignedRooms, 0)
    assert.deepStrictEqual(
      healthAfterRelease.workers.map((worker) => worker.assignedRooms),
      [0, 0],
    )

    await orchestrator.shutdown()
    await pool.shutdown()
    shutdownHealth = summarizeHealth(pool)
    assert.equal(shutdownHealth.state, 'stopped')
    assert.equal(shutdownHealth.totalAssignedRooms, 0)

    const memoryAfter = memorySummary()

    return {
      rooms: roomCount,
      distribution,
      tickLatenciesMs: tickLatenciesMs.map(round),
      avgTickLatencyMs: round(avgTickLatencyMs),
      maxTickLatencyMs: round(maxTickLatencyMs),
      totalBatchTimeMs: round(totalBatchTimeMs),
      roomsPerSecond: round((roomCount * TICK_BATCHES_PER_LEVEL * 1000) / totalBatchTimeMs),
      resultsPerSecond: round((totalResults * 1000) / totalBatchTimeMs),
      memoryBefore,
      memoryAfter,
      healthBeforeRelease,
      healthAfterRelease,
      shutdownHealth,
    }
  } finally {
    await orchestrator.shutdown().catch(() => {})
    await pool.shutdown().catch(() => {})
    shutdownHealth = shutdownHealth ?? summarizeHealth(pool)
  }
}

console.log('\n=== GameWorkerPool real multi-worker stress ===')

const workerEntryUrl = await resolveGameWorkerEntryUrl()
const summaries: StressLevelSummary[] = []

for (const roomCount of ROOM_LEVELS) {
  await check(`STRESS${roomCount}: ${roomCount} rooms across two workers`, async () => {
    const summary = await withTimeout(
      `stress level ${roomCount}`,
      LEVEL_TIMEOUT_MS,
      () => runStressLevel(workerEntryUrl, roomCount),
    )

    summaries.push(summary)
    console.log(`  stress ${roomCount} summary:`, JSON.stringify(summary))
  })
}

if (unhandledErrors.length > 0) {
  fail(
    'UNHANDLED: no unhandled rejections or uncaught exceptions',
    new Error(unhandledErrors.join(' | ')),
  )
} else {
  pass('UNHANDLED: no unhandled rejections or uncaught exceptions')
}

console.log('\n=== Stress summary table ===')
for (const summary of summaries) {
  console.log(
    JSON.stringify({
      rooms: summary.rooms,
      distribution: summary.distribution,
      avgTickLatencyMs: summary.avgTickLatencyMs,
      maxTickLatencyMs: summary.maxTickLatencyMs,
      totalBatchTimeMs: summary.totalBatchTimeMs,
      roomsPerSecond: summary.roomsPerSecond,
      memoryBefore: summary.memoryBefore,
      memoryAfter: summary.memoryAfter,
      shutdownState: summary.shutdownHealth.state,
    }),
  )
}

if (failCount > 0) {
  console.error(`\nGameWorkerPool stress failed: ${failCount} failed, ${passCount} passed.`)
  process.exitCode = 1
} else {
  console.log(`\nGameWorkerPool stress passed: ${passCount} checks.`)
}
