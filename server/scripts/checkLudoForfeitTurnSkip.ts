/**
 * checkLudoForfeitTurnSkip.ts
 *
 * Verification-only (not a bug-fix script) real spawned-server, real
 * WebSocket check for the exact 4-player scenario described in the task:
 *
 *   Player 1 -> Player 2 -> Player 3 -> Player 4  (canonical turnOrder)
 *   Player 3 explicitly leaves (non-active at the time).
 *   Expected turn order from then on: P1 -> P2 -> P4 -> P1 -> P2 -> P4 -> ...
 *   P3 must NEVER become activeColor again, at any point.
 *
 * Uses a deterministic randomDie()=2 injected into an ISOLATED COPY of
 * index.ts only (never the tracked source, same established pattern as
 * server/scripts/checkLudoEconomy.ts::patchIndexTsForDeterministicLudoWin) —
 * a non-6 roll always yields zero legal moves from the default all-home
 * start state, so every roll auto-completes the turn (turn_complete ->
 * TURN_ADVANCED) without needing any move action, letting this test drive
 * many turn cycles quickly and deterministically.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

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

const sourceServerRoot = resolve(
  process.argv.slice(2).find((a) => a.startsWith('--server-root='))?.slice('--server-root='.length) ?? process.cwd(),
)

async function createIsolatedServerRoot() {
  const root = await mkdtemp(join(tmpdir(), 'belot-ludo-turnskip-'))
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
  return { serverDir, cleanup: () => rm(root, { recursive: true, force: true }).catch(() => undefined) }
}

// TEST-ONLY injection into the ISOLATED COPY of index.ts (never the tracked
// server/src/index.ts) — deterministic non-6 die so every roll auto-advances
// the turn (no legal moves from the all-home start state).
async function patchIndexTsForDeterministicDie(serverDir: string): Promise<void> {
  const indexPath = join(serverDir, 'src', 'index.ts')
  const original = await readFile(indexPath, 'utf8')
  const needle = 'const ludoMatchRuntime = createLudoMatchRuntime({\n  onSnapshot: (snapshot) => {'
  if (!original.includes(needle)) throw new Error('patch anchor not found in index.ts')
  const injected = `const ludoMatchRuntime = createLudoMatchRuntime({
  // TEST-ONLY, isolated-copy-only injection — see checkLudoForfeitTurnSkip.ts.
  randomDie: () => 2 as any,
  onSnapshot: (snapshot) => {`
  await writeFile(indexPath, original.replace(needle, injected), 'utf8')
}

type RunningServer = { child: ChildProcessWithoutNullStreams; output(): string }
function startServer(serverDir: string, port: number): RunningServer {
  const chunks: string[] = []
  const child = spawn(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'index.ts')], {
    cwd: serverDir, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
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
      const h: any = await r.json()
      if (r.status === 200 && h.ok === true && h.gameWorkerLifecycle?.state === 'ready') return true
    } catch { /* retry */ }
    await sleep(200)
  }
  return false
}

type TestClient = { profileId: string; ws: WebSocket; frames: any[] }
async function registerAndLogin(port: number, tag: string, runId: string) {
  const email = `ludo-turnskip-${tag}-${runId}@example.test`
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'LudoTurnSkip1!', displayName: `LTS${tag}${runId.slice(-5)}`, gender: 'male' }),
  })
  const body: any = await res.json()
  if (res.status !== 200) throw new Error(`register ${tag} failed: ${JSON.stringify(body)}`)
  const setCookie = (res.headers.getSetCookie?.()[0] ?? res.headers.get('set-cookie'))?.split(';')[0] ?? null
  if (!setCookie) throw new Error('no cookie returned')
  return { cookie: setCookie as string, profileId: body.session.profile.profileId as string }
}
async function connectWs(port: number, cookie: string, profileId: string): Promise<TestClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: cookie } } as any)
  const frames: any[] = []
  ws.addEventListener('message', (event: any) => { try { frames.push(JSON.parse(event.data.toString())) } catch { /* ignore */ } })
  await new Promise<void>((resolveOpen, reject) => {
    ws.addEventListener('open', () => resolveOpen())
    ws.addEventListener('error', (e: any) => reject(e))
  })
  return { profileId, ws, frames }
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
function latestSnapshotFrame(c: TestClient): any {
  return c.frames.filter((f) => f.type === 'ludo_game_started' || f.type === 'ludo_game_state').pop()
}

