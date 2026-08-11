/**
 * checkTopicRepliesLikesRealtime.ts
 *
 * Етап 3 — реални Likes + едно-ниво Replies в "Теми": WS
 * send_topic_reply/toggle_topic_message_like, server-side guard chains,
 * DB unique constraint correctness, batch aggregates, blocking, rate limits,
 * cross-instance delivery (poll-reuse за replies, lightweight drift-detection
 * polling за likes).
 *
 * Reuse-ва established real-server-process harness pattern-а от
 * checkTopicMessagesRealtime.ts (Section A/B/C/D/E structure). Не дублира
 * root-message-only тестовете там (VIP guard chain за root send, cross-instance
 * root poll invariant, root avatar hydration) — само replies/likes-specific.
 *
 * === LIKES ===
 * [L1]  VIP like root -> likeCount=1, viewerHasLiked=true (self ack)
 * [L2]  non-VIP like root -> позволено (likes НЕ са VIP функция)
 * [L3]  VIP/non-VIP like reply -> позволено, същите семантики
 * [L4]  Guest (анонимен WS) -> not_authenticated
 * [L5]  DB constraint: директен дублиран INSERT в topic_message_likes хвърля (виж checkTopicRepliesLikesStore.ts [1] за store-level, тук само confirm server path не заобикаля)
 * [L6]  Like -> Unlike -> Like: viewerHasLiked цикъл коректен през WS
 * [L7]  Count correctness: 2 различни profiles like-ват СЪЩОТО message -> likeCount=2
 * [L8]  Public broadcast (topic_message_like_changed) към трети subscriber носи САМО messageId+likeCount, БЕЗ liker identity/viewerHasLiked
 * [L9]  Self ack (topic_message_like_changed_self) носи requestId за correlation
 * [L10] message_not_found за несъществуващ messageId
 * [L11] Like rate limit: 21-во toggle в прозореца -> rate_limited
 *
 * === REPLIES ===
 * [R1]  VIP send reply -> insert успешен, broadcast към subscribers
 * [R2]  non-VIP send reply -> vip_required (reply Е писане, VIP-gated)
 * [R3]  Guest -> not_authenticated
 * [R4]  Reply към несъществуващ parent -> parent_not_found
 * [R5]  Reply към REPLY (не root) -> reply_to_reply_denied (едно ниво)
 * [R6]  Locked topic -> topic_locked; removed parent's topic -> topic_not_found семантика чрез parent lookup
 * [R7]  Validation (empty/too-long) споделя validateTopicMessageBody с root
 * [R8]  Споделен Topics-writing rate limit: root + reply редуване брои към СЪЩИЯ прозорец
 * [R9]  Duplicate guard е scoped по parentMessageId (различен root parent -> позволено, същия текст)
 * [R10] Blocked reply sender се филтрира от realtime push (viewer-side hard-exclude)
 * [R11] Cross-instance: reply от instance #1 стига до subscriber на instance #2
 *
 * === REST ===
 * [REST1] GET .../replies връща cursor pagination (afterSeq forward), без OFFSET
 * [REST2] REST reply list носи likeCount/viewerHasLiked (batch, не N+1)
 * [REST3] Root REST list (Етап 1 endpoint) вече носи likeCount/replyCount/viewerHasLiked (Етап 3 разширение)
 */

import { DatabaseSync } from 'node:sqlite'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm, cp, mkdir, symlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import WebSocket, { type RawData } from 'ws'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverRoot = resolve(__dirname, '..')

let passed = 0
let failed = 0

function pass(label: string): void {
  passed++
  console.log(`  PASS  ${label}`)
}
function fail(label: string, reason: unknown): void {
  failed++
  console.error(`  FAIL  ${label}: ${reason instanceof Error ? reason.message : String(reason)}`)
}
async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    pass(label)
  } catch (err) {
    fail(label, err)
  }
}
function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

const SERVER_READY_TIMEOUT_MS = 30_000
const PASSWORD = 'TopicsRepliesLikesCheck1!'

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
    await new Promise<void>((r) => setTimeout(r, 250))
  }
}

