import type { ServerRank, ServerTrickPlay, ServerWinningBid } from './serverGameTypes.js'

const NO_TRUMPS_RANK_POWER: Record<ServerRank, number> = {
  '7': 0,
  '8': 1,
  '9': 2,
  J: 3,
  Q: 4,
  K: 5,
  '10': 6,
  A: 7,
}

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

function isTrumpCard(suit: string, winningBid: ServerWinningBid): boolean {
  return winningBid?.contract === 'suit' && winningBid.trumpSuit === suit
}

function isChallengerWinningInSuitContract(
  current: ServerTrickPlay,
  challenger: ServerTrickPlay,
  leadSuit: string,
  winningBid: ServerWinningBid,
): boolean {
  const currentIsTrump = isTrumpCard(current.card.suit, winningBid)
  const challengerIsTrump = isTrumpCard(challenger.card.suit, winningBid)

  if (challengerIsTrump && !currentIsTrump) return true
  if (!challengerIsTrump && currentIsTrump) return false

  if (challengerIsTrump && currentIsTrump) {
    return TRUMP_RANK_POWER[challenger.card.rank] > TRUMP_RANK_POWER[current.card.rank]
  }

  const currentFollowsLead = current.card.suit === leadSuit
  const challengerFollowsLead = challenger.card.suit === leadSuit

  if (challengerFollowsLead && !currentFollowsLead) return true
  if (!challengerFollowsLead && currentFollowsLead) return false

  if (challengerFollowsLead && currentFollowsLead) {
    return NO_TRUMPS_RANK_POWER[challenger.card.rank] > NO_TRUMPS_RANK_POWER[current.card.rank]
  }

  return false
}

function isChallengerWinningInNoTrumpsContract(
  current: ServerTrickPlay,
  challenger: ServerTrickPlay,
  leadSuit: string,
): boolean {
  const currentFollowsLead = current.card.suit === leadSuit
  const challengerFollowsLead = challenger.card.suit === leadSuit

  if (challengerFollowsLead && !currentFollowsLead) return true
  if (!challengerFollowsLead && currentFollowsLead) return false

  if (challengerFollowsLead && currentFollowsLead) {
    return NO_TRUMPS_RANK_POWER[challenger.card.rank] > NO_TRUMPS_RANK_POWER[current.card.rank]
  }

  return false
}

function isChallengerWinningInAllTrumpsContract(
  current: ServerTrickPlay,
  challenger: ServerTrickPlay,
  leadSuit: string,
): boolean {
  const currentFollowsLead = current.card.suit === leadSuit
  const challengerFollowsLead = challenger.card.suit === leadSuit

  if (challengerFollowsLead && !currentFollowsLead) return true
  if (!challengerFollowsLead && currentFollowsLead) return false

  if (challengerFollowsLead && currentFollowsLead) {
    return TRUMP_RANK_POWER[challenger.card.rank] > TRUMP_RANK_POWER[current.card.rank]
  }

  return false
}

export function getServerTrickWinner(
  plays: ServerTrickPlay[],
  winningBid: ServerWinningBid,
): ServerTrickPlay | null {
  if (plays.length === 0) return null

  const leadSuit = plays[0]?.card.suit ?? null

  if (!leadSuit) return null

  let current = plays[0]

  for (let i = 1; i < plays.length; i += 1) {
    const challenger = plays[i]

    if (!challenger) continue

    let challengerWins = false

    if (winningBid?.contract === 'suit') {
      challengerWins = isChallengerWinningInSuitContract(current, challenger, leadSuit, winningBid)
    } else if (winningBid?.contract === 'all-trumps') {
      challengerWins = isChallengerWinningInAllTrumpsContract(current, challenger, leadSuit)
    } else {
      challengerWins = isChallengerWinningInNoTrumpsContract(current, challenger, leadSuit)
    }

    if (challengerWins) {
      current = challenger
    }
  }

  return current
}
