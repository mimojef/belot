/**
 * checkAdminProfileDeletionsUi.ts
 *
 * Етап 4J — реален браузър (Playwright) върху реалния production панел
 * "Заявки за изтриване" (showAdminProfileDeletionsPanel) със synthetic
 * отговори от "сървъра" (scripts/fixtures/adminProfileDeletionsUiHarness.ts).
 * Правата, лимитът, отмяната и поверителността на сървъра са в
 * server/scripts/checkProfileDeletionAdminOversight.ts.
 *
 * Покрива: статуси и обяснения защо отмяна не е позволена, административните
 * операции само за преглед, изтрит профил без име, филтри и обновяване,
 * прозорецът за отмяна (отварянето не праща нищо, задължителна причина,
 * "Назад", Escape, двойно натискане, успех + обновяване, отказ от сървъра),
 * escape на данните, мобилен и настолен изглед.
 *
 * Употреба (от корена): npx tsx scripts/checkAdminProfileDeletionsUi.ts
 */

import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright'
import { createServer as createNetServer } from 'node:net'

let passed = 0
let failed = 0
async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
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

function findFreePort(): Promise<number> {
  return new Promise((resolveFree, reject) => {
    const srv = createNetServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      if (address === null || typeof address === 'string') { reject(new Error('no port')); return }
      srv.close(() => resolveFree(address.port))
    })
  })
}

async function h<T = unknown>(page: Page, method: string, ...args: unknown[]): Promise<T> {
  return await page.evaluate(({ method: m, args: a }) => {
    const harness = (window as any).__adminDeletionsHarness as Record<string, (...x: unknown[]) => unknown>
    return harness[m]!(...a)
  }, { method, args }) as T
}
type Call = { name: string; args: unknown[] }
const getCalls = (page: Page) => h<Call[]>(page, 'getCalls')
const row = (page: Page, id: string) => page.locator(`[data-admin-deletion-row="${id}"]`)

console.log('\ncheckAdminProfileDeletionsUi')

let vite: ViteDevServer | null = null
let browser: Browser | null = null

