/**
 * checkOpenRegistrationPolicy.ts
 *
 * E2E regression тест за продуктовото решение "премахни moderation/anti-
 * evasion блокадите за НОВА регистрация" — наследник на (и пълна замяна на)
 * checkRegistrationModerationGuard.ts, който тестваше ОБРАТНАТА (вече
 * невалидна) policy: че регистрация СЕ ОТКАЗВА при device/IP match с
 * banned/muted/hard-deleted профил. Старият файл е изтрит — почти целият му
 * тестов matrix (40+ сценария) твърдеше "-> 403 REGISTRATION_RESTRICTED",
 * което вече е грешен очакван резултат; механично "обръщане" на всеки тест
 * не си заслужаваше (много от тях покриваха machinery, която вече не
 * съществува — 48h IP recency прозорец, DB-level PK "one device one
 * account" guarantee — виж по-долу), затова той е заменен с фокусиран,
 * четим regression suite върху РЕАЛНАТА нова policy.
 *
 * Нова policy (виж authStore.ts's register() и index.ts doc коментарите):
 *   - Registration вече НЕ се отказва заради anonymous_visitor_id match,
 *     exact/historical IP match, active/expired ban или mute на друг
 *     профил, deleted-profile evidence
 *     (admin_profile_deletion_visitor_snapshots/
 *     admin_profile_deletion_moderation_snapshots), profile_bans history,
 *     visitor_registration_bindings history, site_visit_events history,
 *     или linked/dependent-profile evidence.
 *   - visitor_registration_bindings INSERT е вече "OR IGNORE" (не хвърля/
 *     блокира при вече съществуващ ред за visitor_id-а) — виж
 *     insertVisitorRegistrationBindingStatement в authStore.ts.
 *   - Стандартните validations остават непроменени: валиден email,
 *     duplicate-email rejection, password validation, display name
 *     validation (вкл. reserved Pika names), задължителен valid-формат
 *     visitorId (вече само tracking prerequisite, не anti-evasion сигнал).
 *   - visitorId/IP продължават да се записват (site_visit_events,
 *     visitor_registration_bindings) за admin dependency detection —
 *     adminProfileRiskStore.ts (risk-detail/risk-recheck endpoints) остава
 *     напълно непроменен и продължава да "свети" споделени visitor_id-та.
 *   - Active ban/mute enforcement върху СЪЩЕСТВУВАЩИ профили (login gate,
 *     admin moderation) е напълно непроменено — само НОВАТА регистрация
 *     спира да зависи от чужда история.
 *
 * Покрива:
 *  A. Same visitor_id като АКТИВНО баннат профил -> registration ALLOWED.
 *  B. Same visitor_id като АКТИВНО заглушен (Topics/Лафче) профил ->
 *     registration ALLOWED.
 *  C. Same visitor_id като hard-deleted профил, който Е ИМАЛ активен BAN в
 *     момента на изтриването (най-острият предишен "hard-delete evasion"
 *     блок) -> registration ALLOWED.
 *  D. Same exact IP (нов visitor_id) като banned/muted/hard-deleted профил
 *     -> registration ALLOWED (три под-теста: banned/muted/deleted).
 *  E. Same visitor_id + same exact IP, ВЕДНАГА след hard delete на
 *     актуално баннат профил -> registration ALLOWED.
 *  F. Duplicate съществуващ email -> REJECTED.
 *  G. Невалиден email -> REJECTED.
 *  H. Невалидна парола (<6 символа) -> REJECTED.
 *  I. Невалидно/reserved display name (съдържа "PikaBG") -> REJECTED.
 *  J. visitorId/history продължават да се записват след успешна
 *     регистрация (site_visit_events + visitor_registration_bindings).
 *  K. Admin linked-profile detection (risk-recheck endpoint) продължава да
 *     работи и "светва" профили, споделящи visitor_id — включително
 *     ДВАТА нови профила от J/K сценария, регистрирани от СЪЩИЯ visitor_id
 *     (вече allowed благодарение на тази промяна).
 *  L. Active ban enforcement върху СЪЩЕСТВУВАЩ профил е непроменено —
 *     login на баннат профил продължава да връща 403 PROFILE_BANNED.
 *  M. Флагман real-HTTP regression: POST /api/auth/register с visitor_id
 *     И IP, които ЕДНОВРЕМЕННО match-ват актуално баннат профил (worst-case
 *     комбиниран сценарий от старата policy) -> нормален 200 successful
 *     registration response, не 403.
 *
 * Изолирано копие на реалния сървър (собствена temp SQLite база, реални
 * migrations, реален HTTP слой) — mirror на
 * checkAdminProfileBanAndDeleteHttpAuthorization.ts pattern-а (същия, който
 * ползваше и предшественикът на този файл).
 */

