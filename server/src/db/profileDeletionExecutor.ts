// Самоизтриване на профили — Етап 4: окончателно изтриване в базата и
// постоянната файлова опашка (DB слой на worker-а, виж
// core/profileDeletionWorker.ts за оркестрацията).
//
// Фази на една заявка (profile_deletion_requests):
//   1. claim      — BEGIN IMMEDIATE; pending с изтекъл срок / blocked или failed
//                   с дошъл next_attempt_at / executing с изтекъл lease ->
//                   executing с lease (SQLite, не in-memory заключване).
//   2. DB фаза    — ЕДНА BEGIN IMMEDIATE транзакция: lease + идентичност
//                   (profile_id, account_id_snapshot, profile_created_at_snapshot)
//                   + защитни проверки; запис на файловете в опашката;
//                   snapshot на финансовата атрибуция; анонимизиране;
//                   DELETE FROM profiles (+ accounts, ако е последният профил);
//                   db_deleted_at. Всичко или нищо.
//   3. файлове    — след COMMIT, по един ред от опашката (собствен lease).
//   4. completed  — тригерът (20261026_001) го позволява само при
//                   db_deleted_at и всички файлове done/skipped_shared.
// Всяка фаза е идемпотентна и продължава след срив (изтекъл lease).
//
// Какво НЕ се трие (виж и коментарите при statement-ите):
//   * финансови регистри — само атрибуцията се snapshot-ва (Stripe/платежни
//     идентификатори, суми, статуси остават непроменени);
//   * историята на турнирите и мачовете — SET NULL + snapshot (UI-ят вече
//     показва "Играч" за липсващ профил);
//   * подаръците на други потребители — gift_item_transactions е SET NULL
//     (20261026_001), името на изпращача в известията се заменя;
//   * support разговорите — виж Етап 4E5 по-долу.
//
// Етап 4E1 (одит P5, одобрени решения):
//   * profile_ip_links / profile_visitor_links (без FK) — редовете на
//     профила се изтриват в същата транзакция; връзките на други профили със
//     същия IP/visitor остават. Нищо не ги пресъздава след това (източниците
//     са site_visit_events.profile_id, който става NULL, и admin snapshot-ите,
//     които самоизтриването не създава);
//   * private_room_matches (team_a_json/team_b_json) — участникът, намерен
//     по ТОЧНО съвпадение на profileId, става { profileId: null,
//     displayName: "Изтрит профил", avatarUrl: null, isBot: false }; мачът,
//     другите участници, резултатите и датите остават;
//   * ludo_room_matches (players_json/winner_profile_id) — participant-ът
//     получава НЕСВЪРЗАН случаен идентификатор ('deleted-' + 32 hex, нов за
//     всеки мач), име "Изтрит профил" и avatarUrl null; winner_profile_id,
//     ако е бил изтрития, става СЪЩИЯТ идентификатор. Така "кой е победил"
//     и всички зависимости остават коректни: кампанийният reconciliation
//     (ludo_win, разгъва players_json и сравнява с winner_profile_id) и
//     архивът продължават да начисляват/броят загубилите, а заместителят не
//     съществува в profiles и се пропуска като ineligible — както досега за
//     изтрит ID. NULL би извадил мача от reconciliation-а изцяло.
//   Невалидна структура на архивен запис с профила = грешка (ROLLBACK), не
//   "успешно" изтриване.
//
// Теми и Лафче (Етап 4B, одобрени решения А1 и Б1) — собствените публикации
// и отговори се изтриват физически (с прикачените файлове):
//   * А1 — topic_messages.parent_message_id е ON DELETE CASCADE, затова ПРЕДИ
//     DELETE FROM profiles всеки чужд пряк наследник на собствено съобщение
//     се пренасочва към най-близкия оцелял (чужд) предшественик, а при липса
//     — става самостоятелна root публикация в същата тема (автор, текст,
//     дати, файлове и харесвания остават). Изтрити (модерирани) чужди
//     съобщения остават изтрити и невидими;
//   * Б1 — тема (topics), създадена от профила, се изтрива ИЗЦЯЛО, вкл.
//     чуждите публикации в нея и техните файлове (изрично бизнес
//     изключение само за цяла тема на окончателно изтривания профил);
//     резервираните теми (is_general, Лафче) никога не се трият;
//   * без системен автор/заместител; заглавието и текстовете на изтрития
//     профил не остават;
//   * преди COMMIT: броят чужди съобщения във всички ДРУГИ засегнати теми е
//     непроменен, няма parent връзка между различни теми, а собствените
//     теми са напълно изчезнали — иначе ROLLBACK (failed, повторен опит).
//
// Етап 4E3 (одит P5) — исторически имена на профила:
//   * profile_name_change_ledger — old/new_display_name стават неутралният
//     етикет; сумата, балансът, датата, change_id и snapshot-ът остават;
//   * campaign_archive_top10 — display_name_at_archive на реда на профила
//     става етикетът; мястото, единиците и титлата остават, класацията не се
//     преизчислява. И двете — ПРЕДИ DELETE FROM profiles (после profile_id е
//     NULL); принадлежност само по profile_id / snapshot, никога по име;
//     нарушен инвариант преди COMMIT -> ROLLBACK.
//
// Етап 4E6B (одит 4E6A, одобрени правила; миграция 20261029_001) —
// модераторски записи. Активен БАН отлага окончателното изтриване
// ('active_ban', blocked с повторен опит) до изтичането или премахването
// му — подаване на заявка при активен бан се отказва още в request store-а.
// Заглушаване или минали нарушения НЕ блокират. Пази се само минималната
// следа:
//   * profile_bans — редът остава (дата, срок, основание, кой е наложил);
//     profile_id става NULL, остава само псевдонимният UUID в
//     deleted_profile_id_snapshot. Банът не може да се приложи към друг
//     профил (търси се само по profile_id);
//   * topic_reports — неразгледаните сигнали на профила остават без подател
//     (reporter_profile_id = NULL, FK SET NULL); вече разгледаните се
//     изтриват (досегашното поведение, без ново съхранение);
//   * tournament_participation_blocks — блокировка, наложена ОТ профила,
//     остава в сила (actor_profile_id = NULL); блокировката НА профила
//     изчезва (CASCADE);
//   * заглушавания, известията за тях и доказателствата (topic_mute_evidence)
//     на профила изчезват; файловете им са в опашката (виж по-горе);
//   * одитните журнали (topic_moderation_audit_log, lobby_chat_deletion_
//     audit_log) остават без връзка към профила (SET NULL);
//   * преди COMMIT: чуждите модераторски записи са непроменени, запазените
//     са точно очакваните (анонимни), нищо модераторско не сочи към профила
//     и всеки файл на доказателствата му е в опашката — иначе ROLLBACK.
//
// Етап 4E5 (одит P5) — кореспонденцията с поддръжката ("Връзка с екипа"):
//   * support_messages (без FK към profiles; разговорът е един на профил,
//     ключ profile_id; отговорите на екипа са в същия разговор,
//     is_from_admin = 1) — изтриват се всички съобщения на профила;
//     support_message_attachments изчезват каскадно, а файловете им са в
//     опашката ПРЕДИ това (support_attachment, обичайните защити);
//     support_archived (маркер "архивиран") — изтрива се;
//   * support_deletion_archives НЕ се пипа — отделен доказателствен запис на
//     административно изтриване по изрична заявка (не възниква при
//     самоизтриване);
//   * отложено административно изтриване на СЪЩИЯ профил
//     (pending_profile_moderation, action='delete', със или без support
//     заявка) — Етап 4E6C (одобрен вариант А): окончателното самоизтриване
//     приключва и двете процедури в същата транзакция — pending редът се
//     изтрива изрично, без нов ред в support_deletion_archives и без
//     admin_profile_deletions (административното изтриване не се е
//     случило). Активен бан и другите блокери се проверяват ПРЕДИ това;
//   * преди COMMIT: нищо от поддръжката не сочи към профила, а чуждите
//     разговори и файлови редове са непроменени — иначе ROLLBACK.
//
// Етап 4E4 (одит P5) — партньорски оценки (миграция 20261028_001):
//   * дадените от профила оценки остават в рейтингите на другите — FK
//     rated_by_profile_id е ON DELETE SET NULL (без snapshot на ID-то);
//   * получените от профила изчезват (rated_profile_id ON DELETE CASCADE);
//   * преди COMMIT: броят и сумата на оценките на всеки засегнат играч са
//     непроменени, кешът profiles.average_rating/total_ratings_count е
//     преизчислен от таблицата, нищо не сочи към профила — иначе ROLLBACK.

import { randomBytes, randomUUID } from 'node:crypto'
import type { ProfileDeletionFileKind } from '../uploads/profileDeletionFileRemoval.js'
import { createProfileDeletionParticipationChecks } from './profileDeletionParticipationChecks.js'
import { computeProfileDeletionRetryDelayMs } from './profileDeletionSchedule.js'
import { createProfileVisitLinkReader } from './profileVisitLinks.js'
import { LAFCHE_TOPIC_ID } from './topicHardDeleteService.js'
import type { ProfileDeletionRequestCancelledRecord } from './profileDeletionLedger.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

export const PROFILE_DELETION_WORKER_LEASE_MS = 10 * 60 * 1000
export const PROFILE_DELETION_FILE_LEASE_MS = 2 * 60 * 1000
/** Неочаквани грешки (не защитни блокировки): след толкова опита — failed без автоматичен повторен опит. */
export const PROFILE_DELETION_MAX_FAILED_ATTEMPTS = 6
export const PROFILE_DELETION_MAX_FILE_ATTEMPTS = 6
/** Неутрален етикет на мястото на името на изтрития участник в чужди записи. */
export const PROFILE_DELETION_DELETED_LABEL = 'Изтрит профил'

export type ProfileDeletionBlockCode =
  | 'active_game'
  | 'active_game_local'
  | 'active_tournament'
  | 'pending_tournament_invite'
  | 'role_not_allowed'
  | 'campaign_gift_sender_protected'
  /** Етап 4C: записът в регистъра още не е потвърдено копиран извън VPS. */
  | 'ledger_offsite_pending'
  /** Етап 4E6B: активен бан — окончателното изтриване чака изтичането/премахването му. */
  | 'active_ban'
  /** Етап 4J1: приета отмяна (защита в дълбочина — claim и тригерът я изключват). */
  | 'cancellation_pending'

export type ProfileDeletionFailCode =
  | 'identity_mismatch'
  | 'identity_profile_missing'
  | 'db_phase_error'
  | 'ledger_write_failed'
  | 'files_pending'

export type ClaimedProfileDeletionRequest = {
  requestId: string
  profileId: string
  accountIdSnapshot: string
  profileCreatedAtSnapshot: string
  requestedAt: string
  scheduledFor: string
  attemptCount: number
  dbDeletedAt: string | null
  reclaimed: boolean
}

export type ProfileDeletionDbPhaseResult =
  | { kind: 'db_deleted'; enqueuedFileCount: number; accountDeleted: boolean; alreadyDeletedByAdmin: boolean; dbDeletedAt: string }
  | { kind: 'already_db_deleted' }
  | { kind: 'blocked'; code: ProfileDeletionBlockCode }
  | { kind: 'failed'; code: ProfileDeletionFailCode; willRetry: boolean }
  | { kind: 'lease_lost' }

export type ProfileDeletionQueuedFile = {
  queueId: number
  /** Собственик: заявка за самоизтриване ИЛИ административна операция (20261031_001). */
  requestId: string | null
  adminOperationId: string | null
  fileKind: ProfileDeletionFileKind
  storageRef: string
  attemptCount: number
}

/**
 * Етап 4F2A — окончателно административно изтриване инициира САМО роля
 * `admin`. Authoritative проверка по базата (не по сесията): акаунтът е
 * admin и профилът на актьора е негов. Параметри: ?1 actorAccountId,
 * ?2 actorProfileId. Ползва се при насрочване (координатора) и при директно
 * изпълнение (executor-а); вече насрочена операция се довършва и без
 * интерактивна сесия.
 */
export const ADMIN_HARD_DELETE_ACTOR_AUTHORIZED_SQL = `
  SELECT 1 FROM accounts a
  JOIN profiles p ON p.account_id = a.account_id
  WHERE a.account_id = ?1 AND p.profile_id = ?2 AND a.role = 'admin'
  LIMIT 1;
`

/** Етап 4F2 — вход на административното окончателно изтриване (mirror на hardDeleteProfile). */
export type AdminHardDeleteInput = {
  targetProfileId: string
  actorProfileId: string
  actorAccountId: string
  reason: string
  supportRequestMessageId?: string | null
  /** log_id на одитния ред = operationId в регистъра (иначе нов UUID). */
  auditLogId?: string
  /** Повторно прилагане след restore: оригиналният момент (SQLite datetime). */
  replay?: { deletedAt: string }
}

export type AdminHardDeleteResult =
  | { ok: true; deletedProfileId: string; deletedAccountId: string | null; operationId: string; enqueuedFileCount: number }
  | {
      ok: false
      code:
        | 'not_found'
        | 'self'
        | 'invalid_reason'
        | 'active_tournament_dependency'
        | 'invalid_support_request_message'
        | 'campaign_gift_sender_protected'
        | 'forbidden'
    }

export type AdminFileCleanupFinishResult =
  | { kind: 'done' }
  | { kind: 'files_pending'; willRetry: boolean }
  | { kind: 'not_pending' }

export type ProfileDeletionFinishResult =
  | { kind: 'completed' }
  | { kind: 'files_pending'; willRetry: boolean }
  | { kind: 'lease_lost' }

export type ProfileDeletionReplayResult =
  | { kind: 'deleted'; files: Array<{ fileKind: ProfileDeletionFileKind; storageRef: string }>; accountDeleted: boolean }
  | { kind: 'absent' }
  | { kind: 'identity_mismatch' }
  | { kind: 'blocked'; code: ProfileDeletionBlockCode }

