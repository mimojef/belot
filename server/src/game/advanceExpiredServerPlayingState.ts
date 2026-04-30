import type { ServerAuthoritativeGameState } from './serverGameTypes.js'
import type { Seat } from '../core/serverTypes.js'
import type { ServerCard } from './serverGameTypes.js'
import { detectServerDeclarationsInHand } from './declarations/index.js'
import { pickServerBotPlayCard } from './pickServerBotPlayCard.js'
import { rebaseServerStateToEventAt } from './rebaseServerStateToEventAt.js'
import { isServerSeatControlledByBot } from './serverTimerStateHelpers.js'
import { submitServerPlayCard } from './submitServerPlayCard.js'

export type AdvanceExpiredServerPlayingStateResult = {
  state: ServerAuthoritativeGameState
  advanced: boolean
  eventAt: number
}

function getBotBeloteDeclarationKeysForPlay(
  state: ServerAuthoritativeGameState,
  seat: Seat,
  card: ServerCard,
): string[] {
  if (!isServerSeatControlledByBot(state, seat)) {
    return []
  }

  if (card.rank !== 'Q' && card.rank !== 'K') {
    return []
  }

  const alreadyDeclared = state.declarations.some(
    (declaration) =>
      declaration.seat === seat &&
      declaration.type === 'belote' &&
      declaration.suit === card.suit,
  )

  if (alreadyDeclared) {
    return []
  }

  const candidate = detectServerDeclarationsInHand(
    state.hands[seat],
    state.bidding.winningBid,
  ).find(
    (declaration) =>
      declaration.type === 'belote' && declaration.cardIds.includes(card.id),
  )

  return candidate ? [candidate.key] : []
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

  const declarationKeys = getBotBeloteDeclarationKeysForPlay(
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
  }
}
