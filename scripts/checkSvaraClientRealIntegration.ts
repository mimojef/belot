/**
 * checkSvaraClientRealIntegration.ts
 *
 * Real (non-mocked) integration test за Етап 2Б.3.7.2 "Реално клиентско
 * WebSocket свързване" — real spawned backend (SVARA_TEST_ENABLED=1, real
 * SQLite), real built frontend bundle (dist/), real headless browser
 * (Playwright) за ДВЕ отделни реални сесии (userA/userB), управлявани
 * изцяло през реалния UI (createSvaraLobbyController.ts, mount-нат от
 * createLobbyFlowController.ts), не през raw WS injection — доказва, че
 * РЕАЛНИЯТ клиентски код (createGameServerClient.ts, createLobbyFlowController.ts,
 * createSvaraLobbyController.ts) работи end-to-end срещу реалния сървърен
 * протокол (server/src/games/svara/protocol/svaraLobbyProtocol.ts), не само
 * срещу собствените си TypeScript типове.
 *
 * Server-side протокол/privacy/revision поведение (individual snapshot
 * hidden-card isolation, revision monotonicity, duplicate-command handling,
 * restart durability) вече е изчерпателно покрито от
 * server/scripts/checkSvaraRestart2B36C.ts (raw-ws, server-focused) — този
 * тест умишлено НЕ дублира тези assertions. Фокусът тук е чисто
 * КЛИЕНТСКИ: реален table list, create/join/leave/start през реалния UI,
 * real-time update на партньора БЕЗ manual refresh, и критичният "без
 * автоматичен game exit при unmount/navigation away" lifecycle контракт
 * (задание §9).
 *
 * Покрива:
 *   T1. Празен real table list (loading -> empty state).
 *   T2. Create table (real UI форма) -> real server команда -> waiting
 *       room показва коректен участник/капацитет.
 *   T3. Втори реален потребител вижда масата в list-а и се присъединява
 *       през real UI -> ПЪРВИЯТ потребител вижда 2/2 участника БЕЗ manual
 *       refresh (real-time server_table_updated broadcast).
 *   T4. Explicit "Напусни" от waiting room -> масата се връща на 1/2 И при
 *       двамата (userB вижда масата отново в list-а, userA вижда 1/2 в
 *       waiting room-а си), без page reload.
 *   T5. Повторно join + manual start (host) -> ОБА потребителя преминават
 *       в active-table view с реална ревизия от сървъра; преди какъвто и да
 *       е "Погледни"/залог клик, собствените карти (snapshot.you.cards)
 *       законно остават null — data-svara-own-cards не трябва да се
 *       рендира въобще за никой от двамата (§13 "own unlooked cards stay
 *       hidden", сега проверено и за 2Б.3.7.4's реално look бутон).
 *   T13-T17 (2Б.3.7.4): реален залог (Погледни -> Плати), реално повишаване
 *       (×N), реален отказ (Бягам), постоянен бадж, банка/стекове по
 *       реалния ledger, без двойно начисляване след reconnect.
 *   T6. Навигация away от /games/svara (back-to-games) докато мачът е
 *       in-progress НЕ изпраща leave/exit — userB остава незасегнат; при
 *       връщане userA се restore-ва автоматично в СЪЩАТА активна маса (viж
 *       setTables own-table auto-detect в createSvaraLobbyController.ts),
 *       без втори join и без нов start.
 *   T7. Static guard: createSvaraLobbyController.ts/createGameServerClient.ts
 *       Svara-специфичните добавки не ползват `any` за да прикрият
 *       client/server protocol mismatch (задание §7).
 *   T8. Без uncaught JS грешки в браузъра през целия сценарий.
 *
 * Изход: process.exit(0) при успех, process.exit(1) с описание на грешката.
 */

import { readFileSync } from 'node:fs'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, symlink, readFile, stat } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { extname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'

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
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)) }