try {
  const port = await findFreePort()
  vite = await createViteServer({ root: process.cwd(), server: { port, strictPort: true, host: '127.0.0.1' }, logLevel: 'error' })
  await vite.listen()
  const baseUrl = `http://127.0.0.1:${port}/scripts/fixtures/adminProfileDeletionsUiHarness.html`
  browser = await chromium.launch()

  async function newPage(viewport: { width: number; height: number }, hasTouch = false): Promise<Page> {
    const context = await browser!.newContext({ viewport, hasTouch, isMobile: hasTouch, locale: 'bg-BG', timezoneId: 'Europe/Sofia' })
    const page = await context.newPage()
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await page.goto(baseUrl)
    await page.waitForFunction(() => (window as any).__adminDeletionsHarness !== undefined, undefined, { timeout: 15_000 })
    ;(page as any).__pageErrors = pageErrors
    return page
  }
  const assertNoPageErrors = (page: Page, label: string) => {
    const errors = (page as any).__pageErrors as string[]
    assert(errors.length === 0, `${label}: ${errors.join(' | ')}`)
  }
  const openPanel = async (page: Page, input: Record<string, unknown> = {}) => {
    await h(page, 'open', input)
    await page.waitForFunction(() => document.querySelector('[data-admin-deletion-row], [data-admin-deletions-empty]') !== null
      || (document.querySelector<HTMLElement>('[data-admin-deletions-notice="1"]')?.style.display ?? 'none') !== 'none', undefined, { timeout: 10_000 })
  }

  const page = await newPage({ width: 1280, height: 900 })

  console.log('\n[D] Настолен изглед')

  await check('[1] Списъкът показва реалните статуси; "Отмени заявката" само при canCancel; обяснение защо при останалите; административните — само преглед', async () => {
    await openPanel(page)
    assert((await page.locator('#admin-profile-deletions-title').textContent())?.trim() === 'Заявки за изтриване', 'заглавие')
    assert((await page.locator('[data-admin-deletion-row]').count()) === 13, 'брой редове')
    for (const id of ['req-window', 'req-legacy', 'req-overdue', 'req-game', 'req-xss']) {
      assert((await row(page, id).locator('[data-admin-deletion-cancel-open]').count()) === 1, `бутон за ${id}`)
    }
    for (const [id, blocker] of [['req-ban', 'ledger_intent_recorded'], ['req-offsite', 'ledger_intent_recorded'], ['req-exec', 'lease_held'], ['req-files', 'irreversible'], ['adm-pending', 'not_voluntary']] as const) {
      assert((await row(page, id).locator('[data-admin-deletion-cancel-open]').count()) === 0, `бутон при ${id}`)
      assert((await row(page, id).locator(`[data-admin-deletion-blocker="${blocker}"]`).count()) === 1, `обяснение ${id}`)
    }
    assert(/регистъра на изтриванията/.test((await row(page, 'req-ban').textContent()) ?? ''), 'текст за регистъра')
    assert(/само за преглед/.test((await row(page, 'adm-pending').textContent()) ?? ''), 'административно — само преглед')
    for (const id of ['req-done', 'req-cancelled', 'adm-done']) {
      assert((await row(page, id).locator('[data-admin-deletion-cancel-open], [data-admin-deletion-blocker]').count()) === 0, `краен ред ${id}`)
    }
    assert(/Блокирана — активен бан/.test((await row(page, 'req-ban').textContent()) ?? '') && /Активен бан/.test((await row(page, 'req-ban').textContent()) ?? ''), 'бан: статус и причина')
    assert(/45 дни/.test((await row(page, 'req-legacy').textContent()) ?? ''), '45-дневен срок')
    assert(/30 дни/.test((await row(page, 'req-window').textContent()) ?? ''), '30-дневен срок')
    assert(/Чака копие извън сървъра/.test((await row(page, 'adm-pending').textContent()) ?? ''), 'административно чака offsite')
    assert(/2 неизтрити, 1 с грешка/.test((await row(page, 'req-files').textContent()) ?? ''), 'файлове')
    assertNoPageErrors(page, '[1]')
  })

  await check('[2] Изтрит профил: "Изтрит или недостъпен профил", само технически данни; одит на административна отмяна с причина и администратор', async () => {
    assert(/Изтрит или недостъпен профил/.test((await row(page, 'req-done').textContent()) ?? ''), 'приключена')
    assert(/Изтрит или недостъпен профил/.test((await row(page, 'adm-done').textContent()) ?? ''), 'административно приключена')
    const audit = row(page, 'req-cancelled').locator('[data-admin-deletion-cancel-audit="1"]')
    assert(/Главен Админ/.test((await audit.textContent()) ?? '') && /Потвърди по телефона/.test((await audit.textContent()) ?? ''), 'одит')
  })

  await check('[3] Данните са текст (escape): HTML в името не се изпълнява', async () => {
    assert((await row(page, 'req-xss').locator('img').count()) === 0, 'img елемент')
    assert(await page.evaluate(() => (window as any).__xss === undefined), 'изпълнен код')
    assert(((await row(page, 'req-xss').textContent()) ?? '').includes('<img src=x'), 'текстът липсва')
  })

  await check('[4] Филтри по вид и статус и "Обнови" — всяка промяна зарежда списъка отново със съответния филтър', async () => {
    await h(page, 'clearCalls')
    await page.selectOption('[data-admin-deletions-filter-kind="1"]', 'admin')
    await page.waitForFunction(() => document.querySelectorAll('[data-admin-deletion-row]').length === 2)
    assert((await page.locator('[data-admin-deletion-kind="voluntary"]').count()) === 0, 'доброволни при филтър admin')
    await page.selectOption('[data-admin-deletions-filter-kind="1"]', '')
    await page.selectOption('[data-admin-deletions-filter-category="1"]', 'awaiting_offsite')
    await page.waitForFunction(() => document.querySelectorAll('[data-admin-deletion-row]').length === 1)
    assert((await row(page, 'req-offsite').count()) === 1, 'филтър по статус')
    await page.selectOption('[data-admin-deletions-filter-category="1"]', '')
    await page.waitForFunction(() => document.querySelectorAll('[data-admin-deletion-row]').length === 13)
    await page.click('[data-admin-deletions-refresh="1"]')
    await page.waitForFunction(() => document.querySelectorAll('[data-admin-deletion-row]').length === 13)
    const fetches = (await getCalls(page)).filter((c) => c.name === 'fetchList').map((c) => c.args[0] as { kind: string; category: string })
    assert(fetches.length === 5, `зареждания: ${fetches.length}`)
    assert(fetches[0]!.kind === 'admin' && fetches[2]!.category === 'awaiting_offsite' && fetches[4]!.kind === '' && fetches[4]!.category === '', JSON.stringify(fetches))
  })

  await check('[5] Отварянето на прозореца за отмяна не праща нищо; показва профил, дата, статус и предупреждение; без причина/само интервали — "Потвърди" е неактивен; "Назад" затваря', async () => {
    await h(page, 'clearCalls')
    await row(page, 'req-window').locator('[data-admin-deletion-cancel-open]').click()
    const dialog = page.locator('#admin-profile-deletion-cancel-dialog')
    await dialog.waitFor()
    assert((await getCalls(page)).every((c) => c.name !== 'cancelRequest'), 'заявка при отваряне')
    const text = (await dialog.textContent()) ?? ''
    assert(text.includes('Иван Тестов') && text.includes('Чака — в срока за отмяна') && /Профилът ще бъде запазен/.test(text) && /бан/.test(text), 'съдържание')
    assert(await page.locator('[data-admin-deletion-cancel-reason="1"]').evaluate((el) => el === document.activeElement), 'фокус в полето')
    const confirm = page.locator('[data-admin-deletion-cancel-confirm="1"]')
    assert(await confirm.isDisabled(), 'активен без причина')
    await page.fill('[data-admin-deletion-cancel-reason="1"]', '    ')
    assert(await confirm.isDisabled(), 'активен със само интервали')
    assert(Number(await page.locator('[data-admin-deletion-cancel-reason="1"]').getAttribute('maxlength')) === 500, 'maxlength')
    await page.click('[data-admin-deletion-cancel-back="1"]')
    assert((await dialog.count()) === 0, '"Назад" не затвори')
    assert((await getCalls(page)).every((c) => c.name !== 'cancelRequest'), 'заявка при "Назад"')
    await row(page, 'req-window').locator('[data-admin-deletion-cancel-open]').click()
    await dialog.waitFor()
    await page.keyboard.press('Escape')
    assert((await dialog.count()) === 0, 'Escape не затвори прозореца')
    assert(await page.locator('#admin-profile-deletions-panel').isVisible(), 'Escape затвори и панела')
  })

  await check('[6] Потвърждение: една заявка с изчистената причина (двойно натискане не праща втора); успех — съобщение и обновен списък', async () => {
    await h(page, 'setCancelMode', 'manual')
    await h(page, 'clearCalls')
    await row(page, 'req-window').locator('[data-admin-deletion-cancel-open]').click()
    await page.fill('[data-admin-deletion-cancel-reason="1"]', '  Потребителят поиска да запази профила  ')
    const confirm = page.locator('[data-admin-deletion-cancel-confirm="1"]')
    await confirm.click()
    await confirm.click({ force: true }).catch(() => {})
    await page.keyboard.press('Escape')
    assert((await page.locator('#admin-profile-deletion-cancel-dialog').count()) === 1, 'прозорецът се затвори по време на изпращане')
    const cancels = (await getCalls(page)).filter((c) => c.name === 'cancelRequest')
    assert(cancels.length === 1 && cancels[0]!.args[0] === 'req-window' && cancels[0]!.args[1] === 'Потребителят поиска да запази профила', JSON.stringify(cancels))
    await h(page, 'setCancelMode', 'ok')
    await page.evaluate(() => {
      // Сървърът потвърждава: харнесът отразява новото състояние в "базата".
      const harness = (window as any).__adminDeletionsHarness
      harness.resolveCancel({ ok: true })
    })
    await page.locator('#admin-profile-deletion-cancel-dialog').waitFor({ state: 'detached' })
    await page.waitForFunction(() => /Заявката е отменена/.test(document.querySelector('[data-admin-deletions-notice="1"]')?.textContent ?? ''))
    assert((await getCalls(page)).filter((c) => c.name === 'fetchList').length >= 1, 'списъкът не е обновен')
  })

  await check('[7] Отказ от сървъра (намерение в регистъра): обяснението е в прозореца, нищо не се затваря, списъкът се обновява', async () => {
    await h(page, 'setCancelMode', { ok: false, code: 'ledger_intent_recorded', message: 'Намерението за окончателно изтриване вече е записано в регистъра на изтриванията и се копира извън сървъра. Безопасна отмяна на този етап не е възможна.' })
    await h(page, 'clearCalls')
    await row(page, 'req-overdue').locator('[data-admin-deletion-cancel-open]').click()
    await page.fill('[data-admin-deletion-cancel-reason="1"]', 'Опит')
    await page.click('[data-admin-deletion-cancel-confirm="1"]')
    await page.waitForFunction(() => /регистъра/.test(document.querySelector('[data-admin-deletion-cancel-error="1"]')?.textContent ?? ''))
    assert((await page.locator('#admin-profile-deletion-cancel-dialog').count()) === 1, 'прозорецът се затвори')
    assert(await page.locator('[data-admin-deletion-cancel-confirm="1"]').isEnabled(), 'бутонът остава неактивен')
    await page.waitForFunction(() => true)
    assert((await getCalls(page)).some((c) => c.name === 'fetchList'), 'списъкът не е обновен')
    await page.click('[data-admin-deletion-cancel-back="1"]')
    await h(page, 'setCancelMode', 'ok')
  })

  await check('[8] Грешка при зареждане: съобщение, без редове; Escape затваря панела', async () => {
    await h(page, 'close')
    await openPanel(page, { failList: 'Само администратор може да преглежда и отменя заявки за изтриване.' })
    await page.waitForFunction(() => /Само администратор/.test(document.querySelector('[data-admin-deletions-notice="1"]')?.textContent ?? ''))
    assert((await page.locator('[data-admin-deletion-row]').count()) === 0, 'редове при грешка')
    await page.keyboard.press('Escape')
    assert((await page.locator('#admin-profile-deletions-panel').count()) === 0, 'Escape не затвори панела')
    assertNoPageErrors(page, '[8]')
  })

  console.log('\n[M] Мобилен изглед')
  const mobile = await newPage({ width: 375, height: 740 }, true)

  await check('[9] Телефон 375 px: без хоризонтален скрол; редовете и бутоните са в екрана; прозорецът за отмяна се побира и бутоните са достъпни', async () => {
    await openPanel(mobile)
    const overflow = await mobile.evaluate(() => {
      const host = document.getElementById('admin-profile-deletions-panel')!
      return { host: host.scrollWidth - host.clientWidth, doc: document.documentElement.scrollWidth - window.innerWidth }
    })
    assert(overflow.host <= 1 && overflow.doc <= 1, `хоризонтален скрол: ${JSON.stringify(overflow)}`)
    const button = row(mobile, 'req-window').locator('[data-admin-deletion-cancel-open]')
    const box = await button.boundingBox()
    assert(box !== null && box.x >= 0 && box.x + box.width <= 375 && box.height >= 36, `бутон: ${JSON.stringify(box)}`)
    await button.tap()
    const dialog = mobile.locator('#admin-profile-deletion-cancel-dialog')
    await dialog.waitFor()
    await mobile.fill('[data-admin-deletion-cancel-reason="1"]', 'Причина от телефона')
    const confirm = mobile.locator('[data-admin-deletion-cancel-confirm="1"]')
    await confirm.scrollIntoViewIfNeeded()
    const confirmBox = await confirm.boundingBox()
    assert(confirmBox !== null && confirmBox.x >= 0 && confirmBox.x + confirmBox.width <= 375, `потвърждение: ${JSON.stringify(confirmBox)}`)
    const dialogOverflow = await mobile.evaluate(() => {
      const dlg = document.getElementById('admin-profile-deletion-cancel-dialog')!
      return dlg.scrollWidth - dlg.clientWidth
    })
    assert(dialogOverflow <= 1, `хоризонтален скрол в прозореца: ${dialogOverflow}`)
    await confirm.tap()
    await dialog.waitFor({ state: 'detached' })
    await mobile.waitForFunction(() => document.querySelector('[data-admin-deletion-row="req-window"]')?.getAttribute('data-admin-deletion-category') === 'cancelled')
    assertNoPageErrors(mobile, '[9]')
  })
} catch (error) {
  failed += 1
  console.error(`  FAIL  неочаквана грешка: ${error instanceof Error ? error.stack : String(error)}`)
} finally {
  await browser?.close().catch(() => {})
  await vite?.close().catch(() => {})
}

console.log('\n════════════════════════════════════════════════════════════')
console.log(`Passed: ${passed}  Failed: ${failed}`)
process.exit(failed === 0 ? 0 : 1)
