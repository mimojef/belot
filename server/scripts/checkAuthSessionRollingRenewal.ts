/**
 * checkAuthSessionRollingRenewal.ts
 *
 * Regression coverage за auth session-lifetime fix: 30-дневен ABSOLUTE
 * expiration -> 90-дневен ROLLING/SLIDING expiration от последната реална
 * активност (GET /api/auth/me, викан от клиента при всяко зареждане на
 * сайта, докато е логнат — виж main.ts's loadAuthSession()).
 *
 * Механика (server/src/db/authStore.ts):
 *   - SESSION_TTL_MS = 90 дни (беше 30) — ползва се И за нови сесии
 *     (createSession), И за renewal (touchSession).
 *   - SESSION_RENEWAL_THROTTLE_MS = 1 ден — touchSession() прави реален
 *     UPDATE account_sessions.expires_at САМО ако remaining lifetime на
 *     сесията е паднал под (90d - 1d) = 89 дни, т.е. само ако е минал поне
 *     ~1 ден от последния renewal/login. Максимум ~1 DB write/сесия/ден.
 *   - touchSession() се вика ЕДИНСТВЕНО от GET /api/auth/me
 *     (server/src/index.ts) — WS connect продължава да ползва чист
 *     getSession() (read-only), никога не причинява DB write.
 *   - Renewed:true -> index.ts изпраща нов Set-Cookie със същия удължен
 *     expires_at (cookie/server-side expiry никога не се разминават).
 *   - Existing 30-дневни сесии (стар TTL) се upgrade-ват автоматично при
 *     първия си /api/auth/me след deploy — формулата разчита само на
 *     реално записания expires_at, без нужда от migration/backfill.
 *
 * ЧАСТ 1 (in-process, директен authStore достъп + raw SQL manipulation на
 * account_sessions.expires_at/revoked_at за детерминирано симулиране на
 * "минало е N дни") покрива A/C/D/E/F/I.
 * ЧАСТ 2 (реален HTTP+WS сървър, изолирана temp SQLite копие) покрива
 * B/G/H + cookie/server-side synchronization + "WS traffic сам по себе си
 * не причинява DB write".
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, rm, cp, mkdir, symlink } from 'node:fs/promises'
import { readdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { WebSocket } from 'ws'

import { createAuthStore } from '../src/db/authStore.js'
import { createPlayerProgressStore } from '../src/db/playerProgressStore.js'
import { verifyVerificationCode } from '../src/db/authHelpers.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverRoot = resolve(__dirname, '..')
const migrationsDir = resolve(serverRoot, 'database/migrations')

const PASSWORD = 'SessionRenewSmoke1!'
const DAY_MS = 1000 * 60 * 60 * 24
const NINETY_DAYS_MS = DAY_MS * 90
// Email verification pending-first flow (виж authStore.ts's register() doc
// коментар) — registrationVerificationCodeSecret изисква ≥32 символа
// (validateRateLimitSecret), mirror на password-reset-овия rate-limit
// secret contract. Тестова стойност, не production secret.
const TEST_REGISTRATION_SECRET = 'session-renewal-test-secret-0123456789'

let passed = 0
let failed = 0

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`  PASS  ${label}`)
  } catch (error) {
    failed++
    console.error(`  FAIL  ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function applyMigrations(databaseFilePath: string): Promise<void> {
  const db = new DatabaseSync(databaseFilePath, {
    open: true,
    enableForeignKeyConstraints: true,
  })
  db.exec('PRAGMA foreign_keys = ON;')

  const migrationFiles = readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort()

  for (const file of migrationFiles) {
    const sql = await readFile(join(migrationsDir, file), 'utf8')
    db.exec(sql)
  }

  db.close()
}

// ─────────────────────────────────────────────────────────────────────────
// ЧАСТ 1 — in-process authStore тестове (директен expires_at контрол)
// ─────────────────────────────────────────────────────────────────────────

async function runAuthStoreLevelTests(): Promise<void> {
  console.log('\n[Part 1] authStore.ts in-process тестове (touchSession/renewal семантика)')

  const tempDir = await mkdtemp(join(tmpdir(), 'belot-session-renewal-'))
  const dbPath = join(tempDir, 'session-renewal.sqlite')

  let authStore: Awaited<ReturnType<typeof createAuthStore>> | null = null
  let progressStore: Awaited<ReturnType<typeof createPlayerProgressStore>> | null = null
  let db: DatabaseSync | null = null

  try {
    await applyMigrations(dbPath)
    progressStore = await createPlayerProgressStore(dbPath)
    authStore = await createAuthStore(dbPath, progressStore, {
      registrationVerificationCodeSecret: TEST_REGISTRATION_SECRET,
    })
    db = new DatabaseSync(dbPath, { open: true })
    db.exec('PRAGMA journal_mode = WAL;')

    const localDb = db
    function readSessionRow(sessionId: string): { expires_at: string; revoked_at: string | null } {
      const row = localDb.prepare(`SELECT expires_at, revoked_at FROM account_sessions WHERE session_id = ?`).get(sessionId) as
        | { expires_at: string; revoked_at: string | null }
        | undefined
      if (!row) throw new Error(`session row not found: ${sessionId}`)
      return row
    }
    function setExpiresAt(sessionId: string, isoValue: string): void {
      localDb.prepare(`UPDATE account_sessions SET expires_at = ? WHERE session_id = ?`).run(isoValue, sessionId)
    }
    function setRevoked(sessionId: string): void {
      localDb.prepare(`UPDATE account_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE session_id = ?`).run(sessionId)
    }
    // Email verification pending-first flow — register() вече само създава
    // pending_registrations ред + rawCode (in-process достъпен директно тук,
    // никога през email за този тест); verifyRegistrationEmail() материализира
    // реалния account/profile/session, mirror на production verify flow-а.
    function registerFresh(suffix: string): { sessionToken: string; sessionId: string } {
      const pendingResult = authStore!.register({
        email: `renew-${suffix}@example.test`,
        password: PASSWORD,
        displayName: `Renew${suffix}`,
        gender: 'male',
        visitorId: randomUUID(),
      })
      assert(pendingResult.ok, `register(${suffix}) failed: ${!pendingResult.ok ? pendingResult.message : ''}`)
      if (!pendingResult.ok) throw new Error('unreachable')

      const verifyResult = authStore!.verifyRegistrationEmail({
        pendingRegistrationId: pendingResult.pendingRegistrationId,
        code: pendingResult.rawCode,
        rememberMe: true,
        ipAddress: null,
        userAgent: null,
      })
      assert(verifyResult.ok, `verifyRegistrationEmail(${suffix}) failed: ${!verifyResult.ok ? verifyResult.reason : ''}`)
      if (!verifyResult.ok) throw new Error('unreachable')
      return { sessionToken: verifyResult.sessionToken, sessionId: verifyResult.session.sessionId }
    }

    // ── [A] Нов login/register -> DB expires_at ≈ now + 90 дни ──────────
    await check('[A] нов register() -> DB expires_at ≈ now + 90 дни', () => {
      const { sessionId } = registerFresh('a')
      const expiresAtMs = new Date(readSessionRow(sessionId).expires_at).getTime()
      const driftMs = Math.abs(expiresAtMs - (Date.now() + NINETY_DAYS_MS))
      assert(driftMs < 60_000, `expires_at drift твърде голям: ${driftMs}ms (очаквах ~90 дни от сега)`)
    })

    // ── [D] Стара 30-дневна сесия -> upgrade до 90 дни при следващ touch ─
    await check('[D] стар 30-дневен (pre-fix) валиден session -> touchSession() го upgrade-ва до ~90 дни', () => {
      const { sessionToken, sessionId } = registerFresh('d')
      // Симулира "стара" сесия, създадена преди TTL промяната — expires_at
      // все едно е бил зададен с 30-дневния TTL (все още валиден: 25 от 30
      // дни минали, remaining=5 дни).
      const oldStyleExpiresAt = new Date(Date.now() + 5 * DAY_MS).toISOString()
      setExpiresAt(sessionId, oldStyleExpiresAt)

      const { session, renewed } = authStore!.touchSession(sessionToken)
      assert(session !== null, 'touchSession върна null за все още валидна стара сесия')
      assert(renewed === true, 'очаквах renewed=true за стара 30-дневна сесия с малко remaining lifetime')

      const newExpiresAtMs = new Date(readSessionRow(sessionId).expires_at).getTime()
      const driftMs = Math.abs(newExpiresAtMs - (Date.now() + NINETY_DAYS_MS))
      assert(driftMs < 60_000, `upgraded expires_at drift твърде голям: ${driftMs}ms`)
    })

    // ── [C] Throttle — веднага след renewal, повторен touch НЕ пише пак ─
    await check('[C] повторен touchSession() веднага след renewal -> НЕ прави втори DB write', () => {
      const { sessionToken, sessionId } = registerFresh('c')
      setExpiresAt(sessionId, new Date(Date.now() + 5 * DAY_MS).toISOString())

      const first = authStore!.touchSession(sessionToken)
      assert(first.renewed === true, 'първият touch трябваше да renew-не (remaining lifetime малък)')
      const expiresAtAfterFirst = readSessionRow(sessionId).expires_at

      const second = authStore!.touchSession(sessionToken)
      assert(second.renewed === false, 'вторият touch (веднага след първия) НЕ трябваше да renew-не отново')
      const expiresAtAfterSecond = readSessionRow(sessionId).expires_at
      assert(expiresAtAfterFirst === expiresAtAfterSecond, 'expires_at се промени при throttled (втори) touch — ненужен DB write')
    })

    // ── [C2] Throttle граница — remaining lifetime точно над прага не renew-ва
    await check('[C2] remaining lifetime леко над (90д - throttle) прага -> НЕ renew-ва', () => {
      const { sessionToken, sessionId } = registerFresh('c2')
      // remaining = 89 дни + 2 часа > (90d - 1d) прага -> все още не е due.
      setExpiresAt(sessionId, new Date(Date.now() + 89 * DAY_MS + 2 * 60 * 60 * 1000).toISOString())
      const before = readSessionRow(sessionId).expires_at

      const { renewed } = authStore!.touchSession(sessionToken)
      assert(renewed === false, 'renewed=true, въпреки че remaining lifetime е над throttle прага')
      assert(readSessionRow(sessionId).expires_at === before, 'expires_at се промени, въпреки renewed=false')
    })

    // ── [E] Изтекла сесия -> НЕ се съживява ──────────────────────────────
    await check('[E] изтекла сесия -> touchSession() връща null, НЕ renew-ва (не се съживява)', () => {
      const { sessionToken, sessionId } = registerFresh('e')
      setExpiresAt(sessionId, new Date(Date.now() - 60_000).toISOString())

      const { session, renewed } = authStore!.touchSession(sessionToken)
      assert(session === null, 'изтекла сесия трябваше да върне session:null')
      assert(renewed === false, 'изтекла сесия трябваше да върне renewed:false')

      // getSession() трябва да е идентично поведение (unaffected от fix-а).
      assert(authStore!.getSession(sessionToken) === null, 'getSession() съживи изтекла сесия')
    })

    // ── [F] Revoked (logout) сесия -> НЕ се renew-ва ─────────────────────
    await check('[F] revoked (logout) сесия -> touchSession() връща null, НЕ renew-ва', () => {
      const { sessionToken, sessionId } = registerFresh('f')
      setRevoked(sessionId)

      const { session, renewed } = authStore!.touchSession(sessionToken)
      assert(session === null, 'revoked сесия трябваше да върне session:null')
      assert(renewed === false, 'revoked сесия трябваше да върне renewed:false')
    })

    // ── [F2] Непознат/невалиден token -> НЕ renew-ва ─────────────────────
    await check('[F2] непознат token -> touchSession() връща null, НЕ renew-ва', () => {
      const { session, renewed } = authStore!.touchSession('totally-invalid-token-value')
      assert(session === null, 'непознат token трябваше да върне session:null')
      assert(renewed === false, 'непознат token трябваше да върне renewed:false')
    })

    // ── [I] Multiple sessions — renewal на A не пипа B ───────────────────
    await check('[I] renewal на session A НЕ променя expires_at на session B (същия акаунт, различни устройства)', () => {
      const first = registerFresh('i')
      const loginResult = authStore!.login({ email: `renew-i@example.test`, password: PASSWORD, rememberMe: true })
      assert(loginResult.ok, `втори login (device B) failed: ${!loginResult.ok ? loginResult.message : ''}`)
      if (!loginResult.ok) throw new Error('unreachable')
      const second = { sessionToken: loginResult.sessionToken, sessionId: loginResult.session.sessionId }
      assert(first.sessionId !== second.sessionId, 'двата login-а трябваше да създадат различни sessionId (multi-device)')

      // Направи session B "due for renewal", остави A недокоснат.
      setExpiresAt(second.sessionId, new Date(Date.now() + 5 * DAY_MS).toISOString())
      const expiresAtABefore = readSessionRow(first.sessionId).expires_at

      const { renewed } = authStore!.touchSession(second.sessionToken)
      assert(renewed === true, 'session B трябваше да се renew-не')

      const expiresAtAAfter = readSessionRow(first.sessionId).expires_at
      assert(expiresAtABefore === expiresAtAAfter, 'renewal на session B промени expires_at на session A — cross-session leak')
    })

    // ── Timestamp comparison boundary тестове (strftime fix audit) ──────
    await check('[Timestamp-A] сесия изтекла преди 1 секунда -> invalid (getSession връща null)', () => {
      const { sessionToken, sessionId } = registerFresh('tsa')
      setExpiresAt(sessionId, new Date(Date.now() - 1000).toISOString())
      assert(authStore!.getSession(sessionToken) === null, 'сесия, изтекла преди 1 секунда, все още се третира като валидна')
    })
    await check('[Timestamp-B] сесия изтекла преди 1 минута -> invalid (getSession връща null)', () => {
      const { sessionToken, sessionId } = registerFresh('tsb')
      setExpiresAt(sessionId, new Date(Date.now() - 60_000).toISOString())
      assert(authStore!.getSession(sessionToken) === null, 'сесия, изтекла преди 1 минута, все още се третира като валидна')
    })
    await check('[Timestamp-C] сесия валидна още 1 секунда -> valid (getSession връща сесията)', () => {
      const { sessionToken, sessionId } = registerFresh('tsc')
      setExpiresAt(sessionId, new Date(Date.now() + 1000).toISOString())
      assert(authStore!.getSession(sessionToken) !== null, 'сесия, валидна още 1 секунда, се третира като невалидна')
    })
    await check('[Timestamp-D] сесия валидна още 1 ден -> valid (getSession връща сесията)', () => {
      const { sessionToken, sessionId } = registerFresh('tsd')
      setExpiresAt(sessionId, new Date(Date.now() + DAY_MS).toISOString())
      assert(authStore!.getSession(sessionToken) !== null, 'сесия, валидна още 1 ден, се третира като невалидна')
    })

    // ── Атомарен compare-and-swap — детерминирано доказателство ─────────
    await check(
      '[Atomic-CAS] симулиран race: два UPDATE-а със СЪЩИЯ "believed-stale" cutoff -> само първият matchва (changes=1), вторият е changes=0',
      () => {
        // Реален OS-level thread race не е детерминирано възпроизводим в
        // single-process Node test (JS event loop сериализира JS
        // изпълнението въпреки "паралелни" fetch-ове — виж [Concurrent-*]
        // в ЧАСТ 2 за реален HTTP round-trip тест). Тук директно доказваме
        // САМАТА SQL WHERE клауза (не JS timing) гарантира atomic
        // compare-and-swap: изпълняваме ДВА УПДЕЙТ-а гръб до гръб със
        // СЪЩИТЕ bind параметри (new expires_at + cutoff), симулиращи
        // "Request A и Request B, четели СЪЩИЯ 'due' ред и изчислили
        // почти идентичен cutoff, ПРЕДИ който и да е от двата да commit-не"
        // — точно TOCTOU сценария от concurrency отчета. Ако SQL-ът
        // наистина е atomic compare-and-swap, ПЪРВИЯТ UPDATE трябва да
        // matchне (changes=1) и веднага да премести реда извън cutoff-а,
        // затова ВТОРИЯТ (идентичен) UPDATE вече не намира съвпадащ ред
        // (changes=0) — независимо от факта, че двата "биха" прочели
        // СЪЩИЯ стар expires_at, ако имаше отделен SELECT преди всеки.
        const { sessionId } = registerFresh('cas')
        setExpiresAt(sessionId, new Date(Date.now() + 5 * DAY_MS).toISOString())

        const newExpiresAt = new Date(Date.now() + NINETY_DAYS_MS).toISOString()
        const sharedBelievedCutoff = new Date(Date.now() + (NINETY_DAYS_MS - DAY_MS)).toISOString()

        const casUpdateStmt = localDb.prepare(`
          UPDATE account_sessions
          SET expires_at = ?
          WHERE session_id = ?
            AND revoked_at IS NULL
            AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            AND expires_at <= ?;
        `)

        const resultA = casUpdateStmt.run(newExpiresAt, sessionId, sharedBelievedCutoff) as { changes?: number }
        const resultB = casUpdateStmt.run(newExpiresAt, sessionId, sharedBelievedCutoff) as { changes?: number }

        assert((resultA.changes ?? 0) === 1, `"Request A" (winner) трябваше да получи changes=1, получи ${resultA.changes}`)
        assert((resultB.changes ?? 0) === 0, `"Request B" (loser, СЪЩИЯ believed-stale cutoff) трябваше да получи changes=0, получи ${resultB.changes}`)
      },
    )
  } finally {
    authStore?.close()
    progressStore?.close()
    db?.close()
    await rm(tempDir, { recursive: true, force: true })
  }
}

// ─────────────────────────────────────────────────────────────────────────
// ЧАСТ 2 — реален HTTP + WS сървър (Set-Cookie synchronization, restart)
// ─────────────────────────────────────────────────────────────────────────

type HttpResult = { status: number; body: unknown; headers: Record<string, string | string[] | undefined> }

function httpRequest(port: number, pathname: string, method: string, cookie?: string, jsonBody?: unknown): Promise<HttpResult> {
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
          res({ status: r.statusCode ?? 0, body, headers: r.headers as Record<string, string | string[] | undefined> })
        })
      },
    )
    req.on('timeout', () => req.destroy(new Error('HTTP timeout.')))
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

/**
 * Email verification pending-first flow (виж authStore.ts's register() doc
 * коментар) — POST /api/auth/register вече само връща pendingRegistrationId
 * (rawCode никога не напуска сървъра отвъд email-а). Тестовият spawned
 * сървър НЯМА реален Brevo достъп, затова brute-force-ваме 6-цифрения код
 * (1 000 000 HMAC-SHA256 изчисления, <1s) от DB-съхранения code_hash,
 * използвайки СЪЩИЯ production HMAC helper (verifyVerificationCode) и
 * СЪЩИЯ secret, който startServer() подава на spawned процеса
 * (PASSWORD_RESET_RATE_LIMIT_SECRET=TEST_REGISTRATION_SECRET) — легитимна
 * test-harness техника (тестът контролира и двете страни: secret-а И DB
 * файла), не production security bypass.
 */
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

