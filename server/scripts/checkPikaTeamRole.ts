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
  const root = mkdtempSync(join(tmpdir(), 'belot-pika-team-role-'))
  const dbPath = join(root, 'test.sqlite')
  const db = new DatabaseSync(dbPath)

  try {
    db.exec(`
      CREATE TABLE accounts (
        account_id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE CHECK (trim(email) <> ''),
        password_hash TEXT NOT NULL CHECK (trim(password_hash) <> ''),
        role TEXT NOT NULL DEFAULT 'player' CHECK (role IN ('player', 'chat_admin', 'subadmin', 'admin')),
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
        action TEXT NOT NULL CHECK (action IN ('grant_subadmin', 'revoke_subadmin', 'grant_chat_admin', 'revoke_chat_admin')),
        previous_role TEXT NOT NULL CHECK (previous_role IN ('player', 'chat_admin', 'subadmin', 'admin')),
        new_role TEXT NOT NULL CHECK (new_role IN ('player', 'chat_admin', 'subadmin', 'admin')),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE lobby_chat_messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL UNIQUE,
        sender_profile_id TEXT NOT NULL,
        sender_display_name TEXT NOT NULL,
        sender_is_chat_admin INTEGER NOT NULL DEFAULT 0,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        deleted_at TEXT NULL
      );
      CREATE TABLE lobby_chat_deletion_audit_log (
        log_id TEXT PRIMARY KEY,
        actor_account_id TEXT NULL,
        message_id TEXT NOT NULL,
        sender_profile_id TEXT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        actor_role_at_deletion TEXT NOT NULL DEFAULT 'admin'
          CHECK (actor_role_at_deletion IN ('admin', 'subadmin', 'chat_admin'))
      );
      CREATE TABLE server_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      INSERT INTO accounts (account_id, email, password_hash, role, status)
      VALUES
        ('a-player', 'player@example.test', 'hash', 'player', 'active'),
        ('a-chat', 'chat@example.test', 'hash', 'chat_admin', 'active'),
        ('a-sub', 'sub@example.test', 'hash', 'subadmin', 'active'),
        ('a-admin', 'admin@example.test', 'hash', 'admin', 'active');
      INSERT INTO profiles (profile_id, account_id)
      VALUES ('p-player', 'a-player'), ('p-chat', 'a-chat');
      INSERT INTO admin_role_audit_log (log_id, actor_account_id, target_account_id, action, previous_role, new_role)
      VALUES ('audit-1', 'a-admin', 'a-player', 'grant_chat_admin', 'player', 'chat_admin');
      INSERT INTO lobby_chat_messages (message_id, sender_profile_id, sender_display_name, sender_is_chat_admin, body)
      VALUES
        ('m-player', 'p-player', 'Player', 0, 'hello'),
        ('m-chat', 'p-chat', 'Chat Admin', 1, 'moderator hello');
      INSERT INTO lobby_chat_deletion_audit_log (log_id, actor_account_id, message_id, sender_profile_id, actor_role_at_deletion)
      VALUES ('del-1', 'a-admin', 'm-player', 'p-player', 'chat_admin');
    `)

    const migration = readFileSync(resolve(process.cwd(), 'database/migrations/20260802_001_add_pika_team_role.sql'), 'utf8')
    db.exec(migration)

    const roles = db.prepare(`SELECT account_id, role FROM accounts ORDER BY account_id`).all() as Array<{ account_id: string; role: string }>
    assert(JSON.stringify(roles) === JSON.stringify([
      { account_id: 'a-admin', role: 'admin' },
      { account_id: 'a-chat', role: 'chat_admin' },
      { account_id: 'a-player', role: 'player' },
      { account_id: 'a-sub', role: 'subadmin' },
    ]), `existing roles changed: ${JSON.stringify(roles)}`)

    db.prepare(`INSERT INTO accounts (account_id, email, password_hash, role) VALUES ('a-pika', 'pika@example.test', 'hash', 'pika_team')`).run()
    let invalidRejected = false
    try {
      db.prepare(`INSERT INTO accounts (account_id, email, password_hash, role) VALUES ('a-bad', 'bad@example.test', 'hash', 'superuser')`).run()
    } catch {
      invalidRejected = true
    }
    assert(invalidRejected, 'accounts.role CHECK must still reject invalid roles')

    const messages = db.prepare(`SELECT message_id, sender_role FROM lobby_chat_messages ORDER BY message_id`).all() as Array<{ message_id: string; sender_role: string }>
    assert(JSON.stringify(messages) === JSON.stringify([
      { message_id: 'm-chat', sender_role: 'chat_admin' },
      { message_id: 'm-player', sender_role: 'player' },
    ]), `lobby message sender_role backfill mismatch: ${JSON.stringify(messages)}`)

    db.prepare(`
      INSERT INTO admin_role_audit_log (log_id, actor_account_id, target_account_id, action, previous_role, new_role)
      VALUES ('audit-pika', 'a-admin', 'a-player', 'grant_pika_team', 'player', 'pika_team')
    `).run()
    db.prepare(`
      INSERT INTO lobby_chat_deletion_audit_log (log_id, actor_account_id, message_id, sender_profile_id, actor_role_at_deletion)
      VALUES ('del-pika', 'a-pika', 'm-chat', 'p-chat', 'pika_team')
    `).run()

    const marker = db.prepare(`SELECT filename FROM server_migrations WHERE filename = '20260802_001_add_pika_team_role.sql'`).get()
    assert(Boolean(marker), 'migration marker missing')
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
}

