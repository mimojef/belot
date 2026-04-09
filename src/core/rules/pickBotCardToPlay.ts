import type {
  Card,
  CompletedTrick,
  GameState,
  Rank,
  Suit,
  Team,
  TrickPlay,
  WinningBid,
} from '../state/gameTypes'
import type { Seat } from '../../data/constants/seatOrder'
import { getValidCardsForSeat } from './getValidCardsForSeat'
import { getWinningTrickPlay } from './getWinningTrickPlay'

type ContractMode = 'suit' | 'no-trumps' | 'all-trumps'

type ContractInfo = {
  mode: ContractMode
  trumpSuit: Suit | null
  winningBidSeat: Seat | null
  bidderTeam: Team | null
  dangerSuit: Suit | null
  isOurTeamBid: boolean
  isDefendingAgainstAllTrumps: boolean
  isDefendingAgainstNoTrumps: boolean
}

type PartnerSeekPlan = {
  primarySuit: Suit | null
  secondarySuit: Suit | null
}

const TEAM_A = new Set<Seat>(['bottom', 'top'])
const TEAM_B = new Set<Seat>(['right', 'left'])

const NORMAL_ORDER: Rank[] = ['7', '8', '9', 'J', 'Q', 'K', '10', 'A']
const TRUMP_ORDER: Rank[] = ['7', '8', 'Q', 'K', '10', 'A', '9', 'J']

const NORMAL_POINTS: Record<Rank, number> = {
  '7': 0,
  '8': 0,
  '9': 0,
  J: 2,
  Q: 3,
  K: 4,
  '10': 10,
  A: 11,
}

const TRUMP_POINTS: Record<Rank, number> = {
  '7': 0,
  '8': 0,
  Q: 3,
  K: 4,
  '10': 10,
  A: 11,
  '9': 14,
  J: 20,
}

export function pickBotCardToPlay(state: GameState, seat: Seat): Card | null {
  const validCards = getValidCardsForSeat(state, seat)

  if (validCards.length === 0) {
    return null
  }

  if (validCards.length === 1) {
    return validCards[0] ?? null
  }

  const contractInfo = resolveContractInfo(state, seat)
  const trickPlays = getCurrentTrickPlays(state)
  const partnerSeekPlan = resolvePartnerSeekPlan(state, seat, contractInfo)

  let bestCard: Card | null = null
  let bestScore = Number.NEGATIVE_INFINITY

  for (const card of validCards) {
    const score = scoreCardChoice(
      state,
      seat,
      card,
      trickPlays,
      contractInfo,
      partnerSeekPlan,
    )

    if (score > bestScore) {
      bestScore = score
      bestCard = card
    }
  }

  return bestCard ?? validCards[0] ?? null
}

function scoreCardChoice(
  state: GameState,
  seat: Seat,
  card: Card,
  trickPlays: TrickPlay[],
  contractInfo: ContractInfo,
  partnerSeekPlan: PartnerSeekPlan,
): number {
  const suit = card.suit
  const leadSuit = trickPlays[0]?.card.suit ?? null
  const partnerSeat = getPartnerSeat(seat)
  const currentWinner = getWinningTrickPlay(trickPlays, buildWinningBid(contractInfo))
  const partnerCurrentlyWinning = currentWinner?.seat === partnerSeat
  const cardCost = getCardConservationCost(card, contractInfo, leadSuit)

  let score = 0

  score -= cardCost * getConservationPenaltyMultiplier(contractInfo)

  if (trickPlays.length === 0) {
    score += scoreLeadChoice(state, seat, card, contractInfo, partnerSeekPlan)
    return score
  }

  if (!leadSuit) {
    return score
  }

  const candidateWins = doesCandidateWinTrick(
    [...trickPlays, { seat, card }],
    seat,
    contractInfo,
  )

  if (partnerCurrentlyWinning) {
    if (candidateWins) {
      score -= 95
    } else {
      score += 70
      score -= cardCost * 0.2
    }

    if (
      (contractInfo.mode === 'suit' && contractInfo.trumpSuit === leadSuit && suit === leadSuit) ||
      (contractInfo.mode === 'all-trumps' && suit === leadSuit)
    ) {
      score -= getCardStrengthIndex(card, contractInfo, leadSuit) * 10
    }

    return score
  }

  const tablePoints = getCardsPointTotal(
    trickPlays.map((play) => play.card),
    contractInfo,
    leadSuit,
  )

  if (candidateWins) {
    score += 95
    score += tablePoints * 2.8
    score -= getCardStrengthIndex(card, contractInfo, leadSuit) * 8
    score -= getPointValue(card, contractInfo, leadSuit) * 1.8

    if (contractInfo.isDefendingAgainstAllTrumps) {
      score += getAllTrumpsDefenseBonus(card)
      score += getPointValue(card, contractInfo, leadSuit) * 1.8
    }

    if (contractInfo.isDefendingAgainstNoTrumps) {
      score += getNoTrumpsDefenseBonus(card)
    }
  } else {
    score -= 20
    score -= getPointValue(card, contractInfo, leadSuit) * 1.4

    if (contractInfo.isDefendingAgainstAllTrumps) {
      score -= getAllTrumpsDefenseBonus(card) * 0.45
    }
  }

  return score
}

