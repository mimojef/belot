/**
 * checkBelotVisualCampaignIsolation.ts
 *
 * "Визия на Белот" × активна Хелоуин кампания — реален изолиран сървър.
 * Тиквите се начисляват през истинския campaignCreditStore (игра, загуба,
 * покупка на пакет, награди по прагове) върху базата на сървъра.
 *
 *  S. Начално състояние: тикви, награда за праг 5, иконка, бонус за пакет, класация.
 *  V. Само действия по ръчната визия (3× вкл/изкл, качване, замяна, премахване)
 *     → всички campaign* таблици байт-идентични; кампанията (период, статус,
 *     единици, иконка, изображения, правила, награди), темата (иконка/бонуси),
 *     класацията и профилният прогрес са непроменени; файловете ѝ се сервират.
 *  C. При включена ръчна визия събирането продължава: игра + пакет → тикви,
 *     награда за праг 25, обновена класация и профил.
 *  D. Изключване → кампанийните изображения се връщат автоматично (broadcast
 *     и нова връзка); ръчните остават запазени; кампанията е непроменена.
 */

import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, stat, readdir, writeFile } from 'node:fs/promises'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import sharp from 'sharp'
import WebSocket from 'ws'
import { createCampaignCreditStore } from '../src/campaigns/campaignCreditStore.js'

const PASSWORD = 'BelotVisualCampaignIso1!'
const TEST_SECRET = 'belot-visual-campaign-isolation-secret-0123456789'

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
  for (let attempt = 0; attempt < 4; attempt++) {
    try { await rm(path, { recursive: true, force: true }); return } catch { await sleep(250) }
  }
}

async function createIsolatedServerRoot(originalServerRoot: string) {
  const root = await mkdtemp(join(tmpdir(), 'belot-visual-campaign-isolation-'))
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
    uploadsRoot: join(serverDir, 'uploads'),
    cleanup: () => retryRm(root),
  }
}

type RunningServer = { child: ChildProcessWithoutNullStreams; output(): string }

function startServer(serverDir: string, port: number): RunningServer {
  const chunks: string[] = []
  const child = spawn(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'index.ts')], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(port),
      CAMPAIGNS_FEATURE_ENABLED: '1',
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

async function waitForServer(port: number, server: RunningServer): Promise<void> {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/rooms`)).status === 200) return
    } catch { /* not yet */ }
    await sleep(150)
  }
  console.error(server.output())
  throw new Error('server did not start')
}

let ipCounter = 0
const nextIp = () => `203.0.116.${(ipCounter += 1) % 250}`

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
  try { return fn(db) } finally { db.close() }
}

async function registerUser(port: number, databaseFile: string, label: string, role: string): Promise<string> {
  const email = `belotvis-${label}-${randomUUID().slice(0, 8)}@example.test`
  const result = await request(port, 'POST', '/api/auth/register', {
    email, password: PASSWORD, displayName: `BelotVis${label}${randomUUID().slice(0, 6)}`, gender: 'male', visitorId: randomUUID(),
  })
  assert(result.status === 200, `register ${label}: ${result.status} ${result.text}`)
  withDb(databaseFile, (db) => db.prepare('UPDATE accounts SET role = ? WHERE email = ?').run(role, email))
  const login = await request(port, 'POST', '/api/auth/login', { email, password: PASSWORD, rememberMe: true })
  const cookie = cookieOf(login)
  assert(cookie !== '', `login ${label}: ${login.status}`)
  return cookie
}

async function fileExists(filePath: string): Promise<boolean> {
  try { await stat(filePath); return true } catch { return false }
}

async function pngDataUrl(width: number, height: number, color: string): Promise<string> {
  const buffer = await sharp({ create: { width, height, channels: 4, background: color } }).png().toBuffer()
  return `data:image/png;base64,${buffer.toString('base64')}`
}

// Първият active_campaign_theme кадър на нова (гост) WS връзка = bootstrap.
async function readBootstrapVisual(port: number): Promise<any> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  try {
    return await new Promise<any>((resolveFrame, reject) => {
      const timer = setTimeout(() => reject(new Error('no active_campaign_theme frame')), 10_000)
      ws.on('message', (data) => {
        try {
          const frame = JSON.parse(data.toString())
          if (frame.type === 'active_campaign_theme') { clearTimeout(timer); resolveFrame(frame) }
        } catch { /* ignore */ }
      })
      ws.once('error', reject)
    })
  } finally {
    ws.close()
  }
}

type Listener = { ws: WebSocket; frames: any[] }
async function openListener(port: number): Promise<Listener> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  const frames: any[] = []
  ws.on('message', (data) => { try { frames.push(JSON.parse(data.toString())) } catch { /* ignore */ } })
  await new Promise<void>((done, reject) => { ws.once('open', () => done()); ws.once('error', reject) })
  return { ws, frames }
}


async function profileIdOf(databaseFile: string, cookie: string): Promise<string> {
  void databaseFile
  const res = await fetch(`http://127.0.0.1:${currentPort}/api/auth/me`, { headers: { Cookie: cookie } })
  const body = await res.json().catch(() => null) as any
  const id = body?.session?.profile?.profileId
  if (typeof id !== 'string') throw new Error(`no session profile: ${JSON.stringify(body)}`)
  return id
}

