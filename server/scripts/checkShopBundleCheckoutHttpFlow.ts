/**
 * checkShopBundleCheckoutHttpFlow.ts
 *
 * HTTP route-level checks за Shop -> "Пакети" (X жълтици + X дни VIP = X
 * EUR): GET /api/shop/bundle-packages, POST /api/shop/bundle-checkout,
 * GET /api/shop/bundle-purchases, PATCH /api/shop/bundle-purchases/:id/hide,
 * GET/POST/PATCH/DELETE /api/admin/bundle-packages. Живо стартиран сървър
 * (isolated temp server root, real HTTP requests) — established
 * checkVipCheckoutHttpFlow.ts/checkAdminPayments.ts pattern.
 *
 * ВАЖНО: STRIPE_SECRET_KEY НЕ е зададен в тестовата среда (mirror на
 * checkVipCheckoutHttpFlow.ts §11 rationale — "Do NOT use live Stripe
 * requests in tests"). Checkout endpoint-ът винаги връща 500 "Stripe не е
 * конфигуриран" СЛЕД всички auth/validation gates — доказва, че auth/
 * package/forged-reward guard-овете изпълняват ПРЕДИ каквото и да е Stripe
 * извикване.
 *
 * [1]  GET /api/admin/bundle-packages без admin cookie → 403
 * [2]  GET /api/admin/bundle-packages с обикновен (не-admin) cookie → 403
 * [3]  POST /api/admin/bundle-packages (admin) създава нов пакет → 200,
 *        стойностите точно каквито са подадени
 * [4]  GET /api/shop/bundle-packages (public, без auth) връща САМО active
 *        пакети — inactive пакет НЕ се вижда
 * [5]  PATCH /api/admin/bundle-packages/:id/status → 'inactive' премахва
 *        пакета от public listing-а
 * [6]  PATCH /api/admin/bundle-packages/:id/status → 'active' връща го
 * [7]  POST /api/admin/bundle-packages с невалидни стойности (coins<=0) → 400
 * [8]  POST /api/admin/bundle-packages с невалидни VIP дни (<=0) → 400
 * [9]  POST /api/admin/bundle-packages с невалидна цена (<=0) → 400
 * [10] POST /api/shop/bundle-checkout без cookie → 401, никаква покупка
 * [11] POST /api/shop/bundle-checkout с невалиден packageId → 400
 * [12] POST /api/shop/bundle-checkout с forged/невалидни полета в body
 *        (priceCents, yellowCoinsAmount, vipDays) → полетата се игнорират
 *        напълно (сървърът чете САМО packageId); заявката стига до
 *        Stripe-not-configured 500 (НЕ 400 validation error) — доказва, че
 *        forged полетата не са били дори прочетени
 * [13] GET /api/shop/bundle-purchases без cookie → 401
 * [14] GET /api/shop/bundle-purchases с валидна cookie → 200, purchases: []
 *        (никаква покупка не е успяла да се създаде без Stripe конфигурация)
 * [15] DELETE /api/admin/bundle-packages/:id премахва пакета от admin listing-а
 * [16] Existing coin flow (POST /api/shop/checkout) остава напълно
 *        незасегнат от bundle интеграцията
 * [17] Existing VIP flow (POST /api/vip/checkout) остава напълно незасегнат
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { verifyVerificationCode } from '../src/db/authHelpers.js'

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

async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
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
function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
  }
}

const PASSWORD = 'BundleCheckoutHttpCheck1!'
const SERVER_READY_TIMEOUT_MS = 30_000
// Email-verification pending-first register() изисква registrationVerificationCodeSecret
// (≥32 символа) — TEST-ONLY, deterministic, mirror на established pattern в
// checkTournamentHighEntryFeesHttp.ts/checkPrivateRoomWebSocketRoundTrip.ts.
const TEST_REGISTRATION_SECRET = 'shop-bundle-checkout-http-test-secret-0123456789'

function getFreePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (!addr || typeof addr === 'string') { srv.close(() => reject(new Error('No free port'))); return }
      const { port } = addr
      srv.close(() => resolvePromise(port))
    })
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitFor(label: string, pred: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await pred()) return
    await sleep(100)
  }
  throw new Error(`Timeout: ${label}`)
}

const sourceRoot = resolve(
  process.argv.slice(2).find((a) => a.startsWith('--server-root='))?.slice('--server-root='.length)
    ?? process.cwd(),
)
console.log(`  Server root: ${sourceRoot}`)

async function retryRm(path: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try { await rm(path, { recursive: true, force: true }); return } catch { /* retry */ }
    await new Promise<void>((r) => setTimeout(r, 250))
  }
}

