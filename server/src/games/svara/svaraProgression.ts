/**
 * „Свара“ в общата система за нива и рангове (както „Не се сърди човече“).
 *
 * Правило: всеки участник в действително започнал и приключил мач получава
 * +1 изиграна игра; победителят — и +1 победа. Загубил, отпаднал и напуснал
 * — само игра; мач без победител — само игри. Незапочнати/закрити маси не се
 * броят. Без ELO. Нивото/рангът се изчисляват от общия брояч
 * (rankProgression.ts) — тук няма собствени правила.
 *
 * Записът минава през playerProgressStore.recordCompletedGameForProfile
 * (profile_completed_game_ledger PRIMARY KEY (scope_id, profile_id) + did_win)
 * — повторно извикване за същия мач никога не дава второ +1.
 */
import type { SvaraMatchState } from './engine/svaraMatch.js'

export const SVARA_PROGRESSION_SOURCE = 'svara_match'

export type SvaraProgression = {
  /** false — временна грешка в базата (нищо не е записано за този играч; безопасен повторен опит). */
  record: (matchId: string, profileId: string, didWin: boolean) => boolean
  /** Колко участници на мача вече имат запис (за да не се отварят излишни транзакции при старт). */
  recordedCount: (matchId: string) => number
  /**
   * Момент (ms) на първия запис за „Свара“ — проверката при старт на сървъра
   * гледа само по-нови мачове. Мачовете отпреди интеграцията не се
   * начисляват (решение на собственика — без възстановяване със задна дата).
   * null — още няма нито един запис.
   */
  liveSince: () => number | null
}

type ProgressStore = {
  recordCompletedGameForProfile: (scopeId: string, profileId: string, source: string, didWin: boolean) => { ok: boolean }
  countCompletedGameLedgerRows: (scopeId: string, source: string) => number
  getEarliestCompletedGameRecordedAt: (source: string) => number | null
}

export function createSvaraProgression(store: ProgressStore): SvaraProgression {
  return {
    record: (matchId, profileId, didWin) => store.recordCompletedGameForProfile(matchId, profileId, SVARA_PROGRESSION_SOURCE, didWin).ok,
    recordedCount: (matchId) => store.countCompletedGameLedgerRows(matchId, SVARA_PROGRESSION_SOURCE),
    liveSince: () => store.getEarliestCompletedGameRecordedAt(SVARA_PROGRESSION_SOURCE),
  }
}

export type SvaraProgressionParticipants = { playerIds: string[]; winnerId: string | null }

/**
 * Участниците на приключил мач. След старта engine-ът НЕ маха никого от
 * state.seats — напусналите остават със статус 'exited', отпадналите —
 * 'eliminated' (премахване има само в чакалнята, преди старта). Затова
 * state.seats е пълният първоначален състав. null — не е приключил мач.
 */
export function getSvaraProgressionParticipants(state: Pick<SvaraMatchState, 'phase' | 'seats' | 'winnerId'>): SvaraProgressionParticipants | null {
  if (state.phase !== 'finished') return null
  const winnerId = state.winnerId !== null && state.seats.includes(state.winnerId) ? state.winnerId : null
  return { playerIds: [...state.seats], winnerId }
}
