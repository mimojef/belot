/**
 * checkPrivateRoomPartnerInviteUi.ts
 *
 * "Покани партньор" — реален backend (изолирано копие) + реален Vite dev
 * server + реален Chromium (Playwright), десктоп и телефон.
 *
 * Covers:
 *  [C]  формата "Нова маса": чекбокс "Покани партньор", изключен по
 *       подразбиране; стойността стига до onPrivateRoomCreate.
 *  [R]  домакинът вижда "Покани партньор" на A1; друг член вижда некликаемо
 *       "Място с покана"; ботът не може да се добави в отбор А.
 *  [P]  picker: търсачка, ред свободни онлайн → играещи → офлайн, "Играе",
 *       играещите/офлайн не могат да бъдат поканени; филтърът не губи фокуса;
 *       скролът на списъка оцелява при несвързан re-render.
 *  [I]  покана → "Поканихте Х" (без втора покана) + "Отмени поканата";
 *       поканеният вижда "Х ви кани за партньор в частна маса" с Приеми/Откажи.
 *  [B]/[L] приятел без жълтици / с недостатъчно ниво → покана не се
 *       създава, прозорец с текста от сървъра и "ОК"; резервацията остава.
 *  [X]  "Отмени поканата" → известието при поканения изчезва.
 *  [A]  "Приеми" → поканеният е в чакалнята на A1.
 *  [M]  на телефон (390px) няма хоризонтален overflow в чакалнята/picker-а.
 *  [G]  глобално известие към домакина, докато е в "Теми": отказ → текст +
 *       "Покани друг"/"Освободи мястото", не блокира и не се скрива само,
 *       оцелява refresh, "Покани друг" отваря списъка, нова покана не мести
 *       крайния срок, "Освободи мястото" маха резервацията.
 *  [mn/mp] маса с ръчен старт (без/с поканен партньор), домакинът в "Теми":
 *       4/4 → "Създадената от теб маса се запълни..." + "Към масата"; не се
 *       дублира; refresh; напускане и повторно запълване; без popup в
 *       чакалнята; краен срок; старт на мача. [AS] автоматичен старт — без.
 *  [S1] и навсякъде: появата/изчезването на известие не прерисува "Теми"
 *       (същият DOM възел) и не мести скрола.
 *  [H]  приемане в "Теми" → "прие поканата ти" само с "ОК"; refresh не го връща;
 *       краен срок на масата скрива известието; старт на мача го премахва.
 */

import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { verifyVerificationCode } from '../server/src/db/authHelpers.js'

const TEST_REGISTRATION_SECRET = 'private-room-partner-ui-registration-secret-0123456789'
const STAKE = 5000
let testDatabaseFile = ''

let passed = 0
let failed = 0

async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`  PASS  ${label}`)
  } catch (err) {
    failed++
    console.error(`  FAIL  ${label}: ${err instanceof Error ? err.message : String(err)}`)
  }
}
function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function findFreePort(): Promise<number> {
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
    await sleep(100)
  }
  throw new Error(`Timeout: ${label}`)
}

let testIpCounter = 0
// Различен IP на заявка — регистрациите/верификациите са rate-limited по IP.
const nextTestIp = () => `203.0.117.${(testIpCounter = (testIpCounter % 250) + 1)}`

async function httpJson(port: number, method: string, pathname: string, cookie: string | null, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method, headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': nextTestIp(), ...(cookie ? { Cookie: cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const setCookie = (res.headers.getSetCookie?.()[0] ?? res.headers.get('set-cookie'))?.split(';')[0] ?? null
  let json: any = null
  try { json = await res.json() } catch { /* not json */ }
  return { status: res.status, body: json, setCookie }
}

function withDb<T>(fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(testDatabaseFile, { open: true, timeout: 5_000 })
  try { return fn(db) } finally { db.close() }
}

function setWalletBalance(profileId: string, amount: number): void {
  withDb((db) => {
    db.prepare('UPDATE profile_wallets SET yellow_coins_balance = ? WHERE profile_id = ?').run(amount, profileId)
  })
}

type Profile = { cookie: string; profileId: string; displayName: string }

async function registerProfile(port: number, tag: string): Promise<Profile> {
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const displayName = `PU ${tag}`
  const reg = await httpJson(port, 'POST', '/api/auth/register', null, {
    email: `partner-ui-${tag.replace(/ /g, '-')}-${runId}@example.test`,
    password: 'PartnerUiDiag1!',
    displayName,
    gender: 'male',
    visitorId: randomUUID(),
  })
  const pendingRegistrationId: string | undefined = reg.body?.pendingRegistrationId
  if (!pendingRegistrationId) throw new Error(`Registration failed for ${tag}: ${JSON.stringify(reg.body)}`)
  const row = withDb((db) => db.prepare('SELECT code_hash FROM pending_registrations WHERE pending_registration_id = ?').get(pendingRegistrationId) as { code_hash: string })
  let code = ''
  for (let candidate = 0; candidate < 1_000_000; candidate++) {
    const c = candidate.toString().padStart(6, '0')
    if (verifyVerificationCode(c, TEST_REGISTRATION_SECRET, row.code_hash)) { code = c; break }
  }
  const verifyBody = { pendingRegistrationId, code, rememberMe: true }
  let verified: Awaited<ReturnType<typeof httpJson>>
  try {
    verified = await httpJson(port, 'POST', '/api/auth/verify-registration-email', null, verifyBody)
  } catch {
    await sleep(200)
    verified = await httpJson(port, 'POST', '/api/auth/verify-registration-email', null, verifyBody)
  }
  if (verified.status !== 200) throw new Error(`Email verification failed for ${tag}: ${JSON.stringify(verified.body)}`)
  const profileId = verified.body.session.profile.profileId
  withDb((db) => {
    const res = db.prepare('UPDATE profile_wallets SET yellow_coins_balance = ? WHERE profile_id = ?').run(100_000, profileId)
    if (Number(res.changes) === 0) db.prepare('INSERT INTO profile_wallets (profile_id, yellow_coins_balance) VALUES (?, ?)').run(profileId, 100_000)
  })
  return { cookie: verified.setCookie as string, profileId, displayName }
}

async function makeFriends(port: number, a: Profile, b: Profile): Promise<void> {
  const req = await httpJson(port, 'POST', '/api/friends/request', a.cookie, { profileId: b.profileId })
  if (req.body?.ok !== true) throw new Error(`friend request failed: ${JSON.stringify(req.body)}`)
  const list = await httpJson(port, 'GET', '/api/friends', b.cookie)
  const incoming = list.body.friendships.incomingPending.find((f: any) => f.profile?.profileId === a.profileId)
  const acc = await httpJson(port, 'POST', `/api/friends/${incoming.friendshipId}/accept`, b.cookie)
  if (acc.body?.ok !== true) throw new Error(`friend accept failed: ${JSON.stringify(acc.body)}`)
}

const sourceServerRoot = resolve(process.cwd(), 'server')

async function retryRm(path: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try { await rm(path, { recursive: true, force: true }); return } catch { /* retry */ }
    await sleep(250)
  }
}

async function createIsolatedServerRoot(originalServerRoot: string) {
  const root = await mkdtemp(join(tmpdir(), 'belot-partner-ui-'))
  const serverDir = join(root, 'server')
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
    { cwd: serverDir, env: { ...process.env, PORT: String(port), PASSWORD_RESET_RATE_LIMIT_SECRET: TEST_REGISTRATION_SECRET }, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (c) => chunks.push(c))
  child.stderr.on('data', (c) => chunks.push(c))
  return { child, output: () => chunks.join('') }
}

