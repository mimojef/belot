/**
 * checkProfileDeletionRequestStore.ts
 *
 * Самоизтриване на профили — Етап 3, проверки на ниво store върху
 * ИЗОЛИРАНА temp база с всички реални миграции (ensureServerDatabaseReady()).
 * Никога реалната база.
 *
 * [Q] Подаване: валидна заявка, 30 дни, журнал, дублиране, конкурентност,
 *     недопустими профили.
 * [K] Токени за отмяна: само хеш, еднократност, изтичане, замяна,
 *     "остави заявката активна", отмяна, конкурентна отмяна, граници на срока.
 * [M] Миграция 20261025_001: тригери и инварианти на токените.
 * [G] Активни игри в персистираните snapshot-и (Белот / Не се сърди човече).
 * [GS] Липсваща схема на Свара: стартът не се срива, подаването е fail-closed.
 * [L] Вход: PROFILE_PENDING_DELETION, бан + заявка, rate limit на неуспешни
 *     опити, проверка на паролата, основен профил при няколко профила.
 * [P] Rate limit, журнал за realtime, контрагенти.
 * [D] Данните на профила не се променят от подаване + отмяна.
 */

import { createHash, randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'
import { createPlayerProgressStore } from '../src/db/playerProgressStore.js'
import { createAuthStore, LOGIN_RATE_LIMITED_MESSAGE, PROFILE_PENDING_DELETION_LOGIN_MESSAGE } from '../src/db/authStore.js'
import { createProfileBanStore } from '../src/db/profileBanStore.js'
import { createProfileDeletionRequestStore, PROFILE_DELETION_RESTORE_TOKEN_TTL_MS } from '../src/db/profileDeletionRequestStore.js'
import { createProfileDeletionExecutor } from '../src/db/profileDeletionExecutor.js'
import { PROFILE_DELETION_GRACE_PERIOD_MS } from '../src/db/profileDeletionSchedule.js'

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
const SECRET = 'profile-deletion-request-store-test-secret-0123456789'
const PASSWORD = 'secret123'

console.log('\ncheckProfileDeletionRequestStore')
console.log(`Server root: ${sourceServerRoot}`)

const root = await mkdtemp(join(tmpdir(), 'belot-profile-deletion-request-'))
await mkdir(join(root, 'database', 'migrations'), { recursive: true })
await mkdir(join(root, 'database', 'data'), { recursive: true })
for (const entry of await readdir(join(sourceServerRoot, 'database', 'migrations'), { withFileTypes: true })) {
  if (entry.isFile() && extname(entry.name).toLowerCase() === '.sql') {
    await cp(join(sourceServerRoot, 'database', 'migrations', entry.name), join(root, 'database', 'migrations', entry.name))
  }
}
const { databaseFilePath } = await ensureServerDatabaseReady({ serverRootOverride: root })

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
const store = await createProfileDeletionRequestStore(databaseFilePath, { rateLimitSecret: SECRET })
const store2 = await createProfileDeletionRequestStore(databaseFilePath, { rateLimitSecret: SECRET }) // втори процес

type User = { profileId: string; accountId: string; email: string; displayName: string }
let counter = 0
function registerUser(label: string): User {
  counter += 1
  const email = `req-${label.toLowerCase()}-${counter}@example.test`
  const displayName = `Req${label}${counter}`
  const result = authStore.register({ email, password: PASSWORD, displayName, gender: 'male', visitorId: randomUUID() })
  if (!result.ok || result.mode !== 'direct') throw new Error(`регистрация: ${JSON.stringify(result)}`)
  return { profileId: result.session.profile.profileId as string, accountId: result.session.account.accountId, email, displayName }
}

function dbNow(): string {
  return (db.prepare(`SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now;`).get() as { now: string }).now
}

function withTriggerDropped<T>(name: string, fn: () => T): T {
  const sql = (db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?;`).get(name) as { sql: string }).sql
  db.exec(`DROP TRIGGER ${name};`)
  try { return fn() } finally { db.exec(sql) }
}

/** Fixture: заявка с requested_at назад във времето (insert guard-ът нормално го забранява). */
function insertBackdatedRequest(user: User, scheduledForIso: string): string {
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

function requestRow(requestId: string): Record<string, unknown> {
  return db.prepare('SELECT * FROM profile_deletion_requests WHERE request_id = ?;').get(requestId) as Record<string, unknown>
}

function snapshotTables(exclude: (name: string) => boolean): string {
  const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name;`).all() as Array<{ name: string }>)
    .map((row) => row.name).filter((name) => !exclude(name))
  return tables.map((table) => `${table}:${createHash('sha256').update(db.prepare(`SELECT * FROM "${table}";`).all().map((row) => JSON.stringify(row)).sort().join('\n')).digest('hex')}`).join('|')
}

