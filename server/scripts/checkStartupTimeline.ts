/**
 * checkStartupTimeline.ts — deterministic tests за startup timeline diagnostics.
 *
 *  [1] фиксирани, bounded label-и; непознат label се игнорира
 *  [2] measure() записва продължителност, връща резултата, re-throw при грешка
 *  [3] probe-овете не се изпълняват синхронно и не променят startup ordering
 *  [4] точно ЕДИН [startup-timeline] log ред; setTimeout(0) след setImmediate не логва втори
 *  [5] snapshot-ът е без IDs/user data (whitelist на полетата)
 *  [6] липсващ optional subsystem (shadow/scheduler/coordinator/campaign) не чупи нищо
 *  [7] health serialization (JSON round trip) + getSnapshot преди/след
 *  [8] wiring: всички label-и се ползват в index.ts, без await/yield в production пътя
 */

import { readFileSync } from 'node:fs'
import {
  STARTUP_TIMELINE_STEPS,
  createStartupTimeline,
  type StartupTimelineSnapshot,
} from '../src/monitoring/startupTimeline.js'

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

function fakeClock(start = 1000) {
  let value = start
  return { now: () => value, advance: (ms: number) => { value += ms } }
}

function manualScheduler() {
  const immediates: Array<() => void> = []
  const timeouts: Array<() => void> = []
  return {
    immediates,
    timeouts,
    scheduleImmediate: (callback: () => void) => { immediates.push(callback) },
    scheduleTimeout0: (callback: () => void) => { timeouts.push(callback) },
  }
}

// ─── [1] labels ──────────────────────────────────────────────────────────────
console.log('\n[1] fixed bounded labels')
{
  check('16 fixed labels, unique', STARTUP_TIMELINE_STEPS.length === 16 && new Set(STARTUP_TIMELINE_STEPS).size === 16)
  check('labels are code identifiers (no IDs)', STARTUP_TIMELINE_STEPS.every((label) => /^[A-Za-z][A-Za-z0-9.]{2,63}$/.test(label)))
  const timeline = createStartupTimeline({ ...manualScheduler(), log: () => {} })
  timeline.measure('room-123' as never, () => 1)
  const snapshot = timeline.getSnapshot()
  check('unknown label ignored (no snapshot / no key)', snapshot === null || !('room-123' in snapshot.stepsMs))
}

// ─── [2] measure ─────────────────────────────────────────────────────────────
console.log('\n[2] timing wrapper')
{
  const clock = fakeClock()
  const timeline = createStartupTimeline({ now: clock.now, ...manualScheduler(), log: () => {} })
  const result = timeline.measure('tournamentCoordinator.start', () => { clock.advance(4321.5); return 'started' })
  check('returns fn result', result === 'started')
  check('records duration', timeline.getSnapshot()?.stepsMs['tournamentCoordinator.start'] === 4321.5)
  let rethrown = false
  try {
    timeline.measure('svaraLobby.initializeRecovery', () => { clock.advance(7); throw new Error('boom') })
  } catch (error) {
    rethrown = (error as Error).message === 'boom'
  }
  check('records on exception and re-throws', rethrown && timeline.getSnapshot()?.stepsMs['svaraLobby.initializeRecovery'] === 7)
  timeline.measure('tournamentCoordinator.start', () => { clock.advance(99) })
  check('first measurement wins (startup is one-shot)', timeline.getSnapshot()?.stepsMs['tournamentCoordinator.start'] === 4321.5)
  const startedAt = clock.now()
  clock.advance(12)
  timeline.recordSince('createTournamentScheduler', startedAt)
  check('recordSince records elapsed', timeline.getSnapshot()?.stepsMs.createTournamentScheduler === 12)
}

// ─── [3] probes do not change ordering ───────────────────────────────────────
console.log('\n[3] probes are not awaited and do not change ordering')
{
  const order: string[] = []
  const lines: string[] = []
  const timeline = createStartupTimeline({ log: (line) => { lines.push(line); order.push('probe-log') } })
  order.push('seed')
  timeline.armFirstLoopTurnProbes({ restoredRoomCount: 11, workerCount: 4, readShadowTotals: () => null })
  order.push('after-arm')
  timeline.measure('tournamentCoordinator.start', () => { order.push('coordinator.start') })
  // async стъпка без реален yield (като await import на зареден модул)
  await Promise.resolve()
  order.push('after-microtask-await')
  check('nothing ran synchronously on arm', lines.length === 0 && order.join(',') === 'seed,after-arm,coordinator.start,after-microtask-await')
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setTimeout(resolve, 5))
  check('probe logged only after startup code (first real loop turn)', order.join(',') === 'seed,after-arm,coordinator.start,after-microtask-await,probe-log', order.join(','))
  const snapshot = timeline.getSnapshot()!
  check('first immediate and timeout0 measured', typeof snapshot.totalUntilFirstImmediateMs === 'number' && typeof snapshot.totalUntilFirstTimeout0Ms === 'number')
  timeline.armFirstLoopTurnProbes({ restoredRoomCount: 99, workerCount: 9, readShadowTotals: () => null })
  check('arming twice is a no-op', timeline.getSnapshot()!.restoredRoomCount === 11)
}