/** register() + verify-registration-email() през реален HTTP — резултатната форма mirror-ва старата директна register() HTTP заявка (status/body/headers), за да не се пипат downstream assertions. */
async function registerAndVerifyHttp(
  port: number,
  databaseFilePath: string,
  secret: string,
  input: { email: string; password: string; displayName: string; gender: 'male' | 'female'; visitorId: string; rememberMe?: boolean },
): Promise<HttpResult> {
  const registerResult = await httpRequest(port, '/api/auth/register', 'POST', undefined, {
    email: input.email,
    password: input.password,
    displayName: input.displayName,
    gender: input.gender,
    visitorId: input.visitorId,
  })
  // pendingRegistrationId се връща и на 503 EMAIL_DELIVERY_FAILED (Brevo не
  // е configured в тестовата среда — очаквано, pending редът persists, виж
  // index.ts's register handler doc коментар) — не само на 200.
  const pendingRegistrationId = (registerResult.body as { pendingRegistrationId?: string } | null)?.pendingRegistrationId ?? ''
  if (pendingRegistrationId === '') return registerResult
  const code = bruteForceVerificationCode(databaseFilePath, pendingRegistrationId, secret)
  // bruteForceVerificationCode блокира Node event loop-а синхронно — на
  // бавни/натоварени machines това понякога кара keep-alive connection-а
  // към spawned сървъра да стане stale ("fetch failed"/ECONNRESET, чисто
  // network-layer transient) — един бърз retry е достатъчен.
  try {
    return await httpRequest(port, '/api/auth/verify-registration-email', 'POST', undefined, {
      pendingRegistrationId,
      code,
      rememberMe: input.rememberMe ?? true,
    })
  } catch {
    await sleep(200)
    return httpRequest(port, '/api/auth/verify-registration-email', 'POST', undefined, {
      pendingRegistrationId,
      code,
      rememberMe: input.rememberMe ?? true,
    })
  }
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

type RunningServer = { child: ChildProcessWithoutNullStreams; output(): string }

async function createIsolatedServerRoot(originalServerRoot: string): Promise<{
  root: string
  serverDir: string
  databaseFile: string
  cleanup(): Promise<void>
}> {
  const root = await mkdtemp(join(tmpdir(), 'belot-session-renewal-http-'))
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
        // Email verification pending-first flow (виж authStore.ts's register()
        // doc коментар) — известна тестова стойност, за да може
        // registerAndVerifyHttp() по-долу да brute-force-не 6-цифрения код от
        // DB-съхранения code_hash (същия HMAC helper като production, виж
        // authHelpers.ts's verifyVerificationCode), без нужда от реален Brevo.
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

function extractCookieValue(setCookieHeaders: string[] | undefined): string | null {
  const raw = setCookieHeaders?.find((c) => c.startsWith('belot_session='))
  return raw ? raw.split(';')[0]! : null
}

function extractMaxAge(setCookieHeaders: string[] | undefined): number | null {
  const raw = setCookieHeaders?.find((c) => c.startsWith('belot_session='))
  if (!raw) return null
  const match = raw.match(/Max-Age=(\d+)/)
  return match ? Number(match[1]) : null
}

async function runHttpLevelTests(): Promise<void> {
  console.log('\n[Part 2] реален HTTP+WS сървър — Set-Cookie synchronization, restart, WS-no-write')

  const isolated = await createIsolatedServerRoot(serverRoot)
  const port = await getFreePort()
  let server = startServer(isolated.serverDir, port)

  try {
    await waitFor('сървърът приема HTTP заявки', async () => {
      try {
        const r = await httpRequest(port, '/api/auth/me', 'GET')
        return r.status === 200
      } catch { return false }
    }, 30_000)

    const email = 'renewhttp@example.test'
    let cookie = ''
    let sessionId = ''

    // ── [G] Регистрация -> cookie Max-Age = 7 776 000 сек (90 дни) ──────
    await check('[G] регистрация -> Set-Cookie belot_session Max-Age = 7776000 (90 * 24 * 60 * 60 сек)', async () => {
      const r = await registerAndVerifyHttp(port, isolated.databaseFile, TEST_REGISTRATION_SECRET, {
        email,
        password: PASSWORD,
        displayName: 'RenewHttp',
        gender: 'male',
        visitorId: randomUUID(),
      })
      assert(r.status === 200, `регистрацията върна ${r.status}: ${JSON.stringify(r.body)}`)
      const setCookie = r.headers['set-cookie'] as string[] | undefined
      const maxAge = extractMaxAge(setCookie)
      assert(maxAge === 90 * 24 * 60 * 60, `Max-Age=${maxAge}, очаквах 7776000`)
      const extractedCookie = extractCookieValue(setCookie)
      assert(extractedCookie !== null, 'липсва belot_session в Set-Cookie')
      cookie = extractedCookie!
      const body = r.body as { session?: { sessionId?: string } }
      sessionId = body.session?.sessionId ?? ''
      assert(sessionId !== '', 'липсва sessionId в register response-а')
    })

    // ── DB директна проверка на expires_at веднага след регистрация ─────
    let expiresAtAfterRegister = ''
    await check('[setup] DB expires_at веднага след регистрация ≈ now + 90 дни', () => {
      const db = new DatabaseSync(isolated.databaseFile, { open: true })
      const row = db.prepare(`SELECT expires_at FROM account_sessions WHERE session_id = ?`).get(sessionId) as { expires_at: string } | undefined
      db.close()
      assert(row !== undefined, 'session row not found')
      expiresAtAfterRegister = row!.expires_at
      const driftMs = Math.abs(new Date(expiresAtAfterRegister).getTime() - (Date.now() + NINETY_DAYS_MS))
      assert(driftMs < 60_000, `expires_at drift твърде голям: ${driftMs}ms`)
    })

    // ── /api/auth/me веднага след регистрация -> НЕ renew-ва (throttle) ─
    await check('[C-http] /api/auth/me веднага след регистрация -> НЕ праща нов Set-Cookie (throttled, remaining lifetime пълен)', async () => {
      const r = await httpRequest(port, '/api/auth/me', 'GET', cookie)
      assert(r.status === 200, `status=${r.status}`)
      const setCookie = r.headers['set-cookie'] as string[] | undefined
      assert(extractCookieValue(setCookie) === null, 'получихме нов Set-Cookie веднага след регистрация — throttle-ът не работи')
    })

    // ── Симулира "минали са няколко дни" -> /api/auth/me renew-ва ───────
    await check('[B] /api/auth/me след симулирани изминали дни -> expires_at се удължава до now+90д, response носи нов Set-Cookie', async () => {
      const db = new DatabaseSync(isolated.databaseFile, { open: true })
      db.exec('PRAGMA journal_mode = WAL;')
      // remaining lifetime = 5 дни (под 89-дневния throttle праг) -> due for renewal.
      db.prepare(`UPDATE account_sessions SET expires_at = ? WHERE session_id = ?`).run(
        new Date(Date.now() + 5 * DAY_MS).toISOString(),
        sessionId,
      )
      db.close()

      const r = await httpRequest(port, '/api/auth/me', 'GET', cookie)
      assert(r.status === 200, `status=${r.status}`)
      const body = r.body as { ok?: boolean; session?: { sessionId?: string } | null }
      assert(body.ok === true && body.session?.sessionId === sessionId, 'authenticated /api/auth/me response не съдържа очакваната сесия')

      const setCookie = r.headers['set-cookie'] as string[] | undefined
      const maxAge = extractMaxAge(setCookie)
      assert(maxAge === 90 * 24 * 60 * 60, `renewal Set-Cookie Max-Age=${maxAge}, очаквах 7776000`)

      const dbAfter = new DatabaseSync(isolated.databaseFile, { open: true })
      const row = dbAfter.prepare(`SELECT expires_at FROM account_sessions WHERE session_id = ?`).get(sessionId) as { expires_at: string }
      dbAfter.close()
      const driftMs = Math.abs(new Date(row.expires_at).getTime() - (Date.now() + NINETY_DAYS_MS))
      assert(driftMs < 60_000, `DB expires_at след renewal drift твърде голям: ${driftMs}ms`)
    })

    // ── [C-http-2] Веднага след renewal — повторна заявка не renew-ва пак ─
    let expiresAtAfterRenewal = ''
    await check('[C-http-2] /api/auth/me веднага след renewal -> втора заявка НЕ праща нов Set-Cookie, expires_at непроменен', async () => {
      const dbBefore = new DatabaseSync(isolated.databaseFile, { open: true })
      const rowBefore = dbBefore.prepare(`SELECT expires_at FROM account_sessions WHERE session_id = ?`).get(sessionId) as { expires_at: string }
      dbBefore.close()
      expiresAtAfterRenewal = rowBefore.expires_at

      const r = await httpRequest(port, '/api/auth/me', 'GET', cookie)
      assert(r.status === 200, `status=${r.status}`)
      const setCookie = r.headers['set-cookie'] as string[] | undefined
      assert(extractCookieValue(setCookie) === null, 'получихме нов Set-Cookie при throttled повторна заявка')

      const dbAfter = new DatabaseSync(isolated.databaseFile, { open: true })
      const rowAfter = dbAfter.prepare(`SELECT expires_at FROM account_sessions WHERE session_id = ?`).get(sessionId) as { expires_at: string }
      dbAfter.close()
      assert(rowAfter.expires_at === expiresAtAfterRenewal, 'expires_at се промени при throttled повторна заявка')
    })

    // ── [Concurrent] Два ЕДНОВРЕМЕННИ /api/auth/me за СЪЩАТА renewal-due
    // сесия — реален HTTP round-trip (Promise.all, без await между двете
    // fetch стартирания). Забележка: детерминираното доказателство за
    // самата atomic compare-and-swap SQL логика е в ЧАСТ 1's [Atomic-CAS]
    // тест (single-process Node event loop сериализира JS изпълнението,
    // затова тук не можем гарантирано да принудим двата HTTP request-а да
    // изпълнят touchSession() в истински overlapping ред) — този тест тук
    // е end-to-end sanity: и двата реални HTTP response-а трябва да
    // автентикират успешно, и точно ЕДИН от тях трябва да носи renewal
    // Set-Cookie (директен, observable proxy за "точно 1 atomic winner",
    // защото renewed===true <=> Set-Cookie се изпраща, виж index.ts).
    let concurrentCookie = ''
    let concurrentSessionId = ''
    await check('[Concurrent-setup] нова регистрация за concurrent renewal теста', async () => {
      const r = await registerAndVerifyHttp(port, isolated.databaseFile, TEST_REGISTRATION_SECRET, {
        email: 'renewconcurrent@example.test',
        password: PASSWORD,
        displayName: 'RenewConcurrent',
        gender: 'male',
        visitorId: randomUUID(),
      })
      assert(r.status === 200, `status=${r.status}`)
      const setCookie = r.headers['set-cookie'] as string[] | undefined
      concurrentCookie = extractCookieValue(setCookie) ?? ''
      const body = r.body as { session?: { sessionId?: string } }
      concurrentSessionId = body.session?.sessionId ?? ''
      assert(concurrentCookie !== '' && concurrentSessionId !== '', 'setup за concurrent теста неуспешен')

      const db = new DatabaseSync(isolated.databaseFile, { open: true })
      db.exec('PRAGMA journal_mode = WAL;')
      db.prepare(`UPDATE account_sessions SET expires_at = ? WHERE session_id = ?`).run(
        new Date(Date.now() + 5 * DAY_MS).toISOString(),
        concurrentSessionId,
      )
      db.close()
    })
    await check(
      '[Concurrent] 2 едновременни /api/auth/me за СЪЩАТА renewal-due сесия -> и двата auth success, точно ЕДИН носи renewal Set-Cookie, финален expires_at ≈ +90д, без SQLITE_BUSY',
      async () => {
        const [r1, r2] = await Promise.all([
          httpRequest(port, '/api/auth/me', 'GET', concurrentCookie),
          httpRequest(port, '/api/auth/me', 'GET', concurrentCookie),
        ])

        assert(r1.status === 200 && r2.status === 200, `status1=${r1.status} status2=${r2.status} (SQLITE_BUSY/error би дал != 200)`)

        const body1 = r1.body as { ok?: boolean; session?: { sessionId?: string } | null }
        const body2 = r2.body as { ok?: boolean; session?: { sessionId?: string } | null }
        assert(body1.ok === true && body1.session?.sessionId === concurrentSessionId, `request 1 authentication неуспешен: ${JSON.stringify(body1)}`)
        assert(body2.ok === true && body2.session?.sessionId === concurrentSessionId, `request 2 authentication неуспешен: ${JSON.stringify(body2)}`)

        const setCookie1 = extractCookieValue(r1.headers['set-cookie'] as string[] | undefined)
        const setCookie2 = extractCookieValue(r2.headers['set-cookie'] as string[] | undefined)
        const cookieCount = [setCookie1, setCookie2].filter((c) => c !== null).length
        assert(cookieCount === 1, `очаквах точно 1 response с renewal Set-Cookie (единствен atomic winner), получих ${cookieCount}`)

        const dbAfter = new DatabaseSync(isolated.databaseFile, { open: true })
        const row = dbAfter.prepare(`SELECT expires_at FROM account_sessions WHERE session_id = ?`).get(concurrentSessionId) as { expires_at: string }
        dbAfter.close()
        const driftMs = Math.abs(new Date(row.expires_at).getTime() - (Date.now() + NINETY_DAYS_MS))
        assert(driftMs < 60_000, `финален expires_at drift твърде голям: ${driftMs}ms`)
      },
    )
    await check('[Concurrent-follow-up] непосредствена следваща заявка след concurrent renewal-а -> НЕ renew-ва пак (throttled)', async () => {
      const r = await httpRequest(port, '/api/auth/me', 'GET', concurrentCookie)
      assert(r.status === 200, `status=${r.status}`)
      const setCookie = extractCookieValue(r.headers['set-cookie'] as string[] | undefined)
      assert(setCookie === null, 'заявка непосредствено след concurrent renewal пак получи Set-Cookie')
    })

    // ── WS connect с валидна сесия -> автентикация работи, БЕЗ DB write ──
    await check('[WS] WS connect с belot_session cookie автентикира успешно, БЕЗ да променя expires_at (WS сам по себе си не пише в DB)', async () => {
      const expiresAtBeforeWs = expiresAtAfterRenewal
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: cookie } })
      const messages: Array<{ type?: string }> = []
      await new Promise<void>((resolveOpen, rejectOpen) => {
        const t = setTimeout(() => rejectOpen(new Error('WS connect timeout')), 5000)
        socket.on('open', () => { clearTimeout(t); resolveOpen() })
        socket.on('error', (e) => { clearTimeout(t); rejectOpen(e) })
      })
      socket.on('message', (raw) => { try { messages.push(JSON.parse(raw.toString('utf8'))) } catch { /* ignore */ } })
      await waitFor('WS connected frame', async () => messages.some((m) => m.type === 'connected'), 5000)
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close()

      const db = new DatabaseSync(isolated.databaseFile, { open: true })
      const row = db.prepare(`SELECT expires_at FROM account_sessions WHERE session_id = ?`).get(sessionId) as { expires_at: string }
      db.close()
      assert(row.expires_at === expiresAtBeforeWs, 'expires_at се промени само от WS connect — WS не бива да пише в DB')
    })

    // ── [E-http] Изтекла сесия -> /api/auth/me не я връща, иска нов login ─
    await check('[E-http] изтекла сесия -> /api/auth/me връща session:null (изисква нов login)', async () => {
      const db = new DatabaseSync(isolated.databaseFile, { open: true })
      db.exec('PRAGMA journal_mode = WAL;')
      db.prepare(`UPDATE account_sessions SET expires_at = datetime('now', '-1 hour') WHERE session_id = ?`).run(sessionId)
      db.close()

      const r = await httpRequest(port, '/api/auth/me', 'GET', cookie)
      assert(r.status === 200, `status=${r.status}`)
      const body = r.body as { ok?: boolean; session?: unknown }
      assert(body.ok === true && body.session === null, `очаквах session:null за изтекла сесия, получих: ${JSON.stringify(body)}`)
      const setCookie = r.headers['set-cookie'] as string[] | undefined
      assert(extractCookieValue(setCookie) === null, 'изтекла сесия не биваше да получи renewal Set-Cookie')
    })

    // ── [F-http] logout -> /api/auth/logout revoke-ва + clear-ва cookie ──
    let logoutCookie = ''
    let logoutSessionId = ''
    await check('[F-http-setup] нова регистрация за logout теста', async () => {
      const r = await registerAndVerifyHttp(port, isolated.databaseFile, TEST_REGISTRATION_SECRET, {
        email: 'renewhttplogout@example.test',
        password: PASSWORD,
        displayName: 'RenewHttpLogout',
        gender: 'female',
        visitorId: randomUUID(),
      })
      assert(r.status === 200, `status=${r.status}`)
      const setCookie = r.headers['set-cookie'] as string[] | undefined
      logoutCookie = extractCookieValue(setCookie) ?? ''
      const body = r.body as { session?: { sessionId?: string } }
      logoutSessionId = body.session?.sessionId ?? ''
      assert(logoutCookie !== '' && logoutSessionId !== '', 'setup за logout теста неуспешен')
    })
    await check('[F-http] logout -> revoked сесия -> /api/auth/me след това не renew-ва, НЕ автентикира', async () => {
      const logoutResult = await httpRequest(port, '/api/auth/logout', 'POST', logoutCookie)
      assert(logoutResult.status === 200, `logout status=${logoutResult.status}`)

      // Дори ако remaining lifetime е малък (due for renewal by timing),
      // revoked_at вече не е NULL -> НЕ бива да renew-не.
      const db = new DatabaseSync(isolated.databaseFile, { open: true })
      db.exec('PRAGMA journal_mode = WAL;')
      db.prepare(`UPDATE account_sessions SET expires_at = ? WHERE session_id = ?`).run(
        new Date(Date.now() + 5 * DAY_MS).toISOString(),
        logoutSessionId,
      )
      db.close()

      const r = await httpRequest(port, '/api/auth/me', 'GET', logoutCookie)
      const body = r.body as { ok?: boolean; session?: unknown }
      assert(body.session === null, 'revoked (logout) сесия все пак автентикира /api/auth/me')
      const setCookie = r.headers['set-cookie'] as string[] | undefined
      assert(extractCookieValue(setCookie) === null, 'revoked (logout) сесия получи renewal Set-Cookie')
    })

    // ── [H] PM2/server restart — DB-backed сесия оцелява ─────────────────
    // Собствена, НЕ пипана от предишните тестове регистрация — "cookie"/
    // "sessionId" от по-рано вече бяха нарочно направени expired в
    // [E-http] теста по-горе; reuse-ването им тук би дало false failure,
    // несвързан с реалното restart поведение.
    let restartCookie = ''
    let restartSessionId = ''
    await check('[H-setup] нова регистрация за restart теста', async () => {
      const r = await registerAndVerifyHttp(port, isolated.databaseFile, TEST_REGISTRATION_SECRET, {
        email: 'renewhttprestart@example.test',
        password: PASSWORD,
        displayName: 'RenewHttpRestart',
        gender: 'male',
        visitorId: randomUUID(),
      })
      assert(r.status === 200, `status=${r.status}`)
      const setCookie = r.headers['set-cookie'] as string[] | undefined
      restartCookie = extractCookieValue(setCookie) ?? ''
      const body = r.body as { session?: { sessionId?: string } }
      restartSessionId = body.session?.sessionId ?? ''
      assert(restartCookie !== '' && restartSessionId !== '', 'setup за restart теста неуспешен')
    })
    await check('[H] restart на server процеса (СЪЩИЯТ DB файл) -> валидната сесия остава автентикирана', async () => {
      await stopServer(server)
      server = startServer(isolated.serverDir, port)
      await waitFor('сървърът е готов след restart', async () => {
        try {
          const r = await httpRequest(port, '/api/auth/me', 'GET')
          return r.status === 200
        } catch { return false }
      }, 30_000)

      const r = await httpRequest(port, '/api/auth/me', 'GET', restartCookie)
      assert(r.status === 200, `status=${r.status}`)
      const body = r.body as { ok?: boolean; session?: { sessionId?: string } | null }
      assert(body.session?.sessionId === restartSessionId, 'сесията не оцеля след PM2/server restart, въпреки че е DB-backed и все още валидна')
    })
  } finally {
    await stopServer(server)
    await isolated.cleanup()
  }
}

// ─────────────────────────────────────────────────────────────────────────

console.log('\ncheckAuthSessionRollingRenewal')

await runAuthStoreLevelTests()
await runHttpLevelTests()

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exitCode = 1
