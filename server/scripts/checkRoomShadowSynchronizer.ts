/**
 * checkRoomShadowSynchronizer.ts — deterministic tests за bounded retry в
 * createRoomShadowSynchronizer (fix за shadow convergence след timeout на
 * assign_room/release_room ACK, виж audit на fe8694b).
 *
 * Fake lifecycle client (контролирани ACK/timeout) + fake timers. Успех се
 * проверява ВИНАГИ чрез desiredRooms === confirmedRooms (+ isConsistent), не
 * чрез pendingOperations === 0.
 *
 *  [1]  normal assign
 *  [2]  assign timeout → retry → success
 *  [3]  първият assign стига до worker-а, ACK се губи → retry → already_assigned
 *  [4]  3 неуспешни retries → bounded stop + diagnostics
 *  [5]  desired се маха по време на backoff → стар assign НЕ се изпраща
 *  [6]  release timeout → retry → success (waiter изчаква)
 *  [7]  късен assign ACK след desire=false → стаята не остава confirmed
 *  [8]  assign/release crossing
 *  [9]  duplicate desire не създава duplicate timers/операции
 *  [10] shutdown чисти retry timer-ите
 *  [11] pendingOperations == 0 не е достатъчно (desired != confirmed)
 *  [12] lastError семантика: несвързан успех не скрива неразрешена грешка
 *  [13] worker non-ready → без retry timers
 *  [14] реален pool: main thread блокиран > 5000 ms след assign → convergence чрез retry
 *  [15] exhausted стая + повторен pool.ensureRoom → нов bounded цикъл, същият worker
 *  [16] normal path: повторен ensureRoom (pool и runtime) на converged стая е no-op
 *  [17] exhausted re-arm burst (100× runtime.ensureRoom) се обединява в една bounded верига
 */

import {
  createRoomShadowSynchronizer,
  type RoomShadowSynchronizer,
  type RoomShadowWorkerClient,
} from '../src/game/createRoomShadowSynchronizer.js'
import { createGameWorkerPool } from '../src/game/createGameWorkerPool.js'
import { resolveGameWorkerEntryUrl } from '../src/game/resolveGameWorkerEntryUrl.js'
import { SERVER_ANTI_BAD_LUCK_DEFAULT_CONFIG } from '../src/game/antiBadLuck/serverAntiBadLuckTypes.js'
import type { GameWorkerLifecycleState } from '../src/game/createGameWorkerLifecycleClient.js'
import { createWorkerBackedActiveRoomRuntime } from '../src/game/createWorkerBackedActiveRoomRuntime.js'
import { GAME_WORKER_PROTOCOL_VERSION } from '../src/game/workerProtocol.js'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

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

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve()
}

type Call = {
  action: 'assign' | 'release'
  roomId: string
  ack: (result?: string) => void
  timeout: () => void
  settled: boolean
}

