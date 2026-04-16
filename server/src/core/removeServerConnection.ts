import type { ConnectionId, ServerState } from './serverTypes.js'

export function removeServerConnection(
  serverState: ServerState,
  connectionId: ConnectionId,
): ServerState {
  if (!(connectionId in serverState.connections)) {
    return serverState
  }

  const nextConnections = { ...serverState.connections }
  delete nextConnections[connectionId]

  return {
    ...serverState,
    connections: nextConnections,
  }
}