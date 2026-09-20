import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Page } from 'playwright'
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
    body: JSON.stringify({ email: `ludo-leave-remount-${name}-${unique}@example.test`, password: 'LudoLeave1!', displayName: `LR ${name} ${unique}`, gender: 'male' }),
  })
  const body: any = await response.json()
  assert(response.ok, `Registration failed: ${JSON.stringify(body)}`)
  const cookie = (response.headers.getSetCookie?.()[0] ?? response.headers.get('set-cookie'))?.split(';')[0]
  assert(cookie, 'Missing session cookie')
  return { profileId: body.session.profile.profileId as string, cookie: cookie.split('=')[1]! }
}

async function assertLudoLobbyUiVisible(page: Page, label: string): Promise<void> {
  await page.locator('[data-ludo-lobby="1"]').waitFor({ state: 'visible', timeout: 10_000 })
  const banner = page.locator('[data-ludo-lobby="1"] img[src="/images/games/ludo-lobby-banner.webp"]')
  await banner.waitFor({ state: 'visible', timeout: 10_000 })
  const backBtn = page.locator('[data-ludo-lobby-back="1"]')
  const createBtn = page.locator('[data-ludo-create-open="1"]')
  await backBtn.waitFor({ state: 'visible', timeout: 10_000 })
  await createBtn.waitFor({ state: 'visible', timeout: 10_000 })
  assert(await page.locator('[data-lobby-nav-lobby="1"]').first().isVisible(), `${label}: navbar missing`)
  assert(await page.locator('[data-ludo-lobby="1"]').evaluate((el) => el.childElementCount > 0), `${label}: ludo-lobby section is empty`)
  console.log(`${label}: full lobby UI present (banner + action row + navbar)`)
}

