// Свара — постоянни баджове на залозите (Етап 2Б.3.7.4, задание §11/§12).
// Чиста функция: извлича "последния залог" на играч директно от
// round.actions (сървърният журнал на наддаването за ТЕКУЩОТО раздаване) —
// никакво клиентско броене на "обиколки", никакво локално натрупване.
// round.actions пристига ЦЯЛ (не инкрементално) във всеки snapshot, затова
// е reconnect-safe по конструкция: журналът естествено се занулява, щом
// сървърът премине към ново раздаване (нов round.roundId -> нов, празен
// actions масив), което реализира точно заданието "баджовете остават до
// следващия пълен кръг на наддаване" без никаква допълнителна логика тук.
//
// "Общо внесени" (задание §11.Б) идва директно от SvaraSnapshotSeat.roundContribution
// (вече включва Входа, виж коментара в createGameServerClient.ts) — не се
// нуждае от отделна функция тук, рендира се директно от snapshot-а.

import type { SvaraSnapshotRound } from '../../../network/createGameServerClient'

export type SvaraLastBetBadge = { total: number; blind: boolean }

/**
 * Последният запис в журнала на наддаването за дадения играч в ТЕКУЩОТО
 * раздаване (null ако играчът още не е направил залог тук, или round-ът не
 * е betting тип). Entries с total<=0 (напр. fold преди всякакъв залог) не
 * дават бадж.
 */
export function getLastSvaraBetBadge(round: SvaraSnapshotRound | null, playerId: string): SvaraLastBetBadge | null {
  if (!round || (round.kind !== 'ordinary' && round.kind !== 'svara')) return null
  const actions = round.actions
  for (let i = actions.length - 1; i >= 0; i -= 1) {
    const entry = actions[i]!
    if (entry.playerId !== playerId) continue
    if (entry.total <= 0) return null
    return { total: entry.total, blind: entry.blind }
  }
  return null
}

export function formatSvaraLastBetBadge(badge: SvaraLastBetBadge): string {
  return badge.blind ? `НА ТЪМНО · ${badge.total}` : `ЗАЛОГ · ${badge.total}`
}
