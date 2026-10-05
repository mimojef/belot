/**
 * checkMarketingRole.ts
 *
 * Regression coverage за role='marketing' ("Маркетинг"):
 *
 *  M.  DB migration 20261005_001 — запазва съществуващите роли/audit/ad
 *      campaign редове и разрешава 'marketing' във всички нужни CHECK-ове.
 *  P.  Server permission matrix (authStore predicates, извикани директно) —
 *      marketing е САМО Ads manager + own-content delete, нищо друго; всички
 *      съществуващи роли запазват точно досегашните си права.
 *  C.  Client UX predicates/source wiring (само UX, server е authoritative).
 *  H.  HTTP/WS E2E срещу РЕАЛЕН spawned сървър (изолиран temp SQLite,
 *      direct registration mode):
 *       H1-H6   role management през съществуващия profile-popup endpoint
 *       H7-H14  Ads (HTTP + WS management subscription)
 *       H15-H22 Лафче / Теми own-content delete + ownership enforcement
 *       H23-H30 marketing НЕ получава mute/ban/lock/delete-topic/reports/admin
 *       H31-H34 Admin/Moderator/player regression
 */

import { randomUUID } from 'node:crypto'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import WebSocket, { type RawData } from 'ws'
import {
  isAdCampaignManagerRole,
  isAdCampaignManagerSession,
  isAdminGiftUnlimitedSession,
  isAdminOrSubadminSession,
  isFullAdminSession,
  isLafcheMessageDeleteModeratorSession,
  isLafcheModeratorSession,
  isLafcheOwnPostDeleteSession,
  isLobbyChatModeratorSession,
  isPikaAnnouncementAuthorSession,
  isPikaTeamGiftFriendshipBypassSession,
  isPikaTeamGiftMaxAmountSession,
  isPikaTeamSupportChatSession,
  isTopicMessageModeratorSession,
  isTopicModeratorSession,
  isTopicOwnRootCascadeDeleteSession,
  isTopicWholeTopicModeratorSession,
  type AccountRoleValue,
  type AuthSessionSnapshot,
} from '../src/db/authStore.js'

const PASSWORD = 'MarketingRoleCheck1!'
const TEST_SECRET = 'marketing-role-http-test-secret-0123456789abcdef'
const LAFCHE_TOPIC_ID = 'topic-lafche'
const GENERAL_TOPIC_ID = 'topic-general'

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

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))

const sourceServerRoot = resolve(process.argv.slice(2).find((a) => a.startsWith('--server-root='))?.slice('--server-root='.length) ?? process.cwd())
const projectRoot = resolve(sourceServerRoot, '..')
const readSource = (pathFromProjectRoot: string) => readFileSync(join(projectRoot, pathFromProjectRoot), 'utf8')

// ─── M. Migration smoke ─────────────────────────────────────────────────────

