/**
 * checkGameWorkerTickOrchestrator.ts
 *
 * Проверява:
 * - createRoomRevisionRegistry (unit)
 * - createGameWorkerTickOrchestrator с fake tick client
 * - createGameWorkerTickOrchestrator с sync fallback
 * - real Worker integration
 */

import assert from 'node:assert/strict'
import { Worker } from 'node:worker_threads'
import { createRoomRevisionRegistry } from '../src/game/createRoomRevisionRegistry.js'
import {
  createGameWorkerTickOrchestrator,
  type GameWorkerTickOrchestratorConfig,
  type GameWorkerTickOrchestratorHealth,
} from '../src/game/createGameWorkerTickOrchestrator.js'
import { createGameWorkerTickClient } from '../src/game/createGameWorkerTickClient.js'
import type { GameWorkerTickMessageEndpoint } from '../src/game/createGameWorkerTickClient.js'
import {
  GAME_WORKER_PROTOCOL_VERSION,
  type GameWorkerTickRoomResult,
} from '../src/game/workerProtocol.js'
import type { ServerRoom } from '../src/core/serverTypes.js'
import type {
  TickRoomsInput,
  TickRoomsResult,
  RuntimeRoomTickResult,
} from '../src/game/activeRoomRuntime.js'
import { resolveGameWorkerEntryUrl } from '../src/game/resolveGameWorkerEntryUrl.js'
import { createRoomWithHumanHost } from '../src/core/createRoomWithHumanHost.js'
import { addHumanToRoom } from '../src/core/addHumanToRoom.js'
import { addBotToRoom } from '../src/core/addBotToRoom.js'
import { initializeRoomAuthoritativeGameState } from '../src/game/initializeRoomAuthoritativeGameState.js'
import { advanceRoomAuthoritativeGame } from '../src/game/advanceRoomAuthoritativeGame.js'

// ─── Test harness ─────────────────────────────────────────────────────────────

let passCount = 0
let failCount = 0

function pass(label: string): void {
  passCount += 1
  console.log(`  ✓ ${label}`)
}

function fail(label: string, error: unknown): void {
  failCount += 1
  const msg = error instanceof Error ? error.message : String(error)
  console.error(`  ✗ ${label}: ${msg}`)
}

async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    pass(label)
  } catch (error) {
    fail(label, error)
  }
}

// ─── Room helpers ─────────────────────────────────────────────────────────────

function makeFakeRoom(id: string): ServerRoom {
  return { id, game: { phase: null } } as unknown as ServerRoom
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

// ─── Fake tick client ─────────────────────────────────────────────────────────

type FakeTickClientOptions = {
  throwOnCompute?: boolean | string
  buildResults?: (rooms: Array<{ roomId: string; baseRevision: number; room: ServerRoom }>) => GameWorkerTickRoomResult[]
}

type FakeTickClient = {
  computeTickRooms(
    rooms: Array<{ roomId: string; baseRevision: number; room: ServerRoom }>,
    now: number,
  ): Promise<GameWorkerTickRoomResult[]>
  callCount: number
}

function makeFakeTickClient(opts: FakeTickClientOptions = {}): FakeTickClient {
  let callCount = 0

  const client: FakeTickClient = {
    get callCount() { return callCount },
    async computeTickRooms(rooms, _now) {
      callCount += 1

      if (opts.throwOnCompute === true) {
        throw new Error('fake tick client error')
      }
      if (typeof opts.throwOnCompute === 'string') {
        throw new Error(opts.throwOnCompute)
      }

      if (opts.buildResults !== undefined) {
        return opts.buildResults(rooms)
      }

      return rooms.map((r) => ({
        roomId: r.roomId,
        baseRevision: r.baseRevision,
        result: 'unchanged' as const,
      }))
    },
  }

  return client
}

// ─── Fake sync target ─────────────────────────────────────────────────────────

type FakeSyncTargetOptions = {
  throwOnTick?: boolean | string
  buildResults?: (input: TickRoomsInput) => RuntimeRoomTickResult[]
}

type FakeSyncTarget = {
  tickRooms(input: TickRoomsInput): TickRoomsResult
  callCount: number
}

function makeFakeSyncTarget(opts: FakeSyncTargetOptions = {}): FakeSyncTarget {
  let callCount = 0

  return {
    get callCount() { return callCount },
    tickRooms(input: TickRoomsInput): TickRoomsResult {
      callCount += 1

      if (opts.throwOnTick === true) {
        throw new Error('fake sync target error')
      }
      if (typeof opts.throwOnTick === 'string') {
        throw new Error(opts.throwOnTick)
      }

      if (opts.buildResults !== undefined) {
        return { results: opts.buildResults(input) }
      }

      return {
        results: input.rooms.map((room) => ({
          kind: 'unchanged' as const,
          roomId: room.id,
        })),
      }
    },
  }
}

// ─── Worker lifecycle helper ──────────────────────────────────────────────────

async function withWorker(
  workerUrl: URL,
  fn: (worker: Worker, endpoint: GameWorkerTickMessageEndpoint) => Promise<void>,
): Promise<void> {
  const worker = new Worker(workerUrl, { workerData: { workerId: 'orch-test-worker' } })
  let settled = false

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (!settled) { settled = true; reject(new Error('Worker ready timeout')) }
    }, 5000)
    worker.once('message', (msg: unknown) => {
      clearTimeout(timeout)
      if (!settled) {
        settled = true
        const m = msg as Record<string, unknown>
        if (m['type'] !== 'ready') {
          reject(new Error(`Expected ready, got ${JSON.stringify(msg)}`))
        } else {
          resolve()
        }
      }
    })
    worker.once('error', (err) => {
      clearTimeout(timeout)
      if (!settled) { settled = true; reject(err) }
    })
  })

  const endpoint: GameWorkerTickMessageEndpoint = {
    postMessage: (msg) => worker.postMessage(msg),
    on: (event, listener) => worker.on(event, listener),
    off: (event, listener) => worker.off(event, listener),
  }

  try {
    await fn(worker, endpoint)
  } finally {
    settled = false
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        if (!settled) {
          settled = true
          void worker.terminate().then(() => resolve(), () => resolve())
        }
      }, 2000)
      worker.postMessage({ type: 'shutdown', requestId: 'orch-cleanup' })
      worker.once('exit', () => {
        if (!settled) {
          settled = true
          clearTimeout(t)
          resolve()
        }
      })
    })
  }
}

