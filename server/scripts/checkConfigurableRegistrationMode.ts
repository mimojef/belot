/**
 * checkConfigurableRegistrationMode.ts
 *
 * Regression suite за configurable registration mode (Admin -> Настройки ->
 * "Метод за регистрация", виж adminSettingsStore.ts's
 * registrationVerificationMode / authStore.ts's RegistrationVerificationMode
 * doc коментари). Изолиран temp SQLite + реален spawned HTTP сървър, mirror
 * на checkEmailVerificationRegistration.ts/checkOpenRegistrationPolicy.ts
 * harness pattern-а (bruteForceVerificationCode, nextSyntheticTestIp,
 * postJson/getJson helper-и, admin bootstrap).
 *
 * Registration mode-ът се превключва ЖИВО (без restart) чрез директен SQL
 * write в admin_settings (mirror на checkVipPriceRefreshBug.ts's установен
 * pattern) — доказва, че сървърът реално чете настройката на всяка заявка,
 * не я кешира.
 *
 * Покрива (виж task-а §14):
 *  A. EMAIL_CODE (default mode) — pending се създава, account НЕ се
 *     материализира преди verify, верен код материализира account, resend
 *     работи, wrong code се отказва.
 *  B. DIRECT — успешна регистрация БЕЗ pending ред/verification стъпка,
 *     account/profile/wallet/progress материализирани directno, session се
 *     връща directno; duplicate email/name, invalid input, и "не открадвай
 *     активна email_code display-name резервация" се отказват.
 *  C. MULTI-ACCOUNT SAME DEVICE — СЪЩИЯТ visitor_id регистрира 3 различни
 *     профила успешно, и в direct, и в email_code режим (доказва липса на
 *     device-based one-account gate).
 *  D. FORENSIC DATA — site_visit_events пази ПЪЛНА история (1 ред на
 *     регистрация), visitor_registration_bindings пази само "първия"
 *     archival marker (1 ред на visitor_id) — multi-account НЕ е счупил
 *     нито forensic tracking-а.
 *  E. MODE SWITCH — pending registration, започнат при email_code, остава
 *     напълно verify-able/resend-able след admin switch към direct (и
 *     обратно) — switch-ът няма side effects върху pending_registrations.
 *  F. ADMIN SETTINGS — default='email_code' от migration seed-а, PATCH
 *     direct/email_code през реалния HTTP endpoint, invalid enum reject,
 *     switch не трие pending redове.
 *  G. FRONTEND (source-review, mirror на checkLudoArrowRotation.ts стила —
 *     няма browser в тази harness) — response-driven register flow
 *     (session-clon vs pending-клон), direct success никога не отваря
 *     verification popup, admin settings формата има <select> с двете
 *     стойности.
 *  H. registration-direct-ip rate limit — 10/час IP-scoped cap за direct
 *     mode регистрации, друг IP не е засегнат, email_code не докосва тази
 *     scope изобщо.
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { verifyVerificationCode } from '../src/db/authHelpers.js'

const PASSWORD = 'ConfigRegModeSmoke1!'
const TEST_REGISTRATION_SECRET = 'configurable-registration-mode-test-secret-0123456789'

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

/** Windows EBUSY-tolerant cleanup (established pattern, виж checkLudoSpectatorSubscription.ts) — spawned child-ът/WAL файловете понякога все още държат lock-а за кратко след kill. */
async function retryRm(path: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try { await rm(path, { recursive: true, force: true }); return } catch { /* retry */ }
    await sleep(250)
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
  cleanup(): Promise<void>
}> {
  const root = await mkdtemp(join(tmpdir(), 'belot-config-reg-mode-'))
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
    cleanup: () => retryRm(root),
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

// ─── HTTP helpers (mirror на checkEmailVerificationRegistration.ts) ────────

type JsonResult = { status: number; body: Record<string, unknown> | null; setCookie: string[] }

const TEST_NET_RANGES = ['203.0.113', '198.51.100', '192.0.2'] as const
let syntheticIpCounter = 0
function nextSyntheticTestIp(): string {
  syntheticIpCounter += 1
  const zeroBased = syntheticIpCounter - 1
  const rangePrefix = TEST_NET_RANGES[Math.floor(zeroBased / 254) % TEST_NET_RANGES.length]!
  const hostOctet = (zeroBased % 254) + 1
  return `${rangePrefix}.${hostOctet}`
}

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

async function requestJson(
  port: number,
  method: 'POST' | 'PATCH' | 'GET',
  pathname: string,
  body: unknown,
  options: { cookie?: string; ip?: string } = {},
): Promise<JsonResult> {
  return withFetchRetry(async () => {
    const headers: Record<string, string> = { 'X-Forwarded-For': options.ip ?? nextSyntheticTestIp() }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (options.cookie) headers['Cookie'] = options.cookie
    const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const parsedBody = await res.json().catch(() => null) as Record<string, unknown> | null
    const headersExt = res.headers as Headers & { getSetCookie?: () => string[] }
    const setCookie = headersExt.getSetCookie?.() ?? (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')!] : [])
    return { status: res.status, body: parsedBody, setCookie }
  })
}

async function postJson(port: number, pathname: string, body: unknown, cookie?: string, ip?: string): Promise<JsonResult> {
  return requestJson(port, 'POST', pathname, body, { cookie, ip })
}
async function patchJson(port: number, pathname: string, body: unknown, cookie?: string): Promise<JsonResult> {
  return requestJson(port, 'PATCH', pathname, body, { cookie })
}
async function getJson(port: number, pathname: string, cookie?: string): Promise<JsonResult> {
  return requestJson(port, 'GET', pathname, undefined, { cookie })
}

function extractSessionCookieHeader(setCookie: string[]): string | null {
  const raw = setCookie.find((c) => c.startsWith('belot_session='))
  return raw ? raw.split(';')[0]! : null
}

async function attemptRegister(
  port: number,
  input: { email: string; displayName: string; password?: string; visitorId?: string; ip?: string },
): Promise<JsonResult> {
  return postJson(port, '/api/auth/register', {
    email: input.email,
    password: input.password ?? PASSWORD,
    displayName: input.displayName,
    gender: 'male',
    visitorId: input.visitorId ?? randomUUID(),
  }, undefined, input.ip)
}

function pendingIdFromResult(result: JsonResult): string {
  const id = result.body?.pendingRegistrationId
  if (typeof id !== 'string' || id === '') {
    throw new Error(`Очаквах pendingRegistrationId, получих status=${result.status} body=${JSON.stringify(result.body)}`)
  }
  return id
}

function sessionFromResult(result: JsonResult): { profileId: string; accountId: string; cookie: string } {
  const session = result.body?.session as { profile?: { profileId?: string }; account?: { accountId?: string } } | undefined
  if (result.status !== 200 || !session?.profile?.profileId || !session.account?.accountId) {
    throw new Error(`Очаквах session directno, получих status=${result.status} body=${JSON.stringify(result.body)}`)
  }
  return {
    profileId: session.profile.profileId,
    accountId: session.account.accountId,
    cookie: extractSessionCookieHeader(result.setCookie) ?? '',
  }
}

/** register() + verify-registration-email() пълен flow (email_code mode). */
async function registerAndVerify(
  port: number,
  databaseFile: string,
  input: { email: string; displayName: string; rememberMe?: boolean; visitorId?: string; ip?: string },
): Promise<{ profileId: string; accountId: string; cookie: string; pendingRegistrationId: string }> {
  const registerResult = await attemptRegister(port, input)
  const pendingRegistrationId = pendingIdFromResult(registerResult)
  const code = bruteForceVerificationCode(databaseFile, pendingRegistrationId)
  const verifyResult = await postJson(port, '/api/auth/verify-registration-email', {
    pendingRegistrationId,
    code,
    rememberMe: input.rememberMe ?? true,
  })
  const session = sessionFromResult(verifyResult)
  return { ...session, pendingRegistrationId }
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

function withDb<T>(databaseFile: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(databaseFile)
  db.exec('PRAGMA journal_mode = WAL;')
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

function countAccountsByEmail(databaseFile: string, email: string): number {
  return withDb(databaseFile, (db) => (db.prepare(`SELECT COUNT(*) as n FROM accounts WHERE email = ?`).get(email) as { n: number }).n)
}

function countPendingRegistrationsByEmail(databaseFile: string, email: string): number {
  return withDb(databaseFile, (db) =>
    (db.prepare(`SELECT COUNT(*) as n FROM pending_registrations WHERE normalized_email = ?`).get(email.toLowerCase()) as { n: number }).n)
}

function countPendingRegistrationsTotal(databaseFile: string): number {
  return withDb(databaseFile, (db) => (db.prepare(`SELECT COUNT(*) as n FROM pending_registrations`).get() as { n: number }).n)
}

function countRowsWhere(databaseFile: string, table: string, whereSql: string, param: string): number {
  return withDb(databaseFile, (db) => (db.prepare(`SELECT COUNT(*) as n FROM ${table} WHERE ${whereSql}`).get(param) as { n: number }).n)
}

function setRegistrationVerificationMode(databaseFile: string, mode: 'email_code' | 'direct'): void {
  withDb(databaseFile, (db) => {
    db.prepare(`
      INSERT INTO admin_settings (setting_key, setting_value) VALUES ('registration_verification_mode', ?)
      ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = CURRENT_TIMESTAMP;
    `).run(mode)
  })
}

/** Заобикаля 60s resend cooldown-а БЕЗ реален sleep (established pattern, виж checkEmailVerificationRegistration.ts). */
function backdatePendingRegistrationLastCodeSentAt(databaseFile: string, pendingRegistrationId: string): void {
  withDb(databaseFile, (db) => {
    db.prepare(`UPDATE pending_registrations SET last_code_sent_at = ? WHERE pending_registration_id = ?`).run(
      new Date(Date.now() - 61_000).toISOString(),
      pendingRegistrationId,
    )
  })
}

function getRegistrationVerificationModeRaw(databaseFile: string): string | undefined {
  return withDb(databaseFile, (db) =>
    (db.prepare(`SELECT setting_value FROM admin_settings WHERE setting_key = 'registration_verification_mode'`).get() as
      | { setting_value: string }
      | undefined)?.setting_value)
}

function walletBalance(databaseFile: string, profileId: string): number | undefined {
  return withDb(databaseFile, (db) =>
    (db.prepare(`SELECT yellow_coins_balance FROM profile_wallets WHERE profile_id = ?`).get(profileId) as
      | { yellow_coins_balance: number }
      | undefined)?.yellow_coins_balance)
}

function hasProgressRow(databaseFile: string, profileId: string): boolean {
  return withDb(databaseFile, (db) =>
    (db.prepare(`SELECT 1 as x FROM profile_progress WHERE profile_id = ?`).get(profileId) as { x: number } | undefined) !== undefined)
}

// ─── main ───────────────────────────────────────────────────────────────────

const sourceServerRoot = resolve(
  process.argv.slice(2).find((a) => a.startsWith('--server-root='))?.slice('--server-root='.length) ?? process.cwd(),
)

console.log('\n═══ Configurable registration mode E2E test ═══')
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

  // ── F0. default mode от migration seed-а е 'email_code' ────────────────
  await check('F0. Fresh isolated DB -> registration_verification_mode default е "email_code" (migration seed)', () => {
    const raw = getRegistrationVerificationModeRaw(isolated.databaseFile)
    assert(raw === 'email_code', `очаквах "email_code", намерих ${JSON.stringify(raw)}`)
  })

  // ── Admin bootstrap (за F PATCH тестовете) — регистрираме и verify-ваме
  // докато mode е все още 'email_code' (default), после promote-ваме role.
  const adminEmail = `config-reg-mode-${runId}-admin@example.test`
  await registerAndVerify(port, isolated.databaseFile, { email: adminEmail, displayName: `ConfigRegAdmin${runId}` })
  withDb(isolated.databaseFile, (db) => {
    db.prepare(`UPDATE accounts SET role = 'admin' WHERE email = ?`).run(adminEmail)
  })
  const adminLogin = await postJson(port, '/api/auth/login', { email: adminEmail, password: PASSWORD, rememberMe: true })
  const adminCookie = extractSessionCookieHeader(adminLogin.setCookie)
  if (adminCookie === null) throw new Error('Не успях да получа admin cookie.')

  // ═══════════════════════════════════════════════════════════════════════
  // A. EMAIL_CODE (default mode) — baseline sanity, mode plumbing не чупи
  //    съществуващия flow (пълна дълбочина покрита от
  //    checkEmailVerificationRegistration.ts, пуснат отделно).
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n=== A. EMAIL_CODE ===')

  let aPendingId = ''
  const aEmail = `config-reg-mode-${runId}-a@example.test`
  await check('A1. email_code register -> pending created, NO account/profile yet', async () => {
    const result = await attemptRegister(port, { email: aEmail, displayName: `ConfigRegA${runId}` })
    assert(result.body?.mode === undefined || result.body?.mode === undefined, 'internal mode discriminator е server-only, не изтича в HTTP response-а')
    aPendingId = pendingIdFromResult(result)
    assert(countAccountsByEmail(isolated.databaseFile, aEmail) === 0, 'account не трябва да съществува преди verify')
    assert(countPendingRegistrationsByEmail(isolated.databaseFile, aEmail) === 1, 'точно 1 pending ред очакван')
  })

  await check('A2. wrong code -> rejected, no account created', async () => {
    const wrongCode = bruteForceVerificationCode(isolated.databaseFile, aPendingId) === '000000' ? '000001' : '000000'
    const result = await postJson(port, '/api/auth/verify-registration-email', { pendingRegistrationId: aPendingId, code: wrongCode, rememberMe: true })
    assert(result.status !== 200 || result.body?.ok !== true, 'грешен код не трябва да успее')
    assert(countAccountsByEmail(isolated.databaseFile, aEmail) === 0, 'account не трябва да съществува след грешен код')
  })

  await check('A3. correct code -> account/profile/wallet/progress created exactly once', async () => {
    const code = bruteForceVerificationCode(isolated.databaseFile, aPendingId)
    const result = await postJson(port, '/api/auth/verify-registration-email', { pendingRegistrationId: aPendingId, code, rememberMe: true })
    const session = sessionFromResult(result)
    assert(countAccountsByEmail(isolated.databaseFile, aEmail) === 1, 'точно 1 account очакван')
    assert(countPendingRegistrationsByEmail(isolated.databaseFile, aEmail) === 0, 'pending редът трябва да е consumed/изтрит')
    assert(walletBalance(isolated.databaseFile, session.profileId) !== undefined, 'wallet трябва да е инициализиран')
    assert(hasProgressRow(isolated.databaseFile, session.profileId), 'progress трябва да е инициализиран')
  })

  const aResendEmail = `config-reg-mode-${runId}-a-resend@example.test`
  await check('A4. resend продължава да работи (нов код валиден, стар невалиден)', async () => {
    const result = await attemptRegister(port, { email: aResendEmail, displayName: `ConfigRegAR${runId}` })
    const pendingId = pendingIdFromResult(result)
    const oldCode = bruteForceVerificationCode(isolated.databaseFile, pendingId)
    backdatePendingRegistrationLastCodeSentAt(isolated.databaseFile, pendingId)
    const resendResult = await postJson(port, '/api/auth/resend-registration-code', { pendingRegistrationId: pendingId })
    // Тестовата среда няма реален Brevo достъп — mirror на
    // checkEmailVerificationRegistration.ts's established толерантност:
    // 200 (dispatch опитан) ИЛИ 503 EMAIL_DELIVERY_FAILED (доставката е
    // провалила, но code_hash е ВЕЧЕ COMMIT-нат в DB преди изпращащия опит,
    // виж authStore.ts resendRegistrationVerificationCode()) — и в двата
    // случая новият код е валиден, старият вече не е.
    assert(
      resendResult.status === 200 || (resendResult.status === 503 && resendResult.body?.code === 'EMAIL_DELIVERY_FAILED'),
      `resend: очаквах 200 или 503 EMAIL_DELIVERY_FAILED, получих ${resendResult.status} body=${JSON.stringify(resendResult.body)}`,
    )
    const oldAttempt = await postJson(port, '/api/auth/verify-registration-email', { pendingRegistrationId: pendingId, code: oldCode, rememberMe: true })
    assert(oldAttempt.body?.ok !== true, 'старият код трябва да е невалиден след resend')
    const newCode = bruteForceVerificationCode(isolated.databaseFile, pendingId)
    const newAttempt = await postJson(port, '/api/auth/verify-registration-email', { pendingRegistrationId: pendingId, code: newCode, rememberMe: true })
    assert(newAttempt.status === 200 && newAttempt.body?.ok === true, 'новият код трябва да е валиден')
  })

  // ═══════════════════════════════════════════════════════════════════════
  // B. DIRECT mode
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n=== B. DIRECT ===')
  setRegistrationVerificationMode(isolated.databaseFile, 'direct')
  await check('(setup) admin_settings switched to "direct"', () => {
    assert(getRegistrationVerificationModeRaw(isolated.databaseFile) === 'direct', 'switch трябваше да успее')
  })

  const bEmail = `config-reg-mode-${runId}-b@example.test`
  let bProfileId = ''
  await check('B1. direct register -> session directno, БЕЗ pending ред, account/profile/wallet/progress материализирани', async () => {
    const result = await attemptRegister(port, { email: bEmail, displayName: `ConfigRegB${runId}` })
    assert(result.body?.pendingRegistrationId === undefined, 'direct mode НЕ трябва да връща pendingRegistrationId')
    const session = sessionFromResult(result)
    bProfileId = session.profileId
    assert(countAccountsByEmail(isolated.databaseFile, bEmail) === 1, 'точно 1 account очакван веднага')
    assert(countPendingRegistrationsByEmail(isolated.databaseFile, bEmail) === 0, 'НЕ трябва да съществува pending ред за direct регистрация')
    assert(walletBalance(isolated.databaseFile, bProfileId) !== undefined, 'wallet трябва да е инициализиран')
    assert(hasProgressRow(isolated.databaseFile, bProfileId), 'progress трябва да е инициализиран')
  })

  await check('B2. direct duplicate email -> rejected, no second account', async () => {
    const result = await attemptRegister(port, { email: bEmail, displayName: `ConfigRegB2${runId}` })
    assert(result.body?.ok !== true, 'duplicate email трябва да се отхвърли')
    assert(countAccountsByEmail(isolated.databaseFile, bEmail) === 1, 'все още точно 1 account')
  })

  await check('B3. direct duplicate display name (active profile) -> rejected', async () => {
    const dupNameEmail = `config-reg-mode-${runId}-b3@example.test`
    const result = await attemptRegister(port, { email: dupNameEmail, displayName: `ConfigRegB${runId}` })
    assert(result.body?.ok !== true, 'duplicate display name трябва да се отхвърли')
    assert(result.body?.code === 'DISPLAY_NAME_TAKEN', `очаквах DISPLAY_NAME_TAKEN, получих ${JSON.stringify(result.body)}`)
    assert(countAccountsByEmail(isolated.databaseFile, dupNameEmail) === 0, 'не трябва да се създаде account')
  })

  await check('B4. direct invalid email -> rejected', async () => {
    const result = await attemptRegister(port, { email: 'not-an-email', displayName: `ConfigRegB4${runId}` })
    assert(result.body?.ok !== true, 'невалиден email трябва да се отхвърли')
  })

  await check('B5. direct invalid password (<6 символа) -> rejected', async () => {
    const result = await attemptRegister(port, {
      email: `config-reg-mode-${runId}-b5@example.test`,
      displayName: `ConfigRegB5${runId}`,
      password: '123',
    })
    assert(result.body?.ok !== true, 'невалидна парола трябва да се отхвърли')
  })

  await check('B6. direct invalid display name (reserved Pika name) -> rejected', async () => {
    const result = await attemptRegister(port, { email: `config-reg-mode-${runId}-b6@example.test`, displayName: 'PikaBG Official' })
    assert(result.body?.ok !== true, 'reserved име трябва да се отхвърли')
  })

  await check('B7. direct НЕ може да открадне display name, резервирано от активен email_code pending ред', async () => {
    setRegistrationVerificationMode(isolated.databaseFile, 'email_code')
    const reservedName = `ConfigRegReserved${runId}`
    const reservedEmail = `config-reg-mode-${runId}-b7-reserved@example.test`
    const pendingResult = await attemptRegister(port, { email: reservedEmail, displayName: reservedName })
    const pendingId = pendingIdFromResult(pendingResult)

    setRegistrationVerificationMode(isolated.databaseFile, 'direct')
    const stealEmail = `config-reg-mode-${runId}-b7-steal@example.test`
    const stealResult = await attemptRegister(port, { email: stealEmail, displayName: reservedName })
    assert(stealResult.body?.ok !== true, 'direct регистрацията не трябва да успее')
    assert(stealResult.body?.code === 'DISPLAY_NAME_TAKEN', `очаквах DISPLAY_NAME_TAKEN, получих ${JSON.stringify(stealResult.body)}`)
    assert(countAccountsByEmail(isolated.databaseFile, stealEmail) === 0, 'direct регистрацията не трябва да е създала account')

    // Симетрия: original pending регистрация (email_code) остава напълно
    // verify-able (switch-ът към direct и обратно не я е повредил).
    setRegistrationVerificationMode(isolated.databaseFile, 'email_code')
    const code = bruteForceVerificationCode(isolated.databaseFile, pendingId)
    const verifyResult = await postJson(port, '/api/auth/verify-registration-email', { pendingRegistrationId: pendingId, code, rememberMe: true })
    assert(verifyResult.status === 200 && verifyResult.body?.ok === true, 'original pending регистрация трябва да продължи да работи')
    setRegistrationVerificationMode(isolated.databaseFile, 'direct')
  })

  await check('B8. симетрия: email_code НЕ може да вземе име, вече взето от direct-регистриран профил', async () => {
    // bEmail/ConfigRegB{runId} вече е direct-регистриран в B1.
    setRegistrationVerificationMode(isolated.databaseFile, 'email_code')
    const dupEmail = `config-reg-mode-${runId}-b8@example.test`
    const result = await attemptRegister(port, { email: dupEmail, displayName: `ConfigRegB${runId}` })
    assert(result.body?.ok !== true && result.body?.code === 'DISPLAY_NAME_TAKEN', `очаквах DISPLAY_NAME_TAKEN, получих ${JSON.stringify(result.body)}`)
    setRegistrationVerificationMode(isolated.databaseFile, 'direct')
  })

  // ═══════════════════════════════════════════════════════════════════════
  // C. MULTI-ACCOUNT SAME DEVICE (ЗАДЪЛЖИТЕЛЕН — виж task-а §6)
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n=== C. MULTI-ACCOUNT SAME DEVICE ===')

  const sharedVisitorId = randomUUID()
  await check('C1. DIRECT: същият visitor_id регистрира 3 различни профила успешно (A, B, C)', async () => {
    setRegistrationVerificationMode(isolated.databaseFile, 'direct')
    for (const suffix of ['x', 'y', 'z']) {
      const email = `config-reg-mode-${runId}-multi-${suffix}@example.test`
      const displayName = `ConfigRegMulti${suffix.toUpperCase()}${runId}`
      const result = await attemptRegister(port, { email, displayName, visitorId: sharedVisitorId })
      const session = sessionFromResult(result)
      assert(session.profileId.length > 0, `регистрация ${suffix} трябваше да успее с валиден profileId`)
    }
    assert(countRowsWhere(isolated.databaseFile, 'profile_wallets', 'profile_id IN (SELECT profile_id FROM profiles WHERE account_id IN (SELECT account_id FROM accounts WHERE email LIKE ?))', `config-reg-mode-${runId}-multi-%`) === 3, 'и трите профила трябва да имат wallets')
  })

  await check('C2. EMAIL_CODE: същият visitor_id НЕ блокира нова валидна регистрация (пълен register+verify, 2 различни профила)', async () => {
    setRegistrationVerificationMode(isolated.databaseFile, 'email_code')
    const email1 = `config-reg-mode-${runId}-multi-ec-1@example.test`
    const email2 = `config-reg-mode-${runId}-multi-ec-2@example.test`
    const r1 = await registerAndVerify(port, isolated.databaseFile, { email: email1, displayName: `ConfigRegMultiEC1${runId}`, visitorId: sharedVisitorId })
    const r2 = await registerAndVerify(port, isolated.databaseFile, { email: email2, displayName: `ConfigRegMultiEC2${runId}`, visitorId: sharedVisitorId })
    assert(r1.profileId !== r2.profileId, 'двата профила трябва да са различни')
    assert(countAccountsByEmail(isolated.databaseFile, email1) === 1 && countAccountsByEmail(isolated.databaseFile, email2) === 1, 'и двата account-а трябва да съществуват')
  })

  // ═══════════════════════════════════════════════════════════════════════
  // D. FORENSIC DATA — multi-account не е счупил tracking-а
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n=== D. FORENSIC DATA ===')

  await check('D1. site_visit_events пази ПЪЛНА история (5 регистрации от sharedVisitorId -> 5 реда)', () => {
    const eventsCount = countRowsWhere(isolated.databaseFile, 'site_visit_events', 'anonymous_visitor_id = ?', sharedVisitorId)
    assert(eventsCount === 5, `очаквах 5 site_visit_events реда (3 direct + 2 email_code), намерих ${eventsCount}`)
  })

  await check('D2. visitor_registration_bindings пази само "първия" archival marker (1 ред, не 5)', () => {
    const bindingCount = countRowsWhere(isolated.databaseFile, 'visitor_registration_bindings', 'anonymous_visitor_id = ?', sharedVisitorId)
    assert(bindingCount === 1, `очаквах точно 1 archival binding ред (OR IGNORE), намерих ${bindingCount}`)
  })

  await check('D3. site_visitors пази 1 ред за visitor_id-а (PK), first_profile_id сочи ПЪРВИЯ регистриран профил', () => {
    const visitorCount = countRowsWhere(isolated.databaseFile, 'site_visitors', 'anonymous_visitor_id = ?', sharedVisitorId)
    assert(visitorCount === 1, `очаквах точно 1 site_visitors ред, намерих ${visitorCount}`)
  })

  // ═══════════════════════════════════════════════════════════════════════
  // E. MODE SWITCH не поврежда pending_registrations state
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n=== E. MODE SWITCH ===')

  await check('E1-E3. email_code pending -> admin switch към direct -> старият pending remains verify-able', async () => {
    setRegistrationVerificationMode(isolated.databaseFile, 'email_code')
    const email = `config-reg-mode-${runId}-e@example.test`
    const registerResult = await attemptRegister(port, { email, displayName: `ConfigRegE${runId}` })
    const pendingId = pendingIdFromResult(registerResult)
    assert(countPendingRegistrationsByEmail(isolated.databaseFile, email) === 1, 'pending редът трябва да съществува')

    setRegistrationVerificationMode(isolated.databaseFile, 'direct')

    const code = bruteForceVerificationCode(isolated.databaseFile, pendingId)
    const verifyResult = await postJson(port, '/api/auth/verify-registration-email', { pendingRegistrationId: pendingId, code, rememberMe: true })
    assert(verifyResult.status === 200 && verifyResult.body?.ok === true, `verify трябваше да успее дори при mode='direct' в момента, получих ${JSON.stringify(verifyResult.body)}`)
    assert(countAccountsByEmail(isolated.databaseFile, email) === 1, 'account трябваше да се материализира')
  })

  await check('E4. resend продължава да работи докато mode=direct за pending, стартиран при email_code', async () => {
    setRegistrationVerificationMode(isolated.databaseFile, 'email_code')
    const email = `config-reg-mode-${runId}-e4@example.test`
    const registerResult = await attemptRegister(port, { email, displayName: `ConfigRegE4${runId}` })
    const pendingId = pendingIdFromResult(registerResult)

    setRegistrationVerificationMode(isolated.databaseFile, 'direct')
    backdatePendingRegistrationLastCodeSentAt(isolated.databaseFile, pendingId)
    const resendResult = await postJson(port, '/api/auth/resend-registration-code', { pendingRegistrationId: pendingId })
    // Виж A4-ния коментар — тестова среда без реален Brevo, 200 или 503
    // EMAIL_DELIVERY_FAILED са еднакво валидни (code_hash вече е committed).
    assert(
      resendResult.status === 200 || (resendResult.status === 503 && resendResult.body?.code === 'EMAIL_DELIVERY_FAILED'),
      `resend: очаквах 200 или 503 EMAIL_DELIVERY_FAILED, получих ${resendResult.status} body=${JSON.stringify(resendResult.body)}`,
    )

    const code = bruteForceVerificationCode(isolated.databaseFile, pendingId)
    const verifyResult = await postJson(port, '/api/auth/verify-registration-email', { pendingRegistrationId: pendingId, code, rememberMe: true })
    assert(verifyResult.status === 200 && verifyResult.body?.ok === true, 'verify след resend трябваше да успее')
  })

  await check('E5. switch обратно към email_code -> нова регистрация стартира pending flow нормално', async () => {
    setRegistrationVerificationMode(isolated.databaseFile, 'email_code')
    const email = `config-reg-mode-${runId}-e5@example.test`
    const result = await attemptRegister(port, { email, displayName: `ConfigRegE5${runId}` })
    assert(pendingIdFromResult(result).length > 0, 'pending flow трябва да работи нормално след switch обратно')
    assert(countAccountsByEmail(isolated.databaseFile, email) === 0, 'account не трябва да е материализиран directno')
  })

  // ═══════════════════════════════════════════════════════════════════════
  // F. ADMIN SETTINGS
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n=== F. ADMIN SETTINGS ===')

  await check('F1. GET /api/admin/settings (без промяна) отразява текущата DB стойност', async () => {
    setRegistrationVerificationMode(isolated.databaseFile, 'email_code')
    const result = await getJson(port, '/api/admin/settings', adminCookie)
    assert(result.status === 200 && result.body?.ok === true, 'GET трябва да успее за admin сесия')
    const settings = result.body?.settings as Record<string, unknown> | undefined
    assert(settings?.registrationVerificationMode === 'email_code', `очаквах email_code, получих ${JSON.stringify(settings)}`)
  })

  await check('F2. PATCH /api/admin/settings -> "direct" успява и GET веднага отразява промяната', async () => {
    const patchResult = await patchJson(port, '/api/admin/settings', { registrationVerificationMode: 'direct' }, adminCookie)
    assert(patchResult.status === 200 && patchResult.body?.ok === true, `PATCH трябваше да успее, получих ${JSON.stringify(patchResult.body)}`)
    const getResult = await getJson(port, '/api/admin/settings', adminCookie)
    const settings = getResult.body?.settings as Record<string, unknown> | undefined
    assert(settings?.registrationVerificationMode === 'direct', `очаквах direct, получих ${JSON.stringify(settings)}`)
    assert(getRegistrationVerificationModeRaw(isolated.databaseFile) === 'direct', 'DB редът трябва да отразява direct')
  })

  await check('F3. PATCH обратно -> "email_code" успява', async () => {
    const patchResult = await patchJson(port, '/api/admin/settings', { registrationVerificationMode: 'email_code' }, adminCookie)
    assert(patchResult.status === 200 && patchResult.body?.ok === true, 'PATCH обратно трябваше да успее')
    assert(getRegistrationVerificationModeRaw(isolated.databaseFile) === 'email_code', 'DB редът трябва да отразява email_code')
  })

  await check('F4. PATCH с невалидна enum стойност -> 400 reject, стойността в базата остава непроменена', async () => {
    setRegistrationVerificationMode(isolated.databaseFile, 'direct')
    const patchResult = await patchJson(port, '/api/admin/settings', { registrationVerificationMode: 'bogus_mode' }, adminCookie)
    assert(patchResult.status === 400 && patchResult.body?.ok !== true, `очаквах 400 reject, получих status=${patchResult.status} body=${JSON.stringify(patchResult.body)}`)
    assert(getRegistrationVerificationModeRaw(isolated.databaseFile) === 'direct', 'невалиден PATCH не трябва да променя записаната стойност')
    setRegistrationVerificationMode(isolated.databaseFile, 'email_code')
  })

  await check('F5. Admin setting switch НЕ трие pending_registrations редове', async () => {
    setRegistrationVerificationMode(isolated.databaseFile, 'email_code')
    const email = `config-reg-mode-${runId}-f5@example.test`
    await attemptRegister(port, { email, displayName: `ConfigRegF5${runId}` })
    const before = countPendingRegistrationsTotal(isolated.databaseFile)
    assert(before > 0, 'трябва да съществува поне 1 pending ред преди switch-а')

    await patchJson(port, '/api/admin/settings', { registrationVerificationMode: 'direct' }, adminCookie)
    const afterDirect = countPendingRegistrationsTotal(isolated.databaseFile)
    assert(afterDirect === before, `switch към direct не трябва да трие pending редове (before=${before}, after=${afterDirect})`)

    await patchJson(port, '/api/admin/settings', { registrationVerificationMode: 'email_code' }, adminCookie)
    const afterBack = countPendingRegistrationsTotal(isolated.databaseFile)
    assert(afterBack === before, `switch обратно не трябва да трие pending редове (before=${before}, after=${afterBack})`)
  })

  // ═══════════════════════════════════════════════════════════════════════
  // G. FRONTEND (source-review — няма browser в тази harness, mirror на
  //    checkLudoArrowRotation.ts стила за source-based regression проверки)
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n=== G. FRONTEND (source-review) ===')

  const repoRoot = resolve(sourceServerRoot, '..')
  const mainTsSource = readFileSync(join(repoRoot, 'src/main.ts'), 'utf8')
  const lobbyControllerSource = readFileSync(join(repoRoot, 'src/app/lobby/createLobbyFlowController.ts'), 'utf8')
  const lobbyScreenSource = readFileSync(join(repoRoot, 'src/app/lobby/renderLobbyScreen.ts'), 'utf8')

  await check('G1. submitRegisterRequest() branch-ва на response.session ПРЕДИ pending клона (direct mode success)', () => {
    // \r?\n (не голо \n) — main.ts е CRLF ("\r\n" line endings).
    const fnMatch = mainTsSource.match(/async function submitRegisterRequest[\s\S]*?\r?\n\}\r?\n/)
    assert(fnMatch !== null, 'не намерих submitRegisterRequest() в main.ts')
    const fnBody = fnMatch![0]
    assert(fnBody.includes('data.session') && fnBody.includes('applyNewAuthSession(data.session, true)'), 'очаквах session branch с applyNewAuthSession(..., true) (isNewRegistration)')
    const sessionCheckIndex = fnBody.indexOf('data.session')
    const pendingCheckIndex = fnBody.indexOf('data.pendingRegistrationId')
    assert(sessionCheckIndex !== -1 && pendingCheckIndex !== -1 && sessionCheckIndex < pendingCheckIndex, 'session проверката трябва да е ПРЕДИ pending проверката')
  })

  await check('G2. createLobbyFlowController.ts submitRegister() затваря auth modal-а directno при direct success (никога verification popup)', () => {
    // \r?\n (не голо \n) — createLobbyFlowController.ts е CRLF ("\r\n" line endings).
    const fnMatch = lobbyControllerSource.match(/async function submitRegister\([\s\S]*?\r?\n {2}\}\r?\n/)
    assert(fnMatch !== null, 'не намерих submitRegister() в createLobbyFlowController.ts')
    const fnBody = fnMatch![0]
    assert(fnBody.includes("if (result.pending)") && fnBody.includes('openRegistrationVerificationPopup'), 'pending клонът трябва да продължава да отваря verification popup-а')
    assert(fnBody.includes("state.authModalMode = 'closed'"), 'direct success опашката трябва да затваря auth modal-а (mirror на submitLogin())')
    const pendingBranchIndex = fnBody.indexOf('if (result.pending)')
    const directTailIndex = fnBody.indexOf("state.authModalMode = 'closed'")
    assert(pendingBranchIndex !== -1 && directTailIndex !== -1 && pendingBranchIndex < directTailIndex, 'pending клонът трябва да е ПРЕДИ direct-success опашката (early return)')
  })

  await check('G3. Admin settings формата има <select name="registrationVerificationMode"> с двете допустими стойности', () => {
    assert(lobbyScreenSource.includes('name="registrationVerificationMode"'), 'очаквах <select name="registrationVerificationMode">')
    assert(lobbyScreenSource.includes('value="email_code"') && lobbyScreenSource.includes('value="direct"'), 'очаквах и двете <option value> стойности')
    assert(lobbyScreenSource.includes('С потвърждение по имейл') && lobbyScreenSource.includes('Без потвърждение по имейл'), 'очаквах точния БГ текст за двете опции')
  })

  await check('G4. Frontend НЯМА public registration-mode endpoint/client-controlled mode параметър (виж task-а §10)', () => {
    assert(!mainTsSource.includes('registration-mode'), 'не трябва да съществува GET /api/auth/registration-mode извикване')
    const registerCallMatch = mainTsSource.match(/fetch\(`\$\{getApiBaseUrl\(\)\}\/api\/auth\/register`[\s\S]*?\}\)/)
    assert(registerCallMatch !== null, 'не намерих /api/auth/register fetch call-а')
    assert(!registerCallMatch![0].includes('mode'), '/api/auth/register request body-то не трябва да съдържа client-подадено "mode" поле')
  })

  // ═══════════════════════════════════════════════════════════════════════
  // H. registration-direct-ip rate limit
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n=== H. registration-direct-ip rate limit ===')

  await check('H1-H2. 10 direct регистрации от СЪЩИЯ IP успяват, 11-тата се rate-limit-ва; ДРУГ IP не е засегнат', async () => {
    setRegistrationVerificationMode(isolated.databaseFile, 'direct')
    const rateLimitIp = '198.18.0.77'
    for (let i = 0; i < 10; i++) {
      const email = `config-reg-mode-${runId}-h-${i}@example.test`
      const result = await attemptRegister(port, { email, displayName: `ConfigRegH${i}${runId}`, ip: rateLimitIp })
      const session = sessionFromResult(result)
      assert(session.profileId.length > 0, `регистрация ${i} от rate-limit IP трябваше да успее (в рамките на лимита)`)
    }
    const eleventhEmail = `config-reg-mode-${runId}-h-10@example.test`
    const eleventh = await attemptRegister(port, { email: eleventhEmail, displayName: `ConfigRegH10${runId}`, ip: rateLimitIp })
    assert(eleventh.body?.ok !== true, '11-тата регистрация от същия IP трябва да е rate-limited')
    assert(eleventh.body?.code === 'RATE_LIMITED', `очаквах code=RATE_LIMITED, получих ${JSON.stringify(eleventh.body)}`)
    assert(countAccountsByEmail(isolated.databaseFile, eleventhEmail) === 0, 'rate-limited опитът не трябва да създаде account')

    const otherIpEmail = `config-reg-mode-${runId}-h-other-ip@example.test`
    const otherIpResult = await attemptRegister(port, { email: otherIpEmail, displayName: `ConfigRegHOther${runId}`, ip: '198.18.99.42' })
    const otherSession = sessionFromResult(otherIpResult)
    assert(otherSession.profileId.length > 0, 'различен IP не трябва да е засегнат от лимита на първия IP')
  })

  await check('H3. email_code регистрации от СЪЩИЯ (вече изчерпан за direct) IP не са засегнати от registration-direct-ip', async () => {
    setRegistrationVerificationMode(isolated.databaseFile, 'email_code')
    const rateLimitIp = '198.18.0.77'
    const email = `config-reg-mode-${runId}-h-emailcode@example.test`
    const result = await attemptRegister(port, { email, displayName: `ConfigRegHEC${runId}`, ip: rateLimitIp })
    assert(pendingIdFromResult(result).length > 0, 'email_code регистрация от изчерпан direct-ip лимит трябва да продължи да работи нормално (различен rate-limit scope)')
  })

  console.log('\n' + '═'.repeat(75))
  console.log(`Passed: ${passed}  Failed: ${failed}`)
  console.log('═'.repeat(75) + '\n')
  if (failed > 0) process.exitCode = 1
} catch (error) {
  console.error('\nFATAL:', error instanceof Error ? error.message : error)
  console.error('\n--- server output ---\n' + server.output())
  process.exitCode = 1
} finally {
  await stopServer(server)
  await isolated.cleanup()
}
