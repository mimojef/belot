/**
 * checkTopicMessageLikePollIntegration.ts
 *
 * Интеграционен тест (два реални server процеса върху една временна база) за
 * like drift-detection poll-а (runTopicMessageLikePoll) — поведението трябва
 * да е идентично преди и след ограничаването на tracking set-а
 * (src/realtime/topicMessageLikeTracking.ts). Пуска се и срещу стария код.
 *
 * Съобщенията се публикуват през инстанция B → инстанция A ги вижда през
 * cross-instance poll-а и ги следи (seed). Out-of-band промените по likes
 * (друга инстанция / CASCADE при изтриване на профил) се правят директно в
 * базата, без local toggle → без echo suppression.
 *
 * [1]  Like/unlike на A: subscribers получават count, без дублиран poll echo
 * [2]  Различни потребители в една тема: count 2, public broadcast без identity
 * [3]  Out-of-band like → drift broadcast към всички subscribers на темата
 * [4]  Затваряне на темата → не получава; повторно отваряне → получава отново
 * [5]  Reconnect (terminate + нов WS + subscribe с afterSeq) → получава drift
 * [6]  Смяна на тема: drift само към subscribers на съответната тема
 * [7]  Toggle след drift: viewerHasLiked/count коректни (self ack + public)
 * [8]  Hard delete на харесано съобщение → без broadcast, poll-ът продължава
 * [9]  Непрочетени отговори / „Нови отговори“: likes не променят unreadCount
 * [10] Cross-instance: like на A стига до subscriber на B (catch-up seed)
 * [11] Без „like drift-detection poll failed“ в логовете на двата процеса
 */

import { DatabaseSync } from 'node:sqlite'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm, cp, mkdir, symlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import WebSocket, { type RawData } from 'ws'
import { TEST_REGISTRATION_SECRET, configureDirectRegistrationForTest, prepareDirectRegistration } from './fixtures/directRegistrationTestEnv.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverRoot = resolve(__dirname, '..')

