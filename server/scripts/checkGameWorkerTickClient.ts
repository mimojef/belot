/**
 * checkGameWorkerTickClient.ts
 *
 * Проверява createGameWorkerTickClient с:
 * - fake endpoint unit scenarios (без реален Worker)
 * - real Worker integration scenarios
 * - structured-clone correctness
 * - payload size и latency measurements
 */

import assert from 'node:assert/strict'
import { MessageChannel } from 'node:worker_threads'
import { Worker } from 'node:worker_threads'
import {
  createGameWorkerTickClient,
  type GameWorkerTickMessageEndpoint,
} from '../src/game/createGameWorkerTickClient.js'
import {
  GAME_WORKER_PROTOCOL_VERSION,
  type GameWorkerTickRoomInput,
} from '../src/game/workerProtocol.js'
import type { ServerRoom } from '../src/core/serverTypes.js'
import { resolveGameWorkerEntryUrl } from '../src/game/resolveGameWorkerEntryUrl.js'
import { createRoomWithHumanHost } from '../src/core/createRoomWithHumanHost.js'
import { addHumanToRoom } from '../src/core/addHumanToRoom.js'
import { addBotToRoom } from '../src/core/addBotToRoom.js'
import { initializeRoomAuthoritativeGameState } from '../src/game/initializeRoomAuthoritativeGameState.js'
import { advanceRoomAuthoritativeGame } from '../src/game/advanceRoomAuthoritativeGame.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

// Минимална fake room за unit tests (не е нужен реален state)
function makeFakeRoom(id: string): ServerRoom {
  return { id, game: { phase: null } } as unknown as ServerRoom
}

function makeFakeInput(roomId: string, baseRevision = 0): GameWorkerTickRoomInput {
  return { roomId, baseRevision, room: makeFakeRoom(roomId) }
}

// Fake endpoint — изцяло контролиран
type FakeEndpointOptions = {
  onPostMessage?: (msg: unknown) => void
  throwOnPost?: boolean
}

type FakeEndpoint = GameWorkerTickMessageEndpoint & {
  emit(msg: unknown): void
  getPostedMessages(): unknown[]
}

function makeFakeEndpoint(opts: FakeEndpointOptions = {}): FakeEndpoint {
  const listeners: Array<(msg: unknown) => void> = []
  const posted: unknown[] = []

  return {
    postMessage(msg: unknown): void {
      if (opts.throwOnPost === true) {
        throw new Error('postMessage intentionally failed')
      }
      posted.push(msg)
      opts.onPostMessage?.(msg)
    },
    on(_event: 'message', listener: (msg: unknown) => void): unknown {
      listeners.push(listener)
      return undefined
    },
    off(_event: 'message', listener: (msg: unknown) => void): unknown {
      const idx = listeners.indexOf(listener)
      if (idx !== -1) listeners.splice(idx, 1)
      return undefined
    },
    emit(msg: unknown): void {
      for (const l of [...listeners]) l(msg)
    },
    getPostedMessages(): unknown[] {
      return posted
    },
  }
}

function makeValidResponse(
  requestId: string,
  inputs: GameWorkerTickRoomInput[],
  kind: 'unchanged' | 'advanced' = 'unchanged',
) {
  return {
    protocolVersion: GAME_WORKER_PROTOCOL_VERSION,
    type: 'compute_tick_rooms_response',
    requestId,
    results: inputs.map((i) =>
      kind === 'unchanged'
        ? { roomId: i.roomId, baseRevision: i.baseRevision, result: 'unchanged' as const }
        : {
            roomId: i.roomId,
            baseRevision: i.baseRevision,
            result: 'advanced' as const,
            room: { ...i.room },
          },
    ),
  }
}

// Recursive inspector за non-plain стойности в ServerRoom DTO.
// Date, Map, Set са structured-clone-able, но нежелани в plain DTO contract.
// Function и Symbol са неподходящи за postMessage.
// Тестът изисква ServerRoom да остане изцяло plain-data DTO.
function findUnexpectedNonPlainValues(value: unknown, path = 'root'): string[] {
  const found: string[] = []

  if (value instanceof Date) {
    found.push(`${path}: Date (cloneable, but unexpected in plain DTO)`)
    return found
  }
  if (value instanceof Map) {
    found.push(`${path}: Map (cloneable, but unexpected in plain DTO)`)
    return found
  }
  if (value instanceof Set) {
    found.push(`${path}: Set (cloneable, but unexpected in plain DTO)`)
    return found
  }
  if (typeof value === 'function') {
    found.push(`${path}: Function (not suitable for postMessage)`)
    return found
  }
  if (typeof value === 'symbol') {
    found.push(`${path}: Symbol (not suitable for postMessage)`)
    return found
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      found.push(...findUnexpectedNonPlainValues(value[i], `${path}[${i}]`))
    }
    return found
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      found.push(...findUnexpectedNonPlainValues(v, `${path}.${k}`))
    }
  }
  return found
}

// ─── Section: Fake endpoint unit scenarios ────────────────────────────────────

console.log('\n═══ Fake endpoint scenarios ═══')

