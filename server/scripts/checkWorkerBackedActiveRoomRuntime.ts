import assert from 'node:assert/strict'
import type {
  ActiveRoomRuntime,
  ActiveRoomRuntimeHealth,
  AbandonHumanControlInput,
  EnsureRoomResult,
  ResumeHumanControlInput,
  RuntimeCommandResult,
  SubmitBidInput,
  SubmitCutInput,
  SubmitPlayInput,
  TickRoomsInput,
  TickRoomsResult,
} from '../src/game/activeRoomRuntime.js'
import type { ServerRoom } from '../src/core/serverTypes.js'
import { createInProcessGameWorkerManager } from '../src/game/createInProcessGameWorkerManager.js'
import { createWorkerBackedActiveRoomRuntime } from '../src/game/createWorkerBackedActiveRoomRuntime.js'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRoom(id: string): ServerRoom {
  return { id, game: { phase: null } } as unknown as ServerRoom
}

type FakeDelegateConfig = {
  ensureFailure?: boolean
  ensureThrow?: Error
}

type TickCall = {
  rooms: readonly ServerRoom[]
  now: number
}

type FakeDelegate = ActiveRoomRuntime & {
  rooms: Set<string>
  tickCalls: TickCall[]
  removeCalls: string[]
  commandCalls: string[]
  ensureCalls: string[]
}

function makeFakeDelegate(
  config: FakeDelegateConfig = {},
): FakeDelegate {
  const rooms = new Set<string>()
  const tickCalls: TickCall[] = []
  const removeCalls: string[] = []
  const commandCalls: string[] = []
  const ensureCalls: string[] = []

  const delegate: FakeDelegate = {
    rooms,
    tickCalls,
    removeCalls,
    commandCalls,
    ensureCalls,

    ensureRoom(room: ServerRoom): EnsureRoomResult {
      ensureCalls.push(room.id)

      if (config.ensureThrow !== undefined) {
        throw config.ensureThrow
      }

      if (config.ensureFailure === true) {
        return { ok: false, reason: 'no_capacity' }
      }

      rooms.add(room.id)
      return { ok: true }
    },

    removeRoom(roomId: string): void {
      removeCalls.push(roomId)
      rooms.delete(roomId)
    },

    hasRoom(roomId: string): boolean {
      return rooms.has(roomId)
    },

    getHealth(): ActiveRoomRuntimeHealth {
      return {
        activeRooms: rooms.size,
        roomsByPhase: {},
      }
    },

    listTrackedRoomIds(): string[] {
      return Array.from(rooms)
    },

    tickRooms(input: TickRoomsInput): TickRoomsResult {
      tickCalls.push({ rooms: input.rooms, now: input.now })

      return {
        results: input.rooms.map((room) => ({
          kind: 'unchanged' as const,
          roomId: room.id,
        })),
      }
    },

    submitBid(_input: SubmitBidInput): RuntimeCommandResult {
      commandCalls.push('submitBid')
      return { ok: true, room: _input.room }
    },

    submitCut(_input: SubmitCutInput): RuntimeCommandResult {
      commandCalls.push('submitCut')
      return { ok: true, room: _input.room }
    },

    submitPlay(_input: SubmitPlayInput): RuntimeCommandResult {
      commandCalls.push('submitPlay')
      return { ok: true, room: _input.room }
    },

    resumeHumanControl(
      _input: ResumeHumanControlInput,
    ): RuntimeCommandResult {
      commandCalls.push('resumeHumanControl')
      return { ok: true, room: _input.room }
    },

    abandonHumanControl(
      _input: AbandonHumanControlInput,
    ): RuntimeCommandResult {
      commandCalls.push('abandonHumanControl')
      return { ok: true, room: _input.room }
    },
  }

  return delegate
}

// ─── A. Assignment и idempotency ─────────────────────────────────────────────

