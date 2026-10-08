/**
 * checkPrivateRoomReactionTimeWebSocket.ts
 *
 * Целеви real spawned-server / real WebSocket integration тест за "Време за
 * реакция" при частна маса. Сървърът е изолиран (temp копие на src/dist +
 * temp SQLite DB) — същият модел и helper-и като
 * checkPrivateRoomWebSocketRoundTrip.ts (email-код регистрация с известен
 * тестов secret върху изолираната DB; без production акаунти/база).
 *
 * Веригата: create_private_room JSON по жицата -> parser -> privateRoomsStore
 * -> private_room_updated / private_rooms_list -> старт на мача ->
 * authoritative state -> room_snapshot -> реално поемане от бот от tick loop-а.
 *
 * Покрива:
 *  [1] 5000 / 10000 / 15000 и legacy payload без полето (-> 15000):
 *      стойността в private_room_updated, в private_rooms_list (вижда я
 *      и присъединяващият се), във всеки room_snapshot на мача; първият
 *      snapshot на човешки ход има deadline - serverNow ≈ избраното време;
 *      ботът поема този seat ≈ точно в deadline-а (не по-рано).
 *  [2] невалидна стойност (20000) -> маса НЕ се създава.
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
const TEST_REGISTRATION_SECRET = 'private-room-reaction-time-registration-secret-0123456789'
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
  const root = await mkdtemp(join(tmpdir(), 'belot-private-room-reaction-ws-'))
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
    email: `private-room-reaction-${tag}-${runId}@example.test`,
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

function activeSeatOf(game: any): string | null {
  if (game?.authoritativePhase === 'cutting') return game.cutting?.selectedCutIndex === null ? game.cutting?.cutterSeat ?? null : null
  if (game?.authoritativePhase === 'bidding') return game.bidding?.currentBidderSeat ?? null
  if (game?.authoritativePhase === 'playing') return game.playing?.currentTurnSeat ?? null
  return null
}

function seatOf(frame: any, seat: string): any {
  return frame.seats.find((s: any) => s.seat === seat) ?? null
}

// Регистрацията brute-force-ва кода СИНХРОННО (блокира event loop-а на
// теста) — затова всички клиенти се регистрират последователно ПРЕДИ
// паралелните сценарии, иначе таймаутите на един сценарий изтичат, докато
// друг се регистрира.
async function connectScenarioClients(port: number, label: string): Promise<{ host: TestClient; guest: TestClient }> {
  const tag = label.replace(/[^A-Za-z0-9]/g, '').slice(0, 8)
  const host = await connectClient(port, `${tag}Host`)
  const guest = await connectClient(port, `${tag}Guest`)
  setWalletBalance(host.profileId, 1_000_000)
  setWalletBalance(guest.profileId, 1_000_000)
  return { host, guest }
}

async function runScenario(
  clients: { host: TestClient; guest: TestClient },
  label: string,
  createExtra: Record<string, unknown>,
  expectedMs: number,
): Promise<string> {
  const { host, guest } = clients

  send(host, { type: 'create_private_room', stake: 5000, isLocked: false, ...createExtra })
  const created = await waitForFrame(host, (f) => f.type === 'private_room_updated', 10_000, `${label}: create ack`)
  if (created.room.humanTurnTimeoutMs !== expectedMs) {
    throw new Error(`private_room_updated.humanTurnTimeoutMs=${created.room.humanTurnTimeoutMs}, expected ${expectedMs}`)
  }
  const roomId: string = created.room.id
  const listed = await waitForFrame(
    guest,
    (f) => f.type === 'private_rooms_list' && f.rooms.some((r: any) => r.id === roomId),
    10_000,
    `${label}: guest sees room in list`,
  )
  const listedRoom = listed.rooms.find((r: any) => r.id === roomId)
  if (listedRoom.humanTurnTimeoutMs !== expectedMs) {
    throw new Error(`private_rooms_list.humanTurnTimeoutMs=${listedRoom.humanTurnTimeoutMs} (joiner view), expected ${expectedMs}`)
  }

  send(host, { type: 'add_bot_to_private_room_team', team: 'A' })
  await waitForFrame(host, (f) => f.type === 'private_room_updated' && occupiedCount(f.room) === 2, 10_000, `${label}: bot A`)
  send(guest, { type: 'join_private_room', privateRoomId: roomId, team: 'B', slotIndex: 0 })
  await waitForFrame(guest, (f) => f.type === 'private_room_updated' && occupiedCount(f.room) === 3, 10_000, `${label}: guest joined`)
  send(guest, { type: 'add_bot_to_private_room_team', team: 'B' })

  // Първият човешки ход. Максималното deadline - serverNow сред snapshot-ите
  // със същия deadline е broadcast-ът в момента на стартиране на таймера.
  const humanTurn = await waitForFrame(
    host,
    (f) => {
      if (f.type !== 'room_snapshot' || !f.game || f.isPrivateTableOrigin !== true) return false
      const seat = activeSeatOf(f.game)
      if (seat === null || f.game.timerDeadlineAt === null) return false
      const seatSnapshot = seatOf(f, seat)
      return seatSnapshot !== null && seatSnapshot.isBot === false && seatSnapshot.isControlledByBot === false
    },
    60_000,
    `${label}: first human turn`,
  )
  const turnSeat = activeSeatOf(humanTurn.game) as string
  const deadline: number = humanTurn.game.timerDeadlineAt
  const gameRoomId: string = humanTurn.roomId
  const sameDeadlineFrames = host.frames.filter(
    (f) => f.type === 'room_snapshot' && f.roomId === gameRoomId && f.game?.timerDeadlineAt === deadline,
  )
  const turnLengthMs = Math.max(...sameDeadlineFrames.map((f) => deadline - f.game.serverNow))
  if (turnLengthMs < expectedMs - 300 || turnLengthMs > expectedMs + 50) {
    throw new Error(`human turn length ${turnLengthMs}ms (deadline - serverNow), expected ≈${expectedMs}`)
  }

  // Никой не играе -> сървърът поема seat-а при deadline-а, не по-рано.
  const takeover = await waitForFrame(
    host,
    (f) => f.type === 'room_snapshot' && f.roomId === gameRoomId && seatOf(f, turnSeat)?.isControlledByBot === true,
    expectedMs + 10_000,
    `${label}: bot takeover`,
  )
  const takeoverLagMs = takeover.game.serverNow - deadline
  if (takeoverLagMs < 0 || takeoverLagMs > 700) {
    throw new Error(`bot took over ${takeoverLagMs}ms relative to the deadline (expected 0..700ms)`)
  }

  // Наддаване: първият човешки ход в bidding (гостът още не е поет).
  const biddingTurn = await measureHumanTurn(host, gameRoomId, 'bidding', expectedMs + 120_000, `${label}: bidding human turn`)
  assertTurnLength(biddingTurn.lengthMs, expectedMs, false, `${label} bidding`)

  // Игра: щом започне playing, хостът натиска "Върни се" (resume_human_control
  // по жицата) -> следващият му ход трябва пак да е пълният избран период.
  await waitForFrame(
    host,
    (f) => f.type === 'room_snapshot' && f.roomId === gameRoomId && f.game?.authoritativePhase === 'playing',
    expectedMs * 12 + 120_000,
    `${label}: playing phase`,
  )
  send(host, { type: 'resume_human_control', roomId: gameRoomId })
  const playingTurn = await measureHumanTurn(host, gameRoomId, 'playing', expectedMs * 4 + 60_000, `${label}: playing human turn`)
  assertTurnLength(playingTurn.lengthMs, expectedMs, true, `${label} playing`)

  const gameSnapshots = host.frames.filter((f) => f.type === 'room_snapshot' && f.roomId === gameRoomId && f.game)
  const wrong = gameSnapshots.filter((f) => f.game.humanTurnTimeoutMs !== expectedMs)
  if (wrong.length > 0) {
    throw new Error(`${wrong.length}/${gameSnapshots.length} room_snapshot frames carry humanTurnTimeoutMs=${wrong[0].game.humanTurnTimeoutMs}`)
  }

  host.ws.close()
  guest.ws.close()
  return `${label}: room=${created.room.humanTurnTimeoutMs} list=${listedRoom.humanTurnTimeoutMs} snapshots=${gameSnapshots.length}x${expectedMs}; ${humanTurn.game.authoritativePhase}/${turnSeat}=${turnLengthMs}ms (bot takeover +${takeoverLagMs}ms); bidding/${biddingTurn.seat}=${biddingTurn.lengthMs}ms; playing after resume/${playingTurn.seat}=${playingTurn.lengthMs}ms`
}

// Човешки ход (seat не е бот и не е поет) в дадената фаза; дължина =
// max(deadline - serverNow) сред snapshot-ите със същия deadline.
async function measureHumanTurn(
  client: TestClient,
  gameRoomId: string,
  phase: 'bidding' | 'playing',
  timeoutMs: number,
  label: string,
): Promise<{ seat: string; lengthMs: number }> {
  const frame = await waitForFrame(
    client,
    (f) => {
      if (f.type !== 'room_snapshot' || f.roomId !== gameRoomId || f.game?.authoritativePhase !== phase) return false
      const seat = activeSeatOf(f.game)
      if (seat === null || f.game.timerDeadlineAt === null) return false
      const seatSnapshot = seatOf(f, seat)
      return seatSnapshot !== null && seatSnapshot.isBot === false && seatSnapshot.isControlledByBot === false
    },
    timeoutMs,
    label,
  )
  const deadline: number = frame.game.timerDeadlineAt
  // Изчакваме кратко, за да хванем всички broadcast-и със същия deadline.
  await sleep(300)
  const lengths = client.frames
    .filter((f) => f.type === 'room_snapshot' && f.roomId === gameRoomId && f.game?.timerDeadlineAt === deadline)
    .map((f) => deadline - f.game.serverNow)
  return { seat: activeSeatOf(frame.game) as string, lengthMs: Math.max(...lengths) }
}

// В игра победителят във взятка започва хода си след анимацията за
// събиране (+1325ms) — тогава deadline - serverNow = избраното + 1325.
function assertTurnLength(lengthMs: number, expectedMs: number, allowTrickOffset: boolean, label: string): void {
  const ok =
    Math.abs(lengthMs - expectedMs) <= 300 ||
    (allowTrickOffset && Math.abs(lengthMs - (expectedMs + 1325)) <= 300)
  if (!ok) throw new Error(`${label}: human turn length ${lengthMs}ms, expected ≈${expectedMs}`)
}

console.log('\ncheckPrivateRoomReactionTimeWebSocket\n')

let server: RunningServer | null = null
const isolated = await createIsolatedServerRoot(sourceServerRoot)
testDatabaseFile = join(isolated.serverDir, 'database', 'data', 'belot-v2.sqlite')
const summaries: string[] = []

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

  // Масите вървят паралелно, за да не се чака 5+10+15+15 сек последователно.
  const scenarios: Array<[string, Record<string, unknown>, number]> = [
    ['5s', { waitMinutes: 5, humanTurnTimeoutMs: 5000 }, 5000],
    ['10s', { waitMinutes: 5, humanTurnTimeoutMs: 10000 }, 10000],
    ['15s', { waitMinutes: 5, humanTurnTimeoutMs: 15000 }, 15000],
    ['legacy-no-field', {}, 15000],
  ]
  const scenarioClients: Array<{ host: TestClient; guest: TestClient }> = []
  for (const [label] of scenarios) scenarioClients.push(await connectScenarioClients(port, label))
  await Promise.all(
    scenarios.map(([label, extra, expectedMs], index) =>
      check(`[1] ${label}: value survives payload -> store -> list -> match -> every snapshot -> server takeover at ${expectedMs}ms`, async () => {
        summaries.push(await runScenario(scenarioClients[index], label, extra, expectedMs))
      }),
    ),
  )

  await check('[2] invalid humanTurnTimeoutMs=20000 -> no private room is created', async () => {
    const client = await connectClient(port, 'invalid')
    setWalletBalance(client.profileId, 1_000_000)
    send(client, { type: 'create_private_room', stake: 5000, isLocked: false, waitMinutes: 5, humanTurnTimeoutMs: 20000 })
    await sleep(2500)
    if (framesOfType(client, 'private_room_updated').length > 0) throw new Error('a private room was created for an invalid value')
    const errors = framesOfType(client, 'error').map((f) => f.message)
    summaries.push(`invalid 20000: no room created; error frames: ${JSON.stringify(errors)}`)
    client.ws.close()
  })
} finally {
  await stopServer(server)
  await isolated.cleanup()
}

console.log('\n── measurements ──')
for (const line of summaries.sort()) console.log(`  ${line}`)
console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
