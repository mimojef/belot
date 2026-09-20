// checkLudoForfeitPawnVisibility.ts
//
// Real spawned-server + real browser (Playwright, production controller,
// authoritative WS flow, real UI clicks) regression check for the visual bug
// reported after the explicit "Изход" forfeit feature: departing pieces flew
// home correctly but disappeared immediately after landing instead of
// staying visible.
//
// Root cause (see createLudoFlowController.ts::presentAuthoritativeForfeit):
// playLudoCaptureFlightOverlay() removes its OWN overlay DOM node as soon as
// its ~500ms flight finishes, but the underlying static board only revealed
// the landed piece (suppressedPieceIds.delete + render()) after awaiting the
// FULL max(5s, flights) window used for match-finishing forfeits — leaving a
// multi-second gap where the overlay is gone AND the static piece is still
// suppressed. Fix: reveal pieces as soon as their flights finish; only the
// dice/turn-UI gate + winner-popup timing wait for the remainder of the 5s.
//
// This test seeds a 2-player match (via a deterministic initialStateFactory
// patched into an ISOLATED COPY of index.ts only, never the tracked source)
// with the leaver already holding 2 pieces out of home + 2 pieces at home,
// so no real dice-rolling grind is needed. Both players are REAL Playwright
// pages driving the REAL production UI (create/join room, real Exit+Confirm
// click); DOM is polled on the survivor's page at multiple checkpoints
// across the 5s window.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Page } from 'playwright'
import { createServer as createViteServer } from 'vite'

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
const freePort = () => new Promise<number>((done, failPort) => {
  const server = createNetServer().once('error', failPort).listen(0, '127.0.0.1', () => {
    const address = server.address()
    if (!address || typeof address === 'string') return failPort(new Error('No free port'))
    server.close(() => done(address.port))
  })
})

const projectRoot = process.cwd()

async function createIsolatedServerRoot() {
  const root = await mkdtemp(join(tmpdir(), 'belot-ludo-forfeit-vis-'))
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
  return { root, serverDir, cleanup: () => rm(root, { recursive: true, force: true }).catch(() => undefined) }
}

// TEST-ONLY injection into the ISOLATED COPY of index.ts (never the tracked
// server/src/index.ts) — seeds a 2-player match where turnOrder[0] (the
// leaver) already has 2 pieces out of home (slot 0 on track, slot 1 in the
// finish lane) and 2 pieces still home, so the forfeit-collection flight can
// be exercised without any real dice-rolling grind. Mirrors the established
// pattern in server/scripts/checkLudoEconomy.ts::patchIndexTsForDeterministicLudoWin.
async function patchIndexTsForForfeitSeed(serverDir: string): Promise<void> {
  const indexPath = join(serverDir, 'src', 'index.ts')
  const original = await readFile(indexPath, 'utf8')
  const needle = 'const ludoMatchRuntime = createLudoMatchRuntime({\n  onSnapshot: (snapshot) => {'
  if (!original.includes(needle)) {
    throw new Error('patchIndexTsForForfeitSeed: anchor text not found in index.ts — update the test patch to match the current createLudoMatchRuntime call shape')
  }
  const injected = `const ludoMatchRuntime = createLudoMatchRuntime({
  // TEST-ONLY, isolated-copy-only injection — see checkLudoForfeitPawnVisibility.ts.
  // 2-player matches: turnOrder[0] (the leaver) starts with 2 pieces already
  // out of home (slot 0 on track, slot 1 in the finish lane) + 2 at home
  // (slot 2, slot 3), so the forfeit pawn-return flight/visibility can be
  // exercised deterministically without real dice rolls.
  initialStateFactory: (turnOrder: readonly string[]) => {
    if (turnOrder.length !== 2) return undefined as any
    const leaver = turnOrder[0]
    const survivor = turnOrder[1]
    const pieces = [
      { color: leaver, slot: 0, position: { kind: 'track', trackIndex: 5 } },
      { color: leaver, slot: 1, position: { kind: 'finish', finishIndex: 2 } },
      { color: leaver, slot: 2, position: { kind: 'home', slot: 2 } },
      { color: leaver, slot: 3, position: { kind: 'home', slot: 3 } },
      { color: survivor, slot: 0, position: { kind: 'home', slot: 0 } },
      { color: survivor, slot: 1, position: { kind: 'home', slot: 1 } },
      { color: survivor, slot: 2, position: { kind: 'home', slot: 2 } },
      { color: survivor, slot: 3, position: { kind: 'home', slot: 3 } },
    ]
    return {
      turnOrder: [...turnOrder], activeColor: survivor, turnPhase: 'waiting_for_roll',
      diceValue: null, legalMoves: [], pieces, status: 'in_progress', winnerColor: null,
      turnVersion: 0, pendingExtraRoll: false, leftColors: [],
    } as any
  },
  onSnapshot: (snapshot) => {`
  await writeFile(indexPath, original.replace(needle, injected), 'utf8')
}

