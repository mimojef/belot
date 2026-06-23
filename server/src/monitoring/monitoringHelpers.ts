import type { ServerConnection } from '../core/serverTypes.js'

// WebSocket.OPEN === 1 per the WebSocket spec (RFC 6455 / WHATWG).
// We accept the constant as a parameter so this module stays free of the 'ws' import
// and the functions remain unit-testable with plain objects.
export const WS_OPEN = 1

export function countOpenWebSockets(
  sockets: ReadonlyMap<string, { readyState: number }>,
  wsOpenValue: number = WS_OPEN,
): number {
  let count = 0
  for (const ws of sockets.values()) {
    if (ws.readyState === wsOpenValue) count++
  }
  return count
}

export function countUniqueOnlineRealPlayers(
  connections: Readonly<Record<string, ServerConnection>>,
): number {
  const seen = new Set<string>()
  for (const conn of Object.values(connections)) {
    if (conn.status === 'connected' && conn.profileId !== null) {
      seen.add(conn.profileId)
    }
  }
  return seen.size
}
