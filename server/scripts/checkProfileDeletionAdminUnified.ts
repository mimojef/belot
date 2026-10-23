/**
 * checkProfileDeletionAdminUnified.ts
 *
 * Самоизтриване на профили — Етап 4F2: административното окончателно
 * изтриване използва СЪЩОТО ядро (profileDeletionExecutor.
 * deleteProfileDataInTransaction) и СЪЩАТА надеждна файлова опашка като
 * самоизтриването. САМО временни бази и временни upload директории.
 *
 * [A] Данни (Теми А1/Б1, разговори, поддръжка, история, кампании, оценки,
 *     модерация, IP/visitor, чужди данни).
 * [F] Файлова фаза (неуспех, повторен опит, срив преди/след COMMIT, тригери).
 * [R] Restore (стар backup, backup между COMMIT и файловете, повторение).
 * [C] Координатор, активен бан, паралелно самоизтриване, вход (§10).
 */

import { createHash, randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'
import { createPlayerProgressStore } from '../src/db/playerProgressStore.js'
import { createAuthStore } from '../src/db/authStore.js'
import { createPendingProfileModerationStore } from '../src/db/pendingProfileModerationStore.js'
import { createProfileHardDeleteService } from '../src/db/profileHardDeleteService.js'
import { createProfileDeletionExecutor, PROFILE_DELETION_DELETED_LABEL, PROFILE_DELETION_MAX_FILE_ATTEMPTS } from '../src/db/profileDeletionExecutor.js'
import { createLudoEconomyStore } from '../src/db/ludoEconomyStore.js'
import { PROFILE_DELETION_GRACE_PERIOD_MS } from '../src/db/profileDeletionSchedule.js'
import {
  getProfileDeletionLedgerOffsiteAckPath,
  readProfileDeletionLedger,
  writeProfileDeletionLedgerOffsiteAck,
} from '../src/db/profileDeletionLedger.js'
import { createAdminProfileDeletionCoordinator } from '../src/core/adminProfileDeletionCoordinator.js'
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

const sourceServerRoot = resolve(
  process.argv.slice(2).find((arg) => arg.startsWith('--server-root='))?.slice('--server-root='.length) ?? process.cwd(),
)
const SECRET = 'profile-deletion-admin-unified-secret-0123456789'
const PASSWORD = 'secret123'

console.log('\ncheckProfileDeletionAdminUnified')
console.log(`Server root: ${sourceServerRoot}`)

const tempRoots: string[] = []
const root = await mkdtemp(join(tmpdir(), 'belot-profile-deletion-admin-unified-'))
tempRoots.push(root)
await mkdir(join(root, 'database', 'migrations'), { recursive: true })
await mkdir(join(root, 'database', 'data'), { recursive: true })
for (const entry of await readdir(join(sourceServerRoot, 'database', 'migrations'), { withFileTypes: true })) {
  if (entry.isFile() && extname(entry.name).toLowerCase() === '.sql') {
    await cp(join(sourceServerRoot, 'database', 'migrations', entry.name), join(root, 'database', 'migrations', entry.name))
  }
}
const { databaseFilePath } = await ensureServerDatabaseReady({ serverRootOverride: root })

function makeRoots(base: string): ProfileDeletionUploadRoots {
  return {
    avatars: join(base, 'avatars'),
    profileGallery: join(base, 'profile-gallery'),
    chatAttachments: join(base, 'chat-attachments'),
    topicAttachments: join(base, 'topic-attachments'),
    topicMuteEvidenceAttachments: join(base, 'topic-mute-evidence-attachments'),
    supportAttachments: join(base, 'support-attachments'),
  }
}
const uploadsRoot = join(root, 'uploads')
const roots = makeRoots(uploadsRoot)
for (const dir of Object.values(roots)) await mkdir(dir, { recursive: true })
const ledgerPath = join(root, 'deletion-ledger', 'profile-deletions.jsonl')

const sqliteModule = await import('node:sqlite')
const db: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, { open: true, enableForeignKeyConstraints: true })
db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')

const progressStore = await createPlayerProgressStore(databaseFilePath)
const pendingStore = await createPendingProfileModerationStore(databaseFilePath)
const authStore = await createAuthStore(databaseFilePath, progressStore, {
  registrationVerificationCodeSecret: SECRET,
  getRegistrationVerificationMode: () => 'direct',
  getActiveBanForProfile: () => null,
  isProfileScheduledForAdminDeletion: (profileId) => pendingStore.listPendingDeletes().some((pending) => pending.targetProfileId === profileId),
})
const ludoEconomy = await createLudoEconomyStore(databaseFilePath)
const hardDelete = await createProfileHardDeleteService(databaseFilePath, { uploadRoots: roots })
const selfExecutor = await createProfileDeletionExecutor(databaseFilePath)

type User = { profileId: string; accountId: string; email: string; displayName: string }
let counter = 0
function registerUser(label: string, coins = 0): User {
  counter += 1
  const email = `adm-${label.toLowerCase()}-${counter}@example.test`
  const displayName = `Adm${label}${counter}`
  const result = authStore.register({ email, password: PASSWORD, displayName, gender: 'male', visitorId: randomUUID() })
  if (!result.ok || result.mode !== 'direct') throw new Error(`регистрация: ${JSON.stringify(result)}`)
  const profileId = result.session.profile.profileId as string
  if (coins > 0) {
    db.prepare(`INSERT INTO profile_wallets (profile_id, yellow_coins_balance) VALUES (?, ?) ON CONFLICT(profile_id) DO UPDATE SET yellow_coins_balance = excluded.yellow_coins_balance;`).run(profileId, coins)
  }
  return { profileId, accountId: result.session.account.accountId, email, displayName }
}

const admin = registerUser('Admin')
db.prepare(`UPDATE accounts SET role = 'admin' WHERE account_id = ?;`).run(admin.accountId)

const count = (sql: string, ...params: Array<string | number>) => Number((db.prepare(sql).get(...params) as { c: number }).c)
const webp = () => `${randomUUID()}.webp`
async function writeUpload(dir: string, ...segments: string[]): Promise<string> {
  const path = join(dir, ...segments)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, 'image-bytes')
  return path
}

function befriend(a: User, b: User): string {
  const friendshipId = randomUUID()
  const [lower, higher] = a.profileId < b.profileId ? [a.profileId, b.profileId] : [b.profileId, a.profileId]
  db.prepare(`INSERT INTO profile_friendships (friendship_id, requester_profile_id, addressee_profile_id, lower_profile_id, higher_profile_id, status, kind) VALUES (?, ?, ?, ?, ?, 'accepted', 'friend');`)
    .run(friendshipId, a.profileId, b.profileId, lower, higher)
  return friendshipId
}

async function chatMessage(friendshipId: string, sender: User): Promise<string> {
  const messageId = randomUUID()
  const filename = webp()
  db.prepare(`INSERT INTO friend_chat_messages (message_id, friendship_id, sender_profile_id, body) VALUES (?, ?, ?, 'здрасти');`).run(messageId, friendshipId, sender.profileId)
  db.prepare(`INSERT INTO friend_chat_attachments (message_id, storage_filename, width, height, byte_size) VALUES (?, ?, 1, 1, 11);`).run(messageId, filename)
  db.prepare(`INSERT OR REPLACE INTO chat_conversation_reads (profile_id, friendship_id, last_read_at) VALUES (?, ?, CURRENT_TIMESTAMP);`).run(sender.profileId, friendshipId)
  return writeUpload(roots.chatAttachments, filename)
}

function createTopic(creator: User): string {
  const topicId = randomUUID()
  db.prepare(`INSERT INTO topics (topic_id, slug, title, created_by_profile_id, created_by_role) VALUES (?, ?, 'Тема', ?, 'player');`).run(topicId, `t-${topicId}`, creator.profileId)
  return topicId
}

