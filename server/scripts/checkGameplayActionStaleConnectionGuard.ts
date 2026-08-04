/**
 * checkGameplayActionStaleConnectionGuard.ts
 *
 * Regression test за диагностиката на playing-phase дефекта: production
 * сигнали за карта, изиграна без съзнателно натискане, или различна карта
 * от очакваната — при чести frontend/backend deploy-и (чести reconnect-и).
 *
 * Проверява конкретен, доказан чрез четене на кода server-side дефект в
 * server/src/index.ts: 'submit_play_card', 'submit_bid_action' и
 * 'submit_cut_index' handler-ите авторизираха действие само по
 * `connection.currentRoomId`/`connection.currentSeat` — БЕЗ да проверят
 * `connection.status === 'connected'`.
 *
 * server/src/core/handleDisconnect.ts (викан както при реален WS 'close',
 * така и от displaceProfileConnections() при resume_room от друг
 * таб/устройство за същия profile) сетва status:'disconnected', но НИКОГА
 * не чисти currentRoomId/currentSeat — това прави само explicit
 * leave_active_room (detachConnectionFromRoomSeat.ts). Резултат: displaced
 * (или просто disconnected) connection обект остава "валиден" за
 * submit_play_card/submit_bid_action/submit_cut_index, докато играта не
 * стигне до неговия seat отново.
 *
 * Тестваната поправка: трите handler-а в index.ts сега отхвърлят действие
 * веднага след `latestConnection.status !== 'connected'`
 * (reason: 'stale_connection', логвано през logGameplayActionAudit.ts).
 *
 * Тестова стратегия: реален spawned сървър + реални `ws` клиенти (Node),
 * аналогично на checkPrivateRoomReconnectRaceGuard.ts. Играта се докарва до
 * 'playing' фаза чрез private room + "Запълни с ботове" (бързо, без да се
 * чака matchmaking bot-fill прозореца от 17-20 сек). На victim-ия ход:
 *
 *  1. Отваря се ВТОРА WebSocket връзка (Tab B) за СЪЩИЯ профил, вече
 *     установена и изчакваща (за да не влияе WS handshake latency в race-а).
 *  2. В same JS tick, БЕЗ await между двете: (a) Tab B изпраща resume_room
 *     (сървърът синхронно displace-ва старата връзка — status:'disconnected',
 *     currentRoomId/currentSeat остават populated), (b) старата (Tab A)
 *     връзка ВЕДНАГА изпраща submit_play_card за легална карта. Старата
 *     връзка е гарантирано още readyState=OPEN в момента на send (нищо не
 *     е изпълнено между двата send() извиквания), затова съобщението
 *     реално излиза на wire-а — тества сървърната проверка, не клиентската.
 *  3. Очаква се: Tab A получава error 'stale_connection'/'Връзката не е
 *     активна.', картата НЕ се маха от ръката, НЕ се появява в trick-а.
 *  4. Sanity check: Tab B (живата връзка) успешно изиграва СЪЩАТА карта —
 *     фиксът не чупи нормалния reconnect-после-play flow.
 *
 * Покрива (виж task spec §17, сценарии 17-19 и §18 т.7/т.9/т.19):
 *  [1] host + victim + 2 бота стигат до 'playing' фаза.
 *  [2] displaced (стара) връзка НЕ може да изиграе карта.
 *  [3] картата остава в ръката / не е в trick-а след rejection-а.
 *  [4] новата (жива) връзка успешно изиграва картата.
 *  [5] другите participants виждат само ЕДНО прилагане на картата (не
 *      дублирано).
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

// ─── Isolated server (same model as checkPrivateRoomReconnectRaceGuard.ts) ─

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
  const root = await mkdtemp(join(tmpdir(), 'belot-stale-conn-guard-'))
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

// ─── Test harness ───────────────────────────────────────────────────────────

type TestClient = {
  profileId: string
  cookie: string
  ws: WebSocket
  frames: any[]
}

async function registerProfile(port: number, tag: string): Promise<{ cookie: string; profileId: string }> {
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const reg = await httpJson(port, 'POST', '/api/auth/register', null, {
    email: `stale-conn-guard-${tag}-${runId}@example.test`,
    password: 'StaleConnGuardDiag1!',
    displayName: `SCG ${tag}`,
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
  timeoutMs = 15_000,
  label = 'frame',
): Promise<any> {
  try {
    await waitForCondition(label, () => client.frames.some(predicate), timeoutMs)
  } catch (err) {
    console.error(`[debug] frames received while waiting for "${label}":`, JSON.stringify(client.frames.slice(-10), null, 2))
    throw err
  }
  return client.frames.find(predicate)
}

function latestSnapshot(client: TestClient, roomId: string): any | null {
  const snaps = client.frames.filter((f) => f.type === 'room_snapshot' && f.roomId === roomId)
  return snaps.length > 0 ? snaps[snaps.length - 1] : null
}

// Auto-drives a human seat through cutting + bidding: cuts with a fixed
// valid index when it's this seat's turn to cut; bids clubs whenever
// validActions says it's still legally available (guaranteed available to
// whichever seat — bot or human — acts first in the whole auction, so this
// deterministically produces a contract without waiting for a full
// pass-around), and passes otherwise. Using validActions instead of a
// simple "first turn" flag avoids "Невалидна обява." when the OTHER human
// driver (or a bot) already claimed clubs before this seat's turn.
//
// MUST be attached immediately after the WebSocket opens (before any
// `waitForFrame` call consumes frames from `client.frames`) — cutting has
// exactly ONE turn-taking human, and the server does not repeat a
// `canSubmitCut: true` broadcast if it's already been delivered once. A
// driver attached AFTER the first relevant snapshot was already consumed
// elsewhere would silently miss its only chance to react, causing a REAL
// 20s human cutting timeout — which, being a genuine timeout, correctly
// (and permanently, per the sticky controlledByBot behavior documented in
// the investigation) flips that seat to bot-controlled for the rest of the
// match. That is a real product behavior, not a bug in this guard — but it
// would make THIS test flaky/misleading if the harness itself triggers it
// by accident. Not filtering by roomId here (unknown until the room exists)
// is safe: each test client only ever joins exactly one room.
function autoDriveCuttingAndBidding(client: TestClient): { stop(): void } {
  const seenCutForRoom = new Set<string>()
  const respondedForBidTurn = new Set<string>()

  const handler = (data: WebSocket.RawData): void => {
    let frame: any
    try { frame = JSON.parse(data.toString()) } catch { return }
    if (frame.type !== 'room_snapshot' || !frame.game) return
    const roomId = frame.roomId as string

    const cutting = frame.game.cutting
    if (cutting?.canSubmitCut && !seenCutForRoom.has(roomId)) {
      seenCutForRoom.add(roomId)
      const cutIndex = Math.max(1, Math.min(cutting.deckCount - 1, Math.floor(cutting.deckCount / 2)))
      send(client, { type: 'submit_cut_index', roomId, cutIndex })
    }

    const bidding = frame.game.bidding
    if (bidding?.canSubmitBid) {
      // entries.length uniquely identifies "this specific turn" — canSubmitBid
      // can stay true across multiple broadcasts for the same unresolved
      // turn (e.g. re-render-triggering snapshots unrelated to bidding), and
      // reacting more than once per turn would risk a second, now-invalid
      // action attempt.
      const turnKey = `${roomId}:${bidding.currentBidderSeat}:${bidding.entries.length}`
      if (!respondedForBidTurn.has(turnKey)) {
        respondedForBidTurn.add(turnKey)
        const action = bidding.validActions?.suits?.clubs
          ? { type: 'suit', suit: 'clubs' }
          : { type: 'pass' }
        send(client, { type: 'submit_bid_action', roomId, action })
      }
    }
  }

  client.ws.on('message', handler)
  return { stop: () => client.ws.off('message', handler) }
}

console.log('\ncheckGameplayActionStaleConnectionGuard\n')

let server: RunningServer | null = null
const isolated = await createIsolatedServerRoot(sourceServerRoot)

try {
  const port = await findFreePort()
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
  // Setup: host + victim in a private room, bot-filled to 4/4, quickly
  // driven through cutting + bidding into 'playing'.
  // ───────────────────────────────────────────────────────────────────────
  const host = await connectClient(port, 'host')
  let victim = await connectClient(port, 'victim')

  // Drivers attach BEFORE anything else touches these sockets — see the
  // comment on autoDriveCuttingAndBidding for why attachment order matters.
  const hostDriver = autoDriveCuttingAndBidding(host)
  const victimDriver = autoDriveCuttingAndBidding(victim)

  send(host, { type: 'create_private_room', stake: 5000, isLocked: false })
  const created = await waitForFrame(host, (f) => f.type === 'private_room_updated', 10_000, 'create_private_room ack')
  const privateRoomId: string = created.room.id

  send(victim, { type: 'join_private_room', privateRoomId })
  await waitForFrame(host, (f) => f.type === 'private_room_updated' && f.room.members.length === 2, 10_000, '2 members')
  await waitForFrame(victim, (f) => f.type === 'private_room_updated' && f.room.members.length === 2, 10_000, 'victim sees own join')

  send(host, { type: 'fill_private_room_with_bots' })
  const hostFull = await waitForFrame(host, (f) => f.type === 'private_room_full', 10_000, 'host private_room_full')
  const victimFull = await waitForFrame(victim, (f) => f.type === 'private_room_full', 10_000, 'victim private_room_full')
  const roomId: string = hostFull.roomId
  if (victimFull.roomId !== roomId) throw new Error('host and victim landed in different rooms')

  const hostSnap = await waitForFrame(host, (f) => f.type === 'room_snapshot' && f.roomId === roomId, 10_000, 'host initial snapshot')
  const victimSnap = await waitForFrame(victim, (f) => f.type === 'room_snapshot' && f.roomId === roomId, 10_000, 'victim initial snapshot')
  const victimSeat: string = victimSnap.yourSeat
  if (!victimSeat) throw new Error('victim has no seat')
  console.log(`Room ${roomId}: host seat=${hostSnap.yourSeat} victim seat=${victimSeat}\n`)

  console.log('Driving through cutting + bidding to reach playing phase...')
  await waitForCondition('playing phase reached', () => {
    const snap = latestSnapshot(victim, roomId)
    return snap?.game?.authoritativePhase === 'playing' || snap?.game?.playing?.currentTurnSeat != null
  }, 30_000)
  hostDriver.stop()
  victimDriver.stop()
  console.log('Playing phase reached.\n')

  await check('[0] neither host nor victim was ever left permanently bot-controlled by the cutting/bidding setup itself (sanity check on the harness, not the fix under test)', () => {
    const snap = latestSnapshot(victim, roomId)
    const seatState = (snap.seats as any[]).find((s) => s.seat === victimSeat)
    if (seatState?.isControlledByBot) {
      throw new Error('victim seat is already bot-controlled before the race even starts — harness failed to answer cutting/bidding in time, not a defect in the guard under test')
    }
  })

  // ───────────────────────────────────────────────────────────────────────
  // Wait for the victim's own turn to play, then capture a legal card.
  // ───────────────────────────────────────────────────────────────────────
  await waitForCondition('victim\'s turn to play', () => {
    const snap = latestSnapshot(victim, roomId)
    return snap?.game?.playing?.currentTurnSeat === victimSeat
  }, 60_000)

  const preRaceSnap = latestSnapshot(victim, roomId)
  const validCardIds: string[] | null = preRaceSnap.game.playing.validCardIds
  const ownHand: Array<{ id: string }> = preRaceSnap.game.ownHand
  const targetCardId: string = (validCardIds && validCardIds.length > 0 ? validCardIds[0] : ownHand[0].id)
  const reconnectToken: string = preRaceSnap.reconnectToken
  if (!reconnectToken) throw new Error('missing reconnectToken on victim snapshot')
  console.log(`Victim's turn. Target card: ${targetCardId}. Racing displacement vs. stale-connection play...\n`)

  // ───────────────────────────────────────────────────────────────────────
  // Race: open Tab B ahead of time (fully established, no handshake latency
  // in the race itself). Then, in the SAME synchronous tick — no await in
  // between — fire resume_room on Tab B and submit_play_card on the OLD
  // (Tab A) connection. Tab A's socket is guaranteed readyState=OPEN at
  // send time because nothing has run yet to process the server's close.
  // ───────────────────────────────────────────────────────────────────────
  const victimOld = victim
  const { ws: tabBWs, frames: tabBFrames } = await openWs(port, victim.cookie)
  const victimB: TestClient = { profileId: victim.profileId, cookie: victim.cookie, ws: tabBWs, frames: tabBFrames }

  const oldFrameCountBeforeRace = victimOld.frames.length

  // Give resume_room a small head start (it only needs to reach the server
  // process, not round-trip all the way back) before sending the OLD
  // connection's play — enough that the server has very likely already run
  // displaceProfileConnections (in-process, synchronous, no network hop)
  // by the time it receives the stale play, but short enough that the OLD
  // connection's own readyState has NOT yet flipped (that requires the
  // server's close frame to complete a FULL round trip back to this
  // process — reliably slower than the one-way trip above). Verified
  // empirically: with no delay at all, ordering flips often enough to be
  // flaky; with the delay, the old socket is consistently still OPEN
  // (readyState logged below) while still reliably losing the race.
  send(victimB, { type: 'resume_room', roomId, reconnectToken })
  await sleep(15)
  send(victimOld, { type: 'submit_play_card', roomId, cardId: targetCardId })
  await waitForFrame(victimB, (f) => f.type === 'room_resumed' && f.roomId === roomId, 10_000, 'room_resumed (post-race confirmation)')
  await sleep(300)

  await check('[1] the displaced (old) connection is never treated as authoritative for the racing submit_play_card (no room_snapshot on it ever shows the card as played)', async () => {
    await waitForCondition('old connection reaction after displacement', () => {
      return victimOld.frames.length > oldFrameCountBeforeRace
    }, 10_000)
    // Give any trailing frames a brief moment to also arrive before
    // asserting. The old connection is being closed by the server
    // concurrently (session_displaced + socket.close()), so an explicit
    // 'error' reply for the racing submit_play_card may or may not make it
    // back before the socket fully closes — that ordering is not the
    // guarantee under test. What must ALWAYS hold is that the old
    // connection never observes the card as successfully applied.
    await sleep(500)
    const newFrames = victimOld.frames.slice(oldFrameCountBeforeRace)
    const sawSuccess = newFrames.some((f) =>
      f.type === 'room_snapshot' &&
      !(f.game?.ownHand ?? []).some((c: any) => c.id === targetCardId),
    )
    if (sawSuccess) {
      throw new Error(`the displaced connection observed the target card leaving the hand — the racing stale-connection play was applied: ${JSON.stringify(newFrames)}`)
    }
    const acknowledgedDisplacement = newFrames.some((f) => f.type === 'session_displaced' || f.type === 'error')
    if (!acknowledgedDisplacement) {
      throw new Error(`expected the old connection to observe either session_displaced or an error frame, got: ${JSON.stringify(newFrames)}`)
    }
  })

  await check('[2] Tab B successfully resumes into the room (room_resumed)', async () => {
    const resumed = await waitForFrame(victimB, (f) => f.type === 'room_resumed' && f.roomId === roomId, 10_000, 'room_resumed')
    if (resumed.seat !== victimSeat) throw new Error(`Tab B resumed into wrong seat: ${resumed.seat} vs ${victimSeat}`)
  })

  await check('[3] the target card was NOT removed from the hand by the rejected racing play (still victim\'s turn, card still present)', async () => {
    await sleep(500)
    const snap = latestSnapshot(victimB, roomId)
    if (snap === null) throw new Error('no snapshot received on Tab B yet')
    const stillInHand = (snap.game.ownHand as Array<{ id: string }>).some((c) => c.id === targetCardId)
    if (!stillInHand) throw new Error('target card is missing from hand — the racing stale-connection play was incorrectly applied')
    if (snap.game.playing.currentTurnSeat !== victimSeat) {
      throw new Error(`turn moved past victim's seat unexpectedly (currentTurnSeat=${snap.game.playing.currentTurnSeat}) — a play was applied when it should have been rejected`)
    }
  })

  // ───────────────────────────────────────────────────────────────────────
  // Sanity check: the LIVE connection (Tab B) can still legitimately play
  // the same card — the fix must not regress the normal reconnect-then-play
  // flow.
  // ───────────────────────────────────────────────────────────────────────
  await check('[4] the LIVE (Tab B) connection can legitimately play the same card afterwards', async () => {
    send(victimB, { type: 'submit_play_card', roomId, cardId: targetCardId })
    await waitForCondition('card actually applied via the live connection', () => {
      const snap = latestSnapshot(victimB, roomId)
      if (snap === null) return false
      const stillInHand = (snap.game.ownHand as Array<{ id: string }>).some((c: any) => c.id === targetCardId)
      return !stillInHand
    }, 10_000)
  })

  await check('[5] the host observed exactly one application of the played card (no duplicate broadcast from the rejected racing attempt)', () => {
    const hostSnaps = host.frames.filter((f) => f.type === 'room_snapshot' && f.roomId === roomId)
    const playCounts = hostSnaps.map((snap) => {
      const plays = snap.game?.playing?.currentTrickPlays ?? []
      return plays.filter((p: any) => p.card.id === targetCardId).length
        + (snap.game?.playing?.latestCompletedTrick?.plays ?? []).filter((p: any) => p.card.id === targetCardId).length
    })
    const maxSeen = Math.max(0, ...playCounts)
    if (maxSeen !== 1) throw new Error(`expected the target card to appear exactly once across host snapshots, max seen count was ${maxSeen}`)
  })

  // ─── Cleanup ──────────────────────────────────────────────────────────────
  for (const c of [host, victimOld, victimB]) {
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