function scoreLeadChoice(
  state: GameState,
  seat: Seat,
  card: Card,
  contractInfo: ContractInfo,
  partnerSeekPlan: PartnerSeekPlan,
): number {
  const suit = card.suit
  const rank = card.rank
  const pointValue = getPointValue(card, contractInfo, suit)
  const strengthIndex = getCardStrengthIndex(card, contractInfo, suit)
  const noTrumpsEntryPlan = getNoTrumpsEntryPlan(state, seat, card, contractInfo)
  const trumpDrawNow = shouldDrawTrumpNow(state, seat, contractInfo)

  let score = 0

  if (partnerSeekPlan.primarySuit && suit === partnerSeekPlan.primarySuit) {
    score += 150
  } else if (partnerSeekPlan.secondarySuit && suit === partnerSeekPlan.secondarySuit) {
    score += 80
  }

  if (contractInfo.dangerSuit && suit === contractInfo.dangerSuit) {
    score -= contractInfo.isDefendingAgainstAllTrumps ? 45 : 130
  }

  if (
    contractInfo.bidderTeam &&
    contractInfo.winningBidSeat &&
    contractInfo.isOurTeamBid &&
    contractInfo.mode === 'suit' &&
    contractInfo.trumpSuit === suit
  ) {
    score += 55
  }

  if (trumpDrawNow && contractInfo.trumpSuit) {
    if (suit === contractInfo.trumpSuit) {
      score += getTrumpDrawLeadBonus(card)
    } else {
      score -= 70
    }
  }

  if (contractInfo.isDefendingAgainstAllTrumps) {
    score += getAllTrumpsDefenseBonus(card)

    if (partnerSeekPlan.primarySuit && suit === partnerSeekPlan.primarySuit) {
      score += 18
    }

    score -= pointValue * 0.2
    score -= strengthIndex * 0.15

    if (rank === '7' || rank === '8') {
      score -= 18
    }

    score += getAllTrumpsJackPlanLeadBonus(state, seat, card, contractInfo)
    score += getReturnPartnerSuitAfterJackWinBonus(state, seat, card, contractInfo)

    return score
  }

  if (contractInfo.isDefendingAgainstNoTrumps) {
    score += getNoTrumpsDefenseBonus(card)
  }

  if (contractInfo.mode === 'no-trumps') {
    if (rank === 'A') score += 42
    if (rank === '10') score += 26
    if (rank === 'K') score += 8
    if (rank === 'Q') score += 5

    score += noTrumpsEntryPlan.cashNowBonus
    score -= noTrumpsEntryPlan.saveForLaterPenalty
    score += noTrumpsEntryPlan.partnerSeekAfterCashBonus
  }

  if (contractInfo.mode === 'all-trumps') {
    if (rank === 'J') score += 48
    if (rank === '9') score += 40
    if (rank === 'A') score += 16
    if (rank === '10') score += 14

    score += getAllTrumpsJackPlanLeadBonus(state, seat, card, contractInfo)
    score += getReturnPartnerSuitAfterJackWinBonus(state, seat, card, contractInfo)
  }

  if (contractInfo.mode === 'suit' && contractInfo.trumpSuit === suit) {
    if (rank === 'J') score += 44
    if (rank === '9') score += 36
    if (rank === 'A') score += 12
    if (rank === '10') score += 10
  }

  if (contractInfo.mode === 'suit' && contractInfo.trumpSuit !== suit) {
    if (rank === 'A') score += 28
    if (rank === '10') score += 18
  }

  if (contractInfo.mode === 'no-trumps') {
    score -= pointValue * 1.25
    score -= strengthIndex * 0.75
  } else {
    score -= pointValue * 0.8
    score -= strengthIndex * 0.35
  }

  return score
}

