/**
 * checkTournamentMatchesBrowserE2E.ts
 *
 * Реален end-to-end за "Турнирни срещи" (Виж игрите): реален сървър (local
 * tournament test mode — реален coordinator/scheduler/room runtime/ботове,
 * само ускорени attendance/bot таймери, ОТДЕЛНА временна база), реален Vite
 * frontend и реален Chromium (Playwright). Нищо не е симулирано в браузъра.
 *
 * Изисква свободни портове 3001 (сървър) и 5173 (frontend) — клиентът
 * hardcode-ва :3001, а сървърът позволява CORS само за localhost:5173.
 *
 * Usage: npx tsx scripts/checkTournamentMatchesBrowserE2E.ts [--screenshots=<dir>]
 *
 *   [S]  state machine: 8 отбора -> 4 четвъртфинала под status semifinal_in_progress
 *   [U]  UI: бутон (десктоп в реда на заглавието, мобилен 375/390 без overlap и
 *        без хоризонтален overflow), записване -> без бутон
 *   [M]  "Турнирни срещи": 4 активни срещи, букви, имена, дълго име, резултат = сървъра
 *   [L]  live update без reload (WS push), достъп без VIP до списъка
 *   [W]  VIP "Гледай" -> точната маса, без игрови контроли, spectator snapshot-и
 *   [C]  край на срещата -> обратно в списъка, история с краен резултат/победител/бадж
 *   [N]  отрицателни: без VIP, приключила маса, несъществуваща маса, неначената
 *        маса, активен участник, член на срещата, без beta достъп, фалшив токен
 *   [B]  навигация Назад / browser back
 *   [X]  напускане: unsubscribe + нула live push/HTTP refresh след това
 *   [R]  рестарт на сървъра с изключен spectator флаг: историята е идентична,
 *        "Гледай" изчезва, watch -> feature_disabled
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes, randomUUID, scryptSync } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { createRequire } from 'node:module'

const PROJECT_ROOT = process.cwd()
const SERVER_DIR = join(PROJECT_ROOT, 'server')
// `ws` (за WebSocket с Cookie header) е dependency само на сървъра.
const { WebSocket } = createRequire(join(SERVER_DIR, 'package.json'))('ws') as typeof import('ws')
type WebSocket = InstanceType<typeof WebSocket>
const SERVER_PORT = 3001
const CLIENT_PORT = 5173
const CLIENT = `http://localhost:${CLIENT_PORT}`
const API = `http://127.0.0.1:${SERVER_PORT}`
const SESSION_COOKIE_NAME = 'belot_session'
const LONG_NAME = 'МногоДългоИмеНаИграчКойтоНеБиваДаЧупиПодредбата_ПроверкаЗаМобилен'
const screenshotsDir = resolve(process.argv.find((a) => a.startsWith('--screenshots='))?.slice('--screenshots='.length) ?? join(tmpdir(), 'tournament-matches-e2e-screens'))

let passed = 0
let failed = 0
const failures: string[] = []
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    passed += 1
    console.log(`  ok ${label}`)
  } catch (error) {
    failed += 1
    const message = error instanceof Error ? error.message : String(error)
    failures.push(`${label}: ${message}`)
    console.error(`  FAIL ${label}: ${message}`)
  }
}
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))
async function waitFor<T>(label: string, fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, timeoutMs: number, intervalMs = 500): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last: unknown = null
  while (Date.now() < deadline) {
    try {
      const value = await fn()
      if (value) return value as T
    } catch (error) {
      last = error
    }
    await sleep(intervalMs)
  }
  throw new Error(`timeout waiting for ${label}${last ? ` (${String(last)})` : ''}`)
}

async function assertPortFree(port: number): Promise<void> {
  await new Promise<void>((done, reject) => {
    const srv = createNetServer()
    srv.once('error', () => reject(new Error(`port ${port} is busy — stop the local dev server first`)))
    srv.listen(port, '127.0.0.1', () => srv.close(() => done()))
  })
}

// ─── Server ────────────────────────────────────────────────────────────────

type RunningServer = { child: ChildProcessWithoutNullStreams; output: () => string }

function startServer(databaseFile: string, spectatorEnabled: boolean): RunningServer {
  const chunks: string[] = []
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(SERVER_PORT),
    NODE_ENV: 'development',
    BELOT_LOCAL_TOURNAMENT_TEST_MODE: '1',
    BELOT_LOCAL_TOURNAMENT_TEST_DB_PATH: databaseFile,
    BELOT_LOCAL_TOURNAMENT_ATTENDANCE_MS: '4000',
    BELOT_LOCAL_TOURNAMENT_TRANSITION_MS: '3000',
    BELOT_LOCAL_BOT_ACTION_MIN_MS: '60',
    BELOT_LOCAL_BOT_ACTION_MAX_MS: '120',
  }
  if (spectatorEnabled) env.BELOT_SPECTATOR_ENABLED = '1'
  else delete env.BELOT_SPECTATOR_ENABLED
  const child = spawn(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'index.ts')], {
    cwd: SERVER_DIR, env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => { if (!chunk.includes('[gameplay-audit]')) chunks.push(chunk) })
  child.stderr.on('data', (chunk: string) => chunks.push(chunk))
  return { child, output: () => chunks.join('') }
}

async function stopServer(server: RunningServer | null): Promise<void> {
  if (server === null || server.child.exitCode !== null) return
  server.child.kill('SIGTERM')
  await new Promise<void>((done) => {
    const timer = setTimeout(() => { server.child.kill('SIGKILL'); done() }, 10_000)
    server.child.once('exit', () => { clearTimeout(timer); done() })
  })
}

async function waitForServer(): Promise<void> {
  await waitFor('server /api/rooms', async () => (await fetch(`${API}/api/rooms`)).status === 200, 60_000, 250)
}

function withDb<T>(databaseFile: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(databaseFile, { open: true, timeout: 10_000 })
  try { return fn(db) } finally { db.close() }
}

type SeededUser = { cookieValue: string; cookie: string; profileId: string; label: string }

function seedUser(databaseFile: string, label: string, options: { vip: boolean; beta: boolean }): SeededUser {
  const accountId = randomUUID()
  const profileId = randomUUID()
  const displayName = `E2E ${label} ${randomBytes(2).toString('hex')}`
  const token = randomBytes(32).toString('base64url')
  withDb(databaseFile, (db) => {
    db.exec('PRAGMA foreign_keys = ON;')
    db.exec('BEGIN IMMEDIATE;')
    try {
      db.prepare(`INSERT INTO accounts (account_id, email, password_hash, role, status) VALUES (?, ?, 'not-used-seeded-directly', 'player', 'active');`)
        .run(accountId, `tm-e2e-${label}-${randomBytes(3).toString('hex')}@example.test`)
      db.prepare(`
        INSERT INTO profiles (profile_id, account_id, profile_kind, username, normalized_username, display_name,
          normalized_display_name, avatar_url, level, rank_title, skill_rating, gender, status)
        VALUES (?, ?, 'human', ?, ?, ?, ?, NULL, 5, 'Rank 1', 1000, 'male', 'active');
      `).run(profileId, accountId, displayName, displayName.toLowerCase(), displayName, displayName.toLowerCase())
      db.prepare(`INSERT INTO profile_wallets (profile_id, yellow_coins_balance) VALUES (?, 50000);`).run(profileId)
      db.prepare(`INSERT INTO profile_progress (profile_id, completed_games_count, won_games_count, rank_level) VALUES (?, 0, 0, 1);`).run(profileId)
      db.prepare(`INSERT INTO account_sessions (session_id, account_id, profile_id, token_hash, expires_at) VALUES (?, ?, ?, ?, ?);`)
        .run(randomUUID(), accountId, profileId, scryptSync(token, 'belot-v2-session-v1', 32).toString('hex'), new Date(Date.now() + 86_400_000).toISOString())
      if (options.vip) {
        db.prepare(`INSERT INTO vip_status (profile_id, active_until) VALUES (?, '2099-01-01T00:00:00.000Z');`).run(profileId)
      }
      if (options.beta) {
        db.prepare(`INSERT INTO tournament_beta_access_grants (profile_id, password_version) VALUES (?, 1);`).run(profileId)
      }
      db.exec('COMMIT;')
    } catch (error) {
      try { db.exec('ROLLBACK;') } catch { /* keep original */ }
      throw error
    }
  })
  return { cookieValue: token, cookie: `${SESSION_COOKIE_NAME}=${token}`, profileId, label }
}

