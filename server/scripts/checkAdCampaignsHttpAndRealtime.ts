/**
 * checkAdCampaignsHttpAndRealtime.ts
 *
 * E2E тест за "Рекламни кампании" — реален spawn-нат сървър, изолирана
 * SQLite база, реални HTTP + WS заявки. Established harness pattern (виж
 * checkTopicModerationAuthRealtime.ts/checkSubadminHttpAuthorization.ts).
 *
 * === Section A: Authorization matrix ===
 * [A1-2] admin/pika_team МОГАТ GET list (200)
 * [A3-5] player/subadmin/chat_admin НЕ МОГАТ (403)
 * [A6]   unauthenticated (401/403)
 * [A7-9] player НЕ МОЖЕ create/send/delete (403)
 *
 * === Section B: Campaign ≠ Dispatch CRUD lifecycle + shared visibility ===
 * [B1-3] admin създава кампания; pika_team вижда СЪЩАТА (shared, creator-agnostic)
 * [B4]   pika_team изпраща -> dispatchCount=1
 * [B5]   повторно изпращане -> dispatchCount=2, различни dispatch_id-та в DB
 * [B6]   audit колони коректни (created_by/sent_by profile_id+role) в DB
 * [B7-8] admin изтрива -> изчезва от списъка (за двамата); send/delete на изтрита -> 404
 * [B9]   create с невалидна снимка -> 400; create с невалиден target URL -> 400
 *
 * === Section C: Delivery state machine (WS) ===
 * [C1] Checkpoint A: нов WS connect на online-not-in-game профил веднага получава pending dispatch
 * [C2] Checkpoint C: fan-out веднага след "Изпрати" към вече свързан idle клиент
 * [C3] Dismiss персистира — same dispatch не се връща при нов connect
 * [C4] Repeated send (Send#2 след dismiss на Send#1) СЕ показва пак — campaign ≠ dispatch
 * [C5] Multi-tab: dismiss в един tab праща ad_campaign_dispatch_invalidated в другия
 * [C6] Offline-then-deleted: campaign изтрита ПРЕДИ login -> НИКОГА не се доставя (Scenario 1)
 * [C7] Delete докато клиент е online с pending/shown ad -> получава ad_campaign_deleted realtime
 * [C8] Management realtime sync: create/dispatch/delete от единия -> вижда се от другия management viewer
 *
 * === Section E: Endpoint-specific upload hardening (create) ===
 * [E1-4] malformed/невалиден MIME/неподдържан формат (GIF)/празен imageDataUrl -> 400, без DB ред
 * [E5-6] unsafe target URL (data:, //protocol-relative) -> 400, без DB ред
 * [E7]   regression sanity — валиден create добавя точно 1 ред
 *
 * === Section D: Case B — in-game defer (РЕАЛНА private-room + bots, без 4-играчна маса) ===
 * Ползва private_room + bot-fill seam: initializeRoomAuthoritativeGameState
 * сеща room.status='playing' веднага при 4/4 fill (private_room_full), много
 * преди cutting/bidding/dealing — isProfileInActiveGame() вижда профила
 * in-game без нужда да се играе истински рунд. "Вече не в игра" се постига
 * чрез leave_active_room (permanentlyLeftAt), без да чакаме целия мач.
 * [D1] pending dispatch съществува, но "Изпрати" fan-out НЕ доставя докато in-game
 * [D2] explicit request_pending_ad_campaigns докато in-game -> пак нищо
 * [D3] Checkpoint A: нов connect (2-ри tab) на in-game профил също нищо не получава
 * [D4] доброволно напускане ("game-finished" analog) САМО ПО СЕБЕ СИ не е trigger
 * [D5] campaign, изтрита ПРЕДИ реален Lobby entry, никога не се доставя
 * [D6] реалният Lobby-entry hook доставя валидния dispatch, но не изтрития
 *
 * === Section F: Multiple offline dispatches (Send#1/#2/#3 докато е offline) ===
 * [F1] 3 sends -> ЕДИН push с всичките 3, sent_at ASC, различни dispatch_id
 * [F2] delete след serия sends, преди login -> нищо не оцелява
 *
 * === Section G: Same-instance cross-poll duplicate delivery guard ===
 * [G1-3] send fan-out / delete / dismiss-invalidation всяко доставя ТОЧНО ВЕДНЪЖ
 *        (poll-ът ~700ms по-късно не дублира — event_seq cursor advance-нат синхронно)
 *
 * === Section H: Receipt semantics ===
 * [H1] shown_at analytics-only — не прекратява pending статуса
 * [H2] repeated reconnect преди dismiss/click връща СЪЩИЯ dispatch
 * [H3] clicked е terminal — не се връща след click
 * [H4] clicked_at идемпотентен (двоен click не мести timestamp-а)
 *
 * === Section I: WS management subscribe authorization ===
 * [I1-2] admin/pika_team -> allowed;  [I3-5] player/subadmin/chat_admin -> denied/ignored
 *
 * === Section J: Optional target URL (кампания без линк) ===
 * [J1]   create без target -> 200, DB target_url IS NULL, management връща null
 * [J2]   explicit targetUrl:null -> третира се като "без target"
 * [J3]   empty/whitespace target string се нормализира до null
 * [J4]   unsafe non-empty target продължава да връща 400 (regression)
 * [J5]   send campaign без target -> 200, dispatchCount нараства нормално
 * [J6]   pending dispatch без target се доставя нормално, targetUrl:null в payload-а
 */

import { DatabaseSync } from 'node:sqlite'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm, cp, mkdir, symlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import sharp from 'sharp'
import WebSocket, { type RawData } from 'ws'

const __dirname = dirname(fileURLToPath(import.meta.url))
const serverRoot = resolve(__dirname, '..')

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
  const tmp = await mkdtemp(join(tmpdir(), 'belot-ad-campaigns-'))
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
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    headers: cookie ? { Cookie: cookie } : undefined,
  })
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

async function httpDeleteJson(port: number, pathname: string, cookie: string | undefined): Promise<HttpResult> {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: 'DELETE',
    headers: { ...(cookie ? { Cookie: cookie } : {}) },
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

const PASSWORD = 'AdCampaignsCheck1!'

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

function promoteAccount(databaseFile: string, email: string, role: 'admin' | 'subadmin' | 'pika_team' | 'chat_admin'): void {
  const database = new DatabaseSync(databaseFile, { open: true, enableForeignKeyConstraints: true })
  try {
    database.exec('PRAGMA journal_mode = WAL;')
    database.prepare(`UPDATE accounts SET role = ?, updated_at = CURRENT_TIMESTAMP WHERE email = ?;`).run(role, email)
  } finally {
    database.close()
  }
}

type AnyMsg = Record<string, unknown> & { type: string }

const wsMessageBuffers = new WeakMap<WebSocket, AnyMsg[]>()

function openWs(port: number, cookie?: string): Promise<WebSocket> {
  return new Promise((resolveWs, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, cookie ? { headers: { Cookie: cookie } } : undefined)
    const buffer: AnyMsg[] = []
    wsMessageBuffers.set(ws, buffer)
    ws.on('message', (raw: RawData) => {
      try { buffer.push(JSON.parse(raw.toString())) } catch { /* ignore malformed */ }
    })
    const t = setTimeout(() => { ws.terminate(); reject(new Error('WS open timeout')) }, 5000)
    ws.once('open', () => { clearTimeout(t); resolveWs(ws) })
    ws.once('error', (err) => { clearTimeout(t); reject(err) })
  })
}
function sendWs(ws: WebSocket, message: Record<string, unknown>): void {
  ws.send(JSON.stringify(message))
}
async function waitForWsMessage(ws: WebSocket, predicate: (msg: AnyMsg) => boolean, timeoutMs = 5000): Promise<AnyMsg> {
  const deadline = Date.now() + timeoutMs
  const buffer = wsMessageBuffers.get(ws)
  if (!buffer) throw new Error('WS buffer missing')
  while (Date.now() < deadline) {
    const idx = buffer.findIndex(predicate)
    if (idx !== -1) return buffer[idx]!
    await sleep(30)
  }
  throw new Error('Timeout waiting for WS message matching predicate')
}
async function assertNoWsMessage(ws: WebSocket, predicate: (msg: AnyMsg) => boolean, waitMs = 800): Promise<void> {
  await sleep(waitMs)
  const buffer = wsMessageBuffers.get(ws) ?? []
  assert(!buffer.some(predicate), 'очаквано НИКАКВО съобщение да не match-не предиката, но такова беше намерено')
}
function countWsMessages(ws: WebSocket, predicate: (msg: AnyMsg) => boolean): number {
  const buffer = wsMessageBuffers.get(ws) ?? []
  return buffer.filter(predicate).length
}

