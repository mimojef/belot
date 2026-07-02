import type { Seat } from '../core/serverTypes.js'
import type { ServerAuthoritativeGameState } from '../game/serverGameTypes.js'
import {
  loadTrainingRecorderConfig,
  validateTrainingRecorderConfig,
  type TrainingRecorderConfig,
} from './trainingRecorderConfig.js'
import {
  createMutableMetrics,
  snapshotMetrics,
  type MutableTrainingRecorderMetrics,
  type TrainingRecorderMetrics,
} from './trainingRecorderMetrics.js'
import { createTrainingRecorderWriter } from './trainingRecorderWriter.js'
import { createTrainingRecorderQueue, type TrainingRecorderQueue } from './trainingRecorderQueue.js'
import {
  collectorOnDealStart,
  collectorOnBidAction,
  collectorOnCardPlayed,
  collectorOnDealComplete,
  collectorDropDeal,
  collectorGetActiveDealCount,
} from './trainingRecorderCollector.js'

// ─── Rate-limited integrity warning ──────────────────────────────────────────

const INTEGRITY_WARN_RATE_MS = 60_000
let lastIntegrityWarnAt = 0

function warnIntegrity(violations: string[]): void {
  const now = Date.now()
  if (now - lastIntegrityWarnAt < INTEGRITY_WARN_RATE_MS) return
  lastIntegrityWarnAt = now
  console.warn(
    `[training-recorder] Integrity violations in deal record (${violations.length}): ${violations.slice(0, 3).join('; ')}`,
  )
}

// ─── Recorder interface ───────────────────────────────────────────────────────

export type TrainingRecorder = {
  onDealStart(
    room: { id: string; seats: Record<Seat, { participant: { kind: string; identity: { profileId: string | null } } | null }> },
    state: ServerAuthoritativeGameState,
    dealIndex: number,
  ): void

  onBidAction(
    roomId: string,
    dealIndex: number,
    state: ServerAuthoritativeGameState,
    seat: Seat,
    wasTimedOut: boolean,
  ): void

  onCardPlayed(
    roomId: string,
    dealIndex: number,
    stateBefore: ServerAuthoritativeGameState,
    stateAfter: ServerAuthoritativeGameState,
    seat: Seat,
    cardId: string,
    wasTimedOut: boolean,
  ): void

  onDealComplete(
    roomId: string,
    dealIndex: number,
    state: ServerAuthoritativeGameState,
  ): void

  onDealAbandoned(roomId: string, dealIndex: number): void

  getMetrics(): TrainingRecorderMetrics

  shutdown(timeoutMs?: number): Promise<void>
}

// ─── Noop recorder (used when disabled) ──────────────────────────────────────

function createNoopRecorder(): TrainingRecorder {
  const metrics: TrainingRecorderMetrics = {
    enabled: false,
    healthy: true,
    queuedRecords: 0,
    writtenRecords: 0,
    droppedRecords: 0,
    failedRecords: 0,
    duplicateRecords: 0,
    currentFileBytes: 0,
    totalDirectoryBytes: null,
    lastWriteAt: null,
    lastErrorAt: null,
  }

  return {
    onDealStart: () => undefined,
    onBidAction: () => undefined,
    onCardPlayed: () => undefined,
    onDealComplete: () => undefined,
    onDealAbandoned: () => undefined,
    getMetrics: () => metrics,
    shutdown: async () => undefined,
  }
}

// ─── Active recorder ──────────────────────────────────────────────────────────

