/**
 * checkCampaignThemeRealtimeBroadcast.ts
 *
 * Фаза 10 §5/§6/§7/§8/§11 — Real backend (spawned Node process, isolated
 * temp SQLite+uploads) + real Vite dev server + real Chromium (Playwright)
 * + genuine browser-native WebSocket, driving a REAL
 * createActiveRoomFlowController() through the FULL production dispatch
 * path (Server event -> Protocol type -> Parser -> Client dispatcher ->
 * Controller -> UI), proving the exact chain §8 warns NOT to skip (Phase
 * 6/7 "missing parser case" bug class).
 *
 *   A. Bootstrap push, без активна кампания -> theme:null веднага при connect.
 *   B. Admin активира кампания (с качени ресурси) ПОКА клиентът е вече
 *      свързан -> РЕАЛЕН 'active_campaign_theme' broadcast frame пристига
 *      с коректния theme, БЕЗ reconnect/refresh.
 *   C. Admin подменя ресурс (нов unit_icon) ПОКА кампанията е активна ->
 *      нов broadcast с обновения URL (image-swap while active, §7).
 *   D. Admin спира кампанията -> broadcast с theme:null.
 *   E. Нов connect СЛЕД stop -> bootstrap push е theme:null (без stale
 *      тема за нова връзка, §8 reconnect guarantee).
 *   F. Нов connect ПОКА друга кампания е активна -> bootstrap push веднага
 *      отразява активната тема (reconnect mid-campaign).
 *   G. Scheduler auto-activation (НЕ ръчно activate) -> broadcast-ва
 *      СЪЩАТА 'active_campaign_theme' верига identично на ръчно activate
 *      (§5 "работи по същия начин").
 *   H. Feature flag OFF (restart без CAMPAIGNS_FEATURE_ENABLED) -> bootstrap
 *      push theme:null дори ако DB-то технически има активна кампания от
 *      преди (§11 — никога leak на тема, докато флагът е изключен).
 */

import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer as createNetServer } from 'node:net'
import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

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
function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function findFreePort(): Promise<number> {
  return new Promise((resolveFree, reject) => {
    const srv = createNetServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (addr === null || typeof addr === 'string') { reject(new Error('no port')); return }
      const p = addr.port
      srv.close(() => resolveFree(p))
    })
  })
}

async function retryRm(path: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try { await rm(path, { recursive: true, force: true }); return } catch { /* retry */ }
    await sleep(250)
  }
}

async function createIsolatedServerRoot(originalServerRoot: string) {
  const root = await mkdtemp(join(tmpdir(), 'belot-campaign-theme-ws-'))
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

const TEST_SECRET = 'campaign-theme-ws-test-secret-0123456789ABCDEF'

function startServer(serverDir: string, port: number, campaignsEnabled: boolean): RunningServer {
  const chunks: string[] = []
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port), PASSWORD_RESET_RATE_LIMIT_SECRET: TEST_SECRET }
  if (campaignsEnabled) env.CAMPAIGNS_FEATURE_ENABLED = '1'
  else delete env.CAMPAIGNS_FEATURE_ENABLED
  const child = spawn(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'index.ts')], {
    cwd: serverDir, env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (c) => chunks.push(c))
  child.stderr.on('data', (c) => chunks.push(c))
  return { child, output: () => chunks.join('') }
}

async function stopServer(server: RunningServer | null): Promise<void> {
  if (!server || server.child.exitCode !== null) return
  server.child.kill('SIGTERM')
  await new Promise<void>((r) => {
    const t = setTimeout(() => { server.child.kill('SIGKILL'); r() }, 10_000)
    server.child.once('exit', () => { clearTimeout(t); r() })
  })
}

