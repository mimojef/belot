/**
 * checkProfileDeletionVisibility.ts
 *
 * Самоизтриване на профили — Етап 2. Детерминирани проверки на централния
 * механизъм за видимост (src/db/profileDeletionVisibility.ts) и на всички
 * store-ове, които го ползват, върху ИЗОЛИРАНА temp база с всички реални
 * миграции (през ensureServerDatabaseReady()). Никога реалната база.
 *
 * Скриването се задейства с ред в profile_deletion_requests (както ще го
 * прави бъдещият API етап); възстановяването — с отмяна (status=cancelled).
 *
 * [V] Публична видимост в playerProgressStore + вътрешен достъп непроменен.
 * [U] Директни адреси към аватар/галерия.
 * [S] Сесия и вход на скрит профил.
 * [F] Приятелства — невидими и неизменими за другата страна.
 * [C] Лични разговори — скрити за двете страни, нищо не се трие.
 * [G] Подаръци към скрит профил.
 * [D] Нито една таблица не се променя от механизма (snapshot преди/след).
 * [X] Отмяна — всичко се връща без загуби; retention без изключения.
 * [R] Регистрация — трите съобщения, без разкриване на състоянието.
 */

import { randomUUID } from 'node:crypto'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'
import { createPlayerProgressStore } from '../src/db/playerProgressStore.js'
import {
  createAuthStore,
  PROFILE_PENDING_DELETION_LOGIN_MESSAGE,
  REGISTRATION_DISPLAY_NAME_TAKEN_MESSAGE,
  REGISTRATION_EMAIL_AND_DISPLAY_NAME_TAKEN_MESSAGE,
  REGISTRATION_EMAIL_TAKEN_MESSAGE,
  type AuthStore,
  type RegistrationVerificationMode,
} from '../src/db/authStore.js'
import { createFriendshipStore } from '../src/db/friendshipStore.js'
import { createBlockStore } from '../src/db/blockStore.js'
import { createChatStore } from '../src/db/chatStore.js'
import { createAdminSettingsStore } from '../src/db/adminSettingsStore.js'
import { createYellowCoinGiftStore } from '../src/db/yellowCoinGiftStore.js'
import { computeProfileDeletionSchedule } from '../src/db/profileDeletionSchedule.js'
import { sqlProfileVisibleForDeletion } from '../src/db/profileDeletionVisibility.js'
import { cancelRequestDirectlyForTest } from './fixtures/profileDeletionCancellationKit.js'

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

const sourceServerRoot = resolve(
  process.argv.slice(2).find((arg) => arg.startsWith('--server-root='))?.slice('--server-root='.length)
    ?? process.cwd(),
)
const sourceMigrationsDirectoryPath = join(sourceServerRoot, 'database', 'migrations')
const REGISTRATION_SECRET = 'profile-deletion-visibility-test-secret-0123456789'
const PASSWORD = 'secret123'

console.log('\ncheckProfileDeletionVisibility')
console.log(`Server root: ${sourceServerRoot}`)

const root = await mkdtemp(join(tmpdir(), 'belot-profile-deletion-visibility-'))

async function prepareDatabase(): Promise<string> {
  await mkdir(join(root, 'database', 'migrations'), { recursive: true })
  await mkdir(join(root, 'database', 'data'), { recursive: true })
  const entries = await readdir(sourceMigrationsDirectoryPath, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isFile() && extname(entry.name).toLowerCase() === '.sql') {
      await cp(join(sourceMigrationsDirectoryPath, entry.name), join(root, 'database', 'migrations', entry.name))
    }
  }
  const result = await ensureServerDatabaseReady({ serverRootOverride: root })
  return result.databaseFilePath
}

const databaseFilePath = await prepareDatabase()
const sqliteModule = await import('node:sqlite')
const db: SqliteDatabase = new sqliteModule.DatabaseSync(databaseFilePath, { open: true, enableForeignKeyConstraints: true })
db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')

