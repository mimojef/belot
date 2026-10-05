import { WebSocket } from 'ws'
import type { BelotSpectateEndedMessage } from '../protocol/messageTypes.js'
import { createSpectatorRoomSnapshotMessage } from '../protocol/createRoomSnapshotMessage.js'
import type { BelotSpectatorRegistry } from './belotSpectatorRegistry.js'
import { isProfileParticipantInRoom } from './evaluateBelotSpectatorWatchEligibility.js'
import { sendJsonMessage, sendSerializedJsonMessage } from './sendJsonMessage.js'
import type { ConnectionId, ServerConnection, ServerRoom } from './serverTypes.js'

export type BroadcastBelotSpectatorSnapshotInput = {
  room: ServerRoom
  registry: BelotSpectatorRegistry
  getConnection: (connectionId: ConnectionId) => ServerConnection | null
  getSocket: (connectionId: ConnectionId) => WebSocket | null
}

/**
 * Spectator fan-out за ЕДИН room update (Belot Spectator Mode, Phase 2A).
 *
 *  - Ако стаята няма spectators -> нищо не се строи/сериализира.
 *  - Иначе spectator-safe payload-ът се строи ВЕДНЪЖ и се сериализира ВЕДНЪЖ;
 *    същият низ отива до всички spectator sockets (не N serialization-а).
 *  - Invariant guard: spectator connection, която междувременно е станала
 *    участник (currentRoomId !== null или профилът ѝ седи в тази стая), или
 *    вече не съществува, се маха от registry-то вместо да получи snapshot.
 *
 * Връща броя реално изпратени spectator snapshot-и (диагностика/тестове).
 */
export function broadcastBelotSpectatorSnapshot(input: BroadcastBelotSpectatorSnapshotInput): number {
  const { room, registry, getConnection, getSocket } = input
  const connectionIds = registry.listSpectatorConnectionIds(room.id)
  if (connectionIds.length === 0) return 0

  let serializedSnapshot: string | null = null
  let sentCount = 0

  for (const connectionId of connectionIds) {
    const connection = getConnection(connectionId)

    if (connection === null) {
      registry.unwatch(connectionId)
      continue
    }

    const hasBecomeParticipant =
      connection.currentRoomId !== null ||
      (connection.profileId !== null && isProfileParticipantInRoom(room, connection.profileId))

    const socket = getSocket(connectionId)
    const isSocketOpen = socket !== null && socket.readyState === WebSocket.OPEN

    if (hasBecomeParticipant) {
      registry.unwatch(connectionId)
      if (isSocketOpen) {
        const ended: BelotSpectateEndedMessage = {
          type: 'belot_spectate_ended',
          roomId: room.id,
          reason: 'game_commitment',
        }
        sendJsonMessage(socket, ended)
      }
      continue
    }

    if (!isSocketOpen || connection.status !== 'connected') {
      continue
    }

    if (serializedSnapshot === null) {
      serializedSnapshot = JSON.stringify(createSpectatorRoomSnapshotMessage(room))
    }

    try {
      sendSerializedJsonMessage(socket, serializedSnapshot, 'belot_spectator_snapshot')
      sentCount += 1
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[belot-spectator] send failed room=${room.id} connection=${connectionId}: ${message}`)
    }
  }

  return sentCount
}
