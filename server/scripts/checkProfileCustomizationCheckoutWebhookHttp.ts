/**
 * checkProfileCustomizationCheckoutWebhookHttp.ts
 *
 * "Персонализация на профила", Етап 2 — реален изолиран сървър:
 * потребителският API /api/profile-customization и Stripe webhook-ът с
 * ПОДПИСАНИ събития (stripe.webhooks.generateTestHeaderString). Без мрежови
 * заявки към Stripe: поръчките се вкарват директно като pending редове със
 * закачена сесия (каквото прави checkout route-ът след Stripe), а
 * payment-method полетата са попълнени, за да няма enrichment заявка.
 *
 *  U. Флаг ВКЛЮЧЕН: гост 401; session флаг; каталог/цени/активни; checkout
 *     валидации (изключена продажба, вид, срок) и задължително потвърждение
 *     при замяна (409) — преди всякакъв Stripe.
 *  W. Webhook: completed активира веднъж (повторение не удвоява);
 *     несъответствие на сумата/непозната сесия -> payment_review_issues с
 *     purchase_type='profile_customization' (никога към жълтиците);
 *     expired -> canceled; charge.refunded частичен -> чака преглед (админът
 *     го маркира); пълен -> правото е анулирано.
 *  F. Флаг ИЗКЛЮЧЕН (рестарт): потребителският API -> 404, session флагът е
 *     false; админът продължава да конфигурира; вече платена поръчка се
 *     кредитира.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/checkProfileCustomizationCheckoutWebhookHttp.ts --server-root=.
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

const PASSWORD = 'ProfileCustomizationWebhook1!'
const WEBHOOK_SECRET = 'whsec_profile_customization_test_secret_000000'

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
  const root = await mkdtemp(join(tmpdir(), 'belot-profile-customization-webhook-'))
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

function startServer(serverDir: string, port: number, mode: 'normal' | 'emergency_stop'): RunningServer {
  const chunks: string[] = []
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    PASSWORD_RESET_RATE_LIMIT_SECRET: TEST_REGISTRATION_SECRET,
    // Фиктивен ключ: webhook-ът проверява подписа локално; тестовите събития
    // не изискват заявки към Stripe.
    STRIPE_SECRET_KEY: 'sk_test_dummy_no_network',
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  }
  // PROFILE_CUSTOMIZATION_ENABLED е само авариен стоп ('0'); публичният режим е в SQLite.
  delete env.PROFILE_CUSTOMIZATION_ENABLED
  if (mode === 'emergency_stop') env.PROFILE_CUSTOMIZATION_ENABLED = '0'
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
const nextIp = () => `203.0.118.${(ipCounter += 1) % 250}`
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

const cookieOf = (result: JsonResult) => result.setCookie.find((c) => c.startsWith('belot_session='))?.split(';')[0] ?? ''

function withDb<T>(databaseFile: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(databaseFile)
  try {
    db.exec('PRAGMA busy_timeout = 5000;')
    return fn(db)
  } finally {
    db.close()
  }
}

async function registerUser(port: number, databaseFile: string, label: string, role: string): Promise<{ cookie: string; email: string }> {
  const email = `pcwh-${label}-${randomUUID().slice(0, 8)}@example.test`
  const result = await request(port, 'POST', '/api/auth/register', {
    email, password: PASSWORD, displayName: `Pcwh${label}${randomUUID().slice(0, 5)}`, gender: 'male', ...prepareDirectRegistration(),
  })
  assert(result.status === 200, `register ${label}: ${result.status} ${result.text}`)
  withDb(databaseFile, (db) => db.prepare('UPDATE accounts SET role = ? WHERE email = ?').run(role, email))
  return { cookie: await login(port, email), email }
}

async function login(port: number, email: string): Promise<string> {
  const result = await request(port, 'POST', '/api/auth/login', { email, password: PASSWORD, rememberMe: true })
  const cookie = cookieOf(result)
  assert(cookie !== '', `login: ${result.status} ${result.text}`)
  return cookie
}

const stripeSigner = new Stripe('sk_test_dummy_no_network')

async function postEvent(port: number, type: string, object: Record<string, unknown>, eventId = `evt_${randomUUID()}`): Promise<number> {
  const payload = JSON.stringify({ id: eventId, object: 'event', type, data: { object } })
  const header = stripeSigner.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET })
  const response = await fetch(`http://127.0.0.1:${port}/api/stripe/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': header },
    body: payload,
  })
  await response.text()
  return response.status
}

type OrderLineInput = { kind: string; itemId: string; value: string; days: number; base: number }

/**
 * Неплатена поръчка (1..4 реда) със закачена сесия — състоянието след
 * успешния checkout route (той скрива предишната видима поръчка на профила).
 * payment-method полетата са попълнени, за да няма enrichment заявка към Stripe.
 */
function insertPendingOrder(databaseFile: string, input: { profileId: string; sessionId: string; lines: OrderLineInput[] }): { orderId: string; totalCents: number; lineIds: Record<string, string> } {
  const orderId = randomUUID()
  const totalCents = input.lines.reduce((sum, line) => sum + line.base * (line.days / 30), 0)
  const lineIds: Record<string, string> = {}
  withDb(databaseFile, (db) => {
    const nowIso = new Date().toISOString()
    db.prepare(`UPDATE profile_customization_orders SET hidden_at = ? WHERE profile_id = ? AND status = 'pending' AND hidden_at IS NULL;`).run(nowIso, input.profileId)
    db.prepare(`UPDATE profile_customization_purchases SET hidden_at = ? WHERE profile_id = ? AND status = 'pending' AND hidden_at IS NULL;`).run(nowIso, input.profileId)
    db.prepare(`
      INSERT INTO profile_customization_orders (order_id, profile_id, item_count, total_cents, provider_checkout_session_id, stripe_charge_id, payment_method_type)
      VALUES (?, ?, ?, ?, ?, 'ch_test', 'card');
    `).run(orderId, input.profileId, input.lines.length, totalCents, input.sessionId)
    for (const line of input.lines) {
      const purchaseId = randomUUID()
      lineIds[line.kind] = purchaseId
      db.prepare(`
        INSERT INTO profile_customization_purchases (
          purchase_id, order_id, profile_id, kind, item_id, item_value_snapshot, days_snapshot,
          base_price_30_days_cents_snapshot, price_cents_snapshot
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
      `).run(purchaseId, orderId, input.profileId, line.kind, line.itemId, line.value, line.days, line.base, line.base * (line.days / 30))
    }
  })
  return { orderId, totalCents, lineIds }
}

