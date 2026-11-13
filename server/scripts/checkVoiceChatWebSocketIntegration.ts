/**
 * checkVoiceChatWebSocketIntegration.ts
 *
 * Гласов чат (Етап 2б) — интеграционен тест с РЕАЛЕН сървърен процес в
 * изолирано временно копие (собствена temp SQLite база), реални HTTP
 * регистрации и cookie сесии, реални WebSocket връзки и FAKE LiveKit Twirp
 * сървър на 127.0.0.1 (по образеца на checkPrivateRoomWebSocketRoundTrip /
 * checkUnifiedMuteWebSocket). Никога production, реален LiveKit или реални
 * потребители; токени и тайни не се печатат.
 *
 * Покрива през истинския протокол:
 *   [I1] админ режим public; non-VIP не може да създаде гласова маса
 *   [I2] VIP създава маса; voiceTableId само към седналия играч
 *   [I3] voice_presence -> token по HTTPS (cookie): точни grants, namespace,
 *        CreateRoom с 4 участника; no-store
 *   [I4] чужд профил/връзка: presence и token отказани
 *   [I5] non-VIP гост: слуша (canPublish:false)
 *   [I6] реален admin mute (/api/topics/profile-mute): говоренето е отнето
 *        (UpdateParticipant без publish + ротация), гостът получава сигнал,
 *        текстовият чат в чакалнята продължава да отказва (единният mute)
 *   [I7] реално премахване (/api/topics/unmute): известие, без автоматичен
 *        микрофон; токенът отново позволява говорене
 *   [I8] network reconnect на същата страница: без ротация
 *   [I9] гостът напуска с токен -> ротация; последният напуска -> слотът е
 *        освободен (празна чакалня), стаята е изтрита
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/checkVoiceChatWebSocketIntegration.ts --server-root=.
 *
 * Изисква актуален server/dist (npm run build) — копира се в изолираното копие.
 */

import { spawn } from 'node:child_process'
import { createHmac, randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, rm, rmdir, symlink } from 'node:fs/promises'
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createNetServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import WebSocket from 'ws'
import { verifyVerificationCode } from '../src/db/authHelpers.js'

const TEST_REGISTRATION_SECRET = 'voice-ws-integration-registration-secret-0123456789abcd'
const API_KEY = `APIws${randomUUID().slice(0, 8)}`
const API_SECRET = randomUUID() + randomUUID()
const NAMESPACE = 'wsit'
let testDatabaseFile = ''

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
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function findFreePort(): Promise<number> {
  return new Promise((resolveFree, reject) => {
    const srv = createNetServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port
      srv.close(() => resolveFree(port))
    })
  })
}

async function waitFor(label: string, predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(50)
  }
  throw new Error(`timeout: ${label}`)
}

// ─── Fake LiveKit (само метод/стая в паметта; Authorization се проверява) ──
type FakeCall = { method: string; body: Record<string, unknown> }
const fakeRooms = new Map<string, Set<string>>()
const fakeCalls: FakeCall[] = []
function verifyAdmin(header: string | undefined): boolean {
  if (header === undefined || !header.startsWith('Bearer ')) return false
  const [h, p, sig] = header.slice(7).split('.')
  if (h === undefined || p === undefined || sig === undefined) return false
  return createHmac('sha256', API_SECRET).update(`${h}.${p}`).digest('base64url') === sig
}
const fakeServer = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
  let raw = ''
  req.on('data', (c: Buffer) => { raw += c.toString('utf8') })
  req.on('end', () => {
    const send = (status: number, payload: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    }
    if (!verifyAdmin(req.headers.authorization)) return send(401, { code: 'unauthenticated', msg: 'bad' })
    const method = (req.url ?? '').split('/').pop() ?? ''
    const body = (raw === '' ? {} : JSON.parse(raw)) as Record<string, unknown>
    fakeCalls.push({ method, body })
    const room = String(body.room ?? body.name ?? '')
    switch (method) {
      case 'CreateRoom':
        if (!fakeRooms.has(room)) fakeRooms.set(room, new Set())
        return send(200, { name: room, sid: 'RM_x', maxParticipants: body.maxParticipants })
      case 'DeleteRoom':
        return fakeRooms.delete(room) ? send(200, {}) : send(404, { code: 'not_found', msg: 'nf' })
      case 'ListRooms': {
        const names = Array.isArray(body.names) ? (body.names as string[]) : []
        return send(200, { rooms: [...fakeRooms.keys()].filter((n) => names.length === 0 || names.includes(n)).map((name) => ({ name, sid: 'RM_x' })) })
      }
      case 'UpdateParticipant':
      case 'RemoveParticipant': {
        const participants = fakeRooms.get(room)
        if (participants === undefined || !participants.has(String(body.identity))) return send(404, { code: 'not_found', msg: 'nf' })
        if (method === 'RemoveParticipant') participants.delete(String(body.identity))
        return send(200, method === 'UpdateParticipant' ? { identity: body.identity, permission: body.permission } : {})
      }
      default:
        return send(404, { code: 'bad_route', msg: 'nf' })
    }
  })
})

