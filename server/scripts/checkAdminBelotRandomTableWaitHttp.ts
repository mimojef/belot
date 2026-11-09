/**
 * checkAdminBelotRandomTableWaitHttp.ts
 *
 * E2E за "Белот — изчакване на случайна маса" (Admin -> Настройки) през
 * РЕАЛНИЯ spawned HTTP/WS сървър (изолиран temp SQLite) — harness по модела на
 * checkAdminAntiBadLuckSettingHttp.ts.
 *
 *  A. default 180 без seed ред; /health waitMs = 180000
 *  B. auth: само пълен admin — guest/player/subadmin → 403, без промяна
 *  C. backend validation: само цяло JSON число 20..600, иначе 400
 *  D. валиден PATCH: GET/DB/health веднага (без restart); PATCH без полето не го пипа
 *  E. matchmaking: съществуваща маса пази своя краен момент/продължителност след
 *     промяна; вторият играч вижда общото оставащо време; нова маса = новата стойност
 *  F. persistence през process restart
 *  G. frontend source review: полето, границите, прегледът в минути
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import WebSocket from 'ws'

const PASSWORD = 'RandomTableWait1!'
const TEST_SECRET = 'random-table-wait-http-test-secret-0123456789'
const STAKE = 5000

let passed = 0
let failed = 0

async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    passed += 1
    console.log(`  PASS  ${label}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL  ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))

function getFreePort(): Promise<number> {
  return new Promise((done, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (!addr || typeof addr === 'string') {
        srv.close(() => reject(new Error('no port')))
        return
      }
      srv.close(() => done(addr.port))
    })
  })
}

async function retryRm(path: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try { await rm(path, { recursive: true, force: true }); return } catch { /* retry */ }
    await sleep(250)
  }
}

async function createIsolatedServerRoot(originalServerRoot: string) {
  const root = await mkdtemp(join(tmpdir(), 'belot-random-wait-'))
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
  return { serverDir, databaseFile: join(serverDir, 'database', 'data', 'belot-v2.sqlite'), cleanup: () => retryRm(root) }
}

type RunningServer = { child: ChildProcessWithoutNullStreams; output(): string }

function startServer(serverDir: string, port: number): RunningServer {
  const chunks: string[] = []
  const child = spawn(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'index.ts')], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(port),
      BELOT_GAME_WORKER_TICK_MODE: 'worker-candidate',
      BELOT_GAME_WORKER_COUNT: '1',
      BELOT_ALLOW_CATALOG_BOT_FALLBACK: '1',
      PASSWORD_RESET_RATE_LIMIT_SECRET: TEST_SECRET,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => chunks.push(chunk))
  child.stderr.on('data', (chunk: string) => chunks.push(chunk))
  return { child, output: () => chunks.join('') }
}

async function stopServer(server: RunningServer): Promise<void> {
  if (server.child.exitCode !== null) return
  server.child.kill('SIGTERM')
  await new Promise<void>((done) => {
    const timer = setTimeout(() => { server.child.kill('SIGKILL'); done() }, 10_000)
    server.child.once('exit', () => { clearTimeout(timer); done() })
  })
}

