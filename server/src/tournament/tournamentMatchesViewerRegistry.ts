import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { ConnectionId } from '../core/serverTypes.js'
import type { TournamentId } from './tournamentTypes.js'

/**
 * "Турнирни срещи" (Виж игрите) — in-memory registry на connections, които в
 * момента гледат списъка със срещите на даден турнир. Само read-only fan-out
 * за live резултати — никога не пипа турнирно/игрово state. Не се
 * персистира: след restart е празно и клиентът се абонира наново (след
 * пресен detail fetch, който носи нов токен).
 *
 * Source of truth е `tournamentIdByConnectionId` (една connection следи
 * максимум един турнир); `connectionIdsByTournamentId` е derived reverse
 * index за O(1) fan-out и се поддържа само тук (mirror на
 * core/belotSpectatorRegistry.ts).
 */
export type TournamentMatchesViewerRegistry = {
  subscribe: (connectionId: ConnectionId, tournamentId: TournamentId) => void
  /** Idempotent. tournamentId (ако е подаден) трябва да съвпада с текущия абонамент. */
  unsubscribe: (connectionId: ConnectionId, tournamentId?: TournamentId) => boolean
  getSubscribedTournamentId: (connectionId: ConnectionId) => TournamentId | null
  /** Snapshot копие — безопасно за итерация, докато callback-ът unsubscribe-ва. */
  listSubscriberConnectionIds: (tournamentId: TournamentId) => ConnectionId[]
  hasSubscribers: (tournamentId: TournamentId) => boolean
  size: () => number
}

export function createTournamentMatchesViewerRegistry(): TournamentMatchesViewerRegistry {
  const tournamentIdByConnectionId = new Map<ConnectionId, TournamentId>()
  const connectionIdsByTournamentId = new Map<TournamentId, Set<ConnectionId>>()

  function detachFromIndex(connectionId: ConnectionId, tournamentId: TournamentId): void {
    const connectionIds = connectionIdsByTournamentId.get(tournamentId)
    if (!connectionIds) return
    connectionIds.delete(connectionId)
    if (connectionIds.size === 0) connectionIdsByTournamentId.delete(tournamentId)
  }

  function subscribe(connectionId: ConnectionId, tournamentId: TournamentId): void {
    const previous = tournamentIdByConnectionId.get(connectionId)
    if (previous === tournamentId) return
    if (previous !== undefined) detachFromIndex(connectionId, previous)
    tournamentIdByConnectionId.set(connectionId, tournamentId)
    let connectionIds = connectionIdsByTournamentId.get(tournamentId)
    if (connectionIds === undefined) {
      connectionIds = new Set()
      connectionIdsByTournamentId.set(tournamentId, connectionIds)
    }
    connectionIds.add(connectionId)
  }

  function unsubscribe(connectionId: ConnectionId, tournamentId?: TournamentId): boolean {
    const current = tournamentIdByConnectionId.get(connectionId)
    if (current === undefined) return false
    if (tournamentId !== undefined && tournamentId !== current) return false
    tournamentIdByConnectionId.delete(connectionId)
    detachFromIndex(connectionId, current)
    return true
  }

  return {
    subscribe,
    unsubscribe,
    getSubscribedTournamentId: (connectionId) => tournamentIdByConnectionId.get(connectionId) ?? null,
    listSubscriberConnectionIds: (tournamentId) => [...(connectionIdsByTournamentId.get(tournamentId) ?? [])],
    hasSubscribers: (tournamentId) => connectionIdsByTournamentId.has(tournamentId),
    size: () => tournamentIdByConnectionId.size,
  }
}

/**
 * Токенът за subscribe_tournament_matches е HMAC(tournamentId) с per-process
 * случаен ключ. Издава се САМО в tournament detail DTO-то, т.е. след като
 * HTTP пътят вече е приложил всички access проверки (beta gate, парола за
 * защитени турнири) — WS пътят не дублира тази логика, а само проверява, че
 * клиентът реално е получил detail-а. След restart ключът е нов, затова
 * клиентът винаги се абонира наново с токен от пресен detail fetch.
 */
export type TournamentMatchesLiveTokenSigner = {
  sign: (tournamentId: TournamentId) => string
  verify: (tournamentId: TournamentId, token: string) => boolean
}

export function createTournamentMatchesLiveTokenSigner(
  secret: Buffer = randomBytes(32),
): TournamentMatchesLiveTokenSigner {
  function sign(tournamentId: TournamentId): string {
    return createHmac('sha256', secret).update(`tournament-matches:${tournamentId}`).digest('base64url')
  }
  return {
    sign,
    verify: (tournamentId, token) => {
      const expected = Buffer.from(sign(tournamentId))
      const provided = Buffer.from(token)
      return expected.length === provided.length && timingSafeEqual(expected, provided)
    },
  }
}
