import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

let passed = 0
let failed = 0

function check(label: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  PASS  ${label}`)
  } catch (err) {
    failed++
    console.error(`  FAIL  ${label}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

function source(pathFromRoot: string): string {
  return readFileSync(resolve(process.cwd(), '..', pathFromRoot), 'utf8')
}

function runMigrationSmoke(): void {
  const root = mkdtempSync(join(tmpdir(), 'belot-top-chat-admin-role-'))
  const dbPath = join(root, 'test.sqlite')
  const db = new DatabaseSync(dbPath)

  try {
    db.exec(`
      CREATE TABLE accounts (
        account_id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE CHECK (trim(email) <> ''),
        password_hash TEXT NOT NULL CHECK (trim(password_hash) <> ''),
        role TEXT NOT NULL DEFAULT 'player' CHECK (role IN ('player', 'chat_admin', 'pika_team', 'subadmin', 'admin')),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_login_at TEXT NULL
      );
      CREATE TABLE profiles (
        profile_id TEXT PRIMARY KEY,
        account_id TEXT NULL
      );
      CREATE TABLE admin_role_audit_log (
        log_id TEXT PRIMARY KEY,
        actor_account_id TEXT NULL,
        target_account_id TEXT NULL,
        action TEXT NOT NULL CHECK (action IN ('grant_subadmin', 'revoke_subadmin', 'grant_chat_admin', 'revoke_chat_admin', 'grant_pika_team', 'revoke_pika_team')),
        previous_role TEXT NOT NULL CHECK (previous_role IN ('player', 'chat_admin', 'pika_team', 'subadmin', 'admin')),
        new_role TEXT NOT NULL CHECK (new_role IN ('player', 'chat_admin', 'pika_team', 'subadmin', 'admin')),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE lobby_chat_messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL UNIQUE,
        sender_profile_id TEXT NOT NULL,
        sender_display_name TEXT NOT NULL,
        sender_is_chat_admin INTEGER NOT NULL DEFAULT 0 CHECK (sender_is_chat_admin IN (0, 1)),
        sender_role TEXT NOT NULL DEFAULT 'player' CHECK (sender_role IN ('player', 'chat_admin', 'pika_team', 'subadmin', 'admin')),
        body TEXT NOT NULL CHECK (trim(body) <> '' AND length(body) <= 1200),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        deleted_at TEXT NULL,
        deleted_by_profile_id TEXT NULL
      );
      CREATE TABLE lobby_chat_deletion_audit_log (
        log_id TEXT PRIMARY KEY,
        actor_account_id TEXT NULL,
        message_id TEXT NOT NULL,
        sender_profile_id TEXT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        actor_role_at_deletion TEXT NOT NULL DEFAULT 'admin'
          CHECK (actor_role_at_deletion IN ('admin', 'subadmin', 'chat_admin', 'pika_team'))
      );
      CREATE TABLE server_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      INSERT INTO accounts (account_id, email, password_hash, role, status)
      VALUES
        ('a-admin', 'admin@example.test', 'hash', 'admin', 'active'),
        ('a-chat', 'chat@example.test', 'hash', 'chat_admin', 'active'),
        ('a-pika', 'pika@example.test', 'hash', 'pika_team', 'active'),
        ('a-player', 'player@example.test', 'hash', 'player', 'active'),
        ('a-sub', 'sub@example.test', 'hash', 'subadmin', 'active');
      INSERT INTO profiles (profile_id, account_id)
      VALUES ('p-player', 'a-player'), ('p-chat', 'a-chat'), ('p-pika', 'a-pika');
      INSERT INTO admin_role_audit_log (log_id, actor_account_id, target_account_id, action, previous_role, new_role)
      VALUES
        ('audit-chat', 'a-admin', 'a-player', 'grant_chat_admin', 'player', 'chat_admin'),
        ('audit-pika', 'a-admin', 'a-player', 'grant_pika_team', 'chat_admin', 'pika_team');
      INSERT INTO lobby_chat_messages (message_id, sender_profile_id, sender_display_name, sender_is_chat_admin, sender_role, body)
      VALUES
        ('m-player', 'p-player', 'Player', 0, 'player', 'hello'),
        ('m-chat', 'p-chat', 'Chat Admin', 1, 'chat_admin', 'moderator hello'),
        ('m-pika', 'p-pika', 'Pika Team', 0, 'pika_team', 'official hello');
      INSERT INTO lobby_chat_deletion_audit_log (log_id, actor_account_id, message_id, sender_profile_id, actor_role_at_deletion)
      VALUES
        ('del-chat', 'a-chat', 'm-player', 'p-player', 'chat_admin'),
        ('del-pika', 'a-pika', 'm-chat', 'p-chat', 'pika_team');
    `)

    const migration = readFileSync(resolve(process.cwd(), 'database/migrations/20260802_002_add_top_chat_admin_role.sql'), 'utf8')
    db.exec(migration)

    const roles = db.prepare(`SELECT account_id, role FROM accounts ORDER BY account_id`).all() as Array<{ account_id: string; role: string }>
    assert(JSON.stringify(roles) === JSON.stringify([
      { account_id: 'a-admin', role: 'admin' },
      { account_id: 'a-chat', role: 'chat_admin' },
      { account_id: 'a-pika', role: 'pika_team' },
      { account_id: 'a-player', role: 'player' },
      { account_id: 'a-sub', role: 'subadmin' },
    ]), `existing roles changed: ${JSON.stringify(roles)}`)

    db.prepare(`INSERT INTO accounts (account_id, email, password_hash, role) VALUES ('a-top', 'top@example.test', 'hash', 'top_chat_admin')`).run()
    let invalidRejected = false
    try {
      db.prepare(`INSERT INTO accounts (account_id, email, password_hash, role) VALUES ('a-bad', 'bad@example.test', 'hash', 'superuser')`).run()
    } catch {
      invalidRejected = true
    }
    assert(invalidRejected, 'accounts.role CHECK must reject invalid roles')

    db.prepare(`
      INSERT INTO admin_role_audit_log (log_id, actor_account_id, target_account_id, action, previous_role, new_role)
      VALUES ('audit-top', 'a-admin', 'a-player', 'grant_top_chat_admin', 'pika_team', 'top_chat_admin')
    `).run()
    db.prepare(`
      INSERT INTO lobby_chat_messages (message_id, sender_profile_id, sender_display_name, sender_role, body)
      VALUES ('m-top', 'p-player', 'Top', 'top_chat_admin', 'top hello')
    `).run()
    db.prepare(`
      INSERT INTO lobby_chat_deletion_audit_log (log_id, actor_account_id, message_id, sender_profile_id, actor_role_at_deletion)
      VALUES ('del-top', 'a-top', 'm-pika', 'p-pika', 'top_chat_admin')
    `).run()

    const senderRoles = db.prepare(`SELECT message_id, sender_role FROM lobby_chat_messages ORDER BY message_id`).all() as Array<{ message_id: string; sender_role: string }>
    assert(senderRoles.some((row) => row.message_id === 'm-top' && row.sender_role === 'top_chat_admin'), 'sender_role CHECK must allow top_chat_admin')

    const marker = db.prepare(`SELECT filename FROM server_migrations WHERE filename = '20260802_002_add_top_chat_admin_role.sql'`).get()
    assert(Boolean(marker), 'migration marker missing')
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
}

console.log('\ncheckTopChatAdminRole')

const authStore = source('server/src/db/authStore.ts')
const index = source('server/src/index.ts')
const controller = source('src/app/lobby/createLobbyFlowController.ts')
const renderer = source('src/app/lobby/renderLobbyScreen.ts')
const popup = source('src/ui/overlays/renderPlayerProfilePopup.ts')
const main = source('src/main.ts')
const protocol = source('server/src/protocol/messageTypes.ts')
const clientProtocol = source('src/app/network/createGameServerClient.ts')

check('[1] DB migration preserves existing roles and allows top_chat_admin in all role CHECK constraints', runMigrationSmoke)

check('[2] server delete authorization explicitly allows admin/subadmin/chat_admin/pika_team/top_chat_admin only', () => {
  const helper = authStore.match(/function isLobbyChatModeratorSession[\s\S]*?\n}/)?.[0] ?? ''
  assert(helper.includes("role === 'admin'"), 'admin missing from moderator allowlist')
  assert(helper.includes("role === 'subadmin'"), 'subadmin missing from moderator allowlist')
  assert(helper.includes("role === 'chat_admin'"), 'chat_admin missing from moderator allowlist')
  assert(helper.includes("role === 'pika_team'"), 'pika_team missing from moderator allowlist')
  assert(helper.includes("role === 'top_chat_admin'"), 'top_chat_admin missing from moderator allowlist')
  assert(!helper.includes("role === 'player'"), 'player must not be part of moderator allowlist')
  assert(index.includes("actorRoleAtDeletion: session.account.role as 'admin' | 'subadmin' | 'chat_admin' | 'pika_team' | 'top_chat_admin'"), 'delete audit cast missing top_chat_admin')
})

check('[3] top_chat_admin does not gain admin/subadmin section access or role management access', () => {
  const serverAdminOrSubadmin = authStore.match(/function isAdminOrSubadminSession[\s\S]*?\n}/)?.[0] ?? ''
  const clientAdminOrSubadmin = controller.match(/function isAdminOrSubadminAuthSession[\s\S]*?\n}/)?.[0] ?? ''
  const fullAdmin = authStore.match(/function isFullAdminSession[\s\S]*?\n}/)?.[0] ?? ''
  assert(!serverAdminOrSubadmin.includes('top_chat_admin'), 'server admin/subadmin helper must not include top_chat_admin')
  assert(!clientAdminOrSubadmin.includes('top_chat_admin'), 'client admin/subadmin helper must not include top_chat_admin')
  assert(!fullAdmin.includes('top_chat_admin'), 'full admin helper must not include top_chat_admin')
})

