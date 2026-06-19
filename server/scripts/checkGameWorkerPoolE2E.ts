import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
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
  workers: Array<{
    workerId: string
    state: string
    assignedRooms: number
    pendingShadow: number
    lastError: string | null
  }>
}

let passCount = 0
let failCount = 0

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
    const roomId = `${prefix}-${index}`
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
    workers: health.workers.map((worker) => ({
      workerId: worker.workerId,
      state: worker.state,
      assignedRooms: worker.assignedRooms,
      pendingShadow: worker.shadow.pendingOperations,
      lastError: worker.lastError,
    })),
  }
}

function getDistribution(
  pool: GameWorkerPool,
  roomIds: readonly string[],
): Record<string, string[]> {
  const distribution: Record<string, string[]> = {}

  for (const roomId of roomIds) {
    const workerId = pool.getWorkerIdForRoom(roomId)
    assert.notEqual(workerId, null, `room=${roomId} should have an owner`)
    const ownedRooms = distribution[workerId!] ?? []
    ownedRooms.push(roomId)
    distribution[workerId!] = ownedRooms
  }

  return distribution
}

function summarizeResults(
  results: readonly GameWorkerTickCandidateResult[],
): Array<{ roomId: string; baseRevision: number; kind: string; message?: string }> {
  return results.map((result) => ({
    roomId: result.roomId,
    baseRevision: result.baseRevision,
    kind: result.kind,
    message:
      result.kind === 'compute_failed' || result.kind === 'not_assigned'
        ? result.message
        : undefined,
  }))
}

function assertBalancedDistribution(distribution: Record<string, string[]>): void {
  assert.deepStrictEqual(Object.keys(distribution), [
    'game-worker-1',
    'game-worker-2',
  ])
  assert.deepStrictEqual(distribution['game-worker-1'], [
    'e2e-normal-room-1',
    'e2e-normal-room-3',
  ])
  assert.deepStrictEqual(distribution['game-worker-2'], [
    'e2e-normal-room-2',
    'e2e-normal-room-4',
  ])
}

async function waitFor(
  label: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
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

function applyAdvancedResults(
  roomsById: Map<string, RoomRecord>,
  results: readonly GameWorkerTickCandidateResult[],
  revisionRegistry: ReturnType<typeof createRoomRevisionRegistry>,
): void {
  for (const result of results) {
    const record = roomsById.get(result.roomId) ?? null
    assert.notEqual(record, null, `unexpected result roomId=${result.roomId}`)

    if (result.kind === 'advanced') {
      assert.equal(result.room.id, result.roomId)
      roomsById.set(result.roomId, { room: result.room })
      revisionRegistry.bump(result.roomId)
    }
  }
}

async function createCrashOnComputeWorkerEntry(
  realWorkerEntryUrl: URL,
  crashWorkerId: string,
): Promise<{ url: URL; cleanup(): Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'belot-worker-e2e-'))
  const file = join(dir, 'crashOnComputeWorker.mjs')
  const source = `
import { parentPort, workerData } from 'node:worker_threads'

const crashWorkerId = ${JSON.stringify(crashWorkerId)}

if (workerData?.workerId === crashWorkerId) {
  parentPort.on('message', (message) => {
    if (
      message !== null &&
      typeof message === 'object' &&
      message.type === 'compute_tick_rooms'
    ) {
      process.exit(42)
    }
  })
}

await import(${JSON.stringify(realWorkerEntryUrl.href)})
`

  await writeFile(file, source, 'utf8')

  return {
    url: pathToFileURL(file),
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true })
    },
  }
}

console.log('\n=== GameWorkerPool real multi-worker E2E ===')

const realWorkerEntryUrl = await resolveGameWorkerEntryUrl()

