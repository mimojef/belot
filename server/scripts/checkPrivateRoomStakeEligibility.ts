/**
 * checkPrivateRoomStakeEligibility.ts
 *
 * Real spawned-server, real WebSocket integration test for the private-room
 * "create" gating added to fix a class of bugs where a private table could
 * be created for a stake that isn't configured (or no longer configured),
 * or by a creator whose balance/level doesn't actually cover the stake —
 * leaving a "broken" table nobody can ever start.
 *
 * Follows the exact isolated-server + real-WebSocket pattern established by
 * checkPrivateRoomWebSocketRoundTrip.ts, plus the admin-login pattern from
 * checkPlayersPagination.ts (register -> flip accounts.role='admin' via a
 * direct SQLite write against the live WAL database -> login for a real
 * session cookie) to drive the /api/admin/rooms config endpoint, and direct
 * profile_wallets / profiles.level writes to control a test player's
 * balance/level (there is no admin API for either — see check [3]/[4]).
 *
 * Scenarios (see task spec):
 *  1. Configure 5000 and 20000 (minLevel=1), remove 10000 -> the server's
 *     enabled-stakes list (what the frontend dropdown is sourced from)
 *     contains 5000/20000 and NOT 10000.
 *  2. A manual create_private_room request for the removed stake 10000 is
 *     rejected by the server (code=private_room_stake_unavailable), no room
 *     is created, and no private_room_created_notice is broadcast to other
 *     connections.
 *  3. A player with balance 19999 tries to create a stake-20000 table ->
 *     rejected (code=private_room_insufficient_balance), no room created.
 *  4. A player with level 14 tries a stake requiring level 16 -> rejected
 *     (code=private_room_level_required), message names both the required
 *     and current level, no room created.
 *  5. A player with sufficient balance and level creates the same stake
 *     normally -> private_room_updated confirms the room, and the existing
 *     realtime flow (join_private_room) still works.
 *  6. A valid stake is disabled between "popup open" (client had a stale
 *     copy) and "Създай" (server re-validates at request time) -> rejected
 *     safely (code=private_room_stake_unavailable), no room created.
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

// ─── Isolated server (same model as checkPrivateRoomWebSocketRoundTrip.ts) ─

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
  const root = await mkdtemp(join(tmpdir(), 'belot-private-room-stake-'))
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
  const email = `private-room-stake-${tag}-${runId}@example.test`
  const reg = await httpJson(port, 'POST', '/api/auth/register', null, {
    email,
    password: 'PrivateRoomStakeDiag1!',
    displayName: `PRS ${tag}`,
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

async function adminUpsertRoom(
  port: number,
  adminCookie: string,
  room: { stakeAmount: number; minLevel: number; prizeAmount: number; isEnabled: boolean },
): Promise<any> {
  const res = await httpJson(port, 'POST', '/api/admin/rooms', adminCookie, room)
  if (res.status !== 200 || res.body?.ok !== true) {
    throw new Error(`admin upsert room failed: ${res.status} ${JSON.stringify(res.body)}`)
  }
  return res.body
}

async function adminDeleteRoom(port: number, adminCookie: string, stakeAmount: number): Promise<any> {
  const res = await httpJson(port, 'DELETE', `/api/admin/rooms/${stakeAmount}`, adminCookie)
  if (res.status !== 200 || res.body?.ok !== true) {
    throw new Error(`admin delete room failed: ${res.status} ${JSON.stringify(res.body)}`)
  }
  return res.body
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

function setProfileLevel(dbFile: string, profileId: string, level: number): void {
  const db = new DatabaseSync(dbFile, { open: true, enableForeignKeyConstraints: true })
  try {
    db.prepare(`UPDATE profiles SET level = ? WHERE profile_id = ?`).run(level, profileId)
  } finally {
    db.close()
  }
}

console.log('\ncheckPrivateRoomStakeEligibility\n')

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

  // ─── Admin session (register -> flip role='admin' via direct DB write -> login) ─
  const adminEmail = `private-room-stake-admin-${runId}@example.test`
  const adminReg = await httpJson(port, 'POST', '/api/auth/register', null, {
    email: adminEmail,
    password: 'PrivateRoomStakeAdmin1!',
    displayName: 'PRS Admin',
    gender: 'male',
  })
  if (adminReg.status !== 200) throw new Error(`Admin registration failed: ${JSON.stringify(adminReg.body)}`)

  {
    const db = new DatabaseSync(isolated.dbFile, { open: true, enableForeignKeyConstraints: true })
    db.prepare(`UPDATE accounts SET role='admin' WHERE email=?`).run(adminEmail)
    db.close()
  }

  const adminLogin = await httpJson(port, 'POST', '/api/auth/login', null, {
    email: adminEmail,
    password: 'PrivateRoomStakeAdmin1!',
  })
  const adminCookie = adminLogin.setCookie
  if (!adminCookie) throw new Error('No Set-Cookie on admin login')

  // ───────────────────────────────────────────────────────────────────────
  // Scenario 1+2: configure 5000 and 20000, remove 10000. Dropdown source
  // (enabled stakes) reflects it, and a manual create for 10000 is rejected.
  // ───────────────────────────────────────────────────────────────────────
  console.log('--- Scenario 1+2: unconfigured stake (10000) ---')

  await adminUpsertRoom(port, adminCookie, { stakeAmount: 5000, minLevel: 1, prizeAmount: 8000, isEnabled: true })
  await adminUpsertRoom(port, adminCookie, { stakeAmount: 20000, minLevel: 16, prizeAmount: 30000, isEnabled: true })
  const afterDelete = await adminDeleteRoom(port, adminCookie, 10000)

  await check('[1] enabled-stakes config (dropdown source) contains 5000 and 20000, not 10000', () => {
    const stakes: number[] = afterDelete.rooms.map((r: any) => r.stakeAmount)
    if (!stakes.includes(5000)) throw new Error(`stakes=${JSON.stringify(stakes)} missing 5000`)
    if (!stakes.includes(20000)) throw new Error(`stakes=${JSON.stringify(stakes)} missing 20000`)
    if (stakes.includes(10000)) throw new Error(`stakes=${JSON.stringify(stakes)} still contains removed 10000`)
  })

  const { cookie: unconfCookie, profileId: unconfProfileId } = await registerAndLogin(port, 'unconf', runId)
  setWalletBalance(isolated.dbFile, unconfProfileId, 50_000)
  const unconfClient = await connectWs(port, unconfCookie, unconfProfileId)
  const { cookie: observerCookie, profileId: observerProfileId } = await registerAndLogin(port, 'observer', runId)
  const observer = await connectWs(port, observerCookie, observerProfileId)

  send(unconfClient, { type: 'create_private_room', stake: 10000, isLocked: false, waitMinutes: 15 })

  await check('[2a] manual create_private_room for a removed/unconfigured stake is rejected with private_room_stake_unavailable', async () => {
    const errorFrame = await waitForFrame(unconfClient, (f) => f.type === 'error', 5_000, 'unconfigured stake rejection')
    if (errorFrame.code !== 'private_room_stake_unavailable') throw new Error(`code=${errorFrame.code}, message=${errorFrame.message}`)
  })

  await check('[2b] no private_room_updated (room creation) frame arrives for the rejected request', async () => {
    const clean = await noFrameArrives(unconfClient, (f) => f.type === 'private_room_updated')
    if (!clean) throw new Error('a private_room_updated frame arrived despite the stake being unconfigured')
  })

  await check('[2c] no private_room_created_notice is broadcast to other connections', async () => {
    const clean = await noFrameArrives(observer, (f) => f.type === 'private_room_created_notice')
    if (!clean) throw new Error('observer received a private_room_created_notice for a rejected create')
  })

  // ───────────────────────────────────────────────────────────────────────
  // Scenario 3: insufficient balance (19999 vs stake 20000).
  // ───────────────────────────────────────────────────────────────────────
  console.log('\n--- Scenario 3: insufficient balance ---')

  const { cookie: poorCookie, profileId: poorProfileId } = await registerAndLogin(port, 'poor', runId)
  setWalletBalance(isolated.dbFile, poorProfileId, 19_999)
  setProfileLevel(isolated.dbFile, poorProfileId, 20)
  const poorClient = await connectWs(port, poorCookie, poorProfileId)

  send(poorClient, { type: 'create_private_room', stake: 20000, isLocked: false, waitMinutes: 15 })

  await check('[3a] create_private_room with balance 19999 for stake 20000 is rejected with private_room_insufficient_balance', async () => {
    const errorFrame = await waitForFrame(poorClient, (f) => f.type === 'error', 5_000, 'insufficient balance rejection')
    if (errorFrame.code !== 'private_room_insufficient_balance') throw new Error(`code=${errorFrame.code}, message=${errorFrame.message}`)
  })

  await check('[3b] no room is created for the insufficient-balance request', async () => {
    const clean = await noFrameArrives(poorClient, (f) => f.type === 'private_room_updated')
    if (!clean) throw new Error('a private_room_updated frame arrived despite insufficient balance')
  })

  // ───────────────────────────────────────────────────────────────────────
  // Scenario 4: insufficient level (14 vs required 16 for stake 20000).
  // ───────────────────────────────────────────────────────────────────────
  console.log('\n--- Scenario 4: insufficient level ---')

  const { cookie: lowLevelCookie, profileId: lowLevelProfileId } = await registerAndLogin(port, 'lowlevel', runId)
  setWalletBalance(isolated.dbFile, lowLevelProfileId, 50_000)
  setProfileLevel(isolated.dbFile, lowLevelProfileId, 14)
  const lowLevelClient = await connectWs(port, lowLevelCookie, lowLevelProfileId)

  send(lowLevelClient, { type: 'create_private_room', stake: 20000, isLocked: false, waitMinutes: 15 })

  await check('[4a] create_private_room with level 14 for a stake requiring level 16 is rejected with private_room_level_required', async () => {
    const errorFrame = await waitForFrame(lowLevelClient, (f) => f.type === 'error', 5_000, 'insufficient level rejection')
    if (errorFrame.code !== 'private_room_level_required') throw new Error(`code=${errorFrame.code}, message=${errorFrame.message}`)
  })

  await check('[4b] the rejection message names both the required level (16) and the current level (14)', async () => {
    const errorFrame = [...lowLevelClient.frames].reverse().find((f) => f.type === 'error' && f.code === 'private_room_level_required')
    if (!errorFrame.message.includes('16')) throw new Error(`message missing required level: ${errorFrame.message}`)
    if (!errorFrame.message.includes('14')) throw new Error(`message missing current level: ${errorFrame.message}`)
  })

  await check('[4c] no room is created for the insufficient-level request', async () => {
    const clean = await noFrameArrives(lowLevelClient, (f) => f.type === 'private_room_updated')
    if (!clean) throw new Error('a private_room_updated frame arrived despite insufficient level')
  })

  // ───────────────────────────────────────────────────────────────────────
  // Scenario 5: sufficient balance and level -> normal creation, and the
  // existing realtime join flow still works.
  // ───────────────────────────────────────────────────────────────────────
  console.log('\n--- Scenario 5: eligible creator (happy path unaffected) ---')

  const { cookie: hostCookie, profileId: hostProfileId } = await registerAndLogin(port, 'host', runId)
  setWalletBalance(isolated.dbFile, hostProfileId, 50_000)
  setProfileLevel(isolated.dbFile, hostProfileId, 20)
  const hostClient = await connectWs(port, hostCookie, hostProfileId)

  send(hostClient, { type: 'create_private_room', stake: 20000, isLocked: false, waitMinutes: 15 })
  const created = await waitForFrame(hostClient, (f) => f.type === 'private_room_updated', 10_000, 'eligible create ack')
  const roomId: string = created.room.id

  await check('[5a] an eligible creator (sufficient balance and level) gets a normal private_room_updated with 1 member', () => {
    if (created.room.stake !== 20000) throw new Error(`room.stake=${created.room.stake}`)
    if (created.room.members.length !== 1) throw new Error(`members.length=${created.room.members.length}`)
  })

  const { cookie: guestCookie, profileId: guestProfileId } = await registerAndLogin(port, 'guest', runId)
  setWalletBalance(isolated.dbFile, guestProfileId, 50_000)
  setProfileLevel(isolated.dbFile, guestProfileId, 20)
  const guestClient = await connectWs(port, guestCookie, guestProfileId)

  send(guestClient, { type: 'join_private_room', privateRoomId: roomId })
  await check('[5b] the existing join_private_room realtime flow still works after adding eligibility gating', async () => {
    const updated = await waitForFrame(hostClient, (f) => f.type === 'private_room_updated' && f.room.members.length === 2, 10_000, 'host sees 2nd member')
    if (updated.room.id !== roomId) throw new Error('room id mismatch after join')
  })

  // ───────────────────────────────────────────────────────────────────────
  // Scenario 6: a valid stake is disabled between "popup open" and
  // "Създай" (client had a stale copy) -> server re-validates and rejects.
  // ───────────────────────────────────────────────────────────────────────
  console.log('\n--- Scenario 6: stake disabled after popup opened (stale client) ---')

  const { cookie: staleCookie, profileId: staleProfileId } = await registerAndLogin(port, 'stale', runId)
  setWalletBalance(isolated.dbFile, staleProfileId, 50_000)
  setProfileLevel(isolated.dbFile, staleProfileId, 20)
  const staleClient = await connectWs(port, staleCookie, staleProfileId)

  // Simulate the client having loaded the dropdown while 5000 was still
  // enabled, then the admin disabling it before the client submits.
  await adminUpsertRoom(port, adminCookie, { stakeAmount: 5000, minLevel: 1, prizeAmount: 8000, isEnabled: false })

  send(staleClient, { type: 'create_private_room', stake: 5000, isLocked: false, waitMinutes: 15 })

  await check('[6a] a stake disabled after the popup was opened is safely rejected at request time', async () => {
    const errorFrame = await waitForFrame(staleClient, (f) => f.type === 'error', 5_000, 'stale-client disabled-stake rejection')
    if (errorFrame.code !== 'private_room_stake_unavailable') throw new Error(`code=${errorFrame.code}, message=${errorFrame.message}`)
  })

  await check('[6b] no room is created for the stale disabled-stake request', async () => {
    const clean = await noFrameArrives(staleClient, (f) => f.type === 'private_room_updated')
    if (!clean) throw new Error('a private_room_updated frame arrived despite the stake being disabled at request time')
  })

  // ─── Cleanup ──────────────────────────────────────────────────────────
  for (const c of [unconfClient, observer, poorClient, lowLevelClient, hostClient, guestClient, staleClient]) {
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
