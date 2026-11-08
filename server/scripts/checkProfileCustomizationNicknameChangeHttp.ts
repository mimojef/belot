/**
 * checkProfileCustomizationNicknameChangeHttp.ts
 *
 * Регресия за въпроса "Ако си сменя ника, ще загубя ли закупените цветове и
 * емоджита?". Персонализацията е вързана към profile_id (стабилен), не към
 * display_name. Реален изолиран сървър (временна база, всички миграции):
 * платени екстри през подписан Stripe webhook + безплатно admin
 * предоставяне + ръчна смяна на използвания вариант, после РЕАЛНА платена
 * смяна на ника (POST /api/profile/me/display-name).
 *
 *  N1  Редовете в базата (поръчки, редове, инвентар, използвани, предоставяния)
 *      са байт по байт същите; profile_id е същият; срокове не са рестартирани
 *      или удължени.
 *  N2  GET /api/profile-customization: същите активни и притежавани, същите
 *      срокове; сесията носи новото име.
 *  N3  Лафче в реално време: новото съобщение е с новото име и същата
 *      персонализация.
 *  N4  Стари съобщения (catchup по WS и HTTP при презареждане): персонализацията
 *      продължава да се прилага.
 *  N5  Личен чат: отвореният разговор (списъкът) носи персонализацията на
 *      преименувания — и за събеседника, и за него самия.
 *  N6  Повторно влизане: същото състояние; Използвай/Премахни продължават да
 *      работят след смяната.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/checkProfileCustomizationNicknameChangeHttp.ts --server-root=.
 */

import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Stripe from 'stripe'
import WebSocket, { type RawData } from 'ws'
import { TEST_REGISTRATION_SECRET, configureDirectRegistrationForTest, prepareDirectRegistration } from './fixtures/directRegistrationTestEnv.js'

const PASSWORD = 'NicknameChangeCustomization1!'
const WEBHOOK_SECRET = 'whsec_profile_customization_rename_test_0000'
const LAFCHE = 'topic-lafche'

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
  const root = await mkdtemp(join(tmpdir(), 'belot-pc-nickname-change-'))
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
const nextIp = () => `203.0.117.${(ipCounter += 1) % 250}`
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

async function login(port: number, email: string): Promise<string> {
  const result = await request(port, 'POST', '/api/auth/login', { email, password: PASSWORD, rememberMe: true })
  const cookie = result.setCookie.find((c) => c.startsWith('belot_session='))?.split(';')[0] ?? ''
  assert(cookie !== '', `login: ${result.status} ${result.text}`)
  return cookie
}