type RunningServer = { child: ChildProcessWithoutNullStreams; output(): string }
function startServer(serverDir: string, port: number): RunningServer {
  const chunks: string[] = []
  const child = spawn(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), join('src', 'index.ts')], {
    cwd: serverDir, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
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

async function register(port: number, tag: string, runId: string) {
  const email = `ludo-forfeit-vis-${tag}-${runId}@example.test`
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'LudoForfeitVis1!', displayName: `LFV${tag.replace(/[^a-zA-Z0-9]/g, '')}${runId.slice(-5)}`, gender: 'male' }),
  })
  const body: any = await res.json()
  if (res.status !== 200) throw new Error(`register ${tag} failed: ${JSON.stringify(body)}`)
  const setCookie = (res.headers.getSetCookie?.()[0] ?? res.headers.get('set-cookie'))?.split(';')[0] ?? null
  if (!setCookie) throw new Error('no cookie returned')
  return { cookie: setCookie.split('=')[1]!, profileId: body.session.profile.profileId as string }
}

console.log('\ncheckLudoForfeitPawnVisibility\n')

const isolated = await createIsolatedServerRoot()
await patchIndexTsForForfeitSeed(isolated.serverDir)
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
      name: 'ludo-forfeit-vis-isolated-backend',
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

  async function open(profile: { cookie: string }, viewport: { width: number; height: number }): Promise<Page> {
    const context = await browser.newContext({ viewport })
    await context.addCookies([{ name: 'belot_session', value: profile.cookie, url: backendOrigin }])
    const page = await context.newPage()
    await page.goto(`${appOrigin}/games/ludo`)
    const consentButton = page.locator('[data-consent-accept-all="1"]')
    if (await consentButton.isVisible().catch(() => false)) await consentButton.click()
    await page.locator('[data-ludo-lobby="1"]').waitFor({ state: 'visible', timeout: 15_000 })
    await page.waitForTimeout(400)
    return page
  }

  async function createTwoPlayerRoom(page: Page): Promise<void> {
    await page.locator('[data-ludo-create-open="1"]').click()
    await page.locator('[data-ludo-create-form="1"]').waitFor({ state: 'visible' })
    await page.locator('[data-ludo-create-form="1"] select[name="playerCount"]').selectOption('2')
    const stakeSelect = page.locator('[data-ludo-create-form="1"] select[name="stake"]')
    const firstStakeValue = await stakeSelect.locator('option').first().getAttribute('value')
    await stakeSelect.selectOption(firstStakeValue!)
    await page.locator('[data-ludo-create-form="1"]').evaluate((form: HTMLFormElement) => form.requestSubmit())
  }

  async function runScenario(viewport: { width: number; height: number }, viewportLabel: string) {
    console.log(`\n=== 2-player explicit forfeit, match-finishing (survivor viewport: ${viewportLabel}) ===`)
    const leaverProfile = await register(backendPort, `${viewportLabel}-a`, runId)
    const survivorProfile = await register(backendPort, `${viewportLabel}-b`, runId)

    const leaverPage = await open(leaverProfile, { width: 1280, height: 850 })
    await createTwoPlayerRoom(leaverPage)
    await leaverPage.locator('[data-ludo-room-leave="1"]').waitFor({ state: 'visible', timeout: 10_000 })

    const survivorPage = await open(survivorProfile, viewport)
    await survivorPage.locator('[data-ludo-room-join]').first().waitFor({ state: 'visible', timeout: 10_000 })
    await survivorPage.locator('[data-ludo-room-join]').first().click()

    // 2-player rooms auto-start once full — both clients' UI auto-mounts the
    // real authoritative game screen (createLudoFlowController, same as a
    // real player would see).
    await leaverPage.locator('[data-ludo-cell-pieces]').first().waitFor({ state: 'attached', timeout: 15_000 })
    await survivorPage.locator('[data-ludo-cell-pieces]').first().waitFor({ state: 'attached', timeout: 15_000 })

    // Identify the leaver's color directly: the seeded state guarantees
    // exactly the leaver has pieces OUTSIDE any home-* cell container (slot
    // 0 on the track) — every OTHER piece on the board starts at home for
    // both players, so "-0"/"-1" alone is ambiguous (the survivor also has
    // a slot-0 piece, already home). Scoping to non-home containers picks
    // the right one.
    const trackPieceId = await survivorPage.evaluate(() => {
      const containers = Array.from(document.querySelectorAll('[data-ludo-cell-pieces]')) as HTMLElement[]
      for (const container of containers) {
        const cellId = container.getAttribute('data-ludo-cell-pieces') ?? ''
        if (cellId.startsWith('home-')) continue
        const pieceEl = container.querySelector('[data-ludo-piece]')
        if (pieceEl) return pieceEl.getAttribute('data-ludo-piece')
      }
      return null
    })
    if (!trackPieceId) throw new Error('could not find the seeded out-of-home slot-0 piece on the board')
    const leaverColorResolved = trackPieceId.split('-')[0]!

    async function homeCellHasPiece(slot: number): Promise<boolean> {
      const container = survivorPage.locator(`[data-ludo-cell-pieces="home-${leaverColorResolved}-${slot}"]`)
      const count = await container.locator(`[data-ludo-piece="${leaverColorResolved}-${slot}"], [data-ludo-piece-group~="${leaverColorResolved}-${slot}"]`).count()
      return count > 0
    }
    async function anyOverlayFlying(): Promise<boolean> {
      return (await survivorPage.locator('[data-ludo-capture-flight]').count()) > 0
    }

    await check('[already-home] slot 2/3 visible in home BEFORE forfeit (no premature suppression)', async () => {
      if (!(await homeCellHasPiece(2))) throw new Error('slot 2 missing from home before forfeit')
      if (!(await homeCellHasPiece(3))) throw new Error('slot 3 missing from home before forfeit')
    })
    await check('[pre-forfeit] slot 0/1 visible on the board out of home', async () => {
      await survivorPage.locator(`[data-ludo-piece="${leaverColorResolved}-0"], [data-ludo-piece-group~="${leaverColorResolved}-0"]`).first().waitFor({ state: 'attached', timeout: 5_000 })
      await survivorPage.locator(`[data-ludo-piece="${leaverColorResolved}-1"], [data-ludo-piece-group~="${leaverColorResolved}-1"]`).first().waitFor({ state: 'attached', timeout: 5_000 })
    })

    // Real Exit -> Confirm click, exactly the flow the user reported the bug through.
    await leaverPage.locator('[data-ludo-exit-button="1"]').click()
    await leaverPage.locator('[data-ludo-exit-confirm-backdrop="1"]').waitFor({ state: 'visible', timeout: 5_000 })
    await leaverPage.locator('[data-ludo-exit-confirm-submit="1"]').click()
    const leaveIssuedAt = Date.now()

    // Checkpoint ~900ms: overlay flight (500ms) should have finished and
    // self-removed; the FIX must have already revealed the landed pieces —
    // this is exactly the window the reported bug left empty.
    const elapsedSoFar = Date.now() - leaveIssuedAt
    if (elapsedSoFar < 900) await sleep(900 - elapsedSoFar)
    await check('[checkpoint ~900ms] slot 0 (was on track) visible in home right after flight lands', async () => {
      if (!(await homeCellHasPiece(0))) throw new Error('slot 0 (leaver) not visible in home shortly after landing — the reported disappearing-pawn bug')
    })
    await check('[checkpoint ~900ms] slot 1 (was in finish lane) visible in home right after flight lands', async () => {
      if (!(await homeCellHasPiece(1))) throw new Error('slot 1 (leaver) not visible in home shortly after landing — the reported disappearing-pawn bug')
    })
    await check('[checkpoint ~900ms] no stray flight overlay left running (overlay self-removed, no duplicate/stuck node)', async () => {
      if (await anyOverlayFlying()) throw new Error('a [data-ludo-capture-flight] overlay is still present after the flight should have completed')
    })
    await check('[checkpoint ~900ms] no duplicate render (overlay gone AND static piece present at the same time, never both/neither)', async () => {
      const overlayCount = await survivorPage.locator(`[data-ludo-capture-flight="${leaverColorResolved}-0"]`).count()
      const staticCount = await survivorPage.locator(`[data-ludo-cell-pieces="home-${leaverColorResolved}-0"] [data-ludo-piece="${leaverColorResolved}-0"]`).count()
      if (overlayCount > 0 && staticCount > 0) throw new Error('overlay AND static piece both present simultaneously (duplicate)')
      if (staticCount === 0) throw new Error('neither overlay nor static piece present (still the disappearing bug)')
    })
    await check('[checkpoint ~900ms] leaver panel shows blinking "Излезе от играта"', async () => {
      await survivorPage.locator('text=Излезе от играта').first().waitFor({ state: 'visible', timeout: 3_000 })
    })

    // Checkpoint ~2.5s: still well inside the 5s "Излезе от играта" gate —
    // pieces must remain continuously visible (this is exactly the window
    // that was empty before the fix), and the winner popup must NOT be up yet.
    await sleep(1_600)
    await check('[checkpoint ~2.5s] all 4 leaver home slots remain visible mid-gate', async () => {
      for (const slot of [0, 1, 2, 3]) {
        if (!(await homeCellHasPiece(slot))) throw new Error(`slot ${slot} missing from home mid-gate (2.5s)`)
      }
    })
    await check('[checkpoint ~2.5s] winner popup NOT shown yet (gate still open, <5s elapsed)', async () => {
      const visible = await survivorPage.locator('text=Вие сте победител в играта!').isVisible().catch(() => false)
      if (visible) throw new Error('winner popup appeared before the 5s gate elapsed')
    })

    // Checkpoint ~5.4s: gate has released, winner popup should be up; pieces
    // must still be present underneath (never got hidden by the reveal path).
    await sleep(2_900)
    await check('[checkpoint ~5.4s] winner popup is showing (gate released after max(5s, flight))', async () => {
      await survivorPage.locator('text=Вие сте победител в играта!').waitFor({ state: 'visible', timeout: 3_000 })
    })
    await check('[checkpoint ~5.4s] all 4 leaver home slots still present under/behind the popup', async () => {
      for (const slot of [0, 1, 2, 3]) {
        if (!(await homeCellHasPiece(slot))) throw new Error(`slot ${slot} missing from home after gate release (5.4s)`)
      }
    })

    const screenshotPath = join(projectRoot, `forfeit-pawn-visibility-${viewportLabel}.png`)
    await survivorPage.screenshot({ path: screenshotPath })
    console.log(`  (screenshot saved: ${screenshotPath})`)

    await leaverPage.close()
    await survivorPage.close()
  }

  await runScenario({ width: 1280, height: 850 }, 'desktop')
  await runScenario({ width: 360, height: 800 }, 'mobile-360')

  console.log('\n' + '═'.repeat(72))
  console.log(`Passed: ${passed}  Failed: ${failed}`)
  if (failed > 0) process.exitCode = 1
} finally {
  await browser.close()
  if (vite) await vite.close()
  if (server && server.child.exitCode === null) {
    server.child.kill('SIGKILL')
    await Promise.race([new Promise((r) => server!.child.once('exit', r)), sleep(3_000)])
  }
  await isolated.cleanup()
}
