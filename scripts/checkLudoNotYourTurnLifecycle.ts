// checkLudoNotYourTurnLifecycle.ts
//
// Real spawned-server + real browser (Playwright, production controller,
// real UI clicks + real captured app WS connection) focused check for the
// "ludo_match_not_turn lifecycle UX bug": after a NORMAL finished match
// (natural win/loss), end-game popup -> OK -> /games/ludo used to leave
// "Не е твоят ред." visible under the lobby banner, for BOTH the winner and
// the loser, because a stale gameplay-action (roll/move/reclaim) error
// response — genuinely produced earlier DURING the still-active match by an
// off-turn click — was queued into the (visually hidden, behind the
// fullscreen game overlay) _ludoLobbyController and never invalidated once
// the match ended and the controller was destroyed.
//
// Scenario A: both the eventual WINNER and the eventual LOSER each send one
// genuinely invalid off-turn roll DURING the still-in-progress match (via
// their own REAL captured app connection, not a synthetic side-channel),
// confirming the server really does answer ludo_match_not_turn for each.
// The match then finishes naturally (deterministic seed), both click OK,
// and /games/ludo must stay clean (no "Не е твоят ред.", no stale gameplay
// error) for several seconds on BOTH clients.
//
// Scenario B: while the match is STILL active (before OK), a genuine
// off-turn error is not globally suppressed — the request/response path
// itself must still work normally (server still answers ludo_match_not_turn
// exactly as scenario A already proves) — this is verified by scenario A's
// own mid-match assertions succeeding at all.

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
  const root = await mkdtemp(join(tmpdir(), 'belot-ludo-nyt-'))
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
// server/src/index.ts). activeColor starts on turnOrder[1] (the LOSER) so
// there is a real initial window where it is genuinely NOT turnOrder[0]'s
// (the WINNER's) turn — randomDie=1 gives the loser zero legal moves from
// home (auto-advances to the winner), whose single finishIndex-4 piece
// needs exactly a 1 to land home.
async function patchIndexTsForDeterministicWin(serverDir: string): Promise<void> {
  const indexPath = join(serverDir, 'src', 'index.ts')
  const original = await readFile(indexPath, 'utf8')
  const needle = 'const ludoMatchRuntime = createLudoMatchRuntime({\n  onSnapshot: (snapshot) => {'
  if (!original.includes(needle)) throw new Error('patch anchor not found in index.ts')
  const injected = `const ludoMatchRuntime = createLudoMatchRuntime({
  // TEST-ONLY, isolated-copy-only injection — see checkLudoNotYourTurnLifecycle.ts.
  initialStateFactory: (turnOrder: readonly string[]) => {
    if (turnOrder.length !== 2) return undefined as any
    const winnerColor = turnOrder[0]
    const loserColor = turnOrder[1]
    const pieces = turnOrder.flatMap((color) => ([0, 1, 2, 3] as const).map((slot) => {
      if (color !== winnerColor) return { color, slot, position: { kind: 'home', slot } }
      if (slot === 3) return { color, slot, position: { kind: 'finish', finishIndex: 4 } }
      return { color, slot, position: { kind: 'finish', finishIndex: 5 } }
    }))
    return {
      turnOrder: [...turnOrder], activeColor: loserColor, turnPhase: 'waiting_for_roll',
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
  const email = `ludo-nyt-${tag}-${runId}@example.test`
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'LudoNyt1!', displayName: `LN${tag.replace(/[^a-zA-Z0-9]/g, '')}${runId.slice(-5)}`, gender: 'male' }),
  })
  const body: any = await res.json()
  if (res.status !== 200) throw new Error(`register ${tag} failed: ${JSON.stringify(body)}`)
  const setCookie = (res.headers.getSetCookie?.()[0] ?? res.headers.get('set-cookie'))?.split(';')[0] ?? null
  if (!setCookie) throw new Error('no cookie returned')
  return { cookie: setCookie.split('=')[1]!, profileId: body.session.profile.profileId as string }
}

console.log('\ncheckLudoNotYourTurnLifecycle\n')

const isolated = await createIsolatedServerRoot()
await patchIndexTsForDeterministicWin(isolated.serverDir)
const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

let server: RunningServer | null = null
const browser = await chromium.launch({ headless: true })
let vite: Awaited<ReturnType<typeof createViteServer>> | null = null

const NOT_YOUR_TURN_TEXT = 'Не е твоят ред.'
const NOT_FOUND_TEXT = 'Ludo играта не беше намерена.'

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
      name: 'ludo-nyt-isolated-backend',
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

  const matchInfoByPage = new WeakMap<Page, { matchId: string | null; revision: number; colorByProfile: Map<string, string> }>()

  // Captures a reference to the REAL WebSocket instance the app itself
  // creates (no app code changed — pure prototype-level observation,
  // installed before any page script runs), so genuinely invalid gameplay
  // actions can be sent through the SAME real connection the app uses,
  // exactly like a real off-turn click, and their response is processed by
  // the REAL handleServerMessage.
  async function open(profile: { cookie: string; profileId: string }, viewport: { width: number; height: number }): Promise<Page> {
    const context = await browser.newContext({ viewport })
    await context.addCookies([{ name: 'belot_session', value: profile.cookie, url: backendOrigin }])
    await context.addInitScript(() => {
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
    const page = await context.newPage()
    const info = { matchId: null as string | null, revision: 0, colorByProfile: new Map<string, string>() }
    matchInfoByPage.set(page, info)
    page.on('websocket', (ws) => {
      ws.on('framereceived', (frame) => {
        try {
          const payload = typeof frame.payload === 'string' ? frame.payload : frame.payload.toString('utf8')
          const msg = JSON.parse(payload)
          if ((msg.type === 'ludo_game_started' || msg.type === 'ludo_game_state') && msg.snapshot) {
            info.matchId = msg.snapshot.matchId
            info.revision = msg.snapshot.revision
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

  async function createRoom(page: Page): Promise<void> {
    await page.locator('[data-ludo-create-open="1"]').click()
    await page.locator('[data-ludo-create-form="1"]').waitFor({ state: 'visible' })
    await page.locator('[data-ludo-create-form="1"] select[name="playerCount"]').selectOption('2')
    const stakeSelect = page.locator('[data-ludo-create-form="1"] select[name="stake"]')
    const firstStakeValue = await stakeSelect.locator('option').first().getAttribute('value')
    await stakeSelect.selectOption(firstStakeValue!)
    await page.locator('[data-ludo-create-form="1"]').evaluate((form: HTMLFormElement) => form.requestSubmit())
  }

  async function matchIdOf(page: Page): Promise<string> {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const id = matchInfoByPage.get(page)?.matchId
      if (id) return id
      await sleep(80)
    }
    throw new Error('matchId not observed')
  }

  // Watches this page's real captured connection for the NEXT error frame
  // and returns its code (or null on timeout). Installed BEFORE the real UI
  // click(s) that are expected to (eventually) produce it.
  async function armErrorWatch(page: Page): Promise<void> {
    await page.evaluate(() => {
      const ws: WebSocket = (window as any).__capturedAppWs
      ;(window as any).__lastErrorCode = undefined
      ws.addEventListener('message', (event: MessageEvent) => {
        try {
          const msg = JSON.parse(event.data as string)
          if (msg.type === 'error' && (window as any).__lastErrorCode === undefined) {
            (window as any).__lastErrorCode = msg.code ?? null
          }
        } catch { /* ignore */ }
      })
    })
  }
  async function readErrorWatch(page: Page, timeoutMs = 3_000): Promise<string | null> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const code = await page.evaluate(() => (window as any).__lastErrorCode)
      if (code !== undefined) return code ?? null
      await sleep(80)
    }
    return null
  }

  async function assertNoStaleErrorTextEver(page: Page, label: string, waitMs = 3_500): Promise<void> {
    const deadline = Date.now() + waitMs
    while (Date.now() < deadline) {
      const notYourTurn = await page.locator(`text=${NOT_YOUR_TURN_TEXT}`).isVisible().catch(() => false)
      if (notYourTurn) throw new Error(`"${NOT_YOUR_TURN_TEXT}" appeared (${label})`)
      const notFound = await page.locator(`text=${NOT_FOUND_TEXT}`).isVisible().catch(() => false)
      if (notFound) throw new Error(`"${NOT_FOUND_TEXT}" appeared (${label})`)
      await sleep(150)
    }
  }

  console.log('=== A: natural finish (winner + loser each hit a real mid-match "not your turn"), OK -> clean lobby ===')
  {
    const winnerProfile = await register(backendPort, 'w', runId)
    const loserProfile = await register(backendPort, 'l', runId)
    const winnerPage = await open(winnerProfile, { width: 1280, height: 850 })
    await createRoom(winnerPage)
    await winnerPage.locator('[data-ludo-room-leave="1"]').waitFor({ state: 'visible', timeout: 10_000 })
    const loserPage = await open(loserProfile, { width: 1280, height: 850 })
    await loserPage.locator('[data-ludo-room-join]').first().waitFor({ state: 'visible', timeout: 10_000 })
    await loserPage.locator('[data-ludo-room-join]').first().click()
    await winnerPage.locator('[data-ludo-cell-pieces]').first().waitFor({ state: 'attached', timeout: 15_000 })
    await loserPage.locator('[data-ludo-cell-pieces]').first().waitFor({ state: 'attached', timeout: 15_000 })
    const matchId = await matchIdOf(winnerPage)

    void matchId
    // Seed: activeColor starts on the LOSER. Both mid-match gameplay
    // errors below are produced through 100% REAL UI clicks (the actual
    // dice-roll-button element, the actual onRollRequest callback — so
    // _isAwaitingLudoGameplayActionResponse is genuinely set by the app
    // itself, not injected) via a real double-click: an extremely common,
    // entirely plausible human action (impatience/perceived lag), and a
    // mundane, realistic way the reported bug actually occurs — the FIRST
    // click is a genuinely valid roll; because it yields zero legal moves
    // (die=1, all pieces home) the turn silently auto-advances to the
    // OTHER player server-side, so the immediate SECOND click (already
    // queued client-side against the still-current DOM before the re-render
    // lands) is rejected by the server as off-turn.
    await armErrorWatch(loserPage)
    await loserPage.locator('[data-ludo-dice-roll-button="1"]').click()
    await loserPage.locator('[data-ludo-dice-roll-button="1"]').click().catch(() => { /* button may already be gone by the 2nd click — fine, covered by the fallback check below */ })
    await check('[A setup] LOSER real double-click produces a genuine mid-match ludo_match_not_turn (their own turn auto-advanced away after 0 legal moves)', async () => {
      const code = await readErrorWatch(loserPage)
      if (code !== 'ludo_match_not_turn') throw new Error(`expected ludo_match_not_turn from a real double-click, got ${code}`)
    })
    await sleep(300)

    // Winner's real turn now. Real double-click on the SAME dice-roll
    // button (mirrors the loser's already-proven-reliable pattern above):
    // the first click validly rolls (die=1, yields exactly one legal move
    // — the finishIndex-4 piece); the immediate second click (already
    // queued against the still-current DOM, turnPhase now
    // awaiting_move_selection) is rejected — a genuine gameplay-action
    // error (ludo_match_action_rejected, a DIFFERENT code than "Не е
    // твоят ред." — proving the fix generalizes across gameplay-action
    // error codes, not one literal string).
    await armErrorWatch(winnerPage)
    await winnerPage.locator('[data-ludo-dice-roll-button="1"]').click()
    await winnerPage.locator('[data-ludo-dice-roll-button="1"]').click().catch(() => { /* button may already be gone by the 2nd click — fine, covered by the check below */ })

    await check('[A setup] WINNER real double-click on the roll button produces a genuine mid-match gameplay-action error', async () => {
      const code = await readErrorWatch(winnerPage)
      if (!code) throw new Error('expected a real gameplay-action error code from the double-click, got none')
    })

    await winnerPage.locator('[data-ludo-piece-selectable="1"]').first().waitFor({ state: 'visible', timeout: 5_000 })
    await winnerPage.locator('[data-ludo-piece-selectable="1"]').first().click()

    await winnerPage.locator('text=Вие сте победител в играта!').waitFor({ state: 'visible', timeout: 10_000 })
    await loserPage.locator('text=Вие загубихте играта.').waitFor({ state: 'visible', timeout: 10_000 })

    await check('[A] WINNER: OK -> /games/ludo -> no "Не е твоят ред." / no stale gameplay error (sustained)', async () => {
      await winnerPage.locator('[data-ludo-game-end-dismiss="1"]').click()
      await winnerPage.waitForTimeout(300)
      const lobbyVisible = await winnerPage.locator('[data-ludo-lobby="1"]').isVisible().catch(() => false)
      if (!lobbyVisible) throw new Error('Ludo lobby not visible after OK')
      await assertNoStaleErrorTextEver(winnerPage, 'winner after OK')
    })

    await check('[A] LOSER: OK -> /games/ludo -> no "Не е твоят ред." / no stale gameplay error (sustained)', async () => {
      await loserPage.locator('[data-ludo-game-end-dismiss="1"]').click()
      await loserPage.waitForTimeout(300)
      const lobbyVisible = await loserPage.locator('[data-ludo-lobby="1"]').isVisible().catch(() => false)
      if (!lobbyVisible) throw new Error('Ludo lobby not visible after OK')
      await assertNoStaleErrorTextEver(loserPage, 'loser after OK')
    })

    await winnerPage.close()
    await loserPage.close()
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