check('[1] DB migration preserves existing roles, allows pika_team, backfills old lobby chat messages safely', runMigrationSmoke)

const authStore = source('server/src/db/authStore.ts')
const index = source('server/src/index.ts')
const controller = source('src/app/lobby/createLobbyFlowController.ts')
const renderer = source('src/app/lobby/renderLobbyScreen.ts')
const popup = source('src/ui/overlays/renderPlayerProfilePopup.ts')
const main = source('src/main.ts')
const protocol = source('server/src/protocol/messageTypes.ts')
const clientProtocol = source('src/app/network/createGameServerClient.ts')

check('[2] "Публикации от Pika.bg" delete authorization explicitly allows admin/pika_team only', () => {
  // isLobbyChatModeratorSession (5-роли allowlist) остава в authStore.ts за
  // съвместимост/reuse другаде, но вече НЕ се ползва за lobby-chat delete —
  // "Публикации от Pika.bg" брифа §3 стесни delete до admin/pika_team само,
  // виж isPikaAnnouncementAuthorSession.
  assert(/isPikaAnnouncementAuthorSession[\s\S]{0,200}role === 'admin'[\s\S]{0,80}role === 'pika_team'/.test(authStore), 'isPikaAnnouncementAuthorSession missing or allowlist changed')
  assert(index.includes("actorRoleAtDeletion: session.account.role as 'admin' | 'pika_team'"), 'delete audit cast should be narrowed to admin | pika_team only')
  assert(!authStore.includes("role === 'player'\n    || session.account.role === 'pika_team'"), 'player must not be part of delete allowlist')
})

check('[3] pika_team does not gain admin/subadmin section access', () => {
  const serverHelper = authStore.match(/function isAdminOrSubadminSession[\s\S]*?\n}/)?.[0] ?? ''
  const clientHelper = controller.match(/function isAdminOrSubadminAuthSession[\s\S]*?\n}/)?.[0] ?? ''
  assert(serverHelper.includes("session.account.role === 'admin' || session.account.role === 'subadmin'"), 'server admin/subadmin helper changed unexpectedly')
  assert(!serverHelper.includes('pika_team'), 'server admin/subadmin helper must not include pika_team')
  assert(clientHelper.includes("session.account.role === 'admin' || session.account.role === 'subadmin'"), 'client admin/subadmin helper changed unexpectedly')
  assert(!clientHelper.includes('pika_team'), 'client admin/subadmin helper must not include pika_team')
})

check('[4] only full admin can grant/revoke pika_team through the admin endpoint and UI callback', () => {
  assert(index.includes('/api/admin/profiles/:id/pika-team') || index.includes('/pika-team'), 'pika-team endpoint missing')
  assert(/handleAdminPikaTeamRoleRequest[\s\S]*isFullAdminSession\(session\)[\s\S]*setPikaTeamRole/.test(index), 'pika-team endpoint must require full admin and call setPikaTeamRole')
  assert(main.includes('/pika-team'), 'frontend submit helper must hit /pika-team')
  assert(popup.includes('data-player-profile-grant-pika-team="1"'), 'profile popup grant control missing')
  assert(popup.includes('data-player-profile-revoke-pika-team="1"'), 'profile popup revoke control missing')
})

check('[5] lobby chat messages carry senderRole through DB, protocol, live events, reconnect/history, and client rerender', () => {
  assert(protocol.includes("senderRole: 'player' | 'chat_admin' | 'pika_team' | 'top_chat_admin' | 'subadmin' | 'admin'"), 'server protocol missing senderRole')
  assert(clientProtocol.includes("senderRole: 'player' | 'chat_admin' | 'pika_team' | 'top_chat_admin' | 'subadmin' | 'admin'"), 'client protocol missing senderRole')
  assert(index.includes('senderRole: m.senderRole'), 'history/reconnect payload missing senderRole')
  assert(index.includes('senderRole: snapshot.senderRole'), 'live broadcast missing senderRole')
  assert(controller.includes('senderRole: resolveLobbyChatSenderRole(message)'), 'client live event shared role normalization missing')
})

check('[6] pika_team author name uses previous chat-admin purple glow in the shared lobby chat row renderer', () => {
  assert(renderer.includes("senderRole === 'pika_team'"), 'renderer must branch on pika_team')
  assert(renderer.includes('#c084fc'), 'pika_team purple color missing')
  assert(renderer.includes('rgba(192,132,252,0.42)') && renderer.includes('rgba(192,132,252,0.22)'), 'pika_team purple glow missing')
  assert(renderer.includes('#d4a520'), 'default gold color changed/missing')
  assert(renderer.includes('color:#f1f5f9;font-weight:500;'), 'message body style should remain separate from author color')
})

check('[7] desktop, mobile compact, and mobile fullscreen reuse the same lobby chat panel/message row path', () => {
  assert(renderer.includes('renderLobbyChatPanel(state, { isGuest, compact: false })'), 'desktop chat panel path missing')
  assert(renderer.includes('renderLobbyChatPanel(state, { isGuest, compact: true, fullscreen: isFullscreen })'), 'mobile compact/fullscreen chat panel path missing')
  assert(/function renderLobbyChatPanel[\s\S]*renderLobbyChatMessageRow/.test(renderer), 'chat panel must render rows through shared renderer')
})

check('[8] no source assigns pika_team to PIKABG or performs a production DB role update', () => {
  const combined = [authStore, index, controller, renderer, popup, main].join('\n')
  assert(!/PIKABG[\s\S]{0,120}pika_team|pika_team[\s\S]{0,120}PIKABG/i.test(combined), 'source appears to hard-code pika_team for PIKABG')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
