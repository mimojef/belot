import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium, type BrowserContext, type Page } from 'playwright'
import { createServer as createViteServer } from 'vite'

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))
const assert = (condition: unknown, message: string): asserts condition => { if (!condition) throw new Error(message) }
const freePort = () => new Promise<number>((done, fail) => {
  const server = createNetServer().once('error', fail).listen(0, '127.0.0.1', () => {
    const address = server.address()
    if (!address || typeof address === 'string') return fail(new Error('No free port'))
    server.close(() => done(address.port))
  })
})
async function waitFor(predicate: () => Promise<boolean>, label: string, timeout = 30_000): Promise<void> {
  const expires = Date.now() + timeout
  while (Date.now() < expires) {
    if (await predicate()) return
    await sleep(75)
  }
  throw new Error(`Timeout: ${label}`)
}
async function register(port: number, name: string) {
  const unique = `${Date.now()}${Math.random().toString(36).slice(2, 8)}`
  const response = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `ludo-end-real-${name}-${unique}@example.test`, password: 'LudoEndReal1!', displayName: `LE ${name} ${unique}`, gender: 'male' }),
  })
  const body: any = await response.json()
  assert(response.ok, `Registration failed: ${JSON.stringify(body)}`)
  const cookie = (response.headers.getSetCookie?.()[0] ?? response.headers.get('set-cookie'))?.split(';')[0]
  assert(cookie, 'Missing session cookie')
  return { profileId: body.session.profile.profileId as string, cookie: cookie.split('=')[1]! }
}

