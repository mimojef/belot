/**
 * checkPrivateRoomHostTransferRealtime.ts
 *
 * Real backend + real Vite + real Chromium — the DOM/realtime-broadcast
 * complement to server/scripts/checkPrivateRoomHostTransferLifecycle.ts
 * (which proves the store-level invariants). This proves the part a pure
 * store unit test cannot: when the host leaves, the NEW host is reflected
 * correctly, in realtime, in every connected client's actual rendered DOM —
 * not just in the server's in-memory model.
 *
 * Covers:
 *  [1] after the host leaves, the remaining member's OWN waiting-room view
 *      shows themself with the "ДОМАКИН" badge.
 *  [2] a THIRD, uninvolved bystander connection (list screen, not a member)
 *      also observes the new host via its own private_rooms_list refresh —
 *      proving the broadcast is real, not just visible to the room's own
 *      members.
 *  [3] the departed original creator, if they were to look at the list
 *      again, no longer sees themselves as this room's host anywhere.
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
  const displayName = `HT ${tag}`
  const reg = await httpJson(port, 'POST', '/api/auth/register', null, {
    email: `host-transfer-${tag}-${runId}@example.test`,
    password: 'HostTransferDiag1!',
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
  const root = await mkdtemp(join(tmpdir(), 'belot-host-transfer-'))
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

console.log('\ncheckPrivateRoomHostTransferRealtime\n')

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

  const creator = await registerProfile(backendPort, 'creator')
  const marta = await registerProfile(backendPort, 'marta')
  const bystander = await registerProfile(backendPort, 'bystander')

  const { page: creatorPage } = await openConnectedPage(creator)
  const { page: martaPage } = await openConnectedPage(marta)
  const { page: bystanderPage } = await openConnectedPage(bystander)

  // creator creates an open room; marta joins Team B,0.
  await creatorPage.evaluate(() => (window as any).__diagHarness.send({ type: 'create_private_room', stake: 5000, isLocked: false }))
  await creatorPage.waitForFunction(() => (window as any).__diagHarness.getReceivedFrames().some((f: any) => f.type === 'private_room_updated'), null, { timeout: 10_000 })
  const roomId: string = (await creatorPage.evaluate(() =>
    (window as any).__diagHarness.getReceivedFrames().filter((f: any) => f.type === 'private_room_updated').pop(),
  )).room.id

  await martaPage.evaluate((id) => (window as any).__diagHarness.send({ type: 'join_private_room', privateRoomId: id, team: 'B', slotIndex: 0 }), roomId)
  await martaPage.waitForFunction(() => (window as any).__diagHarness.getReceivedFrames().some((f: any) => f.type === 'private_room_updated'), null, { timeout: 10_000 })

  // bystander is just browsing the list (not a member) — must see the room
  // in its private_rooms_list with the creator as host, before the leave.
  await bystanderPage.evaluate(() => (window as any).__diagHarness.send({ type: 'request_private_rooms_list' }))
  await bystanderPage.waitForFunction(() => (window as any).__diagHarness.getReceivedFrames().some((f: any) => f.type === 'private_rooms_list'), null, { timeout: 10_000 })
  await bystanderPage.evaluate((id) => (window as any).__diagHarness.previewRoom(id), roomId)

  await check('[setup] bystander initially sees the ORIGINAL creator as host', async () => {
    const list = await bystanderPage.evaluate(() => (window as any).__diagHarness.getReceivedFrames().filter((f: any) => f.type === 'private_rooms_list').pop())
    const room = list.rooms.find((r: any) => r.id === roomId)
    const hostSlot = room.slots.find((s: any) => s.occupant?.isHost === true)
    assert(hostSlot?.occupant?.profileId === creator.profileId, 'expected the creator to be the initially-listed host')
  })

  const bystanderListFramesBefore = await bystanderPage.evaluate(() => (window as any).__diagHarness.getReceivedFrames().filter((f: any) => f.type === 'private_rooms_list').length)

  // THE ACTION: the creator (host) leaves.
  await creatorPage.evaluate(() => (window as any).__diagHarness.send({ type: 'leave_private_room' }))
  await creatorPage.waitForFunction(() => (window as any).__diagHarness.getReceivedFrames().some((f: any) => f.type === 'private_room_left'), null, { timeout: 10_000 })

  await check('[1] marta\'s OWN waiting-room DOM shows herself with the "ДОМАКИН" badge after the host leaves', async () => {
    await martaPage.waitForFunction(() => {
      const frames = (window as any).__diagHarness.getReceivedFrames().filter((f: any) => f.type === 'private_room_updated')
      const last = frames[frames.length - 1]
      return last && last.room.slots.find((s: any) => s.team === 'B' && s.slotIndex === 0)?.occupant?.isHost === true
    }, null, { timeout: 10_000 })
    await martaPage.evaluate(() => (window as any).__diagHarness.controller.navigateToPrivateRooms())
    await martaPage.click(`[data-private-room-list-enter="${roomId}"]`)
    const bodyText = await martaPage.evaluate(() => document.body.textContent ?? '')
    assert(bodyText.includes('ДОМАКИН'), 'expected the ДОМАКИН badge to be visible in marta\'s own waiting-room view')
  })

  await check('[2] a completely uninvolved bystander connection also observes the new host in realtime (via its own private_rooms_list refresh, unrequested)', async () => {
    await bystanderPage.waitForFunction((prevCount) => {
      return (window as any).__diagHarness.getReceivedFrames().filter((f: any) => f.type === 'private_rooms_list').length > prevCount
    }, bystanderListFramesBefore, { timeout: 10_000 })
    const list = await bystanderPage.evaluate(() => (window as any).__diagHarness.getReceivedFrames().filter((f: any) => f.type === 'private_rooms_list').pop())
    const room = list.rooms.find((r: any) => r.id === roomId)
    assert(room !== undefined, 'room disappeared from the bystander\'s list — it should still exist (marta remains)')
    const hostSlot = room.slots.find((s: any) => s.occupant?.isHost === true)
    assert(hostSlot?.occupant?.profileId === marta.profileId, `expected marta as the new host in the bystander's realtime view, got ${hostSlot?.occupant?.profileId}`)
    assert(!room.slots.some((s: any) => s.occupant?.profileId === creator.profileId), 'the old creator is still listed as an occupant somewhere')
  })

  await check('[3] the room no longer lists the old creator anywhere, as host or otherwise', async () => {
    const list = await bystanderPage.evaluate(() => (window as any).__diagHarness.getReceivedFrames().filter((f: any) => f.type === 'private_rooms_list').pop())
    const room = list.rooms.find((r: any) => r.id === roomId)
    assert(!room.slots.some((s: any) => s.occupant?.profileId === creator.profileId), 'old creator unexpectedly still present')
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
