/**
 * checkAdminCampaignArchivePanelUi.ts
 *
 * Фаза 11 §14 (тестове #31/#32/#39/#40) — Real browser (Playwright), real
 * production code (renderAdminCampaignArchivePanel.ts +
 * attachAdminCampaignArchivePanelHandlers), synthetic state (mirror на
 * established biddingBoardLifecycleHarness.ts подход — UI wiring под тест,
 * не HTTP/auth слоя, вече покрит от checkCampaignArchiveHttp.ts).
 *
 *   [1] Празен списък -> "Няма приключили кампании."
 *   [2] Списък с 2 реда (архивирана + чакаща) -> правилни badge-ове/totals.
 *   [3] Клик "Виж резултатите" -> onSelect с правилния campaignId.
 *   [4] Detail: finished-но-неархивирана -> readiness банер с pending списък
 *       + "Архивирай сега" бутон disabled, когато ready=false.
 *   [5] Detail: ready=true -> бутонът е enabled.
 *   [6] Клик "Архивирай сега" -> onArchiveNow.
 *   [7] Detail: архивирана -> Топ 10 таблица с правилни редове, вкл.
 *       "(изтрит профил)" маркер за profileId:null.
 *   [8] "Затвори" -> onCloseDetail.
 *   [9] "Назад към Кампании" -> onBack.
 *   [10] Desktop + Mobile оформление — без JS грешки.
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
  return new Promise((resolveFree, reject) => {
    const srv = createNetServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      if (address === null || typeof address === 'string') { reject(new Error('no port')); return }
      const { port } = address
      srv.close(() => resolveFree(port))
    })
  })
}

type H = {
  render: (state: unknown, isMobile?: boolean) => void
  baseState: (overrides?: Record<string, unknown>) => Record<string, unknown>
  getCalls: () => Array<{ name: string; args: unknown[] }>
  clickSelector: (selector: string) => boolean
  rowCount: () => number
  hasDetail: () => boolean
  bodyText: () => string
}

async function call<T>(page: Page, fn: (h: H, arg: any) => T, arg: any = undefined): Promise<T> {
  return page.evaluate(
    ({ fn: fnStr, arg: a }) => {
      const h = (window as any).__adminCampaignArchivePanelHarness as H
      // eslint-disable-next-line no-eval
      const resolved = (0, eval)(fnStr) as (h: H, arg: any) => T
      return resolved(h, a)
    },
    { fn: fn.toString(), arg },
  )
}

console.log('\ncheckAdminCampaignArchivePanelUi')

let vite: ViteDevServer | null = null
let browser: Browser | null = null

try {
  const port = await findFreePort()
  vite = await createViteServer({ root: process.cwd(), server: { port, strictPort: true, host: '127.0.0.1' }, logLevel: 'error' })
  await vite.listen()
  const baseUrl = `http://127.0.0.1:${port}/scripts/fixtures/adminCampaignArchivePanelHarness.html`

  browser = await chromium.launch()

  async function newPage(viewport = { width: 1280, height: 900 }): Promise<Page> {
    const context = await browser!.newContext({ viewport })
    const page = await context.newPage()
    const pageErrors: string[] = []
    page.on('pageerror', (e) => pageErrors.push(e.message))
    await page.goto(baseUrl)
    await page.waitForFunction(() => (window as any).__adminCampaignArchivePanelHarness !== undefined, undefined, { timeout: 10_000 })
    if (pageErrors.length > 0) throw new Error(`page errors during setup: ${pageErrors.join(' | ')}`)
    ;(page as any).__pageErrors = pageErrors
    return page
  }
  function assertNoPageErrors(page: Page, label: string): void {
    const errors = (page as any).__pageErrors as string[]
    assert(errors.length === 0, `${label}: ${errors.join(' | ')}`)
  }

  const page = await newPage()

  await check('[1] Празен списък -> "Няма приключили кампании."', async () => {
    const state = await call(page, (h: H) => h.baseState())
    await call(page, (h: H, s: unknown) => h.render(s), state)
    const text = await call(page, (h: H) => h.bodyText())
    assert(text.includes('Няма приключили кампании'), text)
    assertNoPageErrors(page, '[1]')
  })

  const sampleList = [
    { campaignId: 'camp-archived', name: 'Хелоуин 2026', status: 'finished', startsAt: '2026-10-20T00:00:00Z', endsAt: '2026-11-02T00:00:00Z', unitNameSingular: 'тиква', unitNamePlural: 'тикви', archivedAt: '2026-11-02T01:00:00Z', totalUnits: 1_250_000, participantsCount: 842 },
    { campaignId: 'camp-pending', name: 'Зимна 2026', status: 'stopped', startsAt: '2026-12-01T00:00:00Z', endsAt: '2026-12-31T00:00:00Z', unitNameSingular: 'снежинка', unitNamePlural: 'снежинки', archivedAt: null, totalUnits: null, participantsCount: null },
  ]

  await check('[2] Списък с 2 реда -> правилни badge-ове/totals', async () => {
    const state = await call(page, (h: H, list: unknown) => h.baseState({ adminCampaignArchiveList: list }), sampleList)
    await call(page, (h: H, s: unknown) => h.render(s), state)
    assert((await call(page, (h: H) => h.rowCount())) === 2, 'rowCount')
    const text = await call(page, (h: H) => h.bodyText())
    assert(text.includes('Хелоуин 2026') && text.includes('1 250 000'), text)
    assert(text.includes('Зимна 2026') && text.includes('очаква reconciliation/архивиране'), text)
    assertNoPageErrors(page, '[2]')
  })

  await check('[3] Клик "Виж резултатите" -> onSelect с правилния campaignId', async () => {
    const clicked = await call(page, (h: H) => h.clickSelector('[data-admin-campaign-archive-view="camp-archived"]'))
    assert(clicked, 'бутонът трябва да съществува')
    const calls = await call(page, (h: H) => h.getCalls())
    const selectCall = calls.find((c) => c.name === 'onSelect')
    assert(selectCall !== undefined && selectCall.args[0] === 'camp-archived', JSON.stringify(calls))
  })

  await check('[4] Detail: finished-но-неархивирана, ready=false -> readiness банер + бутон disabled', async () => {
    const state = await call(page, (h: H, list: unknown) => h.baseState({
      adminCampaignArchiveList: list,
      adminCampaignArchiveSelectedId: 'camp-pending',
      adminCampaignArchiveDetail: { ok: true, archived: false, ready: false, readiness: { pendingBelotWin: 3, pendingBelotLegacy: 0, pendingLudoWin: 0, pendingPurchaseCoin: 1, pendingPurchaseBundle: 0, pendingPurchaseVip: 0, pendingGiftRewardGaps: 2 } },
    }), sampleList)
    await call(page, (h: H, s: unknown) => h.render(s), state)
    const text = await call(page, (h: H) => h.bodyText())
    assert(text.includes('все още чака'), text)
    assert(text.includes('Белот начисления: 3'), text)
    assert(text.includes('Дължими награди: 2'), text)
    const disabledAttr = await page.evaluate(() => document.querySelector('[data-admin-campaign-archive-now]')?.hasAttribute('disabled'))
    assert(disabledAttr === true, 'бутонът трябва да е disabled, докато ready=false')
    assertNoPageErrors(page, '[4]')
  })

  await check('[5] Detail: ready=true -> бутонът е enabled', async () => {
    const state = await call(page, (h: H, list: unknown) => h.baseState({
      adminCampaignArchiveList: list,
      adminCampaignArchiveSelectedId: 'camp-pending',
      adminCampaignArchiveDetail: { ok: true, archived: false, ready: true, readiness: { pendingBelotWin: 0, pendingBelotLegacy: 0, pendingLudoWin: 0, pendingPurchaseCoin: 0, pendingPurchaseBundle: 0, pendingPurchaseVip: 0, pendingGiftRewardGaps: 0 } },
    }), sampleList)
    await call(page, (h: H, s: unknown) => h.render(s), state)
    const disabledAttr = await page.evaluate(() => document.querySelector('[data-admin-campaign-archive-now]')?.hasAttribute('disabled'))
    assert(disabledAttr === false, 'бутонът НЕ трябва да е disabled, когато ready=true')
  })

  await check('[6] Клик "Архивирай сега" -> onArchiveNow', async () => {
    await page.evaluate(() => { window.confirm = () => true })
    const clicked = await call(page, (h: H) => h.clickSelector('[data-admin-campaign-archive-now]'))
    assert(clicked, 'бутонът трябва да съществува')
    const calls = await call(page, (h: H) => h.getCalls())
    const archiveCall = calls.find((c) => c.name === 'onArchiveNow')
    assert(archiveCall !== undefined && archiveCall.args[0] === 'camp-pending', JSON.stringify(calls))
  })

  const archivedTop10 = [
    { rank: 1, profileId: 'p1', displayNameAtArchive: 'Иван', rankTitleAtArchive: 'Майстор', unitsTotal: 15430 },
    { rank: 2, profileId: 'p2', displayNameAtArchive: 'Мария', rankTitleAtArchive: 'Чирак', unitsTotal: 14210 },
    { rank: 3, profileId: null, displayNameAtArchive: 'Георги', rankTitleAtArchive: null, unitsTotal: 13900 },
  ]

  await check('[7] Detail: архивирана -> Топ 10 таблица, "(изтрит профил)" маркер за profileId:null', async () => {
    const state = await call(page, (h: H, arg: { list: unknown; top10: unknown }) => h.baseState({
      adminCampaignArchiveList: arg.list,
      adminCampaignArchiveSelectedId: 'camp-archived',
      adminCampaignArchiveDetail: {
        ok: true, archived: true,
        detail: {
          campaignId: 'camp-archived', name: 'Хелоуин 2026', startsAt: '2026-10-20T00:00:00Z', endsAt: '2026-11-02T00:00:00Z',
          unitNameSingular: 'тиква', unitNamePlural: 'тикви',
          summary: { campaignId: 'camp-archived', endedReason: 'expired', participantsCount: 842, totalUnits: 1_250_000, unitsFromBelot: 1_000_000, unitsFromLudo: 200_000, unitsFromPurchases: 50_000, unitsFromAdminAdjustments: 0, rewardsGrantedCount: 500, unitIconUrlAtArchive: null, archivedAt: '2026-11-02T01:00:00Z' },
          top10: arg.top10,
        },
      },
    }), { list: sampleList, top10: archivedTop10 })
    await call(page, (h: H, s: unknown) => h.render(s), state)
    assert(await call(page, (h: H) => h.hasDetail()), 'трябва да има таблица')
    const text = await call(page, (h: H) => h.bodyText())
    assert(text.includes('Иван') && text.includes('15 430'), text)
    assert(text.includes('Георги') && text.includes('(изтрит профил)'), text)
    assert(text.includes('1 250 000'), text)
    assertNoPageErrors(page, '[7]')
  })

  await check('[8] "Затвори" -> onCloseDetail', async () => {
    const clicked = await call(page, (h: H) => h.clickSelector('[data-admin-campaign-archive-close-detail="1"]'))
    assert(clicked, 'бутонът трябва да съществува')
    const calls = await call(page, (h: H) => h.getCalls())
    assert(calls.some((c) => c.name === 'onCloseDetail'), JSON.stringify(calls))
  })

  await check('[9] "Назад към Кампании" -> onBack', async () => {
    const clicked = await call(page, (h: H) => h.clickSelector('[data-admin-campaign-archive-back="1"]'))
    assert(clicked, 'бутонът трябва да съществува')
    const calls = await call(page, (h: H) => h.getCalls())
    assert(calls.some((c) => c.name === 'onBack'), JSON.stringify(calls))
  })

  await check('[10] Mobile (390x844) оформление — без JS грешки, списъкът се рендира', async () => {
    const mobilePage = await newPage({ width: 390, height: 844 })
    const state = await call(mobilePage, (h: H, list: unknown) => h.baseState({ adminCampaignArchiveList: list }), sampleList)
    await call(mobilePage, (h: H, s: unknown) => h.render(s, true), state)
    assert((await call(mobilePage, (h: H) => h.rowCount())) === 2, 'mobile rowCount')
    assertNoPageErrors(mobilePage, '[10]')
  })
} finally {
  if (browser) await browser.close()
  if (vite) await vite.close()
}

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
