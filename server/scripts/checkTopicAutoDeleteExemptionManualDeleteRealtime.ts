/**
 * checkTopicAutoDeleteExemptionManualDeleteRealtime.ts
 *
 * E2E proof (real spawn-нат сървър, real HTTP/WS production paths) за новото
 * business правило: тема, създадена от privileged автор (admin/subadmin/
 * chat_admin/top_chat_admin/pika_team) В МОМЕНТА НА СЪЗДАВАНЕ, е защитена от
 * 72h auto-cleanup ЗАВИНАГИ (immutable snapshot, независимо от по-късна
 * промяна на текущата роля на автора), НО остава напълно нормално manual
 * "кошче" hard-deletable от authorized moderator — established harness
 * pattern (виж checkTopicModerationAuthRealtime.ts/checkTopicCreation.ts).
 *
 * Тъй като runTopicInactivityCleanup() е вътрешен setInterval job (90s
 * startup delay), тук probe-ваме директно СЪЩИЯ canonical primitive
 * (topicHardDeleteService.findInactivityCandidates), извикан отделно срещу
 * SAME db file, вместо да чакаме реалния timer — той е read-only, точно
 * СЪЩАТА функция, която runTopicInactivityCleanup() извиква вътрешно
 * (виж index.ts:2779), затова доказва точно каквото auto-cleanup run-ът би
 * видял.
 *
 * [1]  Real WS create_topic като admin (след promote+VIP) -> persisted
 *      created_by_role='admin' в DB (production create_topic handler-ът,
 *      index.ts, реално captur-ва ролята)
 * [2]  Real WS create_topic като обикновен player (VIP, без promote) ->
 *      persisted created_by_role='player'
 * [2b] Real WS create_topic като pika_team (след promote+VIP) -> persisted
 *      created_by_role='pika_team' — третата privileged роля, за която
 *      бизнес правилото изрично изисква exemption (admin/player вече
 *      покрити по-горе; store-level exemption поведение за ВСИЧКИ 5 роли,
 *      вкл. pika_team, е в checkTopicAutoDeleteExemptionByCreatorRole.ts
 *      [2]-[6] — тук само доказваме, че РЕАЛНИЯТ production handler
 *      captur-ва точно тази роля, не дублираме exemption walkthrough)
 * [3]  findInactivityCandidates (>72h backdated и двете теми) -> admin-
 *      created темата НЕ Е candidate, player-created темата Е candidate
 * [A7] Admin акаунтът е ДЕМОТИРАН до 'player' СЛЕД създаването (promoteAccount)
 *      -> findInactivityCandidates пак изключва темата (snapshot immutable,
 *      демоцията НЕ отменя exemption-а ретроактивно)
 * [A8] Player акаунтът е ПРОМОТИРАН до 'admin' СЛЕД създаването на неговата
 *      тема -> findInactivityCandidates пак Я включва (промоцията НЕ дава
 *      exemption ретроактивно)
 * [B1] Manual DELETE /api/topics/:id на ЗАЩИТЕНАТА (admin-created) тема, от
 *      РАЗЛИЧЕН authorized moderator (subadmin, не създателя) -> 200 (manual
 *      delete НЕ проверява 72h exemption-а изобщо)
 * [B2] След manual delete: topics row липсва напълно
 * [B3] След manual delete: root съобщението липсва напълно
 * [B4] След manual delete: attachment metadata row липсва + filename-ът е
 *      enqueue-нат в topic_message_attachment_deletions за физически cleanup
 * [B5] Realtime: subscribed connection получава ТОЧНО ЕДИН topic_deleted
 *      (не 0, не >1)
 * [B6] Regression symmetry: НЕ-exempt (player-created) тема също се manual-
 *      delete-ва нормално през СЪЩИЯ endpoint (exemption-ът не пречи и не
 *      помага на manual delete в никоя посока)
 */

import { DatabaseSync } from 'node:sqlite'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm, cp, mkdir, symlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import WebSocket, { type RawData } from 'ws'
import { createTopicHardDeleteService } from '../src/db/topicHardDeleteService.js'

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
const PASSWORD = 'TopicAutoDeleteExemptionCheck1!'
const HOUR_MS = 60 * 60 * 1000

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
  const tmp = await mkdtemp(join(tmpdir(), 'belot-topic-auto-delete-exemption-e2e-'))
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

