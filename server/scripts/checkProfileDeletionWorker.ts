/**
 * checkProfileDeletionWorker.ts
 *
 * Самоизтриване на профили — Етап 4: автоматично окончателно изтриване.
 * САМО временни бази (ensureServerDatabaseReady() върху копие на
 * миграциите) и временни upload директории — никога реалната база/файлове.
 *
 * [T] Срок, заявки, lease, рестарт, конкурентни worker-и, повторни опити.
 * [D] Данни: профил, лични разговори за двете страни, несвързани разговори,
 *     Теми, подаръци, турнири, финансови записи, сираци/FK.
 * [F] Файлове: срив преди/след commit и по време на изтриване, повторна
 *     обработка, липсващ/споделен файл, опасен път, symlink, completed guard.
 * [R] Конкурентност при подаване и турнирни покани.
 * [L] Регистър извън базата и процедурата след restore.
 * [S] Миграция 20261026_001 (схема, upgrade със съществуващи данни).
 */

import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'
import { createPlayerProgressStore } from '../src/db/playerProgressStore.js'
import { createAuthStore } from '../src/db/authStore.js'
import { createProfileBanStore } from '../src/db/profileBanStore.js'
import { createProfileDeletionRequestStore } from '../src/db/profileDeletionRequestStore.js'
import { createTournamentStore } from '../src/db/tournamentStore.js'
import { createTournamentEconomyStore } from '../src/db/tournamentEconomyStore.js'
import {
  createProfileDeletionExecutor,
  PROFILE_DELETION_DELETED_LABEL,
  PROFILE_DELETION_MAX_FAILED_ATTEMPTS,
  type ProfileDeletionExecutor,
} from '../src/db/profileDeletionExecutor.js'
import { appendProfileDeletionLedgerEntry, readProfileDeletionLedger } from '../src/db/profileDeletionLedger.js'
import { PROFILE_DELETION_GRACE_PERIOD_MS } from '../src/db/profileDeletionSchedule.js'
import { createProfileDeletionWorker } from '../src/core/profileDeletionWorker.js'
import { isProfileSelfDeletionWorkerEnabled } from '../src/core/profileSelfDeletionFeatureFlag.js'
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

function assertRejects(fn: () => unknown, fragment: string, message: string): void {
  try {
    fn()
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    if (!text.includes(fragment)) throw new Error(`${message}: очаквана грешка "${fragment}", получена "${text}"`)
    return
  }
  throw new Error(`${message}: не беше отхвърлено`)
}

const sleep = (ms: number) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

const sourceServerRoot = resolve(
  process.argv.slice(2).find((arg) => arg.startsWith('--server-root='))?.slice('--server-root='.length) ?? process.cwd(),
)
const SECRET = 'profile-deletion-worker-test-secret-0123456789'
const PASSWORD = 'secret123'
const NEW_MIGRATION = '20261026_001_profile_deletion_worker_guards.sql'

console.log('\ncheckProfileDeletionWorker')
console.log(`Server root: ${sourceServerRoot}`)

async function createTempServerRoot(migrationFilter: (name: string) => boolean): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'belot-profile-deletion-worker-'))
  await mkdir(join(root, 'database', 'migrations'), { recursive: true })
  await mkdir(join(root, 'database', 'data'), { recursive: true })
  for (const entry of await readdir(join(sourceServerRoot, 'database', 'migrations'), { withFileTypes: true })) {
    if (entry.isFile() && extname(entry.name).toLowerCase() === '.sql' && migrationFilter(entry.name)) {
      await cp(join(sourceServerRoot, 'database', 'migrations', entry.name), join(root, 'database', 'migrations', entry.name))
    }
  }
  return root
}

const root = await createTempServerRoot(() => true)
const { databaseFilePath } = await ensureServerDatabaseReady({ serverRootOverride: root })
const uploadsRoot = join(root, 'uploads')
const outsideRoot = join(root, 'outside')
const ledgerPath = join(root, 'deletion-ledger', 'profile-deletions.jsonl')
const roots: ProfileDeletionUploadRoots = {
  avatars: join(uploadsRoot, 'avatars'),
  profileGallery: join(uploadsRoot, 'profile-gallery'),
  chatAttachments: join(uploadsRoot, 'chat-attachments'),
  topicAttachments: join(uploadsRoot, 'topic-attachments'),
  topicMuteEvidenceAttachments: join(uploadsRoot, 'topic-mute-evidence-attachments'),
  supportAttachments: join(uploadsRoot, 'support-attachments'),
}
for (const dir of [...Object.values(roots), outsideRoot]) await mkdir(dir, { recursive: true })

const sqliteModule = await import('node:sqlite')
const db: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, { open: true, enableForeignKeyConstraints: true })
db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')

const progressStore = await createPlayerProgressStore(databaseFilePath)
const banStore = await createProfileBanStore(databaseFilePath)
const authStore = await createAuthStore(databaseFilePath, progressStore, {
  registrationVerificationCodeSecret: SECRET,
  getRegistrationVerificationMode: () => 'direct',
  getActiveBanForProfile: (profileId) => {
    const ban = banStore.getActiveBan(profileId)
    return ban === null ? null : { bannedUntil: ban.bannedUntil, reason: ban.reason, remainingDays: ban.remainingDays }
  },
})
const requestStore = await createProfileDeletionRequestStore(databaseFilePath, { rateLimitSecret: SECRET })
const executor = await createProfileDeletionExecutor(databaseFilePath)
const executor2 = await createProfileDeletionExecutor(databaseFilePath) // втори Node процес
const tournamentStore = await createTournamentStore(databaseFilePath)
const tournamentEconomy = await createTournamentEconomyStore(databaseFilePath) // отделна връзка (друг процес)

const localGames = new Set<string>()
function makeWorker(exec: ProfileDeletionExecutor, workerId: string, onlyRequestIds?: string[], withLedger = true) {
  return createProfileDeletionWorker({
    executor: exec,
    workerId,
    uploadRoots: roots,
    removeFile: removeProfileDeletionFile,
    appendLedgerEntry: withLedger ? (entry) => appendProfileDeletionLedgerEntry(ledgerPath, entry) : null,
    isProfileInActiveGameLocally: (profileId) => localGames.has(profileId),
    onlyRequestIds,
  })
}

type User = { profileId: string; accountId: string; email: string; displayName: string }
let counter = 0
function registerUser(label: string): User {
  counter += 1
  const email = `wrk-${label.toLowerCase()}-${counter}@example.test`
  const displayName = `Wrk${label}${counter}`
  const result = authStore.register({ email, password: PASSWORD, displayName, gender: 'male', visitorId: randomUUID() })
  if (!result.ok || result.mode !== 'direct') throw new Error(`регистрация: ${JSON.stringify(result)}`)
  return { profileId: result.session.profile.profileId as string, accountId: result.session.account.accountId, email, displayName }
}

function dbNow(): string {
  return (db.prepare(`SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now;`).get() as { now: string }).now
}

function isoPlus(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString()
}

function withTriggerDropped<T>(name: string, fn: () => T): T {
  const sql = (db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?;`).get(name) as { sql: string }).sql
  db.exec(`DROP TRIGGER ${name};`)
  try { return fn() } finally { db.exec(sql) }
}

/** Заявка с изтекъл (или близък) срок — requested_at назад с точно 45 × 24 ч (insert guard-ът нормално го забранява). */
function insertRequestScheduledAt(user: User, scheduledForIso: string): string {
  const requestId = randomUUID()
  const createdAt = (db.prepare('SELECT created_at FROM profiles WHERE profile_id = ?;').get(user.profileId) as { created_at: string }).created_at
  const requestedAt = new Date(Date.parse(scheduledForIso) - PROFILE_DELETION_GRACE_PERIOD_MS).toISOString()
  withTriggerDropped('trg_profile_deletion_requests_insert_guard', () => {
    db.prepare(`
      INSERT INTO profile_deletion_requests (request_id, profile_id, account_id_snapshot, profile_created_at_snapshot, requested_at, scheduled_for)
      VALUES (?, ?, ?, ?, ?, ?);
    `).run(requestId, user.profileId, user.accountId, createdAt, requestedAt, scheduledForIso)
  })
  return requestId
}

function insertDueRequest(user: User): string {
  return insertRequestScheduledAt(user, isoPlus(dbNow(), -1000))
}

function requestRow(requestId: string): Record<string, unknown> {
  return db.prepare('SELECT * FROM profile_deletion_requests WHERE request_id = ?;').get(requestId) as Record<string, unknown>
}

function profileExists(profileId: string): boolean {
  return db.prepare('SELECT 1 FROM profiles WHERE profile_id = ?;').get(profileId) !== undefined
}

function count(sql: string, ...params: Array<string | number>): number {
  return Number((db.prepare(sql).get(...params) as Record<string, number>).c)
}

function expireRequestLease(requestId: string): void {
  db.prepare('UPDATE profile_deletion_requests SET lease_expires_at = ? WHERE request_id = ?;').run(isoPlus(dbNow(), -1000), requestId)
}

function makeRetryDue(requestId: string): void {
  db.prepare('UPDATE profile_deletion_requests SET next_attempt_at = ? WHERE request_id = ?;').run(isoPlus(dbNow(), -1000), requestId)
}

async function writeUpload(dir: string, ...segments: string[]): Promise<string> {
  const path = join(dir, ...segments)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, 'image-bytes')
  return path
}

const webp = () => `${randomUUID()}.webp`

function befriend(a: User, b: User): string {
  const friendshipId = randomUUID()
  const [lower, higher] = a.profileId < b.profileId ? [a.profileId, b.profileId] : [b.profileId, a.profileId]
  db.prepare(`
    INSERT INTO profile_friendships (friendship_id, requester_profile_id, addressee_profile_id, lower_profile_id, higher_profile_id, status, kind)
    VALUES (?, ?, ?, ?, ?, 'accepted', 'friend');
  `).run(friendshipId, a.profileId, b.profileId, lower, higher)
  return friendshipId
}

async function addChatMessage(friendshipId: string, sender: User, withAttachment: boolean): Promise<{ messageId: string; filePath: string | null; filename: string | null }> {
  const messageId = randomUUID()
  db.prepare(`INSERT INTO friend_chat_messages (message_id, friendship_id, sender_profile_id, body) VALUES (?, ?, ?, 'здрасти');`).run(messageId, friendshipId, sender.profileId)
  if (!withAttachment) return { messageId, filePath: null, filename: null }
  const filename = webp()
  const filePath = await writeUpload(roots.chatAttachments, filename)
  db.prepare(`INSERT INTO friend_chat_attachments (message_id, storage_filename, width, height, byte_size) VALUES (?, ?, 10, 10, 11);`).run(messageId, filename)
  return { messageId, filePath, filename }
}

function markRead(profile: User, friendshipId: string): void {
  db.prepare(`INSERT OR REPLACE INTO chat_conversation_reads (profile_id, friendship_id, last_read_at) VALUES (?, ?, CURRENT_TIMESTAMP);`).run(profile.profileId, friendshipId)
}

function createTopic(creator: User | null): string {
  const topicId = randomUUID()
  db.prepare(`INSERT INTO topics (topic_id, slug, title, created_by_profile_id) VALUES (?, ?, 'Тема', ?);`).run(topicId, `t-${topicId}`, creator?.profileId ?? null)
  return topicId
}

function addTopicMessage(topicId: string, sender: User, parentMessageId: string | null): string {
  const messageId = randomUUID()
  db.prepare(`
    INSERT INTO topic_messages (message_id, topic_id, parent_message_id, sender_profile_id, sender_display_name, sender_role, body)
    VALUES (?, ?, ?, ?, ?, 'player', 'текст');
  `).run(messageId, topicId, parentMessageId, sender.profileId, sender.displayName)
  return messageId
}

const giftItemId = randomUUID()
db.prepare(`INSERT INTO gift_items (gift_item_id, name, image_url, price) VALUES (?, 'Роза', '/uploads/gift-items/rose.webp', 50);`).run(giftItemId)

function sendGift(sender: User, recipient: User, price = 50): string {
  const transactionId = randomUUID()
  db.prepare(`
    INSERT INTO gift_item_transactions (transaction_id, gift_item_id, sender_profile_id, recipient_profile_id, charged_price, request_id)
    VALUES (?, ?, ?, ?, ?, ?);
  `).run(transactionId, giftItemId, sender.profileId, recipient.profileId, price, randomUUID())
  db.prepare(`
    INSERT INTO gift_item_delivery_log (transaction_id, recipient_profile_id, gift_item_id, item_name, image_url, from_display_name)
    VALUES (?, ?, ?, 'Роза', '/uploads/gift-items/rose.webp', ?);
  `).run(transactionId, recipient.profileId, giftItemId, sender.displayName)
  return transactionId
}

function insertBelotSnapshot(profileId: string): string {
  const roomId = randomUUID()
  db.prepare(`INSERT INTO active_room_snapshots (room_id, snapshot_version, room_status, state_version, snapshot_json) VALUES (?, 1, 'playing', 0, ?);`)
    .run(roomId, JSON.stringify({ status: 'playing', seats: { bottom: { participant: { kind: 'human', identity: { profileId }, permanentlyLeftAt: null } } } }))
  return roomId
}

function insertLudoSnapshot(profileId: string): string {
  const matchId = randomUUID()
  db.prepare(`INSERT INTO active_ludo_match_snapshots (match_id, snapshot_version, ludo_room_id, match_status, revision, snapshot_json) VALUES (?, 1, 'room', 'in_progress', 0, ?);`)
    .run(matchId, JSON.stringify({ players: [{ profileId }] }))
  return matchId
}

function insertSvaraSnapshot(profileId: string): string {
  const matchId = randomUUID()
  db.prepare(`INSERT INTO svara_match_snapshots (match_id, format_version, revision, match_status, snapshot_json) VALUES (?, 1, 0, 'in-progress', ?);`)
    .run(matchId, JSON.stringify({ formatVersion: 1, matchId, state: { phase: 'in-progress', seats: [profileId, 'other-seat'], status: { [profileId]: 'active', 'other-seat': 'active' } } }))
  return matchId
}

function insertOpenTournamentWithEntry(user: User, status = 'open'): { tournamentId: string; entryId: string } {
  const tournamentId = randomUUID()
  const entryId = randomUUID()
  db.prepare(`INSERT INTO tournaments (tournament_id, name, entry_fee, start_mode, status, creator_profile_id) VALUES (?, 'Турнир', 100, 'fill', ?, NULL);`).run(tournamentId, status)
  db.prepare(`INSERT INTO tournament_entries (entry_id, tournament_id, profile_id, joined_as, status) VALUES (?, ?, ?, 'solo', 'confirmed');`).run(entryId, tournamentId, user.profileId)
  return { tournamentId, entryId }
}

/** Всички текстови стойности в цялата база, съдържащи needle (за проверка за сираци/остатъчни лични данни). */
function findOccurrences(needle: string): string[] {
  const hits: string[] = []
  const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%';`).all() as Array<{ name: string }>).map((row) => row.name)
  for (const table of tables) {
    const columns = (db.prepare(`SELECT name FROM pragma_table_info(?);`).all(table) as Array<{ name: string }>).map((row) => row.name)
    for (const column of columns) {
      const found = Number((db.prepare(`SELECT COUNT(*) AS c FROM "${table}" WHERE instr(CAST("${column}" AS TEXT), ?) > 0;`).get(needle) as { c: number }).c)
      if (found > 0) hits.push(`${table}.${column}`)
    }
  }
  return hits
}

