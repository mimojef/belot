import { detectDeclarationsInHand } from '../rules/detectDeclarationsInHand'
import {
  createEmptyPlayingState,
  createEmptyTrickState,
} from '../state/createRoundDefaults'
import type { Declaration, GameState } from '../state/gameTypes'

function collectBotOpeningDeclarations(state: GameState): Declaration[] {
  const winningBid = state.bidding.winningBid

  if (!winningBid) {
    return []
  }

  const declarations: Declaration[] = []

  for (const player of Object.values(state.players)) {
    if (player.mode !== 'bot') {
      continue
    }

    const hand = state.hands[player.seat] ?? []

    if (hand.length === 0) {
      continue
    }

    const detectedDeclarations = detectDeclarationsInHand({
      seat: player.seat,
      team: player.team,
      hand,
      winningBid,
      announced: true,
    })
      .filter((declaration) => declaration.type !== 'belote')
      .map((declaration) => ({
        ...declaration,
        announced: true,
        valid: true,
      }))

    declarations.push(...detectedDeclarations)
  }

  return declarations
}

export function startPlayingPhase(state: GameState): GameState {
  const firstTurnSeat = state.round.firstDealSeat

  const initialTrick = {
    ...createEmptyTrickState(),
    leaderSeat: firstTurnSeat,
    currentSeat: firstTurnSeat,
    trickIndex: 0,
  }

  const preservedHumanDeclarations = state.declarations.filter((declaration) => {
    return state.players[declaration.seat]?.mode !== 'bot'
  })

  const botOpeningDeclarations = collectBotOpeningDeclarations(state)

  return {
    ...state,
    phase: 'playing',
    declarations: [...preservedHumanDeclarations, ...botOpeningDeclarations],
    currentTrick: initialTrick,
    playing: {
      ...createEmptyPlayingState(),
      hasStarted: true,
      currentTurnSeat: firstTurnSeat,
      currentTrick: initialTrick,
    },
  }
}