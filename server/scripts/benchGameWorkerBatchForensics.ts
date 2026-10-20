/**
 * benchGameWorkerBatchForensics.ts — synthetic overhead на Phase 0C:
 *   - worker side: diagnostics collector (threadCpuUsage + per-room timing)
 *     около 1-room и 8-room batch (синтетична room работа)
 *   - main side: tick client с/без onBatchTiming (loopback endpoint) за
 *     1-room и 8-room batch
 *   - metrics: record() и snapshot/reset при 1/4/32 worker-а
 * ns/операция (median от няколко прогона). Не е тест.
 */

import { getThreadCpuUsageFn, startGameWorkerBatchDiagnostics } from '../src/game/gameWorkerBatchDiagnostics.js'
import { createGameWorkerBatchMetrics } from '../src/monitoring/gameWorkerBatchMetrics.js'
import { createGameWorkerTickClient, type GameWorkerTickMessageEndpoint } from '../src/game/createGameWorkerTickClient.js'
import { GAME_WORKER_PROTOCOL_VERSION } from '../src/game/workerProtocol.js'
import { SERVER_ANTI_BAD_LUCK_DEFAULT_CONFIG } from '../src/game/antiBadLuck/serverAntiBadLuckTypes.js'
import type { ServerRoom } from '../src/core/serverTypes.js'

const RUNS = 5

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

async function measure(iterations: number, fn: () => unknown): Promise<number> {
  const results: number[] = []
  for (let run = 0; run < RUNS; run += 1) {
    const startedAt = performance.now()
    for (let i = 0; i < iterations; i += 1) {
      const result = fn()
      if (result instanceof Promise) await result
    }
    results.push(((performance.now() - startedAt) * 1e6) / iterations)
  }
  return median(results)
}

function work(): number {
  // ~ малка синтетична "room compute" работа
  let total = 0
  for (let i = 0; i < 200; i += 1) total += i * 31
  return total
}

const fakeRoom = { id: 'bench-room', game: { authoritativeState: { phase: 'playing' } } } as unknown as ServerRoom
const rows: Array<[string, number, number]> = []

// worker side
const threadCpuUsage = getThreadCpuUsageFn()
const now = () => performance.now()
for (const roomCount of [1, 8]) {
  const base = await measure(100_000, () => {
    for (let i = 0; i < roomCount; i += 1) work()
  })
  const timed = await measure(100_000, () => {
    const collector = startGameWorkerBatchDiagnostics(now, threadCpuUsage)
    for (let i = 0; i < roomCount; i += 1) {
      const startedAt = now()
      work()
      collector.recordRoom(startedAt, fakeRoom.id, fakeRoom, null, 'unchanged')
    }
    return collector.finish()
  })
  rows.push([`worker batch (${roomCount} room${roomCount > 1 ? 's' : ''})`, base, timed])
}

// main side (tick client, loopback endpoint, отговаря синхронно)
for (const roomCount of [1, 8]) {
  const rooms = Array.from({ length: roomCount }, (_, i) => ({ roomId: `r${i}`, baseRevision: 1, room: { id: `r${i}` } as unknown as ServerRoom }))
  const makeClient = (withHook: boolean) => {
    let listener: ((message: unknown) => void) | null = null
    const metrics = createGameWorkerBatchMetrics()
    const endpoint: GameWorkerTickMessageEndpoint = {
      postMessage(message) {
        const request = message as { requestId: string }
        const response = {
          type: 'compute_tick_rooms_response',
          protocolVersion: GAME_WORKER_PROTOCOL_VERSION,
          requestId: request.requestId,
          results: rooms.map((room) => ({ roomId: room.roomId, baseRevision: 1, result: 'unchanged' })),
          diagnostics: { batchWallMs: 1, batchCpuMs: 0.9, roomCount, sumRoomComputeMs: 0.8, maxRoomComputeMs: 0.3, slowestRoomPhase: 'playing', slowestRoomNextPhase: 'playing', slowestRoomOutcome: 'unchanged' },
        }
        queueMicrotask(() => listener?.(response))
      },
      on(_event, fn) { listener = fn },
      off() { listener = null },
    }
    return createGameWorkerTickClient({ endpoint, ...(withHook ? { onBatchTiming: (timing) => metrics.record(0, timing) } : {}) })
  }
  const plain = makeClient(false)
  const hooked = makeClient(true)
  const base = await measure(50_000, () => plain.computeTickRooms(rooms, 1, SERVER_ANTI_BAD_LUCK_DEFAULT_CONFIG))
  const timed = await measure(50_000, () => hooked.computeTickRooms(rooms, 1, SERVER_ANTI_BAD_LUCK_DEFAULT_CONFIG))
  rows.push([`main tick client (${roomCount} room${roomCount > 1 ? 's' : ''})`, base, timed])
}

console.log('path'.padEnd(34), 'baseline ns/op'.padStart(15), 'instrumented ns/op'.padStart(19), 'overhead ns/op'.padStart(15), 'overhead %'.padStart(11))
for (const [name, base, timed] of rows) {
  console.log(name.padEnd(34), base.toFixed(0).padStart(15), timed.toFixed(0).padStart(19), (timed - base).toFixed(0).padStart(15),
    `${(((timed - base) / base) * 100).toFixed(1)}%`.padStart(11))
}

// metrics aggregation
{
  const metrics = createGameWorkerBatchMetrics()
  const timing = {
    outcome: 'completed' as const, roomCount: 3, roundTripWallMs: 4, requestPostMessageMs: 0.1,
    diagnostics: { batchWallMs: 3, batchCpuMs: 2.5, roomCount: 3, sumRoomComputeMs: 2.4, maxRoomComputeMs: 1.2, slowestRoomPhase: 'playing' as const, slowestRoomNextPhase: 'playing' as const, slowestRoomOutcome: 'unchanged' as const },
  }
  const recordNs = await measure(500_000, () => metrics.record(1, timing))
  console.log(`\nmetrics.record(): ${recordNs.toFixed(0)} ns/op`)
  console.log('snapshot/reset'.padEnd(20), 'workers'.padStart(8), 'oneSecond µs'.padStart(14), 'tenSecond µs'.padStart(14))
  for (const workers of [0, 1, 4, 32]) {
    const one: number[] = []
    const ten: number[] = []
    for (let run = 0; run < RUNS; run += 1) {
      const target = createGameWorkerBatchMetrics()
      let oneTotal = 0
      let tenTotal = 0
      const iterations = 20_000
      for (let i = 0; i < iterations; i += 1) {
        for (let w = 0; w < workers; w += 1) target.record(w, timing)
        let startedAt = performance.now()
        target.snapshotOneSecondAndReset()
        oneTotal += performance.now() - startedAt
        startedAt = performance.now()
        target.snapshotTenSecondAndReset()
        tenTotal += performance.now() - startedAt
      }
      one.push((oneTotal * 1000) / iterations)
      ten.push((tenTotal * 1000) / iterations)
    }
    console.log(''.padEnd(20), String(workers).padStart(8), median(one).toFixed(2).padStart(14), median(ten).toFixed(2).padStart(14))
  }
}
