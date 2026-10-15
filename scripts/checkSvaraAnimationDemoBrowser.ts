/**
 * checkSvaraAnimationDemoBrowser.ts — Свара, Етап 2А.
 *
 * Реален браузър (Playwright/Chromium) срещу production build (vite preview)
 * + изолиран backend с SVARA_TEST_ENABLED=1 САМО в този тестов процес.
 *
 * Проверява:
 *  - обикновен профил: няма карта „Свара“, /games/svara пренасочва към /games,
 *    не се изтегля нито един svara-* chunk;
 *  - admin в „Игри“: картата е видима, но svara-* и pixi chunks НЕ се теглят,
 *    докато Свара не бъде отворена;
 *  - прототипът минава всички фази с DOM/WAAPI и с PixiJS (desktop + mobile);
 *  - „Прекъсни“ и resize по време на анимация → коректно крайно състояние;
 *  - неподвижна маса: няма активни WAAPI анимации / Pixi ticker не рисува;
 *  - напускане на страницата освобождава canvas/DOM.
 * Събира метрики (кадри, зареждане, JS heap, мрежа) — без CPU забавяне и с
 * 4× CPU throttling (симулация на по-бавно устройство, НЕ реален телефон).
 *
 * --gpu: хардуерен GPU през ANGLE/D3D11 (по подразбиране headless Chromium
 * рисува WebGL през софтуерния SwiftShader — песимистично за PixiJS).
 * Изисква: `npm run build` (dist/), свободни портове 3001 и 4173.
 * Пускане: npm run check:svara-animation-demo-browser
 * Скрийншоти и JSON с метрики: --out=<dir> (по подразбиране os.tmpdir()).
 */

import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'

const projectRoot = resolve(process.argv.find((a) => a.startsWith('--project-root='))?.slice('--project-root='.length) ?? '.')
const outDir = resolve(process.argv.find((a) => a.startsWith('--out='))?.slice('--out='.length) ?? join(tmpdir(), 'svara-demo-browser'))
const useHardwareGpu = process.argv.includes('--gpu')
const API_PORT = 3001
const WEB_PORT = 4173
const WEB = `http://localhost:${WEB_PORT}`
const API = `http://localhost:${API_PORT}`
const PASSWORD = 'SvaraDemoBrowser1!'
const TEST_SECRET = 'svara-demo-browser-test-secret-0123456789abcdef'

