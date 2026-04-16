import type { ConnectionId, ServerConnection } from './serverTypes.js'

export function markConnectionDisconnected(
  connection: ServerConnection,
  connectionId: ConnectionId,
): ServerConnection {
  if (connection.id !== connectionId) {
    throw new Error(`Connection id mismatch. Expected "${connection.id}", got "${connectionId}".`)
  }

  return {
    ...connection,
    status: 'disconnected',
    lastSeenAt: Date.now(),
  }
}