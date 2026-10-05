/**
 * checkBelotSpectatorWebSocket.ts
 *
 * Real spawned-server, real WebSocket + HTTP integration test за Belot
 * Spectator Mode Phase 2A (server foundation + security). Следва
 * established isolated-server pattern (checkPrivilegedGiftCoinsPolicyMatrix.ts:
 * temp copy на server root + изолирана SQLite DB + директно seed-нати
 * акаунти/сесии, без email verification brute force).
 *
 * Сървър 1 — BELOT_SPECTATOR_ENABLED не е зададен (default OFF):
 *   [W0]  watch_belot_room -> belot_spectate_denied feature_disabled
 *
 * Сървър 2 — BELOT_SPECTATOR_ENABLED=1, частна маса 2 хора + 2 бота:
 *   [W1]  watch -> belot_spectate_started + belot_spectator_snapshot (yourSeat/
 *         reconnectToken null, ownHand []), никога room_snapshot
 *   [W2]  spectator не заема seat: 4 места, нито едно с неговия profileId,
 *         seat-овете на играчите непроменени
 *   [W3]  live updates стигат до spectator-а като belot_spectator_snapshot
 *   [W4]  нито една неизиграна карта на човешките играчи не изтича в
 *         spectator frame-ите (освен в публичните trick/reveal секции)
 *   [W5]  participant (host) watch на собствената маса -> denied participant
 *   [W6]  всеки gameplay/social WS action -> spectator_action_forbidden
 *   [W7]  bidding: spectator bid в хода на host-а -> отказ, state непроменен
 *   [W8]  playing: spectator play на картата на host-а -> отказ, ръката непроменена
 *   [W9]  emoji/phrase не стигат до играчите; table gift -> без transaction/wallet промяна
 *   [W10] HTTP gifts (send-gift-item, gift-coins, gift-coins/direct, платени
 *         gift checkout-и) -> 403 spectator_action_forbidden, без balance/
 *         ledger/transaction side effects
 *   [W11] втори таб на същия профил: WS action -> forbidden; watch на същата
 *         маса прехвърля subscription-а (стария таб: ended 'replaced')
 *   [W12] watch на несъществуваща маса докато гледаш -> room_not_found, без
 *         промяна на текущия subscription
 *   [W13] Ludo/Belot взаимно изключване (Ludo watch приключва Belot watch;
 *         Belot watch докато гледаш Ludo -> ludo_spectating)
 *   [W14] game commitment (join_matchmaking) приключва spectating
 *   [W15] unwatch: ended 'unwatched' веднъж, повторен unwatch no-op, никакви
 *         snapshot-и след това; currentRoomId никога не е бил сетнат
 *   [W16] след unwatch нормалните gift пътища работят (guard-ът е единственият блокер)
 *   [W17] disconnect cleanup — затворен spectator socket вече не блокира gifts
 *   [W18] source review: room removal / disconnect / broadcast hook wiring
 */

import { randomBytes, randomUUID, scryptSync } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import WebSocket from 'ws'

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
  const root = await mkdtemp(join(tmpdir(), 'belot-spectator-ws-'))
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

function createAcceptedFriendship(databaseFile: string, profileIdA: string, profileIdB: string): string {
  const db = new DatabaseSync(databaseFile, { open: true, timeout: 10_000 })
  const friendshipId = randomUUID()
  const lower = profileIdA < profileIdB ? profileIdA : profileIdB
  const higher = profileIdA < profileIdB ? profileIdB : profileIdA
  db.prepare(`
    INSERT INTO profile_friendships
      (friendship_id, requester_profile_id, addressee_profile_id, lower_profile_id, higher_profile_id, status, kind)
    VALUES (?, ?, ?, ?, ?, 'accepted', 'friend');
  `).run(friendshipId, profileIdA, profileIdB, lower, higher)
  db.close()
  return friendshipId
}

function seedGiftItem(databaseFile: string, giftItemId: string, price: number): void {
  const db = new DatabaseSync(databaseFile, { open: true, timeout: 10_000 })
  db.prepare(
    `INSERT INTO gift_items (gift_item_id, name, image_url, price, is_active, sort_order) VALUES (?, ?, ?, ?, 1, 0)
     ON CONFLICT(gift_item_id) DO UPDATE SET price=excluded.price, is_active=1`,
  ).run(giftItemId, 'Spectator Test Rose', '/uploads/gift-items/spectator-test.webp', price)
  db.close()
}

