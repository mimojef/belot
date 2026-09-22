/**
 * checkTournamentHighEntryFeesHttp.ts
 *
 * Focused HTTP integration test за новите високи tournament entry-fee
 * опции (200 000 / 500 000 / 800 000 / 1 000 000 жълтици). Умишлено
 * отделен от checkTournamentEntryHttpApi.ts (legacy общ join/leave/cancel
 * suite, ~76 регистрации в един run) — този тест ползва само 3 регистрирани
 * test акаунта, далеч под 30/час per-IP verify-registration-email лимита
 * (server/src/db/authStore.ts's PENDING_REGISTRATION_VERIFY_IP_MAX_PER_WINDOW).
 *
 * Покрива:
 *  CASE A — entryFee=1 000 000 пълен economy lifecycle:
 *    fresh/low-level creator създава турнир; fresh/low-level second player
 *    join-ва (без level↔stake gating); debit точно 1 000 000; creator
 *    cancel; refund точно 1 000 000.
 *  CASE B — insufficient funds:
 *    трети fresh/low-level играч с баланс < 1 000 000 се опитва да join-не
 *    същия по стойност (нов) турнир — отказ с insufficient_funds, wallet-ът
 *    остава непокътнат.
 *  ENTRY-FEE VALIDATION — 200 000 / 500 000 / 800 000 се приемат като
 *    валидни entryFee стойности през реалния create endpoint (1 000 000
 *    вече е покрито от CASE A, не се дублира).
 *
 * Registration: реален spawned сървър, изолирано temp SQLite копие,
 * established email-verification pending-first pattern — виж
 * checkPrivateRoomWebSocketRoundTrip.ts/checkAuthSessionRollingRenewal.ts
 * (TEST-ONLY deterministic secret, brute-force на 6-цифрения verification
 * код от DB-съхранения code_hash със същия production HMAC helper, БЕЗ
 * реален Brevo/email delivery).
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { verifyVerificationCode } from '../src/db/authHelpers.js'

const PASSWORD = 'HighEntryFeeSmoke1!'
const SERVER_READY_TIMEOUT_MS = 30_000
// Email-verification pending-first register() изисква registrationVerificationCodeSecret
// (≥32 символа, виж index.ts's EMAIL_VERIFICATION_CODE_SECRET/PASSWORD_RESET_RATE_LIMIT_SECRET
// fallback selection) — TEST-ONLY, deterministic, hardcoded само тук, mirror
// на established pattern в checkPrivateRoomWebSocketRoundTrip.ts/
// checkAuthSessionRollingRenewal.ts (никога production secret/production .env).
const TEST_REGISTRATION_SECRET = 'tournament-high-entry-fees-http-test-secret-0123456789'

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
function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// ─── Мрежови helpers ──────────────────────────────────────────────────────

function getFreePort(): Promise<number> {
  return new Promise((resolveP, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (!addr || typeof addr === 'string') {
        srv.close(() => reject(new Error('Не може да се намери свободен порт.')))
        return
      }
      const { port } = addr
      srv.close(() => resolveP(port))
    })
  })
}

type HttpResult = { status: number; body: any; setCookie: string | null }

async function httpJson(port: number, method: string, pathname: string, cookie: string | null, body?: unknown): Promise<HttpResult> {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const setCookie = (res.headers.getSetCookie?.()[0] ?? res.headers.get('set-cookie'))?.split(';')[0] ?? null
  let json: any = null
  try { json = await res.json() } catch { /* not json */ }
  return { status: res.status, body: json, setCookie }
}

async function waitFor(label: string, predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await sleep(100)
  }
  throw new Error(`Timeout: ${label}`)
}

// ─── Сървър helpers (established isolated-spawn pattern) ──────────────────

type RunningServer = { child: ChildProcessWithoutNullStreams; closed: Promise<void>; output(): string }

async function createIsolatedServerRoot(originalServerRoot: string): Promise<{
  root: string
  serverDir: string
  databaseFile: string
  cleanup(): Promise<void>
}> {
  const root = await mkdtemp(join(tmpdir(), 'belot-tournament-high-fees-'))
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
        PASSWORD_RESET_RATE_LIMIT_SECRET: TEST_REGISTRATION_SECRET,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (c: string) => chunks.push(c))
  child.stderr.on('data', (c: string) => chunks.push(c))
  const closed = new Promise<void>((resolveClosed) => { child.once('close', () => resolveClosed()) })
  return { child, closed, output: () => chunks.join('') }
}

async function stopServer(server: RunningServer): Promise<void> {
  if (server.child.exitCode === null) server.child.kill('SIGTERM')
  const forceKillTimer = setTimeout(() => {
    if (server.child.exitCode === null) server.child.kill('SIGKILL')
  }, 10_000)
  try {
    await server.closed
  } finally {
    clearTimeout(forceKillTimer)
  }
}

