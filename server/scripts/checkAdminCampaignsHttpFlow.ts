/**
 * checkAdminCampaignsHttpFlow.ts
 *
 * Фаза 5 §2 — задължителна проверка на Фаза 4 ("Кампании" admin страница)
 * ПРЕДИ работа по покупките. Пълен E2E през РЕАЛНИЯ spawned HTTP сървър
 * (изолиран temp SQLite), harness по модела на
 * checkAdminAntiBadLuckSettingHttp.ts:
 *
 *   A. Boot с CAMPAIGNS_FEATURE_ENABLED=1.
 *   B. Auth: guest/player/subadmin -> 403 на GET и POST /api/admin/campaigns.
 *   C. Пълен admin: създава кампания (Белот + Ludo earn rules, package earn
 *      rule, reward tier с НЯКОЛКО награди: yellow_coins + vip_days,
 *      съществуващ marketing подател) -> 200, конфигурацията се връща цяла.
 *   D. "Затваря и отваря страницата пак" (нов GET request) -> СЪЩАТА
 *      конфигурация, персистирана коректно.
 *   E. Lifecycle: schedule -> activate -> (saveCampaignConfiguration вече
 *      заключен) -> stop.
 *   F. Restart (симулира "рестарт на сървъра") -> конфигурацията преживява.
 *   G. Feature flag OFF (restart без env var) -> 403 "изключени от feature
 *      flag" дори за пълен admin (GET и POST).
 *   H. Frontend source review (nav button desktop+mobile, attach handlers
 *      wiring) — реален browser automation не е наличен в тая harness,
 *      затова навигацията се верифицира структурно (виж Фаза 4 одита,
 *      тук само reconfirm, не повторна пълна реализация).
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const PASSWORD = 'AdminCampaignsHttp1!'
const TEST_SECRET = 'admin-campaigns-http-test-secret-0123456789'

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
  const root = await mkdtemp(join(tmpdir(), 'belot-admin-campaigns-http-'))
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

function startServer(serverDir: string, port: number, campaignsEnabled: boolean): RunningServer {
  const chunks: string[] = []
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    BELOT_GAME_WORKER_TICK_MODE: 'worker-candidate',
    BELOT_GAME_WORKER_COUNT: '1',
    PASSWORD_RESET_RATE_LIMIT_SECRET: TEST_SECRET,
  }
  if (campaignsEnabled) env.CAMPAIGNS_FEATURE_ENABLED = '1'
  else delete env.CAMPAIGNS_FEATURE_ENABLED
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
const nextIp = () => `203.0.114.${(ipCounter += 1)}`

type JsonResult = { status: number; body: Record<string, unknown> | null; text: string; setCookie: string[] }

async function request(
  port: number,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  pathname: string,
  body?: unknown,
  cookie?: string,
): Promise<JsonResult> {
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

async function registerUser(port: number, databaseFile: string, label: string, role: string): Promise<{ cookie: string; profileId: string }> {
  const email = `camph-${label}-${randomUUID().slice(0, 8)}@example.test`
  const result = await request(port, 'POST', '/api/auth/register', {
    email, password: PASSWORD, displayName: `Camp${label}${randomUUID().slice(0, 6)}`, gender: 'male', visitorId: randomUUID(),
  })
  assert(result.status === 200, `register ${label}: ${result.status} ${result.text}`)
  withDb(databaseFile, (db) => db.prepare('UPDATE accounts SET role = ? WHERE email = ?').run(role, email))
  const login = await request(port, 'POST', '/api/auth/login', { email, password: PASSWORD, rememberMe: true })
  const cookie = cookieOf(login)
  assert(cookie !== '', `login ${label}: ${login.status}`)
  const profileRow = withDb(databaseFile, (db) =>
    db.prepare('SELECT p.profile_id AS id FROM profiles p JOIN accounts a ON a.account_id = p.account_id WHERE a.email = ?').get(email) as { id: string } | undefined)
  assert(profileRow !== undefined, `profile lookup ${label}`)
  return { cookie, profileId: profileRow!.id }
}

const sourceServerRoot = resolve(process.argv.slice(2).find((a) => a.startsWith('--server-root='))?.slice('--server-root='.length) ?? process.cwd())
console.log('\n═══ Admin Campaigns HTTP E2E (Фаза 5 §2 — задължителна Фаза 4 проверка) ═══')

const isolated = await createIsolatedServerRoot(sourceServerRoot)
const port = await getFreePort()
let server = startServer(isolated.serverDir, port, true)

try {
  await waitForServer(port)
  withDb(isolated.databaseFile, (db) => db.prepare(`UPDATE admin_settings SET setting_value = 'direct' WHERE setting_key = 'registration_verification_mode'`).run())

  const admin = await registerUser(port, isolated.databaseFile, 'admin', 'admin')
  const subadmin = await registerUser(port, isolated.databaseFile, 'subadmin', 'subadmin')
  const player = await registerUser(port, isolated.databaseFile, 'player', 'player')
  const marketing = await registerUser(port, isolated.databaseFile, 'marketing', 'marketing')

  const allowedStakeRow = withDb(isolated.databaseFile, (db) =>
    db.prepare(`SELECT stake_amount FROM match_rooms WHERE is_enabled = 1 ORDER BY stake_amount ASC LIMIT 1;`).get() as { stake_amount: number } | undefined)
  assert(allowedStakeRow !== undefined, 'no enabled match_rooms seeded')
  const ALLOWED_STAKE = allowedStakeRow!.stake_amount

  const packageRow = withDb(isolated.databaseFile, (db) =>
    db.prepare(`SELECT package_key FROM coin_packages WHERE status = 'active' ORDER BY sort_order ASC LIMIT 1;`).get() as { package_key: string } | undefined)
  assert(packageRow !== undefined, 'no active coin_packages seeded')
  const PACKAGE_KEY = packageRow!.package_key

  console.log('\n=== B. Auth — само пълен admin вижда/пипа кампаниите ===')
  for (const [label, cookie] of [['guest', undefined], ['player', player.cookie], ['subadmin', subadmin.cookie]] as const) {
    await check(`B. ${label}: GET и POST /api/admin/campaigns -> 403`, async () => {
      const get = await request(port, 'GET', '/api/admin/campaigns', undefined, cookie)
      const post = await request(port, 'POST', '/api/admin/campaigns', { name: 'x' }, cookie)
      assert(get.status === 403, `GET ${get.status} ${get.text}`)
      assert(post.status === 403, `POST ${post.status} ${post.text}`)
    })
  }

  console.log('\n=== C. Пълен admin: създаване на кампания с пълна конфигурация ===')
  let campaignId!: string
  await check('C1. POST /api/admin/campaigns (Белот+Ludo rules, package rule, tier с НЯКОЛКО награди, marketing подател) -> 200', async () => {
    const result = await request(port, 'POST', '/api/admin/campaigns', {
      name: 'Хелоуин 2026',
      startsAt: new Date(Date.now() + 3_600_000).toISOString(),
      endsAt: new Date(Date.now() + 200 * 3_600_000).toISOString(),
      unitNameSingular: 'тиква',
      unitNamePlural: 'тикви',
      giftSenderProfileId: marketing.profileId,
      earnRules: [
        { gameKind: 'belot', stakeAmount: ALLOWED_STAKE, unitsPerWin: 10 },
        { gameKind: 'ludo', stakeAmount: ALLOWED_STAKE, unitsPerWin: 15 },
      ],
      packageEarnRules: [{ packageKey: PACKAGE_KEY, unitsPerPurchase: 50 }],
      rewardTiers: [{
        tierId: null,
        thresholdUnits: 100,
        rewards: [{ rewardType: 'yellow_coins', amount: 5000 }, { rewardType: 'vip_days', days: 3 }],
      }],
    }, admin.cookie)
    assert(result.status === 200, `${result.status} ${result.text}`)
    const campaign = result.body?.campaign as Record<string, unknown> | undefined
    assert(campaign !== undefined && campaign.status === 'draft', 'очаква се draft кампания в response-а')
    campaignId = campaign!.campaignId as string
  })

  console.log('\n=== D. "Затваря и отваря страницата" — нов GET връща СЪЩАТА конфигурация ===')
  await check('D1. GET /api/admin/campaigns (нов request) показва пълната запазена конфигурация', async () => {
    const result = await request(port, 'GET', '/api/admin/campaigns', undefined, admin.cookie)
    assert(result.status === 200, `${result.status} ${result.text}`)
    const campaigns = result.body?.campaigns as Array<Record<string, unknown>> | undefined
    const row = campaigns?.find((c) => c.campaignId === campaignId)
    assert(row !== undefined, 'кампанията трябва да е в списъка')
    const earnRules = row!.earnRules as Array<Record<string, unknown>>
    const packageEarnRules = row!.packageEarnRules as Array<Record<string, unknown>>
    const rewardTiers = row!.rewardTiers as Array<Record<string, unknown>>
    assert(earnRules.length === 2, `earnRules трябва да са 2, получени ${earnRules.length}`)
    assert(earnRules.some((r) => r.gameKind === 'belot' && r.unitsPerWin === 10), 'belot rule')
    assert(earnRules.some((r) => r.gameKind === 'ludo' && r.unitsPerWin === 15), 'ludo rule')
    assert(packageEarnRules.length === 1 && packageEarnRules[0]!.packageKey === PACKAGE_KEY && packageEarnRules[0]!.unitsPerPurchase === 50, 'package rule')
    assert(rewardTiers.length === 1 && rewardTiers[0]!.thresholdUnits === 100, 'reward tier')
    const rewards = rewardTiers[0]!.rewards as Array<Record<string, unknown>>
    assert(rewards.length === 2, `очакват се 2 награди в прага, получени ${rewards.length}`)
    assert(rewards.some((r) => r.rewardType === 'yellow_coins' && r.amount === 5000), 'yellow_coins награда')
    assert(rewards.some((r) => r.rewardType === 'vip_days' && r.days === 3), 'vip_days награда')
    assert(row!.giftSenderProfileId === marketing.profileId, 'marketing подателят трябва да е запазен')
  })

  console.log('\n=== E. Lifecycle: schedule -> activate -> заключване -> stop ===')
  await check('E1. POST .../schedule -> status=scheduled', async () => {
    const result = await request(port, 'POST', `/api/admin/campaigns/${campaignId}/schedule`, {}, admin.cookie)
    assert(result.status === 200, `${result.status} ${result.text}`)
    const campaign = result.body?.campaign as Record<string, unknown> | undefined
    assert(campaign?.status === 'scheduled', `очаква се scheduled, получено ${JSON.stringify(campaign)}`)
  })

  await check('E2. POST .../activate -> status=active', async () => {
    const result = await request(port, 'POST', `/api/admin/campaigns/${campaignId}/activate`, {}, admin.cookie)
    assert(result.status === 200, `${result.status} ${result.text}`)
    const campaign = result.body?.campaign as Record<string, unknown> | undefined
    assert(campaign?.status === 'active', `очаква се active, получено ${JSON.stringify(campaign)}`)
  })

  await check('E3. PUT /api/admin/campaigns/{id} на active кампания -> 400 not_editable', async () => {
    const result = await request(port, 'PUT', `/api/admin/campaigns/${campaignId}`, {
      name: 'Should Not Change',
      startsAt: new Date(Date.now() + 3_600_000).toISOString(),
      endsAt: new Date(Date.now() + 200 * 3_600_000).toISOString(),
      unitNameSingular: 'тиква',
      unitNamePlural: 'тикви',
      giftSenderProfileId: marketing.profileId,
      earnRules: [{ gameKind: 'belot', stakeAmount: ALLOWED_STAKE, unitsPerWin: 999 }],
      packageEarnRules: [],
      rewardTiers: [{ tierId: null, thresholdUnits: 1, rewards: [{ rewardType: 'yellow_coins', amount: 1 }] }],
    }, admin.cookie)
    assert(result.status === 400 && result.body?.reason === 'not_editable', `${result.status} ${result.text}`)
  })

  await check('E4. POST .../stop -> status=stopped', async () => {
    const result = await request(port, 'POST', `/api/admin/campaigns/${campaignId}/stop`, {}, admin.cookie)
    assert(result.status === 200, `${result.status} ${result.text}`)
    const campaign = result.body?.campaign as Record<string, unknown> | undefined
    assert(campaign?.status === 'stopped', `очаква се stopped, получено ${JSON.stringify(campaign)}`)
  })

  console.log('\n=== F. Restart ("затваря и отваря страницата" след сървърен restart) ===')
  await stopServer(server)
  server = startServer(isolated.serverDir, port, true)
  await waitForServer(port)
  await check('F1. След restart: GET показва СЪЩАТА конфигурация, статус остава stopped', async () => {
    const result = await request(port, 'GET', '/api/admin/campaigns', undefined, admin.cookie)
    assert(result.status === 200, `${result.status} ${result.text}`)
    const campaigns = result.body?.campaigns as Array<Record<string, unknown>> | undefined
    const row = campaigns?.find((c) => c.campaignId === campaignId)
    assert(row !== undefined && row.status === 'stopped', `очаква се stopped, получено ${JSON.stringify(row)}`)
    const rewardTiers = row!.rewardTiers as Array<Record<string, unknown>>
    assert(rewardTiers.length === 1 && (rewardTiers[0]!.rewards as unknown[]).length === 2, 'конфигурацията трябва да преживее restart')
  })

  console.log('\n=== G. Feature flag OFF ===')
  await stopServer(server)
  server = startServer(isolated.serverDir, port, false)
  await waitForServer(port)
  await check('G1. Flag OFF: GET /api/admin/campaigns -> 403 "изключени от feature flag", дори за пълен admin', async () => {
    const result = await request(port, 'GET', '/api/admin/campaigns', undefined, admin.cookie)
    assert(result.status === 403, `${result.status} ${result.text}`)
    assert(/feature flag/i.test(result.text), `очаква се съобщение за feature flag, получено ${result.text}`)
  })
  await check('G2. Flag OFF: POST /api/admin/campaigns -> 403, никаква DB промяна', async () => {
    const result = await request(port, 'POST', '/api/admin/campaigns', {
      name: 'Should Not Be Created',
      startsAt: new Date(Date.now() + 3_600_000).toISOString(),
      endsAt: new Date(Date.now() + 200 * 3_600_000).toISOString(),
      unitNameSingular: 'x', unitNamePlural: 'x', giftSenderProfileId: null,
      earnRules: [{ gameKind: 'belot', stakeAmount: ALLOWED_STAKE, unitsPerWin: 1 }],
      packageEarnRules: [], rewardTiers: [{ tierId: null, thresholdUnits: 1, rewards: [{ rewardType: 'yellow_coins', amount: 1 }] }],
    }, admin.cookie)
    assert(result.status === 403, `${result.status} ${result.text}`)
    const countRow = withDb(isolated.databaseFile, (db) => db.prepare(`SELECT COUNT(*) AS c FROM campaigns WHERE name = 'Should Not Be Created';`).get() as { c: number })
    assert(countRow.c === 0, 'не бива да е създадена кампания, докато флагът е изключен')
  })
  await check('G3. Flag OFF: нормалните заявки (/api/rooms) продължават да работят нормално', async () => {
    const result = await request(port, 'GET', '/api/rooms', undefined, player.cookie)
    assert(result.status === 200, `${result.status} ${result.text}`)
  })

  console.log('\n=== H. Frontend (source review — nav wiring desktop+mobile) ===')
  await check('H1. Desktop admin dropdown съдържа "Кампании" бутон, гейтнат зад state.isAdmin', () => {
    const lobby = readFileSync(join(sourceServerRoot, '..', 'src', 'app', 'lobby', 'renderLobbyScreen.ts'), 'utf8')
    assert(lobby.includes('data-lobby-nav-admin-campaigns="1"'), 'desktop/mobile nav button data attribute')
    assert(/\$\{state\.isAdmin \? `[\s\S]{0,400}data-lobby-nav-admin-campaigns="1"/.test(lobby), 'бутонът трябва да е вътре в state.isAdmin гейтнатия блок')
  })
  await check('H2. attachAdminCampaignsHandlers се извиква, click listener за nav бутона съществува', () => {
    const lobby = readFileSync(join(sourceServerRoot, '..', 'src', 'app', 'lobby', 'renderLobbyScreen.ts'), 'utf8')
    assert(lobby.includes('attachAdminCampaignsHandlers(root, state,'), 'attach call')
    assert(/data-lobby-nav-admin-campaigns="1"\]'\)\s*\n\s*\?\.addEventListener\('click'/.test(lobby), 'nav button click listener')
  })
  await check('H3. Controller (createLobbyFlowController.ts) има реална fetch-wiring за кампаниите (не само типове)', () => {
    const controller = readFileSync(join(sourceServerRoot, '..', 'src', 'app', 'lobby', 'createLobbyFlowController.ts'), 'utf8')
    assert(controller.includes('function showAdminCampaignsPanel'), 'showAdminCampaignsPanel')
    assert(controller.includes('function fetchAdminCampaigns'), 'fetchAdminCampaigns')
    assert(controller.includes("'/admin/campaigns'"), 'URL routing')
  })
  await check('H4. main.ts прави реални HTTP заявки към /api/admin/campaigns', () => {
    const main = readFileSync(join(sourceServerRoot, '..', 'src', 'main.ts'), 'utf8')
    assert(main.includes('/api/admin/campaigns'), 'fetch към реалния endpoint')
    assert(main.includes('async function loadAdminCampaigns'), 'loadAdminCampaigns')
  })
} finally {
  await stopServer(server)
  await isolated.cleanup()
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
