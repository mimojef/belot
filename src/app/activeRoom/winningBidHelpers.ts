import type {
  RoomAuthoritativePhaseSnapshot,
  RoomGameSnapshot,
  RoomWinningBidSnapshot,
} from '../network/createGameServerClient'

type Suit = 'clubs' | 'diamonds' | 'hearts' | 'spades'

/**
 * Returns the current winningBid from whatever phase snapshot has it.
 * Priority: bidding → playing → scoring (lifecycle order).
 * Returns null when no contract exists yet (pre-bidding or passed round).
 */
export function selectWinningBidFromGame(
  game: RoomGameSnapshot | null | undefined,
): NonNullable<RoomWinningBidSnapshot> | null {
  return (
    game?.bidding?.winningBid ??
    game?.playing?.winningBid ??
    game?.scoring?.winningBid ??
    null
  )
}

const PRE_CONTRACT_PHASES: ReadonlySet<RoomAuthoritativePhaseSnapshot> = new Set([
  'cutting',
  'cut-resolve',
  'deal-first-3',
  'deal-next-2',
  'bidding',
])

/**
 * Pure state machine for lastKnownWinningBid in the active room controller.
 *
 * Rules:
 * - Current snapshot has a winningBid → use it (handles reconnect, normal play, scoring).
 * - Phase is pre-contract and no winningBid → clear to null (new round, old contract must not persist).
 * - Otherwise (null game, unknown phase) → keep previous value unchanged.
 */
export function computeNextLastKnownWinningBid(
  previous: NonNullable<RoomWinningBidSnapshot> | null,
  game: RoomGameSnapshot | null | undefined,
): NonNullable<RoomWinningBidSnapshot> | null {
  const fresh = selectWinningBidFromGame(game)
  if (fresh !== null) {
    return fresh
  }
  const phase = game?.authoritativePhase ?? null
  if (phase !== null && PRE_CONTRACT_PHASES.has(phase)) {
    return null
  }
  return previous
}

function formatSuit(suit: Suit | null): string {
  if (suit === 'clubs') return 'Спатия'
  if (suit === 'diamonds') return 'Каро'
  if (suit === 'hearts') return 'Купа'
  if (suit === 'spades') return 'Пика'
  return '—'
}

export function formatBidType(
  winningBid: NonNullable<RoomWinningBidSnapshot> | null,
): string {
  if (winningBid === null) return 'Няма обява'
  if (winningBid.contract === 'all-trumps') return 'Всичко коз'
  if (winningBid.contract === 'no-trumps') return 'Без коз'
  if (winningBid.contract === 'suit') return formatSuit(winningBid.trumpSuit)
  return 'Няма обява'
}

export function getBidMultiplierLabel(
  winningBid: NonNullable<RoomWinningBidSnapshot> | null,
): string {
  if (winningBid?.redoubled) return ' x4'
  if (winningBid?.doubled) return ' x2'
  return ''
}