import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { verifyVerificationCode } from '../src/db/authHelpers.js'

const PASSWORD = 'OpenRegSmoke1!'
// Email verification pending-first flow (виж authStore.ts's register() doc
// коментар) — тестова HMAC secret стойност (≥32 символа), подадена на
// spawned сървъра чрез PASSWORD_RESET_RATE_LIMIT_SECRET (fallback reuse,
// виж index.ts bootstrap-а) — registerAllowed() по-долу brute-force-ва
// 6-цифрения код от DB-съхранения code_hash със СЪЩИЯ secret, вместо реален
// Brevo (недостъпен в тестова среда).
const TEST_REGISTRATION_SECRET = 'open-registration-policy-test-secret-01'

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
  const root = await mkdtemp(join(tmpdir(), 'belot-open-reg-smoke-'))
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

type RegisterAttemptResult = { status: number; body: Record<string, unknown> | null }

async function attemptRegister(
  port: number,
  input: { email: string; displayName: string; password?: string; visitorId?: string; forwardedFor?: string },
): Promise<RegisterAttemptResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (input.forwardedFor) headers['X-Forwarded-For'] = input.forwardedFor
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      email: input.email,
      password: input.password ?? PASSWORD,
      displayName: input.displayName,
      gender: 'male',
      ...(input.visitorId !== undefined ? { visitorId: input.visitorId } : {}),
    }),
  })
  const body = await res.json().catch(() => null) as Record<string, unknown> | null
  return { status: res.status, body }
}

/**
 * "Registration allowed" evidence за директни attemptRegister() тестове,
 * които проверяват policy-то (не пълния verify flow) — 200 (email реално
 * изпратен) ИЛИ 503 EMAIL_DELIVERY_FAILED С pendingRegistrationId (pending
 * редът е бил създаден успешно — anti-evasion policy-то НЕ е блокирало,
 * единствената причина за non-200 е липсата на реален Brevo в тестовата
 * среда, несвързано с policy-то под тест). НЕ приема 400/403/409 (истинско
 * blocking) като "allowed".
 */
function assertRegistrationAllowed(result: RegisterAttemptResult, label: string): void {
  const pendingRegistrationId = (result.body as { pendingRegistrationId?: string } | null)?.pendingRegistrationId ?? ''
  const allowed = result.status === 200 || (result.status === 503 && pendingRegistrationId !== '')
  assert(allowed, `${label}: очаквах registration allowed (200 или 503 EMAIL_DELIVERY_FAILED с pendingRegistrationId), получих ${result.status} body=${JSON.stringify(result.body)}`)
}

type RegisteredUser = { profileId: string; accountId: string; email: string }

/**
 * Email verification pending-first flow — brute-force-ва 6-цифрения код от
 * pending_registrations.code_hash (1 000 000 HMAC-SHA256 изчисления, <1s),
 * ползвайки СЪЩИЯ production HMAC helper (verifyVerificationCode) и СЪЩИЯ
 * secret, който startServer() подава на spawned процеса — легитимна
 * test-harness техника (тестът контролира и двете страни), не production
 * bypass. Mirror на checkAuthSessionRollingRenewal.ts's аналогична helper.
 */
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

