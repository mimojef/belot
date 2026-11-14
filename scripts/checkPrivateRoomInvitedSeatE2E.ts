/**
 * checkPrivateRoomInvitedSeatE2E.ts — поканен играч в заключена маса може да
 * седне и след F5 / излизане от прегледа / друго устройство ("Поканен си" +
 * активен "+" в списъка, viewerInvited от сървъра), а бутонът "Изпратена" при
 * поканилия се нулира при приемане, отказ или изтичане.
 *
 * Реален сървър (изолирано копие + празна SQLite база), реален Vite dev server
 * с истинския src/main.ts, реален Chromium, реални кликове
 * (scripts/giftBackTestHarness.ts). Гласовият чат е в режим „Само админ“;
 * никой не се включва в гласа — проверява се само прозорецът преди включване.
 *
 *   Маса A (заключена, с глас, "Покани партньор", ръчен старт), домакин desktop:
 *   [A1] "Изпратена" -> след приемане отново "Покани" без презареждане;
 *   [A2] non-VIP (mobile): приемане -> F5 -> "Поканен си" + "+" -> сяда; „само слушай“;
 *   [A3] VIP (desktop): приемане -> излиза от прегледа -> "+"; второ
 *        устройство (mobile) вижда "Поканен си" и сяда оттам; „Включи микрофона“;
 *   [A4] непоканен: "Заключена", без "+", viewerInvited=false; подправен
 *        join_private_room -> отказ; не вижда кой е поканен;
 *   [A5] партньорска покана (mobile) -> сяда директно в резервираното място;
 *   [A6] приел, но масата е пълна -> "Поканен си" без "+"; подправен join -> отказ.
 *   Маса B (заключена, без глас), домакин desktop:
 *   [B1] отказ -> "Покани" без презареждане; повторна покана стига; приемане -> сяда;
 *   [B2] изтекла покана -> "Покани"; без право; повторна покана -> приемане ->
 *        F5 -> сяда (mobile);
 *   Маса C (заключена, без глас):
 *   [C1] затворена маса (последният седнал излиза) -> изчезва от списъка на
 *        приелия; подправен join -> отказ.
 *   [Z]  viewerInvited/ownPendingInviteProfileIds никога не стигат до чужд получател.
 *
 *   node server/node_modules/tsx/dist/cli.mjs scripts/checkPrivateRoomInvitedSeatE2E.ts
 */

import { randomUUID } from 'node:crypto'
import type { BrowserContext, Page, WebSocketRoute } from 'playwright'
import { assert, check, finishAndExit, sleep, startGiftBackHarness, type TestProfile } from './giftBackTestHarness'

console.log('\ncheckPrivateRoomInvitedSeatE2E\n')

// Резервацията на гласова маса изисква подадена LiveKit конфигурация (самият
// LiveKit не участва). Само за изолирания сървърен процес на теста: недостижим
// loopback адрес и изхвърляеми фиктивни стойности — не истински ключове.
process.env.LIVEKIT_API_URL = 'http://127.0.0.1:9'
process.env.LIVEKIT_WS_URL = 'ws://127.0.0.1:9'
process.env.LIVEKIT_API_KEY = 'e2e-test-only'
process.env.LIVEKIT_API_SECRET = 'e2e-test-only-not-a-real-secret-0000000000'
process.env.VOICE_ROOM_NAMESPACE = 'e2etest'
delete process.env.VOICE_CHAT_ENABLED

const h = await startGiftBackHarness()

const DESKTOP = { width: 1280, height: 850 }
const MOBILE = { width: 390, height: 844 }
const LOBBY_READY = '[data-lobby-private-rooms-card="1"]'
const CREATE_OPEN = '[data-private-rooms-create-open="1"]'
const WAITING = '[data-private-room-waiting-screen="1"]'
const LOCKED_TEXT = 'Масата е заключена — нужна е покана.'

