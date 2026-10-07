/**
 * checkProtectedStaffProfileBlock.ts
 *
 * Защита от блокиране САМО за профили с account role 'pika_team' или
 * 'marketing' (екип Pika.bg). admin / subadmin / chat_admin / top_chat_admin /
 * player остават блокируеми. Real spawned isolated server + real HTTP +
 * директна проверка на SQLite.
 *
 *   [P1]  isProtectedStaffRole: само pika_team/marketing -> true
 *   [1-5] player -> player/admin/subadmin/chat_admin/top_chat_admin: block работи
 *   [6-7] player -> pika_team/marketing: 403 PROTECTED_STAFF_PROFILE + точен текст
 *   [8]   отказът не създава ред в player_blocks (нито друг side effect в таблицата)
 *   [9]   отказът не консумира slot от block лимита (49 -> отказ -> 50-ти block минава)
 *   [10]  при пълен лимит отказът е PROTECTED_STAFF_PROFILE, броят не се променя
 *   [11]  стар (legacy) block към защитен профил може да бъде премахнат (toggle unblock)
 *   [12]  admin grant pika_team -> incoming blocks изтрити, outgoing/чужди остават
 *   [13]  admin grant marketing -> incoming blocks изтрити
 *   [14]  admin grant chat_admin НЕ трие incoming blocks (не е защитена роля)
 *   [15]  revoke pika_team -> старите редове НЕ се връщат; профилът е пак блокируем
 *   [16]  migration 20261007_001: трие incoming към pika_team/marketing, не трие
 *         към admin/subadmin/chat_admin/top_chat_admin/player, не трие outgoing
 *   [17]  invariant-ът е в blockStore.toggleBlock (BEGIN IMMEDIATE: role check +
 *         INSERT атомарно); единствен INSERT в player_blocks; endpoint-ът само
 *         превежда резултата; няма WS/друг bypass
 *   [18]  cross-process race: block request в ДРУГ процес, стартиран докато
 *         promotion транзакцията (UPDATE role + DELETE incoming) е отворена,
 *         изчаква и вижда защитената роля -> отказ, без ред
 *   [19]  контрола: същият race с ROLLBACK на promotion-а -> block минава
 *
 * Usage (от server/): tsx scripts/checkProtectedStaffProfileBlock.ts [--server-root=.]
 */

import { randomBytes, randomUUID, scryptSync } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  isProtectedStaffRole,
  PROTECTED_STAFF_PROFILE_BLOCK_MESSAGE,
  PROTECTED_STAFF_PROFILE_ERROR_CODE,
} from '../src/core/protectedStaffProfiles.js'
import { BLOCK_LIMIT } from '../src/db/blockStore.js'

const SESSION_COOKIE_NAME = 'belot_session'
const MIGRATION_FILE = '20261007_001_remove_blocks_to_protected_staff_profiles.sql'
const EXPECTED_MESSAGE = 'Не можете да блокирате профил от екипа на Pika.bg.'

let passed = 0
let failed = 0

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`PASS ${label}`)
  } catch (error) {
    failed++
    console.error(`FAIL ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function getFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Could not allocate a free port.')))
        return
      }
      server.close(() => resolvePort(address.port))
    })
  })
}

// ─── Isolated server ──────────────────────────────────────────────────────

const sourceServerRoot = resolve(
  process.argv.slice(2).find((a) => a.startsWith('--server-root='))?.slice('--server-root='.length) ?? process.cwd(),
)

async function retryRm(path: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try { await rm(path, { recursive: true, force: true }); return } catch { /* retry */ }
    await sleep(250)
  }
}

async function createIsolatedServerRoot(originalServerRoot: string) {
  const root = await mkdtemp(join(tmpdir(), 'belot-protected-staff-block-'))
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
  return {
    serverDir,
    databaseFile: join(serverDir, 'database', 'data', 'belot-v2.sqlite'),
    cleanup: () => retryRm(root),
  }
}

type RunningServer = { child: ChildProcessWithoutNullStreams; output(): string }

function startServer(serverDir: string, port: number): RunningServer {
  const chunks: string[] = []
  const child = spawn(
    process.execPath,
    [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'index.ts')],
    { cwd: serverDir, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (c) => chunks.push(c))
  child.stderr.on('data', (c) => chunks.push(c))
  return { child, output: () => chunks.join('') }
}

async function waitForServer(server: RunningServer, port: number): Promise<void> {
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) throw new Error(`Server exited early:\n${server.output()}`)
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`)
      if (r.ok) return
    } catch { /* retry */ }
    await sleep(150)
  }
  throw new Error(`Server did not become ready:\n${server.output()}`)
}

