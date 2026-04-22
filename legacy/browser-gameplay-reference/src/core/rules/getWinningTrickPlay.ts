import type {
  Rank,
  Suit,
  TrickPlay,
  WinningBid,
} from '../state/gameTypes'

const NO_TRUMPS_RANK_POWER: Record<Rank, number> = {
  '7': 0,
  '8': 1,
  '9': 2,
  J: 3,
  Q: 4,
  K: 5,
  '10': 6,
  A: 7,
}

const TRUMP_RANK_POWER: Record<Rank, number> = {
  '7': 0,
  '8': 1,
  Q: 2,
  K: 3,
  '10': 4,
  A: 5,
  '9': 6,
  J: 7,
}

function getLeadSuit(plays: TrickPlay[]): Suit | null {
  if (plays.length === 0) {
    return null
  }

  return plays[0]?.card.suit ?? null
}

function isTrumpCard(cardSuit: Suit, winningBid: WinningBid): boolean {
  return winningBid?.contract === 'suit' && winningBid.trumpSuit === cardSuit
}

function getPlainSuitPower(rank: Rank): number {
  return NO_TRUMPS_RANK_POWER[rank]
}

function getTrumpSuitPower(rank: Rank): number {
  return TRUMP_RANK_POWER[rank]
}

function isChallengerWinningInSuitContract(
  currentWinner: TrickPlay,
  challenger: TrickPlay,
  leadSuit: Suit,
  winningBid: WinningBid
): boolean {
  const currentIsTrump = isTrumpCard(currentWinner.card.suit, winningBid)
  const challengerIsTrump = isTrumpCard(challenger.card.suit, winningBid)

  if (challengerIsTrump && !currentIsTrump) {
    return true
  }

  if (!challengerIsTrump && currentIsTrump) {
    return false
  }

  if (challengerIsTrump && currentIsTrump) {
    return getTrumpSuitPower(challenger.card.rank) > getTrumpSuitPower(currentWinner.card.rank)
  }

  const currentFollowsLead = currentWinner.card.suit === leadSuit
  const challengerFollowsLead = challenger.card.suit === leadSuit

  if (challengerFollowsLead && !currentFollowsLead) {
    return true
  }

  if (!challengerFollowsLead && currentFollowsLead) {
    return false
  }

  if (challengerFollowsLead && currentFollowsLead) {
    return getPlainSuitPower(challenger.card.rank) > getPlainSuitPower(currentWinner.card.rank)
  }

  return false
}

function isChallengerWinningInNoTrumpsContract(
  currentWinner: TrickPlay,
  challenger: TrickPlay,
  leadSuit: Suit
): boolean {
  const currentFollowsLead = currentWinner.card.suit === leadSuit
  const challengerFollowsLead = challenger.card.suit === leadSuit

  if (challengerFollowsLead && !currentFollowsLead) {
    return true
  }

  if (!challengerFollowsLead && currentFollowsLead) {
    return false
  }

  if (challengerFollowsLead && currentFollowsLead) {
    return getPlainSuitPower(challenger.card.rank) > getPlainSuitPower(currentWinner.card.rank)
  }

  return false
}

function isChallengerWinningInAllTrumpsContract(
  currentWinner: TrickPlay,
  challenger: TrickPlay,
  leadSuit: Suit
): boolean {
  const currentFollowsLead = currentWinner.card.suit === leadSuit
  const challengerFollowsLead = challenger.card.suit === leadSuit

  if (challengerFollowsLead && !currentFollowsLead) {
    return true
  }

  if (!challengerFollowsLead && currentFollowsLead) {
    return false
  }

  if (challengerFollowsLead && currentFollowsLead) {
    return getTrumpSuitPower(challenger.card.rank) > getTrumpSuitPower(currentWinner.card.rank)
  }

  return false
}

export function getWinningTrickPlay(
  plays: TrickPlay[],
  winningBid: WinningBid
): TrickPlay | null {
  if (plays.length === 0) {
    return null
  }

  const leadSuit = getLeadSuit(plays)

  if (!leadSuit) {
    return null
  }

  let currentWinner = plays[0]

  for (let index = 1; index < plays.length; index += 1) {
    const challenger = plays[index]

    if (!challenger) {
      continue
    }

    let challengerWins = false

    if (winningBid?.contract === 'suit') {
      challengerWins = isChallengerWinningInSuitContract(
        currentWinner,
        challenger,
        leadSuit,
        winningBid
      )
    } else if (winningBid?.contract === 'all-trumps') {
      challengerWins = isChallengerWinningInAllTrumpsContract(
        currentWinner,
        challenger,
        leadSuit
      )
    } else {
      challengerWins = isChallengerWinningInNoTrumpsContract(
        currentWinner,
        challenger,
        leadSuit
      )
    }

    if (challengerWins) {
      currentWinner = challenger
    }
  }

  return currentWinner
}