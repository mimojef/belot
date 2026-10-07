/**
 * checkBelotRoomSpectatorsPresence.ts
 *
 * Belot viewer-indicator ("{име} гледа вашата игра") — server side.
 * Real spawned-server + real WebSocket (helpers mirror на
 * checkBelotSpectatorPublicReactions.ts) + in-process unit проверки на
 * buildBelotRoomSpectatorsMessage.
 *
 *   [S1]  първи spectator -> participants получават list = 1
 *   [S2]  spectator-ът НЕ получава belot_room_spectators
 *   [S3]  втори profile -> list = 2
 *   [S4]  същият profile от втори таб -> един ред; без 1 -> 0 -> 1 мигане
 *   [S5]  unwatch -> update
 *   [S6]  disconnect -> update
 *   [S7]  последният излиза -> []
 *   [S8]  друга стая не е засегната
 *   [S9]  participant resume_room -> текущият list веднага
 *   [S10] public shape е точно { profileId, displayName }
 *   [U1]  unit: builder dedup-ва по profileId, пропуска unresolved, fallback име
 *   [U2]  source review: известяване при watch/unwatch/disconnect/replaced/
 *         defensive cleanup/resume; само към participants
 */

import { randomBytes, randomUUID, scryptSync } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import WebSocket from 'ws'
import { createVipStore } from '../src/db/vipStore.js'
import { createBelotSpectatorRegistry } from '../src/core/belotSpectatorRegistry.js'
import { buildBelotRoomSpectatorsMessage } from '../src/core/buildBelotRoomSpectatorsMessage.js'


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
  const root = await mkdtemp(join(tmpdir(), 'belot-spectator-presence-'))
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

// ─── Direct DB seeding (mirror на checkPrivilegedGiftCoinsPolicyMatrix.ts) ──

function hashSessionToken(token: string): string {
  return scryptSync(token, 'belot-v2-session-v1', 32).toString('hex')
}

type SeededUser = { cookie: string; profileId: string; accountId: string; tag: string }