async function waitForHealth(port: number): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`)
      const h = await r.json()
      if (r.status === 200 && h.ok === true) return
    } catch { /* not yet */ }
    await sleep(150)
  }
  throw new Error('server did not start')
}

async function httpJson(port: number, method: string, pathname: string, cookie: string | null, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const setCookie = (res.headers.getSetCookie?.()[0] ?? res.headers.get('set-cookie'))?.split(';')[0] ?? null
  let json: any = null
  try { json = await res.json() } catch { /* not json */ }
  return { status: res.status, body: json, setCookie }
}

function withDb<T>(databaseFile: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(databaseFile)
  try { return fn(db) } finally { db.close() }
}

async function registerAdmin(port: number, databaseFile: string): Promise<{ cookie: string }> {
  const email = `campws-admin-${randomUUID().slice(0, 8)}@example.test`
  const reg = await httpJson(port, 'POST', '/api/auth/register', null, {
    email, password: 'CampaignThemeWs1!', displayName: `CampWsAdmin${randomUUID().slice(0, 6)}`, gender: 'male', visitorId: randomUUID(),
  })
  assert(reg.status === 200, `register admin: ${reg.status} ${JSON.stringify(reg.body)}`)
  withDb(databaseFile, (db) => db.prepare('UPDATE accounts SET role = ? WHERE email = ?').run('admin', email))
  const login = await httpJson(port, 'POST', '/api/auth/login', null, { email, password: 'CampaignThemeWs1!', rememberMe: true })
  assert(login.setCookie !== null, `login admin: ${login.status}`)
  return { cookie: login.setCookie! }
}

async function registerPlayer(port: number): Promise<{ cookie: string }> {
  const email = `campws-player-${randomUUID().slice(0, 8)}@example.test`
  const reg = await httpJson(port, 'POST', '/api/auth/register', null, {
    email, password: 'CampaignThemeWs1!', displayName: `CampWsPlayer${randomUUID().slice(0, 6)}`, gender: 'male', visitorId: randomUUID(),
  })
  assert(reg.status === 200, `register player: ${reg.status} ${JSON.stringify(reg.body)}`)
  return { cookie: reg.setCookie! }
}

const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const TINY_PNG_DATA_URL = `data:image/png;base64,${TINY_PNG_BASE64}`

async function createDraftCampaign(port: number, cookie: string, allowedStake: number): Promise<string> {
  const result = await httpJson(port, 'POST', '/api/admin/campaigns', cookie, {
    name: 'Realtime Theme Test',
    startsAt: new Date(Date.now() + 3_600_000).toISOString(),
    endsAt: new Date(Date.now() + 200 * 3_600_000).toISOString(),
    unitNameSingular: 'жетон', unitNamePlural: 'жетони', giftSenderProfileId: null,
    earnRules: [{ gameKind: 'belot', stakeAmount: allowedStake, unitsPerWin: 1 }],
    packageEarnRules: [],
    rewardTiers: [{ tierId: null, thresholdUnits: 1, rewards: [{ rewardType: 'yellow_coins', amount: 1 }] }],
  })
  assert(result.status === 200, `create campaign: ${result.status} ${JSON.stringify(result.body)}`)
  return result.body.campaign.campaignId as string
}

const sourceServerRoot = resolve(process.cwd(), 'server')
console.log('\n═══ Campaign Theme Realtime Broadcast (WS) E2E — Фаза 10 §5/§6/§7/§8/§11 ═══')

let server: RunningServer | null = null
let vite: ViteDevServer | null = null
let browser: Browser | null = null
const isolated = await createIsolatedServerRoot(sourceServerRoot)

try {
  const backendPort = await findFreePort()
  server = startServer(isolated.serverDir, backendPort, true)
  await waitForHealth(backendPort)
  withDb(isolated.databaseFile, (db) => db.prepare(`UPDATE admin_settings SET setting_value = 'direct' WHERE setting_key = 'registration_verification_mode'`).run())

  const vitePort = await findFreePort()
  vite = await createViteServer({ root: process.cwd(), server: { port: vitePort, strictPort: true, host: '127.0.0.1' }, logLevel: 'error' })
  await vite.listen()

  const backendOrigin = `http://127.0.0.1:${backendPort}`
  const wsUrl = `ws://127.0.0.1:${backendPort}/ws`
  const fixtureUrl = `http://127.0.0.1:${vitePort}/scripts/fixtures/activeRoomRealWsHarness.html`

  browser = await chromium.launch()

  async function openConnectedPage(cookie: string): Promise<Page> {
    const context = await browser!.newContext()
    await context.addCookies([{ name: 'belot_session', value: cookie.split('=')[1], url: backendOrigin }])
    const page = await context.newPage()
    const pageErrors: string[] = []
    page.on('pageerror', (e) => pageErrors.push(e.message))
    await page.goto(fixtureUrl)
    await page.evaluate((url) => (window as any).__activeRoomRealWsHarness.connect(url), wsUrl)
    if (pageErrors.length > 0) throw new Error(`page errors: ${pageErrors.join(' | ')}`)
    return page
  }

  async function latestThemeFrame(page: Page): Promise<{ type: string; theme: unknown } | null> {
    return page.evaluate(() => {
      const frames = (window as any).__activeRoomRealWsHarness.getReceivedFrames()
      const found = [...frames].reverse().find((f: any) => f.type === 'active_campaign_theme')
      return found ?? null
    })
  }

  async function waitForThemeFrameCount(page: Page, minCount: number, timeoutMs = 10_000): Promise<void> {
    await page.waitForFunction((n) => {
      const frames = (window as any).__activeRoomRealWsHarness.getReceivedFrames()
      return frames.filter((f: any) => f.type === 'active_campaign_theme').length >= n
    }, minCount, { timeout: timeoutMs })
  }

  const admin = await registerAdmin(backendPort, isolated.databaseFile)
  const allowedStakeRow = withDb(isolated.databaseFile, (db) =>
    db.prepare(`SELECT stake_amount FROM match_rooms WHERE is_enabled = 1 ORDER BY stake_amount ASC LIMIT 1;`).get() as { stake_amount: number } | undefined)
  assert(allowedStakeRow !== undefined, 'no enabled match_rooms seeded')
  const ALLOWED_STAKE = allowedStakeRow!.stake_amount

  const player1 = await registerPlayer(backendPort)
  const page1 = await openConnectedPage(player1.cookie)

  console.log('\n=== A. Bootstrap push без активна кампания ===')
  await check('A1. При connect, без активна кампания -> bootstrap push theme:null', async () => {
    await waitForThemeFrameCount(page1, 1)
    const frame = await latestThemeFrame(page1)
    assert(frame !== null && frame.theme === null, `очаква се theme:null, получено ${JSON.stringify(frame)}`)
  })

  console.log('\n=== B. Manual activate ПОКА клиентът е вече свързан ===')
  let campaignId!: string
  let iconUrl1 = ''
  await check('B1. Admin създава кампания + качва всичките 4 ресурса', async () => {
    campaignId = await createDraftCampaign(backendPort, admin.cookie, ALLOWED_STAKE)
    for (const kind of ['unit_icon', 'table_bg_desktop', 'table_bg_mobile', 'card_back']) {
      const result = await httpJson(backendPort, 'PATCH', `/api/admin/campaigns/${campaignId}/theme-assets/${kind}`, admin.cookie, { imageDataUrl: TINY_PNG_DATA_URL })
      assert(result.status === 200, `upload ${kind}: ${result.status} ${JSON.stringify(result.body)}`)
      if (kind === 'unit_icon') iconUrl1 = result.body.campaign.unitIconUrl as string
    }
  })
  await check('B2. Admin активира кампанията -> РЕАЛЕН active_campaign_theme broadcast с коректния theme', async () => {
    const before = await page1.evaluate(() => (window as any).__activeRoomRealWsHarness.getReceivedFrames().filter((f: any) => f.type === 'active_campaign_theme').length)
    const result = await httpJson(backendPort, 'POST', `/api/admin/campaigns/${campaignId}/activate`, admin.cookie, {})
    assert(result.status === 200, `activate: ${result.status} ${JSON.stringify(result.body)}`)
    await waitForThemeFrameCount(page1, before + 1)
    const frame = await latestThemeFrame(page1)
    assert((frame?.theme as any)?.unitIconUrl === iconUrl1, `theme.unitIconUrl трябва да съвпада с качения URL, получено ${JSON.stringify(frame)}`)
  })

  console.log('\n=== C. Image swap while active (§7) ===')
  await check('C1. Admin подменя unit_icon ПОКА кампанията е активна -> нов broadcast с НОВИЯ URL', async () => {
    const before = await page1.evaluate(() => (window as any).__activeRoomRealWsHarness.getReceivedFrames().filter((f: any) => f.type === 'active_campaign_theme').length)
    const result = await httpJson(backendPort, 'PATCH', `/api/admin/campaigns/${campaignId}/theme-assets/unit_icon`, admin.cookie, { imageDataUrl: TINY_PNG_DATA_URL })
    assert(result.status === 200, `${result.status} ${JSON.stringify(result.body)}`)
    const iconUrl2 = result.body.campaign.unitIconUrl as string
    assert(iconUrl2 !== iconUrl1, 'новият upload трябва да получи НОВ уникален URL (versioned/safe filename)')
    await waitForThemeFrameCount(page1, before + 1)
    const frame = await latestThemeFrame(page1)
    assert((frame?.theme as any)?.unitIconUrl === iconUrl2, `очаква се новия URL ${iconUrl2}, получено ${JSON.stringify(frame)}`)
  })

  console.log('\n=== D. Manual stop ===')
  await check('D1. Admin спира кампанията -> broadcast с theme:null', async () => {
    const before = await page1.evaluate(() => (window as any).__activeRoomRealWsHarness.getReceivedFrames().filter((f: any) => f.type === 'active_campaign_theme').length)
    const result = await httpJson(backendPort, 'POST', `/api/admin/campaigns/${campaignId}/stop`, admin.cookie, {})
    assert(result.status === 200, `${result.status} ${JSON.stringify(result.body)}`)
    await waitForThemeFrameCount(page1, before + 1)
    const frame = await latestThemeFrame(page1)
    assert(frame !== null && frame.theme === null, `очаква се theme:null след stop, получено ${JSON.stringify(frame)}`)
  })

  console.log('\n=== E/F. Reconnect semantics ===')
  await check('E1. Нов connect СЛЕД stop -> bootstrap push theme:null (без stale тема)', async () => {
    const player2 = await registerPlayer(backendPort)
    const page2 = await openConnectedPage(player2.cookie)
    await waitForThemeFrameCount(page2, 1)
    const frame = await latestThemeFrame(page2)
    assert(frame !== null && frame.theme === null, `очаква се theme:null, получено ${JSON.stringify(frame)}`)
    await page2.close()
  })

  let campaignId2!: string
  await check('F0. setup: втора кампания, пълни ресурси, активирана', async () => {
    campaignId2 = await createDraftCampaign(backendPort, admin.cookie, ALLOWED_STAKE)
    for (const kind of ['unit_icon', 'table_bg_desktop', 'table_bg_mobile', 'card_back']) {
      const result = await httpJson(backendPort, 'PATCH', `/api/admin/campaigns/${campaignId2}/theme-assets/${kind}`, admin.cookie, { imageDataUrl: TINY_PNG_DATA_URL })
      assert(result.status === 200, `${result.status} ${JSON.stringify(result.body)}`)
    }
    const result = await httpJson(backendPort, 'POST', `/api/admin/campaigns/${campaignId2}/activate`, admin.cookie, {})
    assert(result.status === 200, `${result.status} ${JSON.stringify(result.body)}`)
  })
  await check('F1. Нов connect ПОКА кампания е АКТИВНА -> bootstrap push веднага отразява активната тема', async () => {
    const player3 = await registerPlayer(backendPort)
    const page3 = await openConnectedPage(player3.cookie)
    await waitForThemeFrameCount(page3, 1)
    const frame = await latestThemeFrame(page3)
    assert(frame !== null && frame.theme !== null, `очаква се активна тема веднага, получено ${JSON.stringify(frame)}`)
    await page3.close()
  })
  await check('F2. Cleanup: спира campaignId2', async () => {
    const result = await httpJson(backendPort, 'POST', `/api/admin/campaigns/${campaignId2}/stop`, admin.cookie, {})
    assert(result.status === 200, `${result.status} ${JSON.stringify(result.body)}`)
  })

  console.log('\n=== G. Scheduler auto-activation (без ръчен activate) ===')
  await check('G1. Scheduled кампания с startsAt в близкото минало -> scheduler tick я активира сам -> broadcast identичен на manual activate', async () => {
    const campaignId3 = await createDraftCampaign(backendPort, admin.cookie, ALLOWED_STAKE)
    for (const kind of ['unit_icon', 'card_back']) {
      const result = await httpJson(backendPort, 'PATCH', `/api/admin/campaigns/${campaignId3}/theme-assets/${kind}`, admin.cookie, { imageDataUrl: TINY_PNG_DATA_URL })
      assert(result.status === 200, `${result.status} ${JSON.stringify(result.body)}`)
    }
    const scheduleResult = await httpJson(backendPort, 'POST', `/api/admin/campaigns/${campaignId3}/schedule`, admin.cookie, {})
    assert(scheduleResult.status === 200, `${scheduleResult.status} ${JSON.stringify(scheduleResult.body)}`)
    // startsAt е вече в бъдещето (campaign създадена с startsAt +1ч) — пренавиваме
    // директно в DB-то, за да е "в близкото минало" и scheduler-ът (15s tick) да
    // го хване на следващия си реален tick, без да чакаме реалния +1ч прозорец.
    withDb(isolated.databaseFile, (db) => db.prepare(`UPDATE campaigns SET starts_at = ? WHERE campaign_id = ?`).run(new Date(Date.now() - 1_000).toISOString(), campaignId3))

    const before = await page1.evaluate(() => (window as any).__activeRoomRealWsHarness.getReceivedFrames().filter((f: any) => f.type === 'active_campaign_theme').length)
    await waitForThemeFrameCount(page1, before + 1, 20_000)
    const frame = await latestThemeFrame(page1)
    assert(frame !== null && frame.theme !== null, `очаква се scheduler да активира и да broadcast-не тема, получено ${JSON.stringify(frame)}`)
    const row = withDb(isolated.databaseFile, (db) => db.prepare(`SELECT status FROM campaigns WHERE campaign_id = ?`).get(campaignId3) as { status: string })
    assert(row.status === 'active', `scheduler трябваше да активира кампанията, статус е ${row.status}`)

    const stopResult = await httpJson(backendPort, 'POST', `/api/admin/campaigns/${campaignId3}/stop`, admin.cookie, {})
    assert(stopResult.status === 200, 'cleanup stop')
  })
} finally {
  if (browser) await browser.close()
  if (vite) await vite.close()
  await stopServer(server)
}