async function stopServer(server: RunningServer | null): Promise<void> {
  if (!server || server.child.exitCode !== null) return
  server.child.kill('SIGTERM')
  await new Promise<void>((r) => {
    const t = setTimeout(() => { server.child.kill('SIGKILL'); r() }, 10_000)
    server.child.once('exit', () => { clearTimeout(t); r() })
  })
}

console.log('\ncheckPrivateRoomPartnerInviteUi\n')

let server: RunningServer | null = null
let vite: ViteDevServer | null = null
let browser: Browser | null = null
const isolated = await createIsolatedServerRoot(sourceServerRoot)
testDatabaseFile = join(isolated.serverDir, 'database', 'data', 'belot-v2.sqlite')

try {
  const backendPort = await findFreePort()
  server = startServer(isolated.serverDir, backendPort)
  try {
    await waitForCondition('backend health', async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${backendPort}/health`)
        const h = await r.json()
        return r.status === 200 && h.ok === true && h.gameWorkerLifecycle?.state === 'ready'
      } catch { return false }
    }, 30_000)
  } catch (err) {
    console.error(server.output())
    throw err
  }

  const vitePort = await findFreePort()
  vite = await createViteServer({ root: process.cwd(), server: { port: vitePort, strictPort: true, host: '127.0.0.1' }, logLevel: 'error' })
  await vite.listen()
  console.log('Backend + Vite ready.\n')

  const backendOrigin = `http://127.0.0.1:${backendPort}`
  const wsUrl = `ws://127.0.0.1:${backendPort}/ws`
  const viteOrigin = `http://127.0.0.1:${vitePort}`
  browser = await chromium.launch()

  type Party = { context: BrowserContext; page: Page; profile: Profile }

  async function openParty(profile: Profile, viewport: { width: number; height: number }): Promise<Party> {
    const context = await browser!.newContext({ viewport, hasTouch: viewport.width < 600, isMobile: viewport.width < 600 })
    const [name, value] = profile.cookie.split('=') as [string, string]
    await context.addCookies([{ name, value, url: backendOrigin }])
    const page = await context.newPage()
    const pageErrors: string[] = []
    page.on('pageerror', (e) => pageErrors.push(e.message))
    await page.goto(`${viteOrigin}/scripts/fixtures/privateRoomPartnerInviteHarness.html`)
    await page.waitForFunction(() => (window as any).__partnerHarness !== undefined, undefined, { timeout: 15_000 })
    await page.evaluate(({ profileId, displayName }) => (window as any).__partnerHarness.setLocalProfile(profileId, displayName), profile)
    await page.evaluate((url) => (window as any).__partnerHarness.connect(url), wsUrl)
    if (pageErrors.length > 0) throw new Error(`page errors: ${pageErrors.join(' | ')}`)
    return { context, page, profile }
  }

  async function enterOwnWaitingRoom(party: Party, roomId: string): Promise<void> {
    await party.page.evaluate(() => (window as any).__partnerHarness.controller.navigateToPrivateRooms())
    await party.page.locator(`[data-private-room-list-enter="${roomId}"]`).waitFor({ state: 'visible', timeout: 5_000 })
    await party.page.click(`[data-private-room-list-enter="${roomId}"]`)
    await party.page.waitForFunction(() => (window as any).__partnerHarness.getCurrentScreen() === 'private-room-waiting', null, { timeout: 5_000 })
  }

  async function noHorizontalOverflow(page: Page): Promise<boolean> {
    return page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)
  }

  async function runFlow(label: string, viewport: { width: number; height: number }): Promise<void> {
    console.log(`--- ${label} (${viewport.width}x${viewport.height}) ---`)
    const hostP = await registerProfile(backendPort, `${label} host`)
    const friendP = await registerProfile(backendPort, `${label} friend`)
    const oppP = await registerProfile(backendPort, `${label} opp`)
    const poorP = await registerProfile(backendPort, `${label} poor`)
    await makeFriends(backendPort, hostP, friendP)
    await makeFriends(backendPort, hostP, poorP)
    // Онлайн приятел без достатъчно жълтици за входа.
    setWalletBalance(poorP.profileId, STAKE - 1)

    const host = await openParty(hostP, viewport)
    const friend = await openParty(friendP, viewport)
    const opp = await openParty(oppP, viewport)
    const poor = await openParty(poorP, viewport)

    // Реални приятели от сървъра + синтетични "играе"/"офлайн" + пълнеж за скрол.
    const friendsRes = await httpJson(backendPort, 'GET', '/api/friends', hostP.cookie)
    const realFriend = friendsRes.body.friendships.friends.find((f: any) => f.profile.profileId === friendP.profileId)
    assert(realFriend?.isOnline === true, 'real friend must be online')
    const realPoor = friendsRes.body.friendships.friends.find((f: any) => f.profile.profileId === poorP.profileId)
    assert(realPoor?.isOnline === true, 'poor friend must be online')
    const synthetic = (id: string, name: string, isOnline: boolean, isInGame: boolean) => ({
      ...realFriend,
      friendshipId: `fs-${id}`,
      profile: { ...realFriend.profile, profileId: `synthetic-${id}`, displayName: name },
      isOnline,
      isInGame,
    })
    const fillers = Array.from({ length: 30 }, (_, i) => synthetic(`off-${i}`, `Яна Офлайн ${String(i).padStart(2, '0')}`, false, false))
    const friendsForPicker = [
      ...fillers,
      synthetic('playing', 'Борис Играе', true, true),
      synthetic('offline', 'Ася Офлайн', false, false),
      realFriend,
      realPoor,
    ]
    await host.page.evaluate((friends) => (window as any).__partnerHarness.setFriendships(friends), friendsForPicker)

    // ─── [C] Реалната форма "Нова маса" ──────────────────────────────────────
    await host.page.evaluate(() => (window as any).__partnerHarness.openCreatePopup())
    await host.page.waitForSelector('[data-private-room-create-form="1"]', { state: 'visible', timeout: 10_000 })

    await check(`${label} [C1] чекбокс "Покани партньор" съществува и е изключен по подразбиране`, async () => {
      const box = host.page.locator('[data-private-room-invite-partner-checkbox="1"]')
      assert(await box.count() === 1, 'checkbox missing')
      assert(!(await box.isChecked()), 'checkbox must be unchecked by default')
      const text = await host.page.locator('[data-private-room-create-form="1"]').textContent()
      assert((text ?? '').includes('Покани партньор'), 'label missing')
    })

    await host.page.locator('[data-private-room-invite-partner-checkbox="1"]').check()
    await host.page.locator('[data-private-room-create-form="1"] button[type="submit"]').click()

    await check(`${label} [C2] включен чекбокс → create_private_room{invitePartner:true} → чакалня с резервирано A1`, async () => {
      await host.page.waitForFunction(() => (window as any).__partnerHarness.getCurrentScreen() === 'private-room-waiting', null, { timeout: 10_000 })
      const sent = await host.page.evaluate(() => (window as any).__partnerHarness.getSentFrames().find((f: any) => f.type === 'create_private_room'))
      assert(sent?.invitePartner === true && sent?.stake === STAKE, JSON.stringify(sent))
    })
    const roomId: string = await host.page.evaluate(() => [...(window as any).__partnerHarness.getReceivedFrames()].reverse().find((f: any) => f.type === 'private_room_updated').room.id)

    if (label === 'desktop') {
      const plainP = await registerProfile(backendPort, `${label} plain`)
      const plain = await openParty(plainP, viewport)
      await plain.page.evaluate(() => (window as any).__partnerHarness.openCreatePopup())
      await plain.page.waitForSelector('[data-private-room-create-form="1"]', { state: 'visible', timeout: 10_000 })
      await plain.page.locator('[data-private-room-create-form="1"] button[type="submit"]').click()
      await check(`${label} [C3] без чекбокса → invitePartner:false, без резервирано място (старото поведение)`, async () => {
        await plain.page.waitForFunction(() => (window as any).__partnerHarness.getCurrentScreen() === 'private-room-waiting', null, { timeout: 10_000 })
        const sent = await plain.page.evaluate(() => (window as any).__partnerHarness.getSentFrames().find((f: any) => f.type === 'create_private_room'))
        assert(sent?.invitePartner === false, JSON.stringify(sent))
        const room = await plain.page.evaluate(() => (window as any).__partnerHarness.getReceivedFrames().find((f: any) => f.type === 'private_room_updated').room)
        assert(room.partnerReservation === null, JSON.stringify(room.partnerReservation))
        assert(await plain.page.locator('[data-private-room-slot-reserved="1"]').count() === 0, 'reserved card rendered without reservation')
      })
      await plain.page.evaluate(() => (window as any).__partnerHarness.send({ type: 'leave_private_room' }))
      await plain.context.close()
    }

    // opp сяда в отбор Б — член, но не домакин.
    await opp.page.evaluate((id) => (window as any).__partnerHarness.send({ type: 'join_private_room', privateRoomId: id, team: 'B', slotIndex: 0 }), roomId)
    await opp.page.waitForFunction(() => (window as any).__partnerHarness.getReceivedFrames().some((f: any) => f.type === 'private_room_updated'), null, { timeout: 10_000 })
    await enterOwnWaitingRoom(opp, roomId)

    await check(`${label} [R1] домакинът вижда "Покани партньор" на резервираното място`, async () => {
      await host.page.locator('[data-private-room-partner-invite-open="1"]').waitFor({ state: 'visible', timeout: 5_000 })
      const text = await host.page.locator('[data-private-room-slot-reserved="1"]').textContent()
      assert((text ?? '').includes('Място с покана'), `card text: ${text}`)
    })

    await check(`${label} [R2] друг член вижда некликаемо "Място с покана" без бутони`, async () => {
      const card = opp.page.locator('[data-private-room-slot-reserved="1"]')
      await card.waitFor({ state: 'visible', timeout: 5_000 })
      assert((await card.textContent() ?? '').includes('Място с покана'), 'missing label')
      assert(await opp.page.locator('[data-private-room-partner-invite-open="1"]').count() === 0, 'non-host sees invite button')
      assert(await card.locator('button').count() === 0, 'reserved card has buttons for non-host')
    })

    await check(`${label} [R3] "Запълни с бот" (ако флагът е включен) в отбор А е неактивен — единственото място е резервирано`, async () => {
      await host.page.evaluate(() => { (window as any).__partnerHarness.setBotFillOverride(true); (window as any).__partnerHarness.render() })
      try {
        assert(await host.page.locator('[data-private-room-bot-team="A"]').isDisabled({ timeout: 5_000 }), 'bot button for team A must be disabled')
      } finally {
        await host.page.evaluate(() => { (window as any).__partnerHarness.setBotFillOverride(undefined); (window as any).__partnerHarness.render() })
      }
    })

    await host.page.click('[data-private-room-partner-invite-open="1"]')
    await host.page.locator('[data-private-room-partner-row="1"]').first().waitFor({ state: 'visible', timeout: 5_000 })

    await check(`${label} [P1] ред: свободни онлайн → играещи → офлайн`, async () => {
      const statuses = await host.page.$$eval('[data-private-room-partner-row="1"] .prw-invite-status', (els) => els.map((e) => e.textContent?.trim()))
      assert(statuses[0] === 'Онлайн' && statuses[1] === 'Онлайн', `first two: ${statuses.slice(0, 2)}`)
      assert(statuses[2] === 'Играе', `third: ${statuses[2]}`)
      assert(statuses.slice(3).every((s) => s === 'Офлайн'), 'rest must be offline')
      const names = await host.page.$$eval('[data-private-room-partner-row="1"] .prw-invite-name', (els) => els.map((e) => e.textContent?.trim()))
      assert(names[0] === friendP.displayName && names[1] === poorP.displayName && names[2] === 'Борис Играе', JSON.stringify(names.slice(0, 3)))
    })

    await check(`${label} [P2] играещ и офлайн приятел не могат да бъдат поканени`, async () => {
      const disabledFor = async (profileId: string) => host.page.locator(`[data-private-room-partner-send="${profileId}"]`).isDisabled()
      assert(await disabledFor('synthetic-playing'), 'playing friend is invitable')
      assert(await disabledFor('synthetic-offline'), 'offline friend is invitable')
      assert(!(await disabledFor(friendP.profileId)), 'online free friend is not invitable')
    })

    await check(`${label} [P3] скролът на списъка оцелява при несвързан re-render`, async () => {
      await host.page.$eval('[data-private-room-partner-list="1"]', (el) => { el.scrollTop = 400 })
      const before = await host.page.$eval('[data-private-room-partner-list="1"]', (el) => el.scrollTop)
      assert(before > 100, `list not scrollable (scrollTop=${before})`)
      await host.page.evaluate(() => (window as any).__partnerHarness.render())
      // Несвързан сървърен push (lobby списък) — също пълен re-render.
      await host.page.evaluate(() => (window as any).__partnerHarness.send({ type: 'request_private_rooms_list' }))
      await sleep(400)
      const after = await host.page.$eval('[data-private-room-partner-list="1"]', (el) => el.scrollTop)
      assert(Math.abs(after - before) < 2, `scrollTop ${before} -> ${after}`)
    })

    await check(`${label} [P4] търсачката филтрира без да губи фокуса (вкл. при re-render)`, async () => {
      const search = host.page.locator('[data-private-room-partner-search="1"]')
      await search.click()
      await search.type('бор')
      let visible = await host.page.$$eval('[data-private-room-partner-row="1"]:not([hidden]) .prw-invite-name', (els) => els.map((e) => e.textContent?.trim()))
      assert(visible.length === 1 && visible[0] === 'Борис Играе', JSON.stringify(visible))
      await host.page.evaluate(() => (window as any).__partnerHarness.render())
      const focused = await host.page.evaluate(() => (document.activeElement as HTMLElement | null)?.getAttribute('data-private-room-partner-search'))
      assert(focused === '1', 'search lost focus after re-render')
      visible = await host.page.$$eval('[data-private-room-partner-row="1"]:not([hidden]) .prw-invite-name', (els) => els.map((e) => e.textContent?.trim()))
      assert(visible.length === 1, `filter lost after re-render: ${JSON.stringify(visible)}`)
      await search.type('zzz')
      assert(await host.page.locator('[data-private-room-partner-no-match="1"]').isVisible(), 'no-match text not shown')
      await search.fill('')
      await search.dispatchEvent('input')
    })

    if (viewport.width < 600) {
      await check(`${label} [M1] телефон: picker-ът няма хоризонтален overflow и бутоните са видими`, async () => {
        assert(await noHorizontalOverflow(host.page), 'horizontal overflow with picker open')
        const box = await host.page.locator('[data-private-room-partner-picker-panel="1"]').boundingBox()
        assert(box !== null && box.x >= 0 && box.x + box.width <= viewport.width + 1, `panel box ${JSON.stringify(box)}`)
      })
    }

    // ─── Приятел без достатъчно жълтици ─────────────────────────────────────
    await host.page.click(`[data-private-room-partner-send="${poorP.profileId}"]`)
    await check(`${label} [B1] покана към приятел без жълтици → прозорец с точния текст, без покана`, async () => {
      const text = host.page.locator('[data-private-room-partner-eligibility-text="1"]')
      await text.waitFor({ state: 'visible', timeout: 5_000 })
      assert((await text.textContent())?.trim() === `${poorP.displayName} не може да играе на тази маса поради липса на достатъчно жълтици.`, `text: ${await text.textContent()}`)
      await sleep(300)
      assert(await poor.page.locator('[data-private-room-partner-invite-text="1"]').count() === 0, 'poor friend received an invite')
      assert(await host.page.locator('[data-private-room-partner-invited="1"]').count() === 0, 'host shows "Поканихте" for a rejected invite')
    })

    if (viewport.width < 600) {
      await check(`${label} [M4] телефон: прозорецът за жълтици без хоризонтален overflow`, async () => {
        assert(await noHorizontalOverflow(host.page), 'balance popup overflow')
      })
    }

    await check(`${label} [B2] "ОК" затваря прозореца; резервацията е активна и може веднага нова покана`, async () => {
      await host.page.click('[data-private-room-partner-eligibility-ok="1"]')
      await host.page.locator('[data-private-room-partner-eligibility-popup="1"]').waitFor({ state: 'detached', timeout: 5_000 })
      const openBtn = host.page.locator('[data-private-room-partner-invite-open="1"]')
      await openBtn.waitFor({ state: 'visible', timeout: 5_000 })
      assert(!(await openBtn.isDisabled()), '"Покани партньор" is disabled after OK')
      assert((await host.page.locator('[data-private-room-slot-reserved="1"]').textContent() ?? '').includes('Място с покана'), 'reservation lost')
    })

    // Покана
    await host.page.click('[data-private-room-partner-invite-open="1"]')
    await host.page.locator(`[data-private-room-partner-send="${friendP.profileId}"]`).waitFor({ state: 'visible', timeout: 5_000 })
    await host.page.click(`[data-private-room-partner-send="${friendP.profileId}"]`)
    await check(`${label} [I1] домакинът вижда "Поканихте Х" (неактивно) и "Отмени поканата"`, async () => {
      const invited = host.page.locator('[data-private-room-partner-invited="1"]')
      await invited.waitFor({ state: 'visible', timeout: 5_000 })
      assert((await invited.textContent())?.trim() === `Поканихте ${friendP.displayName}`, `label: ${await invited.textContent()}`)
      assert(await invited.isDisabled(), 'invited button must be disabled')
      assert(await host.page.locator('[data-private-room-partner-invite-open="1"]').count() === 0, 'second invite is possible')
      assert(await host.page.locator('[data-private-room-partner-invite-cancel="1"]').isVisible(), 'cancel button missing')
    })

    await check(`${label} [I2] поканеният вижда "Х ви кани за партньор в частна маса" с Приеми/Откажи`, async () => {
      const text = friend.page.locator('[data-private-room-partner-invite-text="1"]')
      await text.waitFor({ state: 'visible', timeout: 5_000 })
      assert((await text.textContent())?.trim() === `${hostP.displayName} ви кани за партньор в частна маса`, `text: ${await text.textContent()}`)
      assert(await friend.page.locator('[data-private-room-invite-accept]').isVisible(), 'accept missing')
      assert(await friend.page.locator('[data-private-room-invite-decline]').isVisible(), 'decline missing')
    })

    if (viewport.width < 600) {
      await check(`${label} [M2] телефон: известието и чакалнята без хоризонтален overflow`, async () => {
        assert(await noHorizontalOverflow(friend.page), 'invitee popup overflow')
        assert(await noHorizontalOverflow(host.page), 'host waiting room overflow')
      })
    }

    await check(`${label} [X1] "Отмени поканата" → известието при поканения изчезва, бутонът се връща`, async () => {
      await host.page.click('[data-private-room-partner-invite-cancel="1"]')
      await friend.page.locator('[data-private-room-partner-invite-text="1"]').waitFor({ state: 'detached', timeout: 5_000 })
      await host.page.locator('[data-private-room-partner-invite-open="1"]').waitFor({ state: 'visible', timeout: 5_000 })
    })

    // Нова покана → приемане
    await host.page.click('[data-private-room-partner-invite-open="1"]')
    await host.page.locator(`[data-private-room-partner-send="${friendP.profileId}"]`).waitFor({ state: 'visible', timeout: 5_000 })
    await host.page.click(`[data-private-room-partner-send="${friendP.profileId}"]`)
    await friend.page.locator('[data-private-room-partner-invite-text="1"]').waitFor({ state: 'visible', timeout: 5_000 })
    await friend.page.click('[data-private-room-invite-accept]')

    await check(`${label} [A1] "Приеми" → поканеният е в чакалнята, на A1 до домакина`, async () => {
      await friend.page.waitForFunction(() => (window as any).__partnerHarness.getCurrentScreen() === 'private-room-waiting', null, { timeout: 5_000 })
      await friend.page.locator('.prw-slot-local').waitFor({ state: 'visible', timeout: 5_000 })
      const room = await friend.page.evaluate(() => [...(window as any).__partnerHarness.getReceivedFrames()].reverse().find((f: any) => f.type === 'private_room_updated').room)
      const a1 = room.slots.find((s: any) => s.team === 'A' && s.slotIndex === 1)
      assert(a1.occupant?.profileId === friendP.profileId, JSON.stringify(a1))
    })

    await check(`${label} [A2] домакинът вижда партньора и съобщение за приемане`, async () => {
      await host.page.locator('[data-private-room-slot-reserved="1"]').waitFor({ state: 'detached', timeout: 5_000 })
      const text = await host.page.locator('[data-private-room-partner-notice="accepted"] [data-private-room-notice-text="1"]').textContent()
      assert((text ?? '').includes('прие поканата'), `notice: ${text}`)
    })

    if (viewport.width < 600) {
      await check(`${label} [M3] телефон: чакалнята на поканения без хоризонтален overflow`, async () => {
        assert(await noHorizontalOverflow(friend.page), 'invitee waiting room overflow')
      })
    }

    for (const party of [host, friend, opp, poor]) await party.context.close()
  }

  await runFlow('desktop', { width: 1280, height: 800 })
  await runFlow('mobile', { width: 390, height: 844 })

  // ─── Недостатъчно ниво: реален залог с изискване (admin API) ───────────────
  const LEVEL_STAKE = 7000
  const LEVEL_MIN = 5
  {
    const adminP = await registerProfile(backendPort, 'level admin')
    const email = withDb((db) => {
      db.prepare("UPDATE accounts SET role = 'admin' WHERE account_id = (SELECT account_id FROM profiles WHERE profile_id = ?)").run(adminP.profileId)
      return (db.prepare('SELECT a.email FROM accounts a JOIN profiles p ON p.account_id = a.account_id WHERE p.profile_id = ?').get(adminP.profileId) as { email: string }).email
    })
    const login = await httpJson(backendPort, 'POST', '/api/auth/login', null, { email, password: 'PartnerUiDiag1!', rememberMe: true })
    const res = await httpJson(backendPort, 'POST', '/api/admin/rooms', login.setCookie, { stakeAmount: LEVEL_STAKE, minLevel: LEVEL_MIN, prizeAmount: 10_000, isEnabled: true })
    if (res.status !== 200) throw new Error(`admin stake setup failed: ${res.status} ${JSON.stringify(res.body)}`)
  }

  async function runLevelFlow(label: string, viewport: { width: number; height: number }): Promise<void> {
    console.log(`--- ${label} ниво (${viewport.width}x${viewport.height}) ---`)
    const hostP = await registerProfile(backendPort, `${label} lvlhost`)
    const noviceP = await registerProfile(backendPort, `${label} novice`)
    withDb((db) => db.prepare('UPDATE profiles SET level = ? WHERE profile_id = ?').run(LEVEL_MIN, hostP.profileId))
    await makeFriends(backendPort, hostP, noviceP)
    const host = await openParty(hostP, viewport)
    const novice = await openParty(noviceP, viewport)

    const friendsRes = await httpJson(backendPort, 'GET', '/api/friends', hostP.cookie)
    await host.page.evaluate((friends) => (window as any).__partnerHarness.setFriendships(friends), friendsRes.body.friendships.friends)
    await host.page.evaluate((stake) => (window as any).__partnerHarness.send({ type: 'create_private_room', stake, isLocked: false, waitMinutes: 15, invitePartner: true }), LEVEL_STAKE)
    await host.page.waitForFunction(() => (window as any).__partnerHarness.getReceivedFrames().some((f: any) => f.type === 'private_room_updated'), null, { timeout: 10_000 })
    const roomId: string = await host.page.evaluate(() => (window as any).__partnerHarness.getReceivedFrames().find((f: any) => f.type === 'private_room_updated').room.id)
    await enterOwnWaitingRoom(host, roomId)

    await host.page.click('[data-private-room-partner-invite-open="1"]')
    await host.page.locator(`[data-private-room-partner-send="${noviceP.profileId}"]`).waitFor({ state: 'visible', timeout: 5_000 })
    await host.page.click(`[data-private-room-partner-send="${noviceP.profileId}"]`)

    await check(`${label} [L1] приятел с недостатъчно ниво → прозорец с точния текст, без покана`, async () => {
      const text = host.page.locator('[data-private-room-partner-eligibility-text="1"]')
      await text.waitFor({ state: 'visible', timeout: 5_000 })
      assert((await text.textContent())?.trim() === `${noviceP.displayName} не може да играе на тази маса поради недостатъчно ниво.`, `text: ${await text.textContent()}`)
      await sleep(300)
      assert(await novice.page.locator('[data-private-room-partner-invite-text="1"]').count() === 0, 'novice received an invite')
      assert(await host.page.locator('[data-private-room-partner-invited="1"]').count() === 0, 'host shows "Поканихте" for a rejected invite')
    })

    if (viewport.width < 600) {
      await check(`${label} [L2] телефон: прозорецът за ниво без хоризонтален overflow`, async () => {
        assert(await noHorizontalOverflow(host.page), 'level popup overflow')
      })
    }

    await check(`${label} [L3] "ОК" затваря прозореца; резервацията е активна и може веднага нова покана`, async () => {
      await host.page.click('[data-private-room-partner-eligibility-ok="1"]')
      await host.page.locator('[data-private-room-partner-eligibility-popup="1"]').waitFor({ state: 'detached', timeout: 5_000 })
      const openBtn = host.page.locator('[data-private-room-partner-invite-open="1"]')
      await openBtn.waitFor({ state: 'visible', timeout: 5_000 })
      assert(!(await openBtn.isDisabled()), '"Покани партньор" is disabled after OK')
      assert((await host.page.locator('[data-private-room-slot-reserved="1"]').textContent() ?? '').includes('Място с покана'), 'reservation lost')
    })

    for (const party of [host, novice]) await party.context.close()
  }

  await runLevelFlow('desktop', { width: 1280, height: 800 })
  await runLevelFlow('mobile', { width: 390, height: 844 })

  // ─── Глобално известие към домакина ──────────────────────────────────────
  const NOTICE = '[data-private-room-partner-notice]'
  const noticeText = (p: Page) => p.locator('[data-private-room-notice-text="1"]').textContent()
  const MANUAL_NOTICE = '[data-private-room-manual-start-notice="1"]'

  // Маркира текущия DOM на "Теми" и скрола — ако root-ът на лобито бъде
  // пресъздаден (innerHTML), маркерът сочи откачен възел и скролът се губи.
  async function markTopicsView(p: Page): Promise<void> {
    await p.evaluate(() => {
      document.body.style.minHeight = '6000px'
      ;(window as any).__topicsRootMarker = document.querySelector('[data-lobby-screen-root="1"]')
      ;(window as any).__topicsRootChildMarker = document.querySelector('[data-lobby-screen-root="1"]')?.firstElementChild ?? null
      window.scrollTo(0, 1500)
    })
  }
  async function assertTopicsViewIntact(p: Page, what: string): Promise<void> {
    const state = await p.evaluate(() => {
      const marker = (window as any).__topicsRootMarker as Element | null
      const child = (window as any).__topicsRootChildMarker as Element | null
      return {
        hasMarker: marker !== null,
        sameRoot: marker !== null && marker.isConnected && marker === document.querySelector('[data-lobby-screen-root="1"]'),
        sameChild: child === null || child.isConnected,
        scrollY: window.scrollY,
        screen: (window as any).__partnerHarness.getCurrentScreen(),
      }
    })
    assert(state.hasMarker, `${what}: no lobby root`)
    assert(state.sameRoot && state.sameChild, `${what}: the Topics page was re-rendered`)
    assert(Math.abs(state.scrollY - 1500) <= 2, `${what}: scroll ${state.scrollY}`)
    assert(state.screen === 'topics', `${what}: screen ${state.screen}`)
  }
  const screenOf = (p: Page) => p.evaluate(() => (window as any).__partnerHarness.getCurrentScreen() as string)

  async function goToTopics(party: Party): Promise<void> {
    await party.page.evaluate(() => (window as any).__partnerHarness.goToTopics())
    await party.page.waitForFunction(() => (window as any).__partnerHarness.getCurrentScreen() === 'topics', null, { timeout: 5_000 })
  }

  // Refresh: нова страница със същата сесия + resync (като main.ts onOpen).
  async function refresh(party: Party): Promise<void> {
    await party.page.reload()
    await party.page.waitForFunction(() => (window as any).__partnerHarness !== undefined, undefined, { timeout: 15_000 })
    await party.page.evaluate(({ profileId, displayName }) => (window as any).__partnerHarness.setLocalProfile(profileId, displayName), party.profile)
    await party.page.evaluate((url) => (window as any).__partnerHarness.connect(url), wsUrl)
    await party.page.evaluate(() => (window as any).__partnerHarness.resync())
  }

  async function createRoomAndEnter(host: Party, friends: unknown[]): Promise<string> {
    await host.page.evaluate((list) => (window as any).__partnerHarness.setFriendships(list), friends)
    await host.page.evaluate((stake) => (window as any).__partnerHarness.send({ type: 'create_private_room', stake, isLocked: false, waitMinutes: 15, invitePartner: true }), STAKE)
    await host.page.waitForFunction(() => (window as any).__partnerHarness.getReceivedFrames().some((f: any) => f.type === 'private_room_updated'), null, { timeout: 10_000 })
    const roomId: string = await host.page.evaluate(() => (window as any).__partnerHarness.getReceivedFrames().find((f: any) => f.type === 'private_room_updated').room.id)
    await enterOwnWaitingRoom(host, roomId)
    return roomId
  }

  async function inviteViaPicker(host: Party, friendProfileId: string): Promise<void> {
    if (await host.page.locator('[data-private-room-partner-picker-backdrop="1"]').count() === 0) {
      await host.page.click('[data-private-room-partner-invite-open="1"]')
    }
    await host.page.locator(`[data-private-room-partner-send="${friendProfileId}"]`).waitFor({ state: 'visible', timeout: 5_000 })
    await host.page.click(`[data-private-room-partner-send="${friendProfileId}"]`)
    await host.page.locator('[data-private-room-partner-invited="1"]').waitFor({ state: 'visible', timeout: 5_000 })
  }

  async function friendsList(hostP: Profile): Promise<unknown[]> {
    return (await httpJson(backendPort, 'GET', '/api/friends', hostP.cookie)).body.friendships.friends
  }

  async function runNoticeFlow(label: string, viewport: { width: number; height: number }): Promise<void> {
    console.log(`--- ${label} известие (${viewport.width}x${viewport.height}) ---`)
    const hostP = await registerProfile(backendPort, `${label} nhost`)
    const friendP = await registerProfile(backendPort, `${label} nfriend`)
    const friend2P = await registerProfile(backendPort, `${label} nfriendtwo`)
    await makeFriends(backendPort, hostP, friendP)
    await makeFriends(backendPort, hostP, friend2P)
    const host = await openParty(hostP, viewport)
    const friend = await openParty(friendP, viewport)
    const friend2 = await openParty(friend2P, viewport)
    const roomId = await createRoomAndEnter(host, await friendsList(hostP))
    const expiresAt: number = await host.page.evaluate(() => [...(window as any).__partnerHarness.getReceivedFrames()].reverse().find((f: any) => f.type === 'private_room_updated').room.expiresAt)

    await inviteViaPicker(host, friendP.profileId)
    await friend.page.locator('[data-private-room-partner-invite-text="1"]').waitFor({ state: 'visible', timeout: 5_000 })
    await goToTopics(host)
    await markTopicsView(host.page)
    await friend.page.click('[data-private-room-invite-decline]')

    await check(`${label} [G1] отказ, докато домакинът е в "Теми" → известие с точния текст и двата бутона`, async () => {
      await host.page.locator(NOTICE).waitFor({ state: 'visible', timeout: 5_000 })
      assert((await noticeText(host.page))?.trim() === `${friendP.displayName} отказа твоята покана за партньор.`, `text: ${await noticeText(host.page)}`)
      assert(await host.page.locator('[data-private-room-partner-notice-invite="1"]').isVisible(), '"Покани друг" missing')
      assert(await host.page.locator('[data-private-room-partner-notice-release="1"]').isVisible(), '"Освободи мястото" missing')
      assert(await screenOf(host.page) === 'topics', 'host was navigated away from Topics')
    })

    await check(`${label} [S1] появата на известието не прерисува "Теми" и не мести скрола`, async () => {
      await assertTopicsViewIntact(host.page, 'notice appeared')
    })

    await check(`${label} [G2] известието не блокира сайта (без фон) и не се скрива само`, async () => {
      const blocked = await host.page.evaluate(() => {
        const notice = document.querySelector('[data-private-room-partner-notice]')
        const hit = document.elementFromPoint(5, 5)
        return notice !== null && hit !== null && notice.contains(hit)
      })
      assert(!blocked, 'notice covers the page')
      const box = await host.page.locator(`${NOTICE} > div`).boundingBox()
      assert(box !== null && box.height < viewport.height / 2, `notice too large: ${JSON.stringify(box)}`)
      await new Promise((r) => setTimeout(r, 3_500))
      assert(await host.page.locator(NOTICE).isVisible(), 'notice auto-hidden')
      if (viewport.width < 600) {
        assert(box!.x >= 0 && box!.x + box!.width <= viewport.width + 1, `notice off-screen ${JSON.stringify(box)}`)
        assert(await host.page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), 'horizontal overflow')
      }
    })

    await check(`${label} [G3] refresh преди крайния срок → известието се възстановява, мястото е запазено`, async () => {
      await refresh(host)
      await host.page.locator(NOTICE).waitFor({ state: 'visible', timeout: 8_000 })
      assert((await noticeText(host.page))?.includes('отказа твоята покана за партньор') === true, 'wrong text after refresh')
      const room = await host.page.evaluate(() => [...(window as any).__partnerHarness.getReceivedFrames()].reverse().find((f: any) => f.type === 'private_room_updated').room)
      assert(room.id === roomId && room.partnerReservation !== null && room.expiresAt === expiresAt, 'room/reservation/deadline changed')
    })

    await check(`${label} [G4] "Покани друг" → чакалнята със списъка с приятели; нова покана махa известието, срокът не се променя`, async () => {
      await host.page.evaluate((list) => (window as any).__partnerHarness.setFriendships(list), await friendsList(hostP))
      await host.page.click('[data-private-room-partner-notice-invite="1"]')
      await host.page.waitForFunction(() => (window as any).__partnerHarness.getCurrentScreen() === 'private-room-waiting', null, { timeout: 5_000 })
      await host.page.locator('[data-private-room-partner-picker-backdrop="1"]').waitFor({ state: 'visible', timeout: 5_000 })
      await inviteViaPicker(host, friend2P.profileId)
      await host.page.locator(NOTICE).waitFor({ state: 'detached', timeout: 5_000 })
      const room = await host.page.evaluate(() => [...(window as any).__partnerHarness.getReceivedFrames()].reverse().find((f: any) => f.type === 'private_room_updated').room)
      assert(room.expiresAt === expiresAt, 'new invite changed the room deadline')
    })

    await check(`${label} [G5] втори отказ в "Теми" → "Освободи мястото" премахва резервацията на сървъра`, async () => {
      await friend2.page.locator('[data-private-room-partner-invite-text="1"]').waitFor({ state: 'visible', timeout: 5_000 })
      await goToTopics(host)
      await markTopicsView(host.page)
      await friend2.page.click('[data-private-room-invite-decline]')
      await host.page.locator(NOTICE).waitFor({ state: 'visible', timeout: 5_000 })
      await assertTopicsViewIntact(host.page, 'second notice appeared')
      await host.page.click('[data-private-room-partner-notice-release="1"]')
      await host.page.locator(NOTICE).waitFor({ state: 'detached', timeout: 5_000 })
      await host.page.waitForTimeout(300)
      await assertTopicsViewIntact(host.page, 'notice removed by release')
      await host.page.waitForFunction(() => {
        const frames = (window as any).__partnerHarness.getReceivedFrames()
        const last = [...frames].reverse().find((f: any) => f.type === 'private_room_updated')
        return last?.room.partnerReservation === null
      }, null, { timeout: 5_000 })
      assert(await screenOf(host.page) === 'topics', 'release navigated away')
    })

    await check(`${label} [G6] след освобождаване A1 е обикновено свободно място`, async () => {
      await host.page.evaluate(() => (window as any).__partnerHarness.controller.navigateToPrivateRooms())
      await host.page.click(`[data-private-room-list-enter="${roomId}"]`)
      await host.page.waitForFunction(() => (window as any).__partnerHarness.getCurrentScreen() === 'private-room-waiting', null, { timeout: 5_000 })
      assert(await host.page.locator('[data-private-room-slot-reserved="1"]').count() === 0, 'reserved card still shown')
    })

    for (const party of [host, friend, friend2]) await party.context.close()
  }

  async function runAcceptFlow(label: string, viewport: { width: number; height: number }, mode: 'dismiss' | 'start'): Promise<void> {
    console.log(`--- ${label} приемане/${mode} (${viewport.width}x${viewport.height}) ---`)
    const hostP = await registerProfile(backendPort, `${label} ahost ${mode}`)
    const friendP = await registerProfile(backendPort, `${label} afriend ${mode}`)
    const oppP = await registerProfile(backendPort, `${label} aopp ${mode}`)
    await makeFriends(backendPort, hostP, friendP)
    const host = await openParty(hostP, viewport)
    const friend = await openParty(friendP, viewport)
    const opp = await openParty(oppP, viewport)
    const roomId = await createRoomAndEnter(host, await friendsList(hostP))
    await inviteViaPicker(host, friendP.profileId)
    await friend.page.locator('[data-private-room-partner-invite-text="1"]').waitFor({ state: 'visible', timeout: 5_000 })
    await goToTopics(host)
    await markTopicsView(host.page)
    await friend.page.click('[data-private-room-invite-accept]')

    await check(`${label} [H1] приемане, докато домакинът чете "Теми" → "Х прие поканата ти и седна на масата." само с "ОК", без пренасочване`, async () => {
      await host.page.locator('[data-private-room-partner-notice="accepted"]').waitFor({ state: 'visible', timeout: 5_000 })
      assert((await noticeText(host.page))?.trim() === `${friendP.displayName} прие поканата ти и седна на масата.`, `text: ${await noticeText(host.page)}`)
      const buttons = await host.page.$$eval('[data-private-room-partner-notice] button', (els) => els.map((e) => e.textContent?.trim()))
      assert(JSON.stringify(buttons) === JSON.stringify(['ОК']), `buttons: ${JSON.stringify(buttons)}`)
      await assertTopicsViewIntact(host.page, 'accepted notice appeared')
    })

    if (mode === 'dismiss') {
    await check(`${label} [H2] "ОК" → известието изчезва без прерисуване на "Теми"; refresh не го връща`, async () => {
      await host.page.click('[data-private-room-partner-notice-dismiss="1"]')
      await host.page.locator(NOTICE).waitFor({ state: 'detached', timeout: 5_000 })
      await host.page.waitForTimeout(300)
      await assertTopicsViewIntact(host.page, 'accepted notice dismissed')
      await refresh(host)
      await host.page.waitForFunction(() => (window as any).__partnerHarness.getReceivedFrames().some((f: any) => f.type === 'private_room_updated'), null, { timeout: 8_000 })
      await new Promise((r) => setTimeout(r, 500))
      assert(await host.page.locator(NOTICE).count() === 0, 'dismissed notice came back')
    })

    await check(`${label} [H3] краен срок на масата → известието изчезва само, без съобщение от сървъра`, async () => {
      const room = await host.page.evaluate(() => [...(window as any).__partnerHarness.getReceivedFrames()].reverse().find((f: any) => f.type === 'private_room_updated').room)
      const withNotice = (expiresInMs: number) => ({
        type: 'private_room_updated',
        room: { ...room, expiresAt: Date.now() + expiresInMs, partnerReservation: { ...room.partnerReservation, notice: { kind: 'declined', toDisplayName: 'Тест', createdAt: Date.now() } } },
      })
      await host.page.evaluate((m) => (window as any).__partnerHarness.inject(m), withNotice(1_500))
      await host.page.locator(NOTICE).waitFor({ state: 'visible', timeout: 3_000 })
      await host.page.locator(NOTICE).waitFor({ state: 'detached', timeout: 4_000 })
      await host.page.evaluate((m) => (window as any).__partnerHarness.inject(m), withNotice(-1_000))
      await new Promise((r) => setTimeout(r, 300))
      assert(await host.page.locator(NOTICE).count() === 0, 'notice shown for an expired room (refresh after deadline)')
      // Връщаме истинския snapshot.
      await host.page.evaluate(() => (window as any).__partnerHarness.resync())
    })

    }

    if (mode === 'start') {
    await check(`${label} [H4] старт на мача, докато "прие" е видимо → известието и действията изчезват`, async () => {
      assert(await host.page.locator(NOTICE).isVisible(), 'accepted notice not visible before start')
      await opp.page.evaluate((id) => (window as any).__partnerHarness.send({ type: 'join_private_room', privateRoomId: id, team: 'B', slotIndex: 0 }), roomId)
      await opp.page.waitForFunction(() => (window as any).__partnerHarness.getReceivedFrames().some((f: any) => f.type === 'private_room_updated'), null, { timeout: 5_000 })
      await opp.page.evaluate(() => (window as any).__partnerHarness.send({ type: 'add_bot_to_private_room_team', team: 'B' }))
      await host.page.waitForFunction(() => (window as any).__partnerHarness.getReceivedFrames().some((f: any) => f.type === 'private_room_full'), null, { timeout: 10_000 })
      // В приложението private_room_full подменя екрана с масата (onMatchFound);
      // harness-ът няма активна стая, затова проверяваме състоянието с render().
      await host.page.evaluate(() => (window as any).__partnerHarness.render())
      await host.page.locator(NOTICE).waitFor({ state: 'detached', timeout: 5_000 })
    })
    }

    for (const party of [host, friend, opp]) await party.context.close()
  }

  // Маса с ръчен старт — "Създадената от теб маса се запълни..."
  async function runManualStartFlow(label: string, viewport: { width: number; height: number }, withPartner: boolean): Promise<void> {
    const tag = withPartner ? 'mp' : 'mn'
    console.log(`--- ${label} ръчен старт ${withPartner ? 'с партньор' : 'без покана'} (${viewport.width}x${viewport.height}) ---`)
    const hostP = await registerProfile(backendPort, `${label} ${tag} host`)
    const b0P = await registerProfile(backendPort, `${label} ${tag} bzero`)
    const b1P = await registerProfile(backendPort, `${label} ${tag} bone`)
    const a1P = await registerProfile(backendPort, `${label} ${tag} aone`)
    if (withPartner) await makeFriends(backendPort, hostP, a1P)
    const host = await openParty(hostP, viewport)
    const b0 = await openParty(b0P, viewport)
    const b1 = await openParty(b1P, viewport)
    const a1 = await openParty(a1P, viewport)
    await host.page.evaluate((list) => (window as any).__partnerHarness.setFriendships(list), await friendsList(hostP))
    await host.page.evaluate(({ stake, invitePartner }) => (window as any).__partnerHarness.send({ type: 'create_private_room', stake, isLocked: false, waitMinutes: 15, manualStart: true, invitePartner }), { stake: STAKE, invitePartner: withPartner })
    await host.page.waitForFunction(() => (window as any).__partnerHarness.getReceivedFrames().some((f: any) => f.type === 'private_room_updated'), null, { timeout: 10_000 })
    const roomId: string = await host.page.evaluate(() => (window as any).__partnerHarness.getReceivedFrames().find((f: any) => f.type === 'private_room_updated').room.id)
    await enterOwnWaitingRoom(host, roomId)
    const join = async (party: Party, team: 'A' | 'B', slotIndex: 0 | 1) => {
      await party.page.evaluate(({ id, t, i }) => (window as any).__partnerHarness.send({ type: 'join_private_room', privateRoomId: id, team: t, slotIndex: i }), { id: roomId, t: team, i: slotIndex })
      await host.page.waitForFunction(({ t, i, pid }) => {
        const last = [...(window as any).__partnerHarness.getReceivedFrames()].reverse().find((f: any) => f.type === 'private_room_updated')
        return last?.room.slots.some((sl: any) => sl.team === t && sl.slotIndex === i && sl.occupant?.profileId === pid)
      }, { t: team, i: slotIndex, pid: party.profile.profileId }, { timeout: 5_000 })
    }
    await join(b0, 'B', 0)
    await join(b1, 'B', 1)
    if (withPartner) await inviteViaPicker(host, a1P.profileId)
    await goToTopics(host)
    await markTopicsView(host.page)
    await check(`${label} [${tag}1] 3/4 → няма известие за запълнена маса`, async () => {
      await host.page.waitForTimeout(300)
      assert(await host.page.locator(MANUAL_NOTICE).count() === 0, 'manual notice before full')
    })
    if (withPartner) {
      await a1.page.locator('[data-private-room-partner-invite-text="1"]').waitFor({ state: 'visible', timeout: 5_000 })
      await a1.page.click('[data-private-room-invite-accept]')
    } else {
      await join(a1, 'A', 1)
    }

    await check(`${label} [${tag}2] последното място е заето, домакинът е в "Теми" → глобално известие с "Към масата"`, async () => {
      await host.page.locator(MANUAL_NOTICE).waitFor({ state: 'visible', timeout: 5_000 })
      assert((await noticeText(host.page))?.trim() === 'Създадената от теб маса се запълни. Всички играчи са готови. Върни се, за да стартираш играта.', `text: ${await noticeText(host.page)}`)
      const buttons = await host.page.$$eval(`${MANUAL_NOTICE} button`, (els) => els.map((e) => e.textContent?.trim()))
      assert(JSON.stringify(buttons) === JSON.stringify(['Към масата']), `buttons ${JSON.stringify(buttons)}`)
      if (withPartner) assert(await host.page.locator('[data-private-room-partner-notice]').count() === 0, 'accepted notice shown instead of the full-table notice')
      await assertTopicsViewIntact(host.page, 'manual-start notice appeared')
    })

    await check(`${label} [${tag}3] не изчезва само и не се дублира при повторни WebSocket събития`, async () => {
      await host.page.waitForTimeout(3_500)
      await host.page.evaluate(() => (window as any).__partnerHarness.resync())
      await host.page.evaluate(() => (window as any).__partnerHarness.send({ type: 'request_private_rooms_list' }))
      await host.page.waitForTimeout(500)
      assert(await host.page.locator(MANUAL_NOTICE).count() === 1, `count ${await host.page.locator(MANUAL_NOTICE).count()}`)
      assert(await host.page.locator('[data-private-room-notice-host="1"]').count() === 1, 'duplicate notice hosts')
      await assertTopicsViewIntact(host.page, 'repeated snapshots')
    })

    await check(`${label} [${tag}4] refresh/reconnect → известието се възстановява`, async () => {
      await refresh(host)
      await host.page.locator(MANUAL_NOTICE).waitFor({ state: 'visible', timeout: 8_000 })
      await goToTopics(host)
      await markTopicsView(host.page)
      assert(await host.page.locator(MANUAL_NOTICE).count() === 1, 'notice lost on navigation')
    })

    await check(`${label} [${tag}5] играч напуска → известието изчезва; повторно запълване → появява се отново`, async () => {
      await b1.page.evaluate(() => (window as any).__partnerHarness.send({ type: 'leave_private_room' }))
      await host.page.locator(MANUAL_NOTICE).waitFor({ state: 'detached', timeout: 5_000 })
      await host.page.waitForTimeout(200)
      await assertTopicsViewIntact(host.page, 'manual notice removed')
      await join(b1, 'B', 1)
      await host.page.locator(MANUAL_NOTICE).waitFor({ state: 'visible', timeout: 5_000 })
      await assertTopicsViewIntact(host.page, 'manual notice re-appeared')
    })

    await check(`${label} [${tag}6] "Към масата" → чакалнята, без автоматичен старт; в чакалнята няма popup`, async () => {
      await host.page.click('[data-private-room-manual-start-notice-open="1"]')
      await host.page.waitForFunction(() => (window as any).__partnerHarness.getCurrentScreen() === 'private-room-waiting', null, { timeout: 5_000 })
      await host.page.waitForTimeout(500)
      assert(await host.page.locator(MANUAL_NOTICE).count() === 0, 'popup shown in the waiting room')
      assert(!(await host.page.evaluate(() => (window as any).__partnerHarness.getReceivedFrames().some((f: any) => f.type === 'private_room_full'))), 'match started automatically')
      assert(await host.page.locator('[data-private-room-manual-start="1"]').isEnabled(), 'START not available')
      if (withPartner) {
        // Неотхвърленото "прие" остава за чакалнята (с "ОК").
        assert(await host.page.locator('[data-private-room-partner-notice="accepted"]').count() === 1, 'accepted notice missing in the waiting room')
      }
    })

    await check(`${label} [${tag}7] краен срок на масата → известието изчезва (и не се връща за изтекла маса)`, async () => {
      await goToTopics(host)
      await host.page.locator(MANUAL_NOTICE).waitFor({ state: 'visible', timeout: 5_000 })
      const room = await host.page.evaluate(() => [...(window as any).__partnerHarness.getReceivedFrames()].reverse().find((f: any) => f.type === 'private_room_updated').room)
      await host.page.evaluate((m) => (window as any).__partnerHarness.inject(m), { type: 'private_room_updated', room: { ...room, expiresAt: Date.now() + 1_500 } })
      await host.page.locator(MANUAL_NOTICE).waitFor({ state: 'detached', timeout: 4_000 })
      await host.page.evaluate((m) => (window as any).__partnerHarness.inject(m), { type: 'private_room_updated', room: { ...room, expiresAt: Date.now() - 1_000 } })
      await host.page.waitForTimeout(300)
      assert(await host.page.locator(MANUAL_NOTICE).count() === 0, 'notice for an expired room')
      await host.page.evaluate(() => (window as any).__partnerHarness.resync())
      await host.page.locator(MANUAL_NOTICE).waitFor({ state: 'visible', timeout: 5_000 })
    })

    await check(`${label} [${tag}8] мачът започва (СТАРТ от чакалнята) → известието изчезва`, async () => {
      await host.page.click('[data-private-room-manual-start-notice-open="1"]')
      await host.page.waitForFunction(() => (window as any).__partnerHarness.getCurrentScreen() === 'private-room-waiting', null, { timeout: 5_000 })
      await host.page.click('[data-private-room-manual-start="1"]')
      await host.page.waitForFunction(() => (window as any).__partnerHarness.getReceivedFrames().some((f: any) => f.type === 'private_room_full'), null, { timeout: 10_000 })
      await host.page.waitForTimeout(300)
      assert(await host.page.locator('[data-private-room-notice-host="1"]').count() === 0, 'notice after match start')
    })

    for (const party of [host, b0, b1, a1]) await party.context.close()
  }

  async function runAutoStartFlow(label: string, viewport: { width: number; height: number }): Promise<void> {
    console.log(`--- ${label} автоматичен старт (${viewport.width}x${viewport.height}) ---`)
    const parties = await Promise.all(['host', 'bzero', 'bone', 'aone'].map(async (t) => openParty(await registerProfile(backendPort, `${label} auto ${t}`), viewport)))
    const [host, b0, b1, a1] = parties as [Party, Party, Party, Party]
    await host.page.evaluate((stake) => (window as any).__partnerHarness.send({ type: 'create_private_room', stake, isLocked: false, waitMinutes: 15 }), STAKE)
    await host.page.waitForFunction(() => (window as any).__partnerHarness.getReceivedFrames().some((f: any) => f.type === 'private_room_updated'), null, { timeout: 10_000 })
    const roomId: string = await host.page.evaluate(() => (window as any).__partnerHarness.getReceivedFrames().find((f: any) => f.type === 'private_room_updated').room.id)
    await goToTopics(host)
    for (const [party, team, slotIndex] of [[b0, 'B', 0], [b1, 'B', 1], [a1, 'A', 1]] as const) {
      await party.page.evaluate(({ id, t, i }) => (window as any).__partnerHarness.send({ type: 'join_private_room', privateRoomId: id, team: t, slotIndex: i }), { id: roomId, t: team, i: slotIndex })
      await host.page.waitForTimeout(250)
    }
    await check(`${label} [AS] маса с автоматичен старт → стартира, без известие за запълнена маса`, async () => {
      await host.page.waitForFunction(() => (window as any).__partnerHarness.getReceivedFrames().some((f: any) => f.type === 'private_room_full'), null, { timeout: 10_000 })
      assert(await host.page.locator(MANUAL_NOTICE).count() === 0, 'manual-start notice on an auto-start table')
    })
    for (const party of parties) await party.context.close()
  }

  for (const withPartner of [false, true]) {
    await runManualStartFlow('desktop', { width: 1280, height: 800 }, withPartner)
    await runManualStartFlow('mobile', { width: 390, height: 844 }, withPartner)
  }
  await runAutoStartFlow('desktop', { width: 1280, height: 800 })
  await runAutoStartFlow('mobile', { width: 390, height: 844 })

  await runNoticeFlow('desktop', { width: 1280, height: 800 })
  await runNoticeFlow('mobile', { width: 390, height: 844 })
  for (const mode of ['dismiss', 'start'] as const) {
    await runAcceptFlow('desktop', { width: 1280, height: 800 }, mode)
    await runAcceptFlow('mobile', { width: 390, height: 844 }, mode)
  }
} finally {
  await browser?.close()
  await vite?.close()
  await stopServer(server)
  await isolated.cleanup()
}

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
