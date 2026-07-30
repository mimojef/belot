/**
 * checkPrivateRoomReconnectRaceGuard.ts
 *
 * Regression test за production bug: играч, чиято WebSocket връзка се
 * прекъсва (кратко мобилно прекъсване, screen lock, Wi-Fi/4G смяна) докато
 * чака в частна маса, оставаше безкрайно на екрана "4/4", защото:
 *
 *  1. server/src/game/privateRoomsStore.ts пази членство по connectionId, не
 *     по profileId — старият (мъртъв) connectionId остава в room.members до
 *     явно reconnectMember() извикване (тригернато само от
 *     request_private_rooms_list).
 *  2. handlePrivateRoomFull (server/src/index.ts) взимаше member.connectionId
 *     директно и го подаваше на attachConnectionToRoomSeat, който безусловно
 *     пише status:'connected' само защото connection обектът все още
 *     съществува (макар и status:'disconnected') — мъртва връзка се
 *     "съживяваше" логически, без реален OPEN WebSocket зад нея.
 *
 * Тестваната поправка е двуслойна:
 *  A. Server-side liveness guard: resolveLiveConnectionForMember() в
 *     server/src/index.ts, викана от handlePrivateRoomFull ПРЕДИ да подаде
 *     connectionId на createHumanParticipant/attachConnectionToRoomSeat.
 *     Ако member.connectionId вече не е 'connected'+OPEN, търси друга
 *     'connected'+OPEN връзка със същия profileId (новата reconnect-нала
 *     връзка) и я ползва вместо мъртвия connectionId. Ако няма жива връзка
 *     изобщо, участникът остава isConnected:false (нормален bot-takeover
 *     path), НЕ се "съживява" изкуствено.
 *  B. Client-side auto-resync: main.ts WS onOpen сега вика
 *     lobby.resyncPrivateRoomMembershipIfWaiting(), огледално на
 *     forceLobbyChatResubscribeIfOnLobbyScreen(), за да не се налага
 *     потребителят ръчно да отваря "Частни маси" или да прави reload след
 *     reconnect.
 *
 * Тестова стратегия: този файл пуска реален spawned сървър и реални `ws`
 * клиенти (Node) и разчита ИЗЦЯЛО на (A) — сървърът намира новата жива
 * връзка сам, по profileId, без тестът да компенсира липсваща клиентска
 * стъпка. Race-ът се произвежда с истинско запълване на масата от 4-ти
 * реален human join (не bot-fill), докато засегнатата връзка вече е
 * reconnect-нала, но НИКОГА не е пращала request_private_rooms_list —
 * точно най-лошият момент от production бъга.
 *
 * (B) не може да се изпълни от server-only WS клиент (браузърният WS onOpen
 * не съществува тук) — покрит е отделно от checkPrivateRoomReconnectClientResync.ts
 * със source-level проверки върху main.ts / createLobbyFlowController.ts.
 *
 * Покрива (виж task spec):
 *  [1] create + 2 join (3/4), 4-ти член disconnect-ва (WS close, без
 *      leave_private_room) докато е в чакалнята.
 *  [2] същият профил отваря НОВА WebSocket връзка (нов connectionId) — без
 *      да праща request_private_rooms_list.
 *  [3] 4-ти реален human се присъединява естествено → масата естествено
 *      става 4/4 → handlePrivateRoomFull се задейства с мъртъв
 *      connectionId за реконектналия член.
 *  [4] новата жива връзка на реконектналия играч получава private_room_full
 *      + room_snapshot (не остава закачена, не гърми not_member).
 *  [5] чат от новата (жива) връзка на стария privateRoomId връща not_member
 *      (стаята вече е стартирана — нормално поведение), НЕ заради грешно
 *      членство.
 *  [6] мъртвият стар socket не се брои за "connected" (admin stats /
 *      resolveLiveConnectionForMember проверка косвено чрез самия старт).
 *  [7] точно 4 уникално заети места, точно 1 стартирана стая (без дублиране).
 *  [8] другите 3 играчи получават нормален старт (room_snapshot).
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import WebSocket from 'ws'

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

// ─── Isolated server (same model as checkPrivateRoomWebSocketRoundTrip.ts) ─

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
  const root = await mkdtemp(join(tmpdir(), 'belot-private-room-race-'))
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
    { cwd: serverDir, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (c) => chunks.push(c))
  child.stderr.on('data', (c) => chunks.push(c))
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
    email: `private-room-race-${tag}-${runId}@example.test`,
    password: 'PrivateRoomRaceDiag1!',
    displayName: `PRR ${tag}`,
    gender: 'male',
  })
  if (reg.status !== 200) throw new Error(`Registration failed for ${tag}: ${JSON.stringify(reg.body)}`)
  return { cookie: reg.setCookie as string, profileId: reg.body.session.profile.profileId }
}

async function openWs(port: number, cookie: string): Promise<{ ws: WebSocket; frames: any[] }> {
  const ws = new WebSocket(`ws://localhost:${port}/ws`, { headers: { Cookie: cookie } })
  const frames: any[] = []
  ws.on('message', (data) => {
    try { frames.push(JSON.parse(data.toString())) } catch { /* ignore */ }
  })
  await new Promise<void>((resolveOpen, reject) => {
    ws.once('open', () => resolveOpen())
    ws.once('error', reject)
  })
  return { ws, frames }
}

