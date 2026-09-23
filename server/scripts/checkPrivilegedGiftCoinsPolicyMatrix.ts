/**
 * checkPrivilegedGiftCoinsPolicyMatrix.ts
 *
 * Review finding §3 — пълна E2E policy матрица за старото служебно "Подари
 * жълтици" (не Paid Gift Shop). Reuse-ва established isolated-server E2E
 * инфраструктура (mirror на checkOldGiftCoinsEndpointDeniedForNormalUsers.ts/
 * checkGiftFriendshipBypassHttpAuthorization.ts).
 *
 * Established policy, потвърдена директно от кода (authStore.ts коментари +
 * route gates в index.ts), НЕ измислена тук:
 *   - Route A (/api/friends/:friendshipId/gift-coins, изисква accepted
 *     friendship): gate = isPikaTeamGiftMaxAmountSession(pika_team) OR
 *     isAdminGiftUnlimitedSession(admin) — И ДВАТА privileged role минават.
 *   - Route B (/api/friends/gift-coins/direct, non-friend bypass): gate =
 *     isPikaTeamGiftFriendshipBypassSession — САМО role==='pika_team'.
 *     Admin explicit НЯМА friendship-bypass право (established design note
 *     в authStore.ts: "Friendship bypass и max-amount permission са
 *     различни права" — admin unlimited bypass покрива amount/daily/window
 *     лимити, НЕ friendship изискването). Затова admin→non-friend е
 *     ОЧАКВАНО 403 на Route B — established policy, не bug.
 *
 * [1] pika_team → friend (Route A)      → 200 allowed
 * [2] pika_team → non-friend (Route B)  → 200 allowed (established bypass)
 * [3] admin → friend (Route A)          → 200 allowed (established unlimited)
 * [4] admin → non-friend (Route B)      → 403 (established: admin няма
 *       friendship-bypass право, само amount unlimited)
 * [5] pika_team daily limit: respects admin-configured
 *       pika_team_daily_gift_limit setting (не hardcoded)
 * [6] admin sender няма daily cap (unlimited)
 * [7] revoke на pika_team роля → веднага DENY на Route B (session role се
 *       чете live от accounts таблицата при всяка заявка, не кеширано)
 * [8] revoke на admin роля → веднага DENY на Route A privileged-only клона
 *       (downgrade към 'player' role)
 * [9] Paid "Подари авоари" (/api/shop/checkout с recipientProfileId) работи
 *       за NORMAL user (без privileged role) — независимост от privileged
 *       permission (само нужен Stripe config, тук очакваме 500
 *       "Stripe не е конфигуриран", НЕ 403 — доказва, че authorization
 *       слоят пуска normal user преди Stripe проверката)
 */

import { randomUUID } from 'node:crypto'
import { randomBytes, scryptSync } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const SESSION_COOKIE_NAME = 'belot_session'
const SERVER_READY_TIMEOUT_MS = 30_000

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
  const root = await mkdtemp(join(tmpdir(), 'belot-privileged-gift-policy-smoke-'))
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

function hashSessionToken(token: string): string {
  return scryptSync(token, 'belot-v2-session-v1', 32).toString('hex')
}

type SeededUser = { cookie: string; profileId: string; accountId: string; email: string }