function readWallet(databaseFile: string, profileId: string): number {
  const db = new DatabaseSync(databaseFile, { open: true, timeout: 10_000 })
  try {
    const row = db.prepare('SELECT yellow_coins_balance AS b FROM profile_wallets WHERE profile_id = ?').get(profileId) as { b: number } | undefined
    return row?.b ?? -1
  } finally {
    db.close()
  }
}

function countRows(databaseFile: string, sql: string, ...params: Array<string | number>): number {
  const db = new DatabaseSync(databaseFile, { open: true, timeout: 10_000 })
  try {
    return (db.prepare(sql).get(...params) as { c: number }).c
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

// Махаме публичните (изиграни/разкрити) секции и проверяваме, че никое
// останало място в spectator frame-а не съдържа card id от ръка на играч.
function assertSpectatorFrameHidesHands(frame: any, handCardIds: Set<string>): void {
  const clone = JSON.parse(JSON.stringify(frame))
  if (clone.game?.playing) {
    clone.game.playing.currentTrickPlays = []
    clone.game.playing.latestCompletedTrick = null
    clone.game.playing.sweepResolution = null
  }
  for (const declaration of clone.game?.declarations ?? []) {
    declaration.cards = []
    declaration.cardIds = []
  }
  const json = JSON.stringify(clone)
  for (const cardId of handCardIds) {
    assert(!json.includes(`"${cardId}"`), `hand card ${cardId} leaked outside public sections of a spectator frame`)
  }
}

// ─── Run ──────────────────────────────────────────────────────────────────

console.log('\ncheckBelotSpectatorWebSocket\n')

// ── Server 1: flag OFF ───────────────────────────────────────────────────
{
  let server: RunningServer | null = null
  const isolated = await createIsolatedServerRoot(sourceServerRoot)
  try {
    const port = await findFreePort()
    server = startServer(isolated.serverDir, port, null)
    console.log(`[flag OFF] waiting for server on ${port}...`)
    await waitForServer(server, port)
    const user = seedUser(isolated.databaseFile, 'flagoff')
    const client = await connectClient(port, user, 'flagoff')
    await check('[W0] feature flag OFF (default) -> watch_belot_room denied feature_disabled, nothing else', async () => {
      send(client, { type: 'watch_belot_room', roomId: 'any-room-id' })
      const denied = await waitForFrame(client, (f) => f.type === 'belot_spectate_denied', 5_000, 'denied')
      assert(denied.code === 'feature_disabled', `code=${denied.code}`)
      await sleep(300)
      assert(!client.frames.some((f) => f.type === 'belot_spectate_started' || f.type === 'belot_spectator_snapshot'), 'no spectator stream when flag is OFF')
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
let driverTimer: ReturnType<typeof setInterval> | null = null

try {
  const port = await findFreePort()
  server = startServer(isolated.serverDir, port, '1')
  console.log(`[flag ON] waiting for server on ${port}...`)
  await waitForServer(server, port)
  console.log('Server ready.\n')

  const hostUser = seedUser(dbFile, 'host')
  const guestUser = seedUser(dbFile, 'guest')
  const spectatorUser = seedUser(dbFile, 'spectator', 'pika_team')
  const ludoUser1 = seedUser(dbFile, 'ludo1')
  const ludoUser2 = seedUser(dbFile, 'ludo2')
  const giftItemId = `spectator-gift-${randomUUID()}`
  seedGiftItem(dbFile, giftItemId, 100)
  const spectatorHostFriendshipId = createAcceptedFriendship(dbFile, spectatorUser.profileId, hostUser.profileId)

  const host = await connectClient(port, hostUser, 'host')
  const guest = await connectClient(port, guestUser, 'guest')
  let spectator = await connectClient(port, spectatorUser, 'spectator')
  openClients.push(host, guest, spectator)

  // ── Private table: host(A) + bot(A) vs guest(B) + bot(B) ─────────────────
  send(host, { type: 'create_private_room', stake: STAKE, isLocked: false })
  const created = await waitForFrame(host, (f) => f.type === 'private_room_updated', 10_000, 'private room created')
  send(host, { type: 'add_bot_to_private_room_team', team: 'A' })
  await waitForFrame(host, (f) => f.type === 'private_room_updated' && f.room.slots.filter((s: any) => s.occupant !== null).length === 2, 10_000, 'bot A')
  send(guest, { type: 'join_private_room', privateRoomId: created.room.id, team: 'B', slotIndex: 0 })
  await waitForFrame(guest, (f) => f.type === 'private_room_updated' && f.room.slots.filter((s: any) => s.occupant !== null).length === 3, 10_000, 'guest joined')
  send(guest, { type: 'add_bot_to_private_room_team', team: 'B' })
  const hostFull = await waitForFrame(host, (f) => f.type === 'private_room_full', 15_000, 'private_room_full')
  const guestFull = await waitForFrame(guest, (f) => f.type === 'private_room_full', 15_000, 'guest private_room_full')
  const roomId: string = hostFull.roomId
  const hostSeat: string = hostFull.seat
  const guestSeat: string = guestFull.seat
  await waitForFrame(host, (f) => f.type === 'room_snapshot' && f.roomId === roomId && f.game?.authoritativePhase, 15_000, 'active game snapshot')
  console.log(`game room=${roomId} host=${hostSeat} guest=${guestSeat}\n`)

  // ── Human driver: keeps the game moving; host holds on demand ───────────
  const handCardIds = new Set<string>()
  const control = { holdHostBid: true, holdHostPlay: true }
  const lastActionKey = new Map<string, string>()
  function drive(client: TestClient, isHost: boolean): void {
    const snap = latestRoomSnapshot(client, roomId)
    const game = snap?.game
    if (!game) return
    for (const c of game.ownHand ?? []) handCardIds.add(c.id)
    const key = JSON.stringify([game.authoritativePhase, game.bidding?.entries?.length, game.playing?.completedTricksCount, game.playing?.currentTrickPlays?.length, game.playing?.sweepOffer?.expiresAt])
    if (lastActionKey.get(client.label) === key) return
    if (game.cutting?.canSubmitCut) {
      lastActionKey.set(client.label, key)
      send(client, { type: 'submit_cut_index', roomId, cutIndex: 10 })
      return
    }
    if (game.bidding?.canSubmitBid && game.bidding.validActions) {
      if (isHost && control.holdHostBid) return
      lastActionKey.set(client.label, key)
      const action = isHost && game.bidding.validActions.allTrumps ? { type: 'all-trumps' } : { type: 'pass' }
      send(client, { type: 'submit_bid_action', roomId, action })
      return
    }
    if (game.playing?.sweepOffer) {
      lastActionKey.set(client.label, key)
      send(client, { type: 'submit_sweep_decision', roomId, decision: 'decline' })
      return
    }
    if (game.playing && game.playing.currentTurnSeat === snap.yourSeat && Array.isArray(game.playing.validCardIds) && game.playing.validCardIds.length > 0) {
      if (isHost && control.holdHostPlay) return
      lastActionKey.set(client.label, key)
      send(client, { type: 'submit_play_card', roomId, cardId: game.playing.validCardIds[0] })
    }
  }
  driverTimer = setInterval(() => {
    try { drive(host, true); drive(guest, false) } catch { /* ignore */ }
  }, 250)

  const spectatorFramesFrom = (client: TestClient) => client.frames.filter((f) => f.type === 'belot_spectator_snapshot')

  // ── [W1] watch ─────────────────────────────────────────────────────────
  await check('[W1] watch -> belot_spectate_started + belot_spectator_snapshot; never room_snapshot', async () => {
    send(spectator, { type: 'watch_belot_room', roomId })
    const started = await waitForFrame(spectator, (f) => f.type === 'belot_spectate_started', 5_000, 'started')
    assert(started.roomId === roomId, 'ACK roomId')
    const snap = await waitForFrame(spectator, (f) => f.type === 'belot_spectator_snapshot', 5_000, 'initial snapshot')
    assert(snap.roomId === roomId && snap.viewerRole === 'spectator', 'snapshot identity')
    assert(snap.yourSeat === null && snap.reconnectToken === null, 'no seat/token')
    assert(Array.isArray(snap.game?.ownHand) && snap.game.ownHand.length === 0, 'ownHand []')
    assert(!spectator.frames.some((f) => f.type === 'room_snapshot'), 'spectator must never receive room_snapshot')
  })

  await check('[W2] spectator takes no seat; players keep their seats', async () => {
    await sleep(500)
    const hostSnap = latestRoomSnapshot(host, roomId)
    assert(hostSnap !== null, 'host snapshot')
    const occupied = hostSnap.seats.filter((s: any) => s.isOccupied)
    assert(occupied.length === 4, `occupied=${occupied.length}`)
    assert(!hostSnap.seats.some((s: any) => s.profileId === spectatorUser.profileId), 'spectator profile must not occupy a seat')
    assert(hostSnap.yourSeat === hostSeat && latestRoomSnapshot(guest, roomId)?.yourSeat === guestSeat, 'player seats unchanged')
  })

  await check('[W5] a participant cannot watch their own table', async () => {
    const from = host.frames.length
    send(host, { type: 'watch_belot_room', roomId })
    const denied = await waitForFrame(host, (f) => f.type === 'belot_spectate_denied', 5_000, 'host denied', from)
    assert(denied.code === 'participant', `code=${denied.code}`)
    assert(!host.frames.slice(from).some((f) => f.type === 'belot_spectator_snapshot'), 'participant never gets spectator stream')
  })

  // ── [W7] bidding mutation attempt ──────────────────────────────────────
  await check('[W7] spectator bid during host turn -> forbidden, bidding state unchanged', async () => {
    await waitForCondition('host bidding turn', () => latestRoomSnapshot(host, roomId)?.game?.bidding?.canSubmitBid === true, 90_000)
    const before = latestRoomSnapshot(host, roomId)
    const entriesBefore = before.game.bidding.entries.length
    const from = spectator.frames.length
    send(spectator, { type: 'submit_bid_action', roomId, action: { type: 'pass' } })
    const error = await waitForFrame(spectator, (f) => f.type === 'error', 5_000, 'bid forbidden', from)
    assert(error.code === 'spectator_action_forbidden', `code=${error.code}`)
    await sleep(800)
    const after = latestRoomSnapshot(host, roomId)
    assert(after.game.bidding?.canSubmitBid === true, 'host must still be on turn')
    assert(after.game.bidding.entries.length === entriesBefore, 'no bidding entry may be added by the spectator')
    control.holdHostBid = false
  })

  // ── [W8] playing mutation attempt ──────────────────────────────────────
  await check('[W8] spectator plays host card during host turn -> forbidden, hand unchanged', async () => {
    await waitForCondition('host playing turn', () => {
      const snap = latestRoomSnapshot(host, roomId)
      return snap?.game?.playing?.currentTurnSeat === hostSeat && (snap.game.playing.validCardIds?.length ?? 0) > 0
    }, 150_000)
    const before = latestRoomSnapshot(host, roomId)
    const targetCardId: string = before.game.playing.validCardIds[0]
    const from = spectator.frames.length
    send(spectator, { type: 'submit_play_card', roomId, cardId: targetCardId })
    const error = await waitForFrame(spectator, (f) => f.type === 'error', 5_000, 'play forbidden', from)
    assert(error.code === 'spectator_action_forbidden', `code=${error.code}`)
    await sleep(800)
    const after = latestRoomSnapshot(host, roomId)
    assert(after.game.ownHand.some((c: any) => c.id === targetCardId), 'host still holds the card')
    assert(after.game.playing.currentTurnSeat === hostSeat, 'still host turn')
    assert(!after.game.playing.currentTrickPlays.some((p: any) => p.card.id === targetCardId), 'card not on the table')
    control.holdHostPlay = false
  })

  await check('[W3] live updates reach the spectator as belot_spectator_snapshot', async () => {
    await waitForCondition('several spectator snapshots', () => spectatorFramesFrom(spectator).length >= 3, 30_000)
    assert(!spectator.frames.some((f) => f.type === 'room_snapshot'), 'still never room_snapshot')
  })

  await check('[W4] no unplayed hand card of the human players leaks into any spectator frame', () => {
    assert(handCardIds.size > 0, 'fixture: collected player hand cards')
    const frames = spectatorFramesFrom(spectator)
    assert(frames.length > 0, 'have spectator frames')
    for (const frame of frames) {
      assert(frame.game === null || (frame.game.ownHand.length === 0 && (frame.game.playing?.validCardIds ?? null) === null && (frame.game.playing?.sweepOffer ?? null) === null), 'private fields stay empty')
      assert(frame.game?.bidding == null || (frame.game.bidding.canSubmitBid === false && frame.game.bidding.validActions === null), 'bid decision fields stay empty')
      assertSpectatorFrameHidesHands(frame, handCardIds)
    }
  })

  // ── [W6] forbidden WS action matrix ────────────────────────────────────
  await check('[W6] every gameplay/social WS action -> spectator_action_forbidden', async () => {
    const actions: Array<Record<string, unknown>> = [
      { type: 'submit_bid_action', roomId, action: { type: 'pass' } },
      { type: 'submit_cut_index', roomId, cutIndex: 5 },
      { type: 'submit_play_card', roomId, cardId: 'hearts-A' },
      { type: 'submit_sweep_decision', roomId, decision: 'accept' },
      { type: 'resume_human_control', roomId },
      { type: 'submit_partner_rating', roomId, ratingValue: 5, requestId: randomUUID() },
      { type: 'request_replay', roomId },
      { type: 'request_leave_match', roomId },
      { type: 'send_emoji_reaction', roomId, emojiId: '01' },
      { type: 'send_phrase_reaction', roomId, phraseId: 'phrase_01' },
      { type: 'send_table_gift', roomId, recipientProfileId: hostUser.profileId, giftItemId, requestId: randomUUID() },
      { type: 'send_ludo_gift', matchId: 'any-match', recipientProfileId: hostUser.profileId, giftItemId, requestId: randomUUID() },
      { type: 'request_player_profile', roomId, seat: hostSeat },
    ]
    for (const action of actions) {
      const from = spectator.frames.length
      send(spectator, action)
      const error = await waitForFrame(spectator, (f) => f.type === 'error' || f.type === 'player_profile' || f.type === 'table_gift_send_result', 5_000, `${action.type} response`, from)
      assert(error.type === 'error' && error.code === 'spectator_action_forbidden', `${action.type}: ${JSON.stringify(error)}`)
    }
  })

  await check('[W9] emoji/phrase never reach players; table gift has no wallet/transaction side effects', async () => {
    const hostFrom = host.frames.length
    const guestFrom = guest.frames.length
    const walletBefore = readWallet(dbFile, spectatorUser.profileId)
    const requestId = randomUUID()
    send(spectator, { type: 'send_emoji_reaction', roomId, emojiId: '02' })
    send(spectator, { type: 'send_phrase_reaction', roomId, phraseId: 'phrase_02' })
    send(spectator, { type: 'send_table_gift', roomId, recipientProfileId: hostUser.profileId, giftItemId, requestId })
    await sleep(1_500)
    for (const [client, from] of [[host, hostFrom], [guest, guestFrom]] as Array<[TestClient, number]>) {
      const leaked = client.frames.slice(from).filter((f) => ['emoji_reaction', 'phrase_reaction', 'table_gift_item_sent'].includes(f.type))
      assert(leaked.length === 0, `${client.label} received ${JSON.stringify(leaked.map((f) => f.type))}`)
    }
    assert(readWallet(dbFile, spectatorUser.profileId) === walletBefore, 'spectator wallet unchanged')
    assert(countRows(dbFile, 'SELECT COUNT(*) AS c FROM gift_item_transactions WHERE request_id = ?', requestId) === 0, 'no gift transaction')
  })

  // ── [W10] HTTP gifts ───────────────────────────────────────────────────
  async function expectHttpGiftsBlocked(label: string): Promise<void> {
    const spectatorWalletBefore = readWallet(dbFile, spectatorUser.profileId)
    const hostWalletBefore = readWallet(dbFile, hostUser.profileId)
    const ledgerBefore = countRows(dbFile, 'SELECT COUNT(*) AS c FROM yellow_coin_gift_ledger WHERE sender_profile_id = ?', spectatorUser.profileId)
    const giftRequestId = randomUUID()

    const responses = [
      ['send-gift-item', await httpJson(port, 'POST', `/api/profile/${hostUser.profileId}/send-gift-item`, spectatorUser.cookie, { giftItemId, requestId: giftRequestId })],
      ['gift-coins', await httpJson(port, 'POST', `/api/friends/${spectatorHostFriendshipId}/gift-coins`, spectatorUser.cookie, { amount: 1_000 })],
      ['gift-coins/direct', await httpJson(port, 'POST', '/api/friends/gift-coins/direct', spectatorUser.cookie, { recipientProfileId: hostUser.profileId, amount: 1_000 })],
      ['shop checkout gift', await httpJson(port, 'POST', '/api/shop/checkout', spectatorUser.cookie, { packageId: 'any-package', recipientProfileId: hostUser.profileId })],
      ['vip checkout gift', await httpJson(port, 'POST', '/api/vip/checkout', spectatorUser.cookie, { packageId: 'vip_30', recipientProfileId: hostUser.profileId })],
      ['bundle checkout gift', await httpJson(port, 'POST', '/api/shop/bundle-checkout', spectatorUser.cookie, { packageId: 'any-package', recipientProfileId: hostUser.profileId })],
    ] as const
    for (const [name, response] of responses) {
      assert(response.status === 403 && response.body?.code === 'spectator_action_forbidden', `${label} ${name}: ${response.status} ${JSON.stringify(response.body)}`)
    }
    assert(readWallet(dbFile, spectatorUser.profileId) === spectatorWalletBefore, `${label}: spectator wallet unchanged`)
    assert(readWallet(dbFile, hostUser.profileId) === hostWalletBefore, `${label}: recipient wallet unchanged`)
    assert(countRows(dbFile, 'SELECT COUNT(*) AS c FROM gift_item_transactions WHERE request_id = ?', giftRequestId) === 0, `${label}: no gift transaction`)
    assert(countRows(dbFile, 'SELECT COUNT(*) AS c FROM yellow_coin_gift_ledger WHERE sender_profile_id = ?', spectatorUser.profileId) === ledgerBefore, `${label}: no coin ledger write`)
    assert(countRows(dbFile, 'SELECT COUNT(*) AS c FROM coin_purchase_ledger WHERE profile_id = ?', spectatorUser.profileId) === 0, `${label}: no pending coin purchase`)
  }

  await check('[W10] HTTP gift endpoints -> 403 spectator_action_forbidden with zero side effects', async () => {
    await expectHttpGiftsBlocked('spectating')
  })

  // ── [W11] second tab ───────────────────────────────────────────────────
  // Сървърът държи ЕДНА live сесия на профил извън игра: нов connect изтласква
  // старите connections (displaceProfileConnections). Затова втори таб не може
  // да заобиколи spectator ограниченията — старият таб спира да е spectator
  // веднага, а новият трябва изрично да re-watch-не (същия път като reconnect).
  const tab1From = spectator.frames.length
  const spectatorTab2 = await connectClient(port, spectatorUser, 'spectator-tab2')
  openClients.push(spectatorTab2)
  await check('[W11] second tab/device: old spectator tab is displaced and unsubscribed immediately; new tab re-watches', async () => {
    const ended = await waitForFrame(spectator, (f) => f.type === 'belot_spectate_ended', 5_000, 'tab1 replaced', tab1From)
    assert(ended.reason === 'replaced' && ended.roomId === roomId, JSON.stringify(ended))
    await waitForFrame(spectator, (f) => f.type === 'session_displaced', 5_000, 'tab1 displaced', tab1From)
    const notSpectating = await httpJson(port, 'POST', '/api/friends/gift-coins/direct', spectatorUser.cookie, { recipientProfileId: hostUser.profileId, amount: 0 })
    assert(notSpectating.body?.code !== 'spectator_action_forbidden', 'displaced tab must not keep the profile marked as spectator')

    const from2 = spectatorTab2.frames.length
    send(spectatorTab2, { type: 'watch_belot_room', roomId })
    await waitForFrame(spectatorTab2, (f) => f.type === 'belot_spectate_started', 5_000, 'tab2 started', from2)
    await waitForFrame(spectatorTab2, (f) => f.type === 'belot_spectator_snapshot', 5_000, 'tab2 snapshot', from2)
    const blocked = await httpJson(port, 'POST', '/api/friends/gift-coins/direct', spectatorUser.cookie, { recipientProfileId: hostUser.profileId, amount: 1_000 })
    assert(blocked.status === 403 && blocked.body?.code === 'spectator_action_forbidden', 'new tab spectating blocks gifts again')
  })
  // от тук нататък активният spectator е tab2
  spectator = spectatorTab2

  await check('[W12] watching a missing room while spectating -> room_not_found, current subscription intact', async () => {
    const from = spectator.frames.length
    send(spectator, { type: 'watch_belot_room', roomId: 'room-that-does-not-exist' })
    const denied = await waitForFrame(spectator, (f) => f.type === 'belot_spectate_denied', 5_000, 'denied', from)
    assert(denied.code === 'room_not_found', `code=${denied.code}`)
    await waitForFrame(spectator, (f) => f.type === 'belot_spectator_snapshot' && f.roomId === roomId, 30_000, 'still receives snapshots', from)
    assert(!spectator.frames.slice(from).some((f) => f.type === 'belot_spectate_ended'), 'no ended event')
  })

  // ── [W13] Ludo mutual exclusion ────────────────────────────────────────
  await check('[W13] Ludo watch ends Belot watch; Belot watch while Ludo-watching -> ludo_spectating', async () => {
    const p1 = await connectClient(port, ludoUser1, 'ludo1')
    const p2 = await connectClient(port, ludoUser2, 'ludo2')
    openClients.push(p1, p2)
    send(p1, { type: 'create_ludo_room', stake: STAKE, playerCount: 2, manualStart: false })
    const ludoRoom = await waitForFrame(p1, (f) => f.type === 'ludo_room_updated', 10_000, 'ludo room')
    send(p2, { type: 'join_ludo_room', ludoRoomId: ludoRoom.room.id })
    const ludoStarted = await waitForFrame(p1, (f) => f.type === 'ludo_game_started', 15_000, 'ludo started')
    const matchId: string = ludoStarted.snapshot?.matchId ?? ludoStarted.matchId

    const from = spectator.frames.length
    send(spectator, { type: 'watch_ludo_match', matchId })
    const ended = await waitForFrame(spectator, (f) => f.type === 'belot_spectate_ended', 5_000, 'belot ended by ludo watch', from)
    assert(ended.reason === 'ludo_spectating', JSON.stringify(ended))
    await waitForFrame(spectator, (f) => f.type === 'ludo_spectator_game_state', 5_000, 'ludo spectator state', from)

    const from2 = spectator.frames.length
    send(spectator, { type: 'watch_belot_room', roomId })
    const denied = await waitForFrame(spectator, (f) => f.type === 'belot_spectate_denied', 5_000, 'belot denied', from2)
    assert(denied.code === 'ludo_spectating', `code=${denied.code}`)

    send(spectator, { type: 'unwatch_ludo_match', matchId })
    await sleep(300)
    const from3 = spectator.frames.length
    send(spectator, { type: 'watch_belot_room', roomId })
    await waitForFrame(spectator, (f) => f.type === 'belot_spectate_started', 5_000, 're-watch after ludo unwatch', from3)
  })

  await check('[W14] taking a game commitment (join_matchmaking) ends spectating first', async () => {
    const from = spectator.frames.length
    send(spectator, { type: 'join_matchmaking', stake: STAKE })
    const ended = await waitForFrame(spectator, (f) => f.type === 'belot_spectate_ended', 5_000, 'ended by commitment', from)
    assert(ended.reason === 'game_commitment', JSON.stringify(ended))
    send(spectator, { type: 'leave_matchmaking' })
    await sleep(500)
    const from2 = spectator.frames.length
    send(spectator, { type: 'watch_belot_room', roomId })
    await waitForFrame(spectator, (f) => f.type === 'belot_spectate_started', 5_000, 're-watch after leaving queue', from2)
  })

  // ── [W15] unwatch ──────────────────────────────────────────────────────
  await check('[W15] unwatch: ended once, idempotent, no later snapshots; connection was never attached to the room', async () => {
    const from = spectator.frames.length
    send(spectator, { type: 'unwatch_belot_room', roomId })
    const ended = await waitForFrame(spectator, (f) => f.type === 'belot_spectate_ended', 5_000, 'unwatched', from)
    assert(ended.reason === 'unwatched', JSON.stringify(ended))
    const unwatchedAt = Date.now()
    send(spectator, { type: 'unwatch_belot_room', roomId })
    // wait until players get a fresh broadcast after the unwatch
    const hostFrom = host.frames.length
    await waitForFrame(host, (f) => f.type === 'room_snapshot' && f.roomId === roomId, 40_000, 'host broadcast after unwatch', hostFrom)
    await sleep(300)
    assert(spectator.frames.slice(from).filter((f) => f.type === 'belot_spectate_ended').length === 1, 'exactly one ended event')
    assert(!spectator.frames.some((f) => f.type === 'belot_spectator_snapshot' && f.__receivedAt > unwatchedAt + 50), 'no snapshots after unwatch')

    // Без spectator gate-а гейминг handler-ът отговаря с "not attached" —
    // доказва, че watch никога не е сетнал currentRoomId/currentSeat.
    const from2 = spectator.frames.length
    send(spectator, { type: 'submit_play_card', roomId, cardId: 'hearts-A' })
    const error = await waitForFrame(spectator, (f) => f.type === 'error', 5_000, 'not attached', from2)
    assert(error.code !== 'spectator_action_forbidden' && /not attached/i.test(error.message), JSON.stringify(error))
  })

  await check('[W16] after unwatch the normal gift paths work (the spectator guard was the only blocker)', async () => {
    const requestId = randomUUID()
    const giftItem = await httpJson(port, 'POST', `/api/profile/${hostUser.profileId}/send-gift-item`, spectatorUser.cookie, { giftItemId, requestId })
    assert(giftItem.status === 200 && giftItem.body?.ok === true, `send-gift-item: ${giftItem.status} ${JSON.stringify(giftItem.body)}`)
    assert(countRows(dbFile, 'SELECT COUNT(*) AS c FROM gift_item_transactions WHERE request_id = ?', requestId) === 1, 'transaction recorded')

    const hostBefore = readWallet(dbFile, hostUser.profileId)
    const direct = await httpJson(port, 'POST', '/api/friends/gift-coins/direct', spectatorUser.cookie, { recipientProfileId: hostUser.profileId, amount: 1_000 })
    assert(direct.status === 200, `direct: ${direct.status} ${JSON.stringify(direct.body)}`)
    assert(readWallet(dbFile, hostUser.profileId) === hostBefore + 1_000, 'recipient credited')

    const checkout = await httpJson(port, 'POST', '/api/shop/checkout', spectatorUser.cookie, { packageId: 'any-package', recipientProfileId: hostUser.profileId })
    assert(checkout.body?.code !== 'spectator_action_forbidden', `checkout no longer spectator-blocked: ${JSON.stringify(checkout.body)}`)
  })

  await check('[W17] disconnect cleanup: a closed spectator socket no longer blocks gifts', async () => {
    const from = spectator.frames.length
    send(spectator, { type: 'watch_belot_room', roomId })
    await waitForFrame(spectator, (f) => f.type === 'belot_spectate_started', 5_000, 're-watch', from)
    const blocked = await httpJson(port, 'POST', '/api/friends/gift-coins/direct', spectatorUser.cookie, { recipientProfileId: hostUser.profileId, amount: 1_000 })
    assert(blocked.status === 403 && blocked.body?.code === 'spectator_action_forbidden', 'blocked while watching')
    spectator.ws.close()
    await waitForCondition('disconnect processed', async () => {
      const r = await httpJson(port, 'POST', '/api/friends/gift-coins/direct', spectatorUser.cookie, { recipientProfileId: hostUser.profileId, amount: 1_000 })
      return r.status === 200
    }, 10_000)
  })

  await check('[W18] source review: room removal, disconnect and broadcast hook wiring', async () => {
    const indexSource = await readFile(join(sourceServerRoot, 'src', 'index.ts'), 'utf8')
    const removalStart = indexSource.indexOf('function removeCommittedServerRoom(')
    const removal = indexSource.slice(removalStart, indexSource.indexOf('\n}\n', removalStart))
    assert(removal.includes("endBelotSpectatorsForRoom(roomId, 'room_removed')"), 'removeCommittedServerRoom must end spectators')
    const closeHandler = indexSource.slice(indexSource.indexOf("socket.on('close'"))
    assert(closeHandler.includes('endBelotSpectatingForConnection(connection.id'), 'close handler must clean the registry')
    assert(indexSource.includes('setBroadcastRoomSnapshotsSpectatorHook('), 'spectator fan-out hook must be wired')
    const watchStart = indexSource.indexOf("if (message.type === 'watch_belot_room') {")
    const watchBlock = indexSource.slice(watchStart, indexSource.indexOf("if (message.type === 'unwatch_belot_room') {", watchStart))
    assert(!/currentRoomId\s*[:=]|currentSeat\s*[:=]|attachConnectionToRoomSeat|seatParticipantInRoom|commitServerRoom/.test(watchBlock), 'watch handler must never touch room membership')
  })
} finally {
  if (driverTimer !== null) clearInterval(driverTimer)
  for (const client of openClients) {
    try { client.ws.close() } catch { /* ignore */ }
  }
  await stopServer(server)
  await isolated.cleanup()
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
process.exit(0)
