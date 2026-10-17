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
 *       в active-table view с реална ревизия от сървъра; тъй като този
 *       подетап няма look/bet UI (виж заданието §11/§17), собствените карти
 *       (snapshot.you.cards) законно остават null — data-svara-own-cards
 *       не трябва да се рендира въобще за никой от двамата (§13 "own
 *       unlooked cards stay hidden").
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
  console.log(`Starting real backend on fixed port ${BACKEND_PORT} (SVARA_TEST_ENABLED=1)...`)
  server = startServer(isolated.serverDir, BACKEND_PORT)
  try {
    await waitForBackendHealth(BACKEND_PORT, 30_000)
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
    await page.goto(`http://127.0.0.1:${staticPort}/games/svara`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-svara-lobby="1"]', { timeout: 20_000 })
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

    // Revision must be a real positive number coming from the server (not a
    // placeholder/dash), for both.
    for (const session of [sessionA, sessionB]) {
      const diagnosticsText = await session.page.locator('[data-svara-diagnostics]').textContent() ?? ''
      if (!/Ревизия:\s*\d+/.test(diagnosticsText)) throw new Error(`expected a real numeric revision in diagnostics, got: ${diagnosticsText}`)
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

  await check('[T6] navigating away from /games/svara mid-match does NOT exit the game; returning restores the SAME active table', async () => {
    await sessionA.page.click('[data-svara-back-to-games]')
    await sessionA.page.waitForURL(/\/games$/, { timeout: 10_000 })
    await sleep(1_500) // give any (incorrect) auto-exit command time to reach the server, if it existed

    // The match must still be running for userB, completely unaffected.
    const stillActiveForB = await sessionB.page.evaluate(() => document.querySelector('[data-svara-diagnostics]') !== null)
    if (!stillActiveForB) throw new Error('userB got ejected from the match just because userA navigated away — unmount must never trigger an exit for ANY participant')

    await sessionA.page.goto(`http://127.0.0.1:${staticPort}/games/svara`, { waitUntil: 'domcontentloaded' })
    // Must restore straight into the active-table view (not the empty/other
    // table list) via setTables()'s own-table auto-detect — no second join,
    // no new start, nothing clicked by the test here.
    await sessionA.page.waitForSelector('[data-svara-diagnostics]', { timeout: 15_000 })
    const createButtonVisible = await sessionA.page.locator('[data-svara-create-open]').count()
    if (createButtonVisible !== 0) throw new Error('userA landed back on the table list instead of being restored into the active table')
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