async function makeIsolated(root: string): Promise<{ serverDir: string; cleanup: () => Promise<void> }> {
  const { existsSync } = await import('node:fs')
  const isServerDir = existsSync(join(root, 'src', 'index.ts'))
  const serverSrc = isServerDir ? root : join(root, 'server')

  const tmp = await mkdtemp(join(tmpdir(), 'belot-bundle-checkout-http-'))
  const serverDir = join(tmp, 'server')
  await mkdir(serverDir, { recursive: true })
  await cp(join(serverSrc, 'src'), join(serverDir, 'src'), { recursive: true, preserveTimestamps: true })
  await cp(join(serverSrc, 'dist'), join(serverDir, 'dist'), { recursive: true, preserveTimestamps: true })
  await mkdir(join(serverDir, 'database', 'data'), { recursive: true })
  await cp(join(serverSrc, 'database', 'migrations'), join(serverDir, 'database', 'migrations'), { recursive: true, preserveTimestamps: true })
  await cp(join(serverSrc, 'package.json'), join(serverDir, 'package.json'), { preserveTimestamps: true })
  const lt = process.platform === 'win32' ? 'junction' : 'dir'
  await symlink(join(serverSrc, 'node_modules'), join(serverDir, 'node_modules'), lt)
  await symlink(join(serverSrc, '..', 'node_modules'), join(tmp, 'node_modules'), lt)
  return {
    serverDir,
    cleanup: () => retryRm(tmp),
  }
}

function startSrv(serverDir: string, port: number): { child: ChildProcessWithoutNullStreams; output(): string } {
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
        // Изрично БЕЗ STRIPE_SECRET_KEY/STRIPE_WEBHOOK_SECRET — виж top-of-file
        // коментара. Checkout endpoint-ът трябва да мине auth/validation
        // ПРЕДИ да стигне до Stripe-not-configured 500-ката.
        STRIPE_SECRET_KEY: '',
        STRIPE_WEBHOOK_SECRET: '',
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

async function stopSrv(s: { child: ChildProcessWithoutNullStreams }): Promise<void> {
  if (s.child.exitCode !== null) return
  s.child.kill('SIGTERM')
  await new Promise<void>((r) => {
    const t = setTimeout(() => { s.child.kill('SIGKILL'); r() }, 10_000)
    s.child.once('exit', () => { clearTimeout(t); r() })
  })
}

type HttpResult = { status: number; body: Record<string, unknown> }

async function httpJson(
  port: number,
  method: string,
  pathname: string,
  options: { cookie?: string; body?: unknown } = {},
): Promise<HttpResult> {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(options.cookie ? { Cookie: options.cookie } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  })
  let body: Record<string, unknown> = {}
  try {
    body = (await response.json()) as Record<string, unknown>
  } catch {
    // no body / non-JSON — leave as {}
  }
  return { status: response.status, body }
}

// ─── Registration: established email-verification pending-first pattern ───
// (mirror на checkTournamentHighEntryFeesHttp.ts) — /api/auth/register вече
// не връща сесия директно, а pendingRegistrationId; кодът се brute-force-ва
// от DB-съхранения code_hash със същия production HMAC helper.

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