// ─── Registration: established email-verification pending-first pattern ───

function bruteForceVerificationCode(databaseFilePath: string, pendingRegistrationId: string, secret: string): string {
  const db = new DatabaseSync(databaseFilePath, { open: true })
  const row = db.prepare(`SELECT code_hash FROM pending_registrations WHERE pending_registration_id = ?`).get(pendingRegistrationId) as
    | { code_hash: string }
    | undefined
  db.close()
  if (!row) throw new Error(`pending_registrations row not found: ${pendingRegistrationId}`)
  for (let candidate = 0; candidate < 1_000_000; candidate++) {
    const code = candidate.toString().padStart(6, '0')
    if (verifyVerificationCode(code, secret, row.code_hash)) return code
  }
  throw new Error(`Не успях да brute-force-на verification кода за ${pendingRegistrationId}`)
}

async function registerProfile(port: number, databaseFile: string, suffix: string): Promise<{ cookie: string; profileId: string }> {
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const reg = await httpJson(port, 'POST', '/api/auth/register', null, {
    email: `high-entry-fee-${suffix}-${runId}@example.test`.toLowerCase(),
    password: PASSWORD,
    displayName: `HighFee ${suffix}`,
    gender: 'male',
    visitorId: randomUUID(),
  })
  // pendingRegistrationId се връща и на 200, И на 503 EMAIL_DELIVERY_FAILED
  // (Brevo не е configured в тестовата среда — очаквано, pending редът
  // persists независимо от email delivery резултата).
  const pendingRegistrationId: string | undefined = reg.body?.pendingRegistrationId
  if (!pendingRegistrationId) throw new Error(`Регистрацията се провали за ${suffix}: ${JSON.stringify(reg.body)}`)

  const code = bruteForceVerificationCode(databaseFile, pendingRegistrationId, TEST_REGISTRATION_SECRET)
  const verifyBody = { pendingRegistrationId, code, rememberMe: true }
  let verified: HttpResult
  try {
    verified = await httpJson(port, 'POST', '/api/auth/verify-registration-email', null, verifyBody)
  } catch {
    // bruteForceVerificationCode блокира event loop-а синхронно и понякога
    // прави keep-alive връзката към spawned сървъра stale (transient) —
    // established mitigation: един бърз retry.
    await sleep(200)
    verified = await httpJson(port, 'POST', '/api/auth/verify-registration-email', null, verifyBody)
  }
  if (verified.status !== 200) throw new Error(`Потвърждението на email се провали за ${suffix}: ${JSON.stringify(verified.body)}`)
  if (!verified.setCookie) throw new Error(`Липсва Set-Cookie при verify-registration-email за ${suffix}.`)

  const profileId = verified.body?.session?.profile?.profileId
  if (!profileId) throw new Error(`Липсва profileId след verify за ${suffix}.`)
  return { cookie: verified.setCookie, profileId }
}

// ─── Test DB setup helpers ──────────────────────────────────────────────

function setWalletBalance(databaseFile: string, profileId: string, amount: number): void {
  const db = new DatabaseSync(databaseFile, { open: true, timeout: 5_000 })
  try {
    db.prepare('UPDATE profile_wallets SET yellow_coins_balance = ? WHERE profile_id = ?;').run(amount, profileId)
  } finally {
    db.close()
  }
}

async function getWalletBalance(port: number, cookie: string): Promise<number> {
  const r = await httpJson(port, 'GET', '/api/auth/me', cookie)
  if (!r.body?.ok || r.body.session === null) throw new Error('Не може да се прочете баланс.')
  return r.body.session.profile.yellowCoinsBalance
}

async function getProfileLevel(port: number, cookie: string): Promise<number> {
  const r = await httpJson(port, 'GET', '/api/auth/me', cookie)
  if (!r.body?.ok || r.body.session === null) throw new Error('Не може да се прочете ниво.')
  return r.body.session.profile.level
}

async function createTournament(
  port: number,
  cookie: string,
  overrides: Partial<{ name: string; entryFee: number }> = {},
): Promise<{ tournamentId: string; entryFee: number; status: number; body: any }> {
  const r = await httpJson(port, 'POST', '/api/tournaments', cookie, {
    name: overrides.name ?? 'High Fee Смоук Турнир',
    entryFee: overrides.entryFee ?? 20000,
    visibility: 'public',
    startMode: 'fill',
  })
  return {
    tournamentId: r.body?.tournament?.tournamentId,
    entryFee: r.body?.tournament?.entryFee,
    status: r.status,
    body: r.body,
  }
}

