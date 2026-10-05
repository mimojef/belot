/**
 * checkBelotSpectatorVipAuthorization.ts
 *
 * Real spawned-server, real WebSocket + real canonical vipStore integration
 * test за Belot Spectator Mode VIP-only authorization (Phase 2C). Следва
 * established isolated-server pattern (checkBelotSpectatorWebSocket.ts /
 * checkPrivilegedGiftCoinsPolicyMatrix.ts: temp copy на server root +
 * изолирана SQLite DB + директно seed-нати акаунти/сесии).
 *
 * VIP статус се grant-ва/expire-ва през РЕАЛНИЯ server/src/db/vipStore.ts
 * (canonical source of truth, vip_status.active_until) — никакъв mock,
 * никаква spectator-specific VIP state.
 *
 *   [V1]  flag OFF + active VIP -> belot_spectate_denied feature_disabled
 *         (VIP gate-ът никога не се достига, ordering потвърден)
 *   [V2]  flag ON + no VIP -> vip_required
 *   [V3]  отказан (vip_required) watch НЕ consume-ва free VIP launch gift:
 *         hasClaimedLaunchGift остава false, vip_grants броя непроменен
 *   [V4]  active VIP (vipStore.grantVip) -> successful watch (started +
 *         spectator snapshot)
 *   [V5]  изтекъл VIP (active_until в миналото) -> vip_required
 *   [V6]  VIP изтича ДОКАТО вече гледа -> registry membership НЕ се
 *         прекъсва автоматично; snapshot-и продължават да идват
 *   [V7]  reconnect/re-watch след expiration -> vip_required
 *   [V8]  admin без VIP -> vip_required (без role bypass)
 *   [V9]  subadmin без VIP -> vip_required (без role bypass)
 *   [V10] marketing без VIP -> vip_required (без role bypass)
 *   [V11] privileged role (admin) + active VIP -> VIP gate-ът пуска
 *   [V12] denied watch invariants: няма registry entry (gameplay action
 *         след отказан watch гърми "not attached", никога
 *         spectator_action_forbidden), spectator никога не се появява в
 *         seats, никога не получава spectator snapshot, host-овото
 *         authoritative game state е непроменено от отказания watch
 */

import { randomBytes, randomUUID, scryptSync } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import WebSocket from 'ws'
import { createVipStore } from '../src/db/vipStore.js'

const SESSION_COOKIE_NAME = 'belot_session'
const STAKE = 5000

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
function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
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

async function waitForCondition(label: string, predicate: () => Promise<boolean> | boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await sleep(100)
  }
  throw new Error(`Timeout: ${label}`)
}

// ─── Isolated server ──────────────────────────────────────────────────────

const sourceServerRoot = resolve(
  process.argv.slice(2).find((a) => a.startsWith('--server-root='))?.slice('--server-root='.length) ?? process.cwd(),
)

async function retryRm(path: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try { await rm(path, { recursive: true, force: true }); return } catch { /* retry */ }
    await sleep(250)
  }
}

async function createIsolatedServerRoot(originalServerRoot: string) {
  const root = await mkdtemp(join(tmpdir(), 'belot-spectator-vip-'))
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
    databaseFile: join(serverDir, 'database', 'data', 'belot-v2.sqlite'),
    cleanup: () => retryRm(root),
  }
}

type RunningServer = { child: ChildProcessWithoutNullStreams; output(): string }

function startServer(serverDir: string, port: number, spectatorFlag: string | null): RunningServer {
  const chunks: string[] = []
  const env: Record<string, string | undefined> = { ...process.env, PORT: String(port) }
  if (spectatorFlag === null) delete env.BELOT_SPECTATOR_ENABLED
  else env.BELOT_SPECTATOR_ENABLED = spectatorFlag
  const child = spawn(
    process.execPath,
    [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'index.ts')],
    { cwd: serverDir, env, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (c) => chunks.push(c))
  child.stderr.on('data', (c) => chunks.push(c))
  return { child, output: () => chunks.join('') }
}