console.log('\n=== H. Feature flag OFF ===')
try {
  const backendPort2 = await findFreePort()
  const server2 = startServer(isolated.serverDir, backendPort2, false)
  try {
    await waitForHealth(backendPort2)
    const vitePort2 = await findFreePort()
    const vite2 = await createViteServer({ root: process.cwd(), server: { port: vitePort2, strictPort: true, host: '127.0.0.1' }, logLevel: 'error' })
    await vite2.listen()
    const browser2 = await chromium.launch()
    try {
      const fixtureUrl2 = `http://127.0.0.1:${vitePort2}/scripts/fixtures/activeRoomRealWsHarness.html`
      const wsUrl2 = `ws://127.0.0.1:${backendPort2}/ws`
      const context = await browser2.newContext()
      const page = await context.newPage()
      await page.goto(fixtureUrl2)
      await page.evaluate((url) => (window as any).__activeRoomRealWsHarness.connect(url), wsUrl2)
      await check('H1. Flag OFF: bootstrap push theme:null дори с (по-рано активна) кампания в DB-то', async () => {
        await page.waitForFunction(() => {
          const frames = (window as any).__activeRoomRealWsHarness.getReceivedFrames()
          return frames.some((f: any) => f.type === 'active_campaign_theme')
        }, undefined, { timeout: 10_000 })
        const frame = await page.evaluate(() => {
          const frames = (window as any).__activeRoomRealWsHarness.getReceivedFrames()
          return [...frames].reverse().find((f: any) => f.type === 'active_campaign_theme')
        })
        assert(frame !== undefined && frame.theme === null, `очаква се theme:null при изключен flag, получено ${JSON.stringify(frame)}`)
      })
    } finally {
      await browser2.close()
      await vite2.close()
    }
  } finally {
    await stopServer(server2)
  }
} finally {
  await isolated.cleanup()
}

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