{
  const manager = createInProcessGameWorkerManager({
    workerCount: 2,
    maxRoomsPerWorker: 5,
  })
  const delegate = makeFakeDelegate()
  const runtime = createWorkerBackedActiveRoomRuntime({
    workerManager: manager,
    delegate,
  })

  const roomA = makeRoom('room-a')

  const result1 = runtime.ensureRoom(roomA)
  assert.equal(result1.ok, true, 'Нов room трябва да получи assignment')
  assert.equal(
    manager.getWorkerIdForRoom('room-a') !== null,
    true,
    'Manager трябва да има assignment',
  )
  assert.equal(
    delegate.ensureCalls.includes('room-a'),
    true,
    'Delegate трябва да получи ensure call',
  )

  const workerBefore = manager
    .getWorkers()
    .find((w) => w.workerId === manager.getWorkerIdForRoom('room-a'))!
  const countBefore = workerBefore.activeRooms

  const result2 = runtime.ensureRoom(roomA)
  assert.equal(result2.ok, true, 'Duplicate ensure трябва да е success')

  const workerAfter = manager
    .getWorkers()
    .find((w) => w.workerId === manager.getWorkerIdForRoom('room-a'))!
  assert.equal(
    workerAfter.activeRooms,
    countBefore,
    'Duplicate ensure не трябва да увеличава room count',
  )

  assert.equal(
    delegate.ensureCalls.filter((id) => id === 'room-a').length,
    2,
    'Delegate трябва да е получил и двата ensure calls',
  )
}

// ─── B. Capacity ──────────────────────────────────────────────────────────────

{
  const manager = createInProcessGameWorkerManager({
    workerCount: 1,
    maxRoomsPerWorker: 1,
  })
  const delegate = makeFakeDelegate()
  const runtime = createWorkerBackedActiveRoomRuntime({
    workerManager: manager,
    delegate,
  })

  const r1 = runtime.ensureRoom(makeRoom('cap-1'))
  assert.equal(r1.ok, true, 'Първи room трябва да е success')

  const ensureCallsBefore = delegate.ensureCalls.length

  const r2 = runtime.ensureRoom(makeRoom('cap-2'))
  assert.equal(r2.ok, false, 'Втори room трябва да върне failure')

  if (!r2.ok) {
    assert.equal(
      r2.reason,
      'no_capacity',
      'reason трябва да е no_capacity',
    )
  }

  assert.equal(
    delegate.ensureCalls.length,
    ensureCallsBefore,
    'Delegate не трябва да е получил ensure при no_capacity',
  )
}

// ─── C. Rollback при delegate failure ────────────────────────────────────────

{
  const manager = createInProcessGameWorkerManager({
    workerCount: 1,
    maxRoomsPerWorker: 2,
  })
  const delegate = makeFakeDelegate({ ensureFailure: true })
  const runtime = createWorkerBackedActiveRoomRuntime({
    workerManager: manager,
    delegate,
  })

  const room = makeRoom('rollback-fail')
  const result = runtime.ensureRoom(room)

  assert.equal(result.ok, false, 'Трябва да върне failure')

  assert.equal(
    manager.getWorkerIdForRoom('rollback-fail'),
    null,
    'Assignment трябва да е премахнат след delegate failure',
  )

  const worker = manager.getWorkers()[0]
  assert.equal(
    worker.activeRooms,
    0,
    'Capacity трябва да е освободен след rollback',
  )
}

// ─── D. Rollback при delegate exception ──────────────────────────────────────

{
  const manager = createInProcessGameWorkerManager({
    workerCount: 1,
    maxRoomsPerWorker: 2,
  })
  const thrownError = new Error('delegate internal error')
  const delegate = makeFakeDelegate({ ensureThrow: thrownError })
  const runtime = createWorkerBackedActiveRoomRuntime({
    workerManager: manager,
    delegate,
  })

  const room = makeRoom('rollback-throw')

  assert.throws(
    () => runtime.ensureRoom(room),
    (err) => err === thrownError,
    'Wrapper трябва да rethrow-не същата грешка',
  )

  assert.equal(
    manager.getWorkerIdForRoom('rollback-throw'),
    null,
    'Assignment трябва да е премахнат след delegate exception',
  )

  const worker = manager.getWorkers()[0]
  assert.equal(
    worker.activeRooms,
    0,
    'Capacity трябва да е освободен след exception rollback',
  )
}

// ─── E. Duplicate ensure failure (existing assignment) ───────────────────────