async function registerUser(port: number, databaseFile: string, label: string, role: string): Promise<{ cookie: string; email: string; profileId: string; displayName: string }> {
  const email = `pcnick-${label}-${randomUUID().slice(0, 8)}@example.test`
  const displayName = `Nick${label}${randomUUID().slice(0, 4)}`
  const result = await request(port, 'POST', '/api/auth/register', {
    email, password: PASSWORD, displayName, gender: 'male', ...prepareDirectRegistration(),
  })
  assert(result.status === 200, `register ${label}: ${result.status} ${result.text}`)
  withDb(databaseFile, (db) => db.prepare('UPDATE accounts SET role = ? WHERE email = ?').run(role, email))
  const profileId = withDb(databaseFile, (db) => (db.prepare(`SELECT p.profile_id AS id FROM profiles p JOIN accounts a ON a.account_id = p.account_id WHERE a.email = ?;`).get(email) as { id: string }).id)
  return { cookie: await login(port, email), email, profileId, displayName }
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

/** Платена поръчка: pending ред със сесия (състоянието след checkout route-а) + подписан checkout.session.completed. */
async function buyViaWebhook(port: number, databaseFile: string, profileId: string, lines: Line[]): Promise<void> {
  const orderId = randomUUID()
  const sessionId = `cs_nick_${randomUUID()}`
  const totalCents = lines.reduce((sum, line) => sum + 199 * (line.days / 30), 0)
  withDb(databaseFile, (db) => {
    const nowIso = new Date().toISOString()
    db.prepare(`UPDATE profile_customization_orders SET hidden_at = ? WHERE profile_id = ? AND status = 'pending' AND hidden_at IS NULL;`).run(nowIso, profileId)
    db.prepare(`
      INSERT INTO profile_customization_orders (order_id, profile_id, item_count, total_cents, provider_checkout_session_id, stripe_charge_id, payment_method_type)
      VALUES (?, ?, ?, ?, ?, 'ch_test', 'card');
    `).run(orderId, profileId, lines.length, totalCents, sessionId)
    for (const line of lines) {
      db.prepare(`
        INSERT INTO profile_customization_purchases (purchase_id, order_id, profile_id, kind, item_id, item_value_snapshot, days_snapshot, base_price_30_days_cents_snapshot, price_cents_snapshot)
        VALUES (?, ?, ?, ?, ?, ?, ?, 199, ?);
      `).run(randomUUID(), orderId, profileId, line.kind, line.itemId, line.value, line.days, 199 * (line.days / 30))
    }
  })
  const status = await postEvent(port, 'checkout.session.completed', {
    id: sessionId, object: 'checkout.session', payment_status: 'paid', status: 'complete', currency: 'eur',
    amount_total: totalCents, payment_intent: `pi_nick_${randomUUID()}`,
    metadata: { purchaseType: 'profile_customization', orderId, purchaseId: orderId },
  })
  assert(status === 200, `webhook ${status}`)
}

type AnyMsg = Record<string, any> & { type: string }
const wsBuffers = new WeakMap<WebSocket, AnyMsg[]>()

function openWs(port: number, cookie: string): Promise<WebSocket> {
  return new Promise((resolveWs, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: cookie } })
    const buffer: AnyMsg[] = []
    wsBuffers.set(ws, buffer)
    ws.on('message', (raw: RawData) => {
      try { buffer.push(JSON.parse(raw.toString())) } catch { /* ignore */ }
    })
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('WS open timeout')) }, 8000)
    ws.once('open', () => { clearTimeout(timer); resolveWs(ws) })
    ws.once('error', (error) => { clearTimeout(timer); reject(error) })
  })
}

async function waitForWs(ws: WebSocket, predicate: (msg: AnyMsg) => boolean, timeoutMs = 10_000): Promise<AnyMsg> {
  const deadline = Date.now() + timeoutMs
  const buffer = wsBuffers.get(ws)!
  while (Date.now() < deadline) {
    const found = buffer.find(predicate)
    if (found !== undefined) return found
    await sleep(30)
  }
  throw new Error('Timeout waiting for WS message')
}

/** Очакваният вид след покупките/предоставянето (стойностите, които трябва да оцелеят смяната на ника). */
const EXPECTED = { nicknameColor: '#DC408E', messageColor: '#2B74D9', emojiBefore: '😀', emojiAfter: '😃' }

function assertDisplay(display: any, label: string): void {
  assert(
    display?.nicknameColor === EXPECTED.nicknameColor && display.messageColor === EXPECTED.messageColor
      && display.emojiBefore === EXPECTED.emojiBefore && display.emojiAfter === EXPECTED.emojiAfter,
    `${label}: ${JSON.stringify(display)}`,
  )
}

console.log('\ncheckProfileCustomizationNicknameChangeHttp')
console.log(`Server root: ${originalServerRoot}`)

const iso = await createIsolatedServerRoot()
let server: RunningServer | null = null
const sockets: WebSocket[] = []

