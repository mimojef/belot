import { finalizePendingScoringTransition } from '../phases/finalizePendingScoringTransition'
import { resolveCutPhase } from '../phases/resolveCutPhase'
import { runPhaseTransition } from '../phases/runPhaseTransition'
import { selectCutIndex } from '../phases/selectCutIndex'
import { submitBidAction } from '../phases/submitBidAction'
import { submitPlayCard } from '../phases/submitPlayCard'
import { pickBotBidAction } from '../rules/pickBotBidAction'
import { pickBotCardToPlay } from '../rules/pickBotCardToPlay'
import type { GameState } from '../state/gameTypes'
import {
  clearTimerState,
  createPlayingTimerState,
  getTimerNow,
  isSeatControlledByBot,
} from './timerStateHelpers'

const MAX_CATCH_UP_STEPS = 256

const CUT_RESOLVE_AUTO_ADVANCE_MS = 0
const DEAL_FIRST_THREE_AUTO_ADVANCE_MS = 2000
const DEAL_NEXT_TWO_AUTO_ADVANCE_MS = 1900
const DEAL_LAST_THREE_AUTO_ADVANCE_MS = 2000
const NEXT_ROUND_AUTO_ADVANCE_MS = 1000

type AdvanceStepResult = {
  state: GameState
  advanced: boolean
  eventAt: number
}

function resolveNow(now?: number): number {
  if (typeof now === 'number' && Number.isFinite(now)) {
    return now
  }

  return getTimerNow()
}

function getTimerExpiry(state: GameState): number | null {
  const expiresAt = state.timer.expiresAt

  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
    return null
  }

  return expiresAt
}

function getPhaseEnteredAt(state: GameState): number | null {
  const phaseEnteredAt = state.phaseEnteredAt

  if (typeof phaseEnteredAt !== 'number' || !Number.isFinite(phaseEnteredAt)) {
    return null
  }

  return phaseEnteredAt
}

function getPhaseAutoAdvanceDelay(phase: GameState['phase']): number | null {
  if (phase === 'cut-resolve') {
    return CUT_RESOLVE_AUTO_ADVANCE_MS
  }

  if (phase === 'deal-first-3') {
    return DEAL_FIRST_THREE_AUTO_ADVANCE_MS
  }

  if (phase === 'deal-next-2') {
    return DEAL_NEXT_TWO_AUTO_ADVANCE_MS
  }

  if (phase === 'deal-last-3') {
    return DEAL_LAST_THREE_AUTO_ADVANCE_MS
  }

  if (phase === 'next-round') {
    return NEXT_ROUND_AUTO_ADVANCE_MS
  }

  return null
}

function getPhaseAutoAdvanceExpiry(state: GameState): number | null {
  const phaseEnteredAt = getPhaseEnteredAt(state)
  const delayMs = getPhaseAutoAdvanceDelay(state.phase)

  if (phaseEnteredAt === null || delayMs === null) {
    return null
  }

  return phaseEnteredAt + delayMs
}

function rebaseStateToEventAt(state: GameState, eventAt: number): GameState {
  const durationMs = state.timer.durationMs
  const hasTimerDuration = typeof durationMs === 'number' && Number.isFinite(durationMs)

  return {
    ...state,
    phaseEnteredAt: eventAt,
    timer: hasTimerDuration
      ? {
          ...state.timer,
          startedAt: eventAt,
          expiresAt: eventAt + durationMs,
        }
      : state.timer,
  }
}

function pickAutoCutIndex(state: GameState): number {
  const totalCards = state.deck.length

  if (totalCards <= 2) {
    return 1
  }

  const minIndex = Math.min(6, totalCards - 1)
  const maxIndex = Math.max(minIndex, totalCards - 6)

  if (maxIndex <= minIndex) {
    return Math.max(1, Math.floor(totalCards / 2))
  }

  return minIndex + Math.floor(Math.random() * (maxIndex - minIndex + 1))
}

function resolveSelectedCut(state: GameState, eventAt: number): AdvanceStepResult {
  const resolvedState = {
    ...resolveCutPhase(state),
    timer: clearTimerState(),
  }

  return {
    state: rebaseStateToEventAt(resolvedState, eventAt),
    advanced: true,
    eventAt,
  }
}

function advanceExpiredCuttingState(state: GameState, eventAt: number): AdvanceStepResult {
  if (state.round.selectedCutIndex !== null) {
    return resolveSelectedCut(state, eventAt)
  }

  return {
    state: rebaseStateToEventAt(selectCutIndex(state, pickAutoCutIndex(state)), eventAt),
    advanced: true,
    eventAt,
  }
}

