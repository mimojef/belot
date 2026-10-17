// Свара — постоянни баджове на залозите (Етап 2Б.3.7.4 → коригирано в
// 2Б.3.7.4А, задание §3). Окончателно решение на собственика: баджът пази
// ПОСЛЕДНИЯ залог на играча само през ТЕКУЩАТА обиколка на наддаването
// (кръг около масата); при нова ПЪЛНА обиколка старият бадж се изчиства за
// играчи, които още не са отговорили в нея. "Общо внесени" (§11.Б, отделно
// — SvaraSnapshotSeat.roundContribution) не се пипа тук и остава за цялото
// раздаване.
//
// Обиколката се извежда ДИРЕКТНО от round.actions (сървърният, пълен — не
// инкрементален — журнал на наддаването за ТЕКУЩОТО раздаване), без никакъв
// клиентски брояч: двигателят (svaraBetting.ts) гарантира, че всеки РЕАЛЕН
// залог/повишение (пълно или непълно/ол-ин над текущия залог) стриктно
// увеличава "текущия залог" и отваря ново право на отговор за всички
// останали активни играчи — това е точно границата на нова обиколка.
// "Call"/"fold"/"без залог"/ол-ин за по-малко (плащане) НИКОГА не вдигат
// текущия залог — остават в СЪЩАТА обиколка. Затова: нова обиколка започва
// точно при запис, чийто total > максималния total, видян до момента.
// round.actions пристига ЦЯЛ във всеки snapshot → изводът е напълно
// reconnect-safe и stateless (прави се отначало при всеки render). Нов
// roundId (ново раздаване) носи нов, празен actions масив → обиколката се
// нулира автоматично заедно с него, без отделна логика.

import type { SvaraSnapshotRound } from '../../../network/createGameServerClient'

export type SvaraLastBetBadge = { total: number; blind: boolean }

/**
 * Последният запис на дадения играч ВЪТРЕ В текущата (последната) обиколка
 * на наддаването за това раздаване (null ако играчът не е действал в нея —
 * включително ако е имал бадж в по-стара обиколка — или round-ът не е
 * betting тип). Entries с total<=0 (напр. fold преди всякакъв залог) не
 * дават бадж.
 */
export function getLastSvaraBetBadge(round: SvaraSnapshotRound | null, playerId: string): SvaraLastBetBadge | null {
  if (!round || (round.kind !== 'ordinary' && round.kind !== 'svara')) return null
  let runningBet = 0
  let lastInCurrentCircuit: SvaraLastBetBadge | null = null
  for (const entry of round.actions) {
    if (entry.total > runningBet) {
      runningBet = entry.total
      lastInCurrentCircuit = null // нова обиколка -> изчиства бадж на ВСИЧКИ, докато не отговорят в нея
    }
    if (entry.playerId === playerId) lastInCurrentCircuit = entry.total > 0 ? { total: entry.total, blind: entry.blind } : null
  }
  return lastInCurrentCircuit
}

export function formatSvaraLastBetBadge(badge: SvaraLastBetBadge): string {
  return badge.blind ? `НА ТЪМНО · ${badge.total}` : `ЗАЛОГ · ${badge.total}`
}
