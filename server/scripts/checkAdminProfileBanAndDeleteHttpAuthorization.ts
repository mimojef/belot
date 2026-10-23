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
 *  - [Етап 4F2A] реалният HTTP път с ВКЛЮЧЕНА offsite защита в изолиран
 *    регистър: DELETE -> "насрочено" (съответства на състоянието) ->
 *    контролиран ack (същия формат като backup-а) -> runner -> одит, файлова
 *    фаза done, регистър без дублиране; липсващ/невалиден ack -> нищо не се
 *    изтрива; само role===admin (subadmin/pika_team/marketing/top_chat_admin/
 *    player/guest/отнета роля -> 403, без висящ ред и без запис в регистъра)
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { cp, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { WebSocket } from 'ws'
import { join, resolve } from 'node:path'
import { verifyVerificationCode } from '../src/db/authHelpers.js'
import {
  getProfileDeletionLedgerOffsiteAckPath,
  isProfileDeletionLedgerRecordConfirmedOffsite,
  readProfileDeletionLedger,
  writeProfileDeletionLedgerOffsiteAck,
  type ProfileDeletionLedgerOffsiteAck,
} from '../src/db/profileDeletionLedger.js'

const PASSWORD = 'BanDeleteSmoke1!'
const SERVER_READY_TIMEOUT_MS = 30_000
// Email verification pending-first flow (виж authStore.ts's register() doc
// коментар) — тестова HMAC secret стойност (≥32 символа), подадена на
// spawned сървъра чрез PASSWORD_RESET_RATE_LIMIT_SECRET fallback — register()
// по-долу brute-force-ва 6-цифрения код от DB-съхранения code_hash вместо
// реален Brevo (недостъпен в тестова среда).
const TEST_REGISTRATION_SECRET = 'ban-delete-http-authorization-test-secret-01'

/**
 * Test isolation helper — исторически (registration anti-evasion gate,
 * премахнат, виж authStore.ts's register() doc коментар) споделен IP между
 * сценарии би блокирал следващи регистрации, докато "IP + ACTIVE
 * moderation" policy-то съществуваше; вече не е така (виж
 * checkOpenRegistrationPolicy.ts — registration вече НЕ се отказва заради
 * IP история). Уникалните synthetic IP-та тук остават просто за общ test
 * isolation/reproducibility hygiene (детерминиран, monotonically-increasing
 * generator, reproducible между run-ове), не заради active policy
 * constraint.
 *
 * Цикли през трите reserved TEST-NET range-а (RFC 5737: 192.0.2.0/24,
 * 198.51.100.0/24, 203.0.113.0/24) вместо произволни public IP адреси.
 */
const TEST_NET_RANGES = ['203.0.113', '198.51.100', '192.0.2'] as const
let syntheticIpCounter = 0
function nextSyntheticTestIp(): string {
  syntheticIpCounter += 1
  const zeroBased = syntheticIpCounter - 1
  const rangePrefix = TEST_NET_RANGES[Math.floor(zeroBased / 254) % TEST_NET_RANGES.length]!
  const octet = (zeroBased % 254) + 1
  return `${rangePrefix}.${octet}`
}

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

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
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
  ledgerPath: string
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
    // Етап 4F2A — изолиран регистър на изтриванията (временна директория).
    ledgerPath: join(root, 'deletion-ledger', 'profile-deletions.jsonl'),
    cleanup: async () => { await rm(root, { recursive: true, force: true }) },
  }
}

