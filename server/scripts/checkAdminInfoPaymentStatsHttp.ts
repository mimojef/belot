/**
 * checkAdminInfoPaymentStatsHttp.ts
 *
 * Регресия: Админ → Информация → "Плащания" (GET /api/admin/stats) не
 * включваше платените поръчки за персонализация, докато Админ → Плащания
 * (GET /api/admin/payments) вече ги показваше. Първата реална покупка
 * (3 екстри, едно плащане 5,97 €) се виждаше в "Плащания → Днес", а
 * картата "Днес" оставаше 0 плащания / 0,00 €.
 *
 * Реален изолиран сървър (временна база, всички миграции), подписани Stripe
 * webhook събития (без мрежа към Stripe):
 *
 *  P1  жълтици; P2 VIP; P3 една персонализация; P4 обща поръчка с 3
 *      персонализации = 1 плащане / обща сума; P5 безплатно admin
 *      предоставяне -> без промяна; P6 неплатена/изтекла поръчка -> без
 *      промяна; P7 пълно възстановяване -> нетно 0; P8 частично
 *      възстановяване -> нетно (обща − върнато); P9 граници на деня по
 *      Europe/Sofia; P10 картите == /admin/payments за всички 5 периода.
 *  S   store ниво с фиксирано "сега": полунощ и смяна на часовото време
 *      (EEST->EET, EET->EEST), картите == списъка на /admin/payments.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/checkAdminInfoPaymentStatsHttp.ts --server-root=.
 */

import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Stripe from 'stripe'
import { TEST_REGISTRATION_SECRET, configureDirectRegistrationForTest, prepareDirectRegistration } from './fixtures/directRegistrationTestEnv.js'
import { ADMIN_PAYMENT_PERIODS, getSofiaDayBoundsUtc, type AdminPaymentPeriod } from '../src/db/sofiaDayBounds.js'
import { createProfileCustomizationStore } from '../src/profileCustomization/profileCustomizationStore.js'

const PASSWORD = 'AdminInfoPaymentStats1!'
const WEBHOOK_SECRET = 'whsec_admin_info_payment_stats_test_000000'

let passed = 0
let failed = 0
async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`  PASS  ${label}`)
  } catch (error) {
    failed++
    console.error(`  FAIL  ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))

function getFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') { reject(new Error('no port')); return }
      const port = address.port
      server.close(() => resolvePort(port))
    })
  })
}

async function retryRm(path: string): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt++) {
    try { await rm(path, { recursive: true, force: true }); return } catch { await sleep(300) }
  }
}

const originalServerRoot = resolve(
  process.argv.slice(2).find((arg) => arg.startsWith('--server-root='))?.slice('--server-root='.length) ?? process.cwd(),
)

async function createIsolatedServerRoot() {
  const root = await mkdtemp(join(tmpdir(), 'belot-admin-info-payment-stats-'))
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
  return { serverDir, databaseFile: join(serverDir, 'database', 'data', 'belot-v2.sqlite'), cleanup: () => retryRm(root) }
}

type RunningServer = { child: ChildProcessWithoutNullStreams; output(): string }

function startServer(serverDir: string, port: number): RunningServer {
  const chunks: string[] = []
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    PASSWORD_RESET_RATE_LIMIT_SECRET: TEST_REGISTRATION_SECRET,
    // Фиктивен ключ: webhook-ът проверява подписа локално, без заявки към Stripe.
    STRIPE_SECRET_KEY: 'sk_test_dummy_no_network',
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  }
  delete env.PROFILE_CUSTOMIZATION_ENABLED
  const child = spawn(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'index.ts')], { cwd: serverDir, env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => chunks.push(chunk))
  child.stderr.on('data', (chunk: string) => chunks.push(chunk))
  return { child, output: () => chunks.join('') }
}

async function stopServer(server: RunningServer): Promise<void> {
  if (server.child.exitCode !== null) return
  server.child.kill('SIGTERM')
  await new Promise<void>((done) => {
    const timer = setTimeout(() => { server.child.kill('SIGKILL'); done() }, 10_000)
    server.child.once('exit', () => { clearTimeout(timer); done() })
  })
}

async function waitForServer(port: number, server: RunningServer): Promise<void> {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/rooms`)).status === 200) return
    } catch { /* not yet */ }
    if (server.child.exitCode !== null) break
    await sleep(150)
  }
  console.error(server.output())
  throw new Error('server did not start')
}

