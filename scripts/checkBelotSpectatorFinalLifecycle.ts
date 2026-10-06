/**
 * checkBelotSpectatorFinalLifecycle.ts
 *
 * Phase 5B — spectator match-end lifecycle. Real browser (Playwright), real
 * production код (createActiveRoomFlowController + renderMatchEndedScreen)
 * през activeRoomSpectatorHarness.ts. harness.setEmulateMainSpectatorExit(true)
 * огледално повтаря main.ts onSpectatorExitRequested (exitSpectatorView +
 * lobby.unwatchBelotSpectatorRoom), за да се брои реалният unwatch.
 *
 * Spectator: match-ended -> замразено финално табло -> след 10 s ЕДИН
 * unwatch през canonical Изход пътя; никога leave_active_room/replay.
 *
 *   [F1] match-ended -> финалното табло е видимо
 *   [F2] ~9.9 s -> още е на финалното табло, нищо не е изпратено
 *   [F3] 10 s -> точно един unwatch (onSpectatorExitRequested) и после никакъв втори
 *   [F4] след auto-exit -> spectator activeRoom state е изчистен
 *   [F5] source review: auto-exit = canonical Изход път -> unwatch + Частни маси -> Играещи
 *   [F6] никога leave_active_room / participant return-to-lobby
 *   [F7] ръчен Изход преди 10 s -> timer отменен, само един unwatch
 *   [F8] belot_spectate_ended (teardown) преди timer -> timer отменен
 *   [F9] нов spectator session (друга И същата стая) -> стар timer не я затваря
 *   [F10] cold entry директно в match-ended -> също auto-exit след 10 s
 *   [R1] replay започва преди 10 s -> spectator остава на frozen final board
 *   [R2] dealing/bidding/cutting snapshot от replay-а не заменя таблото
 *   [R3] spectator не гласува replay (без sendReplayVote / replay бутон)
 *   [B1-B3] desktop: без Преиграй / Нова игра / Към лобито
 *   [B4-B6] mobile: без Преиграй / Нова игра / Към лобито
 *   [B7] има Settings + Изход (desktop и mobile)
 *   [P1] participant: match-ended controls + countdown остават, replay snapshot-ът
 *        се прилага нормално (няма freeze), без spectator auto-exit
 */

import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright'
import { createServer as createNetServer } from 'node:net'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

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
function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}
function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) throw new Error(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
}
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)) }
async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await sleep(150)
  }
  throw new Error('waitUntil: timed out')
}
function findFreePort(): Promise<number> {
  return new Promise((resolveFree, reject) => {
    const srv = createNetServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      if (address === null || typeof address === 'string') { reject(new Error('no port')); return }
      const { port } = address
      srv.close(() => resolveFree(port))
    })
  })
}

type H = any

async function call<T>(page: Page, fn: (h: H, arg: any) => T, arg: any = undefined): Promise<T> {
  return page.evaluate(
    ({ fn: fnStr, arg: a }) => {
      const h = (window as any).__activeRoomSpectatorHarness
      // eslint-disable-next-line no-eval
      const resolved = (0, eval)(fnStr) as (h: H, arg: any) => T
      return resolved(h, a)
    },
    { fn: fn.toString(), arg },
  )
}

const FINAL_BOARD_MS = 10_000
const PARTICIPANT_BUTTON_TEXT = /Преиграй|Нова игра|Към лобито/

console.log('\ncheckBelotSpectatorFinalLifecycle\n')

let vite: ViteDevServer | null = null
let browser: Browser | null = null

