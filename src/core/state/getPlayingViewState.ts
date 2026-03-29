import type { Seat } from '../../data/constants/seatOrder'
import type { Card, GameState, TrickPlay, WinningBid } from './gameTypes'
import { getValidCardsForSeat } from '../rules/getValidCardsForSeat'

export type PlayingViewState = {
  phase: 'playing'
  currentTurnSeat: Seat | null
  leaderSeat: Seat | null
  trickIndex: number
  plays: TrickPlay[]
  winningBid: WinningBid
  bottomHand: Card[]
  validBottomCardIds: string[]
  isBottomTurn: boolean
}

export function getPlayingViewState(state: GameState): PlayingViewState | null {
  if (state.phase !== 'playing') {
    return null
  }

  const currentTurnSeat =
    state.playing?.currentTurnSeat ?? state.currentTrick.currentSeat

  const bottomHand = state.hands.bottom
  const validBottomCards =
    currentTurnSeat === 'bottom' ? getValidCardsForSeat(state, 'bottom') : []

  return {
    phase: 'playing',
    currentTurnSeat,
    leaderSeat: state.playing?.currentTrick.leaderSeat ?? state.currentTrick.leaderSeat,
    trickIndex: state.playing?.currentTrick.trickIndex ?? state.currentTrick.trickIndex,
    plays: state.playing?.currentTrick.plays ?? state.currentTrick.plays,
    winningBid: state.bidding.winningBid,
    bottomHand,
    validBottomCardIds: validBottomCards.map((card) => card.id),
    isBottomTurn: currentTurnSeat === 'bottom',
  }
}