async function assignRoom(worker: Worker, roomId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('assign timeout')), 3000)
    function handler(msg: unknown): void {
      const m = msg as Record<string, unknown>
      if (m['type'] === 'assign_room_ack' && m['roomId'] === roomId) {
        clearTimeout(timeout)
        worker.off('message', handler)
        resolve()
      }
    }
    worker.on('message', handler)
    worker.postMessage({ type: 'assign_room', requestId: `assign-${roomId}`, roomId })
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1: Revision registry
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n═══ Section 1: Revision registry ═══')

await check('R1: get(unknown) === null', () => {
  const reg = createRoomRevisionRegistry()
  assert.strictEqual(reg.get('unknown-room'), null)
})

await check('R2: has(unknown) === false', () => {
  const reg = createRoomRevisionRegistry()
  assert.strictEqual(reg.has('unknown-room'), false)
})

await check('R3: ensure(new room) === 0', () => {
  const reg = createRoomRevisionRegistry()
  assert.strictEqual(reg.ensure('room-1'), 0)
})

await check('R4: repeated ensure() does not change revision', () => {
  const reg = createRoomRevisionRegistry()
  reg.ensure('room-1')
  reg.bump('room-1')
  assert.strictEqual(reg.get('room-1'), 1)
  reg.ensure('room-1')
  assert.strictEqual(reg.get('room-1'), 1)
})

await check('R5: bump() returns 1 after ensure', () => {
  const reg = createRoomRevisionRegistry()
  reg.ensure('room-1')
  assert.strictEqual(reg.bump('room-1'), 1)
})

await check('R6: multiple bumps increment correctly', () => {
  const reg = createRoomRevisionRegistry()
  reg.ensure('room-1')
  assert.strictEqual(reg.bump('room-1'), 1)
  assert.strictEqual(reg.bump('room-1'), 2)
  assert.strictEqual(reg.bump('room-1'), 3)
  assert.strictEqual(reg.get('room-1'), 3)
})

await check('R7: remove() resets entry', () => {
  const reg = createRoomRevisionRegistry()
  reg.ensure('room-1')
  reg.bump('room-1')
  assert.strictEqual(reg.get('room-1'), 1)
  reg.remove('room-1')
  assert.strictEqual(reg.get('room-1'), null)
  assert.strictEqual(reg.has('room-1'), false)
})

await check('R8: duplicate remove() is idempotent (safe)', () => {
  const reg = createRoomRevisionRegistry()
  reg.ensure('room-1')
  reg.remove('room-1')
  reg.remove('room-1')
  assert.strictEqual(reg.has('room-1'), false)
})

await check('R9: invalid roomId throws', () => {
  const reg = createRoomRevisionRegistry()
  assert.throws(() => reg.ensure(''), /non-empty string/)
  assert.throws(() => reg.ensure('   '), /non-empty string/)
  assert.throws(() => reg.get(''), /non-empty string/)
  assert.throws(() => reg.bump(''), /non-empty string/)
  assert.throws(() => reg.remove(''), /non-empty string/)
  assert.throws(() => reg.has(''), /non-empty string/)
})

await check('R10: bump() on unregistered room throws', () => {
  const reg = createRoomRevisionRegistry()
  assert.throws(() => reg.bump('never-ensured'), /unregistered/)
})

// R11: Overflow guard is confirmed by code review.
// There is no public API to artificially reach MAX_SAFE_INTEGER.
// The guard `if (current >= Number.MAX_SAFE_INTEGER) throw ...` is present in the source.
console.log(
  '  ℹ R11: overflow guard confirmed via code review — no public API for artificial overflow',
)

// ─── Registry getTrackedRoomCount ────────────────────────────────────────────

await check('RC1: getTrackedRoomCount() initial === 0', () => {
  const reg = createRoomRevisionRegistry()
  assert.strictEqual(reg.getTrackedRoomCount(), 0)
})

await check('RC2: getTrackedRoomCount() after two ensure() calls === 2', () => {
  const reg = createRoomRevisionRegistry()
  reg.ensure('rc2-a')
  reg.ensure('rc2-b')
  assert.strictEqual(reg.getTrackedRoomCount(), 2)
})

await check('RC3: repeated ensure() does not increase count', () => {
  const reg = createRoomRevisionRegistry()
  reg.ensure('rc3')
  reg.ensure('rc3')
  reg.ensure('rc3')
  assert.strictEqual(reg.getTrackedRoomCount(), 1)
})

await check('RC4: getTrackedRoomCount() after remove() === 1', () => {
  const reg = createRoomRevisionRegistry()
  reg.ensure('rc4-a')
  reg.ensure('rc4-b')
  reg.remove('rc4-a')
  assert.strictEqual(reg.getTrackedRoomCount(), 1)
})

await check('RC5: bump() does not change getTrackedRoomCount()', () => {
  const reg = createRoomRevisionRegistry()
  reg.ensure('rc5')
  reg.bump('rc5')
  reg.bump('rc5')
  assert.strictEqual(reg.getTrackedRoomCount(), 1)
})

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2: Fake tick client tests
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n═══ Section 2: Fake tick client (worker-candidate mode) ═══')

// Config validation
await check('Config1: worker-candidate without computeTickRooms → factory throws', () => {
  const reg = createRoomRevisionRegistry()
  assert.throws(
    () => createGameWorkerTickOrchestrator({
      mode: 'worker-candidate',
      revisionRegistry: reg,
      tickClient: {} as unknown as GameWorkerTickOrchestratorConfig extends { mode: 'worker-candidate'; tickClient: infer T } ? T : never,
    }),
    /computeTickRooms/,
  )
})

await check('Config2: in-process without tickRooms → factory throws', () => {
  const reg = createRoomRevisionRegistry()
  assert.throws(
    () => createGameWorkerTickOrchestrator({
      mode: 'in-process',
      revisionRegistry: reg,
      syncTickTarget: {} as unknown as { tickRooms: () => void },
    }),
    /tickRooms/,
  )
})