try {
  const port = await findFreePort()
  vite = await createViteServer({ root: process.cwd(), server: { port, strictPort: true, host: '127.0.0.1' }, logLevel: 'error' })
  await vite.listen()
  const baseUrl = `http://127.0.0.1:${port}/scripts/fixtures/activeRoomSpectatorHarness.html`
  browser = await chromium.launch()

  async function newPage(mobile = false): Promise<Page> {
    const context = await browser!.newContext(mobile
      ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
      : { viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    const pageErrors: string[] = []
    page.on('pageerror', (e) => pageErrors.push(e.message))
    await page.goto(baseUrl)
    await page.waitForFunction(() => (window as any).__activeRoomSpectatorHarness !== undefined, undefined, { timeout: 10_000 })
    ;(page as any).__pageErrors = pageErrors
    await call(page, (h: H) => h.setEmulateMainSpectatorExit(true))
    return page
  }
  function assertNoPageErrors(page: Page, label: string): void {
    const errors = (page as any).__pageErrors as string[]
    assert(errors.length === 0, `${label}: unexpected page errors: ${errors.join(' | ')}`)
  }
  const countCalls = (page: Page, name: string) => call(page, (h: H, n: string) => h.getCalls().filter((c: any) => c.name === n).length, name)
  // Прилага match-ended snapshot и засича t0 в браузъра (performance.now()).
  const applyMatchEnded = (page: Page, roomId: string) => call(page, (h: H, r: string) => {
    (window as any).__finalT0 = performance.now()
    return h.applySpectatorSnapshot(r, h.matchEndedGame())
  }, roomId)
  const elapsedSinceFinal = (page: Page) => call(page, () => performance.now() - (window as any).__finalT0)
  const sleepUntilElapsed = async (page: Page, targetMs: number) => {
    const elapsed = await elapsedSinceFinal(page)
    if (elapsed < targetMs) await sleep(targetMs - elapsed)
  }

  // Всички 10-секундни сценарии тичат паралелно (отделни pages).
  const scenarios: Array<() => Promise<void>> = []

  // ── Main path: F1-F6, R1-R3 ─────────────────────────────────────────────
  scenarios.push(async () => {
    const page = await newPage()
    await call(page, (h: H) => h.enterAsSpectator('room-final', h.playingGame()))
    await applyMatchEnded(page, 'room-final')

    await check('[F1] match-ended -> final board visible', async () => {
      await waitUntil(() => call(page, (h: H) => h.matchEndedInfo().text.includes('ПОБЕДИТЕЛ: ОТБОР А')), 3_000)
    })

    await sleepUntilElapsed(page, 1_000)
    // Replay: играчите започват нов мач в същата стая преди 10 s.
    await call(page, (h: H) => h.applySpectatorSnapshot('room-final', h.cuttingGame({ cutting: { cutterSeat: 'right', selectedCutIndex: null, deckCount: 32, canSubmitCut: false } })))
    await call(page, (h: H) => h.applySpectatorSnapshot('room-final', h.biddingGame()))
    await sleep(600)

    await check('[R1/R2] replay snapshots (cutting/bidding) before 10 s do not replace the frozen final board', async () => {
      const info = await call(page, (h: H) => h.matchEndedInfo())
      assert(info.text.includes('ПОБЕДИТЕЛ: ОТБОР А'), `final board still visible: ${info.text.slice(0, 60)}`)
      assertEqual(await call(page, (h: H) => h.hasBiddingPopup()), false, 'no bidding UI')
      assertEqual(await call(page, (h: H) => h.hasCuttingInteractiveArea()), false, 'no cutting UI')
      assertEqual(await call(page, (h: H) => h.countVisibleCardsInFan('bottom')), 0, 'no dealt hands of the new game')
    })

    await check('[R3] spectator never votes replay (no sendReplayVote, no replay button)', async () => {
      assertEqual(await countCalls(page, 'sendReplayVote'), 0, 'sendReplayVote')
      assertEqual(await page.locator('[data-match-ended-replay-button]').count(), 0, 'replay button')
    })

    await sleepUntilElapsed(page, FINAL_BOARD_MS - 250)
    await check('[F2] at ~9.75 s: still on the final board, nothing sent', async () => {
      const elapsed = await elapsedSinceFinal(page)
      assert(elapsed < FINAL_BOARD_MS, `sampled too late: ${Math.round(elapsed)} ms`)
      assertEqual(await countCalls(page, 'onSpectatorExitRequested'), 0, 'no exit yet')
      assertEqual(await call(page, (h: H) => h.hasActiveRoomFn()), true, 'still watching')
      assert((await call(page, (h: H) => h.matchEndedInfo())).text.includes('ПОБЕДИТЕЛ'), 'board visible')
    })

    await sleepUntilElapsed(page, FINAL_BOARD_MS + 700)
    await check('[F3] at 10 s: exactly one unwatch through the canonical exit path', async () => {
      assertEqual(await countCalls(page, 'onSpectatorExitRequested'), 1, 'onSpectatorExitRequested')
      assertEqual(await countCalls(page, 'unwatchBelotSpectatorRoom'), 1, 'unwatch')
    })

    await check('[F4] after auto-exit: spectator state clean', async () => {
      assertEqual(await call(page, (h: H) => h.hasActiveRoomFn()), false, 'hasActiveRoom')
      assertEqual(await call(page, (h: H) => h.isSpectatorViewFn()), false, 'isSpectatorView')
      assertEqual(await call(page, (h: H) => h.matchEndedInfo().text), '', 'final board removed')
    })

    await sleep(2_000)
    await check('[F6] never leave_active_room / participant flows; still exactly one unwatch later', async () => {
      assertEqual(await countCalls(page, 'leaveActiveRoom'), 0, 'leaveActiveRoom')
      assertEqual(await countCalls(page, 'onStartNewGameFromMatchEnded'), 0, 'new game')
      assertEqual(await countCalls(page, 'unwatchBelotSpectatorRoom'), 1, 'no second unwatch')
    })
    assertNoPageErrors(page, 'main path')
    await page.close()
  })

  // ── F7 manual Exit ──────────────────────────────────────────────────────
  scenarios.push(async () => {
    const page = await newPage()
    await call(page, (h: H) => h.enterAsSpectator('room-f7', h.playingGame()))
    await applyMatchEnded(page, 'room-f7')
    await sleepUntilElapsed(page, 3_500)
    await call(page, (h: H) => h.clickLeaveButton())
    await sleepUntilElapsed(page, FINAL_BOARD_MS + 1_500)
    await check('[F7] manual Exit at ~3.5 s: leaves immediately, timer cancelled, exactly one unwatch', async () => {
      assertEqual(await countCalls(page, 'onSpectatorExitRequested'), 1, 'exit requests')
      assertEqual(await countCalls(page, 'unwatchBelotSpectatorRoom'), 1, 'unwatch')
      assertEqual(await countCalls(page, 'leaveActiveRoom'), 0, 'leaveActiveRoom')
      assertEqual(await call(page, (h: H) => h.hasActiveRoomFn()), false, 'view closed')
    })
    assertNoPageErrors(page, 'F7')
    await page.close()
  })

  // ── F8 belot_spectate_ended before the timer ────────────────────────────
  scenarios.push(async () => {
    const page = await newPage()
    await call(page, (h: H) => h.enterAsSpectator('room-f8', h.playingGame()))
    await applyMatchEnded(page, 'room-f8')
    await sleepUntilElapsed(page, 3_000)
    // main.ts finishBelotSpectatorView -> activeRoom.exitSpectatorView()
    await call(page, (h: H) => h.exitSpectator())
    await sleepUntilElapsed(page, FINAL_BOARD_MS + 1_500)
    await check('[F8] belot_spectate_ended teardown before 10 s cancels the timer', async () => {
      assertEqual(await countCalls(page, 'onSpectatorExitRequested'), 0, 'no late exit request')
      assertEqual(await countCalls(page, 'unwatchBelotSpectatorRoom'), 0, 'no late unwatch')
    })
    assertNoPageErrors(page, 'F8')
    await page.close()
  })

  // ── F9 new spectator session (other room) ───────────────────────────────
  scenarios.push(async () => {
    const page = await newPage()
    await call(page, (h: H) => h.enterAsSpectator('room-f9a', h.playingGame()))
    await applyMatchEnded(page, 'room-f9a')
    await sleepUntilElapsed(page, 3_000)
    await call(page, (h: H) => h.exitSpectator())
    await call(page, (h: H) => h.enterAsSpectator('room-f9b', h.playingGame()))
    await sleepUntilElapsed(page, FINAL_BOARD_MS + 1_500)
    await check('[F9a] new session in another room: old timer cannot close it', async () => {
      assertEqual(await countCalls(page, 'onSpectatorExitRequested'), 0, 'no exit request')
      assertEqual(await call(page, (h: H) => h.getCurrentRoomIdFn()), 'room-f9b', 'still watching the new room')
    })
    assertNoPageErrors(page, 'F9a')
    await page.close()
  })

  // ── F9 new spectator session (same room re-watch with a fresh game) ─────
  scenarios.push(async () => {
    const page = await newPage()
    await call(page, (h: H) => h.enterAsSpectator('room-f9c', h.playingGame()))
    await applyMatchEnded(page, 'room-f9c')
    await sleepUntilElapsed(page, 3_000)
    await call(page, (h: H) => h.exitSpectator())
    await call(page, (h: H) => h.enterAsSpectator('room-f9c', h.biddingGame()))
    await sleepUntilElapsed(page, FINAL_BOARD_MS + 1_500)
    await check('[F9b] re-watch of the same room: old timer cannot close the new session; no freeze carried over', async () => {
      assertEqual(await countCalls(page, 'onSpectatorExitRequested'), 0, 'no exit request')
      assertEqual(await call(page, (h: H) => h.hasActiveRoomFn()), true, 'new session alive')
      assertEqual(await call(page, (h: H) => h.matchEndedInfo().text), '', 'new game is shown, not a stale final board')
    })
    assertNoPageErrors(page, 'F9b')
    await page.close()
  })

  // ── F10 cold entry into match-ended ─────────────────────────────────────
  scenarios.push(async () => {
    const page = await newPage()
    await call(page, (h: H) => {
      (window as any).__finalT0 = performance.now()
      return h.enterAsSpectator('room-f10', h.matchEndedGame())
    })
    await sleepUntilElapsed(page, FINAL_BOARD_MS + 700)
    await check('[F10] cold entry directly into match-ended also auto-exits after 10 s', async () => {
      assertEqual(await countCalls(page, 'unwatchBelotSpectatorRoom'), 1, 'unwatch')
      assertEqual(await call(page, (h: H) => h.hasActiveRoomFn()), false, 'view closed')
    })
    assertNoPageErrors(page, 'F10')
    await page.close()
  })

  // ── P1 participant regression ───────────────────────────────────────────
  scenarios.push(async () => {
    const page = await newPage()
    await call(page, (h: H) => h.enterAsParticipant('room-p1', 'bottom'))
    await call(page, (h: H) => h.applyParticipantSnapshot('room-p1', h.matchEndedGame()))
    await waitUntil(() => call(page, (h: H) => h.matchEndedInfo().text.length > 0), 3_000)
    const before = await call(page, (h: H) => ({ info: h.matchEndedInfo(), buttons: h.hasMatchEndedActionButtons() }))
    await call(page, (h: H) => h.applyParticipantSnapshot('room-p1', h.biddingGame({
      bidding: { winningBid: null, currentBidderSeat: 'bottom', entries: [], canSubmitBid: true, validActions: { pass: true, noTrumps: true, allTrumps: true, double: false, redouble: false, suits: { clubs: true, diamonds: true, hearts: true, spades: true } } },
    })))
    await sleep(11_000)
    await check('[P1] participant: controls + countdown unchanged, replay snapshot applies (no freeze), no spectator auto-exit', async () => {
      assertEqual(before.buttons, true, 'participant match-ended buttons')
      assertEqual(before.info.hasCountdown, true, 'participant countdown')
      assertEqual(await call(page, (h: H) => h.matchEndedInfo().text), '', 'participant moved on to the new game')
      assertEqual(await countCalls(page, 'onSpectatorExitRequested'), 0, 'no spectator exit for participant')
      assertEqual(await call(page, (h: H) => h.hasActiveRoomFn()), true, 'participant still in room')
    })
    assertNoPageErrors(page, 'P1')
    await page.close()
  })

  // ── B1-B7 buttons (desktop + mobile) ────────────────────────────────────
  for (const [mobile, prefix] of [[false, '[B1-B3/B7 desktop]'], [true, '[B4-B6/B7 mobile]']] as const) {
    scenarios.push(async () => {
      const page = await newPage(mobile)
      await call(page, (h: H) => h.enterAsSpectator('room-b', h.matchEndedGame()))
      await waitUntil(() => call(page, (h: H) => h.matchEndedInfo().text.length > 0), 3_000)
      await check(`${prefix} no Преиграй / Нова игра / Към лобито; Settings + Exit present`, async () => {
        assertEqual(await page.locator('[data-match-ended-replay-button]').count(), 0, 'Преиграй')
        assertEqual(await page.locator('[data-match-ended-new-game-button]').count(), 0, 'Нова игра')
        assertEqual(await page.locator('[data-match-ended-lobby-button]').count(), 0, 'Към лобито')
        const text = await page.evaluate(() => document.body.innerText)
        assert(!PARTICIPANT_BUTTON_TEXT.test(text), 'no participant button labels anywhere')
        assertEqual(await call(page, (h: H) => h.hasSettingsButton()), true, 'Settings')
        assertEqual(await call(page, (h: H) => h.hasLeaveButton()), true, 'Exit')
        assertEqual(await call(page, (h: H) => h.hasPrizeCounter()), false, 'no prize')
      })
      assertNoPageErrors(page, prefix)
      await page.close()
    })
  }

  await Promise.all(scenarios.map((run) => run().catch((err) => fail('scenario crashed', err))))

  // ── F5 source review ────────────────────────────────────────────────────
  await check('[F5] source review: auto-exit uses the canonical Изход path -> unwatch + Частни маси -> Играещи', async () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const read = async (rel: string) => (await readFile(join(here, '..', ...rel.split('/')), 'utf8')).replace(/\r\n/g, '\n')
    const controller = await read('src/app/activeRoom/createActiveRoomFlowController.ts')
    const sync = controller.slice(controller.indexOf('function syncSpectatorFinalBoard('), controller.indexOf('// Targeted ticker за tournament attendance'))
    assert(sync.includes('options.onSpectatorExitRequested(roomId)'), 'timer goes through onSpectatorExitRequested')
    assert(!/leaveActiveRoom|returnToLobbyFromMatchEnded|sendReplayVote/.test(sync), 'timer never uses participant flows')
    assert(sync.includes('SPECTATOR_FINAL_BOARD_MS'), 'uses the 10 s constant')
    assert(controller.includes('const SPECTATOR_FINAL_BOARD_MS = 10_000'), '10 000 ms')
    const exit = controller.slice(controller.indexOf('  function exitSpectatorView(): void {'), controller.indexOf('  function isSpectatorView(): boolean {'))
    assert(exit.includes('clearSpectatorFinalBoard()'), 'every spectator teardown clears the timer')
    const main = await read('src/main.ts')
    const handler = main.slice(main.indexOf('onSpectatorExitRequested: (_roomId) => {'), main.indexOf('},', main.indexOf('onSpectatorExitRequested: (_roomId) => {')))
    assert(handler.includes('activeRoom.exitSpectatorView()') && handler.includes('lobby?.unwatchBelotSpectatorRoom()'), 'main: exit view + unwatch')
    const lobby = await read('src/app/lobby/createLobbyFlowController.ts')
    const unwatch = lobby.slice(lobby.indexOf('  function unwatchBelotSpectatorRoom(): void {'), lobby.indexOf('  function navigateAfterBelotSpectateEnded(): void {'))
    assert(unwatch.includes('options.onUnwatchBelotRoom?.(state.spectatingBelotRoomId)') && unwatch.includes('navigateAfterBelotSpectateEnded()'), 'lobby: unwatch_belot_room + navigation')
    const nav = lobby.slice(lobby.indexOf('  function navigateAfterBelotSpectateEnded(): void {'), lobby.indexOf('  function navigateAfterBelotSpectateEnded(): void {') + 400)
    assert(nav.includes("state.currentScreen = 'private-rooms'") && nav.includes("state.privateRoomsLifecycleTab = 'playing'") && nav.includes('options.onPrivateGamesOpen?.()'), 'Частни маси -> Играещи + list refresh')
  })
} finally {
  if (browser) await browser.close()
  if (vite) await vite.close()
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
process.exit(0)
