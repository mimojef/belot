/**
 * checkVoiceVipWiringE2E.ts — Гласов чат: реалното свързване на VIP статуса
 * в main.ts (не mock стойност към UI-а).
 *
 * Реален сървър (изолирано копие + празна SQLite база, никога реалната), реален
 * Vite dev server с ИСТИНСКИЯ src/main.ts, реален Chromium, реални кликове
 * (scripts/giftBackTestHarness.ts). Режим „Само админ“ — както в production
 * бъга: VIP създател и VIP поканени виждаха „Само слушай / Вземи VIP / Не сега“,
 * защото гласовият UI четеше profile.isVip от сесията (сървърът там праща null).
 *
 *   [W0] сесията (/api/auth/me) наистина има profile.isVip === null — без
 *        новото свързване тестовете долу биха паднали;
 *   [W1] създател (пълен admin + VIP, desktop) -> вариант 'speak'; без нито
 *        един кадър с „Вземи VIP“; прозорецът идва от /api/vip/status;
 *   [W2] поканен VIP (mobile) с бавен /api/vip/status -> прозорецът изчаква
 *        (няма грешен първи кадър), после 'speak';
 *   [W3] поканен без VIP (desktop) -> 'listen_vip' с „Вземи VIP“;
 *   [W4] поканен VIP (mobile) с неуспешен /api/vip/status -> 'neutral', без
 *        „Вземи VIP“;
 *   [W5] без периодични заявки: 6 s в чакалнята (рендерирания всяка секунда) —
 *        нито една нова заявка към /api/vip/status.
 *
 *   node server/node_modules/tsx/dist/cli.mjs scripts/checkVoiceVipWiringE2E.ts
 */

import { randomUUID } from 'node:crypto'
import type { Page } from 'playwright'
import { assert, check, finishAndExit, sleep, startGiftBackHarness, type OpenedPage, type TestProfile } from './giftBackTestHarness'

console.log('\ncheckVoiceVipWiringE2E\n')

// Резервацията на гласова маса изисква подадена LiveKit конфигурация (самият
// LiveKit не участва в нея). Само за изолирания сървърен процес на теста:
// недостижим loopback адрес и изхвърляеми фиктивни стойности — не истински ключове.
process.env.LIVEKIT_API_URL = 'http://127.0.0.1:9'
process.env.LIVEKIT_WS_URL = 'ws://127.0.0.1:9'
process.env.LIVEKIT_API_KEY = 'e2e-test-only'
process.env.LIVEKIT_API_SECRET = 'e2e-test-only-not-a-real-secret-0000000000'
process.env.VOICE_ROOM_NAMESPACE = 'e2etest'
delete process.env.VOICE_CHAT_ENABLED

const h = await startGiftBackHarness()

const DESKTOP = { width: 1280, height: 850 }
const MOBILE = { width: 390, height: 844 }
const PROMPT = '[data-voice-prompt-layer="1"] [data-voice-prompt-offer]'
const LOBBY_READY = '[data-lobby-private-rooms-card="1"]'

function grantVip(profileId: string): void {
  const until = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ')
  h.db.prepare(`
    INSERT INTO vip_status (profile_id, active_until, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(profile_id) DO UPDATE SET active_until = excluded.active_until, updated_at = CURRENT_TIMESTAMP
  `).run(profileId, until)
}
function makeFullAdmin(profileId: string): void {
  h.db.prepare(`UPDATE accounts SET role = 'admin' WHERE account_id = (SELECT account_id FROM profiles WHERE profile_id = ?)`).run(profileId)
}
function setVoiceModeAdminOnly(actorProfileId: string): void {
  h.db.prepare(`INSERT INTO voice_chat_admin_changes (change_id, setting, new_value, previous_value, changed_by_profile_id, changed_at) VALUES (?, 'mode', 'admin_only', 'off', ?, ?)`)
    .run(randomUUID(), actorProfileId, new Date().toISOString())
}

