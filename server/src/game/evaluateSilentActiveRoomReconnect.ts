// Етап 2 (тихо възстановяване на активна игра, reconnectOf) — проверката
// преди изместване на връзки или промяна на мястото. Изнесена от index.ts
// (Етап 0 на диагностиката) без промяна на логиката: същият ред на
// проверките и същите кодове към клиента ('other_session_active' /
// 'reconnect_unavailable'). Добавена е само конкретната причина (detail) и
// блокиращата връзка — единствено за диагностичния лог, никога към клиента.
//
// Чиста функция: състоянието (връзки, наскоро затворени връзки, часовник)
// се подава отвън, за да е тестваема без сървър.

import { findHumanParticipantByReconnectToken } from '../core/serverGameRuntimeHelpers.js'
import type { ConnectionId, ServerConnection, ServerRoom } from '../core/serverTypes.js'

export type SilentReconnectRefusalCode = 'other_session_active' | 'reconnect_unavailable'

export type SilentReconnectRefusalDetail =
  | 'no_profile'
  | 'room_missing'
  | 'same_connection'
  | 'guest_trial'
  | 'token_not_found'
  | 'token_owner_mismatch'
  | 'seat_permanently_left'
  | 'previous_live_profile_mismatch'
  | 'previous_live_room_mismatch'
  | 'previous_unknown'
  | 'previous_closed_profile_mismatch'
  | 'previous_closed_room_mismatch'
  | 'previous_closed_expired'
  | 'seat_held_by_other_connection'
  | 'other_live_connection'

export type RecentlyClosedRoomConnection = { profileId: string; roomId: string; closedAt: number }

export type SilentReconnectDecision =
  | {
      ok: true
      previousConnection: 'live' | 'recently_closed'
      /** Етап 4: собствени предишни опити (доказани), които иначе биха блокирали. */
      provenOwnConnectionIds: ConnectionId[]
    }
  | {
      ok: false
      code: SilentReconnectRefusalCode
      detail: SilentReconnectRefusalDetail
      /** Само при other_session_active — коя връзка блокира (диагностика). */
      blockingConnectionId?: ConnectionId
      blockingConnectionAttached?: boolean
    }

export type EvaluateSilentActiveRoomReconnectInput = {
  connectionId: ConnectionId
  profileId: string | null
  reconnectOf: string
  room: ServerRoom | null
  reconnectToken: string
  connections: Readonly<Record<ConnectionId, ServerConnection>>
  getRecentlyClosed: (connectionId: ConnectionId) => RecentlyClosedRoomConnection | undefined
  now: number
  recentlyClosedTtlMs: number
  /**
   * Етап 4: предишни опити на СЪЩАТА страница, доказани със сървърен
   * attemptProof (виж core/reconnectAttemptProofs.ts). Празно = досегашното
   * поведение без промяна.
   */
  provenOwnConnectionIds?: ReadonlySet<ConnectionId>
}

function refuse(
  code: SilentReconnectRefusalCode,
  detail: SilentReconnectRefusalDetail,
  blocking?: { connectionId: ConnectionId; attached: boolean },
): SilentReconnectDecision {
  return blocking === undefined
    ? { ok: false, code, detail }
    : { ok: false, code, detail, blockingConnectionId: blocking.connectionId, blockingConnectionAttached: blocking.attached }
}

/**
 * Позволено (ok) само ако: reconnectOf е предишната връзка на същия профил към
 * същата стая (жива/полуотворена или наскоро затворена), token-ът е на
 * човешкото място на този профил, мястото е свободно или още на предишната
 * връзка, и профилът няма друга жива сесия.
 */
export function evaluateSilentActiveRoomReconnect(input: EvaluateSilentActiveRoomReconnectInput): SilentReconnectDecision {
  const { connectionId, profileId, reconnectOf, room, reconnectToken, connections } = input
  if (profileId === null) return refuse('reconnect_unavailable', 'no_profile')
  if (room === null) return refuse('reconnect_unavailable', 'room_missing')
  if (reconnectOf === connectionId) return refuse('reconnect_unavailable', 'same_connection')
  if (room.config.isGuestTrial === true) return refuse('reconnect_unavailable', 'guest_trial')
  const seatMatch = findHumanParticipantByReconnectToken(room, reconnectToken)
  if (seatMatch === null) return refuse('reconnect_unavailable', 'token_not_found')
  const ownerProfileId = seatMatch.participant.identity.profileId ?? seatMatch.participant.publicProfile?.profileId ?? null
  if (ownerProfileId !== profileId) return refuse('reconnect_unavailable', 'token_owner_mismatch')
  if (seatMatch.participant.permanentlyLeftAt != null) return refuse('reconnect_unavailable', 'seat_permanently_left')

  // Предишната връзка: още „жива“ (полуотворена) или наскоро затворена.
  let previousConnection: 'live' | 'recently_closed'
  const previousLive = connections[reconnectOf as ConnectionId] ?? null
  if (previousLive !== null) {
    if (previousLive.profileId !== profileId) return refuse('reconnect_unavailable', 'previous_live_profile_mismatch')
    if (previousLive.currentRoomId !== room.id) return refuse('reconnect_unavailable', 'previous_live_room_mismatch')
    previousConnection = 'live'
  } else {
    const closed = input.getRecentlyClosed(reconnectOf as ConnectionId)
    if (closed === undefined) return refuse('reconnect_unavailable', 'previous_unknown')
    if (closed.profileId !== profileId) return refuse('reconnect_unavailable', 'previous_closed_profile_mismatch')
    if (closed.roomId !== room.id) return refuse('reconnect_unavailable', 'previous_closed_room_mismatch')
    if (input.now - closed.closedAt > input.recentlyClosedTtlMs) return refuse('reconnect_unavailable', 'previous_closed_expired')
    previousConnection = 'recently_closed'
  }

  const proven = input.provenOwnConnectionIds ?? new Set<ConnectionId>()
  const provenUsed = new Set<ConnectionId>()
  // Мястото е заето от друга връзка (друго устройство вече е в играта).
  // Етап 4: освен ако е собствен предишен опит (напр. прикрепен, но
  // room_resumed/snapshot не са стигнали до клиента).
  const seatConnectionId = seatMatch.participant.connectionId
  if (seatConnectionId !== null && seatConnectionId !== reconnectOf && proven.has(seatConnectionId)) {
    provenUsed.add(seatConnectionId)
  } else if (seatConnectionId !== null && seatConnectionId !== reconnectOf) {
    const holder = connections[seatConnectionId] ?? null
    return refuse('other_session_active', 'seat_held_by_other_connection', {
      connectionId: seatConnectionId,
      attached: holder !== null && holder.currentRoomId !== null,
    })
  }
  // Друга жива сесия на профила (устройство/таб) — никога не се измества.
  for (const other of Object.values(connections)) {
    if (other.profileId !== profileId || other.status !== 'connected') continue
    if (other.id === connectionId || other.id === reconnectOf) continue
    // Етап 4: собствен предишен опит (полуотворен/неприкрепен) не е друго устройство.
    if (proven.has(other.id)) {
      provenUsed.add(other.id)
      continue
    }
    return refuse('other_session_active', 'other_live_connection', {
      connectionId: other.id,
      attached: other.currentRoomId !== null,
    })
  }
  return { ok: true, previousConnection, provenOwnConnectionIds: [...provenUsed] }
}
