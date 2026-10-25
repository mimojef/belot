/**
 * checkProfileDeletionCrossProcessCommitments.ts
 *
 * Самоизтриване на профили — Етап 4K1: ангажименти, видими САМО в паметта на
 * друг сървърен процес. Два РЕАЛНИ процеса (src/index.ts) с обща временна
 * SQLite база и общ временен регистър. Никога реалната база.
 *
 * Процес A приема HTTP заявката (не вижда масата), процес B държи масата в
 * паметта си. B открива събитието 'requested' чрез poll-а и отменя заявката
 * през durable протокола от 4J1 (системен ред -> request_cancelled в
 * регистъра -> offsite ack -> cancelled).
 *
 * [X1] Чакаща маса в Белот в B: краен резултат за заявката, отмяната,
 *      регистъра, видимостта, сесиите, WS връзката и мястото.
 * [X2] Чакаща маса в „Не се сърди човече“ в B.
 * [X3] Активна игра на Белот в B: персистираният snapshot отказва още в A.
 * [X4] Рестарт по време на състезанието: B умира преди poll-а; B умира след
 *      приемането на отмяната (преди offsite); A умира веднага след отговора.
 */

import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Readable } from 'node:stream'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import WebSocket from 'ws'
import { ensureServerDatabaseReady } from '../src/db/ensureServerDatabaseReady.js'
import { readProfileDeletionLedger } from '../src/db/profileDeletionLedger.js'
import { writeTestLedgerAck } from './fixtures/profileDeletionCancellationKit.js'

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

const SECRET = 'profile-deletion-cross-process-secret-0123456789'
const PASSWORD = 'cross-process-pass-5521'
const STAKE = 5000

const originalServerRoot = resolve(
  process.argv.slice(2).find((a) => a.startsWith('--server-root='))?.slice('--server-root='.length) ?? process.cwd(),
)

console.log('\ncheckProfileDeletionCrossProcessCommitments')
console.log(`Server root: ${originalServerRoot}`)

async function getFreePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolvePort(port))
    })
  })
}

const isolatedRoot = await mkdtemp(join(tmpdir(), 'belot-deletion-cross-process-'))
const ledgerPath = join(isolatedRoot, 'deletion-ledger', 'profile-deletions.jsonl')
const serverDir = join(isolatedRoot, 'server')
await mkdir(serverDir, { recursive: true })
await cp(join(originalServerRoot, 'src'), join(serverDir, 'src'), { recursive: true, preserveTimestamps: true })
await cp(join(originalServerRoot, 'dist'), join(serverDir, 'dist'), { recursive: true, preserveTimestamps: true })
await mkdir(join(serverDir, 'database', 'data'), { recursive: true })
await cp(join(originalServerRoot, 'database', 'migrations'), join(serverDir, 'database', 'migrations'), { recursive: true, preserveTimestamps: true })
await cp(join(originalServerRoot, 'package.json'), join(serverDir, 'package.json'), { preserveTimestamps: true })
const linkType = process.platform === 'win32' ? 'junction' : 'dir'
await symlink(join(originalServerRoot, 'node_modules'), join(serverDir, 'node_modules'), linkType)
await symlink(join(originalServerRoot, '..', 'node_modules'), join(isolatedRoot, 'node_modules'), linkType)

type RunningServer = { label: string; port: number; child: ChildProcessByStdio<null, Readable, Readable>; output(): string }

function startServer(label: string, port: number): RunningServer {
  const chunks: string[] = []
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    BELOT_GAME_WORKER_TICK_MODE: 'worker-candidate',
    BELOT_GAME_WORKER_COUNT: '1',
    PASSWORD_RESET_RATE_LIMIT_SECRET: SECRET,
    PROFILE_DELETION_LEDGER_PATH: ledgerPath,
    PROFILE_SELF_DELETION_ENABLED: '1',
    PROFILE_DELETION_CANCELLATION_FINALIZER_INTERVAL_MS: '300',
  }
  delete env.PROFILE_DELETION_LEDGER_OFFSITE_REQUIRED // offsite ack е задължителен (production поведение)
  const child = spawn(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'index.ts')], {
    cwd: serverDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (c: string) => chunks.push(c))
  child.stderr.on('data', (c: string) => chunks.push(c))
  return { label, port, child, output: () => chunks.join('') }
}