{
  const manager = createInProcessGameWorkerManager({
    workerCount: 1,
    maxRoomsPerWorker: 2,
  })

  // Delegate, който успява при първи ensure, после failure-ва
  let ensureCount = 0
  const delegate = makeFakeDelegate()
  const originalEnsure = delegate.ensureRoom.bind(delegate)
  delegate.ensureRoom = (room: ServerRoom): EnsureRoomResult => {
    ensureCount += 1

    if (ensureCount > 1) {
      return { ok: false, reason: 'no_capacity' }
    }

    return originalEnsure(room)
  }

  const runtime = createWorkerBackedActiveRoomRuntime({
    workerManager: manager,
    delegate,
  })

  const room = makeRoom('dup-fail')

  const r1 = runtime.ensureRoom(room)
  assert.equal(r1.ok, true, 'Първи ensure трябва да е success')

  const workerIdBefore = manager.getWorkerIdForRoom('dup-fail')
  assert.notEqual(workerIdBefore, null, 'Assignment трябва да съществува')

  const r2 = runtime.ensureRoom(room)
  assert.equal(
    r2.ok,
    false,
    'Duplicate ensure с delegate failure трябва да върне failure',
  )

  // Съществуващият assignment НЕ трябва да се премахне
  assert.equal(
    manager.getWorkerIdForRoom('dup-fail'),
    workerIdBefore,
    'Предварително съществуващият assignment не трябва да се премахне',
  )

  const worker = manager.getWorkers()[0]
  assert.equal(
    worker.activeRooms,
    1,
    'Room count трябва да остане 1 — assignment не е нов',
  )
}

// ─── F. Batch partitioning ───────────────────────────────────────────────────

{
  const manager = createInProcessGameWorkerManager({
    workerCount: 2,
    maxRoomsPerWorker: 5,
  })
  const delegate = makeFakeDelegate()
  const runtime = createWorkerBackedActiveRoomRuntime({
    workerManager: manager,
    delegate,
  })

  const roomA = makeRoom('batch-a')
  const roomB = makeRoom('batch-b')
  const roomC = makeRoom('batch-c')

  // A → worker-1, B → worker-2, C → worker-1 (round-robin least-loaded)
  runtime.ensureRoom(roomA)
  runtime.ensureRoom(roomB)
  runtime.ensureRoom(roomC)

  const workerA = manager.getWorkerIdForRoom('batch-a')
  const workerB = manager.getWorkerIdForRoom('batch-b')
  const workerC = manager.getWorkerIdForRoom('batch-c')

  assert.notEqual(workerA, workerB, 'A и B трябва да са на различни workers')
  assert.equal(workerA, workerC, 'A и C трябва да са на един и същ worker')

  delegate.tickCalls.length = 0

  const tickResult = runtime.tickRooms({
    now: 12345,
    rooms: [roomB, roomA, roomC],
  })

  // Два batch-а: по един за всеки worker
  assert.equal(
    delegate.tickCalls.length,
    2,
    'Delegate трябва да е извикан два пъти',
  )

  // И двата batch-а трябва да са получили един и същ now
  for (const call of delegate.tickCalls) {
    assert.equal(call.now, 12345, 'Всеки batch трябва да получи same now')
  }

  // Batch-ът за worker с A и C трябва да съдържа roomA и roomC
  const batchForWorkerAC = delegate.tickCalls.find((call) =>
    call.rooms.some((r) => r.id === 'batch-a'),
  )
  assert.notEqual(batchForWorkerAC, undefined, 'Трябва да има batch с A')
  assert.equal(
    batchForWorkerAC!.rooms.length,
    2,
    'Batch-ът за workerAC трябва да съдържа 2 rooms',
  )
  assert.ok(
    batchForWorkerAC!.rooms.some((r) => r.id === 'batch-a'),
    'Batch-ът трябва да съдържа A',
  )
  assert.ok(
    batchForWorkerAC!.rooms.some((r) => r.id === 'batch-c'),
    'Batch-ът трябва да съдържа C',
  )

  // Batch-ът за worker с B трябва да съдържа само roomB
  const batchForWorkerB = delegate.tickCalls.find((call) =>
    call.rooms.some((r) => r.id === 'batch-b'),
  )
  assert.notEqual(batchForWorkerB, undefined, 'Трябва да има batch с B')
  assert.equal(
    batchForWorkerB!.rooms.length,
    1,
    'Batch-ът за workerB трябва да съдържа 1 room',
  )

  // Крайният result ред трябва да е B, A, C (оригиналният ред)
  assert.equal(tickResult.results.length, 3, 'Трябва да има 3 results')
  assert.equal(
    tickResult.results[0].roomId,
    'batch-b',
    'Първият result трябва да е B',
  )
  assert.equal(
    tickResult.results[1].roomId,
    'batch-a',
    'Вторият result трябва да е A',
  )
  assert.equal(
    tickResult.results[2].roomId,
    'batch-c',
    'Третият result трябва да е C',
  )
}

// ─── G. Missing assignment по време на tick ──────────────────────────────────

