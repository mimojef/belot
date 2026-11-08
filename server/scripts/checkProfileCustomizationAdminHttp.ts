/**
 * checkProfileCustomizationAdminHttp.ts
 *
 * "Персонализация на профила", Етап 1 — реален изолиран сървър и реалното
 * admin HTTP API /api/admin/profile-customization.
 *
 *  A. Флаг ВКЛЮЧЕН: гост/играч/subadmin -> 403; admin -> 200 с началния
 *     каталог (4 вида, 23 цвята = 21 начални + Розов + Оранжев, емоджитата).
 *  B. Цени: текст "2.49" -> 249 цента, таблицата 30..180 дни е точна;
 *     невалидни цени/стойности -> 400 без промяна.
 *  C. Каталог: служебният #F72585 и близки нюанси -> 400; дубликат -> 409;
 *     hex не се сменя през PATCH; скриване/категория на емоджи.
 *  D. Покупки: празен списък, филтър по статус.
 *  E. Флаг ИЗКЛЮЧЕН (рестарт без env): admin продължава да конфигурира
 *     (режимът е в SQLite, "Само админ" по подразбиране; env-ът е само
 *     авариен стоп), admin има достъп и до потребителския API.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/checkProfileCustomizationAdminHttp.ts --server-root=.
 */

import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { TEST_REGISTRATION_SECRET, configureDirectRegistrationForTest, prepareDirectRegistration } from './fixtures/directRegistrationTestEnv.js'

const PASSWORD = 'ProfileCustomizationHttp1!'

let passed = 0
let failed = 0

async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`  PASS  ${label}`)
  } catch (error) {
    failed++
    console.error(`  FAIL  ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))

function getFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') { reject(new Error('no port')); return }
      const port = address.port
      server.close(() => resolvePort(port))
    })
  })
}

async function retryRm(path: string): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt++) {
    try { await rm(path, { recursive: true, force: true }); return } catch { await sleep(300) }
  }
}

const originalServerRoot = resolve(
  process.argv.slice(2).find((arg) => arg.startsWith('--server-root='))?.slice('--server-root='.length) ?? process.cwd(),
)

async function createIsolatedServerRoot() {
  const root = await mkdtemp(join(tmpdir(), 'belot-profile-customization-http-'))
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

function startServer(serverDir: string, port: number, emergencyStop: boolean): RunningServer {
  const chunks: string[] = []
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port), PASSWORD_RESET_RATE_LIMIT_SECRET: TEST_REGISTRATION_SECRET }
  // PROFILE_CUSTOMIZATION_ENABLED е само авариен стоп ('0').
  delete env.PROFILE_CUSTOMIZATION_ENABLED
  if (emergencyStop) env.PROFILE_CUSTOMIZATION_ENABLED = '0'
  const child = spawn(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'index.ts')], {
    cwd: serverDir,
    env,
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

async function waitForServer(port: number, server: RunningServer): Promise<void> {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/rooms`)).status === 200) return
    } catch { /* not yet */ }
    if (server.child.exitCode !== null) break
    await sleep(150)
  }
  console.error(server.output())
  throw new Error('server did not start')
}

let ipCounter = 0
const nextIp = () => `203.0.117.${(ipCounter += 1) % 250}`

type JsonResult = { status: number; body: any; text: string; setCookie: string[] }

async function request(port: number, method: string, pathname: string, body?: unknown, cookie?: string): Promise<JsonResult> {
  const headers: Record<string, string> = { 'X-Forwarded-For': nextIp() }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (cookie) headers['Cookie'] = cookie
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  let parsed: any = null
  try { parsed = JSON.parse(text) } catch { /* not json */ }
  const headersExt = res.headers as Headers & { getSetCookie?: () => string[] }
  return { status: res.status, body: parsed, text, setCookie: headersExt.getSetCookie?.() ?? [] }
}

const cookieOf = (result: JsonResult) => result.setCookie.find((c) => c.startsWith('belot_session='))?.split(';')[0] ?? ''

function withDb<T>(databaseFile: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(databaseFile)
  try {
    db.exec('PRAGMA busy_timeout = 5000;')
    return fn(db)
  } finally {
    db.close()
  }
}

