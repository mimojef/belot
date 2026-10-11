/**
 * checkCampaignRewardCongratulationsCoinPurchase.ts
 *
 * ФАЗА 9.1 — Real browser (Playwright), REAL production code
 * (createLobbyFlowController.ts's campaign-reward-congratulations queue/
 * gating logic, via scripts/fixtures/campaignRewardCongratulationsQueueHarness.ts).
 *
 * Фаза 9's отчет установи пропуск: coin (само жълтици) покупка затваря с
 * transient "+X" overlay анимация (main.ts::showStripeCoinRewardOverlay),
 * без explicit close бутон/callback — за разлика от VIP/bundle (explicit
 * "OK" бутон -> onVipPurchaseSuccessClose), затова поздравлението никога
 * не се опитваше да се покаже след самата анимация, само при следващ
 * connect/reconnect. Fix: showStripeCoinRewardOverlay вече приема
 * onComplete callback (извикан точно след overlay.remove()), а новият
 * getIsCoinRewardOverlayActive option guard-ва isSafeToShowCampaignRewardCongratulations
 * докато анимацията тече (вкл. hold+fade-out фазата), за да не се покаже
 * ВЪРХУ нея.
 *
 * [Q1] Известие пристига ПО ВРЕМЕ на анимацията -> изчаква; след
 *      "анимация приключи" (simulateCoinOverlayComplete, mirror на реалния
 *      onComplete call site) -> popup се показва, БЕЗ reconnect.
 * [Q2] Известие пристига СЛЕД като анимацията вече е приключила ->
 *      показва се веднага, автоматично (без допълнителен trigger call).
 * [Q3] Никога не пристига известие (неуспешна покупка / праг не е
 *      достигнат) -> popup никога не се отваря.
 * [Q4] Друг критичен popup (VIP success) отворен -> известието изчаква;
 *      затварянето му (реален close бутон) автоматично показва
 *      поздравлението веднага след това.
 * [Q5] Затваряне + acknowledgement -> onCampaignRewardNotificationAck
 *      извикан с коректния notificationId; popup не се отваря повторно.
 * [Q6] Повторен realtime push на СЪЩИЯ notificationId (durable redelivery
 *      race) -> без дублиран ред/сума, само ЕДНО copy на наградата.
 * [Q7] Активна игра -> известието изчаква; връщане в лоби показва
 *      поздравлението.
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

const samplePayload = {
  campaignName: 'Хелоуин 2026',
  unitNameSingular: 'тиква',
  unitNamePlural: 'тикви',
  unitsTotal: 500,
  rewards: [{ type: 'yellow_coins', amount: 50_000 }],
}

type H = {
  setCoinRewardOverlayActive: (active: boolean) => Promise<void>
  setInGame: (active: boolean) => Promise<void>
  simulateCoinOverlayComplete: () => Promise<void>
  retryShowCongratulations: () => Promise<void>
  pushNotification: (notificationId: string, campaignId: string, payload: unknown) => Promise<void>
  openVipPurchaseSuccessPopup: () => Promise<void>
  closeVipPurchaseSuccessPopupViaRealButton: () => Promise<void>
  isPopupOpen: () => boolean
  getPopupText: () => string
  clickClose: () => Promise<void>
  getAckedNotificationIds: () => string[]
}

function harness(page: Page) {
  return {
    setCoinRewardOverlayActive: (active: boolean) => page.evaluate((a) => (window as any).__campaignRewardCongratulationsQueueHarness.setCoinRewardOverlayActive(a), active),
    setInGame: (active: boolean) => page.evaluate((a) => (window as any).__campaignRewardCongratulationsQueueHarness.setInGame(a), active),
    simulateCoinOverlayComplete: () => page.evaluate(() => (window as any).__campaignRewardCongratulationsQueueHarness.simulateCoinOverlayComplete()),
    retryShowCongratulations: () => page.evaluate(() => (window as any).__campaignRewardCongratulationsQueueHarness.retryShowCongratulations()),
    pushNotification: (id: string, campaignId: string, payload: unknown) => page.evaluate(
      ({ id, campaignId, payload }) => (window as any).__campaignRewardCongratulationsQueueHarness.pushNotification(id, campaignId, payload),
      { id, campaignId, payload },
    ),
    openVipPurchaseSuccessPopup: () => page.evaluate(() => (window as any).__campaignRewardCongratulationsQueueHarness.openVipPurchaseSuccessPopup()),
    closeVipPurchaseSuccessPopupViaRealButton: () => page.evaluate(() => (window as any).__campaignRewardCongratulationsQueueHarness.closeVipPurchaseSuccessPopupViaRealButton()),
    isPopupOpen: () => page.evaluate(() => (window as any).__campaignRewardCongratulationsQueueHarness.isPopupOpen()),
    getPopupText: () => page.evaluate(() => (window as any).__campaignRewardCongratulationsQueueHarness.getPopupText()),
    clickClose: () => page.evaluate(() => (window as any).__campaignRewardCongratulationsQueueHarness.clickClose()),
    getAckedNotificationIds: () => page.evaluate(() => (window as any).__campaignRewardCongratulationsQueueHarness.getAckedNotificationIds()),
  } satisfies H
}

console.log('\ncheckCampaignRewardCongratulationsCoinPurchase\n')

async function reload(page: Page, port: number): Promise<void> {
  await page.goto(`http://127.0.0.1:${port}/scripts/fixtures/campaignRewardCongratulationsQueueHarness.html`)
  await page.waitForFunction(() => (window as any).__campaignRewardCongratulationsQueueHarness?.pushNotification !== undefined, undefined, { timeout: 10_000 })
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
  const context = await browser.newContext({ viewport: { width: 1280, height: 850 } })
  const page = await context.newPage()
  const jsErrors: string[] = []
  page.on('pageerror', (err) => jsErrors.push(err.message))

  await check('[Q1] Известие по време на анимацията -> изчаква; "анимация приключи" -> показва се, без reconnect', async () => {
    await reload(page, port)
    const h = harness(page)
    await h.setCoinRewardOverlayActive(true)
    await h.pushNotification('coin-n1', 'camp-1', samplePayload)
    assert(!(await h.isPopupOpen()), 'expected popup to wait while the coin overlay animation is active')
    await h.simulateCoinOverlayComplete()
    assert(await h.isPopupOpen(), 'expected popup to show right after the animation completes')
    const text = (await h.getPopupText()).replace(/ /g, ' ')
    assert(text.includes('Хелоуин 2026') && text.includes('50 000'), `expected correct reward content, got: ${text}`)
  })

  await check('[Q2] Известие пристига СЛЕД анимацията -> показва се веднага, автоматично', async () => {
    await reload(page, port)
    const h = harness(page)
    await h.setCoinRewardOverlayActive(true)
    await h.setCoinRewardOverlayActive(false) // animation finished on its own, no congratulations attempt made yet
    await h.pushNotification('coin-n2', 'camp-2', samplePayload)
    assert(await h.isPopupOpen(), 'expected popup to auto-show when the notification arrives after the animation already ended')
  })

  await check('[Q3] Никога не пристига известие (неуспешна покупка / праг не достигнат) -> няма popup', async () => {
    await reload(page, port)
    const h = harness(page)
    await h.setCoinRewardOverlayActive(true)
    await h.simulateCoinOverlayComplete()
    assert(!(await h.isPopupOpen()), 'expected no popup when no notification was ever pushed')
  })

  await check('[Q4] Друг критичен popup (VIP success) отворен -> известието изчаква; затваряне -> показва веднага', async () => {
    await reload(page, port)
    const h = harness(page)
    await h.openVipPurchaseSuccessPopup()
    await h.pushNotification('coin-n4', 'camp-4', samplePayload)
    assert(!(await h.isPopupOpen()), 'expected popup to wait while VIP success popup is open')
    await h.closeVipPurchaseSuccessPopupViaRealButton()
    assert(await h.isPopupOpen(), 'expected congratulations to show right after the VIP popup closes')
  })

  await check('[Q5] Затваряне + acknowledgement -> коректен notificationId, без повторно отваряне', async () => {
    await reload(page, port)
    const h = harness(page)
    await h.pushNotification('coin-n5', 'camp-5', samplePayload)
    assert(await h.isPopupOpen(), 'expected popup to show (nothing blocking)')
    await h.clickClose()
    assert(!(await h.isPopupOpen()), 'expected popup closed after clicking "Страхотно!"')
    const acked = await h.getAckedNotificationIds()
    assert(acked.includes('coin-n5'), `expected notificationId acked, got: ${JSON.stringify(acked)}`)
  })

  await check('[Q6] Повторен realtime push на СЪЩИЯ notificationId -> без дублирана сума/ред', async () => {
    await reload(page, port)
    const h = harness(page)
    await h.setCoinRewardOverlayActive(true)
    await h.pushNotification('coin-n6', 'camp-6', samplePayload)
    await h.pushNotification('coin-n6', 'camp-6', samplePayload) // duplicate redelivery race
    await h.simulateCoinOverlayComplete()
    assert(await h.isPopupOpen(), 'expected popup to show')
    const rows = await page.locator('[data-campaign-congrats-reward-row="1"]').count()
    assert(rows === 1, `expected exactly 1 reward row (no duplication), got ${rows}`)
    await h.clickClose()
    const acked = await h.getAckedNotificationIds()
    const ackCountForThisId = acked.filter((id) => id === 'coin-n6').length
    assert(ackCountForThisId === 1, `expected notificationId acked exactly once, got ${ackCountForThisId}`)
  })

  await check('[Q7] Активна игра -> известието изчаква; връщане в лоби показва поздравлението', async () => {
    await reload(page, port)
    const h = harness(page)
    await h.setInGame(true)
    await h.pushNotification('coin-n7', 'camp-7', samplePayload)
    assert(!(await h.isPopupOpen()), 'expected popup to wait while in an active game')
    await h.setInGame(false)
    await h.retryShowCongratulations() // mirrors the real "returned to lobby" trigger call site
    assert(await h.isPopupOpen(), 'expected congratulations to show after returning to the lobby')
  })

  await check('Няма JS грешки по време на сценариите', () => {
    assert(jsErrors.length === 0, `JS грешки: ${jsErrors.join('; ')}`)
  })

  await context.close()
  await browser.close()
  await vite.close()

  console.log(`\n${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exitCode = 1
}

await run()
