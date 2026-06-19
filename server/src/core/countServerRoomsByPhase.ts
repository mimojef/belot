import type { ServerState } from './serverTypes.js'

export function countServerRoomsByPhase(
  rooms: ServerState['rooms'],
): Record<string, number> {
  const counts: Record<string, number> = {}

  for (const room of Object.values(rooms)) {
    const authoritativeState = room.game.authoritativeState
    const phase =
      authoritativeState !== null && !('kind' in authoritativeState)
        ? authoritativeState.phase
        : (room.game.phase ?? 'bootstrap')
    counts[phase] = (counts[phase] ?? 0) + 1
  }

  return counts
}
