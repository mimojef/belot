/**
 * checkGameWorkerBatchForensics.ts — Phase 0C game worker forensics.
 *
 *  [1] fast batch
 *  [2] slow worker compute (worker wall ≈ round trip)
 *  [3] slow round trip, fast worker compute (unaccounted)
 *  [4] maxRoomCompute selection (collector + across batches) и slowestRoomId правила
 *  [5] slow thresholds (>=50/100/250/500, кумулативни)
 *  [6] worker thread CPU delta: µs → ms, null без API, structured clone round trip
 *  [7] bounded keys/labels (worker index, phase/outcome enum, room id)
 *  [8] без profile/hand/payload leakage
 *  [9] malformed/missing diagnostics и throwing hook не влияят на gameplay резултата
 * [10] 1s/10s window reset семантика
 * [11] реален worker (dist build): diagnostics пристигат, резултатът е непроменен
 */

import {
  GAME_WORKER_ROOM_PHASE_LABELS,
  SLOW_BATCH_ROOM_ID_THRESHOLD_MS,
  resolveGameWorkerRoomPhaseLabel,
  sanitizeGameWorkerBatchDiagnostics,
  startGameWorkerBatchDiagnostics,
  type GameWorkerBatchDiagnostics,
} from '../src/game/gameWorkerBatchDiagnostics.js'
import {
  GAME_WORKER_OVERFLOW_KEY,
  createGameWorkerBatchMetrics,
  resolveGameWorkerKey,
} from '../src/monitoring/gameWorkerBatchMetrics.js'
import {
  createGameWorkerTickClient,
  type GameWorkerTickBatchTiming,
  type GameWorkerTickMessageEndpoint,
} from '../src/game/createGameWorkerTickClient.js'
import { createGameWorkerPool } from '../src/game/createGameWorkerPool.js'
import { resolveGameWorkerEntryUrl } from '../src/game/resolveGameWorkerEntryUrl.js'
import { GAME_WORKER_PROTOCOL_VERSION, type GameWorkerTickRoomResult } from '../src/game/workerProtocol.js'
import { createServerRoom } from '../src/core/createServerRoom.js'
import { createHumanParticipant } from '../src/core/createHumanParticipant.js'
import { createBotParticipant } from '../src/core/createBotParticipant.js'
import { seatParticipantInRoom } from '../src/core/seatParticipantInRoom.js'
import { SERVER_SEAT_ORDER, type ServerRoom } from '../src/core/serverTypes.js'
import { initializeRoomAuthoritativeGameState } from '../src/game/initializeRoomAuthoritativeGameState.js'
import { advanceRoomAuthoritativeGame } from '../src/game/advanceRoomAuthoritativeGame.js'
import { SERVER_ANTI_BAD_LUCK_DEFAULT_CONFIG } from '../src/game/antiBadLuck/serverAntiBadLuckTypes.js'
import { summarizeGameWorkerBatches } from '../../src/app/adminServer/renderAdminCpuIncidents.js'

let passed = 0
let failed = 0

function check(label: string, condition: boolean, details = ''): void {
  if (condition) {
    passed += 1
    console.log(`  ok ${label}`)
  } else {
    failed += 1
    console.error(`  FAIL ${label}${details ? `: ${details}` : ''}`)
  }
}

function fakeClock(start = 0) {
  let value = start
  return { now: () => value, advance: (ms: number) => { value += ms } }
}

const SECRET_PROFILE = 'profile-secret-7f3a9c'
const SECRET_NAME = 'SecretDisplayName'

function makeRoom(roomId: string): ServerRoom {
  let room: ServerRoom = createServerRoom({ roomId, config: { allowBots: true, isPrivate: true, joinCode: null, stakeAmount: 0, targetScore: 151 } as never })
  for (const seat of SERVER_SEAT_ORDER) {
    room = seatParticipantInRoom(room, seat, seat === 'left'
      ? createBotParticipant({ botCode: 'b' })
      : createHumanParticipant({ connectionId: `conn-${seat}`, identity: { profileId: `${SECRET_PROFILE}-${seat}`, displayName: `${SECRET_NAME}-${seat}` } as never }))
  }
  return initializeRoomAuthoritativeGameState(room)
}

function diagnostics(overrides: Partial<GameWorkerBatchDiagnostics> = {}): GameWorkerBatchDiagnostics {
  return {
    batchWallMs: 2,
    batchCpuMs: 1.5,
    roomCount: 1,
    sumRoomComputeMs: 1.8,
    maxRoomComputeMs: 1.8,
    slowestRoomPhase: 'playing',
    slowestRoomNextPhase: 'playing',
    slowestRoomOutcome: 'unchanged',
    ...overrides,
  }
}

