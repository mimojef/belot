import { getBiddingViewState } from '../state/getBiddingViewState'
import type { BidAction, Card, GameState, Suit } from '../state/gameTypes'
import type { Seat } from '../../data/constants/seatOrder'

const SUIT_OPTIONS: Suit[] = ['clubs', 'diamonds', 'hearts', 'spades']
const SEAT_ORDER: Seat[] = ['bottom', 'right', 'top', 'left']

const SUIT_TRUMP_VALUES: Record<string, number> = {
  J: 8.5,
  9: 7,
  A: 4.5,
  '10': 4,
  K: 2.2,
  Q: 1.8,
  8: 0.4,
  7: 0.1,
}

const SUIT_SIDE_VALUES: Record<string, number> = {
  A: 2,
  '10': 1.7,
  K: 0.7,
  Q: 0.4,
  J: 0.2,
  9: 0,
  8: 0,
  7: 0,
}

const NO_TRUMPS_VALUES: Record<string, number> = {
  A: 6,
  '10': 4.6,
  K: 2,
  Q: 1.4,
  J: 0.6,
  9: 0,
  8: 0,
  7: 0,
}

const ALL_TRUMPS_VALUES: Record<string, number> = {
  J: 6.4,
  9: 5.5,
  A: 3.1,
  '10': 2.6,
  K: 1.4,
  Q: 1.1,
  8: 0.3,
  7: 0.1,
}

type BotBidValidActions = NonNullable<ReturnType<typeof getBiddingViewState>>['validActions']

type BotContractCandidate = {
  action: BidAction
  score: number
}

type SuitProfile = {
  suit: Suit
  cards: Card[]
  count: number
  hasJ: boolean
  has9: boolean
  hasA: boolean
  has10: boolean
  hasK: boolean
  hasQ: boolean
  hasBelote: boolean
}

type OpponentSuitBidContext = {
  suit: Suit
  bidderSeat: Seat
  bidderPartnerSeat: Seat
}

export function pickBotBidAction(state: GameState, seat: Seat): BidAction {
  const biddingViewState = getBiddingViewState(state)

  if (!biddingViewState || biddingViewState.currentSeat !== seat) {
    return { type: 'pass' }
  }

  const validActions = biddingViewState.validActions
  const hand = state.hands[seat] ?? []

  const bestContract = getBestBotContractCandidate(state, seat, hand, validActions)

  if (!bestContract) {
    return { type: 'pass' }
  }

  if (bestContract.score >= getMinimumBotBidScore(bestContract.action)) {
    return bestContract.action
  }

  return { type: 'pass' }
}

function getBestBotContractCandidate(
  state: GameState,
  seat: Seat,
  hand: Card[],
  validActions: BotBidValidActions
): BotContractCandidate | null {
  const candidates: BotContractCandidate[] = []

  for (const suit of SUIT_OPTIONS) {
    if (!validActions.suits[suit]) {
      continue
    }

    candidates.push({
      action: { type: 'suit', suit },
      score: getSuitBidStrength(hand, suit),
    })
  }

  if (validActions.noTrumps) {
    candidates.push({
      action: { type: 'no-trumps' },
      score: getNoTrumpsBidStrength(hand),
    })
  }

  if (validActions.allTrumps) {
    candidates.push({
      action: { type: 'all-trumps' },
      score: getAllTrumpsBidStrength(state, seat, hand),
    })
  }

  if (candidates.length === 0) {
    return null
  }

  candidates.sort((left, right) => right.score - left.score)
  return candidates[0] ?? null
}

function getMinimumBotBidScore(action: BidAction): number {
  if (action.type === 'suit') {
    return 18
  }

  if (action.type === 'no-trumps') {
    return 21.5
  }

  if (action.type === 'all-trumps') {
    return 24
  }

  return Number.POSITIVE_INFINITY
}

