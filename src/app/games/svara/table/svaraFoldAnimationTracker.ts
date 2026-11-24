// Свара — проследяване на "нови" откази (доброволен/принудителен) за
// анимация (Етап 2Б.3.7.5, задание §11/§13/§14). Същата архитектура като
// createSvaraBetAnimationTracker (svaraBetAnimationTracker.ts) — отделен
// instance, за да не се пипа/риска вече работещия bet-flash tracker:
// seenCountByRoundId помни докъде в round.actions вече сме "видели" ЗА ВСЕКИ
// roundId; при ПЪРВОТО виждане на даден roundId (mount/reconnect/remount)
// само се запомня baseline, БЕЗ анимация — задание §14/§20 "без повторно
// възпроизвеждане на стари ефекти при reconnect/rerender/duplicate snapshot".
//
// Разграничение доброволен/принудителен (задание §13): server/src/games/
// svara/engine/svaraBetting.ts бележи принудителните откази (отсъствие/
// timeout/изход) с kind:'forced-fold', различно от обикновеното kind:'fold'
// (изричен клик на "Бягам") — вече на протокола (SvaraSnapshotAction.kind),
// никакво ново разширение не е нужно.

import type { SvaraSnapshotRound } from '../../../network/createGameServerClient'

export type SvaraNewFoldEntry = { playerId: string; voluntary: boolean }

export type SvaraFoldAnimationTracker = {
  /** Връща само РЕАЛНО новите (неанимирани досега) fold/forced-fold записи за ТЕКУЩИЯ round. */
  detectNewFolds: (round: SvaraSnapshotRound | null) => SvaraNewFoldEntry[]
  reset: () => void
}

type SvaraSnapshotForFinalFold = {
  matchId: string
  revision: number
  toActId: string | null
  round: SvaraSnapshotRound | null
  seats: ReadonlyArray<{ playerId: string; status: string }>
}

/**
 * Последното доброволно „Бягам“, което приключва наддаването: сървърът минава
 * направо в „Покажи/Скрий“ или в сравняване и в този snapshot вече няма
 * журнал на действията, затова detectNewFolds не го вижда. Познава се по
 * прехода от непосредствено предишния snapshot: играчът на ход не е сред
 * показваните, а статусът му остава 'active' (принудителният отказ — изтекло
 * време/изход — го прави 'absent'/'exited'). Без предишен snapshot
 * (reconnect) — нищо.
 */
export function detectSvaraFinalFold(prev: SvaraSnapshotForFinalFold | null, next: SvaraSnapshotForFinalFold | null): { playerId: string; roundId: string } | null {
  if (!prev || !next || prev.matchId !== next.matchId || next.revision !== prev.revision + 1) return null
  const before = prev.round
  const after = next.round
  if (!before || (before.kind !== 'ordinary' && before.kind !== 'svara')) return null
  if (!after || (after.kind !== 'reveal-choice' && after.kind !== 'showdown-display')) return null
  const actor = prev.toActId
  if (!actor) return null
  const shown = after.kind === 'reveal-choice' ? [after.winnerId] : after.comparedPlayers
  if (shown.includes(actor)) return null
  if (next.seats.find((seat) => seat.playerId === actor)?.status !== 'active') return null
  return { playerId: actor, roundId: before.roundId }
}

export function createSvaraFoldAnimationTracker(): SvaraFoldAnimationTracker {
  const seenCountByRoundId = new Map<string, number>()

  function detectNewFolds(round: SvaraSnapshotRound | null): SvaraNewFoldEntry[] {
    if (!round || (round.kind !== 'ordinary' && round.kind !== 'svara')) return []
    const { roundId, actions } = round
    const seenCount = seenCountByRoundId.get(roundId)
    if (seenCount === undefined) {
      seenCountByRoundId.set(roundId, actions.length)
      return []
    }
    if (actions.length <= seenCount) return []
    const newFolds = actions
      .slice(seenCount)
      .filter((entry) => entry.kind === 'fold' || entry.kind === 'forced-fold')
      .map((entry) => ({ playerId: entry.playerId, voluntary: entry.kind === 'fold' }))
    seenCountByRoundId.set(roundId, actions.length)
    return newFolds
  }

  function reset(): void {
    seenCountByRoundId.clear()
  }

  return { detectNewFolds, reset }
}
