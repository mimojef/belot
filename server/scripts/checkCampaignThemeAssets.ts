/**
 * checkCampaignThemeAssets.ts
 *
 * Фаза 10 / 10.1 — "Тематични изображения, GIF и автоматична смяна на
 * визията в Белот", специфично фокусирано на §2-4 и §13 (upload
 * security + новата per-campaign папкова структура). Пълен E2E през
 * РЕАЛНИЯ spawned HTTP сървър (изолиран temp SQLite + temp uploads/),
 * harness по модела на checkAdminCampaignsHttpFlow.ts.
 *
 *   A. Auth: guest/player/subadmin -> 403 на PATCH .../theme-assets/unit_icon.
 *   B. Пълен admin: upload unit_icon (PNG->WebP) -> 200, URL и физически
 *      файл живеят под campaign-themes/<campaignId>/icons/<uuid>.webp.
 *   C. Upload unit_icon като GIF (ЕДИНСТВЕНИЯТ ресурс, който позволява GIF)
 *      -> 200, съхранен като .gif БЕЗ sharp re-encode, служи с
 *      Content-Type: image/gif.
 *   D. table_bg_desktop + table_bg_mobile -> и двата под .../tables/, с
 *      различни файлови имена (desktop != mobile).
 *   E. card_back -> под .../card-backs/.
 *   F. Replace: нов upload на unit_icon -> старият файл се трие от диска,
 *      новият остава, DB URL се обновява.
 *   G. Remove (imageDataUrl: null) -> URL става null, файлът се трие.
 *   H. Invalid файл (невалиден base64/mime) -> 400, нищо ново не се пише.
 *   I. GIF с невалидни magic bytes / свръх-размер -> 400.
 *   J. GIF е забранен за НЕ-unit_icon ресурси (само PNG/JPEG/WebP) -> 400.
 *   K. Невалиден kind segment -> 400.
 *   L. Невалиден/malformed campaignId (path traversal опит) -> 400,
 *      НИКАКЪВ файл не се пише извън campaign-themes/.
 *   M. Темата е редактируема независимо от статуса (schedule+activate,
 *      после пак upload -> 200), за разлика от заключените бизнес полета.
 *   N. Persistence след restart на сървъра — DB URL и физическият файл
 *      преживяват restart (uploads/ е извън dist/).
 *   O. Soft-delete на кампания -> upload след това се отхвърля
 *      (campaign_not_found), НО съществуващите файлове/папка на диска
 *      НЕ се трият автоматично (историческите изображения оцеляват).
 *   P. GET на реално качен файл през публичния /uploads/ route -> 200 с
 *      коректен Content-Type (nested path проходим през единствения
 *      campaign-themes root whitelist entry).
 */

import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, rm, symlink, stat, readdir } from 'node:fs/promises'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const PASSWORD = 'CampaignThemeAssetsHttp1!'
const TEST_SECRET = 'campaign-theme-assets-http-test-secret-0123456789'

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
  const root = await mkdtemp(join(tmpdir(), 'belot-campaign-theme-assets-http-'))
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
const nextIp = () => `203.0.115.${(ipCounter += 1)}`

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

async function rawGet(port: number, pathname: string): Promise<{ status: number; contentType: string | null }> {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, { method: 'GET' })
  await res.arrayBuffer()
  return { status: res.status, contentType: res.headers.get('content-type') }
}

const cookieOf = (result: JsonResult) => result.setCookie.find((c) => c.startsWith('belot_session='))?.split(';')[0] ?? ''

function withDb<T>(databaseFile: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(databaseFile)
  try { return fn(db) } finally { db.close() }
}

