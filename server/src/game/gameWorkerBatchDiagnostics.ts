// Phase 0C — worker-side diagnostics за един compute_tick_rooms batch.
//
// Worker-ът ги изчислява със СОБСТВЕНИЯ си монотонен часовник (само
// продължителности — никакви абсолютни timestamps, никакво сравнение на
// performance.now() между threads) и ги праща като optional поле
// `diagnostics` в compute_tick_rooms_response. Main страната ги приема САМО
// през sanitizeGameWorkerBatchDiagnostics(): липсващи/невалидни diagnostics
// → null и никога не влияят на gameplay резултатите.
//
// Съдържание: само числа + bounded enum-и (phase/outcome). Без profile IDs,
// имена, ръце, payload. slowestRoomId е optional и присъства само при бавен
// batch (>= SLOW_BATCH_ROOM_ID_THRESHOLD_MS); main страната го приема само ако
// съвпада с room от самия request. Никога не е metric key.

import { AUTHORITATIVE_PHASE_TYPES } from './serverPhaseTypes.js'
import type { ServerRoom } from '../core/serverTypes.js'

export const GAME_WORKER_ROOM_PHASE_LABELS = [
  ...AUTHORITATIVE_PHASE_TYPES,
  // authoritativeState е bootstrap ({ kind }) или null
  'bootstrap',
  'none',
  // неочаквана форма — никога raw стойност
  'unknown',
] as const

export type GameWorkerRoomPhaseLabel = (typeof GAME_WORKER_ROOM_PHASE_LABELS)[number]

export const GAME_WORKER_ROOM_OUTCOMES = ['unchanged', 'advanced', 'compute_failed', 'not_assigned'] as const

export type GameWorkerRoomOutcome = (typeof GAME_WORKER_ROOM_OUTCOMES)[number]

// slowestRoomId се изпраща само за batch с worker wall >= този праг.
export const SLOW_BATCH_ROOM_ID_THRESHOLD_MS = 100

export type GameWorkerBatchDiagnostics = {
  // Worker wall: от началото до края на обработката на batch-а в worker-а
  // (validation на съобщението вече е минала; без deserialization/postMessage).
  batchWallMs: number
  // CPU на worker THREAD-а за същия интервал (process.threadCpuUsage delta,
  // user+system). null ако API-то липсва — НЕ се заменя с process-wide CPU.
  batchCpuMs: number | null
  roomCount: number
  sumRoomComputeMs: number
  maxRoomComputeMs: number
  // Най-бавната room операция в batch-а (null ако batch-ът е без rooms).
  slowestRoomPhase: GameWorkerRoomPhaseLabel | null
  slowestRoomNextPhase: GameWorkerRoomPhaseLabel | null
  slowestRoomOutcome: GameWorkerRoomOutcome | null
  slowestRoomId?: string
  // „Долу картите“ solver (computeServerSweepEligibility) в този batch.
  // Optional: стар worker / batch без нито едно извикване.
  sweepEligibility?: GameWorkerSweepEligibilityStats
}

export type GameWorkerSweepEligibilityStats = {
  count: number
  totalMs: number
  maxMs: number
  guardHits: number
  maxNodes: number
}

const PHASE_SET: ReadonlySet<string> = new Set(GAME_WORKER_ROOM_PHASE_LABELS)
const OUTCOME_SET: ReadonlySet<string> = new Set(GAME_WORKER_ROOM_OUTCOMES)
const AUTHORITATIVE_PHASE_SET: ReadonlySet<string> = new Set(AUTHORITATIVE_PHASE_TYPES)

export function resolveGameWorkerRoomPhaseLabel(room: ServerRoom | null | undefined): GameWorkerRoomPhaseLabel {
  try {
    const state = room?.game?.authoritativeState
    if (state === null || state === undefined) return 'none'
    if ('kind' in state) return 'bootstrap'
    const phase = (state as { phase?: unknown }).phase
    return typeof phase === 'string' && AUTHORITATIVE_PHASE_SET.has(phase) ? (phase as GameWorkerRoomPhaseLabel) : 'unknown'
  } catch {
    return 'unknown'
  }
}

export type ThreadCpuUsageFn = (previous?: NodeJS.CpuUsage) => NodeJS.CpuUsage

// process.threadCpuUsage (Node >= 23.9 / 22.19) — CPU само на текущия thread.
// process.cpuUsage() в worker връща CPU на целия процес (всички threads), затова
// НЕ се ползва като fallback.
export function getThreadCpuUsageFn(): ThreadCpuUsageFn | null {
  const fn = (process as unknown as { threadCpuUsage?: ThreadCpuUsageFn }).threadCpuUsage
  return typeof fn === 'function' ? fn.bind(process) : null
}

export type GameWorkerBatchDiagnosticsCollector = {
  // Записва една room операция (startedAt = now() преди compute-а).
  recordRoom(startedAt: number, roomId: string, room: ServerRoom, nextRoom: ServerRoom | null, outcome: GameWorkerRoomOutcome): void
  // Едно извикване на sweep solver-а (само числа).
  recordSweepEligibility(observation: { durationMs: number; nodes: number; guardHit: boolean }): void
  finish(): GameWorkerBatchDiagnostics
}

