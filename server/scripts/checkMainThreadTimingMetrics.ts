/**
 * checkMainThreadTimingMetrics.ts
 *
 * Детерминирани проверки за Phase 0B main-thread timing instrumentation:
 *  [1] stat агрегиране и slow buckets (>=50/100/250/500, кумулативни)
 *  [2] bounded labels: невалидни/raw стойности, overflow, непозната група
 *  [3] dual-window reset семантика (1s и 10s независими, sparse snapshot)
 *  [4] time/timeAsync/timeSyncAndAsync: резултат, exceptions, rejection semantics
 *  [5] timing hook exception safety
 *  [6] HTTP route family (classifyHttpRoute) и WS (resolveWsTimingLabel) класификация
 *  [7] human gameplay фази с фалшив часовник (recordSince)
 *  [8] broadcastRoomSnapshots: build/stringify/send/spectator/total timings и
 *      непроменен изход (същите bytes, ред, monitoring hook-ове)
 *  [9] Belot hand journal: observe/derive/flush/serialize/write timings
 * [10] spike/bucket интеграция: snapshot-ът влиза в activity и минава JSON
 * [11] HTTP active vs wall: body/io wait НЕ се брои като active; union на waits
 * [12] sync / HTTP active wall / async wall: разделени групи и 3 отделни UI секции
 * [13] таймери: private-room expiry, Svara clock, monitoring sampler, journal maintenance
 * [14] bounded HTTP route labels: без IDs/query/raw URL, фиксиран набор, drift guard
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import {
  MAIN_THREAD_TIMING_GROUPS,
  MAX_LABELS_PER_GROUP,
  INVALID_LABEL,
  OVERFLOW_LABEL,
  createMainThreadTimingMetrics,
  resolveWsTimingLabel,
  safeInvokeTimingHook,
  type MainThreadTimingSnapshot,
} from '../src/monitoring/mainThreadTimingMetrics.js'
import { classifyHttpRoute } from '../src/monitoring/httpRouteClassifier.js'
import { createActivityCounters } from '../src/monitoring/activityCounters.js'
import {
  broadcastRoomSnapshots,
  setBroadcastRoomSnapshotsMonitoringHook,
  setBroadcastRoomSnapshotsSpectatorHook,
  setBroadcastRoomSnapshotsTimingHook,
} from '../src/core/broadcastRoomSnapshots.js'
import { setSendJsonMessageMonitoringHook } from '../src/core/sendJsonMessage.js'
import { createServerRoom } from '../src/core/createServerRoom.js'
import { createHumanParticipant } from '../src/core/createHumanParticipant.js'
import { createBotParticipant } from '../src/core/createBotParticipant.js'
import { seatParticipantInRoom } from '../src/core/seatParticipantInRoom.js'
import { SERVER_SEAT_ORDER, type ConnectionId, type ServerRoom } from '../src/core/serverTypes.js'
import { createRoomSnapshotMessage } from '../src/protocol/createRoomSnapshotMessage.js'
import { initializeRoomAuthoritativeGameState } from '../src/game/initializeRoomAuthoritativeGameState.js'
import { advanceRoomAuthoritativeGame } from '../src/game/advanceRoomAuthoritativeGame.js'
import { SERVER_ANTI_BAD_LUCK_DEFAULT_CONFIG } from '../src/game/antiBadLuck/serverAntiBadLuckTypes.js'
import { createBelotHandJournalStore } from '../src/diagnostics/belotHandJournal/belotHandJournalStore.js'
import { createBelotHandJournal } from '../src/diagnostics/belotHandJournal/createBelotHandJournal.js'
import { createServer, request as httpRequest, type IncomingMessage } from 'node:http'
import { readFileSync } from 'node:fs'
import {
  MAIN_THREAD_SYNC_TIMING_GROUPS,
  MAIN_THREAD_HTTP_ACTIVE_TIMING_GROUPS,
  MAIN_THREAD_WALL_TIMING_GROUPS,
  isMainThreadWallTimingGroup,
} from '../src/monitoring/mainThreadTimingMetrics.js'
import { beginHttpWait, endHttpWait, timeHttpRequest, trackHttpWait } from '../src/monitoring/httpRequestTiming.js'
import { HTTP_ROUTE_TEMPLATES, httpRouteTemplateToLabel } from '../src/monitoring/httpRouteClassifier.js'
import { createPrivateRoomsStore } from '../src/game/privateRoomsStore.js'
import { createSvaraRealClock } from '../src/games/svara/runtime/createSvaraLifecycle.js'
import { createMonitoringSampler } from '../src/monitoring/createMonitoringSampler.js'
import { getMainThreadTimingSection, summarizeMainThreadTimings } from '../../src/app/adminServer/renderAdminCpuIncidents.js'
import {
  MAIN_THREAD_HTTP_ACTIVE_TIMING_GROUPS as CLIENT_HTTP_ACTIVE_GROUPS,
  MAIN_THREAD_WALL_TIMING_GROUPS as CLIENT_WALL_GROUPS,
} from '../../src/app/adminServer/adminServerTypes.js'

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
  return { now: () => value, set: (next: number) => { value = next }, advance: (ms: number) => { value += ms } }
}

const SAFE_KEY = /^[A-Za-z0-9_.:-]{1,64}$/

function allKeysBounded(snapshot: MainThreadTimingSnapshot): boolean {
  for (const [group, labels] of Object.entries(snapshot)) {
    if (!(MAIN_THREAD_TIMING_GROUPS as readonly string[]).includes(group)) return false
    for (const label of Object.keys(labels ?? {})) if (!SAFE_KEY.test(label)) return false
  }
  return true
}

// ─── [1] aggregation + slow buckets ──────────────────────────────────────────
console.log('\n[1] aggregation and slow buckets')
{
  const metrics = createMainThreadTimingMetrics()
  for (const duration of [10, 49.999, 50, 99.9, 100, 250, 499, 500, 1200]) metrics.record('http', 'auth', duration)
  const stat = metrics.peek().http?.auth
  check('count', stat?.count === 9, String(stat?.count))
  check('total', Math.abs((stat?.totalDurationMs ?? 0) - 2758.899) < 1e-6, String(stat?.totalDurationMs))
  check('max', stat?.maxDurationMs === 1200)
  check('slow50 counts >=50 (7)', stat?.slow50 === 7, String(stat?.slow50))
  check('slow100 counts >=100 (5)', stat?.slow100 === 5, String(stat?.slow100))
  check('slow250 counts >=250 (4)', stat?.slow250 === 4, String(stat?.slow250))
  check('slow500 counts >=500 (2)', stat?.slow500 === 2, String(stat?.slow500))
}

// ─── [2] bounded labels ──────────────────────────────────────────────────────
console.log('\n[2] bounded labels')
{
  const metrics = createMainThreadTimingMetrics()
  metrics.record('http', '/api/profiles/123?token=abc', 5)
  metrics.record('ws', 'send to user@example.com', 5)
  metrics.record('ws', '', 5)
  metrics.record('ws', 'x'.repeat(65), 5)
  metrics.record('not_a_group' as never, 'x', 5)
  metrics.record('http', 'auth', Number.NaN)
  metrics.record('http', 'auth', -1)
  const snap = metrics.peek()
  check('raw URL becomes invalid_label', snap.http?.[INVALID_LABEL]?.count === 1)
  check('email-like / empty / too long become invalid_label', snap.ws?.[INVALID_LABEL]?.count === 3)
  check('unknown group ignored', !('not_a_group' in snap))
  check('NaN/negative durations ignored', snap.http?.auth === undefined)
  for (let i = 0; i < MAX_LABELS_PER_GROUP + 20; i += 1) metrics.record('job', `job_${i}`, 1)
  const jobs = metrics.peek().job ?? {}
  check(`at most ${MAX_LABELS_PER_GROUP} distinct labels + overflow`, Object.keys(jobs).length === MAX_LABELS_PER_GROUP, String(Object.keys(jobs).length))
  check('overflow aggregated in "other"', (jobs[OVERFLOW_LABEL]?.count ?? 0) >= 20, String(jobs[OVERFLOW_LABEL]?.count))
  check('all snapshot keys bounded', allKeysBounded(metrics.peek()))
}

// ─── [3] window semantics ────────────────────────────────────────────────────
console.log('\n[3] dual-window semantics')
{
  const metrics = createMainThreadTimingMetrics()
  metrics.record('http', 'topics', 10)
  const firstSecond = metrics.snapshotOneSecondAndReset()
  metrics.record('http', 'topics', 20)
  const secondSecond = metrics.snapshotOneSecondAndReset()
  const emptySecond = metrics.snapshotOneSecondAndReset()
  const tenSecond = metrics.snapshotTenSecondAndReset()
  check('1s window holds only its own events', firstSecond.http?.topics?.totalDurationMs === 10 && secondSecond.http?.topics?.totalDurationMs === 20)
  check('1s window empty after reset (sparse)', Object.keys(emptySecond).length === 0)
  check('10s window independent of 1s resets', tenSecond.http?.topics?.count === 2 && tenSecond.http?.topics?.totalDurationMs === 30)
  check('10s window empty after its reset', Object.keys(metrics.snapshotTenSecondAndReset()).length === 0)
  const snap = metrics.peek()
  snap.http = { mutated: { count: 99, totalDurationMs: 0, maxDurationMs: 0, slow50: 0, slow100: 0, slow250: 0, slow500: 0 } }
  check('snapshot is a copy (mutation does not leak)', metrics.peek().http === undefined)
}

// ─── [4] time / timeAsync / timeSyncAndAsync ─────────────────────────────────
console.log('\n[4] time helpers')
{
  const clock = fakeClock()
  const metrics = createMainThreadTimingMetrics(clock.now)
  const value = metrics.time('commit', 'persist', () => { clock.advance(7); return 'r' })
  check('time returns fn result', value === 'r')
  check('time records duration', metrics.peek().commit?.persist?.totalDurationMs === 7)
  let threw = false
  try {
    metrics.time('commit', 'persist', () => { clock.advance(3); throw new Error('boom') })
  } catch (error) {
    threw = (error as Error).message === 'boom'
  }
  check('time rethrows and still records', threw && metrics.peek().commit?.persist?.count === 2)

  const original = Promise.resolve(42)
  const returned = metrics.timeAsync('http', 'health', () => original)
  check('timeAsync returns the ORIGINAL promise', returned === original)
  await returned
  await Promise.resolve()
  check('timeAsync records after settle', metrics.peek().http?.health?.count === 1)

  const rejecting = Promise.reject(new Error('handler failed'))
  const observed = metrics.timeAsync('http', 'auth', () => rejecting)
  let callerSaw = false
  await observed.catch(() => { callerSaw = true })
  await Promise.resolve()
  check('timeAsync: caller still observes rejection', callerSaw)
  check('timeAsync: rejected request recorded', metrics.peek().http?.auth?.count === 1)

  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
  process.on('unhandledRejection', onUnhandled)
  metrics.timeSyncAndAsync('job', 'jobAsync', 'syncOnly', () => { clock.advance(2) })
  check('timeSyncAndAsync records sync part', metrics.peek().job?.syncOnly?.totalDurationMs === 2)
  check('timeSyncAndAsync: no async record for non-promise', metrics.peek().jobAsync?.syncOnly === undefined)
  metrics.timeSyncAndAsync('job', 'jobAsync', 'asyncOk', () => Promise.resolve('done'))
  const jobError = new Error('job failed')
  metrics.timeSyncAndAsync('job', 'jobAsync', 'asyncFail', () => Promise.reject(jobError))
  await new Promise((resolve) => setTimeout(resolve, 20))
  process.off('unhandledRejection', onUnhandled)
  check('timeSyncAndAsync records async wall on resolve', metrics.peek().jobAsync?.asyncOk?.count === 1)
  check('timeSyncAndAsync records async wall on reject', metrics.peek().jobAsync?.asyncFail?.count === 1)
  check('unobserved job rejection still surfaces exactly once (not swallowed)', unhandled.length === 1 && unhandled[0] === jobError, String(unhandled.length))
}

// ─── [5] hook exception safety ───────────────────────────────────────────────
console.log('\n[5] hook exception safety')
{
  let didThrow = false
  try {
    safeInvokeTimingHook(() => { throw new Error('hook') }, 'x', 1)
    safeInvokeTimingHook(null, 'x', 1)
    safeInvokeTimingHook(undefined, 'x', 1)
  } catch {
    didThrow = true
  }
  check('throwing/missing hook never propagates', !didThrow)
}

// ─── [6] HTTP / WS classification ────────────────────────────────────────────
console.log('\n[6] HTTP and WS classification')
{
  const cases: Array<[string | undefined, string | undefined, string]> = [
    ['POST', '/api/auth/login?next=/x', 'POST.auth.login'],
    ['GET', '/api/topics/abc-123/messages', 'GET.topics._.messages'],
    ['GET', '/api/daily-rewards', 'GET.daily-rewards'],
    ['GET', '/api/tournaments/550e8400-e29b-41d4-a716-446655440000', 'GET.tournaments._'],
    ['GET', '/api/support/messages', 'GET.support.messages'],
    ['GET', '/health', 'GET.health'],
    ['GET', '/api/admin/monitoring/cpu-incidents', 'GET.admin.monitoring.cpu-incidents'],
    ['GET', '/totally/unknown?x=1', 'GET.other.other'],
    [undefined, undefined, 'OTHER.other.other'],
  ]
  for (const [method, url, expected] of cases) {
    const label = classifyHttpRoute(method, url)
    check(`HTTP ${String(method)} ${String(url)} -> ${expected}`, label === expected, label)
  }
  check('WS parsed submit_play_card', resolveWsTimingLabel({ type: 'submit_play_card' }) === 'submit_play_card')
  check('WS parsed svara message type', resolveWsTimingLabel({ type: 'submit_svara_command' }) === 'submit_svara_command')
  check('WS unparsed -> invalid', resolveWsTimingLabel(null) === 'invalid')
  check('WS non-string type -> invalid', resolveWsTimingLabel({ type: 42 }) === 'invalid')
  check('WS odd type string -> invalid_label', resolveWsTimingLabel({ type: '../../etc' }) === INVALID_LABEL)
}

// ─── [7] gameplay phases (fake clock) ────────────────────────────────────────
console.log('\n[7] human gameplay phase timing')
{
  const clock = fakeClock(1000)
  const metrics = createMainThreadTimingMetrics(clock.now)
  const order: string[] = []
  // Огледало на submit_play_card handler-а: фазите се изпълняват в същия ред,
  // recordSince само чете часовника между тях.
  let phaseAt = metrics.now()
  order.push('compute'); clock.advance(3)
  phaseAt = metrics.recordSince('gameplay', 'play.compute', phaseAt)
  order.push('audit'); clock.advance(1)
  phaseAt = metrics.recordSince('gameplay', 'play.audit', phaseAt)
  order.push('commit'); clock.advance(12)
  phaseAt = metrics.recordSince('gameplay', 'play.commit', phaseAt)
  order.push('ensureRoom'); clock.advance(0.5)
  phaseAt = metrics.recordSince('gameplay', 'play.ensureRoom', phaseAt)
  order.push('broadcast'); clock.advance(4)
  phaseAt = metrics.recordSince('gameplay', 'play.broadcast', phaseAt)
  order.push('post'); clock.advance(2)
  metrics.recordSince('gameplay', 'play.post', phaseAt)
  const g = metrics.peek().gameplay ?? {}
  check('phase durations', g['play.compute']?.totalDurationMs === 3 && g['play.audit']?.totalDurationMs === 1 &&
    g['play.commit']?.totalDurationMs === 12 && g['play.ensureRoom']?.totalDurationMs === 0.5 &&
    g['play.broadcast']?.totalDurationMs === 4 && g['play.post']?.totalDurationMs === 2, JSON.stringify(g))
  const sum = Object.values(g).reduce((total, stat) => total + stat.totalDurationMs, 0)
  check('phases sum to handler total (22.5ms)', sum === 22.5, String(sum))
  check('execution order untouched', order.join(',') === 'compute,audit,commit,ensureRoom,broadcast,post')
}

// ─── [8] broadcastRoomSnapshots ──────────────────────────────────────────────
console.log('\n[8] room snapshot broadcast timings')
{
  let room: ServerRoom = createServerRoom({ roomId: 'timing-room', config: { allowBots: true, isPrivate: true, joinCode: null, stakeAmount: 0, targetScore: 151 } as never })
  const sockets = new Map<ConnectionId, WebSocket>()
  const sent: Array<{ connectionId: string; data: string }> = []
  for (const seat of SERVER_SEAT_ORDER) {
    const connectionId = `conn-${seat}` as ConnectionId
    room = seatParticipantInRoom(room, seat, seat === 'left'
      ? createBotParticipant({ botCode: 'b' })
      : createHumanParticipant({ connectionId, identity: { profileId: `p-${seat}`, displayName: seat } as never }))
    sockets.set(connectionId, { readyState: WebSocket.OPEN, send: (data: string) => { sent.push({ connectionId, data }) } } as unknown as WebSocket)
  }
  room = initializeRoomAuthoritativeGameState(room)

  const sentTypes: string[] = []
  let broadcastHookCalls = 0
  let spectatorCalls = 0
  setSendJsonMessageMonitoringHook((type) => { sentTypes.push(type) })
  setBroadcastRoomSnapshotsMonitoringHook(() => { broadcastHookCalls += 1 })
  setBroadcastRoomSnapshotsSpectatorHook(() => { spectatorCalls += 1 })

  const expected = SERVER_SEAT_ORDER.filter((seat) => seat !== 'left').map((seat) => ({
    connectionId: `conn-${seat}`,
    data: JSON.stringify(createRoomSnapshotMessage(room, seat)),
  }))
  const normalize = (items: Array<{ connectionId: string; data: string }>) => items.map((item) => ({
    connectionId: item.connectionId,
    data: item.data.replace(/"serverNow":(\d+|"[^"]*")/g, '"serverNow":0'),
  }))

  const timings: Array<[string, number]> = []
  setBroadcastRoomSnapshotsTimingHook((label, ms) => { timings.push([label, ms]) })
  broadcastRoomSnapshots(room, sockets)
  check('same bytes, recipients and order as before (3 humans)', JSON.stringify(normalize(sent)) === JSON.stringify(normalize(expected)))
  check('send monitoring hook still reports room_snapshot per send', sentTypes.length === 3 && sentTypes.every((type) => type === 'room_snapshot'))
  check('broadcast + spectator hooks still called once', broadcastHookCalls === 1 && spectatorCalls === 1)
  const labelCount = (label: string) => timings.filter(([name]) => name === label).length
  check('build/stringify/send recorded per human seat', labelCount('build') === 3 && labelCount('stringify') === 3 && labelCount('send') === 3)
  check('spectatorFanout + total recorded once', labelCount('spectatorFanout') === 1 && labelCount('total') === 1)
  check('all timings finite and non-negative', timings.every(([, ms]) => Number.isFinite(ms) && ms >= 0))

  sent.length = 0
  setBroadcastRoomSnapshotsTimingHook(() => { throw new Error('timing hook broken') })
  broadcastRoomSnapshots(room, sockets)
  check('throwing timing hook does not affect sends', sent.length === 3)

  sent.length = 0
  timings.length = 0
  setBroadcastRoomSnapshotsTimingHook(null)
  broadcastRoomSnapshots(room, sockets)
  check('no timing hook → same sends, no timings', sent.length === 3 && timings.length === 0)

  setSendJsonMessageMonitoringHook(null)
  setBroadcastRoomSnapshotsMonitoringHook(null)
  setBroadcastRoomSnapshotsSpectatorHook(null)
}

// ─── [9] hand journal timings ────────────────────────────────────────────────
console.log('\n[9] Belot hand journal timings')
{
  const directory = await mkdtemp(join(tmpdir(), 'belot-journal-timing-'))
  const store = await createBelotHandJournalStore({ directory })
  const timings: Array<[string, number]> = []
  const journal = createBelotHandJournal({ store, scheduleFlush: (flush) => flush(), onTiming: (label, ms) => { timings.push([label, ms]) } })
  let room: ServerRoom = createServerRoom({ roomId: 'journal-timing-room', config: { allowBots: true, isPrivate: false, joinCode: null, stakeAmount: 0, targetScore: 151 } as never })
  for (const seat of SERVER_SEAT_ORDER) room = seatParticipantInRoom(room, seat, createBotParticipant({ botCode: `b-${seat}` }))
  room = initializeRoomAuthoritativeGameState(room)
  let now = Date.now()
  let transitions = 0
  for (let i = 0; i < 4000 && transitions < 40; i += 1) {
    now += 250
    const next = advanceRoomAuthoritativeGame(room, now, SERVER_ANTI_BAD_LUCK_DEFAULT_CONFIG)
    if (next !== room) {
      journal.observeRoomTransition(room, next, 'worker_tick')
      room = next
      transitions += 1
    }
  }
  journal.observeRoomTransition(room, room, 'worker_tick') // непроменено състояние → ранно излизане
  const labels = new Set(timings.map(([label]) => label))
  check('observe recorded for every call (incl. no-op)', timings.filter(([label]) => label === 'observe').length === transitions + 1)
  check('derive recorded for real transitions', timings.filter(([label]) => label === 'derive').length === transitions)
  check('flush/serialize/write recorded', labels.has('flush') && labels.has('serialize') && labels.has('write'), [...labels].join(','))
  check('journal still wrote events', journal.getStats().written > 0, String(journal.getStats().written))
  journal.close()
  await rm(directory, { recursive: true, force: true })
}

// ─── [10] forensic integration shape ─────────────────────────────────────────
console.log('\n[10] spike/bucket integration shape')
{
  const activity = createActivityCounters()
  const metrics = createMainThreadTimingMetrics()
  activity.incrementHttpCategory('auth')
  metrics.record('http', 'auth', 420)
  metrics.record('job', 'topicInactivityCleanup', 800)
  // Огледало на 1s forensic tick-а в index.ts.
  const spikeActivity = { ...activity.snapshotOneSecondAndReset(), mainThreadTimings: metrics.snapshotOneSecondAndReset() }
  const roundTrip = JSON.parse(JSON.stringify(spikeActivity)) as typeof spikeActivity
  check('main-thread timings persist through activity_json round trip', roundTrip.mainThreadTimings?.job?.topicInactivityCleanup?.slow500 === 1)
  check('existing activity fields unchanged', roundTrip.httpRequestsByCategory.auth === 1)
  check('next 1s window starts empty', Object.keys(metrics.snapshotOneSecondAndReset()).length === 0)
}

// ─── [11] HTTP active vs wall ────────────────────────────────────────────────
console.log('\n[11] HTTP active vs wall (body/io wait excluded from active)')
{
  const clock = fakeClock()
  const metrics = createMainThreadTimingMetrics(clock.now)
  let releaseBody: () => void = () => {}
  let releaseIo: () => void = () => {}
  const handler = async (): Promise<string> => {
    clock.advance(2) // routing/auth (active)
    // Огледало на readJsonRequestBody: wait до 'end', JSON.parse след това.
    const bodyWait = beginHttpWait('body')
    await new Promise<void>((resolve) => { releaseBody = resolve })
    endHttpWait(bodyWait)
    clock.advance(5) // JSON.parse + validation (active)
    await trackHttpWait('io', new Promise<void>((resolve) => { releaseIo = resolve }))
    clock.advance(3) // DB + response (active)
    return 'done'
  }
  const pending = timeHttpRequest(metrics, 'POST.profile.me.avatar', handler)
  await Promise.resolve()
  clock.advance(100) // мрежата праща body-то бавно
  releaseBody()
  await new Promise((resolve) => setImmediate(resolve))
  clock.advance(50) // sharp/fs в threadpool-а
  releaseIo()
  check('timeHttpRequest returns handler result', (await pending) === 'done')
  await Promise.resolve()
  const snap = metrics.peek()
  const label = 'POST.profile.me.avatar'
  check('http (active) = 2 + 5 + 3 = 10ms', snap.http?.[label]?.totalDurationMs === 10, JSON.stringify(snap.http))
  check('httpWall = 160ms', snap.httpWall?.[label]?.totalDurationMs === 160, JSON.stringify(snap.httpWall))
  check('httpBodyWait = 100ms', snap.httpBodyWait?.[label]?.totalDurationMs === 100)
  check('httpIoWait = 50ms', snap.httpIoWait?.[label]?.totalDurationMs === 50)
  check('slow body is NOT a main-thread slow event', snap.http?.[label]?.slow50 === 0 && snap.httpWall?.[label]?.slow100 === 1)

  // Overlapping waits: union, без двойно броене в active.
  const overlapClock = fakeClock()
  const overlapMetrics = createMainThreadTimingMetrics(overlapClock.now)
  const overlapping = timeHttpRequest(overlapMetrics, 'GET.health', async () => {
    const a = beginHttpWait('io')
    overlapClock.advance(10)
    const b = beginHttpWait('io')
    overlapClock.advance(10)
    endHttpWait(a)
    overlapClock.advance(10)
    endHttpWait(b)
    endHttpWait(b) // идемпотентно
    overlapClock.advance(4)
  })
  await overlapping
  await Promise.resolve()
  const o = overlapMetrics.peek()
  check('overlapping waits: union 30ms, active 4ms', o.http?.['GET.health']?.totalDurationMs === 4 && o.httpWall?.['GET.health']?.totalDurationMs === 34,
    JSON.stringify(o))

  // Rejection: оригиналният promise, caller-ът вижда грешката, записът е направен.
  const failingMetrics = createMainThreadTimingMetrics()
  const failure = new Error('handler failed')
  let failedPromise: Promise<unknown> | null = null
  const returned = timeHttpRequest(failingMetrics, 'GET.health', () => (failedPromise = Promise.reject(failure)))
  check('returns the ORIGINAL handler promise', returned === failedPromise)
  let sawFailure = false
  await returned.catch((error) => { sawFailure = error === failure })
  await Promise.resolve()
  check('rejection still visible to caller and recorded', sawFailure && failingMetrics.peek().httpWall?.['GET.health']?.count === 1)

  // Извън HTTP контекст wait helper-ите са no-op и не променят promise-а.
  const outside = Promise.resolve(7)
  check('outside HTTP: beginHttpWait → null, trackHttpWait → same promise', beginHttpWait('io') === null && trackHttpWait('io', outside) === outside)

  // Реален HTTP сървър: ALS контекстът минава през req 'data'/'end' събития.
  const realMetrics = createMainThreadTimingMetrics()
  const readBody = (req: IncomingMessage): Promise<unknown> => {
    const bodyWait = beginHttpWait('body')
    return new Promise((resolve, reject) => {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk: string) => { body += chunk })
      req.on('end', () => {
        endHttpWait(bodyWait)
        resolve(JSON.parse(body) as unknown)
      })
      req.on('error', reject)
    })
  }
  const server = createServer((req, res) => {
    void timeHttpRequest(realMetrics, 'POST.contact.guest', async () => {
      const body = await readBody(req)
      res.end(JSON.stringify(body))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  await new Promise<void>((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: '/api/contact/guest' }, (res) => {
      res.resume()
      res.on('end', resolve)
    })
    req.on('error', reject)
    req.write('{"a":')
    setTimeout(() => req.end('1}'), 150) // бавен клиент: 150ms между chunk-овете
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  server.close()
  const real = realMetrics.peek()
  const realActive = real.http?.['POST.contact.guest']?.totalDurationMs ?? -1
  const realWall = real.httpWall?.['POST.contact.guest']?.totalDurationMs ?? -1
  const realBody = real.httpBodyWait?.['POST.contact.guest']?.totalDurationMs ?? -1
  check('real server: body wait >= 120ms recorded as httpBodyWait', realBody >= 120, String(realBody))
  check('real server: active < 50ms (slow client not counted)', realActive >= 0 && realActive < 50, String(realActive))
  check('real server: wall ≈ active + body wait', Math.abs(realWall - realActive - realBody) < 1, `${realWall} ${realActive} ${realBody}`)

  // Source guard: index.ts реално ползва timeHttpRequest + body wait преди JSON.parse.
  const indexSource = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  const readJsonStart = indexSource.indexOf('function readJsonRequestBody(')
  const readJsonBody = indexSource.slice(readJsonStart, indexSource.indexOf('function readRawRequestBody(', readJsonStart))
  const endIndex = readJsonBody.indexOf("req.on('end'")
  check('index: createServer uses timeHttpRequest(classifyHttpRoute(...))', /timeHttpRequest\(mainThreadTimings, classifyHttpRoute\(req\.method, req\.url\)/.test(indexSource))
  check('index: readJsonRequestBody ends body wait before JSON.parse',
    readJsonBody.includes("beginHttpWait('body')") && readJsonBody.indexOf('endHttpWait(bodyWait)', endIndex) > endIndex &&
    readJsonBody.indexOf('endHttpWait(bodyWait)', endIndex) < readJsonBody.indexOf('JSON.parse(body)'))
}

// ─── [12] sync / HTTP active wall / async wall sections ──────────────────────
console.log('\n[12] sync (main thread) vs HTTP active wall vs async wall groups')
{
  const sync = new Set<string>(MAIN_THREAD_SYNC_TIMING_GROUPS)
  const httpActive = new Set<string>(MAIN_THREAD_HTTP_ACTIVE_TIMING_GROUPS)
  const wall = new Set<string>(MAIN_THREAD_WALL_TIMING_GROUPS)
  check("'http' is NOT a MAIN_THREAD_SYNC_TIMING_GROUP", !sync.has('http'))
  check("'http' is the only HTTP active-wall group", httpActive.size === 1 && httpActive.has('http'))
  check('sync, httpActive and wall groups are pairwise disjoint',
    [...wall].every((group) => !sync.has(group) && !httpActive.has(group)) && [...httpActive].every((group) => !sync.has(group)))
  check('all groups = sync ∪ httpActive ∪ wall', MAIN_THREAD_TIMING_GROUPS.length === sync.size + httpActive.size + wall.size)
  check('wall groups: httpWall/httpBodyWait/httpIoWait/runtimeWait/journalAsync/jobAsync',
    ['httpWall', 'httpBodyWait', 'httpIoWait', 'runtimeWait', 'journalAsync', 'jobAsync'].every((group) => isMainThreadWallTimingGroup(group)))
  check('ws/gameplay/commit/runtime/snapshot/completion/journal/job/timer are sync',
    ['ws', 'gameplay', 'commit', 'runtime', 'snapshot', 'completion', 'journal', 'job', 'timer'].every((group) => sync.has(group)))
  check('client wall list mirrors server', JSON.stringify([...CLIENT_WALL_GROUPS].sort()) === JSON.stringify([...wall].sort()))
  check('client HTTP active list mirrors server', JSON.stringify([...CLIENT_HTTP_ACTIVE_GROUPS].sort()) === JSON.stringify([...httpActive].sort()))
  check('client section mapping matches server group sets', MAIN_THREAD_TIMING_GROUPS.every((group) =>
    getMainThreadTimingSection(group) === (wall.has(group) ? 'wall' : httpActive.has(group) ? 'httpActive' : 'sync')))
  const indexSource = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  check("index: worker compute wait recorded as runtimeWait (not 'runtime')",
    indexSource.includes("record('runtimeWait', 'workerCompute'") && !indexSource.includes("'computeWait'"))

  const metrics = createMainThreadTimingMetrics()
  metrics.record('http', 'GET.health', 3)
  metrics.record('httpWall', 'GET.health', 900)
  metrics.record('runtimeWait', 'workerCompute', 400)
  metrics.record('runtime', 'applyPersist', 12)
  const snapshot = metrics.peek()
  const syncRow = summarizeMainThreadTimings(snapshot, 'sync')
  const httpActiveRow = summarizeMainThreadTimings(snapshot, 'httpActive')
  const wallRow = summarizeMainThreadTimings(snapshot, 'wall')
  check('UI sync section has only sync groups (no http, no wall)', syncRow.includes('runtime:applyPersist') &&
    !syncRow.includes('http:') && !syncRow.includes('httpWall') && !syncRow.includes('runtimeWait'), syncRow)
  check('UI HTTP active-wall section shows only http', httpActiveRow === 'http:GET.health 1x/общо 3мс/макс.3мс', httpActiveRow)
  check('UI wall section has only wall/wait groups', wallRow.includes('httpWall:GET.health') && wallRow.includes('runtimeWait:workerCompute') &&
    !wallRow.includes('http:GET') && !wallRow.includes('runtime:'), wallRow)
  const renderSource = readFileSync(new URL('../../src/app/adminServer/renderAdminCpuIncidents.ts', import.meta.url), 'utf8')
  check('UI renders three separate labelled rows',
    renderSource.includes('Main thread sync (1s)') && renderSource.includes('HTTP active wall (1s, tracked waits excluded') &&
    renderSource.includes('Async wall/wait (1s, не е main-thread CPU)'))
  check('UI never presents http as main-thread CPU', !/Main thread[^<]*active/.test(renderSource))
  check('UI tolerates old incidents without timings', summarizeMainThreadTimings(undefined, 'sync') === '' && summarizeMainThreadTimings({}, 'wall') === '0x')
}

// ─── [13] timers ─────────────────────────────────────────────────────────────
console.log('\n[13] timer instrumentation')
{
  // Private-room expiry: прихващаме setTimeout, за да изпълним callback-а веднага.
  const captured: Array<() => void> = []
  const realSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = ((fn: () => void) => { captured.push(fn); return realSetTimeout(() => {}, 0) }) as typeof setTimeout
  const timings: Array<[string, number]> = []
  let expired = 0
  const store = createPrivateRoomsStore({
    onRoomsChanged: () => {},
    onRoomReady: () => {},
    onRoomExpired: () => {
      expired += 1
      const until = performance.now() + 15
      while (performance.now() < until) { /* sync работа в expiry callback-а */ }
    },
    onRoomClosed: () => {},
    onMemberLeft: () => {},
    onMemberKicked: () => {},
    onTimerTiming: (label, ms) => { timings.push([label, ms]) },
  })
  const created = store.createRoom({
    connectionId: 'timer-conn', profileId: 'timer-profile', displayName: 'T', avatarUrl: null, level: 1, rankTitle: null,
    stake: 5000, isLocked: false, waitMinutes: 5, manualStart: false, humanTurnTimeoutMs: undefined,
  } as never) as { ok?: boolean }
  globalThis.setTimeout = realSetTimeout
  check('private room created and expiry scheduled', created.ok !== false && captured.length >= 1, String(captured.length))
  for (const fn of captured) fn()
  check('expiry ran (room removed)', expired === 1 && store.listRooms().length === 0)
  const expiryTiming = timings.find(([label]) => label === 'privateRoomExpiry')
  check('privateRoomExpiry timing includes sync callback work (>=15ms)', expiryTiming !== undefined && expiryTiming[1] >= 15, JSON.stringify(timings))

  const storeWithoutHook = createPrivateRoomsStore({
    onRoomsChanged: () => {}, onRoomReady: () => {}, onRoomExpired: () => {}, onRoomClosed: () => {}, onMemberLeft: () => {}, onMemberKicked: () => {},
  })
  check('private rooms store works without timing hook', typeof storeWithoutHook.createRoom === 'function')

  // Svara clock: schedule → 'svaraDeadline', defer → 'svaraContinuation'.
  // Svara таймерите са unref()-нати → ref-нат keep-alive, докато тестът чака.
  const keepAlive = setInterval(() => {}, 1000)
  const svaraTimings: Array<[string, number]> = []
  const clock = createSvaraRealClock((label, ms) => { svaraTimings.push([label, ms]) })
  const order: string[] = []
  await new Promise<void>((resolve) => {
    clock.schedule(() => {
      order.push('deadline')
      const until = performance.now() + 10
      while (performance.now() < until) { /* sync */ }
      clock.defer(() => { order.push('continuation'); resolve() })
    }, 5)
  })
  check('Svara callbacks run in order', order.join(',') === 'deadline,continuation')
  const deadline = svaraTimings.find(([label]) => label === 'svaraDeadline')
  check('svaraDeadline timing recorded (>=10ms sync)', deadline !== undefined && deadline[1] >= 10, JSON.stringify(svaraTimings))
  check('svaraContinuation timing recorded', svaraTimings.some(([label]) => label === 'svaraContinuation'))
  let cancelledRan = false
  const cancel = clock.schedule(() => { cancelledRan = true }, 1)
  cancel()
  await new Promise((resolve) => setTimeout(resolve, 10))
  check('Svara cancel still works with timed clock', !cancelledRan)
  const throwingClock = createSvaraRealClock(() => { throw new Error('hook broken') })
  const ranWithThrowingHook = await new Promise<boolean>((resolve) => { throwingClock.defer(() => resolve(true)) })
  check('throwing Svara timing hook does not break callback', ranWithThrowingHook)
  clearInterval(keepAlive)

  // Monitoring sampler: collectSample (sync) → 'monitoringSample'.
  const samplerTimings: string[] = []
  const sampler = createMonitoringSampler({
    backendStartedAtMs: Date.now(),
    getWsConnectionCount: () => 0,
    getUniqueOnlineRealPlayers: () => 0,
    getMatchmakingWaitersByStake: () => ({}),
    getActiveRoomCount: () => 0,
    getRoomsByPhase: () => ({}),
    getActiveRooms: () => [],
    getWorkerPoolHealth: () => null,
    getWorkerCpuUsages: () => Promise.resolve([]),
    onTiming: (label) => { samplerTimings.push(label) },
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  sampler.stop()
  check('monitoringSample recorded on sample', samplerTimings.includes('monitoringSample'), samplerTimings.join(','))
  check('monitoringWorkerCpu recorded (async wall)', samplerTimings.includes('monitoringWorkerCpu'), samplerTimings.join(','))

  // Journal maintenance: sync store slices → 'maintenance.<метод>' (journal sync).
  const directory = await mkdtemp(join(tmpdir(), 'belot-journal-maint-timing-'))
  const journalStore = await createBelotHandJournalStore({ directory })
  const journalTimings: string[] = []
  const journal = createBelotHandJournal({ store: journalStore, scheduleFlush: (flush) => flush(), onTiming: (label) => { journalTimings.push(label) } })
  await journal.runMaintenanceNow()
  journal.close()
  await rm(directory, { recursive: true, force: true })
  const sliceLabels = journalTimings.filter((label) => label.startsWith('maintenance.'))
  check('maintenance wall recorded', journalTimings.includes('maintenance'), journalTimings.join(','))
  check('maintenance sync store slices recorded (e.g. listDays)',
    sliceLabels.includes('maintenance.listDays'), sliceLabels.join(','))
  // Delete методите вече са async (порции) — не се записват като
  // 'maintenance.<метод>'; тяхната sync работа е 'maintenance.delete*Chunk'.
  check('async delete methods are not recorded as one sync slice',
    !sliceLabels.includes('maintenance.deleteDaysBefore') && !sliceLabels.includes('maintenance.deleteDayRange'), sliceLabels.join(','))
  check('reclaim sync steps + reclaim wall recorded',
    journalTimings.includes('reclaim.checkpoint') && journalTimings.includes('maintenance.reclaim.final'), journalTimings.join(','))
  check('maintenance slice labels bounded', journalTimings.every((label) => SAFE_KEY.test(label)))
}

// ─── [14] bounded HTTP route labels ──────────────────────────────────────────
console.log('\n[14] bounded HTTP route labels')
{
  const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'OTHER']
  const templateLabels = HTTP_ROUTE_TEMPLATES.map(httpRouteTemplateToLabel)
  check('templates unique', new Set(HTTP_ROUTE_TEMPLATES).size === HTTP_ROUTE_TEMPLATES.length)
  check('template labels unique', new Set(templateLabels).size === templateLabels.length)
  const tooLong = methods.flatMap((method) => templateLabels.map((label) => `${method}.${label}`)).filter((label) => !SAFE_KEY.test(label))
  check('every METHOD.template label matches pattern and <= 64 chars', tooLong.length === 0, tooLong.join(','))

  const secret = 'f81d4fae-7dec-11d0-a765-00a0c91e6bf6'
  const idCases: Array<[string, string, string]> = [
    ['POST', `/api/profiles/${secret}/like?token=${secret}`, 'POST.profiles._.like'],
    ['POST', `/api/tournaments/${secret}/partner-invites/123/accept`, 'POST.tournaments._.partner-invites._.accept'],
    ['GET', '/api/topics/mute-status', 'GET.topics.mute-status'],
    ['GET', `/api/topics/${secret}`, 'GET.topics._'],
    ['GET', `/api/chat/${secret}/attachments/abc.webp`, 'GET.chat._.attachments._'],
    ['GET', `/uploads/avatars/${secret}.webp?v=2`, 'GET.uploads.static'],
    ['BREW', '/api/auth/me', 'OTHER.auth.me'],
    ['GET', `/api/profiles//like`, 'GET.profile.other'],
    ['GET', `/api/nonexistent/${secret}`, 'GET.other.other'],
    ['DELETE', `/api/admin/campaigns/${secret}/theme-assets/7`, 'DELETE.admin.campaigns._.theme-assets._'],
  ]
  for (const [method, url, expected] of idCases) {
    const label = classifyHttpRoute(method, url)
    check(`${method} ${url.replace(secret, '<id>')} -> ${expected}`, label === expected, label)
  }

  // Fuzz: случайни IDs/query/user стойности никога не влизат в label-а и
  // наборът от label-и остава bounded.
  const seen = new Set<string>()
  let leaked = 0
  let invalid = 0
  for (let i = 0; i < 5000; i += 1) {
    const id = `u${Math.random().toString(36).slice(2)}x${i}`
    const template = HTTP_ROUTE_TEMPLATES[i % HTTP_ROUTE_TEMPLATES.length]!
    const path = i % 7 === 0 ? `/api/${id}/${id}` : template.replace(/:id/g, id)
    const label = classifyHttpRoute(methods[i % methods.length], `${path}?q=${id}&email=${id}@example.com`)
    if (label.includes(id)) leaked += 1
    if (!SAFE_KEY.test(label)) invalid += 1
    seen.add(label)
  }
  check('no ID/query value ever appears in a label', leaked === 0, String(leaked))
  check('all fuzzed labels valid', invalid === 0, String(invalid))
  check('label set bounded (<= templates × methods + categories × methods)', seen.size <= (HTTP_ROUTE_TEMPLATES.length + 32) * methods.length, String(seen.size))
  const metrics = createMainThreadTimingMetrics()
  for (const label of seen) metrics.record('http', label, 1)
  check(`metrics cap still holds (<= ${MAX_LABELS_PER_GROUP} per group)`, Object.keys(metrics.peek().http ?? {}).length <= MAX_LABELS_PER_GROUP)

  // Drift guard: всеки литерален '/api/...' pathname matcher в index.ts има template.
  const indexSource = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  const literalRoutes = new Set([...indexSource.matchAll(/pathname (?:===|!==) '(\/api\/[^']+)'/g)].map((match) => match[1]!))
  const missing = [...literalRoutes].filter((route) => !HTTP_ROUTE_TEMPLATES.includes(route))
  check(`all ${literalRoutes.size} literal /api routes in index.ts have a template`, missing.length === 0, missing.join(','))
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed > 0 ? 1 : 0
