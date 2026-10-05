import type { ConnectionId, ProfileId, RoomId } from './serverTypes.js'

/**
 * Belot Spectator Mode ("Гледай", Phase 2A) — read-only subscription
 * registry. Spectator-ът е websocket subscriber БЕЗ game membership:
 * registry-то НИКОГА не пипа ServerRoom, ServerConnection.currentRoomId/
 * currentSeat, reconnectToken или persisted authoritative state. Не се
 * персистира — след server restart е празно (клиентът re-watch-ва).
 *
 * Source of truth е ЕДИНСТВЕНО `roomIdByConnectionId` (една connection гледа
 * максимум една маса). `connectionIdsByRoomId` е derived reverse index за
 * O(1) broadcast fan-out и се поддържа САМО вътре в watch/unwatch/removeRoom,
 * атомарно заедно с основния map — никога не се пише отвън, затова двете
 * структури не могат да се разсинхронизират.
 *
 * Profile-level въпросите ("гледа ли този профил нещо?") НЕ пазят собствен
 * profile map — profileId се resolve-ва live от съществуващия connection
 * registry (serverState.connections) чрез подадения resolver. Така няма втори
 * profile source of truth, а multi-tab/multi-device случаите (няколко
 * connections на един профил) автоматично се покриват.
 */
export type BelotSpectatorRegistry = {
  /** Регистрира connection-а като spectator на roomId. Ако вече гледа друга
   * маса, старият subscription се маха атомарно. Връща предишния roomId
   * (или null). */
  watch: (connectionId: ConnectionId, roomId: RoomId) => RoomId | null
  /** Idempotent. Връща roomId-то, от което е махнат, или null при no-op. */
  unwatch: (connectionId: ConnectionId) => RoomId | null
  getWatchedRoomId: (connectionId: ConnectionId) => RoomId | null
  isConnectionSpectating: (connectionId: ConnectionId) => boolean
  /** Snapshot копие — безопасно за итерация, докато callback-ът unwatch-ва. */
  listSpectatorConnectionIds: (roomId: RoomId) => ConnectionId[]
  listAllSpectatorConnectionIds: () => ConnectionId[]
  /** Маха ВСИЧКИ spectators на стаята; връща кои connections са махнати. */
  removeRoom: (roomId: RoomId) => ConnectionId[]
  size: () => number
}

export function createBelotSpectatorRegistry(): BelotSpectatorRegistry {
  const roomIdByConnectionId = new Map<ConnectionId, RoomId>()
  const connectionIdsByRoomId = new Map<RoomId, Set<ConnectionId>>()

  function detachFromIndex(connectionId: ConnectionId, roomId: RoomId): void {
    const connectionIds = connectionIdsByRoomId.get(roomId)
    if (!connectionIds) return
    connectionIds.delete(connectionId)
    if (connectionIds.size === 0) connectionIdsByRoomId.delete(roomId)
  }

  function unwatch(connectionId: ConnectionId): RoomId | null {
    const roomId = roomIdByConnectionId.get(connectionId)
    if (roomId === undefined) return null
    roomIdByConnectionId.delete(connectionId)
    detachFromIndex(connectionId, roomId)
    return roomId
  }

  function watch(connectionId: ConnectionId, roomId: RoomId): RoomId | null {
    const previousRoomId = roomIdByConnectionId.get(connectionId) ?? null
    if (previousRoomId === roomId) return previousRoomId
    if (previousRoomId !== null) detachFromIndex(connectionId, previousRoomId)

    roomIdByConnectionId.set(connectionId, roomId)
    let connectionIds = connectionIdsByRoomId.get(roomId)
    if (connectionIds === undefined) {
      connectionIds = new Set()
      connectionIdsByRoomId.set(roomId, connectionIds)
    }
    connectionIds.add(connectionId)
    return previousRoomId
  }

  function removeRoom(roomId: RoomId): ConnectionId[] {
    const connectionIds = [...(connectionIdsByRoomId.get(roomId) ?? [])]
    for (const connectionId of connectionIds) {
      roomIdByConnectionId.delete(connectionId)
    }
    connectionIdsByRoomId.delete(roomId)
    return connectionIds
  }

  return {
    watch,
    unwatch,
    getWatchedRoomId: (connectionId) => roomIdByConnectionId.get(connectionId) ?? null,
    isConnectionSpectating: (connectionId) => roomIdByConnectionId.has(connectionId),
    listSpectatorConnectionIds: (roomId) => [...(connectionIdsByRoomId.get(roomId) ?? [])],
    listAllSpectatorConnectionIds: () => [...roomIdByConnectionId.keys()],
    removeRoom,
    size: () => roomIdByConnectionId.size,
  }
}

export type ConnectionProfileResolver = (connectionId: ConnectionId) => ProfileId | null

/** Всички spectator connections, принадлежащи на profileId (multi-tab). */
export function findProfileSpectatorConnectionIds(
  registry: BelotSpectatorRegistry,
  profileId: ProfileId,
  resolveProfileId: ConnectionProfileResolver,
): ConnectionId[] {
  return registry
    .listAllSpectatorConnectionIds()
    .filter((connectionId) => resolveProfileId(connectionId) === profileId)
}

/**
 * Profile-level отговор за HTTP пътищата (gift endpoints), които НЕ са
 * table-scoped и нямат connection context — профил, гледащ маса през КОЯТО И
 * ДА Е своя connection (таб/устройство), се третира като spectator.
 */
export function isProfileSpectatingBelot(
  registry: BelotSpectatorRegistry,
  profileId: ProfileId | null,
  resolveProfileId: ConnectionProfileResolver,
): boolean {
  if (profileId === null || profileId.length === 0) return false
  return findProfileSpectatorConnectionIds(registry, profileId, resolveProfileId).length > 0
}
