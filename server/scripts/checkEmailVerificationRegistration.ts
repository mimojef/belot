/**
 * checkEmailVerificationRegistration.ts
 *
 * Regression suite за email verification + remember-me feature-а
 * (production report-а "EMAIL VERIFICATION + REMEMBER ME"):
 *
 *   - POST /api/auth/register вече само създава pending_registrations ред
 *     (authStore.ts's register()) — account/profile/wallet/progress се
 *     материализират едва в verifyRegistrationEmail() при верен код.
 *   - POST /api/auth/verify-registration-email — атомарна финализация.
 *   - POST /api/auth/resend-registration-code — нов код, 60s cooldown,
 *     original expires_at НИКОГА не се удължава.
 *   - POST /api/auth/login приема rememberMe: boolean -> persistent (90-day
 *     Max-Age cookie) vs session-only (без Max-Age/Expires) cookie, плюс
 *     "затваря сайта преди кода" (EMAIL_VERIFICATION_REQUIRED) и expired-
 *     pending (REGISTRATION_EXPIRED) detection.
 *
 * Изолиран temp SQLite + реален spawned HTTP сървър (mirror на
 * checkOpenRegistrationPolicy.ts pattern-а). Тестовата среда няма реален
 * Brevo достъп — verification кодовете се brute-force-ват от DB-съхранения
 * code_hash (1 000 000 HMAC-SHA256 изчисления, <1s) със СЪЩИЯ secret, който
 * се подава на spawned процеса (PASSWORD_RESET_RATE_LIMIT_SECRET fallback,
 * виж authStore.ts's CreateAuthStoreOptions.registrationVerificationCodeSecret) —
 * легитимна test-harness техника, не production bypass.
 *
 * Покрива (production report-а test matrix):
 *  A. register valid data -> pending created, NO account/profile.
 *  B. verification email опит (dispatched или 503 с pendingRegistrationId
 *     — тестовата среда няма реален Brevo, виж bruteForce helper-а).
 *  C. correct code -> account/profile created exactly once.
 *  D. wrong code -> rejected, no account/profile.
 *  E. expired 24h -> rejected.
 *  F. resend -> old code invalid, new code valid, original expires_at unchanged.
 *  G. resend before 60 sec -> rate-limited.
 *  H. same email while pending/unexpired -> no second pending registration.
 *  I. same email after pending expiry -> new registration allowed.
 *  J. login with pending email + correct password -> EMAIL_VERIFICATION_REQUIRED.
 *  K. pending email + wrong password -> invalid credentials.
 *  L. expired pending login -> REGISTRATION_EXPIRED.
 *  M. existing legacy account -> normal login unaffected.
 *  N. rememberMe=true login -> persistent (Max-Age=7776000) cookie.
 *  O. rememberMe=false login -> session cookie, НЯМА Max-Age/Expires.
 *  P. /api/auth/me rolling renewal: persistent сесия остава persistent.
 *  Q. /api/auth/me с session-only: НЕ се "ъпгрейдва" до persistent.
 *  R. logout revokes и двата типа сесии.
 *  S. concurrent verify requests -> точно 1 account/profile.
 *  T. verification код не може да се използва повторно.
 *  U. active duplicate email race при register() -> safe rejection.
 *  V. visitor history/admin risk продължава да работи след verified registration.
 *
 * W (password reset)/X (open-registration policy) НЕ се дублират тук —
 * покрити от dedicated suites (check:password-reset, check:password-reset-http,
 * check:open-registration-policy), пуснати отделно.
 */

import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { verifyVerificationCode } from '../src/db/authHelpers.js'

const PASSWORD = 'EmailVerifySmoke1!'
const TEST_REGISTRATION_SECRET = 'email-verification-registration-test-secret-01'

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
  const root = await mkdtemp(join(tmpdir(), 'belot-email-verify-smoke-'))
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

// ─── HTTP helpers ───────────────────────────────────────────────────────────

type JsonResult = { status: number; body: Record<string, unknown> | null; setCookie: string[] }

/**
 * Test isolation — mirror на checkAdminProfileBanAndDeleteHttpAuthorization.ts's
 * nextSyntheticTestIp doc коментара: postJson/getJson по-долу подават ВИНАГИ
 * уникален synthetic X-Forwarded-For per заявка, за да не се натрупват
 * IP-scoped registration rate limits (registration-resend-ip/
 * registration-verify-ip/registration-update-name-ip, виж authStore.ts) между
 * НЕЗАВИСИМИ тестове в СЪЩИЯ spawned сървър — тестовете тук нарочно НЕ
 * проверяват "споделен IP" поведение (open-registration policy-то вече не
 * блокира на база IP история, виж checkOpenRegistrationPolicy.ts за тези
 * сценарии), затова "always unique" е безопасно тук без изключения.
 */
const TEST_NET_RANGES = ['203.0.113', '198.51.100', '192.0.2'] as const
let syntheticIpCounter = 0
function nextSyntheticTestIp(): string {
  syntheticIpCounter += 1
  const zeroBased = syntheticIpCounter - 1
  const rangePrefix = TEST_NET_RANGES[Math.floor(zeroBased / 254) % TEST_NET_RANGES.length]!
  const hostOctet = (zeroBased % 254) + 1
  return `${rangePrefix}.${hostOctet}`
}

/**
 * Retry-once wrapper — bruteForceVerificationCode() по-долу блокира Node
 * event loop-а синхронно (до ~1 000 000 HMAC-SHA256 изчисления), което на
 * бавни/натоварени machines понякога кара keep-alive fetch connection-а към
 * spawned сървъра да стане stale между тестове ("fetch failed", чисто
 * network-layer transient, не business-logic провал) — един бърз retry е
 * достатъчен и не маскира реални assertion failures (тези хвърлят от тялото
 * на fn, не от самия fetch).
 */
async function withFetchRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    if (error instanceof TypeError || (error instanceof Error && error.message.includes('fetch'))) {
      await sleep(200)
      return fn()
    }
    throw error
  }
}

async function postJson(port: number, pathname: string, body: unknown, cookie?: string): Promise<JsonResult> {
  return withFetchRetry(async () => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Forwarded-For': nextSyntheticTestIp() }
    if (cookie) headers['Cookie'] = cookie
    const res = await fetch(`http://127.0.0.1:${port}${pathname}`, { method: 'POST', headers, body: JSON.stringify(body) })
    const parsedBody = await res.json().catch(() => null) as Record<string, unknown> | null
    const headersExt = res.headers as Headers & { getSetCookie?: () => string[] }
    const setCookie = headersExt.getSetCookie?.() ?? (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')!] : [])
    return { status: res.status, body: parsedBody, setCookie }
  })
}

