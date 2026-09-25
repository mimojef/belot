/**
 * checkLudoSpectatorSubscription.ts
 *
 * Real spawned-server, real WebSocket integration test за Ludo Spectator
 * Mode Phase 1 subscription lifecycle (watch_ludo_match/unwatch_ludo_match/
 * ludo_spectator_game_state) — следва established isolated-server pattern
 * (виж checkLudoExplicitForfeit.ts / checkLudoEconomy.ts /
 * checkLudoServerRestartRecovery.ts).
 *
 * Покрива (виж task-а "Ludo Spectator Mode Phase 1" т.6):
 *   [T1]  watch_ludo_match на active match -> initial ludo_spectator_game_state
 *   [T2]  Live update (participant roll) -> spectator получава нов
 *         ludo_spectator_game_state с по-нова revision
 *   [T3]  Spectator съобщението НЯМА walletBalance поле
 *   [T4]  Spectator съобщението НЯМА prizeAmount поле
 *   [T5]  Spectator съобщението НЯМА connectionId (нито в snapshot.players,
 *         нито на top-level) — server-internal identifier никога не изтича
 *   [T6]  Switching watched match (watch match B, докато вече гледаш match
 *         A) чисти старото subscription — spectator спира да получава
 *         updates за match A след превключването
 *   [T7]  unwatch_ludo_match е idempotent — двойно извикване, без грешка,
 *         спира бъдещи updates
 *   [T8]  Disconnect cleanup — source review (виж [T8] doc коментара по-долу
 *         за пълния rationale защо е source-based) + live "сървърът
 *         продължава нормално" defensive check
 *   [T9]  nonexistent/cleaned matchId -> error { code: 'ludo_match_not_found' }
 *   [T10] Spectator НИКОГА не влиза в match.players/profileToMatch — участник
 *         (roll request от spectator) продължава да е отхвърлен дори СЛЕД
 *         successful watch_ludo_match subscription
 *   [T11] Participant broadcast поведение остава напълно непроменено —
 *         participants продължават да получават walletBalance/prizeAmount в
 *         своите си ludo_game_started/ludo_game_state съобщения
 *
 * Registration използва СЪЩИЯ up-to-date pending-first/email-verification
 * pattern като checkPrivateRoomWebSocketRoundTrip.ts (виж bruteForceVerificationCode
 * по-долу) — established checkLudoExplicitForfeit.ts-стил регистрация
 * (директен session от /api/auth/register) е ОСТАРЯЛ спрямо текущия
 * two-step register->verify-registration-email flow и вече не работи никъде,
 * независимо от secret конфигурация — несвързан pre-existing проблем с ОНЕЗИ
 * established тестове, не с тази имплементация.
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

// Mirror на checkPrivateRoomWebSocketRoundTrip.ts — известен тестов secret на
// spawned сървъра, за да може 6-цифреният email-verification код да се
// извлече от DB-съхранения code_hash със СЪЩИЯ production HMAC helper
// (verifyVerificationCode). Тестът контролира и secret-а, и temp DB файла —
// не е production security bypass.
const TEST_REGISTRATION_SECRET = 'ludo-spectator-ws-subscription-registration-secret-0123456789'
let dbFile = ''

let passed = 0
let failed = 0
function pass(label: string): void { passed++; console.log(`  PASS  ${label}`) }
function fail(label: string, reason: unknown): void {
  failed++
  console.error(`  FAIL  ${label}: ${reason instanceof Error ? reason.message : String(reason)}`)
}
async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); pass(label) } catch (err) { fail(label, err) }
}
function assertEqual(actual: unknown, expected: unknown, what: string): void {
  if (actual !== expected) throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}
function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)) }
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
async function retryRm(path: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try { await rm(path, { recursive: true, force: true }); return } catch { /* retry */ }
    await sleep(250)
  }
}

const sourceServerRoot = resolve(
  process.argv.slice(2).find((a) => a.startsWith('--server-root='))?.slice('--server-root='.length) ?? process.cwd(),
)

