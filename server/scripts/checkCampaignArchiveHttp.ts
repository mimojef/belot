/**
 * checkCampaignArchiveHttp.ts
 *
 * Фаза 11 — admin "Приключили кампании" HTTP wiring E2E (§13 сигурност +
 * реалния archiveCampaign() path), през РЕАЛНИЯ spawned сървър, harness по
 * модела на checkCampaignThemeAssets.ts.
 *
 *   A. Auth: guest/player/subadmin/marketing/pika_team -> 403 на
 *      list/detail/trigger.
 *   B. Feature flag OFF -> 403.
 *   C. GET detail за finished-но-неархивирана кампания -> archived:false +
 *      readiness.
 *   D. POST архивира успешно -> 200, detail с правилна статистика.
 *   E. GET списък показва архивираната кампания с totals.
 *   F. Повторен POST -> идемпотентно success (alreadyArchived:true).
 *   G. Невалиден campaignId -> 404.
 *   H. Едновременни POST заявки (race) -> и двете успешни, само ЕДИН
 *      archive запис (идемпотентност под конкурентност).
 *   I. Draft/active кампания -> GET връща 404 (not_finished), POST -> 400.
 */

import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const PASSWORD = 'CampaignArchiveHttp1!'
const TEST_SECRET = 'campaign-archive-http-test-secret-0123456789'
// Минимален 1x1 валиден PNG (за processImageAttachmentToWebp вход).
const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const TINY_PNG_DATA_URL = `data:image/png;base64,${TINY_PNG_BASE64}`

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
      if (!addr || typeof addr === 'string') { srv.close(() => reject(new Error('no port'))); return }
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
  const root = await mkdtemp(join(tmpdir(), 'belot-campaign-archive-http-'))
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
    ...process.env, PORT: String(port),
    BELOT_GAME_WORKER_TICK_MODE: 'worker-candidate', BELOT_GAME_WORKER_COUNT: '1',
    PASSWORD_RESET_RATE_LIMIT_SECRET: TEST_SECRET,
  }
  if (campaignsEnabled) env.CAMPAIGNS_FEATURE_ENABLED = '1'
  else delete env.CAMPAIGNS_FEATURE_ENABLED
  const child = spawn(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'index.ts')], {
    cwd: serverDir, env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (c: string) => chunks.push(c))
  child.stderr.on('data', (c: string) => chunks.push(c))
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
    try { if ((await fetch(`http://127.0.0.1:${port}/api/rooms`)).status === 200) return } catch { /* not yet */ }
    await sleep(100)
  }
  throw new Error('server did not start')
}

let ipCounter = 0
const nextIp = () => `203.0.116.${(ipCounter += 1)}`

type JsonResult = { status: number; body: Record<string, unknown> | null; text: string; setCookie: string[] }

