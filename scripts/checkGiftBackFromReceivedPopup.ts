// checkGiftBackFromReceivedPopup.ts
//
// Real spawned-server + real browser (Playwright, production controller,
// real UI clicks) check за "Подари и ти" в received-gift popup-ите:
//  - live push popup (main.ts::showGiftItemReceivedPopup) и offline опашката
//    (lobby renderGiftItemReceivedModal) показват "OK" + "Подари и ти";
//  - "OK" работи както досега (затваря, нищо не се праща);
//  - "Подари и ти" затваря received popup-а и отваря СЪЩЕСТВУВАЩИЯ gift item
//    picker с recipient = оригиналния sender profile_id;
//  - избраният подарък минава през нормалния POST /api/profile/:id/send-gift-item
//    към този профил (DB: sender=B, recipient=A, debit = DB цената);
//  - display name не се ползва като идентификатор (offline delivery с подменен
//    from_display_name към ДРУГ съществуващ потребител пак стига до A);
//  - cancel от picker-а не праща нищо; недостатъчен баланс = сегашното
//    поведение; бързи/повторни кликове → 1 request, 1 debit;
//  - блокиран подател / липсващ sender id → без невалиден picker;
//  - mobile (320/360) и desktop layout на бутоните.
//
// Harness: scripts/giftBackTestHarness.ts (изолирано копие на server/src +
// празна DB, никога реалната база; seed директно в изолираната SQLite база).

import { join } from 'node:path'
import type { Page } from 'playwright'
import { assert, check, finishAndExit, sleep, startGiftBackHarness, type OpenedPage, type TestProfile } from './giftBackTestHarness'

console.log('\ncheckGiftBackFromReceivedPopup\n')

const h = await startGiftBackHarness()