// ─── Изолиран сървър ──────────────────────────────────────────────────────
const sourceServerRoot = resolve(
  process.argv.slice(2).find((a) => a.startsWith('--server-root='))?.slice('--server-root='.length) ?? process.cwd(),
)
type Isolated = { root: string; serverDir: string; junctions: string[] }
async function createIsolatedServerRoot(): Promise<Isolated> {
  const root = await mkdtemp(join(tmpdir(), 'belot-voice-ws-'))
  const serverDir = join(root, 'server')
  await mkdir(serverDir, { recursive: true })
  await cp(join(sourceServerRoot, 'src'), join(serverDir, 'src'), { recursive: true, preserveTimestamps: true })
  await cp(join(sourceServerRoot, 'dist'), join(serverDir, 'dist'), { recursive: true, preserveTimestamps: true })
  await mkdir(join(serverDir, 'database', 'data'), { recursive: true })
  await cp(join(sourceServerRoot, 'database', 'migrations'), join(serverDir, 'database', 'migrations'), { recursive: true, preserveTimestamps: true })
  await cp(join(sourceServerRoot, 'package.json'), join(serverDir, 'package.json'), { preserveTimestamps: true })
  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  const serverModules = join(serverDir, 'node_modules')
  const rootModules = join(root, 'node_modules')
  await symlink(join(sourceServerRoot, 'node_modules'), serverModules, linkType)
  await symlink(join(sourceServerRoot, '..', 'node_modules'), rootModules, linkType)
  return { root, serverDir, junctions: [serverModules, rootModules] }
}
async function cleanupIsolated(isolated: Isolated): Promise<void> {
  // Първо САМО връзките (rmdir на junction маха връзката, не целта), после копието.
  for (const junction of isolated.junctions) await rmdir(junction).catch(() => {})
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await rm(isolated.root, { recursive: true, force: true })
      return
    } catch {
      await sleep(250)
    }
  }
}

type RunningServer = { child: ReturnType<typeof spawn>; output: () => string }
function startServer(serverDir: string, port: number, fakePort: number): RunningServer {
  const chunks: string[] = []
  const child = spawn(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'index.ts')], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(port),
      PASSWORD_RESET_RATE_LIMIT_SECRET: TEST_REGISTRATION_SECRET,
      LIVEKIT_API_URL: `http://127.0.0.1:${fakePort}`,
      LIVEKIT_WS_URL: `ws://127.0.0.1:${fakePort}`,
      LIVEKIT_API_KEY: API_KEY,
      LIVEKIT_API_SECRET: API_SECRET,
      VOICE_ROOM_NAMESPACE: NAMESPACE,
      VOICE_CHAT_ENABLED: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (c: string) => chunks.push(c))
  child.stderr.on('data', (c: string) => chunks.push(c))
  return { child, output: () => chunks.join('') }
}
async function stopServer(server: RunningServer | null): Promise<void> {
  if (!server || server.child.exitCode !== null) return
  server.child.kill('SIGTERM')
  await new Promise<void>((r) => {
    const t = setTimeout(() => { server.child.kill('SIGKILL'); r() }, 10_000)
    server.child.once('exit', () => { clearTimeout(t); r() })
  })
}

