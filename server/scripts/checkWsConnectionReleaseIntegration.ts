/**
 * checkWsConnectionReleaseIntegration.ts
 *
 * Интеграционен тест (реален spawned сървър в изолирана временна директория,
 * временна база, реални `ws` клиенти) за освобождаването на затворени
 * WebSocket връзки от serverState.connections и за GET /api/friends.
 *
 * Production дефект: всяка WS връзка оставаше завинаги в
 * serverState.connections; GET /api/friends обхождаше всички записи за
 * всеки приятел (O(F × C)), а всяко входящо WS съобщение (heartbeat)
 * копираше целия обект. На 04.11 GET.friends е стигал 3,3 s.
 *
 * Проверява:
 *  [1] Офлайн приятел -> isOnline:false.
 *  [2] Приятелят отваря WS -> isOnline:true, isInGame:false.
 *  [3] Приятелят затваря WS -> isOnline:false.
 *  [4] Displacement: втора връзка на същия профил -> старата получава
 *      session_displaced и се затваря; след закъснелия ѝ close профилът е
 *      онлайн през новата.
 *  [5] Уведомление (friend_request_received) стига до новата връзка, не до
 *      старата.
 *  [6] Рязко прекъсната стара връзка (terminate) докато се отваря нова ->
 *      профилът остава онлайн, новата връзка получава уведомления и pong.
 *  [7] N последователни guest connect/close цикъла (по подразбиране 10 000,
 *      --cycles=N) -> GET /api/friends и WS ping round-trip не се влошават.
 *  [8] След цикъла профилите в /api/friends са с правилен онлайн статус.
 *  [9] Белот (частна маса + ботове): играчът е isInGame:true.
 *  [10] Рязко прекъсване по време на игра -> нова връзка + resume_room
 *       (reconnectToken) връща същото място; после трета връзка поема
 *       мястото и ЗАКЪСНЕЛИЯТ close на втората не засяга новата
 *       (isOnline/isInGame и мястото остават).
 *
 * [1]-[6] и [8]-[10] минават еднакво и без поправката (външното поведение
 * е непроменено); [7] разграничава старото от новото поведение.
 *
 * Пускане: tsx scripts/checkWsConnectionReleaseIntegration.ts --server-root=. [--cycles=10000]
 * Benchmark-ът (медиани преди/след) се печата винаги — пускането срещу
 * сървър БЕЗ поправката показва старото поведение ([7] пада там очаквано).
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import WebSocket from 'ws'
import { TEST_REGISTRATION_SECRET, configureDirectRegistrationForTest, prepareDirectRegistration } from './fixtures/directRegistrationTestEnv.js'

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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

async function waitFor(label: string, predicate: () => Promise<boolean> | boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await sleep(50)
  }
  throw new Error(`Timeout: ${label}`)
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

async function findFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (addr === null || typeof addr === 'string') { reject(new Error('no port')); return }
      srv.close(() => resolvePort(addr.port))
    })
  })
}

const args = process.argv.slice(2)
const sourceServerRoot = resolve(args.find((a) => a.startsWith('--server-root='))?.slice('--server-root='.length) ?? process.cwd())
const cycles = Number(args.find((a) => a.startsWith('--cycles='))?.slice('--cycles='.length) ?? 10_000)
const FRIEND_COUNT = 40

async function createIsolatedServerRoot(originalServerRoot: string) {
  const root = await mkdtemp(join(tmpdir(), 'belot-ws-release-'))
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
    cleanup: async () => {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        try { await rm(root, { recursive: true, force: true }); return } catch { await sleep(250) }
      }
    },
  }
}

type RunningServer = { child: ChildProcessWithoutNullStreams; output(): string }

function startServer(serverDir: string, port: number): RunningServer {
  const chunks: string[] = []
  const child = spawn(
    process.execPath,
    [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'index.ts')],
    { cwd: serverDir, env: { ...process.env, PORT: String(port), PASSWORD_RESET_RATE_LIMIT_SECRET: TEST_REGISTRATION_SECRET }, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  // Пазим само опашката — 10 000 '[ws] client connected' реда не трябва да
  // пълнят паметта на теста.
  const keep = (chunk: string) => { chunks.push(chunk); if (chunks.length > 400) chunks.splice(0, chunks.length - 400) }
  child.stdout.on('data', keep)
  child.stderr.on('data', keep)
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

async function httpJson(port: number, method: string, pathname: string, cookie: string | null, body?: unknown) {
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

type Profile = { cookie: string; profileId: string }

async function register(port: number, tag: string): Promise<Profile> {
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const reg = await httpJson(port, 'POST', '/api/auth/register', null, {
    email: `ws-release-${tag}-${runId}@example.test`,
    password: 'WsReleaseDiag1!',
    displayName: `WSR ${tag}`.slice(0, 20),
    gender: 'male',
    ...prepareDirectRegistration(),
  })
  if (reg.status !== 200) throw new Error(`Registration failed for ${tag}: ${JSON.stringify(reg.body)}`)
  return { cookie: reg.setCookie as string, profileId: reg.body.session.profile.profileId }
}

async function befriend(port: number, requester: Profile, addressee: Profile): Promise<void> {
  const sent = await httpJson(port, 'POST', '/api/friends/request', requester.cookie, { profileId: addressee.profileId })
  if (sent.status !== 200 || sent.body?.ok !== true) throw new Error(`friend request failed: ${JSON.stringify(sent.body)}`)
  // Отговорът носи само friendships — friendshipId е в outgoingPending.
  const outgoing = (sent.body.friendships?.outgoingPending as any[] | undefined) ?? []
  const friendshipId = outgoing.find((r) => r.profile.profileId === addressee.profileId)?.friendshipId
  if (typeof friendshipId !== 'string') throw new Error('friendshipId липсва в outgoingPending')
  const accepted = await httpJson(port, 'POST', `/api/friends/${friendshipId}/accept`, addressee.cookie, {})
  if (accepted.status !== 200 || accepted.body?.ok !== true) throw new Error(`friend accept failed: ${JSON.stringify(accepted.body)}`)
}

type Client = {
  ws: WebSocket
  frames: any[]
  closed: Promise<void>
  // Event-based изчакване (без polling), за да е точно измерването на RTT.
  nextFrame(predicate: (frame: any) => boolean, timeoutMs?: number): Promise<any>
}

async function openWs(port: number, cookie: string | null): Promise<Client> {
  const ws = new WebSocket(`ws://localhost:${port}/ws`, cookie ? { headers: { Cookie: cookie } } : {})
  const frames: any[] = []
  const waiters = new Set<{ predicate: (frame: any) => boolean; resolve: (frame: any) => void }>()
  ws.on('message', (data) => {
    let frame: any
    try { frame = JSON.parse(data.toString()) } catch { return }
    frames.push(frame)
    for (const waiter of [...waiters]) {
      if (waiter.predicate(frame)) { waiters.delete(waiter); waiter.resolve(frame) }
    }
  })
  const nextFrame = (predicate: (frame: any) => boolean, timeoutMs = 10_000) =>
    new Promise<any>((resolveFrame, reject) => {
      const waiter = {
        predicate,
        resolve: (frame: any) => { clearTimeout(timer); resolveFrame(frame) },
      }
      const timer = setTimeout(() => { waiters.delete(waiter); reject(new Error('Timeout waiting for frame')) }, timeoutMs)
      waiters.add(waiter)
    })
  const closed = new Promise<void>((r) => ws.once('close', () => r()))
  const connected = nextFrame((f) => f.type === 'connected')
  await new Promise<void>((resolveOpen, reject) => { ws.once('open', () => resolveOpen()); ws.once('error', reject) })
  await connected
  return { ws, frames, closed, nextFrame }
}

async function friendStatus(port: number, viewer: Profile, friendProfileId: string) {
  const res = await httpJson(port, 'GET', '/api/friends', viewer.cookie)
  if (res.status !== 200 || res.body?.ok !== true) throw new Error(`GET /api/friends failed: ${res.status}`)
  const entry = (res.body.friendships.friends as any[]).find((f) => f.profile.profileId === friendProfileId)
  if (!entry) throw new Error(`friend ${friendProfileId} missing from /api/friends`)
  return { isOnline: entry.isOnline as boolean, isInGame: entry.isInGame as boolean }
}

async function measureFriends(port: number, viewer: Profile, samples = 15): Promise<number> {
  const timings: number[] = []
  for (let i = 0; i < samples; i += 1) {
    const startedAt = performance.now()
    const res = await httpJson(port, 'GET', '/api/friends', viewer.cookie)
    timings.push(performance.now() - startedAt)
    if (res.status !== 200) throw new Error('GET /api/friends failed')
  }
  return median(timings)
}

async function measurePing(client: Client, samples = 100): Promise<number> {
  const timings: number[] = []
  for (let i = 0; i < samples; i += 1) {
    const pong = client.nextFrame((f) => f.type === 'pong')
    const startedAt = performance.now()
    client.ws.send(JSON.stringify({ type: 'ping' }))
    await pong
    timings.push(performance.now() - startedAt)
  }
  return median(timings)
}

console.log(`\ncheckWsConnectionReleaseIntegration (cycles=${cycles}, server-root=${sourceServerRoot})\n`)

let server: RunningServer | null = null
const isolated = await createIsolatedServerRoot(sourceServerRoot)

try {
  const port = await findFreePort()
  server = startServer(isolated.serverDir, port)
  try {
    await waitFor('backend health', async () => {
      try {
        const r = await fetch(`http://localhost:${port}/health`)
        const h = await r.json()
        return r.status === 200 && h.ok === true && h.gameWorkerLifecycle?.state === 'ready'
      } catch { return false }
    }, 60_000)
  } catch (error) {
    console.error(server.output())
    throw error
  }
  configureDirectRegistrationForTest(join(isolated.serverDir, 'database', 'data', 'belot-v2.sqlite'))

  const viewer = await register(port, 'viewer')
  const friend = await register(port, 'friend')
  const requester = await register(port, 'requester')
  await befriend(port, viewer, friend)
  for (let i = 0; i < FRIEND_COUNT; i += 1) {
    const extra = await register(port, `f${i}`)
    await befriend(port, viewer, extra)
  }
  const viewerWs = await openWs(port, viewer.cookie)

  await check('[1] Офлайн приятел -> isOnline:false', async () => {
    const status = await friendStatus(port, viewer, friend.profileId)
    assert(status.isOnline === false && status.isInGame === false, `очаквах offline, получих ${JSON.stringify(status)}`)
  })

  let friendWs = await openWs(port, friend.cookie)
  await check('[2] Приятелят отваря WS -> isOnline:true, isInGame:false', async () => {
    const status = await friendStatus(port, viewer, friend.profileId)
    assert(status.isOnline === true && status.isInGame === false, `очаквах online, получих ${JSON.stringify(status)}`)
  })

  friendWs.ws.close()
  await friendWs.closed
  await check('[3] Приятелят затваря WS -> isOnline:false', async () => {
    await waitFor('friend offline', async () => (await friendStatus(port, viewer, friend.profileId)).isOnline === false)
  })

  const oldWs = await openWs(port, friend.cookie)
  const newWs = await openWs(port, friend.cookie)
  await check('[4] Displacement: старата връзка получава session_displaced и се затваря; профилът остава онлайн', async () => {
    await waitFor('old displaced', () => oldWs.frames.some((f) => f.type === 'session_displaced'))
    await oldWs.closed
    await sleep(200) // закъснелият close на стария socket се обработва на сървъра
    const status = await friendStatus(port, viewer, friend.profileId)
    assert(status.isOnline === true, 'профилът трябва да е онлайн през новата връзка след close на старата')
    assert(newWs.ws.readyState === WebSocket.OPEN, 'новата връзка трябва да е отворена')
  })

  await check('[5] Уведомление стига до новата връзка, не до старата', async () => {
    const sent = await httpJson(port, 'POST', '/api/friends/request', requester.cookie, { profileId: friend.profileId })
    assert(sent.status === 200 && sent.body?.ok === true, `friend request failed: ${JSON.stringify(sent.body)}`)
    await waitFor('friend_request_received on new', () => newWs.frames.some((f) => f.type === 'friend_request_received'))
    assert(!oldWs.frames.some((f) => f.type === 'friend_request_received'), 'старата връзка получи уведомление')
  })

  await check('[6] Рязко прекъсната стара връзка докато се отваря нова -> профилът онлайн, новата работи', async () => {
    const opening = openWs(port, friend.cookie)
    newWs.ws.terminate()
    friendWs = await opening
    await newWs.closed
    await sleep(300)
    const status = await friendStatus(port, viewer, friend.profileId)
    assert(status.isOnline === true, 'профилът трябва да е онлайн след terminate на старата връзка')
    const rtt = await measurePing(friendWs, 3)
    assert(rtt < 5_000, 'новата връзка не отговаря на ping')
    const friendView = await httpJson(port, 'GET', '/api/friends', friend.cookie)
    const pending = (friendView.body?.friendships?.incomingPending as any[] | undefined) ?? []
    assert(pending.some((p) => p.profile.profileId === requester.profileId), 'входящата покана липсва')
  })

  const friendsBefore = await measureFriends(port, viewer)
  const pingBefore = await measurePing(viewerWs)
  const cyclesStartedAt = performance.now()
  for (let i = 0; i < cycles; i += 1) {
    const guest = await openWs(port, null)
    guest.ws.close()
    await guest.closed
    if ((i + 1) % 2000 === 0) console.log(`        ... ${i + 1}/${cycles} цикъла (${((performance.now() - cyclesStartedAt) / 1000).toFixed(1)} s)`)
  }
  const cyclesSeconds = (performance.now() - cyclesStartedAt) / 1000
  await sleep(500)
  const friendsAfter = await measureFriends(port, viewer)
  const pingAfter = await measurePing(viewerWs)
  console.log(`        BENCHMARK ${cycles} guest connect/close цикъла: ${cyclesSeconds.toFixed(1)} s`)
  console.log(`        GET /api/friends (${FRIEND_COUNT + 1} приятели) медиана: преди=${friendsBefore.toFixed(1)}ms след=${friendsAfter.toFixed(1)}ms`)
  console.log(`        WS ping round-trip медиана: преди=${pingBefore.toFixed(2)}ms след=${pingAfter.toFixed(2)}ms`)

  await check(`[7] ${cycles} connect/close цикъла не влошават GET /api/friends и WS round-trip`, () => {
    assert(friendsAfter < Math.max(friendsBefore * 3, friendsBefore + 25), `GET /api/friends се влоши: ${friendsBefore.toFixed(1)} -> ${friendsAfter.toFixed(1)} ms`)
    assert(pingAfter < Math.max(pingBefore * 3, pingBefore + 5), `WS round-trip се влоши: ${pingBefore.toFixed(2)} -> ${pingAfter.toFixed(2)} ms`)
  })

  await check('[8] След цикъла онлайн статусът е правилен', async () => {
    const online = await friendStatus(port, viewer, friend.profileId)
    assert(online.isOnline === true, 'приятелят с отворена връзка трябва да е онлайн')
    friendWs.ws.close()
    await friendWs.closed
    await waitFor('friend offline after cycles', async () => (await friendStatus(port, viewer, friend.profileId)).isOnline === false)
  })

  // ─── Белот: reconnect по време на игра и закъснял close ─────────────────
  // Частна маса: host (отбор A) + player (отбор B) + по един бот на отбор ->
  // играта стартира веднага (без matchmaking bot-fill прозореца).
  const host = await register(port, 'host')
  const player = await register(port, 'player')
  await befriend(port, host, player)
  const hostWs = await openWs(port, host.cookie)
  const playerWsA = await openWs(port, player.cookie)
  const send = (client: Client, message: Record<string, unknown>) => client.ws.send(JSON.stringify(message))
  const occupied = (room: any) => (room?.slots ?? room?.seats ?? []).filter((s: any) => s && (s.profileId || s.kind || s.occupant)).length

  const createdFrame = hostWs.nextFrame((f) => f.type === 'private_room_updated')
  send(hostWs, { type: 'create_private_room', stake: 5000, isLocked: false })
  const created = await createdFrame
  const privateRoomId: string = created.room.id
  send(playerWsA, { type: 'join_private_room', privateRoomId, team: 'B', slotIndex: 0 })
  await waitFor('player joined', () => hostWs.frames.some((f) => f.type === 'private_room_updated' && occupied(f.room) >= 2) || playerWsA.frames.some((f) => f.type === 'private_room_updated'))
  const hostFull = hostWs.nextFrame((f) => f.type === 'private_room_full', 15_000)
  const playerSnapshotA = playerWsA.nextFrame((f) => f.type === 'room_snapshot', 15_000)
  send(hostWs, { type: 'add_bot_to_private_room_team', team: 'A' })
  await sleep(300)
  send(playerWsA, { type: 'add_bot_to_private_room_team', team: 'B' })
  const roomId: string = (await hostFull).roomId
  const firstSnapshot = await playerSnapshotA
  const playerSeat: string = firstSnapshot.yourSeat
  const reconnectToken: string = firstSnapshot.reconnectToken

  await check('[9] Играта стартира; играчът е isInGame:true в /api/friends', async () => {
    assert(typeof roomId === 'string' && typeof playerSeat === 'string' && typeof reconnectToken === 'string', 'липсва roomId/seat/reconnectToken')
    const status = await friendStatus(port, host, player.profileId)
    assert(status.isOnline === true && status.isInGame === true, `очаквах online+inGame, получих ${JSON.stringify(status)}`)
  })

  await check('[10] Рязко прекъсване по време на игра -> нова връзка + resume_room връща същото място', async () => {
    playerWsA.ws.terminate()
    await playerWsA.closed
    await sleep(300)
    const playerWsB = await openWs(port, player.cookie)
    const resumed = playerWsB.nextFrame((f) => f.type === 'room_resumed' && f.roomId === roomId)
    const snapshot = playerWsB.nextFrame((f) => f.type === 'room_snapshot' && f.roomId === roomId)
    send(playerWsB, { type: 'resume_room', roomId, reconnectToken })
    await resumed
    const resumedSnapshot = await snapshot
    assert(resumedSnapshot.yourSeat === playerSeat, `очаквах място ${playerSeat}, получих ${resumedSnapshot.yourSeat}`)
    const status = await friendStatus(port, host, player.profileId)
    assert(status.isOnline === true && status.isInGame === true, `след resume очаквах online+inGame, получих ${JSON.stringify(status)}`)

    // [11] Закъснял close: нова връзка C поема мястото, ПОСЛЕ старата B се затваря.
    const playerWsC = await openWs(port, player.cookie)
    const resumedC = playerWsC.nextFrame((f) => f.type === 'room_resumed' && f.roomId === roomId)
    send(playerWsC, { type: 'resume_room', roomId, reconnectToken })
    await resumedC
    playerWsB.ws.terminate()
    await playerWsB.closed
    await sleep(300)
    const afterLateClose = await friendStatus(port, host, player.profileId)
    assert(afterLateClose.isOnline === true && afterLateClose.isInGame === true, `закъснелият close на старата връзка засегна новата: ${JSON.stringify(afterLateClose)}`)
    const snapshotC = playerWsC.nextFrame((f) => f.type === 'room_snapshot' && f.roomId === roomId)
    send(playerWsC, { type: 'resume_room', roomId, reconnectToken })
    const latest = await snapshotC
    assert(latest.yourSeat === playerSeat, 'новата връзка изгуби мястото след закъснелия close')
    playerWsC.ws.close()
  })

  hostWs.ws.close()
  viewerWs.ws.close()
  oldWs.ws.close()
} finally {
  await stopServer(server)
  await isolated.cleanup()
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