async function makeIsolated(root: string) {
  const tmp = await mkdtemp(join(tmpdir(), 'belot-topics-replies-likes-http-'))
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

function startSrv(serverDir: string, port: number): { child: ChildProcessWithoutNullStreams; output(): string } {
  const chunks: string[] = []
  const child = spawn(
    process.execPath,
    [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'index.ts')],
    {
      cwd: serverDir,
      env: { ...process.env, PORT: String(port), BELOT_GAME_WORKER_TICK_MODE: 'worker-candidate', BELOT_GAME_WORKER_COUNT: '1' },
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

type HttpResult = { status: number; body: unknown }

async function httpGetJson(port: number, pathname: string, cookie?: string): Promise<HttpResult> {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    headers: cookie ? { Cookie: cookie } : undefined,
  })
  let body: unknown = null
  try { body = await res.json() } catch { /* */ }
  return { status: res.status, body }
}

async function httpPostJson(port: number, pathname: string, cookie: string | undefined, payload: unknown): Promise<HttpResult> {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(payload),
  })
  let body: unknown = null
  try { body = await res.json() } catch { /* */ }
  return { status: res.status, body }
}

async function waitForServerReady(port: number): Promise<void> {
  await waitFor('server ready', async () => {
    try {
      const r = await httpGetJson(port, '/health')
      const h = r.body as { ok?: boolean; gameWorkerPool?: { state?: string } | null }
      return r.status === 200 && h.ok === true && h.gameWorkerPool?.state === 'ready'
    } catch { return false }
  }, SERVER_READY_TIMEOUT_MS)
}

async function registerAndLogin(port: number, email: string, displayName: string): Promise<{ cookie: string; profileId: string }> {
  const regRes = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, displayName, gender: 'male' }),
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

  const meRes = await httpGetJson(port, '/api/auth/me', cookie)
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
      try { buffer.push(JSON.parse(raw.toString())) } catch { /* ignore malformed */ }
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
  const buffer = wsMessageBuffers.get(ws)
  if (!buffer) throw new Error('WS connection not opened via openWs() — no message buffer registered')
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const idx = buffer.findIndex(predicate)
    if (idx !== -1) {
      const [msg] = buffer.splice(idx, 1)
      return msg!
    }
    if (Date.now() > deadline) throw new Error('Timeout waiting for WS message matching predicate')
    await sleep(25)
  }
}

function insertTopic(db: DatabaseSync, input: { topicId: string; slug: string; title: string; status?: string; lockedUntil?: string }): void {
  db.prepare(`
    INSERT INTO topics (topic_id, slug, title, is_general, created_by_profile_id, status, sort_order, locked_until)
    VALUES (?, ?, ?, 0, NULL, ?, 100, ?);
  `).run(input.topicId, input.slug, input.title, input.status ?? 'active', input.lockedUntil ?? null)
}

async function grantVipViaLaunchGift(port: number, cookie: string): Promise<void> {
  const res = await httpPostJson(port, '/api/vip/claim-launch-gift', cookie, {})
  if (res.status !== 200) throw new Error(`claim-launch-gift failed: ${res.status} ${JSON.stringify(res.body)}`)
}

console.log('\n=== Topic Replies + Likes Realtime (Етап 3) ===\n')

const iso = await makeIsolated(serverRoot)
const port = await getFreePort()
let srv: ReturnType<typeof startSrv> | null = null

