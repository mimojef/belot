import { randomUUID } from 'node:crypto'
import type {
  PlayerPublicProfileSnapshot,
  ProfileId,
} from '../core/serverTypes.js'
import type { PlayerProgressStore } from './playerProgressStore.js'
import { dbDateToUtc } from './dbDate.js'
import { getConfiguredOfficialPikaProfileId } from './normalizeProfileIdentityText.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export const PERSONAL_CHAT_HISTORY_LIMIT = 100
export const PERSONAL_CHAT_STORAGE_LIMIT = 500

// Разговор без нови съобщения за повече от 12 календарни месеца се смята
// за архивиран (виж createConversationSnapshot/isArchived по-долу) — чисто
// derived от updatedAt, без отделна archived_at колона/state за поддръжка.
// Всяко ново съобщение обновява updated_at (touchFriendshipStatement в
// sendMessage), значи автоматично "изважда" разговора от архивираните.
const CONVERSATION_ARCHIVE_AFTER_DAYS = 365

export type ChatConversationKind = 'friend' | 'vip_dm' | 'pika_support'
export type ChatStoreErrorCode =
  | 'blocked'
  | 'conversation_not_found'
  | 'invalid_conversation_kind'
  | 'message_required'
  | 'recipient_not_found'
  | 'self'
  | 'vip_required'
  | 'vip_counterpart_required'

export type ChatAttachmentSnapshot = {
  attachmentId: string
  width: number
  height: number
  byteSize: number
  viewUrl: string
  downloadUrl: string
}

export type ChatMessageSnapshot = {
  messageId: string
  friendshipId: string
  senderProfileId: ProfileId
  body: string
  createdAt: string
  isOwnMessage: boolean
  attachment: ChatAttachmentSnapshot | null
}

export type ChatConversationSnapshot = {
  friendshipId: string
  friend: PlayerPublicProfileSnapshot
  // Per-participant факт за КОНКРЕТНИЯ `friend` по-горе — official Pika.bg
  // profileId ИЛИ account role==='pika_team'. Умишлено ОТДЕЛНО от `kind`
  // (виж ChatConversationKind коментара): kind е symmetric property на
  // целия разговор (важи еднакво за двете страни), затова НЕ бива да се
  // ползва като proxy за "този показан участник е Team" — точно това
  // объркване причиняваше "Екип Pika.bg" badge върху normal player, когато
  // pika_team служителят гледа собствения си inbox. Client renderer-ите
  // (renderLobbyScreen.ts) трябва да четат ТОВА поле за badge, не kind.
  friendIsPikaTeam: boolean
  lastMessage: ChatMessageSnapshot | null
  updatedAt: string
  unreadCount: number
  kind: ChatConversationKind
  isArchived: boolean
}

// Входни данни за нов attachment — попълва се от sharp обработения буфер
// ПРЕДИ извикване на sendMessage (файлът вече е записан на диск към момента
// на този запис, виж handleChatRequest/index.ts за атомарността: file write
// → DB транзакция → при DB грешка, изтрий файла).
export type NewChatAttachmentInput = {
  storageFilename: string
  width: number
  height: number
  byteSize: number
  contentType: string
}

export type ChatStore = {
  listConversations: (
    profileId: ProfileId,
    onlineProfileIds?: Set<string>,
    includeArchived?: boolean,
  ) => ChatConversationSnapshot[]
  // Единствен начин служебен pika_support разговор да бъде СЪЗДАДЕН — вика
  // се само от POST /api/chat/pika-support/start. Authoritative проверката
  // живее ИЗЦЯЛО тук (виж коментара на функцията по-долу) — store-ът не
  // вижда session-и, затова isRoleBasedPikaTeamSender се подава explicit от
  // route handler-а, вече изчислен от isPikaTeamSupportChatSession(session)
  // (authStore.ts, role==='pika_team' единствено, server-authoritative, НЕ
  // от client payload). initiatorProfileId === configured officialPikaProfileId
  // (legacy единичен profileId) остава паралелно валиден път.
  getOrCreatePikaSupportConversation: (
    initiatorProfileId: ProfileId,
    recipientProfileId: ProfileId,
    isRoleBasedPikaTeamSender?: boolean,
  ) =>
    | { ok: true; friendshipId: string; conversation: ChatConversationSnapshot }
    | { ok: false; message: string; code?: ChatStoreErrorCode }
  getOrCreateVipDmConversation: (
    senderProfileId: ProfileId,
    recipientProfileId: ProfileId,
  ) =>
    | { ok: true; friendshipId: string; conversation: ChatConversationSnapshot }
    | { ok: false; message: string; code?: ChatStoreErrorCode }
  // Атомарен start+send за ПЪРВОТО съобщение на нов (или вече съществуващ)
  // vip_dm разговор — виж §5 в task spec-а. Единствен path, който може да
  // СЪЗДАДЕ нов vip_dm ред след fix-а (legacy getOrCreateVipDmConversation
  // вече не създава без съществуващ conversation).
  startVipDmConversationWithMessage: (
    senderProfileId: ProfileId,
    recipientProfileId: ProfileId,
    body: string,
    attachment?: NewChatAttachmentInput | null,
  ) =>
    | {
        ok: true
        conversation: ChatConversationSnapshot
        messages: ChatMessageSnapshot[]
        newMessage: ChatMessageSnapshot
      }
    | { ok: false; message: string; code?: ChatStoreErrorCode }
  canSendMessage: (
    profileId: ProfileId,
    friendshipId: string,
  ) => { ok: true } | { ok: false; message: string; code?: ChatStoreErrorCode }
  listMessages: (
    profileId: ProfileId,
    friendshipId: string,
  ) =>
    | { ok: true; messages: ChatMessageSnapshot[] }
    | { ok: false; message: string; code?: ChatStoreErrorCode }
  sendMessage: (
    profileId: ProfileId,
    friendshipId: string,
    body: string,
    attachment?: NewChatAttachmentInput | null,
  ) =>
    | {
        ok: true
        conversation: ChatConversationSnapshot
        messages: ChatMessageSnapshot[]
        newMessage: ChatMessageSnapshot
      }
    | { ok: false; message: string; code?: ChatStoreErrorCode }
  markConversationRead: (profileId: ProfileId, friendshipId: string) => void
  isFirstUnreadMessage: (recipientProfileId: ProfileId, friendshipId: string) => boolean
  isFirstUnreadMessageAfterInsert: (recipientProfileId: ProfileId, friendshipId: string) => boolean
  getAttachmentForDownload: (
    profileId: ProfileId,
    friendshipId: string,
    storageFilename: string,
  ) => { storageFilename: string; contentType: string } | null
  // ─── Background attachment cleanup (виж index.ts runChatAttachmentCleanup /
  // runChatAttachmentOrphanScan) ───────────────────────────────────────────
  listPendingAttachmentDeletions: (limit: number) => { eventSeq: number; storageFilename: string }[]
  markAttachmentDeletionDone: (eventSeq: number) => void
  markAttachmentDeletionFailed: (eventSeq: number) => void
  attachmentExistsForFilename: (storageFilename: string) => boolean
  purgeDoneAttachmentDeletions: (olderThanDays: number, batchSize: number) => number
  close: () => void
}

