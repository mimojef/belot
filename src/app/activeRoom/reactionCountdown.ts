/**
 * reactionCountdown.ts
 *
 * Чиста математика за countdown лентата на "Време за реакция" (cutting,
 * bidding, playing). Единственият източник на totalMs/remainingMs за трите
 * фази — без DOM и без собствени hardcoded timeout константи:
 *  - totalMs  = game.humanTurnTimeoutMs (server-authoritative, whitelist-нат)
 *  - remainingMs = timerDeadlineAt - сървърно "сега" (sharedServerClock)
 */

import {
  DEFAULT_HUMAN_TURN_TIMEOUT_MS,
  isHumanTurnTimeoutMs,
} from '../../../server/src/shared/humanTurnTimeoutOptions'

// Огледало на SERVER_TIMING_CONFIG.*BotDelayMs (production). За бот сървърът
// държи 800ms таймер; клиентът показва "пълна" лента, която изтича за тези
// 800ms (същата презентация като преди), а не 5/10/15-секундно чакане.
export const BOT_ACTION_DELAY_MS = 800

// Звуково предупреждение: запазва досегашните 7s при стандартните 15s и се
// мащабира пропорционално за по-кратките времена (10s -> 4.67s,
// 5s -> 2.33s), така че никога не започва веднага с хода и не звучи през
// целия му период.
const REACTION_WARNING_MAX_THRESHOLD_MS = 7000
const REACTION_WARNING_FRACTION_FOR_SHORT_TIMERS = 7 / 15

export function resolveHumanTurnTimeoutMs(
  game: { humanTurnTimeoutMs?: number | null } | null | undefined,
): number {
  const value = game?.humanTurnTimeoutMs
  return isHumanTurnTimeoutMs(value) ? value : DEFAULT_HUMAN_TURN_TIMEOUT_MS
}

export type SeatCountdownInput = {
  deadlineAt: number | null
  totalMs: number
  isBotSeat: boolean
  serverNow: number
}

/**
 * Оставащо време за лентата. За човек = deadline - serverNow (НЕ се clamp-ва
 * отгоре — remaining > total означава, че ходът още не е започнал, напр.
 * след събиране на взятка; renderCountdownFillAnimation го превръща в
 * положителен animation-delay). За бот = пълната лента минус изтеклото от
 * 800ms bot таймер.
 */
export function computeSeatCountdownRemainingMs(input: SeatCountdownInput): number | null {
  if (input.deadlineAt === null || !Number.isFinite(input.deadlineAt)) {
    return null
  }

  const rawRemainingMs = Math.max(0, input.deadlineAt - input.serverNow)

  if (input.isBotSeat) {
    return Math.max(
      0,
      input.totalMs - (BOT_ACTION_DELAY_MS - Math.min(BOT_ACTION_DELAY_MS, rawRemainingMs)),
    )
  }

  return rawRemainingMs
}

export type CountdownFillAnimation = {
  durationMs: number
  delayMs: number
}

/**
 * CSS параметри на лентата: animation-duration = totalMs (пълният ход), а
 * animation-delay позиционира анимацията спрямо authoritative deadline-а:
 *  - отрицателен (-elapsed) при refresh/reconnect/закъснял render — лентата
 *    продължава от реалното оставащо време, не от 100%;
 *  - положителен (remaining - total), когато deadline-ът е по-далеч от
 *    total (таймерът стартира в бъдеще) — лентата стои пълна и изтича точно
 *    в deadline-а.
 * Краят на анимацията винаги е renderNow + remainingMs = deadline.
 */
export function computeCountdownFillAnimation(
  remainingMs: number,
  totalMs: number,
): CountdownFillAnimation {
  const safeTotalMs = Math.max(1, Math.round(totalMs))
  const safeRemainingMs = Math.max(0, Math.round(remainingMs))

  return {
    durationMs: safeTotalMs,
    delayMs: safeRemainingMs - safeTotalMs,
  }
}

export function getReactionWarningThresholdMs(totalMs: number): number {
  return Math.min(
    REACTION_WARNING_MAX_THRESHOLD_MS,
    Math.round(totalMs * REACTION_WARNING_FRACTION_FOR_SHORT_TIMERS),
  )
}
