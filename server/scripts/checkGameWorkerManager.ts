import assert from 'node:assert/strict'
import { createInProcessGameWorkerManager } from '../src/game/createInProcessGameWorkerManager.js'

// ─── 1. Балансиране ─────────────────────────────────────────────────────────

{
  const m = createInProcessGameWorkerManager({
    workerCount: 3,
    maxRoomsPerWorker: 2,
  })

  const w1 = m.ensureRoom('room-1')
  const w2 = m.ensureRoom('room-2')
  const w3 = m.ensureRoom('room-3')

  assert.notEqual(w1, null, 'room-1 трябва да получи worker')
  assert.notEqual(w2, null, 'room-2 трябва да получи worker')
  assert.notEqual(w3, null, 'room-3 трябва да получи worker')

  // Трите rooms трябва да са на различни workers
  const firstThree = new Set([w1, w2, w3])
  assert.equal(firstThree.size, 3, 'Първите три rooms трябва да са на три различни workers')

  m.ensureRoom('room-4')
  m.ensureRoom('room-5')
  m.ensureRoom('room-6')

  // След шест rooms всеки worker трябва да има точно 2
  for (const worker of m.getWorkers()) {
    assert.equal(worker.activeRooms, 2, `${worker.workerId} трябва да има точно 2 rooms`)
  }
}

// ─── 2. Capacity ─────────────────────────────────────────────────────────────

{
  const m = createInProcessGameWorkerManager({
    workerCount: 3,
    maxRoomsPerWorker: 2,
  })

  for (let i = 1; i <= 6; i++) {
    m.ensureRoom(`room-${i}`)
  }

  const result = m.ensureRoom('room-7')
  assert.equal(result, null, 'Седми room при пълни workers трябва да върне null')
}

// ─── 3. Idempotency ──────────────────────────────────────────────────────────

{
  const m = createInProcessGameWorkerManager({
    workerCount: 3,
    maxRoomsPerWorker: 2,
  })

  const first = m.ensureRoom('room-1')
  assert.notEqual(first, null)

  // Пълни workers
  for (let i = 2; i <= 6; i++) {
    m.ensureRoom(`room-${i}`)
  }

  // Повторен ensureRoom за вече-assigned room при пълни workers
  const second = m.ensureRoom('room-1')
  assert.equal(second, first, 'Повторен ensureRoom трябва да върне същия workerId')

  // activeRooms не трябва да се е увеличил
  const workerSnapshot = m.getWorkers().find((w) => w.workerId === first)
  assert.notEqual(workerSnapshot, undefined)
  assert.equal(workerSnapshot!.activeRooms, 2, 'activeRooms не трябва да нарасне при повторен ensureRoom')
}

// ─── 4. Lookup ───────────────────────────────────────────────────────────────

{
  const m = createInProcessGameWorkerManager({
    workerCount: 2,
    maxRoomsPerWorker: 5,
  })

  const assigned = m.ensureRoom('room-lookup')
  assert.notEqual(assigned, null)

  assert.equal(
    m.getWorkerIdForRoom('room-lookup'),
    assigned,
    'getWorkerIdForRoom трябва да върне правилния workerId',
  )

  assert.equal(
    m.getWorkerIdForRoom('room-unknown'),
    null,
    'getWorkerIdForRoom за непознат room трябва да върне null',
  )
}

// ─── 5. Remove ───────────────────────────────────────────────────────────────