function runMigrationSmoke(): void {
  const root = mkdtempSync(join(tmpdir(), 'belot-marketing-role-migration-'))
  const db = new DatabaseSync(join(root, 'test.sqlite'))
  try {
    // Pre-migration schema = точната текуща production форма на засегнатите таблици.
    db.exec(`
      CREATE TABLE profiles (profile_id TEXT PRIMARY KEY, account_id TEXT NULL);
      CREATE TABLE accounts (
        account_id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE CHECK (trim(email) <> ''),
        password_hash TEXT NOT NULL CHECK (trim(password_hash) <> ''),
        role TEXT NOT NULL DEFAULT 'player' CHECK (role IN ('player', 'chat_admin', 'pika_team', 'top_chat_admin', 'subadmin', 'admin')),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_login_at TEXT NULL
      );
      CREATE TABLE account_sessions (session_id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE);
      CREATE TABLE admin_role_audit_log (
        log_id TEXT PRIMARY KEY,
        actor_account_id TEXT NULL,
        target_account_id TEXT NULL,
        action TEXT NOT NULL CHECK (action IN ('grant_subadmin','revoke_subadmin','grant_chat_admin','revoke_chat_admin','grant_pika_team','revoke_pika_team','grant_top_chat_admin','revoke_top_chat_admin')),
        previous_role TEXT NOT NULL CHECK (previous_role IN ('player', 'chat_admin', 'pika_team', 'top_chat_admin', 'subadmin', 'admin')),
        new_role TEXT NOT NULL CHECK (new_role IN ('player', 'chat_admin', 'pika_team', 'top_chat_admin', 'subadmin', 'admin')),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (actor_account_id) REFERENCES accounts(account_id) ON DELETE SET NULL,
        FOREIGN KEY (target_account_id) REFERENCES accounts(account_id) ON DELETE SET NULL
      );
      CREATE TABLE ad_campaigns (
        campaign_id TEXT PRIMARY KEY,
        image_url TEXT NOT NULL,
        image_filename TEXT NOT NULL,
        target_url TEXT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_by_profile_id TEXT NULL,
        created_by_role TEXT NOT NULL CHECK (created_by_role IN ('admin', 'pika_team')),
        deleted_at TEXT NULL,
        deleted_by_profile_id TEXT NULL,
        deleted_by_role TEXT NULL CHECK (deleted_by_role IS NULL OR deleted_by_role IN ('admin', 'pika_team')),
        FOREIGN KEY (created_by_profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL,
        FOREIGN KEY (deleted_by_profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL
      );
      CREATE TABLE ad_campaign_dispatches (
        dispatch_id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL,
        sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        sent_by_profile_id TEXT NULL,
        sent_by_role TEXT NOT NULL CHECK (sent_by_role IN ('admin', 'pika_team')), superseded_at TEXT NULL,
        FOREIGN KEY (campaign_id) REFERENCES ad_campaigns(campaign_id) ON DELETE CASCADE,
        FOREIGN KEY (sent_by_profile_id) REFERENCES profiles(profile_id) ON DELETE SET NULL
      );
      CREATE TABLE ad_campaign_receipts (
        dispatch_id TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        shown_at TEXT NULL,
        PRIMARY KEY (dispatch_id, profile_id),
        FOREIGN KEY (dispatch_id) REFERENCES ad_campaign_dispatches(dispatch_id) ON DELETE CASCADE,
        FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
      );
      CREATE TABLE server_migrations (filename TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);

      INSERT INTO accounts (account_id, email, password_hash, role) VALUES
        ('a-admin', 'admin@x.test', 'h', 'admin'), ('a-sub', 'sub@x.test', 'h', 'subadmin'),
        ('a-chat', 'chat@x.test', 'h', 'chat_admin'), ('a-pika', 'pika@x.test', 'h', 'pika_team'),
        ('a-top', 'top@x.test', 'h', 'top_chat_admin'), ('a-player', 'player@x.test', 'h', 'player');
      INSERT INTO account_sessions VALUES ('s1', 'a-player');
      INSERT INTO profiles VALUES ('p-admin', 'a-admin'), ('p-pika', 'a-pika'), ('p-player', 'a-player');
      INSERT INTO admin_role_audit_log (log_id, actor_account_id, target_account_id, action, previous_role, new_role)
        VALUES ('l1', 'a-admin', 'a-top', 'grant_top_chat_admin', 'player', 'top_chat_admin');
      INSERT INTO ad_campaigns (campaign_id, image_url, image_filename, target_url, created_by_profile_id, created_by_role)
        VALUES ('c1', '/u/1.webp', '1.webp', '/x', 'p-pika', 'pika_team');
      INSERT INTO ad_campaign_dispatches (dispatch_id, campaign_id, sent_by_profile_id, sent_by_role) VALUES ('d1', 'c1', 'p-admin', 'admin');
      INSERT INTO ad_campaign_receipts (dispatch_id, profile_id) VALUES ('d1', 'p-player');
    `)

    db.exec(readFileSync(join(sourceServerRoot, 'database/migrations/20261005_001_add_marketing_role.sql'), 'utf8'))

    const roles = db.prepare('SELECT account_id, role FROM accounts ORDER BY account_id').all()
    assert(JSON.stringify(roles.map((r) => [r.account_id, r.role])) === JSON.stringify([
      ['a-admin', 'admin'], ['a-chat', 'chat_admin'], ['a-pika', 'pika_team'], ['a-player', 'player'], ['a-sub', 'subadmin'], ['a-top', 'top_chat_admin'],
    ]), `roles changed: ${JSON.stringify(roles)}`)
    assert((db.prepare('SELECT COUNT(*) c FROM account_sessions').get() as { c: number }).c === 1, 'sessions lost (FK cascade fired?)')
    assert((db.prepare('SELECT COUNT(*) c FROM ad_campaign_receipts').get() as { c: number }).c === 1, 'receipts lost (FK cascade fired?)')
    assert((db.prepare("SELECT superseded_at FROM ad_campaign_dispatches WHERE dispatch_id='d1'").get() as { superseded_at: null }).superseded_at === null, 'dispatch lost')
    assert(db.prepare('PRAGMA foreign_key_check').all().length === 0, 'foreign_key_check violations')
    assert((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys === 1, 'foreign_keys must be ON after migration')

    db.prepare("INSERT INTO accounts (account_id, email, password_hash, role) VALUES ('a-mkt', 'mkt@x.test', 'h', 'marketing')").run()
    db.prepare("INSERT INTO admin_role_audit_log (log_id, actor_account_id, target_account_id, action, previous_role, new_role) VALUES ('l2', 'a-admin', 'a-mkt', 'grant_marketing', 'player', 'marketing')").run()
    db.prepare("INSERT INTO admin_role_audit_log (log_id, actor_account_id, target_account_id, action, previous_role, new_role) VALUES ('l3', 'a-admin', 'a-mkt', 'revoke_marketing', 'marketing', 'player')").run()
    db.prepare("INSERT INTO ad_campaigns (campaign_id, image_url, image_filename, created_by_role, deleted_at, deleted_by_role) VALUES ('c2', '/u', 'f', 'marketing', CURRENT_TIMESTAMP, 'marketing')").run()
    db.prepare("INSERT INTO ad_campaign_dispatches (dispatch_id, campaign_id, sent_by_role) VALUES ('d2', 'c1', 'marketing')").run()
    for (const bad of [
      "INSERT INTO accounts (account_id, email, password_hash, role) VALUES ('a-bad', 'bad@x.test', 'h', 'superuser')",
      "INSERT INTO ad_campaigns (campaign_id, image_url, image_filename, created_by_role) VALUES ('c3', '/u', 'f', 'subadmin')",
      "INSERT INTO ad_campaign_dispatches (dispatch_id, campaign_id, sent_by_role) VALUES ('d3', 'c1', 'player')",
      "INSERT INTO admin_role_audit_log (log_id, action, previous_role, new_role) VALUES ('l4', 'grant_superuser', 'player', 'marketing')",
    ]) {
      let rejected = false
      try { db.prepare(bad).run() } catch { rejected = true }
      assert(rejected, `CHECK must reject: ${bad}`)
    }
    assert(Boolean(db.prepare("SELECT 1 FROM server_migrations WHERE filename = '20261005_001_add_marketing_role.sql'").get()), 'migration ledger row missing')
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
}

// ─── P. Server permission matrix ────────────────────────────────────────────

const ALL_ROLES: AccountRoleValue[] = ['player', 'chat_admin', 'pika_team', 'top_chat_admin', 'marketing', 'subadmin', 'admin']

function fakeSession(role: AccountRoleValue): AuthSessionSnapshot {
  return {
    sessionId: 's',
    account: { accountId: 'a', email: 'e@x.test', role, status: 'active', createdAt: '' },
    profile: { profileId: 'p' } as AuthSessionSnapshot['profile'],
  }
}

function rolesAllowed(predicate: (session: AuthSessionSnapshot | null) => boolean): string {
  assert(predicate(null) === false, 'predicate must reject null session')
  return ALL_ROLES.filter((role) => predicate(fakeSession(role))).join(',')
}

const EXPECTED_PREDICATE_MATRIX: Array<[string, (s: AuthSessionSnapshot | null) => boolean, string]> = [
  ['isAdCampaignManagerSession', isAdCampaignManagerSession, 'pika_team,marketing,admin'],
  ['isLafcheOwnPostDeleteSession', isLafcheOwnPostDeleteSession, 'marketing'],
  ['isTopicOwnRootCascadeDeleteSession', isTopicOwnRootCascadeDeleteSession, 'marketing'],
  // Непроменени — marketing НЕ трябва да присъства никъде тук:
  ['isFullAdminSession', isFullAdminSession, 'admin'],
  ['isAdminOrSubadminSession', isAdminOrSubadminSession, 'subadmin,admin'],
  ['isLobbyChatModeratorSession', isLobbyChatModeratorSession, 'chat_admin,pika_team,top_chat_admin,subadmin,admin'],
  ['isPikaAnnouncementAuthorSession', isPikaAnnouncementAuthorSession, 'pika_team,admin'],
  ['isTopicModeratorSession (mute/unmute/reports/audit)', isTopicModeratorSession, 'pika_team,top_chat_admin,subadmin,admin'],
  ['isLafcheModeratorSession (Лафче mute/report)', isLafcheModeratorSession, 'pika_team,top_chat_admin,admin'],
  ['isLafcheMessageDeleteModeratorSession', isLafcheMessageDeleteModeratorSession, 'chat_admin,pika_team,top_chat_admin,admin'],
  ['isTopicWholeTopicModeratorSession (lock/unlock/delete тема)', isTopicWholeTopicModeratorSession, 'top_chat_admin,subadmin,admin'],
  ['isTopicMessageModeratorSession (delete чужд пост)', isTopicMessageModeratorSession, 'chat_admin,pika_team,top_chat_admin,subadmin,admin'],
  ['isPikaTeamGiftFriendshipBypassSession', isPikaTeamGiftFriendshipBypassSession, 'pika_team'],
  ['isPikaTeamGiftMaxAmountSession', isPikaTeamGiftMaxAmountSession, 'pika_team'],
  ['isPikaTeamSupportChatSession', isPikaTeamSupportChatSession, 'pika_team'],
  ['isAdminGiftUnlimitedSession', isAdminGiftUnlimitedSession, 'admin'],
]

// ─── H. HTTP/WS harness ─────────────────────────────────────────────────────

function getFreePort(): Promise<number> {
  return new Promise((done, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (!addr || typeof addr === 'string') {
        srv.close(() => reject(new Error('no port')))
        return
      }
      srv.close(() => done(addr.port))
    })
  })
}

