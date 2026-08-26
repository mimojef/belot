/**
 * checkTournamentRoundTransitionRoomSnapshotHijack.ts
 *
 * Real browser (Playwright), real production code, real DOM — regression for
 * a THIRD, independent bug found after both the resume_room.silent parser
 * fix and the global "Продължи играта" popup unconditional-suppression fix
 * were already confirmed working in a real browser reproduction of Phase 2
 * (STATE A -> STATE B -> gameplay).
 *
 * SYMPTOM: with both prior fixes active, and with nothing clicked by the
 * player, STATE B ("Класирахте се за финала!" / "Ще играете срещу ... от
 * маса 2" / countdown) still got replaced by a DIFFERENT screen —
 * renderMatchmakingRoomScreen's generic quick-match waiting room
 * ("Подготвяме масата" / "Готов" per seat / countdown) — and then, ~20s
 * later, gameplay started correctly on its own. That "started correctly on
 * its own, nothing clicked" is why server-side timing/attendance/silent
 * attach were NOT the problem — this is purely a client-side DOM ownership
 * bug, and a different one from the previous two.
 *
 * ROOT CAUSE: createLobbyFlowController.ts's own handleServerMessage has a
 * room_snapshot branch (written for the generic matchmaking queue, long
 * before tournaments existed) that treats ANY room_snapshot with
 * roomStatus:'waiting' and game:null as "you're queued for a quick match" —
 * it never checked message.isTournamentMatchOrigin. A round-transition
 * tournament room's own room_snapshot, while the human is silently attached
 * (STATE B) and attendance hasn't resolved yet, has EXACTLY that shape
 * (waiting + no game). This branch unconditionally set
 * state.currentScreen = 'matchmaking-room' and called render(), which does
 * options.root.innerHTML = renderMatchmakingRoomScreen(...) — overwriting
 * the SAME shared root element that STATE B's renderer had just written
 * into (lobby and activeRoom share one root, see main.ts's rootElement
 * passed to both createLobbyFlowController and createActiveRoomFlowController).
 *
 * Both prior fixes are provably unrelated to this: the parser fix only
 * changes which ServerMessage type the resume_room response carries
 * (room_attached_silent vs room_resumed) — this bug is triggered by
 * room_snapshot, a message type neither prior fix touches. The popup fix
 * only changes when tournamentMatchStartPopup.setAssignment is called in
 * main.ts's tournament_match_assigned handler — this bug lives entirely
 * inside createLobbyFlowController.ts's room_snapshot handler and requires
 * no popup, no click, and no tournament_match_assigned message at all to
 * reproduce (a single room_snapshot push is sufficient, as this test proves).
 *
 * FIX: the room_snapshot handler now returns false (does not touch
 * state.currentScreen or render()) whenever message.isTournamentMatchOrigin
 * is true, for ANY tournament room (not just round_transition — a
 * first_match tournament room's own awaiting_players snapshot has the exact
 * same waiting+no-game shape and was equally exposed to this, even though
 * the existing first_match flow happens to reach gameplay via a different,
 * unaffected path today). This leaves createActiveRoomFlowController's own
 * silent-entry watch (armPendingTournamentSilentEntry / the
 * isTournamentAttendanceReadyForSilentEntry gate) as the sole decider of
 * when gameplay becomes visible, with the lobby's STATE B renderer as the
 * sole owner of the DOM until then.
 *
 * This test exercises the REAL createLobbyFlowController (not source-string
 * assertions): it drives it into STATE B via a real (fixture-served)
 * onTournamentDetailLoad response carrying myActiveMatch.deadlineKind ===
 * 'round_transition', then pushes real room_snapshot messages through
 * controller.handleServerMessage(...) — the exact same call main.ts makes —
 * and reads the real rendered DOM/state.
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
  enterStateB: (roomId: string, matchId: string) => Promise<void>
  pushRoomSnapshot: (input: {
    roomId: string
    roomStatus: 'waiting' | 'playing' | 'finished'
    game: unknown
    isTournamentMatchOrigin: boolean
  }) => Promise<void>
  getCurrentScreen: () => Promise<string>
  domHasMatchmakingRoomMarkup: () => Promise<boolean>
  getRecoveredCalls: () => Promise<unknown[]>
  getRoundTransitionAssignmentCalls: () => Promise<unknown[]>
  reset: () => Promise<void>
}

async function harness(page: Page): Promise<H> {
  const w = '__tournamentRoundTransitionRoomSnapshotHarness'
  return {
    enterStateB: (roomId, matchId) => page.evaluate(([k, args]: any) => (window as any)[k].enterStateB(...args), [w, [roomId, matchId]] as any),
    pushRoomSnapshot: (input) => page.evaluate(([k, i]: any) => (window as any)[k].pushRoomSnapshot(i), [w, input] as any),
    getCurrentScreen: () => page.evaluate((k: any) => (window as any)[k].getCurrentScreen(), w),
    domHasMatchmakingRoomMarkup: () => page.evaluate((k: any) => (window as any)[k].domHasMatchmakingRoomMarkup(), w),
    getRecoveredCalls: () => page.evaluate((k: any) => (window as any)[k].getRecoveredCalls(), w),
    getRoundTransitionAssignmentCalls: () => page.evaluate((k: any) => (window as any)[k].getRoundTransitionAssignmentCalls(), w),
    reset: () => page.evaluate((k: any) => (window as any)[k].reset(), w),
  }
}

console.log('\n═══ checkTournamentRoundTransitionRoomSnapshotHijack ═══\n')

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

  const context = await browser.newContext({ baseURL: baseUrl, viewport: { width: 390, height: 844 } })
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', (err) => errors.push(err.message))

  await page.goto('/scripts/fixtures/tournamentRoundTransitionRoomSnapshotHarness.html')
  const h = await harness(page)

  await check('[1] STATE B: navigating to tournament-detail with a round_transition myActiveMatch lands on tournament-detail (STATE B owns the screen)', async () => {
    await h.enterStateB('final-room', 'match-1')
    assert((await h.getCurrentScreen()) === 'tournament-detail', `expected 'tournament-detail', got '${await h.getCurrentScreen()}'`)
  })

  await check('[2] a tournament-origin room_snapshot (waiting + no game — the SAME shape a real round-transition silent attach sees) does NOT hijack the screen to matchmaking-room', async () => {
    await h.pushRoomSnapshot({ roomId: 'final-room', roomStatus: 'waiting', game: null, isTournamentMatchOrigin: true })
    assert((await h.getCurrentScreen()) === 'tournament-detail', `screen was hijacked to '${await h.getCurrentScreen()}' by a tournament-origin room_snapshot — this is the exact production bug`)
    assert((await h.domHasMatchmakingRoomMarkup()) === false, 'matchmaking-room DOM markup was rendered into the shared root, clobbering STATE B')
  })

  await check('[3] repeated tournament-origin waiting snapshots (mirroring the coordinator re-sending on every tick) still do not hijack the screen', async () => {
    await h.pushRoomSnapshot({ roomId: 'final-room', roomStatus: 'waiting', game: null, isTournamentMatchOrigin: true })
    await h.pushRoomSnapshot({ roomId: 'final-room', roomStatus: 'waiting', game: null, isTournamentMatchOrigin: true })
    assert((await h.getCurrentScreen()) === 'tournament-detail', 'a later tournament-origin snapshot hijacked the screen')
    assert((await h.domHasMatchmakingRoomMarkup()) === false, 'matchmaking-room DOM markup appeared after repeated pushes')
  })

  await check('[4] control case: a NON-tournament room_snapshot with the identical waiting+no-game shape DOES still drive the normal matchmaking-room screen (fix is scoped, not a global regression)', async () => {
    await h.pushRoomSnapshot({ roomId: 'quick-match-room', roomStatus: 'waiting', game: null, isTournamentMatchOrigin: false })
    assert((await h.getCurrentScreen()) === 'matchmaking-room', `expected normal matchmaking flow to still reach 'matchmaking-room', got '${await h.getCurrentScreen()}'`)
    assert((await h.domHasMatchmakingRoomMarkup()) === true, 'normal quick-match room_snapshot no longer renders the matchmaking-room screen — fix over-scoped')
  })

  await check('[5] fresh STATE B session: a tournament-origin snapshot that already has a game (attendance resolved, gameplay authoritative) still does not force a lobby-side navigation — activeRoom silent-entry watch remains the sole gameplay-entry decider', async () => {
    await page.goto('/scripts/fixtures/tournamentRoundTransitionRoomSnapshotHarness.html')
    const fresh = await harness(page)
    await fresh.enterStateB('final-room-2', 'match-2')
    await fresh.pushRoomSnapshot({
      roomId: 'final-room-2',
      roomStatus: 'playing',
      game: { phase: 'cutting', authoritativePhase: 'cutting' },
      isTournamentMatchOrigin: true,
    })
    assert((await fresh.getCurrentScreen()) === 'tournament-detail', 'lobby navigated away from tournament-detail on its own for an authoritative-started tournament snapshot — that decision belongs to activeRoom, not the lobby')
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
