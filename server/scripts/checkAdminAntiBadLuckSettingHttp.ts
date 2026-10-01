/**
 * checkAdminAntiBadLuckSettingHttp.ts
 *
 * E2E за "Anti Bad Luck праг" (Admin -> Настройки) през РЕАЛНИЯ spawned HTTP
 * сървър (изолиран temp SQLite, worker-candidate tick mode) — harness по
 * модела на checkConfigurableRegistrationMode.ts.
 *
 *  A. migration seed + startup runtime config (threshold=5, resetGeneration=0)
 *  B. auth: само пълен admin — guest/player/subadmin → 403, без промяна
 *  C. backend validation: само JSON number от 0|5|6|7|8|9|10, иначе 400
 *  D. валиден PATCH: GET/DB/runtime cache се обновяват веднага (без restart)
 *  E. resetGeneration: X→0 +1, 0→0 / 0→X / X→Y без промяна; не се връща в API
 *  F. PATCH без полето не го пипа
 *  G. persistence през process restart
 *  H. privacy: публичните endpoints не съдържат настройката
 *  I. frontend source review: admin <select> с 7-те стойности + текст
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const PASSWORD = 'AntiBadLuckSetting1!'
const TEST_SECRET = 'anti-bad-luck-setting-http-test-secret-0123456789'

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
  const root = await mkdtemp(join(tmpdir(), 'belot-abl-setting-'))
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

const rawSetting = (databaseFile: string, key: string) =>
  withDb(databaseFile, (db) => (db.prepare('SELECT setting_value AS v FROM admin_settings WHERE setting_key = ?').get(key) as { v: string } | undefined)?.v)

// Direct registration mode (live admin setting) → session веднага, без email код.
async function registerUser(port: number, databaseFile: string, label: string, role: string): Promise<string> {
  const email = `abl-${label}-${randomUUID().slice(0, 8)}@example.test`
  const result = await request(port, 'POST', '/api/auth/register', {
    email, password: PASSWORD, displayName: `Abl${label}${randomUUID().slice(0, 6)}`, gender: 'male', visitorId: randomUUID(),
  })
  assert(result.status === 200, `register ${label}: ${result.status} ${result.text}`)
  withDb(databaseFile, (db) => db.prepare('UPDATE accounts SET role = ? WHERE email = ?').run(role, email))
  const login = await request(port, 'POST', '/api/auth/login', { email, password: PASSWORD, rememberMe: true })
  const cookie = cookieOf(login)
  assert(cookie !== '', `login ${label}: ${login.status}`)
  return cookie
}

const sourceServerRoot = resolve(process.argv.slice(2).find((a) => a.startsWith('--server-root='))?.slice('--server-root='.length) ?? process.cwd())
console.log('\n═══ Admin Anti Bad Luck setting HTTP E2E ═══')

const isolated = await createIsolatedServerRoot(sourceServerRoot)
const port = await getFreePort()
let server = startServer(isolated.serverDir, port)

try {
  await waitForServer(port)

  console.log('\n=== A. seed + startup ===')
  await check('A1. migration seed: anti_bad_luck_threshold=5, anti_bad_luck_reset_generation=0', () => {
    assert(rawSetting(isolated.databaseFile, 'anti_bad_luck_threshold') === '5', 'threshold')
    assert(rawSetting(isolated.databaseFile, 'anti_bad_luck_reset_generation') === '0', 'generation')
  })
  await check('A2. startup лог: runtime config threshold=5 resetGeneration=0', () => {
    assert(server.output().includes('[anti-bad-luck] runtime config: threshold=5 resetGeneration=0'), 'missing startup log')
  })

  withDb(isolated.databaseFile, (db) => db.prepare(`UPDATE admin_settings SET setting_value = 'direct' WHERE setting_key = 'registration_verification_mode'`).run())
  const adminCookie = await registerUser(port, isolated.databaseFile, 'admin', 'admin')
  const subadminCookie = await registerUser(port, isolated.databaseFile, 'subadmin', 'subadmin')
  const playerCookie = await registerUser(port, isolated.databaseFile, 'player', 'player')

  console.log('\n=== B. auth ===')
  for (const [label, cookie] of [['guest', undefined], ['player', playerCookie], ['subadmin', subadminCookie]] as const) {
    await check(`B. ${label}: GET и PATCH /api/admin/settings → 403, без промяна`, async () => {
      const get = await request(port, 'GET', '/api/admin/settings', undefined, cookie)
      const patch = await request(port, 'PATCH', '/api/admin/settings', { antiBadLuckThreshold: 0 }, cookie)
      assert(get.status === 403 && patch.status === 403, `${get.status}/${patch.status}`)
      assert(!get.text.includes('antiBadLuck'), 'GET leaked setting')
      assert(rawSetting(isolated.databaseFile, 'anti_bad_luck_threshold') === '5', 'DB changed')
    })
  }
  await check('B4. admin GET → antiBadLuckThreshold=5, без resetGeneration в response-а', async () => {
    const get = await request(port, 'GET', '/api/admin/settings', undefined, adminCookie)
    const settings = get.body?.settings as Record<string, unknown> | undefined
    assert(get.status === 200 && settings?.antiBadLuckThreshold === 5, get.text)
    assert(!/resetGeneration|reset_generation/i.test(get.text), 'generation leaked')
  })

  console.log('\n=== C. validation ===')
  for (const value of [4, 11, -1, 5.5, '5', '0', null, true, [], {}, 1e9]) {
    await check(`C. PATCH antiBadLuckThreshold=${JSON.stringify(value)} → 400, DB непроменена`, async () => {
      const patch = await request(port, 'PATCH', '/api/admin/settings', { antiBadLuckThreshold: value }, adminCookie)
      assert(patch.status === 400, `${patch.status} ${patch.text}`)
      assert(rawSetting(isolated.databaseFile, 'anti_bad_luck_threshold') === '5', 'DB changed')
      assert(rawSetting(isolated.databaseFile, 'anti_bad_luck_reset_generation') === '0', 'generation changed')
    })
  }

  console.log('\n=== D. valid PATCH ===')
  await check('D1. PATCH 8 → 200; GET/DB = 8; runtime cache обновен веднага (лог), generation 0', async () => {
    const patch = await request(port, 'PATCH', '/api/admin/settings', { antiBadLuckThreshold: 8 }, adminCookie)
    assert(patch.status === 200 && (patch.body?.settings as Record<string, unknown>)?.antiBadLuckThreshold === 8, patch.text)
    const get = await request(port, 'GET', '/api/admin/settings', undefined, adminCookie)
    assert((get.body?.settings as Record<string, unknown>)?.antiBadLuckThreshold === 8, get.text)
    assert(rawSetting(isolated.databaseFile, 'anti_bad_luck_threshold') === '8', 'DB')
    assert(rawSetting(isolated.databaseFile, 'anti_bad_luck_reset_generation') === '0', 'generation')
    assert(/\[anti-bad-luck\] runtime config \(admin PATCH\): threshold 5 -> 8/.test(server.output()), 'missing cache update log')
    assert(/\[anti-bad-luck\] admin profile=\S+ changed threshold 5 -> 8/.test(server.output()), 'missing admin audit log')
  })

  console.log('\n=== E. resetGeneration ===')
  const generationAfter = async (value: number) => {
    const patch = await request(port, 'PATCH', '/api/admin/settings', { antiBadLuckThreshold: value }, adminCookie)
    assert(patch.status === 200, patch.text)
    assert(!/resetGeneration/i.test(patch.text), 'generation leaked in PATCH response')
    return rawSetting(isolated.databaseFile, 'anti_bad_luck_reset_generation')
  }
  await check('E1. 8→0 → generation 1; 0→0 → 1; 0→6 → 1; 6→9 → 1; 9→0 → 2; 0→7 → 2', async () => {
    const sequence = [await generationAfter(0), await generationAfter(0), await generationAfter(6), await generationAfter(9), await generationAfter(0), await generationAfter(7)]
    assert(JSON.stringify(sequence) === JSON.stringify(['1', '1', '1', '1', '2', '2']), JSON.stringify(sequence))
    assert(/runtime config \(admin PATCH\): threshold 9 -> 0, resetGeneration 1 -> 2/.test(server.output()), 'missing 9->0 cache log')
  })

  console.log('\n=== F. PATCH без полето ===')
  await check('F1. PATCH само на друго поле не пипа прага', async () => {
    const current = await request(port, 'GET', '/api/admin/settings', undefined, adminCookie)
    const freeTopicsVipDays = (current.body?.settings as Record<string, unknown>).freeTopicsVipDays
    const patch = await request(port, 'PATCH', '/api/admin/settings', { freeTopicsVipDays }, adminCookie)
    assert(patch.status === 200 && (patch.body?.settings as Record<string, unknown>)?.antiBadLuckThreshold === 7, patch.text)
    assert(rawSetting(isolated.databaseFile, 'anti_bad_luck_reset_generation') === '2', 'generation changed')
  })

  console.log('\n=== H. privacy ===')
  await check('H1. /api/settings/public и /api/rooms не съдържат настройката', async () => {
    const pub = await request(port, 'GET', '/api/settings/public', undefined, playerCookie)
    const rooms = await request(port, 'GET', '/api/rooms', undefined, playerCookie)
    assert(pub.status === 200 && rooms.status === 200, `${pub.status}/${rooms.status}`)
    assert(!/antiBadLuck|resetGeneration/i.test(pub.text + rooms.text), 'leak')
  })

  console.log('\n=== G. restart persistence ===')
  await stopServer(server)
  server = startServer(isolated.serverDir, port)
  await waitForServer(port)
  await check('G1. след restart: startup лог threshold=7 resetGeneration=2, GET = 7', async () => {
    assert(server.output().includes('[anti-bad-luck] runtime config: threshold=7 resetGeneration=2'), 'startup log')
    const login = await request(port, 'GET', '/api/admin/settings', undefined, adminCookie)
    assert(login.status === 200 && (login.body?.settings as Record<string, unknown>)?.antiBadLuckThreshold === 7, login.text)
  })
  await check('G2. defensive refresh (~5s) хваща out-of-band промяна в базата без PATCH', async () => {
    withDb(isolated.databaseFile, (db) => db.prepare(`UPDATE admin_settings SET setting_value = '10' WHERE setting_key = 'anti_bad_luck_threshold'`).run())
    const deadline = Date.now() + 12_000
    while (Date.now() < deadline && !/runtime config \(periodic\): threshold 7 -> 10/.test(server.output())) await sleep(250)
    assert(/runtime config \(periodic\): threshold 7 -> 10/.test(server.output()), 'periodic refresh not observed')
  })

  console.log('\n=== I. frontend (source review) ===')
  await check('I1. admin <select name="antiBadLuckThreshold"> с „Изключено (0)“ и 5..10, текст и submit', () => {
    const lobby = readFileSync(join(sourceServerRoot, '..', 'src', 'app', 'lobby', 'renderLobbyScreen.ts'), 'utf8')
    const client = readFileSync(join(sourceServerRoot, '..', 'src', 'app', 'network', 'createGameServerClient.ts'), 'utf8')
    assert(lobby.includes('<select name="antiBadLuckThreshold"'), 'select')
    assert(lobby.includes("const ADMIN_ANTI_BAD_LUCK_THRESHOLD_OPTIONS: ReadonlyArray<AdminSettingsSnapshot['antiBadLuckThreshold']> = [0, 5, 6, 7, 8, 9, 10]"), 'options')
    assert(lobby.includes("'Изключено (0)'"), 'off label')
    assert(lobby.includes('При 5 — помощ най-рано на следващото слабо раздаване след 5 поредни слаби') && lobby.includes('При 0 системата е напълно изключена'), 'explanatory text')
    assert(lobby.includes('        antiBadLuckThreshold,\n') || lobby.includes('        antiBadLuckThreshold,\r\n'), 'submit field')
    assert(client.includes('antiBadLuckThreshold: 0 | 5 | 6 | 7 | 8 | 9 | 10'), 'client type')
  })
} finally {
  await stopServer(server)
  await isolated.cleanup()
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