async function connectClient(port: number, tag: string): Promise<TestClient> {
  const { cookie, profileId } = await registerProfile(port, tag)
  const { ws, frames } = await openWs(port, cookie)
  return { profileId, cookie, ws, frames }
}

function send(client: TestClient, message: Record<string, unknown>): void {
  client.ws.send(JSON.stringify(message))
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

console.log('\ncheckPrivateRoomReconnectRaceGuard\n')

let server: RunningServer | null = null
const isolated = await createIsolatedServerRoot(sourceServerRoot)

try {
  const port = await findFreePort()
  if (!(await isPortFree(port))) throw new Error(`Port ${port} in use`)

  server = startServer(isolated.serverDir, port)
  console.log(`Waiting for server on port ${port}...`)
  try {
    await waitForCondition('backend health', async () => {
      try {
        const r = await fetch(`http://localhost:${port}/health`)
        const h = await r.json()
        return r.status === 200 && h.ok === true && h.gameWorkerLifecycle?.state === 'ready'
      } catch { return false }
    }, 30_000)
  } catch (err) {
    console.error('--- server output ---')
    console.error(server.output())
    throw err
  }
  console.log('Server ready.\n')

  // ───────────────────────────────────────────────────────────────────────
  // Setup: host + 2 guests join a private room (3/4). The 4th slot stays
  // open so a real human 4th join naturally triggers handlePrivateRoomFull.
  // ───────────────────────────────────────────────────────────────────────
  const host = await connectClient(port, 'host')
  const guest1 = await connectClient(port, 'guest1')
  let victim = await connectClient(port, 'victim')

  send(host, { type: 'create_private_room', stake: 5000, isLocked: false })
  const created = await waitForFrame(host, (f) => f.type === 'private_room_updated', 10_000, 'create_private_room ack')
  const roomId: string = created.room.id

  send(guest1, { type: 'join_private_room', privateRoomId: roomId })
  await waitForFrame(host, (f) => f.type === 'private_room_updated' && f.room.members.length === 2, 10_000, '2 members')

  send(victim, { type: 'join_private_room', privateRoomId: roomId })
  await waitForFrame(host, (f) => f.type === 'private_room_updated' && f.room.members.length === 3, 10_000, '3 members (victim joined)')
  await waitForFrame(victim, (f) => f.type === 'private_room_updated' && f.room.members.length === 3, 10_000, 'victim sees own join')

  // ───────────────────────────────────────────────────────────────────────
  // [1] Victim's WebSocket dies (mobile blip) — no leave_private_room, just
  // a raw close, exactly like a dropped connection in production.
  // ───────────────────────────────────────────────────────────────────────
  const deadConnectionSocket = victim.ws
  deadConnectionSocket.close()
  await new Promise<void>((r) => deadConnectionSocket.once('close', () => r()))
  await sleep(300)

  // ───────────────────────────────────────────────────────────────────────
  // [2] Victim opens a brand-new WebSocket for the SAME profile (new
  // connectionId on the server) — but crucially never sends
  // request_private_rooms_list. This is the exact gap the client-side fix
  // closes in the browser; here we deliberately do NOT compensate for it,
  // to prove the SERVER-SIDE liveness guard alone is sufficient.
  // ───────────────────────────────────────────────────────────────────────
  const { ws: newWs, frames: newFrames } = await openWs(port, victim.cookie)
  victim = { profileId: victim.profileId, cookie: victim.cookie, ws: newWs, frames: newFrames }

  await check('[1] the victim\'s new (post-reconnect) connection has NOT been told it is a room member yet (no compensating request_private_rooms_list was sent)', () => {
    const memberFrame = victim.frames.find((f) => f.type === 'private_room_updated')
    if (memberFrame !== undefined) throw new Error('test setup invalid: victim already got private_room_updated without asking — race not reproduced')
  })

  // ───────────────────────────────────────────────────────────────────────
  // [3] A 4th REAL human joins, filling the table naturally (not bot-fill).
  // This fires handlePrivateRoomFull with the victim's member.connectionId
  // still pointing at the now-dead original socket.
  // ───────────────────────────────────────────────────────────────────────
  const fourth = await connectClient(port, 'fourth')
  send(fourth, { type: 'join_private_room', privateRoomId: roomId })

  await check('[2] the 4th human join makes the table naturally reach 4/4 and start a single game', async () => {
    const hostFull = await waitForFrame(host, (f) => f.type === 'private_room_full', 15_000, 'host private_room_full')
    const guest1Full = await waitForFrame(guest1, (f) => f.type === 'private_room_full', 15_000, 'guest1 private_room_full')
    const fourthFull = await waitForFrame(fourth, (f) => f.type === 'private_room_full', 15_000, 'fourth private_room_full')
    if (hostFull.roomId !== guest1Full.roomId || hostFull.roomId !== fourthFull.roomId) {
      throw new Error('not all 3 non-victim members landed in the same room')
    }
  })

  const gameRoomId: string = host.frames.find((f) => f.type === 'private_room_full').roomId

  await check('[3] the victim\'s LIVE (post-reconnect) connection receives private_room_full — not left hanging on 4/4 forever', async () => {
    const victimFull = await waitForFrame(victim, (f) => f.type === 'private_room_full', 15_000, 'victim (new connection) private_room_full')
    if (victimFull.roomId !== gameRoomId) throw new Error(`victim landed in a different room: ${victimFull.roomId} vs ${gameRoomId}`)
  })

  await check('[4] the victim\'s live connection also receives the real room_snapshot for the started game', async () => {
    const snapshot = await waitForFrame(victim, (f) => f.type === 'room_snapshot' && f.roomId === gameRoomId, 10_000, 'victim room_snapshot')
    if (snapshot.seats === undefined) throw new Error('victim room_snapshot missing seats')
  })

  await check('[5] exactly 4 uniquely occupied seats, exactly 4 humans, no bots, no duplicate seat/profile binding', async () => {
    const snapshot = await waitForFrame(host, (f) => f.type === 'room_snapshot' && f.roomId === gameRoomId, 10_000, 'host room_snapshot')
    const occupied = (snapshot.seats as any[]).filter((s) => s.isOccupied)
    if (occupied.length !== 4) throw new Error(`occupied seats=${occupied.length}`)
    const uniqueSeats = new Set(occupied.map((s) => s.seat))
    if (uniqueSeats.size !== 4) throw new Error('duplicate seat assignment detected')
    const botCount = occupied.filter((s) => s.isBot).length
    if (botCount !== 0) throw new Error(`expected 0 bots (victim should be seated as a live human, not fall back to a bot), got ${botCount}`)
  })

  await check('[6] the OTHER 3 real participants also received a normal start (room_snapshot) — the fix does not regress the non-race path', () => {
    const hostGotSnapshot = host.frames.some((f) => f.type === 'room_snapshot' && f.roomId === gameRoomId)
    const guest1GotSnapshot = guest1.frames.some((f) => f.type === 'room_snapshot' && f.roomId === gameRoomId)
    const fourthGotSnapshot = fourth.frames.some((f) => f.type === 'room_snapshot' && f.roomId === gameRoomId)
    if (!hostGotSnapshot || !guest1GotSnapshot || !fourthGotSnapshot) {
      throw new Error(`missing snapshot: host=${hostGotSnapshot} guest1=${guest1GotSnapshot} fourth=${fourthGotSnapshot}`)
    }
  })

  // Snapshot the private_room_full counts BEFORE test [7] clears victim.frames
  // for its own chat-rejection assertion below.
  const privateRoomFullCountsBeforeChatCheck = [host, guest1, fourth, victim].map(
    (c) => c.frames.filter((f) => f.type === 'private_room_full').length,
  )

  await check('[7] chat from the victim\'s LIVE connection on the (now-started) old privateRoomId correctly reports not_member — not because of stale binding, but because the waiting room legitimately converted to a game', async () => {
    victim.frames.length = 0
    send(victim, { type: 'send_private_room_chat_message', privateRoomId: roomId, body: 'still here?' })
    const errorFrame = await waitForFrame(victim, (f) => f.type === 'private_room_chat_error' && f.code === 'not_member', 5_000, 'post-start chat rejection')
    if (errorFrame === undefined) throw new Error('expected not_member after the waiting room converted to a game')
  })

  await check('[8] every one of the 4 real participants received exactly ONE private_room_full (no double room start, no duplicate delivery)', () => {
    if (privateRoomFullCountsBeforeChatCheck.some((n) => n !== 1)) {
      throw new Error(`expected exactly 1 private_room_full per participant, got [${privateRoomFullCountsBeforeChatCheck.join(', ')}]`)
    }
  })

  // ─── Cleanup ──────────────────────────────────────────────────────────────
  for (const c of [host, guest1, fourth, victim]) {
    try { c.ws.close() } catch { /* ignore */ }
  }
} finally {
  await stopServer(server)
  await isolated.cleanup()
}

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)

if (failed > 0) {
  process.exit(1)
}