let registrationMode: RegistrationVerificationMode = 'direct'
const progressStore = await createPlayerProgressStore(databaseFilePath)
const authStore: AuthStore = await createAuthStore(databaseFilePath, progressStore, {
  registrationVerificationCodeSecret: REGISTRATION_SECRET,
  getRegistrationVerificationMode: () => registrationMode,
})
const friendshipStore = await createFriendshipStore(databaseFilePath, progressStore)
const blockStore = await createBlockStore(databaseFilePath)
const chatStore = await createChatStore(databaseFilePath, progressStore, blockStore, friendshipStore)
const adminSettingsStore = await createAdminSettingsStore(databaseFilePath)
const giftStore = await createYellowCoinGiftStore(databaseFilePath, progressStore, adminSettingsStore)

type User = { profileId: string; accountId: string; email: string; displayName: string; sessionToken: string }

let userCounter = 0
function registerUser(label: string): User {
  userCounter += 1
  const email = `vis-${label.toLowerCase()}-${userCounter}@example.test`
  const displayName = `Vis${label}${userCounter}`
  const result = authStore.register({ email, password: PASSWORD, displayName, gender: 'male', visitorId: randomUUID() })
  if (!result.ok || result.mode !== 'direct') throw new Error(`регистрация ${label}: ${JSON.stringify(result)}`)
  const profileId = result.session.profile.profileId
  if (profileId === null) throw new Error('липсва profileId')
  db.prepare('UPDATE profile_wallets SET yellow_coins_balance = 100000 WHERE profile_id = ?;').run(profileId)
  return { profileId, accountId: result.session.account.accountId, email, displayName, sessionToken: result.sessionToken }
}

function hideProfile(user: User): string {
  const row = db.prepare('SELECT account_id, created_at FROM profiles WHERE profile_id = ?;').get(user.profileId) as { account_id: string; created_at: string }
  const now = (db.prepare(`SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now;`).get() as { now: string }).now
  const schedule = computeProfileDeletionSchedule(new Date(now))
  const requestId = randomUUID()
  db.prepare(`
    INSERT INTO profile_deletion_requests (request_id, profile_id, account_id_snapshot, profile_created_at_snapshot, requested_at, scheduled_for)
    VALUES (?, ?, ?, ?, ?, ?);
  `).run(requestId, user.profileId, row.account_id, row.created_at, schedule.requestedAt, schedule.scheduledFor)
  return requestId
}

// Етап 4J1 — изход от активна заявка само през финализирана трайна отмяна.
function cancelHide(requestId: string): void {
  cancelRequestDirectlyForTest(db, requestId)
}