let ipCounter = 0
const nextIp = () => `203.0.119.${(ipCounter += 1) % 250}`
type JsonResult = { status: number; body: any; text: string; setCookie: string[] }

async function request(port: number, method: string, pathname: string, body?: unknown, cookie?: string): Promise<JsonResult> {
  const headers: Record<string, string> = { 'X-Forwarded-For': nextIp() }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (cookie) headers['Cookie'] = cookie
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  let parsed: any = null
  try { parsed = JSON.parse(text) } catch { /* not json */ }
  const headersExt = res.headers as Headers & { getSetCookie?: () => string[] }
  return { status: res.status, body: parsed, text, setCookie: headersExt.getSetCookie?.() ?? [] }
}

function withDb<T>(databaseFile: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(databaseFile)
  try {
    db.exec('PRAGMA busy_timeout = 5000;')
    return fn(db)
  } finally {
    db.close()
  }
}

async function registerUser(port: number, databaseFile: string, label: string, role: string): Promise<{ cookie: string; profileId: string }> {
  const email = `aips-${label}-${randomUUID().slice(0, 8)}@example.test`
  const result = await request(port, 'POST', '/api/auth/register', {
    email, password: PASSWORD, displayName: `Aips${label}${randomUUID().slice(0, 5)}`, gender: 'male', ...prepareDirectRegistration(),
  })
  assert(result.status === 200, `register ${label}: ${result.status} ${result.text}`)
  withDb(databaseFile, (db) => db.prepare('UPDATE accounts SET role = ? WHERE email = ?').run(role, email))
  const loginResult = await request(port, 'POST', '/api/auth/login', { email, password: PASSWORD, rememberMe: true })
  const cookie = loginResult.setCookie.find((c) => c.startsWith('belot_session='))?.split(';')[0] ?? ''
  assert(cookie !== '', `login ${label}: ${loginResult.status}`)
  const profileId = withDb(databaseFile, (db) => (db.prepare(`SELECT p.profile_id AS id FROM profiles p JOIN accounts a ON a.account_id = p.account_id WHERE a.email = ?;`).get(email) as { id: string }).id)
  return { cookie, profileId }
}

const stripeSigner = new Stripe('sk_test_dummy_no_network')

