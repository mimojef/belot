/**
 * checkAdCampaignTargetUrlNullableMigration.ts
 *
 * Доказва item 10 от "campaign без target" hardening-а: миграцията
 * 20260830_004_make_ad_campaign_target_url_nullable.sql (table rebuild,
 * ad_campaigns е PARENT на ad_campaign_dispatches с ON DELETE CASCADE)
 * запазва СЪЩЕСТВУВАЩИ campaign/dispatch редове (включително такива с
 * непразен target_url) непокътнати — двуфазен boot на СЪЩАТА SQLite база:
 *
 *  Фаза 1: временно копие на migrations/ БЕЗ новия файл 004 — сървърът
 *          прилага само до 20260830_003 (target_url още NOT NULL), създава
 *          се campaign С target + един dispatch към нея, после спираме сървъра.
 *  Фаза 2: връщаме 004 файла обратно, стартираме сървъра ПАК върху СЪЩИЯ DB
 *          файл — runner-ът вижда 001..003 вече в server_migrations ledger-а
 *          и прилага САМО 004 (реалният production upgrade сценарий).
 *
 * [M1] Фаза 2 boot-ът успява (миграцията се прилага без грешка върху
 *      непразна база с FK-referencing dispatch ред).
 * [M2] Съществуващата campaign (с target) оцелява — same campaign_id, same
 *      target_url, все още видима в management list.
 * [M3] Съществуващият dispatch (FK към campaign_id) оцелява непокътнат.
 * [M4] След миграцията, target_url колоната реално е nullable — нова
 *      campaign БЕЗ target се създава успешно на СЪЩАТА (upgrade-ната) база.
 */

import { DatabaseSync } from 'node:sqlite'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm, cp, mkdir, symlink, rename } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverRoot = resolve(__dirname, '..')
const MIGRATION_FILENAME = '20260830_004_make_ad_campaign_target_url_nullable.sql'

let passed = 0
let failed = 0

function pass(label: string): void {
  passed++
  console.log(`  PASS  ${label}`)
}
function fail(label: string, reason: unknown): void {
  failed++
  console.error(`  FAIL  ${label}: ${reason instanceof Error ? reason.message : String(reason)}`)
}
async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    pass(label)
  } catch (err) {
    fail(label, err)
  }
}
function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}
function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
  }
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
async function waitFor(label: string, pred: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await pred()) return
    await sleep(100)
  }
  throw new Error(`Timeout: ${label}`)
}
async function retryRm(path: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try { await rm(path, { recursive: true, force: true }); return } catch { /* retry */ }
    await new Promise<void>((r) => setTimeout(r, 250))
  }
}
function getFreePort(): Promise<number> {
  return new Promise((res, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (!addr || typeof addr === 'string') {
        srv.close(() => reject(new Error('Не може да се намери свободен порт.')))
        return
      }
      const { port } = addr
      srv.close(() => res(port))
    })
  })
}

async function makeIsolated(root: string) {
  const tmp = await mkdtemp(join(tmpdir(), 'belot-ad-campaigns-migration-'))
  const serverDir = join(tmp, 'server')
  await mkdir(serverDir, { recursive: true })
  await cp(join(root, 'src'), join(serverDir, 'src'), { recursive: true, preserveTimestamps: true })
  await cp(join(root, 'dist'), join(serverDir, 'dist'), { recursive: true, preserveTimestamps: true })
  await mkdir(join(serverDir, 'database', 'data'), { recursive: true })
  await cp(join(root, 'database', 'migrations'), join(serverDir, 'database', 'migrations'), { recursive: true, preserveTimestamps: true })
  await cp(join(root, 'package.json'), join(serverDir, 'package.json'), { preserveTimestamps: true })
  const lt = process.platform === 'win32' ? 'junction' : 'dir'
  await symlink(join(root, 'node_modules'), join(serverDir, 'node_modules'), lt)
  await symlink(join(root, '..', 'node_modules'), join(tmp, 'node_modules'), lt)
  return {
    serverDir,
    dbFile: join(serverDir, 'database', 'data', 'belot-v2.sqlite'),
    migrationsDir: join(serverDir, 'database', 'migrations'),
    cleanup: () => retryRm(tmp),
  }
}

