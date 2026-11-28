// Общ текстов чат на чакалните на частните маси (Етап 1).
//
// Изведен 1:1 от чата на чакалнята на Белот (index.ts, до Етап 1) — същите
// проверки в същия ред, същите текстове на грешките, същото хранилище
// (privateRoomChatStore: in-memory история, лимит за честота и повторения).
// Разлики спрямо досегашния код:
//   * изолация по игра И маса: ключът в хранилището е `${gameId}:${tableId}`,
//     затова еднакви tableId в различни игри никога не споделят история;
//   * членството идва от адаптера на играта (gameTableRegistry.ts) — при
//     абониране, при история, при изпращане и при всяко разпращане;
//     подадените от клиента gameId/tableId само се сравняват с него;
//   * два протокола: старите съобщения на Белот (private_room_chat_*) и общите
//     (table_chat_*). Отговорите към заявителя са в протокола на заявката;
//     разпращането към участниците — във формата на играта (chatDelivery).
//
// Няма списък с абонати: получателите се извеждат при всяко изпращане от
// текущите седнали участници, така че напуснал или изместен участник спира да
// получава съобщения веднага, без отделно почистване.

import type { PrivateRoomChatStore } from '../game/privateRoomChatStore.js'
import { PRIVATE_ROOM_CHAT_HISTORY_LIMIT } from '../game/privateRoomChatStore.js'
import type {
  PrivateRoomChatErrorCode,
  PrivateRoomChatErrorMessage,
  PrivateRoomChatHistoryMessage,
  PrivateRoomChatMessageReceivedMessage,
  TableChatErrorMessage,
  TableChatHistoryMessage,
  TableChatMessageReceivedMessage,
} from '../protocol/messageTypes.js'
import { PRIVATE_ROOM_CHAT_MAX_BODY_CODE_POINTS, validatePrivateRoomChatBody } from '../protocol/privateRoomChatValidation.js'
import type { GameTableRegistry } from './gameTableRegistry.js'

/** 'legacy' — старите съобщения на Белот (само gameId 'belot'); 'table' — общите. */
export type TableChatProtocol = 'legacy' | 'table'

export type TableChatOutgoingMessage =
  | PrivateRoomChatHistoryMessage
  | PrivateRoomChatMessageReceivedMessage
  | PrivateRoomChatErrorMessage
  | TableChatHistoryMessage
  | TableChatMessageReceivedMessage
  | TableChatErrorMessage

export type TableChatMuteSnapshot = { isMuted: boolean; mutedUntil?: string | null; reason?: string | null }

export type TableChatServiceDeps = {
  registry: GameTableRegistry
  store: PrivateRoomChatStore
  /** profileId на ЖИВАТА връзка (сървърното състояние); null/undefined = без профил. */
  getConnectionProfileId: (connectionId: string) => string | null | undefined
  /** Единният mute (topicModerationStore.getSectionMuteSnapshot); хвърлена грешка -> fail-closed. */
  getMuteSnapshot: (profileId: string) => TableChatMuteSnapshot
  send: (connectionId: string, message: TableChatOutgoingMessage) => void
  /** Текстът при активен mute (общият за всички чатове). */
  mutedMessage: string
  /** Прието и разпратено съобщение (броячите за активност). */
  onMessageAccepted?: (gameId: string) => void
  logError?: (line: string) => void
}

export type TableChatTarget = { protocol: TableChatProtocol; gameId: string; tableId: string }

export type TableChatService = {
  subscribe: (connectionId: string, target: TableChatTarget) => void
  sendMessage: (connectionId: string, target: TableChatTarget & { body: string; requestId?: string }) => void
  /** Историята на масата приключва (старт, затваряне, изтичане, празна маса). */
  clearTable: (gameId: string, tableId: string) => void
}

const NOT_MEMBER_MESSAGE = 'Не си в тази чакалня.'

export function tableChatStoreKey(gameId: string, tableId: string): string {
  return `${gameId}:${tableId}`
}