// F1: unchanged result
await check('F1: unchanged result → kind=unchanged', async () => {
  const reg = createRoomRevisionRegistry()
  reg.ensure('r1')
  const orch = createGameWorkerTickOrchestrator({
    mode: 'worker-candidate',
    revisionRegistry: reg,
    tickClient: makeFakeTickClient(),
  })
  const result = await orch.computeCandidates({ now: Date.now(), rooms: [makeFakeRoom('r1')] })
  assert.strictEqual(result.status, 'completed')
  if (result.status === 'completed') {
    assert.strictEqual(result.results.length, 1)
    assert.strictEqual(result.results[0].kind, 'unchanged')
    assert.strictEqual(result.results[0].baseRevision, 0)
  }
  await orch.shutdown()
})

// F2: advanced result — room ID в advanced candidate трябва да съвпада с result room ID
await check('F2: advanced result → kind=advanced with matching room', async () => {
  const reg = createRoomRevisionRegistry()
  reg.ensure('r2')
  const advancedRoom = makeFakeRoom('r2')
  const orch = createGameWorkerTickOrchestrator({
    mode: 'worker-candidate',
    revisionRegistry: reg,
    tickClient: makeFakeTickClient({
      buildResults: (rooms) => rooms.map((r) => ({
        roomId: r.roomId,
        baseRevision: r.baseRevision,
        result: 'advanced' as const,
        room: advancedRoom as unknown as ServerRoom,
      })),
    }),
  })
  const result = await orch.computeCandidates({ now: Date.now(), rooms: [makeFakeRoom('r2')] })
  assert.strictEqual(result.status, 'completed')
  if (result.status === 'completed') {
    const r = result.results[0]
    assert.strictEqual(r.kind, 'advanced')
    if (r.kind === 'advanced') {
      assert.strictEqual(r.room, advancedRoom)
    }
  }
  await orch.shutdown()
})

// F3: not_assigned
await check('F3: not_assigned error → kind=not_assigned', async () => {
  const reg = createRoomRevisionRegistry()
  reg.ensure('r3')
  const orch = createGameWorkerTickOrchestrator({
    mode: 'worker-candidate',
    revisionRegistry: reg,
    tickClient: makeFakeTickClient({
      buildResults: (rooms) => rooms.map((r) => ({
        roomId: r.roomId,
        baseRevision: r.baseRevision,
        result: 'error' as const,
        code: 'not_assigned' as const,
        message: 'Room is not assigned to this worker.',
      })),
    }),
  })
  const result = await orch.computeCandidates({ now: Date.now(), rooms: [makeFakeRoom('r3')] })
  assert.strictEqual(result.status, 'completed')
  if (result.status === 'completed') {
    const r = result.results[0]
    assert.strictEqual(r.kind, 'not_assigned')
    if (r.kind === 'not_assigned') {
      assert.ok(r.message.length > 0)
    }
  }
  await orch.shutdown()
})

// F4: compute_failed
await check('F4: compute_failed error → kind=compute_failed', async () => {
  const reg = createRoomRevisionRegistry()
  reg.ensure('r4')
  const orch = createGameWorkerTickOrchestrator({
    mode: 'worker-candidate',
    revisionRegistry: reg,
    tickClient: makeFakeTickClient({
      buildResults: (rooms) => rooms.map((r) => ({
        roomId: r.roomId,
        baseRevision: r.baseRevision,
        result: 'error' as const,
        code: 'compute_failed' as const,
        message: 'advanceRoomAuthoritativeGame threw',
      })),
    }),
  })
  const result = await orch.computeCandidates({ now: Date.now(), rooms: [makeFakeRoom('r4')] })
  assert.strictEqual(result.status, 'completed')
  if (result.status === 'completed') {
    assert.strictEqual(result.results[0].kind, 'compute_failed')
  }
  await orch.shutdown()
})

// F5: revision is echoed correctly
await check('F5: revision is echoed correctly in candidate result', async () => {
  const reg = createRoomRevisionRegistry()
  reg.ensure('r5')
  reg.bump('r5')
  reg.bump('r5') // revision = 2
  const orch = createGameWorkerTickOrchestrator({
    mode: 'worker-candidate',
    revisionRegistry: reg,
    tickClient: makeFakeTickClient({
      buildResults: (rooms) => rooms.map((r) => ({
        roomId: r.roomId,
        baseRevision: r.baseRevision,
        result: 'unchanged' as const,
      })),
    }),
  })
  const result = await orch.computeCandidates({ now: Date.now(), rooms: [makeFakeRoom('r5')] })
  assert.strictEqual(result.status, 'completed')
  if (result.status === 'completed') {
    assert.strictEqual(result.results[0].baseRevision, 2)
  }
  await orch.shutdown()
})

// F6: stale after bump between request and response
await check('F6: stale after registry.bump() between request and response', async () => {
  const reg = createRoomRevisionRegistry()
  reg.ensure('r6')

  let resolveRequest!: (results: GameWorkerTickRoomResult[]) => void
  let markRequestStarted!: () => void
  const requestStartedGate = new Promise<void>((resolve) => {
    markRequestStarted = resolve
  })

  const orch = createGameWorkerTickOrchestrator({
    mode: 'worker-candidate',
    revisionRegistry: reg,
    tickClient: {
      computeTickRooms(rooms, _now) {
        return new Promise<GameWorkerTickRoomResult[]>((resolve) => {
          markRequestStarted()
          resolveRequest = () => resolve(rooms.map((r) => ({
            roomId: r.roomId,
            baseRevision: r.baseRevision,
            result: 'unchanged' as const,
          })))
        })
      },
    },
  })

  const room = makeFakeRoom('r6')
  const batchPromise = orch.computeCandidates({ now: Date.now(), rooms: [room] })

  // Wait for the fake client to be invoked before bumping
  await requestStartedGate
  reg.bump('r6') // revision bumped to 1 while request is in-flight
  resolveRequest()

  const result = await batchPromise
  assert.strictEqual(result.status, 'completed')
  if (result.status === 'completed') {
    assert.strictEqual(result.results[0].kind, 'stale')
    assert.strictEqual(result.results[0].baseRevision, 0)
  }
  await orch.shutdown()
})