{
  const manager = createInProcessGameWorkerManager({
    workerCount: 1,
    maxRoomsPerWorker: 5,
  })
  const delegate = makeFakeDelegate()
  const runtime = createWorkerBackedActiveRoomRuntime({
    workerManager: manager,
    delegate,
  })

  const unassignedRoom = makeRoom('no-assignment')

  // НЕ извикваме ensureRoom — стаята е без assignment

  assert.throws(
    () =>
      runtime.tickRooms({
        now: 1000,
        rooms: [unassignedRoom],
      }),
    (err) =>
      err instanceof Error &&
      err.message.includes('no worker assignment during tick'),
    'Tick без assignment трябва да хвърли invariant error',
  )

  assert.equal(
    delegate.tickCalls.length,
    0,
    'Delegate tick не трябва да е извикан',
  )
}

// ─── H. Commands ──────────────────────────────────────────────────────────────

{
  const manager = createInProcessGameWorkerManager({
    workerCount: 1,
    maxRoomsPerWorker: 5,
  })
  const delegate = makeFakeDelegate()
  const runtime = createWorkerBackedActiveRoomRuntime({
    workerManager: manager,
    delegate,
  })

  const assignedRoom = makeRoom('cmd-room')
  const unassignedRoom = makeRoom('cmd-no-assign')

  runtime.ensureRoom(assignedRoom)

  const fakeRoom = assignedRoom

  const commands: Array<{
    name: string
    call: () => RuntimeCommandResult
  }> = [
    {
      name: 'submitBid',
      call: () =>
        runtime.submitBid({
          room: unassignedRoom,
          seat: 'south',
          action: { kind: 'pass' },
        } as unknown as SubmitBidInput),
    },
    {
      name: 'submitCut',
      call: () =>
        runtime.submitCut({
          room: unassignedRoom,
          seat: 'south',
          cutIndex: 0,
        } as unknown as SubmitCutInput),
    },
    {
      name: 'submitPlay',
      call: () =>
        runtime.submitPlay({
          room: unassignedRoom,
          seat: 'south',
          cardId: 'c1',
        } as unknown as SubmitPlayInput),
    },
    {
      name: 'resumeHumanControl',
      call: () =>
        runtime.resumeHumanControl({
          room: unassignedRoom,
          seat: 'south',
        } as unknown as ResumeHumanControlInput),
    },
    {
      name: 'abandonHumanControl',
      call: () =>
        runtime.abandonHumanControl({
          room: unassignedRoom,
          seat: 'south',
        } as unknown as AbandonHumanControlInput),
    },
  ]

  // Без assignment → failure, delegate не се извиква
  for (const cmd of commands) {
    delegate.commandCalls.length = 0
    const result = cmd.call()
    assert.equal(
      result.ok,
      false,
      `${cmd.name} без assignment трябва да върне failure`,
    )
    assert.equal(
      delegate.commandCalls.length,
      0,
      `Delegate не трябва да е извикан за ${cmd.name} без assignment`,
    )
  }

  // С assignment → delegate се извиква
  const assignedCommands: Array<{
    name: string
    call: () => RuntimeCommandResult
  }> = [
    {
      name: 'submitBid',
      call: () =>
        runtime.submitBid({
          room: fakeRoom,
          seat: 'south',
          action: { kind: 'pass' },
        } as unknown as SubmitBidInput),
    },
    {
      name: 'submitCut',
      call: () =>
        runtime.submitCut({
          room: fakeRoom,
          seat: 'south',
          cutIndex: 0,
        } as unknown as SubmitCutInput),
    },
    {
      name: 'submitPlay',
      call: () =>
        runtime.submitPlay({
          room: fakeRoom,
          seat: 'south',
          cardId: 'c1',
        } as unknown as SubmitPlayInput),
    },
    {
      name: 'resumeHumanControl',
      call: () =>
        runtime.resumeHumanControl({
          room: fakeRoom,
          seat: 'south',
        } as unknown as ResumeHumanControlInput),
    },
    {
      name: 'abandonHumanControl',
      call: () =>
        runtime.abandonHumanControl({
          room: fakeRoom,
          seat: 'south',
        } as unknown as AbandonHumanControlInput),
    },
  ]

  for (const cmd of assignedCommands) {
    delegate.commandCalls.length = 0
    const result = cmd.call()
    assert.equal(
      result.ok,
      true,
      `${cmd.name} с assignment трябва да е success`,
    )
    assert.equal(
      delegate.commandCalls.length,
      1,
      `Delegate трябва да е извикан за ${cmd.name}`,
    )
    assert.equal(
      delegate.commandCalls[0],
      cmd.name,
      `Delegate трябва да е получил ${cmd.name}`,
    )
  }
}

// ─── I. Remove ordering ───────────────────────────────────────────────────────