function promoteAccount(databaseFile: string, email: string, role: 'admin' | 'subadmin' | 'pika_team' | 'top_chat_admin' | 'chat_admin' | 'player'): void {
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

function readTopicRow(databaseFile: string, topicId: string): { created_by_role: string | null } | undefined {
  const database = new DatabaseSync(databaseFile, { open: true, enableForeignKeyConstraints: true })
  try {
    return database.prepare(`SELECT created_by_role FROM topics WHERE topic_id = ?`).get(topicId) as { created_by_role: string | null } | undefined
  } finally {
    database.close()
  }
}

function backdateMessage(databaseFile: string, messageId: string, hoursAgo: number): void {
  const database = new DatabaseSync(databaseFile, { open: true, enableForeignKeyConstraints: true })
  try {
    const ts = new Date(Date.now() - hoursAgo * HOUR_MS).toISOString().slice(0, 19).replace('T', ' ')
    database.prepare(`UPDATE topic_messages SET created_at = ? WHERE message_id = ?`).run(ts, messageId)
  } finally {
    database.close()
  }
}

function insertAttachmentForMessage(databaseFile: string, messageId: string, storageFilename: string): void {
  const database = new DatabaseSync(databaseFile, { open: true, enableForeignKeyConstraints: true })
  try {
    database.prepare(`
      INSERT INTO topic_message_attachments (message_id, storage_filename, width, height, byte_size, content_type)
      VALUES (?, ?, 400, 300, 12345, 'image/webp');
    `).run(messageId, storageFilename)
  } finally {
    database.close()
  }
}

function queryOne<T>(databaseFile: string, sql: string, ...params: unknown[]): T | undefined {
  const database = new DatabaseSync(databaseFile, { open: true, enableForeignKeyConstraints: true })
  try {
    return database.prepare(sql).get(...params) as T | undefined
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

function countWsMessages(ws: WebSocket, predicate: (msg: AnyMsg) => boolean): number {
  const buffer = wsMessageBuffers.get(ws) ?? []
  return buffer.filter(predicate).length
}

// ─── Setup ───────────────────────────────────────────────────────────────

console.log('\n=== Topic Auto-Delete Exemption — Manual Delete Realtime E2E ===\n')

const iso = await makeIsolated(serverRoot)
const port = await getFreePort()
let srv: { child: ChildProcessWithoutNullStreams; output(): string } | null = null

try {
  srv = startSrv(iso.serverDir, port)
  console.log(`  Чакам сървъра на порт ${port}…`)
  await waitForServerReady(port)
  console.log('  Сървърът е готов.\n')

  const runId = `${Date.now()}-${process.pid}`

  const adminUser = await registerAndLogin(port, `tade-admin-${runId}@example.test`, 'AdminCreator')
  const playerUser = await registerAndLogin(port, `tade-player-${runId}@example.test`, 'PlayerCreator')
  const pikaTeamUser = await registerAndLogin(port, `tade-pikateam-${runId}@example.test`, 'PikaTeamCreator')
  const subadminModerator = await registerAndLogin(port, `tade-subadmin-${runId}@example.test`, 'SubadminModerator')
  const bystander = await registerAndLogin(port, `tade-bystander-${runId}@example.test`, 'BystanderUser')

  promoteAccount(iso.dbFile, `tade-admin-${runId}@example.test`, 'admin')
  promoteAccount(iso.dbFile, `tade-pikateam-${runId}@example.test`, 'pika_team')
  promoteAccount(iso.dbFile, `tade-subadmin-${runId}@example.test`, 'subadmin')
  grantVip(iso.dbFile, adminUser.profileId)
  grantVip(iso.dbFile, playerUser.profileId)
  grantVip(iso.dbFile, pikaTeamUser.profileId)

  const wsAdmin = await openWs(port, adminUser.cookie)
  const wsPlayer = await openWs(port, playerUser.cookie)
  const wsPikaTeam = await openWs(port, pikaTeamUser.cookie)
  const wsBystander = await openWs(port, bystander.cookie)

  sendWs(wsAdmin, { type: 'create_topic', title: `Admin Topic ${runId}`, requestId: 'req-admin-create' })
  const adminCreated = await waitForWsMessage(wsAdmin, (m) => m.type === 'topic_created' && m.requestId === 'req-admin-create')
  const adminTopicId = String((adminCreated.topic as { topicId: string }).topicId)

  sendWs(wsPlayer, { type: 'create_topic', title: `Player Topic ${runId}`, requestId: 'req-player-create' })
  const playerCreated = await waitForWsMessage(wsPlayer, (m) => m.type === 'topic_created' && m.requestId === 'req-player-create')
  const playerTopicId = String((playerCreated.topic as { topicId: string }).topicId)

  sendWs(wsPikaTeam, { type: 'create_topic', title: `Pika Team Topic ${runId}`, requestId: 'req-pikateam-create' })
  const pikaTeamCreated = await waitForWsMessage(wsPikaTeam, (m) => m.type === 'topic_created' && m.requestId === 'req-pikateam-create')
  const pikaTeamTopicId = String((pikaTeamCreated.topic as { topicId: string }).topicId)

  await check('[1] Real WS create_topic като admin -> persisted created_by_role=\'admin\'', () => {
    const row = readTopicRow(iso.dbFile, adminTopicId)
    assert(row !== undefined, 'admin темата трябва да съществува в DB')
    assertEqual(row!.created_by_role, 'admin', 'created_by_role трябва да е снапшот-нат като admin')
  })

  await check('[2] Real WS create_topic като player -> persisted created_by_role=\'player\'', () => {
    const row = readTopicRow(iso.dbFile, playerTopicId)
    assert(row !== undefined, 'player темата трябва да съществува в DB')
    assertEqual(row!.created_by_role, 'player', 'created_by_role трябва да е снапшот-нат като player')
  })

  await check('[2b] Real WS create_topic като pika_team -> persisted created_by_role=\'pika_team\'', () => {
    const row = readTopicRow(iso.dbFile, pikaTeamTopicId)
    assert(row !== undefined, 'pika_team темата трябва да съществува в DB')
    assertEqual(row!.created_by_role, 'pika_team', 'created_by_role трябва да е снапшот-нат като pika_team')
  })

  // Root съобщения (нужни за topic_root_latest_seq — findInactivityCandidates
  // join-ва през него; тема без нито едно съобщение няма ред там изобщо).
  sendWs(wsAdmin, { type: 'subscribe_topic_messages', topicId: adminTopicId, afterSeq: 0 })
  await waitForWsMessage(wsAdmin, (m) => m.type === 'topic_message_catchup' && m.topicId === adminTopicId)
  sendWs(wsAdmin, { type: 'send_topic_message', topicId: adminTopicId, body: 'admin root post', requestId: 'req-admin-root' })
  const adminRootMsg = await waitForWsMessage(wsAdmin, (m) => m.type === 'topic_message' && m.requestId === 'req-admin-root')
  const adminRootMessageId = String(adminRootMsg.messageId)

  sendWs(wsPlayer, { type: 'subscribe_topic_messages', topicId: playerTopicId, afterSeq: 0 })
  await waitForWsMessage(wsPlayer, (m) => m.type === 'topic_message_catchup' && m.topicId === playerTopicId)
  sendWs(wsPlayer, { type: 'send_topic_message', topicId: playerTopicId, body: 'player root post', requestId: 'req-player-root' })
  const playerRootMsg = await waitForWsMessage(wsPlayer, (m) => m.type === 'topic_message' && m.requestId === 'req-player-root')
  const playerRootMessageId = String(playerRootMsg.messageId)

  const attachmentFilename = `aaaaaaaa-0000-4000-8000-${runId.replace(/[^0-9]/g, '').slice(-12).padStart(12, '0')}.webp`
  insertAttachmentForMessage(iso.dbFile, adminRootMessageId, attachmentFilename)

  backdateMessage(iso.dbFile, adminRootMessageId, 73)
  backdateMessage(iso.dbFile, playerRootMessageId, 73)

  const hardDeleteProbe = await createTopicHardDeleteService(iso.dbFile)
  try {
    const cutoff = new Date(Date.now() - 72 * HOUR_MS)

    await check('[3] findInactivityCandidates (>72h): admin-created НЕ Е candidate, player-created Е candidate', () => {
      const candidates = hardDeleteProbe.findInactivityCandidates(cutoff, 200)
      const ids = new Set(candidates.map((c) => c.topicId))
      assert(!ids.has(adminTopicId), 'admin-created темата никога не влиза в auto-cleanup victim set-а')
      assert(ids.has(playerTopicId), 'player-created темата е нормален auto-cleanup candidate')
    })

    // [A7] Демоция СЛЕД създаване — snapshot-ът е immutable.
    promoteAccount(iso.dbFile, `tade-admin-${runId}@example.test`, 'player')
    await check('[A7] Admin акаунтът демотиран до \'player\' СЛЕД създаването -> темата пак Е изключена (snapshot immutable)', () => {
      const candidates = hardDeleteProbe.findInactivityCandidates(cutoff, 200)
      const ids = new Set(candidates.map((c) => c.topicId))
      assert(!ids.has(adminTopicId), 'демоцията на автора СЛЕД създаването не отменя вече записания exemption')
      const row = readTopicRow(iso.dbFile, adminTopicId)
      assertEqual(row!.created_by_role, 'admin', 'persisted snapshot колоната остава непроменена — никой код path не я UPDATE-ва')
    })

    // [A8] Промоция СЛЕД създаване — не дава ретроактивен exemption.
    promoteAccount(iso.dbFile, `tade-player-${runId}@example.test`, 'admin')
    await check('[A8] Player акаунтът промотиран до \'admin\' СЛЕД създаването на неговата тема -> темата пак Е candidate (без ретроактивен exemption)', () => {
      const candidates = hardDeleteProbe.findInactivityCandidates(cutoff, 200)
      const ids = new Set(candidates.map((c) => c.topicId))
      assert(ids.has(playerTopicId), 'промоцията на автора СЛЕД създаването не дава exemption на вече създадената тема')
      const row = readTopicRow(iso.dbFile, playerTopicId)
      assertEqual(row!.created_by_role, 'player', 'persisted snapshot колоната остава непроменена')
    })
  } finally {
    hardDeleteProbe.close()
  }

  // ─── Manual delete на защитената (admin-created) тема ─────────────────────

  sendWs(wsBystander, { type: 'subscribe_topic_messages', topicId: adminTopicId, afterSeq: 0 })
  await waitForWsMessage(wsBystander, (m) => m.type === 'topic_message_catchup' && m.topicId === adminTopicId)

  await check('[B1] Manual DELETE /api/topics/:id на защитената тема, от РАЗЛИЧЕН moderator (subadmin) -> 200', async () => {
    const res = await httpDeleteJson(port, `/api/topics/${adminTopicId}`, subadminModerator.cookie, { reason: 'e2e manual delete of protected topic' })
    assertEqual(res.status, 200, `очаквано 200 (manual delete НЕ проверява 72h exemption), получено ${res.status}`)
  })

  await check('[B2] След manual delete: topics row липсва напълно', () => {
    const row = queryOne<{ topic_id: string }>(iso.dbFile, `SELECT topic_id FROM topics WHERE topic_id = ?`, adminTopicId)
    assertEqual(row, undefined, 'topics row трябва да е физически изтрит')
  })

  await check('[B3] След manual delete: root съобщението липсва напълно', () => {
    const row = queryOne<{ message_id: string }>(iso.dbFile, `SELECT message_id FROM topic_messages WHERE message_id = ?`, adminRootMessageId)
    assertEqual(row, undefined, 'root съобщението трябва да е физически изтрито')
  })

  await check('[B4] Attachment metadata изтрит + filename enqueue-нат в topic_message_attachment_deletions', () => {
    const attRow = queryOne<{ message_id: string }>(iso.dbFile, `SELECT message_id FROM topic_message_attachments WHERE message_id = ?`, adminRootMessageId)
    assertEqual(attRow, undefined, 'attachment metadata row трябва да е изтрит')
    const queueRow = queryOne<{ storage_filename: string }>(iso.dbFile, `SELECT storage_filename FROM topic_message_attachment_deletions WHERE storage_filename = ?`, attachmentFilename)
    assert(queueRow !== undefined, 'filename-ът трябва да е enqueue-нат за физически cleanup')
  })

  await check('[B5] Realtime: subscribed connection получава ТОЧНО ЕДИН topic_deleted', async () => {
    await waitForWsMessage(wsBystander, (m) => m.type === 'topic_deleted' && m.topicId === adminTopicId)
    await sleep(500)
    const count = countWsMessages(wsBystander, (m) => m.type === 'topic_deleted' && m.topicId === adminTopicId)
    assertEqual(count, 1, 'точно 1 topic_deleted събитие, не 0 и не дублирано')
  })

  await check('[B6] Regression symmetry: НЕ-exempt (player-created) тема също се manual-delete-ва нормално', async () => {
    const res = await httpDeleteJson(port, `/api/topics/${playerTopicId}`, subadminModerator.cookie, { reason: 'e2e manual delete of non-exempt topic' })
    assertEqual(res.status, 200, `очаквано 200, получено ${res.status}`)
    const row = queryOne<{ topic_id: string }>(iso.dbFile, `SELECT topic_id FROM topics WHERE topic_id = ?`, playerTopicId)
    assertEqual(row, undefined, 'player-created темата трябва също да е физически изтрита')
  })

  wsAdmin.close()
  wsPlayer.close()
  wsPikaTeam.close()
  wsBystander.close()
} finally {
  if (srv) await stopSrv(srv)
  await iso.cleanup()
}

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) {
  process.exitCode = 1
}
