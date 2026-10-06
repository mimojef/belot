/**
 * checkBelotSpectatorPublicTableGift.ts
 *
 * Phase 4B (D7) — публичната летяща table-gift анимация към Belot spectators.
 * Real spawned-server + real WebSocket (helpers mirror на
 * checkBelotSpectatorPublicReactions.ts) + in-process unit проверки на
 * broadcastBelotSpectatorPublicEvent.
 *
 *   [G1] player table gift -> participants получават table_gift_item_sent както преди
 *        (вкл. chargedPrice/recipientProfileId)
 *   [G2] player table gift -> spectator на същата маса получава публичния event веднъж
 *   [G3] spectator на ДРУГА маса не го получава
 *   [G4] unwatched / disconnected spectator не го получава; нов watch не replay-ва
 *        летяща анимация (само static overlay в snapshot-а)
 *   [G5] spectator payload = точно публичните overlay полета (без chargedPrice,
 *        recipientProfileId, balance/ledger данни); иначе идентичен с participant-ския
 *   [G9] spectator send_table_gift -> spectator_action_forbidden, без transaction,
 *        без промяна в портфейла, без event към никого
 *   [U1] unit: helper projection-ът маха chargedPrice/recipientProfileId и всяко
 *        извънредно поле
 *   [U2] source review: participant broadcast-ът е непроменен, spectator fan-out
 *        е СЛЕД него със същия event; send guard-ът стои
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
import { broadcastBelotSpectatorPublicEvent } from '../src/core/broadcastBelotSpectatorSnapshot.js'


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
  const root = await mkdtemp(join(tmpdir(), 'belot-spectator-table-gift-'))
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

// ─── Helpers (Phase 4A/4B) ───────────────────────────────────────────────────

const GIFT_EVENT = 'table_gift_item_sent'
function giftEventsFrom(client: TestClient, from: number): any[] {
  return client.frames.slice(from).filter((f) => f.type === GIFT_EVENT)
}
// Публичните overlay полета, които spectator snapshot-ът вече показва
// (activeTableGifts), плюс type/roomId.
const SPECTATOR_GIFT_KEYS = [
  'expiresAt', 'giftItemId', 'giftName', 'imageUrl', 'recipientSeat', 'roomId',
  'senderDisplayName', 'senderProfileId', 'senderSeat', 'sentAt', 'transactionId', 'type',
]
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


// ─── Run ──────────────────────────────────────────────────────────────────

console.log('\ncheckBelotSpectatorPublicTableGift\n')

// ── Unit ────────────────────────────────────────────────────────────────
{
  const emptySeat = { participant: null }
  const room: any = { id: 'room-u', seats: { bottom: emptySeat, right: emptySeat, top: emptySeat, left: emptySeat } }
  const conn = (id: string): any => ({ id, profileId: `p-${id}`, currentRoomId: null, status: 'connected' })

  await check('[U1] unit: table-gift projection drops chargedPrice/recipientProfileId and any extra field', () => {
    const registry = createBelotSpectatorRegistry()
    const sent: string[] = []
    const sock: any = { readyState: WebSocket.OPEN, send: (s: string) => { sent.push(s) } }
    registry.watch('c1', 'room-u')
    const event: any = {
      type: 'table_gift_item_sent', roomId: 'room-u', transactionId: 'tx-1', giftItemId: 'g-1', giftName: 'Rose',
      imageUrl: '/uploads/gift-items/rose.webp', senderProfileId: 'p-s', senderSeat: 'bottom', senderDisplayName: 'Sender',
      recipientProfileId: 'p-r', recipientSeat: 'top', chargedPrice: 100, sentAt: 'a', expiresAt: 'b',
      senderBalanceAfter: 4900, ledgerId: 'L1', ownHand: [{ id: 'hearts-A' }],
    }
    const count = broadcastBelotSpectatorPublicEvent({ room, event, registry, getConnection: (id) => conn(id), getSocket: () => sock })
    assert(count === 1 && sent.length === 1, `sent=${count}`)
    const payload = JSON.parse(sent[0]!)
    assert(JSON.stringify(Object.keys(payload).sort()) === JSON.stringify(SPECTATOR_GIFT_KEYS), `keys: ${Object.keys(payload).sort()}`)
    assert(payload.senderSeat === 'bottom' && payload.recipientSeat === 'top' && payload.imageUrl === event.imageUrl, 'public values preserved')
  })

  await check('[U2] source review: participant broadcast untouched, spectator fan-out after it with the same event, guard kept', async () => {
    const indexSource = (await readFile(join(sourceServerRoot, 'src', 'index.ts'), 'utf8')).replace(/\r\n/g, '\n')
    const guardStart = indexSource.indexOf('const BELOT_SPECTATOR_FORBIDDEN_MESSAGE_TYPES')
    const guard = indexSource.slice(guardStart, indexSource.indexOf('])', guardStart))
    assert(guard.includes("'send_table_gift'"), 'spectator send guard must still forbid send_table_gift')
    const start = indexSource.indexOf("if (message.type === 'send_table_gift') {")
    const block = indexSource.slice(start, indexSource.indexOf("if (message.type === 'resume_room') {", start))
    const participantAt = block.indexOf('broadcastToRoomConnections(resolution.room, socketRegistry, tableGiftMsg)')
    const fanOutAt = block.indexOf('broadcastBelotSpectatorPublicEvent(')
    assert(participantAt !== -1, 'participant broadcast must remain')
    assert(fanOutAt > participantAt, 'spectator fan-out must come after the participant broadcast')
    assert(block.slice(fanOutAt).includes('event: tableGiftMsg'), 'fan-out must reuse the same public event')
    const msgStart = block.indexOf('const tableGiftMsg = {')
    const msg = block.slice(msgStart, block.indexOf('}\n', msgStart))
    assert(msg.includes('chargedPrice: giftResult.transaction.chargedPrice') && msg.includes('recipientProfileId: resolution.recipientProfileId'), 'participant payload keeps its fields')
  })
}

// ── Integration ─────────────────────────────────────────────────────────
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
    spec: seedUser(dbFile, 'spec'), specOther: seedUser(dbFile, 'specOther'),
    specUnwatched: seedUser(dbFile, 'specUnwatched'), specGone: seedUser(dbFile, 'specGone'), specLate: seedUser(dbFile, 'specLate'),
  }
  for (const key of ['spec', 'specOther', 'specUnwatched', 'specGone', 'specLate'] as const) await grantVip(dbFile, users[key].profileId)
  const giftItemId = `spectator-table-gift-${randomUUID()}`
  seedGiftItem(dbFile, giftItemId, 100)

  const host = await connectClient(port, users.host, 'host')
  const guest = await connectClient(port, users.guest, 'guest')
  const host2 = await connectClient(port, users.host2, 'host2')
  const guest2 = await connectClient(port, users.guest2, 'guest2')
  const spec = await connectClient(port, users.spec, 'spec')
  const specOther = await connectClient(port, users.specOther, 'specOther')
  const specUnwatched = await connectClient(port, users.specUnwatched, 'specUnwatched')
  const specGone = await connectClient(port, users.specGone, 'specGone')
  openClients.push(host, guest, host2, guest2, spec, specOther, specUnwatched, specGone)

  const table1 = await createPrivateTable(host, guest)
  const table2 = await createPrivateTable(host2, guest2)
  console.log(`table1=${table1.roomId} (host=${table1.hostSeat}, guest=${table1.guestSeat}) table2=${table2.roomId}\n`)

  await watch(spec, table1.roomId)
  await watch(specOther, table2.roomId)
  await watch(specUnwatched, table1.roomId)
  await watch(specGone, table1.roomId)
  send(specUnwatched, { type: 'unwatch_belot_room', roomId: table1.roomId })
  await waitForFrame(specUnwatched, (f) => f.type === 'belot_spectate_ended', 5_000, 'unwatched')
  specGone.ws.close()
  await sleep(500)

  const everyone = [host, guest, host2, guest2, spec, specOther, specUnwatched]
  const marks = new Map<TestClient, number>()
  const mark = (): void => { for (const c of everyone) marks.set(c, c.frames.length) }

  // ── Player table gift host -> guest ─────────────────────────────────────
  mark()
  const requestId = randomUUID()
  send(host, { type: 'send_table_gift', roomId: table1.roomId, recipientProfileId: users.guest.profileId, giftItemId, requestId })
  const result = await waitForFrame(host, (f) => f.type === 'table_gift_send_result' && f.requestId === requestId, 10_000, 'send result', marks.get(host))
  await waitForFrame(spec, (f) => f.type === GIFT_EVENT, 5_000, 'spectator gift event', marks.get(spec))
  await sleep(600)

  await check('[G1] player table gift -> participants receive table_gift_item_sent as before', () => {
    assert(result.ok === true, `send result: ${JSON.stringify(result)}`)
    for (const client of [host, guest]) {
      const got = giftEventsFrom(client, marks.get(client)!)
      assert(got.length === 1, `${client.label}: ${got.length} gift events`)
      const e = got[0]
      assert(e.senderSeat === table1.hostSeat && e.recipientSeat === table1.guestSeat, `${client.label} seats: ${JSON.stringify(e)}`)
      assert(e.chargedPrice === 100 && e.recipientProfileId === users.guest.profileId, `${client.label}: participant payload unchanged`)
    }
  })

  await check('[G2] spectator of the same room receives the public event exactly once', () => {
    const got = giftEventsFrom(spec, marks.get(spec)!)
    assert(got.length === 1, `${got.length} events`)
    assert(got[0].roomId === table1.roomId && got[0].senderSeat === table1.hostSeat && got[0].recipientSeat === table1.guestSeat, JSON.stringify(got[0]))
  })

  await check('[G5] spectator payload = public overlay fields only; otherwise identical to the participant payload', () => {
    const specPayload = stripMeta(giftEventsFrom(spec, marks.get(spec)!)[0])
    const participantPayload = stripMeta(giftEventsFrom(guest, marks.get(guest)!)[0])
    assert(JSON.stringify(Object.keys(specPayload).sort()) === JSON.stringify(SPECTATOR_GIFT_KEYS), `keys: ${Object.keys(specPayload).sort()}`)
    for (const key of SPECTATOR_GIFT_KEYS) {
      assert(JSON.stringify(specPayload[key]) === JSON.stringify(participantPayload[key]), `${key} differs`)
    }
    const json = JSON.stringify(specPayload)
    for (const forbidden of ['chargedPrice', 'recipientProfileId', 'Balance', 'ledger', 'ownHand', 'reconnectToken', 'email']) {
      assert(!json.includes(forbidden), `spectator payload must not contain ${forbidden}`)
    }
  })

  await check('[G3] spectator of another room does not receive it', () => {
    assert(giftEventsFrom(specOther, marks.get(specOther)!).length === 0, 'specOther received a table1 gift')
    for (const client of [host2, guest2]) assert(giftEventsFrom(client, marks.get(client)!).length === 0, `${client.label} received a table1 gift`)
  })

  await check('[G4] unwatched / disconnected spectator gets nothing; a fresh watch gets only the static overlay, no flight event', async () => {
    assert(giftEventsFrom(specUnwatched, marks.get(specUnwatched)!).length === 0, 'unwatched spectator received the gift event')
    assert(specGone.frames.filter((f) => f.type === GIFT_EVENT).length === 0, 'closed spectator received the gift event')
    const specLate = await connectClient(port, users.specLate, 'specLate')
    openClients.push(specLate)
    await watch(specLate, table1.roomId)
    await sleep(800)
    assert(specLate.frames.filter((f) => f.type === GIFT_EVENT).length === 0, 'late watcher must not get a replayed flight event')
    const snap = specLate.frames.filter((f) => f.type === 'belot_spectator_snapshot').pop()
    const overlay = (snap?.activeTableGifts ?? []).find((g: any) => g.recipientSeat === table1.guestSeat)
    assert(overlay !== undefined, 'static overlay still comes from the spectator snapshot')
    assert(!JSON.stringify(snap.activeTableGifts).includes('chargedPrice'), 'snapshot overlay has no price')
  })

  await check('[G9] spectator send_table_gift -> spectator_action_forbidden, no transaction, no wallet change, no event', async () => {
    mark()
    const walletBefore = readWallet(dbFile, users.spec.profileId)
    const specRequestId = randomUUID()
    send(spec, { type: 'send_table_gift', roomId: table1.roomId, recipientProfileId: users.host.profileId, giftItemId, requestId: specRequestId })
    const error = await waitForFrame(spec, (f) => f.type === 'error' || f.type === 'table_gift_send_result', 5_000, 'spectator gift response', marks.get(spec))
    assert(error.type === 'error' && error.code === 'spectator_action_forbidden', JSON.stringify(error))
    await sleep(800)
    assert(readWallet(dbFile, users.spec.profileId) === walletBefore, 'spectator wallet unchanged')
    assert(countRows(dbFile, 'SELECT COUNT(*) AS c FROM gift_item_transactions WHERE request_id = ?', specRequestId) === 0, 'no gift transaction')
    for (const client of everyone) assert(giftEventsFrom(client, marks.get(client)!).length === 0, `${client.label} received a gift event from a spectator`)
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
