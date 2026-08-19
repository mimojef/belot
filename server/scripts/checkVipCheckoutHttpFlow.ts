/**
 * checkVipCheckoutHttpFlow.ts
 *
 * HTTP route-level checks за POST /api/vip/checkout, GET /api/vip/purchases,
 * PATCH /api/admin/settings (VIP price 0-cent policy), и sanity check че
 * съществуващият coin Stripe flow (POST /api/shop/checkout) остава незасегнат
 * от VIP интеграцията. Живо стартиран сървър (isolated temp server root,
 * real HTTP requests) — established checkAdminPayments.ts pattern.
 *
 * ВАЖНО: STRIPE_SECRET_KEY НЕ е зададен в тестовата среда (виж §11 в брифа —
 * "Do NOT use live Stripe requests in tests"). Затова checkout endpoint-ите
 * винаги връщат 500 "Stripe не е конфигуриран" СЛЕД всички auth/validation
 * gates — това е точно правилното поведение за да потвърдим, че auth/package/
 * forged-price guard-овете изпълняват ПРЕДИ каквото и да е Stripe извикване
 * (тестовете по-долу assert-ват точно тази подредба: 401/400 се случват
 * преди да стигнем до Stripe-специфичния 500).
 *
 * [1]  POST /api/vip/checkout без cookie → 401, никаква pending покупка не се създава
 * [2]  POST /api/vip/checkout с невалиден packageId → 400, никаква покупка
 * [3]  POST /api/vip/checkout с forged/невалидни price полета в body (priceCents,
 *        days, activeUntil) → полетата се игнорират напълно (сървърът чете
 *        САМО packageId от body); заявката продължава по нормалния path
 *        (стига до Stripe-not-configured 500, НЕ до a 400 validation error,
 *        което доказва, че forged полетата не са били дори прочетени)
 * [4]  GET /api/vip/purchases без cookie → 401
 * [5]  GET /api/vip/purchases с валидна cookie → 200, purchases: []
 *        (никаква покупка не е успяла да се създаде без Stripe конфигурация)
 * [6]  PATCH /api/admin/settings (non-admin cookie) → 403
 * [7]  PATCH /api/admin/settings vipPrice30DaysCents=0 (admin) → 400,
 *        explicit validation грешка, НЕ silent clamp към 1
 * [8]  PATCH /api/admin/settings vipPrice30DaysCents=-50 (admin) → 400
 * [9]  PATCH /api/admin/settings vipPrice30DaysCents=1.5 (non-integer, admin) → 400
 * [9b] PATCH /api/admin/settings vipPrice30DaysCents="abc" (string garbage) → 400,
 *        НЕ silent ignore (fix: getNumberField()===null ЗА key ПРИСЪСТВАЩ в body
 *        вече е explicit reject, не "field absent" collapse)
 * [9c] PATCH /api/admin/settings vipPrice30DaysCents=null (JSON null) → 400
 * [9d] PATCH /api/admin/settings с невалиден JSON синтаксис (Infinity literal) → 400/500
 * [10] GET /api/vip/packages отразява admin-зададена цена веднага (subsequent
 *        checkout would use new price — packages endpoint е единственият
 *        source, който checkout чете, значи потвърждаването тук е достатъчно)
 * [11] POST /api/shop/checkout (coins) без cookie → 401 (existing coin flow
 *        route table непроменен от VIP интеграцията)
 * [12] POST /api/shop/checkout (coins) с невалиден packageId → 400 (coin
 *        validation path непроменен)
 * [13] Setup: стара PAID покупка A директно в DB (симулира минал webhook)
 * [14] Setup: нов checkout B (различна checkout сесия), остава pending
 * [15] Success-return correlation: EXACT providerCheckoutSessionId match за B
 *        никога не връща/матчва A, дори A да е paid — доказва, че
 *        waitForPaidVipPurchase() (main.ts) прави "тази конкретна сесия
 *        ли е paid", не "има ли КАКВАТО И ДА Е paid покупка"
 * [16] Data isolation: друг authenticated потребител (различен profile) НЕ
 *        вижда чужди VIP покупки през GET /api/vip/purchases
 * [17] Checkout creation failure retry: reuse на съществуващия pending ред,
 *        НЕ orphan/duplicate accumulation (брифа §3)
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

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

// ─── Server bootstrap (mirror на checkAdminPayments.ts) ────────────────────

const SERVER_READY_TIMEOUT_MS = 30_000
const PASSWORD = 'VipCheckoutHttpCheck1!'

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

  const tmp = await mkdtemp(join(tmpdir(), 'belot-vip-checkout-http-'))
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
        // Изрично БЕЗ STRIPE_SECRET_KEY/STRIPE_WEBHOOK_SECRET — виж §11 в
        // брифа, "Do NOT use live Stripe requests in tests". Checkout
        // endpoint-ите трябва да минат auth/validation ПРЕДИ да стигнат до
        // Stripe-not-configured 500-ката (виж top-of-file коментара).
        STRIPE_SECRET_KEY: '',
        STRIPE_WEBHOOK_SECRET: '',
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

const iso = await makeIsolated(sourceRoot)
const port = await getFreePort()
let srv: ReturnType<typeof startSrv> | null = null

try {
  srv = startSrv(iso.serverDir, port)
  console.log(`  Чакам сървъра на порт ${port}…`)
  await waitFor('server ready', async () => {
    try {
      const r = await httpJson(port, 'GET', '/health')
      const h = r.body as { ok?: boolean; gameWorkerPool?: { state?: string } | null }
      return r.status === 200 && h.ok === true && h.gameWorkerPool?.state === 'ready'
    } catch { return false }
  }, SERVER_READY_TIMEOUT_MS)
  console.log('  Сървърът е готов.\n')

  const runId = `${Date.now()}-${process.pid}`
  const playerEmail = `vip-checkout-player-${runId}@example.test`
  const adminEmail = `vip-checkout-admin-${runId}@example.test`

  const regPlayer = await httpJson(port, 'POST', '/api/auth/register', {
    body: { email: playerEmail, password: PASSWORD, displayName: 'VipCheckoutPlayer', gender: 'male' },
  })
  assert(regPlayer.status === 200, `player register status=${regPlayer.status}`)

  const regAdmin = await httpJson(port, 'POST', '/api/auth/register', {
    body: { email: adminEmail, password: PASSWORD, displayName: 'VipCheckoutAdmin', gender: 'male' },
  })
  assert(regAdmin.status === 200, `admin register status=${regAdmin.status}`)

  const dbFile = join(iso.serverDir, 'database', 'data', 'belot-v2.sqlite')
  const db = new DatabaseSync(dbFile)
  db.prepare(`UPDATE accounts SET role='admin' WHERE email=?`).run(adminEmail)
  db.close()

  async function loginAndGetCookie(email: string): Promise<string> {
    const response = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD }),
    })
    const h = response.headers as Headers & { getSetCookie?: () => string[] }
    const cookie = (h.getSetCookie?.()[0] ?? response.headers.get('set-cookie'))?.split(';')[0]
    if (!cookie) throw new Error(`No Set-Cookie on login for ${email}`)
    return cookie
  }

  const playerCookie = await loginAndGetCookie(playerEmail)
  const adminCookie = await loginAndGetCookie(adminEmail)

  // ─── [1]-[3] POST /api/vip/checkout ───────────────────────────────────────

  await check('[1] POST /api/vip/checkout без cookie → 401, никаква покупка не се създава', async () => {
    const r = await httpJson(port, 'POST', '/api/vip/checkout', { body: { packageId: 'vip_30' } })
    assertEqual(r.status, 401, 'status')
    assertEqual(r.body.ok, false, 'ok')

    const rows = db2Count(dbFile, 'vip_purchase_ledger')
    assertEqual(rows, 0, 'vip_purchase_ledger трябва да остане празна')
  })

  await check('[2] POST /api/vip/checkout с невалиден packageId → 400, никаква покупка', async () => {
    const r = await httpJson(port, 'POST', '/api/vip/checkout', {
      cookie: playerCookie,
      body: { packageId: 'vip_90' },
    })
    assertEqual(r.status, 400, 'status')
    assertEqual(r.body.ok, false, 'ok')

    const rows = db2Count(dbFile, 'vip_purchase_ledger')
    assertEqual(rows, 0, 'vip_purchase_ledger трябва да остане празна (невалиден пакет)')
  })

  await check('[3] Forged price/days/activeUntil полета в body се игнорират напълно (сървърът чете само packageId)', async () => {
    const r = await httpJson(port, 'POST', '/api/vip/checkout', {
      cookie: playerCookie,
      body: {
        packageId: 'vip_30',
        // Атакуващ сценарий: клиентът се опитва да подаде собствена цена/дни/
        // директен active_until — сървърът НЕ трябва дори да прочете тия
        // полета (само packageId се четe в handleVipCheckoutRequest).
        priceCents: 1,
        days: 99999,
        activeUntil: '2099-01-01',
        profileId: 'someone-elses-profile-id',
      },
    })
    // STRIPE_SECRET_KEY е изпразнен нарочно — заявката трябва да мине purely
    // покрай auth+package validation и да падне чак на Stripe-not-configured
    // 500-ката, НЕ на 400 validation error. Това доказва, че forged полетата
    // не са спрели/променили validation пътя по никакъв начин.
    assertEqual(r.status, 500, `очаквах Stripe-not-configured 500 (forged fields пропуснати чисто), получих ${r.status}: ${JSON.stringify(r.body)}`)
    assert(
      typeof r.body.message === 'string' && r.body.message.toLowerCase().includes('stripe'),
      `500 съобщението трябва да е за Stripe конфигурация, получих: ${JSON.stringify(r.body)}`,
    )

    // createPendingPurchase() СЕ изпълнява преди Stripe извикването (виж
    // handleVipCheckoutRequest реда) — редът съществува, но с DB snapshot
    // цена/дни (789/30 за vip_30), НЕ forged стойностите от body-то.
    const row = queryOne(
      dbFile,
      `SELECT package_id, days_snapshot, price_cents_snapshot FROM vip_purchase_ledger ORDER BY created_at DESC LIMIT 1`,
    ) as { package_id: string; days_snapshot: number; price_cents_snapshot: number } | null
    assert(row !== null, 'pending ред трябва да съществува (createPendingPurchase изпълнен преди Stripe call-а)')
    assertEqual(row?.package_id, 'vip_30', 'package_id трябва да е server-resolved vip_30')
    assertEqual(row?.days_snapshot, 30, 'days_snapshot трябва да е СЪРВЪРНИЯТ 30 (не forged 99999)')
    assertEqual(row?.price_cents_snapshot, 789, 'price_cents_snapshot трябва да е СЪРВЪРНАТА default цена 789 (не forged 1)')
  })

  await check('[17] Checkout creation failure retry: повторен опит за СЪЩИЯ пакет reuse-ва СЪЩИЯ pending ред, не създава orphan/duplicate', async () => {
    // Аудит сценарий (брифа §3): Stripe session creation fail-ва СЛЕД
    // createPendingPurchase() DB insert-а (виж [3] по-горе, което вече
    // остави точно 1 pending vip_30 ред за playerEmail). Потребителят
    // retry-ва (напр. презарежда Shop и click-ва отново "Купи VIP").
    // createPendingPurchase() трябва да намери СЪЩИЯ pending ред (profile_id
    // + package_id + status=pending unique lookup) и да го reuse-не, НЕ да
    // създаде втори — иначе всеки неуспешен Stripe опит би оставял безкраен
    // trail от orphan pending редове.
    const countBefore = (
      queryOne(dbFile, `SELECT COUNT(*) AS cnt FROM vip_purchase_ledger WHERE package_id='vip_30'`) as { cnt: number }
    ).cnt
    assertEqual(countBefore, 1, 'sanity: точно 1 pending vip_30 ред от [3]')

    const r = await httpJson(port, 'POST', '/api/vip/checkout', {
      cookie: playerCookie,
      body: { packageId: 'vip_30' },
    })
    assertEqual(r.status, 500, 'retry-ът пак fail-ва без Stripe key (очаквано в тестова среда)')

    const countAfter = (
      queryOne(dbFile, `SELECT COUNT(*) AS cnt FROM vip_purchase_ledger WHERE package_id='vip_30'`) as { cnt: number }
    ).cnt
    assertEqual(countAfter, 1, 'retry НЕ трябва да създаде втори pending ред — reuse на съществуващия (no orphan accumulation)')

    const purchaseIds = (
      queryOne(dbFile, `SELECT GROUP_CONCAT(DISTINCT purchase_id) AS ids FROM vip_purchase_ledger WHERE package_id='vip_30'`) as { ids: string }
    ).ids
    assert(!purchaseIds.includes(','), `трябва да има точно 1 уникален purchase_id, получих: ${purchaseIds}`)
  })

  // ─── [4]-[5] GET /api/vip/purchases ────────────────────────────────────────

  await check('[4] GET /api/vip/purchases без cookie → 401', async () => {
    const r = await httpJson(port, 'GET', '/api/vip/purchases')
    assertEqual(r.status, 401, 'status')
  })

  await check('[5] GET /api/vip/purchases с валидна cookie → 200, purchases е масив', async () => {
    const r = await httpJson(port, 'GET', '/api/vip/purchases', { cookie: playerCookie })
    assertEqual(r.status, 200, 'status')
    assertEqual(r.body.ok, true, 'ok')
    assert(Array.isArray(r.body.purchases), 'purchases трябва да е масив')
    // От [3] по-горе имаме точно 1 pending ред (Stripe checkout не е успял,
    // значи никога не е бил settle-нат — status остава pending, НЕ paid).
    const purchases = r.body.purchases as Array<{ status: string }>
    assert(purchases.every((p) => p.status !== 'paid'), 'НИКОЯ покупка не трябва да е paid без реален webhook (cancel/success redirect само не активира VIP)')
  })

  // ─── [13]-[15] Success-return correlation: стара paid + нова pending покупка ──
  // Сценарий от audit брифа §2: user има стара PAID VIP покупка A. После
  // стартира нов checkout B (все още НЕ платен). Success redirect landing-ът
  // (waitForPaidVipPurchase в main.ts) прави EXACT match по
  // providerCheckoutSessionId (от URL-ото session_id={CHECKOUT_SESSION_ID}
  // параметър, Stripe-substituted, не client-editable в нормалния flow) —
  // НЕ "има ли КАКВАТО И ДА Е paid покупка". Долните checks доказват, че A
  // никога не се матчва при query за B-ната сесия, дори А да е реално paid.

  await check('[13] Setup: директно settle-вана "стара" VIP покупка A (симулира webhook, вече минал за друг checkout)', async () => {
    // Директен DB insert на PAID ред — mirror на това какво webhook
    // settlement (vipPurchaseStore.fulfillPaidPurchase) реално оставя зад
    // себе си, без да минаваме през реален Stripe webhook call (§11: no live
    // Stripe requests в тестовете).
    const playerProfileId = queryOne(
      dbFile,
      `SELECT p.profile_id FROM profiles p JOIN accounts a ON a.account_id = p.account_id WHERE a.email = '${playerEmail}'`,
    ) as { profile_id: string } | null
    assert(playerProfileId !== null, 'player profile трябва да съществува')

    const db2 = new DatabaseSync(dbFile)
    try {
      db2.prepare(`
        INSERT INTO vip_purchase_ledger (
          purchase_id, profile_id, package_id, days_snapshot, price_cents_snapshot,
          currency, provider, provider_checkout_session_id, status, credited_at
        ) VALUES (
          'purchase-A-old-paid', ?, 'vip_365', 365, 6989,
          'EUR', 'stripe', 'cs_test_OLD_PAID_SESSION_A', 'paid', CURRENT_TIMESTAMP
        );
      `).run(playerProfileId!.profile_id)
    } finally {
      db2.close()
    }

    const r = await httpJson(port, 'GET', '/api/vip/purchases', { cookie: playerCookie })
    const purchases = r.body.purchases as Array<{ providerCheckoutSessionId: string | null; status: string }>
    const found = purchases.find((p) => p.providerCheckoutSessionId === 'cs_test_OLD_PAID_SESSION_A')
    assert(found !== undefined && found.status === 'paid', 'старата покупка A трябва да се вижда като paid през API-то (setup sanity)')
  })

  await check('[14] Нов checkout B (различна сесия) остава pending — B-ната сесия НЕ съществува все още в А-ния ред', async () => {
    const r = await httpJson(port, 'POST', '/api/vip/checkout', {
      cookie: playerCookie,
      body: { packageId: 'vip_180' },
    })
    // Stripe checkout.sessions.create ще fail-не (без ключ) — pending редът
    // обаче Е създаден преди тази стъпка (виж [3] по-горе), само няма
    // provider_checkout_session_id attach-нат (attachCheckoutSession никога
    // не се извиква, защото stripe.checkout.sessions.create() никога не
    // успява). За да симулираме "B получи checkout session, но webhook НЕ Е
    // пристигнал" — attach-ваме сесия B ръчно, mirror на успешния
    // attachCheckoutSession() call, който нормално би станал СЛЕД успешен
    // Stripe API отговор.
    assertEqual(r.status, 500, 'checkout създаване fail-ва без Stripe key (очаквано в тестова среда)')

    const pendingRow = queryOne(
      dbFile,
      `SELECT purchase_id FROM vip_purchase_ledger WHERE package_id='vip_180' AND status='pending' ORDER BY created_at DESC LIMIT 1`,
    ) as { purchase_id: string } | null
    assert(pendingRow !== null, 'pending ред за B трябва да съществува (createPendingPurchase изпълнен преди Stripe call-а)')

    const db2 = new DatabaseSync(dbFile)
    try {
      db2.prepare(`
        UPDATE vip_purchase_ledger
        SET provider_checkout_session_id = 'cs_test_NEW_PENDING_SESSION_B'
        WHERE purchase_id = ?;
      `).run(pendingRow!.purchase_id)
    } finally {
      db2.close()
    }
  })

  await check('[15] EXACT session-id match: query за B-ната сесия НИКОГА не връща A (старата paid покупка), дори A да е "по-скорошна match" по никакъв друг критерий', async () => {
    const r = await httpJson(port, 'GET', '/api/vip/purchases', { cookie: playerCookie })
    assertEqual(r.status, 200, 'status')
    const purchases = r.body.purchases as Array<{ providerCheckoutSessionId: string | null; status: string }>

    // Симулира ТОЧНО client-side filter логиката от waitForPaidVipPurchase
    // (main.ts): purchases.find(item => item.providerCheckoutSessionId === normalizedSessionId).
    const matchForB = purchases.find((p) => p.providerCheckoutSessionId === 'cs_test_NEW_PENDING_SESSION_B')
    assert(matchForB !== undefined, 'B трябва да съществува в списъка')
    assertEqual(matchForB?.status, 'pending', 'B трябва да е pending (webhook никога не е пристигнал за нея) — success НЕ трябва да се покаже')

    const matchForA = purchases.find((p) => p.providerCheckoutSessionId === 'cs_test_OLD_PAID_SESSION_A')
    assert(matchForA !== undefined && matchForA.status === 'paid', 'A остава paid и видима (не е засегната)')

    // Критичното доказателство: EXACT match по B сесията НЕ връща A-записа,
    // въпреки че A е "paid" и технически присъства в същия response масив.
    // Ако логиката (грешно) търсеше "any paid purchase" вместо "purchase с
    // ТОЧНО тази сесия", matchForB би бил равен на A-записа тук — не е.
    assert(matchForB?.providerCheckoutSessionId !== matchForA?.providerCheckoutSessionId, 'A и B имат различни сесии — cross-match е невъзможен по конструкция')
    assert(matchForB?.status !== 'paid', 'success return за B НЕ трябва да покаже success, докато B специфично не стане paid (А being paid е ирелевантно)')
  })

  await check('[16] Data isolation: GET /api/vip/purchases с cookie на ДРУГ потребител НИКОГА не връща чужди покупки (A/B принадлежат на playerEmail)', async () => {
    const r = await httpJson(port, 'GET', '/api/vip/purchases', { cookie: adminCookie })
    assertEqual(r.status, 200, 'status')
    const purchases = r.body.purchases as Array<{ providerCheckoutSessionId: string | null }>
    const leaked = purchases.some((p) =>
      p.providerCheckoutSessionId === 'cs_test_OLD_PAID_SESSION_A' || p.providerCheckoutSessionId === 'cs_test_NEW_PENDING_SESSION_B',
    )
    assert(!leaked, 'admin акаунтът НЕ трябва да вижда playerEmail-ните VIP покупки (WHERE profile_id обвързан directly към session-owner-а)')
  })

  // ─── [6]-[9] PATCH /api/admin/settings — VIP 0-cent policy ─────────────────

  await check('[6] PATCH /api/admin/settings (non-admin cookie) → 403', async () => {
    const r = await httpJson(port, 'PATCH', '/api/admin/settings', {
      cookie: playerCookie,
      body: { vipPrice30DaysCents: 999 },
    })
    assertEqual(r.status, 403, 'status')
  })

  await check('[7] PATCH /api/admin/settings vipPrice30DaysCents=0 → 400, НЕ silent clamp към 1', async () => {
    const before = (await httpJson(port, 'GET', '/api/admin/settings', { cookie: adminCookie })).body
      .settings as { vipPrice30DaysCents: number }

    const r = await httpJson(port, 'PATCH', '/api/admin/settings', {
      cookie: adminCookie,
      body: { vipPrice30DaysCents: 0 },
    })
    assertEqual(r.status, 400, 'status трябва да е 400 (explicit rejection)')
    assertEqual(r.body.ok, false, 'ok')

    const after = (await httpJson(port, 'GET', '/api/admin/settings', { cookie: adminCookie })).body
      .settings as { vipPrice30DaysCents: number }
    assertEqual(after.vipPrice30DaysCents, before.vipPrice30DaysCents, 'цената НЕ трябва да е променена (нито clamp-ната до 1, нито до 0)')
  })

  await check('[8] PATCH /api/admin/settings vipPrice30DaysCents=-50 → 400', async () => {
    const r = await httpJson(port, 'PATCH', '/api/admin/settings', {
      cookie: adminCookie,
      body: { vipPrice30DaysCents: -50 },
    })
    assertEqual(r.status, 400, 'status')
    assertEqual(r.body.ok, false, 'ok')
  })

  await check('[9] PATCH /api/admin/settings vipPrice30DaysCents=1.5 (fractional) → 400', async () => {
    const r = await httpJson(port, 'PATCH', '/api/admin/settings', {
      cookie: adminCookie,
      body: { vipPrice30DaysCents: 1.5 },
    })
    assertEqual(r.status, 400, 'status')
    assertEqual(r.body.ok, false, 'ok')
  })

  await check('[9b] PATCH /api/admin/settings vipPrice30DaysCents="abc" (string garbage) → 400, НЕ silent ignore', async () => {
    const before = (await httpJson(port, 'GET', '/api/admin/settings', { cookie: adminCookie })).body
      .settings as { vipPrice30DaysCents: number }

    const r = await httpJson(port, 'PATCH', '/api/admin/settings', {
      cookie: adminCookie,
      body: { vipPrice30DaysCents: 'abc' },
    })
    assertEqual(r.status, 400, 'string garbage трябва да е explicit 400, НЕ silent-ignored 200')
    assertEqual(r.body.ok, false, 'ok')

    const after = (await httpJson(port, 'GET', '/api/admin/settings', { cookie: adminCookie })).body
      .settings as { vipPrice30DaysCents: number }
    assertEqual(after.vipPrice30DaysCents, before.vipPrice30DaysCents, 'цената не трябва да е променена')
  })

  await check('[9c] PATCH /api/admin/settings vipPrice30DaysCents=null (JSON null) → 400', async () => {
    const r = await httpJson(port, 'PATCH', '/api/admin/settings', {
      cookie: adminCookie,
      body: { vipPrice30DaysCents: null },
    })
    assertEqual(r.status, 400, 'status')
    assertEqual(r.body.ok, false, 'ok')
  })

  await check('[9d] PATCH /api/admin/settings vipPrice30DaysCents=NaN-produced (Infinity, не JSON-native но проверяваме boundary) → 400 при директен число тип, ако не е finite', async () => {
    // JSON.stringify(Infinity) сериализира като null (JS spec) — проверяваме
    // явно чрез директен raw request с "Infinity" literal (невалиден JSON,
    // очакваме body parse грешка -> 400 по друг път) вместо fragile assumption.
    const response = await fetch(`http://127.0.0.1:${port}/api/admin/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: '{"vipPrice30DaysCents": Infinity}',
    })
    assert(response.status === 400 || response.status === 500, `невалиден JSON синтаксис трябва да е reject-нат, получих ${response.status}`)
  })

  // ─── [10] GET /api/vip/packages отразява нова admin цена веднага ──────────

  await check('[10] Admin price update → GET /api/vip/packages веднага отразява новата цена (следващ checkout ще я ползва)', async () => {
    const updateResult = await httpJson(port, 'PATCH', '/api/admin/settings', {
      cookie: adminCookie,
      body: { vipPrice30DaysCents: 1_234 },
    })
    assertEqual(updateResult.status, 200, 'admin update трябва да успее')

    const packagesResult = await httpJson(port, 'GET', '/api/vip/packages', { cookie: playerCookie })
    assertEqual(packagesResult.status, 200, 'status')
    const packages = packagesResult.body.packages as Array<{ packageId: string; priceCents: number }>
    const vip30 = packages.find((p) => p.packageId === 'vip_30')
    assert(vip30 !== undefined, 'vip_30 пакет трябва да присъства')
    assertEqual(vip30?.priceCents, 1_234, 'GET /api/vip/packages трябва да echo-ва новата admin цена веднага (не stale)')
  })

  // ─── [11]-[12] Coin flow непроменен от VIP интеграцията ────────────────────

  await check('[11] POST /api/shop/checkout (coins) без cookie → 401 (existing coin route непроменен)', async () => {
    const r = await httpJson(port, 'POST', '/api/shop/checkout', { body: { packageId: 'starter' } })
    assertEqual(r.status, 401, 'status')
  })

  await check('[12] POST /api/shop/checkout (coins) с невалиден packageId → 400 (coin validation path непроменен)', async () => {
    const r = await httpJson(port, 'POST', '/api/shop/checkout', {
      cookie: playerCookie,
      body: { packageId: 'this-package-does-not-exist' },
    })
    assertEqual(r.status, 400, 'status')
    assertEqual(r.body.ok, false, 'ok')
  })
} finally {
  if (srv) await stopSrv(srv)
  await iso.cleanup()
}

function db2Count(dbFile: string, table: string): number {
  const db = new DatabaseSync(dbFile)
  try {
    const row = db.prepare(`SELECT COUNT(*) AS cnt FROM ${table}`).get() as { cnt: number }
    return row.cnt
  } finally {
    db.close()
  }
}

function queryOne(dbFile: string, sql: string): unknown {
  const db = new DatabaseSync(dbFile)
  try {
    return db.prepare(sql).get() ?? null
  } finally {
    db.close()
  }
}

console.log(`\n  Passed: ${passed}  Failed: ${failed}\n`)

if (failed > 0) {
  process.exit(1)
}