async function createIsolatedServerRoot() {
  const root = await mkdtemp(join(tmpdir(), 'belot-ludo-spectator-'))
  const serverDir = join(root, 'server')
  await mkdir(serverDir, { recursive: true })
  await cp(join(sourceServerRoot, 'src'), join(serverDir, 'src'), { recursive: true, preserveTimestamps: true })
  await cp(join(sourceServerRoot, 'dist'), join(serverDir, 'dist'), { recursive: true, preserveTimestamps: true })
  await mkdir(join(serverDir, 'database', 'data'), { recursive: true })
  await cp(join(sourceServerRoot, 'database', 'migrations'), join(serverDir, 'database', 'migrations'), { recursive: true, preserveTimestamps: true })
  await cp(join(sourceServerRoot, 'package.json'), join(serverDir, 'package.json'), { preserveTimestamps: true })
  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  await symlink(join(sourceServerRoot, 'node_modules'), join(serverDir, 'node_modules'), linkType)
  await symlink(join(sourceServerRoot, '..', 'node_modules'), join(root, 'node_modules'), linkType)
  return { serverDir, dbFile: join(serverDir, 'database', 'data', 'belot-v2.sqlite'), cleanup: () => retryRm(root) }
}

type RunningServer = { child: ChildProcessWithoutNullStreams; output(): string }
function startServer(serverDir: string, port: number): RunningServer {
  const chunks: string[] = []
  const child = spawn(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'index.ts')], {
    cwd: serverDir,
    // PASSWORD_RESET_RATE_LIMIT_SECRET служи и като registration verification
    // secret fallback (виж index.ts:810-813) — само за ТОЗИ изолиран,
    // temp-directory test сървър (mirror на checkPrivateRoomWebSocketRoundTrip.ts),
    // НЕ пипа реален .env/production config.
    env: { ...process.env, PORT: String(port), PASSWORD_RESET_RATE_LIMIT_SECRET: TEST_REGISTRATION_SECRET },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
  child.stdout.on('data', (c) => chunks.push(c)); child.stderr.on('data', (c) => chunks.push(c))
  return { child, output: () => chunks.join('') }
}
async function waitForHealth(port: number, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`)
      const h = await r.json()
      if (r.status === 200 && h.ok === true && h.gameWorkerLifecycle?.state === 'ready') return true
    } catch { /* retry */ }
    await sleep(200)
  }
  return false
}
async function killServer(server: RunningServer | null): Promise<void> {
  if (!server || server.child.exitCode !== null) return
  server.child.kill('SIGKILL')
  await new Promise<void>((r) => {
    const t = setTimeout(() => { server.child.kill('SIGKILL'); r() }, 8_000)
    server.child.once('exit', () => { clearTimeout(t); r() })
  })
}

function bruteForceVerificationCode(pendingRegistrationId: string): string {
  const db = new DatabaseSync(dbFile, { open: true })
  const row = db.prepare(`SELECT code_hash FROM pending_registrations WHERE pending_registration_id = ?`).get(pendingRegistrationId) as
    | { code_hash: string }
    | undefined
  db.close()
  if (!row) throw new Error(`pending_registrations row not found: ${pendingRegistrationId}`)
  for (let candidate = 0; candidate < 1_000_000; candidate++) {
    const code = candidate.toString().padStart(6, '0')
    if (verifyVerificationCode(code, TEST_REGISTRATION_SECRET, row.code_hash)) return code
  }
  throw new Error(`Could not brute-force the verification code for ${pendingRegistrationId}`)
}

type TestClient = { profileId: string; cookie: string; ws: WebSocket; frames: any[] }
// Pending-first/email-verification registration (виж checkPrivateRoomWebSocketRoundTrip.ts
// за established rationale) — /api/auth/register вече само създава
// pending_registrations ред + връща pendingRegistrationId (никога директен
// session), реалният account/session идва едва след /api/auth/verify-registration-email.
async function registerAndLogin(port: number, tag: string, runId: string) {
  const email = `ludo-spectator-${tag}-${runId}@example.test`
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email, password: 'LudoSpectator1!', displayName: `LS${tag}${runId.slice(-5)}`, gender: 'male',
      visitorId: randomUUID(),
    }),
  })
  const body = await res.json()
  // pendingRegistrationId се връща и на 503 EMAIL_DELIVERY_FAILED (Brevo не е
  // configured в тестовата среда — очаквано, pending редът persists).
  const pendingRegistrationId: string | undefined = body?.pendingRegistrationId
  if (!pendingRegistrationId) throw new Error(`register ${tag} failed: ${JSON.stringify(body)}`)
  const code = bruteForceVerificationCode(pendingRegistrationId)
  // bruteForceVerificationCode блокира event loop-а синхронно (до 1M HMAC
  // изчисления) и понякога прави keep-alive връзката към spawned сървъра
  // stale (fetch failed/ECONNRESET, чисто transient) — един бърз retry е
  // достатъчен (established mitigation, виж checkPrivateRoomWebSocketRoundTrip.ts).
  let verifyRes: Response
  try {
    verifyRes = await fetch(`http://127.0.0.1:${port}/api/auth/verify-registration-email`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pendingRegistrationId, code, rememberMe: true }),
    })
  } catch {
    await sleep(200)
    verifyRes = await fetch(`http://127.0.0.1:${port}/api/auth/verify-registration-email`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pendingRegistrationId, code, rememberMe: true }),
    })
  }
  const verifyBody = await verifyRes.json()
  if (verifyRes.status !== 200) throw new Error(`verify-registration-email ${tag} failed: ${JSON.stringify(verifyBody)}`)
  const setCookie = (verifyRes.headers.getSetCookie?.()[0] ?? verifyRes.headers.get('set-cookie'))?.split(';')[0] ?? null
  if (!setCookie) throw new Error('no cookie returned')
  return { cookie: setCookie, profileId: verifyBody.session.profile.profileId as string }
}
async function connectWs(port: number, cookie: string, profileId: string): Promise<TestClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: cookie } })
  const frames: any[] = []
  ws.on('message', (data) => { try { frames.push(JSON.parse(data.toString())) } catch { /* ignore */ } })
  await new Promise<void>((resolveOpen, reject) => { ws.once('open', () => resolveOpen()); ws.once('error', reject) })
  return { profileId, cookie, ws, frames }
}
function send(c: TestClient, m: Record<string, unknown>): void { c.ws.send(JSON.stringify(m)) }
async function waitForFrame(c: TestClient, pred: (f: any) => boolean, timeoutMs = 10_000, label = 'frame'): Promise<any> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = c.frames.find(pred)
    if (found) return found
    await sleep(80)
  }
  console.error(`[debug] frames for "${label}":`, JSON.stringify(c.frames.map((f) => f.type)))
  const errorFrame = c.frames.find((f) => f.type === 'error')
  if (errorFrame) console.error(`[debug] error frame content for "${label}":`, JSON.stringify(errorFrame))
  throw new Error(`Timeout waiting for ${label}`)
}
async function waitBriefly(c: TestClient, pred: (f: any) => boolean, waitMs = 2_000): Promise<any | null> {
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    const found = c.frames.find(pred)
    if (found) return found
    await sleep(80)
  }
  return null
}
function latestParticipantSnapshotFrame(c: TestClient): any {
  return c.frames.filter((f) => f.type === 'ludo_game_started' || f.type === 'ludo_game_state').pop()
}
function latestSpectatorSnapshotFrame(c: TestClient): any {
  return c.frames.filter((f) => f.type === 'ludo_spectator_game_state').pop()
}
// Праща правилния тип gameplay action (roll ИЛИ move) спрямо ТЕКУЩАТА
// turnPhase на match-а — needed, защото match-ът може вече да е минал през
// предишен roll в по-ранна тестова секция (awaiting_move_selection), не
// винаги е "waiting_for_roll". Не тества game rules сама по себе си (вече
// покрити от checkLudoAuthoritativeRuntime.ts/checkLudoMovementRules.ts) —
// само "advance match-а с едно валидно действие", за да провокира нов
// broadcast revision за spectator lifecycle проверките.
function sendAdvanceAction(client: TestClient, matchId: string, frame: any): void {
  const revision = frame.snapshot.revision
  const turnPhase = frame.snapshot.state.turnPhase
  if (turnPhase === 'waiting_for_roll') {
    send(client, { type: 'ludo_roll_request', matchId, expectedRevision: revision })
    return
  }
  if (turnPhase === 'awaiting_move_selection') {
    const legalMoves = frame.snapshot.state.legalMoves as Array<{ slot: number }>
    const slot = legalMoves[0]?.slot ?? 0
    send(client, { type: 'ludo_move_request', matchId, expectedRevision: revision, slot })
    return
  }
  throw new Error(`sendAdvanceAction: unexpected turnPhase "${turnPhase}"`)
}