// 1. Valid request се post-ва
await check('1: valid request се post-ва', async () => {
  const ep = makeFakeEndpoint()
  const client = createGameWorkerTickClient({ endpoint: ep })
  const inputs = [makeFakeInput('room-1', 0)]

  const promise = client.computeTickRooms(inputs, Date.now())

  const posted = ep.getPostedMessages()
  assert.equal(posted.length, 1)
  const msg = posted[0] as Record<string, unknown>
  assert.equal(msg['type'], 'compute_tick_rooms')
  assert.equal(msg['protocolVersion'], GAME_WORKER_PROTOCOL_VERSION)
  assert.equal(typeof msg['requestId'], 'string')

  // Resolve the promise to avoid unhandled rejection
  const rid = msg['requestId'] as string
  ep.emit(makeValidResponse(rid, inputs))
  await promise
})

// 2. Valid response resolve-ва
await check('2: valid response resolve-ва', async () => {
  const ep = makeFakeEndpoint()
  const client = createGameWorkerTickClient({ endpoint: ep })
  const inputs = [makeFakeInput('room-a', 5)]

  let capturedRequestId = ''
  ep.postMessage = (msg) => {
    capturedRequestId = (msg as Record<string, unknown>)['requestId'] as string
  }

  const promise = client.computeTickRooms(inputs, Date.now())
  ep.emit(makeValidResponse(capturedRequestId, inputs))
  const results = await promise
  assert.equal(results.length, 1)
  assert.equal(results[0].roomId, 'room-a')
  assert.equal(results[0].result, 'unchanged')
})

// 3. Request ID correlation
await check('3: request ID correlation', async () => {
  const ep = makeFakeEndpoint()
  const client = createGameWorkerTickClient({ endpoint: ep })
  const inputs = [makeFakeInput('room-x', 0)]

  let sentRequestId = ''
  const origPost = ep.postMessage.bind(ep)
  ep.postMessage = (msg) => {
    sentRequestId = (msg as Record<string, unknown>)['requestId'] as string
    origPost(msg)
  }

  const promise = client.computeTickRooms(inputs, Date.now())
  // Wrong requestId → should be ignored
  ep.emit(makeValidResponse('wrong-id', inputs))
  // Correct requestId
  ep.emit(makeValidResponse(sentRequestId, inputs))
  const results = await promise
  assert.equal(results[0].roomId, 'room-x')
})

// 4. Revision echo validation — wrong revision → reject
await check('4: wrong revision → reject', async () => {
  const ep = makeFakeEndpoint()
  const client = createGameWorkerTickClient({ endpoint: ep })
  const inputs = [makeFakeInput('room-r', 7)]

  let sentId = ''
  ep.postMessage = (msg) => { sentId = (msg as Record<string, unknown>)['requestId'] as string }

  const promise = client.computeTickRooms(inputs, Date.now())
  ep.emit({
    protocolVersion: GAME_WORKER_PROTOCOL_VERSION,
    type: 'compute_tick_rooms_response',
    requestId: sentId,
    results: [{ roomId: 'room-r', baseRevision: 99, result: 'unchanged' }],
  })
  await assert.rejects(promise, /revision mismatch/)
})

// 5. Unknown result room ID → reject
await check('5: unknown result room ID → reject', async () => {
  const ep = makeFakeEndpoint()
  const client = createGameWorkerTickClient({ endpoint: ep })
  const inputs = [makeFakeInput('room-known', 0)]

  let sentId = ''
  ep.postMessage = (msg) => { sentId = (msg as Record<string, unknown>)['requestId'] as string }

  const promise = client.computeTickRooms(inputs, Date.now())
  ep.emit({
    protocolVersion: GAME_WORKER_PROTOCOL_VERSION,
    type: 'compute_tick_rooms_response',
    requestId: sentId,
    results: [{ roomId: 'room-unknown', baseRevision: 0, result: 'unchanged' }],
  })
  await assert.rejects(promise, /unexpected result roomId|revision mismatch|missing result/)
})

// 6. Missing result → reject
await check('6: missing result → reject', async () => {
  const ep = makeFakeEndpoint()
  const client = createGameWorkerTickClient({ endpoint: ep })
  const inputs = [makeFakeInput('room-m1', 0), makeFakeInput('room-m2', 0)]

  let sentId = ''
  ep.postMessage = (msg) => { sentId = (msg as Record<string, unknown>)['requestId'] as string }

  const promise = client.computeTickRooms(inputs, Date.now())
  ep.emit({
    protocolVersion: GAME_WORKER_PROTOCOL_VERSION,
    type: 'compute_tick_rooms_response',
    requestId: sentId,
    results: [{ roomId: 'room-m1', baseRevision: 0, result: 'unchanged' }],
  })
  await assert.rejects(promise, /expected 2 results, got 1/)
})

// 7. Duplicate result room IDs → malformed correlated response → immediate reject
// (type guard блокира duplicate IDs → type=compute_tick_rooms_response + known requestId + fails guard → immediate reject)
await check('7: duplicate result room IDs → malformed correlated reject', async () => {
  const ep = makeFakeEndpoint()
  const client = createGameWorkerTickClient({ endpoint: ep })
  const inputs = [makeFakeInput('room-d', 0)]

  let sentId = ''
  ep.postMessage = (msg) => { sentId = (msg as Record<string, unknown>)['requestId'] as string }

  const promise = client.computeTickRooms(inputs, Date.now())
  // Дублирани IDs → isGameWorkerComputeTickRoomsResponseMessage връща false
  // → клиентът открива correlated + malformed → immediate reject
  ep.emit({
    protocolVersion: GAME_WORKER_PROTOCOL_VERSION,
    type: 'compute_tick_rooms_response',
    requestId: sentId,
    results: [
      { roomId: 'room-d', baseRevision: 0, result: 'unchanged' },
      { roomId: 'room-d', baseRevision: 0, result: 'unchanged' },
    ],
  })
  await assert.rejects(promise, /malformed compute_tick_rooms_response/)
})