const projectRoot = process.cwd()
const pageTraces = new WeakMap<Page, { sent: any[]; received: any[] }>()
const tempRoot = await mkdtemp(join(tmpdir(), 'belot-ludo-end-real-'))
const serverDir = join(tempRoot, 'server')
let child: ChildProcessWithoutNullStreams | null = null
const browser = await chromium.launch({ headless: true })
let vite: Awaited<ReturnType<typeof createViteServer>> | null = null
try {
  await mkdir(serverDir, { recursive: true })
  await cp(resolve(projectRoot, 'server/src'), join(serverDir, 'src'), { recursive: true })
  await cp(resolve(projectRoot, 'server/dist'), join(serverDir, 'dist'), { recursive: true })
  await cp(resolve(projectRoot, 'server/database/migrations'), join(serverDir, 'database/migrations'), { recursive: true })
  await cp(resolve(projectRoot, 'server/package.json'), join(serverDir, 'package.json'))
  await mkdir(join(serverDir, 'database/data'), { recursive: true })
  await symlink(resolve(projectRoot, 'server/node_modules'), join(serverDir, 'node_modules'), 'junction')
  await symlink(resolve(projectRoot, 'node_modules'), join(tempRoot, 'node_modules'), 'junction')

  const runtimePath = join(serverDir, 'src/game/ludoMatchRuntime.ts')
  let runtimeSource = await readFile(runtimePath, 'utf8')
  runtimeSource = runtimeSource.replace(
    'export function createLudoMatchRuntime(options: Options) {',
    `let realBrowserStateCount = 0
function createRealBrowserNearWinState(turnOrder: readonly LudoColor[]): LudoGameState {
  const state = createLudoAuthoritativeInitialState(turnOrder)
  if (realBrowserStateCount++ >= 2) return state
  const target = turnOrder[0]!
  return {
    ...state,
    pieces: state.pieces.map((piece) => piece.color === target
      ? { ...piece, position: { kind: 'finish' as const, finishIndex: piece.slot === 0 ? 4 : 5 } }
      : piece),
  }
}

export function createLudoMatchRuntime(options: Options) {`,
  ).replace(
    'const randomDie = options.randomDie ?? (() => (Math.floor(Math.random() * 6) + 1) as LudoDiceValue)',
    'let realBrowserDieCount = 0\n  const randomDie = options.randomDie ?? (() => (realBrowserDieCount++ === 0 ? 1 : 6) as LudoDiceValue)',
  ).replace(
    'options.initialStateFactory?.(turnOrder) ?? createLudoAuthoritativeInitialState(turnOrder)',
    'options.initialStateFactory?.(turnOrder) ?? createRealBrowserNearWinState(turnOrder)',
  )
  assert(runtimeSource.includes('function createRealBrowserNearWinState'), 'Failed to inject real-browser near-win state')
  assert(runtimeSource.includes('realBrowserDieCount++ === 0 ? 1 : 6'), 'Failed to force real-browser die sequence')
  assert(runtimeSource.includes('options.initialStateFactory?.(turnOrder) ?? createRealBrowserNearWinState(turnOrder)'), 'Failed to install real-browser near-win state')
  await writeFile(runtimePath, runtimeSource, 'utf8')

  const backendPort = await freePort()
  const serverOutput: string[] = []
  child = spawn(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'index.ts')], {
    cwd: serverDir, env: { ...process.env, PORT: String(backendPort) }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => serverOutput.push(String(chunk)))
  child.stderr.on('data', (chunk) => serverOutput.push(String(chunk)))
  await waitFor(() => fetch(`http://127.0.0.1:${backendPort}/health`).then((response) => response.ok).catch(() => false), 'backend')
  const vitePort = await freePort()
  vite = await createViteServer({
    root: projectRoot,
    server: { host: '127.0.0.1', port: vitePort, strictPort: true },
    logLevel: 'error',
    plugins: [{
      name: 'ludo-real-browser-isolated-backend',
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

  async function open(profile: Awaited<ReturnType<typeof register>>, viewport: { width: number; height: number }): Promise<{ context: BrowserContext; page: Page }> {
    const context = await browser.newContext({ viewport })
    await context.addCookies([{ name: 'belot_session', value: profile.cookie, url: backendOrigin }])
    await context.addInitScript(() => {
      const Native = window.WebSocket
      const trace: { sent: any[]; received: any[] } = { sent: [], received: [] }
      ;(window as any).__ludoWsTrace = trace
      class TracedSocket extends Native {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols)
          this.addEventListener('message', (event) => { try { trace.received.push(JSON.parse(String(event.data))) } catch {} })
        }
        send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
          try { trace.sent.push(JSON.parse(String(data))) } catch {}
          super.send(data)
        }
      }
      window.WebSocket = TracedSocket
    })
    const page = await context.newPage()
    const transportTrace = { sent: [] as any[], received: [] as any[] }
    pageTraces.set(page, transportTrace)
    page.on('websocket', (socket) => {
      socket.on('framesent', (event) => { try { transportTrace.sent.push(JSON.parse(String(event.payload))) } catch {} })
      socket.on('framereceived', (event) => { try { transportTrace.received.push(JSON.parse(String(event.payload))) } catch {} })
    })
    await page.goto(`${appOrigin}/games/ludo`)
    const consentButton = page.locator('[data-consent-accept-all="1"]')
    if (await consentButton.isVisible()) {
      await consentButton.evaluate((button: HTMLButtonElement) => button.click())
      await page.locator('[data-consent-banner="1"]').waitFor({ state: 'hidden' })
    }
    await page.locator('[data-ludo-lobby="1"]').waitFor({ state: 'visible', timeout: 30_000 })
    return { context, page }
  }
  async function createAndStart(creator: Page, second: Page): Promise<void> {
    await creator.locator('[data-ludo-create-open="1"]').click()
    await creator.locator('[data-ludo-create-form="1"] select[name="playerCount"]').selectOption('2')
    await creator.locator('[data-ludo-create-form="1"] select[name="stake"]').selectOption('5000')
    await creator.locator('[data-ludo-create-form="1"]').evaluate((form: HTMLFormElement) => form.requestSubmit())
    await second.locator('[data-ludo-room-join]').waitFor({ state: 'visible' })
    await second.locator('[data-ludo-room-join]').first().click()
    await Promise.all([creator, second].map((page) => page.locator('[data-ludo-overlay-root="1"] [data-ludo-board="1"]').waitFor({ state: 'visible', timeout: 15_000 })))
  }
  async function assertModalAboveGameplay(page: Page, backdropSelector: string, label: string): Promise<void> {
    const result = await page.evaluate((selector) => {
      const modalLayer = document.querySelector<HTMLElement>('[data-ludo-modal-layer="1"]')
      const backdrop = document.querySelector<HTMLElement>(selector)
      const gameRoot = document.querySelector<HTMLElement>('[data-ludo-overlay-root="1"]')
      const gameplay = Array.from(document.querySelectorAll<HTMLElement>(
        '[data-ludo-dice-flight], [data-ludo-capture-flight], [data-ludo-capture-impact]',
      ))
      const gameplayZ: number[] = []
      for (const element of gameplay) gameplayZ.push(Number.parseInt(getComputedStyle(element).zIndex, 10) || 0)
      const centerTop = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2)
      const centerGameRoot = centerTop?.closest<HTMLElement>('[data-ludo-overlay-root="1"]') ?? null
      const centerAttributes: string[] = []
      if (centerTop instanceof HTMLElement) {
        for (const attribute of Array.from(centerTop.attributes)) centerAttributes.push(`${attribute.name}=${attribute.value}`)
      }
      return {
        modalZ: modalLayer ? Number.parseInt(getComputedStyle(modalLayer).zIndex, 10) || 0 : -1,
        modalLayerCount: document.querySelectorAll('[data-ludo-modal-layer="1"]').length,
        gameRootCount: document.querySelectorAll('[data-ludo-overlay-root="1"]').length,
        gameZ: gameRoot ? Number.parseInt(getComputedStyle(gameRoot).zIndex, 10) || 0 : -1,
        centerGameRootZ: centerGameRoot ? Number.parseInt(getComputedStyle(centerGameRoot).zIndex, 10) || 0 : null,
        gameplayZ,
        backdropPointerEvents: backdrop ? getComputedStyle(backdrop).pointerEvents : null,
        backdropDisplay: backdrop ? getComputedStyle(backdrop).display : null,
        backdropVisibility: backdrop ? getComputedStyle(backdrop).visibility : null,
        backdropZ: backdrop ? Number.parseInt(getComputedStyle(backdrop).zIndex, 10) || 0 : null,
        backdropRect: backdrop ? backdrop.getBoundingClientRect().toJSON() : null,
        backdropParentPointerEvents: backdrop?.parentElement ? getComputedStyle(backdrop.parentElement).pointerEvents : null,
        backdropParentZ: backdrop?.parentElement ? Number.parseInt(getComputedStyle(backdrop.parentElement).zIndex, 10) || 0 : null,
        backdropOwnsCenter: Boolean(backdrop && centerTop && backdrop.contains(centerTop)),
        centerTop: centerTop instanceof HTMLElement ? { tag: centerTop.tagName, attributes: centerAttributes } : null,
      }
    }, backdropSelector)
    assert(result.modalZ > result.gameZ, `${label}: modal layer is not above game root: ${JSON.stringify(result)}`)
    assert(result.gameplayZ.every((zIndex) => result.modalZ > zIndex), `${label}: gameplay overlay is above modal: ${JSON.stringify(result)}`)
    assert(result.backdropOwnsCenter, `${label}: modal does not own center hit-test: ${JSON.stringify(result)}`)
  }
  async function assertEnded(page: Page, expectedText: string, label: string): Promise<void> {
    const popup = page.locator('[data-ludo-game-end-backdrop="1"]')
    await popup.waitFor({ state: 'visible', timeout: 15_000 })
    assert((await popup.textContent())?.includes(expectedText), `${label}: wrong popup`)
    await assertModalAboveGameplay(page, '[data-ludo-game-end-backdrop="1"]', label)
    const trace = pageTraces.get(page)!
    const leaveCountBefore = trace.sent.filter((frame: any) => frame.type === 'leave_ludo_match').length
    await page.locator('[data-ludo-game-end-dismiss="1"]').click()
    await page.waitForURL('**/games')
    assert(await page.locator('[data-ludo-overlay-root="1"]').count() === 0, `${label}: board remained after OK`)
    const leaves = trace.sent.filter((frame: any) => frame.type === 'leave_ludo_match')
    assert(leaves.length === leaveCountBefore + 1, `${label}: cleanup frame count mismatch`)
    const cleanupMatchId = leaves.at(-1)?.matchId
    assert(typeof cleanupMatchId === 'string' && cleanupMatchId.length > 0, `${label}: invalid cleanup frame`)
    await page.waitForTimeout(250)
    const outcomes = trace.received.filter((frame: any) => frame.type === 'ludo_match_left' || frame.type === 'error')
    assert(outcomes.some((frame: any) => frame.type === 'ludo_match_left' && frame.matchId === cleanupMatchId), `${label}: no cleanup ack; outcomes=${JSON.stringify(outcomes)}`)
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForTimeout(500)
    assert(await page.locator('[data-ludo-overlay-root="1"]').count() === 0, `${label}: board restored after refresh`)
  }

  const p1 = await register(backendPort, 'Winner')
  const p2 = await register(backendPort, 'Loser')
  const winner = await open(p1, { width: 1280, height: 850 })
  const loser = await open(p2, { width: 390, height: 844 })
  await createAndStart(winner.page, loser.page)
  await winner.page.locator('[data-ludo-dice-roll-button="1"]').click()
  try {
    await winner.page.locator('[data-ludo-piece-selectable="1"]').first().waitFor({ state: 'visible', timeout: 10_000 })
  } catch (error) {
    const trace = pageTraces.get(winner.page)!
    const boardText = await winner.page.locator('[data-ludo-overlay-root="1"]').innerText().catch(() => '<missing overlay>')
    throw new Error(`No selectable pawn after real UI roll. trace=${JSON.stringify(trace)} board=${JSON.stringify(boardText)}`, { cause: error })
  }
  await winner.page.locator('[data-ludo-piece-selectable="1"]').first().click()
  await Promise.all([
    assertEnded(winner.page, 'Вие сте победител в играта!', 'normal winner'),
    assertEnded(loser.page, 'Вие загубихте играта.', 'normal loser'),
  ])

  await Promise.all([winner.page.goto(`${appOrigin}/games/ludo`), loser.page.goto(`${appOrigin}/games/ludo`)])
  await Promise.all([winner.page, loser.page].map((page) => page.locator('[data-ludo-lobby="1"]').waitFor({ state: 'visible', timeout: 30_000 })))
  await createAndStart(winner.page, loser.page)

  const desktopTrace = pageTraces.get(winner.page)!
  const desktopLeavesBefore = desktopTrace.sent.filter((frame: any) => frame.type === 'leave_ludo_match').length
  await winner.page.locator('[data-ludo-dice-roll-button="1"]').click()
  await winner.page.locator('[data-ludo-dice-flight="1"]').waitFor({ state: 'visible', timeout: 5_000 })
  await winner.page.locator('[data-ludo-exit-button="1"]').click()
  const desktopExitPopup = winner.page.locator('[data-ludo-exit-confirm-backdrop="1"]')
  await desktopExitPopup.waitFor({ state: 'visible' })
  await assertModalAboveGameplay(winner.page, '[data-ludo-exit-confirm-backdrop="1"]', 'desktop exit over dice')
  assert((await desktopExitPopup.innerText()).replace(/\s+/g, ' ').includes('5 000 жълтици'), 'desktop exit popup did not show authoritative 5 000 stake')
  await winner.page.locator('[data-ludo-exit-confirm-cancel="1"]').click()
  assert(await desktopExitPopup.count() === 0, 'desktop cancel did not close exit popup')
  assert(await winner.page.locator('[data-ludo-overlay-root="1"]').count() === 1, 'desktop cancel closed the game')
  assert(desktopTrace.sent.filter((frame: any) => frame.type === 'leave_ludo_match').length === desktopLeavesBefore, 'desktop cancel sent leave_ludo_match')

  const mobileTrace = pageTraces.get(loser.page)!
  const mobileLeavesBefore = mobileTrace.sent.filter((frame: any) => frame.type === 'leave_ludo_match').length
  await loser.page.locator('[data-ludo-exit-button="1"]').click()
  const mobileExitPopup = loser.page.locator('[data-ludo-exit-confirm-backdrop="1"]')
  await mobileExitPopup.waitFor({ state: 'visible' })
  assert((await mobileExitPopup.innerText()).replace(/\s+/g, ' ').includes('5 000 жълтици'), 'mobile exit popup did not show authoritative 5 000 stake')
  await loser.page.locator('[data-ludo-exit-confirm-submit="1"]').evaluate((button: HTMLButtonElement) => {
    button.click()
    button.click()
  })
  await loser.page.waitForURL('**/games')
  assert(mobileTrace.sent.filter((frame: any) => frame.type === 'leave_ludo_match').length === mobileLeavesBefore + 1, 'mobile double confirm did not send exactly one leave_ludo_match')
  await assertEnded(winner.page, 'Вие сте победител в играта!', 'forfeit winner')

  const takeoverA = await register(backendPort, 'TakeoverA')
  const takeoverB = await register(backendPort, 'TakeoverB')
  const takeoverHost = await open(takeoverA, { width: 1280, height: 850 })
  const takeoverGuest = await open(takeoverB, { width: 390, height: 844 })
  await createAndStart(takeoverHost.page, takeoverGuest.page)
  await takeoverGuest.context.close()
  await sleep(250)
  const reconnectedGuest = await open(takeoverB, { width: 390, height: 844 })
  await reconnectedGuest.page.locator('[data-ludo-overlay-root="1"] [data-ludo-board="1"]').waitFor({ state: 'visible', timeout: 15_000 })
  await reconnectedGuest.page.locator('[data-ludo-bot-takeover-backdrop="1"]').waitFor({ state: 'visible', timeout: 15_000 })
  await sleep(4_500)
  await assertModalAboveGameplay(reconnectedGuest.page, '[data-ludo-bot-takeover-backdrop="1"]', 'mobile bot takeover')

  const setPageVisibility = (page: Page, state: 'hidden' | 'visible') => page.evaluate((nextState) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: nextState })
    document.dispatchEvent(new Event('visibilitychange'))
  }, state)
  const latestRevision = (page: Page) => {
    const frames = pageTraces.get(page)?.received ?? []
    let revision = -1
    for (const frame of frames) {
      if ((frame.type === 'ludo_game_state' || frame.type === 'ludo_game_started') && typeof frame.snapshot?.revision === 'number') {
        revision = Math.max(revision, frame.snapshot.revision)
      }
    }
    return revision
  }
  const hiddenStartRevision = latestRevision(reconnectedGuest.page)
  await setPageVisibility(reconnectedGuest.page, 'hidden')
  const catchUpDeadline = Date.now() + 35_000
  while (latestRevision(reconnectedGuest.page) < hiddenStartRevision + 10 && Date.now() < catchUpDeadline) {
    const hostRoll = takeoverHost.page.locator('[data-ludo-dice-roll-button="1"]')
    const hostMove = takeoverHost.page.locator('[data-ludo-piece-selectable="1"]').first()
    if (await hostRoll.isVisible().catch(() => false)) await hostRoll.evaluate((element: HTMLElement) => element.click()).catch(() => undefined)
    else if (await hostMove.isVisible().catch(() => false)) await hostMove.evaluate((element: HTMLElement) => element.click()).catch(() => undefined)
    await sleep(100)
  }
  const hiddenEndRevision = latestRevision(reconnectedGuest.page)
  assert(hiddenEndRevision >= hiddenStartRevision + 10, `real hidden client received only ${hiddenEndRevision - hiddenStartRevision} revisions`)
  const refreshCountBefore = pageTraces.get(reconnectedGuest.page)!.sent.filter((frame: any) => frame.type === 'ludo_game_state_request').length
  await setPageVisibility(reconnectedGuest.page, 'visible')
  await waitFor(async () => pageTraces.get(reconnectedGuest.page)!.sent.filter((frame: any) => frame.type === 'ludo_game_state_request').length > refreshCountBefore, 'foreground state refresh')
  await sleep(150)
  const catchUpOverlays = await reconnectedGuest.page.evaluate(() => ({
    dice: document.querySelectorAll('[data-ludo-dice-flight]').length,
    moving: document.querySelectorAll('[data-ludo-moving-piece], [data-ludo-move-trail]').length,
    capture: document.querySelectorAll('[data-ludo-capture-flight], [data-ludo-capture-impact]').length,
  }))
  assert(JSON.stringify(catchUpOverlays) === JSON.stringify({ dice: 0, moving: 0, capture: 0 }), `real foreground replayed historical overlays: ${JSON.stringify(catchUpOverlays)}`)
  await sleep(1_100)
  assert(await reconnectedGuest.page.locator('[data-ludo-dice-flight], [data-ludo-moving-piece], [data-ludo-capture-flight], [data-ludo-capture-impact]').count() === 0, 'stale real overlay appeared after foreground snap')

  await reconnectedGuest.page.locator('[data-ludo-bot-takeover-dismiss="1"]').click()
  await reconnectedGuest.page.locator('[data-ludo-bot-takeover-backdrop="1"]').waitFor({ state: 'hidden', timeout: 10_000 })
  let sawPostReclaimAnimation = false
  const postReclaimDeadline = Date.now() + 35_000
  while (!sawPostReclaimAnimation && Date.now() < postReclaimDeadline) {
    const guestRoll = reconnectedGuest.page.locator('[data-ludo-dice-roll-button="1"]')
    const guestMove = reconnectedGuest.page.locator('[data-ludo-piece-selectable="1"]').first()
    const hostRoll = takeoverHost.page.locator('[data-ludo-dice-roll-button="1"]')
    const hostMove = takeoverHost.page.locator('[data-ludo-piece-selectable="1"]').first()
    const hostReclaim = takeoverHost.page.locator('[data-ludo-bot-takeover-dismiss="1"]')
    if (await hostReclaim.isVisible().catch(() => false)) {
      await hostReclaim.click()
    } else if (await guestRoll.isVisible().catch(() => false)) {
      await guestRoll.click()
      await reconnectedGuest.page.locator('[data-ludo-dice-flight="1"]').waitFor({ state: 'attached', timeout: 5_000 })
      sawPostReclaimAnimation = true
    } else if (await guestMove.isVisible().catch(() => false)) {
      await guestMove.click()
      sawPostReclaimAnimation = await reconnectedGuest.page.locator('[data-ludo-moving-piece]').waitFor({ state: 'attached', timeout: 1_000 }).then(() => true).catch(() => false)
    } else if (await hostRoll.isVisible().catch(() => false)) await hostRoll.evaluate((element: HTMLElement) => element.click()).catch(() => undefined)
    else if (await hostMove.isVisible().catch(() => false)) await hostMove.evaluate((element: HTMLElement) => element.click()).catch(() => undefined)
    await sleep(100)
  }
  assert(sawPostReclaimAnimation, 'real reclaimed player did not animate a new roll')
  await takeoverHost.context.close()
  await reconnectedGuest.context.close()

  console.log('PASS real Ludo UI: modal layering plus 10+ hidden revisions snap without replay; post-reclaim live roll animates')
  await winner.context.close()
  await loser.context.close()
} catch (error) {
  throw error
} finally {
  await browser.close()
  if (vite) await vite.close()
  if (child && child.exitCode === null) {
    child.kill('SIGTERM')
    await Promise.race([new Promise((done) => child!.once('exit', done)), sleep(3_000)])
    if (child.exitCode === null) child.kill('SIGKILL')
  }
  await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined)
}