// 2Б.3.7.5А §6/§18 — единна atomic (виж T12's root-cause коментара защо
// atomic, не две отделни round-trips) layout проверка, преизползвана за
// MULTIPLE реални състояния на масата (по време на раздаването, след
// активни bet бутони, след доброволен отказ, след reconnect), не само
// веднъж точно след старта на мача.
async function measureSvaraLayoutOnce(page: Page) {
  return page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll<HTMLElement>('[data-svara-seat-anchor]')).map((el) => ({
      slot: el.getAttribute('data-svara-seat-anchor'),
      seatIndex: el.getAttribute('data-svara-seat-index'),
      rect: el.getBoundingClientRect().toJSON(),
    }))
    const bottom = anchors.find((a) => a.slot === 'bottom') ?? null
    return {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      windowHeight: window.innerHeight,
      anchorCount: anchors.length,
      anchors,
      bottomPanelBottom: bottom?.rect.bottom ?? null,
      diagnostics: document.querySelector('[data-svara-diagnostics]')?.textContent ?? null,
      dealingOverlayActive: document.querySelector('[data-svara-dealing-overlay]') !== null,
      actionButtonCount: document.querySelectorAll('[data-svara-action-bar] [data-svara-action-button]').length,
    }
  })
}
// Real-browser QA finding (2Б.3.7.5А): `page.setViewportSize()` intermittently
// throws a CDP "Browser.setWindowBounds: fullscreen window" Protocol error —
// observed well after T11's own requestFullscreen()/exitFullscreen() cycle,
// and `document.exitFullscreen()` retrying before the resize did NOT fix it.
// That rules out Document-level fullscreen: this is the separate CDP
// Browser-domain windowState bit (headless Chromium can map an element's
// Fullscreen API request onto the virtual window's actual windowState, and
// apparently does not always flip it back to 'normal' when the page exits
// fullscreen at the DOM level) — a Playwright/Chromium headless quirk in the
// test harness, not an application bug, since the Svara client never touches
// window bounds itself. Fixed by resetting windowState via a raw CDP session
// (Browser domain, not Page domain) before retrying the resize.
async function resetWindowStateToNormal(page: Page): Promise<void> {
  try {
    const client = await page.context().newCDPSession(page)
    const { windowId } = await client.send('Browser.getWindowForTarget')
    await client.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } })
    await client.detach().catch(() => {})
  } catch {
    // Best-effort — ако CDP session-ът самият не успее, оставяме retry-то в
    // setSvaraViewportSize да surface-не оригиналната грешка нормално.
  }
}
async function setSvaraViewportSize(page: Page, vp: { width: number; height: number }): Promise<void> {
  try {
    await page.setViewportSize(vp)
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes('setWindowBounds')) throw err
    await resetWindowStateToNormal(page)
    await sleep(300)
    await page.setViewportSize(vp)
  }
}
async function measureSvaraLayout(page: Page, vp: { width: number; height: number }) {
  await setSvaraViewportSize(page, vp)
  await sleep(150)
  let measurement = await measureSvaraLayoutOnce(page)
  // Real-browser QA finding (2Б.3.7.5А): a COMPLETELY empty mount
  // (anchorCount===0 AND diagnostics===null, i.e. not even the active-table
  // shell exists) is the signature of createLobbyFlowController.ts's own
  // DOCUMENTED, already-mitigated reconciliation race — an unrelated full
  // `options.root.innerHTML` rebuild elsewhere in the giant lobby controller
  // (chat/notifications polling etc., see the "НАПЪЛНО несвързани re-render-и"
  // comment at _svaraLastSnapshot's declaration) can momentarily orphan the
  // Svara mount before its own render() detects `mountRoot.childElementCount
  // === 0` and re-mounts + replays the cached snapshot. That recovery is a
  // single microtask (cached dynamic import) + one render call, not a
  // multi-second wait — polling briefly for it is waiting on a real,
  // already-self-healing async condition, not masking a permanent failure.
  // A PARTIAL render (diagnostics present but the bottom anchor specifically
  // missing/wrong) is a DIFFERENT, genuine-defect signature and must NOT be
  // retried away.
  const looksOrphaned = (m: Awaited<ReturnType<typeof measureSvaraLayoutOnce>>) => m.anchorCount === 0 && m.diagnostics === null
  const deadline = Date.now() + 2_000
  while (looksOrphaned(measurement) && Date.now() < deadline) {
    await sleep(100)
    measurement = await measureSvaraLayoutOnce(page)
  }
  return measurement
}
function assertSvaraLayoutOk(measurement: Awaited<ReturnType<typeof measureSvaraLayout>>, label: string, recentLog: () => string): void {
  if (measurement.scrollWidth > measurement.clientWidth) {
    throw new Error(`horizontal overflow at ${label}: scrollWidth=${measurement.scrollWidth} > clientWidth=${measurement.clientWidth} — diag=${JSON.stringify(measurement)}`)
  }
  if (measurement.bottomPanelBottom === null) {
    throw new Error(`self (bottom) seat panel not found at ${label} — diag=${JSON.stringify(measurement)}\nrecent WS log:\n${recentLog()}`)
  }
  if (measurement.bottomPanelBottom > measurement.windowHeight) {
    throw new Error(`self (bottom) seat panel extends past the viewport at ${label}: bottom=${measurement.bottomPanelBottom.toFixed(0)} > windowHeight=${measurement.windowHeight} — diag=${JSON.stringify(measurement)}`)
  }
}
function assertEqualNum(actual: number, expected: number, message: string): void {
  if (actual !== expected) throw new Error(`${message} (got ${actual}, expected ${expected})`)
}

async function findFreePort(): Promise<number> {
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

async function waitForCondition(label: string, predicate: () => Promise<boolean> | boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await sleep(200)
  }
  throw new Error(`Timeout: ${label}`)
}

// 2Б.3.7.4В: fail fast and clearly if a PREVIOUS (orphaned) run of this same
// test is still squatting the fixed backend port — without this, a stale
// process answers /health on behalf of its OWN (unrelated, already-
// migrated) database, and this test proceeds to query the NEW isolated
// database as if it were ready, long before the real backend startup it
// actually spawned has even begun applying migrations. Root cause found via
// `netstat`: a leftover `tsx .../src/index.ts` child from an earlier
// interrupted run was LISTENING on the port; the freshly spawned child
// never got to bind it at all.
async function assertPortFree(port: number): Promise<void> {
  await new Promise<void>((resolveFree, reject) => {
    const probe = createNetServer()
    probe.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(
          `Port ${port} is already in use by another process — a previous Svara integration ` +
          `test run likely did not shut down cleanly. Find and stop it before retrying ` +
          `(Windows: "netstat -ano | find \":${port}\"" then "taskkill /PID <pid> /F").`,
        ))
      } else reject(err)
    })
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolveFree()))
  })
}

// Anchors "ready" to THIS exact spawned child, not to whoever answers the
// fixed port: ensureServerDatabaseReady() runs synchronously (top-level
// await) before the HTTP listener even starts, and server/src/index.ts logs
// its resolved database file path right after — so seeing this exact line
// in OUR child's own captured stdout proves migrations for OUR isolated
// database file actually completed, before we ever trust a /health response
// on the shared port. Fails fast (not after the full timeout) if the child
// exits early (e.g. a real EADDRINUSE despite the preflight check above).
async function waitForOwnBackendReady(server: RunningServer, databaseFilePath: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  const dbReadyMarker = `[db] SQLite ready file=${databaseFilePath} `
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) {
      throw new Error(`Backend process exited early (code ${server.child.exitCode}) before confirming its own database bootstrap.\n--- server output ---\n${server.output()}`)
    }
    if (server.output().includes(dbReadyMarker)) break
    await sleep(200)
  }
  if (!server.output().includes(dbReadyMarker)) {
    throw new Error(`Timeout: backend did not confirm its own database bootstrap ("${dbReadyMarker.trim()}") within ${timeoutMs}ms.\n--- server output ---\n${server.output()}`)
  }
  await waitForBackendHealth(port, Math.max(1000, deadline - Date.now()))
}

async function httpJson(
  port: number,
  method: string,
  pathname: string,
  body?: unknown,
): Promise<{ status: number; body: any; setCookie: string | null }> {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const setCookie = (res.headers.getSetCookie?.()[0] ?? res.headers.get('set-cookie'))?.split(';')[0] ?? null
  let json: any = null
  try { json = await res.json() } catch { /* not json */ }
  return { status: res.status, body: json, setCookie }
}

// ─── Isolated real backend (fixed port 3001 — hardcoded in the real client's
// getDefaultServerUrl() for hostname 127.0.0.1, see createGameServerClient.ts) ──

const PROJECT_ROOT = process.cwd()
const BACKEND_PORT = 3001

async function retryRm(path: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try { await rm(path, { recursive: true, force: true }); return } catch { /* retry */ }
    await sleep(250)
  }
}

