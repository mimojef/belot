/**
 * checkProfileSelfDeletionUi.ts
 *
 * Самоизтриване, Етап 4I — реален браузър (Playwright) върху реалния
 * production код (syncProfilePopup, showSelfDeletionDialog,
 * showPendingDeletionPrompt) със synthetic отговори от "сървъра"
 * (scripts/fixtures/selfDeletionUiHarness.ts). Реалното HTTP/WS поведение е
 * в checkProfileSelfDeletionE2E.ts и checkProfileDeletionRequestHttp.ts.
 *
 * Покрива: бутонът само в собствения профил, отделно от административното
 * изтриване, изключен флаг, отваряне/затваряне (Escape, "Отказ", клик извън),
 * без парола/без потвърждение, грешна парола, двойно натискане, активен бан,
 * вече подадена заявка, приета заявка с крайната дата от сървъра, без
 * съхраняване на паролата, екранът от 4H (45-дневен срок, отмяна, изтекъл
 * срок), мобилен и настолен изглед, редакция и галерия без регресия.
 *
 * Употреба (от корена): npx tsx scripts/checkProfileSelfDeletionUi.ts
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

type Harness = Record<string, (...args: any[]) => any>
async function h<T = unknown>(page: Page, method: string, ...args: unknown[]): Promise<T> {
  return await page.evaluate(({ method: m, args: a }) => {
    const harness = (window as any).__selfDeletionUiHarness as Harness
    return harness[m]!(...a)
  }, { method, args }) as T
}
const callNames = async (page: Page) => (await h<Array<{ name: string }>>(page, 'getCalls')).map((entry) => entry.name)

console.log('\ncheckProfileSelfDeletionUi')

let vite: ViteDevServer | null = null
let browser: Browser | null = null

try {
  const port = await findFreePort()
  vite = await createViteServer({ root: process.cwd(), server: { port, strictPort: true, host: '127.0.0.1' }, logLevel: 'error' })
  await vite.listen()
  const baseUrl = `http://127.0.0.1:${port}/scripts/fixtures/selfDeletionUiHarness.html`
  browser = await chromium.launch()

  async function newPage(viewport: { width: number; height: number }, hasTouch = false): Promise<Page> {
    const context = await browser!.newContext({ viewport, hasTouch, isMobile: hasTouch, locale: 'bg-BG', timezoneId: 'Europe/Sofia' })
    const page = await context.newPage()
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await page.goto(baseUrl)
    await page.waitForFunction(() => (window as any).__selfDeletionUiHarness !== undefined, undefined, { timeout: 15_000 })
    ;(page as any).__pageErrors = pageErrors
    return page
  }
  const assertNoPageErrors = (page: Page, label: string) => {
    const errors = (page as any).__pageErrors as string[]
    assert(errors.length === 0, `${label}: ${errors.join(' | ')}`)
  }

  const page = await newPage({ width: 1280, height: 900 })

  console.log('\n[P] Профилен popup')

  await check('[1] Собственият профил (наличен флаг): "Изтрий" до "Редакция"; кликът вика само onSelfDeleteClick', async () => {
    await h(page, 'renderPopup', { isOwnProfile: true, canSelfDelete: true })
    const button = page.locator('[data-player-profile-self-delete="1"]')
    assert(await button.isVisible(), 'бутонът "Изтрий" липсва')
    assert((await button.textContent())?.trim() === 'Изтрий', 'текстът на бутона')
    const row = page.locator('[data-player-profile-own-actions="1"]')
    assert((await row.locator('[data-player-profile-edit="1"]').count()) === 1, '"Редакция" не е в същия ред')
    await h(page, 'clearCalls')
    await button.click()
    const names = await callNames(page)
    assert(names.length === 1 && names[0] === 'onSelfDeleteClick', JSON.stringify(names))
    await button.focus()
    await page.keyboard.press('Enter')
    assert((await callNames(page)).filter((n) => n === 'onSelfDeleteClick').length === 2, 'клавиатурен достъп (Enter)')
  })

  await check('[2] Чужд профил: няма "Изтрий" дори при наличен флаг', async () => {
    await h(page, 'renderPopup', { isOwnProfile: false, canSelfDelete: true })
    assert((await page.locator('[data-player-profile-self-delete="1"]').count()) === 0, 'бутонът е в чужд профил')
  })

  // Етап 4J — реалната admin сесия: сървърът дава profileSelfDeletionAvailable
  // САМО на роля player (виж [E5]/[E5b] в checkProfileDeletionRequestHttp.ts),
  // затова за admin canSelfDelete е винаги false.
  await check('[3] Административното изтриване остава отделно: admin вижда своя бутон само за чужд профил; в собствения профил на admin няма "Изтрий" (нито самоизтриване, нито административно)', async () => {
    await h(page, 'renderPopup', { isOwnProfile: false, canSelfDelete: false, viewerIsFullAdmin: true })
    assert((await page.locator('[data-player-profile-delete-open]').count()) === 1, 'административният бутон липсва')
    assert((await page.locator('[data-player-profile-self-delete="1"]').count()) === 0, 'самоизтриване в чужд профил')
    await h(page, 'clearCalls')
    await page.locator('[data-player-profile-delete-open]').click()
    assert(!(await callNames(page)).includes('onSelfDeleteClick'), 'административният бутон вика самоизтриването')
    await h(page, 'renderPopup', { isOwnProfile: true, canSelfDelete: false, viewerIsFullAdmin: true })
    assert((await page.locator('[data-player-profile-delete-open]').count()) === 0, 'административен бутон в собствения профил')
    assert((await page.locator('[data-player-profile-self-delete="1"]').count()) === 0, 'самоизтриване в собствения профил на admin')
    assert(await page.locator('[data-player-profile-edit="1"]').isVisible(), '"Редакция" в собствения профил на admin')
  })

  await check('[4/21] Изключен флаг: няма "Изтрий"; "Редакция" и галерията са непроменени', async () => {
    await h(page, 'renderPopup', { isOwnProfile: true, canSelfDelete: false })
    assert((await page.locator('[data-player-profile-self-delete="1"]').count()) === 0, 'бутонът при изключен флаг')
    assert(await page.locator('[data-player-profile-edit="1"]').isVisible(), '"Редакция"')
    assert((await page.locator('[data-gallery-image-url="/api/profiles/p-own/gallery/img-1"]').count()) === 1, 'галерията')
    await h(page, 'clearCalls')
    await page.locator('[data-player-profile-edit="1"]').click()
    const names = await callNames(page)
    assert(names.length === 1 && names[0] === 'onEditClick', JSON.stringify(names))
    await h(page, 'closePopup')
    assertNoPageErrors(page, '[4]')
  })

  console.log('\n[D] Прозорец за потвърждение')
  const dialog = page.locator('#self-deletion-dialog [role="dialog"]')
  const password = page.locator('[data-self-deletion-password="1"]')
  const confirm = page.locator('[data-self-deletion-confirm="1"]')
  const submit = page.locator('[data-self-deletion-submit="1"]')
  const errorBox = page.locator('[data-self-deletion-error="1"]')

  await check('[5] Отваряне: заглавие, текстове, поле за парола, потвърждение; Escape, "Отказ" и клик извън затварят без подаване', async () => {
    await h(page, 'clearCalls')
    await h(page, 'openDialog')
    assert(await dialog.isVisible(), 'прозорецът')
    const text = (await dialog.textContent()) ?? ''
    for (const fragment of ['Изтриване на профила', 'Ще имаш 30 дни', 'окончателно изтрит съгласно правилата на сайта', 'лични разговори', 'анонимен вид', 'Въведи настоящата си парола', 'Разбирам, че профилът ми ще бъде скрит', 'Потвърди изтриването', 'Отказ']) {
      assert(text.includes(fragment), `липсва: ${fragment}`)
    }
    assert((await password.getAttribute('type')) === 'password' && (await password.getAttribute('autocomplete')) === 'current-password', 'поле за парола')
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-self-deletion-password') === '1', undefined, { timeout: 3_000 })
      .catch(() => { throw new Error('фокус в полето за парола') })
    assert(await dialog.getAttribute('aria-modal') === 'true' && (await page.locator('label[for="self-deletion-password"]').count()) === 1, 'достъпност')
    await page.keyboard.press('Escape')
    assert((await page.locator('#self-deletion-dialog').count()) === 0, 'Escape не затвори')
    await h(page, 'openDialog')
    await page.locator('[data-self-deletion-cancel="1"]').click()
    assert((await page.locator('#self-deletion-dialog').count()) === 0, '"Отказ" не затвори')
    await h(page, 'openDialog')
    await page.mouse.click(5, 5)
    assert((await page.locator('#self-deletion-dialog').count()) === 0, 'клик извън не затвори')
    assert(!(await callNames(page)).includes('submit'), 'подаване при затваряне')
  })

  await check('[6/7] Без парола или без потвърждение бутонът е недостъпен и нищо не се подава', async () => {
    await h(page, 'clearCalls')
    await h(page, 'openDialog')
    assert(await submit.isDisabled(), 'празна форма')
    await password.fill('secret123')
    assert(await submit.isDisabled(), 'само парола')
    await password.fill('')
    await confirm.check()
    assert(await submit.isDisabled(), 'само потвърждение')
    await password.press('Enter')
    assert(!(await callNames(page)).includes('submit'), 'Enter подаде непълна форма')
    await page.keyboard.press('Escape')
  })

  await check('[8/10/22] Грешна парола: едно подаване при двойно натискане/Enter, състояние "Изпращане…", разбираема грешка, полето е изчистено, нищо в localStorage/sessionStorage', async () => {
    await h(page, 'clearCalls')
    await h(page, 'openDialog')
    await password.fill('wrong-pass-1')
    await confirm.check()
    assert(await submit.isEnabled(), 'бутонът трябва да е активен')
    await submit.click()
    await submit.click({ force: true }).catch(() => {})
    await page.keyboard.press('Enter')
    assert((await callNames(page)).filter((n) => n === 'submit').length === 1, `подавания: ${(await callNames(page)).join(',')}`)
    assert((await submit.textContent())?.includes('Изпращане') === true && await submit.isDisabled(), 'състояние на изпълнение')
    assert((await h<string>(page, 'storageSnapshot')).includes('wrong-pass-1') === false, 'паролата е съхранена')
    await h(page, 'resolveSubmit', { ok: false, code: 'INVALID_PASSWORD', message: 'Грешна парола.' })
    await page.waitForFunction(() => (document.querySelector('[data-self-deletion-error="1"]') as HTMLElement | null)?.style.display !== 'none')
    assert((await errorBox.textContent())?.includes('Паролата не е вярна') === true, await errorBox.textContent() ?? '')
    assert((await errorBox.getAttribute('role')) === 'alert', 'role=alert')
    assert((await password.inputValue()) === '', 'полето не е изчистено')
    assert(await dialog.isVisible(), 'прозорецът се затвори')
    const names = await callNames(page)
    assert(names.includes('onSubmitStart') && names.includes('onSubmitFailed') && !names.includes('onAccepted'), JSON.stringify(names))
    assert((await h<string[]>(page, 'submittedPasswords')).at(-1) === 'wrong-pass-1', 'изпратената парола')
  })

  await check('[11/12/14] Активен бан, вече подадена заявка, активна игра и липса на връзка: ясни съобщения, без "приета"', async () => {
    for (const [result, fragment] of [
      [{ ok: false, code: 'PROFILE_BANNED', message: 'x' }, 'активен бан'],
      [{ ok: false, code: 'ALREADY_PENDING', message: 'x' }, 'Вече има подадена заявка'],
      [{ ok: false, code: 'ACTIVE_GAME_OR_TOURNAMENT', message: 'В момента участвате в активна игра или незавършил турнир.' }, 'активна игра'],
      [{ ok: false, code: null, message: null }, 'Няма връзка със сървъра'],
    ] as const) {
      await password.fill('secret123')
      await confirm.check()
      await submit.click()
      await h(page, 'resolveSubmit', result)
      await page.waitForFunction((expected) => (document.querySelector('[data-self-deletion-error="1"]')?.textContent ?? '').includes(expected), fragment)
      assert(!(await callNames(page)).includes('onAccepted'), `приета при ${result.code}`)
      assert(!((await dialog.textContent()) ?? '').includes('Заявката е приета'), 'показва "приета"')
    }
    await page.keyboard.press('Escape')
  })

  await check('[9/15] Приета заявка: крайната дата е от отговора на сървъра (Europe/Sofia), без затваряне с Escape; "Разбрах" -> чисто презареждане', async () => {
    await h(page, 'clearCalls')
    await h(page, 'openDialog')
    await password.fill('secret123')
    await confirm.check()
    await submit.click()
    await h(page, 'resolveSubmit', { ok: true, scheduledFor: '2026-11-23T10:15:00.000Z', gracePeriodDays: 30 })
    await page.waitForSelector('[data-self-deletion-deadline="1"]')
    const expected = await page.evaluate(() => new Date('2026-11-23T10:15:00.000Z').toLocaleString('bg-BG', { timeZone: 'Europe/Sofia', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }))
    assert((await page.locator('[data-self-deletion-deadline="1"]').textContent()) === expected && expected.includes('23.11.2026') && expected.includes('12:15'), `дата: ${await page.locator('[data-self-deletion-deadline="1"]').textContent()} / ${expected}`)
    const text = (await dialog.textContent()) ?? ''
    assert(text.includes('Заявката е приета') && text.includes('Запази профила ми'), text)
    assert((await callNames(page)).filter((n) => n === 'onAccepted').length === 1, 'onAccepted')
    await page.keyboard.press('Escape')
    await page.mouse.click(5, 5)
    assert(await dialog.isVisible(), 'потвърждението изчезна без "Разбрах"')
    await page.locator('[data-self-deletion-done="1"]').click()
    assert((await callNames(page)).includes('onAcceptedClose'), 'onAcceptedClose')
    await h(page, 'removeOverlays')
    assertNoPageErrors(page, '[9]')
  })

  console.log('\n[H] Екранът от Етап 4H')

  await check('[16] Историческа 45-дневна заявка: показва точния срок от сървъра и двата избора', async () => {
    await h(page, 'clearCalls')
    await h(page, 'openPendingPrompt', { restoreAvailable: true, restoreToken: 'tok-45', scheduledFor: '2026-12-05T08:00:00.000Z', gracePeriodDays: 45, isBanned: false })
    const expected = await page.evaluate(() => new Date('2026-12-05T08:00:00.000Z').toLocaleString('bg-BG', { timeZone: 'Europe/Sofia', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }))
    const text = (await page.locator('#pending-deletion-prompt').textContent()) ?? ''
    assert(text.includes(expected) && text.includes('05.12.2026'), `срок: ${text}`)
    assert(text.includes('Запази профила ми') && text.includes('Остави заявката активна'), 'изборите')
  })

  await check('[17] "Запази профила ми" през съществуващия екран: отмяна с токена, после вход', async () => {
    await h(page, 'setPendingActionResult', { ok: true, state: 'cancelled' })
    await page.locator('[data-pending-deletion-cancel="1"]').click()
    await page.waitForFunction(() => (document.querySelector('#pending-deletion-prompt')?.textContent ?? '').includes('отменена'))
    const calls = await h<Array<{ name: string; args: unknown[] }>>(page, 'getCalls')
    assert(calls.some((entry) => entry.name === 'cancelRequest' && entry.args[0] === 'tok-45'), JSON.stringify(calls))
    await page.locator('[data-pending-deletion-login="1"]').click()
    assert((await callNames(page)).includes('onGoToLogin'), 'вход')
  })

  // Етап 4J1 — отмяната е приета, но още не е окончателна (чака offsite потвърждение).
  await check('[17b] Приета, неокончателна отмяна: междинно съобщение, БЕЗ "отменена" и без "Към вход"', async () => {
    await h(page, 'openPendingPrompt', { restoreAvailable: true, restoreToken: 'tok-pending', scheduledFor: '2026-12-05T08:00:00.000Z', gracePeriodDays: 30, isBanned: true })
    await h(page, 'setPendingActionResult', { ok: true, state: 'pending_confirmation', message: null })
    await page.locator('[data-pending-deletion-cancel="1"]').click()
    await page.locator('[data-pending-deletion-cancellation-pending="1"]').waitFor()
    const text = (await page.locator('#pending-deletion-prompt').textContent()) ?? ''
    assert(text.includes('Отмяната е приета') && text.includes('няма да бъде изтрит'), `текст: ${text}`)
    assert(!text.includes('отменена и профилът е запазен'), 'окончателен успех при чакаща отмяна')
    assert(text.includes('Банът остава'), 'банът')
    assert((await page.locator('[data-pending-deletion-login="1"]').count()) === 0, '"Към вход"')
    assert((await page.locator('[data-pending-deletion-close="1"]').count()) === 1, '"Затвори"')
    await h(page, 'setPendingActionResult', { ok: true })
    await h(page, 'removeOverlays')
  })

  await check('[17c] Вход при вече приета отмяна (cancellationPending): само съобщение, без бутони за отмяна/запазване', async () => {
    await h(page, 'openPendingPrompt', { restoreAvailable: false, cancellationPending: true, cancellationMessage: 'Отмяната е приета и профилът няма да бъде изтрит.', isBanned: false })
    assert((await page.locator('[data-pending-deletion-cancellation-pending="1"]').count()) === 1, 'междинно съобщение')
    assert((await page.locator('[data-pending-deletion-cancel="1"], [data-pending-deletion-keep="1"]').count()) === 0, 'бутони')
    assert(!((await page.locator('#pending-deletion-prompt').textContent()) ?? '').includes('Срокът за отмяна'), 'грешно "изтекъл срок"')
    await h(page, 'removeOverlays')
  })

  await check('[18] Изтекъл срок: няма активен бутон за отмяна', async () => {
    await h(page, 'openPendingPrompt', { restoreAvailable: false, isBanned: false })
    assert((await page.locator('[data-pending-deletion-cancel="1"]').count()) === 0, 'бутон за отмяна')
    assert(((await page.locator('#pending-deletion-prompt').textContent()) ?? '').includes('Срокът за отмяна на заявката е изтекъл'), 'текст')
    await h(page, 'removeOverlays')
    assertNoPageErrors(page, '[18]')
  })

  console.log('\n[V] Мобилен и настолен изглед')

  for (const [label, viewport, touch] of [
    ['[19] Малък телефон 320×568', { width: 320, height: 568 }, true],
    ['[19] Телефон 360×640 (клавиатура ≈ половин екран: 360×330)', { width: 360, height: 330 }, true],
    ['[20] Компютър 1280×900', { width: 1280, height: 900 }, false],
  ] as const) {
    await check(`${label}: бутонът и прозорецът се събират, превъртат се, без хоризонтално излизане`, async () => {
      const p = await newPage(viewport, touch)
      await h(p, 'renderPopup', { isOwnProfile: true, canSelfDelete: true })
      const selfDelete = p.locator('[data-player-profile-self-delete="1"]')
      await selfDelete.scrollIntoViewIfNeeded()
      const box = await selfDelete.boundingBox()
      assert(box !== null && box.x >= 0 && box.x + box.width <= viewport.width, `бутонът "Изтрий" извън екрана: ${JSON.stringify(box)}`)
      await h(p, 'closePopup')
      await h(p, 'openDialog')
      const card = p.locator('#self-deletion-dialog [role="dialog"]')
      const cardBox = await card.boundingBox()
      assert(cardBox !== null && cardBox.x >= 0 && cardBox.x + cardBox.width <= viewport.width, `прозорецът е по-широк от екрана: ${JSON.stringify(cardBox)}`)
      for (const selector of ['[data-self-deletion-password="1"]', '[data-self-deletion-confirm="1"]', '[data-self-deletion-submit="1"]', '[data-self-deletion-cancel="1"]']) {
        const element = p.locator(selector)
        await element.scrollIntoViewIfNeeded()
        const elementBox = await element.boundingBox()
        assert(elementBox !== null && elementBox.y >= 0 && elementBox.y + elementBox.height <= viewport.height + 1 && elementBox.x + elementBox.width <= viewport.width,
          `${selector} не е достъпен: ${JSON.stringify(elementBox)}`)
      }
      const submitBox = await p.locator('[data-self-deletion-submit="1"]').boundingBox()
      assert(submitBox !== null && submitBox.height >= 44, 'бутонът за потвърждение е твърде малък за докосване')
      const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      assert(overflow <= 0, `хоризонтално излизане: ${overflow}px`)
      if (touch) {
        await p.locator('[data-self-deletion-submit="1"]').tap().catch(() => {})
        assert(!(await callNames(p)).includes('submit'), 'едно докосване подаде без парола/потвърждение')
      }
      assertNoPageErrors(p, label)
      await p.context().close()
    })
  }
} catch (error) {
  failed += 1
  console.error(`  FAIL  неочаквана грешка: ${error instanceof Error ? error.stack : String(error)}`)
} finally {
  await browser?.close().catch(() => {})
  await vite?.close().catch(() => {})
}

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)
process.exitCode = failed > 0 ? 1 : 0
