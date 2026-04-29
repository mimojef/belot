import type { Seat } from '../core/serverTypes.js'
import type {
  ServerAuthoritativeGameState,
  ServerCard,
  ServerRank,
  ServerSuit,
  ServerTrickPlay,
  ServerWinningBid,
} from './serverGameTypes.js'
import { getTeamBySeat } from './serverStateHelpers.js'
import { getServerTrickWinner } from './getServerTrickWinner.js'

// Trump suit rank power (J highest, then 9, A, 10, K, Q, 8, 7)
const TRUMP_RANK_POWER: Record<ServerRank, number> = {
  '7': 0,
  '8': 1,
  Q: 2,
  K: 3,
  '10': 4,
  A: 5,
  '9': 6,
  J: 7,
}

function getLeadSuit(plays: ServerTrickPlay[]): ServerSuit | null {
  return plays[0]?.card.suit ?? null
}

function getCardsBySuit(cards: ServerCard[], suit: ServerSuit): ServerCard[] {
  return cards.filter((c) => c.suit === suit)
}

function getTrumpSuit(winningBid: ServerWinningBid): ServerSuit | null {
  if (!winningBid || winningBid.contract !== 'suit') {
    return null
  }
  return winningBid.trumpSuit
}

// Highest trump-ordered card of a given suit among the current plays.
function getHighestCardInSuitByTrumpOrder(
  plays: ServerTrickPlay[],
  suit: ServerSuit,
): ServerCard | null {
  const suitedCards = plays.map((p) => p.card).filter((c) => c.suit === suit)
  if (suitedCards.length === 0) return null

  let highest = suitedCards[0]!
  for (let i = 1; i < suitedCards.length; i++) {
    const challenger = suitedCards[i]!
    if (TRUMP_RANK_POWER[challenger.rank] > TRUMP_RANK_POWER[highest.rank]) {
      highest = challenger
    }
  }
  return highest
}

// Cards from `cards` that beat `highestCard` by trump rank power.
function getHigherCardsByTrumpOrder(
  cards: ServerCard[],
  highestCard: ServerCard | null,
): ServerCard[] {
  if (!highestCard) return cards
  return cards.filter((c) => TRUMP_RANK_POWER[c.rank] > TRUMP_RANK_POWER[highestCard.rank])
}

// Is the partner of `seat` currently winning the trick?
function isPartnerWinning(seat: Seat, winningPlay: ServerTrickPlay | null): boolean {
  if (!winningPlay) return false
  return getTeamBySeat(seat) === getTeamBySeat(winningPlay.seat)
}

// ---- Suit contract (козов договор) ----
// Adapted from legacy getValidCardsInSuitContract.
function getValidCardsInSuitContract(
  seat: Seat,
  hand: ServerCard[],
  plays: ServerTrickPlay[],
  leadSuit: ServerSuit,
  trumpSuit: ServerSuit,
  winningBid: ServerWinningBid,
): ServerCard[] {
  const followSuitCards = getCardsBySuit(hand, leadSuit)
  const trumpCards = getCardsBySuit(hand, trumpSuit)
  const currentWinningPlay = getServerTrickWinner(plays, winningBid)

  if (leadSuit === trumpSuit) {
    // Led with trump — must follow trump; if no trump, play anything.
    if (followSuitCards.length === 0) return hand

    // Must overtrump if possible.
    const highestTrumpInTrick = getHighestCardInSuitByTrumpOrder(plays, trumpSuit)
    const higherTrumps = getHigherCardsByTrumpOrder(followSuitCards, highestTrumpInTrick)
    return higherTrumps.length > 0 ? higherTrumps : followSuitCards
  }

  // Led with non-trump — must follow suit.
  if (followSuitCards.length > 0) return followSuitCards

  // Can't follow suit. If partner is winning, no obligation to trump.
  if (isPartnerWinning(seat, currentWinningPlay)) return hand

  // Partner is not winning. Must play trump if we have one.
  if (trumpCards.length === 0) return hand

  // Must overtrump if possible.
  const highestTrumpInTrick = getHighestCardInSuitByTrumpOrder(plays, trumpSuit)
  const higherTrumps = getHigherCardsByTrumpOrder(trumpCards, highestTrumpInTrick)
  return higherTrumps.length > 0 ? higherTrumps : hand
}

// ---- All-trumps contract (всичко коз) ----
// Every suit is treated as trump. Must overplay if possible.
// Adapted from legacy getValidCardsInAllTrumpsContract.
function getValidCardsInAllTrumpsContract(
  hand: ServerCard[],
  plays: ServerTrickPlay[],
  leadSuit: ServerSuit,
): ServerCard[] {
  const followSuitCards = getCardsBySuit(hand, leadSuit)

  if (followSuitCards.length === 0) return hand

  const highestLeadCard = getHighestCardInSuitByTrumpOrder(plays, leadSuit)
  const higherCards = getHigherCardsByTrumpOrder(followSuitCards, highestLeadCard)
  return higherCards.length > 0 ? higherCards : followSuitCards
}

// ---- No-trumps contract (без коз) ----
// Inline in getServerValidPlayCards: follow suit or play anything.

// Returns the subset of `hand` that are legal to play on the current trick.
// When it is the first card of a trick (plays is empty), all cards are valid.
export function getServerValidPlayCards(
  state: ServerAuthoritativeGameState,
  seat: Seat,
): ServerCard[] {
  const hand = state.hands[seat] ?? []
  const plays = state.playing?.currentTrick?.plays ?? []
  const leadSuit = getLeadSuit(plays)
  const winningBid = state.bidding.winningBid

  if (hand.length === 0) return []

  // First card of trick — free choice.
  if (!leadSuit) return hand

  if (winningBid?.contract === 'all-trumps') {
    return getValidCardsInAllTrumpsContract(hand, plays, leadSuit)
  }

  const trumpSuit = getTrumpSuit(winningBid)
  if (trumpSuit) {
    return getValidCardsInSuitContract(seat, hand, plays, leadSuit, trumpSuit, winningBid)
  }

  // No-trumps: follow suit; if void, play anything.
  const followSuitCards = getCardsBySuit(hand, leadSuit)
  return followSuitCards.length > 0 ? followSuitCards : hand
}
