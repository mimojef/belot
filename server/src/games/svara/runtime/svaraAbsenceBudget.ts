// Свара — общ бюджет за отсъствие: 360 s за целия мач на всеки играч.
//
// Времето тече само докато играчът е „Липсва“ (status 'absent') и НЕ е заявил
// завръщане. При завръщане отброяването спира и изразходваното се запазва;
// при следващо отсъствие продължава от оставащото (без нови 6 минути).
//
// Сървърът е единственият авторитет: часовникът (`state.absence`) се обновява
// само в runtime-а след всяка приложена команда (двигателят остава без време)
// и се пази заедно със състоянието на мача — PM2 рестарт, reconnect, refresh и
// ново раздаване не го нулират. Срокът е абсолютен (since + оставащо), затова
// и времето по време на рестарт се отчита.

import type { SvaraAbsenceClock, SvaraMatchState } from '../engine/svaraMatch.js'

export const SVARA_ABSENCE_BUDGET_MS = 360_000

/** Тече ли бюджетът на играча в момента. */
export function isSvaraAbsenceCounting(state: SvaraMatchState, playerId: string): boolean {
  return state.phase === 'in-progress' && state.status[playerId] === 'absent' && !(state.pendingReturns ?? []).includes(playerId)
}

/** Отваря/затваря часовниците според текущите статуси (мутира `state.absence`). */
export function updateSvaraAbsenceClocks(state: SvaraMatchState, now: number): void {
  let clocks: Record<string, SvaraAbsenceClock> | undefined = state.absence
  for (const playerId of state.seats) {
    const clock = clocks?.[playerId]
    const counting = isSvaraAbsenceCounting(state, playerId)
    if (counting && (!clock || clock.since === null)) {
      clocks = { ...clocks, [playerId]: { usedMs: clock?.usedMs ?? 0, since: now } }
    } else if (!counting && clock && clock.since !== null) {
      clocks = { ...clocks, [playerId]: { usedMs: Math.min(SVARA_ABSENCE_BUDGET_MS, clock.usedMs + Math.max(0, now - clock.since)), since: null } }
    }
  }
  if (clocks !== state.absence) state.absence = clocks
}

/** Абсолютният момент на изчерпване (сървърно epoch време) или null, ако не тече. */
export function svaraAbsenceDeadlineAt(state: SvaraMatchState, playerId: string): number | null {
  const clock = state.absence?.[playerId]
  if (!clock || clock.since === null || !isSvaraAbsenceCounting(state, playerId)) return null
  return clock.since + Math.max(0, SVARA_ABSENCE_BUDGET_MS - clock.usedMs)
}

/** Най-ранното изчерпване на масата (един срок за сървърния планировчик). */
export function svaraAbsenceLimitTarget(state: SvaraMatchState): { playerId: string; since: number; deadlineAt: number } | null {
  let best: { playerId: string; since: number; deadlineAt: number } | null = null
  for (const playerId of state.seats) {
    const deadlineAt = svaraAbsenceDeadlineAt(state, playerId)
    if (deadlineAt !== null && (!best || deadlineAt < best.deadlineAt)) best = { playerId, since: state.absence![playerId]!.since!, deadlineAt }
  }
  return best
}