async function stopServer(server: RunningServer | null): Promise<void> {
  if (!server || server.child.exitCode !== null) return
  server.child.kill('SIGTERM')
  await new Promise<void>((r) => {
    const t = setTimeout(() => { server.child.kill('SIGKILL'); r() }, 10_000)
    server.child.once('exit', () => { clearTimeout(t); r() })
  })
}

// ─── Direct DB seeding ────────────────────────────────────────────────────

function hashSessionToken(token: string): string {
  return scryptSync(token, 'belot-v2-session-v1', 32).toString('hex')
}

type Role = 'player' | 'admin' | 'subadmin' | 'chat_admin' | 'top_chat_admin' | 'pika_team' | 'marketing'
type SeededUser = { cookie: string; profileId: string; accountId: string; tag: string }

function openDb(databaseFile: string): DatabaseSync {
  const db = new DatabaseSync(databaseFile, { open: true, timeout: 10_000 })
  db.exec('PRAGMA busy_timeout = 10000;')
  return db
}

function seedUser(databaseFile: string, tag: string, role: Role = 'player'): SeededUser {
  const db = openDb(databaseFile)
  db.exec('PRAGMA foreign_keys = ON;')
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const accountId = randomUUID()
  const profileId = randomUUID()
  const displayName = `Staff ${tag} ${runId.slice(-4)}`
  const normalized = displayName.toLowerCase()
  const token = randomBytes(32).toString('base64url')
  db.exec('BEGIN IMMEDIATE;')
  try {
    db.prepare(`INSERT INTO accounts (account_id, email, password_hash, role, status) VALUES (?, ?, 'not-used-seeded-directly', ?, 'active');`)
      .run(accountId, `protected-staff-${tag}-${runId}@example.test`, role)
    db.prepare(`
      INSERT INTO profiles (
        profile_id, account_id, profile_kind, username, normalized_username,
        display_name, normalized_display_name, avatar_url, level, rank_title,
        skill_rating, gender, status
      ) VALUES (?, ?, 'human', ?, ?, ?, ?, NULL, 1, 'Rank 1', 1000, 'male', 'active');
    `).run(profileId, accountId, displayName, normalized, displayName, normalized)
    db.prepare(`INSERT INTO profile_wallets (profile_id, yellow_coins_balance) VALUES (?, 1000);`).run(profileId)
    db.prepare(`INSERT INTO profile_progress (profile_id, completed_games_count, won_games_count, rank_level) VALUES (?, 0, 0, 1);`).run(profileId)
    db.prepare(`INSERT INTO account_sessions (session_id, account_id, profile_id, token_hash, expires_at) VALUES (?, ?, ?, ?, ?);`)
      .run(randomUUID(), accountId, profileId, hashSessionToken(token), new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString())
    db.exec('COMMIT;')
  } catch (error) {
    try { db.exec('ROLLBACK;') } catch { /* keep original */ }
    throw error
  } finally {
    db.close()
  }
  return { cookie: `${SESSION_COOKIE_NAME}=${token}`, profileId, accountId, tag }
}

function hasBlockRow(databaseFile: string, blocker: string, blocked: string): boolean {
  const db = openDb(databaseFile)
  try {
    return db.prepare('SELECT 1 FROM player_blocks WHERE blocker_profile_id = ? AND blocked_profile_id = ?').get(blocker, blocked) !== undefined
  } finally {
    db.close()
  }
}