// ─── Image fixtures (sharp тук НЕ е block-нат — генерирани преди server import) ───

const fixtureBase = sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 200, g: 60, b: 60 } } })
const pngBuffer = await fixtureBase.clone().png().toBuffer()
const gifBuffer = await fixtureBase.clone().gif().toBuffer()
const garbageBuffer = randomBytes(256)

function toDataUrl(mime: 'png' | 'jpeg' | 'webp', buffer: Buffer): string {
  return `data:image/${mime};base64,${buffer.toString('base64')}`
}
const VALID_IMAGE_DATA_URL = toDataUrl('png', pngBuffer)

type CampaignDto = {
  campaignId: string
  imageUrl: string
  targetUrl: string | null
  createdAt: string
  createdByProfileId: string | null
  createdByDisplayName: string | null
  createdByRole: string
  dispatchCount: number
  lastDispatchAt: string | null
}

console.log('\n=== Ad Campaigns HTTP + Realtime (single instance) ===\n')

const iso = await makeIsolated(serverRoot)
const port = await getFreePort()
let srv: { child: ChildProcessWithoutNullStreams; output(): string } | null = null

try {
  srv = startSrv(iso.serverDir, port)
  console.log(`  Чакам сървъра на порт ${port}…`)
  await waitForServerReady(port)
  console.log('  Сървърът е готов.\n')

  const runId = `${Date.now()}-${process.pid}`

  const admin = await registerAndLogin(port, `adcamp-admin-${runId}@example.test`, 'AdminUser')
  const pikaTeam = await registerAndLogin(port, `adcamp-pikateam-${runId}@example.test`, 'PikaTeamUser')
  const subadmin = await registerAndLogin(port, `adcamp-subadmin-${runId}@example.test`, 'SubadminUser')
  const chatAdmin = await registerAndLogin(port, `adcamp-chatadmin-${runId}@example.test`, 'ChatAdminUser')
  const player = await registerAndLogin(port, `adcamp-player-${runId}@example.test`, 'NormalPlayer')
  const viewer = await registerAndLogin(port, `adcamp-viewer-${runId}@example.test`, 'ViewerPlayer')

  promoteAccount(iso.dbFile, `adcamp-admin-${runId}@example.test`, 'admin')
  promoteAccount(iso.dbFile, `adcamp-pikateam-${runId}@example.test`, 'pika_team')
  promoteAccount(iso.dbFile, `adcamp-subadmin-${runId}@example.test`, 'subadmin')
  promoteAccount(iso.dbFile, `adcamp-chatadmin-${runId}@example.test`, 'chat_admin')

  console.log('=== Section A: Authorization matrix ===\n')

  await check('[A1] admin GET list -> 200', async () => {
    const r = await httpGetJson(port, '/api/admin/ad-campaigns', admin.cookie)
    assert(r.status === 200, `очаквано 200, получено ${r.status}`)
  })
  await check('[A2] pika_team GET list -> 200', async () => {
    const r = await httpGetJson(port, '/api/admin/ad-campaigns', pikaTeam.cookie)
    assert(r.status === 200, `очаквано 200, получено ${r.status}`)
  })
  await check('[A3] player GET list -> 403', async () => {
    const r = await httpGetJson(port, '/api/admin/ad-campaigns', player.cookie)
    assert(r.status === 403, `очаквано 403, получено ${r.status}`)
  })
  await check('[A4] subadmin GET list -> 403 (само admin/pika_team, не subadmin)', async () => {
    const r = await httpGetJson(port, '/api/admin/ad-campaigns', subadmin.cookie)
    assert(r.status === 403, `очаквано 403, получено ${r.status}`)
  })
  await check('[A5] chat_admin GET list -> 403', async () => {
    const r = await httpGetJson(port, '/api/admin/ad-campaigns', chatAdmin.cookie)
    assert(r.status === 403, `очаквано 403, получено ${r.status}`)
  })
  await check('[A6] unauthenticated GET list -> 401/403', async () => {
    const r = await httpGetJson(port, '/api/admin/ad-campaigns', undefined)
    assert(r.status === 401 || r.status === 403, `очаквано 401/403, получено ${r.status}`)
  })
  await check('[A7] player POST create -> 403', async () => {
    const r = await httpPostJson(port, '/api/admin/ad-campaigns', player.cookie, { imageDataUrl: VALID_IMAGE_DATA_URL, targetUrl: '/tournaments' })
    assert(r.status === 403, `очаквано 403, получено ${r.status}`)
  })
  await check('[A8] player POST send -> 403', async () => {
    const r = await httpPostJson(port, '/api/admin/ad-campaigns/nonexistent/send', player.cookie, {})
    assert(r.status === 403, `очаквано 403, получено ${r.status}`)
  })
  await check('[A9] player DELETE -> 403', async () => {
    const r = await httpDeleteJson(port, '/api/admin/ad-campaigns/nonexistent', player.cookie)
    assert(r.status === 403, `очаквано 403, получено ${r.status}`)
  })

  console.log('\n=== Section B: CRUD lifecycle + shared visibility + audit ===\n')

  let campaignId = ''

  await check('[B1] admin създава кампания -> 200, dispatchCount=0', async () => {
    const r = await httpPostJson(port, '/api/admin/ad-campaigns', admin.cookie, {
      imageDataUrl: VALID_IMAGE_DATA_URL,
      targetUrl: '/tournaments',
    })
    assert(r.status === 200, `очаквано 200, получено ${r.status}: ${JSON.stringify(r.body)}`)
    const body = r.body as { ok: boolean; campaign?: CampaignDto }
    assert(body.ok && !!body.campaign, 'липсва campaign в отговора')
    campaignId = body.campaign!.campaignId
    assertEqual(body.campaign!.dispatchCount, 0, 'dispatchCount при създаване')
    assertEqual(body.campaign!.lastDispatchAt, null, 'lastDispatchAt при създаване')
    assertEqual(body.campaign!.createdByRole, 'admin', 'createdByRole')
  })

  await check('[B2] pika_team вижда СЪЩАТА кампания в своя list (shared, creator-agnostic)', async () => {
    const r = await httpGetJson(port, '/api/admin/ad-campaigns', pikaTeam.cookie)
    const body = r.body as { ok: boolean; campaigns: CampaignDto[] }
    assert(body.campaigns.some((c) => c.campaignId === campaignId), 'pika_team не вижда admin-създадената кампания')
  })

  await check('[B3] pika_team изпраща кампанията (не е creator-ът) -> dispatchCount=1', async () => {
    const r = await httpPostJson(port, `/api/admin/ad-campaigns/${campaignId}/send`, pikaTeam.cookie, {})
    assert(r.status === 200, `очаквано 200, получено ${r.status}: ${JSON.stringify(r.body)}`)
    const body = r.body as { ok: boolean; campaign?: CampaignDto }
    assertEqual(body.campaign?.dispatchCount, 1, 'dispatchCount след 1-во изпращане')
    assert(body.campaign?.lastDispatchAt !== null, 'lastDispatchAt трябва да е зададен')
  })

  await check('[B4] повторно изпращане (от admin) -> dispatchCount=2, различни dispatch_id', async () => {
    const before = new DatabaseSync(iso.dbFile, { open: true, enableForeignKeyConstraints: true })
    const beforeIds = (before.prepare(`SELECT dispatch_id FROM ad_campaign_dispatches WHERE campaign_id = ?;`).all(campaignId) as { dispatch_id: string }[]).map((r) => r.dispatch_id)
    before.close()

    const r = await httpPostJson(port, `/api/admin/ad-campaigns/${campaignId}/send`, admin.cookie, {})
    assert(r.status === 200, `очаквано 200, получено ${r.status}`)
    const body = r.body as { campaign?: CampaignDto }
    assertEqual(body.campaign?.dispatchCount, 2, 'dispatchCount след 2-ро изпращане')

    const after = new DatabaseSync(iso.dbFile, { open: true, enableForeignKeyConstraints: true })
    const afterIds = (after.prepare(`SELECT dispatch_id FROM ad_campaign_dispatches WHERE campaign_id = ?;`).all(campaignId) as { dispatch_id: string }[]).map((r) => r.dispatch_id)
    after.close()

    assertEqual(afterIds.length, 2, 'общ брой dispatch редове в DB')
    assert(beforeIds.length === 1 && afterIds.includes(beforeIds[0]!), 'първият dispatch_id трябва да остане непроменен')
    assert(new Set(afterIds).size === 2, 'двата dispatch_id трябва да са различни')
  })

  await check('[B5] audit колони коректни в DB (created_by/sent_by profile_id+role)', async () => {
    const db = new DatabaseSync(iso.dbFile, { open: true, enableForeignKeyConstraints: true })
    const campaignRow = db.prepare(`SELECT created_by_profile_id, created_by_role FROM ad_campaigns WHERE campaign_id = ?;`).get(campaignId) as
      { created_by_profile_id: string; created_by_role: string }
    const dispatchRows = db.prepare(`SELECT sent_by_profile_id, sent_by_role FROM ad_campaign_dispatches WHERE campaign_id = ? ORDER BY sent_at ASC;`).all(campaignId) as
      { sent_by_profile_id: string; sent_by_role: string }[]
    db.close()

    assertEqual(campaignRow.created_by_profile_id, admin.profileId, 'created_by_profile_id')
    assertEqual(campaignRow.created_by_role, 'admin', 'created_by_role')
    assertEqual(dispatchRows.length, 2, 'брой dispatch редове за audit проверка')
    assertEqual(dispatchRows[0]!.sent_by_profile_id, pikaTeam.profileId, 'sent_by_profile_id на 1-вия dispatch (pika_team)')
    assertEqual(dispatchRows[0]!.sent_by_role, 'pika_team', 'sent_by_role на 1-вия dispatch')
    assertEqual(dispatchRows[1]!.sent_by_profile_id, admin.profileId, 'sent_by_profile_id на 2-рия dispatch (admin)')
    assertEqual(dispatchRows[1]!.sent_by_role, 'admin', 'sent_by_role на 2-рия dispatch')
  })

  await check('[B6] create с невалидна снимка -> 400', async () => {
    const r = await httpPostJson(port, '/api/admin/ad-campaigns', admin.cookie, {
      imageDataUrl: toDataUrl('png', garbageBuffer),
      targetUrl: '/tournaments',
    })
    assert(r.status === 400, `очаквано 400, получено ${r.status}`)
  })

  await check('[B7] create с невалиден target URL (javascript:) -> 400', async () => {
    const r = await httpPostJson(port, '/api/admin/ad-campaigns', admin.cookie, {
      imageDataUrl: VALID_IMAGE_DATA_URL,
      targetUrl: 'javascript:alert(1)',
    })
    assert(r.status === 400, `очаквано 400, получено ${r.status}`)
  })

  await check('[B8] admin изтрива кампанията -> 200', async () => {
    const r = await httpDeleteJson(port, `/api/admin/ad-campaigns/${campaignId}`, admin.cookie)
    assert(r.status === 200, `очаквано 200, получено ${r.status}: ${JSON.stringify(r.body)}`)
  })

  await check('[B9] изтритата кампания изчезва от списъка (за admin И pika_team)', async () => {
    const adminList = (await httpGetJson(port, '/api/admin/ad-campaigns', admin.cookie)).body as { campaigns: CampaignDto[] }
    const pikaList = (await httpGetJson(port, '/api/admin/ad-campaigns', pikaTeam.cookie)).body as { campaigns: CampaignDto[] }
    assert(!adminList.campaigns.some((c) => c.campaignId === campaignId), 'admin все още вижда изтритата кампания')
    assert(!pikaList.campaigns.some((c) => c.campaignId === campaignId), 'pika_team все още вижда изтритата кампания')
  })

  await check('[B10] send на изтрита кампания -> 404', async () => {
    const r = await httpPostJson(port, `/api/admin/ad-campaigns/${campaignId}/send`, admin.cookie, {})
    assert(r.status === 404, `очаквано 404, получено ${r.status}`)
  })

  await check('[B11] delete на вече изтрита кампания -> 404', async () => {
    const r = await httpDeleteJson(port, `/api/admin/ad-campaigns/${campaignId}`, pikaTeam.cookie)
    assert(r.status === 404, `очаквано 404, получено ${r.status}`)
  })

  console.log('\n=== Section E: Endpoint-specific upload hardening (create) ===\n')

  function countCampaignRows(): number {
    const db = new DatabaseSync(iso.dbFile, { open: true, enableForeignKeyConstraints: true })
    const row = db.prepare(`SELECT COUNT(*) AS cnt FROM ad_campaigns;`).get() as { cnt: number }
    db.close()
    return row.cnt
  }

  await check('[E1] malformed data URL (изобщо не data:image/...;base64,...) -> 400, НЕ остава campaign ред', async () => {
    const before = countCampaignRows()
    const r = await httpPostJson(port, '/api/admin/ad-campaigns', admin.cookie, {
      imageDataUrl: 'not a data url at all',
      targetUrl: '/tournaments',
    })
    assert(r.status === 400, `очаквано 400, получено ${r.status}`)
    assertEqual(countCampaignRows(), before, 'campaign redovete в DB преди/след malformed опит')
  })

  await check('[E2] невалиден (нерazпознат) MIME префикс в data URL -> 400, НЕ остава campaign ред', async () => {
    const before = countCampaignRows()
    const r = await httpPostJson(port, '/api/admin/ad-campaigns', admin.cookie, {
      imageDataUrl: 'data:text/plain;base64,aGVsbG8=',
      targetUrl: '/tournaments',
    })
    assert(r.status === 400, `очаквано 400, получено ${r.status}`)
    assertEqual(countCampaignRows(), before, 'campaign redovete в DB преди/след невалиден MIME опит')
  })

  await check('[E3] неподдържан image формат (GIF, извън png/jpeg/webp allowlist-а) -> 400, НЕ остава campaign ред', async () => {
    const before = countCampaignRows()
    const r = await httpPostJson(port, '/api/admin/ad-campaigns', admin.cookie, {
      // decodeImageAttachmentDataUrl regex-ът позволява само image/(png|jpe?g|webp)
      // в самия data: префикс — GIF байтове с "image/gif" префикс отпадат тук,
      // преди дори да стигнат до sharp validation-а.
      imageDataUrl: `data:image/gif;base64,${gifBuffer.toString('base64')}`,
      targetUrl: '/tournaments',
    })
    assert(r.status === 400, `очаквано 400, получено ${r.status}`)
    assertEqual(countCampaignRows(), before, 'campaign redovete в DB преди/след GIF опит')
  })

  await check('[E4] празен imageDataUrl -> 400, НЕ остава campaign ред', async () => {
    const before = countCampaignRows()
    const r = await httpPostJson(port, '/api/admin/ad-campaigns', admin.cookie, {
      imageDataUrl: '',
      targetUrl: '/tournaments',
    })
    assert(r.status === 400, `очаквано 400, получено ${r.status}`)
    assertEqual(countCampaignRows(), before, 'campaign redovete в DB преди/след празен imageDataUrl')
  })

  await check('[E5] unsafe target URL (data:) -> 400, НЕ остава campaign ред', async () => {
    const before = countCampaignRows()
    const r = await httpPostJson(port, '/api/admin/ad-campaigns', admin.cookie, {
      imageDataUrl: VALID_IMAGE_DATA_URL,
      targetUrl: 'data:text/html,<script>alert(1)</script>',
    })
    assert(r.status === 400, `очаквано 400, получено ${r.status}`)
    assertEqual(countCampaignRows(), before, 'campaign redovete в DB преди/след unsafe target URL опит')
  })

  await check('[E6] unsafe target URL (//protocol-relative) -> 400, НЕ остава campaign ред', async () => {
    const before = countCampaignRows()
    const r = await httpPostJson(port, '/api/admin/ad-campaigns', admin.cookie, {
      imageDataUrl: VALID_IMAGE_DATA_URL,
      targetUrl: '//evil.com/phish',
    })
    assert(r.status === 400, `очаквано 400, получено ${r.status}`)
    assertEqual(countCampaignRows(), before, 'campaign redovete в DB преди/след protocol-relative опит')
  })

  await check('[E7] валиден create (regression sanity) -> campaign редът СЕ добавя точно с 1', async () => {
    const before = countCampaignRows()
    const r = await httpPostJson(port, '/api/admin/ad-campaigns', admin.cookie, {
      imageDataUrl: VALID_IMAGE_DATA_URL,
      targetUrl: '/tournaments',
    })
    assert(r.status === 200, `очаквано 200, получено ${r.status}`)
    assertEqual(countCampaignRows(), before + 1, 'campaign redovete нараства с точно 1 при валиден create')
    const cId = (r.body as { campaign: CampaignDto }).campaign.campaignId
    await httpDeleteJson(port, `/api/admin/ad-campaigns/${cId}`, admin.cookie)
  })

  // [Rollback cleanup при DB failure след успешен file write] — НЕ е
  // безопасно/практично да се тества end-to-end тук: campaign_id е randomUUID(),
  // а единствените DB write грешки биха дошли от истинска SQLite/диск грешка,
  // която не може да се предизвика легитимно през HTTP входа без fault-injection
  // seam (извън обхвата на този hardening pass). Rollback пътят
  // (`deleteAttachmentFileByFilename` при !result.ok след успешен file write,
  // index.ts handleAdminAdCampaignsRequest create branch) е прегледан ръчно в
  // кода — идентичен на established pattern-а в createTopicAttachmentUpload.

  console.log('\n=== Section C: Delivery state machine (WS) ===\n')

  async function createAndSendCampaign(targetUrl = '/tournaments'): Promise<string> {
    const createRes = await httpPostJson(port, '/api/admin/ad-campaigns', admin.cookie, {
      imageDataUrl: VALID_IMAGE_DATA_URL,
      targetUrl,
    })
    const created = (createRes.body as { campaign: CampaignDto }).campaign
    await httpPostJson(port, `/api/admin/ad-campaigns/${created.campaignId}/send`, admin.cookie, {})
    return created.campaignId
  }

  await check('[C1] Checkpoint A: нов WS connect веднага получава pending dispatch', async () => {
    const cId = await createAndSendCampaign()
    const ws = await openWs(port, viewer.cookie)
    try {
      const msg = await waitForWsMessage(ws, (m) => m.type === 'ad_campaign_pending_ads')
      const dispatches = (msg as { dispatches: { campaignId: string }[] }).dispatches
      assert(dispatches.some((d) => d.campaignId === cId), 'pending push не съдържа новосъздадената+изпратена кампания')
    } finally {
      ws.close()
      await httpDeleteJson(port, `/api/admin/ad-campaigns/${cId}`, admin.cookie)
    }
  })

  await check('[C2] Checkpoint C: fan-out веднага след "Изпрати" към вече свързан idle клиент', async () => {
    const ws = await openWs(port, viewer.cookie)
    try {
      // Изчистваме евентуален Checkpoint A push от connect-а, преди да следим за новия.
      await sleep(300)
      const createRes = await httpPostJson(port, '/api/admin/ad-campaigns', admin.cookie, {
        imageDataUrl: VALID_IMAGE_DATA_URL,
        targetUrl: '/tournaments',
      })
      const cId = (createRes.body as { campaign: CampaignDto }).campaign.campaignId
      await httpPostJson(port, `/api/admin/ad-campaigns/${cId}/send`, admin.cookie, {})

      const msg = await waitForWsMessage(ws, (m) =>
        m.type === 'ad_campaign_pending_ads' &&
        (m as { dispatches: { campaignId: string }[] }).dispatches.some((d) => d.campaignId === cId),
      )
      assert(msg !== undefined, 'не получи fan-out push веднага след Изпрати')
      await httpDeleteJson(port, `/api/admin/ad-campaigns/${cId}`, admin.cookie)
    } finally {
      ws.close()
    }
  })

  await check('[C3] Dismiss персистира — same dispatch не се връща при нов connect', async () => {
    const cId = await createAndSendCampaign()
    const ws1 = await openWs(port, viewer.cookie)
    const msg = await waitForWsMessage(ws1, (m) => m.type === 'ad_campaign_pending_ads')
    const dispatchId = (msg as { dispatches: { campaignId: string; dispatchId: string }[] }).dispatches.find((d) => d.campaignId === cId)!.dispatchId
    sendWs(ws1, { type: 'ad_campaign_dismiss', dispatchId })
    await sleep(300)
    ws1.close()

    const ws2 = await openWs(port, viewer.cookie)
    try {
      await assertNoWsMessage(ws2, (m) =>
        m.type === 'ad_campaign_pending_ads' &&
        (m as { dispatches: { dispatchId: string }[] }).dispatches.some((d) => d.dispatchId === dispatchId),
      )
    } finally {
      ws2.close()
      await httpDeleteJson(port, `/api/admin/ad-campaigns/${cId}`, admin.cookie)
    }
  })

  await check('[C4] Repeated send (Send#2 след dismiss на Send#1) СЕ показва пак', async () => {
    const createRes = await httpPostJson(port, '/api/admin/ad-campaigns', admin.cookie, {
      imageDataUrl: VALID_IMAGE_DATA_URL,
      targetUrl: '/tournaments',
    })
    const cId = (createRes.body as { campaign: CampaignDto }).campaign.campaignId
    await httpPostJson(port, `/api/admin/ad-campaigns/${cId}/send`, admin.cookie, {})

    const ws1 = await openWs(port, viewer.cookie)
    const firstMsg = await waitForWsMessage(ws1, (m) => m.type === 'ad_campaign_pending_ads')
    const firstDispatchId = (firstMsg as { dispatches: { campaignId: string; dispatchId: string }[] }).dispatches.find((d) => d.campaignId === cId)!.dispatchId
    sendWs(ws1, { type: 'ad_campaign_dismiss', dispatchId: firstDispatchId })
    await sleep(300)
    ws1.close()

    // Send #2 — независим dispatch на СЪЩАТА campaign.
    await httpPostJson(port, `/api/admin/ad-campaigns/${cId}/send`, admin.cookie, {})

    const ws2 = await openWs(port, viewer.cookie)
    try {
      const secondMsg = await waitForWsMessage(ws2, (m) =>
        m.type === 'ad_campaign_pending_ads' &&
        (m as { dispatches: { campaignId: string; dispatchId: string }[] }).dispatches.some((d) => d.campaignId === cId),
      )
      const secondDispatchId = (secondMsg as { dispatches: { campaignId: string; dispatchId: string }[] }).dispatches.find((d) => d.campaignId === cId)!.dispatchId
      assert(secondDispatchId !== firstDispatchId, 'Send#2 трябва да е НОВ, различен dispatch_id')
    } finally {
      ws2.close()
      await httpDeleteJson(port, `/api/admin/ad-campaigns/${cId}`, admin.cookie)
    }
  })

  await check('[C5] Multi-tab: dismiss в tab1 праща ad_campaign_dispatch_invalidated в tab2', async () => {
    const cId = await createAndSendCampaign()
    const tab1 = await openWs(port, viewer.cookie)
    const tab2 = await openWs(port, viewer.cookie)
    try {
      const msg1 = await waitForWsMessage(tab1, (m) => m.type === 'ad_campaign_pending_ads')
      const dispatchId = (msg1 as { dispatches: { campaignId: string; dispatchId: string }[] }).dispatches.find((d) => d.campaignId === cId)!.dispatchId

      sendWs(tab1, { type: 'ad_campaign_dismiss', dispatchId })

      const invalidated = await waitForWsMessage(tab2, (m) => m.type === 'ad_campaign_dispatch_invalidated' && m.dispatchId === dispatchId)
      assert(invalidated !== undefined, 'tab2 не получи invalidation')
    } finally {
      tab1.close()
      tab2.close()
      await httpDeleteJson(port, `/api/admin/ad-campaigns/${cId}`, admin.cookie)
    }
  })

  await check('[C6] Offline-then-deleted: campaign изтрита ПРЕДИ login -> НИКОГА не се доставя', async () => {
    const cId = await createAndSendCampaign()
    // "offline" симулация — profile-ът НЕ е свързан през целия този период.
    await httpDeleteJson(port, `/api/admin/ad-campaigns/${cId}`, admin.cookie)

    const ws = await openWs(port, viewer.cookie)
    try {
      await assertNoWsMessage(ws, (m) =>
        m.type === 'ad_campaign_pending_ads' &&
        (m as { dispatches: { campaignId: string }[] }).dispatches.some((d) => d.campaignId === cId),
      )
    } finally {
      ws.close()
    }
  })

  await check('[C7] Delete докато клиент е online с pending ad -> получава ad_campaign_deleted realtime', async () => {
    const cId = await createAndSendCampaign()
    const ws = await openWs(port, viewer.cookie)
    try {
      await waitForWsMessage(ws, (m) =>
        m.type === 'ad_campaign_pending_ads' &&
        (m as { dispatches: { campaignId: string }[] }).dispatches.some((d) => d.campaignId === cId),
      )
      await httpDeleteJson(port, `/api/admin/ad-campaigns/${cId}`, admin.cookie)
      const deletedMsg = await waitForWsMessage(ws, (m) => m.type === 'ad_campaign_deleted' && m.campaignId === cId)
      assert(deletedMsg !== undefined, 'клиентът не получи ad_campaign_deleted')
    } finally {
      ws.close()
    }
  })

  await check('[C8] Management realtime sync: create/dispatch/delete от единия се виждат от другия', async () => {
    const adminWs = await openWs(port, admin.cookie)
    const pikaWs = await openWs(port, pikaTeam.cookie)
    try {
      sendWs(pikaWs, { type: 'subscribe_ad_campaign_management' })
      await sleep(200)

      const createRes = await httpPostJson(port, '/api/admin/ad-campaigns', admin.cookie, {
        imageDataUrl: VALID_IMAGE_DATA_URL,
        targetUrl: '/tournaments',
      })
      const cId = (createRes.body as { campaign: CampaignDto }).campaign.campaignId

      const createdMsg = await waitForWsMessage(pikaWs, (m) => m.type === 'ad_campaign_management_created' && (m as { campaign: CampaignDto }).campaign.campaignId === cId)
      assert(createdMsg !== undefined, 'pika_team management view не видя ad_campaign_management_created')

      sendWs(adminWs, { type: 'subscribe_ad_campaign_management' })
      await sleep(200)

      await httpPostJson(port, `/api/admin/ad-campaigns/${cId}/send`, pikaTeam.cookie, {})
      const dispatchedMsg = await waitForWsMessage(adminWs, (m) => m.type === 'ad_campaign_management_dispatched' && (m as { campaign: CampaignDto }).campaign.campaignId === cId)
      assert(dispatchedMsg !== undefined, 'admin management view не видя ad_campaign_management_dispatched')

      await httpDeleteJson(port, `/api/admin/ad-campaigns/${cId}`, admin.cookie)
      const deletedMsg = await waitForWsMessage(pikaWs, (m) => m.type === 'ad_campaign_management_deleted' && m.campaignId === cId)
      assert(deletedMsg !== undefined, 'pika_team management view не видя ad_campaign_management_deleted')
    } finally {
      adminWs.close()
      pikaWs.close()
    }
  })

  console.log('\n=== Section D: Case B — in-game defer (реален private-room + bots, БЕЗ нужда от 4-играчна маса) ===\n')

  // isProfileInActiveGame(profileId) (index.ts) проверява room.status==='playing'
  // И participant.permanentlyLeftAt==null. initializeRoomAuthoritativeGameState
  // (извикана веднага при private_room_full) сеща room.status='playing' МНОГО
  // преди cutting/bidding/dealing да приключат — значи не ни трябва auto-drive
  // на cutting/bidding изобщо, само да стигнем до private_room_full, за да имаме
  // РЕАЛЕН profile в РЕАЛНА 'playing' стая, без 4 истински човешки участници.
  // "Излизане от играта" (за requirement D — game-finished сам по себе си не е
  // trigger) постигаме чрез leave_active_room (permanentlyLeftAt се сеща
  // веднага, isProfileInActiveGame връща false, без да чакаме целия мач да свърши).
  async function setupInGameProfile(suffix: string): Promise<{
    inGameUser: { cookie: string; profileId: string }
    inGameWs: WebSocket
    roomId: string
  }> {
    const host = await registerAndLogin(port, `adcamp-host-${suffix}@example.test`, 'HostUser')
    const inGameUser = await registerAndLogin(port, `adcamp-ingame-${suffix}@example.test`, 'InGameUser')

    const hostWs = await openWs(port, host.cookie)
    const inGameWs = await openWs(port, inGameUser.cookie)

    function occupiedCount(m: AnyMsg): number {
      return (m as { room?: { slots?: { occupant: unknown }[] } }).room?.slots?.filter((s) => s.occupant !== null).length ?? 0
    }

    sendWs(hostWs, { type: 'create_private_room', stake: 5000, isLocked: false })
    const created = await waitForWsMessage(hostWs, (m) => m.type === 'private_room_updated', 15_000)
    const privateRoomId = (created as { room: { id: string } }).room.id

    sendWs(inGameWs, { type: 'join_private_room', privateRoomId, team: 'B', slotIndex: 0 })
    await waitForWsMessage(hostWs, (m) => m.type === 'private_room_updated' && occupiedCount(m) === 2, 15_000)

    sendWs(hostWs, { type: 'add_bot_to_private_room_team', team: 'A' })
    await waitForWsMessage(hostWs, (m) => m.type === 'private_room_updated' && occupiedCount(m) === 3, 15_000)

    sendWs(inGameWs, { type: 'add_bot_to_private_room_team', team: 'B' })
    const fullMsg = await waitForWsMessage(inGameWs, (m) => m.type === 'private_room_full', 15_000)
    const roomId = (fullMsg as { roomId: string }).roomId

    // room_snapshot потвърждава, че seat binding-ът е приключил — само тогава
    // isProfileInActiveGame() със сигурност вижда profile-а седнал в стаята.
    await waitForWsMessage(inGameWs, (m) => m.type === 'room_snapshot' && (m as { roomId: string }).roomId === roomId, 15_000)

    return { inGameUser, inGameWs, roomId }
  }

  let inGameCtx: { inGameUser: { cookie: string; profileId: string }; inGameWs: WebSocket; roomId: string } | null = null
  let dCampaign1 = ''
  let dCampaign2 = ''

  await check('[D-setup] private room bot-fill стига до private_room_full/room_snapshot -> profile е РЕАЛНО seated в "playing" стая', async () => {
    inGameCtx = await setupInGameProfile(`${Date.now()}-${process.pid}`)
    assert(inGameCtx.roomId.length > 0, 'roomId не е получен')
  })

  await check('[D1] (A+C) pending valid dispatch съществува, но "Изпрати" fan-out НЕ го доставя докато profile-ът е in-active-game', async () => {
    const ctx = inGameCtx!
    const createRes = await httpPostJson(port, '/api/admin/ad-campaigns', admin.cookie, { imageDataUrl: VALID_IMAGE_DATA_URL, targetUrl: '/tournaments' })
    dCampaign1 = (createRes.body as { campaign: CampaignDto }).campaign.campaignId
    await httpPostJson(port, `/api/admin/ad-campaigns/${dCampaign1}/send`, admin.cookie, {})

    await assertNoWsMessage(ctx.inGameWs, (m) =>
      m.type === 'ad_campaign_pending_ads' &&
      (m as { dispatches: { campaignId: string }[] }).dispatches.some((d) => d.campaignId === dCampaign1),
    )
  })

  await check('[D2] (C) explicit request_pending_ad_campaigns докато е in-game -> пак нищо (re-validate-нато, не cache miss)', async () => {
    const ctx = inGameCtx!
    sendWs(ctx.inGameWs, { type: 'request_pending_ad_campaigns' })
    await assertNoWsMessage(ctx.inGameWs, (m) =>
      m.type === 'ad_campaign_pending_ads' &&
      (m as { dispatches: { campaignId: string }[] }).dispatches.some((d) => d.campaignId === dCampaign1),
    )
  })

  await check('[D3] (B+C) Checkpoint A: НОВ connect (втори tab, same profile) за in-game профил също НЕ получава pending dispatch', async () => {
    const ctx = inGameCtx!
    const secondTab = await openWs(port, ctx.inGameUser.cookie)
    try {
      // Потвърждаваме, че вторият tab реално мина по reconnect-в-игра пътя
      // (session_in_game) — доказва, че profile-ът действително е разпознат
      // като in-active-game от сървъра в момента на connect, не просто
      // "не получихме нищо, защото не изчакахме достатъчно".
      await waitForWsMessage(secondTab, (m) => m.type === 'session_in_game', 10_000)
      await assertNoWsMessage(secondTab, (m) =>
        m.type === 'ad_campaign_pending_ads' &&
        (m as { dispatches: { campaignId: string }[] }).dispatches.some((d) => d.campaignId === dCampaign1),
      )
    } finally {
      secondTab.close()
    }
  })

  await check('[D-setup2] втора pending campaign, докато все още е in-game (подготовка за G — delete преди Lobby entry)', async () => {
    const ctx = inGameCtx!
    const createRes = await httpPostJson(port, '/api/admin/ad-campaigns', admin.cookie, { imageDataUrl: VALID_IMAGE_DATA_URL, targetUrl: '/tournaments' })
    dCampaign2 = (createRes.body as { campaign: CampaignDto }).campaign.campaignId
    await httpPostJson(port, `/api/admin/ad-campaigns/${dCampaign2}/send`, admin.cookie, {})
    await assertNoWsMessage(ctx.inGameWs, (m) =>
      m.type === 'ad_campaign_pending_ads' &&
      (m as { dispatches: { campaignId: string }[] }).dispatches.some((d) => d.campaignId === dCampaign2),
    )
  })

  await check('[D4] (D) доброволно напускане ("game-finished" analog) САМО ПО СЕБЕ СИ НЕ Е delivery trigger', async () => {
    const ctx = inGameCtx!
    sendWs(ctx.inGameWs, { type: 'leave_active_room', roomId: ctx.roomId, acceptPenalty: true })
    await waitForWsMessage(ctx.inGameWs, (m) => m.type === 'left_active_room', 10_000)
    // Изчакваме отвъд нормалния propagation прозорец — НИКАКЪВ push не трябва
    // да пристигне автоматично само защото profile-ът вече не е in-active-game;
    // доставката минава ЕДИНСТВЕНО през явния request_pending_ad_campaigns hook.
    await assertNoWsMessage(ctx.inGameWs, (m) => m.type === 'ad_campaign_pending_ads', 1200)
  })

  await check('[D5] (G) campaign, изтрита ПРЕДИ реалния Lobby entry, никога не бива доставена', async () => {
    const r = await httpDeleteJson(port, `/api/admin/ad-campaigns/${dCampaign2}`, admin.cookie)
    assert(r.status === 200, `delete на dCampaign2 трябва да успее, получено ${r.status}`)
  })

  await check('[D6] (E+F) реалният Lobby-entry hook доставя все още валидния dispatch, но НЕ изтрития', async () => {
    const ctx = inGameCtx!
    sendWs(ctx.inGameWs, { type: 'request_pending_ad_campaigns' })
    const msg = await waitForWsMessage(ctx.inGameWs, (m) => m.type === 'ad_campaign_pending_ads', 10_000)
    const dispatches = (msg as { dispatches: { campaignId: string }[] }).dispatches
    assert(dispatches.some((d) => d.campaignId === dCampaign1), 'dCampaign1 (все още валидна) трябва да се достави при реален Lobby entry')
    assert(!dispatches.some((d) => d.campaignId === dCampaign2), 'dCampaign2 (изтрита преди Lobby entry) НИКОГА не трябва да се достави')

    ctx.inGameWs.close()
    await httpDeleteJson(port, `/api/admin/ad-campaigns/${dCampaign1}`, admin.cookie)
  })

  console.log('\n=== Section F: Multiple offline dispatches (Send#1/#2/#3 докато профилът е offline) ===\n')

  await check('[F1] 3 sends към offline профил -> ЕДИН push с всичките 3, sent_at ASC ред, различни dispatch_id', async () => {
    const createRes = await httpPostJson(port, '/api/admin/ad-campaigns', admin.cookie, { imageDataUrl: VALID_IMAGE_DATA_URL, targetUrl: '/tournaments' })
    const cId = (createRes.body as { campaign: CampaignDto }).campaign.campaignId

    // "offline" симулация — viewer НЕ е свързан през целите 3 send-а.
    await httpPostJson(port, `/api/admin/ad-campaigns/${cId}/send`, admin.cookie, {})
    await sleep(50)
    await httpPostJson(port, `/api/admin/ad-campaigns/${cId}/send`, admin.cookie, {})
    await sleep(50)
    await httpPostJson(port, `/api/admin/ad-campaigns/${cId}/send`, admin.cookie, {})

    const ws = await openWs(port, viewer.cookie)
    try {
      const msg = await waitForWsMessage(ws, (m) =>
        m.type === 'ad_campaign_pending_ads' &&
        (m as { dispatches: { campaignId: string }[] }).dispatches.filter((d) => d.campaignId === cId).length === 3,
      )
      const dispatches = (msg as { dispatches: { campaignId: string; dispatchId: string; sentAt: string }[] })
        .dispatches.filter((d) => d.campaignId === cId)
      assertEqual(dispatches.length, 3, 'трите send-а трябва да пристигнат в ЕДИН push (не 3 отделни съобщения)')
      const sentAtTimes = dispatches.map((d) => new Date(d.sentAt).getTime())
      assert(sentAtTimes[0]! <= sentAtTimes[1]! && sentAtTimes[1]! <= sentAtTimes[2]!, 'dispatch-ите трябва да са в sent_at ASC ред')
      assertEqual(new Set(dispatches.map((d) => d.dispatchId)).size, 3, 'трите dispatch_id трябва да са различни')
    } finally {
      ws.close()
      await httpDeleteJson(port, `/api/admin/ad-campaigns/${cId}`, admin.cookie)
    }
  })

  await check('[F2] delete на campaign СЛЕД serия sends, но ПРЕДИ login -> нито един от опашката не оцелява', async () => {
    const createRes = await httpPostJson(port, '/api/admin/ad-campaigns', admin.cookie, { imageDataUrl: VALID_IMAGE_DATA_URL, targetUrl: '/tournaments' })
    const cId = (createRes.body as { campaign: CampaignDto }).campaign.campaignId
    await httpPostJson(port, `/api/admin/ad-campaigns/${cId}/send`, admin.cookie, {})
    await httpPostJson(port, `/api/admin/ad-campaigns/${cId}/send`, admin.cookie, {})
    await httpDeleteJson(port, `/api/admin/ad-campaigns/${cId}`, admin.cookie)

    const ws = await openWs(port, viewer.cookie)
    try {
      await assertNoWsMessage(ws, (m) =>
        m.type === 'ad_campaign_pending_ads' &&
        (m as { dispatches: { campaignId: string }[] }).dispatches.some((d) => d.campaignId === cId),
      )
    } finally {
      ws.close()
    }
  })

  console.log('\n=== Section G: Same-instance cross-poll duplicate delivery guard ===\n')

  await check('[G1] "Изпрати" fan-out доставя dispatch-а ТОЧНО ВЕДНЪЖ (poll ~700ms по-късно НЕ дублира)', async () => {
    const ws = await openWs(port, viewer.cookie)
    try {
      await sleep(300) // изчистваме евентуален Checkpoint A push от самия connect
      const createRes = await httpPostJson(port, '/api/admin/ad-campaigns', admin.cookie, { imageDataUrl: VALID_IMAGE_DATA_URL, targetUrl: '/tournaments' })
      const cId = (createRes.body as { campaign: CampaignDto }).campaign.campaignId
      await httpPostJson(port, `/api/admin/ad-campaigns/${cId}/send`, admin.cookie, {})

      await waitForWsMessage(ws, (m) =>
        m.type === 'ad_campaign_pending_ads' &&
        (m as { dispatches: { campaignId: string }[] }).dispatches.some((d) => d.campaignId === cId),
      )
      await sleep(1500) // > AD_CAMPAIGN_EVENTS_POLL_INTERVAL_MS (700ms) — поне 1 poll tick мина

      const count = countWsMessages(ws, (m) =>
        m.type === 'ad_campaign_pending_ads' &&
        (m as { dispatches: { campaignId: string }[] }).dispatches.some((d) => d.campaignId === cId),
      )
      assertEqual(count, 1, 'dispatch-ът НЕ трябва да бъде доставен повторно от cross-instance poll-а на same-instance connections')
      await httpDeleteJson(port, `/api/admin/ad-campaigns/${cId}`, admin.cookie)
    } finally {
      ws.close()
    }
  })

  await check('[G2] Delete broadcast-ва ad_campaign_deleted ТОЧНО ВЕДНЪЖ (poll не дублира)', async () => {
    const cId = await createAndSendCampaign()
    const ws = await openWs(port, viewer.cookie)
    try {
      await waitForWsMessage(ws, (m) =>
        m.type === 'ad_campaign_pending_ads' &&
        (m as { dispatches: { campaignId: string }[] }).dispatches.some((d) => d.campaignId === cId),
      )
      await httpDeleteJson(port, `/api/admin/ad-campaigns/${cId}`, admin.cookie)
      await waitForWsMessage(ws, (m) => m.type === 'ad_campaign_deleted' && m.campaignId === cId)
      await sleep(1500)
      const count = countWsMessages(ws, (m) => m.type === 'ad_campaign_deleted' && m.campaignId === cId)
      assertEqual(count, 1, 'ad_campaign_deleted не трябва да дублира от poll-а')
    } finally {
      ws.close()
    }
  })

  await check('[G3] Dismiss broadcast-ва ad_campaign_dispatch_invalidated ТОЧНО ВЕДНЪЖ в другия tab (poll не дублира)', async () => {
    const cId = await createAndSendCampaign()
    const tab1 = await openWs(port, viewer.cookie)
    const tab2 = await openWs(port, viewer.cookie)
    try {
      const msg1 = await waitForWsMessage(tab1, (m) => m.type === 'ad_campaign_pending_ads')
      const dispatchId = (msg1 as { dispatches: { campaignId: string; dispatchId: string }[] }).dispatches.find((d) => d.campaignId === cId)!.dispatchId

      sendWs(tab1, { type: 'ad_campaign_dismiss', dispatchId })
      await waitForWsMessage(tab2, (m) => m.type === 'ad_campaign_dispatch_invalidated' && m.dispatchId === dispatchId)
      await sleep(1500)

      const count = countWsMessages(tab2, (m) => m.type === 'ad_campaign_dispatch_invalidated' && m.dispatchId === dispatchId)
      assertEqual(count, 1, 'invalidation не трябва да дублира от poll-а')
    } finally {
      tab1.close()
      tab2.close()
      await httpDeleteJson(port, `/api/admin/ad-campaigns/${cId}`, admin.cookie)
    }
  })

  console.log('\n=== Section H: Receipt semantics (shown_at analytics-only, reconnect-преди-terminal, clicked terminal) ===\n')

  await check('[H1] shown_at е analytics-only — mark_shown НЕ прекратява pending статуса', async () => {
    const cId = await createAndSendCampaign()
    const ws1 = await openWs(port, viewer.cookie)
    const msg = await waitForWsMessage(ws1, (m) => m.type === 'ad_campaign_pending_ads')
    const dispatchId = (msg as { dispatches: { campaignId: string; dispatchId: string }[] }).dispatches.find((d) => d.campaignId === cId)!.dispatchId
    sendWs(ws1, { type: 'ad_campaign_mark_shown', dispatchId })
    await sleep(300)
    ws1.close()

    const ws2 = await openWs(port, viewer.cookie)
    try {
      const msg2 = await waitForWsMessage(ws2, (m) =>
        m.type === 'ad_campaign_pending_ads' &&
        (m as { dispatches: { dispatchId: string }[] }).dispatches.some((d) => d.dispatchId === dispatchId),
      )
      assert(msg2 !== undefined, 'dispatch-ът трябва пак да се достави след mark_shown (shown_at не е terminal)')
    } finally {
      ws2.close()
      await httpDeleteJson(port, `/api/admin/ad-campaigns/${cId}`, admin.cookie)
    }
  })

  await check('[H2] Repeated reconnect ПРЕДИ dismiss/click връща СЪЩИЯ dispatch многократно', async () => {
    const cId = await createAndSendCampaign()
    let dispatchId = ''
    for (let i = 0; i < 3; i++) {
      const ws = await openWs(port, viewer.cookie)
      const msg = await waitForWsMessage(ws, (m) =>
        m.type === 'ad_campaign_pending_ads' &&
        (m as { dispatches: { campaignId: string }[] }).dispatches.some((d) => d.campaignId === cId),
      )
      const found = (msg as { dispatches: { campaignId: string; dispatchId: string }[] }).dispatches.find((d) => d.campaignId === cId)!
      if (dispatchId === '') dispatchId = found.dispatchId
      assertEqual(found.dispatchId, dispatchId, `reconnect #${i + 1} трябва да върне СЪЩИЯ dispatch_id`)
      ws.close()
      await sleep(150)
    }
    await httpDeleteJson(port, `/api/admin/ad-campaigns/${cId}`, admin.cookie)
  })

  await check('[H3] clicked е terminal — след ad_campaign_click dispatch-ът НЕ се връща при нов connect', async () => {
    const cId = await createAndSendCampaign()
    const ws1 = await openWs(port, viewer.cookie)
    const msg = await waitForWsMessage(ws1, (m) => m.type === 'ad_campaign_pending_ads')
    const dispatchId = (msg as { dispatches: { campaignId: string; dispatchId: string }[] }).dispatches.find((d) => d.campaignId === cId)!.dispatchId
    sendWs(ws1, { type: 'ad_campaign_click', dispatchId })
    await sleep(300)
    ws1.close()

    const ws2 = await openWs(port, viewer.cookie)
    try {
      await assertNoWsMessage(ws2, (m) =>
        m.type === 'ad_campaign_pending_ads' &&
        (m as { dispatches: { dispatchId: string }[] }).dispatches.some((d) => d.dispatchId === dispatchId),
      )
    } finally {
      ws2.close()
      await httpDeleteJson(port, `/api/admin/ad-campaigns/${cId}`, admin.cookie)
    }
  })

  await check('[H4] clicked_at е идемпотентен (двоен click не мести timestamp-а)', async () => {
    const cId = await createAndSendCampaign()
    const ws = await openWs(port, viewer.cookie)
    try {
      const msg = await waitForWsMessage(ws, (m) => m.type === 'ad_campaign_pending_ads')
      const dispatchId = (msg as { dispatches: { campaignId: string; dispatchId: string }[] }).dispatches.find((d) => d.campaignId === cId)!.dispatchId

      sendWs(ws, { type: 'ad_campaign_click', dispatchId })
      await sleep(200)
      const db1 = new DatabaseSync(iso.dbFile, { open: true, enableForeignKeyConstraints: true })
      const firstClickedAt = (db1.prepare(`SELECT clicked_at FROM ad_campaign_receipts WHERE dispatch_id = ?;`).get(dispatchId) as { clicked_at: string }).clicked_at
      db1.close()

      sendWs(ws, { type: 'ad_campaign_click', dispatchId })
      await sleep(200)
      const db2 = new DatabaseSync(iso.dbFile, { open: true, enableForeignKeyConstraints: true })
      const secondClickedAt = (db2.prepare(`SELECT clicked_at FROM ad_campaign_receipts WHERE dispatch_id = ?;`).get(dispatchId) as { clicked_at: string }).clicked_at
      db2.close()

      assertEqual(secondClickedAt, firstClickedAt, 'clicked_at не трябва да се променя при повторен click (COALESCE idempotency)')
    } finally {
      ws.close()
      await httpDeleteJson(port, `/api/admin/ad-campaigns/${cId}`, admin.cookie)
    }
  })

  console.log('\n=== Section I: WS management subscribe authorization ===\n')

  async function checkManagementSubscribeDenied(label: string, cookie: string): Promise<void> {
    await check(label, async () => {
      const ws = await openWs(port, cookie)
      try {
        sendWs(ws, { type: 'subscribe_ad_campaign_management' })
        await sleep(200)
        const createRes = await httpPostJson(port, '/api/admin/ad-campaigns', admin.cookie, { imageDataUrl: VALID_IMAGE_DATA_URL, targetUrl: '/tournaments' })
        const cId = (createRes.body as { campaign: CampaignDto }).campaign.campaignId
        await assertNoWsMessage(ws, (m) => m.type === 'ad_campaign_management_created' && (m as { campaign?: CampaignDto }).campaign?.campaignId === cId, 1000)
        await httpDeleteJson(port, `/api/admin/ad-campaigns/${cId}`, admin.cookie)
      } finally {
        ws.close()
      }
    })
  }

  await check('[I1] admin subscribe_ad_campaign_management -> allowed (получава management broadcast)', async () => {
    const ws = await openWs(port, admin.cookie)
    try {
      sendWs(ws, { type: 'subscribe_ad_campaign_management' })
      await sleep(200)
      const createRes = await httpPostJson(port, '/api/admin/ad-campaigns', pikaTeam.cookie, { imageDataUrl: VALID_IMAGE_DATA_URL, targetUrl: '/tournaments' })
      const cId = (createRes.body as { campaign: CampaignDto }).campaign.campaignId
      const msg = await waitForWsMessage(ws, (m) => m.type === 'ad_campaign_management_created' && (m as { campaign: CampaignDto }).campaign.campaignId === cId)
      assert(msg !== undefined, 'admin трябва да получи management broadcast')
      await httpDeleteJson(port, `/api/admin/ad-campaigns/${cId}`, admin.cookie)
    } finally {
      ws.close()
    }
  })

  await check('[I2] pika_team subscribe_ad_campaign_management -> allowed', async () => {
    const ws = await openWs(port, pikaTeam.cookie)
    try {
      sendWs(ws, { type: 'subscribe_ad_campaign_management' })
      await sleep(200)
      const createRes = await httpPostJson(port, '/api/admin/ad-campaigns', admin.cookie, { imageDataUrl: VALID_IMAGE_DATA_URL, targetUrl: '/tournaments' })
      const cId = (createRes.body as { campaign: CampaignDto }).campaign.campaignId
      const msg = await waitForWsMessage(ws, (m) => m.type === 'ad_campaign_management_created' && (m as { campaign: CampaignDto }).campaign.campaignId === cId)
      assert(msg !== undefined, 'pika_team трябва да получи management broadcast')
      await httpDeleteJson(port, `/api/admin/ad-campaigns/${cId}`, admin.cookie)
    } finally {
      ws.close()
    }
  })

  await checkManagementSubscribeDenied('[I3] player subscribe_ad_campaign_management -> denied/ignored (никакъв management broadcast)', player.cookie)
  await checkManagementSubscribeDenied('[I4] subadmin subscribe_ad_campaign_management -> denied/ignored', subadmin.cookie)
  await checkManagementSubscribeDenied('[I5] chat_admin subscribe_ad_campaign_management -> denied/ignored', chatAdmin.cookie)

  console.log('\n=== Section J: Optional target URL (кампания без линк) ===\n')

  await check('[J1] create campaign БЕЗ target (targetUrl липсва) -> 200, DB target_url IS NULL, management връща null', async () => {
    const r = await httpPostJson(port, '/api/admin/ad-campaigns', admin.cookie, {
      imageDataUrl: VALID_IMAGE_DATA_URL,
    })
    assert(r.status === 200, `очаквано 200, получено ${r.status}: ${JSON.stringify(r.body)}`)
    const campaign = (r.body as { campaign: CampaignDto }).campaign
    assertEqual(campaign.targetUrl, null, 'response targetUrl трябва да е null')

    const db = new DatabaseSync(iso.dbFile, { open: true, enableForeignKeyConstraints: true })
    const row = db.prepare(`SELECT target_url FROM ad_campaigns WHERE campaign_id = ?;`).get(campaign.campaignId) as { target_url: string | null }
    db.close()
    assertEqual(row.target_url, null, 'DB target_url трябва да е NULL')

    const listRes = await httpGetJson(port, '/api/admin/ad-campaigns', admin.cookie)
    const listed = (listRes.body as { campaigns: CampaignDto[] }).campaigns.find((c) => c.campaignId === campaign.campaignId)
    assert(listed !== undefined, 'кампанията трябва да е в списъка')
    assertEqual(listed!.targetUrl, null, 'management GET трябва да връща targetUrl:null')

    await httpDeleteJson(port, `/api/admin/ad-campaigns/${campaign.campaignId}`, admin.cookie)
  })

  await check('[J2] create campaign с targetUrl:null (explicit) -> третира се като "без target"', async () => {
    const r = await httpPostJson(port, '/api/admin/ad-campaigns', admin.cookie, {
      imageDataUrl: VALID_IMAGE_DATA_URL,
      targetUrl: null,
    })
    assert(r.status === 200, `очаквано 200, получено ${r.status}`)
    const campaign = (r.body as { campaign: CampaignDto }).campaign
    assertEqual(campaign.targetUrl, null, 'targetUrl:null explicit трябва да се третира като без target')
    await httpDeleteJson(port, `/api/admin/ad-campaigns/${campaign.campaignId}`, admin.cookie)
  })

  await check('[J3] empty/whitespace target string се нормализира до null', async () => {
    const r = await httpPostJson(port, '/api/admin/ad-campaigns', admin.cookie, {
      imageDataUrl: VALID_IMAGE_DATA_URL,
      targetUrl: '   ',
    })
    assert(r.status === 200, `очаквано 200, получено ${r.status}`)
    const campaign = (r.body as { campaign: CampaignDto }).campaign
    assertEqual(campaign.targetUrl, null, 'empty/whitespace target трябва да нормализира до null')
    await httpDeleteJson(port, `/api/admin/ad-campaigns/${campaign.campaignId}`, admin.cookie)
  })

  await check('[J4] unsafe non-empty target продължава да връща 400 (regression след optional-target промяната)', async () => {
    const r = await httpPostJson(port, '/api/admin/ad-campaigns', admin.cookie, {
      imageDataUrl: VALID_IMAGE_DATA_URL,
      targetUrl: 'javascript:alert(1)',
    })
    assert(r.status === 400, `очаквано 400, получено ${r.status}`)
  })

  await check('[J5] send campaign без target -> 200, dispatchCount нараства нормално', async () => {
    const createRes = await httpPostJson(port, '/api/admin/ad-campaigns', admin.cookie, { imageDataUrl: VALID_IMAGE_DATA_URL })
    const cId = (createRes.body as { campaign: CampaignDto }).campaign.campaignId
    const sendRes = await httpPostJson(port, `/api/admin/ad-campaigns/${cId}/send`, admin.cookie, {})
    assert(sendRes.status === 200, `очаквано 200, получено ${sendRes.status}: ${JSON.stringify(sendRes.body)}`)
    assertEqual((sendRes.body as { campaign: CampaignDto }).campaign.dispatchCount, 1, 'dispatchCount след send')
    await httpDeleteJson(port, `/api/admin/ad-campaigns/${cId}`, admin.cookie)
  })

  await check('[J6] pending dispatch без target се доставя нормално (WS), с targetUrl:null в payload-а', async () => {
    const createRes = await httpPostJson(port, '/api/admin/ad-campaigns', admin.cookie, { imageDataUrl: VALID_IMAGE_DATA_URL })
    const cId = (createRes.body as { campaign: CampaignDto }).campaign.campaignId
    await httpPostJson(port, `/api/admin/ad-campaigns/${cId}/send`, admin.cookie, {})

    const ws = await openWs(port, viewer.cookie)
    try {
      const msg = await waitForWsMessage(ws, (m) =>
        m.type === 'ad_campaign_pending_ads' &&
        (m as { dispatches: { campaignId: string }[] }).dispatches.some((d) => d.campaignId === cId),
      )
      const found = (msg as { dispatches: { campaignId: string; targetUrl: string | null }[] }).dispatches.find((d) => d.campaignId === cId)!
      assertEqual(found.targetUrl, null, 'доставеният dispatch трябва да носи targetUrl:null')
    } finally {
      ws.close()
      await httpDeleteJson(port, `/api/admin/ad-campaigns/${cId}`, admin.cookie)
    }
  })
} finally {
  if (srv) await stopSrv(srv)
  await iso.cleanup()
}

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)

if (failed > 0) {
  process.exitCode = 1
}
