/** Targeted adapter + real WS checks. Only disposable databases, no live balances/config. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import WebSocket from 'ws'
import { createSvaraLobby } from '../src/games/svara/createSvaraLobby.js'
import { createSvaraMatchRuntime } from '../src/games/svara/runtime/svaraMatchRuntime.js'
import { SVARA_SNAPSHOT_FORBIDDEN_KEYS } from '../src/games/svara/protocol/svaraSnapshotProtocol.js'
import { parseClientMessage } from '../src/protocol/parseClientMessage.js'
import { setSupportedMatchStakes } from '../src/matchmaking/matchmakingTypes.js'
import { SVARA_ALLOWED_ROLES, type SvaraAccessSession } from '../src/games/svara/svaraAccess.js'

let passed = 0
let failed = 0
async function check(label: string, fn: () => unknown | Promise<unknown>) {
  try { await fn(); passed++; console.log(`  PASS ${label}`) }
  catch (error) { failed++; console.error(`  FAIL ${label}:`, error) }
}
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
const requestId = () => randomUUID()
const create = (capacity = 2, startMode = 'manual', extra = {}) => ({ type: 'create_svara_table', requestId: requestId(), capacity, entryFee: 5000, entryPercent: 2, startMode, ...extra })
const command = (type: string, matchId: string, extra = {}) => ({ type, matchId, requestId: requestId(), ...extra })

function checkPrivacy(value: unknown, publicOnly = false): void {
  if (!value || typeof value !== 'object') return
  for (const [key, nested] of Object.entries(value)) {
    assert(!SVARA_SNAPSHOT_FORBIDDEN_KEYS.includes(key), `internal key ${key}`)
    if (publicOnly) assert(!['cards', 'you', 'betting', 'looked', 'history', 'round'].includes(key), `private key ${key}`)
    checkPrivacy(nested, publicOnly)
  }
}

console.log('\nSvara lobby 2Б.3.3 — adapter and real WebSocket\n')
await check('parser: bounded IDs/settings; forged identity and system fields never enter commands', () => {
  const parsed = parseClientMessage(JSON.stringify(create(3, 'auto', { profileId: 'victim', playerId: 'victim', creator: { playerId: 'victim' }, systemCommand: 'start-next-round' })))!
  assert(parsed)
  for (const key of ['profileId', 'playerId', 'creator', 'systemCommand']) assert(!(key in parsed))
  for (const extra of [{ capacity: 1 }, { capacity: 5 }, { entryFee: -10 }, { entryFee: 51 }, { entryFee: Infinity }, { entryPercent: 4 }, { entryPercent: null }, { startMode: 'other' }, { requestId: '' }, { requestId: 'x'.repeat(65) }]) {
    assert.equal(parseClientMessage(JSON.stringify(create(2, 'auto', extra))), null)
  }
  assert.equal(parseClientMessage(JSON.stringify(command('join_svara_table', 'x'.repeat(65)))), null)
  assert.equal(parseClientMessage(JSON.stringify({ type: 'svara_system_command', command: { type: 'start-next-round' } })), null)
  // Smoke for the shared parser: existing game messages retain their shape.
  setSupportedMatchStakes([5000])
  assert.deepEqual(parseClientMessage('{"type":"join_matchmaking","stake":5000}'), { type: 'join_matchmaking', stake: 5000, displayName: undefined })
  assert.deepEqual(parseClientMessage('{"type":"leave_ludo_room"}'), { type: 'leave_ludo_room' })
})

await check('adapter: actual dealt cards stay private; live role/flag checks cover every delivery', () => {
  const previousFlag = process.env.SVARA_TEST_ENABLED
  process.env.SVARA_TEST_ENABLED = '1'
  try {
    // Детерминиран dealer/ред (2Б.3.7.4А): "look" вече важи само на действителния ход,
    // затова тестът не може да разчита на непосят (Math.random) избор на дилър.
    const runtime = createSvaraMatchRuntime({ random: { nextInt: () => 0 } })
    const lobby = createSvaraLobby({ runtime, hasOtherGameCommitment: () => false })
    const frames = new Map<string, any[]>()
    const sessions = new Map<string, SvaraAccessSession>()
    for (const id of ['a', 'b', 'observer']) {
      sessions.set(id, { account: { role: 'admin' }, profile: { profileId: id } })
      frames.set(id, [])
      lobby.attachConnection(id, { profileId: id, getSession: () => sessions.get(id)!, send: (frame) => frames.get(id)!.push(typeof frame === 'string' ? JSON.parse(frame) : frame) })
      lobby.handle(id, { type: 'request_svara_tables_list' })
    }
    runtime.registerMatch({ matchId: 'dealt', creator: { playerId: 'a' }, capacity: 2, entryFee: 5000, startMode: 'auto' })
    runtime.executeParticipantCommand('dealt', { playerId: 'b' }, 'join', { type: 'join-seat' })
    runtime.executeSystemCommand('dealt', 'deal', { type: 'start-next-round' })
    runtime.executeParticipantCommand('dealt', { playerId: 'b' }, 'look', { type: 'look' })
    for (const id of ['a', 'b']) lobby.handle(id, { type: 'request_svara_table_state', matchId: 'dealt' })
    const a = frames.get('a')!.findLast((f) => f.type === 'svara_match_snapshot')
    const b = frames.get('b')!.findLast((f) => f.type === 'svara_match_snapshot')
    assert.equal(a.type, 'svara_match_snapshot')
    assert.equal(a.you.playerId, 'a'); assert.equal(a.you.cards, null)
    assert.equal(b.you.playerId, 'b'); assert.equal(b.you.cards.length, 3)
    checkPrivacy(a); checkPrivacy(b)
    const internal = runtime.exportInternalStateForServer('dealt')
    assert(internal.round && 'hands' in internal.round)
    for (const card of internal.round.hands.b!) assert(!JSON.stringify(a).includes(`"${card}"`))
    lobby.handle('observer', { type: 'request_svara_tables_list' })
    checkPrivacy(frames.get('observer')!.at(-1), true)
    lobby.handle('observer', { type: 'request_svara_table_state', matchId: 'dealt' })
    assert.equal(frames.get('observer')!.at(-1).code, 'not_a_participant')
    sessions.set('observer', { account: { role: 'player' }, profile: { profileId: 'observer' } })
    const count = frames.get('observer')!.length
    lobby.handle('b', { type: 'leave_svara_table', matchId: 'dealt', requestId: 'exit' })
    assert.equal(frames.get('observer')!.length, count, 'no pushes after role demotion')
    // 2Б.3.7.1: a е единственият останал → избор „Покажи“/„Скрий“ преди края; скрива, за да завърши мачът.
    lobby.handle('a', { type: 'submit_svara_command', matchId: 'dealt', commandId: 'hide', expectedRevision: runtime.getMatchRevision('dealt'), command: { type: 'hide-cards' } })
    assert.equal(lobby.findCommitment('a'), null, 'finished match releases winner')
    assert.equal(lobby.findCommitment('b'), null, 'voluntary exit releases leaver')
    process.env.SVARA_TEST_ENABLED = '0'
    for (const payload of [create(), command('join_svara_table', 'dealt'), command('leave_svara_table', 'dealt'), command('start_svara_table', 'dealt'), { type: 'request_svara_tables_list' }, { type: 'request_svara_table_state', matchId: 'dealt' }]) {
      lobby.handle('a', payload as any)
      assert.equal(frames.get('a')!.at(-1).code, 'feature_disabled')
    }
  } finally {
    if (previousFlag === undefined) delete process.env.SVARA_TEST_ENABLED
    else process.env.SVARA_TEST_ENABLED = previousFlag
  }
})

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const root = await mkdtemp(join(tmpdir(), 'pika-svara-lobby-'))
const serverDir = join(root, 'server')
await mkdir(serverDir, { recursive: true })
for (const folder of ['src', 'dist', 'database/migrations']) await cp(join(serverRoot, folder), join(serverDir, folder), { recursive: true, preserveTimestamps: true })
await cp(join(serverRoot, 'package.json'), join(serverDir, 'package.json'))
await mkdir(join(serverDir, 'database/data'), { recursive: true })
const linkType = process.platform === 'win32' ? 'junction' : 'dir'
await symlink(join(serverRoot, 'node_modules'), join(serverDir, 'node_modules'), linkType)
await symlink(join(serverRoot, '../node_modules'), join(root, 'node_modules'), linkType)
const dbFile = join(serverDir, 'database/data/belot-v2.sqlite')
function db<T>(fn: (database: DatabaseSync) => T): T {
  const database = new DatabaseSync(dbFile)
  try { return fn(database) } finally { database.close() }
}
const freePort = () => new Promise<number>((done, reject) => {
  const server = createServer()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    assert(address && typeof address !== 'string')
    server.close(() => done(address.port))
  })
})
let child: ChildProcess | null = null
let serverOutput = ''
let port = await freePort()
async function start(flag: string) {
  serverOutput = ''
  child = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/index.ts'], {
    cwd: serverDir, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), SVARA_TEST_ENABLED: flag, PASSWORD_RESET_RATE_LIMIT_SECRET: 'svara-ws-isolated-test-secret-2026-123456', BELOT_GAME_WORKER_COUNT: '1', BELOT_GAME_WORKER_TICK_MODE: 'worker-candidate' },
  })
  child.stdout!.on('data', (chunk) => { serverOutput += chunk.toString() })
  child.stderr!.on('data', (chunk) => { serverOutput += chunk.toString() })
  for (let attempt = 0; attempt < 300; attempt++) {
    if (child.exitCode !== null) throw new Error(`server exited: ${serverOutput}`)
    try {
      const health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json()) as any
      if (health.ok && health.gameWorkerPool?.state === 'ready') return
    } catch { /* wait for isolated server */ }
    await sleep(100)
  }
  throw new Error(`server startup timeout: ${serverOutput}`)
}
async function stop() {
  if (!child || child.exitCode !== null) return
  const running = child
  const exited = new Promise<void>((done) => running.once('exit', () => done()))
  running.kill('SIGTERM')
  const timer = setTimeout(() => running.kill('SIGKILL'), 5000)
  await exited; clearTimeout(timer)
}
const PASSWORD = 'SvaraLobbyCheck1!'
async function http(path: string, payload?: unknown, cookie?: string) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: payload === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  })
  return { status: res.status, body: await res.json() as any, cookie: res.headers.getSetCookie()[0]?.split(';')[0] }
}
type Client = { profileId: string; cookie: string; ws: WebSocket; frames: any[]; received: any[]; email?: string }
const clients: Client[] = []
async function connect(cookie = '', profileId = ''): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: cookie } })
  const client = { profileId, cookie, ws, frames: [] as any[], received: [] as any[] }
  ws.on('message', (raw) => {
    const message = JSON.parse(raw.toString())
    client.frames.push(message); client.received.push(message)
  })
  await new Promise<void>((done, reject) => { ws.once('open', done); ws.once('error', reject) })
  clients.push(client)
  await frame(client, (f) => f.type === 'connected')
  return client
}
async function user(role = 'admin'): Promise<Client> {
  // More than ten fixtures share localhost. Reset only this disposable DB's
  // registration anti-spam bucket; each registration still supplies a valid visitorId.
  db((database) => database.exec('DELETE FROM registration_rate_limit_events'))
  const email = `svaraws-${randomUUID()}@example.test`
  const result = await http('/api/auth/register', { email, displayName: `SW${randomUUID().slice(0, 8)}`, password: PASSWORD, gender: 'male', visitorId: randomUUID() })
  assert.equal(result.status, 200, JSON.stringify(result.body))
  const profileId = result.body.session.profile.profileId
  db((database) => database.prepare('UPDATE accounts SET role = ? WHERE email = ?').run(role, email))
  const client = await connect(result.cookie!, profileId)
  client.email = email
  return client
}
function send(client: Client, payload: unknown) { client.ws.send(JSON.stringify(payload)) }
async function frame(client: Client, predicate: (value: any) => boolean) {
  for (let attempt = 0; attempt < 250; attempt++) {
    const index = client.frames.findIndex(predicate)
    if (index !== -1) return client.frames.splice(index, 1)[0]
    await sleep(20)
  }
  throw new Error(`frame timeout: ${JSON.stringify(client.frames).slice(-1500)}`)
}
async function ask(client: Client, payload: any, type: string) {
  send(client, payload)
  return frame(client, (f) => f.type === type && (!payload.requestId || f.requestId === payload.requestId))
}
async function denied(client: Client, payload: any, code: string) {
  const result = await ask(client, payload, 'svara_lobby_error')
  assert.equal(result.code, code)
  checkPrivacy(result, true)
}
async function createTable(client: Client, capacity = 2, mode = 'manual', extra = {}): Promise<string> {
  const result = await ask(client, create(capacity, mode, extra), 'svara_table_updated')
  return result.table.matchId
}
async function joinTable(client: Client, matchId: string) { return ask(client, command('join_svara_table', matchId), 'svara_table_updated') }
async function leave(client: Client, matchId: string) { return ask(client, command('leave_svara_table', matchId), 'svara_table_left') }
async function snapshot(client: Client, matchId: string) {
  send(client, { type: 'ping' })
  await frame(client, (f) => f.type === 'pong')
  client.frames = client.frames.filter((f) => f.type !== 'svara_match_snapshot')
  send(client, { type: 'request_svara_table_state', matchId })
  return frame(client, (f) => f.type === 'svara_match_snapshot' && f.matchId === matchId)
}
async function tables(client: Client) {
  send(client, { type: 'ping' })
  await frame(client, (f) => f.type === 'pong')
  client.frames = client.frames.filter((f) => f.type !== 'svara_tables_list')
  return (await ask(client, { type: 'request_svara_tables_list' }, 'svara_tables_list')).tables as any[]
}

