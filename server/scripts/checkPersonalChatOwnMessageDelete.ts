/**
 * checkPersonalChatOwnMessageDelete.ts — изтриване на СОБСТВЕНО лично
 * съобщение в /chat (и за двамата участници).
 *
 * Реален сървър (spawn на src/index.ts) върху ИЗОЛИРАНА временна директория и
 * празна SQLite база с всички миграции — никога продукционната база. HTTP +
 * WebSocket, както реален клиент; директни DB четения само за проверка.
 *
 *  1  потребител изтрива свое съобщение              10 preview-то се обновява
 *  2  получателят вече не го вижда                    11 броячите за непрочетени
 *  3  изпращачът вече не го вижда                     12 две сесии на един профил
 *  4  получателят не може да изтрие чуждо             13 получател офлайн
 *  5  трети потребител / чужд разговор                14 история след презареждане
 *  6  несъществуващо message ID                       15 архивиран разговор
 *  7  повторна заявка                                 16 синхронизация в реално време
 *  8  старо съобщение                                 17 невалидна сесия, неразрешен достъп
 *  9  последното съобщение                            18 изпращане/получаване след това
 *  +  снимка: attachment редът, опашката за файла, URL-ът; vip_dm извън обхвата;
 *     SQL injection / невалидно кодиране; без промени при отказ.
 *
 * Пускане (от server/): npm run check:personal-chat-own-message-delete
 */

import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import WebSocket, { type RawData } from 'ws'

let passed = 0
let failed = 0

async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${label}`)
  } catch (error) {
    failed += 1
    console.log(`  ✗ ${label}\n      ${error instanceof Error ? error.message : String(error)}`)
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))
const TEST_SECRET = 'personal-chat-delete-test-secret-0123456789abcdef'
const PASSWORD = 'ChatDeleteTest1!'
const serverRootArg = process.argv.find((arg) => arg.startsWith('--server-root='))?.slice('--server-root='.length) ?? '.'
const sourceServerRoot = resolve(serverRootArg)

function getFreePort(): Promise<number> {
  return new Promise((done, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (!addr || typeof addr === 'string') return srv.close(() => reject(new Error('no port')))
      srv.close(() => done(addr.port))
    })
  })
}

async function retryRm(path: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try { await rm(path, { recursive: true, force: true }); return } catch { /* retry */ }
    await sleep(250)
  }
}

async function createIsolatedServerRoot(originalServerRoot: string) {
  const root = await mkdtemp(join(tmpdir(), 'belot-chat-delete-'))
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
  const child = spawn(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'index.ts')], {
    cwd: serverDir,
    env: { ...process.env, PORT: String(port), PASSWORD_RESET_RATE_LIMIT_SECRET: TEST_SECRET },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
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

async function waitForServer(port: number): Promise<void> {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/rooms`)).status === 200) return
    } catch { /* not yet */ }
    await sleep(150)
  }
  throw new Error('server did not start')
}

let ipCounter = 0
const nextIp = () => `203.0.113.${(ipCounter += 1) % 250 + 1}`

type JsonResult = { status: number; body: Record<string, any> | null; text: string; setCookie: string[] }

async function request(port: number, method: 'GET' | 'POST' | 'DELETE' | 'PUT', pathname: string, body?: unknown, cookie?: string): Promise<JsonResult> {
  const headers: Record<string, string> = { 'X-Forwarded-For': nextIp() }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (cookie) headers.Cookie = cookie
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  let parsed: Record<string, any> | null = null
  try { parsed = JSON.parse(text) as Record<string, any> } catch { /* not json */ }
  const headersExt = res.headers as Headers & { getSetCookie?: () => string[] }
  return { status: res.status, body: parsed, text, setCookie: headersExt.getSetCookie?.() ?? [] }
}

const cookieOf = (result: JsonResult) => result.setCookie.find((c) => c.startsWith('belot_session='))?.split(';')[0] ?? ''

function withDb<T>(databaseFile: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(databaseFile)
  try { return fn(db) } finally { db.close() }
}

type TestUser = { cookie: string; profileId: string; email: string; label: string }