await check('E2E1: normal two-worker runtime ticks, releases, and shuts down cleanly', async () => {
  const pool = createGameWorkerPool({
    workerCount: 2,
    maxRoomsPerWorker: 10,
    workerEntryUrl: realWorkerEntryUrl,
    requestTimeoutMs: 5000,
  })
  const revisionRegistry = createRoomRevisionRegistry()
  const orchestrator = createGameWorkerTickOrchestrator({
    mode: 'worker-candidate',
    revisionRegistry,
    tickClient: pool,
  })

  try {
    await pool.start()
    const roomsById = buildRooms('e2e-normal-room', 4)
    const roomIds = [...roomsById.keys()]

    for (const roomId of roomIds) {
      const record = roomsById.get(roomId)!
      revisionRegistry.ensure(roomId)
      const result = pool.ensureRoom(roomId)
      assert.equal(result.ok, true)
      assert.equal(record.room.id, roomId)
    }

    await waitForShadowIdle(pool)

    const distribution = getDistribution(pool, roomIds)
    assertBalancedDistribution(distribution)
    console.log('  normal distribution:', JSON.stringify(distribution))

    const healthBeforeTick = summarizeHealth(pool)
    assert.equal(healthBeforeTick.readyWorkers, 2)
    assert.equal(healthBeforeTick.failedWorkers, 0)
    assert.equal(healthBeforeTick.totalAssignedRooms, 4)
    assert.deepStrictEqual(
      healthBeforeTick.workers.map((worker) => worker.assignedRooms),
      [2, 2],
    )
    console.log('  normal health before tick:', JSON.stringify(healthBeforeTick))

    const firstTick = await orchestrator.computeCandidates({
      now: getFarFutureNow(roomsById.values()),
      rooms: [...roomsById.values()].map((record) => record.room),
    })

    assert.equal(firstTick.status, 'completed')
    assert.equal(firstTick.results.length, 4)
    applyAdvancedResults(roomsById, firstTick.results, revisionRegistry)
    console.log('  normal first tick:', JSON.stringify(summarizeResults(firstTick.results)))

    for (const result of firstTick.results) {
      assert.equal(roomIds.includes(result.roomId), true)
      assert.notEqual(result.kind, 'not_assigned')
      assert.notEqual(result.kind, 'compute_failed')
      if (result.kind === 'advanced') {
        assert.equal(result.room.id, result.roomId)
      }
    }

    const releasedRoomId = 'e2e-normal-room-2'
    assert.equal(pool.getWorkerIdForRoom(releasedRoomId), 'game-worker-2')
    await pool.releaseRoom(releasedRoomId)
    await waitForShadowIdle(pool)
    assert.equal(pool.getWorkerIdForRoom(releasedRoomId), null)

    const healthAfterRelease = summarizeHealth(pool)
    assert.equal(healthAfterRelease.totalAssignedRooms, 3)
    assert.deepStrictEqual(
      healthAfterRelease.workers.map((worker) => worker.assignedRooms),
      [2, 1],
    )
    console.log('  normal health after release:', JSON.stringify(healthAfterRelease))

    roomsById.delete(releasedRoomId)
    const remainingTick = await orchestrator.computeCandidates({
      now: getFarFutureNow(roomsById.values()),
      rooms: [...roomsById.values()].map((record) => record.room),
    })

    assert.equal(remainingTick.status, 'completed')
    assert.equal(remainingTick.results.length, 3)
    assert.equal(
      remainingTick.results.some((result) => result.roomId === releasedRoomId),
      false,
    )
    for (const result of remainingTick.results) {
      assert.notEqual(result.kind, 'not_assigned')
      assert.notEqual(result.kind, 'compute_failed')
    }
    console.log('  normal remaining tick:', JSON.stringify(summarizeResults(remainingTick.results)))
  } finally {
    await orchestrator.shutdown().catch(() => {})
    await pool.shutdown()
  }

  const shutdownHealth = summarizeHealth(pool)
  assert.equal(shutdownHealth.state, 'stopped')
  assert.equal(shutdownHealth.totalAssignedRooms, 0)
  console.log('  normal shutdown:', JSON.stringify(shutdownHealth))
})