try {
  await start('1')
  db((database) => database.prepare("UPDATE admin_settings SET setting_value = 'direct' WHERE setting_key = 'registration_verification_mode'").run())
  const a = await user(), b = await user(), c = await user(), d = await user(), observer = await user()
  const walletBalances = () => db((database) => database.prepare('SELECT profile_id, yellow_coins_balance FROM profile_wallets WHERE profile_id IN (?, ?, ?, ?) ORDER BY profile_id').all(a.profileId, b.profileId, c.profileId, d.profileId))
  const originalBalances = walletBalances()
  await check('WS: all five allowed roles create; normal/VIP/chat_admin/anonymous/forged cookies denied', async () => {
    for (const role of SVARA_ALLOWED_ROLES) {
      const allowed = await user(role)
      const id = await createTable(allowed)
      assert.equal((await snapshot(allowed, id)).table.creatorId, allowed.profileId)
      await leave(allowed, id)
    }
    for (const role of ['player', 'chat_admin']) {
      const forbidden = await user(role)
      for (const payload of [{ type: 'request_svara_tables_list' }, create(2, 'auto', { role: 'admin', profileId: a.profileId })]) await denied(forbidden, payload, 'forbidden_role')
    }
    const vip = await user('player')
    db((database) => database.prepare("INSERT INTO vip_status (profile_id, active_until) VALUES (?, datetime('now', '+1 year')) ON CONFLICT(profile_id) DO UPDATE SET active_until = excluded.active_until").run(vip.profileId))
    await denied(vip, create(), 'forbidden_role')
    for (const cookie of ['', 'belot_session=forged']) await denied(await connect(cookie), create(), 'unauthenticated')
  })
  await check('WS: settings, trusted creator, private snapshots and live public-list updates', async () => {
    await tables(observer)
    observer.frames = []
    const id = await createTable(a, 3, 'manual', { playerId: b.profileId, profileId: b.profileId, creatorId: b.profileId })
    const update = await frame(observer, (f) => f.type === 'svara_tables_list' && f.tables.some((t: any) => t.matchId === id))
    const table = update.tables.find((t: any) => t.matchId === id)
    assert.equal(table.creatorId, a.profileId); assert.equal(table.startingChips, 500); assert.equal(table.entryChips, 10)
    checkPrivacy(update, true)
    const own = await snapshot(a, id)
    assert.equal(own.you.playerId, a.profileId); assert.equal(own.you.cards, null)
    checkPrivacy(own)
    await denied(b, { type: 'request_svara_table_state', matchId: id, playerId: a.profileId }, 'not_a_participant')
    await denied(b, command('start_svara_table', id, { playerId: a.profileId }), 'not_a_participant')
    await denied(b, command('leave_svara_table', id, { playerId: a.profileId }), 'not_a_participant')
    await joinTable(b, id)
    await frame(observer, (f) => f.type === 'svara_tables_list' && f.tables.some((t: any) => t.matchId === id && t.players.length === 2))
    await denied(b, command('join_svara_table', id), 'already_seated')
    await denied(a, create(), 'svara_commitment')
    await leave(a, id)
    await frame(b, (f) => f.type === 'svara_table_left' && f.matchId === id)
    assert(!(await tables(observer)).some((t) => t.matchId === id), 'creator departure closes table')
    const next = await createTable(b)
    await leave(b, next)
  })
  await check('WS: capacities 2–4, full table, manual owner-only start and leave/refill rules', async () => {
    for (const capacity of [2, 3, 4]) {
      const players = [a, b, c, d].slice(0, capacity)
      const id = await createTable(a, capacity)
      await denied(a, command('start_svara_table', id), 'not_allowed')
      for (const player of players.slice(1)) await joinTable(player, id)
      await denied(observer, command('join_svara_table', id), 'table_full')
      await denied(b, command('start_svara_table', id), 'not_allowed')
      await leave(b, id)
      await denied(a, command('start_svara_table', id), 'not_allowed')
      await joinTable(b, id)
      await ask(a, command('start_svara_table', id), 'svara_table_updated')
      const state = await snapshot(a, id)
      assert.equal(state.phase, 'in-progress'); assert.equal(state.round.kind, 'ordinary')
      assert(players.some((player) => player.profileId === state.dealerId), 'first deal exposes its authoritative dealer')
      assert.equal(state.totalChips, capacity * 500)
      assert(state.seats.every((p: any) => p.stack === 490 && p.cardCount === 3))
      for (const player of players.slice(1)) {
        await leave(player, id)
        await denied(player, { type: 'request_svara_table_state', matchId: id }, 'not_a_participant')
      }
      // 2Б.3.7.1: a е единствен останал → избор „Покажи“/„Скрий“ преди края; скрива, за да завърши мачът.
      const pending = await snapshot(a, id)
      await ask(a, { type: 'submit_svara_command', matchId: id, commandId: requestId(), expectedRevision: pending.revision, command: { type: 'hide-cards' } }, 'svara_command_result')
      assert(!(await tables(observer)).some((t) => t.matchId === id), 'finished match removed from list')
    }
  })
  await check('WS: automatic start only when full; concurrent final-seat requests have exactly one winner', async () => {
    const id = await createTable(a, 3, 'auto')
    await joinTable(b, id)
    assert.equal((await snapshot(a, id)).phase, 'lobby')
    await denied(a, command('start_svara_table', id), 'not_allowed')
    const requests = [command('join_svara_table', id), command('join_svara_table', id)]
    send(c, requests[0]); send(d, requests[1])
    const results = await Promise.all([c, d].map((client, index) => frame(client, (f) => f.requestId === requests[index]!.requestId)))
    assert.equal(results.filter((f) => f.type === 'svara_table_updated').length, 1)
    assert.equal(results.filter((f) => f.type === 'svara_lobby_error' && f.code === 'wrong_phase').length, 1)
    const state = await snapshot(a, id)
    assert.equal(state.phase, 'in-progress'); assert.equal(state.seats.length, 3)
    assert.equal(new Set(state.seats.map((p: any) => p.playerId)).size, 3)
    const winner = results[0].type === 'svara_table_updated' ? c : d
    await leave(winner, id); await leave(b, id)
    // 2Б.3.7.1: a е единствен останал → избор; скрива, за да освободи обвързването му за следващите тестове.
    const pending = await snapshot(a, id)
    await ask(a, { type: 'submit_svara_command', matchId: id, commandId: requestId(), expectedRevision: pending.revision, command: { type: 'hide-cards' } }, 'svara_command_result')
  })
  await check('WS: disconnect retains membership; second authenticated session cannot claim another seat', async () => {
    const other = await user()
    const id = await createTable(other)
    const reconnected = await connect(other.cookie, other.profileId)
    other.ws.close()
    await denied(reconnected, create(), 'svara_commitment')
    await denied(reconnected, command('join_svara_table', id), 'already_seated')
    assert.equal((await snapshot(reconnected, id)).you.playerId, other.profileId)
    await leave(reconnected, id)
    const activeHost = await user(), activeGuest = await user()
    const activeId = await createTable(activeHost, 2, 'auto')
    await joinTable(activeGuest, activeId)
    activeHost.ws.close()
    await denied(activeGuest, command('join_svara_table', activeId), 'already_seated')
    assert((await tables(observer)).some((t) => t.matchId === activeId && t.phase === 'in-progress' && t.players.length === 2))
    await leave(activeGuest, activeId)
  })
  await check('WS 2Б.3.4: authenticated look/blind bet, stale/conflicting/duplicate moves and reconnect', async () => {
    const host = await user(), guest = await user(), stranger = await user()
    const matchId = await createTable(host, 2, 'auto')
    await joinTable(guest, matchId)
    const initial = await snapshot(host, matchId)
    assert.equal(initial.round.kind, 'ordinary', 'first deal is a trusted automatic transition')
    assert.equal(initial.you.cards, null)
    assert.equal((await snapshot(guest, matchId)).you.cards, null)
    const active = initial.toActId === host.profileId ? host : guest
    const passive = active === host ? guest : host
    // 2Б.3.7.4А: "Погледни" е позволено само на действителния ход — чужд (не на ход)
    // играч трябва да получи отказ и да не промени revision/картите/дедлайна.
    const beforeForeignLook = await snapshot(active, matchId)
    const foreignLookId = requestId()
    send(passive, { type: 'submit_svara_command', matchId, commandId: foreignLookId, expectedRevision: initial.revision, command: { type: 'look' } })
    assert.equal((await frame(passive, (f) => f.type === 'svara_command_error' && f.commandId === foreignLookId)).code, 'not_your_turn')
    assert.deepEqual(await snapshot(active, matchId), beforeForeignLook, 'a rejected off-turn look leaves revision/state unchanged')
    const move = { type: 'submit_svara_command', matchId, commandId: requestId(), expectedRevision: initial.revision,
      command: { type: 'act', action: { kind: 'blind-bet', total: initial.table.entryChips * 2 }, playerId: passive.profileId }, playerId: passive.profileId }
    send(active, move)
    const applied = await frame(active, (f) => f.type === 'svara_command_result' && f.commandId === move.commandId)
    assert.equal(applied.status, 'applied')
    const committed = await snapshot(passive, matchId)
    const committedTiming = passive.received.findLast((f) => f.type === 'svara_match_timing' && f.revision === committed.revision && f.deadlines.some((d: any) => d.kind === 'turn'))
    assert(committedTiming, 'server sends authoritative timing after the individual snapshot')
    assert.equal(committed.toActId, passive.profileId)
    send(active, { ...move, commandId: requestId() })
    assert.equal((await frame(active, (f) => f.type === 'svara_command_error')).code, 'stale_action')
    send(active, { ...move, command: { type: 'act', action: { kind: 'blind-bet', total: initial.table.entryChips * 4 } } })
    assert.equal((await frame(active, (f) => f.type === 'svara_command_error')).code, 'command_id_conflict')
    active.ws.close()
    const reconnected = await connect(active.cookie, active.profileId)
    const automaticSnapshot = await frame(reconnected, (f) => f.type === 'svara_match_snapshot' && f.matchId === matchId)
    assert.equal(automaticSnapshot.you.playerId, active.profileId)
    const automaticTiming = await frame(reconnected, (f) => f.type === 'svara_match_timing' && f.matchId === matchId)
    assert.equal(automaticTiming.deadlines.find((d: any) => d.kind === 'turn').deadlineAt, committedTiming.deadlines.find((d: any) => d.kind === 'turn').deadlineAt, 'reconnect never resets the turn')
    send(reconnected, move)
    assert.equal((await frame(reconnected, (f) => f.type === 'svara_command_result' && f.commandId === move.commandId)).status, 'duplicate')
    assert.deepEqual(await snapshot(passive, matchId), committed)
    const lookId = requestId()
    send(passive, { type: 'submit_svara_command', matchId, commandId: lookId, expectedRevision: committed.revision, command: { type: 'look', playerId: active.profileId }, profileId: active.profileId })
    assert.equal((await frame(passive, (f) => f.type === 'svara_command_result' && f.commandId === lookId)).status, 'applied')
    const own = await snapshot(passive, matchId), hidden = await snapshot(reconnected, matchId)
    assert.equal(own.you.cards.length, 3); assert.equal(hidden.you.cards, null)
    checkPrivacy(own); checkPrivacy(hidden)
    for (const card of own.you.cards) assert(!JSON.stringify(hidden).includes(`"${card}"`))
    for (const [client, command, code] of [
      [stranger, { type: 'look', playerId: passive.profileId }, 'not_a_participant'],
      [passive, { type: 'start-next-round' }, 'invalid_input'],
      [passive, { type: 'act', action: { kind: 'bet', total: -1 } }, 'invalid_input'],
    ] as const) {
      send(client, { type: 'submit_svara_command', matchId, commandId: requestId(), expectedRevision: own.revision, command })
      assert.equal((await frame(client, (f) => f.type === 'svara_command_error')).code, code)
    }
    // No wallet mutation; disconnect retains commitment and reverse guards.
    send(reconnected, { type: 'join_matchmaking', stake: 5000 })
    assert.equal((await frame(reconnected, (f) => f.type === 'error')).code, 'svara_commitment_active')
    db((database) => database.prepare("UPDATE accounts SET role = 'player' WHERE email = ?").run(passive.email!))
    send(passive, { type: 'submit_svara_command', matchId, commandId: requestId(), expectedRevision: own.revision, command: { type: 'look' } })
    assert.equal((await frame(passive, (f) => f.type === 'svara_command_error')).code, 'forbidden_role')
    db((database) => database.prepare("UPDATE accounts SET role = 'admin' WHERE email = ?").run(passive.email!))
    await http('/api/auth/logout', {}, stranger.cookie)
    if (stranger.ws.readyState === WebSocket.OPEN) {
      send(stranger, { type: 'submit_svara_command', matchId, commandId: requestId(), expectedRevision: own.revision, command: { type: 'look' } })
      assert.equal((await frame(stranger, (f) => f.type === 'svara_command_error')).code, 'unauthenticated')
    }
    assert.deepEqual(await snapshot(passive, matchId), own, 'rejected commands preserve game revision/state')
    await leave(passive, matchId)
    // 2Б.3.7.1: active (reconnected) е единствен останал → избор; скрива, за да завърши мачът.
    const pendingChoice = await snapshot(reconnected, matchId)
    assert.equal(pendingChoice.round.kind, 'reveal-choice')
    await ask(reconnected, { type: 'submit_svara_command', matchId, commandId: requestId(), expectedRevision: pendingChoice.revision, command: { type: 'hide-cards' } }, 'svara_command_result')
    assert.equal((await snapshot(reconnected, matchId)).phase, 'finished')
  })
  await check('WS: actual Belot/Ludo admission guards in both directions, including disconnected Svara member', async () => {
    assert.deepEqual(walletBalances(), originalBalances, 'Svara lobby/start/exit must not change wallets')
    const id = await createTable(a)
    for (const payload of [
      { type: 'join_matchmaking', stake: 5000 }, { type: 'create_room' }, { type: 'join_room', roomId: 'missing' },
      { type: 'create_ludo_room', stake: 5000, playerCount: 2, manualStart: true }, { type: 'join_ludo_room', ludoRoomId: 'missing' },
      { type: 'create_private_room', stake: 5000, waitMinutes: 5 },
      { type: 'join_private_room', privateRoomId: 'missing', team: 'A', slotIndex: 0 },
    ]) {
      send(a, payload)
      const result = await frame(a, (f) => f.type === 'error')
      assert.equal(result.code, 'svara_commitment_active', JSON.stringify(result))
    }
    await leave(a, id)
    send(a, { type: 'create_ludo_room', stake: 5000, playerCount: 2, manualStart: true })
    const ludo = await frame(a, (f) => f.type === 'ludo_room_updated')
    await denied(a, create(), 'other_game_commitment')
    const target = await createTable(b)
    await denied(a, command('join_svara_table', target), 'other_game_commitment')
    // Existing Ludo -> Belot waiting-room guard remains intact.
    send(a, { type: 'create_private_room', stake: 5000, waitMinutes: 5 })
    const blocked = await frame(a, (f) => f.type === 'cross_game_commitment_blocked')
    assert.equal(blocked.location.gameType, 'ludo'); assert.equal(blocked.location.ludoRoomId, ludo.room.id)
    send(a, { type: 'leave_ludo_room' }); await frame(a, (f) => f.type === 'ludo_room_left')
    send(a, { type: 'create_private_room', stake: 5000, waitMinutes: 5 })
    await frame(a, (f) => f.type === 'private_room_updated')
    await denied(a, create(), 'other_game_commitment')
    send(a, { type: 'leave_private_room' }); await frame(a, (f) => f.type === 'private_room_left')
    send(a, { type: 'join_matchmaking', stake: 5000 })
    await frame(a, (f) => f.type === 'matchmaking_joined')
    await denied(a, command('join_svara_table', target), 'other_game_commitment')
    send(a, { type: 'leave_matchmaking' }); await frame(a, (f) => f.type === 'matchmaking_left')
    await joinTable(a, target); await leave(a, target); await leave(b, target)
  })
  await check('WS: live role demotion/revoked session and malformed inputs do not mutate tables', async () => {
    const id = await createTable(a)
    const downgraded = await user()
    await tables(downgraded)
    db((database) => database.prepare("UPDATE accounts SET role = 'player' WHERE email = ?").run(downgraded.email!))
    await denied(downgraded, command('join_svara_table', id), 'forbidden_role')
    downgraded.frames = []
    await joinTable(b, id)
    await sleep(50)
    assert(!downgraded.frames.some((f) => f.type.startsWith('svara_')), 'demoted subscriber gets no list/snapshot pushes')
    await denied(c, command('leave_svara_table', id), 'not_a_participant')
    await denied(c, command('start_svara_table', 'missing'), 'match_not_found')
    for (const payload of [create(5), create(2, 'manual', { requestId: 'x'.repeat(65) }), command('join_svara_table', '')]) {
      send(c, payload)
      assert.equal((await frame(c, (f) => f.type === 'svara_lobby_error')).code, 'invalid_input')
    }
    send(c, { type: 'svara_system_command', matchId: id, command: { type: 'start-next-round' } })
    await frame(c, (f) => f.type === 'error')
    assert.equal((await snapshot(a, id)).phase, 'lobby')
    const revoked = await user()
    await http('/api/auth/logout', {}, revoked.cookie)
    if (revoked.ws.readyState === WebSocket.OPEN) await denied(revoked, create(), 'unauthenticated')
    await leave(a, id)
  })
  await check('WS: active Belot and active Ludo also block Svara admission', async () => {
    const belot = await user(), ludoHost = await user(), ludoGuest = await user()
    send(belot, { type: 'create_room' })
    await frame(belot, (f) => f.type === 'room_created')
    await denied(belot, create(), 'other_game_commitment')
    send(ludoHost, { type: 'create_ludo_room', stake: 5000, playerCount: 2, manualStart: false })
    const room = await frame(ludoHost, (f) => f.type === 'ludo_room_updated')
    send(ludoGuest, { type: 'join_ludo_room', ludoRoomId: room.room.id })
    const match = await frame(ludoHost, (f) => f.type === 'ludo_game_started')
    await frame(ludoGuest, (f) => f.type === 'ludo_game_started')
    await denied(ludoHost, create(), 'other_game_commitment')
    await denied(ludoGuest, create(), 'other_game_commitment')
    send(ludoGuest, { type: 'leave_ludo_match', matchId: match.snapshot.matchId })
    await frame(ludoGuest, (f) => f.type === 'ludo_match_left')
  })
  await check('HTTP tournament admissions cannot bypass an existing Svara commitment', async () => {
    const id = await createTable(a)
    for (const [path, payload] of [
      ['/api/tournaments/missing/join', {}],
      ['/api/tournaments/missing/partner-invites', { inviteeProfileId: b.profileId }],
      ['/api/tournaments/missing/partner-invites/missing/accept', {}],
    ] as const) {
      const response = await http(path, payload, a.cookie)
      assert.equal(response.status, 409, JSON.stringify(response.body))
      assert.equal(response.body.code, 'svara_commitment_active')
    }
    await leave(a, id)
  })
  // Every captured public frame is checked, not just a representative list.
  await check('WS: all delivered Svara lists/updates/snapshots/errors contain only permitted data', () => {
    for (const client of clients) for (const payload of client.received) {
      if (payload.type.startsWith('svara_')) checkPrivacy(payload, payload.type !== 'svara_match_snapshot')
    }
  })
  const cookie = a.cookie, profileId = a.profileId
  for (const client of clients) client.ws.terminate()
  await stop()
  port = await freePort()
  await start('0')
  await check('WS: feature flag OFF denies all lobby and gameplay operations to an allowed authenticated role', async () => {
    const off = await connect(cookie, profileId)
    for (const payload of [{ type: 'request_svara_tables_list' }, create(), command('join_svara_table', 'any'), command('leave_svara_table', 'any'), command('start_svara_table', 'any'), { type: 'request_svara_table_state', matchId: 'any' }]) await denied(off, payload, 'feature_disabled')
    send(off, { type: 'submit_svara_command', matchId: 'any', commandId: requestId(), expectedRevision: 0, command: { type: 'look' } })
    assert.equal((await frame(off, (f) => f.type === 'svara_command_error')).code, 'feature_disabled')
  })
} catch (error) {
  failed++; console.error('FAIL isolated WS setup/run:', error)
} finally {
  for (const client of clients) client.ws.terminate()
  await stop()
  if (failed) console.error(serverOutput.slice(-3000))
  // root was created above with mkdtemp; rm never follows the dependency junctions.
  assert.equal(dirname(resolve(root)), resolve(tmpdir()))
  await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
}
console.log(`\nPassed: ${passed}  Failed: ${failed}`)
if (failed) process.exitCode = 1