export type ProfileDeletionExecutor = {
  /** onlyRequestId — само тази заявка (процедурата след restore обработва само заявките от регистъра). */
  claimNextDueRequest: (workerId: string, onlyRequestId?: string) => ClaimedProfileDeletionRequest | null
  runDatabasePhase: (request: ClaimedProfileDeletionRequest, workerId: string) => ProfileDeletionDbPhaseResult
  /** Защитна блокировка, открита извън транзакцията (напр. игра в паметта на този процес). */
  blockRequest: (requestId: string, workerId: string, code: ProfileDeletionBlockCode) => boolean
  failRequest: (requestId: string, workerId: string, code: ProfileDeletionFailCode) => boolean
  extendLease: (requestId: string, workerId: string) => boolean
  listFilesToProcess: (requestId: string) => ProfileDeletionQueuedFile[]
  claimFile: (queueId: number, workerId: string) => boolean
  /** true, ако storage_ref още се реферира от жив ред в базата (споделен файл). */
  isStorageRefReferenced: (fileKind: ProfileDeletionFileKind, storageRef: string) => boolean
  markFileDone: (file: ProfileDeletionQueuedFile, workerId: string, profileId: string, outcome: 'deleted' | 'missing') => boolean
  markFileSkippedShared: (file: ProfileDeletionQueuedFile, workerId: string, profileId: string) => boolean
  markFileFailed: (file: ProfileDeletionQueuedFile, workerId: string, profileId: string, code: string, permanent: boolean) => boolean
  finishRequest: (requestId: string, workerId: string) => ProfileDeletionFinishResult
  /**
   * Само за процедурата след restore от backup (scripts/reconcileProfileDeletionLedger.ts):
   * същото изтриване в базата за профил, чиято заявка липсва във
   * възстановената база. Без опашка/събития — връща файловете.
   */
  replayDeletionForRestore: (
    identity: { profileId: string; accountIdSnapshot: string; profileCreatedAtSnapshot: string },
    hooks?: { beforeCommit?: (files: Array<{ fileKind: ProfileDeletionFileKind; storageRef: string }>) => void },
  ) => ProfileDeletionReplayResult
  /**
   * Само за процедурата след restore (спрян сървър): заявка от
   * възстановената база става веднага годна за claim — blocked/failed
   * получават next_attempt_at = сега, executing — изтекъл lease. Статусът,
   * идентичността и графикът не се променят (тригерите го гарантират).
   */
  prepareRequestForRestoreReconcile: (requestId: string) => boolean
  /**
   * Етап 4J1 — worker-ът е взел заявка, а регистърът вече съдържа отмяна за
   * нея (restore на база отпреди отмяната): lease-ът се освобождава
   * (blocked, без нов опит) и в СЪЩАТА транзакция се записва трайната
   * защита (recovered_from_ledger = 1). Финализира се от finalizer-а.
   */
  applyRecordedCancellation: (requestId: string, workerId: string, record: ProfileDeletionRequestCancelledRecord) => boolean
  /**
   * Етап 4F2 — административното окончателно изтриване: административните
   * проверки + одитен ред (file_cleanup_status='pending') + СЪЩОТО ядро
   * (deleteProfileDataInTransaction) + СЪЩАТА файлова опашка (собственик
   * admin_operation_id), в ЕДНА BEGIN IMMEDIATE транзакция.
   */
  executeAdminHardDelete: (input: AdminHardDeleteInput) => AdminHardDeleteResult
  listAdminFilesToProcess: (operationId: string) => ProfileDeletionQueuedFile[]
  /** Административни операции, чиято файлова фаза не е приключила (диагностика + повторни опити). */
  listAdminOperationsPendingFileCleanup: () => Array<{ operationId: string; profileId: string }>
  /** pending -> done, само ако всички файлове на операцията са done/skipped_shared (тригерът го гарантира). */
  finishAdminFileCleanup: (operationId: string) => AdminFileCleanupFinishResult
  close: () => void
}

export type ProfileDeletionExecutorOptions = {
  /** Профили, които никога не се изтриват автоматично (официалният профил на Pika). */
  protectedProfileIds?: readonly string[]
  /** Само за тестове: извиква се вътре в DB транзакцията точно преди COMMIT. */
  testHooks?: {
    beforeDatabasePhaseCommit?: (requestId: string) => void
    beforeAdminCommit?: (operationId: string) => void
  }
}

type ProfileRow = {
  profile_id: string
  account_id: string | null
  created_at: string
  profile_kind: string
  is_temporary: number
  avatar_url: string | null
}

type RequestRow = {
  request_id: string
  profile_id: string
  account_id_snapshot: string
  profile_created_at_snapshot: string
  status: string
  requested_at: string
  scheduled_for: string
  attempt_count: number
  lease_owner: string | null
  lease_expires_at: string | null
  db_deleted_at: string | null
}

function isoPlus(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString()
}

