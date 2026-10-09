// checkGiftBlockPrecheckE2E.ts
//
// Real spawned-server + real browser e2e за проверката за блокиране преди
// отваряне на gift picker-ите и за сървърните откази (block в която и да е
// посока). Блоковете се записват в ИЗОЛИРАНАТА тестова SQLite база (никога
// реалната) — сървърът ги чете live (getProfileAccessDenial/sendGiftItem).
//
//   Ludo (A ↔ B, двама души):
//   [LD1] без блокиране → picker-ът се отваря
//   [LD2] B блокира A → "Този потребител ви е блокирал.", без picker
//   [LD3] A блокира B → "Този потребител е блокиран от Вас.", без picker
//   [LD4] мрежова грешка → toast, без picker и без block popup
//   [LD5] loading индикатор, многократни кликове → 1 проверка
//   [LD6] block след отваряне на picker-а → сървърен отказ, picker затворен, popup, без debit/transaction/събитие
//   Профилен popup (отворен от аватар в Ludo):
//   [PP1] block след отваряне на профила → "Подари" показва popup-а, без lobby модал
//   [PP2] без блокиране → lobby модалът се отваря; block → избор на подарък → popup, без debit
//   [PP3] мрежова грешка → съобщение в профилния popup, без модал/block popup
//   "Подари и ти":
//   [GB1] по време на Ludo, подателят е блокирал → received popup се затваря, block popup, без picker
//   Белот (1 човек + 3 бота):
//   [BL1] без блокиране към бот → селекторът се отваря (непроменено)
//   [BL2] играчът блокира бота → "Този потребител е блокиран от Вас."
//   [BL3] ботът "блокира" играча → "Този потребител ви е блокирал."
//   [BL4] block след отваряне на селектора → сървърен отказ, popup, без debit
//   [BL5] мрежова грешка → toast, без селектор
//   [GB2] "Подари и ти" по време на Белот към блокирал подател → standalone popup, без picker
//
// Harness: scripts/giftBackTestHarness.ts.

import type { Page } from 'playwright'
import { assert, check, finishAndExit, sleep, startGiftBackHarness, type OpenedPage } from './giftBackTestHarness'

console.log('\ncheckGiftBlockPrecheckE2E\n')

const h = await startGiftBackHarness()

const BY_VIEWER_TEXT = 'Този потребител е блокиран от Вас.'
const VIEWER_TEXT = 'Този потребител ви е блокирал.'
const BLOCK_POPUP = '[data-profile-access-block-popup-root="1"]'
const BLOCK_POPUP_CLOSE = `${BLOCK_POPUP} [role="dialog"] [data-profile-access-block-close="1"]`
const LUDO_PICKER = '[data-ludo-gift-modal-host="1"]'
const LUDO_TOAST = '[data-ludo-gift-toast="1"]'
const PROFILE_POPUP = '[data-player-profile-popup-root="1"]'
const LOBBY_GIFT_MODAL = '[data-lobby-gift-item-modal-root="1"]'
const TABLE_GIFT_HOST = '[data-table-gift-modal-host="1"]'
const TABLE_GIFT_TOAST = '[data-table-gift-toast="1"]'
const LIVE = '#gift-item-received-popup'
const LIVE_BACK = `${LIVE} [data-gift-item-received-gift-back="1"]`
const GIFT_BACK_PICKER = '[data-gift-back-picker-host="1"]'
const PENDING_STYLE = '#gift-recipient-precheck-pending-style'