function withDb<T>(fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(testDatabaseFile, { open: true, timeout: 5_000 })
  try { return fn(db) } finally { db.close() }
}

// ─── HTTP / WS клиенти ────────────────────────────────────────────────────
async function httpJson(port: number, method: string, pathname: string, cookie: string | null, body?: unknown): Promise<{ status: number; body: any; setCookie: string | null; headers: Headers }> {
  const res = await fetch(`http://localhost:${port}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const setCookie = (res.headers.getSetCookie?.()[0] ?? res.headers.get('set-cookie'))?.split(';')[0] ?? null
  let json: any = null
  try { json = await res.json() } catch { /* not json */ }
  return { status: res.status, body: json, setCookie, headers: res.headers }
}

type Client = { tag: string; profileId: string; cookie: string; ws: WebSocket; frames: any[]; instance: string }

async function register(port: number, tag: string): Promise<{ cookie: string; profileId: string }> {
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const reg = await httpJson(port, 'POST', '/api/auth/register', null, {
    email: `voice-ws-${tag}-${runId}@example.test`,
    password: 'VoiceWsDiag1!',
    displayName: `VWS ${tag}`,
    gender: 'male',
    visitorId: randomUUID(),
  })
  const pendingRegistrationId: string | undefined = reg.body?.pendingRegistrationId
  if (!pendingRegistrationId) throw new Error(`register ${tag}: ${reg.status}`)
  const row = withDb((db) => db.prepare(`SELECT code_hash FROM pending_registrations WHERE pending_registration_id = ?`).get(pendingRegistrationId) as { code_hash: string } | undefined)
  if (!row) throw new Error('pending row')
  let code = ''
  for (let candidate = 0; candidate < 1_000_000; candidate += 1) {
    const attempt = candidate.toString().padStart(6, '0')
    if (verifyVerificationCode(attempt, TEST_REGISTRATION_SECRET, row.code_hash)) { code = attempt; break }
  }
  const verifyBody = { pendingRegistrationId, code, rememberMe: true }
  let verified = await httpJson(port, 'POST', '/api/auth/verify-registration-email', null, verifyBody).catch(async () => {
    await sleep(200)
    return httpJson(port, 'POST', '/api/auth/verify-registration-email', null, verifyBody)
  })
  if (verified.status !== 200) {
    await sleep(200)
    verified = await httpJson(port, 'POST', '/api/auth/verify-registration-email', null, verifyBody)
  }
  if (verified.status !== 200) throw new Error(`verify ${tag}: ${verified.status}`)
  return { cookie: verified.setCookie as string, profileId: verified.body.session.profile.profileId }
}

async function openWs(port: number, cookie: string): Promise<{ ws: WebSocket; frames: any[] }> {
  const ws = new WebSocket(`ws://localhost:${port}/ws`, { headers: { Cookie: cookie } })
  const frames: any[] = []
  ws.on('message', (data) => { try { frames.push(JSON.parse(data.toString())) } catch { /* ignore */ } })
  await new Promise<void>((resolveOpen, reject) => { ws.once('open', () => resolveOpen()); ws.once('error', reject) })
  return { ws, frames }
}

async function connect(port: number, tag: string): Promise<Client> {
  const { cookie, profileId } = await register(port, tag)
  const { ws, frames } = await openWs(port, cookie)
  return { tag, profileId, cookie, ws, frames, instance: `inst_${tag}_${randomUUID().replace(/-/g, '')}`.slice(0, 48) }
}

function send(client: Client, message: Record<string, unknown>): void {
  client.ws.send(JSON.stringify(message))
}

async function next(client: Client, predicate: (frame: any) => boolean, label: string, timeoutMs = 10_000): Promise<any> {
  const start = client.frames.length
  await waitFor(label, () => client.frames.slice(start).some(predicate), timeoutMs)
  return client.frames.slice(start).find(predicate)
}

/** Чака кадър, който може вече да е пристигнал след индекс `from`. */
async function frameAfter(client: Client, from: number, predicate: (frame: any) => boolean, label: string, timeoutMs = 10_000): Promise<any> {
  await waitFor(label, () => client.frames.slice(from).some(predicate), timeoutMs)
  return client.frames.slice(from).find(predicate)
}

async function presence(client: Client, voiceTableId: string, onTableScreen = true): Promise<any> {
  const from = client.frames.length
  send(client, { type: 'voice_presence', voiceTableId, clientInstanceId: client.instance, onTableScreen })
  return frameAfter(client, from, (f) => f.type === 'voice_presence_result' && f.voiceTableId === voiceTableId, `presence ${client.tag}`)
}

function decodeVideo(token: string): Record<string, unknown> {
  const payload = JSON.parse(Buffer.from(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as Record<string, unknown>
  return payload.video as Record<string, unknown>
}

async function voiceToken(port: number, client: Client, voiceTableId: string): Promise<{ status: number; body: any; headers: Headers }> {
  return httpJson(port, 'POST', '/api/voice/token', client.cookie, { voiceTableId, clientInstanceId: client.instance })
}

/** Повтаря при временни 503 (ротация/старт) — както би правил клиентът с backoff. */
async function voiceTokenReady(port: number, client: Client, voiceTableId: string): Promise<{ status: number; body: any; headers: Headers }> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = await voiceToken(port, client, voiceTableId)
    if (result.status !== 503) return result
    await sleep(150)
  }
  return voiceToken(port, client, voiceTableId)
}

// ─── Тест ─────────────────────────────────────────────────────────────────
console.log('\ncheckVoiceChatWebSocketIntegration\n')

let server: RunningServer | null = null
await new Promise<void>((r) => fakeServer.listen(0, '127.0.0.1', () => r()))
const fakePort = (fakeServer.address() as AddressInfo).port
const isolated = await createIsolatedServerRoot()
testDatabaseFile = join(isolated.serverDir, 'database', 'data', 'belot-v2.sqlite')
const clients: Client[] = []

try {
  const port = await findFreePort()
  server = startServer(isolated.serverDir, port, fakePort)
  try {
    await waitFor('server ready', () => server!.output().includes('server is running'), 90_000)
  } catch (error) {
    console.error(server.output().slice(-3000))
    throw error
  }
  assert(server.output().includes('[voice-chat] boot reconcile'), 'boot reconcile при старт')

  const admin = await connect(port, 'admin')
  const host = await connect(port, 'host')
  const guest = await connect(port, 'guest')
  const outsider = await connect(port, 'outsider')
  clients.push(admin, host, guest, outsider)
  withDb((db) => {
    db.prepare(`UPDATE accounts SET role = 'admin' WHERE account_id = (SELECT account_id FROM profiles WHERE profile_id = ?)`).run(admin.profileId)
    for (const client of [host, guest, outsider]) {
      const changed = db.prepare('UPDATE profile_wallets SET yellow_coins_balance = 100000 WHERE profile_id = ?').run(client.profileId)
      if (Number(changed.changes) === 0) db.prepare('INSERT INTO profile_wallets (profile_id, yellow_coins_balance) VALUES (?, 100000)').run(client.profileId)
    }
    db.prepare(`INSERT INTO vip_status (profile_id, active_until, updated_at) VALUES (?, '2031-01-01T00:00:00.000Z', CURRENT_TIMESTAMP)`).run(host.profileId)
  })

  let voiceTableId = ''
  let privateRoomId = ''

  await check('[I1] Админ: режим public; non-VIP с voiceEnabled -> отказ voice_chat_vip_required и масата НЕ се създава', async () => {
    const mode = await httpJson(port, 'POST', '/api/admin/voice-chat/mode', admin.cookie, { mode: 'public', confirm: true })
    assert(mode.status === 200 && mode.body.effectiveMode === 'public' && mode.headers.get('cache-control') === 'no-store', `mode ${mode.status}`)
    assert(mode.body.liveKit?.configured === true && JSON.stringify(mode.body).includes(API_SECRET) === false, 'LiveKit конфигуриран, без тайни')
    const from = guest.frames.length
    send(guest, { type: 'create_private_room', stake: 5000, isLocked: false, waitMinutes: 15, voiceEnabled: true })
    const error = await frameAfter(guest, from, (f) => f.type === 'error' && typeof f.code === 'string' && f.code.startsWith('voice_chat_'), 'non-VIP error')
    assert(error.code === 'voice_chat_vip_required', error.code)
    await sleep(200)
    assert(!guest.frames.slice(from).some((f) => f.type === 'private_room_updated'), 'масата не е създадена')
  })

  await check('[I2] VIP създава гласова маса; voiceTableId е в snapshot-а на седналия, не в лобито', async () => {
    const from = host.frames.length
    send(host, { type: 'create_private_room', stake: 5000, isLocked: false, waitMinutes: 15, voiceEnabled: true })
    const created = await frameAfter(host, from, (f) => f.type === 'private_room_updated', 'create')
    assert(created.room.voiceEnabled === true && typeof created.room.voiceTableId === 'string', JSON.stringify({ e: created.room.voiceEnabled, id: created.room.voiceTableId }))
    voiceTableId = created.room.voiceTableId
    privateRoomId = created.room.id
    const listFrom = outsider.frames.length
    send(outsider, { type: 'request_private_rooms_list' })
    const list = await frameAfter(outsider, listFrom, (f) => f.type === 'private_rooms_list', 'list')
    const listed = (list.rooms as any[]).find((r) => r.id === privateRoomId)
    assert(listed !== undefined && listed.voiceEnabled === true && listed.voiceTableId === null, 'лоби: икона да, id не')
    assert(!fakeCalls.some((c) => c.method === 'CreateRoom'), 'LiveKit не участва в създаването')
  })

  await check('[I3] voice_presence -> POST /api/voice/token: точни grants, namespace, CreateRoom(4), no-store, токенът не е в WS кадрите', async () => {
    const ack = await presence(host, voiceTableId)
    assert(ack.ok === true && ack.speak.canSpeak === true && ack.leaseTtlMs === 60_000, JSON.stringify(ack))
    const result = await voiceTokenReady(port, host, voiceTableId)
    assert(result.status === 200 && result.headers.get('cache-control') === 'no-store', `token ${result.status} ${JSON.stringify(result.body?.code)}`)
    const video = decodeVideo(result.body.token)
    assert(String(video.room).startsWith(`pv_${NAMESPACE}_`), 'namespace в името')
    assert(video.canPublish === true && JSON.stringify(video.canPublishSources) === '["microphone"]' && video.canPublishData === false, 'grants')
    assert(video.roomAdmin === undefined && video.roomCreate === undefined && video.roomList === undefined, 'без admin grants')
    const create = fakeCalls.find((c) => c.method === 'CreateRoom')
    assert(create !== undefined && create.body.maxParticipants === 4 && create.body.name === video.room, 'CreateRoom')
    assert(!host.frames.some((f) => JSON.stringify(f).includes(result.body.token)), 'токенът никога през WS')
    fakeRooms.get(String(video.room))?.add(String(result.body.identity))
  })

  await check('[I4] Чужд профил: presence not_a_player, token 403; без сесия 401; чужд origin 403', async () => {
    const ack = await presence(outsider, voiceTableId)
    assert(ack.ok === false && ack.code === 'not_a_player', JSON.stringify(ack))
    const denied = await voiceToken(port, outsider, voiceTableId)
    assert(denied.status === 403 && denied.body.token === undefined, `${denied.status}`)
    const anon = await httpJson(port, 'POST', '/api/voice/token', null, { voiceTableId, clientInstanceId: outsider.instance })
    assert(anon.status === 401, `${anon.status}`)
    const foreign = await fetch(`http://localhost:${port}/api/voice/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: host.cookie, Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' },
      body: JSON.stringify({ voiceTableId, clientInstanceId: host.instance }),
    })
    assert(foreign.status === 403, `origin ${foreign.status}`)
  })

  await check('[I5] Non-VIP гост сяда: voiceTableId в неговия snapshot; слуша (canPublish:false, vip_required)', async () => {
    const from = guest.frames.length
    send(guest, { type: 'join_private_room', privateRoomId, team: 'B', slotIndex: 0 })
    const joined = await frameAfter(guest, from, (f) => f.type === 'private_room_updated' && f.room.id === privateRoomId, 'join')
    assert(joined.room.voiceTableId === voiceTableId, 'id към седналия')
    const ack = await presence(guest, voiceTableId)
    assert(ack.ok === true && ack.speak.canSpeak === false && ack.speak.blockedReason === 'vip_required', JSON.stringify(ack.speak))
    const result = await voiceTokenReady(port, guest, voiceTableId)
    const video = decodeVideo(result.body.token)
    assert(result.status === 200 && video.canPublish === false && video.canSubscribe === true, 'слуша')
    fakeRooms.get(String(video.room))?.add(String(result.body.identity))
  })

  let hostIdentity = ''
  await check('[I6] Реален admin mute: отнема publish (UpdateParticipant без publish) + ротация; гостът получава сигнал; текстовият чат в чакалнята отказва (непроменено)', async () => {
    const before = await voiceTokenReady(port, host, voiceTableId)
    hostIdentity = String(before.body.identity)
    const oldRoom = String(decodeVideo(before.body.token).room)
    fakeRooms.get(oldRoom)?.add(hostIdentity)
    const hostFrom = host.frames.length
    const guestFrom = guest.frames.length
    const callsFrom = fakeCalls.length
    const muted = await httpJson(port, 'POST', '/api/topics/profile-mute', admin.cookie, {
      profileId: host.profileId,
      reason: 'Обиди в чата на частната маса',
      durationMs: 60 * 60 * 1000,
      reasonCategory: 'insults',
    })
    assert(muted.status === 200, `mute ${muted.status} ${JSON.stringify(muted.body)}`)
    const update = await frameAfter(host, hostFrom, (f) => f.type === 'voice_speak_access_updated', 'speak update')
    assert(update.speak.canSpeak === false && update.speak.blockedReason === 'muted' && typeof update.speak.mutedUntil === 'string', JSON.stringify(update.speak))
    assert(update.speak.hasSpeakingEntitlement === true, 'придобитото право се пази')
    await frameAfter(guest, guestFrom, (f) => f.type === 'voice_table_updated' && f.ready === false, 'guest rotation signal')
    assert(!guest.frames.slice(guestFrom).some((f) => f.type === 'voice_speak_access_updated'), 'наказанието не се праща на други')
    await waitFor('revoke publish', () => fakeCalls.slice(callsFrom).some((c) => c.method === 'UpdateParticipant' && c.body.identity === hostIdentity), 5_000)
    const revoke = fakeCalls.slice(callsFrom).find((c) => c.method === 'UpdateParticipant' && c.body.identity === hostIdentity)!
    const permission = revoke.body.permission as Record<string, unknown>
    assert(permission.canSubscribe === true && permission.canPublish !== true, 'само publish е отнет')
    await waitFor('old room deleted', () => !fakeRooms.has(oldRoom), 10_000)
    await frameAfter(guest, guestFrom, (f) => f.type === 'voice_table_updated' && f.ready === true, 'ready after delete')
    const after = await voiceTokenReady(port, host, voiceTableId)
    const video = decodeVideo(after.body.token)
    assert(after.status === 200 && video.canPublish === false && video.room !== oldRoom, 'само слушане в новата генерация')
    assert(after.body.speak.blockedReason === 'muted', 'причина в отговора')
    const chatFrom = host.frames.length
    send(host, { type: 'send_private_room_chat_message', privateRoomId, body: 'тест', requestId: 'r-muted' })
    const chatError = await frameAfter(host, chatFrom, (f) => f.type === 'private_room_chat_error', 'chat muted')
    assert(chatError.code === 'muted', `текстов mute: ${chatError.code}`)
    fakeRooms.get(String(video.room))?.add(String(after.body.identity))
    hostIdentity = String(after.body.identity)
  })

  await check('[I7] Реално премахване на mute: известие canSpeak, БЕЗ автоматичен микрофон; изричен speak-access; новият токен позволява говорене', async () => {
    const hostFrom = host.frames.length
    const callsFrom = fakeCalls.length
    const unmuted = await httpJson(port, 'POST', '/api/topics/unmute', admin.cookie, { profileId: host.profileId })
    assert(unmuted.status === 200, `unmute ${unmuted.status}`)
    const update = await frameAfter(host, hostFrom, (f) => f.type === 'voice_speak_access_updated', 'unmute update')
    assert(update.speak.canSpeak === true && update.speak.blockedReason === null, JSON.stringify(update.speak))
    await sleep(300)
    assert(!fakeCalls.slice(callsFrom).some((c) => c.method === 'UpdateParticipant'), 'без автоматично повишаване')
    const speak = await httpJson(port, 'POST', '/api/voice/speak-access', host.cookie, { voiceTableId, clientInstanceId: host.instance })
    assert(speak.status === 200 && speak.body.canSpeak === true && speak.body.upgrade === 'updated', JSON.stringify(speak.body))
    const grant = fakeCalls.slice(callsFrom).find((c) => c.method === 'UpdateParticipant' && c.body.identity === hostIdentity)
    assert(grant !== undefined && JSON.stringify((grant.body.permission as Record<string, unknown>).canPublishSources) === '["MICROPHONE"]', 'UpdateParticipant само микрофон')
    const token = await voiceTokenReady(port, host, voiceTableId)
    assert(token.status === 200 && decodeVideo(token.body.token).canPublish === true, 'говори отново')
  })

  await check('[I8] Network reconnect на същата страница: нова WS връзка + същия clientInstanceId -> без ротация', async () => {
    const generationBefore = (await voiceTokenReady(port, host, voiceTableId)).body.generation
    host.ws.close()
    await sleep(300)
    const reopened = await openWs(port, host.cookie)
    host.ws = reopened.ws
    host.frames = reopened.frames
    const listFrom = host.frames.length
    send(host, { type: 'request_private_rooms_list' })
    await frameAfter(host, listFrom, (f) => f.type === 'private_rooms_list', 'resync')
    const ack = await presence(host, voiceTableId)
    assert(ack.ok === true, JSON.stringify(ack))
    const again = await voiceTokenReady(port, host, voiceTableId)
    assert(again.status === 200 && again.body.generation === generationBefore, 'същата генерация (без ротация)')
  })

  await check('[I9] Гостът напуска с токен -> ротация; последният напуска -> празна чакалня освобождава слота и стаята се трие', async () => {
    // Токен за ТЕКУЩАТА генерация (стар токен от оттеглена генерация не изисква ротация).
    await presence(guest, voiceTableId)
    const current = await voiceTokenReady(port, guest, voiceTableId)
    assert(current.status === 200, `guest token ${current.status}`)
    const hostFrom = host.frames.length
    send(guest, { type: 'leave_private_room' })
    await frameAfter(host, hostFrom, (f) => f.type === 'voice_table_updated' && f.ready === false, 'rotation after guest leave')
    const state = await httpJson(port, 'GET', '/api/admin/voice-chat', admin.cookie)
    assert(state.status === 200 && state.body.activeVoiceTables === 1, `active ${state.body?.activeVoiceTables}`)
    send(host, { type: 'leave_private_room' })
    await waitFor('slot released', () => true)
    let active = -1
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const snapshot = await httpJson(port, 'GET', '/api/admin/voice-chat', admin.cookie)
      active = snapshot.body.activeVoiceTables
      if (active === 0 && snapshot.body.pendingRoomDeletions === 0) break
      await sleep(150)
    }
    assert(active === 0, `слотът не е освободен: ${active}`)
    await waitFor('all voice rooms deleted', () => [...fakeRooms.keys()].every((name) => !name.startsWith(`pv_${NAMESPACE}_`)), 10_000)
  })
} finally {
  for (const client of clients) {
    try { client.ws.close() } catch { /* ignore */ }
  }
  await stopServer(server)
  await new Promise<void>((r) => fakeServer.close(() => r()))
  await cleanupIsolated(isolated)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