// ─── [4] exactly one log line ────────────────────────────────────────────────
console.log('\n[4] exactly one structured log line')
{
  const clock = fakeClock(0)
  const scheduler = manualScheduler()
  const lines: string[] = []
  const timeline = createStartupTimeline({ now: clock.now, ...scheduler, log: (line) => lines.push(line) })
  timeline.measure('seedRestoredActiveRooms', () => clock.advance(2))
  timeline.armFirstLoopTurnProbes({
    restoredRoomCount: 11,
    workerCount: 4,
    readShadowTotals: () => ({ desiredRooms: 11, confirmedRooms: 2, pendingOperations: 0, scheduledRetries: 9, assignFailureCount: 9, assignRetryCount: 0 }),
  })
  timeline.measure('tournamentCoordinator.start', () => clock.advance(5200))
  timeline.measure('svaraLobby.initializeRecovery', () => clock.advance(300))
  clock.advance(10) // неизмерен sync код
  scheduler.immediates[0]!() // setImmediate първи
  clock.advance(1)
  scheduler.timeouts[0]!() // setTimeout(0) след него
  scheduler.immediates[0]!() // повторно извикване не логва
  check('exactly one [startup-timeline] line', lines.length === 1 && lines[0]!.startsWith('[startup-timeline] {'))
  const parsed = JSON.parse(lines[0]!.slice('[startup-timeline] '.length)) as StartupTimelineSnapshot
  check('totalUntilFirstImmediateMs = 5510', parsed.totalUntilFirstImmediateMs === 5510, String(parsed.totalUntilFirstImmediateMs))
  check('timeout0 not yet in the log line, but stored in memory', parsed.totalUntilFirstTimeout0Ms === null && timeline.getSnapshot()!.totalUntilFirstTimeout0Ms === 5511)
  check('measuredAfterSeed excludes seed; unattributed = 10ms', parsed.measuredAfterSeedMs === 5500 && parsed.unattributedAfterSeedMs === 10)
  check('shadow totals included', parsed.shadow?.assignFailureCount === 9 && parsed.shadow.desiredRooms === 11)
  check('all fixed labels present (null when not measured)', Object.keys(parsed.stepsMs).length === STARTUP_TIMELINE_STEPS.length && parsed.stepsMs.createMonitoringSampler === null)
}

// ─── [5] no IDs / user data ──────────────────────────────────────────────────
console.log('\n[5] no IDs or user data')
{
  const scheduler = manualScheduler()
  const lines: string[] = []
  const timeline = createStartupTimeline({ ...scheduler, log: (line) => lines.push(line) })
  timeline.captureCoordinatorTick({
    durationMs: 4000, tournaments: 3, sqlStatements: 420, sqlMs: 1200.5, commitRooms: 6, commitRoomMs: 2500,
    processedMatches: 12, notifyAssignments: 8,
    // лишни полета (като в реалния TickMetrics) — не трябва да се копират
    ...({ matchDurationsMs: [1, 2, 3], roomId: 'room-secret-1', profileId: 'profile-secret-1' } as Record<string, unknown>),
  })
  timeline.captureSchedulerTick({ durationMs: 33, ...({ tournamentId: 't-secret' } as Record<string, unknown>) } as { durationMs: number })
  timeline.armFirstLoopTurnProbes({
    restoredRoomCount: 11,
    workerCount: 4,
    readShadowTotals: () => ({ desiredRooms: 1, confirmedRooms: 1, pendingOperations: 0, scheduledRetries: 0, assignFailureCount: 0, assignRetryCount: 0, ...({ roomIds: ['room-secret-2'] } as Record<string, unknown>) }) as never,
  })
  scheduler.immediates[0]!()
  const text = lines[0] ?? ''
  check('no IDs leak into the log line', !/secret|roomId|profileId|tournamentId|matchDurationsMs/.test(text), text)
  const parsed = JSON.parse(text.slice('[startup-timeline] '.length)) as StartupTimelineSnapshot
  check('coordinator tick keeps only whitelisted metrics', JSON.stringify(Object.keys(parsed.coordinatorStartupTick ?? {}).sort()) ===
    JSON.stringify(['commitRoomMs', 'commitRooms', 'durationMs', 'notifyAssignments', 'processedMatches', 'sqlMs', 'sqlStatements', 'tournaments']))
  check('top-level keys are fixed', JSON.stringify(Object.keys(parsed).sort()) === JSON.stringify([
    'coordinatorStartupTick', 'measuredAfterSeedMs', 'restoredRoomCount', 'schedulerStartupTick', 'shadow', 'stepsMs',
    'totalUntilFirstImmediateMs', 'totalUntilFirstTimeout0Ms', 'unattributedAfterSeedMs', 'workerCount',
  ]))
  timeline.captureCoordinatorTick({ durationMs: 1 })
  check('only the startup (first) coordinator tick is kept', timeline.getSnapshot()!.coordinatorStartupTick?.durationMs === 4000)
}