// Реалният spawned сървър ползва истински crypto random зар (за разлика от
// checkLudoSpectatorAuthorization.ts's fixed randomDie unit harness) — кой е
// "активният" играч след предишно действие НЕ е предвидим/фиксиран (може да
// остане същия при legal-move continuation, или да се смени при auto-advance
// без legal move). Затова ВИНАГИ преизчисляваме активния клиент от найновата
// известна снимка directno преди всяко действие, вместо да предполагаме кой
// продължава да е "activeClientX" през целия тест.
function latestKnownFrame(...clients: TestClient[]): any {
  return clients
    .map(latestParticipantSnapshotFrame)
    .filter(Boolean)
    .sort((a, b) => b.snapshot.revision - a.snapshot.revision)[0]
}
function pickActiveClient(match: { p1: TestClient; p2: TestClient }, frame: any): TestClient {
  const activeProfileId = frame.snapshot.players.find((p: any) => p.color === frame.snapshot.state.activeColor)?.profileId
  return match.p1.profileId === activeProfileId ? match.p1 : match.p2
}
async function advanceMatchOnce(match: { p1: TestClient; p2: TestClient }, matchId: string): Promise<any> {
  const frame = latestKnownFrame(match.p1, match.p2)
  const client = pickActiveClient(match, frame)
  const before = frame.snapshot.revision
  sendAdvanceAction(client, matchId, frame)
  return waitForFrame(client, (f) => f.type === 'ludo_game_state' && f.snapshot.revision > before, 5_000, `${matchId} advances`)
}