function resolveContractInfo(state: GameState, seat: Seat): ContractInfo {
  const winningBid = state.bidding.winningBid
  const mode: ContractMode = winningBid?.contract ?? 'no-trumps'
  const trumpSuit = winningBid?.trumpSuit ?? null
  const winningBidSeat = winningBid?.seat ?? null
  const bidderTeam = winningBidSeat ? getTeamBySeat(winningBidSeat) : null
  const isOurTeamBid = !!winningBidSeat && isSameTeam(seat, winningBidSeat)

  return {
    mode,
    trumpSuit,
    winningBidSeat,
    bidderTeam,
    dangerSuit: resolveDangerSuit(state, seat, mode, winningBidSeat),
    isOurTeamBid,
    isDefendingAgainstAllTrumps:
      mode === 'all-trumps' && !!winningBidSeat && !isSameTeam(seat, winningBidSeat),
    isDefendingAgainstNoTrumps:
      mode === 'no-trumps' && !!winningBidSeat && !isSameTeam(seat, winningBidSeat),
  }
}

function resolveDangerSuit(
  state: GameState,
  seat: Seat,
  mode: ContractMode,
  winningBidSeat: Seat | null,
): Suit | null {
  if (mode !== 'all-trumps' || !winningBidSeat || !isSameTeam(seat, winningBidSeat)) {
    return null
  }

  let lastOpponentSuit: Suit | null = null

  for (const entry of state.bidding.entries) {
    if (isSameTeam(entry.seat, winningBidSeat)) {
      continue
    }

    if (entry.action.type === 'suit') {
      lastOpponentSuit = entry.action.suit
    }
  }

  return lastOpponentSuit
}

function resolvePartnerSeekPlan(
  state: GameState,
  seat: Seat,
  contractInfo: ContractInfo,
): PartnerSeekPlan {
  const runPlan = resolveLongRunSeekPlan(state, seat, contractInfo)

  if (runPlan) {
    return runPlan
  }

  const lastDiscardSuit = getLatestPartnerDiscardSuit(state, seat, contractInfo)

  if (!lastDiscardSuit) {
    return {
      primarySuit: null,
      secondarySuit: null,
    }
  }

  return {
    primarySuit: getSisterSuit(lastDiscardSuit),
    secondarySuit: lastDiscardSuit,
  }
}

function resolveLongRunSeekPlan(
  state: GameState,
  seat: Seat,
  contractInfo: ContractInfo,
): PartnerSeekPlan | null {
  const partnerSeat = getPartnerSeat(seat)
  const completedTricks = getCompletedTricks(state)

  if (completedTricks.length < 2) {
    return null
  }

  const latestTrick = completedTricks[completedTricks.length - 1]

  if (!latestTrick || latestTrick.winnerSeat !== partnerSeat || latestTrick.leaderSeat !== partnerSeat) {
    return null
  }

  const runSuit = latestTrick.plays[0]?.card.suit ?? null

  if (!runSuit) {
    return null
  }

  const runTricks: CompletedTrick[] = []

  for (let index = completedTricks.length - 1; index >= 0; index -= 1) {
    const trick = completedTricks[index]
    const trickLeadSuit = trick.plays[0]?.card.suit ?? null

    if (
      trick.winnerSeat !== partnerSeat ||
      trick.leaderSeat !== partnerSeat ||
      trickLeadSuit !== runSuit
    ) {
      break
    }

    runTricks.unshift(trick)
  }

  if (runTricks.length < 2) {
    return null
  }

  const discardHistory: Suit[] = []

  for (const trick of runTricks) {
    const discardSuit = getDiscardSignalSuitFromTrick(trick.plays, seat, contractInfo)

    if (discardSuit) {
      discardHistory.push(discardSuit)
    }
  }

  if (discardHistory.length === 0) {
    return {
      primarySuit: getSisterSuit(runSuit),
      secondarySuit: null,
    }
  }

  const primarySuit = discardHistory[discardHistory.length - 1] ?? null
  const secondarySuit = getPreviousDifferentDiscardSuit(discardHistory, primarySuit)

  return {
    primarySuit,
    secondarySuit,
  }
}

