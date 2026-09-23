/**
 * checkOldGiftCoinsEndpointDeniedForNormalUsers.ts
 *
 * "Подари авоари" брифа §6/§7 — E2E HTTP тест: старият normal-user
 * wallet-to-wallet "Подари жълтици" endpoint (POST
 * /api/friends/:friendshipId/gift-coins) трябва да е SERVER-SIDE DENIED
 * (403) за normal users, дори с валиден accepted friendship и валиден body
 * — не само UI hide. Privileged (pika_team / full admin) остава ALLOWED на
 * СЪЩИЯ endpoint, поведението/лимитите/ledger-а му остават непроменени
 * (§7: "старият backend path трябва да остане ALLOWED за privileged").
 * Reuse-ва established isolated-server E2E инфраструктура (mirror на
 * checkGiftFriendshipBypassHttpAuthorization.ts).
 *
 * [A1] normal user + accepted friendship + валиден amount → 403 (НЕ 400,
 *        НЕ 200) — сървърът отказва ПРЕДИ дори да валидира amount/friendship
 * [A1.1] отказаният опит НЕ е променил wallet баланси на никого
 * [A1.2] отказаният опит НЕ е създал нов ledger ред
 * [A2] pika_team + accepted friendship + валиден amount → 200 ok:true
 *        (старият path остава напълно функционален за privileged)
 * [A3] full admin + accepted friendship + валиден amount → 200 ok:true
 * [extra] guest (без cookie) → 401 (не 403 — сесията изобщо липсва)
 */

import { randomBytes, randomUUID, scryptSync } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const SESSION_COOKIE_NAME = 'belot_session'
const SERVER_READY_TIMEOUT_MS = 30_000

// Established pattern (mirror на checkTournamentEntryHttpApi.ts) — same
// hashing scheme като authStore.ts sessionStore, за seed-ване на валиден
// session token hash директно в DB. /api/auth/register в текущата
// production версия е email-verification pending-first flow (не директна
// регистрация) — за да тестваме authorization gate логиката изолирано, без
// да реimplement-ваме целия email verification submit flow тук, account/
// profile/session редовете се seed-ват директно (temp DB, изолиран server
// instance), заобикаляйки HTTP register/login напълно.
function hashSessionToken(token: string): string {
  return scryptSync(token, 'belot-v2-session-v1', 32).toString('hex')
}

let passed = 0
let failed = 0

function pass(label: string): void { passed++; console.log(`  PASS  ${label}`) }
function fail(label: string, reason: unknown): void {
  failed++
  console.error(`  FAIL  ${label}: ${reason instanceof Error ? reason.message : String(reason)}`)
}
async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); pass(label) } catch (err) { fail(label, err) }
}

function getFreePort(): Promise<number> {
  return new Promise((res, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (!addr || typeof addr === 'string') {
        srv.close(() => reject(new Error('Не може да се намери свободен порт.')))
        return
      }
      const { port } = addr
      srv.close(() => res(port))
    })
  })
}

type HttpResult = { status: number; body: unknown }