function countBlocks(databaseFile: string, where = '1 = 1', ...params: string[]): number {
  const db = openDb(databaseFile)
  try {
    return (db.prepare(`SELECT COUNT(*) AS c FROM player_blocks WHERE ${where}`).get(...params) as { c: number }).c
  } finally {
    db.close()
  }
}

function insertBlockRow(databaseFile: string, blocker: string, blocked: string): void {
  const db = openDb(databaseFile)
  try {
    db.prepare('INSERT OR IGNORE INTO player_blocks (blocker_profile_id, blocked_profile_id) VALUES (?, ?)').run(blocker, blocked)
  } finally {
    db.close()
  }
}

function readRole(databaseFile: string, accountId: string): string | null {
  const db = openDb(databaseFile)
  try {
    return (db.prepare('SELECT role FROM accounts WHERE account_id = ?').get(accountId) as { role: string } | undefined)?.role ?? null
  } finally {
    db.close()
  }
}

// Windows: след kill-а на сървърния процес SQLite файлът (WAL/SHM) може за
// кратко да е още заключен ("disk I/O error") — изчакваме, докато е достъпен.
async function waitForDatabaseReleased(databaseFile: string): Promise<void> {
  let lastError: unknown = null
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const probe = openDb(databaseFile)
      try {
        probe.exec('BEGIN IMMEDIATE; COMMIT;')
        return
      } finally {
        probe.close()
      }
    } catch (error) {
      lastError = error
      await sleep(250)
    }
  }
  throw lastError
}

// ─── HTTP ─────────────────────────────────────────────────────────────────

type JsonResponse = { status: number; body: Record<string, any> }

async function requestJson(port: number, method: 'GET' | 'POST' | 'DELETE', pathname: string, cookie: string | null): Promise<JsonResponse> {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: cookie ? { Cookie: cookie } : {},
  })
  const body = await response.json().catch(() => ({})) as Record<string, any>
  return { status: response.status, body }
}

function postBlock(port: number, actor: SeededUser, target: SeededUser | string): Promise<JsonResponse> {
  const targetId = typeof target === 'string' ? target : target.profileId
  return requestJson(port, 'POST', `/api/profiles/${encodeURIComponent(targetId)}/block`, actor.cookie)
}

function assertBlockedOk(r: JsonResponse, label: string): void {
  assert(r.status === 200 && r.body.ok === true && r.body.blocked === true, `${label}: expected 200 blocked=true, got ${r.status} ${JSON.stringify(r.body)}`)
}

