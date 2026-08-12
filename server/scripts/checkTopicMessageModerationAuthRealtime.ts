/**
 * checkTopicMessageModerationAuthRealtime.ts
 *
 * HTTP/WS integration checks за individual root съобщение/reply moderation
 * delete (различно от checkTopicModerationAuthRealtime.ts, който е
 * whole-topic delete). Real spawn-нат сървър, изолирана SQLite база, реални
 * HTTP + WS заявки. Established harness pattern (mirror на
 * checkTopicModerationAuthRealtime.ts/checkTopicRepliesLikesRealtime.ts).
 *
 * === Section R: Role matrix (5 moderator роли + player/guest/unauthenticated) ===
 * [R1] admin delete root → success
 * [R2] subadmin delete root → success
 * [R3] top_chat_admin delete root → success
 * [R4] pika_team delete root → success
 * [R5] chat_admin delete root → success
 * [R6] player → 403
 * [R7] unauthenticated → 401/403
 * [R8] guest/temporary profile → 403
 * [R9] moderator може да изтрие И собствено съобщение (author === actor)
 *
 * === Section S: Security ===
 * [S1] wrong topic/message pair → 404
 * [S2] removed topic → 404
 * [S3] locked topic → delete success (moderation работи независимо от lock)
 * [S4] missing/nonexistent message → 404
 * [S5] duplicate delete (HTTP-level) → 200 идемпотентно
 *
 * === Section E: Realtime (same-instance) ===
 * [E1] Root delete broadcast: subscriber вижда topic_message_deleted с parentMessageId=null
 * [E2] Reply delete broadcast: subscriber вижда topic_message_deleted с parentMessageId=rootId
 * [E3] Reconnect/subscribe СЛЕД delete не връща изтритото съобщение (catch-up)
 *
 * === Section X: Cross-instance ===
 * [X1] Root delete от instance #1 стига до subscriber на instance #2
 */

import { DatabaseSync } from 'node:sqlite'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm, cp, mkdir, symlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
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
function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
  }
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

const SERVER_READY_TIMEOUT_MS = 30_000
const PASSWORD = 'TopicMsgModerationCheck1!'

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
  const tmp = await mkdtemp(join(tmpdir(), 'belot-topic-message-moderation-http-'))
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

