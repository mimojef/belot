/**
 * checkUnifiedMuteWebSocket.ts
 *
 * Real spawned-server / real HTTP + WebSocket integration тест за единния мют,
 * мюта от профила и известията за приключването му. Изолиран сървър (temp
 * копие на src/dist + temp SQLite DB, email-код регистрация с известен тестов
 * secret върху изолираната DB — същият модел и helper-и като
 * checkPrivateRoomWebSocketRoundTrip.ts). Без production акаунти/база.
 * Ролите/VIP се задават директно в ИЗОЛИРАНАТА DB (тестът я притежава).
 *
 * Покрива:
 *  [A] права: POST /api/topics/profile-mute — admin/pika_team 200;
 *      subadmin/top_chat_admin/chat_admin/marketing/player 403 без DB промяна;
 *      вече активен мют 409; невалиден срок/причина/категория 400;
 *      премахване от профила — admin/pika_team/subadmin/top_chat_admin 200,
 *      chat_admin 403.
 *  [B] защитени профили през ВСИЧКИ mute endpoints (профил, Лафче, Тема):
 *      admin, pika_team, marketing, официалният Pika.bg, собствен профил —
 *      403 и нула промени в topic_section_mutes/audit/evidence.
 *  [C] единен мют: мют от профил/Лафче/Тема блокира чата на частната маса,
 *      Лафче и Теми (директни WS заявки) и редакцията (директна HTTP PATCH);
 *      втора сесия и нова частна маса не заобикалят; след unmute/изтичане
 *      писането се възстановява без ново влизане.
 *  [D] известия: 'unmuted' (онлайн, двете сесии), 'expired' (онлайн), ack от
 *      едно устройство изчиства другото, без повторение след reconnect,
 *      офлайн доставка при следващ connect, restart recovery, нов мют преди
 *      доставка (superseded), доставка по време на активна игра без промяна
 *      в gameplay.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import WebSocket from 'ws'
import { verifyVerificationCode } from '../src/db/authHelpers.js'

// Email-verification pending-first registration (виж checkAuthSessionRollingRenewal.ts):
// известен тестов secret на spawned сървъра, за да може 6-цифреният код да се
// извлече от DB-съхранения code_hash със СЪЩИЯ production HMAC helper — тестът
// контролира и secret-а, и DB файла, не е production security bypass.
const TEST_REGISTRATION_SECRET = 'unified-mute-ws-registration-secret-0123456789abcdef'
let testDatabaseFile = ''

let passed = 0
let failed = 0

function pass(label: string): void {
  passed++
  console.log(`  PASS  ${label}`)
}

function fail(label: string, reason: unknown): void {
  failed++
  const msg = reason instanceof Error ? reason.message : String(reason)
  console.error(`  FAIL  ${label}: ${msg}`)
}

async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    pass(label)
  } catch (err) {
    fail(label, err)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolveFree) => {
    const srv = createServer()
    srv.once('error', () => resolveFree(false))
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolveFree(true)))
  })
}

async function findFreePort(): Promise<number> {
  return new Promise((resolveFree, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (addr === null || typeof addr === 'string') { reject(new Error('no port')); return }
      const p = addr.port
      srv.close(() => resolveFree(p))
    })
  })
}

async function waitForCondition(label: string, predicate: () => Promise<boolean> | boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await sleep(100)
  }
  throw new Error(`Timeout: ${label}`)
}

async function httpJson(
  port: number,
  method: string,
  pathname: string,
  cookie: string | null,
  body?: unknown,
): Promise<{ status: number; body: any; setCookie: string | null }> {
  const res = await fetch(`http://localhost:${port}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const setCookie = (res.headers.getSetCookie?.()[0] ?? res.headers.get('set-cookie'))?.split(';')[0] ?? null
  let json: any = null
  try { json = await res.json() } catch { /* not json */ }
  return { status: res.status, body: json, setCookie }
}

// ─── Isolated server (same model as checkVoluntaryLeaveChatGate.ts) ────────

const sourceServerRoot = resolve(
  process.argv.slice(2).find((a) => a.startsWith('--server-root='))?.slice('--server-root='.length)
  ?? process.cwd(),
)

async function retryRm(path: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try { await rm(path, { recursive: true, force: true }); return } catch { /* retry */ }
    await sleep(250)
  }
}

async function createIsolatedServerRoot(originalServerRoot: string) {
  const root = await mkdtemp(join(tmpdir(), 'belot-unified-mute-ws-'))
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
  return {
    serverDir,
    cleanup: () => retryRm(root),
  }
}

type RunningServer = { child: ChildProcessWithoutNullStreams; output(): string }

function startServer(serverDir: string, port: number): RunningServer {
  const chunks: string[] = []
  const child = spawn(
    process.execPath,
    [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'index.ts')],
    {
      cwd: serverDir,
      env: { ...process.env, PORT: String(port), PASSWORD_RESET_RATE_LIMIT_SECRET: TEST_REGISTRATION_SECRET },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (c) => chunks.push(c))
  child.stderr.on('data', (c) => chunks.push(c))
  return { child, output: () => chunks.join('') }
}

