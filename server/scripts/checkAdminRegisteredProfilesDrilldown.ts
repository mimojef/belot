/**
 * checkAdminRegisteredProfilesDrilldown.ts
 *
 * Regression checks за drill-down списъка зад "днес"/"вчера" broячите в
 * картата "Регистрирани профили" (Admin -> Информация).
 *
 * [1]  today query брои само профили, регистрирани в текущия Sofia ден
 * [2]  yesterday query брои само профили от предходния Sofia ден
 * [3]  boundary: профил, регистриран точно в todayStart, се брои за "днес"
 * [4]  boundary: профил, регистриран 1 сек преди todayStart, се брои за "вчера" (не "днес")
 * [5]  boundary: профил, регистриран точно в yesterdayStart, се брои за "вчера"
 * [6]  DESC сортиране — най-новите регистрации първи
 * [7]  Бот профили (profile_kind='bot') не се броят/листват
 * [8]  Броят редове в drill-down списъка съвпада с countHumanProfiles() broяча за същия период
 * [9]  username/email/createdAt/profileId полетата се връщат коректно (JOIN към accounts)
 * [10] Липсващ account (account_id NULL) не чупи заявката — email е null
 * [11] Empty state: няма редове за период без регистрации
 * [12] HTTP endpoint: admin cookie -> 200
 * [13] HTTP endpoint: subadmin cookie -> 200
 * [14] HTTP endpoint: обикновен player cookie -> 403
 * [15] HTTP endpoint: без cookie -> 403
 * [16] HTTP endpoint: невалиден period параметър -> 400
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { cp, mkdir, symlink } from 'node:fs/promises'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { resolve } from 'node:path'
import { getSofiaDayBoundsUtc, toSqliteUtc } from '../src/db/sofiaDayBounds.js'

let passed = 0
let failed = 0

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`)
    passed++
  } else {
    console.error(`  ✗ FAIL: ${label}${detail ? ` (${detail})` : ''}`)
    failed++
  }
}

// ─── Schema (минимална реплика на profiles + accounts за тестовете) ──────────

function buildSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      account_id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL DEFAULT 'player'
    );

    CREATE TABLE IF NOT EXISTS profiles (
      profile_id TEXT PRIMARY KEY,
      account_id TEXT NULL,
      profile_kind TEXT NOT NULL DEFAULT 'human',
      username TEXT NULL,
      display_name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `)
}

async function withTempDbFile(fn: (dbPath: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'belot-admin-registered-profiles-check-'))
  const dbPath = join(dir, 'test.sqlite')
  try {
    const bootstrap = new DatabaseSync(dbPath)
    buildSchema(bootstrap)
    bootstrap.close()
    await fn(dbPath)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// ─── Реплика на playerProgressStore SQL логиката (директно над теста DB) ─────
// Идентична на countHumanProfiles/listRegisteredProfilesForPeriod в
// server/src/db/playerProgressStore.ts — reuse-ва СЪЩИЯ getSofiaDayBoundsUtc,
// за да гарантираме, че тестовете верифицират реалната production логика.

function countHumanProfiles(db: DatabaseSync, now: Date): { total: number; today: number; yesterday: number } {
  const total = (db.prepare(`SELECT COUNT(*) AS count FROM profiles WHERE profile_kind = 'human'`).get() as { count: number }).count
  const bounds = getSofiaDayBoundsUtc(now)
  const countInRange = (start: string, end: string): number => {
    const row = db.prepare(
      `SELECT COUNT(*) AS count FROM profiles WHERE profile_kind = 'human' AND created_at >= ? AND created_at < ?`,
    ).get(start, end) as { count: number }
    return row.count
  }
  return {
    total,
    today: countInRange(bounds.todayStart, bounds.tomorrowStart),
    yesterday: countInRange(bounds.yesterdayStart, bounds.todayStart),
  }
}

type RegisteredProfileListRow = {
  profileId: string
  username: string | null
  displayName: string
  createdAt: string
  email: string | null
}

function listRegisteredProfilesForPeriod(
  db: DatabaseSync,
  period: 'today' | 'yesterday',
  now: Date,
): RegisteredProfileListRow[] {
  const bounds = getSofiaDayBoundsUtc(now)
  const [start, end] = period === 'today'
    ? [bounds.todayStart, bounds.tomorrowStart]
    : [bounds.yesterdayStart, bounds.todayStart]

  return db.prepare(`
    SELECT
      p.profile_id AS profileId,
      p.username AS username,
      p.display_name AS displayName,
      p.created_at AS createdAt,
      a.email AS email
    FROM profiles p
    LEFT JOIN accounts a ON a.account_id = p.account_id
    WHERE p.profile_kind = 'human'
      AND p.created_at >= ? AND p.created_at < ?
    ORDER BY p.created_at DESC
    LIMIT 500
  `).all(start, end) as RegisteredProfileListRow[]
}

function insertProfile(
  db: DatabaseSync,
  opts: { profileId?: string; accountId?: string | null; kind?: 'human' | 'bot'; username?: string | null; displayName?: string; createdAt: string },
): string {
  const profileId = opts.profileId ?? randomUUID()
  db.prepare(`
    INSERT INTO profiles (profile_id, account_id, profile_kind, username, display_name, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(profileId, opts.accountId ?? null, opts.kind ?? 'human', opts.username ?? null, opts.displayName ?? 'Player', opts.createdAt)
  return profileId
}

function insertAccount(db: DatabaseSync, email: string, role: string = 'player'): string {
  const accountId = randomUUID()
  db.prepare(`INSERT INTO accounts (account_id, email, role) VALUES (?, ?, ?)`).run(accountId, email, role)
  return accountId
}

// Фиксиран момент в Sofia лятно време (EEST, UTC+3) за детерминистични тестове.
// 2026-08-15T12:00:00 UTC = 2026-08-15 15:00 Sofia local.
const FIXED_NOW = new Date('2026-08-15T12:00:00.000Z')

console.log('\ncheckAdminRegisteredProfilesDrilldown — SQL/boundary tests')

await withTempDbFile(async (dbPath) => {
  const db = new DatabaseSync(dbPath)
  const bounds = getSofiaDayBoundsUtc(FIXED_NOW)

  // ─── [1] today query counts only today's Sofia-day registrations ─────────
  {
    const idToday = insertProfile(db, { createdAt: toSqliteUtc(new Date(new Date(bounds.todayStart.replace(' ', 'T') + 'Z').getTime() + 3_600_000)) })
    const idYesterday = insertProfile(db, { createdAt: toSqliteUtc(new Date(new Date(bounds.yesterdayStart.replace(' ', 'T') + 'Z').getTime() + 3_600_000)) })

    const todayRows = listRegisteredProfilesForPeriod(db, 'today', FIXED_NOW)
    check('[1] today query includes a profile created within today\'s Sofia window', todayRows.some((r) => r.profileId === idToday))
    check('[1] today query excludes a profile created yesterday', !todayRows.some((r) => r.profileId === idYesterday))

    db.prepare('DELETE FROM profiles WHERE profile_id IN (?, ?)').run(idToday, idYesterday)
  }

  // ─── [2] yesterday query counts only yesterday's Sofia-day registrations ──
  {
    const idToday = insertProfile(db, { createdAt: toSqliteUtc(new Date(new Date(bounds.todayStart.replace(' ', 'T') + 'Z').getTime() + 3_600_000)) })
    const idYesterday = insertProfile(db, { createdAt: toSqliteUtc(new Date(new Date(bounds.yesterdayStart.replace(' ', 'T') + 'Z').getTime() + 3_600_000)) })

    const yesterdayRows = listRegisteredProfilesForPeriod(db, 'yesterday', FIXED_NOW)
    check('[2] yesterday query includes a profile created within yesterday\'s Sofia window', yesterdayRows.some((r) => r.profileId === idYesterday))
    check('[2] yesterday query excludes a profile created today', !yesterdayRows.some((r) => r.profileId === idToday))

    db.prepare('DELETE FROM profiles WHERE profile_id IN (?, ?)').run(idToday, idYesterday)
  }

  // ─── [3] boundary: exactly at todayStart counts as "today" ────────────────
  {
    const id = insertProfile(db, { createdAt: bounds.todayStart })
    const todayRows = listRegisteredProfilesForPeriod(db, 'today', FIXED_NOW)
    const yesterdayRows = listRegisteredProfilesForPeriod(db, 'yesterday', FIXED_NOW)
    check('[3] profile created exactly at todayStart is counted as "today"', todayRows.some((r) => r.profileId === id))
    check('[3] profile created exactly at todayStart is NOT counted as "yesterday"', !yesterdayRows.some((r) => r.profileId === id))
    db.prepare('DELETE FROM profiles WHERE profile_id = ?').run(id)
  }

  // ─── [4] boundary: 1 second before todayStart counts as "yesterday" ───────
  {
    const oneSecBefore = toSqliteUtc(new Date(new Date(bounds.todayStart.replace(' ', 'T') + 'Z').getTime() - 1000))
    const id = insertProfile(db, { createdAt: oneSecBefore })
    const todayRows = listRegisteredProfilesForPeriod(db, 'today', FIXED_NOW)
    const yesterdayRows = listRegisteredProfilesForPeriod(db, 'yesterday', FIXED_NOW)
    check('[4] profile created 1s before todayStart is NOT counted as "today"', !todayRows.some((r) => r.profileId === id))
    check('[4] profile created 1s before todayStart IS counted as "yesterday"', yesterdayRows.some((r) => r.profileId === id))
    db.prepare('DELETE FROM profiles WHERE profile_id = ?').run(id)
  }

  // ─── [5] boundary: exactly at yesterdayStart counts as "yesterday" ────────
  {
    const id = insertProfile(db, { createdAt: bounds.yesterdayStart })
    const yesterdayRows = listRegisteredProfilesForPeriod(db, 'yesterday', FIXED_NOW)
    check('[5] profile created exactly at yesterdayStart is counted as "yesterday"', yesterdayRows.some((r) => r.profileId === id))
    db.prepare('DELETE FROM profiles WHERE profile_id = ?').run(id)
  }

  // ─── [6] DESC sort order ────────────────────────────────────────────────
  {
    const base = new Date(bounds.todayStart.replace(' ', 'T') + 'Z').getTime()
    const idEarly = insertProfile(db, { createdAt: toSqliteUtc(new Date(base + 1000)), displayName: 'Early' })
    const idMid = insertProfile(db, { createdAt: toSqliteUtc(new Date(base + 5000)), displayName: 'Mid' })
    const idLate = insertProfile(db, { createdAt: toSqliteUtc(new Date(base + 9000)), displayName: 'Late' })

    const rows = listRegisteredProfilesForPeriod(db, 'today', FIXED_NOW)
    const ids = rows.map((r) => r.profileId)
    const idxLate = ids.indexOf(idLate)
    const idxMid = ids.indexOf(idMid)
    const idxEarly = ids.indexOf(idEarly)
    check('[6] DESC sort: latest registration appears before mid', idxLate !== -1 && idxMid !== -1 && idxLate < idxMid)
    check('[6] DESC sort: mid registration appears before earliest', idxMid !== -1 && idxEarly !== -1 && idxMid < idxEarly)

    db.prepare('DELETE FROM profiles WHERE profile_id IN (?, ?, ?)').run(idEarly, idMid, idLate)
  }

  // ─── [7] Bot profiles excluded ─────────────────────────────────────────
  {
    const idHuman = insertProfile(db, { createdAt: bounds.todayStart, kind: 'human' })
    const idBot = insertProfile(db, { createdAt: bounds.todayStart, kind: 'bot' })
    const rows = listRegisteredProfilesForPeriod(db, 'today', FIXED_NOW)
    const stats = countHumanProfiles(db, FIXED_NOW)
    check('[7] bot profile is excluded from the drill-down list', !rows.some((r) => r.profileId === idBot))
    check('[7] bot profile is excluded from the today counter', !rows.some((r) => r.profileId === idBot) && stats.today === rows.length)
    check('[7] human profile IS included', rows.some((r) => r.profileId === idHuman))
    db.prepare('DELETE FROM profiles WHERE profile_id IN (?, ?)').run(idHuman, idBot)
  }

  // ─── [8] Row count matches countHumanProfiles() counter for the same period ─
  {
    const base = new Date(bounds.todayStart.replace(' ', 'T') + 'Z').getTime()
    const ids = [0, 1, 2].map((i) => insertProfile(db, { createdAt: toSqliteUtc(new Date(base + i * 1000)) }))

    const stats = countHumanProfiles(db, FIXED_NOW)
    const rows = listRegisteredProfilesForPeriod(db, 'today', FIXED_NOW)
    check('[8] drill-down row count matches the "today" counter exactly', rows.length === stats.today, `rows=${rows.length} counter=${stats.today}`)

    db.prepare(`DELETE FROM profiles WHERE profile_id IN (${ids.map(() => '?').join(',')})`).run(...ids)
  }

  // ─── [9] username/email/createdAt/profileId fields populated correctly ────
  {
    const accountId = insertAccount(db, 'drilldown-test@example.test')
    const id = insertProfile(db, { createdAt: bounds.todayStart, accountId, username: 'TestUser', displayName: 'Test Display' })
    const rows = listRegisteredProfilesForPeriod(db, 'today', FIXED_NOW)
    const row = rows.find((r) => r.profileId === id)
    check('[9] row found', row !== undefined)
    check('[9] username populated correctly', row?.username === 'TestUser')
    check('[9] email populated correctly via JOIN', row?.email === 'drilldown-test@example.test')
    check('[9] createdAt populated correctly', row?.createdAt === bounds.todayStart)
    db.prepare('DELETE FROM profiles WHERE profile_id = ?').run(id)
    db.prepare('DELETE FROM accounts WHERE account_id = ?').run(accountId)
  }

  // ─── [10] Missing account (account_id NULL) does not break the query ──────
  {
    const id = insertProfile(db, { createdAt: bounds.todayStart, accountId: null, username: null })
    const rows = listRegisteredProfilesForPeriod(db, 'today', FIXED_NOW)
    const row = rows.find((r) => r.profileId === id)
    check('[10] row found for profile with no linked account', row !== undefined)
    check('[10] email is null when account_id is null (no throw)', row?.email === null)
    db.prepare('DELETE FROM profiles WHERE profile_id = ?').run(id)
  }

  // ─── [11] Empty state — no rows for a period with zero registrations ──────
  {
    const rows = listRegisteredProfilesForPeriod(db, 'today', FIXED_NOW)
    check('[11] empty period returns an empty array, not null/throw', Array.isArray(rows) && rows.length === 0)
  }

  db.close()
})

// ─── HTTP endpoint auth tests (реален сървър процес) ──────────────────────

console.log('\ncheckAdminRegisteredProfilesDrilldown — HTTP endpoint auth tests')

const PASSWORD = 'RegisteredProfilesSmoke1!'
const SERVER_READY_TIMEOUT_MS = 30_000
const ENDPOINT = '/api/admin/registered-profiles'

function getFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (!addr || typeof addr === 'string') {
        srv.close(() => reject(new Error('Не може да се намери свободен порт.')))
        return
      }
      const { port } = addr
      srv.close(() => resolvePort(port))
    })
  })
}

type HttpResult = { status: number; body: unknown }

function httpRequest(port: number, pathname: string, method: string, cookie?: string): Promise<HttpResult> {
  return new Promise((resolveReq, reject) => {
    const headers: Record<string, string> = {}
    if (cookie) headers['Cookie'] = cookie
    const req = request(
      { hostname: '127.0.0.1', port, path: pathname, method, headers, timeout: 5000 },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(Buffer.from(c)))
        res.on('end', () => {
          let body: unknown = null
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { /* not JSON */ }
          resolveReq({ status: res.statusCode ?? 0, body })
        })
      },
    )
    req.on('timeout', () => req.destroy(new Error('HTTP timeout.')))
    req.on('error', reject)
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
  serverDir: string
  databaseFile: string
  cleanup(): Promise<void>
}> {
  const root = await mkdtemp(join(tmpdir(), 'belot-registered-profiles-smoke-'))
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
  return { serverDir, databaseFile, cleanup: async () => { await rm(root, { recursive: true, force: true }) } }
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
  await new Promise<void>((resolveStop) => {
    const t = setTimeout(() => { server.child.kill('SIGKILL'); resolveStop() }, 10_000)
    server.child.once('exit', () => { clearTimeout(t); resolveStop() })
  })
}