function seedUser(databaseFile: string, tag: string, role: 'player' | 'pika_team' = 'player'): SeededUser {
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
      .run(accountId, `belot-spectator-${tag}-${runId}@example.test`, role)
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

// Phase 2C: grant-ва активен VIP чрез РЕАЛНИЯ canonical vipStore (не mock,
// не отделна spectator-specific таблица) — виж server/src/db/vipStore.ts.
// Отделна connection от сървърния процес, затворена веднага след grant-а
// (WAL + busy_timeout вече конфигурирани в createVipStore).
async function grantVip(databaseFile: string, profileId: string, days = 30): Promise<void> {
  const store = await createVipStore(databaseFile)
  try {
    store.grantVip(profileId, 'admin_grant', { unit: 'days', amount: days })
  } finally {
    store.close()
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

// ─── Helpers (Phase 4A) ───────────────────────────────────────────────────

function stripMeta(frame: any): any {
  const { __receivedAt: _ignored, ...rest } = frame
  return rest
}

async function createPrivateTable(host: TestClient, guest: TestClient): Promise<{ roomId: string; hostSeat: string; guestSeat: string }> {
  send(host, { type: 'create_private_room', stake: STAKE, isLocked: false })
  const created = await waitForFrame(host, (f) => f.type === 'private_room_updated', 10_000, 'private room created')
  send(host, { type: 'add_bot_to_private_room_team', team: 'A' })
  await waitForFrame(host, (f) => f.type === 'private_room_updated' && f.room.slots.filter((s: any) => s.occupant !== null).length === 2, 10_000, 'bot A')
  send(guest, { type: 'join_private_room', privateRoomId: created.room.id, team: 'B', slotIndex: 0 })
  await waitForFrame(guest, (f) => f.type === 'private_room_updated' && f.room.slots.filter((s: any) => s.occupant !== null).length === 3, 10_000, 'guest joined')
  send(guest, { type: 'add_bot_to_private_room_team', team: 'B' })
  const hostFull = await waitForFrame(host, (f) => f.type === 'private_room_full', 15_000, 'private_room_full')
  const guestFull = await waitForFrame(guest, (f) => f.type === 'private_room_full', 15_000, 'guest private_room_full')
  await waitForFrame(host, (f) => f.type === 'room_snapshot' && f.roomId === hostFull.roomId && f.game?.authoritativePhase, 15_000, 'active game snapshot')
  return { roomId: hostFull.roomId, hostSeat: hostFull.seat, guestSeat: guestFull.seat }
}

async function watch(spectator: TestClient, roomId: string): Promise<void> {
  const from = spectator.frames.length
  send(spectator, { type: 'watch_belot_room', roomId })
  await waitForFrame(spectator, (f) => f.type === 'belot_spectator_snapshot' && f.roomId === roomId, 10_000, 'watch snapshot', from)
}


const PRESENCE = 'belot_room_spectators'
function presenceFrom(client: TestClient, from: number, roomId?: string): any[] {
  return client.frames.slice(from).filter((f) => f.type === PRESENCE && (roomId === undefined || f.roomId === roomId))
}
function latestPresence(client: TestClient, roomId: string): any | null {
  const frames = client.frames.filter((f) => f.type === PRESENCE && f.roomId === roomId)
  return frames.length ? frames[frames.length - 1] : null
}
async function waitPresence(client: TestClient, roomId: string, count: number, from: number, label: string): Promise<any> {
  return waitForFrame(client, (f) => f.type === PRESENCE && f.roomId === roomId && f.spectators.length === count, 6_000, label, from)
}

// ─── Run ──────────────────────────────────────────────────────────────────

console.log('\ncheckBelotRoomSpectatorsPresence\n')

await check('[U1] unit: builder dedups by profileId, skips unresolved connections, falls back to a display name', () => {
  const registry = createBelotSpectatorRegistry()
  registry.watch('c1', 'room-u')
  registry.watch('c2', 'room-u')
  registry.watch('c3', 'room-u')
  registry.watch('c4', 'room-u')
  registry.watch('other', 'room-other')
  const profileByConnection: Record<string, string | null> = { c1: 'p1', c2: 'p1', c3: null, c4: 'p2', other: 'p9' }
  const names: Record<string, string> = { p1: 'Ани', p2: '  ' }
  const message = buildBelotRoomSpectatorsMessage({
    roomId: 'room-u',
    registry,
    resolveConnectionProfileId: (id) => profileByConnection[id] ?? null,
    getPublicDisplayName: (profileId) => names[profileId] ?? null,
  })
  assert(message.type === 'belot_room_spectators' && message.roomId === 'room-u', 'envelope')
  assert(JSON.stringify(message.spectators) === JSON.stringify([{ profileId: 'p1', displayName: 'Ани' }, { profileId: 'p2', displayName: 'Играч' }]), JSON.stringify(message.spectators))
})

await check('[U2] source review: notifications on every membership change, participants only, resume hydration', async () => {
  const src = (await readFile(join(sourceServerRoot, 'src', 'index.ts'), 'utf8')).replace(/\r\n/g, '\n')
  const broadcast = src.slice(src.indexOf('function broadcastBelotRoomSpectatorsToParticipants('), src.indexOf('// Idempotent — no-op ако connection-ът не гледа нищо. notifyParticipants'))
  assert(broadcast.includes('broadcastToRoomConnections(room, socketRegistry,'), 'participants-only delivery')
  const end = src.slice(src.indexOf('function endBelotSpectatingForConnection('), src.indexOf('function endBelotSpectatingForProfile('))
  assert(end.includes('if (roomId !== null && notifyParticipants) broadcastBelotRoomSpectatorsToParticipants(roomId)'), 'central unwatch notifies (unwatch/disconnect/game commitment/displace)')
  const watchBlock = src.slice(src.indexOf("if (message.type === 'watch_belot_room') {"), src.indexOf("if (message.type === 'unwatch_belot_room') {"))
  assert(watchBlock.includes("endBelotSpectatingForConnection(spectatorConnectionId, 'replaced', true, false)"), 'replaced tab defers its notification')
  assert(watchBlock.includes('const previousWatchedRoomId = belotSpectatorRegistry.watch(connection.id, room.id)'), 'room switch tracked')
  assert(watchBlock.includes('broadcastBelotRoomSpectatorsToParticipants(refreshRoomId)'), 'single combined update after watch')
  assert(src.includes('onSpectatorsRemoved: () => broadcastBelotRoomSpectatorsToParticipants(room.id)'), 'defensive cleanup notifies')
  const resume = src.slice(src.indexOf("type: 'room_resumed',"), src.indexOf("if (message.type === 'tournament_semifinal_result_acknowledge')"))
  assert(resume.includes('safeSendToConnection(connection.id, buildBelotRoomSpectatorsMessageForRoom(result.room.id))'), 'resume sends the current list')
})

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

  const users = {
    host: seedUser(dbFile, 'host'), guest: seedUser(dbFile, 'guest'),
    host2: seedUser(dbFile, 'host2'), guest2: seedUser(dbFile, 'guest2'),
    specA: seedUser(dbFile, 'specA'), specB: seedUser(dbFile, 'specB'),
  }
  for (const key of ['specA', 'specB'] as const) await grantVip(dbFile, users[key].profileId)

  const host = await connectClient(port, users.host, 'host')
  const guest = await connectClient(port, users.guest, 'guest')
  const host2 = await connectClient(port, users.host2, 'host2')
  const guest2 = await connectClient(port, users.guest2, 'guest2')
  const specA = await connectClient(port, users.specA, 'specA')
  const specB = await connectClient(port, users.specB, 'specB')
  openClients.push(host, guest, host2, guest2, specA, specB)

  const table1 = await createPrivateTable(host, guest)
  const table2 = await createPrivateTable(host2, guest2)
  console.log(`table1=${table1.roomId} table2=${table2.roomId}\n`)
  const t1 = table1.roomId

  // S1/S2/S10
  let hostFrom = host.frames.length
  let guestFrom = guest.frames.length
  await watch(specA, t1)
  await check('[S1/S10] first spectator -> participants get list = 1 with exactly { profileId, displayName }', async () => {
    for (const [client, from] of [[host, hostFrom], [guest, guestFrom]] as Array<[TestClient, number]>) {
      const msg = await waitPresence(client, t1, 1, from, `${client.label} list=1`)
      const keys = Object.keys(stripMeta(msg)).sort()
      assert(JSON.stringify(keys) === JSON.stringify(['roomId', 'spectators', 'type']), `envelope keys ${keys}`)
      const rowKeys = Object.keys(msg.spectators[0]).sort()
      assert(JSON.stringify(rowKeys) === JSON.stringify(['displayName', 'profileId']), `row keys ${rowKeys}`)
      assert(msg.spectators[0].profileId === users.specA.profileId, 'profileId')
      assert(typeof msg.spectators[0].displayName === 'string' && msg.spectators[0].displayName.startsWith('Spec specA'), `displayName ${msg.spectators[0].displayName}`)
      const json = JSON.stringify(msg)
      for (const forbidden of ['email', 'accountId', 'account_id', 'reconnectToken', 'session', 'visitor', 'balance', 'wallet', 'ip']) {
        assert(!new RegExp(`"${forbidden}"`, 'i').test(json), `must not contain ${forbidden}`)
      }
    }
  })

  await check('[S2] the spectator never receives belot_room_spectators', () => {
    assert(specA.frames.filter((f) => f.type === PRESENCE).length === 0, 'spectator received presence')
  })

  // S3
  hostFrom = host.frames.length
  await watch(specB, t1)
  await check('[S3] second profile -> list = 2', async () => {
    const msg = await waitPresence(host, t1, 2, hostFrom, 'host list=2')
    const ids = msg.spectators.map((s: any) => s.profileId).sort()
    assert(JSON.stringify(ids) === JSON.stringify([users.specA.profileId, users.specB.profileId].sort()), JSON.stringify(ids))
  })

  // S4: same profile from a second tab (replaced) -> still one row, no flicker
  hostFrom = host.frames.length
  const specA2 = await connectClient(port, users.specA, 'specA-tab2')
  openClients.push(specA2)
  await watch(specA2, t1)
  await sleep(800)
  // Забележка: новата connection на същия профил изтласква старата още при
  // connect (single-session displaceProfileConnections -> session_displaced),
  // затова междинно 1 е реално напускане на стария таб, не дублиране.
  await check('[S4] same profile in a second tab -> never two rows for one profile; final list = 2 people', () => {
    const updates = presenceFrom(host, hostFrom, t1)
    assert(updates.length >= 1, 'a refresh was sent')
    for (const update of updates) {
      const ids = update.spectators.map((s: any) => s.profileId)
      assert(new Set(ids).size === ids.length, `duplicate profile rows: ${JSON.stringify(ids)}`)
    }
    const last = updates[updates.length - 1].spectators.map((s: any) => s.profileId).sort()
    assert(JSON.stringify(last) === JSON.stringify([users.specA.profileId, users.specB.profileId].sort()), `final ${JSON.stringify(last)}`)
  })

  // S5 unwatch
  hostFrom = host.frames.length
  send(specB, { type: 'unwatch_belot_room', roomId: t1 })
  await check('[S5] unwatch -> update (list = 1)', async () => {
    const msg = await waitPresence(host, t1, 1, hostFrom, 'host after unwatch')
    assert(msg.spectators[0].profileId === users.specA.profileId, 'specA remains')
  })

  // S9 participant resume -> current list immediately (before any change)
  await check('[S9] participant resume_room -> current list immediately', async () => {
    const token = [...host.frames].reverse().find((f) => f.type === 'room_snapshot' && f.roomId === t1 && f.reconnectToken)?.reconnectToken
    assert(typeof token === 'string' && token.length > 0, 'host reconnect token')
    const host2nd = await connectClient(port, users.host, 'host-resumed')
    openClients.push(host2nd)
    send(host2nd, { type: 'resume_room', roomId: t1, reconnectToken: token })
    await waitForFrame(host2nd, (f) => f.type === 'room_resumed' && f.roomId === t1, 8_000, 'room_resumed')
    const msg = await waitPresence(host2nd, t1, 1, 0, 'resumed host list')
    assert(msg.spectators[0].profileId === users.specA.profileId, 'current spectator list after resume')
  })

  // S6 disconnect (specA's active tab is specA2 after replacement)
  const resumedHost = openClients.find((c) => c.label === 'host-resumed')!
  let resumedFrom = resumedHost.frames.length
  const guestFrom2 = guest.frames.length
  hostFrom = host.frames.length
  await watch(specB, t1)
  await waitPresence(resumedHost, t1, 2, resumedFrom, 'resumed host list=2')
  resumedFrom = resumedHost.frames.length
  specB.ws.close()
  await check('[S6] spectator disconnect -> update', async () => {
    const msg = await waitPresence(resumedHost, t1, 1, resumedFrom, 'after disconnect')
    assert(msg.spectators[0].profileId === users.specA.profileId, 'specA remains')
  })

  // S7 last leaves
  resumedFrom = resumedHost.frames.length
  send(specA2, { type: 'unwatch_belot_room', roomId: t1 })
  await check('[S7] last spectator leaves -> []', async () => {
    await waitPresence(resumedHost, t1, 0, resumedFrom, 'empty list')
    await waitPresence(guest, t1, 0, guestFrom2, 'guest empty list')
  })

  await check('[S8] other room is unaffected', () => {
    for (const client of [host2, guest2]) {
      assert(client.frames.filter((f) => f.type === PRESENCE).length === 0, `${client.label} got presence for another room`)
    }
    assert(latestPresence(guest, table2.roomId) === null, 'table1 participants never get table2 presence')
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