function completed(roundTripWallMs: number, diag: GameWorkerBatchDiagnostics | null, roomCount = 1, requestPostMessageMs = 0.05): GameWorkerTickBatchTiming {
  return { outcome: 'completed', roomCount, roundTripWallMs, requestPostMessageMs, diagnostics: diag }
}

// ─── [1] fast batch ──────────────────────────────────────────────────────────
console.log('\n[1] fast batch')
{
  const metrics = createGameWorkerBatchMetrics()
  metrics.record(0, completed(3, diagnostics()))
  const w = metrics.peek().w1
  check('batch counted', w?.batchCount === 1 && w.roomCount === 1)
  check('round trip / worker wall / cpu recorded', w?.roundTripWallTotalMs === 3 && w.workerBatchWallTotalMs === 2 && w.workerBatchCpuTotalMs === 1.5)
  check('unaccounted = round trip − worker wall = 1', w?.unaccountedRoundTripTotalMs === 1 && w.unaccountedRoundTripMaxMs === 1)
  check('no slow counters', w?.roundTripSlow50 === 0 && w.workerWallSlow50 === 0)
  check('no slowestRoomId for fast batch', w?.slowestRoomId === null)
}

// ─── [2] slow worker compute ─────────────────────────────────────────────────
console.log('\n[2] slow worker compute')
{
  const metrics = createGameWorkerBatchMetrics()
  metrics.record(1, completed(880, diagnostics({ batchWallMs: 872, batchCpuMs: 860, sumRoomComputeMs: 871, maxRoomComputeMs: 871, slowestRoomPhase: 'bidding', slowestRoomNextPhase: 'deal-last-3', slowestRoomOutcome: 'advanced', slowestRoomId: 'room-a' })))
  const w = metrics.peek().w2
  check('worker wall and CPU dominate', w?.workerBatchWallMaxMs === 872 && w.workerBatchCpuMaxMs === 860)
  check('unaccounted small (8ms)', w?.unaccountedRoundTripMaxMs === 8)
  check('both slow500 counters', w?.roundTripSlow500 === 1 && w.workerWallSlow500 === 1)
  check('slowest room phase/outcome/id kept', w?.slowestRoomPhase === 'bidding' && w.slowestRoomNextPhase === 'deal-last-3' && w.slowestRoomOutcome === 'advanced' && w.slowestRoomId === 'room-a')
}

// ─── [3] slow round trip, fast worker ────────────────────────────────────────
console.log('\n[3] slow round trip, fast worker compute')
{
  const metrics = createGameWorkerBatchMetrics()
  metrics.record(0, completed(600, diagnostics({ batchWallMs: 3, batchCpuMs: 2.5 })))
  const w = metrics.peek().w1
  check('round trip slow500, worker wall not slow', w?.roundTripSlow500 === 1 && w.workerWallSlow50 === 0)
  check('unaccounted = 597ms (queue/transfer/main delay)', w?.unaccountedRoundTripMaxMs === 597)
  check('worker CPU small', w?.workerBatchCpuMaxMs === 2.5)
  const row = summarizeGameWorkerBatches(metrics.peek())
  check('UI row shows round trip, worker wall, CPU and unaccounted', row.includes('round trip общо/макс 600/600мс') && row.includes('worker wall 3/3мс') &&
    row.includes('unaccounted 597/597мс') && row.includes('≥500мс:1'), row)
}