type FriendshipRow = {
  friendship_id: string
  requester_profile_id: string
  addressee_profile_id: string
  lower_profile_id: string
  higher_profile_id: string
  updated_at: string
  kind: string
}

type ChatMessageRow = {
  rowid: number
  message_id: string
  friendship_id: string
  sender_profile_id: string
  body: string
  created_at: string
  attachment_filename: string | null
  attachment_width: number | null
  attachment_height: number | null
  attachment_byte_size: number | null
  attachment_content_type: string | null
}

// URL-и за преглед/сваляне на attachment — не физически filesystem path.
// Пазени тук (не в index.ts), за да останат consistent навсякъде, където
// chatStore конструира ChatMessageSnapshot (listMessages, sendMessage,
// createConversationSnapshot за lastMessage preview).
function buildAttachmentUrls(friendshipId: string, storageFilename: string): { viewUrl: string; downloadUrl: string } {
  const base = `/api/chat/${encodeURIComponent(friendshipId)}/attachments/${encodeURIComponent(storageFilename)}`
  return { viewUrl: base, downloadUrl: `${base}?download=1` }
}

function toConversationKind(kind: string): ChatConversationKind | null {
  if (kind === 'friend' || kind === 'vip_dm' || kind === 'pika_support') {
    return kind
  }
  return null
}

function getFriendProfileId(
  friendship: FriendshipRow,
  profileId: ProfileId,
): ProfileId {
  return friendship.requester_profile_id === profileId
    ? friendship.addressee_profile_id
    : friendship.requester_profile_id
}

// Огледално на createProfilePair в friendshipStore.ts — детерминистичен
// (lower, higher) ordering, за да съвпадне с UNIQUE partial index-а
// idx_profile_friendships_pika_support_pair(lower_profile_id, higher_profile_id)
// WHERE kind='pika_support'.
function createChatProfilePair(
  leftProfileId: ProfileId,
  rightProfileId: ProfileId,
): { lowerProfileId: ProfileId; higherProfileId: ProfileId } {
  return leftProfileId.localeCompare(rightProfileId, 'en') <= 0
    ? { lowerProfileId: leftProfileId, higherProfileId: rightProfileId }
    : { lowerProfileId: rightProfileId, higherProfileId: leftProfileId }
}

// Позволява празен body (когато съобщението носи attachment) — за разлика
// от предишната версия, тук НЕ отхвърляме normalized.length === 0. Дали
// празен body е валиден зависи от наличието на attachment, а тази функция
// не го знае — извикващият (sendMessage) прилага "text ИЛИ attachment
// задължителни" правилото.
function normalizeMessageBody(value: string): string | null {
  const normalized = value.replace(/\s+/g, ' ').trim()

  if (normalized.length > 1000) {
    return null
  }

  return normalized
}

function toMessageSnapshot(
  row: ChatMessageRow,
  ownProfileId: ProfileId,
): ChatMessageSnapshot {
  const attachment = row.attachment_filename !== null
    && row.attachment_width !== null
    && row.attachment_height !== null
    && row.attachment_byte_size !== null
    ? {
        attachmentId: row.attachment_filename,
        width: row.attachment_width,
        height: row.attachment_height,
        byteSize: row.attachment_byte_size,
        ...buildAttachmentUrls(row.friendship_id, row.attachment_filename),
      }
    : null

  return {
    messageId: row.message_id,
    friendshipId: row.friendship_id,
    senderProfileId: row.sender_profile_id,
    body: row.body,
    createdAt: dbDateToUtc(row.created_at),
    isOwnMessage: row.sender_profile_id === ownProfileId,
    attachment,
  }
}

// Минимален inject-нат interface от blockStore — избягва circular
// dependency между двата store модула (chatStore не се нуждае от целия
// BlockStore API, само от проверката "A блокирал ли е B").
export type ChatStoreBlockChecker = {
  isBlocked: (blockerProfileId: string, blockedProfileId: string) => boolean
}

