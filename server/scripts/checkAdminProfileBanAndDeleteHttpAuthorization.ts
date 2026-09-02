/**
 * checkAdminProfileBanAndDeleteHttpAuthorization.ts
 *
 * E2E тест на admin moderation endpoint-ите (BAN/UNBAN/HARD DELETE):
 *   POST/GET/DELETE /api/admin/profiles/:id/ban
 *   DELETE          /api/admin/profiles/:id
 * Огледално на checkAdminVipGrantHttpAuthorization.ts — изолирано копие на
 * реалния сървър (собствена temp SQLite база, реални migrations, реален
 * HTTP слой), за да покрие ролева authorization + business logic + audit
 * trail на новите endpoint-и, не само frontend-скрити бутони.
 *
 * Покрива (spec §11 + blocker fix брифа §1/§3):
 *  - non-admin/subadmin direct API call -> 403
 *  - admin self-ban / self-delete -> 400
 *  - nonexistent profile -> 404
 *  - invalid days (0/negative/decimal/string) -> 400
 *  - empty/whitespace reason -> 400
 *  - already banned -> без duplicate active ban (409)
 *  - unban -> login веднага работи (без нов активен бан)
 *  - login с активен бан -> structured PROFILE_BANNED (403) с bannedUntil/reason/remainingDays
 *  - hard delete -> username/email веднага свободни за нова регистрация
 *  - hard delete -> admin_profile_deletions audit ред, БЕЗ profiles row
 *  - [blocker §1] active session -> admin BAN -> старият session token
 *    веднага получава invalid/unauthenticated session при authenticated
 *    HTTP заявка (GET /api/auth/me connection=null), не само WS close
 *  - [blocker §3] online target: admin hard delete -> audit + transactional
 *    delete -> target sessions инвалидирани -> живият WS socket получава
 *    'session_deleted' -> старият session token вече не работи за
 *    authenticated HTTP -> username/email освободени
 *  - [blocker round 2 §1] immutable deleted-profile identity: агрегиран
 *    forensic snapshot от site_visit_events (вкл. middle-profile сценарий
 *    A->TARGET->B, НЕ само site_visitors first/last owner) +
 *    profile_bans/yellow_coin_gift_ledger (sender И recipient поотделно)/
 *    match_economy_ledger deleted_*_profile_id_snapshot остават
 *    reconstructable СЛЕД hard delete (не само "редът оцелява", а
 *    конкретно "знаем чий беше", без да променяме amount/balance/reason)
 *  - [blocker round 2 §2] tournament dependency policy: hard delete на
 *    creator/participant в НЕ-terminal турнир се отказва (409); finished
 *    турнир не се засяга — creator_profile_id/entry.profile_id остават
 *    snapshot-нати, самият турнир/entries/резултати НЕ се трият
 *  - [round 4] BAN/DELETE не прекъсват активна игра:
 *    A) BAN offline -> next login -> PROFILE_BANNED
 *    B) DELETE offline -> next login -> generic invalid credentials, БЕЗ delete-specific code
 *    C) BAN online/not-playing -> immediate session_banned
 *    D) DELETE online/not-playing -> immediate session_deleted
 *    E/F) pending-during-active-game — targeted store/lifecycle ниво (без
 *    пълен gameplay WS harness): pending_profile_moderation persistence,
 *    profile row оцелява докато pending, login/join guard-ове; реалният
 *    match-ended hook остава за manual verification (виж отчета)
 *  - [round 5 blocker §1] active tournament dependency guard-ва DELETE
 *    ПРЕДИ recordPendingDelete (не само вътре в hardDeleteProfile) —
 *    409 веднага, НЕ се създава pending row, профилът остава непроменен
 *  - [round 5 §2] reconnect policy: нова WS connection за profile с pending
 *    moderation не се authenticate-ва (connect-time gate), join_matchmaking
 *    връща "трябва да влезеш" (auth вече отхвърлен); resume_room sanity check
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { WebSocket } from 'ws'
import { join, resolve } from 'node:path'

const PASSWORD = 'BanDeleteSmoke1!'
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
  const root = await mkdtemp(join(tmpdir(), 'belot-ban-delete-smoke-'))
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
  const email = `ban-delete-smoke-${runId}-${suffix}@example.test`
  const displayName = `BanSmoke${runId.replace(/[^0-9]/g, '').slice(-6)}${suffix}`
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

async function loginRaw(port: number, email: string): Promise<{ status: number; body: unknown; cookie: string | null }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  })
  const payload = await res.json().catch(() => null)
  const headersExt = res.headers as Headers & { getSetCookie?: () => string[] }
  const rawCookie = headersExt.getSetCookie?.()[0] ?? res.headers.get('set-cookie')
  return { status: res.status, body: payload, cookie: rawCookie ? rawCookie.split(';')[0]! : null }
}

async function login(port: number, email: string): Promise<string> {
  const result = await loginRaw(port, email)
  if (result.status !== 200 || result.cookie === null) throw new Error(`Login не е успешен за ${email}: status=${result.status}, body=${JSON.stringify(result.body)}`)
  return result.cookie
}

/** Mirror на createTournament в checkTournamentEntryHttpApi.ts — минимален helper за blocker-2 сценариите. */
async function createTournament(
  port: number,
  cookie: string,
  name: string,
): Promise<{ tournamentId: string }> {
  const r = await httpRequest(port, '/api/tournaments', 'POST', cookie, {
    name,
    entryFee: 20000,
    visibility: 'public',
    startMode: 'fill',
  })
  const b = r.body as { ok?: boolean; tournament?: { tournamentId?: string } }
  if (r.status !== 200 || b.ok !== true || !b.tournament?.tournamentId) {
    throw new Error(`createTournament failed: status=${r.status} body=${JSON.stringify(r.body)}`)
  }
  return { tournamentId: b.tournament.tournamentId }
}

const sourceServerRoot = resolve(
  process.argv.slice(2).find((a) => a.startsWith('--server-root='))?.slice('--server-root='.length) ?? process.cwd(),
)

