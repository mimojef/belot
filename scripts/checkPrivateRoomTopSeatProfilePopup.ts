/**
 * checkPrivateRoomTopSeatProfilePopup.ts
 *
 * Real backend (spawned Node process, isolated temp copy) + real Vite dev
 * server + real Chromium (Playwright), driving a REAL private-room -> active
 * -game transition (create_private_room -> join_private_room{team,slotIndex}
 * x3 -> private_room_full -> real cutting/bidding auto-driven to 'playing')
 * with FOUR real browser clients, one per authoritative seat.
 *
 * Regression coverage for a manual-test report: clicking the seat visually
 * shown at "Горе" (top) during active gameplay opened "Няма наличен профил
 * ... за Горе" instead of the partner's real profile, while the other three
 * seats worked. Investigation (real server WS responses, real synthetic-DOM
 * clicks, and this full real-stack reproduction — 16 seat/perspective
 * combinations total) found the underlying request_player_profile /
 * data-profile-seat-btn / room.seats[seat].participant pipeline to be
 * correct end-to-end in the current codebase: every click, from every
 * possible local-perspective rotation, resolves to the real occupant's
 * profileId, never the seat name or its Cyrillic label. This suite exists
 * to prove that and guard it going forward — not to fix a defect that
 * wasn't found (see the audit report for the full investigation trail).
 *
 * Uses activeRoomRealWsHarness.ts (real createActiveRoomFlowController(),
 * wired to a genuine browser WebSocket — mirrors main.ts's actual dispatch,
 * including the private_room_full -> enterActiveRoom(match_found) handoff)
 * with its auto-drive capability for cutting/bidding, so a real browser can
 * reach 'playing' without a human at the controls.
 *
 * Covers:
 *  [1]  the private-room deterministic mapping (A0/A1/B0/B1 ->
 *       bottom/top/right/left) survives materialization into the active
 *       room: all 4 data-profile-seat-btn DOM values are the 4 real seats.
 *  [2]  clicking "top" sends request_player_profile{seat:'top'} — the
 *       REAL seat identifier, never a display label.
 *  [3]  the server's player_profile response for seat='top' carries the
 *       real occupant's profileId/displayName (A1's actual participant),
 *       not null.
 *  [4]  the rendered popup shows that real displayName, not "Няма наличен
 *       профил".
 *  [5]  the other three seats (bottom/right/left) continue to resolve
 *       correctly from the SAME local perspective.
 *  [6]  the invariant holds from EVERY local-perspective rotation (each of
 *       the 4 real participants clicking all 4 seats from their own client)
 *       — proves visualSeat (rotated layout) is never conflated with the
 *       authoritative seat used for profile resolution.
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
    await sleep(150)
  }
  throw new Error(`Timeout: ${label}`)
}

async function httpJson(port: number, method: string, pathname: string, cookie: string | null, body?: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const setCookie = (res.headers.getSetCookie?.()[0] ?? res.headers.get('set-cookie'))?.split(';')[0] ?? null
  let json: any = null
  try { json = await res.json() } catch { /* not json */ }
  return { status: res.status, body: json, setCookie }
}

async function registerProfile(port: number, tag: string): Promise<{ cookieToken: string; profileId: string; displayName: string }> {
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const displayName = `TS ${tag}`
  const reg = await httpJson(port, 'POST', '/api/auth/register', null, {
    email: `top-seat-${tag}-${runId}@example.test`,
    password: 'TopSeatDiag1!',
    displayName,
    gender: 'male',
  })
  if (reg.status !== 200) throw new Error(`Registration failed for ${tag}: ${JSON.stringify(reg.body)}`)
  return { cookieToken: (reg.setCookie as string).split('=')[1], profileId: reg.body.session.profile.profileId, displayName }
}

const sourceServerRoot = resolve(process.cwd(), 'server')

async function retryRm(path: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try { await rm(path, { recursive: true, force: true }); return } catch { /* retry */ }
    await sleep(250)
  }
}