function createHarness(retryDelaysMs?: readonly number[]) {
  const calls: Call[] = []
  const workerRooms = new Set<string>()
  let state: GameWorkerLifecycleState = 'ready'
  let inFlight = 0
  let maxInFlightPerRoom = 0
  const inFlightByRoom = new Map<string, number>()

  const client: RoomShadowWorkerClient = {
    getState: () => state,
    assignRoom: (roomId) => track('assign', roomId),
    releaseRoom: (roomId) => track('release', roomId),
  } as RoomShadowWorkerClient

  function track(action: 'assign' | 'release', roomId: string): Promise<never> {
    inFlight += 1
    const count = (inFlightByRoom.get(roomId) ?? 0) + 1
    inFlightByRoom.set(roomId, count)
    maxInFlightPerRoom = Math.max(maxInFlightPerRoom, count)
    return new Promise((resolve, reject) => {
      const call: Call = {
        action,
        roomId,
        settled: false,
        ack: (result) => {
          if (call.settled) return
          call.settled = true
          done(roomId)
          resolve({ type: `${action}_room_ack`, roomId, result: result ?? (action === 'assign' ? 'assigned' : 'released') } as never)
        },
        timeout: () => {
          if (call.settled) return
          call.settled = true
          done(roomId)
          reject(new Error(`[lifecycle-client] Request ${action}-${roomId} timed out after 5000ms`))
        },
      }
      calls.push(call)
    })
  }

  function done(roomId: string): void {
    inFlight -= 1
    inFlightByRoom.set(roomId, (inFlightByRoom.get(roomId) ?? 1) - 1)
  }

  // Worker-side ефект: изпълнява заявката в "worker-а" (идемпотентно), после ACK.
  function deliver(call: Call): void {
    if (call.action === 'assign') {
      const already = workerRooms.has(call.roomId)
      workerRooms.add(call.roomId)
      call.ack(already ? 'already_assigned' : 'assigned')
    } else {
      const was = workerRooms.delete(call.roomId)
      call.ack(was ? 'released' : 'not_assigned')
    }
  }

  // Worker-ът изпълнява заявката, но ACK-ът "изтича" (lifecycle го игнорира).
  function deliverButTimeout(call: Call): void {
    if (call.action === 'assign') workerRooms.add(call.roomId)
    else workerRooms.delete(call.roomId)
    call.timeout()
  }

  type FakeTimer = { callback: () => void; delayMs: number; cancelled: boolean; fired: boolean }
  const timers: FakeTimer[] = []
  const sync = createRoomShadowSynchronizer({
    client,
    ...(retryDelaysMs !== undefined ? { retryDelaysMs } : {}),
    setTimer: (callback, delayMs) => {
      const timer: FakeTimer = { callback, delayMs, cancelled: false, fired: false }
      timers.push(timer)
      return timer as unknown as ReturnType<typeof setTimeout>
    },
    clearTimer: (handle) => {
      (handle as unknown as FakeTimer).cancelled = true
    },
  })

  function activeTimers(): FakeTimer[] {
    return timers.filter((timer) => !timer.cancelled && !timer.fired)
  }

  async function fireTimers(): Promise<number> {
    const due = activeTimers()
    for (const timer of due) {
      timer.fired = true
      timer.callback()
    }
    await flush()
    return due.length
  }

  return {
    sync,
    calls,
    workerRooms,
    timers,
    activeTimers,
    fireTimers,
    deliver,
    deliverButTimeout,
    setState: (next: GameWorkerLifecycleState) => { state = next },
    lastCall: () => calls[calls.length - 1]!,
    pendingCalls: () => calls.filter((call) => !call.settled),
    get maxInFlightPerRoom() { return maxInFlightPerRoom },
    get inFlight() { return inFlight },
  }
}

function converged(sync: RoomShadowSynchronizer): boolean {
  const health = sync.getHealth()
  return health.desiredRooms === health.confirmedRooms && health.isConsistent
}

// ─── [1] normal assign ───────────────────────────────────────────────────────
console.log('\n[1] normal assign')
{
  const h = createHarness()
  h.sync.desireRoom('r1')
  await flush()
  check('one assign sent', h.calls.length === 1 && h.lastCall().action === 'assign')
  h.deliver(h.lastCall())
  await flush()
  const health = h.sync.getHealth()
  check('desired == confirmed == 1, consistent', health.desiredRooms === 1 && health.confirmedRooms === 1 && health.isConsistent)
  check('no retries/failures', health.assignRetryCount === 0 && health.assignFailureCount === 0 && health.scheduledRetries === 0)
  check('no timers created on normal path', h.timers.length === 0)
}

// ─── [2] assign timeout → retry → success ────────────────────────────────────
console.log('\n[2] assign timeout -> retry -> success')
{
  const h = createHarness()
  h.sync.desireRoom('r1')
  await flush()
  h.lastCall().timeout()
  await flush()
  let health = h.sync.getHealth()
  check('failure counted, retry scheduled at 1000ms', health.assignFailureCount === 1 && health.scheduledRetries === 1 && h.timers[0]?.delayMs === 1000)
  check('not consistent while retry pending', !health.isConsistent && health.pendingOperations === 0)
  check('lastError visible', health.lastError?.includes('timed out') === true)
  await h.fireTimers()
  check('retry sends assign', h.calls.length === 2 && h.lastCall().action === 'assign')
  h.deliver(h.lastCall())
  await flush()
  health = h.sync.getHealth()
  check('converged after retry', converged(h.sync) && health.assignRetryCount === 1)
  check('lastError cleared once THIS room converged', health.lastError === null)
}

