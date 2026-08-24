/**
 * checkTournamentFinalPrizePopup.ts
 *
 * Real browser (Playwright), real production code, real DOM — behavioral
 * regression за champion/runner-up prize popup fix: финалният резултат
 * екран вече чете authoritative `viewer.myPrizeAmount` (tournament detail
 * fetch) вместо `matchEnded.awardedPrizeAmount`, който е structurally null
 * за турнирни стаи (виж payoutMatchWinners exclusion в server/src/index.ts
 * — турнирните стаи никога не минават през room-level match economy
 * payout-а).
 *
 * Retry lifecycle-ът е two-phase bounded (виж loadTournamentFinalResultPrizeInfo
 * в createActiveRoomFlowController.ts):
 *  FAST:  5 опита през 350ms  (покрива синхронния happy-path)
 *  SLOW:  6 допълнителни опита през 2000ms (покрива доказания production
 *         gap — tournamentCoordinator.reconcileSettlementDueTournament
 *         retry-ва pending settlement едва на СЛЕДВАЩИЯ coordinator tick,
 *         DEFAULT_INTERVAL_MS = 5s production / 1s local-test — над
 *         старите 1.75s)
 *  Общо: 1 initial + 5 fast + 6 slow = 12 fetch-а общо, bounded прозорец
 *  ≈ 13.75s, покрива поне два production tick-а (~5s и ~10s).
 *
 * Инварианти:
 *  [1] Champion + settled (immediate): правилно заглавие + authoritative X.
 *  [2] Runner-up + settled (immediate): правилно заглавие + authoritative X.
 *  [3] Success по време на FAST фазата (не веднага): popup се обновява,
 *      SLOW фазата никога не се ангажира.
 *  [4] Delayed settlement ОТВЪД стария 1.75s прозорец (~5.5-6.5s): SLOW
 *      фазата го открива, popup се обновява БЕЗ refresh/navigation. Този
 *      тест FAIL-ва при старата плоска 5×350ms implementation.
 *  [5] Never settles: retry е строго bounded (12 fetch-а общо), спира
 *      окончателно, без infinite polling, popup остава usable.
 *  [6] Напускане на екрана по време на SLOW retry: pending timeout се
 *      cancel-ва, няма late fetch.
 *  [7] Fetch failure (detail fetch резолвва null): popup-ът остава
 *      използваем, "Към турнира" продължава да работи, няма fake сума.
 *  [8] Duplicate/re-render на СЪЩИЯ match: няма дублиран fetch, няма
 *      дублиран popup DOM node.
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
  normalMatchEndedSnapshot: (roomId: string, tournamentId: string, matchId: string, roundType: string, wonRound: boolean) => Promise<any>
  snapshot: (message: any) => Promise<void>
  finalResultScreenVisible: () => Promise<boolean>
  finalResultTitleText: () => Promise<string | null>
  finalResultPrizeText: () => Promise<string | null>
  clickFinalResultContinue: () => Promise<boolean>
  setFetchTournamentDetailQueue: (queue: Array<any>) => Promise<void>
  getFetchTournamentDetailCallCount: () => Promise<number>
  getFinalResultContinueCalls: () => Promise<string[]>
  reset: () => Promise<void>
}

async function harness(page: Page): Promise<H> {
  const w = '__tournamentWalkoverAckHarness'
  return {
    enter: (roomId) => page.evaluate(([k, r]: any) => (window as any)[k].enter(r), [w, roomId] as any),
    normalMatchEndedSnapshot: (roomId, tournamentId, matchId, roundType, wonRound) =>
      page.evaluate(
        ([k, args]: any) => (window as any)[k].normalMatchEndedSnapshot(...args),
        [w, [roomId, tournamentId, matchId, roundType, wonRound]] as any,
      ),
    snapshot: (message) => page.evaluate(([k, m]: any) => (window as any)[k].snapshot(m), [w, message] as any),
    finalResultScreenVisible: () => page.evaluate((k: any) => (window as any)[k].finalResultScreenVisible(), w),
    finalResultTitleText: () => page.evaluate((k: any) => (window as any)[k].finalResultTitleText(), w),
    finalResultPrizeText: () => page.evaluate((k: any) => (window as any)[k].finalResultPrizeText(), w),
    clickFinalResultContinue: () => page.evaluate((k: any) => (window as any)[k].clickFinalResultContinue(), w),
    setFetchTournamentDetailQueue: (queue) =>
      page.evaluate(([k, q]: any) => (window as any)[k].setFetchTournamentDetailQueue(q), [w, queue] as any),
    getFetchTournamentDetailCallCount: () => page.evaluate((k: any) => (window as any)[k].getFetchTournamentDetailCallCount(), w),
    getFinalResultContinueCalls: () => page.evaluate((k: any) => (window as any)[k].getFinalResultContinueCalls(), w),
    reset: () => page.evaluate((k: any) => (window as any)[k].reset(), w),
  }
}

async function formatBgAmount(page: Page, amount: number): Promise<string> {
  // Изчислен В САМИЯ браузър (не в Node), за да съвпадне точно с
  // toLocaleString('bg-BG') резултата, който production кодът реално
  // произвежда — избягва ICU разлики между Node/tsx и Chromium.
  return page.evaluate((n: number) => n.toLocaleString('bg-BG'), amount)
}

function nullPrizeResponse() {
  return { viewer: { myPrizeAmount: null } }
}

console.log('\n═══ checkTournamentFinalPrizePopup ═══\n')

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

  // ─── [1] Champion + settled (immediate) ─────────────────────────────────
  await check('[1] champion + settled: правилно заглавие и "Награда: +X жълтици" с точната authoritative сума', async () => {
    await h.reset()
    await h.setFetchTournamentDetailQueue([{ viewer: { myPrizeAmount: 20800 } }])
    await h.enter('room-1')
    const msg = await h.normalMatchEndedSnapshot('room-1', 'tour-1', 'match-1', 'final', true)
    await h.snapshot(msg)
    assert(await h.finalResultScreenVisible(), 'final result screen трябваше да е видим')
    await page.waitForFunction(
      (k: any) => (window as any)[k].finalResultPrizeText()?.includes('+'),
      '__tournamentWalkoverAckHarness',
      { timeout: 3000 },
    )
    assert((await h.finalResultTitleText()) === 'Вие спечелихте турнира!', `грешно champion заглавие: ${await h.finalResultTitleText()}`)
    const expectedAmount = await formatBgAmount(page, 20800)
    assert((await h.finalResultPrizeText()) === `Награда: +${expectedAmount} жълтици`, `грешен champion prize текст: ${await h.finalResultPrizeText()}`)
    assert((await h.getFetchTournamentDetailCallCount()) === 1, `immediate success трябваше да отнеме точно 1 fetch, получих ${await h.getFetchTournamentDetailCallCount()}`)
  })

  // ─── [2] Runner-up + settled (immediate) ────────────────────────────────
  await check('[2] runner-up + settled: "Класирахте се на второ място!" + правилната authoritative сума', async () => {
    await h.reset()
    await h.setFetchTournamentDetailQueue([{ viewer: { myPrizeAmount: 11200 } }])
    await h.enter('room-2')
    const msg = await h.normalMatchEndedSnapshot('room-2', 'tour-2', 'match-2', 'final', false)
    await h.snapshot(msg)
    await page.waitForFunction(
      (k: any) => (window as any)[k].finalResultPrizeText()?.includes('+'),
      '__tournamentWalkoverAckHarness',
      { timeout: 3000 },
    )
    assert((await h.finalResultTitleText()) === 'Класирахте се на второ място!', `грешно runner-up заглавие: ${await h.finalResultTitleText()}`)
    const expectedAmount = await formatBgAmount(page, 11200)
    assert((await h.finalResultPrizeText()) === `Награда: +${expectedAmount} жълтици`, `грешен runner-up prize текст: ${await h.finalResultPrizeText()}`)
  })

  // ─── [3] D. Success по време на FAST фазата (не веднага) ────────────────
  await check('[3] success по време на FAST retry фазата (3 null + сума на 4-тия fetch): popup се обновява, SLOW фазата не се ангажира', async () => {
    await h.reset()
    await h.setFetchTournamentDetailQueue([nullPrizeResponse(), nullPrizeResponse(), nullPrizeResponse(), { viewer: { myPrizeAmount: 20800 } }])
    await h.enter('room-3')
    const msg = await h.normalMatchEndedSnapshot('room-3', 'tour-3', 'match-3', 'final', true)
    await h.snapshot(msg)
    await page.waitForFunction(
      (k: any) => (window as any)[k].finalResultPrizeText()?.includes('+'),
      '__tournamentWalkoverAckHarness',
      { timeout: 3000 },
    )
    const expectedAmount = await formatBgAmount(page, 20800)
    assert((await h.finalResultPrizeText()) === `Награда: +${expectedAmount} жълтици`, `очаквах сумата да се появи във FAST фазата, получих: ${await h.finalResultPrizeText()}`)
    assert((await h.getFetchTournamentDetailCallCount()) === 4, `очаквах точно 4 fetch-а (в рамките на FAST фазата, макс. 6), получих ${await h.getFetchTournamentDetailCallCount()}`)
    // Изчакай отвъд мястото, където FAST фазата приключва (~1.75s) — не
    // трябва да последва допълнителен fetch след успешния resolve.
    await page.waitForTimeout(2500)
    assert((await h.getFetchTournamentDetailCallCount()) === 4, 'SLOW фазата не трябваше да се ангажира след успешен resolve във FAST фазата')
  })

  // ─── [4] A. Delayed settlement отвъд стария 1.75s прозорец ──────────────
  await check('[4] A. delayed settlement на ~5.5-6.5s (отвъд стария 1.75s прозорец): SLOW фазата го открива, popup се обновява БЕЗ refresh', async () => {
    await h.reset()
    // 7 null отговора покриват: 1 initial + 5 FAST retry + 1-ви SLOW retry
    // (fetch #7, ~3.75s) — settlement все още pending там. 8-ият fetch
    // (2-ри SLOW retry, ~5.75s) вече връща сумата.
    const nulls = Array.from({ length: 7 }, () => nullPrizeResponse())
    await h.setFetchTournamentDetailQueue([...nulls, { viewer: { myPrizeAmount: 20800 } }])
    await h.enter('room-4')
    const msg = await h.normalMatchEndedSnapshot('room-4', 'tour-4', 'match-4', 'final', true)
    await h.snapshot(msg)
    assert((await h.finalResultPrizeText()) === 'Наградата се обработва.', 'първоначално трябваше да е pending')
    // Доказателство, че старият 5×350ms=1.75s прозорец вече е изчерпан на
    // тази точка, но popup-ът ОЩЕ чака — SLOW фазата продължава да опитва.
    await page.waitForTimeout(2200)
    assert((await h.finalResultPrizeText()) === 'Наградата се обработва.', 'на ~2.2s (отвъд стария прозорец) все още трябва да е pending — SLOW фазата поема')
    await page.waitForFunction(
      (k: any) => (window as any)[k].finalResultPrizeText()?.includes('+'),
      '__tournamentWalkoverAckHarness',
      { timeout: 6000 },
    )
    const expectedAmount = await formatBgAmount(page, 20800)
    assert((await h.finalResultPrizeText()) === `Награда: +${expectedAmount} жълтици`, `очаквах SLOW retry да открие сумата, получих: ${await h.finalResultPrizeText()}`)
    assert((await h.getFetchTournamentDetailCallCount()) === 8, `очаквах точно 8-ия fetch (2-ри SLOW опит, ~5.75s) да открие сумата, получих ${await h.getFetchTournamentDetailCallCount()}`)
  })

  // ─── [5] B. Never settles — bounded, без infinite polling ───────────────
  await check('[5] B. never settles: retry е строго bounded (12 fetch-а общо), спира окончателно, popup остава usable', async () => {
    await h.reset()
    await h.setFetchTournamentDetailQueue([nullPrizeResponse()])
    await h.enter('room-5')
    const msg = await h.normalMatchEndedSnapshot('room-5', 'tour-5', 'match-5', 'final', true)
    await h.snapshot(msg)
    // Целият bounded бюджет: 1 initial + 5×350ms (FAST) + 6×2000ms (SLOW)
    // = 12 fetch-а общо, ≈13.75s.
    await page.waitForFunction(
      (k: any) => (window as any)[k].getFetchTournamentDetailCallCount() >= 12,
      '__tournamentWalkoverAckHarness',
      { timeout: 16000 },
    )
    assert((await h.getFetchTournamentDetailCallCount()) === 12, `очаквах точно 12 общо fetch-а (1 initial + 5 FAST + 6 SLOW), получих ${await h.getFetchTournamentDetailCallCount()}`)
    assert((await h.finalResultPrizeText()) === 'Наградата се обработва.', 'без settlement popup-ът трябва да остане на pending текста')
    // Допълнителна проверка за bounded-ност: изчакай отвъд мястото, където
    // 13-ти fetch би паднал, ако retry логиката НЕ спираше окончателно.
    await page.waitForTimeout(3000)
    assert((await h.getFetchTournamentDetailCallCount()) === 12, 'не трябва да има 13-ти fetch — retry-то трябва да е строго bounded, без infinite polling')
    assert(await h.finalResultScreenVisible(), 'popup-ът трябва да остане видим/usable след изчерпване на целия retry бюджет')
    const clicked = await h.clickFinalResultContinue()
    assert(clicked, '"Към турнира" трябва да продължи да работи дори след пълно изчерпване на retry бюджета')
  })

  // ─── [6] C. Напускане на екрана по време на SLOW retry ──────────────────
  await check('[6] C. напускане на final result screen по време на SLOW retry: pending timeout се cancel-ва, няма late fetch', async () => {
    await h.reset()
    await h.setFetchTournamentDetailQueue([nullPrizeResponse()])
    await h.enter('room-6')
    const msg = await h.normalMatchEndedSnapshot('room-6', 'tour-6', 'match-6', 'final', true)
    await h.snapshot(msg)
    // Изчакай точно до 1-вия SLOW retry (7-ми fetch общо, ~3.75s), но
    // ПРЕДИ 2-рия SLOW retry (8-ми fetch, ~5.75s).
    await page.waitForFunction(
      (k: any) => (window as any)[k].getFetchTournamentDetailCallCount() >= 7,
      '__tournamentWalkoverAckHarness',
      { timeout: 6000 },
    )
    const callCountBeforeLeave = await h.getFetchTournamentDetailCallCount()
    assert(callCountBeforeLeave === 7, `очаквах точно 7 fetch-а преди напускане, получих ${callCountBeforeLeave}`)
    const clicked = await h.clickFinalResultContinue()
    assert(clicked, '"Към турнира" трябваше да е кликаем по време на SLOW фазата')
    // Изчакай отвъд мястото, където 2-рия SLOW retry (8-ми fetch) щеше да
    // падне, ако pending timeout-ът не беше cancel-нат при напускането.
    await page.waitForTimeout(3000)
    assert((await h.getFetchTournamentDetailCallCount()) === callCountBeforeLeave, 'pending SLOW retry timeout трябваше да е cancel-нат при напускане на екрана — не трябва да има късен fetch')
    const calls = await h.getFinalResultContinueCalls()
    assert(calls.length === 1 && calls[0] === 'tour-6', '"Към турнира" трябваше да извика continue callback-а с правилния tournamentId')
  })

  // ─── [7] Fetch failure: popup остава използваем ─────────────────────────
  await check('[7] fetch failure (detail === null): popup остава видим, "Към турнира" работи, няма fake сума', async () => {
    await h.reset()
    await h.setFetchTournamentDetailQueue([]) // празна опашка -> винаги null
    await h.enter('room-7')
    const msg = await h.normalMatchEndedSnapshot('room-7', 'tour-7', 'match-7', 'final', true)
    await h.snapshot(msg)
    await page.waitForTimeout(2500)
    assert(await h.finalResultScreenVisible(), 'final result screen трябваше да остане видим при fetch failure')
    assert((await h.finalResultPrizeText()) === 'Наградата се обработва.', 'при fetch failure не трябва да се показва fake сума')
    const clicked = await h.clickFinalResultContinue()
    assert(clicked, '"Към турнира" бутонът трябваше да е кликаем дори при fetch failure')
    const calls = await h.getFinalResultContinueCalls()
    assert(calls.length === 1 && calls[0] === 'tour-7', '"Към турнира" трябваше да извика continue callback-а с правилния tournamentId')
  })

  // ─── [8] Duplicate/re-render на същия match: без дублиране ──────────────
  await check('[8] повторен snapshot/render на СЪЩИЯ match: няма дублиран fetch, няма дублиран popup DOM node', async () => {
    await h.reset()
    await h.setFetchTournamentDetailQueue([{ viewer: { myPrizeAmount: 20800 } }])
    await h.enter('room-8')
    const msg = await h.normalMatchEndedSnapshot('room-8', 'tour-8', 'match-8', 'final', true)
    await h.snapshot(msg)
    await page.waitForFunction(
      (k: any) => (window as any)[k].finalResultPrizeText()?.includes('+'),
      '__tournamentWalkoverAckHarness',
      { timeout: 3000 },
    )
    const callCountAfterFirst = await h.getFetchTournamentDetailCallCount()
    // Изпращаме ИДЕНТИЧЕН snapshot повторно (симулира redundant WS push /
    // re-render за същия вече-известен match) — не трябва да причини нов
    // fetch, нито дублиран DOM node.
    await h.snapshot(msg)
    await h.snapshot(msg)
    const callCountAfterDuplicates = await h.getFetchTournamentDetailCallCount()
    assert(callCountAfterDuplicates === callCountAfterFirst, `повторни snapshot-и за същия match причиниха нов fetch: ${callCountAfterFirst} -> ${callCountAfterDuplicates}`)
    const nodeCount = await page.evaluate(() => document.querySelectorAll('[data-tournament-final-result-detail]').length)
    assert(nodeCount === 1, `очаквах точно 1 "Към турнира" DOM node, получих ${nodeCount}`)
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