await check('E2E2: failed worker keeps ownership, healthy worker continues, and shutdown is clean', async () => {
  const crashingWorker = await createCrashOnComputeWorkerEntry(
    realWorkerEntryUrl,
    'game-worker-2',
  )
  const pool = createGameWorkerPool({
    workerCount: 2,
    maxRoomsPerWorker: 10,
    workerEntryUrl: crashingWorker.url,
    requestTimeoutMs: 1000,
  })
  const revisionRegistry = createRoomRevisionRegistry()
  const orchestrator = createGameWorkerTickOrchestrator({
    mode: 'worker-candidate',
    revisionRegistry,
    tickClient: pool,
  })

  try {
    await pool.start()
    const roomsById = buildRooms('e2e-failure-room', 4)
    const roomIds = [...roomsById.keys()]

    for (const roomId of roomIds) {
      revisionRegistry.ensure(roomId)
      const result = pool.ensureRoom(roomId)
      assert.equal(result.ok, true)
    }

    await waitForShadowIdle(pool)

    const initialOwners = new Map(
      roomIds.map((roomId) => [roomId, pool.getWorkerIdForRoom(roomId)]),
    )
    assert.deepStrictEqual([...initialOwners.values()], [
      'game-worker-1',
      'game-worker-2',
      'game-worker-1',
      'game-worker-2',
    ])

    console.log(
      '  failure distribution before crash:',
      JSON.stringify(getDistribution(pool, roomIds)),
    )

    const healthBeforeFailure = summarizeHealth(pool)
    assert.equal(healthBeforeFailure.readyWorkers, 2)
    assert.equal(healthBeforeFailure.failedWorkers, 0)
    assert.equal(healthBeforeFailure.totalAssignedRooms, 4)
    console.log('  failure health before crash:', JSON.stringify(healthBeforeFailure))

    const firstTick = await orchestrator.computeCandidates({
      now: getFarFutureNow(roomsById.values()),
      rooms: [...roomsById.values()].map((record) => record.room),
    })

    assert.equal(firstTick.status, 'completed')
    assert.equal(firstTick.results.length, 4)
    console.log('  failure first tick:', JSON.stringify(summarizeResults(firstTick.results)))

    for (const result of firstTick.results) {
      const owner = initialOwners.get(result.roomId)

      if (owner === 'game-worker-1') {
        assert.notEqual(result.kind, 'compute_failed')
        assert.notEqual(result.kind, 'not_assigned')
      } else {
        assert.equal(result.kind, 'compute_failed')
      }
    }

    await waitFor(
      'game-worker-2 failed health',
      () =>
        pool.getHealth().workers.some(
          (worker) =>
            worker.workerId === 'game-worker-2' &&
            worker.state === 'failed',
        ),
    )

    const healthAfterFailure = summarizeHealth(pool)
    assert.equal(healthAfterFailure.readyWorkers, 1)
    assert.equal(healthAfterFailure.failedWorkers, 1)
    assert.equal(healthAfterFailure.totalAssignedRooms, 4)
    assert.deepStrictEqual(
      roomIds.map((roomId) => pool.getWorkerIdForRoom(roomId)),
      [...initialOwners.values()],
    )
    console.log('  failure health after crash:', JSON.stringify(healthAfterFailure))

    const secondTick = await orchestrator.computeCandidates({
      now: getFarFutureNow(roomsById.values()),
      rooms: [...roomsById.values()].map((record) => record.room),
    })

    assert.equal(secondTick.status, 'completed')
    console.log('  failure second tick:', JSON.stringify(summarizeResults(secondTick.results)))

    for (const result of secondTick.results) {
      const owner = initialOwners.get(result.roomId)

      if (owner === 'game-worker-1') {
        assert.notEqual(result.kind, 'compute_failed')
        assert.notEqual(result.kind, 'not_assigned')
      } else {
        assert.equal(result.kind, 'compute_failed')
      }
    }
  } finally {
    await orchestrator.shutdown().catch(() => {})
    await pool.shutdown()
    await crashingWorker.cleanup()
  }

  const shutdownHealth = summarizeHealth(pool)
  assert.equal(shutdownHealth.state, 'stopped')
  assert.equal(shutdownHealth.totalAssignedRooms, 0)
  console.log('  failure shutdown:', JSON.stringify(shutdownHealth))
})

if (failCount > 0) {
  console.error(`\nGameWorkerPool E2E failed: ${failCount} failed, ${passCount} passed.`)
  process.exitCode = 1
} else {
  console.log(`\nGameWorkerPool E2E passed: ${passCount} checks.`)
}