// ─── [3] lost ACK → retry → already_assigned ─────────────────────────────────
console.log('\n[3] first assign reaches worker, ACK lost, retry gets already_assigned')
{
  const h = createHarness()
  h.sync.desireRoom('r1')
  await flush()
  h.deliverButTimeout(h.lastCall())
  await flush()
  check('worker already has the room, shadow does not', h.workerRooms.has('r1') && h.sync.getHealth().confirmedRooms === 0)
  await h.fireTimers()
  h.deliver(h.lastCall())
  await flush()
  check('retry converges via idempotent already_assigned', converged(h.sync) && h.workerRooms.size === 1)
}

// ─── [4] retries exhausted ───────────────────────────────────────────────────
console.log('\n[4] all 3 retries fail -> bounded stop')
{
  const h = createHarness()
  h.sync.desireRoom('r1')
  await flush()
  h.lastCall().timeout()
  await flush()
  for (let i = 0; i < 3; i += 1) {
    await h.fireTimers()
    h.lastCall().timeout()
    await flush()
  }
  const health = h.sync.getHealth()
  check('backoff 1000/2000/4000', JSON.stringify(h.timers.map((timer) => timer.delayMs)) === '[1000,2000,4000]')
  check('exactly 1 + 3 attempts', h.calls.length === 4, String(h.calls.length))
  check('retriesExhaustedCount = 1, no timers left', health.retriesExhaustedCount === 1 && health.scheduledRetries === 0 && h.activeTimers().length === 0)
  check('failures 4, retries 3', health.assignFailureCount === 4 && health.assignRetryCount === 3)
  check('unresolved error kept', health.lastError !== null)
  await h.fireTimers()
  check('no further attempts after exhaustion', h.calls.length === 4)
  h.sync.desireRoom('r1')
  await flush()
  check('new external desire starts a fresh cycle', h.calls.length === 5 && h.lastCall().action === 'assign')
  h.deliver(h.lastCall())
  await flush()
  check('fresh cycle converges', converged(h.sync))
}

// ─── [5] desired removed during backoff ──────────────────────────────────────
console.log('\n[5] desired removed during assign backoff')
{
  const h = createHarness()
  h.sync.desireRoom('r1')
  await flush()
  h.deliverButTimeout(h.lastCall()) // worker може да има стаята
  await flush()
  h.sync.forgetRoom('r1')
  await flush()
  check('forget during backoff sends nothing immediately', h.calls.length === 1)
  await h.fireTimers()
  check('stale assign NOT sent; cleanup release sent instead', h.calls.length === 2 && h.lastCall().action === 'release')
  h.deliver(h.lastCall())
  await flush()
  check('worker no longer has the room, shadow converged', !h.workerRooms.has('r1') && converged(h.sync) && h.sync.getHealth().desiredRooms === 0)
  check('assign never re-sent', h.calls.filter((call) => call.action === 'assign').length === 1)
}

// ─── [6] release timeout → retry → success ───────────────────────────────────
console.log('\n[6] release timeout -> retry -> success')
{
  const h = createHarness()
  h.sync.desireRoom('r1')
  await flush()
  h.deliver(h.lastCall())
  await flush()
  let resolved = false
  let rejected = false
  const waiting = h.sync.forgetRoomAndWait('r1').then(() => { resolved = true }, () => { rejected = true })
  await flush()
  h.lastCall().timeout()
  await flush()
  check('waiter still waiting during release backoff', !resolved && !rejected && h.sync.getHealth().releaseFailureCount === 1)
  await h.fireTimers()
  check('retry sends release', h.lastCall().action === 'release' && h.calls.length === 3)
  h.deliver(h.lastCall())
  await waiting
  check('waiter resolves after retry success', resolved && !rejected)
  check('converged, releaseRetryCount = 1', converged(h.sync) && h.sync.getHealth().confirmedRooms === 0 && h.sync.getHealth().releaseRetryCount === 1)
}