async function registerAllowed(
  port: number,
  databaseFile: string,
  input: { email: string; displayName: string; visitorId?: string; forwardedFor?: string },
): Promise<RegisteredUser> {
  const result = await attemptRegister(port, input)
  // pendingRegistrationId се връща и на 503 EMAIL_DELIVERY_FAILED (Brevo не
  // е configured в тестовата среда, pending редът persists — виж index.ts's
  // register handler doc коментар), не само на 200.
  const pendingRegistrationId = (result.body as { pendingRegistrationId?: string } | null)?.pendingRegistrationId ?? ''
  if (pendingRegistrationId === '') {
    throw new Error(`Очаквах pending registration, получих status=${result.status} body=${JSON.stringify(result.body)}`)
  }

  const code = bruteForceVerificationCode(databaseFile, pendingRegistrationId)
  // bruteForceVerificationCode блокира Node event loop-а синхронно (до
  // ~1 000 000 HMAC-SHA256 изчисления) — на бавни/натоварени machines това
  // понякога кара keep-alive connection-а към spawned сървъра да стане
  // stale (ECONNRESET/"fetch failed", чисто network-layer transient, не
  // business-logic провал) — един бърз retry е достатъчен.
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
  const payload = await verifyRes.json().catch(() => null) as
    | { ok?: boolean; session?: { profile: { profileId: string }; account: { accountId: string } } }
    | null
  if (verifyRes.status !== 200 || !payload?.ok || !payload.session) {
    throw new Error(`Верификацията не е успешна: status=${verifyRes.status} body=${JSON.stringify(payload)}`)
  }
  return { profileId: payload.session.profile.profileId, accountId: payload.session.account.accountId, email: input.email }
}

async function attemptLogin(port: number, email: string, password: string): Promise<{ status: number; body: Record<string, unknown> | null; cookie: string | null }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  const headersExt = res.headers as Headers & { getSetCookie?: () => string[] }
  const rawCookie = headersExt.getSetCookie?.()[0] ?? res.headers.get('set-cookie')
  const body = await res.json().catch(() => null) as Record<string, unknown> | null
  return { status: res.status, body, cookie: rawCookie ? rawCookie.split(';')[0]! : null }
}

/** Mirror на promoteRole в checkAdminProfileBanAndDeleteHttpAuthorization.ts — директен DB update, за да не минаваме през целия role-grant HTTP flow (несвързан с тестовете тук). */
function promoteRole(databaseFile: string, email: string, role: string): void {
  const db = new DatabaseSync(databaseFile)
  db.exec('PRAGMA journal_mode = WAL;')
  db.prepare(`UPDATE accounts SET role = ?, updated_at = CURRENT_TIMESTAMP WHERE email = ?`).run(role, email)
  db.close()
}

/** Реален admin hard-delete HTTP call (DELETE /api/admin/profiles/:id) — за тест C/E, за да упражним реалния cascade/snapshot flow (profileHardDeleteService.ts), не reimplement-нат raw SQL. */
async function hardDeleteProfile(port: number, adminCookie: string, targetProfileId: string, reason: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/admin/profiles/${targetProfileId}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: JSON.stringify({ reason }),
  })
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