async function registerUser(port: number, databaseFile: string, label: string, role: string): Promise<{ cookie: string; profileId: string }> {
  const email = `campth-${label}-${randomUUID().slice(0, 8)}@example.test`
  const result = await request(port, 'POST', '/api/auth/register', {
    email, password: PASSWORD, displayName: `CampTh${label}${randomUUID().slice(0, 6)}`, gender: 'male', visitorId: randomUUID(),
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

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

// Минимален 1x1 валиден PNG (за processImageAttachmentToWebp вход).
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const TINY_PNG_DATA_URL = `data:image/png;base64,${TINY_PNG_BASE64}`

// Минимален валиден GIF header (6-байт magic + 7-байт Logical Screen
// Descriptor) — isValidCampaignGifBuffer само чете header+dimensions, НЕ
// decode-ва пълно изображение (sharp.block() забранява GIF decode
// глобално, виж campaignThemeAssets.ts), затова 13 байта са достатъчни.
function makeGifBuffer(widthPx: number, heightPx: number): Buffer {
  const header = Buffer.from('GIF89a', 'ascii')
  const lsd = Buffer.alloc(7)
  lsd.writeUInt16LE(widthPx, 0)
  lsd.writeUInt16LE(heightPx, 2)
  return Buffer.concat([header, lsd])
}
const VALID_GIF_DATA_URL = `data:image/gif;base64,${makeGifBuffer(1, 1).toString('base64')}`
const OVERSIZED_GIF_DATA_URL = `data:image/gif;base64,${makeGifBuffer(600, 600).toString('base64')}`
const BAD_MAGIC_GIF_DATA_URL = `data:image/gif;base64,${Buffer.concat([Buffer.from('ABCDEF', 'ascii'), Buffer.alloc(7)]).toString('base64')}`

const sourceServerRoot = resolve(process.argv.slice(2).find((a) => a.startsWith('--server-root='))?.slice('--server-root='.length) ?? process.cwd())
console.log('\n═══ Campaign Theme Assets HTTP E2E (Фаза 10/10.1) ═══')

const isolated = await createIsolatedServerRoot(sourceServerRoot)
const port = await getFreePort()
let server = startServer(isolated.serverDir, port, true)

try {
  await waitForServer(port)
  withDb(isolated.databaseFile, (db) => db.prepare(`UPDATE admin_settings SET setting_value = 'direct' WHERE setting_key = 'registration_verification_mode'`).run())

  const admin = await registerUser(port, isolated.databaseFile, 'admin', 'admin')
  const subadmin = await registerUser(port, isolated.databaseFile, 'subadmin', 'subadmin')
  const player = await registerUser(port, isolated.databaseFile, 'player', 'player')

  const allowedStakeRow = withDb(isolated.databaseFile, (db) =>
    db.prepare(`SELECT stake_amount FROM match_rooms WHERE is_enabled = 1 ORDER BY stake_amount ASC LIMIT 1;`).get() as { stake_amount: number } | undefined)
  assert(allowedStakeRow !== undefined, 'no enabled match_rooms seeded')
  const ALLOWED_STAKE = allowedStakeRow!.stake_amount

  console.log('\n=== setup: създаване на draft кампания ===')
  let campaignId!: string
  await check('setup. POST /api/admin/campaigns -> 200, draft', async () => {
    const result = await request(port, 'POST', '/api/admin/campaigns', {
      name: 'Theme Assets Test',
      startsAt: new Date(Date.now() + 3_600_000).toISOString(),
      endsAt: new Date(Date.now() + 200 * 3_600_000).toISOString(),
      unitNameSingular: 'жетон',
      unitNamePlural: 'жетони',
      giftSenderProfileId: null,
      earnRules: [{ gameKind: 'belot', stakeAmount: ALLOWED_STAKE, unitsPerWin: 1 }],
      packageEarnRules: [],
      rewardTiers: [{ tierId: null, thresholdUnits: 1, rewards: [{ rewardType: 'yellow_coins', amount: 1 }] }],
    }, admin.cookie)
    assert(result.status === 200, `${result.status} ${result.text}`)
    campaignId = (result.body?.campaign as Record<string, unknown>).campaignId as string
  })

  console.log('\n=== A. Auth — само пълен admin пипа theme-assets ===')
  for (const [label, cookie] of [['guest', undefined], ['player', player.cookie], ['subadmin', subadmin.cookie]] as const) {
    await check(`A. ${label}: PATCH .../theme-assets/unit_icon -> 403`, async () => {
      const result = await request(port, 'PATCH', `/api/admin/campaigns/${campaignId}/theme-assets/unit_icon`, { imageDataUrl: TINY_PNG_DATA_URL }, cookie)
      assert(result.status === 403, `${result.status} ${result.text}`)
    })
  }

  console.log('\n=== B. unit_icon (PNG->WebP) под campaign-themes/<id>/icons/ ===')
  let unitIconUrl1 = ''
  await check('B1. PATCH unit_icon (PNG) -> 200, URL под .../icons/<uuid>.webp', async () => {
    const result = await request(port, 'PATCH', `/api/admin/campaigns/${campaignId}/theme-assets/unit_icon`, { imageDataUrl: TINY_PNG_DATA_URL }, admin.cookie)
    assert(result.status === 200, `${result.status} ${result.text}`)
    const campaign = result.body?.campaign as Record<string, unknown>
    unitIconUrl1 = campaign.unitIconUrl as string
    const expectedPrefix = `/uploads/campaign-themes/${campaignId}/icons/`
    assert(unitIconUrl1.startsWith(expectedPrefix), `URL ${unitIconUrl1} не започва с ${expectedPrefix}`)
    assert(unitIconUrl1.endsWith('.webp'), `очаква се .webp, получено ${unitIconUrl1}`)
  })
  await check('B2. Физическият файл реално съществува под server/uploads/campaign-themes/<id>/icons/', async () => {
    const relative = unitIconUrl1.replace('/uploads/', '')
    const diskPath = join(isolated.uploadsRoot, ...relative.split('/'))
    assert(await fileExists(diskPath), `липсва файл: ${diskPath}`)
  })

  console.log('\n=== C. unit_icon като GIF (без sharp re-encode) ===')
  let gifUrl = ''
  await check('C1. PATCH unit_icon (валиден GIF) -> 200, URL завършва на .gif', async () => {
    const result = await request(port, 'PATCH', `/api/admin/campaigns/${campaignId}/theme-assets/unit_icon`, { imageDataUrl: VALID_GIF_DATA_URL }, admin.cookie)
    assert(result.status === 200, `${result.status} ${result.text}`)
    const campaign = result.body?.campaign as Record<string, unknown>
    gifUrl = campaign.unitIconUrl as string
    assert(gifUrl.endsWith('.gif'), `очаква се .gif, получено ${gifUrl}`)
    assert(gifUrl.includes(`/campaign-themes/${campaignId}/icons/`), `очаква се icons/ подпапка, получено ${gifUrl}`)
  })
  await check('C2. Старият PNG->WebP unit_icon файл е изтрит след замяна с GIF', async () => {
    const relative = unitIconUrl1.replace('/uploads/', '')
    const diskPath = join(isolated.uploadsRoot, ...relative.split('/'))
    assert(!(await fileExists(diskPath)), `стар файл трябваше да е изтрит: ${diskPath}`)
  })
  await check('C3. GET на GIF файла -> 200, Content-Type: image/gif', async () => {
    const result = await rawGet(port, gifUrl)
    assert(result.status === 200, `${result.status}`)
    assert(result.contentType === 'image/gif', `очаква се image/gif, получено ${result.contentType}`)
  })

  console.log('\n=== D. table_bg_desktop / table_bg_mobile под tables/ ===')
  let desktopUrl = ''
  let mobileUrl = ''
  await check('D1. PATCH table_bg_desktop -> 200, под .../tables/', async () => {
    const result = await request(port, 'PATCH', `/api/admin/campaigns/${campaignId}/theme-assets/table_bg_desktop`, { imageDataUrl: TINY_PNG_DATA_URL }, admin.cookie)
    assert(result.status === 200, `${result.status} ${result.text}`)
    desktopUrl = (result.body?.campaign as Record<string, unknown>).tableBgDesktopUrl as string
    assert(desktopUrl.includes(`/campaign-themes/${campaignId}/tables/`), `очаква се tables/ подпапка, получено ${desktopUrl}`)
  })
  await check('D2. PATCH table_bg_mobile -> 200, под .../tables/, различен файл от desktop', async () => {
    const result = await request(port, 'PATCH', `/api/admin/campaigns/${campaignId}/theme-assets/table_bg_mobile`, { imageDataUrl: TINY_PNG_DATA_URL }, admin.cookie)
    assert(result.status === 200, `${result.status} ${result.text}`)
    mobileUrl = (result.body?.campaign as Record<string, unknown>).tableBgMobileUrl as string
    assert(mobileUrl.includes(`/campaign-themes/${campaignId}/tables/`), `очаква се tables/ подпапка, получено ${mobileUrl}`)
    assert(mobileUrl !== desktopUrl, 'desktop и mobile не трябва да сочат към еднакъв файл')
  })

  console.log('\n=== E. card_back под card-backs/ ===')
  let cardBackUrl = ''
  await check('E1. PATCH card_back -> 200, под .../card-backs/', async () => {
    const result = await request(port, 'PATCH', `/api/admin/campaigns/${campaignId}/theme-assets/card_back`, { imageDataUrl: TINY_PNG_DATA_URL }, admin.cookie)
    assert(result.status === 200, `${result.status} ${result.text}`)
    cardBackUrl = (result.body?.campaign as Record<string, unknown>).cardBackUrl as string
    assert(cardBackUrl.includes(`/campaign-themes/${campaignId}/card-backs/`), `очаква се card-backs/ подпапка, получено ${cardBackUrl}`)
  })

  console.log('\n=== F/G. Replace и Remove ===')
  await check('F1. Повторен upload на table_bg_mobile трие стария файл, пази новия', async () => {
    const oldRelative = mobileUrl.replace('/uploads/', '')
    const oldDiskPath = join(isolated.uploadsRoot, ...oldRelative.split('/'))
    const result = await request(port, 'PATCH', `/api/admin/campaigns/${campaignId}/theme-assets/table_bg_mobile`, { imageDataUrl: TINY_PNG_DATA_URL }, admin.cookie)
    assert(result.status === 200, `${result.status} ${result.text}`)
    const newUrl = (result.body?.campaign as Record<string, unknown>).tableBgMobileUrl as string
    assert(newUrl !== mobileUrl, 'нов файл трябва да получи ново уникално име')
    assert(!(await fileExists(oldDiskPath)), `стар mobile файл трябваше да е изтрит: ${oldDiskPath}`)
    const newRelative = newUrl.replace('/uploads/', '')
    assert(await fileExists(join(isolated.uploadsRoot, ...newRelative.split('/'))), 'новият файл трябва да съществува')
    mobileUrl = newUrl
  })
  await check('G1. PATCH table_bg_mobile с imageDataUrl:null премахва ресурса и трие файла', async () => {
    const relative = mobileUrl.replace('/uploads/', '')
    const diskPath = join(isolated.uploadsRoot, ...relative.split('/'))
    const result = await request(port, 'PATCH', `/api/admin/campaigns/${campaignId}/theme-assets/table_bg_mobile`, { imageDataUrl: null }, admin.cookie)
    assert(result.status === 200, `${result.status} ${result.text}`)
    const campaign = result.body?.campaign as Record<string, unknown>
    assert(campaign.tableBgMobileUrl === null, `очаква се null, получено ${JSON.stringify(campaign.tableBgMobileUrl)}`)
    assert(!(await fileExists(diskPath)), `файлът трябваше да е изтрит: ${diskPath}`)
  })

  console.log('\n=== H/I/J/K. Отхвърляне на невалиден вход ===')
  await check('H1. Невалиден base64/mime -> 400, без запис на нов файл', async () => {
    const before = await readdir(join(isolated.uploadsRoot, 'campaign-themes', campaignId, 'card-backs')).catch(() => [])
    const result = await request(port, 'PATCH', `/api/admin/campaigns/${campaignId}/theme-assets/card_back`, { imageDataUrl: 'data:image/png;base64,%%%not-base64%%%' }, admin.cookie)
    assert(result.status === 400, `${result.status} ${result.text}`)
    const after = await readdir(join(isolated.uploadsRoot, 'campaign-themes', campaignId, 'card-backs')).catch(() => [])
    assert(after.length === before.length, 'не трябва да се появи нов файл при невалиден вход')
  })
  await check('I1. GIF с невалидни magic bytes -> 400', async () => {
    const result = await request(port, 'PATCH', `/api/admin/campaigns/${campaignId}/theme-assets/unit_icon`, { imageDataUrl: BAD_MAGIC_GIF_DATA_URL }, admin.cookie)
    assert(result.status === 400, `${result.status} ${result.text}`)
  })
  await check('I2. GIF със свръх-размер (600×600 > 512×512 лимит) -> 400', async () => {
    const result = await request(port, 'PATCH', `/api/admin/campaigns/${campaignId}/theme-assets/unit_icon`, { imageDataUrl: OVERSIZED_GIF_DATA_URL }, admin.cookie)
    assert(result.status === 400, `${result.status} ${result.text}`)
  })
  await check('J1. GIF е забранен за card_back (само unit_icon поддържа GIF) -> 400', async () => {
    const result = await request(port, 'PATCH', `/api/admin/campaigns/${campaignId}/theme-assets/card_back`, { imageDataUrl: VALID_GIF_DATA_URL }, admin.cookie)
    assert(result.status === 400, `${result.status} ${result.text}`)
  })
  await check('K1. Невалиден kind segment -> 400', async () => {
    const result = await request(port, 'PATCH', `/api/admin/campaigns/${campaignId}/theme-assets/not_a_real_kind`, { imageDataUrl: TINY_PNG_DATA_URL }, admin.cookie)
    assert(result.status === 400, `${result.status} ${result.text}`)
  })

  console.log('\n=== L. Path traversal защита на campaignId ===')
  await check('L1. campaignId с ".." traversal опит -> 400, нищо не се пише извън campaign-themes/', async () => {
    const maliciousId = encodeURIComponent('../../../../etc')
    const result = await request(port, 'PATCH', `/api/admin/campaigns/${maliciousId}/theme-assets/unit_icon`, { imageDataUrl: TINY_PNG_DATA_URL }, admin.cookie)
    assert(result.status === 400, `${result.status} ${result.text}`)
    assert(!(await fileExists(join(isolated.serverDir, 'etc'))), 'не трябва да се създаде директория извън uploads/')
  })
  await check('L2. campaignId с невалиден (не-UUID) формат -> 400', async () => {
    const result = await request(port, 'PATCH', `/api/admin/campaigns/not-a-real-uuid/theme-assets/unit_icon`, { imageDataUrl: TINY_PNG_DATA_URL }, admin.cookie)
    assert(result.status === 400, `${result.status} ${result.text}`)
  })

  console.log('\n=== M. Тематичната визия е редактируема независимо от статуса ===')
  await check('M1. POST .../activate -> status=active', async () => {
    const result = await request(port, 'POST', `/api/admin/campaigns/${campaignId}/activate`, {}, admin.cookie)
    assert(result.status === 200, `${result.status} ${result.text}`)
    assert((result.body?.campaign as Record<string, unknown>).status === 'active', result.text)
  })
  await check('M2. PUT на активна кампания (бизнес поле) -> 200, но rewardTiers остават заключени (контролна проверка)', async () => {
    const result = await request(port, 'PUT', `/api/admin/campaigns/${campaignId}`, {
      name: 'Should Change', startsAt: new Date(Date.now() + 3_600_000).toISOString(), endsAt: new Date(Date.now() + 200 * 3_600_000).toISOString(),
      unitNameSingular: 'x', unitNamePlural: 'x', giftSenderProfileId: null,
      earnRules: [{ gameKind: 'belot', stakeAmount: ALLOWED_STAKE, unitsPerWin: 1 }], packageEarnRules: [],
      rewardTiers: [{ tierId: null, thresholdUnits: 999, rewards: [{ rewardType: 'yellow_coins', amount: 1 }] }],
    }, admin.cookie)
    assert(result.status === 200, `${result.status} ${result.text}`)
    const campaign = result.body?.campaign as Record<string, unknown> | undefined
    assert(campaign?.name === 'Should Change', 'името трябва да се обнови за активна кампания')
    const rewardTiers = campaign?.rewardTiers as Array<Record<string, unknown>> | undefined
    assert(rewardTiers !== undefined && rewardTiers[0]?.thresholdUnits === 1, 'rewardTiers трябва да останат заключени (старият праг 1, не подадения 999)')
  })
  await check('M3. ...но PATCH theme-assets на АКТИВНА кампания -> 200 (темата НЕ е заключена)', async () => {
    const result = await request(port, 'PATCH', `/api/admin/campaigns/${campaignId}/theme-assets/card_back`, { imageDataUrl: TINY_PNG_DATA_URL }, admin.cookie)
    assert(result.status === 200, `${result.status} ${result.text}`)
    cardBackUrl = (result.body?.campaign as Record<string, unknown>).cardBackUrl as string
  })

  console.log('\n=== N. Persistence след restart ===')
  await stopServer(server)
  server = startServer(isolated.serverDir, port, true)
  await waitForServer(port)
  await check('N1. След restart: GET показва СЪЩИТЕ theme URL-и', async () => {
    const result = await request(port, 'GET', '/api/admin/campaigns', undefined, admin.cookie)
    assert(result.status === 200, `${result.status} ${result.text}`)
    const row = (result.body?.campaigns as Array<Record<string, unknown>>).find((c) => c.campaignId === campaignId)
    assert(row !== undefined, 'кампанията трябва да е в списъка')
    assert(row!.cardBackUrl === cardBackUrl, `card_back URL трябва да преживее restart, получено ${row!.cardBackUrl}`)
  })
  await check('N2. Физическият файл на диска също преживява restart', async () => {
    const relative = cardBackUrl.replace('/uploads/', '')
    assert(await fileExists(join(isolated.uploadsRoot, ...relative.split('/'))), 'файлът трябва да съществува след restart')
  })

  console.log('\n=== O. Soft-delete запазва историческите файлове ===')
  await check('O1. POST .../stop -> status=stopped (delete изисква не-активна кампания)', async () => {
    const result = await request(port, 'POST', `/api/admin/campaigns/${campaignId}/stop`, {}, admin.cookie)
    assert(result.status === 200, `${result.status} ${result.text}`)
  })
  await check('O2. POST .../delete -> soft-deleted', async () => {
    const result = await request(port, 'POST', `/api/admin/campaigns/${campaignId}/delete`, {}, admin.cookie)
    assert(result.status === 200, `${result.status} ${result.text}`)
  })
  await check('O3. PATCH theme-assets след soft-delete -> 400 campaign_not_found', async () => {
    const result = await request(port, 'PATCH', `/api/admin/campaigns/${campaignId}/theme-assets/card_back`, { imageDataUrl: TINY_PNG_DATA_URL }, admin.cookie)
    assert(result.status === 400 && result.body?.reason === 'campaign_not_found', `${result.status} ${result.text}`)
  })
  await check('O4. Папката/историческите файлове на soft-deleted кампанията НЕ са изтрити автоматично', async () => {
    const campaignDir = join(isolated.uploadsRoot, 'campaign-themes', campaignId)
    assert(await fileExists(campaignDir), `папката трябваше да оцелее: ${campaignDir}`)
    const relative = cardBackUrl.replace('/uploads/', '')
    assert(await fileExists(join(isolated.uploadsRoot, ...relative.split('/'))), 'историческият card_back файл трябва да оцелее')
  })

  console.log('\n=== P. Публично сервиране на вложени пътища ===')
  await check('P1. GET на реално качен вложен файл -> 200 с коректен Content-Type', async () => {
    const result = await rawGet(port, cardBackUrl)
    assert(result.status === 200, `${result.status}`)
    assert(result.contentType === 'image/webp', `очаква се image/webp, получено ${result.contentType}`)
  })
  await check('P2. GET на несъществуващ файл под campaign-themes -> 404 (не 403 — whitelist работи, файлът просто липсва)', async () => {
    const result = await rawGet(port, `/uploads/campaign-themes/${campaignId}/icons/${randomUUID()}.webp`)
    assert(result.status === 404, `очаква се 404, получено ${result.status}`)
  })
} finally {
  await stopServer(server)
  await isolated.cleanup()
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