// ─── [7] late assign ACK after desire=false ──────────────────────────────────
console.log('\n[7] late assign ACK after desire=false')
{
  const h = createHarness()
  h.sync.desireRoom('r1')
  await flush()
  const assign = h.lastCall()
  h.sync.forgetRoom('r1')
  await flush()
  check('no second op while assign in flight', h.calls.length === 1)
  h.deliver(assign) // късен ACK
  await flush()
  check('follow-up release sent', h.calls.length === 2 && h.lastCall().action === 'release')
  h.deliver(h.lastCall())
  await flush()
  const health = h.sync.getHealth()
  check('room not left confirmed', health.confirmedRooms === 0 && health.desiredRooms === 0 && converged(h.sync) && !h.workerRooms.has('r1'))
}

// ─── [8] assign/release crossing ─────────────────────────────────────────────
console.log('\n[8] assign/release crossing')
{
  const h = createHarness()
  h.sync.desireRoom('r1')
  await flush()
  const firstAssign = h.lastCall()
  h.sync.forgetRoom('r1')
  h.deliver(firstAssign)
  await flush()
  const release = h.lastCall()
  check('release follows assign', release.action === 'release')
  h.sync.desireRoom('r1') // отново desired, докато release е in flight
  await flush()
  check('no concurrent op for the room', h.calls.length === 2)
  h.deliver(release)
  await flush()
  check('re-assign after release completes', h.calls.length === 3 && h.lastCall().action === 'assign')
  h.deliver(h.lastCall())
  await flush()
  check('final state desired == confirmed', converged(h.sync) && h.workerRooms.has('r1'))
  check('never more than one in-flight op per room', h.maxInFlightPerRoom === 1)
}

// ─── [9] duplicate desire ────────────────────────────────────────────────────
console.log('\n[9] duplicate desire does not duplicate timers/ops')
{
  const h = createHarness()
  for (let i = 0; i < 5; i += 1) h.sync.desireRoom('r1')
  await flush()
  check('one assign for 5 desires', h.calls.length === 1)
  h.lastCall().timeout()
  await flush()
  for (let i = 0; i < 5; i += 1) h.sync.desireRoom('r1')
  await flush()
  check('one timer, no extra ops during backoff', h.timers.length === 1 && h.calls.length === 1 && h.sync.getHealth().scheduledRetries === 1)
  await h.fireTimers()
  h.deliver(h.lastCall())
  await flush()
  check('converged with single retry', converged(h.sync) && h.calls.length === 2)
}

// ─── [10] shutdown clears retry timers ───────────────────────────────────────
console.log('\n[10] shutdown clears retry timers')
{
  const h = createHarness()
  h.sync.desireRoom('r1')
  h.sync.desireRoom('r2')
  await flush()
  for (const call of h.pendingCalls()) call.timeout()
  await flush()
  check('two timers scheduled', h.activeTimers().length === 2)
  await h.sync.shutdown()
  check('all retry timers cleared on shutdown', h.activeTimers().length === 0 && h.timers.every((timer) => timer.cancelled))
  for (const timer of h.timers) timer.callback() // дори ако callback-ът все пак се изпълни
  await flush()
  check('no operation after shutdown', h.calls.length === 2)
}

// ─── [11] pendingOperations == 0 is not success ──────────────────────────────
console.log('\n[11] pendingOperations == 0 is not sufficient')
{
  const h = createHarness([])
  h.sync.desireRoom('r1')
  await flush()
  h.lastCall().timeout()
  await flush()
  const health = h.sync.getHealth()
  check('pending == 0 but desired != confirmed', health.pendingOperations === 0 && health.desiredRooms === 1 && health.confirmedRooms === 0)
  check('reported as NOT consistent', !health.isConsistent && !converged(h.sync))
}

// ─── [12] lastError semantics ────────────────────────────────────────────────
console.log('\n[12] lastError not hidden by unrelated success')
{
  const h = createHarness([])
  h.sync.desireRoom('bad')
  await flush()
  h.lastCall().timeout()
  await flush()
  h.sync.desireRoom('good')
  await flush()
  h.deliver(h.lastCall())
  await flush()
  check('unrelated success keeps unresolved error', h.sync.getHealth().lastError?.includes('bad') === true)
  h.sync.forgetRoom('bad')
  await flush()
  const cleanup = h.lastCall()
  check('forgotten uncertain room gets idempotent cleanup release', cleanup.action === 'release' && cleanup.roomId === 'bad')
  h.deliver(cleanup)
  await flush()
  check('error cleared when that room converges', h.sync.getHealth().lastError === null && converged(h.sync))
}

