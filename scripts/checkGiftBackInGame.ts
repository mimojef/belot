// checkGiftBackInGame.ts
//
// Real spawned-server + real browser e2e за "Подари и ти" ПО ВРЕМЕ на
// активна игра (Ludo 2 човека; Белот 1 човек + 3 бота от matchmaking-а):
//  - received UI по време на игра показва "OK" + "Подари и ти";
//  - "Подари и ти" отваря in-game picker-а (createGiftPickerModal,
//    [data-gift-back-picker-host]) БЕЗ да напуска играта;
//  - recipient = оригиналният sender profile_id (profile load + send URL + DB);
//  - cancel не праща нищо; успешно изпращане не прекъсва играта;
//  - бърз многократен клик → 1 request, 1 transaction;
//  - picker-ът е над масата, но под игровите модали (z-index);
//  - таймерите НЕ се паузират/променят: докато picker-ът е отворен клиентът не
//    праща никакви игрови WS съобщения, а сървърът продължава да движи играта
//    (нови snapshot-и/revision-и идват, ходове изтичат нормално);
//  - "Подари и ти" НЕ е безплатно връщане: платен flow (DB цена, debit от
//    текущия подател: balance_before - gift_price = balance_after, нова
//    transaction с charged_price = DB цената, оригиналният получен подарък не
//    се пипа/прехвърля, недостатъчен баланс → отказ без transaction).
//
// НЕ е покрито тук (ръчна проверка): Белот in-game top банерът (offline
// опашка) — при reconnect приложението минава през "Върни ме в играта"
// overlay-я и pending подаръците се представят като lobby модал ПРЕДИ resume,
// така че банерът не е достижим детерминистично с този harness.
//
// Harness: scripts/giftBackTestHarness.ts.

import type { Page } from 'playwright'
import { assert, check, finishAndExit, sleep, startGiftBackHarness, type OpenedPage } from './giftBackTestHarness'

console.log('\ncheckGiftBackInGame\n')

const h = await startGiftBackHarness()

const LIVE = '#gift-item-received-popup'
const LIVE_BACK = `${LIVE} [data-gift-item-received-gift-back="1"]`
const LIVE_OK = `${LIVE} [data-gift-item-received-ok="1"]`
const PICKER_HOST = '[data-gift-back-picker-host="1"]'
const PICKER_CLOSE = `${PICKER_HOST} [data-gift-picker-close="1"]`
const PICKER_TOAST = '[data-gift-back-picker-toast="1"]'
const BANNER = '[data-ingame-gift-banner="1"]'
const BANNER_BACK = `${BANNER} [data-ingame-gift-banner-gift-back="1"]`
const PICKER_Z = 9_997

// WS съобщения, които биха променили игровото състояние/таймерите.
const GAME_ACTION_TYPE = /^(ludo_(roll|move|leave|reclaim|resign|exit)|submit_|play_|cut|bid|declar|leave_room|resume_room|pause|timer|bot_|reclaim)/

async function pickerZIndex(page: Page): Promise<number> {
  return page.evaluate(`Number(getComputedStyle(document.querySelector('${PICKER_HOST}')).zIndex)`) as Promise<number>
}

async function topmostAtPickerCenterIsPicker(page: Page): Promise<boolean> {
  return page.evaluate(`(() => {
    const host = document.querySelector('${PICKER_HOST}')
    const panel = host.querySelector('[data-gift-picker-backdrop="1"] > div')
    const r = panel.getBoundingClientRect()
    const el = document.elementFromPoint(r.left + r.width / 2, r.top + 20)
    return !!el && host.contains(el)
  })()`) as Promise<boolean>
}

function gameActionsSentSince(opened: OpenedPage, since: number): string[] {
  return opened.wsSent.filter((f) => f.at >= since && GAME_ACTION_TYPE.test(f.type)).map((f) => f.type)
}

