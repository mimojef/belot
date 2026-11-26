// Етап 3Б.2: защита срещу загуба на задържано изплащане, което НЕ е успяло
// да се запише в belot_held_payouts (DB грешка).
//
//   - пълният (самодостатъчен) запис остава в паметта и се опитва отново;
//   - преди snapshot-ът на масата да бъде презаписан или изтрит — още един
//     опит; ако случаят пак не е записан, ИЗТРИВАНЕТО на snapshot-а се
//     спира (той е последният устойчив източник; при рестарт
//     registerHeldPayoutForRestoredRoom го регистрира);
//   - задържаните snapshot-и се изтриват едва след успешния запис и само ако
//     масата вече не е активна.
//
// Модулът не пише в базата сам — получава операциите като зависимости.

import type { HeldPayoutRecord } from '../db/matchEconomyStore.js'

export type HeldPayoutRegistrationGuardDeps = {
  recordHeldPayout: (record: HeldPayoutRecord) => { ok: true } | { ok: false; message: string }
  /** Суровото изтриване на snapshot-а (може да хвърли). */
  removeRoomSnapshot: (roomId: string) => void
  isRoomActive: (roomId: string) => boolean
  /** След потвърден запис в регистъра (напр. изтриване на файла от журнала). */
  afterRecorded?: (matchScope: string) => void
  log?: (message: string) => void
  error?: (message: string) => void
}

export type HeldPayoutRegistrationGuard = {
  /** Незаписан случай → в паметта за повторни опити (+ пълен запис в лога). */
  enqueue: (record: HeldPayoutRecord, error: string) => void
  /** Опит за запис на незаписаните случаи на масата. true = няма незаписани. */
  flushRoom: (roomId: string) => boolean
  /** Snapshot-ът на масата не се трие, докато случаят ѝ не е записан. */
  retainSnapshot: (roomId: string) => void
  /** Повторни опити + освобождаване на задържаните snapshot-и. */
  retryNow: () => void
  isIdle: () => boolean
  pendingMatchScopes: () => string[]
  retainedRoomIds: () => string[]
}

export function createHeldPayoutRegistrationGuard(deps: HeldPayoutRegistrationGuardDeps): HeldPayoutRegistrationGuard {
  const log = deps.log ?? ((message: string) => console.log(message))
  const error = deps.error ?? ((message: string) => console.error(message))
  const pending = new Map<string, HeldPayoutRecord>()
  const retained = new Set<string>()

  function tryRecord(matchScope: string, record: HeldPayoutRecord): boolean {
    let result: { ok: true } | { ok: false; message: string }
    try {
      result = deps.recordHeldPayout(record)
    } catch (thrown) {
      result = { ok: false, message: thrown instanceof Error ? thrown.message : String(thrown) }
    }
    if (result.ok) {
      pending.delete(matchScope)
      log(`[match-economy] held payout recorded after retry scope=${matchScope}`)
      try {
        deps.afterRecorded?.(matchScope)
      } catch (thrown) {
        error(`[match-economy] afterRecorded failed scope=${matchScope}: ${thrown instanceof Error ? thrown.message : String(thrown)}`)
      }
      return true
    }
    error(`[match-economy] held payout still NOT recorded scope=${matchScope}: ${result.message}`)
    return false
  }

  function enqueue(record: HeldPayoutRecord, reason: string): void {
    error(`[match-economy] HELD PAYOUT NOT RECORDED scope=${record.matchScope}: ${reason} — retrying; record=${JSON.stringify(record)}`)
    pending.set(record.matchScope, record)
  }

  function flushRoom(roomId: string): boolean {
    let allRecorded = true
    for (const [matchScope, record] of pending) {
      if (record.roomId !== roomId) continue
      if (!tryRecord(matchScope, record)) allRecorded = false
    }
    return allRecorded
  }

  function retainSnapshot(roomId: string): void {
    if (!retained.has(roomId)) error(`[match-economy] room snapshot RETAINED room=${roomId} — held payout not yet recorded`)
    retained.add(roomId)
  }

  function retryNow(): void {
    for (const [matchScope, record] of pending) tryRecord(matchScope, record)
    for (const roomId of retained) {
      const stillPending = [...pending.values()].some((record) => record.roomId === roomId)
      if (stillPending || deps.isRoomActive(roomId)) continue
      try {
        deps.removeRoomSnapshot(roomId)
        retained.delete(roomId)
        log(`[match-economy] retained room snapshot released room=${roomId}`)
      } catch (thrown) {
        error(`[room-snapshot] failed to remove retained room=${roomId}: ${thrown instanceof Error ? thrown.message : String(thrown)}`)
      }
    }
  }

  return {
    enqueue,
    flushRoom,
    retainSnapshot,
    retryNow,
    isIdle: () => pending.size === 0 && retained.size === 0,
    pendingMatchScopes: () => [...pending.keys()],
    retainedRoomIds: () => [...retained],
  }
}