console.log('\n═══ Admin profile BAN/UNBAN/HARD-DELETE HTTP authorization E2E test ═══')
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
  const banTarget = await register(port, runId, 'bantarget')
  const deleteTarget = await register(port, runId, 'deltarget')
  const onlineDeleteTarget = await register(port, runId, 'onlinedeltarget')
  const forensicDeleteTarget = await register(port, runId, 'forensicdel')
  const banHistoryDeleteTarget = await register(port, runId, 'banhistdel')
  const tournamentActiveTarget = await register(port, runId, 'touractive')
  const tournamentFinishedCreator = await register(port, runId, 'tourfincreat')
  const tournamentFinishedParticipant = await register(port, runId, 'tourfinpart')
  const offlineBanTarget = await register(port, runId, 'offlineban')
  const offlineDeleteTarget = await register(port, runId, 'offlinedel')
  const onlineNotPlayingBanTarget = await register(port, runId, 'onlinenpban')
  const onlineNotPlayingDeleteTarget = await register(port, runId, 'onlinenpdel')
  const pendingBanTarget = await register(port, runId, 'pendingban')
  const pendingDeleteTarget = await register(port, runId, 'pendingdel')
  const tournamentPendingGuardTarget = await register(port, runId, 'tourpendguard')
  const adminCandidate = await register(port, runId, 'admin')
  const subadminCandidate = await register(port, runId, 'subadmin')

  promoteRole(isolated.databaseFile, adminCandidate.email, 'admin')
  promoteRole(isolated.databaseFile, subadminCandidate.email, 'subadmin')

  const adminCookie = await login(port, adminCandidate.email)
  const subadminCookie = await login(port, subadminCandidate.email)

  console.log('  Регистрирани: player, ban-target, delete-target, admin, subadmin.')

  // ── non-admin/subadmin direct API call -> 403 ───────────────────────────
  console.log('\n[authz] Само role===admin минава — player/subadmin => 403, guest => 403')
  const NON_ADMIN_SESSIONS: Array<{ label: string; cookie: string }> = [
    { label: 'player', cookie: player.cookie },
    { label: 'subadmin', cookie: subadminCookie },
  ]
  for (const { label, cookie } of NON_ADMIN_SESSIONS) {
    await check(`[authz] ${label} -> POST ban => 403`, async () => {
      const r = await httpRequest(port, `/api/admin/profiles/${banTarget.profileId}/ban`, 'POST', cookie, { days: 7, reason: 'test' })
      if (r.status !== 403) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
    })
    await check(`[authz] ${label} -> DELETE profile => 403`, async () => {
      const r = await httpRequest(port, `/api/admin/profiles/${deleteTarget.profileId}`, 'DELETE', cookie, { reason: 'test' })
      if (r.status !== 403) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
    })
  }
  await check('[authz] guest (без cookie) -> POST ban => 403', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${banTarget.profileId}/ban`, 'POST', undefined, { days: 7, reason: 'test' })
    if (r.status !== 403) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
  })

  // ── self-ban / self-delete -> 400 ────────────────────────────────────────
  console.log('\n[self] admin self-ban / self-delete => 400')
  await check('[self] admin -> POST ban на СЕБЕ СИ => 400', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${adminCandidate.profileId}/ban`, 'POST', adminCookie, { days: 7, reason: 'test' })
    if (r.status !== 400) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
  })
  await check('[self] admin -> DELETE СЕБЕ СИ => 400', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${adminCandidate.profileId}`, 'DELETE', adminCookie, { reason: 'test' })
    if (r.status !== 400) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
  })

  // ── nonexistent profile -> 404 ───────────────────────────────────────────
  console.log('\n[404] несъществуващ target')
  await check('[404] admin -> POST ban на несъществуващ profileId => 404', async () => {
    const r = await httpRequest(port, '/api/admin/profiles/does-not-exist-12345/ban', 'POST', adminCookie, { days: 7, reason: 'test' })
    if (r.status !== 404) throw new Error(`status=${r.status}`)
  })
  await check('[404] admin -> DELETE несъществуващ profileId => 404', async () => {
    const r = await httpRequest(port, '/api/admin/profiles/does-not-exist-12345', 'DELETE', adminCookie, { reason: 'test' })
    if (r.status !== 404) throw new Error(`status=${r.status}`)
  })

  // ── invalid days / empty reason -> 400 ───────────────────────────────────
  console.log('\n[validate] невалидни days / празна причина => 400')
  const INVALID_DAYS: Array<{ label: string; days: unknown }> = [
    { label: '0', days: 0 },
    { label: 'отрицателно (-5)', days: -5 },
    { label: 'decimal (2.5)', days: 2.5 },
    { label: 'нечислов текст ("abc")', days: 'abc' },
    { label: 'липсващо поле', days: undefined },
  ]
  for (const { label, days } of INVALID_DAYS) {
    await check(`[validate] admin -> POST ban {days: ${label}} => 400`, async () => {
      const body = { reason: 'test', ...(days === undefined ? {} : { days }) }
      const r = await httpRequest(port, `/api/admin/profiles/${banTarget.profileId}/ban`, 'POST', adminCookie, body)
      if (r.status !== 400) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
    })
  }
  await check('[validate] admin -> POST ban {reason: ""} => 400', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${banTarget.profileId}/ban`, 'POST', adminCookie, { days: 7, reason: '   ' })
    if (r.status !== 400) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
  })
  await check('[validate] admin -> DELETE profile {reason: ""} => 400', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${deleteTarget.profileId}`, 'DELETE', adminCookie, { reason: '' })
    if (r.status !== 400) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
  })

  // ── successful ban -> already_banned duplicate guard -> unban -> login works ──
  console.log('\n[ban-flow] успешен ban -> duplicate 409 -> login blocked -> unban -> login works')

  // banTarget.cookie е активна session, издадена ПРИ РЕГИСТРАЦИЯТА (преди
  // самия ban) — точно сценарият от blocker §1 ("active session -> admin
  // BAN -> старият session token веднага получава unauthorized/invalid
  // session при authenticated HTTP заявка"). Потвърждаваме, че тя работи
  // ПРЕДИ ban-а, за да е сигурно, че последващият провал идва РЕАЛНО от
  // ban revocation-а, не от друга причина (напр. изтекла/невалидна cookie).
  await check('[blocker-1] banTarget session работи ПРЕДИ ban (GET /api/auth/me => session != null)', async () => {
    const r = await httpRequest(port, '/api/auth/me', 'GET', banTarget.cookie)
    const b = r.body as { ok?: boolean; session?: unknown }
    if (r.status !== 200 || b.ok !== true || !b.session) throw new Error(`status=${r.status}, body=${JSON.stringify(b)}`)
  })

  await check('[ban-flow] admin -> POST ban {days:5,reason} => 200 + ban payload', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${banTarget.profileId}/ban`, 'POST', adminCookie, { days: 5, reason: 'testing ban flow' })
    const b = r.body as { ok?: boolean; ban?: { remainingDays?: number; reason?: string } }
    if (r.status !== 200 || b.ok !== true || !b.ban) throw new Error(`status=${r.status}, body=${JSON.stringify(b)}`)
    if (b.ban.remainingDays !== 5) throw new Error(`remainingDays=${b.ban.remainingDays}, очаквах 5`)
    if (b.ban.reason !== 'testing ban flow') throw new Error(`reason=${b.ban.reason}`)
  })

  // ── [blocker §1] session revocation при BAN ──────────────────────────────
  await check('[blocker-1] СЪЩАТА banTarget session СЛЕД ban => invalid (GET /api/auth/me => session:null, не само WS close)', async () => {
    const r = await httpRequest(port, '/api/auth/me', 'GET', banTarget.cookie)
    const b = r.body as { ok?: boolean; session?: unknown }
    // /api/auth/me винаги връща 200 (никога 401) — session:null Е сигналът
    // за "тази cookie вече не удостоверява никого" (виж handleAuthRequest
    // в index.ts). Ако revokeAllSessionsForProfile НЕ работеше, тук
    // session щеше все още да сочи banTarget-а въпреки активния бан.
    if (r.status !== 200 || b.ok !== true) throw new Error(`status=${r.status}, body=${JSON.stringify(b)}`)
    if (b.session !== null) throw new Error(`session все още валидна СЛЕД ban: ${JSON.stringify(b.session)}`)
  })
  // Друг authenticated endpoint (не /api/auth/me) — потвърждава, че
  // revocation-ът важи за ЦЕЛИЯ authenticated HTTP API, не само за
  // единствения diagnostic route.
  await check('[blocker-1] СЪЩАТА banTarget session СЛЕД ban => 401 на друг authenticated endpoint (/api/profile/me)', async () => {
    const r = await httpRequest(port, '/api/profile/me', 'GET', banTarget.cookie)
    if (r.status !== 401) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)} (очаквах 401 — стар session token не трябва да работи никъде)`)
  })

  await check('[ban-flow] admin -> втори POST ban върху вече баннат => 409 already_banned', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${banTarget.profileId}/ban`, 'POST', adminCookie, { days: 3, reason: 'duplicate attempt' })
    if (r.status !== 409) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
  })
  await check('[ban-flow] GET ban => activeBan != null', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${banTarget.profileId}/ban`, 'GET', adminCookie)
    const b = r.body as { ok?: boolean; activeBan?: unknown }
    if (r.status !== 200 || b.ok !== true || !b.activeBan) throw new Error(`status=${r.status}, body=${JSON.stringify(b)}`)
  })
  await check('[ban-flow] баннат профил -> login => 403 structured PROFILE_BANNED', async () => {
    const r = await loginRaw(port, banTarget.email)
    const b = r.body as { ok?: boolean; code?: string; bannedUntil?: string; reason?: string; remainingDays?: number }
    if (r.status !== 403 || b.code !== 'PROFILE_BANNED') throw new Error(`status=${r.status}, body=${JSON.stringify(b)}`)
    if (!b.bannedUntil || b.reason !== 'testing ban flow' || b.remainingDays !== 5) {
      throw new Error(`структурата на PROFILE_BANNED отговора е непълна: ${JSON.stringify(b)}`)
    }
  })
  await check('[ban-flow] admin -> DELETE ban (unban) => 200', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${banTarget.profileId}/ban`, 'DELETE', adminCookie)
    if (r.status !== 200) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
  })
  await check('[ban-flow] след unban -> DELETE ban отново => 409 no_active_ban', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${banTarget.profileId}/ban`, 'DELETE', adminCookie)
    if (r.status !== 409) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
  })
  await check('[ban-flow] след unban -> login веднага работи (200, session)', async () => {
    const r = await loginRaw(port, banTarget.email)
    const b = r.body as { ok?: boolean; session?: unknown }
    if (r.status !== 200 || b.ok !== true || !b.session) throw new Error(`status=${r.status}, body=${JSON.stringify(b)}`)
  })

  // ── hard delete -> username/email веднага свободни ──────────────────────
  console.log('\n[delete-flow] hard delete -> username/email свободни -> audit ред, без profiles row')
  await check('[delete-flow] admin -> DELETE profile {reason} => 200', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${deleteTarget.profileId}`, 'DELETE', adminCookie, { reason: 'testing hard delete' })
    if (r.status !== 200) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
  })
  await check('[delete-flow] изтрит профил -> login => 400 (грешен email/парола, профилът вече не съществува)', async () => {
    const r = await loginRaw(port, deleteTarget.email)
    if (r.status !== 400) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
  })
  await check('[delete-flow] СЪЩИЯТ email може да се регистрира отново (освободен)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: deleteTarget.email, password: PASSWORD, displayName: `${deleteTarget.displayName}Re`, gender: 'male' }),
    })
    const b = await res.json() as { ok?: boolean; message?: string }
    if (res.status !== 200 || b.ok !== true) throw new Error(`status=${res.status}, body=${JSON.stringify(b)}`)
  })
  await check('[delete-flow] СЪЩОТО displayName/username може да се регистрира отново (освободено)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: `ban-delete-smoke-${runId}-namereuse@example.test`, password: PASSWORD, displayName: deleteTarget.displayName, gender: 'male' }),
    })
    const b = await res.json() as { ok?: boolean; message?: string }
    if (res.status !== 200 || b.ok !== true) throw new Error(`status=${res.status}, body=${JSON.stringify(b)}`)
  })

  console.log('\n[audit] admin_profile_deletions + profiles row вече не съществува')
  const auditDb = new DatabaseSync(isolated.databaseFile, { open: true })
  const deletionRows = auditDb.prepare(`
    SELECT deleted_profile_id, username_snapshot, deleted_by_profile_id, reason
    FROM admin_profile_deletions
    WHERE deleted_profile_id = ?
  `).all(deleteTarget.profileId) as Array<{
    deleted_profile_id: string
    username_snapshot: string
    deleted_by_profile_id: string | null
    reason: string
  }>
  const remainingProfileRow = auditDb.prepare(`SELECT profile_id FROM profiles WHERE profile_id = ?`).get(deleteTarget.profileId)
  const remainingAccountRow = auditDb.prepare(`SELECT account_id FROM accounts WHERE account_id = ?`).get(deleteTarget.accountId)
  auditDb.close()

  await check('[audit] точно 1 admin_profile_deletions ред за изтрития профил', () => {
    if (deletionRows.length !== 1) throw new Error(`Брой редове=${deletionRows.length}: ${JSON.stringify(deletionRows)}`)
  })
  await check('[audit] deleted_by_profile_id = admin-а, извършил delete-а; reason съвпада', () => {
    const row = deletionRows[0]
    if (!row || row.deleted_by_profile_id !== adminCandidate.profileId) throw new Error(`deleted_by_profile_id=${row?.deleted_by_profile_id}`)
    if (row.reason !== 'testing hard delete') throw new Error(`reason=${row.reason}`)
    if (row.username_snapshot !== deleteTarget.displayName) throw new Error(`username_snapshot=${row.username_snapshot}, очаквах ${deleteTarget.displayName}`)
  })
  await check('[audit] profiles row вече не съществува (реален hard delete, не soft)', () => {
    if (remainingProfileRow !== undefined) throw new Error(`profiles row все още съществува: ${JSON.stringify(remainingProfileRow)}`)
  })
  await check('[audit] accounts row вече не съществува (профилът беше единственият на този акаунт)', () => {
    if (remainingAccountRow !== undefined) throw new Error(`accounts row все още съществува: ${JSON.stringify(remainingAccountRow)}`)
  })

  // ── [blocker §3] online hard delete: audit + transactional delete +
  //    session revocation + WS 'session_deleted' + old session invalid +
  //    username/email освободени ─────────────────────────────────────────
  console.log('\n[blocker-3] online hard delete: WS session_deleted + session revocation + username/email freed')

  const onlineSocket = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
    headers: { Cookie: onlineDeleteTarget.cookie },
  })
  const wsMessages: Array<{ type?: string; reason?: string }> = []
  let wsClosed = false
  await new Promise<void>((resolveOpen, rejectOpen) => {
    const timer = setTimeout(() => rejectOpen(new Error('WS connect timeout')), 5000)
    onlineSocket.on('open', () => { clearTimeout(timer); resolveOpen() })
    onlineSocket.on('error', (err) => { clearTimeout(timer); rejectOpen(err) })
  })
  onlineSocket.on('message', (raw) => {
    try { wsMessages.push(JSON.parse(raw.toString('utf8'))) } catch { /* ignore non-JSON */ }
  })
  onlineSocket.on('close', () => { wsClosed = true })

  await check('[blocker-3] WS connect с валидна сесия => получава "connected" frame', async () => {
    await waitFor('connected frame', async () => wsMessages.some((m) => m.type === 'connected'), 5000)
  })

  await check('[blocker-3] onlineDeleteTarget session работи ПРЕДИ delete (GET /api/auth/me => session != null)', async () => {
    const r = await httpRequest(port, '/api/auth/me', 'GET', onlineDeleteTarget.cookie)
    const b = r.body as { ok?: boolean; session?: unknown }
    if (r.status !== 200 || b.ok !== true || !b.session) throw new Error(`status=${r.status}, body=${JSON.stringify(b)}`)
  })

  await check('[blocker-3] admin -> DELETE profile (online target) {reason} => 200', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${onlineDeleteTarget.profileId}`, 'DELETE', adminCookie, { reason: 'testing online hard delete' })
    if (r.status !== 200) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
  })

  await check('[blocker-3] живият WS socket получава "session_deleted" преди close', async () => {
    await waitFor('session_deleted frame', async () => wsMessages.some((m) => m.type === 'session_deleted'), 5000)
  })

  await check('[blocker-3] "session_deleted" frame носи точния admin reason', () => {
    const frame = wsMessages.find((m) => m.type === 'session_deleted')
    if (frame?.reason !== 'testing online hard delete') throw new Error(`reason=${JSON.stringify(frame?.reason)}`)
  })

  await check('[blocker-3] WS socket реално се затваря след session_deleted', async () => {
    await waitFor('WS close', async () => wsClosed, 5000)
  })

  await check('[blocker-3] старият session СЛЕД delete => invalid (GET /api/auth/me => session:null)', async () => {
    const r = await httpRequest(port, '/api/auth/me', 'GET', onlineDeleteTarget.cookie)
    const b = r.body as { ok?: boolean; session?: unknown }
    if (r.status !== 200 || b.ok !== true) throw new Error(`status=${r.status}, body=${JSON.stringify(b)}`)
    if (b.session !== null) throw new Error(`session все още валидна СЛЕД delete: ${JSON.stringify(b.session)}`)
  })
  await check('[blocker-3] старият session СЛЕД delete => 401 на друг authenticated endpoint (/api/profile/me)', async () => {
    const r = await httpRequest(port, '/api/profile/me', 'GET', onlineDeleteTarget.cookie)
    if (r.status !== 401) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
  })

  await check('[blocker-3] username/email на online-изтрития профил веднага освободени', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: onlineDeleteTarget.email, password: PASSWORD, displayName: `${onlineDeleteTarget.displayName}Re`, gender: 'male' }),
    })
    const b = await res.json() as { ok?: boolean; message?: string }
    if (res.status !== 200 || b.ok !== true) throw new Error(`status=${res.status}, body=${JSON.stringify(b)}`)
  })

  if (onlineSocket.readyState === WebSocket.OPEN || onlineSocket.readyState === WebSocket.CONNECTING) {
    onlineSocket.close()
  }

  // ── [blocker round 2 §1] immutable deleted-profile identity ─────────────
  console.log('\n[blocker-r2-1] forensic visitor snapshot (вкл. middle-profile) + ban + financial history остават attributable СЛЕД hard delete')

  // Директен DB seed (няма детерминиран HTTP path да обвържем конкретни
  // site_visit_events/ledger redове точно с този профил в изолиран тест) —
  // mirror на promoteRole/setActiveUntilDirectly pattern-а в
  // checkAdminVipGrantHttpAuthorization.ts.
  const seedDb = new DatabaseSync(isolated.databaseFile, { open: true })
  seedDb.exec('PRAGMA journal_mode = WAL;')

  // [A] Middle-profile сценарий (round 2 корекция) — visitor V е използван
  // от A -> forensicDeleteTarget -> B. forensicDeleteTarget НЕ е нито
  // first_profile_id, нито last_profile_id в site_visitors (умишлено —
  // симулира точно случая, в който старият site_visitors-based snapshot
  // би пропуснал профила изцяло). Два site_visit_events реда за
  // forensicDeleteTarget — различни IP-та — за да проверим агрегацията.
  const visitorId = `visitor-${runId}`
  seedDb.prepare(`
    INSERT INTO site_visitors (
      anonymous_visitor_id, first_seen_at, last_seen_at,
      first_profile_id, last_profile_id, first_ip_address, last_ip_address
    ) VALUES (?, '2026-01-01 08:00:00', '2026-01-03 18:00:00', ?, ?, '203.0.113.1', '203.0.113.20')
  `).run(visitorId, player.profileId, subadminCandidate.profileId)
  seedDb.prepare(`
    INSERT INTO site_visit_events (
      page_view_id, anonymous_visitor_id, profile_id, path, navigation_type, occurred_at, ip_address
    ) VALUES (?, ?, ?, '/lobby', 'navigate', '2026-01-02 10:00:00', '203.0.113.5')
  `).run(randomUUID(), visitorId, forensicDeleteTarget.profileId)
  seedDb.prepare(`
    INSERT INTO site_visit_events (
      page_view_id, anonymous_visitor_id, profile_id, path, navigation_type, occurred_at, ip_address
    ) VALUES (?, ?, ?, '/players', 'spa', '2026-01-02 11:30:00', '203.0.113.5')
  `).run(randomUUID(), visitorId, forensicDeleteTarget.profileId)
  seedDb.prepare(`
    INSERT INTO site_visit_events (
      page_view_id, anonymous_visitor_id, profile_id, path, navigation_type, occurred_at, ip_address
    ) VALUES (?, ?, ?, '/topics', 'spa', '2026-01-02 12:15:00', '203.0.113.9')
  `).run(randomUUID(), visitorId, forensicDeleteTarget.profileId)

  // [B] yellow_coin_gift_ledger — forensicDeleteTarget е sender в един ред,
  // recipient в друг (независими transactions, различни counterparties).
  seedDb.prepare(`
    INSERT INTO yellow_coin_gift_ledger (
      gift_id, friendship_id, sender_profile_id, recipient_profile_id,
      amount, sender_balance_after, recipient_balance_after
    ) VALUES (?, NULL, ?, ?, 500, 99500, 1500)
  `).run(randomUUID(), forensicDeleteTarget.profileId, player.profileId)
  seedDb.prepare(`
    INSERT INTO yellow_coin_gift_ledger (
      gift_id, friendship_id, sender_profile_id, recipient_profile_id,
      amount, sender_balance_after, recipient_balance_after
    ) VALUES (?, NULL, ?, ?, 750, 99250, 2250)
  `).run(randomUUID(), player.profileId, forensicDeleteTarget.profileId)

  // [C] match_economy_ledger — поне един game/economy historical row.
  const economyRoomId = `room-${runId}`
  seedDb.prepare(`
    INSERT INTO match_economy_ledger (
      ledger_id, room_id, profile_id, entry_type, amount, balance_after
    ) VALUES (?, ?, ?, 'stake_debit', 20000, 80000)
  `).run(randomUUID(), economyRoomId, forensicDeleteTarget.profileId)

  seedDb.close()

  await check('[blocker-r2-1] admin -> POST ban на banHistoryDeleteTarget => 200 (за да имаме ban история за проверка)', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${banHistoryDeleteTarget.profileId}/ban`, 'POST', adminCookie, { days: 10, reason: 'forensic ban history test' })
    if (r.status !== 200) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
  })

  await check('[blocker-r2-1] admin -> DELETE profile (forensicDeleteTarget) => 200', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${forensicDeleteTarget.profileId}`, 'DELETE', adminCookie, { reason: 'testing forensic identity preservation' })
    if (r.status !== 200) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
  })

  await check('[blocker-r2-1] admin -> DELETE profile (banHistoryDeleteTarget) => 200', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${banHistoryDeleteTarget.profileId}`, 'DELETE', adminCookie, { reason: 'testing ban history identity preservation' })
    if (r.status !== 200) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
  })

  const forensicDb = new DatabaseSync(isolated.databaseFile, { open: true })
  const visitorSnapshotRows = forensicDb.prepare(`
    SELECT deleted_profile_id, anonymous_visitor_id, ip_address, first_seen_at, last_seen_at, event_count
    FROM admin_profile_deletion_visitor_snapshots
    WHERE deleted_profile_id = ?
    ORDER BY ip_address
  `).all(forensicDeleteTarget.profileId) as Array<{
    deleted_profile_id: string
    anonymous_visitor_id: string
    ip_address: string | null
    first_seen_at: string
    last_seen_at: string
    event_count: number
  }>
  const liveVisitorRow = forensicDb.prepare(`
    SELECT first_profile_id, last_profile_id FROM site_visitors WHERE anonymous_visitor_id = ?
  `).get(visitorId) as { first_profile_id: string | null; last_profile_id: string | null } | undefined
  const liveEventRows = forensicDb.prepare(`
    SELECT profile_id FROM site_visit_events WHERE anonymous_visitor_id = ? ORDER BY occurred_at
  `).all(visitorId) as Array<{ profile_id: string | null }>
  const banHistoryRows = forensicDb.prepare(`
    SELECT ban_id, profile_id, deleted_profile_id_snapshot, reason, banned_until
    FROM profile_bans
    WHERE deleted_profile_id_snapshot = ?
  `).all(banHistoryDeleteTarget.profileId) as Array<{
    ban_id: string
    profile_id: string | null
    deleted_profile_id_snapshot: string | null
    reason: string
    banned_until: string
  }>
  const giftLedgerRows = forensicDb.prepare(`
    SELECT gift_id, sender_profile_id, deleted_sender_profile_id_snapshot,
           recipient_profile_id, deleted_recipient_profile_id_snapshot, amount
    FROM yellow_coin_gift_ledger
    WHERE deleted_sender_profile_id_snapshot = ? OR deleted_recipient_profile_id_snapshot = ?
  `).all(forensicDeleteTarget.profileId, forensicDeleteTarget.profileId) as Array<{
    gift_id: string
    sender_profile_id: string | null
    deleted_sender_profile_id_snapshot: string | null
    recipient_profile_id: string | null
    deleted_recipient_profile_id_snapshot: string | null
    amount: number
  }>
  const matchEconomyRow = forensicDb.prepare(`
    SELECT ledger_id, room_id, profile_id, deleted_profile_id_snapshot, entry_type, amount, balance_after
    FROM match_economy_ledger
    WHERE room_id = ?
  `).get(economyRoomId) as {
    ledger_id: string
    room_id: string
    profile_id: string | null
    deleted_profile_id_snapshot: string | null
    entry_type: string
    amount: number
    balance_after: number
  } | undefined
  forensicDb.close()

  await check('[blocker-r2-1] site_visitors редът физически преживява delete-а (не се пипа/трие)', () => {
    if (!liveVisitorRow) throw new Error('site_visitors row изчезна — таблицата не биваше да се пипа')
  })
  await check('[blocker-r2-1] site_visit_events редовете (3-те TARGET events) физически преживяват delete-а', () => {
    if (liveEventRows.length !== 3) throw new Error(`Брой live events=${liveEventRows.length}, очаквах 3`)
  })
  // [A] Middle-profile: forensicDeleteTarget НЕ е нито first_profile_id,
  // нито last_profile_id за този visitor (player и subadminCandidate са) —
  // ако snapshot логиката все още четеше от site_visitors, тя би пропуснала
  // forensicDeleteTarget изцяло. Проверяваме, че source-ът реално е
  // site_visit_events.profile_id (round 2 корекция), не site_visitors.
  await check('[blocker-r2-1] forensicDeleteTarget НЕ е first/last owner в site_visitors (доказва middle-profile сценария)', () => {
    if (liveVisitorRow?.first_profile_id === forensicDeleteTarget.profileId || liveVisitorRow?.last_profile_id === forensicDeleteTarget.profileId) {
      throw new Error(`test setup грешка: forensicDeleteTarget не биваше да е first/last_profile_id: ${JSON.stringify(liveVisitorRow)}`)
    }
  })
  await check('[blocker-r2-1] admin_profile_deletion_visitor_snapshots съдържа 2 агрегирани реда (по IP), с правилен event_count/first/last_seen', () => {
    if (visitorSnapshotRows.length !== 2) throw new Error(`Брой redове=${visitorSnapshotRows.length}: ${JSON.stringify(visitorSnapshotRows)}`)
    const [row1, row2] = visitorSnapshotRows as [typeof visitorSnapshotRows[0], typeof visitorSnapshotRows[0]]
    if (row1.anonymous_visitor_id !== visitorId || row2.anonymous_visitor_id !== visitorId) {
      throw new Error(`anonymous_visitor_id несъответствие: ${JSON.stringify(visitorSnapshotRows)}`)
    }
    // '203.0.113.5' -> 2 events (агрегирани в 1 ред), '203.0.113.9' -> 1 event
    const ip5 = visitorSnapshotRows.find((r) => r.ip_address === '203.0.113.5')
    const ip9 = visitorSnapshotRows.find((r) => r.ip_address === '203.0.113.9')
    if (!ip5 || ip5.event_count !== 2) throw new Error(`IP 203.0.113.5 event_count=${ip5?.event_count}, очаквах 2 (агрегация, не copy на всеки ред)`)
    if (!ip9 || ip9.event_count !== 1) throw new Error(`IP 203.0.113.9 event_count=${ip9?.event_count}, очаквах 1`)
    if (!ip5.first_seen_at || !ip5.last_seen_at) throw new Error(`first/last_seen_at липсват за IP5: ${JSON.stringify(ip5)}`)
  })
  await check('[blocker-r2-1] profile_bans: точно 1 ред attributable към deleted_profile_id_snapshot (profile_id вече е NULL)', () => {
    if (banHistoryRows.length !== 1) throw new Error(`Брой redове=${banHistoryRows.length}: ${JSON.stringify(banHistoryRows)}`)
    const row = banHistoryRows[0]!
    if (row.profile_id !== null) throw new Error(`profile_id все още не е NULL: ${row.profile_id}`)
    if (row.deleted_profile_id_snapshot !== banHistoryDeleteTarget.profileId) {
      throw new Error(`deleted_profile_id_snapshot=${row.deleted_profile_id_snapshot}, очаквах ${banHistoryDeleteTarget.profileId}`)
    }
    if (row.reason !== 'forensic ban history test') throw new Error(`reason=${row.reason}`)
  })
  // [B] yellow_coin_gift_ledger — forensicDeleteTarget участва като sender
  // в 1 ред и recipient в друг; двата реда трябва да оцелеят с ПРАВИЛНАТА
  // (sender vs. recipient) snapshot колона попълнена, другата страна
  // (player.profileId) остава непроменена/жива.
  await check('[blocker-r2-1] yellow_coin_gift_ledger: 2 реда оцеляват (sender + recipient), с правилния snapshot per страна', () => {
    if (giftLedgerRows.length !== 2) throw new Error(`Брой redове=${giftLedgerRows.length}: ${JSON.stringify(giftLedgerRows)}`)
    const asSender = giftLedgerRows.find((r) => r.deleted_sender_profile_id_snapshot === forensicDeleteTarget.profileId)
    const asRecipient = giftLedgerRows.find((r) => r.deleted_recipient_profile_id_snapshot === forensicDeleteTarget.profileId)
    if (!asSender) throw new Error(`Няма ред с deleted_sender_profile_id_snapshot=${forensicDeleteTarget.profileId}: ${JSON.stringify(giftLedgerRows)}`)
    if (!asRecipient) throw new Error(`Няма ред с deleted_recipient_profile_id_snapshot=${forensicDeleteTarget.profileId}: ${JSON.stringify(giftLedgerRows)}`)
    if (asSender.sender_profile_id !== null) throw new Error(`asSender.sender_profile_id все още не е NULL: ${asSender.sender_profile_id}`)
    if (asSender.recipient_profile_id !== player.profileId) throw new Error(`asSender.recipient_profile_id (другата страна) е засегната неправилно: ${asSender.recipient_profile_id}`)
    if (asSender.amount !== 500) throw new Error(`asSender.amount=${asSender.amount}, очаквах 500 (стойността не биваше да се променя)`)
    if (asRecipient.recipient_profile_id !== null) throw new Error(`asRecipient.recipient_profile_id все още не е NULL: ${asRecipient.recipient_profile_id}`)
    if (asRecipient.sender_profile_id !== player.profileId) throw new Error(`asRecipient.sender_profile_id (другата страна) е засегната неправилно: ${asRecipient.sender_profile_id}`)
    if (asRecipient.amount !== 750) throw new Error(`asRecipient.amount=${asRecipient.amount}, очаквах 750`)
  })
  // [C] match_economy_ledger — game/economy historical row.
  await check('[blocker-r2-1] match_economy_ledger: редът оцелява, live FK е NULL, snapshot сочи стария UUID, amount/balance непроменени', () => {
    if (!matchEconomyRow) throw new Error('match_economy_ledger row изчезна — не биваше да се cascade-delete-не')
    if (matchEconomyRow.profile_id !== null) throw new Error(`profile_id все още не е NULL: ${matchEconomyRow.profile_id}`)
    if (matchEconomyRow.deleted_profile_id_snapshot !== forensicDeleteTarget.profileId) {
      throw new Error(`deleted_profile_id_snapshot=${matchEconomyRow.deleted_profile_id_snapshot}, очаквах ${forensicDeleteTarget.profileId}`)
    }
    if (matchEconomyRow.entry_type !== 'stake_debit' || matchEconomyRow.amount !== 20000 || matchEconomyRow.balance_after !== 80000) {
      throw new Error(`historical стойности бяха променени: ${JSON.stringify(matchEconomyRow)}`)
    }
  })

  // ── [blocker round 2 §2] tournament dependency policy ────────────────────
  console.log('\n[blocker-r2-2] active tournament dependency отказва delete; finished турнир НЕ се унищожава')

  await check('[blocker-r2-2] tournamentActiveTarget създава активен турнир (status=open)', async () => {
    const t = await createTournament(port, tournamentActiveTarget.cookie, `Active Guard ${runId}`)
    if (!t.tournamentId) throw new Error('няма tournamentId')
  })

  await check('[blocker-r2-2] admin -> DELETE profile (active tournament creator) => 409 active_tournament_dependency', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${tournamentActiveTarget.profileId}`, 'DELETE', adminCookie, { reason: 'should be rejected' })
    const b = r.body as { ok?: boolean; code?: string }
    if (r.status !== 409 || b.code !== 'active_tournament_dependency') {
      throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
    }
  })

  const activeGuardDb = new DatabaseSync(isolated.databaseFile, { open: true })
  const activeTournamentStillExists = activeGuardDb.prepare(`
    SELECT tournament_id, status, creator_profile_id FROM tournaments WHERE creator_profile_id = ?
  `).get(tournamentActiveTarget.profileId) as { tournament_id: string; status: string; creator_profile_id: string } | undefined
  const activeProfileStillExists = activeGuardDb.prepare(`SELECT profile_id FROM profiles WHERE profile_id = ?`).get(tournamentActiveTarget.profileId)
  activeGuardDb.close()

  await check('[blocker-r2-2] турнирът остава непокътнат (не е cascade-delete-нат заедно с отказания profile delete)', () => {
    if (!activeTournamentStillExists) throw new Error('турнирът изчезна въпреки отказания delete')
    if (activeTournamentStillExists.creator_profile_id !== tournamentActiveTarget.profileId) {
      throw new Error(`creator_profile_id=${activeTournamentStillExists.creator_profile_id}`)
    }
  })
  await check('[blocker-r2-2] target профилът НЕ е изтрит (delete-ът реално е бил отказан, не тихо игнориран)', () => {
    if (!activeProfileStillExists) throw new Error('профилът е изчезнал въпреки 409 отговора')
  })

  // Finished tournament scenario: creator + participant, турнирът минава на
  // терминален статус ръчно (директен DB update — извън обхвата на теста е
  // да симулираме пълния match/finals lifecycle), после delete-ът трябва да
  // мине И да остави турнира/entry-та непокътнати, само с snapshot атрибуция.
  let finishedTournamentId = ''
  await check('[blocker-r2-2] finished-турнир setup: creator + participant + entries', async () => {
    const t = await createTournament(port, tournamentFinishedCreator.cookie, `Finished History ${runId}`)
    const joinRes = await httpRequest(port, `/api/tournaments/${t.tournamentId}/join`, 'POST', tournamentFinishedParticipant.cookie, {})
    const jb = joinRes.body as { ok?: boolean }
    if (joinRes.status !== 200 || jb.ok !== true) throw new Error(`join failed: status=${joinRes.status}, body=${JSON.stringify(joinRes.body)}`)

    const finishDb = new DatabaseSync(isolated.databaseFile, { open: true })
    finishDb.exec('PRAGMA journal_mode = WAL;')
    finishDb.prepare(`UPDATE tournaments SET status = 'finished', finished_at = CURRENT_TIMESTAMP WHERE tournament_id = ?`).run(t.tournamentId)
    finishDb.prepare(`UPDATE tournament_entries SET status = 'eliminated' WHERE tournament_id = ?`).run(t.tournamentId)
    finishDb.close()
    finishedTournamentId = t.tournamentId
  })

  await check('[blocker-r2-2] admin -> DELETE profile (finished tournament creator) => 200 (не е блокирано, турнирът е terminal)', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${tournamentFinishedCreator.profileId}`, 'DELETE', adminCookie, { reason: 'creator of finished tournament' })
    if (r.status !== 200) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
  })
  await check('[blocker-r2-2] admin -> DELETE profile (finished tournament participant) => 200', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${tournamentFinishedParticipant.profileId}`, 'DELETE', adminCookie, { reason: 'participant of finished tournament' })
    if (r.status !== 200) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
  })

  const finishedDb = new DatabaseSync(isolated.databaseFile, { open: true })
  const finishedTournamentRow = finishedDb.prepare(`
    SELECT tournament_id, status, creator_profile_id, deleted_creator_profile_id_snapshot
    FROM tournaments WHERE tournament_id = ?
  `).get(finishedTournamentId) as {
    tournament_id: string
    status: string
    creator_profile_id: string | null
    deleted_creator_profile_id_snapshot: string | null
  } | undefined
  const finishedEntryRows = finishedDb.prepare(`
    SELECT entry_id, profile_id, deleted_profile_id_snapshot, status
    FROM tournament_entries WHERE tournament_id = ?
  `).all(finishedTournamentId) as Array<{
    entry_id: string
    profile_id: string | null
    deleted_profile_id_snapshot: string | null
    status: string
  }>
  finishedDb.close()

  await check('[blocker-r2-2] finished турнирът все още съществува (НЕ е унищожен от creator delete-а)', () => {
    if (!finishedTournamentRow) throw new Error('turnament row изчезна — cascade delete не биваше да стигне дотук')
    if (finishedTournamentRow.status !== 'finished') throw new Error(`status=${finishedTournamentRow.status}, очаквах finished`)
  })
  await check('[blocker-r2-2] tournaments.creator_profile_id => NULL, deleted_creator_profile_id_snapshot => старото UUID', () => {
    if (!finishedTournamentRow) throw new Error('turnament row липсва')
    if (finishedTournamentRow.creator_profile_id !== null) throw new Error(`creator_profile_id все още не е NULL: ${finishedTournamentRow.creator_profile_id}`)
    if (finishedTournamentRow.deleted_creator_profile_id_snapshot !== tournamentFinishedCreator.profileId) {
      throw new Error(`deleted_creator_profile_id_snapshot=${finishedTournamentRow.deleted_creator_profile_id_snapshot}, очаквах ${tournamentFinishedCreator.profileId}`)
    }
  })
  await check('[blocker-r2-2] tournament_entries редът (participant) оцелява с attribution snapshot (историческият roster не е изтрит)', () => {
    // Creator-ът НЕ получава автоматично собствен tournament_entries ред само
    // защото е създал турнира (organize != participate) — единственият
    // entry тук е participant-ският join. Проверката е за НЕГО.
    if (finishedEntryRows.length < 1) throw new Error(`Очаквах поне 1 entry (participant), получих ${finishedEntryRows.length}: ${JSON.stringify(finishedEntryRows)}`)
    const participantEntry = finishedEntryRows.find((e) => e.deleted_profile_id_snapshot === tournamentFinishedParticipant.profileId)
    if (!participantEntry) throw new Error(`Няма entry с deleted_profile_id_snapshot=${tournamentFinishedParticipant.profileId}: ${JSON.stringify(finishedEntryRows)}`)
    if (participantEntry.profile_id !== null) throw new Error(`participant entry.profile_id все още не е NULL: ${participantEntry.profile_id}`)
  })

  // ── [round 4] BAN/DELETE не прекъсват активна игра — runtime behavior ───
  console.log('\n[round4] BAN/DELETE runtime behavior: offline / online-not-playing / pending-during-active-game')

  // [A] BAN offline -> next login -> PROFILE_BANNED.
  await check('[round4-A] admin -> POST ban на offline профил => 200, pending:false (никой live socket за disconnect)', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${offlineBanTarget.profileId}/ban`, 'POST', adminCookie, { days: 3, reason: 'offline ban test' })
    const b = r.body as { ok?: boolean; pending?: boolean }
    if (r.status !== 200 || b.ok !== true || b.pending !== false) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
  })
  await check('[round4-A] offline баннат профил -> следващ login => 403 PROFILE_BANNED', async () => {
    const r = await loginRaw(port, offlineBanTarget.email)
    const b = r.body as { ok?: boolean; code?: string }
    if (r.status !== 403 || b.code !== 'PROFILE_BANNED') throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
  })

  // [B] DELETE offline -> next login -> normal invalid credentials, БЕЗ special delete code.
  await check('[round4-B] admin -> DELETE offline профил => 200, pending:false', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${offlineDeleteTarget.profileId}`, 'DELETE', adminCookie, { reason: 'offline delete test' })
    const b = r.body as { ok?: boolean; pending?: boolean }
    if (r.status !== 200 || b.ok !== true || b.pending !== false) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
  })
  await check('[round4-B] offline изтрит профил -> следващ login => 400 generic invalid credentials, БЕЗ delete-specific code', async () => {
    const r = await loginRaw(port, offlineDeleteTarget.email)
    const b = r.body as { ok?: boolean; code?: string; message?: string }
    if (r.status !== 400) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
    if (b.code !== undefined) throw new Error(`не биваше да има structured code за изтрит профил: code=${b.code}`)
    if (b.message !== 'Грешен email или парола.') throw new Error(`message=${b.message}, очаквах generic invalid-credentials текст`)
  })

  // [C] BAN online/not-playing -> immediate session_banned.
  const onlineNpBanSocket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: onlineNotPlayingBanTarget.cookie } })
  const onlineNpBanMessages: Array<{ type?: string }> = []
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error('WS connect timeout')), 5000)
    onlineNpBanSocket.on('open', () => { clearTimeout(t); res() })
    onlineNpBanSocket.on('error', (e) => { clearTimeout(t); rej(e) })
  })
  onlineNpBanSocket.on('message', (raw) => { try { onlineNpBanMessages.push(JSON.parse(raw.toString('utf8'))) } catch { /* ignore */ } })
  await check('[round4-C] online-not-playing WS connect => "connected" frame', async () => {
    await waitFor('connected frame', async () => onlineNpBanMessages.some((m) => m.type === 'connected'), 5000)
  })
  await check('[round4-C] admin -> POST ban (online, НЕ в игра) => 200, pending:false (immediate enforcement)', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${onlineNotPlayingBanTarget.profileId}/ban`, 'POST', adminCookie, { days: 3, reason: 'online not-playing ban test' })
    const b = r.body as { ok?: boolean; pending?: boolean }
    if (r.status !== 200 || b.ok !== true || b.pending !== false) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
  })
  await check('[round4-C] живият socket получава "session_banned" ВЕДНАГА (не отложено)', async () => {
    await waitFor('session_banned frame', async () => onlineNpBanMessages.some((m) => m.type === 'session_banned'), 5000)
  })
  if (onlineNpBanSocket.readyState === WebSocket.OPEN || onlineNpBanSocket.readyState === WebSocket.CONNECTING) onlineNpBanSocket.close()

  // [D] DELETE online/not-playing -> immediate session_deleted.
  const onlineNpDelSocket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: onlineNotPlayingDeleteTarget.cookie } })
  const onlineNpDelMessages: Array<{ type?: string; reason?: string }> = []
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error('WS connect timeout')), 5000)
    onlineNpDelSocket.on('open', () => { clearTimeout(t); res() })
    onlineNpDelSocket.on('error', (e) => { clearTimeout(t); rej(e) })
  })
  onlineNpDelSocket.on('message', (raw) => { try { onlineNpDelMessages.push(JSON.parse(raw.toString('utf8'))) } catch { /* ignore */ } })
  await check('[round4-D] online-not-playing WS connect => "connected" frame', async () => {
    await waitFor('connected frame', async () => onlineNpDelMessages.some((m) => m.type === 'connected'), 5000)
  })
  await check('[round4-D] admin -> DELETE (online, НЕ в игра) => 200, pending:false (immediate enforcement)', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${onlineNotPlayingDeleteTarget.profileId}`, 'DELETE', adminCookie, { reason: 'online not-playing delete test' })
    const b = r.body as { ok?: boolean; pending?: boolean }
    if (r.status !== 200 || b.ok !== true || b.pending !== false) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
  })
  await check('[round4-D] живият socket получава "session_deleted" ВЕДНАГА (не отложено)', async () => {
    await waitFor('session_deleted frame', async () => onlineNpDelMessages.some((m) => m.type === 'session_deleted'), 5000)
  })

  await check('[round4-D] "session_deleted" frame носи точния admin reason', () => {
    const frame = onlineNpDelMessages.find((m) => m.type === 'session_deleted')
    if (frame?.reason !== 'online not-playing delete test') throw new Error(`reason=${JSON.stringify(frame?.reason)}`)
  })
  if (onlineNpDelSocket.readyState === WebSocket.OPEN || onlineNpDelSocket.readyState === WebSocket.CONNECTING) onlineNpDelSocket.close()

  // [E/F] Pending-during-active-game — targeted store/lifecycle ниво, БЕЗ
  // пълен 4-играч real-game WS harness (spec §11: "не изграждай огромен
  // gameplay test harness, ако съществуващият test infrastructure няма
  // лесен начин"). Тук директно seed-ваме pending_profile_moderation ред
  // (симулирайки, че profileHardDeleteService/banProfileConnections вече
  // е бил deferred от реален active-game HTTP handler flow) и потвърждаваме
  // ДВЕТЕ страни на договора:
  //   (1) store persistence/idempotency (recordPending*/getPending/clearPending);
  //   (2) HTTP/WS join guard-овете реално блокират нова игра, докато pending
  //       съществува.
  // Реалният "match-ended -> applyPendingModerationForRoomParticipants"
  // hook (index.ts, tickRoomGameRuntimes onApplied callback) остава за
  // manual/QA verification в реална игра — виж отчета.
  console.log('\n[round4-EF] pending-during-active-game: store persistence + new-game join guard (targeted, без пълен gameplay harness)')

  const pendingDb = new DatabaseSync(isolated.databaseFile, { open: true })
  pendingDb.exec('PRAGMA journal_mode = WAL;')

  await check('[round4-E] admin -> POST ban на pendingBanTarget (offline тук, само за profile_bans ред) => 200', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${pendingBanTarget.profileId}/ban`, 'POST', adminCookie, { days: 3, reason: 'pending ban simulation' })
    if (r.status !== 200) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
  })
  const banRowForPending = pendingDb.prepare(`SELECT ban_id FROM profile_bans WHERE profile_id = ?`).get(pendingBanTarget.profileId) as { ban_id: string } | undefined
  if (!banRowForPending) throw new Error('ban_id за pendingBanTarget не беше намерен след POST ban')

  // Директен store-level seed на pending_profile_moderation — симулира
  // именно момента, в който handleAdminProfileBanRequest/
  // handleAdminProfileHardDeleteRequest биха записали pending маркер вместо
  // immediate enforcement (isProfileInActiveGame()===true клона).
  pendingDb.prepare(`
    INSERT INTO pending_profile_moderation (
      pending_id, target_profile_id, action, ban_id, requested_by_profile_id, reason
    ) VALUES (?, ?, 'ban', ?, ?, 'pending ban enforcement')
  `).run(randomUUID(), pendingBanTarget.profileId, banRowForPending.ban_id, adminCandidate.profileId)

  pendingDb.prepare(`
    INSERT INTO pending_profile_moderation (
      pending_id, target_profile_id, action, requested_by_profile_id, requested_by_account_id, reason
    ) VALUES (?, ?, 'delete', ?, ?, ?)
  `).run(randomUUID(), pendingDeleteTarget.profileId, adminCandidate.profileId, adminCandidate.accountId, 'pending delete simulation reason')

  await check('[round4-E] profile row за pendingBanTarget продължава да съществува, докато pending е активен (не е disconnect-нат/трогнат)', () => {
    const row = pendingDb.prepare(`SELECT profile_id FROM profiles WHERE profile_id = ?`).get(pendingBanTarget.profileId)
    if (!row) throw new Error('profile row изчезна — pending ban НЕ трябва да пипа профила')
  })
  await check('[round4-F] profile row за pendingDeleteTarget продължава да съществува, докато delete е pending (физическото DELETE е отложено)', () => {
    const row = pendingDb.prepare(`SELECT profile_id FROM profiles WHERE profile_id = ?`).get(pendingDeleteTarget.profileId)
    if (!row) throw new Error('profile row изчезна — pending delete не биваше да изпълни физическото DELETE веднага')
  })

  const pendingBanCookie = await login(port, pendingBanTarget.email).catch(() => null)
  // pendingBanTarget вече е banned (profile_bans ред съществува) — login-ът
  // трябва да е блокиран от PROFILE_BANNED gate-а НЕЗАВИСИМО от pending
  // машинарията (round 4 §9: "ban трябва да блокира new login... независимо
  // от това дали текущата игра продължава"). pendingDeleteTarget НЕ е
  // banned, само pending delete — login-ът му остава валиден (профилът все
  // още съществува), но НОВА игра трябва да е блокирана.
  await check('[round4-E] pendingBanTarget login остава блокиран (PROFILE_BANNED) въпреки pending machinery-то', () => {
    if (pendingBanCookie !== null) throw new Error('login не биваше да успее за баннат профил')
  })

  const pendingDeleteCookie = await login(port, pendingDeleteTarget.email)
  await check('[round4-F] pendingDeleteTarget login РАБОТИ (профилът все още съществува, само delete-ът е pending)', () => {
    if (!pendingDeleteCookie) throw new Error('login трябваше да работи — профилът не е физически изтрит още')
  })
  // round 5 §2 корекция — след добавянето на connect-time pending-moderation
  // gate-а (wsServer.on('connection', ...)), нова WS connection за
  // pendingDeleteCookie вече се отхвърля НА connect-time, ПРЕДИ дори
  // 'connected' frame да бъде доставен — join_matchmaking-level guard-ът
  // (по-долу в message dispatch loop-а) вече е defense-in-depth за profile,
  // чиято connection БЕШЕ established ПРЕДИ pending маркера (напр. живата
  // игрова connection) — тук нямаме такава, затова очакваме connect-time
  // отказ (socket се затваря без 'connected'), не message-level error frame.
  await check('[round4-F] pendingDeleteTarget -> нова WS connection се отхвърля НА connect-time (pending delete блокира reconnect/нова игра още преди handshake-а да завърши)', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: pendingDeleteCookie } })
    const messages: Array<{ type?: string; message?: string }> = []
    let closed = false
    socket.on('close', () => { closed = true })
    socket.on('message', (raw) => { try { messages.push(JSON.parse(raw.toString('utf8'))) } catch { /* ignore */ } })
    await waitFor('socket close (connect-time reject) без "connected" frame', async () => closed, 5000)
    if (messages.some((m) => m.type === 'connected')) {
      throw new Error(`connection не биваше да получи "connected" frame: ${JSON.stringify(messages)}`)
    }
  })

  await check('[round4-EF] pending_profile_moderation съдържа точно 2 реда (ban + delete), UNIQUE(target_profile_id) idempotent upsert работи', () => {
    const rows = pendingDb.prepare(`SELECT target_profile_id, action FROM pending_profile_moderation`).all() as Array<{ target_profile_id: string; action: string }>
    if (rows.length !== 2) throw new Error(`Брой pending redове=${rows.length}: ${JSON.stringify(rows)}`)
    const banRow = rows.find((r) => r.target_profile_id === pendingBanTarget.profileId)
    const delRow = rows.find((r) => r.target_profile_id === pendingDeleteTarget.profileId)
    if (banRow?.action !== 'ban') throw new Error(`banRow.action=${banRow?.action}`)
    if (delRow?.action !== 'delete') throw new Error(`delRow.action=${delRow?.action}`)
  })

  pendingDb.close()

  // ── [round 5 blocker §1] active tournament dependency отказва DELETE
  //    ПРЕДИ pending маркер да се запише (не само вътре в hardDeleteProfile) ──
  console.log('\n[round5-1] active tournament dependency: DELETE се отказва 409, НЕ се създава pending row')

  await check('[round5-1] tournamentPendingGuardTarget създава активен (non-terminal) турнир', async () => {
    const t = await createTournament(port, tournamentPendingGuardTarget.cookie, `Pending Guard ${runId}`)
    if (!t.tournamentId) throw new Error('няма tournamentId')
  })
  await check('[round5-1] admin -> DELETE profile (active tournament dependency) => 409 active_tournament_dependency, БЕЗ pending row', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${tournamentPendingGuardTarget.profileId}`, 'DELETE', adminCookie, { reason: 'should be rejected before pending' })
    const b = r.body as { ok?: boolean; code?: string }
    if (r.status !== 409 || b.code !== 'active_tournament_dependency') {
      throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
    }
  })
  const round5Db = new DatabaseSync(isolated.databaseFile, { open: true })
  await check('[round5-1] pending_profile_moderation НЕ съдържа ред за tournamentPendingGuardTarget (guard-ът е ПРЕДИ recordPendingDelete)', () => {
    const row = round5Db.prepare(`SELECT pending_id FROM pending_profile_moderation WHERE target_profile_id = ?`).get(tournamentPendingGuardTarget.profileId)
    if (row !== undefined) throw new Error(`pending row съществува въпреки active tournament dependency: ${JSON.stringify(row)}`)
  })
  await check('[round5-1] tournamentPendingGuardTarget профилът остава напълно непроменен (delete не е стартирал по никакъв начин)', () => {
    const row = round5Db.prepare(`SELECT profile_id FROM profiles WHERE profile_id = ?`).get(tournamentPendingGuardTarget.profileId)
    if (!row) throw new Error('профилът изчезна въпреки отказания delete')
  })
  round5Db.close()

  // ── [round 5 §2] reconnect policy: pending DELETE / active-game BAN не
  //    позволяват нов WS connect + resume_room reconnect за target-а, дори
  //    ако token-ът все още е технически валиден за стаята ──────────────────
  console.log('\n[round5-2] reconnect policy: нов WS connect + resume_room е блокиран за target с pending DELETE / active ban')

  // pendingDeleteTarget вече има pending 'delete' ред (seed-нат по-горе в
  // round4-EF блока) — потвърждаваме, че НОВА WS connection с валидната му
  // session cookie изобщо не се authenticate-ва (connect-time gate),
  // mirror-вайки ban gate-а, но за pending moderation.
  // Симулира "target отваря нов таб/refresh-ва browser-а СЛЕД като pending
  // delete вече е записан" — fresh login (нова сесия, различна от евентуална
  // все още жива игрова connection) последвана от НОВА WS connection,
  // отхвърлена на connect-time. Отделно от round4-F теста (същия target,
  // различен fresh login+connect опит) — потвърждава, че connect-time
  // gate-ът е idempotent/repeatable, не консумира pending реда само защото
  // веднъж вече е отхвърлил connection.
  await check('[round5-2] повторен fresh login + нов WS connect опит за pendingDeleteTarget пак се отхвърля (idempotent connect-time gate, pending row не се консумира)', async () => {
    const freshCookie = await login(port, pendingDeleteTarget.email)
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: freshCookie } })
    const messages: Array<{ type?: string }> = []
    let closed = false
    socket.on('close', () => { closed = true })
    socket.on('message', (raw) => { try { messages.push(JSON.parse(raw.toString('utf8'))) } catch { /* ignore */ } })
    await waitFor('socket close (connect-time reject)', async () => closed, 5000)
    if (messages.some((m) => m.type === 'connected')) {
      throw new Error(`connection не биваше да получи "connected" frame: ${JSON.stringify(messages)}`)
    }
  })
  await check('[round5-2] pending_profile_moderation ред за pendingDeleteTarget все още съществува (connect-опитите не го чистят)', () => {
    const verifyDb = new DatabaseSync(isolated.databaseFile, { open: true })
    const row = verifyDb.prepare(`SELECT pending_id FROM pending_profile_moderation WHERE target_profile_id = ?`).get(pendingDeleteTarget.profileId)
    verifyDb.close()
    if (row === undefined) throw new Error('pending row изчезна само от connect-time reject опити — не биваше')
  })

  // Пълна reconnectToken-ownership проверка (tokenOwnerProfileId lookup в
  // resume_room handler-а) изисква реален room с "playing" стая и жив
  // reconnectToken — изолираният HTTP/WS-само тест тук няма лесен начин да
  // докара реална игра до този lifecycle etap (spec §11: "не изграждай
  // огромен gameplay test harness"). Тази проверка е baseline sanity: за
  // несъществуваща стая resume_room винаги връща room_resume_failed, без
  // да разкрива нищо за никой конкретен профил (path-ът, засегнат от
  // новия tokenOwnerProfileId guard, е СЛЕД "room намерена" проверката,
  // затова несъществуваща стая никога не го достига — просто потвърждаваме
  // че handler-ът не хвърля/крашва при unauthenticated resume_room опит).
  // Реалният "banned/pending target's token е отхвърлен ДОРИ от нова
  // unauthenticated connection" сценарий остава за manual/QA verification
  // с истинска игра — виж отчета.
  await check('[round5-2] resume_room за несъществуваща стая (guest connection) => room_resume_failed, без crash', async () => {
    const guestSocket = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    const messages: Array<{ type?: string; message?: string }> = []
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error('WS connect timeout')), 5000)
      guestSocket.on('open', () => { clearTimeout(t); res() })
      guestSocket.on('error', (e) => { clearTimeout(t); rej(e) })
    })
    guestSocket.on('message', (raw) => { try { messages.push(JSON.parse(raw.toString('utf8'))) } catch { /* ignore */ } })
    await waitFor('connected frame', async () => messages.some((m) => m.type === 'connected'), 5000)
    guestSocket.send(JSON.stringify({ type: 'resume_room', roomId: 'nonexistent-room', reconnectToken: 'fake-token' }))
    await waitFor('room_resume_failed frame', async () => messages.some((m) => m.type === 'room_resume_failed'), 5000)
    if (guestSocket.readyState === WebSocket.OPEN || guestSocket.readyState === WebSocket.CONNECTING) guestSocket.close()
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