async function waitForServer(server: RunningServer, port: number): Promise<void> {
  try {
    await waitForCondition('backend health', async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/health`)
        const h = await r.json()
        return r.status === 200 && h.ok === true && h.gameWorkerLifecycle?.state === 'ready'
      } catch { return false }
    }, 45_000)
  } catch (err) {
    console.error('--- server output ---')
    console.error(server.output())
    throw err
  }
}

async function stopServer(server: RunningServer | null): Promise<void> {
  if (!server || server.child.exitCode !== null) return
  server.child.kill('SIGTERM')
  await new Promise<void>((r) => {
    const t = setTimeout(() => { server.child.kill('SIGKILL'); r() }, 10_000)
    server.child.once('exit', () => { clearTimeout(t); r() })
  })
}

// ─── Direct DB seeding (mirror на checkBelotSpectatorWebSocket.ts) ─────────

function hashSessionToken(token: string): string {
  return scryptSync(token, 'belot-v2-session-v1', 32).toString('hex')
}

type SeededUser = { cookie: string; profileId: string; accountId: string; tag: string }
type AccountRole = 'player' | 'admin' | 'subadmin' | 'marketing'

function seedUser(databaseFile: string, tag: string, role: AccountRole = 'player'): SeededUser {
  const db = new DatabaseSync(databaseFile, { open: true, timeout: 10_000 })
  db.exec('PRAGMA foreign_keys = ON;')
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const accountId = randomUUID()
  const profileId = randomUUID()
  const displayName = `Spec ${tag} ${runId.slice(-4)}`
  const normalized = displayName.toLowerCase()
  const token = randomBytes(32).toString('base64url')
  db.exec('BEGIN IMMEDIATE;')
  try {
    db.prepare(`INSERT INTO accounts (account_id, email, password_hash, role, status) VALUES (?, ?, 'not-used-seeded-directly', ?, 'active');`)
      .run(accountId, `belot-spectator-vip-${tag}-${runId}@example.test`, role)
    db.prepare(`
      INSERT INTO profiles (
        profile_id, account_id, profile_kind, username, normalized_username,
        display_name, normalized_display_name, avatar_url, level, rank_title,
        skill_rating, gender, status
      ) VALUES (?, ?, 'human', ?, ?, ?, ?, NULL, 1, 'Rank 1', 1000, 'male', 'active');
    `).run(profileId, accountId, displayName, normalized, displayName, normalized)
    db.prepare(`INSERT INTO profile_wallets (profile_id, yellow_coins_balance) VALUES (?, 50000);`).run(profileId)
    db.prepare(`INSERT INTO profile_progress (profile_id, completed_games_count, won_games_count, rank_level) VALUES (?, 0, 0, 1);`).run(profileId)
    db.prepare(`INSERT INTO account_sessions (session_id, account_id, profile_id, token_hash, expires_at) VALUES (?, ?, ?, ?, ?);`)
      .run(randomUUID(), accountId, profileId, hashSessionToken(token), new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString())
    db.exec('COMMIT;')
  } catch (error) {
    try { db.exec('ROLLBACK;') } catch { /* keep original */ }
    throw error
  } finally {
    db.close()
  }
  return { cookie: `${SESSION_COOKIE_NAME}=${token}`, profileId, accountId, tag }
}

function countRows(databaseFile: string, sql: string, ...params: Array<string | number>): number {
  const db = new DatabaseSync(databaseFile, { open: true, timeout: 10_000 })
  try {
    return (db.prepare(sql).get(...params) as { c: number }).c
  } finally {
    db.close()
  }
}

// Grant/read VIP статус през РЕАЛНИЯ canonical vipStore — отделна connection
// от сървърния процес (WAL + busy_timeout вече конфигурирани в
// createVipStore), затворена веднага след всяка операция.
async function grantVip(databaseFile: string, profileId: string, days = 30): Promise<void> {
  const store = await createVipStore(databaseFile)
  try {
    store.grantVip(profileId, 'admin_grant', { unit: 'days', amount: days })
  } finally {
    store.close()
  }
}

// Директно записва active_until в миналото — симулира естествено изтекъл
// VIP (времето просто е минало), не измисля нов expiration механизъм.
// Форматът е идентичен на toSqliteDateTimeString() в vipStore.ts.
function expireVipDirectly(databaseFile: string, profileId: string): void {
  const db = new DatabaseSync(databaseFile, { open: true, timeout: 10_000 })
  try {
    db.prepare(`UPDATE vip_status SET active_until = ? WHERE profile_id = ?;`).run('2000-01-01 00:00:00', profileId)
  } finally {
    db.close()
  }
}

// ─── WS clients ───────────────────────────────────────────────────────────

type TestClient = { user: SeededUser; ws: WebSocket; frames: any[]; label: string }

async function connectClient(port: number, user: SeededUser, label: string): Promise<TestClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: user.cookie } })
  const frames: any[] = []
  ws.on('message', (data) => {
    try { frames.push({ ...JSON.parse(data.toString()), __receivedAt: Date.now() }) } catch { /* ignore */ }
  })
  await new Promise<void>((resolveOpen, reject) => {
    ws.once('open', () => resolveOpen())
    ws.once('error', reject)
  })
  return { user, ws, frames, label }
}

function send(client: TestClient, message: Record<string, unknown>): void {
  client.ws.send(JSON.stringify(message))
}

async function waitForFrame(client: TestClient, predicate: (frame: any) => boolean, timeoutMs = 10_000, label = 'frame', fromIndex = 0): Promise<any> {
  await waitForCondition(`${client.label}: ${label}`, () => client.frames.slice(fromIndex).some(predicate), timeoutMs)
  return client.frames.slice(fromIndex).find(predicate)
}

function latestRoomSnapshot(client: TestClient, roomId: string): any | null {
  for (let i = client.frames.length - 1; i >= 0; i--) {
    const frame = client.frames[i]
    if (frame.type === 'room_snapshot' && frame.roomId === roomId) return frame
  }
  return null
}

// Стабилно подмножество от authoritative game state, незасегнато от
// нормалните timer tick-ове — използва се за "room revision unchanged" (V12).
function gameStateFingerprint(snap: any): string {
  const game = snap?.game
  return JSON.stringify([
    game?.authoritativePhase,
    game?.bidding?.entries?.length ?? null,
    game?.bidding?.winningBid ?? null,
    game?.playing?.completedTricksCount ?? null,
    game?.playing?.currentTrickPlays?.length ?? null,
    game?.scoring ?? null,
    game?.matchEnded ?? null,
  ])
}

async function httpJson(port: number, method: string, pathname: string, cookie: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  let json: any = null
  try { json = await res.json() } catch { /* not json */ }
  return { status: res.status, body: json }
}

// ─── Run ──────────────────────────────────────────────────────────────────

console.log('\ncheckBelotSpectatorVipAuthorization\n')

// ── [V1] Server 1: flag OFF, but attacker already has active VIP ──────────
{
  let server: RunningServer | null = null
  const isolated = await createIsolatedServerRoot(sourceServerRoot)
  try {
    const port = await findFreePort()
    server = startServer(isolated.serverDir, port, null)
    console.log(`[flag OFF + active VIP] waiting for server on ${port}...`)
    await waitForServer(server, port)
    const user = seedUser(isolated.databaseFile, 'flagoff-vip')
    await grantVip(isolated.databaseFile, user.profileId)
    const client = await connectClient(port, user, 'flagoff-vip')
    await check('[V1] feature flag OFF + active VIP -> feature_disabled (VIP gate never reached)', async () => {
      send(client, { type: 'watch_belot_room', roomId: 'any-room-id' })
      const denied = await waitForFrame(client, (f) => f.type === 'belot_spectate_denied', 5_000, 'denied')
      assert(denied.code === 'feature_disabled', `code=${denied.code}`)
      await sleep(300)
      assert(!client.frames.some((f) => f.type === 'belot_spectate_started' || f.type === 'belot_spectator_snapshot'), 'no spectator stream when flag is OFF, regardless of VIP')
    })
    client.ws.close()
  } finally {
    await stopServer(server)
    await isolated.cleanup()
  }
}

// ── Server 2: flag ON ────────────────────────────────────────────────────
let server: RunningServer | null = null
const isolated = await createIsolatedServerRoot(sourceServerRoot)
const dbFile = isolated.databaseFile
const openClients: TestClient[] = []

try {
  const port = await findFreePort()
  server = startServer(isolated.serverDir, port, '1')
  console.log(`[flag ON] waiting for server on ${port}...`)
  await waitForServer(server, port)
  console.log('Server ready.\n')

  const hostUser = seedUser(dbFile, 'host')
  const guestUser = seedUser(dbFile, 'guest')
  const normalNoVip = seedUser(dbFile, 'normal-no-vip')
  const adminNoVip = seedUser(dbFile, 'admin-no-vip', 'admin')
  const subadminNoVip = seedUser(dbFile, 'subadmin-no-vip', 'subadmin')
  const marketingNoVip = seedUser(dbFile, 'marketing-no-vip', 'marketing')
  const adminWithVip = seedUser(dbFile, 'admin-with-vip', 'admin')
  const expiredVipUser = seedUser(dbFile, 'expired-vip')

  const host = await connectClient(port, hostUser, 'host')
  const guest = await connectClient(port, guestUser, 'guest')
  openClients.push(host, guest)

  // ── Private table: host(A) + bot(A) vs guest(B) + bot(B) ─────────────────
  send(host, { type: 'create_private_room', stake: STAKE, isLocked: false })
  const created = await waitForFrame(host, (f) => f.type === 'private_room_updated', 10_000, 'private room created')
  send(host, { type: 'add_bot_to_private_room_team', team: 'A' })
  await waitForFrame(host, (f) => f.type === 'private_room_updated' && f.room.slots.filter((s: any) => s.occupant !== null).length === 2, 10_000, 'bot A')
  send(guest, { type: 'join_private_room', privateRoomId: created.room.id, team: 'B', slotIndex: 0 })
  await waitForFrame(guest, (f) => f.type === 'private_room_updated' && f.room.slots.filter((s: any) => s.occupant !== null).length === 3, 10_000, 'guest joined')
  send(guest, { type: 'add_bot_to_private_room_team', team: 'B' })
  const hostFull = await waitForFrame(host, (f) => f.type === 'private_room_full', 15_000, 'private_room_full')
  const roomId: string = hostFull.roomId
  await waitForFrame(host, (f) => f.type === 'room_snapshot' && f.roomId === roomId && f.game?.authoritativePhase, 15_000, 'active game snapshot')
  console.log(`game room=${roomId}\n`)

  // Сървърът държи ЕДНА live сесия на профил извън игра (same semantics as
  // checkBelotSpectatorWebSocket.ts [W11]): нов connect със СЪЩАТА session
  // cookie displace-ва старата connection. V2/V3/V4/V6 затова ПРЕИЗПОЛЗВАТ
  // една и съща connection за normalNoVip — нова connection тук би изтласкала
  // старата и направила по-късните assertions (V6: "still receiving frames
  // on the ORIGINAL connection") невалидни. Само V7 explicit disconnect-va и
  // reconnect-va (симулира реален client reconnect).
  const vipHolder = normalNoVip
  let vipHolderClient = await connectClient(port, vipHolder, 'vip-holder')
  openClients.push(vipHolderClient)

  // ── [V2] no VIP -> vip_required ────────────────────────────────────────
  await check('[V2] flag ON + no VIP -> vip_required', async () => {
    const from = vipHolderClient.frames.length
    send(vipHolderClient, { type: 'watch_belot_room', roomId })
    const denied = await waitForFrame(vipHolderClient, (f) => f.type === 'belot_spectate_denied', 5_000, 'denied', from)
    assert(denied.code === 'vip_required', `code=${denied.code}`)
    assert(!vipHolderClient.frames.slice(from).some((f) => f.type === 'belot_spectate_started' || f.type === 'belot_spectator_snapshot'), 'no spectator stream without VIP')
  })

  // ── [V3] denied watch never consumes the free VIP launch gift ──────────
  await check('[V3] vip_required denial does not consume the free VIP launch gift', async () => {
    const statusBefore = await httpJson(port, 'GET', '/api/vip/status', vipHolder.cookie)
    assert(statusBefore.status === 200 && statusBefore.body.hasClaimedLaunchGift === false, `before: ${JSON.stringify(statusBefore.body)}`)
    const grantsBefore = countRows(dbFile, 'SELECT COUNT(*) AS c FROM vip_grants WHERE profile_id = ?', vipHolder.profileId)
    assert(grantsBefore === 0, `grants before=${grantsBefore}`)

    const from = vipHolderClient.frames.length
    send(vipHolderClient, { type: 'watch_belot_room', roomId })
    const denied = await waitForFrame(vipHolderClient, (f) => f.type === 'belot_spectate_denied', 5_000, 'denied', from)
    assert(denied.code === 'vip_required', `code=${denied.code}`)

    const statusAfter = await httpJson(port, 'GET', '/api/vip/status', vipHolder.cookie)
    assert(statusAfter.status === 200 && statusAfter.body.hasClaimedLaunchGift === false, `after: ${JSON.stringify(statusAfter.body)}`)
    assert(statusAfter.body.status.isActive === false, `vip must still be inactive: ${JSON.stringify(statusAfter.body.status)}`)
    const grantsAfter = countRows(dbFile, 'SELECT COUNT(*) AS c FROM vip_grants WHERE profile_id = ?', vipHolder.profileId)
    assert(grantsAfter === 0, `grants after=${grantsAfter} (nothing may be consumed/created by a denied watch)`)
  })

  // ── [V4] active VIP -> successful watch ────────────────────────────────
  await check('[V4] active VIP (canonical vipStore.grantVip) -> successful watch', async () => {
    await grantVip(dbFile, vipHolder.profileId)
    const from = vipHolderClient.frames.length
    send(vipHolderClient, { type: 'watch_belot_room', roomId })
    const started = await waitForFrame(vipHolderClient, (f) => f.type === 'belot_spectate_started', 5_000, 'started', from)
    assert(started.roomId === roomId, 'ACK roomId')
    const snap = await waitForFrame(vipHolderClient, (f) => f.type === 'belot_spectator_snapshot', 5_000, 'snapshot', from)
    assert(snap.viewerRole === 'spectator' && snap.yourSeat === null, 'valid spectator snapshot')
  })

  // ── [V5] expired VIP -> vip_required ───────────────────────────────────
  await check('[V5] expired VIP (active_until in the past) -> vip_required', async () => {
    await grantVip(dbFile, expiredVipUser.profileId, 1)
    expireVipDirectly(dbFile, expiredVipUser.profileId)
    const client = await connectClient(port, expiredVipUser, 'expired-vip')
    openClients.push(client)
    send(client, { type: 'watch_belot_room', roomId })
    const denied = await waitForFrame(client, (f) => f.type === 'belot_spectate_denied', 5_000, 'denied')
    assert(denied.code === 'vip_required', `code=${denied.code}`)
  })

  // ── [V6] VIP expires WHILE already spectating -> no auto-kick ─────────
  await check('[V6] VIP expiring mid-spectate does not end the existing subscription', async () => {
    const before = vipHolderClient.frames.filter((f) => f.type === 'belot_spectator_snapshot').length
    expireVipDirectly(dbFile, vipHolder.profileId)
    // no unwatch/re-watch happens here — only time (simulated) passing.
    await waitForCondition('spectator keeps receiving snapshots after VIP expiry', () => {
      return vipHolderClient.frames.filter((f) => f.type === 'belot_spectator_snapshot').length > before
    }, 30_000)
    assert(!vipHolderClient.frames.some((f) => f.type === 'belot_spectate_ended'), 'no forced end event from VIP expiry alone')
  })

  // ── [V7] reconnect/re-watch after expiration -> vip_required ──────────
  await check('[V7] disconnect + reconnect + re-watch after expiration -> vip_required', async () => {
    vipHolderClient.ws.close()
    await sleep(500)
    vipHolderClient = await connectClient(port, vipHolder, 'vip-holder-reconnect')
    openClients.push(vipHolderClient)
    send(vipHolderClient, { type: 'watch_belot_room', roomId })
    const denied = await waitForFrame(vipHolderClient, (f) => f.type === 'belot_spectate_denied', 5_000, 'denied after expiry')
    assert(denied.code === 'vip_required', `code=${denied.code}`)
  })

  // ── [V8]/[V9]/[V10] privileged roles without VIP -> vip_required ──────
  for (const [label, user] of [
    ['admin', adminNoVip],
    ['subadmin', subadminNoVip],
    ['marketing', marketingNoVip],
  ] as const) {
    await check(`[V8-10] ${label} without VIP -> vip_required (no role bypass)`, async () => {
      const client = await connectClient(port, user, `${label}-no-vip`)
      openClients.push(client)
      send(client, { type: 'watch_belot_room', roomId })
      const denied = await waitForFrame(client, (f) => f.type === 'belot_spectate_denied', 5_000, 'denied')
      assert(denied.code === 'vip_required', `${label}: code=${denied.code}`)
    })
  }

  // ── [V11] privileged role WITH active VIP -> gate passes ──────────────
  await check('[V11] admin WITH active VIP -> VIP gate passes', async () => {
    await grantVip(dbFile, adminWithVip.profileId)
    const client = await connectClient(port, adminWithVip, 'admin-with-vip')
    openClients.push(client)
    send(client, { type: 'watch_belot_room', roomId })
    const started = await waitForFrame(client, (f) => f.type === 'belot_spectate_started', 5_000, 'started')
    assert(started.roomId === roomId, 'admin with VIP must be able to watch like any other VIP profile')
    await waitForFrame(client, (f) => f.type === 'belot_spectator_snapshot', 5_000, 'snapshot')
    client.ws.close()
  })

  // ── [V12] denied watch invariants ──────────────────────────────────────
  await check('[V12] denied watch: no registry entry, no seat, no snapshot, host game state unchanged', async () => {
    const deniedUser = seedUser(dbFile, 'denied-invariants')
    const client = await connectClient(port, deniedUser, 'denied-invariants')
    openClients.push(client)

    const beforeFingerprint = gameStateFingerprint(latestRoomSnapshot(host, roomId))
    send(client, { type: 'watch_belot_room', roomId })
    const denied = await waitForFrame(client, (f) => f.type === 'belot_spectate_denied', 5_000, 'denied')
    assert(denied.code === 'vip_required', `code=${denied.code}`)
    await sleep(500)

    // Никога spectator snapshot и никога seat.
    assert(!client.frames.some((f) => f.type === 'belot_spectator_snapshot'), 'denied profile must never receive a spectator snapshot')
    const hostSnap = latestRoomSnapshot(host, roomId)
    assert(!hostSnap.seats.some((s: any) => s.profileId === deniedUser.profileId), 'denied profile must never occupy a seat')

    // Регистрацията никога не се е случила: gameplay action след отказа
    // гърми "not attached" (not-a-participant), НЕ spectator_action_forbidden
    // (което би означавало, че registry-то все пак го смята за spectator).
    const from = client.frames.length
    send(client, { type: 'submit_play_card', roomId, cardId: 'hearts-A' })
    const error = await waitForFrame(client, (f) => f.type === 'error', 5_000, 'not attached', from)
    assert(error.code !== 'spectator_action_forbidden' && /not attached/i.test(error.message), `expected "not attached", got ${JSON.stringify(error)}`)

    // Host-овото authoritative game state не е мутирано от отказания watch.
    const afterFingerprint = gameStateFingerprint(latestRoomSnapshot(host, roomId))
    assert(beforeFingerprint === afterFingerprint, `game state changed from denied watch: before=${beforeFingerprint} after=${afterFingerprint}`)
  })
} finally {
  for (const client of openClients) {
    try { client.ws.close() } catch { /* ignore */ }
  }
  await stopServer(server)
  await isolated.cleanup()
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
process.exit(0)
