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

// ─── Етап 4M1 — правните текстове (без браузър) ─────────────────────────
console.log('\n[L] Общи условия и Политика за поверителност')
{
  const { PUBLIC_LEGAL_PAGES, VOLUNTARY_PROFILE_DELETION_TERMS_ANCHOR } = await import('../src/app/lobby/publicLegalPages')
  const blocksOf = (body: string) => body.split(/\n{2,}/).map((block) => block.trim()).filter((block) => block.length > 0)
  const sectionNumbers = (blocks: string[]) => blocks.map((block) => /^(\d+)\.\s/.exec(block)?.[1]).filter((n): n is string => n !== undefined).map(Number)
  const assertSections = (label: string, blocks: string[], count: number) => {
    const numbers = sectionNumbers(blocks)
    assert(JSON.stringify(numbers) === JSON.stringify(Array.from({ length: count }, (_, i) => i + 1)), `${label}: номерация ${JSON.stringify(numbers)}`)
    blocks.forEach((block, index) => {
      if (/^\d+\.\s/.test(block)) assert(blocks[index + 1] !== undefined && !/^\d+\.\s/.test(blocks[index + 1]!), `${label}: празен раздел "${block}"`)
    })
  }
  const terms = PUBLIC_LEGAL_PAGES.terms
  const privacy = PUBLIC_LEGAL_PAGES.privacy
  const termsBlocks = blocksOf(terms.body)
  const privacyBlocks = blocksOf(privacy.body)

  await check('[L1] Общи условия: разделите са 1–31 последователно, без празен раздел; раздел 28 има директна връзка; т. 27 препраща към него', () => {
    assertSections('Общи условия', termsBlocks, 31)
    assert(termsBlocks.includes('28. Доброволно изтриване на профил'), 'раздел 28')
    assert(terms.sectionAnchors?.['28. Доброволно изтриване на профил'] === VOLUNTARY_PROFILE_DELETION_TERMS_ANCHOR && VOLUNTARY_PROFILE_DELETION_TERMS_ANCHOR === 'voluntary-profile-deletion', 'anchor')
    for (const heading of ['27. Прекратяване и ограничаване на достъпа', '29. Промяна на Общите условия', '30. Приложимо право и спорове', '31. Заключителни разпоредби']) {
      assert(termsBlocks.includes(heading), `липсва "${heading}"`)
    }
    assert(terms.body.includes('да поиска изтриване на профила си съгласно раздел 28'), 'т. 27 -> 28')
  })

  await check('[L2] Раздел 28 описва реалните правила (бутон, парола, откази, 30 дни, отмяна, разговорите и за двамата, жълтици/VIP, запазени записи)', () => {
    const start = termsBlocks.indexOf('28. Доброволно изтриване на профил')
    const section = termsBlocks.slice(start, termsBlocks.indexOf('29. Промяна на Общите условия')).join('\n')
    for (const fragment of ['бутона „Изтрий“', 'текущата парола', 'Не се изпраща допълнителен код по имейл', 'активна игра', 'маса в Белот', 'маса в „Не се сърди човече“', 'търси игра', 'организира турнир', 'активен бан', 'не напуска вместо потребителя', 'срок от 30 дни', '„Запази профила ми“', 'възстановяването на паролата', 'може да отнеме известно време', 'отмени заявката автоматично', 'може да бъде отложено', 'не може да бъде възстановен', 'и за двамата участници, включително прикачените файлове', 'VIP статуса се губят', 'освен ако приложимото законодателство изисква друго', 'без името на потребителя', 'не ограничава другите права']) {
      assert(section.includes(fragment), `раздел 28: липсва "${fragment}"`)
    }
    assert(!/Лудо/i.test(section), '"Лудо" в потребителския текст')
  })

  await check('[L3] Политика за поверителност: разделите са 1–15; изтрити / без идентификатор / псевдонимизирани записи; права и канали за контакт са запазени; без placeholder-и и номера на членове', () => {
    assertSections('Политика', privacyBlocks, 15)
    const body = privacy.body
    for (const fragment of [
      'право на достъп до личните си данни, корекция на неточни данни, изтриване', // съществуващите права
      'belot.pika.bg [at] gmail.com', // съществуващият официален канал
      'раздела „Поддръжка“', 'достъпен и без вход в профил',
      'Изтриват се:', 'личните разговори и прикачените към тях файлове — за двамата участници',
      'Запазват се без идентификатор на потребителя:', 'Запазват се с вътрешен идентификатор вместо име (псевдонимизирани):',
      'Тези записи не са анонимни', 'Регистър на изтриванията:', 'Резервни копия:',
      'не ограничава правото на потребителя да поиска изтриване', 'не е срокът за отговор на искания',
      'ще проверим, че искането идва от собственика на профила',
    ]) {
      assert(body.includes(fragment), `Политика: липсва "${fragment}"`)
    }
    for (const forbidden of [/\[да се уточни/i, /\bчл\.\s*\d/, /Регламент/, /GDPR/]) {
      assert(!forbidden.test(body) && !forbidden.test(terms.body), `недопустим текст: ${forbidden}`)
    }
  })
}

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
    // Етап 4M1 — одобреният окончателен текст (точно), на "Вие".
    const paragraphs = await page.locator('#self-deletion-description p').allTextContents()
    const expectedParagraphs = [
      'След потвърждението профилът Ви ще бъде скрит, а всички активни сесии ще бъдат прекратени.',
      'Разполагате с 30 дни, за да отмените заявката.',
      'За да отмените заявката за изтриване, трябва да влезете със своя имейл и парола и да изберете „Запази профила ми“.',
      'След изтичането на 30-дневния срок профилът подлежи на окончателно изтриване и няма да може да бъде възстановен.',
      'Подробна информация: Общи условия, раздел 28.',
    ]
    assert(JSON.stringify(paragraphs.map((p) => p.trim())) === JSON.stringify(expectedParagraphs), `текст: ${JSON.stringify(paragraphs)}`)
    assert((await page.locator('#self-deletion-dialog h2').textContent())?.trim() === 'Изтриване на профила', 'заглавие')
    assert((await page.locator('label[for="self-deletion-password"]').textContent())?.trim() === 'Въведете текущата си парола.', 'етикет на паролата')
    assert((await page.locator('[data-self-deletion-confirm="1"] + span').textContent())?.trim() === 'Разбирам, че след изтичането на 30-дневния срок няма да мога самостоятелно да отменя заявката.', 'текст на отметката')
    assert((await page.locator('[data-self-deletion-submit="1"]').textContent())?.trim() === 'Потвърди изтриването' && (await page.locator('[data-self-deletion-cancel="1"]').textContent())?.trim() === 'Отказ', 'бутони')
    // Без подробен списък в прозореца (той е в Общите условия).
    for (const forbidden of ['снимк', 'разговор', 'жълтиц', 'VIP', 'анонимен', 'съгласно правилата на сайта', ' ти ', 'Въведи']) {
      assert(!text.includes(forbidden), `прозорецът съдържа "${forbidden}"`)
    }
    const termsLink = page.locator('[data-self-deletion-terms-link="1"]')
    assert((await termsLink.getAttribute('href')) === '/terms#voluntary-profile-deletion', `href=${await termsLink.getAttribute('href')}`)
    assert((await termsLink.getAttribute('target')) === '_blank' && (await termsLink.getAttribute('rel')) === 'noopener', 'връзката се отваря в нов раздел')
    assert((await termsLink.textContent())?.trim() === 'Общи условия, раздел 28', 'текст на връзката')
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
      [{ ok: false, code: 'ACTIVE_GAME', message: 'x' }, 'Не можете да подадете заявка за изтриване, докато участвате в активна игра. Изчакайте играта да приключи и опитайте отново. Профилът не е изтрит и заявка за изтриване не е приета.'],
      [{ ok: false, code: 'BELOT_PRIVATE_TABLE', message: 'x' }, 'Имате заето място на частна маса в Белот. Напуснете масата, преди да подадете заявка за изтриване на профила. Профилът не е изтрит'],
      [{ ok: false, code: 'LUDO_PRIVATE_TABLE', message: 'x' }, 'Имате заето място на частна маса в „Не се сърди човече“. Напуснете масата, преди да подадете заявка за изтриване на профила. Профилът не е изтрит'],
      [{ ok: false, code: 'BELOT_MATCHMAKING', message: 'x' }, 'В момента търсите игра в Белот. Спрете търсенето'],
      [{ ok: false, code: 'TOURNAMENT_ORGANIZER', message: 'x' }, 'Не можете да подадете заявка за изтриване на профила, защото сте организатор на турнир, който още не е приключил. Изчакайте турнирът да приключи или го отменете, ако това все още е възможно, след което опитайте отново. Профилът не е изтрит и заявка за изтриване не е приета.'],
      [{ ok: false, code: 'TOURNAMENT_REGISTRATION', message: 'x' }, 'Не можете да подадете заявка за изтриване на профила, защото сте записан за участие в турнир. Напуснете турнира или изчакайте той да приключи, след което опитайте отново. Профилът не е изтрит'],
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

  await check('[17d] Етап 4K2 — чакаща автоматична отмяна: текстът от сървъра, без "Профилът Ви е запазен" и без бутони', async () => {
    await h(page, 'openPendingPrompt', { restoreAvailable: false, cancellationPending: true, cancellationMessage: 'Установено е участие в игра или заето място на маса. Отмяната на заявката за изтриване е приета и очаква потвърждение. Докато процесът приключи, профилът остава временно скрит.', isBanned: false })
    const text = (await page.locator('[data-pending-deletion-cancellation-pending="1"]').textContent()) ?? ''
    assert(text === 'Установено е участие в игра или заето място на маса. Отмяната на заявката за изтриване е приета и очаква потвърждение. Докато процесът приключи, профилът остава временно скрит.', text)
    assert(!((await page.locator('#pending-deletion-prompt').textContent()) ?? '').includes('Профилът Ви е запазен'), 'преждевременно "запазен"')
    assert((await page.locator('[data-pending-deletion-cancel="1"], [data-pending-deletion-keep="1"]').count()) === 0, 'бутони')
    await h(page, 'removeOverlays')
  })

  await check('[17e] Етап 4K2 — уведомление след вход: точният текст, "Разбрах" го затваря; без локално съхранение', async () => {
    const storageBefore = await h<string>(page, 'storageSnapshot')
    await h(page, 'openAutoCancelNotice', 'Заявката Ви за изтриване беше отменена автоматично. Установено е, че имате заето място на маса или участвате в игра. Профилът Ви е запазен. След като напуснете масата или играта приключи, можете да подадете нова заявка за изтриване.')
    const notice = page.locator('#profile-deletion-auto-cancel-notice')
    assert((await page.locator('[data-profile-deletion-auto-cancel-text="1"]').textContent()) === 'Заявката Ви за изтриване беше отменена автоматично. Установено е, че имате заето място на маса или участвате в игра. Профилът Ви е запазен. След като напуснете масата или играта приключи, можете да подадете нова заявка за изтриване.', 'текст')
    assert((await notice.locator('[role="alertdialog"]').count()) === 1, 'role')
    await page.locator('[data-profile-deletion-auto-cancel-ok="1"]').click()
    assert((await notice.count()) === 0, 'не се затвори')
    assert((await h<string>(page, 'storageSnapshot')) === storageBefore, 'локално съхранение')
    assertNoPageErrors(page, '[17e]')
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
      for (const selector of ['[data-self-deletion-terms-link="1"]', '[data-self-deletion-password="1"]', '[data-self-deletion-confirm="1"]', '[data-self-deletion-submit="1"]', '[data-self-deletion-cancel="1"]']) {
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