function advanceExpiredBiddingState(state: GameState, eventAt: number): AdvanceStepResult {
  const currentSeat = state.bidding.currentSeat

  if (!currentSeat) {
    return {
      state,
      advanced: false,
      eventAt,
    }
  }

  const action = pickBotBidAction(state, currentSeat)

  return {
    state: rebaseStateToEventAt(submitBidAction(state, action), eventAt),
    advanced: true,
    eventAt,
  }
}

function advanceExpiredPlayingState(state: GameState, eventAt: number): AdvanceStepResult {
  const currentSeat = state.playing?.currentTurnSeat ?? state.currentTrick.currentSeat

  if (!currentSeat) {
    return {
      state,
      advanced: false,
      eventAt,
    }
  }

  if (!isSeatControlledByBot(state, currentSeat)) {
    const takeoverState: GameState = {
      ...state,
      players: {
        ...state.players,
        [currentSeat]: {
          ...state.players[currentSeat],
          controlledByBot: true,
        },
      },
    }

    return {
      state: {
        ...takeoverState,
        timer: createPlayingTimerState(takeoverState, currentSeat, eventAt),
      },
      advanced: true,
      eventAt,
    }
  }

  const botCard = pickBotCardToPlay(state, currentSeat)

  if (!botCard) {
    return {
      state,
      advanced: false,
      eventAt,
    }
  }

  return {
    state: rebaseStateToEventAt(submitPlayCard(state, botCard.id), eventAt),
    advanced: true,
    eventAt,
  }
}

function advancePendingScoringState(state: GameState, eventAt: number): AdvanceStepResult {
  return {
    state: rebaseStateToEventAt(finalizePendingScoringTransition(state), eventAt),
    advanced: true,
    eventAt,
  }
}

function advanceExpiredScoringState(state: GameState, eventAt: number): AdvanceStepResult {
  return {
    state: rebaseStateToEventAt(runPhaseTransition(state), eventAt),
    advanced: true,
    eventAt,
  }
}

function advanceExpiredAutoPhaseState(state: GameState, eventAt: number): AdvanceStepResult {
  return {
    state: rebaseStateToEventAt(runPhaseTransition(state), eventAt),
    advanced: true,
    eventAt,
  }
}

function advanceOneStep(
  state: GameState,
  now: number,
  fallbackEventAt: number
): AdvanceStepResult {
  if (state.phase === 'playing' && state.playing?.pendingScoringTransition) {
    return advancePendingScoringState(state, fallbackEventAt)
  }

  if (state.phase === 'cutting' && state.round.selectedCutIndex !== null) {
    return resolveSelectedCut(state, fallbackEventAt)
  }

  const phaseAutoAdvanceExpiry = getPhaseAutoAdvanceExpiry(state)

  if (phaseAutoAdvanceExpiry !== null && now >= phaseAutoAdvanceExpiry) {
    return advanceExpiredAutoPhaseState(state, phaseAutoAdvanceExpiry)
  }

  const expiresAt = getTimerExpiry(state)

  if (expiresAt === null || now < expiresAt) {
    return {
      state,
      advanced: false,
      eventAt: fallbackEventAt,
    }
  }

  if (state.phase === 'cutting') {
    return advanceExpiredCuttingState(state, expiresAt)
  }

  if (state.phase === 'bidding' && !state.bidding.hasEnded) {
    return advanceExpiredBiddingState(state, expiresAt)
  }

  if (state.phase === 'playing') {
    return advanceExpiredPlayingState(state, expiresAt)
  }

  if (state.phase === 'scoring') {
    return advanceExpiredScoringState(state, expiresAt)
  }

  return {
    state,
    advanced: false,
    eventAt: fallbackEventAt,
  }
}

export function advanceGameToNow(state: GameState, now?: number): GameState {
  const resolvedNow = resolveNow(now)
  let currentState = state
  let lastEventAt = getTimerExpiry(state) ?? getPhaseAutoAdvanceExpiry(state) ?? resolvedNow

  for (let step = 0; step < MAX_CATCH_UP_STEPS; step += 1) {
    const result = advanceOneStep(currentState, resolvedNow, lastEventAt)

    if (!result.advanced) {
      return currentState
    }

    currentState = result.state
    lastEventAt = result.eventAt
  }

  return currentState
}