try {
  const { CHEAP_ID, CHEAP_PRICE, setBalance, getBalance, txCount, txRows, sendGiftViaApi } = h

  // Платен flow: точно една нова transaction giver→originalSender с DB цената,
  // balance_before - gift_price = balance_after за ТЕКУЩИЯ подател,
  // оригиналните получени подаръци (originalSender→giver) непокътнати,
  // балансът на оригиналния sender не се променя от "Подари и ти".
  function assertPaidGiftBack(args: {
    giver: { profileId: string }
    originalSender: { profileId: string }
    giverBalanceBefore: number
    originalSenderBalanceBefore: number
    receivedTxIdsBefore: string[]
  }): void {
    const rows = txRows(args.giver.profileId, args.originalSender.profileId)
    assert(rows.length === 1, `expected 1 gift-back transaction, got ${rows.length}`)
    assert(rows[0]!.gift_item_id === CHEAP_ID, `gift_item_id=${rows[0]!.gift_item_id}`)
    assert(rows[0]!.charged_price === CHEAP_PRICE, `charged_price=${rows[0]!.charged_price} (DB price ${CHEAP_PRICE})`)
    const balanceAfter = getBalance(args.giver.profileId)
    assert(args.giverBalanceBefore - CHEAP_PRICE === balanceAfter, `balance_before(${args.giverBalanceBefore}) - gift_price(${CHEAP_PRICE}) != balance_after(${balanceAfter})`)
    assert(getBalance(args.originalSender.profileId) === args.originalSenderBalanceBefore, 'original sender balance changed by gift-back')
    const receivedNow = txRows(args.originalSender.profileId, args.giver.profileId).map((r) => r.transaction_id)
    assert(JSON.stringify(receivedNow) === JSON.stringify(args.receivedTxIdsBefore), 'original received gift transactions were modified')
    assert(!rows.some((r) => args.receivedTxIdsBefore.includes(r.transaction_id)), 'original gift transaction re-used')
  }
  const S = await h.register('s') // подател извън играта (оригинален sender)
  setBalance(S.profileId, 1_000_000)

  // ── Ludo ─────────────────────────────────────────────────────────────────
  console.log('=== Ludo (2 играча) ===')
  const L1 = await h.register('l1') // получател, връща подарък по време на игра
  const L2 = await h.register('l2')
  setBalance(L1.profileId, 50_000)
  setBalance(L2.profileId, 50_000)

  const l2 = await h.openPage(L2, { width: 1280, height: 850 }, '/games/ludo', '[data-ludo-lobby="1"]')
  await l2.page.locator('[data-ludo-create-open="1"]').click()
  await l2.page.locator('[data-ludo-create-form="1"]').waitFor({ state: 'visible' })
  await l2.page.locator('[data-ludo-create-form="1"] select[name="playerCount"]').selectOption('2')
  const stakeSelect = l2.page.locator('[data-ludo-create-form="1"] select[name="stake"]')
  await stakeSelect.selectOption((await stakeSelect.locator('option').first().getAttribute('value'))!)
  await l2.page.locator('[data-ludo-create-form="1"]').evaluate((form: HTMLFormElement) => form.requestSubmit())
  await l2.page.locator('[data-ludo-room-leave="1"]').waitFor({ state: 'visible', timeout: 10_000 })

  const l1 = await h.openPage(L1, { width: 1280, height: 850 }, '/games/ludo', '[data-ludo-lobby="1"]')
  await l1.page.locator('[data-ludo-room-join]').first().waitFor({ state: 'visible', timeout: 10_000 })
  await l1.page.locator('[data-ludo-room-join]').first().click()
  await l1.page.locator('[data-ludo-cell-pieces]').first().waitFor({ state: 'attached', timeout: 20_000 })
  await l2.page.locator('[data-ludo-cell-pieces]').first().waitFor({ state: 'attached', timeout: 20_000 })

  const ludoRevisions = (opened: OpenedPage, since = 0) => opened.wsReceived
    .filter((f) => f.at >= since && f.type === 'ludo_game_state')
    .map((f) => f.data.snapshot.revision as number)

  await sendGiftViaApi(S, L1)
  await l1.page.locator(LIVE).waitFor({ state: 'visible', timeout: 10_000 })
  await check('[L1] received popup по време на Ludo показва "OK" + "Подари и ти"', async () => {
    const texts = (await l1.page.locator(`${LIVE} [data-gift-item-received-actions="1"] button`).allInnerTexts()).map((t) => t.trim())
    assert(JSON.stringify(texts) === JSON.stringify(['OK', 'Подари и ти']), `buttons=${JSON.stringify(texts)}`)
  })

  let ludoSessionStart = Date.now()
  await check('[L2] "Подари и ти" отваря in-game picker-а без напускане на Ludo (recipient = sender profile_id)', async () => {
    ludoSessionStart = Date.now()
    await l1.page.locator(LIVE_BACK).dblclick()
    await l1.page.locator(PICKER_HOST).waitFor({ state: 'visible', timeout: 10_000 })
    await l1.page.locator(LIVE).waitFor({ state: 'detached', timeout: 3_000 })
    assert((await l1.page.locator(PICKER_HOST).count()) === 1, 'expected exactly one picker host')
    assert((await l1.page.locator('[data-lobby-gift-item-modal-root="1"]').count()) === 0, 'lobby picker must not open during Ludo')
    assert((await l1.page.locator('[data-ludo-cell-pieces]').count()) > 0, 'Ludo board disappeared')
    assert(l1.profileLoadUrls.length === 1 && l1.profileLoadUrls[0]!.endsWith(`/api/profiles/${encodeURIComponent(S.profileId)}`), `profile loads=${JSON.stringify(l1.profileLoadUrls)}`)
    const header = await l1.page.locator(PICKER_HOST).innerText()
    assert(header.includes(`Подарък за ${S.displayName}`), `header: ${header.slice(0, 80)}`)
  })
  await check('[L3] Ludo: picker-ът е над масата, под Ludo modal layer-а', async () => {
    const z = await pickerZIndex(l1.page)
    assert(z === PICKER_Z, `picker z=${z}`)
    const modalLayerZ = await l1.page.evaluate(`Number(getComputedStyle(document.querySelector('[data-ludo-modal-layer="1"]')).zIndex)`) as number
    assert(z < modalLayerZ, `picker z ${z} must be below Ludo modal layer ${modalLayerZ}`)
    assert(await topmostAtPickerCenterIsPicker(l1.page), 'picker is not topmost over the board')
  })
  await check('[L4] Ludo таймерите не са паузирани: докато picker-ът е отворен сървърът движи играта, клиентът не праща игрови действия', async () => {
    const revBefore = Math.max(...ludoRevisions(l1))
    await sleep(7_000) // roll timeout = 5s → сървърът трябва да е действал сам
    const revAfter = Math.max(...ludoRevisions(l1))
    assert(revAfter > revBefore, `revision did not advance while picker open (${revBefore} → ${revAfter})`)
    const sent = gameActionsSentSince(l1, ludoSessionStart)
    assert(sent.length === 0, `client sent game actions while picker open: ${JSON.stringify(sent)}`)
    assert(await l1.page.locator(PICKER_HOST).isVisible(), 'picker should still be open')
  })
  await check('[L5] cancel (×) не праща нищо и играчът остава в Ludo', async () => {
    await l1.page.locator(PICKER_CLOSE).click()
    await l1.page.locator(PICKER_HOST).waitFor({ state: 'detached', timeout: 3_000 })
    await sleep(300)
    assert(l1.giftSendUrls.length === 0, `unexpected send: ${l1.giftSendUrls.join(', ')}`)
    assert(txCount(L1.profileId, S.profileId) === 0, 'transaction created on cancel')
    assert((await l1.page.locator('[data-ludo-cell-pieces]').count()) > 0, 'left Ludo')
  })

  await sendGiftViaApi(S, L1)
  await l1.page.locator(LIVE).waitFor({ state: 'visible', timeout: 10_000 })
  await check('[L5b] недостатъчен баланс по време на Ludo → съществуващото "Нямаш достатъчно жълтици.", без transaction и без debit', async () => {
    const realBalance = getBalance(L1.profileId)
    setBalance(L1.profileId, CHEAP_PRICE - 1) // клиентът още показва стария баланс
    await l1.page.locator(LIVE_BACK).click()
    const pick = l1.page.locator(`${PICKER_HOST} [data-gift-picker-pick="${CHEAP_ID}"]`)
    await pick.waitFor({ state: 'visible', timeout: 10_000 })
    await pick.click()
    await l1.page.locator(PICKER_HOST).getByText('Нямаш достатъчно жълтици.').waitFor({ state: 'visible', timeout: 10_000 })
    assert(txCount(L1.profileId, S.profileId) === 0, 'transaction created with insufficient balance')
    assert(getBalance(L1.profileId) === CHEAP_PRICE - 1, 'balance changed on rejected send')
    assert((await l1.page.locator('[data-ludo-cell-pieces]').count()) > 0, 'left Ludo')
    setBalance(L1.profileId, realBalance)
    await l1.page.locator(PICKER_CLOSE).click()
    await l1.page.locator(PICKER_HOST).waitFor({ state: 'detached', timeout: 3_000 })
    l1.giftSendUrls.length = 0
  })

  await sendGiftViaApi(S, L1)
  await l1.page.locator(LIVE).waitFor({ state: 'visible', timeout: 10_000 })
  await check('[L6] платено изпращане към sender-а (троен клик → 1 request; balance_before - gift_price = balance_after) без прекъсване на Ludo', async () => {
    const balanceBefore = getBalance(L1.profileId)
    const sBalanceBefore = getBalance(S.profileId)
    const receivedBefore = txRows(S.profileId, L1.profileId).map((r) => r.transaction_id)
    const sendSession = Date.now()
    await l1.page.locator(LIVE_BACK).click()
    const pick = l1.page.locator(`${PICKER_HOST} [data-gift-picker-pick="${CHEAP_ID}"]`)
    await pick.waitFor({ state: 'visible', timeout: 10_000 })
    await pick.evaluate((el) => { (el as HTMLElement).click(); (el as HTMLElement).click(); (el as HTMLElement).click() })
    await l1.page.locator(PICKER_TOAST).waitFor({ state: 'visible', timeout: 10_000 })
    await l1.page.locator(PICKER_HOST).waitFor({ state: 'detached', timeout: 3_000 })
    await sleep(400)
    assert(l1.giftSendUrls.length === 1, `expected 1 send, got ${l1.giftSendUrls.length}`)
    assert(l1.giftSendUrls[0]!.includes(`/api/profile/${encodeURIComponent(S.profileId)}/send-gift-item`), `url=${l1.giftSendUrls[0]}`)
    assertPaidGiftBack({ giver: L1, originalSender: S, giverBalanceBefore: balanceBefore, originalSenderBalanceBefore: sBalanceBefore, receivedTxIdsBefore: receivedBefore })
    assert((await l1.page.locator('[data-ludo-cell-pieces]').count()) > 0, 'left Ludo after send')
    assert(gameActionsSentSince(l1, sendSession).length === 0, 'game actions sent during gift send')
    const toast = await l1.page.locator(PICKER_TOAST).innerText()
    assert(toast.includes('Подаръкът е изпратен'), `toast=${toast}`)
  })
  await check('[L7] след изпращането Ludo продължава (нови snapshot-и пристигат)', async () => {
    const since = Date.now()
    while (ludoRevisions(l1, since).length === 0 && Date.now() - since < 20_000) await sleep(500)
    const last = l1.wsReceived.filter((f) => f.type === 'ludo_game_state').at(-1)?.data.snapshot
    assert((await l1.page.locator('[data-ludo-cell-pieces]').count()) > 0, 'left Ludo after gift send')
    assert(ludoRevisions(l1, since).length > 0, `no Ludo snapshots within 20s after gift send (last status=${last?.state?.status}, phase=${last?.state?.turnPhase}, deadlineAt=${last?.deadlineAt}, serverNow=${last?.serverNow})`)
  })
  await l1.context.close()
  await l2.context.close()

  // ── Белот ────────────────────────────────────────────────────────────────
  console.log('\n=== Белот (1 човек + 3 бота) ===')
  const P = await h.register('p')
  setBalance(P.profileId, 50_000)
  const p = await h.openPage(P, { width: 1280, height: 850 }, '/lobby', '[data-lobby-nav-bell="1"]')
  await p.page.locator('[data-lobby-stake-card]:not([data-lobby-stake-card-guest-locked]):not([data-lobby-stake-card-level-locked]):not([disabled])').first().click()
  await p.page.locator('[data-active-room-leave-button="1"]').waitFor({ state: 'attached', timeout: 60_000 })
  await sleep(1_500)
  const belotSnapshots = (since = 0) => p.wsReceived.filter((f) => f.at >= since && f.type === 'room_snapshot')

  await sendGiftViaApi(S, P)
  await p.page.locator(LIVE).waitFor({ state: 'visible', timeout: 10_000 })
  await check('[B1] received popup по време на Белот показва "OK" + "Подари и ти"', async () => {
    const texts = (await p.page.locator(`${LIVE} [data-gift-item-received-actions="1"] button`).allInnerTexts()).map((t) => t.trim())
    assert(JSON.stringify(texts) === JSON.stringify(['OK', 'Подари и ти']), `buttons=${JSON.stringify(texts)}`)
  })
  let belotSessionStart = Date.now()
  await check('[B2] "Подари и ти" отваря in-game picker-а без напускане на Белот (recipient = sender profile_id)', async () => {
    belotSessionStart = Date.now()
    await p.page.locator(LIVE_BACK).click()
    await p.page.locator(PICKER_HOST).waitFor({ state: 'visible', timeout: 10_000 })
    await p.page.locator(LIVE).waitFor({ state: 'detached', timeout: 3_000 })
    assert((await p.page.locator('[data-active-room-leave-button="1"]').count()) === 1, 'left the Belot room')
    assert((await p.page.locator('[data-lobby-gift-item-modal-root="1"]').count()) === 0, 'lobby picker must not open during Belot')
    assert(p.profileLoadUrls.at(-1)!.endsWith(`/api/profiles/${encodeURIComponent(S.profileId)}`), `profile load=${p.profileLoadUrls.at(-1)}`)
    const header = await p.page.locator(PICKER_HOST).innerText()
    assert(header.includes(`Подарък за ${S.displayName}`), `header: ${header.slice(0, 80)}`)
  })
  await check('[B3] Белот: picker-ът е над масата/HUD-а и под игровите модали', async () => {
    const z = await pickerZIndex(p.page)
    assert(z === PICKER_Z, `picker z=${z}`)
    assert(z < 9_999 && z < 10_000 && z < 11_000, 'picker must stay below declaration prompt / bot takeover / leave warning')
    assert(await topmostAtPickerCenterIsPicker(p.page), 'picker is not topmost over the table')
  })
  await check('[B4] Белот таймерите не са паузирани: сървърът движи играта, клиентът не праща игрови действия', async () => {
    // Чака до 35s нов room_snapshot (човешкият таймер е 15s; ботовете
    // играят за ~1s) — фазите в Белот са с различна дължина.
    const waitFrom = Date.now()
    while (belotSnapshots(waitFrom).length === 0 && Date.now() - waitFrom < 35_000) await sleep(500)
    assert(belotSnapshots(waitFrom).length > 0, 'no Belot snapshots while picker open (35s)')
    assert(await p.page.locator(PICKER_HOST).isVisible(), 'picker should still be open')
    const sent = gameActionsSentSince(p, belotSessionStart)
    assert(sent.length === 0, `client sent game actions while picker open: ${JSON.stringify(sent)}`)
    // Ако ходът е изтекъл и е излязъл bot takeover overlay, той трябва да е НАД picker-а.
    if (await p.page.locator('[data-bot-takeover-overlay="1"]').count()) {
      const takeoverOnTop = await p.page.evaluate(`(() => {
        const o = document.querySelector('[data-bot-takeover-overlay="1"]')
        const r = o.getBoundingClientRect()
        const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        return !!el && o.contains(el)
      })()`) as boolean
      assert(takeoverOnTop, 'bot takeover overlay is hidden under the picker')
    }
  })
  await check('[B5] cancel (×) не праща нищо и играчът остава в Белот', async () => {
    await p.page.locator('[data-bot-takeover-dismiss="1"]').click({ timeout: 1_000 }).catch(() => undefined)
    await p.page.locator(PICKER_CLOSE).click()
    await p.page.locator(PICKER_HOST).waitFor({ state: 'detached', timeout: 3_000 })
    await sleep(300)
    assert(p.giftSendUrls.length === 0, `unexpected send: ${p.giftSendUrls.join(', ')}`)
    assert(txCount(P.profileId, S.profileId) === 0, 'transaction created on cancel')
    assert((await p.page.locator('[data-active-room-leave-button="1"]').count()) === 1, 'left the Belot room')
  })

  await sendGiftViaApi(S, P)
  await p.page.locator(LIVE).waitFor({ state: 'visible', timeout: 10_000 })
  await check('[B5b] недостатъчен баланс по време на Белот → съществуващото "Нямаш достатъчно жълтици.", без transaction и без debit', async () => {
    const realBalance = getBalance(P.profileId)
    setBalance(P.profileId, CHEAP_PRICE - 1) // клиентът още показва стария баланс
    await p.page.locator(LIVE_BACK).click()
    const pick = p.page.locator(`${PICKER_HOST} [data-gift-picker-pick="${CHEAP_ID}"]`)
    await pick.waitFor({ state: 'visible', timeout: 10_000 })
    await pick.click()
    await p.page.locator(PICKER_HOST).getByText('Нямаш достатъчно жълтици.').waitFor({ state: 'visible', timeout: 10_000 })
    assert(txCount(P.profileId, S.profileId) === 0, 'transaction created with insufficient balance')
    assert(getBalance(P.profileId) === CHEAP_PRICE - 1, 'balance changed on rejected send')
    assert((await p.page.locator('[data-active-room-leave-button="1"]').count()) === 1, 'left Belot')
    setBalance(P.profileId, realBalance)
    await p.page.locator(PICKER_CLOSE).click()
    await p.page.locator(PICKER_HOST).waitFor({ state: 'detached', timeout: 3_000 })
    p.giftSendUrls.length = 0
  })

  await sendGiftViaApi(S, P)
  await p.page.locator(LIVE).waitFor({ state: 'visible', timeout: 10_000 })
  await check('[B6] платено изпращане към sender-а (троен клик → 1 request; balance_before - gift_price = balance_after) без прекъсване на Белот', async () => {
    const balanceBefore = getBalance(P.profileId)
    const sBalanceBefore = getBalance(S.profileId)
    const receivedBefore = txRows(S.profileId, P.profileId).map((r) => r.transaction_id)
    const sendSession = Date.now()
    await p.page.locator(LIVE_BACK).click()
    const pick = p.page.locator(`${PICKER_HOST} [data-gift-picker-pick="${CHEAP_ID}"]`)
    await pick.waitFor({ state: 'visible', timeout: 10_000 })
    await pick.evaluate((el) => { (el as HTMLElement).click(); (el as HTMLElement).click(); (el as HTMLElement).click() })
    await p.page.locator(PICKER_TOAST).waitFor({ state: 'visible', timeout: 10_000 })
    await p.page.locator(PICKER_HOST).waitFor({ state: 'detached', timeout: 3_000 })
    await sleep(400)
    assert(p.giftSendUrls.length === 1, `expected 1 send, got ${p.giftSendUrls.length}`)
    assert(p.giftSendUrls[0]!.includes(`/api/profile/${encodeURIComponent(S.profileId)}/send-gift-item`), `url=${p.giftSendUrls[0]}`)
    assertPaidGiftBack({ giver: P, originalSender: S, giverBalanceBefore: balanceBefore, originalSenderBalanceBefore: sBalanceBefore, receivedTxIdsBefore: receivedBefore })
    assert((await p.page.locator('[data-active-room-leave-button="1"]').count()) === 1, 'left Belot after send')
    assert(gameActionsSentSince(p, sendSession).length === 0, 'game actions sent during gift send')
  })

  await check('[B7] "OK" на live popup-а по време на Белот работи както досега', async () => {
    await sendGiftViaApi(S, P)
    await p.page.locator(LIVE).waitFor({ state: 'visible', timeout: 10_000 })
    await p.page.locator(LIVE_OK).click()
    await p.page.locator(LIVE).waitFor({ state: 'detached', timeout: 3_000 })
    assert((await p.page.locator(PICKER_HOST).count()) === 0, 'picker opened after OK')
  })
  await p.context.close()
} catch (error) {
  console.error(error)
  console.error(h.serverOutput().slice(-3000))
  await check('[setup] harness completed', () => { throw error })
} finally {
  await h.close()
}

finishAndExit()