let passed = 0
let failed = 0
const metrics: Record<string, unknown> = {}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function check(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    passed += 1
    console.log(`  ok ${label}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

async function waitHttp(url: string, timeoutMs: number, proc: ChildProcess, logs: string[]): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`process exited: ${logs.join('').slice(-1500)}`)
    try {
      const res = await fetch(url)
      if (res.status < 500) return
    } catch { /* not yet */ }
    await sleep(150)
  }
  throw new Error(`timeout waiting for ${url}: ${logs.join('').slice(-1500)}`)
}

function startProcess(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): { proc: ChildProcess; logs: string[] } {
  const logs: string[] = []
  const proc = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  proc.stdout?.setEncoding('utf8')
  proc.stderr?.setEncoding('utf8')
  proc.stdout?.on('data', (c: string) => logs.push(c))
  proc.stderr?.on('data', (c: string) => logs.push(c))
  return { proc, logs }
}

async function stopProcess(proc: ChildProcess | null): Promise<void> {
  if (!proc || proc.exitCode !== null) return
  proc.kill('SIGTERM')
  await new Promise<void>((done) => {
    const timer = setTimeout(() => { proc.kill('SIGKILL'); done() }, 8000)
    proc.once('exit', () => { clearTimeout(timer); done() })
  })
}

async function createIsolatedServerRoot(): Promise<{ serverDir: string; databaseFile: string; cleanup(): Promise<void> }> {
  const serverRoot = join(projectRoot, 'server')
  const root = await mkdtemp(join(tmpdir(), 'belot-svara-demo-browser-'))
  const serverDir = join(root, 'server')
  await mkdir(join(serverDir, 'database', 'data'), { recursive: true })
  await cp(join(serverRoot, 'src'), join(serverDir, 'src'), { recursive: true })
  await cp(join(serverRoot, 'dist'), join(serverDir, 'dist'), { recursive: true })
  await cp(join(serverRoot, 'database', 'migrations'), join(serverDir, 'database', 'migrations'), { recursive: true })
  await cp(join(serverRoot, 'package.json'), join(serverDir, 'package.json'))
  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  await symlink(join(serverRoot, 'node_modules'), join(serverDir, 'node_modules'), linkType)
  await symlink(join(projectRoot, 'node_modules'), join(root, 'node_modules'), linkType)
  return {
    serverDir,
    databaseFile: join(serverDir, 'database', 'data', 'belot-v2.sqlite'),
    cleanup: async () => {
      for (let i = 0; i < 6; i += 1) {
        try { await rm(root, { recursive: true, force: true }); return } catch { await sleep(300 * (i + 1)) }
      }
    },
  }
}

function withDb<T>(file: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(file)
  try { return fn(db) } finally { db.close() }
}

async function createUser(databaseFile: string, label: string, role: string): Promise<string> {
  const email = `svara-demo-${label}-${randomUUID().slice(0, 8)}@example.test`
  const headers = { 'Content-Type': 'application/json', 'X-Forwarded-For': `203.0.113.${Math.floor(Math.random() * 200) + 1}` }
  const reg = await fetch(`${API}/api/auth/register`, {
    method: 'POST', headers,
    body: JSON.stringify({ email, password: PASSWORD, displayName: `Svdemo${label}${randomUUID().replace(/[^a-z0-9]/gi, '').slice(0, 4)}`, gender: 'male', visitorId: randomUUID() }),
  })
  assert(reg.status === 200, `register ${label}: ${reg.status} ${await reg.text()}`)
  if (role !== 'player') withDb(databaseFile, (db) => db.prepare('UPDATE accounts SET role = ? WHERE email = ?').run(role, email))
  const login = await fetch(`${API}/api/auth/login`, { method: 'POST', headers, body: JSON.stringify({ email, password: PASSWORD, rememberMe: true }) })
  const cookie = (login.headers as Headers & { getSetCookie(): string[] }).getSetCookie().find((c) => c.startsWith('belot_session='))
  assert(cookie, `login ${label}: ${login.status}`)
  return cookie.split(';')[0]!.slice('belot_session='.length)
}

type Viewport = { name: string; width: number; height: number; deviceScaleFactor: number; isMobile: boolean }
const DESKTOP: Viewport = { name: 'desktop', width: 1280, height: 860, deviceScaleFactor: 1, isMobile: false }
const MOBILE: Viewport = { name: 'mobile', width: 390, height: 844, deviceScaleFactor: 3, isMobile: true }

async function newContext(browser: Browser, viewport: Viewport, sessionToken: string): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.deviceScaleFactor,
    isMobile: viewport.isMobile,
    hasTouch: viewport.isMobile,
    serviceWorkers: 'block',
  })
  // Consent банерът е извън обхвата — приемаме само необходимите бисквитки
  // (същия pattern като другите браузърни проверки).
  await context.addInitScript(() => {
    localStorage.setItem('pika-consent-v2', JSON.stringify({ version: 2, necessary: true, analytics: false, marketing: false, updatedAt: new Date().toISOString() }))
  })
  // Брояч на requestAnimationFrame — само в тестовия браузър.
  await context.addInitScript(() => {
    const w = window as unknown as { __svaraRafCalls: number }
    w.__svaraRafCalls = 0
    const original = window.requestAnimationFrame.bind(window)
    window.requestAnimationFrame = (cb: FrameRequestCallback) => {
      w.__svaraRafCalls += 1
      return original(cb)
    }
  })
  await context.addCookies([{ name: 'belot_session', value: sessionToken, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax' }])
  return context
}

function trackSvaraRequests(page: Page): { urls: string[]; bytes: () => number } {
  const urls: string[] = []
  const sizes = new Map<string, number>()
  page.on('response', async (response) => {
    const url = response.url()
    if (!/\/assets\/svara-/.test(url)) return
    urls.push(url)
    try { sizes.set(url, (await response.body()).length) } catch { /* ignore */ }
  })
  return { urls, bytes: () => [...sizes.values()].reduce((a, b) => a + b, 0) }
}

async function demoMetrics(page: Page): Promise<Record<string, unknown>> {
  const raw = await page.locator('[data-svara-demo-stats]').getAttribute('data-svara-demo-metrics')
  return raw ? JSON.parse(raw) as Record<string, unknown> : {}
}

async function waitDemoStatus(page: Page, status: string, timeoutMs = 20_000): Promise<void> {
  await page.waitForSelector(`[data-svara-demo-stage][data-svara-demo-status="${status}"]`, { timeout: timeoutMs })
}

async function heapMb(page: Page): Promise<number> {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Performance.enable')
  await cdp.send('HeapProfiler.collectGarbage')
  const { metrics: list } = await cdp.send('Performance.getMetrics') as { metrics: Array<{ name: string; value: number }> }
  await cdp.detach()
  return Number(((list.find((m) => m.name === 'JSHeapUsedSize')?.value ?? 0) / 1048576).toFixed(2))
}

async function openSvara(page: Page): Promise<void> {
  await page.goto(`${WEB}/games/svara`)
  await page.waitForSelector('[data-svara-page="granted"]', { timeout: 30_000 })
  await page.waitForSelector('[data-svara-demo-stage]', { timeout: 30_000 })
}

/**
 * Едно пускане. screenshots=true снима по средата и в края — само за
 * визуалната проверка; метриките се вземат от отделни пускания БЕЗ
 * скрийншоти (снимането по време на анимация само по себе си спира кадри).
 */
async function runRenderer(page: Page, label: string, kind: 'dom' | 'pixi', cpuThrottle: number, screenshots = false): Promise<Record<string, unknown>> {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Performance.enable')
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuThrottle })
  try {
    const current = await demoMetrics(page)
    if (current.renderer !== kind) {
      await page.click(`[data-svara-demo-renderer="${kind}"]`)
    } else {
      await waitDemoStatus(page, 'done', 30_000).catch(() => undefined)
      await page.click('[data-svara-demo-action="replay"]')
    }
    await waitDemoStatus(page, 'running', 30_000)
    if (screenshots) {
      // Моменти (ms от старта) — по един кадър във всяка фаза.
      const startedAt = Date.now()
      for (const [name, atMs] of [['deal', 900], ['reveal', 2900], ['bet', 4350], ['svarka', 5900], ['collect', 7700]] as const) {
        await page.waitForTimeout(Math.max(0, atMs - (Date.now() - startedAt)))
        await page.screenshot({ path: join(outDir, `${label}-${kind}-${name}.png`) })
      }
    }
    await waitDemoStatus(page, 'done', 40_000)
    if (screenshots) await page.screenshot({ path: join(outDir, `${label}-${kind}-final.png`) })
    const result = await demoMetrics(page)
    assert(result.renderer === kind, `renderer=${String(result.renderer)} (expected ${kind})`)
    assert(result.interrupted === false, 'run should complete without interruption')
    return result
  } finally {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
    await cdp.detach()
  }
}

/** Неподвижна маса: за 1 s покой страницата не иска нови кадри (rAF). */
async function assertIdle(page: Page, kind: 'dom' | 'pixi'): Promise<number> {
  if (kind === 'dom') {
    const active = await page.evaluate(() => document.querySelector('[data-svara-renderer="dom"]')?.getAnimations({ subtree: true }).length ?? -1)
    assert(active === 0, `DOM renderer has ${active} active animations while idle`)
  } else {
    assert(await page.locator('canvas[data-svara-renderer="pixi"]').count() === 1, 'Pixi canvas missing')
  }
  await page.waitForTimeout(300)
  const before = await page.evaluate(() => (window as unknown as { __svaraRafCalls: number }).__svaraRafCalls)
  await page.waitForTimeout(1000)
  const after = await page.evaluate(() => (window as unknown as { __svaraRafCalls: number }).__svaraRafCalls)
  const delta = after - before
  assert(delta <= 3, `${kind}: ${delta} requestAnimationFrame calls during 1 s idle (continuous redraw?)`)
  return delta
}

async function main(): Promise<void> {
  await mkdir(outDir, { recursive: true })
  console.log(`\ncheckSvaraAnimationDemoBrowser (out: ${outDir})`)

  const isolated = await createIsolatedServerRoot()
  let api: ChildProcess | null = null
  let web: ChildProcess | null = null
  let browser: Browser | null = null
  try {
    const apiProc = startProcess(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'index.ts')], isolated.serverDir, {
      ...process.env,
      PORT: String(API_PORT),
      SVARA_TEST_ENABLED: '1',
      BELOT_GAME_WORKER_TICK_MODE: 'worker-candidate',
      BELOT_GAME_WORKER_COUNT: '1',
      PASSWORD_RESET_RATE_LIMIT_SECRET: TEST_SECRET,
    })
    api = apiProc.proc
    await waitHttp(`${API}/api/rooms`, 60_000, apiProc.proc, apiProc.logs)
    withDb(isolated.databaseFile, (db) => db.prepare(`UPDATE admin_settings SET setting_value = 'direct' WHERE setting_key = 'registration_verification_mode'`).run())

    const webProc = startProcess(process.execPath, [join('node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--port', String(WEB_PORT), '--strictPort', '--host', 'localhost'], projectRoot, { ...process.env })
    web = webProc.proc
    await waitHttp(`${WEB}/`, 30_000, webProc.proc, webProc.logs)

    const adminToken = await createUser(isolated.databaseFile, 'admin', 'admin')
    const playerToken = await createUser(isolated.databaseFile, 'player', 'player')
    browser = await chromium.launch(useHardwareGpu ? { args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] } : {})
    {
      const probe = await browser.newPage()
      metrics.webglRenderer = await probe.evaluate(() => {
        const gl = document.createElement('canvas').getContext('webgl2')
        const ext = gl?.getExtension('WEBGL_debug_renderer_info')
        return gl && ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'unknown'
      })
      await probe.close()
      console.log(`  WebGL: ${String(metrics.webglRenderer)}`)
    }

    // ── Обикновен профил ──
    await check('1. обикновен профил: няма карта „Свара“, URL пренасочва към /games, без svara chunks', async () => {
      const context = await newContext(browser!, DESKTOP, playerToken)
      const page = await context.newPage()
      const svaraRequests = trackSvaraRequests(page)
      await page.goto(`${WEB}/games`)
      await page.waitForSelector('[data-ludo-play-card], img[alt="Игри в Pika.bg"]', { timeout: 30_000 })
      await page.waitForTimeout(1500)
      assert(await page.locator('[data-svara-play-card]').count() === 0, 'svara card visible for player')
      await page.goto(`${WEB}/games/svara`)
      await page.waitForURL(`${WEB}/games`, { timeout: 30_000 })
      await page.waitForTimeout(1000)
      assert(await page.locator('[data-svara-page="granted"]').count() === 0, 'svara content rendered for player')
      assert(svaraRequests.urls.length === 0, `player downloaded svara chunks: ${svaraRequests.urls.join(', ')}`)
      await context.close()
    })

    for (const viewport of [DESKTOP, MOBILE]) {
      const context = await newContext(browser, viewport, adminToken)
      const page = await context.newPage()
      const svaraRequests = trackSvaraRequests(page)
      const consoleErrors: string[] = []
      page.on('pageerror', (e) => consoleErrors.push(String(e)))
      page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
      const vm: Record<string, unknown> = {}
      metrics[viewport.name] = vm

      await check(`2. [${viewport.name}] admin в „Игри“: картата е видима, svara chunks не са изтеглени`, async () => {
        await page.goto(`${WEB}/games`)
        await page.waitForSelector('[data-svara-play-card="1"]', { timeout: 30_000 })
        await page.screenshot({ path: join(outDir, `${viewport.name}-games.png`) })
        assert(svaraRequests.urls.length === 0, `svara chunks loaded before opening: ${svaraRequests.urls.join(', ')}`)
      })

      await check(`3. [${viewport.name}] отваряне от картата → /games/svara, DOM демото минава всички фази`, async () => {
        await page.click('[data-svara-play-card="1"]')
        await page.waitForURL(`${WEB}/games/svara`)
        await page.waitForSelector('[data-svara-demo-stage]', { timeout: 30_000 })
        await waitDemoStatus(page, 'done', 40_000)
        vm.domNoThrottle = await demoMetrics(page)
        vm.domChunkBytes = svaraRequests.bytes()
        assert(!svaraRequests.urls.some((u) => /Pixi|Geometry|WebGL/.test(u)), 'pixi chunks downloaded in DOM mode')
        await page.screenshot({ path: join(outDir, `${viewport.name}-dom-final-first.png`), fullPage: false })
      })

      await check(`4. [${viewport.name}] DOM/WAAPI: пускане (без и с 4× CPU throttling) + неподвижно състояние`, async () => {
        vm.dom = await runRenderer(page, viewport.name, 'dom', 1)
        vm.domIdleRafCalls = await assertIdle(page, 'dom')
        vm.domThrottled4x = await runRenderer(page, viewport.name, 'dom', 4)
        await runRenderer(page, viewport.name, 'dom', 1, true)
        vm.heapDomMb = await heapMb(page)
      })

      await check(`5. [${viewport.name}] PixiJS: зарежда се при избор, пускане (без и с 4× throttling)`, async () => {
        const before = svaraRequests.bytes()
        vm.pixi = await runRenderer(page, viewport.name, 'pixi', 1)
        await page.waitForTimeout(500)
        vm.pixiChunkBytes = svaraRequests.bytes() - before
        assert(svaraRequests.urls.some((u) => /svaraDemoPixiRenderer/.test(u)), 'pixi renderer chunk not requested')
        vm.pixiIdleRafCalls = await assertIdle(page, 'pixi')
        vm.pixiSecondRun = await runRenderer(page, viewport.name, 'pixi', 1)
        vm.pixiThrottled4x = await runRenderer(page, viewport.name, 'pixi', 4)
        await runRenderer(page, viewport.name, 'pixi', 1, true)
        vm.heapPixiMb = await heapMb(page)
        vm.pixiDebug = await page.locator('[data-svara-demo-stats]').innerText()
      })

      await check(`6. [${viewport.name}] „Прекъсни“ по време на раздаването → крайно състояние`, async () => {
        await page.click('[data-svara-demo-action="replay"]')
        await waitDemoStatus(page, 'running')
        await page.waitForTimeout(600)
        await page.click('[data-svara-demo-action="skip"]')
        await waitDemoStatus(page, 'done', 5000)
        const result = await demoMetrics(page)
        assert(result.interrupted === true, 'expected interrupted=true')
        await page.waitForTimeout(300)
        await page.screenshot({ path: join(outDir, `${viewport.name}-pixi-interrupted.png`) })
      })

      await check(`7. [${viewport.name}] resize по време на анимация → нов layout, пускането продължава до коректен край`, async () => {
        await page.click('[data-svara-demo-renderer="dom"]')
        await waitDemoStatus(page, 'running', 30_000)
        await page.waitForTimeout(500)
        const widthBefore = await page.locator('[data-svara-demo-stage]').evaluate((el) => el.clientWidth)
        await page.setViewportSize({ width: viewport.isMobile ? 330 : 600, height: viewport.height })
        await page.waitForFunction((w) => (document.querySelector('[data-svara-demo-stage]') as HTMLElement | null)?.clientWidth !== w, widthBefore, { timeout: 5000 })
        await waitDemoStatus(page, 'done', 30_000)
        const result = await demoMetrics(page)
        assert(result.resized === true && result.interrupted === false, `expected resized run: ${JSON.stringify(result)}`)
        const layout = result.layout as { width: number } | null
        const widthAfter = await page.locator('[data-svara-demo-stage]').evaluate((el) => el.clientWidth)
        assert(layout !== null && layout.width === widthAfter, `layout width ${layout?.width} vs stage ${widthAfter}`)
        const active = await page.evaluate(() => document.querySelector('[data-svara-renderer="dom"]')?.getAnimations({ subtree: true }).length ?? -1)
        assert(active === 0, `active animations after resize: ${active}`)
        await page.screenshot({ path: join(outDir, `${viewport.name}-dom-after-resize.png`) })
        await page.setViewportSize({ width: viewport.width, height: viewport.height })
      })

      await check(`8. [${viewport.name}] напускане на Свара освобождава демото (без canvas/DOM)`, async () => {
        await page.click('[data-svara-demo-renderer="pixi"]')
        await waitDemoStatus(page, 'done', 40_000)
        await page.click('[data-svara-back-to-games="1"]')
        await page.waitForURL(`${WEB}/games`)
        await page.waitForTimeout(500)
        assert(await page.locator('[data-svara-demo]').count() === 0, 'demo DOM still present')
        assert(await page.locator('canvas[data-svara-renderer="pixi"]').count() === 0, 'pixi canvas still present')
        vm.heapAfterLeaveMb = await heapMb(page)
      })

      await check(`9. [${viewport.name}] без JS грешки в конзолата`, async () => {
        const relevant = consoleErrors.filter((e) => !/favicon|ERR_CONNECTION|WebSocket|ads|googletag|adsbygoogle/i.test(e))
        assert(relevant.length === 0, relevant.join(' | '))
      })
      await context.close()
    }
  } finally {
    await browser?.close()
    await stopProcess(web)
    await stopProcess(api)
    await isolated.cleanup()
    await writeFile(join(outDir, 'metrics.json'), JSON.stringify(metrics, null, 2), 'utf8')
  }

  console.log(`\nmetrics: ${join(outDir, 'metrics.json')}`)
  console.log(`Passed: ${passed}  Failed: ${failed}`)
  if (failed > 0) process.exit(1)
}

await main()
