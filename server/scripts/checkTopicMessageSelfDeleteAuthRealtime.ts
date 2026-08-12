/**
 * HTTP/WS integration checks for ordinary author self-delete in Topics.
 *
 * This suite intentionally keeps moderator-delete coverage in
 * checkTopicMessageModerationAuthRealtime.ts and focuses on the new owner path:
 * authorization, VIP independence, locked/removed topics, audit split, and
 * same/cross-instance topic_message_deleted delivery.
 */

import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm, cp, mkdir, symlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
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

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

const SERVER_READY_TIMEOUT_MS = 30_000
const PASSWORD = 'TopicMsgSelfDeleteCheck1!'

function getFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (!addr || typeof addr === 'string') {
        srv.close(() => reject(new Error('No free port')))
        return
      }
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
    try {
      await rm(path, { recursive: true, force: true })
      return
    } catch {
      await sleep(250)
    }
  }
}

async function makeIsolated(root: string) {
  const tmp = await mkdtemp(join(tmpdir(), 'belot-topic-message-self-delete-http-'))
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
  await new Promise<void>((resolveStop) => {
    const t = setTimeout(() => { s.child.kill('SIGKILL'); resolveStop() }, 10_000)
    s.child.once('exit', () => { clearTimeout(t); resolveStop() })
  })
}

type HttpResult = { status: number; body: unknown }

async function httpGetJson(port: number, pathname: string, cookie?: string): Promise<HttpResult> {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    headers: cookie ? { Cookie: cookie } : undefined,
  })
  let body: unknown = null
  try { body = await res.json() } catch { /* ignored */ }
  return { status: res.status, body }
}

async function httpDeleteJson(port: number, pathname: string, cookie: string | undefined): Promise<HttpResult> {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: 'DELETE',
    headers: cookie ? { Cookie: cookie } : undefined,
  })
  let body: unknown = null
  try { body = await res.json() } catch { /* ignored */ }
  return { status: res.status, body }
}