// ─── Главна функция ─────────────────────────────────────────────────────

const sourceServerRoot = resolve(
  process.argv.slice(2).find((a) => a.startsWith('--server-root='))?.slice('--server-root='.length)
  ?? process.cwd(),
)

console.log('\n═══ Tournament high entry-fee options (200k/500k/800k/1M) HTTP smoke test ═══')
console.log(`Server root: ${sourceServerRoot}`)

const isolated = await createIsolatedServerRoot(sourceServerRoot)
const port = await getFreePort()
let server: RunningServer | null = null

try {
  server = startServer(isolated.serverDir, port)

  console.log(`\n[startup] Чакам сървъра на порт ${port}...`)
  await waitFor(
    'server health ready',
    async () => {
      try {
        const r = await httpJson(port, 'GET', '/health', null)
        return r.status === 200 && r.body?.ok === true && r.body?.gameWorkerPool?.state === 'ready'
      } catch { return false }
    },
    SERVER_READY_TIMEOUT_MS,
  )
  console.log('  Сървърът е готов.')

  console.log('\n[auth] Регистрация на 3 test акаунта (далеч под 30/час per-IP verify лимита)...')
  const creator = await registerProfile(port, isolated.databaseFile, 'creator')
  const secondPlayer = await registerProfile(port, isolated.databaseFile, 'secondPlayer')
  const thirdPlayer = await registerProfile(port, isolated.databaseFile, 'thirdPlayer')

  // Достатъчен test wallet balance за 1 000 000 entry fee (default signup
  // bonus е далеч недостатъчен) — директен test DB setup, mirror на
  // checkPrivateRoomWebSocketRoundTrip.ts's setWalletBalance().
  setWalletBalance(isolated.databaseFile, creator.profileId, 2_000_000)
  setWalletBalance(isolated.databaseFile, secondPlayer.profileId, 2_000_000)
  // thirdPlayer умишлено НЕ се top-up-ва — остава на default (недостатъчен) баланс за CASE B.

  // ═══ CASE A: entryFee=1 000 000 пълен economy lifecycle ═══════════════

  let caseATournamentId = ''

  await check('[A1] fresh/low-level creator и second player действително са low-level (без изкуствено level boost)', async () => {
    const creatorLevel = await getProfileLevel(port, creator.cookie)
    const secondPlayerLevel = await getProfileLevel(port, secondPlayer.cookie)
    assert(typeof creatorLevel === 'number' && creatorLevel <= 1, `creator level=${creatorLevel}, очаквах <= 1`)
    assert(typeof secondPlayerLevel === 'number' && secondPlayerLevel <= 1, `secondPlayer level=${secondPlayerLevel}, очаквах <= 1`)
  })

  await check('[A2] Creator създава турнир с entryFee=1000000', async () => {
    const t = await createTournament(port, creator.cookie, { name: 'High Fee Case A', entryFee: 1_000_000 })
    assert(t.status === 200, `create status=${t.status}, body=${JSON.stringify(t.body)}`)
    assert(t.entryFee === 1_000_000, `tournament.entryFee=${t.entryFee}, очаквах 1000000`)
    caseATournamentId = t.tournamentId
  })

  await check('[A3] Second player join-ва БЕЗ level↔stake rejection, точен debit=1000000', async () => {
    const balanceBefore = await getWalletBalance(port, secondPlayer.cookie)
    const r = await httpJson(port, 'POST', `/api/tournaments/${caseATournamentId}/join`, secondPlayer.cookie, {})
    assert(r.status === 200, `join status=${r.status}, body=${JSON.stringify(r.body)} (ако е level-свързан отказ, това е regression)`)
    assert(r.body.entry.status === 'confirmed', `entry.status=${r.body.entry.status}`)
    const balanceAfter = await getWalletBalance(port, secondPlayer.cookie)
    assert(balanceBefore - balanceAfter === 1_000_000, `удържани ${balanceBefore - balanceAfter}, очаквах точно 1000000`)
  })

  await check('[A4] Creator cancel -> refund точно 1000000 обратно на second player', async () => {
    const balanceBeforeCancel = await getWalletBalance(port, secondPlayer.cookie)
    const r = await httpJson(port, 'POST', `/api/tournaments/${caseATournamentId}/cancel`, creator.cookie)
    assert(r.status === 200, `cancel status=${r.status}, body=${JSON.stringify(r.body)}`)
    assert(r.body.totalRefunded === 1_000_000, `totalRefunded=${r.body.totalRefunded}, очаквах 1000000`)
    const balanceAfterCancel = await getWalletBalance(port, secondPlayer.cookie)
    assert(balanceAfterCancel === balanceBeforeCancel + 1_000_000, `balance след cancel=${balanceAfterCancel}, очаквах ${balanceBeforeCancel + 1_000_000}`)
  })

  // ═══ CASE B: insufficient funds ════════════════════════════════════════

  let caseBTournamentId = ''

  await check('[B1] Creator създава нов турнир (entryFee=1000000) за insufficient-funds сценария', async () => {
    const t = await createTournament(port, creator.cookie, { name: 'High Fee Case B', entryFee: 1_000_000 })
    assert(t.status === 200, `create status=${t.status}, body=${JSON.stringify(t.body)}`)
    caseBTournamentId = t.tournamentId
  })

  await check('[B2] Трети fresh/low-level играч с баланс < 1000000 -> join отказан с insufficient_funds, wallet непокътнат', async () => {
    const thirdPlayerLevel = await getProfileLevel(port, thirdPlayer.cookie)
    assert(typeof thirdPlayerLevel === 'number' && thirdPlayerLevel <= 1, `thirdPlayer level=${thirdPlayerLevel}, очаквах <= 1`)

    const balanceBefore = await getWalletBalance(port, thirdPlayer.cookie)
    assert(balanceBefore < 1_000_000, `тестовият играч трябва да има баланс < 1000000, имаше ${balanceBefore}`)

    const r = await httpJson(port, 'POST', `/api/tournaments/${caseBTournamentId}/join`, thirdPlayer.cookie, {})
    assert(r.status !== 200, `очаквах отказ, получих status=${r.status}`)
    assert(r.body.reason === 'insufficient_funds', `reason=${r.body.reason}, очаквах insufficient_funds`)

    const balanceAfter = await getWalletBalance(port, thirdPlayer.cookie)
    assert(balanceAfter === balanceBefore, `wallet балансът е пипнат: before=${balanceBefore}, after=${balanceAfter}`)
  })

  // CASE B приключи, но остави отворен турнир на creator — освен
  // TOURNAMENT_CREATE_RATE_LIMIT_MAX_PER_WINDOW (3 create/60s на profileId),
  // сървърът пази и отделно правило "1 отворен self-created турнир на
  // profileId" ("Вече имаш активен турнир..."), затова го cancel-ваме тук,
  // за да освободим creator-а за следващите validation create-ове.
  await check('[B3] cleanup: creator cancel-ва CASE B турнира (освобождава го за следващите create-ове)', async () => {
    const r = await httpJson(port, 'POST', `/api/tournaments/${caseBTournamentId}/cancel`, creator.cookie)
    assert(r.status === 200, `cancel status=${r.status}, body=${JSON.stringify(r.body)}`)
  })

  // ═══ Entry-fee validation: 200000 / 500000 / 800000 приети от create ═══
  // 1000000 вече е доказано валидно (CASE A/B create-овете по-горе) — не се
  // дублира тук. Разпределени между трите акаунта (по 1 create всеки, след
  // [B3] cleanup-а всеки от трите има свободен "1 отворен self-created
  // турнир" слот), за да не се удари нито create rate limit-а, нито
  // "1 отворен турнир" правилото.

  await check('[V1] entryFee=200000 се приема като валидна стойност', async () => {
    const t = await createTournament(port, creator.cookie, { name: 'High Fee Validate 200k', entryFee: 200_000 })
    assert(t.status === 200, `status=${t.status}, body=${JSON.stringify(t.body)}`)
    assert(t.entryFee === 200_000, `entryFee=${t.entryFee}, очаквах 200000`)
  })

  await check('[V2] entryFee=500000 се приема като валидна стойност', async () => {
    const t = await createTournament(port, secondPlayer.cookie, { name: 'High Fee Validate 500k', entryFee: 500_000 })
    assert(t.status === 200, `status=${t.status}, body=${JSON.stringify(t.body)}`)
    assert(t.entryFee === 500_000, `entryFee=${t.entryFee}, очаквах 500000`)
  })

  await check('[V3] entryFee=800000 се приема като валидна стойност', async () => {
    const t = await createTournament(port, thirdPlayer.cookie, { name: 'High Fee Validate 800k', entryFee: 800_000 })
    assert(t.status === 200, `status=${t.status}, body=${JSON.stringify(t.body)}`)
    assert(t.entryFee === 800_000, `entryFee=${t.entryFee}, очаквах 800000`)
  })

  console.log('\n[cleanup] Спиране на сървъра и изтриване на временните файлове...')
} finally {
  if (server) await stopServer(server)
  await isolated.cleanup()
  console.log('  Сървърът е спрян.')
  console.log('  Временните файлове са изтрити.')
}

console.log('\n' + '═'.repeat(64))
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
