import assert from 'node:assert/strict'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
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

type MemorySample = MemorySummary & {
  elapsedMs: number
}

type SoakLevelSummary = {
  rooms: number
  durationMs: number
  tickCount: number
  resultCount: number
  errorCount: number
  timeoutCount: number
  distribution: Record<string, number>
  avgTickLatencyMs: number
  maxTickLatencyMs: number
  p95TickLatencyMs: number
  roomsPerSecond: number
  resultsPerSecond: number
  eventLoopLagAvgMs: number
  eventLoopLagMaxMs: number
  eventLoopLagP95Ms: number
  memoryStart: MemorySummary
  memoryEnd: MemorySummary
  memoryTrend: string
  memorySamples: MemorySample[]
  healthBeforeRelease: HealthSummary
  healthAfterRelease: HealthSummary
  shutdownHealth: HealthSummary
}

const ROOM_LEVELS = [100, 200] as const
const WORKER_COUNT = 4
const MAX_ROOMS_PER_WORKER = 50
const DEFAULT_LEVEL_DURATION_MS = 90_000
const LEVEL_DURATION_MS = parseDurationEnv(
  process.env.BELOT_GAME_WORKER_SOAK_LEVEL_MS,
  DEFAULT_LEVEL_DURATION_MS,
)
const LEVEL_TIMEOUT_MS = LEVEL_DURATION_MS + 45_000
const MEMORY_SAMPLE_INTERVAL_MS = 10_000
const PROGRESS_INTERVAL_MS = 30_000

let passCount = 0
let failCount = 0
const unhandledErrors: string[] = []
const EXPECTED_WORKER_IDS = Array.from(
  { length: WORKER_COUNT },
  (_, index) => `game-worker-${index + 1}`,
)

process.on('unhandledRejection', (reason) => {
  unhandledErrors.push(reason instanceof Error ? reason.message : String(reason))
})

process.on('uncaughtException', (error) => {
  unhandledErrors.push(error.message)
  throw error
})

function parseDurationEnv(value: string | undefined, defaultValue: number): number {
  if (value === undefined || value.trim() === '') {
    return defaultValue
  }

  const parsed = Number(value)

  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 10_000) {
    throw new Error(
      `[soak] Invalid BELOT_GAME_WORKER_SOAK_LEVEL_MS=${JSON.stringify(value)}. Expected an integer >= 10000.`,
    )
  }

  return parsed
}

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

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) {
    return 0
  }

  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  )
  return sorted[index]
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

function classifyMemoryTrend(samples: readonly MemorySample[]): string {
  if (samples.length < 4) {
    return 'insufficient-samples'
  }

  const windowSize = Math.min(3, Math.floor(samples.length / 2))
  const firstWindow = samples.slice(0, windowSize)
  const lastWindow = samples.slice(-windowSize)

  function avg(samplesForAverage: readonly MemorySample[], key: 'rssMb' | 'heapUsedMb'): number {
    return (
      samplesForAverage.reduce((sum, sample) => sum + sample[key], 0) /
      samplesForAverage.length
    )
  }

  const firstRss = avg(firstWindow, 'rssMb')
  const lastRss = avg(lastWindow, 'rssMb')
  const firstHeap = avg(firstWindow, 'heapUsedMb')
  const lastHeap = avg(lastWindow, 'heapUsedMb')
  const rssDelta = lastRss - firstRss
  const heapDelta = lastHeap - firstHeap

  if (rssDelta > Math.max(12, firstRss * 0.15) || heapDelta > Math.max(8, firstHeap * 0.25)) {
    return `growing rssDeltaMb=${round(rssDelta)} heapDeltaMb=${round(heapDelta)}`
  }

  if (rssDelta < -4 && heapDelta < -2) {
    return `decreasing rssDeltaMb=${round(rssDelta)} heapDeltaMb=${round(heapDelta)}`
  }

  return `stable rssDeltaMb=${round(rssDelta)} heapDeltaMb=${round(heapDelta)}`
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
    assert.equal(ownerByRoomId.has(roomId), false, `duplicate owner check failed for room=${roomId}`)
    ownerByRoomId.set(roomId, workerId!)
    distribution[workerId!] = (distribution[workerId!] ?? 0) + 1
  }

  assert.equal(ownerByRoomId.size, roomIds.length)
  assert.deepStrictEqual(Object.keys(distribution), EXPECTED_WORKER_IDS)
  return distribution
}

function assertBalancedDistribution(
  distribution: Record<string, number>,
  expectedRooms: number,
): void {
  assert.equal(
    expectedRooms % WORKER_COUNT,
    0,
    `expectedRooms=${expectedRooms} must divide evenly across ${WORKER_COUNT} workers`,
  )

  const expectedRoomsPerWorker = expectedRooms / WORKER_COUNT

  for (const workerId of EXPECTED_WORKER_IDS) {
    assert.equal(distribution[workerId], expectedRoomsPerWorker)
  }
}