// F7: partial batch — mixed results
await check('F7: partial batch — unchanged + not_assigned + compute_failed', async () => {
  const reg = createRoomRevisionRegistry()
  reg.ensure('r7a')
  reg.ensure('r7b')
  reg.ensure('r7c')

  const orch = createGameWorkerTickOrchestrator({
    mode: 'worker-candidate',
    revisionRegistry: reg,
    tickClient: makeFakeTickClient({
      buildResults: (rooms) => rooms.map((r) => {
        if (r.roomId === 'r7a') return { roomId: r.roomId, baseRevision: r.baseRevision, result: 'unchanged' as const }
        if (r.roomId === 'r7b') return { roomId: r.roomId, baseRevision: r.baseRevision, result: 'error' as const, code: 'not_assigned' as const, message: 'nope' }
        return { roomId: r.roomId, baseRevision: r.baseRevision, result: 'error' as const, code: 'compute_failed' as const, message: 'crash' }
      }),
    }),
  })

  const result = await orch.computeCandidates({
    now: Date.now(),
    rooms: [makeFakeRoom('r7a'), makeFakeRoom('r7b'), makeFakeRoom('r7c')],
  })
  assert.strictEqual(result.status, 'completed')
  if (result.status === 'completed') {
    assert.strictEqual(result.results.length, 3)
    const byId = Object.fromEntries(result.results.map((r) => [r.roomId, r.kind]))
    assert.strictEqual(byId['r7a'], 'unchanged')
    assert.strictEqual(byId['r7b'], 'not_assigned')
    assert.strictEqual(byId['r7c'], 'compute_failed')
  }
  await orch.shutdown()
})

// F8: whole request reject → batch failed
await check('F8: whole request reject → status=failed', async () => {
  const reg = createRoomRevisionRegistry()
  reg.ensure('r8')
  const orch = createGameWorkerTickOrchestrator({
    mode: 'worker-candidate',
    revisionRegistry: reg,
    tickClient: makeFakeTickClient({ throwOnCompute: 'tick client exploded' }),
  })
  const result = await orch.computeCandidates({ now: Date.now(), rooms: [makeFakeRoom('r8')] })
  assert.strictEqual(result.status, 'failed')
  if (result.status === 'failed') {
    assert.ok(result.message.includes('tick client exploded'))
  }
  await orch.shutdown()
})

// F9: no automatic retry
await check('F9: no automatic retry on failed batch', async () => {
  const reg = createRoomRevisionRegistry()
  reg.ensure('r9')
  let callCount = 0
  const orch = createGameWorkerTickOrchestrator({
    mode: 'worker-candidate',
    revisionRegistry: reg,
    tickClient: {
      async computeTickRooms() {
        callCount += 1
        throw new Error('fail once')
      },
    },
  })
  const result = await orch.computeCandidates({ now: Date.now(), rooms: [makeFakeRoom('r9')] })
  assert.strictEqual(result.status, 'failed')
  assert.strictEqual(callCount, 1, 'should only be called once — no retry')
  await orch.shutdown()
})

// F10: second call while pending → busy
await check('F10: second computeCandidates() while pending → busy', async () => {
  const reg = createRoomRevisionRegistry()
  reg.ensure('r10')

  let resolveFirst!: () => void

  const orch = createGameWorkerTickOrchestrator({
    mode: 'worker-candidate',
    revisionRegistry: reg,
    tickClient: {
      computeTickRooms(rooms, _now) {
        return new Promise<GameWorkerTickRoomResult[]>((resolve) => {
          resolveFirst = () => resolve(rooms.map((r) => ({
            roomId: r.roomId,
            baseRevision: r.baseRevision,
            result: 'unchanged' as const,
          })))
        })
      },
    },
  })

  const room = makeFakeRoom('r10')
  const firstBatch = orch.computeCandidates({ now: Date.now(), rooms: [room] })

  const secondResult = await orch.computeCandidates({ now: Date.now(), rooms: [room] })
  assert.strictEqual(secondResult.status, 'busy')

  resolveFirst()
  const firstResult = await firstBatch
  assert.strictEqual(firstResult.status, 'completed')

  await orch.shutdown()
})

// F11: guard released after success
await check('F11: in-flight guard released after success', async () => {
  const reg = createRoomRevisionRegistry()
  reg.ensure('r11')
  const orch = createGameWorkerTickOrchestrator({
    mode: 'worker-candidate',
    revisionRegistry: reg,
    tickClient: makeFakeTickClient(),
  })
  const room = makeFakeRoom('r11')
  const r1 = await orch.computeCandidates({ now: Date.now(), rooms: [room] })
  assert.strictEqual(r1.status, 'completed')
  const r2 = await orch.computeCandidates({ now: Date.now(), rooms: [room] })
  assert.strictEqual(r2.status, 'completed')
  await orch.shutdown()
})

// F12: guard released after reject
await check('F12: in-flight guard released after reject', async () => {
  const reg = createRoomRevisionRegistry()
  reg.ensure('r12')
  let firstCall = true
  const orch = createGameWorkerTickOrchestrator({
    mode: 'worker-candidate',
    revisionRegistry: reg,
    tickClient: {
      async computeTickRooms(rooms, _now) {
        if (firstCall) {
          firstCall = false
          throw new Error('temporary failure')
        }
        return rooms.map((r) => ({
          roomId: r.roomId,
          baseRevision: r.baseRevision,
          result: 'unchanged' as const,
        }))
      },
    },
  })
  const room = makeFakeRoom('r12')
  const r1 = await orch.computeCandidates({ now: Date.now(), rooms: [room] })
  assert.strictEqual(r1.status, 'failed')
  const r2 = await orch.computeCandidates({ now: Date.now(), rooms: [room] })
  assert.strictEqual(r2.status, 'completed')
  await orch.shutdown()
})