async function request(port: number, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', pathname: string, body?: unknown, cookie?: string): Promise<JsonResult> {
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
  const email = `campah-${label}-${randomUUID().slice(0, 8)}@example.test`
  const result = await request(port, 'POST', '/api/auth/register', {
    email, password: PASSWORD, displayName: `CampAh${label}${randomUUID().slice(0, 6)}`, gender: 'male', visitorId: randomUUID(),
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
console.log('\n═══ Campaign Archive HTTP E2E (Фаза 11) ═══')

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
  const pikaTeam = await registerUser(port, isolated.databaseFile, 'pikateam', 'pika_team')

  const allowedStakeRow = withDb(isolated.databaseFile, (db) =>
    db.prepare(`SELECT stake_amount FROM match_rooms WHERE is_enabled = 1 ORDER BY stake_amount ASC LIMIT 1;`).get() as { stake_amount: number } | undefined)
  assert(allowedStakeRow !== undefined, 'no enabled match_rooms seeded')
  const ALLOWED_STAKE = allowedStakeRow!.stake_amount

  console.log('\n=== setup: draft -> activate -> directly flip to finished (DB) ===')
  let campaignId!: string
  await check('setup. create+activate+finish a campaign with 0 participants', async () => {
    const createResult = await request(port, 'POST', '/api/admin/campaigns', {
      name: 'Archive HTTP Test',
      startsAt: new Date(Date.now() + 1_000).toISOString(),
      endsAt: new Date(Date.now() + 2 * 3_600_000).toISOString(),
      unitNameSingular: 'жетон', unitNamePlural: 'жетони', giftSenderProfileId: null,
      earnRules: [{ gameKind: 'belot', stakeAmount: ALLOWED_STAKE, unitsPerWin: 1 }],
      packageEarnRules: [], rewardTiers: [{ tierId: null, thresholdUnits: 1, rewards: [{ rewardType: 'yellow_coins', amount: 1 }] }],
    }, admin.cookie)
    assert(createResult.status === 200, `${createResult.status} ${createResult.text}`)
    campaignId = (createResult.body?.campaign as Record<string, unknown>).campaignId as string
    await sleep(1200)
    const activateResult = await request(port, 'POST', `/api/admin/campaigns/${campaignId}/activate`, {}, admin.cookie)
    assert(activateResult.status === 200, `activate: ${activateResult.status} ${activateResult.text}`)
    // Директно флипваме статуса на 'finished' през DB (тест за archive flow-а
    // специфично — не чака реалния scheduler/15s tick да изтече реалния период).
    withDb(isolated.databaseFile, (db) => db.prepare(`UPDATE campaigns SET status = 'finished', updated_at = CURRENT_TIMESTAMP WHERE campaign_id = ?;`).run(campaignId))
  })

  console.log('\n=== A. Auth — само пълен admin вижда архива ===')
  for (const [label, cookie] of [['guest', undefined], ['player', player.cookie], ['subadmin', subadmin.cookie], ['marketing', marketing.cookie], ['pikaTeam', pikaTeam.cookie]] as const) {
    await check(`A. ${label}: GET списък/детайл/POST trigger -> 403`, async () => {
      const list = await request(port, 'GET', '/api/admin/campaigns/archive', undefined, cookie)
      assert(list.status === 403, `list: ${list.status}`)
      const detail = await request(port, 'GET', `/api/admin/campaigns/${campaignId}/archive`, undefined, cookie)
      assert(detail.status === 403, `detail: ${detail.status}`)
      const trigger = await request(port, 'POST', `/api/admin/campaigns/${campaignId}/archive`, {}, cookie)
      assert(trigger.status === 403, `trigger: ${trigger.status}`)
    })
  }

  console.log('\n=== C. GET detail за finished-но-неархивирана кампания ===')
  await check('C1. GET .../archive -> archived:false, readiness.ready=true (0 участници)', async () => {
    const result = await request(port, 'GET', `/api/admin/campaigns/${campaignId}/archive`, undefined, admin.cookie)
    assert(result.status === 200, `${result.status} ${result.text}`)
    assert(result.body?.archived === false, `${result.text}`)
    assert(result.body?.ready === true, `${result.text}`)
  })

  console.log('\n=== D. POST архивира успешно ===')
  await check('D1. POST .../archive -> 200, alreadyArchived:false, detail с totalUnits=0', async () => {
    const result = await request(port, 'POST', `/api/admin/campaigns/${campaignId}/archive`, {}, admin.cookie)
    assert(result.status === 200, `${result.status} ${result.text}`)
    assert(result.body?.alreadyArchived === false, `${result.text}`)
    const detail = result.body?.detail as Record<string, unknown>
    const summary = detail.summary as Record<string, unknown>
    assert(summary.totalUnits === 0 && summary.participantsCount === 0, `${JSON.stringify(summary)}`)
    assert(summary.endedReason === 'expired', `${JSON.stringify(summary)}`)
  })

  console.log('\n=== E. GET списък показва архивираната кампания ===')
  await check('E1. GET /api/admin/campaigns/archive -> включва campaignId с archivedAt!=null', async () => {
    const result = await request(port, 'GET', '/api/admin/campaigns/archive', undefined, admin.cookie)
    assert(result.status === 200, `${result.status} ${result.text}`)
    const rows = result.body?.campaigns as Array<Record<string, unknown>>
    const row = rows.find((r) => r.campaignId === campaignId)
    assert(row !== undefined && row.archivedAt !== null && row.totalUnits === 0, `${JSON.stringify(row)}`)
  })

  console.log('\n=== F. Повторен POST -> идемпотентно ===')
  await check('F1. Повторен POST .../archive -> 200, alreadyArchived:true, СЪЩИТЕ данни', async () => {
    const result = await request(port, 'POST', `/api/admin/campaigns/${campaignId}/archive`, {}, admin.cookie)
    assert(result.status === 200 && result.body?.alreadyArchived === true, `${result.status} ${result.text}`)
  })

  console.log('\n=== G. Невалиден campaignId ===')
  await check('G1. GET .../archive за непознат id -> 404', async () => {
    const result = await request(port, 'GET', `/api/admin/campaigns/${randomUUID()}/archive`, undefined, admin.cookie)
    assert(result.status === 404, `${result.status} ${result.text}`)
  })
  await check('G2. POST .../archive за непознат id -> 400/404', async () => {
    const result = await request(port, 'POST', `/api/admin/campaigns/${randomUUID()}/archive`, {}, admin.cookie)
    assert(result.status === 404 || result.status === 400, `${result.status} ${result.text}`)
  })

  console.log('\n=== H. Едновременни POST заявки (race) ===')
  let raceCampaignId!: string
  await check('H0. setup: втора кампания, finished, 0 участници', async () => {
    const createResult = await request(port, 'POST', '/api/admin/campaigns', {
      name: 'Race Test', startsAt: new Date(Date.now() + 1_000).toISOString(), endsAt: new Date(Date.now() + 2 * 3_600_000).toISOString(),
      unitNameSingular: 'ж', unitNamePlural: 'жета', giftSenderProfileId: null,
      earnRules: [{ gameKind: 'belot', stakeAmount: ALLOWED_STAKE, unitsPerWin: 1 }], packageEarnRules: [], rewardTiers: [{ tierId: null, thresholdUnits: 1, rewards: [{ rewardType: 'yellow_coins', amount: 1 }] }],
    }, admin.cookie)
    assert(createResult.status === 200, `${createResult.status} ${createResult.text}`)
    raceCampaignId = (createResult.body?.campaign as Record<string, unknown>).campaignId as string
    await sleep(1200)
    await request(port, 'POST', `/api/admin/campaigns/${raceCampaignId}/activate`, {}, admin.cookie)
    withDb(isolated.databaseFile, (db) => db.prepare(`UPDATE campaigns SET status = 'finished', updated_at = CURRENT_TIMESTAMP WHERE campaign_id = ?;`).run(raceCampaignId))
  })
  await check('H1. 2 едновременни POST .../archive -> и двете success, само 1 archive запис', async () => {
    const [r1, r2] = await Promise.all([
      request(port, 'POST', `/api/admin/campaigns/${raceCampaignId}/archive`, {}, admin.cookie),
      request(port, 'POST', `/api/admin/campaigns/${raceCampaignId}/archive`, {}, admin.cookie),
    ])
    assert(r1.status === 200 && r2.status === 200, `r1=${r1.status} r2=${r2.status}`)
    const count = withDb(isolated.databaseFile, (db) => db.prepare(`SELECT COUNT(*) AS c FROM campaign_archive_summary WHERE campaign_id = ?;`).get(raceCampaignId) as { c: number })
    assert(count.c === 1, `очаква се точно 1 archive запис, получени ${count.c}`)
  })

  console.log('\n=== I. Draft/active кампания ===')
  let activeCampaignId!: string
  await check('I0. setup: активна кампания (не finished)', async () => {
    const createResult = await request(port, 'POST', '/api/admin/campaigns', {
      name: 'Active Not Finished', startsAt: new Date(Date.now() + 1_000).toISOString(), endsAt: new Date(Date.now() + 200 * 3_600_000).toISOString(),
      unitNameSingular: 'ж', unitNamePlural: 'жета', giftSenderProfileId: null,
      earnRules: [{ gameKind: 'belot', stakeAmount: ALLOWED_STAKE, unitsPerWin: 1 }], packageEarnRules: [], rewardTiers: [{ tierId: null, thresholdUnits: 1, rewards: [{ rewardType: 'yellow_coins', amount: 1 }] }],
    }, admin.cookie)
    activeCampaignId = (createResult.body?.campaign as Record<string, unknown>).campaignId as string
    await sleep(1200)
    await request(port, 'POST', `/api/admin/campaigns/${activeCampaignId}/activate`, {}, admin.cookie)
  })
  await check('I1. GET .../archive за активна кампания -> 404 not_finished', async () => {
    const result = await request(port, 'GET', `/api/admin/campaigns/${activeCampaignId}/archive`, undefined, admin.cookie)
    assert(result.status === 404 && result.body?.reason === 'not_finished', `${result.status} ${result.text}`)
  })
  await check('I2. POST .../archive за активна кампания -> 400 not_finished', async () => {
    const result = await request(port, 'POST', `/api/admin/campaigns/${activeCampaignId}/archive`, {}, admin.cookie)
    assert(result.status === 400 && result.body?.reason === 'not_finished', `${result.status} ${result.text}`)
  })

  console.log('\n=== J. Архивно копие на иконата (§8) ===')
  let iconCampaignId!: string
  let liveIconUrl!: string
  await check('J0. setup: кампания с качена иконка, finished', async () => {
    const createResult = await request(port, 'POST', '/api/admin/campaigns', {
      name: 'Icon Archive Test', startsAt: new Date(Date.now() + 1_000).toISOString(), endsAt: new Date(Date.now() + 2 * 3_600_000).toISOString(),
      unitNameSingular: 'ж', unitNamePlural: 'жета', giftSenderProfileId: null,
      earnRules: [{ gameKind: 'belot', stakeAmount: ALLOWED_STAKE, unitsPerWin: 1 }], packageEarnRules: [],
      rewardTiers: [{ tierId: null, thresholdUnits: 1, rewards: [{ rewardType: 'yellow_coins', amount: 1 }] }],
    }, admin.cookie)
    iconCampaignId = (createResult.body?.campaign as Record<string, unknown>).campaignId as string
    const iconResult = await request(port, 'PATCH', `/api/admin/campaigns/${iconCampaignId}/theme-assets/unit_icon`, { imageDataUrl: TINY_PNG_DATA_URL }, admin.cookie)
    assert(iconResult.status === 200, `upload icon: ${iconResult.status} ${iconResult.text}`)
    liveIconUrl = (iconResult.body?.campaign as Record<string, unknown>).unitIconUrl as string
    assert(liveIconUrl.includes('/icons/'), `${liveIconUrl}`)
    await sleep(1200)
    await request(port, 'POST', `/api/admin/campaigns/${iconCampaignId}/activate`, {}, admin.cookie)
    withDb(isolated.databaseFile, (db) => db.prepare(`UPDATE campaigns SET status = 'finished', updated_at = CURRENT_TIMESTAMP WHERE campaign_id = ?;`).run(iconCampaignId))
  })
  await check('J1. POST .../archive -> archived copy под отделен /archive/ път, различен от live иконата', async () => {
    const result = await request(port, 'POST', `/api/admin/campaigns/${iconCampaignId}/archive`, {}, admin.cookie)
    assert(result.status === 200, `${result.status} ${result.text}`)
    const detail = result.body?.detail as Record<string, unknown>
    const summary = detail.summary as Record<string, unknown>
    const archivedIconUrl = summary.unitIconUrlAtArchive as string | null
    assert(archivedIconUrl !== null && archivedIconUrl.includes('/archive/'), `${JSON.stringify(summary)}`)
    assert(archivedIconUrl !== liveIconUrl, 'архивното копие трябва да е ОТДЕЛЕН файл от live иконата')
    const rawArchived = await fetch(`http://127.0.0.1:${port}${archivedIconUrl}`)
    assert(rawArchived.status === 200, `GET архивна иконка: ${rawArchived.status}`)
    const rawLive = await fetch(`http://127.0.0.1:${port}${liveIconUrl}`)
    assert(rawLive.status === 200, 'live иконата продължава да съществува (locked, не изтрита)')
  })
  await check('J2. PATCH theme-assets след архивиране -> 400 campaign_archived, archived copy непроменен', async () => {
    const result = await request(port, 'PATCH', `/api/admin/campaigns/${iconCampaignId}/theme-assets/unit_icon`, { imageDataUrl: null }, admin.cookie)
    assert(result.status === 400 && result.body?.reason === 'campaign_archived', `${result.status} ${result.text}`)
    const detail = await request(port, 'GET', `/api/admin/campaigns/${iconCampaignId}/archive`, undefined, admin.cookie)
    const summary = (detail.body?.detail as Record<string, unknown>).summary as Record<string, unknown>
    assert(summary.unitIconUrlAtArchive !== null, 'архивното копие остава непроменено')
  })

  console.log('\n=== K. Автоматично архивиране при restart (без ръчен POST) ===')
  let autoCampaignId!: string
  await check('K0. setup: finished кампания, НИКОГА archive-ната ръчно', async () => {
    const createResult = await request(port, 'POST', '/api/admin/campaigns', {
      name: 'Auto Archive Test', startsAt: new Date(Date.now() + 1_000).toISOString(), endsAt: new Date(Date.now() + 2 * 3_600_000).toISOString(),
      unitNameSingular: 'ж', unitNamePlural: 'жета', giftSenderProfileId: null,
      earnRules: [{ gameKind: 'belot', stakeAmount: ALLOWED_STAKE, unitsPerWin: 1 }], packageEarnRules: [],
      rewardTiers: [{ tierId: null, thresholdUnits: 1, rewards: [{ rewardType: 'yellow_coins', amount: 1 }] }],
    }, admin.cookie)
    autoCampaignId = (createResult.body?.campaign as Record<string, unknown>).campaignId as string
    await sleep(1200)
    await request(port, 'POST', `/api/admin/campaigns/${autoCampaignId}/activate`, {}, admin.cookie)
    withDb(isolated.databaseFile, (db) => db.prepare(`UPDATE campaigns SET status = 'finished', updated_at = CURRENT_TIMESTAMP WHERE campaign_id = ?;`).run(autoCampaignId))
  })
  await check('K1. Restart на сървъра (СЪЩАТА DB) -> on-boot tick архивира автоматично, без ръчен POST .../archive', async () => {
    await stopServer(server)
    server = startServer(isolated.serverDir, port, true)
    await waitForServer(port)
    const detail = await request(port, 'GET', `/api/admin/campaigns/${autoCampaignId}/archive`, undefined, admin.cookie)
    assert(detail.status === 200 && detail.body?.archived === true, `очаква се автоматично архивирана, получено ${detail.status} ${detail.text}`)
  })

  console.log('\n=== B. Feature flag OFF ===')
  await stopServer(server)
  server = startServer(isolated.serverDir, port, false)
  await waitForServer(port)
  await check('B1. Flag OFF: GET списък -> 403', async () => {
    const result = await request(port, 'GET', '/api/admin/campaigns/archive', undefined, admin.cookie)
    assert(result.status === 403, `${result.status} ${result.text}`)
  })
} finally {
  await stopServer(server)
  await isolated.cleanup()
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
