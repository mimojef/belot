/**
 * checkLudoServerRestartRecovery.ts
 *
 * Real spawned-server, real WebSocket, real backend PROCESS restart
 * integration test for the Ludo persistent-match-snapshot feature
 * (server/src/db/activeLudoMatchSnapshotStore.ts +
 * ludoMatchRuntime.ts::buildInitialMatch/restoreMatch +
 * ludoEconomyStore.ts::collectLudoMatchStakesWithInitialSnapshot).
 *
 * Follows the exact isolated-server + real-WebSocket pattern established by
 * checkLudoEconomy.ts / checkCrossGameCommitmentGuard.ts. Isolated mkdtemp
 * DB copy — NEVER the running dev server, NEVER production DB.
 *
 * Scenarios (task spec §13-15):
 *   A — full restart continuity: real 2-client match, several real moves,
 *       hard process restart, reconnect finds the SAME matchId/positions/
 *       activeColor/phase, no re-debit, play continues to a real payout.
 *   B — crash window: snapshot insert fails -> whole start transaction
 *       rolls back (no debit, no ledger rows, no match).
 *   C — crash window: atomic start DB commit succeeds, but the process dies
 *       before ludoMatchRuntime.createMatch() ever runs (in-memory publish
 *       never happened) -> boot recovery resurrects the match from the
 *       persisted snapshot with no second debit.
 *   D — finished-crash: a 'finished' snapshot is persisted but the process
 *       dies before payoutLudoMatchWinner() runs -> boot recovery completes
 *       the payout exactly once.
 *   E — finished-crash: payout already committed, process dies before the
 *       snapshot row is removed -> boot recovery does NOT double-pay and
 *       still completes the cleanup.
 */

import { DatabaseSync } from 'node:sqlite'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
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
function assertEqual(actual: unknown, expected: unknown, what: string): void {
  if (actual !== expected) throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
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
async function retryRm(path: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try { await rm(path, { recursive: true, force: true }); return } catch { /* retry */ }
    await sleep(250)
  }
}

const sourceServerRoot = resolve(
  process.argv.slice(2).find((a) => a.startsWith('--server-root='))?.slice('--server-root='.length)
  ?? process.cwd(),
)

async function createIsolatedServerRoot() {
  const root = await mkdtemp(join(tmpdir(), 'belot-ludo-restart-'))
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
  server.child.kill('SIGKILL') // hard kill — simulates a real crash/abrupt restart, not a graceful shutdown
  await new Promise<void>((r) => {
    const t = setTimeout(() => { server.child.kill('SIGKILL'); r() }, 8_000)
    server.child.once('exit', () => { clearTimeout(t); r() })
  })
}

type TestClient = { profileId: string; cookie: string; ws: WebSocket; frames: any[] }
async function registerAndLogin(port: number, tag: string, runId: string) {
  const email = `ludo-restart-${tag}-${runId}@example.test`
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'LudoRestart1!', displayName: `LR${tag}${runId.slice(-5)}`, gender: 'male' }),
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
async function waitBriefly(c: TestClient, pred: (f: any) => boolean, waitMs = 3_000): Promise<any | null> {
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    const found = c.frames.find(pred)
    if (found) return found
    await sleep(80)
  }
  return null
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
    const row = db.prepare(`SELECT yellow_coins_balance FROM profile_wallets WHERE profile_id = ?`).get(profileId) as
      { yellow_coins_balance: number } | undefined
    return row?.yellow_coins_balance ?? 0
  } finally { db.close() }
}
function getLudoLedgerEntries(matchId: string): any[] {
  const db = new DatabaseSync(dbFile, { open: true, enableForeignKeyConstraints: true })
  try {
    return db.prepare(`SELECT match_id, profile_id, entry_type, amount FROM ludo_match_economy_ledger WHERE match_id = ? ORDER BY created_at`).all(matchId)
  } finally { db.close() }
}
function getActiveLudoMatchSnapshotRow(matchId: string): any | null {
  const db = new DatabaseSync(dbFile, { open: true, enableForeignKeyConstraints: true })
  try {
    return db.prepare(`SELECT * FROM active_ludo_match_snapshots WHERE match_id = ?`).get(matchId) ?? null
  } finally { db.close() }
}

