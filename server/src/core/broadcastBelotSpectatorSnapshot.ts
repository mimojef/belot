import { WebSocket } from 'ws'
import type {
  BelotSpectateEndedMessage,
  EmojiReactionMessage,
  PhraseReactionMessage,
  TableGiftItemSentMessage,
} from '../protocol/messageTypes.js'
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

// Публични transient presentation събития, които spectator-ите виждат
// (Phase 4A D6 phrase/emoji, Phase 4B D7 table gift). Затворен union —
// нищо друго не минава през този път.
export type BelotSpectatorPublicPresentationEvent =
  | EmojiReactionMessage
  | PhraseReactionMessage
  | TableGiftItemSentMessage

// Table gift към spectator: participant payload-ът БЕЗ chargedPrice (данни за
// покупката) и recipientProfileId — точно полетата на static overlay-я, които
// spectator snapshot-ът вече показва публично (activeTableGifts), плюс
// type/roomId. Client animation-ът не чете пропуснатите полета.
export type BelotSpectatorTableGiftItemSentMessage = Omit<TableGiftItemSentMessage, 'chargedPrice' | 'recipientProfileId'>

type BelotSpectatorPublicPresentationPayload =
  | EmojiReactionMessage
  | PhraseReactionMessage
  | BelotSpectatorTableGiftItemSentMessage

export type BroadcastBelotSpectatorPublicEventInput = {
  room: ServerRoom
  event: BelotSpectatorPublicPresentationEvent
  registry: BelotSpectatorRegistry
  getConnection: (connectionId: ConnectionId) => ServerConnection | null
  getSocket: (connectionId: ConnectionId) => WebSocket | null
}

// Whitelist копие — точно полетата, които participant-ите вече получават,
// дори ако извикващият някога подаде обект с допълнителни полета.
function toPublicPresentationPayload(event: BelotSpectatorPublicPresentationEvent): BelotSpectatorPublicPresentationPayload {
  if (event.type === 'emoji_reaction') {
    return { type: 'emoji_reaction', roomId: event.roomId, seat: event.seat, emojiId: event.emojiId }
  }
  if (event.type === 'table_gift_item_sent') {
    return {
      type: 'table_gift_item_sent',
      roomId: event.roomId,
      transactionId: event.transactionId,
      giftItemId: event.giftItemId,
      giftName: event.giftName,
      imageUrl: event.imageUrl,
      senderProfileId: event.senderProfileId,
      senderSeat: event.senderSeat,
      senderDisplayName: event.senderDisplayName,
      recipientSeat: event.recipientSeat,
      sentAt: event.sentAt,
      expiresAt: event.expiresAt,
    }
  }
  return { type: 'phrase_reaction', roomId: event.roomId, seat: event.seat, phraseId: event.phraseId }
}

/**
 * Spectator fan-out за ЕДНО публично phrase/emoji/table-gift събитие (Phase 4A/4B).
 *
 * Participant broadcast-ът остава непроменен в handler-а; тук същото публично
 * събитие отива само до spectator subscriber-ите на ТАЗИ стая. Transient е —
 * нищо не се пази за reconnect/replay. Registry cleanup-ът (изчезнала
 * connection / станал участник) остава отговорност на snapshot fan-out-а;
 * тук такива connections просто се пропускат.
 *
 * Връща броя реално изпратени съобщения (диагностика/тестове).
 */
export function broadcastBelotSpectatorPublicEvent(input: BroadcastBelotSpectatorPublicEventInput): number {
  const { room, event, registry, getConnection, getSocket } = input
  if (event.roomId !== room.id) return 0
  const connectionIds = registry.listSpectatorConnectionIds(room.id)
  if (connectionIds.length === 0) return 0

  let serializedEvent: string | null = null
  let sentCount = 0

  for (const connectionId of connectionIds) {
    const connection = getConnection(connectionId)
    if (connection === null || connection.status !== 'connected') continue

    const hasBecomeParticipant =
      connection.currentRoomId !== null ||
      (connection.profileId !== null && isProfileParticipantInRoom(room, connection.profileId))
    if (hasBecomeParticipant) continue

    const socket = getSocket(connectionId)
    if (socket === null || socket.readyState !== WebSocket.OPEN) continue

    if (serializedEvent === null) {
      serializedEvent = JSON.stringify(toPublicPresentationPayload(event))
    }

    try {
      sendSerializedJsonMessage(socket, serializedEvent, event.type)
      sentCount += 1
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[belot-spectator] public event send failed room=${room.id} connection=${connectionId}: ${message}`)
    }
  }

  return sentCount
}