async function retryRm(path: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try { await rm(path, { recursive: true, force: true }); return } catch { /* retry */ }
    await sleep(250)
  }
}

async function createIsolatedServerRoot(originalServerRoot: string) {
  const root = await mkdtemp(join(tmpdir(), 'belot-marketing-role-'))
  const serverDir = join(root, 'server')
  await mkdir(serverDir, { recursive: true })
  await cp(join(originalServerRoot, 'src'), join(serverDir, 'src'), { recursive: true, preserveTimestamps: true })
  await cp(join(originalServerRoot, 'dist'), join(serverDir, 'dist'), { recursive: true, preserveTimestamps: true })
  await mkdir(join(serverDir, 'database', 'data'), { recursive: true })
  await cp(join(originalServerRoot, 'database', 'migrations'), join(serverDir, 'database', 'migrations'), { recursive: true, preserveTimestamps: true })
  await cp(join(originalServerRoot, 'package.json'), join(serverDir, 'package.json'), { preserveTimestamps: true })
  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  await symlink(join(originalServerRoot, 'node_modules'), join(serverDir, 'node_modules'), linkType)
  await symlink(join(originalServerRoot, '..', 'node_modules'), join(root, 'node_modules'), linkType)
  return { serverDir, databaseFile: join(serverDir, 'database', 'data', 'belot-v2.sqlite'), cleanup: () => retryRm(root) }
}

type RunningServer = { child: ChildProcessWithoutNullStreams; output(): string }

function startServer(serverDir: string, port: number): RunningServer {
  const chunks: string[] = []
  const child = spawn(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'index.ts')], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(port),
      BELOT_GAME_WORKER_TICK_MODE: 'worker-candidate',
      BELOT_GAME_WORKER_COUNT: '1',
      PASSWORD_RESET_RATE_LIMIT_SECRET: TEST_SECRET,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => chunks.push(chunk))
  child.stderr.on('data', (chunk: string) => chunks.push(chunk))
  return { child, output: () => chunks.join('') }
}

async function stopServer(server: RunningServer): Promise<void> {
  if (server.child.exitCode !== null) return
  server.child.kill('SIGTERM')
  await new Promise<void>((done) => {
    const timer = setTimeout(() => { server.child.kill('SIGKILL'); done() }, 10_000)
    server.child.once('exit', () => { clearTimeout(timer); done() })
  })
}

