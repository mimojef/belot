/**
 * benchMainThreadTimingOverhead.ts — synthetic overhead на Phase 0B
 * instrumentation (enabled vs baseline) за:
 *   - HTTP: classifyHttpRoute + timeHttpRequest (AsyncLocalStorage, active/wall)
 *     около handler с 1 body wait и 1 io wait (вече resolved promise-и)
 *   - WS: try/finally + record около sync handler
 *   - gameplay: 6 последователни recordSince фази
 *   - snapshot broadcast: реален broadcastRoomSnapshots (3 human seats)
 *   - snapshotOneSecondAndReset/snapshotTenSecondAndReset при 0/50/100 labels (µs)
 * Резултатът е ns/операция (median от няколко прогона). Не е тест.
 */

import { WebSocket } from 'ws'
import { createMainThreadTimingMetrics } from '../src/monitoring/mainThreadTimingMetrics.js'
import { beginHttpWait, endHttpWait, timeHttpRequest, trackHttpWait } from '../src/monitoring/httpRequestTiming.js'
import { classifyHttpRoute } from '../src/monitoring/httpRouteClassifier.js'
import { broadcastRoomSnapshots, setBroadcastRoomSnapshotsTimingHook } from '../src/core/broadcastRoomSnapshots.js'
import { createServerRoom } from '../src/core/createServerRoom.js'
import { createHumanParticipant } from '../src/core/createHumanParticipant.js'
import { createBotParticipant } from '../src/core/createBotParticipant.js'
import { seatParticipantInRoom } from '../src/core/seatParticipantInRoom.js'
import { SERVER_SEAT_ORDER, type ConnectionId, type ServerRoom } from '../src/core/serverTypes.js'
import { initializeRoomAuthoritativeGameState } from '../src/game/initializeRoomAuthoritativeGameState.js'

const RUNS = 5

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

async function measure(iterations: number, fn: () => unknown | Promise<unknown>): Promise<number> {
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
  // малко синхронна "handler" работа, за да не мерим празен цикъл
  let total = 0
  for (let i = 0; i < 50; i += 1) total += i * 31
  return total
}

const metrics = createMainThreadTimingMetrics()
const rows: Array<[string, number, number]> = []

// HTTP
{
  const handler = async (): Promise<number> => {
    const bodyWait = beginHttpWait('body')
    await Promise.resolve()
    endHttpWait(bodyWait)
    await trackHttpWait('io', Promise.resolve(0))
    return work()
  }
  const base = await measure(200_000, handler)
  const timed = await measure(200_000, () =>
    timeHttpRequest(metrics, classifyHttpRoute('POST', '/api/tournaments/550e8400-e29b-41d4-a716-446655440000/join?x=1'), handler))
  rows.push(['HTTP request (route+active/wall)', base, timed])
  const classifyOnly = await measure(500_000, () => classifyHttpRoute('GET', '/api/topics/abc/messages/def/replies?cursor=1'))
  rows.push(['  classifyHttpRoute only', 0, classifyOnly])
}
// WS
{
  const base = await measure(500_000, () => { try { work() } catch { /* */ } })
  const timed = await measure(500_000, () => {
    const startedAt = performance.now()
    let label = 'unparsed'
    try {
      label = 'submit_play_card'
      work()
    } catch { /* */ } finally {
      metrics.record('ws', label, performance.now() - startedAt)
    }
  })
  rows.push(['WS inbound handler (try/finally)', base, timed])
}
// gameplay phases
{
  const base = await measure(300_000, () => { work(); work(); work(); work(); work(); work() })
  const timed = await measure(300_000, () => {
    let at = metrics.now()
    work(); at = metrics.recordSince('gameplay', 'play.compute', at)
    work(); at = metrics.recordSince('gameplay', 'play.audit', at)
    work(); at = metrics.recordSince('gameplay', 'play.commit', at)
    work(); at = metrics.recordSince('gameplay', 'play.ensureRoom', at)
    work(); at = metrics.recordSince('gameplay', 'play.broadcast', at)
    work(); metrics.recordSince('gameplay', 'play.post', at)
  })
  rows.push(['Gameplay action (6 phases)', base, timed])
}
// snapshot broadcast
{
  let room: ServerRoom = createServerRoom({ roomId: 'bench-room', config: { allowBots: true, isPrivate: true, joinCode: null, stakeAmount: 0, targetScore: 151 } as never })
  const sockets = new Map<ConnectionId, WebSocket>()
  for (const seat of SERVER_SEAT_ORDER) {
    const connectionId = `bench-${seat}` as ConnectionId
    room = seatParticipantInRoom(room, seat, seat === 'left'
      ? createBotParticipant({ botCode: 'b' })
      : createHumanParticipant({ connectionId, identity: { profileId: `p-${seat}`, displayName: seat } as never }))
    sockets.set(connectionId, { readyState: WebSocket.OPEN, send: () => {} } as unknown as WebSocket)
  }
  room = initializeRoomAuthoritativeGameState(room)
  setBroadcastRoomSnapshotsTimingHook(null)
  const base = await measure(20_000, () => broadcastRoomSnapshots(room, sockets))
  setBroadcastRoomSnapshotsTimingHook((label, ms) => metrics.record('snapshot', label, ms))
  const timed = await measure(20_000, () => broadcastRoomSnapshots(room, sockets))
  setBroadcastRoomSnapshotsTimingHook(null)
  rows.push(['Room snapshot broadcast (3 seats)', base, timed])
}