check('[4] only full admin can grant/revoke top_chat_admin through endpoint and existing profile popup controls', () => {
  assert(/handleAdminTopChatAdminRoleRequest[\s\S]*isFullAdminSession\(session\)[\s\S]*setTopChatAdminRole/.test(index), 'top-chat-admin endpoint must require full admin and call setTopChatAdminRole')
  assert(main.includes('/top-chat-admin'), 'frontend submit helper must hit /top-chat-admin')
  assert(popup.includes('data-player-profile-grant-top-chat-admin="1"'), 'profile popup grant control missing')
  assert(popup.includes('data-player-profile-revoke-top-chat-admin="1"'), 'profile popup revoke control missing')
  assert(renderer.includes('data-top-chat-admin-action-confirm="1"'), 'confirm popup wiring missing')
})

check('[5] non-admin elevated roles cannot assign roles', () => {
  const endpoint = index.match(/async function handleAdminTopChatAdminRoleRequest[\s\S]*?\n}\n\nasync function handleProfileBlockRequest/)?.[0] ?? ''
  assert(index.includes('Само администратор може да управлява роли.') || index.includes('РЎР°РјРѕ Р°РґРјРёРЅРёСЃС‚СЂР°С‚РѕСЂ'), 'role endpoints must keep forbidden message')
  assert(endpoint.includes('isFullAdminSession(session)'), 'top_chat_admin endpoint must use full admin helper')
  assert(!endpoint.includes('isAdminOrSubadminSession(session)'), 'top_chat_admin endpoint must not allow subadmin path')
  assert(!endpoint.includes('isLobbyChatModeratorSession(session)'), 'top_chat_admin endpoint must not allow lobby moderators to assign roles')
})

