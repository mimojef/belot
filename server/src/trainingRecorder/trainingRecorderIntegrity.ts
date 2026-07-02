import type { ServerCard } from '../game/serverGameTypes.js'
import type { TrainingDealRecord, TrainingIntegrity } from './trainingRecorderTypes.js'

const EXPECTED_SEATS = 4
const EXPECTED_BIDDING_CARDS_PER_SEAT = 5   // 20 total at bidding start
const EXPECTED_INITIAL_CARDS = 32           // 8 per seat at playing start (full deals only)
const EXPECTED_PLAYED_CARDS = 32
const EXPECTED_TRICKS = 8
const EXPECTED_PLAYS_PER_TRICK = 4
const MAX_RECORD_BYTES = 500_000

export function validateTrainingRecord(
  record: TrainingDealRecord,
  serialized: string,
): TrainingIntegrity {
  const violations: string[] = []
  const isBiddingOnly = record.recordKind === 'bidding_only'

  // ─── handsAtBiddingStart: 20 cards, 5 per seat, all unique ───────────────

  const biddingStartCards: ServerCard[] = [
    ...record.handsAtBiddingStart.bottom,
    ...record.handsAtBiddingStart.right,
    ...record.handsAtBiddingStart.top,
    ...record.handsAtBiddingStart.left,
  ]
  const biddingStartCount = biddingStartCards.length
  const expectedBiddingTotal = EXPECTED_SEATS * EXPECTED_BIDDING_CARDS_PER_SEAT

  if (biddingStartCount !== expectedBiddingTotal) {
    violations.push(
      `Expected ${expectedBiddingTotal} handsAtBiddingStart cards (5 per seat), got ${biddingStartCount}`,
    )
  }
  const uniqueBiddingIds = new Set(biddingStartCards.map((c) => c.id))
  if (uniqueBiddingIds.size !== biddingStartCount) {
    violations.push(
      `Duplicate cards in handsAtBiddingStart: ${biddingStartCount - uniqueBiddingIds.size} duplicates`,
    )
  }

  // ─── initialHands: required for full deals, null for bidding_only ─────────

  const allInitialCards: ServerCard[] = []
  let initialCardCount = 0
  let uniqueInitialCardCount = 0

  if (isBiddingOnly) {
    if (record.initialHands !== null) {
      violations.push('bidding_only record must have initialHands: null')
    }
  } else {
    if (record.initialHands === null) {
      violations.push('full record must have initialHands (8 cards per seat)')
    } else {
      allInitialCards.push(
        ...record.initialHands.bottom,
        ...record.initialHands.right,
        ...record.initialHands.top,
        ...record.initialHands.left,
      )
      initialCardCount = allInitialCards.length
      const uniqueInitialIds = new Set(allInitialCards.map((c) => c.id))
      uniqueInitialCardCount = uniqueInitialIds.size

      if (initialCardCount !== EXPECTED_INITIAL_CARDS) {
        violations.push(`Expected ${EXPECTED_INITIAL_CARDS} initial cards, got ${initialCardCount}`)
      }
      if (uniqueInitialCardCount !== initialCardCount) {
        violations.push(
          `Duplicate cards in initial hands: ${initialCardCount - uniqueInitialCardCount} duplicates`,
        )
      }

      // ─── Played cards ─────────────────────────────────────────────────────

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
      for (const card of playedCards) {
        if (!uniqueInitialIds.has(card.id)) {
          violations.push(`Played card ${card.id} not found in initial hands`)
        }
      }

      // ─── Tricks ───────────────────────────────────────────────────────────

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
    }
  }

  // ─── bidding_only: must have no card actions or tricks ────────────────────

  if (isBiddingOnly) {
    if (record.cardActions.length !== 0) {
      violations.push(`bidding_only record must have 0 card actions, got ${record.cardActions.length}`)
    }
    if (record.tricks.length !== 0) {
      violations.push(`bidding_only record must have 0 tricks, got ${record.tricks.length}`)
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

  // For played cards, use the counts computed above; for bidding_only use 0
  const playedCards = isBiddingOnly ? [] : record.cardActions.map((a) => a.chosenCard)
  const playedCardCount = playedCards.length
  const uniquePlayedIds = new Set(playedCards.map((c) => c.id))

  return {
    initialCardCount,
    playedCardCount,
    uniqueInitialCardCount,
    uniquePlayedCardCount: uniquePlayedIds.size,
    valid: violations.length === 0,
    violations,
  }
}
