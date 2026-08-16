/**
 * checkPrivateRoomWebSocketRoundTrip.ts
 *
 * Real spawned-server, real WebSocket round-trip integration test for the
 * private-table explicit team/slot join + per-team bot control flow. Unlike
 * the pure privateRoomsStore unit tests (checkPrivateRoomTeamJoinChoice.ts,
 * checkPrivateRoomBotOwnership.ts, etc.), this test exercises the ACTUAL
 * server process end-to-end: real HTTP registration, real cookie sessions,
 * real separate WebSocket connections per human participant, real JSON
 * frames over the wire — following the exact isolated-server pattern
 * established by checkVoluntaryLeaveChatGate.ts.
 *
 * Covers:
 *  - create_private_room -> join_private_room{team,slotIndex} ->
 *    server-authoritative private_room_updated membership confirmation,
 *    with the creator auto-seated at Team A, slot 0.
 *  - subscribe_private_room_chat -> private_room_chat_history, then a real
 *    send_private_room_chat_message reaching exactly the two real members
 *    and NOT an outsider connection (isolation), and the outsider being
 *    rejected (not_member) on both subscribe and send.
 *  - Per-team bot completion (2 humans + 2 bots, and 3 humans + 1 bot):
 *    each team's own human adds their own team's bot via
 *    add_bot_to_private_room_team — a human cannot add a bot to a team they
 *    are not seated in (private_room_bot_owner_missing) — and the room only
 *    starts once BOTH teams are complete: exactly one ServerRoom created,
 *    exactly 4 unique occupied seats, correct bot count, every human
 *    receives the real room_snapshot with the game already started,
 *    isPrivateTableOrigin === true, the private room disappears from
 *    private_rooms_list, chat on the old privateRoomId is rejected
 *    afterward (not_member), and a repeated bot-add command after start
 *    does not create a second room.
 *  - Race guard: a human join and a competing bot-add targeting the exact
 *    same (team, slotIndex) never both succeed — exactly one safe terminal
 *    state, never 5 participants, never two rooms.
 *  - Reconnect: a human who disconnects (WS close, no leave_private_room)
 *    while still in the pre-game waiting room is restored on reconnect
 *    (privateRoomsStore.reconnectMember behaviour) instead of silently
 *    losing their seat.
 *
 * Deterministic: no statistical/many-run sampling. The race test fires two
 * real concurrent commands and asserts the OUTCOME INVARIANT (exactly one
 * valid terminal state) rather than asserting which one specifically wins —
 * the winner depends on real network/event-loop arrival order, but the
 * safety invariant holds unconditionally either way.
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
  const root = await mkdtemp(join(tmpdir(), 'belot-private-room-ws-'))
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
    email: `private-room-ws-${tag}-${runId}@example.test`,
    password: 'PrivateRoomWsDiag1!',
    displayName: `PRW ${tag}`,
    gender: 'male',
  })
  if (reg.status !== 200) throw new Error(`Registration failed for ${tag}: ${JSON.stringify(reg.body)}`)
  return { cookie: reg.setCookie as string, profileId: reg.body.session.profile.profileId }
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

console.log('\ncheckPrivateRoomWebSocketRoundTrip\n')

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
  // Scenario A: explicit team join + per-team bot completion (2 humans + 2
  // bots, one bot per team), plus chat isolation against an outsider.
  // ───────────────────────────────────────────────────────────────────────
  console.log('--- Scenario A: 2 humans + 2 bots (one per team) ---')

  const hostA = await connectClient(port, 'hostA')
  const guestA1 = await connectClient(port, 'guestA1')
  const outsider = await connectClient(port, 'outsider')

  send(hostA, { type: 'create_private_room', stake: 5000, isLocked: false })
  const createdA = await waitForFrame(hostA, (f) => f.type === 'private_room_updated', 10_000, 'create_private_room ack')
  const roomIdA: string = createdA.room.id

  await check('[A1] create_private_room produces a server-authoritative private_room_updated with 1 occupied slot (creator @ Team A, slot 0)', async () => {
    if (occupiedCount(createdA.room) !== 1) throw new Error(`occupiedCount=${occupiedCount(createdA.room)}`)
    const a0 = slotOccupant(createdA.room, 'A', 0)
    if (a0 === null || a0.isHost !== true) throw new Error('creator not seated at A,0 as host')
  })

  await check('[A2] the lone creator CAN add a bot to their OWN team (Team A: 1 human + 1 empty)', async () => {
    hostA.frames.length = 0
    send(hostA, { type: 'add_bot_to_private_room_team', team: 'A' })
    const updated = await waitForFrame(hostA, (f) => f.type === 'private_room_updated', 5_000, 'host sees Team A bot added')
    const a1 = slotOccupant(updated.room, 'A', 1)
    if (a1 === null || a1.isBot !== true) throw new Error('expected a bot at A,1')
    if (occupiedCount(updated.room) !== 2) throw new Error(`occupiedCount=${occupiedCount(updated.room)} (room must not auto-start with Team B still empty)`)
  })

  send(guestA1, { type: 'join_private_room', privateRoomId: roomIdA, team: 'B', slotIndex: 0 })
  await waitForFrame(hostA, (f) => f.type === 'private_room_updated' && occupiedCount(f.room) === 3, 10_000, 'host sees guest join Team B')
  await waitForFrame(guestA1, (f) => f.type === 'private_room_updated' && occupiedCount(f.room) === 3, 10_000, 'guest sees own join confirmed')

  await check('[A3] server-authoritative membership: both host and guest see the same 3-occupied room', async () => {
    const hostView = [...hostA.frames].reverse().find((f) => f.type === 'private_room_updated')
    const guestView = [...guestA1.frames].reverse().find((f) => f.type === 'private_room_updated')
    if (hostView.room.id !== roomIdA || guestView.room.id !== roomIdA) throw new Error('room id mismatch')
    if (occupiedCount(hostView.room) !== 3 || occupiedCount(guestView.room) !== 3) throw new Error('expected 3 occupied slots on both views')
  })

  await check('[A4] a human cannot add a bot to a team they are NOT seated in (Team A is guestA1\'s opponent team)', async () => {
    guestA1.frames.length = 0
    send(guestA1, { type: 'add_bot_to_private_room_team', team: 'A' })
    const errorFrame = await waitForFrame(guestA1, (f) => f.type === 'error', 5_000, 'cross-team bot-add rejection')
    if (typeof errorFrame.message !== 'string' || errorFrame.message.length === 0) throw new Error('expected a rejection message')
  })

  // ─── Chat: subscribe, history, real send/receive, outsider isolation ────
  send(hostA, { type: 'subscribe_private_room_chat', privateRoomId: roomIdA })
  send(guestA1, { type: 'subscribe_private_room_chat', privateRoomId: roomIdA })
  await waitForFrame(hostA, (f) => f.type === 'private_room_chat_history' && f.privateRoomId === roomIdA, 5_000, 'host chat history')
  await waitForFrame(guestA1, (f) => f.type === 'private_room_chat_history' && f.privateRoomId === roomIdA, 5_000, 'guest chat history')

  await check('[A5] chat history starts empty for a fresh room', () => {
    const historyFrame = framesOfType(hostA, 'private_room_chat_history').find((f) => f.privateRoomId === roomIdA)
    if (historyFrame.messages.length !== 0) throw new Error(`expected empty history, got ${historyFrame.messages.length}`)
  })

  outsider.frames.length = 0
  send(outsider, { type: 'subscribe_private_room_chat', privateRoomId: roomIdA })
  await check('[A6] an outsider (not a member) cannot subscribe to this room\'s chat', async () => {
    const errorFrame = await waitForFrame(outsider, (f) => f.type === 'private_room_chat_error' && f.code === 'not_member', 5_000, 'outsider subscribe rejection')
    if (errorFrame === undefined) throw new Error('expected private_room_chat_error(not_member)')
  })

  outsider.frames.length = 0
  send(outsider, { type: 'send_private_room_chat_message', privateRoomId: roomIdA, body: 'intruder message' })
  await check('[A7] an outsider cannot send a chat message into this room', async () => {
    const errorFrame = await waitForFrame(outsider, (f) => f.type === 'private_room_chat_error' && f.code === 'not_member', 5_000, 'outsider send rejection')
    if (errorFrame === undefined) throw new Error('expected private_room_chat_error(not_member)')
  })

  hostA.frames.length = 0
  guestA1.frames.length = 0
  send(hostA, { type: 'send_private_room_chat_message', privateRoomId: roomIdA, body: 'Здравей, отборе!', requestId: 'reqA1' })
  const hostChatMsg = await waitForFrame(hostA, (f) => f.type === 'private_room_chat_message' && f.privateRoomId === roomIdA, 5_000, 'host receives own chat echo')
  const guestChatMsg = await waitForFrame(guestA1, (f) => f.type === 'private_room_chat_message' && f.body === 'Здравей, отборе!', 5_000, 'guest receives real member chat message')

  await check('[A8] a real chat message sent by the host is received by the real guest over their own WebSocket', () => {
    if (guestChatMsg.body !== 'Здравей, отборе!') throw new Error(`unexpected body: ${guestChatMsg.body}`)
    if (guestChatMsg.senderDisplayName !== hostChatMsg.senderDisplayName) throw new Error('sender identity mismatch between host echo and guest delivery')
  })

  await check('[A9] the outsider never receives the private chat message (isolation)', async () => {
    await sleep(500)
    const leaked = outsider.frames.some((f) => f.type === 'private_room_chat_message' && f.body === 'Здравей, отборе!')
    if (leaked) throw new Error('outsider connection received a message from a room it is not a member of')
  })

  await check('[A10] the outsider\'s rejected chat message never reached the real room members', () => {
    const leakedToHost = hostA.frames.some((f) => f.type === 'private_room_chat_message' && f.body === 'intruder message')
    const leakedToGuest = guestA1.frames.some((f) => f.type === 'private_room_chat_message' && f.body === 'intruder message')
    if (leakedToHost || leakedToGuest) throw new Error('rejected outsider message leaked to real members')
  })

  // ─── guestA1 completes Team B with their own bot -> room reaches 4/4 ────
  hostA.frames.length = 0
  guestA1.frames.length = 0
  send(guestA1, { type: 'add_bot_to_private_room_team', team: 'B' })

  const hostFullA = await waitForFrame(hostA, (f) => f.type === 'private_room_full', 15_000, 'host private_room_full')
  const guestFullA = await waitForFrame(guestA1, (f) => f.type === 'private_room_full', 15_000, 'guest private_room_full')

  await check('[A11] exactly one game room is created — host and guest reference the SAME roomId', () => {
    if (hostFullA.roomId !== guestFullA.roomId) throw new Error(`hostRoomId=${hostFullA.roomId} guestRoomId=${guestFullA.roomId}`)
  })
  await check('[A12] host and guest are assigned two DIFFERENT seats', () => {
    if (hostFullA.seat === guestFullA.seat) throw new Error(`both assigned seat=${hostFullA.seat}`)
  })

  const gameRoomIdA: string = hostFullA.roomId
  const hostSnapshotA = await waitForFrame(hostA, (f) => f.type === 'room_snapshot' && f.roomId === gameRoomIdA, 10_000, 'host room_snapshot')
  const guestSnapshotA = await waitForFrame(guestA1, (f) => f.type === 'room_snapshot' && f.roomId === gameRoomIdA, 10_000, 'guest room_snapshot')

  await check('[A13] exactly 4 uniquely occupied seats in the started room', () => {
    const occupied = (hostSnapshotA.seats as any[]).filter((s) => s.isOccupied)
    if (occupied.length !== 4) throw new Error(`occupied seats=${occupied.length}`)
    const uniqueSeatNames = new Set(occupied.map((s) => s.seat))
    if (uniqueSeatNames.size !== 4) throw new Error('duplicate seat assignment detected')
  })

  await check('[A14] exactly 2 bots and 2 humans occupy the 4 seats (2 humans + 2 bots scenario)', () => {
    const seats = hostSnapshotA.seats as any[]
    const botCount = seats.filter((s) => s.isOccupied && s.isBot).length
    const humanCount = seats.filter((s) => s.isOccupied && !s.isBot).length
    if (botCount !== 2) throw new Error(`expected 2 bots, got ${botCount}`)
    if (humanCount !== 2) throw new Error(`expected 2 humans, got ${humanCount}`)
  })

  await check('[A15] isPrivateTableOrigin === true on the started room snapshot', () => {
    if (hostSnapshotA.isPrivateTableOrigin !== true) throw new Error(`isPrivateTableOrigin=${hostSnapshotA.isPrivateTableOrigin}`)
    if (guestSnapshotA.isPrivateTableOrigin !== true) throw new Error('guest snapshot missing isPrivateTableOrigin=true')
  })

  await check('[A16] both real human participants receive the started game state (room_snapshot with an active game phase)', async () => {
    const hostActiveSnapshot = await waitForFrame(
      hostA,
      (f) => isActiveServerAuthoritativeRoomSnapshot(f, gameRoomIdA),
      5_000,
      'host active server-authoritative room_snapshot',
    )
    const guestActiveSnapshot = await waitForFrame(
      guestA1,
      (f) => isActiveServerAuthoritativeRoomSnapshot(f, gameRoomIdA),
      5_000,
      'guest active server-authoritative room_snapshot',
    )
    if (hostActiveSnapshot.yourSeat !== hostFullA.seat) throw new Error(`host yourSeat=${hostActiveSnapshot.yourSeat}, expected ${hostFullA.seat}`)
    if (guestActiveSnapshot.yourSeat !== guestFullA.seat) throw new Error(`guest yourSeat=${guestActiveSnapshot.yourSeat}, expected ${guestFullA.seat}`)
  })

  await check('[A17] the private table is no longer in the public private_rooms_list', async () => {
    hostA.frames.length = 0
    send(hostA, { type: 'request_private_rooms_list' })
    const listFrame = await waitForFrame(hostA, (f) => f.type === 'private_rooms_list', 5_000, 'private_rooms_list after start')
    if (listFrame.rooms.some((r: any) => r.id === roomIdA)) throw new Error('started private room still listed as available')
  })

  await check('[A18] chat on the old (now-started) privateRoomId is rejected — waiting-room chat is gone after start', async () => {
    hostA.frames.length = 0
    send(hostA, { type: 'send_private_room_chat_message', privateRoomId: roomIdA, body: 'still here?' })
    const errorFrame = await waitForFrame(hostA, (f) => f.type === 'private_room_chat_error' && f.code === 'not_member', 5_000, 'post-start chat rejection')
    if (errorFrame === undefined) throw new Error('expected not_member after the waiting room converted to a game')
  })

  await check('[A19] a repeated add_bot_to_private_room_team command after the room already started does not create a second room', async () => {
    hostA.frames.length = 0
    send(hostA, { type: 'add_bot_to_private_room_team', team: 'A' })
    const errorFrame = await waitForFrame(hostA, (f) => f.type === 'error', 5_000, 'post-start bot-add rejection')
    if (errorFrame === undefined) throw new Error('expected a plain error, not a second private_room_full')
    const secondFull = hostA.frames.some((f) => f.type === 'private_room_full')
    if (secondFull) throw new Error('a duplicate bot-add command produced a SECOND private_room_full — second room created')
  })

  // ───────────────────────────────────────────────────────────────────────
  // Scenario B: 3 humans + 1 bot
  // ───────────────────────────────────────────────────────────────────────
  console.log('\n--- Scenario B: 3 humans + 1 bot ---')

  const hostB = await connectClient(port, 'hostB')
  const guestB1 = await connectClient(port, 'guestB1')
  const guestB2 = await connectClient(port, 'guestB2')

  send(hostB, { type: 'create_private_room', stake: 5000, isLocked: false })
  const createdB = await waitForFrame(hostB, (f) => f.type === 'private_room_updated', 10_000, 'create_private_room B')
  const roomIdB: string = createdB.room.id

  // Team A fills with 2 real humans (host + guest1); Team B gets a single
  // human (guest2), who then completes their own team with a bot.
  send(guestB1, { type: 'join_private_room', privateRoomId: roomIdB, team: 'A', slotIndex: 1 })
  await waitForFrame(hostB, (f) => f.type === 'private_room_updated' && occupiedCount(f.room) === 2, 10_000, 'B: 2 occupied')
  send(guestB2, { type: 'join_private_room', privateRoomId: roomIdB, team: 'B', slotIndex: 0 })
  await waitForFrame(hostB, (f) => f.type === 'private_room_updated' && occupiedCount(f.room) === 3, 10_000, 'B: 3 occupied')
  await waitForFrame(guestB1, (f) => f.type === 'private_room_updated' && occupiedCount(f.room) === 3, 10_000, 'B: guest1 sees 3 occupied')
  await waitForFrame(guestB2, (f) => f.type === 'private_room_updated' && occupiedCount(f.room) === 3, 10_000, 'B: guest2 sees 3 occupied')

  hostB.frames.length = 0
  guestB1.frames.length = 0
  guestB2.frames.length = 0
  send(guestB2, { type: 'add_bot_to_private_room_team', team: 'B' })

  const hostFullB = await waitForFrame(hostB, (f) => f.type === 'private_room_full', 15_000, 'B host private_room_full')
  const guest1FullB = await waitForFrame(guestB1, (f) => f.type === 'private_room_full', 15_000, 'B guest1 private_room_full')
  const guest2FullB = await waitForFrame(guestB2, (f) => f.type === 'private_room_full', 15_000, 'B guest2 private_room_full')

  await check('[B1] all 3 real humans land in the SAME single game room', () => {
    if (hostFullB.roomId !== guest1FullB.roomId || hostFullB.roomId !== guest2FullB.roomId) {
      throw new Error(`room ids differ: ${hostFullB.roomId}, ${guest1FullB.roomId}, ${guest2FullB.roomId}`)
    }
  })
  await check('[B2] all 3 humans are assigned 3 DIFFERENT seats', () => {
    const seatSet = new Set([hostFullB.seat, guest1FullB.seat, guest2FullB.seat])
    if (seatSet.size !== 3) throw new Error(`expected 3 unique seats, got ${seatSet.size}`)
  })

  const gameRoomIdB: string = hostFullB.roomId
  const hostSnapshotB = await waitForFrame(hostB, (f) => f.type === 'room_snapshot' && f.roomId === gameRoomIdB, 10_000, 'B host room_snapshot')

  await check('[B3] exactly 4 uniquely occupied seats', () => {
    const occupied = (hostSnapshotB.seats as any[]).filter((s) => s.isOccupied)
    if (occupied.length !== 4) throw new Error(`occupied=${occupied.length}`)
    if (new Set(occupied.map((s) => s.seat)).size !== 4) throw new Error('duplicate seats')
  })
  await check('[B4] exactly 1 bot and 3 humans (3 humans + 1 bot scenario)', () => {
    const seats = hostSnapshotB.seats as any[]
    const botCount = seats.filter((s) => s.isOccupied && s.isBot).length
    const humanCount = seats.filter((s) => s.isOccupied && !s.isBot).length
    if (botCount !== 1) throw new Error(`expected 1 bot, got ${botCount}`)
    if (humanCount !== 3) throw new Error(`expected 3 humans, got ${humanCount}`)
  })
  await check('[B5] isPrivateTableOrigin === true for the 3-humans-plus-bot start', () => {
    if (hostSnapshotB.isPrivateTableOrigin !== true) throw new Error(`isPrivateTableOrigin=${hostSnapshotB.isPrivateTableOrigin}`)
  })

  // ───────────────────────────────────────────────────────────────────────
  // Race: a 4th human join and a competing bot-add, BOTH targeting the same
  // physically free slot (Team B, slot 1). Outcome must ALWAYS be safe
  // (exactly 4 seats, exactly one room) regardless of which real network
  // message the server happens to process first.
  // ───────────────────────────────────────────────────────────────────────
  console.log('\n--- Race: 4th human join vs bot-add for the same (team, slotIndex) ---')

  const hostC = await connectClient(port, 'hostC')
  const guestC1 = await connectClient(port, 'guestC1')
  const guestC2 = await connectClient(port, 'guestC2')
  const guestC3 = await connectClient(port, 'guestC3')

  send(hostC, { type: 'create_private_room', stake: 5000, isLocked: false })
  const createdC = await waitForFrame(hostC, (f) => f.type === 'private_room_updated', 10_000, 'create_private_room C')
  const roomIdC: string = createdC.room.id

  // Team A fills (host + guest1); Team B gets guest2, leaving exactly one
  // physically free slot in the whole room: Team B, slot 1.
  send(guestC1, { type: 'join_private_room', privateRoomId: roomIdC, team: 'A', slotIndex: 1 })
  await waitForFrame(hostC, (f) => f.type === 'private_room_updated' && occupiedCount(f.room) === 2, 10_000, 'C: 2 occupied')
  send(guestC2, { type: 'join_private_room', privateRoomId: roomIdC, team: 'B', slotIndex: 0 })
  await waitForFrame(hostC, (f) => f.type === 'private_room_updated' && occupiedCount(f.room) === 3, 10_000, 'C: 3 occupied')

  hostC.frames.length = 0
  guestC1.frames.length = 0
  guestC2.frames.length = 0
  guestC3.frames.length = 0

  // Fire both real WS messages back-to-back without awaiting in between —
  // the actual arrival/processing order at the server is real network
  // timing, not something this test controls or needs to control. guestC3
  // targets Team B, slot 1 directly; guestC2 (Team B's own human) races it
  // with a bot-add for their own team's only free slot — the same slot.
  send(guestC3, { type: 'join_private_room', privateRoomId: roomIdC, team: 'B', slotIndex: 1 })
  send(guestC2, { type: 'add_bot_to_private_room_team', team: 'B' })

  await check('[R1] the race between a 4th human joining and bot-fill resolves to exactly one safe terminal state', async () => {
    await waitForCondition(
      'a terminal outcome (private_room_full for the host, one way or another) is reached',
      () => hostC.frames.some((f) => f.type === 'private_room_full'),
      15_000,
    )

    const hostFullC = hostC.frames.find((f) => f.type === 'private_room_full')
    const guest3JoinedNormally = guestC3.frames.some((f) => f.type === 'private_room_full')
    const guest3Rejected = guestC3.frames.some((f) => f.type === 'error')

    if (!guest3JoinedNormally && !guest3Rejected) {
      // Give a little more time — guestC3's frame may simply not have
      // arrived yet even though the host's private_room_full already did.
      await waitForCondition(
        'guestC3 reaches a terminal outcome too (joined the 4-human game, or was rejected)',
        () => guestC3.frames.some((f) => f.type === 'private_room_full' || f.type === 'error'),
        5_000,
      )
    }

    const finalGuest3Joined = guestC3.frames.some((f) => f.type === 'private_room_full')
    const finalGuest3Rejected = guestC3.frames.some((f) => f.type === 'error')

    if (finalGuest3Joined === finalGuest3Rejected) {
      throw new Error(`ambiguous outcome for guestC3: joined=${finalGuest3Joined} rejected=${finalGuest3Rejected}`)
    }

    const gameRoomIdC: string = hostFullC.roomId
    const snapshot = await waitForFrame(hostC, (f) => f.type === 'room_snapshot' && f.roomId === gameRoomIdC, 10_000, 'C room_snapshot')
    const occupied = (snapshot.seats as any[]).filter((s) => s.isOccupied)
    if (occupied.length !== 4) throw new Error(`race produced ${occupied.length} occupied seats, expected exactly 4`)
    if (new Set(occupied.map((s) => s.seat)).size !== 4) throw new Error('race produced duplicate seats')

    if (finalGuest3Joined) {
      const guest3Full = guestC3.frames.find((f) => f.type === 'private_room_full')
      if (guest3Full.roomId !== gameRoomIdC) throw new Error('guestC3 ended up in a DIFFERENT room than host — two rooms were created')
      const humanCount = occupied.filter((s) => !s.isBot).length
      if (humanCount !== 4) throw new Error(`guestC3 joined normally but only ${humanCount} humans are seated`)
    } else {
      const humanCount = occupied.filter((s) => !s.isBot).length
      const botCount = occupied.filter((s) => s.isBot).length
      if (humanCount !== 3 || botCount !== 1) throw new Error(`bot-fill won the race but seating is humans=${humanCount} bots=${botCount}, expected 3+1`)
    }
  })

  // ───────────────────────────────────────────────────────────────────────
  // Reconnect: disconnect (no leave_private_room) while still waiting,
  // then reconnect and confirm the seat/membership is preserved.
  // ───────────────────────────────────────────────────────────────────────
  console.log('\n--- Reconnect while in the pre-game waiting room ---')

  let hostD = await connectClient(port, 'hostD')
  let guestD1 = await connectClient(port, 'guestD1')

  send(hostD, { type: 'create_private_room', stake: 5000, isLocked: false })
  const createdD = await waitForFrame(hostD, (f) => f.type === 'private_room_updated', 10_000, 'create_private_room D')
  const roomIdD: string = createdD.room.id

  send(guestD1, { type: 'join_private_room', privateRoomId: roomIdD, team: 'B', slotIndex: 0 })
  await waitForFrame(hostD, (f) => f.type === 'private_room_updated' && occupiedCount(f.room) === 2, 10_000, 'D: 2 occupied')

  await check('[D1] a human who disconnects (WS close, no explicit leave) while waiting can reconnect and is restored to the same room', async () => {
    guestD1.ws.close()
    await new Promise<void>((r) => guestD1.ws.once('close', () => r()))
    await sleep(300)

    const reconnected = await reconnectClient(port, guestD1)
    send(reconnected, { type: 'request_private_rooms_list' })
    const updated = await waitForFrame(reconnected, (f) => f.type === 'private_room_updated' && f.room.id === roomIdD, 10_000, 'reconnect restores private room membership')
    if (occupiedCount(updated.room) !== 2) throw new Error(`expected 2 occupied slots preserved after reconnect, got ${occupiedCount(updated.room)}`)
    const b0 = slotOccupant(updated.room, 'B', 0)
    if (b0 === null || b0.isBot === true) throw new Error('reconnected human is no longer at their original Team B, slot 0')
    guestD1 = reconnected
  })

  await check('[D2] after reconnect, the restored member can still chat in the same waiting room', async () => {
    hostD.frames.length = 0
    guestD1.frames.length = 0
    send(guestD1, { type: 'subscribe_private_room_chat', privateRoomId: roomIdD })
    await waitForFrame(guestD1, (f) => f.type === 'private_room_chat_history' && f.privateRoomId === roomIdD, 5_000, 'reconnected member chat history')
    send(hostD, { type: 'subscribe_private_room_chat', privateRoomId: roomIdD })
    send(guestD1, { type: 'send_private_room_chat_message', privateRoomId: roomIdD, body: 'back online' })
    await waitForFrame(hostD, (f) => f.type === 'private_room_chat_message' && f.body === 'back online', 5_000, 'host receives reconnected member\'s message')
  })

  // ─── Cleanup: close every remaining socket ───────────────────────────────
  for (const c of [hostA, guestA1, outsider, hostB, guestB1, guestB2, hostC, guestC1, guestC2, guestC3, hostD, guestD1]) {
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
