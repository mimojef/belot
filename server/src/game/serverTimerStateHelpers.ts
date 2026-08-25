import type { Seat } from '../core/serverTypes.js'
import { SERVER_TIMING_CONFIG } from './serverTimingConfig.js'
import { createEmptyTimerState } from './createServerRoundDefaults.js'
import {
  getLocalTournamentTestRoomBotDelayOverrides,
  isLocalTournamentTestModeEnabled,
} from '../localTournamentTest/localTournamentTestModeGuard.js'
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

// Local tournament test mode only (see localTournamentTestModeGuard.ts) — a
// one_human test run's own semifinal room should move quickly while the
// sibling all-bot semifinal stays observably in_progress longer, so the
// unified inter-round STATE A/STATE B screen can be watched end-to-end.
// Derived PURELY from this room's own game state (any seat with
// mode === 'human' vs every seat being a bot) — no room/tournament UUID is
// read anywhere here, so this generalizes to any local-test room shape, not
// just this one scenario. Outside local test mode this is a no-op: returns
// productionDelayMs unchanged, i.e. exactly today's SERVER_TIMING_CONFIG
// value (random-at-startup-in-range during local test, fixed 800ms in
// production) — see resolveServerBotActionDelayMs's three call sites below.
export function resolveServerBotActionDelayMs(
  state: ServerAuthoritativeGameState,
  productionDelayMs: number,
): number {
  if (!isLocalTournamentTestModeEnabled()) return productionDelayMs
  const hasHumanSeat = Object.values(state.players).some((player) => player.mode === 'human')
  const overrides = getLocalTournamentTestRoomBotDelayOverrides()
  return hasHumanSeat ? overrides.humanRoomBotDelayMs : overrides.siblingBotOnlyRoomBotDelayMs
}

export function createServerCuttingTimerState(
  state: ServerAuthoritativeGameState,
  activeSeat: Seat,
  startedAt: number = getServerTimerNow(),
): ServerTimerState {
  const durationMs = isServerSeatControlledByBot(state, activeSeat)
    ? resolveServerBotActionDelayMs(state, SERVER_TIMING_CONFIG.cutBotDelayMs)
    : SERVER_TIMING_CONFIG.cutHumanTimeoutMs

  return createServerTimerStateForSeat(activeSeat, durationMs, startedAt)
}

export function createServerBiddingTimerState(
  state: ServerAuthoritativeGameState,
  activeSeat: Seat,
  startedAt: number = getServerTimerNow(),
): ServerTimerState {
  const durationMs = isServerSeatControlledByBot(state, activeSeat)
    ? resolveServerBotActionDelayMs(state, SERVER_TIMING_CONFIG.bidBotDelayMs)
    : SERVER_TIMING_CONFIG.bidHumanTimeoutMs

  return createServerTimerStateForSeat(activeSeat, durationMs, startedAt)
}

export function createServerPlayingTimerState(
  state: ServerAuthoritativeGameState,
  activeSeat: Seat,
  startedAt: number = getServerTimerNow(),
): ServerTimerState {
  const durationMs = isServerSeatControlledByBot(state, activeSeat)
    ? resolveServerBotActionDelayMs(state, SERVER_TIMING_CONFIG.playBotDelayMs)
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