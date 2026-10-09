/**
 * checkGiftBlockEnforcement.ts
 *
 * Virtual gift items + блокиране (в която и да е посока). Real spawned
 * server + real WebSocket + реалния block endpoint (POST /api/profiles/:id/block).
 * Authoritative проверката е в giftItemStore.sendGiftItem (същата транзакция
 * като debit-а), затова тук се упражняват ВСИЧКИ пътища към нея:
 *
 *   [H*]  HTTP POST /api/profile/:id/send-gift-item (профилен popup, "Подари и ти")
 *   [B*]  WS send_table_gift — Belot участник
 *   [SP*] WS send_table_gift — Belot зрител
 *   [L*]  WS send_ludo_gift — Ludo участник
 *
 * За всеки път: без блокиране / A блокира B / B блокира A / взаимно. При
 * отказ: правилен code, баланс непроменен, няма transaction, няма delivery
 * ред, няма push/broadcast към получателя. Плюс:
 *   [P1]  GET /api/profiles/:id (client precheck) връща 403 + code в двете посоки, 200 без block
 *   [P2]  GET /api/profiles/:botProfileId -> 200 (precheck не чупи подаръци към ботове)
 *   [R1]  block след зареждане на каталога (отворен picker) -> send отказан
 *   [R2]  HTTP replay на същия requestId (online получател) -> един push
 *   [R3]  HTTP replay (offline получател) -> 200, един delivery ред
 *   [R4]  HTTP replay на успешен requestId след block -> idempotent 200, без debit/известие
 *   [G1]  подарък към бот без блокиране — непроменен
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
const PRICE = 100

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

// ─── Isolated server (mirror на checkBelotSpectatorTableGiftSend.ts) ───────

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
  const root = await mkdtemp(join(tmpdir(), 'belot-gift-block-'))
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

function startServer(serverDir: string, port: number): RunningServer {
  const chunks: string[] = []
  const env: Record<string, string | undefined> = { ...process.env, PORT: String(port), BELOT_SPECTATOR_ENABLED: '1' }
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

// ─── DB seeding ───────────────────────────────────────────────────────────

function hashSessionToken(token: string): string {
  return scryptSync(token, 'belot-v2-session-v1', 32).toString('hex')
}

type SeededUser = { cookie: string; profileId: string; tag: string }

function seedUser(databaseFile: string, tag: string): SeededUser {
  const db = new DatabaseSync(databaseFile, { open: true, timeout: 10_000 })
  db.exec('PRAGMA foreign_keys = ON;')
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const accountId = randomUUID()
  const profileId = randomUUID()
  const displayName = `Blk ${tag} ${runId.slice(-4)}`
  const normalized = displayName.toLowerCase()
  const token = randomBytes(32).toString('base64url')
  db.exec('BEGIN IMMEDIATE;')
  try {
    db.prepare(`INSERT INTO accounts (account_id, email, password_hash, role, status) VALUES (?, ?, 'not-used-seeded-directly', 'player', 'active');`)
      .run(accountId, `belot-gift-block-${tag}-${runId}@example.test`)
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
  return { cookie: `${SESSION_COOKIE_NAME}=${token}`, profileId, tag }
}

async function grantVip(databaseFile: string, profileId: string): Promise<void> {
  const store = await createVipStore(databaseFile)
  try {
    store.grantVip(profileId, 'admin_grant', { unit: 'days', amount: 30 })
  } finally {
    store.close()
  }
}

function seedGiftItem(databaseFile: string, giftItemId: string): void {
  const db = new DatabaseSync(databaseFile, { open: true, timeout: 10_000 })
  db.prepare(
    `INSERT INTO gift_items (gift_item_id, name, image_url, price, is_active, sort_order) VALUES (?, ?, ?, ?, 1, 0)
     ON CONFLICT(gift_item_id) DO UPDATE SET price=excluded.price, is_active=1`,
  ).run(giftItemId, 'Block Test Rose', '/uploads/gift-items/block-test.webp', PRICE)
  db.close()
}

function dbGet<T>(databaseFile: string, sql: string, ...params: Array<string | number>): T {
  const db = new DatabaseSync(databaseFile, { open: true, timeout: 10_000 })
  try {
    return db.prepare(sql).get(...params) as T
  } finally {
    db.close()
  }
}

// ─── WS / HTTP ────────────────────────────────────────────────────────────

type TestClient = { user: SeededUser; ws: WebSocket; frames: any[]; label: string }

async function connectClient(port: number, user: SeededUser, label: string): Promise<TestClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: user.cookie } })
  const frames: any[] = []
  ws.on('message', (data) => {
    try { frames.push(JSON.parse(data.toString())) } catch { /* ignore */ }
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

