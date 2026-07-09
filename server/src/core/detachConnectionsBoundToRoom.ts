import { detachConnectionFromRoomSeat } from './detachConnectionFromRoomSeat.js'
import { updateServerConnectionInState } from './updateServerConnectionInState.js'
import type { RoomId, ServerState } from './serverTypes.js'

/**
 * Detaches every connection still bound (`currentRoomId === roomId`) to a
 * room that is being removed from the room registry.
 *
 * Bug this fixes: room removal (finished-match TTL reap, reconnect-grace
 * expiry, inactive-room cleanup) used to only delete the room from
 * `serverState.rooms`. Any connection whose socket stayed open past that
 * point kept `currentRoomId` pointing at the now-deleted room, so
 * /admin/server's WS diagnostics kept labeling it "Игрова" (in-game) while
 * "Активни стаи" no longer counted the room — a stale/orphan room binding.
 * The only other code path that cleared `currentRoomId` was the explicit
 * `leave_active_room` message handler, which never runs for an idle/expired
 * room. Call this immediately after removing a room from the registry so
 * connection state and room state never diverge.
 */
export function detachConnectionsBoundToRoom(
  serverState: ServerState,
  roomId: RoomId,
): ServerState {
  let nextState = serverState

  for (const connection of Object.values(nextState.connections)) {
    if (connection.currentRoomId === roomId) {
      const detached = detachConnectionFromRoomSeat(connection, connection.id)
      nextState = updateServerConnectionInState(nextState, connection.id, detached)
    }
  }

  return nextState
}
