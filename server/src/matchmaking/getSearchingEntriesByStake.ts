import type { MatchStake, MatchmakingQueueEntry } from './matchmakingTypes.js'

export function getSearchingEntriesByStake(
  entries: MatchmakingQueueEntry[],
  stake: MatchStake,
): MatchmakingQueueEntry[] {
  return entries.filter((entry) => entry.stake === stake && entry.status === 'searching')
}