async function waitForServer(port: number): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/rooms`)).status === 200) return
    } catch { /* not yet */ }
    await sleep(100)
  }
  throw new Error('server did not start')
}

let ipCounter = 0
const nextIp = () => `203.0.113.${(ipCounter += 1)}`

type JsonResult = { status: number; body: Record<string, unknown> | null; text: string; setCookie: string[] }

async function request(port: number, method: 'GET' | 'POST' | 'PATCH', pathname: string, body?: unknown, cookie?: string): Promise<JsonResult> {
  const headers: Record<string, string> = { 'X-Forwarded-For': nextIp() }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (cookie) headers['Cookie'] = cookie
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  let parsed: Record<string, unknown> | null = null
  try { parsed = JSON.parse(text) as Record<string, unknown> } catch { /* not json */ }
  const headersExt = res.headers as Headers & { getSetCookie?: () => string[] }
  return { status: res.status, body: parsed, text, setCookie: headersExt.getSetCookie?.() ?? [] }
}

const cookieOf = (result: JsonResult) => result.setCookie.find((c) => c.startsWith('belot_session='))?.split(';')[0] ?? ''

function withDb<T>(databaseFile: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(databaseFile)
  try { return fn(db) } finally { db.close() }
}

const SETTING_KEY = 'belot_random_table_wait_seconds'
const rawSetting = (databaseFile: string) =>
  withDb(databaseFile, (db) => (db.prepare('SELECT setting_value AS v FROM admin_settings WHERE setting_key = ?').get(SETTING_KEY) as { v: string } | undefined)?.v)

type User = { cookie: string; profileId: string }

// Direct registration mode (live admin setting) → session веднага, без email код.
async function registerUser(port: number, databaseFile: string, label: string, role: string): Promise<User> {
  const email = `rtw-${label}-${randomUUID().slice(0, 8)}@example.test`
  const result = await request(port, 'POST', '/api/auth/register', {
    email, password: PASSWORD, displayName: `Rtw${label}${randomUUID().slice(0, 6)}`, gender: 'male', visitorId: randomUUID(),
  })
  assert(result.status === 200, `register ${label}: ${result.status} ${result.text}`)
  withDb(databaseFile, (db) => db.prepare('UPDATE accounts SET role = ? WHERE email = ?').run(role, email))
  const login = await request(port, 'POST', '/api/auth/login', { email, password: PASSWORD, rememberMe: true })
  const cookie = cookieOf(login)
  assert(cookie !== '', `login ${label}: ${login.status}`)
  const session = login.body?.session as { profile?: { profileId?: string } } | undefined
  const profileId = session?.profile?.profileId ?? ''
  assert(profileId !== '', `login ${label}: no profileId`)
  withDb(databaseFile, (db) => db.prepare(
    `INSERT INTO profile_wallets (profile_id, yellow_coins_balance) VALUES (?, ?)
     ON CONFLICT(profile_id) DO UPDATE SET yellow_coins_balance = excluded.yellow_coins_balance`,
  ).run(profileId, 1_000_000))
  return { cookie, profileId }
}

type WsClient = { ws: WebSocket; frames: Array<Record<string, unknown>> }

async function connectWs(port: number, cookie: string): Promise<WsClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: cookie } })
  const frames: Array<Record<string, unknown>> = []
  ws.on('message', (data) => {
    try { frames.push(JSON.parse(data.toString()) as Record<string, unknown>) } catch { /* ignore */ }
  })
  await new Promise<void>((done, reject) => {
    ws.once('open', () => done())
    ws.once('error', reject)
  })
  return { ws, frames }
}

async function waitForFrame(client: WsClient, predicate: (frame: Record<string, unknown>) => boolean, label: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const frame = client.frames.find(predicate)
    if (frame) return frame
    await sleep(50)
  }
  throw new Error(`timeout waiting for ${label}; got ${client.frames.map((f) => f.type).join(',')}`)
}

const patchWait = (port: number, cookie: string | undefined, value: unknown) =>
  request(port, 'PATCH', '/api/admin/settings', { belotRandomTableWaitSeconds: value }, cookie)

const getWait = async (port: number, cookie: string) => {
  const get = await request(port, 'GET', '/api/admin/settings', undefined, cookie)
  return (get.body?.settings as Record<string, unknown> | undefined)?.belotRandomTableWaitSeconds
}

const healthWaitMs = async (port: number) => {
  const health = await request(port, 'GET', '/health')
  return (health.body?.matchmaking as Record<string, unknown> | undefined)?.waitMs
}

const sourceServerRoot = resolve(process.argv.slice(2).find((a) => a.startsWith('--server-root='))?.slice('--server-root='.length) ?? process.cwd())
console.log('\n═══ Admin "Белот — изчакване на случайна маса" HTTP/WS E2E ═══')

const isolated = await createIsolatedServerRoot(sourceServerRoot)
const port = await getFreePort()
let server = startServer(isolated.serverDir, port)
const sockets: WebSocket[] = []

try {
  await waitForServer(port)
  withDb(isolated.databaseFile, (db) => db.prepare(`UPDATE admin_settings SET setting_value = 'direct' WHERE setting_key = 'registration_verification_mode'`).run())
  const admin = await registerUser(port, isolated.databaseFile, 'admin', 'admin')
  const subadmin = await registerUser(port, isolated.databaseFile, 'subadmin', 'subadmin')
  const player = await registerUser(port, isolated.databaseFile, 'player', 'player')

  console.log('\n=== A. default ===')
  await check('A1. няма seed ред; GET = 180; /health waitMs = 180000; startup лог wait=180000ms', async () => {
    assert(rawSetting(isolated.databaseFile) === undefined, 'unexpected DB row')
    assert((await getWait(port, admin.cookie)) === 180, 'GET')
    assert((await healthWaitMs(port)) === 180_000, 'health')
    assert(server.output().includes('wait=180000ms (admin setting)'), 'startup log')
  })

  console.log('\n=== B. auth ===')
  for (const [label, cookie] of [['guest', undefined], ['player', player.cookie], ['subadmin', subadmin.cookie]] as const) {
    await check(`B. ${label}: GET и PATCH /api/admin/settings → 403, без промяна`, async () => {
      assert((await request(port, 'GET', '/api/admin/settings', undefined, cookie)).status === 403, 'GET')
      assert((await patchWait(port, cookie, 60)).status === 403, 'PATCH')
      assert(rawSetting(isolated.databaseFile) === undefined, 'DB changed')
    })
  }

  console.log('\n=== C. validation ===')
  for (const value of [19, 601, 0, -5, 180.5, '180', null, true, [180], 1e9]) {
    await check(`C. ${JSON.stringify(value)} → 400, без промяна`, async () => {
      const res = await patchWait(port, admin.cookie, value)
      assert(res.status === 400, `status ${res.status} ${res.text}`)
      assert(rawSetting(isolated.databaseFile) === undefined, 'DB changed')
    })
  }
  await check('C. граници 20 и 600 → 200', async () => {
    assert((await patchWait(port, admin.cookie, 20)).status === 200, '20')
    assert(rawSetting(isolated.databaseFile) === '20', 'DB 20')
    assert((await patchWait(port, admin.cookie, 600)).status === 200, '600')
    assert(rawSetting(isolated.databaseFile) === '600', 'DB 600')
  })

  console.log('\n=== D. valid PATCH ===')
  await check('D1. PATCH 180 → GET/DB/health веднага, без restart', async () => {
    const res = await patchWait(port, admin.cookie, 180)
    assert(res.status === 200 && (res.body?.settings as Record<string, unknown>)?.belotRandomTableWaitSeconds === 180, res.text)
    assert(rawSetting(isolated.databaseFile) === '180', 'DB')
    assert((await healthWaitMs(port)) === 180_000, 'health')
  })
  await check('D2. PATCH без полето (друга настройка) не го пипа', async () => {
    const res = await request(port, 'PATCH', '/api/admin/settings', { freeTopicsVipDays: 30 }, admin.cookie)
    assert(res.status === 200, res.text)
    assert(rawSetting(isolated.databaseFile) === '180', 'DB changed')
  })

  console.log('\n=== E. matchmaking ===')
  const p1 = await registerUser(port, isolated.databaseFile, 'p1', 'player')
  const p2 = await registerUser(port, isolated.databaseFile, 'p2', 'player')
  const p3 = await registerUser(port, isolated.databaseFile, 'p3', 'player')
  const c1 = await connectWs(port, p1.cookie)
  const c2 = await connectWs(port, p2.cookie)
  const c3 = await connectWs(port, p3.cookie)
  sockets.push(c1.ws, c2.ws, c3.ws)

  c1.ws.send(JSON.stringify({ type: 'join_matchmaking', stake: STAKE }))
  const p1Joined = await waitForFrame(c1, (f) => f.type === 'matchmaking_joined', 'p1 joined')
  const tableEndsAt = p1Joined.countdownEndsAt as number
  await check('E1. първият играч (настройка 180) → 180 сек, ring 180000', () => {
    assert(p1Joined.totalDurationMs === 180_000, `total=${String(p1Joined.totalDurationMs)}`)
    assert((p1Joined.remainingMs as number) > 179_000 && (p1Joined.remainingMs as number) <= 180_000, `remaining=${String(p1Joined.remainingMs)}`)
  })

  await sleep(1_500)
  await check('E2. admin сменя на 120 докато масата чака → 200', async () => {
    assert((await patchWait(port, admin.cookie, 120)).status === 200, 'PATCH')
    assert((await healthWaitMs(port)) === 120_000, 'health')
  })

  c1.frames.length = 0
  c2.ws.send(JSON.stringify({ type: 'join_matchmaking', stake: STAKE }))
  const p2Joined = await waitForFrame(c2, (f) => f.type === 'matchmaking_joined', 'p2 joined')
  await check('E3. вторият играч влиза в същата маса: същия краен момент, ring 180000, оставащо < 180 сек', () => {
    assert(p2Joined.countdownEndsAt === tableEndsAt, `endsAt ${String(p2Joined.countdownEndsAt)} != ${tableEndsAt}`)
    assert(p2Joined.totalDurationMs === 180_000, `total=${String(p2Joined.totalDurationMs)}`)
    const remaining = p2Joined.remainingMs as number
    assert(remaining < 179_000 && remaining > 170_000, `remaining=${remaining}`)
    assert(p2Joined.queuedPlayers === 2, `queued=${String(p2Joined.queuedPlayers)}`)
  })
  const p1Status = await waitForFrame(c1, (f) => f.type === 'matchmaking_status' && f.queuedPlayers === 2, 'p1 status after p2')
  await check('E4. първият играч получава status със същия краен момент и ring 180000 (не 120000)', () => {
    assert(p1Status.countdownEndsAt === tableEndsAt, `endsAt ${String(p1Status.countdownEndsAt)}`)
    assert(p1Status.totalDurationMs === 180_000, `total=${String(p1Status.totalDurationMs)}`)
  })

  c1.ws.send(JSON.stringify({ type: 'leave_matchmaking' }))
  c2.ws.send(JSON.stringify({ type: 'leave_matchmaking' }))
  await waitForFrame(c1, (f) => f.type === 'matchmaking_left', 'p1 left')
  await waitForFrame(c2, (f) => f.type === 'matchmaking_left', 'p2 left')

  c3.ws.send(JSON.stringify({ type: 'join_matchmaking', stake: STAKE }))
  const p3Joined = await waitForFrame(c3, (f) => f.type === 'matchmaking_joined', 'p3 joined')
  await check('E5. след като всички напуснат: нова маса = новата стойност 120 сек, ring 120000', () => {
    assert(p3Joined.totalDurationMs === 120_000, `total=${String(p3Joined.totalDurationMs)}`)
    const remaining = p3Joined.remainingMs as number
    assert(remaining > 119_000 && remaining <= 120_000, `remaining=${remaining}`)
    assert((p3Joined.countdownEndsAt as number) > tableEndsAt - 60_000, 'endsAt not fresh')
  })
  c3.ws.send(JSON.stringify({ type: 'leave_matchmaking' }))
  await waitForFrame(c3, (f) => f.type === 'matchmaking_left', 'p3 left')

  console.log('\n=== F. restart persistence ===')
  for (const ws of sockets) ws.close()
  await stopServer(server)
  server = startServer(isolated.serverDir, port)
  await waitForServer(port)
  await check('F1. след restart: GET = 120, /health 120000, startup лог wait=120000ms', async () => {
    assert((await getWait(port, admin.cookie)) === 120, 'GET')
    assert((await healthWaitMs(port)) === 120_000, 'health')
    assert(server.output().includes('wait=120000ms (admin setting)'), 'startup log')
  })
  await check('F2. повредена стойност в базата → fallback 180 (не 0/NaN)', async () => {
    withDb(isolated.databaseFile, (db) => db.prepare('UPDATE admin_settings SET setting_value = ? WHERE setting_key = ?').run('abc', SETTING_KEY))
    assert((await getWait(port, admin.cookie)) === 180, 'GET')
    withDb(isolated.databaseFile, (db) => db.prepare('UPDATE admin_settings SET setting_value = ? WHERE setting_key = ?').run('5', SETTING_KEY))
    assert((await getWait(port, admin.cookie)) === 180, 'GET out of range')
    assert((await patchWait(port, admin.cookie, 120)).status === 200, 'restore')
  })

  console.log('\n=== G. frontend (source review) ===')
  await check('G1. поле „Време за изчакване (секунди)“ 20..600, step 1, преглед в минути, submit', () => {
    const lobby = readFileSync(join(sourceServerRoot, '..', 'src', 'app', 'lobby', 'renderLobbyScreen.ts'), 'utf8')
    const client = readFileSync(join(sourceServerRoot, '..', 'src', 'app', 'network', 'createGameServerClient.ts'), 'utf8')
    assert(lobby.includes('Белот — изчакване на случайна маса'), 'heading')
    assert(lobby.includes('Време за изчакване (секунди)'), 'label')
    assert(lobby.includes('<input name="belotRandomTableWaitSeconds" type="number" min="${ADMIN_BELOT_RANDOM_TABLE_WAIT_MIN_SECONDS}" max="${ADMIN_BELOT_RANDOM_TABLE_WAIT_MAX_SECONDS}" step="1"'), 'input')
    assert(lobby.includes('const ADMIN_BELOT_RANDOM_TABLE_WAIT_MIN_SECONDS = 20') && lobby.includes('const ADMIN_BELOT_RANDOM_TABLE_WAIT_MAX_SECONDS = 600'), 'bounds')
    assert(lobby.includes('data-lobby-admin-random-table-wait-preview="1"'), 'preview')
    assert(lobby.includes('        belotRandomTableWaitSeconds,\n') || lobby.includes('        belotRandomTableWaitSeconds,\r\n'), 'submit field')
    assert(client.includes('belotRandomTableWaitSeconds: number'), 'client type')
  })
} finally {
  for (const ws of sockets) { try { ws.close() } catch { /* ignore */ } }
  await stopServer(server)
  await isolated.cleanup()
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