async function waitForServer(port: number): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/rooms`)).status === 200) return
    } catch { /* not yet */ }
    await sleep(100)
  }
  throw new Error('server did not start')
}

let ipCounter = 0
const nextIp = () => `203.0.113.${(ipCounter += 1) % 250 + 1}`

type JsonResult = { status: number; body: Record<string, unknown> | null; text: string; setCookie: string[] }

async function request(port: number, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', pathname: string, body?: unknown, cookie?: string): Promise<JsonResult> {
  const headers: Record<string, string> = { 'X-Forwarded-For': nextIp() }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (cookie) headers['Cookie'] = cookie
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  let parsed: Record<string, unknown> | null = null
  try { parsed = JSON.parse(text) as Record<string, unknown> } catch { /* not json */ }
  const headersExt = res.headers as Headers & { getSetCookie?: () => string[] }
  return { status: res.status, body: parsed, text, setCookie: headersExt.getSetCookie?.() ?? [] }
}

const cookieOf = (result: JsonResult) => result.setCookie.find((c) => c.startsWith('belot_session='))?.split(';')[0] ?? ''

function withDb<T>(databaseFile: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(databaseFile)
  try { return fn(db) } finally { db.close() }
}

type TestUser = { cookie: string; profileId: string; email: string }

async function registerUser(port: number, databaseFile: string, label: string, role: AccountRoleValue): Promise<TestUser> {
  const email = `mkt-${label}-${randomUUID().slice(0, 8)}@example.test`
  const result = await request(port, 'POST', '/api/auth/register', {
    email, password: PASSWORD, displayName: `Mkt${label}${randomUUID().slice(0, 4)}`, gender: 'male', visitorId: randomUUID(),
  })
  assert(result.status === 200, `register ${label}: ${result.status} ${result.text}`)
  if (role !== 'player') {
    withDb(databaseFile, (db) => db.prepare('UPDATE accounts SET role = ? WHERE email = ?').run(role, email))
  }
  const login = await request(port, 'POST', '/api/auth/login', { email, password: PASSWORD, rememberMe: true })
  const cookie = cookieOf(login)
  assert(cookie !== '', `login ${label}: ${login.status}`)
  const me = await request(port, 'GET', '/api/auth/me', undefined, cookie)
  const profileId = ((me.body?.session as { profile?: { profileId?: string } } | undefined)?.profile?.profileId) ?? ''
  assert(profileId !== '', `profileId ${label}`)
  return { cookie, profileId, email }
}

const accountRole = (databaseFile: string, email: string) =>
  withDb(databaseFile, (db) => (db.prepare('SELECT role FROM accounts WHERE email = ?').get(email) as { role: string }).role)

function setVip(databaseFile: string, profileId: string): void {
  const activeUntil = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 19).replace('T', ' ')
  withDb(databaseFile, (db) => db.prepare(`
    INSERT INTO vip_status (profile_id, active_until) VALUES (?, ?)
    ON CONFLICT(profile_id) DO UPDATE SET active_until = excluded.active_until;
  `).run(profileId, activeUntil))
}

function insertMessage(databaseFile: string, input: { topicId: string; sender: TestUser; parentMessageId?: string | null; body?: string }): string {
  const messageId = randomUUID()
  withDb(databaseFile, (db) => db.prepare(`
    INSERT INTO topic_messages (message_id, topic_id, parent_message_id, sender_profile_id, sender_display_name, sender_role, body)
    VALUES (?, ?, ?, ?, 'X', 'player', ?);
  `).run(messageId, input.topicId, input.parentMessageId ?? null, input.sender.profileId, input.body ?? `body ${messageId.slice(0, 6)}`))
  return messageId
}

const deletedAt = (databaseFile: string, messageId: string) =>
  withDb(databaseFile, (db) => (db.prepare('SELECT deleted_at FROM topic_messages WHERE message_id = ?').get(messageId) as { deleted_at: string | null }).deleted_at)

type AnyMsg = Record<string, unknown> & { type: string }
const wsBuffers = new WeakMap<WebSocket, AnyMsg[]>()

function openWs(port: number, cookie: string): Promise<WebSocket> {
  return new Promise((done, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: cookie } })
    const buffer: AnyMsg[] = []
    wsBuffers.set(ws, buffer)
    ws.on('message', (raw: RawData) => { try { buffer.push(JSON.parse(raw.toString())) } catch { /* ignore */ } })
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('WS open timeout')) }, 5000)
    ws.once('open', () => { clearTimeout(timer); done(ws) })
    ws.once('error', (err) => { clearTimeout(timer); reject(err) })
  })
}

async function waitForWs(ws: WebSocket, predicate: (m: AnyMsg) => boolean, timeoutMs = 5000): Promise<AnyMsg> {
  const buffer = wsBuffers.get(ws) ?? []
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const idx = buffer.findIndex(predicate)
    if (idx !== -1) return buffer.splice(idx, 1)[0]!
    await sleep(25)
  }
  throw new Error('timeout waiting for WS message')
}

const pngBuffer = await sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 30, g: 140, b: 220 } } }).png().toBuffer()
const IMAGE_DATA_URL = `data:image/png;base64,${pngBuffer.toString('base64')}`

// ─── Run ────────────────────────────────────────────────────────────────────

console.log('\n═══ Marketing role ═══')

console.log('\n=== M. migration ===')
await check('M1. 20261005_001 запазва роли/sessions/audit/ad редове, разрешава marketing, отхвърля невалидни роли', runMigrationSmoke)

console.log('\n=== P. server permission matrix ===')
for (const [name, predicate, expected] of EXPECTED_PREDICATE_MATRIX) {
  await check(`P. ${name} → [${expected}]`, () => {
    const actual = rolesAllowed(predicate)
    assert(actual === expected, `got [${actual}]`)
  })
}
await check('P. isAdCampaignManagerRole (WS subscribe gate) → admin/pika_team/marketing само', () => {
  const actual = ALL_ROLES.filter((role) => isAdCampaignManagerRole(role)).join(',')
  assert(actual === 'pika_team,marketing,admin', actual)
  assert(!isAdCampaignManagerRole(null), 'null role')
})

console.log('\n=== C. client UX predicates / source wiring ===')
const controller = readSource('src/app/lobby/createLobbyFlowController.ts')
const topicsScreen = readSource('src/app/lobby/renderTopicsScreen.ts')
const lobbyScreen = readSource('src/app/lobby/renderLobbyScreen.ts')
const popup = readSource('src/ui/overlays/renderPlayerProfilePopup.ts')
const main = readSource('src/main.ts')
const indexSource = readFileSync(join(sourceServerRoot, 'src/index.ts'), 'utf8')
const fnBody = (src: string, name: string) => src.match(new RegExp(`function ${name}\\([\\s\\S]*?\\r?\\n}`))?.[0] ?? ''

await check('C1. client isAdCampaignManagerAuthSession включва marketing ("Реклами" nav + panel)', () => {
  const body = fnBody(controller, 'isAdCampaignManagerAuthSession')
  assert(body.includes("'marketing'") && body.includes("'admin'") && body.includes("'pika_team'"), body)
  assert(controller.includes('isAdCampaignManager: isAdCampaignManagerAuthSession(authSession)'), 'render state wiring')
})
await check('C2. client moderator/admin predicates НЕ включват marketing', () => {
  for (const name of [
    'isFullAdminAuthSession', 'isAdminOrSubadminAuthSession', 'isPikaAnnouncementAuthorAuthSession', 'isTopicMessageModeratorAuthSession',
    'isTopicModeratorAuthSession', 'isLafcheModeratorAuthSession', 'isLafcheMessageDeleteModeratorAuthSession', 'isTopicWholeTopicModeratorAuthSession',
  ]) {
    const body = fnBody(controller, name)
    assert(body.length > 0, `${name} missing`)
    assert(!body.includes('marketing'), `${name} must not include marketing`)
  }
})
await check('C3. own-content UX gates: Лафче кошче само върху собствен пост; собствен root с отговори не е blocked', () => {
  assert(/function isLafcheOwnPostDeleteAuthSession[\s\S]*?role === 'marketing'/.test(controller), 'lafche own gate')
  assert(/function isTopicOwnRootCascadeDeleteAuthSession[\s\S]*?role === 'marketing'/.test(controller), 'cascade gate')
  const lafche = fnBody(topicsScreen, 'renderLafcheDeleteButton')
  assert(lafche.includes('state.canDeleteOwnLafchePosts') && lafche.includes('senderProfileId === state.profile.profileId'), lafche)
  const del = fnBody(topicsScreen, 'renderTopicMessageDeleteButton')
  assert(del.includes('!state.canCascadeDeleteOwnTopicRoot'), 'blocked own root must exclude marketing')
})
await check('C4. profile popup: Направи/Премахни Маркетинг само за viewerIsFullAdmin, confirm popup + main.ts → /marketing', () => {
  const controls = fnBody(popup, 'renderMarketingRoleControls')
  assert(controls.includes('!viewerIsFullAdmin') && controls.includes('isOwnProfile'), 'admin-only guard')
  assert(controls.includes('data-player-profile-grant-marketing="1"') && controls.includes('data-player-profile-revoke-marketing="1"'), 'controls')
  assert(controls.includes('>Маркетинг</span>'), 'UI label "Маркетинг"')
  assert(lobbyScreen.includes('data-marketing-action-confirm="1"') && lobbyScreen.includes("'[data-player-profile-grant-marketing=\"1\"]'"), 'confirm + popup wiring')
  assert(main.includes('/marketing`') && main.includes("onAdminGrantMarketing: (profileId) => submitMarketingRoleChange(profileId, 'grant')"), 'main.ts submit')
})
await check('C5. server: marketing role endpoint изисква isFullAdminSession; WS Ads subscribe ползва централния role predicate', () => {
  const endpoint = fnBody(indexSource, 'handleAdminMarketingRoleRequest')
  assert(endpoint.includes('isFullAdminSession(session)') && endpoint.includes('authStore.setMarketingRole'), 'endpoint')
  assert(indexSource.includes('if (isAdCampaignManagerRole(role)) {'), 'WS subscribe gate')
  assert(!indexSource.includes("role === 'admin' || role === 'pika_team') {\n          adCampaignManagement"), 'old inline gate')
})

console.log('\n=== H. HTTP/WS E2E ===')
const isolated = await createIsolatedServerRoot(sourceServerRoot)
const port = await getFreePort()
const server = startServer(isolated.serverDir, port)

