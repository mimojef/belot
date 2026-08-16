/**
 * checkPrivateRoomRealSecondProfileJoin.ts
 *
 * Real backend (spawned Node process, isolated temp copy) + real Vite dev
 * server + real Chromium (Playwright), two independent browser contexts
 * (separate cookie jars, mirroring two separate browser sessions) — the
 * exact end-to-end path a manual tester exercises: host creates an open
 * room, a second real profile previews it, clicks a specific "+", confirms
 * the join popup, and must become the occupant of that exact (team,
 * slotIndex).
 *
 * This closes a real coverage gap: checkPrivateRoomWebSocketRoundTrip.ts
 * proves the protocol/store layer works over raw WebSocket, and
 * privateRoomWaitingHarness.ts-based Playwright checks prove the DOM click
 * correctly calls onPrivateRoomJoinSlot(...) — but nothing previously
 * exercised BOTH together: a real click, through the real production
 * controller, over a real network round trip, against a real server. That
 * gap is exactly where the reported manual-test bug ("Marta33 confirms a
 * specific + and nothing happens, room stays 1/4") could hide undetected.
 *
 * Root cause found (see investigation): none of the above — every layer
 * (frontend wiring, protocol parser, server handler, store, eligibility)
 * works correctly for a normal previewer join. This suite exists to prove
 * that end-to-end and stand as the permanent regression test for it, plus a
 * companion scenario asserting a REJECTED join surfaces a visible error
 * (not a silent no-op) in the waiting room's info banner.
 */

import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

let passed = 0
let failed = 0

function pass(label: string): void {
  passed++
  console.log(`  PASS  ${label}`)
}
function fail(label: string, reason: unknown): void {
  failed++
  console.error(`  FAIL  ${label}: ${reason instanceof Error ? reason.message : String(reason)}`)
}
async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    pass(label)
  } catch (err) {
    fail(label, err)
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

async function registerProfile(port: number, tag: string): Promise<{ cookieToken: string; profileId: string; displayName: string }> {
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const displayName = `RJ ${tag}`
  const reg = await httpJson(port, 'POST', '/api/auth/register', null, {
    email: `real-join-${tag}-${runId}@example.test`,
    password: 'RealJoinDiag1!',
    displayName,
    gender: 'male',
  })
  if (reg.status !== 200) throw new Error(`Registration failed for ${tag}: ${JSON.stringify(reg.body)}`)
  const cookieToken = (reg.setCookie as string).split('=')[1]
  return { cookieToken, profileId: reg.body.session.profile.profileId, displayName }
}

// ─── Isolated real backend (same model as checkGameplayActionStaleConnectionGuard.ts) ─

const sourceServerRoot = resolve(process.cwd(), 'server')

async function retryRm(path: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try { await rm(path, { recursive: true, force: true }); return } catch { /* retry */ }
    await sleep(250)
  }
}

async function createIsolatedServerRoot(originalServerRoot: string) {
  const root = await mkdtemp(join(tmpdir(), 'belot-real-join-'))
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
  server.child.kill('SIGTERM')
  await new Promise<void>((r) => {
    const t = setTimeout(() => { server.child.kill('SIGKILL'); r() }, 10_000)
    server.child.once('exit', () => { clearTimeout(t); r() })
  })
}

// ─── Playwright helpers ─────────────────────────────────────────────────────

async function diagFrames(page: Page): Promise<{ sent: any[]; received: any[] }> {
  return page.evaluate(() => ({
    sent: (window as any).__diagHarness.getSentFrames(),
    received: (window as any).__diagHarness.getReceivedFrames(),
  }))
}

console.log('\ncheckPrivateRoomRealSecondProfileJoin\n')

let server: RunningServer | null = null
let vite: ViteDevServer | null = null
let browser: Browser | null = null
const isolated = await createIsolatedServerRoot(sourceServerRoot)