async function postEvent(port: number, type: string, object: Record<string, unknown>): Promise<number> {
  const payload = JSON.stringify({ id: `evt_${randomUUID()}`, object: 'event', type, data: { object } })
  const header = stripeSigner.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET })
  const response = await fetch(`http://127.0.0.1:${port}/api/stripe/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': header },
    body: payload,
  })
  await response.text()
  return response.status
}

type Line = { kind: string; itemId: string; value: string; days: number }

/**
 * Неплатена поръчка със закачена сесия — състоянието след checkout route-а
 * (цена 199 за 30 дни). payment-method полетата са попълнени -> няма
 * enrichment заявка към Stripe.
 */
function insertPendingOrder(databaseFile: string, profileId: string, sessionId: string, lines: Line[]): { orderId: string; totalCents: number } {
  const orderId = randomUUID()
  const totalCents = lines.reduce((sum, line) => sum + 199 * (line.days / 30), 0)
  withDb(databaseFile, (db) => {
    const nowIso = new Date().toISOString()
    db.prepare(`UPDATE profile_customization_orders SET hidden_at = ? WHERE profile_id = ? AND status = 'pending' AND hidden_at IS NULL;`).run(nowIso, profileId)
    db.prepare(`UPDATE profile_customization_purchases SET hidden_at = ? WHERE profile_id = ? AND status = 'pending' AND hidden_at IS NULL;`).run(nowIso, profileId)
    db.prepare(`
      INSERT INTO profile_customization_orders (order_id, profile_id, item_count, total_cents, provider_checkout_session_id, stripe_charge_id, payment_method_type)
      VALUES (?, ?, ?, ?, ?, 'ch_test', 'card');
    `).run(orderId, profileId, lines.length, totalCents, sessionId)
    for (const line of lines) {
      db.prepare(`
        INSERT INTO profile_customization_purchases (
          purchase_id, order_id, profile_id, kind, item_id, item_value_snapshot, days_snapshot,
          base_price_30_days_cents_snapshot, price_cents_snapshot
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 199, ?);
      `).run(randomUUID(), orderId, profileId, line.kind, line.itemId, line.value, line.days, 199 * (line.days / 30))
    }
  })
  return { orderId, totalCents }
}

/** Платена поръчка с точно paid_at (за границите на деня); без права — за отчета е важна само поръчката. */
function insertPaidOrderAt(databaseFile: string, profileId: string, paidAtIso: string, totalCents: number, refundedCents = 0): string {
  const orderId = randomUUID()
  withDb(databaseFile, (db) => {
    db.prepare(`
      INSERT INTO profile_customization_orders (order_id, profile_id, item_count, total_cents, provider_checkout_session_id, status, paid_at, refunded_amount_cents, refunded_at, payment_method_type)
      VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, 'card');
    `).run(orderId, profileId, totalCents, `cs_at_${randomUUID()}`, refundedCents >= totalCents ? 'refunded' : 'paid', paidAtIso, refundedCents, refundedCents > 0 ? paidAtIso : null)
  })
  return orderId
}

function completedSession(sessionId: string, orderId: string, amount: number, paymentIntentId: string): Record<string, unknown> {
  return {
    id: sessionId,
    object: 'checkout.session',
    payment_status: 'paid',
    status: 'complete',
    currency: 'eur',
    amount_total: amount,
    payment_intent: paymentIntentId,
    metadata: { purchaseType: 'profile_customization', orderId, purchaseId: orderId },
  }
}

/** "YYYY-MM-DD HH:MM:SS" (UTC) -> Date. */
const fromSqliteUtc = (value: string) => new Date(`${value.replace(' ', 'T')}Z`)
const toSqliteUtc = (date: Date) => date.toISOString().replace('T', ' ').slice(0, 19)

type PeriodStats = { count: number; totalCents: number }

console.log('\ncheckAdminInfoPaymentStatsHttp')
console.log(`Server root: ${originalServerRoot}`)

const iso = await createIsolatedServerRoot()
let server: RunningServer | null = null

try {
  const port = await getFreePort()
  server = startServer(iso.serverDir, port)
  await waitForServer(port, server)
  configureDirectRegistrationForTest(iso.databaseFile)

  const admin = await registerUser(port, iso.databaseFile, 'admin', 'admin')
  const buyer = await registerUser(port, iso.databaseFile, 'buyer', 'player')
  const subadmin = await registerUser(port, iso.databaseFile, 'subadmin', 'subadmin')

  const stats = async (cookie = admin.cookie): Promise<Record<AdminPaymentPeriod, PeriodStats>> => {
    const result = await request(port, 'GET', '/api/admin/stats', undefined, cookie)
    assert(result.status === 200 && result.body?.ok === true, `stats ${result.status} ${result.text.slice(0, 200)}`)
    return result.body.stats.payments
  }
  const paymentsList = async (period: AdminPaymentPeriod) => {
    const result = await request(port, 'GET', `/api/admin/payments?period=${period}&limit=100`, undefined, admin.cookie)
    assert(result.status === 200 && result.body?.ok === true, `payments ${period} ${result.status} ${result.text.slice(0, 200)}`)
    const totalCents = Object.values(result.body.summary.totalsByCurrency as Record<string, number>).reduce((sum, value) => sum + value, 0)
    return { count: result.body.pagination.total as number, totalCents, rows: result.body.purchases as Array<Record<string, any>> }
  }
  const expectToday = async (expected: PeriodStats, label: string) => {
    const today = (await stats()).today
    assert(today.count === expected.count && today.totalCents === expected.totalCents, `${label}: карта "Днес" ${JSON.stringify(today)}, очаквано ${JSON.stringify(expected)}`)
    const list = await paymentsList('today')
    assert(list.count === expected.count && list.totalCents === expected.totalCents, `${label}: /admin/payments днес ${list.count}/${list.totalCents}`)
  }
  const nowSqlite = () => toSqliteUtc(new Date())

  const expected: PeriodStats = { count: 0, totalCents: 0 }

  console.log('\n[P] Обобщените карти в Админ → Информация')

  await check('[P0] Празна база: всички карти 0 / 0,00 €; subadmin вижда същите карти (read-only)', async () => {
    const all = await stats()
    for (const period of ADMIN_PAYMENT_PERIODS) assert(all[period].count === 0 && all[period].totalCents === 0, `${period} ${JSON.stringify(all[period])}`)
    const asSubadmin = await stats(subadmin.cookie)
    assert(JSON.stringify(asSubadmin) === JSON.stringify(all), 'subadmin')
    const forbidden = await request(port, 'GET', '/api/admin/stats', undefined, buyer.cookie)
    assert(forbidden.status === 403, `играч ${forbidden.status}`)
  })

  await check('[P1] Жълтици: платена покупка 4,99 € -> +1 / +499; неплатена/отменена не се броят (отчетността за жълтици е непроменена)', async () => {
    withDb(iso.databaseFile, (db) => {
      const insert = db.prepare(`
        INSERT INTO coin_purchase_ledger (purchase_id, profile_id, package_key_snapshot, title_snapshot, yellow_coins_amount, price_cents, currency, provider_checkout_session_id, status, credited_at)
        VALUES (?, ?, 'coins_test', 'Тестов пакет', 1000, ?, 'EUR', ?, ?, ?);
      `)
      insert.run(randomUUID(), buyer.profileId, 499, `cs_coin_${randomUUID()}`, 'paid', nowSqlite())
      insert.run(randomUUID(), buyer.profileId, 999, `cs_coin_${randomUUID()}`, 'pending', null)
      insert.run(randomUUID(), buyer.profileId, 999, `cs_coin_${randomUUID()}`, 'canceled', null)
    })
    expected.count += 1
    expected.totalCents += 499
    await expectToday(expected, 'жълтици')
  })

  await check('[P2] VIP: платена покупка 3,00 € -> +1 / +300; неплатена не се брои (отчетността за VIP е непроменена)', async () => {
    withDb(iso.databaseFile, (db) => {
      const insert = db.prepare(`
        INSERT INTO vip_purchase_ledger (purchase_id, profile_id, package_id, days_snapshot, price_cents_snapshot, currency, provider_checkout_session_id, status, credited_at)
        VALUES (?, ?, 'vip_30', 30, ?, 'EUR', ?, ?, ?);
      `)
      insert.run(randomUUID(), buyer.profileId, 300, `cs_vip_${randomUUID()}`, 'paid', nowSqlite())
      insert.run(randomUUID(), buyer.profileId, 300, `cs_vip_${randomUUID()}`, 'pending', null)
    })
    expected.count += 1
    expected.totalCents += 300
    await expectToday(expected, 'VIP')
  })

  await check('[P3] Една персонализация (webhook completed) -> +1 / +199; повторен webhook не я брои втори път', async () => {
    const sessionId = `cs_pc_one_${randomUUID()}`
    const paymentIntentId = `pi_pc_one_${randomUUID()}`
    const order = insertPendingOrder(iso.databaseFile, buyer.profileId, sessionId, [{ kind: 'nickname_color', itemId: 'red-1', value: '#E81729', days: 30 }])
    for (let i = 0; i < 2; i++) assert(await postEvent(port, 'checkout.session.completed', completedSession(sessionId, order.orderId, order.totalCents, paymentIntentId)) === 200, 'webhook')
    expected.count += 1
    expected.totalCents += 199
    await expectToday(expected, 'една персонализация')
  })

  let threeOrderId = ''
  await check('[P4] Обща поръчка с 3 персонализации (5,97 €) -> +1 плащане / +597 (НЕ 3 плащания); в /admin/payments е един ред', async () => {
    const sessionId = `cs_pc_three_${randomUUID()}`
    const paymentIntentId = `pi_pc_three_${randomUUID()}`
    const order = insertPendingOrder(iso.databaseFile, admin.profileId, sessionId, [
      { kind: 'nickname_color', itemId: 'blue-1', value: '#2B74D9', days: 30 },
      { kind: 'emoji_before', itemId: 'emoji-0001', value: '😀', days: 30 },
      { kind: 'emoji_after', itemId: 'emoji-0002', value: '😃', days: 30 },
    ])
    threeOrderId = order.orderId
    assert(order.totalCents === 597, `обща сума ${order.totalCents}`)
    assert(await postEvent(port, 'checkout.session.completed', completedSession(sessionId, order.orderId, 597, paymentIntentId)) === 200, 'webhook')
    expected.count += 1
    expected.totalCents += 597
    await expectToday(expected, 'обща поръчка')
    const rows = (await paymentsList('today')).rows.filter((row) => row.source === 'profile_customization' && row.purchaseId === threeOrderId)
    assert(rows.length === 1 && rows[0]!.priceCents === 597 && rows[0]!.packageTitle === 'Персонализация', JSON.stringify(rows))
  })

  await check('[P5] Безплатно admin предоставяне (2 екстри) -> правата са дадени, картите и /admin/payments са без промяна', async () => {
    const granted = await request(port, 'POST', '/api/admin/profile-customization/grants', {
      targetProfileId: buyer.profileId,
      confirm: true,
      items: [{ kind: 'message_color', itemId: 'gold-1', days: 90 }, { kind: 'emoji_after', itemId: 'emoji-0003', days: 180 }],
    }, admin.cookie)
    assert(granted.status === 200 && granted.body.grants.length === 2, `${granted.status} ${granted.text.slice(0, 200)}`)
    const ordersFromGrants = withDb(iso.databaseFile, (db) => (db.prepare(`SELECT COUNT(*) AS c FROM profile_customization_orders WHERE profile_id = ? AND status <> 'pending';`).get(buyer.profileId) as { c: number }).c)
    assert(ordersFromGrants === 1, `поръчки на получателя ${ordersFromGrants} (само платената от P3)`)
    await expectToday(expected, 'предоставяне')
  })

  await check('[P6] Неплатена поръчка (pending) и изтекла сесия (canceled) не се броят', async () => {
    insertPendingOrder(iso.databaseFile, subadmin.profileId, `cs_pc_pending_${randomUUID()}`, [{ kind: 'nickname_color', itemId: 'green-1', value: '#14891E', days: 30 }])
    const expiredSession = `cs_pc_expired_${randomUUID()}`
    const expired = insertPendingOrder(iso.databaseFile, buyer.profileId, expiredSession, [{ kind: 'message_color', itemId: 'purple-1', value: '#9B4BEA', days: 60 }])
    assert(await postEvent(port, 'checkout.session.expired', { id: expiredSession, object: 'checkout.session', status: 'expired', payment_status: 'unpaid', metadata: { purchaseType: 'profile_customization', orderId: expired.orderId, purchaseId: expired.orderId } }) === 200, 'expired')
    const status = withDb(iso.databaseFile, (db) => (db.prepare('SELECT status FROM profile_customization_orders WHERE order_id = ?;').get(expired.orderId) as { status: string }).status)
    assert(status === 'canceled', `статус ${status}`)
    await expectToday(expected, 'неплатени')
  })

  await check('[P7] Пълно възстановяване: поръчката остава 1 ред (статус refunded) в /admin/payments, нетният приход е 0 — картите го следват', async () => {
    const sessionId = `cs_pc_full_${randomUUID()}`
    const paymentIntentId = `pi_pc_full_${randomUUID()}`
    const order = insertPendingOrder(iso.databaseFile, subadmin.profileId, sessionId, [{ kind: 'emoji_before', itemId: 'emoji-0004', value: '😄', days: 60 }])
    assert(await postEvent(port, 'checkout.session.completed', completedSession(sessionId, order.orderId, 398, paymentIntentId)) === 200, 'completed')
    await expectToday({ count: expected.count + 1, totalCents: expected.totalCents + 398 }, 'преди възстановяване')
    assert(await postEvent(port, 'charge.refunded', { id: 'ch_full', object: 'charge', payment_intent: paymentIntentId, amount: 398, amount_refunded: 398, refunded: true }) === 200, 'refund')
    expected.count += 1
    await expectToday(expected, 'пълно възстановяване')
    const row = (await paymentsList('today')).rows.find((r) => r.purchaseId === order.orderId)
    assert(row?.status === 'refunded', `ред ${JSON.stringify(row)}`)
  })

  await check('[P8] Частично възстановяване 2,00 € от 5,97 € -> нетно +397', async () => {
    const sessionId = `cs_pc_partial_${randomUUID()}`
    const paymentIntentId = `pi_pc_partial_${randomUUID()}`
    const order = insertPendingOrder(iso.databaseFile, buyer.profileId, sessionId, [
      { kind: 'nickname_color', itemId: 'purple-1', value: '#9B4BEA', days: 30 },
      { kind: 'emoji_before', itemId: 'emoji-0005', value: '😆', days: 30 },
      { kind: 'message_color', itemId: 'blue-1', value: '#2B74D9', days: 30 },
    ])
    assert(await postEvent(port, 'checkout.session.completed', completedSession(sessionId, order.orderId, 597, paymentIntentId)) === 200, 'completed')
    assert(await postEvent(port, 'charge.refunded', { id: 'ch_partial', object: 'charge', payment_intent: paymentIntentId, amount: 597, amount_refunded: 200, refunded: false }) === 200, 'refund')
    expected.count += 1
    expected.totalCents += 397
    await expectToday(expected, 'частично възстановяване')
    const row = (await paymentsList('today')).rows.find((r) => r.purchaseId === order.orderId)
    assert(row?.status === 'partially_refunded' && row.priceCents === 597, `ред ${JSON.stringify(row)}`)
  })

  await check('[P9] Граници на деня по Europe/Sofia: 23:59:59.999 (вчера) / 00:00:00 (днес) — персонализация и жълтици', async () => {
    const bounds = getSofiaDayBoundsUtc(new Date())
    const todayStart = fromSqliteUtc(bounds.todayStart)
    const lastMsYesterday = new Date(todayStart.getTime() - 1)
    insertPaidOrderAt(iso.databaseFile, buyer.profileId, lastMsYesterday.toISOString(), 199)
    insertPaidOrderAt(iso.databaseFile, buyer.profileId, todayStart.toISOString(), 398)
    // Стара поръчка — само в "Общо".
    insertPaidOrderAt(iso.databaseFile, buyer.profileId, '2025-01-15T10:00:00.000Z', 995)
    withDb(iso.databaseFile, (db) => {
      db.prepare(`
        INSERT INTO coin_purchase_ledger (purchase_id, profile_id, package_key_snapshot, title_snapshot, yellow_coins_amount, price_cents, currency, provider_checkout_session_id, status, credited_at)
        VALUES (?, ?, 'coins_test', 'Тестов пакет', 1000, 250, 'EUR', ?, 'paid', ?);
      `).run(randomUUID(), buyer.profileId, `cs_coin_${randomUUID()}`, toSqliteUtc(new Date(todayStart.getTime() - 1000)))
    })
    expected.count += 1
    expected.totalCents += 398
    await expectToday(expected, 'граница днес')
    const all = await stats()
    assert(all.yesterday.count === 2 && all.yesterday.totalCents === 199 + 250, `вчера ${JSON.stringify(all.yesterday)}`)
    assert(all.allTime.count === expected.count + 3 && all.allTime.totalCents === expected.totalCents + 199 + 250 + 995, `общо ${JSON.stringify(all.allTime)}`)
  })

  await check('[P10] Картите съвпадат с /admin/payments (брой и нетна сума) за всички 5 периода', async () => {
    const all = await stats()
    for (const period of ADMIN_PAYMENT_PERIODS) {
      const list = await paymentsList(period)
      assert(all[period].count === list.count && all[period].totalCents === list.totalCents, `${period}: карта ${JSON.stringify(all[period])} != списък ${list.count}/${list.totalCents}`)
    }
    // Последните 7 дни ⊇ днес+вчера, общо ⊇ всичко.
    assert(all.last7days.count >= all.today.count + all.yesterday.count && all.allTime.count >= all.last7days.count, JSON.stringify(all))
  })

  // Store проверките вървят върху СЪЩАТА изолирана база, докато сървърът
  // още работи (WAL позволява втора връзка; след твърдо спиране на Windows
  // остатъчните -wal/-shm може да дадат "disk I/O error").
  console.log('\n[S] Store ниво с фиксирано "сега" (полунощ и смяна на часовото време)')

  const store = await createProfileCustomizationStore(iso.databaseFile)
  try {
    const sumList = (period: AdminPaymentPeriod, now: Date) => {
      const rows = store.getAdminPaymentListByPeriod({ period, now })
      return { count: rows.length, totalCents: rows.reduce((sum, row) => sum + row.netCents, 0) }
    }

    await check('[S1] EEST -> EET (25.10.2026): 23:59:59.999 на 24-ти е вчера, 00:00 на 25-ти е днес, 00:00 на 26-ти е утре (извън днес)', () => {
      insertPaidOrderAt(iso.databaseFile, buyer.profileId, '2026-10-24T20:59:59.999Z', 101) // 24.10 23:59:59.999 EEST
      insertPaidOrderAt(iso.databaseFile, buyer.profileId, '2026-10-24T21:00:00.000Z', 102) // 25.10 00:00 EEST
      insertPaidOrderAt(iso.databaseFile, buyer.profileId, '2026-10-25T21:59:59.000Z', 103) // 25.10 23:59:59 EET
      insertPaidOrderAt(iso.databaseFile, buyer.profileId, '2026-10-25T22:00:00.000Z', 104) // 26.10 00:00 EET
      const now = new Date('2026-10-25T21:30:00.000Z') // 25.10 23:30 EET
      const result = store.getAdminPaymentStats(now)
      assert(result.today.count === 2 && result.today.totalCents === 102 + 103, `днес ${JSON.stringify(result.today)}`)
      assert(result.yesterday.count === 1 && result.yesterday.totalCents === 101, `вчера ${JSON.stringify(result.yesterday)}`)
    })

    await check('[S2] EET -> EEST (28.03.2027): 23:59:59 на 27-ми е вчера, 00:00 на 28-ми е днес; частично и изцяло възстановени -> нетно', () => {
      insertPaidOrderAt(iso.databaseFile, buyer.profileId, '2027-03-27T21:59:59.000Z', 201) // 27.03 23:59:59 EET
      insertPaidOrderAt(iso.databaseFile, buyer.profileId, '2027-03-27T22:00:00.000Z', 597, 200) // 28.03 00:00 EET, частично
      insertPaidOrderAt(iso.databaseFile, buyer.profileId, '2027-03-28T20:59:59.000Z', 398, 398) // 28.03 23:59:59 EEST, изцяло
      insertPaidOrderAt(iso.databaseFile, buyer.profileId, '2027-03-28T21:00:00.000Z', 204) // 29.03 00:00 EEST
      const now = new Date('2027-03-28T12:00:00.000Z')
      const result = store.getAdminPaymentStats(now)
      assert(result.today.count === 2 && result.today.totalCents === 397, `днес ${JSON.stringify(result.today)}`)
      assert(result.yesterday.count === 1 && result.yesterday.totalCents === 201, `вчера ${JSON.stringify(result.yesterday)}`)
    })

    await check('[S3] Store картите == store списъка на /admin/payments за всички периоди при няколко "сега"', () => {
      for (const now of [new Date(), new Date('2026-10-25T21:30:00.000Z'), new Date('2027-03-28T12:00:00.000Z'), new Date('2026-11-01T00:30:00.000Z')]) {
        const result = store.getAdminPaymentStats(now)
        for (const period of ADMIN_PAYMENT_PERIODS) {
          const list = sumList(period, now)
          assert(result[period].count === list.count && result[period].totalCents === list.totalCents, `${now.toISOString()} ${period}: ${JSON.stringify(result[period])} != ${JSON.stringify(list)}`)
        }
      }
    })

    await check('[S4] Безплатните предоставяния не влизат в нито един период', () => {
      const grants = withDb(iso.databaseFile, (db) => (db.prepare('SELECT COUNT(*) AS c FROM profile_customization_grants;').get() as { c: number }).c)
      assert(grants === 2, `предоставяния ${grants}`)
      const paidOrders = withDb(iso.databaseFile, (db) => (db.prepare(`SELECT COUNT(*) AS c FROM profile_customization_orders WHERE paid_at IS NOT NULL AND status IN ('paid', 'refunded');`).get() as { c: number }).c)
      assert(store.getAdminPaymentStats().allTime.count === paidOrders, `общо ${store.getAdminPaymentStats().allTime.count} != платени поръчки ${paidOrders}`)
    })
  } finally {
    store.close()
  }
} finally {
  if (server !== null) await stopServer(server)
  await iso.cleanup()
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