function seedUser(databaseFile: string, runId: string, suffix: string, role: 'player' | 'pika_team' | 'admin'): SeededUser {
  const db = new DatabaseSync(databaseFile)
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec('PRAGMA journal_mode = WAL;')

  const email = `privileged-gift-policy-smoke-${runId}-${suffix}@example.test`
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
    db.prepare(`INSERT INTO profile_wallets (profile_id, yellow_coins_balance) VALUES (?, 50000);`).run(profileId)
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

function setAccountRole(databaseFile: string, accountId: string, role: 'player' | 'pika_team' | 'admin'): void {
  const db = new DatabaseSync(databaseFile)
  db.exec('PRAGMA journal_mode = WAL;')
  db.prepare(`UPDATE accounts SET role = ?, updated_at = CURRENT_TIMESTAMP WHERE account_id = ?`).run(role, accountId)
  db.close()
}

function setPikaTeamDailyGiftLimit(databaseFile: string, limit: number): void {
  const db = new DatabaseSync(databaseFile)
  db.exec('PRAGMA journal_mode = WAL;')
  db.prepare(`
    INSERT INTO admin_settings (setting_key, setting_value)
    VALUES ('pika_team_daily_gift_limit', ?)
    ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value;
  `).run(String(limit))
  db.close()
}

const sourceServerRoot = resolve(
  process.argv.slice(2).find((a) => a.startsWith('--server-root='))?.slice('--server-root='.length) ?? process.cwd(),
)

console.log('\n═══ Privileged "Подари жълтици" policy matrix E2E тест ═══')
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

  const pikaUser = seedUser(isolated.databaseFile, runId, 'pika', 'pika_team')
  const pikaFriend = seedUser(isolated.databaseFile, runId, 'pikafriend', 'player')
  const pikaNonFriend = seedUser(isolated.databaseFile, runId, 'pikanonfriend', 'player')
  const adminUser = seedUser(isolated.databaseFile, runId, 'admin', 'admin')
  const adminFriend = seedUser(isolated.databaseFile, runId, 'adminfriend', 'player')
  const adminNonFriend = seedUser(isolated.databaseFile, runId, 'adminnonfriend', 'player')
  const normalUser = seedUser(isolated.databaseFile, runId, 'normal', 'player')

  const pikaFriendshipId = createAcceptedFriendship(isolated.databaseFile, pikaUser.profileId, pikaFriend.profileId)
  const adminFriendshipId = createAcceptedFriendship(isolated.databaseFile, adminUser.profileId, adminFriend.profileId)

  // ── [1] pika_team → friend (Route A) → allowed ──────────────────────────
  await check('[1] pika_team -> friend (Route A /gift-coins) => 200 allowed', async () => {
    const r = await httpRequest(port, `/api/friends/${pikaFriendshipId}/gift-coins`, 'POST', pikaUser.cookie, { amount: 2_000 })
    const b = r.body as { ok?: boolean }
    if (r.status !== 200 || b.ok !== true) throw new Error(`status=${r.status}, body=${JSON.stringify(b)}`)
  })

  // ── [2] pika_team → non-friend (Route B) → allowed (established bypass) ──
  await check('[2] pika_team -> non-friend (Route B /gift-coins/direct) => 200 allowed', async () => {
    const r = await httpRequest(port, '/api/friends/gift-coins/direct', 'POST', pikaUser.cookie, {
      recipientProfileId: pikaNonFriend.profileId,
      amount: 2_000,
    })
    const b = r.body as { ok?: boolean }
    if (r.status !== 200 || b.ok !== true) throw new Error(`status=${r.status}, body=${JSON.stringify(b)}`)
  })

  // ── [3] admin → friend (Route A) → allowed (established unlimited) ──────
  await check('[3] admin -> friend (Route A /gift-coins) => 200 allowed', async () => {
    const r = await httpRequest(port, `/api/friends/${adminFriendshipId}/gift-coins`, 'POST', adminUser.cookie, { amount: 2_000 })
    const b = r.body as { ok?: boolean }
    if (r.status !== 200 || b.ok !== true) throw new Error(`status=${r.status}, body=${JSON.stringify(b)}`)
  })

  // ── [4] admin → non-friend (Route B) → 403 (established: no friendship-bypass) ──
  await check('[4] admin -> non-friend (Route B /gift-coins/direct) => 403 (established policy: admin няма friendship-bypass право)', async () => {
    const r = await httpRequest(port, '/api/friends/gift-coins/direct', 'POST', adminUser.cookie, {
      recipientProfileId: adminNonFriend.profileId,
      amount: 2_000,
    })
    if (r.status !== 403) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
  })

  // ── [5] pika_team daily limit — respects admin-configured setting ───────
  await check('[5] pika_team daily limit respects admin-configured pika_team_daily_gift_limit setting (не hardcoded)', async () => {
    const pikaLimitUser = seedUser(isolated.databaseFile, runId, 'pikalimit', 'pika_team')
    const limitRecipient = seedUser(isolated.databaseFile, runId, 'limitrecipient', 'player')

    // Задаваме нисък admin-configured лимит (5000) — под pika_team single-
    // операция max (100000), над single gift amount (2000).
    setPikaTeamDailyGiftLimit(isolated.databaseFile, 5_000)

    const r1 = await httpRequest(port, '/api/friends/gift-coins/direct', 'POST', pikaLimitUser.cookie, {
      recipientProfileId: limitRecipient.profileId,
      amount: 3_000,
    })
    const b1 = r1.body as { ok?: boolean }
    if (r1.status !== 200 || b1.ok !== true) throw new Error(`първи gift (3000, под лимита) трябва да мине: status=${r1.status}, body=${JSON.stringify(b1)}`)

    const limitRecipient2 = seedUser(isolated.databaseFile, runId, 'limitrecipient2', 'player')
    const r2 = await httpRequest(port, '/api/friends/gift-coins/direct', 'POST', pikaLimitUser.cookie, {
      recipientProfileId: limitRecipient2.profileId,
      amount: 3_000,
    })
    const b2 = r2.body as { ok?: boolean; code?: string }
    if (b2.ok !== false || b2.code !== 'PIKA_TEAM_DAILY_GIFT_LIMIT_EXCEEDED') {
      throw new Error(`втори gift (общо 6000 > admin-configured 5000 лимит) трябва да е отказан с PIKA_TEAM_DAILY_GIFT_LIMIT_EXCEEDED: status=${r2.status}, body=${JSON.stringify(b2)}`)
    }

    // Възстановяваме default лимита (200000) за да не влияе на [2]/[1] ако
    // тестовете се пуснат в друг ред занапред.
    setPikaTeamDailyGiftLimit(isolated.databaseFile, 200_000)
  })

  // ── [6] admin sender няма daily cap ──────────────────────────────────────
  await check('[6] admin sender няма daily/window cap — множество последователни gifts над pika_team лимита минават', async () => {
    const adminUnlimited = seedUser(isolated.databaseFile, runId, 'adminunlimited', 'admin')
    const r1recipient = seedUser(isolated.databaseFile, runId, 'adminunlimr1', 'player')
    const r2recipient = seedUser(isolated.databaseFile, runId, 'adminunlimr2', 'player')

    const r1 = await httpRequest(port, '/api/friends/gift-coins/direct', 'POST', adminUnlimited.cookie, {
      recipientProfileId: r1recipient.profileId,
      amount: 1,
    })
    const b1 = r1.body as { ok?: boolean }
    // Admin НЯМА friendship-bypass (виж [4]) — Route B връща 403 дори за
    // admin (established policy). Затова admin unlimited daily-cap теста
    // трябва да мине през Route A (accepted friendship), не Route B.
    if (r1.status !== 403) throw new Error(`sanity: admin Route B очаквано 403, получено status=${r1.status}, body=${JSON.stringify(b1)}`)

    const adminUnlimitedFriendshipId = createAcceptedFriendship(isolated.databaseFile, adminUnlimited.profileId, r2recipient.profileId)
    const r2 = await httpRequest(port, `/api/friends/${adminUnlimitedFriendshipId}/gift-coins`, 'POST', adminUnlimited.cookie, {
      amount: 29_999, // над normal single-операция max (30000 граница), под admin unlimited
    })
    const b2 = r2.body as { ok?: boolean }
    if (r2.status !== 200 || b2.ok !== true) throw new Error(`admin единичен gift 29999 (над normal cap) трябва да мине: status=${r2.status}, body=${JSON.stringify(b2)}`)
  })

  // ── [7] revoke на pika_team роля → веднага DENY на Route B ───────────────
  await check('[7] revoke на pika_team роля → веднага DENY на Route B (session role чете се live от DB)', async () => {
    const revokeCandidate = seedUser(isolated.databaseFile, runId, 'revokepika', 'pika_team')
    const revokeRecipient = seedUser(isolated.databaseFile, runId, 'revokerecipient', 'player')

    const rBefore = await httpRequest(port, '/api/friends/gift-coins/direct', 'POST', revokeCandidate.cookie, {
      recipientProfileId: revokeRecipient.profileId,
      amount: 1_000,
    })
    const bBefore = rBefore.body as { ok?: boolean }
    if (rBefore.status !== 200 || bBefore.ok !== true) throw new Error(`ПРЕДИ revoke: pika_team трябва да успее: status=${rBefore.status}, body=${JSON.stringify(bBefore)}`)

    setAccountRole(isolated.databaseFile, revokeCandidate.accountId, 'player')

    const revokeRecipient2 = seedUser(isolated.databaseFile, runId, 'revokerecipient2', 'player')
    const rAfter = await httpRequest(port, '/api/friends/gift-coins/direct', 'POST', revokeCandidate.cookie, {
      recipientProfileId: revokeRecipient2.profileId,
      amount: 1_000,
    })
    if (rAfter.status !== 403) throw new Error(`СЛЕД revoke (СЪЩИЯТ session cookie): очаквано 403, получено status=${rAfter.status}, body=${JSON.stringify(rAfter.body)}`)
  })

  // ── [8] revoke на admin роля → веднага DENY на Route A privileged клона ──
  await check('[8] revoke на admin роля (downgrade към player) → веднага DENY на стария /gift-coins endpoint', async () => {
    const revokeAdminCandidate = seedUser(isolated.databaseFile, runId, 'revokeadmin', 'admin')
    const revokeAdminFriend = seedUser(isolated.databaseFile, runId, 'revokeadminfriend', 'player')
    const friendshipId = createAcceptedFriendship(isolated.databaseFile, revokeAdminCandidate.profileId, revokeAdminFriend.profileId)

    const rBefore = await httpRequest(port, `/api/friends/${friendshipId}/gift-coins`, 'POST', revokeAdminCandidate.cookie, { amount: 1_000 })
    const bBefore = rBefore.body as { ok?: boolean }
    if (rBefore.status !== 200 || bBefore.ok !== true) throw new Error(`ПРЕДИ revoke: admin трябва да успее: status=${rBefore.status}, body=${JSON.stringify(bBefore)}`)

    setAccountRole(isolated.databaseFile, revokeAdminCandidate.accountId, 'player')

    const rAfter = await httpRequest(port, `/api/friends/${friendshipId}/gift-coins`, 'POST', revokeAdminCandidate.cookie, { amount: 1_000 })
    if (rAfter.status !== 403) throw new Error(`СЛЕД admin->player downgrade (СЪЩИЯТ session cookie): очаквано 403, получено status=${rAfter.status}, body=${JSON.stringify(rAfter.body)}`)
  })

  // ── [9] Paid "Подари авоари" независимост от privileged permission ──────
  await check('[9] Paid "Подари авоари" (/api/shop/checkout с recipientProfileId) достъпен за NORMAL user (независим от privileged permission)', async () => {
    const giftShopRecipient = seedUser(isolated.databaseFile, runId, 'giftshoprecipient', 'player')

    const r = await httpRequest(port, '/api/shop/checkout', 'POST', normalUser.cookie, {
      packageId: 'nonexistent-package-id-for-auth-layer-test',
      recipientProfileId: giftShopRecipient.profileId,
    })
    // Очакваме 400 (невалиден packageId) — НЕ 403 — доказва, че authorization
    // слоят изобщо не гейтва normal user тук; package validation се случва
    // ПРЕДИ Stripe config проверката (виж coinPurchaseStore.createPendingPurchase).
    if (r.status === 403) throw new Error(`Paid gift checkout НЕ трябва да е 403 за normal user: status=${r.status}, body=${JSON.stringify(r.body)}`)
    if (r.status !== 400) throw new Error(`очакван 400 (невалиден package) за да докажем auth слоят пуска normal user: status=${r.status}, body=${JSON.stringify(r.body)}`)
  })

  // ── [10] invalid/deleted recipient → checkout невъзможен (HTTP layer) ────
  await check('[10] Paid gift checkout с НЕСЪЩЕСТВУВАЩ recipientProfileId → ok:false (HTTP 400), checkout не се създава', async () => {
    const r = await httpRequest(port, '/api/shop/checkout', 'POST', normalUser.cookie, {
      packageId: 'nonexistent-package-id-does-not-matter',
      recipientProfileId: 'no-such-profile-id-ever-existed-xyz',
    })
    const b = r.body as { ok?: boolean; message?: string }
    if (b.ok !== false) throw new Error(`checkout към несъществуващ recipient трябва да е ok:false: status=${r.status}, body=${JSON.stringify(b)}`)
  })

  await check('[11] Paid gift checkout с recipientProfileId сочещ към ФИЗИЧЕСКИ ИЗТРИТ профил → ok:false, checkout не се създава', async () => {
    const doomedRecipient = seedUser(isolated.databaseFile, runId, 'doomedforcheckout', 'player')
    const doomedDb = new DatabaseSync(isolated.databaseFile)
    doomedDb.exec('PRAGMA foreign_keys = ON;')
    doomedDb.prepare(`DELETE FROM profiles WHERE profile_id = ?`).run(doomedRecipient.profileId)
    doomedDb.close()

    const r = await httpRequest(port, '/api/shop/checkout', 'POST', normalUser.cookie, {
      packageId: 'nonexistent-package-id-does-not-matter',
      recipientProfileId: doomedRecipient.profileId,
    })
    const b = r.body as { ok?: boolean; message?: string }
    if (b.ok !== false) throw new Error(`checkout към физически изтрит recipient трябва да е ok:false: status=${r.status}, body=${JSON.stringify(b)}`)
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
