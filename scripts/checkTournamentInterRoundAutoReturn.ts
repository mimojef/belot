/**
 * checkTournamentInterRoundAutoReturn.ts
 *
 * Real browser (Playwright), real production code, real DOM — regression for
 * the event-driven STATE A → STATE B auto-return: a player who has left
 * STATE A ("Изчаквате победителя от маса X") to browse elsewhere in the SPA
 * (lobby home, players, tournaments list, chat, ...) must be brought back
 * to the tournament's detail screen automatically, showing STATE B ("Ще
 * играете срещу ... / Следващият мач започва след ..."), the moment the
 * server's authoritative round-transition assignment
 * (tournament_match_assigned, deadlineKind === 'round_transition') arrives
 * — no polling, no popup, no lock.
 *
 * This SUPERSEDES the now-reverted checkTournamentInterRoundLock.ts, which
 * tested a stricter "STATE A/B are non-dismissible" requirement that this
 * product decision replaced: STATE A is freely dismissable again (no nav
 * lock, no disabled buttons, no browser-back trap), and the round-transition
 * push itself is what drives the player back — automatically, once, in
 * place of the reverted continuous lock.
 *
 * IMPLEMENTATION (main.ts's tournament_match_assigned handler, § "A → B
 * AUTO NAVIGATION" — this test exercises the SAME two LobbyFlowController
 * calls the handler makes, in the same order, under the same condition; see
 * scripts/fixtures/tournamentInterRoundAutoReturnHarness.ts's
 * simulateTournamentMatchAssignedPush for the exact mirror):
 *
 *   if (message.assignment.deadlineKind === 'round_transition') {
 *     attemptTournamentRoundTransitionSilentAttach(message.assignment)  // unchanged, covered by checkTournamentUnifiedTransitionTiming
 *     if (lobby.getCurrentTournamentDetailId() !== message.assignment.tournamentId) {
 *       lobby.navigateToTournamentDetail(message.assignment.tournamentId)
 *     }
 *   }
 *
 * getCurrentTournamentDetailId() (new, minimal public getter on
 * LobbyFlowController — returns the tournament id ONLY when the current
 * screen is 'tournament-detail', null otherwise) is what makes this
 * idempotent and lets an ALREADY-showing STATE A transition in place into
 * STATE B via the pre-existing fetchTournamentDetail re-render path,
 * without a redundant navigateToTournamentDetail call (which would reset
 * tournamentDetail to null and flash a loading state for no reason).
 *
 * No second renderer: navigateToTournamentDetail is the exact same function
 * the tournaments list's "Отвори" click already calls — lobby/tournament
 * controller remains the single owner of STATE A/B's DOM. No polling: this
 * fires exactly once, synchronously inside the WS message handler, driven
 * purely by the server push.
 */

import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright'
import { createServer as createNetServer } from 'node:net'

let passed = 0
let failed = 0

function pass(label: string): void {
  passed++
  console.log(`  PASS  ${label}`)
}
function fail(label: string, reason: unknown): void {
  failed++
  console.error(`  FAIL  ${label}: ${reason instanceof Error ? reason.message : String(reason)}`)
}
async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    pass(label)
  } catch (err) {
    fail(label, err)
  }
}
function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('no free port'))
        return
      }
      const { port } = address
      srv.close(() => resolve(port))
    })
  })
}

type H = {
  enterStateAOnDetail: () => Promise<void>
  goToScreen: (screen: 'lobby' | 'players' | 'chat' | 'tournaments') => Promise<void>
  simulateTournamentMatchAssignedPush: () => Promise<void>
  getCurrentScreen: () => Promise<string>
  getCurrentTournamentDetailId: () => Promise<string | null>
  getPathname: () => Promise<string>
  domHasStateBMarkup: () => Promise<boolean>
  domHasStateAMarkup: () => Promise<boolean>
  getNavigateToTournamentDetailCalls: () => Promise<number>
  reset: () => Promise<void>
}

async function harness(page: Page): Promise<H> {
  const w = '__tournamentInterRoundAutoReturnHarness'
  return {
    enterStateAOnDetail: () => page.evaluate((k: any) => (window as any)[k].enterStateAOnDetail(), w),
    goToScreen: (screen) => page.evaluate(([k, s]: any) => (window as any)[k].goToScreen(s), [w, screen] as any),
    simulateTournamentMatchAssignedPush: () => page.evaluate((k: any) => (window as any)[k].simulateTournamentMatchAssignedPush(), w),
    getCurrentScreen: () => page.evaluate((k: any) => (window as any)[k].getCurrentScreen(), w),
    getCurrentTournamentDetailId: () => page.evaluate((k: any) => (window as any)[k].getCurrentTournamentDetailId(), w),
    getPathname: () => page.evaluate((k: any) => (window as any)[k].getPathname(), w),
    domHasStateBMarkup: () => page.evaluate((k: any) => (window as any)[k].domHasStateBMarkup(), w),
    domHasStateAMarkup: () => page.evaluate((k: any) => (window as any)[k].domHasStateAMarkup(), w),
    getNavigateToTournamentDetailCalls: () => page.evaluate((k: any) => (window as any)[k].getNavigateToTournamentDetailCalls(), w),
    reset: () => page.evaluate((k: any) => (window as any)[k].reset(), w),
  }
}