// Пише директно в ИЗОЛИРАНИЯ temp DB на spawned сървъра (тестът го притежава) —
// hasEnoughBalance() чете profile_wallets на всяко извикване, без кеш.
function setWalletBalance(profileId: string, amount: number): void {
  const db = new DatabaseSync(testDatabaseFile, { open: true, timeout: 5_000 })
  try {
    const res = db.prepare('UPDATE profile_wallets SET yellow_coins_balance = ? WHERE profile_id = ?').run(amount, profileId)
    if (Number(res.changes) === 0) {
      db.prepare('INSERT INTO profile_wallets (profile_id, yellow_coins_balance) VALUES (?, ?)').run(profileId, amount)
    }
  } finally {
    db.close()
  }
}

function bruteForceVerificationCode(databaseFilePath: string, pendingRegistrationId: string, secret: string): string {
  const db = new DatabaseSync(databaseFilePath, { open: true })
  const row = db.prepare(`SELECT code_hash FROM pending_registrations WHERE pending_registration_id = ?`).get(pendingRegistrationId) as
    | { code_hash: string }
    | undefined
  db.close()
  if (!row) throw new Error(`pending_registrations row not found: ${pendingRegistrationId}`)
  for (let candidate = 0; candidate < 1_000_000; candidate++) {
    const code = candidate.toString().padStart(6, '0')
    if (verifyVerificationCode(code, secret, row.code_hash)) return code
  }
  throw new Error(`Could not brute-force the verification code for ${pendingRegistrationId}`)
}

async function stopServer(server: RunningServer | null): Promise<void> {
  if (!server || server.child.exitCode !== null) return
  server.child.kill('SIGTERM')
  await new Promise<void>((r) => {
    const t = setTimeout(() => { server.child.kill('SIGKILL'); r() }, 10_000)
    server.child.once('exit', () => { clearTimeout(t); r() })
  })
}

// ─── Test harness: one WS client per human participant ────────────────────

type TestClient = {
  profileId: string
  cookie: string
  ws: WebSocket
  frames: any[]
}

async function registerProfile(port: number, tag: string): Promise<{ cookie: string; profileId: string }> {
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const reg = await httpJson(port, 'POST', '/api/auth/register', null, {
    email: `unified-mute-${tag}-${runId}@example.test`,
    password: 'PrivateRoomWsDiag1!',
    displayName: `PRW ${tag}`,
    gender: 'male',
    visitorId: randomUUID(),
  })
  // pendingRegistrationId се връща и на 503 EMAIL_DELIVERY_FAILED (Brevo не е
  // configured в тестовата среда — очаквано, pending редът persists).
  const pendingRegistrationId: string | undefined = reg.body?.pendingRegistrationId
  if (!pendingRegistrationId) throw new Error(`Registration failed for ${tag}: ${JSON.stringify(reg.body)}`)
  const code = bruteForceVerificationCode(testDatabaseFile, pendingRegistrationId, TEST_REGISTRATION_SECRET)
  // bruteForceVerificationCode блокира event loop-а синхронно и понякога прави
  // keep-alive връзката към spawned сървъра stale (ECONNRESET, чисто transient) —
  // един бърз retry е достатъчен (същото като checkAuthSessionRollingRenewal.ts).
  const verifyBody = { pendingRegistrationId, code, rememberMe: true }
  let verified: Awaited<ReturnType<typeof httpJson>>
  try {
    verified = await httpJson(port, 'POST', '/api/auth/verify-registration-email', null, verifyBody)
  } catch {
    await sleep(200)
    verified = await httpJson(port, 'POST', '/api/auth/verify-registration-email', null, verifyBody)
  }
  if (verified.status !== 200) throw new Error(`Email verification failed for ${tag}: ${JSON.stringify(verified.body)}`)
  return { cookie: verified.setCookie as string, profileId: verified.body.session.profile.profileId }
}

async function connectClient(port: number, tag: string): Promise<TestClient> {
  const { cookie, profileId } = await registerProfile(port, tag)
  const ws = new WebSocket(`ws://localhost:${port}/ws`, { headers: { Cookie: cookie } })
  const frames: any[] = []
  ws.on('message', (data) => {
    try { frames.push(JSON.parse(data.toString())) } catch { /* ignore */ }
  })
  await new Promise<void>((resolveOpen, reject) => {
    ws.once('open', () => resolveOpen())
    ws.once('error', reject)
  })
  return { profileId, cookie, ws, frames }
}

function send(client: TestClient, message: Record<string, unknown>): void {
  client.ws.send(JSON.stringify(message))
}

async function reconnectClient(port: number, previous: TestClient): Promise<TestClient> {
  const ws = new WebSocket(`ws://localhost:${port}/ws`, { headers: { Cookie: previous.cookie } })
  const frames: any[] = []
  ws.on('message', (data) => {
    try { frames.push(JSON.parse(data.toString())) } catch { /* ignore */ }
  })
  await new Promise<void>((resolveOpen, reject) => {
    ws.once('open', () => resolveOpen())
    ws.once('error', reject)
  })
  return { profileId: previous.profileId, cookie: previous.cookie, ws, frames }
}

