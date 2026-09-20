import { createServer as createNetServer } from 'node:net'
import { chromium } from 'playwright'
import { createServer as createViteServer } from 'vite'
import { createLudoAuthoritativeInitialState } from '../server/src/game/ludoEngine/ludoEngineState.js'
import { reduceLudoGame } from '../server/src/game/ludoEngine/ludoEngineReducer.js'

const assert = (value: unknown, message: string): asserts value => { if (!value) throw new Error(message) }
const freePort = () => new Promise<number>((resolve, reject) => {
  const server = createNetServer().once('error', reject).listen(0, '127.0.0.1', () => {
    const address = server.address(); if (!address || typeof address === 'string') return reject(new Error('No port'))
    server.close(() => resolve(address.port))
  })
})

const initial = createLudoAuthoritativeInitialState(['red', 'blue'])
const started = reduceLudoGame(initial, { type: 'ROLL_STARTED', color: 'red', expectedTurnVersion: 0 })
const rolled = reduceLudoGame(started.state, { type: 'ROLL_RESOLVED', color: 'red', expectedTurnVersion: 1, value: 6 })
const moved = reduceLudoGame(rolled.state, { type: 'MOVE_REQUESTED', color: 'red', expectedTurnVersion: 2, slot: 0 })
const advanced = reduceLudoGame(moved.state, { type: 'TURN_ADVANCED', color: 'red', expectedTurnVersion: 3 })
const base = { matchId: 'match-1', ludoRoomId: 'room-1', stake: 100, players: [
  { profileId: 'p-red', displayName: 'Red', avatarUrl: null, color: 'red' },
  { profileId: 'p-blue', displayName: 'Blue', avatarUrl: null, color: 'blue' },
], botControlledColors: [], winnerProfileId: null }
const rollSnapshot = { ...base, revision: 1, serverNow: Date.now(), deadlineAt: Date.now() + 15_000, state: rolled.state, events: rolled.events }
const moveSnapshot = { ...base, revision: 2, serverNow: Date.now(), deadlineAt: Date.now() + 10_000, state: advanced.state, events: [...moved.events, ...advanced.events] }
const nearWin = {
  ...initial,
  pieces: initial.pieces.map((piece) => piece.color === 'red'
    ? { ...piece, position: { kind: 'finish' as const, finishIndex: piece.slot === 0 ? 4 : 5 } }
    : piece),
}
const winningStarted = reduceLudoGame(nearWin, { type: 'ROLL_STARTED', color: 'red', expectedTurnVersion: 0 })
const winningRolled = reduceLudoGame(winningStarted.state, { type: 'ROLL_RESOLVED', color: 'red', expectedTurnVersion: 1, value: 1 })
const winningMoved = reduceLudoGame(winningRolled.state, { type: 'MOVE_REQUESTED', color: 'red', expectedTurnVersion: 2, slot: 0 })
const winningRollSnapshot = { ...base, revision: 3, serverNow: Date.now(), deadlineAt: Date.now() + 15_000, state: winningRolled.state, events: winningRolled.events }
const winningMoveSnapshot = { ...base, revision: 4, serverNow: Date.now(), deadlineAt: null, state: winningMoved.state, events: winningMoved.events, winnerProfileId: 'p-red' }

const port = await freePort(); const vite = await createViteServer({ server: { host: '127.0.0.1', port } }); const browser = await chromium.launch({ headless: true })
try {
  await vite.listen()
  const contexts = await Promise.all([{ width: 1280, height: 850 }, { width: 390, height: 844 }].map((viewport) => browser.newContext({ viewport })))
  const pages = await Promise.all(contexts.map(async (context, index) => {
    const page = await context.newPage(); await page.goto(`http://127.0.0.1:${port}/scripts/fixtures/ludoAuthoritativeHarness.html?color=${index ? 'blue' : 'red'}`)
    await page.waitForFunction(() => (window as any).__ludoAuthHarness); return page
  }))
  const apply = (page: typeof pages[number], snapshot: unknown) => page.evaluate((value) => (window as any).__ludoAuthHarness.apply(value), snapshot)
  await Promise.all(pages.map((page) => apply(page, rollSnapshot))); await pages[0]!.waitForTimeout(1_050)
  assert(await pages[0]!.evaluate(() => (window as any).__ludoAuthHarness.diceVisible()), 'desktop dice result missing')
  assert(await pages[1]!.evaluate(() => (window as any).__ludoAuthHarness.diceVisible()), 'mobile dice result missing')
  const beforeDuplicate = await pages[0]!.evaluate(() => (window as any).__ludoAuthHarness.sounds())
  await apply(pages[0]!, rollSnapshot); await pages[0]!.waitForTimeout(100)
  const afterDuplicate = await pages[0]!.evaluate(() => (window as any).__ludoAuthHarness.sounds())
  assert(JSON.stringify(beforeDuplicate) === JSON.stringify(afterDuplicate), 'duplicate snapshot replayed dice sound')
  await Promise.all(pages.map((page) => apply(page, moveSnapshot))); await pages[0]!.waitForTimeout(1_000)
  const cells = await Promise.all(pages.map((page) => page.evaluate(() => (window as any).__ludoAuthHarness.pieceCell('red-0'))))
  assert(cells[0] === 'track-0' && cells[1] === 'track-0', `clients diverged: ${cells.join(',')}`)
  await apply(pages[0]!, rollSnapshot); await pages[0]!.waitForTimeout(100)
  assert(await pages[0]!.evaluate(() => (window as any).__ludoAuthHarness.pieceCell('red-0')) === 'track-0', 'stale snapshot rolled board back')
  await Promise.all(pages.map((page) => apply(page, winningRollSnapshot))); await pages[0]!.waitForTimeout(1_050)
  await Promise.all(pages.map((page) => apply(page, winningMoveSnapshot))); await pages[0]!.waitForTimeout(1_900)
  const endTexts = await Promise.all(pages.map((page) => page.evaluate(() => (window as any).__ludoAuthHarness.endText())))
  assert(endTexts[0].includes('Вие сте победител в играта!'), `winner popup text missing: ${endTexts[0]}`)
  assert(endTexts[1].includes('Вие загубихте играта.'), `loser popup text missing: ${endTexts[1]}`)
  const endSoundCounts = await Promise.all(pages.map((page) => page.evaluate(() => (window as any).__ludoAuthHarness.sounds()['/audio/ludo/end-game.mp3'] ?? 0)))
  assert(endSoundCounts[0] === 1 && endSoundCounts[1] === 1, `end-game sound counts differ: ${endSoundCounts.join(',')}`)
  await Promise.all(pages.map((page) => apply(page, winningMoveSnapshot))); await pages[0]!.waitForTimeout(100)
  const duplicateEndSoundCounts = await Promise.all(pages.map((page) => page.evaluate(() => (window as any).__ludoAuthHarness.sounds()['/audio/ludo/end-game.mp3'] ?? 0)))
  assert(duplicateEndSoundCounts[0] === 1 && duplicateEndSoundCounts[1] === 1, 'duplicate final snapshot replayed end-game sound')
  console.log('PASS two browser clients: identical state stream, stale/duplicate revisions ignored, winner/loser popup, one end-game sound, desktop+mobile render')
  await Promise.all(contexts.map((context) => context.close()))
} finally { await browser.close(); await vite.close() }
