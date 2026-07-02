import type { Seat } from '../core/serverTypes.js'
import type { ServerAuthoritativeGameState, ServerBidEntry } from '../game/serverGameTypes.js'
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
  collectorOnBiddingStart,
  collectorOnPlayingStart,
  collectorOnBidAction,
  collectorOnCardPlayed,
  collectorOnDealComplete,
  collectorOnAllPass,
  collectorDropDeal,
  collectorGetActiveDealCount,
} from './trainingRecorderCollector.js'
import type { TrainingActionOrigin, TrainingCompactPlayedCard } from './trainingRecorderTypes.js'

// ─── Rate-limited warnings ────────────────────────────────────────────────────

const WARN_RATE_LIMIT_MS = 60_000
let lastIntegrityWarnAt = 0
let lastTransitionWarnAt = 0

function warnIntegrity(violations: string[]): void {
  const now = Date.now()
  if (now - lastIntegrityWarnAt < WARN_RATE_LIMIT_MS) return
  lastIntegrityWarnAt = now
  console.warn(
    `[training-recorder] Integrity violations in deal record (${violations.length}): ${violations.slice(0, 3).join('; ')}`,
  )
}

function warnTransition(label: string): void {
  const now = Date.now()
  if (now - lastTransitionWarnAt < WARN_RATE_LIMIT_MS) return
  lastTransitionWarnAt = now
  console.warn(`[training-recorder] Invalid/unexpected transition: ${label}`)
}

// ─── Recorder interface ───────────────────────────────────────────────────────