const vipUntil = (days: number) => new Date(Date.now() + days * 24 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ')
function setVip(profileId: string, days: number): void {
  h.db.prepare(`
    INSERT INTO vip_status (profile_id, active_until, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(profile_id) DO UPDATE SET active_until = excluded.active_until, updated_at = CURRENT_TIMESTAMP
  `).run(profileId, vipUntil(days))
}
function makeFullAdmin(profileId: string): void {
  h.db.prepare(`UPDATE accounts SET role = 'admin' WHERE account_id = (SELECT account_id FROM profiles WHERE profile_id = ?)`).run(profileId)
}
function setVoiceModeAdminOnly(actorProfileId: string): void {
  h.db.prepare(`INSERT INTO voice_chat_admin_changes (change_id, setting, new_value, previous_value, changed_by_profile_id, changed_at) VALUES (?, 'mode', 'admin_only', 'off', ?, ?)`)
    .run(randomUUID(), actorProfileId, new Date().toISOString())
}
function befriend(a: TestProfile, b: TestProfile): void {
  const [lower, higher] = a.profileId < b.profileId ? [a.profileId, b.profileId] : [b.profileId, a.profileId]
  h.db.prepare(`INSERT INTO profile_friendships (friendship_id, requester_profile_id, addressee_profile_id, lower_profile_id, higher_profile_id, status, responded_at) VALUES (?, ?, ?, ?, ?, 'accepted', CURRENT_TIMESTAMP)`)
    .run(randomUUID(), a.profileId, b.profileId, lower, higher)
}

type Frame = { at: number; type: string; data: any }
type Party = {
  label: string
  profile: TestProfile
  page: Page
  context: BrowserContext
  received: Frame[]
  /** Изпраща съобщение към сървъра през текущата WS връзка на страницата. */
  inject: (message: unknown) => void
}

/** Реалното приложение; WS минава през route само за запис и подправени заявки. */
async function openParty(label: string, profile: TestProfile, viewport: { width: number; height: number }): Promise<Party> {
  const context = await h.browser.newContext(viewport === MOBILE
    ? { viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }
    : { viewport })
  await context.addCookies([{ name: 'belot_session', value: profile.cookie, url: h.backendOrigin }])
  await context.addInitScript(`try { localStorage.setItem('pika-consent-v2', JSON.stringify({ version: 2, necessary: true, analytics: false, marketing: false, updatedAt: new Date().toISOString() })) } catch {}`)
  const received: Frame[] = []
  let current: WebSocketRoute | null = null
  await context.routeWebSocket(/\/ws(\?.*)?$/, (ws) => {
    const server = ws.connectToServer()
    ws.onMessage((m) => server.send(m))
    server.onMessage((m) => {
      try {
        const data = JSON.parse(typeof m === 'string' ? m : m.toString('utf8'))
        received.push({ at: Date.now(), type: String(data?.type ?? ''), data })
      } catch { /* not JSON */ }
      ws.send(m)
    })
    ws.onClose(() => server.close())
    server.onClose(() => ws.close())
    current = server
  })
  const page = await context.newPage()
  await page.goto(`${h.appOrigin}/lobby`)
  await page.locator(LOBBY_READY).first().waitFor({ state: 'attached', timeout: 25_000 })
  await page.waitForTimeout(800)
  return { label, profile, page, context, received, inject: (message) => current?.send(JSON.stringify(message)) }
}

async function goToList(p: Party): Promise<void> {
  if (await p.page.locator(CREATE_OPEN).first().isVisible().catch(() => false)) return
  await p.page.locator(LOBBY_READY).first().waitFor({ state: 'visible', timeout: 25_000 })
  await p.page.locator(LOBBY_READY).first().click()
  await p.page.locator(CREATE_OPEN).first().waitFor({ state: 'visible', timeout: 15_000 })
}

async function reload(p: Party): Promise<void> {
  await p.page.reload()
  await p.page.locator(`${LOBBY_READY}, ${CREATE_OPEN}`).first().waitFor({ state: 'visible', timeout: 25_000 })
  await p.page.waitForTimeout(800)
}

async function createRoom(p: Party, opts: { voice: boolean; partner: boolean }): Promise<string> {
  await goToList(p)
  await p.page.locator(CREATE_OPEN).first().click()
  const form = p.page.locator('[data-private-room-create-form="1"]')
  await form.waitFor({ state: 'visible', timeout: 15_000 })
  await form.locator('input[name="isLocked"]').check()
  await form.locator('input[name="manualStart"]').check()
  if (opts.voice) await form.locator('[data-private-room-voice-checkbox="1"]').check()
  if (opts.partner) await form.locator('[data-private-room-invite-partner-checkbox="1"]').check()
  const before = p.received.length
  await form.locator('button[type="submit"]').click()
  await p.page.locator(WAITING).waitFor({ state: 'attached', timeout: 25_000 })
  if (opts.voice) {
    // Прозорецът за гласа не е предмет на тази стъпка — „Не сега“ (без включване).
    const notNow = p.page.locator('[data-voice-prompt-layer="1"] [data-voice-action="not-now"]').first()
    await notNow.waitFor({ state: 'visible', timeout: 25_000 })
    await notNow.click()
  }
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const f = p.received.slice(before).find((x) => x.type === 'private_room_updated')
    if (f) return f.data.room.id as string
    await sleep(100)
  }
  throw new Error(`${p.label}: няма private_room_updated след създаване`)
}

