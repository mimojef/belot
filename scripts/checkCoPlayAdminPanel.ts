/**
 * checkCoPlayAdminPanel.ts
 *
 * „Забрани за съвместна игра“, Етап 5 — поведенчески и визуални проверки на
 * админ панела в реален Chromium: реалният showAdminCoPlayRestrictionsPanel
 * с изолирани тестови данни (scripts/fixtures/coPlayAdminPanelHarness.ts —
 * фалшив API в страницата, без сървър и без база).
 *
 *   node server/node_modules/tsx/dist/cli.mjs scripts/checkCoPlayAdminPanel.ts
 *
 * Скрийншоти: <tmp>/belot-v2-co-play-admin-screenshots/<viewport>/*.png
 */

import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright'
import { createServer as createNetServer } from 'node:net'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let passed = 0
let failed = 0
async function check(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    passed += 1
    console.log(`  PASS  ${label}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL  ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') return reject(new Error('no port'))
      server.close(() => resolve(address.port))
    })
  })
}

const OUT = join(tmpdir(), 'belot-v2-co-play-admin-screenshots')
const FLAG_OFF_TEXT = 'Системата е изключена. Записаните забрани не се прилагат в игрите.'
const PENDING_1 = 'Забраната ще се активира автоматично, когато общото участие в незавършилите турнири приключи.'
const PENDING_2 = 'Срокът на наказанието започва да тече от момента на активиране.'
const SCOPE = 'Забраната обхваща всички профили на двата потребителски акаунта.'

let vite: ViteDevServer | null = null
let browser: Browser | null = null
try {
  const port = await freePort()
  vite = await createViteServer({ root: process.cwd(), server: { port, strictPort: true, host: '127.0.0.1' }, logLevel: 'error' })
  await vite.listen()
  browser = await chromium.launch()
  const base = `http://127.0.0.1:${port}/scripts/fixtures/coPlayAdminPanelHarness.html`

  console.log('\ncheckCoPlayAdminPanel\n')

  const open = async (vp: { width: number; height: number; mobile: boolean }, scenario = 'default', extra = ''): Promise<Page> => {
    const context = await browser!.newContext({ viewport: { width: vp.width, height: vp.height }, hasTouch: vp.mobile, isMobile: vp.mobile, deviceScaleFactor: vp.mobile ? 2 : 1, timezoneId: 'America/New_York' })
    const page = await context.newPage()
    page.on('pageerror', (error) => console.error(`    pageerror: ${error.message}`))
    await page.goto(`${base}?scenario=${scenario}${extra}`)
    await page.waitForFunction(() => (window as any).__coPlayAdminHarness?.ready() === true, undefined, { timeout: 20_000 })
    await page.waitForTimeout(150)
    return page
  }
  const shot = async (page: Page, dir: string, name: string) => {
    await page.addStyleTag({ content: '#admin-co-play-restrictions-panel{position:absolute!important;inset:auto!important;top:0!important;left:0!important;right:0!important;min-height:100%;overflow:visible!important}' })
    await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true })
  }
  const requests = (page: Page) => page.evaluate(() => (window as any).__coPlayAdminHarness.requests() as Array<{ method: string; path: string; body: any }>)
  const mutations = (page: Page) => page.evaluate(() => (window as any).__coPlayAdminHarness.mutations() as Array<{ method: string; path: string; body: any }>)
  const lastListGet = async (page: Page) => (await requests(page)).filter((r) => r.method === 'GET' && /^\/api\/admin\/co-play-restrictions\?/.test(r.path)).pop()?.path ?? ''
  const text = (page: Page, selector: string) => page.locator(selector).first().innerText()
  const rowStatuses = (page: Page) => page.$$eval('[data-co-play-row]', (rows) => rows.map((r) => r.getAttribute('data-co-play-row-status')))
  const settle = (page: Page, ms = 500) => page.waitForTimeout(ms)
  const pick = async (page: Page, slot: 0 | 1, term: string, name: string) => {
    await page.fill(`[data-co-play-pick-search="${slot}"]`, term)
    await page.locator(`[data-co-play-pick-results="${slot}"] button:has-text("${name}")`).first().waitFor({ timeout: 5000 })
    await page.locator(`[data-co-play-pick-results="${slot}"] button:has-text("${name}")`).first().click()
    await page.locator(`[data-co-play-picker="${slot}"] [data-co-play-picked-name="1"]`).waitFor({ timeout: 3000 })
  }
  const formError = (page: Page) => page.locator('[data-co-play-create-error="1"]').evaluate((el) => (el as HTMLElement).style.display === 'none' ? null : el.textContent)

  const desktop = { label: 'desktop-1280x800', width: 1280, height: 800, mobile: false }
  const dDir = join(OUT, desktop.label)
  await mkdir(dDir, { recursive: true })

  // ─── Глобален превключвател, статуси, списък ────────────────────────
  {
    const page = await open(desktop)
    await check('[A1] изключена система: „Изключена“, пояснението, активните редове са „Не се прилага“; списъкът по подразбиране е „Всички“', async () => {
      assert((await page.getAttribute('[data-co-play-flag-state]', 'data-co-play-flag-state')) === 'off', 'флагът не е off')
      assert((await text(page, '[data-co-play-flag-off-note="1"]')).trim() === FLAG_OFF_TEXT, 'пояснение')
      assert((await page.locator('[data-co-play-row="r-active-1"] [data-co-play-not-enforced="1"]').count()) === 1, 'активната забрана не е маркирана като неприлагана')
      assert((await page.locator('[data-co-play-row="r-expired"] [data-co-play-not-enforced="1"]').count()) === 0, 'изтеклата е маркирана')
      assert((await page.getAttribute('[data-co-play-filter="all"]', 'aria-pressed')) === 'true', 'филтър')
      const get = await lastListGet(page)
      assert(get.includes('status=all') && get.includes('limit=20') && get.includes('offset=0'), get)
    })
    await shot(page, dDir, '01-list-flag-off')
    await check('[A2] четирите статуса с различни етикети', async () => {
      const labels = await page.$$eval('[data-co-play-status-badge]', (els) => Object.fromEntries(els.map((e) => [e.getAttribute('data-co-play-status-badge'), (e as HTMLElement).innerText.trim()])))
      assert(labels.active === 'Активна' && labels.pending_activation === 'Изчаква активиране' && labels.expired === 'Изтекла' && labels.lifted === 'Отменена', JSON.stringify(labels))
    })
    await check('[A3] изчакваща: турнирите с имена и статуси, двете пояснения, заявен срок, без дата на изтичане и без оставащ срок', async () => {
      const row = page.locator('[data-co-play-row="r-pending"]')
      const tournaments = await row.locator('[data-co-play-pending-tournament]').allInnerTexts()
      assert(tournaments.some((t) => t.includes('Есенна купа') && t.includes('Записване')) && tournaments.some((t) => t.includes('Нощен турнир') && t.includes('Полуфинал')), JSON.stringify(tournaments))
      const pendingText = await row.locator('[data-co-play-pending="1"]').innerText()
      assert(pendingText.includes(PENDING_1) && pendingText.includes(PENDING_2), pendingText)
      assert((await row.locator('[data-co-play-field="duration"]').innerText()).includes('14 дни'), 'заявен срок')
      assert((await row.locator('[data-co-play-field="expires-at"]').innerText()).includes('след активиране'), 'дата на изтичане')
      assert((await row.locator('[data-co-play-field="remaining"]').innerText()).trim().endsWith('—'), 'оставащ срок')
      assert((await row.locator('[data-co-play-field="activated-at"]').innerText()).includes('Още не е активирана'), 'активиране')
    })
    await check('[A4] активна/безсрочна/отменена: оставащ срок, „Безсрочно“, преименуван и изтрит профил, кой и кога е отменил', async () => {
      const active = page.locator('[data-co-play-row="r-active-1"]')
      assert((await active.locator('[data-co-play-field="remaining"]').innerText()).includes('28 дни'), await active.locator('[data-co-play-field="remaining"]').innerText())
      assert((await active.locator('[data-co-play-field="created-by"]').innerText()).includes('Главен админ'), 'наложил')
      assert(/\d{2}\.\d{2}\.\d{4}/.test(await active.locator('[data-co-play-field="expires-at"]').innerText()), 'дата на изтичане')
      const indef = page.locator('[data-co-play-row="r-indef"]')
      assert((await indef.locator('[data-co-play-field="duration"]').innerText()).includes('Безсрочно') && (await indef.locator('[data-co-play-field="remaining"]').innerText()).includes('Безсрочно'), 'безсрочна')
      assert((await indef.innerText()).includes('(при налагане: Георги)'), 'преименуван')
      const lifted = page.locator('[data-co-play-row="r-lifted"]')
      assert((await lifted.locator('[data-co-play-field="lifted-by"]').innerText()).includes('Модератор Админ'), 'отменил')
      assert((await lifted.locator('[data-co-play-field="lift-reason"]').innerText()).includes('Недоразумение'), 'причина за отмяна')
      assert((await lifted.innerText()).includes('(изтрит профил)'), 'изтрит профил')
      assert((await lifted.locator('[data-co-play-lift-open]').count()) === 0 && (await page.locator('[data-co-play-row="r-expired"] [data-co-play-lift-open]').count()) === 0, 'отмяна за неактивна')
      assert((await page.locator('[data-co-play-row="r-pending"] [data-co-play-lift-open]').count()) === 1, 'изчакващата не може да се отмени')
    })
    await check('[A5] филтрите пращат status и показват само съответните', async () => {
      for (const status of ['active', 'pending_activation', 'expired', 'lifted', 'all'] as const) {
        await page.click(`[data-co-play-filter="${status}"]`)
        await settle(page, 300)
        assert((await lastListGet(page)).includes(`status=${status}`), `${status}: ${await lastListGet(page)}`)
        const statuses = await rowStatuses(page)
        assert(statuses.length > 0 && (status === 'all' || statuses.every((s) => s === status)), `${status}: ${JSON.stringify(statuses)}`)
      }
    })
    await check('[A6] търсене по ник (q)', async () => {
      await page.fill('[data-co-play-search="1"]', 'Мария')
      await page.press('[data-co-play-search="1"]', 'Enter')
      await settle(page, 300)
      assert((await lastListGet(page)).includes(`q=${encodeURIComponent('Мария')}`), await lastListGet(page))
      const rows = await page.$$eval('[data-co-play-row]', (els) => els.map((e) => e.getAttribute('data-co-play-row')))
      assert(rows.length === 1 && rows[0] === 'r-indef', JSON.stringify(rows))
      await page.fill('[data-co-play-search="1"]', '')
      await page.press('[data-co-play-search="1"]', 'Enter')
      await settle(page, 300)
    })
    await check('[A7] страниране през limit/offset на API-то', async () => {
      await page.click('[data-co-play-filter="expired"]')
      await settle(page, 300)
      assert((await text(page, '[data-co-play-list-summary="1"]')).includes('Общо: 25'), await text(page, '[data-co-play-list-summary="1"]'))
      await page.click('[data-co-play-page="next"]')
      await settle(page, 300)
      assert((await lastListGet(page)).includes('offset=20'), await lastListGet(page))
      assert((await rowStatuses(page)).length === 5, 'втора страница')
      await page.click('[data-co-play-page="prev"]')
      await settle(page, 300)
      assert((await lastListGet(page)).includes('offset=0') && (await rowStatuses(page)).length === 20, 'първа страница')
      await page.click('[data-co-play-filter="all"]')
      await settle(page, 300)
    })
    await check('[A8] включване: потвърждение; „Назад“ не праща нищо; една PUT заявка; „Включена“, без пояснението и без „Не се прилага“', async () => {
      await page.click('[data-co-play-flag-toggle="on"]')
      await page.locator('[data-co-play-dialog="flag-on"]').waitFor()
      await shot(page, dDir, '02-flag-on-confirm')
      await page.click('[data-co-play-dialog-cancel="1"]')
      assert((await mutations(page)).length === 0, 'PUT след „Назад“')
      await page.click('[data-co-play-flag-toggle="on"]')
      await page.locator('[data-co-play-dialog-confirm="1"]').dblclick()
      await page.locator('[data-co-play-dialog]').waitFor({ state: 'detached', timeout: 5000 })
      await settle(page, 300)
      const puts = (await mutations(page)).filter((m) => m.method === 'PUT')
      assert(puts.length === 1 && puts[0]!.body.enabled === true, JSON.stringify(puts))
      assert((await page.getAttribute('[data-co-play-flag-state]', 'data-co-play-flag-state')) === 'on', 'не е on')
      assert((await page.locator('[data-co-play-flag-off-note="1"]').count()) === 0, 'пояснението остана')
      assert((await page.locator('[data-co-play-not-enforced="1"]').count()) === 0, '„Не се прилага“ остана')
      assert((await page.getAttribute('[data-co-play-notice="1"]', 'data-tone')) === 'ok', 'няма потвърждение')
    })
    await shot(page, dDir, '03-flag-on')
    await check('[A8] изключване: потвърждение -> „Изключена“ + пояснението', async () => {
      await page.click('[data-co-play-flag-toggle="off"]')
      await page.locator('[data-co-play-dialog="flag-off"]').waitFor()
      await page.click('[data-co-play-dialog-confirm="1"]')
      await page.locator('[data-co-play-dialog]').waitFor({ state: 'detached', timeout: 5000 })
      assert((await page.getAttribute('[data-co-play-flag-state]', 'data-co-play-flag-state')) === 'off', 'не е off')
      assert((await text(page, '[data-co-play-flag-off-note="1"]')).trim() === FLAG_OFF_TEXT, 'пояснение')
    })
    await check('[A16] предсрочна отмяна: потвърждение, причина по желание, една POST заявка, обновен списък без презареждане', async () => {
      await page.evaluate(() => { (window as any).__noReloadMarker = 1 })
      assert((await page.locator('[data-co-play-notice="1"][data-tone="ok"]').count()) === 1, '(setup) няма съобщение от превключвателя')
      await page.click('[data-co-play-row="r-active-1"] [data-co-play-lift-open]')
      await page.locator('[data-co-play-dialog="lift"]').waitFor()
      assert(!(await page.locator('[data-co-play-notice="1"]').isVisible()), 'старото съобщение остана при нова операция (отмяна)')
      assert((await page.locator('[data-co-play-dialog="lift"]').innerText()).includes('(по желание)'), 'причината не е по желание')
      await page.fill('[data-co-play-dialog-reason="1"]', 'Грешно наложена')
      await shot(page, dDir, '04-lift-confirm')
      await page.locator('[data-co-play-dialog-confirm="1"]').dblclick()
      await page.locator('[data-co-play-dialog]').waitFor({ state: 'detached', timeout: 5000 })
      await settle(page, 400)
      const lifts = (await mutations(page)).filter((m) => m.path.endsWith('/lift'))
      assert(lifts.length === 1 && lifts[0]!.path.includes('r-active-1') && lifts[0]!.body.reason === 'Грешно наложена', JSON.stringify(lifts))
      assert((await page.getAttribute('[data-co-play-row="r-active-1"]', 'data-co-play-row-status')) === 'lifted', 'редът не е „Отменена“')
      assert((await page.evaluate(() => (window as any).__noReloadMarker)) === 1, 'страницата е презаредена')
    })
    await check('[A16] отмяна без причина -> празно тяло; „not_active“ -> съобщение в диалога и обновен списък', async () => {
      await page.click('[data-co-play-row="r-indef"] [data-co-play-lift-open]')
      await page.click('[data-co-play-dialog-confirm="1"]')
      await page.locator('[data-co-play-dialog]').waitFor({ state: 'detached', timeout: 5000 })
      const lift = (await mutations(page)).filter((m) => m.path.includes('r-indef')).pop()
      assert(lift !== undefined && Object.keys(lift.body ?? {}).length === 0, JSON.stringify(lift))
      await page.click('[data-co-play-row="r-stale"] [data-co-play-lift-open]')
      await page.click('[data-co-play-dialog-confirm="1"]')
      await page.locator('[data-co-play-dialog-error="1"]:visible').waitFor({ timeout: 5000 })
      assert((await text(page, '[data-co-play-dialog-error="1"]')).includes('вече не е активна'), await text(page, '[data-co-play-dialog-error="1"]'))
      await page.click('[data-co-play-dialog-cancel="1"]')
      await settle(page, 300)
      assert((await page.getAttribute('[data-co-play-row="r-stale"]', 'data-co-play-row-status')) === 'expired', 'списъкът не е обновен')
    })
    await check('[A17] история на една забрана от реда', async () => {
      await page.click('[data-co-play-history-toggle="r-active-1"]')
      await page.locator('[data-co-play-history="r-active-1"] [data-co-play-history-entry]').first().waitFor({ timeout: 5000 })
      const entries = await page.$$eval('[data-co-play-history="r-active-1"] [data-co-play-history-entry]', (els) => els.map((e) => e.getAttribute('data-co-play-history-entry')))
      assert(entries.includes('activate') && entries.includes('enforcement_removed') && entries.includes('lift'), JSON.stringify(entries))
    })
    await shot(page, dDir, '05-list-after-actions')
    await check('[A18] одит: всички действия, кой и кога (Europe/Sofia), системни записи, филтър по забрана', async () => {
      await page.click('[data-co-play-tab="audit"]')
      await page.locator('[data-co-play-audit-entry]').first().waitFor({ timeout: 5000 })
      const body = await text(page, '[data-co-play-tab-panel="audit"]')
      for (const label of ['Налагане', 'Автоматично активиране', 'Отмяна', 'Изтичане', 'Глобален превключвател', 'Прилагане: премахване от чакалня/маса', 'Засечен конфликт в турнир']) {
        assert(body.includes(label), `липсва „${label}“`)
      }
      assert(body.includes('системата (автоматично)') && body.includes('Главен админ') && body.includes('Модератор Админ'), 'извършители')
      // 2026-07-01T09:05Z = 12:05 българско време (браузърът е в America/New_York).
      assert(body.includes('01.07.2026') && body.includes('12:05'), 'българско време')
      assert(body.includes('Случайна маса') && body.includes('залогът е възстановен'), 'детайли на прилагането')
      await shot(page, dDir, '06-audit')
      await page.locator('[data-co-play-audit-open="r-active-1"]').first().click()
      await page.locator('[data-co-play-audit-filter="r-active-1"]').waitFor({ timeout: 5000 })
      await settle(page, 300)
      assert((await requests(page)).some((r) => r.path.includes('/audit?') && r.path.includes('restrictionId=r-active-1')), 'филтър по забрана')
      await page.click('[data-co-play-audit-clear="1"]')
      await settle(page, 300)
      assert((await page.locator('[data-co-play-audit-filter]').count()) === 0, 'филтърът не е изчистен')
    })
    await check('[A20] Escape затваря първо диалога, после панела', async () => {
      await page.click('[data-co-play-tab="list"]')
      await page.click('[data-co-play-flag-toggle="on"]')
      await page.keyboard.press('Escape')
      assert((await page.locator('[data-co-play-dialog]').count()) === 0, 'диалогът остана')
      assert((await page.locator('#admin-co-play-restrictions-panel').count()) === 1, 'панелът се затвори')
      await page.keyboard.press('Escape')
      assert((await page.locator('#admin-co-play-restrictions-panel').count()) === 0, 'панелът не се затвори')
    })
    await page.context().close()
  }

  // ─── Нова забрана ───────────────────────────────────────────────────
  {
    const page = await open(desktop)
    await page.click('[data-co-play-tab="create"]')
    await check('[A10] формата: ръчен срок (число, без dropdown), „Безсрочно“ деактивира полето, пояснението за акаунтите', async () => {
      assert((await page.locator('[data-co-play-create-form="1"] select').count()) === 0, 'има select')
      assert((await page.getAttribute('[data-co-play-duration="1"]', 'type')) === 'number', 'не е числово поле')
      assert((await page.inputValue('[data-co-play-duration="1"]')) === '30', 'стойност по подразбиране')
      await page.check('[data-co-play-indefinite="1"]')
      assert(await page.isDisabled('[data-co-play-duration="1"]'), 'полето не е неактивно')
      await page.uncheck('[data-co-play-indefinite="1"]')
      assert(!(await page.isDisabled('[data-co-play-duration="1"]')), 'полето остана неактивно')
      assert((await text(page, '[data-co-play-scope-note="1"]')).trim() === SCOPE, 'пояснение')
    })
    await check('[A10] валидиране без заявки: профили, причина, срок 0 / 3651 / 1.5 / празно, причина над 500', async () => {
      await page.click('[data-co-play-submit="1"]')
      assert((await formError(page))?.includes('Изберете двата профила') === true, String(await formError(page)))
      await pick(page, 0, 'Тестов Иг', 'Тестов Играч')
      await pick(page, 1, 'Тестова', 'Тестова Играчка')
      await page.click('[data-co-play-submit="1"]')
      assert((await formError(page))?.includes('Причината за наказанието е задължителна') === true, String(await formError(page)))
      await page.fill('[data-co-play-reason="1"]', 'Тестова причина')
      for (const value of ['0', '3651', '1.5', '']) {
        await page.fill('[data-co-play-duration="1"]', value)
        await page.click('[data-co-play-submit="1"]')
        assert((await formError(page)) !== null, `срок „${value}“ е приет`)
        assert((await page.locator('[data-co-play-dialog]').count()) === 0, `диалог при срок „${value}“`)
      }
      await page.fill('[data-co-play-duration="1"]', '30')
      await page.evaluate(() => { (document.querySelector('[data-co-play-reason="1"]') as HTMLTextAreaElement).value = 'x'.repeat(501) })
      await page.click('[data-co-play-submit="1"]')
      assert((await formError(page))?.includes('до 500') === true, String(await formError(page)))
      assert((await mutations(page)).length === 0, 'изпратена заявка при невалидни данни')
      assert((await page.getAttribute('[data-co-play-reason="1"]', 'maxlength')) === '500', 'maxlength')
    })
    await check('[A11] търсене и избор: ботовете не се показват; аватар + ник; вече избраният е неактивен; „Смени“', async () => {
      await page.click('[data-co-play-pick-change="0"]')
      await page.fill('[data-co-play-pick-search="0"]', 'Тестов')
      await page.locator('[data-co-play-pick-results="0"] button').first().waitFor()
      const names = await page.locator('[data-co-play-pick-results="0"] button').allInnerTexts()
      assert(!names.some((n) => n.includes('Тестов Бот')), 'ботът се показва')
      const taken = page.locator('[data-co-play-pick-results="0"] button[data-co-play-pick-option="p-new-2"]')
      assert(await taken.isDisabled(), 'вече избраният профил не е неактивен')
      await page.click('[data-co-play-pick-results="0"] button[data-co-play-pick-option="p-new-1"]')
      assert((await page.locator('[data-co-play-picker="0"] [data-co-play-picked="p-new-1"]').count()) === 1, 'изборът не е показан')
      assert((await page.locator('[data-co-play-picker="0"] [data-co-play-picked="p-new-1"] span').first().innerText()).trim() === 'Т', 'аватар')
    })
    await page.fill('[data-co-play-reason="1"]', 'Договаряне в турнир')
    await shot(page, dDir, '07-create-form')
    await check('[A12] потвърждение с двата ника, срока и причината; двоен клик -> една POST заявка; успех -> обновен списък', async () => {
      await page.click('[data-co-play-submit="1"]')
      await page.locator('[data-co-play-dialog="impose"]').waitFor()
      const dialog = await text(page, '[data-co-play-dialog="impose"]')
      assert(dialog.includes('Тестов Играч') && dialog.includes('Тестова Играчка') && dialog.includes('30 дни') && dialog.includes('Договаряне в турнир'), dialog)
      await shot(page, dDir, '08-impose-confirm')
      await page.locator('[data-co-play-dialog-confirm="1"]').dblclick()
      await page.locator('[data-co-play-dialog]').waitFor({ state: 'detached', timeout: 5000 })
      await settle(page, 400)
      const posts = (await mutations(page)).filter((m) => m.method === 'POST')
      assert(posts.length === 1, `POST заявки: ${posts.length}`)
      assert(posts[0]!.body.durationDays === 30 && posts[0]!.body.indefinite === undefined && posts[0]!.body.firstProfileId === 'p-new-1' && posts[0]!.body.secondProfileId === 'p-new-2', JSON.stringify(posts[0]!.body))
      assert((await page.getAttribute('[data-co-play-tab="list"]', 'aria-selected')) === 'true', 'не е върнат към списъка')
      assert((await page.locator('[data-co-play-imposed="active"]').count()) === 1, 'няма съобщение за успех')
      const first = await page.locator('[data-co-play-row]').first().innerText()
      assert(first.includes('Тестов Играч') && first.includes('Тестова Играчка'), 'новата забрана не е в списъка')
    })
    await check('[A13] безсрочна: тяло с indefinite:true без durationDays; потвърждението казва „Безсрочно“', async () => {
      await page.click('[data-co-play-tab="create"]')
      await pick(page, 0, 'Тестов Ср', 'Тестов Срок')
      await pick(page, 1, 'Тестов Иг', 'Тестов Играч')
      await page.check('[data-co-play-indefinite="1"]')
      await page.fill('[data-co-play-reason="1"]', 'Безсрочно наказание')
      assert((await page.locator('[data-co-play-notice="1"][data-tone="ok"]').count()) === 1, '(setup) няма съобщение за успех от A12')
      await page.click('[data-co-play-submit="1"]')
      assert(!(await page.locator('[data-co-play-notice="1"]').isVisible()), 'старото съобщение за успех остана при нова операция')
      assert((await text(page, '[data-co-play-dialog="impose"] [data-co-play-field="confirm-duration"]')).includes('Безсрочно'), 'потвърждение')
      await page.click('[data-co-play-dialog-confirm="1"]')
      await settle(page, 600)
      const post = (await mutations(page)).filter((m) => m.method === 'POST').pop()!
      assert(post.body.indefinite === true && !('durationDays' in post.body), JSON.stringify(post.body))
      // p-bad-dur -> сървърът отказва invalid_duration (тук изпитваме и грешката).
      assert((await formError(page))?.includes('от 1 до 3650') === true, String(await formError(page)))
      assert((await page.locator('[data-co-play-picker="0"] [data-co-play-picked="p-bad-dur"]').count()) === 1, 'изборът е изгубен след грешка')
      assert(!(await page.locator('[data-co-play-notice="1"]').isVisible()), 'съобщение за успех до грешката')
    })
    await check('[A15] API откази: същият акаунт, неподходящ профил, вече съществуваща забрана — текст във формата, без промяна в списъка', async () => {
      const cases: Array<[string, string, string, string, string]> = [
        ['Тестов Дв', 'Тестов Двойник', 'Тестов Иг', 'Тестов Играч', 'един и същ потребителски акаунт'],
        ['Тестов Го', 'Тестов Гост', 'Тестов Иг', 'Тестов Играч', 'само между профили на регистрирани акаунти'],
        ['Тестов Ив', 'Тестов Иван', 'Тестов Пе', 'Тестов Петър', 'вече има активна или изчакваща забрана'],
      ]
      for (const [termA, nameA, termB, nameB, expected] of cases) {
        if ((await page.locator('[data-co-play-pick-change="0"]').count()) > 0) await page.click('[data-co-play-pick-change="0"]')
        if ((await page.locator('[data-co-play-pick-change="1"]').count()) > 0) await page.click('[data-co-play-pick-change="1"]')
        await pick(page, 0, termA, nameA)
        await pick(page, 1, termB, nameB)
        await page.uncheck('[data-co-play-indefinite="1"]')
        await page.fill('[data-co-play-duration="1"]', '10')
        await page.fill('[data-co-play-reason="1"]', 'Проверка на отказ')
        await page.click('[data-co-play-submit="1"]')
        await page.click('[data-co-play-dialog-confirm="1"]')
        await page.locator('[data-co-play-dialog]').waitFor({ state: 'detached', timeout: 5000 })
        assert((await formError(page))?.includes(expected) === true, `${nameA}: ${String(await formError(page))}`)
      }
      await shot(page, dDir, '09-create-error')
    })
    await check('[A14] изчакваща забрана: ясно съобщение „изчаква активиране“ с турнира и поясненията', async () => {
      await page.click('[data-co-play-pick-change="0"]')
      await page.click('[data-co-play-pick-change="1"]')
      await pick(page, 0, 'Турнир1', 'Тестов Турнир1')
      await pick(page, 1, 'Турнир2', 'Тестов Турнир2')
      await page.fill('[data-co-play-duration="1"]', '60')
      await page.fill('[data-co-play-reason="1"]', 'Уговорка в турнир')
      await page.click('[data-co-play-submit="1"]')
      await page.click('[data-co-play-dialog-confirm="1"]')
      await page.locator('[data-co-play-imposed="pending_activation"]').waitFor({ timeout: 5000 })
      const notice = await text(page, '[data-co-play-notice="1"]')
      assert(notice.includes('записана успешно, но все още изчаква активиране') && notice.includes('Зимен шампионат') && notice.includes(PENDING_1) && notice.includes(PENDING_2), notice)
    })
    await shot(page, dDir, '10-imposed-pending')
    await page.context().close()
  }

  // ─── 409 при включване, 403 ─────────────────────────────────────────
  {
    const page = await open(desktop, 'conflict')
    await check('[A9] отказ 409 при включване: конфликтните турнири; системата остава изключена; без съобщение за успех', async () => {
      await page.click('[data-co-play-flag-toggle="on"]')
      await page.click('[data-co-play-dialog-confirm="1"]')
      await page.locator('[data-co-play-settings-conflicts="1"]').waitFor({ timeout: 5000 })
      const conflicts = await text(page, '[data-co-play-settings-conflicts="1"]')
      assert(conflicts.includes('НЕ беше включена') && conflicts.includes('Купа Пловдив') && conflicts.includes('Записване'), conflicts)
      assert((await page.getAttribute('[data-co-play-flag-state]', 'data-co-play-flag-state')) === 'off', 'показано като включена')
      assert((await page.locator('[data-co-play-notice="1"][data-tone="ok"]').count()) === 0, 'показано съобщение за успех')
      assert((await page.locator('[data-co-play-flag-off-note="1"]').count()) === 1, 'пояснението изчезна')
    })
    await shot(page, dDir, '11-flag-conflict-409')
    await page.context().close()
    const forbidden = await open(desktop, 'forbidden')
    await check('[A19] 403 от сървъра: съобщение вместо данни, без срив', async () => {
      assert((await text(forbidden, '[data-co-play-settings-error="1"]')).includes('Само администратор'), 'настройка')
      assert((await text(forbidden, '[data-co-play-list-error="1"]')).includes('Само администратор'), 'списък')
    })
    await forbidden.context().close()
  }

  // ─── Mobile ─────────────────────────────────────────────────────────
  for (const vp of [{ label: 'mobile-390x844', width: 390, height: 844, mobile: true }, { label: 'mobile-320x568', width: 320, height: 568, mobile: true }]) {
    const dir = join(OUT, vp.label)
    await mkdir(dir, { recursive: true })
    const page = await open(vp)
    const noOverflow = async (where: string) => {
      const overflow = await page.evaluate(() => {
        const panel = document.querySelector('[data-co-play-panel="1"]') as HTMLElement
        const dialog = document.querySelector('[data-co-play-dialog] [role="dialog"]') as HTMLElement | null
        return {
          doc: document.documentElement.scrollWidth - window.innerWidth,
          panel: panel.scrollWidth - panel.clientWidth,
          dialog: dialog === null ? 0 : dialog.scrollWidth - dialog.clientWidth,
        }
      })
      assert(overflow.doc <= 1 && overflow.panel <= 1 && overflow.dialog <= 1, `${where}: ${JSON.stringify(overflow)}`)
    }
    await check(`[M1] ${vp.label}: списък, форма, диалози — без хоризонтално препълване`, async () => {
      await noOverflow('списък')
      await shot(page, dir, '01-list')
      await page.click('[data-co-play-tab="create"]')
      await pick(page, 0, 'Тестов Иг', 'Тестов Играч')
      await pick(page, 1, 'Тестова', 'Тестова Играчка')
      await page.fill('[data-co-play-reason="1"]', 'Мобилна проверка')
      await noOverflow('форма')
      const fit = await page.evaluate(() => {
        const form = (document.querySelector('[data-co-play-create-form="1"]') as HTMLElement).getBoundingClientRect()
        const padding = 14
        return [...document.querySelectorAll('[data-co-play-picked]')].map((el) => {
          const r = el.getBoundingClientRect()
          return { left: r.left - (form.left + padding), right: form.right - padding - r.right }
        })
      })
      assert(fit.length === 2 && fit.every((g) => g.left >= -0.5 && g.right >= -0.5), `картите излизат от формата: ${JSON.stringify(fit)}`)
      await shot(page, dir, '02-create')
      await page.click('[data-co-play-submit="1"]')
      await page.locator('[data-co-play-dialog="impose"]').waitFor()
      await noOverflow('потвърждение')
      await page.screenshot({ path: join(dir, '03-impose-confirm.png') })
      await page.click('[data-co-play-dialog-cancel="1"]')
      await page.click('[data-co-play-tab="list"]')
      await page.click('[data-co-play-filter="pending_activation"]')
      await settle(page, 300)
      await noOverflow('изчакващи')
      await shot(page, dir, '04-pending')
      await page.click('[data-co-play-tab="audit"]')
      await page.locator('[data-co-play-audit-entry]').first().waitFor()
      await noOverflow('одит')
      await shot(page, dir, '05-audit')
    })
    await page.context().close()
  }
} catch (error) {
  failed += 1
  console.error('FATAL', error)
} finally {
  await browser?.close().catch(() => undefined)
  await vite?.close().catch(() => undefined)
}

console.log(`\n${passed} passed, ${failed} failed`)
console.log(`Скрийншоти: ${OUT}`)
process.exit(failed === 0 ? 0 : 1)
