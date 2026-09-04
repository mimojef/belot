import { randomUUID } from 'node:crypto'
import type {
  PlayerPublicProfileSnapshot,
  ProfileId,
} from '../core/serverTypes.js'
import type { PlayerProgressStore } from './playerProgressStore.js'
import { dbDateToUtc } from './dbDate.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export type FriendshipStatus = 'pending' | 'accepted'
export type FriendshipDirection = 'incoming' | 'outgoing' | 'accepted'

// 90-дневен retention прозорец за unfriended-but-retained разговори (виж
// removeRelationship/runRetentionCleanup по-долу) — броено от последния
// removed_at timestamp, НЕ от оригиналния friendship created_at (unfriend ->
// re-friend -> unfriend отново задава чисто нов 90-дневен deadline, виж §I
// в task spec-а).
export const FRIENDSHIP_RETENTION_DAYS = 90

export type FriendRelationshipSnapshot = {
  friendshipId: string
  status: FriendshipStatus
  direction: FriendshipDirection
  profile: PlayerPublicProfileSnapshot
  createdAt: string
  updatedAt: string
}

export type FriendshipsSnapshot = {
  incomingPending: FriendRelationshipSnapshot[]
  outgoingPending: FriendRelationshipSnapshot[]
  friends: FriendRelationshipSnapshot[]
}

export type UnreadAcceptanceNotification = {
  friendshipId: string
  friendProfile: PlayerPublicProfileSnapshot
}

export type MarkAcceptanceReadResult =
  | { ok: true; status: 'marked' }
  | { ok: true; status: 'already_read' }
  | { ok: false; reason: 'invalid_id' }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'forbidden' }
  | { ok: false; reason: 'wrong_status' }

export type FriendshipStore = {
  // Реюзвана и от chatStore.getOrCreatePikaSupportConversation — единственото
  // място извън friendshipStore, което трябва да знае дали recipientProfileId
  // е реален, активен, човешки профил С акаунт (не guest/бот/деактивиран),
  // без да дублира собствена SQL заявка към profiles таблицата.
  isRegisteredHumanProfile: (profileId: ProfileId) => boolean
  listForProfile: (profileId: ProfileId) => FriendshipsSnapshot
  getUnreadAcceptances: (requesterProfileId: ProfileId) => UnreadAcceptanceNotification[]
  markAcceptanceRead: (
    requesterProfileId: ProfileId,
    friendshipId: string,
  ) => MarkAcceptanceReadResult
  sendRequest: (
    requesterProfileId: ProfileId,
    addresseeProfileId: ProfileId,
  ) =>
    | { ok: true; friendships: FriendshipsSnapshot; friendshipId: string }
    | { ok: false; message: string }
  acceptRequest: (
    profileId: ProfileId,
    friendshipId: string,
  ) =>
    | { ok: true; friendships: FriendshipsSnapshot; requesterProfileId: ProfileId | null }
    | { ok: false; message: string }
  rejectRequest: (
    profileId: ProfileId,
    friendshipId: string,
  ) =>
    | { ok: true; friendships: FriendshipsSnapshot; requesterProfileId: ProfileId | null }
    | { ok: false; message: string }
  cancelRequest: (
    profileId: ProfileId,
    friendshipId: string,
  ) =>
    | { ok: true; friendships: FriendshipsSnapshot; addresseeProfileId: ProfileId }
    | { ok: false; message: string }
  removeRelationship: (
    profileId: ProfileId,
    friendshipId: string,
  ) =>
    | { ok: true; friendships: FriendshipsSnapshot }
    | { ok: false; message: string }
  /**
   * Bounded background job primitive (виж index.ts's runFriendshipRetentionCleanup,
   * mirror на lobbyChatStore.purgeOlderThanDays interval pattern). Обхваща ДВЕ
   * lifecycle категории с активен retention deadline (removed_at != NULL):
   *
   *  - status='removed' (unfriended, никога re-friend-нат отново) -> hard-delete-ва
   *    ЦЕЛИЯ relationship row (kind='friend'), чийто removed_at е поне
   *    FRIENDSHIP_RETENTION_DAYS дни в миналото. Enqueue-ва attachment filenames
   *    в friend_chat_attachment_deletions ПРЕДИ destructive delete-а, в СЪЩАТА
   *    транзакция.
   *  - status='pending' (re-friend request изпратен, но НЕ accept-нат до
   *    expiration — виж sendRequest/reactivateFriendshipStatement doc коментара:
   *    само реален accept, не самото изпращане на request, чисти removed_at) ->
   *    трие САМО retained chat history-то (friend_chat_messages/attachments),
   *    оставя pending request реда жив, clear-ва removed_at (историята вече е
   *    "приключила", request-ът старва fresh conversation при бъдещ accept).
   *
   * status='accepted' никога не участва — acceptRequest винаги нулира
   * removed_at на успешен accept. Race-safe: всеки candidate се re-check-ва
   * (authoritative WHERE clause, съответно за removed/pending) ВЪТРЕ в своята
   * собствена BEGIN IMMEDIATE транзакция непосредствено преди destructive-а —
   * ако точно между SELECT candidates и delete-а статусът/removed_at вече са
   * се променили (re-friend accept, late accept guard в acceptRequest), UPDATE/
   * DELETE-ът връща 0 changes и candidate-ът се прескача непокътнат.
   */
  runRetentionCleanup: (batchSize: number) => {
    deletedFriendships: number
    clearedPendingHistories: number
  }
  close: () => void
}