try {
  console.log('\n[Q] Подаване')

  await check('[Q1] Валидна заявка: pending, точно 30 × 24 ч в UTC, събитие requested (actor user) с върнат event_seq', () => {
    const user = registerUser('Valid')
    const result = store.createRequest({ profileId: user.profileId, accountId: user.accountId })
    assert(result.ok, JSON.stringify(result))
    if (!result.ok) return
    const row = requestRow(result.request.requestId)
    assertEqual(row.status, 'pending', 'status')
    assertEqual(Date.parse(String(row.scheduled_for)) - Date.parse(String(row.requested_at)), PROFILE_DELETION_GRACE_PERIOD_MS, '30 дни')
    assert(String(row.requested_at).endsWith('Z'), 'UTC')
    const event = db.prepare('SELECT event_seq, event_type, actor_kind FROM profile_deletion_events WHERE request_id = ?;').get(result.request.requestId) as { event_seq: number; event_type: string; actor_kind: string }
    assertEqual(event.event_type, 'requested', 'event_type')
    assertEqual(event.actor_kind, 'user', 'actor_kind')
    assertEqual(event.event_seq, result.eventSeq, 'eventSeq')
    assertEqual(store.getPendingRequest(user.profileId)?.requestId ?? null, result.request.requestId, 'getPendingRequest')
  })

  await check('[Q2] Дублирана заявка -> already_pending', () => {
    const user = registerUser('Dup')
    assert(store.createRequest({ profileId: user.profileId, accountId: user.accountId }).ok, 'първа')
    const second = store.createRequest({ profileId: user.profileId, accountId: user.accountId })
    assert(!second.ok && second.code === 'already_pending', JSON.stringify(second))
  })

  await check('[Q3] Едновременни заявки от два процеса за един профил: точно една успява', () => {
    const user = registerUser('Race')
    const results = [store, store2].map((s) => s.createRequest({ profileId: user.profileId, accountId: user.accountId }))
    assertEqual(results.filter((r) => r.ok).length, 1, 'успешни')
    assertEqual((db.prepare('SELECT COUNT(*) AS c FROM profile_deletion_requests WHERE profile_id = ?;').get(user.profileId) as { c: number }).c, 1, 'редове')
  })

  await check('[Q4] Чужд акаунт, бот и временен профил -> profile_not_eligible', () => {
    const user = registerUser('Elig')
    const other = registerUser('Other')
    const wrongAccount = store.createRequest({ profileId: user.profileId, accountId: other.accountId })
    assert(!wrongAccount.ok && wrongAccount.code === 'profile_not_eligible', 'чужд акаунт')
    const missing = store.createRequest({ profileId: randomUUID(), accountId: user.accountId })
    assert(!missing.ok && missing.code === 'profile_not_eligible', 'несъществуващ профил')
    db.prepare(`UPDATE profiles SET is_temporary = 1 WHERE profile_id = ?;`).run(other.profileId)
    const temporary = store.createRequest({ profileId: other.profileId, accountId: other.accountId })
    assert(!temporary.ok && temporary.code === 'profile_not_eligible', 'временен')
    db.prepare(`UPDATE profiles SET is_temporary = 0 WHERE profile_id = ?;`).run(other.profileId)
  })

  console.log('\n[K] Токени за отмяна')

  await check('[K1] Токенът е 32 случайни байта (base64url); в базата е само SHA-256 хешът; валидност 10 мин', () => {
    const user = registerUser('Tok')
    store.createRequest({ profileId: user.profileId, accountId: user.accountId })
    const issued = store.issueRestoreToken(user.profileId)
    assert(issued.ok, JSON.stringify(issued))
    if (!issued.ok) return
    assert(/^[A-Za-z0-9_-]{43}$/.test(issued.restoreToken), 'формат')
    const rows = db.prepare('SELECT * FROM profile_deletion_restore_tokens WHERE profile_id = ?;').all(user.profileId) as Array<Record<string, unknown>>
    assertEqual(rows.length, 1, 'редове')
    assertEqual(rows[0].token_hash, createHash('sha256').update(issued.restoreToken).digest('hex'), 'хеш')
    assert(!JSON.stringify(db.prepare('SELECT * FROM profile_deletion_restore_tokens;').all()).includes(issued.restoreToken), 'суровият токен е записан')
    const ttl = Date.parse(issued.expiresAt) - Date.parse(String(rows[0].created_at))
    assert(Math.abs(ttl - PROFILE_DELETION_RESTORE_TOKEN_TTL_MS) < 2000, `TTL ${ttl}`)
  })

  await check('[K2] Нов токен за същата заявка обезсилва предишния (superseded)', () => {
    const user = registerUser('Super')
    store.createRequest({ profileId: user.profileId, accountId: user.accountId })
    const first = store.issueRestoreToken(user.profileId)
    const second = store.issueRestoreToken(user.profileId)
    assert(first.ok && second.ok, 'издаване')
    if (!first.ok || !second.ok) return
    const firstCancel = store.cancelWithToken(first.restoreToken)
    assert(!firstCancel.ok && firstCancel.code === 'invalid_token', 'старият токен работи')
    assert(store.keepWithToken(second.restoreToken).ok, 'новият токен не работи')
  })

  await check('[K3] "Остави заявката активна": токенът се обезсилва, заявката остава pending, повторна употреба се отказва', () => {
    const user = registerUser('Keep')
    const created = store.createRequest({ profileId: user.profileId, accountId: user.accountId })
    const issued = store.issueRestoreToken(user.profileId)
    assert(created.ok && issued.ok, 'fixture')
    if (!created.ok || !issued.ok) return
    assert(store.keepWithToken(issued.restoreToken).ok, 'keep')
    assertEqual(requestRow(created.request.requestId).status, 'pending', 'status')
    assert(!store.keepWithToken(issued.restoreToken).ok, 'повторен keep')
    assert(!store.cancelWithToken(issued.restoreToken).ok, 'cancel със запазен токен')
  })

  await check('[K4] Отмяна: cancelled, токенът consumed (cancelled), събитие cancelled; повторна употреба и други токени — невалидни', () => {
    const user = registerUser('Cancel')
    const created = store.createRequest({ profileId: user.profileId, accountId: user.accountId })
    const issued = store.issueRestoreToken(user.profileId)
    assert(created.ok && issued.ok, 'fixture')
    if (!created.ok || !issued.ok) return
    const cancelled = store.cancelWithToken(issued.restoreToken)
    assert(cancelled.ok, JSON.stringify(cancelled))
    const row = requestRow(created.request.requestId)
    assertEqual(row.status, 'cancelled', 'status')
    assert(row.cancelled_at !== null, 'cancelled_at')
    const token = db.prepare('SELECT consumed_reason FROM profile_deletion_restore_tokens WHERE request_id = ?;').get(created.request.requestId) as { consumed_reason: string }
    assertEqual(token.consumed_reason, 'cancelled', 'consumed_reason')
    const events = (db.prepare('SELECT event_type FROM profile_deletion_events WHERE request_id = ? ORDER BY event_seq;').all(created.request.requestId) as Array<{ event_type: string }>).map((e) => e.event_type)
    assertEqual(events.join(','), 'requested,cancelled', 'журнал')
    assert(!store.cancelWithToken(issued.restoreToken).ok, 'повторна отмяна')
    assertEqual(store.getPendingRequest(user.profileId), null, 'pending след отмяна')
    // След отмяна може нова заявка (нов цикъл).
    assert(store.createRequest({ profileId: user.profileId, accountId: user.accountId }).ok, 'нова заявка след отмяна')
  })

  await check('[K5] Невалидни токени (формат, случаен, празен) -> invalid_token', () => {
    for (const bad of ['', 'short', 'x'.repeat(43), '../../etc/passwd'.padEnd(43, 'a'), randomUUID()]) {
      const result = store.cancelWithToken(bad)
      assert(!result.ok && result.code === 'invalid_token', `токен ${JSON.stringify(bad)}`)
    }
  })

  await check('[K6] Изтекъл токен -> invalid_token', () => {
    const user = registerUser('Expired')
    const created = store.createRequest({ profileId: user.profileId, accountId: user.accountId })
    assert(created.ok, 'fixture')
    if (!created.ok) return
    const raw = 'E'.repeat(43)
    withTriggerDropped('trg_profile_deletion_restore_tokens_insert_guard', () => {
      db.prepare(`INSERT INTO profile_deletion_restore_tokens (token_hash, request_id, profile_id, expires_at) VALUES (?, ?, ?, ?);`)
        .run(createHash('sha256').update(raw).digest('hex'), created.request.requestId, user.profileId, new Date(Date.now() - 1000).toISOString())
    })
    const result = store.cancelWithToken(raw)
    assert(!result.ok && result.code === 'invalid_token', JSON.stringify(result))
    assertEqual(requestRow(created.request.requestId).status, 'pending', 'status')
  })

  await check('[K7] Конкурентна отмяна от два процеса с един токен: точно една успява', () => {
    const user = registerUser('ConcCancel')
    store.createRequest({ profileId: user.profileId, accountId: user.accountId })
    const issued = store.issueRestoreToken(user.profileId)
    assert(issued.ok, 'fixture')
    if (!issued.ok) return
    const results = [store, store2].map((s) => s.cancelWithToken(issued.restoreToken))
    assertEqual(results.filter((r) => r.ok).length, 1, 'успешни')
  })

  await check('[K8] Отмяна 30 секунди преди края на срока — успешна', () => {
    const user = registerUser('Before')
    const requestId = insertBackdatedRequest(user, new Date(Date.parse(dbNow()) + 30_000).toISOString())
    const issued = store.issueRestoreToken(user.profileId)
    assert(issued.ok, JSON.stringify(issued))
    if (!issued.ok) return
    assert(store.cancelWithToken(issued.restoreToken).ok, 'отмяна')
    assertEqual(requestRow(requestId).status, 'cancelled', 'status')
  })

  await check('[K9] Точно в края на срока: токен не се издава; издаден преди края токен се отказва след него (window_closed)', async () => {
    const atDeadline = registerUser('AtDeadline')
    insertBackdatedRequest(atDeadline, dbNow())
    const none = store.issueRestoreToken(atDeadline.profileId)
    assert(!none.ok && none.code === 'no_pending_request', 'токен на границата')

    const crossing = registerUser('Crossing')
    const requestId = insertBackdatedRequest(crossing, new Date(Date.parse(dbNow()) + 1500).toISOString())
    const issued = store.issueRestoreToken(crossing.profileId)
    assert(issued.ok, 'издаване преди края')
    if (!issued.ok) return
    await new Promise((r) => setTimeout(r, 2200))
    const late = store.cancelWithToken(issued.restoreToken)
    assert(!late.ok && late.code === 'window_closed', JSON.stringify(late))
    assertEqual(requestRow(requestId).status, 'pending', 'статусът не е променен')
  })

  console.log('\n[M] Инварианти на токените (миграция 20261025_001)')

  await check('[M1] Токен не може да се създаде за непозната/не-pending заявка, с минала или >15 мин валидност, или като вече използван', () => {
    const user = registerUser('Mig')
    const created = store.createRequest({ profileId: user.profileId, accountId: user.accountId })
    assert(created.ok, 'fixture')
    if (!created.ok) return
    const hash = () => createHash('sha256').update(randomUUID()).digest('hex')
    const soon = new Date(Date.parse(dbNow()) + 60_000).toISOString()
    assertRejects(() => db.prepare('INSERT INTO profile_deletion_restore_tokens (token_hash, request_id, profile_id, expires_at) VALUES (?, ?, ?, ?);').run(hash(), randomUUID(), user.profileId, soon), 'profile_deletion_restore_token_request_not_pending', 'непозната заявка')
    assertRejects(() => db.prepare('INSERT INTO profile_deletion_restore_tokens (token_hash, request_id, profile_id, expires_at) VALUES (?, ?, ?, ?);').run(hash(), created.request.requestId, randomUUID(), soon), 'profile_deletion_restore_token_request_not_pending', 'чужд профил')
    assertRejects(() => db.prepare('INSERT INTO profile_deletion_restore_tokens (token_hash, request_id, profile_id, expires_at) VALUES (?, ?, ?, ?);').run(hash(), created.request.requestId, user.profileId, new Date(Date.parse(dbNow()) + 20 * 60_000).toISOString()), 'profile_deletion_restore_token_invalid_expiry', '>15 мин')
    assertRejects(() => db.prepare(`INSERT INTO profile_deletion_restore_tokens (token_hash, request_id, profile_id, expires_at, consumed_at, consumed_reason) VALUES (?, ?, ?, ?, ?, 'kept');`).run(hash(), created.request.requestId, user.profileId, soon, dbNow()), 'profile_deletion_restore_token_must_start_unused', 'вече използван')
    assertRejects(() => db.prepare('INSERT INTO profile_deletion_restore_tokens (token_hash, request_id, profile_id, expires_at) VALUES (?, ?, ?, ?);').run('NOT-A-HASH', created.request.requestId, user.profileId, soon), 'CHECK constraint failed', 'формат на хеша')
  })

  await check('[M2] Използван токен е неизменим; редове не се трият; заявка извън pending затваря всички токени', () => {
    const user = registerUser('Imm')
    const created = store.createRequest({ profileId: user.profileId, accountId: user.accountId })
    const issued = store.issueRestoreToken(user.profileId)
    assert(created.ok && issued.ok, 'fixture')
    if (!created.ok || !issued.ok) return
    const tokenHash = createHash('sha256').update(issued.restoreToken).digest('hex')
    assertRejects(() => db.prepare('DELETE FROM profile_deletion_restore_tokens WHERE token_hash = ?;').run(tokenHash), 'profile_deletion_restore_token_no_delete', 'DELETE')
    assertRejects(() => db.prepare(`UPDATE profile_deletion_restore_tokens SET expires_at = ? WHERE token_hash = ?;`).run(dbNow(), tokenHash), 'profile_deletion_restore_token_immutable', 'смяна на expires_at')
    db.prepare(`UPDATE profile_deletion_requests SET status = 'cancelled', cancelled_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE request_id = ?;`).run(created.request.requestId)
    const token = db.prepare('SELECT consumed_reason FROM profile_deletion_restore_tokens WHERE token_hash = ?;').get(tokenHash) as { consumed_reason: string }
    assertEqual(token.consumed_reason, 'request_closed', 'автоматично затваряне')
    assertRejects(() => db.prepare(`UPDATE profile_deletion_restore_tokens SET consumed_reason = 'kept' WHERE token_hash = ?;`).run(tokenHash), 'profile_deletion_restore_token_immutable', 'промяна на consumed_reason')
  })

  console.log('\n[G] Активни игри в snapshot-ите')

  // snapshot_json има CHECK json_valid — нечетим JSON не може да се запише;
  // при грешка в парсването проверката е fail-closed (true).
  await check('[G1] Белот: playing стая с човешки участник -> активна; напуснал / waiting / неактивен snapshot / чужда форма -> не', () => {
    const user = registerUser('Belot')
    const room = (participant: Record<string, unknown>, status = 'playing') => JSON.stringify({ status, seats: { bottom: { participant }, top: { participant: null } } })
    const insert = (json: string, roomStatus = 'playing', isActive = 1) => db.prepare(`
      INSERT INTO active_room_snapshots (room_id, snapshot_version, room_status, state_version, snapshot_json, is_active) VALUES (?, 1, ?, 1, ?, ?);
    `).run(randomUUID(), roomStatus, json, isActive)
    assertEqual(store.hasActiveGameSnapshot(user.profileId), false, 'без snapshot')
    insert(room({ kind: 'human', identity: { profileId: user.profileId }, permanentlyLeftAt: Date.now() }))
    insert(room({ kind: 'human', identity: { profileId: user.profileId } }, 'waiting'), 'waiting')
    insert(room({ kind: 'human', identity: { profileId: user.profileId } }), 'playing', 0)
    assertEqual(store.hasActiveGameSnapshot(user.profileId), false, 'напуснал/waiting/неактивен')
    insert(room({ kind: 'human', identity: { profileId: user.profileId }, permanentlyLeftAt: null }))
    assertEqual(store.hasActiveGameSnapshot(user.profileId), true, 'активен участник')
    const broken = registerUser('Broken')
    db.prepare(`INSERT INTO active_room_snapshots (room_id, snapshot_version, room_status, state_version, snapshot_json, is_active) VALUES (?, 1, 'playing', 1, ?, 1);`)
      .run(randomUUID(), JSON.stringify({ status: 'playing', seats: `"${broken.profileId}"-not-an-object` }))
    assertEqual(store.hasActiveGameSnapshot(broken.profileId), false, 'seats не е обект — участник не е намерен')
  })

  await check('[G2] Не се сърди човече: in_progress мач с играча -> активен; finished -> не', () => {
    const user = registerUser('Ludo')
    const insert = (status: string) => db.prepare(`
      INSERT INTO active_ludo_match_snapshots (match_id, snapshot_version, ludo_room_id, match_status, revision, snapshot_json, is_active) VALUES (?, 1, ?, ?, 1, ?, 1);
    `).run(randomUUID(), randomUUID(), status, JSON.stringify({ players: [{ profileId: user.profileId }, { profileId: randomUUID() }] }))
    insert('finished')
    assertEqual(store.hasActiveGameSnapshot(user.profileId), false, 'finished')
    insert('in_progress')
    assertEqual(store.hasActiveGameSnapshot(user.profileId), true, 'in_progress')
  })

  console.log('\n[L] Вход')

  await check('[L1] Вярна парола + активна заявка -> PROFILE_PENDING_DELETION (profileId, isBanned=false), без нова сесия', () => {
    const user = registerUser('Login')
    store.createRequest({ profileId: user.profileId, accountId: user.accountId })
    const sessionsBefore = (db.prepare('SELECT COUNT(*) AS c FROM account_sessions WHERE profile_id = ?;').get(user.profileId) as { c: number }).c
    const result = authStore.login({ email: user.email, password: PASSWORD, rememberMe: true })
    assert(!result.ok && 'code' in result && result.code === 'PROFILE_PENDING_DELETION', JSON.stringify(result))
    if (!result.ok && 'code' in result && result.code === 'PROFILE_PENDING_DELETION') {
      assertEqual(result.profileId, user.profileId, 'profileId')
      assertEqual(result.isBanned, false, 'isBanned')
      assertEqual(result.message, PROFILE_PENDING_DELETION_LOGIN_MESSAGE, 'message')
    }
    assertEqual((db.prepare('SELECT COUNT(*) AS c FROM account_sessions WHERE profile_id = ?;').get(user.profileId) as { c: number }).c, sessionsBefore, 'сесии')
  })

  await check('[L2] Бан + заявка: собственикът получава PROFILE_PENDING_DELETION (isBanned=true); след отмяна банът остава', () => {
    const user = registerUser('Banned')
    const admin = registerUser('BanAdmin')
    store.createRequest({ profileId: user.profileId, accountId: user.accountId })
    assert(banStore.banProfile({ targetProfileId: user.profileId, actorProfileId: admin.profileId, days: 5, reason: 'тест' }).ok, 'бан')
    const pending = authStore.login({ email: user.email, password: PASSWORD, rememberMe: true })
    assert(!pending.ok && 'code' in pending && pending.code === 'PROFILE_PENDING_DELETION' && pending.isBanned === true, JSON.stringify(pending))
    const issued = store.issueRestoreToken(user.profileId)
    assert(issued.ok && store.cancelWithToken(issued.restoreToken).ok, 'отмяна')
    const after = authStore.login({ email: user.email, password: PASSWORD, rememberMe: true })
    assert(!after.ok && 'code' in after && after.code === 'PROFILE_BANNED', JSON.stringify(after))
    assert(banStore.getActiveBan(user.profileId) !== null, 'банът е премахнат')
  })

  await check('[L3] Rate limit: 10 грешни пароли -> 11-ият опит (дори с вярна парола) е LOGIN_RATE_LIMITED; еднакво за несъществуващ имейл; друг имейл не е засегнат', () => {
    const user = registerUser('Brute')
    const control = registerUser('Control')
    for (let i = 0; i < 10; i++) {
      const wrong = authStore.login({ email: user.email, password: 'wrong-pass', rememberMe: true })
      assert(!wrong.ok && !('code' in wrong), `опит ${i + 1}: ${JSON.stringify(wrong)}`)
      authStore.login({ email: 'ghost-brute@example.test', password: 'wrong-pass', rememberMe: true })
    }
    const limited = authStore.login({ email: user.email, password: PASSWORD, rememberMe: true })
    assert(!limited.ok && 'code' in limited && limited.code === 'LOGIN_RATE_LIMITED' && limited.message === LOGIN_RATE_LIMITED_MESSAGE, JSON.stringify(limited))
    const ghost = authStore.login({ email: 'ghost-brute@example.test', password: 'wrong-pass', rememberMe: true })
    assertEqual(JSON.stringify(ghost), JSON.stringify(limited), 'несъществуващ имейл — различен отговор')
    assert(authStore.login({ email: control.email, password: PASSWORD, rememberMe: true }).ok, 'друг акаунт е блокиран')
  })

  await check('[L4] Успешните входове не се броят за rate limit-а', () => {
    const user = registerUser('Normal')
    for (let i = 0; i < 15; i++) {
      assert(authStore.login({ email: user.email, password: PASSWORD, rememberMe: true }).ok, `вход ${i + 1}`)
    }
  })

  await check('[L5] verifyAccountPassword: вярна/грешна/празна', () => {
    const user = registerUser('Verify')
    assert(authStore.verifyAccountPassword(user.accountId, PASSWORD), 'вярна')
    assert(!authStore.verifyAccountPassword(user.accountId, 'wrong'), 'грешна')
    assert(!authStore.verifyAccountPassword(user.accountId, ''), 'празна')
    assert(!authStore.verifyAccountPassword(randomUUID(), PASSWORD), 'непознат акаунт')
  })

  await check('[L6] Няколко профила на един акаунт: основният е най-старият; заявка за втория профил не засяга входа в основния', () => {
    const user = registerUser('Multi')
    const secondaryId = randomUUID()
    db.prepare(`
      INSERT INTO profiles (profile_id, account_id, display_name, normalized_display_name, created_at)
      VALUES (?, ?, 'MultiSecond', 'multisecond', datetime('now', '+1 minute'));
    `).run(secondaryId, user.accountId)
    assertEqual(authStore.getPrimaryHumanProfileIdForAccount(user.accountId), user.profileId, 'основен профил')
    const created = store.createRequest({ profileId: secondaryId, accountId: user.accountId })
    assert(created.ok, 'заявка за втория профил (на ниво store)')
    const login = authStore.login({ email: user.email, password: PASSWORD, rememberMe: true })
    assert(login.ok && login.session.profile.profileId === user.profileId, 'входът в основния профил е засегнат')
  })

  console.log('\n[P] Rate limit, realtime журнал, контрагенти')

  await check('[P1] Rate limit на store-а: 3 опита, 4-тият е ограничен; друг субект не е; без secret -> fail-closed', async () => {
    const input = { scope: 'test-scope', subject: 'subject-a', windowSeconds: 3600, maxEvents: 3 }
    for (let i = 0; i < 3; i++) assert(!store.isRateLimited(input), `опит ${i + 1}`)
    assert(store.isRateLimited(input), '4-ти опит')
    assert(!store.isRateLimited({ ...input, subject: 'subject-b' }), 'друг субект')
    const noSecret = await createProfileDeletionRequestStore(databaseFilePath, { rateLimitSecret: '' })
    try {
      assert(noSecret.isRateLimited({ ...input, subject: 'subject-c' }), 'без secret')
    } finally {
      noSecret.close()
    }
  })

  await check('[P2] Журнал за realtime: requested/cancelled по ред; getMaxEventSeq', () => {
    const user = registerUser('Events')
    const from = store.getMaxEventSeq()
    const created = store.createRequest({ profileId: user.profileId, accountId: user.accountId })
    const issued = store.issueRestoreToken(user.profileId)
    assert(created.ok && issued.ok && store.cancelWithToken(issued.restoreToken).ok, 'fixture')
    const events = store2.listVisibilityEventsAfter(from, 100).filter((e) => e.profileId === user.profileId)
    assertEqual(events.map((e) => e.eventType).join(','), 'requested,cancelled', 'събития')
    assert(store.getMaxEventSeq() >= events[1].eventSeq, 'max seq')
  })

  await check('[P3] Контрагенти: всички редове в profile_friendships (приети и чакащи)', () => {
    const a = registerUser('CpA')
    const b = registerUser('CpB')
    const c = registerUser('CpC')
    const pair = (x: User, y: User, status: string) => {
      const [lower, higher] = [x.profileId, y.profileId].sort()
      db.prepare(`INSERT INTO profile_friendships (friendship_id, requester_profile_id, addressee_profile_id, lower_profile_id, higher_profile_id, status) VALUES (?, ?, ?, ?, ?, ?);`)
        .run(randomUUID(), x.profileId, y.profileId, lower, higher, status)
    }
    pair(a, b, 'accepted')
    pair(c, a, 'pending')
    assertEqual(store.listRelationshipCounterpartIds(a.profileId).sort().join(','), [b.profileId, c.profileId].sort().join(','), 'контрагенти')
  })

  console.log('\n[GS] Липсваща схема на Свара (svara_match_snapshots)')

  await check('[GS1] Без svara_match_snapshots: store и executor се създават (стартът не се срива); подаването е fail-closed; след възстановяване на таблицата — нормално', async () => {
    const user = registerUser('NoSvara')
    const copyPath = join(root, 'no-svara.sqlite')
    db.exec(`VACUUM INTO '${copyPath.replace(/'/g, "''")}';`)
    const copy: SqliteDatabase = new sqliteModule.DatabaseSync(copyPath, { open: true, enableForeignKeyConstraints: true })
    const schema = copy.prepare(`SELECT type, sql FROM sqlite_master WHERE tbl_name = 'svara_match_snapshots' AND sql IS NOT NULL ORDER BY type = 'table' DESC;`).all() as Array<{ type: string; sql: string }>
    assert(schema.length > 0 && schema[0].type === 'table', 'схемата на Свара липсва още преди теста')
    copy.exec('DROP TABLE svara_match_snapshots;')
    const copyStore = await createProfileDeletionRequestStore(copyPath, { rateLimitSecret: SECRET })
    const copyExecutor = await createProfileDeletionExecutor(copyPath)
    try {
      assertEqual(copyStore.hasActiveGameSnapshot(user.profileId), true, 'без таблицата — "има активна игра" (fail-closed)')
      const refused = copyStore.createRequest({ profileId: user.profileId, accountId: user.accountId })
      assert(!refused.ok && refused.code === 'active_participation', `очакван отказ active_participation, получено ${JSON.stringify(refused)}`)
      assertEqual((copy.prepare('SELECT COUNT(*) AS cnt FROM profile_deletion_requests WHERE profile_id = ?;').get(user.profileId) as { cnt: number }).cnt, 0, 'не е създадена заявка')
      // Неуспешната подготовка не се кешира: таблицата се появява отново.
      for (const entry of schema) copy.exec(entry.sql)
      assertEqual(copyStore.hasActiveGameSnapshot(user.profileId), false, 'с таблицата — няма активна игра')
      const accepted = copyStore.createRequest({ profileId: user.profileId, accountId: user.accountId })
      assert(accepted.ok, `след възстановяване подаването минава: ${JSON.stringify(accepted)}`)
    } finally {
      copyExecutor.close()
      copyStore.close()
      copy.close()
    }
  })

  console.log('\n[D] Цялост на данните')

  await check('[D1] Подаване + токен + отмяна не променят нито една таблица извън заявките/журнала/токените/rate limit', () => {
    const user = registerUser('Integrity')
    const exclude = (name: string) => name.startsWith('profile_deletion_') || name === 'registration_rate_limit_events'
    const before = snapshotTables(exclude)
    store.createRequest({ profileId: user.profileId, accountId: user.accountId })
    const issued = store.issueRestoreToken(user.profileId)
    assert(issued.ok, 'токен')
    if (!issued.ok) return
    store.keepWithToken(issued.restoreToken)
    const second = store.issueRestoreToken(user.profileId)
    assert(second.ok && store.cancelWithToken(second.restoreToken).ok, 'отмяна')
    assertEqual(snapshotTables(exclude), before, 'променени таблици')
  })

  await check('[Z] integrity_check=ok, foreign_key_check празен', () => {
    assertEqual((db.prepare('PRAGMA integrity_check;').get() as { integrity_check: string }).integrity_check, 'ok', 'integrity')
    assertEqual(db.prepare('PRAGMA foreign_key_check;').all().length, 0, 'foreign_key_check')
  })

} finally {
  for (const s of [store, store2, authStore, banStore, progressStore] as Array<{ close: () => void }>) {
    try { s.close() } catch { /* ignore */ }
  }
  db.close()
  await rm(root, { recursive: true, force: true }).catch(() => {})
}

console.log('\n' + '═'.repeat(64))
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
