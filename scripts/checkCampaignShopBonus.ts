/**
 * checkCampaignShopBonus.ts
 *
 * "+X <икона на кампанията>" до пакетите в магазина (real
 * createLobbyFlowController + renderLobbyScreen в Chromium през Vite).
 * X идва САМО от active_campaign_theme.packageUnits (сървърът го чете от
 * campaign_package_earn_rules на активната кампания).
 *
 *  [1] Пакет с правило -> "+20" + реалната иконка; пакет без правило -> нищо.
 *  [2] VIP и комплекти с правило също показват бонуса; без правило -> нищо.
 *  [3] Кампанията е изключена (theme=null) -> никакви бонуси, без reload.
 *  [4] Смяна на кампанията -> новите стойности, без остарели бонуси.
 *  [5] Mobile 360px -> бонусът е в рамките на картата, без хоризонтален overflow.
 *
 * Usage: npx tsx scripts/checkCampaignShopBonus.ts
 */
import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright'
import { createServer as createNetServer } from 'node:net'

let passed = 0
let failed = 0
async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    passed++
    console.log(`  PASS  ${label}`)
  } catch (err) {
    failed++
    console.error(`  FAIL  ${label}: ${err instanceof Error ? err.message : String(err)}`)
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
      if (address === null || typeof address === 'string') return reject(new Error('no free port'))
      srv.close(() => resolve(address.port))
    })
  })
}

type Badge = { key: string; text: string; iconSrc: string | null }
const call = <T>(page: Page, fn: string, ...args: unknown[]): Promise<T> =>
  page.evaluate(([f, a]) => (window as any).__campaignShopBonusHarness[f as string](...(a as unknown[])), [fn, args] as const)

const ICON = '/assets/lobby/icon-coin.png'
const baseTheme = { unitIconUrl: ICON, tableBgDesktopUrl: null, tableBgMobileUrl: null, cardBackUrl: null }
const halloween = { ...baseTheme, packageUnits: { coins_big: 20, bundle_gold: 15, vip_30: 5 } }
const otherCampaign = { ...baseTheme, packageUnits: { coins_big: 7 } }

async function openHarness(page: Page, errors: string[]): Promise<void> {
  page.on('pageerror', (err) => errors.push(err.message))
  await page.goto('/scripts/fixtures/campaignShopBonusHarness.html')
  await page.waitForFunction(() => (window as any).__campaignShopBonusHarness !== undefined, undefined, { timeout: 15_000 })
}

console.log('\n═══ checkCampaignShopBonus ═══\n')