// Пълно съдържание на всички кампанийни таблици (без "Визия на Белот").
function campaignTablesDump(databaseFile: string): Record<string, string> {
  return withDb(databaseFile, (db) => {
    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'campaign%' ORDER BY name`).all() as Array<{ name: string }>).map((r) => r.name)
    const dump: Record<string, string> = {}
    for (const table of tables) {
      dump[table] = JSON.stringify(db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all())
    }
    return dump
  })
}

function campaignView(row: any) {
  return {
    name: row.name,
    status: row.status,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    unitNameSingular: row.unitNameSingular,
    unitNamePlural: row.unitNamePlural,
    unitIconUrl: row.unitIconUrl,
    tableBgDesktopUrl: row.tableBgDesktopUrl,
    tableBgMobileUrl: row.tableBgMobileUrl,
    cardBackUrl: row.cardBackUrl,
    earnRules: row.earnRules,
    packageEarnRules: row.packageEarnRules,
    rewardTiers: row.rewardTiers,
    archivedAt: row.archivedAt,
    deletedAt: row.deletedAt,
  }
}

let currentPort = 0

async function waitForBroadcast(listener: Listener, predicate: (frame: any) => boolean, label: string): Promise<any> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const frame = listener.frames.find((f) => f.type === 'active_campaign_theme' && predicate(f))
    if (frame) return frame
    await sleep(50)
  }
  throw new Error(`no broadcast: ${label}`)
}

const sourceServerRoot = resolve(process.argv.slice(2).find((a) => a.startsWith('--server-root='))?.slice('--server-root='.length) ?? process.cwd())
console.log('\n═══ Визия на Белот × активна Хелоуин кампания — интеграция ═══')

const isolated = await createIsolatedServerRoot(sourceServerRoot)
const port = await getFreePort()
currentPort = port
const server = startServer(isolated.serverDir, port)
let creditStore: Awaited<ReturnType<typeof createCampaignCreditStore>> | null = null

try {
  await waitForServer(port, server)
  withDb(isolated.databaseFile, (db) => db.prepare(`UPDATE admin_settings SET setting_value = 'direct' WHERE setting_key = 'registration_verification_mode'`).run())

  const admin = await registerUser(port, isolated.databaseFile, 'admin', 'admin')
  const players = await Promise.all(['p1', 'p2', 'p3'].map((label) => registerUser(port, isolated.databaseFile, label, 'player')))
  const [p1, p2, p3] = await Promise.all(players.map(async (cookie) => ({ cookie, profileId: await profileIdOf(isolated.databaseFile, cookie) })))

  // ─── Хелоуин кампания ─────────────────────────────────────────────────────
  const snapshot = await request(port, 'GET', '/api/admin/campaigns', undefined, admin)
  const packageKey = snapshot.body.referenceData.purchasePackages[0]?.packageKey as string
  const stake = snapshot.body.referenceData.allowedStakes.belot[0] as number
  assert(typeof packageKey === 'string' && typeof stake === 'number', `reference data: ${snapshot.text.slice(0, 300)}`)

  const created = await request(port, 'POST', '/api/admin/campaigns', {
    name: 'Хелоуин 2026',
    startsAt: new Date(Date.now() + 3_600_000).toISOString(),
    endsAt: new Date(Date.now() + 10 * 24 * 3_600_000).toISOString(),
    unitNameSingular: 'тиква',
    unitNamePlural: 'тикви',
    giftSenderProfileId: null,
    earnRules: [{ gameKind: 'belot', stakeAmount: stake, unitsPerWin: 3, creditMode: 'winner_only' }],
    packageEarnRules: [{ packageKey, unitsPerPurchase: 20 }],
    rewardTiers: [
      { tierId: null, thresholdUnits: 5, rewards: [{ rewardType: 'yellow_coins', amount: 1000 }] },
      { tierId: null, thresholdUnits: 25, rewards: [{ rewardType: 'vip_days', days: 3 }] },
    ],
  }, admin)
  assert(created.status === 200, `campaign create: ${created.text}`)
  const campaignId = created.body.campaign.campaignId as string
  const icon = await request(port, 'PATCH', `/api/admin/campaigns/${campaignId}/theme-assets/unit_icon`, { imageDataUrl: await pngDataUrl(256, 256, '#ff7518') }, admin)
  const campDesk = await request(port, 'PATCH', `/api/admin/campaigns/${campaignId}/theme-assets/table_bg_desktop`, { imageDataUrl: await pngDataUrl(1600, 900, '#3b1f00') }, admin)
  const campMob = await request(port, 'PATCH', `/api/admin/campaigns/${campaignId}/theme-assets/table_bg_mobile`, { imageDataUrl: await pngDataUrl(900, 1600, '#3b1f00') }, admin)
  const campBack = await request(port, 'PATCH', `/api/admin/campaigns/${campaignId}/theme-assets/card_back`, { imageDataUrl: await pngDataUrl(300, 420, '#ff7518') }, admin)
  const activated = await request(port, 'POST', `/api/admin/campaigns/${campaignId}/activate`, {}, admin)
  assert([icon, campDesk, campMob, campBack, activated].every((r) => r.status === 200), `campaign setup: ${activated.text}`)
  const campaignImages = {
    tableBgDesktopUrl: campDesk.body.campaign.tableBgDesktopUrl as string,
    tableBgMobileUrl: campMob.body.campaign.tableBgMobileUrl as string,
    cardBackUrl: campBack.body.campaign.cardBackUrl as string,
  }
  const iconUrl = icon.body.campaign.unitIconUrl as string

  // Събитията са вътре в периода на кампанията (активирането пази зададения
  // startsAt +1ч; начисляването проверява startsAt <= eventAt < endsAt).
  const inCampaignPeriod = () => new Date(Date.parse(created.body.campaign.startsAt) + 60_000)

  // Тиквите се начисляват през истинския campaignCreditStore (същия код като
  // campaignGameHooks/campaignPurchaseHooks), върху базата на сървъра.
  creditStore = await createCampaignCreditStore(isolated.databaseFile)
  const winBelot = (profileId: string) => creditStore!.creditCampaignUnits({
    profileId, sourceType: 'belot_win', sourceId: `room-${randomUUID()}:v1`, eventAt: inCampaignPeriod(), stakeAmount: stake, didWin: true,
  })
  const loseBelot = (profileId: string) => creditStore!.creditCampaignUnits({
    profileId, sourceType: 'belot_win', sourceId: `room-${randomUUID()}:v1`, eventAt: inCampaignPeriod(), stakeAmount: stake, didWin: false,
  })
  const buyPackage = (profileId: string) => creditStore!.creditCampaignUnits({
    profileId, sourceType: 'package_purchase', sourceId: `purchase-${randomUUID()}`, eventAt: inCampaignPeriod(), packageKey,
  })

  console.log('\n=== Начално състояние на кампанията ===')
  await check('S1. тиквите се събират и броят (игри, пакет, загуба = 0) и първата награда се дава', () => {
    const a = winBelot(p1.profileId)
    const b = winBelot(p1.profileId)
    const c = winBelot(p2.profileId)
    const d = loseBelot(p3.profileId)
    assert(a.ok && a.unitsCredited === 3 && b.ok && b.unitsTotal === 6 && c.ok && c.unitsTotal === 3, JSON.stringify([a, b, c]))
    assert(!d.ok || d.unitsCredited === 0, `loss credited: ${JSON.stringify(d)}`)
    assert(b.ok && b.grantedRewards.some((r) => r.type === 'yellow_coins' && r.amount === 1000), `tier 5 reward: ${JSON.stringify(b)}`)
  })

  const campaignBefore = campaignView((await request(port, 'GET', '/api/admin/campaigns', undefined, admin)).body.campaigns.find((c: any) => c.campaignId === campaignId))
  const top10Before = (await request(port, 'GET', `/api/admin/campaigns/${campaignId}/live-top10`, undefined, admin)).body.top10
  const summaryBefore = (await request(port, 'GET', `/api/profiles/${p1.profileId}/campaign-summary`, undefined, p1.cookie)).body
  const themeBefore = (await readBootstrapVisual(port)).theme
  const tablesBefore = campaignTablesDump(isolated.databaseFile)

  await check('S2. кампанията е активна, с иконка, бонус за пакета и правилен период', () => {
    assert(campaignBefore.status === 'active', campaignBefore.status)
    assert(themeBefore.unitIconUrl === iconUrl && themeBefore.packageUnits[packageKey] === 20, JSON.stringify(themeBefore))
    assert(top10Before.length === 2 && top10Before[0].profileId === p1.profileId && top10Before[0].unitsTotal === 6, JSON.stringify(top10Before))
  })

  // ─── Само "Визия на Белот" действия ──────────────────────────────────────
  console.log('\n=== Включване/изключване и смяна на ръчните изображения ===')
  const listener = await openListener(port)
  const manual: Record<string, string> = {}
  for (const [kind, w, h, color] of [['table_bg_desktop', 1600, 900, '#004400'], ['table_bg_mobile', 900, 1600, '#004400'], ['card_back', 300, 420, '#000066']] as const) {
    const res = await request(port, 'PATCH', `/api/admin/belot-visual/assets/${kind}`, { imageDataUrl: await pngDataUrl(w, h, color) }, admin)
    assert(res.status === 200, res.text)
    manual[kind] = kind === 'table_bg_desktop' ? res.body.visual.tableBgDesktopUrl : kind === 'table_bg_mobile' ? res.body.visual.tableBgMobileUrl : res.body.visual.cardBackUrl
  }
  for (let i = 0; i < 3; i++) {
    assert((await request(port, 'PATCH', '/api/admin/belot-visual', { enabled: true }, admin)).status === 200, 'enable')
    await waitForBroadcast(listener, (f) => f.belotVisual.tableBgDesktopUrl === manual.table_bg_desktop, `enable #${i}`)
    listener.frames.length = 0
    assert((await request(port, 'PATCH', '/api/admin/belot-visual', { enabled: false }, admin)).status === 200, 'disable')
    await waitForBroadcast(listener, (f) => f.belotVisual.tableBgDesktopUrl === campaignImages.tableBgDesktopUrl, `disable #${i}`)
    listener.frames.length = 0
  }
  const replaced = await request(port, 'PATCH', '/api/admin/belot-visual/assets/table_bg_desktop', { imageDataUrl: await pngDataUrl(1600, 900, '#006600') }, admin)
  const removed = await request(port, 'PATCH', '/api/admin/belot-visual/assets/card_back', { imageDataUrl: null }, admin)
  assert(replaced.status === 200 && removed.status === 200, 'replace/remove')
  manual.table_bg_desktop = replaced.body.visual.tableBgDesktopUrl
  await request(port, 'PATCH', '/api/admin/belot-visual', { enabled: true }, admin)
  await waitForBroadcast(listener, (f) => f.belotVisual.tableBgDesktopUrl === manual.table_bg_desktop, 'enabled after replace')

  await check('V1. всички кампанийни таблици (кампания, правила, награди, тикви, класация, известия, събития) са байт-идентични', () => {
    const after = campaignTablesDump(isolated.databaseFile)
    assert(JSON.stringify(Object.keys(after)) === JSON.stringify(Object.keys(tablesBefore)), 'table set changed')
    for (const table of Object.keys(tablesBefore)) assert(after[table] === tablesBefore[table], `${table} changed`)
  })
  await check('V2. кампанията (име, статус, период, единици, иконка, изображения, правила, награди) е непроменена', async () => {
    const now = campaignView((await request(port, 'GET', '/api/admin/campaigns', undefined, admin)).body.campaigns.find((c: any) => c.campaignId === campaignId))
    assert(JSON.stringify(now) === JSON.stringify(campaignBefore), `${JSON.stringify(now)}\n!==\n${JSON.stringify(campaignBefore)}`)
  })
  await check('V3. иконката и бонусът за пакет в темата са непроменени при включена ръчна визия', async () => {
    const frame = await readBootstrapVisual(port)
    assert(JSON.stringify(frame.theme) === JSON.stringify(themeBefore), JSON.stringify(frame.theme))
    assert(frame.belotVisual.tableBgDesktopUrl === manual.table_bg_desktop && frame.belotVisual.tableBgMobileUrl === manual.table_bg_mobile, 'manual not applied')
    assert(frame.belotVisual.cardBackUrl === campaignImages.cardBackUrl, 'removed manual card back must fall back to the campaign')
  })
  await check('V4. класацията и профилният прогрес са непроменени', async () => {
    const top10 = (await request(port, 'GET', `/api/admin/campaigns/${campaignId}/live-top10`, undefined, admin)).body.top10
    const summary = (await request(port, 'GET', `/api/profiles/${p1.profileId}/campaign-summary`, undefined, p1.cookie)).body
    assert(JSON.stringify(top10) === JSON.stringify(top10Before), JSON.stringify(top10))
    assert(JSON.stringify(summary) === JSON.stringify(summaryBefore), JSON.stringify(summary).slice(0, 300))
  })
  await check('V5. кампанийните файлове са непокътнати и се сервират', async () => {
    for (const url of [iconUrl, ...Object.values(campaignImages)]) {
      const res = await fetch(`http://127.0.0.1:${port}${url}`)
      assert(res.status === 200, `${url} → ${res.status}`)
    }
  })

  // ─── Кампанията продължава да работи, докато ръчната визия е включена ───
  console.log('\n=== Събиране на тикви при включена ръчна визия ===')
  await check('C1. игра и покупка на пакет добавят тикви; втората награда се дава; класацията се обновява', async () => {
    const win = winBelot(p3.profileId)
    const purchase = buyPackage(p1.profileId)
    assert(win.ok && win.unitsTotal === 3, JSON.stringify(win))
    assert(purchase.ok && purchase.unitsCredited === 20 && purchase.unitsTotal === 26, JSON.stringify(purchase))
    assert(purchase.ok && purchase.grantedRewards.some((r) => r.type === 'vip_days'), `tier 25 reward: ${JSON.stringify(purchase)}`)
    const top10 = (await request(port, 'GET', `/api/admin/campaigns/${campaignId}/live-top10`, undefined, admin)).body.top10 as Array<{ profileId: string; unitsTotal: number }>
    const totals = Object.fromEntries(top10.map((e) => [e.profileId, e.unitsTotal]))
    assert(totals[p1.profileId] === 26 && totals[p2.profileId] === 3 && totals[p3.profileId] === 3, JSON.stringify(top10))
    assert(top10[0]!.profileId === p1.profileId, 'p1 not first')
  })
  await check('C2. профилният прогрес на p1 показва 26 тикви', async () => {
    const summary = (await request(port, 'GET', `/api/profiles/${p1.profileId}/campaign-summary`, undefined, p1.cookie)).body
    const active = summary.summary?.active ?? summary.active
    assert(active?.campaignId === campaignId && active.unitsTotal === 26 && active.unitNamePlural === 'тикви' && active.unitIconUrl === iconUrl, JSON.stringify(summary).slice(0, 400))
  })

  // ─── Изключване → кампанийните изображения се връщат автоматично ─────────
  console.log('\n=== Изключване на ръчната визия ===')
  await check('D1. изключване → broadcast веднага с всички кампанийни изображения; иконка/бонуси непроменени', async () => {
    listener.frames.length = 0
    await request(port, 'PATCH', '/api/admin/belot-visual', { enabled: false }, admin)
    const frame = await waitForBroadcast(listener, () => true, 'disable')
    assert(JSON.stringify(frame.belotVisual) === JSON.stringify(campaignImages), JSON.stringify(frame.belotVisual))
    assert(JSON.stringify(frame.theme) === JSON.stringify(themeBefore), JSON.stringify(frame.theme))
  })
  await check('D2. нова връзка (refresh/reconnect) също получава кампанийните изображения', async () => {
    const frame = await readBootstrapVisual(port)
    assert(JSON.stringify(frame.belotVisual) === JSON.stringify(campaignImages), JSON.stringify(frame.belotVisual))
  })
  await check('D3. ръчните изображения са запазени за следващо включване', async () => {
    const res = await request(port, 'GET', '/api/admin/belot-visual', undefined, admin)
    assert(res.body.visual.enabled === false && res.body.visual.tableBgDesktopUrl === manual.table_bg_desktop && res.body.visual.tableBgMobileUrl === manual.table_bg_mobile, res.text)
  })
  await check('D4. кампанията е непроменена и след изключването (период, статус, правила, награди)', async () => {
    const now = campaignView((await request(port, 'GET', '/api/admin/campaigns', undefined, admin)).body.campaigns.find((c: any) => c.campaignId === campaignId))
    assert(JSON.stringify(now) === JSON.stringify(campaignBefore), JSON.stringify(now))
  })
  listener.ws.close()
} finally {
  creditStore?.close?.()
  await stopServer(server)
  await isolated.cleanup()
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
