import type { Seat } from '../core/serverTypes.js'
import { SERVER_TIMING_CONFIG } from './serverTimingConfig.js'
import { createEmptyTimerState } from './createServerRoundDefaults.js'
import type {
  ServerAuthoritativeGameState,
  ServerTimerState,
} from './serverGameTypes.js'

export function getServerTimerNow(): number {
  return Date.now()
}

export function clearServerTimerState(): ServerTimerState {
  return createEmptyTimerState()
}

export function isServerSeatControlledByBot(
  state: ServerAuthoritativeGameState,
  seat: Seat,
): boolean {
  const player = state.players[seat]

  if (!player) {
    return false
  }

  return player.mode === 'bot' || player.controlledByBot
}

export function createServerTimerStateForSeat(
  activeSeat: Seat,
  durationMs: number,
  startedAt: number = getServerTimerNow(),
): ServerTimerState {
  return {
    activeSeat,
    startedAt,
    durationMs,
    expiresAt: startedAt + durationMs,
  }
}

export function createServerCuttingTimerState(
  state: ServerAuthoritativeGameState,
  activeSeat: Seat,
  startedAt: number = getServerTimerNow(),
): ServerTimerState {
  const durationMs = isServerSeatControlledByBot(state, activeSeat)
    ? SERVER_TIMING_CONFIG.cutBotDelayMs
    : SERVER_TIMING_CONFIG.cutHumanTimeoutMs

  return createServerTimerStateForSeat(activeSeat, durationMs, startedAt)
}

export function createServerBiddingTimerState(
  state: ServerAuthoritativeGameState,
  activeSeat: Seat,
  startedAt: number = getServerTimerNow(),
): ServerTimerState {
  const durationMs = isServerSeatControlledByBot(state, activeSeat)
    ? SERVER_TIMING_CONFIG.bidBotDelayMs
    : SERVER_TIMING_CONFIG.bidHumanTimeoutMs

  return createServerTimerStateForSeat(activeSeat, durationMs, startedAt)
}

export function createServerPlayingTimerState(
  state: ServerAuthoritativeGameState,
  activeSeat: Seat,
  startedAt: number = getServerTimerNow(),
): ServerTimerState {
  const durationMs = isServerSeatControlledByBot(state, activeSeat)
    ? SERVER_TIMING_CONFIG.playBotDelayMs
    : SERVER_TIMING_CONFIG.playHumanTimeoutMs

  return createServerTimerStateForSeat(activeSeat, durationMs, startedAt)
}

export function createServerScoringTimerState(
  startedAt: number = getServerTimerNow(),
): ServerTimerState {
  return {
    activeSeat: null,
    startedAt,
    durationMs: SERVER_TIMING_CONFIG.summaryVisibleMs,
    expiresAt: startedAt + SERVER_TIMING_CONFIG.summaryVisibleMs,
  }
}