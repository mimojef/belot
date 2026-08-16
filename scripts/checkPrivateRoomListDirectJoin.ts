/**
 * checkPrivateRoomListDirectJoin.ts
 *
 * Real backend (spawned Node process, isolated temp copy) + real Vite dev
 * server + real Chromium (Playwright) — same infrastructure as
 * checkPrivateRoomRealSecondProfileJoin.ts (reuses the SAME
 * privateRoomRealWsHarness.ts fixture, no new framework), but exercises the
 * NEW "Частни маси" list-screen UX: direct team/slot "+" on the list card
 * itself (no more separate "Влез в масата" preview step), the "ВЛЕЗ" button
 * on the viewer's own room, the "already seated on another table" conflict
 * popup, and stale-own-room reconciliation.
 *
 * Covers (task spec §18):
 *  [1]  list card renders Team A / Team B labels + all 4 canonical slots.
 *  [2]+[3] non-member clicks a specific list "+" -> confirm -> the exact
 *       (roomId, team, slotIndex) is sent and the join succeeds -> real
 *       navigation to the waiting room as a member.
 *  [4]  cancel -> no join_private_room sent, stays on the list.
 *  [5]  once a member, opening "Частни маси" again pins the own room first.
 *  [6]+[7] the own room shows "ВЛЕЗ", and clicking it does NOT send a new
 *       join_private_room — pure navigation back to the existing waiting
 *       room.
 *  [8]  the own room's empty slots render as non-interactive (no
 *       data-private-room-list-slot-join button) — no second-seat claim.
 *  [9]+[10] clicking "+" on a DIFFERENT room while already seated shows the
 *       "already seated" conflict popup; its return action navigates to the
 *       OWN room, not the other one, without a new join.
 *  [11] after an explicit leave (-), the restriction lifts and a normal "+"
 *       join on another room succeeds.
 *  [12] a stale state.myPrivateRoom (no longer present in a fresh
 *       private_rooms_list) does not permanently block joining a new room.
 *  [13] an occupied human slot's click never sends a join and does not
 *       crash the page (profile-popup path, not join path).
 *  [14] mobile viewport: no horizontal overflow on the list with a 4-slot
 *       team layout.
 *  [15] a genuinely rejected direct list join (slot race) surfaces a
 *       visible, non-empty info toast — not a silent no-op.
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
  const displayName = `LD ${tag}`
  const reg = await httpJson(port, 'POST', '/api/auth/register', null, {
    email: `list-direct-${tag}-${runId}@example.test`,
    password: 'ListDirectDiag1!',
    displayName,
    gender: 'male',
  })
  if (reg.status !== 200) throw new Error(`Registration failed for ${tag}: ${JSON.stringify(reg.body)}`)
  const cookieToken = (reg.setCookie as string).split('=')[1]
  return { cookieToken, profileId: reg.body.session.profile.profileId, displayName }
}

const sourceServerRoot = resolve(process.cwd(), 'server')

async function retryRm(path: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try { await rm(path, { recursive: true, force: true }); return } catch { /* retry */ }
    await sleep(250)
  }
}

