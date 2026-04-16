import type { ServerConnection, ServerState } from './serverTypes.js'

export function upsertServerConnection(
  serverState: ServerState,
  connection: ServerConnection,
): ServerState {
  return {
    ...serverState,
    connections: {
      ...serverState.connections,
      [connection.id]: connection,
    },
  }
}