function grantVipAndBeta(databaseFile: string, profileId: string): void {
  withDb(databaseFile, (db) => {
    db.prepare(`INSERT OR REPLACE INTO vip_status (profile_id, active_until) VALUES (?, '2099-01-01T00:00:00.000Z');`).run(profileId)
    db.prepare(`INSERT OR REPLACE INTO tournament_beta_access_grants (profile_id, password_version) VALUES (?, 1);`).run(profileId)
  })
}

async function api(method: string, pathname: string, cookie?: string, body?: unknown): Promise<{ status: number; body: any; setCookie: string[] }> {
  const headers: Record<string, string> = { Origin: CLIENT }
  if (cookie) headers.Cookie = cookie
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(`${API}${pathname}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  let parsed: any = null
  try { parsed = JSON.parse(text) } catch { parsed = text }
  const ext = res.headers as Headers & { getSetCookie?: () => string[] }
  return { status: res.status, body: parsed, setCookie: ext.getSetCookie?.() ?? [] }
}

type TechMatch = { matchId: string; roomId: string | null; roundType: string; roundIndex: number; status: string; teamAId: string; teamBId: string; winnerTeamId: string | null; finalScoreTeamA: number | null; finalScoreTeamB: number | null }
type TechState = { tournament: { status: string }; teams: Array<{ teamId: string }>; entries: Array<{ profileId: string; teamId: string | null; status: string }>; matches: TechMatch[] }

async function techState(tournamentId: string): Promise<TechState> {
  const res = await api('GET', `/dev/tournament-test/api/state?tournamentId=${encodeURIComponent(tournamentId)}`)
  return (res.body.state ?? res.body) as TechState
}

async function detail(tournamentId: string, cookie: string): Promise<any> {
  const res = await api('GET', `/api/tournaments/${encodeURIComponent(tournamentId)}`, cookie)
  if (res.status !== 200) throw new Error(`detail status ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`)
  return res.body.tournament
}

// ─── Raw WS client ─────────────────────────────────────────────────────────

type RawClient = { ws: WebSocket; frames: any[] }
async function rawConnect(cookie: string): Promise<RawClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${SERVER_PORT}/ws`, { headers: { Cookie: cookie, Origin: CLIENT } })
  const frames: any[] = []
  ws.on('message', (data) => { try { frames.push(JSON.parse(data.toString())) } catch { /* ignore */ } })
  await new Promise<void>((done, reject) => { ws.once('open', () => done()); ws.once('error', reject) })
  await waitFor('connected frame', () => frames.some((f) => f.type === 'connected'), 10_000, 50)
  return { ws, frames }
}
async function rawWatch(client: RawClient, roomId: string): Promise<any> {
  const from = client.frames.length
  client.ws.send(JSON.stringify({ type: 'watch_belot_room', roomId }))
  const result = await waitFor(`watch reply ${roomId}`, () => client.frames.slice(from).find((f) => (
    (f.type === 'belot_spectate_denied' || f.type === 'belot_spectate_started') && f.roomId === roomId
  )), 10_000, 50)
  if (result.type === 'belot_spectate_started') client.ws.send(JSON.stringify({ type: 'unwatch_belot_room', roomId }))
  return result
}

