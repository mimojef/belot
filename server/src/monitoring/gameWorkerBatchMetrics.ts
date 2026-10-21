// Phase 0C — bounded worker batch forensics (main страна).
//
// За всеки compute_tick_rooms batch:
//   roundTripWallMs        — main: непосредствено преди postMessage → начало
//                            на обработката на response-а (монотонен часовник
//                            на main thread-а)
//   requestPostMessageMs   — main: синхронното postMessage (structured clone
//                            на request-а); част от roundTrip
//   workerBatchWallMs      — worker: обработка на batch-а (собствен часовник)
//   workerBatchCpuMs       — worker THREAD CPU за същия интервал
//   unaccountedRoundTripMs = max(0, roundTripWallMs − workerBatchWallMs):
//                            postMessage/clone на request-а, чакане в опашката
//                            на worker-а (вкл. deserialization), clone на
//                            response-а и чакане main event loop-а да поеме
//                            response-а. Не се разделя допълнително — това
//                            изисква сравнение на часовници между threads.
//
// Двете страни мерят само ПРОДЪЛЖИТЕЛНОСТИ със собствените си часовници;
// никога не се сравняват абсолютни timestamps между threads.
//
// Bounded: ключът е worker индекс ('w1'..'w32', иначе 'other'); phase/outcome
// са фиксирани enum-и; slowestRoomId е стойност (не ключ), само при бавен
// batch. Dual-window семантика като mainThreadTimingMetrics: 1s прозорец за
// spike sample-а и 10s прозорец за bucket-а.

import type { GameWorkerTickBatchTiming } from '../game/createGameWorkerTickClient.js'
import type { GameWorkerRoomOutcome, GameWorkerRoomPhaseLabel } from '../game/gameWorkerBatchDiagnostics.js'

export const MAX_TRACKED_WORKERS = 32
export const GAME_WORKER_OVERFLOW_KEY = 'other'

export type GameWorkerBatchWindowStat = {
  batchCount: number
  roomCount: number
  timeoutCount: number
  errorCount: number
  // batch-ове без валидни worker diagnostics (стар worker / невалидни данни)
  diagnosticsMissingCount: number
  roundTripWallTotalMs: number
  roundTripWallMaxMs: number
  requestPostMessageTotalMs: number
  requestPostMessageMaxMs: number
  workerBatchWallTotalMs: number
  workerBatchWallMaxMs: number
  // CPU агрегати само от batch-ове с наличен thread CPU
  workerBatchCpuCount: number
  workerBatchCpuTotalMs: number
  workerBatchCpuMaxMs: number
  unaccountedRoundTripTotalMs: number
  unaccountedRoundTripMaxMs: number
  sumRoomComputeTotalMs: number
  maxRoomComputeMs: number
  slowestRoomPhase: GameWorkerRoomPhaseLabel | null
  slowestRoomNextPhase: GameWorkerRoomPhaseLabel | null
  slowestRoomOutcome: GameWorkerRoomOutcome | null
  slowestRoomId: string | null
  // кумулативни "поне N ms" броячи по roundTripWallMs
  roundTripSlow50: number
  roundTripSlow100: number
  roundTripSlow250: number
  roundTripSlow500: number
  // същите прагове по workerBatchWallMs
  workerWallSlow50: number
  workerWallSlow100: number
  workerWallSlow250: number
  workerWallSlow500: number
  // „Долу картите“ solver (computeServerSweepEligibility) в worker-а.
  sweepEligibilityCount: number
  sweepEligibilityTotalMs: number
  sweepEligibilityMaxMs: number
  sweepEligibilityGuardHits: number
  sweepEligibilityMaxNodes: number
}

// Sparse: само worker-и с поне един batch/failure в прозореца.
export type GameWorkerBatchSnapshot = Record<string, GameWorkerBatchWindowStat>

export type GameWorkerBatchMetrics = {
  record(workerIndex: number, timing: GameWorkerTickBatchTiming): void
  snapshotOneSecondAndReset(): GameWorkerBatchSnapshot
  snapshotTenSecondAndReset(): GameWorkerBatchSnapshot
  peek(): GameWorkerBatchSnapshot
}

export function resolveGameWorkerKey(workerIndex: unknown): string {
  return typeof workerIndex === 'number' && Number.isInteger(workerIndex) && workerIndex >= 0 && workerIndex < MAX_TRACKED_WORKERS
    ? `w${workerIndex + 1}`
    : GAME_WORKER_OVERFLOW_KEY
}

function zeroStat(): GameWorkerBatchWindowStat {
  return {
    batchCount: 0,
    roomCount: 0,
    timeoutCount: 0,
    errorCount: 0,
    diagnosticsMissingCount: 0,
    roundTripWallTotalMs: 0,
    roundTripWallMaxMs: 0,
    requestPostMessageTotalMs: 0,
    requestPostMessageMaxMs: 0,
    workerBatchWallTotalMs: 0,
    workerBatchWallMaxMs: 0,
    workerBatchCpuCount: 0,
    workerBatchCpuTotalMs: 0,
    workerBatchCpuMaxMs: 0,
    unaccountedRoundTripTotalMs: 0,
    unaccountedRoundTripMaxMs: 0,
    sumRoomComputeTotalMs: 0,
    maxRoomComputeMs: 0,
    slowestRoomPhase: null,
    slowestRoomNextPhase: null,
    slowestRoomOutcome: null,
    slowestRoomId: null,
    roundTripSlow50: 0,
    roundTripSlow100: 0,
    roundTripSlow250: 0,
    roundTripSlow500: 0,
    workerWallSlow50: 0,
    workerWallSlow100: 0,
    workerWallSlow250: 0,
    workerWallSlow500: 0,
    sweepEligibilityCount: 0,
    sweepEligibilityTotalMs: 0,
    sweepEligibilityMaxMs: 0,
    sweepEligibilityGuardHits: 0,
    sweepEligibilityMaxNodes: 0,
  }
}

