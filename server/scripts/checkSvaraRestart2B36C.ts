/** Real backend processes, HTTP auth, WS and SQLite. Every path/process is owned by this harness. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import WebSocket from 'ws'
import { buildSvaraDeckForHands, assertSvaraMatchInvariants } from '../src/games/svara/engine/svaraMatch.js'
import { SVARA_ORDERED_DECK, svaraCardCode } from '../src/games/svara/engine/svaraCards.js'
import { SVARA_SNAPSHOT_FORBIDDEN_KEYS } from '../src/games/svara/protocol/svaraSnapshotProtocol.js'
import type { SvaraStoredMatch } from '../src/games/svara/runtime/svaraPersistence.js'
import { svaraDealingAnimationMs } from '../src/games/svara/runtime/createSvaraLifecycle.js'

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const root = await mkdtemp(join(tmpdir(), 'pika-svara-restart-')), serverDir = join(root, 'server')
const dbFile = join(serverDir, 'database/data/belot-v2.sqlite'), hooksFile = join(root, 'hooks.mjs'), runner = join(root, 'runner.mjs')
const PASSWORD = 'IsolatedSvaraRestart1!', BASE = 1_900_000_000_000
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function same(actual: unknown, expected: unknown, label: string) { assert.equal(digest(actual), digest(expected), label) }
function owned(path: string) {
  const rel = relative(root, resolve(path))
  assert(rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !resolve(path).startsWith(`${serverRoot}${sep}`), 'Path is not owned by restart harness')
  return path
}
let passed = 0, failed = 0, starts = 0, gracefulStops = 0, crashes = 0, currentCase = '', now = BASE
type User = { profileId: string; cookie: string; email: string }
type Client = { user: User; ws: WebSocket; frames: any[]; received: any[]; protocolFailure?: string }
type Running = { child: ChildProcess; nonce: string; pid: number; events: any[]; output: string; recovery?: string; exited: Promise<void>; exitCode?: number | null; signal?: string | null; identity: boolean }
let running: Running | null = null
const currentRunning = (): Running | null => running
const clients: Client[] = [], users: User[] = []
const port = await new Promise<number>((done, reject) => {
  const listener = createServer(); listener.once('error', reject)
  listener.listen(0, '127.0.0.1', () => { const addr = listener.address(); assert(addr && typeof addr !== 'string'); listener.close(() => done(addr.port)) })
})
const url = `http://127.0.0.1:${port}`
const links = [join(serverDir, 'node_modules'), join(root, 'node_modules')]
const productionHashes = new Map<string, string>()
async function waitFor<T>(read: () => T | undefined | false, label: string, timeout = 15000): Promise<T> {
  const end = Date.now() + timeout
  while (Date.now() < end) { const result = read(); if (result !== undefined && result !== false) return result as T; await pause(20) }
  throw new Error(`Timed out: ${label}`)
}
function db<T>(read: (database: DatabaseSync) => T): T {
  owned(dbFile); const database = new DatabaseSync(dbFile, { enableForeignKeyConstraints: true })
  try { return read(database) } finally { database.close() }
}
function saved(matchId: string): SvaraStoredMatch {
  return db((database) => {
    const row = database.prepare('SELECT snapshot_json FROM svara_match_snapshots WHERE match_id = ?').get(matchId) as { snapshot_json: string } | undefined
    assert(row, 'Expected durable match row'); const value = JSON.parse(row.snapshot_json) as SvaraStoredMatch
    assertSvaraMatchInvariants(value.state); return value
  })
}
function invariant(snapshot: SvaraStoredMatch) {
  assertSvaraMatchInvariants(snapshot.state)
  assert.equal(snapshot.revision, Object.keys(snapshot.state.processedCommands).length)
}
function privacy(value: unknown, publicOnly = false) {
  if (!value || typeof value !== 'object') return
  for (const [key, nested] of Object.entries(value)) {
    assert(!SVARA_SNAPSHOT_FORBIDDEN_KEYS.includes(key), `Unexpected internal protocol key: ${key}`)
    if (publicOnly) assert(!['cards', 'you', 'betting', 'looked', 'history', 'round'].includes(key), 'Private data in table list')
    privacy(nested, publicOnly)
  }
}
async function prepare() {
  await mkdir(serverDir, { recursive: true })
  for (const directory of ['src', 'dist', 'database/migrations']) await cp(join(serverRoot, directory), owned(join(serverDir, directory)), { recursive: true, preserveTimestamps: true })
  await copyFile(join(serverRoot, 'package.json'), owned(join(serverDir, 'package.json')))
  await mkdir(join(serverDir, 'database/data'), { recursive: true })
  await symlink(join(serverRoot, 'node_modules'), links[0]!, process.platform === 'win32' ? 'junction' : 'dir')
  await symlink(join(serverRoot, '../node_modules'), links[1]!, process.platform === 'win32' ? 'junction' : 'dir')
  await copyFile(join(serverRoot, 'scripts/fixtures/svaraRestartHooks.mjs'), hooksFile)
  for (const [file, exported] of [['games/svara/createPersistentSvaraLobby.js', 'createPersistentSvaraLobby'], ['games/svara/runtime/svaraMatchRuntime.js', 'createSvaraMatchRuntime']]) {
    const original = join(serverRoot, 'dist', file!)
    productionHashes.set(original, createHash('sha256').update(await readFile(original)).digest('hex'))
    const target = owned(join(serverDir, 'dist', file!)), actual = target.replace(/\.js$/, '.actual.js')
    await copyFile(target, actual)
    const sibling = `./${file!.split('/').at(-1)!.replace(/\.js$/, '.actual.js')}`
    await writeFile(target, exported === 'createPersistentSvaraLobby'
      ? `import { ${exported} as actual } from ${JSON.stringify(sibling)};\nimport { clock, decorateService } from ${JSON.stringify(pathToFileURL(hooksFile).href)};\nexport async function ${exported}(deps) { return decorateService(await actual({ ...deps, clock })); }\n`
      : `export * from ${JSON.stringify(sibling)};\nimport { ${exported} as actual } from ${JSON.stringify(sibling)};\nimport { random } from ${JSON.stringify(pathToFileURL(hooksFile).href)};\nexport function ${exported}(options = {}) { return actual({ ...options, random }); }\n`)
  }
  await writeFile(runner, `import { configure } from './hooks.mjs';\nconfigure(JSON.parse(process.argv[2]));\nawait import('./server/dist/index.js');\n`)
}
function identity(value: Running, handshake = true) {
  assert((!handshake || value.identity) && value.child === running?.child && value.pid === value.child.pid && value.child.spawnfile === process.execPath && value.child.spawnargs[1] === runner &&
    JSON.parse(value.child.spawnargs[2]!).nonce === value.nonce, 'Refusing to stop an unverified process')
}
async function ipc(command: string, fields: Record<string, unknown> = {}) {
  const value = running!; identity(value); const id = randomUUID()
  value.child.send!({ nonce: value.nonce, id, command, ...fields })
  const response = await waitFor(() => value.events.find((e) => e.reply === id), `IPC ${command}`, 10000)
  assert(!response.error, 'Private harness command failed'); return response.result
}
async function start(time = now, flag = '1', decks: string[][] = []) {
  assert.equal(running, null); now = time
  const env: Record<string, string> = {}
  for (const key of ['SystemRoot', 'SystemDrive', 'ComSpec', 'PATH', 'Path', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) if (process.env[key]) env[key] = process.env[key]!
  Object.assign(env, { NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(port), SVARA_TEST_ENABLED: flag,
    PASSWORD_RESET_RATE_LIMIT_SECRET: 'isolated-svara-restart-secret-2026-123456', BELOT_GAME_WORKER_COUNT: '1', BELOT_GAME_WORKER_TICK_MODE: 'worker-candidate' })
  const nonce = randomUUID(), child = spawn(process.execPath, [runner, JSON.stringify({ nonce, parentPid: process.pid, now, decks })],
    { cwd: serverDir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  const value: Running = { child, nonce, pid: child.pid!, events: [], output: '', identity: false, exited: Promise.resolve() }
  value.exited = new Promise<void>((done) => child.once('exit', (code, signal) => { value.exitCode = code; value.signal = signal; done() }))
  child.stdout!.on('data', (chunk) => { value.output += chunk.toString() })
  child.stderr!.on('data', (chunk) => { value.output += chunk.toString() })
  child.on('message', (message: any) => {
    assert(message.nonce === nonce && message.pid === child.pid, 'Unexpected child identity')
    value.events.push(message)
    if (message.event === 'identity') { assert.equal(message.parentPid, process.pid); value.identity = true }
    if (message.event === 'recovery') value.recovery = message.status
  })
  running = value; starts++
  await waitFor(() => value.identity, 'child identity')
  const end = Date.now() + 40000
  while (Date.now() < end) {
    if (value.exitCode !== undefined) throw new Error('Isolated backend exited during startup (see sanitized diagnostic)')
    try {
      const health = await fetch(`${url}/health`).then((r) => r.json()) as any
      if (health.ok && health.gameWorkerPool?.state === 'ready' && value.recovery) return value
    } catch { /* this owned port is not listening yet */ }
    await pause(100)
  }
  throw new Error('Isolated backend startup timed out (see sanitized diagnostic)')
}
async function portFree() {
  await new Promise<void>((done, reject) => { const listener = createServer(); listener.once('error', reject); listener.listen(port, '127.0.0.1', () => listener.close(() => done())) })
}
async function stop(mode: 'graceful' | 'crash' = 'graceful') {
  if (!running) return
  const value = running; identity(value)
  if (value.exitCode === undefined) {
    if (mode === 'graceful') {
      for (const client of clients) if (client.ws.readyState === WebSocket.OPEN) client.ws.close()
      await ipc('shutdown'); gracefulStops++
    } else { assert(value.child.kill('SIGKILL'), 'Could not terminate owned backend'); crashes++ }
    await new Promise<void>((done, reject) => {
      const timeout = setTimeout(() => reject(new Error('Owned backend did not exit')), 15000)
      value.exited.then(() => { clearTimeout(timeout); done() })
    })
  }
  if (mode === 'graceful') {
    assert.equal(value.exitCode, 0, 'Graceful backend exit failed')
    assert(value.output.includes('[shutdown] signal=SIGTERM'), 'Did not exercise real graceful shutdown handler')
    assert(value.events.some((e) => e.event === 'lifecycle-stopped' && e.pending === 0), 'Svara timer handles leaked at shutdown')
  }
  for (const client of clients.splice(0)) client.ws.terminate()
  running = null; await portFree(); return value
}
async function advance(delta: number) { const result = await ipc('clock', { delta }); now = result.now; return result }
async function backup(name: string) {
  assert.equal(running, null)
  // Fixture copies contain the committed WAL too. Never copy just the main
  // file before SQLite has checkpointed the stopped, exclusively owned DB.
  db((database) => assert.equal((database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as any).busy, 0))
  const path = owned(join(root, `${name}.sqlite`)); await copyFile(dbFile, path); return path
}
async function restore(path: string) {
  assert.equal(running, null); owned(path)
  for (const suffix of ['-wal', '-shm']) await rm(owned(`${dbFile}${suffix}`), { force: true })
  await copyFile(path, owned(dbFile))
}
async function http(path: string, payload?: unknown, cookie?: string) {
  const response = await fetch(`${url}${path}`, { method: payload === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: payload === undefined ? undefined : JSON.stringify(payload) })
  return { status: response.status, body: await response.json() as any, cookie: response.headers.getSetCookie()[0]?.split(';')[0] }
}
async function connect(user: User, cookie = user.cookie): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: cookie } })
  const client: Client = { user, ws, frames: [], received: [] }
  ws.on('message', (raw) => {
    try { const frame = JSON.parse(raw.toString()); if (frame.type.startsWith('svara_')) privacy(frame); client.frames.push(frame); client.received.push(frame) }
    catch { client.protocolFailure = 'Invalid or private WebSocket payload' }
  })
  ws.on('error', () => {})
  clients.push(client)
  await new Promise<void>((done, reject) => { ws.once('open', done); ws.once('error', reject) })
  await frame(client, (f) => f.type === 'connected'); return client
}
async function register(): Promise<User> {
  db((database) => database.exec('DELETE FROM registration_rate_limit_events'))
  const email = `restart-${randomUUID()}@example.test`
  const result = await http('/api/auth/register', { email, password: PASSWORD, displayName: `SR${randomUUID().slice(0, 8)}`, gender: 'male', visitorId: randomUUID() })
  assert.equal(result.status, 200, 'Isolated HTTP registration failed'); assert(result.cookie)
  db((database) => database.prepare("UPDATE accounts SET role = 'admin' WHERE email = ?").run(email))
  const user = { email, cookie: result.cookie, profileId: result.body.session.profile.profileId }; users.push(user); return user
}
function send(client: Client, message: unknown) { assert.equal(client.ws.readyState, WebSocket.OPEN, 'Test socket is not open'); client.ws.send(JSON.stringify(message)) }
async function frame(client: Client, predicate: (frame: any) => boolean) {
  return waitFor(() => { if (client.protocolFailure) throw new Error(client.protocolFailure); const index = client.frames.findIndex(predicate); return index < 0 ? undefined : client.frames.splice(index, 1)[0] }, 'WebSocket response')
}
async function ask(client: Client, message: any, type: string) {
  send(client, message)
  return waitFor(() => {
    if (client.protocolFailure) throw new Error(client.protocolFailure)
    const index = client.frames.findIndex((f) => (!message.requestId || message.requestId === f.requestId) && (f.type === type || ['svara_lobby_error', 'error'].includes(f.type)))
    if (index < 0) return undefined
    const response = client.frames.splice(index, 1)[0]
    if (response.type !== type) throw new Error(`Unexpected ${response.type}/${response.code} for ${message.type}`)
    return response
  }, `${message.type} -> ${type}`)
}
async function fence(client: Client) { send(client, { type: 'ping' }); await frame(client, (f) => f.type === 'pong') }
async function snapshot(client: Client, matchId: string) {
  await fence(client); client.frames = client.frames.filter((f) => f.type !== 'svara_match_snapshot' && f.type !== 'svara_match_timing')
  send(client, { type: 'request_svara_table_state', matchId }); const result = await frame(client, (f) => f.type === 'svara_match_snapshot' && f.matchId === matchId)
  const current = saved(matchId)
  if (result.revision === current.revision) {
    const round = current.state.round, own = round && 'hands' in round && result.you.looked ? round.hands[client.user.profileId] ?? null : null
    same(result.you.cards, own, 'Snapshot contains incorrect own/hidden cards')
    if (round && 'hands' in round) for (const [owner, cards] of Object.entries(round.hands)) if (owner !== client.user.profileId) {
      for (const card of cards) assert(!JSON.stringify(result).includes(`"${card}"`), 'Foreign card in individual snapshot')
    }
  }
  return result
}
async function timing(client: Client, matchId: string) { await snapshot(client, matchId); return frame(client, (f) => f.type === 'svara_match_timing' && f.matchId === matchId) }
async function tables(client: Client) {
  await fence(client); client.frames = client.frames.filter((f) => f.type !== 'svara_tables_list')
  const result = await ask(client, { type: 'request_svara_tables_list' }, 'svara_tables_list'); privacy(result, true); return result.tables as any[]
}
// 2Б.3.7.4Б: a fresh deal (ordinary or svara) starts in the server dealing-
// presentation phase; advance the REAL (IPC-driven fake) clock through it —
// the real lifecycle timer path, not an engine shortcut. The real 15s-
// after-the-real-wait behavior and the gate itself have their own tests.
async function finishDealingIfNeeded(matchId: string) {
  const round = saved(matchId).state.round as any
  if (round && (round.kind === 'ordinary' || round.kind === 'svara') && round.dealing) await advance(svaraDealingAnimationMs(round.participants.length))
}
// Exercise every real lifecycle boundary; never jump over a presentation phase.
async function finishShowdownDisplays(matchId: string) {
  for (let i = 0; i < 16; i++) {
    const stored = saved(matchId), round = stored.state.round
    if (round?.kind !== 'showdown-display') return
    const kind = round.phase === 'showdown' ? 'showdown-display' : 'payout-display'
    const deadline = stored.deadlines.find((d) => d.kind === kind)
    assert(deadline, `Missing ${kind} absolute deadline`)
    const duration = round.phase === 'showdown' ? 3000 : Math.max(1, round.payoutSteps.length) * 1200
    assert.equal(deadline.deadlineAt - now, duration)
    await advance(duration - 1)
    same(saved(matchId), stored, `${kind} closed before its absolute deadline`)
    await advance(1)
    assert(saved(matchId).revision > stored.revision, `${kind} did not advance at its deadline`)
  }
  throw new Error('Unbounded showdown/all-in continuation')
}
async function createTable(peers: Client[], entryFee = 5000, start = true): Promise<string> {
  const result = await ask(peers[0]!, { type: 'create_svara_table', requestId: randomUUID(), capacity: peers.length, entryFee, entryPercent: 1, startMode: 'manual' }, 'svara_table_updated')
  const matchId = result.table.matchId
  for (const peer of peers.slice(1)) await ask(peer, { type: 'join_svara_table', requestId: randomUUID(), matchId }, 'svara_table_updated')
  if (start) { await ask(peers[0]!, { type: 'start_svara_table', requestId: randomUUID(), matchId }, 'svara_table_updated'); await finishDealingIfNeeded(matchId) }
  await snapshot(peers[0]!, matchId); return matchId
}
async function play(client: Client, matchId: string, command: any, commandId: string = randomUUID(), expectedRevision = saved(matchId).revision) {
  send(client, { type: 'submit_svara_command', matchId, commandId, expectedRevision, command })
  const result = await frame(client, (f) => ['svara_command_result', 'svara_command_error'].includes(f.type) && f.commandId === commandId)
  if (result.type === 'svara_command_result') {
    await fence(client) // finish synchronous automatic transitions before selecting the next revision
    const committed = saved(matchId); assert(committed.revision >= result.revision, 'ACK before durable state')
    invariant(committed)
  }
  return result
}
async function ok(client: Client, matchId: string, command: any, commandId?: string) {
  await finishDealingIfNeeded(matchId)
  const result = await play(client, matchId, command, commandId); assert.equal(result.type, 'svara_command_result', 'Expected accepted gameplay command'); assert.equal(result.status, 'applied'); return result
}
const act = (client: Client, matchId: string, action: any) => ok(client, matchId, { type: 'act', action })
async function reconnect(peers: User[]) { return Promise.all(peers.map((user) => connect(user))) }
function walletHash() { return db((database) => digest(database.prepare('SELECT profile_id, yellow_coins_balance FROM profile_wallets ORDER BY profile_id').all())) }
function integrity() { db((database) => { assert.equal((database.prepare('PRAGMA integrity_check').get() as any).integrity_check, 'ok'); assert.equal(database.prepare('PRAGMA foreign_key_check').all().length, 0) }) }
async function trap(client: Client, matchId: string, command: any) {
  const commandId = randomUUID(), revision = saved(matchId).revision
  await ipc('arm-ack', { commandId }); send(client, { type: 'submit_svara_command', matchId, commandId, expectedRevision: revision, command })
  const event = await waitFor(() => running!.events.find((e) => e.event === 'ack-blocked' && e.commandId === commandId), 'committed-before-ACK failpoint', 8000)
  assert.equal(event.status, 'applied'); assert.equal(event.revision, revision + 1)
  assert(!client.received.some((f) => f.type === 'svara_command_result' && f.commandId === commandId), 'Lost ACK was delivered')
  return { commandId, revision, event }
}
const deck = (order: string[], hands: Record<string, string>) => buildSvaraDeckForHands(order, hands).map(svaraCardCode)
async function carried(peers: Client[]) {
  const matchId = await createTable(peers), b = peers[1]!
  await ok(b, matchId, { type: 'look' }); await act(b, matchId, { kind: 'bet', total: 150 }); await ok(b, matchId, { type: 'exit' })
  await advance(15000); await fence(peers[0]!)
  // 2Б.3.7.1: the 15s timeout that folds the last bettor can leave the sole
  // remaining active player with a pending reveal choice instead of opening
  // the presence-wait window directly; hide it so the wait actually starts.
  const pendingChoice = saved(matchId).state.round as any
  if (pendingChoice?.kind === 'reveal-choice') {
    const winner = peers.find((p) => p.user.profileId === pendingChoice.winnerId)!
    await ok(winner, matchId, { type: 'hide-cards' })
  }
  const state = saved(matchId)
  assert.equal(state.state.carried[0]?.amount, 150); assert(state.deadlines.some((d) => d.kind === 'presence-wait'))
  return matchId
}
async function check(label: string, run: () => Promise<void>) {
  currentCase = label
  try { await run(); if (baselineWallet && !label.includes('durable Ludo participation')) assert.equal(walletHash(), baselineWallet, 'Svara changed a real wallet in the isolated DB'); passed++; console.log(`  PASS ${label}`) }
  catch (error) { failed++; console.error(`  FAIL ${label}: ${error instanceof Error ? error.message : 'test failure'}`); throw error }
}