// 7b. Malformed correlated response (wrong protocolVersion) → immediate reject, not timeout
// Доказателство: regex /malformed compute_tick_rooms_response/ не съвпада с timeout message
// "timed out after Nms", затова reject-ът задължително идва от validation path, не от timer.
await check('7b: malformed correlated response → immediate reject (not timeout)', async () => {
  const ep = makeFakeEndpoint()
  // 3000ms timeout — ако reject-ът идваше от timer, message щеше да е "timed out"
  const client = createGameWorkerTickClient({ endpoint: ep, requestTimeoutMs: 3000 })
  const inputs = [makeFakeInput('room-malf', 0)]

  let sentId = ''
  ep.postMessage = (msg) => { sentId = (msg as Record<string, unknown>)['requestId'] as string }

  const promise = client.computeTickRooms(inputs, Date.now())

  // Wrong protocolVersion → type guard fails → correlated + malformed → immediate reject
  ep.emit({
    type: 'compute_tick_rooms_response',
    protocolVersion: 999,
    requestId: sentId,
    results: [],
  })
  await assert.rejects(promise, /malformed compute_tick_rooms_response/)
})

// 7c. Unrelated malformed message → игнориран, следващият валиден resolve-ва
await check('7c: unrelated malformed message → ignored, valid response resolves', async () => {
  const ep = makeFakeEndpoint()
  const client = createGameWorkerTickClient({ endpoint: ep })
  const inputs = [makeFakeInput('room-unrel', 0)]

  let sentId = ''
  ep.postMessage = (msg) => { sentId = (msg as Record<string, unknown>)['requestId'] as string }

  const promise = client.computeTickRooms(inputs, Date.now())

  // Напълно неразпознато съобщение — без type=compute_tick_rooms_response → игнорирано
  ep.emit({ type: 'ready', workerId: 'worker-1', protocolVersion: 3, startedAt: Date.now() })
  ep.emit({ type: 'pong', requestId: 'some-ping', receivedAt: Date.now() })
  ep.emit({ type: 'health_response', requestId: 'hr', workerId: 'w', startedAt: 0, uptimeMs: 0, activeRooms: 0 })
  ep.emit({ this_is: 'garbage', foo: 42 })

  // Валиден response след това → трябва да resolve
  ep.emit(makeValidResponse(sentId, inputs))
  const results = await promise
  assert.equal(results.length, 1)
  assert.equal(results[0].result, 'unchanged')
})

// 8. Wrong revision in result → reject
await check('8: revision mismatch in result → reject', async () => {
  const ep = makeFakeEndpoint()
  const client = createGameWorkerTickClient({ endpoint: ep })
  const inputs = [makeFakeInput('room-rev', 3)]

  let sentId = ''
  ep.postMessage = (msg) => { sentId = (msg as Record<string, unknown>)['requestId'] as string }

  const promise = client.computeTickRooms(inputs, Date.now())
  ep.emit({
    protocolVersion: GAME_WORKER_PROTOCOL_VERSION,
    type: 'compute_tick_rooms_response',
    requestId: sentId,
    results: [{ roomId: 'room-rev', baseRevision: 0, result: 'unchanged' }],
  })
  await assert.rejects(promise, /revision mismatch/)
})

// 9. Malformed response с различен requestId → игнориран (не е correlated) → timeout
await check('9: malformed response с различен requestId → ignored (timeout)', async () => {
  const ep = makeFakeEndpoint()
  const client = createGameWorkerTickClient({ endpoint: ep, requestTimeoutMs: 50 })
  const inputs = [makeFakeInput('room-bad', 0)]

  const promise = client.computeTickRooms(inputs, Date.now())
  // requestId = 'whatever' не е в pending → не е correlated → игнориран
  ep.emit({ type: 'compute_tick_rooms_response', protocolVersion: 999, requestId: 'whatever' })
  await assert.rejects(promise, /timed out/)
})

// 10. Correlated worker_error → reject
await check('10: correlated worker_error → reject', async () => {
  const ep = makeFakeEndpoint()
  const client = createGameWorkerTickClient({ endpoint: ep })
  const inputs = [makeFakeInput('room-we', 0)]

  let sentId = ''
  ep.postMessage = (msg) => { sentId = (msg as Record<string, unknown>)['requestId'] as string }

  const promise = client.computeTickRooms(inputs, Date.now())
  ep.emit({ type: 'worker_error', requestId: sentId, message: 'worker crashed' })
  await assert.rejects(promise, /worker_error/)
})