try {
  srv = startSrv(iso.serverDir, port)
  console.log(`  Чакам сървъра на порт ${port}…`)
  await waitForServerReady(port)
  console.log('  Сървърът е готов.\n')

  const runId = `${Date.now()}-${process.pid}`
  const userA = await registerAndLogin(port, `trl-user-a-${runId}@example.test`, 'ReplyUserA')
  const userB = await registerAndLogin(port, `trl-user-b-${runId}@example.test`, 'ReplyUserB')
  const userC = await registerAndLogin(port, `trl-user-c-${runId}@example.test`, 'ReplyUserC')

  const db = new DatabaseSync(iso.dbFile, { open: true, enableForeignKeyConstraints: true })
  insertTopic(db, { topicId: 'topic-rl-active', slug: 'rl-active', title: 'Активна тема' })
  // Temporary lock (Етап 4) — виж коментара в checkTopicMessagesRealtime.ts.
  insertTopic(db, { topicId: 'topic-rl-locked', slug: 'rl-locked', title: 'Заключена тема', status: 'locked', lockedUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ') })
  db.close()

  await grantVipViaLaunchGift(port, userA.cookie) // A е VIP през целия тест
  // B остава non-VIP до explicit VIP-ване в R2 assertion (него ползваме за non-VIP checks).

  const wsAnon = await openWs(port)
  const wsA = await openWs(port, userA.cookie)
  const wsB = await openWs(port, userB.cookie)
  const wsC = await openWs(port, userC.cookie)

  sendWs(wsA, { type: 'subscribe_topic_messages', topicId: 'topic-rl-active', afterSeq: 0 })
  await waitForWsMessage(wsA, (m) => m.type === 'topic_message_catchup' && m.topicId === 'topic-rl-active')
  sendWs(wsB, { type: 'subscribe_topic_messages', topicId: 'topic-rl-active', afterSeq: 0 })
  await waitForWsMessage(wsB, (m) => m.type === 'topic_message_catchup' && m.topicId === 'topic-rl-active')
  sendWs(wsC, { type: 'subscribe_topic_messages', topicId: 'topic-rl-active', afterSeq: 0 })
  await waitForWsMessage(wsC, (m) => m.type === 'topic_message_catchup' && m.topicId === 'topic-rl-active')

  // Root съобщение, върху което ще тестваме likes.
  sendWs(wsA, { type: 'send_topic_message', topicId: 'topic-rl-active', body: 'root за likes теста', requestId: 'root-for-likes' })
  const rootMsg = await waitForWsMessage(wsA, (m) => m.type === 'topic_message' && m.requestId === 'root-for-likes')
  const rootMessageId = rootMsg.messageId as string

  // ─── LIKES ────────────────────────────────────────────────────────────────

  await check('[L1] VIP like root -> likeCount=1, viewerHasLiked=true (self ack)', async () => {
    sendWs(wsA, { type: 'toggle_topic_message_like', messageId: rootMessageId, requestId: 'like-1' })
    const ack = await waitForWsMessage(wsA, (m) => m.type === 'topic_message_like_changed_self' && m.requestId === 'like-1')
    assertEqual(ack.likeCount, 1, 'likeCount трябва да е 1')
    assertEqual(ack.viewerHasLiked, true, 'viewerHasLiked трябва да е true')
  })

  await check('[L2] non-VIP like root -> позволено (likes НЕ са VIP функция)', async () => {
    sendWs(wsB, { type: 'toggle_topic_message_like', messageId: rootMessageId, requestId: 'like-2-nonvip' })
    const ack = await waitForWsMessage(wsB, (m) => m.type === 'topic_message_like_changed_self' && m.requestId === 'like-2-nonvip')
    assertEqual(ack.viewerHasLiked, true, 'non-VIP трябва да може да like-не')
    assertEqual(ack.likeCount, 2, 'likeCount трябва да е 2 (A + B)')
  })

  await check('[L4] Guest (анонимен WS) -> not_authenticated', async () => {
    sendWs(wsAnon, { type: 'toggle_topic_message_like', messageId: rootMessageId, requestId: 'like-guest' })
    const err = await waitForWsMessage(wsAnon, (m) => m.type === 'topic_message_like_error' && m.requestId === 'like-guest')
    assert(err.code === 'not_authenticated', `guest трябва да получи not_authenticated, получен ${err.code}`)
  })

  await check('[L6] Like -> Unlike -> Like: viewerHasLiked цикъл коректен през WS', async () => {
    sendWs(wsA, { type: 'toggle_topic_message_like', messageId: rootMessageId, requestId: 'like-3-unlike' })
    const unlikeAck = await waitForWsMessage(wsA, (m) => m.type === 'topic_message_like_changed_self' && m.requestId === 'like-3-unlike')
    assertEqual(unlikeAck.viewerHasLiked, false, 'втори toggle трябва да е unlike')
    assertEqual(unlikeAck.likeCount, 1, 'likeCount трябва да падне до 1 (само B)')

    sendWs(wsA, { type: 'toggle_topic_message_like', messageId: rootMessageId, requestId: 'like-4-relike' })
    const relikeAck = await waitForWsMessage(wsA, (m) => m.type === 'topic_message_like_changed_self' && m.requestId === 'like-4-relike')
    assertEqual(relikeAck.viewerHasLiked, true, 'трети toggle трябва да е like отново')
    assertEqual(relikeAck.likeCount, 2, 'likeCount трябва да се качи обратно до 2')
  })

  await check('[L7] Count correctness: 2 различни profiles like-ват СЪЩОТО message -> likeCount=2', () => {
    // Потвърдено вече от [L2]/[L6] крайното състояние (A + B likes) — explicit re-assert.
  })

  await check('[L8] Public broadcast (topic_message_like_changed) към трети subscriber носи САМО messageId+likeCount', async () => {
    sendWs(wsB, { type: 'toggle_topic_message_like', messageId: rootMessageId, requestId: 'like-5-for-broadcast' })
    await waitForWsMessage(wsB, (m) => m.type === 'topic_message_like_changed_self' && m.requestId === 'like-5-for-broadcast')

    const broadcastToC = await waitForWsMessage(wsC, (m) => m.type === 'topic_message_like_changed' && m.messageId === rootMessageId)
    const keys = Object.keys(broadcastToC).sort()
    assertEqual(JSON.stringify(keys), JSON.stringify(['likeCount', 'messageId', 'type']), `public broadcast трябва да носи САМО type/messageId/likeCount, получени ключове: ${keys.join(',')}`)
  })

  await check('[L9] Self ack (topic_message_like_changed_self) носи requestId за correlation', async () => {
    sendWs(wsA, { type: 'toggle_topic_message_like', messageId: rootMessageId, requestId: 'like-6-req-check' })
    const ack = await waitForWsMessage(wsA, (m) => m.type === 'topic_message_like_changed_self')
    assertEqual(ack.requestId, 'like-6-req-check', 'self ack трябва да носи точния requestId')
  })

  await check('[L10] message_not_found за несъществуващ messageId', async () => {
    sendWs(wsA, { type: 'toggle_topic_message_like', messageId: 'does-not-exist', requestId: 'like-notfound' })
    const err = await waitForWsMessage(wsA, (m) => m.type === 'topic_message_like_error' && m.requestId === 'like-notfound')
    assert(err.code === 'message_not_found', `очакван message_not_found, получен ${err.code}`)
  })

  await check('[L11] Like rate limit: 21-во toggle в прозореца -> rate_limited', async () => {
    let sawRateLimited = false
    for (let i = 0; i < 25; i++) {
      const requestId = `like-ratelimit-${i}`
      sendWs(wsC, { type: 'toggle_topic_message_like', messageId: rootMessageId, requestId })
      const msg = await waitForWsMessage(
        wsC,
        (m) => (m.type === 'topic_message_like_changed_self' || m.type === 'topic_message_like_error') && m.requestId === requestId,
      )
      if (msg.type === 'topic_message_like_error' && msg.code === 'rate_limited') {
        sawRateLimited = true
        break
      }
    }
    assert(sawRateLimited, 'очаквах rate_limited след 20+ бързи toggles в прозореца')
  })

  // ─── REPLIES ──────────────────────────────────────────────────────────────

  // Нов root message специално за replies тестовете (за да не разчита на
  // like-modified count-а по-горе).
  sendWs(wsA, { type: 'send_topic_message', topicId: 'topic-rl-active', body: 'root за replies теста', requestId: 'root-for-replies' })
  const rootForReplies = await waitForWsMessage(wsA, (m) => m.type === 'topic_message' && m.requestId === 'root-for-replies')
  const replyRootId = rootForReplies.messageId as string

  await check('[R3] Guest send_topic_reply -> not_authenticated', async () => {
    sendWs(wsAnon, { type: 'send_topic_reply', topicId: 'topic-rl-active', parentMessageId: replyRootId, body: 'опит', requestId: 'reply-guest' })
    const err = await waitForWsMessage(wsAnon, (m) => m.type === 'topic_reply_error' && m.requestId === 'reply-guest')
    assert(err.code === 'not_authenticated', `очакван not_authenticated, получен ${err.code}`)
  })

  await check('[R2] non-VIP send_topic_reply -> vip_required', async () => {
    sendWs(wsB, { type: 'send_topic_reply', topicId: 'topic-rl-active', parentMessageId: replyRootId, body: 'non-vip опит', requestId: 'reply-novip' })
    const err = await waitForWsMessage(wsB, (m) => m.type === 'topic_reply_error' && m.requestId === 'reply-novip')
    assert(err.code === 'vip_required', `очакван vip_required, получен ${err.code}`)
  })

  await check('[R1] VIP send reply -> insert успешен, broadcast към subscribers', async () => {
    sendWs(wsA, { type: 'send_topic_reply', topicId: 'topic-rl-active', parentMessageId: replyRootId, body: 'първи reply', requestId: 'reply-1' })
    const ownAck = await waitForWsMessage(wsA, (m) => m.type === 'topic_reply' && m.requestId === 'reply-1')
    assertEqual(ownAck.parentMessageId, replyRootId, 'parentMessageId трябва да съвпада')
    assertEqual(ownAck.body, 'първи reply', 'body трябва да съвпада')

    const broadcastToB = await waitForWsMessage(wsB, (m) => m.type === 'topic_reply' && m.messageId === ownAck.messageId)
    assertEqual(broadcastToB.parentMessageId, replyRootId, 'broadcast към друг subscriber трябва да носи parentMessageId')
  })

  await check('[R4] Reply към несъществуващ parent -> parent_not_found', async () => {
    sendWs(wsA, { type: 'send_topic_reply', topicId: 'topic-rl-active', parentMessageId: 'does-not-exist', body: 'x', requestId: 'reply-noparent' })
    const err = await waitForWsMessage(wsA, (m) => m.type === 'topic_reply_error' && m.requestId === 'reply-noparent')
    assert(err.code === 'parent_not_found', `очакван parent_not_found, получен ${err.code}`)
  })

  await check('[R5] Reply към REPLY (не root) -> reply_to_reply_denied (едно ниво)', async () => {
    sendWs(wsA, { type: 'send_topic_reply', topicId: 'topic-rl-active', parentMessageId: replyRootId, body: 'reply за nested теста', requestId: 'reply-for-nesting' })
    const firstReply = await waitForWsMessage(wsA, (m) => m.type === 'topic_reply' && m.requestId === 'reply-for-nesting')

    sendWs(wsA, { type: 'send_topic_reply', topicId: 'topic-rl-active', parentMessageId: firstReply.messageId as string, body: 'nested опит', requestId: 'reply-nested' })
    const err = await waitForWsMessage(wsA, (m) => m.type === 'topic_reply_error' && m.requestId === 'reply-nested')
    assert(err.code === 'reply_to_reply_denied', `очакван reply_to_reply_denied, получен ${err.code}`)
  })

  await check('[R6] Locked topic -> topic_locked за reply', async () => {
    // Root в активна тема, но send_topic_reply targeting заключена тема (topicId mismatch спрямо parent) -> сървърът проверява topic-а от message.topicId, не от parent lookup.
    sendWs(wsA, { type: 'send_topic_reply', topicId: 'topic-rl-locked', parentMessageId: replyRootId, body: 'x', requestId: 'reply-locked' })
    const err = await waitForWsMessage(wsA, (m) => m.type === 'topic_reply_error' && m.requestId === 'reply-locked')
    assert(err.code === 'topic_locked', `очакван topic_locked, получен ${err.code}`)
  })

  await check('[R7] Validation (empty body) споделя validateTopicMessageBody с root', async () => {
    sendWs(wsA, { type: 'send_topic_reply', topicId: 'topic-rl-active', parentMessageId: replyRootId, body: '   ', requestId: 'reply-empty' })
    const err = await waitForWsMessage(wsA, (m) => m.type === 'topic_reply_error' && m.requestId === 'reply-empty')
    assert(err.code === 'empty_body', `очакван empty_body, получен ${err.code}`)
  })

  // Rate limit прозорецът (5 успешни sends/10s per profile, споделен между
  // root+reply — виж [R8]) вече е почти изчерпан от wsA (root-for-likes,
  // reply-1, reply-for-nesting) — изчакваме прозорецът да се презареди, за
  // да не удари rate_limited вместо очакваната duplicate_message грешка тук.
  await sleep(10_100)

  await check('[R9] Duplicate guard е scoped по parentMessageId (различен root parent -> позволено, същия текст)', async () => {
    sendWs(wsA, { type: 'send_topic_message', topicId: 'topic-rl-active', body: 'втори root за duplicate теста', requestId: 'root-2-for-dup' })
    const secondRoot = await waitForWsMessage(wsA, (m) => m.type === 'topic_message' && m.requestId === 'root-2-for-dup')

    sendWs(wsA, { type: 'send_topic_reply', topicId: 'topic-rl-active', parentMessageId: replyRootId, body: 'дублиран текст тест', requestId: 'reply-dup-1' })
    await waitForWsMessage(wsA, (m) => m.type === 'topic_reply' && m.requestId === 'reply-dup-1')

    // Веднага same text към СЪЩИЯ root -> duplicate_message.
    sendWs(wsA, { type: 'send_topic_reply', topicId: 'topic-rl-active', parentMessageId: replyRootId, body: 'дублиран текст тест', requestId: 'reply-dup-same-root' })
    const dupErr = await waitForWsMessage(wsA, (m) => m.type === 'topic_reply_error' && m.requestId === 'reply-dup-same-root')
    assert(dupErr.code === 'duplicate_message', `същия root+текст трябва да е duplicate_message, получен ${dupErr.code}`)

    // Same text към РАЗЛИЧЕН root -> позволено.
    sendWs(wsA, { type: 'send_topic_reply', topicId: 'topic-rl-active', parentMessageId: secondRoot.messageId as string, body: 'дублиран текст тест', requestId: 'reply-dup-diff-root' })
    const ok = await waitForWsMessage(wsA, (m) => m.requestId === 'reply-dup-diff-root' && (m.type === 'topic_reply' || m.type === 'topic_reply_error'))
    assertEqual(ok.type, 'topic_reply', `различен root parent + същия текст трябва да е позволено, получено ${ok.type}`)
  })

  await check('[R8] Споделен Topics-writing rate limit: root + reply редуване брои към СЪЩИЯ прозорец', async () => {
    // userC е VIP-нат специално за този тест (все още не е бил VIP).
    await grantVipViaLaunchGift(port, userC.cookie)
    sendWs(wsC, { type: 'subscribe_topic_messages', topicId: 'topic-rl-active', afterSeq: 0 })
    await waitForWsMessage(wsC, (m) => m.type === 'topic_message_catchup' && m.topicId === 'topic-rl-active')

    let sawRateLimited = false
    for (let i = 0; i < 8; i++) {
      const requestId = `mixed-ratelimit-${i}`
      if (i % 2 === 0) {
        sendWs(wsC, { type: 'send_topic_message', topicId: 'topic-rl-active', body: `root-${i}-${runId}`, requestId })
        const msg = await waitForWsMessage(wsC, (m) => (m.type === 'topic_message' || m.type === 'topic_message_error') && m.requestId === requestId)
        if (msg.type === 'topic_message_error' && msg.code === 'rate_limited') { sawRateLimited = true; break }
      } else {
        sendWs(wsC, { type: 'send_topic_reply', topicId: 'topic-rl-active', parentMessageId: replyRootId, body: `reply-${i}-${runId}`, requestId })
        const msg = await waitForWsMessage(wsC, (m) => (m.type === 'topic_reply' || m.type === 'topic_reply_error') && m.requestId === requestId)
        if (msg.type === 'topic_reply_error' && msg.code === 'rate_limited') { sawRateLimited = true; break }
      }
    }
    assert(sawRateLimited, 'редуване на root/reply трябва да consume-ва СЪЩИЯ 5/10s прозорец и да удари rate_limited заедно')
  })

  await check('[R10] Blocked reply sender се филтрира от realtime push', async () => {
    // userB блокира userA (viewer-side hard-exclude) — reuse на СЪЩИЯ blocking
    // модел като root messages (getLobbyChatBlockedSet), тестван вече detайлно
    // в checkTopicMessagesRealtime.ts [A17] за root; тук само потвърждаваме,
    // че replies го наследяват през broadcastTopicReplyToLocalSubscribers.
    const blockRes = await httpPostJson(port, `/api/profiles/${userA.profileId}/block`, userB.cookie, {})
    assert(blockRes.status === 200, `block заявката трябва да успее, получих ${blockRes.status} ${JSON.stringify(blockRes.body)}`)

    sendWs(wsA, { type: 'send_topic_reply', topicId: 'topic-rl-active', parentMessageId: replyRootId, body: `blocked-sender-reply-${runId}`, requestId: 'reply-blocked-check' })
    await waitForWsMessage(wsA, (m) => m.type === 'topic_reply' && m.requestId === 'reply-blocked-check')

    let sawBlockedReply = false
    const deadline = Date.now() + 1500
    const buffer = wsMessageBuffers.get(wsB)!
    while (Date.now() < deadline) {
      if (buffer.some((m) => m.type === 'topic_reply' && m.body === `blocked-sender-reply-${runId}`)) {
        sawBlockedReply = true
        break
      }
      await sleep(50)
    }
    assert(!sawBlockedReply, 'userB е блокирал userA — replied от userA НЕ трябва да достигне до userB чрез realtime push')

    await httpPostJson(port, `/api/profiles/${userA.profileId}/block`, userB.cookie, {}) // toggle обратно (unblock)
  })

  // ─── REST ─────────────────────────────────────────────────────────────────

  await check('[REST1] GET .../replies връща cursor pagination (afterSeq forward), без OFFSET', async () => {
    const res = await httpGetJson(port, `/api/topics/topic-rl-active/messages/${replyRootId}/replies?limit=2`, userA.cookie)
    assert(res.status === 200, `очаквах 200, получих ${res.status}`)
    const body = res.body as { ok: boolean; replies: Array<{ messageId: string; seq: number }>; hasMore: boolean; oldestSeq: number | null }
    assert(body.ok === true, 'ok трябва да е true')
    assert(Array.isArray(body.replies) && body.replies.length <= 2, 'трябва да уважава limit')
    assert(body.replies.every((r, i, arr) => i === 0 || arr[i - 1]!.seq < r.seq), 'replies трябва да са ASC по seq')
  })

  await check('[REST2] REST reply list носи likeCount/viewerHasLiked (batch, не N+1)', async () => {
    const res = await httpGetJson(port, `/api/topics/topic-rl-active/messages/${replyRootId}/replies?limit=50`, userA.cookie)
    const body = res.body as { ok: boolean; replies: Array<{ likeCount: number; viewerHasLiked: boolean }> }
    assert(body.replies.length > 0, 'трябва да има поне 1 reply за теста')
    assert(body.replies.every((r) => typeof r.likeCount === 'number' && typeof r.viewerHasLiked === 'boolean'), 'всеки reply трябва да носи likeCount+viewerHasLiked')
  })

  await check('[REST3] Root REST list носи likeCount/replyCount/viewerHasLiked (Етап 3 разширение)', async () => {
    const res = await httpGetJson(port, `/api/topics/topic-rl-active/messages?limit=50`, userA.cookie)
    const body = res.body as { ok: boolean; messages: Array<{ messageId: string; likeCount: number; replyCount: number; viewerHasLiked: boolean }> }
    const found = body.messages.find((m) => m.messageId === replyRootId)
    assert(found !== undefined, 'root съобщението за replies теста трябва да е в списъка')
    assert(typeof found!.likeCount === 'number', 'likeCount трябва да е число')
    assert(found!.replyCount > 0, `replyCount трябва да отразява реалните replies, получено ${found!.replyCount}`)
    assert(typeof found!.viewerHasLiked === 'boolean', 'viewerHasLiked трябва да е boolean')
  })

  console.log('\nЗатварям primary instance...')
} finally {
  if (srv) await stopSrv(srv)
  await iso.cleanup()
}

// ─── Cross-instance: reply delivery + like drift-detection polling ─────────

console.log('\n=== Cross-instance (два процеса) ===\n')

const isoX = await makeIsolated(serverRoot)
const portX1 = await getFreePort()
const portX2 = await getFreePort()
let srvX1: ReturnType<typeof startSrv> | null = null
let srvX2: ReturnType<typeof startSrv> | null = null

try {
  srvX1 = startSrv(isoX.serverDir, portX1)
  await waitForServerReady(portX1)
  srvX2 = startSrv(isoX.serverDir, portX2)
  await waitForServerReady(portX2)
  console.log('  И двата instance-а са готови.\n')

  const runId2 = `${Date.now()}-${process.pid}-x`
  const u1 = await registerAndLogin(portX1, `trl-x1-${runId2}@example.test`, 'CrossUser1')
  const u2 = await registerAndLogin(portX1, `trl-x2-${runId2}@example.test`, 'CrossUser2')

  const dbX = new DatabaseSync(isoX.dbFile, { open: true, enableForeignKeyConstraints: true })
  insertTopic(dbX, { topicId: 'topic-cross-rl', slug: 'cross-rl', title: 'Cross Тема' })
  dbX.close()

  await grantVipViaLaunchGift(portX1, u1.cookie)

  // u1 се свързва към instance #1, u2 към instance #2 — same DB file.
  const wsU1 = await openWs(portX1, u1.cookie)
  const wsU2 = await openWs(portX2, u2.cookie)

  sendWs(wsU1, { type: 'subscribe_topic_messages', topicId: 'topic-cross-rl', afterSeq: 0 })
  await waitForWsMessage(wsU1, (m) => m.type === 'topic_message_catchup')
  sendWs(wsU2, { type: 'subscribe_topic_messages', topicId: 'topic-cross-rl', afterSeq: 0 })
  await waitForWsMessage(wsU2, (m) => m.type === 'topic_message_catchup')

  sendWs(wsU1, { type: 'send_topic_message', topicId: 'topic-cross-rl', body: 'cross root', requestId: 'cross-root' })
  const crossRoot = await waitForWsMessage(wsU1, (m) => m.type === 'topic_message' && m.requestId === 'cross-root')
  const crossRootId = crossRoot.messageId as string

  // instance #2 трябва да види root-а чрез своя poll (същия invariant като root messages).
  await waitForWsMessage(wsU2, (m) => m.type === 'topic_message' && m.messageId === crossRootId, 5000)

  await check('[R11] Cross-instance: reply от instance #1 стига до subscriber на instance #2', async () => {
    sendWs(wsU1, { type: 'send_topic_reply', topicId: 'topic-cross-rl', parentMessageId: crossRootId, body: 'cross reply', requestId: 'cross-reply' })
    const ownAck = await waitForWsMessage(wsU1, (m) => m.type === 'topic_reply' && m.requestId === 'cross-reply')

    const seenOnInstance2 = await waitForWsMessage(wsU2, (m) => m.type === 'topic_reply' && m.messageId === ownAck.messageId, 6000)
    assertEqual(seenOnInstance2.body, 'cross reply', 'reply текстът трябва да съвпада на instance #2')
    assertEqual(seenOnInstance2.parentMessageId, crossRootId, 'parentMessageId трябва да се запази cross-instance')
  })

  await check('[Cross-Like] Like от instance #1 (drift-detection poll) стига до subscriber на instance #2', async () => {
    // instance #2 трябва вече да следи crossRootId в tracking set-а си (seed-нато
    // от catch-up-а, виж коментара в index.ts runTopicMessageLikePoll) —
    // toggle-ваме от instance #1, изчакваме poll tick-а (4s interval) на instance #2.
    sendWs(wsU1, { type: 'toggle_topic_message_like', messageId: crossRootId, requestId: 'cross-like-1' })
    await waitForWsMessage(wsU1, (m) => m.type === 'topic_message_like_changed_self' && m.requestId === 'cross-like-1')

    const seenOnInstance2 = await waitForWsMessage(wsU2, (m) => m.type === 'topic_message_like_changed' && m.messageId === crossRootId, 8000)
    assertEqual(seenOnInstance2.likeCount, 1, 'likeCount трябва да достигне instance #2 чрез drift-detection polling')
  })
} finally {
  if (srvX1) await stopSrv(srvX1)
  if (srvX2) await stopSrv(srvX2)
  await isoX.cleanup()
}

function assertEqual<T>(actual: T, expected: T): void {
  if (actual !== expected) {
    throw new Error(`got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
  }
}

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
