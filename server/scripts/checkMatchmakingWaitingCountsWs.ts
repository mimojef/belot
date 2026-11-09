/**
 * checkMatchmakingWaitingCountsWs.ts
 *
 * E2E за значката „брой чакащи реални играчи“ на каретата на случайните маси
 * (matchmaking_waiting_counts) през РЕАЛНИЯ spawned HTTP/WS сървър (изолиран
 * temp SQLite) — harness по модела на checkAdminBelotRandomTableWaitHttp.ts.
 *
 *  A. bootstrap при отваряне на WS (и за гост без профил)
 *  B. join → 1, 2; независими бройки по залог
 *  C. отказ (leave_matchmaking), прекъсване (close), смяна на залог
 *  D. 4 реални → мачът тръгва веднага, бройката пада до 0 (никога 4)
 *  E. запълване с ботове в края → бройката пада до 0; ботовете не се броят
 *  F. reconnect / нов браузър получава текущото състояние
 *  G. няколко наблюдатели виждат еднаква последователност; без дубликати
 *     и без съобщения, когато нищо не се променя; само бройки (без имена/ID)
 */

import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import WebSocket from 'ws'

const PASSWORD = 'WaitingCounts1!'
const TEST_SECRET = 'waiting-counts-ws-test-secret-0123456789abcdef'

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
  const root = await mkdtemp(join(tmpdir(), 'belot-waiting-counts-'))
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

async function registerUser(port: number, databaseFile: string, label: string, role = 'player'): Promise<string> {
  const email = `wc-${label}-${randomUUID().slice(0, 8)}@example.test`
  const result = await request(port, 'POST', '/api/auth/register', {
    email, password: PASSWORD, displayName: `Wc${label}${randomUUID().slice(0, 6)}`, gender: 'male', visitorId: randomUUID(),
  })
  assert(result.status === 200, `register ${label}: ${result.status} ${result.text}`)
  withDb(databaseFile, (db) => db.prepare('UPDATE accounts SET role = ? WHERE email = ?').run(role, email))
  const login = await request(port, 'POST', '/api/auth/login', { email, password: PASSWORD, rememberMe: true })
  const cookie = cookieOf(login)
  assert(cookie !== '', `login ${label}: ${login.status}`)
  const profileId = (login.body?.session as { profile?: { profileId?: string } } | undefined)?.profile?.profileId ?? ''
  assert(profileId !== '', `login ${label}: no profileId`)
  withDb(databaseFile, (db) => db.prepare(
    `INSERT INTO profile_wallets (profile_id, yellow_coins_balance) VALUES (?, ?)
     ON CONFLICT(profile_id) DO UPDATE SET yellow_coins_balance = excluded.yellow_coins_balance`,
  ).run(profileId, 1_000_000))
  return cookie
}

type Frame = Record<string, unknown>
type WsClient = { ws: WebSocket; frames: Frame[]; counts(): Array<Record<string, number>> }

async function connectWs(port: number, cookie?: string): Promise<WsClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, cookie ? { headers: { Cookie: cookie } } : {})
  const frames: Frame[] = []
  ws.on('message', (data) => {
    try { frames.push(JSON.parse(data.toString()) as Frame) } catch { /* ignore */ }
  })
  await new Promise<void>((done, reject) => {
    ws.once('open', () => done())
    ws.once('error', reject)
  })
  return {
    ws,
    frames,
    counts: () => frames.filter((f) => f.type === 'matchmaking_waiting_counts').map((f) => f.counts as Record<string, number>),
  }
}

async function waitFor(label: string, condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return
    await sleep(25)
  }
  throw new Error(`timeout: ${label}`)
}

const same = (a: Record<string, number> | undefined, b: Record<string, number>) => JSON.stringify(a) === JSON.stringify(b)
const lastCounts = (c: WsClient) => c.counts().at(-1)

// Чака наблюдателят да получи ТОЧНО тези бройки като последно съобщение.
async function expectCounts(observer: WsClient, expected: Record<string, number>, label: string): Promise<void> {
  try {
    await waitFor(label, () => same(lastCounts(observer), expected))
  } catch {
    throw new Error(`${label}: last=${JSON.stringify(lastCounts(observer))} expected=${JSON.stringify(expected)}`)
  }
}

const send = (client: WsClient, message: Frame) => client.ws.send(JSON.stringify(message))
const join_ = (client: WsClient, stake: number) => send(client, { type: 'join_matchmaking', stake })

const sourceServerRoot = resolve(process.argv.slice(2).find((a) => a.startsWith('--server-root='))?.slice('--server-root='.length) ?? process.cwd())
console.log('\n═══ Matchmaking waiting counts (lobby badge) WS E2E ═══')

const isolated = await createIsolatedServerRoot(sourceServerRoot)
const port = await getFreePort()
const server = startServer(isolated.serverDir, port)
const sockets: WebSocket[] = []
const track = (c: WsClient) => { sockets.push(c.ws); return c }