// 11. Timeout → reject
await check('11: timeout → reject', async () => {
  const ep = makeFakeEndpoint()
  const client = createGameWorkerTickClient({ endpoint: ep, requestTimeoutMs: 30 })
  const inputs = [makeFakeInput('room-to', 0)]

  const promise = client.computeTickRooms(inputs, Date.now())
  await assert.rejects(promise, /timed out/)
})

// 12. Late response after timeout → ignore (no unhandled rejection)
await check('12: late response after timeout → ignore', async () => {
  const ep = makeFakeEndpoint()
  const client = createGameWorkerTickClient({ endpoint: ep, requestTimeoutMs: 30 })
  const inputs = [makeFakeInput('room-late', 0)]

  let sentId = ''
  ep.postMessage = (msg) => { sentId = (msg as Record<string, unknown>)['requestId'] as string }

  const promise = client.computeTickRooms(inputs, Date.now())
  await assert.rejects(promise, /timed out/)
  // Send late response — should be silently ignored
  ep.emit(makeValidResponse(sentId, inputs))
  // No crash, no unhandled rejection
  await new Promise((r) => setTimeout(r, 10))
})

// 13. Synchronous postMessage throw → reject and cleanup
await check('13: postMessage throw → reject and cleanup', async () => {
  const ep = makeFakeEndpoint({ throwOnPost: true })
  const client = createGameWorkerTickClient({ endpoint: ep })
  const inputs = [makeFakeInput('room-throw', 0)]

  const promise = client.computeTickRooms(inputs, Date.now())
  await assert.rejects(promise, /Failed to send/)
})

// 14. Duplicate input room ID → local reject
await check('14: duplicate input room ID → local reject', async () => {
  const ep = makeFakeEndpoint()
  const client = createGameWorkerTickClient({ endpoint: ep })
  const inputs = [makeFakeInput('room-dup', 0), makeFakeInput('room-dup', 1)]

  await assert.rejects(
    client.computeTickRooms(inputs, Date.now()),
    /Duplicate roomId/,
  )
})

// 15. room.id mismatch → local reject
await check('15: room.id mismatch → local reject', async () => {
  const ep = makeFakeEndpoint()
  const client = createGameWorkerTickClient({ endpoint: ep })
  const inputs: GameWorkerTickRoomInput[] = [
    { roomId: 'room-a', baseRevision: 0, room: makeFakeRoom('room-b') },
  ]

  await assert.rejects(
    client.computeTickRooms(inputs, Date.now()),
    /room\.id must equal roomId/,
  )
})

// 16. Invalid revision → local reject
await check('16: invalid revision → local reject', async () => {
  const ep = makeFakeEndpoint()
  const client = createGameWorkerTickClient({ endpoint: ep })
  const inputs: GameWorkerTickRoomInput[] = [
    { roomId: 'room-neg', baseRevision: -1, room: makeFakeRoom('room-neg') },
  ]

  await assert.rejects(
    client.computeTickRooms(inputs, Date.now()),
    /non-negative safe integer/,
  )
})

// 17. Shutdown rejects pending
await check('17: shutdown rejects pending', async () => {
  const ep = makeFakeEndpoint()
  const client = createGameWorkerTickClient({ endpoint: ep })
  const inputs = [makeFakeInput('room-sd', 0)]

  const promise = client.computeTickRooms(inputs, Date.now())
  await client.shutdown()
  await assert.rejects(promise, /Shutting down/)
})

// 18. Repeated shutdown returns same Promise
await check('18: repeated shutdown returns same Promise', async () => {
  const ep = makeFakeEndpoint()
  const client = createGameWorkerTickClient({ endpoint: ep })

  const p1 = client.shutdown()
  const p2 = client.shutdown()
  assert.strictEqual(p1, p2)
  await p1
})

// 19. Listener is removed after shutdown
await check('19: listener is removed after shutdown', async () => {
  let listenerCount = 0
  const ep: GameWorkerTickMessageEndpoint & { currentListeners: number } = {
    currentListeners: 0,
    postMessage() {},
    on() {
      listenerCount += 1
      this.currentListeners += 1
      return undefined
    },
    off() {
      this.currentListeners -= 1
      return undefined
    },
  }

  const client = createGameWorkerTickClient({ endpoint: ep })
  assert.equal(ep.currentListeners, 1, 'listener should be added on creation')

  await client.shutdown()
  assert.equal(ep.currentListeners, 0, 'listener should be removed after shutdown')
})

// 20. No unhandled rejection при timeout
await check('20: no unhandled rejection при timeout', async () => {
  const ep = makeFakeEndpoint()
  const client = createGameWorkerTickClient({ endpoint: ep, requestTimeoutMs: 20 })
  const inputs = [makeFakeInput('room-ur', 0)]

  // Attach unhandledRejection detector
  let unhandled = false
  const handler = () => { unhandled = true }
  process.on('unhandledRejection', handler)

  try {
    const promise = client.computeTickRooms(inputs, Date.now())
    // Properly catch the rejection
    await promise.catch(() => {})
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(unhandled, false, 'No unhandled rejection should occur')
  } finally {
    process.off('unhandledRejection', handler)
  }
})

// ─── Section: Real Worker integration scenarios ───────────────────────────────

console.log('\n═══ Real Worker integration scenarios ═══')

const workerUrl = await resolveGameWorkerEntryUrl()

