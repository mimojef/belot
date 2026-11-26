// Свара — индикатор „Вход X — MM:SS“ и анимацията „Вход X“ (Chromium, реалният
// контролер, snapshot fixture и контролиран сървърен часовник; без backend).
//   • текст и обновяване всяка секунда по сървърния срок; изтекъл срок → 00:00;
//   • горният ляв ъгъл на сукното, без припокриване с места, карти, бутони;
//   • анимация само при действителна, току-що приложена промяна;
//     без анимация при първо виждане (зареждане/remount) и при стара промяна (reconnect);
//   • мобилен (360, 390) и десктоп (1280) изглед.
// Пускане: npx tsx scripts/checkSvaraAnteIndicatorBrowser.ts [--screenshots=DIR]
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import { chromium } from 'playwright'

const shots = process.argv.find((a) => a.startsWith('--screenshots='))?.slice('--screenshots='.length) ?? null
const vite = await createServer({
  configFile: false, root: resolve('.'), logLevel: 'error',
  optimizeDeps: { noDiscovery: true, entries: [] },
  server: { host: '127.0.0.1', port: 0, strictPort: false },
  plugins: [{
    name: 'svara-ante-qa-page',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url !== '/__svara_ante_qa') return next()
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
let failed = 0
try {
  for (const [width, height] of [[360, 740], [390, 844], [1280, 900]] as const) {
    const page = await browser.newPage({ viewport: { width, height } })
    await page.addInitScript('globalThis.__name = (target) => target')
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${address.port}/__svara_ante_qa`)
    const result = await page.evaluate(async () => {
      const { createSvaraLobbyController } = await import('/src/app/games/svara/createSvaraLobbyController.ts' as string)
      const { svaraResultFixture, RESULT_START } = await import('/scripts/fixtures/svaraResultFixtures.ts' as string)
      const { sharedServerClock } = await import('/src/app/network/serverClock.ts' as string)
      const root = document.querySelector<HTMLElement>('#root')!
      let now = RESULT_START
      Date.now = () => now
      sharedServerClock.reset()
      const checks: string[] = []
      const ok = (condition: unknown, label: string) => { if (!condition) throw new Error(label); checks.push(label) }
      const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))
      const frame = () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())))
      const mount = () => createSvaraLobbyController({ root, localProfileId: 'alice', onRefresh() {}, onCreate() {}, onJoin() {}, onLeave() {}, onStart() {}, onRequestTableState() {}, onSubmitCommand() {} })
      const base = svaraResultFixture()
      let revision = 30
      const snap = (entryChips: number, ante: { nextIncreaseAt: number | null; changedAt: number | null }) => ({
        ...base.snapshot, revision: ++revision, round: null,
        seats: base.snapshot.seats.map((s: any) => ({ ...s, inRound: false, folded: false, allIn: false, cardCount: 0, roundContribution: 0 })),
        table: { ...base.snapshot.table, entryChips, ante },
      })
      const send = (controller: any, snapshot: any) => {
        controller.setMyTable(base.table)
        controller.setTiming({ ...base.timing, revision: snapshot.revision, serverNow: now, deadlines: [] })
        controller.setSnapshot(snapshot)
      }
      const text = () => root.querySelector('[data-svara-ante-indicator]')?.textContent?.replace(/\s+/g, ' ').trim() ?? null
      const flash = () => root.querySelector<HTMLElement>('[data-svara-ante-flash]')
      const rect = (el: Element) => el.getBoundingClientRect()
      const intersects = (a: DOMRect, b: DOMRect) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5

      let controller = mount()
      send(controller, snap(10, { nextIncreaseAt: RESULT_START + 337_000, changedAt: null }))
      await frame()
      ok(text() === 'Вход 10 — 05:37', `индикатор „Вход 10 — 05:37“ (${text()})`)
      ok(flash() === null, 'първо виждане: без анимация')
      now += 1000
      await wait(700)
      ok(text() === 'Вход 10 — 05:36', `броячът се обновява всяка секунда без нов snapshot (${text()})`)

      // Позиция: горният ляв ъгъл на сукното, без припокриване.
      const indicator = root.querySelector('[data-svara-ante-indicator]')!
      const felt = rect(root.querySelector('[data-svara-felt]')!)
      const ir = rect(indicator)
      ok(ir.left >= felt.left && ir.top >= felt.top && ir.left - felt.left < 20 && ir.top - felt.top < 20 && ir.right <= felt.left + felt.width / 2, 'горният ляв ъгъл на сукното')
      const others = [...root.querySelectorAll('[data-svara-scene-seat], [data-svara-seat-anchor], [data-svara-sprite-kind], [data-svara-action-bar] button, [data-svara-top-bar] button')]
        .filter((el) => { const r = rect(el); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' && Number(getComputedStyle(el).opacity) > 0.05 })
      const hit = others.filter((el) => intersects(ir, rect(el))).map((el) => el.outerHTML.slice(0, 80))
      ok(hit.length === 0, `без припокриване с места, карти, чипове и бутони (${hit.join(' | ')})`)
      ok(getComputedStyle(indicator).pointerEvents === 'none', 'индикаторът не блокира кликове')
      // Същото и с карти и чипове на масата (сравняване: 6 открити карти, залози).
      controller.setSnapshot({ ...base.snapshot, revision: ++revision, table: { ...base.snapshot.table, ante: { nextIncreaseAt: now + 300_000, changedAt: null } } })
      controller.setTiming({ ...base.timing, revision, serverNow: now, deadlines: [{ kind: 'showdown-display', deadlineAt: now + 3000, remainingMs: 3000, playerId: null }] })
      await wait(1200)
      const cards = [...root.querySelectorAll('[data-svara-sprite-kind]')].filter((el) => Number(getComputedStyle(el).opacity) > 0.05 && rect(el).width > 0)
      const cardHit = cards.filter((el) => intersects(rect(root.querySelector('[data-svara-ante-indicator]')!), rect(el)))
      ok(cards.length > 0 && cardHit.length === 0, `с карти/чипове на масата: без припокриване (${cards.length} спрайта, ${cardHit.length} засечени)`)
      ok(document.documentElement.scrollWidth <= window.innerWidth + 1, 'без хоризонтален скрол')

      // Действителна промяна → „Вход 20“ в центъра, ~2 s, без затъмняване/блокиране.
      send(controller, snap(20, { nextIncreaseAt: now + 600_000, changedAt: now }))
      await frame()
      const f = flash()
      ok(f !== null && f.textContent === 'Вход 20', 'нов вход → „Вход 20“')
      const fr = rect(f!)
      ok(Math.abs((fr.left + fr.right) / 2 - (felt.left + felt.right) / 2) < 3 && Math.abs((fr.top + fr.bottom) / 2 - (felt.top + felt.bottom) / 2) < 3, 'в центъра на сукното')
      ok(getComputedStyle(f!).pointerEvents === 'none' && f!.getAnimations().length === 1, 'не блокира действия; една анимация')
      const timingInfo = f!.getAnimations()[0]!.effect!.getTiming()
      ok(timingInfo.duration === 2000, 'продължителност 2 s')
      ok(text() === 'Вход 20 — 10:00', `индикаторът показва новия вход и пълния интервал (${text()})`)
      await wait(2300)
      ok(flash() === null, 'анимацията изчезва')

      // Повторен snapshot със същата промяна → няма втора анимация.
      send(controller, snap(20, { nextIncreaseAt: now + 600_000, changedAt: now }))
      await frame()
      ok(flash() === null, 'същата промяна не се анимира повторно')

      // Reconnect: промяната е настъпила преди 10 s → без анимация, но с новия вход.
      now += 10_000
      send(controller, snap(40, { nextIncreaseAt: now + 590_000, changedAt: now - 10_000 }))
      await frame()
      ok(flash() === null && text()?.startsWith('Вход 40') === true, 'стара промяна (reconnect) → без анимация, правилен вход')

      // Remount/презареждане с току-що приложена промяна → само база.
      controller.destroy()
      controller = mount()
      send(controller, snap(80, { nextIncreaseAt: now + 600_000, changedAt: now }))
      await frame()
      ok(flash() === null && text() === 'Вход 80 — 10:00', 'презареждане/remount → без анимация')

      // Изтекъл срок по време на раздаване → 00:00 (никога отрицателно) до следващата граница.
      send(controller, snap(80, { nextIncreaseAt: now - 5_000, changedAt: now - 600_000 }))
      await frame()
      ok(text() === 'Вход 80 — 00:00', `изтекъл срок → 00:00 (${text()})`)

      // Само в игра: lobby/finished → без индикатор.
      send(controller, { ...snap(80, { nextIncreaseAt: null, changedAt: null }), phase: 'finished' })
      await frame()
      ok(root.querySelector('[data-svara-ante-indicator]') === null, 'извън игра — без индикатор')
      send(controller, snap(80, { nextIncreaseAt: now + 300_000, changedAt: now - 1000 }))
      await frame()
      send(controller, snap(160, { nextIncreaseAt: now + 600_000, changedAt: now }))
      await frame()
      return { checks, flashShown: flash() !== null }
    })
    if (shots) {
      await page.locator('[data-svara-felt]').screenshot({ path: `${shots}/svara-ante-${width}.png` })
    }
    const label = `${width}×${height}`
    if (errors.length) { failed++; console.error(`  FAIL ${label}: ${errors.join('; ')}`) }
    else { for (const c of result.checks) console.log(`  PASS ${label}: ${c}`) }
    await page.close()
  }
} catch (error) {
  failed++
  console.error(`  FAIL ${error instanceof Error ? error.message : String(error)}`)
} finally {
  await browser.close()
  await vite.close()
}
console.log(failed ? `\nFAILED (${failed})` : '\nOK')
process.exit(failed ? 1 : 0)