/** Поръчка с един ред — връща id на поръчката (то е и pointer-ът в Stripe metadata). */
function insertPending(databaseFile: string, input: { profileId: string; kind: string; itemId: string; value: string; days: number; base: number; sessionId: string; paymentIntentId: string }): string {
  return insertPendingOrder(databaseFile, { profileId: input.profileId, sessionId: input.sessionId, lines: [{ kind: input.kind, itemId: input.itemId, value: input.value, days: input.days, base: input.base }] }).orderId
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

const one = (kind: string, itemId: string, days: number) => ({ items: [{ kind, itemId, days }], expectedTotalCents: 199 * (days / 30) })

const API = '/api/profile-customization'

console.log('\ncheckProfileCustomizationCheckoutWebhookHttp')
console.log(`Server root: ${originalServerRoot}`)

const iso = await createIsolatedServerRoot()
let server: RunningServer | null = null

try {
  const port = await getFreePort()
  server = startServer(iso.serverDir, port, 'normal')
  await waitForServer(port, server)
  configureDirectRegistrationForTest(iso.databaseFile)

  const buyer = await registerUser(port, iso.databaseFile, 'buyer', 'player')
  const admin = await registerUser(port, iso.databaseFile, 'admin', 'admin')
  const buyerProfileId = withDb(iso.databaseFile, (db) => (db.prepare(`SELECT p.profile_id AS id FROM profiles p JOIN accounts a ON a.account_id = p.account_id WHERE a.email = ?;`).get(buyer.email) as { id: string }).id)
  const activeRow = (kind: string) => withDb(iso.databaseFile, (db) => db.prepare(`SELECT o.item_id, o.active_until FROM profile_customization_equipped e JOIN profile_customization_owned_items o ON o.profile_id = e.profile_id AND o.kind = e.kind AND o.item_id = e.item_id WHERE e.profile_id = ? AND e.kind = ?;`).get(buyerProfileId, kind) as { item_id: string; active_until: string } | undefined)
  // Поръчката (плащане/refund/преглед) и нейните редове (отделните права).
  const purchaseRow = (orderId: string) => withDb(iso.databaseFile, (db) => db.prepare(`SELECT * FROM profile_customization_orders WHERE order_id = ?;`).get(orderId) as Record<string, unknown>)
  const orderLines = (orderId: string) => withDb(iso.databaseFile, (db) => db.prepare(`SELECT * FROM profile_customization_purchases WHERE order_id = ? ORDER BY kind;`).all(orderId) as Array<Record<string, unknown>>)

  const adminProfileId = withDb(iso.databaseFile, (db) => (db.prepare(`SELECT p.profile_id AS id FROM profiles p JOIN accounts a ON a.account_id = p.account_id WHERE a.email = ?;`).get(admin.email) as { id: string }).id)

  console.log('\n[M] Режим на достъп (по подразбиране "Само админ")')

  await check('[M1] "Само админ" по подразбиране: играчът няма бутон/API/checkout; admin има', async () => {
    const meBuyer = await request(port, 'GET', '/api/auth/me', undefined, buyer.cookie)
    assert(meBuyer.body?.session?.profileCustomizationAvailable === false, 'играч: бутонът е скрит')
    const buyerGet = await request(port, 'GET', API, undefined, buyer.cookie)
    assert(buyerGet.status === 404 && buyerGet.body.code === 'feature_disabled', `играч GET ${buyerGet.status}`)
    const buyerCheckout = await request(port, 'POST', `${API}/checkout`, one('nickname_color', 'red-1', 30), buyer.cookie)
    assert(buyerCheckout.status === 404, `играч checkout ${buyerCheckout.status}`)
    const meAdmin = await request(port, 'GET', '/api/auth/me', undefined, admin.cookie)
    assert(meAdmin.body?.session?.profileCustomizationAvailable === true, 'admin: бутонът е видим')
    const adminGet = await request(port, 'GET', API, undefined, admin.cookie)
    assert(adminGet.status === 200, `admin GET ${adminGet.status}`)
    const adminSnapshot = await request(port, 'GET', '/api/admin/profile-customization', undefined, admin.cookie)
    assert(adminSnapshot.body.access.mode === 'admin_only' && adminSnapshot.body.access.changedAt === null && adminSnapshot.body.stripeMode === 'test', JSON.stringify(adminSnapshot.body.access) + adminSnapshot.body.stripeMode)
    assert(!adminSnapshot.text.includes('sk_test_dummy'), 'ключът не се изпраща')
    // Първият admin тест не изисква включване на публичната продажба.
    assert(adminGet.body.adminTestMode === true && adminGet.body.kinds.every((kind: any) => kind.salesEnabled === false && kind.purchasable === true), 'admin: тестов режим, всички екстри купуваеми')
  })

  await check('[M2] "Активирай": само пълен admin, само с потвърждение; одит кой/кога; играчът получава достъп', async () => {
    const forbidden = await request(port, 'POST', '/api/admin/profile-customization/mode', { mode: 'public', confirm: true }, buyer.cookie)
    assert(forbidden.status === 403, `играч ${forbidden.status}`)
    const noConfirm = await request(port, 'POST', '/api/admin/profile-customization/mode', { mode: 'public' }, admin.cookie)
    assert(noConfirm.status === 400 && noConfirm.body.code === 'confirmation_required', `без потвърждение ${noConfirm.status}`)
    const invalid = await request(port, 'POST', '/api/admin/profile-customization/mode', { mode: 'everyone', confirm: true }, admin.cookie)
    assert(invalid.status === 400, `невалиден режим ${invalid.status}`)
    const activated = await request(port, 'POST', '/api/admin/profile-customization/mode', { mode: 'public', confirm: true }, admin.cookie)
    assert(activated.status === 200 && activated.body.changed === true && activated.body.access.mode === 'public', activated.text.slice(0, 300))
    const audit = withDb(iso.databaseFile, (db) => db.prepare('SELECT mode, previous_mode, changed_by_profile_id FROM profile_customization_mode_changes;').all() as Array<Record<string, unknown>>)
    assert(audit.length === 1 && audit[0]!.mode === 'public' && audit[0]!.previous_mode === 'admin_only' && audit[0]!.changed_by_profile_id === adminProfileId, JSON.stringify(audit))
    assert(typeof activated.body.access.changedByDisplayName === 'string' && activated.body.access.history.length === 1, 'история')
    const again = await request(port, 'POST', '/api/admin/profile-customization/mode', { mode: 'public', confirm: true }, admin.cookie)
    assert(again.body.changed === false, 'същият режим -> без нов запис')
  })

  console.log('\n[U] Потребителски API (режим "Активна за всички")')

  await check('[U1] Гост -> 401; сесията на купувача има profileCustomizationAvailable=true', async () => {
    const guest = await request(port, 'GET', API)
    assert(guest.status === 401, `гост ${guest.status}`)
    const me = await request(port, 'GET', '/api/auth/me', undefined, buyer.cookie)
    assert(me.body?.session?.profileCustomizationAvailable === true, me.text.slice(0, 300))
  })

  await check('[U2] Каталог: 4 вида с таблица с цени, 21 цвята, 655 емоджита, няма активни екстри', async () => {
    const result = await request(port, 'GET', API, undefined, buyer.cookie)
    assert(result.status === 200 && result.body.ok === true, `${result.status} ${result.text.slice(0, 200)}`)
    assert(result.body.kinds.length === 4 && result.body.kinds.every((kind: any) => kind.salesEnabled === false), 'видове (продажбата е изключена)')
    assert(result.body.kinds[0].priceTable.map((row: any) => row.priceCents).join(',') === '199,398,597,796,995,1194', 'цени')
    assert(result.body.colors.length === 5 && result.body.emojis.length === 655, `${result.body.colors.length}/${result.body.emojis.length}`)
    assert(Object.values(result.body.active).every((value) => value === null), 'активни')
    assert(result.body.returnOrder === null, 'returnOrder')
  })

  await check('[U3] Checkout: изключена продажба / невалиден вид / срок 45 / липсващ артикул -> 4xx, нищо не е създадено', async () => {
    const disabled = await request(port, 'POST', `${API}/checkout`, one('nickname_color', 'red-1', 30), buyer.cookie)
    assert(disabled.status === 400 && disabled.body.code === 'sales_disabled', `${disabled.status} ${disabled.text}`)
    withDb(iso.databaseFile, (db) => db.exec(`UPDATE profile_customization_kind_settings SET sales_enabled = 1;`))
    const valid = { kind: 'emoji_after', itemId: 'emoji-0001', days: 30 }
    for (const [items, code, kind] of [
      [[{ kind: 'vip', itemId: 'red-1', days: 30 }], 'invalid_kind', null],
      [[{ kind: 'nickname_color', itemId: 'red-1', days: 45 }], 'invalid_duration', 'nickname_color'],
      [[{ kind: 'nickname_color', itemId: 'red-1', days: '30' }], 'invalid_duration', 'nickname_color'],
      [[{ kind: 'nickname_color', itemId: 'nope', days: 30 }], 'item_not_found', 'nickname_color'],
      [[{ kind: 'nickname_color', itemId: 'emoji-0001', days: 30 }], 'item_not_found', 'nickname_color'],
      // Невалиден ред в иначе валидна поръчка -> цялата поръчка е отказана.
      [[valid, { kind: 'message_color', itemId: 'red-1', days: 31 }], 'invalid_duration', 'message_color'],
      [[valid, { ...valid, itemId: 'emoji-0002' }], 'duplicate_kind', 'emoji_after'],
      [[], 'invalid_request', null],
      [Array.from({ length: 5 }, () => valid), 'invalid_request', null],
      ['nickname_color', 'invalid_request', null],
    ] as const) {
      const result = await request(port, 'POST', `${API}/checkout`, { items, expectedTotalCents: 199 }, buyer.cookie)
      assert(result.status === 400 && result.body.code === code && (kind === null || result.body.kind === kind), `${JSON.stringify(items)} -> ${result.status} ${result.text}`)
    }
    // Старият формат (една екстра без items) вече не се приема.
    const legacy = await request(port, 'POST', `${API}/checkout`, { kind: 'nickname_color', itemId: 'red-1', days: 30 }, buyer.cookie)
    assert(legacy.status === 400 && legacy.body.code === 'invalid_request', `стар формат ${legacy.status}`)
    const guest = await request(port, 'POST', `${API}/checkout`, one('nickname_color', 'red-1', 30))
    assert(guest.status === 401, `гост ${guest.status}`)
    const count = withDb(iso.databaseFile, (db) => (db.prepare('SELECT (SELECT COUNT(*) FROM profile_customization_purchases) + (SELECT COUNT(*) FROM profile_customization_orders) AS c;').get() as { c: number }).c)
    assert(count === 0, `поръчки ${count}`)
  })

  await check('[U4] Обща сума: сървърът я изчислява сам; различна сума от показаната -> 409 price_changed (преди Stripe, нищо не е записано)', async () => {
    const items = [{ kind: 'nickname_color', itemId: 'red-1', days: 60 }, { kind: 'emoji_before', itemId: 'emoji-0001', days: 150 }]
    for (const expectedTotalCents of [undefined, 1392, 1394, '1393']) {
      const result = await request(port, 'POST', `${API}/checkout`, { items, expectedTotalCents }, buyer.cookie)
      assert(result.status === 409 && result.body.code === 'price_changed' && result.body.preview.totalCents === 1393 && result.body.preview.lines.length === 2, `${String(expectedTotalCents)} -> ${result.status} ${result.text}`)
    }
    const count = withDb(iso.databaseFile, (db) => (db.prepare('SELECT COUNT(*) AS c FROM profile_customization_orders;').get() as { c: number }).c)
    assert(count === 0, `поръчки ${count}`)
  })

  console.log('\n[W] Stripe webhook')

  const first = { sessionId: `cs_pc_${randomUUID()}`, paymentIntentId: `pi_pc_${randomUUID()}` }
  let firstPurchaseId = ''

  await check('[W1] checkout.session.completed активира екстрата (ефект "new", 30 дни); GET показва активната екстра', async () => {
    firstPurchaseId = insertPending(iso.databaseFile, { profileId: buyerProfileId, kind: 'nickname_color', itemId: 'blue-2', value: '#4A67F7', days: 30, base: 199, ...first })
    const status = await postEvent(port, 'checkout.session.completed', completedSession(first.sessionId, firstPurchaseId, 199, first.paymentIntentId))
    assert(status === 200, `статус ${status}`)
    const row = purchaseRow(firstPurchaseId)
    assert(row.status === 'paid' && row.stripe_payment_intent_id === first.paymentIntentId && orderLines(firstPurchaseId)[0]?.grant_effect === 'new' && orderLines(firstPurchaseId)[0]?.status === 'paid', JSON.stringify(row))
    assert(activeRow('nickname_color')?.item_id === 'blue-2', 'активна')
    const snapshot = await request(port, 'GET', `${API}?sessionId=${first.sessionId}`, undefined, buyer.cookie)
    assert(snapshot.body.active.nickname_color?.value === '#4A67F7' && snapshot.body.active.nickname_color.remainingDays === 30, JSON.stringify(snapshot.body.active))
    assert(snapshot.body.returnOrder?.status === 'paid' && snapshot.body.returnOrder.orderId === firstPurchaseId && snapshot.body.returnOrder.items.length === 1 && snapshot.body.returnOrder.totalCents === 199, 'returnOrder')
  })

  await check('[W2] Повторен webhook (същото и ново събитие) не удвоява срока', async () => {
    const before = activeRow('nickname_color')?.active_until
    for (let i = 0; i < 3; i++) {
      const status = await postEvent(port, 'checkout.session.completed', completedSession(first.sessionId, firstPurchaseId, 199, first.paymentIntentId))
      assert(status === 200, `статус ${status}`)
    }
    assert(activeRow('nickname_color')?.active_until === before, 'срокът е непроменен')
  })

  await check('[W3] Чуждата сесия не се вижда като returnPurchase', async () => {
    const other = await registerUser(port, iso.databaseFile, 'other', 'player')
    const result = await request(port, 'GET', `${API}?sessionId=${first.sessionId}`, undefined, other.cookie)
    assert(result.status === 200 && result.body.returnOrder === null, JSON.stringify(result.body.returnOrder))
  })

  await check('[W4] Друг вариант при притежаван цвят -> "new" без загуба на дни и без потвърждение за замяна; притежаваният -> "extend" (стига се до проверката на сумата, преди Stripe)', async () => {
    const other = await request(port, 'POST', `${API}/checkout`, { items: [{ kind: 'nickname_color', itemId: 'red-1', days: 30 }, { kind: 'emoji_after', itemId: 'emoji-0001', days: 30 }], expectedTotalCents: 1 }, buyer.cookie)
    assert(other.status === 409 && other.body.code === 'price_changed', `${other.status} ${other.text}`)
    const nickname = other.body.preview.lines.find((line: any) => line.kind === 'nickname_color')
    assert(nickname?.effect === 'new' && nickname.forfeitedDays === 0, JSON.stringify(nickname))
    const extend = await request(port, 'POST', `${API}/checkout`, { items: [{ kind: 'nickname_color', itemId: 'blue-2', days: 30 }], expectedTotalCents: 1 }, buyer.cookie)
    assert(extend.status === 409 && extend.body.code === 'price_changed' && extend.body.preview.lines[0].effect === 'extend', `удължаване ${extend.status} ${extend.text}`)
    // Притежаваният цвят е спрян от продажба (не е сред 5-те), но собственикът може да го удължава; нов купувач — не.
    const stranger = await registerUser(port, iso.databaseFile, 'hiddenbuyer', 'player')
    const hidden = await request(port, 'POST', `${API}/checkout`, { items: [{ kind: 'nickname_color', itemId: 'blue-2', days: 30 }], expectedTotalCents: 199 }, stranger.cookie)
    assert(hidden.status === 400 && hidden.body.code === 'item_not_for_sale', `чужд купувач ${hidden.status} ${hidden.text}`)
  })

  await check('[W5] Несъответствие на сумата -> payment_review_issues (profile_customization), нищо не е активирано, жълтиците не са засегнати', async () => {
    const sessionId = `cs_pc_mismatch_${randomUUID()}`
    const purchaseId = insertPending(iso.databaseFile, { profileId: buyerProfileId, kind: 'emoji_before', itemId: 'emoji-0005', value: '😆', days: 60, base: 199, sessionId, paymentIntentId: 'pi_mismatch' })
    const status = await postEvent(port, 'checkout.session.completed', completedSession(sessionId, purchaseId, 100, 'pi_mismatch'))
    assert(status === 200, `статус ${status}`)
    const issue = withDb(iso.databaseFile, (db) => db.prepare('SELECT purchase_type, issue_kind, purchase_id FROM payment_review_issues WHERE checkout_session_id = ?;').get(sessionId) as Record<string, unknown> | undefined)
    assert(issue?.purchase_type === 'profile_customization' && issue.issue_kind === 'amount_mismatch' && issue.purchase_id === purchaseId, JSON.stringify(issue))
    assert(purchaseRow(purchaseId).status === 'pending' && activeRow('emoji_before') === undefined, 'не е активирано')
    const coinRows = withDb(iso.databaseFile, (db) => (db.prepare('SELECT COUNT(*) AS c FROM coin_purchase_ledger;').get() as { c: number }).c)
    assert(coinRows === 0, 'coin ledger')
  })

  await check('[W6] Непозната сесия с purchaseType=profile_customization -> purchase_not_found за персонализация (не за жълтици)', async () => {
    const sessionId = `cs_pc_unknown_${randomUUID()}`
    const status = await postEvent(port, 'checkout.session.completed', completedSession(sessionId, randomUUID(), 199, 'pi_unknown'))
    assert(status === 200, `статус ${status}`)
    const issue = withDb(iso.databaseFile, (db) => db.prepare('SELECT purchase_type, issue_kind FROM payment_review_issues WHERE checkout_session_id = ?;').get(sessionId) as Record<string, unknown> | undefined)
    assert(issue?.purchase_type === 'profile_customization' && issue.issue_kind === 'purchase_not_found', JSON.stringify(issue))
  })

  await check('[W7] checkout.session.expired -> поръчката е canceled', async () => {
    const sessionId = `cs_pc_expired_${randomUUID()}`
    const purchaseId = insertPending(iso.databaseFile, { profileId: buyerProfileId, kind: 'emoji_after', itemId: 'emoji-0010', value: '🙃', days: 30, base: 199, sessionId, paymentIntentId: 'pi_x' })
    const status = await postEvent(port, 'checkout.session.expired', { id: sessionId, object: 'checkout.session', status: 'expired', payment_status: 'unpaid', metadata: { purchaseType: 'profile_customization', purchaseId } })
    assert(status === 200 && purchaseRow(purchaseId).status === 'canceled' && orderLines(purchaseId).every((line) => line.status === 'canceled'), `статус ${status} ${String(purchaseRow(purchaseId).status)}`)
  })

  const refundPi = `pi_pc_refund_${randomUUID()}`
  let refundPurchaseId = ''

  await check('[W8] charge.refunded частичен -> правото остава, покупката чака преглед; админът я маркира', async () => {
    const sessionId = `cs_pc_refund_${randomUUID()}`
    refundPurchaseId = insertPending(iso.databaseFile, { profileId: buyerProfileId, kind: 'message_color', itemId: 'green-2', value: '#1B8648', days: 90, base: 199, sessionId, paymentIntentId: refundPi })
    assert(await postEvent(port, 'checkout.session.completed', completedSession(sessionId, refundPurchaseId, 597, refundPi)) === 200, 'completed')
    const status = await postEvent(port, 'charge.refunded', { id: 'ch_refund', object: 'charge', payment_intent: refundPi, amount: 597, amount_refunded: 200, refunded: false })
    assert(status === 200, `статус ${status}`)
    const row = purchaseRow(refundPurchaseId)
    assert(row.status === 'paid' && row.refunded_amount_cents === 200 && row.refund_review_status === 'pending', JSON.stringify(row))
    assert(activeRow('message_color')?.item_id === 'green-2', 'правото остава')
    const adminSnapshot = await request(port, 'GET', '/api/admin/profile-customization', undefined, admin.cookie)
    assert(adminSnapshot.body.pendingRefundReviews === 1, `за преглед ${adminSnapshot.body.pendingRefundReviews}`)
    const list = await request(port, 'GET', '/api/admin/profile-customization/purchases?status=review_pending', undefined, admin.cookie)
    assert(list.body.total === 1 && list.body.rows[0].orderId === refundPurchaseId && list.body.rows[0].lines.length === 1, 'филтър')
    const forbidden = await request(port, 'POST', `/api/admin/profile-customization/purchases/${refundPurchaseId}/refund-review`, {}, buyer.cookie)
    assert(forbidden.status === 403, `играч ${forbidden.status}`)
    const reviewed = await request(port, 'POST', `/api/admin/profile-customization/purchases/${refundPurchaseId}/refund-review`, {}, admin.cookie)
    assert(reviewed.status === 200 && reviewed.body.pendingRefundReviews === 0, `${reviewed.status} ${reviewed.text}`)
    assert(purchaseRow(refundPurchaseId).refund_review_status === 'reviewed', 'прегледан')
  })

  await check('[W9] charge.refunded пълен -> правото е анулирано; повторно събитие не променя нищо', async () => {
    const status = await postEvent(port, 'charge.refunded', { id: 'ch_refund', object: 'charge', payment_intent: refundPi, amount: 597, amount_refunded: 597, refunded: true })
    assert(status === 200, `статус ${status}`)
    assert(purchaseRow(refundPurchaseId).status === 'refunded' && activeRow('message_color') === undefined, 'анулирано')
    assert(await postEvent(port, 'charge.refunded', { id: 'ch_refund', object: 'charge', payment_intent: refundPi, amount: 597, amount_refunded: 597, refunded: true }) === 200, 'повторно')
    assert(activeRow('nickname_color')?.item_id === 'blue-2', 'другите видове не са засегнати')
  })

  await check('[W10] refund.failed след анулиране -> админ преглед (refund_failed), без автоматично възстановяване; idempotent; кой е прегледал', async () => {
    const failedRefund = { id: 're_pc_failed', object: 'refund', status: 'failed', payment_intent: refundPi, amount: 597, charge: 'ch_refund' }
    assert(await postEvent(port, 'refund.failed', failedRefund) === 200, 'refund.failed')
    const row = purchaseRow(refundPurchaseId)
    assert(row.refund_review_status === 'pending' && row.refund_review_reason === 'refund_failed' && row.refund_failed_refund_id === 're_pc_failed', JSON.stringify(row))
    assert(row.status === 'refunded' && activeRow('message_color') === undefined, 'без автоматично възстановяване')
    assert(await postEvent(port, 'charge.refund.updated', failedRefund) === 200, 'charge.refund.updated (същият refund)')
    assert(await postEvent(port, 'refund.updated', { ...failedRefund, id: 're_pc_ok', status: 'succeeded' }) === 200, 'успешен refund -> без промяна')
    const reviewed = await request(port, 'POST', `/api/admin/profile-customization/purchases/${refundPurchaseId}/refund-review`, {}, admin.cookie)
    assert(reviewed.status === 200, `преглед ${reviewed.status}`)
    const afterReview = purchaseRow(refundPurchaseId)
    assert(afterReview.refund_review_status === 'reviewed' && afterReview.refund_reviewed_by_profile_id === adminProfileId && typeof afterReview.refund_reviewed_at === 'string', JSON.stringify(afterReview))
    assert(await postEvent(port, 'refund.failed', failedRefund) === 200 && purchaseRow(refundPurchaseId).refund_review_status === 'reviewed', 'повторна доставка не отваря прегледания случай')
  })

  console.log('\n[O] Обща поръчка с няколко екстри — едно плащане')

  const multi = { sessionId: `cs_pc_multi_${randomUUID()}`, paymentIntentId: `pi_pc_multi_${randomUUID()}` }
  let multiOrder = { orderId: '', totalCents: 0, lineIds: {} as Record<string, string> }

  await check('[O1] Поръчка с 3 реда (удължаване на активния цвят + две нови екстри): един webhook активира всички; returnOrder показва всичко и общата сума', async () => {
    const nicknameBefore = activeRow('nickname_color')?.active_until as string
    multiOrder = insertPendingOrder(iso.databaseFile, {
      profileId: buyerProfileId,
      sessionId: multi.sessionId,
      lines: [
        { kind: 'nickname_color', itemId: 'blue-2', value: '#4A67F7', days: 60, base: 199 },
        { kind: 'emoji_before', itemId: 'emoji-0020', value: '😊', days: 120, base: 199 },
        { kind: 'emoji_after', itemId: 'emoji-0021', value: '😇', days: 30, base: 199 },
      ],
    })
    assert(multiOrder.totalCents === 398 + 796 + 199, `сума ${multiOrder.totalCents}`)
    const status = await postEvent(port, 'checkout.session.completed', completedSession(multi.sessionId, multiOrder.orderId, multiOrder.totalCents, multi.paymentIntentId))
    assert(status === 200, `статус ${status}`)
    const lines = orderLines(multiOrder.orderId)
    assert(lines.length === 3 && lines.every((line) => line.status === 'paid'), JSON.stringify(lines))
    const byKind = new Map(lines.map((line) => [line.kind, line]))
    assert(byKind.get('nickname_color')?.grant_effect === 'extend' && byKind.get('emoji_before')?.grant_effect === 'new' && byKind.get('emoji_after')?.grant_effect === 'new', 'ефекти')
    assert(Date.parse(activeRow('nickname_color')?.active_until as string) - Date.parse(nicknameBefore) === 60 * 86_400_000, 'удължено с 60 дни')
    assert(activeRow('emoji_before')?.item_id === 'emoji-0020' && activeRow('emoji_after')?.item_id === 'emoji-0021', 'новите са активни')
    const snapshot = await request(port, 'GET', `${API}?sessionId=${multi.sessionId}`, undefined, buyer.cookie)
    const order = snapshot.body.returnOrder
    assert(order?.status === 'paid' && order.totalCents === 1393 && order.items.length === 3 && order.items.every((item: any) => item.status === 'paid' && typeof item.grantedUntil === 'string'), JSON.stringify(order))
  })

  await check('[O2] Повторен/закъснял webhook за поръчката с 3 реда не удвоява нито един срок', async () => {
    const before = ['nickname_color', 'emoji_before', 'emoji_after'].map((kind) => activeRow(kind)?.active_until)
    for (let i = 0; i < 3; i++) {
      assert(await postEvent(port, 'checkout.session.completed', completedSession(multi.sessionId, multiOrder.orderId, multiOrder.totalCents, multi.paymentIntentId)) === 200, 'статус')
    }
    const after = ['nickname_color', 'emoji_before', 'emoji_after'].map((kind) => activeRow(kind)?.active_until)
    assert(JSON.stringify(before) === JSON.stringify(after), `${JSON.stringify(before)} != ${JSON.stringify(after)}`)
  })

  await check('[O3] Сума само на част от редовете -> payment_review_issues, НИТО ЕДИН ред не е активиран', async () => {
    const sessionId = `cs_pc_multi_mismatch_${randomUUID()}`
    const other = await registerUser(port, iso.databaseFile, 'multimismatch', 'player')
    const otherId = withDb(iso.databaseFile, (db) => (db.prepare(`SELECT p.profile_id AS id FROM profiles p JOIN accounts a ON a.account_id = p.account_id WHERE a.email = ?;`).get(other.email) as { id: string }).id)
    const order = insertPendingOrder(iso.databaseFile, { profileId: otherId, sessionId, lines: [{ kind: 'nickname_color', itemId: 'red-1', value: '#E81729', days: 30, base: 199 }, { kind: 'message_color', itemId: 'red-2', value: '#CD473E', days: 30, base: 199 }] })
    assert(await postEvent(port, 'checkout.session.completed', completedSession(sessionId, order.orderId, 199, 'pi_multi_mismatch')) === 200, 'статус')
    const issue = withDb(iso.databaseFile, (db) => db.prepare('SELECT issue_kind, purchase_id FROM payment_review_issues WHERE checkout_session_id = ?;').get(sessionId) as Record<string, unknown> | undefined)
    assert(issue?.issue_kind === 'amount_mismatch' && issue.purchase_id === order.orderId, JSON.stringify(issue))
    const active = withDb(iso.databaseFile, (db) => (db.prepare('SELECT COUNT(*) AS c FROM profile_customization_owned_items WHERE profile_id = ?;').get(otherId) as { c: number }).c)
    assert(active === 0 && purchaseRow(order.orderId).status === 'pending', 'нищо не е активирано')
  })

  await check('[O4] Частичен refund на поръчката с 3 реда -> правата остават, поръчката чака преглед (не може да се определи коя екстра)', async () => {
    assert(await postEvent(port, 'charge.refunded', { id: 'ch_multi', object: 'charge', payment_intent: multi.paymentIntentId, amount: 1393, amount_refunded: 199, refunded: false }) === 200, 'статус')
    const row = purchaseRow(multiOrder.orderId)
    assert(row.status === 'paid' && row.refunded_amount_cents === 199 && row.refund_review_status === 'pending' && row.refund_review_reason === 'partial_refund', JSON.stringify(row))
    assert(orderLines(multiOrder.orderId).every((line) => line.status === 'paid' && line.refunded_amount_cents === null), 'редовете без приписана сума')
    assert(activeRow('emoji_before') !== undefined && activeRow('emoji_after') !== undefined, 'правата остават')
    const list = await request(port, 'GET', '/api/admin/profile-customization/purchases?status=review_pending', undefined, admin.cookie)
    const listed = (list.body.rows as any[]).find((candidate) => candidate.orderId === multiOrder.orderId)
    assert(listed?.lines.length === 3 && listed.totalCents === 1393, 'в списъка за преглед с трите реда')
    const reviewed = await request(port, 'POST', `/api/admin/profile-customization/purchases/${multiOrder.orderId}/refund-review`, {}, admin.cookie)
    assert(reviewed.status === 200 && purchaseRow(multiOrder.orderId).refund_review_status === 'reviewed', `${reviewed.status} ${reviewed.text}`)
  })

  await check('[O5] Пълен refund на поръчката с 3 реда -> отменя трите права; удължението пада, а дните от по-ранната покупка (W1) остават', async () => {
    const firstUntil = purchaseRow(firstPurchaseId) && orderLines(firstPurchaseId)[0]?.granted_until_snapshot
    assert(await postEvent(port, 'charge.refunded', { id: 'ch_multi', object: 'charge', payment_intent: multi.paymentIntentId, amount: 1393, amount_refunded: 1393, refunded: true }) === 200, 'статус')
    assert(purchaseRow(multiOrder.orderId).status === 'refunded' && orderLines(multiOrder.orderId).every((line) => line.status === 'refunded'), 'refunded')
    assert(activeRow('emoji_before') === undefined && activeRow('emoji_after') === undefined, 'новите са отменени')
    assert(activeRow('nickname_color')?.active_until === firstUntil, `никнеймът се връща на срока от W1 (${String(firstUntil)} / ${String(activeRow('nickname_color')?.active_until)})`)
  })

  console.log('\n[E] Инвентар: "Използвай" / "Премахни" през API')

  await check('[E1] Нов цвят -> инвентарът има два цвята за ника, новият се използва; GET връща owned с "използва се"/"наличен"', async () => {
    const sessionId = `cs_pc_inv_${randomUUID()}`
    const order = insertPendingOrder(iso.databaseFile, { profileId: buyerProfileId, sessionId, lines: [{ kind: 'nickname_color', itemId: 'red-1', value: '#E81729', days: 30, base: 199 }] })
    assert(await postEvent(port, 'checkout.session.completed', completedSession(sessionId, order.orderId, 199, `pi_inv_${randomUUID()}`)) === 200, 'webhook')
    const snapshot = await request(port, 'GET', API, undefined, buyer.cookie)
    const nick = (snapshot.body.owned as any[]).filter((item) => item.kind === 'nickname_color')
    assert(nick.length === 2 && nick.find((item) => item.itemId === 'red-1')?.equipped === true && nick.find((item) => item.itemId === 'blue-2')?.equipped === false, JSON.stringify(nick))
    assert(snapshot.body.active.nickname_color?.itemId === 'red-1', 'използва се новият')
  })

  await check('[E2] "Използвай" стария -> сменя се безплатно (без поръчка), сроковете са непроменени; "Премахни" -> без ефект, правото остава; чужд/непритежаван -> 404', async () => {
    const owned = () => withDb(iso.databaseFile, (db) => JSON.stringify(db.prepare('SELECT item_id, active_until FROM profile_customization_owned_items WHERE profile_id = ? ORDER BY kind, item_id;').all(buyerProfileId)))
    const orders = () => withDb(iso.databaseFile, (db) => (db.prepare('SELECT COUNT(*) AS c FROM profile_customization_orders;').get() as { c: number }).c)
    const before = { owned: owned(), orders: orders() }
    const equip = await request(port, 'POST', `${API}/equip`, { kind: 'nickname_color', itemId: 'blue-2' }, buyer.cookie)
    assert(equip.status === 200 && equip.body.active.nickname_color?.itemId === 'blue-2' && (equip.body.owned as any[]).find((item) => item.itemId === 'red-1')?.equipped === false, `${equip.status} ${equip.text.slice(0, 200)}`)
    assert(activeRow('nickname_color')?.item_id === 'blue-2', 'в базата')
    const unequip = await request(port, 'POST', `${API}/unequip`, { kind: 'nickname_color' }, buyer.cookie)
    assert(unequip.status === 200 && unequip.body.active.nickname_color === null && (unequip.body.owned as any[]).filter((item) => item.kind === 'nickname_color').length === 2, unequip.text.slice(0, 200))
    assert(owned() === before.owned && orders() === before.orders, 'правата/сроковете/поръчките са непроменени')
    const stranger = await registerUser(port, iso.databaseFile, 'equipper', 'player')
    const foreign = await request(port, 'POST', `${API}/equip`, { kind: 'nickname_color', itemId: 'blue-2' }, stranger.cookie)
    assert(foreign.status === 404 && foreign.body.code === 'not_owned', `чужд ${foreign.status}`)
    const notOwned = await request(port, 'POST', `${API}/equip`, { kind: 'nickname_color', itemId: 'purple-1' }, buyer.cookie)
    assert(notOwned.status === 404 && notOwned.body.code === 'not_owned', `непритежаван ${notOwned.status}`)
    const badKind = await request(port, 'POST', `${API}/equip`, { kind: 'vip', itemId: 'blue-2' }, buyer.cookie)
    assert(badKind.status === 400, `невалиден вид ${badKind.status}`)
    const guest = await request(port, 'POST', `${API}/equip`, { kind: 'nickname_color', itemId: 'blue-2' })
    assert(guest.status === 401, `гост ${guest.status}`)
    // Обратно към синия — визуализационните проверки по-долу разчитат на него.
    assert((await request(port, 'POST', `${API}/equip`, { kind: 'nickname_color', itemId: 'blue-2' }, buyer.cookie)).status === 200, 'отново син')
  })

  await check('[E3] Изтекъл притежаван вариант не може да се използва (409 expired) и не е в owned', async () => {
    withDb(iso.databaseFile, (db) => db.prepare(`UPDATE profile_customization_owned_items SET chain_started_at = '2019-12-01T00:00:00.000Z', active_until = '2020-01-01T00:00:00.000Z' WHERE profile_id = ? AND item_id = 'red-1';`).run(buyerProfileId))
    const expired = await request(port, 'POST', `${API}/equip`, { kind: 'nickname_color', itemId: 'red-1' }, buyer.cookie)
    assert(expired.status === 409 && expired.body.code === 'expired', `${expired.status} ${expired.text}`)
    const snapshot = await request(port, 'GET', API, undefined, buyer.cookie)
    assert(!(snapshot.body.owned as any[]).some((item) => item.itemId === 'red-1'), 'изтеклият не е в инвентара')
  })

  console.log('\n[G] Безплатно предоставяне от пълен admin')

  const GRANTS = '/api/admin/profile-customization/grants'
  const grantTarget = await registerUser(port, iso.databaseFile, 'granttarget', 'player')
  const grantTargetId = withDb(iso.databaseFile, (db) => (db.prepare(`SELECT p.profile_id AS id FROM profiles p JOIN accounts a ON a.account_id = p.account_id WHERE a.email = ?;`).get(grantTarget.email) as { id: string }).id)
  const ordersCount = () => withDb(iso.databaseFile, (db) => (db.prepare('SELECT COUNT(*) AS c FROM profile_customization_orders;').get() as { c: number }).c)

  await check('[G1] Само пълен admin: player/subadmin/pika_team/marketing/top_chat_admin/chat_admin -> 403 (и за каталога на получателя, и за одита)', async () => {
    for (const role of ['player', 'subadmin', 'pika_team', 'marketing', 'top_chat_admin', 'chat_admin']) {
      const user = await registerUser(port, iso.databaseFile, `role${role.replace(/_/g, '')}`, role)
      const post = await request(port, 'POST', GRANTS, { targetProfileId: grantTargetId, confirm: true, items: [{ kind: 'nickname_color', itemId: 'red-1', days: 30 }] }, user.cookie)
      const target = await request(port, 'GET', `/api/admin/profile-customization/targets/${grantTargetId}`, undefined, user.cookie)
      const audit = await request(port, 'GET', GRANTS, undefined, user.cookie)
      assert(post.status === 403 && target.status === 403 && audit.status === 403, `${role}: ${post.status}/${target.status}/${audit.status}`)
    }
    const guest = await request(port, 'POST', GRANTS, { targetProfileId: grantTargetId, confirm: true, items: [{ kind: 'nickname_color', itemId: 'red-1', days: 30 }] })
    assert(guest.status === 403, `гост ${guest.status}`)
    assert(withDb(iso.databaseFile, (db) => (db.prepare('SELECT COUNT(*) AS c FROM profile_customization_grants;').get() as { c: number }).c) === 0, 'нищо не е предоставено')
  })

  await check('[G2] Каталогът на получателя: истинският ник, ролята, инвентарът и 5 цвята', async () => {
    const target = await request(port, 'GET', `/api/admin/profile-customization/targets/${grantTargetId}`, undefined, admin.cookie)
    assert(target.status === 200 && target.body.target.profileId === grantTargetId && typeof target.body.target.displayName === 'string' && target.body.target.displayName.startsWith('Pcwh') && target.body.target.isSelf === false && target.body.target.eligible === true, target.text.slice(0, 300))
    assert(target.body.colors.length === 5 && Array.isArray(target.body.owned) && target.body.owned.length === 0, 'каталог/инвентар')
    const missing = await request(port, 'GET', '/api/admin/profile-customization/targets/no-such-profile', undefined, admin.cookie)
    assert(missing.status === 404, `липсващ ${missing.status}`)
  })

  await check('[G3] Admin -> чужд профил: 4 екстри безплатно (без потвърждение -> 400); в инвентара на получателя, без поръчка/Stripe; одит', async () => {
    const items = [{ kind: 'nickname_color', itemId: 'blue-1', days: 90 }, { kind: 'message_color', itemId: 'green-1', days: 30 }, { kind: 'emoji_before', itemId: 'emoji-0030', days: 60 }, { kind: 'emoji_after', itemId: 'emoji-0031', days: 180 }]
    const noConfirm = await request(port, 'POST', GRANTS, { targetProfileId: grantTargetId, items }, admin.cookie)
    assert(noConfirm.status === 400 && noConfirm.body.code === 'confirmation_required', `без потвърждение ${noConfirm.status}`)
    const before = ordersCount()
    const granted = await request(port, 'POST', GRANTS, { targetProfileId: grantTargetId, confirm: true, items }, admin.cookie)
    assert(granted.status === 200 && granted.body.grants.length === 4 && granted.body.active.nickname_color?.itemId === 'blue-1', granted.text.slice(0, 300))
    assert(ordersCount() === before, 'без поръчка/Stripe')
    const asTarget = await request(port, 'GET', API, undefined, grantTarget.cookie)
    assert((asTarget.body.owned as any[]).length === 4 && asTarget.body.active.emoji_after?.itemId === 'emoji-0031', 'получателят вижда инвентара')
    const audit = await request(port, 'GET', `${GRANTS}?profileId=${grantTargetId}`, undefined, admin.cookie)
    const row = (audit.body.rows as any[]).find((item) => item.kind === 'nickname_color')
    assert(audit.body.total === 4 && row?.grantedByProfileId === adminProfileId && row.days === 90 && row.grantEffect === 'new' && typeof row.grantedUntil === 'string' && row.itemValue === '#2B74D9', JSON.stringify(row))
  })

  await check('[G4] Невалиден ред -> нищо (транзакционно); получателят може да сменя между предоставените и купените', async () => {
    const bad = await request(port, 'POST', GRANTS, { targetProfileId: grantTargetId, confirm: true, items: [{ kind: 'nickname_color', itemId: 'red-1', days: 30 }, { kind: 'message_color', itemId: 'red-1', days: 31 }] }, admin.cookie)
    assert(bad.status === 400 && bad.body.kind === 'message_color', `${bad.status} ${bad.text}`)
    const owned = await request(port, 'GET', API, undefined, grantTarget.cookie)
    assert(!(owned.body.owned as any[]).some((item) => item.itemId === 'red-1'), 'нищо не е приложено')
    const second = await request(port, 'POST', GRANTS, { targetProfileId: grantTargetId, confirm: true, items: [{ kind: 'nickname_color', itemId: 'red-1', days: 30 }] }, admin.cookie)
    assert(second.status === 200, 'втори цвят')
    const equip = await request(port, 'POST', `${API}/equip`, { kind: 'nickname_color', itemId: 'blue-1' }, grantTarget.cookie)
    assert(equip.status === 200 && equip.body.active.nickname_color?.itemId === 'blue-1', 'смяна')
  })

  await check('[G5] Admin -> собствения профил: безплатно И нормален checkout (стига до проверката на сумата, преди Stripe) работят независимо', async () => {
    const self = await request(port, 'POST', GRANTS, { targetProfileId: adminProfileId, confirm: true, items: [{ kind: 'message_color', itemId: 'purple-1', days: 30 }] }, admin.cookie)
    assert(self.status === 200 && self.body.grants[0]?.profileId === adminProfileId, self.text.slice(0, 200))
    const target = await request(port, 'GET', `/api/admin/profile-customization/targets/${adminProfileId}`, undefined, admin.cookie)
    assert(target.body.target.isSelf === true, 'isSelf')
    const checkout = await request(port, 'POST', `${API}/checkout`, { items: [{ kind: 'emoji_after', itemId: 'emoji-0040', days: 30 }], expectedTotalCents: 1 }, admin.cookie)
    assert(checkout.status === 409 && checkout.body.code === 'price_changed', `платеният път е наличен ${checkout.status}`)
  })

  console.log('\n[P] /admin/payments')

  await check('[P1] Всяка платена Stripe поръчка е ЕДИН ред "Персонализация" (без жълтици); безплатните предоставяния не са там; оборотът е нетен', async () => {
    const list = await request(port, 'GET', '/api/admin/payments?period=allTime&limit=100', undefined, admin.cookie)
    assert(list.status === 200, list.text.slice(0, 200))
    const rows = (list.body.purchases as any[]).filter((row) => row.source === 'profile_customization')
    const dbOrders = withDb(iso.databaseFile, (db) => db.prepare(`SELECT order_id, total_cents, COALESCE(refunded_amount_cents, 0) AS refunded FROM profile_customization_orders WHERE paid_at IS NOT NULL AND status IN ('paid', 'refunded');`).all() as Array<{ order_id: string; total_cents: number; refunded: number }>)
    assert(rows.length === dbOrders.length && new Set(rows.map((row) => row.purchaseId)).size === rows.length, `редове ${rows.length} / поръчки ${dbOrders.length}`)
    assert(rows.every((row) => row.packageTitle === 'Персонализация' && row.yellowCoinsAmount === null && row.vipDays === null && !('netCents' in row)), 'формат')
    const multiRow = rows.find((row) => row.purchaseId === multiOrder.orderId)
    assert(multiRow?.priceCents === 1393 && multiRow.status === 'refunded', JSON.stringify(multiRow))
    const net = dbOrders.reduce((sum, order) => sum + Math.max(order.total_cents - order.refunded, 0), 0)
    assert(list.body.summary.totalsByCurrency.EUR === net, `оборот ${list.body.summary.totalsByCurrency.EUR} != ${net}`)
    assert(!(list.body.purchases as any[]).some((row) => row.profileId === grantTargetId), 'предоставянията не са плащания')
  })

  await check('[P2] Повторен webhook не дублира реда; "Детайли" показва всички екстри, обща сума, refund', async () => {
    const sessionId = `cs_pc_pay_${randomUUID()}`
    const order = insertPendingOrder(iso.databaseFile, { profileId: buyerProfileId, sessionId, lines: [{ kind: 'nickname_color', itemId: 'gold-1', value: '#976F08', days: 60, base: 199 }, { kind: 'message_color', itemId: 'blue-1', value: '#2B74D9', days: 30, base: 199 }, { kind: 'emoji_before', itemId: 'emoji-0041', value: '😚', days: 90, base: 199 }] })
    for (let i = 0; i < 3; i++) assert(await postEvent(port, 'checkout.session.completed', completedSession(sessionId, order.orderId, order.totalCents, `pi_pay_${order.orderId}`)) === 200, 'webhook')
    const today = await request(port, 'GET', '/api/admin/payments?period=today&limit=100', undefined, admin.cookie)
    assert((today.body.purchases as any[]).filter((row) => row.purchaseId === order.orderId).length === 1, 'един ред')
    const detail = await request(port, 'GET', `/api/admin/payments/${order.orderId}`, undefined, admin.cookie)
    const customization = detail.body.purchase?.customization
    assert(detail.status === 200 && detail.body.purchase.packageTitle === 'Персонализация' && detail.body.purchase.providerCheckoutSessionId === sessionId, detail.text.slice(0, 300))
    assert(customization.items.length === 3 && customization.totalCents === 1194 && customization.items.map((item: any) => item.priceCents).join(',') === '398,199,597' && customization.items[0].itemValue === '#976F08', JSON.stringify(customization))
    const subadmin = await registerUser(port, iso.databaseFile, 'paysub', 'subadmin')
    const asSub = await request(port, 'GET', `/api/admin/payments/${order.orderId}`, undefined, subadmin.cookie)
    assert(asSub.status === 200, 'subadmin чете плащанията (досегашното правило)')
    const asPlayer = await request(port, 'GET', '/api/admin/payments?period=allTime', undefined, buyer.cookie)
    assert(asPlayer.status === 403, 'играч')
    // Визуализационните проверки по-долу очакват синия ник на купувача.
    assert((await request(port, 'POST', `${API}/equip`, { kind: 'nickname_color', itemId: 'blue-2' }, buyer.cookie)).status === 200, 'отново син')
  })

  console.log('\n[V] Визуализация в Лафче и личните чатове (реалните HTTP пътища)')

  const other = await registerUser(port, iso.databaseFile, 'viewer', 'player')
  const otherProfileId = withDb(iso.databaseFile, (db) => (db.prepare(`SELECT p.profile_id AS id FROM profiles p JOIN accounts a ON a.account_id = p.account_id WHERE a.email = ?;`).get(other.email) as { id: string }).id)
  const lafchePost = (senderProfileId: string, name: string) => {
    const messageId = randomUUID()
    withDb(iso.databaseFile, (db) => db.prepare(`INSERT INTO topic_messages (message_id, topic_id, sender_profile_id, sender_display_name, sender_role, body) VALUES (?, 'topic-lafche', ?, ?, 'player', 'здравейте');`).run(messageId, senderProfileId, name))
    return messageId
  }
  const buyerPostId = lafchePost(buyerProfileId, 'Купувач')
  const otherPostId = lafchePost(otherProfileId, 'Зрител')
  const adminPostId = lafchePost(adminProfileId, 'Админ')
  // Тестова покупка на admin (емоджи пред ника).
  {
    const sessionId = `cs_pc_admin_${randomUUID()}`
    const purchaseId = insertPending(iso.databaseFile, { profileId: adminProfileId, kind: 'emoji_before', itemId: 'emoji-0050', value: '🙂', days: 30, base: 199, sessionId, paymentIntentId: 'pi_admin' })
    await postEvent(port, 'checkout.session.completed', completedSession(sessionId, purchaseId, 199, 'pi_admin'))
  }
  {
    const [lower, higher] = [buyerProfileId, otherProfileId].sort()
    withDb(iso.databaseFile, (db) => db.prepare(`INSERT INTO profile_friendships (friendship_id, requester_profile_id, addressee_profile_id, lower_profile_id, higher_profile_id, status) VALUES (?, ?, ?, ?, ?, 'accepted');`).run(
      randomUUID(), buyerProfileId, otherProfileId, lower as string, higher as string,
    ))
  }
  const lafcheAs = async (cookie: string) => {
    const result = await request(port, 'GET', '/api/topics/topic-lafche/messages', undefined, cookie)
    assert(result.status === 200, `лафче ${result.status} ${result.text.slice(0, 200)}`)
    const byId = new Map<string, any>((result.body.messages as any[]).map((m) => [m.messageId, m]))
    return { buyer: byId.get(buyerPostId), other: byId.get(otherPostId), admin: byId.get(adminPostId) }
  }

  await check('[V1] Публично: старите съобщения носят ТЕКУЩАТА персонализация на автора; без покупка -> празен обект (нов стандартен вид)', async () => {
    const posts = await lafcheAs(other.cookie)
    assert(posts.buyer?.senderCustomization?.nicknameColor === '#4A67F7' && posts.buyer.senderCustomization.standardDefaults === true && posts.buyer.senderCustomization.emojiAfter === null, JSON.stringify(posts.buyer?.senderCustomization))
    assert(typeof posts.buyer.senderCustomization.nicknameColorUntil === 'string', 'срок за изтичане')
    assert(posts.other?.senderCustomization?.nicknameColor === null && posts.other.senderCustomization.standardDefaults === true, JSON.stringify(posts.other?.senderCustomization))
    assert(posts.admin?.senderCustomization?.emojiBefore === '🙂', 'публично: и admin екстрите се виждат')
  })

  await check('[V2] Личен чат: friendCustomization на събеседника и viewerCustomization на зрителя', async () => {
    const result = await request(port, 'GET', '/api/chat/conversations', undefined, other.cookie)
    assert(result.status === 200, `${result.status} ${result.text.slice(0, 200)}`)
    const conversation = (result.body.conversations as any[]).find((c) => c.friend?.profileId === buyerProfileId)
    assert(conversation?.friendCustomization?.nicknameColor === '#4A67F7' && conversation.friendCustomization.standardDefaults === true, JSON.stringify(conversation?.friendCustomization))
    assert(conversation.viewerCustomization?.nicknameColor === null && conversation.viewerCustomization.standardDefaults === true, 'зрителят')
  })

  await check('[V3] "Деактивирай" -> обикновен зрител: досегашен вид, платените права на играчи остават видими; admin тестовете — не', async () => {
    const deactivated = await request(port, 'POST', '/api/admin/profile-customization/mode', { mode: 'admin_only', confirm: true }, admin.cookie)
    assert(deactivated.status === 200 && deactivated.body.access.mode === 'admin_only', deactivated.text.slice(0, 200))
    const posts = await lafcheAs(other.cookie)
    assert(posts.buyer?.senderCustomization?.nicknameColor === '#4A67F7' && posts.buyer.senderCustomization.standardDefaults === false, `платеното право остава: ${JSON.stringify(posts.buyer?.senderCustomization)}`)
    assert(posts.other !== undefined && !('senderCustomization' in posts.other), 'без покупка -> досегашният вид')
    assert(posts.admin !== undefined && !('senderCustomization' in posts.admin), 'тестовата екстра на admin не се изпраща')
    const chat = await request(port, 'GET', '/api/chat/conversations', undefined, other.cookie)
    const conversation = (chat.body.conversations as any[]).find((c) => c.friend?.profileId === buyerProfileId)
    assert(conversation?.friendCustomization?.standardDefaults === false && !('viewerCustomization' in conversation), JSON.stringify(conversation))
    const asAdmin = await lafcheAs(admin.cookie)
    assert(asAdmin.admin?.senderCustomization?.emojiBefore === '🙂' && asAdmin.admin.senderCustomization.standardDefaults === true, 'admin вижда своите тестове')
    assert(asAdmin.other?.senderCustomization?.standardDefaults === true, 'admin: пълен изглед')
  })

  await check('[V4] Изтекла екстра не се изпраща (стандартният вид се връща без нова покупка)', async () => {
    withDb(iso.databaseFile, (db) => db.prepare(`UPDATE profile_customization_owned_items SET chain_started_at = '2019-12-01T00:00:00.000Z', active_until = '2020-01-01T00:00:00.000Z' WHERE profile_id = ? AND kind = 'emoji_before';`).run(adminProfileId))
    const asAdmin = await lafcheAs(admin.cookie)
    assert(asAdmin.admin?.senderCustomization?.emojiBefore === null, JSON.stringify(asAdmin.admin?.senderCustomization))
  })

  await check('[B1] "Само админ" след започната публична покупка: играчът вижда САМО статуса на своята поръчка; без каталог/покупки/чужди поръчки', async () => {
    // Режимът в момента е "Само админ" (V3). Поръчката е създадена, докато е било публично.
    const sessionId = `cs_pc_limited_${randomUUID()}`
    const purchaseId = insertPending(iso.databaseFile, { profileId: otherProfileId, kind: 'emoji_before', itemId: 'emoji-0006', value: '🤣', days: 30, base: 199, sessionId, paymentIntentId: 'pi_limited' })
    const pending = await request(port, 'GET', `${API}?sessionId=${encodeURIComponent(sessionId)}`, undefined, other.cookie)
    assert(pending.status === 200 && pending.body.limited === true && pending.body.returnOrder?.status === 'pending' && pending.body.kinds === undefined, `${pending.status} ${pending.text.slice(0, 200)}`)
    assert(await postEvent(port, 'checkout.session.completed', completedSession(sessionId, purchaseId, 199, 'pi_limited')) === 200, 'webhook')
    const paid = await request(port, 'GET', `${API}?sessionId=${encodeURIComponent(sessionId)}`, undefined, other.cookie)
    assert(paid.body.returnOrder?.status === 'paid' && paid.body.returnOrder.items[0]?.grantEffect === 'new' && paid.body.active?.emoji_before?.value === '🤣', JSON.stringify(paid.body))
    const noSession = await request(port, 'GET', API, undefined, other.cookie)
    assert(noSession.status === 404, `без поръчка -> 404 (${noSession.status})`)
    const foreign = await request(port, 'GET', `${API}?sessionId=${encodeURIComponent(first.sessionId)}`, undefined, other.cookie)
    assert(foreign.status === 404, `чужда поръчка -> 404 (${foreign.status})`)
    const checkout = await request(port, 'POST', `${API}/checkout?sessionId=${encodeURIComponent(sessionId)}`, one('emoji_before', 'emoji-0006', 30), other.cookie)
    assert(checkout.status === 404, `нова покупка -> 404 (${checkout.status})`)
    const equip = await request(port, 'POST', `${API}/equip`, { kind: 'emoji_before', itemId: 'emoji-0006' }, other.cookie)
    assert(equip.status === 404 && equip.body.code === 'feature_disabled', `"Само админ": смяна -> 404 (${equip.status})`)
  })

  await check('[N1] Без N+1: всеки път извиква груповото извличане по ВЕДНЪЖ на страница/списък, извън цикъла по съобщения', async () => {
    const { readFile } = await import('node:fs/promises')
    const source = await readFile(join(originalServerRoot, 'src', 'index.ts'), 'utf8')
    const functionBody = (name: string) => {
      const start = source.search(new RegExp(`(async )?function ${name}\\(`))
      const next = [source.indexOf('\nfunction ', start + 10), source.indexOf('\nasync function ', start + 10)].filter((index) => index > 0)
      return source.slice(start, Math.min(...next))
    }
    for (const name of ['hydrateTopicMessagesWithCurrentAvatars', 'handleTopicMessagesRequest', 'handleTopicRepliesRequest']) {
      const fn = functionBody(name)
      const calls = fn.split('getProfileCustomizationDisplaysByProfileId(').length - 1
      assert(calls === 1, `${name}: ${calls} извиквания`)
      const callIndex = fn.indexOf('getProfileCustomizationDisplaysByProfileId(')
      const loopIndex = fn.search(/\.map\(\(message\)/)
      assert(loopIndex === -1 || callIndex < loopIndex, `${name}: извикването е в цикъла`)
    }
    const chatSource = await readFile(join(originalServerRoot, 'src', 'db', 'chatStore.ts'), 'utf8')
    const listStart = chatSource.indexOf('function listConversations(')
    const list = chatSource.slice(listStart, chatSource.indexOf('\n  }\n', listStart))
    assert(list.split('customizationGetter(').length - 1 === 1, 'listConversations: една batch заявка')
  })

  // Отново публично преди рестарта — режимът трябва да оцелее (SQLite).
  await request(port, 'POST', '/api/admin/profile-customization/mode', { mode: 'public', confirm: true }, admin.cookie)

  await stopServer(server)
  server = null

  console.log('\n[F] Рестарт с авариен стоп (PROFILE_CUSTOMIZATION_ENABLED=0)')

  const offPort = await getFreePort()
  server = startServer(iso.serverDir, offPort, 'emergency_stop')
  await waitForServer(offPort, server)
  const buyerOff = await login(offPort, buyer.email)
  const adminOff = await login(offPort, admin.email)

  await check('[F1] Режимът оцелява след рестарт; аварийният стоп спира НОВИТЕ плащания за всички (вкл. admin), бутонът е скрит', async () => {
    const snapshot = await request(offPort, 'GET', '/api/admin/profile-customization', undefined, adminOff)
    assert(snapshot.body.access.mode === 'public' && snapshot.body.access.emergencyStop === true, JSON.stringify(snapshot.body.access))
    for (const cookie of [buyerOff, adminOff]) {
      const me = await request(offPort, 'GET', '/api/auth/me', undefined, cookie)
      assert(me.body?.session?.profileCustomizationAvailable === false, 'бутонът е скрит')
      const checkout = await request(offPort, 'POST', `${API}/checkout`, one('emoji_after', 'emoji-0002', 30), cookie)
      assert(checkout.status === 503 && checkout.body.code === 'purchases_halted', `checkout ${checkout.status}`)
    }
    const get = await request(offPort, 'GET', API, undefined, buyerOff)
    assert(get.status === 200, 'проверката на поръчка след плащане остава възможна')
  })

  await check('[F1b] Аварийният стоп спира само Stripe покупките: безплатното admin предоставяне работи', async () => {
    const granted = await request(offPort, 'POST', '/api/admin/profile-customization/grants', { targetProfileId: buyerProfileId, confirm: true, items: [{ kind: 'message_color', itemId: 'gold-1', days: 30 }] }, adminOff)
    assert(granted.status === 200 && granted.body.grants.length === 1, `${granted.status} ${granted.text.slice(0, 200)}`)
  })

  await check('[F2] Админът продължава да конфигурира', async () => {
    const patch = await request(offPort, 'PATCH', '/api/admin/profile-customization/kinds/emoji_after', { basePrice30Days: '0.99' }, adminOff)
    assert(patch.status === 200 && patch.body.settings.basePrice30DaysCents === 99, `${patch.status} ${patch.text}`)
  })

  await check('[F3] Вече платена поръчка (сесия отпреди стопа) се кредитира; асинхронно плащане: unpaid -> нищо, succeeded -> кредит, failed -> failed', async () => {
    const sessionId = `cs_pc_late_${randomUUID()}`
    const purchaseId = insertPending(iso.databaseFile, { profileId: buyerProfileId, kind: 'emoji_after', itemId: 'emoji-0002', value: '😃', days: 30, base: 199, sessionId, paymentIntentId: 'pi_late' })
    assert(await postEvent(offPort, 'checkout.session.completed', completedSession(sessionId, purchaseId, 199, 'pi_late')) === 200, 'статус')
    assert(purchaseRow(purchaseId).status === 'paid' && activeRow('emoji_after')?.item_id === 'emoji-0002', 'кредитирана')
    const asyncSession = `cs_pc_async_${randomUUID()}`
    const asyncPurchase = insertPending(iso.databaseFile, { profileId: otherProfileId, kind: 'emoji_after', itemId: 'emoji-0003', value: '😄', days: 30, base: 199, sessionId: asyncSession, paymentIntentId: 'pi_async' })
    const unpaid = { ...completedSession(asyncSession, asyncPurchase, 199, 'pi_async'), payment_status: 'unpaid' }
    assert(await postEvent(offPort, 'checkout.session.completed', unpaid) === 200 && purchaseRow(asyncPurchase).status === 'pending', 'неплатено -> pending')
    assert(await postEvent(offPort, 'checkout.session.async_payment_succeeded', completedSession(asyncSession, asyncPurchase, 199, 'pi_async')) === 200, 'async статус')
    assert(purchaseRow(asyncPurchase).status === 'paid', 'async -> paid')
    const failedSession = `cs_pc_async_fail_${randomUUID()}`
    const failedPurchase = insertPending(iso.databaseFile, { profileId: otherProfileId, kind: 'emoji_before', itemId: 'emoji-0004', value: '😁', days: 30, base: 199, sessionId: failedSession, paymentIntentId: 'pi_async_fail' })
    assert(await postEvent(offPort, 'checkout.session.async_payment_failed', { ...completedSession(failedSession, failedPurchase, 199, 'pi_async_fail'), payment_status: 'unpaid' }) === 200, 'async fail статус')
    assert(purchaseRow(failedPurchase).status === 'failed', 'async fail -> failed')
  })
} finally {
  if (server !== null) await stopServer(server)
  await iso.cleanup()
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
