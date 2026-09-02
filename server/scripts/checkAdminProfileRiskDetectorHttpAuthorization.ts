/**
 * checkAdminProfileRiskDetectorHttpAuthorization.ts
 *
 * Малък E2E тест на admin "risk detector" фийчъра (linked-profiles чрез
 * споделен anonymous_visitor_id):
 *   GET  /api/admin/registered-profiles?period=all|today|yesterday (risk annotation)
 *   GET  /api/admin/profiles/:id/risk-detail
 *   POST /api/admin/profiles/:id/risk-recheck
 *
 * Изолирано копие на реалния сървър (собствена temp SQLite база, реални
 * migrations, реален HTTP слой) — mirror на
 * checkAdminProfileBanAndDeleteHttpAuthorization.ts (същите helper
 * функции: httpRequest/check/waitFor/register/promoteRole/startServer).
 *
 * Покрива:
 *  (а) subadmin/player => 403 на трите нови endpoints (само risk-detail и
 *      risk-recheck; registered-profiles остава baseline достъпен за
 *      subadmin, но БЕЗ risk полета в response body-то — проверяваме и
 *      това разделение)
 *  (б) два профила, споделящи anonymous_visitor_id (seed директно в
 *      site_visitors/site_visit_events), водят до risk_detected=1 и за
 *      двата, след като admin отвори list view за единия (linked-partner
 *      upsert логиката — spec §6)
 *  (в) admin_profile_risk_checks съдържа очаквания брой redове след batch
 *      check (bounded storage проверка)
 *  (г) втори admin fetch на СЪЩИЯ период НЕ предизвиква recompute за вече
 *      кеширани profile ids (unchanged checked_at между двете заявки)
 */

import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { join, resolve } from 'node:path'

const PASSWORD = 'RiskSmoke1!'
const SERVER_READY_TIMEOUT_MS = 30_000

let passed = 0
let failed = 0

function pass(label: string): void {
  passed++
  console.log(`  PASS  ${label}`)
}

function fail(label: string, reason: unknown): void {
  failed++
  const msg = reason instanceof Error ? reason.message : String(reason)
  console.error(`  FAIL  ${label}: ${msg}`)
}

async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    pass(label)
  } catch (err) {
    fail(label, err)
  }
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

function httpRequest(
  port: number,
  pathname: string,
  method: string,
  cookie?: string,
  jsonBody?: unknown,
): Promise<HttpResult> {
  return new Promise((res, reject) => {
    const headers: Record<string, string> = {}
    if (cookie) headers['Cookie'] = cookie
    let payload: string | undefined
    if (jsonBody !== undefined) {
      payload = JSON.stringify(jsonBody)
      headers['Content-Type'] = 'application/json'
      headers['Content-Length'] = String(Buffer.byteLength(payload))
    }

    const req = request(
      { hostname: '127.0.0.1', port, path: pathname, method, headers, timeout: 5000 },
      (r) => {
        const chunks: Buffer[] = []
        r.on('data', (c) => chunks.push(Buffer.from(c)))
        r.on('end', () => {
          let body: unknown = null
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { /* not JSON */ }
          res({ status: r.statusCode ?? 0, body })
        })
      },
    )
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
  const root = await mkdtemp(join(tmpdir(), 'belot-risk-detector-smoke-'))
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
    root,
    serverDir,
    databaseFile,
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
      env: {
        ...process.env,
        PORT: String(port),
        BELOT_GAME_WORKER_TICK_MODE: 'worker-candidate',
        BELOT_GAME_WORKER_COUNT: '1',
      },
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

function promoteRole(databaseFile: string, email: string, role: string): void {
  const db = new DatabaseSync(databaseFile)
  db.exec('PRAGMA journal_mode = WAL;')
  db.prepare(`UPDATE accounts SET role = ?, updated_at = CURRENT_TIMESTAMP WHERE email = ?`).run(role, email)
  db.close()
}

type RegisteredUser = { cookie: string; profileId: string; accountId: string; email: string; displayName: string }

async function register(port: number, runId: string, suffix: string): Promise<RegisteredUser> {
  const email = `risk-smoke-${runId}-${suffix}@example.test`
  const displayName = `RiskSmoke${runId.replace(/[^0-9]/g, '').slice(-6)}${suffix}`
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, displayName, gender: 'male' }),
  })
  if (res.status !== 200) throw new Error(`Регистрацията (${suffix}) върна status ${res.status}.`)
  const payload = await res.json() as { ok?: boolean; session?: { profile: { profileId: string }; account: { accountId: string } }; message?: string }
  if (!payload.ok || !payload.session) throw new Error(`Регистрацията (${suffix}) не е успешна: ${payload.message ?? '?'}`)

  const headersExt = res.headers as Headers & { getSetCookie?: () => string[] }
  const rawCookie = headersExt.getSetCookie?.()[0] ?? res.headers.get('set-cookie')
  if (!rawCookie) throw new Error(`Липсва Set-Cookie при регистрация (${suffix}).`)
  return {
    cookie: rawCookie.split(';')[0]!,
    profileId: payload.session.profile.profileId,
    accountId: payload.session.account.accountId,
    email,
    displayName,
  }
}

async function login(port: number, email: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  })
  const payload = await res.json().catch(() => null) as { ok?: boolean } | null
  const headersExt = res.headers as Headers & { getSetCookie?: () => string[] }
  const rawCookie = headersExt.getSetCookie?.()[0] ?? res.headers.get('set-cookie')
  if (res.status !== 200 || !payload?.ok || !rawCookie) throw new Error(`Login не е успешен за ${email}: status=${res.status}`)
  return rawCookie.split(';')[0]!
}

const sourceServerRoot = resolve(
  process.argv.slice(2).find((a) => a.startsWith('--server-root='))?.slice('--server-root='.length) ?? process.cwd(),
)

