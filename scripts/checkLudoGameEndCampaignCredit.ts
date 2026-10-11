/**
 * checkLudoGameEndCampaignCredit.ts
 *
 * ФАЗА 7 — Real browser (Playwright), REAL production code
 * (createLudoFlowController.ts + renderLudoGameEndPopup.ts, via
 * scripts/fixtures/ludoGameEndCampaignHarness.ts, mirror на established
 * ludoAuthoritativeHarness.ts/matchEndedHarness.ts conventions) — доказва
 * Ludo финалния popup "спечелени тематични единици" визуално поведение.
 *
 * [D1] Победител с реален credit -> "+25 тикви" + икона, заявена ТОЧНО
 *      веднъж (campaignRequestCount===1).
 * [D2] credit===null -> нищо допълнително, без placeholder.
 * [D3] Губещ играч -> НИКОГА не вижда campaign unit ред, дори ако
 *      (хипотетично невалиден server отговор) credit пристигне.
 * [D4] Spectator -> НИКОГА не заявява credit lookup (campaignRequestCount===0).
 * [D5] Съществуващият жълтици ред остава непроменен, когато и двата
 *      (жълтици + тематични единици) са налични едновременно.
 * [D6] Закъсняло начисление (пристигнало СЛЕД popup-ът вече е mount-нат)
 *      -> targeted DOM patch обновява ВЕЧЕ отворения popup.
 * [D7] Начисление, пристигнало СЛЕД popup-ът вече е ЗАТВОРЕН -> НЕ го
 *      отваря повторно (task spec §5).
 * [D8] Счупен/липсващ icon URL -> fallback текст, без счупена заявка.
 * [D9] Правилно singular/plural (1 vs повече единици).
 * [D10] Нов мач (нов controller instance) -> campaignRequestCount
 *       reset-ва се, предишният credit не "прелива" в новия popup.
 * [D11] Desktop + Mobile оформление, без JS грешки.
 */

import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright'
import { createServer as createNetServer } from 'node:net'

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

const sampleCredit = {
  campaignId: 'campaign-1',
  campaignName: 'Halloween 2026',
  unitNameSingular: 'тиква',
  unitNamePlural: 'тикви',
  unitIconUrl: '/assets/campaigns/pumpkin.webp',
  unitsAmount: 25,
}

async function mount(page: Page, localColor: 'red' | 'blue' = 'red'): Promise<void> {
  await page.evaluate((color) => (window as any).__ludoGameEndCampaignHarness.mount(color), localColor)
}

async function mountSpectator(page: Page): Promise<void> {
  await page.evaluate(() => (window as any).__ludoGameEndCampaignHarness.mountSpectator())
}

async function finishMatch(page: Page, winnerColor: 'red' | 'blue', prizeAmount: number | null): Promise<void> {
  await page.evaluate(
    ({ winnerColor, prizeAmount }) => (window as any).__ludoGameEndCampaignHarness.finishMatch(winnerColor, prizeAmount),
    { winnerColor, prizeAmount },
  )
}

async function simulateCampaignCreditResult(page: Page, credit: typeof sampleCredit | null): Promise<void> {
  await page.evaluate((c) => (window as any).__ludoGameEndCampaignHarness.simulateCampaignCreditResult(c), credit)
}

async function dismissPopup(page: Page): Promise<void> {
  await page.evaluate(() => (window as any).__ludoGameEndCampaignHarness.dismissPopup())
}

async function getCampaignRequestCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as any).__ludoGameEndCampaignHarness.getCampaignRequestCount())
}

async function getCampaignUnitLineCount(page: Page): Promise<number> {
  return page.locator('[data-ludo-campaign-unit-line="1"]').count()
}

async function getCampaignUnitLineText(page: Page): Promise<string | null> {
  return page.locator('[data-ludo-campaign-unit-line="1"]').first().textContent()
}

