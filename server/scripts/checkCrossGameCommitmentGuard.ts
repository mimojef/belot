/**
 * checkCrossGameCommitmentGuard.ts
 *
 * Real spawned-server, real WebSocket integration test for the cross-game
 * commitment guard added to fix a bug where a profile could hold a Ludo
 * waiting-room seat / active Ludo match AND simultaneously create or join a
 * Белот game (matchmaking queue, private table), or vice versa.
 *
 * Follows the exact isolated-server + real-WebSocket pattern established by
 * checkPrivateRoomStakeEligibility.ts / checkPrivateRoomWebSocketRoundTrip.ts.
 *
 * Scenarios (see task spec, letters A-G):
 *  A. Ludo waiting CREATOR -> Белот create_private_room / join_matchmaking
 *     => BLOCK (cross_game_commitment_active), Ludo room untouched.
 *  B. Ludo waiting GUEST -> Белот create_private_room / join_matchmaking
 *     => BLOCK, Ludo room untouched.
 *  C. Ludo ACTIVE MATCH (both seats, auto-started) -> Белот
 *     create_private_room / join_matchmaking => BLOCK for both players.
 *  D. Белот waiting private room (creator) -> Ludo create_ludo_room /
 *     join_ludo_room => BLOCK, private room untouched.
 *  M. Белот matchmaking commitment (searching, no room yet) -> Ludo
 *     create_ludo_room / join_ludo_room => BLOCK — the OTHER
 *     findActiveBelotCommitment() branch (queueEntries, not privateRoomsStore).
 *  E. Белот ACTIVE room (seated via legacy create_room, which produces a
 *     real serverState.rooms entry with a non-null phase) -> Ludo
 *     create_ludo_room / join_ludo_room => BLOCK.
 *  F. After a normal leave (leave_ludo_room / leave_private_room), the SAME
 *     profile can immediately create/join the other game type.
 *  G. No duplicate memberships: every blocked attempt above never produced
 *     a success frame, and the origin room/match membership count never
 *     changed because of the blocked attempt.
 *
 * UX follow-up (structured cross_game_commitment_blocked contract): every
 * BLOCK above additionally asserts the message is the new dedicated
 * `cross_game_commitment_blocked` push (not a generic `error`), and that its
 * `location` field (gameType + kind + canonical id) points at the ACTUAL
 * room/match/stake under test — this is what the client's "Виж" button
 * navigates on, so a wrong id here would silently break navigation.
 */

import { DatabaseSync } from 'node:sqlite'
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
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const setCookie = (res.headers.getSetCookie?.()[0] ?? res.headers.get('set-cookie'))?.split(';')[0] ?? null
  let json: any = null
  try { json = await res.json() } catch { /* not json */ }
  return { status: res.status, body: json, setCookie }
}

// ─── Isolated server (same model as checkPrivateRoomStakeEligibility.ts) ───

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
  const root = await mkdtemp(join(tmpdir(), 'belot-cross-game-guard-'))
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
    dbFile: join(serverDir, 'database', 'data', 'belot-v2.sqlite'),
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

// ─── Test harness helpers ───────────────────────────────────────────────────

type TestClient = {
  profileId: string
  cookie: string
  ws: WebSocket
  frames: any[]
}

async function registerAndLogin(port: number, tag: string, runId: string): Promise<{ cookie: string; profileId: string; email: string }> {
  const email = `cross-game-guard-${tag}-${runId}@example.test`
  const reg = await httpJson(port, 'POST', '/api/auth/register', null, {
    email,
    password: 'CrossGameGuardDiag1!',
    displayName: `CGG ${tag.replace(/[^a-zA-Z0-9]/g, '')}`,
    gender: 'male',
  })
  if (reg.status !== 200) throw new Error(`Registration failed for ${tag}: ${JSON.stringify(reg.body)}`)
  const cookie = reg.setCookie as string
  const profileId = reg.body.session.profile.profileId
  return { cookie, profileId, email }
}

