// checkLudoGameOverlaySingleMount.ts
//
// Целеви real-server + Playwright check: за една активна Ludo игра в DOM-а
// съществува точно един игрови екран ([data-ludo-overlay-root]).
//   1. Refresh по време на игра + няколко бързи ludo_game_state (burst от
//      ludo_game_state_request веднага след connected) — един екран.
//   2. Reconnect (затворен app WebSocket) — един екран.
//   3. Повторно получаване на състоянието за същата игра — екранът не се
//      пресъздава/нулира.
//   4. Изход от играта -> екранът се затваря; нова игра се отваря нормално.

import { createHmac } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { chromium, type Page } from 'playwright'
import { createServer as createViteServer } from 'vite'

const EMAIL_VERIFICATION_SECRET = 'ludo-single-mount-throwaway-secret-32chars-x'
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))
let passed = 0
let failed = 0
async function check(label: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); passed++; console.log(`  PASS  ${label}`) } catch (err) {
    failed++; console.error(`  FAIL  ${label}: ${err instanceof Error ? err.message : String(err)}`)
  }
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
const freePort = () => new Promise<number>((done, failPort) => {
  const server = createNetServer().once('error', failPort).listen(0, '127.0.0.1', () => {
    const address = server.address()
    if (!address || typeof address === 'string') return failPort(new Error('No free port'))
    server.close(() => done(address.port))
  })
})
async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 1; ; attempt += 1) {
    try { return await fetch(url, init) } catch (error) { if (attempt >= 3) throw error; await sleep(200) }
  }
}

const projectRoot = process.cwd()
const root = await mkdtemp(join(tmpdir(), 'belot-ludo-single-mount-'))
const serverDir = join(root, 'server')
await mkdir(serverDir, { recursive: true })
await cp(join(projectRoot, 'server', 'src'), join(serverDir, 'src'), { recursive: true, preserveTimestamps: true })
await cp(join(projectRoot, 'server', 'dist'), join(serverDir, 'dist'), { recursive: true, preserveTimestamps: true })
await mkdir(join(serverDir, 'database', 'data'), { recursive: true })
await cp(join(projectRoot, 'server', 'database', 'migrations'), join(serverDir, 'database', 'migrations'), { recursive: true, preserveTimestamps: true })
await cp(join(projectRoot, 'server', 'package.json'), join(serverDir, 'package.json'), { preserveTimestamps: true })
const linkType = process.platform === 'win32' ? 'junction' : 'dir'
await symlink(join(projectRoot, 'server', 'node_modules'), join(serverDir, 'node_modules'), linkType)
await symlink(join(projectRoot, 'node_modules'), join(root, 'node_modules'), linkType)

let serverChild: ChildProcessWithoutNullStreams | null = null
const serverOutput: string[] = []
const browser = await chromium.launch({ headless: true })
let vite: Awaited<ReturnType<typeof createViteServer>> | null = null
const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

console.log('\ncheckLudoGameOverlaySingleMount\n')