try {
  await waitForServer(port)
  withDb(isolated.databaseFile, (db) => db.prepare(`UPDATE admin_settings SET setting_value = 'direct' WHERE setting_key = 'registration_verification_mode'`).run())

  const admin = await registerUser(port, isolated.databaseFile, 'admin', 'admin')
  const subadmin = await registerUser(port, isolated.databaseFile, 'subadmin', 'subadmin')
  const pika = await registerUser(port, isolated.databaseFile, 'pika', 'pika_team')
  const topChat = await registerUser(port, isolated.databaseFile, 'top', 'top_chat_admin')
  const player = await registerUser(port, isolated.databaseFile, 'player', 'player')
  const other = await registerUser(port, isolated.databaseFile, 'other', 'player')
  const marketing = await registerUser(port, isolated.databaseFile, 'marketing', 'player')
  const target = await registerUser(port, isolated.databaseFile, 'target', 'player')

  console.log('\n--- role management (existing profile-popup flow) ---')
  await check('H1. Admin POST /api/admin/profiles/:id/marketing → 200, role=marketing, audit grant_marketing', async () => {
    const res = await request(port, 'POST', `/api/admin/profiles/${marketing.profileId}/marketing`, undefined, admin.cookie)
    assert(res.status === 200 && res.body?.role === 'marketing', `${res.status} ${res.text}`)
    assert(accountRole(isolated.databaseFile, marketing.email) === 'marketing', 'DB role')
    const audit = withDb(isolated.databaseFile, (db) => db.prepare(`
      SELECT a.action, a.previous_role, a.new_role FROM admin_role_audit_log a JOIN accounts t ON t.account_id = a.target_account_id WHERE t.email = ?
    `).all(marketing.email))
    assert(audit.length === 1 && audit[0]!.action === 'grant_marketing' && audit[0]!.previous_role === 'player' && audit[0]!.new_role === 'marketing', JSON.stringify(audit))
  })
  await check('H2. popup role read (GET .../subadmin) връща "marketing" за badge/бутоните', async () => {
    const res = await request(port, 'GET', `/api/admin/profiles/${marketing.profileId}/subadmin`, undefined, admin.cookie)
    assert(res.status === 200 && res.body?.role === 'marketing', res.text)
  })
  await check('H3. повторен grant е идемпотентен (без нов audit ред)', async () => {
    const res = await request(port, 'POST', `/api/admin/profiles/${marketing.profileId}/marketing`, undefined, admin.cookie)
    assert(res.status === 200, res.text)
    const n = withDb(isolated.databaseFile, (db) => (db.prepare(`SELECT COUNT(*) c FROM admin_role_audit_log a JOIN accounts t ON t.account_id = a.target_account_id WHERE t.email = ?`).get(marketing.email) as { c: number }).c)
    assert(n === 1, `audit rows ${n}`)
  })
  for (const [label, actor] of [['guest', null], ['player', player], ['subadmin', subadmin], ['pika_team', pika], ['top_chat_admin', topChat], ['marketing', marketing]] as const) {
    await check(`H4. ${label} НЕ може да grant/revoke marketing (403, ролята непроменена)`, async () => {
      const grant = await request(port, 'POST', `/api/admin/profiles/${target.profileId}/marketing`, undefined, actor?.cookie)
      const revoke = await request(port, 'DELETE', `/api/admin/profiles/${marketing.profileId}/marketing`, undefined, actor?.cookie)
      assert(grant.status === 403 && revoke.status === 403, `${grant.status}/${revoke.status}`)
      assert(accountRole(isolated.databaseFile, target.email) === 'player', 'target changed')
      assert(accountRole(isolated.databaseFile, marketing.email) === 'marketing', 'marketing changed')
    })
  }
  await check('H5. marketing НЕ може да задава ДРУГИ роли (subadmin/chat-admin/pika-team/top-chat-admin → 403) и не може да чете ролите', async () => {
    for (const path of ['subadmin', 'chat-admin', 'pika-team', 'top-chat-admin']) {
      const res = await request(port, 'POST', `/api/admin/profiles/${target.profileId}/${path}`, undefined, marketing.cookie)
      assert(res.status === 403, `${path}: ${res.status}`)
    }
    const read = await request(port, 'GET', `/api/admin/profiles/${target.profileId}/subadmin`, undefined, marketing.cookie)
    assert(read.status === 403, `read ${read.status}`)
    assert(accountRole(isolated.databaseFile, target.email) === 'player', 'target changed')
  })
  await check('H6. Admin revoke → player (audit revoke_marketing); self/admin target защитени', async () => {
    const grant = await request(port, 'POST', `/api/admin/profiles/${target.profileId}/marketing`, undefined, admin.cookie)
    const revoke = await request(port, 'DELETE', `/api/admin/profiles/${target.profileId}/marketing`, undefined, admin.cookie)
    assert(grant.status === 200 && revoke.status === 200 && revoke.body?.role === 'player', `${grant.status}/${revoke.status} ${revoke.text}`)
    assert(accountRole(isolated.databaseFile, target.email) === 'player', 'target role')
    const actions = withDb(isolated.databaseFile, (db) => db.prepare(`SELECT a.action FROM admin_role_audit_log a JOIN accounts t ON t.account_id = a.target_account_id WHERE t.email = ? ORDER BY a.created_at, a.rowid`).all(target.email).map((r) => r.action))
    assert(JSON.stringify(actions) === JSON.stringify(['grant_marketing', 'revoke_marketing']), JSON.stringify(actions))
    const self = await request(port, 'POST', `/api/admin/profiles/${admin.profileId}/marketing`, undefined, admin.cookie)
    assert(self.status === 400 && accountRole(isolated.databaseFile, admin.email) === 'admin', `self ${self.status}`)
  })

  console.log('\n--- Ads ("Реклами") ---')
  const wsMarketing = await openWs(port, marketing.cookie)
  const wsPlayer = await openWs(port, player.cookie)
  wsMarketing.send(JSON.stringify({ type: 'subscribe_ad_campaign_management' }))
  wsPlayer.send(JSON.stringify({ type: 'subscribe_ad_campaign_management' }))
  await sleep(400)

  let adminCampaignId = ''
  let marketingCampaignId = ''
  await check('H7. marketing GET /api/admin/ad-campaigns → 200 (вижда секцията)', async () => {
    const res = await request(port, 'GET', '/api/admin/ad-campaigns', undefined, marketing.cookie)
    assert(res.status === 200 && Array.isArray(res.body?.campaigns), `${res.status} ${res.text}`)
  })
  await check('H8. marketing създава кампания → 200, created_by_role=marketing', async () => {
    const res = await request(port, 'POST', '/api/admin/ad-campaigns', { imageDataUrl: IMAGE_DATA_URL, targetUrl: '/tournaments' }, marketing.cookie)
    assert(res.status === 200, `${res.status} ${res.text}`)
    const campaign = res.body?.campaign as { campaignId: string; createdByRole: string }
    marketingCampaignId = campaign.campaignId
    assert(campaign.createdByRole === 'marketing', JSON.stringify(campaign))
    const row = withDb(isolated.databaseFile, (db) => db.prepare('SELECT created_by_role FROM ad_campaigns WHERE campaign_id = ?').get(marketingCampaignId) as { created_by_role: string })
    assert(row.created_by_role === 'marketing', JSON.stringify(row))
  })
  await check('H9. marketing WS management subscription получава realtime събитие; player — не', async () => {
    const res = await request(port, 'POST', '/api/admin/ad-campaigns', { imageDataUrl: IMAGE_DATA_URL, targetUrl: null }, admin.cookie)
    assert(res.status === 200, res.text)
    adminCampaignId = (res.body?.campaign as { campaignId: string }).campaignId
    await waitForWs(wsMarketing, (m) => m.type === 'ad_campaign_management_created' && (m.campaign as { campaignId?: string })?.campaignId === adminCampaignId)
    await sleep(300)
    assert(!(wsBuffers.get(wsPlayer) ?? []).some((m) => m.type.startsWith('ad_campaign_management_')), 'player received management event')
  })
  await check('H10. marketing изпраща (send) чужда (admin) кампания → 200, sent_by_role=marketing', async () => {
    const res = await request(port, 'POST', `/api/admin/ad-campaigns/${adminCampaignId}/send`, undefined, marketing.cookie)
    assert(res.status === 200, `${res.status} ${res.text}`)
    const row = withDb(isolated.databaseFile, (db) => db.prepare('SELECT sent_by_role, sent_by_profile_id FROM ad_campaign_dispatches WHERE campaign_id = ?').get(adminCampaignId) as { sent_by_role: string; sent_by_profile_id: string })
    assert(row.sent_by_role === 'marketing' && row.sent_by_profile_id === marketing.profileId, JSON.stringify(row))
  })
  await check('H11. marketing изпраща собствена кампания повторно (supersede) → 200', async () => {
    const a = await request(port, 'POST', `/api/admin/ad-campaigns/${marketingCampaignId}/send`, undefined, marketing.cookie)
    const b = await request(port, 'POST', `/api/admin/ad-campaigns/${marketingCampaignId}/send`, undefined, marketing.cookie)
    assert(a.status === 200 && b.status === 200, `${a.status}/${b.status}`)
  })
  await check('H12. marketing изтрива чужда (admin) кампания → 200, deleted_by_role=marketing', async () => {
    const res = await request(port, 'DELETE', `/api/admin/ad-campaigns/${adminCampaignId}`, undefined, marketing.cookie)
    assert(res.status === 200, `${res.status} ${res.text}`)
    const row = withDb(isolated.databaseFile, (db) => db.prepare('SELECT deleted_at, deleted_by_role FROM ad_campaigns WHERE campaign_id = ?').get(adminCampaignId) as { deleted_at: string | null; deleted_by_role: string })
    assert(row.deleted_at !== null && row.deleted_by_role === 'marketing', JSON.stringify(row))
  })
  for (const [label, actor] of [['guest', null], ['player', player], ['subadmin', subadmin], ['top_chat_admin', topChat]] as const) {
    await check(`H13. ${label} НЯМА Ads privileges (list/create/send/delete → 403, без DB промяна)`, async () => {
      const before = withDb(isolated.databaseFile, (db) => JSON.stringify(db.prepare('SELECT * FROM ad_campaigns ORDER BY campaign_id').all()) + JSON.stringify(db.prepare('SELECT COUNT(*) c FROM ad_campaign_dispatches').get()))
      const list = await request(port, 'GET', '/api/admin/ad-campaigns', undefined, actor?.cookie)
      const create = await request(port, 'POST', '/api/admin/ad-campaigns', { imageDataUrl: IMAGE_DATA_URL, targetUrl: '/x' }, actor?.cookie)
      const send = await request(port, 'POST', `/api/admin/ad-campaigns/${marketingCampaignId}/send`, undefined, actor?.cookie)
      const del = await request(port, 'DELETE', `/api/admin/ad-campaigns/${marketingCampaignId}`, undefined, actor?.cookie)
      assert([list, create, send, del].every((r) => r.status === 403), [list, create, send, del].map((r) => r.status).join('/'))
      const after = withDb(isolated.databaseFile, (db) => JSON.stringify(db.prepare('SELECT * FROM ad_campaigns ORDER BY campaign_id').all()) + JSON.stringify(db.prepare('SELECT COUNT(*) c FROM ad_campaign_dispatches').get()))
      assert(before === after, 'DB changed')
    })
  }
  await check('H14. Admin и pika_team запазват пълен Ads достъп (regression) — pika_team трие marketing кампания', async () => {
    const list = await request(port, 'GET', '/api/admin/ad-campaigns', undefined, pika.cookie)
    const del = await request(port, 'DELETE', `/api/admin/ad-campaigns/${marketingCampaignId}`, undefined, pika.cookie)
    const adminList = await request(port, 'GET', '/api/admin/ad-campaigns', undefined, admin.cookie)
    assert(list.status === 200 && del.status === 200 && adminList.status === 200, `${list.status}/${del.status}/${adminList.status}`)
  })
  wsMarketing.close()
  wsPlayer.close()

  console.log('\n--- Лафче / Теми own-content delete ---')
  setVip(isolated.databaseFile, marketing.profileId)
  const wsMkt = await openWs(port, marketing.cookie)
  await check('H15. marketing публикува в Лафче през WS → sender_role snapshot = player (без badge/CHECK грешка)', async () => {
    wsMkt.send(JSON.stringify({ type: 'subscribe_topic_messages', topicId: LAFCHE_TOPIC_ID, afterSeq: 0 }))
    await waitForWs(wsMkt, (m) => m.type === 'topic_message_catchup' && m.topicId === LAFCHE_TOPIC_ID)
    const requestId = randomUUID()
    wsMkt.send(JSON.stringify({ type: 'send_topic_message', topicId: LAFCHE_TOPIC_ID, body: 'marketing lafche post', requestId }))
    const msg = await waitForWs(wsMkt, (m) => (m.type === 'topic_message' || m.type === 'topic_message_error') && m.requestId === requestId)
    assert(msg.type === 'topic_message', JSON.stringify(msg))
    const row = withDb(isolated.databaseFile, (db) => db.prepare('SELECT sender_role FROM topic_messages WHERE message_id = ?').get(msg.messageId as string) as { sender_role: string })
    assert(row.sender_role === 'player', JSON.stringify(row))
    const res = await request(port, 'DELETE', `/api/topics/${LAFCHE_TOPIC_ID}/messages/${msg.messageId as string}`, undefined, marketing.cookie)
    assert(res.status === 200 && deletedAt(isolated.databaseFile, msg.messageId as string) !== null, `${res.status} ${res.text}`)
  })
  await check('H16. marketing изтрива собствен пост в Лафче → 200', async () => {
    const id = insertMessage(isolated.databaseFile, { topicId: LAFCHE_TOPIC_ID, sender: marketing })
    const res = await request(port, 'DELETE', `/api/topics/${LAFCHE_TOPIC_ID}/messages/${id}`, undefined, marketing.cookie)
    assert(res.status === 200 && deletedAt(isolated.databaseFile, id) !== null, `${res.status} ${res.text}`)
    const selfAudit = withDb(isolated.databaseFile, (db) => (db.prepare('SELECT COUNT(*) c FROM topic_message_self_deletion_audit_log WHERE message_id = ?').get(id) as { c: number }).c)
    const modAudit = withDb(isolated.databaseFile, (db) => (db.prepare('SELECT COUNT(*) c FROM topic_message_deletion_audit_log WHERE message_id = ?').get(id) as { c: number }).c)
    assert(selfAudit === 1 && modAudit === 0, `self=${selfAudit} mod=${modAudit} (must be owner path, not moderator)`)
  })
  await check('H17. marketing НЕ може да изтрие чужд пост в Лафче (директна HTTP заявка) → 403, постът остава', async () => {
    const id = insertMessage(isolated.databaseFile, { topicId: LAFCHE_TOPIC_ID, sender: other })
    const res = await request(port, 'DELETE', `/api/topics/${LAFCHE_TOPIC_ID}/messages/${id}`, undefined, marketing.cookie)
    assert(res.status === 403 && deletedAt(isolated.databaseFile, id) === null, `${res.status}`)
  })
  await check('H18. marketing изтрива собствен отговор и собствен пост (без отговори) в Теми → 200', async () => {
    const otherRoot = insertMessage(isolated.databaseFile, { topicId: GENERAL_TOPIC_ID, sender: other })
    const ownReply = insertMessage(isolated.databaseFile, { topicId: GENERAL_TOPIC_ID, sender: marketing, parentMessageId: otherRoot })
    const ownRoot = insertMessage(isolated.databaseFile, { topicId: GENERAL_TOPIC_ID, sender: marketing })
    const r1 = await request(port, 'DELETE', `/api/topics/${GENERAL_TOPIC_ID}/messages/${ownReply}`, undefined, marketing.cookie)
    const r2 = await request(port, 'DELETE', `/api/topics/${GENERAL_TOPIC_ID}/messages/${ownRoot}`, undefined, marketing.cookie)
    assert(r1.status === 200 && r2.status === 200, `${r1.status}/${r2.status}`)
    assert(deletedAt(isolated.databaseFile, ownReply) !== null && deletedAt(isolated.databaseFile, ownRoot) !== null, 'not deleted')
    assert(deletedAt(isolated.databaseFile, otherRoot) === null, 'foreign root must stay')
  })
  await check('H19. marketing НЕ може да изтрие чужд пост/отговор в Теми → 403', async () => {
    const otherRoot = insertMessage(isolated.databaseFile, { topicId: GENERAL_TOPIC_ID, sender: other })
    const otherReply = insertMessage(isolated.databaseFile, { topicId: GENERAL_TOPIC_ID, sender: other, parentMessageId: otherRoot })
    const r1 = await request(port, 'DELETE', `/api/topics/${GENERAL_TOPIC_ID}/messages/${otherReply}`, undefined, marketing.cookie)
    assert(r1.status === 403 && deletedAt(isolated.databaseFile, otherReply) === null, `reply ${r1.status}`)
  })
  await check('H20. marketing изтрива СОБСТВЕНА тема (root) с чужди отговори → 200, root + всички отговори изтрити', async () => {
    const ownRoot = insertMessage(isolated.databaseFile, { topicId: GENERAL_TOPIC_ID, sender: marketing })
    const r1 = insertMessage(isolated.databaseFile, { topicId: GENERAL_TOPIC_ID, sender: other, parentMessageId: ownRoot })
    const r2 = insertMessage(isolated.databaseFile, { topicId: GENERAL_TOPIC_ID, sender: player, parentMessageId: ownRoot })
    const res = await request(port, 'DELETE', `/api/topics/${GENERAL_TOPIC_ID}/messages/${ownRoot}`, undefined, marketing.cookie)
    assert(res.status === 200, `${res.status} ${res.text}`)
    for (const id of [ownRoot, r1, r2]) assert(deletedAt(isolated.databaseFile, id) !== null, `${id} not deleted`)
    const modAudit = withDb(isolated.databaseFile, (db) => (db.prepare('SELECT COUNT(*) c FROM topic_message_deletion_audit_log WHERE message_id = ?').get(ownRoot) as { c: number }).c)
    assert(modAudit === 0, 'must be owner path (self-delete audit), not moderator')
  })
  await check('H21. marketing НЕ може да изтрие ЧУЖДА тема (root с отговори) → 403, нищо не е изтрито', async () => {
    const otherRoot = insertMessage(isolated.databaseFile, { topicId: GENERAL_TOPIC_ID, sender: other })
    const ownReply = insertMessage(isolated.databaseFile, { topicId: GENERAL_TOPIC_ID, sender: marketing, parentMessageId: otherRoot })
    const res = await request(port, 'DELETE', `/api/topics/${GENERAL_TOPIC_ID}/messages/${otherRoot}`, undefined, marketing.cookie)
    assert(res.status === 403, `${res.status}`)
    assert(deletedAt(isolated.databaseFile, otherRoot) === null && deletedAt(isolated.databaseFile, ownReply) === null, 'something deleted')
  })
  await check('H22. edge: messageId от друга тема / несъществуващ → не трие нищо', async () => {
    const own = insertMessage(isolated.databaseFile, { topicId: GENERAL_TOPIC_ID, sender: marketing })
    const wrongTopic = await request(port, 'DELETE', `/api/topics/${LAFCHE_TOPIC_ID}/messages/${own}`, undefined, marketing.cookie)
    const missing = await request(port, 'DELETE', `/api/topics/${GENERAL_TOPIC_ID}/messages/${randomUUID()}`, undefined, marketing.cookie)
    assert(wrongTopic.status === 404 && missing.status === 404, `${wrongTopic.status}/${missing.status}`)
    assert(deletedAt(isolated.databaseFile, own) === null, 'own message in other topic deleted')
  })

  console.log('\n--- marketing НЕ получава moderator/admin права ---')
  await check('H23. mute (Теми и Лафче) → 403, без mute ред', async () => {
    for (const topicId of [GENERAL_TOPIC_ID, LAFCHE_TOPIC_ID]) {
      const res = await request(port, 'POST', `/api/topics/${topicId}/mute`, { profileId: other.profileId, targetProfileId: other.profileId, durationMs: 3_600_000, reason: 'test' }, marketing.cookie)
      assert(res.status === 403, `${topicId}: ${res.status} ${res.text}`)
    }
    const unmute = await request(port, 'POST', `/api/topics/${GENERAL_TOPIC_ID}/unmute`, { profileId: other.profileId, targetProfileId: other.profileId }, marketing.cookie)
    const globalUnmute = await request(port, 'POST', '/api/topics/unmute', { profileId: other.profileId, targetProfileId: other.profileId }, marketing.cookie)
    assert(unmute.status === 403 && globalUnmute.status === 403, `${unmute.status}/${globalUnmute.status}`)
    const mutes = withDb(isolated.databaseFile, (db) => (db.prepare('SELECT COUNT(*) c FROM topic_mute_evidence').get() as { c: number }).c)
    assert(mutes === 0, `mute evidence rows ${mutes}`)
  })
  await check('H24. ban / unban / ban status → 403', async () => {
    const ban = await request(port, 'POST', `/api/admin/profiles/${other.profileId}/ban`, { reason: 'x', durationDays: 1 }, marketing.cookie)
    const unban = await request(port, 'DELETE', `/api/admin/profiles/${other.profileId}/ban`, undefined, marketing.cookie)
    const status = await request(port, 'GET', `/api/admin/profiles/${other.profileId}/ban`, undefined, marketing.cookie)
    assert(ban.status === 403 && unban.status === 403 && status.status === 403, `${ban.status}/${unban.status}/${status.status}`)
  })
  await check('H25. whole-topic lock/unlock/delete (DELETE /api/topics/:id) → 403', async () => {
    const lock = await request(port, 'POST', `/api/topics/${GENERAL_TOPIC_ID}/lock`, { durationMs: 3_600_000, reason: 'x' }, marketing.cookie)
    const unlock = await request(port, 'POST', `/api/topics/${GENERAL_TOPIC_ID}/unlock`, {}, marketing.cookie)
    const del = await request(port, 'DELETE', `/api/topics/${GENERAL_TOPIC_ID}`, { reason: 'x' }, marketing.cookie)
    assert(lock.status === 403 && unlock.status === 403 && del.status === 403, `${lock.status}/${unlock.status}/${del.status}`)
  })
  await check('H26. topic reports / moderation audit log / mute evidence (moderator) → 403', async () => {
    const reports = await request(port, 'GET', '/api/admin/topic-reports', undefined, marketing.cookie)
    const audit = await request(port, 'GET', `/api/admin/topics/${GENERAL_TOPIC_ID}/moderation-log`, undefined, marketing.cookie)
    const evidence = await request(port, 'GET', `/api/topics/mute-evidence/profile/${other.profileId}`, undefined, marketing.cookie)
    assert(reports.status === 403 && audit.status === 403 && evidence.status === 403, `${reports.status}/${audit.status}/${evidence.status}`)
  })
  await check('H27. admin settings / VIP grant / display-name moderation → 403', async () => {
    const settings = await request(port, 'GET', '/api/admin/settings', undefined, marketing.cookie)
    const vip = await request(port, 'POST', `/api/admin/profiles/${other.profileId}/vip-grant`, { days: 5 }, marketing.cookie)
    const name = await request(port, 'POST', `/api/admin/profiles/${other.profileId}/display-name`, { displayName: 'Hacked' }, marketing.cookie)
    assert(settings.status === 403 && vip.status === 403 && name.status === 403, `${settings.status}/${vip.status}/${name.status}`)
  })
  await check('H28. "Публикации от Pika.bg" delete (lobby chat) → 403', async () => {
    const res = await request(port, 'DELETE', `/api/lobby-chat/messages/${randomUUID()}`, undefined, marketing.cookie)
    assert(res.status === 403, `${res.status}`)
  })
  await check('H29. /api/auth/me за marketing връща role=marketing (UX gate-овете се хранят от него)', async () => {
    const me = await request(port, 'GET', '/api/auth/me', undefined, marketing.cookie)
    assert((me.body?.session as { account?: { role?: string } })?.account?.role === 'marketing', me.text)
  })
  await check('H30. "Админ информация"/"Сървър" (admin/subadmin monitoring) → 403 за marketing, 200 за subadmin (regression)', async () => {
    for (const path of ['/api/admin/monitoring/current', '/api/admin/monitoring/connections']) {
      const mkt = await request(port, 'GET', path, undefined, marketing.cookie)
      const sub = await request(port, 'GET', path, undefined, subadmin.cookie)
      assert(mkt.status === 403 && sub.status === 200, `${path}: marketing=${mkt.status} subadmin=${sub.status}`)
    }
  })

  console.log('\n--- Admin / Moderator / player regression ---')
  await check('H31. player: собствен root С отговори → 409 has_live_replies (непроменено); собствен Лафче пост → 403 (непроменено)', async () => {
    const root = insertMessage(isolated.databaseFile, { topicId: GENERAL_TOPIC_ID, sender: player })
    insertMessage(isolated.databaseFile, { topicId: GENERAL_TOPIC_ID, sender: other, parentMessageId: root })
    const r1 = await request(port, 'DELETE', `/api/topics/${GENERAL_TOPIC_ID}/messages/${root}`, undefined, player.cookie)
    assert(r1.status === 409 && deletedAt(isolated.databaseFile, root) === null, `${r1.status}`)
    const lafche = insertMessage(isolated.databaseFile, { topicId: LAFCHE_TOPIC_ID, sender: player })
    const r2 = await request(port, 'DELETE', `/api/topics/${LAFCHE_TOPIC_ID}/messages/${lafche}`, undefined, player.cookie)
    assert(r2.status === 403 && deletedAt(isolated.databaseFile, lafche) === null, `${r2.status}`)
  })
  await check('H32. admin (moderator) трие чужд Лафче пост и чужда тема с отговори → 200 (moderator audit)', async () => {
    const lafche = insertMessage(isolated.databaseFile, { topicId: LAFCHE_TOPIC_ID, sender: other })
    const root = insertMessage(isolated.databaseFile, { topicId: GENERAL_TOPIC_ID, sender: other })
    const reply = insertMessage(isolated.databaseFile, { topicId: GENERAL_TOPIC_ID, sender: player, parentMessageId: root })
    const r1 = await request(port, 'DELETE', `/api/topics/${LAFCHE_TOPIC_ID}/messages/${lafche}`, undefined, admin.cookie)
    const r2 = await request(port, 'DELETE', `/api/topics/${GENERAL_TOPIC_ID}/messages/${root}`, undefined, admin.cookie)
    assert(r1.status === 200 && r2.status === 200, `${r1.status}/${r2.status}`)
    assert(deletedAt(isolated.databaseFile, reply) !== null, 'reply cascade')
    const modAudit = withDb(isolated.databaseFile, (db) => (db.prepare('SELECT COUNT(*) c FROM topic_message_deletion_audit_log WHERE message_id IN (?, ?)').get(lafche, root) as { c: number }).c)
    assert(modAudit === 2, `moderator audit ${modAudit}`)
  })
  await check('H33. pika_team (moderator) трие чужд пост в Теми → 200; top_chat_admin вижда topic reports → 200', async () => {
    const root = insertMessage(isolated.databaseFile, { topicId: GENERAL_TOPIC_ID, sender: other })
    const del = await request(port, 'DELETE', `/api/topics/${GENERAL_TOPIC_ID}/messages/${root}`, undefined, pika.cookie)
    const reports = await request(port, 'GET', '/api/admin/topic-reports', undefined, topChat.cookie)
    assert(del.status === 200 && reports.status === 200, `${del.status}/${reports.status}`)
  })
  await check('H34. admin продължава да управлява другите роли (top-chat-admin grant/revoke → 200)', async () => {
    const g = await request(port, 'POST', `/api/admin/profiles/${target.profileId}/top-chat-admin`, undefined, admin.cookie)
    const r = await request(port, 'DELETE', `/api/admin/profiles/${target.profileId}/top-chat-admin`, undefined, admin.cookie)
    assert(g.status === 200 && r.status === 200 && accountRole(isolated.databaseFile, target.email) === 'player', `${g.status}/${r.status}`)
  })
  await check('H35. admin превключва marketing → pika_team (единична role колона), после обратно', async () => {
    const toPika = await request(port, 'POST', `/api/admin/profiles/${marketing.profileId}/pika-team`, undefined, admin.cookie)
    assert(toPika.status === 200 && accountRole(isolated.databaseFile, marketing.email) === 'pika_team', `${toPika.status}`)
    const back = await request(port, 'POST', `/api/admin/profiles/${marketing.profileId}/marketing`, undefined, admin.cookie)
    assert(back.status === 200 && accountRole(isolated.databaseFile, marketing.email) === 'marketing', `${back.status}`)
  })
  wsMkt.close()
} catch (error) {
  failed += 1
  console.error(`  FAIL  unexpected: ${error instanceof Error ? error.stack : String(error)}`)
  console.error(server.output().split('\n').slice(-30).join('\n'))
} finally {
  await stopServer(server)
  await isolated.cleanup()
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
