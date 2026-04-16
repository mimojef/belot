import type { Seat } from '../../data/constants/seatOrder'
import { TIMING_CONFIG } from '../../data/config/timingConfig'
import { createEmptyTimerState } from '../state/createRoundDefaults'
import type { GameState, TimerState } from '../state/gameTypes'

export function getTimerNow(): number {
  return Date.now()
}

export function clearTimerState(): TimerState {
  return createEmptyTimerState()
}

export function isSeatControlledByBot(state: GameState, seat: Seat): boolean {
  const player = state.players[seat]

  if (!player) {
    return false
  }

  return player.mode === 'bot' || player.controlledByBot
}

export function createTimerStateForSeat(
  activeSeat: Seat,
  durationMs: number,
  startedAt: number = getTimerNow(),
): TimerState {
  return {
    activeSeat,
    startedAt,
    durationMs,
    expiresAt: startedAt + durationMs,
  }
}

export function createCuttingTimerState(
  state: GameState,
  activeSeat: Seat,
  startedAt: number = getTimerNow(),
): TimerState {
  const durationMs = isSeatControlledByBot(state, activeSeat)
    ? TIMING_CONFIG.cutBotDelayMs
    : TIMING_CONFIG.cutHumanTimeoutMs

  return createTimerStateForSeat(activeSeat, durationMs, startedAt)
}

export function createBiddingTimerState(
  state: GameState,
  activeSeat: Seat,
  startedAt: number = getTimerNow(),
): TimerState {
  const durationMs = isSeatControlledByBot(state, activeSeat)
    ? TIMING_CONFIG.bidBotDelayMs
    : TIMING_CONFIG.bidHumanTimeoutMs

  return createTimerStateForSeat(activeSeat, durationMs, startedAt)
}

export function createPlayingTimerState(
  state: GameState,
  activeSeat: Seat,
  startedAt: number = getTimerNow(),
): TimerState {
  const durationMs = isSeatControlledByBot(state, activeSeat)
    ? TIMING_CONFIG.playBotDelayMs
    : TIMING_CONFIG.playHumanTimeoutMs

  return createTimerStateForSeat(activeSeat, durationMs, startedAt)
}

export function createScoringTimerState(
  startedAt: number = getTimerNow(),
): TimerState {
  return {
    activeSeat: null,
    startedAt,
    durationMs: TIMING_CONFIG.summaryVisibleMs,
    expiresAt: startedAt + TIMING_CONFIG.summaryVisibleMs,
  }
}