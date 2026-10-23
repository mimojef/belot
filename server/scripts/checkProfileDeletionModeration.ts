/**
 * checkProfileDeletionModeration.ts
 *
 * Самоизтриване, Етап 4E6B — модераторски записи при окончателно изтриване
 * (миграция 20261029_001):
 *   * активен бан: заявка не може да се подаде; бан след подаването отлага
 *     окончателното изтриване ('active_ban') до изтичането/премахването му;
 *     изтекъл/премахнат бан и заглушаване НЕ блокират; банът остава като
 *     минимална следа (без profile_id, само псевдонимен UUID) и не може да
 *     засегне друг/нов профил;
 *   * неразгледаните сигнали на изтрития остават без подател; вече
 *     разгледаните се изтриват (досегашното поведение);
 *   * турнирна блокировка, наложена от изтрития, остава (actor = NULL);
 *     блокировката на самия изтрит изчезва;
 *   * заглушаванията и доказателствата на изтрития изчезват, файловете им
 *     минават през защитената опашка;
 *   * административното изтриване запазва досегашното си поведение.
 * САМО временни бази.
 *
 * [U] Upgrade на миграцията.  [M] Модераторски записи.  [P] Процес.
 * [H] Административно изтриване.
 */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'
import { createPlayerProgressStore } from '../src/db/playerProgressStore.js'
import { createAuthStore } from '../src/db/authStore.js'
import { createProfileBanStore } from '../src/db/profileBanStore.js'
import { createTopicModerationStore } from '../src/db/topicModerationStore.js'
import { createProfileDeletionExecutor, type ProfileDeletionExecutor } from '../src/db/profileDeletionExecutor.js'
import { createProfileDeletionRequestStore } from '../src/db/profileDeletionRequestStore.js'
import { createProfileHardDeleteService } from '../src/db/profileHardDeleteService.js'
import { PROFILE_DELETION_GRACE_PERIOD_MS } from '../src/db/profileDeletionSchedule.js'
import { createProfileDeletionWorker } from '../src/core/profileDeletionWorker.js'
import { removeProfileDeletionFile, type ProfileDeletionUploadRoots } from '../src/uploads/profileDeletionFileRemoval.js'

type SqliteDatabase = InstanceType<typeof import('node:sqlite').DatabaseSync>

let passed = 0
let failed = 0
async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    passed += 1
    console.log(`  PASS  ${label}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL  ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}
function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message}: очаквано ${String(expected)}, получено ${String(actual)}`)
}
function assertThrows(fn: () => unknown, fragment: string, message: string): void {
  try {
    fn()
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    if (!text.includes(fragment)) throw new Error(`${message}: очаквана грешка "${fragment}", получена "${text}"`)
    return
  }
  throw new Error(`${message}: не беше отхвърлено`)
}

const sourceServerRoot = resolve(process.argv.slice(2).find((arg) => arg.startsWith('--server-root='))?.slice('--server-root='.length) ?? process.cwd())
const SECRET = 'profile-deletion-moderation-secret-0123456789'
const NEW_MIGRATION = '20261029_001_preserve_anonymous_moderation_records.sql'
const HOUR_MS = 60 * 60 * 1000

console.log('\ncheckProfileDeletionModeration')

const tempRoots: string[] = []
async function createTempServerRoot(filter: (name: string) => boolean): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'belot-profile-deletion-moderation-'))
  tempRoots.push(root)
  await mkdir(join(root, 'database', 'migrations'), { recursive: true })
  await mkdir(join(root, 'database', 'data'), { recursive: true })
  for (const entry of await readdir(join(sourceServerRoot, 'database', 'migrations'), { withFileTypes: true })) {
    if (entry.isFile() && extname(entry.name).toLowerCase() === '.sql' && filter(entry.name)) {
      await cp(join(sourceServerRoot, 'database', 'migrations', entry.name), join(root, 'database', 'migrations', entry.name))
    }
  }
  return root
}

const sqliteModule = await import('node:sqlite')

