/**
 * checkProfileCustomizationRealtimeWs.ts
 *
 * "Персонализация на профила", Етап 3 — реален изолиран сървър и РЕАЛНИЯТ
 * WebSocket поток на "Лафче": нови съобщения в реално време и catchup при
 * абониране носят ТЕКУЩАТА персонализация на автора според политиката за
 * всеки зрител (публичен режим / "Само админ").
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/checkProfileCustomizationRealtimeWs.ts --server-root=.
 */

import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import WebSocket, { type RawData } from 'ws'
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

function grantVip(databaseFile: string, profileId: string): void {
  const activeUntil = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 19).replace('T', ' ')
  withDb(databaseFile, (db) => db.prepare(`INSERT INTO vip_status (profile_id, active_until) VALUES (?, ?) ON CONFLICT(profile_id) DO UPDATE SET active_until = excluded.active_until;`).run(profileId, activeUntil))
}

function activate(databaseFile: string, profileId: string, kind: string, itemId: string, value: string): void {
  const now = new Date()
  withDb(databaseFile, (db) => db.prepare(`
    INSERT INTO profile_customization_active (profile_id, kind, item_id, item_value_snapshot, chain_id, chain_started_at, active_until)
    VALUES (?, ?, ?, ?, ?, ?, ?);
  `).run(profileId, kind, itemId, value, randomUUID(), now.toISOString(), new Date(now.getTime() + 86_400_000).toISOString()))
}

const LAFCHE = 'topic-lafche'

console.log('\ncheckProfileCustomizationRealtimeWs')
console.log(`Server root: ${originalServerRoot}`)

const iso = await createIsolatedServerRoot()
let server: RunningServer | null = null
const sockets: WebSocket[] = []

try {
  const port = await getFreePort()
  server = startServer(iso.serverDir, port, 'normal')
  await waitForServer(port, server)
  configureDirectRegistrationForTest(iso.databaseFile)

  const buyer = await registerUser(port, iso.databaseFile, 'wsbuyer', 'player')
  const viewer = await registerUser(port, iso.databaseFile, 'wsviewer', 'player')
  const admin = await registerUser(port, iso.databaseFile, 'wsadmin', 'admin')
  const profileIdOf = (email: string) => withDb(iso.databaseFile, (db) => (db.prepare(`SELECT p.profile_id AS id FROM profiles p JOIN accounts a ON a.account_id = p.account_id WHERE a.email = ?;`).get(email) as { id: string }).id)
  const buyerId = profileIdOf(buyer.email)
  const adminId = profileIdOf(admin.email)
  grantVip(iso.databaseFile, buyerId)
  grantVip(iso.databaseFile, adminId)
  activate(iso.databaseFile, buyerId, 'nickname_color', 'blue-2', '#4A67F7')
  activate(iso.databaseFile, buyerId, 'emoji_after', 'emoji-0100', '🦋')
  activate(iso.databaseFile, adminId, 'emoji_before', 'emoji-0050', '🙂')

  const activated = await request(port, 'POST', '/api/admin/profile-customization/mode', { mode: 'public', confirm: true }, admin.cookie)
  assert(activated.status === 200, `activate ${activated.status}`)

  const viewerWs = await openWs(port, viewer.cookie)
  const buyerWs = await openWs(port, buyer.cookie)
  const adminWs = await openWs(port, admin.cookie)
  sockets.push(viewerWs, buyerWs, adminWs)
  for (const ws of [viewerWs, buyerWs, adminWs]) ws.send(JSON.stringify({ type: 'subscribe_topic_messages', topicId: LAFCHE, afterSeq: 0 }))
  await sleep(400)

  await check('[R1] Публично: новото съобщение в реално време носи текущата персонализация на автора (цвят + емоджи)', async () => {
    buyerWs.send(JSON.stringify({ type: 'send_topic_message', topicId: LAFCHE, body: 'нов пост в реално време', requestId: 'rt-1' }))
    const received = await waitForWs(viewerWs, (m) => m.type === 'topic_message' && m.senderProfileId === buyerId)
    assert(received.senderCustomization?.nicknameColor === '#4A67F7' && received.senderCustomization.emojiAfter === '🦋' && received.senderCustomization.standardDefaults === true, JSON.stringify(received.senderCustomization))
    assert(received.senderDisplayName !== undefined && !String(received.senderDisplayName).includes('🦋'), 'истинското име не е променено')
  })

  const deactivated = await request(port, 'POST', '/api/admin/profile-customization/mode', { mode: 'admin_only', confirm: true }, admin.cookie)
  assert(deactivated.status === 200, `deactivate ${deactivated.status}`)

  await check('[R2] "Само админ": обикновеният зрител НЕ получава тестовата екстра на admin; admin я вижда при собствения тест', async () => {
    adminWs.send(JSON.stringify({ type: 'send_topic_message', topicId: LAFCHE, body: 'админ тест', requestId: 'rt-2' }))
    const toViewer = await waitForWs(viewerWs, (m) => m.type === 'topic_message' && m.senderProfileId === adminId)
    assert(!('senderCustomization' in toViewer), JSON.stringify(toViewer.senderCustomization))
    const toAdmin = await waitForWs(adminWs, (m) => m.type === 'topic_message' && m.senderProfileId === adminId)
    assert(toAdmin.senderCustomization?.emojiBefore === '🙂' && toAdmin.senderCustomization.standardDefaults === true, JSON.stringify(toAdmin.senderCustomization))
  })

  await check('[R3] "Само админ": платеното право на играч остава видимо в реално време (ограничен изглед, досегашни стандартни цветове)', async () => {
    buyerWs.send(JSON.stringify({ type: 'send_topic_message', topicId: LAFCHE, body: 'втори пост', requestId: 'rt-3' }))
    const received = await waitForWs(viewerWs, (m) => m.type === 'topic_message' && m.senderProfileId === buyerId && m.body === 'втори пост')
    assert(received.senderCustomization?.nicknameColor === '#4A67F7' && received.senderCustomization.standardDefaults === false, JSON.stringify(received.senderCustomization))
  })

  await check('[R4] Catchup при абониране (стари съобщения): същата политика за зрителя', async () => {
    const lateWs = await openWs(port, viewer.cookie)
    sockets.push(lateWs)
    lateWs.send(JSON.stringify({ type: 'subscribe_topic_messages', topicId: LAFCHE, afterSeq: 0 }))
    const catchup = await waitForWs(lateWs, (m) => m.type === 'topic_message_catchup' && Array.isArray(m.messages) && m.messages.length > 0)
    const buyerPost = (catchup.messages as AnyMsg[]).find((m) => m.senderProfileId === buyerId)
    const adminPost = (catchup.messages as AnyMsg[]).find((m) => m.senderProfileId === adminId)
    assert(buyerPost?.senderCustomization?.standardDefaults === false && buyerPost.senderCustomization.emojiAfter === '🦋', JSON.stringify(buyerPost?.senderCustomization))
    assert(adminPost !== undefined && !('senderCustomization' in adminPost), 'admin екстрата не е в catchup-а на обикновен зрител')
  })
} finally {
  for (const ws of sockets) ws.terminate()
  if (server !== null) await stopServer(server)
  await iso.cleanup()
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