function getSuitBidStrength(hand: Card[], suit: Suit): number {
  const profile = buildSuitProfile(hand, suit)

  let score = 0

  score += profile.cards.reduce(
    (sum, card) => sum + (SUIT_TRUMP_VALUES[String(card.rank)] ?? 0),
    0
  )

  score += getSideStrengthForSuitBid(hand, suit)
  score += getSuitLengthBonus(profile.count)

  if (profile.hasBelote) {
    score += 2.5
  }

  if (profile.hasJ && profile.has9) {
    score += 10
  }

  if (profile.hasJ && profile.hasA) {
    score += 4.5
  }

  if (profile.has9 && profile.hasA) {
    score += 3.5
  }

  if (profile.hasJ && profile.has10) {
    score += 3
  }

  if (profile.hasA && profile.has10) {
    score += 2.5
  }

  if (profile.hasJ && profile.has9 && profile.count >= 4) {
    score += 4
  }

  if (profile.count >= 5 && (profile.hasJ || profile.has9)) {
    score += 3.5
  }

  if (!profile.hasJ && !profile.has9 && profile.count < 5) {
    score -= 5
  }

  if (!profile.hasA && !profile.has10 && profile.count < 4) {
    score -= 3
  }

  return score
}

function getNoTrumpsBidStrength(hand: Card[]): number {
  let score = hand.reduce(
    (sum, card) => sum + (NO_TRUMPS_VALUES[String(card.rank)] ?? 0),
    0
  )

  const aces = hand.filter((card) => String(card.rank) === 'A').length
  const tens = hand.filter((card) => String(card.rank) === '10').length
  const kings = hand.filter((card) => String(card.rank) === 'K').length
  const queens = hand.filter((card) => String(card.rank) === 'Q').length

  score += aces * 1.8
  score += Math.min(tens, aces) * 1.5

  if (aces >= 2) {
    score += 3
  }

  if (aces >= 3) {
    score += 2
  }

  if (tens >= 2) {
    score += 1.5
  }

  for (const suit of SUIT_OPTIONS) {
    const suitCards = hand.filter((card) => card.suit === suit)
    const hasAce = suitCards.some((card) => String(card.rank) === 'A')
    const hasTen = suitCards.some((card) => String(card.rank) === '10')
    const hasKing = suitCards.some((card) => String(card.rank) === 'K')
    const hasQueen = suitCards.some((card) => String(card.rank) === 'Q')

    if (hasAce && hasTen) {
      score += 2.4
    }

    if (hasAce && (hasKing || hasQueen)) {
      score += 1.4
    }

    if (hasTen && hasKing) {
      score += 0.8
    }
  }

  if (aces === 0 && tens <= 1) {
    score -= 6
  }

  if (aces === 1 && tens === 0 && kings + queens < 3) {
    score -= 2.5
  }

  return score
}

function getAllTrumpsBidStrength(
  state: GameState,
  seat: Seat,
  hand: Card[]
): number {
  let score = hand.reduce(
    (sum, card) => sum + (ALL_TRUMPS_VALUES[String(card.rank)] ?? 0),
    0
  )

  const suitProfiles = SUIT_OPTIONS.map((suit) => buildSuitProfile(hand, suit))
  const bestSuitScore = Math.max(...suitProfiles.map(getAllTrumpsSuitCoreScore))
  const strongTrumpSuits = suitProfiles.filter(
    (profile) => profile.hasJ || profile.has9 || (profile.hasA && profile.has10)
  ).length
  const beloteCount = suitProfiles.filter((profile) => profile.hasBelote).length
  const totalJacks = hand.filter((card) => String(card.rank) === 'J').length
  const totalNines = hand.filter((card) => String(card.rank) === '9').length

  score += bestSuitScore
  score += strongTrumpSuits * 1.6
  score += beloteCount * 1.3
  score += totalJacks * 1.1
  score += totalNines * 1

  if (strongTrumpSuits >= 2) {
    score += 3
  }

  if (totalJacks >= 2) {
    score += 2
  }

  if (totalNines >= 2) {
    score += 1.5
  }

  if (bestSuitScore < 8 && strongTrumpSuits < 2) {
    score -= 6
  }

  score += getAllTrumpsRiskAdjustment(state, seat, hand)

  return score
}

function getAllTrumpsRiskAdjustment(
  state: GameState,
  seat: Seat,
  hand: Card[]
): number {
  const context = getLatestOpponentSuitBidContext(state, seat)

  if (!context) {
    return 0
  }

  const dangerProfile = buildSuitProfile(hand, context.suit)
  const totalJacksOutsideDanger = hand.filter(
    (card) => String(card.rank) === 'J' && card.suit !== context.suit
  ).length

  const hasAllThreeOtherJacks = totalJacksOutsideDanger === 3
  const hasCoveredDangerNine = dangerProfile.has9 && dangerProfile.count >= 2
  const hasTwoOtherJacks = totalJacksOutsideDanger >= 2

  const bidderUnderHand = isSeatUnderHandForBot(context.bidderSeat, seat)
  const bidderPartnerUnderHand = isSeatUnderHandForBot(context.bidderPartnerSeat, seat)
  const dangerTeamUnderHand = bidderUnderHand || bidderPartnerUnderHand

  if (hasAllThreeOtherJacks) {
    return 18
  }

  if (dangerTeamUnderHand) {
    return -16
  }

  if (hasCoveredDangerNine && hasTwoOtherJacks) {
    return 8
  }

  if (dangerProfile.has9 && !hasCoveredDangerNine) {
    return -4
  }

  return -2
}