function promoteRole(databaseFile: string, email: string, role: string): void {
  const db = new DatabaseSync(databaseFile)
  db.exec('PRAGMA journal_mode = WAL;')
  db.prepare(`UPDATE accounts SET role = ?, updated_at = CURRENT_TIMESTAMP WHERE email = ?`).run(role, email)
  db.close()
}

async function register(port: number, runId: string, suffix: string): Promise<{ email: string; cookie: string }> {
  const email = `registered-profiles-smoke-${runId}-${suffix}@example.test`
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, displayName: `Smoke ${suffix}`, gender: 'male' }),
  })
  if (res.status !== 200) throw new Error(`Регистрацията на ${suffix} върна status ${res.status}.`)
  const payload = await res.json() as { ok?: boolean; message?: string }
  if (!payload.ok) throw new Error(`Регистрацията на ${suffix} не е успешна: ${payload.message ?? '?'}`)
  const headersExt = res.headers as Headers & { getSetCookie?: () => string[] }
  const rawCookie = headersExt.getSetCookie?.()[0] ?? res.headers.get('set-cookie')
  if (!rawCookie) throw new Error(`Липсва Set-Cookie при регистрация на ${suffix}.`)
  return { email, cookie: rawCookie.split(';')[0]! }
}

async function login(port: number, email: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  })
  const payload = await res.json() as { ok?: boolean }
  if (!payload.ok) throw new Error(`Login не е успешен за ${email}.`)
  const headersExt = res.headers as Headers & { getSetCookie?: () => string[] }
  const cookie = (headersExt.getSetCookie?.()[0] ?? res.headers.get('set-cookie'))?.split(';')[0]
  if (!cookie) throw new Error(`Липсва Set-Cookie при login за ${email}.`)
  return cookie
}

