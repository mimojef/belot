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

const baseState = createLudoAuthoritativeInitialState(['red', 'blue'])
const baseSnapshot = {
  matchId: 'match-1', ludoRoomId: 'room-1', stake: 100,
  players: [
    { profileId: 'p-red', displayName: 'Red', avatarUrl: null, color: 'red' as const },
    { profileId: 'p-blue', displayName: 'Blue', avatarUrl: null, color: 'blue' as const },
  ],
  winnerProfileId: null,
}
const snapshot = (revision: number, state: typeof baseState, events: readonly any[], botControlledColors: readonly ('red' | 'blue')[] = []) => ({
  ...baseSnapshot,
  revision,
  serverNow: Date.now(),
  deadlineAt: Date.now() + 8_000,
  state,
  events,
  botControlledColors,
})
const stateAt = (trackIndex: number, turnVersion: number) => ({
  ...baseState,
  activeColor: 'blue' as const,
  turnPhase: 'waiting_for_roll' as const,
  turnVersion,
  pieces: baseState.pieces.map((piece) => piece.color === 'red' && piece.slot === 0
    ? { ...piece, position: { kind: 'track' as const, trackIndex } }
    : piece),
})
const rolledStart = reduceLudoGame(baseState, { type: 'ROLL_STARTED', color: 'red', expectedTurnVersion: 0 })
const rolled = reduceLudoGame(rolledStart.state, { type: 'ROLL_RESOLVED', color: 'red', expectedTurnVersion: 1, value: 6 })

const port = await freePort()
const vite = await createViteServer({ server: { host: '127.0.0.1', port, strictPort: true }, logLevel: 'error' })
const browser = await chromium.launch({ headless: true })
try {
  await vite.listen()
  async function open(viewport: { width: number; height: number }): Promise<Page> {
    const page = await browser.newPage({ viewport })
    await page.goto(`http://127.0.0.1:${port}/scripts/fixtures/ludoAuthoritativeHarness.html?color=red`)
    await page.waitForFunction(() => Boolean((window as any).__ludoAuthHarness))
    return page
  }
  const apply = (page: Page, value: unknown) => page.evaluate((incoming) => (window as any).__ludoAuthHarness.apply(incoming), value)
  const setVisibility = (page: Page, value: 'hidden' | 'visible') => page.evaluate((state) => (window as any).__ludoAuthHarness.setVisibility(state), value)
  const overlays = (page: Page) => page.evaluate(() => (window as any).__ludoAuthHarness.overlays())

  const desktop = await open({ width: 1280, height: 850 })
  await setVisibility(desktop, 'hidden')
  for (let revision = 1; revision <= 12; revision += 1) {
    await apply(desktop, snapshot(revision, stateAt(revision, revision), revision % 2 === 0
      ? [{ type: 'piece_moved', color: 'red', slot: 0, fromPosition: { kind: 'track', trackIndex: revision - 1 }, toPosition: { kind: 'track', trackIndex: revision } }]
      : [{ type: 'dice_accepted', color: 'red', value: 3 }], ['red']))
  }
  assert(JSON.stringify(await overlays(desktop)) === JSON.stringify({ dice: 0, moving: 0, capture: 0 }), 'hidden 12-revision catch-up created gameplay overlays')
  await setVisibility(desktop, 'visible')
  await apply(desktop, snapshot(12, stateAt(12, 12), [], ['red']))
  assert(await desktop.evaluate(() => (window as any).__ludoAuthHarness.botPopup()), 'latest bot ownership was not rendered after catch-up')
  const countdown = await desktop.evaluate(() => (window as any).__ludoAuthHarness.activeCountdown())
  assert(countdown?.color === 'blue', `latest active color/timer is wrong: ${JSON.stringify(countdown)}`)
  await desktop.locator('[data-ludo-bot-takeover-dismiss="1"]').click()
  const reclaimCalls = await desktop.evaluate(() => (window as any).__ludoAuthHarness.calls().filter((call: any[]) => call[0] === 'reclaim'))
  assert(reclaimCalls.length === 1 && reclaimCalls[0][2] === 12, `reclaim did not use latest revision: ${JSON.stringify(reclaimCalls)}`)

  await apply(desktop, snapshot(13, stateAt(12, 13), [{ type: 'human_control_resumed', color: 'red' }], []))
  await apply(desktop, snapshot(14, rolled.state, rolled.events, []))
  await desktop.locator('[data-ludo-dice-flight="1"]').waitFor({ state: 'attached', timeout: 5_000 })
  await desktop.waitForTimeout(1_050)
  const movedState = {
    ...stateAt(12, 15),
    pieces: stateAt(12, 15).pieces.map((piece) => piece.color === 'blue' && piece.slot === 0
      ? { ...piece, position: { kind: 'track' as const, trackIndex: 14 } }
      : piece),
  }
  await apply(desktop, snapshot(15, movedState, [{
    type: 'piece_moved', color: 'blue', slot: 0,
    fromPosition: { kind: 'home', slot: 0 }, toPosition: { kind: 'track', trackIndex: 14 },
  }], []))
  await desktop.locator('[data-ludo-moving-piece="blue-0"]').waitFor({ state: 'attached', timeout: 5_000 })
  await desktop.close()

  const mobile = await open({ width: 390, height: 844 })
  await setVisibility(mobile, 'hidden')
  await apply(mobile, snapshot(1, stateAt(1, 1), [{ type: 'dice_accepted', color: 'red', value: 2 }], ['red']))
  await apply(mobile, snapshot(2, stateAt(2, 2), [{ type: 'piece_moved', color: 'red', slot: 0, fromPosition: { kind: 'track', trackIndex: 1 }, toPosition: { kind: 'track', trackIndex: 2 } }], ['red']))
  await setVisibility(mobile, 'visible')
  await apply(mobile, snapshot(2, stateAt(2, 2), [], ['red']))
  assert(JSON.stringify(await overlays(mobile)) === JSON.stringify({ dice: 0, moving: 0, capture: 0 }), 'small hidden gap replayed historical overlays')
  await mobile.close()

  const interrupted = await open({ width: 390, height: 844 })
  await apply(interrupted, snapshot(1, rolled.state, rolled.events, []))
  await interrupted.locator('[data-ludo-dice-flight="1"]').waitFor({ state: 'attached', timeout: 5_000 })
  await setVisibility(interrupted, 'hidden')
  await apply(interrupted, snapshot(10, stateAt(10, 10), [], ['red']))
  assert((await overlays(interrupted)).dice === 0, 'in-flight stale dice was not flushed on hide')
  await interrupted.waitForTimeout(1_100)
  assert(JSON.stringify(await overlays(interrupted)) === JSON.stringify({ dice: 0, moving: 0, capture: 0 }), 'stale presentation mutated DOM after latest snap')
  await interrupted.close()

  console.log('PASS Ludo hidden catch-up: 2/12 revision gaps snap without replay; stale flight flushes; post-reclaim roll and move animate normally')
} finally {
  await browser.close()
  await vite.close()
}