async function riskRecheck(port: number, adminCookie: string, targetProfileId: string): Promise<{ status: number; body: { ok?: boolean; riskDetected?: boolean; linkedProfilesCount?: number } | null }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/admin/profiles/${targetProfileId}/risk-recheck`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
  })
  const body = await res.json().catch(() => null) as { ok?: boolean; riskDetected?: boolean; linkedProfilesCount?: number } | null
  return { status: res.status, body }
}

function insertBan(databaseFile: string, profileId: string, opts: { active: boolean }): void {
  const db = new DatabaseSync(databaseFile)
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA foreign_keys = ON;')
  const bannedUntil = opts.active ? "datetime('now', '+7 days')" : "datetime('now', '-1 days')"
  const liftedAt = opts.active ? 'NULL' : "datetime('now')"
  db.prepare(`
    INSERT INTO profile_bans (ban_id, profile_id, banned_until, reason, banned_by_profile_id, lifted_at)
    VALUES (?, ?, ${bannedUntil}, 'test ban', NULL, ${liftedAt})
  `).run(randomUUID(), profileId)
  db.close()
}

function insertMute(databaseFile: string, profileId: string, opts: { active: boolean }): void {
  const db = new DatabaseSync(databaseFile)
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA foreign_keys = ON;')
  const mutedUntil = opts.active ? "datetime('now', '+1 hours')" : "datetime('now', '-1 hours')"
  db.prepare(`
    INSERT INTO topic_section_mutes (profile_id, muted_until, reason)
    VALUES (?, ${mutedUntil}, 'test mute')
  `).run(profileId)
  db.close()
}

function countAccountsByEmail(databaseFile: string, email: string): number {
  const db = new DatabaseSync(databaseFile)
  const row = db.prepare(`SELECT COUNT(*) as n FROM accounts WHERE email = ?`).get(email) as { n: number }
  db.close()
  return row.n
}

function hasVisitorProfileEvent(databaseFile: string, visitorId: string, profileId: string): boolean {
  const db = new DatabaseSync(databaseFile)
  const row = db.prepare(`
    SELECT 1 FROM site_visit_events WHERE anonymous_visitor_id = ? AND profile_id = ? LIMIT 1;
  `).get(visitorId, profileId)
  db.close()
  return row !== undefined
}

/** visitor_registration_bindings row за даден (visitorId, profileId) чифт — "OR IGNORE" insert-ът (виж authStore.ts) означава, че само ПЪРВАТА регистрация от даден visitor_id получава ред тук; последващите regs от СЪЩИЯ visitor_id вече НЕ пипат/презаписват съществуващия ред. */
function hasVisitorRegistrationBinding(databaseFile: string, visitorId: string, profileId: string): boolean {
  const db = new DatabaseSync(databaseFile)
  const row = db.prepare(`
    SELECT 1 FROM visitor_registration_bindings WHERE anonymous_visitor_id = ? AND profile_id = ? LIMIT 1;
  `).get(visitorId, profileId)
  db.close()
  return row !== undefined
}

const sourceServerRoot = resolve(
  process.argv.slice(2).find((a) => a.startsWith('--server-root='))?.slice('--server-root='.length) ?? process.cwd(),
)

console.log('\n═══ Open registration policy (no moderation/anti-evasion block) E2E test ═══')
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

  // ── Admin bootstrap (за hard-delete/risk-recheck HTTP flows) ────────────
  const adminEmail = `open-reg-${runId}-admin@example.test`
  await registerAllowed(port, isolated.databaseFile, { email: adminEmail, displayName: `OpenRegAdmin${runId}`, visitorId: randomUUID(), forwardedFor: '198.51.100.200' })
  promoteRole(isolated.databaseFile, adminEmail, 'admin')
  const adminLoginResult = await attemptLogin(port, adminEmail, PASSWORD)
  if (adminLoginResult.cookie === null) {
    throw new Error('Не успях да получа admin session cookie.')
  }
  const adminCookie = adminLoginResult.cookie

  // ── A. Same visitor_id като АКТИВНО баннат профил -> ALLOWED ────────────
  await check('A. same visitor_id като АКТИВНО баннат профил -> registration ALLOWED', async () => {
    const visitorId = randomUUID()
    const victim = await registerAllowed(port, isolated.databaseFile, {
      email: `open-reg-${runId}-a-victim@example.test`,
      displayName: `OpenRegAV${runId}`,
      visitorId,
      forwardedFor: '198.51.100.1',
    })
    insertBan(isolated.databaseFile, victim.profileId, { active: true })

    const result = await attemptRegister(port, {
      email: `open-reg-${runId}-a-new@example.test`,
      displayName: `OpenRegANew${runId}`,
      visitorId,
      forwardedFor: '198.51.100.2',
    })
    assertRegistrationAllowed(result, 'A')
  })

  // ── B. Same visitor_id като АКТИВНО заглушен профил -> ALLOWED ──────────
  await check('B. same visitor_id като АКТИВНО заглушен профил -> registration ALLOWED', async () => {
    const visitorId = randomUUID()
    const victim = await registerAllowed(port, isolated.databaseFile, {
      email: `open-reg-${runId}-b-victim@example.test`,
      displayName: `OpenRegBV${runId}`,
      visitorId,
      forwardedFor: '198.51.100.3',
    })
    insertMute(isolated.databaseFile, victim.profileId, { active: true })

    const result = await attemptRegister(port, {
      email: `open-reg-${runId}-b-new@example.test`,
      displayName: `OpenRegBNew${runId}`,
      visitorId,
      forwardedFor: '198.51.100.4',
    })
    assertRegistrationAllowed(result, 'B')
  })

  // ── C. Same visitor_id като hard-deleted профил, КОЙТО Е ИМАЛ активен
  //      BAN в момента на изтриването -> ALLOWED (най-острият предишен
  //      "hard-delete evasion" блок) ────────────────────────────────────
  await check('C. same visitor_id като hard-deleted (бил активно баннат) профил -> registration ALLOWED', async () => {
    const visitorId = randomUUID()
    const victim = await registerAllowed(port, isolated.databaseFile, {
      email: `open-reg-${runId}-c-victim@example.test`,
      displayName: `OpenRegCV${runId}`,
      visitorId,
      forwardedFor: '198.51.100.5',
    })
    insertBan(isolated.databaseFile, victim.profileId, { active: true })
    const deleteResult = await hardDeleteProfile(port, adminCookie, victim.profileId, 'open-registration-policy test hard delete')
    assert(deleteResult.status === 200, `hard delete: очаквах 200, получих ${deleteResult.status} body=${JSON.stringify(deleteResult.body)}`)

    const result = await attemptRegister(port, {
      email: `open-reg-${runId}-c-new@example.test`,
      displayName: `OpenRegCNew${runId}`,
      visitorId,
      forwardedFor: '198.51.100.6',
    })
    assertRegistrationAllowed(result, 'C')
  })

  // ── D. Same exact IP (нов visitor_id) като banned/muted/hard-deleted
  //      профил -> ALLOWED ─────────────────────────────────────────────
  await check('D1. same IP като АКТИВНО баннат профил (нов visitor_id) -> registration ALLOWED', async () => {
    const sharedIp = '198.51.100.7'
    const victim = await registerAllowed(port, isolated.databaseFile, {
      email: `open-reg-${runId}-d1-victim@example.test`,
      displayName: `OpenRegD1V${runId}`,
      visitorId: randomUUID(),
      forwardedFor: sharedIp,
    })
    insertBan(isolated.databaseFile, victim.profileId, { active: true })

    const result = await attemptRegister(port, {
      email: `open-reg-${runId}-d1-new@example.test`,
      displayName: `OpenRegD1New${runId}`,
      visitorId: randomUUID(),
      forwardedFor: sharedIp,
    })
    assertRegistrationAllowed(result, 'D1')
  })

  await check('D2. same IP като АКТИВНО заглушен профил (нов visitor_id) -> registration ALLOWED', async () => {
    const sharedIp = '198.51.100.8'
    const victim = await registerAllowed(port, isolated.databaseFile, {
      email: `open-reg-${runId}-d2-victim@example.test`,
      displayName: `OpenRegD2V${runId}`,
      visitorId: randomUUID(),
      forwardedFor: sharedIp,
    })
    insertMute(isolated.databaseFile, victim.profileId, { active: true })

    const result = await attemptRegister(port, {
      email: `open-reg-${runId}-d2-new@example.test`,
      displayName: `OpenRegD2New${runId}`,
      visitorId: randomUUID(),
      forwardedFor: sharedIp,
    })
    assertRegistrationAllowed(result, 'D2')
  })

  await check('D3. same IP като hard-deleted (бил активно баннат) профил (нов visitor_id) -> registration ALLOWED', async () => {
    const sharedIp = '198.51.100.9'
    const victim = await registerAllowed(port, isolated.databaseFile, {
      email: `open-reg-${runId}-d3-victim@example.test`,
      displayName: `OpenRegD3V${runId}`,
      visitorId: randomUUID(),
      forwardedFor: sharedIp,
    })
    insertBan(isolated.databaseFile, victim.profileId, { active: true })
    const deleteResult = await hardDeleteProfile(port, adminCookie, victim.profileId, 'open-registration-policy test hard delete (IP)')
    assert(deleteResult.status === 200, `hard delete: очаквах 200, получих ${deleteResult.status}`)

    const result = await attemptRegister(port, {
      email: `open-reg-${runId}-d3-new@example.test`,
      displayName: `OpenRegD3New${runId}`,
      visitorId: randomUUID(),
      forwardedFor: sharedIp,
    })
    assertRegistrationAllowed(result, 'D3')
  })

  // ── E. Same visitor_id + same exact IP, ВЕДНАГА след hard delete на
  //      актуално баннат профил -> ALLOWED ────────────────────────────
  await check('E. same visitor_id + same exact IP веднага след hard delete -> registration ALLOWED', async () => {
    const visitorId = randomUUID()
    const sharedIp = '198.51.100.10'
    const victim = await registerAllowed(port, isolated.databaseFile, {
      email: `open-reg-${runId}-e-victim@example.test`,
      displayName: `OpenRegEV${runId}`,
      visitorId,
      forwardedFor: sharedIp,
    })
    insertBan(isolated.databaseFile, victim.profileId, { active: true })
    const deleteResult = await hardDeleteProfile(port, adminCookie, victim.profileId, 'open-registration-policy test immediate re-register')
    assert(deleteResult.status === 200, `hard delete: очаквах 200, получих ${deleteResult.status}`)

    // Веднага, БЕЗ никакво изчакване — same visitorId И same IP едновременно.
    const result = await attemptRegister(port, {
      email: `open-reg-${runId}-e-new@example.test`,
      displayName: `OpenRegENew${runId}`,
      visitorId,
      forwardedFor: sharedIp,
    })
    assertRegistrationAllowed(result, 'E')
  })

  // ── F. Duplicate email -> REJECTED ───────────────────────────────────
  await check('F. duplicate email -> REJECTED', async () => {
    const email = `open-reg-${runId}-f@example.test`
    await registerAllowed(port, isolated.databaseFile, { email, displayName: `OpenRegF1${runId}`, visitorId: randomUUID(), forwardedFor: '198.51.100.11' })
    const before = countAccountsByEmail(isolated.databaseFile, email)
    assert(before === 1, `очаквах точно 1 account за email-а след първата регистрация, намерих ${before}`)

    const result = await attemptRegister(port, { email, displayName: `OpenRegF2${runId}`, visitorId: randomUUID(), forwardedFor: '198.51.100.12' })
    assert(result.status !== 200, `очаквах rejection, получих 200`)
    assert(result.body?.ok === false, `очаквах ok:false, получих ${JSON.stringify(result.body)}`)

    const after = countAccountsByEmail(isolated.databaseFile, email)
    assert(after === 1, `очаквах регистрацията да остане 1 account (без duplicate), намерих ${after}`)
  })

  // ── G. Невалиден email -> REJECTED ───────────────────────────────────
  await check('G. невалиден email -> REJECTED', async () => {
    const result = await attemptRegister(port, {
      email: 'not-an-email',
      displayName: `OpenRegG${runId}`,
      visitorId: randomUUID(),
      forwardedFor: '198.51.100.13',
    })
    assert(result.status !== 200, `очаквах rejection, получих 200`)
    assert(result.body?.ok === false, `очаквах ok:false, получих ${JSON.stringify(result.body)}`)
  })

  // ── H. Невалидна парола -> REJECTED ──────────────────────────────────
  await check('H. невалидна парола (<6 символа) -> REJECTED', async () => {
    const result = await attemptRegister(port, {
      email: `open-reg-${runId}-h@example.test`,
      displayName: `OpenRegH${runId}`,
      password: '12345',
      visitorId: randomUUID(),
      forwardedFor: '198.51.100.14',
    })
    assert(result.status !== 200, `очаквах rejection, получих 200`)
    assert(result.body?.ok === false, `очаквах ok:false, получих ${JSON.stringify(result.body)}`)
  })

  // ── I. Невалидно/reserved display name -> REJECTED ───────────────────
  await check('I. reserved display name (съдържа "PikaBG") -> REJECTED', async () => {
    const result = await attemptRegister(port, {
      email: `open-reg-${runId}-i@example.test`,
      displayName: 'Pika Bg',
      visitorId: randomUUID(),
      forwardedFor: '198.51.100.15',
    })
    assert(result.status !== 200, `очаквах rejection, получих 200`)
    assert(result.body?.ok === false, `очаквах ok:false, получих ${JSON.stringify(result.body)}`)
    assert(result.body?.code === 'RESERVED_PIKA_NAME', `очаквах code=RESERVED_PIKA_NAME, получих ${JSON.stringify(result.body)}`)
  })

  // ── J/K. visitorId/history продължават да се записват; admin
  //      linked-profile detection продължава да работи ────────────────
  const jkVisitorId = randomUUID()
  const jkUserOne = await registerAllowed(port, isolated.databaseFile, {
    email: `open-reg-${runId}-jk-1@example.test`,
    displayName: `OpenRegJK1${runId}`,
    visitorId: jkVisitorId,
    forwardedFor: '198.51.100.16',
  })
  const jkUserTwo = await registerAllowed(port, isolated.databaseFile, {
    email: `open-reg-${runId}-jk-2@example.test`,
    displayName: `OpenRegJK2${runId}`,
    visitorId: jkVisitorId,
    forwardedFor: '198.51.100.17',
  })

  await check('J. visitorId/history продължават да се записват след успешна регистрация', () => {
    assert(
      hasVisitorProfileEvent(isolated.databaseFile, jkVisitorId, jkUserOne.profileId),
      'липсва site_visit_events ред за първия профил',
    )
    assert(
      hasVisitorProfileEvent(isolated.databaseFile, jkVisitorId, jkUserTwo.profileId),
      'липсва site_visit_events ред за втория профил (доказва, че site_visit_events НЕ е "OR IGNORE"-нато скипнато за повторен visitor_id)',
    )
    assert(
      hasVisitorRegistrationBinding(isolated.databaseFile, jkVisitorId, jkUserOne.profileId),
      'липсва visitor_registration_bindings ред за първия (пръв регистриран) профил',
    )
  })

  await check('K. admin linked-profile detection продължава да работи (risk-recheck "светва" споделен visitor_id)', async () => {
    const result = await riskRecheck(port, adminCookie, jkUserTwo.profileId)
    assert(result.status === 200, `очаквах 200, получих ${result.status} body=${JSON.stringify(result.body)}`)
    assert(result.body?.ok === true, `очаквах ok:true, получих ${JSON.stringify(result.body)}`)
    assert(result.body?.riskDetected === true, `очаквах riskDetected:true за профил, споделящ visitor_id с друг жив профил, получих ${JSON.stringify(result.body)}`)
    assert((result.body?.linkedProfilesCount ?? 0) >= 1, `очаквах linkedProfilesCount >= 1, получих ${JSON.stringify(result.body)}`)
  })

  // ── L. Active ban enforcement върху СЪЩЕСТВУВАЩ профил е непроменено ──
  await check('L. active ban enforcement върху съществуващ профил е непроменено (login -> 403 PROFILE_BANNED)', async () => {
    const visitorId = randomUUID()
    const email = `open-reg-${runId}-l@example.test`
    const victim = await registerAllowed(port, isolated.databaseFile, { email, displayName: `OpenRegL${runId}`, visitorId, forwardedFor: '198.51.100.18' })
    insertBan(isolated.databaseFile, victim.profileId, { active: true })

    const result = await attemptLogin(port, email, PASSWORD)
    assert(result.status === 403, `очаквах 403, получих ${result.status} body=${JSON.stringify(result.body)}`)
    assert(result.body?.code === 'PROFILE_BANNED', `очаквах code=PROFILE_BANNED, получих ${JSON.stringify(result.body)}`)
  })

  // ── M. Флагман real-HTTP regression: same visitor_id И same IP
  //      ЕДНОВРЕМЕННО match-ват актуално баннат профил (worst-case
  //      комбиниран сценарий от старата policy) -> нормален 200 ─────────
  await check('M. флагман regression: visitor_id + IP едновременно match-ват баннат профил -> 200 normal registration', async () => {
    const visitorId = randomUUID()
    const sharedIp = '198.51.100.19'
    const victim = await registerAllowed(port, isolated.databaseFile, {
      email: `open-reg-${runId}-m-victim@example.test`,
      displayName: `OpenRegMV${runId}`,
      visitorId,
      forwardedFor: sharedIp,
    })
    insertBan(isolated.databaseFile, victim.profileId, { active: true })

    // Пълен flow (register -> verify-registration-email), не само pending
    // creation — флагманският тест доказва целия real-HTTP round-trip
    // завършва с нормална, успешна регистрация (реален session), не само
    // "не е блокирано на register стъпката".
    const newUser = await registerAllowed(port, isolated.databaseFile, {
      email: `open-reg-${runId}-m-new@example.test`,
      displayName: `OpenRegMNew${runId}`,
      visitorId,
      forwardedFor: sharedIp,
    })
    assert(typeof newUser.profileId === 'string' && newUser.profileId.length > 0, 'очаквах валиден profileId след verify')
  })
} finally {
  console.log('\n[cleanup] Спиране на сървъра и изтриване на временните файлове...')
  try {
    await stopServer(server)
  } catch (err) {
    fail('Спиране на сървъра', err)
  }
  // Windows file-lock retry (mirror на checkAdminProfileBanAndDeleteHttpAuthorization.ts) —
  // temp cleanup failure не е тестов провал, само best-effort.
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