function isDuration(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function recordInto(window: Map<string, GameWorkerBatchWindowStat>, key: string, timing: GameWorkerTickBatchTiming): void {
  let stat = window.get(key)
  if (stat === undefined) {
    stat = zeroStat()
    window.set(key, stat)
  }
  const roomCount = Number.isSafeInteger(timing.roomCount) && timing.roomCount >= 0 ? timing.roomCount : 0

  if (timing.outcome !== 'completed') {
    if (timing.outcome === 'timeout') stat.timeoutCount += 1
    else stat.errorCount += 1
    return
  }
  if (!isDuration(timing.roundTripWallMs)) return

  const roundTrip = timing.roundTripWallMs
  stat.batchCount += 1
  stat.roomCount += roomCount
  stat.roundTripWallTotalMs += roundTrip
  if (roundTrip > stat.roundTripWallMaxMs) stat.roundTripWallMaxMs = roundTrip
  if (roundTrip >= 50) {
    stat.roundTripSlow50 += 1
    if (roundTrip >= 100) {
      stat.roundTripSlow100 += 1
      if (roundTrip >= 250) {
        stat.roundTripSlow250 += 1
        if (roundTrip >= 500) stat.roundTripSlow500 += 1
      }
    }
  }
  if (isDuration(timing.requestPostMessageMs)) {
    stat.requestPostMessageTotalMs += timing.requestPostMessageMs
    if (timing.requestPostMessageMs > stat.requestPostMessageMaxMs) stat.requestPostMessageMaxMs = timing.requestPostMessageMs
  }

  const diagnostics = timing.diagnostics
  if (diagnostics === null) {
    stat.diagnosticsMissingCount += 1
    return
  }
  const workerWall = diagnostics.batchWallMs
  stat.workerBatchWallTotalMs += workerWall
  if (workerWall > stat.workerBatchWallMaxMs) stat.workerBatchWallMaxMs = workerWall
  if (workerWall >= 50) {
    stat.workerWallSlow50 += 1
    if (workerWall >= 100) {
      stat.workerWallSlow100 += 1
      if (workerWall >= 250) {
        stat.workerWallSlow250 += 1
        if (workerWall >= 500) stat.workerWallSlow500 += 1
      }
    }
  }
  if (diagnostics.batchCpuMs !== null) {
    stat.workerBatchCpuCount += 1
    stat.workerBatchCpuTotalMs += diagnostics.batchCpuMs
    if (diagnostics.batchCpuMs > stat.workerBatchCpuMaxMs) stat.workerBatchCpuMaxMs = diagnostics.batchCpuMs
  }
  const unaccounted = Math.max(0, roundTrip - workerWall)
  stat.unaccountedRoundTripTotalMs += unaccounted
  if (unaccounted > stat.unaccountedRoundTripMaxMs) stat.unaccountedRoundTripMaxMs = unaccounted
  const sweep = diagnostics.sweepEligibility
  if (sweep !== undefined) {
    stat.sweepEligibilityCount += sweep.count
    stat.sweepEligibilityTotalMs += sweep.totalMs
    if (sweep.maxMs > stat.sweepEligibilityMaxMs) stat.sweepEligibilityMaxMs = sweep.maxMs
    stat.sweepEligibilityGuardHits += sweep.guardHits
    if (sweep.maxNodes > stat.sweepEligibilityMaxNodes) stat.sweepEligibilityMaxNodes = sweep.maxNodes
  }
  stat.sumRoomComputeTotalMs += diagnostics.sumRoomComputeMs
  if (diagnostics.slowestRoomOutcome !== null && (stat.slowestRoomOutcome === null || diagnostics.maxRoomComputeMs > stat.maxRoomComputeMs)) {
    stat.maxRoomComputeMs = diagnostics.maxRoomComputeMs
    stat.slowestRoomPhase = diagnostics.slowestRoomPhase
    stat.slowestRoomNextPhase = diagnostics.slowestRoomNextPhase
    stat.slowestRoomOutcome = diagnostics.slowestRoomOutcome
    stat.slowestRoomId = diagnostics.slowestRoomId ?? null
  }
}

function snapshotWindow(window: Map<string, GameWorkerBatchWindowStat>): GameWorkerBatchSnapshot {
  const result: GameWorkerBatchSnapshot = {}
  for (const [key, stat] of window) result[key] = { ...stat }
  return result
}

export function createGameWorkerBatchMetrics(): GameWorkerBatchMetrics {
  let oneSecond = new Map<string, GameWorkerBatchWindowStat>()
  let tenSecond = new Map<string, GameWorkerBatchWindowStat>()

  return {
    record(workerIndex, timing) {
      try {
        if (timing === null || typeof timing !== 'object') return
        const key = resolveGameWorkerKey(workerIndex)
        recordInto(oneSecond, key, timing)
        recordInto(tenSecond, key, timing)
      } catch {
        // monitoring — никога не влияе на worker tick-а
      }
    },
    snapshotOneSecondAndReset() {
      const result = snapshotWindow(oneSecond)
      oneSecond = new Map()
      return result
    },
    snapshotTenSecondAndReset() {
      const result = snapshotWindow(tenSecond)
      tenSecond = new Map()
      return result
    },
    peek() {
      return snapshotWindow(tenSecond)
    },
  }
}
