// Свара — проследяване на "нови" залози за анимация (Етап 2Б.3.7.4, задание
// §14 "Защита срещу двойни анимации"). Mirror на established Белот tracker
// стила (виж cuttingVisualCountdown.ts's createCuttingVisualCountdownTracker) —
// малък stateful closure, детерминистичен спрямо вече известни сървърни данни
// (round.actions дължина по roundId), НЕ клиентски брояч на "обиколки".
//
// Правило: при ПЪРВОТО виждане на даден roundId (нов controller mount —
// reconnect, remount, Демо<->Истинска игра, връщане след навигация) се прави
// само baseline sync (запомня текущата дължина), БЕЗ анимация — задание §14
// "При initial snapshot показвай актуалните баджове, но не възпроизвеждай
// стари анимации". Само СЛЕДВАЩ, РЕАЛНО по-дълъг actions масив за СЪЩИЯ
// roundId произвежда нови записи за анимиране. Дубликат snapshot (същата
// дължина) -> нищо ново. Нов roundId -> отново само baseline (не "довлича"
// стари записи от предишното раздаване).

import type { SvaraSnapshotRound } from '../../../network/createGameServerClient'

export type SvaraNewBetEntry = { playerId: string; total: number; added: number; blind: boolean }

export type SvaraBetAnimationTracker = {
  /** Връща само РЕАЛНО новите (неанимирани досега) записи с added>0 за ТЕКУЩИЯ round. */
  detectNewEntries: (round: SvaraSnapshotRound | null) => SvaraNewBetEntry[]
  reset: () => void
}

export function createSvaraBetAnimationTracker(): SvaraBetAnimationTracker {
  const seenCountByRoundId = new Map<string, number>()

  function detectNewEntries(round: SvaraSnapshotRound | null): SvaraNewBetEntry[] {
    if (!round || (round.kind !== 'ordinary' && round.kind !== 'svara')) return []
    const { roundId, actions } = round
    const seenCount = seenCountByRoundId.get(roundId)
    if (seenCount === undefined) {
      seenCountByRoundId.set(roundId, actions.length)
      return []
    }
    if (actions.length <= seenCount) return []
    const newEntries = actions
      .slice(seenCount)
      .filter((entry) => entry.added > 0)
      .map((entry) => ({ playerId: entry.playerId, total: entry.total, added: entry.added, blind: entry.blind }))
    seenCountByRoundId.set(roundId, actions.length)
    return newEntries
  }

  function reset(): void {
    seenCountByRoundId.clear()
  }

  return { detectNewEntries, reset }
}