try {
  await waitForServer(port)
  withDb(isolated.databaseFile, (db) => db.prepare(`UPDATE admin_settings SET setting_value = 'direct' WHERE setting_key = 'registration_verification_mode'`).run())
  const adminCookie = await registerUser(port, isolated.databaseFile, 'admin', 'admin')
  const cookies: string[] = []
  for (let i = 0; i < 8; i += 1) cookies.push(await registerUser(port, isolated.databaseFile, `p${i}`))

  console.log('\n=== A. bootstrap ===')
  const observerA = track(await connectWs(port, await registerUser(port, isolated.databaseFile, 'obsA')))
  const observerB = track(await connectWs(port, await registerUser(port, isolated.databaseFile, 'obsB')))
  const guest = track(await connectWs(port))
  await check('A1. при отваряне на WS: празни бройки {} (влогнат и гост)', async () => {
    await expectCounts(observerA, {}, 'observerA bootstrap')
    await expectCounts(observerB, {}, 'observerB bootstrap')
    await expectCounts(guest, {}, 'guest bootstrap')
  })

  console.log('\n=== B. join ===')
  const p = await Promise.all(cookies.map(async (cookie) => track(await connectWs(port, cookie))))
  join_(p[0]!, 5000)
  await check('B1. играч А на 5000 → {5000:1}', () => expectCounts(observerA, { '5000': 1 }, 'B1'))
  join_(p[1]!, 5000)
  await check('B2. играч Б на 5000 → {5000:2}', () => expectCounts(observerA, { '5000': 2 }, 'B2'))
  join_(p[2]!, 8000)
  join_(p[3]!, 10000)
  join_(p[4]!, 10000)
  join_(p[5]!, 10000)
  await check('B3. независими бройки: {5000:2, 8000:1, 10000:3}', () => expectCounts(observerA, { '5000': 2, '8000': 1, '10000': 3 }, 'B3'))
  await check('B4. гостът вижда същото', () => expectCounts(guest, { '5000': 2, '8000': 1, '10000': 3 }, 'B4'))

  console.log('\n=== C. отказ / прекъсване / смяна на залог ===')
  send(p[0]!, { type: 'leave_matchmaking' })
  await check('C1. отказ (А напуска 5000) → {5000:1, 8000:1, 10000:3}', () => expectCounts(observerA, { '5000': 1, '8000': 1, '10000': 3 }, 'C1'))
  p[1]!.ws.close()
  await check('C2. прекъсната връзка (Б) → 5000 изчезва', () => expectCounts(observerA, { '8000': 1, '10000': 3 }, 'C2'))
  join_(p[2]!, 15000)
  await check('C3. смяна на залог 8000 → 15000', () => expectCounts(observerA, { '10000': 3, '15000': 1 }, 'C3'))

  console.log('\n=== D. 4 реални → старт веднага ===')
  join_(p[6]!, 10000)
  await check('D1. 4-ти на 10000 → играта тръгва, 10000 изчезва', async () => {
    await expectCounts(observerA, { '15000': 1 }, 'D1')
    await waitFor('match_found for 4th', () => p[6]!.frames.some((f) => f.type === 'match_found' && f.botPlayers === 0))
  })
  await check('D2. никога не е изпратено 10000:4', () => {
    assert(!observerA.counts().some((c) => c['10000'] === 4), JSON.stringify(observerA.counts()))
  })

  console.log('\n=== F. reconnect / нов браузър ===')
  const lateObserver = track(await connectWs(port, await registerUser(port, isolated.databaseFile, 'late')))
  await check('F1. нова връзка получава текущото състояние {15000:1}', () => expectCounts(lateObserver, { '15000': 1 }, 'F1'))

  console.log('\n=== G. синхронизация / без дубликати / privacy ===')
  await check('G1. двамата наблюдатели получиха еднаква последователност', () => {
    assert(JSON.stringify(observerA.counts()) === JSON.stringify(observerB.counts()), `${JSON.stringify(observerA.counts())} vs ${JSON.stringify(observerB.counts())}`)
  })
  await check('G2. без последователни дубликати (праща се само при промяна)', () => {
    const list = observerA.counts().map((c) => JSON.stringify(c))
    assert(list.every((v, i) => i === 0 || v !== list[i - 1]), JSON.stringify(list))
  })
  await check('G3. без съобщения, когато нищо не се променя (3 сек)', async () => {
    const before = observerA.counts().length
    await sleep(3_000)
    assert(observerA.counts().length === before, `${observerA.counts().length - before} extra`)
  })
  await check('G4. съобщението съдържа само type + counts с числа (без имена/ID)', () => {
    for (const frame of observerA.frames.filter((f) => f.type === 'matchmaking_waiting_counts')) {
      assert(JSON.stringify(Object.keys(frame).sort()) === '["counts","type"]', JSON.stringify(frame))
      for (const [key, value] of Object.entries(frame.counts as Record<string, unknown>)) {
        assert(/^\d+$/.test(key) && Number.isInteger(value) && (value as number) > 0, JSON.stringify(frame))
      }
    }
  })

  console.log('\n=== E. ботове в края ===')
  assert((await request(port, 'PATCH', '/api/admin/settings', { belotRandomTableWaitSeconds: 20 }, adminCookie)).status === 200, 'set 20s')
  join_(p[7]!, 20000)
  await check('E1. нов играч на 20000 → {15000:1, 20000:1}', () => expectCounts(observerA, { '15000': 1, '20000': 1 }, 'E1'))
  await check('E2. след запълване с ботове (20 сек) → 20000 изчезва; ботовете не се броят', async () => {
    await waitFor('match_found with bots', () => p[7]!.frames.some((f) => f.type === 'match_found' && f.botPlayers === 3), 30_000)
    await expectCounts(observerA, { '15000': 1 }, 'E2')
    assert(!observerA.counts().some((c) => (c['20000'] ?? 0) > 1), JSON.stringify(observerA.counts()))
  })
  send(p[2]!, { type: 'leave_matchmaking' })
  await check('E3. последният чакащ напуска → {} (значките изчезват)', () => expectCounts(observerA, {}, 'E3'))
} finally {
  for (const ws of sockets) { try { ws.close() } catch { /* ignore */ } }
  await stopServer(server)
  await isolated.cleanup()
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