function framesOfType(client: TestClient, type: string): any[] {
  return client.frames.filter((f) => f.type === type)
}

function occupiedCount(room: any): number {
  return room.slots.filter((s: any) => s.occupant !== null).length
}

function slotOccupant(room: any, team: 'A' | 'B', slotIndex: 0 | 1): any {
  return room.slots.find((s: any) => s.team === team && s.slotIndex === slotIndex)?.occupant ?? null
}

function isActiveServerAuthoritativeRoomSnapshot(frame: any, roomId: string): boolean {
  return (
    frame.type === 'room_snapshot' &&
    frame.roomId === roomId &&
    frame.roomStatus === 'playing' &&
    frame.game !== null &&
    frame.game !== undefined &&
    frame.game.phase !== null &&
    frame.game.phase !== 'bootstrap' &&
    frame.game.authoritativePhase !== null &&
    frame.game.authoritativePhase !== undefined
  )
}

async function waitForFrame(
  client: TestClient,
  predicate: (frame: any) => boolean,
  timeoutMs = 10_000,
  label = 'frame',
): Promise<any> {
  try {
    await waitForCondition(label, () => client.frames.some(predicate), timeoutMs)
  } catch (err) {
    console.error(`[debug] frames received while waiting for "${label}":`, JSON.stringify(client.frames, null, 2))
    throw err
  }
  return client.frames.find(predicate)
}

// ─── Test-owned isolated DB helpers ────────────────────────────────────────