// Helper за lifecycle управление на Worker
async function withWorker(
  fn: (worker: Worker, endpoint: GameWorkerTickMessageEndpoint) => Promise<void>,
): Promise<void> {
  const worker = new Worker(workerUrl, { workerData: { workerId: 'test-worker-1' } })

  let settled = false

  // Изчакай ready signal — задължително е първото съобщение
  const readyMsg = await new Promise<unknown>((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true
        reject(new Error('Worker ready timeout'))
      }
    }, 5000)
    worker.once('message', (msg: unknown) => {
      clearTimeout(timeout)
      if (!settled) {
        settled = true
        resolve(msg)
      }
    })
    worker.once('error', (err) => {
      clearTimeout(timeout)
      if (!settled) {
        settled = true
        reject(err)
      }
    })
  })

  if (
    readyMsg === null ||
    typeof readyMsg !== 'object' ||
    (readyMsg as Record<string, unknown>)['type'] !== 'ready'
  ) {
    await worker.terminate()
    throw new Error(`Unexpected first message from worker: ${JSON.stringify(readyMsg)}`)
  }

  const endpoint: GameWorkerTickMessageEndpoint = {
    postMessage: (msg) => worker.postMessage(msg),
    on: (event, listener) => worker.on(event, listener),
    off: (event, listener) => worker.off(event, listener),
  }

  try {
    await fn(worker, endpoint)
  } finally {
    // Graceful shutdown с settled guard
    settled = false
    await new Promise<void>((resolve) => {
      const cleanupTimer = setTimeout(() => {
        if (!settled) {
          settled = true
          // Изчакай terminate да приключи преди resolve, за да няма orphan worker
          void worker.terminate().then(
            () => resolve(),
            () => resolve(),
          )
        }
      }, 2000)
      worker.postMessage({ type: 'shutdown', requestId: 'cleanup-shutdown' })
      worker.once('exit', () => {
        if (!settled) {
          settled = true
          clearTimeout(cleanupTimer)
          resolve()
        }
      })
    })
  }
}

// Helper за assign room
async function assignRoom(worker: Worker, roomId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('assign timeout')), 3000)
    function handler(msg: unknown): void {
      if (
        msg !== null &&
        typeof msg === 'object' &&
        (msg as Record<string, unknown>)['type'] === 'assign_room_ack' &&
        (msg as Record<string, unknown>)['roomId'] === roomId
      ) {
        clearTimeout(timeout)
        worker.off('message', handler)
        resolve()
      }
    }
    worker.on('message', handler)
    worker.postMessage({ type: 'assign_room', requestId: `assign-${roomId}`, roomId })
  })
}

async function releaseRoom(worker: Worker, roomId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('release timeout')), 3000)
    function handler(msg: unknown): void {
      if (
        msg !== null &&
        typeof msg === 'object' &&
        (msg as Record<string, unknown>)['type'] === 'release_room_ack' &&
        (msg as Record<string, unknown>)['roomId'] === roomId
      ) {
        clearTimeout(timeout)
        worker.off('message', handler)
        resolve()
      }
    }
    worker.on('message', handler)
    worker.postMessage({ type: 'release_room', requestId: `release-${roomId}`, roomId })
  })
}

// Строим реалистичен ServerRoom (4 играча, initialized state)
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

// W1: Проверява реалния ready message — type, protocolVersion, workerId
await check('W1: lifecycle ready — protocolVersion === 3 и workerId в ready message', async () => {
  const worker = new Worker(workerUrl, { workerData: { workerId: 'test-worker-1' } })

  try {
    const readyMsg = await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Worker ready timeout')), 5000)
      worker.once('message', (msg: unknown) => {
        clearTimeout(timeout)
        resolve(msg)
      })
      worker.once('error', (err) => {
        clearTimeout(timeout)
        reject(err)
      })
    })

    assert.ok(readyMsg !== null && typeof readyMsg === 'object', 'ready message трябва да е обект')
    const msg = readyMsg as Record<string, unknown>
    assert.equal(msg['type'], 'ready', 'type трябва да е "ready"')
    assert.equal(msg['protocolVersion'], GAME_WORKER_PROTOCOL_VERSION, `protocolVersion трябва да е ${GAME_WORKER_PROTOCOL_VERSION}`)
    assert.equal(msg['workerId'], 'test-worker-1', 'workerId трябва да съвпада с workerData')
    assert.equal(typeof msg['startedAt'], 'number', 'startedAt трябва да е number')
  } finally {
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => { void worker.terminate(); resolve() }, 2000)
      worker.postMessage({ type: 'shutdown', requestId: 'w1-cleanup' })
      worker.once('exit', () => { clearTimeout(t); resolve() })
    })
  }
})

// W2: assign room
await check('W2: assign room', async () => {
  await withWorker(async (worker) => {
    await assignRoom(worker, 'room-w2')
  })
})

// W3: compute за assigned room → result received
await check('W3: compute за assigned room → result received', async () => {
  await withWorker(async (worker, endpoint) => {
    await assignRoom(worker, 'room-w3')

    const room = buildRealisticRoom('room-w3')
    const client = createGameWorkerTickClient({ endpoint })
    const results = await client.computeTickRooms(
      [{ roomId: 'room-w3', baseRevision: 0, room }],
      Date.now(),
    )

    assert.equal(results.length, 1)
    assert.equal(results[0].roomId, 'room-w3')
    assert.ok(results[0].result === 'unchanged' || results[0].result === 'advanced')
    await client.shutdown()
  })
})

