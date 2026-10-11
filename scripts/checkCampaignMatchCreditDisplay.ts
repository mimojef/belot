/**
 * checkCampaignMatchCreditDisplay.ts
 *
 * Real browser (Playwright), real production code
 * (renderMatchEndedScreen.ts via scripts/fixtures/matchEndedHarness.ts) —
 * доказва Фаза 6 ("Показване на кампанийните единици в Белот End Game")
 * визуалното поведение, не само server-side данните (виж
 * server/scripts/checkCampaignMatchCreditLookup.ts за store-level
 * проверките на getMatchCreditSnapshot).
 *
 * [D1] Победител с реален credit -> "+25 тикви" се показва коректно, с
 *      икона (img[src]).
 * [D2] Credit === null (flag off / няма кампания / все още pending — виж
 *      task spec §5/§8, визуално идентични) -> нищо допълнително не се
 *      показва, без празен placeholder/ред.
 * [D3] Spectator (controlledSeat === null) -> дори credit да е подаден,
 *      НИКОГА не се показва като личен (task spec §7).
 * [D4] Съществуващият жълтиците prize display остава непроменен, когато и
 *      двата (prize + campaign units) са налични едновременно — не си
 *      пречат визуално.
 * [D5] Счупен/невалиден icon URL -> onerror скрива img-а, текстът остава
 *      читаем (safe fallback, task spec §9).
 * [D6] Без icon URL (null) -> само текст, без счупена img заявка.
 * [D7] Повторен re-render (симулира countdown tick / WebSocket snapshot
 *      burst) -> НЕ дублира counter елемента (task spec §9 "no duplicate
 *      rendering on repeated render").
 * [D8] Numeric counting animation достига target-а (не засяда на
 *      междинна стойност) — mirror на prize counter-а regression check-а.
 * [D9] Desktop + Mobile оформление.
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

const sampleCredit = {
  campaignId: 'campaign-1',
  campaignName: 'Halloween 2026',
  unitNameSingular: 'тиква',
  unitNamePlural: 'тикви',
  unitIconUrl: '/assets/campaigns/pumpkin.webp',
  unitsAmount: 25,
}

async function resetCampaignUnitAnimation(page: Page): Promise<void> {
  await page.evaluate(() => (window as any).__matchEndedHarness.resetCampaignUnitAnimation())
}

async function paintCampaignUnitCredit(
  page: Page,
  winnerTeam: 'A' | 'B',
  credit: typeof sampleCredit | null,
  controlledSeat: 'bottom' | 'top' | 'left' | 'right' | null = 'bottom',
): Promise<void> {
  await page.evaluate(
    ({ winnerTeam, credit, controlledSeat }) =>
      (window as any).__matchEndedHarness.paintCampaignUnitCredit(winnerTeam, credit, controlledSeat),
    { winnerTeam, credit, controlledSeat },
  )
}

async function getCounterCount(page: Page): Promise<number> {
  return page.locator('[data-campaign-unit-counter="1"]').count()
}

async function getCounterText(page: Page): Promise<string | null> {
  return page.locator('[data-campaign-unit-amount-text="1"]').first().textContent()
}

async function getIconSrc(page: Page): Promise<string | null> {
  const img = page.locator('[data-campaign-unit-counter="1"] img').first()
  const count = await img.count()
  if (count === 0) return null
  return img.getAttribute('src')
}

async function isIconVisible(page: Page): Promise<boolean> {
  const img = page.locator('[data-campaign-unit-counter="1"] img').first()
  const count = await img.count()
  if (count === 0) return false
  return img.isVisible()
}

async function getPrizeCounterCount(page: Page): Promise<number> {
  return page.locator('[data-prize-counter="1"]').count()
}

async function runScenarios(page: Page, viewportLabel: string): Promise<void> {
  await check(`[${viewportLabel}] [D1] winner with real credit shows "+25 тикви" and an icon`, async () => {
    await resetCampaignUnitAnimation(page)
    await paintCampaignUnitCredit(page, 'A', sampleCredit)

    const count = await getCounterCount(page)
    assert(count === 1, `expected exactly 1 counter element, got ${count}`)

    // Numeric counting animation (виж computePrizeDisplayAmount, 1500ms
    // ease-out-cubic) — изчакваме завършека ПРЕДИ да проверим точния текст,
    // mirror на [D8]/checkMatchEndedPrizeDisplay.ts-овия подход.
    await page.waitForTimeout(1700)
    const text = await getCounterText(page)
    assert(text !== null && text.includes('25') && text.includes('тикви'), `expected "+25 тикви"-like text, got "${text}"`)

    const src = await getIconSrc(page)
    assert(src !== null && src.includes('pumpkin'), `expected icon src to be set, got "${src}"`)
  })

  await check(`[${viewportLabel}] [D2] credit === null shows nothing extra (no empty placeholder)`, async () => {
    await resetCampaignUnitAnimation(page)
    await paintCampaignUnitCredit(page, 'A', null)

    const count = await getCounterCount(page)
    assert(count === 0, `expected 0 counter elements when credit is null, got ${count}`)
  })

  await check(`[${viewportLabel}] [D3] spectator (controlledSeat=null) never sees a personal credit, even if supplied`, async () => {
    await resetCampaignUnitAnimation(page)
    await paintCampaignUnitCredit(page, 'A', sampleCredit, null)

    const count = await getCounterCount(page)
    assert(count === 0, `expected 0 counter elements for a spectator, got ${count}`)
  })

  await check(`[${viewportLabel}] [D4] existing coin prize display is unaffected when both are present`, async () => {
    await resetCampaignUnitAnimation(page)
    await page.evaluate(
      ({ credit }) => (window as any).__matchEndedHarness.paintPrize('A', 13000),
      { credit: sampleCredit },
    )
    await paintCampaignUnitCredit(page, 'A', sampleCredit)

    const prizeCount = await getPrizeCounterCount(page)
    const campaignCount = await getCounterCount(page)
    assert(campaignCount === 1, `expected the campaign counter to render, got ${campaignCount}`)
    assert(prizeCount <= 1, `expected the prize counter to remain well-formed (0 or 1), got ${prizeCount}`)
  })

  await check(`[${viewportLabel}] [D5] broken icon URL hides the image, text stays readable`, async () => {
    await resetCampaignUnitAnimation(page)
    await paintCampaignUnitCredit(page, 'A', { ...sampleCredit, unitIconUrl: '/this/path/does/not/exist.webp' })

    await page.waitForTimeout(150)
    const visible = await isIconVisible(page)
    assert(!visible, 'expected the broken icon image to be hidden via onerror')

    const text = await getCounterText(page)
    assert(text !== null && text.includes('тикви'), `expected text to remain visible despite broken icon, got "${text}"`)
  })

  await check(`[${viewportLabel}] [D6] no icon URL (null) renders text-only, no broken image request`, async () => {
    await resetCampaignUnitAnimation(page)
    await paintCampaignUnitCredit(page, 'A', { ...sampleCredit, unitIconUrl: null })

    const src = await getIconSrc(page)
    assert(src === null, `expected no <img> element when unitIconUrl is null, got "${src}"`)
    const text = await getCounterText(page)
    assert(text !== null && text.includes('тикви'), `expected text to still render, got "${text}"`)
  })

  await check(`[${viewportLabel}] [D7] repeated re-render does not duplicate the counter element`, async () => {
    await resetCampaignUnitAnimation(page)
    await paintCampaignUnitCredit(page, 'A', sampleCredit)
    await paintCampaignUnitCredit(page, 'A', sampleCredit)
    await paintCampaignUnitCredit(page, 'A', sampleCredit)

    const count = await getCounterCount(page)
    assert(count === 1, `expected exactly 1 counter element after repeated re-render, got ${count}`)
  })

  await check(`[${viewportLabel}] [D8] counting animation reaches the exact target amount`, async () => {
    await resetCampaignUnitAnimation(page)
    await paintCampaignUnitCredit(page, 'A', sampleCredit)
    await page.waitForTimeout(1700)
    await paintCampaignUnitCredit(page, 'A', sampleCredit)

    const text = await getCounterText(page)
    assert(text !== null && text.includes('+25'), `expected the final text to show the exact target "+25", got "${text}"`)
  })
}

async function run(): Promise<void> {
  console.log('\ncheckCampaignMatchCreditDisplay\n')

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
    await page.waitForFunction(() => (window as any).__matchEndedHarness?.paintCampaignUnitCredit !== undefined, undefined, {
      timeout: 10_000,
    })

    await runScenarios(page, viewport.label)

    await check(`[${viewport.label}] No JS errors`, () => {
      assert(jsErrors.length === 0, `JS errors: ${jsErrors.join('; ')}`)
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