async function getPrizeLineCount(page: Page): Promise<number> {
  return page.locator('[data-ludo-prize-line="1"]').count()
}

async function getPopupBackdropCount(page: Page): Promise<number> {
  return page.locator('[data-ludo-game-end-backdrop="1"]').count()
}

async function runScenarios(page: Page, viewportLabel: string): Promise<void> {
  await check(`[${viewportLabel}] [D1] Победител с реален credit -> "+25 тикви" + икона, заявена ТОЧНО веднъж`, async () => {
    await mount(page, 'red')
    await finishMatch(page, 'red', 13000)
    const requestCount = await getCampaignRequestCount(page)
    assert(requestCount === 1, `очаквах campaignRequestCount===1, получих ${requestCount}`)

    await simulateCampaignCreditResult(page, sampleCredit)
    const lineCount = await getCampaignUnitLineCount(page)
    assert(lineCount === 1, `очаквах точно 1 campaign unit ред, получих ${lineCount}`)
    const text = await getCampaignUnitLineText(page)
    assert(text !== null && text.includes('25') && text.includes('тикви'), `очаквах "+25 тикви"-подобен текст, получих "${text}"`)
    const img = page.locator('[data-ludo-campaign-unit-line="1"] img')
    const src = await img.getAttribute('src')
    assert(src !== null && src.includes('pumpkin'), `очаквах икона src, получих "${src}"`)
  })

  await check(`[${viewportLabel}] [D2] credit===null -> нищо допълнително, без placeholder`, async () => {
    await mount(page, 'red')
    await finishMatch(page, 'red', 13000)
    await simulateCampaignCreditResult(page, null)
    const lineCount = await getCampaignUnitLineCount(page)
    assert(lineCount === 0, `очаквах 0 campaign unit редове при credit===null, получих ${lineCount}`)
  })

  await check(`[${viewportLabel}] [D3] Губещ играч -> никога не вижда campaign unit ред`, async () => {
    await mount(page, 'red')
    await finishMatch(page, 'blue', null) // red губи
    const requestCount = await getCampaignRequestCount(page)
    assert(requestCount === 1, 'заявката се изпраща и за губещия (сървърът коректно връща null за него)')
    // Симулираме хипотетичен невалиден server отговор (defense-in-depth проверка).
    await simulateCampaignCreditResult(page, sampleCredit)
    const lineCount = await getCampaignUnitLineCount(page)
    assert(lineCount === 0, `губещ играч никога не бива да вижда campaign unit ред, получих ${lineCount}`)
  })

  await check(`[${viewportLabel}] [D4] Spectator -> никога не заявява credit lookup`, async () => {
    await mountSpectator(page)
    await finishMatch(page, 'red', null)
    const requestCount = await getCampaignRequestCount(page)
    assert(requestCount === 0, `spectator никога не бива да заявява campaign credit, получих ${requestCount}`)
  })

  await check(`[${viewportLabel}] [D5] Съществуващият жълтици ред остава непроменен заедно с тематичните единици`, async () => {
    await mount(page, 'red')
    await finishMatch(page, 'red', 13000)
    await simulateCampaignCreditResult(page, sampleCredit)
    const prizeLineCount = await getPrizeLineCount(page)
    const campaignLineCount = await getCampaignUnitLineCount(page)
    assert(prizeLineCount === 1, `очаквах жълтици редът да остане, получих ${prizeLineCount}`)
    assert(campaignLineCount === 1, `очаквах campaign unit редът да се появи, получих ${campaignLineCount}`)
  })

  await check(`[${viewportLabel}] [D6] Закъсняло начисление (СЛЕД popup-ът вече е mount-нат) -> targeted DOM patch`, async () => {
    await mount(page, 'red')
    await finishMatch(page, 'red', 13000)
    const beforePatch = await getCampaignUnitLineCount(page)
    assert(beforePatch === 0, 'преди patch-а campaign unit редът не бива да съществува')
    await simulateCampaignCreditResult(page, sampleCredit)
    const afterPatch = await getCampaignUnitLineCount(page)
    assert(afterPatch === 1, `очаквах targeted patch да добави campaign unit редът, получих ${afterPatch}`)
  })

  await check(`[${viewportLabel}] [D7] Начисление, пристигнало СЛЕД popup-ът вече е затворен -> НЕ го отваря повторно`, async () => {
    await mount(page, 'red')
    await finishMatch(page, 'red', 13000)
    await dismissPopup(page)
    const backdropCountBefore = await getPopupBackdropCount(page)
    assert(backdropCountBefore === 0, 'popup-ът трябва да е затворен преди закъснялото начисление')
    await simulateCampaignCreditResult(page, sampleCredit)
    const backdropCountAfter = await getPopupBackdropCount(page)
    assert(backdropCountAfter === 0, 'закъсняло начисление никога не бива да отваря повторно затворен popup')
  })

  await check(`[${viewportLabel}] [D8] Счупен icon URL -> fallback текст, без счупена заявка`, async () => {
    await mount(page, 'red')
    await finishMatch(page, 'red', 13000)
    await simulateCampaignCreditResult(page, { ...sampleCredit, unitIconUrl: '/this/path/does/not/exist.webp' })
    await page.waitForTimeout(150)
    const img = page.locator('[data-ludo-campaign-unit-line="1"] img')
    const visible = await img.isVisible().catch(() => false)
    assert(!visible, 'очаквах счупената икона да се скрие (onerror)')
    const text = await getCampaignUnitLineText(page)
    assert(text !== null && text.includes('тикви'), `текстът трябва да остане видим, получих "${text}"`)
  })

  await check(`[${viewportLabel}] [D9] Правилно singular/plural (1 единица)`, async () => {
    await mount(page, 'red')
    await finishMatch(page, 'red', 13000)
    await simulateCampaignCreditResult(page, { ...sampleCredit, unitsAmount: 1 })
    const text = await getCampaignUnitLineText(page)
    assert(text !== null && text.includes('+1') && text.includes('тиква') && !text.includes('тикви'), `очаквах singular "тиква" за 1 единица, получих "${text}"`)
  })

  await check(`[${viewportLabel}] [D10] Нов мач (нов controller instance) -> campaignRequestCount reset-ва се`, async () => {
    await mount(page, 'red')
    await finishMatch(page, 'red', 13000)
    await simulateCampaignCreditResult(page, sampleCredit)
    const countBeforeRemount = await getCampaignUnitLineCount(page)
    assert(countBeforeRemount === 1, 'първият мач трябва да покаже credit-а')

    await mount(page, 'red') // нов controller instance, нов matchId
    const requestCountAfterRemount = await getCampaignRequestCount(page)
    assert(requestCountAfterRemount === 0, 'нов controller instance трябва да нулира request count-а')
    const lineCountAfterRemount = await getCampaignUnitLineCount(page)
    assert(lineCountAfterRemount === 0, 'предишният credit не бива да "прелее" в новия popup (все още не е mount-нат)')

    await finishMatch(page, 'red', 13000)
    const lineCountAfterNewFinish = await getCampaignUnitLineCount(page)
    assert(lineCountAfterNewFinish === 0, 'новият мач не бива да показва предишния credit автоматично')
  })
}

async function run(): Promise<void> {
  console.log('\ncheckLudoGameEndCampaignCredit\n')

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

    await page.goto(`http://127.0.0.1:${port}/scripts/fixtures/ludoGameEndCampaignHarness.html`)
    await page.waitForFunction(() => (window as any).__ludoGameEndCampaignHarness?.mount !== undefined, undefined, {
      timeout: 10_000,
    })

    await runScenarios(page, viewport.label)

    await check(`[${viewport.label}] [D11] Няма JS грешки`, () => {
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