function createActiveRecorder(
  config: TrainingRecorderConfig,
): TrainingRecorder {
  const mutableMetrics: MutableTrainingRecorderMetrics = createMutableMetrics()
  const writer = createTrainingRecorderWriter(config, mutableMetrics)
  const queue = createTrainingRecorderQueue(config.maxQueue, writer, mutableMetrics)
  let shutdownRequested = false

  function safeRun(label: string, fn: () => void): void {
    try {
      fn()
    } catch (error) {
      console.error(`[training-recorder] ${label} error:`, error)
    }
  }

  function onDealStart(
    room: { id: string; seats: Record<Seat, { participant: { kind: string; identity: { profileId: string | null } } | null }> },
    state: ServerAuthoritativeGameState,
    dealIndex: number,
  ): void {
    if (shutdownRequested) return
    safeRun('onDealStart', () => {
      collectorOnDealStart(room, state, dealIndex, config.hashSecret)
    })
  }

  function onBidAction(
    roomId: string,
    dealIndex: number,
    state: ServerAuthoritativeGameState,
    seat: Seat,
    wasTimedOut: boolean,
  ): void {
    if (shutdownRequested) return
    safeRun('onBidAction', () => {
      collectorOnBidAction(roomId, dealIndex, state, seat, wasTimedOut)
    })
  }

  function onCardPlayed(
    roomId: string,
    dealIndex: number,
    stateBefore: ServerAuthoritativeGameState,
    stateAfter: ServerAuthoritativeGameState,
    seat: Seat,
    cardId: string,
    wasTimedOut: boolean,
  ): void {
    if (shutdownRequested) return
    safeRun('onCardPlayed', () => {
      collectorOnCardPlayed(roomId, dealIndex, stateBefore, stateAfter, seat, cardId, wasTimedOut)
    })
  }

  function onDealComplete(
    roomId: string,
    dealIndex: number,
    state: ServerAuthoritativeGameState,
  ): void {
    if (shutdownRequested) return

    safeRun('onDealComplete', () => {
      const record = collectorOnDealComplete(roomId, dealIndex, state)

      if (record === null) {
        mutableMetrics.duplicateRecords += 1
        return
      }

      if (!record.integrity.valid) {
        warnIntegrity(record.integrity.violations)
        // Still enqueue the record but mark it so downstream can filter
        // (integrity field is embedded in the record itself)
      }

      const serialized = JSON.stringify(record)

      // Payload size guard (writer also checks, but fail-open here)
      const MAX_BYTES = 500_000
      if (Buffer.byteLength(serialized, 'utf8') > MAX_BYTES) {
        console.warn(
          `[training-recorder] Record payload too large (${Buffer.byteLength(serialized, 'utf8')} bytes) — dropped`,
        )
        mutableMetrics.droppedRecords += 1
        return
      }

      queue.enqueue(serialized)
    })
  }

  function onDealAbandoned(roomId: string, dealIndex: number): void {
    safeRun('onDealAbandoned', () => {
      collectorDropDeal(roomId, dealIndex)
    })
  }

  function getMetrics(): TrainingRecorderMetrics {
    return snapshotMetrics(true, mutableMetrics, queue.getSize())
  }

  async function shutdown(timeoutMs: number = 3_000): Promise<void> {
    shutdownRequested = true
    try {
      await queue.shutdown(timeoutMs)
    } catch (error) {
      console.error('[training-recorder] Shutdown error:', error)
    }
  }

  return {
    onDealStart,
    onBidAction,
    onCardPlayed,
    onDealComplete,
    onDealAbandoned,
    getMetrics,
    shutdown,
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createTrainingRecorder(workerId: string = '0'): TrainingRecorder {
  const config = loadTrainingRecorderConfig(workerId)

  if (!config.enabled) {
    return createNoopRecorder()
  }

  const validation = validateTrainingRecorderConfig(config)

  if (!validation.ok) {
    console.warn(validation.reason)
    return createNoopRecorder()
  }

  console.log(
    `[training-recorder] Enabled — path=${config.storagePath} maxFileMb=${config.maxFileMb} maxTotalGb=${config.maxTotalGb} retentionDays=${config.retentionDays}`,
  )

  return createActiveRecorder(config)
}

// ─── Singleton for main process ───────────────────────────────────────────────

let _globalRecorder: TrainingRecorder | null = null

export function getGlobalTrainingRecorder(): TrainingRecorder {
  if (_globalRecorder === null) {
    _globalRecorder = createTrainingRecorder('0')
  }
  return _globalRecorder
}

export function setGlobalTrainingRecorder(recorder: TrainingRecorder): void {
  _globalRecorder = recorder
}
