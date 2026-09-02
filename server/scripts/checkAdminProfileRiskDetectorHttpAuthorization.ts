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

  console.log('  Регистрирани: player, linkedA, linkedB (споделят visitor id), clean (без risk), admin, subadmin.')

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

  // ── (б) admin отваря list view -> risk_detected=1 за ДВАТА linked профила ──
  console.log('\n[risk-flow] admin -> GET registered-profiles?period=all => batch compute -> linkedA И linkedB стават risk_detected=1')
  let firstCheckedAtA: string | null = null
  await check('[risk-flow] admin -> registered-profiles?period=all => 200, linkedA.riskDetected=true, linkedProfilesCount>=1', async () => {
    const r = await httpRequest(port, '/api/admin/registered-profiles?period=all&page=1', 'GET', adminCookie)
    const b = r.body as { ok?: boolean; rows?: Array<{ profileId: string; riskDetected?: boolean; linkedProfilesCount?: number }> }
    if (r.status !== 200 || b.ok !== true || !Array.isArray(b.rows)) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
    const rowA = b.rows.find((x) => x.profileId === linkedA.profileId)
    if (!rowA || rowA.riskDetected !== true) throw new Error(`linkedA row: ${JSON.stringify(rowA)}`)
    if (!rowA.linkedProfilesCount || rowA.linkedProfilesCount < 1) throw new Error(`linkedA.linkedProfilesCount=${rowA.linkedProfilesCount}`)
    const rowClean = b.rows.find((x) => x.profileId === cleanTarget.profileId)
    if (!rowClean || rowClean.riskDetected !== false) throw new Error(`cleanTarget row (очаквах riskDetected:false): ${JSON.stringify(rowClean)}`)
  })

  await check('[risk-flow] linkedB (НЕ директно fetched от list view-а, но е linked partner) също е risk_detected=1 (spec §6 upsert логика)', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${linkedB.profileId}/risk-detail`, 'GET', adminCookie)
    if (r.status !== 200) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
    // Ако linkedB не беше upsert-нат като risk_detected=1 автоматично, той
    // пак ще си има detail данни (risk-detail работи fresh за всеки target),
    // затова проверяваме директно cache таблицата за linkedB risk_detected.
    const db = new DatabaseSync(isolated.databaseFile, { open: true })
    const row = db.prepare(`SELECT risk_detected FROM admin_profile_risk_checks WHERE profile_id = ?`).get(linkedB.profileId) as { risk_detected: number } | undefined
    db.close()
    if (!row || row.risk_detected !== 1) throw new Error(`linkedB admin_profile_risk_checks row: ${JSON.stringify(row)}`)
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
  console.log('\n[memoization] повторен admin fetch на същия период -> checked_at НЕ се променя (skip recompute)')
  {
    const db = new DatabaseSync(isolated.databaseFile, { open: true })
    const row = db.prepare(`SELECT checked_at FROM admin_profile_risk_checks WHERE profile_id = ?`).get(linkedA.profileId) as { checked_at: string } | undefined
    db.close()
    firstCheckedAtA = row?.checked_at ?? null
  }
  await check('[memoization] firstCheckedAtA е записан', () => {
    if (!firstCheckedAtA) throw new Error('Липсва checked_at след първия fetch.')
  })
  // Малко изчакване, за да е различим timestamp-ът, ако (грешно) се презапише.
  await sleep(1100)
  await check('[memoization] admin -> втори GET registered-profiles?period=all => 200', async () => {
    const r = await httpRequest(port, '/api/admin/registered-profiles?period=all&page=1', 'GET', adminCookie)
    if (r.status !== 200) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
  })
  await check('[memoization] checked_at за linkedA остава непроменен след втория fetch', () => {
    const db = new DatabaseSync(isolated.databaseFile, { open: true })
    const row = db.prepare(`SELECT checked_at FROM admin_profile_risk_checks WHERE profile_id = ?`).get(linkedA.profileId) as { checked_at: string } | undefined
    db.close()
    if (row?.checked_at !== firstCheckedAtA) {
      throw new Error(`checked_at се промени: преди=${firstCheckedAtA}, сега=${row?.checked_at} (recompute се случи за вече кеширан профил)`)
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

  console.log(`\n═══ Резултат: ${passed} passed, ${failed} failed ═══\n`)
} finally {
  if (server) await stopServer(server)
  await isolated.cleanup()
}

if (failed > 0) {
  process.exitCode = 1
}