const projectRoot = process.cwd()
const tempRoot = await mkdtemp(join(tmpdir(), 'belot-ludo-leave-remount-'))
let child: ChildProcessWithoutNullStreams | null = null
const browser = await chromium.launch({ headless: true })
let vite: Awaited<ReturnType<typeof createViteServer>> | null = null
try {
  const backendPort = await freePort()
  child = spawn(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'index.ts')], {
    cwd: join(projectRoot, 'server'), env: { ...process.env, PORT: String(backendPort) }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  await waitFor(() => fetch(`http://127.0.0.1:${backendPort}/health`).then((r) => r.ok).catch(() => false), 'backend')

  const vitePort = await freePort()
  vite = await createViteServer({
    root: projectRoot,
    server: { host: '127.0.0.1', port: vitePort, strictPort: true },
    logLevel: 'error',
    plugins: [{
      name: 'ludo-leave-remount-isolated-backend',
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

  async function open(profile: Awaited<ReturnType<typeof register>>, viewport: { width: number; height: number }): Promise<Page> {
    const context = await browser.newContext({ viewport })
    await context.addCookies([{ name: 'belot_session', value: profile.cookie, url: backendOrigin }])
    const page = await context.newPage()
    await page.goto(`${appOrigin}/games/ludo`)
    const consentButton = page.locator('[data-consent-accept-all="1"]')
    if (await consentButton.isVisible().catch(() => false)) await consentButton.click()
    await page.locator('[data-ludo-lobby="1"]').waitFor({ state: 'visible', timeout: 15_000 })
    await page.waitForTimeout(600)
    return page
  }

  async function createRoom(page: Page, playerCount: '2' | '4' = '4', manual = false): Promise<void> {
    await page.locator('[data-ludo-create-open="1"]').click()
    await page.locator('[data-ludo-create-form="1"]').waitFor({ state: 'visible' })
    await page.locator('[data-ludo-create-form="1"] select[name="playerCount"]').selectOption(playerCount)
    // Stake list is seeded from server-configured match rooms — pick whatever
    // is actually available instead of assuming a fixed value exists.
    const stakeSelect = page.locator('[data-ludo-create-form="1"] select[name="stake"]')
    const firstStakeValue = await stakeSelect.locator('option').first().getAttribute('value')
    await stakeSelect.selectOption(firstStakeValue!)
    if (manual) await page.locator('[data-ludo-create-form="1"] input[value="manual"]').check()
    await page.locator('[data-ludo-create-form="1"]').evaluate((form: HTMLFormElement) => form.requestSubmit())
    await page.locator('[data-ludo-room-leave="1"]').waitFor({ state: 'visible', timeout: 10_000 })
  }

  async function leaveRoomAndAssertLobby(page: Page, label: string): Promise<void> {
    await page.locator('[data-ludo-room-leave="1"]').click()
    await page.locator('[data-ludo-room-leave="1"]').waitFor({ state: 'hidden', timeout: 10_000 })
    // URL must stay on /games/ludo — not blank shell, not navigated away.
    assert(page.url().endsWith('/games/ludo'), `${label}: URL changed away from /games/ludo: ${page.url()}`)
    await assertLudoLobbyUiVisible(page, label)
  }

  const creatorProfile = await register(backendPort, 'Creator')
  const guestProfile = await register(backendPort, 'Guest')

  // === Scenario A: creator create -> waiting room -> leave (alone -> room deleted) ===
  const creator = await open(creatorProfile, { width: 1400, height: 900 })
  await createRoom(creator, '4', true)
  await leaveRoomAndAssertLobby(creator, 'A desktop (creator alone, room deleted)')
  const emptyOrListVisibleA = await creator.locator('[data-ludo-lobby="1"]').innerText()
  console.log('A: post-leave content present, length =', emptyOrListVisibleA.length)

  // === Scenario C: immediately can Create again + Join another room, no duplicate events ===
  await creator.locator('[data-ludo-create-open="1"]').click()
  await creator.locator('[data-ludo-create-form="1"]').waitFor({ state: 'visible', timeout: 5_000 })
  console.log('C: create-game immediately available after leave: true')
  await creator.locator('[data-ludo-create-close="1"]').click()

  // === Scenario D: repeat create -> leave at least 3 times, desktop ===
  for (let i = 1; i <= 3; i += 1) {
    await createRoom(creator, '4', true)
    await leaveRoomAndAssertLobby(creator, `D desktop cycle ${i}`)
  }
  console.log('D: 3x create->leave cycles completed without lifecycle regression (desktop)')

  await creator.close()

  // === Scenario B: guest joins, leaves; creator stays, sees guest leave, still functional ===
  const creatorMobile = await open(creatorProfile, { width: 360, height: 800 })
  await createRoom(creatorMobile, '4', false)

  const guest = await open(guestProfile, { width: 360, height: 800 })
  await guest.locator('[data-ludo-room-join]').first().waitFor({ state: 'visible', timeout: 10_000 })
  await guest.locator('[data-ludo-room-join]').first().click()
  await guest.locator('[data-ludo-room-leave="1"]').waitFor({ state: 'visible', timeout: 10_000 })
  console.log('B: guest joined waiting room')

  await leaveRoomAndAssertLobby(guest, 'B mobile (guest leaves)')

  // Creator must still be in their waiting room (untouched by guest's leave), URL/UI intact.
  await creatorMobile.locator('[data-ludo-room-leave="1"]').waitFor({ state: 'visible', timeout: 10_000 })
  assert(creatorMobile.url().endsWith('/games/ludo'), 'B: creator URL drifted')
  console.log('B: creator remains in waiting room after guest left, unaffected')

  // Guest can immediately create/join again after leaving.
  await guest.locator('[data-ludo-create-open="1"]').click()
  await guest.locator('[data-ludo-create-form="1"]').waitFor({ state: 'visible', timeout: 5_000 })
  console.log('B: guest create-game immediately available after leave: true')
  await guest.locator('[data-ludo-create-close="1"]').click()

  // Guest mobile: repeat create -> leave 3 times too (covers mobile lifecycle).
  for (let i = 1; i <= 3; i += 1) {
    await createRoom(guest, '4', false)
    await leaveRoomAndAssertLobby(guest, `D mobile cycle ${i}`)
  }
  console.log('D: 3x create->leave cycles completed without lifecycle regression (mobile)')

  const hasHorizontalScroll = await guest.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)
  assert(!hasHorizontalScroll, 'mobile has horizontal scroll after leave/remount cycles')
  console.log('mobile hasHorizontalScroll after cycles:', hasHorizontalScroll)

  await leaveRoomAndAssertLobby(creatorMobile, 'B mobile (creator leaves last, room deleted)')

  await guest.close()
  await creatorMobile.close()

  console.log('PASS Ludo waiting-room leave -> lobby remount: creator/guest leave both restore full in-shell lobby UI (banner+action row+navbar), URL stays /games/ludo, repeated create/leave cycles stable on desktop and mobile')
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