async function createPrivateTable(host: TestClient, guest: TestClient): Promise<{ roomId: string }> {
  send(host, { type: 'create_private_room', stake: STAKE, isLocked: false })
  const created = await waitForFrame(host, (f) => f.type === 'private_room_updated', 10_000, 'private room created')
  send(host, { type: 'add_bot_to_private_room_team', team: 'A' })
  await waitForFrame(host, (f) => f.type === 'private_room_updated' && f.room.slots.filter((s: any) => s.occupant !== null).length === 2, 10_000, 'bot A')
  send(guest, { type: 'join_private_room', privateRoomId: created.room.id, team: 'B', slotIndex: 0 })
  await waitForFrame(guest, (f) => f.type === 'private_room_updated' && f.room.slots.filter((s: any) => s.occupant !== null).length === 3, 10_000, 'guest joined')
  send(guest, { type: 'add_bot_to_private_room_team', team: 'B' })
  const hostFull = await waitForFrame(host, (f) => f.type === 'private_room_full', 15_000, 'private_room_full')
  await waitForFrame(guest, (f) => f.type === 'private_room_full', 15_000, 'guest private_room_full')
  await waitForFrame(host, (f) => f.type === 'room_snapshot' && f.roomId === hostFull.roomId && f.game?.authoritativePhase, 15_000, 'active game snapshot')
  return { roomId: hostFull.roomId }
}

async function createLudoMatch(a: TestClient, b: TestClient): Promise<string> {
  send(a, { type: 'create_ludo_room', stake: STAKE, playerCount: 2, manualStart: false })
  const roomFrame = await waitForFrame(a, (f) => f.type === 'ludo_room_updated', 10_000, 'ludo room created')
  send(b, { type: 'join_ludo_room', ludoRoomId: roomFrame.room.id })
  const started = await waitForFrame(a, (f) => f.type === 'ludo_game_started', 15_000, 'ludo started')
  await waitForFrame(b, (f) => f.type === 'ludo_game_started', 15_000, 'ludo started (b)')
  return started.snapshot.matchId
}

// ─── Run ──────────────────────────────────────────────────────────────────

console.log('\ncheckGiftBlockEnforcement\n')

let server: RunningServer | null = null
const isolated = await createIsolatedServerRoot(sourceServerRoot)
const dbFile = isolated.databaseFile
const openClients: TestClient[] = []

const wallet = (profileId: string): number =>
  dbGet<{ b: number } | undefined>(dbFile, 'SELECT yellow_coins_balance AS b FROM profile_wallets WHERE profile_id = ?', profileId)?.b ?? -1
const txCount = (requestId: string): number =>
  dbGet<{ c: number }>(dbFile, 'SELECT COUNT(*) AS c FROM gift_item_transactions WHERE request_id = ?', requestId).c
const deliveryCount = (recipientProfileId: string): number =>
  dbGet<{ c: number }>(dbFile, 'SELECT COUNT(*) AS c FROM gift_item_delivery_log WHERE recipient_profile_id = ?', recipientProfileId).c
const isBlockedInDb = (blocker: string, blocked: string): boolean =>
  dbGet<{ c: number }>(dbFile, 'SELECT COUNT(*) AS c FROM player_blocks WHERE blocker_profile_id = ? AND blocked_profile_id = ?', blocker, blocked).c > 0