function startSrv(serverDir: string, port: number): { child: ChildProcessWithoutNullStreams; output(): string } {
  const chunks: string[] = []
  const child = spawn(
    process.execPath,
    [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'index.ts')],
    {
      cwd: serverDir,
      env: { ...process.env, PORT: String(port), BELOT_GAME_WORKER_TICK_MODE: 'worker-candidate', BELOT_GAME_WORKER_COUNT: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (c: string) => chunks.push(c))
  child.stderr.on('data', (c: string) => chunks.push(c))
  return { child, output: () => chunks.join('') }
}
async function stopSrv(s: { child: ChildProcessWithoutNullStreams }): Promise<void> {
  if (s.child.exitCode !== null) return
  s.child.kill('SIGTERM')
  await new Promise<void>((r) => {
    const t = setTimeout(() => { s.child.kill('SIGKILL'); r() }, 10_000)
    s.child.once('exit', () => { clearTimeout(t); r() })
  })
}

type HttpResult = { status: number; body: unknown }
async function httpGetJson(port: number, pathname: string, cookie?: string): Promise<HttpResult> {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, { headers: cookie ? { Cookie: cookie } : undefined })
  let body: unknown = null
  try { body = await res.json() } catch { /* */ }
  return { status: res.status, body }
}
async function httpPostJson(port: number, pathname: string, cookie: string | undefined, payload: unknown): Promise<HttpResult> {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(payload),
  })
  let body: unknown = null
  try { body = await res.json() } catch { /* */ }
  return { status: res.status, body }
}

async function waitForServerReady(port: number): Promise<void> {
  await waitFor('server ready', async () => {
    try {
      const r = await httpGetJson(port, '/health')
      const h = r.body as { ok?: boolean; gameWorkerPool?: { state?: string } | null }
      return r.status === 200 && h.ok === true && h.gameWorkerPool?.state === 'ready'
    } catch { return false }
  }, 30_000)
}

const PASSWORD = 'AdCampaignsMigrationCheck1!'

async function registerAndLogin(port: number, email: string, displayName: string): Promise<{ cookie: string; profileId: string }> {
  const regRes = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, displayName, gender: 'male' }),
  })
  if (regRes.status !== 200) throw new Error(`Register ${email} failed: ${regRes.status}`)
  const loginRes = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  })
  const h = loginRes.headers as Headers & { getSetCookie?: () => string[] }
  const cookie = (h.getSetCookie?.()[0] ?? loginRes.headers.get('set-cookie'))?.split(';')[0]
  if (!cookie) throw new Error(`No Set-Cookie on login for ${email}`)
  const meRes = await httpGetJson(port, '/api/auth/me', cookie)
  const profileId = (meRes.body as { session?: { profile?: { profileId?: string } } }).session?.profile?.profileId
  if (!profileId) throw new Error(`No profileId for ${email}`)
  return { cookie, profileId }
}

function promoteToAdmin(databaseFile: string, email: string): void {
  const db = new DatabaseSync(databaseFile, { open: true, enableForeignKeyConstraints: true })
  db.exec('PRAGMA journal_mode = WAL;')
  db.prepare(`UPDATE accounts SET role = 'admin', updated_at = CURRENT_TIMESTAMP WHERE email = ?;`).run(email)
  db.close()
}

const fixtureBase = sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 80, g: 140, b: 220 } } })
const pngBuffer = await fixtureBase.clone().png().toBuffer()
const VALID_IMAGE_DATA_URL = `data:image/png;base64,${pngBuffer.toString('base64')}`

type CampaignDto = { campaignId: string; targetUrl: string | null; dispatchCount: number }

console.log('\n=== Ad Campaign target_url nullable migration — data preservation (двуфазен boot) ===\n')

const iso = await makeIsolated(serverRoot)
let phase1Server: { child: ChildProcessWithoutNullStreams; output(): string } | null = null
let phase2Server: { child: ChildProcessWithoutNullStreams; output(): string } | null = null

