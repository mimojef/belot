import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ServerRoom } from '../src/core/serverTypes.js'
import { addBotToRoom } from '../src/core/addBotToRoom.js'
import { addHumanToRoom } from '../src/core/addHumanToRoom.js'
import { createRoomWithHumanHost } from '../src/core/createRoomWithHumanHost.js'
import { initializeRoomAuthoritativeGameState } from '../src/game/initializeRoomAuthoritativeGameState.js'
import {
  createGameWorkerPool,
  type GameWorkerPool,
} from '../src/game/createGameWorkerPool.js'
import { resolveGameWorkerEntryUrl } from '../src/game/resolveGameWorkerEntryUrl.js'
import type { GameWorkerTickRoomInput } from '../src/game/workerProtocol.js'

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
  } catch (error: unknown) {
    fail(label, error)
  }
}

function makeFakeRoom(id: string): ServerRoom {
  return { id, game: { phase: null } } as unknown as ServerRoom
}

function makeInput(roomId: string, baseRevision: number): GameWorkerTickRoomInput {
  return {
    roomId,
    baseRevision,
    room: makeFakeRoom(roomId),
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

async function waitFor(
  label: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3000,
): Promise<void> {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }

  throw new Error(`Timed out waiting for ${label}`)
}

async function withPool(
  pool: GameWorkerPool,
  fn: (pool: GameWorkerPool) => Promise<void> | void,
): Promise<void> {
  try {
    await pool.start()
    await fn(pool)
  } finally {
    await pool.shutdown().catch(() => {})
  }
}

async function writeFakeWorker(
  mode:
    | 'normal'
    | 'worker2-compute-fails'
    | 'worker2-crashes-on-compute'
    | 'delayed-release'
    | 'release-fails-with-room-id'
    | 'bad-revision'
    | 'worker2-startup-fails'
    | 'worker2-shutdown-hangs',
): Promise<{
  url: URL
  readEvents(): Promise<string[]>
  cleanup(): Promise<void>
}> {
  const dir = await mkdtemp(join(tmpdir(), 'belot-worker-pool-'))
  const file = join(dir, 'fakeGameWorker.mjs')
  const eventFile = join(dir, 'events.log')
  const source = `
import { appendFileSync } from 'node:fs'
import { parentPort, workerData } from 'node:worker_threads'

const protocolVersion = 3
const mode = ${JSON.stringify(mode)}
const eventFile = ${JSON.stringify(eventFile)}
const workerId = workerData.workerId
const startedAt = Date.now()
const roomIds = new Set()

function record(event) {
  appendFileSync(eventFile, event + '\\n')
}

process.on('exit', () => {
  record('exit:' + workerId)
})

function send(message) {
  parentPort.postMessage(message)
}

record('start:' + workerId)

if (mode === 'worker2-startup-fails' && workerId === 'game-worker-2') {
  record('startup-fail:' + workerId)
  throw new Error('simulated worker-2 startup failure')
}

parentPort.on('message', (message) => {
  if (message.type === 'ping') {
    send({ type: 'pong', requestId: message.requestId, receivedAt: Date.now() })
    return
  }

  if (message.type === 'health_request') {
    send({
      type: 'health_response',
      requestId: message.requestId,
      workerId,
      startedAt,
      uptimeMs: Math.max(0, Date.now() - startedAt),
      activeRooms: roomIds.size,
    })
    return
  }

  if (message.type === 'assign_room') {
    const alreadyAssigned = roomIds.has(message.roomId)
    roomIds.add(message.roomId)
    send({
      type: 'assign_room_ack',
      requestId: message.requestId,
      roomId: message.roomId,
      result: alreadyAssigned ? 'already_assigned' : 'assigned',
      activeRooms: roomIds.size,
    })
    return
  }

  if (message.type === 'release_room') {
    if (mode === 'release-fails-with-room-id') {
      send({
        type: 'worker_error',
        requestId: message.requestId,
        message: 'release failed for room ' + message.roomId,
      })
      return
    }

    if (mode === 'delayed-release') {
      setTimeout(() => {
        const wasAssigned = roomIds.delete(message.roomId)
        send({
          type: 'release_room_ack',
          requestId: message.requestId,
          roomId: message.roomId,
          result: wasAssigned ? 'released' : 'not_assigned',
          activeRooms: roomIds.size,
        })
      }, 100)
      return
    }

    const wasAssigned = roomIds.delete(message.roomId)
    send({
      type: 'release_room_ack',
      requestId: message.requestId,
      roomId: message.roomId,
      result: wasAssigned ? 'released' : 'not_assigned',
      activeRooms: roomIds.size,
    })
    return
  }

  if (message.type === 'compute_tick_rooms') {
    if (mode === 'worker2-compute-fails' && workerId === 'game-worker-2') {
      send({
        type: 'worker_error',
        requestId: message.requestId,
        message: 'simulated worker-2 compute failure',
      })
      return
    }

    if (mode === 'worker2-crashes-on-compute' && workerId === 'game-worker-2') {
      send({
        type: 'worker_error',
        message: 'simulated worker-2 crash',
      })
      return
    }

    send({
      protocolVersion,
      type: 'compute_tick_rooms_response',
      requestId: message.requestId,
      results: message.rooms.map((input) => {
        if (mode === 'bad-revision') {
          return {
            roomId: input.roomId,
            baseRevision: input.baseRevision + 1,
            result: 'unchanged',
          }
        }

        if (!roomIds.has(input.roomId)) {
          return {
            roomId: input.roomId,
            baseRevision: input.baseRevision,
            result: 'error',
            code: 'not_assigned',
            message: 'Room is not assigned to this worker.',
          }
        }

        if (input.roomId.includes('advanced')) {
          return {
            roomId: input.roomId,
            baseRevision: input.baseRevision,
            result: 'advanced',
            room: { ...input.room, advancedBy: workerId },
          }
        }

        return {
          roomId: input.roomId,
          baseRevision: input.baseRevision,
          result: 'unchanged',
        }
      }),
    })
    return
  }

  if (message.type === 'shutdown') {
    if (mode === 'worker2-shutdown-hangs' && workerId === 'game-worker-2') {
      return
    }
    roomIds.clear()
    record('shutdown:' + workerId)
    send({ type: 'shutdown_complete', requestId: message.requestId })
    parentPort.close()
  }
})

send({ type: 'ready', workerId, protocolVersion, startedAt })
`

  await writeFile(file, source, 'utf8')

  return {
    url: pathToFileURL(file),
    readEvents: async () => {
      const text = await readFile(eventFile, 'utf8').catch(() => '')
      return text.split('\n').filter((line) => line.length > 0)
    },
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true })
    },
  }
}

