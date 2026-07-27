/**
 * checkSubadminProfileStatusEligibility.ts
 *
 * Реален E2E тест на M3 продуктовото решение: субадмин може да бъде
 * НАЗНАЧЕН само на активен, постоянен човешки профил със свързан активен
 * акаунт; REVOKE остава разрешен независимо от статуса. Спъва изолирано
 * копие на реалния сървър (собствена temp SQLite база, реални migrations),
 * манипулира profiles.status/is_temporary/accounts.status директно в
 * изолираната SQLite база (никога реалната локална/production база), и
 * прави реални HTTP заявки.
 *
 * Покрива:
 *  [1] отказ при неактивен профил (profiles.status = 'disabled').
 *  [2] отказ при временен профил (profiles.is_temporary = 1).
 *  [3] отказ при профил без акаунт (бот — profiles.account_id IS NULL).
 *  [4] отказ при неактивен акаунт (accounts.status = 'disabled').
 *  [5] успешно revoke на вече съществуващ субадмин с неактивен профил.
 *  [6] липса на audit запис при отказан grant.
 *  [7] правилен audit запис при успешен revoke (независимо от статуса).
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const PASSWORD = 'StatusEligibilitySmoke1!'
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

function httpRequest(port: number, pathname: string, method: string, cookie?: string): Promise<HttpResult> {
  return new Promise((res, reject) => {
    const headers: Record<string, string> = {}
    if (cookie) headers['Cookie'] = cookie
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
  const root = await mkdtemp(join(tmpdir(), 'belot-subadmin-status-smoke-'))
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

function promoteToAdmin(databaseFile: string, email: string): void {
  const db = new DatabaseSync(databaseFile)
  db.exec('PRAGMA journal_mode = WAL;')
  db.prepare(`UPDATE accounts SET role = 'admin', updated_at = CURRENT_TIMESTAMP WHERE email = ?`).run(email)
  db.close()
}

type RegisteredUser = { cookie: string; profileId: string; accountId: string; email: string }

async function register(port: number, runId: string, suffix: string): Promise<RegisteredUser> {
  const email = `status-smoke-${runId}-${suffix}@example.test`
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

function setProfileStatus(databaseFile: string, profileId: string, status: 'active' | 'disabled'): void {
  const db = new DatabaseSync(databaseFile)
  db.prepare(`UPDATE profiles SET status = ? WHERE profile_id = ?`).run(status, profileId)
  db.close()
}

function setProfileTemporary(databaseFile: string, profileId: string, isTemporary: boolean): void {
  const db = new DatabaseSync(databaseFile)
  db.prepare(`UPDATE profiles SET is_temporary = ? WHERE profile_id = ?`).run(isTemporary ? 1 : 0, profileId)
  db.close()
}

function setAccountStatus(databaseFile: string, accountId: string, status: 'active' | 'disabled'): void {
  const db = new DatabaseSync(databaseFile)
  db.prepare(`UPDATE accounts SET status = ? WHERE account_id = ?`).run(status, accountId)
  db.close()
}

function getAuditRowsForTarget(databaseFile: string, targetAccountId: string): { action: string; previous_role: string; new_role: string; actor_account_id: string }[] {
  const db = new DatabaseSync(databaseFile, { open: true })
  const rows = db.prepare(`
    SELECT action, previous_role, new_role, actor_account_id
    FROM admin_role_audit_log
    WHERE target_account_id = ?
    ORDER BY created_at ASC
  `).all(targetAccountId) as { action: string; previous_role: string; new_role: string; actor_account_id: string }[]
  db.close()
  return rows
}

const sourceServerRoot = resolve(
  process.argv.slice(2).find((a) => a.startsWith('--server-root='))?.slice('--server-root='.length) ?? process.cwd(),
)

console.log('\n═══ Subadmin profile/account status eligibility E2E test (M3) ═══')
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
  // displayName трябва да минава validateProfileDisplayName (само букви/цифри
  // разделени с интервали — БЕЗ тирета), затова suffix-ите тук са без "-".
  const inactiveProfileUser = await register(port, runId, 'inactiveprofile')
  const temporaryUser = await register(port, runId, 'temporary')
  const inactiveAccountUser = await register(port, runId, 'inactiveaccount')
  const revokeAfterDeactivateUser = await register(port, runId, 'revokeafterdeactivate')
  const adminCandidate = await register(port, runId, 'admin1')

  promoteToAdmin(isolated.databaseFile, adminCandidate.email)
  const adminCookie = await login(port, adminCandidate.email)

  // ── [1] отказ при неактивен профил ──────────────────────────────────────
  console.log('\n[1] отказ при неактивен профил')
  setProfileStatus(isolated.databaseFile, inactiveProfileUser.profileId, 'disabled')
  await check('[1.1] grant за profiles.status=disabled => 400 profile_inactive', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${inactiveProfileUser.profileId}/subadmin`, 'POST', adminCookie)
    const b = r.body as { ok?: boolean; message?: string }
    if (r.status !== 400) throw new Error(`status=${r.status}, body=${JSON.stringify(b)}`)
  })
  await check('[1.2] role остава player (grant-ът не е приложен частично)', async () => {
    // Връщаме профила активен, само за да можем да проверим текущата роля read-only.
    setProfileStatus(isolated.databaseFile, inactiveProfileUser.profileId, 'active')
    const r = await httpRequest(port, `/api/admin/profiles/${inactiveProfileUser.profileId}/subadmin`, 'GET', adminCookie)
    const b = r.body as { ok?: boolean; role?: string }
    if (r.status !== 200 || b.role !== 'player') throw new Error(`status=${r.status}, role=${b.role}`)
    setProfileStatus(isolated.databaseFile, inactiveProfileUser.profileId, 'disabled')
  })

  // ── [6] липса на audit запис при отказан grant (за [1]) ─────────────────
  await check('[6.1] няма audit запис за отказания grant (неактивен профил)', () => {
    const rows = getAuditRowsForTarget(isolated.databaseFile, inactiveProfileUser.accountId)
    if (rows.length !== 0) throw new Error(`Очаквахме 0 audit реда, намерени: ${JSON.stringify(rows)}`)
  })

  // ── [2] отказ при временен профил ───────────────────────────────────────
  console.log('\n[2] отказ при временен профил')
  setProfileTemporary(isolated.databaseFile, temporaryUser.profileId, true)
  await check('[2.1] grant за is_temporary=1 => 400 profile_temporary', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${temporaryUser.profileId}/subadmin`, 'POST', adminCookie)
    const b = r.body as { ok?: boolean; message?: string }
    if (r.status !== 400) throw new Error(`status=${r.status}, body=${JSON.stringify(b)}`)
  })
  await check('[6.2] няма audit запис за отказания grant (временен профил)', () => {
    const rows = getAuditRowsForTarget(isolated.databaseFile, temporaryUser.accountId)
    if (rows.length !== 0) throw new Error(`Очаквахме 0 audit реда, намерени: ${JSON.stringify(rows)}`)
  })

  // ── [3] отказ при профил без акаунт (бот) ───────────────────────────────
  console.log('\n[3] отказ при профил без акаунт (бот)')
  const botDb = new DatabaseSync(isolated.databaseFile, { open: true })
  const botRow = botDb.prepare(`SELECT profile_id FROM profiles WHERE profile_kind = 'bot' LIMIT 1`).get() as { profile_id: string } | undefined
  botDb.close()
  if (botRow) {
    await check('[3.1] grant за бот профил (account_id IS NULL) => 400 no_account', async () => {
      const r = await httpRequest(port, `/api/admin/profiles/${botRow.profile_id}/subadmin`, 'POST', adminCookie)
      if (r.status !== 400) throw new Error(`status=${r.status}`)
    })
  } else {
    console.log('  (пропуснато — няма seed-нати ботове в тази изолирана база)')
  }

  // ── [4] отказ при неактивен акаунт ──────────────────────────────────────
  console.log('\n[4] отказ при неактивен акаунт')
  setAccountStatus(isolated.databaseFile, inactiveAccountUser.accountId, 'disabled')
  await check('[4.1] grant за accounts.status=disabled => 400 account_inactive', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${inactiveAccountUser.profileId}/subadmin`, 'POST', adminCookie)
    const b = r.body as { ok?: boolean; message?: string }
    if (r.status !== 400) throw new Error(`status=${r.status}, body=${JSON.stringify(b)}`)
  })
  await check('[6.3] няма audit запис за отказания grant (неактивен акаунт)', () => {
    const rows = getAuditRowsForTarget(isolated.databaseFile, inactiveAccountUser.accountId)
    if (rows.length !== 0) throw new Error(`Очаквахме 0 audit реда, намерени: ${JSON.stringify(rows)}`)
  })
  setAccountStatus(isolated.databaseFile, inactiveAccountUser.accountId, 'active')

  // ── [5]/[7] успешно revoke на субадмин с неактивен профил + audit ───────
  console.log('\n[5][7] revoke работи дори при неактивен профил, с коректен audit')
  await check('[5.1] setup: grant докато профилът е АКТИВЕН => 200 ok:true role:subadmin', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${revokeAfterDeactivateUser.profileId}/subadmin`, 'POST', adminCookie)
    const b = r.body as { ok?: boolean; role?: string }
    if (r.status !== 200 || b.ok !== true || b.role !== 'subadmin') throw new Error(`status=${r.status}, body=${JSON.stringify(b)}`)
  })

  // Деактивираме профила СЛЕД като вече е субадмин (симулира "профилът е бил
  // деактивиран междувременно" — без автоматично отнемане на ролята, по дизайн).
  setProfileStatus(isolated.databaseFile, revokeAfterDeactivateUser.profileId, 'disabled')

  await check('[5.2] revoke за неактивен профил => 200 ok:true role:player (REVOKE винаги позволен)', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${revokeAfterDeactivateUser.profileId}/subadmin`, 'DELETE', adminCookie)
    const b = r.body as { ok?: boolean; role?: string }
    if (r.status !== 200 || b.ok !== true || b.role !== 'player') throw new Error(`status=${r.status}, body=${JSON.stringify(b)}`)
  })

  await check('[7.1] audit log съдържа точно 2 реда (grant + revoke) за този target', () => {
    const rows = getAuditRowsForTarget(isolated.databaseFile, revokeAfterDeactivateUser.accountId)
    if (rows.length !== 2) throw new Error(`Брой редове=${rows.length}: ${JSON.stringify(rows)}`)
  })
  await check('[7.2] audit ред 1: grant_subadmin player->subadmin', () => {
    const rows = getAuditRowsForTarget(isolated.databaseFile, revokeAfterDeactivateUser.accountId)
    const r = rows[0]
    if (!r || r.action !== 'grant_subadmin' || r.previous_role !== 'player' || r.new_role !== 'subadmin') {
      throw new Error(JSON.stringify(r))
    }
  })
  await check('[7.3] audit ред 2: revoke_subadmin subadmin->player, коректен actor, независимо от неактивния профил', () => {
    const rows = getAuditRowsForTarget(isolated.databaseFile, revokeAfterDeactivateUser.accountId)
    const r = rows[1]
    if (!r || r.action !== 'revoke_subadmin' || r.previous_role !== 'subadmin' || r.new_role !== 'player') {
      throw new Error(JSON.stringify(r))
    }
    if (r.actor_account_id !== adminCandidate.accountId) {
      throw new Error(`actor_account_id=${r.actor_account_id}, очакван=${adminCandidate.accountId}`)
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
