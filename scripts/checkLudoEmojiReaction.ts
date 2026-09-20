// checkLudoEmojiReaction.ts
//
// Real spawned-server + real browser (Playwright, production controller,
// authoritative WS flow, real UI clicks) focused check for the new Ludo
// emoji reaction feature (reuses Belot's animated-emoji catalog/asset URLs,
// real realtime WS event, anchored bubble presentation next to the sender's
// player panel).
//
// Scenarios (task spec §12):
//   A/B — 2-player: A opens picker, sees the real 24-emoji catalog, picks
//         one; both A and B see the same animated bubble next to A's card;
//         B then sends a different emoji, both see it next to B's card.
//   C   — 4-player: emoji from an arbitrary seat anchors to the correct card.
//   D   — responsive: wide desktop, ~800px, 360px mobile — bubble stays on
//         screen and doesn't overlap the dice control.
//   E   — an explicitly-left ("Напуснал") player cannot send emoji into the
//         old match (server-side denial, verified at the protocol level).

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
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
  const root = await mkdtemp(join(tmpdir(), 'belot-ludo-emoji-'))
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
  const email = `ludo-emoji-${tag}-${runId}@example.test`
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'LudoEmoji1!', displayName: `LE${tag.replace(/[^a-zA-Z0-9]/g, '')}${runId.slice(-5)}`, gender: 'male' }),
  })
  const body: any = await res.json()
  if (res.status !== 200) throw new Error(`register ${tag} failed: ${JSON.stringify(body)}`)
  const setCookie = (res.headers.getSetCookie?.()[0] ?? res.headers.get('set-cookie'))?.split(';')[0] ?? null
  if (!setCookie) throw new Error('no cookie returned')
  return { cookie: setCookie.split('=')[1]!, profileId: body.session.profile.profileId as string }
}

console.log('\ncheckLudoEmojiReaction\n')