console.log('\ncheckLudoForfeitTurnSkip\n')

const isolated = await createIsolatedServerRoot()
await patchIndexTsForDeterministicDie(isolated.serverDir)
const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const STAKE = 10_000

let server: RunningServer | null = null
try {
  const port = await findFreePort()
  server = startServer(isolated.serverDir, port)
  console.log(`Waiting for server on port ${port}...`)
  if (!(await waitForHealth(port))) { console.error(server.output()); throw new Error('server did not become ready') }
  console.log('Server ready.\n')

  const clients: TestClient[] = []
  for (const p of ['1', '2', '3', '4']) {
    const { cookie, profileId } = await registerAndLogin(port, `p${p}`, runId)
    clients.push(await connectWs(port, cookie, profileId))
  }
  const [P1, P2, P3, P4] = clients
  send(P1!, { type: 'create_ludo_room', stake: STAKE, playerCount: 4, manualStart: false })
  const roomFrame = await waitForFrame(P1!, (f) => f.type === 'ludo_room_updated', 10_000, 'room created')
  send(P2!, { type: 'join_ludo_room', ludoRoomId: roomFrame.room.id })
  await waitForFrame(P1!, (f) => f.type === 'ludo_room_updated' && f.room.players.length === 2, 5_000, '2/4')
  send(P3!, { type: 'join_ludo_room', ludoRoomId: roomFrame.room.id })
  await waitForFrame(P1!, (f) => f.type === 'ludo_room_updated' && f.room.players.length === 3, 5_000, '3/4')
  send(P4!, { type: 'join_ludo_room', ludoRoomId: roomFrame.room.id })
  const started = await waitForFrame(P1!, (f) => f.type === 'ludo_game_started', 10_000, '4/4 auto-start')
  for (const c of clients) await waitForFrame(c, (f) => f.type === 'ludo_game_started', 10_000, 'started (each)')
  const matchId: string = started.snapshot.matchId

  // Map canonical turnOrder position -> the actual test client, using
  // profileId, NOT an assumption about which color is red/blue/etc — the
  // task's "Player 1/2/3/4" numbering is about JOIN ORDER position in
  // turnOrder, whatever colors got assigned.
  const turnOrder: string[] = started.snapshot.state.turnOrder
  const colorToClient = new Map<string, TestClient>()
  for (const c of clients) {
    const color = started.snapshot.players.find((p: any) => p.profileId === c.profileId).color
    colorToClient.set(color, c)
  }
  const seatColors = turnOrder // [seat1Color, seat2Color, seat3Color, seat4Color]
  const [seat1, seat2, seat3, seat4] = seatColors
  const clientBySeat = [seat1, seat2, seat3, seat4].map((color) => colorToClient.get(color!)!)
  console.log(`turnOrder (seat1..seat4): ${seatColors.join(' -> ')}`)
  console.log(`activeColor at start: ${started.snapshot.state.activeColor}`)

  // Roll for whichever seat is currently active, advancing exactly one full
  // turn (deterministic die=2 -> zero legal moves from home -> auto turn_complete
  // -> TURN_ADVANCED happens server-side automatically inside applyRoll()).
  async function rollActiveSeatAndGetNextActiveColor(): Promise<string> {
    const before = latestSnapshotFrame(P1!)
    const activeColorBefore = before.snapshot.state.activeColor
    const activeClient = clientBySeat[seatColors.indexOf(activeColorBefore)]!
    const beforeRevision = before.snapshot.revision
    send(activeClient, { type: 'ludo_roll_request', matchId, expectedRevision: beforeRevision })
    const after = await waitForFrame(P1!, (f) => f.type === 'ludo_game_state' && f.snapshot.revision > beforeRevision, 5_000, 'turn advanced')
    return after.snapshot.state.activeColor
  }

  // Seat3 (Player 3) explicitly leaves WHILE NOT ACTIVE (activeColor is seat1
  // at match start, per default turn order) — mirrors the task's exact
  // scenario: P3 leaves, then P1 finishes their turn, then P2 finishes
  // theirs, and activeColor must jump straight to P4, skipping P3 forever.
  await check('[setup] activeColor at match start is seat1 (Player 1)', () => {
    assertEqual(started.snapshot.state.activeColor, seat1, 'activeColor at start')
  })

  const p3Client = clientBySeat[2]!
  send(p3Client, { type: 'leave_ludo_match', matchId })
  await waitForFrame(p3Client, (f) => f.type === 'ludo_match_left', 5_000, 'P3 leave ack')
  await waitForFrame(P1!, (f) => f.type === 'ludo_game_state' && f.snapshot.state.leftColors.includes(seat3), 5_000, 'others see P3 leftColors')

  await check('[after P3 leaves] activeColor is UNCHANGED (P3 was not active, P1 still active)', () => {
    const snap = latestSnapshotFrame(P1!)
    assertEqual(snap.snapshot.state.activeColor, seat1, 'activeColor right after non-active P3 leave')
  })

  // Now walk 6 full turn cycles and record the EXACT sequence of activeColor
  // values — must be seat1 -> seat2 -> seat4 -> seat1 -> seat2 -> seat4 ...
  // and seat3 must NEVER appear.
  const observedSequence: string[] = [started.snapshot.state.activeColor === seat1 ? seat1 : latestSnapshotFrame(P1!).snapshot.state.activeColor]
  for (let i = 0; i < 6; i++) {
    const next = await rollActiveSeatAndGetNextActiveColor()
    observedSequence.push(next)
  }
  console.log(`observed activeColor sequence: ${observedSequence.join(' -> ')}`)

  await check('[turn cycle] Player 3 (seat3) NEVER becomes activeColor again, across 6 full cycles', () => {
    if (observedSequence.includes(seat3!)) throw new Error(`seat3 (${seat3}) appeared in the active-color sequence: ${observedSequence.join(' -> ')}`)
  })
  await check('[turn cycle] sequence strictly follows seat1 -> seat2 -> seat4 -> seat1 -> ... (P3 skipped every cycle)', () => {
    const expectedCycle = [seat1, seat2, seat4]
    for (let i = 0; i < observedSequence.length; i++) {
      const expected = expectedCycle[i % 3]
      if (observedSequence[i] !== expected) {
        throw new Error(`position ${i}: expected ${expected}, got ${observedSequence[i]} — full sequence: ${observedSequence.join(' -> ')}`)
      }
    }
  })
  await check('[dice control] P3 never received a snapshot making them believe it is their turn (no post-leave broadcast at all)', () => {
    const gotAnyAfterLeave = p3Client.frames.some((f) => f.type === 'ludo_game_state')
    if (gotAnyAfterLeave) throw new Error('P3 unexpectedly received a post-leave ludo_game_state frame')
  })

  for (const c of clients) c.ws.close()

  console.log('\n' + '═'.repeat(72))
  console.log(`Passed: ${passed}  Failed: ${failed}`)
  if (failed > 0) process.exitCode = 1
} finally {
  if (server && server.child.exitCode === null) {
    server.child.kill('SIGKILL')
    await Promise.race([new Promise((r) => server!.child.once('exit', r)), sleep(3_000)])
  }
  await isolated.cleanup()
}
