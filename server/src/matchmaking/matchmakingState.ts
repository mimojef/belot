import type {
  MatchmakingQueueEntry,
  PendingMatchGroup,
} from './matchmakingTypes.js'

export type MatchmakingState = {
  queueEntries: MatchmakingQueueEntry[]
  pendingGroups: PendingMatchGroup[]
  lastProcessedAt: number | null
}