// W4: unchanged candidate — доказано локално, че advanceRoomAuthoritativeGame връща same reference
await check('W4: unchanged candidate при no-op tick', async () => {
  await withWorker(async (worker, endpoint) => {
    await assignRoom(worker, 'room-w4')

    const room = buildRealisticRoom('room-w4')
    // Доказваме локално, че тикането с текущото now НЕ мени стайта
    const nowForTest = room.game.timerDeadlineAt !== null
      ? room.game.timerDeadlineAt - 10_000  // 10 секунди преди изтичане на таймера
      : Date.now() - 1000

    const localResult = advanceRoomAuthoritativeGame(room, nowForTest)
    assert.strictEqual(localResult, room, 'Локалният advance трябва да върне same reference при no-op')

    const client = createGameWorkerTickClient({ endpoint })
    const results = await client.computeTickRooms(
      [{ roomId: 'room-w4', baseRevision: 0, room }],
      nowForTest,
    )
    assert.equal(results.length, 1)
    assert.equal(results[0].result, 'unchanged', `Очакваме точно 'unchanged', получихме '${results[0].result}'`)
    await client.shutdown()
  })
})

// W5: advanced candidate — доказано локално, че advanceRoomAuthoritativeGame връща нов обект
// NOTE: deepStrictEqual срещу локален candidate не е възможен — advance включва Math.random()
// (shuffleServerDeck, pickServerAutoCutIndex), така че два извиквания дават различни карти.
// Вместо това доказваме: (1) локалният advance е нов обект, (2) worker върне 'advanced',
// (3) room.id е коректен, (4) authoritativeState е запазен след structured-clone.
await check('W5: advanced candidate при изтекъл таймер', async () => {
  await withWorker(async (worker, endpoint) => {
    await assignRoom(worker, 'room-w5')

    const room = buildRealisticRoom('room-w5')
    // Таймерът изтича след updatedAt + малко; тикаме далеч в бъдещето
    const farFutureNow = (room.game.timerDeadlineAt ?? room.updatedAt) + 60_000

    // Доказваме локално, че advance ще промени стайта (не-детерминистично, но структурно)
    const localProof = advanceRoomAuthoritativeGame(room, farFutureNow)
    assert.notStrictEqual(localProof, room, 'Локалният advance трябва да върне нов обект при изтекъл таймер')

    const client = createGameWorkerTickClient({ endpoint })
    const results = await client.computeTickRooms(
      [{ roomId: 'room-w5', baseRevision: 0, room }],
      farFutureNow,
    )
    assert.equal(results.length, 1)
    assert.equal(results[0].result, 'advanced', `Очакваме точно 'advanced', получихме '${results[0].result}'`)

    if (results[0].result === 'advanced') {
      const advanced = results[0].room
      // room.id е запазен
      assert.equal(advanced.id, room.id, 'advanced.id трябва да съвпада с оригиналния roomId')
      // authoritativeState не е null след advance
      assert.ok(advanced.game.authoritativeState !== null, 'authoritativeState трябва да е preserved')
      // stateVersion е нараснал (advance увеличава версията)
      assert.ok(
        advanced.game.stateVersion > room.game.stateVersion,
        `stateVersion трябва да е нараснал: was ${room.game.stateVersion}, got ${advanced.game.stateVersion}`,
      )
    }

    await client.shutdown()
  })
})

// W6: unassigned room → not_assigned
await check('W6: unassigned room → not_assigned', async () => {
  await withWorker(async (worker, endpoint) => {
    const room = buildRealisticRoom('room-w6-unassigned')
    const client = createGameWorkerTickClient({ endpoint })
    const results = await client.computeTickRooms(
      [{ roomId: 'room-w6-unassigned', baseRevision: 0, room }],
      Date.now(),
    )
    assert.equal(results.length, 1)
    assert.equal(results[0].result, 'error')
    if (results[0].result === 'error') {
      assert.equal(results[0].code, 'not_assigned')
    }
    await client.shutdown()
  })
})

// W7: release room
await check('W7: release room', async () => {
  await withWorker(async (worker) => {
    await assignRoom(worker, 'room-w7')
    await releaseRoom(worker, 'room-w7')
  })
})

// W8: compute след release → not_assigned
await check('W8: compute след release → not_assigned', async () => {
  await withWorker(async (worker, endpoint) => {
    await assignRoom(worker, 'room-w8')
    await releaseRoom(worker, 'room-w8')

    const room = buildRealisticRoom('room-w8')
    const client = createGameWorkerTickClient({ endpoint })
    const results = await client.computeTickRooms(
      [{ roomId: 'room-w8', baseRevision: 0, room }],
      Date.now(),
    )
    assert.equal(results[0].result, 'error')
    if (results[0].result === 'error') {
      assert.equal(results[0].code, 'not_assigned')
    }
    await client.shutdown()
  })
})

