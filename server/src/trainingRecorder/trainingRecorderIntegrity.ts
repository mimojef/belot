import type { ServerCard } from '../game/serverGameTypes.js'
import type { TrainingDealRecord, TrainingIntegrity } from './trainingRecorderTypes.js'

const EXPECTED_INITIAL_CARDS = 32
const EXPECTED_PLAYED_CARDS = 32
const EXPECTED_TRICKS = 8
const EXPECTED_PLAYS_PER_TRICK = 4
const MAX_RECORD_BYTES = 500_000

export function validateTrainingRecord(
  record: TrainingDealRecord,
  serialized: string,
): TrainingIntegrity {
  const violations: string[] = []

  // ─── Initial cards ────────────────────────────────────────────────────────

  const allInitialCards: ServerCard[] = [
    ...record.initialHands.bottom,
    ...record.initialHands.right,
    ...record.initialHands.top,
    ...record.initialHands.left,
  ]
  const initialCardCount = allInitialCards.length
  const uniqueInitialIds = new Set(allInitialCards.map((c) => c.id))
  const uniqueInitialCardCount = uniqueInitialIds.size

  if (initialCardCount !== EXPECTED_INITIAL_CARDS) {
    violations.push(`Expected ${EXPECTED_INITIAL_CARDS} initial cards, got ${initialCardCount}`)
  }

  if (uniqueInitialCardCount !== initialCardCount) {
    violations.push(
      `Duplicate cards in initial hands: ${initialCardCount - uniqueInitialCardCount} duplicates`,
    )
  }

  // ─── Played cards ─────────────────────────────────────────────────────────

  const playedCards = record.cardActions.map((a) => a.chosenCard)
  const playedCardCount = playedCards.length
  const uniquePlayedIds = new Set(playedCards.map((c) => c.id))
  const uniquePlayedCardCount = uniquePlayedIds.size

  if (playedCardCount !== EXPECTED_PLAYED_CARDS) {
    violations.push(`Expected ${EXPECTED_PLAYED_CARDS} played cards, got ${playedCardCount}`)
  }

  if (uniquePlayedCardCount !== playedCardCount) {
    violations.push(
      `Duplicate cards in card actions: ${playedCardCount - uniquePlayedCardCount} duplicates`,
    )
  }

  // All played cards must belong to initial deck
  for (const card of playedCards) {
    if (!uniqueInitialIds.has(card.id)) {
      violations.push(`Played card ${card.id} not found in initial hands`)
    }
  }

  // ─── Tricks ───────────────────────────────────────────────────────────────

  if (record.tricks.length > EXPECTED_TRICKS) {
    violations.push(`Too many tricks: ${record.tricks.length}, max ${EXPECTED_TRICKS}`)
  }

  for (const trick of record.tricks) {
    if (trick.plays.length !== EXPECTED_PLAYS_PER_TRICK) {
      violations.push(
        `Trick ${trick.trickIndex} has ${trick.plays.length} plays, expected ${EXPECTED_PLAYS_PER_TRICK}`,
      )
    }
  }

  // ─── Sequence numbers ─────────────────────────────────────────────────────

  const bidSeqs = record.biddingActions.map((a) => a.sequence)
  for (let i = 1; i < bidSeqs.length; i++) {
    if ((bidSeqs[i] ?? 0) <= (bidSeqs[i - 1] ?? -1)) {
      violations.push(`Bidding sequence not strictly increasing at index ${i}`)
      break
    }
  }

  const cardSeqs = record.cardActions.map((a) => a.sequence)
  for (let i = 1; i < cardSeqs.length; i++) {
    if ((cardSeqs[i] ?? 0) <= (cardSeqs[i - 1] ?? -1)) {
      violations.push(`Card action sequence not strictly increasing at index ${i}`)
      break
    }
  }

  // ─── Seat validation ──────────────────────────────────────────────────────

  const validSeats = new Set(['bottom', 'right', 'top', 'left'])

  for (const action of record.biddingActions) {
    if (!validSeats.has(action.seat)) {
      violations.push(`Invalid seat in bidding action: ${action.seat}`)
    }
  }

  for (const action of record.cardActions) {
    if (!validSeats.has(action.seat)) {
      violations.push(`Invalid seat in card action: ${action.seat}`)
    }
  }

  // ─── Payload size guard ───────────────────────────────────────────────────

  if (Buffer.byteLength(serialized, 'utf8') > MAX_RECORD_BYTES) {
    violations.push(
      `Record payload too large: ${Buffer.byteLength(serialized, 'utf8')} bytes (max ${MAX_RECORD_BYTES})`,
    )
  }

  return {
    initialCardCount,
    playedCardCount,
    uniqueInitialCardCount,
    uniquePlayedCardCount,
    valid: violations.length === 0,
    violations,
  }
}