function withDb<T>(fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(testDatabaseFile, { open: true, timeout: 5_000 })
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

function setRole(profileId: string, role: string): void {
  withDb((db) => {
    db.prepare(`UPDATE accounts SET role = ? WHERE account_id = (SELECT account_id FROM profiles WHERE profile_id = ?)`).run(role, profileId)
  })
}

function grantVip(profileId: string): void {
  const until = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ')
  withDb((db) => {
    db.prepare(`INSERT INTO vip_status (profile_id, active_until) VALUES (?, ?) ON CONFLICT(profile_id) DO UPDATE SET active_until = excluded.active_until`).run(profileId, until)
  })
}

function forceExpire(profileId: string): void {
  const past = new Date(Date.now() - 60_000).toISOString().slice(0, 19).replace('T', ' ')
  withDb((db) => {
    db.prepare(`UPDATE topic_section_mutes SET muted_until = ? WHERE profile_id = ?`).run(past, profileId)
    db.prepare(`UPDATE topic_mute_evidence SET muted_until = ? WHERE profile_id = ? AND status = 'active'`).run(past, profileId)
  })
}

function moderationCounts(profileId?: string): { mutes: number; audit: number; evidence: number } {
  return withDb((db) => {
    const where = profileId ? ' WHERE profile_id = ?' : ''
    const auditWhere = profileId ? ' WHERE target_profile_id = ?' : ''
    const args = profileId ? [profileId] : []
    return {
      mutes: Number((db.prepare(`SELECT COUNT(*) c FROM topic_section_mutes${where}`).get(...args) as { c: number }).c),
      audit: Number((db.prepare(`SELECT COUNT(*) c FROM topic_moderation_audit_log${auditWhere}`).get(...args) as { c: number }).c),
      evidence: Number((db.prepare(`SELECT COUNT(*) c FROM topic_mute_evidence${where}`).get(...args) as { c: number }).c),
    }
  })
}

function noticeStatuses(profileId: string): string[] {
  return withDb((db) =>
    (db.prepare(`SELECT kind || ':' || status AS s FROM topic_mute_end_notices WHERE profile_id = ? ORDER BY created_at, rowid`).all(profileId) as Array<{ s: string }>).map((r) => r.s),
  )
}

function insertOfficialPikaProfile(): void {
  withDb((db) => {
    db.prepare(`INSERT OR IGNORE INTO profiles (profile_id, display_name, normalized_display_name) VALUES (?, ?, ?)`)
      .run('4c146064-85af-4e6e-b08f-08faa39b167e', 'PIKABG', 'pikabg')
  })
}

function lastTopicMessageId(profileId: string, topicId: string): string | null {
  return withDb((db) => {
    const row = db.prepare(`SELECT message_id FROM topic_messages WHERE sender_profile_id = ? AND topic_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(profileId, topicId) as
      | { message_id: string }
      | undefined
    return row?.message_id ?? null
  })
}

function topicMessageCount(profileId: string): number {
  return withDb((db) => Number((db.prepare(`SELECT COUNT(*) c FROM topic_messages WHERE sender_profile_id = ?`).get(profileId) as { c: number }).c))
}

function activeSeatOfGame(game: any): string | null {
  if (game?.authoritativePhase === 'cutting') return game.cutting?.selectedCutIndex === null ? game.cutting?.cutterSeat ?? null : null
  if (game?.authoritativePhase === 'bidding') return game.bidding?.currentBidderSeat ?? null
  if (game?.authoritativePhase === 'playing') return game.playing?.currentTurnSeat ?? null
  return null
}

// ─── Protocol helpers ──────────────────────────────────────────────────────

const ONE_HOUR_MS = 60 * 60 * 1000
let requestSeq = 0

function profileMute(port: number, actor: TestClient, targetProfileId: string, body: Record<string, unknown> = {}) {
  return httpJson(port, 'POST', '/api/topics/profile-mute', actor.cookie, {
    profileId: targetProfileId,
    reason: 'Обиди в чата на частната маса',
    durationMs: ONE_HOUR_MS,
    reasonCategory: 'insults',
    ...body,
  })
}

function topicMute(port: number, actor: TestClient, topicId: string, targetProfileId: string) {
  return httpJson(port, 'POST', `/api/topics/${topicId}/mute`, actor.cookie, {
    profileId: targetProfileId,
    reason: 'Нарушение в публикация',
    durationMs: ONE_HOUR_MS,
  })
}

function profileUnmute(port: number, actor: TestClient, targetProfileId: string) {
  return httpJson(port, 'POST', '/api/topics/unmute', actor.cookie, { profileId: targetProfileId })
}

async function sendPrivateChat(client: TestClient, privateRoomId: string): Promise<any> {
  const requestId = `pc-${++requestSeq}`
  send(client, { type: 'send_private_room_chat_message', privateRoomId, body: `здравей ${requestSeq}`, requestId })
  return waitForFrame(
    client,
    (f) => (f.type === 'private_room_chat_message' || f.type === 'private_room_chat_error') && f.requestId === requestId,
    8_000,
    `private chat reply ${requestId}`,
  )
}

// Връща 'sent' (DB редът е създаден) или кода на грешката.
async function sendTopicMessage(client: TestClient, topicId: string): Promise<string> {
  const requestId = `tm-${++requestSeq}`
  const before = topicMessageCount(client.profileId)
  send(client, { type: 'send_topic_message', topicId, body: `публикация ${requestSeq}`, requestId })
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    const error = client.frames.find((f) => f.type === 'topic_message_error' && f.requestId === requestId)
    if (error) return error.code
    if (topicMessageCount(client.profileId) > before) return 'sent'
    await sleep(100)
  }
  throw new Error(`no outcome for topic message ${requestId}`)
}

async function createWaitingRoom(client: TestClient): Promise<string> {
  client.frames.length = 0
  send(client, { type: 'create_private_room', stake: 5000, isLocked: false, waitMinutes: 5 })
  const created = await waitForFrame(client, (f) => f.type === 'private_room_updated', 10_000, 'create private room')
  return created.room.id as string
}

function noticeFrames(client: TestClient, kind?: 'expired' | 'unmuted'): any[] {
  return client.frames
    .filter((f) => f.type === 'mute_end_notices')
    .flatMap((f) => f.notices)
    .filter((n: any) => kind === undefined || n.kind === kind)
}

async function waitForNotice(client: TestClient, kind: 'expired' | 'unmuted', timeoutMs = 12_000): Promise<any> {
  await waitForCondition(`mute_end_notice ${kind}`, () => noticeFrames(client, kind).length > 0, timeoutMs)
  return noticeFrames(client, kind)[0]
}

async function startPrivateGame(host: TestClient, guest: TestClient): Promise<string> {
  const roomId = await createWaitingRoom(host)
  send(host, { type: 'add_bot_to_private_room_team', team: 'A' })
  await waitForFrame(host, (f) => f.type === 'private_room_updated' && occupiedCount(f.room) === 2, 10_000, 'bot A')
  send(guest, { type: 'join_private_room', privateRoomId: roomId, team: 'B', slotIndex: 0 })
  await waitForFrame(guest, (f) => f.type === 'private_room_updated' && occupiedCount(f.room) === 3, 10_000, 'guest joined')
  send(guest, { type: 'add_bot_to_private_room_team', team: 'B' })
  const snapshot = await waitForFrame(host, (f) => isActiveServerAuthoritativeRoomSnapshot(f, f.roomId), 30_000, 'game started')
  return snapshot.roomId as string
}

// ─── Run ───────────────────────────────────────────────────────────────────

console.log('\ncheckUnifiedMuteWebSocket\n')

let server: RunningServer | null = null
const isolated = await createIsolatedServerRoot(sourceServerRoot)
testDatabaseFile = join(isolated.serverDir, 'database', 'data', 'belot-v2.sqlite')
let port = 0

async function bootServer(): Promise<void> {
  server = startServer(isolated.serverDir, port)
  try {
    await waitForCondition('backend health', async () => {
      try {
        const r = await fetch(`http://localhost:${port}/health`)
        const h = await r.json()
        return r.status === 200 && h.ok === true && h.gameWorkerLifecycle?.state === 'ready'
      } catch { return false }
    }, 40_000)
  } catch (err) {
    console.error('--- server output ---')
    console.error(server?.output())
    throw err
  }
}

