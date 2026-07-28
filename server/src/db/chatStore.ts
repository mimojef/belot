import { randomUUID } from 'node:crypto'
import type {
  PlayerPublicProfileSnapshot,
  ProfileId,
} from '../core/serverTypes.js'
import type { PlayerProgressStore } from './playerProgressStore.js'
import { dbDateToUtc } from './dbDate.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export const PERSONAL_CHAT_HISTORY_LIMIT = 100
export const PERSONAL_CHAT_STORAGE_LIMIT = 500

export type ChatMessageSnapshot = {
  messageId: string
  friendshipId: string
  senderProfileId: ProfileId
  body: string
  createdAt: string
  isOwnMessage: boolean
}

export type ChatConversationSnapshot = {
  friendshipId: string
  friend: PlayerPublicProfileSnapshot
  lastMessage: ChatMessageSnapshot | null
  updatedAt: string
  unreadCount: number
}

export type ChatStore = {
  listConversations: (profileId: ProfileId, onlineProfileIds?: Set<string>) => ChatConversationSnapshot[]
  listMessages: (
    profileId: ProfileId,
    friendshipId: string,
  ) =>
    | { ok: true; messages: ChatMessageSnapshot[] }
    | { ok: false; message: string }
  sendMessage: (
    profileId: ProfileId,
    friendshipId: string,
    body: string,
  ) =>
    | {
        ok: true
        conversation: ChatConversationSnapshot
        messages: ChatMessageSnapshot[]
        newMessage: ChatMessageSnapshot
      }
    | { ok: false; message: string }
  markConversationRead: (profileId: ProfileId, friendshipId: string) => void
  isFirstUnreadMessage: (recipientProfileId: ProfileId, friendshipId: string) => boolean
  close: () => void
}

type FriendshipRow = {
  friendship_id: string
  requester_profile_id: string
  addressee_profile_id: string
  updated_at: string
}

type ChatMessageRow = {
  rowid: number
  message_id: string
  friendship_id: string
  sender_profile_id: string
  body: string
  created_at: string
}

function getFriendProfileId(
  friendship: FriendshipRow,
  profileId: ProfileId,
): ProfileId {
  return friendship.requester_profile_id === profileId
    ? friendship.addressee_profile_id
    : friendship.requester_profile_id
}

function normalizeMessageBody(value: string): string | null {
  const normalized = value.replace(/\s+/g, ' ').trim()

  if (normalized.length === 0 || normalized.length > 1000) {
    return null
  }

  return normalized
}

function toMessageSnapshot(
  row: ChatMessageRow,
  ownProfileId: ProfileId,
): ChatMessageSnapshot {
  return {
    messageId: row.message_id,
    friendshipId: row.friendship_id,
    senderProfileId: row.sender_profile_id,
    body: row.body,
    createdAt: dbDateToUtc(row.created_at),
    isOwnMessage: row.sender_profile_id === ownProfileId,
  }
}