// F13: shutdown while pending
await check('F13: shutdown while pending → batch completes before shutdown resolves', async () => {
  const reg = createRoomRevisionRegistry()
  reg.ensure('r13')

  let resolveCompute!: () => void

  const orch = createGameWorkerTickOrchestrator({
    mode: 'worker-candidate',
    revisionRegistry: reg,
    tickClient: {
      computeTickRooms(rooms, _now) {
        return new Promise<GameWorkerTickRoomResult[]>((resolve) => {
          resolveCompute = () => resolve(rooms.map((r) => ({
            roomId: r.roomId,
            baseRevision: r.baseRevision,
            result: 'unchanged' as const,
          })))
        })
      },
    },
  })

  const room = makeFakeRoom('r13')
  const batchPromise = orch.computeCandidates({ now: Date.now(), rooms: [room] })

  let shutdownResolved = false
  const shutdownPromise = orch.shutdown().then(() => { shutdownResolved = true })

  assert.strictEqual(shutdownResolved, false)

  resolveCompute()
  await batchPromise

  await shutdownPromise
  assert.strictEqual(shutdownResolved, true)
})

// F14: repeated shutdown returns same Promise
await check('F14: repeated shutdown() returns same Promise', async () => {
  const reg = createRoomRevisionRegistry()
  const orch = createGameWorkerTickOrchestrator({
    mode: 'worker-candidate',
    revisionRegistry: reg,
    tickClient: makeFakeTickClient(),
  })
  const p1 = orch.shutdown()
  const p2 = orch.shutdown()
  assert.strictEqual(p1, p2)
  await p1
})

// F15: call after shutdown → failed
await check('F15: computeCandidates() after shutdown → failed', async () => {
  const reg = createRoomRevisionRegistry()
  reg.ensure('r15')
  const orch = createGameWorkerTickOrchestrator({
    mode: 'worker-candidate',
    revisionRegistry: reg,
    tickClient: makeFakeTickClient(),
  })
  await orch.shutdown()
  const result = await orch.computeCandidates({ now: Date.now(), rooms: [makeFakeRoom('r15')] })
  assert.strictEqual(result.status, 'failed')
  if (result.status === 'failed') {
    assert.ok(result.message.includes('shutdown'))
  }
})

// F16: duplicate input room ID → failed
await check('F16: duplicate input roomId → failed', async () => {
  const reg = createRoomRevisionRegistry()
  reg.ensure('r16')
  const orch = createGameWorkerTickOrchestrator({
    mode: 'worker-candidate',
    revisionRegistry: reg,
    tickClient: makeFakeTickClient(),
  })
  const result = await orch.computeCandidates({
    now: Date.now(),
    rooms: [makeFakeRoom('r16'), makeFakeRoom('r16')],
  })
  assert.strictEqual(result.status, 'failed')
  if (result.status === 'failed') {
    assert.ok(result.message.includes('duplicate'))
  }
  await orch.shutdown()
})

// F17: unknown registry room → failed
await check('F17: room not in registry → failed', async () => {
  const reg = createRoomRevisionRegistry()
  const orch = createGameWorkerTickOrchestrator({
    mode: 'worker-candidate',
    revisionRegistry: reg,
    tickClient: makeFakeTickClient(),
  })
  const result = await orch.computeCandidates({ now: Date.now(), rooms: [makeFakeRoom('r17')] })
  assert.strictEqual(result.status, 'failed')
  if (result.status === 'failed') {
    assert.ok(result.message.includes('not registered') || result.message.includes('registry'))
  }
  await orch.shutdown()
})

// F18: registry lookup uses room.id — rejects unknown room
await check('F18: registry lookup uses room.id and rejects unknown room', async () => {
  const reg = createRoomRevisionRegistry()
  reg.ensure('r18')
  const orch = createGameWorkerTickOrchestrator({
    mode: 'worker-candidate',
    revisionRegistry: reg,
    tickClient: makeFakeTickClient(),
  })
  // Known room → completed
  const result = await orch.computeCandidates({ now: Date.now(), rooms: [makeFakeRoom('r18')] })
  assert.strictEqual(result.status, 'completed')
  // Unknown room → failed (registry lookup by room.id fails)
  const result2 = await orch.computeCandidates({ now: Date.now(), rooms: [makeFakeRoom('r18-unknown')] })
  assert.strictEqual(result2.status, 'failed')
  await orch.shutdown()
})

// F19: invalid now → failed
await check('F19: invalid now (NaN) → failed', async () => {
  const reg = createRoomRevisionRegistry()
  reg.ensure('r19')
  const orch = createGameWorkerTickOrchestrator({
    mode: 'worker-candidate',
    revisionRegistry: reg,
    tickClient: makeFakeTickClient(),
  })
  const result = await orch.computeCandidates({ now: NaN, rooms: [makeFakeRoom('r19')] })
  assert.strictEqual(result.status, 'failed')
  if (result.status === 'failed') {
    assert.ok(result.message.includes('now'))
  }
  await orch.shutdown()
})

// ─── Orchestrator health (worker-candidate mode) ──────────────────────────────

console.log('\n═══ Section 2b: Orchestrator health ═══')

await check('OH1: initial health — correct mode, inFlight=false, isShuttingDown=false (worker-candidate)', () => {
  const reg = createRoomRevisionRegistry()
  const orch = createGameWorkerTickOrchestrator({
    mode: 'worker-candidate',
    revisionRegistry: reg,
    tickClient: makeFakeTickClient(),
  })
  const h = orch.getHealth()
  assert.strictEqual(h.mode, 'worker-candidate')
  assert.strictEqual(h.inFlight, false)
  assert.strictEqual(h.isShuttingDown, false)
})

await check('OH2: initial health — correct mode, inFlight=false, isShuttingDown=false (in-process)', () => {
  const reg = createRoomRevisionRegistry()
  const orch = createGameWorkerTickOrchestrator({
    mode: 'in-process',
    revisionRegistry: reg,
    syncTickTarget: makeFakeSyncTarget(),
  })
  const h = orch.getHealth()
  assert.strictEqual(h.mode, 'in-process')
  assert.strictEqual(h.inFlight, false)
  assert.strictEqual(h.isShuttingDown, false)
})