// ─── [13] worker non-ready ───────────────────────────────────────────────────
console.log('\n[13] worker non-ready -> no retry timers')
{
  const h = createHarness()
  h.sync.desireRoom('r1')
  await flush()
  h.lastCall().timeout()
  await flush()
  h.setState('failed')
  await h.fireTimers()
  const health = h.sync.getHealth()
  check('no op sent to dead worker', h.calls.length === 1)
  check('no further timers, error recorded', h.activeTimers().length === 0 && health.lastError?.includes('worker state=failed') === true)
}

// ─── [14] real pool regression ───────────────────────────────────────────────
console.log('\n[14] real pool: main thread blocked > 5000ms after assign')
{
  const workerEntryUrl = await resolveGameWorkerEntryUrl()
  const pool = createGameWorkerPool({ workerCount: 4, maxRoomsPerWorker: 50, workerEntryUrl, requestTimeoutMs: 5000 })
  await pool.start()
  const roomIds = Array.from({ length: 11 }, (_, index) => `regression-room-${index}`)
  for (const roomId of roomIds) pool.ensureRoom(roomId)
  await Promise.resolve()
  const blockUntil = performance.now() + 6000
  while (performance.now() < blockUntil) { /* блокира main event loop */ }
  await new Promise((resolve) => setTimeout(resolve, 50))
  const before = pool.getHealth()
  const failuresBefore = before.workers.reduce((sum, worker) => sum + worker.shadow.assignFailureCount, 0)
  check('reproduces timeouts (some assigns failed)', failuresBefore > 0, String(failuresBefore))
  const deadline = Date.now() + 4000
  while (Date.now() < deadline && !pool.getHealth().workers.every((worker) => worker.shadow.desiredRooms === worker.shadow.confirmedRooms && worker.shadow.isConsistent)) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  const after = pool.getHealth()
  check('every worker converged desired == confirmed via retry', after.workers.every((worker) => worker.shadow.desiredRooms === worker.shadow.confirmedRooms && worker.shadow.isConsistent),
    after.workers.map((worker) => `${worker.shadow.desiredRooms}/${worker.shadow.confirmedRooms}`).join(' '))
  check('retries were used, none exhausted', after.workers.reduce((sum, worker) => sum + worker.shadow.assignRetryCount, 0) > 0 &&
    after.workers.every((worker) => worker.shadow.retriesExhaustedCount === 0))
  check('no room released/finished to converge', after.totalAssignedRooms === 11)
  check('lastError cleared after convergence', after.workers.every((worker) => worker.shadow.lastError === null))
  const results = await pool.computeTickRooms(
    roomIds.map((roomId) => ({ roomId, baseRevision: 1, room: { id: roomId, game: { authoritativeState: null } } as never })),
    Date.now(),
    SERVER_ANTI_BAD_LUCK_DEFAULT_CONFIG,
  )
  check('ticks unaffected (all unchanged, none not_assigned)', results.every((result) => result.result === 'unchanged'))
  await pool.shutdown()
}

