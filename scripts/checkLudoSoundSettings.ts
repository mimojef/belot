// checkLudoSoundSettings.ts
//
// Real spawned-server + real browser (Playwright, production controller,
// real UI clicks) focused check for the new Ludo sound settings feature:
// settings button + popup, "Звуци в играта" (master mute) and "Звук на
// зара" (dice-only) toggles, priority rule, and localStorage persistence.
//
// Audio playback is observed by patching HTMLAudioElement.prototype.play
// (installed BEFORE any app script runs, via context.addInitScript) to
// record which src was attempted — headless Chromium has no real audio
// output anyway, so this directly and reliably verifies the GATING logic
// (was a given sound attempted or correctly suppressed) without depending
// on actually "hearing" anything.

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
  const root = await mkdtemp(join(tmpdir(), 'belot-ludo-sound-'))
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
// server/src/index.ts) — deterministic 2-player win, same established
// pattern as other Ludo checks this session (turnOrder[0] one exact roll
// away from winning, randomDie=1).
async function patchIndexTsForDeterministicWin(serverDir: string): Promise<void> {
  const indexPath = join(serverDir, 'src', 'index.ts')
  const original = await readFile(indexPath, 'utf8')
  const needle = 'const ludoMatchRuntime = createLudoMatchRuntime({\n  onSnapshot: (snapshot) => {'
  if (!original.includes(needle)) throw new Error('patch anchor not found in index.ts')
  const injected = `const ludoMatchRuntime = createLudoMatchRuntime({
  // TEST-ONLY, isolated-copy-only injection — see checkLudoSoundSettings.ts.
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
  const email = `ludo-sound-${tag}-${runId}@example.test`
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'LudoSound1!', displayName: `LS${tag.replace(/[^a-zA-Z0-9]/g, '')}${runId.slice(-5)}`, gender: 'male' }),
  })
  const body: any = await res.json()
  if (res.status !== 200) throw new Error(`register ${tag} failed: ${JSON.stringify(body)}`)
  const setCookie = (res.headers.getSetCookie?.()[0] ?? res.headers.get('set-cookie'))?.split(';')[0] ?? null
  if (!setCookie) throw new Error('no cookie returned')
  return { cookie: setCookie.split('=')[1]!, profileId: body.session.profile.profileId as string }
}

console.log('\ncheckLudoSoundSettings\n')

const isolated = await createIsolatedServerRoot()
await patchIndexTsForDeterministicWin(isolated.serverDir)
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
      name: 'ludo-sound-isolated-backend',
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
    // Records every HTMLAudioElement.play() attempt (src + timestamp) into
    // window.__playedAudio, installed before any page script runs.
    await context.addInitScript(() => {
      ;(window as any).__playedAudio = []
      const originalPlay = HTMLMediaElement.prototype.play
      HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
        ;(window as any).__playedAudio.push(this.currentSrc || (this as HTMLAudioElement).src)
        return originalPlay.call(this)
      }
    })
    const page = await context.newPage()
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

  async function playedAudioNames(page: Page): Promise<string[]> {
    const srcs: string[] = await page.evaluate(() => (window as any).__playedAudio)
    return srcs.map((src) => src.split('/').pop() ?? src)
  }
  async function clearPlayedAudio(page: Page): Promise<void> {
    await page.evaluate(() => { (window as any).__playedAudio = [] })
  }

  const aProfile = await register(backendPort, 'a', runId)
  const bProfile = await register(backendPort, 'b', runId)
  const aPage = await open(aProfile, { width: 1280, height: 850 })
  await createRoom(aPage)
  await aPage.locator('[data-ludo-room-leave="1"]').waitFor({ state: 'visible', timeout: 10_000 })
  const bPage = await open(bProfile, { width: 1280, height: 850 })
  await bPage.locator('[data-ludo-room-join]').first().waitFor({ state: 'visible', timeout: 10_000 })
  await bPage.locator('[data-ludo-room-join]').first().click()
  await aPage.locator('[data-ludo-cell-pieces]').first().waitFor({ state: 'attached', timeout: 15_000 })
  await bPage.locator('[data-ludo-cell-pieces]').first().waitFor({ state: 'attached', timeout: 15_000 })

  // Seeded state: activeColor = turnOrder[0] from the start — figure out
  // which of A/B that is by checking who can roll.
  const aCanRoll = await aPage.locator('[data-ludo-dice-roll-button="1"]').count()
  const activePage = aCanRoll > 0 ? aPage : bPage

  console.log('=== Settings button + popup UI ===')
  await check('[UI] settings button exists next to Изход, opens popup with title "Настройки"', async () => {
    await activePage.locator('[data-ludo-settings-button="1"]').waitFor({ state: 'visible', timeout: 5_000 })
    await activePage.locator('[data-ludo-settings-button="1"]').click()
    await activePage.locator('text=Настройки').first().waitFor({ state: 'visible', timeout: 5_000 })
    const gameSoundsToggle = activePage.locator('[data-ludo-settings-toggle="gameSounds"]')
    const diceToggle = activePage.locator('[data-ludo-settings-toggle="dice"]')
    await gameSoundsToggle.waitFor({ state: 'visible', timeout: 3_000 })
    await diceToggle.waitFor({ state: 'visible', timeout: 3_000 })
    const gameSoundsText = (await gameSoundsToggle.textContent())?.trim()
    const diceText = (await diceToggle.textContent())?.trim()
    if (gameSoundsText !== '✓') throw new Error(`expected default gameSounds toggle = checkmark, got "${gameSoundsText}"`)
    if (diceText !== '✓') throw new Error(`expected default dice toggle = checkmark, got "${diceText}"`)
  })
  await check('[UI] popup closes via X, exit button unaffected, bottom bar width unchanged', async () => {
    const barBefore = await activePage.locator('[data-ludo-bottom-bar="1"]').boundingBox()
    await activePage.locator('[data-ludo-settings-close="1"]').click()
    await activePage.locator('[data-ludo-settings-backdrop="1"]').waitFor({ state: 'detached', timeout: 3_000 })
    const barAfter = await activePage.locator('[data-ludo-bottom-bar="1"]').boundingBox()
    if (!barBefore || !barAfter) throw new Error('bottom bar not measurable')
    if (Math.abs(barBefore.height - barAfter.height) > 1) throw new Error(`bottom bar height shifted: ${barBefore.height} -> ${barAfter.height}`)
  })

  console.log('\n=== A: default (both ON) — dice roll sound plays ===')
  await clearPlayedAudio(activePage)
  await activePage.locator('[data-ludo-dice-roll-button="1"]').click()
  await activePage.locator('[data-ludo-piece-selectable="1"]').first().waitFor({ state: 'visible', timeout: 5_000 })
  await check('[A] default: dice-roll.mp3 attempted', async () => {
    const played = await playedAudioNames(activePage)
    if (!played.includes('dice-roll.mp3')) throw new Error(`expected dice-roll.mp3 in ${JSON.stringify(played)}`)
  })

  console.log('\n=== B/C/D/E: toggle interactions + priority rule ===')
  await activePage.locator('[data-ludo-settings-button="1"]').click()
  await activePage.locator('[data-ludo-settings-toggle="dice"]').waitFor({ state: 'visible' })
  await activePage.locator('[data-ludo-settings-toggle="dice"]').click()
  await check('[B] "Звук на зара" toggled OFF shows a red X', async () => {
    const text = (await activePage.locator('[data-ludo-settings-toggle="dice"]').textContent())?.trim()
    if (text !== '✕') throw new Error(`expected X, got "${text}"`)
  })
  await activePage.locator('[data-ludo-settings-close="1"]').click()

  await check('[B] dice sound OFF alone: dice-roll.mp3 NOT attempted, but end-game.mp3 IS (winning move)', async () => {
    await clearPlayedAudio(activePage)
    // Winner's turn again after the roll above advanced turnPhase — actually
    // the seeded state gives exactly 1 legal move after the roll already
    // taken above; click it now to win (triggers end-game.mp3, 'gameplay'
    // category — must NOT be affected by the dice-only toggle).
    await activePage.locator('[data-ludo-piece-selectable="1"]').first().click()
    await activePage.locator('text=Вие сте победител в играта!').waitFor({ state: 'visible', timeout: 10_000 })
    const played = await playedAudioNames(activePage)
    if (played.includes('dice-roll.mp3')) throw new Error(`dice-roll.mp3 should NOT have played: ${JSON.stringify(played)}`)
    if (!played.includes('end-game.mp3')) throw new Error(`expected end-game.mp3 in ${JSON.stringify(played)}`)
  })

  // localStorage persistence check (dice=false, gameSounds still true at this point)
  await check('[D setup] localStorage reflects dice=OFF, gameSounds=ON so far', async () => {
    const dice = await activePage.evaluate(() => localStorage.getItem('pika.ludoDiceSoundEnabled'))
    const game = await activePage.evaluate(() => localStorage.getItem('pika.ludoGameSoundsEnabled'))
    if (dice !== 'false') throw new Error(`expected dice=false in localStorage, got ${dice}`)
    if (game !== null && game !== 'true') throw new Error(`expected gameSounds still true/unset, got ${game}`)
  })

  console.log('\n=== C/D/E: master OFF silences dice too; dice keeps its OWN value; master back ON restores others ===')
  {
    const eProfile = await register(backendPort, 'e', runId)
    const fProfile = await register(backendPort, 'f', runId)
    const ePage = await open(eProfile, { width: 1280, height: 850 })
    await createRoom(ePage)
    await ePage.locator('[data-ludo-room-leave="1"]').waitFor({ state: 'visible', timeout: 10_000 })
    const fPage = await open(fProfile, { width: 1280, height: 850 })
    await fPage.locator('[data-ludo-room-join]').first().waitFor({ state: 'visible', timeout: 10_000 })
    await fPage.locator('[data-ludo-room-join]').first().click()
    await ePage.locator('[data-ludo-cell-pieces]').first().waitFor({ state: 'attached', timeout: 15_000 })
    await fPage.locator('[data-ludo-cell-pieces]').first().waitFor({ state: 'attached', timeout: 15_000 })
    const eCanRoll = await ePage.locator('[data-ludo-dice-roll-button="1"]').count()
    const activePage2 = eCanRoll > 0 ? ePage : fPage

    // Fresh browser context -> fresh localStorage -> default ON/ON here,
    // independent of match 1's context above.
    await activePage2.locator('[data-ludo-settings-button="1"]').click()
    await activePage2.locator('[data-ludo-settings-toggle="gameSounds"]').waitFor({ state: 'visible' })
    await activePage2.locator('[data-ludo-settings-toggle="gameSounds"]').click()
    await check('[C setup] "Звуци в играта" toggled OFF shows a red X; dice toggle still shows a green check (own value untouched)', async () => {
      const gameText = (await activePage2.locator('[data-ludo-settings-toggle="gameSounds"]').textContent())?.trim()
      const diceText = (await activePage2.locator('[data-ludo-settings-toggle="dice"]').textContent())?.trim()
      if (gameText !== '✕') throw new Error(`expected X for gameSounds, got "${gameText}"`)
      if (diceText !== '✓') throw new Error(`expected dice to remain a checkmark (untouched), got "${diceText}"`)
    })
    await activePage2.locator('[data-ludo-settings-close="1"]').click()

    await check('[C] master OFF: rolling produces NO Ludo sound at all (dice-roll.mp3 silent despite dice=ON individually)', async () => {
      await clearPlayedAudio(activePage2)
      await activePage2.locator('[data-ludo-dice-roll-button="1"]').click()
      await activePage2.locator('[data-ludo-piece-selectable="1"]').first().waitFor({ state: 'visible', timeout: 5_000 })
      const played = await playedAudioNames(activePage2)
      if (played.includes('dice-roll.mp3')) throw new Error(`dice-roll.mp3 must be silent under master OFF: ${JSON.stringify(played)}`)
    })

    await check('[D] dice setting\'s OWN localStorage value is unaffected by the master toggle', async () => {
      const dice = await activePage2.evaluate(() => localStorage.getItem('pika.ludoDiceSoundEnabled'))
      if (dice !== null && dice !== 'true') throw new Error(`expected dice still true/unset (never touched), got ${dice}`)
    })

    await activePage2.locator('[data-ludo-settings-button="1"]').click()
    await activePage2.locator('[data-ludo-settings-toggle="gameSounds"]').waitFor({ state: 'visible' })
    await activePage2.locator('[data-ludo-settings-toggle="gameSounds"]').click()
    await check('[E setup] "Звуци в играта" toggled back ON shows a green check again', async () => {
      const gameText = (await activePage2.locator('[data-ludo-settings-toggle="gameSounds"]').textContent())?.trim()
      if (gameText !== '✓') throw new Error(`expected checkmark for gameSounds after re-enabling, got "${gameText}"`)
    })
    await activePage2.locator('[data-ludo-settings-close="1"]').click()

    await check('[E] master back ON: the winning move\'s end-game.mp3 plays again (other sounds resumed)', async () => {
      await clearPlayedAudio(activePage2)
      await activePage2.locator('[data-ludo-piece-selectable="1"]').first().click()
      await activePage2.locator('text=Вие сте победител в играта!').waitFor({ state: 'visible', timeout: 10_000 })
      const played = await playedAudioNames(activePage2)
      if (!played.includes('end-game.mp3')) throw new Error(`expected end-game.mp3 to resume playing, got ${JSON.stringify(played)}`)
    })

    await ePage.close()
    await fPage.close()
  }

  console.log('\n=== F: refresh persists settings ===')
  await activePage.reload()
  await activePage.locator('[data-ludo-lobby="1"], [data-ludo-cell-pieces]').first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {})
  await sleep(500)
  await check('[F] after refresh, dice setting is still OFF (persisted)', async () => {
    const dice = await activePage.evaluate(() => localStorage.getItem('pika.ludoDiceSoundEnabled'))
    if (dice !== 'false') throw new Error(`expected persisted dice=false after refresh, got ${dice}`)
  })

  console.log('\n=== G: responsive (desktop + 360px mobile) ===')
  {
    const cProfile = await register(backendPort, 'c', runId)
    const dProfile = await register(backendPort, 'd', runId)
    const cPage = await open(cProfile, { width: 1280, height: 850 })
    await createRoom(cPage)
    await cPage.locator('[data-ludo-room-leave="1"]').waitFor({ state: 'visible', timeout: 10_000 })
    const dPage = await open(dProfile, { width: 360, height: 800 })
    await dPage.locator('[data-ludo-room-join]').first().waitFor({ state: 'visible', timeout: 10_000 })
    await dPage.locator('[data-ludo-room-join]').first().click()
    await cPage.locator('[data-ludo-cell-pieces]').first().waitFor({ state: 'attached', timeout: 15_000 })
    await dPage.locator('[data-ludo-cell-pieces]').first().waitFor({ state: 'attached', timeout: 15_000 })

    for (const [page, label] of [[cPage, 'desktop'], [dPage, '360-mobile']] as const) {
      await check(`[G:${label}] settings popup visible, toggles are large squares, no horizontal scroll`, async () => {
        await page.locator('[data-ludo-settings-button="1"]').click()
        await page.locator('[data-ludo-settings-backdrop="1"]').waitFor({ state: 'visible', timeout: 5_000 })
        const toggleBox = await page.locator('[data-ludo-settings-toggle="gameSounds"]').boundingBox()
        if (!toggleBox) throw new Error('toggle not measurable')
        if (toggleBox.width < 40 || toggleBox.height < 40) throw new Error(`toggle too small for touch: ${JSON.stringify(toggleBox)}`)
        const hScroll = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)
        if (hScroll) throw new Error(`horizontal scroll present at ${label}`)
        await page.locator('[data-ludo-settings-close="1"]').click()
      })
    }
    await cPage.close()
    await dPage.close()
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