async function waitForServerReady(port: number): Promise<void> {
  await waitFor('server ready', async () => {
    try {
      const r = await httpGetJson(port, '/health')
      const h = r.body as { ok?: boolean; gameWorkerPool?: { state?: string } | null }
      return r.status === 200 && h.ok === true && h.gameWorkerPool?.state === 'ready'
    } catch {
      return false
    }
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

function withDb<T>(databaseFile: string, fn: (database: DatabaseSync) => T): T {
  const database = new DatabaseSync(databaseFile, { open: true, enableForeignKeyConstraints: true })
  try {
    database.exec('PRAGMA journal_mode = WAL;')
    return fn(database)
  } finally {
    database.close()
  }
}

function sqliteDateAfter(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ')
}

function sqliteDateBefore(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ')
}

function promoteAccount(databaseFile: string, email: string, role: 'admin' | 'subadmin' | 'top_chat_admin' | 'pika_team' | 'chat_admin'): void {
  withDb(databaseFile, (database) => {
    database.prepare(`UPDATE accounts SET role = ?, updated_at = CURRENT_TIMESTAMP WHERE email = ?;`).run(role, email)
  })
}

function setVip(databaseFile: string, profileId: string, activeUntil: string): void {
  withDb(databaseFile, (database) => {
    database.prepare(`
      INSERT INTO vip_status (profile_id, active_until)
      VALUES (?, ?)
      ON CONFLICT(profile_id) DO UPDATE SET active_until = excluded.active_until, updated_at = CURRENT_TIMESTAMP;
    `).run(profileId, activeUntil)
  })
}

function insertTopic(databaseFile: string, topicId: string, slug: string, status = 'active'): void {
  withDb(databaseFile, (database) => {
    database.prepare(`
      INSERT INTO topics (topic_id, slug, title, is_general, created_by_profile_id, status, sort_order, locked_until, removed_at)
      VALUES (?, ?, ?, 0, NULL, ?, 50, ?, ?);
    `).run(
      topicId,
      slug,
      slug,
      status,
      status === 'locked' ? sqliteDateAfter(1) : null,
      status === 'removed' ? sqliteDateBefore(1) : null,
    )
  })
}

function insertMessage(databaseFile: string, input: {
  topicId: string
  senderProfileId: string
  senderDisplayName: string
  senderRole?: string
  body: string
  parentMessageId?: string | null
}): string {
  const messageId = randomUUID()
  withDb(databaseFile, (database) => {
    database.prepare(`
      INSERT INTO topic_messages (
        message_id, topic_id, parent_message_id, sender_profile_id, sender_display_name, sender_role, body
      ) VALUES (?, ?, ?, ?, ?, ?, ?);
    `).run(
      messageId,
      input.topicId,
      input.parentMessageId ?? null,
      input.senderProfileId,
      input.senderDisplayName,
      input.senderRole ?? 'player',
      input.body,
    )
  })
  return messageId
}

function messageDeletedAt(databaseFile: string, messageId: string): string | null {
  return withDb(databaseFile, (database) => {
    const row = database.prepare(`SELECT deleted_at FROM topic_messages WHERE message_id = ?;`).get(messageId) as { deleted_at: string | null } | undefined
    return row?.deleted_at ?? null
  })
}

function countRows(databaseFile: string, sql: string, ...args: unknown[]): number {
  return withDb(databaseFile, (database) => {
    const row = database.prepare(sql).get(...args) as { c: number }
    return row.c
  })
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
  if (!buffer) throw new Error('WS buffer missing')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const idx = buffer.findIndex(predicate)
    if (idx !== -1) {
      const [msg] = buffer.splice(idx, 1)
      return msg!
    }
    await sleep(25)
  }
  throw new Error('Timeout waiting for WS message matching predicate')
}

async function subscribe(ws: WebSocket, topicId: string): Promise<void> {
  sendWs(ws, { type: 'subscribe_topic_messages', topicId, afterSeq: 0 })
  await waitForWsMessage(ws, (m) => m.type === 'topic_message_catchup' && m.topicId === topicId)
}

async function postRoot(ws: WebSocket, topicId: string, body: string, requestId: string): Promise<string> {
  sendWs(ws, { type: 'send_topic_message', topicId, body, requestId })
  const msg = await waitForWsMessage(ws, (m) => (m.type === 'topic_message' || m.type === 'topic_message_error') && m.requestId === requestId)
  if (msg.type === 'topic_message_error') throw new Error(`send_topic_message failed: ${JSON.stringify(msg)}`)
  return msg.messageId as string
}

async function postReply(ws: WebSocket, topicId: string, parentMessageId: string, body: string, requestId: string): Promise<string> {
  sendWs(ws, { type: 'send_topic_reply', topicId, parentMessageId, body, requestId })
  const msg = await waitForWsMessage(ws, (m) => (m.type === 'topic_reply' || m.type === 'topic_reply_error') && m.requestId === requestId)
  if (msg.type === 'topic_reply_error') throw new Error(`send_topic_reply failed: ${JSON.stringify(msg)}`)
  return msg.messageId as string
}

console.log('\n=== Topic Message Self-Delete Auth/Realtime (single instance) ===\n')

const iso = await makeIsolated(serverRoot)
const port = await getFreePort()
let srv: ReturnType<typeof startSrv> | null = null

try {
  srv = startSrv(iso.serverDir, port)
  console.log(`  Waiting for server on port ${port}...`)
  await waitForServerReady(port)
  console.log('  Server is ready.\n')

  const runId = `${Date.now()}-${process.pid}`
  const owner = await registerAndLogin(port, `self-owner-${runId}@example.test`, 'SelfOwner')
  const other = await registerAndLogin(port, `self-other-${runId}@example.test`, 'SelfOther')
  const nonVipOwner = await registerAndLogin(port, `self-nonvip-${runId}@example.test`, 'SelfNonVip')
  const expiredVipOwner = await registerAndLogin(port, `self-expired-${runId}@example.test`, 'SelfExpired')
  const activeVipOwner = await registerAndLogin(port, `self-active-${runId}@example.test`, 'SelfActive')
  const admin = await registerAndLogin(port, `self-admin-${runId}@example.test`, 'SelfAdmin')
  const viewer = await registerAndLogin(port, `self-viewer-${runId}@example.test`, 'SelfViewer')

  promoteAccount(iso.dbFile, `self-admin-${runId}@example.test`, 'admin')
  setVip(iso.dbFile, owner.profileId, sqliteDateAfter(30))
  setVip(iso.dbFile, activeVipOwner.profileId, sqliteDateAfter(30))
  setVip(iso.dbFile, expiredVipOwner.profileId, sqliteDateBefore(1))
  setVip(iso.dbFile, admin.profileId, sqliteDateAfter(30))

  insertTopic(iso.dbFile, 'topic-self-auth', 'self-auth')
  insertTopic(iso.dbFile, 'topic-self-locked', 'self-locked', 'locked')
  insertTopic(iso.dbFile, 'topic-self-removed', 'self-removed', 'removed')
  insertTopic(iso.dbFile, 'topic-self-realtime', 'self-realtime')

  const wsOwner = await openWs(port, owner.cookie)
  const wsActiveVipOwner = await openWs(port, activeVipOwner.cookie)
  const wsAdmin = await openWs(port, admin.cookie)
  await subscribe(wsOwner, 'topic-self-auth')
  await subscribe(wsActiveVipOwner, 'topic-self-auth')
  await subscribe(wsAdmin, 'topic-self-auth')

  console.log('=== HTTP auth/product matrix ===\n')

  await check('[A1] owner root with 0 replies -> success', async () => {
    const rootId = insertMessage(iso.dbFile, {
      topicId: 'topic-self-auth',
      senderProfileId: owner.profileId,
      senderDisplayName: 'SelfOwner',
      body: 'own root without replies',
    })
    const res = await httpDeleteJson(port, `/api/topics/topic-self-auth/messages/${rootId}`, owner.cookie)
    assertEqual(res.status, 200, 'owner root delete status')
    assert(messageDeletedAt(iso.dbFile, rootId) !== null, 'root should be soft-deleted')
  })

  await check('[A2] owner reply -> success', async () => {
    const rootId = insertMessage(iso.dbFile, {
      topicId: 'topic-self-auth',
      senderProfileId: other.profileId,
      senderDisplayName: 'SelfOther',
      body: 'root for owner reply',
    })
    const replyId = insertMessage(iso.dbFile, {
      topicId: 'topic-self-auth',
      parentMessageId: rootId,
      senderProfileId: owner.profileId,
      senderDisplayName: 'SelfOwner',
      body: 'own reply',
    })
    const res = await httpDeleteJson(port, `/api/topics/topic-self-auth/messages/${replyId}`, owner.cookie)
    assertEqual(res.status, 200, 'owner reply delete status')
    assert(messageDeletedAt(iso.dbFile, replyId) !== null, 'reply should be soft-deleted')
    assertEqual(messageDeletedAt(iso.dbFile, rootId), null, 'root should remain live')
  })

  await check('[A3] other registered player -> 403', async () => {
    const rootId = insertMessage(iso.dbFile, {
      topicId: 'topic-self-auth',
      senderProfileId: owner.profileId,
      senderDisplayName: 'SelfOwner',
      body: 'not yours',
    })
    const res = await httpDeleteJson(port, `/api/topics/topic-self-auth/messages/${rootId}`, other.cookie)
    assertEqual(res.status, 403, 'non-owner status')
    assertEqual(messageDeletedAt(iso.dbFile, rootId), null, 'target should remain live')
  })

  await check('[A4] guest/temporary profile -> denied', async () => {
    const rootId = insertMessage(iso.dbFile, {
      topicId: 'topic-self-auth',
      senderProfileId: owner.profileId,
      senderDisplayName: 'SelfOwner',
      body: 'guest cannot delete',
    })
    const guestRes = await fetch(`http://127.0.0.1:${port}/api/guest/trial-status`, { method: 'GET' })
    const h = guestRes.headers as Headers & { getSetCookie?: () => string[] }
    const guestCookie = (h.getSetCookie?.()[0] ?? guestRes.headers.get('set-cookie'))?.split(';')[0]
    const res = await httpDeleteJson(port, `/api/topics/topic-self-auth/messages/${rootId}`, guestCookie)
    assert(res.status === 401 || res.status === 403, `expected 401/403, got ${res.status}`)
  })

  await check('[A5] unauthenticated -> denied', async () => {
    const rootId = insertMessage(iso.dbFile, {
      topicId: 'topic-self-auth',
      senderProfileId: owner.profileId,
      senderDisplayName: 'SelfOwner',
      body: 'anonymous cannot delete',
    })
    const res = await httpDeleteJson(port, `/api/topics/topic-self-auth/messages/${rootId}`, undefined)
    assert(res.status === 401 || res.status === 403, `expected 401/403, got ${res.status}`)
  })

  await check('[A6] non-VIP registered owner -> success', async () => {
    const rootId = insertMessage(iso.dbFile, {
      topicId: 'topic-self-auth',
      senderProfileId: nonVipOwner.profileId,
      senderDisplayName: 'SelfNonVip',
      body: 'non-vip owner delete',
    })
    const res = await httpDeleteJson(port, `/api/topics/topic-self-auth/messages/${rootId}`, nonVipOwner.cookie)
    assertEqual(res.status, 200, 'non-VIP owner status')
  })

  await check('[A7] expired VIP owner -> success', async () => {
    const rootId = insertMessage(iso.dbFile, {
      topicId: 'topic-self-auth',
      senderProfileId: expiredVipOwner.profileId,
      senderDisplayName: 'SelfExpired',
      body: 'expired-vip owner delete',
    })
    const res = await httpDeleteJson(port, `/api/topics/topic-self-auth/messages/${rootId}`, expiredVipOwner.cookie)
    assertEqual(res.status, 200, 'expired VIP owner status')
  })

  await check('[A8] active VIP owner -> success', async () => {
    const rootId = insertMessage(iso.dbFile, {
      topicId: 'topic-self-auth',
      senderProfileId: activeVipOwner.profileId,
      senderDisplayName: 'SelfActive',
      body: 'active-vip owner delete',
    })
    const res = await httpDeleteJson(port, `/api/topics/topic-self-auth/messages/${rootId}`, activeVipOwner.cookie)
    assertEqual(res.status, 200, 'active VIP owner status')
  })

  await check('[A9] locked topic -> own-delete success', async () => {
    const rootId = insertMessage(iso.dbFile, {
      topicId: 'topic-self-locked',
      senderProfileId: owner.profileId,
      senderDisplayName: 'SelfOwner',
      body: 'locked topic own delete',
    })
    const res = await httpDeleteJson(port, `/api/topics/topic-self-locked/messages/${rootId}`, owner.cookie)
    assertEqual(res.status, 200, 'locked topic delete status')
  })

  await check('[A10] removed topic -> 404', async () => {
    const rootId = insertMessage(iso.dbFile, {
      topicId: 'topic-self-removed',
      senderProfileId: owner.profileId,
      senderDisplayName: 'SelfOwner',
      body: 'removed topic own delete',
    })
    const res = await httpDeleteJson(port, `/api/topics/topic-self-removed/messages/${rootId}`, owner.cookie)
    assertEqual(res.status, 404, 'removed topic status')
  })

  await check('[A11-A12] ordinary owner root with live reply -> 409 and both stay live', async () => {
    const rootId = insertMessage(iso.dbFile, {
      topicId: 'topic-self-auth',
      senderProfileId: owner.profileId,
      senderDisplayName: 'SelfOwner',
      body: 'root with live reply',
    })
    const replyId = insertMessage(iso.dbFile, {
      topicId: 'topic-self-auth',
      parentMessageId: rootId,
      senderProfileId: other.profileId,
      senderDisplayName: 'SelfOther',
      body: 'live reply',
    })
    const res = await httpDeleteJson(port, `/api/topics/topic-self-auth/messages/${rootId}`, owner.cookie)
    const body = res.body as { code?: string }
    assertEqual(res.status, 409, 'root-with-replies status')
    assertEqual(body.code, 'has_live_replies', 'root-with-replies code')
    assertEqual(messageDeletedAt(iso.dbFile, rootId), null, 'root should remain live')
    assertEqual(messageDeletedAt(iso.dbFile, replyId), null, 'reply should remain live')
  })

  await check('[A13-A14] author+moderator root with replies -> moderator semantics', async () => {
    const rootId = insertMessage(iso.dbFile, {
      topicId: 'topic-self-auth',
      senderProfileId: admin.profileId,
      senderDisplayName: 'SelfAdmin',
      senderRole: 'admin',
      body: 'admin-authored root with reply',
    })
    const replyId = insertMessage(iso.dbFile, {
      topicId: 'topic-self-auth',
      parentMessageId: rootId,
      senderProfileId: other.profileId,
      senderDisplayName: 'SelfOther',
      body: 'reply removed by moderator path',
    })
    const res = await httpDeleteJson(port, `/api/topics/topic-self-auth/messages/${rootId}`, admin.cookie)
    assertEqual(res.status, 200, 'author+moderator status')
    assert(messageDeletedAt(iso.dbFile, rootId) !== null, 'root should be deleted')
    assert(messageDeletedAt(iso.dbFile, replyId) !== null, 'reply should be deleted by moderator root semantics')
    assertEqual(
      countRows(iso.dbFile, `SELECT COUNT(*) AS c FROM topic_message_deletion_audit_log WHERE message_id = ?;`, rootId),
      1,
      'moderator audit count',
    )
    assertEqual(
      countRows(iso.dbFile, `SELECT COUNT(*) AS c FROM topic_message_self_deletion_audit_log WHERE message_id = ?;`, rootId),
      0,
      'self-delete audit count for author+moderator',
    )
  })

  console.log('\n=== Realtime ===\n')

  await check('[E1] same-instance own root delete -> topic_message_deleted', async () => {
    const wsSubscriber = await openWs(port, viewer.cookie)
    await subscribe(wsSubscriber, 'topic-self-realtime')
    await subscribe(wsOwner, 'topic-self-realtime')
    const rootId = await postRoot(wsOwner, 'topic-self-realtime', 'same-instance root delete', 'self-e1-root')
    await waitForWsMessage(wsSubscriber, (m) => m.type === 'topic_message' && m.messageId === rootId)
    const res = await httpDeleteJson(port, `/api/topics/topic-self-realtime/messages/${rootId}`, owner.cookie)
    assertEqual(res.status, 200, 'same-instance root delete status')
    const deleted = await waitForWsMessage(wsSubscriber, (m) => m.type === 'topic_message_deleted' && m.messageId === rootId)
    assertEqual(deleted.parentMessageId, null, 'root delete parentMessageId')
    await sleep(4500)
    const buffer = wsMessageBuffers.get(wsSubscriber) ?? []
    assert(!buffer.some((m) => m.type === 'topic_message_deleted' && m.messageId === rootId), 'should not duplicate local delete after poll')
    wsSubscriber.close()
  })

  await check('[E2] same-instance own reply delete -> topic_message_deleted', async () => {
    const wsSubscriber = await openWs(port, viewer.cookie)
    await subscribe(wsSubscriber, 'topic-self-auth')
    const rootId = await postRoot(wsActiveVipOwner, 'topic-self-auth', 'root for reply realtime', 'self-e2-root')
    await waitForWsMessage(wsSubscriber, (m) => m.type === 'topic_message' && m.messageId === rootId)
    const replyId = await postReply(wsActiveVipOwner, 'topic-self-auth', rootId, 'reply realtime delete', 'self-e2-reply')
    await waitForWsMessage(wsSubscriber, (m) => m.type === 'topic_reply' && m.messageId === replyId)
    const res = await httpDeleteJson(port, `/api/topics/topic-self-auth/messages/${replyId}`, activeVipOwner.cookie)
    assertEqual(res.status, 200, 'same-instance reply delete status')
    const deleted = await waitForWsMessage(wsSubscriber, (m) => m.type === 'topic_message_deleted' && m.messageId === replyId)
    assertEqual(deleted.parentMessageId, rootId, 'reply delete parentMessageId')
    const restRes = await httpGetJson(port, `/api/topics/topic-self-auth/messages/${rootId}/replies`, viewer.cookie)
    const restBody = restRes.body as { replies?: Array<{ messageId?: string }> }
    assert(!(restBody.replies ?? []).some((reply) => reply.messageId === replyId), 'deleted reply should not be in REST replies')
    wsSubscriber.close()
  })

  await check('[E3] reconnect/REST after delete does not return deleted root', async () => {
    const rootId = await postRoot(wsOwner, 'topic-self-realtime', 'deleted root hidden on reconnect', 'self-e3-root')
    const res = await httpDeleteJson(port, `/api/topics/topic-self-realtime/messages/${rootId}`, owner.cookie)
    assertEqual(res.status, 200, 'delete before reconnect status')
    const wsLate = await openWs(port, viewer.cookie)
    sendWs(wsLate, { type: 'subscribe_topic_messages', topicId: 'topic-self-realtime', afterSeq: 0 })
    const catchup = await waitForWsMessage(wsLate, (m) => m.type === 'topic_message_catchup')
    const catchupMessages = (catchup as { messages?: Array<{ messageId?: string }> }).messages ?? []
    assert(!catchupMessages.some((m) => m.messageId === rootId), 'deleted root should not appear in catch-up')
    const restRes = await httpGetJson(port, '/api/topics/topic-self-realtime/messages', viewer.cookie)
    const restBody = restRes.body as { messages?: Array<{ messageId?: string }> }
    assert(!(restBody.messages ?? []).some((m) => m.messageId === rootId), 'deleted root should not appear in REST history')
    wsLate.close()
  })
} finally {
  if (srv) await stopSrv(srv)
  await iso.cleanup()
}

console.log('\n=== Cross-instance ===\n')

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

  const runId = `${Date.now()}-${process.pid}-x`
  const ownerX = await registerAndLogin(portX1, `self-x-owner-${runId}@example.test`, 'SelfCrossOwner')
  const viewerX = await registerAndLogin(portX1, `self-x-viewer-${runId}@example.test`, 'SelfCrossViewer')
  setVip(isoX.dbFile, ownerX.profileId, sqliteDateAfter(30))
  insertTopic(isoX.dbFile, 'topic-self-cross', 'self-cross')

  const wsOwnerX = await openWs(portX1, ownerX.cookie)
  const wsViewerX = await openWs(portX2, viewerX.cookie)
  await subscribe(wsOwnerX, 'topic-self-cross')
  await subscribe(wsViewerX, 'topic-self-cross')

  const rootId = await postRoot(wsOwnerX, 'topic-self-cross', 'cross-instance self delete', 'self-cross-root')
  await waitForWsMessage(wsViewerX, (m) => m.type === 'topic_message' && m.messageId === rootId, 6000)

  await check('[X1] cross-instance own delete reaches subscriber on another instance', async () => {
    const res = await httpDeleteJson(portX1, `/api/topics/topic-self-cross/messages/${rootId}`, ownerX.cookie)
    assertEqual(res.status, 200, 'cross-instance delete status')
    const deleted = await waitForWsMessage(wsViewerX, (m) => m.type === 'topic_message_deleted' && m.messageId === rootId, 7000)
    assertEqual(deleted.topicId, 'topic-self-cross', 'cross-instance deleted topicId')
    assertEqual(deleted.parentMessageId, null, 'cross-instance root parentMessageId')
  })
} finally {
  if (srvX1) await stopSrv(srvX1)
  if (srvX2) await stopSrv(srvX2)
  await isoX.cleanup()
}

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) {
  process.exitCode = 1
}