async function registerUser(port: number, label: string): Promise<TestUser> {
  const email = `chatdel-${label}-${randomUUID().slice(0, 8)}@example.test`
  const result = await request(port, 'POST', '/api/auth/register', {
    email, password: PASSWORD, displayName: `Del${label}${randomUUID().slice(0, 4)}`, gender: 'male', visitorId: randomUUID(),
  })
  assert(result.status === 200, `register ${label}: ${result.status} ${result.text}`)
  return { ...(await login(port, email)), email, label }
}

async function login(port: number, email: string): Promise<{ cookie: string; profileId: string }> {
  const res = await request(port, 'POST', '/api/auth/login', { email, password: PASSWORD, rememberMe: true })
  const cookie = cookieOf(res)
  assert(cookie !== '', `login ${email}: ${res.status}`)
  const me = await request(port, 'GET', '/api/auth/me', undefined, cookie)
  const profileId = (me.body?.session?.profile?.profileId as string | undefined) ?? ''
  assert(profileId !== '', `profileId ${email}`)
  return { cookie, profileId }
}

function createConversation(databaseFile: string, a: TestUser, b: TestUser, kind: 'friend' | 'pika_support' | 'vip_dm' = 'friend'): string {
  const friendshipId = randomUUID()
  const [lower, higher] = a.profileId.localeCompare(b.profileId, 'en') <= 0 ? [a.profileId, b.profileId] : [b.profileId, a.profileId]
  withDb(databaseFile, (db) => db.prepare(`
    INSERT INTO profile_friendships (friendship_id, requester_profile_id, addressee_profile_id, lower_profile_id, higher_profile_id, status, kind, responded_at)
    VALUES (?, ?, ?, ?, ?, 'accepted', ?, CURRENT_TIMESTAMP);
  `).run(friendshipId, a.profileId, b.profileId, lower, higher, kind))
  return friendshipId
}

/** Директно вмъкване (за стари съобщения с минала дата). */
function seedMessage(databaseFile: string, friendshipId: string, sender: TestUser, body: string, createdAt: string): string {
  const messageId = randomUUID()
  withDb(databaseFile, (db) => db.prepare(`
    INSERT INTO friend_chat_messages (message_id, friendship_id, sender_profile_id, body, created_at) VALUES (?, ?, ?, ?, ?);
  `).run(messageId, friendshipId, sender.profileId, body, createdAt))
  return messageId
}

const messageExists = (databaseFile: string, messageId: string) =>
  withDb(databaseFile, (db) => db.prepare('SELECT 1 AS x FROM friend_chat_messages WHERE message_id = ?').get(messageId) !== undefined)

const tableCount = (databaseFile: string, table: string) =>
  withDb(databaseFile, (db) => (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c)

async function send(port: number, user: TestUser, friendshipId: string, body: string, imageDataUrl?: string): Promise<string> {
  const res = await request(port, 'POST', `/api/chat/${friendshipId}/messages`, imageDataUrl ? { body, imageDataUrl } : { body }, user.cookie)
  assert(res.status === 200 && res.body?.ok, `send ${user.label}: ${res.status} ${res.text}`)
  return res.body!.newMessage.messageId as string
}

const del = (port: number, user: TestUser | null, friendshipId: string, messageId: string) =>
  request(port, 'DELETE', `/api/chat/${encodeURIComponent(friendshipId)}/messages/${encodeURIComponent(messageId)}`, undefined, user?.cookie)

async function messageIds(port: number, user: TestUser, friendshipId: string): Promise<string[]> {
  const res = await request(port, 'GET', `/api/chat/${friendshipId}/messages`, undefined, user.cookie)
  assert(res.status === 200 && Array.isArray(res.body?.messages), `list ${user.label}: ${res.status} ${res.text}`)
  return (res.body!.messages as Array<{ messageId: string }>).map((m) => m.messageId)
}

async function conversationOf(port: number, user: TestUser, friendshipId: string, archived = false): Promise<Record<string, any>> {
  const res = await request(port, 'GET', `/api/chat/conversations${archived ? '?archived=1' : ''}`, undefined, user.cookie)
  assert(res.status === 200, `conversations ${user.label}: ${res.status}`)
  const found = (res.body!.conversations as Array<Record<string, any>>).find((c) => c.friendshipId === friendshipId)
  assert(found, `conversation ${friendshipId} not listed for ${user.label}`)
  return found
}

type AnyMsg = Record<string, any> & { type: string }
const wsBuffers = new WeakMap<WebSocket, AnyMsg[]>()

function openWs(port: number, cookie: string): Promise<WebSocket> {
  return new Promise((done, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: cookie } })
    const buffer: AnyMsg[] = []
    wsBuffers.set(ws, buffer)
    ws.on('message', (raw: RawData) => { try { buffer.push(JSON.parse(raw.toString())) } catch { /* ignore */ } })
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('WS open timeout')) }, 5000)
    ws.once('open', () => { clearTimeout(timer); done(ws) })
    ws.once('error', (err) => { clearTimeout(timer); reject(err) })
  })
}

