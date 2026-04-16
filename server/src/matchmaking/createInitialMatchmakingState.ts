import type { MatchmakingState } from './matchmakingState.js'

export function createInitialMatchmakingState(): MatchmakingState {
  return {
    queueEntries: [],
    pendingGroups: [],
    lastProcessedAt: null,
  }
}
