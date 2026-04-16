import type { ConnectionId, ServerConnection } from './serverTypes.js'

export function updateConnectionHeartbeat(
  connection: ServerConnection,
  connectionId: ConnectionId,
): ServerConnection {
  if (connection.id !== connectionId) {
    throw new Error(`Connection id mismatch. Expected "${connection.id}", got "${connectionId}".`)
  }

  return {
    ...connection,
    lastSeenAt: Date.now(),
  }
}