async function httpDeleteJson(port: number, pathname: string, cookie: string | undefined): Promise<HttpResult> {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: 'DELETE',
    headers: cookie ? { Cookie: cookie } : undefined,
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

function promoteAccount(databaseFile: string, email: string, role: 'admin' | 'subadmin' | 'pika_team' | 'top_chat_admin' | 'chat_admin'): void {
  const database = new DatabaseSync(databaseFile, { open: true, enableForeignKeyConstraints: true })
  try {
    database.exec('PRAGMA journal_mode = WAL;')
    database.prepare(`UPDATE accounts SET role = ?, updated_at = CURRENT_TIMESTAMP WHERE email = ?;`).run(role, email)
  } finally {
    database.close()
  }
}

function insertExtraTopic(databaseFile: string, topicId: string, slug: string, title: string): void {
  const database = new DatabaseSync(databaseFile, { open: true, enableForeignKeyConstraints: true })
  try {
    database.exec('PRAGMA journal_mode = WAL;')
    database.prepare(`
      INSERT INTO topics (topic_id, slug, title, is_general, created_by_profile_id, status, sort_order)
      VALUES (?, ?, ?, 0, NULL, 'active', 50);
    `).run(topicId, slug, title)
  } finally {
    database.close()
  }
}

function grantVip(databaseFile: string, profileId: string): void {
  const database = new DatabaseSync(databaseFile, { open: true, enableForeignKeyConstraints: true })
  try {
    database.exec('PRAGMA journal_mode = WAL;')
    const activeUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ')
    database.prepare(`INSERT INTO vip_status (profile_id, active_until) VALUES (?, ?) ON CONFLICT(profile_id) DO UPDATE SET active_until = excluded.active_until;`).run(profileId, activeUntil)
  } finally {
    database.close()
  }
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
  const deadline = Date.now() + timeoutMs
  const buffer = wsMessageBuffers.get(ws)
  if (!buffer) throw new Error('WS buffer missing')
  while (Date.now() < deadline) {
    const idx = buffer.findIndex(predicate)
    if (idx !== -1) return buffer[idx]!
    await sleep(30)
  }
  throw new Error('Timeout waiting for WS message matching predicate')
}

// ─── Setup: единична изолирана инстанция, споделена между Section R/S/E ────

console.log('\n=== Topic Message Moderation Auth/Realtime (single instance) ===\n')

const iso = await makeIsolated(serverRoot)
const port = await getFreePort()
let srv: { child: ChildProcessWithoutNullStreams; output(): string } | null = null

try {
  srv = startSrv(iso.serverDir, port)
  console.log(`  Чакам сървъра на порт ${port}…`)
  await waitForServerReady(port)
  console.log('  Сървърът е готов.\n')

  const runId = `${Date.now()}-${process.pid}`

  const admin = await registerAndLogin(port, `tmsgmod-admin-${runId}@example.test`, 'AdminUser')
  const subadmin = await registerAndLogin(port, `tmsgmod-subadmin-${runId}@example.test`, 'SubadminUser')
  const topChatAdmin = await registerAndLogin(port, `tmsgmod-topchatadmin-${runId}@example.test`, 'TopChatAdminUser')
  const pikaTeam = await registerAndLogin(port, `tmsgmod-pikateam-${runId}@example.test`, 'PikaTeamUser')
  const chatAdmin = await registerAndLogin(port, `tmsgmod-chatadmin-${runId}@example.test`, 'ChatAdminUser')
  const normalPlayer = await registerAndLogin(port, `tmsgmod-player-${runId}@example.test`, 'NormalPlayer')

  promoteAccount(iso.dbFile, `tmsgmod-admin-${runId}@example.test`, 'admin')
  promoteAccount(iso.dbFile, `tmsgmod-subadmin-${runId}@example.test`, 'subadmin')
  promoteAccount(iso.dbFile, `tmsgmod-topchatadmin-${runId}@example.test`, 'top_chat_admin')
  promoteAccount(iso.dbFile, `tmsgmod-pikateam-${runId}@example.test`, 'pika_team')
  promoteAccount(iso.dbFile, `tmsgmod-chatadmin-${runId}@example.test`, 'chat_admin')

  insertExtraTopic(iso.dbFile, 'topic-role-matrix', 'role-matrix', 'Role Matrix Topic')
  insertExtraTopic(iso.dbFile, 'topic-security', 'security', 'Security Topic')
  insertExtraTopic(iso.dbFile, 'topic-security-b', 'security-b', 'Security Topic B')
  insertExtraTopic(iso.dbFile, 'topic-locked', 'locked-topic', 'Locked Topic')
  insertExtraTopic(iso.dbFile, 'topic-realtime', 'realtime-topic', 'Realtime Topic')
  grantVip(iso.dbFile, normalPlayer.profileId)
  grantVip(iso.dbFile, admin.profileId)
  // Всички модератори имат нужда от VIP, за да пишат root/reply съобщения
  // (established Topics write guard) — seed-ваме постовете от РАЗЛИЧНИ
  // потребители, за да не удряме TOPIC_MESSAGE_RATE_LIMIT_MAX_PER_WINDOW=5/10s
  // per-profile лимита с толкова много тестове в тази секция.
  grantVip(iso.dbFile, subadmin.profileId)
  grantVip(iso.dbFile, topChatAdmin.profileId)
  grantVip(iso.dbFile, pikaTeam.profileId)
  grantVip(iso.dbFile, chatAdmin.profileId)

  const wsAdmin = await openWs(port, admin.cookie)
  sendWs(wsAdmin, { type: 'subscribe_topic_messages', topicId: 'topic-role-matrix', afterSeq: 0 })
  await waitForWsMessage(wsAdmin, (m) => m.type === 'topic_message_catchup')

  const wsSubadmin = await openWs(port, subadmin.cookie)
  const wsTopChatAdmin = await openWs(port, topChatAdmin.cookie)
  const wsPikaTeam = await openWs(port, pikaTeam.cookie)
  const wsChatAdmin = await openWs(port, chatAdmin.cookie)

  async function postRoot(ws: WebSocket, topicId: string, body: string, requestId: string): Promise<string> {
    sendWs(ws, { type: 'subscribe_topic_messages', topicId, afterSeq: 0 })
    await waitForWsMessage(ws, (m) => m.type === 'topic_message_catchup')
    sendWs(ws, { type: 'send_topic_message', topicId, body, requestId })
    const msg = await waitForWsMessage(ws, (m) => (m.type === 'topic_message' || m.type === 'topic_message_error') && m.requestId === requestId)
    if (msg.type === 'topic_message_error') throw new Error(`send_topic_message failed: ${JSON.stringify(msg)}`)
    return msg.messageId as string
  }

  console.log('=== Section R: Role matrix ===\n')

  await check('[R1] admin delete root → success', async () => {
    const rootId = await postRoot(wsAdmin, 'topic-role-matrix', 'root for admin delete', 'req-r1')
    const r = await httpDeleteJson(port, `/api/topics/topic-role-matrix/messages/${rootId}`, admin.cookie)
    assert(r.status === 200, `очаквано 200, получено ${r.status}`)
  })

  await check('[R2] subadmin delete root → success', async () => {
    const rootId = await postRoot(wsSubadmin, 'topic-role-matrix', 'root for subadmin delete', 'req-r2')
    const r = await httpDeleteJson(port, `/api/topics/topic-role-matrix/messages/${rootId}`, subadmin.cookie)
    assert(r.status === 200, `очаквано 200, получено ${r.status}`)
  })

  await check('[R3] top_chat_admin delete root → success', async () => {
    const rootId = await postRoot(wsTopChatAdmin, 'topic-role-matrix', 'root for top_chat_admin delete', 'req-r3')
    const r = await httpDeleteJson(port, `/api/topics/topic-role-matrix/messages/${rootId}`, topChatAdmin.cookie)
    assert(r.status === 200, `очаквано 200, получено ${r.status}`)
  })

  await check('[R4] pika_team delete root → success', async () => {
    const rootId = await postRoot(wsPikaTeam, 'topic-role-matrix', 'root for pika_team delete', 'req-r4')
    const r = await httpDeleteJson(port, `/api/topics/topic-role-matrix/messages/${rootId}`, pikaTeam.cookie)
    assert(r.status === 200, `очаквано 200, получено ${r.status}`)
  })

  await check('[R5] chat_admin delete root → success', async () => {
    const rootId = await postRoot(wsChatAdmin, 'topic-role-matrix', 'root for chat_admin delete', 'req-r5')
    const r = await httpDeleteJson(port, `/api/topics/topic-role-matrix/messages/${rootId}`, chatAdmin.cookie)
    assert(r.status === 200, `очаквано 200, получено ${r.status}`)
  })

  await check('[R6] player НЕ МОЖЕ да изтрие съобщение (403)', async () => {
    const rootId = await postRoot(wsSubadmin, 'topic-role-matrix', 'root for player denial', 'req-r6')
    const r = await httpDeleteJson(port, `/api/topics/topic-role-matrix/messages/${rootId}`, normalPlayer.cookie)
    assert(r.status === 403, `очаквано 403, получено ${r.status}`)
  })

  await check('[R7] Unauthenticated (без сесия) → 401/403', async () => {
    const rootId = await postRoot(wsTopChatAdmin, 'topic-role-matrix', 'root for unauth denial', 'req-r7')
    const r = await httpDeleteJson(port, `/api/topics/topic-role-matrix/messages/${rootId}`, undefined)
    assert(r.status === 401 || r.status === 403, `очаквано 401/403, получено ${r.status}`)
  })

  await check('[R8] Guest/temporary profile → 403', async () => {
    const rootId = await postRoot(wsPikaTeam, 'topic-role-matrix', 'root for guest denial', 'req-r8')
    const guestRes = await fetch(`http://127.0.0.1:${port}/api/guest/trial-status`, { method: 'GET' })
    const h = guestRes.headers as Headers & { getSetCookie?: () => string[] }
    const guestCookie = (h.getSetCookie?.()[0] ?? guestRes.headers.get('set-cookie'))?.split(';')[0]
    const r = await httpDeleteJson(port, `/api/topics/topic-role-matrix/messages/${rootId}`, guestCookie)
    assert(r.status === 403 || r.status === 401, `очаквано 401/403, получено ${r.status}`)
  })

  await check('[R9] Moderator може да изтрие И СОБСТВЕНО съобщение (author === actor)', async () => {
    const rootId = await postRoot(wsChatAdmin, 'topic-role-matrix', 'chat_admin own message', 'req-r9')
    // wsChatAdmin е самият chat_admin — той е и автор, и actor тук.
    const r = await httpDeleteJson(port, `/api/topics/topic-role-matrix/messages/${rootId}`, chatAdmin.cookie)
    assert(r.status === 200, `moderator трябва да може да изтрие собственото си съобщение, получено ${r.status}`)
  })

  console.log('\n=== Section S: Security ===\n')

  await check('[S1] Wrong topic/message pair → 404', async () => {
    const rootId = await postRoot(wsSubadmin, 'topic-security', 'root in security topic', 'req-s1')
    const r = await httpDeleteJson(port, `/api/topics/topic-security-b/messages/${rootId}`, admin.cookie)
    assert(r.status === 404, `очаквано 404 за wrong topic/message pair, получено ${r.status}`)
  })

  await check('[S2] Removed topic → 404', async () => {
    const rootId = await postRoot(wsTopChatAdmin, 'topic-security', 'root before topic removal', 'req-s2')
    const delTopic = await fetch(`http://127.0.0.1:${port}/api/topics/topic-security`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ reason: 'test removal for S2' }),
    })
    assert(delTopic.status === 200, `whole-topic delete трябва да успее, получено ${delTopic.status}`)
    const r = await httpDeleteJson(port, `/api/topics/topic-security/messages/${rootId}`, admin.cookie)
    assert(r.status === 404, `individual-message endpoint НЕ трябва да работи в removed тема, получено ${r.status}`)
  })

  await check('[S3] Locked topic → delete success (moderation работи независимо от lock)', async () => {
    const rootId = await postRoot(wsPikaTeam, 'topic-locked', 'root before lock', 'req-s3')
    const lockRes = await fetch(`http://127.0.0.1:${port}/api/topics/topic-locked/lock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
      body: JSON.stringify({ reason: 'test lock for S3', durationMs: 30 * 60 * 1000 }),
    })
    assert(lockRes.status === 200, `lock трябва да успее, получено ${lockRes.status}`)
    const r = await httpDeleteJson(port, `/api/topics/topic-locked/messages/${rootId}`, admin.cookie)
    assert(r.status === 200, `individual-message moderation delete трябва да работи в locked тема, получено ${r.status}`)
  })

  await check('[S4] Missing/nonexistent message → 404', async () => {
    const r = await httpDeleteJson(port, '/api/topics/topic-security/messages/nonexistent-message-id', admin.cookie)
    assert(r.status === 404, `очаквано 404, получено ${r.status}`)
  })

  await check('[S5] Duplicate delete (HTTP-level) → 200 идемпотентно', async () => {
    const rootId = await postRoot(wsChatAdmin, 'topic-security-b', 'root for duplicate delete test', 'req-s5')
    const first = await httpDeleteJson(port, `/api/topics/topic-security-b/messages/${rootId}`, admin.cookie)
    assert(first.status === 200, `първи delete трябва да успее, получено ${first.status}`)
    const second = await httpDeleteJson(port, `/api/topics/topic-security-b/messages/${rootId}`, admin.cookie)
    assert(second.status === 200, `втори delete на вече изтрито съобщение трябва да е 200 идемпотентно, получено ${second.status}`)
  })

  console.log('\n=== Section E: Realtime (same-instance) ===\n')

  await check('[E1] Root delete broadcast: subscriber вижда topic_message_deleted с parentMessageId=null', async () => {
    const wsSubscriber = await openWs(port, normalPlayer.cookie)
    sendWs(wsSubscriber, { type: 'subscribe_topic_messages', topicId: 'topic-realtime', afterSeq: 0 })
    await waitForWsMessage(wsSubscriber, (m) => m.type === 'topic_message_catchup')

    const rootId = await postRoot(wsAdmin, 'topic-realtime', 'root for realtime delete E1', 'req-e1')
    await waitForWsMessage(wsSubscriber, (m) => m.type === 'topic_message' && m.messageId === rootId)

    const r = await httpDeleteJson(port, `/api/topics/topic-realtime/messages/${rootId}`, admin.cookie)
    assert(r.status === 200, `delete трябва да успее, получено ${r.status}`)

    const deletedMsg = await waitForWsMessage(wsSubscriber, (m) => m.type === 'topic_message_deleted' && m.messageId === rootId)
    assertEqual(deletedMsg.parentMessageId, null, 'root target -> parentMessageId null в broadcast payload-а')
    assertEqual(deletedMsg.topicId, 'topic-realtime', 'topicId трябва да съвпада')
    assert(typeof deletedMsg.deletedAt === 'string' && (deletedMsg.deletedAt as string).length > 0, 'deletedAt трябва да е непразен timestamp')

    wsSubscriber.close()
  })

  await check('[E2] Reply delete broadcast: subscriber вижда topic_message_deleted с parentMessageId=rootId', async () => {
    const wsSubscriber = await openWs(port, normalPlayer.cookie)
    sendWs(wsSubscriber, { type: 'subscribe_topic_messages', topicId: 'topic-realtime', afterSeq: 0 })
    await waitForWsMessage(wsSubscriber, (m) => m.type === 'topic_message_catchup')

    const rootId = await postRoot(wsAdmin, 'topic-realtime', 'root for reply delete E2', 'req-e2-root')
    await waitForWsMessage(wsSubscriber, (m) => m.type === 'topic_message' && m.messageId === rootId)

    sendWs(wsAdmin, { type: 'send_topic_reply', topicId: 'topic-realtime', parentMessageId: rootId, body: 'reply for E2', requestId: 'req-e2-reply' })
    const replyAck = await waitForWsMessage(wsAdmin, (m) => m.type === 'topic_reply' && m.requestId === 'req-e2-reply')
    const replyId = replyAck.messageId as string
    await waitForWsMessage(wsSubscriber, (m) => m.type === 'topic_reply' && m.messageId === replyId)

    const r = await httpDeleteJson(port, `/api/topics/topic-realtime/messages/${replyId}`, admin.cookie)
    assert(r.status === 200, `reply delete трябва да успее, получено ${r.status}`)

    const deletedMsg = await waitForWsMessage(wsSubscriber, (m) => m.type === 'topic_message_deleted' && m.messageId === replyId)
    assertEqual(deletedMsg.parentMessageId, rootId, 'reply target -> parentMessageId сочи към root-а')

    wsSubscriber.close()
  })

  await check('[E3] Reconnect/subscribe СЛЕД delete не връща изтритото съобщение (catch-up)', async () => {
    const rootId = await postRoot(wsAdmin, 'topic-realtime', 'root for reconnect test E3', 'req-e3')
    const r = await httpDeleteJson(port, `/api/topics/topic-realtime/messages/${rootId}`, admin.cookie)
    assert(r.status === 200, `delete трябва да успее, получено ${r.status}`)

    const wsLate = await openWs(port, normalPlayer.cookie)
    sendWs(wsLate, { type: 'subscribe_topic_messages', topicId: 'topic-realtime', afterSeq: 0 })
    const catchup = await waitForWsMessage(wsLate, (m) => m.type === 'topic_message_catchup')
    const catchupMessages = (catchup as unknown as { messages?: Array<{ messageId?: string }> }).messages ?? []
    assert(!catchupMessages.some((m) => m.messageId === rootId), 'изтритото съобщение НЕ трябва да се появи в catch-up-а')

    const restRes = await httpGetJson(port, '/api/topics/topic-realtime/messages', normalPlayer.cookie)
    const restBody = restRes.body as { messages?: Array<{ messageId?: string }> }
    assert(!(restBody.messages ?? []).some((m) => m.messageId === rootId), 'изтритото съобщение НЕ трябва да се появи в REST history-то')

    wsLate.close()
  })
} finally {
  if (srv) await stopSrv(srv)
  await iso.cleanup()
}

// ─── Section X: Cross-instance ──────────────────────────────────────────────

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
  const modX = await registerAndLogin(portX1, `tmsgmod-x1-${runId2}@example.test`, 'CrossModerator')
  const viewerX = await registerAndLogin(portX1, `tmsgmod-x2-${runId2}@example.test`, 'CrossViewer')
  promoteAccount(isoX.dbFile, `tmsgmod-x1-${runId2}@example.test`, 'admin')
  grantVip(isoX.dbFile, modX.profileId)

  const dbX = new DatabaseSync(isoX.dbFile, { open: true, enableForeignKeyConstraints: true })
  dbX.prepare(`
    INSERT INTO topics (topic_id, slug, title, is_general, created_by_profile_id, status, sort_order)
    VALUES ('topic-cross-msg-mod', 'cross-msg-mod', 'Cross Message Moderation Topic', 0, NULL, 'active', 50);
  `).run()
  dbX.close()

  const wsMod = await openWs(portX1, modX.cookie)
  const wsViewer = await openWs(portX2, viewerX.cookie)

  sendWs(wsMod, { type: 'subscribe_topic_messages', topicId: 'topic-cross-msg-mod', afterSeq: 0 })
  await waitForWsMessage(wsMod, (m) => m.type === 'topic_message_catchup')
  sendWs(wsViewer, { type: 'subscribe_topic_messages', topicId: 'topic-cross-msg-mod', afterSeq: 0 })
  await waitForWsMessage(wsViewer, (m) => m.type === 'topic_message_catchup')

  sendWs(wsMod, { type: 'send_topic_message', topicId: 'topic-cross-msg-mod', body: 'cross root for delete', requestId: 'cross-root-del' })
  const crossRoot = await waitForWsMessage(wsMod, (m) => m.type === 'topic_message' && m.requestId === 'cross-root-del')
  const crossRootId = crossRoot.messageId as string

  await waitForWsMessage(wsViewer, (m) => m.type === 'topic_message' && m.messageId === crossRootId, 5000)

  await check('[X1] Root delete от instance #1 стига до subscriber на instance #2', async () => {
    const r = await httpDeleteJson(portX1, `/api/topics/topic-cross-msg-mod/messages/${crossRootId}`, modX.cookie)
    assert(r.status === 200, `delete трябва да успее, получено ${r.status}`)

    const deletedOnInstance2 = await waitForWsMessage(wsViewer, (m) => m.type === 'topic_message_deleted' && m.messageId === crossRootId, 6000)
    assertEqual(deletedOnInstance2.topicId, 'topic-cross-msg-mod', 'topicId трябва да съвпада cross-instance')
    assertEqual(deletedOnInstance2.parentMessageId, null, 'root target -> parentMessageId null cross-instance')
  })
} finally {
  if (srvX1) await stopSrv(srvX1)
  if (srvX2) await stopSrv(srvX2)
  await isoX.cleanup()
}

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)

if (failed > 0) {
  process.exitCode = 1
}
