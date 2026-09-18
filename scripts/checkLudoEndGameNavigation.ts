import { createServer as createNetServer } from 'node:net'
import { chromium, type Page } from 'playwright'
import { createServer as createViteServer } from 'vite'
import { createLudoAuthoritativeInitialState } from '../server/src/game/ludoEngine/ludoEngineState.js'

const assert = (condition: unknown, message: string): asserts condition => { if (!condition) throw new Error(message) }
const freePort = () => new Promise<number>((resolve, reject) => {
  const server = createNetServer().once('error', reject).listen(0, '127.0.0.1', () => {
    const address = server.address()
    if (!address || typeof address === 'string') return reject(new Error('No free port'))
    server.close(() => resolve(address.port))
  })
})

const initial = createLudoAuthoritativeInitialState(['red', 'blue'])
const players = [
  { profileId: 'p-red', displayName: 'Red', avatarUrl: null, color: 'red' },
  { profileId: 'p-blue', displayName: 'Blue', avatarUrl: null, color: 'blue' },
]
const base = {
  matchId: 'end-match', ludoRoomId: 'end-room', stake: 100, players,
  serverNow: Date.now(), deadlineAt: Date.now() + 10_000,
  botControlledColors: [], winnerProfileId: null, events: [],
}
const started = { ...base, revision: 0, state: initial }
const finished = (winnerColor: 'red' | 'blue', revision: number) => ({
  ...base, revision, deadlineAt: null,
  state: { ...initial, status: 'finished', winnerColor, turnPhase: 'turn_complete', legalMoves: [], diceValue: null },
  winnerProfileId: winnerColor === 'red' ? 'p-red' : 'p-blue',
})

const port = await freePort()
const vite = await createViteServer({ server: { host: '127.0.0.1', port, strictPort: true }, logLevel: 'error' })
const browser = await chromium.launch({ headless: true })
try {
  await vite.listen()
  async function scenario(profileId: 'p-red' | 'p-blue', winnerColor: 'red' | 'blue', viewport: { width: number; height: number }, label: string): Promise<void> {
    const page = await browser.newPage({ viewport })
    await page.goto(`http://127.0.0.1:${port}/scripts/fixtures/privateRoomRealWsHarness.html`)
    await page.waitForFunction(() => Boolean((window as any).__diagHarness))
    await page.evaluate(({ profileId, started }) => {
      history.replaceState({}, '', '/games/ludo')
      const harness = (window as any).__diagHarness
      harness.setLocalProfile(profileId, profileId)
      harness.handleServerMessage({ type: 'ludo_game_started', snapshot: started })
    }, { profileId, started })
    await page.locator('[data-ludo-overlay-root="1"]').waitFor({ state: 'attached' })
    await page.evaluate((snapshot) => (window as any).__diagHarness.handleServerMessage({ type: 'ludo_game_state', snapshot }), finished(winnerColor, 1))
    await page.locator('[data-ludo-game-end-dismiss="1"]').waitFor({ state: 'visible' })
    const expected = profileId === (winnerColor === 'red' ? 'p-red' : 'p-blue') ? 'Вие сте победител в играта!' : 'Вие загубихте играта.'
    assert((await page.locator('[data-ludo-game-end-backdrop="1"]').textContent())?.includes(expected), `${label}: wrong popup`)
    await page.locator('[data-ludo-game-end-dismiss="1"]').click()
    const sent = await page.evaluate(() => (window as any).__diagHarness.getSentFrames().filter((frame: any) => frame.type === 'leave_ludo_match'))
    assert(sent.length === 1 && sent[0].matchId === 'end-match', `${label}: finished acknowledgement was not sent once`)
    assert(await page.locator('[data-ludo-overlay-root="1"]').count() === 0, `${label}: overlay remained after OK`)
    assert(new URL(page.url()).pathname === '/games', `${label}: route did not change immediately`)
    await page.evaluate((snapshot) => (window as any).__diagHarness.handleServerMessage({ type: 'ludo_game_state', snapshot }), finished(winnerColor, 2))
    assert(await page.locator('[data-ludo-overlay-root="1"]').count() === 0, `${label}: late finished snapshot reopened board`)
    await page.evaluate(() => (window as any).__diagHarness.handleServerMessage({ type: 'ludo_match_left', matchId: 'end-match' }))
    assert(await page.locator('[data-ludo-overlay-root="1"]').count() === 0, `${label}: overlay remained after ack`)
    assert(new URL(page.url()).pathname === '/games', `${label}: route is ${page.url()}`)
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForTimeout(250)
    assert(await page.locator('[data-ludo-overlay-root="1"]').count() === 0, `${label}: finished match reopened after refresh`)
    await page.close()
  }

  await scenario('p-red', 'red', { width: 1280, height: 850 }, 'normal winner')
  await scenario('p-blue', 'red', { width: 390, height: 844 }, 'normal loser')
  await scenario('p-blue', 'blue', { width: 1280, height: 850 }, 'forfeit winner')
  console.log('PASS Ludo end-game navigation: normal winner/loser and forfeit winner close on ack, navigate /games, and stay closed after refresh')
} finally {
  await browser.close()
  await vite.close()
}
