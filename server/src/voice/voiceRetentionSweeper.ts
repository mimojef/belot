// Гласов чат — T1: гарантирано периодично изтриване на личните данни.
//
// Изпълнява се при старт на backend-а (от voiceChatService.boot) и на всеки
// 6 часа. Две фази, всяка на малки партиди в отделни кратки транзакции
// (BEGIN IMMEDIATE, busy_timeout на store-а), с отстъпване на event loop-а
// между партидите — игровият сървър не се блокира:
//
//   1. ЛИЧНИ ДАННИ — приключилите участия (voice_table_memberships) и
//      наследените voice_speaking_grants на маси, окончателно освободени преди
//      30 дни. НЕЗАВИСИМО от статуса на LiveKit стаите. Активни маси и
//      активни участия никога не се пипат.
//   2. ТЕХНИЧЕСКИ ЗАПИСИ — освободените маси без лични данни (voice_tables +
//      voice_room_generations), само след потвърдено изтриване на стаите
//      (нужни са за окончателното изтриване на LiveKit стаите и сигурността).
//
// При SQLITE_BUSY: ограничени повторни опити с нарастваща пауза; ако базата
// остане заета, текущото преминаване спира и данните се изтриват при
// следващото (най-късно след 6 часа). Нито един опит не се „губи“ — изборът
// се прави наново по `released_at` при всяко преминаване.

import type { VoiceChatStore } from './voiceChatStore.js'

export const VOICE_RETENTION_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000
export const VOICE_PERSONAL_DATA_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
export const VOICE_RETENTION_BATCH_SIZE = 100
/** Таван на партидите за едно преминаване (100 × 200 = 20 000 реда). */
export const VOICE_RETENTION_MAX_BATCHES_PER_RUN = 200
export const VOICE_RETENTION_BUSY_RETRY_DELAYS_MS: readonly number[] = [500, 2_000, 10_000, 30_000]

export type VoiceRetentionScheduler = {
  setTimeout: (callback: () => void, delayMs: number) => unknown
  clearTimeout: (handle: unknown) => void
}

export type VoiceRetentionRunResult = {
  status: 'done' | 'busy_gave_up' | 'batch_cap_reached' | 'disposed'
  memberships: number
  grants: number
  tables: number
  batches: number
  busyRetries: number
}

export type VoiceRetentionSweeper = {
  /** Първо преминаване веднага (асинхронно), после на всеки интервал. Идемпотентно. */
  start: () => void
  /** Едно преминаване; паралелно извикване връща текущото. */
  runNow: () => Promise<VoiceRetentionRunResult>
  dispose: () => void
  stats: () => { runs: number; lastRunAt: string | null; lastResult: VoiceRetentionRunResult | null }
}