console.log('\ncheckLudoServerRestartRecovery\n')

const isolated = await createIsolatedServerRoot()
dbFile = isolated.dbFile
const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const STAKE = 10_000

let server: RunningServer | null = null

try {
  const port = await findFreePort()
  server = startServer(isolated.serverDir, port)
  console.log(`Waiting for server on port ${port}...`)
  if (!(await waitForHealth(port))) {
    console.error(server.output())
    throw new Error('server did not become ready')
  }
  console.log('Server ready.\n')

  // ═══════════════════════════════════════════════════════════════════════
  // A: full restart continuity — real 2-client match, real moves, hard
  // process restart, reconnect finds the SAME match, no re-debit, continues
  // to a real single payout via forfeit.
  // ═══════════════════════════════════════════════════════════════════════
  console.log('=== A: full restart continuity (2-player, stake 10 000) ===')

  const A = await registerAndLogin(port, 'a', runId)
  const B = await registerAndLogin(port, 'b', runId)
  setWalletBalance(A.profileId, 50_000)
  setWalletBalance(B.profileId, 50_000)
  console.log(`Before: A=${getWalletBalance(A.profileId)} B=${getWalletBalance(B.profileId)}`)

  let clientA = await connectWs(port, A.cookie, A.profileId)
  let clientB = await connectWs(port, B.cookie, B.profileId)

  send(clientA, { type: 'create_ludo_room', stake: STAKE, playerCount: 2, manualStart: false })
  const roomFrame = await waitForFrame(clientA, (f) => f.type === 'ludo_room_updated', 10_000, 'room created')
  send(clientB, { type: 'join_ludo_room', ludoRoomId: roomFrame.room.id })
  const startedA = await waitForFrame(clientA, (f) => f.type === 'ludo_game_started', 10_000, 'match started (A)')
  await waitForFrame(clientB, (f) => f.type === 'ludo_game_started', 10_000, 'match started (B)')
  const matchId = startedA.snapshot.matchId

  const afterStart = { A: getWalletBalance(A.profileId), B: getWalletBalance(B.profileId) }
  console.log(`Start: A=${afterStart.A} B=${afterStart.B}  matchId=${matchId}`)
  await check('[A1] both players debited exactly stake (50000 -> 40000)', () => {
    assertEqual(afterStart.A, 40_000, 'A after start')
    assertEqual(afterStart.B, 40_000, 'B after start')
  })

  // Play a few real rounds so the match has genuine progress (piece
  // positions/turnVersion/revision beyond the initial state).
  for (let round = 0; round < 4; round++) {
    const latestA = clientA.frames.filter((f) => f.type === 'ludo_game_started' || f.type === 'ludo_game_state').pop()
    const latestB = clientB.frames.filter((f) => f.type === 'ludo_game_started' || f.type === 'ludo_game_state').pop()
    const latest = (latestA?.snapshot?.revision ?? -1) >= (latestB?.snapshot?.revision ?? -1) ? latestA : latestB
    const activeColor = latest.snapshot.state.activeColor
    const mover = startedA.snapshot.players.find((p: any) => p.profileId === A.profileId)?.color === activeColor ? clientA : clientB
    send(mover, { type: 'ludo_roll_request', matchId, expectedRevision: latest.snapshot.revision })
    await sleep(350)
    const afterRoll = mover.frames.filter((f) => f.type === 'ludo_game_state').pop()
    if (afterRoll?.snapshot?.state?.legalMoves?.length > 0) {
      const move = afterRoll.snapshot.state.legalMoves[0]
      send(mover, { type: 'ludo_move_request', matchId, expectedRevision: afterRoll.snapshot.revision, slot: move.slot })
      await sleep(350)
    }
  }

  const preRestart = [...clientA.frames, ...clientB.frames]
    .filter((f) => f.type === 'ludo_game_state' || f.type === 'ludo_game_started')
    .sort((a, b) => a.snapshot.revision - b.snapshot.revision)
    .pop()
  const preRestartSnapshot = preRestart.snapshot
  console.log(`Pre-restart: revision=${preRestartSnapshot.revision} activeColor=${preRestartSnapshot.state.activeColor} phase=${preRestartSnapshot.state.turnPhase} pieces=${JSON.stringify(preRestartSnapshot.state.pieces)}`)
  await check('[A2] match made real progress before restart (revision > 0)', () => {
    if (!(preRestartSnapshot.revision > 0)) throw new Error(`expected revision > 0, got ${preRestartSnapshot.revision}`)
  })

  const persistedRowBeforeRestart = getActiveLudoMatchSnapshotRow(matchId)
  await check('[A3] a durable snapshot row exists for the match BEFORE restart', () => {
    if (!persistedRowBeforeRestart) throw new Error('no active_ludo_match_snapshots row found')
  })

  clientA.ws.close(); clientB.ws.close()
  await sleep(200)

  console.log('\n--- RESTART: hard-killing the backend process, respawning on the SAME port + SAME DB file ---')
  await killServer(server)
  server = startServer(isolated.serverDir, port)
  if (!(await waitForHealth(port))) {
    console.error(server.output())
    throw new Error('server did not become ready after restart')
  }
  console.log('New process ready.\n')

  clientA = await connectWs(port, A.cookie, A.profileId)
  clientB = await connectWs(port, B.cookie, B.profileId)
  send(clientA, { type: 'ludo_game_state_request' })
  send(clientB, { type: 'ludo_game_state_request' })
  const resumedA = await waitForFrame(clientA, (f) => f.type === 'ludo_game_state' || f.type === 'error', 8_000, 'A resume after restart')
  const resumedB = await waitForFrame(clientB, (f) => f.type === 'ludo_game_state' || f.type === 'error', 8_000, 'B resume after restart')

  await check('[A4] A is resumed into the SAME matchId after restart (not an error)', () => {
    if (resumedA.type !== 'ludo_game_state') throw new Error(`expected ludo_game_state, got ${JSON.stringify(resumedA)}`)
    assertEqual(resumedA.snapshot.matchId, matchId, 'resumed matchId (A)')
  })
  await check('[A5] B is resumed into the SAME matchId after restart (not an error)', () => {
    if (resumedB.type !== 'ludo_game_state') throw new Error(`expected ludo_game_state, got ${JSON.stringify(resumedB)}`)
    assertEqual(resumedB.snapshot.matchId, matchId, 'resumed matchId (B)')
  })
  await check('[A6] restored piece positions match the pre-restart snapshot exactly', () => {
    assertEqual(JSON.stringify(resumedA.snapshot.state.pieces), JSON.stringify(preRestartSnapshot.state.pieces), 'pieces after restore')
  })
  await check('[A7] restored activeColor matches pre-restart', () => {
    assertEqual(resumedA.snapshot.state.activeColor, preRestartSnapshot.state.activeColor, 'activeColor after restore')
  })
  await check('[A8] restored turnPhase matches pre-restart', () => {
    assertEqual(resumedA.snapshot.state.turnPhase, preRestartSnapshot.state.turnPhase, 'turnPhase after restore')
  })
  await check('[A9] restored revision is >= pre-restart revision (never goes backwards)', () => {
    if (!(resumedA.snapshot.revision >= preRestartSnapshot.revision)) {
      throw new Error(`expected revision >= ${preRestartSnapshot.revision}, got ${resumedA.snapshot.revision}`)
    }
  })

  const afterRestartBalances = { A: getWalletBalance(A.profileId), B: getWalletBalance(B.profileId) }
  console.log(`After restart: A=${afterRestartBalances.A} B=${afterRestartBalances.B}`)
  await check('[A10] NO re-debit occurred — balances stay exactly 40000/40000', () => {
    assertEqual(afterRestartBalances.A, 40_000, 'A after restart')
    assertEqual(afterRestartBalances.B, 40_000, 'B after restart')
  })
  await check('[A11] still exactly 2 ludo_stake_debit ledger rows (no duplicate)', () => {
    const debitRows = getLudoLedgerEntries(matchId).filter((r) => r.entry_type === 'ludo_stake_debit')
    assertEqual(debitRows.length, 2, 'debit row count')
  })

  // Play continues: forfeit-finish via A, B becomes winner, single payout.
  send(clientA, { type: 'leave_ludo_match', matchId })
  await waitForFrame(clientA, (f) => f.type === 'ludo_match_left', 5_000, 'A left after restart')
  const bFinished = await waitForFrame(clientB, (f) => f.type === 'ludo_game_state' && f.snapshot.state.status === 'finished', 5_000, 'B sees finish after restart')
  await sleep(400)

  const finalBalances = { A: getWalletBalance(A.profileId), B: getWalletBalance(B.profileId) }
  console.log(`After forfeit-finish post-restart: A=${finalBalances.A} B=${finalBalances.B} prizeAmount=${bFinished.prizeAmount}`)
  await check('[A12] winner (B) payout = 16 000 -> 56 000 exactly once', () => {
    assertEqual(finalBalances.B, 56_000, 'B final balance')
    assertEqual(bFinished.prizeAmount, 16_000, 'pushed prizeAmount')
  })
  await check('[A13] exactly ONE ludo_winner_payout ledger row', () => {
    const payoutRows = getLudoLedgerEntries(matchId).filter((r) => r.entry_type === 'ludo_winner_payout')
    assertEqual(payoutRows.length, 1, 'payout row count')
  })
  await sleep(300)
  await check('[A14] the persisted snapshot row is cleaned up after settlement', () => {
    const row = getActiveLudoMatchSnapshotRow(matchId)
    if (row !== null) throw new Error(`expected snapshot row removed, still present: ${JSON.stringify(row)}`)
  })

  clientA.ws.close(); clientB.ws.close()

  // ═══════════════════════════════════════════════════════════════════════
  // B: crash window — snapshot insert fails -> whole start transaction
  // rolls back (no debit, no ledger rows, no match).
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n=== B: atomic start rollback when the snapshot insert fails ===')

  const economyModule = await import(pathToFileURL(join(isolated.serverDir, 'src', 'db', 'ludoEconomyStore.ts')).href) as
    typeof import('../src/db/ludoEconomyStore.ts')
  const secondEconomyStore = await economyModule.createLudoEconomyStore(dbFile)
  try {
    const B1 = await registerAndLogin(port, 'b1', runId)
    const B2 = await registerAndLogin(port, 'b2', runId)
    setWalletBalance(B1.profileId, 50_000)
    setWalletBalance(B2.profileId, 50_000)
    const bogusMatchId = `bogus-${runId}`

    // Deliberately malformed snapshot (invalid state.status) — violates the
    // active_ludo_match_snapshots.match_status CHECK constraint, forcing the
    // INSERT inside the atomic transaction to throw.
    const malformedSnapshot = {
      matchId: bogusMatchId, ludoRoomId: 'bogus-room', stake: STAKE, revision: 0, serverNow: Date.now(),
      deadlineAt: null,
      players: [{ profileId: B1.profileId, displayName: 'B1', avatarUrl: null, color: 'red' }, { profileId: B2.profileId, displayName: 'B2', avatarUrl: null, color: 'yellow' }],
      state: { status: 'not_a_real_status' } as any,
      events: [], botControlledColors: [],
    }

    const result = secondEconomyStore.collectLudoMatchStakesWithInitialSnapshot(
      bogusMatchId, [B1.profileId, B2.profileId], STAKE, malformedSnapshot as any,
    )

    await check('[B1] the atomic call reports failure (snapshot insert rejected)', () => {
      if (result.ok) throw new Error('expected ok:false, got ok:true')
    })
    await check('[B2] wallets are COMPLETELY untouched (debit rolled back with the snapshot)', () => {
      assertEqual(getWalletBalance(B1.profileId), 50_000, 'B1 balance')
      assertEqual(getWalletBalance(B2.profileId), 50_000, 'B2 balance')
    })
    await check('[B3] no ludo_stake_debit ledger rows were left behind', () => {
      assertEqual(getLudoLedgerEntries(bogusMatchId).length, 0, 'ledger row count')
    })
    await check('[B4] no snapshot row was left behind', () => {
      if (getActiveLudoMatchSnapshotRow(bogusMatchId) !== null) throw new Error('snapshot row unexpectedly present')
    })
  } finally {
    secondEconomyStore.close()
  }

  // ═══════════════════════════════════════════════════════════════════════
  // C: crash window — atomic start DB commit succeeds, but the process dies
  // BEFORE ludoMatchRuntime.createMatch() ever runs (in-memory publish never
  // happened). Simulated by calling the real atomic function directly
  // (bypassing the WS create/join flow, which would also call createMatch),
  // then starting a server against this DB and confirming boot recovery.
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n=== C: DB commit succeeds, process dies before in-memory publish -> boot recovers ===')

  const C1 = await registerAndLogin(port, 'c1', runId)
  const C2 = await registerAndLogin(port, 'c2', runId)
  setWalletBalance(C1.profileId, 50_000)
  setWalletBalance(C2.profileId, 50_000)
  const crashMatchId = `crash-c-${runId}`
  const crashSnapshot = {
    matchId: crashMatchId, ludoRoomId: `room-${crashMatchId}`, stake: STAKE, revision: 0, serverNow: Date.now(),
    deadlineAt: null,
    players: [
      { profileId: C1.profileId, displayName: 'C1', avatarUrl: null, color: 'red' as const },
      { profileId: C2.profileId, displayName: 'C2', avatarUrl: null, color: 'yellow' as const },
    ],
    state: {
      turnOrder: ['red', 'yellow'], activeColor: 'red', turnPhase: 'waiting_for_roll',
      diceValue: null, legalMoves: [],
      pieces: [0, 1, 2, 3].flatMap((slot) => [
        { color: 'red', slot, position: { kind: 'home', slot } },
        { color: 'yellow', slot, position: { kind: 'home', slot } },
      ]),
      status: 'in_progress', winnerColor: null, turnVersion: 0, pendingExtraRoll: false, leftColors: [],
    } as any,
    events: [], botControlledColors: [],
  }

  const economyModule2 = await import(pathToFileURL(join(isolated.serverDir, 'src', 'db', 'ludoEconomyStore.ts')).href) as
    typeof import('../src/db/ludoEconomyStore.ts')
  const thirdEconomyStore = await economyModule2.createLudoEconomyStore(dbFile)
  let crashCommitResult: { ok: boolean }
  try {
    crashCommitResult = thirdEconomyStore.collectLudoMatchStakesWithInitialSnapshot(
      crashMatchId, [C1.profileId, C2.profileId], STAKE, crashSnapshot as any,
    )
  } finally {
    thirdEconomyStore.close()
  }
  await check('[C1] the atomic transaction itself succeeds (this is the "DB commit happened" moment)', () => {
    if (!crashCommitResult.ok) throw new Error('expected the atomic start transaction to succeed')
  })
  await check('[C2] debit is visible immediately after commit, before any in-memory match ever existed', () => {
    assertEqual(getWalletBalance(C1.profileId), 40_000, 'C1 after atomic commit')
    assertEqual(getWalletBalance(C2.profileId), 40_000, 'C2 after atomic commit')
  })
  // NOTE: ludoMatchRuntime.createMatch() / finalizeRoomStart() are
  // deliberately NEVER called here — this IS the simulated crash: the
  // process would have died between the DB commit above and the in-memory
  // publish. No live room/match exists anywhere in the running server's
  // memory for crashMatchId at this point.

  console.log('--- RESTART (simulating the crash boundary) ---')
  await killServer(server)
  server = startServer(isolated.serverDir, port)
  if (!(await waitForHealth(port))) {
    console.error(server.output())
    throw new Error('server did not become ready after C restart')
  }

  const clientC1 = await connectWs(port, C1.cookie, C1.profileId)
  send(clientC1, { type: 'ludo_game_state_request' })
  const resumedC1 = await waitForFrame(clientC1, (f) => f.type === 'ludo_game_state' || f.type === 'error', 8_000, 'C1 resume')
  await check('[C3] boot recovery resurrected the match that never had an in-memory publish', () => {
    if (resumedC1.type !== 'ludo_game_state') throw new Error(`expected ludo_game_state, got ${JSON.stringify(resumedC1)}`)
    assertEqual(resumedC1.snapshot.matchId, crashMatchId, 'resurrected matchId')
  })
  await check('[C4] balances are debited EXACTLY ONCE (no second debit from any recovery path)', () => {
    assertEqual(getWalletBalance(C1.profileId), 40_000, 'C1 after boot recovery')
    assertEqual(getWalletBalance(C2.profileId), 40_000, 'C2 after boot recovery')
  })
  await check('[C5] still exactly 2 ludo_stake_debit ledger rows', () => {
    assertEqual(getLudoLedgerEntries(crashMatchId).filter((r) => r.entry_type === 'ludo_stake_debit').length, 2, 'debit row count')
  })

  clientC1.ws.close()

  // ═══════════════════════════════════════════════════════════════════════
  // D: finished-crash — a 'finished' snapshot is persisted (winner decided)
  // but the process dies BEFORE payoutLudoMatchWinner() ever runs -> boot
  // recovery must complete the payout exactly once.
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n=== D: finished snapshot persisted, restart BEFORE payout -> boot completes it ===')

  const D1 = await registerAndLogin(port, 'd1', runId)
  const D2 = await registerAndLogin(port, 'd2', runId)
  setWalletBalance(D1.profileId, 50_000)
  setWalletBalance(D2.profileId, 50_000)
  const finishedMatchId = `crash-d-${runId}`

  const economyModule3 = await import(pathToFileURL(join(isolated.serverDir, 'src', 'db', 'ludoEconomyStore.ts')).href) as
    typeof import('../src/db/ludoEconomyStore.ts')
  const fourthEconomyStore = await economyModule3.createLudoEconomyStore(dbFile)
  const finishedPieces = [0, 1, 2, 3].map((slot) => ({ color: 'red', slot, position: { kind: 'finish', finishIndex: 5 } }))
    .concat([0, 1, 2, 3].map((slot) => ({ color: 'yellow', slot, position: { kind: 'home', slot } })))
  const finishedSnapshot = {
    matchId: finishedMatchId, ludoRoomId: `room-${finishedMatchId}`, stake: STAKE, revision: 5, serverNow: Date.now(),
    deadlineAt: null,
    players: [
      { profileId: D1.profileId, displayName: 'D1', avatarUrl: null, color: 'red' as const },
      { profileId: D2.profileId, displayName: 'D2', avatarUrl: null, color: 'yellow' as const },
    ],
    state: {
      turnOrder: ['red', 'yellow'], activeColor: 'red', turnPhase: 'turn_complete', diceValue: null, legalMoves: [],
      pieces: finishedPieces, status: 'finished', winnerColor: 'red', turnVersion: 5, pendingExtraRoll: false, leftColors: [],
    } as any,
    events: [], botControlledColors: [],
  }
  try {
    // Debit both via the SAME atomic start transaction production code uses
    // (as if the match had started normally with an in_progress snapshot),
    // then immediately overwrite the row with the ALREADY-FINISHED snapshot
    // via the normal onSnapshot-equivalent upsert path below — simulating
    // "the finished snapshot commit happened, then the process died before
    // onSnapshot's settleLudoMatchIfNeeded() call ran".
    const debit = fourthEconomyStore.collectLudoMatchStakesWithInitialSnapshot(
      finishedMatchId, [D1.profileId, D2.profileId], STAKE, { ...finishedSnapshot, state: { ...finishedSnapshot.state, status: 'in_progress', winnerColor: null } } as any,
    )
    if (!debit.ok) throw new Error(`setup debit failed: ${JSON.stringify(debit)}`)
  } finally {
    fourthEconomyStore.close()
  }
  const snapshotModule = await import(pathToFileURL(join(isolated.serverDir, 'src', 'db', 'activeLudoMatchSnapshotStore.ts')).href) as
    typeof import('../src/db/activeLudoMatchSnapshotStore.ts')
  const snapshotStoreForSetup = await snapshotModule.createActiveLudoMatchSnapshotStore(dbFile)
  try {
    snapshotStoreForSetup.upsertMatch(finishedSnapshot as any)
  } finally {
    snapshotStoreForSetup.close()
  }
  await check('[D0] setup: finished snapshot is persisted, but payout has NOT happened yet', () => {
    assertEqual(getLudoLedgerEntries(finishedMatchId).filter((r) => r.entry_type === 'ludo_winner_payout').length, 0, 'payout row count before restart')
    assertEqual(getWalletBalance(D1.profileId), 40_000, 'D1 before restart (debited, not yet paid)')
  })

  console.log('--- RESTART (simulating crash between finished-snapshot commit and payout) ---')
  await killServer(server)
  server = startServer(isolated.serverDir, port)
  if (!(await waitForHealth(port))) {
    console.error(server.output())
    throw new Error('server did not become ready after D restart')
  }
  await sleep(500) // give boot recovery a moment to run its settlement pass

  await check('[D1_check] boot recovery completed the payout exactly once', () => {
    const payoutRows = getLudoLedgerEntries(finishedMatchId).filter((r) => r.entry_type === 'ludo_winner_payout')
    assertEqual(payoutRows.length, 1, 'payout row count after boot recovery')
    assertEqual(payoutRows[0].amount, 16_000, 'payout amount (80% of 20000 pot)')
  })
  await check('[D2_check] winner (D1) balance reflects the payout exactly once', () => {
    assertEqual(getWalletBalance(D1.profileId), 56_000, 'D1 balance after boot-recovered payout')
  })
  await check('[D3_check] the snapshot row is cleaned up after boot-recovered settlement', () => {
    if (getActiveLudoMatchSnapshotRow(finishedMatchId) !== null) throw new Error('expected snapshot row removed after successful boot-recovery payout')
  })

  // ═══════════════════════════════════════════════════════════════════════
  // E: finished-crash — payout already committed, process dies BEFORE the
  // snapshot row is removed -> boot recovery must NOT double-pay, and must
  // still complete the cleanup.
  // ═══════════════════════════════════════════════════════════════════════
  console.log('\n=== E: payout committed, restart BEFORE snapshot delete -> no double payout ===')

  const E1 = await registerAndLogin(port, 'e1', runId)
  const E2 = await registerAndLogin(port, 'e2', runId)
  setWalletBalance(E1.profileId, 50_000)
  setWalletBalance(E2.profileId, 50_000)
  const paidMatchId = `crash-e-${runId}`
  const paidFinishedPieces = [0, 1, 2, 3].map((slot) => ({ color: 'blue', slot, position: { kind: 'finish', finishIndex: 5 } }))
    .concat([0, 1, 2, 3].map((slot) => ({ color: 'green', slot, position: { kind: 'home', slot } })))
  const paidSnapshot = {
    matchId: paidMatchId, ludoRoomId: `room-${paidMatchId}`, stake: STAKE, revision: 5, serverNow: Date.now(),
    deadlineAt: null,
    players: [
      { profileId: E1.profileId, displayName: 'E1', avatarUrl: null, color: 'blue' as const },
      { profileId: E2.profileId, displayName: 'E2', avatarUrl: null, color: 'green' as const },
    ],
    state: {
      turnOrder: ['blue', 'green'], activeColor: 'blue', turnPhase: 'turn_complete', diceValue: null, legalMoves: [],
      pieces: paidFinishedPieces, status: 'finished', winnerColor: 'blue', turnVersion: 5, pendingExtraRoll: false, leftColors: [],
    } as any,
    events: [], botControlledColors: [],
  }

  const economyModule4 = await import(pathToFileURL(join(isolated.serverDir, 'src', 'db', 'ludoEconomyStore.ts')).href) as
    typeof import('../src/db/ludoEconomyStore.ts')
  const fifthEconomyStore = await economyModule4.createLudoEconomyStore(dbFile)
  try {
    const debit = fifthEconomyStore.collectLudoMatchStakesWithInitialSnapshot(
      paidMatchId, [E1.profileId, E2.profileId], STAKE, { ...paidSnapshot, state: { ...paidSnapshot.state, status: 'in_progress', winnerColor: null } } as any,
    )
    if (!debit.ok) throw new Error(`setup debit failed: ${JSON.stringify(debit)}`)
    // Pay out for real (this is the production function) — simulating
    // "settleLudoMatchIfNeeded already ran".
    const payout = fifthEconomyStore.payoutLudoMatchWinner(paidMatchId, E1.profileId)
    if (!payout.ok) throw new Error(`setup payout failed: ${JSON.stringify(payout)}`)
  } finally {
    fifthEconomyStore.close()
  }
  // Persist the finished snapshot row AFTER the payout — simulating "the
  // process died between payout commit and the snapshot-delete step" (the
  // row is deliberately left behind).
  const snapshotModule2 = await import(pathToFileURL(join(isolated.serverDir, 'src', 'db', 'activeLudoMatchSnapshotStore.ts')).href) as
    typeof import('../src/db/activeLudoMatchSnapshotStore.ts')
  const snapshotStoreForSetup2 = await snapshotModule2.createActiveLudoMatchSnapshotStore(dbFile)
  try {
    snapshotStoreForSetup2.upsertMatch(paidSnapshot as any)
  } finally {
    snapshotStoreForSetup2.close()
  }
  await check('[E0] setup: payout already happened once, snapshot row still present', () => {
    assertEqual(getLudoLedgerEntries(paidMatchId).filter((r) => r.entry_type === 'ludo_winner_payout').length, 1, 'payout row count before restart')
    assertEqual(getWalletBalance(E1.profileId), 56_000, 'E1 before restart (already paid once)')
    if (getActiveLudoMatchSnapshotRow(paidMatchId) === null) throw new Error('expected snapshot row still present for this test setup')
  })

  console.log('--- RESTART (simulating crash between payout commit and snapshot delete) ---')
  await killServer(server)
  server = startServer(isolated.serverDir, port)
  if (!(await waitForHealth(port))) {
    console.error(server.output())
    throw new Error('server did not become ready after E restart')
  }
  await sleep(500)

  await check('[E1_check] NO double payout — still exactly ONE ludo_winner_payout row', () => {
    assertEqual(getLudoLedgerEntries(paidMatchId).filter((r) => r.entry_type === 'ludo_winner_payout').length, 1, 'payout row count after boot recovery')
  })
  await check('[E2_check] winner balance did NOT increase a second time', () => {
    assertEqual(getWalletBalance(E1.profileId), 56_000, 'E1 balance unchanged (still exactly one payout)')
  })
  await check('[E3_check] the leftover snapshot row is cleaned up by boot recovery', () => {
    if (getActiveLudoMatchSnapshotRow(paidMatchId) !== null) throw new Error('expected snapshot row removed by boot-recovery cleanup')
  })

  console.log('\n' + '═'.repeat(70))
  console.log(`Passed: ${passed}  Failed: ${failed}`)
  if (failed > 0) process.exitCode = 1
} finally {
  await killServer(server)
  await isolated.cleanup()
}