// Минимален inject-нат interface от friendshipStore — избягва chatStore да
// подготвя собствена SQL заявка към profiles таблицата (и по този начин да
// изисква тя да съществува дори в тестови fixtures, които изолират само
// chat-специфичните таблици). Реюзва СЪЩАТА "регистриран човешки профил с
// активен акаунт" дефиниция, която вече guard-ва обикновените friend
// requests (виж friendshipStore.isRegisteredHumanProfile).
export type ChatStoreProfileEligibilityChecker = {
  isRegisteredHumanProfile: (profileId: ProfileId) => boolean
}

export type ChatStoreVipStatusChecker = {
  isActiveVip: (profileId: ProfileId) => boolean
}

// Минимален inject-нат interface от authStore — избягва circular dependency
// (authStore зависи транзитивно от други store-ове, chatStore не бива да го
// import-ва directly). Единствената нужда тук е "тоя конкретен profileId
// account role==='pika_team' ли е" — за derive-ване на friendIsPikaTeam в
// createConversationSnapshot (виж direct chat "Екип Pika.bg" badge
// cross-over fix-а — badge-ът трябва да следва КОНКРЕТНИЯ показан
// participant, не conversation.kind).
export type ChatStoreRoleChecker = {
  isPikaTeamProfile: (profileId: ProfileId) => boolean
}

export type ChatStoreOptions = {
  officialPikaProfileId?: string | null
  vipStatusChecker?: ChatStoreVipStatusChecker
  roleChecker?: ChatStoreRoleChecker
}