function validateTickResults(
  results: readonly GameWorkerTickCandidateResult[],
  expectedRooms: readonly ServerRoom[],
  revisionRegistry: ReturnType<typeof createRoomRevisionRegistry>,
): void {
  assert.equal(results.length, expectedRooms.length)

  const seenResultIds = new Set<string>()

  for (let index = 0; index < results.length; index += 1) {
    const result = results[index]
    const expectedRoom = expectedRooms[index]

    assert.equal(result.roomId, expectedRoom.id)
    assert.equal(result.baseRevision, revisionRegistry.get(result.roomId))
    assert.equal(seenResultIds.has(result.roomId), false, `duplicate result room=${result.roomId}`)
    assert.notEqual(result.kind, 'not_assigned')
    assert.notEqual(result.kind, 'compute_failed')

    if (result.kind === 'advanced') {
      assert.equal(result.room.id, result.roomId)
    }

    seenResultIds.add(result.roomId)
  }

  assert.equal(seenResultIds.size, expectedRooms.length)
}

function applyAdvancedResults(
  roomsById: Map<string, RoomRecord>,
  results: readonly GameWorkerTickCandidateResult[],
  revisionRegistry: ReturnType<typeof createRoomRevisionRegistry>,
): void {
  for (const result of results) {
    if (result.kind === 'advanced') {
      roomsById.set(result.roomId, { room: result.room })
      revisionRegistry.bump(result.roomId)
    }
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

async function runSoakLevel(
  workerEntryUrl: URL,
  roomCount: number,
): Promise<SoakLevelSummary> {
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
  const lagMonitor = monitorEventLoopDelay({ resolution: 20 })
  const memorySamples: MemorySample[] = []
  const tickLatenciesMs: number[] = []
  let tickCount = 0
  let resultCount = 0
  let errorCount = 0
  let timeoutCount = 0
  let shutdownHealth: HealthSummary | null = null

  try {
    await pool.start()
    const roomsById = buildRooms(`soak-${roomCount}-room`, roomCount)
    const roomIds = [...roomsById.keys()]

    for (const roomId of roomIds) {
      revisionRegistry.ensure(roomId)
      const result = pool.ensureRoom(roomId)
      assert.equal(result.ok, true, `ensureRoom failed for room=${roomId}`)
    }

    await waitForShadowIdle(pool)

    const distribution = getDistributionCounts(pool, roomIds)
    assertBalancedDistribution(distribution, roomCount)
    assertHealthyPool(summarizeHealth(pool), roomCount)

    lagMonitor.enable()
    const startedAt = performance.now()
    let nextMemorySampleAt = 0
    let nextProgressAt = PROGRESS_INTERVAL_MS

    while (performance.now() - startedAt < LEVEL_DURATION_MS) {
      const elapsedMs = performance.now() - startedAt

      if (elapsedMs >= nextMemorySampleAt) {
        memorySamples.push({ elapsedMs: round(elapsedMs), ...memorySummary() })
        nextMemorySampleAt += MEMORY_SAMPLE_INTERVAL_MS
      }

      const rooms = [...roomsById.values()].map((record) => record.room)
      const tickStartedAt = performance.now()

      try {
        const batch = await orchestrator.computeCandidates({
          now: getFarFutureNow(roomsById.values()),
          rooms,
        })
        const tickLatencyMs = performance.now() - tickStartedAt
        tickLatenciesMs.push(tickLatencyMs)

        assert.equal(batch.status, 'completed')
        validateTickResults(batch.results, rooms, revisionRegistry)
        applyAdvancedResults(roomsById, batch.results, revisionRegistry)
        resultCount += batch.results.length
        tickCount += 1
      } catch (error: unknown) {
        errorCount += 1
        const message = error instanceof Error ? error.message : String(error)
        if (/timeout|timed out/i.test(message)) {
          timeoutCount += 1
        }
        throw error
      }

      if (tickCount % 25 === 0) {
        assertBalancedDistribution(getDistributionCounts(pool, roomIds), roomCount)
        assertHealthyPool(summarizeHealth(pool), roomCount)
      }

      const afterTickElapsedMs = performance.now() - startedAt
      if (afterTickElapsedMs >= nextProgressAt) {
        const lastLatency = tickLatenciesMs[tickLatenciesMs.length - 1] ?? 0
        console.log(
          `  soak ${roomCount} progress: ` +
            JSON.stringify({
              elapsedSec: round(afterTickElapsedMs / 1000),
              ticks: tickCount,
              results: resultCount,
              lastLatencyMs: round(lastLatency),
              memory: memorySummary(),
            }),
        )
        nextProgressAt += PROGRESS_INTERVAL_MS
      }
    }

    memorySamples.push({
      elapsedMs: round(performance.now() - startedAt),
      ...memorySummary(),
    })

    lagMonitor.disable()

    const durationMs = performance.now() - startedAt
    const healthBeforeRelease = summarizeHealth(pool)
    assertHealthyPool(healthBeforeRelease, roomCount)

    await Promise.all(roomIds.map((roomId) => pool.releaseRoom(roomId)))
    await waitForShadowIdle(pool)
    const healthAfterRelease = summarizeHealth(pool)
    assert.equal(healthAfterRelease.totalAssignedRooms, 0)
    assert.deepStrictEqual(
      healthAfterRelease.workers.map((worker) => worker.assignedRooms),
      Array.from({ length: WORKER_COUNT }, () => 0),
    )

    await orchestrator.shutdown()
    await pool.shutdown()
    shutdownHealth = summarizeHealth(pool)
    assert.equal(shutdownHealth.state, 'stopped')
    assert.equal(shutdownHealth.totalAssignedRooms, 0)

    return {
      rooms: roomCount,
      durationMs: round(durationMs),
      tickCount,
      resultCount,
      errorCount,
      timeoutCount,
      distribution,
      avgTickLatencyMs: round(
        tickLatenciesMs.reduce((sum, value) => sum + value, 0) /
          tickLatenciesMs.length,
      ),
      maxTickLatencyMs: round(Math.max(...tickLatenciesMs)),
      p95TickLatencyMs: round(percentile(tickLatenciesMs, 95)),
      roomsPerSecond: round(resultCount / (durationMs / 1000)),
      resultsPerSecond: round(resultCount / (durationMs / 1000)),
      eventLoopLagAvgMs: round(lagMonitor.mean / 1_000_000),
      eventLoopLagMaxMs: round(lagMonitor.max / 1_000_000),
      eventLoopLagP95Ms: round(lagMonitor.percentile(95) / 1_000_000),
      memoryStart: memorySamples[0] ?? memorySummary(),
      memoryEnd: memorySamples[memorySamples.length - 1] ?? memorySummary(),
      memoryTrend: classifyMemoryTrend(memorySamples),
      memorySamples,
      healthBeforeRelease,
      healthAfterRelease,
      shutdownHealth,
    }
  } finally {
    lagMonitor.disable()
    await orchestrator.shutdown().catch(() => {})
    await pool.shutdown().catch(() => {})
    shutdownHealth = shutdownHealth ?? summarizeHealth(pool)
  }
}

console.log('\n=== GameWorkerPool real multi-worker soak ===')
console.log(
  `  config: rooms=${ROOM_LEVELS.join(',')} workers=${WORKER_COUNT} levelDurationMs=${LEVEL_DURATION_MS}`,
)

const workerEntryUrl = await resolveGameWorkerEntryUrl()
const summaries: SoakLevelSummary[] = []

for (const roomCount of ROOM_LEVELS) {
  await check(`SOAK${roomCount}: ${roomCount} rooms for ${LEVEL_DURATION_MS}ms`, async () => {
    const summary = await withTimeout(
      `soak level ${roomCount}`,
      LEVEL_TIMEOUT_MS,
      () => runSoakLevel(workerEntryUrl, roomCount),
    )
    summaries.push(summary)
    console.log(`  soak ${roomCount} summary:`, JSON.stringify(summary))
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

console.log('\n=== Soak summary table ===')
for (const summary of summaries) {
  console.log(
    JSON.stringify({
      rooms: summary.rooms,
      durationMs: summary.durationMs,
      ticks: summary.tickCount,
      results: summary.resultCount,
      errors: summary.errorCount,
      timeouts: summary.timeoutCount,
      distribution: summary.distribution,
      avgTickLatencyMs: summary.avgTickLatencyMs,
      p95TickLatencyMs: summary.p95TickLatencyMs,
      maxTickLatencyMs: summary.maxTickLatencyMs,
      resultsPerSecond: summary.resultsPerSecond,
      eventLoopLagP95Ms: summary.eventLoopLagP95Ms,
      eventLoopLagMaxMs: summary.eventLoopLagMaxMs,
      memoryStart: summary.memoryStart,
      memoryEnd: summary.memoryEnd,
      memoryTrend: summary.memoryTrend,
      shutdownState: summary.shutdownHealth.state,
    }),
  )
}

if (failCount > 0) {
  console.error(`\nGameWorkerPool soak failed: ${failCount} failed, ${passCount} passed.`)
  process.exitCode = 1
} else {
  console.log(`\nGameWorkerPool soak passed: ${passCount} checks.`)
}