// W9: malformed duplicate batch → correlated worker_error
await check('W9: duplicate batch roomId → correlated worker_error → client reject', async () => {
  await withWorker(async (worker, endpoint) => {
    await assignRoom(worker, 'room-w9')

    // Изпращаме raw invalid message с duplicate roomIds — заобикаляме client validation
    const requestId = 'w9-dup-test'
    const room = buildRealisticRoom('room-w9')
    const rawMsg = {
      protocolVersion: GAME_WORKER_PROTOCOL_VERSION,
      type: 'compute_tick_rooms',
      requestId,
      now: Date.now(),
      rooms: [
        { roomId: 'room-w9', baseRevision: 0, room },
        { roomId: 'room-w9', baseRevision: 0, room },
      ],
    }

    const response = await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('no response')), 3000)
      function handler(msg: unknown): void {
        const m = msg as Record<string, unknown>
        if (m['requestId'] === requestId) {
          clearTimeout(timeout)
          worker.off('message', handler)
          resolve(msg)
        }
      }
      worker.on('message', handler)
      worker.postMessage(rawMsg)
    })

    const r = response as Record<string, unknown>
    assert.equal(r['type'], 'worker_error', 'Worker трябва да върне worker_error при duplicate batch')
    assert.equal(r['requestId'], requestId)
  })
})

// W10: partial batch — assigned + unassigned
await check('W10: partial batch — assigned и unassigned', async () => {
  await withWorker(async (worker, endpoint) => {
    await assignRoom(worker, 'room-w10-assigned')

    const assignedRoom = buildRealisticRoom('room-w10-assigned')
    const unassignedRoom = buildRealisticRoom('room-w10-unassigned')

    const client = createGameWorkerTickClient({ endpoint })
    const results = await client.computeTickRooms(
      [
        { roomId: 'room-w10-assigned', baseRevision: 0, room: assignedRoom },
        { roomId: 'room-w10-unassigned', baseRevision: 0, room: unassignedRoom },
      ],
      Date.now(),
    )

    assert.equal(results.length, 2)

    const assignedResult = results.find((r) => r.roomId === 'room-w10-assigned')
    const unassignedResult = results.find((r) => r.roomId === 'room-w10-unassigned')

    assert.ok(assignedResult !== undefined)
    assert.ok(unassignedResult !== undefined)
    assert.ok(
      assignedResult!.result === 'unchanged' || assignedResult!.result === 'advanced',
      `assigned room should compute, got ${assignedResult!.result}`,
    )
    assert.equal(unassignedResult!.result, 'error')
    if (unassignedResult!.result === 'error') {
      assert.equal(unassignedResult!.code, 'not_assigned')
    }

    await client.shutdown()
  })
})

// W11/W12: clean worker shutdown, no orphan
await check('W11/W12: clean worker shutdown, no orphan', async () => {
  const worker = new Worker(workerUrl, { workerData: { workerId: 'test-cleanup-1' } })

  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('ready timeout')), 5000)
    worker.once('message', () => { clearTimeout(t); resolve() })
    worker.once('error', reject)
  })

  const exitCode = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => {
      void worker.terminate()
      reject(new Error('shutdown timeout'))
    }, 5000)
    worker.once('exit', (code) => { clearTimeout(timeout); resolve(code) })
    worker.postMessage({ type: 'shutdown', requestId: 'clean-shutdown-test' })
  })

  assert.equal(exitCode, 0, 'Worker трябва да exit-не с код 0')
})

// W13: no unhandled rejection при real worker request — проверяваме реален not_assigned резултат
await check('W13: no unhandled rejection при real worker request', async () => {
  let unhandled = false
  const handler = () => { unhandled = true }
  process.on('unhandledRejection', handler)

  try {
    await withWorker(async (worker, endpoint) => {
      // НЕ assign-ваме room → worker ще върне not_assigned
      const room = buildRealisticRoom('room-w13-unassigned')
      const client = createGameWorkerTickClient({ endpoint })

      const results = await client.computeTickRooms(
        [{ roomId: 'room-w13-unassigned', baseRevision: 0, room }],
        Date.now(),
      )

      assert.equal(results.length, 1)
      assert.equal(results[0].result, 'error')
      if (results[0].result === 'error') {
        assert.equal(results[0].code, 'not_assigned', 'Трябва да получим not_assigned за неassigned room')
      }

      await client.shutdown()
    })

    assert.equal(unhandled, false, 'No unhandled rejection')
  } finally {
    process.off('unhandledRejection', handler)
  }
})

// ─── Section: Structured-clone correctness ────────────────────────────────────

console.log('\n═══ Structured-clone verification ═══')

// Real MessageChannel clone test — deepStrictEqual за стойности, notStrictEqual за обекти
await check('Clone: MessageChannel structured-clone — deepStrictEqual, notStrictEqual', async () => {
  const originalRoom = buildRealisticRoom('room-clone-mc')

  // Проверяваме за non-plain стойности преди опит
  const nonPlain = findUnexpectedNonPlainValues(originalRoom)
  if (nonPlain.length > 0) {
    throw new Error(`ServerRoom съдържа неочаквани non-plain стойности:\n  ${nonPlain.join('\n  ')}`)
  }

  const { port1, port2 } = new MessageChannel()

  try {
    const received = await new Promise<ServerRoom>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('MessageChannel timeout')), 3000)
      port2.once('message', (msg: unknown) => {
        clearTimeout(timeout)
        resolve(msg as ServerRoom)
      })
      port2.start()
      port1.postMessage(originalRoom)
    })

    // Стойностите трябва да са идентични (deepStrictEqual)
    assert.deepStrictEqual(received, originalRoom, 'Клонираната room трябва да има същите стойности')

    // Но трябва да е различен обект (структурно клониране, не reference)
    assert.notStrictEqual(received, originalRoom, 'Клонираната room трябва да е нов обект')

    // Nested objects също трябва да са различни references
    assert.notStrictEqual(received.game, originalRoom.game, 'game трябва да е нов обект')
    assert.notStrictEqual(received.seats, originalRoom.seats, 'seats трябва да е нов обект')
  } finally {
    port1.close()
    port2.close()
  }
})

