// checkLudoPhraseReaction.ts
//
// Real spawned-server + real browser (Playwright) check за готовите фрази в
// „Не се сърди човече“ — 1:1 копие на Белот системата.
//
//   V — визуално сравнение при еднакъв viewport (desktop 1280×850 и
//       1920×1080, phone 390×844 и 360×800): реалният Белот контролер
//       (activeRoomSpectatorHarness, участник в playing фаза) срещу реална
//       Ludo игра — панел с фрази (позиция, размер, цветове, шрифт, колони,
//       скрол), бутон, балонче. Screenshot-и се записват в --screenshots=<dir>.
//   F — функционалност: 14-те фрази в точния ред, toggle/outside-click
//       затваряне, взаимно изключване с emoji панела, изпращане и показване
//       при двамата играчи до картата на подателя, 4500ms живот, replace,
//       скрол на телефон, не пречи на зара.
//   S — сървърни проверки: произволен текст/чужд каталог/невалиден id/чужд
//       matchId/неучастник/напуснал играч — нищо не се broadcast-ва; без
//       смесване между две паралелни маси.
//   R — reconnect: прекъснат WebSocket и презареждане на страницата —
//       фразите продължават да работят и в двете посоки.

import { createHmac } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { chromium, type BrowserContext, type Page } from 'playwright'
import { createServer as createViteServer } from 'vite'

const LUDO_PHRASES = [
  'ХАХА... Чукнах те!',
  'Ще те скъсам!',
  'Само да те докопам!',
  'Бягай, идвам!',
  'Това вече е наглост!',
  'Нищо лично!',
  'Опа, без да искам!',
  'Това боли!',
  'Записвам си го в черния тефтер!',
  'Играеш си с огъня!',
  'Нервичките как са?',
  'Тук не си добре!',
  'Благодаря за играта!',
  'Успех!',
]

// Регистрацията минава през pending registration + 6-цифрен код по имейл
// (виж checkLudoEmojiDiceInteraction.ts за същия подход): изолираният
// сървър получава throwaway EMAIL_VERIFICATION_CODE_SECRET, а кодът се
// възстановява локално от code_hash в неговата собствена SQLite база.
const EMAIL_VERIFICATION_SECRET = 'ludo-phrase-harness-throwaway-secret-32chars-x'
function recoverVerificationCode(storedHash: string): string {
  for (let n = 0; n < 1_000_000; n += 1) {
    const code = n.toString().padStart(6, '0')
    if (createHmac('sha256', EMAIL_VERIFICATION_SECRET).update(`email-verification-code-v1:${code}`).digest('hex') === storedHash) return code
  }
  throw new Error('could not recover verification code from code_hash')
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))
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
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
function near(a: number, b: number, tolerance: number, label: string): void {
  if (Math.abs(a - b) > tolerance) throw new Error(`${label}: Белот=${a.toFixed(2)} Ludo=${b.toFixed(2)} (tolerance ${tolerance})`)
}
const freePort = () => new Promise<number>((done, failPort) => {
  const server = createNetServer().once('error', failPort).listen(0, '127.0.0.1', () => {
    const address = server.address()
    if (!address || typeof address === 'string') return failPort(new Error('No free port'))
    server.close(() => done(address.port))
  })
})

const projectRoot = process.cwd()
const onlySections = process.argv.find((arg) => arg.startsWith('--only='))?.slice('--only='.length).split(',') ?? null
const shouldRun = (section: string) => onlySections === null || onlySections.includes(section)
const screenshotDir = process.argv.find((arg) => arg.startsWith('--screenshots='))?.slice('--screenshots='.length) ?? null

async function createIsolatedServerRoot() {
  const root = await mkdtemp(join(tmpdir(), 'belot-ludo-phrase-'))
  const serverDir = join(root, 'server')
  await mkdir(serverDir, { recursive: true })
  await cp(join(projectRoot, 'server', 'src'), join(serverDir, 'src'), { recursive: true, preserveTimestamps: true })
  await cp(join(projectRoot, 'server', 'dist'), join(serverDir, 'dist'), { recursive: true, preserveTimestamps: true }).catch(() => undefined)
  await mkdir(join(serverDir, 'database', 'data'), { recursive: true })
  await cp(join(projectRoot, 'server', 'database', 'migrations'), join(serverDir, 'database', 'migrations'), { recursive: true, preserveTimestamps: true })
  await cp(join(projectRoot, 'server', 'package.json'), join(serverDir, 'package.json'), { preserveTimestamps: true })
  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  await symlink(join(projectRoot, 'server', 'node_modules'), join(serverDir, 'node_modules'), linkType)
  await symlink(join(projectRoot, 'node_modules'), join(root, 'node_modules'), linkType)
  return { serverDir, cleanup: () => rm(root, { recursive: true, force: true }).catch(() => undefined) }
}

type RunningServer = { child: ChildProcessWithoutNullStreams; output(): string }
function startServer(serverDir: string, port: number): RunningServer {
  const chunks: string[] = []
  const child = spawn(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'index.ts')], {
    cwd: serverDir,
    env: { ...process.env, PORT: String(port), EMAIL_VERIFICATION_CODE_SECRET: EMAIL_VERIFICATION_SECRET },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
  child.stdout.on('data', (c) => chunks.push(c)); child.stderr.on('data', (c) => chunks.push(c))
  return { child, output: () => chunks.join('') }
}
async function waitForHealth(port: number, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`)
      const h: any = await r.json()
      if (r.status === 200 && h.ok === true && h.gameWorkerLifecycle?.state === 'ready') return true
    } catch { /* retry */ }
    await sleep(200)
  }
  return false
}

type Profile = { cookie: string; profileId: string }
function randomVisitorUuid(): string {
  const hex = () => Math.floor(Math.random() * 16).toString(16)
  const block = (n: number) => Array.from({ length: n }, hex).join('')
  return `${block(8)}-${block(4)}-4${block(3)}-${['8', '9', 'a', 'b'][Math.floor(Math.random() * 4)]}${block(3)}-${block(12)}`
}

// undici преизползва keep-alive сокет, който сървърът вече е затворил след
// дълга пауза → ECONNRESET. Мрежова грешка (не HTTP отговор) се повтаря.
async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fetch(url, init)
    } catch (error) {
      if (attempt >= 3) throw error
      await sleep(200)
    }
  }
}

async function register(port: number, tag: string, runId: string, serverDir: string): Promise<Profile> {
  const email = `ludo-phrase-${tag}-${runId}@example.test`
  const registerRes = await fetchWithRetry(`http://127.0.0.1:${port}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email, password: 'LudoPhrase1!',
      displayName: `LP${tag.replace(/[^a-zA-Z0-9]/g, '')}${runId.slice(-5)}`,
      gender: 'male', visitorId: randomVisitorUuid(),
    }),
  })
  const registerBody: any = await registerRes.json()
  const pendingRegistrationId = registerBody.pendingRegistrationId as string | undefined
  if (!pendingRegistrationId) throw new Error(`register ${tag}: unexpected response ${registerRes.status} ${JSON.stringify(registerBody)}`)
  const db = new DatabaseSync(join(serverDir, 'database', 'data', 'belot-v2.sqlite'), { readOnly: true })
  let codeHash: string
  try {
    const row = db.prepare('SELECT code_hash FROM pending_registrations WHERE pending_registration_id = ?').get(pendingRegistrationId) as { code_hash: string } | undefined
    if (!row) throw new Error(`register ${tag}: pending registration row not found`)
    codeHash = row.code_hash
  } finally {
    db.close()
  }
  const verifyRes = await fetchWithRetry(`http://127.0.0.1:${port}/api/auth/verify-registration-email`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pendingRegistrationId, code: recoverVerificationCode(codeHash) }),
  })
  const verifyBody: any = await verifyRes.json()
  if (verifyRes.status !== 200) throw new Error(`verify-registration-email ${tag} failed: ${JSON.stringify(verifyBody)}`)
  const setCookie = (verifyRes.headers.getSetCookie?.()[0] ?? verifyRes.headers.get('set-cookie'))?.split(';')[0] ?? null
  if (!setCookie) throw new Error('no cookie returned')
  return { cookie: setCookie.split('=')[1]!, profileId: verifyBody.session.profile.profileId as string }
}

