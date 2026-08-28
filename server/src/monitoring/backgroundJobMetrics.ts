// Bounded, fixed-cardinality timing metrics за production background jobs —
// НЕ generic dynamic registry (виж diagnostic fix брифа). Всеки job е
// изрично именувано поле, никога Map с произволни ключове. Пази само
// count/totalDurationMs/maxDurationMs — никакво съдържание, IDs, stack traces.
//
// Цел: forensic evidence при CPU incident ("Matchmaking: 1x, max 846 ms"),
// не generic APM инструментация — затова само осмте job-а, идентифицирани
// като high-value suspects от forensic audit-а.
//
// DUAL-WINDOW ARCHITECTURE (виж final fix pass брифа §1/§3) — всеки record()
// пише едновременно в ДВА напълно независими accumulator-а:
//   - oneSecond: reset-ва се точно веднъж на всеки 1s forensic sample tick.
//   - tenSecond: reset-ва се точно веднъж на всеки 10s bucket tick.
// Преди тази промяна snapshotAndReset() никога не се викаше в production —
// peek() връщаше process-uptime-cumulative данни, представени като
// "activity during this incident" (FALSE ATTRIBUTION RISK). Сега
// snapshotOneSecondAndReset() е единственият коректен източник за spike
// forensic context.

export type BackgroundJobName =
  | 'matchmakingTick'
  | 'gameRuntimeTick'
  | 'tournamentCoordinatorTick'
  | 'tournamentSchedulerTick'
  | 'topicPoll'
  | 'lobbyChatPoll'
  | 'monitoringHistoryPersist'
  | 'monitoringHistoryPurge'

const JOB_NAMES: readonly BackgroundJobName[] = [
  'matchmakingTick',
  'gameRuntimeTick',
  'tournamentCoordinatorTick',
  'tournamentSchedulerTick',
  'topicPoll',
  'lobbyChatPoll',
  'monitoringHistoryPersist',
  'monitoringHistoryPurge',
]

export type BackgroundJobStat = {
  count: number
  totalDurationMs: number
  maxDurationMs: number
}

export type BackgroundJobStatsSnapshot = Record<BackgroundJobName, BackgroundJobStat>

function zeroStat(): BackgroundJobStat {
  return { count: 0, totalDurationMs: 0, maxDurationMs: 0 }
}

function zeroSnapshot(): BackgroundJobStatsSnapshot {
  const result = {} as BackgroundJobStatsSnapshot
  for (const name of JOB_NAMES) result[name] = zeroStat()
  return result
}

function snapshotForRead(stats: BackgroundJobStatsSnapshot): BackgroundJobStatsSnapshot {
  const result = {} as BackgroundJobStatsSnapshot
  for (const name of JOB_NAMES) result[name] = { ...stats[name] }
  return result
}

function recordInto(stats: BackgroundJobStatsSnapshot, name: BackgroundJobName, durationMs: number): void {
  const stat = stats[name]
  stat.count += 1
  stat.totalDurationMs += durationMs
  if (durationMs > stat.maxDurationMs) stat.maxDurationMs = durationMs
}

export type BackgroundJobMetrics = {
  // Обвива sync job callback — измерва performance.now() преди/след,
  // записва в count/totalDurationMs/maxDurationMs на ДВАТА прозореца. Не
  // променя поведението на job-а (връща/хвърля каквото job-ът връща/хвърля,
  // само след запис на duration-а в finally).
  recordSync<T>(name: BackgroundJobName, fn: () => T): T
  // За async jobs — обвива само измерването на цялото await duration,
  // без да променя поведението/timing-а на самия job.
  recordAsync<T>(name: BackgroundJobName, fn: () => Promise<T>): Promise<T>
  // Директен запис на вече измерена продължителност (напр. когато job-ът
  // вече прави собствено performance.now() измерване другаде). Пише в ДВАТА
  // прозореца едновременно.
  record(name: BackgroundJobName, durationMs: number): void
  // Completed one-second forensic window. Reset-ва САМО oneSecond state.
  snapshotOneSecondAndReset(): BackgroundJobStatsSnapshot
  // Completed ten-second forensic window (= стария snapshotAndReset()).
  // Reset-ва САМО tenSecond state.
  snapshotTenSecondAndReset(): BackgroundJobStatsSnapshot
  /** Alias за snapshotTenSecondAndReset(), запазен за source-compat. */
  snapshotAndReset(): BackgroundJobStatsSnapshot
  // Non-destructive read на tenSecond window — НЕ използвай за spike
  // forensic context (виж review findings, FALSE ATTRIBUTION RISK).
  peek(): BackgroundJobStatsSnapshot
}

export function createBackgroundJobMetrics(
  nowMs: () => number = () => performance.now(),
): BackgroundJobMetrics {
  let oneSecond = zeroSnapshot()
  let tenSecond = zeroSnapshot()

  function record(name: BackgroundJobName, durationMs: number): void {
    recordInto(oneSecond, name, durationMs)
    recordInto(tenSecond, name, durationMs)
  }

  function recordSync<T>(name: BackgroundJobName, fn: () => T): T {
    const started = nowMs()
    try {
      return fn()
    } finally {
      record(name, nowMs() - started)
    }
  }

  async function recordAsync<T>(name: BackgroundJobName, fn: () => Promise<T>): Promise<T> {
    const started = nowMs()
    try {
      return await fn()
    } finally {
      record(name, nowMs() - started)
    }
  }

  return {
    recordSync,
    recordAsync,
    record,
    snapshotOneSecondAndReset() {
      const result = snapshotForRead(oneSecond)
      oneSecond = zeroSnapshot()
      return result
    },
    snapshotTenSecondAndReset() {
      const result = snapshotForRead(tenSecond)
      tenSecond = zeroSnapshot()
      return result
    },
    snapshotAndReset() {
      const result = snapshotForRead(tenSecond)
      tenSecond = zeroSnapshot()
      return result
    },
    peek() {
      return snapshotForRead(tenSecond)
    },
  }
}

export function emptyBackgroundJobStatsSnapshot(): BackgroundJobStatsSnapshot {
  return zeroSnapshot()
}