console.log('\n═══ checkTournamentInterRoundAutoReturn ═══\n')

let vite: ViteDevServer | null = null
let browser: Browser | null = null

try {
  const port = await findFreePort()
  vite = await createViteServer({
    root: process.cwd(),
    server: { port, strictPort: true, host: '127.0.0.1' },
    logLevel: 'error',
  })
  await vite.listen()

  browser = await chromium.launch()
  const baseUrl = `http://127.0.0.1:${port}`

  const context = await browser.newContext({ baseURL: baseUrl, viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', (err) => errors.push(err.message))

  await page.goto('/scripts/fixtures/tournamentInterRoundAutoReturnHarness.html')
  const h = await harness(page)

  // --- A/B: STATE A is freely dismissable (no lock) ---
  await check('[A] STATE A reaches tournament-detail, then Lobby navigation is freely allowed (no lock)', async () => {
    await h.enterStateAOnDetail()
    assert((await h.getCurrentScreen()) === 'tournament-detail', 'did not reach STATE A')
    await h.goToScreen('lobby')
    assert((await h.getCurrentScreen()) === 'lobby', `Lobby navigation was blocked — expected 'lobby', got '${await h.getCurrentScreen()}'`)
  })

  await check('[B] from Lobby, navigating to another normal SPA section (players) is allowed', async () => {
    await h.goToScreen('players')
    assert((await h.getPathname()) === '/players', 'navigation to /players did not go through')
  })

  // --- C: no forced return while sibling is still playing ---
  await check('[C] user in Lobby, sibling still playing: no forced return yet (nothing pushed)', async () => {
    await h.goToScreen('lobby')
    assert((await h.getCurrentScreen()) === 'lobby', 'unexpectedly left Lobby without any assignment push')
  })

  // --- D: auto-return from Lobby ---
  await check('[D] user in Lobby, round-transition assignment arrives: automatic navigation to tournament detail, STATE B renders, exactly once', async () => {
    await h.reset()
    await h.goToScreen('lobby')
    await h.simulateTournamentMatchAssignedPush()
    assert((await h.getCurrentScreen()) === 'tournament-detail', `did not auto-navigate to tournament-detail from Lobby — got '${await h.getCurrentScreen()}'`)
    assert((await h.getCurrentTournamentDetailId()) === 'tour-1', 'landed on tournament-detail but for the wrong tournament id')
    assert((await h.domHasStateBMarkup()) === true, 'STATE B markup did not render after auto-return')
    assert((await h.getNavigateToTournamentDetailCalls()) === 1, `navigateToTournamentDetail should fire exactly once, fired ${await h.getNavigateToTournamentDetailCalls()} times`)
  })

  // --- E: auto-return from other sections (players/tournaments list) ---
  await check('[E] user on Players screen, round-transition assignment arrives: same automatic return to STATE B', async () => {
    await h.reset()
    await h.goToScreen('players')
    await h.simulateTournamentMatchAssignedPush()
    assert((await h.getCurrentScreen()) === 'tournament-detail', `did not auto-navigate from Players — got '${await h.getCurrentScreen()}'`)
    assert((await h.domHasStateBMarkup()) === true, 'STATE B markup did not render after auto-return from Players')
  })

  // --- F: already on STATE A for this tournament — in-place transition, no redundant navigate ---
  await check('[F] user already viewing STATE A for this tournament: assignment arrival transitions in place, no redundant navigateToTournamentDetail call', async () => {
    await h.reset()
    await h.enterStateAOnDetail()
    assert((await h.domHasStateAMarkup()) === true, 'sanity: STATE A markup should be visible before the push')
    await h.simulateTournamentMatchAssignedPush()
    assert((await h.getCurrentScreen()) === 'tournament-detail', 'left tournament-detail unexpectedly during in-place A->B transition')
    assert((await h.domHasStateBMarkup()) === true, 'STATE B markup did not render for the in-place transition')
    assert((await h.getNavigateToTournamentDetailCalls()) === 0, `already being on the correct tournament-detail should skip navigateToTournamentDetail entirely, but it fired ${await h.getNavigateToTournamentDetailCalls()} times`)
  })

  await check('Няма JS грешки в конзолата през целия сценарий', () => {
    assert(errors.length === 0, `console errors: ${errors.join('; ')}`)
  })

  await context.close()

  console.log('\n' + '═'.repeat(64))
  console.log(`Passed: ${passed}  Failed: ${failed}`)
  if (failed > 0) process.exit(1)
} finally {
  if (browser) await browser.close()
  if (vite) await vite.close()
}
