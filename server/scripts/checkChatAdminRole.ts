/**
 * checkChatAdminRole.ts
 *
 * Пълен E2E smoke тест на новата роля chat_admin: спъва изолирано копие на
 * реалния сървър (собствена temp SQLite база, реални migrations, реален HTTP
 * слой), огледално на checkSubadminHttpAuthorization.ts. Покрива специфично
 * НОВАТА функционалност (роля/endpoint management), НЕ дублира изтриването на
 * лайв чат съобщения (виж checkLobbyChat.ts [A11]) нито render-а на бадж/
 * бутони (виж checkSubadminProfilePopupRendering.ts).
 *
 * Покрива:
 *  [1]  chat_admin няма достъп до НИТО ЕДИН друг admin endpoint/екран
 *       (READ_ONLY_ADMIN_ENDPOINTS + ADMIN_ONLY_ENDPOINTS, всички 403).
 *  [2]  chat_admin не може да чете чужда роля (GET .../subadmin => 403).
 *  [3]  chat_admin не може да grant-badge subadmin на никого (403).
 *  [4]  chat_admin не може да grant/revoke chat_admin (дори себе си) — само
 *       пълен admin управлява роли (403).
 *  [5]  admin grant-ва chat_admin на player => 200, роля=chat_admin.
 *  [6]  admin grant-ва subadmin на chat_admin target => директно превключване
 *       (без нужда от изричен revoke), роля=subadmin.
 *  [7]  admin grant-ва chat_admin на subadmin target => обратно превключване.
 *  [8]  admin revoke-ва chat_admin => роля=player.
 *  [9]  Идемпотентност: повторен revoke на вече-player => ok, БЕЗ нов audit ред.
 *  [10] Mismatch guard: revoke chat_admin върху реално subadmin акаунт => 409
 *       conflict, ролята остава непроменена (не пипа чуждата роля мълчаливо).
 *  [11] Self: admin не може да промени собствената си роля през chat-admin endpoint.
 *  [12] target_is_admin: не може да се пипне роля на друг пълен admin.
 *  [13] Правата важат ВЕДНАГА без re-login (стар cookie, преди/след grant).
 *  [14] Audit log записва коректен actor/target/action/previous/new role за
 *       всеки преход, вкл. switch-преходите.
 *  [15] chat_admin не получава admin/subadmin ordering в /api/players (третира
 *       се като обикновен player) и НЕ разкрива роля в отговора.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const PASSWORD = 'ChatAdminSmoke1!'
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
  const root = await mkdtemp(join(tmpdir(), 'belot-chat-admin-smoke-'))
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
  const email = `chat-admin-smoke-${runId}-${suffix}@example.test`
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, displayName: `Smoke ${suffix.replace(/-/g, ' ')}`, gender: 'male' }),
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

console.log('\n═══ chat_admin role E2E test ═══')
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
  const targetGrant = await register(port, runId, 'target-grant')
  const targetSwitch = await register(port, runId, 'target-switch')
  const targetMismatch = await register(port, runId, 'target-mismatch')
  const targetImmediate = await register(port, runId, 'target-immediate')
  const adminCandidate = await register(port, runId, 'admin1')
  const admin2Candidate = await register(port, runId, 'admin2')

  promoteToAdmin(isolated.databaseFile, adminCandidate.email)
  promoteToAdmin(isolated.databaseFile, admin2Candidate.email)
  const adminCookie = await login(port, adminCandidate.email)
  const admin2Cookie = await login(port, admin2Candidate.email)

  console.log('  Регистрирани: 4 targets, admin1, admin2.')

  // ── Grant chat_admin на targetGrant, за да тестваме [1]-[4] като chat_admin ──
  console.log('\n[setup] admin1 grant-ва chat_admin на targetGrant')
  {
    const r = await httpRequest(port, `/api/admin/profiles/${targetGrant.profileId}/chat-admin`, 'POST', adminCookie)
    if (r.status !== 200) throw new Error(`grant chat_admin setup провали: status=${r.status}, body=${JSON.stringify(r.body)}`)
  }
  const chatAdminCookie = targetGrant.cookie

  // ── [1] chat_admin няма достъп до НИТО ЕДИН друг admin endpoint ──────────
  console.log('\n[1] chat_admin няма достъп до други admin endpoints')
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
    await check(`[1] chat_admin -> GET ${path} => 403`, async () => {
      const r = await httpRequest(port, path, 'GET', chatAdminCookie)
      if (r.status !== 403) throw new Error(`status=${r.status}`)
    })
  }
  await check('[1] chat_admin -> PATCH profile display-name (moderation) => 403', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${targetGrant.profileId}/display-name`, 'PATCH', chatAdminCookie, { displayName: 'Hacked' })
    if (r.status !== 403) throw new Error(`status=${r.status}`)
  })

  // ── [2] chat_admin не може да чете чужда роля ────────────────────────────
  console.log('\n[2] chat_admin не може да чете чужда роля')
  await check('[2] chat_admin -> GET .../subadmin (роля) => 403', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${targetSwitch.profileId}/subadmin`, 'GET', chatAdminCookie)
    if (r.status !== 403) throw new Error(`status=${r.status}`)
  })

  // ── [3] chat_admin не може да grant-badge subadmin ───────────────────────
  console.log('\n[3] chat_admin не може да управлява subadmin роля')
  await check('[3] chat_admin -> POST .../subadmin => 403', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${targetSwitch.profileId}/subadmin`, 'POST', chatAdminCookie)
    if (r.status !== 403) throw new Error(`status=${r.status}`)
  })

  // ── [4] chat_admin не може да управлява chat_admin роля (дори себе си) ───
  console.log('\n[4] chat_admin не може да управлява chat_admin роля')
  await check('[4] chat_admin -> POST .../chat-admin (чужд target) => 403', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${targetSwitch.profileId}/chat-admin`, 'POST', chatAdminCookie)
    if (r.status !== 403) throw new Error(`status=${r.status}`)
  })
  await check('[4] chat_admin -> DELETE .../chat-admin (собствен профил) => 403', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${targetGrant.profileId}/chat-admin`, 'DELETE', chatAdminCookie)
    if (r.status !== 403) throw new Error(`status=${r.status}`)
  })

  // ── [5]-[9] Основен grant/revoke/idempotency цикъл (targetGrant) ────────
  console.log('\n[5]-[9] Основен grant/revoke/idempotency цикъл')
  await check('[5] admin1 grant-ва chat_admin на targetGrant => вече потвърдено в setup, role=chat_admin', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${targetGrant.profileId}/subadmin`, 'GET', adminCookie)
    const body = r.body as { ok?: boolean; role?: string }
    if (r.status !== 200 || body.role !== 'chat_admin') throw new Error(`status=${r.status}, role=${body.role}`)
  })

  await check('[9] admin1 grant-ва chat_admin отново (идемпотентно) => 200, role=chat_admin', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${targetGrant.profileId}/chat-admin`, 'POST', adminCookie)
    const body = r.body as { ok?: boolean; role?: string }
    if (r.status !== 200 || body.role !== 'chat_admin') throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
  })

  await check('[8] admin1 revoke-ва chat_admin от targetGrant => 200, role=player', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${targetGrant.profileId}/chat-admin`, 'DELETE', adminCookie)
    const body = r.body as { ok?: boolean; role?: string }
    if (r.status !== 200 || body.role !== 'player') throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
  })

  await check('[9] admin1 revoke-ва отново (вече player, идемпотентно) => 200, role=player', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${targetGrant.profileId}/chat-admin`, 'DELETE', adminCookie)
    const body = r.body as { ok?: boolean; role?: string }
    if (r.status !== 200 || body.role !== 'player') throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
  })

  // ── [6]-[7] Директно превключване subadmin <-> chat_admin (targetSwitch) ─
  console.log('\n[6]-[7] Директно превключване subadmin <-> chat_admin')
  await check('[setup] admin1 grant-ва subadmin на targetSwitch => 200, role=subadmin', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${targetSwitch.profileId}/subadmin`, 'POST', adminCookie)
    const body = r.body as { ok?: boolean; role?: string }
    if (r.status !== 200 || body.role !== 'subadmin') throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
  })
  await check('[6] admin1 grant-ва chat_admin на subadmin target => директно превключва, role=chat_admin', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${targetSwitch.profileId}/chat-admin`, 'POST', adminCookie)
    const body = r.body as { ok?: boolean; role?: string }
    if (r.status !== 200 || body.role !== 'chat_admin') throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
  })
  await check('[7] admin1 grant-ва subadmin на chat_admin target => обратно превключва, role=subadmin', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${targetSwitch.profileId}/subadmin`, 'POST', adminCookie)
    const body = r.body as { ok?: boolean; role?: string }
    if (r.status !== 200 || body.role !== 'subadmin') throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
  })

  // ── [10] Mismatch guard (targetMismatch) ─────────────────────────────────
  console.log('\n[10] Mismatch guard — revoke на роля, която акаунтът реално няма')
  await check('[setup] admin1 grant-ва subadmin на targetMismatch => 200', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${targetMismatch.profileId}/subadmin`, 'POST', adminCookie)
    const body = r.body as { ok?: boolean; role?: string }
    if (r.status !== 200 || body.role !== 'subadmin') throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
  })
  await check('[10] admin1 revoke-ва chat_admin от РЕАЛНО subadmin target => 409 conflict', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${targetMismatch.profileId}/chat-admin`, 'DELETE', adminCookie)
    if (r.status !== 409) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
  })
  await check('[10] targetMismatch остава subadmin (непроменено от неуспешния revoke)', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${targetMismatch.profileId}/subadmin`, 'GET', adminCookie)
    const body = r.body as { ok?: boolean; role?: string }
    if (r.status !== 200 || body.role !== 'subadmin') throw new Error(`status=${r.status}, role=${body.role}`)
  })

  // ── [11] Self ─────────────────────────────────────────────────────────────
  console.log('\n[11] admin не може да смени собствената си роля през chat-admin endpoint')
  await check('[11] admin1 -> POST chat-admin на собствения си профил => 400', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${adminCandidate.profileId}/chat-admin`, 'POST', adminCookie)
    if (r.status !== 400) throw new Error(`status=${r.status}`)
  })

  // ── [12] target_is_admin ─────────────────────────────────────────────────
  console.log('\n[12] не може да се пипне ролята на друг пълен admin')
  await check('[12] admin1 -> POST chat-admin на admin2 => 409 target_is_admin', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${admin2Candidate.profileId}/chat-admin`, 'POST', adminCookie)
    if (r.status !== 409) throw new Error(`status=${r.status}`)
  })

  // ── [13] Веднага без re-login ─────────────────────────────────────────────
  console.log('\n[13] правата важат веднага, без re-login')
  const immediateCookieBefore = targetImmediate.cookie
  await check('[13] преди grant: DELETE lobby-chat (несъществуващо съобщение) => 403 (не е moderator)', async () => {
    const r = await httpRequest(port, '/api/lobby-chat/messages/does-not-exist', 'DELETE', immediateCookieBefore)
    if (r.status !== 403) throw new Error(`status=${r.status}`)
  })
  await check('[setup] admin1 grant-ва chat_admin на targetImmediate => 200', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${targetImmediate.profileId}/chat-admin`, 'POST', adminCookie)
    const body = r.body as { ok?: boolean; role?: string }
    if (r.status !== 200 || body.role !== 'chat_admin') throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
  })
  await check('[13] след grant, СЪЩИЯ стар cookie: DELETE lobby-chat => 404 (не 403 — гейтът мина, съобщението просто не съществува)', async () => {
    const r = await httpRequest(port, '/api/lobby-chat/messages/does-not-exist', 'DELETE', immediateCookieBefore)
    if (r.status !== 404) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
  })

  // ── [14] Audit log ────────────────────────────────────────────────────────
  console.log('\n[14] audit log записва коректни преходи')
  const auditDb = new DatabaseSync(isolated.databaseFile, { open: true })
  type AuditRow = { actor_account_id: string; action: string; previous_role: string; new_role: string }
  function auditRowsFor(targetAccountId: string): AuditRow[] {
    return auditDb.prepare(`
      SELECT actor_account_id, action, previous_role, new_role
      FROM admin_role_audit_log
      WHERE target_account_id = ?
      ORDER BY created_at ASC, rowid ASC
    `).all(targetAccountId) as AuditRow[]
  }

  await check('[14.1] targetGrant: точно 2 реда (grant + revoke; идемпотентните повторения без нов ред)', () => {
    const rows = auditRowsFor(targetGrant.accountId)
    if (rows.length !== 2) throw new Error(`брой=${rows.length}: ${JSON.stringify(rows)}`)
    if (rows[0]!.action !== 'grant_chat_admin' || rows[0]!.previous_role !== 'player' || rows[0]!.new_role !== 'chat_admin') {
      throw new Error(`ред 0: ${JSON.stringify(rows[0])}`)
    }
    if (rows[1]!.action !== 'revoke_chat_admin' || rows[1]!.previous_role !== 'chat_admin' || rows[1]!.new_role !== 'player') {
      throw new Error(`ред 1: ${JSON.stringify(rows[1])}`)
    }
    if (rows[0]!.actor_account_id !== adminCandidate.accountId || rows[1]!.actor_account_id !== adminCandidate.accountId) {
      throw new Error(`actor не е admin1: ${JSON.stringify(rows)}`)
    }
  })

  await check('[14.2] targetSwitch: 3 реда — grant_subadmin, grant_chat_admin (switch), grant_subadmin (switch back)', () => {
    const rows = auditRowsFor(targetSwitch.accountId)
    if (rows.length !== 3) throw new Error(`брой=${rows.length}: ${JSON.stringify(rows)}`)
    if (rows[0]!.action !== 'grant_subadmin' || rows[0]!.previous_role !== 'player' || rows[0]!.new_role !== 'subadmin') {
      throw new Error(`ред 0: ${JSON.stringify(rows[0])}`)
    }
    if (rows[1]!.action !== 'grant_chat_admin' || rows[1]!.previous_role !== 'subadmin' || rows[1]!.new_role !== 'chat_admin') {
      throw new Error(`ред 1 (switch): ${JSON.stringify(rows[1])}`)
    }
    if (rows[2]!.action !== 'grant_subadmin' || rows[2]!.previous_role !== 'chat_admin' || rows[2]!.new_role !== 'subadmin') {
      throw new Error(`ред 2 (switch back): ${JSON.stringify(rows[2])}`)
    }
  })

  await check('[14.3] targetMismatch: точно 1 ред (само успешния grant_subadmin — неуспешният mismatch revoke НЕ добавя ред)', () => {
    const rows = auditRowsFor(targetMismatch.accountId)
    if (rows.length !== 1) throw new Error(`брой=${rows.length}: ${JSON.stringify(rows)}`)
    if (rows[0]!.action !== 'grant_subadmin' || rows[0]!.previous_role !== 'player' || rows[0]!.new_role !== 'subadmin') {
      throw new Error(`ред 0: ${JSON.stringify(rows[0])}`)
    }
  })
  auditDb.close()

  // ── [15] Players directory: chat_admin = обикновен player, без role leak ──
  console.log('\n[15] /api/players третира chat_admin като player и не разкрива роля')
  await check('[15] chat_admin -> GET /api/players => 200, отговорът не съдържа поле "role"', async () => {
    const r = await httpRequest(port, '/api/players', 'GET', chatAdminCookie)
    if (r.status !== 200) throw new Error(`status=${r.status}`)
    const body = r.body as { ok?: boolean; players?: unknown[] }
    if (!body.ok || !Array.isArray(body.players)) throw new Error(`невалиден отговор: ${JSON.stringify(body)}`)
    for (const p of body.players) {
      if (p !== null && typeof p === 'object' && 'role' in p) {
        throw new Error(`профил в /api/players съдържа поле "role" — течаща роля: ${JSON.stringify(p)}`)
      }
    }
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