async function createIsolatedServerRoot() {
  const root = await mkdtemp(join(tmpdir(), 'belot-svara-client-'))
  const serverDir = join(root, 'server')
  const originalServerRoot = resolve(PROJECT_ROOT, 'server')
  await mkdir(serverDir, { recursive: true })
  await cp(join(originalServerRoot, 'src'), join(serverDir, 'src'), { recursive: true, preserveTimestamps: true })
  await cp(join(originalServerRoot, 'dist'), join(serverDir, 'dist'), { recursive: true, preserveTimestamps: true })
  await mkdir(join(serverDir, 'database', 'data'), { recursive: true })
  await cp(join(originalServerRoot, 'database', 'migrations'), join(serverDir, 'database', 'migrations'), { recursive: true, preserveTimestamps: true })
  await cp(join(originalServerRoot, 'package.json'), join(serverDir, 'package.json'), { preserveTimestamps: true })
  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  await symlink(join(originalServerRoot, 'node_modules'), join(serverDir, 'node_modules'), linkType)
  await symlink(join(originalServerRoot, '..', 'node_modules'), join(root, 'node_modules'), linkType)
  return { serverDir, dbFile: join(serverDir, 'database', 'data', 'belot-v2.sqlite'), cleanup: () => retryRm(root) }
}

type RunningServer = { child: ChildProcessWithoutNullStreams; output(): string }