function getLatestOpponentSuitBidContext(
  state: GameState,
  seat: Seat
): OpponentSuitBidContext | null {
  for (let index = state.bidding.entries.length - 1; index >= 0; index -= 1) {
    const entry = state.bidding.entries[index]

    if (isSameTeam(entry.seat, seat)) {
      continue
    }

    if (entry.action.type !== 'suit') {
      continue
    }

    return {
      suit: entry.action.suit,
      bidderSeat: entry.seat,
      bidderPartnerSeat: getPartnerSeat(entry.seat),
    }
  }

  return null
}

function getAllTrumpsSuitCoreScore(profile: SuitProfile): number {
  let score = 0

  if (profile.hasJ) score += 6
  if (profile.has9) score += 4.5
  if (profile.hasA) score += 2.5
  if (profile.has10) score += 2
  if (profile.hasBelote) score += 1.5
  if (profile.count >= 4) score += 1.2
  if (profile.count >= 5) score += 1.3

  if (profile.hasJ && profile.has9) {
    score += 5
  }

  if (profile.hasA && profile.has9) {
    score += 1.8
  }

  return score
}

function buildSuitProfile(hand: Card[], suit: Suit): SuitProfile {
  const cards = hand.filter((card) => card.suit === suit)

  return {
    suit,
    cards,
    count: cards.length,
    hasJ: cards.some((card) => String(card.rank) === 'J'),
    has9: cards.some((card) => String(card.rank) === '9'),
    hasA: cards.some((card) => String(card.rank) === 'A'),
    has10: cards.some((card) => String(card.rank) === '10'),
    hasK: cards.some((card) => String(card.rank) === 'K'),
    hasQ: cards.some((card) => String(card.rank) === 'Q'),
    hasBelote:
      cards.some((card) => String(card.rank) === 'K') &&
      cards.some((card) => String(card.rank) === 'Q'),
  }
}

function getSuitLengthBonus(count: number): number {
  if (count >= 6) return 7
  if (count >= 5) return 4.8
  if (count >= 4) return 2.8
  if (count >= 3) return 1
  return 0
}

function getSideStrengthForSuitBid(hand: Card[], trumpSuit: Suit): number {
  let score = 0

  for (const suit of SUIT_OPTIONS) {
    if (suit === trumpSuit) {
      continue
    }

    const suitCards = hand.filter((card) => card.suit === suit)

    for (const card of suitCards) {
      score += SUIT_SIDE_VALUES[String(card.rank)] ?? 0
    }

    const hasAce = suitCards.some((card) => String(card.rank) === 'A')
    const hasTen = suitCards.some((card) => String(card.rank) === '10')

    if (hasAce && hasTen) {
      score += 0.8
    }
  }

  return score
}

function getPartnerSeat(seat: Seat): Seat {
  switch (seat) {
    case 'bottom':
      return 'top'
    case 'top':
      return 'bottom'
    case 'right':
      return 'left'
    case 'left':
      return 'right'
  }
}

function isSameTeam(firstSeat: Seat, secondSeat: Seat): boolean {
  return getTeamBySeat(firstSeat) === getTeamBySeat(secondSeat)
}

function getTeamBySeat(seat: Seat): 'A' | 'B' {
  return seat === 'bottom' || seat === 'top' ? 'A' : 'B'
}

function isSeatUnderHandForBot(candidateSeat: Seat, botSeat: Seat): boolean {
  return getPreviousSeat(botSeat) === candidateSeat
}

function getPreviousSeat(seat: Seat): Seat {
  const index = SEAT_ORDER.indexOf(seat)

  if (index <= 0) {
    return SEAT_ORDER[SEAT_ORDER.length - 1]
  }

  return SEAT_ORDER[index - 1]
}