// ─── Browser helpers ───────────────────────────────────────────────────────

type WsLog = { sent: Array<{ at: number; data: any }>; received: Array<{ at: number; data: any }> }
type Session = { context: BrowserContext; page: Page; ws: WsLog; requests: Array<{ at: number; url: string }> }

async function openSession(browser: Browser, user: SeededUser, viewport: { width: number; height: number }, mobile: boolean): Promise<Session> {
  const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1, locale: 'bg-BG' })
  await context.addCookies([{ name: SESSION_COOKIE_NAME, value: user.cookieValue, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax' }])
  const page = await context.newPage()
  const ws: WsLog = { sent: [], received: [] }
  const requests: Session['requests'] = []
  page.on('websocket', (socket) => {
    socket.on('framesent', (frame) => { try { ws.sent.push({ at: Date.now(), data: JSON.parse(String(frame.payload)) }) } catch { /* ignore */ } })
    socket.on('framereceived', (frame) => { try { ws.received.push({ at: Date.now(), data: JSON.parse(String(frame.payload)) }) } catch { /* ignore */ } })
  })
  page.on('request', (request) => requests.push({ at: Date.now(), url: request.url() }))
  page.on('pageerror', (error) => console.error(`    [pageerror ${user.label}] ${error.message}`))
  return { context, page, ws, requests }
}

async function openTournamentDetail(session: Session, tournamentId: string): Promise<void> {
  const { page } = session
  await page.goto(`${CLIENT}/tournaments`, { waitUntil: 'domcontentloaded' })
  // Cookie consent банерът покрива долната част — приемаме го като реален потребител.
  const accept = page.locator('button:has-text("Приеми всички")')
  try {
    await accept.first().waitFor({ state: 'visible', timeout: 4000 })
    await accept.first().click()
  } catch { /* вече прието / не е показан */ }
  const card = page.locator(`[data-tournament-card="${tournamentId}"]`)
  await card.first().waitFor({ state: 'visible', timeout: 30_000 })
  await card.first().click()
  await page.waitForURL(`**/tournaments/${tournamentId}`, { timeout: 15_000 })
  await page.locator('h2').first().waitFor({ timeout: 15_000 })
}

async function noHorizontalOverflow(page: Page): Promise<{ ok: boolean; scrollWidth: number; innerWidth: number }> {
  return page.evaluate(() => ({
    ok: document.documentElement.scrollWidth <= window.innerWidth + 1,
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }))
}

async function cardsOverflow(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const problems: string[] = []
    const vw = window.innerWidth
    document.querySelectorAll<HTMLElement>('[data-tournament-live-match], [data-tournament-history-match]').forEach((card) => {
      const rect = card.getBoundingClientRect()
      if (rect.right > vw + 1 || rect.left < -1) problems.push(`card outside viewport ${rect.left}-${rect.right}/${vw}`)
      if (card.scrollWidth > card.clientWidth + 1) problems.push(`card content overflow ${card.scrollWidth}>${card.clientWidth}`)
      card.querySelectorAll<HTMLElement>('*').forEach((el) => {
        const r = el.getBoundingClientRect()
        if (r.width > 0 && r.right > rect.right + 1) problems.push(`child overflows card: ${el.tagName} ${r.right}>${rect.right}`)
      })
    })
    return problems.slice(0, 5)
  })
}

async function domLiveScores(page: Page): Promise<Map<string, string>> {
  const pairs = await page.evaluate(() => {
    const result: Array<[string, string]> = []
    document.querySelectorAll<HTMLElement>('[data-tournament-live-match]').forEach((card) => {
      const id = card.dataset.tournamentLiveMatch ?? ''
      const a = card.querySelector<HTMLElement>('[data-tournament-live-score-team="a"]')?.textContent?.trim() ?? ''
      const b = card.querySelector<HTMLElement>('[data-tournament-live-score-team="b"]')?.textContent?.trim() ?? ''
      result.push([id, `${a}:${b}`])
    })
    return result
  })
  return new Map(pairs)
}

function apiLiveScores(tournamentDetail: any): Map<string, string> {
  const map = new Map<string, string>()
  for (const round of tournamentDetail.rounds) {
    for (const match of round.matches) {
      if (match.status === 'in_progress') map.set(match.matchId, `${match.liveScoreTeamA ?? '—'}:${match.liveScoreTeamB ?? '—'}`)
    }
  }
  return map
}

// ─── Main ──────────────────────────────────────────────────────────────────

console.log('\n═══ checkTournamentMatchesBrowserE2E (real server + Vite + Chromium) ═══')
await assertPortFree(SERVER_PORT)
await assertPortFree(CLIENT_PORT)
await mkdir(screenshotsDir, { recursive: true })
const tempDir = await mkdtemp(join(tmpdir(), 'belot-tm-e2e-'))
const databaseFile = join(tempDir, 'belot-tournament-test-matches-e2e.sqlite')
let server: RunningServer | null = null
let vite: ViteDevServer | null = null
let browser: Browser | null = null
const rawClients: RawClient[] = []