/** Всички варианти на прозореца, които някога са се появили в DOM-а (и дали е имало „Вземи VIP“). */
// Скриптовете в браузъра са низове: tsx/esbuild добавя __name(...) към
// именуваните функции, а такъв helper в страницата няма.
async function recordPromptOffers(page: Page): Promise<void> {
  await page.evaluate(`(() => {
    window.__voiceOffers = []
    window.__voiceGetVipSeen = false
    new MutationObserver(() => {
      const el = document.querySelector('[data-voice-prompt-layer="1"] [data-voice-prompt-offer]')
      const offer = el ? el.getAttribute('data-voice-prompt-offer') : null
      if (offer !== null && window.__voiceOffers[window.__voiceOffers.length - 1] !== offer) window.__voiceOffers.push(offer)
      if (el && el.querySelector('[data-voice-action="get-vip"]')) window.__voiceGetVipSeen = true
    }).observe(document.body, { childList: true, subtree: true, attributes: true })
  })()`)
}
const offersOf = (page: Page) => page.evaluate('window.__voiceOffers') as Promise<string[]>
const getVipSeen = (page: Page) => page.evaluate('window.__voiceGetVipSeen') as Promise<boolean>

function trackVipStatusRequests(opened: OpenedPage): () => number[] {
  const at: number[] = []
  opened.page.on('request', (req) => { if (req.url().split('?')[0]!.endsWith('/api/vip/status')) at.push(Date.now()) })
  return () => at
}

async function promptButtons(page: Page): Promise<{ offer: string | null; mic: boolean; listen: boolean; vip: boolean; notNow: boolean }> {
  return page.evaluate(`(() => {
    const el = document.querySelector('[data-voice-prompt-layer="1"] [data-voice-prompt-offer]')
    const q = (a) => !!(el && el.querySelector('[data-voice-action="' + a + '"]'))
    return { offer: el ? el.getAttribute('data-voice-prompt-offer') : null, mic: q('join-mic'), listen: q('join-listen'), vip: q('get-vip'), notNow: q('not-now') }
  })()`) as Promise<{ offer: string | null; mic: boolean; listen: boolean; vip: boolean; notNow: boolean }>
}

async function joinRoom(opened: OpenedPage, roomId: string): Promise<void> {
  const { page } = opened
  await page.locator(LOBBY_READY).first().click()
  const plus = page.locator(`[data-private-room-list-slot-join^="${roomId}:"]`).first()
  await plus.waitFor({ state: 'visible', timeout: 15_000 })
  await recordPromptOffers(page)
  await plus.click()
  await page.locator('[data-private-room-join-popup-confirm="1"]').waitFor({ state: 'visible', timeout: 5_000 })
  await page.locator('[data-private-room-join-popup-confirm="1"]').click()
}

