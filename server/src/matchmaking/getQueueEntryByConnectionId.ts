import type { ConnectionId } from '../core/serverTypes.js'
import type { MatchmakingQueueEntry } from './matchmakingTypes.js'

export function getQueueEntryByConnectionId(
  entries: MatchmakingQueueEntry[],
  connectionId: ConnectionId,
): MatchmakingQueueEntry | null {
  return entries.find((entry) => entry.connectionId === connectionId) ?? null
}