try {
  server = startServer(databaseFile, true)
  await waitForServer()
  vite = await createViteServer({ root: PROJECT_ROOT, server: { port: CLIENT_PORT, strictPort: true, host: 'localhost' }, logLevel: 'error' })
  await vite.listen()
  browser = await chromium.launch()

  // Production-like: beta gate включен; само изрично разрешени профили имат достъп.
  withDb(databaseFile, (db) => db.prepare(`UPDATE tournament_beta_access_config SET enabled = 1, password_hash = 'e2e-not-used', password_version = 1;`).run())
  const vipViewer = seedUser(databaseFile, 'vip', { vip: true, beta: true })
  const plainViewer = seedUser(databaseFile, 'plain', { vip: false, beta: true })
  const rawVip = seedUser(databaseFile, 'rawvip', { vip: true, beta: true })
  const noBetaVip = seedUser(databaseFile, 'nobeta', { vip: true, beta: false })
  // Една отворена сесия на профил (по-нова изтласква по-старата) — всяка
  // браузърна сесия ползва собствен профил.
  const mobileViewers = new Map<number, SeededUser>([
    [375, seedUser(databaseFile, 'm375', { vip: true, beta: true })],
    [390, seedUser(databaseFile, 'm390', { vip: true, beta: true })],
  ])
  const mobileHistoryViewers = new Map<number, SeededUser>([
    [375, seedUser(databaseFile, 'h375', { vip: false, beta: true })],
    [390, seedUser(databaseFile, 'h390', { vip: false, beta: true })],
  ])

  // Турнир в "Записване" (без бутон) — реален create endpoint би изисквал
  // монети/beta flow; статусът е единственото, което бутонът чете.
  const openTournamentId = randomUUID()
  withDb(databaseFile, (db) => db.prepare(`
    INSERT INTO tournaments (tournament_id, kind, name, creator_profile_id, visibility, password_hash, entry_fee,
      player_capacity, start_mode, scheduled_start_at, status, settlement_state, created_at, updated_at)
    VALUES (?, 'community', 'E2E Записване', ?, 'public', NULL, 5000, 8, 'fill', NULL, 'open', 'pending', ?, ?);
  `).run(openTournamentId, vipViewer.profileId, new Date(Date.now() - 60_000).toISOString(), new Date(Date.now() - 60_000).toISOString()))

  const created = await api('POST', '/dev/tournament-test/api/create', undefined, { teamCapacity: 8, mode: 'one_human' })
  assert(created.status === 200 && created.body.ok, `create test tournament: ${JSON.stringify(created.body).slice(0, 300)}`)
  const tournamentId: string = created.body.tournamentId
  const human = created.body.humanCredentials[0] as { email: string; password: string; profileId: string }
  console.log(`  tournament ${tournamentId}`)

  // Дълго име на бот в турнира (временна база) — проверка на подредбата.
  const initialState = await techState(tournamentId)
  const longNameBot = initialState.entries.find((entry) => entry.profileId !== human.profileId)!
  withDb(databaseFile, (db) => db.prepare(`UPDATE profiles SET display_name = ? WHERE profile_id = ?;`).run(LONG_NAME, longNameBot.profileId))

  // Наблюдавана state machine: (status, брой срещи по кръг, статуси на срещите).
  const observations: Array<{ status: string; qf: number; other: number; matchStatuses: string }> = []
  const qfInProgress = await waitFor('4 quarterfinals in_progress', async () => {
    const state = await techState(tournamentId)
    const qf = state.matches.filter((match) => match.roundType === 'quarterfinal')
    observations.push({
      status: state.tournament.status,
      qf: qf.length,
      other: state.matches.length - qf.length,
      matchStatuses: [...new Set(qf.map((match) => match.status))].sort().join('/'),
    })
    return qf.length === 4 && qf.every((match) => match.status === 'in_progress') ? state : null
  }, 120_000, 200)

  await check('[S1] 8 отбора: преди старта "open" без срещи; първият кръг (4 четвъртфинала) тече под semifinal_in_progress', () => {
    const summary = [...new Set(observations.map((o) => `${o.status}[qf=${o.qf},other=${o.other},${o.matchStatuses}]`))].join(' -> ')
    console.log(`    observed: ${summary}`)
    assert(observations.every((o) => o.status !== 'open' || (o.qf === 0 && o.other === 0)), `matches while open: ${summary}`)
    assert(observations.every((o) => ['open', 'starting', 'semifinal_in_progress'].includes(o.status)), `unexpected status: ${summary}`)
    assert(observations.every((o) => o.status !== 'semifinal_in_progress' || (o.qf === 4 && o.other === 0)), `semifinal_in_progress must cover exactly the 4 quarterfinals: ${summary}`)
    assert(qfInProgress.tournament.status === 'semifinal_in_progress', `status=${qfInProgress.tournament.status}`)
  })

  // ── Desktop ──
  const desktop = await openSession(browser, vipViewer, { width: 1366, height: 900 }, false)

  await check('[U1] турнир в "Записване": бутонът "Виж игрите" липсва', async () => {
    await openTournamentDetail(desktop, openTournamentId)
    await desktop.page.locator('text=E2E Записване').first().waitFor({ timeout: 10_000 })
    assert(await desktop.page.locator('[data-tournament-matches-open="1"]').count() === 0, 'button must be hidden for open tournament')
  })

  await check('[U2] десктоп: зелен "Виж игрите" в реда на заглавието', async () => {
    await openTournamentDetail(desktop, tournamentId)
    const button = desktop.page.locator('[data-tournament-matches-open="1"]')
    await button.waitFor({ state: 'visible', timeout: 15_000 })
    const geometry = await desktop.page.evaluate(() => {
      const b = document.querySelector<HTMLElement>('[data-tournament-matches-open="1"]')!.getBoundingClientRect()
      const h = document.querySelector('h2')!.getBoundingClientRect()
      const bg = getComputedStyle(document.querySelector<HTMLElement>('[data-tournament-matches-open="1"]')!).backgroundImage
      return { bTop: b.top, bBottom: b.bottom, hTop: h.top, hBottom: h.bottom, bLeft: b.left, hRight: h.right, bg }
    })
    assert(geometry.bTop < geometry.hBottom && geometry.bBottom > geometry.hTop, `button not on title row ${JSON.stringify(geometry)}`)
    assert(geometry.bLeft >= geometry.hRight - 1, 'button overlaps title')
    assert(geometry.bg.includes('34, 197, 94'), `not green: ${geometry.bg}`)
    await desktop.page.screenshot({ path: join(screenshotsDir, 'desktop-1366-detail.png') })
  })

  for (const width of [375, 390]) {
    await check(`[U3] мобилен ${width}px: бутонът е под/до заглавието без припокриване, без хоризонтален overflow`, async () => {
      const mobile = await openSession(browser!, mobileViewers.get(width)!, { width, height: 844 }, true)
      try {
        await openTournamentDetail(mobile, tournamentId)
        await mobile.page.locator('[data-tournament-matches-open="1"]').waitFor({ state: 'visible', timeout: 15_000 })
        const g = await mobile.page.evaluate(() => {
          const b = document.querySelector<HTMLElement>('[data-tournament-matches-open="1"]')!.getBoundingClientRect()
          const h = document.querySelector('h2')!.getBoundingClientRect()
          return { b: { l: b.left, r: b.right, t: b.top, bo: b.bottom }, h: { l: h.left, r: h.right, t: h.top, bo: h.bottom }, vw: window.innerWidth }
        })
        const overlap = g.b.l < g.h.r && g.b.r > g.h.l && g.b.t < g.h.bo && g.b.bo > g.h.t
        assert(!overlap, `button overlaps title ${JSON.stringify(g)}`)
        assert(g.b.r <= g.vw + 1, 'button outside viewport')
        const overflow = await noHorizontalOverflow(mobile.page)
        assert(overflow.ok, `horizontal overflow ${overflow.scrollWidth}>${overflow.innerWidth}`)
        await mobile.page.screenshot({ path: join(screenshotsDir, `mobile-${width}-detail.png`) })
        await mobile.page.locator('[data-tournament-matches-open="1"]').click()
        await mobile.page.locator('[data-tournament-matches-view="1"]').waitFor({ timeout: 15_000 })
        await mobile.page.locator('[data-tournament-live-match]').first().waitFor({ timeout: 15_000 })
        const overflowView = await noHorizontalOverflow(mobile.page)
        assert(overflowView.ok, `matches view horizontal overflow ${overflowView.scrollWidth}>${overflowView.innerWidth}`)
        const problems = await cardsOverflow(mobile.page)
        assert(problems.length === 0, problems.join('; '))
        const watchHeight = await mobile.page.locator('[data-watch-tournament-match]').first().evaluate((el) => el.getBoundingClientRect().height)
        assert(watchHeight >= 40, `Гледай touch target ${watchHeight}px`)
        await mobile.page.screenshot({ path: join(screenshotsDir, `mobile-${width}-matches-live.png`), fullPage: true })
      } finally {
        await mobile.context.close()
      }
    })
  }

  const qfMatches = qfInProgress.matches.filter((match) => match.roundType === 'quarterfinal')
  let viewDetail: any = null

  await check('[M1] "Турнирни срещи": 4 активни срещи с етап, букви, имена и "Гледай" към точните маси', async () => {
    await desktop.page.locator('[data-tournament-matches-open="1"]').click()
    await desktop.page.waitForURL(`**/tournaments/${tournamentId}/games`, { timeout: 10_000 })
    await desktop.page.locator('[data-tournament-live-match]').nth(3).waitFor({ timeout: 15_000 })
    const cards = await desktop.page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-tournament-live-match]')].map((card) => ({
      matchId: card.dataset.tournamentLiveMatch,
      text: card.innerText,
      watchRoom: card.querySelector<HTMLElement>('[data-watch-tournament-match]')?.dataset.watchTournamentMatch ?? null,
    })))
    assert(cards.length === 4, `cards=${cards.length}`)
    viewDetail = await detail(tournamentId, vipViewer.cookie)
    const letters = new Map<string, string>(viewDetail.teams.map((team: any, index: number) => [team.teamId, 'ABCDEFGH'[index]]))
    for (const match of qfMatches) {
      const card = cards.find((item) => item.matchId === match.matchId)
      assert(card !== undefined, `missing card ${match.matchId}`)
      assert(card.text.toUpperCase().includes(`ЧЕТВЪРТФИНАЛ ${match.roundIndex}`), `stage label: ${card.text.slice(0, 60)}`)
      // innerText отразява CSS text-transform:uppercase ("ОТБОР A").
      const upper = card.text.toUpperCase()
      assert(upper.includes(`ОТБОР ${letters.get(match.teamAId)}`) && upper.includes(`ОТБОР ${letters.get(match.teamBId)}`), `letters for ${match.matchId}: ${card.text.slice(0, 120)}`)
      const memberNames = viewDetail.teams.filter((team: any) => team.teamId === match.teamAId || team.teamId === match.teamBId).flatMap((team: any) => team.members.map((m: any) => m.displayName))
      assert(memberNames.length === 4 && memberNames.every((name: string) => card.text.includes(name)), `names for ${match.matchId}`)
      assert(card.watchRoom === match.roomId, `Гледай room ${card.watchRoom} != ${match.roomId}`)
    }
    assert(cards.some((card) => card.text.includes(LONG_NAME)), 'long name rendered')
    assert((await desktop.page.locator('text=Все още няма приключили срещи.').count()) === 1, 'empty history')
    const problems = await cardsOverflow(desktop.page)
    assert(problems.length === 0, problems.join('; '))
    await desktop.page.screenshot({ path: join(screenshotsDir, 'desktop-1366-matches-live.png'), fullPage: true })
  })

  await check('[M2] показаният резултат е равен на authoritative резултата на масата', async () => {
    await waitFor('DOM scores == server scores', async () => {
      const dom = await domLiveScores(desktop.page)
      const server = apiLiveScores(await detail(tournamentId, vipViewer.cookie))
      return [...server].every(([matchId, score]) => dom.get(matchId) === score)
    }, 20_000, 300)
  })

  await check('[L1] резултатът се обновява на живо без презареждане (WS push)', async () => {
    await desktop.page.evaluate(() => { (window as any).__tmNoReload = 1 })
    const before = await domLiveScores(desktop.page)
    const pushesBefore = desktop.ws.received.filter((f) => f.data.type === 'tournament_match_live_score').length
    await waitFor('a live score change', async () => {
      const now = await domLiveScores(desktop.page)
      return [...now].some(([matchId, score]) => before.has(matchId) && before.get(matchId) !== score)
    }, 180_000, 500)
    assert(await desktop.page.evaluate(() => (window as any).__tmNoReload === 1), 'page was reloaded')
    const pushes = desktop.ws.received.filter((f) => f.data.type === 'tournament_match_live_score').length - pushesBefore
    assert(pushes > 0, 'no tournament_match_live_score push received')
    const subscribed = desktop.ws.sent.find((f) => f.data.type === 'subscribe_tournament_matches')
    assert(subscribed?.data.tournamentId === tournamentId && typeof subscribed.data.token === 'string', 'subscribe frame')
    await waitFor('DOM scores == server scores after update', async () => {
      const dom = await domLiveScores(desktop.page)
      const server = apiLiveScores(await detail(tournamentId, vipViewer.cookie))
      return [...server].every(([matchId, score]) => !dom.has(matchId) || dom.get(matchId) === score)
    }, 20_000, 300)
  })

  // ── Negative: без VIP (списъкът е достъпен, гледането — не) ──
  await check('[N1] без VIP: списъкът и резултатите са достъпни, "Гледай" отваря VIP popup, без watch', async () => {
    const plain = await openSession(browser!, plainViewer, { width: 1366, height: 900 }, false)
    try {
      await openTournamentDetail(plain, tournamentId)
      await plain.page.locator('[data-tournament-matches-open="1"]').click()
      await plain.page.locator('[data-tournament-live-match]').first().waitFor({ timeout: 15_000 })
      await plain.page.locator('[data-watch-tournament-match]').first().click()
      await plain.page.locator('[data-belot-spectator-vip-popup-close="1"]').waitFor({ timeout: 10_000 })
      await sleep(1500)
      assert(!plain.ws.received.some((f) => f.data.type === 'belot_spectate_started'), 'spectate started without VIP')
      await plain.page.screenshot({ path: join(screenshotsDir, 'desktop-1366-no-vip-popup.png') })
    } finally {
      await plain.context.close()
    }
    const raw = await rawConnect(plainViewer.cookie)
    rawClients.push(raw)
    const reply = await rawWatch(raw, qfMatches[0]!.roomId!)
    assert(reply.type === 'belot_spectate_denied' && reply.code === 'vip_required', JSON.stringify(reply))
  })

  await check('[N2] без beta достъп: detail е отказан (няма токен), фалшив subscribe не получава резултати', async () => {
    const denied = await api('GET', `/api/tournaments/${tournamentId}`, noBetaVip.cookie)
    assert(denied.status === 403, `detail status ${denied.status}`)
    const raw = await rawConnect(noBetaVip.cookie)
    rawClients.push(raw)
    raw.ws.send(JSON.stringify({ type: 'subscribe_tournament_matches', tournamentId, token: 'forged-token' }))
    // Ограничено чакане: до следващия реален push към легитимния абонат (desktop).
    const subscribedAt = Date.now()
    await waitFor('a live push to the legitimate subscriber', () => desktop.ws.received.some((f) => f.at > subscribedAt && f.data.type === 'tournament_match_live_score'), 120_000, 500)
    assert(!raw.frames.some((f) => f.type === 'tournament_match_live_score' || f.type === 'tournament_matches_changed'), 'forged token received pushes')
  })

  await check('[N3] активен участник и член на срещата не могат да гледат турнирни маси; несъществуваща маса -> отказ', async () => {
    const login = await api('POST', '/api/auth/login', undefined, { email: human.email, password: human.password, rememberMe: true })
    const humanCookie = login.setCookie.find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`))?.split(';')[0]
    assert(humanCookie, `participant login ${login.status}`)
    grantVipAndBeta(databaseFile, human.profileId)
    const raw = await rawConnect(humanCookie)
    rawClients.push(raw)
    const state = await techState(tournamentId)
    const humanTeam = state.entries.find((entry) => entry.profileId === human.profileId)!.teamId
    const ownMatch = state.matches.find((match) => match.status === 'in_progress' && (match.teamAId === humanTeam || match.teamBId === humanTeam))
    const otherMatch = state.matches.find((match) => match.status === 'in_progress' && match.teamAId !== humanTeam && match.teamBId !== humanTeam)
    if (ownMatch) {
      const own = await rawWatch(raw, ownMatch.roomId!)
      assert(own.type === 'belot_spectate_denied' && own.code === 'participant', `own match: ${JSON.stringify(own)}`)
    }
    assert(otherMatch !== undefined, 'need another live match')
    const other = await rawWatch(raw, otherMatch.roomId!)
    assert(other.type === 'belot_spectate_denied' && other.code === 'active_game_commitment', `other match: ${JSON.stringify(other)}`)
    raw.ws.close()
    const rawV = await rawConnect(rawVip.cookie)
    rawClients.push(rawV)
    const missing = await rawWatch(rawV, randomUUID())
    assert(missing.type === 'belot_spectate_denied' && missing.code === 'room_not_found', JSON.stringify(missing))
  })

  // ── Гледане ──
  const watchedMatch = qfMatches[0]!
  const watchedRoomId = watchedMatch.roomId!
  let watchStartedAt = 0

  await check('[W1] VIP "Гледай" отваря точно съответната маса като зрител', async () => {
    const card = desktop.page.locator(`[data-watch-tournament-match="${watchedRoomId}"]`)
    await card.click()
    watchStartedAt = Date.now()
    const sent = await waitFor('watch frame', () => desktop.ws.sent.find((f) => f.data.type === 'watch_belot_room'), 10_000, 100)
    assert(sent.data.roomId === watchedRoomId, `watch sent for ${sent.data.roomId}`)
    await waitFor('spectate started', () => desktop.ws.received.find((f) => f.data.type === 'belot_spectate_started' && f.data.roomId === watchedRoomId), 10_000, 100)
    // Seat panels host е body-level контейнер с нулев размер — "attached", не "visible".
    await desktop.page.locator('[data-seat-panels-host="1"]').first().waitFor({ state: 'attached', timeout: 20_000 })
    await desktop.page.locator('[data-active-room-leave-button="1"]').first().waitFor({ state: 'visible', timeout: 20_000 })
    await sleep(2000)
    const snapshot = desktop.ws.received.find((f) => f.data.type === 'belot_spectator_snapshot')
    assert(snapshot?.data.roomId === watchedRoomId && snapshot.data.isTournamentMatchOrigin === true, 'spectator snapshot for the tournament room')
    await desktop.page.screenshot({ path: join(screenshotsDir, 'desktop-1366-spectating.png') })
  })

  await check('[W2] зрителят няма игрови контроли и не праща игрови действия', async () => {
    await sleep(8000)
    const controls = await desktop.page.evaluate(() => ({
      bidPopup: document.querySelectorAll('[data-bidding-popup="1"], [data-bid-action]').length,
      leave: document.querySelectorAll('[data-active-room-leave-button="1"]').length,
    }))
    assert(controls.bidPopup === 0, `bid controls visible: ${controls.bidPopup}`)
    assert(controls.leave >= 1, 'exit button present')
    const forbidden = desktop.ws.sent.filter((f) => ['submit_bid_action', 'submit_play_card', 'submit_cut_index', 'resume_room', 'join_room', 'leave_active_room'].includes(f.data.type) && f.at >= watchStartedAt)
    assert(forbidden.length === 0, `game actions sent: ${forbidden.map((f) => f.data.type).join(',')}`)
    const seated = await techState(tournamentId)
    assert(seated.matches.find((match) => match.matchId === watchedMatch.matchId)?.status === 'in_progress', 'match still in progress')
  })

  await check('[W3] резултатът на масата се обновява при гледане (spectator snapshot-и)', async () => {
    await waitFor('spectator score change', () => {
      const scores = desktop.ws.received
        .filter((f) => f.data.type === 'belot_spectator_snapshot' && f.data.roomId === watchedRoomId && f.data.game?.score?.match)
        .map((f) => `${f.data.game.score.match.teamA}:${f.data.game.score.match.teamB}`)
      return new Set(scores).size >= 2
    }, 240_000, 1000)
  })

  // ── Връщане в списъка ──
  // Естественият край на срещата (room removal -> belot_spectate_ended) и
  // преминаването в историята са покрити от check:tournament-matches-view
  // [I5]-[I8] (реален coordinator) — тук без многоминутно чакане на ботски мач.
  // "Изход" минава през СЪЩИЯ helper за връщане (navigateAfterBelotSpectateEnded).
  await check('[C1] "Изход" от масата -> обратно в "Турнирни срещи" със същия турнир', async () => {
    await desktop.page.locator('[data-active-room-leave-button="1"]').first().click()
    await desktop.page.locator('[data-tournament-matches-view="1"]').waitFor({ timeout: 20_000 })
    assert(desktop.page.url().endsWith(`/tournaments/${tournamentId}/games`), `url=${desktop.page.url()}`)
    await waitFor('unwatch frame', () => desktop.ws.sent.find((f) => f.data.type === 'unwatch_belot_room' && f.data.roomId === watchedRoomId), 10_000, 100)
    assert(!desktop.ws.sent.some((f) => f.data.type === 'leave_active_room' && f.at >= watchStartedAt), 'spectator exit must never send leave_active_room')
    await desktop.page.locator('[data-tournament-live-match]').first().waitFor({ timeout: 15_000 })
    await desktop.page.screenshot({ path: join(screenshotsDir, 'desktop-1366-after-exit.png'), fullPage: true })
  })

  await check('[B1] навигация: "Назад към турнира" -> detail; browser back -> срещите; forward -> detail', async () => {
    await desktop.page.locator('[data-tournament-matches-back="1"]').click()
    await desktop.page.waitForURL(`**/tournaments/${tournamentId}`, { timeout: 10_000 })
    await desktop.page.locator('[data-tournament-matches-open="1"]').waitFor({ timeout: 10_000 })
    await desktop.page.goBack()
    await desktop.page.locator('[data-tournament-matches-view="1"]').waitFor({ timeout: 10_000 })
    assert(desktop.page.url().endsWith('/games'), desktop.page.url())
    await desktop.page.goForward()
    await desktop.page.locator('[data-tournament-matches-open="1"]').waitFor({ timeout: 10_000 })
  })

  await check('[X1] напускане: unsubscribe; без live push-ове и HTTP refresh след това', async () => {
    // detail екранът (без срещите) вече е напуснал изгледа — абонаментът трябва да е прекратен.
    await waitFor('unsubscribe frame', () => desktop.ws.sent.find((f) => f.data.type === 'unsubscribe_tournament_matches' && f.data.tournamentId === tournamentId), 10_000, 100)
    await desktop.page.locator('[data-tournament-detail-back="1"]').click()
    await desktop.page.waitForURL('**/tournaments', { timeout: 10_000 })
    const leftAt = Date.now()
    const live = (await techState(tournamentId)).matches.filter((match) => match.status === 'in_progress').length
    await sleep(35_000)
    const pushes = desktop.ws.received.filter((f) => f.at > leftAt + 500 && (f.data.type === 'tournament_match_live_score' || f.data.type === 'tournament_matches_changed'))
    const refetches = desktop.requests.filter((r) => r.at > leftAt + 500 && r.url.includes(`/api/tournaments/${tournamentId}`))
    assert(pushes.length === 0, `pushes after leaving: ${pushes.length} (live matches during window: ${live})`)
    assert(refetches.length === 0, `detail refetches after leaving: ${refetches.length}`)
  })

  const historyBeforeRestart = JSON.stringify((await detail(tournamentId, vipViewer.cookie)).rounds
    .flatMap((round: any) => round.matches.filter((m: any) => m.status === 'completed').map((m: any) => [m.matchId, m.winnerTeamId, m.finalScoreTeamA, m.finalScoreTeamB])))

  await desktop.context.close()
  for (const client of rawClients) { try { client.ws.close() } catch { /* ignore */ } }

  // ── Рестарт с изключен spectator флаг ──
  await stopServer(server)
  server = startServer(databaseFile, false)
  await waitForServer()

  await check('[R1] след рестарт detail-ът се зарежда и историята е идентична (съдържанието е покрито от [I7])', async () => {
    const after = JSON.stringify((await detail(tournamentId, vipViewer.cookie)).rounds
      .flatMap((round: any) => round.matches.filter((m: any) => m.status === 'completed').map((m: any) => [m.matchId, m.winnerTeamId, m.finalScoreTeamA, m.finalScoreTeamB])))
    assert(after === historyBeforeRestart, `history differs:\n${historyBeforeRestart}\n${after}`)
  })

  await check('[R2] изключен BELOT_SPECTATOR_ENABLED: няма "Гледай", watch -> feature_disabled', async () => {
    const tDetail = await detail(tournamentId, vipViewer.cookie)
    assert(tDetail.belotSpectatingEnabled === false, 'belotSpectatingEnabled must be false')
    const session = await openSession(browser!, vipViewer, { width: 1366, height: 900 }, false)
    try {
      await openTournamentDetail(session, tournamentId)
      await session.page.locator('[data-tournament-matches-open="1"]').click()
      await session.page.locator('[data-tournament-matches-view="1"]').waitFor({ timeout: 15_000 })
      await sleep(1000)
      assert(await session.page.locator('[data-watch-tournament-match]').count() === 0, 'Гледай visible with flag off')
    } finally {
      await session.context.close()
    }
    const live = (await techState(tournamentId)).matches.find((match) => match.status === 'in_progress' && match.roomId !== null)
    const raw = await rawConnect(rawVip.cookie)
    const reply = await rawWatch(raw, live?.roomId ?? randomUUID())
    raw.ws.close()
    assert(reply.type === 'belot_spectate_denied' && reply.code === 'feature_disabled', JSON.stringify(reply))
  })
} catch (error) {
  failed += 1
  failures.push(`fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  console.error(`  FATAL ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  if (server) console.error(server.output().split('\n').filter((line) => /error|fail/i.test(line)).slice(-20).join('\n'))
} finally {
  for (const client of rawClients) { try { client.ws.close() } catch { /* ignore */ } }
  try { await browser?.close() } catch { /* ignore */ }
  try { await vite?.close() } catch { /* ignore */ }
  await stopServer(server)
  await sleep(500)
  try { await rm(tempDir, { recursive: true, force: true }) } catch { /* Windows file locks */ }
}

console.log(`\nScreenshots: ${screenshotsDir}`)
if (failed > 0) {
  console.error(`checkTournamentMatchesBrowserE2E failed: ${failed} failed, ${passed} passed.`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`checkTournamentMatchesBrowserE2E passed: ${passed} checks.`)