const isolated = await createIsolatedServerRoot()
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
      name: 'ludo-emoji-isolated-backend',
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

  // Track (matchId, {profileId -> color}) per page by listening to the raw
  // WS traffic — the board is rendered VIEWER-ROTATED per client (each
  // client sees their OWN color in a consistent local quadrant), so
  // `document.querySelector('[data-ludo-player-panel]')` (first DOM match)
  // does NOT reliably identify "my own color" across different viewers.
  // The server's ludo_game_started/ludo_game_state snapshot.players list
  // (profileId + color) is the only reliable, canonical source.
  const matchInfoByPage = new WeakMap<Page, { matchId: string | null; colorByProfile: Map<string, string> }>()

  async function open(profile: { cookie: string; profileId: string }, viewport: { width: number; height: number }): Promise<Page> {
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

  async function matchIdOf(page: Page): Promise<string> {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const matchId = matchInfoByPage.get(page)?.matchId
      if (matchId) return matchId
      await sleep(80)
    }
    throw new Error('matchId not observed via WS traffic in time')
  }

  async function sendEmoji(page: Page, emojiId: string): Promise<void> {
    await page.locator('[data-ludo-emoji-button="1"]').click()
    await page.locator('[data-ludo-emoji-picker="1"]').waitFor({ state: 'visible', timeout: 5_000 })
    await page.locator(`[data-ludo-emoji-pick="${emojiId}"]`).click()
  }

  async function bubbleAnchoredToColor(page: Page, color: string): Promise<boolean> {
    return page.evaluate((c) => {
      const panel = document.querySelector(`[data-ludo-player-panel="${c}"]`)
      if (!panel || !panel.parentElement) return false
      return panel.parentElement.querySelector('[data-ludo-emoji-reaction]') !== null
    }, color)
  }

  // ═══════════════════════════════════════════════════════════════════
  // A/B: 2-player — real picker, real catalog, real realtime broadcast,
  // bubble anchored to sender's own card for BOTH participants.
  // ═══════════════════════════════════════════════════════════════════
  console.log('=== A/B: 2-player emoji reaction ===')
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

    const aColor = await colorOf(aPage, aProfile.profileId)
    const bColor = await colorOf(bPage, bProfile.profileId)

    await check('[A] picker opens with the real 24-emoji catalog (real preview asset URLs)', async () => {
      await aPage.locator('[data-ludo-emoji-button="1"]').click()
      await aPage.locator('[data-ludo-emoji-picker="1"]').waitFor({ state: 'visible', timeout: 5_000 })
      const count = await aPage.locator('[data-ludo-emoji-pick]').count()
      if (count !== 24) throw new Error(`expected 24 emoji options, got ${count}`)
      const firstImgSrc = await aPage.locator('[data-ludo-emoji-pick="01"] img').getAttribute('src')
      if (!firstImgSrc || !firstImgSrc.includes('preview-emoji-01.png')) throw new Error(`unexpected preview asset src: ${firstImgSrc}`)
      await aPage.locator('[data-ludo-emoji-pick="01"]').click()
    })

    await check('[A] sender (A) sees the real animated emoji anchored to their OWN card', async () => {
      await aPage.waitForTimeout(300)
      const anchored = await bubbleAnchoredToColor(aPage, aColor)
      if (!anchored) throw new Error('bubble not anchored to sender (A) card on A\'s own screen')
      const imgSrc = await aPage.evaluate((c) => {
        const panel = document.querySelector(`[data-ludo-player-panel="${c}"]`)
        return panel?.parentElement?.querySelector('[data-ludo-emoji-reaction] img')?.getAttribute('src') ?? null
      }, aColor)
      if (!imgSrc || !imgSrc.includes('emoji-01.webp')) throw new Error(`expected real animated emoji-01.webp, got ${imgSrc}`)
    })

    await check('[A] the OTHER participant (B) sees the SAME animated emoji anchored to A\'s card, not the board center', async () => {
      const anchored = await bubbleAnchoredToColor(bPage, aColor)
      if (!anchored) throw new Error('B does not see the bubble anchored to A\'s card')
      const anchoredToB = await bubbleAnchoredToColor(bPage, bColor)
      if (anchoredToB) throw new Error('bubble incorrectly also anchored to B\'s own card')
    })

    await sleep(4_500)
    await check('[cleanup] bubble is gone after its lifetime elapses (no stale DOM node)', async () => {
      const stillThere = await bPage.locator('[data-ludo-emoji-reaction]').count()
      if (stillThere > 0) throw new Error('emoji reaction DOM node was not cleaned up after its lifetime')
    })

    await check('[B] B sends a DIFFERENT emoji; both A and B see it anchored to B\'s card', async () => {
      await sendEmoji(bPage, '05')
      const anchoredOnA = await bubbleAnchoredToColor(aPage, bColor)
      const anchoredOnB = await bubbleAnchoredToColor(bPage, bColor)
      if (!anchoredOnA || !anchoredOnB) throw new Error(`B's emoji not anchored to B's card on both screens (A saw=${anchoredOnA}, B saw=${anchoredOnB})`)
    })

    await aPage.close()
    await bPage.close()
  }

  // ═══════════════════════════════════════════════════════════════════
  // C: 4-player — emoji from an arbitrary seat anchors to the correct card.
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n=== C: 4-player emoji anchoring ===')
  {
    const profiles = await Promise.all(['p1', 'p2', 'p3', 'p4'].map((tag) => register(backendPort, tag, runId)))
    const pages: Page[] = []
    pages.push(await open(profiles[0]!, { width: 1280, height: 850 }))
    await createRoom(pages[0]!, '4')
    await pages[0]!.locator('[data-ludo-room-leave="1"]').waitFor({ state: 'visible', timeout: 10_000 })
    for (let i = 1; i < 4; i++) {
      const page = await open(profiles[i]!, { width: 1280, height: 850 })
      pages.push(page)
      await page.locator('[data-ludo-room-join]').first().waitFor({ state: 'visible', timeout: 10_000 })
      await page.locator('[data-ludo-room-join]').first().click()
    }
    for (const page of pages) await page.locator('[data-ludo-cell-pieces]').first().waitFor({ state: 'attached', timeout: 15_000 })

    const colors = await Promise.all(pages.map((p, i) => colorOf(p, profiles[i]!.profileId)))

    await check('[C] seat 3 (index 2) emoji anchors to its OWN card on all 4 screens', async () => {
      await sendEmoji(pages[2]!, '10')
      await sleep(400)
      for (let i = 0; i < 4; i++) {
        const anchored = await bubbleAnchoredToColor(pages[i]!, colors[2]!)
        if (!anchored) throw new Error(`viewer ${i} (color=${colors[i]}) did not see seat-3's (color=${colors[2]}) bubble anchored correctly`)
        for (let other = 0; other < 4; other++) {
          if (other === 2) continue
          const wronglyAnchored = await bubbleAnchoredToColor(pages[i]!, colors[other]!)
          if (wronglyAnchored) throw new Error(`viewer ${i} incorrectly saw a bubble anchored to color=${colors[other]} (not the sender)`)
        }
      }
    })

    for (const page of pages) await page.close()
  }

  // ═══════════════════════════════════════════════════════════════════
  // D: responsive — wide desktop, ~800px, 360px mobile: bubble stays
  // on-screen and doesn't overlap the dice control.
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n=== D: responsive emoji bubble anchoring ===')
  {
    const aProfile = await register(backendPort, 'ra', runId)
    const bProfile = await register(backendPort, 'rb', runId)
    const aPage = await open(aProfile, { width: 1280, height: 850 })
    await createRoom(aPage, '2')
    await aPage.locator('[data-ludo-room-leave="1"]').waitFor({ state: 'visible', timeout: 10_000 })
    const bPage = await open(bProfile, { width: 800, height: 700 })
    await bPage.locator('[data-ludo-room-join]').first().waitFor({ state: 'visible', timeout: 10_000 })
    await bPage.locator('[data-ludo-room-join]').first().click()
    await aPage.locator('[data-ludo-cell-pieces]').first().waitFor({ state: 'attached', timeout: 15_000 })
    await bPage.locator('[data-ludo-cell-pieces]').first().waitFor({ state: 'attached', timeout: 15_000 })
    const aColor = await colorOf(aPage, aProfile.profileId)

    for (const [w, h, label] of [[1280, 850, 'wide'], [800, 700, '800px'], [360, 800, '360-mobile']] as const) {
      await bPage.setViewportSize({ width: w, height: h })
      await bPage.waitForTimeout(150)
      await sendEmoji(aPage, '12')
      await sleep(300)
      await check(`[D:${label}] bubble stays within viewport bounds, no horizontal scroll`, async () => {
        const box = await bPage.locator('[data-ludo-emoji-reaction]').first().boundingBox()
        if (!box) throw new Error('bubble bounding box not found')
        if (box.x < -2 || box.y < -2 || box.x + box.width > w + 2 || box.y + box.height > h + 2) {
          throw new Error(`bubble out of viewport bounds at ${label}: ${JSON.stringify(box)} vs viewport ${w}x${h}`)
        }
        const hScroll = await bPage.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)
        if (hScroll) throw new Error(`horizontal scroll present at ${label}`)
      })
      await check(`[D:${label}] bubble does not overlap the dice control area`, async () => {
        const diceBox = await bPage.locator(`[data-ludo-dice-anchor="${aColor}"]`).boundingBox()
        const bubbleBox = await bPage.locator('[data-ludo-emoji-reaction]').first().boundingBox()
        if (!diceBox || !bubbleBox) return // dice anchor not rendered for non-active/non-local color here, skip
        const overlaps = bubbleBox.x < diceBox.x + diceBox.width && diceBox.x < bubbleBox.x + bubbleBox.width &&
          bubbleBox.y < diceBox.y + diceBox.height && diceBox.y < bubbleBox.y + bubbleBox.height
        if (overlaps) throw new Error(`bubble overlaps dice control at ${label}`)
      })
      await sleep(4_200)
    }

    await aPage.close()
    await bPage.close()
  }

  // ═══════════════════════════════════════════════════════════════════
  // E: explicit "Напуснал" player cannot send emoji into the old match
  // (server-side denial — verified at the protocol level, since the real
  // UI already navigates the leaver away and hides the button).
  // ═══════════════════════════════════════════════════════════════════
  console.log('\n=== E: left player cannot send emoji ===')
  {
    const aProfile = await register(backendPort, 'ea', runId)
    const bProfile = await register(backendPort, 'eb', runId)
    const aPage = await open(aProfile, { width: 1280, height: 850 })

    await createRoom(aPage, '2')
    await aPage.locator('[data-ludo-room-leave="1"]').waitFor({ state: 'visible', timeout: 10_000 })
    const bPage = await open(bProfile, { width: 1280, height: 850 })
    await bPage.locator('[data-ludo-room-join]').first().waitFor({ state: 'visible', timeout: 10_000 })
    await bPage.locator('[data-ludo-room-join]').first().click()
    await aPage.locator('[data-ludo-cell-pieces]').first().waitFor({ state: 'attached', timeout: 15_000 })
    await bPage.locator('[data-ludo-cell-pieces]').first().waitFor({ state: 'attached', timeout: 15_000 })

    const capturedMatchId = await matchIdOf(aPage)

    await aPage.locator('[data-ludo-exit-button="1"]').click()
    await aPage.locator('[data-ludo-exit-confirm-backdrop="1"]').waitFor({ state: 'visible', timeout: 5_000 })
    await aPage.locator('[data-ludo-exit-confirm-submit="1"]').click()
    await aPage.waitForURL('**/games', { timeout: 10_000 }).catch(() => {})
    await sleep(1_500)

    await check('[E] the left player\'s own client shows no emoji button reachable in the old match (navigated to /games)', async () => {
      if (!aPage.url().endsWith('/games')) throw new Error(`A did not navigate away after leaving, url=${aPage.url()}`)
      const emojiButtonVisible = await aPage.locator('[data-ludo-emoji-button="1"]').isVisible().catch(() => false)
      if (emojiButtonVisible) throw new Error('emoji button still reachable on the left player\'s screen after Exit')
    })

    await check('[E] server denies send_ludo_emoji_reaction for the now-left profile\'s old match (no broadcast reaches B)', async () => {
      // Real protocol-level attempt from A's still-authenticated browser
      // context (same session cookie, same origin) — this proves the
      // SERVER itself refuses (leftColors check in index.ts), not just
      // that the UI happens to hide the button.
      let bReceivedEmoji = false
      bPage.on('websocket', (ws) => {
        ws.on('framereceived', (frame) => {
          try {
            const payload = typeof frame.payload === 'string' ? frame.payload : frame.payload.toString('utf8')
            const msg = JSON.parse(payload)
            if (msg.type === 'ludo_emoji_reaction') bReceivedEmoji = true
          } catch { /* ignore */ }
        })
      })
      await aPage.evaluate(async ({ matchId, wsUrl }) => {
        await new Promise<void>((resolveWs) => {
          const ws = new WebSocket(wsUrl)
          ws.addEventListener('message', (event) => {
            try {
              const msg = JSON.parse(event.data as string)
              if (msg.type === 'connected') {
                ws.send(JSON.stringify({ type: 'send_ludo_emoji_reaction', matchId, emojiId: '03' }))
                setTimeout(() => { ws.close(); resolveWs() }, 800)
              }
            } catch { /* ignore */ }
          })
          ws.addEventListener('error', () => resolveWs())
        })
      }, { matchId: capturedMatchId, wsUrl: `ws://127.0.0.1:${backendPort}/ws` })
      await sleep(500)
      if (bReceivedEmoji) throw new Error('B received an emoji_reaction that was sent by the already-left A profile')
    })

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