function startServer(serverDir: string, port: number, ledgerPath: string): RunningServer {
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
        PASSWORD_RESET_RATE_LIMIT_SECRET: TEST_REGISTRATION_SECRET,
        // Етап 4F2A — реалната offsite защита остава ВКЛЮЧЕНА (изрично, без
        // значение от наследената среда); тестът сам играе ролята на backup-а,
        // който записва ack (confirmLedgerOffsite). Само runner-ът е по-чест.
        PROFILE_DELETION_LEDGER_PATH: ledgerPath,
        PROFILE_DELETION_LEDGER_OFFSITE_REQUIRED: '1',
        ADMIN_PROFILE_DELETION_RUNNER_INTERVAL_MS: '250',
        ADMIN_PROFILE_DELETION_RUNNER_STARTUP_DELAY_MS: '250',
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

/**
 * Етап 4F2A — контролирано тестово offsite потвърждение. Записва ack файла
 * точно както backup скриптът (ops/pikabg-backup/scripts/pikabg-ledger-backup):
 * брой байтове + SHA-256 на потвърдения префикс на регистъра. Сървърът го
 * проверява със СЪЩИЯ production код (isProfileDeletionLedgerRecordConfirmedOffsite)
 * — нищо не се заобикаля. `tamper` създава умишлено невалиден ack.
 */
function confirmLedgerOffsite(ledgerPath: string, tamper: 'none' | 'wrong_sha' | 'truncated' = 'none'): void {
  const buffer = readFileSync(ledgerPath)
  const parsed = readProfileDeletionLedger(ledgerPath)
  const confirmed = tamper === 'truncated' ? buffer.subarray(0, buffer.length - 1) : buffer
  const ack: ProfileDeletionLedgerOffsiteAck = {
    v: 1,
    bytes: confirmed.length,
    sha256: tamper === 'wrong_sha' ? '0'.repeat(64) : createHash('sha256').update(confirmed).digest('hex'),
    lineCount: parsed.lineCount,
    entryCount: parsed.records.length,
    remotePath: 'test-offsite:/belot-ban-delete-smoke/profile-deletions.jsonl',
    confirmedAt: new Date().toISOString(),
  }
  // Windows: atomic rename-ът върху ack файла може да получи EPERM/EBUSY,
  // докато runner-ът на сървъра го чете в същия момент — кратък повторен опит.
  for (let attempt = 1; ; attempt++) {
    try {
      writeProfileDeletionLedgerOffsiteAck(getProfileDeletionLedgerOffsiteAckPath(ledgerPath), ack)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (attempt >= 20 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
    }
  }
}

/** Записите в регистъра за една административна операция (по вид). */
function countAdminLedgerRecords(ledgerPath: string, operationId: string): { intent: number; completed: number } {
  const records = readProfileDeletionLedger(ledgerPath).records as unknown as Array<{ kind?: string; operationId?: string }>
  return {
    intent: records.filter((r) => r.kind === 'admin_delete_intent' && r.operationId === operationId).length,
    completed: records.filter((r) => r.kind === 'admin_delete_completed' && r.operationId === operationId).length,
  }
}

type AdminDeletionDbState = {
  profileExists: boolean
  pendingOperationId: string | null
  pendingRequestedBy: string | null
  pendingReason: string | null
  auditFileCleanupStatus: string | null | undefined
}

function readAdminDeletionDbState(databaseFile: string, profileId: string, operationId: string | null): AdminDeletionDbState {
  const db = new DatabaseSync(databaseFile, { open: true })
  try {
    const pending = db.prepare(`
      SELECT ledger_operation_id, requested_by_profile_id, reason FROM pending_profile_moderation
      WHERE target_profile_id = ? AND action = 'delete'
    `).get(profileId) as { ledger_operation_id: string | null; requested_by_profile_id: string | null; reason: string } | undefined
    const audit = operationId === null
      ? undefined
      : db.prepare(`SELECT file_cleanup_status FROM admin_profile_deletions WHERE log_id = ?`).get(operationId) as { file_cleanup_status: string | null } | undefined
    return {
      profileExists: db.prepare(`SELECT 1 FROM profiles WHERE profile_id = ?`).get(profileId) !== undefined,
      pendingOperationId: pending?.ledger_operation_id ?? null,
      pendingRequestedBy: pending?.requested_by_profile_id ?? null,
      pendingReason: pending?.reason ?? null,
      auditFileCleanupStatus: audit === undefined ? undefined : audit.file_cleanup_status,
    }
  } finally {
    db.close()
  }
}

type RegisteredUser = { cookie: string; profileId: string; accountId: string; email: string; displayName: string }

/** Brute-force-ва 6-цифрения verification код от pending_registrations.code_hash (mirror на checkOpenRegistrationPolicy.ts's аналогична helper). */
function bruteForceVerificationCode(databaseFile: string, pendingRegistrationId: string): string {
  const db = new DatabaseSync(databaseFile)
  const row = db.prepare(`SELECT code_hash FROM pending_registrations WHERE pending_registration_id = ?`).get(pendingRegistrationId) as
    | { code_hash: string }
    | undefined
  db.close()
  if (!row) throw new Error(`pending_registrations row not found: ${pendingRegistrationId}`)
  for (let candidate = 0; candidate < 1_000_000; candidate++) {
    const code = candidate.toString().padStart(6, '0')
    if (verifyVerificationCode(code, TEST_REGISTRATION_SECRET, row.code_hash)) return code
  }
  throw new Error(`Не успях да brute-force-на verification кода за ${pendingRegistrationId}`)
}

/**
 * Email verification pending-first flow (виж authStore.ts's register() doc
 * коментар) — register() вече само създава pending_registrations ред;
 * verify-registration-email() материализира реалния account/profile/session.
 * Тестовата среда няма реален Brevo достъп, затова brute-force-ваме кода.
 */
async function register(port: number, databaseFile: string, runId: string, suffix: string): Promise<RegisteredUser> {
  const email = `ban-delete-smoke-${runId}-${suffix}@example.test`
  const displayName = `BanSmoke${runId.replace(/[^0-9]/g, '').slice(-6)}${suffix}`
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Test isolation — виж nextSyntheticTestIp doc коментара по-горе.
      'X-Forwarded-For': nextSyntheticTestIp(),
    },
    // visitorId: authStore.ts::register() изисква valid UUID-формат visitor
    // identity (стандартна tracking validation, виж register()'s doc
    // коментар) — несвързано с ban/delete логиката, тествана тук, но
    // задължително за да не се отхвърли заявката с 400.
    body: JSON.stringify({ email, password: PASSWORD, displayName, gender: 'male', visitorId: randomUUID() }),
  })
  const registerPayload = await res.json().catch(() => null) as { pendingRegistrationId?: string; message?: string } | null
  const pendingRegistrationId = registerPayload?.pendingRegistrationId
  if (typeof pendingRegistrationId !== 'string' || pendingRegistrationId === '') {
    throw new Error(`Регистрацията (${suffix}) не създаде pending registration: status=${res.status} ${JSON.stringify(registerPayload)}`)
  }

  const code = bruteForceVerificationCode(databaseFile, pendingRegistrationId)
  // bruteForceVerificationCode блокира Node event loop-а синхронно — на
  // бавни/натоварени machines това понякога кара keep-alive connection-а
  // към spawned сървъра да стане stale ("fetch failed"/ECONNRESET) — един
  // бърз retry е достатъчен.
  let verifyRes: Response
  try {
    verifyRes = await fetch(`http://127.0.0.1:${port}/api/auth/verify-registration-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pendingRegistrationId, code, rememberMe: true }),
    })
  } catch {
    await new Promise((r) => setTimeout(r, 200))
    verifyRes = await fetch(`http://127.0.0.1:${port}/api/auth/verify-registration-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pendingRegistrationId, code, rememberMe: true }),
    })
  }
  if (verifyRes.status !== 200) throw new Error(`Верификацията (${suffix}) върна status ${verifyRes.status}.`)
  const payload = await verifyRes.json() as { ok?: boolean; session?: { profile: { profileId: string }; account: { accountId: string } }; message?: string }
  if (!payload.ok || !payload.session) throw new Error(`Верификацията (${suffix}) не е успешна: ${payload.message ?? '?'}`)

  const headersExt = verifyRes.headers as Headers & { getSetCookie?: () => string[] }
  const rawCookie = headersExt.getSetCookie?.()[0] ?? verifyRes.headers.get('set-cookie')
  if (!rawCookie) throw new Error(`Липсва Set-Cookie при верификация (${suffix}).`)
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
  server = startServer(isolated.serverDir, port, isolated.ledgerPath)

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
  const player = await register(port, isolated.databaseFile, runId, 'player')
  const banTarget = await register(port, isolated.databaseFile, runId, 'bantarget')
  const deleteTarget = await register(port, isolated.databaseFile, runId, 'deltarget')
  const onlineDeleteTarget = await register(port, isolated.databaseFile, runId, 'onlinedeltarget')
  const forensicDeleteTarget = await register(port, isolated.databaseFile, runId, 'forensicdel')
  const banHistoryDeleteTarget = await register(port, isolated.databaseFile, runId, 'banhistdel')
  const tournamentActiveTarget = await register(port, isolated.databaseFile, runId, 'touractive')
  const tournamentFinishedCreator = await register(port, isolated.databaseFile, runId, 'tourfincreat')
  const tournamentFinishedParticipant = await register(port, isolated.databaseFile, runId, 'tourfinpart')
  const offlineBanTarget = await register(port, isolated.databaseFile, runId, 'offlineban')
  const offlineDeleteTarget = await register(port, isolated.databaseFile, runId, 'offlinedel')
  const onlineNotPlayingBanTarget = await register(port, isolated.databaseFile, runId, 'onlinenpban')
  const onlineNotPlayingDeleteTarget = await register(port, isolated.databaseFile, runId, 'onlinenpdel')
  const pendingBanTarget = await register(port, isolated.databaseFile, runId, 'pendingban')
  const pendingDeleteTarget = await register(port, isolated.databaseFile, runId, 'pendingdel')
  const tournamentPendingGuardTarget = await register(port, isolated.databaseFile, runId, 'tourpendguard')
  const adminCandidate = await register(port, isolated.databaseFile, runId, 'admin')
  const subadminCandidate = await register(port, isolated.databaseFile, runId, 'subadmin')

  promoteRole(isolated.databaseFile, adminCandidate.email, 'admin')
  promoteRole(isolated.databaseFile, subadminCandidate.email, 'subadmin')

  const adminCookie = await login(port, adminCandidate.email)
  const subadminCookie = await login(port, subadminCandidate.email)

  // Етап 4F2A — останалите служебни роли и admin, чиято роля е отнета СЛЕД
  // издаването на сесията.
  const pikaTeamCandidate = await register(port, isolated.databaseFile, runId, 'pikateam')
  const marketingCandidate = await register(port, isolated.databaseFile, runId, 'marketing')
  const topChatAdminCandidate = await register(port, isolated.databaseFile, runId, 'topchatadmin')
  const demotedAdminCandidate = await register(port, isolated.databaseFile, runId, 'demotedadmin')
  promoteRole(isolated.databaseFile, pikaTeamCandidate.email, 'pika_team')
  promoteRole(isolated.databaseFile, marketingCandidate.email, 'marketing')
  promoteRole(isolated.databaseFile, topChatAdminCandidate.email, 'top_chat_admin')
  promoteRole(isolated.databaseFile, demotedAdminCandidate.email, 'admin')
  const pikaTeamCookie = await login(port, pikaTeamCandidate.email)
  const marketingCookie = await login(port, marketingCandidate.email)
  const topChatAdminCookie = await login(port, topChatAdminCandidate.email)
  const demotedAdminCookie = await login(port, demotedAdminCandidate.email)
  promoteRole(isolated.databaseFile, demotedAdminCandidate.email, 'subadmin')

  console.log('  Регистрирани: player, ban-target, delete-target, admin, subadmin, pika_team, marketing, top_chat_admin, demoted admin.')

  const ledgerPath = isolated.ledgerPath

  /**
   * Етап 4F2A — реалният HTTP път на административното изтриване: DELETE
   * връща "насрочено" (pending:true), защото намерението току-що е записано
   * в регистъра и още НЕ е потвърдено offsite. Проверява, че отговорът
   * съответства на реалното състояние (профилът съществува, висящ ред с
   * операцията, намерение в регистъра, без offsite потвърждение).
   */
  async function scheduleAdminDelete(targetProfileId: string, reason: string): Promise<string> {
    const r = await httpRequest(port, `/api/admin/profiles/${targetProfileId}`, 'DELETE', adminCookie, { reason })
    const b = r.body as { ok?: boolean; pending?: boolean }
    if (r.status !== 200 || b.ok !== true || b.pending !== true) throw new Error(`DELETE: status=${r.status}, body=${JSON.stringify(r.body)}`)
    const state = readAdminDeletionDbState(isolated.databaseFile, targetProfileId, null)
    if (!state.profileExists) throw new Error('"насрочено", но профилът вече го няма')
    if (state.pendingOperationId === null) throw new Error('"насрочено", но няма висящ ред с операция')
    if (state.pendingRequestedBy !== adminCandidate.profileId || state.pendingReason !== reason) {
      throw new Error(`висящият ред не носи администратора/причината: ${JSON.stringify(state)}`)
    }
    const counts = countAdminLedgerRecords(ledgerPath, state.pendingOperationId)
    if (counts.intent !== 1 || counts.completed !== 0) throw new Error(`регистър: ${JSON.stringify(counts)}`)
    if (isProfileDeletionLedgerRecordConfirmedOffsite(ledgerPath, `admin_delete_intent:${state.pendingOperationId}`)) {
      throw new Error('намерението не би трябвало още да е потвърдено offsite')
    }
    return state.pendingOperationId
  }

  /** Offsite ack -> runner-ът изпълнява -> одит + файлова фаза done + completed в регистъра (без дублиране). */
  async function confirmAndAwaitAdminDelete(targetProfileId: string, operationId: string): Promise<void> {
    confirmLedgerOffsite(ledgerPath)
    await waitFor(`административното изтриване ${operationId} е изпълнено`, async () => {
      const state = readAdminDeletionDbState(isolated.databaseFile, targetProfileId, operationId)
      return !state.profileExists && state.pendingOperationId === null && state.auditFileCleanupStatus === 'done'
    }, 15_000)
    await waitFor(`admin_delete_completed за ${operationId}`, async () => countAdminLedgerRecords(ledgerPath, operationId).completed >= 1, 5_000)
    const counts = countAdminLedgerRecords(ledgerPath, operationId)
    if (counts.intent !== 1 || counts.completed !== 1) throw new Error(`регистърът е дублиран: ${JSON.stringify(counts)}`)
  }

  async function adminDeleteViaOffsite(targetProfileId: string, reason: string): Promise<string> {
    const operationId = await scheduleAdminDelete(targetProfileId, reason)
    await confirmAndAwaitAdminDelete(targetProfileId, operationId)
    return operationId
  }

  // ── non-admin/subadmin direct API call -> 403 ───────────────────────────
  console.log('\n[authz] Само role===admin минава — player/subadmin/pika_team/marketing/top_chat_admin/отнет admin => 403, guest => 403')
  const ledgerSizeBeforeAuthz = readProfileDeletionLedger(ledgerPath).records.length
  const NON_ADMIN_SESSIONS: Array<{ label: string; cookie: string; banToo: boolean }> = [
    { label: 'player', cookie: player.cookie, banToo: true },
    { label: 'subadmin', cookie: subadminCookie, banToo: true },
    { label: 'pika_team', cookie: pikaTeamCookie, banToo: false },
    { label: 'marketing', cookie: marketingCookie, banToo: false },
    { label: 'top_chat_admin', cookie: topChatAdminCookie, banToo: false },
    { label: 'admin с отнета роля (сесия отпреди смяната)', cookie: demotedAdminCookie, banToo: false },
  ]
  for (const { label, cookie, banToo } of NON_ADMIN_SESSIONS) {
    if (banToo) {
      await check(`[authz] ${label} -> POST ban => 403`, async () => {
        const r = await httpRequest(port, `/api/admin/profiles/${banTarget.profileId}/ban`, 'POST', cookie, { days: 7, reason: 'test' })
        if (r.status !== 403) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
      })
    }
    await check(`[authz] ${label} -> DELETE profile => 403`, async () => {
      const r = await httpRequest(port, `/api/admin/profiles/${deleteTarget.profileId}`, 'DELETE', cookie, { reason: 'test' })
      if (r.status !== 403) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
    })
    await check(`[authz] ${label} -> DELETE по support заявка (supportRequestMessageId) => 403`, async () => {
      const r = await httpRequest(port, `/api/admin/profiles/${deleteTarget.profileId}`, 'DELETE', cookie, { reason: 'test', supportRequestMessageId: randomUUID() })
      if (r.status !== 403) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
    })
  }
  await check('[authz] guest (без cookie) -> POST ban => 403', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${banTarget.profileId}/ban`, 'POST', undefined, { days: 7, reason: 'test' })
    if (r.status !== 403) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
  })
  await check('[authz] guest (без cookie) -> DELETE profile => 403', async () => {
    const r = await httpRequest(port, `/api/admin/profiles/${deleteTarget.profileId}`, 'DELETE', undefined, { reason: 'test' })
    if (r.status !== 403) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
  })
  await check('[authz] отказаните заявки не създават висящ ред, запис в регистъра или промяна по профила', () => {
    const state = readAdminDeletionDbState(isolated.databaseFile, deleteTarget.profileId, null)
    if (!state.profileExists || state.pendingOperationId !== null) throw new Error(JSON.stringify(state))
    const after = readProfileDeletionLedger(ledgerPath).records.length
    if (after !== ledgerSizeBeforeAuthz) throw new Error(`регистър: ${ledgerSizeBeforeAuthz} -> ${after}`)
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
  // Етап 4F2A — до 4F1 очакването беше незабавно изтриване в същия HTTP
  // отговор. От 4F1 намерението се изпълнява едва след offsite потвърждение
  // на регистъра, затова реалният отговор е "насрочено"; изтриването се
  // проверява след контролирания ack.
  let deleteFlowOperationId = ''
  await check('[delete-flow] admin -> DELETE profile {reason} => 200 насрочено -> offsite ack -> изпълнено', async () => {
    deleteFlowOperationId = await adminDeleteViaOffsite(deleteTarget.profileId, 'testing hard delete')
  })
  await check('[delete-flow] изтрит профил -> login => 400 (грешен email/парола, профилът вече не съществува)', async () => {
    const r = await loginRaw(port, deleteTarget.email)
    if (r.status !== 400) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
  })
  await check('[delete-flow] СЪЩИЯТ email може да се регистрира отново (освободен)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': nextSyntheticTestIp() },
      body: JSON.stringify({ email: deleteTarget.email, password: PASSWORD, displayName: `${deleteTarget.displayName}Re`, gender: 'male', visitorId: randomUUID() }),
    })
    // Email verification pending-first flow — "успешна регистрация" сега
    // означава pendingRegistrationId присъства (200 ok:true, ИЛИ 503
    // EMAIL_DELIVERY_FAILED с pendingRegistrationId — тестова среда без
    // реален Brevo, виж register()'s doc коментар по-горе). Целта на теста
    // (email-ът е реално освободен, не блокиран от стария изтрит профил)
    // е доказана от самото присъствие на pendingRegistrationId.
    const b = await res.json() as { ok?: boolean; message?: string; pendingRegistrationId?: string }
    const isAllowed = (res.status === 200 && b.ok === true) || (res.status === 503 && typeof b.pendingRegistrationId === 'string' && b.pendingRegistrationId !== '')
    if (!isAllowed) throw new Error(`status=${res.status}, body=${JSON.stringify(b)}`)
  })
  await check('[delete-flow] СЪЩОТО displayName/username може да се регистрира отново (освободено)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': nextSyntheticTestIp() },
      body: JSON.stringify({ email: `ban-delete-smoke-${runId}-namereuse@example.test`, password: PASSWORD, displayName: deleteTarget.displayName, gender: 'male', visitorId: randomUUID() }),
    })
    const b = await res.json() as { ok?: boolean; message?: string; pendingRegistrationId?: string }
    const isAllowed = (res.status === 200 && b.ok === true) || (res.status === 503 && typeof b.pendingRegistrationId === 'string' && b.pendingRegistrationId !== '')
    if (!isAllowed) throw new Error(`status=${res.status}, body=${JSON.stringify(b)}`)
  })

  console.log('\n[audit] admin_profile_deletions + profiles row вече не съществува')
  const auditDb = new DatabaseSync(isolated.databaseFile, { open: true })
  const deletionRows = auditDb.prepare(`
    SELECT log_id, deleted_profile_id, username_snapshot, deleted_by_profile_id, reason, file_cleanup_status
    FROM admin_profile_deletions
    WHERE deleted_profile_id = ?
  `).all(deleteTarget.profileId) as Array<{
    log_id: string
    deleted_profile_id: string
    username_snapshot: string
    deleted_by_profile_id: string | null
    reason: string
    file_cleanup_status: string | null
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
  await check('[audit] одитният ред е самата операция от регистъра; файловата фаза е done', () => {
    const row = deletionRows[0]
    if (!row || row.log_id !== deleteFlowOperationId) throw new Error(`log_id=${row?.log_id}, операция=${deleteFlowOperationId}`)
    if (row.file_cleanup_status !== 'done') throw new Error(`file_cleanup_status=${row.file_cleanup_status}`)
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

  // Етап 4F2 §10 — извън игра достъпът се спира ВЕДНАГА при насрочването
  // (сесии + живи socket-и), а изтриването следва след offsite потвърждението.
  let onlineDeleteOperationId = ''
  await check('[blocker-3] admin -> DELETE profile (online target) {reason} => 200 насрочено', async () => {
    onlineDeleteOperationId = await scheduleAdminDelete(onlineDeleteTarget.profileId, 'testing online hard delete')
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

  await check('[blocker-3] offsite ack -> изтриването е изпълнено (одит, файлова фаза done, регистър без дублиране)', async () => {
    await confirmAndAwaitAdminDelete(onlineDeleteTarget.profileId, onlineDeleteOperationId)
  })

  await check('[blocker-3] username/email на online-изтрития профил веднага освободени', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': nextSyntheticTestIp() },
      body: JSON.stringify({ email: onlineDeleteTarget.email, password: PASSWORD, displayName: `${onlineDeleteTarget.displayName}Re`, gender: 'male', visitorId: randomUUID() }),
    })
    // Email verification pending-first flow — виж [delete-flow] тестовете
    // по-горе за същия tolerance rationale (200 ok:true ИЛИ 503
    // EMAIL_DELIVERY_FAILED с pendingRegistrationId).
    const b = await res.json() as { ok?: boolean; message?: string; pendingRegistrationId?: string }
    const isAllowed = (res.status === 200 && b.ok === true) || (res.status === 503 && typeof b.pendingRegistrationId === 'string' && b.pendingRegistrationId !== '')
    if (!isAllowed) throw new Error(`status=${res.status}, body=${JSON.stringify(b)}`)
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

  await check('[blocker-r2-1] admin -> DELETE profile (forensicDeleteTarget) => насрочено -> offsite ack -> изпълнено', async () => {
    await adminDeleteViaOffsite(forensicDeleteTarget.profileId, 'testing forensic identity preservation')
  })

  await check('[blocker-r2-1] admin -> DELETE profile (banHistoryDeleteTarget, с активен бан) => насрочено -> offsite ack -> изпълнено', async () => {
    await adminDeleteViaOffsite(banHistoryDeleteTarget.profileId, 'testing ban history identity preservation')
  })

  const forensicDb = new DatabaseSync(isolated.databaseFile, { open: true })
  // Семантичен filter — ТОЧНО по target профила И по test-а СОБСТВЕНИЯ,
  // ръчно seed-нат visitorId (не global "всички редове за този profileId").
  // Registration-guard's immediate visitor/profile binding (production
  // security fix) вече ЛЕГИТИМНО добавя СВОЙ собствен site_visit_events ред
  // при самата register() заявка на forensicDeleteTarget (различен,
  // автоматично генериран visitor_id, синтетичен IP от nextSyntheticTestIp()) —
  // filter-ът по anonymous_visitor_id = visitorId изолира точно тестовия
  // сценарий от този допълнителен, коректен ред, вместо да разчита на
  // "точно N реда общо" за целия profileId.
  const visitorSnapshotRows = forensicDb.prepare(`
    SELECT deleted_profile_id, anonymous_visitor_id, ip_address, first_seen_at, last_seen_at, event_count
    FROM admin_profile_deletion_visitor_snapshots
    WHERE deleted_profile_id = ?
      AND anonymous_visitor_id = ?
    ORDER BY ip_address
  `).all(forensicDeleteTarget.profileId, visitorId) as Array<{
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
  const forensicCompactLinkCount = (forensicDb.prepare(`
    SELECT (SELECT COUNT(*) FROM profile_visitor_links WHERE profile_id = ?1)
         + (SELECT COUNT(*) FROM profile_ip_links WHERE profile_id = ?1) AS n
  `).get(forensicDeleteTarget.profileId) as { n: number }).n
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
  // Етап 4F2 (P5) — административното изтриване прилага правилата на
  // самоизтриването: НОВ visitor/IP forensic snapshot не се създава, а
  // compact visitor/IP връзките на изтрития се премахват. Старото очакване
  // (2 агрегирани snapshot реда) описваше поведението отпреди 4F2.
  await check('[blocker-r2-1] 4F2: без нов visitor snapshot; compact visitor/IP връзките на изтрития са премахнати; събитията са без profile_id', () => {
    if (visitorSnapshotRows.length !== 0) throw new Error(`snapshot редове=${visitorSnapshotRows.length}: ${JSON.stringify(visitorSnapshotRows)}`)
    if (forensicCompactLinkCount !== 0) throw new Error(`compact връзки=${forensicCompactLinkCount}`)
    if (liveEventRows.some((row) => row.profile_id !== null)) throw new Error(`site_visit_events.profile_id: ${JSON.stringify(liveEventRows)}`)
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

  await check('[blocker-r2-2] admin -> DELETE profile (finished tournament creator) => насрочено -> изпълнено (не е блокирано, турнирът е terminal)', async () => {
    await adminDeleteViaOffsite(tournamentFinishedCreator.profileId, 'creator of finished tournament')
  })
  await check('[blocker-r2-2] admin -> DELETE profile (finished tournament participant) => насрочено -> изпълнено', async () => {
    await adminDeleteViaOffsite(tournamentFinishedParticipant.profileId, 'participant of finished tournament')
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
  // Етап 4F2A — pending:false в същия отговор е невъзможно при задължително
  // offsite потвърждение (намерението се записва в тази заявка); реалният
  // отговор е pending:true, а изтриването следва след ack-а.
  await check('[round4-B] admin -> DELETE offline профил => 200, pending:true -> offsite ack -> изпълнено', async () => {
    await adminDeleteViaOffsite(offlineDeleteTarget.profileId, 'offline delete test')
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
  let onlineNpDeleteOperationId = ''
  await check('[round4-D] admin -> DELETE (online, НЕ в игра) => 200, pending:true (насрочено; достъпът се спира веднага)', async () => {
    onlineNpDeleteOperationId = await scheduleAdminDelete(onlineNotPlayingDeleteTarget.profileId, 'online not-playing delete test')
  })
  await check('[round4-D] живият socket получава "session_deleted" ВЕДНАГА (преди offsite потвърждението)', async () => {
    await waitFor('session_deleted frame', async () => onlineNpDelMessages.some((m) => m.type === 'session_deleted'), 5000)
    if (countAdminLedgerRecords(ledgerPath, onlineNpDeleteOperationId).completed !== 0) throw new Error('изтриването вече е изпълнено — проверката не доказва незабавно спиране')
  })
  await check('[round4-D] offsite ack -> изтриването е изпълнено', async () => {
    await confirmAndAwaitAdminDelete(onlineNotPlayingDeleteTarget.profileId, onlineNpDeleteOperationId)
  })

  await check('[round4-D] "session_deleted" frame носи точния admin reason', () => {
    const frame = onlineNpDelMessages.find((m) => m.type === 'session_deleted')
    if (frame?.reason !== 'online not-playing delete test') throw new Error(`reason=${JSON.stringify(frame?.reason)}`)
  })
  if (onlineNpDelSocket.readyState === WebSocket.OPEN || onlineNpDelSocket.readyState === WebSocket.CONNECTING) onlineNpDelSocket.close()

  // [WS-Invalidation] Admin Information/Registered Profiles aggregate
  // refresh fix (втори follow-up production report) — реален HTTP+WS
  // round-trip: immediate hard delete трябва да изпрати
  // {type:'admin_aggregate_data_changed'} (INVALIDATION-only, без payload
  // данни — виж broadcastAdminAggregateDataChangedToAdminConnections в
  // index.ts) към ДРУГИ admin/subadmin WS connections, но НЕ към
  // собствената WS сесия на admin-а, направил HTTP заявката (dedup чрез
  // ServerConnection.sessionId exclusion — admin-ският таб вече получава
  // synchronous local refresh directно от своя HTTP response).
  console.log('\n[WS-Invalidation] admin_aggregate_data_changed broadcast след успешен immediate hard delete')

  const wsInvalidationTarget = await register(port, isolated.databaseFile, runId, 'wsinvalidation')

  const adminSelfSocket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: adminCookie } })
  const adminSelfMessages: Array<{ type?: string }> = []
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error('WS connect timeout')), 5000)
    adminSelfSocket.on('open', () => { clearTimeout(t); res() })
    adminSelfSocket.on('error', (e) => { clearTimeout(t); rej(e) })
  })
  adminSelfSocket.on('message', (raw) => { try { adminSelfMessages.push(JSON.parse(raw.toString('utf8'))) } catch { /* ignore */ } })

  const bystanderAdminSocket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: subadminCookie } })
  const bystanderAdminMessages: Array<{ type?: string }> = []
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error('WS connect timeout')), 5000)
    bystanderAdminSocket.on('open', () => { clearTimeout(t); res() })
    bystanderAdminSocket.on('error', (e) => { clearTimeout(t); rej(e) })
  })
  bystanderAdminSocket.on('message', (raw) => { try { bystanderAdminMessages.push(JSON.parse(raw.toString('utf8'))) } catch { /* ignore */ } })

  await check('[WS-Invalidation] admin (self) и bystander (subadmin) WS connections => "connected" frame', async () => {
    await waitFor('admin self connected frame', async () => adminSelfMessages.some((m) => m.type === 'connected'), 5000)
    await waitFor('bystander admin connected frame', async () => bystanderAdminMessages.some((m) => m.type === 'connected'), 5000)
  })

  await check('[WS-Invalidation] admin -> DELETE (offline target) => 200, pending:true -> offsite ack -> изпълнено от runner-а', async () => {
    await adminDeleteViaOffsite(wsInvalidationTarget.profileId, 'ws invalidation broadcast test')
  })

  await check('[WS-Invalidation] bystander admin (subadmin) socket получава admin_aggregate_data_changed', async () => {
    await waitFor('admin_aggregate_data_changed frame', async () => bystanderAdminMessages.some((m) => m.type === 'admin_aggregate_data_changed'), 5000)
  })

  await check('[WS-Invalidation] admin_aggregate_data_changed е чист invalidation сигнал — БЕЗ payload данни (само type полето)', () => {
    const frame = bystanderAdminMessages.find((m) => m.type === 'admin_aggregate_data_changed') as Record<string, unknown> | undefined
    if (!frame) throw new Error('frame not found')
    const extraKeys = Object.keys(frame).filter((k) => k !== 'type')
    if (extraKeys.length > 0) throw new Error(`admin_aggregate_data_changed носи неочаквани полета: ${JSON.stringify(extraKeys)}`)
  })

  // Етап 4F2A — dedup-ът (excludeSessionId) важи само за изтриване,
  // изпълнено в самия HTTP отговор (тогава табът на администратора се
  // обновява локално). При изпълнение от runner-а след offsite потвърждението
  // HTTP отговорът е бил "насрочено", затова и собственият таб на
  // администратора ТРЯБВА да получи сигнала — иначе списъците му остават стари.
  await check('[WS-Invalidation] при отложено изпълнение и собственият socket на администратора получава admin_aggregate_data_changed', async () => {
    await waitFor('admin self admin_aggregate_data_changed frame', async () => adminSelfMessages.some((m) => m.type === 'admin_aggregate_data_changed'), 5000)
  })

  if (adminSelfSocket.readyState === WebSocket.OPEN || adminSelfSocket.readyState === WebSocket.CONNECTING) adminSelfSocket.close()
  if (bystanderAdminSocket.readyState === WebSocket.OPEN || bystanderAdminSocket.readyState === WebSocket.CONNECTING) bystanderAdminSocket.close()

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

  // Етап 4F2 (§10) — насроченото административно изтриване спира и НОВИЯ
  // вход (не само новите WS връзки): иначе профилът би могъл да прави
  // покупки/HTTP действия до изпълнението. WS проверката по-долу ползва
  // вече съществуващата сесия от регистрацията.
  const pendingDeleteLogin = await loginRaw(port, pendingDeleteTarget.email)
  await check('[round4-F] pendingDeleteTarget нов login се отказва (403 PROFILE_DELETION_SCHEDULED) — профилът още съществува, изтриването е насрочено', () => {
    const body = pendingDeleteLogin.body as { code?: string }
    if (pendingDeleteLogin.status !== 403 || body.code !== 'PROFILE_DELETION_SCHEDULED' || pendingDeleteLogin.cookie !== null) {
      throw new Error(`status=${pendingDeleteLogin.status}, body=${JSON.stringify(pendingDeleteLogin.body)}`)
    }
  })
  const pendingDeleteCookie = pendingDeleteTarget.cookie
  // round 5 §2 корекция — след добавянето на connect-time pending-moderation
  // gate-а (wsServer.on('connection', ...)), нова WS connection за
  // pendingDeleteCookie вече се отхвърля НА connect-time, ПРЕДИ дори
  // 'connected' frame да бъде доставен — join_matchmaking-level guard-ът
  // (по-долу в message dispatch loop-а) вече е defense-in-depth за profile,
  // чиято connection БЕШЕ established ПРЕДИ pending маркера (напр. живата
  // игрова connection) — тук нямаме такава, затова очакваме connect-time
  // отказ (socket се затваря без 'connected'), не message-level error frame.
  // Етап 4F2A — двата валидни пътя (виж assertNewWsNotAuthenticatedAsProfile):
  // докато сесията още е жива — connect-time reject; след като runner-ът
  // (onWaiting) я отнеме — гост връзка. Кой от двата се случи зависи само от
  // момента на цикъла на runner-а; и в двата случая профилът не се удостоверява.
  async function assertNewWsNotAuthenticatedAsProfile(cookie: string): Promise<void> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: cookie } })
    const messages: Array<{ type?: string; message?: string }> = []
    let closed = false
    socket.on('close', () => { closed = true })
    socket.on('message', (raw) => { try { messages.push(JSON.parse(raw.toString('utf8'))) } catch { /* ignore */ } })
    await waitFor('socket close или "connected" frame', async () => closed || messages.some((m) => m.type === 'connected'), 5000)
    if (closed) {
      if (messages.some((m) => m.type === 'connected')) throw new Error(`затворена след "connected": ${JSON.stringify(messages)}`)
      return
    }
    socket.send(JSON.stringify({ type: 'join_matchmaking', stake: 5000 }))
    try {
      await waitFor('отказ "Трябва да влезеш" за join_matchmaking', async () => messages.some((m) => m.type === 'error' && typeof m.message === 'string' && m.message.startsWith('Трябва да влезеш')), 5000)
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}; frames=${JSON.stringify(messages.map((m) => ({ type: m.type, message: m.message })))}`)
    } finally {
      socket.close()
    }
  }

  await check('[round4-F] pendingDeleteTarget -> нова WS connection НЕ се удостоверява като профила (connect-time reject или гост след отнемане на сесиите) — нова игра е блокирана', async () => {
    await assertNewWsNotAuthenticatedAsProfile(pendingDeleteCookie)
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
  // Етап 4F2A — изолираният тест не може да постави профила в реална игра,
  // затова runner-ът (onWaiting, Етап 4F2 §10) вижда насрочено изтриване
  // извън игра и ОТНЕМА сесиите му. Тогава старата бисквитка вече не
  // удостоверява никого и връзката е гост връзка (connect-time gate-ът за
  // висяща модерация не е нужен). Валидното очакване е същото по смисъл:
  // нова връзка НЕ се удостоверява като pendingDeleteTarget — или се затваря
  // на connect-time, или е гост и действие, изискващо профил, се отказва.
  await check('[round5-2] повторен login отказан + нов WS connect опит (съществуващата бисквитка) за pendingDeleteTarget НЕ се удостоверява като профила (connect-time reject или гост), pending row не се консумира', async () => {
    const freshLogin = await loginRaw(port, pendingDeleteTarget.email)
    if (freshLogin.status !== 403 || freshLogin.cookie !== null) throw new Error(`login: status=${freshLogin.status}`)
    await assertNewWsNotAuthenticatedAsProfile(pendingDeleteTarget.cookie)
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

  // ── HARD DELETE physical avatar/gallery file cleanup (production gap fix) ──
  // fileCleanupTarget получава реален avatar upload + 2 gallery снимки на
  // диска, в ТОЧНИТЕ upload директории, които реалният сървър използва
  // (AVATAR_UPLOADS_PATH/GALLERY_UPLOADS_PATH под isolated.serverDir) —
  // seed-нати директно през DB+filesystem (mirror на site_visit_events seed
  // pattern-а в checkAdminProfileRiskDetectorHttpAuthorization.ts), не през
  // пълния image-crop upload HTTP flow. fileCleanupControl има собствен
  // avatar upload в СЪЩАТА (flat, споделена между всички профили) avatars
  // директория — доказва, че cleanup-ът е targeted само към target-а, дори
  // когато друг профил споделя родителската директория. Hard delete на
  // fileCleanupTarget през реалния admin endpoint (СЪЩИЯ
  // profileHardDeleteService.hardDeleteProfile primitive, ползван и от
  // deferred pending-delete flow-а) -> и трите target файла трябва да
  // изчезнат физически, control файлът остава, profile_gallery_images
  // редовете на target-а изчезват (cascade). fileCleanupDefaultAvatarTarget
  // никога не е качвал avatar/gallery (avatar_url остава NULL, каквото е по
  // подразбиране при регистрация) — доказва, че default/липсващ avatar не
  // чупи delete-а.
  console.log('\n[file-cleanup] HARD DELETE трие физически avatar + gallery файлове на target, НЕ пипа unrelated profile файлове')
  const fileCleanupTarget = await register(port, isolated.databaseFile, runId, 'filecleanup')
  const fileCleanupControl = await register(port, isolated.databaseFile, runId, 'filecleanupctrl')
  const fileCleanupDefaultAvatarTarget = await register(port, isolated.databaseFile, runId, 'filecleanupdefault')

  const avatarUploadsPath = join(isolated.serverDir, 'uploads', 'avatars')
  const galleryUploadsPath = join(isolated.serverDir, 'uploads', 'profile-gallery')
  await mkdir(avatarUploadsPath, { recursive: true })

  const targetAvatarFilename = `${randomUUID()}.webp`
  const targetAvatarFilePath = join(avatarUploadsPath, targetAvatarFilename)
  await writeFile(targetAvatarFilePath, Buffer.from('fake-avatar-bytes'))
  const targetAvatarUrl = `/uploads/avatars/${targetAvatarFilename}`

  const controlAvatarFilename = `${randomUUID()}.webp`
  const controlAvatarFilePath = join(avatarUploadsPath, controlAvatarFilename)
  await writeFile(controlAvatarFilePath, Buffer.from('fake-control-avatar-bytes'))
  const controlAvatarUrl = `/uploads/avatars/${controlAvatarFilename}`

  const targetGalleryDir = join(galleryUploadsPath, fileCleanupTarget.profileId)
  await mkdir(targetGalleryDir, { recursive: true })
  const galleryImageId1 = randomUUID()
  const galleryImageId2 = randomUUID()
  const galleryFilePath1 = join(targetGalleryDir, `${galleryImageId1}.webp`)
  const galleryFilePath2 = join(targetGalleryDir, `${galleryImageId2}.webp`)
  await writeFile(galleryFilePath1, Buffer.from('fake-gallery-bytes-1'))
  await writeFile(galleryFilePath2, Buffer.from('fake-gallery-bytes-2'))
  const galleryImageUrl1 = `/uploads/profile-gallery/${fileCleanupTarget.profileId}/${galleryImageId1}.webp`
  const galleryImageUrl2 = `/uploads/profile-gallery/${fileCleanupTarget.profileId}/${galleryImageId2}.webp`

  {
    const db = new DatabaseSync(isolated.databaseFile, { open: true })
    db.exec('PRAGMA journal_mode = WAL;')
    db.prepare(`UPDATE profiles SET avatar_url = ? WHERE profile_id = ?`).run(targetAvatarUrl, fileCleanupTarget.profileId)
    db.prepare(`UPDATE profiles SET avatar_url = ? WHERE profile_id = ?`).run(controlAvatarUrl, fileCleanupControl.profileId)
    db.prepare(`
      INSERT INTO profile_gallery_images (image_id, profile_id, image_url, thumbnail_url, sort_order)
      VALUES (?, ?, ?, ?, 0)
    `).run(galleryImageId1, fileCleanupTarget.profileId, galleryImageUrl1, galleryImageUrl1)
    db.prepare(`
      INSERT INTO profile_gallery_images (image_id, profile_id, image_url, thumbnail_url, sort_order)
      VALUES (?, ?, ?, ?, 1)
    `).run(galleryImageId2, fileCleanupTarget.profileId, galleryImageUrl2, galleryImageUrl2)
    db.close()
  }

  await check('[file-cleanup] setup: avatar/gallery файловете физически съществуват ПРЕДИ delete-а', async () => {
    for (const p of [targetAvatarFilePath, controlAvatarFilePath, galleryFilePath1, galleryFilePath2]) {
      if (!(await pathExists(p))) throw new Error(`Setup файлът липсва: ${p}`)
    }
  })

  // Етап 4F2 — файловете минават през надеждната опашка; adminDeleteViaOffsite
  // изчаква file_cleanup_status='done', т.е. всички файлови операции са
  // приключили (done/skipped_shared), преди проверките по-долу.
  await check('[file-cleanup] admin -> DELETE profile (fileCleanupTarget) => насрочено -> изпълнено, файловата фаза done', async () => {
    await adminDeleteViaOffsite(fileCleanupTarget.profileId, 'testing physical file cleanup')
  })

  await check('[file-cleanup] target avatar файлът вече не съществува на диска', async () => {
    if (await pathExists(targetAvatarFilePath)) throw new Error(`Файлът все още съществува: ${targetAvatarFilePath}`)
  })
  await check('[file-cleanup] target gallery файл #1 вече не съществува на диска', async () => {
    if (await pathExists(galleryFilePath1)) throw new Error(`Файлът все още съществува: ${galleryFilePath1}`)
  })
  await check('[file-cleanup] target gallery файл #2 вече не съществува на диска', async () => {
    if (await pathExists(galleryFilePath2)) throw new Error(`Файлът все още съществува: ${galleryFilePath2}`)
  })
  await check('[file-cleanup] profile_gallery_images redовете на target вече не съществуват (cascade)', () => {
    const db = new DatabaseSync(isolated.databaseFile, { open: true })
    const rows = db.prepare(`SELECT image_id FROM profile_gallery_images WHERE profile_id = ?`).all(fileCleanupTarget.profileId)
    db.close()
    if (rows.length !== 0) throw new Error(`Останали redове: ${JSON.stringify(rows)}`)
  })
  await check('[file-cleanup] unrelated control avatar файлът остава недокоснат (targeted cleanup, не global)', async () => {
    if (!(await pathExists(controlAvatarFilePath))) throw new Error(`Control файлът неочаквано изчезна: ${controlAvatarFilePath}`)
  })
  await check('[file-cleanup] admin -> DELETE profile (fileCleanupDefaultAvatarTarget, никога не е качвал avatar/gallery) => изпълнено, без грешка (NULL avatar_url се игнорира безопасно)', async () => {
    await adminDeleteViaOffsite(fileCleanupDefaultAvatarTarget.profileId, 'testing default avatar skip')
  })

  // ── SHARED AVATAR SAFETY: двама профила сочат към ЕДИН И СЪЩ uploaded
  // avatar URL (flat, споделена директория — за разлика от gallery)
  // — hard delete на единия НЕ трябва да унищожи файла, докато другият
  // профил все още го реферира.
  console.log('\n[file-cleanup-shared] Двама профила споделят СЪЩИЯ uploaded avatar URL -> hard delete на единия НЕ трие физическия файл')
  const sharedAvatarProfileA = await register(port, isolated.databaseFile, runId, 'sharedavatara')
  const sharedAvatarProfileB = await register(port, isolated.databaseFile, runId, 'sharedavatarb')

  const sharedAvatarFilename = `${randomUUID()}.webp`
  const sharedAvatarFilePath = join(avatarUploadsPath, sharedAvatarFilename)
  await writeFile(sharedAvatarFilePath, Buffer.from('fake-shared-avatar-bytes'))
  const sharedAvatarUrl = `/uploads/avatars/${sharedAvatarFilename}`

  {
    const db = new DatabaseSync(isolated.databaseFile, { open: true })
    db.exec('PRAGMA journal_mode = WAL;')
    db.prepare(`UPDATE profiles SET avatar_url = ? WHERE profile_id = ?`).run(sharedAvatarUrl, sharedAvatarProfileA.profileId)
    db.prepare(`UPDATE profiles SET avatar_url = ? WHERE profile_id = ?`).run(sharedAvatarUrl, sharedAvatarProfileB.profileId)
    db.close()
  }

  await check('[file-cleanup-shared] admin -> DELETE profile (sharedAvatarProfileA) => изпълнено (споделеният файл -> skipped_shared, файловата фаза done)', async () => {
    await adminDeleteViaOffsite(sharedAvatarProfileA.profileId, 'testing shared avatar safety')
  })
  await check('[file-cleanup-shared] споделеният avatar файл остава на диска (все още реферира от sharedAvatarProfileB)', async () => {
    if (!(await pathExists(sharedAvatarFilePath))) throw new Error(`Споделеният файл неочаквано изчезна: ${sharedAvatarFilePath}`)
  })
  await check('[file-cleanup-shared] sharedAvatarProfileB остава с валиден avatar_url в DB (профилът не е пипнат)', () => {
    const db = new DatabaseSync(isolated.databaseFile, { open: true })
    const row = db.prepare(`SELECT avatar_url FROM profiles WHERE profile_id = ?`).get(sharedAvatarProfileB.profileId) as { avatar_url: string | null } | undefined
    db.close()
    if (!row || row.avatar_url !== sharedAvatarUrl) throw new Error(`sharedAvatarProfileB.avatar_url=${row?.avatar_url}, очаквах ${sharedAvatarUrl}`)
  })

  // ── Етап 4F2A: offsite потвърждението през реалния HTTP път ─────────────
  // Без валиден ack нищо не се изтрива (fail-closed), колкото и пъти да мине
  // runner-ът; "насрочено" отговаря на реалното състояние през цялото време.
  console.log('\n[offsite] липсващо / невалидно / валидно offsite потвърждение (реалната проверка на регистъра)')
  const offsiteTarget = await register(port, isolated.databaseFile, runId, 'offsitetarget')
  const RUNNER_TICKS_WAIT_MS = 1_500 // ≥ 5 цикъла на runner-а (250 ms)
  let offsiteOperationId = ''

  const assertStillScheduled = (label: string): void => {
    const state = readAdminDeletionDbState(isolated.databaseFile, offsiteTarget.profileId, offsiteOperationId)
    if (!state.profileExists || state.pendingOperationId !== offsiteOperationId || state.auditFileCleanupStatus !== undefined) {
      throw new Error(`${label}: ${JSON.stringify(state)}`)
    }
    if (countAdminLedgerRecords(ledgerPath, offsiteOperationId).completed !== 0) throw new Error(`${label}: completed запис в регистъра`)
  }

  await check('[offsite] admin -> DELETE => 200 насрочено (профил, висящ ред, намерение в регистъра — без потвърждение)', async () => {
    offsiteOperationId = await scheduleAdminDelete(offsiteTarget.profileId, 'offsite confirmation test')
  })
  await check('[offsite] насроченият профил няма действаща сесия (нови игри/покупки изискват сесия) и не може да влезе', async () => {
    const me = await httpRequest(port, '/api/profile/me', 'GET', offsiteTarget.cookie)
    if (me.status !== 401) throw new Error(`/api/profile/me status=${me.status}`)
    const relogin = await loginRaw(port, offsiteTarget.email)
    const body = relogin.body as { code?: string }
    if (relogin.status !== 403 || body.code !== 'PROFILE_DELETION_SCHEDULED' || relogin.cookie !== null) {
      throw new Error(`login: status=${relogin.status}, body=${JSON.stringify(relogin.body)}`)
    }
  })
  await check('[offsite] липсващо потвърждение: след няколко цикъла на runner-а изтриването НЕ е изпълнено', async () => {
    await sleep(RUNNER_TICKS_WAIT_MS)
    assertStillScheduled('липсващ ack')
  })
  await check('[offsite] невалидно потвърждение (грешен SHA-256): изтриването НЕ е изпълнено', async () => {
    confirmLedgerOffsite(ledgerPath, 'wrong_sha')
    await sleep(RUNNER_TICKS_WAIT_MS)
    assertStillScheduled('грешен SHA-256')
  })
  await check('[offsite] невалидно потвърждение (префикс без последния байт): изтриването НЕ е изпълнено', async () => {
    confirmLedgerOffsite(ledgerPath, 'truncated')
    await sleep(RUNNER_TICKS_WAIT_MS)
    assertStillScheduled('отрязан префикс')
  })
  await check('[offsite] валидно потвърждение -> изпълнено: одит от името на администратора, файловата фаза done, регистърът без дублиране', async () => {
    await confirmAndAwaitAdminDelete(offsiteTarget.profileId, offsiteOperationId)
    const db = new DatabaseSync(isolated.databaseFile, { open: true })
    const audit = db.prepare(`SELECT deleted_profile_id, deleted_by_profile_id, reason FROM admin_profile_deletions WHERE log_id = ?`).get(offsiteOperationId) as Record<string, unknown> | undefined
    db.close()
    if (audit?.deleted_profile_id !== offsiteTarget.profileId || audit.deleted_by_profile_id !== adminCandidate.profileId || audit.reason !== 'offsite confirmation test') {
      throw new Error(`одит: ${JSON.stringify(audit)}`)
    }
  })
  await check('[offsite] след изпълнението входът връща generic невалидни данни (профилът го няма)', async () => {
    const r = await loginRaw(port, offsiteTarget.email)
    if (r.status !== 400) throw new Error(`status=${r.status}, body=${JSON.stringify(r.body)}`)
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
