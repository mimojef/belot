import type { Seat } from '../../data/constants/seatOrder'
import type {
  Card,
  Declaration,
  GameState,
  TrickPlay,
  WinningBid,
} from './gameTypes'
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
  botDebugDeclarations: Declaration[]
}

type TrickCollectionSnapshotLike = {
  trickIndex?: unknown
  winnerSeat?: unknown
  plays?: unknown[]
}

type PlayingStateWithTrickCollectionSnapshot = NonNullable<GameState['playing']> & {
  trickCollectionSnapshot?: TrickCollectionSnapshotLike | null
}

function isSeat(value: unknown): value is Seat {
  return value === 'bottom' || value === 'left' || value === 'top' || value === 'right'
}

function isTrickPlay(value: unknown): value is TrickPlay {
  if (!value || typeof value !== 'object') {
    return false
  }

  const maybePlay = value as {
    seat?: unknown
    card?: unknown
  }

  if (!isSeat(maybePlay.seat)) {
    return false
  }

  if (!maybePlay.card || typeof maybePlay.card !== 'object') {
    return false
  }

  return true
}

function resolveTrickCollectionSnapshot(
  state: GameState
): TrickCollectionSnapshotLike | null {
  const playingState = state.playing as PlayingStateWithTrickCollectionSnapshot | null | undefined

  return playingState?.trickCollectionSnapshot ?? null
}

function resolveSnapshotPlays(snapshot: TrickCollectionSnapshotLike | null): TrickPlay[] {
  if (!snapshot || !Array.isArray(snapshot.plays)) {
    return []
  }

  return snapshot.plays.filter(isTrickPlay)
}

function resolveSnapshotTrickIndex(
  snapshot: TrickCollectionSnapshotLike | null,
  fallbackTrickIndex: number
): number {
  if (snapshot && typeof snapshot.trickIndex === 'number') {
    return snapshot.trickIndex
  }

  return fallbackTrickIndex
}

function resolveSnapshotLeaderSeat(
  snapshotPlays: TrickPlay[],
  fallbackLeaderSeat: Seat | null
): Seat | null {
  if (snapshotPlays.length > 0) {
    return snapshotPlays[0].seat
  }

  return fallbackLeaderSeat
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

  const botDebugDeclarations = state.declarations.filter((declaration) => {
    if (declaration.seat === 'bottom') {
      return false
    }

    return state.players[declaration.seat]?.mode === 'bot'
  })

  const fallbackLeaderSeat =
    state.playing?.currentTrick.leaderSeat ?? state.currentTrick.leaderSeat

  const fallbackTrickIndex =
    state.playing?.currentTrick.trickIndex ?? state.currentTrick.trickIndex

  const fallbackPlays =
    state.playing?.currentTrick.plays ?? state.currentTrick.plays

  const trickCollectionSnapshot = resolveTrickCollectionSnapshot(state)
  const snapshotPlays = resolveSnapshotPlays(trickCollectionSnapshot)

  const plays = snapshotPlays.length > 0 ? snapshotPlays : fallbackPlays
  const leaderSeat = resolveSnapshotLeaderSeat(snapshotPlays, fallbackLeaderSeat)
  const trickIndex = resolveSnapshotTrickIndex(
    trickCollectionSnapshot,
    fallbackTrickIndex
  )

  return {
    phase: 'playing',
    currentTurnSeat,
    leaderSeat,
    trickIndex,
    plays,
    winningBid: state.bidding.winningBid,
    bottomHand,
    validBottomCardIds: validBottomCards.map((card) => card.id),
    isBottomTurn: currentTurnSeat === 'bottom',
    botDebugDeclarations,
  }
}