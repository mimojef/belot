import type { Card, GameState, TrickPlay } from '../state/gameTypes'
import {
  getNextSeatCounterClockwise,
  getTeamBySeat,
} from '../state/createInitialState'
import { getValidCardsForSeat } from '../rules/getValidCardsForSeat'
import { getWinningTrickPlay } from '../rules/getWinningTrickPlay'

function removeCardFromHand(hand: Card[], cardId: string): Card[] {
  return hand.filter((card) => card.id !== cardId)
}

export function submitPlayCard(state: GameState, cardId: string): GameState {
  if (state.phase !== 'playing') {
    return state
  }

  const currentSeat = state.playing?.currentTurnSeat ?? state.currentTrick.currentSeat

  if (!currentSeat) {
    return state
  }

  const currentHand = state.hands[currentSeat] ?? []
  const selectedCard = currentHand.find((card) => card.id === cardId)

  if (!selectedCard) {
    return state
  }

  const validCards = getValidCardsForSeat(state, currentSeat)
  const isValidCard = validCards.some((card) => card.id === cardId)

  if (!isValidCard) {
    return state
  }

  const nextHands = {
    ...state.hands,
    [currentSeat]: removeCardFromHand(currentHand, cardId),
  }

  const nextPlay: TrickPlay = {
    seat: currentSeat,
    card: selectedCard,
  }

  const nextPlays = [...state.currentTrick.plays, nextPlay]
  const isTrickComplete = nextPlays.length === 4

  if (!isTrickComplete) {
    const nextCurrentSeat = getNextSeatCounterClockwise(currentSeat)

    const nextCurrentTrick = {
      ...state.currentTrick,
      currentSeat: nextCurrentSeat,
      plays: nextPlays,
    }

    return {
      ...state,
      hands: nextHands,
      currentTrick: nextCurrentTrick,
      playing: state.playing
        ? {
            ...state.playing,
            currentTurnSeat: nextCurrentSeat,
            currentTrick: nextCurrentTrick,
          }
        : state.playing,
    }
  }

  const winningPlay = getWinningTrickPlay(nextPlays, state.bidding.winningBid)

  if (!winningPlay) {
    return {
      ...state,
      hands: nextHands,
    }
  }

  const winnerSeat = winningPlay.seat
  const winnerTeam = getTeamBySeat(winnerSeat)
  const trickCards = nextPlays.map((play) => play.card)
  const completedTrickIndex = state.currentTrick.trickIndex

  const completedTrick = {
    trickIndex: completedTrickIndex,
    leaderSeat: state.currentTrick.leaderSeat ?? winnerSeat,
    plays: nextPlays,
    winnerSeat,
    winningTeam: winnerTeam,
  }

  const nextWonTricks = {
    ...state.wonTricks,
    [winnerTeam]: [...state.wonTricks[winnerTeam], trickCards],
  }

  const nextPlaying = state.playing
    ? {
        ...state.playing,
        currentTurnSeat: winnerSeat,
        currentTrick: {
          leaderSeat: winnerSeat,
          currentSeat: winnerSeat,
          plays: [],
          winnerSeat: null,
          trickIndex: completedTrickIndex + 1,
        },
        completedTricks: [...state.playing.completedTricks, completedTrick],
        lastCompletedTrickWinnerSeat: winnerSeat,
        lastCompletedTrickWinnerTeam: winnerTeam,
        wonTricksBySeat: {
          ...state.playing.wonTricksBySeat,
          [winnerSeat]: [...state.playing.wonTricksBySeat[winnerSeat], trickCards],
        },
        wonTricksByTeam: {
          ...state.playing.wonTricksByTeam,
          [winnerTeam]: [...state.playing.wonTricksByTeam[winnerTeam], trickCards],
        },
      }
    : state.playing

  const nextCurrentTrick = {
    leaderSeat: winnerSeat,
    currentSeat: winnerSeat,
    plays: [],
    winnerSeat: null,
    trickIndex: completedTrickIndex + 1,
  }

  return {
    ...state,
    hands: nextHands,
    currentTrick: nextCurrentTrick,
    wonTricks: nextWonTricks,
    playing: nextPlaying,
  }
}