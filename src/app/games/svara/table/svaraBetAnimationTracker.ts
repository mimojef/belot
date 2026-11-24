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

type SvaraSnapshotForFinalCall = {
  matchId: string
  revision: number
  toActId: string | null
  round: SvaraSnapshotRound | null
  seats: ReadonlyArray<{ playerId: string; stack: number }>
}

/**
 * Последното „Плати“, което приключва наддаването: сървърът минава направо
 * в сравняване (showdown-display) и в този snapshot вече няма действия, а
 * стековете включват и изплащането — затова вноската не се вижда като ново
 * действие. Познава се по прехода: предишният snapshot е залагане, играчът на
 * ход е сред сравняваните; сумата е до текущия залог (без досегашните му
 * доброволни вноски), най-много колкото е имал. Само при жив преход в
 * сесията (не при reconnect: тогава няма предишен snapshot).
 */
export function detectSvaraFinalCall(prev: SvaraSnapshotForFinalCall | null, next: SvaraSnapshotForFinalCall | null): { playerId: string; added: number; roundId: string } | null {
  // Само непосредствено следващият snapshot: ако междинен е пропуснат, играчът
  // „на ход“ в предишния може да не е последният платил — тогава без анимация.
  if (!prev || !next || prev.matchId !== next.matchId || next.revision !== prev.revision + 1) return null
  const before = prev.round
  const after = next.round
  if (!before || (before.kind !== 'ordinary' && before.kind !== 'svara')) return null
  if (!after || after.kind !== 'showdown-display' || after.displayPhase !== 'showdown') return null
  const actor = prev.toActId
  if (!actor || !after.comparedPlayers.includes(actor)) return null
  const voluntary = before.actions.filter((entry) => entry.playerId === actor).reduce((sum, entry) => sum + entry.added, 0)
  const stack = prev.seats.find((seat) => seat.playerId === actor)?.stack ?? 0
  const added = Math.min(Math.max(0, before.currentBet - voluntary), stack)
  return added > 0 ? { playerId: actor, added, roundId: before.roundId } : null
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