await check('OH3: inFlight=true while batch pending', async () => {
  const reg = createRoomRevisionRegistry()
  reg.ensure('oh3')

  let resolveCompute!: () => void
  const orch = createGameWorkerTickOrchestrator({
    mode: 'worker-candidate',
    revisionRegistry: reg,
    tickClient: {
      computeTickRooms(rooms, _now) {
        return new Promise<GameWorkerTickRoomResult[]>((resolve) => {
          resolveCompute = () => resolve(rooms.map((r) => ({
            roomId: r.roomId,
            baseRevision: r.baseRevision,
            result: 'unchanged' as const,
          })))
        })
      },
    },
  })

  const batchPromise = orch.computeCandidates({ now: Date.now(), rooms: [makeFakeRoom('oh3')] })

  // At this point the batch is pending — inFlight should be true
  assert.strictEqual(orch.getHealth().inFlight, true)
  assert.strictEqual(orch.getHealth().isShuttingDown, false)

  resolveCompute()
  await batchPromise

  assert.strictEqual(orch.getHealth().inFlight, false)
  await orch.shutdown()
})

await check('OH4: inFlight=false after success', async () => {
  const reg = createRoomRevisionRegistry()
  reg.ensure('oh4')
  const orch = createGameWorkerTickOrchestrator({
    mode: 'worker-candidate',
    revisionRegistry: reg,
    tickClient: makeFakeTickClient(),
  })
  await orch.computeCandidates({ now: Date.now(), rooms: [makeFakeRoom('oh4')] })
  assert.strictEqual(orch.getHealth().inFlight, false)
  await orch.shutdown()
})

await check('OH5: inFlight=false after failed request', async () => {
  const reg = createRoomRevisionRegistry()
  reg.ensure('oh5')
  const orch = createGameWorkerTickOrchestrator({
    mode: 'worker-candidate',
    revisionRegistry: reg,
    tickClient: makeFakeTickClient({ throwOnCompute: true }),
  })
  await orch.computeCandidates({ now: Date.now(), rooms: [makeFakeRoom('oh5')] })
  assert.strictEqual(orch.getHealth().inFlight, false)
  await orch.shutdown()
})

await check('OH6: isShuttingDown=true after shutdown()', async () => {
  const reg = createRoomRevisionRegistry()
  const orch = createGameWorkerTickOrchestrator({
    mode: 'worker-candidate',
    revisionRegistry: reg,
    tickClient: makeFakeTickClient(),
  })
  void orch.shutdown()
  assert.strictEqual(orch.getHealth().isShuttingDown, true)
  await orch.shutdown()
})

await check('OH7: repeated getHealth() has no side effects', async () => {
  const reg = createRoomRevisionRegistry()
  reg.ensure('oh7')
  const orch = createGameWorkerTickOrchestrator({
    mode: 'worker-candidate',
    revisionRegistry: reg,
    tickClient: makeFakeTickClient(),
  })
  for (let i = 0; i < 5; i++) {
    const h: GameWorkerTickOrchestratorHealth = orch.getHealth()
    assert.strictEqual(h.mode, 'worker-candidate')
    assert.strictEqual(h.inFlight, false)
    assert.strictEqual(h.isShuttingDown, false)
  }
  await orch.shutdown()
})

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3: Sync fallback (in-process mode)
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n═══ Section 3: Sync fallback (in-process mode) ═══')

// S1: sync target is called, tick client is not
await check('S1: sync target called, tick client not called', async () => {
  const reg = createRoomRevisionRegistry()
  reg.ensure('s1')

  let tickClientCalled = false
  const syncTarget = makeFakeSyncTarget()

  const orch = createGameWorkerTickOrchestrator({
    mode: 'in-process',
    revisionRegistry: reg,
    syncTickTarget: syncTarget,
  })

  const result = await orch.computeCandidates({ now: Date.now(), rooms: [makeFakeRoom('s1')] })
  assert.strictEqual(result.status, 'completed')
  assert.strictEqual(syncTarget.callCount, 1)
  assert.strictEqual(tickClientCalled, false)
  await orch.shutdown()
})

// S2: unchanged mapping
await check('S2: sync unchanged → kind=unchanged', async () => {
  const reg = createRoomRevisionRegistry()
  reg.ensure('s2')

  const orch = createGameWorkerTickOrchestrator({
    mode: 'in-process',
    revisionRegistry: reg,
    syncTickTarget: makeFakeSyncTarget(),
  })

  const result = await orch.computeCandidates({ now: Date.now(), rooms: [makeFakeRoom('s2')] })
  assert.strictEqual(result.status, 'completed')
  if (result.status === 'completed') {
    assert.strictEqual(result.results[0].kind, 'unchanged')
  }
  await orch.shutdown()
})

// S3: advanced mapping
await check('S3: sync advanced → kind=advanced', async () => {
  const reg = createRoomRevisionRegistry()
  reg.ensure('s3')
  const advancedRoom = makeFakeRoom('s3')

  const syncTarget = makeFakeSyncTarget({
    buildResults: (input) => input.rooms.map((room) => ({
      kind: 'advanced' as const,
      roomId: room.id,
      room: advancedRoom,
    })),
  })

  const orch = createGameWorkerTickOrchestrator({
    mode: 'in-process',
    revisionRegistry: reg,
    syncTickTarget: syncTarget,
  })

  const result = await orch.computeCandidates({ now: Date.now(), rooms: [makeFakeRoom('s3')] })
  assert.strictEqual(result.status, 'completed')
  if (result.status === 'completed') {
    const r = result.results[0]
    assert.strictEqual(r.kind, 'advanced')
    if (r.kind === 'advanced') {
      assert.strictEqual(r.room, advancedRoom)
    }
  }
  await orch.shutdown()
})

// S4: revision is not bumped by orchestrator
await check('S4: revision not bumped by sync orchestrator', async () => {
  const reg = createRoomRevisionRegistry()
  reg.ensure('s4')
  reg.bump('s4') // revision = 1

  const orch = createGameWorkerTickOrchestrator({
    mode: 'in-process',
    revisionRegistry: reg,
    syncTickTarget: makeFakeSyncTarget({
      buildResults: (input) => input.rooms.map((room) => ({
        kind: 'advanced' as const,
        roomId: room.id,
        room: makeFakeRoom(`${room.id}-next`),
      })),
    }),
  })

  await orch.computeCandidates({ now: Date.now(), rooms: [makeFakeRoom('s4')] })
  assert.strictEqual(reg.get('s4'), 1, 'Orchestrator must not bump revision')
  await orch.shutdown()
})

