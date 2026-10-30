/**
 * checkTopicThreadUnreadWindowHttp.ts
 *
 * E2E за „Теми“ — отваряне на нишка при първия непрочетен отговор и
 * отчитане на прочетеното по видимост, през РЕАЛНИЯ spawned HTTP/WS сървър
 * (изолиран temp SQLite). Harness по модела на
 * checkAdminAntiBadLuckSettingHttp.ts (direct регистрация + visitorId).
 *
 *  A. window=unread на нова нишка с 190 отговора: root непрочетен, първа страница
 *  B. частично прочитане (throughSeq) → реален остатък + WS push към второ устройство
 *  C. второ устройство / refresh: отваря се при №171 с 10 прочетени над разделителя
 *  D. закъсняла/по-ниска заявка не връща прага; валидация на throughSeq
 *  E. страници before/after (без „Покажи още“) + tombstones при reconnect
 *  F. изтрит отговор и скрит автор (заявка за изтриване)
 *  G. 0 непрочетени → край на нишката; нов отговор → 1 непрочетен
 *  H. стар клиент без body — досегашното „до края“; Лафче непроменено; auth
 */

import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import WebSocket from 'ws'
import { createTopicMessageStore } from '../src/db/topicMessageStore.js'

const PASSWORD = 'TopicThreadUnread1!'
const TEST_SECRET = 'topic-thread-unread-window-http-test-secret-0123456789'
const GENERAL = 'topic-general'
const LAFCHE = 'topic-lafche'

let passed = 0
let failed = 0