function block(blocker: string, blocked: string): void {
  h.db.prepare('INSERT OR IGNORE INTO player_blocks (blocker_profile_id, blocked_profile_id) VALUES (?, ?)').run(blocker, blocked)
}
function unblockAll(a: string, b: string): void {
  h.db.prepare('DELETE FROM player_blocks WHERE (blocker_profile_id = ? AND blocked_profile_id = ?) OR (blocker_profile_id = ? AND blocked_profile_id = ?)').run(a, b, b, a)
}
async function blockPopupText(page: Page): Promise<string> {
  await page.locator(BLOCK_POPUP).waitFor({ state: 'visible', timeout: 10_000 })
  return (await page.locator(BLOCK_POPUP).innerText()).replace(/\s+/g, ' ')
}
async function closeBlockPopup(page: Page): Promise<void> {
  await domClick(page, BLOCK_POPUP_CLOSE)
  await page.locator(BLOCK_POPUP).waitFor({ state: 'detached', timeout: 5_000 })
}
async function isVisible(page: Page, selector: string): Promise<boolean> {
  const loc = page.locator(selector)
  return (await loc.count()) > 0 && (await loc.first().isVisible())
}
// DOM click (el.click()) — Ludo bot takeover backdrop-ът (при изтекъл ход в
// теста) прихваща pointer събитията; тук не тестваме layering-а.
async function domClick(page: Page, selector: string): Promise<void> {
  await page.locator(selector).first().waitFor({ state: "attached", timeout: 10_000 })
  await page.locator(selector).first().evaluate((el) => (el as HTMLElement).click())
}
async function dismissLudoTakeover(page: Page): Promise<void> {
  if ((await page.locator("[data-ludo-bot-takeover-dismiss]").count()) > 0) {
    await page.locator("[data-ludo-bot-takeover-dismiss]").first().evaluate((el) => (el as HTMLElement).click()).catch(() => undefined)
    await sleep(200)
  }
}
function profileLoadsFor(opened: OpenedPage, profileId: string): number {
  return opened.profileLoadUrls.filter((u) => u.endsWith(`/api/profiles/${encodeURIComponent(profileId)}`)).length
}