async function openInvitePopup(host: Party): Promise<void> {
  if (await host.page.locator('[data-private-room-invite-send]').first().isVisible().catch(() => false)) return
  await host.page.locator('[data-private-room-invite-open="1"]').first().click()
  await host.page.locator('[data-private-room-invite-close="1"]').waitFor({ state: 'visible', timeout: 10_000 })
}
const inviteButton = (host: Party, to: TestProfile) => host.page.locator(`[data-private-room-invite-send^="${to.profileId}:"]`)
async function inviteButtonState(host: Party, to: TestProfile): Promise<{ text: string; disabled: boolean }> {
  const btn = inviteButton(host, to)
  await btn.waitFor({ state: 'attached', timeout: 15_000 })
  return { text: ((await btn.textContent()) ?? '').trim(), disabled: await btn.isDisabled() }
}
async function waitInviteButton(host: Party, to: TestProfile, text: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last = { text: '', disabled: false }
  while (Date.now() < deadline) {
    last = await inviteButtonState(host, to).catch(() => last)
    if (last.text === text) return
    await sleep(150)
  }
  throw new Error(`бутонът за ${to.displayName}: ${JSON.stringify(last)} (очаквано "${text}")`)
}
async function sendInvite(host: Party, to: TestProfile): Promise<void> {
  await openInvitePopup(host)
  await waitInviteButton(host, to, 'Покани')
  await inviteButton(host, to).click()
}

async function respondInvite(p: Party, accept: boolean): Promise<string> {
  const selector = accept ? '[data-private-room-invite-accept]' : '[data-private-room-invite-decline]'
  const btn = p.page.locator(selector).first()
  await btn.waitFor({ state: 'visible', timeout: 15_000 })
  const inviteId = (await btn.getAttribute(accept ? 'data-private-room-invite-accept' : 'data-private-room-invite-decline')) ?? ''
  await btn.click()
  return inviteId
}

type ListView = { listed: boolean; invitedChip: boolean; plusButtons: number; lockedChip: boolean; viewerInvited: boolean | null }
async function listView(p: Party, roomId: string): Promise<ListView> {
  await goToList(p)
  await p.page.waitForTimeout(300)
  const dom = await p.page.evaluate(`(() => {
    const plus = document.querySelectorAll('[data-private-room-list-slot-join^="${roomId}:"]').length
    const chip = document.querySelector('[data-private-room-list-invited="${roomId}"]')
    return { plus, chip: chip !== null && chip.textContent.trim() === 'Поканен си' }
  })()`) as { plus: number; chip: boolean }
  const lastList = [...p.received].reverse().find((f) => f.type === 'private_rooms_list')
  const entry = lastList?.data?.rooms?.find((r: any) => r.id === roomId) ?? null
  const lockedChip = await p.page.evaluate(`document.body.textContent.includes('Заключена')`) as boolean
  return { listed: entry !== null, invitedChip: dom.chip, plusButtons: dom.plus, lockedChip, viewerInvited: entry === null ? null : entry.viewerInvited === true }
}
async function waitListView(p: Party, roomId: string, predicate: (v: ListView) => boolean, timeoutMs = 10_000): Promise<ListView> {
  const deadline = Date.now() + timeoutMs
  let v = await listView(p, roomId)
  while (!predicate(v) && Date.now() < deadline) {
    await sleep(250)
    v = await listView(p, roomId)
  }
  return v
}