export async function createProfileDeletionExecutor(
  databaseFilePath: string,
  options: ProfileDeletionExecutorOptions = {},
): Promise<ProfileDeletionExecutor> {
  const sqliteModule = await import('node:sqlite')
  const database: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })
  database.exec('PRAGMA foreign_keys = ON;')
  database.exec('PRAGMA journal_mode = WAL;')
  database.exec('PRAGMA busy_timeout = 5000;')

  const protectedProfileIds = new Set((options.protectedProfileIds ?? []).filter((id) => id.length > 0))
  const participationChecks = createProfileDeletionParticipationChecks(database)
  const linkReader = createProfileVisitLinkReader(database)

  const selectNowStatement = database.prepare(`SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now;`)

  const REQUEST_COLUMNS = `request_id, profile_id, account_id_snapshot, profile_created_at_snapshot, status,
    requested_at, scheduled_for, attempt_count, lease_owner, lease_expires_at, db_deleted_at`

  const NO_CANCELLATION_SQL = `NOT EXISTS (
        SELECT 1 FROM profile_deletion_cancellations c WHERE c.request_id = profile_deletion_requests.request_id
      )`

  const selectClaimCandidateStatement = database.prepare(`
    SELECT ${REQUEST_COLUMNS}
    FROM profile_deletion_requests
    WHERE (?2 IS NULL OR request_id = ?2)
      AND ${NO_CANCELLATION_SQL}
      AND (
        (status = 'pending' AND scheduled_for <= ?1)
        OR (status = 'blocked' AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?1)
        OR (status = 'failed' AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?1)
        OR (status = 'executing' AND lease_expires_at <= ?1)
      )
    ORDER BY scheduled_for ASC, request_id ASC
    LIMIT 1;
  `)

  const claimStatement = database.prepare(`
    UPDATE profile_deletion_requests
    SET status = 'executing', lease_owner = ?1, lease_expires_at = ?2,
        attempt_count = attempt_count + 1, next_attempt_at = NULL, updated_at = ?3
    WHERE request_id = ?4 AND status = ?5
      AND ${NO_CANCELLATION_SQL}
      AND (
        (status = 'pending' AND scheduled_for <= ?3)
        OR (status IN ('blocked', 'failed') AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?3)
        OR (status = 'executing' AND lease_expires_at <= ?3)
      );
  `)

  const selectRequestStatement = database.prepare(`
    SELECT ${REQUEST_COLUMNS} FROM profile_deletion_requests WHERE request_id = ? LIMIT 1;
  `)

  const extendLeaseStatement = database.prepare(`
    UPDATE profile_deletion_requests
    SET lease_expires_at = ?1, updated_at = ?2
    WHERE request_id = ?3 AND status = 'executing' AND lease_owner = ?4 AND lease_expires_at > ?2;
  `)

  const releaseStatement = database.prepare(`
    UPDATE profile_deletion_requests
    SET status = ?1, lease_owner = NULL, lease_expires_at = NULL, next_attempt_at = ?2,
        last_error_code = ?3, last_error_at = ?4, updated_at = ?4
    WHERE request_id = ?5 AND status = 'executing' AND lease_owner = ?6;
  `)

  const markDbDeletedStatement = database.prepare(`
    UPDATE profile_deletion_requests
    SET db_deleted_at = ?1, lease_expires_at = ?2, updated_at = ?1
    WHERE request_id = ?3 AND status = 'executing' AND lease_owner = ?4 AND db_deleted_at IS NULL;
  `)

  const completeStatement = database.prepare(`
    UPDATE profile_deletion_requests
    SET status = 'completed', completed_at = ?1, lease_owner = NULL, lease_expires_at = NULL,
        next_attempt_at = NULL, updated_at = ?1
    WHERE request_id = ?2 AND status = 'executing' AND lease_owner = ?3 AND db_deleted_at IS NOT NULL;
  `)

  const insertEventStatement = database.prepare(`
    INSERT INTO profile_deletion_events (request_id, profile_id, event_type, actor_kind, worker_id, detail_json)
    VALUES (?, ?, ?, 'system', ?, ?);
  `)

  const selectCancellationStatement = database.prepare(`
    SELECT 1 FROM profile_deletion_cancellations WHERE request_id = ? LIMIT 1;
  `)

  const insertRecoveredCancellationStatement = database.prepare(`
    INSERT INTO profile_deletion_cancellations (cancellation_id, request_id, profile_id, source, recovered_from_ledger, previous_status, ledger_recorded_at)
    VALUES (?, ?, ?, ?, 1, 'blocked', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  `)

  // ─── Идентичност и защитни проверки ──────────────────────────────────────
  const selectProfileStatement = database.prepare(`
    SELECT profile_id, account_id, created_at, profile_kind, is_temporary, avatar_url
    FROM profiles WHERE profile_id = ? LIMIT 1;
  `)

  const selectAccountRoleStatement = database.prepare(`SELECT role FROM accounts WHERE account_id = ? LIMIT 1;`)

  const selectAdminDeletionStatement = database.prepare(`
    SELECT 1 FROM admin_profile_deletions WHERE deleted_profile_id = ? LIMIT 1;
  `)

  const selectCampaignGiftSenderStatement = database.prepare(`
    SELECT 1 FROM gift_item_transactions WHERE sender_profile_id = ? AND context = 'campaign_reward' LIMIT 1;
  `)

  // ─── Теми и Лафче (виж А1/Б1 в началото на файла) ───────────────────────
  // Чужди преки наследници на собствени съобщения — само те биха били
  // засегнати от parent_message_id CASCADE (по-дълбоките чужди наследници
  // следват своя чужд родител, който остава).
  const selectForeignChildrenOfOwnMessagesStatement = database.prepare(`
    SELECT child.message_id, child.topic_id, child.deleted_at
    FROM topic_messages child
    JOIN topic_messages parent ON parent.message_id = child.parent_message_id
    WHERE parent.sender_profile_id = ?1 AND child.sender_profile_id <> ?1
    ORDER BY child.seq ASC;
  `)

  const selectTopicMessageLinkStatement = database.prepare(`
    SELECT parent_message_id, sender_profile_id FROM topic_messages WHERE message_id = ? LIMIT 1;
  `)

  // ?3 — защита: пренасочва се само ЧУЖДО съобщение.
  const reparentTopicMessageStatement = database.prepare(`
    UPDATE topic_messages SET parent_message_id = ?1 WHERE message_id = ?2 AND sender_profile_id <> ?3;
  `)

  // Б1: теми на профила. Резервираните (is_general / Лафче) не се трият.
  const selectCreatedTopicsStatement = database.prepare(`
    SELECT topic_id, is_general FROM topics WHERE created_by_profile_id = ?1;
  `)

  const selectAttachmentsForTopicStatement = database.prepare(`
    SELECT a.storage_filename
    FROM topic_message_attachments a
    JOIN topic_messages m ON m.message_id = a.message_id
    WHERE m.topic_id = ?;
  `)

  // topic_moderation_audit_log.topic_id е без FK — mirror на
  // topicHardDeleteService.hardDeleteTopic (автоматично почистване без actor).
  const deleteTopicModerationAuditStatement = database.prepare(`
    DELETE FROM topic_moderation_audit_log WHERE topic_id = ?;
  `)

  const deleteOwnTopicStatement = database.prepare(`
    DELETE FROM topics
    WHERE topic_id = ?1 AND created_by_profile_id = ?2 AND is_general = 0 AND topic_id <> ?3;
  `)

  const selectAffectedTopicIdsStatement = database.prepare(`
    SELECT topic_id FROM topic_messages WHERE sender_profile_id = ?1
    UNION
    SELECT topic_id FROM topics WHERE created_by_profile_id = ?1;
  `)

  const countForeignTopicMessagesStatement = database.prepare(`
    SELECT COUNT(*) AS cnt FROM topic_messages
    WHERE sender_profile_id <> ?1 AND topic_id IN (SELECT value FROM json_each(?2));
  `)

  const countTopicMessagesInTopicsStatement = database.prepare(`
    SELECT COUNT(*) AS cnt FROM topic_messages WHERE topic_id IN (SELECT value FROM json_each(?1));
  `)

  const countTopicsStatement = database.prepare(`
    SELECT COUNT(*) AS cnt FROM topics WHERE topic_id IN (SELECT value FROM json_each(?1));
  `)

  const countCrossTopicParentLinksStatement = database.prepare(`
    SELECT COUNT(*) AS cnt
    FROM topic_messages child
    JOIN topic_messages parent ON parent.message_id = child.parent_message_id
    WHERE child.topic_id <> parent.topic_id AND child.topic_id IN (SELECT value FROM json_each(?1));
  `)

  // Чужди root-ове, под които профилът има отговори — агрегатът им
  // (topic_root_latest_seq) се преизчислява след изтриването.
  const selectForeignParentsOfOwnRepliesStatement = database.prepare(`
    SELECT DISTINCT parent.message_id
    FROM topic_messages own
    JOIN topic_messages parent ON parent.message_id = own.parent_message_id
    WHERE own.sender_profile_id = ?1 AND parent.sender_profile_id <> ?1;
  `)

  // Mirror на topicMessageStore recomputeRootLatestSeqStatement +
  // bumpOrSetRootLatestSeqStatement (само за редове, които съществуват).
  const recomputeRootLatestSeqStatement = database.prepare(`
    UPDATE topic_root_latest_seq
    SET latest_seq = (
          SELECT MAX(m.seq) FROM topic_messages m
          WHERE (m.message_id = ?1 OR m.parent_message_id = ?1) AND m.deleted_at IS NULL
        ),
        updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now')
    WHERE root_message_id = ?1
      AND EXISTS (
        SELECT 1 FROM topic_messages m
        WHERE (m.message_id = ?1 OR m.parent_message_id = ?1) AND m.deleted_at IS NULL
      );
  `)

  // А1: жив чужд отговор, станал root — получава свой ред (mirror на
  // insertRootLatestSeqStatement; само за жив root, latest_seq по живите
  // съобщения в нишката му).
  const upsertPromotedRootLatestSeqStatement = database.prepare(`
    INSERT INTO topic_root_latest_seq (root_message_id, topic_id, latest_seq)
    SELECT m.message_id, m.topic_id, (
      SELECT MAX(x.seq) FROM topic_messages x
      WHERE (x.message_id = ?1 OR x.parent_message_id = ?1) AND x.deleted_at IS NULL
    )
    FROM topic_messages m
    WHERE m.message_id = ?1 AND m.parent_message_id IS NULL AND m.deleted_at IS NULL
    ON CONFLICT(root_message_id) DO UPDATE SET
      latest_seq = excluded.latest_seq,
      updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now');
  `)

  // ─── Файлове ─────────────────────────────────────────────────────────────
  const selectGalleryStatement = database.prepare(`
    SELECT image_url, thumbnail_url FROM profile_gallery_images WHERE profile_id = ?;
  `)

  // Всички лични разговори на профила (всеки статус/вид) — изтриват се за
  // двете страни (profile_friendships -> friend_chat_messages ->
  // friend_chat_attachments е ON DELETE CASCADE).
  const selectChatAttachmentsStatement = database.prepare(`
    SELECT a.storage_filename
    FROM friend_chat_attachments a
    JOIN friend_chat_messages m ON m.message_id = a.message_id
    JOIN profile_friendships f ON f.friendship_id = m.friendship_id
    WHERE f.requester_profile_id = ?1 OR f.addressee_profile_id = ?1;
  `)

  // След пренасочването каскадата засяга САМО собствени съобщения (и
  // собствени теми без чуждо съдържание) — техните файлове.
  const selectTopicAttachmentsStatement = database.prepare(`
    SELECT a.storage_filename
    FROM topic_message_attachments a
    JOIN topic_messages m ON m.message_id = a.message_id
    WHERE m.sender_profile_id = ?1;
  `)

  // topic_mute_evidence.profile_id е ON DELETE CASCADE — evidence копието
  // (отделен файл) или препратката към оригиналния файл остават без ред.
  const selectEvidenceAttachmentsStatement = database.prepare(`
    SELECT source_attachment_storage_filename AS storage_filename, source_attachment_is_evidence_copy AS is_copy
    FROM topic_mute_evidence
    WHERE profile_id = ? AND source_attachment_storage_filename IS NOT NULL;
  `)

  const insertFileStatement = database.prepare(`
    INSERT OR IGNORE INTO profile_deletion_file_queue (request_id, file_kind, storage_ref) VALUES (?, ?, ?);
  `)

  // ?1 = profile_id, ?2 = неутралният етикет; всеки statement получава
  // точно толкова параметри, колкото реферира (node:sqlite отказва излишни).
  function prepareWithArity(sql: string): { run: (profileId: string) => void } {
    const statement = database.prepare(sql)
    const usesLabel = sql.includes('?2')
    return {
      run: (profileId: string) => {
        if (usesLabel) statement.run(profileId, PROFILE_DELETION_DELETED_LABEL)
        else statement.run(profileId)
      },
    }
  }

  // ─── Атрибуция (mirror на profileHardDeleteService.ts snapshot списъка) ─
  // Суми/салда/статуси/платежни идентификатори НЕ се променят — само кой
  // профил е бил (псевдонимен UUID), за финансово отчитане и доказване на
  // транзакции. Тестът проверява, че всяка *_snapshot колона е покрита.
  const attributionSnapshotStatements = [
    `UPDATE profile_bans SET deleted_profile_id_snapshot = ?1 WHERE profile_id = ?1;`,
    `UPDATE tournaments SET deleted_creator_profile_id_snapshot = ?1 WHERE creator_profile_id = ?1;`,
    `UPDATE tournament_entries SET deleted_profile_id_snapshot = ?1 WHERE profile_id = ?1;`,
    `UPDATE tournament_economy_ledger SET deleted_profile_id_snapshot = ?1 WHERE profile_id = ?1;`,
    `UPDATE yellow_coin_gift_ledger SET deleted_sender_profile_id_snapshot = ?1 WHERE sender_profile_id = ?1;`,
    `UPDATE yellow_coin_gift_ledger SET deleted_recipient_profile_id_snapshot = ?1 WHERE recipient_profile_id = ?1;`,
    `UPDATE match_economy_ledger SET deleted_profile_id_snapshot = ?1 WHERE profile_id = ?1;`,
    `UPDATE coin_purchase_ledger SET deleted_profile_id_snapshot = ?1 WHERE profile_id = ?1;`,
    `UPDATE profile_name_change_ledger SET deleted_profile_id_snapshot = ?1 WHERE profile_id = ?1;`,
    `UPDATE vip_grants SET deleted_profile_id_snapshot = ?1 WHERE profile_id = ?1;`,
    `UPDATE vip_purchase_ledger SET deleted_profile_id_snapshot = ?1 WHERE profile_id = ?1;`,
    `UPDATE bundle_purchase_ledger SET deleted_profile_id_snapshot = ?1 WHERE profile_id = ?1;`,
    `UPDATE table_exit_penalties SET deleted_profile_id_snapshot = ?1 WHERE profile_id = ?1;`,
    `UPDATE profile_match_results SET deleted_profile_id_snapshot = ?1 WHERE profile_id = ?1;`,
    `UPDATE belot_match_completion_ledger SET deleted_profile_id_snapshot = ?1 WHERE profile_id = ?1;`,
    // Етап 4E2 (20261027_001): Ludo финансовият регистър и кампанийната
    // атрибуция (единици, предоставени награди, ръчни корекции).
    `UPDATE ludo_match_economy_ledger SET deleted_profile_id_snapshot = ?1 WHERE profile_id = ?1;`,
    `UPDATE campaign_unit_ledger SET deleted_profile_id_snapshot = ?1 WHERE profile_id = ?1;`,
    `UPDATE campaign_reward_claims SET deleted_profile_id_snapshot = ?1 WHERE profile_id = ?1;`,
    `UPDATE campaign_manual_adjustments SET deleted_profile_id_snapshot = ?1 WHERE profile_id = ?1;`,
    // Подаръци (жълтици/VIP/пакет), платени от ДРУГ потребител за този
    // профил: псевдонимният UUID се snapshot-ва, а името му в чуждия запис
    // се заменя с неутрален етикет (не е платежен идентификатор).
    `UPDATE coin_purchase_ledger SET deleted_recipient_profile_id_snapshot = ?1,
       recipient_display_name_snapshot = CASE WHEN recipient_display_name_snapshot IS NULL THEN NULL ELSE ?2 END
     WHERE recipient_profile_id = ?1;`,
    `UPDATE vip_purchase_ledger SET deleted_recipient_profile_id_snapshot = ?1,
       recipient_display_name_snapshot = CASE WHEN recipient_display_name_snapshot IS NULL THEN NULL ELSE ?2 END
     WHERE recipient_profile_id = ?1;`,
    `UPDATE bundle_purchase_ledger SET deleted_recipient_profile_id_snapshot = ?1,
       recipient_display_name_snapshot = CASE WHEN recipient_display_name_snapshot IS NULL THEN NULL ELSE ?2 END
     WHERE recipient_profile_id = ?1;`,
  ].map(prepareWithArity)

  // ─── Анонимизиране на чужди записи ──────────────────────────────────────
  const anonymizeStatements = [
    // Получени от други подаръци: редът в gift_item_transactions остава
    // (FK SET NULL); името на изпращача в известието на получателя се заменя.
    `UPDATE gift_item_delivery_log SET from_display_name = ?2
     WHERE transaction_id IN (SELECT transaction_id FROM gift_item_transactions WHERE sender_profile_id = ?1);`,
    // Известията за платени подаръци, изпратени ОТ профила до други.
    `UPDATE paid_gift_notification_log
     SET body_text = replace(body_text, sender_display_name_snapshot, ?2), sender_display_name_snapshot = ?2
     WHERE (purchase_type = 'coin' AND purchase_id IN (SELECT purchase_id FROM coin_purchase_ledger WHERE profile_id = ?1))
        OR (purchase_type = 'vip' AND purchase_id IN (SELECT purchase_id FROM vip_purchase_ledger WHERE profile_id = ?1))
        OR (purchase_type = 'bundle' AND purchase_id IN (SELECT purchase_id FROM bundle_purchase_ledger WHERE profile_id = ?1));`,
    // Лайковете, дадени ОТ профила, се броят в чужди тотали
    // (SUM(total_given)) — пазят се, но с несвързан случаен идентификатор.
    `UPDATE profile_likes SET liker_profile_id = 'deleted-' || lower(hex(randomblob(16))) WHERE liker_profile_id = ?1;`,
    // Етап 4E3: историята на платените смени на име — двете имена стават
    // неутралният етикет; сумата, балансът, датата, change_id и snapshot-ът
    // остават. Принадлежност САМО по profile_id / snapshot на същия UUID
    // (никога по съвпадение на име).
    `UPDATE profile_name_change_ledger SET old_display_name = ?2, new_display_name = ?2
     WHERE profile_id = ?1 OR (profile_id IS NULL AND deleted_profile_id_snapshot = ?1);`,
    // Етап 4E3: архивът на кампаниите — само името на реда на профила
    // (мястото, единиците и титлата остават; класацията не се преизчислява).
    // Трябва да е ПРЕДИ DELETE FROM profiles: след него profile_id е NULL
    // (ON DELETE SET NULL) и редът вече не може да бъде свързан с профила.
    `UPDATE campaign_archive_top10 SET display_name_at_archive = ?2 WHERE profile_id = ?1;`,
  ].map(prepareWithArity)

  // ─── Лични данни без FK (cascade НЕ ги пипа) ─────────────────────────────
  const deleteWithoutFkStatements = [
    `DELETE FROM gift_item_delivery_log WHERE recipient_profile_id = ?1;`,
    `DELETE FROM paid_gift_notification_log WHERE recipient_profile_id = ?1;`,
    `DELETE FROM profile_likes WHERE liked_profile_id = ?1;`,
    `DELETE FROM player_blocks WHERE blocker_profile_id = ?1 OR blocked_profile_id = ?1;`,
    // Маркерите за прочитане на ДВЕТЕ страни за изтриваните разговори.
    `DELETE FROM chat_conversation_reads
     WHERE profile_id = ?1
        OR friendship_id IN (SELECT friendship_id FROM profile_friendships WHERE requester_profile_id = ?1 OR addressee_profile_id = ?1);`,
  ].map(prepareWithArity)

  // ─── Етап 4E1: IP/visitor връзки и история на игрите ─────────────────────
  // Изпълняват се СЛЕД инвалидирането на risk cache-а (то чете visitor
  // връзките, за да намери засегнатите профили).
  const deleteIdentityLinkStatements = [
    `DELETE FROM profile_ip_links WHERE profile_id = ?1;`,
    `DELETE FROM profile_visitor_links WHERE profile_id = ?1;`,
  ].map((sql) => database.prepare(sql))

  // instr() е само предварителен филтър; съвпадението е по точен profileId
  // след JSON парсване.
  const selectPrivateMatchCandidatesStatement = database.prepare(`
    SELECT room_id, team_a_json, team_b_json FROM private_room_matches
    WHERE instr(team_a_json, ?1) > 0 OR instr(team_b_json, ?1) > 0;
  `)
  const updatePrivateMatchTeamsStatement = database.prepare(`
    UPDATE private_room_matches SET team_a_json = ?, team_b_json = ? WHERE room_id = ?;
  `)
  const selectLudoMatchCandidatesStatement = database.prepare(`
    SELECT match_id, players_json, winner_profile_id FROM ludo_room_matches
    WHERE instr(players_json, ?1) > 0 OR winner_profile_id = ?1;
  `)
  const updateLudoMatchStatement = database.prepare(`
    UPDATE ludo_room_matches SET players_json = ?, winner_profile_id = ? WHERE match_id = ?;
  `)

  function parseOccupantArray(json: string): Array<Record<string, unknown>> {
    const parsed = JSON.parse(json) as unknown
    if (!Array.isArray(parsed) || parsed.some((item) => item === null || typeof item !== 'object' || Array.isArray(item))) {
      throw new Error('profile_deletion_match_history_unparseable')
    }
    return parsed as Array<Record<string, unknown>>
  }

  /** true, ако някоя стойност (рекурсивно, вкл. вложени полета) е ТОЧНО needle. */
  function containsExactValue(value: unknown, needle: string): boolean {
    if (value === needle) return true
    if (Array.isArray(value)) return value.some((item) => containsExactValue(item, needle))
    if (value !== null && typeof value === 'object') return Object.values(value).some((item) => containsExactValue(item, needle))
    return false
  }

  function anonymizePrivateRoomMatches(profileId: string): number {
    let changed = 0
    for (const row of selectPrivateMatchCandidatesStatement.all(profileId) as Array<{ room_id: string; team_a_json: string; team_b_json: string }>) {
      let touched = false
      const anonymizeTeam = (json: string): Array<Record<string, unknown>> =>
        parseOccupantArray(json).map((occupant) => {
          if (occupant.profileId !== profileId) return occupant
          touched = true
          return { profileId: null, displayName: PROFILE_DELETION_DELETED_LABEL, avatarUrl: null, isBot: false }
        })
      const teamA = anonymizeTeam(row.team_a_json)
      const teamB = anonymizeTeam(row.team_b_json)
      // ID-то не е стойност в архивния запис (среща се само като подниз на друга стойност).
      if (!touched && !containsExactValue(teamA, profileId) && !containsExactValue(teamB, profileId)) continue
      // Остатъчно точно ID (напр. вложено поле) = непозната структура -> ROLLBACK.
      if (containsExactValue(teamA, profileId) || containsExactValue(teamB, profileId)) throw new Error('profile_deletion_match_history_residual_id')
      updatePrivateMatchTeamsStatement.run(JSON.stringify(teamA), JSON.stringify(teamB), row.room_id)
      changed += 1
    }
    return changed
  }

  function anonymizeLudoMatches(profileId: string): number {
    let changed = 0
    for (const row of selectLudoMatchCandidatesStatement.all(profileId) as Array<{ match_id: string; players_json: string; winner_profile_id: string | null }>) {
      const placeholder = `deleted-${randomBytes(16).toString('hex')}`
      let touched = row.winner_profile_id === profileId
      const players = parseOccupantArray(row.players_json).map((player) => {
        if (player.profileId !== profileId) return player
        touched = true
        return { profileId: placeholder, displayName: PROFILE_DELETION_DELETED_LABEL, avatarUrl: null, color: player.color }
      })
      if (!touched && !containsExactValue(players, profileId)) continue
      if (containsExactValue(players, profileId)) throw new Error('profile_deletion_match_history_residual_id')
      const winner = row.winner_profile_id === profileId ? placeholder : row.winner_profile_id
      updateLudoMatchStatement.run(JSON.stringify(players), winner, row.match_id)
      changed += 1
    }
    return changed
  }

  // ─── Етап 4E2: финансов инвариант ────────────────────────────────────────
  // Преди DELETE: редовете на профила; след DELETE (преди COMMIT): същият
  // брой/сума трябва да е под snapshot-а с profile_id NULL, а общите
  // стойности на регистъра — непроменени (никой ред не е изгубен/дублиран).
  // Нарушение = ROLLBACK (failed), профилът НЕ се маркира като изтрит.
  const FINANCIAL_LEDGERS = [
    { table: 'ludo_match_economy_ledger', sum: 'amount' },
    { table: 'campaign_unit_ledger', sum: 'units_amount' },
    { table: 'campaign_reward_claims', sum: '0' },
    { table: 'campaign_manual_adjustments', sum: 'units_delta' },
    // Етап 4E3: платените смени на име (сумата и балансът остават).
    { table: 'profile_name_change_ledger', sum: 'price_amount' },
  ] as const
  const financialInvariantStatements = FINANCIAL_LEDGERS.map(({ table, sum }) => ({
    table,
    own: database.prepare(`SELECT COUNT(*) AS cnt, COALESCE(SUM(${sum}), 0) AS total FROM ${table} WHERE profile_id = ?;`),
    snapshotted: database.prepare(`SELECT COUNT(*) AS cnt, COALESCE(SUM(${sum}), 0) AS total FROM ${table} WHERE profile_id IS NULL AND deleted_profile_id_snapshot = ?;`),
    all: database.prepare(`SELECT COUNT(*) AS cnt, COALESCE(SUM(${sum}), 0) AS total FROM ${table};`),
  }))

  type LedgerTotals = { cnt: number; total: number }
  function readFinancialTotals(profileId: string): Array<{ table: string; own: LedgerTotals; snapshotted: LedgerTotals; all: LedgerTotals }> {
    return financialInvariantStatements.map((statements) => ({
      table: statements.table,
      own: statements.own.get(profileId) as LedgerTotals,
      snapshotted: statements.snapshotted.get(profileId) as LedgerTotals,
      all: statements.all.get() as LedgerTotals,
    }))
  }

  function assertFinancialInvariant(before: ReturnType<typeof readFinancialTotals>, profileId: string): void {
    const after = readFinancialTotals(profileId)
    for (let index = 0; index < before.length; index += 1) {
      const b = before[index]
      const a = after[index]
      const expectedSnapshotted = { cnt: b.snapshotted.cnt + b.own.cnt, total: b.snapshotted.total + b.own.total }
      if (
        a.own.cnt !== 0 ||
        a.snapshotted.cnt !== expectedSnapshotted.cnt ||
        a.snapshotted.total !== expectedSnapshotted.total ||
        a.all.cnt !== b.all.cnt ||
        a.all.total !== b.all.total
      ) {
        throw new Error(`profile_deletion_financial_invariant_violated:${b.table}`)
      }
    }
  }

  // ─── Етап 4E3: имена в историята и архивите ──────────────────────────────
  // Преди DELETE: редовете на профила в архива (място, единици, титла) и
  // общите стойности; след DELETE (преди COMMIT): същите редове са без
  // profile_id и с неутралния етикет, нищо друго в архива не е променено, а
  // в регистъра за смяна на име не е останало оригинално име на профила.
  type ArchiveRow = { campaign_id: string; rank: number; units_total: number; rank_title_at_archive: string | null }
  const selectOwnArchiveRowsStatement = database.prepare(`
    SELECT campaign_id, rank, units_total, rank_title_at_archive
    FROM campaign_archive_top10 WHERE profile_id = ? ORDER BY campaign_id, rank;
  `)
  const selectArchiveRowStatement = database.prepare(`
    SELECT profile_id, display_name_at_archive, units_total, rank_title_at_archive
    FROM campaign_archive_top10 WHERE campaign_id = ? AND rank = ?;
  `)
  const selectArchiveTotalsStatement = database.prepare(`
    SELECT COUNT(*) AS cnt, COALESCE(SUM(units_total), 0) AS units, COALESCE(SUM(rank), 0) AS ranks,
      COALESCE(SUM(CASE WHEN display_name_at_archive = ?1 THEN 1 ELSE 0 END), 0) AS labelled
    FROM campaign_archive_top10;
  `)
  const countNameLedgerOriginalNamesStatement = database.prepare(`
    SELECT COUNT(*) AS cnt FROM profile_name_change_ledger
    WHERE (profile_id = ?1 OR deleted_profile_id_snapshot = ?1)
      AND (old_display_name <> ?2 OR new_display_name <> ?2);
  `)

  type NameArchiveState = { rows: ArchiveRow[]; totals: { cnt: number; units: number; ranks: number; labelled: number } }
  function readNameArchiveState(profileId: string): NameArchiveState {
    return {
      rows: selectOwnArchiveRowsStatement.all(profileId) as ArchiveRow[],
      totals: selectArchiveTotalsStatement.get(PROFILE_DELETION_DELETED_LABEL) as NameArchiveState['totals'],
    }
  }

  function assertNameArchiveInvariant(before: NameArchiveState, profileId: string): void {
    for (const row of before.rows) {
      const after = selectArchiveRowStatement.get(row.campaign_id, row.rank) as
        | { profile_id: string | null; display_name_at_archive: string; units_total: number; rank_title_at_archive: string | null }
        | undefined
      if (
        after === undefined ||
        after.profile_id !== null ||
        after.display_name_at_archive !== PROFILE_DELETION_DELETED_LABEL ||
        after.units_total !== row.units_total ||
        after.rank_title_at_archive !== row.rank_title_at_archive
      ) {
        throw new Error('profile_deletion_name_archive_invariant_violated:campaign_archive_top10')
      }
    }
    const totals = selectArchiveTotalsStatement.get(PROFILE_DELETION_DELETED_LABEL) as NameArchiveState['totals']
    const newlyLabelled = before.rows.length
    if (
      totals.cnt !== before.totals.cnt ||
      totals.units !== before.totals.units ||
      totals.ranks !== before.totals.ranks ||
      totals.labelled > before.totals.labelled + newlyLabelled
    ) {
      throw new Error('profile_deletion_name_archive_invariant_violated:campaign_archive_top10_totals')
    }
    if ((countNameLedgerOriginalNamesStatement.get(profileId, PROFILE_DELETION_DELETED_LABEL) as { cnt: number }).cnt !== 0) {
      throw new Error('profile_deletion_name_archive_invariant_violated:profile_name_change_ledger')
    }
  }

  // ─── Етап 4E4: партньорски оценки ───────────────────────────────────────
  type RatingAggregate = { profile_id: string; cnt: number; total: number }
  const selectRatedByProfileAggregatesStatement = database.prepare(`
    SELECT r.rated_profile_id AS profile_id, COUNT(*) AS cnt, COALESCE(SUM(r.rating_value), 0) AS total
    FROM profile_partner_ratings r
    WHERE r.rated_profile_id IN (
      SELECT DISTINCT rated_profile_id FROM profile_partner_ratings WHERE rated_by_profile_id = ?1 AND rated_profile_id <> ?1
    )
    GROUP BY r.rated_profile_id
    ORDER BY r.rated_profile_id;
  `)
  const selectRatingAggregatesForProfilesStatement = database.prepare(`
    SELECT rated_profile_id AS profile_id, COUNT(*) AS cnt, COALESCE(SUM(rating_value), 0) AS total
    FROM profile_partner_ratings
    WHERE rated_profile_id IN (SELECT value FROM json_each(?1))
    GROUP BY rated_profile_id
    ORDER BY rated_profile_id;
  `)
  const selectRatingTotalsStatement = database.prepare(`
    SELECT COUNT(*) AS cnt, COALESCE(SUM(rating_value), 0) AS total,
      COALESCE(SUM(CASE WHEN rated_profile_id = ?1 THEN 1 ELSE 0 END), 0) AS received_cnt,
      COALESCE(SUM(CASE WHEN rated_profile_id = ?1 THEN rating_value ELSE 0 END), 0) AS received_total,
      COALESCE(SUM(CASE WHEN rated_by_profile_id = ?1 OR rated_profile_id = ?1 THEN 1 ELSE 0 END), 0) AS linked_cnt
    FROM profile_partner_ratings;
  `)
  // Същата формула като playerProgressStore.refreshRatingAggregate.
  const refreshRatingCacheStatement = database.prepare(`
    UPDATE profiles
    SET average_rating = (SELECT COALESCE(AVG(rating_value), 0) FROM profile_partner_ratings WHERE rated_profile_id = profiles.profile_id),
        total_ratings_count = (SELECT COUNT(*) FROM profile_partner_ratings WHERE rated_profile_id = profiles.profile_id),
        updated_at = CURRENT_TIMESTAMP
    WHERE profile_id IN (SELECT value FROM json_each(?1));
  `)
  const countStaleRatingCachesStatement = database.prepare(`
    SELECT COUNT(*) AS cnt FROM profiles p
    WHERE p.profile_id IN (SELECT value FROM json_each(?1))
      AND (
        p.total_ratings_count <> (SELECT COUNT(*) FROM profile_partner_ratings WHERE rated_profile_id = p.profile_id)
        OR abs(p.average_rating - (SELECT COALESCE(AVG(rating_value), 0) FROM profile_partner_ratings WHERE rated_profile_id = p.profile_id)) > 1e-9
      );
  `)

  type RatingState = { affected: RatingAggregate[]; totals: { cnt: number; total: number; received_cnt: number; received_total: number } }
  function readRatingState(profileId: string): RatingState {
    return {
      affected: selectRatedByProfileAggregatesStatement.all(profileId) as RatingAggregate[],
      totals: selectRatingTotalsStatement.get(profileId) as RatingState['totals'],
    }
  }

  /** След DELETE FROM profiles: проверка + преизчисляване на кеша на засегнатите играчи. */
  function finalizePartnerRatings(before: RatingState, profileId: string): void {
    const affectedIdsJson = JSON.stringify(before.affected.map((row) => row.profile_id))
    const after = selectRatingAggregatesForProfilesStatement.all(affectedIdsJson) as RatingAggregate[]
    const totals = selectRatingTotalsStatement.get(profileId) as RatingState['totals'] & { linked_cnt: number }
    if (
      JSON.stringify(after) !== JSON.stringify(before.affected) ||
      totals.linked_cnt !== 0 ||
      totals.cnt !== before.totals.cnt - before.totals.received_cnt ||
      totals.total !== before.totals.total - before.totals.received_total
    ) {
      throw new Error('profile_deletion_partner_rating_invariant_violated')
    }
    refreshRatingCacheStatement.run(affectedIdsJson)
    if ((countStaleRatingCachesStatement.get(affectedIdsJson) as { cnt: number }).cnt !== 0) {
      throw new Error('profile_deletion_partner_rating_cache_stale')
    }
  }

  // ─── Етап 4E5: кореспонденцията с поддръжката ──────────────────────────
  const selectSupportAttachmentsStatement = database.prepare(`
    SELECT a.storage_filename
    FROM support_message_attachments a
    JOIN support_messages m ON m.message_id = a.message_id
    WHERE m.profile_id = ?1;
  `)
  const deleteSupportMessagesStatement = database.prepare(`
    DELETE FROM support_messages WHERE profile_id = ?1;
  `)
  const deleteSupportArchivedStatement = database.prepare(`
    DELETE FROM support_archived WHERE profile_id = ?1;
  `)
  // Етап 4E6C — висящото административно изтриване на същия профил се
  // приключва от самоизтриването (вариант А). Само action='delete' и само
  // за този профил; pending бан се обработва от правилото за активен бан.
  const deletePendingAdminDeleteStatement = database.prepare(`
    DELETE FROM pending_profile_moderation WHERE target_profile_id = ?1 AND action = 'delete';
  `)
  const selectSupportStateStatement = database.prepare(`
    SELECT
      (SELECT COUNT(*) FROM support_messages WHERE profile_id = ?1) AS own_messages,
      (SELECT COUNT(*) FROM support_message_attachments a JOIN support_messages m ON m.message_id = a.message_id WHERE m.profile_id = ?1) AS own_attachments,
      (SELECT COUNT(*) FROM support_archived WHERE profile_id = ?1) AS own_archived,
      (SELECT COUNT(*) FROM support_messages) AS all_messages,
      (SELECT COUNT(*) FROM support_message_attachments) AS all_attachments,
      (SELECT COUNT(*) FROM support_archived) AS all_archived;
  `)
  type SupportState = { own_messages: number; own_attachments: number; own_archived: number; all_messages: number; all_attachments: number; all_archived: number }

  function deleteSupportCorrespondence(profileId: string): SupportState {
    const before = selectSupportStateStatement.get(profileId) as SupportState
    deleteSupportMessagesStatement.run(profileId)
    deleteSupportArchivedStatement.run(profileId)
    return before
  }

  function assertSupportInvariant(before: SupportState, profileId: string): void {
    const after = selectSupportStateStatement.get(profileId) as SupportState
    if (
      after.own_messages !== 0 ||
      after.own_attachments !== 0 ||
      after.own_archived !== 0 ||
      after.all_messages !== before.all_messages - before.own_messages ||
      after.all_attachments !== before.all_attachments - before.own_attachments ||
      after.all_archived !== before.all_archived - before.own_archived
    ) {
      throw new Error('profile_deletion_support_invariant_violated')
    }
  }

  // ─── Етап 4E6B: модераторски записи ─────────────────────────────────────
  // Вече разгледаните сигнали на профила — досегашното поведение (CASCADE);
  // неразгледаните остават анонимни чрез FK SET NULL (20261029_001).
  // Същата семантика като profileBanStore.getActiveBan.
  const selectActiveBanStatement = database.prepare(`
    SELECT 1 FROM profile_bans
    WHERE profile_id = ?1 AND lifted_at IS NULL AND banned_until > CURRENT_TIMESTAMP
    LIMIT 1;
  `)
  const deleteReviewedOwnReportsStatement = database.prepare(`
    DELETE FROM topic_reports WHERE reporter_profile_id = ?1 AND status <> 'pending';
  `)
  // Очакваното състояние СЛЕД изтриването, изчислено ПРЕДИ него, и
  // действителното СЛЕД него — една и съща заявка: преди нея редовете на
  // профила се трансформират така, както каскадата/изтриването ще ги
  // промени; след нея такива редове няма и трансформацията е празна.
  // ?1 = profile_id, ?2 = JSON на изтриваните собствени теми (Б1),
  const selectModerationStateStatement = database.prepare(`
    SELECT
      (SELECT json_group_array(json_array(report_id, topic_id,
          CASE WHEN reporter_profile_id IS ?1 THEN NULL ELSE reporter_profile_id END,
          reason, status,
          reviewed_by_account_id,
          reviewed_at, created_at))
       FROM (SELECT * FROM topic_reports
             WHERE topic_id NOT IN (SELECT value FROM json_each(?2))
               AND NOT (reporter_profile_id IS ?1 AND status <> 'pending')
             ORDER BY report_id)) AS reports,
      (SELECT json_group_array(json_array(block_id, tournament_id, blocked_profile_id,
          CASE WHEN actor_profile_id IS ?1 THEN NULL ELSE actor_profile_id END,
          actor_role, reason, created_at))
       FROM (SELECT * FROM tournament_participation_blocks
             WHERE blocked_profile_id IS NOT ?1
             ORDER BY block_id)) AS blocks,
      (SELECT json_group_array(json_array(ban_id,
          CASE WHEN profile_id IS ?1 THEN NULL ELSE profile_id END,
          CASE WHEN profile_id IS ?1 THEN ?1 ELSE deleted_profile_id_snapshot END,
          banned_at, banned_until, reason,
          CASE WHEN banned_by_profile_id IS ?1 THEN NULL ELSE banned_by_profile_id END,
          lifted_at,
          CASE WHEN lifted_by_profile_id IS ?1 THEN NULL ELSE lifted_by_profile_id END))
       FROM (SELECT * FROM profile_bans ORDER BY ban_id)) AS bans,
      (SELECT json_group_array(json_array(mute_history_id, mute_audit_log_id, profile_id,
          source_topic_id, source_body_snapshot, source_attachment_storage_filename,
          source_attachment_is_evidence_copy, status, muted_until, reason_text))
       FROM (SELECT * FROM topic_mute_evidence WHERE profile_id IS NOT ?1 ORDER BY mute_history_id)) AS evidence,
      (SELECT json_group_array(json_array(topic_id, profile_id, muted_until, reason))
       FROM (SELECT * FROM topic_mutes
             WHERE profile_id IS NOT ?1 AND topic_id NOT IN (SELECT value FROM json_each(?2))
             ORDER BY topic_id, profile_id)) AS topic_mutes,
      (SELECT json_group_array(json_array(profile_id, muted_until, reason))
       FROM (SELECT * FROM topic_section_mutes WHERE profile_id IS NOT ?1 ORDER BY profile_id)) AS section_mutes,
      (SELECT json_group_array(json_array(log_id, action, topic_id,
          CASE WHEN target_profile_id IS ?1 THEN NULL ELSE target_profile_id END,
          reason, expires_at, created_at))
       FROM (SELECT * FROM topic_moderation_audit_log
             WHERE topic_id NOT IN (SELECT value FROM json_each(?2))
             ORDER BY log_id)) AS topic_audit,
      (SELECT json_group_array(json_array(log_id, message_id,
          CASE WHEN sender_profile_id IS ?1 THEN NULL ELSE sender_profile_id END,
          actor_role_at_deletion, created_at))
       FROM (SELECT * FROM lobby_chat_deletion_audit_log ORDER BY log_id)) AS lobby_audit,
      (SELECT json_group_array(json_array(pending_id, target_profile_id, action, ban_id, reason, support_request_message_id))
       FROM (SELECT * FROM pending_profile_moderation WHERE target_profile_id IS NOT ?1 ORDER BY pending_id)) AS pending;
  `)
  // Модераторски записи, които след изтриването НЕ бива да сочат към профила
  // (единствената разрешена следа е profile_bans.deleted_profile_id_snapshot).
  const countModerationLinksStatement = database.prepare(`
    SELECT
      (SELECT COUNT(*) FROM profile_bans WHERE profile_id = ?1 OR banned_by_profile_id = ?1 OR lifted_by_profile_id = ?1)
      + (SELECT COUNT(*) FROM topic_reports WHERE reporter_profile_id = ?1)
      + (SELECT COUNT(*) FROM tournament_participation_blocks WHERE blocked_profile_id = ?1 OR actor_profile_id = ?1)
      + (SELECT COUNT(*) FROM topic_mutes WHERE profile_id = ?1)
      + (SELECT COUNT(*) FROM topic_section_mutes WHERE profile_id = ?1)
      + (SELECT COUNT(*) FROM topic_mute_evidence WHERE profile_id = ?1)
      + (SELECT COUNT(*) FROM topic_mute_end_notices WHERE profile_id = ?1)
      + (SELECT COUNT(*) FROM topic_moderation_audit_log WHERE target_profile_id = ?1)
      + (SELECT COUNT(*) FROM lobby_chat_deletion_audit_log WHERE sender_profile_id = ?1)
      + (SELECT COUNT(*) FROM topic_message_deletion_audit_log WHERE sender_profile_id = ?1)
      + (SELECT COUNT(*) FROM topic_message_self_deletion_audit_log WHERE sender_profile_id = ?1)
      + (SELECT COUNT(*) FROM pending_profile_moderation WHERE target_profile_id = ?1)
      + (SELECT COUNT(*) FROM player_blocks WHERE blocker_profile_id = ?1 OR blocked_profile_id = ?1)
      + (SELECT COUNT(*) FROM admin_profile_risk_checks WHERE profile_id = ?1) AS cnt;
  `)

  type ModerationState = { expected: string; evidenceFiles: string[] }
  function readModerationState(profileId: string, ownTopicIdsJson: string): ModerationState {
    return {
      expected: JSON.stringify(selectModerationStateStatement.get(profileId, ownTopicIdsJson)),
      evidenceFiles: (selectEvidenceAttachmentsStatement.all(profileId) as Array<{ storage_filename: string; is_copy: number }>)
        .map((row) => `${row.is_copy === 1 ? 'topic_mute_evidence_attachment' : 'topic_attachment'}\n${row.storage_filename}`),
    }
  }

  function assertModerationInvariant(
    before: ModerationState,
    profileId: string,
    ownTopicIdsJson: string,
    enqueuedFiles: ReadonlySet<string>,
  ): void {
    const actual = JSON.stringify(selectModerationStateStatement.get(profileId, ownTopicIdsJson))
    if (
      actual !== before.expected ||
      (countModerationLinksStatement.get(profileId) as { cnt: number }).cnt !== 0 ||
      before.evidenceFiles.some((key) => !enqueuedFiles.has(key))
    ) {
      throw new Error('profile_deletion_moderation_invariant_violated')
    }
  }

  // Известията за кампанийни награди на изтрития — UI съобщения без одитна
  // стойност (наградата е в campaign_reward_claims); иначе остават сираци.
  const deleteCampaignRewardNotificationsStatement = database.prepare(`
    DELETE FROM campaign_reward_notifications WHERE profile_id = ?;
  `)

  const deleteProfileStatement = database.prepare(`DELETE FROM profiles WHERE profile_id = ?;`)
  const countAccountProfilesStatement = database.prepare(`SELECT COUNT(*) AS cnt FROM profiles WHERE account_id = ?;`)
  const deleteAccountStatement = database.prepare(`DELETE FROM accounts WHERE account_id = ?;`)

  // ─── Етап 4F2: административно окончателно изтриване ─────────────────────
  // Разлики спрямо самоизтриването САМО в проверките и одита: без срок, без
  // парола, без блокировките на самоизтриването (роля, активен бан, покани —
  // активната игра се проверява от извикващия/координатора); собствени
  // откази за незавършен турнир и кампаниен подател; одитен ред с log_id =
  // operationId; support архив само при изрично валидирано съобщение.
  // Реалното заличаване — същото ядро и същата опашка.
  const ADMIN_DELETE_MAX_REASON_LENGTH = 2000
  const selectAdminTargetStatement = database.prepare(`
    SELECT profile_id, account_id, created_at, profile_kind, is_temporary, avatar_url, display_name, username
    FROM profiles WHERE profile_id = ? LIMIT 1;
  `)
  const selectProfileExistsStatement = database.prepare(`SELECT 1 FROM profiles WHERE profile_id = ? LIMIT 1;`)
  const selectAdminActorAuthorizedStatement = database.prepare(ADMIN_HARD_DELETE_ACTOR_AUTHORIZED_SQL)
  // Вече насрочена операция (висящ ред, създаден от упълномощен admin при
  // schedule) — изпълнението не изисква актьорът да е още в активна сесия.
  const selectScheduledAdminDeleteStatement = database.prepare(`
    SELECT 1 FROM pending_profile_moderation
    WHERE ledger_operation_id = ? AND action = 'delete' AND target_profile_id = ?
    LIMIT 1;
  `)
  const selectSupportRequestMessageStatement = database.prepare(`
    SELECT message_id, profile_id, is_from_admin, created_at FROM support_messages WHERE message_id = ? LIMIT 1;
  `)
  // Файловата фаза започва като 'pending' — insert guard-ът на опашката
  // приема административни редове само за такъв одитен ред.
  const insertAdminAuditStatement = database.prepare(`
    INSERT INTO admin_profile_deletions (
      log_id, deleted_profile_id, deleted_account_id, username_snapshot,
      deleted_by_profile_id, reason, deleted_at, file_cleanup_status
    ) VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), 'pending');
  `)
  const insertSupportDeletionArchiveStatement = database.prepare(`
    INSERT INTO support_deletion_archives (
      archive_id, profile_id, username_snapshot, display_name_snapshot,
      request_message_id, requested_at, deleted_by_profile_id, reason, deleted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP));
  `)
  // Минимален модераторски запис (само UUID + края на активното заглушаване) —
  // досегашното административно поведение.
  const selectActiveSectionMuteStatement = database.prepare(`
    SELECT muted_until FROM topic_section_mutes
    WHERE profile_id = ? AND muted_until > CURRENT_TIMESTAMP LIMIT 1;
  `)
  const insertModerationSnapshotStatement = database.prepare(`
    INSERT INTO admin_profile_deletion_moderation_snapshots (deleted_profile_id, active_topics_mute_until)
    VALUES (?, ?)
    ON CONFLICT (deleted_profile_id) DO UPDATE SET active_topics_mute_until = excluded.active_topics_mute_until;
  `)
  const insertAdminFileStatement = database.prepare(`
    INSERT OR IGNORE INTO profile_deletion_file_queue (admin_operation_id, file_kind, storage_ref) VALUES (?, ?, ?);
  `)
  const selectAdminFilesToProcessStatement = database.prepare(`
    SELECT queue_id, request_id, admin_operation_id, file_kind, storage_ref, attempt_count
    FROM profile_deletion_file_queue
    WHERE admin_operation_id = ?1
      AND (
        (status IN ('pending', 'failed') AND attempt_count < ?2 AND (next_attempt_at IS NULL OR next_attempt_at <= ?3))
        OR (status = 'processing' AND lease_expires_at <= ?3)
      )
    ORDER BY queue_id ASC;
  `)
  const countUnfinishedAdminFilesStatement = database.prepare(`
    SELECT
      SUM(CASE WHEN status NOT IN ('done', 'skipped_shared') THEN 1 ELSE 0 END) AS unfinished,
      SUM(CASE WHEN status = 'processing' OR (status IN ('pending', 'failed') AND attempt_count < ?2) THEN 1 ELSE 0 END) AS retryable
    FROM profile_deletion_file_queue WHERE admin_operation_id = ?1;
  `)
  const selectAdminFileCleanupStatusStatement = database.prepare(`
    SELECT file_cleanup_status FROM admin_profile_deletions WHERE log_id = ? LIMIT 1;
  `)
  const markAdminFileCleanupDoneStatement = database.prepare(`
    UPDATE admin_profile_deletions SET file_cleanup_status = 'done'
    WHERE log_id = ? AND file_cleanup_status = 'pending';
  `)
  const selectAdminOperationsPendingFileCleanupStatement = database.prepare(`
    SELECT log_id, deleted_profile_id FROM admin_profile_deletions
    WHERE file_cleanup_status = 'pending'
    ORDER BY deleted_at ASC, log_id ASC;
  `)

  // ─── Файлова опашка ──────────────────────────────────────────────────────
  const selectFilesToProcessStatement = database.prepare(`
    SELECT queue_id, request_id, file_kind, storage_ref, attempt_count
    FROM profile_deletion_file_queue
    WHERE request_id = ?1
      AND (
        (status IN ('pending', 'failed') AND attempt_count < ?2 AND (next_attempt_at IS NULL OR next_attempt_at <= ?3))
        OR (status = 'processing' AND lease_expires_at <= ?3)
      )
    ORDER BY queue_id ASC;
  `)

  const claimFileStatement = database.prepare(`
    UPDATE profile_deletion_file_queue
    SET status = 'processing', lease_owner = ?1, lease_expires_at = ?2, attempt_count = attempt_count + 1, updated_at = ?3
    WHERE queue_id = ?4
      AND (
        (status IN ('pending', 'failed') AND attempt_count < ?5 AND (next_attempt_at IS NULL OR next_attempt_at <= ?3))
        OR (status = 'processing' AND lease_expires_at <= ?3)
      );
  `)

  const finishFileStatement = database.prepare(`
    UPDATE profile_deletion_file_queue
    SET status = ?1, lease_owner = NULL, lease_expires_at = NULL, completed_at = ?2, updated_at = ?3,
        last_error_code = COALESCE(?4, last_error_code), next_attempt_at = ?5,
        attempt_count = CASE WHEN ?6 = 1 THEN max(attempt_count, ?7) ELSE attempt_count END
    WHERE queue_id = ?8 AND status = 'processing' AND lease_owner = ?9;
  `)

  const countUnfinishedFilesStatement = database.prepare(`
    SELECT
      SUM(CASE WHEN status NOT IN ('done', 'skipped_shared') THEN 1 ELSE 0 END) AS unfinished,
      SUM(CASE WHEN status = 'processing' OR (status IN ('pending', 'failed') AND attempt_count < ?2) THEN 1 ELSE 0 END) AS retryable
    FROM profile_deletion_file_queue WHERE request_id = ?1;
  `)

  const sharedReferenceStatements: Record<ProfileDeletionFileKind, ReturnType<SqliteDatabase['prepare']>> = {
    avatar: database.prepare(`SELECT 1 FROM profiles WHERE avatar_url = ?1 LIMIT 1;`),
    gallery_image: database.prepare(`
      SELECT 1 FROM profile_gallery_images WHERE image_url = ?1 OR thumbnail_url = ?1
      UNION ALL SELECT 1 FROM profiles WHERE avatar_url = ?1 LIMIT 1;`),
    gallery_thumbnail: database.prepare(`
      SELECT 1 FROM profile_gallery_images WHERE image_url = ?1 OR thumbnail_url = ?1
      UNION ALL SELECT 1 FROM profiles WHERE avatar_url = ?1 LIMIT 1;`),
    chat_attachment: database.prepare(`SELECT 1 FROM friend_chat_attachments WHERE storage_filename = ?1 LIMIT 1;`),
    // Оригиналният файл може да е реферира и от evidence ред (без копие).
    topic_attachment: database.prepare(`
      SELECT 1 FROM topic_message_attachments WHERE storage_filename = ?1
      UNION ALL SELECT 1 FROM topic_mute_evidence
        WHERE source_attachment_storage_filename = ?1 AND source_attachment_is_evidence_copy = 0
      LIMIT 1;`),
    topic_mute_evidence_attachment: database.prepare(`
      SELECT 1 FROM topic_mute_evidence
      WHERE source_attachment_storage_filename = ?1 AND source_attachment_is_evidence_copy = 1 LIMIT 1;`),
    support_attachment: database.prepare(`SELECT 1 FROM support_message_attachments WHERE storage_filename = ?1 LIMIT 1;`),
  }

  function dbNow(): string {
    return (selectNowStatement.get() as { now: string }).now
  }

  function rollbackQuietly(): void {
    try { database.exec('ROLLBACK;') } catch { /* няма отворена транзакция */ }
  }

  function insertEvent(requestId: string, profileId: string, eventType: string, workerId: string | null, detail: Record<string, unknown> | null): void {
    insertEventStatement.run(requestId, profileId, eventType, workerId, detail === null ? null : JSON.stringify(detail))
  }

  function toClaimed(row: RequestRow, reclaimed: boolean, attemptCount: number): ClaimedProfileDeletionRequest {
    return {
      requestId: row.request_id,
      profileId: row.profile_id,
      accountIdSnapshot: row.account_id_snapshot,
      profileCreatedAtSnapshot: row.profile_created_at_snapshot,
      requestedAt: row.requested_at,
      scheduledFor: row.scheduled_for,
      attemptCount,
      dbDeletedAt: row.db_deleted_at,
      reclaimed,
    }
  }

  function claimNextDueRequest(workerId: string, onlyRequestId?: string): ClaimedProfileDeletionRequest | null {
    database.exec('BEGIN IMMEDIATE;')
    try {
      const now = dbNow()
      const row = selectClaimCandidateStatement.get(now, onlyRequestId ?? null) as RequestRow | undefined
      if (row === undefined) {
        database.exec('ROLLBACK;')
        return null
      }
      const result = claimStatement.run(workerId, isoPlus(now, PROFILE_DELETION_WORKER_LEASE_MS), now, row.request_id, row.status) as { changes: number }
      if (Number(result.changes) !== 1) {
        database.exec('ROLLBACK;')
        return null
      }
      const reclaimed = row.status === 'executing'
      insertEvent(row.request_id, row.profile_id, reclaimed ? 'lease_reclaimed' : 'claimed', workerId, {
        previousStatus: row.status,
        attempt: row.attempt_count + 1,
        dbDeleted: row.db_deleted_at !== null,
      })
      database.exec('COMMIT;')
      return toClaimed(row, reclaimed, row.attempt_count + 1)
    } catch (error) {
      rollbackQuietly()
      throw error
    }
  }

  /** Вика се ВЪТРЕ в отворена транзакция. */
  function releaseInTransaction(
    row: RequestRow,
    workerId: string,
    status: 'blocked' | 'failed',
    code: string,
    retry: boolean,
    now: string,
  ): boolean {
    const nextAttemptAt = retry ? isoPlus(now, computeProfileDeletionRetryDelayMs(Math.max(1, row.attempt_count))) : null
    const result = releaseStatement.run(status, nextAttemptAt, code, now, row.request_id, workerId) as { changes: number }
    if (Number(result.changes) !== 1) return false
    insertEvent(row.request_id, row.profile_id, status, workerId, { code, nextAttemptAt })
    return true
  }

  function releaseRequest(requestId: string, workerId: string, status: 'blocked' | 'failed', code: string, retryOverride?: boolean): boolean {
    database.exec('BEGIN IMMEDIATE;')
    try {
      const row = selectRequestStatement.get(requestId) as RequestRow | undefined
      if (row === undefined || row.status !== 'executing' || row.lease_owner !== workerId) {
        database.exec('ROLLBACK;')
        return false
      }
      const retry = retryOverride ?? (status === 'blocked' || row.attempt_count < PROFILE_DELETION_MAX_FAILED_ATTEMPTS)
      const released = releaseInTransaction(row, workerId, status, code, retry, dbNow())
      database.exec(released ? 'COMMIT;' : 'ROLLBACK;')
      return released
    } catch (error) {
      rollbackQuietly()
      throw error
    }
  }

  type TopicCleanupPlan = {
    /** А1: чужди преки наследници на собствени съобщения извън изтриваните теми -> нов родител (null = root). */
    reparent: Array<{ messageId: string; newParentMessageId: string | null; promotedLiveRoot: boolean }>
    /** Б1: теми на профила, които се изтриват изцяло (без резервираните). */
    ownTopicIdsToDelete: string[]
  }

  /** Вика се ВЪТРЕ в отворена транзакция (четенето и записът виждат едно и също състояние). */
  function planTopicCleanup(profileId: string): TopicCleanupPlan {
    const ownTopicIdsToDelete = (selectCreatedTopicsStatement.all(profileId) as Array<{ topic_id: string; is_general: number }>)
      .filter((topic) => topic.is_general === 0 && topic.topic_id !== LAFCHE_TOPIC_ID)
      .map((topic) => topic.topic_id)
    const deletedTopics = new Set(ownTopicIdsToDelete)

    const reparent: TopicCleanupPlan['reparent'] = []
    const children = selectForeignChildrenOfOwnMessagesStatement.all(profileId) as Array<{ message_id: string; topic_id: string; deleted_at: string | null }>
    for (const child of children) {
      if (deletedTopics.has(child.topic_id)) continue // изтрива се заедно с темата (Б1)
      // Нагоре по веригата, докато предшествениците са на профила; първият
      // чужд предшественик оцелява. Продуктът има едно ниво (root + отговори),
      // но базата позволява повече — guard срещу цикъл в данните.
      let ancestorId = (selectTopicMessageLinkStatement.get(child.message_id) as { parent_message_id: string | null }).parent_message_id
      for (let depth = 0; ancestorId !== null; depth += 1) {
        if (depth > 10_000) throw new Error('profile_deletion_topic_parent_cycle')
        const ancestor = selectTopicMessageLinkStatement.get(ancestorId) as { parent_message_id: string | null; sender_profile_id: string } | undefined
        if (ancestor === undefined || ancestor.sender_profile_id !== profileId) break
        ancestorId = ancestor.parent_message_id
      }
      reparent.push({
        messageId: child.message_id,
        newParentMessageId: ancestorId,
        promotedLiveRoot: ancestorId === null && child.deleted_at === null,
      })
    }
    return { reparent, ownTopicIdsToDelete }
  }

  type BlockerResult = { blocked: ProfileDeletionBlockCode } | null

  function findBlocker(profile: ProfileRow): BlockerResult {
    const role = profile.account_id === null
      ? null
      : (selectAccountRoleStatement.get(profile.account_id) as { role: string } | undefined)?.role ?? null
    if (protectedProfileIds.has(profile.profile_id) || role !== 'player') return { blocked: 'role_not_allowed' }
    if (participationChecks.hasActiveTournamentDependency(profile.profile_id)) return { blocked: 'active_tournament' }
    if (participationChecks.hasPendingTournamentInvite(profile.profile_id)) return { blocked: 'pending_tournament_invite' }
    if (participationChecks.hasPersistedActiveGame(profile.profile_id)) return { blocked: 'active_game' }
    if (selectCampaignGiftSenderStatement.get(profile.profile_id) !== undefined) return { blocked: 'campaign_gift_sender_protected' }
    if (selectActiveBanStatement.get(profile.profile_id) !== undefined) return { blocked: 'active_ban' }
    return null
  }

  function identityMatches(profile: ProfileRow, identity: { accountIdSnapshot: string; profileCreatedAtSnapshot: string }): boolean {
    return (
      profile.account_id !== null &&
      profile.account_id === identity.accountIdSnapshot &&
      profile.created_at === identity.profileCreatedAtSnapshot &&
      profile.profile_kind === 'human' &&
      profile.is_temporary === 0
    )
  }

  /**
   * Самото изтриване — вика се ВЪТРЕ в отворена BEGIN IMMEDIATE транзакция,
   * след проверка на идентичността и защитите. enqueue получава всеки файл,
   * който след COMMIT трябва да бъде изтрит физически.
   */
  function deleteProfileDataInTransaction(
    profile: ProfileRow,
    enqueue: (fileKind: ProfileDeletionFileKind, storageRef: string) => void,
  ): { accountDeleted: boolean; identityLinksDeleted: number; privateMatchesAnonymized: number; ludoMatchesAnonymized: number; pendingAdminDeleteResolved: number } {
    const profileId = profile.profile_id
    const topicPlan = planTopicCleanup(profileId)
    const enqueuedFiles = new Set<string>()
    const enqueueFile = enqueue
    enqueue = (fileKind, storageRef) => {
      enqueuedFiles.add(`${fileKind}\n${storageRef}`)
      enqueueFile(fileKind, storageRef)
    }
    // Етап 4E6B — очакваното състояние на модераторските записи ПРЕДИ всичко.
    const ownTopicIdsJson = JSON.stringify(topicPlan.ownTopicIdsToDelete)
    const moderationBefore = readModerationState(profileId, ownTopicIdsJson)

    if (profile.avatar_url !== null && profile.avatar_url.startsWith('/uploads/avatars/')) {
      enqueue('avatar', profile.avatar_url)
    }
    for (const row of selectGalleryStatement.all(profileId) as Array<{ image_url: string; thumbnail_url: string }>) {
      enqueue('gallery_image', row.image_url)
      if (row.thumbnail_url !== row.image_url) enqueue('gallery_thumbnail', row.thumbnail_url)
    }
    for (const row of selectChatAttachmentsStatement.all(profileId) as Array<{ storage_filename: string }>) {
      enqueue('chat_attachment', row.storage_filename)
    }
    // Етап 4E5 — файловете към support съобщенията (на потребителя и на екипа).
    for (const row of selectSupportAttachmentsStatement.all(profileId) as Array<{ storage_filename: string }>) {
      enqueue('support_attachment', row.storage_filename)
    }
    for (const row of selectTopicAttachmentsStatement.all(profileId) as Array<{ storage_filename: string }>) {
      enqueue('topic_attachment', row.storage_filename)
    }
    // Б1: файловете на ВСИЧКИ участници в изтриваните теми — преди редовете
    // им да изчезнат с темата.
    for (const topicId of topicPlan.ownTopicIdsToDelete) {
      for (const row of selectAttachmentsForTopicStatement.all(topicId) as Array<{ storage_filename: string }>) {
        enqueue('topic_attachment', row.storage_filename)
      }
    }
    for (const row of selectEvidenceAttachmentsStatement.all(profileId) as Array<{ storage_filename: string; is_copy: number }>) {
      enqueue(row.is_copy === 1 ? 'topic_mute_evidence_attachment' : 'topic_attachment', row.storage_filename)
    }

    // ─── Теми: пренасочване на чуждите наследници ПРЕДИ каскадата (А1) ───
    const deletedTopicIds = new Set(topicPlan.ownTopicIdsToDelete)
    const deletedTopicIdsJson = JSON.stringify(topicPlan.ownTopicIdsToDelete)
    const preservedTopicIdsJson = JSON.stringify(
      (selectAffectedTopicIdsStatement.all(profileId) as Array<{ topic_id: string }>)
        .map((row) => row.topic_id)
        .filter((topicId) => !deletedTopicIds.has(topicId)),
    )
    const foreignTopicMessagesBefore = (countForeignTopicMessagesStatement.get(profileId, preservedTopicIdsJson) as { cnt: number }).cnt
    const rootsToRecompute = new Set(
      (selectForeignParentsOfOwnRepliesStatement.all(profileId) as Array<{ message_id: string }>).map((row) => row.message_id),
    )
    const promotedRoots: string[] = []
    for (const move of topicPlan.reparent) {
      const moved = reparentTopicMessageStatement.run(move.newParentMessageId, move.messageId, profileId) as { changes: number }
      if (Number(moved.changes) !== 1) throw new Error('profile_deletion_topic_reparent_failed')
      if (move.newParentMessageId !== null) rootsToRecompute.add(move.newParentMessageId)
      if (move.promotedLiveRoot) promotedRoots.push(move.messageId)
    }

    // Етап 4E2 — финансовите стойности ПРЕДИ snapshot-а и DELETE-а.
    const financialTotalsBefore = readFinancialTotals(profileId)
    // Етап 4E3 — архивните редове на профила ПРЕДИ анонимизирането.
    const nameArchiveBefore = readNameArchiveState(profileId)
    // Етап 4E4 — оценките, които профилът е дал/получил, ПРЕДИ каскадата.
    const ratingStateBefore = readRatingState(profileId)
    for (const statement of attributionSnapshotStatements) statement.run(profileId)
    deleteCampaignRewardNotificationsStatement.run(profileId)
    for (const statement of anonymizeStatements) statement.run(profileId)
    for (const statement of deleteWithoutFkStatements) statement.run(profileId)
    // Етап 4E5 — кореспонденцията с поддръжката (без FK към profiles).
    const supportBefore = deleteSupportCorrespondence(profileId)
    // Етап 4E6C — висящото административно изтриване на същия профил е
    // приключено от тази процедура (изрично, не чрез каскадата).
    const pendingAdminDeleteResolved = Number((deletePendingAdminDeleteStatement.run(profileId) as { changes: number }).changes)
    // Етап 4E6B — вече разгледаните сигнали на профила (неразгледаните
    // остават анонимни чрез FK SET NULL при DELETE FROM profiles).
    deleteReviewedOwnReportsStatement.run(profileId)

    // Risk cache на свързаните профили (mirror на hard delete) — само маркер.
    const visitorIds = [...(linkReader.findVisitorIdsForProfiles([profileId]).get(profileId) ?? [])]
    if (visitorIds.length > 0) {
      const affected = new Set<string>()
      for (const ids of linkReader.findProfilesForVisitorIds(visitorIds).values()) {
        for (const id of ids) if (id !== profileId) affected.add(id)
      }
      if (affected.size > 0) {
        const list = [...affected]
        database.prepare(`UPDATE admin_profile_risk_checks SET check_complete = 0 WHERE profile_id IN (${list.map(() => '?').join(', ')});`).run(...list)
      }
    }

    // Етап 4E1 — след risk cache-а (той чете visitor връзките по-горе).
    let identityLinksDeleted = 0
    for (const statement of deleteIdentityLinkStatements) {
      identityLinksDeleted += Number((statement.run(profileId) as { changes: number }).changes)
    }
    const privateMatchesAnonymized = anonymizePrivateRoomMatches(profileId)
    const ludoMatchesAnonymized = anonymizeLudoMatches(profileId)

    // Б1: темите на профила — изцяло, вкл. чуждите публикации (каскада от
    // topics: съобщения, отговори, файлови редове, харесвания, read state,
    // mutes, reports, root агрегати).
    for (const topicId of topicPlan.ownTopicIdsToDelete) {
      deleteTopicModerationAuditStatement.run(topicId)
      const deleted = deleteOwnTopicStatement.run(topicId, profileId, LAFCHE_TOPIC_ID) as { changes: number }
      if (Number(deleted.changes) !== 1) throw new Error('profile_deletion_own_topic_delete_failed')
    }

    deleteProfileStatement.run(profileId)
    // Етап 4E2 — след SET NULL каскадата: атрибуцията е под snapshot-а, нищо
    // не е изгубено/дублирано (иначе ROLLBACK).
    assertFinancialInvariant(financialTotalsBefore, profileId)
    // Етап 4E3 — имената в историята/архива са заличени, нищо друго не е пипнато.
    assertNameArchiveInvariant(nameArchiveBefore, profileId)
    // Етап 4E4 — дадените оценки са анонимни и в сила, кешът е коректен.
    finalizePartnerRatings(ratingStateBefore, profileId)
    // Етап 4E5 — нищо от поддръжката не сочи към профила; чуждото е непокътнато.
    assertSupportInvariant(supportBefore, profileId)
    // Етап 4E6B — модераторските записи: точно очакваното, без връзки към
    // профила, файловете на доказателствата му — в опашката.
    assertModerationInvariant(moderationBefore, profileId, ownTopicIdsJson, enqueuedFiles)

    // Инварианти преди COMMIT — нарушение = ROLLBACK (failed, повторен опит).
    const foreignTopicMessagesAfter = (countForeignTopicMessagesStatement.get(profileId, preservedTopicIdsJson) as { cnt: number }).cnt
    if (foreignTopicMessagesAfter !== foreignTopicMessagesBefore) {
      throw new Error('profile_deletion_foreign_topic_messages_changed')
    }
    if ((countCrossTopicParentLinksStatement.get(preservedTopicIdsJson) as { cnt: number }).cnt !== 0) {
      throw new Error('profile_deletion_cross_topic_parent_link')
    }
    if (
      (countTopicsStatement.get(deletedTopicIdsJson) as { cnt: number }).cnt !== 0 ||
      (countTopicMessagesInTopicsStatement.get(deletedTopicIdsJson) as { cnt: number }).cnt !== 0
    ) {
      throw new Error('profile_deletion_own_topic_not_removed')
    }
    for (const rootMessageId of rootsToRecompute) recomputeRootLatestSeqStatement.run(rootMessageId)
    for (const rootMessageId of promotedRoots) upsertPromotedRootLatestSeqStatement.run(rootMessageId)

    let accountDeleted = false
    if (profile.account_id !== null) {
      const remaining = (countAccountProfilesStatement.get(profile.account_id) as { cnt: number }).cnt
      if (remaining === 0) {
        deleteAccountStatement.run(profile.account_id)
        accountDeleted = true
      }
    }
    return { accountDeleted, identityLinksDeleted, privateMatchesAnonymized, ludoMatchesAnonymized, pendingAdminDeleteResolved }
  }

  function executeAdminHardDelete(input: AdminHardDeleteInput): AdminHardDeleteResult {
    if (input.targetProfileId === input.actorProfileId) return { ok: false, code: 'self' }
    const reason = input.reason.trim()
    if (reason.length === 0 || reason.length > ADMIN_DELETE_MAX_REASON_LENGTH) return { ok: false, code: 'invalid_reason' }
    const operationId = input.auditLogId ?? randomUUID()

    database.exec('BEGIN IMMEDIATE;')
    try {
      const target = selectAdminTargetStatement.get(input.targetProfileId) as (ProfileRow & { display_name: string; username: string | null }) | undefined
      if (target === undefined) {
        database.exec('ROLLBACK;')
        return { ok: false, code: 'not_found' }
      }
      if (target.profile_id === input.actorProfileId) {
        database.exec('ROLLBACK;')
        return { ok: false, code: 'self' }
      }
      // Етап 4F2A — само admin. Replay повтаря вече ЗАВЪРШЕНА (доказана в
      // регистъра) операция; насрочената е упълномощена при schedule.
      if (input.replay === undefined) {
        const scheduled = input.auditLogId !== undefined
          && selectScheduledAdminDeleteStatement.get(input.auditLogId, target.profile_id) !== undefined
        if (!scheduled && selectAdminActorAuthorizedStatement.get(input.actorAccountId, input.actorProfileId) === undefined) {
          database.exec('ROLLBACK;')
          return { ok: false, code: 'forbidden' }
        }
      }
      // Незавършен турнир / кампаниен подател — отказ без частични промени
      // (досегашните административни правила; провереят се в writer lock-а).
      if (participationChecks.hasActiveTournamentDependency(target.profile_id)) {
        database.exec('ROLLBACK;')
        return { ok: false, code: 'active_tournament_dependency' }
      }
      if (selectCampaignGiftSenderStatement.get(target.profile_id) !== undefined) {
        database.exec('ROLLBACK;')
        return { ok: false, code: 'campaign_gift_sender_protected' }
      }

      // Support заявка: само изрично подадено и валидирано потребителско
      // съобщение на target-а (при replay липсващото съобщение -> без архив).
      let validatedSupportRequest: { message_id: string; created_at: string } | null = null
      if (input.supportRequestMessageId != null && input.supportRequestMessageId !== '') {
        const message = selectSupportRequestMessageStatement.get(input.supportRequestMessageId) as
          | { message_id: string; profile_id: string; is_from_admin: number; created_at: string }
          | undefined
        const isValid = message !== undefined && message.profile_id === target.profile_id && message.is_from_admin === 0
        if (!isValid && input.replay === undefined) {
          database.exec('ROLLBACK;')
          return { ok: false, code: 'invalid_support_request_message' }
        }
        validatedSupportRequest = isValid && message !== undefined ? { message_id: message.message_id, created_at: message.created_at } : null
      }

      const actorProfileId = input.replay !== undefined && selectProfileExistsStatement.get(input.actorProfileId) === undefined
        ? null
        : input.actorProfileId
      const deletedAt = input.replay?.deletedAt ?? null
      const usernameSnapshot = target.username?.trim() || target.display_name

      // Одитният ред ПРЕДИ заличаването, в същата транзакция.
      insertAdminAuditStatement.run(operationId, target.profile_id, target.account_id, usernameSnapshot, actorProfileId, reason, deletedAt)
      if (validatedSupportRequest !== null) {
        insertSupportDeletionArchiveStatement.run(
          randomUUID(),
          target.profile_id,
          usernameSnapshot,
          target.display_name,
          validatedSupportRequest.message_id,
          validatedSupportRequest.created_at,
          actorProfileId,
          reason,
          deletedAt,
        )
      }
      const activeMute = selectActiveSectionMuteStatement.get(target.profile_id) as { muted_until: string } | undefined
      if (activeMute !== undefined) insertModerationSnapshotStatement.run(target.profile_id, activeMute.muted_until)

      // Същото ядро и същата опашка като самоизтриването.
      let enqueuedFileCount = 0
      const { accountDeleted } = deleteProfileDataInTransaction(target, (fileKind, storageRef) => {
        enqueuedFileCount += Number((insertAdminFileStatement.run(operationId, fileKind, storageRef) as { changes: number }).changes)
      })
      // Без файлове файловата фаза е приключила веднага.
      if (enqueuedFileCount === 0) markAdminFileCleanupDoneStatement.run(operationId)

      options.testHooks?.beforeAdminCommit?.(operationId)
      database.exec('COMMIT;')
      return {
        ok: true,
        deletedProfileId: target.profile_id,
        deletedAccountId: accountDeleted ? target.account_id : null,
        operationId,
        enqueuedFileCount,
      }
    } catch (error) {
      rollbackQuietly()
      // Последната защита в базата (20261013_001).
      if (error instanceof Error && error.message.includes('campaign_gift_sender_protected')) {
        return { ok: false, code: 'campaign_gift_sender_protected' }
      }
      throw error
    }
  }

  function runDatabasePhase(request: ClaimedProfileDeletionRequest, workerId: string): ProfileDeletionDbPhaseResult {
    database.exec('BEGIN IMMEDIATE;')
    let row: RequestRow | undefined
    try {
      const now = dbNow()
      row = selectRequestStatement.get(request.requestId) as RequestRow | undefined
      if (
        row === undefined ||
        row.status !== 'executing' ||
        row.lease_owner !== workerId ||
        row.lease_expires_at === null ||
        row.lease_expires_at <= now
      ) {
        database.exec('ROLLBACK;')
        return { kind: 'lease_lost' }
      }
      if (row.db_deleted_at !== null) {
        database.exec('ROLLBACK;')
        return { kind: 'already_db_deleted' }
      }
      if (row.scheduled_for > now) {
        // Невъзможно при тригера за pending -> executing; защита в дълбочина.
        database.exec('ROLLBACK;')
        return { kind: 'lease_lost' }
      }
      if (selectCancellationStatement.get(row.request_id) !== undefined) {
        // Етап 4J1 — невъзможно (claim и тригерът го изключват); защита в дълбочина.
        const released = releaseInTransaction(row, workerId, 'blocked', 'cancellation_pending', false, now)
        database.exec(released ? 'COMMIT;' : 'ROLLBACK;')
        return released ? { kind: 'blocked', code: 'cancellation_pending' } : { kind: 'lease_lost' }
      }

      const profile = selectProfileStatement.get(row.profile_id) as ProfileRow | undefined
      if (profile === undefined) {
        if (selectAdminDeletionStatement.get(row.profile_id) !== undefined) {
          // Профилът вече е изтрит от администратор през периода за отмяна.
          markDbDeletedStatement.run(now, isoPlus(now, PROFILE_DELETION_WORKER_LEASE_MS), row.request_id, workerId)
          insertEvent(row.request_id, row.profile_id, 'db_deleted', workerId, { files: 0, accountDeleted: false, alreadyDeletedByAdmin: true })
          database.exec('COMMIT;')
          return { kind: 'db_deleted', enqueuedFileCount: 0, accountDeleted: false, alreadyDeletedByAdmin: true, dbDeletedAt: now }
        }
        const released = releaseInTransaction(row, workerId, 'failed', 'identity_profile_missing', false, now)
        database.exec(released ? 'COMMIT;' : 'ROLLBACK;')
        return released ? { kind: 'failed', code: 'identity_profile_missing', willRetry: false } : { kind: 'lease_lost' }
      }
      if (!identityMatches(profile, { accountIdSnapshot: row.account_id_snapshot, profileCreatedAtSnapshot: row.profile_created_at_snapshot })) {
        const released = releaseInTransaction(row, workerId, 'failed', 'identity_mismatch', false, now)
        database.exec(released ? 'COMMIT;' : 'ROLLBACK;')
        return released ? { kind: 'failed', code: 'identity_mismatch', willRetry: false } : { kind: 'lease_lost' }
      }

      const blocker = findBlocker(profile)
      if (blocker !== null) {
        const released = releaseInTransaction(row, workerId, 'blocked', blocker.blocked, true, now)
        database.exec(released ? 'COMMIT;' : 'ROLLBACK;')
        return released ? { kind: 'blocked', code: blocker.blocked } : { kind: 'lease_lost' }
      }

      let enqueuedFileCount = 0
      const requestId = row.request_id
      const deletion = deleteProfileDataInTransaction(profile, (fileKind, storageRef) => {
        const result = insertFileStatement.run(requestId, fileKind, storageRef) as { changes: number }
        enqueuedFileCount += Number(result.changes)
      })
      const { accountDeleted } = deletion

      const marked = markDbDeletedStatement.run(now, isoPlus(now, PROFILE_DELETION_WORKER_LEASE_MS), row.request_id, workerId) as { changes: number }
      if (Number(marked.changes) !== 1) throw new Error('profile_deletion_mark_db_deleted_failed')
      insertEvent(row.request_id, row.profile_id, 'db_deleted', workerId, {
        files: enqueuedFileCount,
        accountDeleted,
        alreadyDeletedByAdmin: false,
        identityLinks: deletion.identityLinksDeleted,
        privateMatches: deletion.privateMatchesAnonymized,
        ludoMatches: deletion.ludoMatchesAnonymized,
        pendingAdminDeleteResolved: deletion.pendingAdminDeleteResolved,
      })
      if (enqueuedFileCount > 0) insertEvent(row.request_id, row.profile_id, 'file_enqueued', workerId, { count: enqueuedFileCount })

      options.testHooks?.beforeDatabasePhaseCommit?.(row.request_id)
      database.exec('COMMIT;')
      return { kind: 'db_deleted', enqueuedFileCount, accountDeleted, alreadyDeletedByAdmin: false, dbDeletedAt: now }
    } catch (error) {
      rollbackQuietly()
      // Само за тестове: симулиран срив на процеса — заявката остава
      // executing с висящ lease (точно като при истински срив/рестарт).
      if ((error as { profileDeletionSimulatedCrash?: boolean } | null)?.profileDeletionSimulatedCrash === true) {
        throw error
      }
      // Защитата в базата (20261013_001) е последната линия за кампанийни подаръци.
      if (error instanceof Error && error.message.includes('campaign_gift_sender_protected')) {
        return releaseRequest(request.requestId, workerId, 'blocked', 'campaign_gift_sender_protected')
          ? { kind: 'blocked', code: 'campaign_gift_sender_protected' }
          : { kind: 'lease_lost' }
      }
      const willRetry = (row?.attempt_count ?? PROFILE_DELETION_MAX_FAILED_ATTEMPTS) < PROFILE_DELETION_MAX_FAILED_ATTEMPTS
      return releaseRequest(request.requestId, workerId, 'failed', 'db_phase_error', willRetry)
        ? { kind: 'failed', code: 'db_phase_error', willRetry }
        : { kind: 'lease_lost' }
    }
  }

  function extendLease(requestId: string, workerId: string): boolean {
    const now = dbNow()
    const result = extendLeaseStatement.run(isoPlus(now, PROFILE_DELETION_WORKER_LEASE_MS), now, requestId, workerId) as { changes: number }
    return Number(result.changes) === 1
  }

  function listFilesToProcess(requestId: string): ProfileDeletionQueuedFile[] {
    return (selectFilesToProcessStatement.all(requestId, PROFILE_DELETION_MAX_FILE_ATTEMPTS, dbNow()) as Array<{
      queue_id: number
      request_id: string
      file_kind: ProfileDeletionFileKind
      storage_ref: string
      attempt_count: number
    }>).map((row) => ({
      queueId: row.queue_id,
      requestId: row.request_id,
      adminOperationId: null,
      fileKind: row.file_kind,
      storageRef: row.storage_ref,
      attemptCount: row.attempt_count,
    }))
  }

  function listAdminFilesToProcess(operationId: string): ProfileDeletionQueuedFile[] {
    return (selectAdminFilesToProcessStatement.all(operationId, PROFILE_DELETION_MAX_FILE_ATTEMPTS, dbNow()) as Array<{
      queue_id: number
      admin_operation_id: string
      file_kind: ProfileDeletionFileKind
      storage_ref: string
      attempt_count: number
    }>).map((row) => ({
      queueId: row.queue_id,
      requestId: null,
      adminOperationId: row.admin_operation_id,
      fileKind: row.file_kind,
      storageRef: row.storage_ref,
      attemptCount: row.attempt_count,
    }))
  }

  function listAdminOperationsPendingFileCleanup(): Array<{ operationId: string; profileId: string }> {
    return (selectAdminOperationsPendingFileCleanupStatement.all() as Array<{ log_id: string; deleted_profile_id: string }>)
      .map((row) => ({ operationId: row.log_id, profileId: row.deleted_profile_id }))
  }

  function finishAdminFileCleanup(operationId: string): AdminFileCleanupFinishResult {
    database.exec('BEGIN IMMEDIATE;')
    try {
      const row = selectAdminFileCleanupStatusStatement.get(operationId) as { file_cleanup_status: string | null } | undefined
      if (row === undefined || row.file_cleanup_status !== 'pending') {
        database.exec('ROLLBACK;')
        return { kind: 'not_pending' }
      }
      const counts = countUnfinishedAdminFilesStatement.get(operationId, PROFILE_DELETION_MAX_FILE_ATTEMPTS) as { unfinished: number | null; retryable: number | null }
      if ((counts.unfinished ?? 0) > 0) {
        database.exec('ROLLBACK;')
        return { kind: 'files_pending', willRetry: (counts.retryable ?? 0) > 0 }
      }
      markAdminFileCleanupDoneStatement.run(operationId)
      database.exec('COMMIT;')
      return { kind: 'done' }
    } catch (error) {
      rollbackQuietly()
      throw error
    }
  }

  function claimFile(queueId: number, workerId: string): boolean {
    const now = dbNow()
    const result = claimFileStatement.run(workerId, isoPlus(now, PROFILE_DELETION_FILE_LEASE_MS), now, queueId, PROFILE_DELETION_MAX_FILE_ATTEMPTS) as { changes: number }
    return Number(result.changes) === 1
  }

  function isStorageRefReferenced(fileKind: ProfileDeletionFileKind, storageRef: string): boolean {
    return sharedReferenceStatements[fileKind].get(storageRef) !== undefined
  }

  function finishFile(
    file: ProfileDeletionQueuedFile,
    workerId: string,
    profileId: string,
    status: 'done' | 'skipped_shared' | 'failed',
    eventType: 'file_deleted' | 'file_skipped_shared' | 'file_failed',
    detail: Record<string, unknown>,
    errorCode: string | null,
    permanent: boolean,
  ): boolean {
    database.exec('BEGIN IMMEDIATE;')
    try {
      const now = dbNow()
      const attempt = file.attemptCount + 1
      const nextAttemptAt = status === 'failed' && !permanent ? isoPlus(now, computeProfileDeletionRetryDelayMs(attempt)) : null
      const result = finishFileStatement.run(
        status,
        status === 'failed' ? null : now,
        now,
        errorCode,
        nextAttemptAt,
        permanent ? 1 : 0,
        PROFILE_DELETION_MAX_FILE_ATTEMPTS,
        file.queueId,
        workerId,
      ) as { changes: number }
      if (Number(result.changes) !== 1) {
        database.exec('ROLLBACK;')
        return false
      }
      // Журналът е по заявка (FK); административните файлови редове се
      // диагностицират от самата опашка (статус, опити, last_error_code).
      if (file.requestId !== null) {
        insertEvent(file.requestId, profileId, eventType, workerId, { queueId: file.queueId, kind: file.fileKind, ...detail })
      }
      database.exec('COMMIT;')
      return true
    } catch (error) {
      rollbackQuietly()
      throw error
    }
  }

  function finishRequest(requestId: string, workerId: string): ProfileDeletionFinishResult {
    database.exec('BEGIN IMMEDIATE;')
    try {
      const now = dbNow()
      const row = selectRequestStatement.get(requestId) as RequestRow | undefined
      if (row === undefined || row.status !== 'executing' || row.lease_owner !== workerId || row.db_deleted_at === null) {
        database.exec('ROLLBACK;')
        return { kind: 'lease_lost' }
      }
      const counts = countUnfinishedFilesStatement.get(requestId, PROFILE_DELETION_MAX_FILE_ATTEMPTS) as { unfinished: number | null; retryable: number | null }
      if ((counts.unfinished ?? 0) === 0) {
        const result = completeStatement.run(now, requestId, workerId) as { changes: number }
        if (Number(result.changes) !== 1) {
          database.exec('ROLLBACK;')
          return { kind: 'lease_lost' }
        }
        insertEvent(requestId, row.profile_id, 'completed', workerId, null)
        database.exec('COMMIT;')
        return { kind: 'completed' }
      }
      const willRetry = (counts.retryable ?? 0) > 0
      const released = releaseInTransaction(row, workerId, 'failed', 'files_pending', willRetry, now)
      database.exec(released ? 'COMMIT;' : 'ROLLBACK;')
      return released ? { kind: 'files_pending', willRetry } : { kind: 'lease_lost' }
    } catch (error) {
      rollbackQuietly()
      throw error
    }
  }

  function replayDeletionForRestore(
    identity: { profileId: string; accountIdSnapshot: string; profileCreatedAtSnapshot: string },
    hooks: { beforeCommit?: (files: Array<{ fileKind: ProfileDeletionFileKind; storageRef: string }>) => void } = {},
  ): ProfileDeletionReplayResult {
    database.exec('BEGIN IMMEDIATE;')
    try {
      const profile = selectProfileStatement.get(identity.profileId) as ProfileRow | undefined
      if (profile === undefined) {
        database.exec('ROLLBACK;')
        return { kind: 'absent' }
      }
      if (!identityMatches(profile, identity)) {
        database.exec('ROLLBACK;')
        return { kind: 'identity_mismatch' }
      }
      const blocker = findBlocker(profile)
      if (blocker !== null) {
        database.exec('ROLLBACK;')
        return { kind: 'blocked', code: blocker.blocked }
      }
      const files: Array<{ fileKind: ProfileDeletionFileKind; storageRef: string }> = []
      const seen = new Set<string>()
      const { accountDeleted } = deleteProfileDataInTransaction(profile, (fileKind, storageRef) => {
        const key = `${fileKind}\n${storageRef}`
        if (!seen.has(key)) {
          seen.add(key)
          files.push({ fileKind, storageRef })
        }
      })
      // Процедурата след restore записва файловете в собствен журнал ПРЕДИ
      // COMMIT — при срив след COMMIT те не "изчезват" (редовете вече ги няма).
      hooks.beforeCommit?.(files)
      database.exec('COMMIT;')
      return { kind: 'deleted', files, accountDeleted }
    } catch (error) {
      rollbackQuietly()
      throw error
    }
  }

  const prepareBlockedOrFailedForRestoreStatement = database.prepare(`
    UPDATE profile_deletion_requests SET next_attempt_at = ?1, updated_at = ?1
    WHERE request_id = ?2 AND status IN ('blocked', 'failed');
  `)
  const prepareExecutingForRestoreStatement = database.prepare(`
    UPDATE profile_deletion_requests SET lease_expires_at = ?1, updated_at = ?2
    WHERE request_id = ?3 AND status = 'executing';
  `)

  function prepareRequestForRestoreReconcile(requestId: string): boolean {
    database.exec('BEGIN IMMEDIATE;')
    try {
      const now = dbNow()
      const a = prepareBlockedOrFailedForRestoreStatement.run(now, requestId) as { changes: number }
      const b = prepareExecutingForRestoreStatement.run(isoPlus(now, -1), now, requestId) as { changes: number }
      database.exec('COMMIT;')
      return Number(a.changes) + Number(b.changes) > 0
    } catch (error) {
      rollbackQuietly()
      throw error
    }
  }

  function applyRecordedCancellation(requestId: string, workerId: string, record: ProfileDeletionRequestCancelledRecord): boolean {
    database.exec('BEGIN IMMEDIATE;')
    try {
      const row = selectRequestStatement.get(requestId) as RequestRow | undefined
      if (
        row === undefined || row.status !== 'executing' || row.lease_owner !== workerId ||
        row.db_deleted_at !== null || row.profile_id !== record.profileId || record.requestId !== requestId
      ) {
        database.exec('ROLLBACK;')
        return false
      }
      if (!releaseInTransaction(row, workerId, 'blocked', 'cancellation_recorded', false, dbNow())) {
        database.exec('ROLLBACK;')
        return false
      }
      insertRecoveredCancellationStatement.run(
        /^[A-Za-z0-9_.:-]{1,64}$/.test(record.cancellationId) ? record.cancellationId : randomUUID(),
        requestId,
        row.profile_id,
        record.source,
      )
      database.exec('COMMIT;')
      return true
    } catch (error) {
      rollbackQuietly()
      throw error
    }
  }

  return {
    claimNextDueRequest,
    runDatabasePhase,
    applyRecordedCancellation,
    blockRequest: (requestId, workerId, code) => releaseRequest(requestId, workerId, 'blocked', code),
    failRequest: (requestId, workerId, code) => releaseRequest(requestId, workerId, 'failed', code),
    extendLease,
    listFilesToProcess,
    claimFile,
    isStorageRefReferenced,
    markFileDone: (file, workerId, profileId, outcome) =>
      finishFile(file, workerId, profileId, 'done', 'file_deleted', { outcome }, null, false),
    markFileSkippedShared: (file, workerId, profileId) =>
      finishFile(file, workerId, profileId, 'skipped_shared', 'file_skipped_shared', {}, null, false),
    markFileFailed: (file, workerId, profileId, code, permanent) =>
      finishFile(file, workerId, profileId, 'failed', 'file_failed', { code, permanent }, code.slice(0, 200), permanent),
    finishRequest,
    replayDeletionForRestore,
    prepareRequestForRestoreReconcile,
    executeAdminHardDelete,
    listAdminFilesToProcess,
    listAdminOperationsPendingFileCleanup,
    finishAdminFileCleanup,
    close: () => database.close(),
  }
}