async function createIsolatedServerRoot(originalServerRoot: string) {
  const root = await mkdtemp(join(tmpdir(), 'belot-top-seat-profile-'))
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

console.log('\ncheckPrivateRoomTopSeatProfilePopup\n')

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
  const fixtureUrl = `http://127.0.0.1:${vitePort}/scripts/fixtures/activeRoomRealWsHarness.html`

  browser = await chromium.launch()

  async function openConnectedPage(profile: { cookieToken: string; profileId: string; displayName: string }): Promise<{ context: BrowserContext; page: Page }> {
    const context = await browser!.newContext()
    await context.addCookies([{ name: 'belot_session', value: profile.cookieToken, url: backendOrigin }])
    const page = await context.newPage()
    const pageErrors: string[] = []
    page.on('pageerror', (e) => pageErrors.push(e.message))
    await page.goto(fixtureUrl)
    await page.evaluate((url) => (window as any).__activeRoomRealWsHarness.connect(url), wsUrl)
    await page.evaluate(() => (window as any).__activeRoomRealWsHarness.setAutoDrive(true))
    if (pageErrors.length > 0) throw new Error(`page errors during setup: ${pageErrors.join(' | ')}`)
    return { context, page }
  }

  // A0 -> bottom (hostA, creator), A1 -> top (guest1, partner), B0 -> right
  // (guest2), B1 -> left (guest3) — the exact private-room deterministic
  // mapping from the task spec.
  const hostA = await registerProfile(backendPort, 'hostA')
  const guest1 = await registerProfile(backendPort, 'guest1')
  const guest2 = await registerProfile(backendPort, 'guest2')
  const guest3 = await registerProfile(backendPort, 'guest3')

  const { page: hostAPage } = await openConnectedPage(hostA)
  const { page: guest1Page } = await openConnectedPage(guest1)
  const { page: guest2Page } = await openConnectedPage(guest2)
  const { page: guest3Page } = await openConnectedPage(guest3)

  await hostAPage.evaluate(() => (window as any).__activeRoomRealWsHarness.send({ type: 'create_private_room', stake: 5000, isLocked: false }))
  await hostAPage.waitForFunction(() => (window as any).__activeRoomRealWsHarness.getReceivedFrames().some((f: any) => f.type === 'private_room_updated'), null, { timeout: 10_000 })
  const roomId: string = (await hostAPage.evaluate(() =>
    (window as any).__activeRoomRealWsHarness.getReceivedFrames().filter((f: any) => f.type === 'private_room_updated').pop(),
  )).room.id

  await guest1Page.evaluate((id) => (window as any).__activeRoomRealWsHarness.send({ type: 'join_private_room', privateRoomId: id, team: 'A', slotIndex: 1 }), roomId)
  await hostAPage.waitForFunction(() => (window as any).__activeRoomRealWsHarness.getReceivedFrames().some((f: any) => f.type === 'private_room_updated' && f.room.slots.filter((s: any) => s.occupant !== null).length === 2), null, { timeout: 10_000 })

  await guest2Page.evaluate((id) => (window as any).__activeRoomRealWsHarness.send({ type: 'join_private_room', privateRoomId: id, team: 'B', slotIndex: 0 }), roomId)
  await hostAPage.waitForFunction(() => (window as any).__activeRoomRealWsHarness.getReceivedFrames().some((f: any) => f.type === 'private_room_updated' && f.room.slots.filter((s: any) => s.occupant !== null).length === 3), null, { timeout: 10_000 })

  await guest3Page.evaluate((id) => (window as any).__activeRoomRealWsHarness.send({ type: 'join_private_room', privateRoomId: id, team: 'B', slotIndex: 1 }), roomId)

  for (const p of [hostAPage, guest1Page, guest2Page, guest3Page]) {
    await p.waitForFunction(() => (window as any).__activeRoomRealWsHarness.getReceivedFrames().some((f: any) => f.type === 'private_room_full'), null, { timeout: 10_000 })
  }

  console.log('Private room full — driving through cutting + bidding to reach playing...')
  await hostAPage.waitForFunction(() => {
    const frames = (window as any).__activeRoomRealWsHarness.getReceivedFrames()
    const last = [...frames].reverse().find((f: any) => f.type === 'room_snapshot')
    return last?.game?.authoritativePhase === 'playing'
  }, null, { timeout: 60_000 })
  console.log('Reached playing phase.\n')

  await check('[1] all 4 authoritative seats render a data-profile-seat-btn in the real active-game DOM', async () => {
    await hostAPage.waitForFunction(() => document.body.querySelectorAll('[data-profile-seat-btn]').length === 4, null, { timeout: 10_000 })
    const attrs: string[] = await hostAPage.evaluate(() => (window as any).__activeRoomRealWsHarness.getSeatProfileBtnAttrs())
    for (const seat of ['bottom', 'top', 'right', 'left']) {
      assert(attrs.includes(seat), `missing data-profile-seat-btn for "${seat}"; found: ${JSON.stringify(attrs)}`)
    }
  })

  async function clickAndInspect(page: Page, seat: string): Promise<{ sentSeat: string; serverProfileName: string | null; popupNormalized: string }> {
    const sentBefore = await page.evaluate(() => (window as any).__activeRoomRealWsHarness.getSentFrames().length)
    const clicked = await page.evaluate((s) => (window as any).__activeRoomRealWsHarness.clickSeatProfile(s), seat)
    assert(clicked, `no clickable data-profile-seat-btn found for seat "${seat}"`)
    await page.waitForFunction((s) => {
      const frames = (window as any).__activeRoomRealWsHarness.getReceivedFrames()
      return frames.some((f: any) => f.type === 'player_profile' && f.seat === s)
    }, seat, { timeout: 10_000 })
    const sentFrames = await page.evaluate(() => (window as any).__activeRoomRealWsHarness.getSentFrames())
    const requestFrame = sentFrames.slice(sentBefore).find((f: any) => f.type === 'request_player_profile')
    const profileFrame = await page.evaluate((s) => {
      const frames = (window as any).__activeRoomRealWsHarness.getReceivedFrames()
      return [...frames].reverse().find((f: any) => f.type === 'player_profile' && f.seat === s)
    }, seat)
    const popupText = await page.evaluate(() => (window as any).__activeRoomRealWsHarness.getPopupBodyText())
    return {
      sentSeat: requestFrame?.seat ?? '<none>',
      serverProfileName: profileFrame?.profile?.displayName ?? null,
      popupNormalized: (popupText ?? '').replace(/\s+/g, ' ').trim(),
    }
  }

  await check('[2] clicking "top" sends request_player_profile with the real seat identifier "top" (not a display label)', async () => {
    const result = await clickAndInspect(hostAPage, 'top')
    assert(result.sentSeat === 'top', `expected sent seat "top", got "${result.sentSeat}"`)
    assert(result.sentSeat !== 'Горе', 'sent the Cyrillic label instead of the seat identifier')
  })

  await check('[3] the server\'s player_profile response for "top" carries guest1\'s real profile, not null', async () => {
    const result = await clickAndInspect(hostAPage, 'top')
    assert(result.serverProfileName === guest1.displayName, `expected "${guest1.displayName}", got ${JSON.stringify(result.serverProfileName)}`)
  })

  await check('[4] the rendered popup shows the real partner\'s displayName, never "Няма наличен профил"', async () => {
    const result = await clickAndInspect(hostAPage, 'top')
    assert(!result.popupNormalized.includes('Няма наличен профил'), `popup incorrectly shows the empty-profile fallback: ${result.popupNormalized.slice(0, 200)}`)
    assert(result.popupNormalized.includes(guest1.displayName), `popup does not show guest1's name: ${result.popupNormalized.slice(0, 200)}`)
  })

  await check('[5] the other three seats (bottom/right/left) continue to resolve correctly from hostA\'s perspective', async () => {
    const expectations: Array<[string, string]> = [['bottom', hostA.displayName], ['right', guest2.displayName], ['left', guest3.displayName]]
    for (const [seat, expectedName] of expectations) {
      const result = await clickAndInspect(hostAPage, seat)
      assert(result.serverProfileName === expectedName, `seat "${seat}": expected "${expectedName}", got ${JSON.stringify(result.serverProfileName)}`)
      assert(result.popupNormalized.includes(expectedName), `seat "${seat}": popup does not show "${expectedName}"`)
      assert(!result.popupNormalized.includes('Няма наличен профил'), `seat "${seat}": popup incorrectly shows the empty-profile fallback`)
    }
  })

  await check('[6] the invariant holds from EVERY local-perspective rotation (visualSeat is never conflated with the authoritative seat)', async () => {
    const perspectives: Array<{ page: Page; label: string }> = [
      { page: guest1Page, label: 'guest1 (authoritative top)' },
      { page: guest2Page, label: 'guest2 (authoritative right)' },
      { page: guest3Page, label: 'guest3 (authoritative left)' },
    ]
    const expectedBySeat: Record<string, string> = { bottom: hostA.displayName, top: guest1.displayName, right: guest2.displayName, left: guest3.displayName }
    for (const { page, label } of perspectives) {
      for (const seat of ['bottom', 'top', 'right', 'left']) {
        const result = await clickAndInspect(page, seat)
        assert(result.sentSeat === seat, `[${label}] click "${seat}" sent seat "${result.sentSeat}"`)
        assert(result.serverProfileName === expectedBySeat[seat], `[${label}] seat "${seat}": expected "${expectedBySeat[seat]}", got ${JSON.stringify(result.serverProfileName)}`)
        assert(!result.popupNormalized.includes('Няма наличен профил'), `[${label}] seat "${seat}": popup incorrectly shows the empty-profile fallback`)
      }
    }
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
