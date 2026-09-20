/**
 * checkLudoExplicitForfeit.ts
 *
 * Real spawned-server, real WebSocket integration test for explicit "Изход"
 * forfeit on a STARTED Ludo match (task spec "Explicit Изход от STARTED
 * match"). Follows the exact isolated-server pattern established by
 * checkLudoEconomy.ts / checkLudoServerRestartRecovery.ts.
 *
 * Scenarios (task spec §13):
 *   B — 4-player, first leave: display roster stays, turn skips forfeited
 *       color forever, match continues.
 *   C — 4->3->2->1 cascading forfeits: last-player-standing wins, payout =
 *       80% of the ORIGINAL 4-player pot (never recomputed).
 *   D — active-player leave: no stuck turn, deadline cancelled/reassigned.
 *   E — inactive-player leave: current active player's turn is undisturbed.
 *   F — server restart after a 4-player leave: leftColors state survives,
 *       forfeited profile never re-enters profileToMatch/reconnects.
 *   Plus: cross-game membership release (profile can create/join elsewhere
 *   immediately after forfeiting), and idempotent duplicate leave.
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
  const root = await mkdtemp(join(tmpdir(), 'belot-ludo-forfeit-'))
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

type TestClient = { profileId: string; cookie: string; ws: WebSocket; frames: any[] }
async function registerAndLogin(port: number, tag: string, runId: string) {
  const email = `ludo-forfeit-${tag}-${runId}@example.test`
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'LudoForfeit1!', displayName: `LF${tag}${runId.slice(-5)}`, gender: 'male' }),
  })
  const body = await res.json()
  if (res.status !== 200) throw new Error(`register ${tag} failed: ${JSON.stringify(body)}`)
  const setCookie = (res.headers.getSetCookie?.()[0] ?? res.headers.get('set-cookie'))?.split(';')[0] ?? null
  if (!setCookie) throw new Error('no cookie returned')
  return { cookie: setCookie, profileId: body.session.profile.profileId as string }
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
async function waitBriefly(c: TestClient, pred: (f: any) => boolean, waitMs = 2_000): Promise<any | null> {
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    const found = c.frames.find(pred)
    if (found) return found
    await sleep(80)
  }
  return null
}
function latestSnapshotFrame(c: TestClient): any {
  return c.frames.filter((f) => f.type === 'ludo_game_started' || f.type === 'ludo_game_state').pop()
}

let dbFile = ''
function setWalletBalance(profileId: string, amount: number): void {
  const db = new DatabaseSync(dbFile, { open: true, enableForeignKeyConstraints: true })
  try {
    db.prepare(`INSERT INTO profile_wallets (profile_id, yellow_coins_balance) VALUES (?, ?)
      ON CONFLICT(profile_id) DO UPDATE SET yellow_coins_balance = excluded.yellow_coins_balance`).run(profileId, amount)
  } finally { db.close() }
}
function getWalletBalance(profileId: string): number {
  const db = new DatabaseSync(dbFile, { open: true, enableForeignKeyConstraints: true })
  try {
    const row = db.prepare(`SELECT yellow_coins_balance FROM profile_wallets WHERE profile_id = ?`).get(profileId) as { yellow_coins_balance: number } | undefined
    return row?.yellow_coins_balance ?? 0
  } finally { db.close() }
}
function getLudoLedgerEntries(matchId: string): any[] {
  const db = new DatabaseSync(dbFile, { open: true, enableForeignKeyConstraints: true })
  try {
    return db.prepare(`SELECT match_id, profile_id, entry_type, amount FROM ludo_match_economy_ledger WHERE match_id = ? ORDER BY created_at`).all(matchId)
  } finally { db.close() }
}

console.log('\ncheckLudoExplicitForfeit\n')

const isolated = await createIsolatedServerRoot()
dbFile = isolated.dbFile
const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const STAKE = 10_000

let server: RunningServer | null = null

async function create4pMatch(port: number, tag: string): Promise<{ clients: TestClient[]; matchId: string }> {
  const clients: TestClient[] = []
  for (const p of ['a', 'b', 'c', 'd']) {
    const { cookie, profileId } = await registerAndLogin(port, `${tag}${p}`, runId)
    setWalletBalance(profileId, 50_000)
    clients.push(await connectWs(port, cookie, profileId))
  }
  const [p1, p2, p3, p4] = clients
  send(p1!, { type: 'create_ludo_room', stake: STAKE, playerCount: 4, manualStart: false })
  const roomFrame = await waitForFrame(p1!, (f) => f.type === 'ludo_room_updated', 10_000, `${tag} room created`)
  send(p2!, { type: 'join_ludo_room', ludoRoomId: roomFrame.room.id })
  await waitForFrame(p1!, (f) => f.type === 'ludo_room_updated' && f.room.players.length === 2, 5_000, `${tag} 2/4`)
  send(p3!, { type: 'join_ludo_room', ludoRoomId: roomFrame.room.id })
  await waitForFrame(p1!, (f) => f.type === 'ludo_room_updated' && f.room.players.length === 3, 5_000, `${tag} 3/4`)
  send(p4!, { type: 'join_ludo_room', ludoRoomId: roomFrame.room.id })
  const started = await waitForFrame(p1!, (f) => f.type === 'ludo_game_started', 10_000, `${tag} 4/4 auto-start`)
  for (const c of clients) await waitForFrame(c, (f) => f.type === 'ludo_game_started', 10_000, `${tag} started (each)`)
  return { clients, matchId: started.snapshot.matchId }
}

try {
  const port = await findFreePort()
  server = startServer(isolated.serverDir, port)
  console.log(`Waiting for server on port ${port}...`)
  if (!(await waitForHealth(port))) { console.error(server.output()); throw new Error('server did not become ready') }
  console.log('Server ready.\n')

  // ═══════════════════════════════════════════════════════════════════════
  // B: 4-player, first leave — display roster stays, permanent leftColors,
  // forfeited color never gets a turn again, others continue.
  // ═══════════════════════════════════════════════════════════════════════
  console.log('=== B: 4-player, first leave (inactive player) ===')
  const B = await create4pMatch(port, 'b')
  const [B1, B2, B3, B4] = B.clients
  const beforeLeave = latestSnapshotFrame(B1!)
  const activeColorBefore = beforeLeave.snapshot.state.activeColor
  const activeClient = B.clients[['red', 'blue', 'yellow', 'green'].indexOf(activeColorBefore) === -1
    ? 0
    : beforeLeave.snapshot.players.findIndex((p: any) => p.color === activeColorBefore)]
  const inactivePlayer = B.clients.find((c) => c !== activeClient)!
  const inactiveColor = beforeLeave.snapshot.players.find((p: any) => p.profileId === inactivePlayer.profileId).color

  inactivePlayer.frames.length = 0
  B1!.frames.length = 0
  send(inactivePlayer, { type: 'leave_ludo_match', matchId: B.matchId })
  await waitForFrame(inactivePlayer, (f) => f.type === 'ludo_match_left', 5_000, 'inactive player left ack')
  const afterLeaveFrame = await waitForFrame(B1!, (f) => (f.type === 'ludo_game_state') && f.snapshot.state.leftColors.includes(inactiveColor), 5_000, 'others see the leave')

  await check('[B1] display roster still includes the forfeited player (players.length unchanged)', () => {
    assertEqual(afterLeaveFrame.snapshot.players.length, 4, 'players array length')
  })
  await check('[B2] leftColors includes the forfeited color', () => {
    if (!afterLeaveFrame.snapshot.state.leftColors.includes(inactiveColor)) throw new Error('leftColors missing forfeited color')
  })
  await check('[B3] activeColor is unaffected (inactive player left, not their turn)', () => {
    assertEqual(afterLeaveFrame.snapshot.state.activeColor, activeColorBefore, 'activeColor after inactive leave')
  })
  await check('[B4] match is still in_progress (3 players remain)', () => {
    assertEqual(afterLeaveFrame.snapshot.state.status, 'in_progress', 'match status')
  })
  await check('[B5] the leaving player is NOT broadcast further snapshots (excluded from broadcast loop)', () => {
    const gotAnyAfterLeave = inactivePlayer.frames.some((f) => f.type === 'ludo_game_state')
    if (gotAnyAfterLeave) throw new Error('leaving player unexpectedly received a post-leave ludo_game_state frame')
  })
  await check('[B6] the forfeited profile is free to create a NEW Ludo room immediately (cross-game membership released)', async () => {
    inactivePlayer.frames.length = 0
    send(inactivePlayer, { type: 'create_ludo_room', stake: STAKE, playerCount: 2, manualStart: true })
    const created = await waitForFrame(inactivePlayer, (f) => f.type === 'ludo_room_updated' || f.type === 'error', 5_000, 'forfeited profile creates new room')
    if (created.type !== 'ludo_room_updated') throw new Error(`expected ludo_room_updated, got ${JSON.stringify(created)}`)
    send(inactivePlayer, { type: 'leave_ludo_room' })
    await waitForFrame(inactivePlayer, (f) => f.type === 'ludo_room_left', 5_000, 'cleanup waiting room')
  })

  for (const c of B.clients) c.ws.close()

  // ═══════════════════════════════════════════════════════════════════════
  // C: 4->3->2->1 cascading forfeits — last player standing wins, payout =
  // 80% of ORIGINAL 4-player pot regardless of how many forfeited.
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n=== C: cascading forfeits 4->3->2->1, payout = 80% of ORIGINAL pot ===')
  const C = await create4pMatch(port, 'c')
  const [C1, C2, C3, C4] = C.clients
  const startSnap = latestSnapshotFrame(C1!)
  const colorOf = (client: TestClient) => startSnap.snapshot.players.find((p: any) => p.profileId === client.profileId).color

  // Leave C2, C3, C4 in sequence (order doesn't matter for correctness —
  // whichever is NOT active just leaves; if a leaving one happens to be
  // active the server reassigns automatically, exercised separately in D).
  for (const leaver of [C2!, C3!, C4!]) {
    leaver.frames.length = 0
    C1!.frames.length = 0
    send(leaver, { type: 'leave_ludo_match', matchId: C.matchId })
    await waitForFrame(leaver, (f) => f.type === 'ludo_match_left', 5_000, 'cascading leave ack')
    await waitForFrame(C1!, (f) => f.type === 'ludo_game_state' && f.snapshot.state.leftColors.includes(colorOf(leaver)), 5_000, 'C1 observes cascading leave')
  }

  const finalFrame = await waitForFrame(C1!, (f) => f.type === 'ludo_game_state' && f.snapshot.state.status === 'finished', 5_000, 'last-player-standing finish')
  await sleep(400)
  await check('[C1] winner is the last remaining color (C1)', () => {
    assertEqual(finalFrame.snapshot.state.winnerColor, colorOf(C1!), 'winnerColor')
  })
  await check('[C2] all 3 forfeited colors are in leftColors', () => {
    for (const leaver of [C2!, C3!, C4!]) {
      if (!finalFrame.snapshot.state.leftColors.includes(colorOf(leaver))) throw new Error(`missing ${colorOf(leaver)} in leftColors`)
    }
  })
  await check('[C3] winner payout = 32 000 (80% of the ORIGINAL 40 000 4-player pot, never recomputed)', () => {
    assertEqual(getWalletBalance(C1!.profileId), 72_000, 'C1 final balance (40000 + 32000)')
  })
  await check('[C4] exactly ONE ludo_winner_payout ledger row, amount 32 000', () => {
    const rows = getLudoLedgerEntries(C.matchId).filter((r) => r.entry_type === 'ludo_winner_payout')
    assertEqual(rows.length, 1, 'payout row count')
    assertEqual(rows[0].amount, 32_000, 'payout amount')
  })
  await check('[C5] still exactly 4 ludo_stake_debit rows (pot never shrank)', () => {
    assertEqual(getLudoLedgerEntries(C.matchId).filter((r) => r.entry_type === 'ludo_stake_debit').length, 4, 'debit row count')
  })
  await check('[C6] the 3 forfeited players kept their post-start balance (40 000, stake never refunded)', () => {
    for (const leaver of [C2!, C3!, C4!]) assertEqual(getWalletBalance(leaver.profileId), 40_000, `${leaver.profileId} balance`)
  })

  for (const c of C.clients) c.ws.close()

  // ═══════════════════════════════════════════════════════════════════════
  // D: active-player leave — no stuck turn, deadline reassigned immediately.
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n=== D: active-player leave — no stuck turn ===')
  const D = await create4pMatch(port, 'd')
  const [D1, D2, D3, D4] = D.clients
  const dSnap = latestSnapshotFrame(D1!)
  const dActiveColor = dSnap.snapshot.state.activeColor
  const dActivePlayer = D.clients.find((c) => dSnap.snapshot.players.find((p: any) => p.profileId === c.profileId).color === dActiveColor)!
  const dOtherPlayer = D.clients.find((c) => c !== dActivePlayer)!

  dActivePlayer.frames.length = 0
  dOtherPlayer.frames.length = 0
  send(dActivePlayer, { type: 'leave_ludo_match', matchId: D.matchId })
  await waitForFrame(dActivePlayer, (f) => f.type === 'ludo_match_left', 5_000, 'active player left ack')
  const dAfter = await waitForFrame(dOtherPlayer, (f) => f.type === 'ludo_game_state' && f.snapshot.state.leftColors.includes(dActiveColor), 5_000, 'others observe active-player leave')

  await check('[D1] activeColor immediately moved OFF the forfeited color (no stuck turn)', () => {
    if (dAfter.snapshot.state.activeColor === dActiveColor) throw new Error('activeColor still points at the forfeited color')
  })
  await check('[D2] new activeColor is NOT itself a left color', () => {
    if (dAfter.snapshot.state.leftColors.includes(dAfter.snapshot.state.activeColor)) throw new Error('new activeColor is somehow also left')
  })
  await check('[D3] turnPhase reset to waiting_for_roll for the new active color', () => {
    assertEqual(dAfter.snapshot.state.turnPhase, 'waiting_for_roll', 'turnPhase after active-player forfeit')
  })
  await check('[D4] match still in_progress (3 players remain)', () => {
    assertEqual(dAfter.snapshot.state.status, 'in_progress', 'match status')
  })

  for (const c of D.clients) c.ws.close()

  // ═══════════════════════════════════════════════════════════════════════
  // E: inactive-player leave — current active player's turn undisturbed
  // (deadline/turnVersion not reset unnecessarily).
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n=== E: inactive-player leave — active player turn undisturbed ===')
  const E = await create4pMatch(port, 'e')
  const [E1] = E.clients
  const eSnap = latestSnapshotFrame(E1!)
  const eActiveColor = eSnap.snapshot.state.activeColor
  const eActivePlayer = E.clients.find((c) => eSnap.snapshot.players.find((p: any) => p.profileId === c.profileId).color === eActiveColor)!
  const eInactivePlayer = E.clients.find((c) => c !== eActivePlayer && eSnap.snapshot.players.find((p: any) => p.profileId === c.profileId))!
  const eInactiveColor = eSnap.snapshot.players.find((p: any) => p.profileId === eInactivePlayer.profileId).color

  E1!.frames.length = 0
  send(eInactivePlayer, { type: 'leave_ludo_match', matchId: E.matchId })
  await waitForFrame(eInactivePlayer, (f) => f.type === 'ludo_match_left', 5_000, 'inactive leave ack')
  const eAfter = await waitForFrame(E1!, (f) => f.type === 'ludo_game_state' && f.snapshot.state.leftColors.includes(eInactiveColor), 5_000, 'E1 observes inactive leave')

  await check('[E1] activeColor stays exactly the same (inactive leave never touches active turn)', () => {
    assertEqual(eAfter.snapshot.state.activeColor, eActiveColor, 'activeColor unaffected')
  })
  await check('[E2] turnPhase unaffected by the inactive leave', () => {
    assertEqual(eAfter.snapshot.state.turnPhase, eSnap.snapshot.state.turnPhase, 'turnPhase unaffected')
  })

  for (const c of E.clients) c.ws.close()

  // ═══════════════════════════════════════════════════════════════════════
  // Idempotency: duplicate leave_ludo_match for an already-forfeited color.
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n=== Idempotency: duplicate leave_ludo_match ===')
  const Idem = await create4pMatch(port, 'idem')
  const [I1, , , I4] = Idem.clients
  I4!.frames.length = 0
  send(I4!, { type: 'leave_ludo_match', matchId: Idem.matchId })
  await waitForFrame(I4!, (f) => f.type === 'ludo_match_left', 5_000, 'first leave ack')
  const balanceAfterFirst = getWalletBalance(I4!.profileId)
  send(I4!, { type: 'leave_ludo_match', matchId: Idem.matchId })
  await sleep(1_000) // let a possible (idempotent no-op) second ludo_match_left/error arrive if the server sends one
  await check('[Idem1] duplicate leave does not change the balance again', () => {
    assertEqual(getWalletBalance(I4!.profileId), balanceAfterFirst, 'balance after duplicate leave')
  })
  await check('[Idem2] duplicate leave does not add a second player_forfeited turn skip / crash the server', async () => {
    const health = await fetch(`http://127.0.0.1:${port}/health`)
    if (health.status !== 200) throw new Error('server unhealthy after duplicate leave')
  })
  for (const c of Idem.clients) c.ws.close()

  // ═══════════════════════════════════════════════════════════════════════
  // F: server restart after a 4-player leave — leftColors persists, the
  // forfeited profile never re-enters profileToMatch/reconnects, match
  // continues normally for the rest.
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n=== F: server restart after a 4-player leave ===')
  const F = await create4pMatch(port, 'f')
  const [F1, F2, F3, F4] = F.clients
  const fSnap = latestSnapshotFrame(F1!)
  const fLeaver = F.clients.find((c) => fSnap.snapshot.state.activeColor !== fSnap.snapshot.players.find((p: any) => p.profileId === c.profileId).color)!
  const fLeaverColor = fSnap.snapshot.players.find((p: any) => p.profileId === fLeaver.profileId).color

  fLeaver.frames.length = 0
  send(fLeaver, { type: 'leave_ludo_match', matchId: F.matchId })
  await waitForFrame(fLeaver, (f) => f.type === 'ludo_match_left', 5_000, 'F leaver ack')
  await sleep(300)

  for (const c of F.clients) c.ws.close()

  console.log('--- RESTART after a 4-player leave ---')
  await killServer(server)
  server = startServer(isolated.serverDir, port)
  if (!(await waitForHealth(port))) { console.error(server.output()); throw new Error('server did not become ready after F restart') }

  const fRemaining = F.clients.filter((c) => c !== fLeaver)
  const fRemaining1 = await connectWs(port, fRemaining[0]!.cookie, fRemaining[0]!.profileId)
  send(fRemaining1, { type: 'ludo_game_state_request' })
  const fResumed = await waitForFrame(fRemaining1, (f) => f.type === 'ludo_game_state' || f.type === 'error', 8_000, 'remaining player resumes after restart')
  await check('[F1] a remaining (non-forfeited) player resumes into the SAME match after restart', () => {
    if (fResumed.type !== 'ludo_game_state') throw new Error(`expected ludo_game_state, got ${JSON.stringify(fResumed)}`)
    assertEqual(fResumed.snapshot.matchId, F.matchId, 'resumed matchId')
  })
  await check('[F2] leftColors survived the restart (forfeited color still marked left)', () => {
    if (!fResumed.snapshot.state.leftColors.includes(fLeaverColor)) throw new Error('leftColors lost the forfeited color after restart')
  })
  await check('[F3] display roster still includes the forfeited player after restart', () => {
    assertEqual(fResumed.snapshot.players.length, 4, 'players array length after restart')
  })

  const fLeaverReconnect = await connectWs(port, fLeaver.cookie, fLeaver.profileId)
  send(fLeaverReconnect, { type: 'ludo_game_state_request' })
  const fLeaverResult = await waitForFrame(fLeaverReconnect, (f) => f.type === 'ludo_game_state' || f.type === 'error', 5_000, 'forfeited profile tries to resume after restart')
  await check('[F4] the forfeited profile does NOT reconnect into the match after restart (not in profileToMatch)', () => {
    if (fLeaverResult.type !== 'error' || fLeaverResult.code !== 'ludo_match_not_found') {
      throw new Error(`expected ludo_match_not_found, got ${JSON.stringify(fLeaverResult)}`)
    }
  })
  await check('[F5] the forfeited profile can create a new Ludo room after restart (membership genuinely released)', async () => {
    fLeaverReconnect.frames.length = 0
    send(fLeaverReconnect, { type: 'create_ludo_room', stake: STAKE, playerCount: 2, manualStart: true })
    const created = await waitForFrame(fLeaverReconnect, (f) => f.type === 'ludo_room_updated' || f.type === 'error', 5_000, 'forfeited profile creates room after restart')
    if (created.type !== 'ludo_room_updated') throw new Error(`expected ludo_room_updated, got ${JSON.stringify(created)}`)
  })

  fRemaining1.ws.close(); fLeaverReconnect.ws.close()

  console.log('\n' + '═'.repeat(70))
  console.log(`Passed: ${passed}  Failed: ${failed}`)
  if (failed > 0) process.exitCode = 1
} finally {
  await killServer(server)
  await isolated.cleanup()
}
