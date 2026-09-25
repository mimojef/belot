import type { ServerAuthoritativeGameState } from './serverGameTypes.js'
import type { Seat } from '../core/serverTypes.js'
import type { ServerCard } from './serverGameTypes.js'
import {
  detectServerDeclarationsInHand,
  resolveServerDeclarationConflicts,
} from './declarations/index.js'
import { pickServerBotPlayCard } from './pickServerBotPlayCard.js'
import { rebaseServerStateToEventAt } from './rebaseServerStateToEventAt.js'
import { isServerSeatControlledByBot } from './serverTimerStateHelpers.js'
import { submitServerPlayCard } from './submitServerPlayCard.js'

export type AdvanceExpiredServerPlayingStateResult = {
  state: ServerAuthoritativeGameState
  advanced: boolean
  eventAt: number
  stopCatchUpAfterStep?: boolean
}

function canDeclareBotBeloteForCard(
  state: ServerAuthoritativeGameState,
  card: ServerCard,
): boolean {
  const winningBid = state.bidding.winningBid

  if (winningBid === null || winningBid.contract === 'no-trumps') {
    return false
  }

  if (winningBid.contract === 'suit') {
    return winningBid.trumpSuit === card.suit
  }

  const leadSuit = state.playing?.currentTrick.plays[0]?.card.suit ?? null

  return leadSuit === null || leadSuit === card.suit
}

// Mirrors the human client's default-selected declaration set
// (resolveClientDeclarationConflicts pre-checks these in the popup), so a
// bot seat or a human seat taken over on timeout declares exactly what a
// connected human would have submitted by pressing "Продължи" without
// touching the checkboxes.
export function getServerDefaultDeclarationKeysForPlay(
  state: ServerAuthoritativeGameState,
  seat: Seat,
  card: ServerCard,
): string[] {
  if (!isServerSeatControlledByBot(state, seat)) {
    return []
  }

  const playing = state.playing

  if (playing === null) {
    return []
  }

  const isFirstTrick = playing.currentTrick.trickIndex === 0

  const alreadyDeclaredKeys = new Set(
    state.declarations
      .filter((declaration) => declaration.seat === seat)
      .map((declaration) => declaration.key),
  )

  const candidates = detectServerDeclarationsInHand(
    state.hands[seat],
    state.bidding.winningBid,
  ).filter((candidate) => {
    if (alreadyDeclaredKeys.has(candidate.key)) {
      return false
    }

    if (candidate.type === 'belote') {
      return (
        candidate.cardIds.includes(card.id) &&
        candidate.privateMetadata.suit === card.suit &&
        canDeclareBotBeloteForCard(state, card)
      )
    }

    return isFirstTrick
  })

  const resolved = resolveServerDeclarationConflicts(candidates)

  return resolved.selectedCandidates.map((candidate) => candidate.key)
}

export function advanceExpiredServerPlayingState(
  state: ServerAuthoritativeGameState,
  eventAt: number,
): AdvanceExpiredServerPlayingStateResult {
  const playing = state.playing

  if (playing === null || !playing.hasStarted) {
    return { state, advanced: false, eventAt }
  }

  const currentSeat = playing.currentTurnSeat

  if (!currentSeat) {
    return { state, advanced: false, eventAt }
  }

  const stateWithBotControl = isServerSeatControlledByBot(state, currentSeat)
    ? state
    : {
        ...state,
        players: {
          ...state.players,
          [currentSeat]: {
            ...state.players[currentSeat],
            controlledByBot: true,
          },
        },
      }

  const card = pickServerBotPlayCard(stateWithBotControl, currentSeat)

  if (!card) {
    return { state, advanced: false, eventAt }
  }

  const declarationKeys = getServerDefaultDeclarationKeysForPlay(
    stateWithBotControl,
    currentSeat,
    card,
  )

  const nextState = rebaseServerStateToEventAt(
    submitServerPlayCard(
      stateWithBotControl,
      currentSeat,
      card.id,
      declarationKeys,
    ),
    eventAt,
  )

  return {
    state: nextState,
    advanced: true,
    eventAt,
    stopCatchUpAfterStep: true,
  }
}