/** SHA-256 на всички редове на всяка таблица (освен profile_deletion_*), сортирани детерминирано. */
function snapshotDatabase(): Map<string, string> {
  const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name;`).all() as Array<{ name: string }>)
    .map((row) => row.name)
    .filter((name) => !name.startsWith('profile_deletion_'))
  const result = new Map<string, string>()
  for (const table of tables) {
    const rows = db.prepare(`SELECT * FROM "${table}";`).all().map((row) => JSON.stringify(row)).sort()
    result.set(table, createHash('sha256').update(rows.join('\n')).digest('hex'))
  }
  return result
}

function diffSnapshots(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed: string[] = []
  for (const [table, hash] of before) {
    if (after.get(table) !== hash) changed.push(table)
  }
  return changed
}

function makeFriends(a: User, b: User): string {
  const request = friendshipStore.sendRequest(a.profileId, b.profileId)
  if (!request.ok) throw new Error(`friend request: ${request.message}`)
  const accept = friendshipStore.acceptRequest(b.profileId, request.friendshipId)
  if (!accept.ok) throw new Error(`friend accept: ${accept.message}`)
  return request.friendshipId
}

function friendshipRow(friendshipId: string): string {
  return JSON.stringify(db.prepare('SELECT * FROM profile_friendships WHERE friendship_id = ?;').get(friendshipId))
}

function profileIdsOf(list: Array<{ profileId: string | null }>): Set<string> {
  return new Set(list.map((p) => p.profileId).filter((id): id is string => id !== null))
}

try {
  // ─── Fixture ───────────────────────────────────────────────────────────
  const alice = registerUser('Alice') // наблюдател, активен
  const bob = registerUser('Bob') // активен контрол
  const hidden = registerUser('Hidden') // ще бъде скрит
  const requester = registerUser('Requester') // скрит, с изпратена покана към Alice
  const addressee = registerUser('Addressee') // скрит, с покана от Alice към него

  const aliceHiddenFriendshipId = makeFriends(alice, hidden)
  const aliceBobFriendshipId = makeFriends(alice, bob)
  const incoming = friendshipStore.sendRequest(requester.profileId, alice.profileId)
  if (!incoming.ok) throw new Error('incoming request')
  const outgoing = friendshipStore.sendRequest(alice.profileId, addressee.profileId)
  if (!outgoing.ok) throw new Error('outgoing request')

  // Разговор Alice <-> Hidden: съобщения от двете страни + прикачен файл.
  const attachmentDir = join(root, 'chat-attachments')
  await mkdir(attachmentDir, { recursive: true })
  const attachmentFilename = `${randomUUID()}.webp`
  await writeFile(join(attachmentDir, attachmentFilename), Buffer.from('fake-webp'))
  const send1 = chatStore.sendMessage(hidden.profileId, aliceHiddenFriendshipId, 'Здравей от скрития', {
    storageFilename: attachmentFilename, width: 10, height: 10, byteSize: 9, contentType: 'image/webp',
  })
  const send2 = chatStore.sendMessage(alice.profileId, aliceHiddenFriendshipId, 'Отговор от Alice', null)
  const send3 = chatStore.sendMessage(hidden.profileId, aliceHiddenFriendshipId, 'Непрочетено за Alice', null)
  if (!send1.ok || !send2.ok || !send3.ok) throw new Error('chat fixture')
  // created_at е с точност до секунда — маркерът "прочетено" на Alice се
  // мести детерминирано преди всички съобщения, после съобщенията на
  // скрития се разполагат след него => точно 2 непрочетени за Alice.
  db.prepare(`
    INSERT INTO chat_conversation_reads (profile_id, friendship_id, last_read_at)
    VALUES (?, ?, datetime('now', '-2 hours'))
    ON CONFLICT (profile_id, friendship_id) DO UPDATE SET last_read_at = excluded.last_read_at;
  `).run(alice.profileId, aliceHiddenFriendshipId)
  db.prepare(`UPDATE friend_chat_messages SET created_at = datetime('now', '-1 hour') WHERE friendship_id = ?;`).run(aliceHiddenFriendshipId)

  // Аватар и галерия.
  const hiddenAvatar = `/uploads/avatars/${randomUUID()}.webp`
  const sharedAvatar = `/uploads/avatars/${randomUUID()}.webp`
  db.prepare('UPDATE profiles SET avatar_url = ? WHERE profile_id = ?;').run(hiddenAvatar, hidden.profileId)
  db.prepare('UPDATE profiles SET avatar_url = ? WHERE profile_id = ?;').run(sharedAvatar, requester.profileId)
  db.prepare('UPDATE profiles SET avatar_url = ? WHERE profile_id = ?;').run(sharedAvatar, bob.profileId)
  const hiddenGallery = `/uploads/profile-gallery/${hidden.profileId}/${randomUUID()}.webp`
  const bobGallery = `/uploads/profile-gallery/${bob.profileId}/${randomUUID()}.webp`

  const unreadBefore = chatStore.listConversations(alice.profileId).find((c) => c.friendshipId === aliceHiddenFriendshipId)?.unreadCount
  assert(unreadBefore === 2, `fixture: очаквани 2 непрочетени, получени ${unreadBefore}`)

  // ─── Състояние преди скриване ───────────────────────────────────────
  const snapshotBefore = snapshotDatabase()
  const hiddenIds = [hidden, requester, addressee].map((user) => ({ user, requestId: hideProfile(user) }))

  console.log('\n[V] Публична видимост')

  await check('[V1] getVisiblePublicProfile връща null за скрит профил; вътрешният getPublicProfile — профила', () => {
    assertEqual(progressStore.getVisiblePublicProfile(hidden.profileId), null, 'видим скрит профил')
    assertEqual(progressStore.getPublicProfile(hidden.profileId)?.profileId ?? null, hidden.profileId, 'вътрешен достъп')
    assertEqual(progressStore.getVisiblePublicProfile(bob.profileId)?.profileId ?? null, bob.profileId, 'активен профил')
    assertEqual(progressStore.isProfileHiddenForDeletion(hidden.profileId), true, 'isProfileHiddenForDeletion')
  })

  await check('[V2] Списък с играчи, търсене, ред на players страницата и snapshot-и изключват скрития профил', () => {
    const listed = profileIdsOf(progressStore.listPublicHumanProfiles())
    assert(!listed.has(hidden.profileId) && listed.has(bob.profileId), 'listPublicHumanProfiles')
    const search = profileIdsOf(progressStore.searchPublicProfiles('vishidden'))
    assert(!search.has(hidden.profileId), 'searchPublicProfiles намери скрития')
    const searchBob = profileIdsOf(progressStore.searchPublicProfiles('visbob'))
    assert(searchBob.has(bob.profileId), 'searchPublicProfiles не намери Bob')
    const eligible = new Set(progressStore.listEligibleProfileKinds().map((row) => row.profileId))
    assert(!eligible.has(hidden.profileId) && eligible.has(bob.profileId), 'listEligibleProfileKinds')
    const snapshots = profileIdsOf(progressStore.getProfileSnapshotsByIds([hidden.profileId, bob.profileId]))
    assert(!snapshots.has(hidden.profileId) && snapshots.has(bob.profileId), 'getProfileSnapshotsByIds')
  })

  await check('[V3] Всички 4 класации изключват скрития профил', () => {
    const boards = progressStore.listLeaderboards() as unknown as Record<string, Array<{ profileId: string | null }>>
    const boardNames = Object.keys(boards)
    assert(boardNames.length >= 4, `класации: ${boardNames.join(',')}`)
    for (const name of boardNames) {
      assert(!profileIdsOf(boards[name]).has(hidden.profileId), `класация ${name} съдържа скрития профил`)
    }
    assert(boardNames.some((name) => profileIdsOf(boards[name]).has(bob.profileId)), 'Bob липсва от всички класации')
  })

  await check('[V4] Предикатът отхвърля невалидна SQL колона (защита от инжекция)', () => {
    let threw = false
    try { sqlProfileVisibleForDeletion('p.profile_id; DROP TABLE profiles') } catch { threw = true }
    assert(threw, 'невалидна колона беше приета')
  })

  console.log('\n[U] Директни адреси към файлове')

  // Етап 3: аватарите НЕ се крият — изключенията (завършени турнири и
  // "Приключили" частни маси за 2 часа) показват аватара на участника.
  await check('[U1] Галерията на скрит профил е скрита; аватарът (изключения: турнири/частни маси) и чуждите файлове — не', () => {
    assertEqual(progressStore.isUploadPathHiddenForDeletion(hiddenGallery), true, 'галерия на скрит')
    assertEqual(progressStore.isUploadPathHiddenForDeletion(encodeURI(hiddenGallery)), true, 'кодиран път на галерия')
    assertEqual(progressStore.isUploadPathHiddenForDeletion(hiddenAvatar), false, 'аватар на скрит')
    assertEqual(progressStore.isUploadPathHiddenForDeletion(bobGallery), false, 'галерия на Bob')
    assertEqual(progressStore.isUploadPathHiddenForDeletion(sharedAvatar), false, 'аватар, споделен с видим профил')
    assertEqual(progressStore.isUploadPathHiddenForDeletion('/uploads/gift-items/x.webp'), false, 'подаръчна снимка')
  })

  console.log('\n[S] Сесия и вход')

  await check('[S1] Стара сесия на скрит профил е невалидна (getSession/touchSession); активните — валидни', () => {
    assertEqual(authStore.getSession(hidden.sessionToken), null, 'getSession на скрит')
    assertEqual(authStore.touchSession(hidden.sessionToken).session, null, 'touchSession на скрит')
    assert(authStore.getSession(alice.sessionToken) !== null, 'сесията на Alice е невалидна')
  })

  await check('[S2] Вход: вярна парола -> PROFILE_PENDING_DELETION без нова сесия; грешна парола -> общо съобщение', () => {
    const sessionsBefore = (db.prepare('SELECT COUNT(*) AS c FROM account_sessions WHERE profile_id = ?;').get(hidden.profileId) as { c: number }).c
    const result = authStore.login({ email: hidden.email, password: PASSWORD, rememberMe: true })
    assert(!result.ok && 'code' in result && result.code === 'PROFILE_PENDING_DELETION', `резултат: ${JSON.stringify(result)}`)
    if (!result.ok && 'message' in result) assertEqual(result.message, PROFILE_PENDING_DELETION_LOGIN_MESSAGE, 'съобщение')
    const sessionsAfter = (db.prepare('SELECT COUNT(*) AS c FROM account_sessions WHERE profile_id = ?;').get(hidden.profileId) as { c: number }).c
    assertEqual(sessionsAfter, sessionsBefore, 'създадена е сесия')
    const wrong = authStore.login({ email: hidden.email, password: 'wrong-password', rememberMe: true })
    const unknown = authStore.login({ email: 'nobody-vis@example.test', password: 'wrong-password', rememberMe: true })
    assertEqual(JSON.stringify(wrong), JSON.stringify(unknown), 'грешна парола издава състоянието на профила')
  })

  console.log('\n[F] Приятелства')

  await check('[F1] Списъкът на Alice не съдържа скрити приятели и покани; Bob остава', () => {
    const list = friendshipStore.listForProfile(alice.profileId)
    const all = [...list.friends, ...list.incomingPending, ...list.outgoingPending].map((r) => r.profile.profileId)
    for (const user of [hidden, requester, addressee]) {
      assert(!all.includes(user.profileId), `${user.displayName} е видим в списъка`)
    }
    assert(list.friends.some((r) => r.profile.profileId === bob.profileId), 'Bob липсва')
    assert(friendshipStore.getUnreadAcceptances(hidden.profileId).length >= 0, 'getUnreadAcceptances хвърли')
  })

  await check('[F2] Нова покана към скрит профил се отказва', () => {
    const fresh = registerUser('Fresh')
    const result = friendshipStore.sendRequest(fresh.profileId, hidden.profileId)
    assert(!result.ok, 'поканата беше приета')
    assertEqual(friendshipStore.isRegisteredHumanProfile(hidden.profileId), false, 'isRegisteredHumanProfile')
  })

  await check('[F3] accept/reject/cancel/remove/markAcceptanceRead върху ред със скрит контрагент не променят нищо', () => {
    const rowsBefore = [aliceHiddenFriendshipId, incoming.friendshipId, outgoing.friendshipId].map(friendshipRow)
    assert(!friendshipStore.acceptRequest(alice.profileId, incoming.friendshipId).ok, 'accept')
    assert(!friendshipStore.rejectRequest(alice.profileId, incoming.friendshipId).ok, 'reject')
    assert(!friendshipStore.cancelRequest(alice.profileId, outgoing.friendshipId).ok, 'cancel')
    assert(!friendshipStore.removeRelationship(alice.profileId, aliceHiddenFriendshipId).ok, 'remove')
    const mark = friendshipStore.markAcceptanceRead(alice.profileId, aliceHiddenFriendshipId)
    assert(!mark.ok, 'markAcceptanceRead')
    const rowsAfter = [aliceHiddenFriendshipId, incoming.friendshipId, outgoing.friendshipId].map(friendshipRow)
    assertEqual(JSON.stringify(rowsAfter), JSON.stringify(rowsBefore), 'редовете се промениха')
  })

  console.log('\n[C] Лични разговори')

  await check('[C1] Разговорът със скрития не се вижда в списъка на Alice; разговорът с Bob — да', () => {
    const ids = chatStore.listConversations(alice.profileId, undefined, true).map((c) => c.friendshipId)
    assert(!ids.includes(aliceHiddenFriendshipId), 'скритият разговор е видим')
    assert(ids.includes(aliceBobFriendshipId), 'разговорът с Bob липсва')
  })

  await check('[C2] Четене, писане, сваляне на файл и маркиране като прочетено са недостъпни за Alice', () => {
    assert(!chatStore.listMessages(alice.profileId, aliceHiddenFriendshipId).ok, 'listMessages')
    assert(!chatStore.sendMessage(alice.profileId, aliceHiddenFriendshipId, 'опит', null).ok, 'sendMessage')
    assert(!chatStore.canSendMessage(alice.profileId, aliceHiddenFriendshipId).ok, 'canSendMessage')
    assertEqual(chatStore.getAttachmentForDownload(alice.profileId, aliceHiddenFriendshipId, attachmentFilename), null, 'getAttachmentForDownload')
    const readMarker = () => (db.prepare('SELECT last_read_at FROM chat_conversation_reads WHERE profile_id = ? AND friendship_id = ?;').get(alice.profileId, aliceHiddenFriendshipId) as { last_read_at: string } | undefined)?.last_read_at ?? null
    const markerBefore = readMarker()
    chatStore.markConversationRead(alice.profileId, aliceHiddenFriendshipId)
    assertEqual(readMarker(), markerBefore, 'markConversationRead промени маркера')
  })

  await check('[C3] Съобщенията, прикаченият файл и файлът на диска са непокътнати; нищо не е в опашката за изтриване', async () => {
    const messages = (db.prepare('SELECT COUNT(*) AS c FROM friend_chat_messages WHERE friendship_id = ?;').get(aliceHiddenFriendshipId) as { c: number }).c
    assertEqual(messages, 3, 'брой съобщения')
    assert(db.prepare('SELECT 1 FROM friend_chat_attachments WHERE storage_filename = ?;').get(attachmentFilename) !== undefined, 'ред на прикачения файл')
    assertEqual((db.prepare('SELECT COUNT(*) AS c FROM friend_chat_attachment_deletions;').get() as { c: number }).c, 0, 'опашка за изтриване')
    assert((await stat(join(attachmentDir, attachmentFilename))).isFile(), 'файлът липсва')
  })

  console.log('\n[G] Подаръци')

  await check('[G1] Жълтици към скрит профил (директно и по приятелство) се отказват; балансите са непроменени', () => {
    const balance = (id: string) => (db.prepare('SELECT yellow_coins_balance AS b FROM profile_wallets WHERE profile_id = ?;').get(id) as { b: number }).b
    const before = [balance(alice.profileId), balance(hidden.profileId)]
    assert(!giftStore.sendGiftToProfile(alice.profileId, hidden.profileId, 100).ok, 'sendGiftToProfile')
    assert(!giftStore.sendGift(alice.profileId, aliceHiddenFriendshipId, 100).ok, 'sendGift по приятелство')
    assertEqual(JSON.stringify([balance(alice.profileId), balance(hidden.profileId)]), JSON.stringify(before), 'балансите')
  })

  console.log('\n[D] Цялост на данните')

  await check('[D1] Нито една таблица (извън profile_deletion_*) не е променена от скриването и отказаните действия', () => {
    const changed = diffSnapshots(snapshotBefore, snapshotDatabase())
    // registerUser('Fresh') в [F2] легитимно добавя профил/акаунт/сесия/посещения.
    const allowedByFreshUser = new Set(['accounts', 'profiles', 'profile_wallets', 'profile_progress', 'account_sessions', 'site_visitors', 'site_visit_events', 'visitor_registration_bindings', 'profile_visitor_links', 'registration_rate_limit_events'])
    const unexpected = changed.filter((table) => !allowedByFreshUser.has(table))
    assert(unexpected.length === 0, `променени таблици: ${unexpected.join(', ')}`)
    const freshOnlyAdded = (db.prepare('SELECT COUNT(*) AS c FROM profiles WHERE profile_id IN (?, ?, ?, ?, ?);').get(alice.profileId, bob.profileId, hidden.profileId, requester.profileId, addressee.profileId) as { c: number }).c
    assertEqual(freshOnlyAdded, 5, 'профилите от fixture-а')
  })

  console.log('\n[X] Отмяна и retention')

  for (const { requestId } of hiddenIds) cancelHide(requestId)

  await check('[X1] След отмяна: профил, списъци, класации, файлове и сесията са отново налични', () => {
    assertEqual(progressStore.getVisiblePublicProfile(hidden.profileId)?.profileId ?? null, hidden.profileId, 'видимост')
    assert(profileIdsOf(progressStore.listPublicHumanProfiles()).has(hidden.profileId), 'listPublicHumanProfiles')
    assertEqual(progressStore.isUploadPathHiddenForDeletion(hiddenGallery), false, 'галерия')
    assert(authStore.getSession(hidden.sessionToken) !== null, 'старата сесия не се възстанови')
    const login = authStore.login({ email: hidden.email, password: PASSWORD, rememberMe: true })
    assert(login.ok, `вход след отмяна: ${JSON.stringify(login)}`)
  })

  await check('[X2] След отмяна: приятелства, покани и разговорът с непроменен брой непрочетени се връщат', () => {
    const list = friendshipStore.listForProfile(alice.profileId)
    assert(list.friends.some((r) => r.profile.profileId === hidden.profileId), 'приятел')
    assert(list.incomingPending.some((r) => r.profile.profileId === requester.profileId), 'входяща покана')
    assert(list.outgoingPending.some((r) => r.profile.profileId === addressee.profileId), 'изходяща покана')
    const conversation = chatStore.listConversations(alice.profileId).find((c) => c.friendshipId === aliceHiddenFriendshipId)
    assert(conversation !== undefined, 'разговорът липсва')
    assertEqual(conversation?.unreadCount, unreadBefore, 'непрочетени')
    const messages = chatStore.listMessages(alice.profileId, aliceHiddenFriendshipId)
    assert(messages.ok && messages.messages.length === 3, 'съобщенията')
    assert(chatStore.getAttachmentForDownload(alice.profileId, aliceHiddenFriendshipId, attachmentFilename) !== null, 'прикачен файл')
  })

  await check('[X3] Retention продължава без изключения: изтекло развалено приятелство със скрит профил се изтрива', () => {
    const victim = registerUser('Victim')
    const other = registerUser('Other')
    const fid = makeFriends(victim, other)
    db.prepare(`UPDATE profile_friendships SET status = 'removed', removed_at = datetime('now', '-91 days') WHERE friendship_id = ?;`).run(fid)
    const requestId = hideProfile(victim)
    friendshipStore.runRetentionCleanup(500)
    assertEqual(db.prepare('SELECT 1 FROM profile_friendships WHERE friendship_id = ?;').get(fid), undefined, 'retention пропусна скрития профил')
    cancelHide(requestId)
  })

  console.log('\n[R] Регистрация — трите съобщения')

  const active = registerUser('Active')
  const pendingTarget = registerUser('Pending')
  const pendingRequestId = hideProfile(pendingTarget)

  for (const mode of ['direct', 'email_code'] as const) {
    const tag = mode === 'direct' ? 'Direct' : 'Code'
    await check(`[R1-${mode}] Зает имейл / заето име / и двете — точните три съобщения`, () => {
      registrationMode = mode
      const emailTaken = authStore.register({ email: active.email, password: PASSWORD, displayName: `FreshName${tag}A`, visitorId: randomUUID() })
      const nameTaken = authStore.register({ email: `fresh-${tag.toLowerCase()}-b@example.test`, password: PASSWORD, displayName: active.displayName, visitorId: randomUUID() })
      const bothTaken = authStore.register({ email: active.email, password: PASSWORD, displayName: active.displayName, visitorId: randomUUID() })
      assert(!emailTaken.ok && emailTaken.message === REGISTRATION_EMAIL_TAKEN_MESSAGE && emailTaken.code === 'EMAIL_TAKEN', `имейл: ${JSON.stringify(emailTaken)}`)
      assert(!nameTaken.ok && nameTaken.message === REGISTRATION_DISPLAY_NAME_TAKEN_MESSAGE && nameTaken.code === 'DISPLAY_NAME_TAKEN', `име: ${JSON.stringify(nameTaken)}`)
      assert(!bothTaken.ok && bothTaken.message === REGISTRATION_EMAIL_AND_DISPLAY_NAME_TAKEN_MESSAGE && bothTaken.code === 'EMAIL_AND_DISPLAY_NAME_TAKEN', `и двете: ${JSON.stringify(bothTaken)}`)
    })

    await check(`[R2-${mode}] Имейлът и името на чакащ изтриване профил са заети с ИДЕНТИЧНИ отговори като при активен`, () => {
      registrationMode = mode
      const cases: Array<[string, string, string, string]> = [
        ['имейл', pendingTarget.email, `OtherName${tag}C`, active.email],
        ['име', `fresh-${tag.toLowerCase()}-d@example.test`, pendingTarget.displayName, active.displayName],
        ['и двете', pendingTarget.email, pendingTarget.displayName, active.email],
      ]
      for (const [label, email, displayName] of cases) {
        const forPending = authStore.register({ email, password: PASSWORD, displayName, visitorId: randomUUID() })
        assert(!forPending.ok, `${label}: регистрацията мина`)
      }
      const pendingEmail = authStore.register({ email: pendingTarget.email, password: PASSWORD, displayName: `OtherName${tag}E`, visitorId: randomUUID() })
      const activeEmail = authStore.register({ email: active.email, password: PASSWORD, displayName: `OtherName${tag}F`, visitorId: randomUUID() })
      assertEqual(JSON.stringify(pendingEmail), JSON.stringify(activeEmail), 'имейл: различен отговор')
      const pendingName = authStore.register({ email: `fresh-${tag.toLowerCase()}-g@example.test`, password: PASSWORD, displayName: pendingTarget.displayName, visitorId: randomUUID() })
      const activeName = authStore.register({ email: `fresh-${tag.toLowerCase()}-h@example.test`, password: PASSWORD, displayName: active.displayName, visitorId: randomUUID() })
      assertEqual(JSON.stringify(pendingName), JSON.stringify(activeName), 'име: различен отговор')
      const pendingBoth = authStore.register({ email: pendingTarget.email, password: PASSWORD, displayName: pendingTarget.displayName, visitorId: randomUUID() })
      assertEqual(pendingBoth.ok ? '' : pendingBoth.message, REGISTRATION_EMAIL_AND_DISPLAY_NAME_TAKEN_MESSAGE, 'и двете')
    })
  }

  await check('[R3] Email verification: имейл зает при verify -> EMAIL_TAKEN; с displayNameAlsoTaken, ако и името е заето', () => {
    registrationMode = 'email_code'
    const pending = authStore.register({ email: 'verify-race@example.test', password: PASSWORD, displayName: 'VerifyRaceName', visitorId: randomUUID() })
    if (!pending.ok || pending.mode !== 'email_code') throw new Error(`pending: ${JSON.stringify(pending)}`)
    // Конкурентен акаунт със същия имейл (вмъкнат директно — нормалните пътища го забраняват).
    db.prepare(`INSERT INTO accounts (account_id, email, password_hash) VALUES (?, 'verify-race@example.test', 'x');`).run(randomUUID())
    const emailOnly = authStore.verifyRegistrationEmail({ pendingRegistrationId: pending.pendingRegistrationId, code: pending.rawCode, rememberMe: true, ipAddress: null, userAgent: null })
    assert(!emailOnly.ok && emailOnly.reason === 'email_taken' && emailOnly.displayNameAlsoTaken === false, `само имейл: ${JSON.stringify(emailOnly)}`)
    db.prepare(`
      INSERT INTO profiles (profile_id, display_name, normalized_display_name, username, normalized_username)
      VALUES (?, 'VerifyRaceName', 'verifyracename', 'verifyracename', 'verifyracename');
    `).run(randomUUID())
    const both = authStore.verifyRegistrationEmail({ pendingRegistrationId: pending.pendingRegistrationId, code: pending.rawCode, rememberMe: true, ipAddress: null, userAgent: null })
    assert(!both.ok && both.reason === 'email_taken' && both.displayNameAlsoTaken === true, `и двете: ${JSON.stringify(both)}`)
  })

  await check('[R4] Името на профил с нестандартен статус също е заето (съвпада с UNIQUE индекса)', () => {
    registrationMode = 'direct'
    db.prepare(`
      INSERT INTO profiles (profile_id, profile_kind, display_name, normalized_display_name, status)
      VALUES (?, 'bot', 'DisabledBotName', 'disabledbotname', 'disabled');
    `).run(randomUUID())
    const result = authStore.register({ email: 'disabled-name@example.test', password: PASSWORD, displayName: 'DisabledBotName', visitorId: randomUUID() })
    assert(!result.ok && result.code === 'DISPLAY_NAME_TAKEN' && result.message === REGISTRATION_DISPLAY_NAME_TAKEN_MESSAGE, JSON.stringify(result))
  })

  cancelHide(pendingRequestId)

  await check('[Z] integrity_check=ok, foreign_key_check празен', () => {
    assertEqual((db.prepare('PRAGMA integrity_check;').get() as { integrity_check: string }).integrity_check, 'ok', 'integrity_check')
    assertEqual(db.prepare('PRAGMA foreign_key_check;').all().length, 0, 'foreign_key_check')
  })
} finally {
  for (const store of [giftStore, adminSettingsStore, chatStore, blockStore, friendshipStore, authStore, progressStore] as Array<{ close: () => void }>) {
    try { store.close() } catch { /* ignore */ }
  }
  db.close()
  await rm(root, { recursive: true, force: true }).catch(() => {})
}

console.log('\n' + '═'.repeat(64))
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