try {
  const backendPort = await freePort()
  serverChild = spawn(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'index.ts')], {
    cwd: serverDir,
    env: { ...process.env, PORT: String(backendPort), EMAIL_VERIFICATION_CODE_SECRET: EMAIL_VERIFICATION_SECRET },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  serverChild.stdout.on('data', (c) => serverOutput.push(String(c)))
  serverChild.stderr.on('data', (c) => serverOutput.push(String(c)))
  const healthDeadline = Date.now() + 30_000
  for (;;) {
    try {
      const h: any = await (await fetch(`http://127.0.0.1:${backendPort}/health`)).json()
      if (h.ok === true && h.gameWorkerLifecycle?.state === 'ready') break
    } catch { /* retry */ }
    if (Date.now() > healthDeadline) throw new Error('server did not become ready')
    await sleep(200)
  }

  const vitePort = await freePort()
  vite = await createViteServer({
    root: projectRoot,
    server: { host: '127.0.0.1', port: vitePort, strictPort: true },
    logLevel: 'error',
    plugins: [{
      name: 'ludo-single-mount-backend',
      enforce: 'pre',
      transform(code, id) {
        if (!id.includes('/src/') && !id.includes('\\src\\')) return null
        return code.includes(':3001') ? code.replaceAll(':3001', `:${backendPort}`) : null
      },
    }],
  })
  await vite.listen()
  const appOrigin = `http://127.0.0.1:${vitePort}`

  async function register(tag: string): Promise<{ cookie: string; profileId: string }> {
    const hex = () => Math.floor(Math.random() * 16).toString(16)
    const block = (n: number) => Array.from({ length: n }, hex).join('')
    const res = await fetchWithRetry(`http://127.0.0.1:${backendPort}/api/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `ludo-sm-${tag}-${runId}@example.test`, password: 'LudoSingle1!',
        displayName: `SM${tag}${runId.slice(-5)}`, gender: 'male',
        visitorId: `${block(8)}-${block(4)}-4${block(3)}-8${block(3)}-${block(12)}`,
      }),
    })
    const body: any = await res.json()
    if (!body.pendingRegistrationId) throw new Error(`register ${tag}: ${JSON.stringify(body)}`)
    const db = new DatabaseSync(join(serverDir, 'database', 'data', 'belot-v2.sqlite'), { readOnly: true })
    const row = db.prepare('SELECT code_hash FROM pending_registrations WHERE pending_registration_id = ?').get(body.pendingRegistrationId) as { code_hash: string }
    db.close()
    let code = ''
    for (let n = 0; n < 1_000_000; n += 1) {
      const candidate = n.toString().padStart(6, '0')
      if (createHmac('sha256', EMAIL_VERIFICATION_SECRET).update(`email-verification-code-v1:${candidate}`).digest('hex') === row.code_hash) { code = candidate; break }
    }
    const verify = await fetchWithRetry(`http://127.0.0.1:${backendPort}/api/auth/verify-registration-email`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pendingRegistrationId: body.pendingRegistrationId, code }),
    })
    const verifyBody: any = await verify.json()
    const cookie = (verify.headers.getSetCookie?.()[0] ?? '').split(';')[0]!.split('=')[1]!
    return { cookie, profileId: verifyBody.session.profile.profileId }
  }

  const pageErrors = new Map<Page, string[]>()
  async function open(profile: { cookie: string }): Promise<Page> {
    const context = await browser.newContext({ viewport: { width: 1280, height: 850 } })
    await context.addCookies([{ name: 'belot_session', value: profile.cookie, url: `http://127.0.0.1:${backendPort}` }])
    // Запомня app сокета; ако localStorage.__ludoBurst е зададен — веднага
    // след 'connected' изпраща 4 ludo_game_state_request (сървърът отговаря с
    // 4 бързи ludo_game_state, докато екранът още се монтира).
    await context.addInitScript(`
      (() => {
        const NativeWebSocket = window.WebSocket
        window.WebSocket = class extends NativeWebSocket {
          constructor(...args) {
            super(...args)
            if (!String(args[0]).includes('/ws')) return
            window.__appWs = this
            this.addEventListener('message', (event) => {
              try {
                const msg = JSON.parse(event.data)
                if (msg.type === 'connected' && localStorage.getItem('__ludoBurst') === '1') {
                  for (let i = 0; i < 4; i += 1) this.send(JSON.stringify({ type: 'ludo_game_state_request' }))
                }
              } catch {}
            })
          }
        }
      })()
    `)
    const page = await context.newPage()
    pageErrors.set(page, [])
    page.on('pageerror', (e) => pageErrors.get(page)!.push(e.message))
    await page.goto(`${appOrigin}/games/ludo`)
    const consent = page.locator('[data-consent-accept-all="1"]')
    if (await consent.isVisible().catch(() => false)) await consent.click()
    await page.locator('[data-ludo-lobby="1"]').waitFor({ state: 'visible', timeout: 15_000 })
    return page
  }

  async function startMatch(host: Page, guest: Page): Promise<void> {
    await host.locator('[data-ludo-create-open="1"]').click()
    await host.locator('[data-ludo-create-form="1"]').waitFor({ state: 'visible' })
    await host.locator('[data-ludo-create-form="1"] select[name="playerCount"]').selectOption('2')
    const stake = host.locator('[data-ludo-create-form="1"] select[name="stake"]')
    await stake.selectOption((await stake.locator('option').first().getAttribute('value'))!)
    await host.locator('[data-ludo-create-form="1"]').evaluate((form: HTMLFormElement) => form.requestSubmit())
    await host.locator('[data-ludo-room-leave="1"]').waitFor({ state: 'visible', timeout: 10_000 })
    await guest.locator('[data-ludo-room-join]').first().waitFor({ state: 'visible', timeout: 10_000 })
    await guest.locator('[data-ludo-room-join]').first().click()
    await host.locator('[data-ludo-cell-pieces]').first().waitFor({ state: 'attached', timeout: 15_000 })
    await guest.locator('[data-ludo-cell-pieces]').first().waitFor({ state: 'attached', timeout: 15_000 })
  }

  const rootCount = (page: Page) => page.locator('[data-ludo-overlay-root]').count()
  const tagRoot = (page: Page) => page.evaluate(() => document.querySelector('[data-ludo-overlay-root]')?.setAttribute('data-test-root-tag', '1'))
  const sameRoot = (page: Page) => page.evaluate(() => document.querySelector('[data-test-root-tag]') !== null)

  const a = await open(await register('a'))
  const b = await open(await register('b'))
  await startMatch(a, b)

  await check('[1] Refresh по време на игра + burst от ludo_game_state: точно един игрови екран', async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await b.evaluate(() => localStorage.setItem('__ludoBurst', '1'))
      await b.reload()
      await b.locator('[data-ludo-cell-pieces]').first().waitFor({ state: 'attached', timeout: 20_000 })
      await sleep(2_500)
      const count = await rootCount(b)
      assert(count === 1, `attempt ${attempt + 1}: ${count} overlay roots`)
    }
    await b.evaluate(() => localStorage.removeItem('__ludoBurst'))
  })

  await check('[2] Reconnect (затворен WebSocket): точно един игрови екран', async () => {
    await b.evaluate(() => (window as any).__appWs.close())
    await b.waitForFunction(() => (window as any).__appWs?.readyState === 1, undefined, { timeout: 20_000 })
    await sleep(4_000)
    const count = await rootCount(b)
    assert(count === 1, `${count} overlay roots after reconnect`)
    await b.locator('[data-ludo-cell-pieces]').first().waitFor({ state: 'attached', timeout: 10_000 })
  })

  await check('[3] Повторно получаване на състоянието за същата игра не пресъздава/нулира екрана', async () => {
    await tagRoot(b)
    await b.evaluate(() => { for (let i = 0; i < 4; i += 1) (window as any).__appWs.send(JSON.stringify({ type: 'ludo_game_state_request' })) })
    await sleep(2_000)
    assert(await rootCount(b) === 1, 'more than one overlay root')
    assert(await sameRoot(b), 'game screen was recreated')
  })

  await check('[4] Изход -> екранът се затваря; нова игра се отваря нормално с един екран', async () => {
    const bot = b.locator('[data-ludo-bot-takeover-dismiss]')
    if (await bot.isVisible().catch(() => false)) await bot.click()
    await b.locator('[data-ludo-exit-button="1"]').click()
    await b.locator('[data-ludo-exit-confirm-submit="1"]').click()
    await b.waitForURL('**/games', { timeout: 10_000 }).catch(() => undefined)
    await sleep(1_500)
    assert(await rootCount(b) === 0, `B still has ${await rootCount(b)} overlay roots after exit`)
    // A вижда края на играта (опонентът е напуснал) — затваря и той.
    const endOk = a.locator('[data-ludo-game-end-dismiss]').first()
    if (await endOk.isVisible({ timeout: 5_000 }).catch(() => false)) await endOk.click()
    const c = await open(await register('c'))
    await b.goto(`${appOrigin}/games/ludo`)
    await b.locator('[data-ludo-lobby="1"]').waitFor({ state: 'visible', timeout: 15_000 })
    await startMatch(b, c)
    await sleep(1_500)
    assert(await rootCount(b) === 1, `new match: ${await rootCount(b)} overlay roots on B`)
    assert(await rootCount(c) === 1, `new match: ${await rootCount(c)} overlay roots on C`)
  })

  await check('[5] без грешки в конзолата', async () => {
    const errors = [...pageErrors.values()].flat()
    assert(errors.length === 0, errors.join(' | '))
  })

  console.log(`\nPassed: ${passed}  Failed: ${failed}`)
  if (failed > 0) process.exitCode = 1
} catch (error) {
  process.exitCode = 1
  console.error(error)
  console.error(serverOutput.join('').split('\n').slice(-40).join('\n'))
} finally {
  await browser.close()
  if (vite) await vite.close()
  serverChild?.kill('SIGKILL')
  await sleep(500)
  await rm(root, { recursive: true, force: true }).catch(() => undefined)
}
