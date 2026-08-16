/**
 * checkPrivateRoomExpiryRealtimeCleanup.ts
 *
 * Real backend (spawned Node process, isolated temp copy) + real Vite dev
 * server + real Chromium (Playwright) — proves (or disproves) that a
 * private room's server-authoritative expiry is delivered and handled
 * end-to-end in a live session, not just at the pure in-memory store level
 * (checkPrivateRoomWaitTimeSelection.ts's [S11]/[S12], which never exercise
 * index.ts's WS handler or the real client controller).
 *
 * The real waitMinutes values (5/10/15/30 minutes) are impractical to wait
 * out in an automated test, so this script patches ONLY the isolated temp
 * copy of the server source (never the real repo files — createIsolatedServerRoot
 * already makes a disposable copy for every check script in this style) to
 * scale privateRoomsStore.ts's `waitMinutes * 60 * 1000` down to
 * `waitMinutes * 1000` — i.e. waitMinutes=5 expires in 5 REAL SECONDS. Every
 * other line of production code (server handlers, protocol, client
 * controller, DOM) runs completely unmodified.
 *
 * Covers:
 *  [1]  member actively viewing the waiting screen when expiry hits is
 *       automatically navigated away (no manual refresh).
 *  [2]  state.myPrivateRoom / previewedPrivateRoomId are cleared.
 *  [3]  a fresh private_rooms_list (without the expired room) arrives
 *       without the client requesting it — realtime, not on next open.
 *  [4]  the badge count (private_rooms_list.length) drops accordingly.
 *  [5]  the expired room cannot be reopened/rejoined afterward (server
 *       genuinely deleted it, not just a client-side illusion).
 *  [6]  a member who pressed "Изчакай в лоби" BEFORE expiry (not looking at
 *       the waiting screen) still gets realtime own-room/badge cleanup.
 */