try {
  console.log('\n[U] Миграция 20261029_001')

  await check('[U1] Upgrade със съществуващи сигнали и блокировки: стойностите са запазени; FK SET NULL/CASCADE, CHECK, UNIQUE, индекси и тригери са налице; FK проверката е чиста', async () => {
    const oldRoot = await createTempServerRoot((name) => name !== NEW_MIGRATION)
    const { databaseFilePath: oldPath } = await ensureServerDatabaseReady({ serverRootOverride: oldRoot })
    const old = new sqliteModule.DatabaseSync(oldPath, { open: true, enableForeignKeyConstraints: true })
    const ids = [randomUUID(), randomUUID()]
    for (const [index, id] of ids.entries()) {
      old.prepare(`INSERT INTO profiles (profile_id, display_name, normalized_display_name) VALUES (?, ?, ?);`).run(id, `Up${index}`, `up${index}`)
    }
    old.prepare(`INSERT INTO topics (topic_id, slug, title, created_by_profile_id) VALUES ('t-up', 't-up', 'Тема', NULL);`).run()
    old.prepare(`INSERT INTO topic_reports (report_id, topic_id, reporter_profile_id, reason, status, created_at) VALUES ('r1', 't-up', ?, 'спам', 'pending', '2026-05-01 10:00:00');`).run(ids[0])
    old.prepare(`INSERT INTO topic_reports (report_id, topic_id, reporter_profile_id, reason, status, reviewed_at, created_at) VALUES ('r2', 't-up', ?, 'обида', 'reviewed', '2026-05-02 10:00:00', '2026-05-01 11:00:00');`).run(ids[1])
    old.prepare(`INSERT INTO tournaments (tournament_id, name, entry_fee, start_mode, status, creator_profile_id) VALUES ('tour-up', 'Т', 100, 'fill', 'finished', ?);`).run(ids[0])
    old.prepare(`INSERT INTO tournament_participation_blocks (block_id, tournament_id, blocked_profile_id, actor_profile_id, actor_role, reason, created_at) VALUES ('b1', 'tour-up', ?, ?, 'player', 'неспортсменско', '2026-05-03 10:00:00');`).run(ids[1], ids[0])
    const dump = (db: SqliteDatabase) => JSON.stringify([
      db.prepare('SELECT * FROM topic_reports ORDER BY report_id;').all(),
      db.prepare('SELECT * FROM tournament_participation_blocks ORDER BY block_id;').all(),
    ])
    const before = dump(old)
    old.close()
    await cp(join(sourceServerRoot, 'database', 'migrations', NEW_MIGRATION), join(oldRoot, 'database', 'migrations', NEW_MIGRATION))
    await ensureServerDatabaseReady({ serverRootOverride: oldRoot })
    const up = new sqliteModule.DatabaseSync(oldPath, { readOnly: true })
    try {
      assertEqual(dump(up), before, 'стойности')
      const fks = (table: string) => JSON.stringify(up.prepare(`SELECT "from", "table", on_delete FROM pragma_foreign_key_list(?) ORDER BY "from";`).all(table))
      assertEqual(fks('topic_reports'), JSON.stringify([
        { from: 'reporter_profile_id', table: 'profiles', on_delete: 'SET NULL' },
        { from: 'reviewed_by_account_id', table: 'accounts', on_delete: 'SET NULL' },
        { from: 'topic_id', table: 'topics', on_delete: 'CASCADE' },
      ]), 'FK на сигналите')
      assertEqual(fks('tournament_participation_blocks'), JSON.stringify([
        { from: 'actor_profile_id', table: 'profiles', on_delete: 'SET NULL' },
        { from: 'blocked_profile_id', table: 'profiles', on_delete: 'CASCADE' },
        { from: 'tournament_id', table: 'tournaments', on_delete: 'CASCADE' },
      ]), 'FK на блокировките')
      const objects = (up.prepare(`SELECT name FROM sqlite_master WHERE tbl_name IN ('topic_reports', 'tournament_participation_blocks') AND type IN ('index', 'trigger') ORDER BY name;`).all() as Array<{ name: string }>).map((row) => row.name)
      for (const name of ['idx_topic_reports_status_created', 'idx_topic_reports_reporter_topic', 'trg_topic_reports_reporter_required', 'trg_topic_reports_reporter_immutable', 'trg_tournament_participation_blocks_actor_required', 'trg_tournament_participation_blocks_actor_immutable']) {
        assert(objects.includes(name), `липсва ${name}`)
      }
      assert(objects.some((name) => name.startsWith('sqlite_autoindex_tournament_participation_blocks')), 'UNIQUE на блокировките')
      const tableSql = (up.prepare(`SELECT sql FROM sqlite_master WHERE name = 'topic_reports';`).get() as { sql: string }).sql
      assert(tableSql.includes("status IN ('pending', 'reviewed', 'dismissed')") && tableSql.includes("trim(reason) <> ''"), 'CHECK на сигналите')
      assertEqual((up.prepare('PRAGMA foreign_key_check;').all() as unknown[]).length, 0, 'foreign_key_check')
      assertEqual((up.prepare('PRAGMA integrity_check;').get() as { integrity_check: string }).integrity_check, 'ok', 'integrity')
    } finally {
      up.close()
    }
  })

  // ─── Основна временна база ───────────────────────────────────────────────
  const root = await createTempServerRoot(() => true)
  const { databaseFilePath } = await ensureServerDatabaseReady({ serverRootOverride: root })
  const roots: ProfileDeletionUploadRoots = {
    avatars: join(root, 'uploads', 'avatars'),
    profileGallery: join(root, 'uploads', 'profile-gallery'),
    chatAttachments: join(root, 'uploads', 'chat-attachments'),
    topicAttachments: join(root, 'uploads', 'topic-attachments'),
    topicMuteEvidenceAttachments: join(root, 'uploads', 'topic-mute-evidence-attachments'),
    supportAttachments: join(root, 'uploads', 'support-attachments'),
  }
  for (const dir of Object.values(roots)) await mkdir(dir, { recursive: true })
  const db: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, { open: true, enableForeignKeyConstraints: true })
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
  const progressStore = await createPlayerProgressStore(databaseFilePath)
  const authStore = await createAuthStore(databaseFilePath, progressStore, {
    registrationVerificationCodeSecret: SECRET,
    getRegistrationVerificationMode: () => 'direct',
    getActiveBanForProfile: () => null,
  })
  const banStore = await createProfileBanStore(databaseFilePath)
  const modStore = await createTopicModerationStore(databaseFilePath)
  const requestStore = await createProfileDeletionRequestStore(databaseFilePath, { rateLimitSecret: SECRET })
  const executor = await createProfileDeletionExecutor(databaseFilePath)
  const hardDeleteService = await createProfileHardDeleteService(databaseFilePath, { deleteUploadFileByUrl: async () => {} })

  const makeWorker = (exec: ProfileDeletionExecutor, onlyRequestIds: string[]) => createProfileDeletionWorker({
    executor: exec,
    workerId: `w-moderation-${randomUUID().slice(0, 6)}`,
    uploadRoots: roots,
    removeFile: removeProfileDeletionFile,
    appendLedgerEntry: null,
    onlyRequestIds,
  })
  type User = { profileId: string; accountId: string; email: string; displayName: string }
  let counter = 0
  const registerUser = (label: string, email?: string): User => {
    counter += 1
    const finalEmail = email ?? `moderation-${label.toLowerCase()}-${counter}@example.test`
    const displayName = `Md${label}${counter}`
    const result = authStore.register({ email: finalEmail, password: 'secret123', displayName, gender: 'male', visitorId: randomUUID() })
    if (!result.ok || result.mode !== 'direct') throw new Error(`регистрация: ${JSON.stringify(result)}`)
    return { profileId: result.session.profile.profileId as string, accountId: result.session.account.accountId, email: finalEmail, displayName }
  }
  const count = (sql: string, ...params: Array<string | number | null>) => Number((db.prepare(sql).get(...params) as { c: number }).c)
  const dbNow = () => (db.prepare(`SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now;`).get() as { now: string }).now
  const insertDueRequest = (user: User): string => {
    const requestId = randomUUID()
    const createdAt = (db.prepare('SELECT created_at FROM profiles WHERE profile_id = ?;').get(user.profileId) as { created_at: string }).created_at
    const scheduledFor = new Date(Date.parse(dbNow()) - 1000).toISOString()
    const requestedAt = new Date(Date.parse(scheduledFor) - PROFILE_DELETION_GRACE_PERIOD_MS).toISOString()
    const guard = (db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_profile_deletion_requests_insert_guard';`).get() as { sql: string }).sql
    db.exec('DROP TRIGGER trg_profile_deletion_requests_insert_guard;')
    try {
      db.prepare(`INSERT INTO profile_deletion_requests (request_id, profile_id, account_id_snapshot, profile_created_at_snapshot, requested_at, scheduled_for) VALUES (?, ?, ?, ?, ?, ?);`)
        .run(requestId, user.profileId, user.accountId, createdAt, requestedAt, scheduledFor)
    } finally {
      db.exec(guard)
    }
    return requestId
  }
  const requestRow = (requestId: string) => db.prepare('SELECT status, db_deleted_at, last_error_code FROM profile_deletion_requests WHERE request_id = ?;').get(requestId) as { status: string; db_deleted_at: string | null; last_error_code: string | null }
  const deleteViaWorker = async (user: User): Promise<string> => {
    const requestId = insertDueRequest(user)
    const summary = await makeWorker(executor, [requestId]).runOnce()
    assertEqual(summary.completed, 1, `completed (${JSON.stringify(summary)}, ${JSON.stringify(requestRow(requestId))})`)
    return requestId
  }
  const profileExists = (profileId: string) => count('SELECT COUNT(*) AS c FROM profiles WHERE profile_id = ?;', profileId) === 1
  const createTopic = (creator: User | null): string => {
    const topicId = randomUUID()
    db.prepare(`INSERT INTO topics (topic_id, slug, title, created_by_profile_id) VALUES (?, ?, 'Тема', ?);`).run(topicId, `t-${topicId}`, creator?.profileId ?? null)
    return topicId
  }
  const addTopicMessage = (topicId: string, sender: User): string => {
    const messageId = randomUUID()
    db.prepare(`INSERT INTO topic_messages (message_id, topic_id, parent_message_id, sender_profile_id, sender_display_name, sender_role, body) VALUES (?, ?, NULL, ?, ?, 'player', 'текст');`)
      .run(messageId, topicId, sender.profileId, sender.displayName)
    return messageId
  }
  const writeUpload = async (dir: string): Promise<string> => {
    const name = `${randomUUID()}.webp`
    await writeFile(join(dir, name), Buffer.from(`RIFF-${name}`))
    return name
  }
  const attachTopicFile = async (messageId: string): Promise<string> => {
    const name = await writeUpload(roots.topicAttachments)
    db.prepare(`INSERT INTO topic_message_attachments (message_id, storage_filename, width, height, byte_size) VALUES (?, ?, 1, 1, 11);`).run(messageId, name)
    return name
  }
  const createTournament = (creator: User, status: string): string => {
    const tournamentId = randomUUID()
    db.prepare(`INSERT INTO tournaments (tournament_id, name, entry_fee, start_mode, status, creator_profile_id) VALUES (?, 'Турнир', 100, 'fill', ?, ?);`).run(tournamentId, status, creator.profileId)
    return tournamentId
  }
  const blockInTournament = (tournamentId: string, blocked: User, actor: User, role: 'player' | 'admin'): string => {
    const blockId = randomUUID()
    db.prepare(`INSERT INTO tournament_participation_blocks (block_id, tournament_id, blocked_profile_id, actor_profile_id, actor_role, reason) VALUES (?, ?, ?, ?, ?, 'неспортсменско поведение');`)
      .run(blockId, tournamentId, blocked.profileId, actor.profileId, role)
    return blockId
  }
  const reportRow = (reportId: string) => db.prepare('SELECT * FROM topic_reports WHERE report_id = ?;').get(reportId) as Record<string, unknown> | undefined
  const blockRow = (blockId: string) => db.prepare('SELECT * FROM tournament_participation_blocks WHERE block_id = ?;').get(blockId) as Record<string, unknown> | undefined
  const queueOf = (requestId: string) => db.prepare(`SELECT file_kind AS kind, storage_ref AS ref, status FROM profile_deletion_file_queue WHERE request_id = ? ORDER BY storage_ref;`).all(requestId) as Array<{ kind: string; ref: string; status: string }>
  // Модераторските записи на ДРУГИ профили (байт по байт).
  const foreignModerationDump = (excluded: string[]) => {
    const placeholders = excluded.map(() => '?').join(', ')
    return JSON.stringify([
      db.prepare(`SELECT * FROM profile_bans WHERE profile_id IS NULL OR profile_id NOT IN (${placeholders}) ORDER BY ban_id;`).all(...excluded),
      db.prepare(`SELECT * FROM topic_section_mutes WHERE profile_id NOT IN (${placeholders}) ORDER BY profile_id;`).all(...excluded),
      db.prepare(`SELECT * FROM topic_mutes WHERE profile_id NOT IN (${placeholders}) ORDER BY topic_id, profile_id;`).all(...excluded),
      db.prepare(`SELECT * FROM topic_mute_evidence WHERE profile_id NOT IN (${placeholders}) ORDER BY mute_history_id;`).all(...excluded),
      db.prepare(`SELECT * FROM topic_reports WHERE reporter_profile_id IS NULL OR reporter_profile_id NOT IN (${placeholders}) ORDER BY report_id;`).all(...excluded),
      db.prepare(`SELECT * FROM tournament_participation_blocks WHERE blocked_profile_id NOT IN (${placeholders}) AND (actor_profile_id IS NULL OR actor_profile_id NOT IN (${placeholders})) ORDER BY block_id;`).all(...excluded, ...excluded),
    ])
  }
  // Остатъчни идентификатори: всяка текстова клетка във всяка таблица.
  // Разрешени: собствените записи на процеса по изтриване (регистърът за
  // restore) и САМО псевдонимният UUID в атрибуционните deleted_*_snapshot
  // колони (одобрени в предишните етапи; вкл. profile_bans). Имейл, акаунт и
  // име не са разрешени никъде.
  const isPseudonymousSnapshotColumn = (column: string) => /^deleted_[a-z_]*profile_id_snapshot$/.test(column)
  const residualIdentifiers = (user: User): string[] => {
    const hits: string[] = []
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'profile_deletion_%';`).all() as Array<{ name: string }>).map((row) => row.name)
    for (const table of tables) {
      const columns = (db.prepare(`SELECT name FROM pragma_table_info(?);`).all(table) as Array<{ name: string }>).map((row) => row.name)
      for (const column of columns) {
        const needles = isPseudonymousSnapshotColumn(column) ? [user.accountId, user.email, user.displayName] : [user.profileId, user.accountId, user.email, user.displayName]
        for (const needle of needles) {
          const found = count(`SELECT COUNT(*) AS c FROM "${table}" WHERE typeof("${column}") = 'text' AND instr("${column}", ?) > 0;`, needle)
          if (found > 0) hits.push(`${table}.${column}`)
        }
      }
    }
    return [...new Set(hits)]
  }

  const admin = registerUser('Admin')
  db.prepare(`UPDATE accounts SET role = 'admin' WHERE account_id = ?;`).run(admin.accountId)
  const bystander = registerUser('Bystander')
  const otherAuthor = registerUser('OtherAuthor')
  const foreignTopic = createTopic(otherAuthor)
  const foreignTopic2 = createTopic(otherAuthor)
  const generalTopic = createTopic(null)
  // Модераторски записи на трето лице — трябва да останат байт по байт.
  assert(banStore.banProfile({ targetProfileId: bystander.profileId, actorProfileId: admin.profileId, days: 5, reason: 'спам' }).ok, 'бан на третото лице')
  modStore.muteProfileInTopics({ topicId: generalTopic, profileId: bystander.profileId, actorAccountId: admin.accountId, actorRole: 'admin', reason: 'обиди', durationMs: HOUR_MS, sourceMessageId: addTopicMessage(generalTopic, bystander), sourceKind: 'topic_root' })
  assert(modStore.createReport({ topicId: foreignTopic, reporterProfileId: bystander.profileId, reason: 'спам от трето лице' }).ok, 'сигнал на третото лице')

  console.log('\n[M] Модераторски записи')

  await check('[M1a] Активен бан: заявка за самоизтриване НЕ може да бъде подадена (сървърна проверка в транзакцията); нищо не е записано', () => {
    const user = registerUser('BannedSubmit')
    assert(banStore.banProfile({ targetProfileId: user.profileId, actorProfileId: admin.profileId, days: 30, reason: 'измама' }).ok, 'бан')
    const created = requestStore.createRequest({ profileId: user.profileId, accountId: user.accountId })
    assert(!created.ok && created.code === 'active_ban', JSON.stringify(created))
    assertEqual(count('SELECT COUNT(*) AS c FROM profile_deletion_requests WHERE profile_id = ?;', user.profileId), 0, 'заявка')
    assertEqual(count('SELECT COUNT(*) AS c FROM profile_deletion_events WHERE profile_id = ?;', user.profileId), 0, 'журнал')
  })

  await check('[M1b] Бан след подаването: окончателното изтриване се отлага (blocked active_ban, нищо не е променено); след премахване на бана — минава; банът остава с дата, срок, основание и автор, без profile_id; не важи за нов профил със същия имейл', async () => {
    const user = registerUser('ActiveBan')
    const requestId = insertDueRequest(user) // заявката е подадена преди бана и срокът е изтекъл
    assert(banStore.banProfile({ targetProfileId: user.profileId, actorProfileId: admin.profileId, days: 30, reason: 'измама' }).ok, 'бан')
    const snapshot = () => JSON.stringify([
      db.prepare('SELECT * FROM profiles WHERE profile_id = ?;').all(user.profileId),
      db.prepare('SELECT * FROM profile_bans WHERE profile_id = ?;').all(user.profileId),
    ])
    const before = snapshot()
    assertEqual((await makeWorker(executor, [requestId]).runOnce()).blocked, 1, 'blocked')
    const row = requestRow(requestId)
    assert(row.status === 'blocked' && row.last_error_code === 'active_ban' && row.db_deleted_at === null, JSON.stringify(row))
    assertEqual(snapshot(), before, 'нищо не е променено')
    assertEqual(queueOf(requestId).length, 0, 'няма файлове в опашката')
    // Банът е премахнат (съществуващият механизъм) — следващият опит минава.
    assert(banStore.unbanProfile({ targetProfileId: user.profileId, actorProfileId: admin.profileId }).ok, 'премахване')
    const trace = db.prepare('SELECT ban_id, banned_at, banned_until, reason, banned_by_profile_id, lifted_at, lifted_by_profile_id FROM profile_bans WHERE profile_id = ?;').all(user.profileId)
    db.prepare('UPDATE profile_deletion_requests SET next_attempt_at = ? WHERE request_id = ?;').run(new Date(Date.parse(dbNow()) - 1000).toISOString(), requestId)
    assertEqual((await makeWorker(executor, [requestId]).runOnce()).completed, 1, 'completed')
    assert(!profileExists(user.profileId), 'профилът')
    const after = db.prepare('SELECT ban_id, banned_at, banned_until, reason, banned_by_profile_id, lifted_at, lifted_by_profile_id FROM profile_bans WHERE deleted_profile_id_snapshot = ? AND profile_id IS NULL;').all(user.profileId)
    assertEqual(JSON.stringify(after), JSON.stringify(trace), 'минималната следа')
    const reborn = registerUser('ActiveBanNew', user.email)
    assert(reborn.profileId !== user.profileId, 'нов профил')
    assertEqual(banStore.getActiveBan(reborn.profileId), null, 'банът не се прехвърля')
  })

  await check('[M1c] Бан след подаването, който изтича: след изтичането изтриването минава без друга намеса', async () => {
    const user = registerUser('BanExpires')
    const requestId = insertDueRequest(user)
    assert(banStore.banProfile({ targetProfileId: user.profileId, actorProfileId: admin.profileId, days: 1, reason: 'кратък' }).ok, 'бан')
    assertEqual((await makeWorker(executor, [requestId]).runOnce()).blocked, 1, 'blocked')
    db.prepare(`UPDATE profile_bans SET banned_until = datetime('now', '-1 minute') WHERE profile_id = ?;`).run(user.profileId)
    db.prepare('UPDATE profile_deletion_requests SET next_attempt_at = ? WHERE request_id = ?;').run(new Date(Date.parse(dbNow()) - 1000).toISOString(), requestId)
    assertEqual((await makeWorker(executor, [requestId]).runOnce()).completed, 1, 'completed')
    assertEqual(count('SELECT COUNT(*) AS c FROM profile_bans WHERE deleted_profile_id_snapshot = ? AND profile_id IS NULL;', user.profileId), 1, 'следа')
  })

  await check('[M2] Изтекъл бан: изтриването минава; редът остава непроменен, без profile_id', async () => {
    const user = registerUser('ExpiredBan')
    assert(banStore.banProfile({ targetProfileId: user.profileId, actorProfileId: admin.profileId, days: 1, reason: 'стар' }).ok, 'бан')
    db.prepare(`UPDATE profile_bans SET banned_until = datetime('now', '-1 day') WHERE profile_id = ?;`).run(user.profileId)
    assertEqual(banStore.getActiveBan(user.profileId), null, 'изтекъл')
    await deleteViaWorker(user)
    assertEqual(count('SELECT COUNT(*) AS c FROM profile_bans WHERE deleted_profile_id_snapshot = ? AND profile_id IS NULL AND reason = ?;', user.profileId, 'стар'), 1, 'следа')
  })

  let evidenceUser: User | null = null
  let evidenceFiles: { original: string; copy: string } | null = null
  await check('[M3] Активно заглушаване (раздел и тема) с доказателства: изтриването минава; заглушаванията, известията и доказателствата изчезват', async () => {
    const user = registerUser('Muted')
    const post = addTopicMessage(generalTopic, user)
    const original = await attachTopicFile(post)
    modStore.muteProfileInTopics({ topicId: generalTopic, profileId: user.profileId, actorAccountId: admin.accountId, actorRole: 'admin', reason: 'обиди', durationMs: HOUR_MS, sourceMessageId: post, sourceKind: 'topic_root' })
    modStore.muteProfileInTopic({ topicId: foreignTopic, profileId: user.profileId, actorAccountId: admin.accountId, actorRole: 'admin', reason: 'спам', durationMs: HOUR_MS })
    assert(modStore.isProfileMutedInTopicsSection(user.profileId), 'заглушен')
    // Второ доказателство — със собствено копие на файла (както при Lafche retention).
    const post2 = addTopicMessage(generalTopic, user)
    const original2 = await attachTopicFile(post2)
    modStore.unmuteProfileInTopics({ topicId: generalTopic, profileId: user.profileId, actorAccountId: admin.accountId, actorRole: 'admin' })
    modStore.muteProfileInTopics({ topicId: generalTopic, profileId: user.profileId, actorAccountId: admin.accountId, actorRole: 'admin', reason: 'снимка', durationMs: HOUR_MS, sourceMessageId: post2, sourceKind: 'topic_root' })
    const copy = await writeUpload(roots.topicMuteEvidenceAttachments)
    assertEqual(modStore.repointMuteEvidenceAttachmentToEvidenceCopy(original2, copy), 1, 'копие')
    assertEqual(count('SELECT COUNT(*) AS c FROM topic_mute_evidence WHERE profile_id = ? AND source_attachment_storage_filename IS NOT NULL;', user.profileId), 2, 'доказателства с файл')
    evidenceUser = user
    evidenceFiles = { original, copy }
    const requestId = await deleteViaWorker(user)
    for (const table of ['topic_section_mutes', 'topic_mutes', 'topic_mute_evidence', 'topic_mute_end_notices']) {
      assertEqual(count(`SELECT COUNT(*) AS c FROM ${table} WHERE profile_id = ?;`, user.profileId), 0, table)
    }
    assertEqual(count('SELECT COUNT(*) AS c FROM topic_moderation_audit_log WHERE target_profile_id = ?;', user.profileId), 0, 'одит без връзка')
    assert(queueOf(requestId).some((row) => row.kind === 'topic_mute_evidence_attachment' && row.ref === copy), 'копието е в опашката')
  })

  await check('[M9] Доказателство с прикачен файл: оригиналът и копието са изтрити физически през опашката; няма файл без ред', async () => {
    assert(evidenceFiles !== null, 'няма данни от M3')
    assert(!existsSync(join(roots.topicAttachments, evidenceFiles!.original)), 'оригиналът')
    assert(!existsSync(join(roots.topicMuteEvidenceAttachments, evidenceFiles!.copy)), 'копието')
    const referenced = new Set((db.prepare('SELECT source_attachment_storage_filename AS f FROM topic_mute_evidence WHERE source_attachment_is_evidence_copy = 1;').all() as Array<{ f: string }>).map((row) => row.f))
    const stray = (await readdir(roots.topicMuteEvidenceAttachments)).filter((name) => !referenced.has(name))
    assertEqual(stray.length, 0, `осиротели копия: ${stray.join(',')}`)
  })

  await check('[M10] Файл с друга валидна препратка (доказателство на друг профил сочи същия оригинал): пропуска се (skipped_shared) и остава', async () => {
    const user = registerUser('SharedFile')
    const post = addTopicMessage(generalTopic, user)
    const shared = await attachTopicFile(post)
    // Наследен случай: доказателство на друг профил сочи същия оригинален файл.
    db.prepare(`INSERT INTO topic_mute_evidence (mute_history_id, mute_audit_log_id, profile_id, source_topic_id, source_kind, source_body_snapshot, source_attachment_storage_filename, source_attachment_is_evidence_copy, muted_by_role, duration_ms, muted_until, status)
      VALUES (?, ?, ?, ?, 'topic_root', 'текст', ?, 0, 'admin', 3600000, datetime('now', '+1 hour'), 'active');`).run(randomUUID(), randomUUID(), bystander.profileId, generalTopic, shared)
    const requestId = await deleteViaWorker(user)
    const row = queueOf(requestId).find((entry) => entry.ref === shared)
    assert(row !== undefined && row.status === 'skipped_shared', JSON.stringify(queueOf(requestId)))
    assert(existsSync(join(roots.topicAttachments, shared)), 'файлът остава')
  })

  const reporter = registerUser('Reporter')
  const reporterOwnTopic = createTopic(reporter)
  const pendingReport = modStore.createReport({ topicId: foreignTopic, reporterProfileId: reporter.profileId, reason: 'обидно съдържание' })
  const reviewedReport = modStore.createReport({ topicId: foreignTopic2, reporterProfileId: reporter.profileId, reason: 'спам' })
  const reportOnOwnTopic = modStore.createReport({ topicId: reporterOwnTopic, reporterProfileId: bystander.profileId, reason: 'сигнал срещу темата на изтрития' })
  if (!pendingReport.ok || !reviewedReport.ok || !reportOnOwnTopic.ok) throw new Error('сигнали')
  assert(modStore.reviewReport({ reportId: reviewedReport.report.reportId, status: 'reviewed', actorAccountId: admin.accountId }).ok, 'разглеждане')
  const pendingBefore = reportRow(pendingReport.report.reportId)!

  const actor = registerUser('BlockActor')
  const blockedOther = registerUser('BlockedOther')
  const blockedSelf = registerUser('BlockedSelf')
  const finishedTournament = createTournament(actor, 'finished')
  const otherTournament = createTournament(otherAuthor, 'finished')
  const blockByActor = blockInTournament(finishedTournament, blockedOther, actor, 'player')
  const blockOfSelf = blockInTournament(otherTournament, blockedSelf, otherAuthor, 'player')
  const blockByActorBefore = blockRow(blockByActor)!

  await deleteViaWorker(reporter)

  await check('[M4] Неразгледан сигнал от изтрития: остава със същата тема, причина, статус и дата, без подател', () => {
    const row = reportRow(pendingReport.report.reportId)
    assert(row !== undefined, 'сигналът изчезна')
    assertEqual(row!.reporter_profile_id, null, 'подател')
    assertEqual(JSON.stringify({ ...row, reporter_profile_id: pendingBefore.reporter_profile_id }), JSON.stringify(pendingBefore), 'останалите полета')
    const listed = modStore.listReports('pending', 100).find((report) => report.reportId === pendingReport.report.reportId)
    assert(listed !== undefined && listed.reporterProfileId === null, 'в администраторския списък без подател')
    assert(!JSON.stringify(modStore.listReports(null, 100)).includes(reporter.profileId), 'самоличността не се показва')
  })

  await check('[M5] Сигнал срещу съдържание на друг потребител: може да бъде разгледан; подателят не може да бъде присвоен; нов сигнал без подател е забранен', () => {
    assertThrows(() => db.prepare('UPDATE topic_reports SET reporter_profile_id = ? WHERE report_id = ?;').run(bystander.profileId, pendingReport.report.reportId), 'topic_report_reporter_immutable', 'присвояване')
    assertThrows(() => db.prepare(`INSERT INTO topic_reports (report_id, topic_id, reporter_profile_id, reason) VALUES (?, ?, NULL, 'анонимен');`).run(randomUUID(), foreignTopic), 'topic_report_reporter_required', 'нов анонимен')
    const ownReport = modStore.createReport({ topicId: foreignTopic2, reporterProfileId: otherAuthor.profileId, reason: 'х' })
    assert(ownReport.ok, 'нормален сигнал')
    if (ownReport.ok) assertThrows(() => db.prepare('UPDATE topic_reports SET reporter_profile_id = ? WHERE report_id = ?;').run(bystander.profileId, ownReport.report.reportId), 'topic_report_reporter_immutable', 'смяна на подател')
    const reviewed = modStore.reviewReport({ reportId: pendingReport.report.reportId, status: 'dismissed', actorAccountId: admin.accountId })
    assert(reviewed.ok && reviewed.report.status === 'dismissed' && reviewed.report.reporterProfileId === null, JSON.stringify(reviewed))
  })

  await check('[M6] Вече разгледан сигнал от изтрития: изтрит (досегашното поведение); сигналите на други срещу темата на изтрития изчезват с темата (Б1)', () => {
    assertEqual(reportRow(reviewedReport.report.reportId), undefined, 'разгледаният')
    assertEqual(reportRow(reportOnOwnTopic.report.reportId), undefined, 'сигналът срещу изтритата тема')
  })

  await deleteViaWorker(actor)
  await check('[M7] Турнирна блокировка, наложена от изтрития: остава в сила (actor = NULL, роля, причина, дата); блокираният е непроменен; авторът не може да бъде присвоен; нова блокировка без автор е забранена', () => {
    const row = blockRow(blockByActor)
    assert(row !== undefined, 'блокировката изчезна')
    assertEqual(row!.actor_profile_id, null, 'автор')
    assertEqual(JSON.stringify({ ...row, actor_profile_id: blockByActorBefore.actor_profile_id }), JSON.stringify(blockByActorBefore), 'останалите полета')
    assert(profileExists(blockedOther.profileId), 'блокираният')
    assertThrows(() => db.prepare('UPDATE tournament_participation_blocks SET actor_profile_id = ? WHERE block_id = ?;').run(admin.profileId, blockByActor), 'tournament_participation_block_actor_immutable', 'присвояване')
    assertThrows(() => db.prepare(`INSERT INTO tournament_participation_blocks (block_id, tournament_id, blocked_profile_id, actor_profile_id, actor_role, reason) VALUES (?, ?, ?, NULL, 'admin', 'х');`).run(randomUUID(), otherTournament, bystander.profileId), 'tournament_participation_block_actor_required', 'без автор')
  })

  await deleteViaWorker(blockedSelf)
  await check('[M8] Изтриване на самия блокиран профил: неговата блокировка изчезва (досегашното правило); блокировките на другите остават', () => {
    assertEqual(blockRow(blockOfSelf), undefined, 'блокировката на изтрития')
    assert(blockRow(blockByActor) !== undefined, 'чуждата блокировка')
  })

  console.log('\n[P] Процес')

  await check('[P1] Отмяна преди срока (бан, наложен след подаването): бан, заглушаване, сигнал и блокировка остават непроменени (банът важи и след отмяната)', async () => {
    const user = registerUser('Cancel')
    modStore.muteProfileInTopics({ topicId: generalTopic, profileId: user.profileId, actorAccountId: admin.accountId, actorRole: 'admin', reason: 'х', durationMs: HOUR_MS })
    assert(modStore.createReport({ topicId: foreignTopic, reporterProfileId: user.profileId, reason: 'х' }).ok, 'сигнал')
    const tournament = createTournament(user, 'finished')
    blockInTournament(tournament, bystander, user, 'player')
    const snapshot = () => JSON.stringify([
      db.prepare('SELECT * FROM profile_bans WHERE profile_id = ?;').all(user.profileId),
      db.prepare('SELECT * FROM topic_section_mutes WHERE profile_id = ?;').all(user.profileId),
      db.prepare('SELECT * FROM topic_reports WHERE reporter_profile_id = ?;').all(user.profileId),
      db.prepare('SELECT * FROM tournament_participation_blocks WHERE actor_profile_id = ?;').all(user.profileId),
    ])
    const created = requestStore.createRequest({ profileId: user.profileId, accountId: user.accountId })
    if (!created.ok) throw new Error(JSON.stringify(created))
    assert(banStore.banProfile({ targetProfileId: user.profileId, actorProfileId: admin.profileId, days: 10, reason: 'х' }).ok, 'бан след подаването')
    const before = snapshot()
    assertEqual((await makeWorker(executor, [created.request.requestId]).runOnce()).claimed, 0, 'не е взета преди срока')
    const issued = requestStore.issueRestoreToken(user.profileId)
    assert(issued.ok && requestStore.cancelWithToken(issued.restoreToken).ok, 'отмяна')
    assertEqual(snapshot(), before, 'след отмяната')
    assert(banStore.getActiveBan(user.profileId) !== null, 'банът важи')
  })

  await check('[P2] Окончателно изтриване на профил с всички видове записи (изтекъл бан, заглушаване, сигнал, блокировка): completed; нищо модераторско не сочи към профила', async () => {
    const user = registerUser('Final')
    assert(banStore.banProfile({ targetProfileId: user.profileId, actorProfileId: admin.profileId, days: 10, reason: 'х' }).ok, 'бан')
    db.prepare(`UPDATE profile_bans SET banned_until = datetime('now', '-1 day') WHERE profile_id = ?;`).run(user.profileId)
    modStore.muteProfileInTopics({ topicId: generalTopic, profileId: user.profileId, actorAccountId: admin.accountId, actorRole: 'admin', reason: 'х', durationMs: HOUR_MS, sourceMessageId: addTopicMessage(generalTopic, user), sourceKind: 'topic_root' })
    const report = modStore.createReport({ topicId: foreignTopic, reporterProfileId: user.profileId, reason: 'х' })
    assert(report.ok, 'сигнал')
    blockInTournament(createTournament(user, 'finished'), bystander, user, 'player')
    const requestId = await deleteViaWorker(user)
    assertEqual(requestRow(requestId).status, 'completed', 'статус')
    assertEqual(count('SELECT COUNT(*) AS c FROM profile_bans WHERE profile_id = ?;', user.profileId), 0, 'бан')
    assertEqual(count('SELECT COUNT(*) AS c FROM topic_reports WHERE reporter_profile_id = ?;', user.profileId), 0, 'сигнал')
    assertEqual(count('SELECT COUNT(*) AS c FROM tournament_participation_blocks WHERE actor_profile_id = ?1 OR blocked_profile_id = ?1;', user.profileId), 0, 'блокировка')
    if (report.ok) assertEqual(reportRow(report.report.reportId)!.reporter_profile_id, null, 'анонимният сигнал')
  })

  await check('[P3] Повторно изпълнение на worker-а: нищо не се взема; модераторските таблици са непроменени', async () => {
    const dump = () => JSON.stringify(['profile_bans', 'topic_reports', 'tournament_participation_blocks', 'topic_mute_evidence', 'topic_section_mutes'].map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid;`).all()))
    const before = dump()
    const requestIds = (db.prepare(`SELECT request_id FROM profile_deletion_requests WHERE status = 'completed';`).all() as Array<{ request_id: string }>).map((row) => row.request_id)
    assertEqual((await makeWorker(executor, requestIds).runOnce()).claimed, 0, 'нищо не е взето')
    assertEqual(dump(), before, 'непроменено')
  })

  await check('[P4] Restore от стар backup: replayDeletionForRestore прилага същите правила (бан без profile_id, анонимен неразгледан сигнал, запазена блокировка, без заглушавания); при активен бан в backup-а — blocked active_ban (fail-closed)', async () => {
    const banned = registerUser('ReplayBanned')
    assert(banStore.banProfile({ targetProfileId: banned.profileId, actorProfileId: admin.profileId, days: 10, reason: 'активен' }).ok, 'активен бан')
    const user = registerUser('Replay')
    assert(banStore.banProfile({ targetProfileId: user.profileId, actorProfileId: admin.profileId, days: 10, reason: 'replay' }).ok, 'бан')
    db.prepare(`UPDATE profile_bans SET banned_until = datetime('now', '-1 day') WHERE profile_id = ?;`).run(user.profileId)
    modStore.muteProfileInTopics({ topicId: generalTopic, profileId: user.profileId, actorAccountId: admin.accountId, actorRole: 'admin', reason: 'х', durationMs: HOUR_MS })
    const report = modStore.createReport({ topicId: foreignTopic, reporterProfileId: user.profileId, reason: 'replay сигнал' })
    if (!report.ok) throw new Error('сигнал')
    const blockId = blockInTournament(createTournament(user, 'finished'), bystander, user, 'player')
    const backupPath = join(root, `backup-${randomUUID()}.sqlite`)
    db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}';`)
    const restored = await createProfileDeletionExecutor(backupPath)
    try {
      const createdAt = (db.prepare('SELECT created_at FROM profiles WHERE profile_id = ?;').get(user.profileId) as { created_at: string }).created_at
      assertEqual(restored.replayDeletionForRestore({ profileId: user.profileId, accountIdSnapshot: user.accountId, profileCreatedAtSnapshot: createdAt }).kind, 'deleted', 'replay')
      const bannedCreatedAt = (db.prepare('SELECT created_at FROM profiles WHERE profile_id = ?;').get(banned.profileId) as { created_at: string }).created_at
      const blocked = restored.replayDeletionForRestore({ profileId: banned.profileId, accountIdSnapshot: banned.accountId, profileCreatedAtSnapshot: bannedCreatedAt })
      assert(blocked.kind === 'blocked' && blocked.code === 'active_ban', `активен бан: ${JSON.stringify(blocked)}`)
    } finally {
      restored.close()
    }
    const backup = new sqliteModule.DatabaseSync(backupPath, { readOnly: true })
    try {
      const one = (sql: string, ...params: string[]) => Number((backup.prepare(sql).get(...params) as { c: number }).c)
      assertEqual(one('SELECT COUNT(*) AS c FROM profile_bans WHERE profile_id IS NULL AND deleted_profile_id_snapshot = ? AND reason = ?;', user.profileId, 'replay'), 1, 'бан')
      assertEqual(one('SELECT COUNT(*) AS c FROM topic_reports WHERE report_id = ? AND reporter_profile_id IS NULL;', report.report.reportId), 1, 'сигнал')
      assertEqual(one('SELECT COUNT(*) AS c FROM tournament_participation_blocks WHERE block_id = ? AND actor_profile_id IS NULL;', blockId), 1, 'блокировка')
      assertEqual(one('SELECT COUNT(*) AS c FROM topic_section_mutes WHERE profile_id = ?;', user.profileId), 0, 'заглушаване')
    } finally {
      backup.close()
    }
  })

  await check('[P5] Нарушен инвариант (чужд бан изчезва по време на изтриването): ROLLBACK, failed; профилът и модераторските записи са непокътнати', async () => {
    const user = registerUser('Rollback')
    const report = modStore.createReport({ topicId: foreignTopic, reporterProfileId: user.profileId, reason: 'rollback' })
    if (!report.ok) throw new Error('сигнал')
    const before = foreignModerationDump([user.profileId]) + JSON.stringify(reportRow(report.report.reportId))
    db.exec(`CREATE TRIGGER trg_test_lose_ban AFTER DELETE ON profiles WHEN OLD.profile_id = '${user.profileId}'
      BEGIN DELETE FROM profile_bans WHERE profile_id = '${bystander.profileId}'; END;`)
    let requestId = ''
    try {
      requestId = insertDueRequest(user)
      assertEqual((await makeWorker(executor, [requestId]).runOnce()).failed, 1, 'failed')
    } finally {
      db.exec('DROP TRIGGER trg_test_lose_ban;')
    }
    const row = requestRow(requestId)
    assert(row.status === 'failed' && row.db_deleted_at === null && row.last_error_code === 'db_phase_error', JSON.stringify(row))
    assert(profileExists(user.profileId), 'профилът')
    assertEqual(foreignModerationDump([user.profileId]) + JSON.stringify(reportRow(report.report.reportId)), before, 'записите')
  })

  await check('[P6] Модераторските записи на други профили (бан, заглушаване, доказателство, сигнал, блокировки) са байт по байт непроменени след всички изтривания', () => {
    const dump = JSON.parse(foreignModerationDump([admin.profileId])) as unknown[][]
    const bystanderRows = JSON.stringify(dump.map((rows) => (rows as Array<Record<string, unknown>>).filter((row) => Object.values(row).includes(bystander.profileId))))
    assert(bystanderRows.includes('спам от трето лице'), 'сигналът на третото лице')
    assertEqual(banStore.getActiveBan(bystander.profileId)?.reason ?? null, 'спам', 'банът на третото лице')
    assert(modStore.isProfileMutedInTopicsSection(bystander.profileId), 'заглушаването на третото лице')
    assertEqual(count('SELECT COUNT(*) AS c FROM topic_mute_evidence WHERE profile_id = ?;', bystander.profileId), 2, 'доказателствата на третото лице')
  })

  await check('[P7] Отложено административно действие: pending бан — blocked active_ban, после (бан премахнат) минава и pending редът изчезва; pending изтриване без/със support заявка НЕ блокира и се приключва (Етап 4E6C)', async () => {
    const withBan = registerUser('PendingBan')
    const banRequestId = insertDueRequest(withBan)
    const ban = banStore.banProfile({ targetProfileId: withBan.profileId, actorProfileId: admin.profileId, days: 10, reason: 'отложен' })
    if (!ban.ok) throw new Error('бан')
    db.prepare(`INSERT INTO pending_profile_moderation (pending_id, target_profile_id, action, ban_id, requested_by_profile_id, reason) VALUES (?, ?, 'ban', ?, ?, 'отложен');`)
      .run(randomUUID(), withBan.profileId, ban.ban.banId, admin.profileId)
    assertEqual((await makeWorker(executor, [banRequestId]).runOnce()).blocked, 1, 'blocked при активен бан')
    assertEqual(requestRow(banRequestId).last_error_code, 'active_ban', 'код')
    assert(banStore.unbanProfile({ targetProfileId: withBan.profileId, actorProfileId: admin.profileId }).ok, 'премахване')
    db.prepare('UPDATE profile_deletion_requests SET next_attempt_at = ? WHERE request_id = ?;').run(new Date(Date.parse(dbNow()) - 1000).toISOString(), banRequestId)
    assertEqual((await makeWorker(executor, [banRequestId]).runOnce()).completed, 1, 'completed')
    assertEqual(count('SELECT COUNT(*) AS c FROM pending_profile_moderation WHERE target_profile_id = ?;', withBan.profileId), 0, 'pending бан')
    assertEqual(count('SELECT COUNT(*) AS c FROM profile_bans WHERE ban_id = ? AND profile_id IS NULL;', ban.ban.banId), 1, 'банът')

    const withDelete = registerUser('PendingDelete')
    db.prepare(`INSERT INTO pending_profile_moderation (pending_id, target_profile_id, action, requested_by_profile_id, reason) VALUES (?, ?, 'delete', ?, 'отложено');`)
      .run(randomUUID(), withDelete.profileId, admin.profileId)
    await deleteViaWorker(withDelete)

    const withSupport = registerUser('PendingSupport')
    db.prepare(`INSERT INTO support_messages (message_id, profile_id, body, is_from_admin) VALUES (?, ?, 'Изтрийте профила ми', 0);`).run('sup-msg-1', withSupport.profileId)
    db.prepare(`INSERT INTO pending_profile_moderation (pending_id, target_profile_id, action, requested_by_profile_id, reason, support_request_message_id) VALUES (?, ?, 'delete', ?, 'по заявка', 'sup-msg-1');`)
      .run(randomUUID(), withSupport.profileId, admin.profileId)
    await deleteViaWorker(withSupport)
    assertEqual(count('SELECT COUNT(*) AS c FROM pending_profile_moderation WHERE target_profile_id IN (?, ?);', withDelete.profileId, withSupport.profileId), 0, 'pending изтривания')
    assertEqual(count('SELECT COUNT(*) AS c FROM support_messages WHERE profile_id = ?;', withSupport.profileId), 0, 'support разговорът')
  })

  await check('[P8] Остатъчни идентификатори: ID, акаунт, имейл и име на изтритите не се срещат в нито една таблица (освен регистъра на изтриването и псевдонимния UUID в атрибуционните deleted_*_snapshot колони, вкл. profile_bans)', () => {
    const deleted = (db.prepare(`SELECT r.profile_id, r.account_id_snapshot FROM profile_deletion_requests r WHERE r.status = 'completed';`).all() as Array<{ profile_id: string; account_id_snapshot: string }>)
    assert(deleted.length >= 12, `изтрити: ${deleted.length}`)
    const known = [evidenceUser, reporter, actor, blockedSelf].filter((user): user is User => user !== null)
    for (const user of known) {
      const hits = residualIdentifiers(user)
      assertEqual(hits.length, 0, `${user.displayName}: ${hits.join(', ')}`)
    }
  })

  console.log('\n[H] Административно изтриване (Етап 4F2 — същите правила като самоизтриването)')

  await check('[H1] Административно изтриване: неразгледаният сигнал за чуждо съдържание остава анонимен; наложената на друг блокировка остава без автор', async () => {
    const target = registerUser('AdminTarget')
    const report = modStore.createReport({ topicId: foreignTopic, reporterProfileId: target.profileId, reason: 'admin' })
    if (!report.ok) throw new Error('сигнал')
    const blockId = blockInTournament(createTournament(otherAuthor, 'finished'), bystander, target, 'player')
    const result = await hardDeleteService.hardDeleteProfile({ targetProfileId: target.profileId, actorProfileId: admin.profileId, actorAccountId: admin.accountId, reason: 'test' })
    assert(result.ok, JSON.stringify(result))
    const reportAfter = reportRow(report.report.reportId)
    assert(reportAfter !== undefined && reportAfter.reporter_profile_id === null && reportAfter.status === 'pending', `сигналът: ${JSON.stringify(reportAfter)}`)
    const blockAfter = blockRow(blockId)
    assert(blockAfter !== undefined && blockAfter.actor_profile_id === null && blockAfter.blocked_profile_id === bystander.profileId, `блокировката: ${JSON.stringify(blockAfter)}`)
    assertEqual((db.prepare('PRAGMA foreign_key_check;').all() as unknown[]).length, 0, 'foreign_key_check')
  })

  for (const store of [executor, requestStore, authStore, progressStore, banStore, modStore] as Array<{ close: () => void }>) {
    try { store.close() } catch { /* ignore */ }
  }
  db.close()
} catch (error) {
  failed += 1
  console.error(`  FAIL  неочаквана грешка: ${error instanceof Error ? error.stack : String(error)}`)
} finally {
  for (const root of tempRoots) await rm(root, { recursive: true, force: true }).catch(() => {})
}

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)
process.exitCode = failed > 0 ? 1 : 0
