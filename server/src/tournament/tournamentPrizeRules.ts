export const TOURNAMENT_FINANCIAL_RULES_VERSION = 'v1_20_65_35' as const
export const TOURNAMENT_SYSTEM_FEE_PERCENT = 20
export const TOURNAMENT_WINNER_SHARE_PERCENT = 65
export const TOURNAMENT_RUNNER_UP_SHARE_PERCENT = 35

export type TournamentPrizePreview = {
  totalEntryFees: number
  systemFee: number
  prizePool: number
  firstTeamPrize: number
  secondTeamPrize: number
  firstPlayerPrize: number
  secondPlayerPrize: number
  systemFeePercent: typeof TOURNAMENT_SYSTEM_FEE_PERCENT
  winnerSharePercent: typeof TOURNAMENT_WINNER_SHARE_PERCENT
  runnerUpSharePercent: typeof TOURNAMENT_RUNNER_UP_SHARE_PERCENT
  financialRulesVersion: typeof TOURNAMENT_FINANCIAL_RULES_VERSION
}

export function calculateTournamentPrizePreview(
  entryFee: number,
  playerCapacity: number,
): TournamentPrizePreview {
  const totalEntryFees = entryFee * playerCapacity
  const systemFee = Math.trunc(totalEntryFees * TOURNAMENT_SYSTEM_FEE_PERCENT / 100)
  const prizePool = totalEntryFees - systemFee
  const firstTeamPrize = Math.trunc(prizePool * TOURNAMENT_WINNER_SHARE_PERCENT / 100)
  const secondTeamPrize = prizePool - firstTeamPrize
  const firstPlayerPrize = Math.trunc(firstTeamPrize / 2)
  const secondPlayerPrize = Math.trunc(secondTeamPrize / 2)

  if (
    systemFee + prizePool !== totalEntryFees ||
    firstTeamPrize + secondTeamPrize !== prizePool ||
    firstPlayerPrize * 2 !== firstTeamPrize ||
    secondPlayerPrize * 2 !== secondTeamPrize
  ) {
    throw new Error('Tournament prize preview must use exact integer arithmetic.')
  }

  return {
    totalEntryFees,
    systemFee,
    prizePool,
    firstTeamPrize,
    secondTeamPrize,
    firstPlayerPrize,
    secondPlayerPrize,
    systemFeePercent: TOURNAMENT_SYSTEM_FEE_PERCENT,
    winnerSharePercent: TOURNAMENT_WINNER_SHARE_PERCENT,
    runnerUpSharePercent: TOURNAMENT_RUNNER_UP_SHARE_PERCENT,
    financialRulesVersion: TOURNAMENT_FINANCIAL_RULES_VERSION,
  }
}