try {
  const port = await findFreePort()
  server = startServer(isolated.serverDir, port)
  console.log(`waiting for server on ${port}...`)
  await waitForServer(server, port)
  console.log('Server ready.\n')

  const users = {
    host: seedUser(dbFile, 'host'), guest: seedUser(dbFile, 'guest'),
    spec: seedUser(dbFile, 'spec'),
    lp1: seedUser(dbFile, 'lp1'), lp2: seedUser(dbFile, 'lp2'),
    off: seedUser(dbFile, 'off'),
  }
  await grantVip(dbFile, users.spec.profileId)
  const giftItemId = `gift-block-${randomUUID()}`
  seedGiftItem(dbFile, giftItemId)

  // Реалният block endpoint (toggle) — довежда двойката до желаното състояние.
  const setBlock = async (blocker: SeededUser, blocked: SeededUser, want: boolean): Promise<void> => {
    if (isBlockedInDb(blocker.profileId, blocked.profileId) === want) return
    const res = await httpJson(port, 'POST', `/api/profiles/${encodeURIComponent(blocked.profileId)}/block`, blocker.cookie)
    assert(res.status === 200, `block toggle ${res.status} ${JSON.stringify(res.body)}`)
    assert(isBlockedInDb(blocker.profileId, blocked.profileId) === want, 'block state applied')
  }
  const setPair = async (a: SeededUser, b: SeededUser, aBlocksB: boolean, bBlocksA: boolean) => {
    await setBlock(a, b, aBlocksB)
    await setBlock(b, a, bBlocksA)
  }

  const host = await connectClient(port, users.host, 'host')
  const guest = await connectClient(port, users.guest, 'guest')
  const spec = await connectClient(port, users.spec, 'spec')
  const lp1 = await connectClient(port, users.lp1, 'lp1')
  const lp2 = await connectClient(port, users.lp2, 'lp2')
  openClients.push(host, guest, spec, lp1, lp2)

  const { roomId } = await createPrivateTable(host, guest)
  const snap = [...host.frames].reverse().find((f) => f.type === 'room_snapshot' && f.roomId === roomId)
  const botSeat = snap.seats.find((s: any) => s.isBot && s.profileId)
  {
    const from = spec.frames.length
    send(spec, { type: 'watch_belot_room', roomId })
    await waitForFrame(spec, (f) => f.type === 'belot_spectator_snapshot' && f.roomId === roomId, 10_000, 'watch snapshot', from)
  }
  const matchId = await createLudoMatch(lp1, lp2)
  console.log(`belot=${roomId} ludo=${matchId}\n`)

  // ── Пътища ─────────────────────────────────────────────────────────────
  type PathResult = { ok: boolean; code?: string; isReplay?: boolean; status?: number; raw: any }
  type GiftPath = {
    id: string
    sender: TestClient
    recipient: TestClient
    send: (requestId: string) => Promise<PathResult>
    /** Брой gift събития/известия, получени от recipient след индекс `from`. */
    recipientEvents: (from: number) => number
  }

  const wsTableGift = (sender: TestClient, recipient: TestClient) => async (requestId: string): Promise<PathResult> => {
    const from = sender.frames.length
    send(sender, { type: 'send_table_gift', roomId, recipientProfileId: recipient.user.profileId, giftItemId, requestId })
    const r = await waitForFrame(sender, (f) => (f.type === 'table_gift_send_result' && f.requestId === requestId) || f.type === 'error', 6_000, 'table gift result', from)
    return { ok: r.ok === true, code: r.code, isReplay: r.isReplay, raw: r }
  }

  const paths: GiftPath[] = [
    {
      id: 'H', sender: host, recipient: lp2,
      send: async (requestId) => {
        const r = await httpJson(port, 'POST', `/api/profile/${encodeURIComponent(lp2.user.profileId)}/send-gift-item`, host.user.cookie, { giftItemId, requestId })
        return { ok: r.body?.ok === true, code: r.body?.code, status: r.status, raw: r.body }
      },
      recipientEvents: (from) => lp2.frames.slice(from).filter((f) => f.type === 'gift_item_received').length,
    },
    {
      id: 'B', sender: host, recipient: guest,
      send: wsTableGift(host, guest),
      recipientEvents: (from) => guest.frames.slice(from).filter((f) => f.type === 'table_gift_item_sent').length,
    },
    {
      id: 'SP', sender: spec, recipient: host,
      send: wsTableGift(spec, host),
      recipientEvents: (from) => host.frames.slice(from).filter((f) => f.type === 'table_gift_item_sent').length,
    },
    {
      id: 'L', sender: lp1, recipient: lp2,
      send: async (requestId) => {
        const from = lp1.frames.length
        send(lp1, { type: 'send_ludo_gift', matchId, recipientProfileId: lp2.user.profileId, giftItemId, requestId })
        const r = await waitForFrame(lp1, (f) => (f.type === 'ludo_gift_send_result' && f.requestId === requestId) || f.type === 'error', 6_000, 'ludo gift result', from)
        return { ok: r.ok === true, code: r.code, isReplay: r.isReplay, raw: r }
      },
      recipientEvents: (from) => lp2.frames.slice(from).filter((f) => f.type === 'ludo_gift_sent').length,
    },
  ]

  const cases: Array<{ name: string; aBlocksB: boolean; bBlocksA: boolean; expectedCode: string | null }> = [
    { name: 'без блокиране', aBlocksB: false, bBlocksA: false, expectedCode: null },
    { name: 'A блокира B', aBlocksB: true, bBlocksA: false, expectedCode: 'profile_blocked_by_viewer' },
    { name: 'B блокира A', aBlocksB: false, bBlocksA: true, expectedCode: 'profile_blocked_viewer' },
    { name: 'взаимно', aBlocksB: true, bBlocksA: true, expectedCode: 'profile_blocked_by_viewer' },
  ]

  for (const path of paths) {
    for (const c of cases) {
      await check(`[${path.id}] ${c.name} (sender=${path.sender.label}, recipient=${path.recipient.label})`, async () => {
        await setPair(path.sender.user, path.recipient.user, c.aBlocksB, c.bBlocksA)
        const before = wallet(path.sender.user.profileId)
        const deliveriesBefore = deliveryCount(path.recipient.user.profileId)
        const from = path.recipient.frames.length
        const requestId = randomUUID()
        const result = await path.send(requestId)
        await sleep(400)
        if (c.expectedCode === null) {
          assert(result.ok, `очакван успех: ${JSON.stringify(result.raw)}`)
          assert(wallet(path.sender.user.profileId) === before - PRICE, 'единичен debit')
          assert(txCount(requestId) === 1, 'един transaction')
          assert(path.recipientEvents(from) === 1, `получателят получава точно 1 събитие (got ${path.recipientEvents(from)})`)
        } else {
          assert(!result.ok, `очакван отказ: ${JSON.stringify(result.raw)}`)
          assert(result.code === c.expectedCode, `code=${result.code}, очакван ${c.expectedCode}`)
          if (path.id === 'H') assert(result.status === 400, `HTTP status ${result.status}`)
          assert(wallet(path.sender.user.profileId) === before, 'без debit')
          assert(txCount(requestId) === 0, 'без transaction')
          assert(deliveryCount(path.recipient.user.profileId) === deliveriesBefore, 'без delivery ред')
          assert(path.recipientEvents(from) === 0, 'без push/broadcast към получателя')
        }
      })
    }
    await setPair(path.sender.user, path.recipient.user, false, false)
  }

  // ── Client precheck contract ──────────────────────────────────────────
  await check('[P1] GET /api/profiles/:id — 403 + code в двете посоки, 200 без block', async () => {
    await setPair(users.host, users.guest, true, false)
    const byViewer = await httpJson(port, 'GET', `/api/profiles/${users.guest.profileId}`, users.host.cookie)
    assert(byViewer.status === 403 && byViewer.body?.code === 'profile_blocked_by_viewer', `${byViewer.status} ${JSON.stringify(byViewer.body)}`)
    await setPair(users.host, users.guest, false, true)
    const viewer = await httpJson(port, 'GET', `/api/profiles/${users.guest.profileId}`, users.host.cookie)
    assert(viewer.status === 403 && viewer.body?.code === 'profile_blocked_viewer', `${viewer.status} ${JSON.stringify(viewer.body)}`)
    await setPair(users.host, users.guest, false, false)
    const none = await httpJson(port, 'GET', `/api/profiles/${users.guest.profileId}`, users.host.cookie)
    assert(none.status === 200 && none.body?.ok === true, `${none.status}`)
    // Зрителят (не е закачен за стаята) също може да ползва precheck-а.
    const fromSpec = await httpJson(port, 'GET', `/api/profiles/${users.host.profileId}`, users.spec.cookie)
    assert(fromSpec.status === 200, `spectator precheck ${fromSpec.status}`)
  })

  await check('[P2/G1] bot recipient: precheck 200 и подаръкът минава (непроменено поведение)', async () => {
    assert(botSeat, 'масата има бот с profileId')
    const profile = await httpJson(port, 'GET', `/api/profiles/${botSeat.profileId}`, users.host.cookie)
    assert(profile.status === 200 && profile.body?.ok === true, `bot precheck ${profile.status} ${JSON.stringify(profile.body)}`)
    const before = wallet(users.host.profileId)
    const requestId = randomUUID()
    const from = host.frames.length
    send(host, { type: 'send_table_gift', roomId, recipientProfileId: botSeat.profileId, giftItemId, requestId })
    const r = await waitForFrame(host, (f) => f.type === 'table_gift_send_result' && f.requestId === requestId, 6_000, 'bot gift', from)
    assert(r.ok === true, JSON.stringify(r))
    assert(wallet(users.host.profileId) === before - PRICE, 'единичен debit')
  })

  // ── Race / replay ─────────────────────────────────────────────────────
  await check('[R1] block след зареждане на каталога (отворен picker) -> send отказан, без debit', async () => {
    await setPair(users.host, users.guest, false, false)
    const catalog = await httpJson(port, 'GET', '/api/gift-items', users.host.cookie)
    assert(catalog.status === 200 && Array.isArray(catalog.body?.items), 'каталогът е зареден')
    await setBlock(users.guest, users.host, true)
    const before = wallet(users.host.profileId)
    const requestId = randomUUID()
    const result = await wsTableGift(host, guest)(requestId)
    assert(!result.ok && result.code === 'profile_blocked_viewer', JSON.stringify(result.raw))
    assert(wallet(users.host.profileId) === before && txCount(requestId) === 0, 'без debit/transaction')
    await setPair(users.host, users.guest, false, false)
  })

  await check('[R2] HTTP replay (online получател) -> един debit, един push', async () => {
    const requestId = randomUUID()
    const before = wallet(users.host.profileId)
    const from = lp2.frames.length
    const first = await httpJson(port, 'POST', `/api/profile/${lp2.user.profileId}/send-gift-item`, users.host.cookie, { giftItemId, requestId })
    const replay = await httpJson(port, 'POST', `/api/profile/${lp2.user.profileId}/send-gift-item`, users.host.cookie, { giftItemId, requestId })
    await sleep(500)
    assert(first.status === 200 && replay.status === 200, `${first.status}/${replay.status} ${JSON.stringify(replay.body)}`)
    assert(first.body.transaction.transactionId === replay.body.transaction.transactionId, 'същият transaction')
    assert(wallet(users.host.profileId) === before - PRICE, 'един debit')
    const pushes = lp2.frames.slice(from).filter((f) => f.type === 'gift_item_received').length
    assert(pushes === 1, `push-ове към получателя: ${pushes}`)
  })

  await check('[R3] HTTP replay (offline получател) -> 200 и един delivery ред', async () => {
    const requestId = randomUUID()
    const deliveriesBefore = deliveryCount(users.off.profileId)
    const first = await httpJson(port, 'POST', `/api/profile/${users.off.profileId}/send-gift-item`, users.host.cookie, { giftItemId, requestId })
    const replay = await httpJson(port, 'POST', `/api/profile/${users.off.profileId}/send-gift-item`, users.host.cookie, { giftItemId, requestId })
    assert(first.status === 200, `first ${first.status}`)
    assert(replay.status === 200 && replay.body?.ok === true, `replay ${replay.status} ${JSON.stringify(replay.body)}`)
    assert(deliveryCount(users.off.profileId) === deliveriesBefore + 1, 'точно един delivery ред')
  })

  await check('[R4] HTTP replay на успешен requestId след block -> idempotent 200, без debit/известие', async () => {
    const requestId = randomUUID()
    const first = await httpJson(port, 'POST', `/api/profile/${lp2.user.profileId}/send-gift-item`, users.host.cookie, { giftItemId, requestId })
    assert(first.status === 200, `first ${first.status}`)
    await sleep(300)
    await setBlock(users.lp2, users.host, true)
    const before = wallet(users.host.profileId)
    const from = lp2.frames.length
    const replay = await httpJson(port, 'POST', `/api/profile/${lp2.user.profileId}/send-gift-item`, users.host.cookie, { giftItemId, requestId })
    await sleep(400)
    assert(replay.status === 200 && replay.body?.ok === true, `replay ${replay.status}`)
    assert(wallet(users.host.profileId) === before, 'без debit')
    assert(txCount(requestId) === 1, 'един transaction')
    assert(lp2.frames.slice(from).filter((f) => f.type === 'gift_item_received').length === 0, 'без известие')
    const fresh = await httpJson(port, 'POST', `/api/profile/${lp2.user.profileId}/send-gift-item`, users.host.cookie, { giftItemId, requestId: randomUUID() })
    assert(fresh.status === 400 && fresh.body?.code === 'profile_blocked_viewer', `fresh ${fresh.status} ${JSON.stringify(fresh.body)}`)
    await setBlock(users.lp2, users.host, false)
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