type Viewport = { width: number; height: number }
type PageInfo = {
  matchId: string | null
  colorByProfile: Map<string, string>
  received: any[]
  sent: any[]
  pageErrors: string[]
  lastConnectedAt: number
}

console.log('\ncheckLudoPhraseReaction\n')

const isolated = await createIsolatedServerRoot()
const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
let server: RunningServer | null = null
const browser = await chromium.launch({ headless: true })
let vite: Awaited<ReturnType<typeof createViteServer>> | null = null

try {
  const backendPort = await freePort()
  server = startServer(isolated.serverDir, backendPort)
  console.log(`Waiting for server on port ${backendPort}...`)
  if (!(await waitForHealth(backendPort))) { console.error(server.output()); throw new Error('server did not become ready') }
  console.log('Server ready.\n')

  const vitePort = await freePort()
  vite = await createViteServer({
    root: projectRoot,
    server: { host: '127.0.0.1', port: vitePort, strictPort: true },
    logLevel: 'error',
    plugins: [{
      name: 'ludo-phrase-isolated-backend',
      enforce: 'pre',
      transform(code, id) {
        if (!id.includes('/src/') && !id.includes('\\src\\')) return null
        return code.includes(':3001') ? code.replaceAll(':3001', `:${backendPort}`) : null
      },
    }],
  })
  await vite.listen()
  const appOrigin = `http://127.0.0.1:${vitePort}`
  const backendOrigin = `http://127.0.0.1:${backendPort}`

  const infoByPage = new WeakMap<Page, PageInfo>()
  const info = (page: Page): PageInfo => infoByPage.get(page)!

  async function newTrackedContext(viewport: Viewport, profile: Profile | null): Promise<BrowserContext> {
    const context = await browser.newContext({ viewport })
    if (profile) await context.addCookies([{ name: 'belot_session', value: profile.cookie, url: backendOrigin }])
    // Пази референция към реалния app WebSocket — за protocol-level
    // проверките (S) и за прекъсване на връзката (R) през СЪЩАТА
    // автентикирана връзка, без втора паралелна сесия.
    // (string, не функция — tsx/esbuild иначе вмъква __name helper.)
    await context.addInitScript(`
      (() => {
        const NativeWebSocket = window.WebSocket
        window.WebSocket = class extends NativeWebSocket {
          constructor(...args) {
            super(...args)
            // Само app сокетът към backend /ws — не Vite HMR сокета.
            if (String(args[0]).includes('/ws')) window.__appWs = this
          }
        }
      })()
    `)
    return context
  }

  function trackPage(page: Page): PageInfo {
    const pageInfo: PageInfo = { matchId: null, colorByProfile: new Map(), received: [], sent: [], pageErrors: [], lastConnectedAt: 0 }
    infoByPage.set(page, pageInfo)
    page.on('pageerror', (error) => pageInfo.pageErrors.push(error.message))
    page.on('websocket', (ws) => {
      ws.on('framereceived', (frame) => {
        try {
          const payload = typeof frame.payload === 'string' ? frame.payload : frame.payload.toString('utf8')
          const msg = JSON.parse(payload)
          pageInfo.received.push(msg)
          if (msg.type === 'connected') pageInfo.lastConnectedAt = Date.now()
          if ((msg.type === 'ludo_game_started' || msg.type === 'ludo_game_state') && msg.snapshot) {
            pageInfo.matchId = msg.snapshot.matchId
            for (const p of msg.snapshot.players) pageInfo.colorByProfile.set(p.profileId, p.color)
          }
        } catch { /* ignore */ }
      })
      ws.on('framesent', (frame) => {
        try {
          const payload = typeof frame.payload === 'string' ? frame.payload : frame.payload.toString('utf8')
          pageInfo.sent.push(JSON.parse(payload))
        } catch { /* ignore */ }
      })
    })
    return pageInfo
  }

  async function openLudo(profile: Profile, viewport: Viewport): Promise<Page> {
    const context = await newTrackedContext(viewport, profile)
    const page = await context.newPage()
    trackPage(page)
    await page.goto(`${appOrigin}/games/ludo`)
    const consentButton = page.locator('[data-consent-accept-all="1"]')
    if (await consentButton.isVisible().catch(() => false)) await consentButton.click()
    await page.locator('[data-ludo-lobby="1"]').waitFor({ state: 'visible', timeout: 15_000 })
    await page.waitForTimeout(300)
    return page
  }

  async function createRoom(page: Page): Promise<void> {
    await page.locator('[data-ludo-create-open="1"]').click()
    await page.locator('[data-ludo-create-form="1"]').waitFor({ state: 'visible' })
    await page.locator('[data-ludo-create-form="1"] select[name="playerCount"]').selectOption('2')
    const stakeSelect = page.locator('[data-ludo-create-form="1"] select[name="stake"]')
    const firstStakeValue = await stakeSelect.locator('option').first().getAttribute('value')
    await stakeSelect.selectOption(firstStakeValue!)
    await page.locator('[data-ludo-create-form="1"]').evaluate((form: HTMLFormElement) => form.requestSubmit())
  }

  async function startTwoPlayerMatch(tagA: string, tagB: string, viewportA: Viewport, viewportB: Viewport) {
    const aProfile = await register(backendPort, tagA, runId, isolated.serverDir)
    const bProfile = await register(backendPort, tagB, runId, isolated.serverDir)
    const aPage = await openLudo(aProfile, viewportA)
    await createRoom(aPage)
    await aPage.locator('[data-ludo-room-leave="1"]').waitFor({ state: 'visible', timeout: 10_000 })
    const bPage = await openLudo(bProfile, viewportB)
    const joinButton = bPage.locator(`[data-ludo-room-join]`).first()
    await joinButton.waitFor({ state: 'visible', timeout: 10_000 })
    await joinButton.click()
    await aPage.locator('[data-ludo-cell-pieces]').first().waitFor({ state: 'attached', timeout: 15_000 })
    await bPage.locator('[data-ludo-cell-pieces]').first().waitFor({ state: 'attached', timeout: 15_000 })
    const aColor = await waitFor(() => info(aPage).colorByProfile.get(aProfile.profileId), 'A color')
    const bColor = await waitFor(() => info(bPage).colorByProfile.get(bProfile.profileId), 'B color')
    const matchId = await waitFor(() => info(aPage).matchId, 'matchId')
    return { aProfile, bProfile, aPage, bPage, aColor, bColor, matchId }
  }

  async function waitFor<T>(read: () => T | null | undefined, label: string, timeoutMs = 10_000): Promise<T> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const value = read()
      if (value !== null && value !== undefined) return value
      await sleep(80)
    }
    throw new Error(`${label} not observed in time`)
  }

  async function dismissLudoPopups(page: Page): Promise<void> {
    const dismiss = page.locator('[data-ludo-bot-takeover-dismiss]')
    if (await dismiss.isVisible().catch(() => false)) await dismiss.click().catch(() => undefined)
  }

  // Предварително съществуваща гонка (не е част от фразите): два бързи
  // ludo_game_state при reload/reconnect могат да монтират два Ludo екрана
  // (openLudoGameOverlay проверява _ludoController преди async import-ите).
  // Отчитаме го като WARN и работим с последния (живия) екран.
  const duplicateScreenWarnings = new Set<string>()
  async function noteDuplicateLudoScreens(page: Page): Promise<void> {
    const roots = await page.locator('[data-ludo-overlay-root]').count()
    if (roots > 1 && !duplicateScreenWarnings.has(page.url() + roots)) {
      duplicateScreenWarnings.add(page.url() + roots)
      console.log(`  WARN  ${roots} Ludo overlay roots в DOM-а (предварително съществуваща double-mount гонка в openLudoGameOverlay)`)
    }
  }

  async function openPhrasePicker(page: Page): Promise<void> {
    await dismissLudoPopups(page)
    if (await page.locator('[data-ludo-phrase-picker="1"]').isVisible().catch(() => false)) return
    await noteDuplicateLudoScreens(page)
    await page.locator('[data-ludo-phrase-button="1"]').last().click()
    await page.locator('[data-ludo-phrase-picker="1"]').waitFor({ state: 'visible', timeout: 5_000 })
  }

  // Bot takeover popup (при изтекъл ход на неактивен тестов играч) може да
  // изскочи между отварянето на панела и клика — тогава го затваряме и
  // повтаряме.
  async function sendPhrase(page: Page, index: number): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await openPhrasePicker(page)
        const pick = page.locator(`[data-ludo-phrase-pick="ludo_phrase_${String(index).padStart(2, '0')}"]`)
        await pick.scrollIntoViewIfNeeded({ timeout: 3_000 })
        await pick.click({ timeout: 3_000 })
        return
      } catch (error) {
        if (attempt >= 3) throw error
        await dismissLudoPopups(page)
      }
    }
  }

  async function bubbleText(page: Page, color: string): Promise<string | null> {
    return page.evaluate((c) => document.querySelector(`[data-ludo-phrase-bubble="${c}"]`)?.textContent?.trim() ?? null, color)
  }

  async function waitBubble(page: Page, color: string, text: string, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await bubbleText(page, color) === text) return
      await sleep(60)
    }
    throw new Error(`bubble "${text}" for ${color} not shown (got ${JSON.stringify(await bubbleText(page, color))})`)
  }

  // Най-близкият player panel до центъра на балончето — трябва да е на
  // подателя (балончето е закачено за неговата карта).
  async function nearestPanelColor(page: Page, color: string): Promise<string | null> {
    return page.evaluate((c) => {
      const bubble = document.querySelector(`[data-ludo-phrase-bubble="${c}"]`)
      if (!bubble) return null
      const b = bubble.getBoundingClientRect()
      const bx = b.left + b.width / 2
      const by = b.top + b.height / 2
      let best: string | null = null
      let bestDistance = Infinity
      for (const panel of Array.from(document.querySelectorAll('[data-ludo-player-panel]'))) {
        const r = panel.getBoundingClientRect()
        const dx = Math.max(r.left - bx, 0, bx - r.right)
        const dy = Math.max(r.top - by, 0, by - r.bottom)
        const distance = Math.hypot(dx, dy)
        if (distance < bestDistance) { bestDistance = distance; best = panel.getAttribute('data-ludo-player-panel') }
      }
      return best
    }, color)
  }

  async function rawSend(page: Page, message: unknown): Promise<void> {
    await page.evaluate((m) => {
      const ws = (window as any).__appWs as WebSocket | undefined
      if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('app websocket not open')
      ws.send(JSON.stringify(m))
    }, message)
  }

  function phraseMessagesSince(page: Page, start: number): any[] {
    return info(page).received.slice(start).filter((m) => m.type === 'ludo_phrase_reaction')
  }

  // ───────── measurement helpers (изпълняват се в страницата) ─────────
  type PickerMetrics = {
    rect: { x: number; y: number; w: number; h: number; right: number; bottom: number }
    bg: string; border: string; radius: string; padding: string; gap: string; transform: string
    maxHeight: string; overflowY: string; boxShadow: string; position: string; columns: number
    scrollable: boolean
    btn: { w: number; h: number; font: string; color: string; bg: string; border: string; radius: string; padding: string; minHeight: string; textAlign: string }
    texts: string[]
  }
  async function measurePicker(page: Page, panelSelector: string, pickSelector: string): Promise<PickerMetrics> {
    return page.evaluate(({ panelSelector: ps, pickSelector: ks }) => {
      const panel = document.querySelector(ps) as HTMLElement
      const r = panel.getBoundingClientRect()
      const cs = getComputedStyle(panel)
      const buttons = Array.from(panel.querySelectorAll(ks)) as HTMLElement[]
      const first = buttons[0]!
      const br = first.getBoundingClientRect()
      const bcs = getComputedStyle(first)
      return {
        rect: { x: r.x, y: r.y, w: r.width, h: r.height, right: window.innerWidth - r.right, bottom: window.innerHeight - r.bottom },
        bg: cs.backgroundColor,
        border: `${cs.borderTopWidth} ${cs.borderTopStyle} ${cs.borderTopColor}`,
        radius: cs.borderTopLeftRadius,
        padding: cs.padding,
        gap: `${cs.rowGap} ${cs.columnGap}`,
        transform: cs.transform,
        maxHeight: cs.maxHeight,
        overflowY: cs.overflowY,
        boxShadow: cs.boxShadow,
        position: cs.position,
        columns: new Set(buttons.map((b) => Math.round(b.getBoundingClientRect().left))).size,
        scrollable: panel.scrollHeight > panel.clientHeight + 1,
        btn: {
          w: br.width, h: br.height, font: bcs.font, color: bcs.color, bg: bcs.backgroundColor,
          border: `${bcs.borderTopWidth} ${bcs.borderTopStyle} ${bcs.borderTopColor}`,
          radius: bcs.borderTopLeftRadius, padding: bcs.padding, minHeight: bcs.minHeight, textAlign: bcs.justifyContent,
        },
        texts: buttons.map((b) => (b.textContent ?? '').trim()),
      }
    }, { panelSelector, pickSelector })
  }

  type CardMetrics = {
    fontPx: number; fontWeight: string; lineHeight: number; color: string; bg: string; borderColor: string; borderPx: number
    padV: number; padH: number; radius: number; minW: number; maxW: number; boxShadow: string; textAlign: string; opacity: string
  }
  async function measureCard(page: Page, selector: string): Promise<CardMetrics> {
    return page.evaluate((sel) => {
      const el = document.querySelector(sel) as HTMLElement
      const cs = getComputedStyle(el)
      const k = el.getBoundingClientRect().width / el.offsetWidth
      return {
        fontPx: parseFloat(cs.fontSize) * k,
        fontWeight: cs.fontWeight,
        lineHeight: parseFloat(cs.lineHeight) / parseFloat(cs.fontSize),
        color: cs.color,
        bg: cs.backgroundColor,
        borderColor: cs.borderTopColor,
        borderPx: parseFloat(cs.borderTopWidth) * k,
        padV: parseFloat(cs.paddingTop) * k,
        padH: parseFloat(cs.paddingLeft) * k,
        radius: parseFloat(cs.borderTopLeftRadius) * k,
        minW: parseFloat(cs.minWidth) * k,
        maxW: parseFloat(cs.maxWidth) * k,
        boxShadow: cs.boxShadow,
        textAlign: cs.textAlign,
        opacity: getComputedStyle(el.parentElement!).opacity,
      }
    }, selector)
  }

  async function measureToggle(page: Page, selector: string) {
    return page.evaluate((sel) => {
      const el = document.querySelector(sel) as HTMLElement
      const cs = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      const icon = el.querySelector('span[aria-hidden="true"]') as HTMLElement
      const ir = icon.getBoundingClientRect()
      return {
        w: r.width, h: r.height,
        bg: cs.backgroundColor, border: `${cs.borderTopWidth} ${cs.borderTopStyle} ${cs.borderTopColor}`,
        radius: cs.borderTopLeftRadius, boxShadow: cs.boxShadow,
        iconRatioW: ir.width / r.width, iconRatioH: ir.height / r.height,
        iconBg: getComputedStyle(icon).backgroundColor,
        dots: icon.querySelectorAll(':scope > span').length,
      }
    }, selector)
  }

  async function shot(page: Page, name: string): Promise<void> {
    if (!screenshotDir) return
    await page.screenshot({ path: join(screenshotDir, `${name}.png`) })
  }

  // ───────── Belot baseline (реалният Белот контролер) ─────────
  async function openBelot(viewport: Viewport): Promise<Page> {
    const context = await browser.newContext({ viewport })
    const page = await context.newPage()
    trackPage(page)
    await page.goto(`${appOrigin}/scripts/fixtures/activeRoomSpectatorHarness.html`)
    await page.waitForFunction(() => (window as any).__activeRoomSpectatorHarness !== undefined, undefined, { timeout: 15_000 })
    // Реалното приложение зарежда src/style.css глобално (main.ts) — без него
    // harness-ът би рисувал Белот с browser default box-sizing и сравнението
    // нямаше да е честно.
    await page.evaluate(`import('/src/style.css')`)
    await page.waitForTimeout(200)
    await page.evaluate(async () => {
      const h = (window as any).__activeRoomSpectatorHarness
      await h.enterAsParticipant('room-phrase-visual', 'bottom')
      await h.applyParticipantSnapshot('room-phrase-visual', h.playingGame())
    })
    await page.locator('[data-phrase-toggle="1"]').waitFor({ state: 'visible', timeout: 5_000 })
    return page
  }

  // ═══════════════════════════════════════════════════════════════════
  // V: визуално сравнение Белот ↔ Ludo при еднакъв viewport
  // ═══════════════════════════════════════════════════════════════════
  console.log('=== V: Белот ↔ Ludo визуално сравнение ===')
  if (shouldRun('V')) {
    const match = await startTwoPlayerMatch('va', 'vb', { width: 1280, height: 850 }, { width: 1280, height: 850 })
    const viewports: Array<{ label: string; viewport: Viewport; phone: boolean }> = [
      { label: 'desktop-1280x850', viewport: { width: 1280, height: 850 }, phone: false },
      { label: 'desktop-1920x1080', viewport: { width: 1920, height: 1080 }, phone: false },
      { label: 'phone-390x844', viewport: { width: 390, height: 844 }, phone: true },
      { label: 'phone-360x800', viewport: { width: 360, height: 800 }, phone: true },
    ]

    for (const { label, viewport, phone } of viewports) {
      const belot = await openBelot(viewport)
      await match.aPage.setViewportSize(viewport)
      await match.bPage.setViewportSize(viewport)
      await match.aPage.waitForTimeout(400)
      await dismissLudoPopups(match.aPage)

      // Панел с фрази
      await belot.locator('[data-phrase-toggle="1"]').click()
      await belot.locator('[data-phrase-picker="1"]').waitFor({ state: 'visible' })
      const belotPicker = await measurePicker(belot, '[data-phrase-picker="1"]', '[data-phrase-pick]')
      await shot(belot, `${label}-belot-picker`)
      await openPhrasePicker(match.aPage)
      const ludoPicker = await measurePicker(match.aPage, '[data-ludo-phrase-picker="1"]', '[data-ludo-phrase-pick]')
      await shot(match.aPage, `${label}-ludo-picker`)

      await check(`[V:${label}] панел: същите позиция, ширина, scale, колони, цветове, рамка, отстъпи`, () => {
        assert(belotPicker.position === 'fixed' && ludoPicker.position === 'fixed', 'position')
        near(belotPicker.rect.w, ludoPicker.rect.w, 0.5, 'width')
        near(belotPicker.rect.right, ludoPicker.rect.right, 0.5, 'right offset')
        assert(belotPicker.transform === ludoPicker.transform, `transform ${belotPicker.transform} vs ${ludoPicker.transform}`)
        assert(belotPicker.columns === ludoPicker.columns, `columns ${belotPicker.columns} vs ${ludoPicker.columns}`)
        assert(belotPicker.columns === (phone ? 1 : 2), `expected ${phone ? 1 : 2} columns, got ${belotPicker.columns}`)
        for (const key of ['bg', 'border', 'radius', 'padding', 'gap', 'maxHeight', 'overflowY', 'boxShadow'] as const) {
          assert(belotPicker[key] === ludoPicker[key], `${key}: Белот=${belotPicker[key]} Ludo=${ludoPicker[key]}`)
        }
        if (!phone) near(belotPicker.rect.bottom, ludoPicker.rect.bottom, 0.5, 'bottom offset (76px)')
      })

      await check(`[V:${label}] бутоните в панела: същият шрифт, цвят, рамка, фон, отстъпи, размер`, () => {
        for (const key of ['font', 'color', 'bg', 'border', 'radius', 'padding', 'minHeight', 'textAlign'] as const) {
          assert(belotPicker.btn[key] === ludoPicker.btn[key], `button ${key}: Белот=${belotPicker.btn[key]} Ludo=${ludoPicker.btn[key]}`)
        }
        near(belotPicker.btn.w, ludoPicker.btn.w, 0.5, 'button width')
      })

      if (phone) {
        await check(`[V:${label}] телефон: същата височина (52vh), скрол, 8px над долната лента`, async () => {
          near(belotPicker.rect.h, ludoPicker.rect.h, 0.5, 'height')
          assert(belotPicker.scrollable && ludoPicker.scrollable, `scrollable Белот=${belotPicker.scrollable} Ludo=${ludoPicker.scrollable}`)
          // Белот: 8px над 50px долна навигация; Ludo: 8px над долната лента.
          near(belotPicker.rect.bottom, 50 + 8, 0.5, 'Белот bottom')
          const barTop = await match.aPage.evaluate(() => document.querySelector('[data-ludo-bottom-bar="1"]')!.getBoundingClientRect().top)
          near(barTop - (viewport.height - ludoPicker.rect.bottom), 8, 0.6, 'Ludo: отстъп над долната лента')
        })
      }

      await check(`[V:${label}] Ludo панелът съдържа точно 14-те фрази в зададения ред`, () => {
        assert(JSON.stringify(ludoPicker.texts) === JSON.stringify(LUDO_PHRASES), `texts: ${JSON.stringify(ludoPicker.texts)}`)
      })

      // Бутон „Фрази“
      const belotToggle = await measureToggle(belot, '[data-phrase-toggle="1"]')
      const ludoToggle = await measureToggle(match.aPage, '[data-ludo-phrase-button="1"]')
      await check(`[V:${label}] бутон „Фрази“: същата повърхност и икона`, () => {
        for (const key of ['bg', 'border', 'radius', 'boxShadow', 'iconBg', 'dots'] as const) {
          assert(belotToggle[key] === ludoToggle[key], `${key}: Белот=${belotToggle[key]} Ludo=${ludoToggle[key]}`)
        }
        near(belotToggle.iconRatioW, ludoToggle.iconRatioW, 0.02, 'icon width ratio')
        near(belotToggle.iconRatioH, ludoToggle.iconRatioH, 0.02, 'icon height ratio')
        if (phone) near(belotToggle.w, ludoToggle.w, 0.5, 'phone button size (40px)')
      })

      // Затваряне на двата панела
      await belot.locator('[data-phrase-toggle="1"]').click()
      await match.aPage.locator('[data-ludo-phrase-button="1"]').click()

      // Балонче: Белот — фраза от дясното място; Ludo — фраза от B.
      await belot.evaluate(async () => {
        const h = (window as any).__activeRoomSpectatorHarness
        await h.injectServerMessage({ type: 'phrase_reaction', roomId: 'room-phrase-visual', seat: 'right', phraseId: 'phrase_01' })
      })
      await sendPhrase(match.bPage, 4)
      await waitBubble(match.aPage, match.bColor, LUDO_PHRASES[3]!)
      await sleep(1_000)
      const belotBubbleSelector = phone ? '[data-mobile-phrase-bubble="right"]' : '[data-seat-phrase-bubble="right"] > div > div'
      await belot.locator(belotBubbleSelector).waitFor({ state: 'attached', timeout: 3_000 })
      const belotCard = await measureCard(belot, belotBubbleSelector)
      const ludoCard = await measureCard(match.aPage, `[data-ludo-phrase-bubble="${match.bColor}"]`)
      await shot(belot, `${label}-belot-bubble`)
      await shot(match.aPage, `${label}-ludo-bubble`)
      await check(`[V:${label}] балонче: същият шрифт, рамка, фон, отстъпи, ширини`, () => {
        for (const key of ['fontWeight', 'color', 'bg', 'borderColor', 'boxShadow', 'textAlign'] as const) {
          assert(belotCard[key] === ludoCard[key], `${key}: Белот=${belotCard[key]} Ludo=${ludoCard[key]}`)
        }
        near(belotCard.fontPx, ludoCard.fontPx, 0.6, 'font px')
        near(belotCard.lineHeight, ludoCard.lineHeight, 0.01, 'line-height')
        near(belotCard.borderPx, ludoCard.borderPx, 0.6, 'border px')
        near(belotCard.padV, ludoCard.padV, 0.6, 'padding V')
        near(belotCard.padH, ludoCard.padH, 0.6, 'padding H')
        near(belotCard.radius, ludoCard.radius, 0.6, 'radius')
        near(belotCard.minW, ludoCard.minW, 0.6, 'min-width')
      })
      await belot.context().close()
      await sleep(3_600)
    }

    // Отделно: 8px отстъп над лентата на телефон (Ludo) — като Белот над навигацията.
    await match.aPage.setViewportSize({ width: 390, height: 844 })
    await match.aPage.waitForTimeout(400)
    await openPhrasePicker(match.aPage)
    await check('[V:phone] Ludo панелът е на 8px над долната лента (Белот: 8px над долната навигация)', async () => {
      const gap = await match.aPage.evaluate(() => {
        const bar = document.querySelector('[data-ludo-bottom-bar="1"]')!.getBoundingClientRect()
        const panel = document.querySelector('[data-ludo-phrase-picker="1"]')!.getBoundingClientRect()
        return bar.top - panel.bottom
      })
      near(gap, 8, 0.6, 'gap')
    })
    await match.aPage.locator('[data-ludo-phrase-button="1"]').click()
    await match.aPage.context().close()
    await match.bPage.context().close()
  }

  // ═══════════════════════════════════════════════════════════════════
  // F: функционалност (A desktop, B phone)
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n=== F: функционалност ===')
  if (shouldRun('F')) {
    const { aPage, bPage, aColor, bColor } = await startTwoPlayerMatch('fa', 'fb', { width: 1280, height: 850 }, { width: 390, height: 844 })

    await check('[F1] бутонът отваря и затваря панела (toggle)', async () => {
      await openPhrasePicker(aPage)
      await aPage.locator('[data-ludo-phrase-button="1"]').click()
      await aPage.locator('[data-ludo-phrase-picker="1"]').waitFor({ state: 'detached', timeout: 2_000 })
    })

    await check('[F2] клик извън панела го затваря', async () => {
      await openPhrasePicker(aPage)
      await aPage.mouse.click(640, 80)
      await aPage.locator('[data-ludo-phrase-picker="1"]').waitFor({ state: 'detached', timeout: 2_000 })
    })

    await check('[F3] emoji и фрази се изключват взаимно (като в Белот)', async () => {
      await openPhrasePicker(aPage)
      await aPage.locator('[data-ludo-emoji-button="1"]').click()
      await aPage.locator('[data-ludo-emoji-picker="1"]').waitFor({ state: 'visible', timeout: 2_000 })
      assert(await aPage.locator('[data-ludo-phrase-picker="1"]').count() === 0, 'phrase picker still open after emoji open')
      await aPage.locator('[data-ludo-phrase-button="1"]').click()
      await aPage.locator('[data-ludo-phrase-picker="1"]').waitFor({ state: 'visible', timeout: 2_000 })
      assert(await aPage.locator('[data-ludo-emoji-picker="1"]').count() === 0, 'emoji picker still open after phrase open')
      await aPage.locator('[data-ludo-phrase-button="1"]').click()
    })

    const aStart = info(aPage).received.length
    const bStart = info(bPage).received.length
    await check('[F4] изборът изпраща фразата, панелът се затваря, двамата я виждат до картата на A', async () => {
      await sendPhrase(aPage, 1)
      await aPage.locator('[data-ludo-phrase-picker="1"]').waitFor({ state: 'detached', timeout: 2_000 })
      await waitBubble(aPage, aColor, LUDO_PHRASES[0]!)
      await waitBubble(bPage, aColor, LUDO_PHRASES[0]!)
      assert(await nearestPanelColor(aPage, aColor) === aColor, 'A: bubble not anchored to A card')
      assert(await nearestPanelColor(bPage, aColor) === aColor, 'B (phone): bubble not anchored to A card')
      const sent = info(aPage).sent.filter((m) => m.type === 'send_ludo_phrase_reaction')
      assert(sent.length === 1 && sent[0].phraseId === 'ludo_phrase_01', `sent: ${JSON.stringify(sent)}`)
      assert(phraseMessagesSince(aPage, aStart).length === 1 && phraseMessagesSince(bPage, bStart).length === 1, 'each participant receives exactly one echo')
    })

    await check('[F5] балончето е видимо ~4.0s и изчезва след 4.5s (същото време като Белот)', async () => {
      const shownAt = Date.now()
      await sleep(Math.max(0, 3_900 - (Date.now() - shownAt)))
      assert(await bubbleText(bPage, aColor) === LUDO_PHRASES[0], 'bubble gone too early')
      await sleep(1_000)
      assert(await bubbleText(bPage, aColor) === null, 'bubble still present after lifetime')
      assert(await bubbleText(aPage, aColor) === null, 'bubble still present on sender after lifetime')
    })

    await check('[F6] нова фраза от същия играч заменя старата (едно балонче на играч)', async () => {
      await sendPhrase(aPage, 2)
      await waitBubble(bPage, aColor, LUDO_PHRASES[1]!)
      await sendPhrase(aPage, 3)
      await waitBubble(bPage, aColor, LUDO_PHRASES[2]!)
      const count = await bPage.locator(`[data-ludo-phrase-bubble="${aColor}"]`).count()
      assert(count === 1, `expected 1 bubble for A, got ${count}`)
    })

    await check('[F7] телефон: панелът скролира, последната фраза („Успех!“) е достъпна и се изпраща', async () => {
      await openPhrasePicker(bPage)
      const scroll = await bPage.evaluate(() => {
        const panel = document.querySelector('[data-ludo-phrase-picker="1"]') as HTMLElement
        panel.scrollTop = panel.scrollHeight
        return { top: panel.scrollTop, max: panel.scrollHeight - panel.clientHeight }
      })
      assert(scroll.max > 0 && scroll.top > 0, `panel not scrollable: ${JSON.stringify(scroll)}`)
      await bPage.locator('[data-ludo-phrase-pick="ludo_phrase_14"]').click()
      await waitBubble(aPage, bColor, 'Успех!')
      await waitBubble(bPage, bColor, 'Успех!')
      assert(await nearestPanelColor(aPage, bColor) === bColor, 'B bubble not anchored to B card on A')
    })

    await check('[F8] emoji + фраза едновременно: балончетата не се застъпват', async () => {
      await sleep(4_700)
      await aPage.locator('[data-ludo-emoji-button="1"]').click()
      await aPage.locator('[data-ludo-emoji-pick="05"]').click()
      await sendPhrase(aPage, 9)
      await waitBubble(bPage, aColor, LUDO_PHRASES[8]!)
      await sleep(300)
      for (const page of [aPage, bPage]) {
        const overlap = await page.evaluate((c) => {
          const phrase = document.querySelector(`[data-ludo-phrase-bubble="${c}"]`)!.getBoundingClientRect()
          const panel = document.querySelector(`[data-ludo-player-panel="${c}"]`)!
          const emoji = panel.parentElement!.querySelector('[data-ludo-emoji-reaction]')
          if (!emoji) return 'no-emoji'
          const e = emoji.getBoundingClientRect()
          return phrase.left < e.right && e.left < phrase.right && phrase.top < e.bottom && e.top < phrase.bottom ? 'overlap' : 'ok'
        }, aColor)
        assert(overlap === 'ok', `phrase/emoji overlap state: ${overlap}`)
        const inViewport = await page.evaluate((c) => {
          const r = document.querySelector(`[data-ludo-phrase-bubble="${c}"]`)!.getBoundingClientRect()
          return r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight
        }, aColor)
        assert(inViewport, 'phrase bubble outside the viewport')
      }
    })

    // След хвърляне мачът чака избор на пионка — довършваме го, иначе
    // изтича 15s move timeout и идва bot takeover (виж
    // checkLudoEmojiDiceInteraction.ts::completePendingMoveIfAny).
    async function waitForRoller(): Promise<Page> {
      const deadline = Date.now() + 40_000
      while (Date.now() < deadline) {
        for (const page of [aPage, bPage]) {
          await dismissLudoPopups(page)
          if (await page.locator('[data-ludo-dice-roll-button="1"]').isVisible().catch(() => false)) return page
          const piece = page.locator('[data-ludo-piece-selectable="1"]').first()
          if (await piece.isVisible().catch(() => false)) await piece.click().catch(() => undefined)
        }
        await sleep(150)
      }
      throw new Error('no local roll button became available')
    }
    async function clickDiceExpectRoll(page: Page): Promise<void> {
      const before = info(page).sent.filter((m) => m.type === 'ludo_roll_request').length
      // Реалната точка на клика трябва да попада в зара (няма невидим
      // прихващащ слой от панела/балончетата).
      const hit = await page.evaluate(() => {
        const dice = document.querySelector('[data-ludo-dice-roll-button="1"]')!.getBoundingClientRect()
        const top = document.elementFromPoint(dice.left + dice.width / 2, dice.top + dice.height / 2)
        return top?.closest('[data-ludo-dice-roll-button="1"]') ? 'dice' : (top?.outerHTML.slice(0, 120) ?? 'null')
      })
      assert(hit === 'dice', `dice center is covered by: ${hit}`)
      await page.locator('[data-ludo-dice-roll-button="1"]').click()
      await sleep(400)
      const after = info(page).sent.filter((m) => m.type === 'ludo_roll_request').length
      assert(after === before + 1, `roll request not sent (before=${before}, after=${after})`)
      const piece = page.locator('[data-ludo-piece-selectable="1"]').first()
      if (await piece.waitFor({ state: 'visible', timeout: 2_000 }).then(() => true).catch(() => false)) await piece.click()
    }

    await check('[F9] след изпращане на фраза (панелът се затваря) зарът работи веднага', async () => {
      await sleep(4_700)
      const roller = await waitForRoller()
      await sendPhrase(roller, 8)
      await roller.locator('[data-ludo-phrase-picker="1"]').waitFor({ state: 'detached', timeout: 2_000 })
      await clickDiceExpectRoll(roller)
    })

    await check('[F9b] при видимо балонче на противника зарът не е блокиран', async () => {
      const roller = await waitForRoller()
      const other = roller === aPage ? bPage : aPage
      await sendPhrase(other, 2)
      await sleep(250)
      await clickDiceExpectRoll(roller)
    })

    await check('[F9c] отворен панел се затваря с тап извън него и зарът работи (както в Белот)', async () => {
      const roller = await waitForRoller()
      await openPhrasePicker(roller)
      await roller.mouse.click(5, 5)
      await roller.locator('[data-ludo-phrase-picker="1"]').waitFor({ state: 'detached', timeout: 2_000 })
      await clickDiceExpectRoll(roller)
    })

    await check('[F10] без грешки в конзолата на страниците', () => {
      const errors = [...info(aPage).pageErrors, ...info(bPage).pageErrors]
      assert(errors.length === 0, errors.join(' | '))
    })

    await aPage.context().close()
    await bPage.context().close()
  }

  // ═══════════════════════════════════════════════════════════════════
  // S: сървърни проверки и изолация между маси
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n=== S: сървърна валидация и изолация ===')
  if (shouldRun('S')) {
    const m1 = await startTwoPlayerMatch('s1a', 's1b', { width: 1280, height: 850 }, { width: 1280, height: 850 })
    const m2 = await startTwoPlayerMatch('s2a', 's2b', { width: 1280, height: 850 }, { width: 1280, height: 850 })
    const outsiderProfile = await register(backendPort, 'sout', runId, isolated.serverDir)
    const outsider = await openLudo(outsiderProfile, { width: 1280, height: 850 })
    const everyone = [m1.aPage, m1.bPage, m2.aPage, m2.bPage, outsider]

    async function expectNoBroadcast(label: string, page: Page, message: unknown): Promise<void> {
      await check(label, async () => {
        const starts = everyone.map((p) => info(p).received.length)
        await rawSend(page, message)
        await sleep(700)
        everyone.forEach((p, i) => {
          const got = phraseMessagesSince(p, starts[i]!)
          assert(got.length === 0, `unexpected ludo_phrase_reaction delivered: ${JSON.stringify(got)}`)
        })
      })
    }

    await expectNoBroadcast('[S1] произволен текст вместо phraseId се отхвърля', m1.aPage,
      { type: 'send_ludo_phrase_reaction', matchId: m1.matchId, phraseId: 'Някакъв произволен текст' })
    await expectNoBroadcast('[S2] id от Белот каталога (phrase_01) се отхвърля', m1.aPage,
      { type: 'send_ludo_phrase_reaction', matchId: m1.matchId, phraseId: 'phrase_01' })
    await expectNoBroadcast('[S3] извън диапазона (ludo_phrase_15 / ludo_phrase_00) се отхвърля', m1.aPage,
      { type: 'send_ludo_phrase_reaction', matchId: m1.matchId, phraseId: 'ludo_phrase_15' })
    await expectNoBroadcast('[S3b] ludo_phrase_00 се отхвърля', m1.aPage,
      { type: 'send_ludo_phrase_reaction', matchId: m1.matchId, phraseId: 'ludo_phrase_00' })
    await expectNoBroadcast('[S4] чужд matchId (на друга маса) се отхвърля', m1.aPage,
      { type: 'send_ludo_phrase_reaction', matchId: m2.matchId, phraseId: 'ludo_phrase_01' })
    await expectNoBroadcast('[S5] неучастник не може да изпраща в чужд мач', outsider,
      { type: 'send_ludo_phrase_reaction', matchId: m1.matchId, phraseId: 'ludo_phrase_01' })
    await expectNoBroadcast('[S5b] Белот-ският send_phrase_reaction не достига до Ludo масата', m1.aPage,
      { type: 'send_phrase_reaction', roomId: m1.matchId, phraseId: 'phrase_01' })

    await check('[S6] валидна фраза стига само до играчите на същата маса (без смесване)', async () => {
      const starts = everyone.map((p) => info(p).received.length)
      await rawSend(m1.aPage, { type: 'send_ludo_phrase_reaction', matchId: m1.matchId, phraseId: 'ludo_phrase_06' })
      await waitBubble(m1.bPage, m1.aColor, LUDO_PHRASES[5]!)
      await sleep(500)
      const counts = everyone.map((p, i) => phraseMessagesSince(p, starts[i]!).length)
      assert(counts[0] === 1 && counts[1] === 1, `match 1 participants: ${counts.slice(0, 2)}`)
      assert(counts[2] === 0 && counts[3] === 0 && counts[4] === 0, `leaked to others: ${counts.slice(2)}`)
      const msg = phraseMessagesSince(m1.bPage, starts[1]!)[0]
      assert(msg.color === m1.aColor && msg.matchId === m1.matchId && !('text' in msg), `message shape: ${JSON.stringify(msg)}`)
      assert(await bubbleText(m2.aPage, m1.aColor) === null && await bubbleText(m2.bPage, m1.aColor) === null, 'bubble rendered on other table')
    })

    await check('[S7] фраза от втората маса не стига до първата', async () => {
      const starts = everyone.map((p) => info(p).received.length)
      await sendPhrase(m2.bPage, 7)
      await waitBubble(m2.aPage, m2.bColor, LUDO_PHRASES[6]!)
      await sleep(500)
      const counts = everyone.map((p, i) => phraseMessagesSince(p, starts[i]!).length)
      assert(counts[0] === 0 && counts[1] === 0 && counts[4] === 0, `leaked to match 1/outsider: ${counts}`)
    })

    await check('[S8] напуснал („Изход“) играч не може да изпраща в стария мач', async () => {
      await dismissLudoPopups(m1.aPage)
      await m1.aPage.locator('[data-ludo-exit-button="1"]').click()
      await m1.aPage.locator('[data-ludo-exit-confirm-backdrop="1"]').waitFor({ state: 'visible', timeout: 5_000 })
      await m1.aPage.locator('[data-ludo-exit-confirm-submit="1"]').click()
      await m1.aPage.waitForURL('**/games', { timeout: 10_000 }).catch(() => undefined)
      await sleep(1_500)
      const start = info(m1.bPage).received.length
      await rawSend(m1.aPage, { type: 'send_ludo_phrase_reaction', matchId: m1.matchId, phraseId: 'ludo_phrase_02' })
      await sleep(700)
      assert(phraseMessagesSince(m1.bPage, start).length === 0, 'left player phrase was broadcast')
    })

    for (const page of everyone) await page.context().close()
  }

  // ═══════════════════════════════════════════════════════════════════
  // R: прекъсване и възстановяване на WebSocket връзката
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n=== R: reconnect ===')
  if (shouldRun('R')) {
    const { aPage, bPage, aColor, bColor } = await startTwoPlayerMatch('ra', 'rb', { width: 1280, height: 850 }, { width: 390, height: 844 })

    await check('[R1] след прекъснат и възстановен WebSocket (B) фразите работят и в двете посоки', async () => {
      const wsCountBefore = await bPage.evaluate(() => (window as any).__appWs?.readyState)
      assert(wsCountBefore === 1, 'B websocket not open initially')
      const beforeReconnect = info(bPage).received.length
      await bPage.evaluate(() => document.querySelector('[data-ludo-overlay-root]')?.setAttribute('data-test-before-reconnect', '1'))
      await bPage.evaluate(() => (window as any).__appWs.close())
      await bPage.waitForFunction(() => (window as any).__appWs?.readyState === 1, undefined, { timeout: 20_000 })
      // Изпращаме веднага щом пристигне първият ludo_game_state след reconnect —
      // точно прозорецът на resync-а (следват още snapshot-и), в който фразата
      // не бива да се губи. Преди това B реално е офлайн за сървъра.
      // Reconnect-ът на приложението е многостъпков (нов сокет, после още
      // connected цикли и повторно монтиране на Ludo екрана). Изпращаме,
      // щом се успокои: >=1.5s без ново connected и snapshot след последното.
      await waitFor(() => {
        const frames = info(bPage).received.slice(beforeReconnect)
        const connectedAt = frames.map((m) => m.type).lastIndexOf('connected')
        const settled = Date.now() - info(bPage).lastConnectedAt >= 1_500
        return connectedAt >= 0 && settled && frames.slice(connectedAt).some((m) => m.type === 'ludo_game_state') ? true : null
      }, 'B reconnect settled', 25_000)
      const bStart = info(bPage).received.length
      await sendPhrase(aPage, 10)
      try {
        await waitBubble(bPage, aColor, LUDO_PHRASES[9]!, 8_000)
      } catch (error) {
        const types = info(bPage).received.slice(bStart).map((m) => m.type)
        const dom = await bPage.evaluate(() => ({ roots: document.querySelectorAll('[data-ludo-overlay-root]').length, sameRoot: !!document.querySelector('[data-test-before-reconnect]'), host: !!document.querySelector('[data-ludo-phrase-overlay-host]') }))
        const all = info(bPage).received.slice(beforeReconnect).map((m) => m.type).filter((t) => t !== 'ludo_game_state' || true)
        throw new Error(`${(error as Error).message}; B frames after send: ${JSON.stringify(types)}; since disconnect: ${JSON.stringify(all)}; dom: ${JSON.stringify(dom)}; sent by B since disconnect: ${JSON.stringify(info(bPage).sent.slice(-12).map((m) => m.type))}`)
      }
      await sendPhrase(bPage, 11)
      await waitBubble(aPage, bColor, LUDO_PHRASES[10]!, 8_000)
    })

    await check('[R2] след презареждане на страницата (B) фразите работят; стари балончета не се възпроизвеждат', async () => {
      await sleep(4_700)
      await sendPhrase(aPage, 12)
      await waitBubble(bPage, aColor, LUDO_PHRASES[11]!)
      await bPage.reload()
      await bPage.locator('[data-ludo-cell-pieces]').first().waitFor({ state: 'attached', timeout: 20_000 })
      await sleep(800)
      assert(await bubbleText(bPage, aColor) === null, 'old phrase bubble replayed after reload')
      await sendPhrase(bPage, 13)
      await waitBubble(aPage, bColor, LUDO_PHRASES[12]!, 8_000)
      await sendPhrase(aPage, 14)
      await waitBubble(bPage, aColor, LUDO_PHRASES[13]!, 8_000)
    })

    await aPage.context().close()
    await bPage.context().close()
  }

  console.log('\n' + '═'.repeat(72))
  console.log(`Passed: ${passed}  Failed: ${failed}`)
  if (failed > 0) process.exitCode = 1
} catch (error) {
  process.exitCode = 1
  console.error(error)
  if (server) console.error('--- server output (tail) ---\n' + server.output().split('\n').slice(-60).join('\n'))
} finally {
  await browser.close()
  if (vite) await vite.close()
  if (server && server.child.exitCode === null) {
    server.child.kill('SIGKILL')
    await Promise.race([new Promise((r) => server!.child.once('exit', r)), sleep(3_000)])
  }
  await isolated.cleanup()
}
