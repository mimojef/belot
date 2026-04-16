import type {
  ConnectionId,
  ServerConnection,
  ServerState,
} from './serverTypes.js'

export function updateServerConnectionInState(
  serverState: ServerState,
  connectionId: ConnectionId,
  connection: ServerConnection,
): ServerState {
  if (!(connectionId in serverState.connections)) {
    throw new Error(`Connection "${connectionId}" does not exist in server state.`)
  }

  if (connection.id !== connectionId) {
    throw new Error(
      `Connection id mismatch. Expected "${connectionId}", got "${connection.id}".`,
    )
  }

  return {
    ...serverState,
    connections: {
      ...serverState.connections,
      [connectionId]: connection,
    },
  }
}