function getLatestPartnerDiscardSuit(
  state: GameState,
  seat: Seat,
  contractInfo: ContractInfo,
): Suit | null {
  const partnerSeat = getPartnerSeat(seat)
  const completedTricks = getCompletedTricks(state)

  for (let index = completedTricks.length - 1; index >= 0; index -= 1) {
    const discardSuit = getDiscardSignalSuitFromTrick(
      completedTricks[index].plays,
      partnerSeat,
      contractInfo,
    )

    if (discardSuit) {
      return discardSuit
    }
  }

  return getDiscardSignalSuitFromTrick(getCurrentTrickPlays(state), partnerSeat, contractInfo)
}

function getDiscardSignalSuitFromTrick(
  plays: TrickPlay[],
  seat: Seat,
  contractInfo: ContractInfo,
): Suit | null {
  if (plays.length === 0) {
    return null
  }

  const leadSuit = plays[0]?.card.suit ?? null

  if (!leadSuit) {
    return null
  }

  const play = plays.find((entry) => entry.seat === seat)

  if (!play) {
    return null
  }

  if (play.card.suit === leadSuit) {
    return null
  }

  if (
    contractInfo.mode === 'suit' &&
    contractInfo.trumpSuit &&
    leadSuit !== contractInfo.trumpSuit &&
    play.card.suit === contractInfo.trumpSuit
  ) {
    return null
  }

  return play.card.suit
}

function getPreviousDifferentDiscardSuit(history: Suit[], primarySuit: Suit | null): Suit | null {
  if (!primarySuit) {
    return null
  }

  for (let index = history.length - 2; index >= 0; index -= 1) {
    if (history[index] !== primarySuit) {
      return history[index]
    }
  }

  return null
}

function getNoTrumpsEntryPlan(
  state: GameState,
  seat: Seat,
  card: Card,
  contractInfo: ContractInfo,
): {
  cashNowBonus: number
  saveForLaterPenalty: number
  partnerSeekAfterCashBonus: number
} {
  if (contractInfo.mode !== 'no-trumps') {
    return {
      cashNowBonus: 0,
      saveForLaterPenalty: 0,
      partnerSeekAfterCashBonus: 0,
    }
  }

  if (!isLikelyTopRemainingCardInSuit(state, seat, card, contractInfo)) {
    return {
      cashNowBonus: 0,
      saveForLaterPenalty: 0,
      partnerSeekAfterCashBonus: 0,
    }
  }

  const hand = getSeatHand(state, seat)
  const sameSuitCards = hand.filter((handCard) => handCard.suit === card.suit)
  const hasOtherLikelyEntry = hasAnotherLikelyNoTrumpsEntry(state, seat, card, contractInfo)

  if (sameSuitCards.length === 1 && !hasOtherLikelyEntry) {
    return {
      cashNowBonus: 88,
      saveForLaterPenalty: 0,
      partnerSeekAfterCashBonus: 16,
    }
  }

  if (sameSuitCards.length === 1 && hasOtherLikelyEntry) {
    return {
      cashNowBonus: 22,
      saveForLaterPenalty: 20,
      partnerSeekAfterCashBonus: 0,
    }
  }

  if (sameSuitCards.length > 1 && !hasOtherLikelyEntry) {
    return {
      cashNowBonus: 28,
      saveForLaterPenalty: 0,
      partnerSeekAfterCashBonus: 8,
    }
  }

  return {
    cashNowBonus: 8,
    saveForLaterPenalty: 18,
    partnerSeekAfterCashBonus: 0,
  }
}

function hasAnotherLikelyNoTrumpsEntry(
  state: GameState,
  seat: Seat,
  excludedCard: Card,
  contractInfo: ContractInfo,
): boolean {
  const hand = getSeatHand(state, seat)

  for (const card of hand) {
    if (card === excludedCard) {
      continue
    }

    if (
      isLikelyTopRemainingCardInSuit(state, seat, card, contractInfo) &&
      getPointValue(card, contractInfo, card.suit) >= 10
    ) {
      return true
    }
  }

  return false
}

function isLikelyTopRemainingCardInSuit(
  state: GameState,
  seat: Seat,
  card: Card,
  contractInfo: ContractInfo,
): boolean {
  if (contractInfo.mode !== 'no-trumps') {
    return false
  }

  const playedCards = getPlayedCards(state)
  const hand = getSeatHand(state, seat)
  const higherRanks = NORMAL_ORDER.slice(getNormalOrderIndex(card) + 1)

  for (const rank of higherRanks) {
    const higherCardAlreadyPlayed = playedCards.some(
      (playedCard) => playedCard.suit === card.suit && playedCard.rank === rank,
    )

    if (higherCardAlreadyPlayed) {
      continue
    }

    const higherCardInOwnHand = hand.some(
      (handCard) => handCard.suit === card.suit && handCard.rank === rank,
    )

    if (higherCardInOwnHand) {
      continue
    }

    return false
  }

  return true
}