// ─── [4] maxRoomCompute selection ────────────────────────────────────────────
console.log('\n[4] maxRoomCompute selection')
{
  const clock = fakeClock()
  const roomA = makeRoom('room-a')
  const roomB = makeRoom('room-b')
  const roomC = makeRoom('room-c')
  const collector = startGameWorkerBatchDiagnostics(clock.now, null)
  for (const [room, ms] of [[roomA, 2], [roomB, 15], [roomC, 4]] as const) {
    const startedAt = clock.now()
    clock.advance(ms)
    collector.recordRoom(startedAt, room.id, room, null, 'unchanged')
  }
  const fast = collector.finish()
  check('max = 15, sum = 21, roomCount = 3', fast.maxRoomComputeMs === 15 && fast.sumRoomComputeMs === 21 && fast.roomCount === 3)
  check('slowest phase from that room (bounded enum)', fast.slowestRoomPhase !== null && GAME_WORKER_ROOM_PHASE_LABELS.includes(fast.slowestRoomPhase))
  check(`fast batch (< ${SLOW_BATCH_ROOM_ID_THRESHOLD_MS}ms) carries no room id`, fast.slowestRoomId === undefined)

  const slowCollector = startGameWorkerBatchDiagnostics(clock.now, null)
  let startedAt = clock.now()
  clock.advance(5)
  slowCollector.recordRoom(startedAt, 'room-a', roomA, null, 'unchanged')
  startedAt = clock.now()
  clock.advance(120)
  slowCollector.recordRoom(startedAt, 'room-b', roomB, null, 'compute_failed')
  const slow = slowCollector.finish()
  check('slow batch carries slowest room id + outcome', slow.slowestRoomId === 'room-b' && slow.slowestRoomOutcome === 'compute_failed')

  const empty = startGameWorkerBatchDiagnostics(clock.now, null).finish()
  check('empty batch → nulls', empty.roomCount === 0 && empty.slowestRoomPhase === null && empty.slowestRoomOutcome === null)

  const metrics = createGameWorkerBatchMetrics()
  metrics.record(0, completed(10, diagnostics({ maxRoomComputeMs: 7, slowestRoomPhase: 'playing' })))
  metrics.record(0, completed(30, diagnostics({ maxRoomComputeMs: 25, slowestRoomPhase: 'scoring', slowestRoomOutcome: 'advanced' })))
  metrics.record(0, completed(12, diagnostics({ maxRoomComputeMs: 9, slowestRoomPhase: 'bidding' })))
  const w = metrics.peek().w1
  check('window keeps the slowest room across batches', w?.maxRoomComputeMs === 25 && w.slowestRoomPhase === 'scoring' && w.slowestRoomOutcome === 'advanced')
}

// ─── [5] slow thresholds ─────────────────────────────────────────────────────
console.log('\n[5] slow thresholds')
{
  const metrics = createGameWorkerBatchMetrics()
  for (const ms of [49.9, 50, 99, 100, 250, 499, 500, 2000]) metrics.record(0, completed(ms, diagnostics({ batchWallMs: ms })))
  const w = metrics.peek().w1
  check('roundTrip slow50/100/250/500 = 7/5/4/2', w?.roundTripSlow50 === 7 && w.roundTripSlow100 === 5 && w.roundTripSlow250 === 4 && w.roundTripSlow500 === 2,
    JSON.stringify(w))
  check('workerWall slow50/100/250/500 = 7/5/4/2', w?.workerWallSlow50 === 7 && w.workerWallSlow100 === 5 && w.workerWallSlow250 === 4 && w.workerWallSlow500 === 2)
}

// ─── [6] worker CPU delta ────────────────────────────────────────────────────
console.log('\n[6] worker thread CPU delta')
{
  let calls = 0
  const fakeThreadCpu = (previous?: NodeJS.CpuUsage): NodeJS.CpuUsage => {
    calls += 1
    return previous === undefined ? { user: 1_000_000, system: 200_000 } : { user: 860_000, system: 12_500 }
  }
  const diag = startGameWorkerBatchDiagnostics(fakeClock().now, fakeThreadCpu).finish()
  check('µs delta → ms (860000+12500 µs = 872.5 ms)', diag.batchCpuMs === 872.5, String(diag.batchCpuMs))
  check('threadCpuUsage called twice (start + delta)', calls === 2)
  const noApi = startGameWorkerBatchDiagnostics(fakeClock().now, null).finish()
  check('no thread CPU API → batchCpuMs null (no process-wide fallback)', noApi.batchCpuMs === null)
  const cloned = structuredClone(diag)
  check('structured clone round trip preserved', JSON.stringify(cloned) === JSON.stringify(diag))
  const sanitized = sanitizeGameWorkerBatchDiagnostics(cloned, new Set())
  check('sanitized CPU value preserved', sanitized?.batchCpuMs === 872.5)
  const metrics = createGameWorkerBatchMetrics()
  metrics.record(0, completed(900, sanitized))
  metrics.record(0, completed(5, noApi))
  const w = metrics.peek().w1
  check('CPU aggregates only batches with CPU', w?.workerBatchCpuCount === 1 && w.workerBatchCpuTotalMs === 872.5)
  check('activity JSON round trip keeps CPU', JSON.parse(JSON.stringify(metrics.peek())).w1.workerBatchCpuMaxMs === 872.5)
}