try {
  // ─── Фаза 1: без 20260830_004 — сървърът спира на 003 (target_url NOT NULL) ───
  // Runner-ът чете ВСЕКИ .sql файл в migrations/ (без филтър по име) — файлът
  // трябва да излезе НАПЪЛНО от директорията, не просто да се преименува
  // вътре в нея (иначе _pending_ префикс го сортира ПРЕДИ 001 и се опитва да
  // изпълни срещу празна база).
  const movedAsideMigrationPath = join(iso.serverDir, `_pending_${MIGRATION_FILENAME}`)
  await rename(join(iso.migrationsDir, MIGRATION_FILENAME), movedAsideMigrationPath)

  const port1 = await getFreePort()
  phase1Server = startSrv(iso.serverDir, port1)
  console.log(`  [Фаза 1] Чакам сървъра (без ${MIGRATION_FILENAME}) на порт ${port1}…`)
  try {
    await waitForServerReady(port1)
  } catch (err) {
    console.error('--- phase1 server output ---')
    console.error(phase1Server.output())
    throw err
  }
  console.log('  [Фаза 1] Сървърът е готов (само до 20260830_003).\n')

  const runId = `${Date.now()}-${process.pid}`
  const admin = await registerAndLogin(port1, `adcamp-migr-admin-${runId}@example.test`, 'MigrAdmin')
  promoteToAdmin(iso.dbFile, `adcamp-migr-admin-${runId}@example.test`)

  let preMigrationCampaignId = ''
  await check('[M0 — Фаза 1 setup] campaign С target + 1 dispatch, създадени ПРЕДИ миграцията', async () => {
    const createRes = await httpPostJson(port1, '/api/admin/ad-campaigns', admin.cookie, {
      imageDataUrl: VALID_IMAGE_DATA_URL,
      targetUrl: '/tournaments',
    })
    assert(createRes.status === 200, `create (pre-migration) очаквано 200, получено ${createRes.status}: ${JSON.stringify(createRes.body)}`)
    preMigrationCampaignId = (createRes.body as { campaign: CampaignDto }).campaign.campaignId

    const sendRes = await httpPostJson(port1, `/api/admin/ad-campaigns/${preMigrationCampaignId}/send`, admin.cookie, {})
    assert(sendRes.status === 200, `send (pre-migration) очаквано 200, получено ${sendRes.status}`)
    assertEqual((sendRes.body as { campaign: CampaignDto }).campaign.dispatchCount, 1, 'dispatchCount преди миграцията')
  })

  await stopSrv(phase1Server)
  phase1Server = null

  // ─── Фаза 2: връщаме 004 обратно, стартираме ПАК върху СЪЩИЯ DB файл ───
  await rename(movedAsideMigrationPath, join(iso.migrationsDir, MIGRATION_FILENAME))

  const port2 = await getFreePort()
  phase2Server = startSrv(iso.serverDir, port2)
  console.log(`  [Фаза 2] Чакам сървъра (сега С ${MIGRATION_FILENAME}) на порт ${port2}…`)

  await check('[M1] Фаза 2 boot-ът успява — миграцията се прилага чисто върху непразна база с FK-referencing dispatch', async () => {
    await waitForServerReady(port2)
  })
  console.log('  [Фаза 2] Сървърът е готов (20260830_004 приложена).\n')

  await check('[M2] Съществуващата campaign (с target) оцелява — same campaign_id, same target_url', async () => {
    const listRes = await httpGetJson(port2, '/api/admin/ad-campaigns', admin.cookie)
    assert(listRes.status === 200, `management list очаквано 200, получено ${listRes.status}`)
    const found = (listRes.body as { campaigns: CampaignDto[] }).campaigns.find((c) => c.campaignId === preMigrationCampaignId)
    assert(found !== undefined, 'campaign-ът, създадена преди миграцията, трябва все още да съществува')
    assertEqual(found!.targetUrl, '/tournaments', 'target_url трябва да е запазен непроменен след rebuild-а')
  })

  await check('[M3] Съществуващият dispatch (FK campaign_id) оцелява непокътнат', () => {
    const db = new DatabaseSync(iso.dbFile, { open: true, enableForeignKeyConstraints: true })
    const row = db.prepare(`SELECT COUNT(*) AS cnt FROM ad_campaign_dispatches WHERE campaign_id = ?;`).get(preMigrationCampaignId) as { cnt: number }
    const fkCheck = db.prepare(`PRAGMA foreign_key_check(ad_campaign_dispatches);`).all()
    db.close()
    assertEqual(row.cnt, 1, 'dispatch редът трябва да е оцелял (не cascade-delete-нат от table rebuild-а)')
    assertEqual(fkCheck.length, 0, 'foreign_key_check не трябва да съобщава нарушения след rebuild-а')
  })

  await check('[M4] target_url колоната реално е nullable след миграцията — нова campaign БЕЗ target се създава успешно', async () => {
    const r = await httpPostJson(port2, '/api/admin/ad-campaigns', admin.cookie, { imageDataUrl: VALID_IMAGE_DATA_URL })
    assert(r.status === 200, `create без target след миграцията очаквано 200, получено ${r.status}: ${JSON.stringify(r.body)}`)
    const campaign = (r.body as { campaign: CampaignDto }).campaign
    assertEqual(campaign.targetUrl, null, 'новата campaign без target трябва да има targetUrl:null')
  })
} finally {
  if (phase1Server) await stopSrv(phase1Server)
  if (phase2Server) await stopSrv(phase2Server)
  await iso.cleanup()
}

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)

if (failed > 0) {
  process.exitCode = 1
}
