/**
 * checkCampaignRewardCongratulationsUi.ts
 *
 * ФАЗА 9 — Real browser (Playwright), REAL production code
 * (renderCampaignRewardCongratulationsPopup.ts, via
 * scripts/fixtures/campaignRewardCongratulationsHarness.ts) — доказва
 * поздравителния popup за действително предоставени кампанийни награди.
 *
 * [D1] Единична награда (жълтици) — "Поздравления!", име на кампания,
 *      "Достигна X тикви!", коректна сума, бутон "Страхотно!".
 * [D2] VIP дни награда — коректно "N VIP дни"/"1 VIP ден" (единствено число).
 * [D3] Подарък — реално изображение + име + "От: <подател>".
 * [D4] Един праг с 3 вида награди (жълтици+VIP+подарък) — всички показани,
 *      без дублиране.
 * [D5] Няколко слети известия (нескол ко прага наведнъж) — генерично
 *      заглавие, ВСИЧКИ награди показани, без загуба.
 * [D6] Няколко еднакви подаръка — "× N" количество, не повторени блокове.
 * [D7] Затваряне ("Страхотно!") -> onClose извикан ТОЧНО веднъж, с
 *      ВСИЧКИТЕ notificationIds от слятата група.
 * [D8] Клик на backdrop -> също затваря (mirror на VIP success popup UX).
 * [D9] Клик ВЪТРЕ в card-а -> НЕ затваря (stopPropagation ефективен).
 * [D10] Счупено изображение на подарък -> fallback (onerror скрива img, без
 *       счупена икона).
 * [D11] Desktop + Mobile оформление — без overflow, без JS грешки,
 *       скролиране при много награди.
 * [D12] Без дублирани listeners — множество mount() извиквания + close не
 *       предизвиква повторни onClose извиквания над очакваното.
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

const singleCoinsGroup = {
  campaignId: 'campaign-1',
  campaignName: 'Хелоуин 2026',
  unitNameSingular: 'тиква',
  unitNamePlural: 'тикви',
  unitsTotal: 500,
  rewards: [{ type: 'yellow_coins', amount: 50_000 }],
  notificationIds: ['n1'],
}

const vipSingularGroup = {
  campaignId: 'campaign-2',
  campaignName: 'Хелоуин 2026',
  unitNameSingular: 'тиква',
  unitNamePlural: 'тикви',
  unitsTotal: 250,
  rewards: [{ type: 'vip_days', interval: { unit: 'days', amount: 1 }, activeUntil: new Date().toISOString() }],
  notificationIds: ['n2'],
}

const vipPluralGroup = {
  ...vipSingularGroup,
  rewards: [{ type: 'vip_days', interval: { unit: 'days', amount: 3 }, activeUntil: new Date().toISOString() }],
}

const giftGroup = {
  campaignId: 'campaign-3',
  campaignName: 'Хелоуин 2026',
  unitNameSingular: 'тиква',
  unitNamePlural: 'тикви',
  unitsTotal: 1000,
  rewards: [{ type: 'gift_item', giftItemId: 'g1', name: 'Златна тиква', imageUrl: '/assets/gifts/golden-pumpkin.webp', senderDisplayName: 'Pika.bg Marketing' }],
  notificationIds: ['n3'],
}

const multiRewardSingleTierGroup = {
  campaignId: 'campaign-4',
  campaignName: 'Хелоуин 2026',
  unitNameSingular: 'тиква',
  unitNamePlural: 'тикви',
  unitsTotal: 1000,
  rewards: [
    { type: 'yellow_coins', amount: 50_000 },
    { type: 'vip_days', interval: { unit: 'days', amount: 3 }, activeUntil: new Date().toISOString() },
    { type: 'gift_item', giftItemId: 'g1', name: 'Златна тиква', imageUrl: '/assets/gifts/golden-pumpkin.webp', senderDisplayName: 'Pika.bg Marketing' },
  ],
  notificationIds: ['n4'],
}

const multiTierMergedGroup = {
  campaignId: 'campaign-5',
  campaignName: 'Хелоуин 2026',
  unitNameSingular: 'тиква',
  unitNamePlural: 'тикви',
  unitsTotal: 530,
  rewards: [
    { type: 'yellow_coins', amount: 10_000 },
    { type: 'yellow_coins', amount: 25_000 },
    { type: 'yellow_coins', amount: 50_000 },
    { type: 'vip_days', interval: { unit: 'days', amount: 3 }, activeUntil: new Date().toISOString() },
  ],
  notificationIds: ['n5', 'n6', 'n7'],
}

const duplicateGiftGroup = {
  campaignId: 'campaign-6',
  campaignName: 'Хелоуин 2026',
  unitNameSingular: 'тиква',
  unitNamePlural: 'тикви',
  unitsTotal: 2000,
  rewards: [
    { type: 'gift_item', giftItemId: 'g1', name: 'Златна тиква', imageUrl: '/assets/gifts/golden-pumpkin.webp', senderDisplayName: 'Pika.bg Marketing' },
    { type: 'gift_item', giftItemId: 'g1', name: 'Златна тиква', imageUrl: '/assets/gifts/golden-pumpkin.webp', senderDisplayName: 'Pika.bg Marketing' },
  ],
  notificationIds: ['n8'],
}

const brokenImageGroup = {
  campaignId: 'campaign-7',
  campaignName: 'Хелоуин 2026',
  unitNameSingular: 'тиква',
  unitNamePlural: 'тикви',
  unitsTotal: 1000,
  rewards: [{ type: 'gift_item', giftItemId: 'g1', name: 'Златна тиква', imageUrl: '/nonexistent-image-404.webp', senderDisplayName: 'Pika.bg Marketing' }],
  notificationIds: ['n9'],
}

async function mount(page: Page, group: typeof singleCoinsGroup): Promise<void> {
  await page.evaluate((g) => (window as any).__campaignRewardCongratulationsHarness.mount(g), group)
}

function card(page: Page) {
  return page.locator('[data-campaign-reward-congratulations-backdrop="1"]')
}

console.log('\ncheckCampaignRewardCongratulationsUi\n')

async function runScenarios(page: Page, viewportLabel: string): Promise<void> {
  await check(`[${viewportLabel}] [D1] Единична награда (жълтици) — коректен текст`, async () => {
    await mount(page, singleCoinsGroup)
    const text = ((await card(page).textContent()) ?? '').replace(/ /g, ' ')
    assert(text.includes('Поздравления!'), 'missing title')
    assert(text.includes('Събрахте 500 тикви!'), `missing collected line, got: ${text}`)
    assert(text.includes('Печелите 50 000 жълтици!'), `missing winnings headline, got: ${text}`)
    assert(text.includes('Наградата ви е начислена.'), `missing credited note, got: ${text}`)
    const noteWeight = await card(page).locator('[data-campaign-congrats-credited-note="1"]').evaluate((el) => getComputedStyle(el).fontWeight)
    assert(Number(noteWeight) <= 400, `credited note must not be bold, got ${noteWeight}`)
    assert(text.indexOf('Поздравления!') < text.indexOf('Събрахте') && text.indexOf('Събрахте') < text.indexOf('Печелите') && text.indexOf('Печелите') < text.indexOf('Наградата ви е начислена.'), `wrong order: ${text}`)
    assert(text.includes('50 000') && text.includes('жълтици'), 'missing coin amount')
    const button = card(page).locator('[data-campaign-reward-congratulations-close="1"]')
    assert(((await button.textContent()) ?? '').trim() === 'ОК', 'close button must be "ОК"')
    assert(!text.includes('Прибери'), 'old "Прибери" text must be gone')
    assert(!text.includes('Страхотно!'), 'old button text must be gone')
  })

  await check(`[${viewportLabel}] [D2] VIP дни — единствено и множествено число`, async () => {
    await mount(page, vipSingularGroup)
    const textSingular = (await card(page).textContent()) ?? ''
    assert(textSingular.includes('1 ден') && !textSingular.includes('1 дни'), `expected "1 ден", got: ${textSingular}`)
    await mount(page, vipPluralGroup)
    const textPlural = (await card(page).textContent()) ?? ''
    assert(textPlural.includes('3 дни'), `expected "3 дни", got: ${textPlural}`)
  })

  await check(`[${viewportLabel}] [D3] Подарък — изображение + име + подател`, async () => {
    await mount(page, giftGroup)
    const text = (await card(page).textContent()) ?? ''
    assert(text.includes('Златна тиква'), 'missing gift name')
    assert(text.includes('От: Pika.bg Marketing'), `missing sender, got: ${text}`)
    const img = card(page).locator('img[alt="Златна тиква"]')
    assert((await img.count()) === 1, 'expected gift image element')
    assert((await img.getAttribute('src')) === '/assets/gifts/golden-pumpkin.webp', 'expected correct image src')
  })

  await check(`[${viewportLabel}] [D4] Един праг, 3 вида награди — всички показани`, async () => {
    await mount(page, multiRewardSingleTierGroup)
    const text = ((await card(page).textContent()) ?? '').replace(/ /g, ' ')
    assert(text.includes('50 000') && text.includes('жълтици'), 'missing coins')
    assert(text.includes('3 дни'), 'missing VIP days')
    assert(text.includes('Златна тиква'), 'missing gift')
    assert(text.includes('Печелите 50 000 жълтици, 3 дни VIP и подарък!'), `mixed headline must list all reward kinds, got: ${text}`)
    const rows = card(page).locator('[data-campaign-congrats-reward-row="1"]')
    assert((await rows.count()) === 3, `expected 3 reward rows, got ${await rows.count()}`)
  })

  await check(`[${viewportLabel}] [D5] Няколко прага наведнъж — един общ popup с всички награди`, async () => {
    await mount(page, multiTierMergedGroup)
    const text = ((await card(page).textContent()) ?? '').replace(/ /g, ' ')
    assert(text.includes('Събрахте 530 тикви!') && text.includes('Печелите 85 000 жълтици и 3 дни VIP!'), `expected one shared popup with summed coins + VIP, got: ${text}`)
    assert(text.includes('10 000') && text.includes('25 000') && text.includes('50 000'), 'missing one or more coin reward lines')
    assert(text.includes('3 дни'), 'missing VIP reward line')
    const rows = card(page).locator('[data-campaign-congrats-reward-row="1"]')
    assert((await rows.count()) === 4, `expected 4 separate reward rows (no merging of coin rewards), got ${await rows.count()}`)
  })

  await check(`[${viewportLabel}] [D6] Няколко еднакви подаръка — "× N" количество, без дублиране`, async () => {
    await mount(page, duplicateGiftGroup)
    const text = (await card(page).textContent()) ?? ''
    assert(text.includes('× 2'), `expected quantity "× 2", got: ${text}`)
    assert(text.includes('Печелите 2 подаръка!') && !text.includes('жълтици!'), `gift-only headline must not claim coins, got: ${text}`)
    const giftRows = card(page).locator('[data-campaign-congrats-reward-row-gift="1"]')
    assert((await giftRows.count()) === 1, `expected exactly 1 gift row (deduplicated), got ${await giftRows.count()}`)
  })

  await check(`[${viewportLabel}] [D7] Затваряне -> onClose точно веднъж, с всичките notificationIds`, async () => {
    await mount(page, multiTierMergedGroup)
    await page.evaluate(() => (window as any).__campaignRewardCongratulationsHarness.clickClose())
    const closeCount = await page.evaluate(() => (window as any).__campaignRewardCongratulationsHarness.getCloseCallCount())
    assert(closeCount === 1, `expected onClose called exactly once, got ${closeCount}`)
    const closedIds = await page.evaluate(() => (window as any).__campaignRewardCongratulationsHarness.getLastClosedNotificationIds())
    assert(JSON.stringify(closedIds) === JSON.stringify(['n5', 'n6', 'n7']), `expected all merged notificationIds, got ${JSON.stringify(closedIds)}`)
    assert(!(await page.evaluate(() => (window as any).__campaignRewardCongratulationsHarness.isOpen())), 'expected popup closed after close')
  })

  await check(`[${viewportLabel}] [D8] Клик на backdrop -> НЕ затваря и НЕ потвърждава (само "ОК")`, async () => {
    await mount(page, singleCoinsGroup)
    const before = await page.evaluate(() => (window as any).__campaignRewardCongratulationsHarness.getCloseCallCount())
    await page.evaluate(() => (window as any).__campaignRewardCongratulationsHarness.clickBackdrop())
    assert(await page.evaluate(() => (window as any).__campaignRewardCongratulationsHarness.isOpen()), 'popup must stay open after backdrop click')
    const after = await page.evaluate(() => (window as any).__campaignRewardCongratulationsHarness.getCloseCallCount())
    assert(after === before, `backdrop click must not call onClose/ack (before=${before}, after=${after})`)
  })

  await check(`[${viewportLabel}] [D13] Динамична икона на единицата от кампанията`, async () => {
    await mount(page, { ...singleCoinsGroup, unitIconUrl: '/assets/lobby/icon-coin.png' })
    const icon = card(page).locator('[data-campaign-congrats-unit-icon="1"]')
    assert((await icon.count()) === 1, 'expected unit icon element')
    assert((await icon.getAttribute('src')) === '/assets/lobby/icon-coin.png', 'unit icon must come from group.unitIconUrl')
    await mount(page, singleCoinsGroup)
    assert((await card(page).locator('[data-campaign-congrats-unit-icon="1"]').count()) === 0, 'no icon element without unitIconUrl')
  })

  await check(`[${viewportLabel}] [D9] Клик ВЪТРЕ в card-а -> НЕ затваря`, async () => {
    await mount(page, singleCoinsGroup)
    await card(page).locator('[data-campaign-congrats-card="1"]').click({ position: { x: 5, y: 5 } })
    assert(await page.evaluate(() => (window as any).__campaignRewardCongratulationsHarness.isOpen()), 'expected popup to remain open after clicking inside the card')
  })

  await check(`[${viewportLabel}] [D10] Счупено изображение на подарък -> fallback, без счупена икона`, async () => {
    await mount(page, brokenImageGroup)
    const img = card(page).locator('img[alt="Златна тиква"]')
    await img.waitFor({ state: 'attached' })
    // Дай на onerror handler-а шанс да сработи (счупен URL).
    await page.waitForTimeout(300)
    const isHidden = await img.evaluate((el) => (el as HTMLImageElement).style.display === 'none')
    assert(isHidden, 'expected broken gift image to be hidden via onerror fallback')
  })

  await check(`[${viewportLabel}] [D12] Без дублирани listeners — многократен mount + close не превишава очакваните извиквания`, async () => {
    await mount(page, singleCoinsGroup)
    await mount(page, singleCoinsGroup)
    await mount(page, singleCoinsGroup)
    await page.evaluate(() => (window as any).__campaignRewardCongratulationsHarness.clickClose())
    const closeCount = await page.evaluate(() => (window as any).__campaignRewardCongratulationsHarness.getCloseCallCount())
    assert(closeCount === 1, `expected exactly 1 close call despite 3 re-mounts, got ${closeCount}`)
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

    await page.goto(`http://127.0.0.1:${port}/scripts/fixtures/campaignRewardCongratulationsHarness.html`)
    await page.waitForFunction(() => (window as any).__campaignRewardCongratulationsHarness?.mount !== undefined, undefined, {
      timeout: 10_000,
    })

    await runScenarios(page, viewport.label)

    await check(`[${viewport.label}] [D11] Няма JS грешки, без хоризонтален overflow`, async () => {
      assert(jsErrors.length === 0, `JS грешки: ${jsErrors.join('; ')}`)
      await mount(page, multiTierMergedGroup)
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