async function seatFromList(p: Party, roomId: string): Promise<void> {
  await goToList(p)
  const plus = p.page.locator(`[data-private-room-list-slot-join^="${roomId}:"]`).first()
  await plus.waitFor({ state: 'visible', timeout: 15_000 })
  await plus.click()
  await p.page.locator('[data-private-room-join-popup-confirm="1"]').waitFor({ state: 'visible', timeout: 5_000 })
  await p.page.locator('[data-private-room-join-popup-confirm="1"]').click()
}
function isSeatedIn(p: Party, roomId: string): boolean {
  const f = [...p.received].reverse().find((x) => x.type === 'private_room_updated' && x.data?.room?.id === roomId)
  return !!f && f.data.room.slots.some((s: any) => s.occupant?.profileId === p.profile.profileId)
}
async function waitSeated(p: Party, roomId: string, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (isSeatedIn(p, roomId) && await p.page.locator(WAITING).count() > 0) return true
    await sleep(150)
  }
  return false
}
async function waitOffer(p: Party, offer: string, timeoutMs = 20_000): Promise<boolean> {
  try {
    await p.page.waitForFunction(`document.querySelector('[data-voice-prompt-layer="1"] [data-voice-prompt-offer="${offer}"]') !== null`, null, { timeout: timeoutMs })
    return true
  } catch {
    return false
  }
}
async function forgedJoin(p: Party, roomId: string, team: 'A' | 'B', slotIndex: 0 | 1): Promise<string | null> {
  const before = p.received.length
  p.inject({ type: 'join_private_room', privateRoomId: roomId, team, slotIndex })
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const err = p.received.slice(before).find((f) => f.type === 'error')
    if (err) return String(err.data.message)
    if (p.received.slice(before).some((f) => f.type === 'private_room_updated' && f.data?.room?.id === roomId)) return null
    await sleep(100)
  }
  return 'timeout'
}