console.log('path'.padEnd(36), 'baseline ns/op'.padStart(15), 'instrumented ns/op'.padStart(19), 'overhead ns/op'.padStart(15), 'overhead %'.padStart(11))
for (const [name, base, timed] of rows) {
  console.log(
    name.padEnd(36),
    base.toFixed(0).padStart(15),
    timed.toFixed(0).padStart(19),
    (timed - base).toFixed(0).padStart(15),
    (base > 0 ? `${(((timed - base) / base) * 100).toFixed(1)}%` : '-').padStart(11),
  )
}

// snapshot/reset цена (викат се в 1s forensic tick-а и 10s bucket tick-а).
// Populate-ът е извън измерването; мери се само самият snapshot*AndReset().
{
  const groups = ['http', 'ws', 'gameplay', 'commit', 'runtime', 'snapshot', 'job', 'timer', 'httpWall', 'jobAsync'] as const
  const populate = (target: ReturnType<typeof createMainThreadTimingMetrics>, labelCount: number) => {
    for (let i = 0; i < labelCount; i += 1) target.record(groups[i % groups.length]!, `label_${i}`, (i % 7) + 0.5)
  }
  console.log('\nsnapshot/reset'.padEnd(37), 'labels'.padStart(8), 'oneSecond µs'.padStart(14), 'tenSecond µs'.padStart(14))
  for (const labelCount of [0, 50, 100]) {
    const iterations = 20_000
    const runsOne: number[] = []
    const runsTen: number[] = []
    for (let run = 0; run < RUNS; run += 1) {
      const target = createMainThreadTimingMetrics()
      let one = 0
      let ten = 0
      for (let i = 0; i < iterations; i += 1) {
        populate(target, labelCount)
        let startedAt = performance.now()
        target.snapshotOneSecondAndReset()
        one += performance.now() - startedAt
        startedAt = performance.now()
        target.snapshotTenSecondAndReset()
        ten += performance.now() - startedAt
      }
      runsOne.push((one * 1000) / iterations)
      runsTen.push((ten * 1000) / iterations)
    }
    console.log(''.padEnd(36), String(labelCount).padStart(8), median(runsOne).toFixed(2).padStart(14), median(runsTen).toFixed(2).padStart(14))
  }
}
