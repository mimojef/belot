// Етап 3В.2 — свързване на платената „Свара“ с финансовата основа.
//
// ИЗКЛЮЧЕНО по подразбиране: активно САМО при SVARA_PAID_MATCHES_ENABLED=1.
// При изключен флаг „Свара“ работи както досега (виртуални чипове, без
// удържане/изплащане).
//
// Правилата на играта НЕ се променят. Тук са само:
//   - кога един lobby команден път ще стартира мача (за удържане ПРЕДИ старта);
//   - възстановяване при старт на сървъра за мачове с удържани входове.

import type { SvaraEconomyStore } from '../../db/svaraEconomyStore.js'
import type { SvaraPublicTable } from './protocol/svaraSnapshotProtocol.js'

const ENV_FLAG_NAME = 'SVARA_PAID_MATCHES_ENABLED'

export function isSvaraPaidMatchesEnabled(): boolean {
  return process.env[ENV_FLAG_NAME] === '1'
}

export type SvaraPaidEconomy = Pick<SvaraEconomyStore,
  'collectEntries' | 'refundEntries' | 'settleMatch' | 'markUnrecoverable' | 'listCollectedMatchIds' | 'previewPrize' | 'getActiveConfig' | 'getFinance'>

/**
 * Участниците, ако командата ще стартира мача; иначе null. Повтаря само
 * условията на двигателя (joinSeat при 'auto' / startMatchByCreator при
 * 'manual') — двигателят остава единственият, който реално стартира.
 */
export function participantsIfCommandStartsMatch(
  table: SvaraPublicTable,
  playerId: string,
  command: 'join-seat' | 'start-match',
): string[] | null {
  if (table.phase !== 'lobby') return null
  const seated = table.players.map((p) => p.playerId)
  if (command === 'join-seat') {
    if (table.startMode !== 'auto' || seated.includes(playerId) || seated.length + 1 !== table.capacity) return null
    return [...seated, playerId]
  }
  if (table.startMode !== 'manual' || playerId !== table.creatorId || seated.length !== table.capacity) return null
  return seated
}

export type SvaraPersistedMatchView =
  | { kind: 'missing' }
  | { kind: 'unreadable' }
  | { kind: 'state'; phase: 'lobby' | 'in-progress' | 'finished' | 'closed'; winnerId: string | null }

export type SvaraPaidReconcileReport = {
  refunded: string[]
  settled: Array<{ matchId: string; status: string }>
  continuing: string[]
  unrecoverable: string[]
  failed: Array<{ matchId: string; message: string }>
}

/**
 * При старт (след възстановяването на мачовете): всеки ред 'collected'.
 *   - мачът не е започнал (няма snapshot / lobby / closed) → връщане на входовете;
 *   - тече → нищо;
 *   - приключил → уреждане (изплащане или 'held' без победител);
 *   - нечетим snapshot → 'held' (match-unrecoverable), без автоматично движение.
 * Всички операции са идемпотентни — повторен рестарт не плаща/връща втори път.
 */
export function reconcileSvaraPaidMatches(
  economy: SvaraPaidEconomy,
  loadMatch: (matchId: string) => SvaraPersistedMatchView,
): SvaraPaidReconcileReport {
  const report: SvaraPaidReconcileReport = { refunded: [], settled: [], continuing: [], unrecoverable: [], failed: [] }
  for (const matchId of economy.listCollectedMatchIds()) {
    let view: SvaraPersistedMatchView
    try { view = loadMatch(matchId) } catch { view = { kind: 'unreadable' } }
    if (view.kind === 'unreadable') {
      const r = economy.markUnrecoverable(matchId)
      if (r.ok) report.unrecoverable.push(matchId)
      else report.failed.push({ matchId, message: r.message })
      continue
    }
    if (view.kind === 'missing' || view.phase === 'lobby' || view.phase === 'closed') {
      const r = economy.refundEntries(matchId)
      if (r.ok) report.refunded.push(matchId)
      else report.failed.push({ matchId, message: r.message })
      continue
    }
    if (view.phase === 'in-progress') { report.continuing.push(matchId); continue }
    const r = economy.settleMatch(matchId, view.winnerId)
    if (r.ok) report.settled.push({ matchId, status: r.status })
    else report.failed.push({ matchId, message: r.message })
  }
  return report
}