function topicMessage(topicId: string, sender: User, parent: string | null): string {
  const messageId = randomUUID()
  db.prepare(`INSERT INTO topic_messages (message_id, topic_id, parent_message_id, sender_profile_id, sender_display_name, sender_role, body) VALUES (?, ?, ?, ?, ?, 'player', 'текст');`)
    .run(messageId, topicId, parent, sender.profileId, sender.displayName)
  return messageId
}

async function topicAttachment(messageId: string): Promise<string> {
  const filename = webp()
  db.prepare(`INSERT INTO topic_message_attachments (message_id, storage_filename, width, height, byte_size) VALUES (?, ?, 1, 1, 11);`).run(messageId, filename)
  return writeUpload(roots.topicAttachments, filename)
}

async function supportMessage(user: User, fromAdmin: boolean): Promise<{ messageId: string; filePath: string }> {
  const messageId = randomUUID()
  const filename = webp()
  db.prepare(`INSERT INTO support_messages (message_id, profile_id, body, is_from_admin) VALUES (?, ?, 'съобщение', ?);`).run(messageId, user.profileId, fromAdmin ? 1 : 0)
  db.prepare(`INSERT INTO support_message_attachments (message_id, storage_filename, width, height, byte_size) VALUES (?, ?, 1, 1, 11);`).run(messageId, filename)
  return { messageId, filePath: await writeUpload(roots.supportAttachments, filename) }
}

function ackLedger(path: string): void {
  const buffer = readFileSync(path)
  const lines = buffer.toString('utf8').split('\n').filter((line) => line.trim().length > 0).length
  writeProfileDeletionLedgerOffsiteAck(getProfileDeletionLedgerOffsiteAckPath(path), {
    v: 1, bytes: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex'),
    lineCount: lines, entryCount: lines, remotePath: 'test:ledger', confirmedAt: new Date().toISOString(),
  })
}

/** Всички текстови стойности, съдържащи needle (за остатъчни идентификатори). */
function findOccurrences(needle: string): string[] {
  const hits: string[] = []
  for (const { name: table } of db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%';`).all() as Array<{ name: string }>) {
    for (const { name: column } of db.prepare(`SELECT name FROM pragma_table_info(?);`).all(table) as Array<{ name: string }>) {
      if (Number((db.prepare(`SELECT COUNT(*) AS c FROM "${table}" WHERE instr(CAST("${column}" AS TEXT), ?) > 0;`).get(needle) as { c: number }).c) > 0) hits.push(`${table}.${column}`)
    }
  }
  return hits
}

// Административният одит (одитният ред, support архивът при заявка,
// модераторският snapshot), служебната файлова опашка (URL на галерията
// съдържа ID-то — както при самоизтриването) и snapshot колоните на
// финансовите регистри са единствените допустими следи от изтрития профил.
const ALLOWED_RESIDUE = (hit: string): boolean => {
  const [table, column] = hit.split('.')
  return ['admin_profile_deletions', 'support_deletion_archives', 'admin_profile_deletion_moderation_snapshots', 'profile_deletion_file_queue'].includes(table) ||
    /^deleted_.*_snapshot$/.test(column)
}

