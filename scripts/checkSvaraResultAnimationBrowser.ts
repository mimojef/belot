// Real Chromium component QA using explicit snapshot fixtures and a fake server
// clock. This is NOT the real HTTP/auth/WebSocket integration harness.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import { chromium } from 'playwright'

const outDir = resolve('tmp/svara-result-browser')
await mkdir(outDir, { recursive: true })
const vite = await createServer({
  configFile: false, root: resolve('.'), logLevel: 'error',
  optimizeDeps: { noDiscovery: true, entries: [] },
  server: { host: '127.0.0.1', port: 0, strictPort: false },
  plugins: [{
    name: 'svara-component-qa-page',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url !== '/__svara_result_qa') return next()
        res.setHeader('Content-Type', 'text/html')
        res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:#030303}</style><div id="root"></div>')
      })
    },
  }],
})
await vite.listen()
const address = vite.httpServer!.address()
assert(address && typeof address !== 'string')
const browser = await chromium.launch({ headless: true })
const errors: string[] = []
const report: Array<{ viewport: string; checks: string[] }> = []
try {
  for (const [width, height] of [[320, 568], [390, 844], [844, 390], [1280, 900]]) {
    const page = await browser.newPage({ viewport: { width: width!, height: height! } })
    await page.addInitScript('globalThis.__name = (target) => target') // tsx keepNames helper inside evaluate
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${address.port}/__svara_result_qa`)
    const checks = await page.evaluate(async () => {
      const controllerPath = '/src/app/games/svara/createSvaraLobbyController.ts'
      const fixturePath = '/scripts/fixtures/svaraResultFixtures.ts'
      const clockPath = '/src/app/network/serverClock.ts'
      const { createSvaraLobbyController } = await import(controllerPath)
      const { svaraResultFixture, RESULT_START, setFixturePayout } = await import(fixturePath)
      const { sharedServerClock } = await import(clockPath)
      const root = document.querySelector<HTMLElement>('#root')!
      const originalNow = Date.now
      let now = RESULT_START + 105
      Date.now = () => now
      sharedServerClock.reset()
      const checks: string[] = []
      function ok(condition: unknown, label: string) {
        if (!condition) throw new Error(label)
        checks.push(label)
      }
      const frame = () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())))
      let commandCount = 0
      const mount = () => createSvaraLobbyController({
        root, localProfileId: 'alice', onRefresh() {}, onCreate() {}, onJoin() {}, onLeave() { commandCount++ },
        onStart() { commandCount++ }, onRequestTableState() {}, onSubmitCommand() { commandCount++ },
      })
      let controller = mount()
      const input = svaraResultFixture()
      const send = () => {
        controller.setMyTable(input.table)
        controller.setSnapshot(input.snapshot)
        controller.setTiming(input.timing)
      }
      function layout(label: string) {
        const anchors = Array.from(root.querySelectorAll<HTMLElement>('[data-svara-seat-anchor]')).map((el) => el.getBoundingClientRect())
        const felt = root.querySelector<HTMLElement>('[data-svara-felt]')!.getBoundingClientRect()
        ok(document.documentElement.scrollWidth <= window.innerWidth + 1, `${label}: no horizontal overflow`)
        ok(anchors.every((r) => r.left >= felt.left - 1 && r.right <= felt.right + 1 && r.top >= felt.top - 1 && r.bottom <= felt.bottom + 1), `${label}: every seat fits in felt`)
        for (let a = 0; a < anchors.length; a++) for (let b = a + 1; b < anchors.length; b++) {
          const x = anchors[a]!, y = anchors[b]!
          ok(!(Math.min(x.right, y.right) - Math.max(x.left, y.left) > 1 && Math.min(x.bottom, y.bottom) - Math.max(x.top, y.top) > 1), `${label}: seats ${a}/${b} do not overlap`)
        }
        const controls = Array.from(root.querySelectorAll<HTMLElement>('[data-svara-table-refresh],[data-svara-table-leave]'))
        const bubbles = Array.from(root.querySelectorAll<HTMLElement>('[data-svara-win-bubble]'))
        ok(bubbles.every((bubble) => {
          const r = bubble.getBoundingClientRect()
          return controls.every((control) => { const c = control.getBoundingClientRect(); return r.bottom <= c.top || r.top >= c.bottom || r.right <= c.left || r.left >= c.right })
        }), `${label}: win bubbles leave controls accessible`)
        const overlay = root.querySelector<HTMLElement>('[data-svara-result-overlay]')!
        ok(getComputedStyle(overlay).pointerEvents === 'none', `${label}: flights cannot intercept actions`)
        const pot = root.querySelector<HTMLElement>('[data-svara-active-pot]')?.getBoundingClientRect()
        if (pot) ok(anchors.every((r) => Math.min(r.right, pot.right) <= Math.max(r.left, pot.left) + 1 || Math.min(r.bottom, pot.bottom) <= Math.max(r.top, pot.top) + 1), `${label}: highlighted bank stays clear of player panels`)
      }
      try {
        send()
        await frame()
        const flips = Array.from(root.querySelectorAll<HTMLElement>('[data-svara-showdown-cards]'))
        ok(flips.length === 2 && flips.every((el) => el.dataset.svaraFlipProgress === '0.2500'), 'simultaneous local/all-in public flip')
        ok(root.querySelectorAll('[data-svara-showdown-points]').length === 2, 'only compared hands have server points')
        ok(root.querySelector('[data-svara-seat-index="3"] [data-svara-seat-cards-mount]')!.childElementCount === 0, 'folded player has no cards')
        const avatar = root.querySelector('[data-svara-avatar="0"]')
        const table = root.querySelector('[data-svara-table]')
        now = RESULT_START + 500
        await new Promise((done) => setTimeout(done, 300)) // also exercises the countdown interval
        ok(root.querySelector('[data-svara-avatar="0"]') === avatar && root.querySelector('[data-svara-table]') === table, 'animation frames and countdown preserve table/avatar DOM identity')
        layout('showdown')
        now = RESULT_START + 2999
        await frame()
        ok(root.querySelectorAll('[data-svara-showdown-cards]').length === 2, 'cards stay until absolute showdown deadline')
        now++
        await frame()
        ok(root.querySelectorAll('[data-svara-showdown-cards]').length === 0, 'expired showdown hides without waiting for another snapshot')
        setFixturePayout(input)
        now = RESULT_START + 3300
        send()
        await frame()
        ok(root.querySelectorAll('[data-svara-win-bubble]').length === 1 && root.querySelector('[data-svara-win-bubble]')!.textContent === 'Печеля 1250!', 'main pot exact winner bubble')
        ok(root.querySelector('[data-svara-seat-index="1"] [data-svara-win-bubble]'), 'main bank reaches bob')
        ok(root.querySelector('[data-svara-payout-flight="1"]'), 'chips fly to main recipient')
        layout('main payout')
        now = RESULT_START + 3940
        await frame()
        const flight = root.querySelector<HTMLElement>('[data-svara-payout-flight="1"]')!.getBoundingClientRect()
        const destination = root.querySelector<HTMLElement>('[data-svara-avatar="1"]')!.getBoundingClientRect()
        ok(Math.hypot(flight.left - (destination.left + destination.width / 2), flight.top - (destination.top + destination.height / 2)) < 2, 'chip flight lands at the measured avatar position')
        now = RESULT_START + 3960
        await frame()
        ok(!root.querySelector('[data-svara-payout-flight]') && root.querySelector('[data-svara-win-bubble]'), 'chips finish within their 1200ms window')
        controller.setSnapshot(input.snapshot)
        controller.setTiming(input.timing)
        await frame()
        ok(root.querySelectorAll('[data-svara-win-bubble]').length === 1, 'duplicate snapshot never duplicates a win')
        now = RESULT_START + 4800
        controller.destroy()
        controller = mount()
        send()
        await frame()
        const key = root.querySelector('[data-svara-active-pot]')!.getAttribute('data-svara-payout-key')
        ok(root.querySelectorAll('[data-svara-win-bubble]').length === 2 && !root.textContent!.includes('Печеля 1250!'), 'remount mid-payout skips completed main bank')
        ok(Array.from(root.querySelectorAll('[data-svara-win-bubble]')).every((el) => el.textContent === 'Печеля 200!'), 'split shows exact server shares')
        ok(root.querySelector('[data-svara-payout-flight="0"]') && root.querySelector('[data-svara-payout-flight="2"]'), 'split chips reach both recipients')
        layout('split payout')
        controller.destroy()
        controller = mount()
        send()
        await frame()
        ok(root.querySelector('[data-svara-active-pot]')!.getAttribute('data-svara-payout-key') === key, 'stable payout key across repeated remount')
        now = RESULT_START + 5400
        await frame()
        ok(!root.querySelector('[data-svara-win-bubble],[data-svara-payout-flight]'), 'payout ends at server deadline without a new packet')
        ok(commandCount === 0, 'presentation and destroy send no financial/game commands')
        for (const capacity of [2, 3, 4]) {
          const fixture = svaraResultFixture()
          fixture.table.capacity = capacity
          fixture.table.players = fixture.table.players.slice(0, capacity)
          fixture.snapshot.table.capacity = capacity
          fixture.snapshot.seats = fixture.snapshot.seats.slice(0, capacity)
          setFixturePayout(fixture)
          fixture.snapshot.round.svaraTie = true
          fixture.snapshot.lockedPots = [{ potId: 'locked', kind: 'allin', amount: 777, eligible: ['alice', 'bob'], isMain: true, continuation: 1 }]
          now = RESULT_START + 3300
          controller.setMyTable(fixture.table)
          controller.setSnapshot(fixture.snapshot)
          controller.setTiming(fixture.timing)
          await frame()
          ok(root.querySelector('[data-svara-tie]')?.textContent === 'СВАРА!', `${capacity} seats: tie banner and normal payout coexist`)
          layout(`${capacity} seats, tie`)
        }
        // Exercise the original concrete flash truncation: look triggers 33ms
        // full renders while a confirmed bet's 900ms WAAPI animation runs.
        const betting = svaraResultFixture()
        betting.snapshot.round = {
          kind: 'ordinary', roundId: 'bet-flash-test', dealerId: 'alice', potId: null,
          participants: ['alice', 'bob', 'carol', 'dave'], currentBet: 0,
          blind: { status: 'available', lastBlindTotal: 0 }, carriedIn: 0, potTotal: 40,
          provisionalPots: [], isFourthHeadsUp: false, noBetAllowed: false, actions: [], dealing: false,
        }
        betting.snapshot.you.looked = false
        betting.timing.deadlines = [{ kind: 'turn', deadlineAt: now + 15000, remainingMs: 15000, playerId: 'alice' }]
        controller.setMyTable(betting.table)
        controller.setSnapshot(betting.snapshot)
        controller.setTiming(betting.timing)
        betting.snapshot.you.looked = true
        betting.snapshot.you.cards = ['AC', 'AH', 'AS']
        betting.snapshot.round.actions.push({ playerId: 'alice', kind: 'bet', total: 10, added: 10, allIn: false, blind: false })
        controller.setSnapshot(betting.snapshot)
        const flash = root.querySelector<HTMLElement>('[data-svara-bet-flash]')
        ok(flash, 'confirmed bet creates a flash during look animation')
        await new Promise((done) => setTimeout(done, 200))
        ok(root.querySelector('[data-svara-bet-flash]') === flash && flash!.getAnimations().some((animation) => animation.playState === 'running'), 'full look/countdown renders preserve the same running bet flash')
        await new Promise((done) => setTimeout(done, 800))
        ok(!root.querySelector('[data-svara-bet-flash]'), 'preserved bet flash completes and cleans up normally')
        return checks
      } finally { controller.destroy(); Date.now = originalNow; sharedServerClock.reset() }
    })
    await page.reload()
    await page.evaluate(async () => {
      const controllerPath = '/src/app/games/svara/createSvaraLobbyController.ts'
      const fixturePath = '/scripts/fixtures/svaraResultFixtures.ts'
      const clockPath = '/src/app/network/serverClock.ts'
      const { createSvaraLobbyController } = await import(controllerPath)
      const { svaraResultFixture, setFixturePayout, RESULT_START } = await import(fixturePath)
      const { sharedServerClock } = await import(clockPath)
      const input = svaraResultFixture()
      setFixturePayout(input)
      sharedServerClock.recordServerNowSample(RESULT_START + 4800)
      const root = document.querySelector<HTMLElement>('#root')!
      const controller = createSvaraLobbyController({ root, localProfileId: 'alice', onRefresh() {}, onCreate() {}, onJoin() {}, onLeave() {}, onStart() {}, onRequestTableState() {}, onSubmitCommand() { throw new Error('refresh submitted a command') } })
      try {
        controller.setMyTable(input.table)
        controller.setSnapshot(input.snapshot)
        controller.setTiming(input.timing)
        await new Promise<void>((done) => requestAnimationFrame(() => done()))
        if (root.querySelectorAll('[data-svara-win-bubble]').length !== 2 || root.textContent!.includes('Печеля 1250!')) throw new Error('refresh replayed completed payout')
        const expected = JSON.stringify(['result-test', 'showdown-7', 'side:payout'])
        if (root.querySelector('[data-svara-active-pot]')?.getAttribute('data-svara-payout-key') !== expected) throw new Error('refresh lost stable step identity')
      } finally { controller.destroy(); sharedServerClock.reset() }
    })
    checks.push('actual page refresh seeks to the active step with stable identity and no game command')
    // A screenshot of the production renderer at a deterministic presentation
    // instant, separately from the lifecycle assertions above.
    await page.evaluate(async () => {
      const rendererPath = '/src/app/games/svara/table/renderSvaraActiveTable.ts'
      const fixturePath = '/scripts/fixtures/svaraResultFixtures.ts'
      const { renderSvaraActiveTable } = await import(rendererPath)
      const { svaraResultFixture, setFixturePayout, RESULT_START } = await import(fixturePath)
      const input = svaraResultFixture()
      setFixturePayout(input)
      input.serverNow = RESULT_START + 4500
      document.querySelector('#root')!.innerHTML = renderSvaraActiveTable(input)
    })
    await page.screenshot({ path: resolve(outDir, `${width}x${height}.png`), fullPage: true })
    report.push({ viewport: `${width}x${height}`, checks })
    console.log(`  ok ${width}x${height}: ${checks.length} Chromium component assertions`)
    await page.close()
  }
  const page = await browser.newPage({ viewport: { width: 320, height: 568 }, reducedMotion: 'reduce' })
  await page.addInitScript('globalThis.__name = (target) => target')
  await page.goto(`http://127.0.0.1:${address.port}/__svara_result_qa`)
  await page.evaluate(async () => {
    const controllerPath = '/src/app/games/svara/createSvaraLobbyController.ts'
    const fixturePath = '/scripts/fixtures/svaraResultFixtures.ts'
    const clockPath = '/src/app/network/serverClock.ts'
    const { createSvaraLobbyController } = await import(controllerPath)
    const { svaraResultFixture, setFixturePayout, RESULT_START } = await import(fixturePath)
    const { sharedServerClock } = await import(clockPath)
    const input = svaraResultFixture()
    setFixturePayout(input)
    sharedServerClock.recordServerNowSample(RESULT_START + 3300)
    const root = document.querySelector<HTMLElement>('#root')!
    const controller = createSvaraLobbyController({ root, localProfileId: 'alice', onRefresh() {}, onCreate() {}, onJoin() {}, onLeave() {}, onStart() {}, onRequestTableState() {}, onSubmitCommand() {} })
    controller.setMyTable(input.table)
    controller.setSnapshot(input.snapshot)
    controller.setTiming(input.timing)
    await new Promise<void>((done) => requestAnimationFrame(() => done()))
    if (!root.textContent!.includes('Печеля 1250!') || root.querySelector('[data-svara-payout-flight]')) throw new Error('Reduced motion must retain award and suppress flight')
    controller.destroy()
    sharedServerClock.reset()
  })
  console.log('  ok real prefers-reduced-motion media query')
  assert.deepEqual(errors, [], 'no uncaught Chromium errors')
  await writeFile(resolve(outDir, 'report.json'), JSON.stringify({ kind: 'Chromium component fixtures; not auth/WS integration', report, errors }, null, 2))
  console.log(`Screenshots and report: ${outDir}`)
} catch (error) {
  const page = browser.contexts().flatMap((context) => context.pages()).at(-1)
  if (page) await page.screenshot({ path: resolve(outDir, 'failure.png'), fullPage: true })
  throw error
} finally {
  await browser.close()
  await vite.close()
}