try {
  const port = await getFreePort()
  server = startServer(iso.serverDir, port)
  await waitForServer(port, server)
  configureDirectRegistrationForTest(iso.databaseFile)

  const admin = await registerUser(port, iso.databaseFile, 'admin', 'admin')
  const buyer = await registerUser(port, iso.databaseFile, 'buyer', 'player')
  const friend = await registerUser(port, iso.databaseFile, 'friend', 'player')
  assert((await request(port, 'POST', '/api/admin/profile-customization/mode', { mode: 'public', confirm: true }, admin.cookie)).status === 200, 'публичен режим')

  // VIP (за Лафче), жълтици за платената смяна на ника, приятелство за личния чат.
  withDb(iso.databaseFile, (db) => {
    const vipUntil = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 19).replace('T', ' ')
    for (const profileId of [buyer.profileId, friend.profileId]) {
      db.prepare(`INSERT INTO vip_status (profile_id, active_until) VALUES (?, ?) ON CONFLICT(profile_id) DO UPDATE SET active_until = excluded.active_until;`).run(profileId, vipUntil)
    }
    db.prepare(`INSERT INTO profile_wallets (profile_id, yellow_coins_balance) VALUES (?, 1000000) ON CONFLICT(profile_id) DO UPDATE SET yellow_coins_balance = 1000000;`).run(buyer.profileId)
    const [lower, higher] = [buyer.profileId, friend.profileId].sort()
    db.prepare(`INSERT INTO profile_friendships (friendship_id, requester_profile_id, addressee_profile_id, lower_profile_id, higher_profile_id, status, responded_at) VALUES (?, ?, ?, ?, ?, 'accepted', CURRENT_TIMESTAMP);`).run(randomUUID(), buyer.profileId, friend.profileId, lower, higher)
  })

  // Платени: Розов ник + Син текст + емоджи пред; втора поръчка — Червен ник
  // (става "използва се"), после ръчно обратно на Розов (активният избор).
  await buyViaWebhook(port, iso.databaseFile, buyer.profileId, [
    { kind: 'nickname_color', itemId: 'pink-1', value: '#DC408E', days: 60 },
    { kind: 'message_color', itemId: 'blue-1', value: '#2B74D9', days: 30 },
    { kind: 'emoji_before', itemId: 'emoji-0001', value: '😀', days: 90 },
  ])
  await buyViaWebhook(port, iso.databaseFile, buyer.profileId, [{ kind: 'nickname_color', itemId: 'red-1', value: '#E81729', days: 30 }])
  const reEquip = await request(port, 'POST', '/api/profile-customization/equip', { kind: 'nickname_color', itemId: 'pink-1' }, buyer.cookie)
  assert(reEquip.status === 200, `equip ${reEquip.status} ${reEquip.text}`)
  // Безплатно admin предоставяне: емоджи след.
  const granted = await request(port, 'POST', '/api/admin/profile-customization/grants', { targetProfileId: buyer.profileId, confirm: true, items: [{ kind: 'emoji_after', itemId: 'emoji-0002', days: 120 }] }, admin.cookie)
  assert(granted.status === 200, `grant ${granted.status} ${granted.text}`)

  const dbState = () => withDb(iso.databaseFile, (db) => JSON.stringify({
    orders: db.prepare('SELECT * FROM profile_customization_orders WHERE profile_id = ? ORDER BY order_id;').all(buyer.profileId),
    purchases: db.prepare('SELECT * FROM profile_customization_purchases WHERE profile_id = ? ORDER BY purchase_id;').all(buyer.profileId),
    owned: db.prepare('SELECT * FROM profile_customization_owned_items WHERE profile_id = ? ORDER BY kind, item_id;').all(buyer.profileId),
    equipped: db.prepare('SELECT * FROM profile_customization_equipped WHERE profile_id = ? ORDER BY kind;').all(buyer.profileId),
    grants: db.prepare('SELECT * FROM profile_customization_grants WHERE profile_id = ? ORDER BY grant_id;').all(buyer.profileId),
  }))
  const snapshotOf = async (cookie: string) => {
    const result = await request(port, 'GET', '/api/profile-customization', undefined, cookie)
    assert(result.status === 200, `GET ${result.status}`)
    const owned = (result.body.owned as any[]).map((item) => `${item.kind}|${item.itemId}|${item.activeUntil}|${item.equipped}`).sort()
    const active = Object.fromEntries(Object.entries(result.body.active as Record<string, any>).map(([kind, item]) => [kind, item === null ? null : `${item.itemId}|${item.value}|${item.activeUntil}`]))
    return { owned, active }
  }

  const stateBefore = dbState()
  const apiBefore = await snapshotOf(buyer.cookie)
  assert(apiBefore.owned.length === 5, `притежавани преди: ${JSON.stringify(apiBefore.owned)}`)

  // Отворени връзки ПРЕДИ смяната: Лафче (зрител) и стар пост.
  const viewerWs = await openWs(port, friend.cookie)
  const buyerWs = await openWs(port, buyer.cookie)
  sockets.push(viewerWs, buyerWs)
  for (const ws of [viewerWs, buyerWs]) ws.send(JSON.stringify({ type: 'subscribe_topic_messages', topicId: LAFCHE, afterSeq: 0 }))
  await sleep(400)
  buyerWs.send(JSON.stringify({ type: 'send_topic_message', topicId: LAFCHE, body: 'пост преди смяната', requestId: 'nick-1' }))
  const oldPost = await waitForWs(viewerWs, (m) => m.type === 'topic_message' && m.senderProfileId === buyer.profileId)
  assertDisplay(oldPost.senderCustomization, 'преди смяната')

  // ─── Смяната на ника (реалният платен маршрут) ─────────────────────────
  const newName = `Renamed${randomUUID().slice(0, 6)}`
  const renamed = await request(port, 'POST', '/api/profile/me/display-name', { displayName: newName }, buyer.cookie)
  assert(renamed.status === 200 && renamed.body?.ok === true, `смяна на ника ${renamed.status} ${renamed.text.slice(0, 300)}`)

  console.log('\n[N] След смяна на ника при активна персонализация')

  await check('[N1] Базата: поръчки, редове, инвентар, използвани и предоставяния — байт по байт същите; същият profile_id с новото име; сроковете не са рестартирани/удължени', () => {
    assert(dbState() === stateBefore, 'редовете на персонализацията са променени')
    const profile = withDb(iso.databaseFile, (db) => db.prepare('SELECT profile_id, display_name FROM profiles WHERE profile_id = ?;').get(buyer.profileId) as { profile_id: string; display_name: string } | undefined)
    assert(profile?.display_name === newName, JSON.stringify(profile))
    const ledger = withDb(iso.databaseFile, (db) => (db.prepare('SELECT COUNT(*) AS c FROM profile_name_change_ledger WHERE profile_id = ?;').get(buyer.profileId) as { c: number }).c)
    assert(ledger === 1, `реална платена смяна: ${ledger}`)
  })

  await check('[N2] API (презареждане на прозореца): същите използвани и притежавани варианти (вкл. неизползвания Червен и подареното емоджи) със същите срокове; сесията е с новото име', async () => {
    const apiAfter = await snapshotOf(buyer.cookie)
    assert(JSON.stringify(apiAfter) === JSON.stringify(apiBefore), `${JSON.stringify(apiAfter)} != ${JSON.stringify(apiBefore)}`)
    assert(apiAfter.active.nickname_color?.startsWith('pink-1|') === true && apiAfter.owned.some((item) => item.startsWith('nickname_color|red-1|') && item.endsWith('|false')), 'активният избор е запазен')
    const me = await request(port, 'GET', '/api/auth/me', undefined, buyer.cookie)
    assert(me.body?.session?.profile?.displayName === newName && me.body.session.profileCustomizationAvailable === true, JSON.stringify(me.body?.session?.profile?.displayName))
  })

  await check('[N3] Лафче в реално време (отворена връзка отпреди смяната): новото съобщение е с новото име и същия цвят/емоджита', async () => {
    buyerWs.send(JSON.stringify({ type: 'send_topic_message', topicId: LAFCHE, body: 'пост след смяната', requestId: 'nick-2' }))
    const post = await waitForWs(viewerWs, (m) => m.type === 'topic_message' && m.senderProfileId === buyer.profileId && m.body === 'пост след смяната')
    assert(post.senderDisplayName === newName, `име ${post.senderDisplayName}`)
    assertDisplay(post.senderCustomization, 'ново съобщение')
  })

  await check('[N4] Стари съобщения: catchup по WS и HTTP зареждане (презареждане на страницата) — персонализацията се прилага и към поста отпреди смяната', async () => {
    const lateWs = await openWs(port, friend.cookie)
    sockets.push(lateWs)
    lateWs.send(JSON.stringify({ type: 'subscribe_topic_messages', topicId: LAFCHE, afterSeq: 0 }))
    const catchup = await waitForWs(lateWs, (m) => m.type === 'topic_message_catchup' && Array.isArray(m.messages) && m.messages.length >= 2)
    const old = (catchup.messages as AnyMsg[]).find((m) => m.messageId === oldPost.messageId)
    assertDisplay(old?.senderCustomization, 'catchup, стар пост')
    const page = await request(port, 'GET', `/api/topics/${LAFCHE}/messages`, undefined, friend.cookie)
    assert(page.status === 200, `HTTP ${page.status} ${page.text.slice(0, 200)}`)
    const list = (page.body.messages ?? page.body.page?.messages ?? []) as AnyMsg[]
    const oldHttp = list.find((m) => m.messageId === oldPost.messageId)
    assertDisplay(oldHttp?.senderCustomization, 'HTTP, стар пост')
  })

  await check('[N5] Личен чат: разговорът носи персонализацията на преименувания — при събеседника (friendCustomization) и при него самия (viewerCustomization)', async () => {
    const asFriend = await request(port, 'GET', '/api/chat/conversations', undefined, friend.cookie)
    assert(asFriend.status === 200, `събеседник ${asFriend.status} ${asFriend.text.slice(0, 200)}`)
    const conversation = (asFriend.body.conversations as AnyMsg[]).find((c) => c.friend?.profileId === buyer.profileId)
    assert(conversation?.friend?.displayName === newName, `име в чата ${conversation?.friend?.displayName}`)
    assertDisplay(conversation?.friendCustomization, 'friendCustomization')
    const asSelf = await request(port, 'GET', '/api/chat/conversations', undefined, buyer.cookie)
    const own = (asSelf.body.conversations as AnyMsg[]).find((c) => c.friend?.profileId === friend.profileId)
    assertDisplay(own?.viewerCustomization, 'viewerCustomization')
  })

  await check('[N6] Повторно влизане: същото състояние; "Премахни"/"Използвай" продължават да работят; срокът не се променя', async () => {
    const cookie = await login(port, buyer.email)
    const after = await snapshotOf(cookie)
    assert(JSON.stringify(after) === JSON.stringify(apiBefore), 'след повторно влизане')
    const removed = await request(port, 'POST', '/api/profile-customization/unequip', { kind: 'emoji_before' }, cookie)
    assert(removed.status === 200 && removed.body.active.emoji_before === null, `премахни ${removed.status}`)
    const equipped = await request(port, 'POST', '/api/profile-customization/equip', { kind: 'emoji_before', itemId: 'emoji-0001' }, cookie)
    assert(equipped.status === 200 && equipped.body.active.emoji_before?.value === '😀', `използвай ${equipped.status}`)
    const final = await snapshotOf(cookie)
    assert(JSON.stringify(final) === JSON.stringify(apiBefore), 'сроковете са същите')
  })
} finally {
  for (const ws of sockets) ws.terminate()
  if (server !== null) await stopServer(server)
  await iso.cleanup()
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