async function registerAndLogin(port: number, databaseFile: string, suffix: string): Promise<{ cookie: string; email: string }> {
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const email = `bundle-checkout-${suffix}-${runId}@example.test`.toLowerCase()
  const reg = await httpJson(port, 'POST', '/api/auth/register', {
    body: {
      email,
      password: PASSWORD,
      displayName: `BundleCheckout${suffix}`,
      gender: 'male',
      visitorId: randomUUID(),
    },
  })
  // pendingRegistrationId се връща и на 200, и на 503 EMAIL_DELIVERY_FAILED
  // (Brevo не е конфигуриран в тестовата среда — очаквано).
  const pendingRegistrationId = reg.body.pendingRegistrationId as string | undefined
  if (!pendingRegistrationId) throw new Error(`Регистрацията се провали за ${suffix}: ${JSON.stringify(reg.body)}`)

  const code = bruteForceVerificationCode(databaseFile, pendingRegistrationId, TEST_REGISTRATION_SECRET)

  const response = await fetch(`http://127.0.0.1:${port}/api/auth/verify-registration-email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pendingRegistrationId, code, rememberMe: true }),
  })
  const h = response.headers as Headers & { getSetCookie?: () => string[] }
  const cookie = (h.getSetCookie?.()[0] ?? response.headers.get('set-cookie'))?.split(';')[0]
  if (response.status !== 200 || !cookie) {
    const body = await response.json().catch(() => ({}))
    throw new Error(`verify-registration-email се провали за ${suffix}: status=${response.status} body=${JSON.stringify(body)}`)
  }
  return { cookie, email }
}

const iso = await makeIsolated(sourceRoot)
const port = await getFreePort()
let srv: ReturnType<typeof startSrv> | null = null

try {
  srv = startSrv(iso.serverDir, port)
  console.log(`  Чакам сървъра на порт ${port}…`)
  await waitFor('server ready', async () => {
    try {
      const r = await httpJson(port, 'GET', '/health')
      const h = r.body as { ok?: boolean; gameWorkerLifecycle?: { state?: string } | null }
      return r.status === 200 && h.ok === true && h.gameWorkerLifecycle?.state === 'ready'
    } catch { return false }
  }, SERVER_READY_TIMEOUT_MS)
  console.log('  Сървърът е готов.\n')

  const dbFile = join(iso.serverDir, 'database', 'data', 'belot-v2.sqlite')
  const runId = `${Date.now()}-${process.pid}`

  const player = await registerAndLogin(port, dbFile, 'player')
  const otherPlayer = await registerAndLogin(port, dbFile, 'other')
  const admin = await registerAndLogin(port, dbFile, 'admin')
  const playerCookie = player.cookie
  const otherPlayerCookie = otherPlayer.cookie
  const adminCookie = admin.cookie

  const db = new DatabaseSync(dbFile)
  db.prepare(`UPDATE accounts SET role='admin' WHERE email=?`).run(admin.email)
  db.close()

  // ─── [1]-[2] Admin permission gate ─────────────────────────────────────────

  await check('[1] GET /api/admin/bundle-packages без cookie → 403', async () => {
    const r = await httpJson(port, 'GET', '/api/admin/bundle-packages')
    assertEqual(r.status, 403, 'status')
  })

  await check('[2] GET /api/admin/bundle-packages с обикновен (не-admin) cookie → 403', async () => {
    const r = await httpJson(port, 'GET', '/api/admin/bundle-packages', { cookie: playerCookie })
    assertEqual(r.status, 403, 'status')
  })

  // ─── [3] Admin create ───────────────────────────────────────────────────────

  let createdPackageId = ''
  await check('[3] POST /api/admin/bundle-packages (admin) създава нов пакет → 200, стойностите точни', async () => {
    const r = await httpJson(port, 'POST', '/api/admin/bundle-packages', {
      cookie: adminCookie,
      body: {
        packageKey: `super-${runId}`,
        title: 'Супер',
        description: 'Тестов пакет',
        yellowCoinsAmount: 500000,
        vipDays: 30,
        priceCents: 999,
        currency: 'EUR',
        status: 'active',
        sortOrder: 10,
      },
    })
    assertEqual(r.status, 200, 'status')
    const pkg = r.body.package as Record<string, unknown>
    assertEqual(pkg.title, 'Супер', 'title')
    assertEqual(pkg.yellowCoinsAmount, 500000, 'yellowCoinsAmount')
    assertEqual(pkg.vipDays, 30, 'vipDays')
    assertEqual(pkg.priceCents, 999, 'priceCents')
    assertEqual(pkg.status, 'active', 'status')
    createdPackageId = String(pkg.packageId)
    assert(createdPackageId.length > 0, 'packageId present')
    assertEqual(pkg.visualKey, null, 'visualKey не е подаден -> established default null')
  })

  // ─── Shop -> "Пакети" Premium Visual System — visualKey API contract ──────

  await check('[3b] POST /api/admin/bundle-packages с валиден visualKey → 200, response.package.visualKey точен', async () => {
    const r = await httpJson(port, 'POST', '/api/admin/bundle-packages', {
      cookie: adminCookie,
      body: {
        packageKey: `visual-${runId}`,
        title: 'Визуален',
        description: '',
        yellowCoinsAmount: 250000,
        vipDays: 15,
        priceCents: 599,
        currency: 'EUR',
        status: 'active',
        sortOrder: 15,
        visualKey: 'crown',
      },
    })
    assertEqual(r.status, 200, 'status')
    const pkg = r.body.package as Record<string, unknown>
    assertEqual(pkg.visualKey, 'crown', 'visualKey')

    const pub = await httpJson(port, 'GET', '/api/shop/bundle-packages')
    const packages = pub.body.packages as Array<Record<string, unknown>>
    const publicRow = packages.find((p) => p.packageId === pkg.packageId)
    assert(publicRow !== undefined, 'пакетът трябва да е в public listing-а')
    assertEqual(publicRow?.visualKey, 'crown', 'public response трябва да носи visualKey')
  })

  await check('[3c] POST /api/admin/bundle-packages с непознат visualKey → 400', async () => {
    const r = await httpJson(port, 'POST', '/api/admin/bundle-packages', {
      cookie: adminCookie,
      body: {
        packageKey: `bad-visual-${runId}`,
        title: 'Невалиден',
        description: '',
        yellowCoinsAmount: 100000,
        vipDays: 10,
        priceCents: 299,
        currency: 'EUR',
        status: 'active',
        sortOrder: 16,
        visualKey: 'totally-bogus-key',
      },
    })
    assertEqual(r.status, 400, 'status')
  })

  await check('[3d] POST edit (packageId зададен) с нов visualKey → 200, persisted', async () => {
    const r = await httpJson(port, 'POST', '/api/admin/bundle-packages', {
      cookie: adminCookie,
      body: {
        packageId: createdPackageId,
        title: 'Супер',
        description: 'Тестов пакет',
        yellowCoinsAmount: 500000,
        vipDays: 30,
        priceCents: 999,
        currency: 'EUR',
        status: 'active',
        sortOrder: 10,
        visualKey: 'treasure-chest',
      },
    })
    assertEqual(r.status, 200, 'status')
    assertEqual((r.body.package as Record<string, unknown>).visualKey, 'treasure-chest', 'visualKey updated')

    const admin = await httpJson(port, 'GET', '/api/admin/bundle-packages', { cookie: adminCookie })
    const packages = admin.body.packages as Array<Record<string, unknown>>
    const row = packages.find((p) => p.packageId === createdPackageId)
    assertEqual(row?.visualKey, 'treasure-chest', 'admin listing трябва да отрази новия visualKey')
  })

  // ─── [4] Public listing shows only active ──────────────────────────────────

  let inactivePackageId = ''
  await check('[4 setup] create a second, INACTIVE package', async () => {
    const r = await httpJson(port, 'POST', '/api/admin/bundle-packages', {
      cookie: adminCookie,
      body: {
        packageKey: `hidden-${runId}`,
        title: 'Скрит пакет',
        description: '',
        yellowCoinsAmount: 100000,
        vipDays: 7,
        priceCents: 199,
        currency: 'EUR',
        status: 'inactive',
        sortOrder: 20,
      },
    })
    assertEqual(r.status, 200, 'status')
    inactivePackageId = String((r.body.package as Record<string, unknown>).packageId)
  })

  await check('[4] GET /api/shop/bundle-packages (public) връща само active пакети', async () => {
    const r = await httpJson(port, 'GET', '/api/shop/bundle-packages')
    assertEqual(r.status, 200, 'status')
    const packages = r.body.packages as Array<Record<string, unknown>>
    assert(packages.some((p) => p.packageId === createdPackageId), 'active package listed')
    assert(!packages.some((p) => p.packageId === inactivePackageId), 'inactive package NOT listed')
  })

  // ─── [5]-[6] Status toggle ──────────────────────────────────────────────────

  await check('[5] PATCH status=inactive премахва active пакета от public listing-а', async () => {
    const r = await httpJson(port, 'PATCH', `/api/admin/bundle-packages/${encodeURIComponent(createdPackageId)}/status`, {
      cookie: adminCookie,
      body: { status: 'inactive' },
    })
    assertEqual(r.status, 200, 'status')

    const pub = await httpJson(port, 'GET', '/api/shop/bundle-packages')
    const packages = pub.body.packages as Array<Record<string, unknown>>
    assert(!packages.some((p) => p.packageId === createdPackageId), 'package hidden after deactivate')
  })

  await check('[6] PATCH status=active връща пакета в public listing-а', async () => {
    const r = await httpJson(port, 'PATCH', `/api/admin/bundle-packages/${encodeURIComponent(createdPackageId)}/status`, {
      cookie: adminCookie,
      body: { status: 'active' },
    })
    assertEqual(r.status, 200, 'status')

    const pub = await httpJson(port, 'GET', '/api/shop/bundle-packages')
    const packages = pub.body.packages as Array<Record<string, unknown>>
    assert(packages.some((p) => p.packageId === createdPackageId), 'package visible after reactivate')
  })

  // ─── [7]-[9] Admin validation ───────────────────────────────────────────────

  await check('[7] POST /api/admin/bundle-packages coins<=0 → 400', async () => {
    const r = await httpJson(port, 'POST', '/api/admin/bundle-packages', {
      cookie: adminCookie,
      body: { packageKey: `bad-coins-${runId}`, title: 'Bad', description: '', yellowCoinsAmount: 0, vipDays: 30, priceCents: 999, currency: 'EUR', status: 'active', sortOrder: 0 },
    })
    assertEqual(r.status, 400, 'status')
  })

  await check('[8] POST /api/admin/bundle-packages vipDays<=0 → 400', async () => {
    const r = await httpJson(port, 'POST', '/api/admin/bundle-packages', {
      cookie: adminCookie,
      body: { packageKey: `bad-days-${runId}`, title: 'Bad', description: '', yellowCoinsAmount: 100000, vipDays: 0, priceCents: 999, currency: 'EUR', status: 'active', sortOrder: 0 },
    })
    assertEqual(r.status, 400, 'status')
  })

  await check('[9] POST /api/admin/bundle-packages priceCents<=0 → 400', async () => {
    const r = await httpJson(port, 'POST', '/api/admin/bundle-packages', {
      cookie: adminCookie,
      body: { packageKey: `bad-price-${runId}`, title: 'Bad', description: '', yellowCoinsAmount: 100000, vipDays: 30, priceCents: 0, currency: 'EUR', status: 'active', sortOrder: 0 },
    })
    assertEqual(r.status, 400, 'status')
  })

  // ─── [10]-[12] Checkout guard order ─────────────────────────────────────────

  await check('[10] POST /api/shop/bundle-checkout без cookie → 401, никаква покупка', async () => {
    const r = await httpJson(port, 'POST', '/api/shop/bundle-checkout', { body: { packageId: createdPackageId } })
    assertEqual(r.status, 401, 'status')
  })

  await check('[11] POST /api/shop/bundle-checkout с невалиден packageId → 400', async () => {
    const r = await httpJson(port, 'POST', '/api/shop/bundle-checkout', {
      cookie: playerCookie,
      body: { packageId: 'not-a-real-package-id' },
    })
    assertEqual(r.status, 400, 'status')
  })

  await check(
    '[12] POST /api/shop/bundle-checkout с forged priceCents/yellowCoinsAmount/vipDays → полетата се игнорират, стига до Stripe-not-configured 500 (не 400)',
    async () => {
      const r = await httpJson(port, 'POST', '/api/shop/bundle-checkout', {
        cookie: playerCookie,
        body: {
          packageId: createdPackageId,
          priceCents: 1,
          yellowCoinsAmount: 999999999,
          vipDays: 99999,
        },
      })
      // Stripe не е конфигуриран в тестовата среда — 500 доказва, че auth+
      // package validation вече мина УСПЕШНО (forged reward fields никога
      // не се четат от сървъра, viж handleShopBundleCheckoutRequest —
      // единственото поле, четено от body, е packageId).
      assertEqual(r.status, 500, 'status (Stripe-not-configured, proves forged fields were ignored)')
      assert(!String(r.body.message ?? '').includes('999999999'), 'forged coins amount never echoed back')
    },
  )

  // ─── [13]-[14] Purchase history isolation ───────────────────────────────────

  await check('[13] GET /api/shop/bundle-purchases без cookie → 401', async () => {
    const r = await httpJson(port, 'GET', '/api/shop/bundle-purchases')
    assertEqual(r.status, 401, 'status')
  })

  await check('[14] GET /api/shop/bundle-purchases с валидна cookie → 200, всички видими покупки са status:pending (нищо не е settle-нало без Stripe, test [12] остави точно 1 pending ред)', async () => {
    const r = await httpJson(port, 'GET', '/api/shop/bundle-purchases', { cookie: playerCookie })
    assertEqual(r.status, 200, 'status')
    assert(Array.isArray(r.body.purchases), 'purchases is array')
    const purchases = r.body.purchases as Array<Record<string, unknown>>
    assert(purchases.every((p) => p.status === 'pending'), 'ниkоя покупка не трябва да е paid без реален Stripe settlement')
  })

  await check('[14b] other logged-in profile also sees an empty purchase history (data isolation baseline)', async () => {
    const r = await httpJson(port, 'GET', '/api/shop/bundle-purchases', { cookie: otherPlayerCookie })
    assertEqual(r.status, 200, 'status')
    assertEqual((r.body.purchases as unknown[]).length, 0, 'purchases empty for other profile too')
  })

  // ─── [15] Delete ─────────────────────────────────────────────────────────────

  await check('[15] DELETE /api/admin/bundle-packages/:id премахва пакета от admin listing-а', async () => {
    const r = await httpJson(port, 'DELETE', `/api/admin/bundle-packages/${encodeURIComponent(inactivePackageId)}`, { cookie: adminCookie })
    assertEqual(r.status, 200, 'status')

    const list = await httpJson(port, 'GET', '/api/admin/bundle-packages', { cookie: adminCookie })
    const packages = list.body.packages as Array<Record<string, unknown>>
    assert(!packages.some((p) => p.packageId === inactivePackageId), 'deleted package no longer in admin listing')
  })

  // ─── [16]-[17] Existing coin/VIP flows unaffected ──────────────────────────

  await check('[16] съществуващ coin flow (POST /api/shop/checkout) остава незасегнат — без cookie → 401', async () => {
    const r = await httpJson(port, 'POST', '/api/shop/checkout', { body: { packageId: 'coin-package-starter' } })
    assertEqual(r.status, 401, 'status')
  })

  await check('[17] съществуващ VIP flow (POST /api/vip/checkout) остава незасегнат — без cookie → 401', async () => {
    const r = await httpJson(port, 'POST', '/api/vip/checkout', { body: { packageId: 'vip_30' } })
    assertEqual(r.status, 401, 'status')
  })

  console.log('')
  console.log(`Passed: ${passed}, Failed: ${failed}`)
} finally {
  if (srv) await stopSrv(srv)
  await iso.cleanup()
}

process.exit(failed > 0 ? 1 : 0)