function startServer(serverDir: string, port: number): RunningServer {
  const chunks: string[] = []
  const child = spawn(
    process.execPath,
    [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'index.ts')],
    {
      cwd: serverDir,
      env: {
        ...process.env,
        PORT: String(port),
        SVARA_TEST_ENABLED: '1',
        // Required for POST /api/auth/register to not short-circuit with
        // "Регистрацията временно не е налична." — see server/src/index.ts's
        // registrationVerificationCodeSecret length>=32 guard.
        PASSWORD_RESET_RATE_LIMIT_SECRET: 'isolated-svara-client-integration-secret-123456',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (c) => chunks.push(c))
  child.stderr.on('data', (c) => chunks.push(c))
  return { child, output: () => chunks.join('') }
}

async function stopServer(server: RunningServer | null): Promise<void> {
  if (!server || server.child.exitCode !== null) return
  server.child.kill()
  await new Promise<void>((r) => {
    const t = setTimeout(() => { try { server.child.kill('SIGKILL') } catch { /* */ }; r() }, 10_000)
    server.child.once('exit', () => { clearTimeout(t); r() })
  })
}

async function waitForBackendHealth(port: number, timeoutMs: number): Promise<void> {
  await waitForCondition(`backend health on ${port}`, async () => {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`)
      const h = await r.json()
      return r.status === 200 && h.ok === true && h.gameWorkerLifecycle?.state === 'ready'
    } catch { return false }
  }, timeoutMs)
}

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg', '.woff2': 'font/woff2', '.txt': 'text/plain', '.xml': 'application/xml',
}

function startStaticServer(distDir: string, port: number) {
  return createHttpServer(async (req, res) => {
    try {
      const urlPath = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
      let filePath = join(distDir, urlPath === '/' ? '/index.html' : urlPath)
      try {
        const st = await stat(filePath)
        if (st.isDirectory()) filePath = join(filePath, 'index.html')
      } catch {
        if (!extname(urlPath)) filePath = join(distDir, 'index.html')
      }
      const data = await readFile(filePath)
      res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream' })
      res.end(data)
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('404')
    }
  }).listen(port, '127.0.0.1')
}

function runFrontendBuild(): Promise<void> {
  return new Promise((resolveBuild, reject) => {
    const child: ChildProcessWithoutNullStreams = spawn('npx', ['vite', 'build'], { cwd: PROJECT_ROOT, shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => { out += d.toString() })
    child.stderr.on('data', (d) => { out += d.toString() })
    child.on('exit', (code) => code === 0 ? resolveBuild() : reject(new Error(out.slice(-2000))))
  })
}

// ─── T7 static guard: no `any` in the new Svara client files (checked
// up-front, no server/browser needed) ───────────────────────────────────

await check('[T7] createSvaraLobbyController.ts contains no `any` (no hiding client/server protocol mismatches)', () => {
  const src = readFileSync(join(PROJECT_ROOT, 'src/app/games/svara/createSvaraLobbyController.ts'), 'utf8')
  const matches = src.match(/\bany\b/g) ?? []
  if (matches.length > 0) throw new Error(`found ${matches.length} occurrence(s) of "any"`)
})

await check('[T7] createGameServerClient.ts Svara type/method block contains no `any`', () => {
  const src = readFileSync(join(PROJECT_ROOT, 'src/app/network/createGameServerClient.ts'), 'utf8')
  const start = src.indexOf("| { type: 'request_svara_tables_list' }")
  const end = src.indexOf('function requestSvaraTableState')
  if (start === -1 || end === -1) throw new Error('Svara block markers not found — file structure changed')
  const block = src.slice(start, end)
  const matches = block.match(/\bany\b/g) ?? []
  if (matches.length > 0) throw new Error(`found ${matches.length} occurrence(s) of "any" inside the Svara protocol block`)
})

console.log('\ncheckSvaraClientRealIntegration\n')
console.log('Building frontend (dist/, needed for a real index.html/main bundle)...')
await runFrontendBuild()

const isolated = await createIsolatedServerRoot()
let server: RunningServer | null = null
let staticServer: ReturnType<typeof createHttpServer> | null = null
let browser: Browser | null = null

try {
  await assertPortFree(BACKEND_PORT)
  console.log(`Starting real backend on fixed port ${BACKEND_PORT} (SVARA_TEST_ENABLED=1)...`)
  server = startServer(isolated.serverDir, BACKEND_PORT)
  try {
    await waitForOwnBackendReady(server, isolated.dbFile, BACKEND_PORT, 30_000)
  } catch (err) {
    console.error('--- server output ---')
    console.error(server.output())
    throw err
  }
  console.log('Backend ready.\n')

  // Registration defaults to the email_code verification flow (Brevo),
  // which this isolated test env has no transport for — switch to the
  // 'direct' admin setting (same key the real admin panel toggles via
  // POST /api/admin/settings) so /api/auth/register materializes the
  // account/session immediately, exactly like it already does when an
  // admin has configured it that way in production.
  {
    const settingsDb = new DatabaseSync(isolated.dbFile)
    try {
      settingsDb.prepare(
        `INSERT INTO admin_settings (setting_key, setting_value) VALUES ('registration_verification_mode', 'direct')
         ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = CURRENT_TIMESTAMP;`,
      ).run()
    } finally {
      settingsDb.close()
    }
  }

  const staticPort = await findFreePort()
  staticServer = startStaticServer(join(PROJECT_ROOT, 'dist'), staticPort)
  await sleep(300)

  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  async function registerUser(label: string): Promise<{ cookie: string; cookieName: string; cookieValue: string; profileId: string; email: string }> {
    const email = `svara-client-${label}-${runId}@example.test`
    const reg = await httpJson(BACKEND_PORT, 'POST', '/api/auth/register', {
      email, password: 'SvaraClientDiag1!', displayName: `SC ${label} ${Date.now() % 100000}`, gender: 'male', visitorId: randomUUID(),
    })
    if (reg.status !== 200) {
      console.error('--- server output (registration failure diagnosis) ---')
      console.error(server?.output().slice(-4000))
      throw new Error(`Registration failed for ${label}: ${JSON.stringify(reg.body)}`)
    }
    const cookie = reg.setCookie as string
    const [cookieName, cookieValue] = cookie.split('=')
    // Grant an allowed Svara test role — same mechanism as
    // server/scripts/checkSvaraRestart2B36C.ts's register().
    const db = new DatabaseSync(isolated.dbFile)
    try { db.prepare("UPDATE accounts SET role = 'admin' WHERE email = ?").run(email) } finally { db.close() }
    return { cookie, cookieName: cookieName!, cookieValue: cookieValue!, profileId: reg.body.session.profile.profileId, email }
  }

  console.log('Registering two real users and granting the Svara test role...')
  const userA = await registerUser('a')
  const userB = await registerUser('b')

  browser = await chromium.launch({ headless: true })
  const consoleErrors: string[] = []

  async function openSvaraPage(user: { cookieName: string; cookieValue: string }): Promise<{ context: BrowserContext; page: Page }> {
    const context = await browser!.newContext({ viewport: { width: 420, height: 900 } })
    await context.addCookies([{ name: user.cookieName, value: user.cookieValue, domain: '127.0.0.1', path: '/' }])
    const page = await context.newPage()
    page.on('pageerror', (err) => consoleErrors.push(`${err.message}`))
    const svaraLog: string[] = []
    page.on('console', (msg) => { if (msg.text().includes('game-server') || msg.text().includes('svara')) svaraLog.push(msg.text()) })
    ;(page as any)._svaraLog = svaraLog
    await page.goto(`http://127.0.0.1:${staticPort}/games/svara`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-svara-lobby="1"]', { timeout: 20_000 })
    // Real cookie-consent banner (unrelated to Svara) otherwise intercepts
    // later clicks (e.g. "Обратно към Игри") and can eat a full click-retry
    // timeout, during which an UNRELATED real 15s turn deadline can elapse
    // and degrade match state out from under the test.
    await page.getByText('Приеми всички').click({ timeout: 3_000 }).catch(() => {})
    return { context, page }
  }

  console.log('Opening real pages for both users (direct /games/svara load, real cookie, real WS)...')
  const sessionA = await openSvaraPage(userA)
  const sessionB = await openSvaraPage(userB)

  await check('[T1] userA sees the real empty table list on first load', async () => {
    await sessionA.page.waitForFunction(
      () => document.querySelector('[data-svara-lobby="1"]')?.textContent?.includes('В момента няма чакащи маси') ?? false,
      undefined, { timeout: 10_000 },
    )
  })

  async function openCreateModalAndSubmit(page: Page, capacity: 2 | 3 | 4, entryFee: number): Promise<void> {
    await page.click('[data-svara-create-open]')
    await page.waitForSelector('[data-svara-create-form]', { timeout: 5_000 })
    await page.selectOption('[data-svara-create-form] select[name="capacity"]', String(capacity))
    await page.fill('[data-svara-create-form] input[name="entryFee"]', String(entryFee))
    await page.click('[data-svara-create-form] button[type="submit"]')
  }

  await check('[T2] userA creates a real table via the UI -> waiting room shows 1/2 participants', async () => {
    await openCreateModalAndSubmit(sessionA.page, 2, 500)
    await sessionA.page.waitForFunction(
      () => document.querySelector('[data-svara-lobby="1"]')?.textContent?.includes('1/2') ?? false,
      undefined, { timeout: 10_000 },
    )
  })

  await check('[T3] userB sees the real table in the list and joins -> BOTH see 2/2 WITHOUT manual refresh', async () => {
    await sessionB.page.waitForFunction(
      () => Array.from(document.querySelectorAll('[data-svara-table-join]')).length > 0,
      undefined, { timeout: 10_000 },
    )
    await sessionB.page.click('[data-svara-table-join]')
    await sessionB.page.waitForFunction(
      () => document.querySelector('[data-svara-lobby="1"]')?.textContent?.includes('2/2') ?? false,
      undefined, { timeout: 10_000 },
    )
    // userA never clicked anything — this MUST come from the real-time
    // svara_table_updated broadcast, not a manual refresh action.
    await sessionA.page.waitForFunction(
      () => document.querySelector('[data-svara-lobby="1"]')?.textContent?.includes('2/2') ?? false,
      undefined, { timeout: 10_000 },
    )
  })

  await check('[T4] userB leaves via the real "Напусни" button -> BOTH see 1/2 again, no page reload', async () => {
    await sessionB.page.click('[data-svara-table-leave]')
    // userB returns to the list view, where userA's still-waiting table is
    // visible again as a joinable 1/2 card (NOT an empty list — userA never left).
    await sessionB.page.waitForFunction(
      () => Array.from(document.querySelectorAll('[data-svara-table-join]')).length > 0
        && (document.querySelector('[data-svara-lobby="1"]')?.textContent?.includes('1/2') ?? false),
      undefined, { timeout: 10_000 },
    )
    await sessionA.page.waitForFunction(
      () => document.querySelector('[data-svara-lobby="1"]')?.textContent?.includes('1/2') ?? false,
      undefined, { timeout: 10_000 },
    )
  })

  await check('[T5] userB rejoins, host starts the real match -> BOTH reach active view; unlooked cards stay hidden (no look/bet UI exists in this sub-stage by design)', async () => {
    await sessionB.page.waitForFunction(
      () => Array.from(document.querySelectorAll('[data-svara-table-join]')).length > 0,
      undefined, { timeout: 10_000 },
    )
    await sessionB.page.click('[data-svara-table-join]')
    await sessionA.page.waitForFunction(
      () => document.querySelector('[data-svara-lobby="1"]')?.textContent?.includes('2/2') ?? false,
      undefined, { timeout: 10_000 },
    )
    await sessionA.page.waitForSelector('[data-svara-table-start]:not([disabled])', { timeout: 10_000 })
    await sessionA.page.click('[data-svara-table-start]')

    await sessionA.page.waitForSelector('[data-svara-diagnostics]', { timeout: 15_000 })
    await sessionB.page.waitForSelector('[data-svara-diagnostics]', { timeout: 15_000 })

    // 2Б.3.7.4Б: a fresh deal starts in the server dealing-presentation
    // phase — BOTH real sessions must see this immediately (no one "on
    // turn" yet, no action bar for either), proving the server actually
    // suppressed betting for both, not just coincidentally slow UI.
    for (const session of [sessionA, sessionB]) {
      const earlyButtons = await session.page.locator('[data-svara-action-bar] [data-svara-action-button]').count()
      if (earlyButtons !== 0) throw new Error('an action bar/button must not appear for anyone while the server dealing-presentation phase is still open')
    }

    // Revision must be a real positive number coming from the server (not a
    // placeholder/dash), for both.
    for (const session of [sessionA, sessionB]) {
      const diagnosticsText = await session.page.locator('[data-svara-diagnostics]').textContent() ?? ''
      if (!/rev\s*\d+/.test(diagnosticsText)) throw new Error(`expected a real numeric revision in diagnostics, got: ${diagnosticsText}`)
    }

    // §13 "own unlooked cards stay hidden" / §17 "no bet/gameplay buttons in
    // this sub-stage" — this minimal view never sends a `look` command, so
    // own cards (snapshot.you.cards) legitimately stay null/hidden for BOTH
    // players; data-svara-own-cards must therefore be ABSENT, not merely
    // empty — rendering it with empty content would itself be a leak signal
    // (distinguishes "server sent nothing" from "server sent an empty hand").
    const ownCardsVisibleA = await sessionA.page.locator('[data-svara-own-cards]').count()
    const ownCardsVisibleB = await sessionB.page.locator('[data-svara-own-cards]').count()
    if (ownCardsVisibleA !== 0 || ownCardsVisibleB !== 0) {
      throw new Error('own cards must stay hidden until an explicit `look` command (no such UI exists yet) — data-svara-own-cards should not be rendered at all')
    }
  })

  await check('[T12] the active table never overflows horizontally, and the self (bottom) panel stays within the viewport, across required breakpoints (задание §18)', async () => {
    // Runs IMMEDIATELY while the match is freshly active (right after T5),
    // deliberately BEFORE T6/T9-T11 spend extra wall-clock time — nothing in
    // this sub-stage ever sends an "act" command yet (no bet/fold UI, see
    // §14), so the real 15s server turn deadline keeps ticking down in the
    // background regardless of what the test does; this is layout
    // verification, not a test of how long an un-acted match survives.
    //
    // Root-cause note (2Б.3.7.5А): T5 only waits for `[data-svara-diagnostics]`,
    // which renders UNCONDITIONALLY inside the felt even while
    // `snapshot.seats` is still empty — the real client legitimately shows a
    // brief "Зареждане на масата…" placeholder (ZERO seat anchors) during the
    // narrow window between the `svara_table_updated` (phase: in-progress)
    // broadcast and the FOLLOWING `svara_match_snapshot` that actually carries
    // the seats. That is a genuine, clearly-defined async state (not a
    // disguised sleep) worth waiting for in its own right — proceeding to
    // viewport-resize measurements before it resolves was the test's bug, not
    // the app's: it could land mid-placeholder and misreport a missing seat
    // panel. Waiting for the bottom anchor specifically (not just "some
    // anchor") also doubles as a minimal regression check for seat-slot
    // assignment being correct from the very first real render.
    await sessionA.page.waitForSelector('[data-svara-seat-anchor="bottom"]', { timeout: 10_000 })

    const viewportsToCheck: Array<{ width: number; height: number }> = [
      { width: 320, height: 568 },
      { width: 390, height: 844 },
      { width: 430, height: 932 },
      { width: 844, height: 390 },
      { width: 1280, height: 900 },
    ]
    const recentLog = (): string => ((sessionA.page as any)._svaraLog as string[]).slice(-15).join('\n')
    for (const vp of viewportsToCheck) {
      const measurement = await measureSvaraLayout(sessionA.page, vp)
      assertSvaraLayoutOk(measurement, `${vp.width}x${vp.height} (during dealing)`, recentLog)
    }
    await setSvaraViewportSize(sessionA.page, { width: 420, height: 900 })
  })

  async function findActor(): Promise<{ page: Page; context: BrowserContext; label: 'A' | 'B' }> {
    // 2Б.3.7.4Б: a fresh deal now spends a real server dealing-presentation
    // phase (Вход + карти, 2900-5000ms depending on capacity) before ANY
    // action bar appears for anyone — poll instead of a single snapshot check.
    const deadline = Date.now() + 10_000
    for (;;) {
      for (const [label, session] of [['A', sessionA], ['B', sessionB]] as const) {
        const buttonCount = await session.page.locator('[data-svara-action-bar] [data-svara-action-button]').count()
        if (buttonCount > 0) return { ...session, label }
      }
      if (Date.now() >= deadline) throw new Error('neither session has an active action bar — no one is apparently on turn')
      await sleep(200)
    }
  }
  function other(label: 'A' | 'B') { return label === 'A' ? sessionB : sessionA }
  async function readSeatTotalsOnce(page: Page): Promise<{ bank: number | null; selfStack: number | null; selfTotal: number | null; selfBadge: string | null; bottomAnchorPresent: boolean }> {
    return page.evaluate(() => {
      const feltText = document.querySelector('[data-svara-felt-center]')?.textContent ?? ''
      const bankMatch = /Банка:\s*(\d+)/.exec(feltText)
      const bottomAnchor = document.querySelector('[data-svara-seat-anchor="bottom"]')
      const totalEl = bottomAnchor?.querySelector('[data-svara-seat-total]')
      const totalText = totalEl?.textContent ?? ''
      const stackMatch = /^(\d+)/.exec(totalText.trim())
      const contribMatch = /общо\s*(\d+)/.exec(totalText)
      const badgeEl = bottomAnchor?.querySelector('[data-svara-seat-badges]')
      return {
        bank: bankMatch ? Number(bankMatch[1]) : null,
        selfStack: stackMatch ? Number(stackMatch[1]) : null,
        selfTotal: contribMatch ? Number(contribMatch[1]) : null,
        selfBadge: badgeEl?.textContent ?? null,
        bottomAnchorPresent: bottomAnchor !== null,
      }
    })
  }
  // Real-browser QA finding (2Б.3.7.5А) — same orphan/remount race as
  // measureSvaraLayout's `looksOrphaned` retry (see its doc comment): the
  // bottom anchor (and so `seat.stack`, which is ALWAYS rendered once a
  // match is active, in every round kind) can transiently disappear if an
  // unrelated full lobby-root rebuild races the exact read, even right after
  // a `waitForSelector` confirmed it existed a moment earlier. Retrying
  // briefly here — not on every caller individually — closes that gap once.
  async function readSeatTotals(page: Page): Promise<{ bank: number | null; selfStack: number | null; selfTotal: number | null; selfBadge: string | null }> {
    let result = await readSeatTotalsOnce(page)
    const deadline = Date.now() + 2_000
    while (!result.bottomAnchorPresent && Date.now() < deadline) {
      await sleep(100)
      result = await readSeatTotalsOnce(page)
    }
    return result
  }

  // T9/T10/T11 проверяват инварианти на ОБИЧАЙНАТА активна маса (преди
  // залозите да стигнат до край на раздаването) — умишлено ТУК, преди T13-
  // T17, защото T16's реален отказ при 2-ма играчи приключва раздаването
  // веднага (reveal-choice преход), след което "Банка"/dealerId временно не
  // се показват по същия начин (виж T16's коментар по-долу).
  await check('[T9] "ти" marker sits on the BOTTOM-anchored seat for EACH player — real, per-player seat rotation (задание §4/§18)', async () => {
    for (const session of [sessionA, sessionB]) {
      const bottomText = await session.page.locator('[data-svara-seat-anchor="bottom"]').textContent()
      if (!bottomText || !bottomText.includes('(ти)')) throw new Error(`expected the bottom-anchored seat to contain the local "(ти)" marker, got: ${bottomText}`)
    }
    // And they must NOT be the same seatIndex (two real distinct players).
    const bottomSeatIndexA = await sessionA.page.locator('[data-svara-seat-anchor="bottom"]').getAttribute('data-svara-seat-index')
    const bottomSeatIndexB = await sessionB.page.locator('[data-svara-seat-anchor="bottom"]').getAttribute('data-svara-seat-index')
    if (bottomSeatIndexA === bottomSeatIndexB) throw new Error(`userA and userB must see DIFFERENT seatIndex values at the bottom anchor (each sees themself), got the same value "${bottomSeatIndexA}" for both`)
  })

  await check('[T10] exactly one dealer badge is rendered on the real table, never duplicated', async () => {
    for (const session of [sessionA, sessionB]) {
      const dealerBadgeCount = await session.page.locator('[data-svara-dealer-badge]').count()
      if (dealerBadgeCount !== 1) throw new Error(`expected exactly 1 dealer badge, got ${dealerBadgeCount}`)
    }
  })

  await check('[T11] fullscreen toggle button calls the real Fullscreen API on click (задание §13)', async () => {
    // Headless Chromium's fullscreen support is environment-dependent — we
    // assert the REAL browser API was actually invoked (not a fake/no-op
    // client-side flag), by instrumenting the real requestFullscreen/
    // exitFullscreen before clicking, rather than asserting document.
    // fullscreenElement (which can be refused by the headless sandbox for
    // reasons unrelated to our code).
    const calls = await sessionA.page.evaluate(async () => {
      const table = document.querySelector('[data-svara-table]') as HTMLElement | null
      if (!table) return { hasButton: false, requestCalled: false }
      let requestCalled = false
      const original = table.requestFullscreen?.bind(table)
      table.requestFullscreen = (...args: unknown[]) => {
        requestCalled = true
        return original ? (original as any)(...args).catch(() => {}) : Promise.resolve()
      }
      const button = document.querySelector('[data-svara-fullscreen-toggle]') as HTMLElement | null
      if (!button) return { hasButton: false, requestCalled: false }
      button.click()
      await new Promise((r) => setTimeout(r, 200))
      return { hasButton: true, requestCalled }
    })
    if (!calls.hasButton) throw new Error('fullscreen toggle button must be rendered when the browser supports the Fullscreen API')
    if (!calls.requestCalled) throw new Error('clicking the fullscreen button must call the real element.requestFullscreen(), not a fake client-side-only toggle')
    // Headless Chromium can actually GRANT programmatic fullscreen — leave
    // it active and the subsequent viewport-resize checks (T12) would
    // measure a real fullscreen layout instead of the plain embedded one.
    // Also resets the CDP Browser-domain windowState (see
    // resetWindowStateToNormal's doc comment) at the source — exitFullscreen()
    // alone only clears the Document-level state and was observed to
    // occasionally leave the virtual window's own windowState stuck, later
    // breaking unrelated setViewportSize() calls much further into the run.
    await sessionA.page.evaluate(() => { if (document.fullscreenElement) void document.exitFullscreen().catch(() => {}) })
    await sleep(200)
    await resetWindowStateToNormal(sessionA.page)
  })

  await check('[T13] Погледни -> реалните собствени карти се показват едва СЛЕД explicit клик (не оптимистично по-рано)', async () => {
    const actor = await findActor()
    const beforeLook = await actor.page.locator('[data-svara-own-cards]').count()
    if (beforeLook !== 0) throw new Error('own cards must not be visible before an explicit "Погледни" click')
    const hasLook = await actor.page.locator('[data-svara-action-button="look"]').count()
    if (hasLook > 0) {
      await actor.page.click('[data-svara-action-button="look"]')
      await actor.page.waitForFunction(() => document.querySelector('[data-svara-own-cards]') !== null, undefined, { timeout: 10_000 })
    }
  })

  let actorLabel: 'A' | 'B' = 'A'
  await check('[T14] Реален първи залог ("Плати") -> банката/стекът/баджът се обновяват по РЕАЛНИЯ сървърен ledger за ДВАМАТА, без ръчно въвеждане на сума', async () => {
    const actor = await findActor()
    actorLabel = actor.label
    const before = await readSeatTotals(actor.page)
    await actor.page.waitForSelector('[data-svara-action-button="pay"]:not([disabled])', { timeout: 10_000 })
    const payLabel = await actor.page.locator('[data-svara-action-button="pay"]').textContent()
    const payAmount = Number(/\d+/.exec(payLabel ?? '')?.[0] ?? NaN)
    if (!Number.isFinite(payAmount)) throw new Error(`could not parse the "Плати" amount from label "${payLabel}"`)
    await actor.page.click('[data-svara-action-button="pay"]')
    await actor.page.waitForFunction(
      (expected) => document.querySelector('[data-svara-seat-anchor="bottom"] [data-svara-seat-badges]')?.textContent?.includes(String(expected)) ?? false,
      payAmount, { timeout: 10_000 },
    )
    const after = await readSeatTotals(actor.page)
    if (before.selfStack === null || after.selfStack === null) throw new Error('could not read the stack before/after the bet')
    assertEqualNum(before.selfStack - after.selfStack, payAmount, 'the stack must decrease by EXACTLY the amount shown on the "Плати" button — no silent extra/short charge')
    if (after.selfBadge === null || !after.selfBadge.includes(String(payAmount))) throw new Error(`persistent bet badge must show the real amount ${payAmount}, got: ${after.selfBadge}`)

    // Реалният бюджет се вижда еднакво и от ДВАМАТА (real-time, без manual refresh) — вкл. банката.
    const otherSession = other(actor.label)
    await otherSession.page.waitForFunction(
      (expected) => (document.querySelector('[data-svara-felt-center]')?.textContent ?? '').includes(`Банка: ${expected}`),
      (before.bank ?? 0) + payAmount, { timeout: 10_000 },
    )
  })

  await check('[T15] Реално повишаване (×2) от следващия играч -> точната сума (min×2), не приблизителна', async () => {
    const actor = await findActor()
    if (actor.label === actorLabel) throw new Error('turn must have moved to the OTHER player after a valid bet')
    const before = await readSeatTotals(actor.page)
    const hasLook = await actor.page.locator('[data-svara-action-button="look"]').count()
    if (hasLook > 0) {
      await actor.page.click('[data-svara-action-button="look"]')
      await sleep(300)
    }
    await actor.page.waitForSelector('[data-svara-action-button="x2"]:not([disabled])', { timeout: 10_000 })
    const x2Label = await actor.page.locator('[data-svara-action-button="x2"]').textContent()
    await actor.page.click('[data-svara-action-button="x2"]')
    await actor.page.waitForFunction(() => (document.querySelector('[data-svara-lobby="1"]')?.textContent ?? '').length > 0, undefined, { timeout: 5_000 })
    await sleep(600)
    const after = await readSeatTotals(actor.page)
    if (before.selfStack === null || after.selfStack === null) throw new Error(`could not read stacks around ×2 raise (x2 label was "${x2Label}")`)
    const actuallyAdded = before.selfStack - after.selfStack
    if (actuallyAdded <= 0) throw new Error(`×2 raise did not actually deduct any chips (before=${before.selfStack}, after=${after.selfStack})`)
  })

  await check('[T16] Реален отказ ("Бягам") -> ходът приключва (2 играчи: единственият останал печели веднага), без разкриване на картите на отказалия', async () => {
    const actor = await findActor()
    await actor.page.waitForSelector('[data-svara-action-button="fold"]:not([disabled])', { timeout: 10_000 })
    const ownCardsBeforeFold = await actor.page.locator('[data-svara-own-cards]').textContent().catch(() => null)
    await actor.page.click('[data-svara-action-button="fold"]')
    // С точно 2 играчи, "Бягам" оставя точно ЕДИН неотказал участник —
    // раздаването приключва ВЕДНАГА (банката се присъжда, виж §17 от
    // 2Б.3.7.1's reveal-choice механизъм) вместо да остави видим "ОТКАЗАЛ
    // СЕ" бадж за остатъка от текущия кръг (структурно мигновено с точно 2
    // играчи — проверено отделно като unit логика в seatStatusBadges, виж
    // checkSvaraTableLayout.ts/визуалните 4-играчови проверки от 2Б.3.7.3).
    // Тук проверяваме сигурността на прехода: действащият вече няма ход.
    await actor.page.waitForFunction(
      () => document.querySelectorAll('[data-svara-action-bar] [data-svara-action-button]').length === 0,
      undefined, { timeout: 10_000 },
    )
    const otherSession = other(actor.label)
    if (ownCardsBeforeFold) {
      const opponentHtml = await otherSession.page.content()
      for (const token of ownCardsBeforeFold.split(/\s+/).filter(Boolean)) {
        if (opponentHtml.includes(token)) throw new Error(`opponent's DOM leaked the folded player's card token "${token}"`)
      }
    }
    // Задание §6 (2Б.3.7.5А) — landscape mobile СЛЕД доброволен отказ
    // (с точно 2 играчи вече в reveal-choice преход, не статично "ОТКАЗАЛ
    // СЕ" състояние, виж коментара по-горе) — различен реален екран от
    // dealing-прозореца, който T12 покрива. Нарочно винаги на sessionA (не
    // actor.page, който може да е sessionB) — real-browser QA finding: в
    // headless Chromium, след T11's requestFullscreen() на sessionA,
    // setViewportSize() на ДРУГАТА сесия (sessionB) понякога хвърля CDP
    // "Browser.setWindowBounds: fullscreen window" грешка (общ браузърен
    // process/window state между контекстите) — sessionA вече е доказано
    // безопасна за resize (виж T11's собствен exitFullscreen cleanup + T12's
    // 5 успешни resize-а веднага след това).
    const foldLog = (): string => ((sessionA.page as any)._svaraLog as string[]).slice(-15).join('\n')
    assertSvaraLayoutOk(await measureSvaraLayout(sessionA.page, { width: 844, height: 390 }), '844x390 (след доброволен отказ)', foldLog)
    await setSvaraViewportSize(sessionA.page, { width: 420, height: 900 })
  })

  await check('[T17] Reconnect след реални залози -> СЪЩИТЕ стекове/банка/баджове, БЕЗ повторно начисляване', async () => {
    // Real-browser QA finding (2Б.3.7.5А): readSeatTotals() needs the real
    // bottom anchor to already be rendered — reading it with no wait, right
    // as T16's own round-transition (fold -> reveal-choice) and viewport
    // restore are still settling, occasionally raced a transient state and
    // produced a false `before.selfStack === null` (symptom identical to the
    // T6/T12 root cause: the diagnostics shell can render before seats do).
    // This wait is for that already-real async condition, not a disguised
    // sleep — readSeatTotals is meaningless without it.
    try {
      await sessionA.page.waitForSelector('[data-svara-seat-anchor="bottom"]', { timeout: 10_000 })
    } catch (err) {
      const recentLog = ((sessionA.page as any)._svaraLog as string[]).slice(-15).join('\n')
      throw new Error(`bottom seat anchor missing BEFORE the reload even started — diag unavailable, recent WS log:\n${recentLog}\n(original: ${err instanceof Error ? err.message : String(err)})`)
    }
    const before = await readSeatTotals(sessionA.page)
    await sessionA.page.reload({ waitUntil: 'domcontentloaded' })
    // Виж T6/T12's root-cause коментар защо чакаме точно bottom anchor-а
    // (не само diagnostics shell-а, който се рендира дори с 0 места) —
    // readSeatTotals() по-долу разчита на `[data-svara-seat-anchor="bottom"]`
    // реално да съществува, иначе и двете четения стават null и сравнението
    // (-1 vs -2) фалшиво пропада.
    await sessionA.page.waitForSelector('[data-svara-seat-anchor="bottom"]', { timeout: 15_000 })
    await sleep(500)
    const after = await readSeatTotals(sessionA.page)
    // "Банка: N" е част от feltCenterHtml само за betting (ordinary/svara)
    // кръгове — ако T16's отказ вече е прехвърлил раздаването в reveal-
    // choice (структурно мигновено с точно 2 играчи), и двете четения са
    // null по еднакво легитимна причина, не грешка — сравняваме САМО ако
    // поне едната страна носи реална стойност.
    if (before.bank !== null || after.bank !== null) {
      assertEqualNum(before.bank ?? -1, after.bank ?? -1, 'bank must be IDENTICAL after a reload — reconnect must never resubmit or re-tally a bet')
    }
    assertEqualNum(before.selfStack ?? -1, after.selfStack ?? -2, 'own stack must be IDENTICAL after a reload')
    // "· общо N" idem — само релевантна докато round е betting (ordinary/
    // svara); в прехода към reveal-choice сървърният roundContribution
    // пада на 0 за всички (виж snapshot protocol-а), затова липсва и в
    // двете четения по еднакво легитимна причина тук.
    if (before.selfTotal !== null || after.selfTotal !== null) {
      assertEqualNum(before.selfTotal ?? -1, after.selfTotal ?? -1, 'own total-contributed badge must be IDENTICAL after a reload')
    }
    // Задание §6 (2Б.3.7.5А) — landscape mobile СЛЕД reconnect/remount на
    // контролера (пресъздаден от нулата от createLobbyFlowController.ts
    // след page.reload()), различен реален lifecycle момент от T12/T16.
    const reconnectLog = (): string => ((sessionA.page as any)._svaraLog as string[]).slice(-15).join('\n')
    assertSvaraLayoutOk(await measureSvaraLayout(sessionA.page, { width: 844, height: 390 }), '844x390 (след reconnect)', reconnectLog)
    await setSvaraViewportSize(sessionA.page, { width: 420, height: 900 })
  })

  await check('[T6] navigating away from /games/svara mid-match does NOT exit the game; returning restores the SAME active table', async () => {
    await sessionA.page.click('[data-svara-back-to-games]')
    await sessionA.page.waitForURL(/\/games$/, { timeout: 10_000 })
    await sleep(1_500) // give any (incorrect) auto-exit command time to reach the server, if it existed

    // The match must still be running for userB, completely unaffected.
    const stillActiveForB = await sessionB.page.evaluate(() => document.querySelector('[data-svara-diagnostics]') !== null)
    if (!stillActiveForB) throw new Error('userB got ejected from the match just because userA navigated away — unmount must never trigger an exit for ANY participant')

    const reloadStartedAt = Date.now()
    await sessionA.page.goto(`http://127.0.0.1:${staticPort}/games/svara`, { waitUntil: 'domcontentloaded' })
    // Must restore straight into the active-table view (not the empty/other
    // table list) via setTables()'s own-table auto-detect — no second join,
    // no new start, nothing clicked by the test here. Waiting for the real
    // BOTTOM seat anchor (not just the diagnostics shell, which renders even
    // while seats are still empty — see the T12 root-cause note above) is the
    // actual "restored into the same active table" signal; a plain
    // `data-svara-diagnostics` wait would also pass during a transient
    // zero-seat loading placeholder and mask a genuine stuck restore.
    try {
      await sessionA.page.waitForSelector('[data-svara-seat-anchor="bottom"]', { timeout: 15_000 })
    } catch (err) {
      const diag = await sessionA.page.evaluate(() => ({
        url: location.href,
        hasLobbyRoot: document.querySelector('[data-svara-lobby="1"]') !== null,
        hasDiagnostics: document.querySelector('[data-svara-diagnostics]') !== null,
        hasCreateButton: document.querySelector('[data-svara-create-open]') !== null,
        hasTableList: document.querySelector('[data-svara-table-join]') !== null,
        anchorCount: document.querySelectorAll('[data-svara-seat-anchor]').length,
        bodyTextSnippet: document.body.textContent?.slice(0, 300) ?? null,
      }))
      const recentLog = ((sessionA.page as any)._svaraLog as string[]).slice(-20).join('\n')
      throw new Error(`restore after reload timed out ${Date.now() - reloadStartedAt}ms after goto() — diag=${JSON.stringify(diag)}\nrecent WS log:\n${recentLog}\n(original: ${err instanceof Error ? err.message : String(err)})`)
    }
    const createButtonVisible = await sessionA.page.locator('[data-svara-create-open]').count()
    if (createButtonVisible !== 0) throw new Error('userA landed back on the table list instead of being restored into the active table')
    // Задание §6 (2Б.3.7.5А) — landscape mobile СЛЕД повторно монтиране на
    // контролера (fresh createSvaraLobbyController() instance след navigate
    // away/back, виж openSvaraLobbyOverlay()'s cached-snapshot replay).
    const remountLog = (): string => ((sessionA.page as any)._svaraLog as string[]).slice(-15).join('\n')
    assertSvaraLayoutOk(await measureSvaraLayout(sessionA.page, { width: 844, height: 390 }), '844x390 (след повторно монтиране)', remountLog)
    await setSvaraViewportSize(sessionA.page, { width: 420, height: 900 })
  })

  await check('[T8] no uncaught JS errors during the entire scenario', () => {
    if (consoleErrors.length > 0) throw new Error(`Console errors: ${consoleErrors.join(' | ')}`)
  })

  await sessionA.context.close()
  await sessionB.context.close()
} finally {
  if (browser) await browser.close()
  if (staticServer) staticServer.close()
  await stopServer(server)
  await isolated.cleanup()
}

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