let baseline = '', activeFixture = '', activeClock = BASE, baselineWallet = ''
try {
  await prepare()
  await check('isolated real startup, empty recovery, HTTP registrations and private sessions', async () => {
    assert.equal((await start(BASE)).recovery, 'ready')
    db((database) => database.prepare("UPDATE admin_settings SET setting_value = 'direct' WHERE setting_key = 'registration_verification_mode'").run())
    for (let i = 0; i < 8; i++) await register()
    const observer = await connect(users[7]!); assert.equal((await tables(observer)).length, 0)
    baselineWallet = walletHash(); await stop(); baseline = await backup('baseline')
  })
  await check('graceful stop/start preserves the full active deal, seen/hidden cards and remaining deadline', async () => {
    await start(BASE); let peers = await reconnect(users.slice(0, 3)); const matchId = await createTable(peers)
    await ok(peers[1]!, matchId, { type: 'look' }); await act(peers[1]!, matchId, { kind: 'bet', total: 10 }); await advance(3000)
    const before = saved(matchId); await stop(); await start(now + 2000); peers = await reconnect(users.slice(0, 3))
    same(saved(matchId), before, 'Full state changed across graceful restart')
    // peers[1]'s plain bet above closed the blind phase (commit 4c2a280):
    // every active, non-folded participant is auto-revealed, not only the
    // bettor. Expect visibility from the durable `betting.looked` set, not a
    // single hardcoded peer.
    const beforeRound = before.state.round as any
    for (const peer of peers) {
      const own = await snapshot(peer, matchId); assert.equal(own.you.playerId, peer.user.profileId)
      const looked = beforeRound.betting.looked.includes(peer.user.profileId)
      assert.equal(own.you.looked, looked, 'Looked/auto-reveal status did not survive the restart')
      same(own.you.cards, looked ? beforeRound.hands[peer.user.profileId] : null, 'Own card visibility changed')
    }
    const time = await timing(peers[2]!, matchId); assert.equal(time.deadlines[0].deadlineAt, before.deadlines[0]!.deadlineAt); assert.equal(time.deadlines[0].remainingMs, 10000)
    await ok(peers[2]!, matchId, { type: 'look' }); await act(peers[2]!, matchId, { kind: 'call' })
    await ok(peers[0]!, matchId, { type: 'look' }); await act(peers[0]!, matchId, { kind: 'bet', total: 20 })
    const confirmed = saved(matchId); await stop('crash')
    assert((await stat(`${dbFile}-wal`)).size > 0, 'Crash scenario did not leave a real WAL to recover')
    await start(now); peers = await reconnect(users.slice(0, 3)); same(saved(matchId), confirmed, 'Confirmed raise lost after forced crash'); integrity()
    await act(peers[1]!, matchId, { kind: 'call' })
    const beforeLost = saved(matchId), command = { type: 'act', action: { kind: 'bet', total: 30 } }
    const lost = await trap(peers[2]!, matchId, command); await stop('crash'); await start(now); peers = await reconnect(users.slice(0, 3))
    const committed = saved(matchId); assert.equal(committed.revision, beforeLost.revision + 1)
    assert.equal(committed.state.stacks[users[2]!.profileId], beforeLost.state.stacks[users[2]!.profileId]! - 20)
    const repeated = await play(peers[2]!, matchId, command, lost.commandId, lost.revision); assert.equal(repeated.status, 'duplicate')
    assert.equal((await play(peers[2]!, matchId, { type: 'act', action: { kind: 'fold' } }, lost.commandId, lost.revision)).code, 'command_id_conflict')
    same(saved(matchId), committed, 'Lost ACK retry/conflict changed durable state')
    await stop(); activeClock = now; activeFixture = await backup('active-confirmed')
  })
  await check('forced crash exactly during the server dealing-presentation phase restores the original deadline deterministically', async () => {
    await restore(baseline); await start(BASE); let peers = await reconnect(users.slice(0, 3))
    // Deliberately NOT createTable()'s own helper, to crash BEFORE any
    // dealing-phase skip would otherwise advance the clock past it.
    const created = await ask(peers[0]!, { type: 'create_svara_table', requestId: randomUUID(), capacity: peers.length, entryFee: 5000, entryPercent: 1, startMode: 'manual' }, 'svara_table_updated')
    const matchId = created.table.matchId
    for (const peer of peers.slice(1)) await ask(peer, { type: 'join_svara_table', requestId: randomUUID(), matchId }, 'svara_table_updated')
    await ask(peers[0]!, { type: 'start_svara_table', requestId: randomUUID(), matchId }, 'svara_table_updated')
    const before = saved(matchId)
    assert.equal((before.state.round as any).dealing, true); assert.equal(before.deadlines[0]!.kind, 'dealing')
    await stop('crash')
    assert((await stat(`${dbFile}-wal`)).size > 0, 'Crash scenario did not leave a real WAL to recover')
    await start(now); peers = await reconnect(users.slice(0, 3))
    same(saved(matchId), before, 'Mid-dealing state changed after a forced crash')
    assert.equal((await timing(peers[1]!, matchId)).deadlines[0].deadlineAt, before.deadlines[0]!.deadlineAt, 'the original absolute dealing deadline must survive a forced crash')
    await advance(svaraDealingAnimationMs(peers.length))
    const after = saved(matchId)
    assert(after.state.round?.kind === 'ordinary')
    assert.equal(after.state.round.dealing, false); assert.equal(after.revision, before.revision + 1, 'exactly one finish-dealing transition')
    assert.equal(after.state.ledger.filter((e) => e.type === 'entry').length, before.state.ledger.filter((e) => e.type === 'entry').length, 'no repeated entry charge')
    assert.equal(JSON.stringify((after.state.round as any).hands), JSON.stringify((before.state.round as any).hands), 'no re-deal across the crash')
    integrity(); await stop()
  })
  await check('auto-reveal on a plain bet looks only active non-folded participants, including after a restart', async () => {
    await restore(baseline); await start(BASE); let peers = await reconnect(users.slice(0, 3))
    const matchId = await createTable(peers)
    const byId = (id: string) => peers.find((p) => p.user.profileId === id)!
    const order = (saved(matchId).state.round as any).betting.order as string[], [first, second] = order
    await act(byId(first!), matchId, { kind: 'fold' }) // first actor declines before looking or betting
    await ok(byId(second!), matchId, { type: 'look' }); await act(byId(second!), matchId, { kind: 'bet', total: 10 }) // plain bet closes the blind phase for everyone
    const before = saved(matchId), beforeRound = before.state.round as any
    assert(beforeRound.betting.folded.includes(first), 'First actor should have folded')
    assert(!beforeRound.betting.looked.includes(first), 'A folded participant must not be auto-revealed')
    for (const id of order.filter((p: string) => p !== first)) assert(beforeRound.betting.looked.includes(id), `${id} must be auto-revealed once the blind phase closed`)
    await stop(); await start(now + 1000); peers = await reconnect(users.slice(0, 3))
    same(saved(matchId), before, 'Auto-reveal state changed across restart')
    for (const peer of peers) {
      const own = await snapshot(peer, matchId); assert.equal(own.you.playerId, peer.user.profileId)
      const looked = beforeRound.betting.looked.includes(peer.user.profileId)
      assert.equal(own.you.looked, looked, 'Looked/auto-reveal status did not survive the restart')
      same(own.you.cards, looked ? beforeRound.hands[peer.user.profileId] : null, 'Own card visibility changed after restart')
    }
    await stop()
  })
  await check('expired real turn, absent/pending return, actual reconnect security and both cross-game guards', async () => {
    await restore(activeFixture); const matchId = db((database) => (database.prepare("SELECT match_id FROM svara_match_snapshots WHERE match_status = 'in-progress'").get() as any).match_id)
    const before = saved(matchId); await start(before.deadlines[0]!.deadlineAt + 1); let peers = await reconnect(users.slice(0, 3))
    const after = saved(matchId), absentId = before.deadlines[0]!.playerId!
    assert.equal(after.revision, before.revision + 1); assert.equal(after.state.status[absentId], 'absent')
    for (const field of ['config', 'seats', 'stacks', 'lockedPots', 'carried', 'ledger', 'history'] as const) same(after.state[field], before.state[field], `Unexpected timeout mutation: ${field}`)
    same((after.state.round as any).hands, (before.state.round as any).hands, 'Timeout changed dealt cards')
    const absent = peers.find((p) => p.user.profileId === absentId)!
    assert.equal((await snapshot(absent, matchId)).you.status, 'absent'); assert.equal((await play(absent, matchId, { type: 'look' })).code, 'player_absent')
    await ok(absent, matchId, { type: 'request-return' }); const pending = saved(matchId); await stop(); await start(now + 1000); peers = await reconnect(users.slice(0, 3))
    same(saved(matchId), pending, 'Pending return changed during restart'); const restoredAbsent = peers.find((p) => p.user.profileId === absentId)!
    assert.equal((await snapshot(restoredAbsent, matchId)).you.returnPending, true)
    for (const message of [{ type: 'create_ludo_room', stake: 5000, playerCount: 2, manualStart: true }, { type: 'create_private_room', stake: 5000, waitMinutes: 5 }]) {
      send(restoredAbsent, message); const denied = await frame(restoredAbsent, (f) => f.type === 'error'); assert.equal(denied.code, 'svara_commitment_active')
    }
    assert.equal((await play(restoredAbsent, matchId, { type: 'look' })).code, 'player_absent')
    const nextPlayer = peers.find((p) => p.user.profileId === saved(matchId).deadlines[0]!.playerId)!
    await act(nextPlayer, matchId, { kind: 'fold' })
    // 2Б.3.7.1: that fold can leave the third (still-active) player as the
    // sole remaining participant, opening a reveal choice before the round
    // actually closes and the pending return can be activated. Hide it.
    const pendingChoice = saved(matchId).state.round as any
    if (pendingChoice?.kind === 'reveal-choice') {
      const winner = peers.find((p) => p.user.profileId === pendingChoice.winnerId)!
      await ok(winner, matchId, { type: 'hide-cards' })
    }
    const returned = saved(matchId)
    assert.equal(returned.state.status[absentId], 'active'); assert(!returned.state.pendingReturns?.includes(absentId))
    assert.notEqual(returned.state.round?.roundId, pending.state.round?.roundId, 'Return activated before a new deal')
    assert.equal((await snapshot(restoredAbsent, matchId)).you.cards, null)
    const old = peers[1]!, replacement = await connect(users[1]!); await fence(replacement)
    if (old.ws.readyState === WebSocket.OPEN) { const state = saved(matchId); const result = await play(old, matchId, { type: 'look' }); assert.equal(result.code, 'unauthenticated'); same(saved(matchId), state, 'Displaced session mutated game') }
    const forged = await connect(users[1]!, 'belot_session=invalid'); send(forged, { type: 'request_svara_table_state', matchId, profileId: users[1]!.profileId }); assert.equal((await frame(forged, (f) => f.type === 'svara_lobby_error')).code, 'unauthenticated')
    assert.equal(walletHash(), baselineWallet); await stop()
  })
  await check('real Svara joining window survives before expiry and closes once after restart', async () => {
    await restore(baseline); await start(BASE); let peers = await reconnect(users.slice(0, 3)); const ids = peers.map((p) => p.user.profileId)
    await ipc('decks', { decks: [deck([ids[1]!, ids[2]!, ids[0]!], { [ids[1]!]: 'KS QS JS', [ids[0]!]: 'KH QH JH', [ids[2]!]: '8C 9D 10H' })] })
    const matchId = await createTable(peers); await ok(peers[1]!, matchId, { type: 'look' }); await act(peers[1]!, matchId, { kind: 'bet', total: 5 }); await act(peers[2]!, matchId, { kind: 'fold' }); await act(peers[0]!, matchId, { kind: 'call' }); await fence(peers[0]!)
    assert.equal(saved(matchId).state.round?.kind, 'showdown-display')
    await finishShowdownDisplays(matchId)
    const before = saved(matchId); assert.equal(before.state.round?.kind, 'svara-joining'); const deadline = before.deadlines.find((d) => d.kind === 'svara-joining')!
    assert.equal(deadline.deadlineAt - now, 15000)
    // 2Б.3.7.4Б: the match spent svaraDealingAnimationMs(3)=3950ms in the
    // server dealing-presentation phase before the betting sequence below
    // could even start; restart 7000ms into the 15s joining window, same as before.
    await stop(); await start(deadline.deadlineAt - 8000); peers = await reconnect(users.slice(0, 3)); same(saved(matchId), before, 'Joining state reset')
    assert.equal((await timing(peers[2]!, matchId)).deadlines[0].remainingMs, 8000)
    await stop('crash'); await start(deadline.deadlineAt + 1); peers = await reconnect(users.slice(0, 3))
    const after = saved(matchId); assert.equal(after.state.round?.kind, 'svara'); assert.equal(after.revision, before.revision + 2)
    assert.equal(after.state.ledger.filter((e) => e.type === 'entry').length, 3); assert.equal(after.state.stacks[ids[2]!], before.state.stacks[ids[2]!]); integrity(); await stop()
  })
  await check('sole-active restart before/after five minutes awards the carried bank once, including another restart', async () => {
    await restore(baseline); await start(BASE); let peers = await reconnect(users.slice(0, 3)); const matchId = await carried(peers), before = saved(matchId), deadline = before.deadlines.find((d) => d.kind === 'presence-wait')!
    await stop(); await start(deadline.deadlineAt - 1); peers = await reconnect(users.slice(0, 3)); same(saved(matchId), before, 'Presence wait reset on restart'); assert.equal((await timing(peers[0]!, matchId)).deadlines[0].remainingMs, 1)
    await stop(); await start(deadline.deadlineAt + 1); peers = await reconnect(users.slice(0, 3)); const ended = saved(matchId)
    assert.equal(ended.state.winnerId, users[0]!.profileId); assert.equal(ended.state.finishReason, 'prolonged-absence'); assert.equal(ended.state.stacks[users[0]!.profileId], before.state.stacks[users[0]!.profileId]! + 150)
    assert.equal(ended.state.ledger.filter((e) => e.type === 'absence-pot-award').length, 1); assert.equal(ended.state.carried.length, 0); assert.equal(ended.state.lockedPots.length, 0)
    await stop('crash'); await start(now + 1000); peers = await reconnect(users.slice(0, 3)); same(saved(matchId), ended, 'Official win awarded twice'); assert.equal((await tables(peers[0]!)).length, 0); assert.equal(walletHash(), baselineWallet); integrity(); await stop()
  })
  await check('zero-active restart aborts without a winner, new entry fees or repeated pot removal', async () => {
    await restore(baseline); await start(BASE); let peers = await reconnect(users.slice(0, 3)); const matchId = await carried(peers); await ok(peers[0]!, matchId, { type: 'exit' })
    const before = saved(matchId), deadline = before.deadlines.find((d) => d.kind === 'presence-wait')!; assert.equal(deadline.playerId, null)
    await stop(); await start(deadline.deadlineAt - 1); peers = await reconnect(users.slice(0, 3)); same(saved(matchId), before, 'Zero-active wait reset'); assert.equal((await timing(peers[2]!, matchId)).deadlines[0].remainingMs, 1)
    await stop(); await start(deadline.deadlineAt + 1); peers = await reconnect(users.slice(0, 3)); const ended = saved(matchId)
    assert.equal(ended.state.winnerId, null); assert.equal(ended.state.finishReason, 'all-absent'); same(ended.state.stacks, before.state.stacks, 'Abort changed free balances'); assert.equal(ended.state.removedChips, before.state.removedChips + 150)
    assert.equal(ended.state.ledger.filter((e) => e.type === 'entry').length, before.state.ledger.filter((e) => e.type === 'entry').length); assert.equal(ended.state.ledger.filter((e) => e.type === 'abandoned-pot-removed').length, 1)
    await stop(); await start(now + 1000); same(saved(matchId), ended, 'Abort repeated'); integrity(); await stop()
  })
  await check('pending all-in main/side banks survive a crash and are settled exactly once through startup', async () => {
    await restore(baseline); await start(BASE); let peers = await reconnect(users.slice(0, 3)); const ids = peers.map((p) => p.user.profileId)
    const tie = deck(ids, { [ids[0]!]: 'KS QS JS', [ids[1]!]: 'KH QH JH', [ids[2]!]: 'KD QD JD' }), decided = deck(ids, { [ids[0]!]: '7C 7D 7H', [ids[1]!]: 'KH QH JH', [ids[2]!]: '8C 9D 10H' })
    await ipc('decks', { decks: [SVARA_ORDERED_DECK.map(svaraCardCode), SVARA_ORDERED_DECK.map(svaraCardCode), tie] })
    const matchId = await createTable(peers, 5000)
    for (const p of [peers[1]!, peers[2]!, peers[2]!, peers[0]!]) {
      await act(p, matchId, { kind: 'fold' })
      // 2Б.3.7.1: if that fold left a sole remaining winner, resolve the
      // reveal choice (hide) before the next scripted fold in this warm-up
      // sequence, which targets the following deal.
      const pendingChoice = saved(matchId).state.round as any
      if (pendingChoice?.kind === 'reveal-choice') {
        const winner = peers.find((peer) => peer.user.profileId === pendingChoice.winnerId)!
        await ok(winner, matchId, { type: 'hide-cards' })
      }
    }
    for (const p of peers.slice(0, 2)) { await ok(p, matchId, { type: 'look' }); await act(p, matchId, { kind: 'all-in' }) }
    await ok(peers[2]!, matchId, { type: 'look' }); const lost = await trap(peers[2]!, matchId, { type: 'act', action: { kind: 'all-in' } })
    const before = saved(matchId); assert.equal(before.state.round?.kind, 'showdown-display'); assert.equal(before.state.lockedPots.length, 2); await stop('crash')
    await start(now, '1', [tie, decided]); peers = await reconnect(users.slice(0, 3))
    same(saved(matchId), before, 'Pending all-in showdown changed on recovery')
    await finishShowdownDisplays(matchId)
    const after = saved(matchId)
    assert.equal(after.state.history.filter((r) => r.kind === 'allin-svara').length, 2); assert.equal(after.state.ledger.filter((e) => e.type === 'entry').length, 11)
    assert.equal((await play(peers[2]!, matchId, { type: 'act', action: { kind: 'all-in' } }, lost.commandId, lost.revision)).status, 'duplicate'); same(saved(matchId), after, 'All-in duplicate changed settled pots')
    await stop(); await start(now); same(saved(matchId), after, 'Settled main/side pots repeated after restart'); integrity(); await stop()
  })
  await check('several real tables restore independently with unchanged IDs and no duplicate lobby entries', async () => {
    await restore(baseline); await start(BASE); let peers = await reconnect(users)
    const ids = [await createTable(peers.slice(0, 3)), await createTable(peers.slice(3, 5), 5000, false), await createTable(peers.slice(5, 7))]
    const before = ids.map(saved); await stop(); await start(now + 2000); peers = await reconnect(users)
    ids.forEach((matchId, i) => same(saved(matchId), before[i], 'Independent table changed during recovery'))
    const list = await tables(peers[7]!); assert.equal(list.length, 3); assert.equal(new Set(list.map((t) => t.matchId)).size, 3)
    await ok(peers[1]!, ids[0]!, { type: 'look' }); same(saved(ids[1]!), before[1], 'First table mutated waiting table'); same(saved(ids[2]!), before[2], 'First table mutated third table'); await stop()
  })
  await check('real startup quarantines corrupt JSON, unsupported version and incomplete snapshots without overwrite/leaks', async () => {
    for (const kind of ['json', 'version', 'incomplete']) {
      await restore(activeFixture)
      const matchId = db((database) => {
        const row = database.prepare("SELECT match_id, snapshot_json FROM svara_match_snapshots WHERE match_status = 'in-progress'").get() as any
        const value = JSON.parse(row.snapshot_json)
        if (kind === 'json') { database.exec('PRAGMA ignore_check_constraints = ON'); database.prepare('UPDATE svara_match_snapshots SET snapshot_json = ? WHERE match_id = ?').run('PRIVATE_RESTART_SENTINEL', row.match_id) }
        if (kind === 'version') { value.formatVersion = 999; database.prepare('UPDATE svara_match_snapshots SET format_version = 999, snapshot_json = ? WHERE match_id = ?').run(JSON.stringify(value), row.match_id) }
        if (kind === 'incomplete') { delete value.state.ledger; database.prepare('UPDATE svara_match_snapshots SET snapshot_json = ? WHERE match_id = ?').run(JSON.stringify(value), row.match_id) }
        return row.match_id as string
      })
      const rowHash = () => db((database) => digest(database.prepare('SELECT * FROM svara_match_snapshots WHERE match_id = ?').get(matchId)))
      const before = rowHash(), child = await start(activeClock); assert.equal(child.recovery, 'failed'); const peer = await connect(users[0]!)
      const result = await ask(peer, { type: 'create_svara_table', requestId: randomUUID(), capacity: 2, entryFee: 1000, startMode: 'auto' }, 'svara_lobby_error')
      assert.equal(result.code, 'server_unavailable'); assert.equal(rowHash(), before); assert(!child.output.includes('PRIVATE_RESTART_SENTINEL'), 'Private snapshot leaked to backend logs'); await stop()
    }
  })
  await check('feature OFF/missing table keeps the real platform healthy; ON refuses missing required schema', async () => {
    await restore(baseline); db((database) => database.exec('DROP TABLE svara_match_snapshots')) // only the owned disposable schema; ledger intentionally simulates drift
    assert.equal((await start(BASE, '0')).recovery, 'disabled'); let peer = await connect(users[0]!)
    assert.equal((await ask(peer, { type: 'request_svara_tables_list' }, 'svara_lobby_error')).code, 'feature_disabled'); await stop()
    assert.equal((await start(BASE, '1')).recovery, 'failed'); peer = await connect(users[0]!)
    assert.equal((await ask(peer, { type: 'request_svara_tables_list' }, 'svara_lobby_error')).code, 'server_unavailable')
    assert.equal(db((database) => database.prepare("SELECT name FROM sqlite_master WHERE name = 'svara_match_snapshots'").get()), undefined); await stop()
  })
  await check('conflicting durable Ludo participation prevents Svara readiness without replacing its saved match', async () => {
    await restore(baseline); await start(BASE); const peers = await reconnect(users.slice(0, 2))
    send(peers[0]!, { type: 'create_ludo_room', stake: 5000, playerCount: 2, manualStart: false })
    const room = await frame(peers[0]!, (f) => f.type === 'ludo_room_updated')
    send(peers[1]!, { type: 'join_ludo_room', ludoRoomId: room.room.id }); await frame(peers[0]!, (f) => f.type === 'ludo_game_started')
    await stop()
    db((database) => {
      database.prepare('ATTACH DATABASE ? AS saved_svara').run(activeFixture)
      database.exec('INSERT INTO svara_match_snapshots SELECT * FROM saved_svara.svara_match_snapshots')
      database.exec('DETACH DATABASE saved_svara')
    })
    const before = db((database) => digest(database.prepare('SELECT * FROM svara_match_snapshots').all()))
    assert.equal((await start(activeClock)).recovery, 'failed')
    const peer = await connect(users[0]!); assert.equal((await ask(peer, { type: 'request_svara_tables_list' }, 'svara_lobby_error')).code, 'server_unavailable')
    assert.equal(db((database) => digest(database.prepare('SELECT * FROM svara_match_snapshots').all())), before); integrity(); await stop()
  })
} catch {
  const active = currentRunning()
  const diagnostic = { case: currentCase, starts, gracefulStops, crashes, passed, failed, pid: active?.pid, recovery: active?.recovery,
    exited: active?.exitCode, startupReady: active?.output.includes('[http] Belot V2 server is running'), shutdownSeen: active?.output.includes('[shutdown] signal=SIGTERM') }
  await mkdir(join(serverRoot, '../tmp'), { recursive: true })
  const artifact = join(serverRoot, '../tmp', `svara-restart-${randomUUID()}-failure.json`)
  await writeFile(artifact, JSON.stringify(diagnostic, null, 2))
  console.error(`Sanitized diagnostic: ${artifact}`)
  process.exitCode = 1
} finally {
  const value = currentRunning()
  if (value) {
    try { identity(value, false); if (value.exitCode === undefined) value.child.kill('SIGKILL'); await value.exited } finally { for (const client of clients.splice(0)) client.ws.terminate(); running = null }
  }
  await portFree()
  for (const link of links) await unlink(owned(link)).catch((error) => { if (error.code !== 'ENOENT') throw error })
  assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert(root.includes('pika-svara-restart-'))
  await rm(root, { recursive: true, force: true })
  for (const [path, hash] of productionHashes) assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'), hash, 'Production build modified by private hooks')
}
console.log(`\nSvara real restart 2Б.3.6В: ${passed} passed, ${failed} failed; ${starts} starts, ${gracefulStops} graceful stops, ${crashes} forced crashes; owned port released`)
if (failed) process.exitCode = 1
