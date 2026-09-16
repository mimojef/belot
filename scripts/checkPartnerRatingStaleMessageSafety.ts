/**
 * checkPartnerRatingStaleMessageSafety.ts
 *
 * Real browser (Playwright), REAL createActiveRoomFlowController() (via
 * scripts/fixtures/partnerRatingStaleMessageHarness.ts) — доказва че
 * закъснял/stale partner_rating_result за ЕДИН submit не може да промени
 * matchEndedPartnerRatingState на ДРУГ (текущ) submit, дори когато и двата
 * submit-а са в СЪЩАТА стая (roomId непроменен между Match 1 и Match 2,
 * replay).
 *
 * КРИТИЧЕН RACE (explicit repro потвърди го е реален ПРЕДИ requestId fix-а):
 *   1. Room A / Match 1: submit partner rating -> request стига до server,
 *      response СЕ ЗАБАВЯ (никога не пристига навреме).
 *   2. Replay -> Match 2 в СЪЩАТА стая (roomId непроменен). Rating state
 *      правилно reset-ва на 'idle' (matchEndedPartnerRatingMatchKey fix от
 *      предишния audit).
 *   3. User submit-ва rating за Match 2 -> state става 'submitting'.
 *   4. СЕГА пристига закъснелият Match 1 partner_rating_result.
 *   5. С roomId-only guard (предишна версия): message.roomId ===
 *      activeRoomState.roomId (ДА, същата стая) И
 *      matchEndedPartnerRatingState === 'submitting' (ДА, Match 2 чака) ->
 *      guard-ът МИНАВА -> Match 1's резултат ГРЕШНО решава Match 2's
 *      state, показвайки лъжливо "Оценката е изпратена" за Match 2, без
 *      сървърът изобщо да е потвърдил НЕЯ.
 *
 * ROOT CAUSE: PartnerRatingResultMessage носеше само roomId/ok/alreadyRated
 * — достатъчно за "различна стая" (предишен audit), НЕДОСТАТЪЧНО за
 * "същата стая, различен submit" (този audit).
 *
 * FIX: нов requestId — client-generated correlation id
 * (crypto.randomUUID(), established pattern, виж sendTableGift/
 * pendingRequestId) за ТОЗИ конкретен submit click. Server echo-ва
 * requestId непроменено в partner_rating_result (НЕ го тълкува/валидира —
 * server-side game logic/DB idempotency продължава да разчита изцяло на
 * room.game.stateVersion, established server-owned identity). Client-ът
 * приема resolve само ако message.requestId === текущия pending
 * matchEndedPartnerRatingRequestId — Match 1's requestId никога не съвпада
 * с Match 2's.
 *
 * Покрива X1-X8 (плюс S5-S7 pre-existing normal-flow regression, за да не
 * загубим coverage от предишния audit):
 *   X1. Match 1 result пристига след replay в Match 2, state idle -> ignore.
 *   X2. Match 1 success пристига докато Match 2 е submitting -> ignore,
 *       Match 2 остава submitting.
 *   X3. Match 1 alreadyRated=true пристига докато Match 2 е submitting -> ignore.
 *   X4. Match 1 generic failure пристига докато Match 2 е submitting -> ignore.
 *   X5. правилен Match 2 success -> submitted.
 *   X6. правилен Match 2 generic failure -> idle.
 *   X7. правилен Match 2 alreadyRated -> submitted.
 *   X8. different-room stale result -> ignore (pre-existing guard, regression).
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

// scheduleActiveRoomRender() в контролера е requestAnimationFrame-coalesced
// — след всяко handleServerMessage/enterActiveRoom извикване трябва да
// изчакаме поне един browser frame, преди да проверяваме DOM-а.
async function waitForRenderFrame(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
}

async function enterRoom(page: Page, roomId: string, endedAt: number): Promise<void> {
  await page.evaluate(
    ({ roomId, endedAt }) => (window as any).__partnerRatingStaleMessageHarness.enterRoom(roomId, endedAt),
    { roomId, endedAt },
  )
  await waitForRenderFrame(page)
}

async function reenterSameRoomNewMatch(page: Page, roomId: string, endedAt: number): Promise<void> {
  await page.evaluate(
    ({ roomId, endedAt }) => (window as any).__partnerRatingStaleMessageHarness.reenterSameRoomNewMatch(roomId, endedAt),
    { roomId, endedAt },
  )
  await waitForRenderFrame(page)
}

async function clickFirstRatingButton(page: Page): Promise<void> {
  await page.evaluate(() => (window as any).__partnerRatingStaleMessageHarness.clickFirstRatingButton())
  await waitForRenderFrame(page)
}

async function getLastSubmitRequestId(page: Page): Promise<string> {
  const id = await page.evaluate(() => (window as any).__partnerRatingStaleMessageHarness.getLastSubmitRequestId())
  assert(typeof id === 'string' && id.length > 0, 'Очаквах валиден requestId от последния submit frame')
  return id as string
}

async function sendResult(page: Page, roomId: string, requestId: string, ok: boolean, alreadyRated: boolean): Promise<void> {
  await page.evaluate(
    ({ roomId, requestId, ok, alreadyRated }) =>
      (window as any).__partnerRatingStaleMessageHarness.sendPartnerRatingResult(roomId, requestId, ok, alreadyRated),
    { roomId, requestId, ok, alreadyRated },
  )
  await waitForRenderFrame(page)
}

async function getButtonCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as any).__partnerRatingStaleMessageHarness.getRatingButtonCount())
}

async function getPanelText(page: Page): Promise<string | null> {
  return page.evaluate(() => (window as any).__partnerRatingStaleMessageHarness.getRatingPanelText())
}

async function runScenarios(page: Page, label: string): Promise<void> {
  // X1: Match 1 result пристига след replay в Match 2, state idle -> ignore.
  await check(`[${label}] [X1] Match 1 result след replay в Match 2 (idle, все още не submitting) -> ignore`, async () => {
    await enterRoom(page, 'room-X1', 1000)
    await clickFirstRatingButton(page) // Match 1: submitting
    const match1RequestId = await getLastSubmitRequestId(page)

    await reenterSameRoomNewMatch(page, 'room-X1', 2000) // replay -> Match 2, state reset to idle

    const beforeCount = await getButtonCount(page)
    assert(beforeCount === 6, `Очаквах 6 активни бутона (idle) за Match 2 преди stale result, получих ${beforeCount}`)

    await sendResult(page, 'room-X1', match1RequestId, true, false) // Match 1's delayed result

    const afterCount = await getButtonCount(page)
    assert(
      afterCount === 6,
      `Очаквах Match 2 да ОСТАНЕ idle (6 активни бутона) след Match 1's stale result, получих ${afterCount}`,
    )
    const text = await getPanelText(page)
    assert(
      text === null || !text.includes('Оценката е изпратена'),
      `Очаквах Match 2 да НЕ показва "Оценката е изпратена" от Match 1's stale result, получих "${text}"`,
    )
  })

  // X2: Match 1 SUCCESS пристига докато Match 2 е submitting -> ignore, Match 2 остава submitting.
  await check(`[${label}] [X2] Match 1 SUCCESS докато Match 2 е submitting (СЪЩАТА стая) -> ignore, Match 2 остава submitting`, async () => {
    await enterRoom(page, 'room-X2', 3000)
    await clickFirstRatingButton(page)
    const match1RequestId = await getLastSubmitRequestId(page)

    await reenterSameRoomNewMatch(page, 'room-X2', 4000) // replay -> Match 2, idle
    await clickFirstRatingButton(page) // Match 2: submitting (NEW requestId, different from match1RequestId)
    const match2RequestId = await getLastSubmitRequestId(page)
    assert(match2RequestId !== match1RequestId, 'Очаквах различен requestId за Match 2 submit-а спрямо Match 1')

    // Match 2 е submitting — бутоните са disabled, но все още в DOM-а.
    const duringCount = await getButtonCount(page)
    assert(duringCount === 6, `Очаквах 6 (disabled) бутона докато Match 2 е submitting, получих ${duringCount}`)

    // Закъснелият Match 1 SUCCESS result пристига СЕГА (СЪЩИЯТ roomId).
    await sendResult(page, 'room-X2', match1RequestId, true, false)

    const afterCount = await getButtonCount(page)
    const text = await getPanelText(page)
    assert(
      afterCount === 6,
      `КРИТИЧНО: Match 1's success НЕ трябва да flip-не Match 2 на submitted! Очаквах 6 бутона (все още submitting), получих ${afterCount}`,
    )
    assert(
      text === null || !text.includes('Оценката е изпратена'),
      `КРИТИЧНО: Match 2 НЕ трябва да показва "Оценката е изпратена" от Match 1's result, получих "${text}"`,
    )
  })

  // X3: Match 1 alreadyRated=true пристига докато Match 2 е submitting -> ignore.
  await check(`[${label}] [X3] Match 1 ALREADYRATED докато Match 2 е submitting -> ignore`, async () => {
    await enterRoom(page, 'room-X3', 5000)
    await clickFirstRatingButton(page)
    const match1RequestId = await getLastSubmitRequestId(page)

    await reenterSameRoomNewMatch(page, 'room-X3', 6000)
    await clickFirstRatingButton(page)

    await sendResult(page, 'room-X3', match1RequestId, false, true) // alreadyRated от Match 1

    const afterCount = await getButtonCount(page)
    assert(
      afterCount === 6,
      `Очаквах Match 2 да остане submitting (6 бутона), НЕ да flip-не на submitted от Match 1's alreadyRated, получих ${afterCount}`,
    )
  })

  // X4: Match 1 generic failure пристига докато Match 2 е submitting -> ignore.
  await check(`[${label}] [X4] Match 1 GENERIC FAILURE докато Match 2 е submitting -> ignore`, async () => {
    await enterRoom(page, 'room-X4', 7000)
    await clickFirstRatingButton(page)
    const match1RequestId = await getLastSubmitRequestId(page)

    await reenterSameRoomNewMatch(page, 'room-X4', 8000)
    await clickFirstRatingButton(page)

    const beforeSubmitCallCount = (await page.evaluate(() => (window as any).__partnerRatingStaleMessageHarness.getSentFrames()))
      .filter((f: any) => f.type === 'submit_partner_rating').length

    await sendResult(page, 'room-X4', match1RequestId, false, false) // generic failure от Match 1

    const afterCount = await getButtonCount(page)
    assert(
      afterCount === 6,
      `Очаквах Match 2 да остане submitting (6 бутона, все още disabled), НЕ да flip-не на idle от Match 1's failure, получих ${afterCount}`,
    )
    // Бутоните трябва да СА все още disabled (submitting), не re-enabled от Match 1's failure.
    const firstDisabled = await page.evaluate(() =>
      document.querySelector<HTMLButtonElement>('[data-partner-rating-value]')?.disabled ?? null,
    )
    assert(firstDisabled === true, `Очаквах бутоните да останат disabled (submitting), получих disabled=${firstDisabled}`)

    const submitCallCountAfter = (await page.evaluate(() => (window as any).__partnerRatingStaleMessageHarness.getSentFrames()))
      .filter((f: any) => f.type === 'submit_partner_rating').length
    assert(
      submitCallCountAfter === beforeSubmitCallCount,
      'Очаквах Match 1-ото stale failure да НЕ отключи нов submit call за Match 2',
    )
  })

  // X5: правилен Match 2 success -> submitted.
  await check(`[${label}] [X5] правилен Match 2 SUCCESS (верен requestId) -> submitted`, async () => {
    await enterRoom(page, 'room-X5', 9000)
    await clickFirstRatingButton(page)
    const requestId = await getLastSubmitRequestId(page)

    await sendResult(page, 'room-X5', requestId, true, false)

    const count = await getButtonCount(page)
    assert(count === 0, `Очаквах 0 бутона след коректен success, получих ${count}`)
    const text = await getPanelText(page)
    assert(
      text !== null && text.includes('Оценката е изпратена'),
      `Очаквах "Оценката е изпратена", получих "${text}"`,
    )
  })

  // X6: правилен Match 2 generic failure -> idle.
  await check(`[${label}] [X6] правилен Match 2 GENERIC FAILURE (верен requestId) -> idle (retry)`, async () => {
    await enterRoom(page, 'room-X6', 10000)
    await clickFirstRatingButton(page)
    const requestId = await getLastSubmitRequestId(page)

    await sendResult(page, 'room-X6', requestId, false, false)

    const count = await getButtonCount(page)
    assert(count === 6, `Очаквах 6 активни бутона (idle, retry) след коректен generic failure, получих ${count}`)
    const text = await getPanelText(page)
    assert(
      text === null || !text.includes('Оценката е изпратена'),
      `Очаквах НЕ "Оценката е изпратена" след failure, получих "${text}"`,
    )
  })

  // X7: правилен Match 2 alreadyRated -> submitted.
  await check(`[${label}] [X7] правилен Match 2 ALREADYRATED (верен requestId) -> submitted`, async () => {
    await enterRoom(page, 'room-X7', 11000)
    await clickFirstRatingButton(page)
    const requestId = await getLastSubmitRequestId(page)

    await sendResult(page, 'room-X7', requestId, false, true)

    const count = await getButtonCount(page)
    assert(count === 0, `Очаквах 0 бутона след коректен alreadyRated response, получих ${count}`)
    const text = await getPanelText(page)
    assert(
      text !== null && text.includes('Оценката е изпратена'),
      `Очаквах "Оценката е изпратена" при alreadyRated, получих "${text}"`,
    )
  })

  // X8: different-room stale result -> ignore (pre-existing guard, regression check).
  await check(`[${label}] [X8] different-room stale result -> ignore (pre-existing roomId guard, regression)`, async () => {
    await enterRoom(page, 'room-X8a', 12000)
    await clickFirstRatingButton(page)
    const staleRoomARequestId = await getLastSubmitRequestId(page)

    await enterRoom(page, 'room-X8b', 13000) // genuinely different room (different roomId)
    const beforeCount = await getButtonCount(page)
    assert(beforeCount === 6, `Очаквах 6 активни бутона в новата различна стая, получих ${beforeCount}`)

    await sendResult(page, 'room-X8a', staleRoomARequestId, true, false) // stale result за старата стая

    const afterCount = await getButtonCount(page)
    assert(
      afterCount === 6,
      `Очаквах новата стая да остане непроменена (6 бутона) след different-room stale result, получих ${afterCount}`,
    )
  })
}

async function run(): Promise<void> {
  console.log('\ncheckPartnerRatingStaleMessageSafety\n')

  const port = await findFreePort()
  const vite: ViteDevServer = await createViteServer({
    root: process.cwd(),
    server: { port, strictPort: true, host: '127.0.0.1' },
    logLevel: 'error',
  })
  await vite.listen()

  const browser: Browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } })
  const jsErrors: string[] = []
  page.on('pageerror', (err) => jsErrors.push(err.message))

  await page.goto(`http://127.0.0.1:${port}/scripts/fixtures/partnerRatingStaleMessageHarness.html`)
  await page.waitForFunction(
    () => (window as any).__partnerRatingStaleMessageHarness?.enterRoom !== undefined,
    undefined,
    { timeout: 10_000 },
  )

  await runScenarios(page, 'desktop')

  await check('[desktop] Няма JS грешки', () => {
    assert(jsErrors.length === 0, `JS грешки: ${jsErrors.join('; ')}`)
  })

  await browser.close()
  await vite.close()

  console.log(`\n${passed} passed, ${failed} failed\n`)
  if (failed > 0) {
    process.exit(1)
  }
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