function assertProtectedRejection(r: JsonResponse, label: string): void {
  assert(r.status === 403, `${label}: expected 403, got ${r.status} ${JSON.stringify(r.body)}`)
  assert(r.body.ok === false, `${label}: expected ok=false`)
  assert(r.body.code === 'PROTECTED_STAFF_PROFILE', `${label}: code=${r.body.code}`)
  assert(r.body.message === EXPECTED_MESSAGE, `${label}: message=${r.body.message}`)
  assert(!String(r.body.message).includes('модератор'), `${label}: message must not mention "модератор"`)
  assert(r.body.blocked === undefined && r.body.limitReached === undefined, `${label}: unexpected blocked/limitReached fields`)
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('═══ checkProtectedStaffProfileBlock ═══')

  await check('[P1] isProtectedStaffRole: only pika_team and marketing are protected', () => {
    assert(isProtectedStaffRole('pika_team') === true, 'pika_team must be protected')
    assert(isProtectedStaffRole('marketing') === true, 'marketing must be protected')
    for (const role of ['player', 'admin', 'subadmin', 'chat_admin', 'top_chat_admin', '', 'PIKA_TEAM', null, undefined]) {
      assert(isProtectedStaffRole(role as string | null | undefined) === false, `${String(role)} must NOT be protected`)
    }
    assert(PROTECTED_STAFF_PROFILE_ERROR_CODE === 'PROTECTED_STAFF_PROFILE', 'error code constant')
    assert(PROTECTED_STAFF_PROFILE_BLOCK_MESSAGE === EXPECTED_MESSAGE, 'message constant')
  })

  const isolated = await createIsolatedServerRoot(sourceServerRoot)
  const db = isolated.databaseFile
  const port = await getFreePort()
  let server: RunningServer | null = null

  try {
    server = startServer(isolated.serverDir, port)
    await waitForServer(server, port)

    const actor = seedUser(db, 'actor')
    const targets: Record<Exclude<Role, 'pika_team' | 'marketing'>, SeededUser> = {
      player: seedUser(db, 'player'),
      admin: seedUser(db, 'admin', 'admin'),
      subadmin: seedUser(db, 'subadmin', 'subadmin'),
      chat_admin: seedUser(db, 'chatadmin', 'chat_admin'),
      top_chat_admin: seedUser(db, 'topchatadmin', 'top_chat_admin'),
    }
    const pikaTeam = seedUser(db, 'pikateam', 'pika_team')
    const marketing = seedUser(db, 'marketing', 'marketing')
    const boss = seedUser(db, 'boss', 'admin')

    let index = 1
    for (const [role, target] of Object.entries(targets)) {
      await check(`[${index++}] player -> ${role}: block still works`, async () => {
        const r = await postBlock(port, actor, target)
        assertBlockedOk(r, role)
        assert(hasBlockRow(db, actor.profileId, target.profileId), `${role}: player_blocks row missing`)
      })
    }

    for (const [role, target] of [['pika_team', pikaTeam], ['marketing', marketing]] as const) {
      await check(`[${index++}] player -> ${role}: rejected with 403 PROTECTED_STAFF_PROFILE and the exact message`, async () => {
        assertProtectedRejection(await postBlock(port, actor, target), role)
        // Повторен опит — същият резултат (не toggle-ва нищо).
        assertProtectedRejection(await postBlock(port, actor, target), `${role} retry`)
      })
    }

    await check('[8] rejection creates no player_blocks row and leaves the table untouched', () => {
      assert(!hasBlockRow(db, actor.profileId, pikaTeam.profileId), 'row to pika_team exists')
      assert(!hasBlockRow(db, actor.profileId, marketing.profileId), 'row to marketing exists')
      assert(countBlocks(db, 'blocked_profile_id IN (?, ?)', pikaTeam.profileId, marketing.profileId) === 0, 'incoming rows to protected profiles exist')
      assert(countBlocks(db, 'blocker_profile_id = ?', actor.profileId) === 5, `actor must have exactly 5 blocks, has ${countBlocks(db, 'blocker_profile_id = ?', actor.profileId)}`)
    })

    await check(`[9] rejection does not consume a block-limit slot (${BLOCK_LIMIT - 1} -> reject -> ${BLOCK_LIMIT}th block succeeds)`, async () => {
      const filler = seedUser(db, 'filler')
      for (let i = 0; i < BLOCK_LIMIT - 1; i++) insertBlockRow(db, filler.profileId, `limit-filler-${i}-${randomUUID()}`)
      assert(countBlocks(db, 'blocker_profile_id = ?', filler.profileId) === BLOCK_LIMIT - 1, 'filler seed count')
      assertProtectedRejection(await postBlock(port, filler, pikaTeam), 'limit pika_team')
      assertProtectedRejection(await postBlock(port, filler, marketing), 'limit marketing')
      assert(countBlocks(db, 'blocker_profile_id = ?', filler.profileId) === BLOCK_LIMIT - 1, 'rejection changed the block count')
      const last = seedUser(db, 'lastslot')
      assertBlockedOk(await postBlock(port, filler, last), 'last free slot')
      assert(countBlocks(db, 'blocker_profile_id = ?', filler.profileId) === BLOCK_LIMIT, 'last slot not used')
    })

    await check(`[10] at the full limit (${BLOCK_LIMIT}) a protected target still returns PROTECTED_STAFF_PROFILE; normal limit semantics unchanged`, async () => {
      const filler = seedUser(db, 'full-filler')
      for (let i = 0; i < BLOCK_LIMIT; i++) insertBlockRow(db, filler.profileId, `full-filler-${i}-${randomUUID()}`)
      assertProtectedRejection(await postBlock(port, filler, pikaTeam), 'full limit pika_team')
      assert(countBlocks(db, 'blocker_profile_id = ?', filler.profileId) === BLOCK_LIMIT, 'count changed at full limit')
      const over = await postBlock(port, filler, seedUser(db, 'overlimit'))
      assert(over.status === 429 && over.body.limitReached === true, `normal limit semantics changed: ${over.status}`)
    })

    await check('[11] a legacy block row to a protected profile can still be removed (toggle unblock)', async () => {
      const legacy = seedUser(db, 'legacy')
      insertBlockRow(db, legacy.profileId, pikaTeam.profileId)
      const r = await postBlock(port, legacy, pikaTeam)
      assert(r.status === 200 && r.body.ok === true && r.body.blocked === false, `unblock expected 200 blocked=false, got ${r.status} ${JSON.stringify(r.body)}`)
      assert(!hasBlockRow(db, legacy.profileId, pikaTeam.profileId), 'legacy row still present')
      assertProtectedRejection(await postBlock(port, legacy, pikaTeam), 'legacy re-block')
    })

    // ── Grant / revoke през реалните admin HTTP endpoint-и ──
    const promoteTarget = seedUser(db, 'promote-pika')
    const promoteMarketing = seedUser(db, 'promote-marketing')
    const promoteChatAdmin = seedUser(db, 'promote-chatadmin')
    const blockerX = seedUser(db, 'blocker-x')
    const blockerY = seedUser(db, 'blocker-y')
    const bystander = seedUser(db, 'bystander')

    await check('[12] admin grant pika_team deletes incoming blocks atomically; outgoing/unrelated blocks stay', async () => {
      assertBlockedOk(await postBlock(port, blockerX, promoteTarget), 'X -> target')
      assertBlockedOk(await postBlock(port, blockerY, promoteTarget), 'Y -> target')
      assertBlockedOk(await postBlock(port, promoteTarget, bystander), 'target -> bystander (outgoing)')
      assertBlockedOk(await postBlock(port, blockerX, bystander), 'X -> bystander (unrelated)')
      const grant = await requestJson(port, 'POST', `/api/admin/profiles/${promoteTarget.profileId}/pika-team`, boss.cookie)
      assert(grant.status === 200 && grant.body.role === 'pika_team', `grant failed ${grant.status} ${JSON.stringify(grant.body)}`)
      assert(readRole(db, promoteTarget.accountId) === 'pika_team', 'role not updated')
      assert(countBlocks(db, 'blocked_profile_id = ?', promoteTarget.profileId) === 0, 'incoming blocks survived the grant')
      assert(hasBlockRow(db, promoteTarget.profileId, bystander.profileId), 'outgoing block of the promoted profile was removed')
      assert(hasBlockRow(db, blockerX.profileId, bystander.profileId), 'unrelated block was removed')
      assertProtectedRejection(await postBlock(port, blockerX, promoteTarget), 'block after grant')
      // Идемпотентен повторен grant — без грешка.
      const again = await requestJson(port, 'POST', `/api/admin/profiles/${promoteTarget.profileId}/pika-team`, boss.cookie)
      assert(again.status === 200 && again.body.role === 'pika_team', 'idempotent grant failed')
    })

    await check('[13] admin grant marketing deletes incoming blocks', async () => {
      assertBlockedOk(await postBlock(port, blockerX, promoteMarketing), 'X -> marketing target')
      assertBlockedOk(await postBlock(port, blockerY, promoteMarketing), 'Y -> marketing target')
      const grant = await requestJson(port, 'POST', `/api/admin/profiles/${promoteMarketing.profileId}/marketing`, boss.cookie)
      assert(grant.status === 200 && grant.body.role === 'marketing', `grant failed ${grant.status} ${JSON.stringify(grant.body)}`)
      assert(countBlocks(db, 'blocked_profile_id = ?', promoteMarketing.profileId) === 0, 'incoming blocks survived the marketing grant')
      assertProtectedRejection(await postBlock(port, blockerY, promoteMarketing), 'block after marketing grant')
    })

    await check('[14] admin grant chat_admin (not protected) keeps incoming blocks', async () => {
      assertBlockedOk(await postBlock(port, blockerX, promoteChatAdmin), 'X -> chat admin target')
      const grant = await requestJson(port, 'POST', `/api/admin/profiles/${promoteChatAdmin.profileId}/chat-admin`, boss.cookie)
      assert(grant.status === 200, `chat_admin grant failed ${grant.status} ${JSON.stringify(grant.body)}`)
      assert(readRole(db, promoteChatAdmin.accountId) === 'chat_admin', 'chat_admin role not set')
      assert(hasBlockRow(db, blockerX.profileId, promoteChatAdmin.profileId), 'chat_admin grant removed an incoming block')
    })

    await check('[15] revoke pika_team: removed blocks are NOT restored and the profile is blockable again', async () => {
      const revoke = await requestJson(port, 'DELETE', `/api/admin/profiles/${promoteTarget.profileId}/pika-team`, boss.cookie)
      assert(revoke.status === 200 && revoke.body.role === 'player', `revoke failed ${revoke.status} ${JSON.stringify(revoke.body)}`)
      assert(countBlocks(db, 'blocked_profile_id = ?', promoteTarget.profileId) === 0, 'old blocks came back after revoke')
      assertBlockedOk(await postBlock(port, blockerX, promoteTarget), 'block after revoke')
      assert(hasBlockRow(db, blockerX.profileId, promoteTarget.profileId), 'new block row missing after revoke')
    })

    // ── Migration ──
    await check(`[16] migration ${MIGRATION_FILE} removes incoming blocks only to pika_team/marketing`, async () => {
      await stopServer(server)
      server = null
      await waitForDatabaseReleased(db)

      const migrationBlocker = seedUser(db, 'migration-blocker')
      const staffOutgoingTarget = seedUser(db, 'migration-outgoing-target')
      const protectedTargets = [pikaTeam, marketing]
      const keptTargets = [...Object.values(targets)]
      for (const target of [...protectedTargets, ...keptTargets]) insertBlockRow(db, migrationBlocker.profileId, target.profileId)
      insertBlockRow(db, pikaTeam.profileId, staffOutgoingTarget.profileId)
      insertBlockRow(db, marketing.profileId, staffOutgoingTarget.profileId)
      assert(countBlocks(db, 'blocked_profile_id IN (?, ?)', pikaTeam.profileId, marketing.profileId) === 2, 'seed incoming protected rows')

      const ledger = openDb(db)
      try {
        const deleted = ledger.prepare('DELETE FROM server_migrations WHERE filename = ?').run(MIGRATION_FILE)
        assert(Number(deleted.changes) === 1, 'migration must have been applied on first boot (ledger row missing)')
      } finally {
        ledger.close()
      }

      server = startServer(isolated.serverDir, port)
      await waitForServer(server, port)

      for (const target of protectedTargets) {
        assert(!hasBlockRow(db, migrationBlocker.profileId, target.profileId), `migration did not remove block to ${target.tag}`)
      }
      for (const target of keptTargets) {
        assert(hasBlockRow(db, migrationBlocker.profileId, target.profileId), `migration removed block to ${target.tag}`)
      }
      assert(hasBlockRow(db, pikaTeam.profileId, staffOutgoingTarget.profileId), 'migration removed an outgoing pika_team block')
      assert(hasBlockRow(db, marketing.profileId, staffOutgoingTarget.profileId), 'migration removed an outgoing marketing block')
      const ledgerAfter = openDb(db)
      try {
        assert(ledgerAfter.prepare('SELECT 1 FROM server_migrations WHERE filename = ?').get(MIGRATION_FILE) !== undefined, 'migration not re-recorded')
      } finally {
        ledgerAfter.close()
      }
    })
    // ── Cross-process race срещу role promotion ──
    // Child процесът ползва РЕАЛНИЯ createBlockStore (отделна SQLite връзка в
    // отделен OS процес — като второ PM2 копие). Promotion-ът се симулира със
    // същите statements като authStore.changeElevatedRole (BEGIN IMMEDIATE ->
    // UPDATE accounts.role -> DELETE incoming player_blocks), държан отворен.
    const childScript = join(isolated.serverDir, 'protectedStaffRaceChild.ts')
    await writeFile(childScript, [
      'import { createInterface } from \'node:readline\'',
      'import { createBlockStore } from \'./src/db/blockStore.js\'',
      'const [dbFile, blocker, blocked] = process.argv.slice(2)',
      'const store = await createBlockStore(dbFile)',
      'process.stdout.write(\'READY\\n\')',
      'const rl = createInterface({ input: process.stdin })',
      'rl.once(\'line\', () => {',
      '  process.stdout.write(\'START\\n\')',
      '  const result = store.toggleBlock(blocker, blocked)',
      '  process.stdout.write(\'RESULT \' + JSON.stringify(result) + \'\\n\')',
      '  store.close()',
      '  rl.close()',
      '})',
      '',
    ].join('\n'))

    async function runPromotionRace(outcome: 'COMMIT' | 'ROLLBACK', role: 'pika_team' | 'marketing') {
      const blocker = seedUser(db, `race-blocker-${outcome}`)
      const target = seedUser(db, `race-target-${outcome}`)
      const legacyBlocker = seedUser(db, `race-legacy-${outcome}`)
      insertBlockRow(db, legacyBlocker.profileId, target.profileId)

      const lines: string[] = []
      const child = spawn(
        process.execPath,
        [join('node_modules', 'tsx', 'dist', 'cli.mjs'), childScript, db, blocker.profileId, target.profileId],
        { cwd: isolated.serverDir, stdio: ['pipe', 'pipe', 'pipe'] },
      )
      child.stdout.setEncoding('utf8')
      let stderr = ''
      child.stderr.on('data', (c) => { stderr += c })
      child.stdout.on('data', (c: string) => lines.push(...c.split('\n').filter(Boolean)))
      const waitLine = async (prefix: string, timeoutMs: number) => {
        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
          const line = lines.find((l) => l.startsWith(prefix))
          if (line) return line
          if (child.exitCode !== null) break
          await sleep(25)
        }
        throw new Error(`child did not print ${prefix}; stderr=${stderr}`)
      }

      const promotion = openDb(db)
      try {
        await waitLine('READY', 30_000)
        promotion.exec('BEGIN IMMEDIATE;')
        promotion.prepare('UPDATE accounts SET role = ? WHERE account_id = ? AND role = ?').run(role, target.accountId, 'player')
        promotion.prepare('DELETE FROM player_blocks WHERE blocked_profile_id IN (SELECT profile_id FROM profiles WHERE account_id = ?)').run(target.accountId)
        child.stdin.write('GO\n')
        await waitLine('START', 10_000)
        await sleep(800)
        const resultWhileLocked = lines.find((l) => l.startsWith('RESULT'))
        promotion.exec(`${outcome};`)
        const resultLine = await waitLine('RESULT', 10_000)
        return {
          blocker, target, legacyBlocker,
          waitedForLock: resultWhileLocked === undefined,
          result: JSON.parse(resultLine.slice('RESULT '.length)) as Record<string, unknown>,
        }
      } finally {
        try { promotion.exec('ROLLBACK;') } catch { /* already finished */ }
        promotion.close()
        if (child.exitCode === null) child.kill()
      }
    }

    await check('[18] cross-process race: block started during an open pika_team/marketing promotion waits and is refused', async () => {
      for (const role of ['pika_team', 'marketing'] as const) {
        const race = await runPromotionRace('COMMIT', role)
        assert(race.waitedForLock, `${role}: block request did not wait for the promotion transaction`)
        assert(race.result.protectedStaffProfile === true && race.result.blocked === false, `${role}: expected protected refusal, got ${JSON.stringify(race.result)}`)
        assert(!hasBlockRow(db, race.blocker.profileId, race.target.profileId), `${role}: block row written after promotion`)
        assert(!hasBlockRow(db, race.legacyBlocker.profileId, race.target.profileId), `${role}: promotion did not delete incoming blocks`)
        assert(readRole(db, race.target.accountId) === role, `${role}: promotion not committed`)
      }
    })

    await check('[19] control: same race with the promotion rolled back -> the block succeeds (the child really read post-lock state)', async () => {
      const race = await runPromotionRace('ROLLBACK', 'pika_team')
      assert(race.waitedForLock, 'block request did not wait for the promotion transaction')
      assert(race.result.blocked === true && race.result.protectedStaffProfile === undefined, `expected blocked=true, got ${JSON.stringify(race.result)}`)
      assert(hasBlockRow(db, race.blocker.profileId, race.target.profileId), 'block row missing')
      assert(hasBlockRow(db, race.legacyBlocker.profileId, race.target.profileId), 'rolled-back promotion deleted blocks')
      assert(readRole(db, race.target.accountId) === 'player', 'rolled-back promotion changed the role')
    })
  } finally {
    await stopServer(server)
    await isolated.cleanup()
  }

  await check('[17] invariant lives in blockStore.toggleBlock (one BEGIN IMMEDIATE transaction); endpoint only maps it; single INSERT path', () => {
    const store = readFileSync(resolve(sourceServerRoot, 'src/db/blockStore.ts'), 'utf8').replace(/\r\n/g, '\n')
    const toggle = store.slice(store.indexOf('function toggleBlock('), store.indexOf('function close('))
    const beginIndex = toggle.indexOf("database.exec('BEGIN IMMEDIATE;')")
    const roleIndex = toggle.indexOf('selectTargetAccountRoleStatement.get(blockedProfileId)')
    const protectedIndex = toggle.indexOf('isProtectedStaffRole(targetRole)')
    const insertIndex = toggle.indexOf('insertBlockStatement.run(')
    const commitIndex = toggle.indexOf("database.exec('COMMIT;')")
    assert(beginIndex >= 0 && beginIndex < roleIndex && roleIndex < protectedIndex && protectedIndex < insertIndex && insertIndex < commitIndex,
      'toggleBlock must read the role and INSERT inside one BEGIN IMMEDIATE transaction')
    assert(toggle.indexOf('deleteBlockStatement.run(') < roleIndex, 'existing (legacy) block must stay removable before the role check')

    const sources = ['src/index.ts', 'src/db/chatStore.ts', 'src/db/authStore.ts', 'src/db/tournamentEconomyStore.ts', 'src/db/profileHardDeleteService.ts', 'src/matchmaking/resolveMatchmakingSeats.ts']
      .map((path) => readFileSync(resolve(sourceServerRoot, path), 'utf8'))
    assert(sources.every((source) => !/INSERT[^;]*INTO\s+player_blocks/i.test(source)), 'another INSERT INTO player_blocks exists outside blockStore')

    const source = readFileSync(resolve(sourceServerRoot, 'src/index.ts'), 'utf8').replace(/\r\n/g, '\n')
    const toggleCalls = source.match(/blockStore\.toggleBlock\(/g) ?? []
    assert(toggleCalls.length === 1, `expected exactly 1 blockStore.toggleBlock call, found ${toggleCalls.length}`)
    const toggleIndex = source.indexOf('const result = blockStore.toggleBlock(myProfileId, targetProfileId)')
    const mapIndex = source.indexOf('if (result.protectedStaffProfile) {', toggleIndex)
    const cacheIndex = source.indexOf('invalidateLobbyChatBlockCache(myProfileId)', toggleIndex)
    assert(toggleIndex > 0 && mapIndex > toggleIndex && mapIndex < cacheIndex, 'endpoint must map protectedStaffProfile to 403 before any side effect')
    const migration = readFileSync(resolve(sourceServerRoot, 'database/migrations', MIGRATION_FILE), 'utf8')
    assert(/accounts\.role IN \('pika_team', 'marketing'\)/.test(migration), 'migration must target exactly pika_team/marketing')
  })

  console.log('\n' + '═'.repeat(64))
  console.log(`Passed: ${passed}  Failed: ${failed}`)
  if (failed > 0) process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
