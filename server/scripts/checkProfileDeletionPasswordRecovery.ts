/**
 * checkProfileDeletionPasswordRecovery.ts
 *
 * Самоизтриване, Етап 4H — "Забравена парола" при активна заявка за
 * изтриване. Само временни бази и тестов транспорт за имейли.
 *
 * [A] В процеса: реалните handler-и (forgot/reset) с тестов транспорт,
 *     password reset store, request store, worker, бан, административно
 *     изтриване, паралелно изпълнение с worker-а, граници на срока.
 * [B] Реален HTTP/WS сървър в изолирано копие на server/: смяна на паролата
 *     по линка, ограничен вход с новата парола (без сесия), без достъп до
 *     останалите функции, изрично "запази" / "остави активна", границата.
 *
 * Употреба (от server/): npx tsx scripts/checkProfileDeletionPasswordRecovery.ts --server-root=.
 */

import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { cp, mkdir, mkdtemp, readdir, rm, symlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import WebSocket from 'ws'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'
import { createPlayerProgressStore } from '../src/db/playerProgressStore.js'
import { createAuthStore } from '../src/db/authStore.js'
import { createProfileBanStore } from '../src/db/profileBanStore.js'
import { createPendingProfileModerationStore } from '../src/db/pendingProfileModerationStore.js'
import { createPasswordResetStore } from '../src/db/passwordResetStore.js'
import { createProfileDeletionRequestStore } from '../src/db/profileDeletionRequestStore.js'
import { createProfileDeletionExecutor } from '../src/db/profileDeletionExecutor.js'
import { PROFILE_DELETION_GRACE_PERIOD_MS } from '../src/db/profileDeletionSchedule.js'
import { createProfileDeletionWorker } from '../src/core/profileDeletionWorker.js'
import { handleForgotPassword, handleResetPassword, type PasswordResetHandlerContext } from '../src/auth/passwordResetHandlers.js'
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
  if (actual !== expected) throw new Error(`${message}: очаквано ${JSON.stringify(expected)}, получено ${JSON.stringify(actual)}`)
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
const SECRET = 'profile-deletion-password-recovery-secret-0123456789'
const PASSWORD = 'secret123'
const NEW_PASSWORD = 'new-secret-456'
const RESET_URL = 'http://localhost/reset-password'

console.log('\ncheckProfileDeletionPasswordRecovery')
console.log(`Server root: ${sourceServerRoot}`)

const tempRoots: string[] = []

// ═══ [A] В процеса ═══════════════════════════════════════════════════════════
const root = await mkdtemp(join(tmpdir(), 'belot-deletion-recovery-'))
tempRoots.push(root)
await mkdir(join(root, 'database', 'migrations'), { recursive: true })
await mkdir(join(root, 'database', 'data'), { recursive: true })
for (const entry of await readdir(join(sourceServerRoot, 'database', 'migrations'), { withFileTypes: true })) {
  if (entry.isFile() && extname(entry.name).toLowerCase() === '.sql') {
    await cp(join(sourceServerRoot, 'database', 'migrations', entry.name), join(root, 'database', 'migrations', entry.name))
  }
}
const { databaseFilePath } = await ensureServerDatabaseReady({ serverRootOverride: root })
const db: SqliteDatabase = new DatabaseSync(databaseFilePath, { open: true, enableForeignKeyConstraints: true })
db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')

const progressStore = await createPlayerProgressStore(databaseFilePath)
const banStore = await createProfileBanStore(databaseFilePath)
const pendingModerationStore = await createPendingProfileModerationStore(databaseFilePath)
const authStore = await createAuthStore(databaseFilePath, progressStore, {
  registrationVerificationCodeSecret: SECRET,
  getRegistrationVerificationMode: () => 'direct',
  getActiveBanForProfile: (profileId) => {
    const ban = banStore.getActiveBan(profileId)
    return ban === null ? null : { bannedUntil: ban.bannedUntil, reason: ban.reason, remainingDays: ban.remainingDays }
  },
  isProfileScheduledForAdminDeletion: (profileId) => pendingModerationStore.listPendingDeletes().some((pending) => pending.targetProfileId === profileId),
})
const resetStore = await createPasswordResetStore(databaseFilePath, { rateLimitHashSecret: SECRET })
const requestStore = await createProfileDeletionRequestStore(databaseFilePath, { rateLimitSecret: SECRET })
const executor = await createProfileDeletionExecutor(databaseFilePath)

const uploadsRoot = join(root, 'uploads')
const roots: ProfileDeletionUploadRoots = {
  avatars: join(uploadsRoot, 'avatars'),
  profileGallery: join(uploadsRoot, 'profile-gallery'),
  chatAttachments: join(uploadsRoot, 'chat-attachments'),
  topicAttachments: join(uploadsRoot, 'topic-attachments'),
  topicMuteEvidenceAttachments: join(uploadsRoot, 'topic-mute-evidence-attachments'),
  supportAttachments: join(uploadsRoot, 'support-attachments'),
}
for (const dir of Object.values(roots)) await mkdir(dir, { recursive: true })
const makeWorker = (workerId: string, onlyRequestIds: string[]) => createProfileDeletionWorker({
  executor, workerId, uploadRoots: roots, removeFile: removeProfileDeletionFile, appendLedgerEntry: null, onlyRequestIds,
})

type User = { profileId: string; accountId: string; email: string; displayName: string }
let counter = 0
function registerUser(label: string): User {
  counter += 1
  const email = `rec-${label.toLowerCase()}-${counter}@example.test`
  const displayName = `Rec${label}${counter}`
  const result = authStore.register({ email, password: PASSWORD, displayName, gender: 'male', visitorId: randomUUID() })
  if (!result.ok || result.mode !== 'direct') throw new Error(`регистрация: ${JSON.stringify(result)}`)
  return { profileId: result.session.profile.profileId as string, accountId: result.session.account.accountId, email, displayName }
}

const dbNow = () => (db.prepare(`SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now;`).get() as { now: string }).now
const isoPlus = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString()
function withTriggerDropped<T>(name: string, fn: () => T): T {
  const sql = (db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?;`).get(name) as { sql: string }).sql
  db.exec(`DROP TRIGGER ${name};`)
  try { return fn() } finally { db.exec(sql) }
}
const createdAt = (user: User) => (db.prepare('SELECT created_at FROM profiles WHERE profile_id = ?;').get(user.profileId) as { created_at: string }).created_at

/** Заявка с даден краен срок (requested_at назад — insert guard-ът нормално го забранява). */
function insertRequestScheduledAt(user: User, scheduledForIso: string, graceDays: 30 | 45 = 30): string {
  const requestId = randomUUID()
  const graceMs = graceDays * 24 * 60 * 60 * 1000
  withTriggerDropped('trg_profile_deletion_requests_insert_guard', () => {
    db.prepare(`
      INSERT INTO profile_deletion_requests (request_id, profile_id, account_id_snapshot, profile_created_at_snapshot, requested_at, scheduled_for, grace_period_days)
      VALUES (?, ?, ?, ?, ?, ?, ?);
    `).run(requestId, user.profileId, user.accountId, createdAt(user), isoPlus(scheduledForIso, -graceMs), scheduledForIso, graceDays)
  })
  return requestId
}

const requestRow = (requestId: string) => db.prepare('SELECT * FROM profile_deletion_requests WHERE request_id = ?;').get(requestId) as Record<string, unknown> | undefined
const profileExists = (profileId: string) => db.prepare('SELECT 1 FROM profiles WHERE profile_id = ?;').get(profileId) !== undefined
const passwordHash = (accountId: string) => (db.prepare('SELECT password_hash FROM accounts WHERE account_id = ?;').get(accountId) as { password_hash: string } | undefined)?.password_hash

// ─── Тестов транспорт + реалните handler-и ─────────────────────────────────
type SentEmail = { toEmail: string; rawToken: string; resetUrl: string }
const sentEmails: SentEmail[] = []
let transportFails = false
let nextIp = 1
const freshIp = () => `198.18.${Math.floor(nextIp / 250)}.${(nextIp++ % 250) + 1}`

async function callHandler(kind: 'forgot' | 'reset', body: unknown, ip: string): Promise<{ status: number; body: Record<string, unknown> }> {
  let captured: { status: number; body: Record<string, unknown> } = { status: 0, body: {} }
  const ctx: PasswordResetHandlerContext = {
    store: resetStore,
    resetUrl: RESET_URL,
    getRequestIp: () => ip,
    sendJson: (_res, status, responseBody) => { captured = { status, body: responseBody as Record<string, unknown> } },
    readBody: async () => body,
    sendEmail: async (input) => {
      if (transportFails) return { ok: false, message: 'тестов транспорт: отказ' }
      sentEmails.push(input)
      return { ok: true }
    },
  }
  const req = {} as IncomingMessage
  const res = {} as ServerResponse
  if (kind === 'forgot') await handleForgotPassword(req, res, ctx)
  else await handleResetPassword(req, res, ctx)
  return captured
}

async function forgotAndCapture(email: string, ip = freshIp()): Promise<{ status: number; body: Record<string, unknown>; email: SentEmail | null }> {
  const before = sentEmails.length
  const response = await callHandler('forgot', { email }, ip)
  return { ...response, email: sentEmails.length > before ? sentEmails[sentEmails.length - 1]! : null }
}

const resetWith = (token: string, newPassword = NEW_PASSWORD, ip = freshIp()) => callHandler('reset', { token, newPassword }, ip)

function login(email: string, password: string) {
  return authStore.login({ email, password, rememberMe: false }) as { ok: boolean; code?: string; sessionToken?: string; isBanned?: boolean; message?: string }
}

let sessionCountAfterRestricted = 0

try {
  console.log('\n[A] Възстановяване на паролата (в процеса)')

  await check('[1] Нормален профил: имейл до регистрирания адрес, смяна на паролата, вход с новата парола — без регресия', async () => {
    const user = registerUser('Normal')
    const sent = await forgotAndCapture(user.email)
    assert(sent.status === 200 && sent.body.code === 'EMAIL_SENT' && sent.email !== null, JSON.stringify(sent))
    assertEqual(sent.email!.toEmail, user.email, 'адресат')
    const reset = await resetWith(sent.email!.rawToken)
    assert(reset.status === 200 && reset.body.code === 'PASSWORD_CHANGED', JSON.stringify(reset))
    assert(!('session' in reset.body) && !('token' in reset.body), 'отговорът не съдържа сесия/токен')
    assert(login(user.email, NEW_PASSWORD).ok === true, 'вход с новата парола')
    assert(login(user.email, PASSWORD).ok === false, 'старата парола не работи')
  })

  // Профил с чакаща 30-дневна заявка и жива сесия отпреди заявката.
  const pending = registerUser('Pending30')
  const pendingSession = login(pending.email, PASSWORD)
  const pendingCreated = requestStore.createRequest({ profileId: pending.profileId, accountId: pending.accountId })
  if (!pendingCreated.ok) throw new Error(`fixture: ${JSON.stringify(pendingCreated)}`)
  const pendingRequestId = pendingCreated.request.requestId
  const pendingRowBefore = requestRow(pendingRequestId)!
  const restoreBeforeReset = requestStore.issueRestoreToken(pending.profileId)
  let pendingResetEmail: SentEmail | null = null

  await check('[2/4/21] Чакаща 30-дневна заявка: същият отговор като за нормален профил; токенът отива само на регистрирания имейл (въведеният текст не е адресат)', async () => {
    const normal = registerUser('Compare')
    const normalResponse = await forgotAndCapture(normal.email)
    const typed = `  ${pending.email.toUpperCase()}  `
    const pendingResponse = await forgotAndCapture(typed)
    assertEqual(pendingResponse.status, normalResponse.status, 'HTTP статус')
    assertEqual(JSON.stringify(pendingResponse.body), JSON.stringify(normalResponse.body), 'тяло на отговора')
    assert(pendingResponse.email !== null, 'имейл')
    assertEqual(pendingResponse.email!.toEmail, pending.email, 'адресатът е регистрираният имейл от базата')
    assert(!JSON.stringify(pendingResponse.body).includes(pendingResponse.email!.rawToken), 'токенът не е в API отговора')
    pendingResetEmail = pendingResponse.email
  })

  await check('[5] Невалиден токен се отказва; заявката и паролата не се променят', async () => {
    const hashBefore = passwordHash(pending.accountId)
    for (const token of ['', 'x', 'A'.repeat(43), 'A'.repeat(300)]) {
      const response = await resetWith(token)
      assert(response.status === 400 && response.body.code === 'INVALID_OR_EXPIRED_TOKEN', `${token.length}: ${JSON.stringify(response)}`)
    }
    assertEqual(passwordHash(pending.accountId), hashBefore, 'паролата')
  })

  await check('[8/9/10] Смяна на паролата при чакаща заявка: старите сесии и старият токен за отмяна са обезсилени; заявката (статус, срокове, grace) е непроменена', async () => {
    assert(pendingSession.ok && typeof pendingSession.sessionToken === 'string', 'fixture: сесия отпреди заявката')
    const activeSessionRows = () => Number((db.prepare('SELECT COUNT(*) AS c FROM account_sessions WHERE account_id = ? AND revoked_at IS NULL;').get(pending.accountId) as { c: number }).c)
    // Сесията отпреди заявката съществува в базата, но вече не удостоверява
    // профил с активна заявка (защитата от Етап 3).
    assert(activeSessionRows() >= 1, 'fixture: неотнет ред на сесия преди смяната')
    assertEqual(authStore.getSession(pendingSession.sessionToken!), null, 'сесията не удостоверява чакащ профил')
    assert(restoreBeforeReset.ok, 'fixture: токен за отмяна отпреди смяната')
    const response = await resetWith(pendingResetEmail!.rawToken)
    assert(response.status === 200 && response.body.code === 'PASSWORD_CHANGED', JSON.stringify(response))
    assertEqual(activeSessionRows(), 0, 'старите сесии са отнети')
    if (restoreBeforeReset.ok) {
      const stale = requestStore.cancelWithToken(restoreBeforeReset.restoreToken)
      assert(!stale.ok && stale.code === 'invalid_token', `стар токен за отмяна: ${JSON.stringify(stale)}`)
    }
    const after = requestRow(pendingRequestId)!
    for (const [column, value] of Object.entries(pendingRowBefore)) {
      if (column === 'updated_at') continue
      assertEqual(after[column], value, `заявка.${column}`)
    }
    assertEqual(after.status, 'pending', 'статус')
    assertEqual(Number(after.grace_period_days), 30, 'grace_period_days')
  })

  await check('[7] Повторна употреба на същия recovery токен: отказ', async () => {
    const response = await resetWith(pendingResetEmail!.rawToken, 'another-pass-789')
    assert(response.status === 400 && response.body.code === 'INVALID_OR_EXPIRED_TOKEN', JSON.stringify(response))
    assert(login(pending.email, 'another-pass-789').code !== 'PROFILE_PENDING_DELETION', 'паролата не е сменена втори път')
  })

  await check('[11] Вход с новата парола: само ограниченото състояние (PROFILE_PENDING_DELETION), без сесия; новият токен за отмяна носи срока от базата', () => {
    const sessionsBefore = Number((db.prepare('SELECT COUNT(*) AS c FROM account_sessions WHERE account_id = ? AND revoked_at IS NULL;').get(pending.accountId) as { c: number }).c)
    const result = login(pending.email, NEW_PASSWORD)
    assert(!result.ok && result.code === 'PROFILE_PENDING_DELETION' && result.sessionToken === undefined, JSON.stringify(result))
    sessionCountAfterRestricted = Number((db.prepare('SELECT COUNT(*) AS c FROM account_sessions WHERE account_id = ? AND revoked_at IS NULL;').get(pending.accountId) as { c: number }).c)
    assertEqual(sessionCountAfterRestricted, sessionsBefore, 'не е създадена сесия')
    const issued = requestStore.issueRestoreToken(pending.profileId)
    assert(issued.ok && issued.request.scheduledFor === pendingRowBefore.scheduled_for && issued.request.gracePeriodDays === 30, JSON.stringify(issued))
    assertEqual(login(pending.email, PASSWORD).code, undefined, 'старата парола: общ отказ без код')
  })

  await check('[3] Историческа 45-дневна заявка: смяната на паролата запазва grace_period_days = 45 и оригиналния срок', async () => {
    const legacy = registerUser('Legacy45')
    const requestId = insertRequestScheduledAt(legacy, isoPlus(dbNow(), 40 * 24 * 60 * 60 * 1000), 45)
    const before = requestRow(requestId)!
    const sent = await forgotAndCapture(legacy.email)
    assert(sent.email !== null && sent.email.toEmail === legacy.email, 'имейл')
    const response = await resetWith(sent.email!.rawToken)
    assert(response.body.code === 'PASSWORD_CHANGED', JSON.stringify(response))
    const after = requestRow(requestId)!
    assertEqual(after.scheduled_for, before.scheduled_for, 'scheduled_for')
    assertEqual(Number(after.grace_period_days), 45, 'grace_period_days')
    assertEqual(after.status, 'pending', 'статус')
    const issued = requestStore.issueRestoreToken(legacy.profileId)
    assert(issued.ok && issued.request.gracePeriodDays === 45 && issued.request.scheduledFor === before.scheduled_for, JSON.stringify(issued))
  })

  await check('[6] Изтекъл recovery токен: отказ, паролата не се сменя', async () => {
    const user = registerUser('Expired')
    requestStore.createRequest({ profileId: user.profileId, accountId: user.accountId })
    const sent = await forgotAndCapture(user.email)
    db.prepare(`UPDATE password_reset_tokens SET expires_at = datetime('now', '-1 minute') WHERE account_id = ? AND used_at IS NULL AND revoked_at IS NULL;`).run(user.accountId)
    const hashBefore = passwordHash(user.accountId)
    const response = await resetWith(sent.email!.rawToken)
    assert(response.status === 400 && response.body.code === 'INVALID_OR_EXPIRED_TOKEN', JSON.stringify(response))
    assertEqual(passwordHash(user.accountId), hashBefore, 'паролата')
  })

  console.log('\n[D] Крайният срок')

  await check('[15/16] Recovery непосредствено преди срока, употреба след него: паролата се сменя, но отмяна вече няма (без токен; тригерът отказва точно на срока)', async () => {
    const user = registerUser('NearDeadline')
    const requestId = insertRequestScheduledAt(user, isoPlus(dbNow(), 1500))
    const sent = await forgotAndCapture(user.email)
    assert(sent.email !== null, 'имейлът е изпратен преди срока')
    await new Promise((r) => setTimeout(r, 1800))
    const response = await resetWith(sent.email!.rawToken)
    assert(response.body.code === 'PASSWORD_CHANGED', `смяната на паролата не зависи от срока: ${JSON.stringify(response)}`)
    const result = login(user.email, NEW_PASSWORD)
    assert(!result.ok && result.code === 'PROFILE_PENDING_DELETION', 'ограничено състояние')
    const issued = requestStore.issueRestoreToken(user.profileId)
    assert(!issued.ok && issued.code === 'no_pending_request', 'след срока: токен за отмяна не се издава')
    assertRejects(() => db.prepare(`UPDATE profile_deletion_requests SET status = 'cancelled', cancelled_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE request_id = ?;`).run(requestId), 'profile_deletion_cancel_window_closed', 'отмяна след срока')
    const atDeadline = registerUser('AtDeadline')
    insertRequestScheduledAt(atDeadline, dbNow())
    const none = requestStore.issueRestoreToken(atDeadline.profileId)
    assert(!none.ok, 'точно на срока: токен не се издава')
    assertEqual(requestRow(requestId)!.scheduled_for, isoPlus(String(requestRow(requestId)!.requested_at), PROFILE_DELETION_GRACE_PERIOD_MS), 'срокът е непроменен')
  })

  await check('[7b] Смяна на паролата, докато окончателното изтриване вече се изпълнява: заявката остава executing със същия lease и срок', async () => {
    const user = registerUser('Executing')
    const requestId = insertRequestScheduledAt(user, isoPlus(dbNow(), -1000))
    const sent = await forgotAndCapture(user.email)
    const claimed = executor.claimNextDueRequest('w-claim', requestId)
    assert(claimed !== null, 'fixture: заявката е взета от worker')
    const before = requestRow(requestId)!
    const response = await resetWith(sent.email!.rawToken)
    assert(response.body.code === 'PASSWORD_CHANGED', JSON.stringify(response))
    const after = requestRow(requestId)!
    for (const column of ['status', 'lease_owner', 'lease_expires_at', 'scheduled_for', 'requested_at', 'grace_period_days', 'attempt_count']) {
      assertEqual(after[column], before[column], `заявка.${column}`)
    }
  })

  console.log('\n[S] Бан, административно изтриване, изтрит профил')

  await check('[17] Бан след подаването: recovery работи, но не премахва бана; ограниченият вход носи isBanned; след отмяна входът връща PROFILE_BANNED (без сесия)', async () => {
    const user = registerUser('BannedPending')
    requestStore.createRequest({ profileId: user.profileId, accountId: user.accountId })
    const banId = randomUUID()
    db.prepare(`INSERT INTO profile_bans (ban_id, profile_id, banned_until, reason, banned_by_profile_id) VALUES (?, ?, datetime('now', '+7 days'), 'нарушение', NULL);`).run(banId, user.profileId)
    const sent = await forgotAndCapture(user.email)
    assert((await resetWith(sent.email!.rawToken)).body.code === 'PASSWORD_CHANGED', 'смяна')
    const restricted = login(user.email, NEW_PASSWORD)
    assert(!restricted.ok && restricted.code === 'PROFILE_PENDING_DELETION' && restricted.isBanned === true, JSON.stringify(restricted))
    const issued = requestStore.issueRestoreToken(user.profileId)
    assert(issued.ok, 'токен')
    if (!issued.ok) return
    assert(requestStore.cancelWithToken(issued.restoreToken).ok, 'отмяна')
    const afterCancel = login(user.email, NEW_PASSWORD)
    assert(!afterCancel.ok && afterCancel.code === 'PROFILE_BANNED' && afterCancel.sessionToken === undefined, JSON.stringify(afterCancel))
    const ban = db.prepare('SELECT lifted_at FROM profile_bans WHERE ban_id = ?;').get(banId) as { lifted_at: string | null }
    assertEqual(ban.lifted_at, null, 'банът остава')
  })

  await check('[17b] Активен бан без заявка: recovery сменя паролата, но не дава вход и не позволява нова заявка', async () => {
    const user = registerUser('BannedOnly')
    db.prepare(`INSERT INTO profile_bans (ban_id, profile_id, banned_until, reason, banned_by_profile_id) VALUES (?, ?, datetime('now', '+7 days'), 'нарушение', NULL);`).run(randomUUID(), user.profileId)
    const sent = await forgotAndCapture(user.email)
    assert((await resetWith(sent.email!.rawToken)).body.code === 'PASSWORD_CHANGED', 'смяна')
    assertEqual(login(user.email, NEW_PASSWORD).code, 'PROFILE_BANNED', 'вход')
    const create = requestStore.createRequest({ profileId: user.profileId, accountId: user.accountId })
    assert(!create.ok && create.code === 'active_ban', JSON.stringify(create))
  })

  await check('[18] Насрочено административно изтриване: recovery не дава вход, токен за отмяна или начин за отмяна; висящото изтриване е непроменено', async () => {
    const user = registerUser('AdminScheduled')
    const actor = registerUser('AdminActor')
    db.prepare(`UPDATE accounts SET role = 'admin' WHERE account_id = ?;`).run(actor.accountId)
    db.prepare(`INSERT INTO pending_profile_moderation (pending_id, target_profile_id, action, requested_by_profile_id, requested_by_account_id, reason) VALUES (?, ?, 'delete', ?, ?, 'административно');`).run(randomUUID(), user.profileId, actor.profileId, actor.accountId)
    const before = JSON.stringify(db.prepare('SELECT * FROM pending_profile_moderation WHERE target_profile_id = ?;').all(user.profileId))
    const sent = await forgotAndCapture(user.email)
    assert((await resetWith(sent.email!.rawToken)).body.code === 'PASSWORD_CHANGED', 'смяна')
    const result = login(user.email, NEW_PASSWORD)
    assert(!result.ok && result.code === 'PROFILE_DELETION_SCHEDULED' && result.sessionToken === undefined, JSON.stringify(result))
    const issued = requestStore.issueRestoreToken(user.profileId)
    assert(!issued.ok, 'без токен за отмяна')
    assertEqual(JSON.stringify(db.prepare('SELECT * FROM pending_profile_moderation WHERE target_profile_id = ?;').all(user.profileId)), before, 'висящото изтриване')
  })

  await check('[19] Вече окончателно изтрит профил: recovery не го намира (същият отговор като за непознат имейл), стар токен е невалиден, нищо не се създава отново', async () => {
    const user = registerUser('Deleted')
    const requestId = insertRequestScheduledAt(user, isoPlus(dbNow(), -1000))
    const sentBefore = await forgotAndCapture(user.email)
    const summary = await makeWorker('w-deleted', [requestId]).runOnce()
    assertEqual(summary.completed, 1, `изтриване (${JSON.stringify(summary)})`)
    const unknown = await forgotAndCapture(`nobody-${randomUUID()}@example.test`)
    const deleted = await forgotAndCapture(user.email)
    assertEqual(deleted.status, unknown.status, 'статус')
    assertEqual(JSON.stringify(deleted.body), JSON.stringify(unknown.body), 'тяло')
    assert(deleted.email === null, 'без имейл')
    const stale = await resetWith(sentBefore.email!.rawToken)
    assert(stale.body.code === 'INVALID_OR_EXPIRED_TOKEN', JSON.stringify(stale))
    assert(!profileExists(user.profileId), 'профилът не съществува')
    assertEqual(Number((db.prepare('SELECT COUNT(*) AS c FROM accounts WHERE account_id = ?;').get(user.accountId) as { c: number }).c), 0, 'акаунтът не съществува')
    assertEqual(requestRow(requestId)!.status, 'completed', 'заявката')
  })

  await check('[20] Паралелно: worker и смяна на паролата — изтриването приключва, срокът е непроменен, профилът не се възстановява', async () => {
    for (const order of ['parallel', 'reset-first'] as const) {
      const user = registerUser(`Race${order.replace('-', '')}`)
      const requestId = insertRequestScheduledAt(user, isoPlus(dbNow(), -1000))
      const scheduledBefore = requestRow(requestId)!.scheduled_for
      const sent = await forgotAndCapture(user.email)
      if (order === 'reset-first') {
        assert((await resetWith(sent.email!.rawToken)).body.code === 'PASSWORD_CHANGED', 'смяна преди worker-а')
        await makeWorker(`w-${order}`, [requestId]).runOnce()
      } else {
        const [, reset] = await Promise.all([makeWorker(`w-${order}`, [requestId]).runOnce(), resetWith(sent.email!.rawToken)])
        assert(reset.body.code === 'PASSWORD_CHANGED' || reset.body.code === 'INVALID_OR_EXPIRED_TOKEN', JSON.stringify(reset))
      }
      assert(!profileExists(user.profileId), `${order}: профилът е изтрит`)
      const row = requestRow(requestId)!
      assertEqual(row.status, 'completed', `${order}: статус`)
      assertEqual(row.scheduled_for, scheduledBefore, `${order}: срок`)
      const again = await forgotAndCapture(user.email)
      assert(again.email === null, `${order}: изтритият профил не получава recovery`)
    }
  })

  console.log('\n[L] Изброяване и масови заявки')

  await check('[21] Изброяване: непознат имейл, изтрит профил и грешна парола не издават състоянието на чакащия профил', async () => {
    const pendingUser = registerUser('EnumPending')
    requestStore.createRequest({ profileId: pendingUser.profileId, accountId: pendingUser.accountId })
    const normalUser = registerUser('EnumNormal')
    const a = await forgotAndCapture(pendingUser.email)
    const b = await forgotAndCapture(normalUser.email)
    assertEqual(`${a.status}|${JSON.stringify(a.body)}`, `${b.status}|${JSON.stringify(b.body)}`, 'чакащ = нормален')
    const wrongPending = login(pendingUser.email, 'wrong-password')
    const unknownLogin = login(`nobody-${randomUUID()}@example.test`, 'wrong-password')
    assertEqual(JSON.stringify(wrongPending), JSON.stringify(unknownLogin), 'грешна парола = непознат имейл')
  })

  await check('[22] Масови/повторни заявки: лимит на акаунт (3/час) и на IP (5/30 мин) за forgot, (10/15 мин) за reset — без изпратени имейли над лимита; при отказ на транспорта токенът се обезсилва', async () => {
    const user = registerUser('Flood')
    requestStore.createRequest({ profileId: user.profileId, accountId: user.accountId })
    const responses = [] as Array<{ status: number; email: SentEmail | null }>
    for (let i = 0; i < 4; i += 1) responses.push(await forgotAndCapture(user.email))
    assertEqual(responses.slice(0, 3).filter((r) => r.status === 200 && r.email !== null).length, 3, 'първите 3')
    assert(responses[3]!.status === 429 && responses[3]!.email === null, `4-ти: ${responses[3]!.status}`)
    const ip = freshIp()
    const ipResponses = [] as number[]
    for (let i = 0; i < 6; i += 1) ipResponses.push((await callHandler('forgot', { email: `nobody-${i}-${randomUUID()}@example.test` }, ip)).status)
    assert(ipResponses.slice(0, 5).every((s) => s === 404) && ipResponses[5] === 429, `IP: ${ipResponses.join(',')}`)
    const resetIp = freshIp()
    const resetStatuses = [] as number[]
    for (let i = 0; i < 11; i += 1) resetStatuses.push((await resetWith('A'.repeat(43), NEW_PASSWORD, resetIp)).status)
    assert(resetStatuses.slice(0, 10).every((s) => s === 400) && resetStatuses[10] === 429, `reset IP: ${resetStatuses.join(',')}`)
    const other = registerUser('TransportFail')
    transportFails = true
    try {
      const failedSend = await forgotAndCapture(other.email)
      assertEqual(failedSend.status, 503, 'отказ на транспорта')
    } finally {
      transportFails = false
    }
    const active = Number((db.prepare('SELECT COUNT(*) AS c FROM password_reset_tokens WHERE account_id = ? AND used_at IS NULL AND revoked_at IS NULL;').get(other.accountId) as { c: number }).c)
    assertEqual(active, 0, 'неизпратеният токен е обезсилен')
  })
} catch (error) {
  failed += 1
  console.error(`  FAIL  неочаквана грешка [A]: ${error instanceof Error ? error.stack : String(error)}`)
}

// ═══ [B] Реален HTTP/WS сървър ═══════════════════════════════════════════════
type RunningServer = { child: ChildProcessByStdio<null, Readable, Readable>; output(): string }
let server: RunningServer | null = null
const sockets: WebSocket[] = []

async function getFreePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      srv.close(() => resolvePort(port))
    })
  })
}

try {
  console.log('\n[B] Реален HTTP/WS сървър')
  const isolatedRoot = await mkdtemp(join(tmpdir(), 'belot-deletion-recovery-http-'))
  tempRoots.push(isolatedRoot)
  const serverDir = join(isolatedRoot, 'server')
  await mkdir(serverDir, { recursive: true })
  await cp(join(sourceServerRoot, 'src'), join(serverDir, 'src'), { recursive: true, preserveTimestamps: true })
  await cp(join(sourceServerRoot, 'dist'), join(serverDir, 'dist'), { recursive: true, preserveTimestamps: true })
  await mkdir(join(serverDir, 'database', 'data'), { recursive: true })
  await cp(join(sourceServerRoot, 'database', 'migrations'), join(serverDir, 'database', 'migrations'), { recursive: true, preserveTimestamps: true })
  await cp(join(sourceServerRoot, 'package.json'), join(serverDir, 'package.json'), { preserveTimestamps: true })
  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  await symlink(join(sourceServerRoot, 'node_modules'), join(serverDir, 'node_modules'), linkType)
  await symlink(join(sourceServerRoot, '..', 'node_modules'), join(isolatedRoot, 'node_modules'), linkType)

  const bootstrap = await ensureServerDatabaseReady({ serverRootOverride: serverDir })
  const hdb = new DatabaseSync(bootstrap.databaseFilePath)
  hdb.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;')
  hdb.prepare(`UPDATE admin_settings SET setting_value = 'direct' WHERE setting_key = 'registration_verification_mode';`).run()
  // "Имейлът" с линка: токенът се издава от същия store, който ползва сървърът
  // (тестов транспорт — без реален Brevo); смяната минава през реалния HTTP.
  const hResetStore = await createPasswordResetStore(bootstrap.databaseFilePath, { rateLimitHashSecret: SECRET })
  const hRequestStore = await createProfileDeletionRequestStore(bootstrap.databaseFilePath, { rateLimitSecret: SECRET })

  const port = await getFreePort()
  const base = `http://127.0.0.1:${port}`
  const chunks: string[] = []
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    BELOT_GAME_WORKER_TICK_MODE: 'worker-candidate',
    BELOT_GAME_WORKER_COUNT: '1',
    PASSWORD_RESET_RATE_LIMIT_SECRET: SECRET,
    PASSWORD_RESET_URL: RESET_URL,
  }
  // Подаването на заявки не се ползва (заявките се създават от store-а) —
  // флагът за самоизтриване остава изключен.
  delete env.PROFILE_SELF_DELETION_ENABLED
  const child = spawn(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'index.ts')], { cwd: serverDir, env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (c: string) => chunks.push(c))
  child.stderr.on('data', (c: string) => chunks.push(c))
  server = { child, output: () => chunks.join('') }
  const deadline = Date.now() + 90_000
  for (;;) {
    if (child.exitCode !== null) throw new Error(`Сървърът спря:\n${server.output().slice(-2000)}`)
    try { if ((await fetch(`${base}/health`)).ok) break } catch { /* not ready */ }
    if (Date.now() > deadline) throw new Error('Timeout: health')
    await new Promise((r) => setTimeout(r, 250))
  }

  async function api(path: string, init: { method?: string; cookie?: string; body?: unknown } = {}): Promise<{ status: number; json: any; setCookie: string }> {
    const res = await fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers: { ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(init.cookie ? { Cookie: init.cookie } : {}) },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    })
    const text = await res.text()
    let json: any = null
    try { json = JSON.parse(text) } catch { json = text }
    return { status: res.status, json, setCookie: res.headers.get('set-cookie') ?? '' }
  }
  type HttpUser = { profileId: string; accountId: string; email: string; cookie: string }
  let httpCounter = 0
  async function registerHttp(label: string): Promise<HttpUser> {
    httpCounter += 1
    hdb.prepare(`DELETE FROM registration_rate_limit_events WHERE scope = 'registration-direct-ip';`).run()
    const email = `rec-http-${label.toLowerCase()}-${httpCounter}@example.test`
    const res = await api('/api/auth/register', { method: 'POST', body: { email, password: PASSWORD, displayName: `RecHttp${label}${httpCounter}`, gender: 'male', visitorId: randomUUID() } })
    if (res.status !== 200 || !res.json.ok) throw new Error(`регистрация: ${res.status} ${JSON.stringify(res.json)}`)
    return { profileId: res.json.session.profile.profileId, accountId: res.json.session.account.accountId, email, cookie: res.setCookie.split(';')[0]! }
  }
  const loginHttp = async (email: string, password: string) => {
    const res = await api('/api/auth/login', { method: 'POST', body: { email, password } })
    return { status: res.status, json: res.json, sessionCookie: /belot_session=[^;]+/.test(res.setCookie) && !/belot_session=;/.test(res.setCookie) }
  }
  async function wsIsUnauthenticated(cookie: string): Promise<boolean> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: cookie } })
    sockets.push(ws)
    const messages: any[] = []
    let closed = false
    ws.on('message', (data) => { try { messages.push(JSON.parse(String(data))) } catch { /* ignore */ } })
    ws.on('close', () => { closed = true })
    const until = async (predicate: () => boolean, ms = 5000) => {
      const end = Date.now() + ms
      while (Date.now() < end && !predicate()) await new Promise((r) => setTimeout(r, 50))
      return predicate()
    }
    await until(() => closed || messages.some((m) => m.type === 'connected'))
    if (closed) return true
    ws.send(JSON.stringify({ type: 'join_matchmaking', stake: 5000 }))
    const refused = await until(() => messages.some((m) => m.type === 'error' && typeof m.message === 'string' && m.message.startsWith('Трябва да влезеш')))
    ws.close()
    return refused
  }

  const user = await registerHttp('Pending')
  const created = hRequestStore.createRequest({ profileId: user.profileId, accountId: user.accountId })
  if (!created.ok) throw new Error(`fixture: ${JSON.stringify(created)}`)
  const rowBefore = hdb.prepare('SELECT * FROM profile_deletion_requests WHERE request_id = ?;').get(created.request.requestId) as Record<string, unknown>

  await check('[B2/B8] HTTP смяна на паролата по линка: PASSWORD_CHANGED без сесия; старата сесия (cookie) е отнета; заявката е непроменена', async () => {
    // Заявката е създадена директно (без HTTP подаването, което отнема
    // сесиите): редът на сесията е неотнет, но вече не удостоверява профила.
    const activeSessions = () => Number((hdb.prepare('SELECT COUNT(*) AS c FROM account_sessions WHERE account_id = ? AND revoked_at IS NULL;').get(user.accountId) as { c: number }).c)
    assert(activeSessions() >= 1, 'fixture: неотнет ред на сесия')
    assertEqual((await api('/api/friends', { cookie: user.cookie })).status, 401, 'сесията не удостоверява чакащ профил')
    const token = hResetStore.createPasswordResetToken(user.accountId)
    assert(token.ok, 'токен')
    if (!token.ok) return
    const res = await api('/api/auth/reset-password', { method: 'POST', body: { token: token.rawToken, newPassword: NEW_PASSWORD } })
    assert(res.status === 200 && res.json.code === 'PASSWORD_CHANGED', `${res.status} ${JSON.stringify(res.json)}`)
    assert(!/belot_session=[^;]/.test(res.setCookie), `издадена сесия: ${res.setCookie}`)
    assertEqual(activeSessions(), 0, 'старите сесии са отнети')
    const row = hdb.prepare('SELECT * FROM profile_deletion_requests WHERE request_id = ?;').get(created.request.requestId) as Record<string, unknown>
    for (const column of ['status', 'requested_at', 'scheduled_for', 'grace_period_days', 'cancelled_at']) assertEqual(row[column], rowBefore[column], `заявка.${column}`)
  })

  let restoreToken = ''
  await check('[B11/B12] Вход с новата парола: 403 PROFILE_PENDING_DELETION, срокът = базата, без сесия; без достъп до приятели/разговори; WS не се удостоверява', async () => {
    const res = await loginHttp(user.email, NEW_PASSWORD)
    assert(res.status === 403 && res.json.code === 'PROFILE_PENDING_DELETION' && res.json.restoreAvailable === true, `${res.status} ${JSON.stringify(res.json)}`)
    assert(!res.sessionCookie, 'издадена сесия')
    assertEqual(res.json.scheduledFor, rowBefore.scheduled_for, 'scheduledFor = базата')
    assertEqual(res.json.gracePeriodDays, 30, 'gracePeriodDays')
    assert(res.json.profileId === undefined, 'вътрешният profileId не се връща')
    restoreToken = res.json.restoreToken
    for (const path of ['/api/friends', '/api/profile/me', '/api/chat/conversations']) {
      const denied = await api(path, { cookie: user.cookie })
      assert(denied.status === 401 || denied.status === 403, `${path}: ${denied.status}`)
    }
    assert(await wsIsUnauthenticated(user.cookie), 'WS')
    const old = await loginHttp(user.email, PASSWORD)
    assert(old.status === 400 && old.json.code === undefined, `старата парола: ${old.status} ${JSON.stringify(old.json)}`)
  })

  await check('[B14] "Остави заявката активна": заявката е непроменена, токенът е изразходван', async () => {
    const kept = await api('/api/account/deletion-request/keep', { method: 'POST', body: { restoreToken } })
    assert(kept.status === 200 && kept.json.ok === true, `${kept.status} ${JSON.stringify(kept.json)}`)
    const row = hdb.prepare('SELECT * FROM profile_deletion_requests WHERE request_id = ?;').get(created.request.requestId) as Record<string, unknown>
    for (const column of ['status', 'requested_at', 'scheduled_for', 'grace_period_days', 'cancelled_at']) assertEqual(row[column], rowBefore[column], `заявка.${column}`)
    const reuse = await api('/api/account/deletion-request/cancel', { method: 'POST', body: { restoreToken } })
    assert(reuse.status === 400 && reuse.json.code === 'INVALID_RESTORE_TOKEN', 'изразходваният токен не отменя')
  })

  await check('[B13] "Запази профила ми" преди срока: заявката е отменена (журнал), без сесия от самата отмяна; следващият вход е нормален', async () => {
    const res = await loginHttp(user.email, NEW_PASSWORD)
    assert(res.status === 403 && res.json.restoreAvailable === true, 'нов токен')
    const cancelled = await api('/api/account/deletion-request/cancel', { method: 'POST', body: { restoreToken: res.json.restoreToken } })
    assert(cancelled.status === 200 && cancelled.json.ok === true, `${cancelled.status} ${JSON.stringify(cancelled.json)}`)
    assert(!/belot_session=[^;]/.test(cancelled.setCookie), 'отмяната не издава сесия')
    const row = hdb.prepare('SELECT status, cancelled_at FROM profile_deletion_requests WHERE request_id = ?;').get(created.request.requestId) as { status: string; cancelled_at: string | null }
    assert(row.status === 'cancelled' && row.cancelled_at !== null, JSON.stringify(row))
    const event = hdb.prepare(`SELECT actor_kind FROM profile_deletion_events WHERE request_id = ? AND event_type = 'cancelled';`).get(created.request.requestId) as { actor_kind: string } | undefined
    assertEqual(event?.actor_kind, 'user', 'одит: cancelled от потребителя')
    const normal = await loginHttp(user.email, NEW_PASSWORD)
    assert(normal.status === 200 && normal.json.ok === true && normal.sessionCookie, `нормален вход: ${normal.status} ${JSON.stringify(normal.json)}`)
  })

  await check('[B15/B16] HTTP граница: токен, издаден преди срока, се отказва след него (DELETION_WINDOW_CLOSED); след срока вход дава само ограничено състояние без токен', async () => {
    const late = await registerHttp('Late')
    const requestId = randomUUID()
    const lateCreatedAt = (hdb.prepare('SELECT created_at FROM profiles WHERE profile_id = ?;').get(late.profileId) as { created_at: string }).created_at
    const nowIso = (hdb.prepare(`SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now;`).get() as { now: string }).now
    const scheduledFor = isoPlus(nowIso, 2500)
    const sql = (hdb.prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_profile_deletion_requests_insert_guard';`).get() as { sql: string }).sql
    hdb.exec('DROP TRIGGER trg_profile_deletion_requests_insert_guard;')
    try {
      hdb.prepare(`INSERT INTO profile_deletion_requests (request_id, profile_id, account_id_snapshot, profile_created_at_snapshot, requested_at, scheduled_for, grace_period_days) VALUES (?, ?, ?, ?, ?, ?, 30);`)
        .run(requestId, late.profileId, late.accountId, lateCreatedAt, isoPlus(scheduledFor, -PROFILE_DELETION_GRACE_PERIOD_MS), scheduledFor)
    } finally {
      hdb.exec(sql)
    }
    const before = await loginHttp(late.email, PASSWORD)
    assert(before.status === 403 && before.json.restoreAvailable === true, 'токен преди срока')
    await new Promise((r) => setTimeout(r, 2800))
    const cancel = await api('/api/account/deletion-request/cancel', { method: 'POST', body: { restoreToken: before.json.restoreToken } })
    assert(cancel.status === 400 && cancel.json.code === 'DELETION_WINDOW_CLOSED', `${cancel.status} ${JSON.stringify(cancel.json)}`)
    const after = await loginHttp(late.email, PASSWORD)
    assert(after.status === 403 && after.json.code === 'PROFILE_PENDING_DELETION' && after.json.restoreAvailable === false && after.json.restoreToken === undefined && !after.sessionCookie, JSON.stringify(after.json))
    assertEqual((hdb.prepare('SELECT status FROM profile_deletion_requests WHERE request_id = ?;').get(requestId) as { status: string }).status, 'pending', 'заявката не е отменена')
  })

  hResetStore.close()
  hRequestStore.close()
  hdb.close()
} catch (error) {
  failed += 1
  console.error(`  FAIL  неочаквана грешка [B]: ${error instanceof Error ? error.stack : String(error)}`)
  if (server !== null) console.error(server.output().slice(-2000))
} finally {
  for (const ws of sockets) { try { ws.terminate() } catch { /* ignore */ } }
  if (server !== null && server.child.exitCode === null) {
    server.child.kill('SIGTERM')
    await new Promise<void>((res) => {
      const timer = setTimeout(() => { server?.child.kill('SIGKILL'); res() }, 10_000)
      server!.child.once('exit', () => { clearTimeout(timer); res() })
    })
  }
  for (const store of [resetStore, requestStore, executor]) { try { store.close() } catch { /* ignore */ } }
  try { db.close() } catch { /* ignore */ }
  for (const dir of tempRoots) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try { await rm(dir, { recursive: true, force: true }); break } catch { await new Promise((r) => setTimeout(r, 500)) }
    }
  }
}

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)
process.exitCode = failed > 0 ? 1 : 0
