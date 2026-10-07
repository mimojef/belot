/**
 * checkBelotSpectatorTableGiftSend.ts
 *
 * Belot spectator table gifts — тясно изключение: send_table_gift САМО от
 * регистриран spectator, САМО към участник в гледаната маса, през
 * непроменения economy path (giftItemStore.sendGiftItem). Real spawned
 * server + real WebSocket + unit проверки на resolveSpectatorTableGiftParticipants.
 *
 *   [S1]  spectator праща валиден table gift (human получател; bot също)
 *   [S2]  балансът е таксуван точно веднъж (replay на requestId не таксува пак)
 *   [S3]  нормална транзакция context='game', room_id = стаята
 *   [S4]  получателят трябва да е от гледаната маса
 *   [S5]  произволен profile -> отказ
 *   [S6]  друга (негледана) стая -> spectator_action_forbidden
 *   [S7]  втори таб без spectating -> отказ, без транзакция
 *   [S8]  недостатъчен баланс -> отказ
 *   [S9]  HTTP profile gift остава 403
 *   [S10] gift-back (същият HTTP send-gift-item path) остава 403
 *   [S11] gift coins / VIP recipient checkout остават 403
 *   [S12] phrase/emoji/bid/cut/card/sweep/replay/rating/bot reclaim/profile остават забранени
 *   [S13] participant gift поведение непроменено
 *   [S14] spectator event: senderKind='spectator', senderSeat=null, публично име
 *   [S15] participant event: senderKind='participant', senderSeat=реалното място
 *   [S16] spectator public payload без chargedPrice/recipientProfileId/wallet
 *   [U1]  unit: resolver отказва всички невалидни входове
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
import { resolveSpectatorTableGiftParticipants } from '../src/core/resolveSpectatorTableGiftParticipants.js'


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
  const root = await mkdtemp(join(tmpdir(), 'belot-spectator-gift-send-'))
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
  'senderDisplayName', 'senderKind', 'senderProfileId', 'senderSeat', 'sentAt', 'transactionId', 'type',
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

function setWallet(databaseFile: string, profileId: string, balance: number): void {
  const db = new DatabaseSync(databaseFile, { open: true, timeout: 10_000 })
  try {
    db.prepare('UPDATE profile_wallets SET yellow_coins_balance = ? WHERE profile_id = ?').run(balance, profileId)
  } finally {
    db.close()
  }
}

// ─── Run ──────────────────────────────────────────────────────────────────

console.log('\ncheckBelotSpectatorTableGiftSend\n')

// ── Unit ────────────────────────────────────────────────────────────────
await check('[U1] unit: spectator resolver rejects every invalid input and accepts only a watched-room participant', () => {
  const human = (profileId: string): any => ({ kind: 'human', identity: { profileId, displayName: profileId } })
  const bot = (profileId: string): any => ({ kind: 'bot', identity: { profileId, displayName: profileId } })
  const room: any = {
    id: 'room-1', status: 'playing', config: { isPrivateTableOrigin: true },
    seats: { bottom: { participant: human('p-host') }, right: { participant: bot('p-bot') }, top: { participant: human('p-guest') }, left: { participant: null } },
  }
  const rooms: any = { 'room-1': room, 'room-pub': { ...room, id: 'room-pub', config: { isPrivateTableOrigin: false } }, 'room-done': { ...room, id: 'room-done', status: 'finished' } }
  const conn = (extra: Record<string, unknown> = {}): any => ({ id: 'c1', status: 'connected', profileId: 'p-spec', currentRoomId: null, ...extra })
  const base = { connectionId: 'c1', rooms, claimedRoomId: 'room-1', recipientProfileId: 'p-host', getPublicDisplayName: () => 'Зрител X', watchedRoomId: 'room-1' as string | null }
  const run = (over: Record<string, unknown>, connection: any = conn()) => resolveSpectatorTableGiftParticipants({ ...base, connection, ...over } as any)

  const ok = run({})
  assert(ok.ok && ok.recipientSeat === 'bottom' && ok.senderDisplayName === 'Зрител X', `valid: ${JSON.stringify(ok)}`)
  const okBot = run({ recipientProfileId: 'p-bot' })
  assert(okBot.ok && okBot.recipientIsBot, 'bot recipient allowed (same as participant rules)')
  const rejects: Array<[string, any]> = [
    ['no connection', run({}, null)],
    ['disconnected', run({}, conn({ status: 'disconnected' }))],
    ['no profile', run({}, conn({ profileId: null }))],
    ['attached to a room', run({}, conn({ currentRoomId: 'room-1' }))],
    ['not watching', run({ watchedRoomId: null })],
    ['claims another room', run({ claimedRoomId: 'room-other' })],
    ['non-private room', run({ watchedRoomId: 'room-pub', claimedRoomId: 'room-pub' })],
    ['finished room', run({ watchedRoomId: 'room-done', claimedRoomId: 'room-done' })],
    ['sender is a participant', run({}, conn({ profileId: 'p-guest' }))],
    ['self', run({ recipientProfileId: 'p-spec' })],
    ['arbitrary profile', run({ recipientProfileId: 'p-random' })],
    ['empty recipient', run({ recipientProfileId: '  ' })],
  ]
  for (const [label, result] of rejects) assert(result.ok === false, `${label} must be rejected`)
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
    spec: seedUser(dbFile, 'spec'), poor: seedUser(dbFile, 'poor'),
  }
  for (const key of ['spec', 'poor'] as const) await grantVip(dbFile, users[key].profileId)
  const PRICE = 100
  const giftItemId = `spectator-send-gift-${randomUUID()}`
  seedGiftItem(dbFile, giftItemId, PRICE)

  const host = await connectClient(port, users.host, 'host')
  const guest = await connectClient(port, users.guest, 'guest')
  const host2 = await connectClient(port, users.host2, 'host2')
  const guest2 = await connectClient(port, users.guest2, 'guest2')
  let spec = await connectClient(port, users.spec, 'spec')
  const poor = await connectClient(port, users.poor, 'poor')
  openClients.push(host, guest, host2, guest2, spec, poor)

  const table1 = await createPrivateTable(host, guest)
  const table2 = await createPrivateTable(host2, guest2)
  const t1 = table1.roomId
  const snap = [...host.frames].reverse().find((f) => f.type === 'room_snapshot' && f.roomId === t1)
  const botSeat = snap.seats.find((s: any) => s.isBot && s.profileId)
  console.log(`table1=${t1} host=${table1.hostSeat} guest=${table1.guestSeat} bot=${botSeat?.seat} table2=${table2.roomId}\n`)

  await watch(spec, t1)
  await watch(poor, t1)
  const everyone = [host, guest, host2, guest2, spec, poor]
  const marks = new Map<TestClient, number>()
  const mark = (): void => { for (const c of everyone) marks.set(c, c.frames.length) }
  const sendGift = async (client: TestClient, roomId: string, recipientProfileId: string, requestId = randomUUID()) => {
    const from = client.frames.length
    send(client, { type: 'send_table_gift', roomId, recipientProfileId, giftItemId, requestId })
    const response = await waitForFrame(client, (f) => (f.type === 'table_gift_send_result' && f.requestId === requestId) || f.type === 'error', 6_000, `${client.label} gift response`, from)
    return { response, requestId }
  }
  const txCount = (requestId: string) => countRows(dbFile, 'SELECT COUNT(*) AS c FROM gift_item_transactions WHERE request_id = ?', requestId)

  // ── S1/S2/S3/S14/S16 ──
  const walletBefore = readWallet(dbFile, users.spec.profileId)
  mark()
  const first = await sendGift(spec, t1, users.guest.profileId)
  await waitForFrame(guest, (f) => f.type === GIFT_EVENT, 6_000, 'guest event', marks.get(guest))
  await sleep(500)

  await check('[S1] spectator sends a valid table gift to a participant of the watched room', () => {
    assert(first.response.type === 'table_gift_send_result' && first.response.ok === true, JSON.stringify(first.response))
    assert(typeof first.response.senderBalanceAfter === 'number', 'sender gets its own balance back')
  })

  await check('[S2] balance deducted exactly once (requestId replay does not charge again)', async () => {
    assert(readWallet(dbFile, users.spec.profileId) === walletBefore - PRICE, `wallet ${readWallet(dbFile, users.spec.profileId)} vs ${walletBefore - PRICE}`)
    mark()
    const replay = await sendGift(spec, t1, users.guest.profileId, first.requestId)
    assert(replay.response.ok === true && replay.response.isReplay === true, `replay ${JSON.stringify(replay.response)}`)
    await sleep(500)
    assert(readWallet(dbFile, users.spec.profileId) === walletBefore - PRICE, 'no second debit')
    assert(giftEventsFrom(guest, marks.get(guest)!).length === 0, 'no second broadcast on replay')
  })

  await check('[S3] normal transaction context=game, room_id=room, exactly one row', () => {
    const db = new DatabaseSync(dbFile, { open: true, timeout: 10_000 })
    try {
      const row = db.prepare('SELECT context, room_id, sender_profile_id, recipient_profile_id, charged_price FROM gift_item_transactions WHERE request_id = ?').get(first.requestId) as any
      assert(row.context === 'game' && row.room_id === t1, JSON.stringify(row))
      assert(row.sender_profile_id === users.spec.profileId && row.recipient_profile_id === users.guest.profileId && row.charged_price === PRICE, JSON.stringify(row))
    } finally {
      db.close()
    }
    assert(txCount(first.requestId) === 1, 'one transaction')
  })

  await check('[S14] event: senderKind=spectator, senderSeat=null, public spectator name, recipient seat', () => {
    for (const client of [host, guest, spec, poor]) {
      const event = client.frames.filter((f) => f.type === GIFT_EVENT).find((f) => f.transactionId === first.response.transactionId)
      assert(event, `${client.label} received the event`)
      assert(event.senderKind === 'spectator' && event.senderSeat === null, `${client.label}: ${JSON.stringify(event)}`)
      assert(event.senderProfileId === users.spec.profileId && String(event.senderDisplayName).startsWith('Spec spec'), `${client.label} sender ${event.senderDisplayName}`)
      assert(event.recipientSeat === table1.guestSeat, `${client.label} recipient seat`)
    }
  })

  await check('[S16] spectator public payload has no private economy fields; participants keep theirs', () => {
    const specEvent = stripMeta(spec.frames.filter((f) => f.type === GIFT_EVENT).find((f) => f.transactionId === first.response.transactionId))
    assert(JSON.stringify(Object.keys(specEvent).sort()) === JSON.stringify(SPECTATOR_GIFT_KEYS), `keys ${Object.keys(specEvent).sort()}`)
    const json = JSON.stringify(specEvent)
    for (const forbidden of ['chargedPrice', 'recipientProfileId', 'Balance', 'balance', 'wallet', 'email', 'accountId', 'reconnectToken']) {
      assert(!json.includes(forbidden), `spectator payload contains ${forbidden}`)
    }
    const guestEvent = guest.frames.filter((f) => f.type === GIFT_EVENT).find((f) => f.transactionId === first.response.transactionId)
    assert(guestEvent.chargedPrice === PRICE && guestEvent.recipientProfileId === users.guest.profileId, 'participant payload unchanged')
  })

  await check('[S1b] spectator can gift a bot seat (same rules as participants)', async () => {
    assert(botSeat, 'room has a bot with profileId')
    const res = await sendGift(spec, t1, botSeat.profileId)
    assert(res.response.ok === true, JSON.stringify(res.response))
  })

  // ── Rejections ──
  await check('[S4] recipient must belong to the watched room (table2 participant rejected)', async () => {
    const res = await sendGift(spec, t1, users.host2.profileId)
    assert(res.response.type === 'table_gift_send_result' && res.response.ok === false, JSON.stringify(res.response))
    assert(txCount(res.requestId) === 0, 'no transaction')
  })

  await check('[S5] arbitrary profile rejected', async () => {
    const res = await sendGift(spec, t1, users.poor.profileId)
    assert(res.response.ok === false, JSON.stringify(res.response))
    const random = await sendGift(spec, t1, randomUUID())
    assert(random.response.ok === false, JSON.stringify(random.response))
    assert(txCount(res.requestId) + txCount(random.requestId) === 0, 'no transaction')
  })

  await check('[S6] wrong (not watched) room -> spectator_action_forbidden', async () => {
    const res = await sendGift(spec, table2.roomId, users.host2.profileId)
    assert(res.response.type === 'error' && res.response.code === 'spectator_action_forbidden', JSON.stringify(res.response))
    assert(txCount(res.requestId) === 0, 'no transaction')
  })

  await check('[S8] insufficient balance rejected, no transaction', async () => {
    setWallet(dbFile, users.poor.profileId, 10)
    const res = await sendGift(poor, t1, users.host.profileId)
    assert(res.response.ok === false && /жълтици/.test(res.response.message ?? ''), JSON.stringify(res.response))
    assert(readWallet(dbFile, users.poor.profileId) === 10, 'wallet unchanged')
    assert(txCount(res.requestId) === 0, 'no transaction')
  })

  await check('[S9/S10] HTTP profile gift (and gift-back, same endpoint) remain 403 for the spectator', async () => {
    const res = await httpJson(port, 'POST', `/api/profile/${users.host.profileId}/send-gift-item`, users.spec.cookie, { giftItemId, requestId: randomUUID() })
    assert(res.status === 403 && res.body?.code === 'spectator_action_forbidden', `${res.status} ${JSON.stringify(res.body)}`)
  })

  await check('[S11] gift coins / VIP recipient checkout remain 403', async () => {
    const coins = await httpJson(port, 'POST', '/api/friends/gift-coins/direct', users.spec.cookie, { recipientProfileId: users.host.profileId, amount: 1_000 })
    assert(coins.status === 403 && coins.body?.code === 'spectator_action_forbidden', `coins ${coins.status} ${JSON.stringify(coins.body)}`)
    const vip = await httpJson(port, 'POST', '/api/vip/checkout', users.spec.cookie, { packageId: 'vip_30', recipientProfileId: users.host.profileId })
    assert(vip.status === 403 && vip.body?.code === 'spectator_action_forbidden', `vip ${vip.status} ${JSON.stringify(vip.body)}`)
  })

  await check('[S12] all other spectator actions remain spectator_action_forbidden', async () => {
    const actions: Array<Record<string, unknown>> = [
      { type: 'send_phrase_reaction', roomId: t1, phraseId: 'phrase_01' },
      { type: 'send_emoji_reaction', roomId: t1, emojiId: '01' },
      { type: 'submit_bid_action', roomId: t1, action: { type: 'pass' } },
      { type: 'submit_cut_index', roomId: t1, cutIndex: 5 },
      { type: 'submit_play_card', roomId: t1, cardId: 'hearts-A' },
      { type: 'submit_sweep_decision', roomId: t1, decision: 'accept' },
      { type: 'request_replay', roomId: t1 },
      { type: 'submit_partner_rating', roomId: t1, ratingValue: 5, requestId: randomUUID() },
      { type: 'resume_human_control', roomId: t1 },
      { type: 'request_leave_match', roomId: t1 },
      { type: 'request_player_profile', roomId: t1, seat: table1.hostSeat },
      { type: 'send_ludo_gift', matchId: 'any', recipientProfileId: users.host.profileId, giftItemId, requestId: randomUUID() },
    ]
    for (const action of actions) {
      const from = spec.frames.length
      send(spec, action)
      const response = await waitForFrame(spec, (f) => f.type === 'error' || f.type === 'player_profile', 5_000, `${action.type} response`, from)
      assert(response.type === 'error' && response.code === 'spectator_action_forbidden', `${action.type}: ${JSON.stringify(response)}`)
    }
  })

  await check('[S13/S15] participant gift unchanged: senderKind=participant, real senderSeat, charged once', async () => {
    const hostWallet = readWallet(dbFile, users.host.profileId)
    mark()
    const res = await sendGift(host, t1, users.guest.profileId)
    assert(res.response.ok === true, JSON.stringify(res.response))
    const event = await waitForFrame(guest, (f) => f.type === GIFT_EVENT && f.transactionId === res.response.transactionId, 6_000, 'participant event', marks.get(guest))
    assert(event.senderKind === 'participant' && event.senderSeat === table1.hostSeat, JSON.stringify(event))
    assert(event.chargedPrice === PRICE && event.recipientProfileId === users.guest.profileId, 'participant payload')
    assert(readWallet(dbFile, users.host.profileId) === hostWallet - PRICE, 'host charged once')
    const specCopy = await waitForFrame(spec, (f) => f.type === GIFT_EVENT && f.transactionId === res.response.transactionId, 6_000, 'spectator sees participant gift', marks.get(spec))
    assert(specCopy.senderKind === 'participant' && specCopy.senderSeat === table1.hostSeat, 'spectator copy marks participant sender')
  })

  // S7 последен: нов таб на същия профил изтласква spectator connection-а.
  await check('[S7] second tab of the same profile (not spectating) -> rejected, no transaction', async () => {
    const tab2 = await connectClient(port, users.spec, 'spec-tab2')
    openClients.push(tab2)
    await sleep(500)
    const res = await sendGift(tab2, t1, users.guest.profileId)
    const rejected = (res.response.type === 'error') || (res.response.type === 'table_gift_send_result' && res.response.ok === false)
    assert(rejected, JSON.stringify(res.response))
    assert(txCount(res.requestId) === 0, 'no transaction')
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