let passed = 0
let failed = 0
async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`  PASS  ${label}`)
  } catch (err) {
    failed++
    console.error(`  FAIL  ${label}: ${err instanceof Error ? err.message : String(err)}`)
  }
}
function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}
function assertEqual<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) throw new Error(`${msg}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

const SERVER_READY_TIMEOUT_MS = 30_000
const PASSWORD = 'TopicLikePollCheck1!'
const DRIFT_TIMEOUT_MS = 10_000 // poll на 4 сек + запас
const NO_ECHO_WINDOW_MS = 9_000 // > 2 poll tick-а

function getFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (!addr || typeof addr === 'string') { srv.close(() => reject(new Error('No free port'))); return }
      const { port } = addr
      srv.close(() => resolvePort(port))
    })
  })
}

async function waitFor(label: string, pred: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await pred()) return
    await sleep(100)
  }
  throw new Error(`Timeout: ${label}`)
}

async function retryRm(path: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try { await rm(path, { recursive: true, force: true }); return } catch { /* retry */ }
    await sleep(250)
  }
}

async function makeIsolated(root: string) {
  const tmp = await mkdtemp(join(tmpdir(), 'belot-topic-like-poll-'))
  const serverDir = join(tmp, 'server')
  await mkdir(serverDir, { recursive: true })
  await cp(join(root, 'src'), join(serverDir, 'src'), { recursive: true, preserveTimestamps: true })
  await cp(join(root, 'dist'), join(serverDir, 'dist'), { recursive: true, preserveTimestamps: true })
  await mkdir(join(serverDir, 'database', 'data'), { recursive: true })
  await cp(join(root, 'database', 'migrations'), join(serverDir, 'database', 'migrations'), { recursive: true, preserveTimestamps: true })
  await cp(join(root, 'package.json'), join(serverDir, 'package.json'), { preserveTimestamps: true })
  const lt = process.platform === 'win32' ? 'junction' : 'dir'
  await symlink(join(root, 'node_modules'), join(serverDir, 'node_modules'), lt)
  await symlink(join(root, '..', 'node_modules'), join(tmp, 'node_modules'), lt)
  return {
    serverDir,
    dbFile: join(serverDir, 'database', 'data', 'belot-v2.sqlite'),
    cleanup: () => retryRm(tmp),
  }
}

type Srv = { child: ChildProcessWithoutNullStreams; output(): string }

function startSrv(serverDir: string, port: number): Srv {
  const chunks: string[] = []
  const child = spawn(
    process.execPath,
    [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'index.ts')],
    {
      cwd: serverDir,
      env: {
        ...process.env,
        PORT: String(port),
        PASSWORD_RESET_RATE_LIMIT_SECRET: TEST_REGISTRATION_SECRET,
        BELOT_GAME_WORKER_TICK_MODE: 'worker-candidate',
        BELOT_GAME_WORKER_COUNT: '1',
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

async function stopSrv(s: Srv): Promise<void> {
  if (s.child.exitCode !== null) return
  s.child.kill('SIGTERM')
  await new Promise<void>((r) => {
    const t = setTimeout(() => { s.child.kill('SIGKILL'); r() }, 10_000)
    s.child.once('exit', () => { clearTimeout(t); r() })
  })
}

async function httpJson(port: number, method: 'GET' | 'POST', pathname: string, cookie?: string, payload?: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: { ...(payload !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: payload !== undefined ? JSON.stringify(payload) : undefined,
  })
  let body: unknown = null
  try { body = await res.json() } catch { /* */ }
  return { status: res.status, body }
}

async function waitForServerReady(port: number): Promise<void> {
  await waitFor('server ready', async () => {
    try {
      const r = await httpJson(port, 'GET', '/health')
      const h = r.body as { ok?: boolean; gameWorkerPool?: { state?: string } | null }
      return r.status === 200 && h.ok === true && h.gameWorkerPool?.state === 'ready'
    } catch { return false }
  }, SERVER_READY_TIMEOUT_MS)
}

async function registerAndLogin(port: number, email: string, displayName: string): Promise<{ cookie: string; profileId: string }> {
  const regRes = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, displayName, gender: 'male', ...prepareDirectRegistration() }),
  })
  if (regRes.status !== 200) throw new Error(`Register ${email} failed: ${regRes.status}`)
  const loginRes = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  })
  const h = loginRes.headers as Headers & { getSetCookie?: () => string[] }
  const cookie = (h.getSetCookie?.()[0] ?? loginRes.headers.get('set-cookie'))?.split(';')[0]
  if (!cookie) throw new Error(`No Set-Cookie on login for ${email}`)
  const meRes = await httpJson(port, 'GET', '/api/auth/me', cookie)
  const profileId = (meRes.body as { session?: { profile?: { profileId?: string } } }).session?.profile?.profileId
  if (!profileId) throw new Error(`No profileId for ${email}`)
  return { cookie, profileId }
}

type AnyMsg = Record<string, unknown> & { type: string }
const wsMessageBuffers = new WeakMap<WebSocket, AnyMsg[]>()

function openWs(port: number, cookie?: string): Promise<WebSocket> {
  return new Promise((resolveWs, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, cookie ? { headers: { Cookie: cookie } } : undefined)
    const buffer: AnyMsg[] = []
    wsMessageBuffers.set(ws, buffer)
    ws.on('message', (raw: RawData) => {
      try { buffer.push(JSON.parse(raw.toString())) } catch { /* ignore */ }
    })
    const t = setTimeout(() => { ws.terminate(); reject(new Error('WS open timeout')) }, 5000)
    ws.once('open', () => { clearTimeout(t); resolveWs(ws) })
    ws.once('error', (err) => { clearTimeout(t); reject(err) })
  })
}

function sendWs(ws: WebSocket, message: Record<string, unknown>): void {
  ws.send(JSON.stringify(message))
}

async function waitForWsMessage(ws: WebSocket, predicate: (msg: AnyMsg) => boolean, timeoutMs = 5000): Promise<AnyMsg> {
  const buffer = wsMessageBuffers.get(ws)!
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const idx = buffer.findIndex(predicate)
    if (idx !== -1) return buffer.splice(idx, 1)[0]!
    if (Date.now() > deadline) throw new Error('Timeout waiting for WS message matching predicate')
    await sleep(20)
  }
}

function takeAll(ws: WebSocket, predicate: (msg: AnyMsg) => boolean): AnyMsg[] {
  const buffer = wsMessageBuffers.get(ws)!
  const taken: AnyMsg[] = []
  for (let i = buffer.length - 1; i >= 0; i--) {
    if (predicate(buffer[i]!)) taken.unshift(buffer.splice(i, 1)[0]!)
  }
  return taken
}

const likeChanged = (messageId: string, likeCount?: number) => (m: AnyMsg) =>
  m.type === 'topic_message_like_changed' && m.messageId === messageId && (likeCount === undefined || m.likeCount === likeCount)
const anyLikeChanged = (messageId: string) => (m: AnyMsg) =>
  (m.type === 'topic_message_like_changed' || m.type === 'topic_message_like_changed_self') && m.messageId === messageId

function openDb(file: string): DatabaseSync {
  const db = new DatabaseSync(file, { open: true, enableForeignKeyConstraints: true })
  db.exec('PRAGMA busy_timeout = 5000;')
  return db
}

function insertTopic(db: DatabaseSync, topicId: string, slug: string, title: string): void {
  db.prepare(`
    INSERT INTO topics (topic_id, slug, title, is_general, created_by_profile_id, status, sort_order, locked_until)
    VALUES (?, ?, ?, 0, NULL, 'active', 100, NULL);
  `).run(topicId, slug, title)
}

console.log('\n=== Topic message like poll — интеграция (2 процеса) ===\n')

const iso = await makeIsolated(serverRoot)
const portA = await getFreePort()
const portB = await getFreePort()
let srvA: Srv | null = null
let srvB: Srv | null = null
const sockets: WebSocket[] = []

try {
  srvA = startSrv(iso.serverDir, portA)
  await waitForServerReady(portA)
  srvB = startSrv(iso.serverDir, portB)
  await waitForServerReady(portB)
  configureDirectRegistrationForTest(iso.dbFile)
  console.log('  И двата процеса са готови.\n')

  const runId = `${Date.now()}-${process.pid}`
  const u1 = await registerAndLogin(portA, `tlp-1-${runId}@example.test`, 'LikePollOne')
  const u2 = await registerAndLogin(portA, `tlp-2-${runId}@example.test`, 'LikePollTwo')
  const u3 = await registerAndLogin(portA, `tlp-3-${runId}@example.test`, 'LikePollThree')
  const u4 = await registerAndLogin(portA, `tlp-4-${runId}@example.test`, 'LikePollFour')
  for (const u of [u1, u2]) {
    const r = await httpJson(portA, 'POST', '/api/vip/claim-launch-gift', u.cookie, {})
    if (r.status !== 200) throw new Error(`claim-launch-gift: ${r.status}`)
  }

  const T1 = 'topic-likepoll-1'
  const T2 = 'topic-likepoll-2'
  const setupDb = openDb(iso.dbFile)
  insertTopic(setupDb, T1, 'likepoll-1', 'Like poll 1')
  insertTopic(setupDb, T2, 'likepoll-2', 'Like poll 2')
  setupDb.close()

  const track = (ws: WebSocket) => { sockets.push(ws); return ws }
  const ws1 = track(await openWs(portA, u1.cookie))
  const ws2 = track(await openWs(portA, u2.cookie))
  let ws3 = track(await openWs(portA, u3.cookie))
  const wsB1 = track(await openWs(portB, u1.cookie))

  async function subscribe(ws: WebSocket, topicId: string, afterSeq: number): Promise<AnyMsg> {
    sendWs(ws, { type: 'subscribe_topic_messages', topicId, afterSeq })
    return waitForWsMessage(ws, (m) => m.type === 'topic_message_catchup' && m.topicId === topicId)
  }
  for (const ws of [ws1, ws2, ws3]) await subscribe(ws, T1, 0)

  // Съобщения, публикувани през B → A ги следи чрез cross-instance poll seed.
  // Ack-ът към изпращача идва само през broadcast към subscribers на темата.
  let wsB1TopicId: string | null = null
  async function postViaB(topicId: string, body: string): Promise<string> {
    if (wsB1TopicId !== topicId) {
      await subscribe(wsB1, topicId, 0)
      wsB1TopicId = topicId
    }
    const requestId = `req-${body.replace(/\s+/g, '-')}`
    sendWs(wsB1, { type: 'send_topic_message', topicId, body, requestId })
    const msg = await waitForWsMessage(wsB1, (m) => m.type === 'topic_message' && m.requestId === requestId)
    return msg.messageId as string
  }
  const M1 = await postViaB(T1, 'likepoll m1')
  const M2 = await postViaB(T1, 'likepoll m2')
  const M3 = await postViaB(T1, 'likepoll m3')
  const M4 = await postViaB(T2, 'likepoll m4')
  // A трябва да ги е видял (и seed-нал) — subscribers на T1 получават topic_message.
  for (const id of [M1, M2, M3]) await waitForWsMessage(ws1, (m) => m.type === 'topic_message' && m.messageId === id, 6000)
  await sleep(1500) // и M4 (T2, без subscribers на A) е минал през poll-а на A

  const db = openDb(iso.dbFile)
  const addLike = (messageId: string, profileId: string) =>
    db.prepare('INSERT INTO topic_message_likes (message_id, liker_profile_id) VALUES (?, ?)').run(messageId, profileId)
  const removeLike = (messageId: string, profileId: string) =>
    db.prepare('DELETE FROM topic_message_likes WHERE message_id = ? AND liker_profile_id = ?').run(messageId, profileId)
  const maxSeq = () => (db.prepare('SELECT MAX(seq) AS s FROM topic_messages').get() as { s: number }).s

  // ─── [1] ────────────────────────────────────────────────────────────────
  // Local toggle-ите са върху M3 (M1/M2 остават за out-of-band проверките,
  // без 15-секундния echo suppression прозорец).
  await check('[1] Like/unlike на A: subscribers получават count, без дублиран poll echo', async () => {
    sendWs(ws2, { type: 'toggle_topic_message_like', messageId: M3, requestId: 'l1' })
    const self1 = await waitForWsMessage(ws2, (m) => m.type === 'topic_message_like_changed_self' && m.requestId === 'l1')
    assertEqual(self1.likeCount, 1, 'self ack count')
    assertEqual(self1.viewerHasLiked, true, 'self ack viewerHasLiked')
    await waitForWsMessage(ws1, likeChanged(M3, 1))
    await waitForWsMessage(ws3, likeChanged(M3, 1))
    sendWs(ws2, { type: 'toggle_topic_message_like', messageId: M3, requestId: 'l2' })
    const self2 = await waitForWsMessage(ws2, (m) => m.type === 'topic_message_like_changed_self' && m.requestId === 'l2')
    assertEqual(self2.likeCount, 0, 'unlike count')
    assertEqual(self2.viewerHasLiked, false, 'unlike viewerHasLiked')
    await waitForWsMessage(ws1, likeChanged(M3, 0))
    await waitForWsMessage(ws3, likeChanged(M3, 0))
    takeAll(ws2, anyLikeChanged(M3))
    await sleep(NO_ECHO_WINDOW_MS)
    for (const ws of [ws1, ws2, ws3]) {
      const extra = takeAll(ws, anyLikeChanged(M3))
      assertEqual(extra.length, 0, 'poll-ът не трябва да дублира local broadcast-а')
    }
  })

  // ─── [2] ────────────────────────────────────────────────────────────────
  await check('[2] Различни потребители в една тема: count 2, public broadcast без identity', async () => {
    sendWs(ws1, { type: 'toggle_topic_message_like', messageId: M3, requestId: 'l3' })
    await waitForWsMessage(ws1, (m) => m.type === 'topic_message_like_changed_self' && m.requestId === 'l3')
    sendWs(ws3, { type: 'toggle_topic_message_like', messageId: M3, requestId: 'l4' })
    const self = await waitForWsMessage(ws3, (m) => m.type === 'topic_message_like_changed_self' && m.requestId === 'l4')
    assertEqual(self.likeCount, 2, 'count след два различни профила')
    const pub = await waitForWsMessage(ws2, likeChanged(M3, 2))
    assertEqual(Object.keys(pub).sort().join(','), 'likeCount,messageId,type', 'public broadcast ключове')
    for (const ws of [ws1, ws2, ws3]) takeAll(ws, anyLikeChanged(M3))
  })

  // ─── [3] ────────────────────────────────────────────────────────────────
  await check('[3] Out-of-band like → drift broadcast към всички subscribers на темата', async () => {
    addLike(M1, u4.profileId)
    for (const ws of [ws1, ws2, ws3]) await waitForWsMessage(ws, likeChanged(M1, 1), DRIFT_TIMEOUT_MS)
  })

  // ─── [4] ────────────────────────────────────────────────────────────────
  await check('[4] Затваряне на темата → не получава; повторно отваряне → получава отново', async () => {
    sendWs(ws3, { type: 'unsubscribe_topic_messages', topicId: T1 })
    await sleep(300)
    addLike(M1, u2.profileId)
    await waitForWsMessage(ws1, likeChanged(M1, 2), DRIFT_TIMEOUT_MS)
    await sleep(500)
    assertEqual(takeAll(ws3, anyLikeChanged(M1)).length, 0, 'затворената тема не трябва да получава')
    await subscribe(ws3, T1, maxSeq())
    addLike(M1, u3.profileId)
    await waitForWsMessage(ws3, likeChanged(M1, 3), DRIFT_TIMEOUT_MS)
    takeAll(ws1, anyLikeChanged(M1)); takeAll(ws2, anyLikeChanged(M1))
  })

  // ─── [5] ────────────────────────────────────────────────────────────────
  await check('[5] Reconnect (terminate + нов WS + subscribe с afterSeq) → получава drift', async () => {
    ws3.terminate()
    await sleep(500)
    ws3 = track(await openWs(portA, u3.cookie))
    const catchup = await subscribe(ws3, T1, maxSeq())
    assertEqual((catchup.messages as unknown[]).length, 0, 'catch-up след latest seq е празен (M1 не се seed-ва наново)')
    removeLike(M1, u3.profileId)
    await waitForWsMessage(ws3, likeChanged(M1, 2), DRIFT_TIMEOUT_MS)
    takeAll(ws1, anyLikeChanged(M1)); takeAll(ws2, anyLikeChanged(M1))
  })

  // ─── [6] ────────────────────────────────────────────────────────────────
  await check('[6] Смяна на тема: drift само към subscribers на съответната тема', async () => {
    await subscribe(ws3, T2, 0) // имплицитно напуска T1
    addLike(M1, u3.profileId)
    await waitForWsMessage(ws1, likeChanged(M1, 3), DRIFT_TIMEOUT_MS)
    await sleep(500)
    assertEqual(takeAll(ws3, anyLikeChanged(M1)).length, 0, 'ws3 вече е в T2')
    addLike(M4, u4.profileId)
    await waitForWsMessage(ws3, likeChanged(M4, 1), DRIFT_TIMEOUT_MS)
    await sleep(500)
    assertEqual(takeAll(ws1, anyLikeChanged(M4)).length, 0, 'ws1 не е в T2')
    takeAll(ws2, anyLikeChanged(M1))
  })

  // ─── [7] ────────────────────────────────────────────────────────────────
  await check('[7] Toggle след drift: viewerHasLiked/count коректни', async () => {
    // u2 е харесал M1 out-of-band в [4] → toggle го маха.
    sendWs(ws2, { type: 'toggle_topic_message_like', messageId: M1, requestId: 'l5' })
    const self = await waitForWsMessage(ws2, (m) => m.type === 'topic_message_like_changed_self' && m.requestId === 'l5')
    assertEqual(self.viewerHasLiked, false, 'viewerHasLiked след unlike')
    assertEqual(self.likeCount, 2, 'count след unlike (u4 + u3)')
    await waitForWsMessage(ws1, likeChanged(M1, 2))
  })

  // ─── [8] ────────────────────────────────────────────────────────────────
  await check('[8] Hard delete на харесано съобщение → без broadcast, poll-ът продължава', async () => {
    addLike(M2, u4.profileId)
    await waitForWsMessage(ws1, likeChanged(M2, 1), DRIFT_TIMEOUT_MS)
    takeAll(ws2, anyLikeChanged(M2))
    db.exec('BEGIN')
    db.prepare('DELETE FROM topic_message_likes WHERE message_id = ?').run(M2)
    db.prepare('DELETE FROM topic_messages WHERE message_id = ?').run(M2)
    db.exec('COMMIT')
    await sleep(NO_ECHO_WINDOW_MS)
    assertEqual(takeAll(ws1, anyLikeChanged(M2)).length + takeAll(ws2, anyLikeChanged(M2)).length, 0, 'няма broadcast за изтрито съобщение')
    addLike(M1, u2.profileId)
    await waitForWsMessage(ws1, likeChanged(M1, 3), DRIFT_TIMEOUT_MS)
    takeAll(ws2, anyLikeChanged(M1))
  })

  // ─── [9] ────────────────────────────────────────────────────────────────
  await check('[9] Непрочетени отговори / „Нови отговори“: likes не променят unreadCount', async () => {
    const G = 'topic-general'
    await subscribe(ws1, G, 0)
    await subscribe(ws2, G, 0) // ack към изпращача идва само през broadcast към subscribers
    sendWs(ws1, { type: 'send_topic_message', topicId: G, body: 'likepoll general root', requestId: 'g-root' })
    const root = await waitForWsMessage(ws1, (m) => m.type === 'topic_message' && m.requestId === 'g-root')
    const rootId = root.messageId as string
    const replyIds: string[] = []
    for (const n of [1, 2]) {
      sendWs(ws2, { type: 'send_topic_reply', topicId: G, parentMessageId: rootId, body: `likepoll reply ${n}`, requestId: `g-r${n}` })
      const ack = await waitForWsMessage(ws2, (m) => m.type === 'topic_reply' && m.requestId === `g-r${n}`)
      replyIds.push(ack.messageId as string)
    }
    const unreadFor = async (): Promise<number> => {
      const c = await subscribe(ws3, G, 0)
      const found = (c.messages as Array<{ messageId: string; unreadCount: number }>).find((m) => m.messageId === rootId)
      assert(found !== undefined, 'root-ът трябва да е в catch-up')
      return found!.unreadCount
    }
    const before = await unreadFor()
    assert(before > 0, `u3 трябва да има непрочетени в нишката (получено ${before})`)
    sendWs(ws1, { type: 'toggle_topic_message_like', messageId: replyIds[0], requestId: 'g-l1' })
    await waitForWsMessage(ws1, (m) => m.type === 'topic_message_like_changed_self' && m.requestId === 'g-l1')
    addLike(rootId, u4.profileId)
    addLike(replyIds[1]!, u4.profileId)
    await waitForWsMessage(ws3, likeChanged(rootId, 1), DRIFT_TIMEOUT_MS)
    assertEqual(await unreadFor(), before, 'likes не променят непрочетените')
    const seen = await httpJson(portA, 'POST', `/api/topics/${G}/messages/${rootId}/seen`, u3.cookie, {})
    assertEqual(seen.status, 200, 'mark seen')
    assertEqual((seen.body as { unreadCount: number }).unreadCount, 0, 'unread след прочитане')
    removeLike(rootId, u4.profileId)
    await waitForWsMessage(ws3, likeChanged(rootId, 0), DRIFT_TIMEOUT_MS)
    assertEqual(await unreadFor(), 0, 'прочетеното остава прочетено след likes')
  })

  // ─── [10] ───────────────────────────────────────────────────────────────
  await check('[10] Cross-instance: like на A стига до subscriber на B (catch-up seed)', async () => {
    const wsB2 = track(await openWs(portB, u2.cookie))
    await subscribe(wsB2, T1, 0) // catch-up seed-ва M1/M3 на B
    sendWs(ws1, { type: 'toggle_topic_message_like', messageId: M1, requestId: 'x1' })
    const self = await waitForWsMessage(ws1, (m) => m.type === 'topic_message_like_changed_self' && m.requestId === 'x1')
    await waitForWsMessage(wsB2, likeChanged(M1, self.likeCount as number), DRIFT_TIMEOUT_MS)
  })

  db.close()

  await check('[11] Без „like drift-detection poll failed“ в логовете на двата процеса', () => {
    for (const [name, s] of [['A', srvA!], ['B', srvB!]] as const) {
      assert(!s.output().includes('like drift-detection poll failed'), `процес ${name} е логнал грешка в poll-а`)
    }
  })
} finally {
  for (const ws of sockets) { try { ws.terminate() } catch { /* */ } }
  if (srvA) await stopSrv(srvA)
  if (srvB) await stopSrv(srvB)
  await iso.cleanup()
}

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
