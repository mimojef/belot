// Startup timeline diagnostics (само startup, само in-memory).
//
// Цел: да се измери коя startup стъпка след seedRestoredActiveRooms() държи
// main event loop-а. Audit-ът показа, че от seed-а до края на module
// evaluation няма реален event-loop yield (всички await-и са microtask-only),
// затова 5000 ms lifecycle timeout-ите на assign_room изтичат преди ACK-овете.
//
// - measure(label, fn): синхронен performance.now() wrapper около стъпка;
//   записва и при exception (re-throw), никога не променя резултата.
// - armFirstLoopTurnProbes(): насрочва (БЕЗ await) setImmediate и
//   setTimeout(0) непосредствено след seed-а. Те само отчитат кога event
//   loop-ът реално се връща; на първия setImmediate се печата точно ЕДИН
//   ред `[startup-timeline] {...}`.
// - Само фиксирани label-и; без roomId/profileId/user данни; без DB.

export const STARTUP_TIMELINE_STEPS = [
  'seedRestoredActiveRooms',
  'runMuteExpirySweep',
  'createTournamentScheduler',
  'tournamentScheduler.start',
  'createTournamentCoordinator',
  'tournamentCoordinator.start',
  'createMonitoringSampler',
  'monitoring.initialCollectSample',
  'createMonitoringHistoryStore',
  'monitoringHistoryStore.purgeOlderThan',
  'createCpuIncidentStore',
  'cpuIncidentStore.purgeOlderThan',
  'svaraLobby.initializeRecovery',
  'httpServer.listen',
  'campaignScheduler.start',
  'campaignCreditReconciliationJob.start',
] as const

export type StartupTimelineStep = (typeof STARTUP_TIMELINE_STEPS)[number]

const STEP_SET: ReadonlySet<string> = new Set(STARTUP_TIMELINE_STEPS)

export type StartupShadowTotals = {
  desiredRooms: number
  confirmedRooms: number
  pendingOperations: number
  scheduledRetries: number
  assignFailureCount: number
  assignRetryCount: number
}

export type StartupCoordinatorTick = {
  durationMs: number
  tournaments: number
  sqlStatements: number
  sqlMs: number
  commitRooms: number
  commitRoomMs: number
  processedMatches: number
  notifyAssignments: number
}

export type StartupSchedulerTick = {
  durationMs: number
}

export type StartupTimelineSnapshot = {
  // От края на seedRestoredActiveRooms() до първия setImmediate / setTimeout(0).
  totalUntilFirstImmediateMs: number | null
  totalUntilFirstTimeout0Ms: number | null
  restoredRoomCount: number | null
  workerCount: number | null
  // null = стъпката не е измерена (напр. optional subsystem липсва).
  stepsMs: Record<StartupTimelineStep, number | null>
  // Сума на измерените стъпки СЛЕД seed-а и остатъкът до първия setImmediate
  // (неизмерен sync код между стъпките).
  measuredAfterSeedMs: number
  unattributedAfterSeedMs: number | null
  shadow: StartupShadowTotals | null
  schedulerStartupTick: StartupSchedulerTick | null
  coordinatorStartupTick: StartupCoordinatorTick | null
}

export type StartupTimeline = {
  measure<T>(step: StartupTimelineStep, fn: () => T): T
  recordSince(step: StartupTimelineStep, startedAt: number): void
  now(): number
  armFirstLoopTurnProbes(input: {
    restoredRoomCount: number
    workerCount: number
    readShadowTotals: () => StartupShadowTotals | null
  }): void
  captureSchedulerTick(tick: { durationMs: number }): void
  captureCoordinatorTick(tick: Partial<Record<keyof StartupCoordinatorTick, unknown>>): void
  getSnapshot(): StartupTimelineSnapshot | null
}

