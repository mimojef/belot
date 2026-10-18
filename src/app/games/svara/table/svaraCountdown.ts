// Свара — чиста countdown математика за пръстена около аватара на играча на
// ход (Етап 2Б.3.7.3, задание §8/§9). Mirror на установения в Белот подход
// (reactionCountdown.ts): remainingMs = deadlineAt - сървърно "сега"
// (sharedServerClock, виж serverClock.ts) — НИКОГА клиентско Date.now()
// директно и НИКОГА локален "старт" timestamp, затова рендиране/reconnect
// никога не рестартира пръстена (deadlineAt е единственият авторитет).
//
// totalMs по вид срок огледално на server/src/games/svara/runtime/
// svaraDeadlines.ts константите (SVARA_TURN_MS и т.н.) — само за презентация
// (дължина на пръстена/цвета), не нова бизнес логика; сървърът решава кога
// изтича, клиентът само визуализира.

import type { SvaraDeadlineKind } from '../../../network/createGameServerClient'

// 'dealing' (2Б.3.7.4Б) няма ЕДНА фиксирана продължителност — варира по брой
// участници (2900/3950/5000ms при текущите временни server/src/games/svara/
// runtime/svaraDeadlines.ts константи). Стойността тук е само за цвета на
// генеричния "друг дедлайн" текст (deadlineStatusText) — не е авторитетна;
// 2Б.3.7.5 може да я замени с реалния брой участници от round.participants.
// 'showdown-display' (2Б.3.7.6А) е 3с фиксирано (виж SVARA_SHOWDOWN_DISPLAY_MS
// на сървъра); 'payout-display' варира по брой стъпки на изплащане — стойността
// тук е само за генеричния цвят, не авторитетна (аналогично на 'dealing').
export const SVARA_DEADLINE_TOTAL_MS: Record<SvaraDeadlineKind, number> = {
  dealing: 5_000,
  turn: 15_000,
  'svara-joining': 15_000,
  'presence-wait': 300_000,
  'reveal-choice': 5_000,
  'reveal-display': 3_000,
  'showdown-display': 3_000,
  'payout-display': 1_200,
}

export const SVARA_DEADLINE_LABEL: Record<SvaraDeadlineKind, string> = {
  dealing: 'Раздаване',
  turn: 'Ход',
  'svara-joining': 'Включване в Свара',
  'presence-wait': 'Изчакване на играч',
  'reveal-choice': 'Избор за показване',
  'reveal-display': 'Публичен показ',
  'showdown-display': 'Сравняване',
  'payout-display': 'Изплащане',
}

/** Последните 5 секунди (или целия срок, ако е по-кратък от 5s) стават червени. */
const DANGER_THRESHOLD_MS = 5_000

export type SvaraRingState = {
  /** 0 = изтекъл (празен пръстен); 1 = пълен (начало на срока). */
  fraction: number
  remainingMs: number
  remainingSeconds: number
  isDanger: boolean
}

export function computeSvaraRingState(
  deadlineAt: number,
  totalMs: number,
  serverNow: number,
): SvaraRingState {
  const safeTotalMs = Math.max(1, totalMs)
  const remainingMs = Math.min(safeTotalMs, Math.max(0, deadlineAt - serverNow))
  const fraction = remainingMs / safeTotalMs
  const dangerThreshold = Math.min(DANGER_THRESHOLD_MS, safeTotalMs)
  return {
    fraction,
    remainingMs,
    remainingSeconds: Math.ceil(remainingMs / 1000),
    isDanger: remainingMs <= dangerThreshold,
  }
}

/** SVG `stroke-dashoffset` за даден `fraction` (0..1) и обиколка на пръстена. */
export function svaraRingDashOffset(fraction: number, circumference: number): number {
  const clamped = Math.min(1, Math.max(0, fraction))
  return circumference * (1 - clamped)
}