async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    passed += 1
    console.log(`  PASS  ${label}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL  ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
  }
}

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))

function getFreePort(): Promise<number> {
  return new Promise((done, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (!addr || typeof addr === 'string') {
        srv.close(() => reject(new Error('no port')))
        return
      }
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
  const root = await mkdtemp(join(tmpdir(), 'belot-topic-thread-unread-'))
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
    BELOT_GAME_WORKER_TICK_MODE: 'worker-candidate',
    BELOT_GAME_WORKER_COUNT: '1',
    PASSWORD_RESET_RATE_LIMIT_SECRET: TEST_SECRET,
    PROFILE_SELF_DELETION_ENABLED: '1',
  }
  const child = spawn(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'index.ts')], {
    cwd: serverDir,
    env,
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
    await sleep(100)
  }
  throw new Error('server did not start')
}

let ipCounter = 0
const nextIp = () => `198.51.100.${(ipCounter += 1)}`

type JsonResult = { status: number; body: any; text: string; setCookie: string[] }

async function request(port: number, method: 'GET' | 'POST', pathname: string, options: { body?: unknown; rawBody?: string; cookie?: string } = {}): Promise<JsonResult> {
  const headers: Record<string, string> = { 'X-Forwarded-For': nextIp() }
  if (options.body !== undefined || options.rawBody !== undefined) headers['Content-Type'] = 'application/json'
  if (options.cookie) headers['Cookie'] = options.cookie
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers,
    body: options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
  })
  const text = await res.text()
  let parsed: any = null
  try { parsed = JSON.parse(text) } catch { /* not json */ }
  const headersExt = res.headers as Headers & { getSetCookie?: () => string[] }
  return { status: res.status, body: parsed, text, setCookie: headersExt.getSetCookie?.() ?? [] }
}

const cookieOf = (result: JsonResult) => result.setCookie.find((c) => c.startsWith('belot_session='))?.split(';')[0] ?? ''

function withDb<T>(databaseFile: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(databaseFile)
  try { return fn(db) } finally { db.close() }
}

type User = { email: string; cookie: string; profileId: string }

async function login(port: number, email: string): Promise<{ cookie: string; profileId: string }> {
  const result = await request(port, 'POST', '/api/auth/login', { body: { email, password: PASSWORD, rememberMe: true } })
  const cookie = cookieOf(result)
  assert(cookie !== '', `login ${email}: ${result.status} ${result.text}`)
  return { cookie, profileId: String(result.body?.session?.profile?.profileId ?? '') }
}

async function registerUser(port: number, label: string): Promise<User> {
  const email = `ttu-${label}-${randomUUID().slice(0, 8)}@example.test`
  const result = await request(port, 'POST', '/api/auth/register', {
    body: { email, password: PASSWORD, displayName: `Ttu${label}${randomUUID().slice(0, 5)}`, gender: 'male', visitorId: randomUUID() },
  })
  assert(result.status === 200, `register ${label}: ${result.status} ${result.text}`)
  const session = await login(port, email)
  assert(session.profileId !== '', `profileId for ${label}`)
  return { email, ...session }
}

type WsClient = { ws: WebSocket; frames: any[] }

async function connectWs(port: number, cookie: string): Promise<WsClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: cookie } })
  const frames: any[] = []
  ws.on('message', (data) => {
    try { frames.push(JSON.parse(data.toString())) } catch { /* ignore */ }
  })
  await new Promise<void>((done, reject) => {
    ws.once('open', () => done())
    ws.once('error', reject)
  })
  return { ws, frames }
}

async function waitFor<T>(producer: () => T | undefined, label: string, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = producer()
    if (value !== undefined) return value
    await sleep(50)
  }
  throw new Error(`timeout: ${label}`)
}

const sourceServerRoot = resolve(process.argv.slice(2).find((a) => a.startsWith('--server-root='))?.slice('--server-root='.length) ?? process.cwd())
console.log('\n═══ Теми: нишка — първи непрочетен + прочетено по видимост (HTTP/WS E2E) ═══')

const isolated = await createIsolatedServerRoot(sourceServerRoot)
const port = await getFreePort()
const server = startServer(isolated.serverDir, port)
let deviceBWs: WsClient | null = null

try {
  await waitForServer(port)
  withDb(isolated.databaseFile, (db) => db.prepare(`UPDATE admin_settings SET setting_value = 'direct' WHERE setting_key = 'registration_verification_mode'`).run())

  const viewer = await registerUser(port, 'viewer')
  const author = await registerUser(port, 'author')
  const hiddenAuthor = await registerUser(port, 'hidden')

  // Директорията се зарежда ПРЕДИ съдържанието (topic-level праг = текущия край).
  const directory = await request(port, 'GET', '/api/topics', { cookie: viewer.cookie })
  assert(directory.status === 200, `topics directory: ${directory.status}`)

  const store = await createTopicMessageStore(isolated.databaseFile)
  const root = store.insertMessage({ topicId: GENERAL, senderProfileId: author.profileId, senderDisplayName: 'Author', senderRole: 'player', body: 'Тема' })
  const replies: Array<{ id: string; seq: number }> = []
  for (let i = 0; i < 190; i++) {
    const result = store.insertReply({ topicId: GENERAL, parentMessageId: root.messageId, senderProfileId: author.profileId, senderDisplayName: 'Author', senderRole: 'player', body: `Отговор ${i + 1}` })
    assert(result.ok, 'insert reply')
    if (result.ok) replies.push({ id: result.message.messageId, seq: result.message.seq })
  }
  // Cross-instance poll-ът (700 ms) може да прати собствени reconcile push-ове.
  await sleep(900)

  const repliesPath = (query: string) => `/api/topics/${GENERAL}/messages/${encodeURIComponent(root.messageId)}/replies?${query}`
  const seenPath = `/api/topics/${GENERAL}/messages/${encodeURIComponent(root.messageId)}/seen`
  const seqs = (body: any): number[] => (body.replies as Array<{ seq: number }>).map((reply) => reply.seq)

  console.log('\n=== A. нова нишка ===')
  await check('A1. window=unread: root непрочетен, страница от първия отговор, всички isUnread', async () => {
    const res = await request(port, 'GET', repliesPath('window=unread&limit=30'), { cookie: viewer.cookie })
    assert(res.status === 200, `${res.status} ${res.text}`)
    assertEqual(res.body.readState.rootIsUnread, true, 'rootIsUnread')
    assertEqual(res.body.readState.firstUnreadSeq, replies[0]!.seq, 'firstUnreadSeq')
    assertEqual(seqs(res.body), replies.slice(0, 30).map((r) => r.seq), 'first page')
    assertEqual([res.body.hasMoreBefore, res.body.hasMoreAfter], [false, true], 'flags')
    assert(res.body.replies.every((reply: any) => reply.isUnread === true), 'all unread')
  })
  await check('A2. само отварянето НЕ маркира нищо като прочетено', async () => {
    const res = await request(port, 'GET', '/api/topics', { cookie: viewer.cookie })
    const general = res.body.topics.find((topic: any) => topic.topicId === GENERAL)
    assertEqual(general.unreadCount, 191, 'general unread (root + 190)')
  })

  console.log('\n=== B. частично прочитане + второ устройство ===')
  const deviceB = await login(port, viewer.email)
  deviceBWs = await connectWs(port, deviceB.cookie)
  await sleep(300)
  await check('B1. throughSeq = №170 → остават 20 непрочетени', async () => {
    const res = await request(port, 'POST', seenPath, { cookie: viewer.cookie, body: { throughSeq: replies[169]!.seq } })
    assert(res.status === 200, `${res.status} ${res.text}`)
    assertEqual(res.body.lastSeenSeq, replies[169]!.seq, 'lastSeenSeq')
    assertEqual(res.body.unreadCount, 20, 'thread unread')
    assertEqual(res.body.topicUnreadCount, 20, 'general unread')
  })
  await check('B2. WS topic_thread_seen_updated към второто устройство носи реалния остатък (не 0)', async () => {
    const frame = await waitFor(
      () => deviceBWs!.frames.find((f) => f.type === 'topic_thread_seen_updated' && f.rootMessageId === root.messageId),
      'topic_thread_seen_updated',
    )
    assertEqual([frame.lastSeenSeq, frame.unreadCount, frame.topicUnreadCount], [replies[169]!.seq, 20, 20], 'push payload')
  })

  console.log('\n=== C. повторно отваряне (refresh / второ устройство) ===')
  await check('C1. отваря се при №171: 10 прочетени над разделителя + 20 непрочетени', async () => {
    const res = await request(port, 'GET', repliesPath('window=unread&limit=30'), { cookie: deviceB.cookie })
    assert(res.status === 200, `${res.status} ${res.text}`)
    assertEqual(res.body.readState.firstUnreadSeq, replies[170]!.seq, 'firstUnreadSeq')
    assertEqual(res.body.readState.lastSeenSeq, replies[169]!.seq, 'lastSeenSeq')
    assertEqual(res.body.readState.rootIsUnread, false, 'root read')
    assertEqual(seqs(res.body), replies.slice(160).map((r) => r.seq), 'context + unread')
    assertEqual(res.body.replies.map((reply: any) => reply.isUnread), [...Array(10).fill(false), ...Array(20).fill(true)], 'isUnread flags')
    assertEqual([res.body.hasMoreBefore, res.body.hasMoreAfter], [true, false], 'flags')
  })

  console.log('\n=== D. монотонност и валидация ===')
  await check('D1. по-нисък throughSeq (закъсняла заявка) не връща прага', async () => {
    const res = await request(port, 'POST', seenPath, { cookie: deviceB.cookie, body: { throughSeq: replies[100]!.seq } })
    assert(res.status === 200, `${res.status}`)
    assertEqual([res.body.lastSeenSeq, res.body.unreadCount], [replies[169]!.seq, 20], 'unchanged')
  })
  for (const [label, rawBody] of [['отрицателен', '{"throughSeq":-1}'], ['дроб', '{"throughSeq":1.5}'], ['текст', '{"throughSeq":"5"}'], ['невалиден JSON', '{throughSeq']] as const) {
    await check(`D2. ${label} throughSeq → 400 без промяна`, async () => {
      const res = await request(port, 'POST', seenPath, { cookie: viewer.cookie, rawBody })
      assertEqual(res.status, 400, 'status')
      const after = await request(port, 'GET', repliesPath('window=unread'), { cookie: viewer.cookie })
      assertEqual(after.body.readState.lastSeenSeq, replies[169]!.seq, 'threshold unchanged')
    })
  }

  console.log('\n=== E. страници при скрол ===')
  await check('E1. before=№161 → №131-160 (прочетени), още по-стари има', async () => {
    const res = await request(port, 'GET', repliesPath(`before=${replies[160]!.seq}&limit=30`), { cookie: viewer.cookie })
    assertEqual(seqs(res.body), replies.slice(130, 160).map((r) => r.seq), 'older page')
    assertEqual([res.body.hasMoreBefore, res.body.hasMoreAfter], [true, false], 'flags')
    assert(res.body.replies.every((reply: any) => reply.isUnread === false), 'older are read')
  })
  await check('E2. after=№150 → №151-180, hasMoreAfter; isUnread само над прага', async () => {
    const res = await request(port, 'GET', repliesPath(`after=${replies[149]!.seq}&limit=30`), { cookie: viewer.cookie })
    assertEqual(seqs(res.body), replies.slice(150, 180).map((r) => r.seq), 'newer page')
    assertEqual(res.body.hasMoreAfter, true, 'hasMoreAfter')
    assertEqual(res.body.replies.filter((reply: any) => reply.isUnread).length, 10, 'unread in page')
  })

  console.log('\n=== F. изтрити и скрити ===')
  await check('F1. изтрит непрочетен отговор: извън прозореца, брояча; tombstone при reconnect', async () => {
    const deletion = store.deleteMessage({ topicId: GENERAL, messageId: replies[170]!.id, actorAccountId: null, actorRole: 'admin' })
    assert(deletion.ok, 'delete')
    const res = await request(port, 'GET', repliesPath('window=unread&limit=30'), { cookie: viewer.cookie })
    assertEqual(res.body.readState.firstUnreadSeq, replies[171]!.seq, 'first unread moves to №172')
    assert(!seqs(res.body).includes(replies[170]!.seq), 'deleted not in window')
    const reconnect = await request(port, 'GET', repliesPath(`after=${replies[189]!.seq}`), { cookie: viewer.cookie })
    assert(reconnect.body.deletedMessageIds.includes(replies[170]!.id), 'tombstone')
    const seen = await request(port, 'POST', seenPath, { cookie: viewer.cookie, body: { throughSeq: replies[169]!.seq } })
    assertEqual(seen.body.unreadCount, 19, 'unread without deleted')
  })
  await check('F2. скрит автор (заявка за изтриване): нишката му е 404 и за seen; броячът я изключва', async () => {
    const hiddenRoot = store.insertMessage({ topicId: GENERAL, senderProfileId: hiddenAuthor.profileId, senderDisplayName: 'Hidden', senderRole: 'player', body: 'скрит' })
    const reply = store.insertReply({ topicId: GENERAL, parentMessageId: hiddenRoot.messageId, senderProfileId: author.profileId, senderDisplayName: 'Author', senderRole: 'player', body: 'чужд' })
    assert(reply.ok, 'reply under hidden')
    const before = await request(port, 'GET', '/api/topics', { cookie: viewer.cookie })
    const generalBefore = before.body.topics.find((topic: any) => topic.topicId === GENERAL).unreadCount
    const submit = await request(port, 'POST', '/api/account/deletion-request', { cookie: hiddenAuthor.cookie, body: { password: PASSWORD, confirm: true } })
    assert(submit.status === 200 || submit.status === 201, `deletion request: ${submit.status} ${submit.text}`)
    const hiddenPath = `/api/topics/${GENERAL}/messages/${encodeURIComponent(hiddenRoot.messageId)}`
    const window = await request(port, 'GET', `${hiddenPath}/replies?window=unread`, { cookie: viewer.cookie })
    const seen = await request(port, 'POST', `${hiddenPath}/seen`, { cookie: viewer.cookie, body: { throughSeq: 1 } })
    assertEqual([window.status, seen.status], [404, 404], 'hidden thread')
    const after = await request(port, 'GET', '/api/topics', { cookie: viewer.cookie })
    const generalAfter = after.body.topics.find((topic: any) => topic.topicId === GENERAL).unreadCount
    assertEqual(generalAfter, generalBefore - 2, 'hidden root + foreign reply excluded')
  })

  console.log('\n=== G. всичко прочетено и нов отговор ===')
  await check('G1. throughSeq = последния → 0 непрочетени; отваряне в края, без разделител', async () => {
    const seen = await request(port, 'POST', seenPath, { cookie: viewer.cookie, body: { throughSeq: replies[189]!.seq } })
    assertEqual(seen.body.unreadCount, 0, 'unread')
    const res = await request(port, 'GET', repliesPath('window=unread&limit=30'), { cookie: deviceB.cookie })
    assertEqual(res.body.readState.firstUnreadSeq, null, 'no divider')
    const tail = replies.slice(159).filter((r) => r.id !== replies[170]!.id).map((r) => r.seq)
    assertEqual(seqs(res.body), tail, 'tail page')
    assertEqual([res.body.hasMoreBefore, res.body.hasMoreAfter], [true, false], 'flags')
  })
  await check('G2. нов отговор → 1 непрочетен, разделителят е пред него', async () => {
    const late = store.insertReply({ topicId: GENERAL, parentMessageId: root.messageId, senderProfileId: author.profileId, senderDisplayName: 'Author', senderRole: 'player', body: 'нов' })
    assert(late.ok, 'late reply')
    const res = await request(port, 'GET', repliesPath('window=unread&limit=30'), { cookie: viewer.cookie })
    assertEqual(res.body.readState.firstUnreadSeq, late.ok ? late.message.seq : -1, 'divider before new reply')
    assertEqual(res.body.replies.filter((reply: any) => reply.isUnread).length, 1, 'one unread')
    const latest = await request(port, 'GET', repliesPath('window=latest&limit=30'), { cookie: viewer.cookie })
    assertEqual(seqs(latest.body).at(-1), late.ok ? late.message.seq : -1, 'window=latest ends with the new reply')
  })

  console.log('\n=== H. съвместимост, Лафче, auth ===')
  await check('H1. стар клиент без body → досегашното „цялата нишка прочетена“', async () => {
    const res = await request(port, 'POST', seenPath, { cookie: viewer.cookie })
    assertEqual([res.status, res.body.unreadCount], [200, 0], 'legacy seen')
  })
  await check('H2. Лафче: история и topic-level seen — непроменен контракт', async () => {
    const history = await request(port, 'GET', `/api/topics/${LAFCHE}/messages`, { cookie: viewer.cookie })
    assert(history.status === 200 && Array.isArray(history.body.messages), `lafche history ${history.status}`)
    assert(!('readState' in history.body), 'lafche history has no thread readState')
    const seen = await request(port, 'POST', `/api/topics/${LAFCHE}/seen`, { cookie: viewer.cookie })
    assertEqual([seen.status, seen.body.unreadCount], [200, 0], 'lafche topic seen')
  })
  await check('H3. без сесия → 401 и за прозореца, и за seen', async () => {
    const window = await request(port, 'GET', repliesPath('window=unread'))
    const seen = await request(port, 'POST', seenPath, { body: { throughSeq: 1 } })
    assertEqual([window.status, seen.status], [401, 401], 'unauthenticated')
  })

  store.close()
} catch (error) {
  failed += 1
  console.error(`  FAIL  harness: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  console.error(server.output().slice(-4000))
} finally {
  deviceBWs?.ws.close()
  await stopServer(server)
  await isolated.cleanup()
}

if (failed > 0) {
  console.error(`\ncheckTopicThreadUnreadWindowHttp: ${failed} failed, ${passed} passed.`)
  process.exit(1)
}
console.log(`\ncheckTopicThreadUnreadWindowHttp: ${passed} passed.\n`)