console.log('\n=== GameWorkerPool config validation ===')

await check('CFG1: invalid workerCount throws before Worker creation', () => {
  assert.throws(
    () =>
      createGameWorkerPool({
        workerCount: 0,
        maxRoomsPerWorker: 1,
        workerEntryUrl: new URL('file:///does-not-matter.js'),
      }),
    /workerCount/,
  )
})

await check('CFG2: invalid maxRoomsPerWorker throws before Worker creation', () => {
  assert.throws(
    () =>
      createGameWorkerPool({
        workerCount: 1,
        maxRoomsPerWorker: 1.5,
        workerEntryUrl: new URL('file:///does-not-matter.js'),
      }),
    /maxRoomsPerWorker/,
  )
})

await check('CFG3: invalid workerEntryUrl throws before Worker creation', () => {
  assert.throws(
    () =>
      createGameWorkerPool({
        workerCount: 1,
        maxRoomsPerWorker: 1,
        workerEntryUrl: 'file:///bad.js' as unknown as URL,
      }),
    /workerEntryUrl/,
  )
})

const normalWorker = await writeFakeWorker('normal')
const failingWorker = await writeFakeWorker('worker2-compute-fails')
const crashingWorker = await writeFakeWorker('worker2-crashes-on-compute')
const delayedReleaseWorker = await writeFakeWorker('delayed-release')
const releaseFailureWorker = await writeFakeWorker('release-fails-with-room-id')
const badRevisionWorker = await writeFakeWorker('bad-revision')
const startupFailureWorker = await writeFakeWorker('worker2-startup-fails')
const hangingShutdownWorker = await writeFakeWorker('worker2-shutdown-hangs')

