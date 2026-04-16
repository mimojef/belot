import type { ConnectionId, ServerConnection, ServerState } from './serverTypes.js'

export function getConnectionById(
  serverState: ServerState,
  connectionId: ConnectionId,
): ServerConnection | null {
  return serverState.connections[connectionId] ?? null
}