const DELETION_BOOKKEEPING_TABLES = new Set(['profile_deletion_requests', 'profile_deletion_events', 'profile_deletion_restore_tokens', 'profile_deletion_file_queue'])
// Компактните anti-abuse връзки (без FK) се запазват и при административното
// изтриване. Дали да се пазят при самоизтриване е правен въпрос за решение
// (финален отчет) — Етап 4 НЕ ги променя и не създава нови копия.
const RETAINED_PENDING_DECISION_TABLES = new Set(['profile_visitor_links', 'profile_ip_links'])

try {
  console.log('\n[S] Миграция 20261026_001')

  await check('[S1] Схема: gift_item_transactions е SET NULL, db_deleted_at съществува, новите тригери и campaign защитата са налице', () => {
    const fks = db.prepare(`SELECT "from", on_delete FROM pragma_foreign_key_list('gift_item_transactions') WHERE "table" = 'profiles';`).all() as Array<{ from: string; on_delete: string }>
    assertEqual(fks.length, 2, 'FK към profiles')
    assert(fks.every((fk) => fk.on_delete === 'SET NULL'), JSON.stringify(fks))
    assert(db.prepare(`SELECT 1 FROM pragma_table_info('profile_deletion_requests') WHERE name = 'db_deleted_at';`).get() !== undefined, 'db_deleted_at')
    for (const trigger of [
      'trg_profile_deletion_requests_db_deleted_guard',
      'trg_profile_deletion_requests_after_db_deleted',
      'trg_profile_deletion_requests_completion_guard',
      'trg_profile_deletion_file_queue_no_delete',
      'trg_tournament_entries_profile_deletion_admission_insert',
      'trg_tournament_entries_profile_deletion_admission_update',
      'trg_protect_campaign_gift_sender_profiles',
    ]) {
      assert(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?;`).get(trigger) !== undefined, trigger)
    }
    assertEqual((db.prepare('PRAGMA foreign_key_check;').all() as unknown[]).length, 0, 'foreign_key_check')
  })

  await check('[S2] Upgrade: съществуващи подаръци оцеляват байт по байт; после изтриване на изпращача пази реда със sender=NULL', async () => {
    const upgradeRoot = await createTempServerRoot((name) => name.localeCompare(NEW_MIGRATION, 'en') < 0)
    const { databaseFilePath: upgradePath } = await ensureServerDatabaseReady({ serverRootOverride: upgradeRoot })
    const up = new sqliteModule.DatabaseSync(upgradePath, { open: true, enableForeignKeyConstraints: true })
    try {
      up.exec('PRAGMA foreign_keys = ON;')
      const ids = [randomUUID(), randomUUID()]
      for (const id of ids) {
        up.prepare(`INSERT INTO profiles (profile_id, display_name, normalized_display_name) VALUES (?, ?, ?);`).run(id, `U${id.slice(0, 6)}`, `u${id.slice(0, 6)}`)
      }
      const gid = randomUUID()
      up.prepare(`INSERT INTO gift_items (gift_item_id, name, image_url, price) VALUES (?, 'X', '/uploads/gift-items/x.webp', 5);`).run(gid)
      up.prepare(`INSERT INTO gift_item_transactions (transaction_id, gift_item_id, sender_profile_id, recipient_profile_id, charged_price, context, request_id) VALUES ('tx-1', ?, ?, ?, 5, 'profile', 'rq-1');`).run(gid, ids[0], ids[1])
      const before = JSON.stringify(up.prepare('SELECT * FROM gift_item_transactions ORDER BY transaction_id;').all())
      up.close()
      await cp(join(sourceServerRoot, 'database', 'migrations', NEW_MIGRATION), join(upgradeRoot, 'database', 'migrations', NEW_MIGRATION))
      await ensureServerDatabaseReady({ serverRootOverride: upgradeRoot })
      const after = new sqliteModule.DatabaseSync(upgradePath, { open: true, enableForeignKeyConstraints: true })
      after.exec('PRAGMA foreign_keys = ON;')
      assertEqual(JSON.stringify(after.prepare('SELECT * FROM gift_item_transactions ORDER BY transaction_id;').all()), before, 'редовете след upgrade')
      assertEqual((after.prepare('PRAGMA foreign_key_check;').all() as unknown[]).length, 0, 'foreign_key_check')
      after.prepare('DELETE FROM profiles WHERE profile_id = ?;').run(ids[0])
      const row = after.prepare(`SELECT sender_profile_id, recipient_profile_id, charged_price FROM gift_item_transactions WHERE transaction_id = 'tx-1';`).get() as Record<string, unknown>
      assertEqual(row.sender_profile_id, null, 'sender след изтриване')
      assertEqual(row.recipient_profile_id, ids[1], 'recipient непроменен')
      assertEqual(row.charged_price, 5, 'сума')
      after.close()
    } finally {
      await rm(upgradeRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  await check('[S3] Всяка *_snapshot колона за изтрит профил в схемата е покрита от executor-а', async () => {
    const source = await readFile(join(sourceServerRoot, 'src', 'db', 'profileDeletionExecutor.ts'), 'utf8')
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table';`).all() as Array<{ name: string }>).map((row) => row.name)
    const missing: string[] = []
    for (const table of tables) {
      for (const { name } of db.prepare(`SELECT name FROM pragma_table_info(?);`).all(table) as Array<{ name: string }>) {
        if (!/^deleted_.*profile_id_snapshot$/.test(name)) continue
        if (!new RegExp(`UPDATE ${table} SET [^;]*${name}`).test(source.replace(/\s+/g, ' '))) missing.push(`${table}.${name}`)
      }
    }
    assert(missing.length === 0, `непокрити: ${missing.join(', ')}`)
  })

  console.log('\n[T] Срок и заявки')

  await check('[T1] Изтриване точно след 45 × 24 ч: преди scheduled_for не се взема, след него — изтрива', async () => {
    const user = registerUser('Exact')
    const scheduledFor = isoPlus(dbNow(), 1500)
    const requestId = insertRequestScheduledAt(user, scheduledFor)
    const row = requestRow(requestId)
    assertEqual(Date.parse(String(row.scheduled_for)) - Date.parse(String(row.requested_at)), PROFILE_DELETION_GRACE_PERIOD_MS, '45 × 24 ч')
    assertEqual(executor.claimNextDueRequest('w-exact', requestId), null, 'claim преди срока')
    while (dbNow() < scheduledFor) await sleep(100)
    const summary = await makeWorker(executor, 'w-exact', [requestId]).runOnce()
    assertEqual(summary.completed, 1, `completed (${JSON.stringify(summary)})`)
    assert(!profileExists(user.profileId), 'профилът е изтрит')
    assertEqual(requestRow(requestId).status, 'completed', 'статус')
  })

  await check('[T2] Отказ преди срока: worker-ът не взема, а принудителен преход се отхвърля от тригера', () => {
    const user = registerUser('Early')
    const result = requestStore.createRequest({ profileId: user.profileId, accountId: user.accountId })
    assert(result.ok, JSON.stringify(result))
    if (!result.ok) return
    assertEqual(executor.claimNextDueRequest('w-early', result.request.requestId), null, 'claim')
    assertRejects(
      () => db.prepare(`UPDATE profile_deletion_requests SET status = 'executing', lease_owner = 'x', lease_expires_at = ? WHERE request_id = ?;`).run(isoPlus(dbNow(), 60_000), result.request.requestId),
      'profile_deletion_not_due',
      'принудително executing',
    )
    assert(profileExists(user.profileId), 'профилът е непокътнат')
  })

  await check('[T3] Отменена заявка никога не се изтрива — и след изтичане на срока', async () => {
    const user = registerUser('Cancel')
    const scheduledFor = isoPlus(dbNow(), 800)
    const requestId = insertRequestScheduledAt(user, scheduledFor)
    const issued = requestStore.issueRestoreToken(user.profileId)
    assert(issued.ok, 'токен')
    if (!issued.ok) return
    assert(requestStore.cancelWithToken(issued.restoreToken).ok, 'отмяна')
    while (dbNow() < scheduledFor) await sleep(100)
    assertEqual(executor.claimNextDueRequest('w-cancel', requestId), null, 'claim на отменена')
    await makeWorker(executor, 'w-cancel').runOnce()
    assert(profileExists(user.profileId), 'профилът съществува')
    assertEqual(requestRow(requestId).status, 'cancelled', 'статус')
  })

  await check('[T4] Състезание отмяна/worker на границата: точно една от двете страни успява', async () => {
    const user = registerUser('Boundary')
    const scheduledFor = isoPlus(dbNow(), 600)
    const requestId = insertRequestScheduledAt(user, scheduledFor)
    const issued = requestStore.issueRestoreToken(user.profileId)
    assert(issued.ok, 'токен')
    if (!issued.ok) return
    while (dbNow() < scheduledFor) await sleep(50)
    const claimed = executor.claimNextDueRequest('w-boundary', requestId)
    const cancel = requestStore.cancelWithToken(issued.restoreToken)
    assert(claimed !== null, 'worker взе заявката след срока')
    assert(!cancel.ok, 'отмяната след срока е отказана')
    // Обратният ред — отмяна преди срока, после worker:
    const user2 = registerUser('Boundary2')
    const requestId2 = insertRequestScheduledAt(user2, isoPlus(dbNow(), 60_000))
    const issued2 = requestStore.issueRestoreToken(user2.profileId)
    assert(issued2.ok && requestStore.cancelWithToken(issued2.restoreToken).ok, 'отмяна преди срока')
    assertEqual(executor.claimNextDueRequest('w-boundary', requestId2), null, 'worker след отмяна')
    // Довършване на първата заявка.
    expireRequestLease(requestId)
    assertEqual((await makeWorker(executor, 'w-boundary-2', [requestId]).runOnce()).completed, 1, 'довършване')
  })

  await check('[T5] Срив преди COMMIT: всичко се връща; след рестарт (изтекъл lease) друг worker довършва', async () => {
    const user = registerUser('Crash')
    const avatarName = webp()
    const avatarPath = await writeUpload(roots.avatars, avatarName)
    db.prepare('UPDATE profiles SET avatar_url = ? WHERE profile_id = ?;').run(`/uploads/avatars/${avatarName}`, user.profileId)
    const requestId = insertDueRequest(user)
    const crashing = await createProfileDeletionExecutor(databaseFilePath, {
      testHooks: { beforeDatabasePhaseCommit: () => { throw Object.assign(new Error('simulated crash'), { profileDeletionSimulatedCrash: true }) } },
    })
    try {
      let crashed = false
      try {
        await makeWorker(crashing, 'w-crash', [requestId]).runOnce()
      } catch {
        crashed = true
      }
      assert(crashed, 'симулираният срив прекъсна worker-а')
    } finally {
      crashing.close()
    }
    assert(profileExists(user.profileId), 'профилът е непокътнат (ROLLBACK)')
    assertEqual(count('SELECT COUNT(*) AS c FROM profile_deletion_file_queue WHERE request_id = ?;', requestId), 0, 'опашката е празна')
    assert(existsSync(avatarPath), 'файлът е непокътнат')
    assertEqual(requestRow(requestId).status, 'executing', 'остава executing с висящ lease')
    assertEqual(executor.claimNextDueRequest('w-crash-2', requestId), null, 'жив lease не се отнема')
    expireRequestLease(requestId)
    assertEqual((await makeWorker(executor, 'w-crash-2', [requestId]).runOnce()).completed, 1, 'довършване след рестарт')
    assert(!profileExists(user.profileId) && !existsSync(avatarPath), 'профил и файл изтрити')
    assertEqual(count(`SELECT COUNT(*) AS c FROM profile_deletion_events WHERE request_id = ? AND event_type = 'lease_reclaimed';`, requestId), 1, 'lease_reclaimed')
  })

  await check('[T6] Два едновременно работещи worker-а (два процеса): всяка заявка се обработва точно веднъж', async () => {
    const users = [registerUser('ParA'), registerUser('ParB'), registerUser('ParC')]
    const requestIds = users.map((user) => insertDueRequest(user))
    const [a, b] = await Promise.all([
      makeWorker(executor, 'w-par-a', requestIds).runOnce(),
      makeWorker(executor2, 'w-par-b', requestIds).runOnce(),
    ])
    assertEqual(a.completed + b.completed, 3, `общо completed (${JSON.stringify([a, b])})`)
    for (const requestId of requestIds) {
      assertEqual(count(`SELECT COUNT(*) AS c FROM profile_deletion_events WHERE request_id = ? AND event_type IN ('claimed', 'lease_reclaimed');`, requestId), 1, `един claim за ${requestId}`)
      assertEqual(count(`SELECT COUNT(*) AS c FROM profile_deletion_events WHERE request_id = ? AND event_type = 'db_deleted';`, requestId), 1, 'едно db_deleted')
    }
    assert(users.every((user) => !profileExists(user.profileId)), 'всички изтрити')
  })

  await check('[T7] Изтекъл lease: старият worker губи правото да продължи (lease_lost)', async () => {
    const user = registerUser('Lease')
    const requestId = insertDueRequest(user)
    const claimedByA = executor.claimNextDueRequest('w-lease-a', requestId)
    assert(claimedByA !== null, 'A взе')
    assertEqual(executor2.claimNextDueRequest('w-lease-b', requestId), null, 'B не може при жив lease')
    expireRequestLease(requestId)
    const claimedByB = executor2.claimNextDueRequest('w-lease-b', requestId)
    assert(claimedByB !== null, 'B пое след изтичане')
    if (claimedByA === null || claimedByB === null) return
    assertEqual(executor.runDatabasePhase(claimedByA, 'w-lease-a').kind, 'lease_lost', 'A: DB фаза')
    assert(profileExists(user.profileId), 'A не изтри нищо')
    assertEqual(executor2.runDatabasePhase(claimedByB, 'w-lease-b').kind, 'db_deleted', 'B изтри')
    assertEqual(executor.finishRequest(requestId, 'w-lease-a').kind, 'lease_lost', 'A не може да завърши')
    assertEqual(executor2.finishRequest(requestId, 'w-lease-b').kind, 'completed', 'B завърши')
  })

  await check('[T8] Постоянна грешка: ограничени повторни опити с backoff, после failed без автоматичен опит', async () => {
    const user = registerUser('Retry')
    const requestId = insertDueRequest(user)
    const broken = await createProfileDeletionExecutor(databaseFilePath, {
      testHooks: { beforeDatabasePhaseCommit: () => { throw new Error('persistent failure') } },
    })
    try {
      for (let attempt = 1; attempt <= PROFILE_DELETION_MAX_FAILED_ATTEMPTS; attempt += 1) {
        if (attempt > 1) makeRetryDue(requestId)
        const summary = await makeWorker(broken, 'w-retry', [requestId], false).runOnce()
        assertEqual(summary.failed, 1, `опит ${attempt}`)
        const row = requestRow(requestId)
        assertEqual(row.status, 'failed', 'статус')
        assertEqual(row.last_error_code, 'db_phase_error', 'код')
        assertEqual(row.attempt_count, attempt, 'attempt_count')
        if (attempt < PROFILE_DELETION_MAX_FAILED_ATTEMPTS) {
          assert(typeof row.next_attempt_at === 'string' && String(row.next_attempt_at) > dbNow(), 'next_attempt_at в бъдещето')
          assertEqual(broken.claimNextDueRequest('w-retry', requestId), null, 'не се взема преди next_attempt_at')
        } else {
          assertEqual(row.next_attempt_at, null, 'без автоматичен опит след лимита')
        }
      }
      assertEqual(broken.claimNextDueRequest('w-retry', requestId), null, 'изчерпаната заявка не се взема')
      assert(profileExists(user.profileId), 'нищо не е изтрито')
    } finally {
      broken.close()
    }
  })

  console.log('\n[D] Данни')

  const target = registerUser('Target')
  const friend = registerUser('Friend')
  const stranger1 = registerUser('StrA')
  const stranger2 = registerUser('StrB')
  const giftFan = registerUser('Fan')
  const payer = registerUser('Payer')

  // Личен разговор target <-> friend (двете страни пишат, двама са чели, има снимки).
  const targetFriendship = befriend(target, friend)
  const msgByTarget = await addChatMessage(targetFriendship, target, true)
  const msgByFriend = await addChatMessage(targetFriendship, friend, true)
  markRead(target, targetFriendship)
  markRead(friend, targetFriendship)
  // Несвързан разговор stranger1 <-> stranger2.
  const unrelatedFriendship = befriend(stranger1, stranger2)
  const unrelatedMsg = await addChatMessage(unrelatedFriendship, stranger1, true)
  markRead(stranger1, unrelatedFriendship)

  // Аватар + галерия.
  const targetAvatarName = webp()
  const targetAvatarPath = await writeUpload(roots.avatars, targetAvatarName)
  db.prepare('UPDATE profiles SET avatar_url = ? WHERE profile_id = ?;').run(`/uploads/avatars/${targetAvatarName}`, target.profileId)
  const galleryName = webp()
  const galleryPath = await writeUpload(roots.profileGallery, target.profileId, galleryName)
  const galleryUrl = `/uploads/profile-gallery/${target.profileId}/${galleryName}`
  db.prepare(`INSERT INTO profile_gallery_images (image_id, profile_id, image_url, thumbnail_url) VALUES (?, ?, ?, ?);`).run(randomUUID(), target.profileId, galleryUrl, galleryUrl)

  // Теми: чужд root с отговор от target (отговорът се трие, root-ът остава);
  // root на target с отговор само от target (трие се целият).
  const topicId = createTopic(stranger1)
  const foreignRoot = addTopicMessage(topicId, stranger1, null)
  const targetReplyUnderForeign = addTopicMessage(topicId, target, foreignRoot)
  const strangerReplyUnderForeign = addTopicMessage(topicId, stranger2, foreignRoot)
  const targetRoot = addTopicMessage(topicId, target, null)
  addTopicMessage(topicId, target, targetRoot)
  const topicFileName = webp()
  const topicFilePath = await writeUpload(roots.topicAttachments, topicFileName)
  db.prepare(`INSERT INTO topic_message_attachments (message_id, storage_filename, width, height, byte_size) VALUES (?, ?, 1, 1, 11);`).run(targetRoot, topicFileName)
  db.prepare(`INSERT INTO topic_message_likes (message_id, liker_profile_id) VALUES (?, ?);`).run(foreignRoot, target.profileId)
  // Evidence копие (отделен файл) за mute на target.
  const evidenceName = webp()
  const evidencePath = await writeUpload(roots.topicMuteEvidenceAttachments, evidenceName)
  db.prepare(`
    INSERT INTO topic_mute_evidence (mute_history_id, mute_audit_log_id, profile_id, source_topic_id, source_kind, muted_by_role, duration_ms, muted_until, source_attachment_storage_filename, source_attachment_is_evidence_copy)
    VALUES (?, ?, ?, ?, 'topic_reply', 'admin', 60000, datetime('now', '+1 day'), ?, 1);
  `).run(randomUUID(), randomUUID(), target.profileId, topicId, evidenceName)

  // Подаръци: target -> fan (получен от fan), fan -> target (получен от target).
  const giftFromTarget = sendGift(target, giftFan, 70)
  const giftToTarget = sendGift(giftFan, target, 30)
  const totalChargedBefore = count('SELECT COALESCE(SUM(charged_price), 0) AS c FROM gift_item_transactions;')

  // Финансови записи: покупка на target; подарък-покупка от payer за target;
  // подарък-покупка от target за fan + известие към fan.
  const ownPurchaseId = randomUUID()
  db.prepare(`
    INSERT INTO coin_purchase_ledger (purchase_id, profile_id, package_key_snapshot, title_snapshot, yellow_coins_amount, price_cents, currency, status, provider_checkout_session_id, stripe_payment_intent_id, card_last4)
    VALUES (?, ?, 'p1', 'Пакет', 1000, 499, 'eur', 'paid', ?, 'pi_test_own', '4242');
  `).run(ownPurchaseId, target.profileId, `cs_${randomUUID()}`)
  const giftPurchaseForTarget = randomUUID()
  db.prepare(`
    INSERT INTO coin_purchase_ledger (purchase_id, profile_id, package_key_snapshot, title_snapshot, yellow_coins_amount, price_cents, currency, status, recipient_profile_id, recipient_display_name_snapshot, stripe_payment_intent_id)
    VALUES (?, ?, 'p1', 'Пакет', 1000, 499, 'eur', 'paid', ?, ?, 'pi_test_gift_in');
  `).run(giftPurchaseForTarget, payer.profileId, target.profileId, target.displayName)
  const giftPurchaseByTarget = randomUUID()
  db.prepare(`
    INSERT INTO coin_purchase_ledger (purchase_id, profile_id, package_key_snapshot, title_snapshot, yellow_coins_amount, price_cents, currency, status, recipient_profile_id, recipient_display_name_snapshot, stripe_payment_intent_id)
    VALUES (?, ?, 'p1', 'Пакет', 1000, 499, 'eur', 'paid', ?, ?, 'pi_test_gift_out');
  `).run(giftPurchaseByTarget, target.profileId, giftFan.profileId, giftFan.displayName)
  db.prepare(`
    INSERT INTO paid_gift_notification_log (purchase_id, purchase_type, recipient_profile_id, sender_display_name_snapshot, body_text)
    VALUES (?, 'coin', ?, ?, ?);
  `).run(giftPurchaseByTarget, giftFan.profileId, target.displayName, `${target.displayName} ви подари 1000 жълтици.`)
  db.prepare(`
    INSERT INTO paid_gift_notification_log (purchase_id, purchase_type, recipient_profile_id, sender_display_name_snapshot, body_text)
    VALUES (?, 'coin', ?, ?, ?);
  `).run(giftPurchaseForTarget, target.profileId, payer.displayName, `${payer.displayName} ви подари 1000 жълтици.`)

  // Завършен турнир с резултати на target и на друг участник.
  const finishedTournamentId = randomUUID()
  db.prepare(`INSERT INTO tournaments (tournament_id, name, entry_fee, start_mode, status, creator_profile_id) VALUES (?, 'Завършен', 100, 'fill', 'finished', ?);`).run(finishedTournamentId, target.profileId)
  const championTeam = randomUUID()
  db.prepare(`INSERT INTO tournament_teams (team_id, tournament_id, status) VALUES (?, ?, 'champion');`).run(championTeam, finishedTournamentId)
  db.prepare(`INSERT INTO tournament_entries (entry_id, tournament_id, profile_id, team_id, joined_as, status) VALUES (?, ?, ?, ?, 'partner_inviter', 'champion');`).run(randomUUID(), finishedTournamentId, target.profileId, championTeam)
  db.prepare(`INSERT INTO tournament_entries (entry_id, tournament_id, profile_id, team_id, joined_as, status) VALUES (?, ?, ?, ?, 'partner_invitee', 'champion');`).run(randomUUID(), finishedTournamentId, friend.profileId, championTeam)
  const matchRoom = randomUUID()
  db.prepare(`INSERT INTO profile_match_results (room_id, profile_id, team, did_win) VALUES (?, ?, 'A', 1);`).run(matchRoom, target.profileId)
  db.prepare(`INSERT INTO profile_match_results (room_id, profile_id, team, did_win) VALUES (?, ?, 'A', 1);`).run(matchRoom, friend.profileId)

  // Лайкове и блокировки.
  db.prepare(`INSERT INTO profile_likes (liker_profile_id, liked_profile_id, total_given) VALUES (?, ?, 3);`).run(target.profileId, stranger1.profileId)
  db.prepare(`INSERT INTO profile_likes (liker_profile_id, liked_profile_id, total_given) VALUES (?, ?, 2);`).run(stranger2.profileId, target.profileId)
  db.prepare(`INSERT INTO player_blocks (blocker_profile_id, blocked_profile_id) VALUES (?, ?);`).run(stranger2.profileId, target.profileId)
  const stranger1LikesBefore = count('SELECT COALESCE(SUM(total_given), 0) AS c FROM profile_likes WHERE liked_profile_id = ?;', stranger1.profileId)

  // Заявка с изтекъл 45-дневен срок (сесиите са отнети при подаването).
  authStore.revokeAllSessionsForProfile(target.profileId)
  const targetRequestId = insertDueRequest(target)
  const targetSummary = await makeWorker(executor, 'w-data', [targetRequestId]).runOnce()

  await check('[D1] Профилът и акаунтът (единствен профил) са физически премахнати; заявката е completed', () => {
    assertEqual(targetSummary.completed, 1, `completed (${JSON.stringify(targetSummary)})`)
    assert(!profileExists(target.profileId), 'profiles')
    assertEqual(count('SELECT COUNT(*) AS c FROM accounts WHERE account_id = ?;', target.accountId), 0, 'accounts')
    assertEqual(count('SELECT COUNT(*) AS c FROM account_sessions WHERE profile_id = ? OR account_id = ?;', target.profileId, target.accountId), 0, 'sessions')
    const row = requestRow(targetRequestId)
    assertEqual(row.status, 'completed', 'статус')
    assert(typeof row.db_deleted_at === 'string' && typeof row.completed_at === 'string', 'db_deleted_at/completed_at')
    assertEqual(row.lease_owner, null, 'lease освободен')
  })

  await check('[D2] Личният разговор е изтрит за ДВЕТЕ страни: съобщения, снимки, маркери за прочитане', () => {
    assertEqual(count('SELECT COUNT(*) AS c FROM profile_friendships WHERE friendship_id = ?;', targetFriendship), 0, 'friendship')
    assertEqual(count('SELECT COUNT(*) AS c FROM friend_chat_messages WHERE friendship_id = ?;', targetFriendship), 0, 'съобщения (и на двете страни)')
    assertEqual(count('SELECT COUNT(*) AS c FROM friend_chat_attachments WHERE message_id IN (?, ?);', msgByTarget.messageId, msgByFriend.messageId), 0, 'снимки')
    assertEqual(count('SELECT COUNT(*) AS c FROM chat_conversation_reads WHERE friendship_id = ?;', targetFriendship), 0, 'маркери за прочитане (и на friend)')
    assert(profileExists(friend.profileId), 'другият участник е непокътнат')
  })

  await check('[D3] Файловете (аватар, галерия, снимки от чата на двете страни, Теми, evidence копие) са физически изтрити', () => {
    for (const path of [targetAvatarPath, galleryPath, msgByTarget.filePath as string, msgByFriend.filePath as string, topicFilePath, evidencePath]) {
      assert(!existsSync(path), `файлът още съществува: ${path.slice(uploadsRoot.length)}`)
    }
    assert(!existsSync(join(roots.profileGallery, target.profileId)), 'празната директория на галерията е премахната')
    const statuses = db.prepare('SELECT status, COUNT(*) AS c FROM profile_deletion_file_queue WHERE request_id = ? GROUP BY status;').all(targetRequestId) as Array<{ status: string; c: number }>
    assertEqual(JSON.stringify(statuses), JSON.stringify([{ status: 'done', c: 6 }]), 'опашката')
  })

  await check('[D4] Несвързаният разговор (други двама) е напълно непокътнат', () => {
    assertEqual(count('SELECT COUNT(*) AS c FROM profile_friendships WHERE friendship_id = ?;', unrelatedFriendship), 1, 'friendship')
    assertEqual(count('SELECT COUNT(*) AS c FROM friend_chat_messages WHERE friendship_id = ?;', unrelatedFriendship), 1, 'съобщения')
    assertEqual(count('SELECT COUNT(*) AS c FROM friend_chat_attachments WHERE message_id = ?;', unrelatedMsg.messageId), 1, 'снимка')
    assertEqual(count('SELECT COUNT(*) AS c FROM chat_conversation_reads WHERE friendship_id = ?;', unrelatedFriendship), 1, 'маркер')
    assert(existsSync(unrelatedMsg.filePath as string), 'файлът на несвързания разговор')
  })

  await check('[D5] Теми: собственото съдържание е изтрито, чуждият root и чуждите отговори са запазени', () => {
    assertEqual(count('SELECT COUNT(*) AS c FROM topic_messages WHERE message_id IN (?, ?);', foreignRoot, strangerReplyUnderForeign), 2, 'чужд root + чужд отговор')
    assertEqual(count('SELECT COUNT(*) AS c FROM topic_messages WHERE message_id IN (?, ?);', targetReplyUnderForeign, targetRoot), 0, 'съдържанието на target')
    assertEqual(count('SELECT COUNT(*) AS c FROM topics WHERE topic_id = ?;', topicId), 1, 'темата')
  })

  await check('[D6] Подаръци: получените от fan остават (sender=NULL, името е заменено); сумата на изхарчените жълтици е непроменена', () => {
    const fromTarget = db.prepare('SELECT sender_profile_id, recipient_profile_id, charged_price FROM gift_item_transactions WHERE transaction_id = ?;').get(giftFromTarget) as Record<string, unknown>
    assertEqual(fromTarget.sender_profile_id, null, 'sender')
    assertEqual(fromTarget.recipient_profile_id, giftFan.profileId, 'recipient (fan)')
    assertEqual(fromTarget.charged_price, 70, 'сума')
    const delivery = db.prepare('SELECT from_display_name FROM gift_item_delivery_log WHERE transaction_id = ?;').get(giftFromTarget) as { from_display_name: string }
    assertEqual(delivery.from_display_name, PROFILE_DELETION_DELETED_LABEL, 'име в известието на fan')
    const toTarget = db.prepare('SELECT sender_profile_id, recipient_profile_id FROM gift_item_transactions WHERE transaction_id = ?;').get(giftToTarget) as Record<string, unknown>
    assertEqual(toTarget.sender_profile_id, giftFan.profileId, 'разходът на fan остава')
    assertEqual(toTarget.recipient_profile_id, null, 'recipient')
    assertEqual(count('SELECT COUNT(*) AS c FROM gift_item_delivery_log WHERE transaction_id = ?;', giftToTarget), 0, 'известието КЪМ target е изтрито')
    assertEqual(count('SELECT COALESCE(SUM(charged_price), 0) AS c FROM gift_item_transactions;'), totalChargedBefore, 'общо изхарчени')
  })

  await check('[D7] Турнирна история: турнирът, отборът и резултатите остават; target е анонимизиран (NULL + snapshot), другите — непроменени', () => {
    assertEqual(count('SELECT COUNT(*) AS c FROM tournaments WHERE tournament_id = ?;', finishedTournamentId), 1, 'турнир')
    const tournament = db.prepare('SELECT creator_profile_id, deleted_creator_profile_id_snapshot, status FROM tournaments WHERE tournament_id = ?;').get(finishedTournamentId) as Record<string, unknown>
    assertEqual(tournament.creator_profile_id, null, 'creator')
    assertEqual(tournament.deleted_creator_profile_id_snapshot, target.profileId, 'creator snapshot')
    assertEqual(tournament.status, 'finished', 'статус')
    const entries = db.prepare('SELECT profile_id, deleted_profile_id_snapshot, status, team_id FROM tournament_entries WHERE tournament_id = ? ORDER BY profile_id IS NOT NULL;').all(finishedTournamentId) as Array<Record<string, unknown>>
    assertEqual(entries.length, 2, 'записи')
    assertEqual(entries[0].profile_id, null, 'target entry')
    assertEqual(entries[0].deleted_profile_id_snapshot, target.profileId, 'target snapshot')
    assertEqual(entries[0].status, 'champion', 'победата е запазена')
    assertEqual(entries[1].profile_id, friend.profileId, 'съотборникът е непроменен')
    assertEqual(entries[1].status, 'champion', 'резултатът на съотборника')
    const results = db.prepare('SELECT profile_id, deleted_profile_id_snapshot, did_win FROM profile_match_results WHERE room_id = ? ORDER BY profile_id IS NULL;').all(matchRoom) as Array<Record<string, unknown>>
    assertEqual(results.length, 2, 'резултати от мача')
    assertEqual(results[1].deleted_profile_id_snapshot, target.profileId, 'snapshot в резултатите')
    assertEqual(results[1].did_win, 1, 'победа')
  })

  await check('[D8] Финансови записи: остават със суми и Stripe идентификатори; атрибуцията е snapshot; името на получателя в чужд запис е заменено', () => {
    const own = db.prepare('SELECT profile_id, deleted_profile_id_snapshot, price_cents, stripe_payment_intent_id, card_last4, status FROM coin_purchase_ledger WHERE purchase_id = ?;').get(ownPurchaseId) as Record<string, unknown>
    assertEqual(own.profile_id, null, 'payer')
    assertEqual(own.deleted_profile_id_snapshot, target.profileId, 'payer snapshot')
    assertEqual(own.price_cents, 499, 'сума')
    assertEqual(own.stripe_payment_intent_id, 'pi_test_own', 'Stripe идентификатор')
    assertEqual(own.card_last4, '4242', 'платежни данни')
    assertEqual(own.status, 'paid', 'статус')
    const incoming = db.prepare('SELECT profile_id, recipient_profile_id, deleted_recipient_profile_id_snapshot, recipient_display_name_snapshot, stripe_payment_intent_id FROM coin_purchase_ledger WHERE purchase_id = ?;').get(giftPurchaseForTarget) as Record<string, unknown>
    assertEqual(incoming.profile_id, payer.profileId, 'payer-ът е непроменен')
    assertEqual(incoming.recipient_profile_id, null, 'recipient')
    assertEqual(incoming.deleted_recipient_profile_id_snapshot, target.profileId, 'recipient snapshot')
    assertEqual(incoming.recipient_display_name_snapshot, PROFILE_DELETION_DELETED_LABEL, 'името на получателя')
    assertEqual(incoming.stripe_payment_intent_id, 'pi_test_gift_in', 'Stripe')
    const outgoing = db.prepare('SELECT recipient_profile_id, recipient_display_name_snapshot FROM coin_purchase_ledger WHERE purchase_id = ?;').get(giftPurchaseByTarget) as Record<string, unknown>
    assertEqual(outgoing.recipient_profile_id, giftFan.profileId, 'получателят fan е непроменен')
    assertEqual(outgoing.recipient_display_name_snapshot, giftFan.displayName, 'името на fan е непроменено')
    const notice = db.prepare('SELECT sender_display_name_snapshot, body_text FROM paid_gift_notification_log WHERE purchase_id = ?;').get(giftPurchaseByTarget) as Record<string, string>
    assertEqual(notice.sender_display_name_snapshot, PROFILE_DELETION_DELETED_LABEL, 'изпращач в известието на fan')
    assertEqual(notice.body_text, `${PROFILE_DELETION_DELETED_LABEL} ви подари 1000 жълтици.`, 'текст на известието')
    assertEqual(count('SELECT COUNT(*) AS c FROM paid_gift_notification_log WHERE purchase_id = ?;', giftPurchaseForTarget), 0, 'известието КЪМ target е изтрито')
  })

  await check('[D9] Няма сираци и счупени FK; ID/акаунт/име/имейл на target не остават извън snapshot колоните, журнала и anti-abuse връзките (за решение)', () => {
    assertEqual((db.prepare('PRAGMA foreign_key_check;').all() as unknown[]).length, 0, 'foreign_key_check')
    const unexpected = (needle: string) => findOccurrences(needle).filter((hit) => {
      const [table, column] = hit.split('.')
      return !DELETION_BOOKKEEPING_TABLES.has(table) && !RETAINED_PENDING_DECISION_TABLES.has(table) && !/^deleted_.*_snapshot$/.test(column)
    })
    assertEqual(unexpected(target.profileId).join(', '), '', 'profile_id')
    assertEqual(unexpected(target.accountId).join(', '), '', 'account_id')
    assertEqual(findOccurrences(target.displayName).join(', '), '', 'display name')
    assertEqual(findOccurrences(target.email).join(', '), '', 'имейл')
  })

  await check('[D10] Лайкове: дадените от target се броят в чуждите тотали (несвързан идентификатор); получените от target са изтрити; блокировки — изтрити', () => {
    assertEqual(count('SELECT COALESCE(SUM(total_given), 0) AS c FROM profile_likes WHERE liked_profile_id = ?;', stranger1.profileId), stranger1LikesBefore, 'тоталът на stranger1')
    assertEqual(count(`SELECT COUNT(*) AS c FROM profile_likes WHERE liked_profile_id = ? AND liker_profile_id LIKE 'deleted-%';`, stranger1.profileId), 1, 'анонимен liker')
    assertEqual(count('SELECT COUNT(*) AS c FROM player_blocks WHERE blocker_profile_id = ? OR blocked_profile_id = ?;', target.profileId, target.profileId), 0, 'блокировки')
  })

  await check('[D11] Журналът на изтриването съдържа само технически кодове (без имена, имейли и пътища до файлове)', () => {
    const details = (db.prepare('SELECT detail_json FROM profile_deletion_events WHERE request_id = ?;').all(targetRequestId) as Array<{ detail_json: string | null }>)
      .map((row) => row.detail_json ?? '').join('\n')
    for (const forbidden of [target.displayName, target.email, '/uploads/', '.webp']) {
      assert(!details.includes(forbidden), `журналът съдържа "${forbidden}"`)
    }
    const types = (db.prepare('SELECT event_type FROM profile_deletion_events WHERE request_id = ? ORDER BY event_seq;').all(targetRequestId) as Array<{ event_type: string }>).map((row) => row.event_type)
    assertEqual(types[0], 'claimed', 'първо събитие')
    assert(types.includes('db_deleted') && types.includes('file_enqueued') && types.at(-1) === 'completed', types.join(','))
  })

  await check('[D12] Чужди отговори под съобщение на профила БЛОКИРАТ изтриването (без каскада); след премахването им — изтрива се', async () => {
    const author = registerUser('TopicAuthor')
    const replier = registerUser('Replier')
    const ownTopic = createTopic(author)
    const authorRoot = addTopicMessage(ownTopic, author, null)
    const foreignReply = addTopicMessage(ownTopic, replier, authorRoot)
    const requestId = insertDueRequest(author)
    const summary = await makeWorker(executor, 'w-topic', [requestId]).runOnce()
    assertEqual(summary.blocked, 1, 'blocked')
    const row = requestRow(requestId)
    assertEqual(row.status, 'blocked', 'статус')
    assertEqual(row.last_error_code, 'topic_foreign_replies', 'код')
    assert(profileExists(author.profileId), 'профилът е непокътнат')
    assertEqual(count('SELECT COUNT(*) AS c FROM topic_messages WHERE message_id IN (?, ?);', authorRoot, foreignReply), 2, 'нищо от Теми не е изтрито')
    // Модератор премахва чуждия отговор (напр. обичайното почистване) — повторен опит.
    db.prepare('DELETE FROM topic_messages WHERE message_id = ?;').run(foreignReply)
    makeRetryDue(requestId)
    assertEqual((await makeWorker(executor, 'w-topic', [requestId]).runOnce()).completed, 1, 'изтриване при повторен опит')
    assert(!profileExists(author.profileId), 'изтрит')
  })

  await check('[D13] Няколко профила на един акаунт: изтрива се само профилът; акаунтът и другият профил остават', async () => {
    const owner = registerUser('Multi')
    const secondProfileId = randomUUID()
    db.prepare(`INSERT INTO profiles (profile_id, account_id, display_name, normalized_display_name) VALUES (?, ?, ?, ?);`).run(secondProfileId, owner.accountId, `Second${counter}`, `second${counter}`)
    const requestId = insertDueRequest(owner)
    assertEqual((await makeWorker(executor, 'w-multi', [requestId]).runOnce()).completed, 1, 'completed')
    assert(!profileExists(owner.profileId), 'изтритият профил')
    assert(profileExists(secondProfileId), 'другият профил остава')
    assertEqual(count('SELECT COUNT(*) AS c FROM accounts WHERE account_id = ?;', owner.accountId), 1, 'акаунтът остава')
  })

  await check('[D14] Сменена идентичност (profile_created_at не съвпада) — НИКОГА не се изтрива; failed без автоматичен опит', async () => {
    const user = registerUser('Ident')
    const requestId = insertDueRequest(user)
    withTriggerDropped('trg_profile_deletion_requests_identity_immutable', () => {
      db.prepare(`UPDATE profile_deletion_requests SET profile_created_at_snapshot = '2000-01-01 00:00:00' WHERE request_id = ?;`).run(requestId)
    })
    const summary = await makeWorker(executor, 'w-ident', [requestId]).runOnce()
    assertEqual(summary.failed, 1, 'failed')
    const row = requestRow(requestId)
    assertEqual(row.last_error_code, 'identity_mismatch', 'код')
    assertEqual(row.next_attempt_at, null, 'без автоматичен опит')
    assert(profileExists(user.profileId), 'профилът е непокътнат')
  })

  console.log('\n[F] Файлове')

  await check('[F1] Срив след DB COMMIT, преди файловете: опашката оцелява; след рестарт файловете се изтриват и заявката завършва', async () => {
    const user = registerUser('AfterCommit')
    const name = webp()
    const path = await writeUpload(roots.avatars, name)
    db.prepare('UPDATE profiles SET avatar_url = ? WHERE profile_id = ?;').run(`/uploads/avatars/${name}`, user.profileId)
    const requestId = insertDueRequest(user)
    const claimed = executor.claimNextDueRequest('w-after', requestId)
    assert(claimed !== null, 'claim')
    if (claimed === null) return
    assertEqual(executor.runDatabasePhase(claimed, 'w-after').kind, 'db_deleted', 'DB фаза')
    // "Срив": нито файловете, нито finishRequest.
    assert(!profileExists(user.profileId) && existsSync(path), 'профилът е изтрит, файлът още е на диска')
    assertEqual(count(`SELECT COUNT(*) AS c FROM profile_deletion_file_queue WHERE request_id = ? AND status = 'pending';`, requestId), 1, 'файлът е в опашката')
    expireRequestLease(requestId)
    assertEqual((await makeWorker(executor2, 'w-after-2', [requestId]).runOnce()).completed, 1, 'довършване')
    assert(!existsSync(path), 'файлът е изтрит')
    assertEqual(count(`SELECT COUNT(*) AS c FROM profile_deletion_events WHERE request_id = ? AND event_type = 'db_deleted';`, requestId), 1, 'DB фазата не се повтаря')
  })

  await check('[F2] Срив по време на изтриването на файл (processing): след изтичане на lease-а файлът се обработва отново', async () => {
    const user = registerUser('MidFile')
    const name = webp()
    const path = await writeUpload(roots.avatars, name)
    db.prepare('UPDATE profiles SET avatar_url = ? WHERE profile_id = ?;').run(`/uploads/avatars/${name}`, user.profileId)
    const requestId = insertDueRequest(user)
    const claimed = executor.claimNextDueRequest('w-mid', requestId)
    if (claimed === null) throw new Error('claim')
    executor.runDatabasePhase(claimed, 'w-mid')
    const [file] = executor.listFilesToProcess(requestId)
    assert(executor.claimFile(file.queueId, 'w-mid'), 'claimFile')
    // "Срив" след claim на файла — unlink-ът дори е минал, отбелязването — не.
    await removeProfileDeletionFile(file.fileKind, file.storageRef, roots)
    assertEqual(executor2.claimFile(file.queueId, 'w-mid-2'), false, 'жив файлов lease не се отнема')
    db.prepare('UPDATE profile_deletion_file_queue SET lease_expires_at = ? WHERE queue_id = ?;').run(isoPlus(dbNow(), -1000), file.queueId)
    expireRequestLease(requestId)
    assertEqual((await makeWorker(executor2, 'w-mid-2', [requestId]).runOnce()).completed, 1, 'довършване')
    const fileRow = db.prepare('SELECT status, attempt_count FROM profile_deletion_file_queue WHERE queue_id = ?;').get(file.queueId) as Record<string, unknown>
    assertEqual(fileRow.status, 'done', 'файлът е done (липсващ = вече чисто)')
    assertEqual(fileRow.attempt_count, 2, 'два опита')
    assert(!existsSync(path), 'файлът липсва')
  })

  await check('[F3] Повторна обработка и липсващ файл: done без грешка; втори пуск на worker-а няма странични ефекти', async () => {
    const user = registerUser('Missing')
    db.prepare('UPDATE profiles SET avatar_url = ? WHERE profile_id = ?;').run(`/uploads/avatars/${webp()}`, user.profileId) // файлът никога не е съществувал
    const requestId = insertDueRequest(user)
    assertEqual((await makeWorker(executor, 'w-missing', [requestId]).runOnce()).completed, 1, 'completed')
    const eventsBefore = count('SELECT COUNT(*) AS c FROM profile_deletion_events WHERE request_id = ?;', requestId)
    const second = await makeWorker(executor, 'w-missing', [requestId]).runOnce()
    assertEqual(second.claimed, 0, 'завършена заявка не се взема отново')
    assertEqual(count('SELECT COUNT(*) AS c FROM profile_deletion_events WHERE request_id = ?;', requestId), eventsBefore, 'без нови събития')
    const detail = (db.prepare(`SELECT detail_json FROM profile_deletion_events WHERE request_id = ? AND event_type = 'file_deleted';`).get(requestId) as { detail_json: string }).detail_json
    assert(detail.includes('"outcome":"missing"'), detail)
  })

  await check('[F4] Споделен файл (същият аватар при друг профил) — skipped_shared, файлът остава', async () => {
    const user = registerUser('Shared')
    const other = registerUser('SharedOther')
    const name = webp()
    const path = await writeUpload(roots.avatars, name)
    db.prepare('UPDATE profiles SET avatar_url = ? WHERE profile_id IN (?, ?);').run(`/uploads/avatars/${name}`, user.profileId, other.profileId)
    const requestId = insertDueRequest(user)
    assertEqual((await makeWorker(executor, 'w-shared', [requestId]).runOnce()).completed, 1, 'completed')
    assert(existsSync(path), 'споделеният файл остава')
    assertEqual((db.prepare('SELECT status FROM profile_deletion_file_queue WHERE request_id = ?;').get(requestId) as { status: string }).status, 'skipped_shared', 'статус')
  })

  await check('[F5] Опасен път и неразрешена директория: отказ без докосване на файлове; заявката остава failed (ръчна проверка)', async () => {
    const outsideFile = await writeUpload(outsideRoot, 'secret.webp')
    const adFile = await writeUpload(join(uploadsRoot, 'ad-campaigns'), 'banner.webp')
    const refs = [
      '/uploads/avatars/..%2F..%2Foutside%2Fsecret.webp',
      '/uploads/avatars/%2e%2e',
      '/uploads/ad-campaigns/banner.webp',
      '/uploads/avatars/a/b.webp',
      '/uploads/profile-gallery/x/..%5Csecret.webp',
    ]
    for (const ref of refs) {
      assertEqual((await removeProfileDeletionFile('avatar', ref, roots)).outcome, 'rejected', `avatar ${ref}`)
    }
    assertEqual((await removeProfileDeletionFile('gallery_image', '/uploads/profile-gallery/x/..%5Csecret.webp', roots)).outcome, 'rejected', 'gallery backslash')
    assertEqual((await removeProfileDeletionFile('chat_attachment', '../outside/secret.webp', roots)).outcome, 'rejected', 'chat ref')
    // През worker-а: ред с опасен storage_ref в опашката на реална заявка.
    const user = registerUser('BadRef')
    const requestId = insertDueRequest(user)
    const claimed = executor.claimNextDueRequest('w-bad', requestId)
    if (claimed === null) throw new Error('claim')
    db.prepare(`INSERT INTO profile_deletion_file_queue (request_id, file_kind, storage_ref) VALUES (?, 'avatar', '/uploads/ad-campaigns/banner.webp');`).run(requestId)
    executor.runDatabasePhase(claimed, 'w-bad')
    await makeWorker(executor, 'w-bad', [requestId]).runOnce() // lease-ът още е на w-bad: продължава от файловете
    expireRequestLease(requestId)
    await makeWorker(executor, 'w-bad', [requestId]).runOnce()
    const fileRow = db.prepare(`SELECT status, last_error_code FROM profile_deletion_file_queue WHERE request_id = ? AND storage_ref LIKE '%ad-campaigns%';`).get(requestId) as Record<string, unknown>
    assertEqual(fileRow.status, 'failed', 'файлов статус')
    assertEqual(fileRow.last_error_code, 'invalid_storage_ref', 'код')
    const row = requestRow(requestId)
    assertEqual(row.status, 'failed', 'заявката не е completed')
    assertEqual(row.next_attempt_at, null, 'без автоматичен опит (постоянен отказ)')
    assert(existsSync(outsideFile) && existsSync(adFile), 'файловете извън разрешените директории са непокътнати')
  })

  await check('[F6] Символни връзки не се следват (файл и междинна директория/junction)', async () => {
    const outsideFile = await writeUpload(outsideRoot, 'linked.webp')
    const galleryProfile = randomUUID()
    await symlink(outsideRoot, join(roots.profileGallery, galleryProfile), 'junction')
    const viaDir = await removeProfileDeletionFile('gallery_image', `/uploads/profile-gallery/${galleryProfile}/linked.webp`, roots)
    assertEqual(viaDir.outcome === 'rejected' ? viaDir.code : viaDir.outcome, 'symlink_refused', 'междинна директория')
    let fileLinkTested = false
    const linkName = webp()
    try {
      await symlink(outsideFile, join(roots.avatars, linkName), 'file')
      fileLinkTested = true
    } catch {
      // Windows без право за symlink към файл — junction-ът по-горе покрива случая.
    }
    if (fileLinkTested) {
      const viaFile = await removeProfileDeletionFile('avatar', `/uploads/avatars/${linkName}`, roots)
      assertEqual(viaFile.outcome === 'rejected' ? viaFile.code : viaFile.outcome, 'symlink_refused', 'файлов symlink')
    }
    assert(existsSync(outsideFile), 'целта извън uploads е непокътната')
  })

  await check('[F7] completed е невъзможен при недовършена опашка или без db_deleted_at; няма връщане назад; опашката не се трие', () => {
    const user = registerUser('Guard')
    const requestId = insertDueRequest(user)
    const claimed = executor.claimNextDueRequest('w-guard', requestId)
    if (claimed === null) throw new Error('claim')
    const now = dbNow()
    assertRejects(
      () => db.prepare(`UPDATE profile_deletion_requests SET status = 'completed', completed_at = ?, lease_owner = NULL, lease_expires_at = NULL WHERE request_id = ?;`).run(now, requestId),
      'profile_deletion_completion_requires_db_deleted', 'completed без db_deleted_at')
    db.prepare(`INSERT INTO profile_deletion_file_queue (request_id, file_kind, storage_ref) VALUES (?, 'avatar', ?);`).run(requestId, `/uploads/avatars/${webp()}`)
    db.prepare('UPDATE profile_deletion_requests SET db_deleted_at = ? WHERE request_id = ?;').run(now, requestId)
    assertRejects(
      () => db.prepare(`UPDATE profile_deletion_requests SET status = 'completed', completed_at = ?, lease_owner = NULL, lease_expires_at = NULL WHERE request_id = ?;`).run(now, requestId),
      'profile_deletion_completion_files_pending', 'completed с чакащ файл')
    assertRejects(() => db.prepare('UPDATE profile_deletion_requests SET db_deleted_at = ? WHERE request_id = ?;').run(isoPlus(now, 1), requestId), 'profile_deletion_db_deleted_immutable', 'db_deleted_at е неизменим')
    assertRejects(
      () => db.prepare(`UPDATE profile_deletion_requests SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL WHERE request_id = ?;`).run(requestId),
      'profile_deletion_db_already_deleted', 'връщане към pending')
    assertRejects(
      () => db.prepare(`UPDATE profile_deletion_requests SET status = 'blocked', lease_owner = NULL, lease_expires_at = NULL WHERE request_id = ?;`).run(requestId),
      'profile_deletion_db_already_deleted', 'връщане към blocked')
    assertRejects(() => db.prepare('DELETE FROM profile_deletion_file_queue WHERE request_id = ?;').run(requestId), 'profile_deletion_file_queue_no_delete', 'триене от опашката')
    const user2 = registerUser('Guard2')
    const pendingId = insertRequestScheduledAt(user2, isoPlus(dbNow(), 60_000))
    assertRejects(() => db.prepare('UPDATE profile_deletion_requests SET db_deleted_at = ? WHERE request_id = ?;').run(dbNow(), pendingId), 'profile_deletion_db_deleted_requires_executing', 'db_deleted_at при pending')
    // Оставяме заявката в подредено състояние: файлът "done", после completed.
    const [file] = executor.listFilesToProcess(requestId)
    executor.claimFile(file.queueId, 'w-guard')
    executor.markFileDone(file, 'w-guard', user.profileId, 'missing')
    assertEqual(executor.finishRequest(requestId, 'w-guard').kind, 'completed', 'completed след done')
  })

  console.log('\n[R] Конкурентност при подаване и турнирни покани')

  await check('[R1] Подаването отказва ВЪТРЕ в транзакцията при персистиран Белот/Не се сърди човече/Свара и незавършен турнир', () => {
    for (const [label, setup] of [
      ['belot', (user: User) => insertBelotSnapshot(user.profileId)],
      ['ludo', (user: User) => insertLudoSnapshot(user.profileId)],
      ['svara', (user: User) => insertSvaraSnapshot(user.profileId)],
      ['tournament', (user: User) => insertOpenTournamentWithEntry(user)],
    ] as const) {
      const user = registerUser(`Busy${label}`)
      setup(user)
      const result = requestStore.createRequest({ profileId: user.profileId, accountId: user.accountId })
      assert(!result.ok && result.code === 'active_participation', `${label}: ${JSON.stringify(result)}`)
      assertEqual(count('SELECT COUNT(*) AS c FROM profile_deletion_requests WHERE profile_id = ?;', user.profileId), 0, `${label}: без заявка`)
    }
  })

  await check('[R2] Общ SQLite guard: при активна заявка ново турнирно участие се отказва; съществуващите участия и преходите им не се засягат', () => {
    const user = registerUser('TourGuard')
    const { tournamentId, entryId } = insertOpenTournamentWithEntry(registerUser('TourOther'))
    assert(requestStore.createRequest({ profileId: user.profileId, accountId: user.accountId }).ok, 'заявка')
    assertRejects(
      () => db.prepare(`INSERT INTO tournament_entries (entry_id, tournament_id, profile_id, joined_as, status) VALUES (?, ?, ?, 'solo', 'confirmed');`).run(randomUUID(), tournamentId, user.profileId),
      'profile_deletion_pending_tournament_admission', 'ново участие')
    db.prepare(`UPDATE tournament_entries SET status = 'finalist' WHERE entry_id = ?;`).run(entryId)
    assertEqual((db.prepare('SELECT status FROM tournament_entries WHERE entry_id = ?;').get(entryId) as { status: string }).status, 'finalist', 'обичайният преход на друг участник')
  })

  await check('[R3] Race с игра в паметта на друг процес: системна отмяна (само pending, журнал actor=system, токените се затварят)', () => {
    const user = registerUser('RaceGame')
    const created = requestStore.createRequest({ profileId: user.profileId, accountId: user.accountId })
    if (!created.ok) throw new Error('заявка')
    const issued = requestStore.issueRestoreToken(user.profileId)
    assert(issued.ok, 'токен')
    const cancelled = requestStore.cancelForActiveParticipation(created.request.requestId)
    assert(cancelled.ok, 'системна отмяна')
    assertEqual(requestRow(created.request.requestId).status, 'cancelled', 'статус')
    const event = db.prepare(`SELECT actor_kind, detail_json FROM profile_deletion_events WHERE request_id = ? AND event_type = 'cancelled';`).get(created.request.requestId) as Record<string, string>
    assertEqual(event.actor_kind, 'system', 'actor')
    assert(event.detail_json.includes('active_participation'), 'причина')
    assertEqual(requestStore.cancelForActiveParticipation(created.request.requestId).ok, false, 'идемпотентно')
    if (issued.ok) assertEqual(requestStore.cancelWithToken(issued.restoreToken).ok, false, 'токенът е затворен')
    const due = registerUser('RaceDue')
    const dueId = insertDueRequest(due)
    assertEqual(requestStore.cancelForActiveParticipation(dueId).ok, false, 'след срока — без отмяна')
  })

  await check('[R4] Worker-ът блокира и опитва отново при игра (snapshot или в паметта), турнир или чакаща покана; после изтрива', async () => {
    const cases: Array<[string, (user: User) => () => void]> = [
      ['active_game', (user) => { const roomId = insertBelotSnapshot(user.profileId); return () => db.prepare('UPDATE active_room_snapshots SET is_active = 0 WHERE room_id = ?;').run(roomId) }],
      ['active_game_local', (user) => { localGames.add(user.profileId); return () => localGames.delete(user.profileId) }],
      ['active_tournament', (user) => { const { tournamentId } = insertOpenTournamentWithEntry(user); return () => db.prepare(`UPDATE tournaments SET status = 'finished' WHERE tournament_id = ?;`).run(tournamentId) }],
      ['pending_tournament_invite', (user) => {
        const inviter = registerUser('Inviter')
        const tournamentId = randomUUID()
        const teamId = randomUUID()
        const inviteId = randomUUID()
        db.prepare(`INSERT INTO tournaments (tournament_id, name, entry_fee, start_mode, status) VALUES (?, 'Т', 100, 'fill', 'open');`).run(tournamentId)
        db.prepare(`INSERT INTO tournament_teams (team_id, tournament_id) VALUES (?, ?);`).run(teamId, tournamentId)
        db.prepare(`INSERT INTO tournament_partner_invites (invite_id, tournament_id, team_id, inviter_profile_id, invitee_profile_id, expires_at) VALUES (?, ?, ?, ?, ?, datetime('now', '+1 day'));`).run(inviteId, tournamentId, teamId, inviter.profileId, user.profileId)
        return () => db.prepare(`UPDATE tournament_partner_invites SET status = 'expired' WHERE invite_id = ?;`).run(inviteId)
      }],
    ]
    for (const [code, setup] of cases) {
      const user = registerUser(`Blk${code.length}`)
      const clear = setup(user)
      const requestId = insertDueRequest(user)
      const first = await makeWorker(executor, 'w-block', [requestId]).runOnce()
      assertEqual(first.blocked, 1, `${code}: blocked`)
      assertEqual(requestRow(requestId).last_error_code, code, `${code}: код`)
      assert(profileExists(user.profileId), `${code}: профилът е непокътнат`)
      clear()
      makeRetryDue(requestId)
      assertEqual((await makeWorker(executor, 'w-block', [requestId]).runOnce()).completed, 1, `${code}: изтриване след отпадане`)
    }
  })

  await check('[R5] Покани: при подаване поканата НЕ се отказва; не може да бъде приета през периода; след отмяна е отново валидна', () => {
    const invitee = registerUser('Invitee')
    const inviter = registerUser('InviterB')
    const tournamentId = randomUUID()
    const teamId = randomUUID()
    const inviteId = randomUUID()
    db.prepare(`INSERT INTO tournaments (tournament_id, name, entry_fee, start_mode, status) VALUES (?, 'Т', 100, 'fill', 'open');`).run(tournamentId)
    db.prepare(`INSERT INTO tournament_teams (team_id, tournament_id) VALUES (?, ?);`).run(teamId, tournamentId)
    db.prepare(`INSERT INTO tournament_partner_invites (invite_id, tournament_id, team_id, inviter_profile_id, invitee_profile_id, expires_at) VALUES (?, ?, ?, ?, ?, datetime('now', '+1 day'));`).run(inviteId, tournamentId, teamId, inviter.profileId, invitee.profileId)
    const created = requestStore.createRequest({ profileId: invitee.profileId, accountId: invitee.accountId })
    if (!created.ok) throw new Error(JSON.stringify(created))
    assertEqual((db.prepare('SELECT status FROM tournament_partner_invites WHERE invite_id = ?;').get(inviteId) as { status: string }).status, 'pending', 'поканата е pending')
    assertRejects(
      () => db.prepare(`INSERT INTO tournament_entries (entry_id, tournament_id, profile_id, team_id, joined_as, status) VALUES (?, ?, ?, ?, 'partner_invitee', 'confirmed');`).run(randomUUID(), tournamentId, invitee.profileId, teamId),
      'profile_deletion_pending_tournament_admission', 'приемане през периода')
    const issued = requestStore.issueRestoreToken(invitee.profileId)
    assert(issued.ok && requestStore.cancelWithToken(issued.restoreToken).ok, 'отмяна')
    assertEqual((db.prepare('SELECT status FROM tournament_partner_invites WHERE invite_id = ?;').get(inviteId) as { status: string }).status, 'pending', 'поканата е още валидна')
    db.prepare(`INSERT INTO tournament_entries (entry_id, tournament_id, profile_id, team_id, joined_as, status) VALUES (?, ?, ?, ?, 'partner_invitee', 'confirmed');`).run(randomUUID(), tournamentId, invitee.profileId, teamId)
    assertEqual(count(`SELECT COUNT(*) AS c FROM tournament_entries WHERE tournament_id = ? AND profile_id = ?;`, tournamentId, invitee.profileId), 1, 'участие след отмяна')
  })

  await check('[R6] Турнирни пътища при активна заявка (заявката е записана от друга връзка/процес): solo, повторно записване, приемане и създаване на покана -> profile_deletion_pending без грешка; нищо не е записано/таксувано; след отмяна — нормално', () => {
    const fund = (profileId: string) => db.prepare(`
      INSERT INTO profile_wallets (profile_id, yellow_coins_balance) VALUES (?, 1000000)
      ON CONFLICT(profile_id) DO UPDATE SET yellow_coins_balance = 1000000;`).run(profileId)
    const balance = (profileId: string) => (db.prepare('SELECT yellow_coins_balance AS b FROM profile_wallets WHERE profile_id = ?;').get(profileId) as { b: number }).b
    // Отделен създател за всеки турнир (лимит на активните турнири на създател).
    const newTournament = (name: string) => {
      const creator = registerUser('P6Creator')
      const created = tournamentStore.createTournament({ name, creatorProfileId: creator.profileId, visibility: 'public', entryFee: 100, startMode: 'fill', playerCapacity: 8 })
      if (!created.ok) throw new Error(`турнир: ${created.reason}`)
      return created.tournament.tournamentId
    }
    const submit = (user: User) => {
      const created = requestStore.createRequest({ profileId: user.profileId, accountId: user.accountId })
      if (!created.ok) throw new Error(`заявка: ${JSON.stringify(created)}`)
    }
    const entryCount = (tournamentId: string, profileId: string, status = 'confirmed') =>
      count(`SELECT COUNT(*) AS c FROM tournament_entries WHERE tournament_id = ? AND profile_id = ? AND status = ?;`, tournamentId, profileId, status)
    const befriend = (a: User, b: User) => {
      const [lower, higher] = [a.profileId, b.profileId].sort()
      db.prepare(`INSERT INTO profile_friendships (friendship_id, requester_profile_id, addressee_profile_id, lower_profile_id, higher_profile_id, status) VALUES (?, ?, ?, ?, ?, 'accepted');`)
        .run(randomUUID(), a.profileId, b.profileId, lower, higher)
    }

    // a) Самостоятелно записване.
    const solo = registerUser('P6Solo')
    fund(solo.profileId)
    const soloTournament = newTournament('P6 solo')
    submit(solo)
    const soloResult = tournamentEconomy.joinTournamentSoloAtomically(soloTournament, solo.profileId)
    assert(!soloResult.ok && soloResult.reason === 'profile_deletion_pending', `solo: ${JSON.stringify(soloResult)}`)
    assertEqual(entryCount(soloTournament, solo.profileId), 0, 'solo: без участие')
    assertEqual(balance(solo.profileId), 1000000, 'solo: без таксуване')
    assertEqual(count(`SELECT COUNT(*) AS c FROM tournament_economy_ledger WHERE profile_id = ?;`, solo.profileId), 0, 'solo: без ledger ред')

    // b) Повторно записване (refunded -> confirmed през UPDATE).
    const rejoin = registerUser('P6Rejoin')
    fund(rejoin.profileId)
    const rejoinTournament = newTournament('P6 rejoin')
    const firstJoin = tournamentEconomy.joinTournamentSoloAtomically(rejoinTournament, rejoin.profileId)
    assert(firstJoin.ok, `първо записване: ${JSON.stringify(firstJoin)}`)
    db.prepare(`UPDATE tournament_entries SET status = 'refunded', refunded_at = CURRENT_TIMESTAMP WHERE tournament_id = ? AND profile_id = ?;`).run(rejoinTournament, rejoin.profileId)
    const balanceBeforeRejoin = balance(rejoin.profileId)
    submit(rejoin)
    const rejoinResult = tournamentEconomy.joinTournamentSoloAtomically(rejoinTournament, rejoin.profileId)
    assert(!rejoinResult.ok && rejoinResult.reason === 'profile_deletion_pending', `повторно: ${JSON.stringify(rejoinResult)}`)
    assertEqual(entryCount(rejoinTournament, rejoin.profileId, 'refunded'), 1, 'повторно: участието остава refunded')
    assertEqual(balance(rejoin.profileId), balanceBeforeRejoin, 'повторно: без таксуване')

    // c) Приемане на покана от поканения с активна заявка.
    const inviter = registerUser('P6Inviter')
    const invitee = registerUser('P6Invitee')
    fund(inviter.profileId)
    fund(invitee.profileId)
    befriend(inviter, invitee)
    const inviteTournament = newTournament('P6 accept')
    const invite = tournamentEconomy.createPartnerInviteAtomically(inviteTournament, inviter.profileId, invitee.profileId)
    if (!invite.ok) throw new Error(`покана: ${JSON.stringify(invite)}`)
    submit(invitee)
    const acceptResult = tournamentEconomy.acceptPartnerInviteAtomically(inviteTournament, invite.invite.inviteId, invitee.profileId)
    assert(!acceptResult.ok && acceptResult.reason === 'profile_deletion_pending', `приемане: ${JSON.stringify(acceptResult)}`)
    assertEqual(entryCount(inviteTournament, invitee.profileId), 0, 'приемане: без участие')
    assertEqual(balance(invitee.profileId), 1000000, 'приемане: без таксуване')
    assertEqual((db.prepare('SELECT status FROM tournament_partner_invites WHERE invite_id = ?;').get(invite.invite.inviteId) as { status: string }).status, 'pending', 'приемане: поканата остава pending')

    // d) Създаване на покана от поканил с активна заявка (участието му се създава при поканата).
    const pendingInviter = registerUser('P6PendInviter')
    const friend = registerUser('P6Friend')
    fund(pendingInviter.profileId)
    befriend(pendingInviter, friend)
    const createTournament = newTournament('P6 create')
    submit(pendingInviter)
    const createResult = tournamentEconomy.createPartnerInviteAtomically(createTournament, pendingInviter.profileId, friend.profileId)
    assert(!createResult.ok && createResult.reason === 'profile_deletion_pending', `създаване: ${JSON.stringify(createResult)}`)
    assertEqual(entryCount(createTournament, pendingInviter.profileId), 0, 'създаване: без участие')
    assertEqual(count(`SELECT COUNT(*) AS c FROM tournament_partner_invites WHERE tournament_id = ?;`, createTournament), 0, 'създаване: без покана')
    assertEqual(balance(pendingInviter.profileId), 1000000, 'създаване: без таксуване')

    // e) След отмяна guard-ът не пречи — самостоятелното записване минава.
    const issued = requestStore.issueRestoreToken(solo.profileId)
    assert(issued.ok && requestStore.cancelWithToken(issued.restoreToken).ok, 'отмяна')
    const afterCancel = tournamentEconomy.joinTournamentSoloAtomically(soloTournament, solo.profileId)
    assert(afterCancel.ok, `след отмяна: ${JSON.stringify(afterCancel)}`)
    assertEqual(entryCount(soloTournament, solo.profileId), 1, 'след отмяна: участие')
  })

  console.log('\n[L] Регистър и процедурата след restore')

  await check('[L1] Флагът на worker-а е изключен по подразбиране и независим от флага за подаване', () => {
    const saved = { a: process.env.PROFILE_SELF_DELETION_WORKER_ENABLED, b: process.env.PROFILE_SELF_DELETION_ENABLED }
    try {
      delete process.env.PROFILE_SELF_DELETION_WORKER_ENABLED
      process.env.PROFILE_SELF_DELETION_ENABLED = '1'
      assertEqual(isProfileSelfDeletionWorkerEnabled(), false, 'без env')
      for (const value of ['true', '0', 'yes', ' 1']) {
        process.env.PROFILE_SELF_DELETION_WORKER_ENABLED = value
        assertEqual(isProfileSelfDeletionWorkerEnabled(), false, `"${value}"`)
      }
      process.env.PROFILE_SELF_DELETION_WORKER_ENABLED = '1'
      delete process.env.PROFILE_SELF_DELETION_ENABLED
      assertEqual(isProfileSelfDeletionWorkerEnabled(), true, 'само при точно "1"')
    } finally {
      if (saved.a === undefined) delete process.env.PROFILE_SELF_DELETION_WORKER_ENABLED
      else process.env.PROFILE_SELF_DELETION_WORKER_ENABLED = saved.a
      if (saved.b === undefined) delete process.env.PROFILE_SELF_DELETION_ENABLED
      else process.env.PROFILE_SELF_DELETION_ENABLED = saved.b
    }
  })

  await check('[L2] Регистърът: запис ПРЕДИ изтриването, само псевдонимни идентификатори (без имейл/име)', () => {
    const ledger = readProfileDeletionLedger(ledgerPath)
    const entry = ledger.entries.find((candidate) => candidate.requestId === targetRequestId)
    assert(entry !== undefined, 'записът за target')
    assertEqual(ledger.invalidLineCount, 0, 'невалидни редове')
    if (entry === undefined) return
    assertEqual(entry.profileId, target.profileId, 'profileId')
    assertEqual(entry.accountIdSnapshot, target.accountId, 'accountId')
    const raw = readFileSync(ledgerPath, 'utf8')
    for (const forbidden of [target.email, target.displayName]) assert(!raw.includes(forbidden), 'лични данни в регистъра')
    assertEqual(Object.keys(entry).sort().join(','), 'accountIdSnapshot,profileCreatedAtSnapshot,profileId,recordedAt,requestId,requestedAt,scheduledFor,v', 'полета')
  })

  // Restore сценарий: backup-ите са направени, когато профилите още са съществували.
  const restoreA = registerUser('RestoreA') // заявката е в backup-а (pending с изтекъл срок)
  const restoreB = registerUser('RestoreB') // backup-ът е по-стар от заявката
  const restoreC = registerUser('RestoreC') // друг профил със същия profile_id не трябва да съществува — mismatch тест
  const restoreAvatar = webp()
  db.prepare('UPDATE profiles SET avatar_url = ? WHERE profile_id = ?;').run(`/uploads/avatars/${restoreAvatar}`, restoreB.profileId)
  const backupDir = await mkdtemp(join(tmpdir(), 'belot-profile-deletion-restore-'))
  const backupBeforeRequests = join(backupDir, 'before.sqlite')
  db.exec(`VACUUM INTO '${backupBeforeRequests.replace(/'/g, "''")}';`)
  const requestA = insertDueRequest(restoreA)
  const backupWithRequestA = join(backupDir, 'with-a.sqlite')
  db.exec(`VACUUM INTO '${backupWithRequestA.replace(/'/g, "''")}';`)
  const requestB = insertDueRequest(restoreB)
  const requestC = insertDueRequest(restoreC)
  await makeWorker(executor, 'w-restore', [requestA, requestB, requestC]).runOnce()
  const restoredUploads = join(backupDir, 'uploads')
  await mkdir(join(restoredUploads, 'avatars'), { recursive: true })
  const restoredAvatarPath = join(restoredUploads, 'avatars', restoreAvatar)
  await writeFile(restoredAvatarPath, 'image-bytes')

  function runReconcile(args: string[]): { status: number | null; stdout: string } {
    const tsxCli = join(sourceServerRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
    const result = spawnSync(process.execPath, [tsxCli, join(sourceServerRoot, 'scripts', 'reconcileProfileDeletionLedger.ts'), ...args], { encoding: 'utf8', cwd: sourceServerRoot })
    return { status: result.status, stdout: `${result.stdout}${result.stderr}` }
  }

  await check('[L3] След restore: само отчет по подразбиране — открива "възкресените" профили и не променя нищо', () => {
    for (const [backup, expectA, expectB] of [
      [backupWithRequestA, 'request_present', 'request_missing'],
      [backupBeforeRequests, 'request_missing', 'request_missing'],
    ] as const) {
      const result = runReconcile([`--db=${backup}`, `--ledger=${ledgerPath}`])
      assertEqual(result.status, 0, `exit (${result.stdout.slice(-300)})`)
      assert(result.stdout.includes(`${expectA} requestId=${requestA}`), `A: ${expectA}`)
      assert(result.stdout.includes(`${expectB} requestId=${requestB}`), `B: ${expectB}`)
      assert(result.stdout.includes('report-only'), 'режим')
      const restored = new sqliteModule.DatabaseSync(backup, { readOnly: true })
      assertEqual(Number((restored.prepare('SELECT COUNT(*) AS c FROM profiles WHERE profile_id IN (?, ?);').get(restoreA.profileId, restoreB.profileId) as { c: number }).c), 2, 'нищо не е изтрито')
      restored.close()
      for (const forbidden of [restoreA.email, restoreA.displayName]) assert(!result.stdout.includes(forbidden), 'лични данни в изхода')
    }
  })

  await check('[L4] --apply без изричното потвърждение се отказва (exit 2)', () => {
    const result = runReconcile([`--db=${backupWithRequestA}`, `--ledger=${ledgerPath}`, '--apply', `--uploads-root=${restoredUploads}`])
    assertEqual(result.status, 2, 'exit')
    const restored = new sqliteModule.DatabaseSync(backupWithRequestA, { readOnly: true })
    assertEqual(Number((restored.prepare('SELECT COUNT(*) AS c FROM profiles WHERE profile_id = ?;').get(restoreA.profileId) as { c: number }).c), 1, 'нищо не е изтрито')
    restored.close()
  })

  await check('[L5] --apply с потвърждение: повторно прилага изтриванията във възстановената база и файлове; несъвпадаща идентичност не се пипа', () => {
    const tamper = new sqliteModule.DatabaseSync(backupWithRequestA, { open: true })
    tamper.prepare(`UPDATE profiles SET created_at = '2001-01-01 00:00:00' WHERE profile_id = ?;`).run(restoreC.profileId)
    tamper.close()
    const result = runReconcile([`--db=${backupWithRequestA}`, `--ledger=${ledgerPath}`, '--apply', '--confirm=REAPPLY-PROFILE-DELETIONS', `--uploads-root=${restoredUploads}`])
    assertEqual(result.status, 1, `exit 1 заради identity_mismatch (${result.stdout.slice(-400)})`)
    assert(result.stdout.includes(`identity_mismatch requestId=${requestC}`), 'C е identity_mismatch')
    const restored = new sqliteModule.DatabaseSync(backupWithRequestA, { readOnly: true })
    const remaining = (restored.prepare('SELECT profile_id FROM profiles WHERE profile_id IN (?, ?, ?);').all(restoreA.profileId, restoreB.profileId, restoreC.profileId) as Array<{ profile_id: string }>).map((row) => row.profile_id)
    assertEqual(remaining.join(','), restoreC.profileId, 'A и B са изтрити, C остава')
    assertEqual((restored.prepare('SELECT status FROM profile_deletion_requests WHERE request_id = ?;').get(requestA) as { status: string }).status, 'completed', 'A: заявката е completed')
    assertEqual((restored.prepare('PRAGMA foreign_key_check;').all() as unknown[]).length, 0, 'foreign_key_check')
    restored.close()
    assert(!existsSync(restoredAvatarPath), 'файлът на B във възстановените uploads е изтрит')
  })
  await rm(backupDir, { recursive: true, force: true }).catch(() => {})
} catch (error) {
  failed += 1
  console.error(`  FAIL  неочаквана грешка: ${error instanceof Error ? error.stack : String(error)}`)
}

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)
process.exitCode = failed > 0 ? 1 : 0
