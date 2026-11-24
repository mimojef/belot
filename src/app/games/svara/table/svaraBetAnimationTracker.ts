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

import type { SvaraSnapshotAction, SvaraSnapshotRound } from '../../../network/createGameServerClient'

/** previousBet: текущият залог непосредствено преди действието (най-високото ниво в журнала преди него). */
export type SvaraNewBetEntry = { playerId: string; kind: SvaraSnapshotAction['kind']; total: number; added: number; blind: boolean; previousBet: number }

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
 * `call`: сумата се покрива от наличното, т.е. действието е „Плати“ (при
 * недостиг наддаването се затваря с Ол-ин за по-малко).
 */
export function detectSvaraFinalCall(prev: SvaraSnapshotForFinalCall | null, next: SvaraSnapshotForFinalCall | null): { playerId: string; added: number; roundId: string; call: boolean } | null {
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
  const need = Math.max(0, before.currentBet - voluntary)
  const added = Math.min(need, stack)
  return added > 0 ? { playerId: actor, added, roundId: before.roundId, call: need <= stack } : null
}

/**
 * С колко действието вдига текущия залог (за „Вдигам +N“), или null.
 * Сървърът записва повишаването с три вида действие: `bet` (обикновен
 * залог, ×N, вкл. залог за цялата наличност), `all-in` (Ол-ин над текущия
 * залог) и `blind-bet` (на тъмно). Повишаване е само когато новото ниво е
 * над текущия залог преди действието. Изключение: откриването с „Плати“ —
 * обикновен залог точно на Входа при текущ залог 0 (бутонът „Плати“ го праща).
 */
export function svaraRaiseAmount(entry: Pick<SvaraNewBetEntry, 'kind' | 'total' | 'previousBet'>, entryChips: number): number | null {
  if (entry.kind !== 'bet' && entry.kind !== 'all-in' && entry.kind !== 'blind-bet') return null
  if (entry.total <= entry.previousBet) return null
  if (entry.kind === 'bet' && entry.previousBet === 0 && entry.total === entryChips) return null
  return entry.total - entry.previousBet
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
    const newEntries: SvaraNewBetEntry[] = []
    actions.forEach((entry, index) => {
      if (index < seenCount || entry.added <= 0) return
      const previousBet = actions.slice(0, index).reduce((max, prior) => Math.max(max, prior.total), 0)
      newEntries.push({ playerId: entry.playerId, kind: entry.kind, total: entry.total, added: entry.added, blind: entry.blind, previousBet })
    })
    seenCountByRoundId.set(roundId, actions.length)
    return newEntries
  }

  function reset(): void {
    seenCountByRoundId.clear()
  }

  return { detectNewEntries, reset }
}
