/**
 * checkBelotSpectatorPublicReactions.ts
 *
 * Phase 4A (D6) — публични phrase/emoji presentation събития към Belot
 * spectators. Real spawned-server + real WebSocket (helpers mirror на
 * checkBelotSpectatorWebSocket.ts) + in-process unit проверки на
 * broadcastBelotSpectatorPublicEvent.
 *
 *   [P1] player phrase -> participants получават както преди
 *   [P2] player phrase -> spectator на същата маса получава същия event (веднъж)
 *   [P5] spectator phrase send -> spectator_action_forbidden, нищо не стига до никого
 *   [E1] player emoji -> participants получават както преди
 *   [E2] player emoji -> spectator на същата маса получава същия event (веднъж)
 *   [E5] spectator emoji send -> spectator_action_forbidden, нищо не стига до никого
 *   [F1] spectator на ДРУГА маса не получава event-а (и обратно)
 *   [F2] unwatched / disconnected spectator не получава event; нов watch не
 *        replay-ва стари phrase/emoji (transient, без ledger)
 *   [F3] spectator payload = точно публичните полета {type, roomId, seat,
 *        phraseId|emojiId}, идентичен с participant payload-а; seat = sender
 *   [U1] unit: helper-ът whitelist-ва полетата (извънредни полета не минават)
 *   [U2] unit: чужда стая / участник / затворен socket / disconnected -> 0 изпратени
 *   [U3] source review: participant loop-ът е непроменен, fan-out е СЛЕД него,
 *        а spectator send guard-ът (BELOT_SPECTATOR_FORBIDDEN_MESSAGE_TYPES) стои
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
  const root = await mkdtemp(join(tmpdir(), 'belot-spectator-reactions-'))
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

const REACTION_TYPES = ['phrase_reaction', 'emoji_reaction']
function reactionsFrom(client: TestClient, from: number): any[] {
  return client.frames.slice(from).filter((f) => REACTION_TYPES.includes(f.type))
}
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

console.log('\ncheckBelotSpectatorPublicReactions\n')

// ── Unit: broadcastBelotSpectatorPublicEvent ─────────────────────────────
{
  type FakeSocket = { readyState: number; sent: string[]; send: (s: string) => void }
  const fakeSocket = (readyState: number = WebSocket.OPEN): FakeSocket => {
    const sock: FakeSocket = { readyState, sent: [], send: (s) => { sock.sent.push(s) } }
    return sock
  }
  const emptySeat = { participant: null }
  const room: any = { id: 'room-u', seats: { bottom: emptySeat, right: emptySeat, top: emptySeat, left: emptySeat } }
  const seatedRoom: any = {
    id: 'room-u',
    seats: { ...room.seats, top: { participant: { kind: 'human', identity: { profileId: 'p-seated' } } } },
  }
  const conn = (id: string, extra: Record<string, unknown> = {}): any => ({ id, profileId: `p-${id}`, currentRoomId: null, status: 'connected', ...extra })

  await check('[U1] unit: helper whitelists the public fields only', () => {
    const registry = createBelotSpectatorRegistry()
    const sock = fakeSocket()
    registry.watch('c1', 'room-u')
    const event: any = { type: 'phrase_reaction', roomId: 'room-u', seat: 'right', phraseId: 'phrase_04', ownHand: [{ id: 'hearts-A' }], reconnectToken: 'secret' }
    const sent = broadcastBelotSpectatorPublicEvent({ room, event, registry, getConnection: (id) => conn(id), getSocket: () => sock as any })
    assert(sent === 1 && sock.sent.length === 1, `sent=${sent}`)
    const payload = JSON.parse(sock.sent[0]!)
    assert(JSON.stringify(Object.keys(payload).sort()) === JSON.stringify(['phraseId', 'roomId', 'seat', 'type']), `keys: ${Object.keys(payload)}`)
    const emojiSock = fakeSocket()
    broadcastBelotSpectatorPublicEvent({ room, event: { type: 'emoji_reaction', roomId: 'room-u', seat: 'left', emojiId: '03', extra: 1 } as any, registry, getConnection: (id) => conn(id), getSocket: () => emojiSock as any })
    const emojiPayload = JSON.parse(emojiSock.sent[0]!)
    assert(JSON.stringify(Object.keys(emojiPayload).sort()) === JSON.stringify(['emojiId', 'roomId', 'seat', 'type']), `emoji keys: ${Object.keys(emojiPayload)}`)
  })

  await check('[U2] unit: other room / participant / closed socket / disconnected / unknown -> nothing sent', () => {
    const registry = createBelotSpectatorRegistry()
    const event = { type: 'emoji_reaction' as const, roomId: 'room-u', seat: 'bottom' as const, emojiId: '01' }
    const socks: Record<string, FakeSocket> = {
      other: fakeSocket(), member: fakeSocket(), seated: fakeSocket(), closed: fakeSocket(WebSocket.CLOSED), offline: fakeSocket(), ok: fakeSocket(),
    }
    registry.watch('other', 'room-other')
    for (const id of ['member', 'seated', 'closed', 'offline', 'ok', 'ghost']) registry.watch(id, 'room-u')
    const connections: Record<string, any> = {
      other: conn('other'),
      member: conn('member', { currentRoomId: 'room-x' }),
      seated: conn('seated', { profileId: 'p-seated' }),
      closed: conn('closed'),
      offline: conn('offline', { status: 'disconnected' }),
      ok: conn('ok'),
    }
    const deps = {
      registry,
      getConnection: (id: string) => connections[id] ?? null,
      getSocket: (id: string) => (socks[id] as any) ?? null,
    }
    const sent = broadcastBelotSpectatorPublicEvent({ room: seatedRoom, event, ...deps })
    assert(sent === 1, `exactly the eligible spectator receives it, got ${sent}`)
    for (const id of ['other', 'member', 'seated', 'closed', 'offline']) assert(socks[id]!.sent.length === 0, `${id} must receive nothing`)
    assert(socks.ok!.sent.length === 1, 'ok spectator receives the event')
    const mismatched = broadcastBelotSpectatorPublicEvent({ room: seatedRoom, event: { ...event, roomId: 'room-other' }, ...deps })
    assert(mismatched === 0, 'event roomId must match the room')
  })

  await check('[U3] source review: participant loop untouched, spectator fan-out after it, send guard kept', async () => {
    const indexSource = (await readFile(join(sourceServerRoot, 'src', 'index.ts'), 'utf8')).replace(/\r\n/g, '\n')
    const guardStart = indexSource.indexOf('const BELOT_SPECTATOR_FORBIDDEN_MESSAGE_TYPES')
    const guard = indexSource.slice(guardStart, indexSource.indexOf('])', guardStart))
    assert(guard.includes("'send_emoji_reaction'") && guard.includes("'send_phrase_reaction'"), 'spectator send guard must still forbid emoji/phrase')
    const handlers = [['send_emoji_reaction', 'emojiMsg', 'emojiRoom'], ['send_phrase_reaction', 'phraseMsg', 'phraseRoom']] as const
    for (const [type, msgVar, roomVar] of handlers) {
      const start = indexSource.indexOf(`if (message.type === '${type}') {`)
      const block = indexSource.slice(start, indexSource.indexOf('\n        return\n', start))
      const loopAt = block.indexOf('for (const s of SERVER_SEAT_ORDER)')
      const participantSendAt = block.indexOf(`sendJsonMessage(sock, ${msgVar})`)
      const fanOutAt = block.indexOf('broadcastBelotSpectatorPublicEvent(')
      assert(loopAt !== -1 && participantSendAt > loopAt, `${type}: participant loop must remain`)
      assert(fanOutAt > participantSendAt, `${type}: spectator fan-out must come after participant broadcast`)
      const fanOut = block.slice(fanOutAt)
      assert(fanOut.includes(`room: ${roomVar}`) && fanOut.includes(`event: ${msgVar}`), `${type}: fan-out must reuse the same public event`)
    }
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
  console.log(`table1=${table1.roomId} (host=${table1.hostSeat}) table2=${table2.roomId}\n`)

  await watch(spec, table1.roomId)
  await watch(specOther, table2.roomId)
  await watch(specUnwatched, table1.roomId)
  await watch(specGone, table1.roomId)
  // F2 setup: един се отписва, друг затваря socket-а.
  send(specUnwatched, { type: 'unwatch_belot_room', roomId: table1.roomId })
  await waitForFrame(specUnwatched, (f) => f.type === 'belot_spectate_ended', 5_000, 'unwatched')
  specGone.ws.close()
  await sleep(500)

  const everyone = [host, guest, host2, guest2, spec, specOther, specUnwatched]
  const marks = new Map<TestClient, number>()
  const mark = (): void => { for (const c of everyone) marks.set(c, c.frames.length) }

  // ── Phrase ─────────────────────────────────────────────────────────────
  mark()
  send(host, { type: 'send_phrase_reaction', roomId: table1.roomId, phraseId: 'phrase_03' })
  await waitForFrame(spec, (f) => f.type === 'phrase_reaction', 5_000, 'spectator phrase', marks.get(spec))
  await sleep(600)
  const phraseMarks = new Map(marks)

  await check('[P1] player phrase -> participants receive it as before', () => {
    for (const client of [host, guest]) {
      const got = reactionsFrom(client, phraseMarks.get(client)!)
      assert(got.length === 1, `${client.label}: ${got.length} reactions`)
      assert(got[0].type === 'phrase_reaction' && got[0].seat === table1.hostSeat && got[0].phraseId === 'phrase_03', `${client.label}: ${JSON.stringify(got[0])}`)
    }
  })

  await check('[P2] player phrase -> spectator of the same room receives it exactly once', () => {
    const got = reactionsFrom(spec, phraseMarks.get(spec)!)
    assert(got.length === 1 && got[0].type === 'phrase_reaction' && got[0].roomId === table1.roomId, JSON.stringify(got))
  })

  await check('[F3] spectator phrase payload == participant payload, only public fields, seat = sender', () => {
    const specPayload = stripMeta(reactionsFrom(spec, phraseMarks.get(spec)!)[0])
    const guestPayload = stripMeta(reactionsFrom(guest, phraseMarks.get(guest)!)[0])
    assert(JSON.stringify(specPayload) === JSON.stringify(guestPayload), `spectator ${JSON.stringify(specPayload)} vs participant ${JSON.stringify(guestPayload)}`)
    assert(JSON.stringify(Object.keys(specPayload).sort()) === JSON.stringify(['phraseId', 'roomId', 'seat', 'type']), `keys ${Object.keys(specPayload)}`)
    assert(specPayload.seat === table1.hostSeat, 'seat is the real sender seat')
  })

  // ── Emoji ──────────────────────────────────────────────────────────────
  mark()
  send(guest, { type: 'send_emoji_reaction', roomId: table1.roomId, emojiId: '05' })
  await waitForFrame(spec, (f) => f.type === 'emoji_reaction', 5_000, 'spectator emoji', marks.get(spec))
  await sleep(600)
  const emojiMarks = new Map(marks)

  await check('[E1] player emoji -> participants receive it as before', () => {
    for (const client of [host, guest]) {
      const got = reactionsFrom(client, emojiMarks.get(client)!)
      assert(got.length === 1 && got[0].type === 'emoji_reaction' && got[0].seat === table1.guestSeat && got[0].emojiId === '05', `${client.label}: ${JSON.stringify(got)}`)
    }
  })

  await check('[E2] player emoji -> spectator of the same room receives it exactly once (same payload)', () => {
    const got = reactionsFrom(spec, emojiMarks.get(spec)!)
    assert(got.length === 1, `${got.length} reactions`)
    const guestPayload = stripMeta(reactionsFrom(guest, emojiMarks.get(guest)!)[0])
    assert(JSON.stringify(stripMeta(got[0])) === JSON.stringify(guestPayload), 'identical to participant payload')
    assert(JSON.stringify(Object.keys(stripMeta(got[0])).sort()) === JSON.stringify(['emojiId', 'roomId', 'seat', 'type']), 'public fields only')
  })

  await check('[F1] spectator of another room receives neither; table2 events reach only its own spectator', async () => {
    assert(reactionsFrom(specOther, phraseMarks.get(specOther)!).length === 0, 'specOther got a table1 reaction')
    for (const client of [host2, guest2]) assert(reactionsFrom(client, phraseMarks.get(client)!).length === 0, `${client.label} got a table1 reaction`)
    mark()
    send(host2, { type: 'send_phrase_reaction', roomId: table2.roomId, phraseId: 'phrase_05' })
    await waitForFrame(specOther, (f) => f.type === 'phrase_reaction', 5_000, 'table2 spectator phrase', marks.get(specOther))
    await sleep(600)
    assert(reactionsFrom(spec, marks.get(spec)!).length === 0, 'table1 spectator must not get a table2 phrase')
  })

  await check('[F2] unwatched / disconnected spectator gets nothing; a fresh watch replays nothing', async () => {
    assert(reactionsFrom(specUnwatched, phraseMarks.get(specUnwatched)!).length === 0, 'unwatched spectator received a reaction')
    assert(specGone.frames.filter((f) => REACTION_TYPES.includes(f.type)).length === 0, 'closed spectator received a reaction')
    const specLate = await connectClient(port, users.specLate, 'specLate')
    openClients.push(specLate)
    await watch(specLate, table1.roomId)
    await sleep(800)
    assert(specLate.frames.filter((f) => REACTION_TYPES.includes(f.type)).length === 0, 'late watcher must not get replayed reactions')
  })

  // ── Spectator send stays forbidden ─────────────────────────────────────
  const forbiddenSends = [
    ['[P5] spectator phrase send -> spectator_action_forbidden, delivered to nobody', { type: 'send_phrase_reaction', roomId: table1.roomId, phraseId: 'phrase_01' }, 'phrase_reaction'],
    ['[E5] spectator emoji send -> spectator_action_forbidden, delivered to nobody', { type: 'send_emoji_reaction', roomId: table1.roomId, emojiId: '01' }, 'emoji_reaction'],
  ] as const
  for (const [label, action, reactionType] of forbiddenSends) {
    await check(label, async () => {
      mark()
      send(spec, action)
      const error = await waitForFrame(spec, (f) => f.type === 'error', 5_000, `${action.type} response`, marks.get(spec))
      assert(error.code === 'spectator_action_forbidden', JSON.stringify(error))
      await sleep(800)
      for (const client of everyone) {
        const leaked = client.frames.slice(marks.get(client)!).filter((f) => f.type === reactionType)
        assert(leaked.length === 0, `${client.label} received ${reactionType} from a spectator`)
      }
    })
  }
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