const parties: Party[] = []
try {
  const host = await h.register('ha')
  const nonVip = await h.register('nv')
  const vip = await h.register('vp')
  const partner = await h.register('pt')
  const lateFull = await h.register('lf')
  const outsider = await h.register('os')
  const host2 = await h.register('hb')
  const decliner = await h.register('dc')
  const expirer = await h.register('ex')
  const closedInvitee = await h.register('ci')
  for (const p of [host, nonVip, vip, partner, lateFull, outsider, host2, decliner, expirer, closedInvitee]) h.setBalance(p.profileId, 50_000_000)
  makeFullAdmin(host.profileId)
  setVip(host.profileId, 30)
  setVip(vip.profileId, 30)
  setVoiceModeAdminOnly(host.profileId)
  for (const f of [nonVip, vip, partner, lateFull]) befriend(host, f)
  for (const f of [decliner, expirer, closedInvitee]) befriend(host2, f)

  // ═══ Маса A: заключена, с глас, "Покани партньор" ═══════════════════════
  const H = await openParty('host', host, DESKTOP); parties.push(H)
  const N = await openParty('non-vip', nonVip, MOBILE); parties.push(N)
  const V = await openParty('vip', vip, DESKTOP); parties.push(V)
  const P = await openParty('partner', partner, MOBILE); parties.push(P)
  const L = await openParty('late', lateFull, MOBILE); parties.push(L)
  const O = await openParty('outsider', outsider, DESKTOP); parties.push(O)
  const roomA = await createRoom(H, { voice: true, partner: true })

  await sendInvite(H, nonVip)
  const sentState = await inviteButtonState(H, nonVip)
  await respondInvite(N, true)
  await N.page.locator(WAITING).waitFor({ state: 'attached', timeout: 15_000 })
  await check('[A1] "Изпратена" при изпращане -> след приемане отново "Покани" без презареждане', async () => {
    assert(sentState.text === 'Изпратена' && sentState.disabled, `след изпращане: ${JSON.stringify(sentState)}`)
    await waitInviteButton(H, nonVip, 'Покани')
    assert(!(await inviteButton(H, nonVip).isDisabled()), 'бутонът е неактивен')
  })

  await reload(N)
  const nAfterF5 = await waitListView(N, roomA, (v) => v.invitedChip && v.plusButtons > 0)
  const reservedPlus = await N.page.locator('[data-private-room-list-slot-join="' + roomA + ':A:1"]').count()
  await seatFromList(N, roomA)
  const nSeated = await waitSeated(N, roomA)
  const nOffer = nSeated && await waitOffer(N, 'listen_vip')
  await check('[A2] non-VIP (mobile): приемане -> F5 -> "Поканен си" + "+" -> сяда; гласова маса -> „само слушай“', async () => {
    assert(nAfterF5.viewerInvited === true && nAfterF5.invitedChip, `след F5: ${JSON.stringify(nAfterF5)}`)
    assert(nAfterF5.plusButtons === 2, `"+" бутони: ${nAfterF5.plusButtons} (очаквани 2 свободни нерезервирани)`)
    assert(reservedPlus === 0, 'резервираното място е кликаемо')
    assert(nSeated, 'не седна')
    assert(nOffer, 'прозорецът не е listen_vip')
  })

  await openInvitePopup(H)
  await sendInvite(H, vip)
  await respondInvite(V, true)
  await V.page.locator(WAITING).waitFor({ state: 'attached', timeout: 15_000 })
  // Излизане от прегледа в приложението („Изчакай в лоби“, без reload).
  await V.page.locator('[data-private-waiting-wait-in-lobby-button="1"]').click()
  await V.page.waitForTimeout(800)
  const vLeftPreview = (await V.page.locator(WAITING).count()) === 0
  const vAfterExit = await waitListView(V, roomA, (v) => v.invitedChip && v.plusButtons > 0)
  const V2 = await openParty('vip-2nd-device', vip, MOBILE); parties.push(V2)
  const v2View = await waitListView(V2, roomA, (v) => v.invitedChip && v.plusButtons > 0)
  await seatFromList(V2, roomA)
  const vSeated = await waitSeated(V2, roomA)
  const vOffer = vSeated && await waitOffer(V2, 'speak')
  await check('[A3] VIP: приемане -> излиза от прегледа -> "+"; второ устройство вижда "Поканен си" и сяда; „Включи микрофона“', async () => {
    assert(vLeftPreview, 'излизането от прегледа не сработи')
    assert(vAfterExit.viewerInvited === true && vAfterExit.invitedChip && vAfterExit.plusButtons === 1, `след излизане: ${JSON.stringify(vAfterExit)}`)
    assert(v2View.viewerInvited === true && v2View.invitedChip && v2View.plusButtons === 1, `второ устройство: ${JSON.stringify(v2View)}`)
    assert(vSeated, 'не седна от второто устройство')
    assert(vOffer, 'прозорецът не е speak')
  })

  // Приел, но още не седнал — нужен е за [A6]; приема преди масата да се напълни.
  await openInvitePopup(H)
  await sendInvite(H, lateFull)
  await respondInvite(L, true)
  await L.page.locator(WAITING).waitFor({ state: 'attached', timeout: 15_000 })

  const oView = await listView(O, roomA)
  const oForged = await forgedJoin(O, roomA, 'B', 1)
  await check('[A4] непоканен: "Заключена", без "+", viewerInvited=false; подправен join -> отказ', async () => {
    assert(oView.listed && oView.viewerInvited === false && !oView.invitedChip, JSON.stringify(oView))
    assert(oView.plusButtons === 0 && oView.lockedChip, `"+" бутони: ${oView.plusButtons}`)
    assert(oForged === LOCKED_TEXT, `отговор: ${oForged}`)
    assert(!isSeatedIn(O, roomA), 'седна без покана')
  })

  // ─── [A5] Партньорска покана ──────────────────────────────────────────
  await H.page.locator('[data-private-room-invite-close="1"]').click().catch(() => undefined)
  await H.page.locator('[data-private-room-partner-invite-open="1"]').click()
  await H.page.locator(`[data-private-room-partner-send="${partner.profileId}"]`).waitFor({ state: 'visible', timeout: 15_000 })
  await H.page.locator(`[data-private-room-partner-send="${partner.profileId}"]`).click()
  await respondInvite(P, true)
  const pSeated = await waitSeated(P, roomA)
  const pSlot = [...P.received].reverse().find((f) => f.type === 'private_room_updated' && f.data?.room?.id === roomA)
    ?.data.room.slots.find((s: any) => s.occupant?.profileId === partner.profileId)
  await check('[A5] партньорска покана (mobile) -> сяда директно в резервираното място', async () => {
    assert(pSeated, 'не седна')
    assert(pSlot?.team === 'A' && pSlot?.slotIndex === 1, JSON.stringify(pSlot))
  })

  // ─── [A6] Масата е пълна ──────────────────────────────────────────────
  await reload(L)
  const lView = await waitListView(L, roomA, (v) => v.invitedChip)
  const lForged = await forgedJoin(L, roomA, 'B', 1)
  await check('[A6] приел, но масата е пълна -> "Поканен си" без "+"; подправен join -> отказ', async () => {
    assert(lView.viewerInvited === true && lView.invitedChip, JSON.stringify(lView))
    assert(lView.plusButtons === 0, `"+" бутони: ${lView.plusButtons}`)
    assert(lForged !== null && lForged !== 'timeout', `отговор: ${lForged}`)
    assert(!isSeatedIn(L, roomA), 'седна на пълна маса')
  })

  // ═══ Маса C: затворена маса ════════════════════════════════════════════
  const H2 = await openParty('host2', host2, DESKTOP); parties.push(H2)
  const C = await openParty('closed', closedInvitee, DESKTOP); parties.push(C)
  const roomC = await createRoom(H2, { voice: false, partner: false })
  await sendInvite(H2, closedInvitee)
  await respondInvite(C, true)
  await C.page.locator(WAITING).waitFor({ state: 'attached', timeout: 15_000 })
  await H2.page.locator('[data-private-room-invite-close="1"]').click().catch(() => undefined)
  await H2.page.locator('[data-private-room-leave-slot="1"]').click()
  await H2.page.locator('[data-private-room-leave-popup-confirm="1"]').click()
  await reload(C)
  const cView = await waitListView(C, roomC, (v) => !v.listed)
  const cForged = await forgedJoin(C, roomC, 'B', 0)
  await check('[C1] затворена маса -> изчезва от списъка на приелия; подправен join -> отказ', async () => {
    assert(!cView.listed && !cView.invitedChip && cView.plusButtons === 0, JSON.stringify(cView))
    assert(cForged === 'Масата не съществува.', `отговор: ${cForged}`)
  })

  // ═══ Маса B: без глас ══════════════════════════════════════════════════
  const D = await openParty('decliner', decliner, DESKTOP); parties.push(D)
  const E = await openParty('expirer', expirer, MOBILE); parties.push(E)
  await H2.page.waitForTimeout(500)
  const roomB = await createRoom(H2, { voice: false, partner: false })

  // Изтичането отнема 60 s — поканата към E тръгва първа, отказът се проверява междувременно.
  await sendInvite(H2, expirer)
  const expiryStartedAt = Date.now()
  await E.page.locator('[data-private-room-invite-accept]').first().waitFor({ state: 'visible', timeout: 15_000 })

  await sendInvite(H2, decliner)
  const firstInviteId = await respondInvite(D, false)
  let declineReset = true
  try { await waitInviteButton(H2, decliner, 'Покани') } catch { declineReset = false }
  const dView = await listView(D, roomB)
  await sendInvite(H2, decliner)
  const secondInviteId = await respondInvite(D, true)
  await D.page.locator(WAITING).waitFor({ state: 'attached', timeout: 15_000 })
  await D.page.locator('[data-private-room-slot-join]').first().click()
  await D.page.locator('[data-private-room-join-popup-confirm="1"]').click()
  const dSeated = await waitSeated(D, roomB)
  await check('[B1] отказ -> "Покани" без презареждане; без право; повторна покана стига; приемане -> сяда (desktop)', async () => {
    assert(declineReset, 'бутонът остана "Изпратена"')
    assert(dView.viewerInvited === false && !dView.invitedChip && dView.plusButtons === 0, `след отказ: ${JSON.stringify(dView)}`)
    assert(firstInviteId !== '' && secondInviteId !== '' && firstInviteId !== secondInviteId, 'повторната покана не стигна')
    assert(dSeated, 'не седна')
  })

  const waitMs = Math.max(0, expiryStartedAt + 61_500 - Date.now())
  console.log(`  ... изчакване на изтичането (${Math.round(waitMs / 1000)} s)`)
  await sleep(waitMs)
  let expiryReset = true
  try { await waitInviteButton(H2, expirer, 'Покани', 5_000) } catch { expiryReset = false }
  const ePopupGone = (await E.page.locator('[data-private-room-invite-accept]').count()) === 0
  const eView = await listView(E, roomB)
  const eForged = await forgedJoin(E, roomB, 'B', 1)
  await sendInvite(H2, expirer)
  await respondInvite(E, true)
  await E.page.locator(WAITING).waitFor({ state: 'attached', timeout: 15_000 })
  await reload(E)
  const eAfterF5 = await waitListView(E, roomB, (v) => v.invitedChip && v.plusButtons > 0)
  await seatFromList(E, roomB)
  const eSeated = await waitSeated(E, roomB)
  await check('[B2] изтекла покана -> "Покани"; без право; повторна покана -> приемане -> F5 -> сяда (mobile, без глас)', async () => {
    assert(expiryReset, 'бутонът остана "Изпратена" след изтичането')
    assert(ePopupGone, 'поканата не изчезна при поканения')
    assert(eView.viewerInvited === false && !eView.invitedChip && eView.plusButtons === 0, `след изтичане: ${JSON.stringify(eView)}`)
    assert(eForged === LOCKED_TEXT, `подправен join след изтичане: ${eForged}`)
    assert(eAfterF5.viewerInvited === true && eAfterF5.invitedChip && eAfterF5.plusButtons > 0, `след F5: ${JSON.stringify(eAfterF5)}`)
    assert(eSeated, 'не седна')
  })

  await check('[Z] viewerInvited/ownPendingInviteProfileIds не стигат до чужд получател; поканените не се разкриват', async () => {
    const leaks: string[] = []
    for (const p of parties) {
      for (const f of p.received) {
        const rooms: any[] = f.type === 'private_rooms_list' ? f.data.rooms : f.type === 'private_room_updated' ? [f.data.room] : []
        for (const r of rooms) {
          if (r.viewerInvited === true) {
            const allowed = (r.id === roomA && [nonVip, vip, lateFull].some((x) => x.profileId === p.profile.profileId))
              || (r.id === roomB && [decliner, expirer].some((x) => x.profileId === p.profile.profileId))
              || (r.id === roomC && p.profile.profileId === closedInvitee.profileId)
            if (!allowed) leaks.push(`${p.label}: viewerInvited за ${r.id}`)
          }
          if (Array.isArray(r.ownPendingInviteProfileIds)) {
            if (f.type !== 'private_room_updated') leaks.push(`${p.label}: ownPendingInviteProfileIds в списъка`)
            if (r.ownPendingInviteProfileIds.length > 0 && ![host, host2].some((x) => x.profileId === p.profile.profileId)) {
              leaks.push(`${p.label}: висящи покани ${JSON.stringify(r.ownPendingInviteProfileIds)}`)
            }
          }
        }
      }
    }
    // Непоканеният никога не вижда профила на приелия, който не е седнал.
    if (O.received.some((f) => JSON.stringify(f.data).includes(lateFull.profileId))) leaks.push('outsider вижда lateFull')
    assert(leaks.length === 0, leaks.slice(0, 5).join(' | '))
  })
} catch (error) {
  console.error('  FAIL  неочаквана грешка:', error instanceof Error ? error.stack : error)
  console.error(h.serverOutput().split('\n').slice(-25).join('\n'))
  await check('без неочаквани грешки', () => { throw error })
} finally {
  await h.close()
}
finishAndExit()