try {
  port = await findFreePort()
  if (!(await isPortFree(port))) throw new Error(`Port ${port} in use`)
  await bootServer()
  console.log('Server ready. Registering profiles...\n')

  // Регистрациите (синхронен brute-force на кода) са последователни.
  const tags = [
    'Admin', 'Pika', 'Subadm', 'TopChat', 'ChatAdm', 'Market', 'Player',
    'AdminT', 'PikaT', 'MarketT',
    'TgtA', 'TgtB', 'TgtC', 'TgtD', 'TgtE', 'TgtF', 'TgtG', 'TgtH', 'TgtI', 'TgtJ', 'TgtK',
  ] as const
  const c: Record<(typeof tags)[number], TestClient> = {} as any
  for (const tag of tags) c[tag] = await connectClient(port, tag)
  setRole(c.Admin.profileId, 'admin')
  setRole(c.Pika.profileId, 'pika_team')
  setRole(c.Subadm.profileId, 'subadmin')
  setRole(c.TopChat.profileId, 'top_chat_admin')
  setRole(c.ChatAdm.profileId, 'chat_admin')
  setRole(c.Market.profileId, 'marketing')
  setRole(c.AdminT.profileId, 'admin')
  setRole(c.PikaT.profileId, 'pika_team')
  setRole(c.MarketT.profileId, 'marketing')
  for (const tag of tags) {
    setWalletBalance(c[tag].profileId, 1_000_000)
    grantVip(c[tag].profileId)
  }
  insertOfficialPikaProfile()
  console.log('Profiles ready.\n')

  // ── [A] Права ──────────────────────────────────────────────────────────
  for (const actor of ['Subadm', 'TopChat', 'ChatAdm', 'Market', 'Player'] as const) {
    await check(`[A] ${actor} CANNOT mute from profile (403, no DB change)`, async () => {
      const before = moderationCounts(c.TgtA.profileId)
      const res = await profileMute(port, c[actor], c.TgtA.profileId)
      if (res.status !== 403) throw new Error(`status ${res.status} ${JSON.stringify(res.body)}`)
      const after = moderationCounts(c.TgtA.profileId)
      if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error(`DB changed ${JSON.stringify(before)} -> ${JSON.stringify(after)}`)
    })
  }

  await check('[A] invalid duration / reason / category are rejected (400) without DB change', async () => {
    const before = moderationCounts(c.TgtA.profileId)
    for (const bad of [{ durationMs: 12345 }, { reason: '' }, { reason: 'x'.repeat(201) }, { reasonCategory: 'bogus' }]) {
      const res = await profileMute(port, c.Admin, c.TgtA.profileId, bad)
      if (res.status !== 400) throw new Error(`${JSON.stringify(bad)} -> ${res.status}`)
    }
    if (JSON.stringify(before) !== JSON.stringify(moderationCounts(c.TgtA.profileId))) throw new Error('DB changed')
  })

  await check('[A] admin CAN mute from profile; second mute while active -> 409 without DB change', async () => {
    const res = await profileMute(port, c.Admin, c.TgtA.profileId)
    if (res.status !== 200 || res.body.mute?.isMuted !== true) throw new Error(`status ${res.status} ${JSON.stringify(res.body)}`)
    const before = moderationCounts(c.TgtA.profileId)
    if (before.mutes !== 1 || before.audit !== 1 || before.evidence !== 1) throw new Error(`expected 1/1/1, got ${JSON.stringify(before)}`)
    const again = await profileMute(port, c.Pika, c.TgtA.profileId)
    if (again.status !== 409 || again.body.code !== 'already_muted') throw new Error(`second mute ${again.status} ${JSON.stringify(again.body)}`)
    if (JSON.stringify(before) !== JSON.stringify(moderationCounts(c.TgtA.profileId))) throw new Error('DB changed on 409')
    const evidence = withDb((db) => db.prepare(`SELECT source_topic_id, source_kind, muted_by_role, reason_category FROM topic_mute_evidence WHERE profile_id = ?`).get(c.TgtA.profileId))
    if (JSON.stringify(evidence) !== JSON.stringify({ source_topic_id: 'profile-popup', source_kind: 'unspecified', muted_by_role: 'admin', reason_category: 'insults' })) {
      throw new Error(`evidence ${JSON.stringify(evidence)}`)
    }
  })

  await check('[A] pika_team CAN mute from profile', async () => {
    const res = await profileMute(port, c.Pika, c.TgtB.profileId)
    if (res.status !== 200 || res.body.mute?.isMuted !== true) throw new Error(`status ${res.status} ${JSON.stringify(res.body)}`)
  })

  await check('[A] chat_admin CANNOT unmute from profile (403)', async () => {
    const res = await profileUnmute(port, c.ChatAdm, c.TgtB.profileId)
    if (res.status !== 403) throw new Error(`status ${res.status}`)
  })

  for (const actor of ['Admin', 'Pika', 'Subadm', 'TopChat'] as const) {
    await check(`[A] ${actor} keeps the right to unmute from profile`, async () => {
      // Всеки unmute върху пресен мют на TgtK (наложен от admin от профила).
      const muted = await profileMute(port, c.Admin, c.TgtK.profileId)
      if (muted.status !== 200) throw new Error(`setup mute ${muted.status} ${JSON.stringify(muted.body)}`)
      const res = await profileUnmute(port, c[actor], c.TgtK.profileId)
      if (res.status !== 200) throw new Error(`status ${res.status} ${JSON.stringify(res.body)}`)
      if (moderationCounts(c.TgtK.profileId).mutes !== 0) throw new Error('mute row still present')
    })
  }

  // ── [B] Защитени профили ───────────────────────────────────────────────
  const protectedTargets: Array<[string, string]> = [
    ['admin role', c.AdminT.profileId],
    ['pika_team role', c.PikaT.profileId],
    ['marketing role', c.MarketT.profileId],
    ['official Pika.bg profile', '4c146064-85af-4e6e-b08f-08faa39b167e'],
  ]
  for (const [label, targetId] of protectedTargets) {
    await check(`[B] ${label} cannot be muted via profile / Лафче / Тема endpoints (403, zero DB change)`, async () => {
      const before = moderationCounts()
      const attempts = [
        await profileMute(port, c.Admin, targetId),
        await topicMute(port, c.Admin, 'topic-lafche', targetId),
        await topicMute(port, c.Subadm, 'topic-general', targetId),
      ]
      for (const res of attempts) {
        if (res.status !== 403 || res.body.code !== 'PROTECTED_STAFF_PROFILE') throw new Error(`got ${res.status} ${JSON.stringify(res.body)}`)
      }
      if (JSON.stringify(before) !== JSON.stringify(moderationCounts())) throw new Error('DB changed')
    })
  }

  await check('[B] self-mute is rejected on every mute endpoint (403, zero DB change)', async () => {
    const before = moderationCounts()
    const attempts = [
      await profileMute(port, c.Admin, c.Admin.profileId),
      await topicMute(port, c.Admin, 'topic-lafche', c.Admin.profileId),
      await topicMute(port, c.Subadm, 'topic-general', c.Subadm.profileId),
    ]
    for (const res of attempts) {
      if (res.status !== 403 || res.body.code !== 'self_mute') throw new Error(`got ${res.status} ${JSON.stringify(res.body)}`)
    }
    if (JSON.stringify(before) !== JSON.stringify(moderationCounts())) throw new Error('DB changed')
  })

  // ── [C] Единен мют ─────────────────────────────────────────────────────
  const roomC = await createWaitingRoom(c.TgtC)
  let tgtCRoom = roomC
  let tgtDRoom = ''
  await check('[C] baseline: unmuted user can write in private chat, Теми and Лафче', async () => {
    const chat = await sendPrivateChat(c.TgtC, roomC)
    if (chat.type !== 'private_room_chat_message') throw new Error(`chat ${JSON.stringify(chat)}`)
    if ((await sendTopicMessage(c.TgtC, 'topic-general')) !== 'sent') throw new Error('topic send failed')
    if ((await sendTopicMessage(c.TgtC, 'topic-lafche')) !== 'sent') throw new Error('lafche send failed')
  })
  const editableMessageId = lastTopicMessageId(c.TgtC.profileId, 'topic-general')

  await check('[C] profile mute blocks private chat, Теми, Лафче (direct WS) and editing (direct HTTP)', async () => {
    const mute = await profileMute(port, c.Admin, c.TgtC.profileId)
    if (mute.status !== 200) throw new Error(`mute ${mute.status}`)
    const chat = await sendPrivateChat(c.TgtC, roomC)
    if (chat.type !== 'private_room_chat_error' || chat.code !== 'muted' || !chat.mutedUntil || chat.reason !== 'Обиди в чата на частната маса') {
      throw new Error(`chat ${JSON.stringify(chat)}`)
    }
    if (chat.message !== 'Временно сте заглушени. Не можете да изпращате съобщения до изтичане на наказанието.') throw new Error(`text ${chat.message}`)
    const before = topicMessageCount(c.TgtC.profileId)
    if ((await sendTopicMessage(c.TgtC, 'topic-general')) !== 'topic_muted') throw new Error('topic not blocked')
    if ((await sendTopicMessage(c.TgtC, 'topic-lafche')) !== 'topic_muted') throw new Error('lafche not blocked')
    if (topicMessageCount(c.TgtC.profileId) !== before) throw new Error('a blocked message was stored')
    const edit = await httpJson(port, 'PATCH', `/api/topics/topic-general/messages/${editableMessageId}`, c.TgtC.cookie, { body: 'редакция' })
    if (edit.status !== 403 || edit.body.code !== 'topic_muted') throw new Error(`edit ${edit.status} ${JSON.stringify(edit.body)}`)
    // Връзката и мястото на масата остават.
    if (c.TgtC.ws.readyState !== WebSocket.OPEN) throw new Error('connection was closed')
  })

  await check('[C] leaving and creating a brand new private room does not bypass the mute', async () => {
    send(c.TgtC, { type: 'leave_private_room' })
    await sleep(700)
    const newRoom = await createWaitingRoom(c.TgtC)
    tgtCRoom = newRoom
    const chat = await sendPrivateChat(c.TgtC, newRoom)
    if (chat.code !== 'muted') throw new Error(`new room chat ${JSON.stringify(chat)}`)
  })

  await check('[C] a second session (new device/tab / reconnect) does not bypass the mute', async () => {
    // Нова връзка поема профила (продуктът държи една активна връзка на
    // профил, освен по време на игра) и наследява членството в чакалнята —
    // мютът идва от DB при всяко изпращане, не от връзката.
    const second = await reconnectClient(port, c.TgtC)
    await sleep(700)
    if ((await sendTopicMessage(second, 'topic-general')) !== 'topic_muted') throw new Error('second session bypassed Теми')
    // Клиентът възстановява членството в чакалнята чрез request_private_rooms_list.
    send(second, { type: 'request_private_rooms_list' })
    await waitForFrame(second, (f) => f.type === 'private_room_updated' && f.room.id === tgtCRoom, 10_000, 'membership restored')
    const chat = await sendPrivateChat(second, tgtCRoom)
    if (chat.code !== 'muted') throw new Error(`second session private chat ${JSON.stringify(chat)}`)
    c.TgtC = second
  })

  await check('[C] mute from Лафче blocks the private table chat', async () => {
    const lafcheMessageId = (await sendTopicMessage(c.TgtD, 'topic-lafche')) === 'sent' ? lastTopicMessageId(c.TgtD.profileId, 'topic-lafche') : null
    const res = await httpJson(port, 'POST', '/api/topics/topic-lafche/mute', c.Admin.cookie, {
      profileId: c.TgtD.profileId, reason: 'Лафче нарушение', durationMs: ONE_HOUR_MS, sourceMessageId: lafcheMessageId, sourceKind: 'lafche_post',
    })
    if (res.status !== 200) throw new Error(`lafche mute ${res.status}`)
    const room = await createWaitingRoom(c.TgtD)
    tgtDRoom = room
    const chat = await sendPrivateChat(c.TgtD, room)
    if (chat.code !== 'muted') throw new Error(`chat ${JSON.stringify(chat)}`)
  })

  await check('[C] mute from a Тема blocks the private table chat', async () => {
    const res = await topicMute(port, c.Subadm, 'topic-general', c.TgtE.profileId)
    if (res.status !== 200) throw new Error(`topic mute ${res.status}`)
    const room = await createWaitingRoom(c.TgtE)
    const chat = await sendPrivateChat(c.TgtE, room)
    if (chat.code !== 'muted') throw new Error(`chat ${JSON.stringify(chat)}`)
  })

  // ── [D] Известия ───────────────────────────────────────────────────────
  let unmutedNoticeId = ''
  await check('[D] early unmute -> "unmuted" notice online (no "expired"); writing restored without re-login', async () => {
    c.TgtC.frames.length = 0
    const res = await profileUnmute(port, c.Subadm, c.TgtC.profileId)
    if (res.status !== 200) throw new Error(`unmute ${res.status}`)
    const notice = await waitForNotice(c.TgtC, 'unmuted')
    unmutedNoticeId = notice.noticeId
    await sleep(6000) // > един sweep цикъл — не бива да дойде и 'expired'
    if (noticeFrames(c.TgtC, 'expired').length > 0) throw new Error('an "expired" notice was also sent')
    const chat = await sendPrivateChat(c.TgtC, tgtCRoom)
    if (chat.type !== 'private_room_chat_message') throw new Error(`chat after unmute ${JSON.stringify(chat)}`)
    if ((await sendTopicMessage(c.TgtC, 'topic-general')) !== 'sent') throw new Error('topic after unmute')
  })

  await check('[D] multi-device: unacknowledged notice follows the profile to another device; OK there ends it everywhere', async () => {
    // Устройство 2 (нова връзка) получава СЪЩОТО непотвърдено известие.
    const device2 = await reconnectClient(port, c.TgtC)
    const redelivered = await waitForNotice(device2, 'unmuted', 8_000)
    if (redelivered.noticeId !== unmutedNoticeId) throw new Error('different notice on the second device')
    send(device2, { type: 'ack_mute_end_notice', noticeId: redelivered.noticeId })
    await waitForFrame(device2, (f) => f.type === 'mute_end_notices_cleared' && f.noticeIds.includes(redelivered.noticeId), 8_000, 'ack confirmed')
    // Устройство 3 / refresh — вече нищо.
    const device3 = await reconnectClient(port, c.TgtC)
    await sleep(1500)
    if (noticeFrames(device3).length > 0) throw new Error('acknowledged notice re-delivered')
    if (JSON.stringify(noticeStatuses(c.TgtC.profileId)) !== JSON.stringify(['unmuted:acknowledged'])) throw new Error(JSON.stringify(noticeStatuses(c.TgtC.profileId)))
    device3.ws.close()
  })

  await check('[D] natural expiry -> "expired" notice online (server sweep); writing restored', async () => {
    c.TgtD.frames.length = 0
    forceExpire(c.TgtD.profileId)
    const notice = await waitForNotice(c.TgtD, 'expired')
    if (notice.kind !== 'expired') throw new Error('wrong kind')
    const chat = await sendPrivateChat(c.TgtD, tgtDRoom)
    if (chat.type !== 'private_room_chat_message') throw new Error(`chat after expiry ${JSON.stringify(chat)}`)
  })

  await check('[D] offline expiry -> notice delivered on next connect', async () => {
    const res = await profileMute(port, c.Pika, c.TgtF.profileId)
    if (res.status !== 200) throw new Error('setup mute')
    c.TgtF.ws.close()
    await sleep(500)
    forceExpire(c.TgtF.profileId)
    await waitForCondition('sweep created notice', () => noticeStatuses(c.TgtF.profileId).includes('expired:pending'), 12_000)
    const back = await reconnectClient(port, c.TgtF)
    await waitForNotice(back, 'expired', 8_000)
    c.TgtF = back
  })

  await check('[D] new mute before delivery -> stale notice superseded, nothing shown', async () => {
    const res = await profileMute(port, c.Admin, c.TgtH.profileId)
    if (res.status !== 200) throw new Error('setup mute')
    c.TgtH.ws.close()
    await sleep(500)
    forceExpire(c.TgtH.profileId)
    await waitForCondition('sweep created notice', () => noticeStatuses(c.TgtH.profileId).includes('expired:pending'), 12_000)
    const again = await profileMute(port, c.Admin, c.TgtH.profileId)
    if (again.status !== 200) throw new Error(`re-mute ${again.status}`)
    const back = await reconnectClient(port, c.TgtH)
    await sleep(1500)
    if (noticeFrames(back).length > 0) throw new Error('stale "you can write" notice delivered while muted')
    if (!noticeStatuses(c.TgtH.profileId).includes('expired:superseded')) throw new Error(JSON.stringify(noticeStatuses(c.TgtH.profileId)))
    back.ws.close()
  })

  await check('[D] notice is delivered during an ACTIVE Belot game without touching gameplay', async () => {
    const res = await profileMute(port, c.Admin, c.TgtI.profileId)
    if (res.status !== 200) throw new Error('setup mute')
    const gameRoomId = await startPrivateGame(c.TgtI, c.TgtJ)
    const un = await profileUnmute(port, c.TopChat, c.TgtI.profileId)
    if (un.status !== 200) throw new Error('unmute')
    await waitForNotice(c.TgtI, 'unmuted', 8_000)
    // Играта продължава СЛЕД известието: нови snapshot-и, масата е 'playing',
    // седалката на играча НЕ е предадена на бот, няма грешки.
    const noticeIndex = c.TgtI.frames.findIndex((f) => f.type === 'mute_end_notices')
    // Следващ snapshot може да чака човешки ход (до 15s) — играта трябва да
    // продължи нормално след известието.
    await waitForCondition(
      'game snapshot after notice',
      () => c.TgtI.frames.slice(noticeIndex).some((f) => f.type === 'room_snapshot' && f.roomId === gameRoomId),
      25_000,
    )
    const snapsAfter = c.TgtI.frames.slice(noticeIndex).filter((f) => f.type === 'room_snapshot' && f.roomId === gameRoomId)
    const last = snapsAfter[snapsAfter.length - 1]
    if (last.roomStatus !== 'playing') throw new Error(`room status ${last.roomStatus}`)
    // Поемане от бот е допустимо САМО като нормален таймаут на човешкия ход
    // (тестът нарочно не играе) — никога като следствие от известието.
    const allSnaps = c.TgtI.frames.filter((f) => f.type === 'room_snapshot' && f.roomId === gameRoomId && f.game)
    const takeoverIndex = allSnaps.findIndex((s) => s.seats.find((seat: any) => seat.seat === s.yourSeat)?.isControlledByBot === true)
    if (takeoverIndex >= 0) {
      const takeover = allSnaps[takeoverIndex]
      const myTurnDeadlines = allSnaps
        .slice(0, takeoverIndex)
        .filter((s) => activeSeatOfGame(s.game) === s.yourSeat && typeof s.game.timerDeadlineAt === 'number')
        .map((s) => s.game.timerDeadlineAt as number)
      const deadline = myTurnDeadlines.length > 0 ? Math.max(...myTurnDeadlines) : null
      if (deadline === null || takeover.game.serverNow < deadline) {
        throw new Error(`seat handed to a bot before its turn deadline (serverNow=${takeover.game.serverNow}, deadline=${deadline})`)
      }
    }
    if (c.TgtI.frames.some((f) => f.type === 'error')) throw new Error('error frame during game')
  })

  await check('[D] restart recovery: pending notice + mute expired while server was down are delivered after restart', async () => {
    // TgtG: мют, изтича ДОКАТО сървърът е спрян. TgtE: pending 'unmuted' без OK.
    const res = await profileMute(port, c.Admin, c.TgtG.profileId)
    if (res.status !== 200) throw new Error('setup mute')
    const un = await profileUnmute(port, c.Admin, c.TgtE.profileId)
    if (un.status !== 200) throw new Error('setup unmute')
    await stopServer(server)
    await sleep(2000) // Windows освобождава SQLite WAL/SHM handle-ите със закъснение
    forceExpire(c.TgtG.profileId)
    await bootServer()
    const g = await reconnectClient(port, c.TgtG)
    const e = await reconnectClient(port, c.TgtE)
    await waitForNotice(g, 'expired', 15_000)
    await waitForNotice(e, 'unmuted', 8_000)
    g.ws.close()
    e.ws.close()
  })
} finally {
  await stopServer(server)
  await isolated.cleanup()
}

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
