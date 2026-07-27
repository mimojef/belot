/**
 * checkSubadminHttpAuthorization.ts
 *
 * Пълен E2E smoke тест на субадмин ролята: спъва изолирано копие на реалния
 * сървър (собствена temp SQLite база, реални migrations, реален HTTP слой),
 * регистрира реални акаунти през /api/auth/register, промотира до admin
 * директно в SQLite (единственият начин да се стартира без предварителен
 * admin), после изпълнява реални HTTP заявки и проверява отговорите.
 *
 * Покрива (номерация съответства на изискания test plan):
 *  [2]  player няма административен достъп никъде.
 *  [3]  subadmin отваря "Информация"/"Сървър" endpoints (200).
 *  [5]  subadmin няма достъп до "Настройки" API-та.
 *  [6]  subadmin не редактира/модерира профили.
 *  [7]  subadmin не чете чат с поддръжката.
 *  [8]  subadmin не назначава/премахва субадмини (дори себе си или друг).
 *  [9]  subadmin не използва write endpoints в "Информация"/"Сървър" —
 *       (тези екрани нямат write endpoints изобщо; тества се негативно:
 *       единствените POST/DELETE в целия "admin" namespace извън
 *       Информация/Сървър остават admin-only, виж [5]/[6]/[8]).
 *  [10] admin запазва всички права (settings, profile edit, support, roles).
 *  [15] не може да се промени собствената админ роля.
 *  [16] не може друг пълен admin да бъде grant/revoke-нат.
 *  [17] промяната на правата се прилага ВЕДНАГА, без re-login (стар cookie).
 *  [18] audit log записва коректен actor/target/action/previous/new role.
 *  [19] regression: съществуващите admin endpoints работят за admin.
 *  [20] integrity_check/foreign_key_check вече покрити в
 *       checkAccountsRoleMigration.ts — тук само health check.
 *
 * Frontend-специфичните точки (11-14: бадж видимост, попъп, confirm modal)
 * се покриват отделно в checkSubadminProfilePopupRendering.ts (реално
 * извикване на renderPlayerProfilePopup) — HTTP слоят тук не рендира UI.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const PASSWORD = 'SubadminSmoke1!'
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
  const root = await mkdtemp(join(tmpdir(), 'belot-subadmin-smoke-'))
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

function promoteToAdmin(databaseFile: string, email: string): void {
  const db = new DatabaseSync(databaseFile)
  db.exec('PRAGMA journal_mode = WAL;')
  db.prepare(`UPDATE accounts SET role = 'admin', updated_at = CURRENT_TIMESTAMP WHERE email = ?`).run(email)
  db.close()
}

type RegisteredUser = { cookie: string; profileId: string; accountId: string; email: string }

async function register(port: number, runId: string, suffix: string): Promise<RegisteredUser> {
  const email = `subadmin-smoke-${runId}-${suffix}@example.test`
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

console.log('\n═══ Subadmin HTTP authorization E2E test ═══')
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

  console.log('\n[setup] Регистрация на потребители...')
  const player = await register(port, runId, 'player')
  const target = await register(port, runId, 'target')
  const adminCandidate = await register(port, runId, 'admin1')
  const admin2Candidate = await register(port, runId, 'admin2')

  promoteToAdmin(isolated.databaseFile, adminCandidate.email)
  promoteToAdmin(isolated.databaseFile, admin2Candidate.email)
  const adminCookie = await login(port, adminCandidate.email)
  const admin2Cookie = await login(port, admin2Candidate.email)
  // profileId/accountId на admin1/admin2 остават същите като при register — ролята
  // е account-level UPDATE, не подменя профила.

  console.log('  Регистрирани: player, target (бъдещ subadmin), admin1, admin2.')

  // ── [2] player няма административен достъп ────────────────────────────
  console.log('\n[2] player няма административен достъп')
  const playerCookie = player.cookie
  const READ_ONLY_ADMIN_ENDPOINTS = [
    '/api/admin/stats',
    '/api/admin/monitoring/current',
    '/api/admin/monitoring/connections',
    '/api/admin/monitoring/history?window=1h',
    '/api/admin/visitors',
    '/api/admin/visitor-sources',
    '/api/admin/payments?period=allTime',
  ]
  const ADMIN_ONLY_ENDPOINTS = [
    '/api/admin/settings',
    '/api/admin/coin-packages',
    '/api/admin/missions',
    '/api/admin/daily-rewards',
    '/api/admin/rooms',
    '/api/admin/guest-contact/messages',
    '/api/support/admin/conversations',
  ]

  for (const path of [...READ_ONLY_ADMIN_ENDPOINTS, ...ADMIN_ONLY_ENDPOINTS]) {
    await check(`[2] player -> GET ${path} => 403`, async () => {
      const r = await httpRequest(port, path, 'GET', playerCookie)
      if (r.status !== 403) throw new Error(`status=${r.status}`)
    })
  }
  await check('[2] player -> GET subadmin role endpoint => 403', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${target.profileId}/subadmin`, 'GET', playerCookie)
    if (r.status !== 403) throw new Error(`status=${r.status}`)
  })
  await check('[2] player -> POST grant subadmin => 403', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${target.profileId}/subadmin`, 'POST', playerCookie)
    if (r.status !== 403) throw new Error(`status=${r.status}`)
  })
  await check('[2] player -> PATCH profile display-name (moderation) => 403', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${target.profileId}/display-name`, 'PATCH', playerCookie, { displayName: 'Hacked' })
    if (r.status !== 403) throw new Error(`status=${r.status}`)
  })

  // ── [10]/[19] admin запазва всички права (baseline преди grant) ────────
  console.log('\n[10][19] admin baseline — всички endpoints работят')
  for (const path of READ_ONLY_ADMIN_ENDPOINTS) {
    await check(`[10] admin1 -> GET ${path} => 200`, async () => {
      const r = await httpRequest(port, path, 'GET', adminCookie)
      if (r.status !== 200) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
    })
  }
  await check('[10] admin1 -> GET /api/admin/settings => 200', async () => {
    const r = await httpRequest(port, '/api/admin/settings', 'GET', adminCookie)
    if (r.status !== 200) throw new Error(`status=${r.status}`)
  })
  await check('[10] admin1 -> GET /api/admin/coin-packages => 200', async () => {
    const r = await httpRequest(port, '/api/admin/coin-packages', 'GET', adminCookie)
    if (r.status !== 200) throw new Error(`status=${r.status}`)
  })
  await check('[10] admin1 -> GET /api/support/admin/conversations => 200', async () => {
    const r = await httpRequest(port, '/api/support/admin/conversations', 'GET', adminCookie)
    if (r.status !== 200) throw new Error(`status=${r.status}`)
  })

  // ── [15] admin не може да смени собствената си роля ────────────────────
  console.log('\n[15] admin не може да смени собствената си роля')
  await check('[15.1] admin1 -> POST grant себе си => 400', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${adminCandidate.profileId}/subadmin`, 'POST', adminCookie)
    if (r.status !== 400) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
  })
  await check('[15.2] admin1 -> DELETE revoke себе си => 400', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${adminCandidate.profileId}/subadmin`, 'DELETE', adminCookie)
    if (r.status !== 400) throw new Error(`status=${r.status}`)
  })

  // ── [16] не може друг пълен admin да бъде grant/revoke-нат ─────────────
  console.log('\n[16] admin1 не може да промени ролята на admin2')
  await check('[16.1] admin1 -> POST grant admin2 => 409 target_is_admin', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${admin2Candidate.profileId}/subadmin`, 'POST', adminCookie)
    if (r.status !== 409) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
  })
  await check('[16.2] admin1 -> DELETE revoke admin2 => 409 target_is_admin', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${admin2Candidate.profileId}/subadmin`, 'DELETE', adminCookie)
    if (r.status !== 409) throw new Error(`status=${r.status}`)
  })
  await check('[16.3] admin2 остава admin (не е понижен) — GET /api/admin/settings все още 200', async () => {
    const r = await httpRequest(port, '/api/admin/settings', 'GET', admin2Cookie)
    if (r.status !== 200) throw new Error(`status=${r.status}`)
  })

  // ── Несъществуващ профил ──────────────────────────────────────────────
  await check('[edge] grant за несъществуващ profileId => 404', async () => {
    const r = await httpRequest(port, '/api/admin/profiles/does-not-exist-12345/subadmin', 'POST', adminCookie)
    if (r.status !== 404) throw new Error(`status=${r.status}`)
  })

  // ── Профил без акаунт (бот) — no_account ────────────────────────────────
  console.log('\n[edge] grant за бот профил (account_id = NULL) => 400 no_account')
  const botDb = new DatabaseSync(isolated.databaseFile, { open: true })
  const botRow = botDb.prepare(`SELECT profile_id FROM profiles WHERE profile_kind = 'bot' LIMIT 1`).get() as { profile_id: string } | undefined
  botDb.close()
  if (botRow) {
    await check('[edge] grant за бот профил => 400 no_account', async () => {
      const r = await httpRequest(port, `/api/admin/profiles/${botRow.profile_id}/subadmin`, 'POST', adminCookie)
      if (r.status !== 400) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
    })
  } else {
    console.log('  (пропуснато — няма seed-нати ботове в тази изолирана база)')
  }

  // ── [17] GET роля на target ПРЕДИ grant => 'player' ─────────────────────
  await check('[baseline] GET роля на target преди grant => player', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${target.profileId}/subadmin`, 'GET', adminCookie)
    const b = r.body as { ok?: boolean; role?: string }
    if (r.status !== 200 || b.role !== 'player') throw new Error(`status=${r.status}, role=${b.role}`)
  })

  // ── [8] target (все още player) НЕ може да управлява роли ───────────────
  console.log('\n[8] player (target преди grant) не може да управлява роли')
  await check('[8] target -> POST grant на друг => 403 (все още обикновен player)', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${player.profileId}/subadmin`, 'POST', target.cookie)
    if (r.status !== 403) throw new Error(`status=${r.status}`)
  })

  // ── GRANT: admin1 прави target субадмин ─────────────────────────────────
  console.log('\n[grant] admin1 прави target субадмин')
  await check('[grant.1] POST grant => 200 ok:true role:subadmin', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${target.profileId}/subadmin`, 'POST', adminCookie)
    const b = r.body as { ok?: boolean; role?: string }
    if (r.status !== 200 || b.ok !== true || b.role !== 'subadmin') {
      throw new Error(`status=${r.status}, body=${JSON.stringify(b)}`)
    }
  })

  // ── Идемпотентност: повторен grant ──────────────────────────────────────
  await check('[grant.2] повторен POST grant (идемпотентно) => 200 ok:true role:subadmin', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${target.profileId}/subadmin`, 'POST', adminCookie)
    const b = r.body as { ok?: boolean; role?: string }
    if (r.status !== 200 || b.ok !== true || b.role !== 'subadmin') {
      throw new Error(`status=${r.status}, body=${JSON.stringify(b)}`)
    }
  })

  // ── [17] Веднага важи, БЕЗ re-login — старият target.cookie е от ПРЕДИ grant ──
  console.log('\n[17] Правата важат веднага, без re-login (стар cookie)')
  await check('[17.1] target (стар cookie отпреди grant) -> GET /api/admin/stats => 200 СЕГА', async () => {
    const r = await httpRequest(port, '/api/admin/stats', 'GET', target.cookie)
    if (r.status !== 200) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
  })
  await check('[17.1b] target (същия cookie) -> GET /api/auth/me веднага показва role=subadmin (основата на M1 frontend polling-а)', async () => {
    const r = await httpRequest(port, '/api/auth/me', 'GET', target.cookie)
    const b = r.body as { ok?: boolean; session?: { account?: { role?: string } } | null }
    if (r.status !== 200 || b.session?.account?.role !== 'subadmin') {
      throw new Error(`status=${r.status}, role=${b.session?.account?.role}`)
    }
  })

  // ── [3] subadmin вижда Информация + Сървър (read-only) ──────────────────
  console.log('\n[3] subadmin (target) вижда всички read-only "Информация"/"Сървър" endpoints')
  for (const path of READ_ONLY_ADMIN_ENDPOINTS) {
    await check(`[3] subadmin -> GET ${path} => 200`, async () => {
      const r = await httpRequest(port, path, 'GET', target.cookie)
      if (r.status !== 200) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
    })
  }

  // ── [5] subadmin няма достъп до "Настройки" ─────────────────────────────
  console.log('\n[5] subadmin няма достъп до "Настройки" API-та')
  for (const path of ADMIN_ONLY_ENDPOINTS) {
    await check(`[5] subadmin -> GET ${path} => 403`, async () => {
      const r = await httpRequest(port, path, 'GET', target.cookie)
      if (r.status !== 403) throw new Error(`status=${r.status}`)
    })
  }

  // ── [6] subadmin не редактира/модерира профили ──────────────────────────
  console.log('\n[6] subadmin не редактира/модерира профили')
  await check('[6] subadmin -> PATCH display-name на друг профил => 403', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${player.profileId}/display-name`, 'PATCH', target.cookie, { displayName: 'Hacked' })
    if (r.status !== 403) throw new Error(`status=${r.status}`)
  })

  // ── [7] subadmin не чете чат с поддръжката ───────────────────────────────
  console.log('\n[7] subadmin не чете чат с поддръжката')
  await check('[7.1] subadmin -> GET /api/support/admin/conversations => 403', async () => {
    const r = await httpRequest(port, '/api/support/admin/conversations', 'GET', target.cookie)
    if (r.status !== 403) throw new Error(`status=${r.status}`)
  })
  await check('[7.2] subadmin -> GET /api/support/admin/messages/:id => 403', async () => {
    const r = await httpRequest(port, `/api/support/admin/messages/${player.profileId}`, 'GET', target.cookie)
    if (r.status !== 403) throw new Error(`status=${r.status}`)
  })
  await check('[7.3] subadmin -> POST /api/support/admin/reply => 403', async () => {
    const r = await httpRequest(port, '/api/support/admin/reply', 'POST', target.cookie, { profileId: player.profileId, body: 'hi' })
    if (r.status !== 403) throw new Error(`status=${r.status}`)
  })

  // ── [8] subadmin не назначава/премахва субадмини ────────────────────────
  console.log('\n[8] subadmin не назначава/премахва субадмини')
  await check('[8.1] subadmin -> POST grant на друг потребител => 403', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${player.profileId}/subadmin`, 'POST', target.cookie)
    if (r.status !== 403) throw new Error(`status=${r.status}`)
  })
  await check('[8.2] subadmin -> DELETE revoke на себе си => 403', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${target.profileId}/subadmin`, 'DELETE', target.cookie)
    if (r.status !== 403) throw new Error(`status=${r.status}`)
  })
  await check('[8.3] subadmin -> GET роля на друг профил => 403 (дори read-only на тази функция)', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${player.profileId}/subadmin`, 'GET', target.cookie)
    if (r.status !== 403) throw new Error(`status=${r.status}`)
  })

  // ── [9] subadmin няма write endpoints в Информация/Сървър (няма такива изобщо) ──
  console.log('\n[9] "Информация"/"Сървър" нямат write endpoints — само GET методи съществуват')
  await check('[9.1] POST към /api/admin/stats => 405 (не съществува POST)', async () => {
    const r = await httpRequest(port, '/api/admin/stats', 'POST', adminCookie)
    if (r.status !== 405) throw new Error(`status=${r.status}`)
  })
  await check('[9.2] POST към /api/admin/monitoring/current => 403 (subadmin+admin четат само GET, POST не е whitelisted и се третира като заявка без валиден route match за POST->guard)', async () => {
    // handleAdminMonitoringCurrentRequest проверява ролята ПРЕДИ метода, но après
    // това проверява req.method !== 'GET' => 405. За admin cookie очакваме 405.
    const r = await httpRequest(port, '/api/admin/monitoring/current', 'POST', adminCookie)
    if (r.status !== 405) throw new Error(`status=${r.status}`)
  })

  // ── REVOKE: admin1 маха субадмин от target ──────────────────────────────
  console.log('\n[revoke] admin1 маха субадмин роля от target')
  await check('[revoke.1] DELETE revoke => 200 ok:true role:player', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${target.profileId}/subadmin`, 'DELETE', adminCookie)
    const b = r.body as { ok?: boolean; role?: string }
    if (r.status !== 200 || b.ok !== true || b.role !== 'player') {
      throw new Error(`status=${r.status}, body=${JSON.stringify(b)}`)
    }
  })

  // Идемпотентност на revoke
  await check('[revoke.2] повторен DELETE (идемпотентно) => 200 ok:true role:player', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${target.profileId}/subadmin`, 'DELETE', adminCookie)
    const b = r.body as { ok?: boolean; role?: string }
    if (r.status !== 200 || b.ok !== true || b.role !== 'player') {
      throw new Error(`status=${r.status}, body=${JSON.stringify(b)}`)
    }
  })

  // ── [17] Веднага след revoke — старият target.cookie губи достъп ────────
  console.log('\n[17] Отнемането важи веднага (същия стар target cookie)')
  await check('[17.2] target (същия cookie) -> GET /api/admin/stats => 403 СЕГА', async () => {
    const r = await httpRequest(port, '/api/admin/stats', 'GET', target.cookie)
    if (r.status !== 403) throw new Error(`status=${r.status}`)
  })
  await check('[17.2b] target (същия cookie) -> GET /api/auth/me веднага показва role=player (M1 polling ще засече това при следващ tick)', async () => {
    const r = await httpRequest(port, '/api/auth/me', 'GET', target.cookie)
    const b = r.body as { ok?: boolean; session?: { account?: { role?: string } } | null }
    if (r.status !== 200 || b.session?.account?.role !== 'player') {
      throw new Error(`status=${r.status}, role=${b.session?.account?.role}`)
    }
  })

  // ── [12] обикновен потребител/subadmin не вижда чужд subadmin статус ────
  console.log('\n[12] player не може да чете чужда роля дори за самия себе си')
  await check('[12] player -> GET собствената си роля => 403 (само пълен admin вижда/чете роля)', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${player.profileId}/subadmin`, 'GET', playerCookie)
    if (r.status !== 403) throw new Error(`status=${r.status}`)
  })

  // ── [18] Audit log съдържание ────────────────────────────────────────────
  console.log('\n[18] audit log записва коректен actor/target/action')
  const auditDb = new DatabaseSync(isolated.databaseFile, { open: true })
  const auditRows = auditDb.prepare(`
    SELECT actor_account_id, target_account_id, action, previous_role, new_role
    FROM admin_role_audit_log
    WHERE target_account_id = ?
    ORDER BY created_at ASC
  `).all(target.accountId) as { actor_account_id: string; target_account_id: string; action: string; previous_role: string; new_role: string }[]
  auditDb.close()

  await check('[18.1] точно 2 audit реда за target (grant + revoke, идемпотентните повторения НЕ добавят нови)', async () => {
    if (auditRows.length !== 2) throw new Error(`Брой редове=${auditRows.length}: ${JSON.stringify(auditRows)}`)
  })
  await check('[18.2] първи ред: grant_subadmin, player->subadmin, actor=admin1', async () => {
    const r = auditRows[0]
    if (!r || r.action !== 'grant_subadmin' || r.previous_role !== 'player' || r.new_role !== 'subadmin' || r.actor_account_id !== adminCandidate.accountId) {
      throw new Error(JSON.stringify(r))
    }
  })
  await check('[18.3] втори ред: revoke_subadmin, subadmin->player, actor=admin1', async () => {
    const r = auditRows[1]
    if (!r || r.action !== 'revoke_subadmin' || r.previous_role !== 'subadmin' || r.new_role !== 'player' || r.actor_account_id !== adminCandidate.accountId) {
      throw new Error(JSON.stringify(r))
    }
  })

  // ── [19] Regression: admin1 запазва всички права СЛЕД целия сценарий ────
  console.log('\n[19] regression — admin1 запазва всички права след целия сценарий')
  await check('[19.1] admin1 -> GET /api/admin/settings => 200', async () => {
    const r = await httpRequest(port, '/api/admin/settings', 'GET', adminCookie)
    if (r.status !== 200) throw new Error(`status=${r.status}`)
  })
  await check('[19.2] admin1 -> GET /api/admin/stats => 200', async () => {
    const r = await httpRequest(port, '/api/admin/stats', 'GET', adminCookie)
    if (r.status !== 200) throw new Error(`status=${r.status}`)
  })
  await check('[19.3] admin1 -> PATCH profile display-name (moderation) => не е 403', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${player.profileId}/display-name`, 'PATCH', adminCookie, { displayName: `Renamed${Date.now()}` })
    if (r.status === 403) throw new Error(`status=${r.status} (неочакван Forbidden за пълен admin)`)
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
  // Windows понякога държи file handle към SQLite/WAL кратко след SIGTERM/SIGKILL
  // на child процеса — кратък retry вместо незабавен FAIL.
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
