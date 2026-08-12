/**
 * checkTopicModerationAuthRealtime.ts
 *
 * HTTP/WS integration checks за Topics moderation (Етап 4) — real spawn-нат
 * сървър, изолирана SQLite база, реални HTTP + WS заявки. Established
 * harness pattern (виж checkTopicMessagesRealtime.ts/checkLobbyChat.ts).
 *
 * === Section A: Role authorization ===
 * [A1]  admin МОЖЕ да заключи тема (200)
 * [A2]  subadmin МОЖЕ да заключи тема (200)
 * [A3]  pika_team НЕ МОЖЕ да заключи тема (403) — whole-topic lock/unlock/delete
 *       е admin/subadmin/top_chat_admin само (corrective pass — виж Section AA)
 * [A4]  top_chat_admin МОЖЕ да заключи тема (200)
 * [A5]  Обикновен player НЕ МОЖЕ да заключи тема (403)
 * [A6]  VIP player (не moderator role) НЕ МОЖЕ да заключи тема (403) — VIP ≠ moderator
 * [A7]  Guest/temporary profile НЕ МОЖЕ да заключи тема (403)
 * [A8]  Unauthenticated (без сесия) НЕ МОЖЕ да заключи тема (401/403)
 *
 * === Section AA: Whole-topic role matrix (corrective pass — lock/unlock/delete
 * е по-тесен permission set от mute/unmute/reports/audit, isTopicWholeTopicModeratorSession) ===
 * [AA1-3]   admin МОЖЕ lock/unlock/delete
 * [AA4-6]   subadmin МОЖЕ lock/unlock/delete
 * [AA7-9]   top_chat_admin МОЖЕ lock/unlock/delete
 * [AA10-12] pika_team НЕ МОЖЕ lock/unlock/delete (403)
 * [AA13-15] chat_admin НЕ МОЖЕ lock/unlock/delete (403)
 * [AA16]    pika_team продължава да МОЖЕ mute/unmute (непроменена политика)
 * [AA17]    pika_team продължава да МОЖЕ reports list + audit log (непроменена политика)
 *
 * === Section B: Locked topic blocks writes ===
 * [B1]  Locked topic блокира root post (WS send_topic_message -> topic_locked)
 * [B2]  Locked topic блокира reply (WS send_topic_reply -> topic_locked)
 * [B3]  Locked topic ПОЗВОЛЯВА четене (GET messages все още връща 200 + темата се вижда в listActiveTopics)
 *
 * === Section C: Muted user blocks writes (topic-specific) ===
 * [C1]  Muted user не може да пише root post в темата, в която е muted (topic_muted)
 * [C2]  Muted user не може да пише reply в темата, в която е muted (topic_muted)
 * [C3]  Muted user МОЖЕ да пише в ДРУГА тема (mute е topic-specific, не global)
 *
 * === Section D: Expiry / early unlock / unmute restore write access ===
 * [D1]  Ръчен unlock ПРЕДИ expiry веднага възстановява write достъп
 * [D2]  Ръчен unmute ПРЕДИ expiry веднага възстановява write достъп
 *
 * === Section E: Realtime notifications ===
 * [E1]  Lock: ВСИЧКИ subscribers на темата получават topic_lock_state_changed
 * [E2]  Unlock: subscribers получават topic_lock_state_changed с isLocked=false
 * [E3]  Mute: САМО target-ът получава topic_mute_state_changed (друг subscriber НЕ получава)
 * [E4]  Delete: subscribers получават topic_deleted
 *
 * === Section F: Report identity + persistence ===
 * [F1]  Report reporter identity идва от session (client-provided profileId в body се игнорира)
 * [F2]  Report persist-ва — admin GET /api/admin/topic-reports вижда pending report-а
 * [F3]  Duplicate report (същия reporter+topic бързо) -> 409 topic_report_duplicate
 * [F4]  Invalid/несъществуваща тема -> 404 при report опит
 *
 * === Section G: Concurrency / idempotency (HTTP-level) ===
 * [G1]  Втори lock (докато вече е locked) презаписва duration/reason, все още 200
 * [G2]  Unlock на вече unlocked тема -> 200, идемпотентно (не грешка)
 * [G3]  Unmute на вече unmuted профил -> 200, идемпотентно
 * [G4]  Delete на вече изтрита тема -> 200 идемпотентно (already_removed третиран като success навън, симетрично на unlock/unmute)
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
const PASSWORD = 'TopicModerationCheck1!'

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
  const tmp = await mkdtemp(join(tmpdir(), 'belot-topic-moderation-http-'))
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

async function httpDeleteJson(port: number, pathname: string, cookie: string | undefined, payload: unknown): Promise<HttpResult> {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: 'DELETE',
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

function promoteAccount(databaseFile: string, email: string, role: 'admin' | 'subadmin' | 'pika_team' | 'top_chat_admin' | 'chat_admin'): void {
  const database = new DatabaseSync(databaseFile, { open: true, enableForeignKeyConstraints: true })
  try {
    database.exec('PRAGMA journal_mode = WAL;')
    database.prepare(`UPDATE accounts SET role = ?, updated_at = CURRENT_TIMESTAMP WHERE email = ?;`).run(role, email)
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

async function assertNoWsMessage(ws: WebSocket, predicate: (msg: AnyMsg) => boolean, waitMs = 800): Promise<void> {
  await sleep(waitMs)
  const buffer = wsMessageBuffers.get(ws) ?? []
  assert(!buffer.some(predicate), 'очаквано НИКАКВО съобщение да не match-не предиката, но такова беше намерено')
}

// ─── Setup: единична изолирана инстанция, споделена между секциите ─────────

console.log('\n=== Topic Moderation Auth/Realtime (single instance) ===\n')

const iso = await makeIsolated(serverRoot)
const port = await getFreePort()
let srv: { child: ChildProcessWithoutNullStreams; output(): string } | null = null

try {
  srv = startSrv(iso.serverDir, port)
  console.log(`  Чакам сървъра на порт ${port}…`)
  await waitForServerReady(port)
  console.log('  Сървърът е готов.\n')

  const runId = `${Date.now()}-${process.pid}`

  const admin = await registerAndLogin(port, `tmod-admin-${runId}@example.test`, 'AdminUser')
  const subadmin = await registerAndLogin(port, `tmod-subadmin-${runId}@example.test`, 'SubadminUser')
  const pikaTeam = await registerAndLogin(port, `tmod-pikateam-${runId}@example.test`, 'PikaTeamUser')
  const topChatAdmin = await registerAndLogin(port, `tmod-topchatadmin-${runId}@example.test`, 'TopChatAdminUser')
  const chatAdmin = await registerAndLogin(port, `tmod-chatadmin-${runId}@example.test`, 'ChatAdminUser')
  const normalPlayer = await registerAndLogin(port, `tmod-player-${runId}@example.test`, 'NormalPlayer')
  const vipPlayer = await registerAndLogin(port, `tmod-vip-${runId}@example.test`, 'VipPlayer')
  const targetUser = await registerAndLogin(port, `tmod-target-${runId}@example.test`, 'TargetUser')
  const bystander = await registerAndLogin(port, `tmod-bystander-${runId}@example.test`, 'BystanderUser')

  promoteAccount(iso.dbFile, `tmod-admin-${runId}@example.test`, 'admin')
  promoteAccount(iso.dbFile, `tmod-subadmin-${runId}@example.test`, 'subadmin')
  promoteAccount(iso.dbFile, `tmod-pikateam-${runId}@example.test`, 'pika_team')
  promoteAccount(iso.dbFile, `tmod-topchatadmin-${runId}@example.test`, 'top_chat_admin')
  promoteAccount(iso.dbFile, `tmod-chatadmin-${runId}@example.test`, 'chat_admin')
  grantVip(iso.dbFile, vipPlayer.profileId)

  insertExtraTopic(iso.dbFile, 'topic-lock-test', 'lock-test', 'Lock Test Topic')
  insertExtraTopic(iso.dbFile, 'topic-mute-test-a', 'mute-test-a', 'Mute Test Topic A')
  insertExtraTopic(iso.dbFile, 'topic-mute-test-b', 'mute-test-b', 'Mute Test Topic B')
  insertExtraTopic(iso.dbFile, 'topic-delete-test', 'delete-test', 'Delete Test Topic')
  insertExtraTopic(iso.dbFile, 'topic-realtime-test', 'realtime-test', 'Realtime Test Topic')
  insertExtraTopic(iso.dbFile, 'topic-idempotency-test', 'idempotency-test', 'Idempotency Test Topic')
  insertExtraTopic(iso.dbFile, 'topic-report-test', 'report-test', 'Report Test Topic')
  insertExtraTopic(iso.dbFile, 'topic-whole-topic-matrix-test', 'whole-topic-matrix-test', 'Whole Topic Matrix Test Topic')
  grantVip(iso.dbFile, targetUser.profileId)
  grantVip(iso.dbFile, normalPlayer.profileId)

  console.log('=== Section A: Role authorization ===\n')

  await check('[A1] admin МОЖЕ да заключи тема (200)', async () => {
    const r = await httpPostJson(port, '/api/topics/topic-lock-test/lock', admin.cookie, { reason: 'test', durationMs: 30 * 60 * 1000 })
    assert(r.status === 200, `очаквано 200, получено ${r.status}`)
    await httpPostJson(port, '/api/topics/topic-lock-test/unlock', admin.cookie, {})
  })

  await check('[A2] subadmin МОЖЕ да заключи тема (200)', async () => {
    const r = await httpPostJson(port, '/api/topics/topic-lock-test/lock', subadmin.cookie, { reason: 'test', durationMs: 30 * 60 * 1000 })
    assert(r.status === 200, `очаквано 200, получено ${r.status}`)
    await httpPostJson(port, '/api/topics/topic-lock-test/unlock', subadmin.cookie, {})
  })

  await check('[A3] pika_team НЕ МОЖЕ да заключи тема (403) — whole-topic lock/unlock/delete е admin/subadmin/top_chat_admin само (corrective pass)', async () => {
    const r = await httpPostJson(port, '/api/topics/topic-lock-test/lock', pikaTeam.cookie, { reason: 'test', durationMs: 30 * 60 * 1000 })
    assert(r.status === 403, `очаквано 403 за pika_team whole-topic lock, получено ${r.status}`)
  })

  await check('[A4] top_chat_admin МОЖЕ да заключи тема (200)', async () => {
    const r = await httpPostJson(port, '/api/topics/topic-lock-test/lock', topChatAdmin.cookie, { reason: 'test', durationMs: 30 * 60 * 1000 })
    assert(r.status === 200, `очаквано 200, получено ${r.status}`)
    await httpPostJson(port, '/api/topics/topic-lock-test/unlock', topChatAdmin.cookie, {})
  })

  await check('[A5] Обикновен player НЕ МОЖЕ да заключи тема (403)', async () => {
    const r = await httpPostJson(port, '/api/topics/topic-lock-test/lock', normalPlayer.cookie, { reason: 'test', durationMs: 30 * 60 * 1000 })
    assert(r.status === 403, `очаквано 403, получено ${r.status}`)
  })

  await check('[A6] VIP player (не moderator role) НЕ МОЖЕ да заключи тема (403) — VIP ≠ moderator', async () => {
    const r = await httpPostJson(port, '/api/topics/topic-lock-test/lock', vipPlayer.cookie, { reason: 'test', durationMs: 30 * 60 * 1000 })
    assert(r.status === 403, `очаквано 403 за VIP-но-не-модератор, получено ${r.status}`)
  })

  await check('[A7] Guest/temporary profile НЕ МОЖЕ да заключи тема (403)', async () => {
    const guestRes = await fetch(`http://127.0.0.1:${port}/api/guest/trial-status`, { method: 'GET' })
    const h = guestRes.headers as Headers & { getSetCookie?: () => string[] }
    const guestCookie = (h.getSetCookie?.()[0] ?? guestRes.headers.get('set-cookie'))?.split(';')[0]
    const r = await httpPostJson(port, '/api/topics/topic-lock-test/lock', guestCookie, { reason: 'test', durationMs: 30 * 60 * 1000 })
    assert(r.status === 403 || r.status === 401, `очаквано 401/403 за guest, получено ${r.status}`)
  })

  await check('[A8] Unauthenticated (без сесия) НЕ МОЖЕ да заключи тема (401/403)', async () => {
    const r = await httpPostJson(port, '/api/topics/topic-lock-test/lock', undefined, { reason: 'test', durationMs: 30 * 60 * 1000 })
    assert(r.status === 401 || r.status === 403, `очаквано 401/403, получено ${r.status}`)
  })

  console.log('\n=== Section AA: Whole-topic role matrix (lock/unlock/delete) — corrective pass ===\n')

  // Собствена тема per allowed role (unlock изисква вече locked; delete
  // консумира темата), за да не кръстосват тестовете състояние помежду си.
  insertExtraTopic(iso.dbFile, 'topic-matrix-admin', 'matrix-admin', 'Matrix Admin Topic')
  insertExtraTopic(iso.dbFile, 'topic-matrix-subadmin', 'matrix-subadmin', 'Matrix Subadmin Topic')
  insertExtraTopic(iso.dbFile, 'topic-matrix-topchatadmin', 'matrix-topchatadmin', 'Matrix TopChatAdmin Topic')

  await check('[AA1] admin МОЖЕ lock (200)', async () => {
    const r = await httpPostJson(port, '/api/topics/topic-matrix-admin/lock', admin.cookie, { reason: 'matrix', durationMs: 30 * 60 * 1000 })
    assert(r.status === 200, `очаквано 200, получено ${r.status}`)
  })

  await check('[AA2] admin МОЖЕ unlock (200)', async () => {
    const r = await httpPostJson(port, '/api/topics/topic-matrix-admin/unlock', admin.cookie, {})
    assert(r.status === 200, `очаквано 200, получено ${r.status}`)
  })

  await check('[AA3] admin МОЖЕ delete (200)', async () => {
    const r = await httpDeleteJson(port, '/api/topics/topic-matrix-admin', admin.cookie, { reason: 'matrix delete' })
    assert(r.status === 200, `очаквано 200, получено ${r.status}`)
  })

  await check('[AA4] subadmin МОЖЕ lock (200)', async () => {
    const r = await httpPostJson(port, '/api/topics/topic-matrix-subadmin/lock', subadmin.cookie, { reason: 'matrix', durationMs: 30 * 60 * 1000 })
    assert(r.status === 200, `очаквано 200, получено ${r.status}`)
  })

  await check('[AA5] subadmin МОЖЕ unlock (200)', async () => {
    const r = await httpPostJson(port, '/api/topics/topic-matrix-subadmin/unlock', subadmin.cookie, {})
    assert(r.status === 200, `очаквано 200, получено ${r.status}`)
  })

  await check('[AA6] subadmin МОЖЕ delete (200)', async () => {
    const r = await httpDeleteJson(port, '/api/topics/topic-matrix-subadmin', subadmin.cookie, { reason: 'matrix delete' })
    assert(r.status === 200, `очаквано 200, получено ${r.status}`)
  })

  await check('[AA7] top_chat_admin МОЖЕ lock (200)', async () => {
    const r = await httpPostJson(port, '/api/topics/topic-matrix-topchatadmin/lock', topChatAdmin.cookie, { reason: 'matrix', durationMs: 30 * 60 * 1000 })
    assert(r.status === 200, `очаквано 200, получено ${r.status}`)
  })

  await check('[AA8] top_chat_admin МОЖЕ unlock (200)', async () => {
    const r = await httpPostJson(port, '/api/topics/topic-matrix-topchatadmin/unlock', topChatAdmin.cookie, {})
    assert(r.status === 200, `очаквано 200, получено ${r.status}`)
  })

  await check('[AA9] top_chat_admin МОЖЕ delete (200)', async () => {
    const r = await httpDeleteJson(port, '/api/topics/topic-matrix-topchatadmin', topChatAdmin.cookie, { reason: 'matrix delete' })
    assert(r.status === 200, `очаквано 200, получено ${r.status}`)
  })

  await check('[AA10] pika_team НЕ МОЖЕ lock (403)', async () => {
    const r = await httpPostJson(port, '/api/topics/topic-whole-topic-matrix-test/lock', pikaTeam.cookie, { reason: 'matrix', durationMs: 30 * 60 * 1000 })
    assert(r.status === 403, `очаквано 403, получено ${r.status}`)
  })

  await check('[AA11] pika_team НЕ МОЖЕ unlock (403)', async () => {
    // Заключваме с admin, за да тестваме unlock отказа отделно от lock отказа.
    await httpPostJson(port, '/api/topics/topic-whole-topic-matrix-test/lock', admin.cookie, { reason: 'setup for AA11', durationMs: 30 * 60 * 1000 })
    const r = await httpPostJson(port, '/api/topics/topic-whole-topic-matrix-test/unlock', pikaTeam.cookie, {})
    assert(r.status === 403, `очаквано 403, получено ${r.status}`)
    await httpPostJson(port, '/api/topics/topic-whole-topic-matrix-test/unlock', admin.cookie, {})
  })

  await check('[AA12] pika_team НЕ МОЖЕ delete (403)', async () => {
    const r = await httpDeleteJson(port, '/api/topics/topic-whole-topic-matrix-test', pikaTeam.cookie, { reason: 'matrix delete attempt' })
    assert(r.status === 403, `очаквано 403, получено ${r.status}`)
  })

  await check('[AA13] chat_admin НЕ МОЖЕ lock (403)', async () => {
    const r = await httpPostJson(port, '/api/topics/topic-whole-topic-matrix-test/lock', chatAdmin.cookie, { reason: 'matrix', durationMs: 30 * 60 * 1000 })
    assert(r.status === 403, `очаквано 403, получено ${r.status}`)
  })

  await check('[AA14] chat_admin НЕ МОЖЕ unlock (403)', async () => {
    await httpPostJson(port, '/api/topics/topic-whole-topic-matrix-test/lock', admin.cookie, { reason: 'setup for AA14', durationMs: 30 * 60 * 1000 })
    const r = await httpPostJson(port, '/api/topics/topic-whole-topic-matrix-test/unlock', chatAdmin.cookie, {})
    assert(r.status === 403, `очаквано 403, получено ${r.status}`)
    await httpPostJson(port, '/api/topics/topic-whole-topic-matrix-test/unlock', admin.cookie, {})
  })

  await check('[AA15] chat_admin НЕ МОЖЕ delete (403)', async () => {
    const r = await httpDeleteJson(port, '/api/topics/topic-whole-topic-matrix-test', chatAdmin.cookie, { reason: 'matrix delete attempt' })
    assert(r.status === 403, `очаквано 403, получено ${r.status}`)
  })

  await check('[AA16] existing mute permissions НЕ са неволно променени — pika_team продължава да МОЖЕ mute', async () => {
    const r = await httpPostJson(port, '/api/topics/topic-whole-topic-matrix-test/mute', pikaTeam.cookie, { profileId: bystander.profileId, reason: 'matrix mute check', durationMs: 30 * 60 * 1000 })
    assert(r.status === 200, `очаквано 200 (mute permissions непроменени за pika_team), получено ${r.status}`)
    await httpPostJson(port, '/api/topics/topic-whole-topic-matrix-test/unmute', pikaTeam.cookie, { profileId: bystander.profileId })
  })

  await check('[AA17] existing reports/audit permissions НЕ са неволно променени — pika_team продължава да МОЖЕ GET reports list и audit log', async () => {
    const reportsRes = await httpGetJson(port, '/api/admin/topic-reports', pikaTeam.cookie)
    assert(reportsRes.status === 200, `очаквано 200 за reports list (pika_team), получено ${reportsRes.status}`)
    const auditRes = await httpGetJson(port, '/api/admin/topics/topic-whole-topic-matrix-test/moderation-log', pikaTeam.cookie)
    assert(auditRes.status === 200, `очаквано 200 за audit log (pika_team), получено ${auditRes.status}`)
  })

  console.log('\n=== Section B: Locked topic blocks writes ===\n')

  const wsNormal = await openWs(port, normalPlayer.cookie)
  const wsTarget = await openWs(port, targetUser.cookie)

  // Broadcast-ите за успешен send стигат ТОЧНО до topic subscribers-и (виж
  // broadcastTopicMessageToLocalSubscribers в index.ts — итерира само през
  // topicMessageSubscribersByTopicId Set-а, дори за самия originator) — за
  // разлика от error responses (изпратени directno до connection.id,
  // независимо от subscription state). Затова subscribe е задължителен ПРЕДИ
  // всеки WS send тест, който очаква да види собствения си successful `topic_message` ack.
  sendWs(wsNormal, { type: 'subscribe_topic_messages', topicId: 'topic-lock-test', afterSeq: 0 })
  await waitForWsMessage(wsNormal, (m) => m.type === 'topic_message_catchup' && m.topicId === 'topic-lock-test')

  await check('[B1] Locked topic блокира root post (WS send_topic_message -> topic_locked)', async () => {
    await httpPostJson(port, '/api/topics/topic-lock-test/lock', admin.cookie, { reason: 'testing lock', durationMs: 30 * 60 * 1000 })
    sendWs(wsNormal, { type: 'send_topic_message', topicId: 'topic-lock-test', body: 'blocked message', requestId: 'req-lock-b1' })
    const err = await waitForWsMessage(wsNormal, (m) => m.type === 'topic_message_error' && m.requestId === 'req-lock-b1')
    assertEqual(err.code, 'topic_locked', `очаквано topic_locked, получено ${String(err.code)}`)
  })

  let lockTestRootMessageId = ''
  await check('[B2] Locked topic блокира reply (WS send_topic_reply -> topic_locked)', async () => {
    await httpPostJson(port, '/api/topics/topic-lock-test/unlock', admin.cookie, {})
    sendWs(wsNormal, { type: 'send_topic_message', topicId: 'topic-lock-test', body: 'root for reply test', requestId: 'req-lock-root' })
    const rootMsg = await waitForWsMessage(wsNormal, (m) => m.type === 'topic_message' && m.requestId === 'req-lock-root')
    lockTestRootMessageId = String(rootMsg.messageId)

    await httpPostJson(port, '/api/topics/topic-lock-test/lock', admin.cookie, { reason: 'lock again', durationMs: 30 * 60 * 1000 })
    sendWs(wsNormal, { type: 'send_topic_reply', topicId: 'topic-lock-test', parentMessageId: lockTestRootMessageId, body: 'blocked reply', requestId: 'req-lock-b2' })
    const err = await waitForWsMessage(wsNormal, (m) => m.type === 'topic_reply_error' && m.requestId === 'req-lock-b2')
    assertEqual(err.code, 'topic_locked', `очаквано topic_locked, получено ${String(err.code)}`)
  })

  await check('[B3] Locked topic ПОЗВОЛЯВА четене (GET messages все още връща 200 + темата се вижда в listActiveTopics)', async () => {
    const messagesRes = await httpGetJson(port, '/api/topics/topic-lock-test/messages', normalPlayer.cookie)
    assert(messagesRes.status === 200, `GET messages трябва да работи докато е locked, получено ${messagesRes.status}`)
    const topicsRes = await httpGetJson(port, '/api/topics', normalPlayer.cookie)
    const topics = (topicsRes.body as { topics?: Array<{ topicId: string }> }).topics ?? []
    assert(topics.some((t) => t.topicId === 'topic-lock-test'), 'locked темата трябва да остане видима в listActiveTopics')
    await httpPostJson(port, '/api/topics/topic-lock-test/unlock', admin.cookie, {})
  })

  console.log('\n=== Section C: Muted user blocks writes (topic-specific) ===\n')

  await check('[C1] Muted user не може да пише root post в темата, в която е muted', async () => {
    await httpPostJson(port, '/api/topics/topic-mute-test-a/mute', admin.cookie, { profileId: targetUser.profileId, reason: 'spam', durationMs: 30 * 60 * 1000 })
    sendWs(wsTarget, { type: 'send_topic_message', topicId: 'topic-mute-test-a', body: 'muted attempt', requestId: 'req-mute-c1' })
    const err = await waitForWsMessage(wsTarget, (m) => m.type === 'topic_message_error' && m.requestId === 'req-mute-c1')
    assertEqual(err.code, 'topic_muted', `очаквано topic_muted, получено ${String(err.code)}`)
  })

  let muteTestRootMessageId = ''
  await check('[C2] Muted user не може да пише reply в темата, в която е muted', async () => {
    // wsNormal е subscribed за topic-lock-test (виж Section B setup) — само
    // ЕДНА активна subscription/connection (established Topics constraint,
    // виж topicMessageSubscriberTopicIdByConnectionId в index.ts). Re-subscribe
    // към topic-mute-test-a, за да получи собствения си successful ack тук.
    sendWs(wsNormal, { type: 'subscribe_topic_messages', topicId: 'topic-mute-test-a', afterSeq: 0 })
    await waitForWsMessage(wsNormal, (m) => m.type === 'topic_message_catchup' && m.topicId === 'topic-mute-test-a')
    sendWs(wsNormal, { type: 'send_topic_message', topicId: 'topic-mute-test-a', body: 'root for mute reply test', requestId: 'req-mute-root' })
    const rootMsg = await waitForWsMessage(wsNormal, (m) => m.type === 'topic_message' && m.requestId === 'req-mute-root')
    muteTestRootMessageId = String(rootMsg.messageId)

    sendWs(wsTarget, { type: 'send_topic_reply', topicId: 'topic-mute-test-a', parentMessageId: muteTestRootMessageId, body: 'muted reply attempt', requestId: 'req-mute-c2' })
    const err = await waitForWsMessage(wsTarget, (m) => m.type === 'topic_reply_error' && m.requestId === 'req-mute-c2')
    assertEqual(err.code, 'topic_muted', `очаквано topic_muted, получено ${String(err.code)}`)
  })

  await check('[C3] Muted user МОЖЕ да пише в ДРУГА тема (mute е topic-specific, не global)', async () => {
    sendWs(wsTarget, { type: 'subscribe_topic_messages', topicId: 'topic-mute-test-b', afterSeq: 0 })
    await waitForWsMessage(wsTarget, (m) => m.type === 'topic_message_catchup' && m.topicId === 'topic-mute-test-b')
    sendWs(wsTarget, { type: 'send_topic_message', topicId: 'topic-mute-test-b', body: 'allowed in other topic', requestId: 'req-mute-c3' })
    const result = await waitForWsMessage(wsTarget, (m) => (m.type === 'topic_message' || m.type === 'topic_message_error') && m.requestId === 'req-mute-c3')
    assertEqual(result.type, 'topic_message', `очаквано успешен send в друга тема, получено ${result.type}/${String((result as { code?: string }).code)}`)
  })

  console.log('\n=== Section D: Expiry / early unlock / unmute restore write access ===\n')

  await check('[D1] Ръчен unlock ПРЕДИ expiry веднага възстановява write достъп', async () => {
    await httpPostJson(port, '/api/topics/topic-lock-test/lock', admin.cookie, { reason: 'd1 test', durationMs: 24 * 60 * 60 * 1000 })
    const unlockRes = await httpPostJson(port, '/api/topics/topic-lock-test/unlock', admin.cookie, {})
    assert(unlockRes.status === 200, `unlock трябва да успее, получено ${unlockRes.status}`)

    // wsNormal последно е бил re-subscribe-нат за topic-mute-test-a (Section
    // C) — само 1 активна subscription/connection, трябва обратно re-subscribe.
    sendWs(wsNormal, { type: 'subscribe_topic_messages', topicId: 'topic-lock-test', afterSeq: 0 })
    await waitForWsMessage(wsNormal, (m) => m.type === 'topic_message_catchup' && m.topicId === 'topic-lock-test')
    sendWs(wsNormal, { type: 'send_topic_message', topicId: 'topic-lock-test', body: 'after unlock', requestId: 'req-d1' })
    const result = await waitForWsMessage(wsNormal, (m) => (m.type === 'topic_message' || m.type === 'topic_message_error') && m.requestId === 'req-d1')
    assertEqual(result.type, 'topic_message', `очаквано успешен send след unlock, получено ${result.type}/${String((result as { code?: string }).code)}`)
  })

  await check('[D2] Ръчен unmute ПРЕДИ expiry веднага възстановява write достъп', async () => {
    const unmuteRes = await httpPostJson(port, '/api/topics/topic-mute-test-a/unmute', admin.cookie, { profileId: targetUser.profileId })
    assert(unmuteRes.status === 200, `unmute трябва да успее, получено ${unmuteRes.status}`)

    // wsTarget последно е бил subscribe-нат за topic-mute-test-b (Section C3).
    sendWs(wsTarget, { type: 'subscribe_topic_messages', topicId: 'topic-mute-test-a', afterSeq: 0 })
    await waitForWsMessage(wsTarget, (m) => m.type === 'topic_message_catchup' && m.topicId === 'topic-mute-test-a')
    sendWs(wsTarget, { type: 'send_topic_message', topicId: 'topic-mute-test-a', body: 'after unmute', requestId: 'req-d2' })
    const result = await waitForWsMessage(wsTarget, (m) => (m.type === 'topic_message' || m.type === 'topic_message_error') && m.requestId === 'req-d2')
    assertEqual(result.type, 'topic_message', `очаквано успешен send след unmute, получено ${result.type}/${String((result as { code?: string }).code)}`)
  })

  console.log('\n=== Section E: Realtime notifications ===\n')

  const wsBystander = await openWs(port, bystander.cookie)
  sendWs(wsNormal, { type: 'subscribe_topic_messages', topicId: 'topic-realtime-test', afterSeq: 0 })
  await waitForWsMessage(wsNormal, (m) => m.type === 'topic_message_catchup')
  sendWs(wsBystander, { type: 'subscribe_topic_messages', topicId: 'topic-realtime-test', afterSeq: 0 })
  await waitForWsMessage(wsBystander, (m) => m.type === 'topic_message_catchup')

  await check('[E1] Lock: ВСИЧКИ subscribers на темата получават topic_lock_state_changed', async () => {
    await httpPostJson(port, '/api/topics/topic-realtime-test/lock', admin.cookie, { reason: 'realtime test', durationMs: 30 * 60 * 1000 })
    const notify1 = await waitForWsMessage(wsNormal, (m) => m.type === 'topic_lock_state_changed' && m.topicId === 'topic-realtime-test')
    const notify2 = await waitForWsMessage(wsBystander, (m) => m.type === 'topic_lock_state_changed' && m.topicId === 'topic-realtime-test')
    assertEqual(notify1.isLocked, true, 'notify1 isLocked трябва да е true')
    assertEqual(notify2.isLocked, true, 'notify2 isLocked трябва да е true')
  })

  await check('[E2] Unlock: subscribers получават topic_lock_state_changed с isLocked=false', async () => {
    await httpPostJson(port, '/api/topics/topic-realtime-test/unlock', admin.cookie, {})
    const notify = await waitForWsMessage(wsNormal, (m) => m.type === 'topic_lock_state_changed' && m.topicId === 'topic-realtime-test' && m.isLocked === false)
    assertEqual(notify.isLocked, false, 'isLocked трябва да е false след unlock')
  })

  await check('[E3] Mute: САМО target-ът получава topic_mute_state_changed (друг subscriber НЕ получава)', async () => {
    sendWs(wsTarget, { type: 'subscribe_topic_messages', topicId: 'topic-realtime-test', afterSeq: 0 })
    await waitForWsMessage(wsTarget, (m) => m.type === 'topic_message_catchup')

    await httpPostJson(port, '/api/topics/topic-realtime-test/mute', admin.cookie, { profileId: targetUser.profileId, reason: 'e3 test', durationMs: 30 * 60 * 1000 })
    const targetNotify = await waitForWsMessage(wsTarget, (m) => m.type === 'topic_mute_state_changed' && m.topicId === 'topic-realtime-test')
    assertEqual(targetNotify.isMuted, true, 'target трябва да получи isMuted=true')

    await assertNoWsMessage(wsBystander, (m) => m.type === 'topic_mute_state_changed')
    await httpPostJson(port, '/api/topics/topic-realtime-test/unmute', admin.cookie, { profileId: targetUser.profileId })
  })

  await check('[E4] Delete: subscribers получават topic_deleted', async () => {
    const deleteRes = await httpDeleteJson(port, '/api/topics/topic-realtime-test', admin.cookie, { reason: 'e4 test' })
    assert(deleteRes.status === 200, `delete трябва да успее, получено ${deleteRes.status}`)
    const notify1 = await waitForWsMessage(wsNormal, (m) => m.type === 'topic_deleted' && m.topicId === 'topic-realtime-test')
    const notify2 = await waitForWsMessage(wsBystander, (m) => m.type === 'topic_deleted' && m.topicId === 'topic-realtime-test')
    assert(notify1.type === 'topic_deleted', 'notify1 трябва да е topic_deleted')
    assert(notify2.type === 'topic_deleted', 'notify2 трябва да е topic_deleted')
  })

  console.log('\n=== Section F: Report identity + persistence ===\n')

  await check('[F1] Report reporter identity идва от session (client-provided profileId в body се игнорира)', async () => {
    const r = await httpPostJson(port, '/api/topics/topic-report-test/report', normalPlayer.cookie, {
      reason: 'spam content here',
      reporterProfileId: 'spoofed-profile-id-should-be-ignored',
      profileId: admin.profileId,
    })
    assert(r.status === 200, `report трябва да успее, получено ${r.status}`)

    const reportsRes = await httpGetJson(port, '/api/admin/topic-reports?status=pending', admin.cookie)
    const reports = (reportsRes.body as { reports?: Array<{ reporterProfileId: string; topicId: string }> }).reports ?? []
    const found = reports.find((rep) => rep.topicId === 'topic-report-test')
    assert(found !== undefined, 'report трябва да се появи в admin queue-то')
    assertEqual(found!.reporterProfileId, normalPlayer.profileId, 'reporterProfileId трябва да е от authenticated session, НЕ от spoofed body полето')
  })

  await check('[F2] Report persist-ва — admin GET /api/admin/topic-reports вижда pending report-а', async () => {
    const reportsRes = await httpGetJson(port, '/api/admin/topic-reports?status=pending', admin.cookie)
    assert(reportsRes.status === 200, `admin трябва да вижда report queue-то, получено ${reportsRes.status}`)
    const reports = (reportsRes.body as { reports?: unknown[] }).reports ?? []
    assert(reports.length > 0, 'трябва да има поне 1 pending report')
  })

  await check('[F3] Duplicate report (същия reporter+topic бързо) -> 409 topic_report_duplicate', async () => {
    const r = await httpPostJson(port, '/api/topics/topic-report-test/report', normalPlayer.cookie, { reason: 'again same topic' })
    assert(r.status === 409, `очаквано 409, получено ${r.status}`)
    const body = r.body as { code?: string }
    assertEqual(body.code, 'topic_report_duplicate', 'code трябва да е topic_report_duplicate')
  })

  await check('[F4] Invalid/несъществуваща тема -> 404 при report опит', async () => {
    const r = await httpPostJson(port, '/api/topics/nonexistent-topic-id/report', normalPlayer.cookie, { reason: 'test' })
    assert(r.status === 404, `очаквано 404, получено ${r.status}`)
  })

  console.log('\n=== Section G: Concurrency / idempotency (HTTP-level) ===\n')

  await check('[G1] Втори lock (докато вече е locked) презаписва duration/reason, все още 200', async () => {
    await httpPostJson(port, '/api/topics/topic-idempotency-test/lock', admin.cookie, { reason: 'first lock', durationMs: 30 * 60 * 1000 })
    const r = await httpPostJson(port, '/api/topics/topic-idempotency-test/lock', subadmin.cookie, { reason: 'second lock overwrite', durationMs: 60 * 60 * 1000 })
    assert(r.status === 200, `втори lock трябва да успее (overwrite), получено ${r.status}`)
    const body = r.body as { lock?: { lockedReason?: string } }
    assertEqual(body.lock?.lockedReason, 'second lock overwrite', 'lockedReason трябва да е от последния lock')
    await httpPostJson(port, '/api/topics/topic-idempotency-test/unlock', admin.cookie, {})
  })

  await check('[G2] Unlock на вече unlocked тема -> 200, идемпотентно (не грешка)', async () => {
    const r = await httpPostJson(port, '/api/topics/topic-idempotency-test/unlock', admin.cookie, {})
    assert(r.status === 200, `повторен unlock трябва да е 200 idempotent, получено ${r.status}`)
  })

  await check('[G3] Unmute на вече unmuted профил -> 200, идемпотентно', async () => {
    const r = await httpPostJson(port, '/api/topics/topic-idempotency-test/unmute', admin.cookie, { profileId: bystander.profileId })
    assert(r.status === 200, `unmute на никога-mute-нат профил трябва да е 200 idempotent, получено ${r.status}`)
  })

  await check('[G4] Delete на вече изтрита тема -> 200 идемпотентно (already_removed третиран като success навън)', async () => {
    await httpDeleteJson(port, '/api/topics/topic-idempotency-test', admin.cookie, { reason: 'first delete' })
    const r = await httpDeleteJson(port, '/api/topics/topic-idempotency-test', admin.cookie, { reason: 'second delete attempt' })
    assert(r.status === 200, `втори delete на вече removed тема трябва да е 200 idempotent (established already_removed=success pattern), получено ${r.status}`)
  })
} finally {
  if (srv) await stopSrv(srv)
  await iso.cleanup()
}

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)

if (failed > 0) {
  process.exitCode = 1
}
