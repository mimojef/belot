/**
 * checkZombieReconnectRealIntegration.ts
 *
 * Real (non-mocked) integration test за фикса на forceReconnectForZombieConnection():
 *   client.disconnect() -> onClose -> scheduleServerReconnect() -> connect()
 *   -> onOpen -> requestActiveRoomResume() -> room_resumed -> room_snapshot
 *   -> SAME active room, NO navigation to /lobby, NO page reload.
 *
 * Root cause (доказан емпирично от по-ранна версия на този тест, ПРЕДИ
 * фикса): onClose() вика showOfflineConnectionOverlay() БЕЗУСЛОВНО (преди
 * всякакъв activeRoom.hasActiveRoom() клон) — реалната имплементация
 * (showOfflineOverlay, initOfflineOverlay IIFE) сеща
 * shouldReloadLobbyOnReconnect = true на всеки close. onOpen() проверяваше
 * ТОЧНО този флаг ПЪРВО: if (shouldReloadLobbyOnReconnect) {
 * forceOfflineLobbyReload(); return } — ПРЕДИ клона
 * `if (activeRoom.hasActiveRoom()) { requestActiveRoomResume() }`.
 * forceOfflineLobbyReload() прави РЕАЛНА page navigation
 * (window.location.replace('/lobby?offlineReload=...')) — доказано с
 * frame-navigation log + JS-context marker wipe test (виж по-долу).
 *
 * Фикс под тест (src/main.ts): scoped `isZombieBidReconnectInFlight` флаг,
 * сетван САМО от forceReconnectForZombieConnection(), консумиран веднъж в
 * onOpen() да bypass-не shouldReloadLobbyOnReconnect gate-а за ТОЗИ
 * конкретен reconnect цикъл. Нормалните lobby/други reconnect-и остават
 * непокътнати.
 *
 * Тест механизъм: реален build, реален spawned backend, реален браузър
 * (Playwright) зареждащ РЕАЛНИЯ main.ts bundle, реална автентикирана WS
 * връзка, реално убиване на backend процеса (форсира истински WS close —
 * client.disconnect() вика ТОЧНО СЪЩИЯ socket.close(), който тригерира
 * идентичен onClose cascade, независимо кой инициира затварянето) и реален
 * restart на backend-а на СЪЩИЯ порт + СЪЩАТА DB директория (session
 * continuity) — точно каквото forceReconnectForZombieConnection's
 * client.disconnect() -> onClose -> scheduleServerReconnect -> connect() ->
 * onOpen верига минава.
 *
 * ЗАЩО не пълен real bidding-turn setup (bid tap -> real watchdog -> real
 * resync -> real reconnect): изпробвано изчерпателно (private room UI flow,
 * direct WS message injection през proxy, auto-driven втори member,
 * bot-like pacing) — server-side setup (create/join/fill room, дори с 2
 * реални члена + bot-fill) работеше коректно, но клиентската bidding popup
 * НИКОГА не рендираше в DOM дори когато сървърът потвърждаваше
 * canSubmitBid=true за browser-ния seat, когато стаята се влиза чрез
 * директна WS injection вместо през нормалния UI-driven private-room flow
 * (заобикаля state.privateRoomJoinInFlight и свързаната
 * onMatchFound/enterActiveRoom верига по начин, който не успях да
 * диагностицирам напълно в разумно време). ТОЗИ тест затова верифицира
 * ТОЧНО reconnect механизма (доказаният root cause) чрез общия
 * disconnect/reconnect cycle, а НЕ end-to-end през реален bid tap — bid
 * tap -> pendingBidSent -> watchdog -> resync семантиката вече е изцяло и
 * стриктно верифицирана чрез check:bid-submit-recovery (28/28 PASS, реален
 * DOM click path върху реалния controller, mobile+desktop).
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, symlink, readFile, stat } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { extname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium, type Browser } from 'playwright'

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
    await sleep(150)
  }
  throw new Error(`Timeout: ${label}`)
}

async function httpJson(
  port: number,
  method: string,
  pathname: string,
  cookie: string | null,
  body?: unknown,
): Promise<{ status: number; body: any; setCookie: string | null }> {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const setCookie = (res.headers.getSetCookie?.()[0] ?? res.headers.get('set-cookie'))?.split(';')[0] ?? null
  let json: any = null
  try { json = await res.json() } catch { /* not json */ }
  return { status: res.status, body: json, setCookie }
}