// ─── [7] bounded keys/labels ─────────────────────────────────────────────────
console.log('\n[7] bounded keys and labels')
{
  check('worker index → w1..w32', resolveGameWorkerKey(0) === 'w1' && resolveGameWorkerKey(31) === 'w32')
  check('out-of-range/invalid index → other', [32, -1, 1.5, Number.NaN, '3', null].every((index) => resolveGameWorkerKey(index) === GAME_WORKER_OVERFLOW_KEY))
  const metrics = createGameWorkerBatchMetrics()
  for (let i = 0; i < 500; i += 1) metrics.record(i, completed(1, diagnostics()))
  const keys = Object.keys(metrics.peek())
  check('at most 33 keys (w1..w32 + other)', keys.length === 33 && keys.every((key) => /^(w\d{1,2}|other)$/.test(key)), String(keys.length))
  const expected = new Set(['room-a'])
  check('phase outside enum → diagnostics rejected', sanitizeGameWorkerBatchDiagnostics({ ...diagnostics(), slowestRoomPhase: 'evil<script>' }, expected) === null)
  check('outcome outside enum → rejected', sanitizeGameWorkerBatchDiagnostics({ ...diagnostics(), slowestRoomOutcome: 'whatever' }, expected) === null)
  check('room id not from request → dropped', sanitizeGameWorkerBatchDiagnostics({ ...diagnostics(), slowestRoomId: 'profile-123' }, expected)?.slowestRoomId === undefined)
  check('room id from request → kept', sanitizeGameWorkerBatchDiagnostics({ ...diagnostics(), slowestRoomId: 'room-a' }, expected)?.slowestRoomId === 'room-a')
  check('room phase label resolver bounded', resolveGameWorkerRoomPhaseLabel(null) === 'none' &&
    resolveGameWorkerRoomPhaseLabel({ game: { authoritativeState: { phase: 'hacked' } } } as never) === 'unknown' &&
    resolveGameWorkerRoomPhaseLabel({ game: { authoritativeState: { kind: 'bootstrap' } } } as never) === 'bootstrap')
}

// ─── [8] no leakage ──────────────────────────────────────────────────────────
console.log('\n[8] no profile/hand/payload leakage')
{
  const room = makeRoom('room-leak')
  const next = advanceRoomAuthoritativeGame(room, Date.now() + 60_000, SERVER_ANTI_BAD_LUCK_DEFAULT_CONFIG)
  const clock = fakeClock()
  const collector = startGameWorkerBatchDiagnostics(clock.now, null)
  const startedAt = clock.now()
  clock.advance(150)
  collector.recordRoom(startedAt, room.id, room, next, next === room ? 'unchanged' : 'advanced')
  const diag = collector.finish()
  const allowedKeys = ['batchWallMs', 'batchCpuMs', 'roomCount', 'sumRoomComputeMs', 'maxRoomComputeMs', 'slowestRoomPhase', 'slowestRoomNextPhase', 'slowestRoomOutcome', 'slowestRoomId']
  check('diagnostics contain only whitelisted keys', Object.keys(diag).every((key) => allowedKeys.includes(key)), Object.keys(diag).join(','))
  const metrics = createGameWorkerBatchMetrics()
  metrics.record(0, completed(160, sanitizeGameWorkerBatchDiagnostics(diag, new Set([room.id]))))
  const serialized = JSON.stringify({ diag, snapshot: metrics.peek(), row: summarizeGameWorkerBatches(metrics.peek()) })
  check('no profile IDs / display names', !serialized.includes(SECRET_PROFILE) && !serialized.includes(SECRET_NAME))
  check('no hand/card/payload fields', !/"(hand|hands|cards|card|deck|room|payload|participant|seats)"/.test(serialized), serialized.slice(0, 200))
  check('only the request room id appears (slow batch)', serialized.includes('room-leak'))
}

