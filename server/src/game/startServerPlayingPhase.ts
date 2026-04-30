import { SERVER_SEAT_ORDER } from '../core/serverTypes.js'
import type {
  ServerAuthoritativeGameState,
  ServerDeclaration,
} from './serverGameTypes.js'
import {
  detectServerDeclarationsInHand,
  resolveServerDeclarationConflicts,
} from './declarations/index.js'
import { createServerDeclarationRecord } from './serverDeclarationRecordHelpers.js'
import {
  clearServerTimerState,
  createServerPlayingTimerState,
  isServerSeatControlledByBot,
} from './serverTimerStateHelpers.js'
import {
  createEmptyPlayingState,
  createEmptyTrickState,
} from './createServerRoundDefaults.js'

function createBotOpeningDeclarations(
  state: ServerAuthoritativeGameState,
): ServerDeclaration[] {
  const contract = state.bidding.winningBid

  if (contract === null) {
    return []
  }

  return SERVER_SEAT_ORDER.flatMap((seat) => {
    if (!isServerSeatControlledByBot(state, seat)) {
      return []
    }

    const existingKeysForSeat = new Set(
      state.declarations
        .filter((declaration) => declaration.seat === seat)
        .map((declaration) => declaration.key),
    )
    const candidates = detectServerDeclarationsInHand(
      state.hands[seat],
      contract,
    ).filter(
      (candidate) =>
        candidate.type !== 'belote' && !existingKeysForSeat.has(candidate.key),
    )
    const resolved = resolveServerDeclarationConflicts(candidates)

    return resolved.selectedCandidates.map((candidate) =>
      createServerDeclarationRecord({
        candidate,
        seat,
        declaredAtTrickIndex: 0,
      }),
    )
  })
}

export function startServerPlayingPhase(
  state: ServerAuthoritativeGameState,
): ServerAuthoritativeGameState {
  if (state.playing?.hasStarted) {
    return state
  }

  const firstPlayerSeat = state.round.firstDealSeat
  const botOpeningDeclarations = createBotOpeningDeclarations(state)

  if (!firstPlayerSeat) {
    return {
      ...state,
      phase: 'playing',
      playing: createEmptyPlayingState(),
      declarations: [...state.declarations, ...botOpeningDeclarations],
      timer: clearServerTimerState(),
    }
  }

  const firstTrick = {
    ...createEmptyTrickState(),
    leaderSeat: firstPlayerSeat,
    currentSeat: firstPlayerSeat,
    trickIndex: 0,
  }

  return {
    ...state,
    phase: 'playing',
    playing: {
      ...createEmptyPlayingState(),
      hasStarted: true,
      currentTurnSeat: firstPlayerSeat,
      currentTrick: firstTrick,
    },
    declarations: [...state.declarations, ...botOpeningDeclarations],
    timer: createServerPlayingTimerState(state, firstPlayerSeat),
  }
}