export function createVoiceRetentionSweeper(deps: {
  store: Pick<VoiceChatStore, 'purgeEndedVoiceMemberships' | 'purgeReleasedVoiceTables'>
  scheduler: VoiceRetentionScheduler
  now?: () => number
  log?: (line: string) => void
  intervalMs?: number
  retentionMs?: number
  batchSize?: number
  maxBatchesPerRun?: number
  busyRetryDelaysMs?: readonly number[]
  /** Отстъпване на event loop-а между партидите (тестове: синхронно). */
  yieldToEventLoop?: () => Promise<void>
}): VoiceRetentionSweeper {
  const now = deps.now ?? (() => Date.now())
  const log = deps.log ?? ((line: string) => console.log(line))
  const intervalMs = deps.intervalMs ?? VOICE_RETENTION_SWEEP_INTERVAL_MS
  const retentionMs = deps.retentionMs ?? VOICE_PERSONAL_DATA_RETENTION_MS
  const batchSize = deps.batchSize ?? VOICE_RETENTION_BATCH_SIZE
  const maxBatches = deps.maxBatchesPerRun ?? VOICE_RETENTION_MAX_BATCHES_PER_RUN
  const busyDelays = deps.busyRetryDelaysMs ?? VOICE_RETENTION_BUSY_RETRY_DELAYS_MS
  const yieldToEventLoop = deps.yieldToEventLoop ?? (() => new Promise<void>((resolve) => setImmediate(resolve)))

  let started = false
  let disposed = false
  let timer: unknown = null
  let inFlight: Promise<VoiceRetentionRunResult> | null = null
  const pendingSleeps = new Set<{ handle: unknown; resolve: () => void }>()
  let runs = 0
  let lastRunAt: string | null = null
  let lastResult: VoiceRetentionRunResult | null = null

  function sleep(delayMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const entry = { handle: null as unknown, resolve }
      entry.handle = deps.scheduler.setTimeout(() => {
        pendingSleeps.delete(entry)
        resolve()
      }, delayMs)
      pendingSleeps.add(entry)
    })
  }

  /** Една партида с повторни опити при busy. null = отказ (базата остава заета / disposed). */
  async function withBusyRetry<T>(attempt: () => T | { ok: false; code: 'busy' }, result: VoiceRetentionRunResult): Promise<T | null> {
    for (let index = 0; ; index += 1) {
      if (disposed) return null
      const outcome = attempt()
      if (typeof outcome === 'object' && outcome !== null && 'ok' in outcome && (outcome as { ok: unknown }).ok === false) {
        if (index >= busyDelays.length) return null
        result.busyRetries += 1
        await sleep(busyDelays[index]!)
        continue
      }
      return outcome as T
    }
  }

  async function sweep(): Promise<VoiceRetentionRunResult> {
    const result: VoiceRetentionRunResult = { status: 'done', memberships: 0, grants: 0, tables: 0, batches: 0, busyRetries: 0 }
    const cutoff = new Date(now() - retentionMs)

    // Фаза 1 — лични данни.
    for (;;) {
      if (disposed) return { ...result, status: 'disposed' }
      if (result.batches >= maxBatches) return { ...result, status: 'batch_cap_reached' }
      const batch = await withBusyRetry(() => deps.store.purgeEndedVoiceMemberships({ endedBefore: cutoff, limit: batchSize }), result)
      if (batch === null) return { ...result, status: disposed ? 'disposed' : 'busy_gave_up' }
      if (!batch.ok) return { ...result, status: 'busy_gave_up' }
      result.batches += 1
      result.memberships += batch.memberships
      result.grants += batch.grants
      if (batch.memberships < batchSize && batch.grants < batchSize) break
      await yieldToEventLoop()
    }

    // Фаза 2 — технически записи (само при потвърдено изтриване на стаите).
    for (;;) {
      if (disposed) return { ...result, status: 'disposed' }
      if (result.batches >= maxBatches) return { ...result, status: 'batch_cap_reached' }
      const batch = await withBusyRetry(() => deps.store.purgeReleasedVoiceTables({ releasedBefore: cutoff, limit: batchSize }), result)
      if (batch === null) return { ...result, status: disposed ? 'disposed' : 'busy_gave_up' }
      if (!batch.ok) return { ...result, status: 'busy_gave_up' }
      result.batches += 1
      result.tables += batch.purged
      if (batch.purged < batchSize) break
      await yieldToEventLoop()
    }
    return result
  }

  function scheduleNext(): void {
    if (disposed || !started) return
    if (timer !== null) deps.scheduler.clearTimeout(timer)
    timer = deps.scheduler.setTimeout(() => {
      timer = null
      void runNow().finally(scheduleNext)
    }, intervalMs)
  }

  function runNow(): Promise<VoiceRetentionRunResult> {
    if (inFlight !== null) return inFlight
    inFlight = sweep()
      .catch((error: unknown): VoiceRetentionRunResult => {
        log(`[voice-chat] retention sweep failed: ${error instanceof Error ? error.message : String(error)}`)
        return { status: 'busy_gave_up', memberships: 0, grants: 0, tables: 0, batches: 0, busyRetries: 0 }
      })
      .then((result) => {
        runs += 1
        lastRunAt = new Date(now()).toISOString()
        lastResult = result
        if (result.memberships > 0 || result.grants > 0 || result.tables > 0 || result.status !== 'done') {
          log(
            `[voice-chat] retention sweep status=${result.status} memberships=${result.memberships}` +
              ` grants=${result.grants} tables=${result.tables} batches=${result.batches} busyRetries=${result.busyRetries}`,
          )
        }
        return result
      })
      .finally(() => {
        inFlight = null
      })
    return inFlight
  }

  return {
    start() {
      if (started || disposed) return
      started = true
      void runNow().finally(scheduleNext)
    },
    runNow,
    dispose() {
      disposed = true
      if (timer !== null) deps.scheduler.clearTimeout(timer)
      timer = null
      for (const entry of pendingSleeps) {
        deps.scheduler.clearTimeout(entry.handle)
        entry.resolve()
      }
      pendingSleeps.clear()
    },
    stats: () => ({ runs, lastRunAt, lastResult }),
  }
}