// ─── [9] malformed diagnostics / hook failures do not affect gameplay ────────
console.log('\n[9] malformed/missing diagnostics never affect results')
{
  const listeners = new Set<(message: unknown) => void>()
  const sent: Array<Record<string, unknown>> = []
  const endpoint: GameWorkerTickMessageEndpoint = {
    postMessage(message) { sent.push(message as Record<string, unknown>) },
    on(_event, listener) { listeners.add(listener) },
    off(_event, listener) { listeners.delete(listener) },
  }
  const emit = (message: unknown) => { for (const listener of listeners) listener(message) }
  const clock = fakeClock(1000)
  const timings: GameWorkerTickBatchTiming[] = []
  let hookThrows = false
  const client = createGameWorkerTickClient({
    endpoint,
    now: clock.now,
    onBatchTiming: (timing) => {
      timings.push(timing)
      if (hookThrows) throw new Error('hook broken')
    },
  })
  const room = makeRoom('room-m')
  const respond = async (diagnosticsValue: unknown, includeDiagnostics = true): Promise<GameWorkerTickRoomResult[]> => {
    const promise = client.computeTickRooms([{ roomId: room.id, baseRevision: 3, room }], Date.now(), SERVER_ANTI_BAD_LUCK_DEFAULT_CONFIG)
    const request = sent[sent.length - 1]!
    clock.advance(40)
    const response: Record<string, unknown> = {
      type: 'compute_tick_rooms_response',
      protocolVersion: GAME_WORKER_PROTOCOL_VERSION,
      requestId: request['requestId'],
      results: [{ roomId: room.id, baseRevision: 3, result: 'unchanged' }],
    }
    if (includeDiagnostics) response['diagnostics'] = diagnosticsValue
    emit(response)
    return promise
  }
  const expectedResults = JSON.stringify([{ roomId: room.id, baseRevision: 3, result: 'unchanged' }])
  const malformed: unknown[] = [
    'garbage', 42, null, { batchWallMs: -1 }, { ...diagnostics(), batchCpuMs: 'x' }, { ...diagnostics(), roomCount: 1.5 },
    Object.defineProperty({}, 'batchWallMs', { get() { throw new Error('getter boom') }, enumerable: true }),
  ]
  let allSame = true
  for (const value of malformed) if (JSON.stringify(await respond(value)) !== expectedResults) allSame = false
  if (JSON.stringify(await respond(undefined, false)) !== expectedResults) allSame = false
  check('results identical for malformed/missing diagnostics', allSame)
  check('malformed/missing → timing.diagnostics null', timings.length === malformed.length + 1 &&
    timings.every((timing) => timing.outcome === 'completed' && timing.diagnostics === null))
  check('round trip measured with injected clock (40ms)', timings.every((timing) => timing.outcome === 'completed' && timing.roundTripWallMs === 40))
  hookThrows = true
  check('throwing hook does not affect results', JSON.stringify(await respond(diagnostics())) === expectedResults)
  hookThrows = false
  const valid = timings[timings.length - 1]
  check('valid diagnostics delivered', valid?.outcome === 'completed' && valid.diagnostics?.batchWallMs === 2)

  // Worker error → failure timing, caller still gets the rejection.
  const failing = client.computeTickRooms([{ roomId: room.id, baseRevision: 3, room }], Date.now(), SERVER_ANTI_BAD_LUCK_DEFAULT_CONFIG)
  clock.advance(7)
  emit({ type: 'worker_error', requestId: sent[sent.length - 1]!['requestId'], message: 'boom' })
  let rejected = false
  await failing.catch(() => { rejected = true })
  const last = timings[timings.length - 1]
  check('worker_error → rejection preserved + error timing', rejected && last?.outcome === 'error' && last.elapsedMs === 7)
  await client.shutdown()

  // Без hook: request-ът е побитово същият (без допълнителни полета).
  const plainSent: unknown[] = []
  const plainClient = createGameWorkerTickClient({
    endpoint: { postMessage: (message) => { plainSent.push(message) }, on: () => {}, off: () => {} },
  })
  void plainClient.computeTickRooms([{ roomId: room.id, baseRevision: 3, room }], 5, SERVER_ANTI_BAD_LUCK_DEFAULT_CONFIG).catch(() => {})
  check('request message shape unchanged', JSON.stringify(Object.keys(plainSent[0] as object)) === JSON.stringify(['protocolVersion', 'type', 'requestId', 'now', 'antiBadLuckConfig', 'rooms']))
  await plainClient.shutdown()
}