export type StartupTimelineDeps = {
  now?: () => number
  scheduleImmediate?: (callback: () => void) => void
  scheduleTimeout0?: (callback: () => void) => void
  log?: (line: string) => void
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export function createStartupTimeline(deps: StartupTimelineDeps = {}): StartupTimeline {
  const now = deps.now ?? (() => performance.now())
  const scheduleImmediate = deps.scheduleImmediate ?? ((callback: () => void) => {
    setImmediate(callback).unref?.()
  })
  const scheduleTimeout0 = deps.scheduleTimeout0 ?? ((callback: () => void) => {
    setTimeout(callback, 0).unref?.()
  })
  const log = deps.log ?? ((line: string) => console.log(line))

  const stepsMs = new Map<StartupTimelineStep, number>()
  let armedAt: number | null = null
  let restoredRoomCount: number | null = null
  let workerCount: number | null = null
  let totalUntilFirstImmediateMs: number | null = null
  let totalUntilFirstTimeout0Ms: number | null = null
  let shadow: StartupShadowTotals | null = null
  let schedulerStartupTick: StartupSchedulerTick | null = null
  let coordinatorStartupTick: StartupCoordinatorTick | null = null
  let logged = false

  function record(step: StartupTimelineStep, durationMs: number): void {
    // Само фиксирани label-и; първото измерване печели (startup е еднократен).
    if (!STEP_SET.has(step) || stepsMs.has(step) || !Number.isFinite(durationMs)) return
    stepsMs.set(step, Math.max(0, durationMs))
  }

  function measure<T>(step: StartupTimelineStep, fn: () => T): T {
    const startedAt = now()
    try {
      return fn()
    } finally {
      try {
        record(step, now() - startedAt)
      } catch {
        // diagnostics — никога не влияе на startup
      }
    }
  }

  function buildSnapshot(): StartupTimelineSnapshot {
    const steps = {} as Record<StartupTimelineStep, number | null>
    let measuredAfterSeedMs = 0
    for (const step of STARTUP_TIMELINE_STEPS) {
      const value = stepsMs.get(step)
      steps[step] = value === undefined ? null : round(value)
      if (value !== undefined && step !== 'seedRestoredActiveRooms') measuredAfterSeedMs += value
    }
    return {
      totalUntilFirstImmediateMs: totalUntilFirstImmediateMs === null ? null : round(totalUntilFirstImmediateMs),
      totalUntilFirstTimeout0Ms: totalUntilFirstTimeout0Ms === null ? null : round(totalUntilFirstTimeout0Ms),
      restoredRoomCount,
      workerCount,
      stepsMs: steps,
      measuredAfterSeedMs: round(measuredAfterSeedMs),
      unattributedAfterSeedMs: totalUntilFirstImmediateMs === null
        ? null
        : round(Math.max(0, totalUntilFirstImmediateMs - measuredAfterSeedMs)),
      shadow: shadow === null ? null : { ...shadow },
      schedulerStartupTick: schedulerStartupTick === null ? null : { ...schedulerStartupTick },
      coordinatorStartupTick: coordinatorStartupTick === null ? null : { ...coordinatorStartupTick },
    }
  }

  function readShadowSafely(read: () => StartupShadowTotals | null): StartupShadowTotals | null {
    try {
      const value = read()
      if (value === null) return null
      return {
        desiredRooms: finiteNumber(value.desiredRooms),
        confirmedRooms: finiteNumber(value.confirmedRooms),
        pendingOperations: finiteNumber(value.pendingOperations),
        scheduledRetries: finiteNumber(value.scheduledRetries),
        assignFailureCount: finiteNumber(value.assignFailureCount),
        assignRetryCount: finiteNumber(value.assignRetryCount),
      }
    } catch {
      return null
    }
  }

  return {
    measure,
    recordSince(step, startedAt) {
      try {
        record(step, now() - startedAt)
      } catch {
        // diagnostics — никога не влияе на startup
      }
    },
    now,
    armFirstLoopTurnProbes(input) {
      if (armedAt !== null) return
      try {
        armedAt = now()
        restoredRoomCount = input.restoredRoomCount
        workerCount = input.workerCount
        const startedAt = armedAt
        scheduleTimeout0(() => {
          if (totalUntilFirstTimeout0Ms === null) totalUntilFirstTimeout0Ms = now() - startedAt
        })
        scheduleImmediate(() => {
          if (logged) return
          logged = true
          try {
            totalUntilFirstImmediateMs = now() - startedAt
            shadow = readShadowSafely(input.readShadowTotals)
            log(`[startup-timeline] ${JSON.stringify(buildSnapshot())}`)
          } catch {
            // diagnostics — никога не влияе на runtime
          }
        })
      } catch {
        // diagnostics — никога не влияе на startup
      }
    },
    captureSchedulerTick(tick) {
      if (schedulerStartupTick !== null) return
      schedulerStartupTick = { durationMs: round(finiteNumber(tick.durationMs)) }
    },
    captureCoordinatorTick(tick) {
      if (coordinatorStartupTick !== null) return
      try {
        coordinatorStartupTick = {
          durationMs: round(finiteNumber(tick.durationMs)),
          tournaments: finiteNumber(tick.tournaments),
          sqlStatements: finiteNumber(tick.sqlStatements),
          sqlMs: round(finiteNumber(tick.sqlMs)),
          commitRooms: finiteNumber(tick.commitRooms),
          commitRoomMs: round(finiteNumber(tick.commitRoomMs)),
          processedMatches: finiteNumber(tick.processedMatches),
          notifyAssignments: finiteNumber(tick.notifyAssignments),
        }
      } catch {
        // diagnostics — никога не влияе на tournament логиката
      }
    },
    getSnapshot() {
      return armedAt === null && stepsMs.size === 0 ? null : buildSnapshot()
    },
  }
}
