/**
 * checkLudoSpectatorViewerMembership.ts
 *
 * Real spawned-server, real WebSocket integration test за Ludo Spectator
 * Mode viewer-indicator ("наднича във вашата игра") membership broadcast —
 * следва established isolated-server pattern (виж checkLudoSpectatorSubscription.ts
 * Phase 1 harness-а, reuse-нат почти verbatim тук).
 *
 * Покрива:
 *   [V1] Spectator watch -> ОБАТА participants получават ludo_match_spectators
 *        с точно 1 запис (profileId + displayName на spectator-а).
 *   [V2] Втора connection на СЪЩИЯ профил (multi-tab), гледаща СЪЩИЯ match ->
 *        participants виждат точно 1 запис (dedup по profileId, не connectionId).
 *   [V3] Първата от двете connections на профила disconnect-ва -> името
 *        ОСТАВА (втората connection все още гледа).
 *   [V4] Последната connection на профила unwatch-ва -> participants виждат
 *        празен списък (0 viewers).
 *   [V5] Spectator switch-ва към ДРУГ match -> старият match's participants
 *        виждат 0 viewers, новият match's participants виждат 1 viewer.
 *   [V6] Explicit unwatch_ludo_match ("Назад") -> participants получават
 *        обновен (без viewer-а) списък.
 *   [V7] Spectator-ът САМИЯТ НИКОГА не получава ludo_match_spectators
 *        съобщение (нито за match-а, който гледа, нито за друг).
 *   [V8] Двама РАЗЛИЧНИ spectators (различни профили), гледащи СЪЩИЯ match ->
 *        participants виждат и двете имена (2 записа).
 *
 * Registration използва СЪЩИЯ up-to-date pending-first/email-verification
 * pattern като checkLudoSpectatorSubscription.ts/checkPrivateRoomWebSocketRoundTrip.ts.
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

const TEST_REGISTRATION_SECRET = 'ludo-spectator-viewer-membership-registration-secret-0123456789'
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
function assertSameProfileIdSet(actual: string[], expected: string[], what: string): void {
  const a = [...actual].sort()
  const e = [...expected].sort()
  if (JSON.stringify(a) !== JSON.stringify(e)) throw new Error(`${what}: expected profileId set ${JSON.stringify(e)}, got ${JSON.stringify(a)}`)
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
  const root = await mkdtemp(join(tmpdir(), 'belot-ludo-spectator-viewers-'))
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
async function registerAndLogin(port: number, tag: string, runId: string): Promise<{ cookie: string; profileId: string }> {
  const email = `ludo-spec-viewers-${tag}-${runId}@example.test`
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email, password: 'LudoSpecViewers1!', displayName: `LSV${tag}${runId.slice(-5)}`, gender: 'male',
      visitorId: randomUUID(),
    }),
  })
  const body = await res.json()
  const pendingRegistrationId: string | undefined = body?.pendingRegistrationId
  if (!pendingRegistrationId) throw new Error(`register ${tag} failed: ${JSON.stringify(body)}`)
  const code = bruteForceVerificationCode(pendingRegistrationId)
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
  throw new Error(`Timeout waiting for ${label}`)
}
async function waitBriefly(c: TestClient, pred: (f: any) => boolean, waitMs = 1_500): Promise<any | null> {
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    const found = c.frames.find(pred)
    if (found) return found
    await sleep(80)
  }
  return null
}
function latestSpectatorsFrameFor(c: TestClient, matchId: string): any {
  return c.frames.filter((f) => f.type === 'ludo_match_spectators' && f.matchId === matchId).pop()
}

console.log('\ncheckLudoSpectatorViewerMembership\n')

const isolated = await createIsolatedServerRoot()
dbFile = isolated.dbFile
const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
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

  const matchA = await create2pMatch(port, 'a')
  const matchB = await create2pMatch(port, 'b')

  const { cookie: specCookie, profileId: specProfileId } = await registerAndLogin(port, 'spec', runId)
  const spectator = await connectWs(port, specCookie, specProfileId)

  // ═══════════════════════════════════════════════════════════════════════
  // V1: watch -> ОБАТА participants получават viewer entry
  // ═══════════════════════════════════════════════════════════════════════
  console.log('=== V1: watch -> participants виждат viewer-а ===')
  matchA.p1.frames.length = 0
  matchA.p2.frames.length = 0
  send(spectator, { type: 'watch_ludo_match', matchId: matchA.matchId })
  await waitForFrame(spectator, (f) => f.type === 'ludo_spectator_game_state', 5_000, 'initial spectator snapshot')

  await check('[V1] И двамата participants получават ludo_match_spectators с точно 1 запис (spectator-а)', async () => {
    const f1 = await waitForFrame(matchA.p1, (f) => f.type === 'ludo_match_spectators' && f.matchId === matchA.matchId, 5_000, 'p1 sees spectator')
    const f2 = await waitForFrame(matchA.p2, (f) => f.type === 'ludo_match_spectators' && f.matchId === matchA.matchId, 5_000, 'p2 sees spectator')
    assertEqual(f1.spectators.length, 1, 'p1 трябва да вижда точно 1 spectator')
    assertEqual(f2.spectators.length, 1, 'p2 трябва да вижда точно 1 spectator')
    assertEqual(f1.spectators[0].profileId, specProfileId, 'profileId трябва да съвпада')
    assert(typeof f1.spectators[0].displayName === 'string' && f1.spectators[0].displayName.length > 0, 'displayName трябва да е непразен string')
  })

  // ═══════════════════════════════════════════════════════════════════════
  // V2: multi-tab (втора connection, СЪЩИЯ профил) -> dedup
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n=== V2: multi-tab dedup ===')
  const spectatorTab2 = await connectWs(port, specCookie, specProfileId)
  matchA.p1.frames.length = 0
  send(spectatorTab2, { type: 'watch_ludo_match', matchId: matchA.matchId })
  await waitForFrame(spectatorTab2, (f) => f.type === 'ludo_spectator_game_state', 5_000, 'tab2 initial spectator snapshot')

  await check('[V2] Втора connection на СЪЩИЯ профил -> participants виждат ПАК точно 1 запис (dedup по profileId)', async () => {
    const f1 = await waitForFrame(matchA.p1, (f) => f.type === 'ludo_match_spectators' && f.matchId === matchA.matchId, 5_000, 'p1 sees dedup after tab2 watch')
    assertEqual(f1.spectators.length, 1, 'все още точно 1 уникален spectator (не 2)')
    assertEqual(f1.spectators[0].profileId, specProfileId, 'profileId трябва да е СЪЩИЯ')
  })

  // ═══════════════════════════════════════════════════════════════════════
  // V3: първата connection disconnect-ва -> името ОСТАВА (втората все още гледа)
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n=== V3: една connection disconnect-ва, другата остава ===')
  // Забележка: НЕ чистим matchA.p1.frames тук — dedup-ът по profileId
  // означава, че membership-ът реално не се променя (профилът все още
  // гледа през tab2), затова сървърът с право може да НЕ прати нов
  // broadcast. Проверяваме ПОСЛЕДНОТО известно състояние (от V2), което
  // трябва да остане валидно и след disconnect-а на първата connection.
  spectator.ws.close()
  await sleep(500)

  await check('[V3] Първа connection на профила disconnect-ва -> spectator-ът ОСТАВА видим (втора connection все още гледа)', async () => {
    // Best-effort: изчакваме малко за евентуален нов broadcast, после
    // проверяваме последното известно състояние (ново или от преди).
    await waitBriefly(matchA.p1, (f) => f.type === 'ludo_match_spectators' && f.matchId === matchA.matchId && f.spectators.length !== 1, 1_000)
    const latest = latestSpectatorsFrameFor(matchA.p1, matchA.matchId)
    assert(!!latest, 'трябва да съществува поне един ludo_match_spectators frame (от по-рано, V2)')
    assertEqual(latest.spectators.length, 1, 'spectator-ът трябва да остане точно 1 (профилът все още гледа през tab2)')
    assertEqual(latest.spectators[0].profileId, specProfileId, 'профилът трябва да е СЪЩИЯ')
  })

  // ═══════════════════════════════════════════════════════════════════════
  // V4: последната connection unwatch-ва -> 0 viewers
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n=== V4: последна connection unwatch -> 0 viewers ===')
  matchA.p1.frames.length = 0
  send(spectatorTab2, { type: 'unwatch_ludo_match', matchId: matchA.matchId })

  await check('[V4] Последната connection unwatch-ва -> participants виждат празен списък', async () => {
    const f1 = await waitForFrame(matchA.p1, (f) => f.type === 'ludo_match_spectators' && f.matchId === matchA.matchId, 5_000, 'p1 sees empty after last unwatch')
    assertEqual(f1.spectators.length, 0, 'списъкът трябва да е празен')
  })

  // ═══════════════════════════════════════════════════════════════════════
  // V5: switch между гледани мачове
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n=== V5: switch между гледани мачове ===')
  const spectator3 = await connectWs(port, specCookie, specProfileId)
  matchA.p1.frames.length = 0
  matchB.p1.frames.length = 0
  send(spectator3, { type: 'watch_ludo_match', matchId: matchA.matchId })
  await waitForFrame(spectator3, (f) => f.type === 'ludo_spectator_game_state' && f.snapshot.matchId === matchA.matchId, 5_000, 'spectator3 watches A')
  await waitForFrame(matchA.p1, (f) => f.type === 'ludo_match_spectators' && f.matchId === matchA.matchId && f.spectators.length === 1, 5_000, 'match A gains viewer')

  matchA.p1.frames.length = 0
  send(spectator3, { type: 'watch_ludo_match', matchId: matchB.matchId })
  await waitForFrame(spectator3, (f) => f.type === 'ludo_spectator_game_state' && f.snapshot.matchId === matchB.matchId, 5_000, 'spectator3 switches to B')

  await check('[V5a] След switch, match A participants виждат 0 viewers', async () => {
    const f1 = await waitForFrame(matchA.p1, (f) => f.type === 'ludo_match_spectators' && f.matchId === matchA.matchId && f.spectators.length === 0, 5_000, 'match A loses viewer after switch')
    assertEqual(f1.spectators.length, 0, 'match A трябва да остане без viewers')
  })
  await check('[V5b] Match B participants виждат новия viewer', async () => {
    const f1 = await waitForFrame(matchB.p1, (f) => f.type === 'ludo_match_spectators' && f.matchId === matchB.matchId && f.spectators.length === 1, 5_000, 'match B gains viewer')
    assertEqual(f1.spectators[0].profileId, specProfileId, 'match B трябва да вижда spectator3-ия профил')
  })

  // ═══════════════════════════════════════════════════════════════════════
  // V6: explicit unwatch ("Назад")
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n=== V6: explicit unwatch ("Назад") ===')
  matchB.p1.frames.length = 0
  send(spectator3, { type: 'unwatch_ludo_match', matchId: matchB.matchId })

  await check('[V6] Explicit unwatch -> match B participants виждат обновен (празен) списък', async () => {
    const f1 = await waitForFrame(matchB.p1, (f) => f.type === 'ludo_match_spectators' && f.matchId === matchB.matchId && f.spectators.length === 0, 5_000, 'match B empty after explicit unwatch')
    assertEqual(f1.spectators.length, 0, 'match B трябва да е без viewers')
  })

  // ═══════════════════════════════════════════════════════════════════════
  // V7: spectator-ът НИКОГА не получава ludo_match_spectators
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n=== V7: spectator никога не получава ludo_match_spectators ===')
  await check('[V7] Spectator connection-ите никога не получават ludo_match_spectators съобщение', () => {
    for (const c of [spectator, spectatorTab2, spectator3]) {
      const leaked = c.frames.find((f) => f.type === 'ludo_match_spectators')
      assert(!leaked, 'spectator connection не трябва никога да получи ludo_match_spectators')
    }
  })

  // ═══════════════════════════════════════════════════════════════════════
  // V8: двама различни spectators -> и двете имена видими
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n=== V8: двама различни spectators ===')
  const { cookie: spec2Cookie, profileId: spec2ProfileId } = await registerAndLogin(port, 'spec2', runId)
  const spectator4 = await connectWs(port, spec2Cookie, spec2ProfileId)
  matchB.p1.frames.length = 0
  send(spectator3, { type: 'watch_ludo_match', matchId: matchB.matchId })
  await waitForFrame(spectator3, (f) => f.type === 'ludo_spectator_game_state' && f.snapshot.matchId === matchB.matchId, 5_000, 'spectator3 re-watches B')
  await waitForFrame(matchB.p1, (f) => f.type === 'ludo_match_spectators' && f.matchId === matchB.matchId && f.spectators.length === 1, 5_000, 'match B has 1 viewer again')

  matchB.p1.frames.length = 0
  send(spectator4, { type: 'watch_ludo_match', matchId: matchB.matchId })
  await waitForFrame(spectator4, (f) => f.type === 'ludo_spectator_game_state' && f.snapshot.matchId === matchB.matchId, 5_000, 'spectator4 watches B')

  await check('[V8] Двама различни spectators на СЪЩИЯ match -> participants виждат и двете имена', async () => {
    const f1 = await waitForFrame(matchB.p1, (f) => f.type === 'ludo_match_spectators' && f.matchId === matchB.matchId && f.spectators.length === 2, 5_000, 'match B has 2 distinct viewers')
    assertSameProfileIdSet(
      f1.spectators.map((s: any) => s.profileId),
      [specProfileId, spec2ProfileId],
      'match B viewers трябва да са точно двата различни профила',
    )
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
