// Chromium component tests: explicit protected snapshot fixtures and fake time.
// The separate checkSvaraClientRealIntegration is the real HTTP/auth/WS harness.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import { chromium } from 'playwright'

const outDir = resolve('tmp/svara-decision-browser')
await mkdir(outDir, { recursive: true })
const vite = await createServer({ configFile: false, root: resolve('.'), logLevel: 'error',
  optimizeDeps: { noDiscovery: true, entries: [] }, server: { host: '127.0.0.1', port: 0 },
  plugins: [{ name: 'svara-decision-qa', configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.url !== '/__svara_decision_qa') return next()
      res.setHeader('Content-Type', 'text/html')
      res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:#030303}</style><div id="root"></div>')
    })
  } }],
})
await vite.listen()
const address = vite.httpServer!.address()
assert(address && typeof address !== 'string')
const browser = await chromium.launch({ headless: true })
const errors: string[] = [], report: Array<{ viewport: string; checks: string[] }> = []
try {
  for (const [width, height] of [[320, 568], [390, 844], [844, 390], [1280, 900]]) {
    const page = await browser.newPage({ viewport: { width: width!, height: height! } })
    await page.addInitScript('globalThis.__name = (target) => target')
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${address.port}/__svara_decision_qa`)
    const checks = await page.evaluate(async () => {
      const controllerPath = '/src/app/games/svara/createSvaraLobbyController.ts'
      const fixturePath = '/scripts/fixtures/svaraDecisionFixtures.ts'
      const clockPath = '/src/app/network/serverClock.ts'
      const { createSvaraLobbyController } = await import(controllerPath)
      const { svaraDecisionFixture, RESULT_START } = await import(fixturePath)
      const { sharedServerClock } = await import(clockPath)
      const root = document.querySelector<HTMLElement>('#root')!
      const originalNow = Date.now
      let now = RESULT_START + 6300
      Date.now = () => now
      sharedServerClock.reset()
      const checks: string[] = []
      const calls: Array<{ matchId: string; commandId: string; revision: number; command: { type: string } }> = []
      const wait = () => new Promise((done) => setTimeout(done, 300))
      const frames = () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())))
      function ok(value: unknown, label: string) { if (!value) throw new Error(label); checks.push(label) }
      const mount = (localProfileId = 'carol') => createSvaraLobbyController({ root, localProfileId,
        onRefresh() {}, onCreate() {}, onJoin() {}, onLeave() {}, onStart() {}, onRequestTableState() {},
        onSubmitCommand(matchId: string, commandId: string, revision: number, command: { type: string }) { calls.push({ matchId, commandId, revision, command }) },
      })
      let controller = mount()
      const send = (input: ReturnType<typeof svaraDecisionFixture>) => {
        controller.setMyTable(input.table); controller.setSnapshot(input.snapshot); controller.setTiming(input.timing)
      }
      const click = (action: string) => root.querySelector<HTMLButtonElement>(`[data-svara-decision-action="${action}"]`)!.click()
      function layout(label: string) {
        const dialog = root.querySelector<HTMLElement>('[data-svara-decision-window]')!
        const rect = dialog.getBoundingClientRect()
        ok(rect.left >= 0 && rect.top >= 0 && rect.right <= window.innerWidth + 1 && rect.bottom <= window.innerHeight + 1, `${label}: dialog stays in viewport`)
        ok(dialog.scrollHeight <= dialog.clientHeight + 1, `${label}: contents fit without scrolling`)
        ok(Array.from(dialog.querySelectorAll('button')).every((button) => button.getBoundingClientRect().height >= 44), `${label}: phone touch targets at least 44px`)
        ok(document.documentElement.scrollWidth <= window.innerWidth + 1, `${label}: no horizontal overflow`)
        ok(dialog.querySelector('[data-svara-decision-seconds]'), `${label}: timer remains visible in dialog`)
      }
      try {
        const joining = svaraDecisionFixture()
        send(joining)
        ok(root.querySelector('[data-svara-joining-fee]')!.textContent!.includes('625'), 'joining fee is exact server value')
        ok(root.querySelector('[data-svara-decision-seconds]')!.textContent === '9', 'joining reconnect resumes at 9s, not 15s')
        layout('joining')
        const button = root.querySelector<HTMLButtonElement>('[data-svara-decision-action="join"]')!
        button.focus()
        now += 1000
        await wait()
        ok(root.querySelector('[data-svara-decision-action="join"]') === button && document.activeElement === button && root.querySelector('[data-svara-decision-seconds]')!.textContent === '8', 'ticks update countdown without replacing focused buttons')
        click('join'); click('join')
        ok(calls.length === 1 && calls[0]!.command.type === 'svara-join' && calls[0]!.revision === joining.snapshot.revision && !!calls[0]!.commandId, 'double join emits one existing command with commandId and revision')
        ok(root.querySelectorAll('button[data-svara-decision-action]:disabled').length === 2, 'both actions disabled while pending')
        ok(joining.snapshot.seats[2].stack === 700, 'click does not deduct local chips')
        const first = calls[0]!.commandId
        controller.onCommandError('Недостатъчно чипове', first)
        ok(root.querySelector('[role="alert"]')!.textContent === 'Недостатъчно чипове', 'rejected fee action shows server error and permits retry')
        click('join')
        ok(calls.length === 2 && calls[1]!.commandId !== first, 'retry uses a fresh commandId')
        controller.onCommandError('Стар отказ', first)
        ok(root.querySelectorAll('button[data-svara-decision-action]:disabled').length === 2, 'old command error cannot unlock a newer request')
        controller.onCommandResult(calls[1]!.commandId)
        controller.setSnapshot(joining.snapshot) // duplicate still undecided, before authoritative update
        click('join')
        ok(calls.length === 2 && root.querySelectorAll('button[data-svara-decision-action]:disabled').length === 2, 'ACK before snapshot never permits another command')
        joining.snapshot.revision++; joining.timing.revision++
        joining.snapshot.you.svaraDecision = 'joined'
        joining.snapshot.round.decisions[0].status = 'joined'
        joining.snapshot.round.joiners = ['carol']
        joining.snapshot.seats[2].stack = 75 // next authoritative snapshot, not client accounting
        joining.snapshot.lockedPots[0].eligible.push('carol')
        send(joining)
        ok(!root.querySelector('[data-svara-decision-window]'), 'confirmed join closes local window')
        ok(root.querySelector('[data-svara-seat-index="2"]')!.textContent!.includes('ВКЛЮЧВА СЕ'), 'joined badge belongs to the matching profile')
        joining.snapshot.round.decisions[1].status = 'declined'
        controller.setSnapshot(joining.snapshot)
        ok(root.querySelector('[data-svara-seat-index="3"]')!.textContent!.includes('ПРОПУСКА'), 'other participant decline comes directly from server')
        controller.destroy(); controller = mount(); send(joining)
        ok(!root.querySelector('[data-svara-decision-window]') && root.querySelector('[data-svara-seat-index="2"]')!.textContent!.includes('ВКЛЮЧВА СЕ') && root.querySelector('[data-svara-seat-index="3"]')!.textContent!.includes('ПРОПУСКА'), 'remount restores completed public choices without reopening the dialog')
        const decline = svaraDecisionFixture()
        decline.snapshot.round.roundId = 'joining-decline'
        send(decline); click('decline')
        ok(calls.at(-1)!.command.type === 'svara-decline', 'skip sends existing decline command')
        decline.snapshot.round = null
        controller.setSnapshot(decline.snapshot)
        ok(!root.querySelector('[data-svara-decision-window]'), 'early authoritative transition closes window and pending state')
        const stale = button.cloneNode(true) as HTMLButtonElement
        root.appendChild(stale)
        const beforeStale = calls.length
        stale.click(); stale.remove()
        ok(calls.length === beforeStale, 'a stale detached window button cannot decide in another phase')
        const timeout = svaraDecisionFixture()
        timeout.snapshot.round.roundId = 'joining-timeout'
        now = RESULT_START + 14999
        send(timeout)
        const beforeTimeout = calls.length
        ok(root.querySelector('[data-svara-decision-seconds]')!.textContent === '1', 'joining final second uses absolute deadline')
        now++
        click('join')
        ok(calls.length === beforeTimeout, 'deadline rechecked on click even before the next UI tick')
        await wait()
        ok(!root.querySelector('[data-svara-decision-window]') && calls.length === beforeTimeout, 'joining expiry removes actions without inventing a decline command')
        ok(root.querySelector('[data-svara-seat-index="2"]')!.textContent!.includes('ИЗЧАКВА СЕ'), 'deadline alone does not fabricate public declined status')
        controller.destroy(); controller = mount('alice')
        now = RESULT_START + 3100
        const reveal = svaraDecisionFixture('reveal', 'alice')
        send(reveal)
        ok(root.querySelector('[data-svara-decision-seconds]')!.textContent === '2', 'winner reconnect resumes remaining 2s, not 5s')
        layout('reveal')
        const beforeReveal = calls.length
        click('reveal'); click('reveal')
        ok(calls.length === beforeReveal + 1 && calls.at(-1)!.command.type === 'reveal-cards', 'show submits once with existing reveal command')
        reveal.snapshot.revision++; reveal.timing.revision++
        reveal.snapshot.round.decision = 'revealed'
        reveal.snapshot.round.cards = ['AC', 'AH', 'AS']; reveal.snapshot.round.handPoints = 33
        reveal.snapshot.you.revealChoice.canDecide = false
        reveal.timing.deadlines = [{ kind: 'reveal-display', deadlineAt: now + 3000, remainingMs: 3000, playerId: 'alice' }]
        send(reveal)
        ok(!root.querySelector('[data-svara-decision-window]'), 'public reveal closes the choice window')
        now += 500
        await frames()
        ok(root.querySelectorAll('[data-svara-reveal-cards] img').length === 3 && root.querySelector('[data-svara-reveal-points]')!.textContent === '33', 'existing reveal animation shows exactly winner cards and server points')
        now += 2500
        await frames()
        ok(!root.querySelector('[data-svara-reveal-cards]'), 'public cards disappear at exact 3s deadline without another snapshot')
        const hide = svaraDecisionFixture('reveal', 'alice')
        hide.snapshot.round.roundId = 'reveal-hide'
        now = RESULT_START + 1000
        send(hide); click('hide')
        ok(calls.at(-1)!.command.type === 'hide-cards', 'hide uses existing command')
        hide.snapshot.round = null; hide.snapshot.you.cards = null
        controller.setSnapshot(hide.snapshot)
        ok(!root.querySelector('[data-svara-reveal-cards],[data-svara-decision-window]'), 'confirmed hide never publicly reveals cards')
        const expired = svaraDecisionFixture('reveal', 'alice')
        expired.snapshot.round.roundId = 'reveal-timeout'
        now = RESULT_START + 4999
        send(expired)
        const beforeExpiry = calls.length
        now++
        await wait()
        ok(!root.querySelector('[data-svara-decision-window],[data-svara-reveal-cards]') && calls.length === beforeExpiry, '5s reveal expiry sends no local hide command and leaks no public cards')
        controller.destroy(); controller = mount()
        now = RESULT_START + 2000
        const observer = svaraDecisionFixture('reveal', 'carol')
        send(observer)
        ok(root.querySelector('[data-svara-reveal-waiting]') && !root.querySelector('[data-svara-decision-action],[data-svara-own-cards],[data-svara-reveal-cards]'), 'opponents see waiting state without winner buttons or private cards')
        const fresh = svaraDecisionFixture()
        send(fresh)
        controller.destroy(); controller = mount(); send(fresh)
        ok(root.querySelector('[data-svara-decision-seconds]')!.textContent === '13' && !root.querySelector('[data-svara-decision-pending]'), 'remount restores actual remaining time without resubmitting a choice')
        if (typeof document.documentElement.requestFullscreen === 'function') {
          const table = root.querySelector<HTMLElement>('[data-svara-table]')!
          await table.requestFullscreen()
          controller.setTiming(fresh.timing)
          ok(document.fullscreenElement === table && table.contains(root.querySelector('[data-svara-decision-window]')), 'fullscreen keeps original table node and contains the decision window through updates')
          layout('fullscreen joining')
          await document.exitFullscreen()
        }
        return checks
      } finally {
        if (document.fullscreenElement) await document.exitFullscreen()
        controller.destroy(); Date.now = originalNow; sharedServerClock.reset()
      }
    })
    // Actual reload: reconstruct each window from a fresh module graph and the
    // same authoritative deadline; no controller-local timer is retained.
    for (const kind of ['joining', 'reveal'] as const) {
      await page.reload()
      const restored = await page.evaluate(async (kind) => {
        const controllerPath = '/src/app/games/svara/createSvaraLobbyController.ts'
        const fixturePath = '/scripts/fixtures/svaraDecisionFixtures.ts'
        const clockPath = '/src/app/network/serverClock.ts'
        const { createSvaraLobbyController } = await import(controllerPath)
        const { svaraDecisionFixture, RESULT_START } = await import(fixturePath)
        const { sharedServerClock } = await import(clockPath)
        const viewer = kind === 'joining' ? 'carol' : 'alice'
        const input = svaraDecisionFixture(kind, viewer)
        sharedServerClock.recordServerNowSample(RESULT_START + (kind === 'joining' ? 6300 : 3100))
        const root = document.querySelector<HTMLElement>('#root')!
        const controller = createSvaraLobbyController({ root, localProfileId: viewer, onRefresh() {}, onCreate() {}, onJoin() {}, onLeave() {}, onStart() {}, onRequestTableState() {}, onSubmitCommand() { throw new Error('reload submitted a command') } })
        controller.setMyTable(input.table); controller.setSnapshot(input.snapshot); controller.setTiming(input.timing)
        const seconds = root.querySelector('[data-svara-decision-seconds]')!.textContent
        return { seconds }
      }, kind)
      assert.equal(restored.seconds, kind === 'joining' ? '9' : '2')
      await page.screenshot({ path: resolve(outDir, `${kind}-${width}x${height}.png`), fullPage: true })
      checks.push(`${kind}: actual refresh restores remaining time without a command`)
    }
    report.push({ viewport: `${width}x${height}`, checks })
    console.log(`  ok ${width}x${height}: ${checks.length} Chromium component assertions`)
    await page.close()
  }
  assert.deepEqual(errors, [])
  await writeFile(resolve(outDir, 'report.json'), JSON.stringify({ kind: 'Chromium component fixtures; not HTTP/auth/WS integration', report, errors }, null, 2))
  console.log(`Screenshots and report: ${outDir}`)
} catch (error) {
  const page = browser.contexts().flatMap((context) => context.pages()).at(-1)
  if (page) await page.screenshot({ path: resolve(outDir, 'failure.png'), fullPage: true })
  throw error
} finally { await browser.close(); await vite.close() }
