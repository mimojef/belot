/**
 * checkBelotVisualAdminHttp.ts
 *
 * "Визия на Белот" — реален изолиран сървър (кампаниите включени), реален
 * HTTP admin API, реални файлове на диска и реален WebSocket bootstrap/broadcast.
 *
 *  A. Права: гост/играч/subadmin → 403 на GET/PATCH/качване; admin → 200.
 *  B. По подразбиране изключена, без изображения; WS носи стандартната визия.
 *  C. Качване (PNG → оптимизиран WebP) под campaign-themes/belot-visual/;
 *     сервира се като image/webp с immutable кеш; докато е изключена, не
 *     засяга масата.
 *  D. Приоритет през реалния WS: изключена → кампанията; включена → ръчната
 *     пред кампанията; липсващо ръчно изображение → кампанийното; без
 *     кампания → стандартната; включването/изключването се broadcast-ва веднага.
 *  E. Замяна: нов URL (кеш), новият файл е на диска, старият е изтрит
 *     физически; неуспешно качване оставя старата картинка непокътната.
 *  F. "Премахни" изтрива файла физически; изключване НЕ трие нищо.
 *  G. Защита: файл на кампания (или извън belot-visual/), сочен от ръчната
 *     визия, не се изтрива при замяна/премахване.
 *  H. Рестарт: настройките и файловете оцеляват; WS bootstrap пак носи
 *     ръчната визия; неизползван файл в belot-visual/ се почиства при старт.
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

const PASSWORD = 'BelotVisualAdminHttp1!'
const TEST_SECRET = 'belot-visual-admin-http-test-secret-0123456789'

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
  const root = await mkdtemp(join(tmpdir(), 'belot-visual-admin-http-'))
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
console.log('\n═══ Визия на Белот — admin HTTP + WS E2E ═══')

const isolated = await createIsolatedServerRoot(sourceServerRoot)
const port = await getFreePort()
let server = startServer(isolated.serverDir, port)
const diskPath = (url: string) => join(isolated.uploadsRoot, ...url.replace('/uploads/', '').split('/'))

try {
  await waitForServer(port, server)
  withDb(isolated.databaseFile, (db) => db.prepare(`UPDATE admin_settings SET setting_value = 'direct' WHERE setting_key = 'registration_verification_mode'`).run())

  const admin = await registerUser(port, isolated.databaseFile, 'admin', 'admin')
  const subadmin = await registerUser(port, isolated.databaseFile, 'subadmin', 'subadmin')
  const player = await registerUser(port, isolated.databaseFile, 'player', 'player')
  const RED = await pngDataUrl(1600, 900, '#aa0000')
  const GREEN = await pngDataUrl(900, 1600, '#00aa00')
  const BLUE = await pngDataUrl(300, 420, '#0000aa')
  const YELLOW = await pngDataUrl(1600, 900, '#aaaa00')

  console.log('\n=== A. Права ===')
  for (const [label, cookie] of [['гост', undefined], ['играч', player], ['subadmin', subadmin]] as const) {
    await check(`A. ${label}: GET/PATCH/качване → 403`, async () => {
      const get = await request(port, 'GET', '/api/admin/belot-visual', undefined, cookie)
      const toggle = await request(port, 'PATCH', '/api/admin/belot-visual', { enabled: true }, cookie)
      const upload = await request(port, 'PATCH', '/api/admin/belot-visual/assets/card_back', { imageDataUrl: BLUE }, cookie)
      assert(get.status === 403 && toggle.status === 403 && upload.status === 403, `${get.status}/${toggle.status}/${upload.status}`)
    })
  }
  await check('A. отказаните заявки не са променили нищо', async () => {
    const res = await request(port, 'GET', '/api/admin/belot-visual', undefined, admin)
    assert(res.body.visual.enabled === false && res.body.visual.cardBackUrl === null, res.text)
  })

  console.log('\n=== B. По подразбиране ===')
  await check('B1. admin GET → изключена, без изображения', async () => {
    const res = await request(port, 'GET', '/api/admin/belot-visual', undefined, admin)
    assert(res.status === 200, res.text)
    assert(JSON.stringify(res.body.visual) === JSON.stringify({ enabled: false, tableBgDesktopUrl: null, tableBgMobileUrl: null, cardBackUrl: null }), res.text)
  })
  await check('B2. WS bootstrap → стандартна визия (всичко null)', async () => {
    const frame = await readBootstrapVisual(port)
    assert(JSON.stringify(frame.belotVisual) === JSON.stringify({ tableBgDesktopUrl: null, tableBgMobileUrl: null, cardBackUrl: null }), JSON.stringify(frame))
  })
  await check('B3. невалидни заявки → 400 (тип изображение, тяло)', async () => {
    const badKind = await request(port, 'PATCH', '/api/admin/belot-visual/assets/unit_icon', { imageDataUrl: BLUE }, admin)
    const badBody = await request(port, 'PATCH', '/api/admin/belot-visual', { enabled: 'yes' }, admin)
    assert(badKind.status === 400 && badBody.status === 400, `${badKind.status}/${badBody.status}`)
  })

  console.log('\n=== Подготовка: активна кампания с маса Desktop и гръб ===')
  const stakeRow = withDb(isolated.databaseFile, (db) => db.prepare(`SELECT stake_amount FROM match_rooms WHERE is_enabled = 1 ORDER BY stake_amount ASC LIMIT 1;`).get() as { stake_amount: number })
  const created = await request(port, 'POST', '/api/admin/campaigns', {
    name: 'Belot Visual Priority Test',
    startsAt: new Date(Date.now() + 3_600_000).toISOString(),
    endsAt: new Date(Date.now() + 200 * 3_600_000).toISOString(),
    unitNameSingular: 'жетон',
    unitNamePlural: 'жетони',
    giftSenderProfileId: null,
    earnRules: [{ gameKind: 'belot', stakeAmount: stakeRow.stake_amount, unitsPerWin: 1 }],
    packageEarnRules: [],
    rewardTiers: [{ tierId: null, thresholdUnits: 1, rewards: [{ rewardType: 'yellow_coins', amount: 1 }] }],
  }, admin)
  assert(created.status === 200, `campaign create: ${created.text}`)
  const campaignId = created.body.campaign.campaignId as string
  const campDesk = await request(port, 'PATCH', `/api/admin/campaigns/${campaignId}/theme-assets/table_bg_desktop`, { imageDataUrl: YELLOW }, admin)
  const campBack = await request(port, 'PATCH', `/api/admin/campaigns/${campaignId}/theme-assets/card_back`, { imageDataUrl: BLUE }, admin)
  const activated = await request(port, 'POST', `/api/admin/campaigns/${campaignId}/activate`, {}, admin)
  assert(campDesk.status === 200 && campBack.status === 200 && activated.status === 200, `${campDesk.status}/${campBack.status}/${activated.status} ${activated.text}`)
  const campaignDeskUrl = campDesk.body.campaign.tableBgDesktopUrl as string
  const campaignBackUrl = campBack.body.campaign.cardBackUrl as string

  console.log('\n=== C/D. Качване и приоритет ===')
  const listener = await openListener(port)
  await check('D1. изключена ръчна визия + активна кампания → кампанийните изображения', async () => {
    const frame = await readBootstrapVisual(port)
    assert(frame.belotVisual.tableBgDesktopUrl === campaignDeskUrl && frame.belotVisual.cardBackUrl === campaignBackUrl && frame.belotVisual.tableBgMobileUrl === null, JSON.stringify(frame.belotVisual))
    assert(frame.theme?.tableBgDesktopUrl === campaignDeskUrl, 'campaign theme field changed')
  })

  let deskUrl1 = ''
  await check('C1. качване на маса Desktop (PNG) → WebP под campaign-themes/belot-visual/tables/', async () => {
    const res = await request(port, 'PATCH', '/api/admin/belot-visual/assets/table_bg_desktop', { imageDataUrl: RED }, admin)
    assert(res.status === 200, res.text)
    deskUrl1 = res.body.visual.tableBgDesktopUrl
    assert(/^\/uploads\/campaign-themes\/belot-visual\/tables\/[0-9a-f-]{36}\.webp$/.test(deskUrl1), deskUrl1)
    assert(res.body.visual.enabled === false, 'upload must not enable the override')
    assert(await fileExists(diskPath(deskUrl1)), 'file not on disk')
  })
  await check('C2. файлът се сервира като image/webp с immutable кеш, реален WebP', async () => {
    const res = await fetch(`http://127.0.0.1:${port}${deskUrl1}`)
    const buffer = Buffer.from(await res.arrayBuffer())
    assert(res.status === 200 && res.headers.get('content-type') === 'image/webp', `${res.status} ${res.headers.get('content-type')}`)
    assert((res.headers.get('cache-control') ?? '').includes('immutable'), `${res.headers.get('cache-control')}`)
    const meta = await sharp(buffer).metadata()
    assert(meta.format === 'webp' && meta.width === 1600 && meta.height === 900, `${meta.format} ${meta.width}x${meta.height}`)
  })
  await check('C3. докато е изключена, качването не засяга масата (broadcast-ът пак е кампанията)', async () => {
    const frame = await waitForBroadcast(listener, () => true, 'after upload')
    assert(frame.belotVisual.tableBgDesktopUrl === campaignDeskUrl, JSON.stringify(frame.belotVisual))
  })

  await check('D2. включване → broadcast веднага: ръчна маса Desktop пред кампанията; липсващите → кампания/стандартна', async () => {
    listener.frames.length = 0
    const res = await request(port, 'PATCH', '/api/admin/belot-visual', { enabled: true }, admin)
    assert(res.status === 200 && res.body.visual.enabled === true, res.text)
    const frame = await waitForBroadcast(listener, (f) => f.belotVisual.tableBgDesktopUrl === deskUrl1, 'enable')
    assert(frame.belotVisual.cardBackUrl === campaignBackUrl, `card back must fall back to campaign: ${frame.belotVisual.cardBackUrl}`)
    assert(frame.belotVisual.tableBgMobileUrl === null, 'mobile must fall back to standard')
  })

  let mobileUrl = ''
  let backUrl = ''
  await check('D3. ръчни Mobile и гръб → и трите ръчни; desktop/mobile са различни URL-и', async () => {
    const m = await request(port, 'PATCH', '/api/admin/belot-visual/assets/table_bg_mobile', { imageDataUrl: GREEN }, admin)
    const b = await request(port, 'PATCH', '/api/admin/belot-visual/assets/card_back', { imageDataUrl: BLUE }, admin)
    assert(m.status === 200 && b.status === 200, `${m.text} ${b.text}`)
    mobileUrl = m.body.visual.tableBgMobileUrl
    backUrl = b.body.visual.cardBackUrl
    assert(backUrl.startsWith('/uploads/campaign-themes/belot-visual/card-backs/'), backUrl)
    const frame = await readBootstrapVisual(port)
    assert(frame.belotVisual.tableBgDesktopUrl === deskUrl1 && frame.belotVisual.tableBgMobileUrl === mobileUrl && frame.belotVisual.cardBackUrl === backUrl, JSON.stringify(frame.belotVisual))
    assert(mobileUrl !== deskUrl1, 'desktop and mobile share a URL')
  })
  await check('D4. гърбът на картите е свален до 500px (размер по ресурс)', async () => {
    // Буфер, не път: на Windows libvips държи отворени файловете, подадени по път.
    const meta = await sharp(await readFile(diskPath(backUrl))).metadata()
    assert(meta.width === 300 && meta.height === 420, `card back ${meta.width}x${meta.height} (no upscaling of a 300x420 source)`)
    const mobileMeta = await sharp(await readFile(diskPath(mobileUrl))).metadata()
    assert(mobileMeta.height === 1400 && Math.abs((mobileMeta.width ?? 0) - 788) <= 1, `mobile ${mobileMeta.width}x${mobileMeta.height}`)
  })

  console.log('\n=== E. Замяна и неуспешно качване ===')
  let deskUrl2 = ''
  await check('E1. замяна → нов URL, новият файл е на диска, старият е изтрит физически', async () => {
    listener.frames.length = 0
    const res = await request(port, 'PATCH', '/api/admin/belot-visual/assets/table_bg_desktop', { imageDataUrl: YELLOW }, admin)
    assert(res.status === 200, res.text)
    deskUrl2 = res.body.visual.tableBgDesktopUrl
    assert(deskUrl2 !== deskUrl1, 'URL not changed (cache would serve the old image)')
    assert(await fileExists(diskPath(deskUrl2)), 'new file missing')
    assert(!(await fileExists(diskPath(deskUrl1))), 'old file still on disk')
    await waitForBroadcast(listener, (f) => f.belotVisual.tableBgDesktopUrl === deskUrl2, 'replace broadcast')
  })
  await check('E2. стария URL вече връща 404 (няма остатъчен файл)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}${deskUrl1}`)
    assert(res.status === 404, `${res.status}`)
  })
  await check('E3. неуспешно качване (невалиден файл / GIF / повреден PNG) → 400, старата картинка непокътната', async () => {
    const filesBefore = await readdir(join(isolated.uploadsRoot, 'campaign-themes', 'belot-visual', 'tables'))
    const gif = `data:image/gif;base64,${(await sharp({ create: { width: 10, height: 10, channels: 3, background: '#f00' } }).gif().toBuffer()).toString('base64')}`
    const broken = `data:image/png;base64,${Buffer.from('not-a-real-png-file').toString('base64')}`
    for (const imageDataUrl of [gif, broken, 'data:text/plain;base64,aGVsbG8=']) {
      const res = await request(port, 'PATCH', '/api/admin/belot-visual/assets/table_bg_desktop', { imageDataUrl }, admin)
      assert(res.status === 400, `${res.status} ${res.text}`)
    }
    const get = await request(port, 'GET', '/api/admin/belot-visual', undefined, admin)
    assert(get.body.visual.tableBgDesktopUrl === deskUrl2, 'active image changed')
    assert(await fileExists(diskPath(deskUrl2)), 'old image deleted on failed upload')
    const filesAfter = await readdir(join(isolated.uploadsRoot, 'campaign-themes', 'belot-visual', 'tables'))
    assert(filesAfter.length === filesBefore.length, `leftover files: ${filesBefore.length} -> ${filesAfter.length}`)
  })

  console.log('\n=== F. Изключване и премахване ===')
  await check('F1. изключване → кампанията веднага; файловете и URL-ите се пазят', async () => {
    listener.frames.length = 0
    const res = await request(port, 'PATCH', '/api/admin/belot-visual', { enabled: false }, admin)
    assert(res.body.visual.enabled === false && res.body.visual.tableBgDesktopUrl === deskUrl2 && res.body.visual.cardBackUrl === backUrl, res.text)
    await waitForBroadcast(listener, (f) => f.belotVisual.tableBgDesktopUrl === campaignDeskUrl && f.belotVisual.cardBackUrl === campaignBackUrl, 'disable')
    for (const url of [deskUrl2, mobileUrl, backUrl]) assert(await fileExists(diskPath(url)), `file deleted on disable: ${url}`)
  })
  await check('F2. повторно включване → същите ръчни изображения се връщат', async () => {
    listener.frames.length = 0
    await request(port, 'PATCH', '/api/admin/belot-visual', { enabled: true }, admin)
    await waitForBroadcast(listener, (f) => f.belotVisual.tableBgDesktopUrl === deskUrl2 && f.belotVisual.cardBackUrl === backUrl && f.belotVisual.tableBgMobileUrl === mobileUrl, 're-enable')
  })
  await check('F3. "Премахни" (гръб) → файлът е изтрит физически, слотът пада към кампанията', async () => {
    listener.frames.length = 0
    const res = await request(port, 'PATCH', '/api/admin/belot-visual/assets/card_back', { imageDataUrl: null }, admin)
    assert(res.status === 200 && res.body.visual.cardBackUrl === null, res.text)
    assert(!(await fileExists(diskPath(backUrl))), 'removed file still on disk')
    await waitForBroadcast(listener, (f) => f.belotVisual.cardBackUrl === campaignBackUrl, 'remove broadcast')
  })

  console.log('\n=== G. Защита на чужди файлове ===')
  await check('G1. файл на кампания, сочен от ръчната визия, не се изтрива при замяна', async () => {
    withDb(isolated.databaseFile, (db) => db.prepare(`INSERT INTO admin_settings (setting_key, setting_value) VALUES ('belot_visual_card_back_url', ?) ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value`).run(campaignBackUrl))
    const res = await request(port, 'PATCH', '/api/admin/belot-visual/assets/card_back', { imageDataUrl: BLUE }, admin)
    assert(res.status === 200, res.text)
    assert(await fileExists(diskPath(campaignBackUrl)), 'campaign file was deleted')
    const campaignRow = (await request(port, 'GET', '/api/admin/campaigns', undefined, admin)).body.campaigns.find((c: any) => c.campaignId === campaignId)
    assert(campaignRow.cardBackUrl === campaignBackUrl, 'campaign record changed')
    backUrl = res.body.visual.cardBackUrl
  })
  await check('G2. файл извън belot-visual/ (кампанийна маса) не се изтрива при "Премахни"', async () => {
    withDb(isolated.databaseFile, (db) => db.prepare(`UPDATE admin_settings SET setting_value = ? WHERE setting_key = 'belot_visual_table_bg_mobile_url'`).run(campaignDeskUrl))
    const res = await request(port, 'PATCH', '/api/admin/belot-visual/assets/table_bg_mobile', { imageDataUrl: null }, admin)
    assert(res.status === 200, res.text)
    assert(await fileExists(diskPath(campaignDeskUrl)), 'campaign table file was deleted')
  })
  await check('G3. кампанията продължава да работи (изображенията ѝ се сервират)', async () => {
    for (const url of [campaignDeskUrl, campaignBackUrl]) {
      const res = await fetch(`http://127.0.0.1:${port}${url}`)
      assert(res.status === 200, `${url} → ${res.status}`)
    }
  })

  console.log('\n=== H. Рестарт ===')
  listener.ws.close()
  const orphanName = `${randomUUID()}.webp`
  const orphanPath = join(isolated.uploadsRoot, 'campaign-themes', 'belot-visual', 'tables', orphanName)
  await writeFile(orphanPath, await sharp({ create: { width: 4, height: 4, channels: 3, background: '#fff' } }).webp().toBuffer())
  // Mobile файлът от D3 остана без ред след G2 (симулира срив между запис и активиране).
  await stopServer(server)
  server = startServer(isolated.serverDir, port)
  await waitForServer(port, server)
  await check('H1. след рестарт настройката и изображенията са запазени', async () => {
    const res = await request(port, 'GET', '/api/admin/belot-visual', undefined, admin)
    assert(res.body.visual.enabled === true && res.body.visual.tableBgDesktopUrl === deskUrl2 && res.body.visual.cardBackUrl === backUrl, res.text)
    assert(await fileExists(diskPath(deskUrl2)) && await fileExists(diskPath(backUrl)), 'files missing after restart')
  })
  await check('H2. WS bootstrap след рестарт → ръчната визия', async () => {
    const frame = await readBootstrapVisual(port)
    assert(frame.belotVisual.tableBgDesktopUrl === deskUrl2 && frame.belotVisual.cardBackUrl === backUrl && frame.belotVisual.tableBgMobileUrl === null, JSON.stringify(frame.belotVisual))
  })
  await check('H3. при старт неизползваните файлове в belot-visual/ са почистени, използваните — не', async () => {
    assert(!(await fileExists(orphanPath)), 'orphan file not pruned')
    assert(!(await fileExists(diskPath(mobileUrl))), 'unreferenced mobile file not pruned')
    assert(await fileExists(diskPath(deskUrl2)) && await fileExists(diskPath(backUrl)), 'referenced file pruned')
    assert(await fileExists(diskPath(campaignDeskUrl)) && await fileExists(diskPath(campaignBackUrl)), 'campaign file pruned')
  })
} finally {
  await stopServer(server)
  await isolated.cleanup()
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