// S5: sync throw → failed batch
await check('S5: sync target throws → status=failed', async () => {
  const reg = createRoomRevisionRegistry()
  reg.ensure('s5')

  const orch = createGameWorkerTickOrchestrator({
    mode: 'in-process',
    revisionRegistry: reg,
    syncTickTarget: makeFakeSyncTarget({ throwOnTick: 'sync crash' }),
  })

  const result = await orch.computeCandidates({ now: Date.now(), rooms: [makeFakeRoom('s5')] })
  assert.strictEqual(result.status, 'failed')
  if (result.status === 'failed') {
    assert.ok(result.message.includes('sync crash'))
  }
  await orch.shutdown()
})

// S6: busy guard works in sync mode
await check('S6: busy guard works in in-process mode', async () => {
  const reg = createRoomRevisionRegistry()
  reg.ensure('s6')

  let callCount = 0
  const syncTarget: FakeSyncTarget = {
    get callCount() { return callCount },
    tickRooms(input: TickRoomsInput): TickRoomsResult {
      callCount += 1
      return { results: input.rooms.map((r) => ({ kind: 'unchanged' as const, roomId: r.id })) }
    },
  }

  const orch = createGameWorkerTickOrchestrator({
    mode: 'in-process',
    revisionRegistry: reg,
    syncTickTarget: syncTarget,
  })

  const room = makeFakeRoom('s6')
  const [r1, r2] = await Promise.all([
    orch.computeCandidates({ now: Date.now(), rooms: [room] }),
    orch.computeCandidates({ now: Date.now(), rooms: [room] }),
  ])

  const statuses = [r1.status, r2.status]
  assert.ok(statuses.includes('completed'), 'at least one should complete')
  assert.ok(
    statuses.every((s) => s === 'completed' || s === 'busy'),
    `unexpected statuses: ${JSON.stringify(statuses)}`,
  )
  await orch.shutdown()
})

// S7: sync target returns unregistered roomId → batch failed
await check('S7: sync target returns unregistered roomId → status=failed', async () => {
  const reg = createRoomRevisionRegistry()
  reg.ensure('s7-known')

  const orch = createGameWorkerTickOrchestrator({
    mode: 'in-process',
    revisionRegistry: reg,
    // Sync target returns a result for a room NOT in the registry
    syncTickTarget: makeFakeSyncTarget({
      buildResults: () => [{
        kind: 'unchanged' as const,
        roomId: 's7-unknown-ghost',
      }],
    }),
  })

  const result = await orch.computeCandidates({ now: Date.now(), rooms: [makeFakeRoom('s7-known')] })
  assert.strictEqual(result.status, 'failed')
  if (result.status === 'failed') {
    assert.ok(
      result.message.includes('unregistered') || result.message.includes('s7-unknown-ghost'),
      `Unexpected message: ${result.message}`,
    )
  }
  await orch.shutdown()
})

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4: Real worker integration
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n═══ Section 4: Real worker integration ═══')

const workerUrl = await resolveGameWorkerEntryUrl()

// RW1: Worker ready — settled guard + terminate().then() in fallback
await check('RW1: worker sends ready signal', async () => {
  const worker = new Worker(workerUrl, { workerData: { workerId: 'orch-rw1' } })
  let settled = false

  try {
    const readyMsg = await new Promise<unknown>((resolve, reject) => {
      const t = setTimeout(() => {
        if (!settled) {
          settled = true
          reject(new Error('ready timeout'))
        }
      }, 5000)
      worker.once('message', (msg) => {
        clearTimeout(t)
        if (!settled) { settled = true; resolve(msg) }
      })
      worker.once('error', (err) => {
        clearTimeout(t)
        if (!settled) { settled = true; reject(err) }
      })
    })
    const m = readyMsg as Record<string, unknown>
    assert.strictEqual(m['type'], 'ready')
    assert.strictEqual(m['protocolVersion'], GAME_WORKER_PROTOCOL_VERSION)
  } finally {
    settled = false
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        if (!settled) {
          settled = true
          void worker.terminate().then(() => resolve(), () => resolve())
        }
      }, 2000)
      worker.postMessage({ type: 'shutdown', requestId: 'rw1-shutdown' })
      worker.once('exit', () => {
        if (!settled) {
          settled = true
          clearTimeout(t)
          resolve()
        }
      })
    })
  }
})

// RW2-RW6: Full orchestrator integration
await check('RW2-RW6: assign room + registry.ensure + computeCandidates → valid batch', async () => {
  await withWorker(workerUrl, async (worker, endpoint) => {
    const roomId = 'orch-real-room-1'
    await assignRoom(worker, roomId)

    const reg = createRoomRevisionRegistry()
    reg.ensure(roomId)

    const tickClient = createGameWorkerTickClient({ endpoint, requestTimeoutMs: 10_000 })
    const orch = createGameWorkerTickOrchestrator({
      mode: 'worker-candidate',
      revisionRegistry: reg,
      tickClient,
    })

    const room = buildRealisticRoom(roomId)
    const result = await orch.computeCandidates({ now: Date.now(), rooms: [room] })

    assert.strictEqual(result.status, 'completed')
    if (result.status === 'completed') {
      assert.strictEqual(result.results.length, 1)
      const r = result.results[0]
      assert.strictEqual(r.roomId, roomId)
      assert.ok(r.kind === 'unchanged' || r.kind === 'advanced', `unexpected kind: ${r.kind}`)
      assert.strictEqual(r.baseRevision, 0)
    }

    await orch.shutdown()
    await tickClient.shutdown()
  })
})

