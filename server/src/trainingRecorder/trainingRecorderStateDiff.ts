import type {
  ServerAuthoritativeGameState,
  ServerBidAction,
  ServerBidEntry,
} from '../game/serverGameTypes.js'
import type { TrainingCompactPlayedCard } from './trainingRecorderTypes.js'

// ─── Bid entry diff ────────────────────────────────────────────────────────

export type BidDiffResult =
  | { kind: 'added'; entry: ServerBidEntry }
  | { kind: 'unchanged' }
  | { kind: 'mismatch' }

function bidActionsEqual(a: ServerBidAction, b: ServerBidAction): boolean {
  if (a.type !== b.type) return false
  if (a.type === 'suit' && b.type === 'suit') return a.suit === b.suit
  return true
}

function bidEntriesEqual(a: ServerBidEntry, b: ServerBidEntry): boolean {
  return a.seat === b.seat && bidActionsEqual(a.action, b.action)
}

// Finds the single bid entry appended between previousState and nextState.
//
// This works uniformly for bidding→bidding, bidding→deal-last-3, and
// bidding→next-round transitions because ServerBiddingState.entries is
// preserved unchanged (never reset) across all three — see
// finalizeServerBiddingPhase.ts and enterServerPhase.ts. There is no need to
// special-case the "last bid" transitions: nextState.bidding.entries already
// contains the final entry in every case.
export function findAddedBidEntry(
  previousState: ServerAuthoritativeGameState,
  nextState: ServerAuthoritativeGameState,
): BidDiffResult {
  const prevEntries = previousState.bidding.entries
  const nextEntries = nextState.bidding.entries

  if (nextEntries.length !== prevEntries.length && nextEntries.length !== prevEntries.length + 1) {
    return { kind: 'mismatch' }
  }

  for (let i = 0; i < prevEntries.length; i++) {
    if (!bidEntriesEqual(prevEntries[i]!, nextEntries[i]!)) {
      return { kind: 'mismatch' }
    }
  }

  if (nextEntries.length === prevEntries.length) {
    return { kind: 'unchanged' }
  }

  return { kind: 'added', entry: nextEntries[nextEntries.length - 1]! }
}

// ─── Played card diff ──────────────────────────────────────────────────────

// Chronological history of every card played so far: completed tricks in
// order, followed by the plays of the trick currently in progress. This is
// the single source of truth for "what has been played" — no assumptions
// about which index holds the Nth card.
export function flattenPlayedCards(
  state: ServerAuthoritativeGameState,
): TrainingCompactPlayedCard[] {
  const playing = state.playing
  if (!playing) return []

  const result: TrainingCompactPlayedCard[] = []
  let sequence = 0

  for (const trick of playing.completedTricks) {
    for (let i = 0; i < trick.plays.length; i++) {
      sequence += 1
      const play = trick.plays[i]!
      result.push({
        sequence,
        trickIndex: trick.trickIndex,
        positionInTrick: i,
        seat: play.seat,
        card: play.card,
      })
    }
  }

  for (let i = 0; i < playing.currentTrick.plays.length; i++) {
    sequence += 1
    const play = playing.currentTrick.plays[i]!
    result.push({
      sequence,
      trickIndex: playing.currentTrick.trickIndex,
      positionInTrick: i,
      seat: play.seat,
      card: play.card,
    })
  }

  return result
}

export type CardDiffResult =
  | { kind: 'added'; play: TrainingCompactPlayedCard }
  | { kind: 'unchanged' }
  | { kind: 'mismatch' }

// Finds the single card play appended between previousState and nextState.
//
// Works uniformly for playing→playing and playing→scoring transitions:
// startServerScoringPhase.ts preserves `playing` unchanged when entering
// scoring, so the 32nd card is present in nextState's flattened history
// exactly like any other card.
export function findAddedPlayedCard(
  previousState: ServerAuthoritativeGameState,
  nextState: ServerAuthoritativeGameState,
): CardDiffResult {
  const prevHistory = flattenPlayedCards(previousState)
  const nextHistory = flattenPlayedCards(nextState)

  if (nextHistory.length !== prevHistory.length && nextHistory.length !== prevHistory.length + 1) {
    return { kind: 'mismatch' }
  }

  for (let i = 0; i < prevHistory.length; i++) {
    const p = prevHistory[i]!
    const n = nextHistory[i]!
    if (p.seat !== n.seat || p.card.id !== n.card.id) {
      return { kind: 'mismatch' }
    }
  }

  if (nextHistory.length === prevHistory.length) {
    return { kind: 'unchanged' }
  }

  return { kind: 'added', play: nextHistory[nextHistory.length - 1]! }
}