await check('Clone: critical nested fields preserved after structured-clone', async () => {
  await withWorker(async (worker, endpoint) => {
    await assignRoom(worker, 'room-clone-test')

    const originalRoom = buildRealisticRoom('room-clone-test')
    const client = createGameWorkerTickClient({ endpoint })

    // Тикаме в бъдещето за да гарантираме advanced
    const farFutureNow = (originalRoom.game.timerDeadlineAt ?? originalRoom.updatedAt) + 60_000

    const results = await client.computeTickRooms(
      [{ roomId: 'room-clone-test', baseRevision: 0, room: originalRoom }],
      farFutureNow,
    )

    assert.equal(results.length, 1)
    const result = results[0]

    if (result.result === 'advanced') {
      const received = result.room

      // Базова структура е запазена след structured-clone
      assert.equal(received.id, originalRoom.id)
      assert.ok(received.seats !== null && typeof received.seats === 'object')
      assert.ok(received.game !== null && typeof received.game === 'object')

      const auth = received.game.authoritativeState
      assert.ok(auth !== null, 'authoritativeState трябва да е preserved')

      if (auth !== null && 'phase' in auth) {
        assert.ok(typeof auth.hands === 'object', 'hands трябва да е обект')
        assert.ok(Array.isArray(auth.deck), 'deck трябва да е масив')
        assert.ok(typeof auth.bidding === 'object', 'bidding трябва да е обект')
        assert.ok(Array.isArray(auth.bidding.entries), 'bidding.entries трябва да е масив')
        assert.ok(typeof auth.timer === 'object', 'timer трябва да е обект')
        assert.ok(Array.isArray(auth.declarations), 'declarations трябва да е масив')
        assert.ok(typeof auth.round === 'object', 'round трябва да е обект')
      }

      // received е различен обект от originalRoom
      assert.notStrictEqual(received, originalRoom)

      // stateVersion е нараснал
      assert.ok(
        received.game.stateVersion > originalRoom.game.stateVersion,
        `stateVersion трябва да е нараснал след advance`,
      )
    } else {
      console.log(`    (room result was '${result.result}' — clone comparison skipped)`)
    }

    await client.shutdown()
  })
})

await check('Clone: no Date/Map/Set/Function/Symbol in ServerRoom', async () => {
  const room = buildRealisticRoom('room-plain-check')

  const nonPlain = findUnexpectedNonPlainValues(room)
  if (nonPlain.length > 0) {
    throw new Error(
      `ServerRoom съдържа неочаквани non-plain стойности:\n  ${nonPlain.join('\n  ')}`,
    )
  }

  // JSON.stringify като допълнителна проверка за circular references
  const json = JSON.stringify(room)
  assert.ok(json.length > 0, 'ServerRoom трябва да е JSON-serializable')

  const reparsed = JSON.parse(json) as unknown
  assert.equal(typeof reparsed, 'object')
  assert.notEqual(reparsed, null)
})

// ─── Section: Payload and latency measurements ────────────────────────────────

console.log('\n═══ Payload и latency measurements ═══')

await withWorker(async (worker, endpoint) => {
  const roomIds = ['perf-1', 'perf-2', 'perf-3']

  for (let n = 1; n <= 100; n++) {
    const roomId = `perf-extra-${n}`
    roomIds.push(roomId)
  }

  // Assign всички rooms
  for (const rid of roomIds) {
    await assignRoom(worker, rid)
  }

  const rooms = new Map<string, ServerRoom>()
  for (const rid of roomIds) {
    rooms.set(rid, buildRealisticRoom(rid))
  }

  const client = createGameWorkerTickClient({ endpoint, requestTimeoutMs: 30_000 })

  for (const count of [1, 10, 100]) {
    const subset = roomIds.slice(0, count)
    const inputs: GameWorkerTickRoomInput[] = subset.map((rid, i) => ({
      roomId: rid,
      baseRevision: i,
      room: rooms.get(rid)!,
    }))

    const jsonSize = JSON.stringify(inputs).length
    const start = performance.now()
    const results = await client.computeTickRooms(inputs, Date.now())
    const elapsed = performance.now() - start

    console.log(
      `  [n=${count}] payload≈${(jsonSize / 1024).toFixed(1)}KB  round-trip≈${elapsed.toFixed(1)}ms  results=${results.length}`,
    )

    assert.equal(results.length, count)
  }

  await client.shutdown()
})

// ─── Final summary ────────────────────────────────────────────────────────────

console.log(`\n═══ Summary: ${passCount} passed, ${failCount} failed ═══`)

if (failCount > 0) {
  process.exit(1)
}