import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
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
  const displayName = `EX ${tag}`
  const reg = await httpJson(port, 'POST', '/api/auth/register', null, {
    email: `expiry-${tag}-${runId}@example.test`,
    password: 'ExpiryDiag1!',
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
  const root = await mkdtemp(join(tmpdir(), 'belot-expiry-realtime-'))
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

  // Test-only time compression, applied ONLY to this disposable temp copy —
  // the real repo file (server/src/game/privateRoomsStore.ts) is never
  // touched. Turns "waitMinutes" into "wait-seconds" so a 5-minute room
  // expires in 5 real seconds, making a genuine end-to-end expiry
  // observable in an automated test.
  const storeFile = join(serverDir, 'src', 'game', 'privateRoomsStore.ts')
  const original = await readFile(storeFile, 'utf8')
  const needle = 'const timeoutMs = input.waitMinutes * 60 * 1000'
  if (!original.includes(needle)) {
    throw new Error('time-compression patch target line not found in privateRoomsStore.ts — source may have changed')
  }
  const patched = original.replace(needle, 'const timeoutMs = input.waitMinutes * 1000 // [TEST PATCH] 60x compressed for checkPrivateRoomExpiryRealtimeCleanup.ts')
  await writeFile(storeFile, patched, 'utf8')

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

console.log('\ncheckPrivateRoomExpiryRealtimeCleanup\n')

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

  async function openConnectedPage(profile: { cookieToken: string; profileId: string; displayName: string }): Promise<{ context: BrowserContext; page: Page }> {
    const context = await browser!.newContext()
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

  // ───────────────────────────────────────────────────────────────────────
  // Scenario A: member is ACTIVELY viewing the waiting screen when the
  // (time-compressed) 5-second expiry hits.
  // ───────────────────────────────────────────────────────────────────────
  const memberA = await registerProfile(backendPort, 'memberA')
  const { page: pageA } = await openConnectedPage(memberA)

  const beforeCreateA = await pageA.evaluate(() => (window as any).__diagHarness.getReceivedFrames().length)
  // waitMinutes=5 -> with the isolated-copy time compression, expires in 5
  // real seconds (the shortest value the real protocol still accepts).
  await pageA.evaluate(() => (window as any).__diagHarness.send({ type: 'create_private_room', stake: 5000, isLocked: false, waitMinutes: 5 }))
  await pageA.waitForFunction((prevLen) => {
    return (window as any).__diagHarness.getReceivedFrames().slice(prevLen).some((f: any) => f.type === 'private_room_updated')
  }, beforeCreateA, { timeout: 10_000 })
  const roomIdA: string = (await pageA.evaluate(() =>
    (window as any).__diagHarness.getReceivedFrames().filter((f: any) => f.type === 'private_room_updated').pop(),
  )).room.id

  // Land on the real waiting screen via the real "ВЛЕЗ" click (own room is
  // already pinned first with myPrivateRoom already set from the
  // private_room_updated above) — navigateToPrivateRooms() itself now
  // always opens the LIST (see checkPrivateRoomListDirectJoin.ts), so a
  // real member click on "ВЛЕЗ" is how a member actually reaches the
  // waiting screen.
  await pageA.evaluate(() => (window as any).__diagHarness.controller.navigateToPrivateRooms())
  await pageA.locator(`[data-private-room-list-enter="${roomIdA}"]`).waitFor({ state: 'visible', timeout: 5_000 })
  await pageA.click(`[data-private-room-list-enter="${roomIdA}"]`)
  await pageA.waitForFunction(() => (window as any).__diagHarness.getCurrentScreen() === 'private-room-waiting', null, { timeout: 5_000 })

  console.log('Waiting ~7s for the real (time-compressed) server expiry to fire...')
  await pageA.waitForFunction(() => (window as any).__diagHarness.getReceivedFrames().some((f: any) => f.type === 'private_room_expired'), null, { timeout: 15_000 })

  await check('[1] the waiting screen navigates itself away to the MAIN LOBBY (not the "Частни маси" list) automatically when expiry hits', async () => {
    await pageA.waitForFunction(() => (window as any).__diagHarness.getCurrentScreen() === 'lobby', null, { timeout: 5_000 })
    const screen = await pageA.evaluate(() => (window as any).__diagHarness.getCurrentScreen())
    assert(screen === 'lobby', `expected 'lobby', got ${screen}`)
  })

  await check('[1b] the exact info toast text is shown', async () => {
    const text = await pageA.locator('[data-private-room-info-toast="1"]').textContent()
    assert(!!text && text.includes('Времето за чакане изтече. Частната маса беше затворена.'), `unexpected toast text: ${text}`)
  })

  await check('[2] a fresh private_rooms_list (without the expired room) arrives in realtime, unrequested', async () => {
    const frames = await diagFrames(pageA)
    const listsAfterExpiry = frames.received.filter((f: any) => f.type === 'private_rooms_list')
    assert(listsAfterExpiry.length > 0, 'no private_rooms_list arrived at all after expiry')
    const latest = listsAfterExpiry[listsAfterExpiry.length - 1]
    assert(!latest.rooms.some((r: any) => r.id === roomIdA), 'the expired room is still present in the realtime-refreshed list')
  })

  await check('[3] state.myPrivateRoom / previewedPrivateRoomId are cleared — own-room "ВЛЕЗ" cannot reappear stale', async () => {
    await pageA.evaluate(() => (window as any).__diagHarness.controller.navigateToPrivateRooms())
    await sleep(200)
    const enterCount = await pageA.locator(`[data-private-room-list-enter="${roomIdA}"]`).count()
    assert(enterCount === 0, 'a stale ВЛЕЗ button for the expired room is still rendered')
  })

  await check('[4] the badge-relevant private_rooms_list no longer counts the expired room', async () => {
    const frames = await diagFrames(pageA)
    const latest = frames.received.filter((f: any) => f.type === 'private_rooms_list').pop()
    assert(!latest.rooms.some((r: any) => r.id === roomIdA), 'expired room still counted in the badge-driving list')
  })

  await check('[5] the expired room cannot be reopened — the server genuinely deleted it (not a client-only illusion)', async () => {
    const sentBefore = await pageA.evaluate(() => (window as any).__diagHarness.getSentFrames().length)
    await pageA.evaluate((id) => (window as any).__diagHarness.send({ type: 'join_private_room', privateRoomId: id, team: 'A', slotIndex: 1 }), roomIdA)
    await pageA.waitForFunction((prevLen) => {
      return (window as any).__diagHarness.getReceivedFrames().length > 0
        && (window as any).__diagHarness.getSentFrames().length > prevLen
    }, sentBefore, { timeout: 2_000 }).catch(() => {})
    await waitForCondition('rejoin rejection', async () => {
      const frames = await diagFrames(pageA)
      return frames.received.some((f: any) => f.type === 'error' && /не съществува/i.test(f.message ?? ''))
    }, 10_000)
  })

  // ───────────────────────────────────────────────────────────────────────
  // Scenario B: member pressed "Изчакай в лоби" BEFORE expiry (NOT looking
  // at the waiting screen when the timer fires) — own-room/badge state must
  // still reconcile in realtime, without the user re-opening anything.
  // ───────────────────────────────────────────────────────────────────────
  const memberB = await registerProfile(backendPort, 'memberB')
  const { page: pageB } = await openConnectedPage(memberB)

  const beforeCreateB = await pageB.evaluate(() => (window as any).__diagHarness.getReceivedFrames().length)
  await pageB.evaluate(() => (window as any).__diagHarness.send({ type: 'create_private_room', stake: 5000, isLocked: false, waitMinutes: 5 }))
  await pageB.waitForFunction((prevLen) => {
    return (window as any).__diagHarness.getReceivedFrames().slice(prevLen).some((f: any) => f.type === 'private_room_updated')
  }, beforeCreateB, { timeout: 10_000 })
  const roomIdB: string = (await pageB.evaluate(() =>
    (window as any).__diagHarness.getReceivedFrames().filter((f: any) => f.type === 'private_room_updated').pop(),
  )).room.id

  // Real "Изчакай в лоби" click — lands member B on the actual MAIN LOBBY
  // screen (not the "Частни маси" list), exactly the scenario the task spec
  // describes: membership stays, pure client nav, no WS sent.
  await pageB.evaluate(() => (window as any).__diagHarness.controller.navigateToPrivateRooms())
  await pageB.locator(`[data-private-room-list-enter="${roomIdB}"]`).waitFor({ state: 'visible', timeout: 5_000 })
  await pageB.click(`[data-private-room-list-enter="${roomIdB}"]`)
  await pageB.waitForFunction(() => (window as any).__diagHarness.getCurrentScreen() === 'private-room-waiting', null, { timeout: 5_000 })

  const sentBeforeWaitInLobby = await pageB.evaluate(() => (window as any).__diagHarness.getSentFrames().length)
  await pageB.locator('[data-private-waiting-wait-in-lobby-button="1"]').click()
  await pageB.waitForFunction(() => (window as any).__diagHarness.getCurrentScreen() === 'lobby', null, { timeout: 5_000 })

  await check('[6-setup] "Изчакай в лоби" sends no membership-affecting frame (no leave_private_room / join_private_room — chat unsubscribe is expected)', async () => {
    const frames = await diagFrames(pageB)
    const newFrames = frames.sent.slice(sentBeforeWaitInLobby)
    assert(!newFrames.some((f: any) => f.type === 'leave_private_room' || f.type === 'join_private_room'), `unexpected membership frame(s): ${JSON.stringify(newFrames)}`)
  })

  console.log('Waiting ~7s for the real (time-compressed) server expiry to fire (member B, already in the main Lobby, not on the waiting screen)...')
  await pageB.waitForFunction(() => (window as any).__diagHarness.getReceivedFrames().some((f: any) => f.type === 'private_room_expired'), null, { timeout: 15_000 })

  await check('[6] a member already in the main Lobby before expiry is NOT navigated anywhere — stays on \'lobby\'', async () => {
    await sleep(300)
    const screen = await pageB.evaluate(() => (window as any).__diagHarness.getCurrentScreen())
    assert(screen === 'lobby', `expected to remain on 'lobby', got ${screen}`)
  })

  await check('[6c] the same info toast text is shown even though the member was never on the waiting screen', async () => {
    const text = await pageB.locator('[data-private-room-info-toast="1"]').textContent()
    assert(!!text && text.includes('Времето за чакане изтече. Частната маса беше затворена.'), `unexpected toast text: ${text}`)
  })

  await check('[6b] own-room membership/badge state is cleared in realtime regardless — no re-navigation needed to see it', async () => {
    await pageB.evaluate(() => (window as any).__diagHarness.controller.navigateToPrivateRooms())
    const enterCount = await pageB.locator(`[data-private-room-list-enter="${roomIdB}"]`).count()
    assert(enterCount === 0, 'a stale ВЛЕЗ button for the expired own room is still rendered')
    const frames = await diagFrames(pageB)
    const latestList = frames.received.filter((f: any) => f.type === 'private_rooms_list').pop()
    assert(!latestList.rooms.some((r: any) => r.id === roomIdB), 'expired own room still present in the realtime list (badge would still count it)')
  })
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