async function killServer(server: RunningServer, signal: NodeJS.Signals): Promise<void> {
  if (server.child.exitCode !== null || server.child.signalCode !== null) return
  const exited = new Promise<void>((res) => server.child.once('exit', () => res()))
  server.child.kill(signal)
  const timer = setTimeout(() => server.child.kill('SIGKILL'), 10_000)
  await exited
  clearTimeout(timer)
}

async function waitForHealth(server: RunningServer): Promise<void> {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) throw new Error(`Сървър ${server.label} спря:\n${server.output().slice(-2000)}`)
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/health`)
      const health = await res.json() as { ok?: boolean; gameWorkerLifecycle?: { state?: string } }
      if (res.ok && health.ok === true && health.gameWorkerLifecycle?.state === 'ready') return
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`Timeout: health ${server.label}\n${server.output().slice(-2000)}`)
}

const bootstrap = await ensureServerDatabaseReady({ serverRootOverride: serverDir })
const db = new DatabaseSync(bootstrap.databaseFilePath)
db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;')
db.prepare(`UPDATE admin_settings SET setting_value = 'direct' WHERE setting_key = 'registration_verification_mode';`).run()

const servers: RunningServer[] = []
const sockets: WebSocket[] = []

try {
  let serverA = startServer('A', await getFreePort())
  servers.push(serverA)
  await waitForHealth(serverA)
  let serverB = startServer('B', await getFreePort())
  servers.push(serverB)
  await waitForHealth(serverB)

  async function api(server: RunningServer, path: string, init: { method?: string; cookie?: string; body?: unknown } = {}): Promise<{ status: number; json: any; setCookie: string }> {
    const res = await fetch(`http://127.0.0.1:${server.port}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(init.cookie ? { Cookie: init.cookie } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    })
    const text = await res.text()
    let json: any = null
    try { json = JSON.parse(text) } catch { json = text }
    return { status: res.status, json, setCookie: res.headers.get('set-cookie') ?? '' }
  }

  type User = { profileId: string; email: string; displayName: string; cookie: string }
  let counter = 0
  async function register(label: string): Promise<User> {
    counter += 1
    db.prepare(`DELETE FROM registration_rate_limit_events WHERE scope = 'registration-direct-ip';`).run()
    const email = `xproc-${label.toLowerCase()}-${counter}@example.test`
    const displayName = `Xp${label}${counter}`.slice(0, 20)
    const res = await api(serverA, '/api/auth/register', { method: 'POST', body: { email, password: PASSWORD, displayName, gender: 'male', visitorId: randomUUID() } })
    if (res.status !== 200 || !res.json.ok) throw new Error(`регистрация ${label}: ${res.status} ${JSON.stringify(res.json)}`)
    const user = { profileId: res.json.session.profile.profileId, email, displayName, cookie: res.setCookie.split(';')[0] }
    db.prepare(`INSERT INTO profile_wallets (profile_id, yellow_coins_balance) VALUES (?, 50000) ON CONFLICT(profile_id) DO UPDATE SET yellow_coins_balance = excluded.yellow_coins_balance;`).run(user.profileId)
    return user
  }

  async function login(server: RunningServer, user: User): Promise<{ status: number; json: any; cookie: string }> {
    db.prepare(`DELETE FROM registration_rate_limit_events WHERE scope LIKE 'login-%';`).run()
    const res = await api(server, '/api/auth/login', { method: 'POST', body: { email: user.email, password: PASSWORD } })
    return { status: res.status, json: res.json, cookie: res.setCookie.split(';')[0] }
  }

  type Socket = { ws: WebSocket; messages: any[]; closed: Promise<void> }
  async function openSocket(server: RunningServer, cookie: string): Promise<Socket> {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { headers: { Cookie: cookie } })
    sockets.push(ws)
    const messages: any[] = []
    ws.on('message', (data) => { try { messages.push(JSON.parse(String(data))) } catch { /* ignore */ } })
    const closed = new Promise<void>((r) => ws.once('close', () => r()))
    await new Promise<void>((r, j) => { ws.once('open', () => r()); ws.once('error', j) })
    await waitFor(() => messages.some((m) => m.type === 'connected'), 'connected')
    return { ws, messages, closed }
  }

  async function waitFor(predicate: () => boolean, label: string, timeoutMs = 8000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (predicate()) return
      await new Promise((r) => setTimeout(r, 50))
    }
    throw new Error(`Timeout: ${label}`)
  }

  async function sendAndWait(socket: Socket, message: Record<string, unknown>, type: string, label: string): Promise<any> {
    socket.messages.length = 0
    socket.ws.send(JSON.stringify(message))
    await waitFor(() => socket.messages.some((m) => m.type === type || m.type === 'error' || m.type === 'cross_game_commitment_blocked'), label)
    const frame = socket.messages.find((m) => m.type === type)
    if (frame === undefined) throw new Error(`${label}: ${JSON.stringify(socket.messages.slice(-3))}`)
    return frame
  }

  async function submitVia(server: RunningServer, user: User): Promise<{ status: number; json: any }> {
    db.prepare(`DELETE FROM registration_rate_limit_events WHERE scope LIKE 'profile-deletion-submit-%';`).run()
    return await api(server, '/api/account/deletion-request', { method: 'POST', cookie: user.cookie, body: { password: PASSWORD, confirm: true } })
  }

  type RequestRow = { request_id: string; status: string }
  type CancellationRow = { cancellation_id: string; source: string; ledger_recorded_at: string | null; finalized_at: string | null }
  const latestRequest = (profileId: string) => db.prepare('SELECT request_id, status FROM profile_deletion_requests WHERE profile_id = ? ORDER BY requested_at DESC, rowid DESC LIMIT 1;').get(profileId) as RequestRow | undefined
  const cancellationFor = (requestId: string) => db.prepare('SELECT cancellation_id, source, ledger_recorded_at, finalized_at FROM profile_deletion_cancellations WHERE request_id = ?;').get(requestId) as CancellationRow | undefined
  const ledgerKinds = (requestId: string) => readProfileDeletionLedger(ledgerPath).records
    .filter((record: any) => record.requestId === requestId)
    .map((record: any) => record.kind ?? 'intent')
  const activeSessions = (profileId: string) => (db.prepare(`SELECT COUNT(*) AS c FROM account_sessions WHERE profile_id = ? AND revoked_at IS NULL;`).get(profileId) as { c: number }).c

  const observer = await register('Observer')
  const observerB = await openSocket(serverB, observer.cookie)
  async function privateRoomInB(profileId: string): Promise<any | null> {
    const list = await sendAndWait(observerB, { type: 'request_private_rooms_list' }, 'private_rooms_list', 'private_rooms_list')
    return list.rooms.find((r: any) => r.slots.some((s: any) => s.occupant?.profileId === profileId)) ?? null
  }
  async function ludoRoomInB(profileId: string): Promise<any | null> {
    const list = await sendAndWait(observerB, { type: 'request_ludo_rooms_list' }, 'ludo_rooms_list', 'ludo_rooms_list')
    return list.rooms.find((r: any) => r.players.some((p: any) => p.profileId === profileId)) ?? null
  }
  const profileVisibleVia = async (server: RunningServer, profileId: string) => (await api(server, `/api/profiles/${profileId}`, { cookie: observer.cookie })).status === 200

  // ═══ [X1] Чакаща маса в Белот в процес B ══════════════════════════════
  console.log('\n[X1] Чакаща маса в Белот, държана от процес B; заявка през процес A')

  const u1 = await register('Table')
  const friend = await register('Friend')
  {
    const [lower, higher] = [u1.profileId, friend.profileId].sort()
    db.prepare(`INSERT INTO profile_friendships (friendship_id, requester_profile_id, addressee_profile_id, lower_profile_id, higher_profile_id, status, responded_at) VALUES (?, ?, ?, ?, ?, 'accepted', CURRENT_TIMESTAMP);`)
      .run(randomUUID(), u1.profileId, friend.profileId, lower, higher)
  }
  const friendA = await openSocket(serverA, friend.cookie)
  const u1SocketB = await openSocket(serverB, u1.cookie)
  const u1Room = await sendAndWait(u1SocketB, { type: 'create_private_room', stake: STAKE, isLocked: false, waitMinutes: 15 }, 'private_room_updated', 'create_private_room в B')
  let x1RequestId = ''

  await check('[X1a] A не вижда масата в паметта на B: приема заявката (200) и отнема сесиите ПРЕДИ B да е реагирал', async () => {
    const res = await submitVia(serverA, u1)
    assert(res.status === 200 && res.json.ok === true, `${res.status} ${JSON.stringify(res.json)}`)
    x1RequestId = latestRequest(u1.profileId)!.request_id
    assert(activeSessions(u1.profileId) === 0, 'активни сесии след приемането')
  })

  await check('[X1b] B отменя през durable протокола: системен ред + request_cancelled в регистъра; без offsite ack заявката остава pending (не е окончателно)', async () => {
    await waitFor(() => cancellationFor(x1RequestId)?.ledger_recorded_at != null, 'системна отмяна в регистъра', 10_000)
    const row = cancellationFor(x1RequestId)!
    assert(row.source === 'system', `source=${row.source}`)
    assert(row.finalized_at === null, 'финализирана без offsite ack')
    assert(latestRequest(u1.profileId)!.status === 'pending', `статус ${latestRequest(u1.profileId)!.status}`)
    const kinds = ledgerKinds(x1RequestId)
    assert(kinds.includes('request_cancelled') && !kinds.includes('intent') && !kinds.includes('request_deletion_decided'), `регистър: ${kinds.join(',')}`)
    assert(serverB.output().includes(`mode=auto_cancel_accepted_active_participation requestId=${x1RequestId}`), 'лог в B')
  })

  await check('[X1c] Докато отмяната чака offsite: профилът е скрит; вход -> cancellationPending без токен и без сесия; старата сесия е отказана и в двата процеса', async () => {
    assert(!(await profileVisibleVia(serverA, u1.profileId)), 'видим през A')
    const pending = await login(serverA, u1)
    assert(pending.status === 403 && pending.json.code === 'PROFILE_PENDING_DELETION' && pending.json.cancellationPending === true && pending.json.restoreToken === undefined, `${pending.status} ${JSON.stringify(pending.json)}`)
    assert(pending.cookie === '' || !pending.cookie.includes('='), 'издадена сесия')
    for (const server of [serverA, serverB]) {
      assert((await api(server, '/api/friends', { cookie: u1.cookie })).status === 401, `стара сесия приета от ${server.label}`)
    }
  })

  await check('[X1d] Мястото на масата в B остава непокътнато; WS връзката в B не е затворена от отмяната', async () => {
    const room = await privateRoomInB(u1.profileId)
    assert(room?.id === u1Room.room.id, 'мястото е изгубено')
    assert(u1SocketB.ws.readyState === WebSocket.OPEN, `WS readyState=${u1SocketB.ws.readyState}`)
    assert(!u1SocketB.messages.some((m) => m.type === 'session_deletion_requested'), 'session_deletion_requested в B')
  })

  await check('[X1e] След offsite ack: отмяната е окончателна (cancelled), профилът е видим, приятелят в A получава скриване и възстановяване', async () => {
    writeTestLedgerAck(ledgerPath)
    await waitFor(() => cancellationFor(x1RequestId)?.finalized_at != null && latestRequest(u1.profileId)?.status === 'cancelled', 'финализиране', 10_000)
    assert(await profileVisibleVia(serverA, u1.profileId), 'скрит през A')
    assert(await profileVisibleVia(serverB, u1.profileId), 'скрит през B')
    await waitFor(() => friendA.messages.some((m) => m.type === 'profile_visibility_changed' && m.profileId === u1.profileId && m.hidden === true), 'hidden към приятеля')
    await waitFor(() => friendA.messages.some((m) => m.type === 'profile_visibility_changed' && m.profileId === u1.profileId && m.hidden === false), 'visible към приятеля')
    const kinds = ledgerKinds(x1RequestId)
    assert(kinds.filter((k: string) => k === 'request_cancelled').length === 1, `регистър: ${kinds.join(',')}`)
  })

  await check('[X1f] Нормален вход; нова връзка към B поема мястото; напускане -> нова заявка е приета и НЕ се отменя', async () => {
    const fresh = await login(serverA, u1)
    assert(fresh.status === 200 && fresh.json.ok === true, `${fresh.status} ${JSON.stringify(fresh.json)}`)
    u1.cookie = fresh.cookie
    const socket = await openSocket(serverB, u1.cookie)
    await sendAndWait(socket, { type: 'request_private_rooms_list' }, 'private_rooms_list', 'reconnect')
    await sendAndWait(socket, { type: 'leave_private_room' }, 'private_room_left', 'leave')
    assert((await privateRoomInB(u1.profileId)) === null, 'още на масата')
    const res = await submitVia(serverA, u1)
    assert(res.status === 200, `${res.status} ${JSON.stringify(res.json)}`)
    const requestId = latestRequest(u1.profileId)!.request_id
    await new Promise((r) => setTimeout(r, 2500)) // > 2 poll цикъла в B
    assert(cancellationFor(requestId) === undefined && latestRequest(u1.profileId)!.status === 'pending', 'неоснователна отмяна')
  })

  // ═══ [X2] Чакаща маса в „Не се сърди човече“ в процес B ════════════════
  console.log('\n[X2] Чакаща маса в „Не се сърди човече“, държана от процес B')

  await check('[X2] Отмяна през протокола, окончателна след ack; мястото остава', async () => {
    const user = await register('Ludo')
    const socket = await openSocket(serverB, user.cookie)
    const room = await sendAndWait(socket, { type: 'create_ludo_room', stake: STAKE, playerCount: 4, manualStart: true }, 'ludo_room_updated', 'create_ludo_room в B')
    assert((await submitVia(serverA, user)).status === 200, 'приемане в A')
    const requestId = latestRequest(user.profileId)!.request_id
    await waitFor(() => cancellationFor(requestId)?.ledger_recorded_at != null, 'системна отмяна', 10_000)
    assert(cancellationFor(requestId)!.source === 'system', 'source')
    writeTestLedgerAck(ledgerPath)
    await waitFor(() => latestRequest(user.profileId)?.status === 'cancelled', 'cancelled', 10_000)
    assert((await ludoRoomInB(user.profileId))?.id === room.room.id, 'мястото е изгубено')
  })

  // ═══ [X3] Активна игра на Белот в процес B ════════════════════════════
  console.log('\n[X3] Активна игра на Белот в процес B')

  await check('[X3] Персистираният snapshot отказва още в транзакцията на A (409 ACTIVE_GAME), без заявка и без отнети сесии', async () => {
    const user = await register('Game')
    const socket = await openSocket(serverB, user.cookie)
    await sendAndWait(socket, { type: 'create_room', displayName: user.displayName }, 'room_created', 'create_room в B')
    await waitFor(() => (db.prepare(`SELECT COUNT(*) AS c FROM active_room_snapshots WHERE is_active = 1 AND instr(snapshot_json, ?) > 0;`).get(user.profileId) as { c: number }).c > 0, 'snapshot', 10_000)
    const res = await submitVia(serverA, user)
    assert(res.status === 409 && res.json.code === 'ACTIVE_GAME', `${res.status} ${JSON.stringify(res.json)}`)
    assert(latestRequest(user.profileId) === undefined, 'създадена заявка')
    assert(activeSessions(user.profileId) > 0, 'сесиите са отнети')
    assert(socket.ws.readyState === WebSocket.OPEN, 'WS в B е затворен')
  })

  // ═══ [X4] Рестарт по време на състезанието ════════════════════════════
  console.log('\n[X4] Рестарт на процес по време на състезанието')

  await check('[X4a] B умира (SIGKILL) с масата в паметта преди poll-а: масата изчезва с процеса; заявката остава валидно приета; няма отмяна след рестарта', async () => {
    const user = await register('Crash')
    const socket = await openSocket(serverB, user.cookie)
    await sendAndWait(socket, { type: 'create_private_room', stake: STAKE, isLocked: false, waitMinutes: 15 }, 'private_room_updated', 'create в B')
    await killServer(serverB, 'SIGKILL')
    const res = await submitVia(serverA, user)
    assert(res.status === 200, `${res.status} ${JSON.stringify(res.json)}`)
    const requestId = latestRequest(user.profileId)!.request_id
    serverB = startServer('B', serverB.port)
    servers.push(serverB)
    await waitForHealth(serverB)
    await new Promise((r) => setTimeout(r, 2500))
    assert(cancellationFor(requestId) === undefined && latestRequest(user.profileId)!.status === 'pending', 'неочаквана отмяна след рестарта')
    const observerSocket = await openSocket(serverB, observer.cookie)
    const list = await sendAndWait(observerSocket, { type: 'request_private_rooms_list' }, 'private_rooms_list', 'list след рестарта')
    assert(!list.rooms.some((r: any) => r.slots.some((s: any) => s.occupant?.profileId === user.profileId)), 'масата е възкръснала')
    assert(activeSessions(user.profileId) === 0, 'активни сесии')
    observerB.ws = observerSocket.ws
    observerB.messages = observerSocket.messages
  })

  await check('[X4b] B умира след приемането на отмяната (записана в регистъра, без offsite): A я финализира след ack — отмяната не се губи', async () => {
    const user = await register('CrashCancel')
    const socket = await openSocket(serverB, user.cookie)
    await sendAndWait(socket, { type: 'create_private_room', stake: STAKE, isLocked: false, waitMinutes: 15 }, 'private_room_updated', 'create в B')
    assert((await submitVia(serverA, user)).status === 200, 'приемане в A')
    const requestId = latestRequest(user.profileId)!.request_id
    await waitFor(() => cancellationFor(requestId)?.ledger_recorded_at != null, 'системна отмяна', 10_000)
    await killServer(serverB, 'SIGKILL')
    assert(latestRequest(user.profileId)!.status === 'pending' && cancellationFor(requestId)!.finalized_at === null, 'финализирана без ack')
    writeTestLedgerAck(ledgerPath)
    await waitFor(() => latestRequest(user.profileId)?.status === 'cancelled', 'финализиране от A', 10_000)
    assert(ledgerKinds(requestId).includes('request_cancelled'), 'липсва в регистъра')
    serverB = startServer('B', serverB.port)
    servers.push(serverB)
    await waitForHealth(serverB)
  })

  await check('[X4c] A умира (SIGKILL) веднага след отговора: B пак отменя от общата база; окончателно след ack', async () => {
    const user = await register('CrashA')
    const socket = await openSocket(serverB, user.cookie)
    await sendAndWait(socket, { type: 'create_private_room', stake: STAKE, isLocked: false, waitMinutes: 15 }, 'private_room_updated', 'create в B')
    assert((await submitVia(serverA, user)).status === 200, 'приемане в A')
    await killServer(serverA, 'SIGKILL')
    const requestId = latestRequest(user.profileId)!.request_id
    await waitFor(() => cancellationFor(requestId)?.ledger_recorded_at != null, 'системна отмяна в B', 10_000)
    writeTestLedgerAck(ledgerPath)
    await waitFor(() => latestRequest(user.profileId)?.status === 'cancelled', 'финализиране от B', 10_000)
    serverA = startServer('A', serverA.port)
    servers.push(serverA)
    await waitForHealth(serverA)
  })

  await check('[X5] Паролата не присъства в изхода на нито един процес', () => {
    for (const server of servers) assert(!server.output().includes(PASSWORD), `парола в лога на ${server.label}`)
  })
} catch (error) {
  failed += 1
  console.error(`  FAIL  (неочаквана грешка): ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  for (const server of servers) console.error(`--- ${server.label} ---\n${server.output().slice(-2500)}`)
} finally {
  for (const ws of sockets) { try { ws.close() } catch { /* ignore */ } }
  for (const server of servers) await killServer(server, 'SIGTERM')
  db.close()
  await rm(isolatedRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