export function createTableChatService(deps: TableChatServiceDeps): TableChatService {
  const logError = deps.logError ?? ((line: string) => console.error(line))

  /** Членството — само от адаптера; сравнението с gameId/tableId от клиента е допълнително условие. */
  function resolveMembership(connectionId: string, target: TableChatTarget) {
    // Старият протокол е само на Белот (privateRoomId) — никога не достига други игри.
    if (target.protocol === 'legacy' && target.gameId !== 'belot') return null
    const adapter = deps.registry.get(target.gameId)
    if (adapter === null) return null
    const membership = adapter.findMembership(connectionId)
    if (membership === null || membership.tableId !== target.tableId) return null
    return { adapter, membership }
  }

  function sendError(
    connectionId: string,
    target: TableChatTarget,
    code: PrivateRoomChatErrorCode,
    message: string,
    extra: { requestId?: string; mutedUntil?: string; reason?: string } = {},
  ): void {
    const tail = {
      ...(extra.requestId ? { requestId: extra.requestId } : {}),
      ...(extra.mutedUntil ? { mutedUntil: extra.mutedUntil } : {}),
      ...(extra.reason ? { reason: extra.reason } : {}),
    }
    if (target.protocol === 'legacy') {
      deps.send(connectionId, { type: 'private_room_chat_error', code, message, ...tail })
      return
    }
    deps.send(connectionId, { type: 'table_chat_error', gameId: target.gameId, tableId: target.tableId, code, message, ...tail })
  }

  function subscribe(connectionId: string, target: TableChatTarget): void {
    const resolved = resolveMembership(connectionId, target)
    if (resolved === null) {
      sendError(connectionId, target, 'not_member', NOT_MEMBER_MESSAGE)
      return
    }
    const tableId = resolved.membership.tableId
    const messages = deps.store
      .listRecentMessages(tableChatStoreKey(target.gameId, tableId))
      .slice(-PRIVATE_ROOM_CHAT_HISTORY_LIMIT)
    if (target.protocol === 'legacy') {
      deps.send(connectionId, { type: 'private_room_chat_history', privateRoomId: tableId, messages })
      return
    }
    deps.send(connectionId, { type: 'table_chat_history', gameId: target.gameId, tableId, messages })
  }

  function sendMessage(connectionId: string, target: TableChatTarget & { body: string; requestId?: string }): void {
    const requestId = target.requestId
    const fail = (code: PrivateRoomChatErrorCode, message: string) => sendError(connectionId, target, code, message, { requestId })

    const profileId = deps.getConnectionProfileId(connectionId)
    if (profileId == null) {
      fail('not_authenticated', 'Трябва да влезеш в профила си.')
      return
    }

    const resolved = resolveMembership(connectionId, target)
    if (resolved === null) {
      fail('not_member', NOT_MEMBER_MESSAGE)
      return
    }
    const { adapter, membership } = resolved

    // Единен мют (Лафче + Теми + чатовете на частните маси) — при ВСЯКО
    // изпращане, по profileId на сесията, ПРЕДИ запис и разпращане.
    // Fail-closed: непроверим мют -> съобщението НЕ се публикува.
    let mute: TableChatMuteSnapshot
    try {
      mute = deps.getMuteSnapshot(profileId)
    } catch (error) {
      logError(`[private-room-chat] mute check failed ${error instanceof Error ? error.message : String(error)}`)
      fail('mute_check_unavailable', 'Съобщението не можа да бъде изпратено. Опитай отново.')
      return
    }
    if (mute.isMuted) {
      sendError(connectionId, target, 'muted', deps.mutedMessage, {
        requestId,
        ...(mute.mutedUntil ? { mutedUntil: mute.mutedUntil } : {}),
        ...(mute.reason ? { reason: mute.reason } : {}),
      })
      return
    }

    const validation = validatePrivateRoomChatBody(target.body)
    if (!validation.ok) {
      const messagesByCode: Record<typeof validation.code, string> = {
        empty_body: 'Съобщението не може да бъде празно.',
        body_too_long: `Съобщението може да е най-много ${PRIVATE_ROOM_CHAT_MAX_BODY_CODE_POINTS} символа.`,
        invalid_body: 'Съобщението съдържа неразрешени символи.',
      }
      fail(validation.code, messagesByCode[validation.code])
      return
    }

    const sendResult = deps.store.sendMessage(tableChatStoreKey(target.gameId, membership.tableId), {
      senderProfileId: membership.member.profileId,
      senderDisplayName: membership.member.displayName,
      body: validation.body,
    })
    if (!sendResult.ok) {
      const messagesByCode: Record<typeof sendResult.code, string> = {
        rate_limited: 'Твърде много съобщения. Изчакай малко и опитай пак.',
        duplicate_message: 'Вече изпрати това съобщение.',
      }
      fail(sendResult.code, messagesByCode[sendResult.code])
      return
    }

    deps.onMessageAccepted?.(target.gameId)

    // Получателите — от същото авторитетно участие (текущите седнали).
    for (const recipientConnectionId of membership.recipientConnectionIds) {
      const echo = recipientConnectionId === connectionId && requestId ? { requestId } : {}
      if (adapter.chatDelivery === 'legacy-private-room') {
        deps.send(recipientConnectionId, { type: 'private_room_chat_message', privateRoomId: membership.tableId, ...sendResult.message, ...echo })
      } else {
        deps.send(recipientConnectionId, { type: 'table_chat_message', gameId: target.gameId, tableId: membership.tableId, ...sendResult.message, ...echo })
      }
    }
  }

  return {
    subscribe,
    sendMessage,
    clearTable: (gameId, tableId) => deps.store.clearRoom(tableChatStoreKey(gameId, tableId)),
  }
}
