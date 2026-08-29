/**
 * checkTournamentRefundLogoutSessionGuard.ts
 *
 * Real spawned-server, real WebSocket integration test for the manually
 * discovered bug: after a normal logout in one browser tab (site left open,
 * WebSocket never explicitly closed by the old code), the tournament
 * creator-cancel refund popup still appeared in that logged-out tab, because
 * the WS connection stayed bound server-side to the OLD profileId forever
 * (only a real `close` event, never fired by logout, ever flips
 * connection.status away from 'connected').
 *
 * Root cause + fix (see server/src/index.ts):
 *  - POST /api/auth/logout now looks up the session being revoked BEFORE
 *    invalidating it, and calls disconnectConnectionsForSession(sessionId),
 *    which closes (not just unbinds) every WS connection authenticated under
 *    THAT SPECIFIC session — never by profileId alone, because
 *    authStore.ts supports multiple concurrent independent sessions per
 *    profile (one row per login/register) and logout only ever revokes the
 *    one session token it was called with. Closing the socket drives the
 *    EXISTING 'close' handler, which already marks status='disconnected'
 *    (already excluded from sendToOpenProfileConnections's target set).
 *  - cancelOpenTournamentAndRefundAtomically now writes a durable row to
 *    tournament_economy_notice_log (reason='creator_cancelled', previously
 *    only fill_expired/scheduled_underfilled were persisted there — a
 *    creator-cancel refund for an offline/just-logged-out recipient used to
 *    be lost forever, not just delayed). The existing connect-time flush
 *    (already used for fill_expired/scheduled_underfilled/partner_left)
 *    delivers it automatically on the next login/reconnect, exactly once.
 *
 * Scenarios covered (see task spec's 9-point targeted test list):
 *  [1] Profile A authenticated, single session -> creator cancels -> A's own
 *      tab receives the tournament_economy_notice popup push.
 *  [2] A logs out (single session) -> creator cancels -> the (now closed)
 *      connection receives NOTHING.
 *  [4] The logged-out connection's readyState actually transitions to
 *      CLOSED (proxy for "removed from the profile connection registry" —
 *      status flips to 'disconnected', excluding it from
 *      sendToOpenProfileConnections's target set).
 *  [3] The refund notice persisted server-side (delivered_at IS NULL right
 *      after the cancel); logging back in opens a fresh connection that
 *      receives the notice automatically (no polling, no manual refresh),
 *      and the row is then marked delivered.
 *  [9] A second reconnect afterwards receives NOTHING further for that same
 *      event (no duplicate realtime delivery).
 *  [8] Exactly one tournament_economy_notice_log row ever exists for that
 *      (tournament, profile) pair.
 *  [6] Multi-tab isolation: two independent sessions (two logins) for the
 *      SAME profile; logging out ONE session closes only that session's
 *      connection — the other tab's connection stays open and still
 *      receives the realtime popup when the creator cancels.
 *  [7] Ledger/wallet correctness is unaffected by any of the above: exactly
 *      one entry_fee_refund ledger row per (tournament, profile), wallet
 *      balance fully restored every time.
 *  [5] Client-side defense-in-depth guard (main.ts: no popup when
 *      currentAuthSession is null) is present as a static source check —
 *      the live behavioral proof for the reported scenario is the server no
 *      longer delivering the push at all (scenario [2]/[4] above); this is
 *      a regression guard for the belt-and-suspenders client check itself.
 */

import { DatabaseSync } from 'node:sqlite'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
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
function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
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
  const root = await mkdtemp(join(tmpdir(), 'belot-refund-logout-guard-'))
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

type TestClient = { profileId: string; cookie: string; ws: WebSocket; frames: any[] }

async function register(port: number, tag: string, runId: string): Promise<{ email: string; password: string; cookie: string; profileId: string }> {
  const email = `refund-logout-guard-${tag}-${runId}@example.test`
  const password = 'RefundLogoutGuardDiag1!'
  const reg = await httpJson(port, 'POST', '/api/auth/register', null, {
    email, password, displayName: `RLG ${tag}`, gender: 'male',
  })
  if (reg.status !== 200) throw new Error(`Registration failed for ${tag}: ${JSON.stringify(reg.body)}`)
  return { email, password, cookie: reg.setCookie as string, profileId: reg.body.session.profile.profileId }
}