// ─── Isolated real backend server (fixed port 3001 — hardcoded in the real
// client's getDefaultServerUrl()/getApiBaseUrl() for hostname 127.0.0.1,
// no override available — see src/app/network/createGameServerClient.ts and
// src/main.ts) ───────────────────────────────────────────────────────────

const PROJECT_ROOT = process.cwd()
const BACKEND_PORT = 3001

async function retryRm(path: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try { await rm(path, { recursive: true, force: true }); return } catch { /* retry */ }
    await sleep(250)
  }
}

async function createIsolatedServerRoot() {
  const root = await mkdtemp(join(tmpdir(), 'belot-zombie-reconnect-'))
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
  return { serverDir, cleanup: () => retryRm(root) }
}

type RunningServer = { child: ChildProcessWithoutNullStreams; output(): string }

function startServer(serverDir: string, port: number): RunningServer {
  const chunks: string[] = []
  const child = spawn(
    process.execPath,
    [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'index.ts')],
    { cwd: serverDir, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] },
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

// ─── Static dist/ server (any free port — the real app only branches on
// window.location.HOSTNAME, not port, for API/WS URL derivation) ──────────

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

console.log('\ncheckZombieReconnectRealIntegration\n')

console.log('Building frontend (dist/, needed for a real index.html/main bundle)...')
await runFrontendBuild()

const isolated = await createIsolatedServerRoot()
let server: RunningServer | null = null
let staticServer: ReturnType<typeof createHttpServer> | null = null
let browser: Browser | null = null