export async function createChatStore(
  databaseFilePath: string,
  playerProgressStore: PlayerProgressStore,
): Promise<ChatStore> {
  const sqliteModule = await import('node:sqlite')
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })

  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')

  const selectAcceptedFriendshipsStatement = database.prepare(`
    SELECT
      friendship_id,
      requester_profile_id,
      addressee_profile_id,
      updated_at
    FROM profile_friendships
    WHERE status = 'accepted'
      AND (
        requester_profile_id = ?
        OR addressee_profile_id = ?
      )
    ORDER BY updated_at DESC;
  `)

  const selectAcceptedFriendshipStatement = database.prepare(`
    SELECT
      friendship_id,
      requester_profile_id,
      addressee_profile_id,
      updated_at
    FROM profile_friendships
    WHERE friendship_id = ?
      AND status = 'accepted'
      AND (
        requester_profile_id = ?
        OR addressee_profile_id = ?
      )
    LIMIT 1;
  `)

  const selectLatestMessageStatement = database.prepare(`
    SELECT
      message_id,
      friendship_id,
      sender_profile_id,
      body,
      created_at
    FROM friend_chat_messages
    WHERE friendship_id = ?
      AND deleted_at IS NULL
    ORDER BY created_at DESC, rowid DESC
    LIMIT 1;
  `)

  const selectMessagesStatement = database.prepare(`
    SELECT
      message_id,
      friendship_id,
      sender_profile_id,
      body,
      created_at
    FROM (
      SELECT
        rowid,
        message_id,
        friendship_id,
        sender_profile_id,
        body,
        created_at
      FROM friend_chat_messages
      WHERE friendship_id = ?
        AND deleted_at IS NULL
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?
    )
    ORDER BY created_at ASC, rowid ASC;
  `)

  const selectInsertedMessageStatement = database.prepare(`
    SELECT
      rowid,
      message_id,
      friendship_id,
      sender_profile_id,
      body,
      created_at
    FROM friend_chat_messages
    WHERE message_id = ?
    LIMIT 1;
  `)

  const insertMessageStatement = database.prepare(`
    INSERT INTO friend_chat_messages (
      message_id,
      friendship_id,
      sender_profile_id,
      body
    ) VALUES (
      ?,
      ?,
      ?,
      ?
    );
  `)

  const touchFriendshipStatement = database.prepare(`
    UPDATE profile_friendships
    SET updated_at = CURRENT_TIMESTAMP
    WHERE friendship_id = ?;
  `)

  const selectUnreadCountStatement = database.prepare(`
    SELECT COUNT(*) as cnt
    FROM friend_chat_messages
    WHERE friendship_id = ?
      AND sender_profile_id != ?
      AND deleted_at IS NULL
      AND created_at > COALESCE(
        (SELECT last_read_at FROM chat_conversation_reads WHERE profile_id = ? AND friendship_id = ?),
        '1970-01-01'
      );
  `)

  const upsertReadStatement = database.prepare(`
    INSERT INTO chat_conversation_reads (profile_id, friendship_id, last_read_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT (profile_id, friendship_id)
    DO UPDATE SET last_read_at = CURRENT_TIMESTAMP;
  `)

  const pruneOldMessagesStatement = database.prepare(`
    DELETE FROM friend_chat_messages
    WHERE friendship_id = ?
      AND rowid IN (
        SELECT rowid
        FROM friend_chat_messages
        WHERE friendship_id = ?
        ORDER BY created_at DESC, rowid DESC
        LIMIT -1 OFFSET ?
      );
  `)

  function getUnreadCount(profileId: ProfileId, friendshipId: string): number {
    const row = selectUnreadCountStatement.get(
      friendshipId,
      profileId,
      profileId,
      friendshipId,
    ) as { cnt: number } | undefined
    return row?.cnt ?? 0
  }

  function createConversationSnapshot(
    friendship: FriendshipRow,
    ownProfileId: ProfileId,
    onlineProfileIds?: Set<string>,
  ): ChatConversationSnapshot | null {
    const friendProfile = playerProgressStore.getPublicProfile(
      getFriendProfileId(friendship, ownProfileId),
    )

    if (friendProfile === null) {
      return null
    }

    if (onlineProfileIds !== undefined && friendProfile.profileId !== null) {
      friendProfile.isOnline = onlineProfileIds.has(friendProfile.profileId)
    }

    const lastMessageRow = selectLatestMessageStatement.get(
      friendship.friendship_id,
    ) as ChatMessageRow | undefined

    return {
      friendshipId: friendship.friendship_id,
      friend: friendProfile,
      lastMessage: lastMessageRow
        ? toMessageSnapshot(lastMessageRow, ownProfileId)
        : null,
      updatedAt: dbDateToUtc(lastMessageRow?.created_at ?? friendship.updated_at),
      unreadCount: getUnreadCount(ownProfileId, friendship.friendship_id),
    }
  }

  function getAcceptedFriendship(
    profileId: ProfileId,
    friendshipId: string,
  ): FriendshipRow | null {
    const row = selectAcceptedFriendshipStatement.get(
      friendshipId,
      profileId,
      profileId,
    ) as FriendshipRow | undefined

    return row ?? null
  }

  function listConversations(profileId: ProfileId, onlineProfileIds?: Set<string>): ChatConversationSnapshot[] {
    const friendships = selectAcceptedFriendshipsStatement.all(
      profileId,
      profileId,
    ) as FriendshipRow[]

    return friendships
      .map((friendship) => createConversationSnapshot(friendship, profileId, onlineProfileIds))
      .filter((conversation): conversation is ChatConversationSnapshot => {
        return conversation !== null
      })
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  function listMessages(
    profileId: ProfileId,
    friendshipId: string,
  ):
    | { ok: true; messages: ChatMessageSnapshot[] }
    | { ok: false; message: string } {
    const friendship = getAcceptedFriendship(profileId, friendshipId)

    if (friendship === null) {
      return {
        ok: false,
        message: 'Чатът е достъпен само между приятели.',
      }
    }

    const rows = selectMessagesStatement.all(
      friendshipId,
      PERSONAL_CHAT_HISTORY_LIMIT,
    ) as ChatMessageRow[]

    return {
      ok: true,
      messages: rows.map((row) => toMessageSnapshot(row, profileId)),
    }
  }

  function sendMessage(
    profileId: ProfileId,
    friendshipId: string,
    body: string,
  ):
    | {
        ok: true
        conversation: ChatConversationSnapshot
        messages: ChatMessageSnapshot[]
        newMessage: ChatMessageSnapshot
      }
    | { ok: false; message: string } {
    const friendship = getAcceptedFriendship(profileId, friendshipId)

    if (friendship === null) {
      return {
        ok: false,
        message: 'Чатът е достъпен само между приятели.',
      }
    }

    const normalizedBody = normalizeMessageBody(body)

    if (normalizedBody === null) {
      return {
        ok: false,
        message: 'Съобщението трябва да е между 1 и 1000 символа.',
      }
    }

    const messageId = randomUUID()
    let insertedRow: ChatMessageRow | undefined

    database.exec('BEGIN IMMEDIATE;')

    try {
      insertMessageStatement.run(
        messageId,
        friendshipId,
        profileId,
        normalizedBody,
      )
      insertedRow = selectInsertedMessageStatement.get(messageId) as ChatMessageRow | undefined
      touchFriendshipStatement.run(friendshipId)
      upsertReadStatement.run(profileId, friendshipId)
      pruneOldMessagesStatement.run(
        friendshipId,
        friendshipId,
        PERSONAL_CHAT_STORAGE_LIMIT,
      )
      database.exec('COMMIT;')
    } catch (error) {
      try {
        database.exec('ROLLBACK;')
      } catch {
        // Keep the original write failure visible to the caller.
      }
      throw error
    }

    if (insertedRow === undefined) {
      return {
        ok: false,
        message: 'РЎСЉРѕР±С‰РµРЅРёРµС‚Рѕ РЅРµ Р±РµС€Рµ Р·Р°РїРёСЃР°РЅРѕ.',
      }
    }

    const conversation = createConversationSnapshot(friendship, profileId)
    const messagesResult = listMessages(profileId, friendshipId)

    if (conversation === null || !messagesResult.ok) {
      return {
        ok: false,
        message: 'Съобщението беше записано, но чатът не се обнови.',
      }
    }

    return {
      ok: true,
      conversation,
      messages: messagesResult.messages,
      newMessage: toMessageSnapshot(insertedRow, profileId),
    }
  }

  function markConversationRead(profileId: ProfileId, friendshipId: string): void {
    upsertReadStatement.run(profileId, friendshipId)
  }

  /**
   * Вярно само когато получателят няма НИКАКВИ непрочетени съобщения в тази
   * боя преди текущия момент — т.е. следващото съобщение, изпратено сега, ще
   * бъде ПЪРВОТО непрочетено в поредицата му. Трябва да се извика ПРЕДИ
   * sendMessage() да вмъкне новото съобщение, иначе винаги ще намери поне 1
   * непрочетено (самото ново съобщение).
   */
  function isFirstUnreadMessage(recipientProfileId: ProfileId, friendshipId: string): boolean {
    return getUnreadCount(recipientProfileId, friendshipId) === 0
  }

  function close(): void {
    database.close()
  }

  return {
    listConversations,
    listMessages,
    sendMessage,
    markConversationRead,
    isFirstUnreadMessage,
    close,
  }
}
