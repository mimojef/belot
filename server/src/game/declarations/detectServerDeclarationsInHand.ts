import type {
  ServerCard,
  ServerRank,
  ServerSuit,
} from '../serverGameTypes.js'
import type {
  ServerDeclarationCandidate,
  ServerDeclarationDetectionContract,
  ServerDeclarationPublicLabel,
} from './serverDeclarationTypes.js'

const SUITS: ServerSuit[] = ['clubs', 'diamonds', 'hearts', 'spades']
const RANK_ORDER: ServerRank[] = ['7', '8', '9', '10', 'J', 'Q', 'K', 'A']

function getRankIndex(rank: ServerRank): number {
  return RANK_ORDER.indexOf(rank)
}

function sortCardsByRank(cards: ServerCard[]): ServerCard[] {
  return [...cards].sort((left, right) => {
    const rankDelta = getRankIndex(left.rank) - getRankIndex(right.rank)

    if (rankDelta !== 0) {
      return rankDelta
    }

    return SUITS.indexOf(left.suit) - SUITS.indexOf(right.suit)
  })
}

function getSequencePoints(length: number): number | null {
  if (length === 3) return 20
  if (length === 4) return 50
  if (length >= 5) return 100

  return null
}

function getSequenceLabel(length: number): ServerDeclarationPublicLabel {
  if (length === 3) return 'Терца'
  if (length === 4) return '50'

  return '100'
}

function getSquarePoints(rank: ServerRank): number | null {
  if (rank === 'J') return 200
  if (rank === '9') return 150
  if (rank === '10' || rank === 'A' || rank === 'K' || rank === 'Q') return 100

  return null
}

function createCandidate(params: {
  type: ServerDeclarationCandidate['type']
  publicLabel: ServerDeclarationPublicLabel
  points: number
  cards: ServerCard[]
  suit: ServerSuit | null
  highRank: ServerRank | null
  rank: ServerRank | null
  sequenceLength: number | null
}): ServerDeclarationCandidate {
  const cards = sortCardsByRank(params.cards)
  const cardIds = cards.map((card) => card.id)
  const keyParts = [
    params.type,
    params.publicLabel,
    String(params.points),
    params.suit ?? 'none',
    params.highRank ?? 'none',
    params.rank ?? 'none',
    String(params.sequenceLength ?? 0),
    cardIds.join(','),
  ]
  const key = keyParts.join(':')

  return {
    id: key,
    key,
    type: params.type,
    comparisonGroup: params.type,
    publicLabel: params.publicLabel,
    points: params.points,
    cardIds,
    privateMetadata: {
      suit: params.suit,
      highRank: params.highRank,
      rank: params.rank,
      sequenceLength: params.sequenceLength,
      cards,
    },
  }
}

function findSequenceCandidates(hand: ServerCard[]): ServerDeclarationCandidate[] {
  const candidates: ServerDeclarationCandidate[] = []

  for (const suit of SUITS) {
    const suitCards = sortCardsByRank(hand.filter((card) => card.suit === suit))
    let currentRun: ServerCard[] = []

    function flushRun(): void {
      const points = getSequencePoints(currentRun.length)

      if (points !== null) {
        const highCard = currentRun[currentRun.length - 1] ?? null
        candidates.push(
          createCandidate({
            type: 'sequence',
            publicLabel: getSequenceLabel(currentRun.length),
            points,
            cards: currentRun,
            suit,
            highRank: highCard?.rank ?? null,
            rank: null,
            sequenceLength: currentRun.length,
          }),
        )
      }

      currentRun = []
    }

    for (const card of suitCards) {
      const previousCard = currentRun[currentRun.length - 1]

      if (!previousCard) {
        currentRun = [card]
        continue
      }

      if (getRankIndex(card.rank) === getRankIndex(previousCard.rank) + 1) {
        currentRun.push(card)
        continue
      }

      flushRun()
      currentRun = [card]
    }

    flushRun()
  }

  return candidates
}

function findSquareCandidates(hand: ServerCard[]): ServerDeclarationCandidate[] {
  const candidates: ServerDeclarationCandidate[] = []

  for (const rank of RANK_ORDER) {
    const cards = hand.filter((card) => card.rank === rank)
    const points = getSquarePoints(rank)

    if (cards.length !== 4 || points === null) {
      continue
    }

    candidates.push(
      createCandidate({
        type: 'square',
        publicLabel: 'Каре',
        points,
        cards,
        suit: null,
        highRank: rank,
        rank,
        sequenceLength: null,
      }),
    )
  }

  return candidates
}

function getBeloteEligibleSuits(
  contract: ServerDeclarationDetectionContract,
): ServerSuit[] {
  if (contract === null || contract.contract === 'no-trumps') {
    return []
  }

  if (contract.contract === 'suit') {
    return contract.trumpSuit ? [contract.trumpSuit] : []
  }

  return [...SUITS]
}

function findBeloteCandidates(
  hand: ServerCard[],
  contract: ServerDeclarationDetectionContract,
): ServerDeclarationCandidate[] {
  const candidates: ServerDeclarationCandidate[] = []

  for (const suit of getBeloteEligibleSuits(contract)) {
    const queen = hand.find((card) => card.suit === suit && card.rank === 'Q')
    const king = hand.find((card) => card.suit === suit && card.rank === 'K')

    if (!queen || !king) {
      continue
    }

    candidates.push(
      createCandidate({
        type: 'belote',
        publicLabel: 'Белот',
        points: 20,
        cards: [queen, king],
        suit,
        highRank: 'K',
        rank: null,
        sequenceLength: null,
      }),
    )
  }

  return candidates
}

export function detectServerDeclarationsInHand(
  hand: ServerCard[],
  contract: ServerDeclarationDetectionContract,
): ServerDeclarationCandidate[] {
  if (contract === null || contract.contract === 'no-trumps') {
    return []
  }

  return [
    ...findSequenceCandidates(hand),
    ...findSquareCandidates(hand),
    ...findBeloteCandidates(hand, contract),
  ]
}
