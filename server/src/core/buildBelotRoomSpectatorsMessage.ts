import type { BelotRoomSpectatorsMessage, BelotRoomSpectatorSnapshot } from '../protocol/messageTypes.js'
import type { BelotSpectatorRegistry } from './belotSpectatorRegistry.js'
import type { ConnectionId, ProfileId, RoomId } from './serverTypes.js'

export type BuildBelotRoomSpectatorsMessageInput = {
  roomId: RoomId
  registry: BelotSpectatorRegistry
  resolveConnectionProfileId: (connectionId: ConnectionId) => ProfileId | null
  getPublicDisplayName: (profileId: ProfileId) => string | null
}

const FALLBACK_DISPLAY_NAME = 'Играч'

/**
 * Viewer-indicator за участниците на Belot маса ("{име} гледа вашата игра").
 *
 * Чиста функция — списъкът се строи от registry-то (connections на стаята),
 * profileId се resolve-ва live от connection state-а, а името — от public
 * профила. Deduplicate по profileId: един човек с няколко connections/tabs е
 * точно един ред. Само public полета (profileId + displayName) — никога
 * email/accountId/session/token/wallet данни.
 */
export function buildBelotRoomSpectatorsMessage(input: BuildBelotRoomSpectatorsMessageInput): BelotRoomSpectatorsMessage {
  const seenProfileIds = new Set<ProfileId>()
  const spectators: BelotRoomSpectatorSnapshot[] = []

  for (const connectionId of input.registry.listSpectatorConnectionIds(input.roomId)) {
    const profileId = input.resolveConnectionProfileId(connectionId)
    if (profileId === null || seenProfileIds.has(profileId)) continue
    seenProfileIds.add(profileId)
    const displayName = input.getPublicDisplayName(profileId)?.trim() ?? ''
    spectators.push({ profileId, displayName: displayName.length > 0 ? displayName : FALLBACK_DISPLAY_NAME })
  }

  return { type: 'belot_room_spectators', roomId: input.roomId, spectators }
}