// ─── [6] missing optional subsystems ─────────────────────────────────────────
console.log('\n[6] missing optional subsystems do not break')
{
  const scheduler = manualScheduler()
  const lines: string[] = []
  const timeline = createStartupTimeline({ ...scheduler, log: (line) => lines.push(line) })
  timeline.armFirstLoopTurnProbes({ restoredRoomCount: 0, workerCount: 1, readShadowTotals: () => { throw new Error('pool missing') } })
  let threw = false
  try {
    scheduler.immediates[0]!()
    scheduler.timeouts[0]!()
  } catch {
    threw = true
  }
  const snapshot = timeline.getSnapshot()!
  check('throwing shadow reader → shadow null, no throw', !threw && snapshot.shadow === null && lines.length === 1)
  check('no scheduler/coordinator/campaign → nulls', snapshot.schedulerStartupTick === null && snapshot.coordinatorStartupTick === null &&
    snapshot.stepsMs['campaignScheduler.start'] === null && snapshot.stepsMs['campaignCreditReconciliationJob.start'] === null)
  const brokenLog = createStartupTimeline({ ...manualScheduler(), log: () => { throw new Error('stdout closed') } })
  let brokenThrew = false
  try {
    brokenLog.armFirstLoopTurnProbes({ restoredRoomCount: 0, workerCount: 1, readShadowTotals: () => null })
  } catch {
    brokenThrew = true
  }
  check('throwing logger never propagates', !brokenThrew)
  const brokenScheduler = createStartupTimeline({ scheduleImmediate: () => { throw new Error('x') }, scheduleTimeout0: () => {}, log: () => {} })
  let armThrew = false
  try {
    brokenScheduler.armFirstLoopTurnProbes({ restoredRoomCount: 0, workerCount: 1, readShadowTotals: () => null })
  } catch {
    armThrew = true
  }
  check('throwing scheduler never breaks startup', !armThrew)
}

// ─── [7] health serialization ────────────────────────────────────────────────
console.log('\n[7] health serialization')
{
  const scheduler = manualScheduler()
  const timeline = createStartupTimeline({ ...scheduler, log: () => {} })
  check('getSnapshot() is null before startup instrumentation', timeline.getSnapshot() === null)
  timeline.measure('seedRestoredActiveRooms', () => {})
  timeline.armFirstLoopTurnProbes({ restoredRoomCount: 3, workerCount: 4, readShadowTotals: () => null })
  const before = timeline.getSnapshot()!
  check('partial snapshot before first loop turn (totals null)', before.totalUntilFirstImmediateMs === null && before.restoredRoomCount === 3)
  scheduler.timeouts[0]!()
  scheduler.immediates[0]!()
  const body = JSON.parse(JSON.stringify({ ok: true, snapshot: {}, startupTimeline: timeline.getSnapshot() })) as { startupTimeline: StartupTimelineSnapshot }
  check('JSON round trip for /api/admin/monitoring/current', typeof body.startupTimeline.totalUntilFirstImmediateMs === 'number' &&
    typeof body.startupTimeline.totalUntilFirstTimeout0Ms === 'number' && body.startupTimeline.workerCount === 4)
  const copy = timeline.getSnapshot()!
  copy.stepsMs.seedRestoredActiveRooms = 999
  check('snapshot is a copy', timeline.getSnapshot()!.stepsMs.seedRestoredActiveRooms !== 999)
}

// ─── [8] wiring in index.ts ──────────────────────────────────────────────────
console.log('\n[8] index.ts wiring')
{
  const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  const missing = STARTUP_TIMELINE_STEPS.filter((label) => !source.includes(`'${label}'`))
  check('every fixed label is wired in index.ts', missing.length === 0, missing.join(','))
  check('probes armed right after seed (both tick modes)', (source.match(/seedRestoredActiveRoomsWithStartupTimeline\(\)/g) ?? []).length === 3)
  check('no await on startup timeline', !/await\s+startupTimeline/.test(source))
  check('admin monitoring endpoint exposes in-memory snapshot', source.includes('startupTimeline: startupTimeline.getSnapshot()'))
  const moduleSource = readFileSync(new URL('../src/monitoring/startupTimeline.ts', import.meta.url), 'utf8')
  check('module has no DB/fs access', !/node:sqlite|DatabaseSync|node:fs|writeFile/.test(moduleSource))
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed > 0 ? 1 : 0