{
  const operations: string[] = []

  const manager = createInProcessGameWorkerManager({
    workerCount: 1,
    maxRoomsPerWorker: 5,
  })

  // Instrumented delegate
  const delegate = makeFakeDelegate()
  const originalRemove = delegate.removeRoom.bind(delegate)
  delegate.removeRoom = (roomId: string): void => {
    operations.push(`delegate:remove:${roomId}`)
    originalRemove(roomId)
  }

  // Instrumented manager proxy
  const managerProxy: typeof manager = {
    ...manager,
    ensureRoom(roomId: string) {
      return manager.ensureRoom(roomId)
    },
    getWorkerIdForRoom(roomId: string) {
      return manager.getWorkerIdForRoom(roomId)
    },
    removeRoom(roomId: string) {
      operations.push(`manager:remove:${roomId}`)
      manager.removeRoom(roomId)
    },
    getWorkers() {
      return manager.getWorkers()
    },
    getHealth() {
      return manager.getHealth()
    },
  }

  const runtime = createWorkerBackedActiveRoomRuntime({
    workerManager: managerProxy,
    delegate,
  })

  const room = makeRoom('remove-order')
  runtime.ensureRoom(room)
  operations.length = 0

  runtime.removeRoom('remove-order')

  assert.equal(operations.length, 2, 'Трябва да има точно 2 операции')
  assert.equal(
    operations[0],
    'delegate:remove:remove-order',
    'Delegate remove трябва да е първи',
  )
  assert.equal(
    operations[1],
    'manager:remove:remove-order',
    'Manager remove трябва да е втори',
  )

  assert.equal(
    manager.getWorkerIdForRoom('remove-order'),
    null,
    'Assignment трябва да е премахнат',
  )
  assert.equal(
    delegate.hasRoom('remove-order'),
    false,
    'Delegate не трябва да има room след remove',
  )

  // Duplicate remove е no-op
  assert.doesNotThrow(
    () => runtime.removeRoom('remove-order'),
    'Duplicate remove не трябва да хвърля',
  )
}

// ─── J. hasRoom и health ──────────────────────────────────────────────────────

{
  const manager = createInProcessGameWorkerManager({
    workerCount: 1,
    maxRoomsPerWorker: 5,
  })
  const delegate = makeFakeDelegate()
  const runtime = createWorkerBackedActiveRoomRuntime({
    workerManager: manager,
    delegate,
  })

  const room = makeRoom('has-room-test')

  // Преди ensure — false
  assert.equal(
    runtime.hasRoom('has-room-test'),
    false,
    'hasRoom трябва да е false преди ensure',
  )

  runtime.ensureRoom(room)

  // След ensure — true
  assert.equal(
    runtime.hasRoom('has-room-test'),
    true,
    'hasRoom трябва да е true след ensure',
  )

  // Health е точно delegate health — без worker fields
  const health = runtime.getHealth()
  assert.equal(
    health.activeRooms,
    delegate.getHealth().activeRooms,
    'health.activeRooms трябва да е от delegate',
  )
  assert.ok(
    !('workers' in health),
    'Health не трябва да съдържа worker breakdown',
  )
  assert.ok(
    !('configuredWorkers' in health),
    'Health не трябва да съдържа configuredWorkers',
  )
}

// ─── K. Single-worker mode ────────────────────────────────────────────────────

{
  const manager = createInProcessGameWorkerManager({
    workerCount: 1,
    maxRoomsPerWorker: 10,
  })
  const delegate = makeFakeDelegate()
  const runtime = createWorkerBackedActiveRoomRuntime({
    workerManager: manager,
    delegate,
  })

  const rooms = [
    makeRoom('sw-1'),
    makeRoom('sw-2'),
    makeRoom('sw-3'),
  ]

  for (const room of rooms) {
    runtime.ensureRoom(room)
  }

  delegate.tickCalls.length = 0

  const tickResult = runtime.tickRooms({
    now: 9999,
    rooms,
  })

  assert.equal(
    delegate.tickCalls.length,
    1,
    'Single worker трябва да предизвика точно 1 delegate tick',
  )

  assert.equal(
    tickResult.results.length,
    3,
    'Трябва да има 3 results',
  )

  for (let i = 0; i < rooms.length; i += 1) {
    assert.equal(
      tickResult.results[i].roomId,
      rooms[i].id,
      `Result ${i} трябва да съответства на room ${rooms[i].id}`,
    )
  }
}

// ─── Финал ───────────────────────────────────────────────────────────────────

console.log('WorkerBackedActiveRoomRuntime checks passed.')