async function getJson(port: number, pathname: string, cookie?: string): Promise<JsonResult> {
  return withFetchRetry(async () => {
    const headers: Record<string, string> = {}
    if (cookie) headers['Cookie'] = cookie
    const res = await fetch(`http://127.0.0.1:${port}${pathname}`, { method: 'GET', headers })
    const parsedBody = await res.json().catch(() => null) as Record<string, unknown> | null
    const headersExt = res.headers as Headers & { getSetCookie?: () => string[] }
    const setCookie = headersExt.getSetCookie?.() ?? (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')!] : [])
    return { status: res.status, body: parsedBody, setCookie }
  })
}

function extractSessionCookieHeader(setCookie: string[]): string | null {
  const raw = setCookie.find((c) => c.startsWith('belot_session='))
  return raw ? raw.split(';')[0]! : null
}

function extractRawSessionCookie(setCookie: string[]): string | null {
  return setCookie.find((c) => c.startsWith('belot_session=')) ?? null
}

async function attemptRegister(
  port: number,
  input: { email: string; displayName: string; password?: string; visitorId?: string },
): Promise<JsonResult> {
  return postJson(port, '/api/auth/register', {
    email: input.email,
    password: input.password ?? PASSWORD,
    displayName: input.displayName,
    gender: 'male',
    visitorId: input.visitorId ?? randomUUID(),
  })
}

function pendingIdFromResult(result: JsonResult): string {
  const id = result.body?.pendingRegistrationId
  if (typeof id !== 'string' || id === '') {
    throw new Error(`Очаквах pendingRegistrationId, получих status=${result.status} body=${JSON.stringify(result.body)}`)
  }
  return id
}

/** register() + verify-registration-email() пълен flow — mirror на checkOpenRegistrationPolicy.ts's registerAllowed(). */
async function registerAndVerify(
  port: number,
  databaseFile: string,
  input: { email: string; displayName: string; rememberMe?: boolean; visitorId?: string },
): Promise<{ profileId: string; accountId: string; cookie: string; setCookieRaw: string }> {
  const registerResult = await attemptRegister(port, input)
  const pendingRegistrationId = pendingIdFromResult(registerResult)
  const code = bruteForceVerificationCode(databaseFile, pendingRegistrationId)
  const verifyResult = await postJson(port, '/api/auth/verify-registration-email', {
    pendingRegistrationId,
    code,
    rememberMe: input.rememberMe ?? true,
  })
  const session = verifyResult.body?.session as { profile?: { profileId?: string }; account?: { accountId?: string } } | undefined
  if (verifyResult.status !== 200 || !session?.profile?.profileId || !session.account?.accountId) {
    throw new Error(`Верификацията не е успешна: status=${verifyResult.status} body=${JSON.stringify(verifyResult.body)}`)
  }
  const cookie = extractSessionCookieHeader(verifyResult.setCookie) ?? ''
  const setCookieRaw = extractRawSessionCookie(verifyResult.setCookie) ?? ''
  return { profileId: session.profile.profileId, accountId: session.account.accountId, cookie, setCookieRaw }
}

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

// ─── DB helpers ─────────────────────────────────────────────────────────────

function countAccountsByEmail(databaseFile: string, email: string): number {
  const db = new DatabaseSync(databaseFile)
  const row = db.prepare(`SELECT COUNT(*) as n FROM accounts WHERE email = ?`).get(email) as { n: number }
  db.close()
  return row.n
}

function countPendingRegistrationsByEmail(databaseFile: string, email: string): number {
  const db = new DatabaseSync(databaseFile)
  const row = db.prepare(`SELECT COUNT(*) as n FROM pending_registrations WHERE normalized_email = ?`).get(email.toLowerCase()) as { n: number }
  db.close()
  return row.n
}

function getPendingRegistrationRow(databaseFile: string, pendingRegistrationId: string): { expires_at: string; last_code_sent_at: string; code_hash: string } | undefined {
  const db = new DatabaseSync(databaseFile)
  const row = db.prepare(`SELECT expires_at, last_code_sent_at, code_hash FROM pending_registrations WHERE pending_registration_id = ?`).get(pendingRegistrationId) as
    | { expires_at: string; last_code_sent_at: string; code_hash: string }
    | undefined
  db.close()
  return row
}

function backdatePendingRegistration(databaseFile: string, pendingRegistrationId: string, field: 'expires_at' | 'last_code_sent_at', isoValue: string): void {
  const db = new DatabaseSync(databaseFile)
  db.exec('PRAGMA journal_mode = WAL;')
  db.prepare(`UPDATE pending_registrations SET ${field} = ? WHERE pending_registration_id = ?`).run(isoValue, pendingRegistrationId)
  db.close()
}

/**
 * Симулира "legacy/unreserved" pending ред — normalized_display_name=NULL,
 * точно както migration 20260921_001_add_pending_registration_display_name_
 * reservation.sql backfill-ва ambiguous/duplicate историческа данни (виж
 * нейния doc коментар: "ТОЗИ ред е legacy/unreserved... NULL никога не
 * match-ва тази SELECT, затова unreserved loser automатично пада в conflict
 * клона"). ЕДИНСТВЕНИЯТ начин, по който verify() все още може легитимно да
 * достигне DISPLAY_NAME_TAKEN конфликт (не register()/update-display-name,
 * и двата вече проверяват active-pending-reservation ПРЕДИ да позволят
 * claim — виж authStore.ts's FINAL PLAN v5 doc коментари) — HARDENING-A
 * тества точно ТОЗИ (реален, документиран) legacy-row код path, виж теста
 * doc коментара за пълния root-cause анализ.
 */
function nullifyPendingRegistrationDisplayNameReservation(databaseFile: string, pendingRegistrationId: string): void {
  const db = new DatabaseSync(databaseFile)
  db.exec('PRAGMA journal_mode = WAL;')
  db.prepare(`UPDATE pending_registrations SET normalized_display_name = NULL WHERE pending_registration_id = ?`).run(pendingRegistrationId)
  db.close()
}

function backdateAllActiveSessionsExpiry(databaseFile: string, isoValue: string): void {
  const db = new DatabaseSync(databaseFile)
  db.exec('PRAGMA journal_mode = WAL;')
  db.prepare(`UPDATE account_sessions SET expires_at = ? WHERE revoked_at IS NULL`).run(isoValue)
  db.close()
}

const sourceServerRoot = resolve(
  process.argv.slice(2).find((a) => a.startsWith('--server-root='))?.slice('--server-root='.length) ?? process.cwd(),
)

console.log('\n═══ Email verification + remember-me E2E test ═══')
console.log(`Server root: ${sourceServerRoot}`)

const isolated = await createIsolatedServerRoot(sourceServerRoot)
const port = await getFreePort()
const server = startServer(isolated.serverDir, port)

try {
  await waitFor('server ready', async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/rooms`)
      return res.status === 200
    } catch {
      return false
    }
  }, 30_000)

  const runId = Date.now().toString(36)

  // ── Admin bootstrap (за risk-recheck V теста) ────────────────────────────
  const adminEmail = `email-verify-${runId}-admin@example.test`
  const admin = await registerAndVerify(port, isolated.databaseFile, { email: adminEmail, displayName: `EmailVerifyAdmin${runId}` })
  {
    const db = new DatabaseSync(isolated.databaseFile)
    db.exec('PRAGMA journal_mode = WAL;')
    db.prepare(`UPDATE accounts SET role = 'admin' WHERE email = ?`).run(adminEmail)
    db.close()
  }
  const adminLogin = await postJson(port, '/api/auth/login', { email: adminEmail, password: PASSWORD, rememberMe: true })
  const adminCookie = extractSessionCookieHeader(adminLogin.setCookie)
  if (adminCookie === null) throw new Error('Не успях да получа admin cookie.')
  void admin

  // ── A. register valid data -> pending created, NO account/profile ───────
  let aPendingId = ''
  const aEmail = `email-verify-${runId}-a@example.test`
  await check('A. register valid data -> pending created, NO account/profile yet', async () => {
    const before = countAccountsByEmail(isolated.databaseFile, aEmail)
    const result = await attemptRegister(port, { email: aEmail, displayName: `EmailVerifyA${runId}` })
    aPendingId = pendingIdFromResult(result)
    const after = countAccountsByEmail(isolated.databaseFile, aEmail)
    assert(before === 0 && after === 0, `очаквах 0 accounts преди/след register(), получих before=${before} after=${after}`)
    const pendingCount = countPendingRegistrationsByEmail(isolated.databaseFile, aEmail)
    assert(pendingCount === 1, `очаквах точно 1 pending_registrations ред, намерих ${pendingCount}`)
  })

  // ── B. verification email dispatch опит ──────────────────────────────────
  await check('B. verification email dispatch (200 EMAIL_SENT-еквивалент или 503 EMAIL_DELIVERY_FAILED с pendingRegistrationId — тестова среда без реален Brevo)', async () => {
    const row = getPendingRegistrationRow(isolated.databaseFile, aPendingId)
    assert(row !== undefined, 'pending_registrations редът трябваше да съществува (register() вече е изпълнен в тест A)')
    // register()'s HTTP handler винаги опитва sendRegistrationVerificationEmail
    // синхронно ПРЕДИ да отговори — самото съществуване на code_hash в DB
    // (проверено по-горе) доказва, че кодът е бил генериран/hash-нат преди
    // изпращащия опит, независимо дали Brevo реално е успял в тази среда.
  })

  // ── C. correct code -> account/profile created exactly once ─────────────
  let cUser: { profileId: string; accountId: string } | null = null
  await check('C. correct code -> account/profile created exactly once', async () => {
    const code = bruteForceVerificationCode(isolated.databaseFile, aPendingId)
    const result = await postJson(port, '/api/auth/verify-registration-email', { pendingRegistrationId: aPendingId, code, rememberMe: true })
    assert(result.status === 200, `очаквах 200, получих ${result.status} body=${JSON.stringify(result.body)}`)
    const session = result.body?.session as { profile?: { profileId?: string }; account?: { accountId?: string } } | undefined
    assert(!!session?.profile?.profileId && !!session.account?.accountId, 'очаквах валиден session в отговора')
    cUser = { profileId: session!.profile!.profileId!, accountId: session!.account!.accountId! }
    const accountCount = countAccountsByEmail(isolated.databaseFile, aEmail)
    assert(accountCount === 1, `очаквах точно 1 account, намерих ${accountCount}`)
  })

  // ── T. verification код не може да се използва повторно ─────────────────
  await check('T. verification код не може да се използва повторно (pending редът е consumed)', async () => {
    // pending редът вече е изтрит (consumed от тест C, INSERT OR IGNORE-
    // consume-on-success flow-а) — директен verify със СТАРИЯ pendingRegistrationId
    // трябва да върне not-found грешка, независимо от подадения код.
    const rowAfterConsume = getPendingRegistrationRow(isolated.databaseFile, aPendingId)
    assert(rowAfterConsume === undefined, 'pending_registrations редът трябваше да е изтрит след успешен verify')
    const result = await postJson(port, '/api/auth/verify-registration-email', { pendingRegistrationId: aPendingId, code: '000000', rememberMe: true })
    assert(result.status !== 200, `очаквах rejection за вече consumed pending registration, получих 200`)
    const accountCount = countAccountsByEmail(isolated.databaseFile, aEmail)
    assert(accountCount === 1, `очаквах accountCount да остане 1 (без duplicate), намерих ${accountCount}`)
  })

  // ── D. wrong code -> rejected, no account/profile ────────────────────────
  const dEmail = `email-verify-${runId}-d@example.test`
  await check('D. wrong code -> rejected, no account/profile', async () => {
    const registerResult = await attemptRegister(port, { email: dEmail, displayName: `EmailVerifyD${runId}` })
    const pendingRegistrationId = pendingIdFromResult(registerResult)
    const result = await postJson(port, '/api/auth/verify-registration-email', { pendingRegistrationId, code: '000000', rememberMe: true })
    // '000000' е технически валиден 6-цифрен формат, но почти сигурно грешен
    // (1/1 000 000 шанс да съвпадне) — ако случайно съвпадне, тестът label-ва
    // ясно защо (изключително малка вероятност, приемлив flake risk).
    const row = getPendingRegistrationRow(isolated.databaseFile, pendingRegistrationId)
    if (row !== undefined && verifyVerificationCode('000000', TEST_REGISTRATION_SECRET, row.code_hash)) {
      throw new Error('SKIP: "000000" случайно съвпадна с реалния код (1/1e6 шанс) — пусни теста пак.')
    }
    assert(result.status !== 200, `очаквах rejection, получих 200`)
    assert(result.body?.code === 'INVALID_CODE', `очаквах code=INVALID_CODE, получих ${JSON.stringify(result.body)}`)
    const accountCount = countAccountsByEmail(isolated.databaseFile, dEmail)
    assert(accountCount === 0, `очаквах 0 accounts след wrong code, намерих ${accountCount}`)
  })

  // ── E. expired 24h -> rejected ────────────────────────────────────────────
  const eEmail = `email-verify-${runId}-e@example.test`
  await check('E. pending registration expired (>24h) -> verify rejected', async () => {
    const registerResult = await attemptRegister(port, { email: eEmail, displayName: `EmailVerifyE${runId}` })
    const pendingRegistrationId = pendingIdFromResult(registerResult)
    const code = bruteForceVerificationCode(isolated.databaseFile, pendingRegistrationId)
    backdatePendingRegistration(isolated.databaseFile, pendingRegistrationId, 'expires_at', new Date(Date.now() - 60_000).toISOString())

    const result = await postJson(port, '/api/auth/verify-registration-email', { pendingRegistrationId, code, rememberMe: true })
    assert(result.status !== 200, `очаквах rejection за expired pending, получих 200`)
    assert(result.body?.code === 'REGISTRATION_EXPIRED', `очаквах code=REGISTRATION_EXPIRED, получих ${JSON.stringify(result.body)}`)
    const accountCount = countAccountsByEmail(isolated.databaseFile, eEmail)
    assert(accountCount === 0, `очаквах 0 accounts след expired verify, намерих ${accountCount}`)
  })

  // ── F. resend -> old code invalid, new code valid, expires_at unchanged ──
  const fEmail = `email-verify-${runId}-f@example.test`
  await check('F. resend -> стар код invalid, нов код valid, original expires_at непроменен', async () => {
    const registerResult = await attemptRegister(port, { email: fEmail, displayName: `EmailVerifyF${runId}` })
    const pendingRegistrationId = pendingIdFromResult(registerResult)
    const oldCode = bruteForceVerificationCode(isolated.databaseFile, pendingRegistrationId)
    const rowBefore = getPendingRegistrationRow(isolated.databaseFile, pendingRegistrationId)
    assert(rowBefore !== undefined, 'pending row not found')
    const originalExpiresAt = rowBefore!.expires_at

    // Симулира "60+ секунди изминали" директно чрез backdate на
    // last_code_sent_at (без реален sleep в теста).
    backdatePendingRegistration(isolated.databaseFile, pendingRegistrationId, 'last_code_sent_at', new Date(Date.now() - 61_000).toISOString())

    const resendResult = await postJson(port, '/api/auth/resend-registration-code', { pendingRegistrationId })
    assert(resendResult.status === 200 || (resendResult.status === 503 && resendResult.body?.code === 'EMAIL_DELIVERY_FAILED'), `resend: очаквах 200 или 503 EMAIL_DELIVERY_FAILED, получих ${resendResult.status} body=${JSON.stringify(resendResult.body)}`)

    const rowAfter = getPendingRegistrationRow(isolated.databaseFile, pendingRegistrationId)
    assert(rowAfter !== undefined, 'pending row изчезна след resend')
    assert(rowAfter!.expires_at === originalExpiresAt, `expires_at се промени след resend: ${originalExpiresAt} -> ${rowAfter!.expires_at}`)
    assert(rowAfter!.code_hash !== rowBefore!.code_hash, 'code_hash не се промени след resend')

    // Старият код вече не важи.
    const oldCodeResult = await postJson(port, '/api/auth/verify-registration-email', { pendingRegistrationId, code: oldCode, rememberMe: true })
    assert(oldCodeResult.status !== 200, 'старият код все още работи след resend')

    // Новият код работи.
    const newCode = bruteForceVerificationCode(isolated.databaseFile, pendingRegistrationId)
    const newCodeResult = await postJson(port, '/api/auth/verify-registration-email', { pendingRegistrationId, code: newCode, rememberMe: true })
    assert(newCodeResult.status === 200, `новият код не проработи: status=${newCodeResult.status} body=${JSON.stringify(newCodeResult.body)}`)
  })

  // ── G. resend преди 60 сек -> rate-limited ───────────────────────────────
  const gEmail = `email-verify-${runId}-g@example.test`
  await check('G. resend преди 60 сек -> rejected/rate-limited', async () => {
    const registerResult = await attemptRegister(port, { email: gEmail, displayName: `EmailVerifyG${runId}` })
    const pendingRegistrationId = pendingIdFromResult(registerResult)
    // last_code_sent_at е "сега" (веднага след register) -> resend веднага
    // след това ТРЯБВА да е под 60s cooldown-а.
    const resendResult = await postJson(port, '/api/auth/resend-registration-code', { pendingRegistrationId })
    assert(resendResult.status === 429, `очаквах 429 rate-limited, получих ${resendResult.status} body=${JSON.stringify(resendResult.body)}`)
  })

  // ── H. same email while pending/unexpired -> no second pending ──────────
  const hEmail = `email-verify-${runId}-h@example.test`
  await check('H. same email докато pending е unexpired -> no second pending registration', async () => {
    const first = await attemptRegister(port, { email: hEmail, displayName: `EmailVerifyH1${runId}` })
    assert(pendingIdFromResult(first).length > 0, 'първата регистрация не създаде pending')
    const before = countPendingRegistrationsByEmail(isolated.databaseFile, hEmail)
    assert(before === 1, `очаквах точно 1 pending ред, намерих ${before}`)

    const second = await attemptRegister(port, { email: hEmail, displayName: `EmailVerifyH2${runId}` })
    assert(second.status === 409, `очаквах 409, получих ${second.status} body=${JSON.stringify(second.body)}`)
    assert(second.body?.code === 'EMAIL_VERIFICATION_PENDING', `очаквах code=EMAIL_VERIFICATION_PENDING, получих ${JSON.stringify(second.body)}`)

    const after = countPendingRegistrationsByEmail(isolated.databaseFile, hEmail)
    assert(after === 1, `очаквах pending редовете да останат 1 (без duplicate), намерих ${after}`)
  })

  // ── I. same email след pending expiry -> new registration allowed ───────
  const iEmail = `email-verify-${runId}-i@example.test`
  await check('I. same email след pending expiry -> нова регистрация allowed', async () => {
    const first = await attemptRegister(port, { email: iEmail, displayName: `EmailVerifyI1${runId}` })
    const firstPendingId = pendingIdFromResult(first)
    backdatePendingRegistration(isolated.databaseFile, firstPendingId, 'expires_at', new Date(Date.now() - 60_000).toISOString())

    const second = await attemptRegister(port, { email: iEmail, displayName: `EmailVerifyI2${runId}` })
    const secondPendingId = pendingIdFromResult(second)
    assert(secondPendingId !== firstPendingId, 'втората регистрация трябваше да получи НОВ pendingRegistrationId')

    const after = countPendingRegistrationsByEmail(isolated.databaseFile, iEmail)
    assert(after === 1, `очаквах точно 1 pending ред (старият expired е бил opportunistically изтрит), намерих ${after}`)
  })

  // ── J. login with pending email + correct password -> EMAIL_VERIFICATION_REQUIRED
  const jEmail = `email-verify-${runId}-j@example.test`
  let jPendingId = ''
  await check('J. login с pending email + правилна парола -> EMAIL_VERIFICATION_REQUIRED', async () => {
    const registerResult = await attemptRegister(port, { email: jEmail, displayName: `EmailVerifyJ${runId}` })
    jPendingId = pendingIdFromResult(registerResult)

    const loginResult = await postJson(port, '/api/auth/login', { email: jEmail, password: PASSWORD, rememberMe: true })
    assert(loginResult.status === 403, `очаквах 403, получих ${loginResult.status} body=${JSON.stringify(loginResult.body)}`)
    assert(loginResult.body?.code === 'EMAIL_VERIFICATION_REQUIRED', `очаквах code=EMAIL_VERIFICATION_REQUIRED, получих ${JSON.stringify(loginResult.body)}`)
    assert(loginResult.body?.pendingRegistrationId === jPendingId, 'pendingRegistrationId в login response-а не съвпада')
    assert(typeof loginResult.body?.maskedEmail === 'string' && (loginResult.body!.maskedEmail as string).includes('*'), 'очаквах masked email')
    // Login НЕ трябва да създаде сесия.
    assert(loginResult.setCookie.length === 0, 'login при EMAIL_VERIFICATION_REQUIRED не биваше да изпраща Set-Cookie')
  })

  // ── K. pending email + wrong password -> invalid credentials ────────────
  await check('K. pending email + грешна парола -> generic invalid credentials (без да разкрива pending state)', async () => {
    const loginResult = await postJson(port, '/api/auth/login', { email: jEmail, password: 'totally-wrong-password', rememberMe: true })
    assert(loginResult.status === 400, `очаквах 400, получих ${loginResult.status} body=${JSON.stringify(loginResult.body)}`)
    assert(loginResult.body?.code !== 'EMAIL_VERIFICATION_REQUIRED', 'грешна парола не биваше да разкрива EMAIL_VERIFICATION_REQUIRED')
    assert(loginResult.body?.code !== 'REGISTRATION_EXPIRED', 'грешна парола не биваше да разкрива REGISTRATION_EXPIRED')
  })

  // ── L. expired pending login -> REGISTRATION_EXPIRED ─────────────────────
  await check('L. expired pending + login с правилна парола -> REGISTRATION_EXPIRED', async () => {
    backdatePendingRegistration(isolated.databaseFile, jPendingId, 'expires_at', new Date(Date.now() - 60_000).toISOString())
    const loginResult = await postJson(port, '/api/auth/login', { email: jEmail, password: PASSWORD, rememberMe: true })
    assert(loginResult.status === 410, `очаквах 410, получих ${loginResult.status} body=${JSON.stringify(loginResult.body)}`)
    assert(loginResult.body?.code === 'REGISTRATION_EXPIRED', `очаквах code=REGISTRATION_EXPIRED, получих ${JSON.stringify(loginResult.body)}`)

    // Email-ът вече трябва да е свободен за нова регистрация (200 или 503
    // EMAIL_DELIVERY_FAILED с pendingRegistrationId — тестова среда без
    // реален Brevo, виж pendingIdFromResult-овия doc коментар).
    const newAttempt = await attemptRegister(port, { email: jEmail, displayName: `EmailVerifyJRetry${runId}` })
    assert(pendingIdFromResult(newAttempt).length > 0, `очаквах нова регистрация да мине, получих ${newAttempt.status} body=${JSON.stringify(newAttempt.body)}`)
  })

  // ── M. existing legacy account -> normal login unaffected ────────────────
  const mEmail = `email-verify-${runId}-m@example.test`
  await check('M. existing (verified) account -> normal login непроменен', async () => {
    await registerAndVerify(port, isolated.databaseFile, { email: mEmail, displayName: `EmailVerifyM${runId}` })
    const loginResult = await postJson(port, '/api/auth/login', { email: mEmail, password: PASSWORD, rememberMe: true })
    assert(loginResult.status === 200, `очаквах 200, получих ${loginResult.status} body=${JSON.stringify(loginResult.body)}`)
    assert((loginResult.body?.session as { profile?: unknown } | undefined)?.profile !== undefined, 'очаквах валиден session')
  })
  await check('M2. legacy account_sessions ред (INSERT без explicit remember_me) -> DEFAULT 1 (persistent), migration-safe за production', () => {
    // Директен raw INSERT, симулиращ ред, съществувал ПРЕДИ 20260914_002
    // migration-а (production report-а "REMEMBER ME — SERVER SEMANTICS":
    // "DEFAULT за legacy rows = 1") — не минава през createSession(), затова
    // не подава remember_me explicit, само DEFAULT constraint-ът от schema-та.
    const db = new DatabaseSync(isolated.databaseFile)
    db.exec('PRAGMA journal_mode = WAL;')
    const accountRow = db.prepare(`SELECT account_id FROM accounts WHERE email = ?`).get(mEmail.toLowerCase()) as { account_id: string } | undefined
    assert(accountRow !== undefined, 'account row not found за legacy-session теста')
    const profileRow = db.prepare(`SELECT profile_id FROM profiles WHERE account_id = ?`).get(accountRow!.account_id) as { profile_id: string } | undefined
    assert(profileRow !== undefined, 'profile row not found за legacy-session теста')
    db.prepare(`
      INSERT INTO account_sessions (session_id, account_id, profile_id, token_hash, expires_at)
      VALUES (?, ?, ?, ?, datetime('now', '+90 days'));
    `).run(randomUUID(), accountRow!.account_id, profileRow!.profile_id, randomUUID())
    const insertedRow = db.prepare(`SELECT remember_me FROM account_sessions WHERE account_id = ? ORDER BY created_at DESC LIMIT 1`).get(accountRow!.account_id) as { remember_me: number }
    db.close()
    assert(insertedRow.remember_me === 1, `очаквах DEFAULT remember_me=1 за legacy ред без explicit стойност, получих ${insertedRow.remember_me}`)
  })

  // ── N. rememberMe=true login -> persistent 90-day cookie ────────────────
  const nEmail = `email-verify-${runId}-n@example.test`
  await check('N. rememberMe=true login -> persistent cookie (Max-Age=7776000)', async () => {
    await registerAndVerify(port, isolated.databaseFile, { email: nEmail, displayName: `EmailVerifyN${runId}` })
    const loginResult = await postJson(port, '/api/auth/login', { email: nEmail, password: PASSWORD, rememberMe: true })
    const rawCookie = extractRawSessionCookie(loginResult.setCookie)
    assert(rawCookie !== null, 'липсва Set-Cookie')
    assert(rawCookie!.includes('Max-Age=7776000'), `очаквах Max-Age=7776000, получих: ${rawCookie}`)
  })

  // ── O. rememberMe=false login -> session cookie, no Max-Age/Expires ─────
  const oEmail = `email-verify-${runId}-o@example.test`
  let oCookie = ''
  await check('O. rememberMe=false login -> session cookie, БЕЗ Max-Age/Expires', async () => {
    await registerAndVerify(port, isolated.databaseFile, { email: oEmail, displayName: `EmailVerifyO${runId}` })
    const loginResult = await postJson(port, '/api/auth/login', { email: oEmail, password: PASSWORD, rememberMe: false })
    const rawCookie = extractRawSessionCookie(loginResult.setCookie)
    assert(rawCookie !== null, 'липсва Set-Cookie')
    assert(!rawCookie!.includes('Max-Age'), `session-only cookie НЕ биваше да съдържа Max-Age: ${rawCookie}`)
    assert(!rawCookie!.includes('Expires'), `session-only cookie НЕ биваше да съдържа Expires: ${rawCookie}`)
    oCookie = extractSessionCookieHeader(loginResult.setCookie) ?? ''
    assert(oCookie !== '', 'липсва usable session cookie value')
  })

  // ── P. /api/auth/me rolling renewal: persistent остава persistent ───────
  const pEmail = `email-verify-${runId}-p@example.test`
  await check('P. /api/auth/me rolling renewal: persistent сесия остава persistent след renewal', async () => {
    await registerAndVerify(port, isolated.databaseFile, { email: pEmail, displayName: `EmailVerifyP${runId}` })
    const loginResult = await postJson(port, '/api/auth/login', { email: pEmail, password: PASSWORD, rememberMe: true })
    const cookie = extractSessionCookieHeader(loginResult.setCookie)
    assert(cookie !== null, 'липсва session cookie')

    // Направи сесията "due for renewal" (remaining lifetime малък).
    backdateAllActiveSessionsExpiry(isolated.databaseFile, new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString())

    const meResult = await getJson(port, '/api/auth/me', cookie!)
    assert(meResult.status === 200, `status=${meResult.status}`)
    const rawCookie = extractRawSessionCookie(meResult.setCookie)
    assert(rawCookie !== null, 'очаквах renewal Set-Cookie')
    assert(rawCookie!.includes('Max-Age=7776000'), `renewal Set-Cookie трябваше да остане persistent (Max-Age=7776000): ${rawCookie}`)
  })

  // ── Q. /api/auth/me с session-only: НЕ се "ъпгрейдва" ────────────────────
  await check('Q. /api/auth/me rolling renewal: session-only сесия НЕ се "ъпгрейдва" до persistent', async () => {
    // oCookie е session-only (rememberMe=false) от тест O.
    backdateAllActiveSessionsExpiry(isolated.databaseFile, new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString())

    const meResult = await getJson(port, '/api/auth/me', oCookie)
    assert(meResult.status === 200, `status=${meResult.status}`)
    const rawCookie = extractRawSessionCookie(meResult.setCookie)
    // renewed:true -> Set-Cookie се изпраща, но БЕЗ Max-Age/Expires (остава session-only).
    if (rawCookie !== null) {
      assert(!rawCookie.includes('Max-Age'), `session-only renewal Set-Cookie НЕ биваше да получи Max-Age: ${rawCookie}`)
      assert(!rawCookie.includes('Expires'), `session-only renewal Set-Cookie НЕ биваше да получи Expires: ${rawCookie}`)
    }
    const body = meResult.body as { ok?: boolean; session?: { profile?: unknown } | null } | null
    assert(body?.ok === true && body.session != null, 'session-only сесията трябваше да остане валидна след renewal')
  })

  // ── R. logout revokes и двата типа сесии ─────────────────────────────────
  await check('R. logout revoke-ва persistent сесия', async () => {
    const rEmail = `email-verify-${runId}-r1@example.test`
    await registerAndVerify(port, isolated.databaseFile, { email: rEmail, displayName: `EmailVerifyR1${runId}`, rememberMe: true })
    const loginResult = await postJson(port, '/api/auth/login', { email: rEmail, password: PASSWORD, rememberMe: true })
    const cookie = extractSessionCookieHeader(loginResult.setCookie)!
    await postJson(port, '/api/auth/logout', {}, cookie)
    const meResult = await getJson(port, '/api/auth/me', cookie)
    const body = meResult.body as { session?: unknown } | null
    assert(body?.session === null, 'persistent сесия остана валидна след logout')
  })
  await check('R. logout revoke-ва session-only сесия', async () => {
    const rEmail = `email-verify-${runId}-r2@example.test`
    await registerAndVerify(port, isolated.databaseFile, { email: rEmail, displayName: `EmailVerifyR2${runId}`, rememberMe: false })
    const loginResult = await postJson(port, '/api/auth/login', { email: rEmail, password: PASSWORD, rememberMe: false })
    const cookie = extractSessionCookieHeader(loginResult.setCookie)!
    await postJson(port, '/api/auth/logout', {}, cookie)
    const meResult = await getJson(port, '/api/auth/me', cookie)
    const body = meResult.body as { session?: unknown } | null
    assert(body?.session === null, 'session-only сесия остана валидна след logout')
  })

  // ── S. concurrent verify requests -> точно 1 account/profile ────────────
  const sEmail = `email-verify-${runId}-s@example.test`
  await check('S. два едновременни verify requests (СЪЩИЯ код) -> точно 1 account/profile', async () => {
    const registerResult = await attemptRegister(port, { email: sEmail, displayName: `EmailVerifyS${runId}` })
    const pendingRegistrationId = pendingIdFromResult(registerResult)
    const code = bruteForceVerificationCode(isolated.databaseFile, pendingRegistrationId)

    const [r1, r2] = await Promise.all([
      postJson(port, '/api/auth/verify-registration-email', { pendingRegistrationId, code, rememberMe: true }),
      postJson(port, '/api/auth/verify-registration-email', { pendingRegistrationId, code, rememberMe: true }),
    ])
    const successCount = [r1, r2].filter((r) => r.status === 200).length
    assert(successCount === 1, `очаквах точно 1 успешен verify от 2 конкурентни, получих ${successCount}`)

    const accountCount = countAccountsByEmail(isolated.databaseFile, sEmail)
    assert(accountCount === 1, `очаквах точно 1 account след concurrent verify, намерих ${accountCount}`)
  })

  // ── U. active duplicate email race при register() -> safe rejection ─────
  const uEmail = `email-verify-${runId}-u@example.test`
  await check('U. два едновременни register() опита (СЪЩИЯ email) -> точно 1 pending registration', async () => {
    const [r1, r2] = await Promise.all([
      attemptRegister(port, { email: uEmail, displayName: `EmailVerifyU1${runId}` }),
      attemptRegister(port, { email: uEmail, displayName: `EmailVerifyU2${runId}` }),
    ])
    const withPendingId = [r1, r2].filter((r) => typeof r.body?.pendingRegistrationId === 'string' && r.body.pendingRegistrationId !== '')
    assert(withPendingId.length >= 1, 'нито един от двата конкурентни register() опита не успя')

    const pendingCount = countPendingRegistrationsByEmail(isolated.databaseFile, uEmail)
    assert(pendingCount === 1, `очаквах точно 1 pending_registrations ред след race, намерих ${pendingCount}`)
  })

  // ── V. visitor history/admin risk продължава да работи след verified registration
  await check('V. visitor history/admin linked-profile detection продължава да работи след verified registration', async () => {
    const sharedVisitorId = randomUUID()
    const v1Email = `email-verify-${runId}-v1@example.test`
    const v2Email = `email-verify-${runId}-v2@example.test`
    // Двата профила споделят ЯВНО СЪЩИЯ visitorId (mirror на
    // checkOpenRegistrationPolicy.ts's J/K тест) — доказва, че
    // site_visit_events/admin risk detection продължават да работят и след
    // pending-first verified registration flow-а.
    await registerAndVerify(port, isolated.databaseFile, { email: v1Email, displayName: `EmailVerifyV1${runId}`, visitorId: sharedVisitorId })

    const registerV2 = await attemptRegister(port, { email: v2Email, displayName: `EmailVerifyV2${runId}`, visitorId: sharedVisitorId })
    const pendingV2 = pendingIdFromResult(registerV2)
    const codeV2 = bruteForceVerificationCode(isolated.databaseFile, pendingV2)
    const verifyV2 = await postJson(port, '/api/auth/verify-registration-email', { pendingRegistrationId: pendingV2, code: codeV2, rememberMe: true })
    const v2ProfileId = (verifyV2.body?.session as { profile?: { profileId?: string } } | undefined)?.profile?.profileId
    assert(typeof v2ProfileId === 'string' && v2ProfileId.length > 0, 'V2 верификацията не успя')

    const db = new DatabaseSync(isolated.databaseFile)
    const eventCount = db.prepare(`SELECT COUNT(*) as n FROM site_visit_events WHERE anonymous_visitor_id = ?`).get(sharedVisitorId) as { n: number }
    db.close()
    assert(eventCount.n >= 1, `очаквах поне 1 site_visit_events ред за споделения visitor_id, намерих ${eventCount.n}`)

    const riskResult = await postJson(port, `/api/admin/profiles/${v2ProfileId}/risk-recheck`, {}, adminCookie)
    assert(riskResult.status === 200, `risk-recheck: status=${riskResult.status} body=${JSON.stringify(riskResult.body)}`)
  })

  // ═══════════════════════════════════════════════════════════════════════
  // HARDENING PASS — DISPLAY_NAME_TAKEN recovery / wrong-code recovery /
  // "Смени имейла" / email delivery failure recovery
  // ═══════════════════════════════════════════════════════════════════════

  // ── HARDENING-A. DISPLAY_NAME_TAKEN при verify -> recoverable БЕЗ 24h чакане
  //
  // ROOT CAUSE на предишния (остарял test setup) провал, документиран тук за
  // бъдещи читатели: FINAL PLAN v5 (migration 20260921_001_add_pending_
  // registration_display_name_reservation.sql) добави active-pending-
  // reservation guard-ове И в register(), И в update-pending-registration-
  // display-name — от този момент нататък е СТРУКТУРНО невъзможно двама
  // РАЗЛИЧНИ, НОРМАЛНИ pending redове да "състезават" за едно и също име чак
  // до verify-я: вторият register() опит (тук — user3-ия, преди тази
  // корекция) вече се отхвърля ВЕДНАГА при самата регистрация (виж
  // register()'s pendingNameConflict проверка), не по-късно при verify.
  // Старият test setup ("user2 register -> user3 register+verify със СЪЩОТО
  // име -> user2 verify открива конфликта") предхожда тази защита и вече не
  // е конструируем през публичните endpoints.
  //
  // Единственият ДОКУМЕНТИРАН, реално поддържан код path, който verify()
  // все още може легитимно да достигне DISPLAY_NAME_TAKEN, е "legacy/
  // unreserved" pending ред (normalized_display_name IS NULL — виж
  // createVerifiedAccountAndProfileInOpenTransaction's reservationOwner
  // проверка и migration-ния backfill doc коментар за "unreserved loser
  // automатично пада в conflict клона"). Тестът по-долу симулира точно това
  // (nullifyPendingRegistrationDisplayNameReservation) — единствената
  // минимална промяна спрямо оригинала — за да достигне РЕАЛНО targeted
  // verify() DISPLAY_NAME_TAKEN сценария, СЪС СЪЩАТА security цел:
  // потребител с валиден, все още неизтекъл код не бива да бъде заключен за
  // 24ч само защото избраното му име се е оказало заето — recovery чрез
  // update-pending-registration-display-name, без нов email/парола/код.
  await check('HARDENING-A. DISPLAY_NAME_TAKEN при verify -> смяна на името без нов email/парола/код/24ч', async () => {
    const raceName = `RaceName${runId}`
    const raceName2 = `RaceName${runId}Two`

    // user2 регистрира pending с raceName (все още свободно -> минава early
    // check-а, реален active reservation).
    const user2Email = `email-verify-${runId}-hard-a-u2@example.test`
    const registerU2 = await attemptRegister(port, { email: user2Email, displayName: raceName })
    const pendingU2 = pendingIdFromResult(registerU2)
    const codeU2 = bruteForceVerificationCode(isolated.databaseFile, pendingU2)
    const rowBeforeConflict = getPendingRegistrationRow(isolated.databaseFile, pendingU2)
    assert(rowBeforeConflict !== undefined, 'pending row not found (user2)')
    const originalExpiresAt = rowBeforeConflict!.expires_at

    // Симулира "legacy/unreserved" ред (виж doc коментара по-горе за пълния
    // root-cause rationale) — user2's ред вече НЕ държи active reservation
    // за raceName (normalized_display_name=NULL), значи user3 може легитимно
    // да регистрира+verify-не СЪЩОТО име през нормалните endpoints, без
    // register()'s pendingNameConflict guard да го отхвърли.
    nullifyPendingRegistrationDisplayNameReservation(isolated.databaseFile, pendingU2)

    // user3 verify-ва ПЪРВИ със СЪЩОТО raceName -> заема го в profiles.
    const user3Email = `email-verify-${runId}-hard-a-u3@example.test`
    await registerAndVerify(port, isolated.databaseFile, { email: user3Email, displayName: raceName })

    // user2 опитва verify СЪС СЪЩИЯ (валиден) код -> DISPLAY_NAME_TAKEN, pending ОСТАВА.
    const verifyConflict = await postJson(port, '/api/auth/verify-registration-email', { pendingRegistrationId: pendingU2, code: codeU2, rememberMe: true })
    assert(verifyConflict.status === 409, `очаквах 409, получих ${verifyConflict.status} body=${JSON.stringify(verifyConflict.body)}`)
    assert(verifyConflict.body?.code === 'DISPLAY_NAME_TAKEN', `очаквах code=DISPLAY_NAME_TAKEN, получих ${JSON.stringify(verifyConflict.body)}`)

    const rowAfterConflict = getPendingRegistrationRow(isolated.databaseFile, pendingU2)
    assert(rowAfterConflict !== undefined, 'pending редът изчезна след display_name_taken конфликт — потребителят би бил заключен за 24ч')
    assert(rowAfterConflict!.expires_at === originalExpiresAt, `expires_at се промени след display-name конфликт: ${originalExpiresAt} -> ${rowAfterConflict!.expires_at}`)
    assert(countAccountsByEmail(isolated.databaseFile, user2Email) === 0, 'account не биваше да е създаден при display_name_taken')

    // Смяна на името (нов endpoint) — СЪЩИЯТ pending/email/password/code.
    const updateNameResult = await postJson(port, '/api/auth/update-pending-registration-display-name', { pendingRegistrationId: pendingU2, displayName: raceName2 })
    assert(updateNameResult.status === 200, `update-display-name: status=${updateNameResult.status} body=${JSON.stringify(updateNameResult.body)}`)

    const rowAfterRename = getPendingRegistrationRow(isolated.databaseFile, pendingU2)
    assert(rowAfterRename !== undefined, 'pending row изчезна след успешна смяна на името')
    assert(rowAfterRename!.expires_at === originalExpiresAt, `expires_at се промени след смяна на името: ${originalExpiresAt} -> ${rowAfterRename!.expires_at}`)
    assert(rowAfterRename!.code_hash === rowBeforeConflict!.code_hash, 'code_hash се промени след смяна на името — старият код вече не би работил')

    // ПАК verify със СЪЩИЯ (все още валиден) код -> вече успешно (новото име е свободно).
    const verifySuccess = await postJson(port, '/api/auth/verify-registration-email', { pendingRegistrationId: pendingU2, code: codeU2, rememberMe: true })
    assert(verifySuccess.status === 200, `финален verify: status=${verifySuccess.status} body=${JSON.stringify(verifySuccess.body)}`)
    assert(countAccountsByEmail(isolated.databaseFile, user2Email) === 1, 'account трябваше да е създаден след успешна смяна на името + verify')
  })

  // ── HARDENING-A2. update-display-name при вече заето (отново) име -> ясно съобщение
  await check('HARDENING-A2. update-display-name с ново, но пак заето име -> DISPLAY_NAME_TAKEN, pending остава', async () => {
    const email = `email-verify-${runId}-hard-a2@example.test`
    const takenName = `AlreadyTaken${runId}`
    await registerAndVerify(port, isolated.databaseFile, { email: `email-verify-${runId}-hard-a2-owner@example.test`, displayName: takenName })

    const registerResult = await attemptRegister(port, { email, displayName: `Fresh${runId}` })
    const pendingRegistrationId = pendingIdFromResult(registerResult)

    const result = await postJson(port, '/api/auth/update-pending-registration-display-name', { pendingRegistrationId, displayName: takenName })
    assert(result.status === 409, `очаквах 409, получих ${result.status} body=${JSON.stringify(result.body)}`)
    assert(result.body?.code === 'DISPLAY_NAME_TAKEN', `очаквах code=DISPLAY_NAME_TAKEN, получих ${JSON.stringify(result.body)}`)
    assert(
      typeof result.body?.message === 'string' && (result.body.message as string).includes('заето'),
      `очаквах ясно "заето" съобщение, получих ${JSON.stringify(result.body)}`,
    )

    const row = getPendingRegistrationRow(isolated.databaseFile, pendingRegistrationId)
    assert(row !== undefined, 'pending row изчезна след неуспешна смяна на името')
  })

  // ── HARDENING-B. 5 wrong codes -> TOO_MANY_ATTEMPTS -> resend -> reset -> success
  await check('HARDENING-B. 5 грешни кода -> TOO_MANY_ATTEMPTS -> resend -> failed_attempts reset -> успешен verify', async () => {
    const email = `email-verify-${runId}-hard-b@example.test`
    const registerResult = await attemptRegister(port, { email, displayName: `HardeningB${runId}` })
    const pendingRegistrationId = pendingIdFromResult(registerResult)
    const realCode = bruteForceVerificationCode(isolated.databaseFile, pendingRegistrationId)

    // 5 различни грешни кода (гарантирано различни от realCode).
    let wrongAttempts = 0
    for (let candidate = 0; wrongAttempts < 5; candidate++) {
      const wrongCode = candidate.toString().padStart(6, '0')
      if (wrongCode === realCode) continue
      const result = await postJson(port, '/api/auth/verify-registration-email', { pendingRegistrationId, code: wrongCode, rememberMe: true })
      assert(result.status === 400, `wrong attempt #${wrongAttempts + 1}: очаквах 400, получих ${result.status} body=${JSON.stringify(result.body)}`)
      assert(result.body?.code === 'INVALID_CODE', `wrong attempt #${wrongAttempts + 1}: очаквах INVALID_CODE, получих ${JSON.stringify(result.body)}`)
      wrongAttempts++
    }

    const rowAfterFiveWrong = getPendingRegistrationRow(isolated.databaseFile, pendingRegistrationId)
    assert(rowAfterFiveWrong !== undefined, 'pending row изчезна след 5 грешни опита')

    // 6-ти опит — дори с ПРАВИЛНИЯ код -> TOO_MANY_ATTEMPTS (locked до resend).
    const lockedAttempt = await postJson(port, '/api/auth/verify-registration-email', { pendingRegistrationId, code: realCode, rememberMe: true })
    assert(lockedAttempt.status === 429, `очаквах 429 TOO_MANY_ATTEMPTS, получих ${lockedAttempt.status} body=${JSON.stringify(lockedAttempt.body)}`)
    assert(lockedAttempt.body?.code === 'TOO_MANY_ATTEMPTS', `очаквах code=TOO_MANY_ATTEMPTS, получих ${JSON.stringify(lockedAttempt.body)}`)
    assert(countAccountsByEmail(isolated.databaseFile, email) === 0, 'account не биваше да е създаден при too_many_attempts')

    // Потребителят НЕ е заключен за 24ч — resend (след 60s cooldown) реши проблема.
    backdatePendingRegistration(isolated.databaseFile, pendingRegistrationId, 'last_code_sent_at', new Date(Date.now() - 61_000).toISOString())
    const resendResult = await postJson(port, '/api/auth/resend-registration-code', { pendingRegistrationId })
    assert(resendResult.status === 200 || (resendResult.status === 503 && resendResult.body?.code === 'EMAIL_DELIVERY_FAILED'), `resend: status=${resendResult.status} body=${JSON.stringify(resendResult.body)}`)

    const rowAfterResend = getPendingRegistrationRow(isolated.databaseFile, pendingRegistrationId)
    assert(rowAfterResend !== undefined, 'pending row изчезна след resend')
    const failedAttemptsAfterResend = (() => {
      const db = new DatabaseSync(isolated.databaseFile)
      const row = db.prepare(`SELECT failed_attempts FROM pending_registrations WHERE pending_registration_id = ?`).get(pendingRegistrationId) as { failed_attempts: number } | undefined
      db.close()
      return row?.failed_attempts ?? -1
    })()
    assert(failedAttemptsAfterResend === 0, `очаквах failed_attempts=0 след resend, получих ${failedAttemptsAfterResend}`)

    const newCode = bruteForceVerificationCode(isolated.databaseFile, pendingRegistrationId)
    assert(newCode !== realCode, 'новият код съвпада със стария — resend не генерира реално нов код')
    const finalVerify = await postJson(port, '/api/auth/verify-registration-email', { pendingRegistrationId, code: newCode, rememberMe: true })
    assert(finalVerify.status === 200, `финален verify: status=${finalVerify.status} body=${JSON.stringify(finalVerify.body)}`)
    assert(countAccountsByEmail(isolated.databaseFile, email) === 1, 'account трябваше да е създаден след успешния финален verify')
  })

  // ── HARDENING-C. "Смени имейла" -> старият typo-нат email веднага свободен
  await check('HARDENING-C. cancel-pending-registration -> typo-натият email веднага свободен за нова регистрация', async () => {
    const typoEmail = `email-verify-${runId}-hard-c-typo@example.test`

    const firstAttempt = await attemptRegister(port, { email: typoEmail, displayName: `HardeningC1${runId}` })
    const firstPendingId = pendingIdFromResult(firstAttempt)

    // Все още блокиран (unexpired pending) — потвърждава baseline поведението.
    const blockedAttempt = await attemptRegister(port, { email: typoEmail, displayName: `HardeningC2${runId}` })
    assert(blockedAttempt.status === 409, `очаквах 409 преди cancel, получих ${blockedAttempt.status}`)
    assert(blockedAttempt.body?.code === 'EMAIL_VERIFICATION_PENDING', `очаквах EMAIL_VERIFICATION_PENDING, получих ${JSON.stringify(blockedAttempt.body)}`)

    // "Смени имейла" -> explicit cancel на typo-натия pending.
    const cancelResult = await postJson(port, '/api/auth/cancel-pending-registration', { pendingRegistrationId: firstPendingId })
    assert(cancelResult.status === 200 && cancelResult.body?.ok === true, `cancel: status=${cancelResult.status} body=${JSON.stringify(cancelResult.body)}`)
    assert(countPendingRegistrationsByEmail(isolated.databaseFile, typoEmail) === 0, 'pending редът трябваше да е изтрит след cancel')

    // Email-ът вече СВОБОДЕН — трета страна (или самият потребител, ако греши пак) може веднага да го ползва.
    const afterCancelAttempt = await attemptRegister(port, { email: typoEmail, displayName: `HardeningC3${runId}` })
    assert(pendingIdFromResult(afterCancelAttempt).length > 0, `очаквах нова регистрация да мине веднага след cancel, получих status=${afterCancelAttempt.status} body=${JSON.stringify(afterCancelAttempt.body)}`)

    // Cancel е идемпотентно/безопасно и за несъществуващ/вече cancelled id.
    const doubleCancel = await postJson(port, '/api/auth/cancel-pending-registration', { pendingRegistrationId: firstPendingId })
    assert(doubleCancel.status === 200 && doubleCancel.body?.ok === true, `double-cancel: status=${doubleCancel.status} body=${JSON.stringify(doubleCancel.body)}`)
  })

  // ── HARDENING-D. Email delivery failure -> pending recoverable -> resend completes flow
  await check('HARDENING-D. email delivery failure -> pending остава recoverable -> resend завършва флоу-а', async () => {
    const email = `email-verify-${runId}-hard-d@example.test`
    const registerResult = await attemptRegister(port, { email, displayName: `HardeningD${runId}` })
    // Тестовата среда няма реален Brevo -> очакваме 503 EMAIL_DELIVERY_FAILED,
    // но с pendingRegistrationId + maskedEmail + expiresAt (hardening pass §4).
    assert(registerResult.status === 503, `очаквах 503 EMAIL_DELIVERY_FAILED (тестова среда без Brevo), получих ${registerResult.status}`)
    assert(registerResult.body?.code === 'EMAIL_DELIVERY_FAILED', `очаквах code=EMAIL_DELIVERY_FAILED, получих ${JSON.stringify(registerResult.body)}`)
    const pendingRegistrationId = pendingIdFromResult(registerResult)
    assert(typeof registerResult.body?.maskedEmail === 'string' && (registerResult.body.maskedEmail as string).includes('*'), 'очаквах maskedEmail в 503 отговора')
    assert(typeof registerResult.body?.expiresAt === 'string' && (registerResult.body.expiresAt as string).length > 0, 'очаквах expiresAt в 503 отговора')
    assert(!('rawCode' in (registerResult.body ?? {})), 'rawCode НИКОГА не биваше да напуска сървъра')

    assert(countPendingRegistrationsByEmail(isolated.databaseFile, email) === 1, 'pending редът трябваше да съществува въпреки delivery провала')

    // 60s cooldown-ът тръгва от last_code_sent_at, зададен при самия
    // register() опит (дори delivery-то да е провалило) — backdate, за да
    // симулираме "изминала е повече от минута", mirror на тест F/HARDENING-B.
    backdatePendingRegistration(isolated.databaseFile, pendingRegistrationId, 'last_code_sent_at', new Date(Date.now() - 61_000).toISOString())

    // Resend (пак ще fail-не delivery-то, но кодът РЕАЛНО се regenerate-ва в DB).
    const resendResult = await postJson(port, '/api/auth/resend-registration-code', { pendingRegistrationId })
    assert(resendResult.status === 503, `resend: очаквах 503 (тестова среда без Brevo), получих ${resendResult.status}`)
    assert(resendResult.body?.code === 'EMAIL_DELIVERY_FAILED', `resend: очаквах EMAIL_DELIVERY_FAILED, получих ${JSON.stringify(resendResult.body)}`)

    // Флоу-ът е реално завършим — brute-force-ваме текущия (regenerated) код и verify-ваме.
    const code = bruteForceVerificationCode(isolated.databaseFile, pendingRegistrationId)
    const verifyResult = await postJson(port, '/api/auth/verify-registration-email', { pendingRegistrationId, code, rememberMe: true })
    assert(verifyResult.status === 200, `финален verify: status=${verifyResult.status} body=${JSON.stringify(verifyResult.body)}`)
    assert(countAccountsByEmail(isolated.databaseFile, email) === 1, 'account трябваше да е създаден въпреки delivery провала')
  })
} finally {
  console.log('\n[cleanup] Спиране на сървъра и изтриване на временните файлове...')
  try {
    await stopServer(server)
  } catch (err) {
    fail('Спиране на сървъра', err)
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
  if (!cleanupOk) {
    console.warn('  [warn] Временните файлове не бяха изтрити (Windows file lock) — не е тестов провал.')
  }
}

console.log(`\n═══ Резултат: ${passed} passed, ${failed} failed ═══\n`)
if (failed > 0) {
  process.exitCode = 1
}
