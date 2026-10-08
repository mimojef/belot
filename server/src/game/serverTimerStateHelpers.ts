import type { Seat } from '../core/serverTypes.js'
import { SERVER_TIMING_CONFIG } from './serverTimingConfig.js'
import { createEmptyTimerState } from './createServerRoundDefaults.js'
import {
  getLocalTournamentTestRoomBotDelayOverrides,
  isLocalTournamentTestModeEnabled,
} from '../localTournamentTest/localTournamentTestModeGuard.js'
import { isHumanTurnTimeoutMs } from '../shared/humanTurnTimeoutOptions.js'
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

// "Време за реакция" — единствената точка, която чете state.humanTurnTimeoutMs.
// Override-ът се приема само ако е от whitelist-а (HUMAN_TURN_TIMEOUT_OPTIONS_MS);
// null/липсващ/невалиден (legacy persisted state, повреден JSON) пада обратно
// на стандартната стойност за фазата, така че произволен timeout не може да
// бъде наложен. Засяга само човешкия timeout — bot delay-ите и sweepOffer
// остават непроменени.
export function resolveServerHumanTurnTimeoutMs(
  state: Pick<ServerAuthoritativeGameState, 'humanTurnTimeoutMs'>,
  standardTimeoutMs: number,
): number {
  return isHumanTurnTimeoutMs(state.humanTurnTimeoutMs)
    ? state.humanTurnTimeoutMs
    : standardTimeoutMs
}

// Ефективната продължителност на човешки ход за текущата фаза — изпраща се
// в snapshot-а като пълната дължина на клиентската countdown лента, така че
// animation-duration винаги съвпада със сървърния durationMs.
export function getServerHumanTurnTimeoutMsForPhase(
  state: ServerAuthoritativeGameState,
): number {
  const standardTimeoutMs =
    state.phase === 'cutting'
      ? SERVER_TIMING_CONFIG.cutHumanTimeoutMs
      : state.phase === 'bidding'
        ? SERVER_TIMING_CONFIG.bidHumanTimeoutMs
        : SERVER_TIMING_CONFIG.playHumanTimeoutMs

  return resolveServerHumanTurnTimeoutMs(state, standardTimeoutMs)
}

export function createServerCuttingTimerState(
  state: ServerAuthoritativeGameState,
  activeSeat: Seat,
  startedAt: number = getServerTimerNow(),
): ServerTimerState {
  const durationMs = isServerSeatControlledByBot(state, activeSeat)
    ? resolveServerBotActionDelayMs(state, SERVER_TIMING_CONFIG.cutBotDelayMs)
    : resolveServerHumanTurnTimeoutMs(state, SERVER_TIMING_CONFIG.cutHumanTimeoutMs)

  return createServerTimerStateForSeat(activeSeat, durationMs, startedAt)
}

export function createServerBiddingTimerState(
  state: ServerAuthoritativeGameState,
  activeSeat: Seat,
  startedAt: number = getServerTimerNow(),
): ServerTimerState {
  const durationMs = isServerSeatControlledByBot(state, activeSeat)
    ? resolveServerBotActionDelayMs(state, SERVER_TIMING_CONFIG.bidBotDelayMs)
    : resolveServerHumanTurnTimeoutMs(state, SERVER_TIMING_CONFIG.bidHumanTimeoutMs)

  return createServerTimerStateForSeat(activeSeat, durationMs, startedAt)
}

export function createServerPlayingTimerState(
  state: ServerAuthoritativeGameState,
  activeSeat: Seat,
  startedAt: number = getServerTimerNow(),
): ServerTimerState {
  const durationMs = isServerSeatControlledByBot(state, activeSeat)
    ? resolveServerBotActionDelayMs(state, SERVER_TIMING_CONFIG.playBotDelayMs)
    : resolveServerHumanTurnTimeoutMs(state, SERVER_TIMING_CONFIG.playHumanTimeoutMs)

  return createServerTimerStateForSeat(activeSeat, durationMs, startedAt)
}

export function createServerSweepOfferTimerState(
  state: ServerAuthoritativeGameState,
  activeSeat: Seat,
  startedAt: number = getServerTimerNow(),
): ServerTimerState {
  const durationMs = isServerSeatControlledByBot(state, activeSeat)
    ? resolveServerBotActionDelayMs(state, SERVER_TIMING_CONFIG.sweepOfferBotDelayMs)
    : SERVER_TIMING_CONFIG.sweepOfferHumanTimeoutMs

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