import type {
  Card,
  Declaration,
  Rank,
  Suit,
  WinningBid,
} from '../state/gameTypes'

const SUITS: Suit[] = ['clubs', 'diamonds', 'hearts', 'spades']
const RANK_ORDER: Rank[] = ['7', '8', '9', '10', 'J', 'Q', 'K', 'A']

type DetectDeclarationsInHandInput = {
  seat: Declaration['seat']
  team: Declaration['team']
  hand: Card[]
  winningBid: WinningBid
  announced?: boolean
}

function buildEmptySuitMap(): Record<Suit, Card[]> {
  return {
    clubs: [],
    diamonds: [],
    hearts: [],
    spades: [],
  }
}

function buildEmptyRankMap(): Record<Rank, Card[]> {
  return {
    '7': [],
    '8': [],
    '9': [],
    '10': [],
    J: [],
    Q: [],
    K: [],
    A: [],
  }
}

function getRankIndex(rank: Rank): number {
  return RANK_ORDER.indexOf(rank)
}

function sortCardsByRankAscending(cards: Card[]): Card[] {
  return [...cards].sort((left, right) => getRankIndex(left.rank) - getRankIndex(right.rank))
}

function getSequencePoints(length: number): number | null {
  if (length === 3) {
    return 20
  }

  if (length === 4) {
    return 50
  }

  if (length >= 5) {
    return 100
  }

  return null
}

function getSquarePoints(rank: Rank): number | null {
  if (rank === 'J') {
    return 200
  }

  if (rank === '9') {
    return 150
  }

  if (rank === '10' || rank === 'A' || rank === 'K' || rank === 'Q') {
    return 100
  }

  return null
}

function getBeloteEligibleSuits(winningBid: WinningBid): Suit[] {
  if (!winningBid) {
    return []
  }

  if (winningBid.contract === 'no-trumps') {
    return []
  }

  if (winningBid.contract === 'suit') {
    return winningBid.trumpSuit ? [winningBid.trumpSuit] : []
  }

  if (winningBid.contract === 'all-trumps') {
    return [...SUITS]
  }

  return []
}

function groupCardsBySuit(hand: Card[]): Record<Suit, Card[]> {
  const suitMap = buildEmptySuitMap()

  for (const card of hand) {
    suitMap[card.suit].push(card)
  }

  for (const suit of SUITS) {
    suitMap[suit] = sortCardsByRankAscending(suitMap[suit])
  }

  return suitMap
}

function groupCardsByRank(hand: Card[]): Record<Rank, Card[]> {
  const rankMap = buildEmptyRankMap()

  for (const card of hand) {
    rankMap[card.rank].push(card)
  }

  return rankMap
}

function buildSequenceDeclaration(params: {
  seat: Declaration['seat']
  team: Declaration['team']
  suit: Suit
  cards: Card[]
  announced: boolean
}): Declaration {
  const sortedCards = sortCardsByRankAscending(params.cards)
  const highCard = sortedCards[sortedCards.length - 1]

  return {
    seat: params.seat,
    team: params.team,
    type: 'sequence',
    points: getSequencePoints(sortedCards.length) ?? 0,
    cards: sortedCards,
    suit: params.suit,
    highRank: highCard?.rank ?? null,
    announced: params.announced,
    valid: false,
  }
}

function buildSquareDeclaration(params: {
  seat: Declaration['seat']
  team: Declaration['team']
  cards: Card[]
  announced: boolean
}): Declaration {
  const sortedCards = sortCardsByRankAscending(params.cards)
  const rank = sortedCards[0]?.rank ?? null

  return {
    seat: params.seat,
    team: params.team,
    type: 'square',
    points: rank ? getSquarePoints(rank) ?? 0 : 0,
    cards: sortedCards,
    suit: null,
    highRank: rank,
    announced: params.announced,
    valid: false,
  }
}

function buildBeloteDeclaration(params: {
  seat: Declaration['seat']
  team: Declaration['team']
  suit: Suit
  cards: Card[]
  announced: boolean
}): Declaration {
  const sortedCards = sortCardsByRankAscending(params.cards)

  return {
    seat: params.seat,
    team: params.team,
    type: 'belote',
    points: 20,
    cards: sortedCards,
    suit: params.suit,
    highRank: 'K',
    announced: params.announced,
    valid: false,
  }
}

function findSequenceDeclarations(params: {
  seat: Declaration['seat']
  team: Declaration['team']
  hand: Card[]
  announced: boolean
}): Declaration[] {
  const suitMap = groupCardsBySuit(params.hand)
  const declarations: Declaration[] = []

  for (const suit of SUITS) {
    const cards = suitMap[suit]

    if (cards.length < 3) {
      continue
    }

    let currentRun: Card[] = []

    for (let index = 0; index < cards.length; index += 1) {
      const currentCard = cards[index]
      const previousCard = cards[index - 1]

      if (!previousCard) {
        currentRun = [currentCard]
        continue
      }

      const previousRankIndex = getRankIndex(previousCard.rank)
      const currentRankIndex = getRankIndex(currentCard.rank)

      if (currentRankIndex === previousRankIndex + 1) {
        currentRun.push(currentCard)
      } else {
        if (currentRun.length >= 3) {
          declarations.push(
            buildSequenceDeclaration({
              seat: params.seat,
              team: params.team,
              suit,
              cards: currentRun,
              announced: params.announced,
            })
          )
        }

        currentRun = [currentCard]
      }
    }

    if (currentRun.length >= 3) {
      declarations.push(
        buildSequenceDeclaration({
          seat: params.seat,
          team: params.team,
          suit,
          cards: currentRun,
          announced: params.announced,
        })
      )
    }
  }

  return declarations
}

function findSquareDeclarations(params: {
  seat: Declaration['seat']
  team: Declaration['team']
  hand: Card[]
  announced: boolean
}): Declaration[] {
  const rankMap = groupCardsByRank(params.hand)
  const declarations: Declaration[] = []

  for (const rank of RANK_ORDER) {
    const cards = rankMap[rank]
    const points = getSquarePoints(rank)

    if (cards.length !== 4 || !points) {
      continue
    }

    declarations.push(
      buildSquareDeclaration({
        seat: params.seat,
        team: params.team,
        cards,
        announced: params.announced,
      })
    )
  }

  return declarations
}

function findBeloteDeclarations(params: {
  seat: Declaration['seat']
  team: Declaration['team']
  hand: Card[]
  winningBid: WinningBid
  announced: boolean
}): Declaration[] {
  const declarations: Declaration[] = []
  const beloteSuits = getBeloteEligibleSuits(params.winningBid)

  for (const suit of beloteSuits) {
    const queen = params.hand.find((card) => card.suit === suit && card.rank === 'Q')
    const king = params.hand.find((card) => card.suit === suit && card.rank === 'K')

    if (!queen || !king) {
      continue
    }

    declarations.push(
      buildBeloteDeclaration({
        seat: params.seat,
        team: params.team,
        suit,
        cards: [queen, king],
        announced: params.announced,
      })
    )
  }

  return declarations
}

export function detectDeclarationsInHand(
  input: DetectDeclarationsInHandInput
): Declaration[] {
  const announced = input.announced ?? false

  return [
    ...findSequenceDeclarations({
      seat: input.seat,
      team: input.team,
      hand: input.hand,
      announced,
    }),
    ...findSquareDeclarations({
      seat: input.seat,
      team: input.team,
      hand: input.hand,
      announced,
    }),
    ...findBeloteDeclarations({
      seat: input.seat,
      team: input.team,
      hand: input.hand,
      winningBid: input.winningBid,
      announced,
    }),
  ]
}