let exitCode = 0
const diagPages: OpenedPage[] = []
const pageErrors: string[] = []
try {
  const creator = await h.register('vca')
  const vipInvitee = await h.register('vcb')
  const plainInvitee = await h.register('vcc')
  const vipInviteeError = await h.register('vcd')
  for (const p of [creator, vipInvitee, plainInvitee, vipInviteeError]) h.setBalance(p.profileId, 50_000_000)
  makeFullAdmin(creator.profileId)
  grantVip(creator.profileId)
  grantVip(vipInvitee.profileId)
  grantVip(vipInviteeError.profileId)
  setVoiceModeAdminOnly(creator.profileId)

  const sessionIsVip = async (p: TestProfile) => {
    const res = await fetch(`${h.backendOrigin}/api/auth/me`, { headers: { Cookie: `belot_session=${p.cookie}` } })
    const body: any = await res.json()
    return body?.session?.profile?.isVip
  }

  await check('[W0] Сесията (/api/auth/me) праща profile.isVip === null дори за VIP — старото свързване е невалиден източник', async () => {
    assert(await sessionIsVip(creator) === null, `creator isVip: ${await sessionIsVip(creator)}`)
    assert(await sessionIsVip(vipInvitee) === null, 'vipInvitee isVip')
  })

  // ─── [W1] Създател: пълен admin + VIP, desktop ─────────────────────────
  const a = await h.openPage(creator, DESKTOP, '/lobby', LOBBY_READY)
  diagPages.push(a)
  a.page.on('pageerror', (e) => pageErrors.push(String(e)))
  const aVipRequests = trackVipStatusRequests(a)
  await a.page.locator(LOBBY_READY).first().click()
  await a.page.locator('[data-private-rooms-create-open="1"]').first().click()
  const voiceCheckbox = a.page.locator('[data-private-room-create-form="1"] [data-private-room-voice-checkbox="1"]')
  await voiceCheckbox.waitFor({ state: 'visible', timeout: 15_000 })
  await voiceCheckbox.check()
  // Ръчен старт: при 4/4 масата остава в чакалнята (иначе играта тръгва сама).
  await a.page.locator('[data-private-room-create-form="1"] input[name="manualStart"]').check()
  const stake = a.page.locator('[data-private-room-create-form="1"] select[name="stake"]')
  if (await stake.count() > 0) await stake.selectOption((await stake.locator('option:not([disabled])').first().getAttribute('value'))!)
  await recordPromptOffers(a.page)
  const beforeCreate = Date.now()
  await a.page.locator('[data-private-room-create-form="1"] button[type="submit"]').click()
  await a.page.locator(PROMPT).waitFor({ state: 'visible', timeout: 25_000 })
  const created = a.wsReceived.find((f) => f.type === 'private_room_updated' && f.data?.room?.voiceTableId)
  const roomId = created?.data?.room?.id as string | undefined

  await check('[W1] Създател (admin + VIP, desktop): „Включи микрофона“ + „Само слушай“ + „Не сега“, без „Вземи VIP“ — нито в един кадър', async () => {
    assert(roomId, 'гласова маса създадена')
    const buttons = await promptButtons(a.page)
    assert(buttons.offer === 'speak', `offer: ${buttons.offer}`)
    assert(buttons.mic && buttons.listen && buttons.notNow && !buttons.vip, JSON.stringify(buttons))
    assert(!(await getVipSeen(a.page)), 'кадър с „Вземи VIP“')
    assert(JSON.stringify(await offersOf(a.page)) === '["speak"]', `варианти: ${JSON.stringify(await offersOf(a.page))}`)
    assert(aVipRequests().some((t) => t >= beforeCreate), 'заявка към /api/vip/status при влизане в гласовата чакалня')
  })

  // ─── [W2] Поканен VIP, mobile, бавен /api/vip/status ───────────────────
  const b = await h.openPage(vipInvitee, MOBILE, '/lobby', LOBBY_READY)
  const VIP_DELAY_MS = 2_500
  let bReleasedAt = 0
  await b.context.route('**/api/vip/status', async (route) => {
    await sleep(VIP_DELAY_MS)
    bReleasedAt = Date.now()
    await route.continue()
  })
  await joinRoom(b, roomId!)
  await b.page.locator('[data-voice-waiting-strip="1"]').waitFor({ state: 'attached', timeout: 15_000 })
  const bInWaitingAt = Date.now()
  await sleep(800)
  const bEarly = await promptButtons(b.page)
  await b.page.locator(PROMPT).waitFor({ state: 'visible', timeout: 15_000 })
  const bShownAt = Date.now()

  await check('[W2] Поканен VIP (mobile, бавен статус): прозорецът изчаква статуса (без грешен първи кадър), после „Включи микрофона“', async () => {
    assert(bEarly.offer === null, `преди отговора има прозорец: ${JSON.stringify(bEarly)}`)
    assert(bReleasedAt > 0 && bShownAt >= bReleasedAt && bShownAt > bInWaitingAt, 'показан след отговора')
    const buttons = await promptButtons(b.page)
    assert(buttons.offer === 'speak' && buttons.mic && buttons.listen && !buttons.vip, JSON.stringify(buttons))
    assert(!(await getVipSeen(b.page)) && JSON.stringify(await offersOf(b.page)) === '["speak"]', `варианти: ${JSON.stringify(await offersOf(b.page))}`)
  })

  // ─── [W3] Поканен без VIP, desktop ─────────────────────────────────────
  const c = await h.openPage(plainInvitee, DESKTOP, '/lobby', LOBBY_READY)
  await joinRoom(c, roomId!)
  await c.page.locator(PROMPT).waitFor({ state: 'visible', timeout: 25_000 })

  await check('[W3] Поканен без VIP (desktop): „Само слушай“ + „Вземи VIP“, без „Включи микрофона“', async () => {
    const buttons = await promptButtons(c.page)
    assert(buttons.offer === 'listen_vip' && buttons.listen && buttons.vip && !buttons.mic, JSON.stringify(buttons))
  })

  // ─── [W4] Поканен VIP, mobile, неуспешен /api/vip/status ────────────────
  const d = await h.openPage(vipInviteeError, MOBILE, '/lobby', LOBBY_READY)
  await d.context.route('**/api/vip/status', (route) => route.abort())
  await joinRoom(d, roomId!)
  await d.page.locator(PROMPT).waitFor({ state: 'visible', timeout: 25_000 })

  await check('[W4] Неуспешно зареждане на статуса (mobile): неутрален прозорец — „Само слушай“ + „Включи микрофона“, без „Вземи VIP“', async () => {
    const buttons = await promptButtons(d.page)
    assert(buttons.offer === 'neutral' && buttons.listen && buttons.mic && !buttons.vip, JSON.stringify(buttons))
    assert(!(await getVipSeen(d.page)), 'кадър с „Вземи VIP“')
  })

  // ─── [W5] Без периодични заявки ─────────────────────────────────────────
  const aCountBefore = aVipRequests().length
  await sleep(6_000)
  await check('[W5] Без периодични заявки: 6 s в чакалнята (с рендериране) -> 0 нови заявки към /api/vip/status', async () => {
    assert(aVipRequests().length === aCountBefore, `нови заявки: ${aVipRequests().length - aCountBefore}`)
    assert(await a.page.locator(PROMPT).isVisible(), 'прозорецът остава')
  })

  await a.page.screenshot({ path: `${process.env.TEMP ?? '/tmp'}/voice-vip-wiring-creator-desktop.png` }).catch(() => undefined)
  await b.page.screenshot({ path: `${process.env.TEMP ?? '/tmp'}/voice-vip-wiring-vip-mobile.png` }).catch(() => undefined)
  await c.page.screenshot({ path: `${process.env.TEMP ?? '/tmp'}/voice-vip-wiring-plain-desktop.png` }).catch(() => undefined)
  await d.page.screenshot({ path: `${process.env.TEMP ?? '/tmp'}/voice-vip-wiring-error-mobile.png` }).catch(() => undefined)
} catch (error) {
  console.error('  FAIL  setup:', error instanceof Error ? error.message : String(error))
  console.error(h.serverOutput().slice(-1500))
  console.error('pageErrors:', pageErrors.slice(0, 5))
  for (const o of diagPages) {
    console.error('ws received:', o.wsReceived.map((f) => f.type).filter((t) => t !== 'pong').slice(-25).join(','))
    console.error('ws sent:', o.wsSent.map((f) => f.type).slice(-15).join(','))
    console.error('voice frames:', JSON.stringify(o.wsReceived.filter((f) => f.type === 'private_room_updated' || f.type === 'error').map((f) => f.data).slice(-3)).slice(0, 1500))
    await o.page.screenshot({ path: (process.env.TEMP ?? '/tmp') + '/voice-vip-wiring-fail.png' }).catch(() => undefined)
  }
  exitCode = 1
} finally {
  await h.close()
}
if (exitCode !== 0) process.exit(exitCode)
finishAndExit()