// ─── Fake worker за pool-level тестове ───────────────────────────────────────
// 'drop-acks': изпълнява assign_room (стаята е при worker-а), но НЕ праща ACK
// за първите DROP_ACKS assign-а на стая — симулира изгубени/закъснели ACK-ове.
const DROP_ACKS = 4
async function writeFakeWorker(mode: 'normal' | 'drop-acks', dropAcks: number = DROP_ACKS) {
  const dir = await mkdtemp(join(tmpdir(), 'belot-shadow-sync-'))
  const file = join(dir, 'fakeWorker.mjs')
  const eventFile = join(dir, 'events.log')
  await writeFile(file, `
import { appendFileSync } from 'node:fs'
import { parentPort, workerData } from 'node:worker_threads'
const mode = ${JSON.stringify(mode)}
const eventFile = ${JSON.stringify(eventFile)}
const workerId = workerData.workerId
const startedAt = Date.now()
const roomIds = new Set()
const assignsByRoom = new Map()
const send = (message) => parentPort.postMessage(message)
parentPort.on('message', (message) => {
  if (message.type === 'assign_room') {
    const count = (assignsByRoom.get(message.roomId) ?? 0) + 1
    assignsByRoom.set(message.roomId, count)
    appendFileSync(eventFile, 'assign:' + workerId + ':' + message.roomId + '\\n')
    const already = roomIds.has(message.roomId)
    roomIds.add(message.roomId)
    if (mode === 'drop-acks' && count <= ${dropAcks}) return
    send({ type: 'assign_room_ack', requestId: message.requestId, roomId: message.roomId, result: already ? 'already_assigned' : 'assigned', activeRooms: roomIds.size })
    return
  }
  if (message.type === 'release_room') {
    appendFileSync(eventFile, 'release:' + workerId + ':' + message.roomId + '\\n')
    const was = roomIds.delete(message.roomId)
    send({ type: 'release_room_ack', requestId: message.requestId, roomId: message.roomId, result: was ? 'released' : 'not_assigned', activeRooms: roomIds.size })
    return
  }
  if (message.type === 'shutdown') {
    send({ type: 'shutdown_complete', requestId: message.requestId })
    parentPort.close()
  }
})
send({ type: 'ready', workerId, protocolVersion: ${GAME_WORKER_PROTOCOL_VERSION}, startedAt })
`, 'utf8')
  return {
    url: pathToFileURL(file),
    events: async () => (await readFile(eventFile, 'utf8').catch(() => '')).split('\n').filter(Boolean),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

async function waitUntil(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return condition()
}

function workerShadow(pool: ReturnType<typeof createGameWorkerPool>, workerId: string) {
  return pool.getHealth().workers.find((worker) => worker.workerId === workerId)!.shadow
}

// ─── [15] exhausted room re-armed by pool.ensureRoom ─────────────────────────
console.log('\n[15] exhausted room re-armed by pool.ensureRoom (same worker)')
{
  const worker = await writeFakeWorker('drop-acks')
  const pool = createGameWorkerPool({ workerCount: 2, maxRoomsPerWorker: 10, workerEntryUrl: worker.url, requestTimeoutMs: 100 })
  await pool.start()
  const roomId = 'rearm-room'
  const first = pool.ensureRoom(roomId)
  const ownerBefore = first.ok ? first.workerId : null
  // 1 + 3 retries (1000/2000/4000 ms backoff), всички без ACK.
  const exhausted = await waitUntil(() => ownerBefore !== null && workerShadow(pool, ownerBefore).retriesExhaustedCount === 1, 12_000)
  let shadow = workerShadow(pool, ownerBefore!)
  check('A: all retries exhausted (4 assigns, no ACK)', exhausted && shadow.assignFailureCount === 4 && shadow.assignRetryCount === 3, JSON.stringify(shadow))
  check('A: desired != confirmed, no timers left', shadow.desiredRooms === 1 && shadow.confirmedRooms === 0 && shadow.scheduledRetries === 0)
  check('B: room still assigned to the same worker', pool.getWorkerIdForRoom(roomId) === ownerBefore)
  const again = pool.ensureRoom(roomId)
  check('C: ensureRoom returns existing assignment (not newly assigned)', again.ok && !again.newlyAssigned && again.workerId === ownerBefore)
  const reconverged = await waitUntil(() => {
    const current = workerShadow(pool, ownerBefore!)
    return current.desiredRooms === current.confirmedRooms && current.isConsistent
  }, 3000)
  shadow = workerShadow(pool, ownerBefore!)
  const assigns = (await worker.events()).filter((event) => event.startsWith('assign:'))
  check('D: new bounded cycle started (5th assign sent)', assigns.length === 5, String(assigns.length))
  check('E: after ACK desired == confirmed', reconverged && shadow.confirmedRooms === 1)
  check('F: ownership unchanged, all assigns to the same worker', pool.getWorkerIdForRoom(roomId) === ownerBefore &&
    assigns.every((event) => event === `assign:${ownerBefore}:${roomId}`))
  check('lastError cleared after this room converged', pool.getHealth().workers.every((w) => w.shadow.lastError === null))
  await pool.shutdown()
  await worker.cleanup()
}

// ─── [16] repeated ensureRoom on converged room is a no-op ───────────────────
console.log('\n[16] normal path: repeated ensureRoom on converged room')
{
  const worker = await writeFakeWorker('normal')
  const pool = createGameWorkerPool({ workerCount: 2, maxRoomsPerWorker: 10, workerEntryUrl: worker.url, requestTimeoutMs: 5000 })
  await pool.start()
  const owner = pool.ensureRoom('steady-room')
  const ownerId = owner.ok ? owner.workerId : ''
  await waitUntil(() => workerShadow(pool, ownerId).isConsistent && workerShadow(pool, ownerId).confirmedRooms === 1, 3000)
  for (let i = 0; i < 50; i += 1) pool.ensureRoom('steady-room')
  await new Promise((resolve) => setTimeout(resolve, 100))
  const shadow = workerShadow(pool, ownerId)
  const assigns = (await worker.events()).filter((event) => event.startsWith('assign:'))
  check('no extra assign sent for 50 repeated ensureRoom calls', assigns.length === 1, String(assigns.length))
  check('no retry timers, no failure/retry counters', shadow.scheduledRetries === 0 && shadow.assignRetryCount === 0 && shadow.assignFailureCount === 0 &&
    shadow.releaseRetryCount === 0 && shadow.releaseFailureCount === 0 && shadow.retriesExhaustedCount === 0)
  check('still converged, same owner', shadow.isConsistent && pool.getWorkerIdForRoom('steady-room') === ownerId)

  // Runtime wiring: съществуващ assignment → runtime.ensureRoom достига pool-а.
  const delegateRooms = new Set<string>()
  const runtime = createWorkerBackedActiveRoomRuntime({
    workerManager: {
      ensureRoom: (roomId) => { const result = pool.ensureRoom(roomId); return result.ok ? result.workerId : null },
      getWorkerIdForRoom: (roomId) => pool.getWorkerIdForRoom(roomId),
      removeRoom: (roomId) => { void pool.releaseRoom(roomId).catch(() => {}) },
      getWorkers: () => [],
      getHealth: () => ({ configuredWorkers: 2, readyWorkers: 2, totalActiveRooms: 0, workers: [] }),
    },
    delegate: {
      ensureRoom: (room: { id: string }) => { delegateRooms.add(room.id); return { ok: true } },
      removeRoom: (roomId: string) => { delegateRooms.delete(roomId) },
      hasRoom: (roomId: string) => delegateRooms.has(roomId),
    } as never,
  })
  const room = { id: 'steady-room' } as never
  for (let i = 0; i < 20; i += 1) runtime.ensureRoom(room)
  await new Promise((resolve) => setTimeout(resolve, 100))
  const runtimeAssigns = (await worker.events()).filter((event) => event.startsWith('assign:'))
  check('runtime re-assert on converged room sends nothing', runtimeAssigns.length === 1 && workerShadow(pool, ownerId).isConsistent)
  await pool.shutdown()
  await worker.cleanup()
}

// ─── [17] exhausted re-arm burst is coalesced ────────────────────────────────
console.log('\n[17] exhausted re-arm burst is coalesced')
{
  // 4 изпуснати ACK-а до Exhausted + 1 изпуснат в новия цикъл; 6-ият assign получава ACK.
  const worker = await writeFakeWorker('drop-acks', 5)
  const pool = createGameWorkerPool({ workerCount: 2, maxRoomsPerWorker: 10, workerEntryUrl: worker.url, requestTimeoutMs: 100 })
  await pool.start()
  const delegateRooms = new Set<string>()
  // Production-еквивалентен път: runtime → adapter-подобен worker manager → pool.
  const runtime = createWorkerBackedActiveRoomRuntime({
    workerManager: {
      ensureRoom: (roomId) => { const result = pool.ensureRoom(roomId); return result.ok ? result.workerId : null },
      getWorkerIdForRoom: (roomId) => pool.getWorkerIdForRoom(roomId),
      removeRoom: (roomId) => { void pool.releaseRoom(roomId).catch(() => {}) },
      getWorkers: () => [],
      getHealth: () => ({ configuredWorkers: 2, readyWorkers: 2, totalActiveRooms: 0, workers: [] }),
    },
    delegate: {
      ensureRoom: (room: { id: string }) => { delegateRooms.add(room.id); return { ok: true } },
      removeRoom: (roomId: string) => { delegateRooms.delete(roomId) },
      hasRoom: (roomId: string) => delegateRooms.has(roomId),
    } as never,
  })
  const roomId = 'burst-room'
  const room = { id: roomId } as never
  check('initial runtime.ensureRoom ok', runtime.ensureRoom(room).ok)
  const ownerId = pool.getWorkerIdForRoom(roomId)!
  const assignEvents = async () => (await worker.events()).filter((event) => event.startsWith('assign:'))

  // 1–2. Exhausted след initial + 3 retries.
  const exhausted = await waitUntil(() => workerShadow(pool, ownerId).retriesExhaustedCount === 1, 12_000)
  let shadow = workerShadow(pool, ownerId)
  check('exhausted: retriesExhaustedCount == 1', exhausted && shadow.retriesExhaustedCount === 1, JSON.stringify(shadow))
  check('exhausted: no pending operation, no retry timer', shadow.pendingOperations === 0 && shadow.scheduledRetries === 0)
  check('exhausted: 4 assigns sent, ownership unchanged', (await assignEvents()).length === 4 && pool.getWorkerIdForRoom(roomId) === ownerId)
  const retriesBefore = shadow.assignRetryCount
  const failuresBefore = shadow.assignFailureCount

  // 3. Burst: 100 последователни runtime.ensureRoom.
  for (let i = 0; i < 100; i += 1) runtime.ensureRoom(room)
  shadow = workerShadow(pool, ownerId)
  check('burst: exactly one in-flight op, no timer', shadow.pendingOperations === 1 && shadow.scheduledRetries === 0, JSON.stringify(shadow))
  await new Promise((resolve) => setTimeout(resolve, 40)) // < 100 ms timeout
  check('burst: exactly ONE new assign_room (not 100)', (await assignEvents()).length === 5, String((await assignEvents()).length))
  check('burst: ownership unchanged', pool.getWorkerIdForRoom(roomId) === ownerId)

  // 5–6. Новият цикъл fail-ва веднъж, после една retry верига до ACK.
  let maxPending = 0
  let maxTimers = 0
  const reconverged = await waitUntil(() => {
    const current = workerShadow(pool, ownerId)
    maxPending = Math.max(maxPending, current.pendingOperations)
    maxTimers = Math.max(maxTimers, current.scheduledRetries)
    return current.desiredRooms === current.confirmedRooms && current.isConsistent
  }, 4000)
  shadow = workerShadow(pool, ownerId)
  const finalAssigns = await assignEvents()
  check('new cycle: at most 1 in-flight op and 1 retry timer at any sample', maxPending <= 1 && maxTimers <= 1, `pending=${maxPending} timers=${maxTimers}`)
  check('new cycle: single bounded chain (+1 failure, +1 retry)', shadow.assignFailureCount === failuresBefore + 1 && shadow.assignRetryCount === retriesBefore + 1,
    `failures ${failuresBefore}->${shadow.assignFailureCount}, retries ${retriesBefore}->${shadow.assignRetryCount}`)
  check('after ACK: desired == confirmed, isConsistent, no timers', reconverged && shadow.desiredRooms === 1 && shadow.confirmedRooms === 1 &&
    shadow.isConsistent && shadow.scheduledRetries === 0)
  await new Promise((resolve) => setTimeout(resolve, 1500)) // повече от 1-вия backoff: нищо "закъсняло" от burst-а
  const settledAssigns = await assignEvents()
  check('no extra operations from the burst (6 assigns total, still 6 later)', finalAssigns.length === 6 && settledAssigns.length === 6,
    `${finalAssigns.length} / ${settledAssigns.length}`)
  check('ownership unchanged, all assigns to the same worker', pool.getWorkerIdForRoom(roomId) === ownerId &&
    settledAssigns.every((event) => event === `assign:${ownerId}:${roomId}`))
  check('still consistent, retriesExhaustedCount unchanged', workerShadow(pool, ownerId).isConsistent && workerShadow(pool, ownerId).retriesExhaustedCount === 1)
  await pool.shutdown()
  await worker.cleanup()
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed > 0 ? 1 : 0