function shouldDrawTrumpNow(
  state: GameState,
  seat: Seat,
  contractInfo: ContractInfo,
): boolean {
  if (
    contractInfo.mode !== 'suit' ||
    !contractInfo.isOurTeamBid ||
    !contractInfo.trumpSuit
  ) {
    return false
  }

  const hand = getSeatHand(state, seat)
  const ownTrumpCards = hand.filter((card) => card.suit === contractInfo.trumpSuit)

  if (ownTrumpCards.length === 0) {
    return false
  }

  const playedTrumpCount = getPlayedCards(state).filter(
    (card) => card.suit === contractInfo.trumpSuit,
  ).length

  const unseenTrumpOutsideHand = 8 - playedTrumpCount - ownTrumpCards.length

  return unseenTrumpOutsideHand > 0
}

function getTrumpDrawLeadBonus(card: Card): number {
  switch (card.rank) {
    case 'J':
      return 210
    case '9':
      return 188
    case 'A':
      return 160
    case '10':
      return 138
    case 'K':
      return 112
    case 'Q':
      return 104
    case '8':
      return 74
    case '7':
      return 70
  }
}

function getAllTrumpsJackPlanLeadBonus(
  state: GameState,
  seat: Seat,
  card: Card,
  contractInfo: ContractInfo,
): number {
  if (contractInfo.mode !== 'all-trumps') {
    return 0
  }

  const hand = getSeatHand(state, seat)
  const suitCards = hand.filter((handCard) => handCard.suit === card.suit)
  const hasJack = suitCards.some((suitCard) => suitCard.rank === 'J')
  const hasNine = suitCards.some((suitCard) => suitCard.rank === '9')
  const hasAce = suitCards.some((suitCard) => suitCard.rank === 'A')

  if (hasJack) {
    return 0
  }

  if (hasAce && hasNine) {
    if (card.rank === 'A') {
      let bonus = 118

      if (contractInfo.isOurTeamBid) {
        bonus += 22
      }

      if (suitCards.some((suitCard) => suitCard.rank === 'Q' || suitCard.rank === 'K' || suitCard.rank === '10')) {
        bonus += 10
      }

      return bonus
    }

    if (card.rank === '9') {
      return -88
    }
  }

  if (!hasAce && hasNine) {
    if (!contractInfo.isOurTeamBid) {
      if (card.rank === '9' || card.rank === 'Q' || card.rank === 'K' || card.rank === '10') {
        return -72
      }
    }

    if (card.rank === '9') {
      return -36
    }
  }

  return 0
}

function getReturnPartnerSuitAfterJackWinBonus(
  state: GameState,
  seat: Seat,
  card: Card,
  contractInfo: ContractInfo,
): number {
  if (contractInfo.mode !== 'all-trumps') {
    return 0
  }

  const completedTricks = getCompletedTricks(state)
  const lastTrick = completedTricks[completedTricks.length - 1]

  if (!lastTrick || lastTrick.winnerSeat !== seat) {
    return 0
  }

  const partnerSeat = getPartnerSeat(seat)
  const leadSuit = lastTrick.plays[0]?.card.suit ?? null
  const winningPlay = getWinningTrickPlay(lastTrick.plays, buildWinningBid(contractInfo))

  if (
    !leadSuit ||
    lastTrick.leaderSeat !== partnerSeat ||
    !winningPlay ||
    winningPlay.seat !== seat ||
    winningPlay.card.rank !== 'J' ||
    winningPlay.card.suit !== leadSuit
  ) {
    return 0
  }

  return card.suit === leadSuit ? 126 : 0
}

function getPlayedCards(state: GameState): Card[] {
  const playedCards: Card[] = []

  for (const trick of getCompletedTricks(state)) {
    for (const play of trick.plays) {
      playedCards.push(play.card)
    }
  }

  for (const play of getCurrentTrickPlays(state)) {
    playedCards.push(play.card)
  }

  return playedCards
}