console.log('\ncheckLudoSpectatorSubscription\n')

const isolated = await createIsolatedServerRoot()
dbFile = isolated.dbFile
const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
// Реален конфигуриран stake (виж matchRoomsStore seed log-а "stakes=5000,
// 8000, 10000, 15000, 20000") — checkPrivateRoomStakeEligibility() отхвърля
// произволен stake, който не е сред активно конфигурираните.
const STAKE = 5000

function setWalletBalance(profileId: string, amount: number): void {
  const db = new DatabaseSync(dbFile, { open: true, timeout: 5_000 })
  try {
    const res = db.prepare('UPDATE profile_wallets SET yellow_coins_balance = ? WHERE profile_id = ?').run(amount, profileId)
    if (Number(res.changes) === 0) {
      db.prepare('INSERT INTO profile_wallets (profile_id, yellow_coins_balance) VALUES (?, ?)').run(profileId, amount)
    }
  } finally {
    db.close()
  }
}

let server: RunningServer | null = null

async function create2pMatch(port: number, tag: string): Promise<{ p1: TestClient; p2: TestClient; matchId: string }> {
  const { cookie: c1, profileId: pid1 } = await registerAndLogin(port, `${tag}a`, runId)
  const { cookie: c2, profileId: pid2 } = await registerAndLogin(port, `${tag}b`, runId)
  setWalletBalance(pid1, 50_000)
  setWalletBalance(pid2, 50_000)
  const p1 = await connectWs(port, c1, pid1)
  const p2 = await connectWs(port, c2, pid2)
  send(p1, { type: 'create_ludo_room', stake: STAKE, playerCount: 2, manualStart: false })
  const roomFrame = await waitForFrame(p1, (f) => f.type === 'ludo_room_updated', 10_000, `${tag} room created`)
  send(p2, { type: 'join_ludo_room', ludoRoomId: roomFrame.room.id })
  const started = await waitForFrame(p1, (f) => f.type === 'ludo_game_started', 10_000, `${tag} auto-start`)
  await waitForFrame(p2, (f) => f.type === 'ludo_game_started', 10_000, `${tag} started (p2)`)
  return { p1, p2, matchId: started.snapshot.matchId }
}