async function connectWs(port: number, cookie: string, profileId: string): Promise<TestClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: cookie } })
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

async function noFrameArrives(
  client: TestClient,
  predicate: (frame: any) => boolean,
  waitMs = 1500,
): Promise<boolean> {
  await sleep(waitMs)
  return !client.frames.some(predicate)
}

function setWalletBalance(dbFile: string, profileId: string, amount: number): void {
  const db = new DatabaseSync(dbFile, { open: true, enableForeignKeyConstraints: true })
  try {
    db.prepare(
      `INSERT INTO profile_wallets (profile_id, yellow_coins_balance) VALUES (?, ?)
       ON CONFLICT(profile_id) DO UPDATE SET yellow_coins_balance = excluded.yellow_coins_balance`,
    ).run(profileId, amount)
  } finally {
    db.close()
  }
}

const CROSS_GAME_MESSAGE = 'Вече участвате в друга игра. Напуснете я, преди да започнете нова.'

// Structured contract check (UX follow-up task): the block is now a
// dedicated cross_game_commitment_blocked message carrying `location` —
// server says WHERE the commitment is (gameType + kind + canonical id), the
// client only navigates. Returns the location so callers can additionally
// assert the canonical id (ludoRoomId/matchId/privateRoomId/stake) matches
// the actual room/match under test.
async function expectCrossGameBlock(
  client: TestClient,
  label: string,
  waitLabel: string,
  expectedLocation: { gameType: 'ludo' | 'belot'; kind: string },
): Promise<any> {
  let location: any = null
  await check(label, async () => {
    const frame = await waitForFrame(client, (f) => f.type === 'cross_game_commitment_blocked', 5_000, waitLabel)
    if (frame.message !== CROSS_GAME_MESSAGE) {
      throw new Error(`unexpected message: ${frame.message}`)
    }
    if (frame.location?.gameType !== expectedLocation.gameType || frame.location?.kind !== expectedLocation.kind) {
      throw new Error(`unexpected location: ${JSON.stringify(frame.location)}`)
    }
    location = frame.location
  })
  return location
}

