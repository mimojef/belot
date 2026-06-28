import type { ServerConnection } from '../core/serverTypes.js'

// WebSocket ready-state constants per RFC 6455 / WHATWG.
// Defined as plain numbers so this module stays free of the 'ws' import
// and remains unit-testable with plain objects.
export const WS_CONNECTING = 0
export const WS_OPEN = 1
export const WS_CLOSING = 2
export const WS_CLOSED = 3

function readyStateName(rs: number): string {
  if (rs === WS_OPEN) return 'OPEN'
  if (rs === WS_CONNECTING) return 'CONNECTING'
  if (rs === WS_CLOSING) return 'CLOSING'
  if (rs === WS_CLOSED) return 'CLOSED'
  return String(rs)
}

export function maskIpAddress(ip: string | null): string | null {
  if (ip === null) return null
  const trimmed = ip.trim()
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(trimmed)
  if (v4 !== null) return `*.*.${v4[3]}.${v4[4]}`
  const v4m = /^::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(trimmed)
  if (v4m !== null) return `*.*.${v4m[3]}.${v4m[4]}`
  return '[****]'
}

export type WsConnectionInput = Pick<
  ServerConnection,
  'profileId' | 'currentRoomId' | 'connectedAt' | 'lastSeenAt' | 'remoteAddress' | 'userAgent' | 'status'
>

export type WsConnectionEntry = {
  connectionId: string
  readyStateLabel: string
  isOpen: boolean
  profileId: string | null
  displayName: string | null
  connectedAtMs: number
  lastSeenAtMs: number
  maskedIp: string | null
  userAgent: string | null
  currentRoomId: string | null
  hasActiveGameSession: boolean
  probablePendingSessionInGame: boolean
}

export type WsConnectionsSummary = {
  registrySize: number
  openSocketCount: number
  connectedStateCount: number
  uniqueOnlineProfiles: number
  guestOpenSockets: number
  authenticatedOpenSockets: number
  profilesWithMultipleOpenSockets: number
}

export type WsConnectionsDiagnostic = {
  entries: WsConnectionEntry[]
  summary: WsConnectionsSummary
}

/**
 * Builds a read-only diagnostic snapshot of current WebSocket connections.
 *
 * Guarantees:
 * - Never calls socket.send(), socket.close() or socket.terminate()
 * - Never mutates the supplied sockets Map or connections Record
 * - Never mutates the supplied profileOpenCounts (internal Map is created fresh)
 * - All IP addresses are masked before they reach the output
 *
 * @param sockets        Read-only view of the socket registry (connectionId → socket-like object)
 * @param connections    Read-only view of server connection state
 * @param hasActiveGameSession   Injected predicate — returns true if the profile is currently
 *                               a live human participant in any active game room
 * @param getDisplayName Injected lookup — returns the public display name for a profileId, or null
 */
export function buildWsConnectionsDiagnostic(
  sockets: ReadonlyMap<string, { readyState: number }>,
  connections: Readonly<Record<string, WsConnectionInput>>,
  hasActiveGameSession: (profileId: string) => boolean,
  getDisplayName: (profileId: string) => string | null,
): WsConnectionsDiagnostic {
  const entries: WsConnectionEntry[] = []
  const profileOpenCounts = new Map<string, number>()

  for (const [connId, socket] of sockets) {
    const conn = connections[connId]
    const rs = socket.readyState
    const isOpen = rs === WS_OPEN
    const profileId = conn?.profileId ?? null
    const currentRoomId = conn?.currentRoomId ?? null
    const hasGame = profileId !== null && hasActiveGameSession(profileId)
    const probablePendingSessionInGame = isOpen && profileId !== null && currentRoomId === null && hasGame

    const displayName = profileId !== null ? getDisplayName(profileId) : null

    if (isOpen && profileId !== null) {
      profileOpenCounts.set(profileId, (profileOpenCounts.get(profileId) ?? 0) + 1)
    }

    entries.push({
      connectionId: connId,
      readyStateLabel: readyStateName(rs),
      isOpen,
      profileId,
      displayName,
      connectedAtMs: conn?.connectedAt ?? 0,
      lastSeenAtMs: conn?.lastSeenAt ?? 0,
      maskedIp: maskIpAddress(conn?.remoteAddress ?? null),
      userAgent: conn?.userAgent ?? null,
      currentRoomId,
      hasActiveGameSession: hasGame,
      probablePendingSessionInGame,
    })
  }

  entries.sort((a, b) => b.connectedAtMs - a.connectedAtMs)

  const openEntries = entries.filter((e) => e.isOpen)

  const summary: WsConnectionsSummary = {
    registrySize: sockets.size,
    openSocketCount: openEntries.length,
    connectedStateCount: Object.values(connections).filter((c) => c.status === 'connected').length,
    uniqueOnlineProfiles: profileOpenCounts.size,
    guestOpenSockets: openEntries.filter((e) => e.profileId === null).length,
    authenticatedOpenSockets: openEntries.filter((e) => e.profileId !== null).length,
    profilesWithMultipleOpenSockets: [...profileOpenCounts.values()].filter((c) => c > 1).length,
  }

  return { entries, summary }
}