function httpRequest(port: number, pathname: string, method: string, cookie?: string, jsonBody?: unknown): Promise<HttpResult> {
  return new Promise((res, reject) => {
    const headers: Record<string, string> = {}
    if (cookie) headers['Cookie'] = cookie
    let payload: string | undefined
    if (jsonBody !== undefined) {
      payload = JSON.stringify(jsonBody)
      headers['Content-Type'] = 'application/json'
      headers['Content-Length'] = String(Buffer.byteLength(payload))
    }
    const req = request({ hostname: '127.0.0.1', port, path: pathname, method, headers, timeout: 5000 }, (r) => {
      const chunks: Buffer[] = []
      r.on('data', (c) => chunks.push(Buffer.from(c)))
      r.on('end', () => {
        let body: unknown = null
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { /* not JSON */ }
        res({ status: r.statusCode ?? 0, body })
      })
    })
    req.on('timeout', () => req.destroy(new Error('HTTP timeout.')))
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitFor(label: string, predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await sleep(100)
  }
  throw new Error(`Timeout: ${label}`)
}

type RunningServer = { child: ChildProcessWithoutNullStreams; output(): string }

async function createIsolatedServerRoot(originalServerRoot: string): Promise<{
  root: string
  serverDir: string
  databaseFile: string
  cleanup(): Promise<void>
}> {
  const root = await mkdtemp(join(tmpdir(), 'belot-old-gift-deny-smoke-'))
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

  const databaseFile = join(serverDir, 'database', 'data', 'belot-v2.sqlite')

  return {
    root, serverDir, databaseFile,
    cleanup: async () => { await rm(root, { recursive: true, force: true }) },
  }
}

function startServer(serverDir: string, port: number): RunningServer {
  const chunks: string[] = []
  const child = spawn(
    process.execPath,
    [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'index.ts')],
    {
      cwd: serverDir,
      env: { ...process.env, PORT: String(port), BELOT_GAME_WORKER_TICK_MODE: 'worker-candidate', BELOT_GAME_WORKER_COUNT: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (c: string) => chunks.push(c))
  child.stderr.on('data', (c: string) => chunks.push(c))
  return { child, output: () => chunks.join('') }
}

async function stopServer(server: RunningServer): Promise<void> {
  if (server.child.exitCode !== null) return
  server.child.kill('SIGTERM')
  await new Promise<void>((res) => {
    const t = setTimeout(() => { server.child.kill('SIGKILL'); res() }, 10_000)
    server.child.once('exit', () => { clearTimeout(t); res() })
  })
}

function setWalletBalance(databaseFile: string, profileId: string, balance: number): void {
  const db = new DatabaseSync(databaseFile)
  db.exec('PRAGMA journal_mode = WAL;')
  db.prepare(`
    INSERT INTO profile_wallets (profile_id, yellow_coins_balance)
    VALUES (?, ?)
    ON CONFLICT(profile_id) DO UPDATE SET yellow_coins_balance = excluded.yellow_coins_balance;
  `).run(profileId, balance)
  db.close()
}

function createAcceptedFriendship(databaseFile: string, profileIdA: string, profileIdB: string): string {
  const db = new DatabaseSync(databaseFile)
  db.exec('PRAGMA journal_mode = WAL;')
  const friendshipId = randomUUID()
  const lower = profileIdA < profileIdB ? profileIdA : profileIdB
  const higher = profileIdA < profileIdB ? profileIdB : profileIdA
  db.prepare(`
    INSERT INTO profile_friendships
      (friendship_id, requester_profile_id, addressee_profile_id, lower_profile_id, higher_profile_id, status, kind)
    VALUES (?, ?, ?, ?, ?, 'accepted', 'friend');
  `).run(friendshipId, profileIdA, profileIdB, lower, higher)
  db.close()
  return friendshipId
}

function getWalletBalance(databaseFile: string, profileId: string): number {
  const db = new DatabaseSync(databaseFile)
  const row = db.prepare(`SELECT yellow_coins_balance FROM profile_wallets WHERE profile_id = ?`).get(profileId) as
    | { yellow_coins_balance: number } | undefined
  db.close()
  return row?.yellow_coins_balance ?? 0
}

function countGiftLedgerRows(databaseFile: string, senderProfileId: string, recipientProfileId: string): number {
  const db = new DatabaseSync(databaseFile)
  const row = db.prepare(`
    SELECT COUNT(*) AS c FROM yellow_coin_gift_ledger
    WHERE sender_profile_id = ? AND recipient_profile_id = ?
  `).get(senderProfileId, recipientProfileId) as { c: number }
  db.close()
  return row.c
}

type RegisteredUser = { cookie: string; profileId: string; accountId: string; email: string }

// Директен DB seed на account+profile+session (established pattern, mirror
// на checkTournamentEntryHttpApi.ts) — заобикаля изцяло HTTP register/login,
// които в текущата production версия минават през email-verification
// pending-first flow (изисква реален email delivery + code submission, извън
// обхвата на ТОЗИ authorization-gate тест). password_hash тук е placeholder
// (login никога не се извиква през HTTP — session token се seed-ва directly
// hashed, cookie се build-ва ръчно и се подава директно на httpRequest).
function seedUser(databaseFile: string, runId: string, suffix: string, role: 'player' | 'pika_team' | 'admin'): RegisteredUser {
  const db = new DatabaseSync(databaseFile)
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec('PRAGMA journal_mode = WAL;')

  const email = `old-gift-deny-smoke-${runId}-${suffix}@example.test`
  const accountId = randomUUID()
  const profileId = randomUUID()
  const displayName = `Smoke ${suffix}`
  const normalized = displayName.toLowerCase()
  const token = randomBytes(32).toString('base64url')

  db.exec('BEGIN IMMEDIATE;')
  try {
    db.prepare(`
      INSERT INTO accounts (account_id, email, password_hash, role, status)
      VALUES (?, ?, 'not-used-seeded-directly', ?, 'active');
    `).run(accountId, email, role)
    db.prepare(`
      INSERT INTO profiles (
        profile_id, account_id, profile_kind, username, normalized_username,
        display_name, normalized_display_name, avatar_url, level, rank_title,
        skill_rating, gender, status
      ) VALUES (?, ?, 'human', ?, ?, ?, ?, NULL, 1, 'Rank 1', 1000, 'male', 'active');
    `).run(profileId, accountId, displayName, normalized, displayName, normalized)
    db.prepare(`
      INSERT INTO profile_wallets (profile_id, yellow_coins_balance) VALUES (?, 0);
    `).run(profileId)
    db.prepare(`
      INSERT INTO profile_progress (profile_id, completed_games_count, won_games_count, rank_level)
      VALUES (?, 0, 0, 1);
    `).run(profileId)
    db.prepare(`
      INSERT INTO account_sessions (session_id, account_id, profile_id, token_hash, expires_at)
      VALUES (?, ?, ?, ?, ?);
    `).run(randomUUID(), accountId, profileId, hashSessionToken(token), new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString())
    db.exec('COMMIT;')
  } catch (error) {
    try { db.exec('ROLLBACK;') } catch { /* keep original error */ }
    throw error
  } finally {
    db.close()
  }

  return { cookie: `${SESSION_COOKIE_NAME}=${token}`, profileId, accountId, email }
}

const sourceServerRoot = resolve(
  process.argv.slice(2).find((a) => a.startsWith('--server-root='))?.slice('--server-root='.length) ?? process.cwd(),
)

console.log('\n═══ Старият "Подари жълтици" endpoint — server-side DENY за normal users E2E тест ═══')
console.log(`Server root: ${sourceServerRoot}`)

const isolated = await createIsolatedServerRoot(sourceServerRoot)
const port = await getFreePort()
let server: RunningServer | null = null

try {
  server = startServer(isolated.serverDir, port)

  console.log(`\n[startup] Чакам сървъра на порт ${port}...`)
  await waitFor('server health ready', async () => {
    try {
      const r = await httpRequest(port, '/health', 'GET')
      const h = r.body as { ok?: boolean; gameWorkerPool?: { state?: string } | null }
      return r.status === 200 && h.ok === true && h.gameWorkerPool?.state === 'ready'
    } catch { return false }
  }, SERVER_READY_TIMEOUT_MS)
  console.log('  Сървърът е готов.')

  const runId = `${Date.now()}-${process.pid}`

  console.log('\n[setup] Seed на normal user, pika_team, admin + приятели директно в DB...')
  const normalUser = seedUser(isolated.databaseFile, runId, 'normal', 'player')
  const normalFriend = seedUser(isolated.databaseFile, runId, 'normalfriend', 'player')
  const pikaUser = seedUser(isolated.databaseFile, runId, 'pika', 'pika_team')
  const pikaFriend = seedUser(isolated.databaseFile, runId, 'pikafriend', 'player')
  const adminUser = seedUser(isolated.databaseFile, runId, 'admin', 'admin')
  const adminFriend = seedUser(isolated.databaseFile, runId, 'adminfriend', 'player')

  const normalCookie = normalUser.cookie
  const pikaCookie = pikaUser.cookie
  const adminCookie = adminUser.cookie

  const normalFriendshipId = createAcceptedFriendship(isolated.databaseFile, normalUser.profileId, normalFriend.profileId)
  const pikaFriendshipId = createAcceptedFriendship(isolated.databaseFile, pikaUser.profileId, pikaFriend.profileId)
  const adminFriendshipId = createAcceptedFriendship(isolated.databaseFile, adminUser.profileId, adminFriend.profileId)

  setWalletBalance(isolated.databaseFile, normalUser.profileId, 50_000)
  setWalletBalance(isolated.databaseFile, pikaUser.profileId, 50_000)
  setWalletBalance(isolated.databaseFile, adminUser.profileId, 50_000)

  // ── [A1] normal user + accepted friendship + валиден amount → 403 ──────────
  console.log('\n[A1] normal user (accepted friend) -> POST /api/friends/:friendshipId/gift-coins => 403')
  const normalBalanceBefore = getWalletBalance(isolated.databaseFile, normalUser.profileId)
  const normalFriendBalanceBefore = getWalletBalance(isolated.databaseFile, normalFriend.profileId)
  const normalLedgerCountBefore = countGiftLedgerRows(isolated.databaseFile, normalUser.profileId, normalFriend.profileId)

  await check('[A1] normal user -> стария /gift-coins endpoint => 403 (НЕ 200, НЕ 400)', async () => {
    const r = await httpRequest(port, `/api/friends/${normalFriendshipId}/gift-coins`, 'POST', normalCookie, {
      amount: 2_000,
    })
    if (r.status !== 403) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
    const b = r.body as { ok?: boolean }
    if (b.ok !== false) throw new Error(`ok трябва да е false: ${JSON.stringify(b)}`)
  })

  await check('[A1.1] отказаният опит НЕ е променил sender wallet баланса', () => {
    const bal = getWalletBalance(isolated.databaseFile, normalUser.profileId)
    if (bal !== normalBalanceBefore) throw new Error(`sender balance=${bal}, очаквах непроменен ${normalBalanceBefore}`)
  })

  await check('[A1.2] отказаният опит НЕ е променил recipient wallet баланса', () => {
    const bal = getWalletBalance(isolated.databaseFile, normalFriend.profileId)
    if (bal !== normalFriendBalanceBefore) throw new Error(`recipient balance=${bal}, очаквах непроменен ${normalFriendBalanceBefore}`)
  })

  await check('[A1.3] отказаният опит НЕ е създал нов ledger ред', () => {
    const count = countGiftLedgerRows(isolated.databaseFile, normalUser.profileId, normalFriend.profileId)
    if (count !== normalLedgerCountBefore) throw new Error(`ledger rows=${count}, очаквах непроменено ${normalLedgerCountBefore}`)
  })

  // ── [A2] pika_team + accepted friendship + валиден amount → 200 ────────────
  console.log('\n[A2] pika_team (accepted friend) -> POST /api/friends/:friendshipId/gift-coins => 200 (старият path остава ALLOWED)')
  await check('[A2] pika_team -> стария /gift-coins endpoint => 200 ok:true', async () => {
    const r = await httpRequest(port, `/api/friends/${pikaFriendshipId}/gift-coins`, 'POST', pikaCookie, {
      amount: 2_000,
    })
    const b = r.body as { ok?: boolean }
    if (r.status !== 200 || b.ok !== true) throw new Error(`status=${r.status}, body=${JSON.stringify(b)}`)
  })

  // ── [A3] full admin + accepted friendship + валиден amount → 200 ───────────
  console.log('\n[A3] full admin (accepted friend) -> POST /api/friends/:friendshipId/gift-coins => 200 (старият path остава ALLOWED)')
  await check('[A3] admin -> стария /gift-coins endpoint => 200 ok:true', async () => {
    const r = await httpRequest(port, `/api/friends/${adminFriendshipId}/gift-coins`, 'POST', adminCookie, {
      amount: 2_000,
    })
    const b = r.body as { ok?: boolean }
    if (r.status !== 200 || b.ok !== true) throw new Error(`status=${r.status}, body=${JSON.stringify(b)}`)
  })

  // ── [extra] guest (без cookie) → 401, не 403 ────────────────────────────────
  await check('[extra] guest (без cookie) -> стария /gift-coins endpoint => 401', async () => {
    const r = await httpRequest(port, `/api/friends/${normalFriendshipId}/gift-coins`, 'POST', undefined, {
      amount: 2_000,
    })
    if (r.status !== 401) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
  })

} catch (err) {
  fail('Непредвидена грешка в E2E теста', err)
  if (server !== null) {
    console.error('\n[server output tail]:\n' + server.output().slice(-3000))
  }
  console.error(err)
} finally {
  console.log('\n[cleanup] Спиране на сървъра и изтриване на временните файлове...')
  if (server !== null) {
    try {
      await stopServer(server)
      console.log('  Сървърът е спрян.')
    } catch (err) {
      fail('Спиране на сървъра', err)
      console.error(server.output().slice(-3000))
    }
  }
  let cleanupOk = false
  for (let attempt = 0; attempt < 5 && !cleanupOk; attempt++) {
    try {
      if (attempt > 0) await sleep(500)
      await isolated.cleanup()
      cleanupOk = true
    } catch {
      // ще опитаме пак
    }
  }
  if (cleanupOk) {
    console.log('  Временните файлове са изтрити.')
  } else {
    console.warn('  [warn] Временните файлове не бяха изтрити (Windows file lock) — не е тестов провал.')
  }
}

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