try {
  const { db, backendOrigin, runId, CHEAP_ID, PRICEY_ID, CHEAP_PRICE, getBalance, setBalance, txCount, sendGiftViaApi } = h
  const A = await h.register('a') // оригинален подател
  const B = await h.register('b') // получател, който връща подарък
  const C = await h.register('c') // decoy: display name-ът му се подменя в delivery
  setBalance(A.profileId, 100_000)
  setBalance(B.profileId, 10_000)

  const openLobby = (profile: TestProfile, viewport: { width: number; height: number }): Promise<OpenedPage> =>
    h.openPage(profile, viewport, '/lobby', '[data-lobby-nav-bell="1"]')

  // Опционални screenshot-и за визуален преглед (GIFT_BACK_SCREENSHOT_DIR).
  const screenshotDir = process.env.GIFT_BACK_SCREENSHOT_DIR ?? null
  async function snap(page: Page, name: string): Promise<void> {
    if (screenshotDir) await page.screenshot({ path: join(screenshotDir, `${name}.png`) })
  }

  const LIVE = '#gift-item-received-popup'
  const LIVE_OK = `${LIVE} [data-gift-item-received-ok="1"]`
  const LIVE_BACK = `${LIVE} [data-gift-item-received-gift-back="1"]`
  const LOBBY = '[data-lobby-gift-item-received-root="1"]'
  const LOBBY_OK = `${LOBBY} [data-lobby-gift-item-received-ok="1"]`
  const LOBBY_BACK = `${LOBBY} [data-lobby-gift-item-received-gift-back="1"]`
  const PICKER = '[data-lobby-gift-item-modal-root="1"]'

  async function pickerRecipient(page: Page): Promise<string | null> {
    return page.locator(`${PICKER} [data-lobby-gift-item-recipient]`).getAttribute('data-lobby-gift-item-recipient')
  }

  async function assertActionsLayout(page: Page, dialogSelector: string, label: string): Promise<void> {
    const layout = await page.evaluate(`(() => {
      const dialog = document.querySelector(${JSON.stringify(dialogSelector)})
      const actions = dialog.querySelector('[data-gift-item-received-actions="1"]')
      const buttons = Array.from(actions.querySelectorAll('button'))
      const d = dialog.getBoundingClientRect()
      return {
        dialog: { left: d.left, right: d.right, top: d.top, bottom: d.bottom },
        viewportWidth: window.innerWidth,
        docScrollWidth: document.documentElement.scrollWidth,
        buttons: buttons.map((b) => {
          const r = b.getBoundingClientRect()
          return { text: b.textContent.trim(), left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height, overflows: b.scrollWidth > b.clientWidth + 1 }
        }),
      }
    })()`) as {
      dialog: { left: number; right: number; top: number; bottom: number }
      viewportWidth: number
      docScrollWidth: number
      buttons: Array<{ text: string; left: number; right: number; top: number; bottom: number; height: number; overflows: boolean }>
    }
    assert(layout.buttons.length === 2, `${label}: expected 2 buttons, got ${JSON.stringify(layout.buttons.map((b) => b.text))}`)
    assert(layout.buttons[0]!.text === 'OK' && layout.buttons[1]!.text === 'Подари и ти', `${label}: texts=${JSON.stringify(layout.buttons.map((b) => b.text))}`)
    for (const b of layout.buttons) {
      assert(b.left >= layout.dialog.left - 0.5 && b.right <= layout.dialog.right + 0.5, `${label}: "${b.text}" излиза хоризонтално от popup-а`)
      assert(b.top >= layout.dialog.top - 0.5 && b.bottom <= layout.dialog.bottom + 0.5, `${label}: "${b.text}" излиза вертикално от popup-а`)
      assert(!b.overflows, `${label}: текстът на "${b.text}" е отрязан`)
      assert(b.height >= 40, `${label}: "${b.text}" tap height=${b.height}`)
    }
    const [ok, back] = layout.buttons as [typeof layout.buttons[0], typeof layout.buttons[0]]
    const overlapX = Math.min(ok.right, back.right) - Math.max(ok.left, back.left)
    const overlapY = Math.min(ok.bottom, back.bottom) - Math.max(ok.top, back.top)
    assert(!(overlapX > 0.5 && overlapY > 0.5), `${label}: бутоните се застъпват`)
    assert(layout.docScrollWidth <= layout.viewportWidth, `${label}: хоризонтален scroll ${layout.docScrollWidth} > ${layout.viewportWidth}`)
  }

  // ── 1. Live push (desktop) ─────────────────────────────────────────────
  console.log('=== Live push popup (desktop 1280) ===')
  const bDesktop = await openLobby(B, { width: 1280, height: 850 })

  await sendGiftViaApi(A, B)
  await bDesktop.page.locator(LIVE).waitFor({ state: 'visible', timeout: 10_000 })
  await check('[1] live popup показва "OK" + "Подари и ти" (desktop layout)', async () => {
    await assertActionsLayout(bDesktop.page, `${LIVE} [role="dialog"]`, 'desktop live')
    await snap(bDesktop.page, 'desktop-live')
  })
  await check('[2] "OK" работи както досега: затваря popup-а, без picker, без изпращане', async () => {
    await bDesktop.page.locator(LIVE_OK).click()
    await bDesktop.page.locator(LIVE).waitFor({ state: 'detached', timeout: 3_000 })
    assert((await bDesktop.page.locator(PICKER).count()) === 0, 'picker opened after OK')
    assert(bDesktop.giftSendUrls.length === 0, `unexpected send: ${bDesktop.giftSendUrls.join(', ')}`)
    assert(bDesktop.profileLoadUrls.length === 0, 'OK не трябва да зарежда профил')
  })

  await sendGiftViaApi(A, B)
  await bDesktop.page.locator(LIVE).waitFor({ state: 'visible', timeout: 10_000 })
  await check('[3] "Подари и ти" (двоен клик) затваря received popup-а и отваря ЕДИН picker към sender profile_id', async () => {
    await bDesktop.page.locator(LIVE_BACK).dblclick()
    await bDesktop.page.locator(PICKER).waitFor({ state: 'visible', timeout: 10_000 })
    await bDesktop.page.locator(LIVE).waitFor({ state: 'detached', timeout: 3_000 })
    assert((await bDesktop.page.locator(PICKER).count()) === 1, 'expected exactly one picker')
    assert(bDesktop.profileLoadUrls.length === 1, `expected 1 profile load, got ${bDesktop.profileLoadUrls.length}`)
    assert(bDesktop.profileLoadUrls[0]!.endsWith(`/api/profiles/${encodeURIComponent(A.profileId)}`), `profile load by id expected, got ${bDesktop.profileLoadUrls[0]}`)
    assert(!bDesktop.profileLoadUrls[0]!.includes(encodeURIComponent(A.displayName)), 'display name used in profile load URL')
  })
  await check('[4] recipient в picker-а е точно оригиналният sender profile_id (header = неговото име)', async () => {
    assert((await pickerRecipient(bDesktop.page)) === A.profileId, `recipient=${await pickerRecipient(bDesktop.page)}`)
    const headerText = await bDesktop.page.locator(PICKER).innerText()
    assert(headerText.includes(`Към ${A.displayName}`), `header: ${headerText.slice(0, 120)}`)
  })
  await check('[5] cancel (×) от picker-а не праща нищо и не дебитира', async () => {
    const balanceBefore = getBalance(B.profileId)
    await bDesktop.page.locator('[data-lobby-gift-item-modal-close="1"]').click()
    await bDesktop.page.locator(PICKER).waitFor({ state: 'detached', timeout: 3_000 })
    await sleep(300)
    assert(bDesktop.giftSendUrls.length === 0, `unexpected send: ${bDesktop.giftSendUrls.join(', ')}`)
    assert(txCount(B.profileId, A.profileId) === 0, 'transaction created on cancel')
    assert(getBalance(B.profileId) === balanceBefore, 'balance changed on cancel')
  })

  await sendGiftViaApi(A, B)
  await bDesktop.page.locator(LIVE).waitFor({ state: 'visible', timeout: 10_000 })
  await check('[6] недостатъчен баланс = сегашното поведение (скъпият подарък е disabled, няма изпращане)', async () => {
    await bDesktop.page.locator(LIVE_BACK).click()
    await bDesktop.page.locator(`${PICKER} [data-lobby-gift-item-select="${CHEAP_ID}"]`).waitFor({ state: 'visible', timeout: 10_000 })
    const pricey = bDesktop.page.locator(`${PICKER} [data-lobby-gift-item-select="${PRICEY_ID}"]`)
    assert(await pricey.isDisabled(), 'pricey gift should be disabled for insufficient balance')
    await pricey.click({ force: true })
    await sleep(300)
    assert(bDesktop.giftSendUrls.length === 0, 'disabled gift must not send')
  })
  await check('[7] server-side недостатъчен баланс → съществуващото "Нямаш достатъчно жълтици.", без transaction', async () => {
    const balanceBefore = getBalance(B.profileId)
    setBalance(B.profileId, 0) // клиентът още "мисли", че може да си позволи евтиния
    await bDesktop.page.locator(`${PICKER} [data-lobby-gift-item-select="${CHEAP_ID}"]`).click()
    await bDesktop.page.locator(`${PICKER}`).getByText('Нямаш достатъчно жълтици.').waitFor({ state: 'visible', timeout: 5_000 })
    assert(bDesktop.giftSendUrls.length === 1, `expected 1 send attempt, got ${bDesktop.giftSendUrls.length}`)
    assert(bDesktop.giftSendUrls[0]!.includes(`/api/profile/${encodeURIComponent(A.profileId)}/send-gift-item`), `wrong URL ${bDesktop.giftSendUrls[0]}`)
    assert(txCount(B.profileId, A.profileId) === 0, 'transaction created despite insufficient balance')
    setBalance(B.profileId, balanceBefore)
  })
  await check('[8] избраният подарък отива към оригиналния подател; бърз двоен клик → 1 request, 1 debit', async () => {
    const before = bDesktop.giftSendUrls.length
    const balanceBefore = getBalance(B.profileId)
    // Свежо отваряне на picker-а, за да прочете възстановения баланс.
    await bDesktop.page.locator('[data-lobby-gift-item-modal-close="1"]').click()
    await bDesktop.page.locator(PICKER).waitFor({ state: 'detached', timeout: 3_000 })
    await bDesktop.page.reload()
    await bDesktop.page.locator('[data-lobby-nav-bell="1"]').first().waitFor({ state: 'attached', timeout: 20_000 })
    await bDesktop.page.waitForTimeout(800)
    await sendGiftViaApi(A, B)
    // Снимка СЛЕД като A е платил за собствения си подарък към B.
    const aBalanceBefore = getBalance(A.profileId)
    const receivedBefore = h.txRows(A.profileId, B.profileId).map((r) => r.transaction_id)
    await bDesktop.page.locator(LIVE).waitFor({ state: 'visible', timeout: 10_000 })
    await bDesktop.page.locator(LIVE_BACK).click()
    const cheap = bDesktop.page.locator(`${PICKER} [data-lobby-gift-item-select="${CHEAP_ID}"]`)
    await cheap.waitFor({ state: 'visible', timeout: 10_000 })
    const sendCountBeforeClick = bDesktop.giftSendUrls.length
    await cheap.evaluate((el) => { (el as HTMLButtonElement).click(); (el as HTMLButtonElement).click(); (el as HTMLButtonElement).click() })
    await bDesktop.page.locator('[data-lobby-gift-item-success-root="1"]').waitFor({ state: 'visible', timeout: 10_000 })
    await sleep(400)
    const sends = bDesktop.giftSendUrls.slice(sendCountBeforeClick)
    assert(sends.length === 1, `expected exactly 1 send request, got ${sends.length} (before=${before})`)
    assert(sends[0]!.includes(`/api/profile/${encodeURIComponent(A.profileId)}/send-gift-item`), `wrong recipient URL ${sends[0]}`)
    assert(txCount(B.profileId, A.profileId) === 1, `expected 1 B→A transaction, got ${txCount(B.profileId, A.profileId)}`)
    // Платен flow, не безплатно връщане: balance_before - gift_price = balance_after,
    // charged_price = DB цената, оригиналните A→B подаръци не са пипнати,
    // балансът на A не се променя.
    const balanceAfter = getBalance(B.profileId)
    assert(balanceBefore - CHEAP_PRICE === balanceAfter, `balance_before(${balanceBefore}) - gift_price(${CHEAP_PRICE}) != balance_after(${balanceAfter})`)
    const giftBackRows = h.txRows(B.profileId, A.profileId)
    assert(giftBackRows.length === 1 && giftBackRows[0]!.charged_price === CHEAP_PRICE && giftBackRows[0]!.gift_item_id === CHEAP_ID, `tx rows=${JSON.stringify(giftBackRows)}`)
    assert(getBalance(A.profileId) === aBalanceBefore, 'original sender balance changed')
    assert(JSON.stringify(h.txRows(A.profileId, B.profileId).map((r) => r.transaction_id)) === JSON.stringify(receivedBefore), 'original received gifts modified')
    const successText = await bDesktop.page.locator('[data-lobby-gift-item-success-root="1"]').innerText()
    assert(successText.includes(A.displayName), `success modal should name A: ${successText}`)
    await bDesktop.page.locator('[data-lobby-gift-item-success-ok="1"]').click()
  })
  await check('[9] оригиналният подател получава подаръка през нормалните известия (delivery към A)', () => {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM gift_item_delivery_log d JOIN gift_item_transactions t ON t.transaction_id = d.transaction_id WHERE t.sender_profile_id = ? AND d.recipient_profile_id = ?`).get(B.profileId, A.profileId) as { n: number }
    assert(row.n === 1, `expected 1 pending delivery for offline A, got ${row.n}`)
  })
  await bDesktop.context.close()

  // ── 2. Offline опашка (lobby модал) + display name не е идентификатор ──
  console.log('\n=== Offline queue modal + display name is not an identifier ===')
  const offlineTx = await sendGiftViaApi(A, B) // B е offline → delivery log
  // Подменяме snapshot display name-а към ДРУГ съществуващ потребител (C).
  db.prepare(`UPDATE gift_item_delivery_log SET from_display_name = ? WHERE transaction_id = ?`).run(C.displayName, offlineTx)
  const bMobile = await openLobby(B, { width: 360, height: 740 })
  await bMobile.page.locator(LOBBY).waitFor({ state: 'visible', timeout: 15_000 })
  await check('[10] offline popup показва "OK" + "Подари и ти" (mobile 360 layout)', async () => {
    await assertActionsLayout(bMobile.page, `${LOBBY} [role="dialog"]`, 'mobile 360 offline')
    await snap(bMobile.page, 'mobile-360-offline')
    const text = await bMobile.page.locator(LOBBY).innerText()
    assert(text.includes(C.displayName), 'popup shows the (tampered) display name snapshot')
  })
  await check('[11] display name НЕ е идентификатор: recipient = A.profileId, не C', async () => {
    await bMobile.page.locator(LOBBY_BACK).click()
    await bMobile.page.locator(PICKER).waitFor({ state: 'visible', timeout: 10_000 })
    await bMobile.page.locator(LOBBY).waitFor({ state: 'detached', timeout: 3_000 })
    const recipient = await pickerRecipient(bMobile.page)
    assert(recipient === A.profileId, `recipient=${recipient}, A=${A.profileId}, C=${C.profileId}`)
    assert(bMobile.profileLoadUrls.every((u) => !u.includes(encodeURIComponent(C.profileId)) && !u.includes(encodeURIComponent(C.displayName))), 'C was used')
    await bMobile.page.locator('[data-lobby-gift-item-modal-close="1"]').click()
    await bMobile.page.locator(PICKER).waitFor({ state: 'detached', timeout: 3_000 })
  })
  await check('[12] received delivery-то е маркирано shown след "Подари и ти" (опашката продължава нормално)', () => {
    const row = db.prepare(`SELECT shown_at FROM gift_item_delivery_log WHERE transaction_id = ?`).get(offlineTx) as { shown_at: string | null }
    assert(row.shown_at !== null, 'delivery not marked shown')
  })
  await bMobile.context.close()

  // ── 3. Невалиден подател ──────────────────────────────────────────────
  console.log('\n=== Invalid sender ===')
  // (a) Подател, когото B е блокирал → съществуващото сървърно съобщение, без picker.
  const blockRes = await fetch(`${backendOrigin}/api/profiles/${encodeURIComponent(A.profileId)}/block`, {
    method: 'POST', headers: { Cookie: `belot_session=${B.cookie}` },
  })
  assert(blockRes.ok, `block failed: ${blockRes.status}`)
  await sendGiftViaApi(A, B) // offline delivery
  // (b) Legacy delivery без transaction ред → fromProfileId null.
  db.exec('PRAGMA foreign_keys = OFF;')
  db.prepare(`INSERT INTO gift_item_delivery_log (transaction_id, recipient_profile_id, gift_item_id, item_name, image_url, from_display_name) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(`legacy-${runId}`, B.profileId, CHEAP_ID, 'Роза GB', '/favicon.ico', A.displayName)
  db.exec('PRAGMA foreign_keys = ON;')

  const bSmall = await openLobby(B, { width: 320, height: 640 })
  await bSmall.page.locator(LOBBY).waitFor({ state: 'visible', timeout: 15_000 })
  await check('[13] mobile 320: бутоните са вътре в popup-а', async () => {
    await assertActionsLayout(bSmall.page, `${LOBBY} [role="dialog"]`, 'mobile 320 offline')
  })
  await check('[14] блокиран подател: "Подари и ти" показва съществуващото съобщение и НЕ отваря picker', async () => {
    await bSmall.page.locator(LOBBY_BACK).click()
    await bSmall.page.locator(`${LOBBY} [data-gift-item-received-error="1"]`).waitFor({ state: 'visible', timeout: 10_000 })
    const errorText = await bSmall.page.locator(`${LOBBY} [data-gift-item-received-error="1"]`).innerText()
    assert(errorText.includes('блокиран'), `error text: ${errorText}`)
    await snap(bSmall.page, 'mobile-320-blocked')
    assert((await bSmall.page.locator(PICKER).count()) === 0, 'picker opened for blocked sender')
    assert((await bSmall.page.locator(LOBBY_BACK).count()) === 0, '"Подари и ти" should be hidden after error')
    assert(bSmall.giftSendUrls.length === 0, 'send happened')
  })
  await check('[15] "OK" след грешката затваря и показва следващия (legacy) popup', async () => {
    await bSmall.page.locator(LOBBY_OK).click()
    await bSmall.page.waitForTimeout(400)
    await bSmall.page.locator(LOBBY).waitFor({ state: 'visible', timeout: 5_000 })
  })
  await check('[16] delivery без sender profile_id → само "OK" (без невалиден gift flow)', async () => {
    const buttons = await bSmall.page.locator(`${LOBBY} [data-gift-item-received-actions="1"] button`).allInnerTexts()
    assert(JSON.stringify(buttons.map((t) => t.trim())) === JSON.stringify(['OK']), `buttons=${JSON.stringify(buttons)}`)
    await bSmall.page.locator(LOBBY_OK).click()
    await bSmall.page.locator(LOBBY).waitFor({ state: 'detached', timeout: 5_000 })
  })
  await bSmall.context.close()

  // ── 4. Live popup на mobile 320 ────────────────────────────────────────
  console.log('\n=== Live push popup (mobile 320) ===')
  await fetch(`${backendOrigin}/api/profiles/${encodeURIComponent(A.profileId)}/block`, {
    method: 'POST', headers: { Cookie: `belot_session=${B.cookie}` },
  }) // toggle → unblock
  const bLive320 = await openLobby(B, { width: 320, height: 640 })
  await sendGiftViaApi(A, B)
  await bLive320.page.locator(LIVE).waitFor({ state: 'visible', timeout: 10_000 })
  await check('[17] live popup на mobile 320: бутоните са вътре в popup-а', async () => {
    await assertActionsLayout(bLive320.page, `${LIVE} [role="dialog"]`, 'mobile 320 live')
  })
  await check('[18] payload-ът на live push-а носи стабилния fromProfileId (picker recipient = A)', async () => {
    await bLive320.page.locator(LIVE_BACK).click()
    await bLive320.page.locator(PICKER).waitFor({ state: 'visible', timeout: 10_000 })
    assert((await pickerRecipient(bLive320.page)) === A.profileId, 'recipient mismatch')
    await snap(bLive320.page, 'mobile-320-picker')
  })
  await bLive320.context.close()
} finally {
  await h.close()
}

finishAndExit()