// ─── [10] window semantics ───────────────────────────────────────────────────
console.log('\n[10] window reset semantics')
{
  const metrics = createGameWorkerBatchMetrics()
  metrics.record(0, completed(10, diagnostics()))
  const first = metrics.snapshotOneSecondAndReset()
  metrics.record(0, completed(20, diagnostics()))
  metrics.record(0, { outcome: 'timeout', roomCount: 2, elapsedMs: 5000 })
  const second = metrics.snapshotOneSecondAndReset()
  const empty = metrics.snapshotOneSecondAndReset()
  const ten = metrics.snapshotTenSecondAndReset()
  check('1s windows independent', first.w1?.roundTripWallTotalMs === 10 && second.w1?.roundTripWallTotalMs === 20)
  check('timeout counted separately (not as batch)', second.w1?.timeoutCount === 1 && second.w1?.batchCount === 1)
  check('empty after reset (sparse)', Object.keys(empty).length === 0)
  check('10s window accumulates across 1s resets', ten.w1?.batchCount === 2 && ten.w1?.roundTripWallTotalMs === 30 && ten.w1?.timeoutCount === 1)
  check('10s empty after its reset', Object.keys(metrics.snapshotTenSecondAndReset()).length === 0)
  const snapshot = metrics.peek()
  snapshot.w1 = undefined as never
  check('snapshot is a copy', Object.keys(metrics.peek()).length === 0)
  check('UI tolerates old incidents', summarizeGameWorkerBatches(undefined) === '' && summarizeGameWorkerBatches({}) === '0x')
}

// ─── [11] real worker E2E ────────────────────────────────────────────────────
console.log('\n[11] real game worker (dist build)')
{
  let workerEntryUrl: URL | null = null
  try {
    workerEntryUrl = await resolveGameWorkerEntryUrl()
  } catch (error) {
    check('compiled worker available (run npm run build)', false, (error as Error).message)
  }
  if (workerEntryUrl !== null) {
    const timings: Array<[number, GameWorkerTickBatchTiming]> = []
    const pool = createGameWorkerPool({
      workerCount: 2,
      maxRoomsPerWorker: 10,
      workerEntryUrl,
      onTickBatchTiming: (index, timing) => { timings.push([index, timing]) },
    })
    await pool.start()
    const rooms = ['e2e-room-1', 'e2e-room-2', 'e2e-room-3'].map(makeRoom)
    for (const room of rooms) pool.ensureRoom(room.id)
    const now = Date.now() + 30_000
    let results: GameWorkerTickRoomResult[] = []
    for (let attempt = 0; attempt < 50; attempt += 1) {
      results = await pool.computeTickRooms(rooms.map((room) => ({ roomId: room.id, baseRevision: 1, room })), now, SERVER_ANTI_BAD_LUCK_DEFAULT_CONFIG)
      if (results.every((result) => result.result !== 'error')) break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    // advance ползва Math.random (раздаване) → сравняваме структурата, не байтовете.
    const shape = (list: GameWorkerTickRoomResult[]) => list.map((result) => [
      result.roomId, result.baseRevision, result.result,
      result.result === 'advanced' ? resolveGameWorkerRoomPhaseLabel(result.room) : null,
    ])
    const expected: GameWorkerTickRoomResult[] = rooms.map((room) => {
      const next = advanceRoomAuthoritativeGame(room, now, SERVER_ANTI_BAD_LUCK_DEFAULT_CONFIG)
      return next === room ? { roomId: room.id, baseRevision: 1, result: 'unchanged' } : { roomId: room.id, baseRevision: 1, result: 'advanced', room: next }
    })
    check('worker results match in-process compute (order, ids, revisions, outcome, phase)',
      JSON.stringify(shape(results)) === JSON.stringify(shape(expected)), JSON.stringify(shape(results)) + ' vs ' + JSON.stringify(shape(expected)))
    check('no diagnostics field leaks into results', results.every((result) => !('diagnostics' in result)))
    const completedTimings = timings.filter(([, timing]) => timing.outcome === 'completed')
    const lastBatch = completedTimings.slice(-2)
    check('timings reported per worker index (0/1)', lastBatch.length >= 1 && lastBatch.every(([index]) => index === 0 || index === 1))
    const withDiag = completedTimings.map(([, timing]) => timing).filter((timing) => timing.outcome === 'completed' && timing.diagnostics !== null)
    check('real worker sends valid diagnostics', withDiag.length > 0)
    check('round trip >= worker wall (no clock sync needed)', withDiag.every((timing) => timing.outcome === 'completed' && timing.diagnostics !== null &&
      timing.roundTripWallMs >= timing.diagnostics.batchWallMs))
    check('worker thread CPU measured (Node threadCpuUsage)', withDiag.every((timing) => timing.outcome === 'completed' && typeof timing.diagnostics?.batchCpuMs === 'number'))
    check('room counts match batch sizes', withDiag.every((timing) => timing.outcome === 'completed' && timing.diagnostics?.roomCount === timing.roomCount))
    await pool.shutdown()
  }
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed > 0 ? 1 : 0