export async function createChatStore(
  databaseFilePath: string,
  playerProgressStore: PlayerProgressStore,
  blockChecker: ChatStoreBlockChecker,
  profileEligibilityChecker: ChatStoreProfileEligibilityChecker,
  options: ChatStoreOptions = {},
): Promise<ChatStore> {
  // Единственият profileId, който смее да СЪЗДАВА pika_support разговори —
  // fail-closed: липсваща/празна/невалидна env стойност → null → цялата
  // getOrCreatePikaSupportConversation отказва безусловно (виж по-долу).
  // Реюзва СЪЩИЯ canonical helper като display-name reservation-а
  // (normalizeProfileIdentityText.ts), за да няма два разминаващи се env
  // var-а за "кой е официалният Pika.bg профил".
  const officialPikaProfileId =
    options.officialPikaProfileId ?? getConfiguredOfficialPikaProfileId()
  const vipStatusChecker = options.vipStatusChecker ?? null
  const roleChecker = options.roleChecker ?? null

  // Истинска самоличност на "Екип Pika.bg" за КОНКРЕТЕН profileId — legacy
  // единичен official profile ID ИЛИ role==='pika_team' (role-based staff).
  // Умишлено НЕ зависи от conversation.kind: kind='pika_support' е symmetric
  // property на целия friendship ред (важи еднакво за двете страни), докато
  // това тук е per-participant факт. Виж direct chat "Екип Pika.bg" badge
  // cross-over fix-а — badge-ът в renderChatPanel трябва да пита точно тази
  // функция за conversation.friend, не conversation.kind.
  function isPikaTeamProfile(profileId: ProfileId | null): boolean {
    if (profileId === null) {
      return false
    }
    if (officialPikaProfileId !== null && profileId === officialPikaProfileId) {
      return true
    }
    return roleChecker?.isPikaTeamProfile(profileId) ?? false
  }

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
      lower_profile_id,
      higher_profile_id,
      updated_at,
      kind
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
      lower_profile_id,
      higher_profile_id,
      updated_at,
      kind
    FROM profile_friendships
    WHERE friendship_id = ?
      AND status = 'accepted'
      AND (
        requester_profile_id = ?
        OR addressee_profile_id = ?
      )
    LIMIT 1;
  `)

  // Намира вече съществуващ pika_support ред между двойката (независимо
  // кой е requester/addressee) — 'find' частта на find-or-create.
  const selectPikaSupportByPairStatement = database.prepare(`
    SELECT
      friendship_id,
      requester_profile_id,
      addressee_profile_id,
      lower_profile_id,
      higher_profile_id,
      updated_at,
      kind
    FROM profile_friendships
    WHERE lower_profile_id = ?
      AND higher_profile_id = ?
      AND kind = 'pika_support'
    LIMIT 1;
  `)

  const selectAcceptedFriendByPairStatement = database.prepare(`
    SELECT
      friendship_id,
      requester_profile_id,
      addressee_profile_id,
      lower_profile_id,
      higher_profile_id,
      updated_at,
      kind
    FROM profile_friendships
    WHERE lower_profile_id = ?
      AND higher_profile_id = ?
      AND status = 'accepted'
      AND kind = 'friend'
    LIMIT 1;
  `)

  const selectVipDmByPairStatement = database.prepare(`
    SELECT
      friendship_id,
      requester_profile_id,
      addressee_profile_id,
      lower_profile_id,
      higher_profile_id,
      updated_at,
      kind
    FROM profile_friendships
    WHERE lower_profile_id = ?
      AND higher_profile_id = ?
      AND status = 'accepted'
      AND kind = 'vip_dm'
    LIMIT 1;
  `)

  // 'create' частта — status веднага 'accepted' (служебният чат няма pending
  // stage, PIKABG го започва директно), защитено допълнително от партичния
  // unique index idx_profile_friendships_pika_support_pair (race safety).
  const insertPikaSupportConversationStatement = database.prepare(`
    INSERT INTO profile_friendships (
      friendship_id,
      requester_profile_id,
      addressee_profile_id,
      lower_profile_id,
      higher_profile_id,
      status,
      kind,
      responded_at
    ) VALUES (?, ?, ?, ?, ?, 'accepted', 'pika_support', CURRENT_TIMESTAMP);
  `)

  const insertVipDmConversationStatement = database.prepare(`
    INSERT INTO profile_friendships (
      friendship_id,
      requester_profile_id,
      addressee_profile_id,
      lower_profile_id,
      higher_profile_id,
      status,
      kind,
      responded_at
    ) VALUES (?, ?, ?, ?, ?, 'accepted', 'vip_dm', CURRENT_TIMESTAMP);
  `)

  const selectLatestMessageStatement = database.prepare(`
    SELECT
      m.message_id,
      m.friendship_id,
      m.sender_profile_id,
      m.body,
      m.created_at,
      a.storage_filename AS attachment_filename,
      a.width AS attachment_width,
      a.height AS attachment_height,
      a.byte_size AS attachment_byte_size,
      a.content_type AS attachment_content_type
    FROM friend_chat_messages m
    LEFT JOIN friend_chat_attachments a ON a.message_id = m.message_id
    WHERE m.friendship_id = ?
      AND m.deleted_at IS NULL
    ORDER BY m.created_at DESC, m.rowid DESC
    LIMIT 1;
  `)

  const selectMessagesStatement = database.prepare(`
    SELECT
      message_id,
      friendship_id,
      sender_profile_id,
      body,
      created_at,
      attachment_filename,
      attachment_width,
      attachment_height,
      attachment_byte_size,
      attachment_content_type
    FROM (
      SELECT
        m.rowid AS rowid,
        m.message_id,
        m.friendship_id,
        m.sender_profile_id,
        m.body,
        m.created_at,
        a.storage_filename AS attachment_filename,
        a.width AS attachment_width,
        a.height AS attachment_height,
        a.byte_size AS attachment_byte_size,
        a.content_type AS attachment_content_type
      FROM friend_chat_messages m
      LEFT JOIN friend_chat_attachments a ON a.message_id = m.message_id
      WHERE m.friendship_id = ?
        AND m.deleted_at IS NULL
      ORDER BY m.created_at DESC, m.rowid DESC
      LIMIT ?
    )
    ORDER BY created_at ASC, rowid ASC;
  `)

  const selectInsertedMessageStatement = database.prepare(`
    SELECT
      m.rowid AS rowid,
      m.message_id,
      m.friendship_id,
      m.sender_profile_id,
      m.body,
      m.created_at,
      a.storage_filename AS attachment_filename,
      a.width AS attachment_width,
      a.height AS attachment_height,
      a.byte_size AS attachment_byte_size,
      a.content_type AS attachment_content_type
    FROM friend_chat_messages m
    LEFT JOIN friend_chat_attachments a ON a.message_id = m.message_id
    WHERE m.message_id = ?
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

  const insertAttachmentStatement = database.prepare(`
    INSERT INTO friend_chat_attachments (
      message_id,
      storage_filename,
      width,
      height,
      byte_size,
      content_type
    ) VALUES (
      ?,
      ?,
      ?,
      ?,
      ?,
      ?
    );
  `)

  const selectAttachmentForDownloadStatement = database.prepare(`
    SELECT
      a.storage_filename,
      a.content_type
    FROM friend_chat_attachments a
    JOIN friend_chat_messages m ON m.message_id = a.message_id
    WHERE m.friendship_id = ?
      AND a.storage_filename = ?
    LIMIT 1;
  `)

  // Включва и 'failed' редове (не само 'pending') — иначе запис, маркиран
  // failed след transient FS грешка (напр. временно заключен файл), никога
  // повече не би се преоценил и файлът остава завинаги неизтрит. Redим по
  // event_seq (FIFO), за да не гладуват по-стари failed записи зад
  // непрекъснат поток от нови pending записи.
  const selectPendingAttachmentDeletionsStatement = database.prepare(`
    SELECT event_seq, storage_filename
    FROM friend_chat_attachment_deletions
    WHERE cleanup_status IN ('pending', 'failed')
    ORDER BY event_seq ASC
    LIMIT ?;
  `)

  const markAttachmentDeletionStatusStatement = database.prepare(`
    UPDATE friend_chat_attachment_deletions
    SET cleanup_status = ?
    WHERE event_seq = ?;
  `)

  // Завършените (done/failed-retried) записи не се трият автоматично при
  // markAttachmentDeletionDone/Failed — таблицата би растяла неограничено
  // без периодично почистване. Batch purge по created_at, аналогично на
  // lobbyChatStore.purgeOlderThanDays (viz. purgeDeletionEventsBatchStatement).
  const purgeDoneAttachmentDeletionsStatement = database.prepare(`
    DELETE FROM friend_chat_attachment_deletions
    WHERE event_seq IN (
      SELECT event_seq FROM friend_chat_attachment_deletions
      WHERE cleanup_status = 'done' AND created_at < ?
      ORDER BY event_seq ASC
      LIMIT ?
    );
  `)

  const selectAttachmentExistsStatement = database.prepare(`
    SELECT 1 as found
    FROM friend_chat_attachments
    WHERE storage_filename = ?
    LIMIT 1;
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

  // Кои attachment файлове принадлежат на съобщенията, които prune-ът е на
  // път да изтрие (виж pruneOldMessagesStatement по-долу) — изпълнява се
  // ПРЕДИ delete-а, в СЪЩАТА транзакция, за да може deletion-intent записът
  // (insertAttachmentDeletionStatement) никога да не изостане от реалното
  // изтриване на съобщението.
  const selectPrunedAttachmentFilenamesStatement = database.prepare(`
    SELECT a.storage_filename
    FROM friend_chat_attachments a
    WHERE a.message_id IN (
      SELECT message_id
      FROM friend_chat_messages
      WHERE friendship_id = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT -1 OFFSET ?
    );
  `)

  const insertAttachmentDeletionStatement = database.prepare(`
    INSERT INTO friend_chat_attachment_deletions (storage_filename)
    VALUES (?);
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

  // Автоматичното 12-месечно архивиране важи ЕДИНСТВЕНО за служебните
  // pika_support разговори (виж задачата) — обикновените kind='friend'
  // чатове НЕ трябва да изчезват от основния списък по тази функция, дори
  // при дългогодишно мълчание. isConversationArchived винаги връща false
  // за kind='friend', независимо от възрастта на updatedAt.
  function isConversationArchived(kind: string, updatedAtUtc: string): boolean {
    if (kind !== 'pika_support') return false
    const updatedAtMs = new Date(updatedAtUtc).getTime()
    if (!Number.isFinite(updatedAtMs)) return false
    const ageMs = Date.now() - updatedAtMs
    return ageMs > CONVERSATION_ARCHIVE_AFTER_DAYS * 24 * 60 * 60 * 1000
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

    const updatedAt = dbDateToUtc(lastMessageRow?.created_at ?? friendship.updated_at)
    const kind = toConversationKind(friendship.kind)

    if (kind === null) {
      return null
    }

    return {
      friendshipId: friendship.friendship_id,
      friend: friendProfile,
      friendIsPikaTeam: isPikaTeamProfile(friendProfile.profileId),
      lastMessage: lastMessageRow
        ? toMessageSnapshot(lastMessageRow, ownProfileId)
        : null,
      updatedAt,
      unreadCount: getUnreadCount(ownProfileId, friendship.friendship_id),
      kind,
      isArchived: isConversationArchived(kind, updatedAt),
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

  function listConversations(
    profileId: ProfileId,
    onlineProfileIds?: Set<string>,
    includeArchived = false,
  ): ChatConversationSnapshot[] {
    const friendships = selectAcceptedFriendshipsStatement.all(
      profileId,
      profileId,
    ) as FriendshipRow[]

    return friendships
      .map((friendship) => createConversationSnapshot(friendship, profileId, onlineProfileIds))
      .filter((conversation): conversation is ChatConversationSnapshot => {
        return conversation !== null
      })
      .filter((conversation) => includeArchived || !conversation.isArchived)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  // Единственият път служебен pika_support разговор да бъде създаден.
  // Authoritative правила:
  //  1) initiatorProfileId ТРЯБВА да е ИЛИ точно configured official Pika.bg
  //     profileId (legacy единичен profileId, fail-closed ако env var-ът
  //     липсва/е невалиден) ИЛИ isRoleBasedPikaTeamSender===true (route
  //     handler-ът вече е проверил session.account.role==='pika_team' през
  //     isPikaTeamSupportChatSession — виж authStore.ts; store-ът тук не
  //     презаверява role-а, защото не вижда сесии, само получава готовия
  //     server-authoritative флаг). Двата пътя са РАВНОПРАВНИ — не се
  //     изисква role-based sender-ът да съвпада с official profileId.
  //  2) initiator != recipient (без self-chat).
  //  3) recipient трябва да е реален регистриран човешки профил (не guest,
  //     не бот, не изтрит/деактивиран).
  //  4) find-or-create по (lower,higher) двойка + kind='pika_support' —
  //     повторно повикване връща СЪЩИЯ friendship_id (idempotent), никога
  //     дубликат, защитено допълнително от partial unique index-а.
  //     createChatProfilePair(initiatorProfileId, recipientProfileId) е
  //     функция на РЕАЛНИТЕ двата profileId — различни pika_team sender-и
  //     към същия recipient пораждат различни (lower,higher) двойки, значи
  //     отделни conversation redове; НЯМА conversation identity collision
  //     между различни pika_team profileId-та (виж chat authorization
  //     hotfix брифа §4).
  //  5) НЯМА block проверка тук — съществуващо поведение, непроменено
  //     нарочно (виж chat authorization hotfix брифа §3: "запази ги такива,
  //     каквито са в момента" — pika_support исторически bypass-ва и
  //     friendship, и block).
  function getOrCreatePikaSupportConversation(
    initiatorProfileId: ProfileId,
    recipientProfileId: ProfileId,
    isRoleBasedPikaTeamSender: boolean = false,
  ):
    | { ok: true; friendshipId: string; conversation: ChatConversationSnapshot }
    | { ok: false; message: string; code?: ChatStoreErrorCode } {
    const isOfficialPikaProfile = officialPikaProfileId !== null && initiatorProfileId === officialPikaProfileId

    if (!isOfficialPikaProfile && !isRoleBasedPikaTeamSender) {
      return {
        ok: false,
        message: 'Само официалният профил на Pika.bg може да започне този разговор.',
      }
    }

    if (initiatorProfileId === recipientProfileId) {
      return {
        ok: false,
        message: 'Не можеш да започнеш служебен чат със себе си.',
      }
    }

    if (!profileEligibilityChecker.isRegisteredHumanProfile(recipientProfileId)) {
      return {
        ok: false,
        message: 'Играчът не беше намерен.',
      }
    }

    const pair = createChatProfilePair(initiatorProfileId, recipientProfileId)

    const existingRow = selectPikaSupportByPairStatement.get(
      pair.lowerProfileId,
      pair.higherProfileId,
    ) as FriendshipRow | undefined

    let friendship: FriendshipRow | undefined = existingRow

    if (friendship === undefined) {
      try {
        insertPikaSupportConversationStatement.run(
          randomUUID(),
          initiatorProfileId,
          recipientProfileId,
          pair.lowerProfileId,
          pair.higherProfileId,
        )
      } catch {
        // Race: друг едновременен request вече е вкарал реда между нашия
        // SELECT по-горе и този INSERT опит (unique partial index го
        // отхвърли) — очаквано, четем реалния ред по-долу вместо да върнем
        // грешка на потребителя.
      }

      friendship = selectPikaSupportByPairStatement.get(
        pair.lowerProfileId,
        pair.higherProfileId,
      ) as FriendshipRow | undefined
    }

    if (friendship === undefined) {
      return {
        ok: false,
        message: 'Разговорът не беше създаден.',
      }
    }

    const conversation = createConversationSnapshot(friendship, initiatorProfileId)

    if (conversation === null) {
      return {
        ok: false,
        message: 'Разговорът не беше създаден.',
      }
    }

    return {
      ok: true,
      friendshipId: friendship.friendship_id,
      conversation,
    }
  }

  // Споделена основна проверка/lookup логика за vip_dm start пътищата
  // (legacy getOrCreateVipDmConversation И атомарния startVipDmConversationWithMessage).
  // НЕ отваря собствена BEGIN/COMMIT — извикващият управлява транзакционната
  // граница, за да няма nested SQLite транзакции (SQLite няма истински nested
  // transactions; вложен BEGIN върху вече отворена транзакция е грешка).
  //
  // allowCreate=false (legacy /vip-dm/start без съобщение, виж §3 в task spec-а):
  // ако разговорът НЕ съществува, НЕ INSERT-ва нов ред — връща
  // code='message_required', за да спре да pollute-ва DB с празни vip_dm.
  // allowCreate=true (атомарния start-with-message path): при липса на
  // съществуващ ред, INSERT-ва нов, вътре в извикващата транзакция.
  function resolveVipDmFriendshipRow(
    senderProfileId: ProfileId,
    recipientProfileId: ProfileId,
    allowCreate: boolean,
  ):
    | { ok: true; friendship: FriendshipRow }
    | { ok: false; message: string; code?: ChatStoreErrorCode } {
    if (senderProfileId === recipientProfileId) {
      return {
        ok: false,
        code: 'self',
        message: 'Не можеш да започнеш личен разговор със себе си.',
      }
    }

    if (!profileEligibilityChecker.isRegisteredHumanProfile(recipientProfileId)) {
      return {
        ok: false,
        code: 'recipient_not_found',
        message: 'Играчът не беше намерен.',
      }
    }

    if (
      blockChecker.isBlocked(senderProfileId, recipientProfileId)
      || blockChecker.isBlocked(recipientProfileId, senderProfileId)
    ) {
      return {
        ok: false,
        code: 'blocked',
        message: 'Чатът е недостъпен поради блокиране.',
      }
    }

    const pair = createChatProfilePair(senderProfileId, recipientProfileId)

    const existingVipDm = selectVipDmByPairStatement.get(
      pair.lowerProfileId,
      pair.higherProfileId,
    ) as FriendshipRow | undefined

    if (existingVipDm !== undefined) {
      return { ok: true, friendship: existingVipDm }
    }

    if (!allowCreate) {
      return {
        ok: false,
        code: 'message_required',
        message: 'Изпрати първо съобщение, за да започнеш този разговор.',
      }
    }

    if (vipStatusChecker === null || !vipStatusChecker.isActiveVip(senderProfileId)) {
      return {
        ok: false,
        code: 'vip_required',
        message: 'Необходим е активен VIP, за да започнеш този разговор.',
      }
    }

    if (!vipStatusChecker.isActiveVip(recipientProfileId)) {
      return {
        ok: false,
        code: 'vip_counterpart_required',
        message: 'Получателят трябва да има активен VIP.',
      }
    }

    try {
      insertVipDmConversationStatement.run(
        randomUUID(),
        senderProfileId,
        recipientProfileId,
        pair.lowerProfileId,
        pair.higherProfileId,
      )
    } catch {
      // Another writer may have won the partial unique index race — re-select below.
    }

    const friendship = selectVipDmByPairStatement.get(
      pair.lowerProfileId,
      pair.higherProfileId,
    ) as FriendshipRow | undefined

    if (friendship === undefined) {
      return {
        ok: false,
        code: 'conversation_not_found',
        message: 'Разговорът не беше създаден.',
      }
    }

    return { ok: true, friendship }
  }

  // Legacy entry point — вика се от POST /api/chat/vip-dm/start (без
  // съобщение). От fix-а насам НЕ създава нов празен vip_dm ред (виж §3 в
  // task spec-а): allowCreate=false, за да предотврати стари/некеширани
  // клиенти да продължават да pollute-ват DB с празни разговори. Ако
  // разговорът вече съществува (canonical, с поне 1 съобщение или стар
  // legacy ред), просто го връща.
  function getOrCreateVipDmConversation(
    senderProfileId: ProfileId,
    recipientProfileId: ProfileId,
  ):
    | { ok: true; friendshipId: string; conversation: ChatConversationSnapshot }
    | { ok: false; message: string; code?: ChatStoreErrorCode } {
    database.exec('BEGIN IMMEDIATE;')
    let resolved: ReturnType<typeof resolveVipDmFriendshipRow>
    try {
      resolved = resolveVipDmFriendshipRow(senderProfileId, recipientProfileId, false)
      database.exec('COMMIT;')
    } catch (error) {
      try {
        database.exec('ROLLBACK;')
      } catch {
        // Keep the original error visible.
      }
      throw error
    }

    if (!resolved.ok) {
      return resolved
    }

    const conversation = createConversationSnapshot(resolved.friendship, senderProfileId)
    if (conversation === null) {
      return {
        ok: false,
        code: 'invalid_conversation_kind',
        message: 'Разговорът не може да бъде отворен.',
      }
    }

    return {
      ok: true,
      friendshipId: resolved.friendship.friendship_id,
      conversation,
    }
  }

  // Атомарен start+send: get-or-create vip_dm + insert на ПЪРВОТО съобщение
  // в ЕДНА SQLite транзакция (виж §5 в task spec-а). Ако insert-ът на
  // съобщението се провали, ROLLBACK анулира и новосъздадения vip_dm ред —
  // никога не остава persistent conversation без съобщение от този path.
  // Attachment файлът (ако има) вече е записан на диска ОТ ИЗВИКВАЩИЯ преди
  // тази функция (виж index.ts handler-а) — тук само DB редовете; при
  // rollback извикващият трие orphan файла (същия established pattern като
  // обикновения POST /api/chat/:friendshipId/messages).
  function startVipDmConversationWithMessage(
    senderProfileId: ProfileId,
    recipientProfileId: ProfileId,
    body: string,
    attachment: NewChatAttachmentInput | null = null,
  ):
    | {
        ok: true
        conversation: ChatConversationSnapshot
        messages: ChatMessageSnapshot[]
        newMessage: ChatMessageSnapshot
      }
    | { ok: false; message: string; code?: ChatStoreErrorCode } {
    const normalizedBody = normalizeMessageBody(body)

    if (normalizedBody === null) {
      return {
        ok: false,
        message: 'Съобщението трябва да е до 1000 символа.',
      }
    }

    if (normalizedBody.length === 0 && attachment === null) {
      return {
        ok: false,
        message: 'Съобщението трябва да съдържа текст или снимка.',
      }
    }

    const messageId = randomUUID()
    let friendshipId: string | undefined
    let insertedRow: ChatMessageRow | undefined

    database.exec('BEGIN IMMEDIATE;')
    try {
      const resolved = resolveVipDmFriendshipRow(senderProfileId, recipientProfileId, true)

      if (!resolved.ok) {
        database.exec('COMMIT;')
        return resolved
      }

      friendshipId = resolved.friendship.friendship_id

      insertMessageStatement.run(messageId, friendshipId, senderProfileId, normalizedBody)

      if (attachment !== null) {
        insertAttachmentStatement.run(
          messageId,
          attachment.storageFilename,
          attachment.width,
          attachment.height,
          attachment.byteSize,
          attachment.contentType,
        )
      }

      insertedRow = selectInsertedMessageStatement.get(messageId) as ChatMessageRow | undefined
      touchFriendshipStatement.run(friendshipId)
      upsertReadStatement.run(senderProfileId, friendshipId)

      database.exec('COMMIT;')
    } catch (error) {
      try {
        database.exec('ROLLBACK;')
      } catch {
        // Keep the original write failure visible to the caller.
      }
      throw error
    }

    if (friendshipId === undefined || insertedRow === undefined) {
      return {
        ok: false,
        message: 'Съобщението не беше записано.',
      }
    }

    const friendshipRow = selectAcceptedFriendshipStatement.get(
      friendshipId,
      senderProfileId,
      senderProfileId,
    ) as FriendshipRow | undefined
    const conversation = friendshipRow !== undefined
      ? createConversationSnapshot(friendshipRow, senderProfileId)
      : null
    const messagesResult = listMessages(senderProfileId, friendshipId)

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
      newMessage: toMessageSnapshot(insertedRow, senderProfileId),
    }
  }

  function authorizeSendMessage(
    profileId: ProfileId,
    friendshipId: string,
  ):
    | { ok: true; friendship: FriendshipRow; recipientProfileId: ProfileId }
    | { ok: false; message: string; code?: ChatStoreErrorCode } {
    const friendship = getAcceptedFriendship(profileId, friendshipId)

    if (friendship === null) {
      return {
        ok: false,
        code: 'conversation_not_found',
        message: 'Чатът е недостъпен.',
      }
    }

    const kind = toConversationKind(friendship.kind)
    if (kind === null) {
      return {
        ok: false,
        code: 'invalid_conversation_kind',
        message: 'Чатът е с невалиден тип.',
      }
    }

    const recipientProfileId = getFriendProfileId(friendship, profileId)

    if (
      blockChecker.isBlocked(profileId, recipientProfileId)
      || blockChecker.isBlocked(recipientProfileId, profileId)
    ) {
      return {
        ok: false,
        code: 'blocked',
        message: 'Чатът е недостъпен поради блокиране.',
      }
    }

    if (kind === 'vip_dm') {
      if (vipStatusChecker === null || !vipStatusChecker.isActiveVip(profileId)) {
        return {
          ok: false,
          code: 'vip_required',
          message: 'Необходим е активен VIP, за да изпратиш съобщение.',
        }
      }
      if (!vipStatusChecker.isActiveVip(recipientProfileId)) {
        return {
          ok: false,
          code: 'vip_counterpart_required',
          message: 'Получателят трябва да има активен VIP.',
        }
      }
    }

    return { ok: true, friendship, recipientProfileId }
  }

  function canSendMessage(
    profileId: ProfileId,
    friendshipId: string,
  ): { ok: true } | { ok: false; message: string; code?: ChatStoreErrorCode } {
    const authorization = authorizeSendMessage(profileId, friendshipId)
    if (!authorization.ok) return authorization
    return { ok: true }
  }

  function listMessages(
    profileId: ProfileId,
    friendshipId: string,
  ):
    | { ok: true; messages: ChatMessageSnapshot[] }
    | { ok: false; message: string; code?: ChatStoreErrorCode } {
    const friendship = getAcceptedFriendship(profileId, friendshipId)

    if (friendship === null) {
      return {
        ok: false,
        message: 'Чатът е достъпен само между приятели.',
      }
    }

    if (toConversationKind(friendship.kind) === null) {
      return {
        ok: false,
        code: 'invalid_conversation_kind',
        message: 'Chat has an invalid conversation kind.',
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
    attachment: NewChatAttachmentInput | null = null,
  ):
    | {
        ok: true
        conversation: ChatConversationSnapshot
        messages: ChatMessageSnapshot[]
        newMessage: ChatMessageSnapshot
      }
    | { ok: false; message: string; code?: ChatStoreErrorCode } {
    const authorization = authorizeSendMessage(profileId, friendshipId)

    if (!authorization.ok) {
      return authorization
    }

    const friendship = authorization.friendship

    if (friendship === null) {
      return {
        ok: false,
        message: 'Чатът е достъпен само между приятели.',
      }
    }

    const recipientProfileId = getFriendProfileId(friendship, profileId)

    // Блокиране в която и да е посока спира изпращането на НОВИ съобщения
    // (текст или снимка) — историческите съобщения остават непроменени и
    // видими (виж listMessages, който НЕ guard-ва с blockChecker).
    if (
      blockChecker.isBlocked(profileId, recipientProfileId)
      || blockChecker.isBlocked(recipientProfileId, profileId)
    ) {
      return {
        ok: false,
        message: 'Чатът е недостъпен поради блокиране.',
      }
    }

    const normalizedBody = normalizeMessageBody(body)

    if (normalizedBody === null) {
      return {
        ok: false,
        message: 'Съобщението трябва да е до 1000 символа.',
      }
    }

    if (normalizedBody.length === 0 && attachment === null) {
      return {
        ok: false,
        message: 'Съобщението трябва да съдържа текст или снимка.',
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

      if (attachment !== null) {
        insertAttachmentStatement.run(
          messageId,
          attachment.storageFilename,
          attachment.width,
          attachment.height,
          attachment.byteSize,
          attachment.contentType,
        )
      }

      insertedRow = selectInsertedMessageStatement.get(messageId) as ChatMessageRow | undefined
      touchFriendshipStatement.run(friendshipId)
      upsertReadStatement.run(profileId, friendshipId)

      // Deletion-intent ПРЕДИ delete-а, в същата транзакция — виж коментара
      // до selectPrunedAttachmentFilenamesStatement по-горе.
      const prunedAttachmentRows = selectPrunedAttachmentFilenamesStatement.all(
        friendshipId,
        PERSONAL_CHAT_STORAGE_LIMIT,
      ) as { storage_filename: string }[]

      for (const prunedRow of prunedAttachmentRows) {
        insertAttachmentDeletionStatement.run(prunedRow.storage_filename)
      }

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
        message: 'Съобщението не беше записано.',
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

  // Огледално на isFirstUnreadMessage, но за извикване СЛЕД insert-а — за
  // startVipDmConversationWithMessage, където friendshipId не е известен
  // ПРЕДИ атомарната транзакция (get-or-create се случва вътре в нея), значи
  // isFirstUnreadMessage (която изисква извикване преди insert) не може да
  // се приложи директно. Вярно само когато току-що вмъкнатото съобщение е
  // ЕДИНСТВЕНОТО непрочетено — т.е. или разговорът е чисто нов, или
  // получателят вече е бил "up to date" преди това съобщение.
  function isFirstUnreadMessageAfterInsert(recipientProfileId: ProfileId, friendshipId: string): boolean {
    return getUnreadCount(recipientProfileId, friendshipId) === 1
  }

  // Guard за защитения view/download endpoint (index.ts handleChatAttachmentRequest):
  // изисква профилът да участва в accepted friendship-а (същия стандарт като
  // listMessages/sendMessage) И attachment записът действително да принадлежи
  // на съобщение от ТОЗИ friendship — предотвратява enumeration на чужди
  // снимки чрез познат UUID.webp filename при друг friendshipId.
  function getAttachmentForDownload(
    profileId: ProfileId,
    friendshipId: string,
    storageFilename: string,
  ): { storageFilename: string; contentType: string } | null {
    const friendship = getAcceptedFriendship(profileId, friendshipId)

    if (friendship === null) {
      return null
    }

    const row = selectAttachmentForDownloadStatement.get(
      friendshipId,
      storageFilename,
    ) as { storage_filename: string; content_type: string } | undefined

    if (row === undefined) {
      return null
    }

    return { storageFilename: row.storage_filename, contentType: row.content_type }
  }

  function listPendingAttachmentDeletions(limit: number): { eventSeq: number; storageFilename: string }[] {
    const rows = selectPendingAttachmentDeletionsStatement.all(limit) as {
      event_seq: number
      storage_filename: string
    }[]

    return rows.map((row) => ({ eventSeq: row.event_seq, storageFilename: row.storage_filename }))
  }

  function markAttachmentDeletionDone(eventSeq: number): void {
    markAttachmentDeletionStatusStatement.run('done', eventSeq)
  }

  function markAttachmentDeletionFailed(eventSeq: number): void {
    markAttachmentDeletionStatusStatement.run('failed', eventSeq)
  }

  function attachmentExistsForFilename(storageFilename: string): boolean {
    return selectAttachmentExistsStatement.get(storageFilename) !== undefined
  }

  function purgeDoneAttachmentDeletions(olderThanDays: number, batchSize: number): number {
    const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString()
    let totalDeleted = 0

    for (;;) {
      const result = purgeDoneAttachmentDeletionsStatement.run(cutoff, batchSize) as { changes?: number }
      const changes = result.changes ?? 0
      totalDeleted += changes
      if (changes < batchSize) break
    }

    return totalDeleted
  }

  function close(): void {
    database.close()
  }

  return {
    listConversations,
    getOrCreatePikaSupportConversation,
    getOrCreateVipDmConversation,
    startVipDmConversationWithMessage,
    canSendMessage,
    listMessages,
    sendMessage,
    markConversationRead,
    isFirstUnreadMessage,
    isFirstUnreadMessageAfterInsert,
    getAttachmentForDownload,
    listPendingAttachmentDeletions,
    markAttachmentDeletionDone,
    markAttachmentDeletionFailed,
    attachmentExistsForFilename,
    purgeDoneAttachmentDeletions,
    close,
  }
}
