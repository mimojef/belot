import type { Seat } from '../core/serverTypes.js'
import { getValidServerBidActions } from './getValidServerBidActions.js'
import type {
  ServerAuthoritativeGameState,
  ServerBidAction,
  ServerCard,
  ServerSuit,
} from './serverGameTypes.js'

const SERVER_SUIT_OPTIONS: ServerSuit[] = ['clubs', 'diamonds', 'hearts', 'spades']
const SERVER_SEAT_ORDER: Seat[] = ['bottom', 'right', 'top', 'left']

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

type BotContractCandidate = {
  action: ServerBidAction
  score: number
}

type SuitProfile = {
  suit: ServerSuit
  cards: ServerCard[]
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
  suit: ServerSuit
  bidderSeat: Seat
  bidderPartnerSeat: Seat
}

type RankCounts = Record<string, number>

export function pickServerBotBidAction(
  state: ServerAuthoritativeGameState,
  seat: Seat,
): ServerBidAction {
  if (state.phase !== 'bidding' || state.bidding.currentSeat !== seat) {
    return { type: 'pass' }
  }

  const validActions = getValidServerBidActions(seat, state.bidding.winningBid)
  const hand = state.hands[seat] ?? []

  const bestContract = getBestBotContractCandidate(state, seat, hand, validActions)

  if (!bestContract) {
    return { type: 'pass' }
  }

  if (bestContract.score >= getMinimumBotBidScore(bestContract.action, hand)) {
    return bestContract.action
  }

  return { type: 'pass' }
}

function getBestBotContractCandidate(
  state: ServerAuthoritativeGameState,
  seat: Seat,
  hand: ServerCard[],
  validActions: ReturnType<typeof getValidServerBidActions>,
): BotContractCandidate | null {
  const candidates: BotContractCandidate[] = []

  for (const suit of SERVER_SUIT_OPTIONS) {
    if (!validActions.suits[suit]) {
      continue
    }

    candidates.push({
      action: { type: 'suit', suit },
      score:
        getSuitBidStrength(hand, suit) +
        getAnnouncementPressureBonus({ type: 'suit', suit }, hand),
    })
  }

  if (validActions.noTrumps) {
    candidates.push({
      action: { type: 'no-trumps' },
      score:
        getNoTrumpsBidStrength(hand) +
        getAnnouncementPressureBonus({ type: 'no-trumps' }, hand),
    })
  }

  if (validActions.allTrumps) {
    candidates.push({
      action: { type: 'all-trumps' },
      score:
        getAllTrumpsBidStrength(state, seat, hand) +
        getAnnouncementPressureBonus({ type: 'all-trumps' }, hand),
    })
  }

  if (candidates.length === 0) {
    return null
  }

  candidates.sort((left, right) => right.score - left.score)
  return candidates[0] ?? null
}

function getMinimumBotBidScore(action: ServerBidAction, hand: ServerCard[]): number {
  const rankCounts = getRankCounts(hand)
  const hasSquareJ = rankCounts.J === 4
  const hasSquare9 = rankCounts['9'] === 4
  const hasSquareHigh =
    rankCounts.A === 4 ||
    rankCounts['10'] === 4 ||
    rankCounts.K === 4 ||
    rankCounts.Q === 4

  if (action.type === 'suit') {
    let minimum = 18

    if (hasSquareJ) {
      minimum -= 6
    } else if (hasSquare9) {
      minimum -= 5
    } else if (hasSquareHigh) {
      minimum -= 2
    }

    return minimum
  }

  if (action.type === 'no-trumps') {
    let minimum = 21.5

    if (hasSquareJ) {
      minimum -= 1
    } else if (hasSquare9) {
      minimum -= 0.5
    }

    return minimum
  }

  if (action.type === 'all-trumps') {
    return 26
  }

  return Number.POSITIVE_INFINITY
}