async function createIsolatedServerRoot(originalServerRoot: string) {
  const root = await mkdtemp(join(tmpdir(), 'belot-list-direct-'))
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

async function diagFrames(page: Page): Promise<{ sent: any[]; received: any[] }> {
  return page.evaluate(() => ({
    sent: (window as any).__diagHarness.getSentFrames(),
    received: (window as any).__diagHarness.getReceivedFrames(),
  }))
}

async function refreshRoomsList(page: Page): Promise<void> {
  // IMPORTANT: compute `before` BEFORE sending — the local server can (and
  // often does) respond before the next evaluate() round-trip completes, so
  // computing the baseline count after send() risks it already including
  // the fresh response, making the "count > before" wait never resolve.
  const before = await page.evaluate(() => (window as any).__diagHarness.getReceivedFrames().filter((f: any) => f.type === 'private_rooms_list').length)
  await page.evaluate(() => (window as any).__diagHarness.send({ type: 'request_private_rooms_list' }))
  await page.waitForFunction((prevCount) => {
    return (window as any).__diagHarness.getReceivedFrames().filter((f: any) => f.type === 'private_rooms_list').length > prevCount
  }, before, { timeout: 10_000 })
}

console.log('\ncheckPrivateRoomListDirectJoin\n')

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

  browser = await chromium.launch()

  async function openConnectedPage(
    profile: { cookieToken: string; profileId: string; displayName: string },
    viewport?: { width: number; height: number },
  ): Promise<{ context: BrowserContext; page: Page }> {
    const context = await browser!.newContext(viewport ? { viewport } : {})
    await context.addCookies([{ name: 'belot_session', value: profile.cookieToken, url: backendOrigin }])
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

  async function createOpenRoom(page: Page): Promise<string> {
    const before = await page.evaluate(() => (window as any).__diagHarness.getReceivedFrames().length)
    await page.evaluate(() => (window as any).__diagHarness.send({ type: 'create_private_room', stake: 5000, isLocked: false }))
    await page.waitForFunction((prevLen) => {
      const frames = (window as any).__diagHarness.getReceivedFrames()
      return frames.slice(prevLen).some((f: any) => f.type === 'private_room_updated')
    }, before, { timeout: 10_000 })
    const frames = await page.evaluate(() => (window as any).__diagHarness.getReceivedFrames())
    return frames.filter((f: any) => f.type === 'private_room_updated').pop().room.id
  }

  // ───────────────────────────────────────────────────────────────────────
  // Setup: two independent rooms (roomA owned by hostA, roomC owned by
  // hostC) and one second real profile (viewer) who will interact with both
  // purely through the list screen.
  // ───────────────────────────────────────────────────────────────────────
  const hostA = await registerProfile(backendPort, 'hostA')
  const hostC = await registerProfile(backendPort, 'hostC')
  const viewer = await registerProfile(backendPort, 'viewer')

  const { page: hostAPage } = await openConnectedPage(hostA)
  const { page: hostCPage } = await openConnectedPage(hostC)
  const { context: viewerCtx, page: viewerPage } = await openConnectedPage(viewer)

  const roomIdA = await createOpenRoom(hostAPage)
  const roomIdC = await createOpenRoom(hostCPage)

  await refreshRoomsList(viewerPage)
  await viewerPage.evaluate(() => (window as any).__diagHarness.controller.navigateToPrivateRooms())

  await check('[1] the list card for roomA shows both team labels and all 4 canonical slots (1 occupant + 3 empty)', async () => {
    const cardText = await viewerPage.evaluate(() => document.body.textContent ?? '')
    assert(cardText.includes('ОТБОР А'), 'missing ОТБОР А label')
    assert(cardText.includes('ОТБОР Б'), 'missing ОТБОР Б label')
    const plusButtons = await viewerPage.locator(`[data-private-room-list-slot-join^="${roomIdA}:"]`).count()
    assert(plusButtons === 3, `expected 3 clickable "+" on a fresh 1/4 open room, got ${plusButtons}`)
  })

  await check('[4-setup] no join_private_room has been sent yet by the viewer', async () => {
    const frames = await diagFrames(viewerPage)
    assert(!frames.sent.some((f: any) => f.type === 'join_private_room'), 'unexpected premature join_private_room')
  })

  // Open the popup, then CANCEL — must not send anything.
  await viewerPage.click(`[data-private-room-list-slot-join="${roomIdA}:B:0"]`)
  await viewerPage.locator('[data-private-room-join-popup-cancel="1"]').waitFor({ state: 'visible', timeout: 5_000 })
  await viewerPage.click('[data-private-room-join-popup-cancel="1"]')

  await check('[4] cancel does not send a join_private_room and leaves the viewer on the list', async () => {
    const frames = await diagFrames(viewerPage)
    assert(!frames.sent.some((f: any) => f.type === 'join_private_room'), 'cancel unexpectedly sent a join')
    const screen = await viewerPage.evaluate(() => (window as any).__diagHarness.getCurrentScreen())
    assert(screen === 'private-rooms', `expected to stay on private-rooms, got ${screen}`)
  })

  // Real click -> real confirm -> real join, for the SAME exact slot.
  await viewerPage.click(`[data-private-room-list-slot-join="${roomIdA}:B:0"]`)
  await viewerPage.locator('[data-private-room-join-popup-confirm="1"]').waitFor({ state: 'visible', timeout: 5_000 })
  await viewerPage.click('[data-private-room-join-popup-confirm="1"]')

  await check('[2]+[3] confirm sends the exact (roomA, B, 0) and the viewer becomes a member navigated to the waiting room', async () => {
    await viewerPage.waitForFunction(() => (window as any).__diagHarness.getCurrentScreen() === 'private-room-waiting', null, { timeout: 10_000 })
    const frames = await diagFrames(viewerPage)
    const sentJoin = frames.sent.find((f: any) => f.type === 'join_private_room')
    assert(sentJoin !== undefined, 'no join_private_room was sent')
    assert(sentJoin.privateRoomId === roomIdA && sentJoin.team === 'B' && sentJoin.slotIndex === 0, `wrong payload: ${JSON.stringify(sentJoin)}`)
    const updated = frames.received.filter((f: any) => f.type === 'private_room_updated').pop()
    const b0 = updated.room.slots.find((s: any) => s.team === 'B' && s.slotIndex === 0)
    assert(b0.occupant !== null && b0.occupant.isBot === false, 'viewer did not land in B,0')
  })

  // ───────────────────────────────────────────────────────────────────────
  // Now the viewer is a real member of roomA. Re-open the list.
  // ───────────────────────────────────────────────────────────────────────
  await refreshRoomsList(viewerPage)
  await viewerPage.evaluate(() => (window as any).__diagHarness.controller.navigateToPrivateRooms())

  await check('[5] the own room (roomA) is pinned first in the list, ahead of roomC (created earlier)', async () => {
    const order = await viewerPage.evaluate(() =>
      Array.from(document.querySelectorAll('[data-private-room-list-enter], [data-private-room-list-slot-join]'))
        .map((el) => el.getAttribute('data-private-room-list-enter') ?? (el.getAttribute('data-private-room-list-slot-join') ?? '').split(':')[0]),
    )
    const firstRoomIdSeen = order.find((id: string) => id === roomIdA || id === roomIdC)
    assert(firstRoomIdSeen === roomIdA, `expected roomA first, DOM order was: ${JSON.stringify(order)}`)
  })

  await check('[6] the own room shows a "ВЛЕЗ" button', async () => {
    await viewerPage.locator(`[data-private-room-list-enter="${roomIdA}"]`).waitFor({ state: 'visible', timeout: 5_000 })
  })

  await check('[8] the own room has NO clickable "+" (no second-seat claim) — its remaining empty slots are non-interactive', async () => {
    const count = await viewerPage.locator(`[data-private-room-list-slot-join^="${roomIdA}:"]`).count()
    assert(count === 0, `expected 0 clickable "+" on own room, got ${count}`)
  })

  const sentCountBeforeEnter = (await diagFrames(viewerPage)).sent.length
  await viewerPage.click(`[data-private-room-list-enter="${roomIdA}"]`)

  await check('[7] "ВЛЕЗ" navigates to the waiting room WITHOUT sending a new join_private_room', async () => {
    await viewerPage.waitForFunction(() => (window as any).__diagHarness.getCurrentScreen() === 'private-room-waiting', null, { timeout: 5_000 })
    const frames = await diagFrames(viewerPage)
    assert(frames.sent.length === sentCountBeforeEnter, `ВЛЕЗ sent ${frames.sent.length - sentCountBeforeEnter} extra frame(s): ${JSON.stringify(frames.sent.slice(sentCountBeforeEnter))}`)
  })

  // ───────────────────────────────────────────────────────────────────────
  // Back to the list; try "+" on the OTHER room (roomC) while still seated
  // in roomA -> must show the conflict popup, not the join-confirm popup.
  // ───────────────────────────────────────────────────────────────────────
  await refreshRoomsList(viewerPage)
  await viewerPage.evaluate(() => (window as any).__diagHarness.controller.navigateToPrivateRooms())
  await viewerPage.click(`[data-private-room-list-slot-join="${roomIdC}:A:1"]`)

  await check('[9] clicking "+" on a DIFFERENT room while already seated shows the "already seated" conflict popup, not the join popup', async () => {
    await viewerPage.locator('[data-private-room-conflict-return="1"]').waitFor({ state: 'visible', timeout: 5_000 })
    const joinPopupVisible = await viewerPage.locator('[data-private-room-join-popup-confirm="1"]').isVisible().catch(() => false)
    assert(!joinPopupVisible, 'the join-confirm popup should NOT be visible for a different-room conflict')
  })

  const sentCountBeforeConflictReturn = (await diagFrames(viewerPage)).sent.length
  await viewerPage.click('[data-private-room-conflict-return="1"]')

  await check('[10] "Върни се"/"Виж масата" navigates to the OWN room (roomA), not roomC, without a new join', async () => {
    await viewerPage.waitForFunction(() => (window as any).__diagHarness.getCurrentScreen() === 'private-room-waiting', null, { timeout: 5_000 })
    const frames = await diagFrames(viewerPage)
    assert(frames.sent.length === sentCountBeforeConflictReturn, 'conflict-return unexpectedly sent a new frame')
    const updated = frames.received.filter((f: any) => f.type === 'private_room_updated').pop()
    assert(updated.room.id === roomIdA, `expected to be back on roomA, got ${updated.room.id}`)
  })

  // ───────────────────────────────────────────────────────────────────────
  // [11] Explicit leave lifts the restriction — a normal "+" on roomC now
  // works.
  // ───────────────────────────────────────────────────────────────────────
  await viewerPage.evaluate(() => (window as any).__diagHarness.send({ type: 'leave_private_room' }))
  await viewerPage.waitForFunction(() => (window as any).__diagHarness.getReceivedFrames().some((f: any) => f.type === 'private_room_left'), null, { timeout: 10_000 })

  await refreshRoomsList(viewerPage)
  await viewerPage.evaluate(() => (window as any).__diagHarness.controller.navigateToPrivateRooms())
  await viewerPage.click(`[data-private-room-list-slot-join="${roomIdC}:A:1"]`)
  await viewerPage.locator('[data-private-room-join-popup-confirm="1"]').waitFor({ state: 'visible', timeout: 5_000 })
  await viewerPage.click('[data-private-room-join-popup-confirm="1"]')

  await check('[11] after an explicit leave, the same profile can join a DIFFERENT room via a normal list "+"', async () => {
    await viewerPage.waitForFunction(() => (window as any).__diagHarness.getCurrentScreen() === 'private-room-waiting', null, { timeout: 10_000 })
    const frames = await diagFrames(viewerPage)
    const updated = frames.received.filter((f: any) => f.type === 'private_room_updated').pop()
    assert(updated.room.id === roomIdC, `expected to have joined roomC, got ${updated.room.id}`)
  })

  // ───────────────────────────────────────────────────────────────────────
  // [12] Stale own-room reconciliation: inject a private_rooms_list that no
  // longer contains the viewer's real room (simulating the expiry-race the
  // task spec describes), WITHOUT clearing state.myPrivateRoom — the list
  // must not show a stale "ВЛЕЗ", and must not block a fresh join elsewhere.
  // ───────────────────────────────────────────────────────────────────────
  const hostD = await registerProfile(backendPort, 'hostD')
  const { page: hostDPage } = await openConnectedPage(hostD)
  const roomIdD = await createOpenRoom(hostDPage)

  // Fetch the REAL current list (contains roomC — the viewer's genuine
  // current membership — plus roomD), then inject a manually-filtered copy
  // with roomC removed, WITHOUT touching state.myPrivateRoom. This is the
  // most direct simulation of the exact race the task spec describes: the
  // canonical private_rooms_list moved on (roomC expired/closed/started)
  // before the corresponding private_room_left/expired message arrived.
  await refreshRoomsList(viewerPage)
  const roomsWithoutC = await viewerPage.evaluate((excludeId) => {
    const frames = (window as any).__diagHarness.getReceivedFrames().filter((f: any) => f.type === 'private_rooms_list')
    const latest = frames[frames.length - 1]
    return latest.rooms.filter((r: any) => r.id !== excludeId)
  }, roomIdC)
  await viewerPage.evaluate(
    (rooms) => (window as any).__diagHarness.controller.handleServerMessage({ type: 'private_rooms_list', rooms }),
    roomsWithoutC,
  )
  await viewerPage.evaluate(() => (window as any).__diagHarness.controller.navigateToPrivateRooms())

  await check('[12a] a stale state.myPrivateRoom (absent from a fresh private_rooms_list) does not render a stale "ВЛЕЗ"', async () => {
    const enterCount = await viewerPage.locator('[data-private-room-list-enter]').count()
    assert(enterCount === 0, `expected no ВЛЕЗ button with a stale/absent own room, found ${enterCount}`)
  })

  // Still on the deliberately-stale (roomC-less) list state — click "+" on
  // roomD, which IS present in the injected list.
  await viewerPage.click(`[data-private-room-list-slot-join="${roomIdD}:A:1"]`)

  await check('[12b] while own-room membership is stale/absent from the list, "+" on a new room opens the normal join popup — no false conflict block', async () => {
    await viewerPage.locator('[data-private-room-join-popup-confirm="1"]').waitFor({ state: 'visible', timeout: 5_000 })
    const conflictVisible = await viewerPage.locator('[data-private-room-conflict-return="1"]').isVisible().catch(() => false)
    assert(!conflictVisible, 'stale own-room state incorrectly blocked a fresh join with the conflict popup')
  })
  await viewerPage.click('[data-private-room-join-popup-cancel="1"]')

  // Restore the viewer's client-side list state to the real, current truth
  // (roomC included again) before moving on, so later scenarios (which
  // reuse hostAPage/other actors, not viewerPage) are unaffected either way
  // — viewerPage itself is not touched again after this point.
  await refreshRoomsList(viewerPage)

  // ───────────────────────────────────────────────────────────────────────
  // [13] Occupied human slot click never sends a join and does not crash.
  // ───────────────────────────────────────────────────────────────────────
  const pageErrorsForMemberClick: string[] = []
  hostAPage.on('pageerror', (e) => pageErrorsForMemberClick.push(e.message))
  await refreshRoomsList(hostAPage)
  await hostAPage.evaluate(() => (window as any).__diagHarness.controller.navigateToPrivateRooms())
  const sentBeforeMemberClick = (await diagFrames(hostAPage)).sent.length

  await check('[13] clicking an occupied human slot never sends a join and does not throw', async () => {
    const memberBtn = hostAPage.locator(`[data-private-room-member]`).first()
    await memberBtn.waitFor({ state: 'visible', timeout: 5_000 })
    await memberBtn.click()
    await sleep(200)
    assert(pageErrorsForMemberClick.length === 0, `page errors: ${pageErrorsForMemberClick.join(' | ')}`)
    const frames = await diagFrames(hostAPage)
    assert(frames.sent.length === sentBeforeMemberClick, 'clicking an occupied member slot unexpectedly sent a frame')
  })

  await viewerCtx.close()

  // ───────────────────────────────────────────────────────────────────────
  // [14] Mobile viewport — no horizontal overflow on a 4-slot team layout.
  // ───────────────────────────────────────────────────────────────────────
  const mobileViewer = await registerProfile(backendPort, 'mobileViewer')
  const { context: mobileCtx, page: mobilePage } = await openConnectedPage(mobileViewer, { width: 375, height: 812 })
  await refreshRoomsList(mobilePage)
  await mobilePage.evaluate(() => (window as any).__diagHarness.controller.navigateToPrivateRooms())

  await check('[14] mobile viewport (375x812): the list with team/slot cards has no horizontal overflow', async () => {
    await mobilePage.locator('[data-private-room-list-slot-join]').first().waitFor({ state: 'visible', timeout: 5_000 })
    const overflow = await mobilePage.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)
    assert(!overflow, 'horizontal overflow detected on the mobile private-rooms list')
  })
  await mobileCtx.close()

  // ───────────────────────────────────────────────────────────────────────
  // [15] A genuinely rejected direct list join (slot race) shows a visible
  // info toast, not a silent no-op.
  // ───────────────────────────────────────────────────────────────────────
  const racerA = await registerProfile(backendPort, 'racerA')
  const racerB = await registerProfile(backendPort, 'racerB')
  const { page: racerAPage } = await openConnectedPage(racerA)
  const { context: racerBCtx, page: racerBPage } = await openConnectedPage(racerB)
  const roomIdE = await createOpenRoom(racerAPage)

  await refreshRoomsList(racerBPage)
  await racerBPage.evaluate(() => (window as any).__diagHarness.controller.navigateToPrivateRooms())
  await racerBPage.click(`[data-private-room-list-slot-join="${roomIdE}:B:0"]`)
  await racerBPage.locator('[data-private-room-join-popup-confirm="1"]').waitFor({ state: 'visible', timeout: 5_000 })

  // A third profile grabs B,0 first, via a real completed round trip.
  const racerC = await registerProfile(backendPort, 'racerC')
  const { context: racerCCtx, page: racerCPage } = await openConnectedPage(racerC)
  await racerCPage.evaluate((id) => (window as any).__diagHarness.send({ type: 'join_private_room', privateRoomId: id, team: 'B', slotIndex: 0 }), roomIdE)
  await racerCPage.waitForFunction(() => (window as any).__diagHarness.getReceivedFrames().some((f: any) => f.type === 'private_room_updated'), null, { timeout: 10_000 })

  await racerBPage.click('[data-private-room-join-popup-confirm="1"]')

  await check('[15] a rejected direct list join (slot already taken) shows a visible, non-empty info toast', async () => {
    await racerBPage.locator('[data-private-room-info-toast="1"]').waitFor({ state: 'visible', timeout: 5_000 })
    const text = await racerBPage.locator('[data-private-room-info-toast="1"]').textContent()
    assert(!!text && text.trim().length > 0, 'expected non-empty info toast text')
    const screen = await racerBPage.evaluate(() => (window as any).__diagHarness.getCurrentScreen())
    assert(screen === 'private-rooms', `rejected join must not navigate away from the list, got ${screen}`)
  })

  await racerBCtx.close()
  await racerCCtx.close()
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
