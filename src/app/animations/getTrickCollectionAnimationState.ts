import type { Seat } from '../../data/constants/seatOrder'
import type { GameState } from '../../core/state/gameTypes'

export type TrickCollectionAnimationState = {
  trickKey: string | null
  winnerSeat: Seat | null
  shouldAnimate: boolean
}

type SnapshotPlayLike = {
  card?: {
    id?: unknown
    suit?: unknown
    rank?: unknown
  }
}

type TrickCollectionSnapshotLike = {
  trickIndex?: unknown
  winnerSeat?: unknown
  plays?: unknown[]
}

function buildCardSignature(card: unknown): string {
  if (!card || typeof card !== 'object') {
    return 'unknown-card'
  }

  const maybeCard = card as {
    id?: unknown
    suit?: unknown
    rank?: unknown
  }

  if (typeof maybeCard.id === 'string' && maybeCard.id.length > 0) {
    return maybeCard.id
  }

  const suit =
    typeof maybeCard.suit === 'string' && maybeCard.suit.length > 0
      ? maybeCard.suit
      : 'unknown-suit'

  const rank =
    typeof maybeCard.rank === 'string' && maybeCard.rank.length > 0
      ? maybeCard.rank
      : 'unknown-rank'

  return `${suit}-${rank}`
}

function buildTrickKey(
  roundIndex: number | null,
  trickIndex: number | null,
  cards: unknown[],
): string | null {
  if (cards.length === 0) {
    return null
  }

  const normalizedRoundIndex = typeof roundIndex === 'number' ? roundIndex : 0
  const normalizedTrickIndex = typeof trickIndex === 'number' ? trickIndex : 0
  const cardPart = cards.map(buildCardSignature).join('|')

  return `round:${normalizedRoundIndex};trick:${normalizedTrickIndex};cards:${cardPart}`
}

function isSeat(value: unknown): value is Seat {
  return value === 'bottom' || value === 'left' || value === 'top' || value === 'right'
}

function resolveRoundIndex(state: GameState): number | null {
  const maybeState = state as GameState & {
    roundIndex?: number
    round?: { roundIndex?: number; index?: number }
  }

  if (typeof maybeState.roundIndex === 'number') {
    return maybeState.roundIndex
  }

  if (typeof maybeState.round?.roundIndex === 'number') {
    return maybeState.round.roundIndex
  }

  if (typeof maybeState.round?.index === 'number') {
    return maybeState.round.index
  }

  return null
}

function resolveSnapshot(state: GameState): TrickCollectionSnapshotLike | null {
  const maybeState = state as GameState & {
    playing?: GameState['playing'] & {
      trickCollectionSnapshot?: TrickCollectionSnapshotLike | null
    }
  }

  return maybeState.playing?.trickCollectionSnapshot ?? null
}

function resolveSnapshotWinnerSeat(snapshot: TrickCollectionSnapshotLike | null): Seat | null {
  if (!snapshot) {
    return null
  }

  return isSeat(snapshot.winnerSeat) ? snapshot.winnerSeat : null
}

function resolveSnapshotTrickIndex(snapshot: TrickCollectionSnapshotLike | null): number | null {
  if (!snapshot) {
    return null
  }

  return typeof snapshot.trickIndex === 'number' ? snapshot.trickIndex : null
}

function resolveSnapshotCards(snapshot: TrickCollectionSnapshotLike | null): unknown[] {
  if (!snapshot || !Array.isArray(snapshot.plays)) {
    return []
  }

  return snapshot.plays.map((play) => {
    const maybePlay = play as SnapshotPlayLike
    return maybePlay.card ?? null
  })
}

function resolveFallbackCurrentTrickCards(state: GameState): unknown[] {
  const maybeState = state as GameState & {
    currentTrick?: { plays?: unknown[] }
    trick?: { plays?: unknown[] }
    round?: { currentTrick?: { plays?: unknown[] } }
  }

  if (Array.isArray(maybeState.currentTrick?.plays)) {
    return maybeState.currentTrick.plays
  }

  if (Array.isArray(maybeState.trick?.plays)) {
    return maybeState.trick.plays
  }

  if (Array.isArray(maybeState.round?.currentTrick?.plays)) {
    return maybeState.round.currentTrick.plays
  }

  return []
}

function resolveFallbackWinningSeat(state: GameState): Seat | null {
  const maybeState = state as GameState & {
    currentTrickWinnerSeat?: Seat | null
    trickWinnerSeat?: Seat | null
    round?: {
      currentTrickWinnerSeat?: Seat | null
      trickWinnerSeat?: Seat | null
    }
  }

  if (maybeState.currentTrickWinnerSeat) {
    return maybeState.currentTrickWinnerSeat
  }

  if (maybeState.trickWinnerSeat) {
    return maybeState.trickWinnerSeat
  }

  if (maybeState.round?.currentTrickWinnerSeat) {
    return maybeState.round.currentTrickWinnerSeat
  }

  if (maybeState.round?.trickWinnerSeat) {
    return maybeState.round.trickWinnerSeat
  }

  return null
}

function resolveFallbackTrickIndex(state: GameState): number | null {
  const maybeState = state as GameState & {
    trickIndex?: number
    currentTrickIndex?: number
    round?: { trickIndex?: number; currentTrickIndex?: number }
    completedTricks?: unknown[]
    roundState?: { completedTricks?: unknown[] }
  }

  if (typeof maybeState.currentTrickIndex === 'number') {
    return maybeState.currentTrickIndex
  }

  if (typeof maybeState.trickIndex === 'number') {
    return maybeState.trickIndex
  }

  if (typeof maybeState.round?.currentTrickIndex === 'number') {
    return maybeState.round.currentTrickIndex
  }

  if (typeof maybeState.round?.trickIndex === 'number') {
    return maybeState.round.trickIndex
  }

  if (Array.isArray(maybeState.completedTricks)) {
    return maybeState.completedTricks.length
  }

  if (Array.isArray(maybeState.roundState?.completedTricks)) {
    return maybeState.roundState.completedTricks.length
  }

  return null
}

export function getTrickCollectionAnimationState(
  state: GameState,
): TrickCollectionAnimationState {
  const snapshot = resolveSnapshot(state)
  const snapshotCards = resolveSnapshotCards(snapshot)
  const snapshotWinnerSeat = resolveSnapshotWinnerSeat(snapshot)
  const snapshotTrickIndex = resolveSnapshotTrickIndex(snapshot)

  if (
    state.phase === 'playing' &&
    snapshotCards.length > 0 &&
    snapshotWinnerSeat !== null
  ) {
    return {
      trickKey: buildTrickKey(resolveRoundIndex(state), snapshotTrickIndex, snapshotCards),
      winnerSeat: snapshotWinnerSeat,
      shouldAnimate: true,
    }
  }

  const fallbackCards = resolveFallbackCurrentTrickCards(state)
  const fallbackWinnerSeat = resolveFallbackWinningSeat(state)
  const shouldAnimate =
    state.phase === 'playing' &&
    fallbackCards.length > 0 &&
    fallbackWinnerSeat !== null

  return {
    trickKey: shouldAnimate
      ? buildTrickKey(resolveRoundIndex(state), resolveFallbackTrickIndex(state), fallbackCards)
      : null,
    winnerSeat: fallbackWinnerSeat,
    shouldAnimate,
  }
}