try {
  const { CHEAP_ID, setBalance, getBalance, txCount, sendGiftViaApi } = h
  const S = await h.register('s') // външен подател за "Подари и ти"
  setBalance(S.profileId, 1_000_000)

  // ── Ludo ─────────────────────────────────────────────────────────────────
  console.log('=== Ludo (2 играча) ===')
  const A = await h.register('a')
  const B = await h.register('b')
  setBalance(A.profileId, 50_000)
  setBalance(B.profileId, 50_000)

  const lb = await h.openPage(B, { width: 1280, height: 850 }, '/games/ludo', '[data-ludo-lobby="1"]')
  await lb.page.locator('[data-ludo-create-open="1"]').click()
  await lb.page.locator('[data-ludo-create-form="1"]').waitFor({ state: 'visible' })
  await lb.page.locator('[data-ludo-create-form="1"] select[name="playerCount"]').selectOption('2')
  const stakeSelect = lb.page.locator('[data-ludo-create-form="1"] select[name="stake"]')
  await stakeSelect.selectOption((await stakeSelect.locator('option').first().getAttribute('value'))!)
  await lb.page.locator('[data-ludo-create-form="1"]').evaluate((form: HTMLFormElement) => form.requestSubmit())
  await lb.page.locator('[data-ludo-room-leave="1"]').waitFor({ state: 'visible', timeout: 10_000 })

  const la = await h.openPage(A, { width: 1280, height: 850 }, '/games/ludo', '[data-ludo-lobby="1"]')
  await la.page.locator('[data-ludo-room-join]').first().waitFor({ state: 'visible', timeout: 10_000 })
  await la.page.locator('[data-ludo-room-join]').first().click()
  await la.page.locator('[data-ludo-cell-pieces]').first().waitFor({ state: 'attached', timeout: 20_000 })
  await lb.page.locator('[data-ludo-cell-pieces]').first().waitFor({ state: 'attached', timeout: 20_000 })
  await sleep(800)

  const started = la.wsReceived.find((f) => f.type === 'ludo_game_started')?.data
  const bColor = started?.snapshot?.players?.find((p: any) => p.profileId === B.profileId)?.color as string
  assert(bColor, 'B color resolved')
  const LUDO_ICON = `[data-ludo-gift-icon="${bColor}"]`
  await la.page.locator(LUDO_ICON).waitFor({ state: 'visible', timeout: 10_000 })
  const closeLudoPicker = async () => {
    await domClick(la.page, `${LUDO_PICKER} [data-gift-picker-close="1"]`)
    await la.page.locator(LUDO_PICKER).waitFor({ state: 'detached', timeout: 3_000 })
  }

  await check('[LD1] Ludo без блокиране → picker-ът се отваря (1 проверка за B)', async () => {
    const before = profileLoadsFor(la, B.profileId)
    await dismissLudoTakeover(la.page); await domClick(la.page, LUDO_ICON)
    await la.page.locator(`${LUDO_PICKER} [data-gift-picker-pick="${CHEAP_ID}"]`).waitFor({ state: 'visible', timeout: 10_000 })
    assert(profileLoadsFor(la, B.profileId) === before + 1, 'exactly one precheck')
    assert(!(await isVisible(la.page, BLOCK_POPUP)), 'no block popup')
    await closeLudoPicker()
  })

  await check('[LD2] Ludo: B блокира A → "Този потребител ви е блокирал.", без picker', async () => {
    block(B.profileId, A.profileId)
    await dismissLudoTakeover(la.page); await domClick(la.page, LUDO_ICON)
    const text = await blockPopupText(la.page)
    assert(text.includes(VIEWER_TEXT), `popup=${text}`)
    assert((await la.page.locator(LUDO_PICKER).count()) === 0, 'picker must not open')
    await closeBlockPopup(la.page)
    unblockAll(A.profileId, B.profileId)
  })

  await check('[LD3] Ludo: A блокира B → "Този потребител е блокиран от Вас.", без picker', async () => {
    block(A.profileId, B.profileId)
    await dismissLudoTakeover(la.page); await domClick(la.page, LUDO_ICON)
    const text = await blockPopupText(la.page)
    assert(text.includes(BY_VIEWER_TEXT), `popup=${text}`)
    assert((await la.page.locator(LUDO_PICKER).count()) === 0, 'picker must not open')
    await closeBlockPopup(la.page)
    unblockAll(A.profileId, B.profileId)
  })

  await check('[LD4] Ludo: мрежова грешка → toast, без picker и без block popup', async () => {
    const pattern = `**/api/profiles/${encodeURIComponent(B.profileId)}`
    await la.page.route(pattern, (route) => route.abort())
    await dismissLudoTakeover(la.page); await domClick(la.page, LUDO_ICON)
    await la.page.locator(LUDO_TOAST).waitFor({ state: 'visible', timeout: 10_000 })
    const toast = await la.page.locator(LUDO_TOAST).innerText()
    assert(toast.includes('Няма връзка със сървъра.'), `toast=${toast}`)
    await sleep(300)
    assert((await la.page.locator(LUDO_PICKER).count()) === 0, 'picker must not open')
    assert(!(await isVisible(la.page, BLOCK_POPUP)), 'no block popup without confirmed block')
    await la.page.unroute(pattern)
  })

  await check('[LD5] Ludo: loading индикатор, троен клик → 1 проверка, после picker', async () => {
    const pattern = `**/api/profiles/${encodeURIComponent(B.profileId)}`
    await la.page.route(pattern, async (route) => { await sleep(1_500); await route.continue() })
    const before = profileLoadsFor(la, B.profileId)
    await dismissLudoTakeover(la.page); await domClick(la.page, LUDO_ICON)
    await dismissLudoTakeover(la.page); await domClick(la.page, LUDO_ICON)
    await dismissLudoTakeover(la.page); await domClick(la.page, LUDO_ICON)
    const css = await la.page.locator(PENDING_STYLE).textContent()
    assert(css?.includes(`[data-ludo-gift-icon="${bColor}"]`), `pending css=${css}`)
    await la.page.locator(`${LUDO_PICKER} [data-gift-picker-pick="${CHEAP_ID}"]`).waitFor({ state: 'visible', timeout: 10_000 })
    assert(profileLoadsFor(la, B.profileId) === before + 1, `prechecks=${profileLoadsFor(la, B.profileId) - before}`)
    assert((await la.page.locator(PENDING_STYLE).count()) === 0, 'indicator removed')
    await la.page.unroute(pattern)
    await closeLudoPicker()
  })

  await check('[LD6] Ludo: block след отваряне на picker-а → сървърен отказ, popup за B, без debit/transaction/събитие', async () => {
    await dismissLudoTakeover(la.page); await domClick(la.page, LUDO_ICON)
    const pick = la.page.locator(`${LUDO_PICKER} [data-gift-picker-pick="${CHEAP_ID}"]`)
    await pick.waitFor({ state: 'visible', timeout: 10_000 })
    block(B.profileId, A.profileId)
    const balanceBefore = getBalance(A.profileId)
    const txBefore = txCount(A.profileId, B.profileId)
    const bEventsFrom = Date.now()
    await pick.evaluate((el) => (el as HTMLElement).click())
    const text = await blockPopupText(la.page)
    assert(text.includes(VIEWER_TEXT), `popup=${text}`)
    await la.page.locator(LUDO_PICKER).waitFor({ state: 'detached', timeout: 5_000 })
    await sleep(400)
    assert(getBalance(A.profileId) === balanceBefore, 'balance changed')
    assert(txCount(A.profileId, B.profileId) === txBefore, 'transaction created')
    assert(lb.wsReceived.filter((f) => f.at >= bEventsFrom && f.type === 'ludo_gift_sent').length === 0, 'B received a gift event')
    const blockTarget = await la.page.locator(`${BLOCK_POPUP} [data-profile-access-block-block]`).getAttribute('data-profile-access-block-block')
    assert(blockTarget === B.profileId, `popup recipient=${blockTarget}`)
    await closeBlockPopup(la.page)
    unblockAll(A.profileId, B.profileId)
  })

  // ── Профилен popup (от аватар в Ludo → openProtectedProfileById) ─────────
  const GIFT_BUTTON = `${PROFILE_POPUP} [data-player-profile-gift-item="${B.profileId}"]`
  const openBProfile = async () => {
    await dismissLudoTakeover(la.page)
    await domClick(la.page, `[data-ludo-avatar-clickable="${bColor}"]`)
    await la.page.locator(GIFT_BUTTON).waitFor({ state: 'visible', timeout: 10_000 })
  }

  await check('[PP1] профилен popup: block след отварянето → "Подари" показва popup-а, без lobby модал', async () => {
    await openBProfile()
    block(B.profileId, A.profileId)
    await domClick(la.page, GIFT_BUTTON)
    const text = await blockPopupText(la.page)
    assert(text.includes(VIEWER_TEXT), `popup=${text}`)
    assert((await la.page.locator(LOBBY_GIFT_MODAL).count()) === 0, 'lobby gift modal must not open')
    assert(!(await isVisible(la.page, PROFILE_POPUP)), 'profile popup closed')
    await closeBlockPopup(la.page)
    unblockAll(A.profileId, B.profileId)
  })

  await check('[PP2] профилен popup без блокиране → lobby модал; block → избор → popup, без debit/transaction', async () => {
    await openBProfile()
    await domClick(la.page, GIFT_BUTTON)
    const select = la.page.locator(`${LOBBY_GIFT_MODAL} [data-lobby-gift-item-select="${CHEAP_ID}"]`)
    await select.waitFor({ state: 'visible', timeout: 10_000 })
    block(A.profileId, B.profileId)
    const balanceBefore = getBalance(A.profileId)
    const txBefore = txCount(A.profileId, B.profileId)
    await select.evaluate((el) => (el as HTMLElement).click())
    const text = await blockPopupText(la.page)
    assert(text.includes(BY_VIEWER_TEXT), `popup=${text}`)
    await la.page.locator(LOBBY_GIFT_MODAL).waitFor({ state: 'detached', timeout: 5_000 })
    await sleep(300)
    assert(getBalance(A.profileId) === balanceBefore, 'balance changed')
    assert(txCount(A.profileId, B.profileId) === txBefore, 'transaction created')
    await closeBlockPopup(la.page)
    unblockAll(A.profileId, B.profileId)
  })

  await check('[PP3] профилен popup: мрежова грешка → съобщение в popup-а, без модал и без block popup', async () => {
    await openBProfile()
    const pattern = `**/api/profiles/${encodeURIComponent(B.profileId)}`
    await la.page.route(pattern, (route) => route.abort())
    await domClick(la.page, GIFT_BUTTON)
    await la.page.locator(PROFILE_POPUP).getByText('Няма връзка със сървъра.').waitFor({ state: 'visible', timeout: 10_000 })
    await sleep(300)
    assert((await la.page.locator(LOBBY_GIFT_MODAL).count()) === 0, 'lobby gift modal must not open')
    assert(!(await isVisible(la.page, BLOCK_POPUP)), 'no block popup')
    await la.page.unroute(pattern)
    await la.page.keyboard.press('Escape').catch(() => undefined)
    await la.page.locator('[data-player-profile-popup-close="1"]').first().click({ timeout: 2_000 }).catch(() => undefined)
  })

  await check('[GB1] "Подари и ти" по време на Ludo към блокирал подател → block popup, без picker', async () => {
    la.giftSendUrls.length = 0 // [PP2] вече е пратил (отказан) request
    await sendGiftViaApi(S, A)
    await la.page.locator(LIVE).waitFor({ state: 'visible', timeout: 10_000 })
    block(S.profileId, A.profileId)
    await dismissLudoTakeover(la.page)
    await domClick(la.page, LIVE_BACK)
    const text = await blockPopupText(la.page)
    assert(text.includes(VIEWER_TEXT), `popup=${text}`)
    await la.page.locator(LIVE).waitFor({ state: 'detached', timeout: 5_000 })
    assert((await la.page.locator(GIFT_BACK_PICKER).count()) === 0, 'gift-back picker must not open')
    assert(la.giftSendUrls.length === 0, `unexpected send: ${la.giftSendUrls.join(', ')}`)
    await closeBlockPopup(la.page)
    unblockAll(S.profileId, A.profileId)
  })
  await la.context.close()
  await lb.context.close()

  // ── Белот ────────────────────────────────────────────────────────────────
  console.log('\n=== Белот (1 човек + 3 бота) ===')
  const P = await h.register('p')
  setBalance(P.profileId, 50_000)
  const p = await h.openPage(P, { width: 1280, height: 850 }, '/lobby', '[data-lobby-nav-bell="1"]')
  await p.page.locator('[data-lobby-stake-card]:not([data-lobby-stake-card-guest-locked]):not([data-lobby-stake-card-level-locked]):not([disabled])').first().click()
  await p.page.locator('[data-active-room-leave-button="1"]').waitFor({ state: 'attached', timeout: 60_000 })
  await sleep(1_500)
  const snap = [...p.wsReceived].reverse().find((f) => f.type === 'room_snapshot' && f.data.seats?.some((s: any) => s.isBot && s.profileId))?.data
  const bot = snap?.seats?.find((s: any) => s.isBot && s.profileId && s.seat !== snap.yourSeat)
  assert(bot, 'bot seat with profileId')
  const BOT_ICON = `[data-active-room-gift-icon="${bot.seat}"]`
  await p.page.locator(BOT_ICON).waitFor({ state: 'attached', timeout: 15_000 })
  const clickBotIcon = () => p.page.locator(BOT_ICON).evaluate((el) => (el as HTMLElement).click())
  const closeTableGift = async () => {
    await p.page.locator('[data-table-gift-modal-close="1"]').click()
    await sleep(200)
  }

  await check('[BL1] Белот без блокиране към бот → селекторът се отваря (непроменено поведение)', async () => {
    await clickBotIcon()
    await p.page.locator(`${TABLE_GIFT_HOST} [data-table-gift-pick="${CHEAP_ID}"]`).waitFor({ state: 'visible', timeout: 10_000 })
    assert(!(await isVisible(p.page, BLOCK_POPUP)), 'no block popup')
    await closeTableGift()
  })

  await check('[BL2] Белот: играчът блокира бота → "Този потребител е блокиран от Вас."', async () => {
    block(P.profileId, bot.profileId)
    await clickBotIcon()
    const text = await blockPopupText(p.page)
    assert(text.includes(BY_VIEWER_TEXT), `popup=${text}`)
    assert((await p.page.locator(`${TABLE_GIFT_HOST} [data-table-gift-pick]`).count()) === 0, 'selector must not open')
    await closeBlockPopup(p.page)
    unblockAll(P.profileId, bot.profileId)
  })

  await check('[BL3] Белот: блок от другата страна → "Този потребител ви е блокирал."', async () => {
    block(bot.profileId, P.profileId)
    await clickBotIcon()
    const text = await blockPopupText(p.page)
    assert(text.includes(VIEWER_TEXT), `popup=${text}`)
    assert((await p.page.locator(`${TABLE_GIFT_HOST} [data-table-gift-pick]`).count()) === 0, 'selector must not open')
    await closeBlockPopup(p.page)
    unblockAll(P.profileId, bot.profileId)
  })

  await check('[BL4] Белот: block след отваряне на селектора → сървърен отказ, popup, без debit/transaction', async () => {
    await clickBotIcon()
    const pick = p.page.locator(`${TABLE_GIFT_HOST} [data-table-gift-pick="${CHEAP_ID}"]`)
    await pick.waitFor({ state: 'visible', timeout: 10_000 })
    block(bot.profileId, P.profileId)
    const balanceBefore = getBalance(P.profileId)
    const txBefore = txCount(P.profileId, bot.profileId)
    await pick.evaluate((el) => (el as HTMLElement).click())
    const text = await blockPopupText(p.page)
    assert(text.includes(VIEWER_TEXT), `popup=${text}`)
    await sleep(400)
    assert((await p.page.locator(`${TABLE_GIFT_HOST} [data-table-gift-pick]`).count()) === 0, 'selector closed')
    assert(getBalance(P.profileId) === balanceBefore, 'balance changed')
    assert(txCount(P.profileId, bot.profileId) === txBefore, 'transaction created')
    const result = p.wsReceived.filter((f) => f.type === 'table_gift_send_result').at(-1)?.data
    assert(result?.ok === false && result?.code === 'profile_blocked_viewer', `result=${JSON.stringify(result)}`)
    await closeBlockPopup(p.page)
    unblockAll(P.profileId, bot.profileId)
  })

  await check('[BL5] Белот: мрежова грешка → toast, без селектор и без block popup', async () => {
    const pattern = `**/api/profiles/${encodeURIComponent(bot.profileId)}`
    await p.page.route(pattern, (route) => route.abort())
    await clickBotIcon()
    await p.page.locator(TABLE_GIFT_TOAST).waitFor({ state: 'visible', timeout: 10_000 })
    assert((await p.page.locator(TABLE_GIFT_TOAST).innerText()).includes('Няма връзка със сървъра.'), 'toast text')
    await sleep(300)
    assert((await p.page.locator(`${TABLE_GIFT_HOST} [data-table-gift-pick]`).count()) === 0, 'selector must not open')
    assert(!(await isVisible(p.page, BLOCK_POPUP)), 'no block popup')
    await p.page.unroute(pattern)
  })

  await check('[GB2] "Подари и ти" по време на Белот към блокирал подател → standalone popup, без picker', async () => {
    await sendGiftViaApi(S, P)
    await p.page.locator(LIVE).waitFor({ state: 'visible', timeout: 10_000 })
    block(S.profileId, P.profileId)
    await p.page.locator(LIVE_BACK).click()
    const text = await blockPopupText(p.page)
    assert(text.includes(VIEWER_TEXT), `popup=${text}`)
    await p.page.locator(LIVE).waitFor({ state: 'detached', timeout: 5_000 })
    assert((await p.page.locator(GIFT_BACK_PICKER).count()) === 0, 'gift-back picker must not open')
    assert(p.giftSendUrls.length === 0, `unexpected send: ${p.giftSendUrls.join(', ')}`)
    assert((await p.page.locator('[data-active-room-leave-button="1"]').count()) === 1, 'still in Belot')
    await closeBlockPopup(p.page)
    unblockAll(S.profileId, P.profileId)
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
