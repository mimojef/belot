/**
 * checkGameWorkerLifecycleClient.ts
 *
 * Checks:
 * - getMessageEndpoint() state guards
 * - lifecycle + tick client sharing the same real Worker endpoint
 * - listener coexistence via Worker.emit('message', ...)
 * - correlated tick worker_error does not affect lifecycle state
 * - clean shutdown order
 */

import assert from 'node:assert/strict'
import { Worker } from 'node:worker_threads'
import {
  createGameWorkerLifecycleClient,
  type GameWorkerLifecycleClient,
} from '../src/game/createGameWorkerLifecycleClient.js'
import {
  createGameWorkerTickClient,
  type GameWorkerTickClient,
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

async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    pass(label)
  } catch (error) {
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

async function nextMicrotask(): Promise<void> {
  await Promise.resolve()
}

async function shutdownClients(
  tickClient: GameWorkerTickClient | null,
  lifecycleClient: GameWorkerLifecycleClient | null,
): Promise<void> {
  if (tickClient !== null) {
    await tickClient.shutdown()
  }
  if (lifecycleClient !== null) {
    await lifecycleClient.shutdown()
  }
}

const workerUrl = await resolveGameWorkerEntryUrl()

console.log('\n=== Section 1: getMessageEndpoint() state guards ===')

await check('EP1: getMessageEndpoint() before start() throws with state=idle', () => {
  const client = createGameWorkerLifecycleClient({
    workerId: 'ep1-worker',
    workerEntryUrl: workerUrl,
  })

  assert.throws(
    () => client.getMessageEndpoint(),
    /state=idle/,
  )
})

await check('EP2: getMessageEndpoint() while starting throws with state=starting', async () => {
  const client = createGameWorkerLifecycleClient({
    workerId: 'ep2-worker',
    workerEntryUrl: workerUrl,
  })

  try {
    const startPromise = client.start()

    assert.throws(
      () => client.getMessageEndpoint(),
      /state=starting/,
    )

    await startPromise
  } finally {
    await client.shutdown()
  }
})

await check('EP3: getMessageEndpoint() after ready returns the real Worker endpoint', async () => {
  const client = createGameWorkerLifecycleClient({
    workerId: 'ep3-worker',
    workerEntryUrl: workerUrl,
  })

  try {
    await client.start()
    assert.strictEqual(client.getState(), 'ready')

    const endpoint = client.getMessageEndpoint()
    assert.ok(endpoint instanceof Worker, 'endpoint must be the real Worker object')
    assert.strictEqual(typeof endpoint.postMessage, 'function')
    assert.strictEqual(typeof endpoint.on, 'function')
    assert.strictEqual(typeof endpoint.off, 'function')
  } finally {
    await client.shutdown()
  }
})

await check('EP4: getMessageEndpoint() after shutdown() throws with state=stopped', async () => {
  const client = createGameWorkerLifecycleClient({
    workerId: 'ep4-worker',
    workerEntryUrl: workerUrl,
  })

  try {
    await client.start()
    await client.shutdown()

    assert.throws(
      () => client.getMessageEndpoint(),
      /state=stop/,
    )
  } finally {
    await client.shutdown()
  }
})

console.log('\n=== Section 2: Shared real Worker endpoint ===')

await check('EW1: getMessageEndpoint() returns the same real Worker reference repeatedly', async () => {
  const client = createGameWorkerLifecycleClient({
    workerId: 'ew1-worker',
    workerEntryUrl: workerUrl,
  })

  try {
    await client.start()

    const ep1 = client.getMessageEndpoint()
    const ep2 = client.getMessageEndpoint()
    assert.ok(ep1 instanceof Worker, 'endpoint must be a Worker')
    assert.strictEqual(ep1, ep2, 'repeated getMessageEndpoint() calls must return the same object')
  } finally {
    await client.shutdown()
  }
})

await check('EW2: lifecycle ping and tick client shutdown share one Worker cleanly', async () => {
  const lifecycleClient = createGameWorkerLifecycleClient({
    workerId: 'ew2-worker',
    workerEntryUrl: workerUrl,
  })
  let tickClient: GameWorkerTickClient | null = null

  try {
    await lifecycleClient.start()
    assert.strictEqual(lifecycleClient.getState(), 'ready')

    const endpoint = lifecycleClient.getMessageEndpoint()
    tickClient = createGameWorkerTickClient({ endpoint, requestTimeoutMs: 5000 })

    const latency = await lifecycleClient.ping()
    assert.ok(latency >= 0, 'lifecycle ping must succeed while tick listener is attached')

    await tickClient.shutdown()
    tickClient = null

    const latencyAfterTickShutdown = await lifecycleClient.ping()
    assert.ok(latencyAfterTickShutdown >= 0, 'tick shutdown must not stop lifecycle Worker')
  } finally {
    await shutdownClients(tickClient, lifecycleClient)
  }
})

await check('EW3: real shared Worker tick flow keeps lifecycle ready through tick shutdown', async () => {
  const lifecycleClient = createGameWorkerLifecycleClient({
    workerId: 'ew3-worker',
    workerEntryUrl: workerUrl,
    requestTimeoutMs: 10_000,
  })
  let tickClient: GameWorkerTickClient | null = null

  try {
    await lifecycleClient.start()
    assert.strictEqual(lifecycleClient.getState(), 'ready')

    const endpoint = lifecycleClient.getMessageEndpoint()
    assert.ok(endpoint instanceof Worker, 'lifecycle endpoint must be the real Worker')
    assert.strictEqual(endpoint, lifecycleClient.getMessageEndpoint())

    tickClient = createGameWorkerTickClient({ endpoint, requestTimeoutMs: 10_000 })

    const roomId = 'ew3-real-shared-room'
    const assignAck = await lifecycleClient.assignRoom(roomId)
    assert.strictEqual(assignAck.roomId, roomId)
    assert.ok(assignAck.result === 'assigned' || assignAck.result === 'already_assigned')

    const room = buildRealisticRoom(roomId)
    const results = await tickClient.computeTickRooms(
      [{ roomId, baseRevision: 0, room }],
      Date.now(),
    )

    assert.strictEqual(results.length, 1)
    assert.strictEqual(results[0].roomId, roomId)
    assert.strictEqual(results[0].baseRevision, 0)
    assert.ok(
      results[0].result === 'unchanged' || results[0].result === 'advanced',
      `unexpected tick result: ${results[0].result}`,
    )
    assert.strictEqual(lifecycleClient.getState(), 'ready')

    const latency = await lifecycleClient.ping()
    assert.ok(latency >= 0, 'lifecycle ping must still work after real tick response')

    await tickClient.shutdown()
    tickClient = null

    assert.strictEqual(lifecycleClient.getState(), 'ready')
    const latencyAfterTickShutdown = await lifecycleClient.ping()
    assert.ok(latencyAfterTickShutdown >= 0, 'tick shutdown must not stop the Worker')
  } finally {
    await shutdownClients(tickClient, lifecycleClient)
  }
})

console.log('\n=== Section 3: Listener coexistence on the real Worker ===')

await check('LC1: lifecycle ignores unrelated compute_tick_rooms_response on shared Worker', async () => {
  const lifecycleClient = createGameWorkerLifecycleClient({
    workerId: 'lc1-worker',
    workerEntryUrl: workerUrl,
  })

  try {
    await lifecycleClient.start()
    assert.strictEqual(lifecycleClient.getState(), 'ready')

    const worker = lifecycleClient.getMessageEndpoint() as Worker
    const pingPromise = lifecycleClient.ping()
    let pingSettled = false
    pingPromise.then(
      () => { pingSettled = true },
      () => { pingSettled = true },
    )

    worker.emit('message', {
      type: 'compute_tick_rooms_response',
      requestId: 'lc1-unrelated-tick-request',
      protocolVersion: GAME_WORKER_PROTOCOL_VERSION,
      results: [],
    })

    await nextMicrotask()
    assert.strictEqual(pingSettled, false, 'tick response must not settle lifecycle ping')

    const latency = await pingPromise
    assert.ok(latency >= 0, 'real pong must resolve lifecycle ping')
    assert.strictEqual(lifecycleClient.getState(), 'ready')
  } finally {
    await lifecycleClient.shutdown()
  }
})

await check('LC2: tick client ignores lifecycle responses while pending on shared Worker', async () => {
  const lifecycleClient = createGameWorkerLifecycleClient({
    workerId: 'lc2-worker',
    workerEntryUrl: workerUrl,
  })
  let tickClient: GameWorkerTickClient | null = null

  try {
    await lifecycleClient.start()
    const worker = lifecycleClient.getMessageEndpoint() as Worker

    let capturedRequestId: string | null = null
    const endpoint: GameWorkerTickMessageEndpoint = {
      postMessage(message) {
        const msg = message as Record<string, unknown>
        if (msg['type'] === 'compute_tick_rooms') {
          capturedRequestId = msg['requestId'] as string
        }
      },
      on(event, listener) { return worker.on(event, listener) },
      off(event, listener) { return worker.off(event, listener) },
    }

    tickClient = createGameWorkerTickClient({ endpoint, requestTimeoutMs: 3000 })

    const roomId = 'lc2-room'
    const room = buildRealisticRoom(roomId)
    const tickPromise = tickClient.computeTickRooms(
      [{ roomId, baseRevision: 0, room }],
      Date.now(),
    )
    let tickSettled = false
    tickPromise.then(
      () => { tickSettled = true },
      () => { tickSettled = true },
    )

    await nextMicrotask()
    assert.ok(capturedRequestId !== null, 'tick requestId must be captured')

    const lifecycleMessages = [
      {
        type: 'ready',
        workerId: 'lc2-worker',
        protocolVersion: GAME_WORKER_PROTOCOL_VERSION,
        startedAt: Date.now(),
      },
      { type: 'pong', requestId: 'lc2-pong-req', receivedAt: Date.now() },
      {
        type: 'health_response',
        requestId: 'lc2-health-req',
        workerId: 'lc2-worker',
        startedAt: Date.now() - 1000,
        uptimeMs: 1000,
        activeRooms: 1,
      },
      {
        type: 'assign_room_ack',
        requestId: 'lc2-assign-req',
        roomId,
        result: 'assigned',
        activeRooms: 1,
      },
      {
        type: 'release_room_ack',
        requestId: 'lc2-release-req',
        roomId,
        result: 'released',
        activeRooms: 0,
      },
      { type: 'shutdown_complete', requestId: 'lc2-shutdown-req' },
    ]

    for (const msg of lifecycleMessages) {
      worker.emit('message', msg)
      await nextMicrotask()
      assert.strictEqual(tickSettled, false, `${msg.type} must not settle tick request`)
    }

    worker.emit('message', {
      type: 'compute_tick_rooms_response',
      requestId: capturedRequestId,
      protocolVersion: GAME_WORKER_PROTOCOL_VERSION,
      results: [{ roomId, baseRevision: 0, result: 'unchanged' }],
    })

    const results = await tickPromise
    assert.deepStrictEqual(results, [{ roomId, baseRevision: 0, result: 'unchanged' }])
    assert.strictEqual(lifecycleClient.getState(), 'ready')
  } finally {
    await shutdownClients(tickClient, lifecycleClient)
  }
})

console.log('\n=== Section 4: Correlated tick worker_error on the shared Worker ===')

await check('CWE1: correlated tick worker_error rejects tick request and leaves lifecycle ready', async () => {
  const lifecycleClient = createGameWorkerLifecycleClient({
    workerId: 'cwe1-worker',
    workerEntryUrl: workerUrl,
  })
  let tickClient: GameWorkerTickClient | null = null

  try {
    await lifecycleClient.start()
    assert.strictEqual(lifecycleClient.getState(), 'ready')

    const worker = lifecycleClient.getMessageEndpoint() as Worker
    let capturedRequestId: string | null = null

    const endpoint: GameWorkerTickMessageEndpoint = {
      postMessage(message) {
        const msg = message as Record<string, unknown>
        if (msg['type'] === 'compute_tick_rooms') {
          capturedRequestId = msg['requestId'] as string
        }
      },
      on(event, listener) { return worker.on(event, listener) },
      off(event, listener) { return worker.off(event, listener) },
    }

    tickClient = createGameWorkerTickClient({ endpoint, requestTimeoutMs: 3000 })

    const input: GameWorkerTickRoomInput = {
      roomId: 'cwe1-room',
      baseRevision: 0,
      room: buildRealisticRoom('cwe1-room'),
    }

    const tickPromise = tickClient.computeTickRooms([input], Date.now())

    await nextMicrotask()
    assert.ok(capturedRequestId !== null, 'tick requestId must be captured')

    worker.emit('message', {
      type: 'worker_error',
      requestId: capturedRequestId,
      message: 'simulated tick error',
    })

    await assert.rejects(tickPromise, /worker_error.*simulated tick error/)
    assert.strictEqual(lifecycleClient.getState(), 'ready')

    const latency = await lifecycleClient.ping()
    assert.ok(latency >= 0, 'lifecycle ping must still work after correlated tick error')
  } finally {
    await shutdownClients(tickClient, lifecycleClient)
  }
})

console.log(`\n=== Summary: ${passCount} passed, ${failCount} failed ===`)

if (failCount > 0) {
  process.exit(1)
}