check('[6] senderRole snapshot/payload supports top_chat_admin through DB, server protocol, client protocol, history, live event, and rerender', () => {
  const union = "senderRole: 'player' | 'chat_admin' | 'pika_team' | 'top_chat_admin' | 'subadmin' | 'admin'"
  assert(protocol.includes(union), 'server protocol missing top_chat_admin senderRole')
  assert(clientProtocol.includes(union), 'client protocol missing top_chat_admin senderRole')
  assert(index.includes('senderRole: m.senderRole'), 'history/reconnect payload missing senderRole')
  assert(index.includes('senderRole: snapshot.senderRole'), 'live broadcast missing senderRole')
  assert(renderer.includes("senderRole === 'top_chat_admin'"), 'client renderer missing top_chat_admin branch')
})

check('[7] top_chat_admin and chat_admin names use the shared purple glow style only for the author name; existing defaults remain', () => {
  assert(renderer.includes('#c084fc'), 'top_chat_admin purple color missing')
  assert(renderer.includes('rgba(192,132,252,0.42)'), 'top_chat_admin purple glow missing')
  assert(renderer.includes("senderRole === 'pika_team'") && renderer.includes('#ef4444'), 'pika_team red style changed/missing')
  assert(renderer.includes("senderRole === 'top_chat_admin' || senderRole === 'chat_admin'"), 'chat_admin must share the top_chat_admin purple style')
  assert(renderer.includes('#d4a520'), 'default gold color changed/missing')
  assert(renderer.includes('color:#f1f5f9;font-weight:500;'), 'message body style should remain separate from author color')
})

check('[8] desktop, mobile compact, and mobile fullscreen reuse the same lobby chat panel/message row path', () => {
  assert(renderer.includes('renderLobbyChatPanel(state, { isGuest, compact: false })'), 'desktop chat panel path missing')
  assert(renderer.includes('renderLobbyChatPanel(state, { isGuest, compact: true, fullscreen: isFullscreen })'), 'mobile compact/fullscreen chat panel path missing')
  assert(/function renderLobbyChatPanel[\s\S]*renderLobbyChatMessageRow/.test(renderer), 'chat panel must render rows through shared renderer')
})

check('[9] no source assigns top_chat_admin to a real profile or performs a production DB role update', () => {
  const combined = [authStore, index, controller, renderer, popup, main].join('\n')
  assert(!/PIKABG[\s\S]{0,120}top_chat_admin|top_chat_admin[\s\S]{0,120}PIKABG/i.test(combined), 'source appears to hard-code top_chat_admin for PIKABG')
  assert(!/UPDATE\s+accounts\s+SET\s+role\s*=\s*['"]top_chat_admin/i.test(combined), 'source appears to perform manual role update')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