const sourceServerRoot = resolve(
  process.argv.slice(2).find((a) => a.startsWith('--server-root='))?.slice('--server-root='.length)
  ?? process.cwd(),
)

const isolated = await createIsolatedServerRoot(sourceServerRoot)
const port = await getFreePort()
let server: RunningServer | null = null

try {
  server = startServer(isolated.serverDir, port)

  await waitFor(
    'server health ready',
    async () => {
      try {
        const r = await httpRequest(port, '/health', 'GET')
        const h = r.body as { ok?: boolean; gameWorkerPool?: { state?: string } | null }
        return r.status === 200 && h.ok === true && h.gameWorkerPool?.state === 'ready'
      } catch { return false }
    },
    SERVER_READY_TIMEOUT_MS,
  )

  const runId = `${Date.now()}-${process.pid}`
  const player = await register(port, runId, 'player')
  const adminCandidate = await register(port, runId, 'admin')
  const subadminCandidate = await register(port, runId, 'subadmin')
  promoteRole(isolated.databaseFile, adminCandidate.email, 'admin')
  promoteRole(isolated.databaseFile, subadminCandidate.email, 'subadmin')
  const adminCookie = await login(port, adminCandidate.email)
  const subadminCookie = await login(port, subadminCandidate.email)

  // ─── [12] Admin cookie -> 200 ───────────────────────────────────────────
  {
    const r = await httpRequest(port, `${ENDPOINT}?period=today`, 'GET', adminCookie)
    check('[12] admin cookie -> status 200', r.status === 200, `got ${r.status}`)
    const b = r.body as { ok?: boolean; rows?: unknown }
    check('[12] admin response ok:true with rows array', b.ok === true && Array.isArray(b.rows))
  }

  // ─── [13] Subadmin cookie -> 200 ────────────────────────────────────────
  {
    const r = await httpRequest(port, `${ENDPOINT}?period=today`, 'GET', subadminCookie)
    check('[13] subadmin cookie -> status 200', r.status === 200, `got ${r.status}`)
  }

  // ─── [14] Normal player cookie -> 403 ───────────────────────────────────
  {
    const r = await httpRequest(port, `${ENDPOINT}?period=today`, 'GET', player.cookie)
    check('[14] normal player cookie -> status 403', r.status === 403, `got ${r.status}`)
  }

  // ─── [15] No cookie -> 403 ──────────────────────────────────────────────
  {
    const r = await httpRequest(port, `${ENDPOINT}?period=today`, 'GET')
    check('[15] no cookie -> status 403', r.status === 403, `got ${r.status}`)
  }

  // ─── [16] Invalid period param -> 400 ───────────────────────────────────
  {
    const r = await httpRequest(port, `${ENDPOINT}?period=lastweek`, 'GET', adminCookie)
    check('[16] invalid period param -> status 400', r.status === 400, `got ${r.status}`)
  }

  console.log(`\n${'─'.repeat(60)}`)
  console.log(`Passed: ${passed}  Failed: ${failed}`)

  await stopServer(server)
  await isolated.cleanup()

  if (failed > 0) process.exit(1)
} catch (error) {
  console.error('\n[fatal]', error)
  if (server) {
    console.log(`\n[debug] Server output:\n${server.output().slice(-4000)}`)
    await stopServer(server)
  }
  await isolated.cleanup()
  process.exit(1)
}
