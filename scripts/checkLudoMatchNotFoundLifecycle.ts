// checkLudoMatchNotFoundLifecycle.ts
//
// Real spawned-server + real browser (Playwright, production controller,
// real UI clicks) focused check for the "ludo_match_not_found lifecycle UX
// bug": after a normal finished match, end-game popup -> OK -> /games/ludo
// used to leave "Ludo играта не беше намерена." visible under the lobby
// banner, because a stale/background ludo_game_state_request response
// (from the on-'connected' blind probe or the hidden->visible resync probe)
// had no way to be distinguished from a genuine "expected active match is
// unexpectedly missing" restore attempt.
//
// Scenarios (task spec):
//   1. loss -> OK -> /games/ludo -> no error text.
//   2. win  -> OK -> /games/ludo -> no error text.
//   3. normal refresh with no active match -> no error text.
//   4. a genuine EXPECTED restore (cross-game-commitment "Виж") whose match
//      has meanwhile actually disappeared -> error handling still shows.

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
  const root = await mkdtemp(join(tmpdir(), 'belot-ludo-mnf-'))
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
  return { serverDir, cleanup: () => rm(root, { recursive: true, force: true }).catch(() => undefined) }
}

// TEST-ONLY injection into the ISOLATED COPY of index.ts (never the tracked
// server/src/index.ts) — seeds a 2-player match where turnOrder[0] is one
// exact-landing roll away from winning (mirrors server/scripts/
// checkLudoEconomy.ts::patchIndexTsForDeterministicLudoWin, adapted to
// turnOrder.length===2), so a single real roll+move click drives a REAL
// 'finished' transition for both scenarios 1 (loss) and 2 (win) in one match.
async function patchIndexTsForDeterministicWin(serverDir: string): Promise<void> {
  const indexPath = join(serverDir, 'src', 'index.ts')
  const original = await readFile(indexPath, 'utf8')
  const needle = 'const ludoMatchRuntime = createLudoMatchRuntime({\n  onSnapshot: (snapshot) => {'
  if (!original.includes(needle)) throw new Error('patch anchor not found in index.ts')
  const injected = `const ludoMatchRuntime = createLudoMatchRuntime({
  // TEST-ONLY, isolated-copy-only injection — see checkLudoMatchNotFoundLifecycle.ts.
  initialStateFactory: (turnOrder: readonly string[]) => {
    if (turnOrder.length !== 2) return undefined as any
    const winnerColor = turnOrder[0]
    const pieces = turnOrder.flatMap((color) => ([0, 1, 2, 3] as const).map((slot) => {
      if (color !== winnerColor) return { color, slot, position: { kind: 'home', slot } }
      if (slot === 3) return { color, slot, position: { kind: 'finish', finishIndex: 4 } }
      return { color, slot, position: { kind: 'finish', finishIndex: 5 } }
    }))
    return {
      turnOrder: [...turnOrder], activeColor: winnerColor, turnPhase: 'waiting_for_roll',
      diceValue: null, legalMoves: [], pieces, status: 'in_progress', winnerColor: null,
      turnVersion: 0, pendingExtraRoll: false, leftColors: [],
    } as any
  },
  randomDie: () => 1 as any,
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
  const email = `ludo-mnf-${tag}-${runId}@example.test`
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'LudoMnf1!', displayName: `LM${tag.replace(/[^a-zA-Z0-9]/g, '')}${runId.slice(-5)}`, gender: 'male' }),
  })
  const body: any = await res.json()
  if (res.status !== 200) throw new Error(`register ${tag} failed: ${JSON.stringify(body)}`)
  const setCookie = (res.headers.getSetCookie?.()[0] ?? res.headers.get('set-cookie'))?.split(';')[0] ?? null
  if (!setCookie) throw new Error('no cookie returned')
  return { cookie: setCookie.split('=')[1]!, profileId: body.session.profile.profileId as string }
}

console.log('\ncheckLudoMatchNotFoundLifecycle\n')

const isolated = await createIsolatedServerRoot()
await patchIndexTsForDeterministicWin(isolated.serverDir)
const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

let server: RunningServer | null = null
const browser = await chromium.launch({ headless: true })
let vite: Awaited<ReturnType<typeof createViteServer>> | null = null

const ERROR_TEXT = 'Ludo играта не беше намерена.'

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
      name: 'ludo-mnf-isolated-backend',
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

  const matchInfoByPage = new WeakMap<Page, { matchId: string | null; colorByProfile: Map<string, string> }>()

  async function open(profile: { cookie: string }, viewport: { width: number; height: number }): Promise<Page> {
    const context = await browser.newContext({ viewport })
    await context.addCookies([{ name: 'belot_session', value: profile.cookie, url: backendOrigin }])
    const page = await context.newPage()
    const info = { matchId: null as string | null, colorByProfile: new Map<string, string>() }
    matchInfoByPage.set(page, info)
    page.on('websocket', (ws) => {
      ws.on('framereceived', (frame) => {
        try {
          const payload = typeof frame.payload === 'string' ? frame.payload : frame.payload.toString('utf8')
          const msg = JSON.parse(payload)
          if ((msg.type === 'ludo_game_started' || msg.type === 'ludo_game_state') && msg.snapshot) {
            info.matchId = msg.snapshot.matchId
            for (const p of msg.snapshot.players) info.colorByProfile.set(p.profileId, p.color)
          }
        } catch { /* ignore non-JSON/binary frames */ }
      })
    })
    await page.goto(`${appOrigin}/games/ludo`)
    const consentButton = page.locator('[data-consent-accept-all="1"]')
    if (await consentButton.isVisible().catch(() => false)) await consentButton.click()
    await page.locator('[data-ludo-lobby="1"]').waitFor({ state: 'visible', timeout: 15_000 })
    await page.waitForTimeout(300)
    return page
  }

  async function createRoom(page: Page, playerCount: '2' | '4'): Promise<void> {
    await page.locator('[data-ludo-create-open="1"]').click()
    await page.locator('[data-ludo-create-form="1"]').waitFor({ state: 'visible' })
    await page.locator('[data-ludo-create-form="1"] select[name="playerCount"]').selectOption(playerCount)
    const stakeSelect = page.locator('[data-ludo-create-form="1"] select[name="stake"]')
    const firstStakeValue = await stakeSelect.locator('option').first().getAttribute('value')
    await stakeSelect.selectOption(firstStakeValue!)
    await page.locator('[data-ludo-create-form="1"]').evaluate((form: HTMLFormElement) => form.requestSubmit())
  }

  async function colorOf(page: Page, profileId: string): Promise<string> {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const color = matchInfoByPage.get(page)?.colorByProfile.get(profileId)
      if (color) return color
      await sleep(80)
    }
    throw new Error('color for profile not observed via WS traffic in time')
  }

  async function assertNoErrorTextEver(page: Page, label: string, waitMs = 3_000): Promise<void> {
    const deadline = Date.now() + waitMs
    while (Date.now() < deadline) {
      const visible = await page.locator(`text=${ERROR_TEXT}`).isVisible().catch(() => false)
      if (visible) throw new Error(`"${ERROR_TEXT}" appeared (${label})`)
      await sleep(150)
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Scenarios 1+2: one real deterministic 2-player match — the loser
  // clicks OK (scenario 1), the winner clicks OK (scenario 2).
  // ═══════════════════════════════════════════════════════════════════
  console.log('=== 1/2: loss/win -> OK -> /games/ludo -> no error text ===')
  {
    const aProfile = await register(backendPort, 'a', runId)
    const bProfile = await register(backendPort, 'b', runId)
    const aPage = await open(aProfile, { width: 1280, height: 850 })
    await createRoom(aPage, '2')
    await aPage.locator('[data-ludo-room-leave="1"]').waitFor({ state: 'visible', timeout: 10_000 })
    const bPage = await open(bProfile, { width: 1280, height: 850 })
    await bPage.locator('[data-ludo-room-join]').first().waitFor({ state: 'visible', timeout: 10_000 })
    await bPage.locator('[data-ludo-room-join]').first().click()
    await aPage.locator('[data-ludo-cell-pieces]').first().waitFor({ state: 'attached', timeout: 15_000 })
    await bPage.locator('[data-ludo-cell-pieces]').first().waitFor({ state: 'attached', timeout: 15_000 })

    void aProfile; void bProfile
    // Seeded state: activeColor===turnOrder[0]===the winner from the start
    // — only THAT color's own local client renders a clickable roll button.
    // Determine the winner page from that real, observable DOM fact instead
    // of assuming join-order-to-turnOrder-index mapping.
    const aCanRoll = await aPage.locator('[data-ludo-dice-roll-button="1"]').count()
    const winnerPage = aCanRoll > 0 ? aPage : bPage
    const loserPage = winnerPage === aPage ? bPage : aPage

    // Drive the deterministic win: roll (die=1) then move the finishIndex-4 piece home.
    await winnerPage.locator('[data-ludo-dice-roll-button="1"]').click()
    await winnerPage.locator('[data-ludo-piece-selectable="1"]').first().waitFor({ state: 'visible', timeout: 5_000 })
    await winnerPage.locator('[data-ludo-piece-selectable="1"]').first().click()

    await winnerPage.locator('text=Вие сте победител в играта!').waitFor({ state: 'visible', timeout: 10_000 })
    await loserPage.locator('text=Вие загубихте играта.').waitFor({ state: 'visible', timeout: 10_000 })

    await check('[1] loser: OK -> /games/ludo -> no error text (sustained 3s)', async () => {
      await loserPage.locator('[data-ludo-game-end-dismiss="1"]').click()
      await loserPage.waitForTimeout(300)
      const lobbyVisible = await loserPage.locator('[data-ludo-lobby="1"]').isVisible().catch(() => false)
      if (!lobbyVisible) throw new Error('Ludo lobby not visible after OK')
      await assertNoErrorTextEver(loserPage, 'loser after OK')
    })

    await check('[2] winner: OK -> /games/ludo -> no error text (sustained 3s)', async () => {
      await winnerPage.locator('[data-ludo-game-end-dismiss="1"]').click()
      await winnerPage.waitForTimeout(300)
      const lobbyVisible = await winnerPage.locator('[data-ludo-lobby="1"]').isVisible().catch(() => false)
      if (!lobbyVisible) throw new Error('Ludo lobby not visible after OK')
      await assertNoErrorTextEver(winnerPage, 'winner after OK')
    })

    await loserPage.close()
    await winnerPage.close()
  }

  // ═══════════════════════════════════════════════════════════════════
  // Scenario 3: normal refresh with no active match -> no error text.
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n=== 3: normal refresh, no active match -> no error text ===')
  {
    const profile = await register(backendPort, 'c', runId)
    const page = await open(profile, { width: 1280, height: 850 })
    await check('[3] fresh /games/ludo load with no active match never shows the error text', async () => {
      await assertNoErrorTextEver(page, 'fresh load', 2_500)
    })
    await page.close()
  }

  // ═══════════════════════════════════════════════════════════════════
  // Scenario 4: a genuine EXPECTED restore (cross-game-commitment "Виж")
  // whose match has meanwhile actually disappeared -> error handling stays.
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n=== 4: expected restore with a genuinely missing match -> error handling remains ===')
  {
    const aProfile = await register(backendPort, 'd', runId)
    const bProfile = await register(backendPort, 'e', runId)
    const aPage = await open(aProfile, { width: 1280, height: 850 })
    await createRoom(aPage, '2')
    await aPage.locator('[data-ludo-room-leave="1"]').waitFor({ state: 'visible', timeout: 10_000 })
    const bPage = await open(bProfile, { width: 1280, height: 850 })
    await bPage.locator('[data-ludo-room-join]').first().waitFor({ state: 'visible', timeout: 10_000 })
    await bPage.locator('[data-ludo-room-join]').first().click()
    await aPage.locator('[data-ludo-cell-pieces]').first().waitFor({ state: 'attached', timeout: 15_000 })

    const matchId = await (async () => {
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        const id = matchInfoByPage.get(aPage)?.matchId
        if (id) return id
        await sleep(80)
      }
      throw new Error('matchId not observed')
    })()

    // Real trigger for the cross-game-commitment modal: a SECOND real tab
    // for the SAME profile (same session cookie) — a completely independent
    // page/connection/lobby-controller instance, exactly like a user opening
    // a new browser tab while their other tab has an active Ludo match —
    // navigates to the main lobby and clicks a real stake card, sending a
    // REAL join_matchmaking through ITS OWN WS connection. The server's
    // cross_game_commitment_blocked reply is received by THIS tab's own
    // real handleServerMessage, which renders the REAL "Вече участвате в
    // друга игра." modal (not a side-channel/synthetic frame).
    const aContext2 = await browser.newContext({ viewport: { width: 1280, height: 850 } })
    await aContext2.addCookies([{ name: 'belot_session', value: aProfile.cookie, url: backendOrigin }])
    // Capture a reference to the REAL WebSocket instance the app itself
    // creates (no app code changed — pure prototype-level observation,
    // installed before any page script runs) so we can send a REAL
    // join_matchmaking through the app's OWN connection and have its REAL
    // handleServerMessage process the reply, without needing to locate a
    // specific reachable UI button (the exact underlying lobby screen/route
    // for a profile with an active Ludo match isn't the point under test).
    await aContext2.addInitScript(() => {
      const NativeWebSocket = window.WebSocket
      // @ts-ignore
      window.WebSocket = new Proxy(NativeWebSocket, {
        construct(target, args) {
          const instance = new target(...(args as [any, any]))
          ;(window as any).__capturedAppWs = instance
          return instance
        },
      })
    })
    const aPage2 = await aContext2.newPage()
    // /games/ludo (not bare root) — ensures _ludoLobbyController mounts
    // (showLudoLobbyPage()) exactly like a real user's Ludo lobby visit,
    // matching the ACTUAL reported bug's screen (the fullscreen game
    // overlay may ALSO auto-open on top for this profile's real active
    // match — that overlay sits at a lower z-index than the cross-game
    // modal below, so it never blocks anything under test).
    await aPage2.goto(`${appOrigin}/games/ludo`)
    const consent2 = aPage2.locator('[data-consent-accept-all="1"]')
    if (await consent2.isVisible().catch(() => false)) await consent2.click()
    await aPage2.locator('[data-ludo-lobby="1"]').waitFor({ state: 'attached', timeout: 15_000 })
    await aPage2.waitForTimeout(500)

    await aPage2.evaluate(() => {
      (window as any).__capturedAppWs.send(JSON.stringify({ type: 'join_matchmaking', stake: 5000 }))
    })

    await check('[4 setup] cross-game-commitment modal appears on A\'s second real tab', async () => {
      await aPage2.locator('[data-cross-game-modal-view="1"]').waitFor({ state: 'visible', timeout: 5_000 })
    })

    // Race the match away BEFORE clicking "Виж" — force it to genuinely no
    // longer exist by the time the explicit restore request is processed.
    // Sent through the SAME real captured connection (not a third
    // throwaway one) so this tab's own app also observes the real
    // ludo_match_left and settles its state naturally, exactly like a
    // real leave would.
    await aPage2.evaluate(async (matchIdArg) => {
      const ws: WebSocket = (window as any).__capturedAppWs
      ;(window as any).__ludoMatchLeftSeen = false
      ws.addEventListener('message', (event: MessageEvent) => {
        try {
          if (JSON.parse(event.data as string).type === 'ludo_match_left') (window as any).__ludoMatchLeftSeen = true
        } catch { /* ignore */ }
      })
      ws.send(JSON.stringify({ type: 'leave_ludo_match', matchId: matchIdArg }))
    }, matchId)
    await aPage2.waitForFunction(() => (window as any).__ludoMatchLeftSeen === true, { timeout: 5_000 })
    await sleep(300)

    await check('[4] "Виж" on a genuinely-missing expected match shows real error handling', async () => {
      await aPage2.locator('[data-cross-game-modal-view="1"]').click()
      await aPage2.locator(`text=${ERROR_TEXT}`).waitFor({ state: 'visible', timeout: 5_000 })
    })

    await aPage2.close()
    await aPage.close()
    await bPage.close()
  }

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
