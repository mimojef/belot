/**
 * checkTournamentWalkoverAcknowledgement.ts
 *
 * Real browser (Playwright), real production code, real DOM — behavioral
 * regression за DELTA walkover acknowledgement bug-а: човешки финалист,
 * спечелил semifinal чрез walkover, никога не изпращаше
 * tournament_semifinal_result_acknowledge, защото
 * getTournamentRoundResultTransitionContext() изисква реален
 * activeRoomState.game?.matchEnded snapshot — а при walkover room.game.phase
 * остава 'bootstrap' завинаги. Walkover екранът живееше в напълно отделен
 * render клон (createActiveRoomFlowController.ts, "Към турнира" бутон), без
 * никаква връзка към acknowledgeTournamentSemifinalResult — нито ръчно, нито
 * през auto-transition таймера (какъвто walkover изобщо нямаше).
 *
 * Fix: completeTournamentWalkoverTransition/
 * ensureTournamentWalkoverAutoTransitionTimer/
 * acknowledgeTournamentSemifinalWalkoverIfNeeded — споделен helper между
 * ръчния click и нов walkover-specific auto-transition таймер (огледало на
 * съществуващия completeTournamentRoundResultTransition/
 * ensureTournamentRoundResultAutoTransitionTimer pattern за нормалния path).
 *
 * Инварианти, тествани тук:
 *  [1] semifinal walkover WIN + ръчен click "Към турнира": ack се изпраща.
 *  [2] semifinal walkover WIN + auto-transition (без click): ack се изпраща.
 *  [3] semifinal walkover LOSS: ack НЕ се изпраща.
 *  [4] final walkover WIN: semifinal ack НЕ се изпраща (не е semifinal).
 *  [5] manual click + auto-timer race: ack се изпраща точно ВЕДНЪЖ (idempotent).
 *  [6] нормален (не-walkover) spechelen semifinal: старият
 *      completeTournamentRoundResultTransition path продължава да работи
 *      непроменен.
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
  walkoverSnapshot: (roomId: string, tournamentId: string, matchId: string, roundType: string, wonByWalkover: boolean) => Promise<any>
  playingSnapshot: (roomId: string, tournamentId: string, matchId: string, roundType: string) => Promise<any>
  normalMatchEndedSnapshot: (roomId: string, tournamentId: string, matchId: string, roundType: string, wonRound: boolean) => Promise<any>
  snapshot: (message: any) => Promise<void>
  render: () => Promise<void>
  walkoverContinueButtonExists: () => Promise<boolean>
  clickWalkoverContinue: () => Promise<boolean>
  roundResultLobbyButtonExists: () => Promise<boolean>
  clickRoundResultLobby: () => Promise<boolean>
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
    walkoverSnapshot: (roomId, tournamentId, matchId, roundType, wonByWalkover) =>
      page.evaluate(
        ([k, args]: any) => (window as any)[k].walkoverSnapshot(...args),
        [w, [roomId, tournamentId, matchId, roundType, wonByWalkover]] as any,
      ),
    playingSnapshot: (roomId, tournamentId, matchId, roundType) =>
      page.evaluate(
        ([k, args]: any) => (window as any)[k].playingSnapshot(...args),
        [w, [roomId, tournamentId, matchId, roundType]] as any,
      ),
    normalMatchEndedSnapshot: (roomId, tournamentId, matchId, roundType, wonRound) =>
      page.evaluate(
        ([k, args]: any) => (window as any)[k].normalMatchEndedSnapshot(...args),
        [w, [roomId, tournamentId, matchId, roundType, wonRound]] as any,
      ),
    snapshot: (message) => page.evaluate(([k, m]: any) => (window as any)[k].snapshot(m), [w, message] as any),
    render: () => page.evaluate((k: any) => (window as any)[k].render(), w),
    walkoverContinueButtonExists: () => page.evaluate((k: any) => (window as any)[k].walkoverContinueButtonExists(), w),
    clickWalkoverContinue: () => page.evaluate((k: any) => (window as any)[k].clickWalkoverContinue(), w),
    roundResultLobbyButtonExists: () => page.evaluate((k: any) => (window as any)[k].roundResultLobbyButtonExists(), w),
    clickRoundResultLobby: () => page.evaluate((k: any) => (window as any)[k].clickRoundResultLobby(), w),
    getAckCalls: () => page.evaluate((k: any) => (window as any)[k].getAckCalls(), w),
    getAckCount: () => page.evaluate((k: any) => (window as any)[k].getAckCount(), w),
    getEnterWaitingCount: () => page.evaluate((k: any) => (window as any)[k].getEnterWaitingCount(), w),
    getShowLobbyCalls: () => page.evaluate((k: any) => (window as any)[k].getShowLobbyCalls(), w),
    reset: () => page.evaluate((k: any) => (window as any)[k].reset(), w),
  }
}

const AUTO_TRANSITION_WAIT_MS = 2_900 // TOURNAMENT_ROUND_RESULT_AUTO_TRANSITION_MS (2500) + буфер

console.log('\n═══ checkTournamentWalkoverAcknowledgement ═══\n')

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

  // ─── [1] semifinal walkover WIN + ръчен click "Към турнира" ────────────
  await check('[1] semifinal walkover WIN + manual "Към турнира": acknowledgement се изпраща', async () => {
    await h.reset()
    await h.enter('room-1')
    const msg = await h.walkoverSnapshot('room-1', 'tour-1', 'match-1', 'semifinal', true)
    await h.snapshot(msg)
    assert(await h.walkoverContinueButtonExists(), 'walkover continue бутонът трябваше да съществува')
    assert((await h.getAckCount()) === 0, 'ack не трябва да е изпратен преди click')
    const clicked = await h.clickWalkoverContinue()
    assert(clicked, 'click върху "Към турнира" трябваше да успее')
    const calls = await h.getAckCalls()
    assert(calls.length === 1, `очаквах точно 1 ack call, получих ${calls.length}`)
    assert(calls[0].tournamentId === 'tour-1' && calls[0].semifinalMatchId === 'match-1', 'ack трябваше да носи правилните tournamentId/matchId')
    assert((await h.getEnterWaitingCount()) === 1, 'onEnterWaitingForNextTournamentRound трябваше да се извика веднъж')
  })

  // ─── [2] semifinal walkover WIN + auto-transition (без click) ──────────
  await check('[2] semifinal walkover WIN + auto-transition (без ръчен click): acknowledgement се изпраща автоматично', async () => {
    await h.reset()
    await h.enter('room-2')
    const msg = await h.walkoverSnapshot('room-2', 'tour-2', 'match-2', 'semifinal', true)
    await h.snapshot(msg)
    assert(await h.walkoverContinueButtonExists(), 'walkover continue бутонът трябваше да съществува')
    assert((await h.getAckCount()) === 0, 'ack не трябва да е изпратен веднага след render')
    await page.waitForTimeout(AUTO_TRANSITION_WAIT_MS)
    const calls = await h.getAckCalls()
    assert(calls.length === 1, `auto-transition трябваше да изпрати точно 1 ack, получих ${calls.length}`)
    assert(calls[0].tournamentId === 'tour-2' && calls[0].semifinalMatchId === 'match-2', 'auto-transition ack трябваше да носи правилните ids')
    assert((await h.getEnterWaitingCount()) === 1, 'auto-transition трябваше да извика onEnterWaitingForNextTournamentRound')
  })

  // ─── [3] semifinal walkover LOSS ────────────────────────────────────────
  await check('[3] semifinal walkover LOSS: acknowledgement НЕ се изпраща', async () => {
    await h.reset()
    await h.enter('room-3')
    const msg = await h.walkoverSnapshot('room-3', 'tour-3', 'match-3', 'semifinal', false)
    await h.snapshot(msg)
    // Без auto-transition таймер при загуба — изчакваме отвъд auto-transition
    // прозореца, за да докажем, че НИЩО не се изпраща автоматично.
    await page.waitForTimeout(AUTO_TRANSITION_WAIT_MS)
    assert((await h.getAckCount()) === 0, 'ack НЕ трябва да е изпратен за loss дори след auto-transition прозореца')
    assert((await h.getEnterWaitingCount()) === 0, 'onEnterWaitingForNextTournamentRound НЕ трябва да се вика за loss')
    const clicked = await h.clickWalkoverContinue()
    assert(clicked, 'ръчният "Към лобито" click при loss трябваше да успее')
    assert((await h.getAckCount()) === 0, 'ack НЕ трябва да е изпратен и след ръчния click при loss')
  })

  // ─── [4] final walkover WIN ──────────────────────────────────────────────
  await check('[4] final walkover WIN: semifinal acknowledgement НЕ се изпраща (не е semifinal)', async () => {
    await h.reset()
    await h.enter('room-4')
    const msg = await h.walkoverSnapshot('room-4', 'tour-4', 'match-4', 'final', true)
    await h.snapshot(msg)
    await page.waitForTimeout(AUTO_TRANSITION_WAIT_MS)
    assert((await h.getAckCount()) === 0, 'final walkover не трябва да изпраща semifinal ack дори след auto-transition прозореца')
    const clicked = await h.clickWalkoverContinue()
    assert(clicked, 'ръчният "Към турнира" click при final walkover трябваше да успее')
    assert((await h.getAckCount()) === 0, 'ack НЕ трябва да е изпратен и след ръчния click при final walkover')
    assert((await h.getEnterWaitingCount()) === 0, 'onEnterWaitingForNextTournamentRound НЕ трябва да се вика за final walkover')
  })

  // ─── [5] manual click + auto-timer race ─────────────────────────────────
  await check('[5] manual click + auto-transition race: acknowledgement се изпраща точно ВЕДНЪЖ (idempotent)', async () => {
    await h.reset()
    await h.enter('room-5')
    const msg = await h.walkoverSnapshot('room-5', 'tour-5', 'match-5', 'semifinal', true)
    await h.snapshot(msg)
    // Ръчен click веднага (преди auto-timer-а да е изтекъл) — трябва да
    // спечели race-а и да маркира transition-а като completed чрез споделения
    // tournamentRoundResultCompletedTransitionKey guard.
    const clicked = await h.clickWalkoverContinue()
    assert(clicked, 'ръчният click трябваше да успее')
    // Изчакваме отвъд auto-transition прозореца — ако таймерът все още беше
    // жив (не clear-нат от completeTournamentWalkoverTransition), той би
    // изпратил ВТОРИ ack тук.
    await page.waitForTimeout(AUTO_TRANSITION_WAIT_MS)
    const calls = await h.getAckCalls()
    assert(calls.length === 1, `race между manual click и auto-timer трябваше да даде точно 1 ack, получих ${calls.length}`)
    assert((await h.getEnterWaitingCount()) === 1, 'onEnterWaitingForNextTournamentRound трябваше да се извика точно веднъж под race')
  })

  // ─── [6] нормален (не-walkover) spechelen semifinal остава непроменен ──
  // completeTournamentRoundResultTransition (НЕПРОМЕНЕНА функция) вика
  // shouldEnterTournamentInterRoundWaitingImmediately() -> за пресен, реален
  // matchEnded win, transition-ът е МИГНОВЕН на самия render (без нужда от
  // ръчен click/auto-timer изчакване — за разлика от walkover, който няма
  // реален matchEnded snapshot и затова изобщо не влиза в тази immediate
  // логика). Доказваме, че СТАРИЯТ path продължава да го прави автоматично,
  // без промяна от walkover fix-а.
  await check('[6] нормален spechelen semifinal (не walkover): старият acknowledgement path продължава да работи', async () => {
    await h.reset()
    await h.enter('room-6')
    await h.snapshot(await h.playingSnapshot('room-6', 'tour-6', 'match-6', 'semifinal'))
    assert((await h.getAckCount()) === 0, 'ack не трябва да е изпратен преди matchEnded snapshot-а')
    const msg = await h.normalMatchEndedSnapshot('room-6', 'tour-6', 'match-6', 'semifinal', true)
    await h.snapshot(msg)
    const calls = await h.getAckCalls()
    assert(calls.length === 1, `нормалният path трябваше да изпрати точно 1 ack на самия matchEnded snapshot, получих ${calls.length}`)
    assert(calls[0].tournamentId === 'tour-6' && calls[0].semifinalMatchId === 'match-6', 'нормалният ack трябваше да носи правилните ids')
    assert((await h.getEnterWaitingCount()) === 1, 'onEnterWaitingForNextTournamentRound трябваше да се извика веднъж')
    assert((await h.getShowLobbyCalls()) >= 1, 'showLobby (returnToLobbyFromMatchEnded) трябваше да се извика')
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
