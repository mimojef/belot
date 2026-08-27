/**
 * checkTournamentScoringPhaseGuard.ts
 *
 * Real browser (Playwright), real production code, real DOM — behavioral
 * regression за ISSUE 1: последният scoring panel на спечелен non-final
 * tournament round се прекъсваше преждевременно (преди пълните 5s
 * authoritative summaryVisibleMs), защото
 * getTournamentRoundResultTransitionContext() гейтваше само на
 * `game.matchEnded == null`, без да проверява реалната
 * `authoritativePhase`.
 *
 * Реален race: сървърът вече изчислява matchEnded в момента на влизане в
 * scoring фазата на печелившата ръка (startServerScoringPhase.ts), преди
 * authoritative-ния 5s delay да изтече. Coordinator-ът пре-праща
 * tournament_match_assigned на всеки tick за ВСЕКИ runnable мач (включително
 * вече in_progress) — main.ts вика
 * activeRoom.completePendingTournamentRoundResultTransition() безусловно на
 * всяко такова съобщение. Без phase guard, това прекъсваше scoring панела
 * преди сървърът реално да е преминал в 'match-ended'.
 *
 * Fix: getTournamentRoundResultTransitionContext()
 * (createActiveRoomFlowController.ts) вече изисква изрично
 * `game.authoritativePhase === 'match-ended'`, не само `matchEnded !== null`.
 *
 * Тестван изцяло на createActiveRoomFlowController ниво (не през main.ts
 * WS routing) — доказва, че самият phase guard решава race-а,
 * независимо от main.ts assignment handler-а (умишлено непроменен в тази
 * задача).
 *
 * Инварианти:
 *  [1] scoring + matchEnded populated, authoritativePhase='scoring':
 *      completePendingTournamentRoundResultTransition() е no-op — scoring
 *      остава видим, никакъв ack, никакъв showLobby.
 *  [2] Същият round, authoritativePhase='match-ended': transition-ът вече
 *      минава нормално (ack + showLobby + enterWaiting) — нормалният
 *      semifinal/inter-round flow продължава непроменен.
 *  [3] Final round: no-op независимо от phase (вече гейтнат от
 *      roundType==='final', непроменено от този fix).
 *  [4] Non-final round, различен от semifinal (quarterfinal): същият guard
 *      важи — fix-ът не е ограничен само до semifinal.
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
  enter: (roomId: string) => Promise<void>
  scoringWithMatchEndedSnapshot: (roomId: string, tournamentId: string, matchId: string, roundType: string, wonRound: boolean) => Promise<any>
  normalMatchEndedSnapshot: (roomId: string, tournamentId: string, matchId: string, roundType: string, wonRound: boolean) => Promise<any>
  snapshot: (message: any) => Promise<void>
  completePendingTournamentRoundResultTransition: () => Promise<boolean>
  scoringCountdownVisible: () => Promise<boolean>
  getAckCalls: () => Promise<Array<{ tournamentId: string; semifinalMatchId: string }>>
  getAckCount: () => Promise<number>
  getEnterWaitingCount: () => Promise<number>
  getShowLobbyCalls: () => Promise<number>
  reset: () => Promise<void>
}

async function harness(page: Page): Promise<H> {
  const w = '__tournamentWalkoverAckHarness'
  return {
    enter: (roomId) => page.evaluate(([k, r]: any) => (window as any)[k].enter(r), [w, roomId] as any),
    scoringWithMatchEndedSnapshot: (roomId, tournamentId, matchId, roundType, wonRound) =>
      page.evaluate(
        ([k, args]: any) => (window as any)[k].scoringWithMatchEndedSnapshot(...args),
        [w, [roomId, tournamentId, matchId, roundType, wonRound]] as any,
      ),
    normalMatchEndedSnapshot: (roomId, tournamentId, matchId, roundType, wonRound) =>
      page.evaluate(
        ([k, args]: any) => (window as any)[k].normalMatchEndedSnapshot(...args),
        [w, [roomId, tournamentId, matchId, roundType, wonRound]] as any,
      ),
    snapshot: (message) => page.evaluate(([k, m]: any) => (window as any)[k].snapshot(m), [w, message] as any),
    completePendingTournamentRoundResultTransition: () =>
      page.evaluate((k: any) => (window as any)[k].completePendingTournamentRoundResultTransition(), w),
    scoringCountdownVisible: () => page.evaluate((k: any) => (window as any)[k].scoringCountdownVisible(), w),
    getAckCalls: () => page.evaluate((k: any) => (window as any)[k].getAckCalls(), w),
    getAckCount: () => page.evaluate((k: any) => (window as any)[k].getAckCount(), w),
    getEnterWaitingCount: () => page.evaluate((k: any) => (window as any)[k].getEnterWaitingCount(), w),
    getShowLobbyCalls: () => page.evaluate((k: any) => (window as any)[k].getShowLobbyCalls(), w),
    reset: () => page.evaluate((k: any) => (window as any)[k].reset(), w),
  }
}

console.log('\n═══ checkTournamentScoringPhaseGuard ═══\n')

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

  await page.goto('/scripts/fixtures/tournamentWalkoverAcknowledgementHarness.html')
  const h = await harness(page)

  // ─── [1] scoring + matchEnded (won semifinal), phase still 'scoring' ───
  await check('[1] won semifinal, matchEnded populated but authoritativePhase still "scoring": transition is a no-op, scoring stays visible', async () => {
    await h.reset()
    await h.enter('room-1')
    const msg = await h.scoringWithMatchEndedSnapshot('room-1', 'tour-1', 'match-1', 'semifinal', true)
    await h.snapshot(msg)
    assert(await h.scoringCountdownVisible(), 'scoring countdown marker трябваше да е видим за authoritativePhase=scoring')
    const transitioned = await h.completePendingTournamentRoundResultTransition()
    assert(transitioned === false, 'completePendingTournamentRoundResultTransition трябваше да върне false, докато authoritativePhase все още е scoring')
    assert((await h.getAckCount()) === 0, 'ack НЕ трябва да е изпратен, докато authoritativePhase все още е scoring')
    assert((await h.getShowLobbyCalls()) === 0, 'showLobby НЕ трябва да е извикан, докато authoritativePhase все още е scoring')
    assert((await h.getEnterWaitingCount()) === 0, 'onEnterWaitingForNextTournamentRound НЕ трябва да е извикан, докато authoritativePhase все още е scoring')
    assert(await h.scoringCountdownVisible(), 'scoring панелът трябваше да остане в DOM-а след no-op transition опита')
  })

  // ─── [2] same round transitions to authoritativePhase='match-ended': normal flow continues ───
  await check('[2] same semifinal round reaches authoritativePhase="match-ended": transition proceeds normally (ack + showLobby + enterWaiting)', async () => {
    const msg = await h.normalMatchEndedSnapshot('room-1', 'tour-1', 'match-1', 'semifinal', true)
    // ВАЖНО: изпращането на самия match-ended snapshot вече тригерира
    // shouldEnterTournamentInterRoundWaitingImmediately() -> transition
    // АВТОМАТИЧНО, вътре в самия render pass на handleServerMessage() —
    // преди explicit-ния completePendingTournamentRoundResultTransition()
    // call изобщо да е изпълнен (точно както main.ts:tournament_match_assigned
    // handler-ът би го извикал допълнително, redundant). Затова първо
    // проверяваме, че normal immediate-transition flow-ът (непроменен от
    // ISSUE 1 fix-а) вече е приключил сам.
    await h.snapshot(msg)
    const calls = await h.getAckCalls()
    assert(calls.length === 1, `очаквах точно 1 ack call (от автоматичния immediate-transition flow), получих ${calls.length}`)
    assert(calls[0].tournamentId === 'tour-1' && calls[0].semifinalMatchId === 'match-1', 'ack трябваше да носи правилните tournamentId/matchId')
    assert((await h.getShowLobbyCalls()) === 1, 'showLobby трябваше да се извика веднъж')
    assert((await h.getEnterWaitingCount()) === 1, 'onEnterWaitingForNextTournamentRound трябваше да се извика веднъж')
    // Explicit-ният call (огледало на main.ts assignment handler-а) трябва
    // да е безопасен idempotent no-op — доказва защита срещу точно
    // redundant-call race сценария от production.
    const transitionedAgain = await h.completePendingTournamentRoundResultTransition()
    assert(transitionedAgain === false, 'втори (explicit) transition опит след вече завършен automatic transition трябваше да е idempotent no-op')
    assert((await h.getAckCount()) === 1, 'explicit-ният повторен call НЕ трябва да изпрати дублиран ack')
  })

  // ─── [3] final round: no-op regardless of phase (unchanged final flow) ───
  await check('[3] final round: transition remains a no-op even with matchEnded populated during scoring (final flow unchanged)', async () => {
    await h.reset()
    await h.enter('room-3')
    const scoringMsg = await h.scoringWithMatchEndedSnapshot('room-3', 'tour-3', 'match-3', 'final', true)
    await h.snapshot(scoringMsg)
    const transitionedDuringScoring = await h.completePendingTournamentRoundResultTransition()
    assert(transitionedDuringScoring === false, 'final round не трябва да transition-ва по този path по време на scoring')
    const endedMsg = await h.normalMatchEndedSnapshot('room-3', 'tour-3', 'match-3', 'final', true)
    await h.snapshot(endedMsg)
    const transitionedAtMatchEnded = await h.completePendingTournamentRoundResultTransition()
    assert(transitionedAtMatchEnded === false, 'final round не трябва да transition-ва по този path дори при authoritativePhase="match-ended" (изключен от roundType==="final")')
    assert((await h.getAckCount()) === 0, 'ack НЕ трябва да е изпратен за final round по този path')
    assert((await h.getShowLobbyCalls()) === 0, 'showLobby НЕ трябва да е извикан за final round по този path')
  })

  // ─── [4] non-final round different from semifinal (quarterfinal): same guard applies ───
  await check('[4] quarterfinal (non-final, not semifinal): same phase guard applies — fix is not semifinal-specific', async () => {
    await h.reset()
    await h.enter('room-4')
    const scoringMsg = await h.scoringWithMatchEndedSnapshot('room-4', 'tour-4', 'match-4', 'quarterfinal', true)
    await h.snapshot(scoringMsg)
    const transitionedDuringScoring = await h.completePendingTournamentRoundResultTransition()
    assert(transitionedDuringScoring === false, 'quarterfinal transition трябваше да е no-op по време на scoring')
    assert((await h.getAckCount()) === 0, 'ack НЕ трябва да е изпратен по време на quarterfinal scoring')

    const endedMsg = await h.normalMatchEndedSnapshot('room-4', 'tour-4', 'match-4', 'quarterfinal', true)
    await h.snapshot(endedMsg)
    // Automatic immediate-transition flow (виж коментара в [2]) — не explicit call.
    const calls = await h.getAckCalls()
    assert(calls.length === 1 && calls[0].tournamentId === 'tour-4' && calls[0].semifinalMatchId === 'match-4', 'quarterfinal ack трябваше да носи правилните ids')
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