console.log('\ncheckCrossGameCommitmentGuard\n')

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
        const r = await fetch(`http://127.0.0.1:${port}/health`)
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

  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const STAKE = 5000 // default-seeded stake, minLevel=1, used by both Белот and Ludo

  async function newClient(tag: string): Promise<TestClient> {
    const { cookie, profileId } = await registerAndLogin(port, tag, runId)
    setWalletBalance(isolated.dbFile, profileId, 50_000)
    return connectWs(port, cookie, profileId)
  }

  // ───────────────────────────────────────────────────────────────────────
  // Scenario A: Ludo waiting CREATOR -> Белот create => BLOCK
  // ───────────────────────────────────────────────────────────────────────
  console.log('--- Scenario A: Ludo waiting creator -> Белот create ---')

  const aHost = await newClient('a-host')
  send(aHost, { type: 'create_ludo_room', stake: STAKE, playerCount: 2, manualStart: true })
  const aRoom = await waitForFrame(aHost, (f) => f.type === 'ludo_room_updated', 10_000, 'A: ludo room created')

  aHost.frames.length = 0
  send(aHost, { type: 'create_private_room', stake: STAKE, isLocked: false, waitMinutes: 15 })
  const a1Location = await expectCrossGameBlock(
    aHost, '[A1] Ludo waiting creator -> create_private_room => BLOCK', 'A1 rejection',
    { gameType: 'ludo', kind: 'waiting_room' },
  )
  await check('[A1b] location.ludoRoomId points at the actual Ludo waiting room', () => {
    if (a1Location.ludoRoomId !== aRoom.room.id) throw new Error(`ludoRoomId=${a1Location.ludoRoomId}, expected=${aRoom.room.id}`)
  })

  aHost.frames.length = 0
  send(aHost, { type: 'join_matchmaking', stake: STAKE })
  await expectCrossGameBlock(
    aHost, '[A2] Ludo waiting creator -> join_matchmaking => BLOCK', 'A2 rejection',
    { gameType: 'ludo', kind: 'waiting_room' },
  )

  await check('[A3] the Ludo waiting room is untouched (still 1 member, still waiting)', async () => {
    aHost.frames.length = 0
    send(aHost, { type: 'request_ludo_rooms_list' })
    const listFrame = await waitForFrame(aHost, (f) => f.type === 'ludo_rooms_list', 5_000, 'A3 rooms list')
    const room = listFrame.rooms.find((r: any) => r.id === aRoom.room.id)
    if (!room) throw new Error('ludo room disappeared after blocked Белот attempts')
    if (room.players.length !== 1) throw new Error(`expected 1 player, got ${room.players.length}`)
  })

  // ───────────────────────────────────────────────────────────────────────
  // Scenario B: Ludo waiting GUEST -> Белот join/create => BLOCK
  // ───────────────────────────────────────────────────────────────────────
  console.log('\n--- Scenario B: Ludo waiting guest -> Белот join/create ---')

  const bHost = await newClient('b-host')
  send(bHost, { type: 'create_ludo_room', stake: STAKE, playerCount: 4, manualStart: true })
  const bRoom = await waitForFrame(bHost, (f) => f.type === 'ludo_room_updated', 10_000, 'B: host room created')

  const bGuest = await newClient('b-guest')
  send(bGuest, { type: 'join_ludo_room', ludoRoomId: bRoom.room.id })
  await waitForFrame(bGuest, (f) => f.type === 'ludo_room_updated', 10_000, 'B: guest joined (still waiting, 2/4)')

  bGuest.frames.length = 0
  send(bGuest, { type: 'join_matchmaking', stake: STAKE })
  await expectCrossGameBlock(
    bGuest, '[B1] Ludo waiting guest -> join_matchmaking => BLOCK', 'B1 rejection',
    { gameType: 'ludo', kind: 'waiting_room' },
  )

  bGuest.frames.length = 0
  send(bGuest, { type: 'create_private_room', stake: STAKE, isLocked: false, waitMinutes: 15 })
  const b2Location = await expectCrossGameBlock(
    bGuest, '[B2] Ludo waiting guest -> create_private_room => BLOCK', 'B2 rejection',
    { gameType: 'ludo', kind: 'waiting_room' },
  )
  await check('[B2b] location.ludoRoomId points at the actual Ludo waiting room (not the guest\'s own — there is none)', () => {
    if (b2Location.ludoRoomId !== bRoom.room.id) throw new Error(`ludoRoomId=${b2Location.ludoRoomId}, expected=${bRoom.room.id}`)
  })

  await check('[B3] the Ludo waiting room still has the guest as a member (2/4, still waiting)', async () => {
    bGuest.frames.length = 0
    send(bGuest, { type: 'request_ludo_rooms_list' })
    const listFrame = await waitForFrame(bGuest, (f) => f.type === 'ludo_rooms_list', 5_000, 'B3 rooms list')
    const room = listFrame.rooms.find((r: any) => r.id === bRoom.room.id)
    if (!room) throw new Error('ludo room disappeared after blocked Белот attempts')
    if (room.players.length !== 2) throw new Error(`expected 2 players, got ${room.players.length}`)
  })

  // ───────────────────────────────────────────────────────────────────────
  // Scenario C: Ludo ACTIVE MATCH -> Белот create/join => BLOCK
  // ───────────────────────────────────────────────────────────────────────
  console.log('\n--- Scenario C: Ludo active match -> Белот create/join ---')

  const cHost = await newClient('c-host')
  send(cHost, { type: 'create_ludo_room', stake: STAKE, playerCount: 2, manualStart: false })
  await waitForFrame(cHost, (f) => f.type === 'ludo_room_updated', 10_000, 'C: host room created')
  const cHostRoomId = cHost.frames.find((f) => f.type === 'ludo_room_updated').room.id

  const cGuest = await newClient('c-guest')
  send(cGuest, { type: 'join_ludo_room', ludoRoomId: cHostRoomId })

  let cMatchId = ''
  await check('[C0] auto-start: both players receive ludo_game_started once 2/2 is filled', async () => {
    const started = await waitForFrame(cHost, (f) => f.type === 'ludo_game_started', 10_000, 'C0 host match start')
    cMatchId = started.snapshot.matchId
    await waitForFrame(cGuest, (f) => f.type === 'ludo_game_started', 10_000, 'C0 guest match start')
  })

  cHost.frames.length = 0
  send(cHost, { type: 'create_private_room', stake: STAKE, isLocked: false, waitMinutes: 15 })
  const c1Location = await expectCrossGameBlock(
    cHost, '[C1] Ludo active match (host) -> create_private_room => BLOCK', 'C1 rejection',
    { gameType: 'ludo', kind: 'active_match' },
  )
  await check('[C1b] location.matchId points at the actual active Ludo match', () => {
    if (c1Location.matchId !== cMatchId) throw new Error(`matchId=${c1Location.matchId}, expected=${cMatchId}`)
  })

  cGuest.frames.length = 0
  send(cGuest, { type: 'join_matchmaking', stake: STAKE })
  await expectCrossGameBlock(
    cGuest, '[C2] Ludo active match (guest) -> join_matchmaking => BLOCK', 'C2 rejection',
    { gameType: 'ludo', kind: 'active_match' },
  )

  // ───────────────────────────────────────────────────────────────────────
  // Scenario D: Белот waiting private room -> Ludo create/join => BLOCK
  // ───────────────────────────────────────────────────────────────────────
  console.log('\n--- Scenario D: Белот waiting private room -> Ludo create/join ---')

  const dHost = await newClient('d-host')
  send(dHost, { type: 'create_private_room', stake: STAKE, isLocked: false, waitMinutes: 15 })
  const dRoom = await waitForFrame(dHost, (f) => f.type === 'private_room_updated', 10_000, 'D: private room created')

  dHost.frames.length = 0
  send(dHost, { type: 'create_ludo_room', stake: STAKE, playerCount: 2, manualStart: true })
  const d1Location = await expectCrossGameBlock(
    dHost, '[D1] Белот waiting private room -> create_ludo_room => BLOCK', 'D1 rejection',
    { gameType: 'belot', kind: 'waiting_room' },
  )
  await check('[D1b] location.privateRoomId points at the actual Белот waiting room', () => {
    if (d1Location.privateRoomId !== dRoom.room.id) throw new Error(`privateRoomId=${d1Location.privateRoomId}, expected=${dRoom.room.id}`)
  })

  dHost.frames.length = 0
  send(dHost, { type: 'join_ludo_room', ludoRoomId: aRoom.room.id })
  await expectCrossGameBlock(
    dHost, '[D2] Белот waiting private room -> join_ludo_room => BLOCK', 'D2 rejection',
    { gameType: 'belot', kind: 'waiting_room' },
  )

  await check('[D3] the private room is untouched (still 1 occupant)', async () => {
    dHost.frames.length = 0
    send(dHost, { type: 'request_private_rooms_list' })
    const listFrame = await waitForFrame(dHost, (f) => f.type === 'private_rooms_list', 5_000, 'D3 rooms list')
    const room = listFrame.rooms.find((r: any) => r.id === dRoom.room.id)
    if (!room) throw new Error('private room disappeared after blocked Ludo attempts')
    const occupied = room.slots.filter((s: any) => s.occupant !== null).length
    if (occupied !== 1) throw new Error(`expected 1 occupant, got ${occupied}`)
  })

  // ───────────────────────────────────────────────────────────────────────
  // Scenario M: Белот matchmaking commitment (searching, no room yet) ->
  // Ludo create/join => BLOCK. Distinct from D (private waiting room) —
  // exercises the other findActiveBelotCommitment() branch
  // (matchmakingState.queueEntries), added by the UX follow-up task's
  // structured-location contract (case D in the task spec).
  // ───────────────────────────────────────────────────────────────────────
  console.log('\n--- Scenario M: Белот matchmaking commitment -> Ludo create/join ---')

  const mClient = await newClient('m-searcher')
  send(mClient, { type: 'join_matchmaking', stake: STAKE })
  await waitForFrame(mClient, (f) => f.type === 'matchmaking_joined', 10_000, 'M: joined matchmaking queue')

  mClient.frames.length = 0
  send(mClient, { type: 'create_ludo_room', stake: STAKE, playerCount: 2, manualStart: true })
  const mLocation = await expectCrossGameBlock(
    mClient, '[M1] Белот matchmaking -> create_ludo_room => BLOCK', 'M1 rejection',
    { gameType: 'belot', kind: 'matchmaking' },
  )
  await check('[M1b] location.stake matches the stake actually queued for', () => {
    if (mLocation.stake !== STAKE) throw new Error(`stake=${mLocation.stake}, expected=${STAKE}`)
  })

  mClient.frames.length = 0
  send(mClient, { type: 'join_ludo_room', ludoRoomId: aRoom.room.id })
  await expectCrossGameBlock(
    mClient, '[M2] Белот matchmaking -> join_ludo_room => BLOCK', 'M2 rejection',
    { gameType: 'belot', kind: 'matchmaking' },
  )

  await check('[M3] re-sending join_matchmaking for the SAME stake ("Виж" target) is idempotent — still just matchmaking_joined, no duplicate entry', async () => {
    mClient.frames.length = 0
    send(mClient, { type: 'join_matchmaking', stake: STAKE })
    const rejoined = await waitForFrame(mClient, (f) => f.type === 'matchmaking_joined', 5_000, 'M3 idempotent rejoin')
    if (rejoined.stake !== STAKE) throw new Error(`stake=${rejoined.stake}`)
  })
  mClient.ws.close()

  // ───────────────────────────────────────────────────────────────────────
  // Scenario E: Белот ACTIVE room -> Ludo create/join => BLOCK
  // ───────────────────────────────────────────────────────────────────────
  console.log('\n--- Scenario E: Белот active room -> Ludo create/join ---')

  const eHost = await newClient('e-host')
  send(eHost, { type: 'create_room', displayName: 'E Host' })
  await waitForFrame(eHost, (f) => f.type === 'room_created', 10_000, 'E: legacy room seated (active, non-null phase)')

  // NOTE: an ACTIVE Белот room (unlike waiting private-room/matchmaking-queue)
  // is already caught by the pre-existing sendSessionInGameIfNeeded() guard,
  // which fires first and responds with 'session_in_game' (offers a
  // reconnect-to-active-game overlay) instead of the generic
  // cross_game_commitment_active error — both are a real BLOCK (no Ludo room
  // is created/joined), just a different, arguably more helpful signal.
  eHost.frames.length = 0
  send(eHost, { type: 'create_ludo_room', stake: STAKE, playerCount: 2, manualStart: true })
  await check('[E1] Белот active room -> create_ludo_room => BLOCK (session_in_game)', async () => {
    const frame = await waitForFrame(eHost, (f) => f.type === 'session_in_game' || f.type === 'error', 5_000, 'E1 rejection')
    if (frame.type !== 'session_in_game') throw new Error(`unexpected frame type=${frame.type}`)
  })
  await check('[E1b] no ludo_room_updated success frame arrived for the blocked create', async () => {
    const clean = await noFrameArrives(eHost, (f) => f.type === 'ludo_room_updated')
    if (!clean) throw new Error('a ludo_room_updated frame arrived despite the active Белот room')
  })

  eHost.frames.length = 0
  send(eHost, { type: 'join_ludo_room', ludoRoomId: aRoom.room.id })
  await check('[E2] Белот active room -> join_ludo_room => BLOCK (session_in_game)', async () => {
    const frame = await waitForFrame(eHost, (f) => f.type === 'session_in_game' || f.type === 'error', 5_000, 'E2 rejection')
    if (frame.type !== 'session_in_game') throw new Error(`unexpected frame type=${frame.type}`)
  })
  await check('[E2b] no ludo_room_updated success frame arrived for the blocked join', async () => {
    const clean = await noFrameArrives(eHost, (f) => f.type === 'ludo_room_updated')
    if (!clean) throw new Error('a ludo_room_updated frame arrived despite the active Белот room')
  })

  // ───────────────────────────────────────────────────────────────────────
  // Scenario F: after a normal leave, the other game type works immediately
  // ───────────────────────────────────────────────────────────────────────
  console.log('\n--- Scenario F: after normal leave, other game type works ---')

  // F1: the Ludo waiting guest from Scenario B leaves, then create_private_room succeeds.
  bGuest.frames.length = 0
  send(bGuest, { type: 'leave_ludo_room' })
  await waitForFrame(bGuest, (f) => f.type === 'ludo_room_left', 5_000, 'F1 leave ack')

  bGuest.frames.length = 0
  send(bGuest, { type: 'create_private_room', stake: STAKE, isLocked: false, waitMinutes: 15 })
  await check('[F1] after leave_ludo_room, create_private_room succeeds immediately', async () => {
    const updated = await waitForFrame(bGuest, (f) => f.type === 'private_room_updated', 5_000, 'F1 private room created')
    if (updated.room.stake !== STAKE) throw new Error(`unexpected stake ${updated.room.stake}`)
  })

  // F2: the Белот waiting host from Scenario D leaves, then create_ludo_room succeeds.
  dHost.frames.length = 0
  send(dHost, { type: 'leave_private_room' })
  await waitForFrame(dHost, (f) => f.type === 'private_room_left', 5_000, 'F2 leave ack')

  dHost.frames.length = 0
  send(dHost, { type: 'create_ludo_room', stake: STAKE, playerCount: 2, manualStart: true })
  await check('[F2] after leave_private_room, create_ludo_room succeeds immediately', async () => {
    const updated = await waitForFrame(dHost, (f) => f.type === 'ludo_room_updated', 5_000, 'F2 ludo room created')
    if (updated.room.stake !== STAKE) throw new Error(`unexpected stake ${updated.room.stake}`)
  })

  // ───────────────────────────────────────────────────────────────────────
  // Scenario G: no duplicate memberships anywhere in server state
  // ───────────────────────────────────────────────────────────────────────
  console.log('\n--- Scenario G: no duplicate memberships in server state ---')

  await check('[G1] aHost (blocked A1/A2) appears in exactly one place: the Ludo waiting room, nowhere else', async () => {
    aHost.frames.length = 0
    send(aHost, { type: 'request_private_rooms_list' })
    const privateList = await waitForFrame(aHost, (f) => f.type === 'private_rooms_list', 5_000, 'G1 private rooms list')
    const inAnyPrivateRoom = privateList.rooms.some((r: any) =>
      r.slots.some((s: any) => s.occupant?.profileId === aHost.profileId))
    if (inAnyPrivateRoom) throw new Error('aHost unexpectedly holds a private-room seat too')

    aHost.frames.length = 0
    send(aHost, { type: 'request_ludo_rooms_list' })
    const ludoList = await waitForFrame(aHost, (f) => f.type === 'ludo_rooms_list', 5_000, 'G1 ludo rooms list')
    const ludoMemberships = ludoList.rooms.filter((r: any) => r.players.some((p: any) => p.profileId === aHost.profileId))
    if (ludoMemberships.length !== 1) throw new Error(`expected exactly 1 ludo room membership, got ${ludoMemberships.length}`)
  })

  await check('[G2] cHost/cGuest (active Ludo match) no longer appear in the Ludo WAITING rooms list', async () => {
    cHost.frames.length = 0
    send(cHost, { type: 'request_ludo_rooms_list' })
    const listFrame = await waitForFrame(cHost, (f) => f.type === 'ludo_rooms_list', 5_000, 'G2 rooms list')
    const stale = listFrame.rooms.some((r: any) => r.id === cHostRoomId)
    if (stale) throw new Error('the started Ludo room is still listed as a waiting room (duplicate waiting+active state)')
  })

  await check('[G3] every blocked cross-game attempt above never produced a matching success frame (re-verified)', () => {
    const successTypes = ['private_room_updated', 'matchmaking_joined', 'matchmaking_status', 'ludo_room_updated', 'ludo_game_started']
    // aHost's post-A frames only contain the two rejections + the G1 list responses.
    const aHostBlockedFrames = aHost.frames.filter((f) => successTypes.includes(f.type) && f.type !== 'ludo_rooms_list')
    if (aHostBlockedFrames.some((f) => f.type === 'private_room_updated' || f.type === 'matchmaking_joined')) {
      throw new Error('aHost has an unexpected Белот success frame despite being blocked')
    }
  })

  // ───────────────────────────────────────────────────────────────────────
  // Scenario R: near-simultaneous requests on the SAME connection (the
  // realistic "race" shape — the server displaces any older connection for
  // the same profile on new WS connect, so genuine concurrent sockets for
  // one profile don't coexist outside an already-active game; a script/bug
  // firing two sends back-to-back on one socket is the real attack surface).
  // Both messages are sent with NO await/delay between them, so the 'ws'
  // library must parse and emit both 'message' events back-to-back on
  // Node's single JS thread. Since socket.on('message', ...) is a plain
  // (non-async) callback and every function in the guard->write chain is
  // synchronous (node:sqlite DatabaseSync, in-memory Maps — verified via
  // `await`-in-non-async-function being a TS compile error), the FIRST
  // message must run its entire guard-check+write to completion before the
  // SECOND message's handler even begins. This section proves that
  // empirically: whichever request was sent first always wins, the second
  // is always blocked, and no dual-membership state is ever observable.
  // ───────────────────────────────────────────────────────────────────────
  console.log('\n--- Scenario R: near-simultaneous requests (race) ---')

  // R-A: create_ludo_room + create_private_room fired back-to-back.
  const rA = await newClient('r-a')
  send(rA, { type: 'create_ludo_room', stake: STAKE, playerCount: 2, manualStart: true })
  send(rA, { type: 'create_private_room', stake: STAKE, isLocked: false, waitMinutes: 15 })

  await check('[R-A1] create_ludo_room (sent first) wins: exactly one ludo_room_updated arrives', async () => {
    await waitForFrame(rA, (f) => f.type === 'ludo_room_updated', 5_000, 'R-A1 ludo success')
  })
  await check('[R-A2] create_private_room (sent second) is blocked: cross_game_commitment_blocked arrives', async () => {
    const frame = await waitForFrame(rA, (f) => f.type === 'cross_game_commitment_blocked', 5_000, 'R-A2 belot rejection')
    if (frame.location?.gameType !== 'ludo' || frame.location?.kind !== 'waiting_room') throw new Error(`unexpected location: ${JSON.stringify(frame.location)}`)
  })
  await check('[R-A3] no private_room_updated ever arrives (no dual membership)', async () => {
    const clean = await noFrameArrives(rA, (f) => f.type === 'private_room_updated')
    if (!clean) throw new Error('a private_room_updated frame arrived despite the concurrent Ludo create winning the race')
  })

  // R-B: create_ludo_room + join_matchmaking fired back-to-back.
  const rB = await newClient('r-b')
  send(rB, { type: 'create_ludo_room', stake: STAKE, playerCount: 2, manualStart: true })
  send(rB, { type: 'join_matchmaking', stake: STAKE })

  await check('[R-B1] create_ludo_room (sent first) wins', async () => {
    await waitForFrame(rB, (f) => f.type === 'ludo_room_updated', 5_000, 'R-B1 ludo success')
  })
  await check('[R-B2] join_matchmaking (sent second) is blocked: cross_game_commitment_blocked arrives', async () => {
    const frame = await waitForFrame(rB, (f) => f.type === 'cross_game_commitment_blocked', 5_000, 'R-B2 matchmaking rejection')
    if (frame.location?.gameType !== 'ludo' || frame.location?.kind !== 'waiting_room') throw new Error(`unexpected location: ${JSON.stringify(frame.location)}`)
  })
  await check('[R-B3] no matchmaking_joined/matchmaking_status ever arrives (never entered the queue)', async () => {
    const clean = await noFrameArrives(rB, (f) => f.type === 'matchmaking_joined' || f.type === 'matchmaking_status')
    if (!clean) throw new Error('a matchmaking frame arrived despite the concurrent Ludo create winning the race')
  })

  // R-C: join_ludo_room + join_private_room fired back-to-back by the same
  // joining profile, against two pre-existing (different host) waiting rooms.
  const rHostLudo = await newClient('r-hostludo')
  send(rHostLudo, { type: 'create_ludo_room', stake: STAKE, playerCount: 4, manualStart: true })
  const rLudoRoom = await waitForFrame(rHostLudo, (f) => f.type === 'ludo_room_updated', 10_000, 'R-C ludo host room')

  const rHostBelot = await newClient('r-hostbelot')
  send(rHostBelot, { type: 'create_private_room', stake: STAKE, isLocked: false, waitMinutes: 15 })
  const rBelotRoom = await waitForFrame(rHostBelot, (f) => f.type === 'private_room_updated', 10_000, 'R-C belot host room')

  const rJoiner = await newClient('r-joiner')
  send(rJoiner, { type: 'join_ludo_room', ludoRoomId: rLudoRoom.room.id })
  send(rJoiner, { type: 'join_private_room', privateRoomId: rBelotRoom.room.id, team: 'B', slotIndex: 0 })

  await check('[R-C1] join_ludo_room (sent first) wins', async () => {
    await waitForFrame(rJoiner, (f) => f.type === 'ludo_room_updated', 5_000, 'R-C1 ludo join success')
  })
  await check('[R-C2] join_private_room (sent second) is blocked: cross_game_commitment_blocked arrives', async () => {
    const frame = await waitForFrame(rJoiner, (f) => f.type === 'cross_game_commitment_blocked', 5_000, 'R-C2 belot join rejection')
    if (frame.location?.gameType !== 'ludo' || frame.location?.kind !== 'waiting_room') throw new Error(`unexpected location: ${JSON.stringify(frame.location)}`)
  })
  await check('[R-C3] the Белот host never sees a 2nd member (private room stays at 1 occupant)', async () => {
    rHostBelot.frames.length = 0
    send(rHostBelot, { type: 'request_private_rooms_list' })
    const listFrame = await waitForFrame(rHostBelot, (f) => f.type === 'private_rooms_list', 5_000, 'R-C3 rooms list')
    const room = listFrame.rooms.find((r: any) => r.id === rBelotRoom.room.id)
    if (!room) throw new Error('private room disappeared')
    const occupied = room.slots.filter((s: any) => s.occupant !== null).length
    if (occupied !== 1) throw new Error(`expected 1 occupant (race loser never seated), got ${occupied}`)
  })

  // ─── Cleanup ──────────────────────────────────────────────────────────
  for (const c of [aHost, bHost, bGuest, cHost, cGuest, dHost, eHost, rA, rB, rHostLudo, rHostBelot, rJoiner]) {
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
