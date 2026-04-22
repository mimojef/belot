import type { Card, GameState } from './gameTypes'
import type { Seat } from '../../data/constants/seatOrder'
import { getValidCardsForSeat } from '../rules/getValidCardsForSeat'

export type BottomHandSortMode = {
  contract: 'all-trumps' | 'no-trumps' | 'suit' | 'unknown'
  trumpSuit: string | null
}

export type BottomHandViewCard = Card & {
  isPlayable?: boolean
}

export type BottomHandViewState = {
  shouldShow: boolean
  cards: BottomHandViewCard[]
  phase: GameState['phase']
  dealerSeat: Seat | null
  phaseEnteredAt: number | null
  sortMode: BottomHandSortMode
}

function shouldShowBottomHandForPhase(phase: GameState['phase']): boolean {
  return (
    phase === 'deal-first-3' ||
    phase === 'deal-next-2' ||
    phase === 'bidding' ||
    phase === 'deal-last-3' ||
    phase === 'playing'
  )
}

function resolveBottomHandSortMode(state: GameState): BottomHandSortMode {
  const unsafeState = state as GameState & {
    bidding?: {
      winningBid?: unknown
      highestBid?: unknown
      contract?: unknown
      trumpSuit?: unknown
    }
    round?: {
      winningBid?: unknown
      highestBid?: unknown
      contract?: unknown
      trumpSuit?: unknown
    }
  }

  const winningBid =
    unsafeState.bidding?.winningBid ??
    unsafeState.round?.winningBid ??
    unsafeState.bidding?.highestBid ??
    unsafeState.round?.highestBid ??
    null

  if (winningBid && typeof winningBid === 'object') {
    const unsafeBid = winningBid as {
      type?: unknown
      contract?: unknown
      suit?: unknown
      trumpSuit?: unknown
    }

    const rawKind =
      (typeof unsafeBid.type === 'string' ? unsafeBid.type : null) ??
      (typeof unsafeBid.contract === 'string' ? unsafeBid.contract : null)

    const rawSuit =
      (typeof unsafeBid.suit === 'string' ? unsafeBid.suit : null) ??
      (typeof unsafeBid.trumpSuit === 'string' ? unsafeBid.trumpSuit : null)

    if (rawKind === 'all-trumps') {
      return {
        contract: 'all-trumps',
        trumpSuit: rawSuit,
      }
    }

    if (rawKind === 'no-trumps') {
      return {
        contract: 'no-trumps',
        trumpSuit: null,
      }
    }

    if (rawKind === 'suit' || rawKind === 'color') {
      return {
        contract: 'suit',
        trumpSuit: rawSuit,
      }
    }
  }

  const fallbackContract =
    (typeof unsafeState.bidding?.contract === 'string' ? unsafeState.bidding.contract : null) ??
    (typeof unsafeState.round?.contract === 'string' ? unsafeState.round.contract : null)

  const fallbackTrumpSuit =
    (typeof unsafeState.bidding?.trumpSuit === 'string' ? unsafeState.bidding.trumpSuit : null) ??
    (typeof unsafeState.round?.trumpSuit === 'string' ? unsafeState.round.trumpSuit : null)

  if (fallbackContract === 'all-trumps') {
    return {
      contract: 'all-trumps',
      trumpSuit: fallbackTrumpSuit,
    }
  }

  if (fallbackContract === 'no-trumps') {
    return {
      contract: 'no-trumps',
      trumpSuit: null,
    }
  }

  if (fallbackContract === 'suit' || fallbackContract === 'color') {
    return {
      contract: 'suit',
      trumpSuit: fallbackTrumpSuit,
    }
  }

  return {
    contract: 'unknown',
    trumpSuit: null,
  }
}

function resolvePlayableCardIds(state: GameState): Set<string> {
  if (state.phase !== 'playing') {
    return new Set()
  }

  const currentTurnSeat = state.playing?.currentTurnSeat ?? null

  if (currentTurnSeat !== 'bottom') {
    return new Set()
  }

  const validCards = getValidCardsForSeat(state, 'bottom')
  const validIds = new Set<string>()

  for (const card of validCards) {
    if (typeof card.id === 'string' && card.id.length > 0) {
      validIds.add(card.id)
    }
  }

  return validIds
}

export function getBottomHandViewState(state: GameState): BottomHandViewState {
  const shouldShow = shouldShowBottomHandForPhase(state.phase)
  const playableCardIds = resolvePlayableCardIds(state)
  const cards = shouldShow
    ? state.hands.bottom.map((card) => ({
        ...card,
        isPlayable:
          state.phase === 'playing' &&
          state.playing?.currentTurnSeat === 'bottom' &&
          typeof card.id === 'string' &&
          playableCardIds.has(card.id),
      }))
    : []

  return {
    shouldShow,
    cards,
    phase: state.phase,
    dealerSeat: state.round.dealerSeat,
    phaseEnteredAt: state.phaseEnteredAt ?? null,
    sortMode: resolveBottomHandSortMode(state),
  }
}