try {
  const backendPort = await findFreePort()
  server = startServer(isolated.serverDir, backendPort)
  console.log(`Waiting for backend on port ${backendPort}...`)
  try {
    await waitForCondition('backend health', async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${backendPort}/health`)
        const h = await r.json()
        return r.status === 200 && h.ok === true && h.gameWorkerLifecycle?.state === 'ready'
      } catch { return false }
    }, 30_000)
  } catch (err) {
    console.error('--- server output ---')
    console.error(server.output())
    throw err
  }
  console.log('Backend ready.')

  const vitePort = await findFreePort()
  vite = await createViteServer({
    root: process.cwd(),
    server: { port: vitePort, strictPort: true, host: '127.0.0.1' },
    logLevel: 'error',
  })
  await vite.listen()
  console.log('Vite ready.\n')

  const backendOrigin = `http://127.0.0.1:${backendPort}`
  const wsUrl = `ws://127.0.0.1:${backendPort}/ws`
  const fixtureUrl = `http://127.0.0.1:${vitePort}/scripts/fixtures/privateRoomRealWsHarness.html`

  const host = await registerProfile(backendPort, 'host')
  const marta = await registerProfile(backendPort, 'marta')

  browser = await chromium.launch()

  async function openConnectedPage(profile: { cookieToken: string; profileId: string; displayName: string }): Promise<{ context: BrowserContext; page: Page }> {
    const context = await browser!.newContext()
    await context.addCookies([{
      name: 'belot_session',
      value: profile.cookieToken,
      url: backendOrigin,
    }])
    const page = await context.newPage()
    const pageErrors: string[] = []
    page.on('pageerror', (e) => pageErrors.push(e.message))
    await page.goto(fixtureUrl)
    await page.evaluate(
      ({ profileId, displayName }) => (window as any).__diagHarness.setLocalProfile(profileId, displayName),
      { profileId: profile.profileId, displayName: profile.displayName },
    )
    await page.evaluate((url) => (window as any).__diagHarness.connect(url), wsUrl)
    if (pageErrors.length > 0) throw new Error(`page errors during setup: ${pageErrors.join(' | ')}`)
    return { context, page }
  }

  // ───────────────────────────────────────────────────────────────────────
  // Scenario: host creates an open room; Marta (second real profile, real
  // browser session, separate cookie jar) previews it, clicks a specific
  // "+", confirms — must become the occupant of exactly that slot.
  // ───────────────────────────────────────────────────────────────────────
  const { context: hostCtx, page: hostPage } = await openConnectedPage(host)
  const { context: martaCtx, page: martaPage } = await openConnectedPage(marta)

  await hostPage.evaluate(() => (window as any).__diagHarness.send({ type: 'create_private_room', stake: 5000, isLocked: false }))
  await hostPage.waitForFunction(() => (window as any).__diagHarness.getReceivedFrames().some((f: any) => f.type === 'private_room_updated'), null, { timeout: 10_000 })
  const created = await hostPage.evaluate(() => (window as any).__diagHarness.getReceivedFrames().find((f: any) => f.type === 'private_room_updated'))
  const roomId: string = created.room.id

  await check('[1] host real-browser create_private_room produces a real private_room_updated with the creator at A,0', async () => {
    const a0 = created.room.slots.find((s: any) => s.team === 'A' && s.slotIndex === 0)
    assert(a0?.occupant?.isHost === true, 'expected host at A,0')
  })

  // Marta requests the real room list (same as opening the private-rooms
  // screen) and gets the REAL server response — no fabricated data.
  await martaPage.evaluate(() => (window as any).__diagHarness.send({ type: 'request_private_rooms_list' }))
  await martaPage.waitForFunction(() => (window as any).__diagHarness.getReceivedFrames().some((f: any) => f.type === 'private_rooms_list'), null, { timeout: 10_000 })

  await check('[2] Marta\'s real private_rooms_list response includes the host\'s room', async () => {
    const list = await martaPage.evaluate(() => (window as any).__diagHarness.getReceivedFrames().find((f: any) => f.type === 'private_rooms_list'))
    assert(list.rooms.some((r: any) => r.id === roomId), 'room not present in Marta\'s real private_rooms_list')
  })

  // Pure client-side preview navigation (production method) — no WS send.
  await martaPage.evaluate((id) => (window as any).__diagHarness.previewRoom(id), roomId)

  await check('[3] Marta lands on the waiting screen as a previewer with a clickable "+" for B,0', async () => {
    const screen = await martaPage.evaluate(() => (window as any).__diagHarness.getCurrentScreen())
    assert(screen === 'private-room-waiting', `expected private-room-waiting, got ${screen}`)
    const btn = martaPage.locator('[data-private-room-slot-join="B:0"]')
    await btn.waitFor({ state: 'visible', timeout: 5_000 })
  })

  // The real click, through the real DOM, through the real controller.
  await martaPage.click('[data-private-room-slot-join="B:0"]')
  await martaPage.locator('[data-private-room-join-popup-confirm="1"]').waitFor({ state: 'visible', timeout: 5_000 })
  await martaPage.click('[data-private-room-join-popup-confirm="1"]')

  await check('[4] confirm click reaches onPrivateRoomJoinSlot and a real join_private_room{privateRoomId,team,slotIndex} frame is sent on the wire', async () => {
    const frames = await diagFrames(martaPage)
    const sentJoin = frames.sent.find((f: any) => f.type === 'join_private_room')
    assert(sentJoin !== undefined, `no join_private_room frame was sent; sent=${JSON.stringify(frames.sent)}`)
    assert(sentJoin.privateRoomId === roomId, `wrong privateRoomId: ${sentJoin.privateRoomId}`)
    assert(sentJoin.team === 'B' && sentJoin.slotIndex === 0, `wrong slot: ${JSON.stringify(sentJoin)}`)
  })

  await check('[5] the server accepts the join and Marta becomes the human occupant of exactly (B,0)', async () => {
    await martaPage.waitForFunction(() => {
      const frames = (window as any).__diagHarness.getReceivedFrames()
      return frames.some((f: any) => f.type === 'private_room_updated' && f.room.slots.find((s: any) => s.team === 'B' && s.slotIndex === 0)?.occupant !== null)
    }, null, { timeout: 10_000 })
    const latest = await martaPage.evaluate(() => {
      const frames = (window as any).__diagHarness.getReceivedFrames().filter((f: any) => f.type === 'private_room_updated')
      return frames[frames.length - 1]
    })
    const b0 = latest.room.slots.find((s: any) => s.team === 'B' && s.slotIndex === 0)
    assert(b0.occupant !== null && b0.occupant.isBot === false, 'B,0 is not occupied by a human')
    const a1 = latest.room.slots.find((s: any) => s.team === 'A' && s.slotIndex === 1)
    assert(a1.occupant === null, 'A,1 unexpectedly occupied — join landed on the wrong slot')
  })

  await check('[6] the host\'s real browser connection also observes the update (2 occupied slots)', async () => {
    await hostPage.waitForFunction(() => {
      const frames = (window as any).__diagHarness.getReceivedFrames().filter((f: any) => f.type === 'private_room_updated')
      const last = frames[frames.length - 1]
      return last && last.room.slots.filter((s: any) => s.occupant !== null).length === 2
    }, null, { timeout: 10_000 })
  })

  await check('[7] Marta\'s waiting-room DOM now shows her own red "−" (member view, not previewer)', async () => {
    const leaveBtn = martaPage.locator('[data-private-room-leave-slot="1"]')
    await leaveBtn.waitFor({ state: 'visible', timeout: 5_000 })
  })

  await hostCtx.close()
  await martaCtx.close()

  // ───────────────────────────────────────────────────────────────────────
  // Companion scenario: a REJECTED join must surface a visible error, not a
  // silent no-op — this is what point 5/6 of the task spec asked to verify.
  // ───────────────────────────────────────────────────────────────────────
  const { context: host2Ctx, page: host2Page } = await openConnectedPage(await registerProfile(backendPort, 'host2'))
  const outsider = await registerProfile(backendPort, 'outsider')
  const { context: outsiderCtx, page: outsiderPage } = await openConnectedPage(outsider)

  await host2Page.evaluate(() => (window as any).__diagHarness.send({ type: 'create_private_room', stake: 5000, isLocked: false }))
  await host2Page.waitForFunction(() => (window as any).__diagHarness.getReceivedFrames().some((f: any) => f.type === 'private_room_updated'), null, { timeout: 10_000 })
  const created2 = await host2Page.evaluate(() => (window as any).__diagHarness.getReceivedFrames().find((f: any) => f.type === 'private_room_updated'))
  const roomId2: string = created2.room.id

  await outsiderPage.evaluate(() => (window as any).__diagHarness.send({ type: 'request_private_rooms_list' }))
  await outsiderPage.waitForFunction(() => (window as any).__diagHarness.getReceivedFrames().some((f: any) => f.type === 'private_rooms_list'), null, { timeout: 10_000 })
  await outsiderPage.evaluate((id) => (window as any).__diagHarness.previewRoom(id), roomId2)
  await outsiderPage.locator('[data-private-room-slot-join="B:0"]').waitFor({ state: 'visible', timeout: 5_000 })
  await outsiderPage.click('[data-private-room-slot-join="B:0"]')
  await outsiderPage.locator('[data-private-room-join-popup-confirm="1"]').waitFor({ state: 'visible', timeout: 5_000 })

  // A SEPARATE real profile takes the exact same slot FIRST (full real
  // round trip, confirmed complete) so that outsider's subsequent confirm
  // click genuinely finds the slot taken — a real, reproducible rejection,
  // not a fabricated one.
  const racer = await registerProfile(backendPort, 'racer')
  const { context: raceCtx, page: racePage } = await openConnectedPage(racer)
  await racePage.evaluate((id) => (window as any).__diagHarness.send({ type: 'join_private_room', privateRoomId: id, team: 'B', slotIndex: 0 }), roomId2)
  await racePage.waitForFunction(() => (window as any).__diagHarness.getReceivedFrames().some((f: any) => f.type === 'private_room_updated'), null, { timeout: 10_000 })

  await outsiderPage.click('[data-private-room-join-popup-confirm="1"]')
  await sleep(500)

  await check('[8] a rejected join (slot already taken) is surfaced as a VISIBLE error in the waiting-room info banner, not a silent no-op', async () => {
    const infoText = await outsiderPage.locator('.prw-info-banner').textContent().catch(() => null)
    const bannerVisible = await outsiderPage.locator('.prw-info-banner').isVisible().catch(() => false)
    const frames = await diagFrames(outsiderPage)
    const gotError = frames.received.some((f: any) => f.type === 'error')
    assert(gotError, `expected an error frame on the outsider connection; received=${JSON.stringify(frames.received)}`)
    assert(bannerVisible && !!infoText && infoText.trim().length > 0, `expected a visible non-empty info banner, got visible=${bannerVisible} text=${JSON.stringify(infoText)}`)
  })

  await host2Ctx.close()
  await outsiderCtx.close()
  await raceCtx.close()
} finally {
  if (browser) await browser.close()
  if (vite) await vite.close()
  await stopServer(server)
  await isolated.cleanup()
}

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)

if (failed > 0) {
  process.exit(1)
}
