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
const PASSWORD = 'TopicMsgEditCheck1!'
const SERVER_READY_TIMEOUT_MS = 30_000

let passed = 0
let failed = 0

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) throw new Error(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
}

async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`  PASS  ${label}`)
  } catch (error) {
    failed++
    console.error(`  FAIL  ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

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
      srv.close(() => resolvePort(addr.port))
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
  const tmp = await mkdtemp(join(tmpdir(), 'belot-topic-message-edit-http-'))
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
  child.stdout.on('data', (chunk: string) => chunks.push(chunk))
  child.stderr.on('data', (chunk: string) => chunks.push(chunk))
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

async function httpPatchJson(port: number, pathname: string, cookie: string | undefined, body: unknown): Promise<HttpResult> {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  })
  let json: unknown = null
  try { json = await res.json() } catch { /* ignored */ }
  return { status: res.status, body: json }
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

function insertTopic(databaseFile: string, topicId: string, slug: string, status: 'active' | 'locked' | 'removed' = 'active'): void {
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
      status === 'removed' ? new Date(Date.now() - 60_000).toISOString() : null,
    )
  })
}

function insertMessage(databaseFile: string, input: {
  topicId: string
  senderProfileId: string
  senderDisplayName: string
  body: string
  parentMessageId?: string | null
  createdAt?: string
}): string {
  const messageId = randomUUID()
  withDb(databaseFile, (database) => {
    database.prepare(`
      INSERT INTO topic_messages (
        message_id, topic_id, parent_message_id, sender_profile_id, sender_display_name, sender_role, body, created_at
      ) VALUES (?, ?, ?, ?, ?, 'player', ?, ?);
    `).run(
      messageId,
      input.topicId,
      input.parentMessageId ?? null,
      input.senderProfileId,
      input.senderDisplayName,
      input.body,
      input.createdAt ?? new Date().toISOString(),
    )
  })
  return messageId
}

function getMessage(databaseFile: string, messageId: string): { body: string; edited_at: string | null } | null {
  return withDb(databaseFile, (database) => {
    const row = database.prepare(`SELECT body, edited_at FROM topic_messages WHERE message_id = ?;`).get(messageId) as
      | { body: string; edited_at: string | null }
      | undefined
    return row ?? null
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

console.log('\n=== Topic Message Edit Auth/Realtime ===\n')

const iso = await makeIsolated(serverRoot)
const port = await getFreePort()
let srv: ReturnType<typeof startSrv> | null = null

try {
  srv = startSrv(iso.serverDir, port)
  console.log(`  Waiting for server on port ${port}...`)
  await waitForServerReady(port)
  console.log('  Server is ready.\n')

  const runId = `${Date.now()}-${process.pid}`
  const owner = await registerAndLogin(port, `edit-owner-${runId}@example.test`, 'EditOwner')
  const other = await registerAndLogin(port, `edit-other-${runId}@example.test`, 'EditOther')
  const viewer = await registerAndLogin(port, `edit-viewer-${runId}@example.test`, 'EditViewer')

  insertTopic(iso.dbFile, 'topic-edit-auth', 'edit-auth')
  insertTopic(iso.dbFile, 'topic-edit-locked', 'edit-locked', 'locked')
  insertTopic(iso.dbFile, 'topic-edit-removed', 'edit-removed', 'removed')
  insertTopic(iso.dbFile, 'topic-edit-realtime', 'edit-realtime')

  await check('[A1] unauthenticated PATCH is denied', async () => {
    const messageId = insertMessage(iso.dbFile, {
      topicId: 'topic-edit-auth',
      senderProfileId: owner.profileId,
      senderDisplayName: 'EditOwner',
      body: 'anonymous cannot edit',
    })
    const res = await httpPatchJson(port, `/api/topics/topic-edit-auth/messages/${messageId}`, undefined, { body: 'edited' })
    assertEqual(res.status, 401, 'status')
  })

  await check('[A2] non-owner live message in same topic -> 403', async () => {
    const messageId = insertMessage(iso.dbFile, {
      topicId: 'topic-edit-auth',
      senderProfileId: owner.profileId,
      senderDisplayName: 'EditOwner',
      body: 'not yours',
    })
    const res = await httpPatchJson(port, `/api/topics/topic-edit-auth/messages/${messageId}`, other.cookie, { body: 'stolen' })
    assertEqual(res.status, 403, 'status')
    assertEqual(getMessage(iso.dbFile, messageId)?.body, 'not yours', 'body unchanged')
  })

  await check('[A3] owner root with live reply -> 409 has_live_replies', async () => {
    const rootId = insertMessage(iso.dbFile, {
      topicId: 'topic-edit-auth',
      senderProfileId: owner.profileId,
      senderDisplayName: 'EditOwner',
      body: 'root with reply',
    })
    insertMessage(iso.dbFile, {
      topicId: 'topic-edit-auth',
      parentMessageId: rootId,
      senderProfileId: other.profileId,
      senderDisplayName: 'EditOther',
      body: 'reply',
    })
    const res = await httpPatchJson(port, `/api/topics/topic-edit-auth/messages/${rootId}`, owner.cookie, { body: 'blocked' })
    const body = res.body as { code?: string }
    assertEqual(res.status, 409, 'status')
    assertEqual(body.code, 'has_live_replies', 'code')
  })

  await check('[A4] locked topic -> 409 topic_locked', async () => {
    const messageId = insertMessage(iso.dbFile, {
      topicId: 'topic-edit-locked',
      senderProfileId: owner.profileId,
      senderDisplayName: 'EditOwner',
      body: 'locked',
    })
    const res = await httpPatchJson(port, `/api/topics/topic-edit-locked/messages/${messageId}`, owner.cookie, { body: 'blocked' })
    const body = res.body as { code?: string }
    assertEqual(res.status, 409, 'status')
    assertEqual(body.code, 'topic_locked', 'code')
  })

  await check('[A5] removed topic -> 404', async () => {
    const messageId = insertMessage(iso.dbFile, {
      topicId: 'topic-edit-removed',
      senderProfileId: owner.profileId,
      senderDisplayName: 'EditOwner',
      body: 'removed',
    })
    const res = await httpPatchJson(port, `/api/topics/topic-edit-removed/messages/${messageId}`, owner.cookie, { body: 'blocked' })
    assertEqual(res.status, 404, 'status')
  })

  await check('[A6] wrong topic/message pair -> 404', async () => {
    const messageId = insertMessage(iso.dbFile, {
      topicId: 'topic-edit-auth',
      senderProfileId: owner.profileId,
      senderDisplayName: 'EditOwner',
      body: 'wrong pair',
    })
    const res = await httpPatchJson(port, `/api/topics/topic-edit-realtime/messages/${messageId}`, owner.cookie, { body: 'wrong' })
    assertEqual(res.status, 404, 'status')
  })

  await check('[A7] invalid body -> 400 empty_body and no edit event', async () => {
    const messageId = insertMessage(iso.dbFile, {
      topicId: 'topic-edit-auth',
      senderProfileId: owner.profileId,
      senderDisplayName: 'EditOwner',
      body: 'valid',
    })
    const before = countRows(iso.dbFile, `SELECT COUNT(*) AS c FROM topic_message_edit_events WHERE message_id = ?;`, messageId)
    const res = await httpPatchJson(port, `/api/topics/topic-edit-auth/messages/${messageId}`, owner.cookie, { body: '   ' })
    const after = countRows(iso.dbFile, `SELECT COUNT(*) AS c FROM topic_message_edit_events WHERE message_id = ?;`, messageId)
    const body = res.body as { code?: string }
    assertEqual(res.status, 400, 'status')
    assertEqual(body.code, 'empty_body', 'code')
    assertEqual(after, before, 'edit events')
  })

  await check('[A8] owner PATCH succeeds, normalizes body, sets edited_at and event', async () => {
    const messageId = insertMessage(iso.dbFile, {
      topicId: 'topic-edit-auth',
      senderProfileId: owner.profileId,
      senderDisplayName: 'EditOwner',
      body: 'before edit',
    })
    const res = await httpPatchJson(port, `/api/topics/topic-edit-auth/messages/${messageId}`, owner.cookie, { body: '  after edit  ' })
    const body = res.body as { ok?: boolean; body?: string; editedAt?: string | null; changed?: boolean }
    const dbRow = getMessage(iso.dbFile, messageId)
    assertEqual(res.status, 200, 'status')
    assertEqual(body.ok, true, 'ok')
    assertEqual(body.body, 'after edit', 'response body')
    assertEqual(body.changed, true, 'changed')
    assert(dbRow?.edited_at !== null, 'edited_at should be set')
    assertEqual(countRows(iso.dbFile, `SELECT COUNT(*) AS c FROM topic_message_edit_events WHERE message_id = ?;`, messageId), 1, 'edit events')
  })

  await check('[A9] no-op PATCH succeeds without new edit event', async () => {
    const messageId = insertMessage(iso.dbFile, {
      topicId: 'topic-edit-auth',
      senderProfileId: owner.profileId,
      senderDisplayName: 'EditOwner',
      body: 'same',
    })
    const before = countRows(iso.dbFile, `SELECT COUNT(*) AS c FROM topic_message_edit_events WHERE message_id = ?;`, messageId)
    const res = await httpPatchJson(port, `/api/topics/topic-edit-auth/messages/${messageId}`, owner.cookie, { body: 'same' })
    const body = res.body as { changed?: boolean; editedAt?: string | null }
    const after = countRows(iso.dbFile, `SELECT COUNT(*) AS c FROM topic_message_edit_events WHERE message_id = ?;`, messageId)
    assertEqual(res.status, 200, 'status')
    assertEqual(body.changed, false, 'changed')
    assertEqual(body.editedAt ?? null, null, 'editedAt')
    assertEqual(after, before, 'edit events')
  })

  await check('[E1] same-instance PATCH broadcasts topic_message_edited', async () => {
    const wsViewer = await openWs(port, viewer.cookie)
    await subscribe(wsViewer, 'topic-edit-realtime')
    const messageId = insertMessage(iso.dbFile, {
      topicId: 'topic-edit-realtime',
      senderProfileId: owner.profileId,
      senderDisplayName: 'EditOwner',
      body: 'realtime before',
    })
    const res = await httpPatchJson(port, `/api/topics/topic-edit-realtime/messages/${messageId}`, owner.cookie, { body: 'realtime after' })
    assertEqual(res.status, 200, 'status')
    const edited = await waitForWsMessage(wsViewer, (m) => m.type === 'topic_message_edited' && m.messageId === messageId)
    assertEqual(edited.topicId, 'topic-edit-realtime', 'topicId')
    assertEqual(edited.parentMessageId, null, 'parentMessageId')
    assertEqual(edited.body, 'realtime after', 'body')
    assert(typeof edited.editedAt === 'string' && edited.editedAt.length > 0, 'editedAt should be present')
    wsViewer.close()
  })
} finally {
  if (srv) {
    await stopSrv(srv)
    const output = srv.output()
    if (failed > 0 && output.trim()) {
      console.error('\n--- server output ---')
      console.error(output.trim())
    }
  }
  await iso.cleanup()
}

console.log(`\nTopic message edit auth/realtime checks: ${passed} passed, ${failed} failed.`)
if (failed > 0) process.exitCode = 1