async function waitForWs(ws: WebSocket, predicate: (m: AnyMsg) => boolean, timeoutMs = 5000): Promise<AnyMsg> {
  const buffer = wsBuffers.get(ws) ?? []
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const idx = buffer.findIndex(predicate)
    if (idx !== -1) return buffer.splice(idx, 1)[0]!
    await sleep(25)
  }
  throw new Error('timeout waiting for WS message')
}

const deletedEvents = (ws: WebSocket, messageId?: string) =>
  (wsBuffers.get(ws) ?? []).filter((m) => m.type === 'chat_message_deleted' && (messageId === undefined || m.messageId === messageId))

const pngBuffer = await sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 30, g: 140, b: 220 } } }).png().toBuffer()
const IMAGE_DATA_URL = `data:image/png;base64,${pngBuffer.toString('base64')}`

// ─── Run ────────────────────────────────────────────────────────────────────

console.log('\ncheckPersonalChatOwnMessageDelete\n')
const isolated = await createIsolatedServerRoot(sourceServerRoot)
const port = await getFreePort()
const server = startServer(isolated.serverDir, port)
const sockets: WebSocket[] = []

try {
  await waitForServer(port)
  withDb(isolated.databaseFile, (db) => db.prepare(`UPDATE admin_settings SET setting_value = 'direct' WHERE setting_key = 'registration_verification_mode'`).run())

  const alice = await registerUser(port, 'alice')
  const bob = await registerUser(port, 'bob')
  const carol = await registerUser(port, 'carol')
  const dave = await registerUser(port, 'dave')
  const ab = createConversation(isolated.databaseFile, alice, bob)
  const ac = createConversation(isolated.databaseFile, alice, carol)

  const aliceWs = await openWs(port, alice.cookie)
  const aliceSecond = { ...alice, ...(await login(port, alice.email)) }
  const aliceWs2 = await openWs(port, aliceSecond.cookie)
  const bobWs = await openWs(port, bob.cookie)
  const carolWs = await openWs(port, carol.cookie)
  sockets.push(aliceWs, aliceWs2, bobWs, carolWs)
  await sleep(300)

  const m1 = await send(port, alice, ab, 'първо от Alice')
  const m2 = await send(port, bob, ab, 'отговор от Bob')
  const m3 = await send(port, alice, ab, 'второ от Alice')
  const m4 = await send(port, alice, ab, 'последно от Alice')

  // Съществуваща политика на платформата: няколко HTTP сесии на профил, но
  // само ЕДНА активна WS връзка — новата изтласква старата (session_displaced).
  await check('0. (контекст) втората WS връзка на Alice изтласква първата — съществуващо поведение, не е променяно', async () => {
    await waitForWs(aliceWs, (m) => m.type === 'session_displaced')
  })

  await check('1/3/16. Alice изтрива свое съобщение → 200; изчезва и при нея; WS събитие до активната ѝ връзка и до Bob', async () => {
    const res = await del(port, alice, ab, m3)
    assert(res.status === 200 && res.body?.ok === true && res.body.messageId === m3 && res.body.friendshipId === ab, `${res.status} ${res.text}`)
    assert(!messageExists(isolated.databaseFile, m3), 'row deleted')
    assert(!(await messageIds(port, alice, ab)).includes(m3), 'gone for sender')
    for (const ws of [aliceWs2, bobWs]) {
      const event = await waitForWs(ws, (m) => m.type === 'chat_message_deleted' && m.messageId === m3)
      assert(event.friendshipId === ab && Object.keys(event).sort().join() === 'friendshipId,messageId,type', JSON.stringify(event))
    }
    await sleep(200)
    assert(deletedEvents(carolWs).length === 0, 'third party gets no event')
  })

  await check('2/14. Bob (получателят) вече не го вижда — и след „презареждане“ (нова GET заявка)', async () => {
    const ids = await messageIds(port, bob, ab)
    assert(!ids.includes(m3) && ids.includes(m1) && ids.includes(m2) && ids.includes(m4), JSON.stringify(ids))
  })

  await check('4. Bob не може да изтрие съобщение на Alice → 404, без промени, без WS', async () => {
    const before = tableCount(isolated.databaseFile, 'friend_chat_messages')
    const res = await del(port, bob, ab, m1)
    assert(res.status === 404 && res.body?.code === 'message_not_found', `${res.status} ${res.text}`)
    assert(messageExists(isolated.databaseFile, m1) && tableCount(isolated.databaseFile, 'friend_chat_messages') === before, 'unchanged')
    await sleep(200)
    assert(deletedEvents(aliceWs, m1).length === 0 && deletedEvents(bobWs, m1).length === 0, 'no event')
  })

  await check('5. трети потребител: чужд разговор → 404 conversation_not_found; свой разговор + чуждо ID → 404 message_not_found', async () => {
    const foreign = await del(port, carol, ab, m1)
    assert(foreign.status === 404 && foreign.body?.code === 'conversation_not_found', `${foreign.status} ${foreign.text}`)
    // Carol е участник в ac, но m1 е от разговора ab — чуждо ID не заобикаля проверката.
    const crossConversation = await del(port, alice, ac, m1)
    assert(crossConversation.status === 404 && crossConversation.body?.code === 'message_not_found', `${crossConversation.status} ${crossConversation.text}`)
    assert(messageExists(isolated.databaseFile, m1), 'm1 kept')
  })

  await check('6. несъществуващо ID, SQL injection и невалидно кодиране → отказ, без промени', async () => {
    const before = tableCount(isolated.databaseFile, 'friend_chat_messages')
    for (const id of [randomUUID(), "' OR '1'='1", `${m1}' OR 1=1 --`, '%', 'x'.repeat(300)]) {
      const res = await del(port, alice, ab, id)
      assert(res.status === 404 && res.body?.code === 'message_not_found', `${JSON.stringify(id)}: ${res.status} ${res.text}`)
    }
    const malformed = await request(port, 'DELETE', `/api/chat/${ab}/messages/%E0%A4%A`, undefined, alice.cookie)
    assert(malformed.status === 400, `malformed: ${malformed.status}`)
    const wrongMethod = await request(port, 'POST', `/api/chat/${ab}/messages/${m1}`, {}, alice.cookie)
    assert(wrongMethod.status === 405, `method: ${wrongMethod.status}`)
    assert(tableCount(isolated.databaseFile, 'friend_chat_messages') === before && messageExists(isolated.databaseFile, m1), 'unchanged')
  })

  await check('7. повторна заявка за същото изтриване → 404, без странични ефекти и без второ WS събитие', async () => {
    const before = tableCount(isolated.databaseFile, 'friend_chat_messages')
    const queueBefore = tableCount(isolated.databaseFile, 'friend_chat_attachment_deletions')
    const again = await del(port, alice, ab, m3)
    assert(again.status === 404 && again.body?.code === 'message_not_found', `${again.status} ${again.text}`)
    await sleep(200)
    assert(deletedEvents(bobWs, m3).length === 0, 'no second event')
    assert(tableCount(isolated.databaseFile, 'friend_chat_messages') === before && tableCount(isolated.databaseFile, 'friend_chat_attachment_deletions') === queueBefore, 'unchanged')
  })

  await check('8. старо собствено съобщение (2024 г.) може да се изтрие', async () => {
    const old = seedMessage(isolated.databaseFile, ac, alice, 'много старо', '2024-01-05 10:00:00')
    const res = await del(port, alice, ac, old)
    assert(res.status === 200 && !messageExists(isolated.databaseFile, old), `${res.status} ${res.text}`)
  })

  await check('9/10. изтриване на последното съобщение → preview-то сочи предишното и при двамата; при празен разговор → null', async () => {
    const res = await del(port, alice, ab, m4)
    assert(res.status === 200, res.text)
    assert(res.body!.conversation?.lastMessage?.messageId === m2, `response preview ${JSON.stringify(res.body!.conversation?.lastMessage)}`)
    for (const user of [alice, bob]) {
      const conv = await conversationOf(port, user, ab)
      assert(conv.lastMessage?.messageId === m2 && conv.lastMessage.body === 'отговор от Bob', `${user.label}: ${JSON.stringify(conv.lastMessage)}`)
    }
    const solo = seedMessage(isolated.databaseFile, ac, alice, 'единствено', '2026-10-01 10:00:00')
    await del(port, alice, ac, solo)
    const conv = await conversationOf(port, carol, ac)
    assert(conv.lastMessage === null, `empty preview ${JSON.stringify(conv.lastMessage)}`)
  })

  await check('11. непрочетените броячи се коригират (изтрито непрочетено съобщение не се брои)', async () => {
    await request(port, 'POST', `/api/chat/${ac}/read`, undefined, carol.cookie)
    await sleep(1100) // created_at е с точност до секунда
    const u1 = await send(port, alice, ac, 'непрочетено 1')
    const u2 = await send(port, alice, ac, 'непрочетено 2')
    assert((await conversationOf(port, carol, ac)).unreadCount === 2, 'two unread')
    await del(port, alice, ac, u2)
    const conv = await conversationOf(port, carol, ac)
    assert(conv.unreadCount === 1 && conv.lastMessage?.messageId === u1, `unread ${conv.unreadCount}`)
    assert((await conversationOf(port, alice, ac)).unreadCount === 0, 'sender unread unaffected')
  })

  await check('12. две сесии на един профил: изтриване от всяка от тях; живата връзка получава събитието, другата сесия не го вижда при зареждане', async () => {
    for (const [deleter, other] of [[aliceSecond, alice], [alice, aliceSecond]] as const) {
      const m = await send(port, other, ab, 'две сесии')
      const res = await del(port, deleter, ab, m)
      assert(res.status === 200, res.text)
      for (const ws of [aliceWs2, bobWs]) await waitForWs(ws, (e) => e.type === 'chat_message_deleted' && e.messageId === m)
      assert(!(await messageIds(port, other, ab)).includes(m) && !(await messageIds(port, deleter, ab)).includes(m), 'gone for both sessions')
    }
  })

  await check('13. получателят е офлайн: след ново свързване и зареждане съобщението не се появява', async () => {
    const m = await send(port, alice, ab, 'докато Bob е офлайн')
    bobWs.close()
    await sleep(200)
    assert((await del(port, alice, ab, m)).status === 200, 'deleted while bob offline')
    const bobWsAgain = await openWs(port, bob.cookie)
    sockets.push(bobWsAgain)
    assert(!(await messageIds(port, bob, ab)).includes(m), 'not in history after reconnect')
    const conv = await conversationOf(port, bob, ab)
    assert(conv.lastMessage?.messageId !== m, 'not in preview')
  })

  await check('15. архивиран разговор (pika_support, >12 месеца): изтритото не се показва при повторно отваряне', async () => {
    const support = createConversation(isolated.databaseFile, alice, dave, 'pika_support')
    const keep = seedMessage(isolated.databaseFile, support, dave, 'старо от Dave', '2024-03-01 09:00:00')
    const own = seedMessage(isolated.databaseFile, support, alice, 'старо мое', '2024-03-02 09:00:00')
    const archived = await conversationOf(port, alice, support, true)
    assert(archived.isArchived === true && archived.lastMessage?.messageId === own, `archived ${JSON.stringify(archived)}`)
    assert((await del(port, alice, support, own)).status === 200, 'deleted in archived conversation')
    const again = await conversationOf(port, alice, support, true)
    assert(again.isArchived === true && again.lastMessage?.messageId === keep, `archived preview ${JSON.stringify(again.lastMessage)}`)
    assert(!(await messageIds(port, alice, support)).includes(own), 'history')
  })

  await check('снимка: attachment редът изчезва, файлът е в опашката за изтриване, URL-ът вече връща 404', async () => {
    const survivor = await send(port, alice, ab, 'друга снимка', IMAGE_DATA_URL)
    const survivorFilename = withDb(isolated.databaseFile, (db) => (db.prepare('SELECT storage_filename FROM friend_chat_attachments WHERE message_id = ?').get(survivor) as { storage_filename: string }).storage_filename)
    const m = await send(port, alice, ab, '', IMAGE_DATA_URL)
    const row = withDb(isolated.databaseFile, (db) => db.prepare('SELECT storage_filename FROM friend_chat_attachments WHERE message_id = ?').get(m) as { storage_filename: string } | undefined)
    assert(row, 'attachment stored')
    const url = `/api/chat/${ab}/attachments/${row.storage_filename}`
    assert((await request(port, 'GET', url, undefined, bob.cookie)).status === 200, 'attachment visible before')
    assert((await del(port, bob, ab, m)).status === 404, 'recipient cannot delete attachment message')
    assert(withDb(isolated.databaseFile, (db) => db.prepare('SELECT 1 FROM friend_chat_attachment_deletions WHERE storage_filename = ?').get(row.storage_filename)) === undefined, 'unauthorized deletion does not enqueue file cleanup')
    assert((await del(port, alice, ab, m)).status === 200, 'deleted')
    const attachmentLeft = withDb(isolated.databaseFile, (db) => db.prepare('SELECT 1 FROM friend_chat_attachments WHERE message_id = ?').get(m))
    const queued = withDb(isolated.databaseFile, (db) => db.prepare('SELECT cleanup_status FROM friend_chat_attachment_deletions WHERE storage_filename = ?').all(row.storage_filename))
    assert(attachmentLeft === undefined && queued.length === 1, `attachment ${String(attachmentLeft)} queue ${JSON.stringify(queued)}`)
    assert((await request(port, 'GET', url, undefined, bob.cookie)).status === 404, 'attachment URL gone for recipient')
    assert((await request(port, 'GET', url, undefined, alice.cookie)).status === 404, 'attachment URL gone for sender')
    assert(messageExists(isolated.databaseFile, survivor), 'unrelated attachment message kept')
    assert((await request(port, 'GET', `/api/chat/${ab}/attachments/${survivorFilename}`, undefined, bob.cookie)).status === 200, 'unrelated attachment remains accessible')
    assert(withDb(isolated.databaseFile, (db) => db.prepare('SELECT 1 FROM friend_chat_attachment_deletions WHERE storage_filename = ?').get(survivorFilename)) === undefined, 'unrelated file is not enqueued for deletion')
  })

  await check('vip_dm е извън обхвата (Теми): 403, без промени', async () => {
    const vip = createConversation(isolated.databaseFile, bob, carol, 'vip_dm')
    const m = seedMessage(isolated.databaseFile, vip, bob, 'vip', '2026-10-10 10:00:00')
    const res = await del(port, bob, vip, m)
    assert(res.status === 403 && res.body?.code === 'invalid_conversation_kind' && messageExists(isolated.databaseFile, m), `${res.status} ${res.text}`)
  })

  await check('17. невалидна или липсваща сесия → 401, без промени', async () => {
    const before = tableCount(isolated.databaseFile, 'friend_chat_messages')
    assert((await del(port, null, ab, m1)).status === 401, 'no cookie')
    assert((await del(port, { ...alice, cookie: 'belot_session=forged-token' }, ab, m1)).status === 401, 'forged cookie')
    // Клиентски „доказателства“ за авторство се игнорират (тялото не се чете).
    const spoof = await request(port, 'DELETE', `/api/chat/${ab}/messages/${m1}`, { senderProfileId: bob.profileId, profileId: alice.profileId }, bob.cookie)
    assert(spoof.status === 404, `spoof ${spoof.status}`)
    assert(tableCount(isolated.databaseFile, 'friend_chat_messages') === before && messageExists(isolated.databaseFile, m1), 'unchanged')
  })

  await check('18. изпращане и получаване след изтриванията работят (HTTP + chat_message_received)', async () => {
    const bobWsLive = sockets[sockets.length - 1]!
    const fresh = await send(port, alice, ab, 'ново след изтриването')
    await waitForWs(bobWsLive, (m) => m.type === 'chat_message_received' && m.messageId === fresh)
    const reply = await send(port, bob, ab, 'и аз пиша')
    const ids = await messageIds(port, alice, ab)
    assert(ids.includes(fresh) && ids.includes(reply) && ids.includes(m1) && ids.includes(m2), JSON.stringify(ids))
    assert((await del(port, alice, ab, fresh)).status === 200 && (await messageIds(port, bob, ab)).includes(reply), 'delete still selective')
  })
} finally {
  for (const ws of sockets) { try { ws.close() } catch { /* ignore */ } }
  await stopServer(server)
  if (failed > 0) console.log(`\n--- server output (tail) ---\n${server.output().slice(-3000)}`)
  await isolated.cleanup()
}

console.log(`\nPassed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