try {
  console.log('\n=== GameWorkerPool startup cleanup ===')

  await check('ST1: partial startup failure cleans already-started worker', async () => {
    const pool = createGameWorkerPool({
      workerCount: 2,
      maxRoomsPerWorker: 5,
      workerEntryUrl: startupFailureWorker.url,
      requestTimeoutMs: 500,
    })

    await assert.rejects(pool.start(), /startup failure|Worker error during start|exited during start/)
    assert.equal(pool.getHealth().state, 'failed')
    assert.equal(pool.getHealth().totalAssignedRooms, 0)

    await waitFor(
      'worker-1 shutdown after partial startup failure',
      async () => {
        const events = await startupFailureWorker.readEvents()
        return (
          events.includes('shutdown:game-worker-1') ||
          events.includes('exit:game-worker-1')
        )
      },
      3000,
    ).catch(async (error: unknown) => {
      const msg = error instanceof Error ? error.message : String(error)
      const events = await startupFailureWorker.readEvents()
      throw new Error(`${msg}; events=${events.join(',')}`)
    })

    const events = await startupFailureWorker.readEvents()
    assert.ok(events.includes('start:game-worker-1'))
    assert.ok(events.includes('start:game-worker-2'))
    assert.ok(events.includes('startup-fail:game-worker-2'))
    assert.ok(
      events.includes('shutdown:game-worker-1') ||
        events.includes('exit:game-worker-1'),
    )

    await pool.shutdown()
    assert.equal(pool.getHealth().state, 'stopped')
  })

  console.log('\n=== GameWorkerPool assignment ===')

  await check('A1: deterministic least-loaded assignment', async () => {
    await withPool(
      createGameWorkerPool({
        workerCount: 3,
        maxRoomsPerWorker: 2,
        workerEntryUrl: normalWorker.url,
      }),
      async (pool) => {
        assert.deepStrictEqual(pool.ensureRoom('room-1'), {
          ok: true,
          workerId: 'game-worker-1',
          newlyAssigned: true,
        })
        assert.deepStrictEqual(pool.ensureRoom('room-2'), {
          ok: true,
          workerId: 'game-worker-2',
          newlyAssigned: true,
        })
        assert.deepStrictEqual(pool.ensureRoom('room-3'), {
          ok: true,
          workerId: 'game-worker-3',
          newlyAssigned: true,
        })
        assert.deepStrictEqual(pool.ensureRoom('room-4'), {
          ok: true,
          workerId: 'game-worker-1',
          newlyAssigned: true,
        })

        const health = pool.getHealth()
        assert.equal(health.totalAssignedRooms, 4)
        assert.deepStrictEqual(
          health.workers.map((worker) => [worker.workerId, worker.assignedRooms]),
          [
            ['game-worker-1', 2],
            ['game-worker-2', 1],
            ['game-worker-3', 1],
          ],
        )
      },
    )
  })

  await check('A2: capacity limit and repeated ensure are stable', async () => {
    await withPool(
      createGameWorkerPool({
        workerCount: 2,
        maxRoomsPerWorker: 1,
        workerEntryUrl: normalWorker.url,
      }),
      (pool) => {
        assert.equal(pool.ensureRoom('room-a').ok, true)
        assert.equal(pool.ensureRoom('room-b').ok, true)
        assert.deepStrictEqual(pool.ensureRoom('room-c'), {
          ok: false,
          reason: 'no_capacity',
        })

        assert.deepStrictEqual(pool.ensureRoom('room-a'), {
          ok: true,
          workerId: 'game-worker-1',
          newlyAssigned: false,
        })
        assert.equal(pool.getHealth().totalAssignedRooms, 2)
      },
    )
  })

  await check('A3: release is idempotent and frees capacity', async () => {
    await withPool(
      createGameWorkerPool({
        workerCount: 1,
        maxRoomsPerWorker: 1,
        workerEntryUrl: normalWorker.url,
      }),
      async (pool) => {
        assert.equal(pool.ensureRoom('room-a').ok, true)
        assert.deepStrictEqual(pool.ensureRoom('room-b'), {
          ok: false,
          reason: 'no_capacity',
        })

        await pool.releaseRoom('room-a')
        await pool.releaseRoom('room-a')

        assert.equal(pool.getWorkerIdForRoom('room-a'), null)
        assert.deepStrictEqual(pool.ensureRoom('room-b'), {
          ok: true,
          workerId: 'game-worker-1',
          newlyAssigned: true,
        })
      },
    )
  })

  await check('A4: no double assignment for the same room', async () => {
    await withPool(
      createGameWorkerPool({
        workerCount: 2,
        maxRoomsPerWorker: 5,
        workerEntryUrl: normalWorker.url,
      }),
      (pool) => {
        const first = pool.ensureRoom('same-room')
        const second = pool.ensureRoom('same-room')

        assert.deepStrictEqual(first, {
          ok: true,
          workerId: 'game-worker-1',
          newlyAssigned: true,
        })
        assert.deepStrictEqual(second, {
          ok: true,
          workerId: 'game-worker-1',
          newlyAssigned: false,
        })
        assert.equal(pool.getHealth().totalAssignedRooms, 1)
      },
    )
  })

  await check('A5: delayed release keeps ownership until acknowledgement', async () => {
    await withPool(
      createGameWorkerPool({
        workerCount: 2,
        maxRoomsPerWorker: 5,
        workerEntryUrl: delayedReleaseWorker.url,
      }),
      async (pool) => {
        assert.deepStrictEqual(pool.ensureRoom('release-race-room'), {
          ok: true,
          workerId: 'game-worker-1',
          newlyAssigned: true,
        })

        await waitFor(
          'initial shadow assignment',
          () => pool.getHealth().workers.every((worker) => worker.shadow.pendingOperations === 0),
        )

        const releasePromise = pool.releaseRoom('release-race-room')

        assert.deepStrictEqual(pool.ensureRoom('release-race-room'), {
          ok: true,
          workerId: 'game-worker-1',
          newlyAssigned: false,
        })
        assert.equal(pool.getWorkerIdForRoom('release-race-room'), 'game-worker-1')

        await releasePromise

        assert.equal(pool.getWorkerIdForRoom('release-race-room'), null)
        assert.deepStrictEqual(pool.ensureRoom('release-race-room'), {
          ok: true,
          workerId: 'game-worker-1',
          newlyAssigned: true,
        })
      },
    )
  })

  await check('A6: release failure keeps old ownership and sanitizes health', async () => {
    await withPool(
      createGameWorkerPool({
        workerCount: 2,
        maxRoomsPerWorker: 5,
        workerEntryUrl: releaseFailureWorker.url,
      }),
      async (pool) => {
        const roomId = 'secret-release-room-id'
        assert.equal(pool.ensureRoom(roomId).ok, true)

        await waitFor(
          'initial shadow assignment',
          () => pool.getHealth().workers.every((worker) => worker.shadow.pendingOperations === 0),
        )

        await assert.rejects(pool.releaseRoom(roomId), /release failed/)
        assert.equal(pool.getWorkerIdForRoom(roomId), 'game-worker-1')

        const healthText = JSON.stringify(pool.getHealth())
        assert.equal(healthText.includes(roomId), false)
        assert.equal(healthText.includes('release failed for room'), false)
        assert.equal(healthText.includes('Shadow synchronization failed.'), true)
        assert.equal(healthText.includes('Worker operation failed.'), true)
      },
    )
  })

  console.log('\n=== GameWorkerPool tick routing ===')

  await check('T1: routes rooms to owner workers and preserves result order', async () => {
    await withPool(
      createGameWorkerPool({
        workerCount: 2,
        maxRoomsPerWorker: 10,
        workerEntryUrl: normalWorker.url,
      }),
      async (pool) => {
        pool.ensureRoom('room-a')
        pool.ensureRoom('room-b-advanced')

        await waitFor(
          'shadow assignment',
          () => pool.getHealth().workers.every((worker) => worker.shadow.pendingOperations === 0),
        )

        const results = await pool.computeTickRooms(
          [makeInput('room-b-advanced', 2), makeInput('room-a', 1)],
          Date.now(),
        )

        assert.equal(results.length, 2)
        assert.equal(results[0].roomId, 'room-b-advanced')
        assert.equal(results[0].baseRevision, 2)
        assert.equal(results[0].result, 'advanced')
        assert.equal(results[1].roomId, 'room-a')
        assert.equal(results[1].baseRevision, 1)
        assert.equal(results[1].result, 'unchanged')
      },
    )
  })

  await check('T2: duplicate input room IDs reject', async () => {
    await withPool(
      createGameWorkerPool({
        workerCount: 1,
        maxRoomsPerWorker: 10,
        workerEntryUrl: normalWorker.url,
      }),
      async (pool) => {
        pool.ensureRoom('dup-room')

        await assert.rejects(
          pool.computeTickRooms(
            [makeInput('dup-room', 1), makeInput('dup-room', 2)],
            Date.now(),
          ),
          /Duplicate roomId/,
        )
      },
    )
  })

  await check('T3: missing owner returns protocol-compatible not_assigned', async () => {
    await withPool(
      createGameWorkerPool({
        workerCount: 1,
        maxRoomsPerWorker: 10,
        workerEntryUrl: normalWorker.url,
      }),
      async (pool) => {
        const results = await pool.computeTickRooms(
          [makeInput('missing-owner-room', 5)],
          Date.now(),
        )

        assert.equal(results.length, 1)
        assert.equal(results[0].roomId, 'missing-owner-room')
        assert.equal(results[0].baseRevision, 5)
        assert.equal(results[0].result, 'error')
        if (results[0].result === 'error') {
          assert.equal(results[0].code, 'not_assigned')
        }
      },
    )
  })

  await check('T4: partial worker failure does not fail healthy worker results', async () => {
    await withPool(
      createGameWorkerPool({
        workerCount: 2,
        maxRoomsPerWorker: 10,
        workerEntryUrl: failingWorker.url,
      }),
      async (pool) => {
        pool.ensureRoom('healthy-room')
        pool.ensureRoom('failing-room')

        await waitFor(
          'shadow assignment',
          () => pool.getHealth().workers.every((worker) => worker.shadow.pendingOperations === 0),
        )

        const results = await pool.computeTickRooms(
          [makeInput('failing-room', 20), makeInput('healthy-room', 10)],
          Date.now(),
        )

        assert.equal(results.length, 2)
        assert.equal(results[0].roomId, 'failing-room')
        assert.equal(results[0].baseRevision, 20)
        assert.equal(results[0].result, 'error')
        if (results[0].result === 'error') {
          assert.equal(results[0].code, 'compute_failed')
          assert.match(results[0].message, /simulated worker-2 compute failure/)
        }

        assert.equal(results[1].roomId, 'healthy-room')
        assert.equal(results[1].baseRevision, 10)
        assert.equal(results[1].result, 'unchanged')

        const worker2 = pool.getHealth().workers.find((worker) => worker.workerId === 'game-worker-2')
        assert.ok(worker2 !== undefined)
        assert.equal(worker2!.lastError, 'Worker operation failed.')
      },
    )
  })

  await check('T4b: bad worker baseRevision becomes compute_failed', async () => {
    await withPool(
      createGameWorkerPool({
        workerCount: 1,
        maxRoomsPerWorker: 10,
        workerEntryUrl: badRevisionWorker.url,
      }),
      async (pool) => {
        pool.ensureRoom('bad-revision-room')

        await waitFor(
          'shadow assignment',
          () => pool.getHealth().workers.every((worker) => worker.shadow.pendingOperations === 0),
        )

        const results = await pool.computeTickRooms(
          [makeInput('bad-revision-room', 42)],
          Date.now(),
        )

        assert.equal(results.length, 1)
        assert.equal(results[0].roomId, 'bad-revision-room')
        assert.equal(results[0].baseRevision, 42)
        assert.equal(results[0].result, 'error')
        if (results[0].result === 'error') {
          assert.equal(results[0].code, 'compute_failed')
        }
      },
    )
  })

  await check('T5: failed worker state keeps ownership and receives no new rooms', async () => {
    await withPool(
      createGameWorkerPool({
        workerCount: 2,
        maxRoomsPerWorker: 2,
        workerEntryUrl: crashingWorker.url,
        requestTimeoutMs: 100,
      }),
      async (pool) => {
        pool.ensureRoom('room-a')
        pool.ensureRoom('room-b-crash')
        assert.equal(pool.getWorkerIdForRoom('room-b-crash'), 'game-worker-2')

        await waitFor(
          'shadow assignment',
          () => pool.getHealth().workers.every((worker) => worker.shadow.pendingOperations === 0),
        )

        const results = await pool.computeTickRooms(
          [makeInput('room-b-crash', 1)],
          Date.now(),
        )

        assert.equal(results.length, 1)
        assert.equal(results[0].result, 'error')
        if (results[0].result === 'error') {
          assert.equal(results[0].code, 'compute_failed')
        }

        await waitFor(
          'worker-2 failed state',
          () =>
            pool.getHealth().workers.some(
              (worker) => worker.workerId === 'game-worker-2' && worker.state === 'failed',
            ),
        )

        assert.equal(pool.getWorkerIdForRoom('room-b-crash'), 'game-worker-2')
        assert.deepStrictEqual(pool.ensureRoom('room-c'), {
          ok: true,
          workerId: 'game-worker-1',
          newlyAssigned: true,
        })
      },
    )
  })

  await check('T6: shutdown continues and reports cleanup error', async () => {
    const pool = createGameWorkerPool({
      workerCount: 2,
      maxRoomsPerWorker: 2,
      workerEntryUrl: hangingShutdownWorker.url,
      requestTimeoutMs: 100,
    })

    await pool.start()
    pool.ensureRoom('shutdown-room-1')
    pool.ensureRoom('shutdown-room-2')

    await assert.rejects(pool.shutdown(), /timed out|shutdown/i)
    assert.equal(pool.getHealth().state, 'failed')
    assert.equal(pool.getHealth().totalAssignedRooms, 0)
  })

  console.log('\n=== GameWorkerPool health and shutdown ===')

  await check('H1: health exposes pool and worker state without room IDs', async () => {
    await withPool(
      createGameWorkerPool({
        workerCount: 2,
        maxRoomsPerWorker: 3,
        workerEntryUrl: normalWorker.url,
      }),
      (pool) => {
        pool.ensureRoom('health-room-1')
        pool.ensureRoom('health-room-2')

        const health = pool.getHealth()
        assert.equal(health.state, 'ready')
        assert.equal(health.workerCount, 2)
        assert.equal(health.readyWorkers, 2)
        assert.equal(health.failedWorkers, 0)
        assert.equal(health.totalAssignedRooms, 2)
        assert.equal(health.maxRoomsPerWorker, 3)
        assert.equal(health.workers.length, 2)
        assert.equal(JSON.stringify(health).includes('health-room-1'), false)
      },
    )
  })

  await check('S1: repeated start and repeated shutdown are safe', async () => {
    const pool = createGameWorkerPool({
      workerCount: 1,
      maxRoomsPerWorker: 5,
      workerEntryUrl: normalWorker.url,
    })

    await pool.start()
    await pool.start()
    assert.equal(pool.getHealth().state, 'ready')

    await pool.shutdown()
    await pool.shutdown()
    assert.equal(pool.getHealth().state, 'stopped')
    assert.equal(pool.getHealth().totalAssignedRooms, 0)
  })

  console.log('\n=== GameWorkerPool real-worker integration ===')

  await check('R1: starts two real workers, assigns rooms, computes, releases, and shuts down', async () => {
    const realWorkerUrl = await resolveGameWorkerEntryUrl()
    const pool = createGameWorkerPool({
      workerCount: 2,
      maxRoomsPerWorker: 3,
      workerEntryUrl: realWorkerUrl,
      requestTimeoutMs: 10_000,
    })

    await pool.start()

    try {
      const rooms = [
        buildRealisticRoom('real-pool-room-1'),
        buildRealisticRoom('real-pool-room-2'),
        buildRealisticRoom('real-pool-room-3'),
      ]

      assert.equal(pool.ensureRoom(rooms[0].id).workerId, 'game-worker-1')
      assert.equal(pool.ensureRoom(rooms[1].id).workerId, 'game-worker-2')
      assert.equal(pool.ensureRoom(rooms[2].id).workerId, 'game-worker-1')

      await waitFor(
        'real worker shadow assignment',
        () => pool.getHealth().workers.every((worker) => worker.shadow.pendingOperations === 0),
        10_000,
      )

      const results = await pool.computeTickRooms(
        rooms.map((room, index) => ({
          roomId: room.id,
          baseRevision: index,
          room,
        })),
        Date.now(),
      )

      assert.equal(results.length, 3)
      assert.deepStrictEqual(
        results.map((result) => result.roomId),
        rooms.map((room) => room.id),
      )
      assert.ok(
        results.every((result) => result.result === 'unchanged' || result.result === 'advanced'),
        'real worker results must be successful for assigned rooms',
      )

      await pool.releaseRoom(rooms[1].id)
      assert.equal(pool.getWorkerIdForRoom(rooms[1].id), null)
      assert.equal(pool.getHealth().totalAssignedRooms, 2)
    } finally {
      await pool.shutdown()
    }

    assert.equal(pool.getHealth().state, 'stopped')
  })
} finally {
  await normalWorker.cleanup()
  await failingWorker.cleanup()
  await crashingWorker.cleanup()
  await delayedReleaseWorker.cleanup()
  await releaseFailureWorker.cleanup()
  await badRevisionWorker.cleanup()
  await startupFailureWorker.cleanup()
  await hangingShutdownWorker.cleanup()
}

console.log(`\n=== Summary: ${passCount} passed, ${failCount} failed ===`)

if (failCount > 0) {
  process.exit(1)
}
