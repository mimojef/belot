import { createServer as createNetServer } from 'node:net'
import { chromium, type Page } from 'playwright'
import { createServer as createViteServer } from 'vite'
import { createLudoAuthoritativeInitialState } from '../server/src/game/ludoEngine/ludoEngineState.js'
import { reduceLudoGame } from '../server/src/game/ludoEngine/ludoEngineReducer.js'

const assert = (condition: unknown, message: string): asserts condition => { if (!condition) throw new Error(message) }
const freePort = () => new Promise<number>((resolve, reject) => {
  const server = createNetServer().once('error', reject).listen(0, '127.0.0.1', () => {
    const address = server.address()
    if (!address || typeof address === 'string') return reject(new Error('No free port'))
    server.close(() => resolve(address.port))
  })
})

const initial = createLudoAuthoritativeInitialState(['red', 'blue'])
const started = reduceLudoGame(initial, { type: 'ROLL_STARTED', color: 'red', expectedTurnVersion: 0 })
const rolled = reduceLudoGame(started.state, { type: 'ROLL_RESOLVED', color: 'red', expectedTurnVersion: 1, value: 6 })
const base = {
  matchId: 'match-1', ludoRoomId: 'room-1', stake: 100,
  serverNow: Date.now(), deadlineAt: Date.now() + 10_000,
  players: [
    { profileId: 'p-red', displayName: 'Red', avatarUrl: null, color: 'red' },
    { profileId: 'p-blue', displayName: 'Blue', avatarUrl: null, color: 'blue' },
  ],
  winnerProfileId: null,
}
const normalRoll = { ...base, revision: 1, state: rolled.state, events: rolled.events, botControlledColors: [] }
const takeover = { ...base, revision: 1, state: initial, events: [{ type: 'bot_takeover_started', color: 'red' }], botControlledColors: ['red'] }
const reclaimed = { ...base, revision: 2, state: initial, events: [{ type: 'human_control_resumed', color: 'red' }], botControlledColors: [] }
const reclaimedRoll = { ...base, revision: 3, state: rolled.state, events: rolled.events, botControlledColors: [] }

const port = await freePort()
const vite = await createViteServer({ server: { host: '127.0.0.1', port, strictPort: true }, logLevel: 'error' })
const browser = await chromium.launch({ headless: true })
try {
  await vite.listen()
  async function open(color: 'red' | 'blue', viewport: { width: number; height: number }): Promise<Page> {
    const page = await browser.newPage({ viewport })
    await page.goto(`http://127.0.0.1:${port}/scripts/fixtures/ludoAuthoritativeHarness.html?color=${color}`)
    await page.waitForFunction(() => Boolean((window as any).__ludoAuthHarness))
    return page
  }
  const apply = (page: Page, snapshot: unknown) => page.evaluate((value) => (window as any).__ludoAuthHarness.apply(value), snapshot)
  const flightVisible = (page: Page) => page.evaluate(() => (window as any).__ludoAuthHarness.diceFlightVisible())
  const applyAndWaitForFlight = async (page: Page, snapshot: unknown): Promise<void> => {
    const previous = await page.$('[data-ludo-dice-flight="1"]')
    await apply(page, snapshot)
    if (previous) {
      await page.waitForFunction((node) => document.querySelector('[data-ludo-dice-flight="1"]') !== node, previous)
      await previous.dispose()
    } else {
      await page.locator('[data-ludo-dice-flight="1"]').waitFor({ state: 'attached' })
    }
  }

  const normal = await open('red', { width: 1280, height: 850 })
  await applyAndWaitForFlight(normal, normalRoll)
  assert(await flightVisible(normal), 'normal human roll flight is not visible')

  const botViewer = await open('blue', { width: 390, height: 844 })
  await apply(botViewer, takeover)
  await applyAndWaitForFlight(botViewer, { ...normalRoll, revision: 2, botControlledColors: ['red'] })
  assert(await flightVisible(botViewer), 'bot-controlled roll flight is not visible to opponent')

  for (const viewport of [{ width: 1280, height: 850 }, { width: 390, height: 844 }]) {
    const reclaimedPlayer = await open('red', viewport)
    await apply(reclaimedPlayer, takeover)
    await reclaimedPlayer.locator('[data-ludo-bot-takeover-dismiss="1"]').click()
    const reclaimCalls = await reclaimedPlayer.evaluate(() => (window as any).__ludoAuthHarness.calls().filter((call: any[]) => call[0] === 'reclaim'))
    assert(reclaimCalls.length === 1, `reclaim request count is ${reclaimCalls.length}`)
    await apply(reclaimedPlayer, reclaimed)
    for (let revision = 3; revision <= 5; revision++) {
      await applyAndWaitForFlight(reclaimedPlayer, { ...reclaimedRoll, revision })
      assert(await flightVisible(reclaimedPlayer), `reclaimed human roll ${revision - 2} is not visible at ${viewport.width}px`)
      await reclaimedPlayer.waitForTimeout(1_050)
    }
    assert(await reclaimedPlayer.locator('[data-ludo-bot-takeover-backdrop="1"]').count() === 0, 'reclaim popup remained mounted')
    await reclaimedPlayer.close()
  }
  console.log('PASS Ludo roll presentation: normal human, bot-controlled, and three post-reclaim human flights on desktop/mobile')
} finally {
  await browser.close()
  await vite.close()
}