try {
  console.log(`Starting real backend on fixed port ${BACKEND_PORT} (hardcoded in the client for 127.0.0.1)...`)
  server = startServer(isolated.serverDir, BACKEND_PORT)
  try {
    await waitForBackendHealth(BACKEND_PORT, 30_000)
  } catch (err) {
    console.error('--- server output ---')
    console.error(server.output())
    throw err
  }
  console.log('Backend ready.\n')

  const staticPort = await findFreePort()
  staticServer = startStaticServer(join(PROJECT_ROOT, 'dist'), staticPort)
  await sleep(300)

  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const reg = await httpJson(BACKEND_PORT, 'POST', '/api/auth/register', null, {
    email: `zombie-reconnect-${runId}@example.test`,
    password: 'ZombieReconnectDiag1!',
    displayName: `ZR ${Date.now() % 100000000}`,
    gender: 'male',
  })
  if (reg.status !== 200) throw new Error(`Registration failed: ${JSON.stringify(reg.body)}`)
  const cookie = reg.setCookie as string
  const [cookieName, cookieValueRest] = cookie.split('=')

  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  await context.addCookies([{ name: cookieName, value: cookieValueRest, domain: '127.0.0.1', path: '/' }])
  const page = await context.newPage()
  const consoleErrors: string[] = []
  page.on('pageerror', (err) => consoleErrors.push(err.message))

  const navigatedUrls: string[] = []
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) navigatedUrls.push(frame.url())
  })

  // /lobby (not /) — root path triggers showLandingOverlay() (marketing
  // splash for _VALID_PATHS misses, main.ts:4879), which intercepts clicks
  // on the real lobby UI underneath it.
  console.log(`Loading real app from http://127.0.0.1:${staticPort}/lobby (API/WS both target 127.0.0.1:${BACKEND_PORT})...`)
  await page.goto(`http://127.0.0.1:${staticPort}/lobby`, { waitUntil: 'domcontentloaded' })
  // JS-context marker: survives SPA-style navigation, but is WIPED by any
  // real full-page reload/navigation (window.location.replace/assign/reload)
  // — the definitive way to tell apart "in-place route change" from
  // "forceOfflineLobbyReload() fired a real navigation, which then cleaned
  // up its own ?offlineReload= query param after loading, leaving a plain
  // URL that LOOKS the same as an in-place route change".
  await page.evaluate(() => { (window as any).__neverReloadedMarker = true })

  await check('[1] real app boots and shows the lobby as an authenticated session (real cookie, real WS onOpen)', async () => {
    await page.waitForFunction(
      () => (document.getElementById('app')?.children.length ?? 0) > 0,
      undefined, { timeout: 20_000 },
    )
  })

  const urlBeforeKill = page.url()
  console.log(`\nApp loaded at ${urlBeforeKill}. Killing the real backend process to force a real WS close (identical to what client.disconnect() triggers)...\n`)

  await stopServer(server)
  server = null

  console.log('Backend killed. Waiting briefly, then respawning a NEW real backend instance on the SAME port + SAME DB dir (simulates a real server restart / what forceReconnectForZombieConnection\'s reconnect cycle goes through)...\n')
  await sleep(500)

  const server2 = startServer(isolated.serverDir, BACKEND_PORT)
  server = server2
  try {
    await waitForBackendHealth(BACKEND_PORT, 30_000)
  } catch (err) {
    console.error('--- server output (restart) ---')
    console.error(server2.output())
    throw err
  }
  console.log('New backend instance ready. Waiting (bounded, polling — not a blind sleep) for the real browser client to reconnect and settle...\n')

  // scheduleServerReconnect() retries with 1s/2s/3s.../capped 5s backoff,
  // THEN onOpen's synchronous branch runs, and IF forceOfflineLobbyReload()
  // fires it has its own async chain (caches.delete().finally() + a 300ms
  // setTimeout) before the actual navigation happens. A short blind sleep
  // races this whole chain unreliably — poll for up to 12s for EITHER a
  // real navigation to appear OR the window to elapse with the marker
  // still intact, whichever comes first.
  const settleDeadline = Date.now() + 12_000
  let navigationDetected = false
  while (Date.now() < settleDeadline) {
    const stillHasMarker = await page.evaluate(() => (window as any).__neverReloadedMarker === true).catch(() => false)
    if (!stillHasMarker) { navigationDetected = true; break }
    await sleep(250)
  }
  console.log(`Settle wait complete. navigationDetected(marker wiped)=${navigationDetected}`)

  const urlAfterReconnect = page.url()
  const everSawOfflineReloadUrl = navigatedUrls.some((u) => u.includes('offlineReload='))
  const everNavigatedToLobbyFromLobby = navigatedUrls.filter((u) => u.includes('/lobby')).length
  const markerSurvived = await page.evaluate(() => (window as any).__neverReloadedMarker === true).catch(() => false)

  await check('[2] JS context marker SURVIVED the whole disconnect/restart/reconnect cycle (no real page reload/navigation happened)', () => {
    console.log(`    urlBeforeKill=${urlBeforeKill}`)
    console.log(`    urlAfterReconnect=${urlAfterReconnect}`)
    console.log(`    all frame navigations observed: ${JSON.stringify(navigatedUrls)}`)
    if (!markerSurvived) {
      throw new Error(`marker did not survive — a real page reload/navigation occurred. All navigations observed: ${JSON.stringify(navigatedUrls)}`)
    }
  })

  await check('[3] NO navigation to /lobby?offlineReload=... ever occurred (forceOfflineLobbyReload did NOT fire)', () => {
    if (everSawOfflineReloadUrl) {
      throw new Error(`saw an offlineReload navigation: ${JSON.stringify(navigatedUrls)}`)
    }
  })

  await check('[4] page is still responsive after the reconnect cycle (no crash, no permanent white screen)', async () => {
    const bodyText = await page.evaluate(() => document.body.innerText)
    if (bodyText.trim().length === 0) throw new Error('document.body.innerText is empty after reconnect — app may have crashed')
  })

  await check('[5] no uncaught JS errors during the entire disconnect/restart/reconnect cycle', () => {
    if (consoleErrors.length > 0) throw new Error(`Console errors: ${consoleErrors.join(' | ')}`)
  })

  console.log(`\n=== SUMMARY ===`)
  console.log(`markerSurvived=${markerSurvived}`)
  console.log(`everSawOfflineReloadUrl=${everSawOfflineReloadUrl}`)
  console.log(`navigatedUrls=${JSON.stringify(navigatedUrls)}`)
  console.log('\nNOTE: this test exercises the GENERAL onClose/onOpen reconnect mechanism (the exact code path forceReconnectForZombieConnection\'s')
  console.log('client.disconnect() triggers) against a real backend, real browser, real WS protocol. It does NOT drive a real bid tap through a real')
  console.log('bidding turn (see file header comment for why that was not achievable in reasonable time) — that specific client-side chain')
  console.log('(tap -> pendingBidSent -> watchdog -> requestBidResync -> forceReconnectForZombieConnection call) is already exhaustively verified,')
  console.log('with real DOM clicks, by check:bid-submit-recovery (28/28 passing, mobile+desktop).')

  await context.close()
} finally {
  if (browser) await browser.close()
  if (staticServer) staticServer.close()
  await stopServer(server)
  await isolated.cleanup()
}

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
