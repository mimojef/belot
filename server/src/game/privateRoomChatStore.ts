// Изолиран, изцяло in-memory чат за живота на чакалнята на частна маса.
// НЕ се пази в SQLite (ефимерен е — виж task спецификацията), НЕ се бърка с
// lobby chat / friend chat / game reactions. Членството НЕ се проследява тук
// като отделен subscriber Set — при всяко изпращане index.ts проверява
// текущото членство директно в privateRoomsStore (по модела на
// emoji/phrase reactions), така че fan-out винаги отразява реалните текущи
// участници и се самопочиства при напускане/закриване без отделен teardown.
import { randomUUID } from 'node:crypto'

export const PRIVATE_ROOM_CHAT_MAX_MESSAGES_PER_ROOM = 200
export const PRIVATE_ROOM_CHAT_HISTORY_LIMIT = 100

const RATE_LIMIT_WINDOW_MS = 10_000
const RATE_LIMIT_MAX_PER_WINDOW = 5
const DUPLICATE_GUARD_MS = 8_000
const CLEANUP_INTERVAL_MS = 30_000

export type PrivateRoomChatMessage = {
  seq: number
  messageId: string
  senderProfileId: string | null
  senderDisplayName: string
  body: string
  createdAt: number
}

export type SendPrivateRoomChatInput = {
  senderProfileId: string | null
  senderDisplayName: string
  body: string
}

export type SendPrivateRoomChatResult =
  | { ok: true; message: PrivateRoomChatMessage }
  | { ok: false; code: 'rate_limited' | 'duplicate_message' }

export type PrivateRoomChatStore = {
  listRecentMessages: (privateRoomId: string) => PrivateRoomChatMessage[]
  sendMessage: (privateRoomId: string, input: SendPrivateRoomChatInput) => SendPrivateRoomChatResult
  clearRoom: (privateRoomId: string) => void
}

export function createPrivateRoomChatStore(): PrivateRoomChatStore {
  const messagesByRoom = new Map<string, PrivateRoomChatMessage[]>()
  const rateLimitByKey = new Map<string, { count: number; windowStartedAt: number }>()
  const lastMessageByKey = new Map<string, { body: string; sentAt: number }>()
  let nextSeq = 1
  let lastCleanupAt = 0

  function cleanupIfNeeded(now: number): void {
    if (now - lastCleanupAt < CLEANUP_INTERVAL_MS) return
    lastCleanupAt = now

    for (const [key, entry] of rateLimitByKey.entries()) {
      if (now - entry.windowStartedAt >= RATE_LIMIT_WINDOW_MS) {
        rateLimitByKey.delete(key)
      }
    }
    for (const [key, entry] of lastMessageByKey.entries()) {
      if (now - entry.sentAt >= DUPLICATE_GUARD_MS) {
        lastMessageByKey.delete(key)
      }
    }
  }

  function listRecentMessages(privateRoomId: string): PrivateRoomChatMessage[] {
    return messagesByRoom.get(privateRoomId) ?? []
  }

  function sendMessage(privateRoomId: string, input: SendPrivateRoomChatInput): SendPrivateRoomChatResult {
    const now = Date.now()
    cleanupIfNeeded(now)

    const rateLimitKey = input.senderProfileId ?? `conn:${privateRoomId}:${input.senderDisplayName}`
    const existingLimit = rateLimitByKey.get(rateLimitKey)

    if (existingLimit === undefined || now - existingLimit.windowStartedAt >= RATE_LIMIT_WINDOW_MS) {
      rateLimitByKey.set(rateLimitKey, { count: 1, windowStartedAt: now })
    } else if (existingLimit.count >= RATE_LIMIT_MAX_PER_WINDOW) {
      return { ok: false, code: 'rate_limited' }
    } else {
      existingLimit.count += 1
    }

    const lastMessage = lastMessageByKey.get(rateLimitKey)
    if (lastMessage !== undefined && lastMessage.body === input.body && now - lastMessage.sentAt < DUPLICATE_GUARD_MS) {
      return { ok: false, code: 'duplicate_message' }
    }
    lastMessageByKey.set(rateLimitKey, { body: input.body, sentAt: now })

    const message: PrivateRoomChatMessage = {
      seq: nextSeq,
      messageId: randomUUID(),
      senderProfileId: input.senderProfileId,
      senderDisplayName: input.senderDisplayName,
      body: input.body,
      createdAt: now,
    }
    nextSeq += 1

    const existingMessages = messagesByRoom.get(privateRoomId) ?? []
    const nextMessages = [...existingMessages, message]
    messagesByRoom.set(
      privateRoomId,
      nextMessages.length > PRIVATE_ROOM_CHAT_MAX_MESSAGES_PER_ROOM
        ? nextMessages.slice(nextMessages.length - PRIVATE_ROOM_CHAT_MAX_MESSAGES_PER_ROOM)
        : nextMessages,
    )

    return { ok: true, message }
  }

  function clearRoom(privateRoomId: string): void {
    messagesByRoom.delete(privateRoomId)
  }

  return { listRecentMessages, sendMessage, clearRoom }
}
