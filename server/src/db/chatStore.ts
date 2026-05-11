import { randomUUID } from 'node:crypto'
import type {
  PlayerPublicProfileSnapshot,
  ProfileId,
} from '../core/serverTypes.js'
import type { PlayerProgressStore } from './playerProgressStore.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

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
}

export type ChatStore = {
  listConversations: (profileId: ProfileId) => ChatConversationSnapshot[]
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
      }
    | { ok: false; message: string }
  close: () => void
}

type FriendshipRow = {
  friendship_id: string
  requester_profile_id: string
  addressee_profile_id: string
  updated_at: string
}

type ChatMessageRow = {
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
    createdAt: row.created_at,
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
    ORDER BY created_at DESC
    LIMIT 1;
  `)

  const selectMessagesStatement = database.prepare(`
    SELECT
      message_id,
      friendship_id,
      sender_profile_id,
      body,
      created_at
    FROM friend_chat_messages
    WHERE friendship_id = ?
      AND deleted_at IS NULL
    ORDER BY created_at ASC
    LIMIT 100;
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

  function createConversationSnapshot(
    friendship: FriendshipRow,
    ownProfileId: ProfileId,
  ): ChatConversationSnapshot | null {
    const friendProfile = playerProgressStore.getPublicProfile(
      getFriendProfileId(friendship, ownProfileId),
    )

    if (friendProfile === null) {
      return null
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
      updatedAt: lastMessageRow?.created_at ?? friendship.updated_at,
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

  function listConversations(profileId: ProfileId): ChatConversationSnapshot[] {
    const friendships = selectAcceptedFriendshipsStatement.all(
      profileId,
      profileId,
    ) as FriendshipRow[]

    return friendships
      .map((friendship) => createConversationSnapshot(friendship, profileId))
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

    const rows = selectMessagesStatement.all(friendshipId) as ChatMessageRow[]

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

    insertMessageStatement.run(
      randomUUID(),
      friendshipId,
      profileId,
      normalizedBody,
    )
    touchFriendshipStatement.run(friendshipId)

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
    }
  }

  function close(): void {
    database.close()
  }

  return {
    listConversations,
    listMessages,
    sendMessage,
    close,
  }
}
