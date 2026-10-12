/**
 * checkCampaignProfilePopupUi.ts
 *
 * ФАЗА 8 — Real browser (Playwright), REAL production code
 * (renderPlayerProfilePopup.ts + renderLobbyScreen.ts's syncProfilePopup/
 * attachPopupListeners, via scripts/fixtures/campaignProfilePopupHarness.ts) —
 * доказва активната кампания карето под "Ранг", "Виж всички награди"
 * expand/collapse, горната навигация "Кампании" + последна приключила
 * кампания панел, desktop/mobile оформление.
 *
 * [D1] Активна кампания — 347/500 example: име, "Твоят прогрес", "347 тикви",
 *      точните награди НАД числовия прогрес, "347 / 500", "Още 153 тикви...".
 * [D2] Без активна кампания (summary.active=null) -> карето не се показва.
 * [D3] Без кампания изобщо (summary=null, flag off еквивалент) -> нито
 *      карето, нито горната навигация, popup изглежда непроменен.
 * [D4] Единствено число (1 тиква) vs множествено (347 тикви).
 * [D5] Всички прагове изпълнени -> "Всички награди са получени!".
 * [D6] Праг с pending (не locked) награда -> "Очаква предоставяне".
 * [D7] "Виж всички награди" — разгъване показва всички прагове с коректен
 *      статус (Получена/Очаква предоставяне/Заключена); бутонът реално
 *      toggle-ва state през REAL click wiring (не само HTML presence).
 * [D8] Свиване връща бутона към "Виж всички награди".
 * [D9] Горна навигация "Кампании" — клик показва последната приключила
 *      кампания ("Хелоуин 2026", "Общо събрани: 1274 тикви").
 * [D10] "Няма предишна кампания" — graceful когато lastFinished=null.
 * [D11] Собствен И чужд профил — и двата показват campaignSummary коректно
 *       (секцията не е ролево ограничена).
 * [D12] Desktop + Mobile оформление, без JS грешки, без overflow.
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

const activeSummary347of500 = {
  active: {
    campaignId: 'campaign-active-1',
    campaignName: 'Хелоуин 2026',
    unitNameSingular: 'тиква',
    unitNamePlural: 'тикви',
    unitIconUrl: null,
    unitsTotal: 347,
    tiers: [
      {
        tierId: 'tier-100',
        thresholdUnits: 100,
        rewards: [{ tierRewardId: 'r-100-coins', reward: { rewardType: 'yellow_coins', amount: 10_000 }, status: 'granted' }],
      },
      {
        tierId: 'tier-500',
        thresholdUnits: 500,
        rewards: [
          { tierRewardId: 'r-500-coins', reward: { rewardType: 'yellow_coins', amount: 50_000 }, status: 'locked' },
          { tierRewardId: 'r-500-vip', reward: { rewardType: 'vip_days', days: 3 }, status: 'locked' },
        ],
      },
    ],
    nextIncompleteTier: {
      tierId: 'tier-500',
      thresholdUnits: 500,
      rewards: [
        { tierRewardId: 'r-500-coins', reward: { rewardType: 'yellow_coins', amount: 50_000 }, status: 'locked' },
        { tierRewardId: 'r-500-vip', reward: { rewardType: 'vip_days', days: 3 }, status: 'locked' },
      ],
    },
  },
  lastFinished: {
    campaignId: 'campaign-finished-1',
    campaignName: 'Хелоуин 2026',
    unitNameSingular: 'тиква',
    unitNamePlural: 'тикви',
    unitIconUrl: null,
    unitsTotal: 1274,
  },
}

const allTiersGrantedSummary = {
  active: {
    ...activeSummary347of500.active,
    unitsTotal: 600,
    tiers: activeSummary347of500.active.tiers.map((tier) => ({
      ...tier,
      rewards: tier.rewards.map((r) => ({ ...r, status: 'granted' })),
    })),
    nextIncompleteTier: null,
  },
  lastFinished: null,
}

const pendingRewardSummary = {
  active: {
    campaignId: 'campaign-pending-1',
    campaignName: 'Pending Test Campaign',
    unitNameSingular: 'жетон',
    unitNamePlural: 'жетона',
    unitIconUrl: null,
    unitsTotal: 50,
    tiers: [
      {
        tierId: 'tier-50-pending',
        thresholdUnits: 50,
        rewards: [{ tierRewardId: 'r-50-gift', reward: { rewardType: 'gift_item', giftItemId: 'g1', name: 'Златна тиква', imageUrl: null }, status: 'pending' }],
      },
    ],
    nextIncompleteTier: {
      tierId: 'tier-50-pending',
      thresholdUnits: 50,
      rewards: [{ tierRewardId: 'r-50-gift', reward: { rewardType: 'gift_item', giftItemId: 'g1', name: 'Златна тиква', imageUrl: null }, status: 'pending' }],
    },
  },
  lastFinished: null,
}

const singleUnitSummary = {
  active: {
    campaignId: 'campaign-single-1',
    campaignName: 'Единична единица',
    unitNameSingular: 'жетон',
    unitNamePlural: 'жетона',
    unitIconUrl: null,
    unitsTotal: 1,
    tiers: [{ tierId: 'tier-10', thresholdUnits: 10, rewards: [{ tierRewardId: 'r-10', reward: { rewardType: 'yellow_coins', amount: 500 }, status: 'locked' }] }],
    nextIncompleteTier: { tierId: 'tier-10', thresholdUnits: 10, rewards: [{ tierRewardId: 'r-10', reward: { rewardType: 'yellow_coins', amount: 500 }, status: 'locked' }] },
  },
  lastFinished: null,
}

const noLastFinishedButActiveSummary = {
  active: activeSummary347of500.active,
  lastFinished: null,
}

async function mount(page: Page, opts: { own?: boolean; summary?: unknown }): Promise<void> {
  await page.evaluate((o) => (window as any).__campaignProfilePopupHarness.mount(o), opts)
}

function card(page: Page) {
  return page.locator('[data-player-profile-campaign-card="1"]')
}

console.log('\ncheckCampaignProfilePopupUi\n')

async function runScenarios(page: Page, viewportLabel: string): Promise<void> {
  await check(`[${viewportLabel}] [D1] Активна кампания 347/500 — коректен текст и точните награди над прогреса`, async () => {
    await mount(page, { own: true, summary: activeSummary347of500 })
    await card(page).waitFor({ state: 'visible' })
    // bg-BG Intl.NumberFormat ползва non-breaking space (U+00A0) като group
    // separator (напр. "50 000") — нормализираме към обикновен space
    // за текстовите сравнения тук.
    const text = ((await card(page).textContent()) ?? '').replace(/ /g, ' ')
    assert(!text.includes('Хелоуин 2026'), 'campaign name must not be shown inside the compact card')
    assert(text.includes('50 000'), 'missing reward amount 50 000')
    assert(text.includes('+1'), 'missing "+1" for the second reward on the same tier')
    assert(text.includes('347/500'), 'missing numeric progress "347/500"')
    // Компактен дизайн: без поясняващи текстове (само име, награда, прогрес, бар, бутон).
    for (const removed of ['Твоят прогрес', '347 тикви', 'получаваш', 'жълтици', 'до следващата награда']) {
      assert(!text.includes(removed), `compact card must not contain "${removed}"`)
    }
    assert(text.trim().startsWith('Събирай'), 'card title must be just "Събирай" (+ icon)')
    assert(text.includes('Всяка спечелена игра или покупка ви носи тикви'), 'missing hint "Всяка спечелена игра или покупка ви носи <единици>"')
    // Първи ред: следващата награда е преди числовия прогрес.
    const rewardsIndex = text.indexOf('50 000')
    const progressIndex = text.indexOf('347/500')
    assert(rewardsIndex !== -1 && progressIndex !== -1 && rewardsIndex < progressIndex, 'rewards must appear before numeric progress')
  })

  await check(`[${viewportLabel}] [D2] active:null -> карето не се показва`, async () => {
    await mount(page, { own: true, summary: { active: null, lastFinished: activeSummary347of500.lastFinished } })
    assert((await card(page).count()) === 0, 'expected no campaign card when active=null')
  })

  await check(`[${viewportLabel}] [D3] summary=null -> нито каре, нито горна навигация`, async () => {
    await mount(page, { own: true, summary: null })
    assert((await card(page).count()) === 0, 'expected no campaign card')
    assert((await page.locator('[data-player-profile-nav-bar="1"]').count()) === 0, 'expected no nav bar when summary=null')
  })

  await check(`[${viewportLabel}] [D4] Компактен прогрес 1/10 с иконка и число на жълтиците`, async () => {
    await mount(page, { own: true, summary: singleUnitSummary })
    const text = (await card(page).textContent()) ?? ''
    assert(text.includes('1/10') && text.includes('500'), `expected "1/10" and "500", got: ${text}`)
    assert((await card(page).locator('[data-player-profile-campaign-next-rewards="1"] img[src*="icon-coin"]').count()) === 1, 'expected coin icon next to the reward amount')
  })

  await check(`[${viewportLabel}] [D5] Всички прагове изпълнени -> "Всички награди са получени!"`, async () => {
    await mount(page, { own: true, summary: allTiersGrantedSummary })
    const text = (await card(page).textContent()) ?? ''
    assert(text.includes('Всички награди са получени!'), `expected completion message, got: ${text}`)
  })

  await check(`[${viewportLabel}] [D6] Pending (не locked) награда -> подаръкът в картата, "Очаква предоставяне" в списъка с награди`, async () => {
    await mount(page, { own: true, summary: pendingRewardSummary })
    const text = (await card(page).textContent()) ?? ''
    assert(text.includes('Златна тиква') && text.includes('50/50'), `expected real gift item name and "50/50", got: ${text}`)
    await page.evaluate(() => (window as any).__campaignProfilePopupHarness.clickViewAllRewards())
    const panel = page.locator('[data-player-profile-campaign-all-rewards-panel="1"]')
    await panel.waitFor({ state: 'visible' })
    assert(((await panel.textContent()) ?? '').includes('Очаква предоставяне'), 'expected pending status in all-rewards panel')
  })

  await check(`[${viewportLabel}] [D7] "Виж всички награди" — реален click wiring разгъва с коректни статуси`, async () => {
    await mount(page, { own: true, summary: activeSummary347of500 })
    const panelBefore = page.locator('[data-player-profile-campaign-all-rewards-panel="1"]')
    assert((await panelBefore.count()) === 0, 'expected panel collapsed initially')
    const toggleCountBefore = await page.evaluate(() => (window as any).__campaignProfilePopupHarness.getCampaignViewAllRewardsToggleCount())
    await page.evaluate(() => (window as any).__campaignProfilePopupHarness.clickViewAllRewards())
    const toggleCountAfter = await page.evaluate(() => (window as any).__campaignProfilePopupHarness.getCampaignViewAllRewardsToggleCount())
    assert(toggleCountAfter === toggleCountBefore + 1, 'expected real click to invoke onCampaignViewAllRewardsToggle exactly once')
    const panelAfter = page.locator('[data-player-profile-campaign-all-rewards-panel="1"]')
    await panelAfter.waitFor({ state: 'visible' })
    const panelText = (await panelAfter.textContent()) ?? ''
    assert(panelText.includes('Получена'), 'expected granted status text in all-rewards panel')
    assert(panelText.includes('3 VIP'), 'expected VIP days reward in all-rewards panel')
    assert(panelText.includes('Заключена'), 'expected locked status text in all-rewards panel')
    const tierRows = page.locator('[data-player-profile-campaign-tier-row="1"]')
    assert((await tierRows.count()) === 2, `expected 2 tier rows, got ${await tierRows.count()}`)
  })

  await check(`[${viewportLabel}] [D8] Свиване връща бутона към "Виж всички награди"`, async () => {
    await mount(page, { own: true, summary: activeSummary347of500 })
    await page.evaluate(() => (window as any).__campaignProfilePopupHarness.clickViewAllRewards())
    await page.locator('[data-player-profile-campaign-all-rewards-panel="1"]').waitFor({ state: 'visible' })
    await page.evaluate(() => (window as any).__campaignProfilePopupHarness.clickViewAllRewards())
    assert((await page.locator('[data-player-profile-campaign-all-rewards-panel="1"]').count()) === 0, 'expected panel collapsed again')
    const btnText = await page.locator('[data-player-profile-campaign-view-all-rewards="1"]').textContent()
    assert(btnText === 'Виж всички награди', `expected collapsed button text, got "${btnText}"`)
  })

  await check(`[${viewportLabel}] [D9] Горна навигация "Кампании" -> последна приключила кампания`, async () => {
    await mount(page, { own: true, summary: activeSummary347of500 })
    const historyPanelBefore = page.locator('[data-player-profile-campaign-history-panel="1"]')
    assert((await historyPanelBefore.count()) === 0, 'expected history panel collapsed initially')
    const navClickCountBefore = await page.evaluate(() => (window as any).__campaignProfilePopupHarness.getCampaignsNavClickCount())
    await page.evaluate(() => (window as any).__campaignProfilePopupHarness.clickCampaignsNav())
    const navClickCountAfter = await page.evaluate(() => (window as any).__campaignProfilePopupHarness.getCampaignsNavClickCount())
    assert(navClickCountAfter === navClickCountBefore + 1, 'expected real click to invoke onCampaignsNavClick exactly once')
    const historyPanel = page.locator('[data-player-profile-campaign-history-panel="1"]')
    await historyPanel.waitFor({ state: 'visible' })
    const text = (await historyPanel.textContent()) ?? ''
    assert(text.includes('Хелоуин 2026'), 'missing last finished campaign name')
    assert(text.includes('Общо събрани: 1274 тикви'), `missing last finished totals line, got: ${text}`)
  })

  await check(`[${viewportLabel}] [D10] "Няма предишна кампания" — graceful когато lastFinished=null`, async () => {
    await mount(page, { own: true, summary: noLastFinishedButActiveSummary })
    await page.evaluate(() => (window as any).__campaignProfilePopupHarness.clickCampaignsNav())
    const historyPanel = page.locator('[data-player-profile-campaign-history-panel="1"]')
    await historyPanel.waitFor({ state: 'visible' })
    const text = (await historyPanel.textContent()) ?? ''
    assert(text.includes('Няма предишна приключила кампания'), `expected graceful empty-state text, got: ${text}`)
  })

  await check(`[${viewportLabel}] [D11] Собствен и чужд профил — и двата показват campaignSummary`, async () => {
    await mount(page, { own: true, summary: activeSummary347of500 })
    assert((await card(page).count()) === 1, 'expected card for own profile')
    await mount(page, { own: false, summary: activeSummary347of500 })
    assert((await card(page).count()) === 1, 'expected card for foreign profile too')
  })
}

async function run(): Promise<void> {
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

    await page.goto(`http://127.0.0.1:${port}/scripts/fixtures/campaignProfilePopupHarness.html`)
    await page.waitForFunction(() => (window as any).__campaignProfilePopupHarness?.mount !== undefined, undefined, {
      timeout: 10_000,
    })

    await runScenarios(page, viewport.label)

    await check(`[${viewport.label}] [D12] Няма JS грешки, без хоризонтален overflow`, async () => {
      assert(jsErrors.length === 0, `JS грешки: ${jsErrors.join('; ')}`)
      await mount(page, { own: true, summary: activeSummary347of500 })
      const overflowsX = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)
      assert(!overflowsX, 'expected no horizontal page overflow')
    })

    await context.close()
  }

  await browser.close()
  await vite.close()

  console.log(`\n${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exitCode = 1
}

await run()