async function registerUser(port: number, databaseFile: string, label: string, role: string): Promise<string> {
  const email = `pcust-${label}-${randomUUID().slice(0, 8)}@example.test`
  const result = await request(port, 'POST', '/api/auth/register', {
    email, password: PASSWORD, displayName: `Pcust${label}${randomUUID().slice(0, 6)}`, gender: 'male', ...prepareDirectRegistration(),
  })
  assert(result.status === 200, `register ${label}: ${result.status} ${result.text}`)
  withDb(databaseFile, (db) => db.prepare('UPDATE accounts SET role = ? WHERE email = ?').run(role, email))
  return login(port, email, label)
}

async function login(port: number, email: string, label: string): Promise<string> {
  const result = await request(port, 'POST', '/api/auth/login', { email, password: PASSWORD, rememberMe: true })
  const cookie = cookieOf(result)
  assert(cookie !== '', `login ${label}: ${result.status} ${result.text}`)
  return cookie
}

const BASE = '/api/admin/profile-customization'

console.log('\ncheckProfileCustomizationAdminHttp')
console.log(`Server root: ${originalServerRoot}`)

const iso = await createIsolatedServerRoot()
let server: RunningServer | null = null

try {
  const port = await getFreePort()
  server = startServer(iso.serverDir, port, false)
  await waitForServer(port, server)
  configureDirectRegistrationForTest(iso.databaseFile)

  const admin = await registerUser(port, iso.databaseFile, 'admin', 'admin')
  const subadmin = await registerUser(port, iso.databaseFile, 'sub', 'subadmin')
  const player = await registerUser(port, iso.databaseFile, 'player', 'player')

  console.log('\n[A] Права (флагът е включен)')

  await check('[A1] Гост, играч и subadmin -> 403 за четене и промени', async () => {
    for (const [label, cookie] of [['гост', undefined], ['играч', player], ['subadmin', subadmin]] as const) {
      const get = await request(port, 'GET', BASE, undefined, cookie)
      assert(get.status === 403, `${label} GET ${get.status}`)
      const patch = await request(port, 'PATCH', `${BASE}/kinds/nickname_color`, { salesEnabled: true }, cookie)
      assert(patch.status === 403, `${label} PATCH ${patch.status}`)
      const post = await request(port, 'POST', `${BASE}/colors`, { hex: '#123456', label: 'X', groupKey: 'blue' }, cookie)
      assert(post.status === 403, `${label} POST ${post.status}`)
    }
    const salesEnabled = withDb(iso.databaseFile, (db) => (db.prepare(`SELECT SUM(sales_enabled) AS s FROM profile_customization_kind_settings;`).get() as { s: number }).s)
    assert(salesEnabled === 0, 'нищо не е променено')
  })

  await check('[A2] Admin -> 200: 4 вида (изключени), 23 цвята с контраст (21 начални + Розов + Оранжев), емоджита, категории, запазен цвят', async () => {
    const result = await request(port, 'GET', BASE, undefined, admin)
    assert(result.status === 200 && result.body?.ok === true, `${result.status} ${result.text.slice(0, 200)}`)
    assert(result.body.kinds.length === 4 && result.body.kinds.every((kind: any) => kind.salesEnabled === false && kind.basePrice30DaysCents === 199), 'видове')
    assert(result.body.colors.length === 23 && result.body.colors.some((color: any) => color.colorId === 'pink-1' && color.hex === '#DC408E' && color.isActive === true) && result.body.colors.some((color: any) => color.colorId === 'orange-4' && color.hex === '#C65A00' && color.isActive === true) && result.body.colors.every((color: any) => typeof color.contrast.onBlack === 'number'), 'цветове')
    assert(result.body.emojis.length >= 500 && result.body.emojis.length <= 700, `емоджита ${result.body.emojis.length}`)
    assert(result.body.emojiCategories.length === 15 && result.body.colorGroups.length === 7, 'категории/групи')
    assert(result.body.reservedStaffColor === '#F72585', 'запазен цвят')
    assert(JSON.stringify(result.body.durations) === '[30,60,90,120,150,180]', 'срокове')
  })

  console.log('\n[B] Цени и продажба')

  await check('[B1] "2.49" -> 249 цента; таблицата 30..180 дни е точна; продажбата се включва', async () => {
    const result = await request(port, 'PATCH', `${BASE}/kinds/nickname_color`, { basePrice30Days: '2.49', salesEnabled: true }, admin)
    assert(result.status === 200, `${result.status} ${result.text}`)
    assert(result.body.settings.basePrice30DaysCents === 249 && result.body.settings.salesEnabled === true, JSON.stringify(result.body.settings))
    assert(result.body.settings.priceTable.map((row: any) => row.priceCents).join(',') === '249,498,747,996,1245,1494', 'таблица')
    const comma = await request(port, 'PATCH', `${BASE}/kinds/emoji_before`, { basePrice30Days: '1,50' }, admin)
    assert(comma.status === 200 && comma.body.settings.basePrice30DaysCents === 150 && comma.body.settings.salesEnabled === false, 'запетая; продажбата не е пипната')
  })

  await check('[B2] Невалидни: 1.999 / 0.49 / число вместо текст / salesEnabled като текст / непознат вид -> 400 без промяна', async () => {
    const cases: Array<[string, unknown, number]> = [
      ['nickname_color', { basePrice30Days: '1.999' }, 400],
      ['nickname_color', { basePrice30Days: '0.49' }, 400],
      ['nickname_color', { basePrice30Days: 2.49 }, 400],
      ['nickname_color', { salesEnabled: 'yes' }, 400],
      ['vip', { salesEnabled: true }, 400],
    ]
    for (const [kind, body, status] of cases) {
      const result = await request(port, 'PATCH', `${BASE}/kinds/${kind}`, body, admin)
      assert(result.status === status, `${kind} ${JSON.stringify(body)} -> ${result.status} ${result.text}`)
    }
    const invalidJson = await fetch(`http://127.0.0.1:${port}${BASE}/kinds/nickname_color`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: admin }, body: '{nope' })
    assert(invalidJson.status === 400, `invalid json ${invalidJson.status}`)
    const price = withDb(iso.databaseFile, (db) => (db.prepare(`SELECT base_price_30_days_cents AS p FROM profile_customization_kind_settings WHERE kind = 'nickname_color';`).get() as { p: number }).p)
    assert(price === 249, `цената остава ${price}`)
  })

  console.log('\n[C] Каталог')

  await check('[C1] Цветове: #F72585 и #FF1493 -> 400 reserved_color; валиден -> 200; дубликат -> 409; невалиден hex -> 400', async () => {
    for (const hex of ['#F72585', '#ff1493']) {
      const result = await request(port, 'POST', `${BASE}/colors`, { hex, label: 'Розово', groupKey: 'red' }, admin)
      assert(result.status === 400 && result.body.code === 'reserved_color', `${hex}: ${result.status} ${result.text}`)
    }
    const added = await request(port, 'POST', `${BASE}/colors`, { hex: '#2a6f97', label: 'Петролено', groupKey: 'blue' }, admin)
    assert(added.status === 200 && added.body.color.hex === '#2A6F97' && added.body.color.isActive === true, `${added.status} ${added.text}`)
    const duplicate = await request(port, 'POST', `${BASE}/colors`, { hex: '#2A6F97', label: 'Пак', groupKey: 'blue' }, admin)
    assert(duplicate.status === 409, `дубликат ${duplicate.status}`)
    const invalid = await request(port, 'POST', `${BASE}/colors`, { hex: 'blue', label: 'X', groupKey: 'blue' }, admin)
    assert(invalid.status === 400 && invalid.body.code === 'invalid_color', `невалиден ${invalid.status}`)
  })

  await check('[C2] Редакция на цвят: скриване и име; hex в тялото се игнорира', async () => {
    const result = await request(port, 'PATCH', `${BASE}/colors/red-1`, { isActive: false, label: 'Бордо', hex: '#000000' }, admin)
    assert(result.status === 200 && result.body.color.isActive === false && result.body.color.label === 'Бордо' && result.body.color.hex === '#E81729', `${result.status} ${result.text}`)
    const missing = await request(port, 'PATCH', `${BASE}/colors/nope`, { isActive: true }, admin)
    assert(missing.status === 404, `липсващ ${missing.status}`)
    const badType = await request(port, 'PATCH', `${BASE}/colors/red-1`, { isActive: 'false' }, admin)
    assert(badType.status === 400, `тип ${badType.status}`)
  })

  await check('[C3] Емоджита: добавяне, отказ за текст/две емоджита, скриване и смяна на категория', async () => {
    const added = await request(port, 'POST', `${BASE}/emojis`, { emoji: '🦴', categoryKey: 'animals' }, admin)
    assert(added.status === 200 && added.body.emoji.emoji === '🦴', `${added.status} ${added.text}`)
    for (const emoji of ['ab', '😀😀', '']) {
      const result = await request(port, 'POST', `${BASE}/emojis`, { emoji, categoryKey: 'smileys' }, admin)
      assert(result.status === 400, `"${emoji}" -> ${result.status}`)
    }
    const duplicate = await request(port, 'POST', `${BASE}/emojis`, { emoji: '🦴', categoryKey: 'animals' }, admin)
    assert(duplicate.status === 409, `дубликат ${duplicate.status}`)
    const hidden = await request(port, 'PATCH', `${BASE}/emojis/emoji-0001`, { isActive: false, categoryKey: 'other' }, admin)
    assert(hidden.status === 200 && hidden.body.emoji.isActive === false && hidden.body.emoji.categoryKey === 'other', `${hidden.status} ${hidden.text}`)
    const badCategory = await request(port, 'PATCH', `${BASE}/emojis/emoji-0001`, { categoryKey: 'nope' }, admin)
    assert(badCategory.status === 400, `категория ${badCategory.status}`)
  })

  console.log('\n[D] Покупки')

  await check('[D1] Списък с покупки: празен; невалиден статус се игнорира; грешен метод -> 405', async () => {
    const list = await request(port, 'GET', `${BASE}/purchases?limit=10&offset=0`, undefined, admin)
    assert(list.status === 200 && list.body.total === 0 && Array.isArray(list.body.rows), `${list.status} ${list.text}`)
    const filtered = await request(port, 'GET', `${BASE}/purchases?status=bogus`, undefined, admin)
    assert(filtered.status === 200, `филтър ${filtered.status}`)
    const wrongMethod = await request(port, 'POST', `${BASE}/purchases`, {}, admin)
    assert(wrongMethod.status === 405, `метод ${wrongMethod.status}`)
  })

  await stopServer(server)
  server = null

  console.log('\n[E] Рестарт с авариен стоп (PROFILE_CUSTOMIZATION_ENABLED=0)')

  const offPort = await getFreePort()
  server = startServer(iso.serverDir, offPort, true)
  await waitForServer(offPort, server)

  await check('[E1] Admin конфигурира и при авариен стоп; режимът е "Само админ"; гост -> 403; checkout -> 503', async () => {
    const email = withDb(iso.databaseFile, (db) => (db.prepare(`SELECT email FROM accounts WHERE role = 'admin' AND email LIKE 'pcust-admin-%' LIMIT 1;`).get() as { email: string }).email)
    const adminOff = await login(offPort, email, 'admin-off')
    const get = await request(offPort, 'GET', BASE, undefined, adminOff)
    assert(get.status === 200 && get.body.access.mode === 'admin_only' && get.body.access.emergencyStop === true && get.body.stripeMode === 'not_configured' && get.body.colors.length === 24, `GET ${get.status} ${get.text.slice(0, 200)}`)
    const patch = await request(offPort, 'PATCH', `${BASE}/kinds/message_color`, { basePrice30Days: '3.00', salesEnabled: true }, adminOff)
    assert(patch.status === 200 && patch.body.settings.basePrice30DaysCents === 300 && patch.body.settings.salesEnabled === true, `PATCH ${patch.status} ${patch.text}`)
    const guest = await request(offPort, 'GET', BASE, undefined, undefined)
    assert(guest.status === 403, `гост ${guest.status}`)
    const user = await request(offPort, 'GET', '/api/profile-customization', undefined, adminOff)
    assert(user.status === 200, `admin: потребителски API ${user.status}`)
    const checkout = await request(offPort, 'POST', '/api/profile-customization/checkout', { kind: 'message_color', itemId: 'red-1', days: 30 }, adminOff)
    assert(checkout.status === 503 && checkout.body.code === 'purchases_halted', `checkout ${checkout.status}`)
  })
} finally {
  if (server !== null) await stopServer(server)
  await iso.cleanup()
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