export type TrainingRecorder = {
  // Called at deal-next-2 → bidding (5 cards per seat captured here)
  onBiddingStart(
    room: { id: string; seats: Record<Seat, { participant: { kind: string; identity: { profileId: string | null } } | null }> },
    state: ServerAuthoritativeGameState,
  ): void

  // Called at deal-last-3 → playing (8 cards per seat captured here)
  onPlayingStart(
    roomId: string,
    state: ServerAuthoritativeGameState,
  ): void

  onBidAction(
    roomId: string,
    stateBefore: ServerAuthoritativeGameState,
    stateAfter: ServerAuthoritativeGameState,
    addedEntry: ServerBidEntry,
    actionOrigin: TrainingActionOrigin,
  ): void

  onCardPlayed(
    roomId: string,
    stateBefore: ServerAuthoritativeGameState,
    stateAfter: ServerAuthoritativeGameState,
    addedPlay: TrainingCompactPlayedCard,
    actionOrigin: TrainingActionOrigin,
  ): void

  onDealComplete(
    roomId: string,
    state: ServerAuthoritativeGameState,
  ): void

  // Called on bidding → next-round (all pass). Writes a bidding_only record.
  onAllPass(
    roomId: string,
    state: ServerAuthoritativeGameState,
  ): void

  // Legacy: called to explicitly drop a deal without recording (disconnects, etc.)
  onDealAbandoned(roomId: string): void

  // Called when a state-diff helper (bid or card) cannot find a clean single
  // added action. Never throws, never blocks gameplay — observability only.
  onInvalidTransition(label: string): void

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
    duplicateDeals: 0,
    duplicateActions: 0,
    noActiveDeal: 0,
    invalidTransition: 0,
    currentFileBytes: 0,
    totalDirectoryBytes: null,
    lastWriteAt: null,
    lastErrorAt: null,
  }

  return {
    onBiddingStart: () => undefined,
    onPlayingStart: () => undefined,
    onBidAction: () => undefined,
    onCardPlayed: () => undefined,
    onDealComplete: () => undefined,
    onAllPass: () => undefined,
    onDealAbandoned: () => undefined,
    onInvalidTransition: () => undefined,
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

  function enqueueRecord(record: import('./trainingRecorderTypes.js').TrainingDealRecord): void {
    if (!record.integrity.valid) {
      warnIntegrity(record.integrity.violations)
    }

    const serialized = JSON.stringify(record)
    const MAX_BYTES = 500_000
    if (Buffer.byteLength(serialized, 'utf8') > MAX_BYTES) {
      console.warn(
        `[training-recorder] Record payload too large (${Buffer.byteLength(serialized, 'utf8')} bytes) — dropped`,
      )
      mutableMetrics.droppedRecords += 1
      return
    }

    queue.enqueue(serialized)
  }

  function onBiddingStart(
    room: { id: string; seats: Record<Seat, { participant: { kind: string; identity: { profileId: string | null } } | null }> },
    state: ServerAuthoritativeGameState,
  ): void {
    if (shutdownRequested) return
    safeRun('onBiddingStart', () => {
      const result = collectorOnBiddingStart(room, state, config.hashSecret)
      if (result === 'replaced_stale') {
        mutableMetrics.invalidTransition += 1
        warnTransition(`deal-next-2→bidding fired twice for room without finalizing (roomId redacted)`)
      }
    })
  }

  function onPlayingStart(
    roomId: string,
    state: ServerAuthoritativeGameState,
  ): void {
    if (shutdownRequested) return
    safeRun('onPlayingStart', () => {
      collectorOnPlayingStart(roomId, state)
    })
  }

  function onBidAction(
    roomId: string,
    stateBefore: ServerAuthoritativeGameState,
    stateAfter: ServerAuthoritativeGameState,
    addedEntry: ServerBidEntry,
    actionOrigin: TrainingActionOrigin,
  ): void {
    if (shutdownRequested) return
    safeRun('onBidAction', () => {
      const result = collectorOnBidAction(roomId, stateBefore, stateAfter, addedEntry, actionOrigin)
      if (result === 'duplicate') mutableMetrics.duplicateActions += 1
      if (result === 'no_active_deal') mutableMetrics.noActiveDeal += 1
    })
  }

  function onCardPlayed(
    roomId: string,
    stateBefore: ServerAuthoritativeGameState,
    stateAfter: ServerAuthoritativeGameState,
    addedPlay: TrainingCompactPlayedCard,
    actionOrigin: TrainingActionOrigin,
  ): void {
    if (shutdownRequested) return
    safeRun('onCardPlayed', () => {
      const result = collectorOnCardPlayed(roomId, stateBefore, stateAfter, addedPlay, actionOrigin)
      if (result === 'duplicate') mutableMetrics.duplicateActions += 1
      if (result === 'no_active_deal') mutableMetrics.noActiveDeal += 1
    })
  }

  function onDealComplete(
    roomId: string,
    state: ServerAuthoritativeGameState,
  ): void {
    if (shutdownRequested) return

    safeRun('onDealComplete', () => {
      const result = collectorOnDealComplete(roomId, state)

      if (result.kind === 'duplicate') {
        mutableMetrics.duplicateDeals += 1
        return
      }
      if (result.kind === 'no_active_deal') {
        mutableMetrics.noActiveDeal += 1
        return
      }
      if (result.kind !== 'enqueued') {
        // no_active_deal, not_ready, invalid — silent drop
        return
      }

      enqueueRecord(result.record)
    })
  }

  function onAllPass(
    roomId: string,
    state: ServerAuthoritativeGameState,
  ): void {
    if (shutdownRequested) return

    safeRun('onAllPass', () => {
      const result = collectorOnAllPass(roomId, state)

      if (result.kind === 'duplicate') {
        mutableMetrics.duplicateDeals += 1
        return
      }
      if (result.kind === 'no_active_deal') {
        mutableMetrics.noActiveDeal += 1
        return
      }
      if (result.kind !== 'enqueued') {
        return
      }

      enqueueRecord(result.record)
    })
  }

  function onDealAbandoned(roomId: string): void {
    safeRun('onDealAbandoned', () => {
      collectorDropDeal(roomId)
    })
  }

  function onInvalidTransition(label: string): void {
    mutableMetrics.invalidTransition += 1
    warnTransition(label)
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
    onBiddingStart,
    onPlayingStart,
    onBidAction,
    onCardPlayed,
    onDealComplete,
    onAllPass,
    onDealAbandoned,
    onInvalidTransition,
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