{
  const m = createInProcessGameWorkerManager({
    workerCount: 2,
    maxRoomsPerWorker: 2,
  })

  const w = m.ensureRoom('room-a')
  assert.notEqual(w, null)

  const workerBefore = m.getWorkers().find((wk) => wk.workerId === w)!
  assert.equal(workerBefore.activeRooms, 1)

  m.removeRoom('room-a')

  assert.equal(m.getWorkerIdForRoom('room-a'), null, 'След removeRoom lookup трябва да върне null')

  const workerAfter = m.getWorkers().find((wk) => wk.workerId === w)!
  assert.equal(workerAfter.activeRooms, 0, 'removeRoom трябва да намали activeRooms с 1')

  // Повторно remove е no-op
  m.removeRoom('room-a')
  const workerAfter2 = m.getWorkers().find((wk) => wk.workerId === w)!
  assert.equal(workerAfter2.activeRooms, 0, 'Повторен removeRoom не трябва да намалява count')

  // Пълни workers преди remove
  const m2 = createInProcessGameWorkerManager({
    workerCount: 1,
    maxRoomsPerWorker: 1,
  })
  const wA = m2.ensureRoom('room-x')
  assert.notEqual(wA, null)
  assert.equal(m2.ensureRoom('room-y'), null, 'Трябва да е пълно')

  m2.removeRoom('room-x')

  // След освобождаване новият room трябва да може да влезе
  const wB = m2.ensureRoom('room-y')
  assert.notEqual(wB, null, 'Нов room трябва да заеме освободения capacity')

  // Никой worker няма отрицателен count
  for (const worker of m2.getWorkers()) {
    assert.ok(worker.activeRooms >= 0, 'activeRooms не трябва да е отрицателен')
  }
}

// ─── 6. Single-worker mode ───────────────────────────────────────────────────

{
  const m = createInProcessGameWorkerManager({
    workerCount: 1,
    maxRoomsPerWorker: 2,
  })

  const w1 = m.ensureRoom('room-s1')
  const w2 = m.ensureRoom('room-s2')

  assert.equal(w1, 'game-worker-1', 'Single worker трябва да е game-worker-1')
  assert.equal(w2, 'game-worker-1', 'Вторият room трябва да отиде при game-worker-1')

  const w3 = m.ensureRoom('room-s3')
  assert.equal(w3, null, 'Третият room трябва да върне null при пълен single worker')
}

// ─── 7. Невалидна конфигурация ───────────────────────────────────────────────

{
  const invalidCases: Array<{ config: { workerCount: number; maxRoomsPerWorker: number }; label: string }> = [
    { config: { workerCount: 0, maxRoomsPerWorker: 10 }, label: 'workerCount: 0' },
    { config: { workerCount: NaN, maxRoomsPerWorker: 10 }, label: 'workerCount: NaN' },
    { config: { workerCount: 1.5, maxRoomsPerWorker: 10 }, label: 'workerCount: 1.5' },
    { config: { workerCount: 2, maxRoomsPerWorker: 0 }, label: 'maxRoomsPerWorker: 0' },
    { config: { workerCount: 2, maxRoomsPerWorker: Infinity }, label: 'maxRoomsPerWorker: Infinity' },
  ]

  for (const { config, label } of invalidCases) {
    assert.throws(
      () => createInProcessGameWorkerManager(config),
      (err) => err instanceof Error,
      `Трябва да хвърли Error при ${label}`,
    )
  }
}

// ─── 8. Health invariant ─────────────────────────────────────────────────────

{
  const m = createInProcessGameWorkerManager({
    workerCount: 3,
    maxRoomsPerWorker: 5,
  })

  m.ensureRoom('h-1')
  m.ensureRoom('h-2')
  m.ensureRoom('h-3')
  m.removeRoom('h-2')

  const health = m.getHealth()
  const workers = m.getWorkers()

  const sumFromWorkers = workers.reduce((sum, w) => sum + w.activeRooms, 0)
  const sumFromHealth = health.totalActiveRooms

  assert.equal(
    sumFromWorkers,
    sumFromHealth,
    'sum(workers.activeRooms) трябва да съвпада с health.totalActiveRooms',
  )

  // 2 активни assignments: h-1 и h-3
  assert.equal(sumFromHealth, 2, 'totalActiveRooms трябва да е 2 след едно remove')

  assert.equal(health.configuredWorkers, 3)
  assert.equal(health.readyWorkers, 3)
}

// ─── Финал ───────────────────────────────────────────────────────────────────

console.log('GameWorkerManager checks passed.')