let vite: ViteDevServer | null = null
let browser: Browser | null = null
try {
  const port = await findFreePort()
  vite = await createViteServer({ root: process.cwd(), server: { port, strictPort: true, host: '127.0.0.1' }, logLevel: 'error' })
  await vite.listen()
  browser = await chromium.launch()
  const errors: string[] = []

  const desktop = await browser.newContext({ baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1280, height: 900 } })
  const page = await desktop.newPage()
  await openHarness(page, errors)

  await check('[1] Пакет с правило -> "+20" + иконка на кампанията; пакет без правило -> без бонус', async () => {
    await call(page, 'pushTheme', halloween)
    await call(page, 'openShopTab', 'coins')
    const badges = await call<Badge[]>(page, 'badges')
    const big = badges.filter((b) => b.key === 'coins_big')
    assert(big.length >= 1, `expected a badge for coins_big, got ${JSON.stringify(badges)}`)
    assert(big.every((b) => b.text === '+20' && b.iconSrc === ICON), `wrong badge: ${JSON.stringify(big)}`)
    assert(!badges.some((b) => b.key === 'coins_small'), `package without a rule must not show units: ${JSON.stringify(badges)}`)
  })

  await check('[2] VIP и комплект с правило -> бонус; VIP без правило -> нищо', async () => {
    await call(page, 'openShopTab', 'vip')
    const vip = await call<Badge[]>(page, 'badges')
    assert(vip.some((b) => b.key === 'vip_30' && b.text === '+5'), `expected +5 on vip_30, got ${JSON.stringify(vip)}`)
    assert(!vip.some((b) => b.key === 'vip_180'), `vip_180 has no rule: ${JSON.stringify(vip)}`)
    await call(page, 'openShopTab', 'bundle')
    const bundle = await call<Badge[]>(page, 'badges')
    assert(bundle.some((b) => b.key === 'bundle_gold' && b.text === '+15'), `expected +15 on bundle_gold, got ${JSON.stringify(bundle)}`)
  })

  await check('[3] Изключена кампания (theme=null) -> магазинът без бонуси, без reload', async () => {
    await call(page, 'openShopTab', 'coins')
    await call(page, 'pushTheme', null)
    const badges = await call<Badge[]>(page, 'badges')
    assert(badges.length === 0, `expected no badges, got ${JSON.stringify(badges)}`)
  })

  await check('[4] Смяна на кампанията -> новите стойности, без остарели бонуси', async () => {
    await call(page, 'pushTheme', halloween)
    await call(page, 'pushTheme', otherCampaign)
    const coins = await call<Badge[]>(page, 'badges')
    assert(coins.length >= 1 && coins.every((b) => b.key === 'coins_big' && b.text === '+7'), `expected only +7, got ${JSON.stringify(coins)}`)
    await call(page, 'openShopTab', 'vip')
    assert((await call<Badge[]>(page, 'badges')).length === 0, 'stale VIP bonus after campaign switch')
    await call(page, 'openShopTab', 'bundle')
    assert((await call<Badge[]>(page, 'badges')).length === 0, 'stale bundle bonus after campaign switch')
  })
  await desktop.close()

  await check('[5] Mobile 360px -> бонусът е в картата, без хоризонтален overflow (жълтици, VIP, комплект)', async () => {
    const mobile = await browser!.newContext({ baseURL: `http://127.0.0.1:${port}`, viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true })
    const m = await mobile.newPage()
    await openHarness(m, errors)
    await call(m, 'pushTheme', halloween)
    for (const tab of ['coins', 'vip', 'bundle'] as const) {
      await call(m, 'openShopTab', tab)
      const result = await m.evaluate(() => {
        const badges = [...document.querySelectorAll<HTMLElement>('[data-shop-campaign-units]')].filter((el) => el.getClientRects().length > 0)
        const problems: string[] = []
        for (const badge of badges) {
          const r = badge.getBoundingClientRect()
          let card: HTMLElement | null = badge.parentElement
          while (card && parseFloat(getComputedStyle(card).borderTopWidth) === 0) card = card.parentElement
          const c = card?.getBoundingClientRect()
          if (!c) { problems.push(`${badge.dataset.shopCampaignUnits}: no card`); continue }
          if (r.right > c.right + 0.5 || r.left < c.left - 0.5) problems.push(`${badge.dataset.shopCampaignUnits}: badge ${Math.round(r.left)}-${Math.round(r.right)} outside card ${Math.round(c.left)}-${Math.round(c.right)}`)
        }
        return { count: badges.length, problems, pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 }
      })
      assert(result.count >= 1, `${tab}: expected at least one visible badge`)
      assert(result.problems.length === 0, `${tab}: ${result.problems.join('; ')}`)
      assert(!result.pageOverflow, `${tab}: horizontal page overflow`)
      if (process.env.SHOP_BONUS_SHOTS_DIR) await m.waitForTimeout(2500).then(() => m.screenshot({ path: `${process.env.SHOP_BONUS_SHOTS_DIR}/shop-bonus-360-${tab}.png` }))
    }
    await mobile.close()
  })

  await check('Няма JS грешки', () => {
    assert(errors.length === 0, `page errors: ${errors.join('; ')}`)
  })
} finally {
  if (browser) await browser.close()
  if (vite) await vite.close()
}

console.log(`\nPassed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
