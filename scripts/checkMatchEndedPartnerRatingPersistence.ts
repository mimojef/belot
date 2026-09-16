/**
 * checkMatchEndedPartnerRatingPersistence.ts
 *
 * Real browser (Playwright), real production code (renderMatchEndedScreen.ts
 * via scripts/fixtures/matchEndedHarness.ts) — доказва fix-а за
 * "partner rating контролата се активира отново след re-render след успешен
 * submit" (production incident: DOM-only disable state се губеше при
 * следващ пълен re-render, позволявайки повторен клик/submit) И последващия
 * "false-success UI" audit fix (permanent SUBMITTED state НЕ може да се
 * задава само от клика — трябва server-confirmed response).
 *
 * ROOT CAUSE #1 (re-render persistence, потвърден чрез audit): след успешен
 * клик върху rating бутон, старият код правеше САМО DOM mutation
 * (button.disabled=true, инжектиран "Оценката е изпратена" текст) —
 * никакво controller-level state не пазеше "този local profile вече е
 * оценил партньора за този match-ended lifecycle". Следващ пълен re-render
 * (renderMatchEndedScreen(), причинен от WebSocket room_snapshot при leave/
 * replay vote, bot-takeover, reconnect) правеше root.innerHTML = `...`
 * наново, пресъздавайки активните rating бутони от нула.
 *
 * ROOT CAUSE #2 (false-success UI, открит при post-fix audit): протоколът
 * submit_partner_rating няма explicit success ack към submitting
 * connection-а (само 'error' при failure, тих success). Първата версия на
 * fix-а задаваше permanent "submitted" state синхронно при click
 * (onPartnerRatingSubmitted), преди сървърът реално да потвърди — ако
 * server request се провали (network/server причина, различна от
 * duplicate), UI-то щеше лъжливо да остане на "Оценката е изпратена" без
 * retry възможност.
 *
 * FIX: (1) authoritative "submitted" state живее в
 * createActiveRoomFlowController.ts (matchEndedPartnerRatingState), подава
 * се на renderMatchEndedScreen при всеки render (partnerRatingStatus), и
 * определя дали да се рендира rating UI-то или "Оценката е изпратена"
 * completed съобщение — директно от render логиката, не от DOM mutation
 * след факта. (2) Tri-state: 'idle' -> 'submitting' (temporary, синхронно
 * при click, само UI feedback) -> 'submitted' (permanent, ЕДИНСТВЕНО след
 * реален partner_rating_result server response с ok:true ИЛИ
 * alreadyRated:true) или обратно 'idle' при generic failure (retry-able).
 * (3) Нов server message тип partner_rating_result дава explicit ack и за
 * success, и за failure — виж server/src/protocol/messageTypes.ts.
 * Reset-ва се само при напускане на match-ended lifecycle / нова игра,
 * СЪЩИТЕ места като matchEndedPrizeAnimationStartedAt reset-а.
 *
 * Покрива R1-R6, R8-R10 + F1-F4 от task-а (R7 — server-side duplicate DB
 * effect — се тества отделно в checkPartnerRatingServerIdempotency.ts, тъй
 * като е чиста server data-integrity логика, несвързана с browser
 * rendering):
 *   F1.  click rating -> submit започва -> controls temporary disabled
 *        ("Изпращане...", НЕ "Оценката е изпратена" все още).
 *   F2.  server success -> permanent completed state -> re-render остава
 *        completed.
 *   R1.  submit -> server success -> control completed (бутоните изчезват).
 *   R2.  submit -> success -> full re-render -> остава completed.
 *   R3.  submit -> success -> room_snapshot re-render -> остава completed.
 *   R4.  submit -> success -> leave vote re-render -> остава completed.
 *   R5.  submit -> success -> replay vote re-render -> остава completed.
 *   R6.  втори клик от същия client -> onSubmitPartnerRating НЕ се вика
 *        втори път.
 *   F3.  server failure (различен от duplicate) -> НЕ остава лъжливо
 *        "Оценката е изпратена" -> бутоните се връщат активни -> retry
 *        възможен (нов onSubmitPartnerRating call при повторен клик).
 *   F4.  duplicate/already-rated response -> третира се като completed
 *        (safe), НЕ като retry-able грешка.
 *   R8.  нов match/room -> rating state се reset-ва правилно.
 *   R9.  losing side -> submit защитата (tri-state) работи еднакво.
 *   R10. desktop + mobile.
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

async function resetPartnerRating(page: Page): Promise<void> {
  await page.evaluate(() => (window as any).__matchEndedHarness.resetPartnerRating())
}

async function paintRating(page: Page, winnerTeam: 'A' | 'B'): Promise<void> {
  await page.evaluate((winnerTeam) => (window as any).__matchEndedHarness.paintRating(winnerTeam), winnerTeam)
}

async function getSubmitCallCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as any).__matchEndedHarness.getOnSubmitPartnerRatingCallCount())
}

async function getStatus(page: Page): Promise<'idle' | 'submitting' | 'submitted'> {
  return page.evaluate(() => (window as any).__matchEndedHarness.getPartnerRatingStatus())
}

async function resolveSubmit(page: Page, ok: boolean, alreadyRated: boolean): Promise<void> {
  await page.evaluate(
    ({ ok, alreadyRated }) => (window as any).__matchEndedHarness.resolveSubmit(ok, alreadyRated),
    { ok, alreadyRated },
  )
}

async function getRatingButtonCount(page: Page): Promise<number> {
  return page.locator('[data-partner-rating-value]').count()
}

async function getRatingPanelText(page: Page): Promise<string | null> {
  return page.locator('[data-partner-rating-panel="1"]').textContent()
}

async function clickFirstRatingButton(page: Page): Promise<void> {
  await page.locator('[data-partner-rating-value]').first().click()
}

// Пълен happy-path helper: click -> паинт (показва 'submitting') -> server
// success ack -> паинт (показва 'submitted'). Използван от повечето R*
// сценарии, за които конкретното SUBMITTING/SUBMITTED разграничение не е
// фокус (виж F1/F2 за explicit проверка на самите преходи).
async function submitAndConfirmSuccess(page: Page, winnerTeam: 'A' | 'B' = 'A'): Promise<void> {
  await clickFirstRatingButton(page)
  await resolveSubmit(page, true, false)
  await paintRating(page, winnerTeam)
}

async function runScenarios(page: Page, viewportLabel: string): Promise<void> {
  // F1: click rating -> submit започва -> controls temporary disabled, НО
  // все още НЕ permanent "Оценката е изпратена" (само "Изпращане...").
  await check(`[${viewportLabel}] [F1] click -> submitting state -> бутоните са disabled, текстът е "Изпращане..."`, async () => {
    await resetPartnerRating(page)
    await paintRating(page, 'A')
    await clickFirstRatingButton(page)

    const status = await getStatus(page)
    assert(status === 'submitting', `Очаквах status='submitting' веднага след клик, получих '${status}'`)

    await paintRating(page, 'A')
    const panelText = await getRatingPanelText(page)
    assert(
      panelText !== null && panelText.includes('Изпращане') && !panelText.includes('Оценката е изпратена'),
      `Очаквах "Изпращане..." (НЕ "Оценката е изпратена") докато чакаме server response, получих "${panelText}"`,
    )
    const buttons = page.locator('[data-partner-rating-value]')
    const count = await buttons.count()
    if (count > 0) {
      const firstDisabled = await buttons.first().isDisabled()
      assert(firstDisabled, 'Очаквах rating бутоните да са disabled по време на submitting')
    }
  })

  // F2: server success -> permanent completed state -> re-render остава completed.
  await check(`[${viewportLabel}] [F2] server success -> permanent completed state, персистира през re-render`, async () => {
    await resetPartnerRating(page)
    await paintRating(page, 'A')
    await clickFirstRatingButton(page)
    await resolveSubmit(page, true, false)
    await paintRating(page, 'A')

    const status = await getStatus(page)
    assert(status === 'submitted', `Очаквах status='submitted' след server success, получих '${status}'`)

    // Допълнителен re-render (симулира следващ room_snapshot) — трябва да остане completed.
    await paintRating(page, 'A')
    const panelText = await getRatingPanelText(page)
    assert(
      panelText !== null && panelText.includes('Оценката е изпратена'),
      `Очаквах "Оценката е изпратена" да персистира, получих "${panelText}"`,
    )
  })

  // R1: submit -> server success -> control completed (бутоните изчезват).
  await check(`[${viewportLabel}] [R1] submit rating -> server success -> control става completed`, async () => {
    await resetPartnerRating(page)
    await paintRating(page, 'A')
    const beforeCount = await getRatingButtonCount(page)
    assert(beforeCount === 6, `Очаквах 6 rating бутона преди submit, получих ${beforeCount}`)

    await submitAndConfirmSuccess(page)

    const afterCount = await getRatingButtonCount(page)
    assert(afterCount === 0, `Очаквах 0 rating бутона след success+re-render, получих ${afterCount}`)

    const panelText = await getRatingPanelText(page)
    assert(
      panelText !== null && panelText.includes('Оценката е изпратена'),
      `Очаквах "Оценката е изпратена" в панела, получих "${panelText}"`,
    )
  })

  // R2: submit -> success -> full re-render -> остава completed.
  await check(`[${viewportLabel}] [R2] submit -> success -> пълен re-render -> остава completed`, async () => {
    await resetPartnerRating(page)
    await paintRating(page, 'A')
    await submitAndConfirmSuccess(page)

    // Симулираме 3 последователни пълни re-render-а (напр. burst от snapshot-и).
    await paintRating(page, 'A')
    await paintRating(page, 'A')
    await paintRating(page, 'A')

    const count = await getRatingButtonCount(page)
    assert(count === 0, `Очаквах 0 rating бутона след множество re-render-и, получих ${count}`)
  })

  // R3: submit -> success -> room_snapshot re-render -> остава completed.
  await check(`[${viewportLabel}] [R3] submit -> success -> room_snapshot re-render -> остава completed`, async () => {
    await resetPartnerRating(page)
    await paintRating(page, 'A')
    await submitAndConfirmSuccess(page)
    await paintRating(page, 'A')

    const count = await getRatingButtonCount(page)
    assert(count === 0, `Очаквах 0 rating бутона след room_snapshot re-render, получих ${count}`)
  })

  // R4/R5: leave vote / replay vote update причиняват СЪЩИЯ вид full
  // re-render на client-а (виж applyRoomSnapshotToActiveRoom) — harness-ът
  // не различава конкретния trigger, само факта, че renderMatchEndedScreen
  // се извиква наново, точно както при production leave/replay vote push.
  await check(`[${viewportLabel}] [R4] submit -> success -> leave vote re-render -> остава completed`, async () => {
    await resetPartnerRating(page)
    await paintRating(page, 'A')
    await submitAndConfirmSuccess(page)
    await paintRating(page, 'A') // симулира re-render от leave vote snapshot
    const count = await getRatingButtonCount(page)
    assert(count === 0, `Очаквах 0 rating бутона след leave-vote re-render, получих ${count}`)
  })

  await check(`[${viewportLabel}] [R5] submit -> success -> replay vote re-render -> остава completed`, async () => {
    await resetPartnerRating(page)
    await paintRating(page, 'A')
    await submitAndConfirmSuccess(page)
    await paintRating(page, 'A') // симулира re-render от replay vote snapshot
    const count = await getRatingButtonCount(page)
    assert(count === 0, `Очаквах 0 rating бутона след replay-vote re-render, получих ${count}`)
  })

  // R6: втори клик от същия client -> onSubmitPartnerRating НЕ се вика втори път.
  await check(`[${viewportLabel}] [R6] control е disabled по време на submitting -> втори клик не праща втори submit`, async () => {
    await resetPartnerRating(page)
    await paintRating(page, 'A')
    await clickFirstRatingButton(page)

    const countAfterFirstClick = await getSubmitCallCount(page)
    assert(countAfterFirstClick === 1, `Очаквах 1 submit call след първия клик, получих ${countAfterFirstClick}`)

    // Бутоните вече са disabled (submitting state) — опит за клик върху
    // disabled бутон не тригва listener-а в браузъра.
    const buttons = page.locator('[data-partner-rating-value]')
    const remaining = await buttons.count()
    if (remaining > 0) {
      await buttons.first().click({ force: true }).catch(() => {})
    }

    const countAfterSecondAttempt = await getSubmitCallCount(page)
    assert(
      countAfterSecondAttempt === 1,
      `Очаквах submit call да остане 1 след опит за втори клик по време на submitting, получих ${countAfterSecondAttempt}`,
    )
  })

  // F3: server failure (различен от duplicate) -> НЕ остава лъжливо
  // "Оценката е изпратена" -> бутоните се връщат активни -> retry възможен.
  await check(`[${viewportLabel}] [F3] server failure (non-duplicate) -> НЕ completed, бутоните се връщат за retry`, async () => {
    await resetPartnerRating(page)
    await paintRating(page, 'A')
    await clickFirstRatingButton(page)
    await resolveSubmit(page, false, false) // generic failure, не duplicate

    const status = await getStatus(page)
    assert(status === 'idle', `Очаквах status='idle' след generic failure (retry-able), получих '${status}'`)

    await paintRating(page, 'A')
    const panelText = await getRatingPanelText(page)
    assert(
      panelText === null || !panelText.includes('Оценката е изпратена'),
      `Очаквах НЕ "Оценката е изпратена" след failure, получих "${panelText}"`,
    )
    const count = await getRatingButtonCount(page)
    assert(count === 6, `Очаквах 6 активни rating бутона за retry след failure, получих ${count}`)

    // Retry: втори клик СЛЕД failure трябва да прати нов submit call.
    const countBeforeRetry = await getSubmitCallCount(page)
    await clickFirstRatingButton(page)
    const countAfterRetry = await getSubmitCallCount(page)
    assert(
      countAfterRetry === countBeforeRetry + 1,
      `Очаквах retry click да прати нов submit call (${countBeforeRetry} -> ${countBeforeRetry + 1}), получих ${countAfterRetry}`,
    )
  })

  // F4: duplicate/already-rated response -> третира се като completed
  // (safe), НЕ като retry-able грешка.
  await check(`[${viewportLabel}] [F4] duplicate/already-rated response -> completed state (safe), НЕ retry`, async () => {
    await resetPartnerRating(page)
    await paintRating(page, 'A')
    await clickFirstRatingButton(page)
    await resolveSubmit(page, false, true) // ok:false, НО alreadyRated:true

    const status = await getStatus(page)
    assert(status === 'submitted', `Очаквах status='submitted' при alreadyRated:true response, получих '${status}'`)

    await paintRating(page, 'A')
    const panelText = await getRatingPanelText(page)
    assert(
      panelText !== null && panelText.includes('Оценката е изпратена'),
      `Очаквах "Оценката е изпратена" при duplicate response (сървърът вече ИМА оценката), получих "${panelText}"`,
    )
    const count = await getRatingButtonCount(page)
    assert(count === 0, `Очаквах 0 rating бутона при alreadyRated response (не retry-able), получих ${count}`)
  })

  // R8: нов match/room -> rating state се reset-ва правилно.
  await check(`[${viewportLabel}] [R8] нов match (resetPartnerRating) -> control отново активна`, async () => {
    await resetPartnerRating(page)
    await paintRating(page, 'A')
    await submitAndConfirmSuccess(page)
    let count = await getRatingButtonCount(page)
    assert(count === 0, `Очаквах 0 rating бутона след success submit, получих ${count}`)

    // Нов match-ended lifecycle (production: enterActiveRoomFromResume /
    // room cleanup нулира matchEndedPartnerRatingState).
    await resetPartnerRating(page)
    await paintRating(page, 'A')
    count = await getRatingButtonCount(page)
    assert(count === 6, `Очаквах 6 активни rating бутона след reset за нов match, получих ${count}`)
  })

  // R9: losing side — партньорският панел показва rating UI независимо от
  // победа/загуба (зависи само от partner.isOccupied) — защитата важи
  // еднакво. localSeat='bottom' е винаги екипа на 'A', така че winnerTeam='B'
  // прави localSeat губещ, но partner rating панелът пак се показва.
  await check(`[${viewportLabel}] [R9] губеща страна -> submit защитата работи еднакво`, async () => {
    await resetPartnerRating(page)
    await paintRating(page, 'B')
    const beforeCount = await getRatingButtonCount(page)
    assert(beforeCount === 6, `Очаквах 6 rating бутона (губеща страна), получих ${beforeCount}`)

    await submitAndConfirmSuccess(page, 'B')
    const afterCount = await getRatingButtonCount(page)
    assert(afterCount === 0, `Очаквах 0 rating бутона след submit (губеща страна), получих ${afterCount}`)
  })
}

async function run(): Promise<void> {
  console.log('\ncheckMatchEndedPartnerRatingPersistence\n')

  const port = await findFreePort()
  const vite: ViteDevServer = await createViteServer({
    root: process.cwd(),
    server: { port, strictPort: true, host: '127.0.0.1' },
    logLevel: 'error',
  })
  await vite.listen()

  const browser: Browser = await chromium.launch()

  const viewports: Array<{ label: string; width: number; height: number; hasTouch?: boolean; isMobile?: boolean }> = [
    { label: 'desktop 1280x850', width: 1280, height: 850 },
    { label: 'mobile 390x844', width: 390, height: 844, hasTouch: true, isMobile: true },
  ]

  for (const viewport of viewports) {
    console.log(`\n--- ${viewport.label[0].toUpperCase()}${viewport.label.slice(1)} ---`)
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      hasTouch: viewport.hasTouch,
      isMobile: viewport.isMobile,
    })
    const page = await context.newPage()
    const jsErrors: string[] = []
    page.on('pageerror', (err) => jsErrors.push(err.message))

    await page.goto(`http://127.0.0.1:${port}/scripts/fixtures/matchEndedHarness.html`)
    await page.waitForFunction(() => (window as any).__matchEndedHarness?.paintRating !== undefined, undefined, {
      timeout: 10_000,
    })

    await runScenarios(page, viewport.label)

    await check(`[${viewport.label}] [R10] Няма JS грешки`, () => {
      assert(jsErrors.length === 0, `JS грешки: ${jsErrors.join('; ')}`)
    })

    await context.close()
  }

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