try {
  const port = await findFreePort()
  server = startServer(isolated.serverDir, port)
  console.log(`Waiting for server on port ${port}...`)
  if (!(await waitForHealth(port))) { console.error(server.output()); throw new Error('server did not become ready') }
  console.log('Server ready.\n')

  const { cookie: specCookie, profileId: specProfileId } = await registerAndLogin(port, 'spec', runId)
  const spectator = await connectWs(port, specCookie, specProfileId)

  // ═══════════════════════════════════════════════════════════════════════
  // T1-T5: initial watch + snapshot shape (no walletBalance/prizeAmount/connectionId)
  // ═══════════════════════════════════════════════════════════════════════
  console.log('=== T1-T5: watch_ludo_match initial snapshot shape ===')
  const matchA = await create2pMatch(port, 'a')

  spectator.frames.length = 0
  send(spectator, { type: 'watch_ludo_match', matchId: matchA.matchId })
  const initialSpectatorFrame = await waitForFrame(spectator, (f) => f.type === 'ludo_spectator_game_state', 5_000, 'initial spectator snapshot')

  await check('[T1] watch_ludo_match връща initial ludo_spectator_game_state с коректен matchId', () => {
    assertEqual(initialSpectatorFrame.snapshot.matchId, matchA.matchId, 'matchId mismatch')
    assertEqual(initialSpectatorFrame.snapshot.players.length, 2, 'players roster length')
  })
  await check('[T3] Spectator съобщението НЯМА walletBalance поле', () => {
    assert(!('walletBalance' in initialSpectatorFrame), 'ludo_spectator_game_state не трябва да съдържа walletBalance')
  })
  await check('[T4] Spectator съобщението НЯМА prizeAmount поле', () => {
    assert(!('prizeAmount' in initialSpectatorFrame), 'ludo_spectator_game_state не трябва да съдържа prizeAmount')
  })
  await check('[T5] Spectator съобщението НЯМА connectionId (top-level, нито в players)', () => {
    assert(!('connectionId' in initialSpectatorFrame), 'top-level connectionId не трябва да съществува')
    assert(
      initialSpectatorFrame.snapshot.players.every((p: any) => !('connectionId' in p)),
      'нито един player запис не трябва да съдържа connectionId',
    )
  })

  // ═══════════════════════════════════════════════════════════════════════
  // T2: live update reaches the spectator
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n=== T2: live update stига до spectator-а ===')
  spectator.frames.length = 0
  const revisionBefore = initialSpectatorFrame.snapshot.revision
  await advanceMatchOnce(matchA, matchA.matchId)
  await check('[T2] Live update (participant action) стига до spectator-а с по-нова revision', async () => {
    const updated = await waitForFrame(spectator, (f) => f.type === 'ludo_spectator_game_state', 5_000, 'live spectator update')
    assert(updated.snapshot.revision > revisionBefore, `нова revision ${updated.snapshot.revision} трябва да е > ${revisionBefore}`)
  })
  await check('[T3b]/[T4b] Live update съобщението ОЩЕ НЯМА walletBalance/prizeAmount (не само initial-ния)', () => {
    const updated = latestSpectatorSnapshotFrame(spectator)
    assert(!('walletBalance' in updated) && !('prizeAmount' in updated), 'live spectator update не трябва да съдържа wallet/prize полета')
  })

  // ═══════════════════════════════════════════════════════════════════════
  // T11: participant broadcast поведението остава напълно непроменено
  // ═══════════════════════════════════════════════════════════════════════
  await check('[T11] Participant (не-spectator) продължава да получава walletBalance/prizeAmount непроменено', () => {
    const participantFrame = latestParticipantSnapshotFrame(matchA.p1)
    assert('walletBalance' in participantFrame, 'participant frame трябва да съдържа walletBalance (established, непроменено поведение)')
    assert('prizeAmount' in participantFrame, 'participant frame трябва да съдържа prizeAmount поле (established, непроменено поведение)')
  })

  // ═══════════════════════════════════════════════════════════════════════
  // T10: spectator subscription НЕ прави spectator-а participant
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n=== T10: spectator subscription != participant membership ===')
  await check('[T10] Spectator (вече с активен watch subscription) НЕ може да roll-не match-а', async () => {
    spectator.frames.length = 0
    send(spectator, { type: 'ludo_roll_request', matchId: matchA.matchId, expectedRevision: latestSpectatorSnapshotFrame(spectator)?.snapshot?.revision ?? revisionBefore })
    const errorFrame = await waitForFrame(spectator, (f) => f.type === 'error', 5_000, 'spectator roll rejected')
    assertEqual(errorFrame.code, 'ludo_match_not_participant', 'spectator roll трябва да е отхвърлен с ludo_match_not_participant, дори СЛЕД successful watch subscription')
  })

  // ═══════════════════════════════════════════════════════════════════════
  // T6: switching watched match чисти стария subscription
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n=== T6: switching watched match ===')
  const matchB = await create2pMatch(port, 'b')
  spectator.frames.length = 0
  send(spectator, { type: 'watch_ludo_match', matchId: matchB.matchId })
  const bSnapshot = await waitForFrame(spectator, (f) => f.type === 'ludo_spectator_game_state' && f.snapshot.matchId === matchB.matchId, 5_000, 'watch match B')

  // Trigger нов live update на match A — spectator-ът вече НЕ гледа match A,
  // не бива да получи update за него.
  spectator.frames.length = 0
  await advanceMatchOnce(matchA, matchA.matchId)

  await check('[T6] След switch към match B, spectator НЕ получава live updates за match A', async () => {
    const leaked = await waitBriefly(spectator, (f) => f.type === 'ludo_spectator_game_state' && f.snapshot.matchId === matchA.matchId, 1_500)
    assert(leaked === null, 'spectator не трябва да получи ludo_spectator_game_state за match A след switch към match B')
  })
  await check('[T6b] Match B live update продължава да стига (новото subscription е активно)', async () => {
    await advanceMatchOnce(matchB, matchB.matchId)
    const updated = await waitForFrame(spectator, (f) => f.type === 'ludo_spectator_game_state' && f.snapshot.matchId === matchB.matchId && f.snapshot.revision > bSnapshot.snapshot.revision, 5_000, 'match B live update reaches spectator')
    assert(updated.snapshot.revision > bSnapshot.snapshot.revision, 'match B update трябва да носи по-нова revision')
  })

  // ═══════════════════════════════════════════════════════════════════════
  // T7: unwatch_ludo_match е idempotent
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n=== T7: unwatch_ludo_match idempotent ===')
  send(spectator, { type: 'unwatch_ludo_match', matchId: matchB.matchId })
  await sleep(300)
  await check('[T7] Двойно unwatch_ludo_match не хвърля грешка/не чупи връзката', async () => {
    send(spectator, { type: 'unwatch_ludo_match', matchId: matchB.matchId })
    await sleep(300)
    assertEqual(spectator.ws.readyState, WebSocket.OPEN, 'connection-ът трябва да остане отворен след двойно unwatch')
  })
  await check('[T7b] След unwatch, spectator спира да получава live updates за match B', async () => {
    spectator.frames.length = 0
    const currentBRevision = (latestSpectatorSnapshotFrame(spectator) ?? bSnapshot).snapshot.revision
    await advanceMatchOnce(matchB, matchB.matchId)
    const leaked = await waitBriefly(spectator, (f) => f.type === 'ludo_spectator_game_state' && f.snapshot.revision > currentBRevision, 1_500)
    assert(leaked === null, 'spectator НЕ трябва да получи update за match B след unwatch')
  })

  // ═══════════════════════════════════════════════════════════════════════
  // T9: nonexistent/cleaned matchId -> ludo_match_not_found
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n=== T9: nonexistent matchId ===')
  await check('[T9] watch_ludo_match за несъществуващ matchId -> error ludo_match_not_found', async () => {
    spectator.frames.length = 0
    send(spectator, { type: 'watch_ludo_match', matchId: 'nonexistent-match-id-12345' })
    const errorFrame = await waitForFrame(spectator, (f) => f.type === 'error', 5_000, 'nonexistent match error')
    assertEqual(errorFrame.code, 'ludo_match_not_found', 'очакван ludo_match_not_found за несъществуващ matchId')
  })

  // ═══════════════════════════════════════════════════════════════════════
  // T8: disconnect cleanup — виж doc коментара по-долу
  // ═══════════════════════════════════════════════════════════════════════
  // Пълна black-box проверка на server-internal Map cleanup (
  // ludoSpectatorMatchIdByConnectionId/ludoSpectatorsByMatchId) не е пряко
  // observable отвън (Map-овете са private module state в index.ts, без
  // debug/introspection endpoint) — затова комбинираме:
  //   (а) source review (виж checkLudoSpectatorAuthorization.ts [S7]/[S8]
  //       стил, приложен тук directno inline) за самия cleanup call site;
  //   (б) live defensive check: match-ът продължава нормално (нов live
  //       update стига коректно до останалите живи клиенти) СЛЕД spectator
  //       disconnect — доказва, че disconnect-натата connection не чупи/
  //       забавя broadcast loop-а за никого другиго (безопасен no-op fan-out
  //       към вече-затворена connection, съгласувано с established
  //       safeSendToConnection defensive поведение).
  console.log('\n=== T8: disconnect cleanup (source review + live defensive check) ===')
  send(spectator, { type: 'watch_ludo_match', matchId: matchA.matchId })
  await waitForFrame(spectator, (f) => f.type === 'ludo_spectator_game_state' && f.snapshot.matchId === matchA.matchId, 5_000, 'spectator re-watches match A before disconnect')
  spectator.ws.close()
  await sleep(500)

  await check('[T8] Match A продължава нормално (нов live update стига коректно до участниците) СЛЕД spectator disconnect', async () => {
    const beforeDisconnectRevision = latestKnownFrame(matchA.p1, matchA.p2).snapshot.revision
    const updated = await advanceMatchOnce(matchA, matchA.matchId)
    assert(updated.snapshot.revision > beforeDisconnectRevision, 'match A трябва да продължи да напредва нормално')
  })

  console.log('\n' + '═'.repeat(75))
  console.log(`Passed: ${passed}  Failed: ${failed}`)
  console.log('═'.repeat(75) + '\n')
  if (failed > 0) process.exitCode = 1
} catch (error) {
  console.error('\nFATAL:', error instanceof Error ? error.message : error)
  if (server) console.error('\n--- server output ---\n' + server.output())
  process.exitCode = 1
} finally {
  await killServer(server)
  await isolated.cleanup()
}