console.log('\n═══ Admin profile risk detector HTTP authorization + logic E2E test ═══')
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

  console.log('\n[setup] Регистрация на потребители с различни роли...')
  const player = await register(port, runId, 'player')
  const linkedA = await register(port, runId, 'linkeda')
  const linkedB = await register(port, runId, 'linkedb')
  const cleanTarget = await register(port, runId, 'clean')
  const adminCandidate = await register(port, runId, 'admin')
  const subadminCandidate = await register(port, runId, 'subadmin')

  promoteRole(isolated.databaseFile, adminCandidate.email, 'admin')
  promoteRole(isolated.databaseFile, subadminCandidate.email, 'subadmin')

  const adminCookie = await login(port, adminCandidate.email)
  const subadminCookie = await login(port, subadminCandidate.email)

  const linkedC = await register(port, runId, 'linkedc')
  // За cache-invalidation сценариите (А/Б/В по-долу): staleCleanA беше
  // fully-checked и clean, staleRiskyA беше fully-checked с точен стар count,
  // batchA/batchX са explicit targets в ЕДИН batch (проверка на sequencing-а).
  const staleCleanA = await register(port, runId, 'stalecleana')
  const staleCleanX = await register(port, runId, 'stalecleanx')
  const staleRiskyA = await register(port, runId, 'staleriskya')
  const staleRiskyOld = await register(port, runId, 'staleriskyold')
  const staleRiskyX = await register(port, runId, 'staleriskyx')
  const batchA = await register(port, runId, 'batcha')
  const batchX = await register(port, runId, 'batchx')
  // Round 3 fix (no-ping-pong): noPingA/noPingX ще бъдат fully checked
  // ПОСЛЕ evidence-ът им е seed-нат — двата fetch-ва трябва да останат
  // стабилни, докато няма НОВО evidence след последния им checked_at.
  const noPingA = await register(port, runId, 'nopinga')
  const noPingX = await register(port, runId, 'nopingx')

  console.log('  Регистрирани: player, linkedA, linkedB (споделят visitor id), linkedC (свързан само с linkedB), clean (без risk), admin, subadmin.')

  // ── seed: linkedA и linkedB споделят anonymous_visitor_id ───────────────
  console.log('\n[seed] site_visitors/site_visit_events за linkedA/linkedB (споделен visitor id)')
  const seedDb = new DatabaseSync(isolated.databaseFile, { open: true })
  seedDb.exec('PRAGMA journal_mode = WAL;')
  const sharedVisitorId = `visitor-${runId}`
  seedDb.prepare(`
    INSERT INTO site_visitors (
      anonymous_visitor_id, first_seen_at, last_seen_at,
      first_profile_id, last_profile_id, first_ip_address, last_ip_address
    ) VALUES (?, '2026-01-01 08:00:00', '2026-01-01 09:00:00', ?, ?, '203.0.113.30', '203.0.113.30')
  `).run(sharedVisitorId, linkedA.profileId, linkedB.profileId)
  seedDb.prepare(`
    INSERT INTO site_visit_events (
      page_view_id, anonymous_visitor_id, profile_id, path, navigation_type, occurred_at, ip_address
    ) VALUES (?, ?, ?, '/lobby', 'navigate', '2026-01-01 08:00:00', '203.0.113.30')
  `).run(randomUUID(), sharedVisitorId, linkedA.profileId)
  seedDb.prepare(`
    INSERT INTO site_visit_events (
      page_view_id, anonymous_visitor_id, profile_id, path, navigation_type, occurred_at, ip_address
    ) VALUES (?, ?, ?, '/lobby', 'navigate', '2026-01-01 09:00:00', '203.0.113.30')
  `).run(randomUUID(), sharedVisitorId, linkedB.profileId)
  // cleanTarget си има собствен, несподелен visitor id — не трябва да light-не risk.
  const soloVisitorId = `visitor-solo-${runId}`
  seedDb.prepare(`
    INSERT INTO site_visitors (anonymous_visitor_id, first_seen_at, last_seen_at, first_profile_id, last_profile_id)
    VALUES (?, '2026-01-01 08:00:00', '2026-01-01 08:00:00', ?, ?)
  `).run(soloVisitorId, cleanTarget.profileId, cleanTarget.profileId)
  seedDb.prepare(`
    INSERT INTO site_visit_events (page_view_id, anonymous_visitor_id, profile_id, path, navigation_type, occurred_at, ip_address)
    VALUES (?, ?, ?, '/lobby', 'navigate', '2026-01-01 08:00:00', '203.0.113.99')
  `).run(randomUUID(), soloVisitorId, cleanTarget.profileId)
  // linkedB И linkedC споделят ВТОРИ, отделен visitor id (linkedA НЕ участва
  // в него) — точно scenario-то от production bug-а: когато linkedA бъде
  // fetched като target, linkedB се upsert-ва само indirectly (check_complete
  // =0, груб count=1), но реалната пълна linked група на linkedB е 2
  // (linkedA + linkedC), не 1. Fix-ът трябва да гарантира, че linkedB
  // получава собствен full analysis следващия път, когато е в target batch-а.
  const secondSharedVisitorId = `visitor-bc-${runId}`
  seedDb.prepare(`
    INSERT INTO site_visitors (
      anonymous_visitor_id, first_seen_at, last_seen_at,
      first_profile_id, last_profile_id, first_ip_address, last_ip_address
    ) VALUES (?, '2026-01-01 10:00:00', '2026-01-01 11:00:00', ?, ?, '203.0.113.40', '203.0.113.40')
  `).run(secondSharedVisitorId, linkedB.profileId, linkedC.profileId)
  seedDb.prepare(`
    INSERT INTO site_visit_events (
      page_view_id, anonymous_visitor_id, profile_id, path, navigation_type, occurred_at, ip_address
    ) VALUES (?, ?, ?, '/lobby', 'navigate', '2026-01-01 10:00:00', '203.0.113.40')
  `).run(randomUUID(), secondSharedVisitorId, linkedB.profileId)
  seedDb.prepare(`
    INSERT INTO site_visit_events (
      page_view_id, anonymous_visitor_id, profile_id, path, navigation_type, occurred_at, ip_address
    ) VALUES (?, ?, ?, '/lobby', 'navigate', '2026-01-01 11:00:00', '203.0.113.40')
  `).run(randomUUID(), secondSharedVisitorId, linkedC.profileId)

  // staleRiskyA/staleRiskyOld споделят visitor id ОТ САМОТО НАЧАЛО (за
  // сценарий Б — staleRiskyA ще бъде fully-checked с точен стар count=1,
  // ПРЕДИ staleRiskyX да добави нова връзка).
  const staleRiskyVisitorId = `visitor-stale-risky-${runId}`
  seedDb.prepare(`
    INSERT INTO site_visitors (
      anonymous_visitor_id, first_seen_at, last_seen_at,
      first_profile_id, last_profile_id, first_ip_address, last_ip_address
    ) VALUES (?, '2026-01-01 08:00:00', '2026-01-01 08:00:00', ?, ?, '203.0.113.50', '203.0.113.50')
  `).run(staleRiskyVisitorId, staleRiskyA.profileId, staleRiskyOld.profileId)
  seedDb.prepare(`
    INSERT INTO site_visit_events (
      page_view_id, anonymous_visitor_id, profile_id, path, navigation_type, occurred_at, ip_address
    ) VALUES (?, ?, ?, '/lobby', 'navigate', '2026-01-01 08:00:00', '203.0.113.50')
  `).run(randomUUID(), staleRiskyVisitorId, staleRiskyA.profileId)
  seedDb.prepare(`
    INSERT INTO site_visit_events (
      page_view_id, anonymous_visitor_id, profile_id, path, navigation_type, occurred_at, ip_address
    ) VALUES (?, ?, ?, '/lobby', 'navigate', '2026-01-01 08:00:00', '203.0.113.50')
  `).run(randomUUID(), staleRiskyVisitorId, staleRiskyOld.profileId)

  // batchA/batchX споделят visitor id — ще бъдат fetched КАТО ДВАТА explicit
  // targets в ЕДИН list batch (сценарий В: batch-ordering не трябва да
  // downgrade-не единия explicit target с indirect upsert-а на другия).
  const batchVisitorId = `visitor-batch-${runId}`
  seedDb.prepare(`
    INSERT INTO site_visitors (
      anonymous_visitor_id, first_seen_at, last_seen_at,
      first_profile_id, last_profile_id, first_ip_address, last_ip_address
    ) VALUES (?, '2026-01-01 08:00:00', '2026-01-01 08:00:00', ?, ?, '203.0.113.60', '203.0.113.60')
  `).run(batchVisitorId, batchA.profileId, batchX.profileId)
  seedDb.prepare(`
    INSERT INTO site_visit_events (
      page_view_id, anonymous_visitor_id, profile_id, path, navigation_type, occurred_at, ip_address
    ) VALUES (?, ?, ?, '/lobby', 'navigate', '2026-01-01 08:00:00', '203.0.113.60')
  `).run(randomUUID(), batchVisitorId, batchA.profileId)
  seedDb.prepare(`
    INSERT INTO site_visit_events (
      page_view_id, anonymous_visitor_id, profile_id, path, navigation_type, occurred_at, ip_address
    ) VALUES (?, ?, ?, '/lobby', 'navigate', '2026-01-01 08:00:00', '203.0.113.60')
  `).run(randomUUID(), batchVisitorId, batchX.profileId)

  // noPingA/noPingX споделят visitor id ОТ САМОТО НАЧАЛО (исторически
  // timestamp, преди двата да бъдат fully checked) — за no-ping-pong
  // сценария (round 3): щом веднъж и двата минат explicit full analysis
  // СЛЕД това evidence, повторни fetch-ове на единия не трябва да
  // invalidate-ват другия, тъй като evidence-ът не се е променил.
  const noPingVisitorId = `visitor-no-pingpong-${runId}`
  seedDb.prepare(`
    INSERT INTO site_visitors (
      anonymous_visitor_id, first_seen_at, last_seen_at,
      first_profile_id, last_profile_id, first_ip_address, last_ip_address
    ) VALUES (?, '2026-01-01 08:00:00', '2026-01-01 08:00:00', ?, ?, '203.0.113.90', '203.0.113.90')
  `).run(noPingVisitorId, noPingA.profileId, noPingX.profileId)
  seedDb.prepare(`
    INSERT INTO site_visit_events (
      page_view_id, anonymous_visitor_id, profile_id, path, navigation_type, occurred_at, ip_address
    ) VALUES (?, ?, ?, '/lobby', 'navigate', '2026-01-01 08:00:00', '203.0.113.90')
  `).run(randomUUID(), noPingVisitorId, noPingA.profileId)
  seedDb.prepare(`
    INSERT INTO site_visit_events (
      page_view_id, anonymous_visitor_id, profile_id, path, navigation_type, occurred_at, ip_address
    ) VALUES (?, ?, ?, '/lobby', 'navigate', '2026-01-01 08:00:00', '203.0.113.90')
  `).run(randomUUID(), noPingVisitorId, noPingX.profileId)
  seedDb.close()

  // ── (а) authorization: subadmin/player => 403 на risk-detail/risk-recheck ──
  console.log('\n[authz] subadmin/player => 403 на risk-detail и risk-recheck')
  const NON_FULL_ADMIN_SESSIONS: Array<{ label: string; cookie: string }> = [
    { label: 'player', cookie: player.cookie },
    { label: 'subadmin', cookie: subadminCookie },
  ]
  for (const { label, cookie } of NON_FULL_ADMIN_SESSIONS) {
    await check(`[authz] ${label} -> GET risk-detail => 403`, async () => {
      const r = await httpRequest(port, `/api/admin/profiles/${linkedA.profileId}/risk-detail`, 'GET', cookie)
      if (r.status !== 403) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
    })
    await check(`[authz] ${label} -> POST risk-recheck => 403`, async () => {
      const r = await httpRequest(port, `/api/admin/profiles/${linkedA.profileId}/risk-recheck`, 'POST', cookie)
      if (r.status !== 403) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
    })
  }
  await check('[authz] guest (без cookie) -> GET risk-detail => 403', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${linkedA.profileId}/risk-detail`, 'GET', undefined)
    if (r.status !== 403) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
  })

  // ── subadmin вижда registered-profiles списъка, но БЕЗ risk полета ──────
  console.log('\n[authz] subadmin -> GET registered-profiles: списъкът е достъпен, но БЕЗ risk полета')
  await check('[authz] subadmin -> registered-profiles?period=all => 200, редовете БЕЗ riskDetected поле', async () => {
    const r = await httpRequest(port, '/api/admin/registered-profiles?period=all&page=1', 'GET', subadminCookie)
    const b = r.body as { ok?: boolean; rows?: Array<{ profileId: string; riskDetected?: boolean }> }
    if (r.status !== 200 || b.ok !== true || !Array.isArray(b.rows)) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
    const row = b.rows.find((x) => x.profileId === linkedA.profileId)
    if (row && row.riskDetected !== undefined) throw new Error(`subadmin получи riskDetected поле: ${JSON.stringify(row)}`)
  })

  // ── (б) admin анализира САМО linkedA (изолирано, чрез risk-recheck — не
  //    list fetch, защото period=all винаги batch-ва ВСИЧКИ регистрирани
  //    профили накуп, включително linkedB, което би направило linkedB
  //    директен target от самото начало и няма да пресъздаде production
  //    bug сценария) -> risk_detected=1 за linkedA И linkedB (indirect) ──
  console.log('\n[risk-flow] admin -> POST risk-recheck(linkedA) изолирано => linkedA директен target, linkedB indirect partner')
  let firstCheckedAtA: string | null = null
  await check('[risk-flow] admin -> POST risk-recheck(linkedA) => 200, riskDetected=true, linkedProfilesCount>=1', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${linkedA.profileId}/risk-recheck`, 'POST', adminCookie)
    const b = r.body as { ok?: boolean; riskDetected?: boolean; linkedProfilesCount?: number }
    if (r.status !== 200 || b.ok !== true) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
    if (b.riskDetected !== true) throw new Error(`riskDetected=${b.riskDetected}`)
    if (!b.linkedProfilesCount || b.linkedProfilesCount < 1) throw new Error(`linkedProfilesCount=${b.linkedProfilesCount}`)
  })
  {
    const db = new DatabaseSync(isolated.databaseFile, { open: true })
    const row = db.prepare(`SELECT checked_at FROM admin_profile_risk_checks WHERE profile_id = ?`).get(linkedA.profileId) as { checked_at: string } | undefined
    db.close()
    firstCheckedAtA = row?.checked_at ?? null
  }
  await check('[risk-flow] firstCheckedAtA е записан', () => {
    if (!firstCheckedAtA) throw new Error('Липсва checked_at след risk-recheck(linkedA).')
  })

  await check('[risk-flow] linkedB (НЕ директно checked, но е linked partner) също е risk_detected=1 (spec §6 upsert логика)', async () => {
    const db = new DatabaseSync(isolated.databaseFile, { open: true })
    const row = db.prepare(`SELECT risk_detected FROM admin_profile_risk_checks WHERE profile_id = ?`).get(linkedB.profileId) as { risk_detected: number } | undefined
    db.close()
    if (!row || row.risk_detected !== 1) throw new Error(`linkedB admin_profile_risk_checks row: ${JSON.stringify(row)}`)
  })

  // ── production QA bug fix: indirect partner upsert => check_complete=0,
  //    частичен count, list UI не показва точно число; после B попада в
  //    target batch (list fetch) -> full analysis -> check_complete=1,
  //    точен count (linkedA + linkedC = 2) -> следващ fetch НЕ recompute-ва ──
  console.log('\n[check-complete] linkedB indirect upsert => check_complete=0, груб/частичен count; после full analysis => check_complete=1, точен count=2')
  await check('[check-complete] след risk-recheck(linkedA): linkedB е check_complete=0 в DB (indirect upsert, НЕ fully checked)', () => {
    const db = new DatabaseSync(isolated.databaseFile, { open: true })
    const row = db.prepare(`SELECT check_complete, linked_profiles_count FROM admin_profile_risk_checks WHERE profile_id = ?`).get(linkedB.profileId) as { check_complete: number; linked_profiles_count: number } | undefined
    db.close()
    if (!row || row.check_complete !== 0) throw new Error(`linkedB row: ${JSON.stringify(row)}`)
  })

  let linkedBCheckedAtAfterFullAnalysis: string | null = null
  await check('[check-complete] linkedB попада в list fetch batch (симулира "Регистрирани" отваряне, докато B е сред резултатите) -> получава собствен full analysis, riskCheckComplete:true, точен count=2', async () => {
    const r = await httpRequest(port, '/api/admin/registered-profiles?period=all&page=1', 'GET', adminCookie)
    const b = r.body as { ok?: boolean; rows?: Array<{ profileId: string; riskDetected?: boolean; linkedProfilesCount?: number; riskCheckComplete?: boolean }> }
    if (r.status !== 200 || b.ok !== true || !Array.isArray(b.rows)) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
    const rowClean = b.rows.find((x) => x.profileId === cleanTarget.profileId)
    if (!rowClean || rowClean.riskDetected !== false) throw new Error(`cleanTarget row (очаквах riskDetected:false): ${JSON.stringify(rowClean)}`)
    const rowB = b.rows.find((x) => x.profileId === linkedB.profileId)
    if (!rowB) throw new Error('linkedB липсва от list резултатите.')
    if (rowB.riskCheckComplete !== true) throw new Error(`linkedB.riskCheckComplete=${rowB.riskCheckComplete}, очаквах true след full analysis`)
    if (rowB.linkedProfilesCount !== 2) throw new Error(`linkedB.linkedProfilesCount=${rowB.linkedProfilesCount}, очаквах точно 2 (linkedA + linkedC)`)
  })
  await check('[check-complete] admin_profile_risk_checks: linkedB вече check_complete=1 с точен count=2 в DB', () => {
    const db = new DatabaseSync(isolated.databaseFile, { open: true })
    const row = db.prepare(`SELECT check_complete, linked_profiles_count, checked_at FROM admin_profile_risk_checks WHERE profile_id = ?`).get(linkedB.profileId) as { check_complete: number; linked_profiles_count: number; checked_at: string } | undefined
    db.close()
    if (!row || row.check_complete !== 1 || row.linked_profiles_count !== 2) throw new Error(`linkedB row: ${JSON.stringify(row)}`)
    linkedBCheckedAtAfterFullAnalysis = row.checked_at
  })
  // Забележка за chain-reaction поведението (round 2 fix, т.2): linkedA-
  // linkedB-linkedC е ВЕРИГА от директни връзки (A<->B, B<->C), не просто
  // двойка — щом кой да е от тях стане explicit target и намери съсед като
  // partner, съседът (ако не Е explicit target в СЪЩИЯ batch) се
  // invalidate-ва отново, дори ако преди малко е бил fully-checked. Затова
  // цялата верига се стабилизира трайно само когато ВСИЧКИТЕ трима станат
  // explicit targets В ЕДИН И СЪЩ batch (т.3 sequencing защитата) — точно
  // това проверяваме тук: forced-delete на трите cache reda (симулира "и
  // трите едновременно unchecked"), после ЕДИН list fetch ги compute-
  // computва заедно и от този момент нататък остават стабилни.
  await check('[check-complete] forced delete на linkedA/linkedB/linkedC от cache -> симулира "и трите едновременно unchecked" (верига A<->B<->C)', () => {
    const db = new DatabaseSync(isolated.databaseFile, { open: true })
    db.prepare(`DELETE FROM admin_profile_risk_checks WHERE profile_id IN (?, ?, ?)`).run(linkedA.profileId, linkedB.profileId, linkedC.profileId)
    db.close()
  })
  let linkedBCheckedAtAfterJointFullAnalysis: string | null = null
  await check('[check-complete] list fetch с linkedA/linkedB/linkedC едновременно unchecked (ЕДИН batch) -> и трите стават check_complete=1, exact counts', async () => {
    const r = await httpRequest(port, '/api/admin/registered-profiles?period=all&page=1', 'GET', adminCookie)
    const b = r.body as { ok?: boolean; rows?: Array<{ profileId: string; riskDetected?: boolean; linkedProfilesCount?: number; riskCheckComplete?: boolean }> }
    if (r.status !== 200 || b.ok !== true || !Array.isArray(b.rows)) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
    const rowA = b.rows.find((x) => x.profileId === linkedA.profileId)
    const rowB = b.rows.find((x) => x.profileId === linkedB.profileId)
    const rowC = b.rows.find((x) => x.profileId === linkedC.profileId)
    if (!rowA || rowA.riskCheckComplete !== true || rowA.linkedProfilesCount !== 1) throw new Error(`linkedA row: ${JSON.stringify(rowA)}`)
    if (!rowB || rowB.riskCheckComplete !== true || rowB.linkedProfilesCount !== 2) throw new Error(`linkedB row: ${JSON.stringify(rowB)}`)
    if (!rowC || rowC.riskCheckComplete !== true || rowC.linkedProfilesCount !== 1) throw new Error(`linkedC row: ${JSON.stringify(rowC)}`)
    const db = new DatabaseSync(isolated.databaseFile, { open: true })
    const row = db.prepare(`SELECT checked_at FROM admin_profile_risk_checks WHERE profile_id = ?`).get(linkedB.profileId) as { checked_at: string } | undefined
    db.close()
    linkedBCheckedAtAfterJointFullAnalysis = row?.checked_at ?? null
  })
  await sleep(1100)
  await check('[check-complete] следващ list fetch (цялата верига вече complete от joint batch-а) НЕ recompute-ва linkedB (checked_at непроменен)', async () => {
    const r = await httpRequest(port, '/api/admin/registered-profiles?period=all&page=1', 'GET', adminCookie)
    if (r.status !== 200) throw new Error(`status=${r.status}`)
    const db = new DatabaseSync(isolated.databaseFile, { open: true })
    const row = db.prepare(`SELECT checked_at FROM admin_profile_risk_checks WHERE profile_id = ?`).get(linkedB.profileId) as { checked_at: string } | undefined
    db.close()
    if (row?.checked_at !== linkedBCheckedAtAfterJointFullAnalysis) {
      throw new Error(`checked_at се промени: преди=${linkedBCheckedAtAfterJointFullAnalysis}, сега=${row?.checked_at}`)
    }
  })

  // ── cache-consistency fix (round 2): indirect discovery трябва да
  //    invalidate-ва И вече fully-checked редове (не само нови), но НЕ
  //    трябва да downgrade-не explicit targets в СЪЩИЯ batch ──────────────

  // Сценарий А: staleCleanA е fully checked и clean (0 linked). После нов
  // X (staleCleanX) се свързва с него -> A трябва да стане risk=true,
  // check_complete=false -> след list fetch на A: check_complete=true,
  // exact count.
  console.log('\n[invalidate-A] Existing fully-checked CLEAN A -> нов X linked -> A става risk=true + check_complete=false -> full analysis при следващ fetch')
  await check('[invalidate-A] admin -> POST risk-recheck(staleCleanA) => fully checked, clean (riskDetected:false)', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${staleCleanA.profileId}/risk-recheck`, 'POST', adminCookie)
    const b = r.body as { ok?: boolean; riskDetected?: boolean }
    if (r.status !== 200 || b.ok !== true) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
    if (b.riskDetected !== false) throw new Error(`riskDetected=${b.riskDetected}, очаквах false (все още няма linked profiles)`)
  })
  await check('[invalidate-A] admin_profile_risk_checks: staleCleanA е check_complete=1, risk_detected=0 в DB', () => {
    const db = new DatabaseSync(isolated.databaseFile, { open: true })
    const row = db.prepare(`SELECT check_complete, risk_detected FROM admin_profile_risk_checks WHERE profile_id = ?`).get(staleCleanA.profileId) as { check_complete: number; risk_detected: number } | undefined
    db.close()
    if (!row || row.check_complete !== 1 || row.risk_detected !== 0) throw new Error(`staleCleanA row: ${JSON.stringify(row)}`)
  })
  // Round 3 fix: indirect discovery invalidate-ва fully-checked partner
  // САМО ако shared evidence-ът е СТРОГО по-нов от partner.checked_at —
  // затова тук seed-ваме evidence-а с CURRENT_TIMESTAMP (реално "сега",
  // след staleCleanA-то recheck по-горе), не хардкоднат минал timestamp,
  // за да гарантираме че evidence-ът реално е по-нов.
  await sleep(1100)
  {
    // Нов X се появява и се свързва с A (споделен visitor id) — симулира
    // "нов регистриран профил ползва browser identity-то на стар профил".
    const db = new DatabaseSync(isolated.databaseFile, { open: true })
    db.exec('PRAGMA journal_mode = WAL;')
    const visitorId = `visitor-invalidate-a-${runId}`
    db.prepare(`
      INSERT INTO site_visitors (
        anonymous_visitor_id, first_seen_at, last_seen_at,
        first_profile_id, last_profile_id, first_ip_address, last_ip_address
      ) VALUES (?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, ?, '203.0.113.70', '203.0.113.70')
    `).run(visitorId, staleCleanA.profileId, staleCleanX.profileId)
    db.prepare(`
      INSERT INTO site_visit_events (page_view_id, anonymous_visitor_id, profile_id, path, navigation_type, occurred_at, ip_address)
      VALUES (?, ?, ?, '/lobby', 'navigate', CURRENT_TIMESTAMP, '203.0.113.70')
    `).run(randomUUID(), visitorId, staleCleanA.profileId)
    db.prepare(`
      INSERT INTO site_visit_events (page_view_id, anonymous_visitor_id, profile_id, path, navigation_type, occurred_at, ip_address)
      VALUES (?, ?, ?, '/lobby', 'navigate', CURRENT_TIMESTAMP, '203.0.113.70')
    `).run(randomUUID(), visitorId, staleCleanX.profileId)
    db.close()
  }
  await check('[invalidate-A] admin -> POST risk-recheck(staleCleanX) => открива A indirectly -> A става risk=true, check_complete=false', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${staleCleanX.profileId}/risk-recheck`, 'POST', adminCookie)
    if (r.status !== 200) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
    const db = new DatabaseSync(isolated.databaseFile, { open: true })
    const row = db.prepare(`SELECT check_complete, risk_detected FROM admin_profile_risk_checks WHERE profile_id = ?`).get(staleCleanA.profileId) as { check_complete: number; risk_detected: number } | undefined
    db.close()
    if (!row || row.risk_detected !== 1 || row.check_complete !== 0) throw new Error(`staleCleanA row след X discovery: ${JSON.stringify(row)}`)
  })
  await check('[invalidate-A] list fetch докато A е в резултатите -> A получава full analysis -> check_complete=true, exact count', async () => {
    const r = await httpRequest(port, '/api/admin/registered-profiles?period=all&page=1', 'GET', adminCookie)
    const b = r.body as { ok?: boolean; rows?: Array<{ profileId: string; riskDetected?: boolean; linkedProfilesCount?: number; riskCheckComplete?: boolean }> }
    if (r.status !== 200 || b.ok !== true || !Array.isArray(b.rows)) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
    const rowA = b.rows.find((x) => x.profileId === staleCleanA.profileId)
    if (!rowA) throw new Error('staleCleanA липсва от list резултатите.')
    if (rowA.riskDetected !== true || rowA.riskCheckComplete !== true) throw new Error(`staleCleanA row: ${JSON.stringify(rowA)}`)
    if (rowA.linkedProfilesCount !== 1) throw new Error(`staleCleanA.linkedProfilesCount=${rowA.linkedProfilesCount}, очаквах 1 (staleCleanX)`)
  })

  // Сценарий Б: staleRiskyA е fully checked, risky, с точен стар count=1
  // (staleRiskyOld). Нов X (staleRiskyX) добавя нова връзка -> A се
  // invalidate-ва до check_complete=false -> следващ list fetch дава новия
  // exact count=2.
  console.log('\n[invalidate-B] Existing fully-checked RISKY A (стар count=1) -> нов X добавя връзка -> invalidate -> next fetch дава новия exact count=2')
  await check('[invalidate-B] admin -> POST risk-recheck(staleRiskyA) => fully checked, risky, count=1 (staleRiskyOld)', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${staleRiskyA.profileId}/risk-recheck`, 'POST', adminCookie)
    const b = r.body as { ok?: boolean; riskDetected?: boolean; linkedProfilesCount?: number }
    if (r.status !== 200 || b.ok !== true) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
    if (b.riskDetected !== true || b.linkedProfilesCount !== 1) throw new Error(`riskDetected=${b.riskDetected}, linkedProfilesCount=${b.linkedProfilesCount}, очаквах true/1`)
  })
  // Round 3 fix: same причина като [invalidate-A] по-горе — evidence-ът
  // трябва да е СТРОГО по-нов от staleRiskyA.checked_at, за да invalidate-не
  // fully-checked partner-а.
  await sleep(1100)
  {
    const db = new DatabaseSync(isolated.databaseFile, { open: true })
    db.exec('PRAGMA journal_mode = WAL;')
    const visitorId = `visitor-invalidate-b-${runId}`
    db.prepare(`
      INSERT INTO site_visitors (
        anonymous_visitor_id, first_seen_at, last_seen_at,
        first_profile_id, last_profile_id, first_ip_address, last_ip_address
      ) VALUES (?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, ?, '203.0.113.80', '203.0.113.80')
    `).run(visitorId, staleRiskyA.profileId, staleRiskyX.profileId)
    db.prepare(`
      INSERT INTO site_visit_events (page_view_id, anonymous_visitor_id, profile_id, path, navigation_type, occurred_at, ip_address)
      VALUES (?, ?, ?, '/lobby', 'navigate', CURRENT_TIMESTAMP, '203.0.113.80')
    `).run(randomUUID(), visitorId, staleRiskyA.profileId)
    db.prepare(`
      INSERT INTO site_visit_events (page_view_id, anonymous_visitor_id, profile_id, path, navigation_type, occurred_at, ip_address)
      VALUES (?, ?, ?, '/lobby', 'navigate', CURRENT_TIMESTAMP, '203.0.113.80')
    `).run(randomUUID(), visitorId, staleRiskyX.profileId)
    db.close()
  }
  await check('[invalidate-B] admin -> POST risk-recheck(staleRiskyX) => открива A indirectly -> A invalidate-ва (check_complete=false), стар count=1 остава непроменен до full analysis', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${staleRiskyX.profileId}/risk-recheck`, 'POST', adminCookie)
    if (r.status !== 200) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
    const db = new DatabaseSync(isolated.databaseFile, { open: true })
    const row = db.prepare(`SELECT check_complete, risk_detected FROM admin_profile_risk_checks WHERE profile_id = ?`).get(staleRiskyA.profileId) as { check_complete: number; risk_detected: number } | undefined
    db.close()
    if (!row || row.risk_detected !== 1 || row.check_complete !== 0) throw new Error(`staleRiskyA row след X discovery: ${JSON.stringify(row)}`)
  })
  await check('[invalidate-B] list fetch докато A е в резултатите -> A получава full analysis -> exact count=2 (staleRiskyOld + staleRiskyX)', async () => {
    const r = await httpRequest(port, '/api/admin/registered-profiles?period=all&page=1', 'GET', adminCookie)
    const b = r.body as { ok?: boolean; rows?: Array<{ profileId: string; riskDetected?: boolean; linkedProfilesCount?: number; riskCheckComplete?: boolean }> }
    if (r.status !== 200 || b.ok !== true || !Array.isArray(b.rows)) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
    const rowA = b.rows.find((x) => x.profileId === staleRiskyA.profileId)
    if (!rowA) throw new Error('staleRiskyA липсва от list резултатите.')
    if (rowA.riskCheckComplete !== true) throw new Error(`staleRiskyA.riskCheckComplete=${rowA.riskCheckComplete}, очаквах true`)
    if (rowA.linkedProfilesCount !== 2) throw new Error(`staleRiskyA.linkedProfilesCount=${rowA.linkedProfilesCount}, очаквах точно 2 (стар count=1 беше STALE)`)
  })

  // Сценарий В: batchA и batchX са explicit targets в ЕДИН list batch ->
  // след batch-а и двата трябва да останат check_complete=true с exact
  // counts (indirect marking не трябва да downgrade-не explicit target).
  console.log('\n[invalidate-C] batchA и batchX са explicit targets в ЕДИН batch -> и двата остават check_complete=true с exact counts')
  await check('[invalidate-C] admin -> list fetch (batchA и batchX и двата unchecked, в СЪЩИЯ batch) => и двата check_complete=true, exact count=1', async () => {
    const r = await httpRequest(port, '/api/admin/registered-profiles?period=all&page=1', 'GET', adminCookie)
    const b = r.body as { ok?: boolean; rows?: Array<{ profileId: string; riskDetected?: boolean; linkedProfilesCount?: number; riskCheckComplete?: boolean }> }
    if (r.status !== 200 || b.ok !== true || !Array.isArray(b.rows)) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
    const rowBatchA = b.rows.find((x) => x.profileId === batchA.profileId)
    const rowBatchX = b.rows.find((x) => x.profileId === batchX.profileId)
    if (!rowBatchA || !rowBatchX) throw new Error(`batchA/batchX липсват от list резултатите: ${JSON.stringify({ rowBatchA, rowBatchX })}`)
    if (rowBatchA.riskCheckComplete !== true || rowBatchA.linkedProfilesCount !== 1) throw new Error(`batchA row: ${JSON.stringify(rowBatchA)}`)
    if (rowBatchX.riskCheckComplete !== true || rowBatchX.linkedProfilesCount !== 1) throw new Error(`batchX row: ${JSON.stringify(rowBatchX)}`)
  })
  await check('[invalidate-C] admin_profile_risk_checks: и двата check_complete=1 в DB (indirect marking не downgrade-на explicit target-ите)', () => {
    const db = new DatabaseSync(isolated.databaseFile, { open: true })
    const rowA = db.prepare(`SELECT check_complete, linked_profiles_count FROM admin_profile_risk_checks WHERE profile_id = ?`).get(batchA.profileId) as { check_complete: number; linked_profiles_count: number } | undefined
    const rowX = db.prepare(`SELECT check_complete, linked_profiles_count FROM admin_profile_risk_checks WHERE profile_id = ?`).get(batchX.profileId) as { check_complete: number; linked_profiles_count: number } | undefined
    db.close()
    if (!rowA || rowA.check_complete !== 1 || rowA.linked_profiles_count !== 1) throw new Error(`batchA row: ${JSON.stringify(rowA)}`)
    if (!rowX || rowX.check_complete !== 1 || rowX.linked_profiles_count !== 1) throw new Error(`batchX row: ${JSON.stringify(rowX)}`)
  })

  // ── round 3 fix: indirect discovery invalidate-ва fully-checked partner
  //    САМО когато shared evidence-ът е по-нов от partner.checked_at — не
  //    безусловно (production инцидент: A и X се гонеха между отделни list
  //    fetch-ове/дни без никаква нова връзка, безкраен ping-pong) ─────────
  console.log('\n[no-pingpong] А) noPingA/noPingX вече fully checked СЛЕД съществуващото evidence -> отделни fetch-ове не се invalidate-ват взаимно')
  let noPingACheckedAtStable: string | null = null
  let noPingXCheckedAtStable: string | null = null
  await check('[no-pingpong-A] admin -> POST risk-recheck(noPingA) => fully checked, риск (noPingX)', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${noPingA.profileId}/risk-recheck`, 'POST', adminCookie)
    const b = r.body as { ok?: boolean; riskDetected?: boolean; linkedProfilesCount?: number }
    if (r.status !== 200 || b.ok !== true) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
    if (b.riskDetected !== true || b.linkedProfilesCount !== 1) throw new Error(`riskDetected=${b.riskDetected}, linkedProfilesCount=${b.linkedProfilesCount}, очаквах true/1`)
  })
  await sleep(1100)
  await check('[no-pingpong-A] admin -> POST risk-recheck(noPingX) => fully checked, риск (noPingA) — evidence-ът е ОТПРЕДИ и двата checks, НЕ по-нов', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${noPingX.profileId}/risk-recheck`, 'POST', adminCookie)
    const b = r.body as { ok?: boolean; riskDetected?: boolean; linkedProfilesCount?: number }
    if (r.status !== 200 || b.ok !== true) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
    if (b.riskDetected !== true || b.linkedProfilesCount !== 1) throw new Error(`riskDetected=${b.riskDetected}, linkedProfilesCount=${b.linkedProfilesCount}, очаквах true/1`)
  })
  await check('[no-pingpong-A] noPingA остава check_complete=1 СЛЕД noPingX-то recheck (старото evidence не е по-ново от noPingA.checked_at)', () => {
    const db = new DatabaseSync(isolated.databaseFile, { open: true })
    const row = db.prepare(`SELECT check_complete, checked_at FROM admin_profile_risk_checks WHERE profile_id = ?`).get(noPingA.profileId) as { check_complete: number; checked_at: string } | undefined
    db.close()
    if (!row || row.check_complete !== 1) throw new Error(`noPingA row: ${JSON.stringify(row)}`)
    noPingACheckedAtStable = row.checked_at
  })
  {
    const db = new DatabaseSync(isolated.databaseFile, { open: true })
    const row = db.prepare(`SELECT checked_at FROM admin_profile_risk_checks WHERE profile_id = ?`).get(noPingX.profileId) as { checked_at: string } | undefined
    db.close()
    noPingXCheckedAtStable = row?.checked_at ?? null
  }
  await sleep(1100)
  await check('[no-pingpong-A] fetch A отделно (risk-detail) -> X остава check_complete=1, checked_at непроменен', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${noPingA.profileId}/risk-detail`, 'GET', adminCookie)
    if (r.status !== 200) throw new Error(`status=${r.status}`)
    const db = new DatabaseSync(isolated.databaseFile, { open: true })
    const row = db.prepare(`SELECT check_complete, checked_at FROM admin_profile_risk_checks WHERE profile_id = ?`).get(noPingX.profileId) as { check_complete: number; checked_at: string } | undefined
    db.close()
    if (!row || row.check_complete !== 1) throw new Error(`noPingX row: ${JSON.stringify(row)}`)
    if (row.checked_at !== noPingXCheckedAtStable) throw new Error(`noPingX.checked_at се промени: преди=${noPingXCheckedAtStable}, сега=${row.checked_at}`)
  })
  await check('[no-pingpong-A] list fetch (batch съдържа и двата) -> И двата остават check_complete=1, checked_at непроменени (без ping-pong)', async () => {
    const r = await httpRequest(port, '/api/admin/registered-profiles?period=all&page=1', 'GET', adminCookie)
    if (r.status !== 200) throw new Error(`status=${r.status}`)
    const db = new DatabaseSync(isolated.databaseFile, { open: true })
    const rowA = db.prepare(`SELECT check_complete, checked_at FROM admin_profile_risk_checks WHERE profile_id = ?`).get(noPingA.profileId) as { check_complete: number; checked_at: string } | undefined
    const rowX = db.prepare(`SELECT check_complete, checked_at FROM admin_profile_risk_checks WHERE profile_id = ?`).get(noPingX.profileId) as { check_complete: number; checked_at: string } | undefined
    db.close()
    if (!rowA || rowA.check_complete !== 1 || rowA.checked_at !== noPingACheckedAtStable) throw new Error(`noPingA row: ${JSON.stringify(rowA)}, очаквах checked_at=${noPingACheckedAtStable}`)
    if (!rowX || rowX.check_complete !== 1 || rowX.checked_at !== noPingXCheckedAtStable) throw new Error(`noPingX row: ${JSON.stringify(rowX)}, очаквах checked_at=${noPingXCheckedAtStable}`)
  })

  console.log('\n[no-pingpong] Б) ново shared evidence СЛЕД noPingA.checked_at -> анализ на X invalidates A')
  await sleep(1100)
  {
    const db = new DatabaseSync(isolated.databaseFile, { open: true })
    db.exec('PRAGMA journal_mode = WAL;')
    db.prepare(`
      INSERT INTO site_visit_events (page_view_id, anonymous_visitor_id, profile_id, path, navigation_type, occurred_at, ip_address)
      VALUES (?, ?, ?, '/lobby', 'navigate', CURRENT_TIMESTAMP, '203.0.113.90')
    `).run(randomUUID(), `visitor-no-pingpong-${runId}`, noPingX.profileId)
    db.close()
  }
  await check('[no-pingpong-B] admin -> POST risk-recheck(noPingX) => ново evidence СЛЕД noPingA.checked_at -> noPingA става check_complete=0', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${noPingX.profileId}/risk-recheck`, 'POST', adminCookie)
    if (r.status !== 200) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
    const db = new DatabaseSync(isolated.databaseFile, { open: true })
    const row = db.prepare(`SELECT check_complete, risk_detected FROM admin_profile_risk_checks WHERE profile_id = ?`).get(noPingA.profileId) as { check_complete: number; risk_detected: number } | undefined
    db.close()
    if (!row || row.check_complete !== 0 || row.risk_detected !== 1) throw new Error(`noPingA row след новото evidence: ${JSON.stringify(row)}`)
  })

  console.log('\n[no-pingpong] В) fetch A -> A получава нов full analysis (check_complete=1); след това A/X поотделно остават стабилни (без ping-pong)')
  let noPingACheckedAtAfterNewEvidence: string | null = null
  await check('[no-pingpong-C] list fetch (A е в резултатите) -> A получава full analysis, check_complete=1', async () => {
    const r = await httpRequest(port, '/api/admin/registered-profiles?period=all&page=1', 'GET', adminCookie)
    const b = r.body as { ok?: boolean; rows?: Array<{ profileId: string; riskCheckComplete?: boolean }> }
    if (r.status !== 200 || b.ok !== true || !Array.isArray(b.rows)) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
    const rowA = b.rows.find((x) => x.profileId === noPingA.profileId)
    if (!rowA || rowA.riskCheckComplete !== true) throw new Error(`noPingA row: ${JSON.stringify(rowA)}`)
    const db = new DatabaseSync(isolated.databaseFile, { open: true })
    const row = db.prepare(`SELECT checked_at FROM admin_profile_risk_checks WHERE profile_id = ?`).get(noPingA.profileId) as { checked_at: string } | undefined
    db.close()
    noPingACheckedAtAfterNewEvidence = row?.checked_at ?? null
  })
  await sleep(1100)
  await check('[no-pingpong-C] fetch X отделно (risk-detail) -> A остава стабилен (checked_at непроменен, БЕЗ нов ping-pong)', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${noPingX.profileId}/risk-detail`, 'GET', adminCookie)
    if (r.status !== 200) throw new Error(`status=${r.status}`)
    const db = new DatabaseSync(isolated.databaseFile, { open: true })
    const row = db.prepare(`SELECT check_complete, checked_at FROM admin_profile_risk_checks WHERE profile_id = ?`).get(noPingA.profileId) as { check_complete: number; checked_at: string } | undefined
    db.close()
    if (!row || row.check_complete !== 1) throw new Error(`noPingA row: ${JSON.stringify(row)}`)
    if (row.checked_at !== noPingACheckedAtAfterNewEvidence) throw new Error(`noPingA.checked_at се промени: преди=${noPingACheckedAtAfterNewEvidence}, сега=${row.checked_at}`)
  })

  // ── (в) bounded storage: точно N redове в admin_profile_risk_checks ─────
  console.log('\n[bounded] admin_profile_risk_checks съдържа очаквания брой redове (не forensic history — 1 ред на профил)')
  await check('[bounded] admin_profile_risk_checks: точно 1 ред за linkedA, точно 1 за linkedB', () => {
    const db = new DatabaseSync(isolated.databaseFile, { open: true })
    const countA = db.prepare(`SELECT COUNT(*) AS c FROM admin_profile_risk_checks WHERE profile_id = ?`).get(linkedA.profileId) as { c: number }
    const countB = db.prepare(`SELECT COUNT(*) AS c FROM admin_profile_risk_checks WHERE profile_id = ?`).get(linkedB.profileId) as { c: number }
    db.close()
    if (countA.c !== 1) throw new Error(`linkedA redове=${countA.c}`)
    if (countB.c !== 1) throw new Error(`linkedB redове=${countB.c}`)
  })

  // ── (г) втори fetch на СЪЩИЯ период НЕ предизвиква recompute ────────────
  // Ползваме cleanTarget тук (не linkedA) — cleanTarget е напълно изолиран
  // (единствен, несподелен visitor id), затова гарантирано НЕ може да бъде
  // indirect-invalidated от верижна reaction на друг сценарий по-горе
  // (напр. linkedA може легитимно да бъде re-invalidated, ако linkedC по-
  // късно открие linkedB, което пък намира linkedA — коректно cache-
  // consistency поведение по round 2 fix-а, не бъг).
  console.log('\n[memoization] повторен admin fetch на същия период -> checked_at НЕ се променя (skip recompute)')
  let firstCheckedAtClean: string | null = null
  {
    const db = new DatabaseSync(isolated.databaseFile, { open: true })
    const row = db.prepare(`SELECT checked_at FROM admin_profile_risk_checks WHERE profile_id = ?`).get(cleanTarget.profileId) as { checked_at: string } | undefined
    db.close()
    firstCheckedAtClean = row?.checked_at ?? null
  }
  await check('[memoization] firstCheckedAtClean е записан', () => {
    if (!firstCheckedAtClean) throw new Error('Липсва checked_at след първия fetch.')
  })
  // Малко изчакване, за да е различим timestamp-ът, ако (грешно) се презапише.
  await sleep(1100)
  await check('[memoization] admin -> втори GET registered-profiles?period=all => 200', async () => {
    const r = await httpRequest(port, '/api/admin/registered-profiles?period=all&page=1', 'GET', adminCookie)
    if (r.status !== 200) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
  })
  await check('[memoization] checked_at за cleanTarget остава непроменен след втория fetch', () => {
    const db = new DatabaseSync(isolated.databaseFile, { open: true })
    const row = db.prepare(`SELECT checked_at FROM admin_profile_risk_checks WHERE profile_id = ?`).get(cleanTarget.profileId) as { checked_at: string } | undefined
    db.close()
    if (row?.checked_at !== firstCheckedAtClean) {
      throw new Error(`checked_at се промени: преди=${firstCheckedAtClean}, сега=${row?.checked_at} (recompute се случи за вече кеширан профил)`)
    }
  })

  // ── risk-detail: detailed breakdown ──────────────────────────────────────
  console.log('\n[detail] GET risk-detail за linkedA връща linkedB с коректни sharedVisitorIdsCount/sharedIpCount')
  await check('[detail] admin -> GET risk-detail(linkedA) => 200, linkedProfiles съдържа linkedB', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${linkedA.profileId}/risk-detail`, 'GET', adminCookie)
    const b = r.body as { ok?: boolean; linkedProfiles?: Array<{ profileId: string; sharedVisitorIdsCount: number; sharedIpCount: number }> }
    if (r.status !== 200 || b.ok !== true || !Array.isArray(b.linkedProfiles)) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
    const entry = b.linkedProfiles.find((x) => x.profileId === linkedB.profileId)
    if (!entry) throw new Error(`linkedB отсъства от linkedProfiles: ${JSON.stringify(b.linkedProfiles)}`)
    if (entry.sharedVisitorIdsCount !== 1) throw new Error(`sharedVisitorIdsCount=${entry.sharedVisitorIdsCount}, очаквах 1`)
    if (entry.sharedIpCount !== 1) throw new Error(`sharedIpCount=${entry.sharedIpCount}, очаквах 1 (203.0.113.30 споделен)`)
  })
  await check('[detail] admin -> GET risk-detail(cleanTarget) => 200, празен linkedProfiles списък', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${cleanTarget.profileId}/risk-detail`, 'GET', adminCookie)
    const b = r.body as { ok?: boolean; linkedProfiles?: unknown[] }
    if (r.status !== 200 || b.ok !== true || !Array.isArray(b.linkedProfiles)) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
    if (b.linkedProfiles.length !== 0) throw new Error(`Очаквах празен списък, получих: ${JSON.stringify(b.linkedProfiles)}`)
  })
  await check('[detail] admin -> GET risk-detail(несъществуващ profileId) => 404', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/does-not-exist-12345/risk-detail`, 'GET', adminCookie)
    if (r.status !== 404) throw new Error(`status=${r.status}`)
  })

  // ── risk-recheck: forced recheck presses fresh checked_at ────────────────
  console.log('\n[recheck] "Провери отново" презаписва checked_at')
  await check('[recheck] admin -> POST risk-recheck(linkedA) => 200, riskDetected:true', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${linkedA.profileId}/risk-recheck`, 'POST', adminCookie)
    const b = r.body as { ok?: boolean; riskDetected?: boolean; linkedProfilesCount?: number }
    if (r.status !== 200 || b.ok !== true) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
    if (b.riskDetected !== true) throw new Error(`riskDetected=${b.riskDetected}`)
  })
  await check('[recheck] checked_at за linkedA се е обновил след recheck', () => {
    const db = new DatabaseSync(isolated.databaseFile, { open: true })
    const row = db.prepare(`SELECT checked_at FROM admin_profile_risk_checks WHERE profile_id = ?`).get(linkedA.profileId) as { checked_at: string } | undefined
    db.close()
    if (row?.checked_at === firstCheckedAtA) throw new Error(`checked_at не се промени след forced recheck: ${row?.checked_at}`)
  })
  await check('[recheck] admin -> POST risk-recheck(несъществуващ profileId) => 404', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/does-not-exist-12345/risk-recheck`, 'POST', adminCookie)
    if (r.status !== 404) throw new Error(`status=${r.status}`)
  })

  // ── HARD DELETE targeted risk-cache invalidation (production bug fix) ───
  // invA е linked с invB (visitor-inv-ab) и invC (visitor-inv-ac). Fully
  // compute invA -> exact count=2. Hard delete invB през реалния admin
  // hard-delete endpoint (СЪЩИЯ profileHardDeleteService.hardDeleteProfile
  // primitive/транзакция, ползван и от deferred pending-delete flow-а в
  // applyPendingModerationForRoomParticipants). Очакваме: invA cache row ->
  // check_complete=0 веднага след delete-а (targeted invalidation, ПРЕДИ
  // какъвто и да е нов list fetch), следващ list fetch за invA ->
  // check_complete=1, exact linked_profiles_count=1 (само invC), detail
  // view съдържа invC, не съдържа invB. invD е напълно несвързан control
  // профил — трябва да остане недокоснат (check_complete=1, checked_at
  // непроменен) — доказва, че invalidation-ът е targeted, не global scan.
  console.log('\n[hard-delete-invalidate] HARD DELETE на linked partner B -> targeted risk cache invalidation за A (НЕ global scan)')
  const invA = await register(port, runId, 'invdela')
  const invB = await register(port, runId, 'invdelb')
  const invC = await register(port, runId, 'invdelc')
  const invD = await register(port, runId, 'invdeld')

  {
    const db = new DatabaseSync(isolated.databaseFile, { open: true })
    db.exec('PRAGMA journal_mode = WAL;')
    const visitorAB = `visitor-inv-ab-${runId}`
    const visitorAC = `visitor-inv-ac-${runId}`
    const visitorDSolo = `visitor-inv-d-solo-${runId}`
    db.prepare(`
      INSERT INTO site_visitors (
        anonymous_visitor_id, first_seen_at, last_seen_at,
        first_profile_id, last_profile_id, first_ip_address, last_ip_address
      ) VALUES (?, '2026-01-02 08:00:00', '2026-01-02 08:00:00', ?, ?, '203.0.113.101', '203.0.113.101')
    `).run(visitorAB, invA.profileId, invB.profileId)
    db.prepare(`
      INSERT INTO site_visit_events (page_view_id, anonymous_visitor_id, profile_id, path, navigation_type, occurred_at, ip_address)
      VALUES (?, ?, ?, '/lobby', 'navigate', '2026-01-02 08:00:00', '203.0.113.101')
    `).run(randomUUID(), visitorAB, invA.profileId)
    db.prepare(`
      INSERT INTO site_visit_events (page_view_id, anonymous_visitor_id, profile_id, path, navigation_type, occurred_at, ip_address)
      VALUES (?, ?, ?, '/lobby', 'navigate', '2026-01-02 08:00:00', '203.0.113.101')
    `).run(randomUUID(), visitorAB, invB.profileId)

    db.prepare(`
      INSERT INTO site_visitors (
        anonymous_visitor_id, first_seen_at, last_seen_at,
        first_profile_id, last_profile_id, first_ip_address, last_ip_address
      ) VALUES (?, '2026-01-02 09:00:00', '2026-01-02 09:00:00', ?, ?, '203.0.113.102', '203.0.113.102')
    `).run(visitorAC, invA.profileId, invC.profileId)
    db.prepare(`
      INSERT INTO site_visit_events (page_view_id, anonymous_visitor_id, profile_id, path, navigation_type, occurred_at, ip_address)
      VALUES (?, ?, ?, '/lobby', 'navigate', '2026-01-02 09:00:00', '203.0.113.102')
    `).run(randomUUID(), visitorAC, invA.profileId)
    db.prepare(`
      INSERT INTO site_visit_events (page_view_id, anonymous_visitor_id, profile_id, path, navigation_type, occurred_at, ip_address)
      VALUES (?, ?, ?, '/lobby', 'navigate', '2026-01-02 09:00:00', '203.0.113.102')
    `).run(randomUUID(), visitorAC, invC.profileId)

    db.prepare(`
      INSERT INTO site_visitors (anonymous_visitor_id, first_seen_at, last_seen_at, first_profile_id, last_profile_id)
      VALUES (?, '2026-01-02 10:00:00', '2026-01-02 10:00:00', ?, ?)
    `).run(visitorDSolo, invD.profileId, invD.profileId)
    db.prepare(`
      INSERT INTO site_visit_events (page_view_id, anonymous_visitor_id, profile_id, path, navigation_type, occurred_at, ip_address)
      VALUES (?, ?, ?, '/lobby', 'navigate', '2026-01-02 10:00:00', '203.0.113.103')
    `).run(randomUUID(), visitorDSolo, invD.profileId)
    db.close()
  }

  await check('[hard-delete-invalidate] admin -> POST risk-recheck(invA) => fully checked, exact linkedProfilesCount=2 (B+C)', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${invA.profileId}/risk-recheck`, 'POST', adminCookie)
    const b = r.body as { ok?: boolean; riskDetected?: boolean; linkedProfilesCount?: number }
    if (r.status !== 200 || b.ok !== true) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
    if (b.riskDetected !== true || b.linkedProfilesCount !== 2) throw new Error(`riskDetected=${b.riskDetected}, linkedProfilesCount=${b.linkedProfilesCount}, очаквах true/2`)
  })
  await check('[hard-delete-invalidate] admin_profile_risk_checks: invA check_complete=1, linked_profiles_count=2 в DB', () => {
    const db = new DatabaseSync(isolated.databaseFile, { open: true })
    const row = db.prepare(`SELECT check_complete, linked_profiles_count FROM admin_profile_risk_checks WHERE profile_id = ?`).get(invA.profileId) as { check_complete: number; linked_profiles_count: number } | undefined
    db.close()
    if (!row || row.check_complete !== 1 || row.linked_profiles_count !== 2) throw new Error(`invA row: ${JSON.stringify(row)}`)
  })

  await check('[hard-delete-invalidate] admin -> POST risk-recheck(invD) => fully checked, clean control (несвързан с A/B/C)', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${invD.profileId}/risk-recheck`, 'POST', adminCookie)
    const b = r.body as { ok?: boolean; riskDetected?: boolean; linkedProfilesCount?: number }
    if (r.status !== 200 || b.ok !== true) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
    if (b.riskDetected !== false || b.linkedProfilesCount !== 0) throw new Error(`riskDetected=${b.riskDetected}, linkedProfilesCount=${b.linkedProfilesCount}, очаквах false/0`)
  })

  let invDCheckedAtBeforeDelete: string | null = null
  {
    const db = new DatabaseSync(isolated.databaseFile, { open: true })
    const row = db.prepare(`SELECT checked_at FROM admin_profile_risk_checks WHERE profile_id = ?`).get(invD.profileId) as { checked_at: string } | undefined
    db.close()
    invDCheckedAtBeforeDelete = row?.checked_at ?? null
  }

  await sleep(1100)
  await check('[hard-delete-invalidate] admin -> DELETE /api/admin/profiles/:invB (реален hard-delete endpoint) => 200, pending:false', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${invB.profileId}`, 'DELETE', adminCookie, { reason: 'risk cache invalidation regression' })
    const b = r.body as { ok?: boolean; pending?: boolean }
    if (r.status !== 200 || b.ok !== true || b.pending !== false) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
  })

  await check('[hard-delete-invalidate] СЛЕД delete: invA cache row -> check_complete=0 (targeted invalidation, преди какъвто и да е нов list fetch)', () => {
    const db = new DatabaseSync(isolated.databaseFile, { open: true })
    const row = db.prepare(`SELECT check_complete FROM admin_profile_risk_checks WHERE profile_id = ?`).get(invA.profileId) as { check_complete: number } | undefined
    db.close()
    if (!row || row.check_complete !== 0) throw new Error(`invA row след delete: ${JSON.stringify(row)}`)
  })

  await check('[hard-delete-invalidate] СЛЕД delete: invD (несвързан control) остава check_complete=1, checked_at непроменен (НЕ global scan)', () => {
    const db = new DatabaseSync(isolated.databaseFile, { open: true })
    const row = db.prepare(`SELECT check_complete, checked_at FROM admin_profile_risk_checks WHERE profile_id = ?`).get(invD.profileId) as { check_complete: number; checked_at: string } | undefined
    db.close()
    if (!row || row.check_complete !== 1) throw new Error(`invD row след delete: ${JSON.stringify(row)}`)
    if (row.checked_at !== invDCheckedAtBeforeDelete) throw new Error(`invD.checked_at се промени: преди=${invDCheckedAtBeforeDelete}, сега=${row.checked_at}`)
  })

  await check('[hard-delete-invalidate] normal list fetch (invA е сред резултатите) -> full recompute -> check_complete=1, exact linkedProfilesCount=1 (само C)', async () => {
    const r = await httpRequest(port, '/api/admin/registered-profiles?period=all&page=1', 'GET', adminCookie)
    const b = r.body as { ok?: boolean; rows?: Array<{ profileId: string; riskDetected?: boolean; linkedProfilesCount?: number; riskCheckComplete?: boolean }> }
    if (r.status !== 200 || b.ok !== true || !Array.isArray(b.rows)) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
    const rowA = b.rows.find((x) => x.profileId === invA.profileId)
    if (!rowA) throw new Error('invA липсва от list резултатите.')
    if (rowA.riskCheckComplete !== true) throw new Error(`invA.riskCheckComplete=${rowA.riskCheckComplete}, очаквах true`)
    if (rowA.linkedProfilesCount !== 1) throw new Error(`invA.linkedProfilesCount=${rowA.linkedProfilesCount}, очаквах точно 1 (само invC, invB е изтрит)`)
  })
  await check('[hard-delete-invalidate] admin_profile_risk_checks: invA вече check_complete=1, linked_profiles_count=1 в DB', () => {
    const db = new DatabaseSync(isolated.databaseFile, { open: true })
    const row = db.prepare(`SELECT check_complete, linked_profiles_count FROM admin_profile_risk_checks WHERE profile_id = ?`).get(invA.profileId) as { check_complete: number; linked_profiles_count: number } | undefined
    db.close()
    if (!row || row.check_complete !== 1 || row.linked_profiles_count !== 1) throw new Error(`invA row: ${JSON.stringify(row)}`)
  })

  await check('[hard-delete-invalidate] GET risk-detail(invA) => linkedProfiles съдържа invC, НЕ съдържа invB (вече hard-deleted)', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${invA.profileId}/risk-detail`, 'GET', adminCookie)
    const b = r.body as { ok?: boolean; linkedProfiles?: Array<{ profileId: string }> }
    if (r.status !== 200 || b.ok !== true || !Array.isArray(b.linkedProfiles)) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
    const hasC = b.linkedProfiles.some((x) => x.profileId === invC.profileId)
    const hasB = b.linkedProfiles.some((x) => x.profileId === invB.profileId)
    if (!hasC) throw new Error(`invC отсъства от linkedProfiles: ${JSON.stringify(b.linkedProfiles)}`)
    if (hasB) throw new Error(`invB (hard-deleted) все още присъства в linkedProfiles: ${JSON.stringify(b.linkedProfiles)}`)
  })

  console.log(`\n═══ Резултат: ${passed} passed, ${failed} failed ═══\n`)
} finally {
  if (server) await stopServer(server)
  await isolated.cleanup()
}

if (failed > 0) {
  process.exitCode = 1
}
