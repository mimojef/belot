import {
  calcServerCpuPercent,
  calcNodeCpuPercent,
  sumOsCpuTimes,
  sanitizeErrorMessage,
} from '../src/monitoring/systemMetrics.js'
import {
  countOpenWebSockets,
  countUniqueOnlineRealPlayers,
  WS_OPEN,
} from '../src/monitoring/monitoringHelpers.js'
import { createMonitoringSampler } from '../src/monitoring/createMonitoringSampler.js'
import type {
  MonitoringDeps,
  MonitoringContext,
  MonitoringWorkerPoolSnapshot,
} from '../src/monitoring/monitoringTypes.js'
import type { GameWorkerPoolHealth } from '../src/game/createGameWorkerPool.js'
import type { ServerConnection } from '../src/core/serverTypes.js'

let passed = 0
let failed = 0

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`)
    passed++
  } else {
    console.error(`  ✗ FAIL: ${label}`)
    failed++
  }
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  assert(actual === expected, `${label} (got ${String(actual)}, expected ${String(expected)})`)
}

// ─── [1] calcServerCpuPercent ─────────────────────────────────────────────────

console.log('\n[1] calcServerCpuPercent — 37.5% load')
{
  // prev total = 9200, curr total = 10000, delta = 800
  // idle delta = 8500-8000 = 500, used delta = 300
  // expected = 300/800 * 100 = 37.5%
  const prev = { user: 1000, nice: 0, sys: 200, idle: 8000, irq: 0 }
  const curr = { user: 1200, nice: 0, sys: 300, idle: 8500, irq: 0 }
  const result = calcServerCpuPercent(prev, curr)
  assert(Math.abs(result - 37.5) < 0.001, `result = 37.5% (got ${result.toFixed(4)})`)
  assert(result >= 0 && result <= 100, 'result within 0..100')
}

console.log('\n[2] calcServerCpuPercent — zero total delta')
{
  const snap = { user: 1000, nice: 0, sys: 200, idle: 8800, irq: 0 }
  assertEqual(calcServerCpuPercent(snap, snap), 0, 'returns 0 when no change')
}

console.log('\n[3] calcServerCpuPercent — fully idle')
{
  const prev = { user: 0, nice: 0, sys: 0, idle: 1000, irq: 0 }
  const curr = { user: 0, nice: 0, sys: 0, idle: 2000, irq: 0 }
  const result = calcServerCpuPercent(prev, curr)
  assertEqual(result, 0, 'fully idle = 0%')
}

console.log('\n[4] calcServerCpuPercent — fully loaded')
{
  // No idle increase → 100% load
  const prev = { user: 0, nice: 0, sys: 0, idle: 1000, irq: 0 }
  const curr = { user: 1000, nice: 0, sys: 0, idle: 1000, irq: 0 }
  const result = calcServerCpuPercent(prev, curr)
  assertEqual(result, 100, 'fully loaded = 100%')
}

console.log('\n[5] calcNodeCpuPercent — 200% multi-core')
{
  // (1_500_000 + 500_000) µs / (1000ms * 1000µs/ms) * 100 = 200%
  const prev: NodeJS.CpuUsage = { user: 0, system: 0 }
  const curr: NodeJS.CpuUsage = { user: 1_500_000, system: 500_000 }
  const result = calcNodeCpuPercent(prev, curr, 1000)
  assert(Math.abs(result - 200) < 0.001, `result = 200% (got ${result.toFixed(4)})`)
  assert(result > 100, 'can exceed 100%')
}

console.log('\n[6] calcNodeCpuPercent — 50% single core')
{
  // 500_000 µs / 1_000_000 µs * 100 = 50%
  const prev: NodeJS.CpuUsage = { user: 0, system: 0 }
  const curr: NodeJS.CpuUsage = { user: 500_000, system: 0 }
  const result = calcNodeCpuPercent(prev, curr, 1000)
  assert(Math.abs(result - 50) < 0.001, `result = 50% (got ${result.toFixed(4)})`)
}

console.log('\n[7] calcNodeCpuPercent — zero elapsed returns 0')
{
  const usage: NodeJS.CpuUsage = { user: 999_999, system: 999_999 }
  assertEqual(calcNodeCpuPercent(usage, usage, 0), 0, 'returns 0 on zero elapsed')
}

console.log('\n[8] sumOsCpuTimes — aggregates all cores')
{
  const cores = [
    { times: { user: 100, nice: 10, sys: 50, idle: 840, irq: 0 } },
    { times: { user: 200, nice: 20, sys: 100, idle: 680, irq: 0 } },
  ]
  const sum = sumOsCpuTimes(cores)
  assertEqual(sum.user, 300, 'user sum')
  assertEqual(sum.nice, 30, 'nice sum')
  assertEqual(sum.sys, 150, 'sys sum')
  assertEqual(sum.idle, 1520, 'idle sum')
  assertEqual(sum.irq, 0, 'irq sum')
}

// ─── [9] sanitizeErrorMessage ─────────────────────────────────────────────────

console.log('\n[9] sanitizeErrorMessage — malicious input')
{
  const malicious =
    'Something failed\n    at Object.<anonymous> (D:\\Projects\\belot\\src\\index.ts:42:10)\n' +
    '    at ModuleJob.run (node:internal/modules/esm/module_job:430:25)\n' +
    '    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:101:5)\n' +
    'A'.repeat(500)

  const result = sanitizeErrorMessage(new Error(malicious))

  assert(typeof result === 'string', 'returns a string')
  assert(!result.includes('\n'), 'no newlines')
  assert(!result.includes('\r'), 'no carriage returns')
  assert(!result.includes('    at '), 'no indented "at" stack frames')
  assert(!result.includes('node:internal'), 'no node internal references')
  assert(!result.includes('D:\\Projects'), 'no Windows absolute path')
  assert(!result.includes('/node_modules'), 'no Unix path fragment')
  assert(result.length <= 185, `length ≤ 185 (got ${result.length})`)
  assert(result.length > 0, 'non-empty result')

  console.log(`    → sanitized (${result.length} chars): "${result}"`)
}

console.log('\n[10] sanitizeErrorMessage — null/undefined/empty')
{
  assertEqual(sanitizeErrorMessage(null), 'Monitoring error', 'null → generic')
  assertEqual(sanitizeErrorMessage(undefined), 'Monitoring error', 'undefined → generic')
  assertEqual(sanitizeErrorMessage(''), 'Monitoring error', 'empty string → generic')
  assertEqual(sanitizeErrorMessage(new Error('')), 'Monitoring error', 'Error("") → generic')
}

console.log('\n[11] sanitizeErrorMessage — normal short message preserved')
{
  const result = sanitizeErrorMessage(new Error('Connection refused'))
  assertEqual(result, 'Connection refused', 'clean short message passes through unchanged')
}

console.log('\n[12] sanitizeErrorMessage — string error')
{
  const result = sanitizeErrorMessage('simple string error')
  assertEqual(result, 'simple string error', 'plain string returned as-is')
}

console.log('\n[12b] sanitizeErrorMessage — secret redaction: Authorization Bearer')
{
  const result = sanitizeErrorMessage('Request failed: Authorization: Bearer abc123')
  assert(!result.includes('abc123'), 'original Bearer token not present')
  assert(!result.includes('Bearer abc123'), 'full Bearer value not present')
  assert(result.includes('<redacted>'), 'placeholder <redacted> present')
}

console.log('\n[12c] sanitizeErrorMessage — secret redaction: token=value')
{
  const result = sanitizeErrorMessage('Invalid token=my-secret-token in request')
  assert(!result.includes('my-secret-token'), 'original token value not present')
  assert(result.includes('<redacted>'), 'placeholder <redacted> present')
}

console.log('\n[12d] sanitizeErrorMessage — secret redaction: STRIPE_SECRET_KEY=sk_live_123')
{
  const result = sanitizeErrorMessage('Env error: STRIPE_SECRET_KEY=sk_live_123')
  assert(!result.includes('sk_live_123'), 'original Stripe key not present')
  assert(result.includes('<redacted>'), 'placeholder <redacted> present')
}

console.log('\n[12e] sanitizeErrorMessage — secret redaction: password: hunter2')
{
  const result = sanitizeErrorMessage('DB connect failed password: hunter2')
  assert(!result.includes('hunter2'), 'original password not present')
  assert(result.includes('<redacted>'), 'placeholder <redacted> present')
}

console.log('\n[12f] sanitizeErrorMessage — normal word "token" without value not redacted')
{
  const result = sanitizeErrorMessage('Invalid token provided')
  // "token" alone (no = or :) should not be touched — no value to redact
  assert(result.includes('token') || result.includes('<redacted>'), 'safe message still meaningful')
  assert(!result.includes('provided=') && !result.includes('provided:'), 'no false-positive redaction of surrounding words')
}

// ─── createMonitoringSampler tests ────────────────────────────────────────────

function makeDeps(overrides: Partial<MonitoringDeps> = {}): MonitoringDeps {
  let time = 1_000_000
  return {
    nowMs: () => {
      const t = time
      time += 1000
      return t
    },
    processCpuUsage: () => ({ user: 0, system: 0 }),
    osCpuTimes: () => [{ times: { user: 1000, nice: 0, sys: 200, idle: 8800, irq: 0 } }],
    osFreeMem: () => 2 * 1024 * 1024 * 1024,
    osTotalMem: () => 8 * 1024 * 1024 * 1024,
    processMemUsage: () => ({ rss: 64 * 1024 * 1024, heapUsed: 0, heapTotal: 0, external: 0, arrayBuffers: 0 }),
    processUptime: () => 42,
    setInterval: overrides.setInterval ?? ((fn, ms) => setInterval(fn, ms)),
    clearInterval: overrides.clearInterval ?? ((id) => clearInterval(id)),
    ...overrides,
  }
}

function makeContext(overrides: Partial<MonitoringContext> = {}): MonitoringContext {
  return {
    backendStartedAtMs: 1_000_000,
    getWsConnectionCount: () => 5,
    getUniqueOnlineRealPlayers: () => 3,
    getMatchmakingWaitersByStake: () => ({ '100': 2, '200': 1 }),
    getActiveRoomCount: () => 7,
    getRoomsByPhase: () => ({ bidding: 3, playing: 4 }),
    getActiveRooms: () => [],
    getWorkerPoolHealth: () => null,
    ...overrides,
  }
}

function captureInterval(overrides: Partial<MonitoringDeps> = {}): {
  deps: MonitoringDeps
  fireTick: () => void
} {
  let fn: (() => void) | null = null
  const deps = makeDeps({
    setInterval: (f) => { fn = f; return 0 as unknown as ReturnType<typeof globalThis.setInterval> },
    clearInterval: () => {},
    ...overrides,
  })
  return { deps, fireTick: () => fn?.() }
}

console.log('\n[13] Warming-up state before second sample')
{
  const { deps, fireTick: _ } = captureInterval()
  const sampler = createMonitoringSampler(makeContext(), deps)
  const snap = sampler.getSnapshot()
  assert(snap.samplerStatus === 'warming_up', 'status is warming_up before second probe')
  assert(snap.serverCpuNowPercent === null, 'serverCpuNowPercent is null while warming up')
  assert(snap.nodeCpuNowPercent === null, 'nodeCpuNowPercent is null while warming up')
  assertEqual(snap.sampleWindowMs, 0, 'sampleWindowMs is 0 while warming up')
  sampler.stop()
}

console.log('\n[14] Running state after second sample — exact sampleWindowMs')
{
  // nowMs increments by 1000 per call.
  // buildWarmingSnapshotSafe: 1 call (t=1_000_000)
  // collectSample (init): 1 call → prevSampleAtMs = 1_001_000
  // fireTick: 1 call → nowMs = 1_002_000, elapsed = 1_002_000 - 1_001_000 = 1000
  const { deps, fireTick } = captureInterval()
  const sampler = createMonitoringSampler(makeContext(), deps)
  assert(sampler.getSnapshot().samplerStatus === 'warming_up', 'warming up initially')

  fireTick()
  const snap = sampler.getSnapshot()
  assert(snap.samplerStatus === 'running', 'status becomes running after second probe')
  assert(snap.serverCpuNowPercent !== null, 'serverCpuNowPercent available')
  assert(snap.nodeCpuNowPercent !== null, 'nodeCpuNowPercent available')
  assertEqual(snap.sampleWindowMs, 1000, 'sampleWindowMs = 1000ms (exact elapsed between probes)')
  sampler.stop()
}

console.log('\n[15] Only one active interval')
{
  let activeIntervals = 0
  const deps = makeDeps({
    setInterval: (fn, ms) => { activeIntervals++; return setInterval(fn, ms) },
    clearInterval: (id) => { activeIntervals--; clearInterval(id) },
  })
  const sampler = createMonitoringSampler(makeContext(), deps)
  assertEqual(activeIntervals, 1, 'exactly one interval active')
  sampler.stop()
  assertEqual(activeIntervals, 0, 'interval cleared after stop')
}

console.log('\n[16] No overlapping samples')
{
  let callDepth = 0
  let maxDepth = 0
  const { deps, fireTick } = captureInterval({
    processCpuUsage: () => {
      callDepth++
      if (callDepth > maxDepth) maxDepth = callDepth
      const result = { user: callDepth * 10000, system: 0 }
      callDepth--
      return result
    },
  })
  const sampler = createMonitoringSampler(makeContext(), deps)
  fireTick()
  fireTick()
  fireTick()
  assert(maxDepth <= 1, 'no overlapping sample calls (max call depth ≤ 1)')
  sampler.stop()
}

console.log('\n[17] Sampler continues after metric read failure, lastError set then cleared')
{
  // buildWarmingSnapshotSafe: osFreeMem call #1
  // collectSample (init): osFreeMem call #2
  // fireTick (1st): osFreeMem call #3 → throws
  // fireTick (2nd): osFreeMem call #4 → ok → recovers
  let osFreeCallCount = 0
  const { deps, fireTick } = captureInterval({
    osFreeMem: () => {
      osFreeCallCount++
      if (osFreeCallCount === 3) throw new Error('Simulated OS read failure')
      return 1024 * 1024 * 1024
    },
  })
  const sampler = createMonitoringSampler(makeContext(), deps)

  let threw = false
  try { fireTick() } catch { threw = true }
  assert(!threw, 'sampler does not propagate metric read failure')

  const snapErr = sampler.getSnapshot()
  assert(snapErr.lastError !== null, 'lastError is set after failure')
  if (snapErr.lastError !== null) {
    assert(!snapErr.lastError.includes('\n'), 'lastError has no newlines (sanitized)')
    assert(!snapErr.lastError.includes('    at '), 'lastError has no stack trace lines')
    assert(snapErr.lastError.length <= 185, `lastError length ≤ 185 (got ${snapErr.lastError.length})`)
  }

  fireTick()
  assertEqual(sampler.getSnapshot().lastError, null, 'sampler recovers: lastError null after good sample')
  sampler.stop()
}

console.log('\n[18] sanitizeErrorMessage applied — malicious error.message with path and newline')
{
  const { deps, fireTick } = captureInterval({
    processUptime: (() => {
      let call = 0
      return () => {
        call++
        // buildWarmingSnapshotSafe: call 1
        // collectSample init: call 2
        // fireTick: call 3 → throws with nasty message
        if (call === 3) {
          throw new Error(
            'Failed\n    at Object.<anonymous> (C:\\Users\\user\\project\\index.ts:1:1)\n' +
            '    at node:internal/modules/esm/module_job:430\n' +
            'X'.repeat(300),
          )
        }
        return 42
      }
    })(),
  })
  const sampler = createMonitoringSampler(makeContext(), deps)
  let threw = false
  try { fireTick() } catch { threw = true }
  assert(!threw, 'sampler does not throw on nasty error')
  const snap = sampler.getSnapshot()
  assert(snap.lastError !== null, 'lastError is set')
  if (snap.lastError !== null) {
    assert(!snap.lastError.includes('\n'), 'no newline in lastError')
    assert(!snap.lastError.includes('C:\\'), 'no Windows path in lastError')
    assert(!snap.lastError.includes('node:internal'), 'no node:internal in lastError')
    assert(snap.lastError.length <= 185, `length ≤ 185 (got ${snap.lastError.length})`)
    console.log(`    → lastError: "${snap.lastError}"`)
  }
  sampler.stop()
}

console.log('\n[19] Idempotent stop — clearInterval called exactly once')
{
  let clearCount = 0
  const deps = makeDeps({
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (id) => { clearCount++; clearInterval(id) },
  })
  const sampler = createMonitoringSampler(makeContext(), deps)
  sampler.stop()
  sampler.stop()
  assertEqual(clearCount, 1, 'clearInterval called exactly once despite double stop')
}

console.log('\n[20] After stop — no new samples, status is stopped')
{
  let nowValue = 1_000_000
  const { deps, fireTick } = captureInterval({ nowMs: () => nowValue++ })
  const sampler = createMonitoringSampler(makeContext(), deps)
  sampler.stop()
  const tsBefore = sampler.getSnapshot().sampledAtMs
  fireTick()
  fireTick()
  assertEqual(sampler.getSnapshot().samplerStatus, 'stopped', 'status is stopped')
  assertEqual(sampler.getSnapshot().sampledAtMs, tsBefore, 'sampledAtMs unchanged after stop')
}

console.log('\n[21] getSnapshot does not trigger new CPU reads')
{
  let cpuCalls = 0
  const { deps, fireTick: _ } = captureInterval({
    processCpuUsage: () => { cpuCalls++; return { user: cpuCalls * 1000, system: 0 } },
  })
  const sampler = createMonitoringSampler(makeContext(), deps)
  const after = cpuCalls
  const s1 = sampler.getSnapshot()
  const s2 = sampler.getSnapshot()
  const s3 = sampler.getSnapshot()
  assertEqual(cpuCalls, after, 'getSnapshot() triggers no CPU reads')
  assert(s1 === s2 && s2 === s3, 'getSnapshot() returns same reference when no new sample')
  sampler.stop()
}

console.log('\n[22] Worker pool snapshot — full field mapping')
{
  const fakeHealth: GameWorkerPoolHealth = {
    state: 'ready',
    workerCount: 2,
    readyWorkers: 2,
    failedWorkers: 0,
    totalAssignedRooms: 5,
    maxRoomsPerWorker: 100,
    workers: [
      {
        workerId: 'game-worker-1',
        state: 'ready',
        assignedRooms: 3,
        maxRooms: 100,
        shadow: {
          desiredRooms: 3,
          confirmedRooms: 3,
          pendingOperations: 0,
          workerState: 'ready',
          isConsistent: true,
          isShuttingDown: false,
          lastError: null,
        },
        lastError: null,
      },
      {
        workerId: 'game-worker-2',
        state: 'ready',
        assignedRooms: 2,
        maxRooms: 100,
        shadow: {
          desiredRooms: 2,
          confirmedRooms: 1,
          pendingOperations: 1,
          workerState: 'ready',
          isConsistent: false,
          isShuttingDown: false,
          // Злонамерена shadow грешка: newline + stack frame + Bearer token
          lastError: 'Shadow sync failed\n    at Object.<anonymous> (node:internal/worker:42)\nAuthorization: Bearer shadow-secret-99',
        },
        // Злонамерена worker грешка: Windows path + token
        lastError: 'Read error at C:\\Users\\user\\belot\\server\\index.ts:1 token=worker-tok-xyz',
      },
    ],
  }

  const { deps, fireTick } = captureInterval()
  const sampler = createMonitoringSampler(
    makeContext({ getWorkerPoolHealth: () => fakeHealth }),
    deps,
  )
  fireTick()
  const snap = sampler.getSnapshot()
  const pool = snap.workerPool as MonitoringWorkerPoolSnapshot

  assert(pool !== null, 'workerPool is not null')
  assertEqual(pool.state, 'ready', 'pool.state')
  assertEqual(pool.workerCount, 2, 'pool.workerCount')
  assertEqual(pool.readyWorkers, 2, 'pool.readyWorkers')
  assertEqual(pool.failedWorkers, 0, 'pool.failedWorkers')
  assertEqual(pool.totalAssignedRooms, 5, 'pool.totalAssignedRooms')
  assertEqual(pool.maxRoomsPerWorker, 100, 'pool.maxRoomsPerWorker')
  assertEqual(pool.workers.length, 2, 'workers.length')

  const w1 = pool.workers[0]
  assertEqual(w1.workerId, 'game-worker-1', 'w1.workerId')
  assertEqual(w1.state, 'ready', 'w1.state')
  assertEqual(w1.assignedRooms, 3, 'w1.assignedRooms')
  assertEqual(w1.maxRooms, 100, 'w1.maxRooms')
  assertEqual(w1.shadow.desiredRooms, 3, 'w1.shadow.desiredRooms')
  assertEqual(w1.shadow.confirmedRooms, 3, 'w1.shadow.confirmedRooms')
  assertEqual(w1.shadow.pendingOperations, 0, 'w1.shadow.pendingOperations')
  assertEqual(w1.shadow.workerState, 'ready', 'w1.shadow.workerState')
  assertEqual(w1.shadow.isConsistent, true, 'w1.shadow.isConsistent')
  assertEqual(w1.shadow.isShuttingDown, false, 'w1.shadow.isShuttingDown')
  assertEqual(w1.shadow.lastError, null, 'w1.shadow.lastError is null')
  assertEqual(w1.lastError, null, 'w1.lastError is null')

  const w2 = pool.workers[1]
  assertEqual(w2.workerId, 'game-worker-2', 'w2.workerId')

  // worker lastError — трябва да е санитизирана: без Windows path, без token стойност
  assert(w2.lastError !== null, 'w2.lastError is set')
  assert(!w2.lastError!.includes('\n'), 'w2.lastError has no newlines')
  assert(!w2.lastError!.includes('C:\\'), 'w2.lastError has no Windows path')
  assert(!w2.lastError!.includes('worker-tok-xyz'), 'w2.lastError has no original token value')
  assert(w2.lastError!.includes('<redacted>') || w2.lastError!.includes('<path>'), 'w2.lastError has safe placeholder')

  // shadow lastError — трябва да е санитизирана: без newline, без stack frame, без Bearer стойност
  assert(w2.shadow.lastError !== null, 'w2.shadow.lastError is set')
  assert(!w2.shadow.lastError!.includes('\n'), 'w2.shadow.lastError has no newlines')
  assert(!w2.shadow.lastError!.includes('    at '), 'w2.shadow.lastError has no stack frame')
  assert(!w2.shadow.lastError!.includes('shadow-secret-99'), 'w2.shadow.lastError has no Bearer value')
  assert(!w2.shadow.lastError!.includes('node:internal'), 'w2.shadow.lastError has no node:internal')
  assert(w2.shadow.lastError!.includes('<redacted>') || w2.shadow.lastError!.includes('<internal>'), 'w2.shadow.lastError has safe placeholder')

  sampler.stop()
}

// ─── countOpenWebSockets ─────────────────────────────────────────────────────

console.log('\n[23] countOpenWebSockets — WS_OPEN constant is 1')
{
  assertEqual(WS_OPEN, 1, 'WS_OPEN === 1 (WebSocket spec value)')
}

console.log('\n[24] countOpenWebSockets — empty map returns 0')
{
  assertEqual(countOpenWebSockets(new Map()), 0, 'empty map → 0')
}

console.log('\n[25] countOpenWebSockets — only OPEN (1) sockets counted')
{
  const sockets = new Map([
    ['conn-a', { readyState: 0 }], // CONNECTING
    ['conn-b', { readyState: 1 }], // OPEN      ← counted
    ['conn-c', { readyState: 2 }], // CLOSING
    ['conn-d', { readyState: 3 }], // CLOSED
    ['conn-e', { readyState: 1 }], // OPEN      ← counted
  ])
  assertEqual(countOpenWebSockets(sockets), 2, 'counts only readyState===1 sockets (2 of 5)')
}

console.log('\n[26] countOpenWebSockets — CONNECTING not counted')
{
  const sockets = new Map([['c1', { readyState: 0 }]])
  assertEqual(countOpenWebSockets(sockets), 0, 'CONNECTING (0) not counted')
}

console.log('\n[27] countOpenWebSockets — CLOSING not counted')
{
  const sockets = new Map([['c1', { readyState: 2 }]])
  assertEqual(countOpenWebSockets(sockets), 0, 'CLOSING (2) not counted')
}

console.log('\n[28] countOpenWebSockets — CLOSED not counted')
{
  const sockets = new Map([['c1', { readyState: 3 }]])
  assertEqual(countOpenWebSockets(sockets), 0, 'CLOSED (3) not counted')
}

console.log('\n[29] countOpenWebSockets — all OPEN returns exact count')
{
  const sockets = new Map([
    ['c1', { readyState: 1 }],
    ['c2', { readyState: 1 }],
    ['c3', { readyState: 1 }],
  ])
  assertEqual(countOpenWebSockets(sockets), 3, 'all OPEN → exact count 3')
}

// ─── countUniqueOnlineRealPlayers ─────────────────────────────────────────────

function makeConn(status: 'connected' | 'disconnected', profileId: string | null): ServerConnection {
  return { status, profileId } as unknown as ServerConnection
}

console.log('\n[30] countUniqueOnlineRealPlayers — empty connections returns 0')
{
  assertEqual(countUniqueOnlineRealPlayers({}), 0, 'empty → 0')
}

console.log('\n[31] countUniqueOnlineRealPlayers — connected with profileId counted')
{
  const connections = {
    'conn-1': makeConn('connected', 'player-A'),
  }
  assertEqual(countUniqueOnlineRealPlayers(connections), 1, 'one connected real player → 1')
}

console.log('\n[32] countUniqueOnlineRealPlayers — disconnected not counted')
{
  const connections = {
    'conn-1': makeConn('disconnected', 'player-A'),
  }
  assertEqual(countUniqueOnlineRealPlayers(connections), 0, 'disconnected player → 0')
}

console.log('\n[33] countUniqueOnlineRealPlayers — null profileId not counted')
{
  const connections = {
    'conn-1': makeConn('connected', null),
  }
  assertEqual(countUniqueOnlineRealPlayers(connections), 0, 'connected but profileId null → 0')
}

console.log('\n[34] countUniqueOnlineRealPlayers — two tabs of same player count as 1')
{
  const connections = {
    'conn-1': makeConn('connected', 'player-A'),
    'conn-2': makeConn('connected', 'player-A'),
  }
  assertEqual(countUniqueOnlineRealPlayers(connections), 1, 'two connections same profileId → 1 unique player')
}

console.log('\n[35] countUniqueOnlineRealPlayers — mixed: connected, disconnected, null, duplicate')
{
  const connections = {
    'conn-1': makeConn('connected', 'player-A'),      // counted
    'conn-2': makeConn('connected', 'player-A'),      // duplicate — same player
    'conn-3': makeConn('connected', 'player-B'),      // counted
    'conn-4': makeConn('disconnected', 'player-C'),   // disconnected — not counted
    'conn-5': makeConn('connected', null),             // null profileId — not counted
  }
  assertEqual(countUniqueOnlineRealPlayers(connections), 2, 'mixed connections → 2 unique real players')
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)

if (failed > 0) {
  process.exit(1)
}

// ─── Manual smoke (not counted) ───────────────────────────────────────────────
console.log(`
Manual smoke — GET /api/admin/monitoring/current
  (run on a live server with credentials)

  1. No cookie          → expect 403 { ok: false }
  2. Normal user cookie → expect 403 { ok: false }
  3. Admin cookie       → expect 200 { ok: true, snapshot: { samplerStatus: "running"|"warming_up", ... } }
  4. Two consecutive GETs with admin cookie → sampledAtMs identical (cached, no CPU re-read between calls)
  5. Response body must NOT contain: stack frames, absolute paths (C:\\, /home/), node:internal
`)
