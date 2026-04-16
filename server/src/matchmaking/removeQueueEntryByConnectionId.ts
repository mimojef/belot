import type { ConnectionId } from '../core/serverTypes.js'
import type { MatchmakingQueueEntry } from './matchmakingTypes.js'

export function removeQueueEntryByConnectionId(
  entries: MatchmakingQueueEntry[],
  connectionId: ConnectionId,
): MatchmakingQueueEntry[] {
  return entries.filter((entry) => entry.connectionId !== connectionId)
}