// Collector за един batch. now() е монотонен часовник на worker-а.
// Изчисляването никога не хвърля към caller-а (виж gameWorkerThread).
export function startGameWorkerBatchDiagnostics(
  now: () => number,
  threadCpuUsage: ThreadCpuUsageFn | null,
): GameWorkerBatchDiagnosticsCollector {
  const startedAt = now()
  const cpuStart = threadCpuUsage !== null ? threadCpuUsage() : null
  let roomCount = 0
  let sumRoomComputeMs = 0
  let maxRoomComputeMs = 0
  let slowest: { roomId: string; room: ServerRoom; nextRoom: ServerRoom | null; outcome: GameWorkerRoomOutcome } | null = null
  let sweep: GameWorkerSweepEligibilityStats | null = null

  return {
    recordSweepEligibility(observation) {
      if (!isDuration(observation.durationMs) || !isCount(observation.nodes)) return
      sweep ??= { count: 0, totalMs: 0, maxMs: 0, guardHits: 0, maxNodes: 0 }
      sweep.count += 1
      sweep.totalMs += observation.durationMs
      if (observation.durationMs > sweep.maxMs) sweep.maxMs = observation.durationMs
      if (observation.guardHit) sweep.guardHits += 1
      if (observation.nodes > sweep.maxNodes) sweep.maxNodes = observation.nodes
    },
    recordRoom(roomStartedAt, roomId, room, nextRoom, outcome) {
      const durationMs = now() - roomStartedAt
      roomCount += 1
      sumRoomComputeMs += durationMs
      if (slowest === null || durationMs > maxRoomComputeMs) {
        maxRoomComputeMs = durationMs
        // Само референции — phase label-ите се извличат веднъж във finish().
        slowest = { roomId, room, nextRoom, outcome }
      }
    },
    finish() {
      const batchWallMs = now() - startedAt
      let batchCpuMs: number | null = null
      if (threadCpuUsage !== null && cpuStart !== null) {
        const delta = threadCpuUsage(cpuStart)
        batchCpuMs = (delta.user + delta.system) / 1000
      }
      const diagnostics: GameWorkerBatchDiagnostics = {
        batchWallMs,
        batchCpuMs,
        roomCount,
        sumRoomComputeMs,
        maxRoomComputeMs,
        slowestRoomPhase: slowest === null ? null : resolveGameWorkerRoomPhaseLabel(slowest.room),
        slowestRoomNextPhase: slowest === null
          ? null
          : resolveGameWorkerRoomPhaseLabel(slowest.nextRoom ?? slowest.room),
        slowestRoomOutcome: slowest === null ? null : slowest.outcome,
      }
      if (slowest !== null && batchWallMs >= SLOW_BATCH_ROOM_ID_THRESHOLD_MS) diagnostics.slowestRoomId = slowest.roomId
      if (sweep !== null) diagnostics.sweepEligibility = { ...sweep }
      return diagnostics
    },
  }
}

function isDuration(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

// Невалидно sweep поле се изпуска самостоятелно (останалите diagnostics остават).
function sanitizeSweepEligibilityStats(raw: unknown): GameWorkerSweepEligibilityStats | null {
  if (raw === null || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  if (!isCount(value['count']) || !isDuration(value['totalMs']) || !isDuration(value['maxMs'])) return null
  if (!isCount(value['guardHits']) || !isCount(value['maxNodes'])) return null
  if (value['guardHits'] > value['count']) return null
  return {
    count: value['count'],
    totalMs: value['totalMs'],
    maxMs: value['maxMs'],
    guardHits: value['guardHits'],
    maxNodes: value['maxNodes'],
  }
}

// Main-side строга валидация. Всичко невалидно → null (diagnostics липсват),
// никога exception. slowestRoomId се запазва само ако е от expectedRoomIds.
export function sanitizeGameWorkerBatchDiagnostics(
  raw: unknown,
  expectedRoomIds: ReadonlySet<string>,
): GameWorkerBatchDiagnostics | null {
  try {
    if (raw === null || typeof raw !== 'object') return null
    const value = raw as Record<string, unknown>
    if (!isDuration(value['batchWallMs']) || !isDuration(value['sumRoomComputeMs']) || !isDuration(value['maxRoomComputeMs'])) return null
    const batchCpuMs = value['batchCpuMs']
    if (batchCpuMs !== null && !isDuration(batchCpuMs)) return null
    const roomCount = value['roomCount']
    if (typeof roomCount !== 'number' || !Number.isSafeInteger(roomCount) || roomCount < 0) return null
    const phase = value['slowestRoomPhase']
    const nextPhase = value['slowestRoomNextPhase']
    const outcome = value['slowestRoomOutcome']
    if (phase !== null && (typeof phase !== 'string' || !PHASE_SET.has(phase))) return null
    if (nextPhase !== null && (typeof nextPhase !== 'string' || !PHASE_SET.has(nextPhase))) return null
    if (outcome !== null && (typeof outcome !== 'string' || !OUTCOME_SET.has(outcome))) return null
    const diagnostics: GameWorkerBatchDiagnostics = {
      batchWallMs: value['batchWallMs'],
      batchCpuMs: batchCpuMs as number | null,
      roomCount,
      sumRoomComputeMs: value['sumRoomComputeMs'],
      maxRoomComputeMs: value['maxRoomComputeMs'],
      slowestRoomPhase: phase as GameWorkerRoomPhaseLabel | null,
      slowestRoomNextPhase: nextPhase as GameWorkerRoomPhaseLabel | null,
      slowestRoomOutcome: outcome as GameWorkerRoomOutcome | null,
    }
    const roomId = value['slowestRoomId']
    if (typeof roomId === 'string' && expectedRoomIds.has(roomId)) diagnostics.slowestRoomId = roomId
    const sweep = sanitizeSweepEligibilityStats(value['sweepEligibility'])
    if (sweep !== null) diagnostics.sweepEligibility = sweep
    return diagnostics
  } catch {
    return null
  }
}