function getSuitBidStrength(hand: ServerCard[], suit: ServerSuit): number {
  const profile = buildSuitProfile(hand, suit)

  let score = 0

  score += profile.cards.reduce(
    (sum, card) => sum + (SUIT_TRUMP_VALUES[String(card.rank)] ?? 0),
    0,
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

function getNoTrumpsBidStrength(hand: ServerCard[]): number {
  let score = hand.reduce(
    (sum, card) => sum + (NO_TRUMPS_VALUES[String(card.rank)] ?? 0),
    0,
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

  for (const suit of SERVER_SUIT_OPTIONS) {
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
  state: ServerAuthoritativeGameState,
  seat: Seat,
  hand: ServerCard[],
): number {
  let score = hand.reduce(
    (sum, card) => sum + (ALL_TRUMPS_VALUES[String(card.rank)] ?? 0),
    0,
  )

  const suitProfiles = SERVER_SUIT_OPTIONS.map((suit) => buildSuitProfile(hand, suit))
  const bestSuitProfile = getBestAllTrumpsSuitProfile(suitProfiles)
  const bestSuitScore = getAllTrumpsSuitCoreScore(bestSuitProfile)
  const strongTrumpSuits = suitProfiles.filter(
    (profile) =>
      profile.hasJ ||
      (profile.has9 && (profile.hasA || profile.has10 || profile.count >= 3)) ||
      (profile.hasA && profile.has10 && profile.count >= 4),
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

  if (totalJacks >= 3) {
    score += 2.5
  }

  if (totalNines >= 2) {
    score += 1.5
  }

  if (bestSuitProfile.hasJ && bestSuitProfile.has9) {
    score += 3.5
  }

  if (bestSuitProfile.hasJ && bestSuitProfile.count >= 4) {
    score += 2
  }

  if (!bestSuitProfile.hasJ) {
    score -= 7
  }

  if (totalJacks === 1) {
    score -= 5
  }

  if (totalJacks === 0) {
    score -= 18
  }

  if (totalJacks === 0 && totalNines <= 1) {
    score -= 7
  }

  if (totalJacks === 0 && strongTrumpSuits < 2) {
    score -= 6
  }

  if (totalJacks === 1 && totalNines === 0 && bestSuitProfile.count < 4) {
    score -= 3.5
  }

  if (bestSuitScore < 8 && strongTrumpSuits < 2) {
    score -= 6
  }

  score += getAllTrumpsRiskAdjustment(state, seat, hand)

  return score
}

function getAnnouncementPressureBonus(
  action: ServerBidAction,
  hand: ServerCard[],
): number {
  const rankCounts = getRankCounts(hand)

  const hasSquareJ = rankCounts.J === 4
  const hasSquare9 = rankCounts['9'] === 4
  const hasSquareA = rankCounts.A === 4
  const hasSquare10 = rankCounts['10'] === 4
  const hasSquareK = rankCounts.K === 4
  const hasSquareQ = rankCounts.Q === 4
  const hasAnyHighSquare = hasSquareA || hasSquare10 || hasSquareK || hasSquareQ

  if (action.type === 'suit') {
    let bonus = 0

    if (hasSquareJ) {
      bonus += 18
    }

    if (hasSquare9) {
      bonus += 15
    }

    if (hasAnyHighSquare) {
      bonus += 7
    }

    return bonus
  }

  if (action.type === 'no-trumps') {
    let bonus = 0

    if (hasSquareJ) {
      bonus += 4
    }

    if (hasSquare9) {
      bonus += 3
    }

    if (hasAnyHighSquare) {
      bonus += 4
    }

    return bonus
  }

  if (action.type === 'all-trumps') {
    let bonus = 0

    if (hasSquareJ) {
      bonus += 8
    }

    if (hasSquare9) {
      bonus += 4
    }

    if (hasAnyHighSquare) {
      bonus += 2
    }

    return bonus
  }

  return 0
}

function getAllTrumpsRiskAdjustment(
  state: ServerAuthoritativeGameState,
  seat: Seat,
  hand: ServerCard[],
): number {
  const context = getLatestOpponentSuitBidContext(state, seat)

  if (!context) {
    return 0
  }

  const dangerProfile = buildSuitProfile(hand, context.suit)
  const totalJacks = hand.filter((card) => String(card.rank) === 'J').length
  const totalJacksOutsideDanger = hand.filter(
    (card) => String(card.rank) === 'J' && card.suit !== context.suit,
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

  if (dangerTeamUnderHand && totalJacks === 0) {
    return -22
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

  if (totalJacks === 0) {
    return -6
  }

  return -2
}

function getLatestOpponentSuitBidContext(
  state: ServerAuthoritativeGameState,
  seat: Seat,
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

function getBestAllTrumpsSuitProfile(suitProfiles: SuitProfile[]): SuitProfile {
  return [...suitProfiles].sort(
    (left, right) => getAllTrumpsSuitCoreScore(right) - getAllTrumpsSuitCoreScore(left),
  )[0]!
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

function buildSuitProfile(hand: ServerCard[], suit: ServerSuit): SuitProfile {
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

function getRankCounts(hand: ServerCard[]): RankCounts {
  const counts: RankCounts = {}

  for (const card of hand) {
    const rank = String(card.rank)
    counts[rank] = (counts[rank] ?? 0) + 1
  }

  return counts
}

function getSuitLengthBonus(count: number): number {
  if (count >= 6) return 7
  if (count >= 5) return 4.8
  if (count >= 4) return 2.8
  if (count >= 3) return 1
  return 0
}

function getSideStrengthForSuitBid(
  hand: ServerCard[],
  trumpSuit: ServerSuit,
): number {
  let score = 0

  for (const suit of SERVER_SUIT_OPTIONS) {
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
  const index = SERVER_SEAT_ORDER.indexOf(seat)

  if (index <= 0) {
    return SERVER_SEAT_ORDER[SERVER_SEAT_ORDER.length - 1]
  }

  return SERVER_SEAT_ORDER[index - 1]
}