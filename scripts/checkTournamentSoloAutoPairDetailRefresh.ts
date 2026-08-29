/**
 * checkTournamentSoloAutoPairDetailRefresh.ts
 *
 * Real browser (Playwright), real production code, real DOM — regression for
 * the "solo auto-pair saves to DB but the tournament detail UI doesn't update
 * immediately" bug.
 *
 * ROOT CAUSE (proven, not assumed): submitTournamentJoin()'s success path
 * (createLobbyFlowController.ts) only called mergeTournamentSummaryIntoDetail
 * (result.tournament) — and POST /api/tournaments/:id/join only ever returns
 * a TournamentSummaryDto (buildTournamentSummaryDto), never the full
 * TournamentDetailDto. mergeTournamentSummaryIntoDetail is a shallow spread:
 * it correctly refreshes summary fields (counters/status/viewer) but
 * detail-only fields — teams, myTeam — don't exist on the summary and so
 * survive untouched from the stale pre-join fetch. That's why the waiting
 * "Отбор A / ИЗЧАКВА ПАРТНЬОР" card and "Записан си самостоятелно" stayed on
 * screen even though the server had already auto-paired the two players.
 *
 * This is the EXACT same bug class already diagnosed and fixed once for
 * submitTournamentLeave (see its "КРИТИЧНО: ПРОВЕРИ OWN-LEAVE SUCCESS PATH"
 * comment) — just never applied to the join flow.
 *
 * FIX (targeted patch, reusing the canonical helper, no new state model): a
 * single `void fetchTournamentDetail(tournamentId)` call added right after
 * mergeTournamentSummaryIntoDetail in submitTournamentJoin's success path —
 * the exact same authoritative full-detail refetch already used by
 * submitTournamentLeave, submitTournamentPartnerInvite, and
 * respondTournamentPartnerInvite.
 *
 * This test drives the REAL createLobbyFlowController + REAL DOM through a
 * fixture harness (scripts/fixtures/tournamentSoloAutoPairDetailRefreshHarness.ts):
 * loads a tournament detail showing Mimo alone/waiting, clicks the real
 * "Запиши се сам" -> confirm flow, and asserts the on-screen result reflects
 * the auto-paired ready team WITHOUT any navigation/reload — only what the
 * canonical fetchTournamentDetail reconciliation produces.
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
  flush: () => Promise<void>
  clickJoinOpen: () => Promise<void>
  clickJoinSubmit: () => Promise<void>
  getRootText: () => Promise<string>
  getDetailLoadCallCount: () => Promise<number>
  getJoinCallCount: () => Promise<number>
  getCurrentScreen: () => Promise<string>
  getNavigateToTournamentDetailCallCount: () => Promise<number>
  getLoadMarker: () => Promise<string>
}

async function harness(page: Page): Promise<H> {
  const w = '__tournamentSoloAutoPairDetailRefreshHarness'
  return {
    flush: () => page.evaluate((k: any) => (window as any)[k].flush(), w),
    clickJoinOpen: () => page.evaluate((k: any) => (window as any)[k].clickJoinOpen(), w),
    clickJoinSubmit: () => page.evaluate((k: any) => (window as any)[k].clickJoinSubmit(), w),
    getRootText: () => page.evaluate((k: any) => (window as any)[k].getRootText(), w),
    getDetailLoadCallCount: () => page.evaluate((k: any) => (window as any)[k].getDetailLoadCallCount(), w),
    getJoinCallCount: () => page.evaluate((k: any) => (window as any)[k].getJoinCallCount(), w),
    getCurrentScreen: () => page.evaluate((k: any) => (window as any)[k].getCurrentScreen(), w),
    getNavigateToTournamentDetailCallCount: () => page.evaluate((k: any) => (window as any)[k].getNavigateToTournamentDetailCallCount(), w),
    getLoadMarker: () => page.evaluate((k: any) => (window as any)[k].getLoadMarker(), w),
  }
}

type WaitingH = {
  flush: () => Promise<void>
  getRootText: () => Promise<string>
  getDetailLoadCallCount: () => Promise<number>
  getCurrentScreen: () => Promise<string>
  simulateTeamUpdatedPush: (tournamentId: string) => Promise<void>
}

async function waitingHarness(page: Page): Promise<WaitingH> {
  const w = '__tournamentSoloAutoPairWaitingClientHarness'
  return {
    flush: () => page.evaluate((k: any) => (window as any)[k].flush(), w),
    getRootText: () => page.evaluate((k: any) => (window as any)[k].getRootText(), w),
    getDetailLoadCallCount: () => page.evaluate((k: any) => (window as any)[k].getDetailLoadCallCount(), w),
    getCurrentScreen: () => page.evaluate((k: any) => (window as any)[k].getCurrentScreen(), w),
    simulateTeamUpdatedPush: (tournamentId) => page.evaluate(([k, t]: any) => (window as any)[k].simulateTeamUpdatedPush(t), [w, tournamentId] as any),
  }
}

console.log('\n═══ checkTournamentSoloAutoPairDetailRefresh ═══\n')

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

  const context = await browser.newContext({ baseURL: baseUrl, viewport: { width: 480, height: 900 } })
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', (err) => errors.push(err.message))

  await page.goto('/scripts/fixtures/tournamentSoloAutoPairDetailRefreshHarness.html')
  const h = await harness(page)
  await h.flush()

  await check('[setup] initial detail load shows Mimo alone, waiting for a partner', async () => {
    assert((await h.getDetailLoadCallCount()) === 1, 'expected exactly 1 initial detail load')
    const text = await h.getRootText()
    assert(text.includes('Mimo'), 'expected Mimo to be visible in the waiting team card')
    assert(text.includes('Изчаква партньор'), 'expected the waiting label before joining')
    assert(text.includes('Запиши се сам'), 'expected the solo-join entry button to be visible')
  })

  await check('[A] clicking "Запиши се сам" -> confirm triggers the join call', async () => {
    await h.clickJoinOpen()
    await h.flush()
    await h.clickJoinSubmit()
    await h.flush()
    assert((await h.getJoinCallCount()) === 1, 'expected exactly 1 join call')
  })

  await check('[B] BLOCKER: detail state reconciles immediately after a successful auto-pair join — no navigation/reload needed', async () => {
    // The canonical reconciliation this bug required: an authoritative
    // detail refetch after the join resolves, same helper as leave/invite.
    assert((await h.getDetailLoadCallCount()) === 2, `expected the join success path to trigger exactly one additional detail refetch (canonical fetchTournamentDetail), got ${await h.getDetailLoadCallCount()} total loads`)

    const text = await h.getRootText()
    assert(text.includes('Mimo'), 'expected Mimo to still be visible, now in the ready team')
    assert(text.includes('Me'), 'expected the joining player ("Me") to be visible in the SAME team card')
    assert(!text.includes('Изчаква партньор'), 'the "waiting for partner" label must be gone once the team is complete')
    assert(text.includes('Готов отбор'), 'the team card must show the ready/complete label')
    assert(text.includes('Отборът ти е готов'), 'own participation status must say the team is ready, not "Записан си самостоятелно"')
    assert(!text.includes('Записан си самостоятелно'), 'stale "joined solo, still waiting" own-status text must not remain on screen')
  })

  await check('[C] no navigation/reload was used to achieve the reconciliation', async () => {
    assert((await h.getNavigateToTournamentDetailCallCount()) === 1, 'navigateToTournamentDetail must be called exactly once (initial load only) — the fix must not re-navigate')
    assert((await h.getCurrentScreen()) === 'tournament-detail', 'must still be on the tournament-detail screen')
    assert((await h.getLoadMarker()) === 'still-the-same-page', 'the page must never have reloaded (window.location.reload or similar)')
  })

  const wh = await waitingHarness(page)
  await wh.flush()

  await check('[E] setup: waiting player (Mimo\'s own screen) starts on their lone forming team', async () => {
    assert((await wh.getDetailLoadCallCount()) === 1, 'expected exactly 1 initial detail load for the waiting player')
    const text = await wh.getRootText()
    assert(text.includes('Изчаква партньор'), 'expected the waiting label on the waiting player\'s own screen')
    assert(!text.includes('Готов отбор'), 'must not show ready yet')
  })

  await check('[F] REALTIME BLOCKER: a tournament_team_updated push for a DIFFERENT tournament is a no-op (proves no false/misdirected refetch)', async () => {
    await wh.simulateTeamUpdatedPush('some-other-tournament-id')
    await wh.flush()
    assert((await wh.getDetailLoadCallCount()) === 1, 'a push for a different tournamentId must not trigger a refetch of the one being viewed')
  })

  await check('[G] REALTIME BLOCKER: the waiting player sees the ready team immediately once the real tournament_team_updated push arrives — no click, no navigation, no reload', async () => {
    // Must match the harness's internal `tournamentId` const
    // (tournamentSoloAutoPairDetailRefreshHarness.ts) — the two live in
    // separate JS realms (Node driver vs browser page), so it can't be
    // imported/shared and is intentionally duplicated here.
    await wh.simulateTeamUpdatedPush('tour-auto-pair-1')
    await wh.flush()
    assert((await wh.getDetailLoadCallCount()) === 2, `expected exactly one additional detail refetch triggered by the push, got ${await wh.getDetailLoadCallCount()} total loads`)
    const text = await wh.getRootText()
    assert(text.includes('Готов отбор'), 'waiting player must now see the ready/complete team label')
    assert(text.includes('Отборът ти е готов'), 'waiting player\'s own status must say the team is ready')
    assert(!text.includes('Изчаква партньор'), 'the waiting label must be gone')
    assert((await wh.getCurrentScreen()) === 'tournament-detail', 'must still be on the tournament-detail screen (no navigation)')
  })

  await check('[D] no page errors were thrown during the whole flow', () => {
    assert(errors.length === 0, `page errors: ${errors.join('; ')}`)
  })
} finally {
  try { await browser?.close() } catch {}
  try { await vite?.close() } catch {}
}

console.log(`\ncheckTournamentSoloAutoPairDetailRefresh: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
