/**
 * Свара — отпаднал играч остава черно-бял до края на мача (реален Chromium,
 * истинската сцена/контролер, истински сървърни snapshot-и от engine/runtime;
 * без WebSocket — snapshot-ите се подават на контролера както от лобито).
 *
 *  [1] All-in с 0 свободни чипа преди края на раздаването → никой не е затъмнен.
 *  [2] Окончателно отпадане → картата е черно-бяла, останалите — нормални.
 *  [3] Следващо раздаване → остава черно-бяла.
 *  [4] Отпадналият излиза (сървърът го води 'exited') и следващо раздаване → остава.
 *  [5] Reconnect/refresh (нов контролер: списък + последен snapshot) → остава;
 *      същото, когато отпадналият е локалният играч (до собствения му изход —
 *      след него сървърът вече не му праща snapshot-и, а svara_table_left).
 *  [6] Нов мач в същия изглед → определя се от новия мач, без стария ефект.
 *
 * Пускане: npx tsx scripts/checkSvaraEliminatedSeatDimBrowser.ts
 */
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import { chromium } from 'playwright'
import { generateSvaraEliminationSnapshots, generateSvaraFreshMatchStep } from './fixtures/svaraEliminationSnapshots'

const vite = await createServer({
  configFile: false, root: resolve('.'), logLevel: 'error',
  optimizeDeps: { noDiscovery: true, entries: [] },
  server: { host: '127.0.0.1', port: 0, strictPort: false },
  plugins: [{
    name: 'svara-eliminated-dim-qa',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url !== '/__svara_eliminated_qa') return next()
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
let total = 0
try {
  for (const [viewer, width] of [['alice', 390], ['carol', 390], ['alice', 1280]] as const) {
    const sequence = generateSvaraEliminationSnapshots(viewer, 1)
    assert.equal(sequence.eliminated, 'carol')
    const fresh = generateSvaraFreshMatchStep(viewer, 'new-match-2')
    const page = await browser.newPage({ viewport: { width, height: 844 } })
    await page.addInitScript('globalThis.__name = (target) => target') // tsx keepNames helper inside evaluate
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${address.port}/__svara_eliminated_qa`)
    const checks = await page.evaluate(async ({ viewer, sequence, fresh }) => {
      const { createSvaraLobbyController } = await import('/src/app/games/svara/createSvaraLobbyController.ts' as string)
      const root = document.querySelector<HTMLElement>('#root')!
      const frame = () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())))
      const checks: string[] = []
      const ok = (condition: unknown, label: string) => { if (!condition) throw new Error(label); checks.push(label) }
      const players = ['alice', 'bob', 'carol', 'dave']
      const mount = () => createSvaraLobbyController({ root, localProfileId: viewer, onRefresh() {}, onCreate() {}, onJoin() {}, onLeave() {}, onStart() {}, onRequestTableState() {}, onSubmitCommand() {} })
      /** Черно-бял ли е видимият профил на играча (изчисленият филтър на карето). */
      const gray = (playerId: string) => {
        const node = root.querySelector<HTMLElement>(`[data-svara-scene-profile="${playerId}"]`)
        const card = node?.querySelector<HTMLElement>('[data-svara-seat-card]')
        if (!node || !card) throw new Error(`${playerId}: no seat card`)
        return { grayscale: /grayscale\(1\)/.test(getComputedStyle(card).filter), dim: node.dataset.svaraSeatDim ?? null }
      }
      const expectOnlyCarolGray = (label: string) => {
        const carol = gray('carol')
        ok(carol.grayscale && carol.dim === 'eliminated', `${label}: carol stays black-and-white`)
        ok(players.filter((p) => p !== 'carol').every((p) => !gray(p).grayscale && gray(p).dim === null), `${label}: active players look normal`)
      }
      const step = (label: string) => sequence.steps.find((s: any) => s.label === label)!
      let controller = mount()
      const show = async (s: any) => { controller.setMyTable(s.table); controller.setSnapshot(s.snapshot); await frame() }

      // [1] All-in с 0 свободни чипа — раздаването не е приключило.
      for (const label of ['all-in-bob', 'all-in-carol', 'showdown-showdown', 'showdown-payout']) {
        const s = step(label)
        await show(s)
        const zero = s.snapshot.seats.filter((seat: any) => seat.stack === 0).map((seat: any) => seat.playerId)
        ok(players.every((p) => !gray(p).grayscale), `${label}: nobody dimmed (0 free chips: ${zero.join(',') || 'none'}, status active)`)
      }
      // [2]–[4]
      const localEliminated = viewer === 'carol'
      const afterElimination = ['eliminated', 'next-round-dealing', 'next-round-betting']
      if (!localEliminated) afterElimination.push('eliminated-exited', 'after-exit-next-round-dealing', 'after-exit-next-round-betting')
      for (const label of afterElimination) {
        await show(step(label))
        expectOnlyCarolGray(label)
      }
      if (!localEliminated) ok(step('eliminated-exited').snapshot.seats.find((seat: any) => seat.playerId === 'carol').status === 'exited', 'server marks the eliminated player exited after Изход')
      // [5] Reconnect/refresh: нов контролер (списъкът идва първи, после snapshot-ът).
      const last = step(afterElimination.at(-1)!)
      controller.destroy()
      controller = mount()
      controller.setTables([last.table])
      controller.setSnapshot(last.snapshot)
      await frame()
      expectOnlyCarolGray('after refresh')
      // [6] Нов мач в същия изглед.
      await show(fresh)
      ok(fresh.snapshot.seats.every((seat: any) => seat.status === 'active'), 'new match: every player active on the server')
      ok(players.every((p) => !gray(p).grayscale && gray(p).dim === null), 'new match: no stale black-and-white card')
      controller.destroy()
      return checks
    }, { viewer, sequence, fresh })
    assert.deepEqual(errors, [], `page errors: ${errors.join('; ')}`)
    total += checks.length
    console.log(`  ✓ viewer=${viewer} ${width}px — ${checks.length} checks`)
    await page.close()
  }
  console.log(`\nSvara eliminated seat dim (browser): ${total} checks passed`)
} finally {
  await browser.close()
  await vite.close()
}
