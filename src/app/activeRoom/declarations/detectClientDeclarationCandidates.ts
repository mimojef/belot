import type { RoomCardSnapshot } from '../../network/createGameServerClient'
import type {
  ClientDeclarationCandidate,
  ClientDeclarationDetectionContract,
  ClientDeclarationPublicLabel,
} from './declarationPromptTypes'

const SUITS: RoomCardSnapshot['suit'][] = ['clubs', 'diamonds', 'hearts', 'spades']
const RANK_ORDER: RoomCardSnapshot['rank'][] = ['7', '8', '9', '10', 'J', 'Q', 'K', 'A']

function getRankIndex(rank: RoomCardSnapshot['rank']): number {
  return RANK_ORDER.indexOf(rank)
}

function sortCardsByRank(cards: RoomCardSnapshot[]): RoomCardSnapshot[] {
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

function getSequenceLabel(length: number): ClientDeclarationPublicLabel {
  if (length === 3) return 'Терца'
  if (length === 4) return '50'

  return '100'
}

function getSquarePoints(rank: RoomCardSnapshot['rank']): number | null {
  if (rank === 'J') return 200
  if (rank === '9') return 150
  if (rank === '10' || rank === 'A' || rank === 'K' || rank === 'Q') return 100

  return null
}

function createCandidate(params: {
  type: ClientDeclarationCandidate['type']
  publicLabel: ClientDeclarationPublicLabel
  points: number
  cards: RoomCardSnapshot[]
  suit: RoomCardSnapshot['suit'] | null
  highRank: RoomCardSnapshot['rank'] | null
  rank: RoomCardSnapshot['rank'] | null
  sequenceLength: number | null
}): ClientDeclarationCandidate {
  const cards = sortCardsByRank(params.cards)
  const cardIds = cards.map((card) => card.id)
  const key = [
    params.type,
    params.publicLabel,
    String(params.points),
    params.suit ?? 'none',
    params.highRank ?? 'none',
    params.rank ?? 'none',
    String(params.sequenceLength ?? 0),
    cardIds.join(','),
  ].join(':')

  return {
    key,
    type: params.type,
    publicLabel: params.publicLabel,
    points: params.points,
    cardIds,
    privateMetadata: {
      suit: params.suit,
      highRank: params.highRank,
      rank: params.rank,
      sequenceLength: params.sequenceLength,
    },
  }
}

function findSequenceCandidates(hand: RoomCardSnapshot[]): ClientDeclarationCandidate[] {
  const candidates: ClientDeclarationCandidate[] = []

  for (const suit of SUITS) {
    const suitCards = sortCardsByRank(hand.filter((card) => card.suit === suit))
    let currentRun: RoomCardSnapshot[] = []

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

function findSquareCandidates(hand: RoomCardSnapshot[]): ClientDeclarationCandidate[] {
  const candidates: ClientDeclarationCandidate[] = []

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
  contract: ClientDeclarationDetectionContract,
): RoomCardSnapshot['suit'][] {
  if (contract === null || contract.contract === 'no-trumps') {
    return []
  }

  if (contract.contract === 'suit') {
    return contract.trumpSuit ? [contract.trumpSuit] : []
  }

  return [...SUITS]
}

function findBeloteCandidates(
  hand: RoomCardSnapshot[],
  contract: ClientDeclarationDetectionContract,
): ClientDeclarationCandidate[] {
  const candidates: ClientDeclarationCandidate[] = []

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

export function detectClientDeclarationCandidates(
  hand: RoomCardSnapshot[],
  contract: ClientDeclarationDetectionContract,
): ClientDeclarationCandidate[] {
  if (contract === null || contract.contract === 'no-trumps') {
    return []
  }

  return [
    ...findSequenceCandidates(hand),
    ...findSquareCandidates(hand),
    ...findBeloteCandidates(hand, contract),
  ]
}