function getSeatHand(state: GameState, seat: Seat): Card[] {
  return state.hands[seat] ?? []
}

function getCurrentTrickPlays(state: GameState): TrickPlay[] {
  return state.playing?.currentTrick.plays ?? []
}

function getCompletedTricks(state: GameState): CompletedTrick[] {
  return state.playing?.completedTricks ?? []
}

function doesCandidateWinTrick(
  playsAfterCandidate: TrickPlay[],
  seat: Seat,
  contractInfo: ContractInfo,
): boolean {
  const winningPlay = getWinningTrickPlay(playsAfterCandidate, buildWinningBid(contractInfo))
  return winningPlay?.seat === seat
}

function buildWinningBid(contractInfo: ContractInfo): WinningBid {
  if (!contractInfo.winningBidSeat) {
    return null
  }

  return {
    seat: contractInfo.winningBidSeat,
    contract: contractInfo.mode,
    trumpSuit: contractInfo.trumpSuit,
    doubled: false,
    redoubled: false,
  }
}

function getConservationPenaltyMultiplier(contractInfo: ContractInfo): number {
  if (contractInfo.isDefendingAgainstAllTrumps) {
    return 0.08
  }

  if (contractInfo.mode === 'no-trumps') {
    return 0.4
  }

  if (contractInfo.mode === 'all-trumps') {
    return 0.16
  }

  return 0.24
}

function getAllTrumpsDefenseBonus(card: Card): number {
  switch (card.rank) {
    case 'J':
      return 96
    case '9':
      return 82
    case 'A':
      return 34
    case '10':
      return 30
    case 'K':
      return 12
    case 'Q':
      return 10
    default:
      return 0
  }
}

function getNoTrumpsDefenseBonus(card: Card): number {
  switch (card.rank) {
    case 'A':
      return 34
    case '10':
      return 22
    case 'K':
      return 8
    case 'Q':
      return 6
    default:
      return 0
  }
}

function getCardConservationCost(
  card: Card,
  contractInfo: ContractInfo,
  leadSuit: Suit | null,
): number {
  const points = getPointValue(card, contractInfo, leadSuit)
  const strength = getCardStrengthIndex(card, contractInfo, leadSuit)

  return points * 10 + strength
}

function getCardStrengthIndex(
  card: Card,
  contractInfo: ContractInfo,
  leadSuit: Suit | null,
): number {
  if (contractInfo.mode === 'all-trumps') {
    return getTrumpOrderIndex(card)
  }

  if (contractInfo.mode === 'suit' && contractInfo.trumpSuit === card.suit) {
    return getTrumpOrderIndex(card)
  }

  if (leadSuit && card.suit === leadSuit) {
    return getNormalOrderIndex(card)
  }

  return getNormalOrderIndex(card)
}

function getPointValue(
  card: Card,
  contractInfo: ContractInfo,
  leadSuit: Suit | null,
): number {
  if (contractInfo.mode === 'all-trumps') {
    return TRUMP_POINTS[card.rank]
  }

  if (contractInfo.mode === 'suit' && contractInfo.trumpSuit === card.suit) {
    return TRUMP_POINTS[card.rank]
  }

  if (leadSuit && card.suit === leadSuit) {
    return NORMAL_POINTS[card.rank]
  }

  return NORMAL_POINTS[card.rank]
}

function getCardsPointTotal(
  cards: Card[],
  contractInfo: ContractInfo,
  leadSuit: Suit | null,
): number {
  return cards.reduce((total, candidate) => total + getPointValue(candidate, contractInfo, leadSuit), 0)
}

function getNormalOrderIndex(card: Card): number {
  return NORMAL_ORDER.indexOf(card.rank)
}

function getTrumpOrderIndex(card: Card): number {
  return TRUMP_ORDER.indexOf(card.rank)
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

function getTeamBySeat(seat: Seat): Team {
  return TEAM_A.has(seat) ? 'A' : 'B'
}

function isSameTeam(firstSeat: Seat, secondSeat: Seat): boolean {
  return (TEAM_A.has(firstSeat) && TEAM_A.has(secondSeat)) ||
    (TEAM_B.has(firstSeat) && TEAM_B.has(secondSeat))
}

function getSisterSuit(suit: Suit): Suit {
  switch (suit) {
    case 'clubs':
      return 'spades'
    case 'spades':
      return 'clubs'
    case 'diamonds':
      return 'hearts'
    case 'hearts':
      return 'diamonds'
  }
}