type FriendshipRow = {
  friendship_id: string
  requester_profile_id: string
  addressee_profile_id: string
  status: string
  created_at: string
  updated_at: string
}

// Naive UTC "YYYY-MM-DD HH:MM:SS" cutoff (СЪЩИЯТ формат като CURRENT_TIMESTAMP
// и removed_at), за да е директно string-comparable в SQL. Единен computation
// point за "кога изтича retention-ът точно СЕГА" — ползван и от acceptRequest
// (late-accept authoritative re-check) и от runRetentionCleanup (batch
// discovery + per-candidate re-check), за да няма drift между двата пътя.
function retentionCutoffNow(): string {
  return new Date(Date.now() - FRIENDSHIP_RETENTION_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace('T', ' ')
    .replace('Z', '')
}

function createProfilePair(
  leftProfileId: ProfileId,
  rightProfileId: ProfileId,
): { lowerProfileId: ProfileId; higherProfileId: ProfileId } {
  return leftProfileId.localeCompare(rightProfileId, 'en') <= 0
    ? {
        lowerProfileId: leftProfileId,
        higherProfileId: rightProfileId,
      }
    : {
        lowerProfileId: rightProfileId,
        higherProfileId: leftProfileId,
      }
}

function createEmptyFriendshipsSnapshot(): FriendshipsSnapshot {
  return {
    incomingPending: [],
    outgoingPending: [],
    friends: [],
  }
}

function getFriendshipDirection(
  row: FriendshipRow,
  ownProfileId: ProfileId,
): FriendshipDirection {
  if (row.status === 'accepted') {
    return 'accepted'
  }

  return row.addressee_profile_id === ownProfileId ? 'incoming' : 'outgoing'
}

function getCounterpartProfileId(
  row: FriendshipRow,
  ownProfileId: ProfileId,
): ProfileId {
  return row.requester_profile_id === ownProfileId
    ? row.addressee_profile_id
    : row.requester_profile_id
}

function toRelationshipSnapshot(input: {
  row: FriendshipRow
  ownProfileId: ProfileId
  profile: PlayerPublicProfileSnapshot
}): FriendRelationshipSnapshot {
  return {
    friendshipId: input.row.friendship_id,
    status: input.row.status as FriendshipStatus,
    direction: getFriendshipDirection(input.row, input.ownProfileId),
    profile: input.profile,
    createdAt: dbDateToUtc(input.row.created_at),
    updatedAt: dbDateToUtc(input.row.updated_at),
  }
}

export async function createFriendshipStore(
  databaseFilePath: string,
  playerProgressStore: PlayerProgressStore,
): Promise<FriendshipStore> {
  const sqliteModule = await import('node:sqlite')
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })

  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')

  const selectRegisteredHumanProfileStatement = database.prepare(`
    SELECT profile_id
    FROM profiles
    WHERE profile_id = ?
      AND profile_kind = 'human'
      AND status = 'active'
      AND account_id IS NOT NULL
    LIMIT 1;
  `)

  // 'kind = friend' на всяка заявка по-долу изолира истинските приятелски
  // редове от служебните pika_support разговори (виж chatStore.ts /
  // getOrCreatePikaSupportConversation) — служебният чат НЕ трябва да се
  // появява в incoming/outgoing/friends списъците, нито да участва в
  // send/accept/reject/cancel/remove friend request потока.
  //
  // selectFriendshipByPairStatement НАРОЧНО включва status='removed' редове
  // (изключва само 'blocked') — sendRequest по-долу разчита на нея, за да
  // намери retained (unfriended, still-in-90-day-window) relationship и да
  // го reactivate-не (reuse на СЪЩИЯ friendship_id/history), вместо да опита
  // INSERT нов ред и да гръмне idx_profile_friendships_friend_pair partial
  // UNIQUE index-а (той пази по (lower,higher) за kind='friend' независимо
  // от status).
  const selectFriendshipByPairStatement = database.prepare(`
    SELECT
      friendship_id,
      requester_profile_id,
      addressee_profile_id,
      status,
      created_at,
      updated_at
    FROM profile_friendships
    WHERE lower_profile_id = ?
      AND higher_profile_id = ?
      AND status != 'blocked'
      AND kind = 'friend'
    LIMIT 1;
  `)

  // За разлика от горната — тук 'removed' СЕ изключва изрично.
  // selectFriendshipsForProfileStatement захранва listForProfile
  // (incoming/outgoing/friends UI списъка) — retained-but-unfriended
  // разговор не трябва да се показва там като active relationship нито в
  // едната, нито в другата посока.
  const selectFriendshipsForProfileStatement = database.prepare(`
    SELECT
      friendship_id,
      requester_profile_id,
      addressee_profile_id,
      status,
      created_at,
      updated_at
    FROM profile_friendships
    WHERE (requester_profile_id = ? OR addressee_profile_id = ?)
      AND status NOT IN ('blocked', 'removed')
      AND kind = 'friend'
    ORDER BY updated_at DESC, created_at DESC;
  `)

  const insertFriendshipStatement = database.prepare(`
    INSERT INTO profile_friendships (
      friendship_id,
      requester_profile_id,
      addressee_profile_id,
      lower_profile_id,
      higher_profile_id,
      status,
      kind
    ) VALUES (?, ?, ?, ?, ?, 'pending', 'friend');
  `)

  // Reactivation на retained (status='removed', still-in-90-day-window)
  // relationship — виж sendRequest по-долу. Reuse-ва СЪЩИЯ friendship_id
  // (и оттам СЪЩАТА friend_chat_messages/friend_chat_attachments история,
  // тъй като FK-то е на friendship_id, не се пипа тук). requester/addressee
  // се пренаписват на новата purpose (кой точно е изпратил новата покана
  // сега може да е различен от оригиналния requester) — responded_at се
  // нулира, защото цикълът минава отново през pending -> acceptRequest.
  //
  // removed_at НАРОЧНО НЕ се пипа тук (edge case fix — виж task follow-up):
  // самото изпращане на нов friend request НЕ отменя retention deadline-а,
  // само реален ACCEPT прави това (виж acceptFriendshipStatement/
  // acceptRequest по-долу). Ако request-ът никога не бъде accept-нат до
  // изтичане на оригиналния removed_at, runRetentionCleanup трябва пак да
  // hard-delete-не старата chat history, докато самият pending request ред
  // остава жив (виж runRetentionCleanup doc коментара).
  const reactivateFriendshipStatement = database.prepare(`
    UPDATE profile_friendships
    SET
      requester_profile_id = ?,
      addressee_profile_id = ?,
      status = 'pending',
      responded_at = NULL,
      requester_acceptance_read_at = NULL,
      updated_at = CURRENT_TIMESTAMP
    WHERE friendship_id = ?
      AND status = 'removed'
      AND kind = 'friend';
  `)

  // Accept — работи еднакво за normal pending request (removed_at вече NULL,
  // SET removed_at=NULL е no-op) И за retained-but-still-within-window
  // re-friend request (§3 в task follow-up-а: реален accept ПРЕДИ expiration
  // окончателно отменя retention deadline-а, запазвайки старата history
  // непокътната). Виж acceptRequest за authoritative removed_at expiry
  // re-check-а, който решава дали history-то трябва да се cleanup-не ПРЕДИ
  // този statement (late-accept guard).
  const acceptFriendshipClearingRetentionStatement = database.prepare(`
    UPDATE profile_friendships
    SET
      status = 'accepted',
      removed_at = NULL,
      updated_at = CURRENT_TIMESTAMP,
      responded_at = CURRENT_TIMESTAMP
    WHERE friendship_id = ?
      AND addressee_profile_id = ?
      AND status = 'pending'
      AND kind = 'friend';
  `)

  // Обикновен, никога-unfriend-нат pending request (removed_at IS NULL) —
  // reject/cancel-ват го чрез истинско DELETE, както досега.
  const deletePendingFriendshipStatement = database.prepare(`
    DELETE FROM profile_friendships
    WHERE friendship_id = ?
      AND addressee_profile_id = ?
      AND status = 'pending'
      AND kind = 'friend'
      AND removed_at IS NULL;
  `)

  // Reject/cancel на RETAINED re-friend request (removed_at != NULL) — НЕ
  // DELETE-ва реда (би загубил retained history без enqueue, symmetric на
  // оригиналния unfriend bug), вместо това връща relationship-а обратно в
  // status='removed', запазвайки СЪЩИЯ removed_at (оригиналният unfriend
  // timestamp, НЕ reset). History-то остава retained до естествения си
  // 90-дневен deadline — runRetentionCleanup ще го обработи нормално по-късно.
  const revertRejectedRetainedFriendshipStatement = database.prepare(`
    UPDATE profile_friendships
    SET
      status = 'removed',
      updated_at = CURRENT_TIMESTAMP
    WHERE friendship_id = ?
      AND addressee_profile_id = ?
      AND status = 'pending'
      AND kind = 'friend'
      AND removed_at IS NOT NULL;
  `)

  const selectOutgoingPendingFriendshipStatement = database.prepare(`
    SELECT
      friendship_id,
      requester_profile_id,
      addressee_profile_id,
      status,
      created_at,
      updated_at
    FROM profile_friendships
    WHERE friendship_id = ?
      AND requester_profile_id = ?
      AND status = 'pending'
      AND kind = 'friend'
    LIMIT 1;
  `)

  // Обикновен, никога-unfriend-нат outgoing pending request (removed_at IS
  // NULL) — cancel-ва го чрез истинско DELETE, както досега.
  const deleteOutgoingPendingFriendshipStatement = database.prepare(`
    DELETE FROM profile_friendships
    WHERE friendship_id = ?
      AND requester_profile_id = ?
      AND status = 'pending'
      AND kind = 'friend'
      AND removed_at IS NULL;
  `)

  // Cancel на RETAINED outgoing re-friend request (removed_at != NULL) — виж
  // revertRejectedRetainedFriendshipStatement doc коментара по-горе, същия
  // принцип, само за requester страната: връща реда в status='removed',
  // запазва оригиналния removed_at, НЕ трие history-то тук.
  const revertCancelledRetainedFriendshipStatement = database.prepare(`
    UPDATE profile_friendships
    SET
      status = 'removed',
      updated_at = CURRENT_TIMESTAMP
    WHERE friendship_id = ?
      AND requester_profile_id = ?
      AND status = 'pending'
      AND kind = 'friend'
      AND removed_at IS NOT NULL;
  `)

  // Normal unfriend е СЕГА non-destructive soft-state transition (product
  // retention изискване, виж runRetentionCleanup doc коментара) — status ->
  // 'removed' + removed_at timestamp anchor, вместо DELETE. Ефектът върху
  // видимост/authorization е автоматичен, БЕЗ да пипаме нито ред extra guard
  // логика: chatStore.selectAcceptedFriendshipsStatement/
  // selectAcceptedFriendshipStatement изискват status='accepted' (изчезва от
  // chat list + send блокиран), selectFriendshipsForProfileStatement по-горе
  // изрично изключва 'removed' (изчезва от incoming/outgoing/friends). History
  // (friend_chat_messages/attachments) остава физически непокътната — FK-то е
  // на friendship_id, който тук НЕ се трие.
  const softRemoveAcceptedFriendshipStatement = database.prepare(`
    UPDATE profile_friendships
    SET
      status = 'removed',
      removed_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
    WHERE friendship_id = ?
      AND status = 'accepted'
      AND kind = 'friend'
      AND (
        requester_profile_id = ?
        OR addressee_profile_id = ?
      );
  `)

  // Deletion-intent за attachment файловете на разговора — ползвана САМО от
  // destructive пътищата (runRetentionCleanup по-долу при изтекъл 90-дневен
  // прозорец), НЕ от normal unfriend (softRemoveAcceptedFriendshipStatement
  // по-горе не трие нищо физически). profile_friendships -> friend_chat_messages
  // -> friend_chat_attachments е ON DELETE CASCADE (виж migrations), затова DB
  // редовете иначе биха изчезнали БЕЗ да enqueue-нат storage_filename за
  // физическо изтриване (същия проблем и fix pattern като chatStore.ts's
  // selectPrunedAttachmentFilenamesStatement при >500-message prune).
  // Изпълнява се в СЪЩАТА транзакция като destructive delete-а, за да не
  // изостане queue intent-ът от реалното cascade изтриване.
  const selectFriendshipAttachmentFilenamesStatement = database.prepare(`
    SELECT a.storage_filename
    FROM friend_chat_attachments a
    JOIN friend_chat_messages m ON m.message_id = a.message_id
    WHERE m.friendship_id = ?;
  `)

  const insertAttachmentDeletionStatement = database.prepare(`
    INSERT INTO friend_chat_attachment_deletions (storage_filename)
    VALUES (?);
  `)

  // chat_conversation_reads (profile_id, friendship_id) НЯМА FOREIGN KEY изобщо
  // (виж 20260520_001 migration-а — единствената CREATE TABLE за нея) —
  // read-marker редовете НЕ изчезват автоматично при никакъв cascade. Ползвана
  // САМО от destructive hard-delete пътя на runRetentionCleanup по-долу
  // (status='removed' branch, където profile_friendships реда самия СЕ трие) —
  // НЕ от normal unfriend (softRemoveAcceptedFriendshipStatement по-горе е
  // non-destructive soft-state UPDATE; read-state трябва да оцелее за
  // потенциален re-friend в рамките на 90-дневния прозорец) и НЕ от pending-branch
  // history wipe-а (clearExpiredPendingRetentionStatement/deleteFriendshipMessagesStatement
  // по-долу трият само messages/attachments, но самият friendship_id остава
  // жив pending request — read timestamp-ът пак важи за бъдещи съобщения по
  // същия friendship_id, не е orphan).
  const deleteFriendshipReadsStatement = database.prepare(`
    DELETE FROM chat_conversation_reads WHERE friendship_id = ?;
  `)

  // Chat-history-only destructive cleanup — НЕ трие profile_friendships реда
  // (за разлика от deleteExpiredRetainedFriendshipStatement по-долу). Ползвана
  // от два пътя, и двата "expired retention, но relationship row-ът трябва да
  // оцелее": (1) runRetentionCleanup при status='pending' re-friend request,
  // чийто removed_at е изтекъл преди да бъде accept-нат (виж task follow-up
  // §"НЕ ТРИЙ PENDING FRIEND REQUEST-А"), (2) acceptRequest's late-accept
  // guard — ако accept-ът пристигне СЛЕД expiration, но ПРЕДИ daily cleanup
  // job-а да е минал (race), старата history се cleanup-ва inline тук, вместо
  // late accept-ът да "спаси" retained history отвъд дефинирания deadline.
  // friend_chat_attachments изчезва автоматично чрез ON DELETE CASCADE на
  // message_id, затова само messages се трият explicit.
  const deleteFriendshipMessagesStatement = database.prepare(`
    DELETE FROM friend_chat_messages WHERE friendship_id = ?;
  `)

  // Candidate discovery за runRetentionCleanup по-долу — ДВЕ отделни SELECT-и
  // (не един combined "status IN (...)" query) НАРОЧНО: idx_profile_friendships_removed_at
  // partial index-ът е дефиниран WHERE status='removed' (виж migration-а) —
  // "status IN ('removed','pending')" не е съвместимо с този partial index
  // predicate, SQLite би паднал обратно на idx_profile_friendships_status_updated
  // + TEMP B-TREE sort (потвърдено с EXPLAIN QUERY PLAN).
  //
  // status='removed' SELECT-ът долу носи explicit "INDEXED BY" hint — EXPLAIN
  // QUERY PLAN показа, че БЕЗ hint-а SQLite все пак избира
  // idx_profile_friendships_status_updated дори когато partial index-ът е
  // приложим и по-евтин (index вече подреден по removed_at, елиминира TEMP
  // B-TREE sort-а), защото planner-ът няма runtime cardinality статистика
  // (без ANALYZE) на малка/празна таблица. Hint-ът прави избора детерминистичен,
  // вместо да зависи от production data volume. status='pending' SELECT-ът
  // НЯМА такъв hint — partial index-ът е scoped само за status='removed' по
  // дизайн, structurally неприложим за pending; idx_profile_friendships_status_updated
  // си е единственият relevant index там, с filter/sort по removed_at отгоре.
  //
  // Обхващат ДВА lifecycle-а с активен retention deadline (виж task follow-up):
  //  - status='removed'  -> целият relationship row е кандидат за hard delete
  //  - status='pending'  -> само retained chat history-то е кандидат;
  //    самата pending re-friend request остава (viz. reactivateFriendshipStatement
  //    doc коментара — sendRequest НЕ чисти removed_at при reactivation).
  // status='accepted' никога няма removed_at != NULL (acceptRequest по-долу
  // винаги го нулира на успешен accept), затова не участва тук изобщо.
  // Действителният re-check и destructive операция се случват ВЪТРЕ в
  // собствената транзакция на всеки candidate (race-safety срещу конкурентен
  // accept/re-friend, виж doc коментара на интерфейса по-горе) — тези заявки
  // са read-only и НЕ гарантират, че кандидатът все още е валиден до момента
  // на re-check-а.
  const selectExpiredRemovedFriendshipCandidatesStatement = database.prepare(`
    SELECT friendship_id, status
    FROM profile_friendships INDEXED BY idx_profile_friendships_removed_at
    WHERE status = 'removed'
      AND kind = 'friend'
      AND removed_at IS NOT NULL
      AND removed_at <= ?
    ORDER BY removed_at ASC
    LIMIT ?;
  `)

  const selectExpiredPendingFriendshipCandidatesStatement = database.prepare(`
    SELECT friendship_id, status
    FROM profile_friendships
    WHERE status = 'pending'
      AND kind = 'friend'
      AND removed_at IS NOT NULL
      AND removed_at <= ?
    ORDER BY removed_at ASC
    LIMIT ?;
  `)

  // Race-safe destructive delete за ЕДИН expired status='removed' candidate —
  // WHERE клаузата повтаря authoritative условието (status='removed' AND
  // removed_at<=cutoff) ВЪТРЕ в DELETE-а самия, не само в discovery SELECT-а
  // по-горе. Ако между discovery и тази заявка потребителите са се
  // re-friend-нали (reactivateFriendshipStatement е задал status='pending',
  // removed_at остава same-as-before — виж doc коментара там), статусът вече
  // не е 'removed' и тази заявка засяга 0 реда — cleanup-ът я прескача
  // непокътната, виж runRetentionCleanup.
  const deleteExpiredRetainedFriendshipStatement = database.prepare(`
    DELETE FROM profile_friendships
    WHERE friendship_id = ?
      AND status = 'removed'
      AND kind = 'friend'
      AND removed_at IS NOT NULL
      AND removed_at <= ?;
  `)

  // Race-safe "clear retention, keep the pending request" за ЕДИН expired
  // status='pending' candidate — WHERE клаузата повтаря authoritative
  // условието ВЪТРЕ в UPDATE-а самия. Ако между discovery и тази заявка
  // request-ът вече е бил accept-нат (acceptRequest вече е clear-нал
  // removed_at и сменил status='accepted') ИЛИ отменен/отхвърлен, тази заявка
  // засяга 0 реда — cleanup-ът прескача history delete-а (виж runRetentionCleanup:
  // ако changes=0 тук, се пропуска и attachment/message delete-а за този
  // candidate, за да не изтрие history на вече legitimate-active friendship).
  const clearExpiredPendingRetentionStatement = database.prepare(`
    UPDATE profile_friendships
    SET removed_at = NULL
    WHERE friendship_id = ?
      AND status = 'pending'
      AND kind = 'friend'
      AND removed_at IS NOT NULL
      AND removed_at <= ?;
  `)

  const selectUnreadAcceptancesStatement = database.prepare(`
    SELECT
      friendship_id,
      requester_profile_id,
      addressee_profile_id,
      status,
      created_at,
      updated_at
    FROM profile_friendships
    WHERE requester_profile_id = ?
      AND status = 'accepted'
      AND kind = 'friend'
      AND requester_acceptance_read_at IS NULL
    ORDER BY updated_at DESC;
  `)

  const selectFriendshipForReadStatement = database.prepare(`
    SELECT
      friendship_id,
      requester_profile_id,
      status,
      requester_acceptance_read_at
    FROM profile_friendships
    WHERE friendship_id = ?
      AND kind = 'friend'
    LIMIT 1;
  `)

  const markAcceptanceReadStatement = database.prepare(`
    UPDATE profile_friendships
    SET requester_acceptance_read_at = CURRENT_TIMESTAMP
    WHERE friendship_id = ?
      AND requester_profile_id = ?
      AND status = 'accepted'
      AND kind = 'friend'
      AND requester_acceptance_read_at IS NULL;
  `)

  function isRegisteredHumanProfile(profileId: ProfileId): boolean {
    const row = selectRegisteredHumanProfileStatement.get(profileId) as
      | { profile_id: string }
      | undefined

    return row !== undefined
  }

  function listForProfile(profileId: ProfileId): FriendshipsSnapshot {
    const rows = selectFriendshipsForProfileStatement.all(
      profileId,
      profileId,
    ) as FriendshipRow[]
    const snapshot = createEmptyFriendshipsSnapshot()

    for (const row of rows) {
      const counterpartProfileId = getCounterpartProfileId(row, profileId)
      const profile = playerProgressStore.getPublicProfile(counterpartProfileId)

      if (profile === null) {
        continue
      }

      const relationship = toRelationshipSnapshot({
        row,
        ownProfileId: profileId,
        profile,
      })

      if (relationship.direction === 'incoming') {
        snapshot.incomingPending.push(relationship)
      } else if (relationship.direction === 'outgoing') {
        snapshot.outgoingPending.push(relationship)
      } else {
        snapshot.friends.push(relationship)
      }
    }

    return snapshot
  }

  function getUnreadAcceptances(requesterProfileId: ProfileId): UnreadAcceptanceNotification[] {
    const rows = selectUnreadAcceptancesStatement.all(requesterProfileId) as FriendshipRow[]
    const result: UnreadAcceptanceNotification[] = []

    for (const row of rows) {
      const friendProfileId = row.addressee_profile_id
      const profile = playerProgressStore.getPublicProfile(friendProfileId)
      if (profile === null) continue
      result.push({ friendshipId: row.friendship_id, friendProfile: profile })
    }

    return result
  }

  function markAcceptanceRead(
    requesterProfileId: ProfileId,
    friendshipId: string,
  ): MarkAcceptanceReadResult {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(friendshipId)) {
      return { ok: false, reason: 'invalid_id' }
    }

    const row = selectFriendshipForReadStatement.get(friendshipId) as
      | { friendship_id: string; requester_profile_id: string; status: string; requester_acceptance_read_at: string | null }
      | undefined

    if (row === undefined) {
      return { ok: false, reason: 'not_found' }
    }

    if (row.requester_profile_id !== requesterProfileId) {
      return { ok: false, reason: 'forbidden' }
    }

    if (row.status !== 'accepted') {
      return { ok: false, reason: 'wrong_status' }
    }

    if (row.requester_acceptance_read_at !== null) {
      return { ok: true, status: 'already_read' }
    }

    markAcceptanceReadStatement.run(friendshipId, requesterProfileId)
    return { ok: true, status: 'marked' }
  }

  function sendRequest(
    requesterProfileId: ProfileId,
    addresseeProfileId: ProfileId,
  ):
    | { ok: true; friendships: FriendshipsSnapshot; friendshipId: string }
    | { ok: false; message: string } {
    if (requesterProfileId === addresseeProfileId) {
      return {
        ok: false,
        message: 'Не можеш да изпратиш покана за приятел към себе си.',
      }
    }

    if (!isRegisteredHumanProfile(requesterProfileId)) {
      return {
        ok: false,
        message: 'Трябва да влезеш в профила си.',
      }
    }

    if (!isRegisteredHumanProfile(addresseeProfileId)) {
      return {
        ok: false,
        message: 'Играчът не беше намерен.',
      }
    }

    const pair = createProfilePair(requesterProfileId, addresseeProfileId)
    const existingRow = selectFriendshipByPairStatement.get(
      pair.lowerProfileId,
      pair.higherProfileId,
    ) as FriendshipRow | undefined

    if (existingRow) {
      if (existingRow.status === 'accepted') {
        return {
          ok: false,
          message: 'Вече сте приятели.',
        }
      }

      // Retained (unfriended, still-in-90-day-window) relationship — reuse-ва
      // СЪЩИЯ friendship_id вместо нов INSERT (виж reactivateFriendshipStatement
      // doc коментара по-горе). §E в task spec-а: reversed direction (заявката
      // сега е обратна на оригиналната) не бива да създаде втори duplicate ред
      // — pair lookup-ът е по (lower,higher), независим от посоката.
      //
      // removed_at НЕ се докосва тук (edge case fix) — retention deadline-ът
      // продължава да тече докато request-ът е само pending; само реален
      // accept (acceptFriendshipClearingRetentionStatement) го нулира.
      if (existingRow.status === 'removed') {
        reactivateFriendshipStatement.run(
          requesterProfileId,
          addresseeProfileId,
          existingRow.friendship_id,
        )

        return {
          ok: true,
          friendships: listForProfile(requesterProfileId),
          friendshipId: existingRow.friendship_id,
        }
      }

      if (existingRow.requester_profile_id === requesterProfileId) {
        return {
          ok: false,
          message: 'Поканата вече е изпратена.',
        }
      }

      return {
        ok: false,
        message: 'Този играч вече ти е изпратил покана. Отвори панела с приятели.',
      }
    }

    const newFriendshipId = randomUUID()
    insertFriendshipStatement.run(
      newFriendshipId,
      requesterProfileId,
      addresseeProfileId,
      pair.lowerProfileId,
      pair.higherProfileId,
    )

    return {
      ok: true,
      friendships: listForProfile(requesterProfileId),
      friendshipId: newFriendshipId,
    }
  }

  function acceptRequest(
    profileId: ProfileId,
    friendshipId: string,
  ):
    | { ok: true; friendships: FriendshipsSnapshot; requesterProfileId: ProfileId | null }
    | { ok: false; message: string } {
    database.exec('BEGIN IMMEDIATE;')

    let requesterProfileId: string | null = null
    let changes = 0

    try {
      // Read the row before updating so we know who the requester is AND
      // whether this pending row carries a retention deadline from a prior
      // unfriend (removed_at != NULL, виж reactivateFriendshipStatement doc
      // коментара — sendRequest НЕ чисти removed_at при reactivation).
      const existingRow = (database.prepare(`
        SELECT requester_profile_id, removed_at
        FROM profile_friendships
        WHERE friendship_id = ?
          AND addressee_profile_id = ?
          AND status = 'pending'
          AND kind = 'friend'
        LIMIT 1;
      `).get(friendshipId, profileId)) as { requester_profile_id: string; removed_at: string | null } | undefined

      if (existingRow === undefined) {
        database.exec('ROLLBACK;')
        return {
          ok: false,
          message: 'Поканата не беше намерена или вече е обработена.',
        }
      }

      requesterProfileId = existingRow.requester_profile_id

      // Authoritative expiry re-check ВЪТРЕ в транзакцията — late-accept
      // guard (task follow-up §"ACCEPT RACE / LATE ACCEPT"). Ако removed_at
      // вече е >= FRIENDSHIP_RETENTION_DAYS старо (retention е изтекъл, но
      // daily cleanup job-ът още не е минал), late accept-ът НЕ бива да
      // "спаси" старата history отвъд дефинирания deadline — старата
      // conversation се destructive-clean-ва ТУК, inline, ПРЕДИ accept-а, в
      // СЪЩАТА транзакция, после приятелството започва с празна история.
      // Ако removed_at все още е в прозореца (или е NULL — нормален,
      // never-unfriended pending request), нормалният accept path clear-ва
      // removed_at и запазва историята непокътната.
      const isExpiredRetention =
        existingRow.removed_at !== null && existingRow.removed_at <= retentionCutoffNow()

      if (isExpiredRetention) {
        const attachmentRows = selectFriendshipAttachmentFilenamesStatement.all(
          friendshipId,
        ) as { storage_filename: string }[]

        deleteFriendshipMessagesStatement.run(friendshipId)

        for (const attachmentRow of attachmentRows) {
          insertAttachmentDeletionStatement.run(attachmentRow.storage_filename)
        }
      }

      const result = acceptFriendshipClearingRetentionStatement.run(
        friendshipId,
        profileId,
      ) as { changes?: number }

      changes = result.changes ?? 0

      if (changes === 0) {
        database.exec('ROLLBACK;')
        return {
          ok: false,
          message: 'Поканата не беше намерена или вече е обработена.',
        }
      }

      database.exec('COMMIT;')
    } catch (error) {
      try {
        database.exec('ROLLBACK;')
      } catch {
        // Keep the original write failure visible to the caller.
      }
      throw error
    }

    return {
      ok: true,
      friendships: listForProfile(profileId),
      requesterProfileId,
    }
  }

  function rejectRequest(
    profileId: ProfileId,
    friendshipId: string,
  ):
    | { ok: true; friendships: FriendshipsSnapshot; requesterProfileId: ProfileId | null }
    | { ok: false; message: string } {
    // Read requester before deleting so we can notify them via WS.
    const existingRow = database.prepare(`
      SELECT requester_profile_id
      FROM profile_friendships
      WHERE friendship_id = ?
        AND addressee_profile_id = ?
        AND status = 'pending'
        AND kind = 'friend'
      LIMIT 1;
    `).get(friendshipId, profileId) as { requester_profile_id: string } | undefined

    if (existingRow === undefined) {
      return {
        ok: false,
        message: 'Поканата не беше намерена или вече е обработена.',
      }
    }

    // Нормален (никога-unfriend-нат) pending request -> истинско DELETE. Ако
    // 0 changes, редът може да е RETAINED (removed_at != NULL) — опитваме
    // revert-а вместо DELETE, за да не загубим retention state-а/history-то
    // (виж revertRejectedRetainedFriendshipStatement doc коментара).
    const deleteResult = deletePendingFriendshipStatement.run(
      friendshipId,
      profileId,
    ) as { changes?: number }

    const changes =
      (deleteResult.changes ?? 0) > 0
        ? (deleteResult.changes ?? 0)
        : (revertRejectedRetainedFriendshipStatement.run(friendshipId, profileId) as { changes?: number }).changes ?? 0

    if (changes === 0) {
      return {
        ok: false,
        message: 'Поканата не беше намерена или вече е обработена.',
      }
    }

    return {
      ok: true,
      friendships: listForProfile(profileId),
      requesterProfileId: existingRow.requester_profile_id,
    }
  }

  function cancelRequest(
    profileId: ProfileId,
    friendshipId: string,
  ):
    | { ok: true; friendships: FriendshipsSnapshot; addresseeProfileId: ProfileId }
    | { ok: false; message: string } {
    const row = selectOutgoingPendingFriendshipStatement.get(
      friendshipId,
      profileId,
    ) as FriendshipRow | undefined

    if (row === undefined) {
      return {
        ok: false,
        message: 'Поканата не беше намерена или вече е обработена.',
      }
    }

    // Виж rejectRequest по-горе — същия delete-or-revert избор, само за
    // requester страната (revertCancelledRetainedFriendshipStatement).
    const deleteResult = deleteOutgoingPendingFriendshipStatement.run(
      friendshipId,
      profileId,
    ) as { changes?: number }

    const changes =
      (deleteResult.changes ?? 0) > 0
        ? (deleteResult.changes ?? 0)
        : (revertCancelledRetainedFriendshipStatement.run(friendshipId, profileId) as { changes?: number }).changes ?? 0

    if (changes === 0) {
      return {
        ok: false,
        message: 'Поканата не беше намерена или вече е обработена.',
      }
    }

    return {
      ok: true,
      friendships: listForProfile(profileId),
      addresseeProfileId: row.addressee_profile_id,
    }
  }

  function removeRelationship(
    profileId: ProfileId,
    friendshipId: string,
  ):
    | { ok: true; friendships: FriendshipsSnapshot }
    | { ok: false; message: string } {
    // Единичен UPDATE, атомарен сам по себе си — normal unfriend вече НЕ е
    // destructive (виж softRemoveAcceptedFriendshipStatement doc коментара),
    // затова няма нужда от explicit BEGIN/COMMIT транзакция тук, нито от
    // attachment deletion-intent enqueue (history/attachments остават
    // непокътнати за 90-дневния retention прозорец, виж runRetentionCleanup).
    const result = softRemoveAcceptedFriendshipStatement.run(
      friendshipId,
      profileId,
      profileId,
    ) as { changes?: number }

    if ((result.changes ?? 0) === 0) {
      return {
        ok: false,
        message: 'Приятелството не беше намерено.',
      }
    }

    return {
      ok: true,
      friendships: listForProfile(profileId),
    }
  }

  function runRetentionCleanup(batchSize: number): {
    deletedFriendships: number
    clearedPendingHistories: number
  } {
    const normalizedBatchSize = Number.isInteger(batchSize) && batchSize > 0 ? batchSize : 100
    const cutoff = retentionCutoffNow()

    // Две отделни discovery заявки (виж statement doc коментарите по-горе за
    // защо не е един "status IN (...)" query) — всяка е независима work queue
    // с общия batchSize като per-category cap, не global cap. И двете вече
    // подредени по removed_at ASC (най-просрочените първи в рамките на своята
    // категория).
    const removedCandidates = selectExpiredRemovedFriendshipCandidatesStatement.all(
      cutoff,
      normalizedBatchSize,
    ) as { friendship_id: string; status: string }[]
    const pendingCandidates = selectExpiredPendingFriendshipCandidatesStatement.all(
      cutoff,
      normalizedBatchSize,
    ) as { friendship_id: string; status: string }[]
    const candidates = [...removedCandidates, ...pendingCandidates]

    let deletedFriendships = 0
    let clearedPendingHistories = 0

    for (const candidate of candidates) {
      database.exec('BEGIN IMMEDIATE;')

      try {
        // Attachment filenames трябва да се прочетат ПРЕДИ delete-а по-долу —
        // profile_friendships -> friend_chat_messages -> friend_chat_attachments
        // е ON DELETE CASCADE (removed-branch) / friend_chat_messages ->
        // friend_chat_attachments също е CASCADE (pending-branch), затова
        // редовете изчезват от DB веднага след destructive-а по-долу (СЪЩАТА
        // транзакция).
        const attachmentRows = selectFriendshipAttachmentFilenamesStatement.all(
          candidate.friendship_id,
        ) as { storage_filename: string }[]

        if (candidate.status === 'removed') {
          // Целият relationship row е кандидат — race-safe re-check ВЪТРЕ в
          // транзакцията, непосредствено преди destructive delete-а. Ако
          // relationship-ът е бил reactivate-нат (re-friend, status ->
          // 'pending') между discovery SELECT-а по-горе и този момент, WHERE
          // клаузата (status='removed' AND removed_at<=cutoff) не засяга
          // редове и changes ще е 0.
          const result = deleteExpiredRetainedFriendshipStatement.run(
            candidate.friendship_id,
            cutoff,
          ) as { changes?: number }

          if ((result.changes ?? 0) > 0) {
            for (const attachmentRow of attachmentRows) {
              insertAttachmentDeletionStatement.run(attachmentRow.storage_filename)
            }
            // chat_conversation_reads няма FK — profile_friendships row-ът
            // тъкмо изчезна завинаги (DELETE по-горе), затова read-marker
            // редовете за този friendship_id са orphaned от този момент
            // нататък, ако не ги изтрием explicit тук (виж statement doc
            // коментара по-горе).
            deleteFriendshipReadsStatement.run(candidate.friendship_id)
            deletedFriendships += 1
          }
        } else {
          // status === 'pending' — само retained history-то е кандидат, НЕ
          // самата pending re-friend request (виж task follow-up
          // "НЕ ТРИЙ PENDING FRIEND REQUEST-А"). Race-safe re-check: ако
          // request-ът вече е бил accept-нат (acceptRequest вече е clear-нал
          // removed_at и е cleanup-нал history-то inline при late-accept
          // guard-а си) ИЛИ отменен между discovery и тук, WHERE клаузата
          // (status='pending' AND removed_at<=cutoff) не засяга редове и
          // changes ще е 0 — тогава изобщо не трием нищо (history-то или вече
          // е cleanup-нато, или принадлежи на вече-active friendship).
          const result = clearExpiredPendingRetentionStatement.run(
            candidate.friendship_id,
            cutoff,
          ) as { changes?: number }

          if ((result.changes ?? 0) > 0) {
            deleteFriendshipMessagesStatement.run(candidate.friendship_id)

            for (const attachmentRow of attachmentRows) {
              insertAttachmentDeletionStatement.run(attachmentRow.storage_filename)
            }
            clearedPendingHistories += 1
          }
        }

        database.exec('COMMIT;')
      } catch (error) {
        try {
          database.exec('ROLLBACK;')
        } catch {
          // Keep the original write failure visible to the caller.
        }
        throw error
      }
    }

    return { deletedFriendships, clearedPendingHistories }
  }

  function close(): void {
    database.close()
  }

  return {
    isRegisteredHumanProfile,
    listForProfile,
    getUnreadAcceptances,
    markAcceptanceRead,
    sendRequest,
    acceptRequest,
    rejectRequest,
    cancelRequest,
    removeRelationship,
    runRetentionCleanup,
    close,
  }
}
