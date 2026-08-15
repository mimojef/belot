/**
 * checkAdminVipGrantHttpAuthorization.ts
 *
 * E2E тест на "Дай VIP" admin endpoint-а: POST /api/admin/profiles/:id/vip-grant.
 * Спъва изолирано копие на реалния сървър (собствена temp SQLite база, реални
 * migrations, реален HTTP слой) — огледално на checkSubadminHttpAuthorization.ts,
 * за да покрие ТОЧНО ролевата authorization + VIP business logic + audit trail
 * на новия endpoint, а не да разчита само на frontend-скрит бутон.
 *
 * Покрива (номерация съответства на task brief-а):
 *  [2]  subadmin не вижда/използва endpoint-а (403)
 *  [3]  pika_team/top_chat_admin/chat_admin/player/guest също 403/401
 *  [5]  admin grant 15 на профил БЕЗ VIP → active VIP + ~15 дни от сега
 *  [6]  admin grant 15 на профил С активен VIP → удължава (base=max(now,currentActiveUntil))
 *  [7]  0, отрицателно, decimal, нечислова стойност → 400 (server-side, не само UI)
 *  [8]  server endpoint reject-ва non-admin директен request (дори с валиден JSON body)
 *  [11] grant history/audit: vip_grants.granted_by_profile_id + resulting_active_until
 *  [edge] self-grant => 400; несъществуващ target => 404
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const PASSWORD = 'VipGrantSmoke1!'
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
  const root = await mkdtemp(join(tmpdir(), 'belot-vip-grant-smoke-'))
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

function setActiveUntilDirectly(databaseFile: string, profileId: string, isoDate: string): void {
  const db = new DatabaseSync(databaseFile)
  db.exec('PRAGMA journal_mode = WAL;')
  db.prepare(`
    INSERT INTO vip_status (profile_id, active_until)
    VALUES (?, ?)
    ON CONFLICT(profile_id) DO UPDATE SET active_until = excluded.active_until;
  `).run(profileId, isoDate)
  db.close()
}

type RegisteredUser = { cookie: string; profileId: string; accountId: string; email: string }

async function register(port: number, runId: string, suffix: string): Promise<RegisteredUser> {
  const email = `vip-grant-smoke-${runId}-${suffix}@example.test`
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, displayName: `Smoke ${suffix}`, gender: 'male' }),
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
  }
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
  const rawCookie = headersExt.getSetCookie?.()[0] ?? res.headers.get('set-cookie')
  if (!rawCookie) throw new Error(`Липсва Set-Cookie при login за ${email}.`)
  return rawCookie.split(';')[0]!
}

const sourceServerRoot = resolve(
  process.argv.slice(2).find((a) => a.startsWith('--server-root='))?.slice('--server-root='.length) ?? process.cwd(),
)

console.log('\n═══ Admin VIP grant HTTP authorization E2E test ═══')
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
  const target = await register(port, runId, 'target')
  const targetWithVip = await register(port, runId, 'targetvip')
  const adminCandidate = await register(port, runId, 'admin')
  const subadminCandidate = await register(port, runId, 'subadmin')
  const pikaTeamCandidate = await register(port, runId, 'pikateam')
  const topChatAdminCandidate = await register(port, runId, 'topchatadmin')
  const chatAdminCandidate = await register(port, runId, 'chatadmin')

  promoteRole(isolated.databaseFile, adminCandidate.email, 'admin')
  promoteRole(isolated.databaseFile, subadminCandidate.email, 'subadmin')
  promoteRole(isolated.databaseFile, pikaTeamCandidate.email, 'pika_team')
  promoteRole(isolated.databaseFile, topChatAdminCandidate.email, 'top_chat_admin')
  promoteRole(isolated.databaseFile, chatAdminCandidate.email, 'chat_admin')

  const adminCookie = await login(port, adminCandidate.email)
  const subadminCookie = await login(port, subadminCandidate.email)
  const pikaTeamCookie = await login(port, pikaTeamCandidate.email)
  const topChatAdminCookie = await login(port, topChatAdminCandidate.email)
  const chatAdminCookie = await login(port, chatAdminCandidate.email)

  console.log('  Регистрирани: player, target, target-vip, admin, subadmin, pika_team, top_chat_admin, chat_admin.')

  // ── [2][3] Всички НЕ-admin роли + guest => 403/401 ──────────────────────
  console.log('\n[2][3] Само role===admin минава — всички други роли 403, guest 401')
  const NON_ADMIN_SESSIONS: Array<{ label: string; cookie: string }> = [
    { label: 'player', cookie: player.cookie },
    { label: 'subadmin', cookie: subadminCookie },
    { label: 'pika_team', cookie: pikaTeamCookie },
    { label: 'top_chat_admin', cookie: topChatAdminCookie },
    { label: 'chat_admin', cookie: chatAdminCookie },
  ]
  for (const { label, cookie } of NON_ADMIN_SESSIONS) {
    await check(`[2/3] ${label} -> POST vip-grant => 403`, async () => {
      const r = await httpRequest(port, `/api/admin/profiles/${target.profileId}/vip-grant`, 'POST', cookie, { days: 15 })
      if (r.status !== 403) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
    })
  }
  await check('[8] guest (без cookie) -> POST vip-grant => 403 (няма fresh admin session)', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${target.profileId}/vip-grant`, 'POST', undefined, { days: 15 })
    if (r.status !== 403) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
  })

  // ── [5] admin grant 15 на профил БЕЗ VIP ────────────────────────────────
  console.log('\n[5] admin grant 15 на профил без VIP')
  await check('[5] POST vip-grant {days:15} => 200, activeUntil ≈ now+15 дни', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${target.profileId}/vip-grant`, 'POST', adminCookie, { days: 15 })
    const b = r.body as { ok?: boolean; profile?: { isVip?: boolean | null; vipActiveUntil?: string | null } }
    if (r.status !== 200 || b.ok !== true || !b.profile) {
      throw new Error(`status=${r.status}, body=${JSON.stringify(b)}`)
    }
    if (b.profile.isVip !== true) throw new Error(`profile.isVip трябва да е true, получих ${b.profile.isVip}`)
    const daysUntil = (new Date(b.profile.vipActiveUntil!).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
    if (!(daysUntil > 14.9 && daysUntil < 15.1)) throw new Error(`очаквах ~15 дни, получих ${daysUntil}`)
  })

  // ── [6] admin grant 15 на профил С активен VIP → удължава ───────────────
  console.log('\n[6] admin grant 15 на профил с активен VIP (20 оставащи) → удължава до ~35')
  const future20 = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19)
  setActiveUntilDirectly(isolated.databaseFile, targetWithVip.profileId, future20)
  await check('[6] POST vip-grant {days:15} върху 20-дневен активен VIP => ~35 дни (extension, не презапис)', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${targetWithVip.profileId}/vip-grant`, 'POST', adminCookie, { days: 15 })
    const b = r.body as { ok?: boolean; profile?: { vipActiveUntil?: string | null } }
    if (r.status !== 200 || b.ok !== true || !b.profile) throw new Error(`status=${r.status}, body=${JSON.stringify(b)}`)
    const daysUntil = (new Date(b.profile.vipActiveUntil!).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
    if (!(daysUntil > 34.5 && daysUntil < 35.5)) throw new Error(`очаквах ~35 дни (20 оставащи + 15 нови), получих ${daysUntil}`)
  })

  // ── [7] Невалиден days => 400 (server-side, не само UI) ──────────────────
  console.log('\n[7] Невалидни стойности за days => 400')
  const INVALID_DAYS: Array<{ label: string; days: unknown }> = [
    { label: '0', days: 0 },
    { label: 'отрицателно (-5)', days: -5 },
    { label: 'decimal (2.5)', days: 2.5 },
    { label: 'нечислов текст ("abc")', days: 'abc' },
    { label: 'липсващо поле', days: undefined },
  ]
  for (const { label, days } of INVALID_DAYS) {
    await check(`[7] admin -> POST vip-grant {days: ${label}} => 400`, async () => {
      const body = days === undefined ? {} : { days }
      const r = await httpRequest(port, `/api/admin/profiles/${target.profileId}/vip-grant`, 'POST', adminCookie, body)
      if (r.status !== 400) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
    })
  }

  // ── [edge] self-grant и несъществуващ target ─────────────────────────────
  console.log('\n[edge] self-grant => 400; несъществуващ target => 404')
  await check('[edge] admin -> POST vip-grant на СЕБЕ СИ => 400', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${adminCandidate.profileId}/vip-grant`, 'POST', adminCookie, { days: 5 })
    if (r.status !== 400) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
  })
  await check('[edge] admin -> POST vip-grant на несъществуващ profileId => 404', async () => {
    const r = await httpRequest(port, '/api/admin/profiles/does-not-exist-12345/vip-grant', 'POST', adminCookie, { days: 5 })
    if (r.status !== 404) throw new Error(`status=${r.status}`)
  })

  // ── [11] Audit trail: granted_by_profile_id + resulting_active_until ────
  console.log('\n[11] vip_grants audit trail: granted_by_profile_id + resulting_active_until')
  const auditDb = new DatabaseSync(isolated.databaseFile, { open: true })
  const auditRows = auditDb.prepare(`
    SELECT profile_id, reason, interval_unit, interval_amount, granted_by_profile_id, resulting_active_until
    FROM vip_grants
    WHERE profile_id = ? AND reason = 'admin_grant'
    ORDER BY granted_at ASC
  `).all(target.profileId) as Array<{
    profile_id: string
    reason: string
    interval_unit: string
    interval_amount: number
    granted_by_profile_id: string | null
    resulting_active_until: string | null
  }>
  auditDb.close()

  await check('[11.1] точно 1 admin_grant ред за target (само успешният [5] grant, невалидните [7] не записаха нищо)', () => {
    if (auditRows.length !== 1) throw new Error(`Брой редове=${auditRows.length}: ${JSON.stringify(auditRows)}`)
  })
  await check('[11.2] granted_by_profile_id = admin-a, извършил grant-а', () => {
    const row = auditRows[0]
    if (!row || row.granted_by_profile_id !== adminCandidate.profileId) {
      throw new Error(`granted_by_profile_id=${row?.granted_by_profile_id}, очаквах ${adminCandidate.profileId}`)
    }
  })
  await check('[11.3] interval_unit=days, interval_amount=15 (точно както е подадено)', () => {
    const row = auditRows[0]
    if (!row || row.interval_unit !== 'days' || row.interval_amount !== 15) {
      throw new Error(`unit=${row?.interval_unit}, amount=${row?.interval_amount}`)
    }
  })
  await check('[11.4] resulting_active_until е записан и съвпада с ~15 дни от grant момента', () => {
    const row = auditRows[0]
    if (!row?.resulting_active_until) throw new Error('resulting_active_until липсва')
    const daysUntil = (new Date(row.resulting_active_until.replace(' ', 'T') + 'Z').getTime() - Date.now()) / (1000 * 60 * 60 * 24)
    if (!(daysUntil > 14.5 && daysUntil < 15.5)) throw new Error(`resulting_active_until implies ~${daysUntil} дни, очаквах ~15`)
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