try {
  console.log('\n[A] Данни при административно изтриване')

  const target = registerUser('Target', 3000)
  const friend = registerUser('Friend', 3000)
  const strangerA = registerUser('StrA', 3000)
  const strangerB = registerUser('StrB', 3000)

  // Аватар + галерия.
  const avatarName = webp()
  const avatarPath = await writeUpload(roots.avatars, avatarName)
  db.prepare('UPDATE profiles SET avatar_url = ? WHERE profile_id = ?;').run(`/uploads/avatars/${avatarName}`, target.profileId)
  const galleryName = webp()
  const galleryPath = await writeUpload(roots.profileGallery, target.profileId, galleryName)
  db.prepare(`INSERT INTO profile_gallery_images (image_id, profile_id, image_url, thumbnail_url) VALUES (?, ?, ?, ?);`)
    .run(randomUUID(), target.profileId, `/uploads/profile-gallery/${target.profileId}/${galleryName}`, `/uploads/profile-gallery/${target.profileId}/${galleryName}`)

  // Лични разговори: target<->friend (двете страни), несвързан strangerA<->strangerB.
  const targetFriendship = befriend(target, friend)
  const chatByTarget = await chatMessage(targetFriendship, target)
  const chatByFriend = await chatMessage(targetFriendship, friend)
  const unrelatedFriendship = befriend(strangerA, strangerB)
  const unrelatedChat = await chatMessage(unrelatedFriendship, strangerA)

  // Поддръжка: разговор на target (негово съобщение + отговор на екипа) и чужд разговор.
  const supportByTarget = await supportMessage(target, false)
  const supportReply = await supportMessage(target, true)
  db.prepare(`INSERT OR IGNORE INTO support_archived (profile_id) VALUES (?);`).run(target.profileId)
  const foreignSupport = await supportMessage(strangerA, false)

  // Теми: Б1 — собствена тема с чужд отговор (+файл); А1 — съобщение в чужда тема с чужд отговор.
  const ownTopic = createTopic(target)
  const ownRoot = topicMessage(ownTopic, target, null)
  const foreignReplyInOwnTopic = topicMessage(ownTopic, strangerA, ownRoot)
  const foreignFileInOwnTopic = await topicAttachment(foreignReplyInOwnTopic)
  const foreignTopic = createTopic(strangerB)
  const targetRootInForeign = topicMessage(foreignTopic, target, null)
  const foreignReplyToTarget = topicMessage(foreignTopic, strangerA, targetRootInForeign)
  const targetFileInForeign = await topicAttachment(targetRootInForeign)

  // История: частен Белот, Ludo (target печели), смяна на име, кампаниен архив.
  const privateRoom = randomUUID()
  const occupant = (user: User) => ({ profileId: user.profileId, displayName: user.displayName, avatarUrl: null, isBot: false })
  db.prepare(`INSERT INTO private_room_matches (room_id, private_room_id, status, stake, team_a_json, team_b_json, team_a_score, team_b_score, finished_at) VALUES (?, 'p', 'finished', 100, ?, ?, 151, 90, CURRENT_TIMESTAMP);`)
    .run(privateRoom, JSON.stringify([occupant(target), occupant(friend)]), JSON.stringify([occupant(strangerA), occupant(strangerB)]))
  const ludoMatch = randomUUID()
  assert(ludoEconomy.collectLudoMatchStakes(ludoMatch, [target.profileId, friend.profileId], 100).ok, 'ludo stake')
  assert(ludoEconomy.payoutLudoMatchWinner(ludoMatch, target.profileId).ok, 'ludo payout')
  db.prepare(`INSERT INTO ludo_room_matches (match_id, ludo_room_id, status, stake, player_count, players_json, winner_profile_id, finished_at) VALUES (?, 'r', 'finished', 100, 2, ?, ?, CURRENT_TIMESTAMP);`)
    .run(ludoMatch, JSON.stringify([{ profileId: target.profileId, displayName: target.displayName, avatarUrl: null, color: 'red' }, { profileId: friend.profileId, displayName: friend.displayName, avatarUrl: null, color: 'blue' }]), target.profileId)
  const nameChangeId = randomUUID()
  db.prepare(`INSERT INTO profile_name_change_ledger (change_id, profile_id, old_display_name, new_display_name, price_amount, balance_after) VALUES (?, ?, 'СтароИме', ?, 500, 2500);`).run(nameChangeId, target.profileId, target.displayName)
  const campaignId = randomUUID()
  db.prepare(`INSERT INTO campaigns (campaign_id, name, status, starts_at, ends_at, unit_name_singular, unit_name_plural) VALUES (?, 'К', 'finished', '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z', 'т', 'т');`).run(campaignId)
  db.prepare(`INSERT INTO campaign_archive_top10 (campaign_id, rank, profile_id, display_name_at_archive, units_total, rank_title_at_archive) VALUES (?, 1, ?, ?, 99, 'Шампион');`).run(campaignId, target.profileId, target.displayName)
  db.prepare(`INSERT INTO campaign_archive_top10 (campaign_id, rank, profile_id, display_name_at_archive, units_total) VALUES (?, 2, ?, ?, 50);`).run(campaignId, friend.profileId, friend.displayName)

  // Оценки: target оценява friend (дадена), strangerA оценява target (получена).
  db.prepare(`INSERT INTO profile_partner_ratings (rating_id, room_id, rated_profile_id, rated_by_profile_id, rating_value) VALUES (?, 'room-1', ?, ?, 2);`).run(randomUUID(), friend.profileId, target.profileId)
  db.prepare(`INSERT INTO profile_partner_ratings (rating_id, room_id, rated_profile_id, rated_by_profile_id, rating_value) VALUES (?, 'room-1', ?, ?, 6);`).run(randomUUID(), friend.profileId, strangerB.profileId)
  db.prepare(`INSERT INTO profile_partner_ratings (rating_id, room_id, rated_profile_id, rated_by_profile_id, rating_value) VALUES (?, 'room-2', ?, ?, 5);`).run(randomUUID(), target.profileId, strangerA.profileId)

  // Модерация: неразгледан сигнал на target за чуждо съдържание; блокировка, наложена от target; доказателство за заглушаване на target.
  const pendingReportId = randomUUID()
  db.prepare(`INSERT INTO topic_reports (report_id, topic_id, reporter_profile_id, reason) VALUES (?, ?, ?, 'спам');`).run(pendingReportId, foreignTopic, target.profileId)
  const tournamentId = randomUUID()
  db.prepare(`INSERT INTO tournaments (tournament_id, name, entry_fee, start_mode, status) VALUES (?, 'Т', 100, 'fill', 'finished');`).run(tournamentId)
  const blockId = randomUUID()
  db.prepare(`INSERT INTO tournament_participation_blocks (block_id, tournament_id, blocked_profile_id, actor_profile_id, actor_role, reason) VALUES (?, ?, ?, ?, 'player', 'грубост');`).run(blockId, tournamentId, strangerB.profileId, target.profileId)
  const evidenceName = webp()
  const evidencePath = await writeUpload(roots.topicMuteEvidenceAttachments, evidenceName)
  db.prepare(`INSERT INTO topic_mute_evidence (mute_history_id, mute_audit_log_id, profile_id, source_topic_id, source_kind, muted_by_role, duration_ms, muted_until, source_attachment_storage_filename, source_attachment_is_evidence_copy) VALUES (?, ?, ?, ?, 'topic_reply', 'admin', 60000, datetime('now', '+1 day'), ?, 1);`)
    .run(randomUUID(), randomUUID(), target.profileId, foreignTopic, evidenceName)

  // IP/visitor: общ IP със strangerA.
  for (const [user, ip, visitor] of [[target, '198.51.100.9', 'v-target'], [target, '203.0.113.5', 'v-shared'], [strangerA, '203.0.113.5', 'v-shared']] as const) {
    db.prepare(`INSERT OR IGNORE INTO profile_ip_links (profile_id, ip_address, first_seen_at, last_seen_at, event_count) VALUES (?, ?, '2026-01-01 00:00:00', '2026-01-02 00:00:00', 1);`).run(user.profileId, ip)
    db.prepare(`INSERT OR IGNORE INTO profile_visitor_links (profile_id, anonymous_visitor_id, first_seen_at, last_seen_at, event_count) VALUES (?, ?, '2026-01-01 00:00:00', '2026-01-02 00:00:00', 1);`).run(user.profileId, visitor)
  }

  // Активен бан на target — административното изтриване НЕ се спира от него.
  db.prepare(`INSERT INTO profile_bans (ban_id, profile_id, banned_until, reason, banned_by_profile_id) VALUES (?, ?, datetime('now', '+7 days'), 'нарушение', ?);`).run(randomUUID(), target.profileId, admin.profileId)

  // Чужди данни — "отпечатък" преди изтриването.
  const bystanderFingerprint = () => JSON.stringify([
    db.prepare('SELECT * FROM friend_chat_messages WHERE friendship_id = ? ORDER BY message_id;').all(unrelatedFriendship),
    db.prepare('SELECT * FROM support_messages WHERE profile_id = ? ORDER BY message_id;').all(strangerA.profileId),
    db.prepare('SELECT * FROM profile_ip_links WHERE profile_id = ? ORDER BY ip_address;').all(strangerA.profileId),
    db.prepare('SELECT * FROM profile_visitor_links WHERE profile_id = ? ORDER BY anonymous_visitor_id;').all(strangerA.profileId),
    db.prepare('SELECT * FROM topics WHERE topic_id = ?;').all(foreignTopic),
    db.prepare('SELECT * FROM profile_wallets WHERE profile_id IN (?, ?) ORDER BY profile_id;').all(strangerA.profileId, strangerB.profileId),
    db.prepare(`SELECT * FROM campaign_archive_top10 WHERE rank = 2 AND campaign_id = ?;`).all(campaignId),
  ])
  const bystanderBefore = bystanderFingerprint()
  const friendLudoBefore = JSON.stringify(db.prepare('SELECT * FROM ludo_match_economy_ledger WHERE profile_id = ? ORDER BY ledger_id;').all(friend.profileId))

  const result = await hardDelete.hardDeleteProfile({ targetProfileId: target.profileId, actorProfileId: admin.profileId, actorAccountId: admin.accountId, reason: 'Административно изтриване' })

  await check('[A1] Нормално административно изтриване: профил и акаунт изчезват; одит с operationId; файловата фаза е done', () => {
    assert(result.ok, JSON.stringify(result))
    if (!result.ok) return
    assertEqual(count('SELECT COUNT(*) AS c FROM profiles WHERE profile_id = ?;', target.profileId), 0, 'профил')
    assertEqual(count('SELECT COUNT(*) AS c FROM accounts WHERE account_id = ?;', target.accountId), 0, 'акаунт')
    const audit = db.prepare('SELECT deleted_profile_id, deleted_by_profile_id, reason, file_cleanup_status FROM admin_profile_deletions WHERE log_id = ?;').get(result.operationId) as Record<string, unknown>
    assertEqual(audit.deleted_profile_id, target.profileId, 'одит: профил')
    assertEqual(audit.deleted_by_profile_id, admin.profileId, 'одит: администратор')
    assertEqual(audit.reason, 'Административно изтриване', 'одит: причина')
    assertEqual(audit.file_cleanup_status, 'done', 'файловата фаза')
    assertEqual(result.filesPending, 0, 'filesPending')
  })

  await check('[A3] Б1: собствената тема изчезва изцяло — вкл. чуждия отговор и файла му', () => {
    assertEqual(count('SELECT COUNT(*) AS c FROM topics WHERE topic_id = ?;', ownTopic), 0, 'темата')
    assertEqual(count('SELECT COUNT(*) AS c FROM topic_messages WHERE message_id = ?;', foreignReplyInOwnTopic), 0, 'чуждият отговор в нея')
    assert(!existsSync(foreignFileInOwnTopic), 'файлът на чуждия отговор')
  })

  await check('[A4] А1: съобщението в чужда тема е изтрито, чуждият отговор остава като самостоятелна публикация', () => {
    assertEqual(count('SELECT COUNT(*) AS c FROM topic_messages WHERE message_id = ?;', targetRootInForeign), 0, 'съобщението на target')
    const reply = db.prepare('SELECT topic_id, parent_message_id, sender_profile_id FROM topic_messages WHERE message_id = ?;').get(foreignReplyToTarget) as Record<string, unknown> | undefined
    assert(reply !== undefined, 'чуждият отговор е изтрит')
    assertEqual(reply?.topic_id, foreignTopic, 'същата тема')
    assertEqual(reply?.parent_message_id, null, 'самостоятелна публикация')
    assert(!existsSync(targetFileInForeign), 'файлът на изтритото съобщение')
  })

  await check('[A5] Лични разговори: изтрити за двете страни (вкл. маркери и файлове); несвързаният разговор е непокътнат', () => {
    assertEqual(count('SELECT COUNT(*) AS c FROM friend_chat_messages WHERE friendship_id = ?;', targetFriendship), 0, 'съобщения')
    assertEqual(count('SELECT COUNT(*) AS c FROM chat_conversation_reads WHERE friendship_id = ?;', targetFriendship), 0, 'маркери')
    assert(!existsSync(chatByTarget) && !existsSync(chatByFriend), 'файловете на двете страни')
    assert(existsSync(unrelatedChat), 'файлът на несвързания разговор')
    assertEqual(count('SELECT COUNT(*) AS c FROM friend_chat_attachment_deletions;'), 0, 'старата best-effort опашка не се ползва')
  })

  await check('[A6] Поддръжка: съобщенията (вкл. на екипа), маркерът за архив и файловете са изтрити; чуждият разговор е непокътнат', () => {
    assertEqual(count('SELECT COUNT(*) AS c FROM support_messages WHERE profile_id = ?;', target.profileId), 0, 'съобщения')
    assertEqual(count('SELECT COUNT(*) AS c FROM support_archived WHERE profile_id = ?;', target.profileId), 0, 'маркер за архив')
    assert(!existsSync(supportByTarget.filePath) && !existsSync(supportReply.filePath), 'файловете')
    assert(existsSync(foreignSupport.filePath), 'чуждият файл')
  })

  await check('[A7] Исторически имена: старото и новото име са заличени, сумата остава; името в кампанийния архив е заличено', () => {
    const change = db.prepare('SELECT * FROM profile_name_change_ledger WHERE change_id = ?;').get(nameChangeId) as Record<string, unknown>
    assert(change.old_display_name !== 'СтароИме' && change.new_display_name !== target.displayName, JSON.stringify(change))
    assertEqual(change.price_amount, 500, 'сума')
    assertEqual(change.deleted_profile_id_snapshot, target.profileId, 'одитен идентификатор')
    const top = db.prepare('SELECT display_name_at_archive, units_total, rank_title_at_archive FROM campaign_archive_top10 WHERE campaign_id = ? AND rank = 1;').get(campaignId) as Record<string, unknown>
    assert(top.display_name_at_archive !== target.displayName, 'име в архива')
    assertEqual(top.units_total, 99, 'единиците')
    assertEqual(top.rank_title_at_archive, 'Шампион', 'титлата')
  })

  await check('[A8] Финансови инварианти: Ludo дебит и печалба остават със snapshot; записите на friend — непроменени', () => {
    assertEqual(count('SELECT COUNT(*) AS c FROM ludo_match_economy_ledger WHERE profile_id IS NULL AND deleted_profile_id_snapshot = ?;', target.profileId), 2, 'дебит + печалба')
    assertEqual(JSON.stringify(db.prepare('SELECT * FROM ludo_match_economy_ledger WHERE profile_id = ? ORDER BY ledger_id;').all(friend.profileId)), friendLudoBefore, 'friend')
  })

  await check('[A9-A10] История на Белот и Ludo: изтритият е анонимизиран, другите участници/резултати — непроменени', () => {
    const teamA = JSON.parse(String((db.prepare('SELECT team_a_json FROM private_room_matches WHERE room_id = ?;').get(privateRoom) as { team_a_json: string }).team_a_json)) as Array<Record<string, unknown>>
    assertEqual(JSON.stringify(teamA[0]), JSON.stringify({ profileId: null, displayName: PROFILE_DELETION_DELETED_LABEL, avatarUrl: null, isBot: false }), 'Белот: изтритият')
    assertEqual(JSON.stringify(teamA[1]), JSON.stringify(occupant(friend)), 'Белот: съотборникът')
    const ludo = db.prepare('SELECT players_json, winner_profile_id FROM ludo_room_matches WHERE match_id = ?;').get(ludoMatch) as { players_json: string; winner_profile_id: string }
    const players = JSON.parse(ludo.players_json) as Array<Record<string, unknown>>
    assert(/^deleted-[0-9a-f]{32}$/.test(String(players[0].profileId)) && ludo.winner_profile_id === players[0].profileId, 'Ludo: заместител и победител')
    assertEqual(players[1].profileId, friend.profileId, 'Ludo: другият играч')
  })

  await check('[A11] Оценки: дадената остава анонимна, получената е изтрита, кешът на friend е коректен', () => {
    assertEqual(count('SELECT COUNT(*) AS c FROM profile_partner_ratings WHERE rated_profile_id = ? AND rated_by_profile_id IS NULL;', friend.profileId), 1, 'анонимна оценка')
    assertEqual(count('SELECT COUNT(*) AS c FROM profile_partner_ratings WHERE rated_profile_id = ?;', target.profileId), 0, 'получени')
    const cache = db.prepare('SELECT average_rating, total_ratings_count FROM profiles WHERE profile_id = ?;').get(friend.profileId) as { average_rating: number; total_ratings_count: number }
    assertEqual(cache.total_ratings_count, 2, 'брой')
    assertEqual(cache.average_rating, 4, 'средна')
  })

  await check('[A12-A13] Неразгледаният сигнал остава анонимен; блокировката, наложена от target на друг, остава без автор', () => {
    const report = db.prepare('SELECT reporter_profile_id, status FROM topic_reports WHERE report_id = ?;').get(pendingReportId) as Record<string, unknown>
    assert(report !== undefined && report.reporter_profile_id === null && report.status === 'pending', JSON.stringify(report))
    const block = db.prepare('SELECT actor_profile_id, blocked_profile_id FROM tournament_participation_blocks WHERE block_id = ?;').get(blockId) as Record<string, unknown>
    assert(block !== undefined && block.actor_profile_id === null && block.blocked_profile_id === strangerB.profileId, JSON.stringify(block))
  })

  await check('[A14] Доказателство за заглушаване: редът е премахнат, копието на файла е изтрито (без сирак)', () => {
    assertEqual(count('SELECT COUNT(*) AS c FROM topic_mute_evidence WHERE profile_id = ?;', target.profileId), 0, 'ред')
    assert(!existsSync(evidencePath), 'файлът')
  })

  await check('[A15] IP/visitor: връзките на изтрития са изтрити; общите IP/visitor на друг профил остават; без нов forensic snapshot', () => {
    assertEqual(count('SELECT COUNT(*) AS c FROM profile_ip_links WHERE profile_id = ?;', target.profileId), 0, 'IP')
    assertEqual(count('SELECT COUNT(*) AS c FROM profile_visitor_links WHERE profile_id = ?;', target.profileId), 0, 'visitor')
    assertEqual(count('SELECT COUNT(*) AS c FROM admin_profile_deletion_visitor_snapshots WHERE deleted_profile_id = ?;', target.profileId), 0, 'snapshot')
  })

  await check('[A16] Активен бан не спира административното изтриване; банът остава в историята (snapshot)', () => {
    assertEqual(count('SELECT COUNT(*) AS c FROM profile_bans WHERE profile_id IS NULL AND deleted_profile_id_snapshot = ?;', target.profileId), 1, 'бан')
  })

  await check('[A22] Данните на другите профили са непроменени; от изтрития остават само административният одит и snapshot колоните', () => {
    assertEqual(bystanderFingerprint(), bystanderBefore, 'чужди данни')
    assertEqual((db.prepare('PRAGMA foreign_key_check;').all() as unknown[]).length, 0, 'foreign_key_check')
    assertEqual(findOccurrences(target.profileId).filter((hit) => !ALLOWED_RESIDUE(hit)).join(', '), '', 'profile_id')
    assertEqual(findOccurrences(target.email).join(', '), '', 'имейл')
    assertEqual(findOccurrences(avatarName).filter((hit) => !hit.startsWith('profile_deletion_file_queue.')).join(', '), '', 'аватар (извън опашката)')
    assert(!existsSync(avatarPath) && !existsSync(galleryPath), 'аватар и галерия')
  })

  await check('[A2] Изтриване по support заявка: архивен ред към изричното съобщение; кореспонденцията се изтрива по правилата на 4E5', async () => {
    const user = registerUser('Support')
    const request = await supportMessage(user, false)
    const r = await hardDelete.hardDeleteProfile({ targetProfileId: user.profileId, actorProfileId: admin.profileId, actorAccountId: admin.accountId, reason: 'По заявка', supportRequestMessageId: request.messageId })
    assert(r.ok, JSON.stringify(r))
    const archive = db.prepare('SELECT request_message_id, deleted_by_profile_id FROM support_deletion_archives WHERE profile_id = ?;').get(user.profileId) as Record<string, unknown>
    assertEqual(archive.request_message_id, request.messageId, 'архив към съобщението')
    assertEqual(archive.deleted_by_profile_id, admin.profileId, 'администратор')
    assertEqual(count('SELECT COUNT(*) AS c FROM support_messages WHERE profile_id = ?;', user.profileId), 0, 'кореспонденцията')
    assert(!existsSync(request.filePath), 'файлът')
    const invalid = await hardDelete.hardDeleteProfile({ targetProfileId: friend.profileId, actorProfileId: admin.profileId, actorAccountId: admin.accountId, reason: 'x', supportRequestMessageId: foreignSupport.messageId })
    assert(!invalid.ok && invalid.code === 'invalid_support_request_message', 'чуждо съобщение -> отказ')
    assertEqual(count('SELECT COUNT(*) AS c FROM profiles WHERE profile_id = ?;', friend.profileId), 1, 'нищо не е изтрито')
  })

  console.log('\n[F] Файлова фаза')

  await check('[F1-F2] Неуспешно физическо изтриване: файловата фаза остава pending; повторният опит я довършва', async () => {
    const user = registerUser('FileFail')
    const name = webp()
    const path = await writeUpload(roots.avatars, name)
    db.prepare('UPDATE profiles SET avatar_url = ? WHERE profile_id = ?;').run(`/uploads/avatars/${name}`, user.profileId)
    let fail = true
    const flaky = await createProfileHardDeleteService(databaseFilePath, {
      uploadRoots: roots,
      removeFile: async (kind, ref, r) => (fail ? { outcome: 'error', code: 'EBUSY' } : removeProfileDeletionFile(kind, ref, r)),
    })
    try {
      const r = await flaky.hardDeleteProfile({ targetProfileId: user.profileId, actorProfileId: admin.profileId, actorAccountId: admin.accountId, reason: 'x' })
      assert(r.ok && r.filesPending === 1, JSON.stringify(r))
      if (!r.ok) return
      assertEqual((db.prepare('SELECT file_cleanup_status FROM admin_profile_deletions WHERE log_id = ?;').get(r.operationId) as { file_cleanup_status: string }).file_cleanup_status, 'pending', 'статус')
      const row = db.prepare('SELECT status, last_error_code FROM profile_deletion_file_queue WHERE admin_operation_id = ?;').get(r.operationId) as Record<string, unknown>
      assert(row.status === 'failed' && row.last_error_code === 'EBUSY', JSON.stringify(row))
      assert(existsSync(path), 'файлът още е на диска')
      const early = selfExecutor.finishAdminFileCleanup(r.operationId)
      assert(early.kind === 'files_pending' && early.willRetry === true, `приключване с чакащ файл: ${JSON.stringify(early)}`)
      fail = false
      db.prepare(`UPDATE profile_deletion_file_queue SET next_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 second') WHERE admin_operation_id = ?;`).run(r.operationId)
      const summary = await flaky.processPendingAdminFileCleanup()
      assert(summary.completed >= 1, JSON.stringify(summary))
      assert(!existsSync(path), 'файлът е изтрит при повторния опит')
      assertEqual((db.prepare('SELECT file_cleanup_status FROM admin_profile_deletions WHERE log_id = ?;').get(r.operationId) as { file_cleanup_status: string }).file_cleanup_status, 'done', 'статус след опита')
    } finally {
      flaky.close()
    }
  })

  await check('[F3] Срив преди DB COMMIT: нищо не е изтрито — нито одит, нито опашка, нито профил', async () => {
    const user = registerUser('CrashBefore')
    const crashing = await createProfileHardDeleteService(databaseFilePath, {
      uploadRoots: roots,
      executorOptions: { testHooks: { beforeAdminCommit: () => { throw new Error('simulated crash') } } },
    })
    try {
      let thrown = false
      try {
        await crashing.hardDeleteProfile({ targetProfileId: user.profileId, actorProfileId: admin.profileId, actorAccountId: admin.accountId, reason: 'x', auditLogId: 'op-crash-before' })
      } catch {
        thrown = true
      }
      assert(thrown, 'сривът прекъсна изтриването')
    } finally {
      crashing.close()
    }
    assertEqual(count('SELECT COUNT(*) AS c FROM profiles WHERE profile_id = ?;', user.profileId), 1, 'профил')
    assertEqual(count(`SELECT COUNT(*) AS c FROM admin_profile_deletions WHERE log_id = 'op-crash-before';`), 0, 'одит')
    assertEqual(count(`SELECT COUNT(*) AS c FROM profile_deletion_file_queue WHERE admin_operation_id = 'op-crash-before';`), 0, 'опашка')
  })

  await check('[F4] Срив след COMMIT (процес без upload директории): файловете остават в опашката; друг процес ги довършва', async () => {
    const user = registerUser('CrashAfter')
    const name = webp()
    const path = await writeUpload(roots.avatars, name)
    db.prepare('UPDATE profiles SET avatar_url = ? WHERE profile_id = ?;').run(`/uploads/avatars/${name}`, user.profileId)
    const noRoots = await createProfileHardDeleteService(databaseFilePath, {})
    let operationId = ''
    try {
      const r = await noRoots.hardDeleteProfile({ targetProfileId: user.profileId, actorProfileId: admin.profileId, actorAccountId: admin.accountId, reason: 'x' })
      assert(r.ok && r.filesPending === 1, JSON.stringify(r))
      if (r.ok) operationId = r.operationId
    } finally {
      noRoots.close()
    }
    assert(existsSync(path), 'файлът е още на диска')
    const summary = await hardDelete.processPendingAdminFileCleanup()
    assert(summary.completed >= 1 && !existsSync(path), JSON.stringify(summary))
    assertEqual((db.prepare('SELECT file_cleanup_status FROM admin_profile_deletions WHERE log_id = ?;').get(operationId) as { file_cleanup_status: string }).file_cleanup_status, 'done', 'статус')
  })

  await check('[F6] Без файлове: файловата фаза е done още в DB транзакцията, опашката е празна', async () => {
    const user = registerUser('NoFiles')
    const noRoots = await createProfileHardDeleteService(databaseFilePath, {})
    try {
      const r = await noRoots.hardDeleteProfile({ targetProfileId: user.profileId, actorProfileId: admin.profileId, actorAccountId: admin.accountId, reason: 'x' })
      assert(r.ok && r.filesPending === 0, JSON.stringify(r))
      if (!r.ok) return
      assertEqual((db.prepare('SELECT file_cleanup_status FROM admin_profile_deletions WHERE log_id = ?;').get(r.operationId) as { file_cleanup_status: string }).file_cleanup_status, 'done', 'статус')
      assertEqual(count('SELECT COUNT(*) AS c FROM profile_deletion_file_queue WHERE admin_operation_id = ?;', r.operationId), 0, 'опашка')
    } finally {
      noRoots.close()
    }
  })

  await check('[F7] Постоянен отказ (опасен път): файловата фаза остава pending и откриваема; без повторни опити; лог file_cleanup_stuck', async () => {
    const user = registerUser('FileStuck')
    const name = webp()
    const path = await writeUpload(roots.avatars, name)
    db.prepare('UPDATE profiles SET avatar_url = ? WHERE profile_id = ?;').run(`/uploads/avatars/${name}`, user.profileId)
    let removeCalls = 0
    const refusing = await createProfileHardDeleteService(databaseFilePath, {
      uploadRoots: roots,
      removeFile: async () => { removeCalls += 1; return { outcome: 'rejected', code: 'symlink_refused' } },
    })
    const errors: string[] = []
    const originalError = console.error
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')) }
    try {
      const r = await refusing.hardDeleteProfile({ targetProfileId: user.profileId, actorProfileId: admin.profileId, actorAccountId: admin.accountId, reason: 'x' })
      assert(r.ok && r.filesPending === 1, JSON.stringify(r))
      if (!r.ok) return
      const row = db.prepare('SELECT status, attempt_count, last_error_code, next_attempt_at FROM profile_deletion_file_queue WHERE admin_operation_id = ?;').get(r.operationId) as Record<string, unknown>
      assert(row.status === 'failed' && row.last_error_code === 'symlink_refused' && Number(row.attempt_count) >= PROFILE_DELETION_MAX_FILE_ATTEMPTS && row.next_attempt_at === null, JSON.stringify(row))
      const finished = selfExecutor.finishAdminFileCleanup(r.operationId)
      assert(finished.kind === 'files_pending' && finished.willRetry === false, JSON.stringify(finished))
      assert(selfExecutor.listAdminOperationsPendingFileCleanup().some((op) => op.operationId === r.operationId), 'операцията е в списъка с недовършени')
      await refusing.processPendingAdminFileCleanup()
      assertEqual(removeCalls, 1, 'без повторни опити на постоянния отказ')
      assertEqual((db.prepare('SELECT file_cleanup_status FROM admin_profile_deletions WHERE log_id = ?;').get(r.operationId) as { file_cleanup_status: string }).file_cleanup_status, 'pending', 'статус')
      assert(errors.some((line) => line.includes(`file_cleanup_stuck operationId=${r.operationId}`)), `лог: ${JSON.stringify(errors)}`)
      assert(!errors.some((line) => line.includes(name)), 'файловият път не се логва')
      assert(existsSync(path), 'файлът не е пипнат')
    } finally {
      console.error = originalError
      refusing.close()
    }
  })

  await check('[F5] Тригери: done само без чакащи файлове; ред в опашката само за pending операция; точно един собственик', () => {
    db.prepare(`INSERT INTO admin_profile_deletions (log_id, deleted_profile_id, username_snapshot, reason, file_cleanup_status) VALUES ('op-guard', 'ghost', 'ghost', 'x', 'pending');`).run()
    db.prepare(`INSERT INTO profile_deletion_file_queue (admin_operation_id, file_kind, storage_ref) VALUES ('op-guard', 'avatar', '/uploads/avatars/g.webp');`).run()
    assertRejects(() => db.prepare(`UPDATE admin_profile_deletions SET file_cleanup_status = 'done' WHERE log_id = 'op-guard';`).run(), 'admin_profile_deletion_files_pending', 'done с чакащ файл')
    assertRejects(() => db.prepare(`INSERT INTO profile_deletion_file_queue (admin_operation_id, file_kind, storage_ref) VALUES ('op-missing', 'avatar', '/uploads/avatars/m.webp');`).run(), 'profile_deletion_file_requires_admin_operation', 'несъществуваща операция')
    db.prepare(`INSERT INTO admin_profile_deletions (log_id, deleted_profile_id, username_snapshot, reason) VALUES ('op-legacy', 'ghost2', 'ghost2', 'x');`).run()
    assertRejects(() => db.prepare(`INSERT INTO profile_deletion_file_queue (admin_operation_id, file_kind, storage_ref) VALUES ('op-legacy', 'avatar', '/uploads/avatars/l.webp');`).run(), 'profile_deletion_file_requires_admin_operation', 'наследена операция (NULL)')
    assertRejects(() => db.prepare(`UPDATE admin_profile_deletions SET file_cleanup_status = 'pending' WHERE log_id = 'op-legacy';`).run(), 'admin_profile_deletion_file_cleanup_invalid_transition', 'NULL -> pending')
    assertRejects(() => db.prepare(`INSERT INTO profile_deletion_file_queue (file_kind, storage_ref) VALUES ('avatar', '/uploads/avatars/n.webp');`).run(), 'profile_deletion_file_requires_executing_request', 'без собственик')
    assertRejects(() => db.prepare(`DELETE FROM profile_deletion_file_queue WHERE admin_operation_id = 'op-guard';`).run(), 'profile_deletion_file_queue_no_delete', 'триене от опашката')
  })

  console.log('\n[R] Restore')

  await check('[R1] Restore на стар backup (преди изтриването) + replay: същото почистване и файлове във възстановените uploads; повторно — без дублиране', async () => {
    const victim = registerUser('Restore')
    const name = webp()
    db.prepare('UPDATE profiles SET avatar_url = ? WHERE profile_id = ?;').run(`/uploads/avatars/${name}`, victim.profileId)
    db.prepare(`INSERT INTO profile_ip_links (profile_id, ip_address, first_seen_at, last_seen_at, event_count) VALUES (?, '198.51.100.77', '2026-01-01 00:00:00', '2026-01-01 00:00:00', 1);`).run(victim.profileId)
    const backupDir = await mkdtemp(join(tmpdir(), 'belot-admin-unified-restore-'))
    tempRoots.push(backupDir)
    const backup = join(backupDir, 'old.sqlite')
    db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}';`)
    const live = await hardDelete.hardDeleteProfile({ targetProfileId: victim.profileId, actorProfileId: admin.profileId, actorAccountId: admin.accountId, reason: 'x', auditLogId: 'op-restore' })
    assert(live.ok, 'живо изтриване')
    const restoredRoots = makeRoots(join(backupDir, 'uploads'))
    for (const dir of Object.values(restoredRoots)) await mkdir(dir, { recursive: true })
    const restoredAvatar = await writeUpload(restoredRoots.avatars, name)
    const restoredService = await createProfileHardDeleteService(backup, { uploadRoots: restoredRoots })
    try {
      const replay = await restoredService.hardDeleteProfile({ targetProfileId: victim.profileId, actorProfileId: admin.profileId, actorAccountId: '', reason: 'replay', auditLogId: 'op-restore', replay: { deletedAt: '2026-10-01 10:00:00' } })
      assert(replay.ok && replay.filesPending === 0, JSON.stringify(replay))
      const again = await restoredService.hardDeleteProfile({ targetProfileId: victim.profileId, actorProfileId: admin.profileId, actorAccountId: '', reason: 'replay', auditLogId: 'op-restore', replay: { deletedAt: '2026-10-01 10:00:00' } })
      assert(!again.ok && again.code === 'not_found', 'повторният replay не прави нищо')
    } finally {
      restoredService.close()
    }
    const restored = new sqliteModule.DatabaseSync(backup, { readOnly: true })
    try {
      assertEqual(Number((restored.prepare('SELECT COUNT(*) AS c FROM profiles WHERE profile_id = ?;').get(victim.profileId) as { c: number }).c), 0, 'профилът')
      assertEqual(Number((restored.prepare('SELECT COUNT(*) AS c FROM profile_ip_links WHERE profile_id = ?;').get(victim.profileId) as { c: number }).c), 0, 'IP връзката')
      assertEqual(Number((restored.prepare(`SELECT COUNT(*) AS c FROM admin_profile_deletions WHERE log_id = 'op-restore';`).get() as { c: number }).c), 1, 'един одитен ред (оригиналната операция)')
      assertEqual((restored.prepare(`SELECT deleted_at FROM admin_profile_deletions WHERE log_id = 'op-restore';`).get() as { deleted_at: string }).deleted_at, '2026-10-01 10:00:00', 'оригиналният момент')
    } finally {
      restored.close()
    }
    assert(!existsSync(restoredAvatar), 'файлът във възстановените uploads')
  })

  await check('[R2] Restore на backup между COMMIT и файловете: недовършената файлова фаза се довършва', async () => {
    const victim = registerUser('RestoreMid')
    const name = webp()
    await writeUpload(roots.avatars, name)
    db.prepare('UPDATE profiles SET avatar_url = ? WHERE profile_id = ?;').run(`/uploads/avatars/${name}`, victim.profileId)
    const noRoots = await createProfileHardDeleteService(databaseFilePath, {})
    let operationId = ''
    try {
      const r = await noRoots.hardDeleteProfile({ targetProfileId: victim.profileId, actorProfileId: admin.profileId, actorAccountId: admin.accountId, reason: 'x' })
      if (r.ok) operationId = r.operationId
    } finally {
      noRoots.close()
    }
    const backupDir = await mkdtemp(join(tmpdir(), 'belot-admin-unified-mid-'))
    tempRoots.push(backupDir)
    const backup = join(backupDir, 'mid.sqlite')
    db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}';`)
    const restoredRoots = makeRoots(join(backupDir, 'uploads'))
    for (const dir of Object.values(restoredRoots)) await mkdir(dir, { recursive: true })
    const restoredAvatar = await writeUpload(restoredRoots.avatars, name)
    const restoredService = await createProfileHardDeleteService(backup, { uploadRoots: restoredRoots })
    try {
      const summary = await restoredService.processPendingAdminFileCleanup()
      assert(summary.completed >= 1, JSON.stringify(summary))
    } finally {
      restoredService.close()
    }
    assert(!existsSync(restoredAvatar), 'файлът')
    const restored = new sqliteModule.DatabaseSync(backup, { readOnly: true })
    assertEqual((restored.prepare('SELECT file_cleanup_status FROM admin_profile_deletions WHERE log_id = ?;').get(operationId) as { file_cleanup_status: string }).file_cleanup_status, 'done', 'статус')
    restored.close()
    await hardDelete.processPendingAdminFileCleanup() // довършване и в живата база
  })

  console.log('\n[C] Координатор, паралелно самоизтриване, вход')

  await check('[C1] Координатор: изчакване на offsite -> вход отказан (PROFILE_DELETION_SCHEDULED) и onWaiting; след ack -> изпълнено; регистърът — completed', async () => {
    const user = registerUser('Scheduled')
    const coordinator = await createAdminProfileDeletionCoordinator({
      databaseFilePath, hardDeleteService: hardDelete, pendingStore, ledgerPath, offsiteRequired: true, isTargetInActiveGame: () => false,
    })
    try {
      const scheduled = coordinator.schedule({ targetProfileId: user.profileId, actorProfileId: admin.profileId, actorAccountId: admin.accountId, reason: 'насрочено', supportRequestMessageId: null })
      assert(scheduled.ok, JSON.stringify(scheduled))
      if (!scheduled.ok) return
      const waiting: string[] = []
      const first = await coordinator.runOnce({ onWaiting: (pending) => waiting.push(pending.targetProfileId) })
      assertEqual(first.waiting, 1, 'чака offsite')
      assertEqual(waiting.join(','), user.profileId, 'onWaiting')
      const login = authStore.login({ email: user.email, password: PASSWORD, rememberMe: false })
      assert(!login.ok && 'code' in login && login.code === 'PROFILE_DELETION_SCHEDULED', `вход: ${JSON.stringify(login)}`)
      ackLedger(ledgerPath)
      const second = await coordinator.runOnce()
      assertEqual(second.executed, 1, 'изпълнено след ack')
      assertEqual(count('SELECT COUNT(*) AS c FROM profiles WHERE profile_id = ?;', user.profileId), 0, 'профилът')
      const state = readProfileDeletionLedger(ledgerPath).records.filter((record) => 'operationId' in record && record.operationId === scheduled.operationId).map((record) => record.kind)
      assert(state.includes('admin_delete_intent') && state.includes('admin_delete_completed'), state.join(','))
      assertEqual(count(`SELECT COUNT(*) AS c FROM admin_profile_deletions WHERE log_id = ?;`, scheduled.operationId), 1, 'един одитен ред = operationId')
    } finally {
      coordinator.close()
    }
  })

  console.log('\n[P] Права (Етап 4F2A): само роля admin инициира окончателно административно изтриване')

  await check('[P1] schedule: subadmin/pika_team/marketing/top_chat_admin/chat_admin/player, admin с чужд профил, празна причина -> отказ без висящ ред и без запис в регистъра', async () => {
    const target = registerUser('RoleTarget')
    const coordinator = await createAdminProfileDeletionCoordinator({
      databaseFilePath, hardDeleteService: hardDelete, pendingStore, ledgerPath, offsiteRequired: true, isTargetInActiveGame: () => false,
    })
    try {
      const ledgerBefore = readProfileDeletionLedger(ledgerPath).records.length
      for (const role of ['subadmin', 'pika_team', 'marketing', 'top_chat_admin', 'chat_admin', 'player']) {
        const actor = registerUser(`Role${role.replace(/_/g, '')}`)
        db.prepare(`UPDATE accounts SET role = ? WHERE account_id = ?;`).run(role, actor.accountId)
        const r = coordinator.schedule({ targetProfileId: target.profileId, actorProfileId: actor.profileId, actorAccountId: actor.accountId, reason: 'опит', supportRequestMessageId: null })
        assert(!r.ok && r.code === 'forbidden', `${role}: ${JSON.stringify(r)}`)
      }
      const other = registerUser('RoleOther')
      const foreign = coordinator.schedule({ targetProfileId: target.profileId, actorProfileId: other.profileId, actorAccountId: admin.accountId, reason: 'опит', supportRequestMessageId: null })
      assert(!foreign.ok && foreign.code === 'forbidden', `admin акаунт + чужд профил: ${JSON.stringify(foreign)}`)
      const emptyReason = coordinator.schedule({ targetProfileId: target.profileId, actorProfileId: admin.profileId, actorAccountId: admin.accountId, reason: '   ', supportRequestMessageId: null })
      assert(!emptyReason.ok && emptyReason.code === 'invalid_reason', `празна причина: ${JSON.stringify(emptyReason)}`)
      assertEqual(count(`SELECT COUNT(*) AS c FROM pending_profile_moderation WHERE target_profile_id = ?;`, target.profileId), 0, 'висящ ред')
      assertEqual(readProfileDeletionLedger(ledgerPath).records.length, ledgerBefore, 'записи в регистъра')
      assertEqual(count('SELECT COUNT(*) AS c FROM profiles WHERE profile_id = ?;', target.profileId), 1, 'профилът')
    } finally {
      coordinator.close()
    }
  })

  await check('[P2] Директно hardDeleteProfile от неупълномощен актьор (вкл. по support заявка) -> forbidden, нищо не е променено', async () => {
    const target = registerUser('DirectTarget')
    const request = await supportMessage(target, false)
    const subadmin = registerUser('DirectSubadmin')
    db.prepare(`UPDATE accounts SET role = 'subadmin' WHERE account_id = ?;`).run(subadmin.accountId)
    const auditBefore = count('SELECT COUNT(*) AS c FROM admin_profile_deletions;')
    for (const input of [
      { actorProfileId: subadmin.profileId, actorAccountId: subadmin.accountId, supportRequestMessageId: null },
      { actorProfileId: subadmin.profileId, actorAccountId: subadmin.accountId, supportRequestMessageId: request.messageId },
      { actorProfileId: 'nobody', actorAccountId: '', supportRequestMessageId: null },
    ]) {
      const r = await hardDelete.hardDeleteProfile({ targetProfileId: target.profileId, reason: 'опит', ...input })
      assert(!r.ok && r.code === 'forbidden', JSON.stringify(r))
    }
    assertEqual(count('SELECT COUNT(*) AS c FROM profiles WHERE profile_id = ?;', target.profileId), 1, 'профилът')
    assertEqual(count('SELECT COUNT(*) AS c FROM admin_profile_deletions;'), auditBefore, 'одит')
    assertEqual(count('SELECT COUNT(*) AS c FROM support_messages WHERE message_id = ?;', request.messageId), 1, 'support съобщението')
  })

  await check('[P3] Насрочена от admin операция се довършва от координатора без интерактивна сесия на администратора', async () => {
    const user = registerUser('NoSession')
    const coordinator = await createAdminProfileDeletionCoordinator({
      databaseFilePath, hardDeleteService: hardDelete, pendingStore, ledgerPath, offsiteRequired: true, isTargetInActiveGame: () => false,
    })
    try {
      const scheduled = coordinator.schedule({ targetProfileId: user.profileId, actorProfileId: admin.profileId, actorAccountId: admin.accountId, reason: 'без сесия', supportRequestMessageId: null })
      assert(scheduled.ok, JSON.stringify(scheduled))
      if (!scheduled.ok) return
      authStore.revokeAllSessionsForProfile(admin.profileId)
      ackLedger(ledgerPath)
      const run = await coordinator.runOnce()
      assert(run.executed >= 1 && run.refused === 0, JSON.stringify(run))
      assertEqual(count('SELECT COUNT(*) AS c FROM profiles WHERE profile_id = ?;', user.profileId), 0, 'профилът')
      assertEqual(count(`SELECT COUNT(*) AS c FROM admin_profile_deletions WHERE log_id = ? AND deleted_by_profile_id = ?;`, scheduled.operationId, admin.profileId), 1, 'одит')
    } finally {
      coordinator.close()
    }
  })

  await check('[P4] Наследен висящ ред отпреди 4F1 (без requested_by_account_id) се довършва; сам по себе си hardDeleteProfile без насрочване би бил отказан', async () => {
    const user = registerUser('LegacyPending')
    const direct = await hardDelete.hardDeleteProfile({ targetProfileId: user.profileId, actorProfileId: admin.profileId, actorAccountId: '', reason: 'наследено' })
    assert(!direct.ok && direct.code === 'forbidden', `без насрочване: ${JSON.stringify(direct)}`)
    db.prepare(`INSERT INTO pending_profile_moderation (pending_id, target_profile_id, action, requested_by_profile_id, requested_by_account_id, reason) VALUES (?, ?, 'delete', ?, NULL, 'наследено');`)
      .run(randomUUID(), user.profileId, admin.profileId)
    const coordinator = await createAdminProfileDeletionCoordinator({
      databaseFilePath, hardDeleteService: hardDelete, pendingStore, ledgerPath, offsiteRequired: true, isTargetInActiveGame: () => false,
    })
    try {
      const first = await coordinator.runOnce()
      assertEqual(first.waiting, 1, 'намерението е записано и чака offsite')
      ackLedger(ledgerPath)
      const second = await coordinator.runOnce()
      assert(second.executed === 1 && second.refused === 0, JSON.stringify(second))
      assertEqual(count('SELECT COUNT(*) AS c FROM profiles WHERE profile_id = ?;', user.profileId), 0, 'профилът')
    } finally {
      coordinator.close()
    }
  })

  await check('[C2] Паралелно: висяща заявка за самоизтриване + административно изтриване -> worker-ът я приключва без повторно изтриване', async () => {
    const user = registerUser('Parallel')
    const requestId = randomUUID()
    const createdAt = (db.prepare('SELECT created_at FROM profiles WHERE profile_id = ?;').get(user.profileId) as { created_at: string }).created_at
    const scheduledFor = new Date(Date.now() - 1000).toISOString()
    const triggerSql = (db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'trg_profile_deletion_requests_insert_guard';`).get() as { sql: string }).sql
    db.exec('DROP TRIGGER trg_profile_deletion_requests_insert_guard;')
    try {
      db.prepare(`INSERT INTO profile_deletion_requests (request_id, profile_id, account_id_snapshot, profile_created_at_snapshot, requested_at, scheduled_for) VALUES (?, ?, ?, ?, ?, ?);`)
        .run(requestId, user.profileId, user.accountId, createdAt, new Date(Date.parse(scheduledFor) - PROFILE_DELETION_GRACE_PERIOD_MS).toISOString(), scheduledFor)
    } finally {
      db.exec(triggerSql)
    }
    const r = await hardDelete.hardDeleteProfile({ targetProfileId: user.profileId, actorProfileId: admin.profileId, actorAccountId: admin.accountId, reason: 'x' })
    assert(r.ok, 'административното изтриване')
    const worker = createProfileDeletionWorker({ executor: selfExecutor, workerId: 'w-par', uploadRoots: roots, removeFile: removeProfileDeletionFile, appendLedgerEntry: null, onlyRequestIds: [requestId] })
    const summary = await worker.runOnce()
    assertEqual(summary.completed, 1, `completed (${JSON.stringify(summary)})`)
    const detail = (db.prepare(`SELECT detail_json FROM profile_deletion_events WHERE request_id = ? AND event_type = 'db_deleted';`).get(requestId) as { detail_json: string }).detail_json
    assert(detail.includes('"alreadyDeletedByAdmin":true'), detail)
  })

  await check('[C3] Самоизтриване преди административното: висящото административно изтриване е приключено (без второ изтриване)', async () => {
    const user = registerUser('SelfFirst')
    pendingStore.recordPendingDelete({ targetProfileId: user.profileId, requestedByProfileId: admin.profileId, requestedByAccountId: admin.accountId, reason: 'x', ledgerOperationId: randomUUID() })
    const requestId = randomUUID()
    const createdAt = (db.prepare('SELECT created_at FROM profiles WHERE profile_id = ?;').get(user.profileId) as { created_at: string }).created_at
    const scheduledFor = new Date(Date.now() - 1000).toISOString()
    const triggerSql = (db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'trg_profile_deletion_requests_insert_guard';`).get() as { sql: string }).sql
    db.exec('DROP TRIGGER trg_profile_deletion_requests_insert_guard;')
    try {
      db.prepare(`INSERT INTO profile_deletion_requests (request_id, profile_id, account_id_snapshot, profile_created_at_snapshot, requested_at, scheduled_for) VALUES (?, ?, ?, ?, ?, ?);`)
        .run(requestId, user.profileId, user.accountId, createdAt, new Date(Date.parse(scheduledFor) - PROFILE_DELETION_GRACE_PERIOD_MS).toISOString(), scheduledFor)
    } finally {
      db.exec(triggerSql)
    }
    const worker = createProfileDeletionWorker({ executor: selfExecutor, workerId: 'w-self', uploadRoots: roots, removeFile: removeProfileDeletionFile, appendLedgerEntry: null, onlyRequestIds: [requestId] })
    assertEqual((await worker.runOnce()).completed, 1, 'самоизтриването')
    assertEqual(pendingStore.listPendingDeletes().filter((pending) => pending.targetProfileId === user.profileId).length, 0, 'висящото административно изтриване е приключено')
    const again = await hardDelete.hardDeleteProfile({ targetProfileId: user.profileId, actorProfileId: admin.profileId, actorAccountId: admin.accountId, reason: 'x' })
    assert(!again.ok && again.code === 'not_found', 'без второ изтриване')
  })
} catch (error) {
  failed += 1
  console.error(`  FAIL  неочаквана грешка: ${error instanceof Error ? error.stack : String(error)}`)
}

for (const dir of tempRoots) await rm(dir, { recursive: true, force: true }).catch(() => {})

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)
process.exitCode = failed > 0 ? 1 : 0