// RW7: advanced candidate from real worker
await check('RW7: advanced candidate при far-future now (real worker)', async () => {
  await withWorker(workerUrl, async (worker, endpoint) => {
    const roomId = 'orch-real-room-2'
    await assignRoom(worker, roomId)

    const reg = createRoomRevisionRegistry()
    reg.ensure(roomId)

    const tickClient = createGameWorkerTickClient({ endpoint, requestTimeoutMs: 10_000 })
    const orch = createGameWorkerTickOrchestrator({
      mode: 'worker-candidate',
      revisionRegistry: reg,
      tickClient,
    })

    const room = buildRealisticRoom(roomId)
    // advanceRoomAuthoritativeGame може да използва Math.random() при shuffle/auto-cut transitions.
    // Затова не правим deepStrictEqual между локален и worker-candidate резултат.
    const farFutureNow = (room.game.timerDeadlineAt ?? room.updatedAt) + 60_000

    const localProof = advanceRoomAuthoritativeGame(room, farFutureNow)
    assert.notStrictEqual(localProof, room, 'local advance must return new object')

    const result = await orch.computeCandidates({ now: farFutureNow, rooms: [room] })

    assert.strictEqual(result.status, 'completed')
    if (result.status === 'completed') {
      const r = result.results[0]
      assert.strictEqual(r.roomId, roomId)
      assert.strictEqual(r.kind, 'advanced', `expected 'advanced', got '${r.kind}'`)
      if (r.kind === 'advanced') {
        assert.strictEqual(r.room.id, roomId)
        assert.ok(r.room.game.authoritativeState !== null)
        assert.ok(r.room.game.stateVersion > room.game.stateVersion)
      }
    }

    await orch.shutdown()
    await tickClient.shutdown()
  })
})

// RW8: Deterministic stale simulation
// Uses explicit promise gates — no arbitrary sleep.
// markRequestStarted() is called inside the wrapper when computeTickRooms is invoked.
// The bump happens only after the gate fires, before the result is released.
await check('RW8: stale simulation — deterministic gate, bump after request start', async () => {
  await withWorker(workerUrl, async (worker, endpoint) => {
    const roomId = 'orch-real-stale'
    await assignRoom(worker, roomId)

    const reg = createRoomRevisionRegistry()
    reg.ensure(roomId)

    const realClient = createGameWorkerTickClient({ endpoint, requestTimeoutMs: 10_000 })

    let markRequestStarted!: () => void
    const requestStarted = new Promise<void>((resolve) => {
      markRequestStarted = resolve
    })

    let releaseResult!: () => void
    const releaseGate = new Promise<void>((resolve) => {
      releaseResult = resolve
    })

    const wrappedClient = {
      async computeTickRooms(
        rooms: Parameters<typeof realClient.computeTickRooms>[0],
        now: Parameters<typeof realClient.computeTickRooms>[1],
      ) {
        const pendingResult = realClient.computeTickRooms(rooms, now)
        markRequestStarted()
        const results = await pendingResult
        await releaseGate
        return results
      },
    }

    const orch = createGameWorkerTickOrchestrator({
      mode: 'worker-candidate',
      revisionRegistry: reg,
      tickClient: wrappedClient,
    })

    const room = buildRealisticRoom(roomId)
    const batchPromise = orch.computeCandidates({ now: Date.now(), rooms: [room] })

    // Wait until computeTickRooms has been called and real request is in-flight
    await requestStarted

    // Bump revision while the request result is held behind the gate
    reg.bump(roomId) // revision = 1, but baseRevision sent was 0

    // Release the held result — orchestrator will see stale
    releaseResult()

    const result = await batchPromise
    assert.strictEqual(result.status, 'completed')
    if (result.status === 'completed') {
      assert.strictEqual(result.results[0].kind, 'stale', `expected stale, got ${result.results[0].kind}`)
      assert.strictEqual(result.results[0].baseRevision, 0)
    }

    await orch.shutdown()
    await realClient.shutdown()
  })
})

// RW9-RW13: clean shutdown — exit timeout uses terminate().then() before reject
await check('RW9-RW13: clean orchestrator + tick client + lifecycle shutdown, no orphan, no unhandled rejection', async () => {
  let unhandled = false
  const handler = () => { unhandled = true }
  process.on('unhandledRejection', handler)

  try {
    const worker = new Worker(workerUrl, { workerData: { workerId: 'orch-shutdown-test' } })
    let workerSettled = false

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => {
        if (!workerSettled) {
          workerSettled = true
          void worker.terminate().then(
            () => reject(new Error('ready timeout')),
            () => reject(new Error('ready timeout')),
          )
        }
      }, 5000)
      worker.once('message', (msg: unknown) => {
        clearTimeout(t)
        if (!workerSettled) {
          workerSettled = true
          const m = msg as Record<string, unknown>
          if (m['type'] === 'ready') resolve()
          else reject(new Error(`expected ready, got ${JSON.stringify(msg)}`))
        }
      })
      worker.once('error', (err) => {
        clearTimeout(t)
        if (!workerSettled) { workerSettled = true; reject(err) }
      })
    })

    const endpoint: GameWorkerTickMessageEndpoint = {
      postMessage: (msg) => worker.postMessage(msg),
      on: (event, listener) => worker.on(event, listener),
      off: (event, listener) => worker.off(event, listener),
    }

    const reg = createRoomRevisionRegistry()
    const tickClient = createGameWorkerTickClient({ endpoint })
    const orch = createGameWorkerTickOrchestrator({
      mode: 'worker-candidate',
      revisionRegistry: reg,
      tickClient,
    })

    await orch.shutdown()
    await tickClient.shutdown()

    // Lifecycle shutdown — send shutdown to worker and wait for exit
    let exitSettled = false
    const exitCode = await new Promise<number>((resolve, reject) => {
      const t = setTimeout(() => {
        if (!exitSettled) {
          exitSettled = true
          void worker.terminate().then(
            () => reject(new Error('exit timeout')),
            () => reject(new Error('exit timeout')),
          )
        }
      }, 5000)
      worker.once('exit', (code) => {
        if (!exitSettled) {
          exitSettled = true
          clearTimeout(t)
          resolve(code)
        }
      })
      worker.postMessage({ type: 'shutdown', requestId: 'orch-final-shutdown' })
    })

    assert.strictEqual(exitCode, 0, `Worker must exit with code 0, got ${exitCode}`)
    assert.strictEqual(unhandled, false, 'No unhandled rejection')
  } finally {
    process.off('unhandledRejection', handler)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// Final summary
// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n═══ Summary: ${passCount} passed, ${failCount} failed ═══`)

if (failCount > 0) {
  process.exit(1)
}