async function login(port: number, email: string, password: string): Promise<string> {
  const res = await httpJson(port, 'POST', '/api/auth/login', null, { email, password })
  if (res.status !== 200) throw new Error(`Login failed for ${email}: ${JSON.stringify(res.body)}`)
  return res.setCookie as string
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
function getWalletBalance(dbFile: string, profileId: string): number {
  const db = new DatabaseSync(dbFile, { open: true, enableForeignKeyConstraints: true })
  try {
    const row = db.prepare(`SELECT yellow_coins_balance FROM profile_wallets WHERE profile_id = ?`).get(profileId) as
      | { yellow_coins_balance: number }
      | undefined
    return row?.yellow_coins_balance ?? 0
  } finally {
    db.close()
  }
}
function countLedgerRows(dbFile: string, tournamentId: string, profileId: string, entryType: string): number {
  const db = new DatabaseSync(dbFile, { open: true, enableForeignKeyConstraints: true })
  try {
    const row = db.prepare(
      `SELECT COUNT(*) as c FROM tournament_economy_ledger WHERE tournament_id = ? AND profile_id = ? AND entry_type = ?`,
    ).get(tournamentId, profileId, entryType) as { c: number }
    return row.c
  } finally {
    db.close()
  }
}
function getNoticeRows(dbFile: string, tournamentId: string, profileId: string): Array<{ reason: string; refunded_amount: number; delivered_at: string | null }> {
  const db = new DatabaseSync(dbFile, { open: true, enableForeignKeyConstraints: true })
  try {
    return db.prepare(
      `SELECT reason, refunded_amount, delivered_at FROM tournament_economy_notice_log WHERE tournament_id = ? AND recipient_profile_id = ?`,
    ).all(tournamentId, profileId) as any
  } finally {
    db.close()
  }
}

async function createTournament(port: number, hostCookie: string, entryFee: number): Promise<string> {
  const res = await httpJson(port, 'POST', '/api/tournaments', hostCookie, {
    name: `Refund Guard ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    entryFee,
    teamCapacity: 4,
    visibility: 'public',
    startMode: 'fill',
  })
  if (res.status !== 200 || res.body?.ok !== true) {
    throw new Error(`Tournament create failed: ${res.status} ${JSON.stringify(res.body)}`)
  }
  return res.body.tournament.tournamentId as string
}
async function joinSolo(port: number, cookie: string, tournamentId: string): Promise<void> {
  const res = await httpJson(port, 'POST', `/api/tournaments/${tournamentId}/join`, cookie, {})
  if (res.status !== 200 || res.body?.ok !== true) {
    throw new Error(`Join failed: ${res.status} ${JSON.stringify(res.body)}`)
  }
}
async function cancelTournament(port: number, hostCookie: string, tournamentId: string): Promise<void> {
  const res = await httpJson(port, 'POST', `/api/tournaments/${tournamentId}/cancel`, hostCookie, {})
  if (res.status !== 200 || res.body?.ok !== true) {
    throw new Error(`Cancel failed: ${res.status} ${JSON.stringify(res.body)}`)
  }
}
async function logout(port: number, cookie: string): Promise<void> {
  const res = await httpJson(port, 'POST', '/api/auth/logout', cookie)
  if (res.status !== 200) throw new Error(`Logout failed: ${res.status} ${JSON.stringify(res.body)}`)
}

function economyNoticeFrames(client: TestClient, tournamentId: string): any[] {
  return client.frames.filter((f) => f.type === 'tournament_economy_notice' && f.tournamentId === tournamentId)
}

console.log('\ncheckTournamentRefundLogoutSessionGuard\n')

let server: RunningServer | null = null
const isolated = await createIsolatedServerRoot(sourceServerRoot)
const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

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

  const host = await register(port, 'host', runId)
  const a = await register(port, 'a', runId)
  setWalletBalance(isolated.dbFile, a.profileId, 20_000)

  // ─── [1] Baseline: still authenticated -> popup arrives ─────────────────
  let t0: string = ''
  let wsA1: TestClient | null = null
  await check('[1] Profile A authenticated (single session) receives the creator-cancel refund popup', async () => {
    const cookieA1 = await login(port, a.email, a.password)
    wsA1 = await connectWs(port, cookieA1, a.profileId)
    t0 = await createTournament(port, host.cookie, 5000)
    await joinSolo(port, cookieA1, t0)
    await cancelTournament(port, host.cookie, t0)
    await waitForCondition('t0 notice frame', () => economyNoticeFrames(wsA1!, t0).length > 0, 5_000)
    const frame = economyNoticeFrames(wsA1!, t0)[0]
    assert(frame.reason === 'creator_cancelled', `expected reason creator_cancelled, got ${frame.reason}`)
    assert(frame.amount === 5000, `expected amount 5000, got ${frame.amount}`)
  })
  await check('[7] ledger/wallet correct after baseline cancel (A refunded exactly once, balance restored)', () => {
    assert(countLedgerRows(isolated.dbFile, t0, a.profileId, 'entry_fee_refund') === 1, 'expected exactly one refund ledger row')
    assert(getWalletBalance(isolated.dbFile, a.profileId) === 20_000, 'expected wallet balance restored to 20000')
  })

  // ─── [2]/[4]/[3]/[9]/[8]: logout -> cancel -> no popup -> persists -> ───
  // ─── delivered exactly once on next login -> no duplicate on 2nd reconnect
  let ta: string = ''
  await check('[2] After logout, the (now stale) connection receives NOTHING when the creator cancels', async () => {
    assert(wsA1 !== null, 'wsA1 must exist from [1]')
    const framesBeforeLogout = wsA1!.frames.length
    await logout(port, wsA1!.cookie)
    ta = await createTournament(port, host.cookie, 5000)
    // Re-login is needed to join (join requires an authenticated session) —
    // simulates A having joined BEFORE logging out in the reported scenario.
    // We join with a throwaway session so the WS opened for wsA1 stays the
    // one and only connection under test; its cookie is now invalidated.
    const joinCookie = await login(port, a.email, a.password)
    await joinSolo(port, joinCookie, ta)
    await logout(port, joinCookie)
    await cancelTournament(port, host.cookie, ta)
    await sleep(1500)
    assert(wsA1!.frames.length === framesBeforeLogout, 'the logged-out connection must receive no new frames at all')
    assert(economyNoticeFrames(wsA1!, ta).length === 0, 'the logged-out connection must not receive the refund popup')
  })
  await check('[4] The logged-out connection is actually closed server-side (removed from the registry)', async () => {
    await waitForCondition('wsA1 readyState CLOSED', () => wsA1!.ws.readyState === WebSocket.CLOSED, 5_000)
  })
  await check('[3] The refund notice persisted server-side, undelivered, right after the cancel', () => {
    const rows = getNoticeRows(isolated.dbFile, ta, a.profileId)
    assert(rows.length === 1, `expected exactly one durable notice row, got ${rows.length}`)
    assert(rows[0]!.reason === 'creator_cancelled', `expected reason creator_cancelled, got ${rows[0]!.reason}`)
    assert(rows[0]!.refunded_amount === 5000, `expected amount 5000, got ${rows[0]!.refunded_amount}`)
    assert(rows[0]!.delivered_at === null, 'notice must start undelivered — it was never actually pushed to anyone')
  })
  await check('[7] ledger/wallet correct even though A was logged out during the cancel', () => {
    assert(countLedgerRows(isolated.dbFile, ta, a.profileId, 'entry_fee_refund') === 1, 'expected exactly one refund ledger row')
    assert(getWalletBalance(isolated.dbFile, a.profileId) === 20_000, 'expected wallet balance restored to 20000')
  })
  let wsA2: TestClient | null = null
  await check('[3] Logging back in delivers the persisted notice automatically (no refresh/polling)', async () => {
    const cookieA2 = await login(port, a.email, a.password)
    wsA2 = await connectWs(port, cookieA2, a.profileId)
    await waitForCondition('flushed notice frame', () => economyNoticeFrames(wsA2!, ta).length > 0, 5_000)
    const frame = economyNoticeFrames(wsA2!, ta)[0]
    assert(frame.reason === 'creator_cancelled', `expected reason creator_cancelled, got ${frame.reason}`)
    assert(frame.amount === 5000, `expected amount 5000, got ${frame.amount}`)
  })
  await check('[3] The notice row is marked delivered after the flush', () => {
    const rows = getNoticeRows(isolated.dbFile, ta, a.profileId)
    assert(rows.length === 1, `expected exactly one durable notice row, got ${rows.length}`)
    assert(rows[0]!.delivered_at !== null, 'notice must be marked delivered after the connect-time flush')
  })
  await check('[9] A further reconnect receives nothing further for the same event (no duplicate realtime delivery)', async () => {
    const cookieA3 = await login(port, a.email, a.password)
    const wsA3 = await connectWs(port, cookieA3, a.profileId)
    await sleep(1500)
    assert(economyNoticeFrames(wsA3, ta).length === 0, 'a later reconnect must not re-show the same event as new')
    wsA3.ws.close()
  })
  await check('[8] Exactly one durable notice row ever exists for this (tournament, profile) pair', () => {
    const rows = getNoticeRows(isolated.dbFile, ta, a.profileId)
    assert(rows.length === 1, `expected exactly one row total, got ${rows.length}`)
  })

  // ─── [6] Multi-tab / multi-session isolation ─────────────────────────────
  // Note: this app already displaces (closes) any OLDER live WS connection
  // for a profile the moment a NEWER one connects (see
  // displaceProfileConnections in index.ts, unrelated to this bugfix) — so
  // two simultaneously-live connections for the same profile never coexist
  // regardless of logout. The scenario this fix actually protects against is
  // sharper: Tab X's connection is already gone (displaced by Tab Y opening
  // later), but Tab X's HTTP session cookie is still sitting in that old
  // tab's memory/storage. If the user goes back to Tab X and clicks
  // "logout" there, that must revoke ONLY session X — it must NEVER
  // collaterally kill Tab Y's still-active connection just because both
  // happen to belong to the same profileId (which a naive profileId-scoped
  // disconnect, instead of the sessionId-scoped one this fix uses, would
  // do).
  await check('[6] Logging out an old (already-displaced) session never disconnects a different, currently-active session for the same profile', async () => {
    const cookieX = await login(port, a.email, a.password)
    const wsX = await connectWs(port, cookieX, a.profileId)
    const cookieY = await login(port, a.email, a.password)
    const wsY = await connectWs(port, cookieY, a.profileId)

    // Pre-existing, unrelated behavior: Y's connect displaces X's connection.
    await waitForCondition('wsX displaced by wsY connecting', () => wsX.ws.readyState === WebSocket.CLOSED, 5_000)
    assert(wsY.ws.readyState === WebSocket.OPEN, 'sanity: Y must still be open right after connecting')

    // The actual regression this check guards: logging out the OLD, already
    // -dead session X must not touch Y's live connection.
    await logout(port, cookieX)
    await sleep(500)
    assert(wsY.ws.readyState === WebSocket.OPEN, 'logging out an unrelated (already-displaced) session must never close a different active session\'s connection')

    const tb = await createTournament(port, host.cookie, 5000)
    await joinSolo(port, cookieY, tb)
    await cancelTournament(port, host.cookie, tb)

    await waitForCondition('wsY notice frame', () => economyNoticeFrames(wsY, tb).length > 0, 5_000)
    assert(countLedgerRows(isolated.dbFile, tb, a.profileId, 'entry_fee_refund') === 1, 'expected exactly one refund ledger row')

    wsY.ws.close()
  })

  // ─── [5] Client-side defense-in-depth guard: static source presence ─────
  await check('[5] main.ts guards the popup handler against a missing authenticated session', async () => {
    const mainTs = await readFile(resolve(sourceServerRoot, '..', 'src', 'main.ts'), 'utf8')
    const handlerStart = mainTs.indexOf("message.type === 'tournament_economy_notice'")
    assert(handlerStart !== -1, 'tournament_economy_notice handler not found in main.ts')
    const handlerSlice = mainTs.slice(handlerStart, handlerStart + 1200)
    assert(handlerSlice.includes('currentAuthSession === null'), 'expected a currentAuthSession === null guard before showing the popup')
    assert(handlerSlice.indexOf('currentAuthSession === null') < handlerSlice.indexOf('tournamentEconomyNotification.handleIncoming'), 'the auth guard must run BEFORE the popup is shown')
  })
} finally {
  await stopServer(server)
  await isolated.cleanup()
}

console.log(`\ncheckTournamentRefundLogoutSessionGuard: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
