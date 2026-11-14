/**
 * checkLobbySoftReconnectE2E.ts — тихо възстановяване на игровия WS в лобито
 * и чакалнята (без презареждане), реално прекъсване/възстановяване.
 *
 * Реален сървър (изолирано копие + празна SQLite база, никога реалната),
 * реален Vite dev server с истинския src/main.ts, реален Chromium, реални
 * кликове (scripts/giftBackTestHarness.ts). Прекъсването е реално затваряне на
 * WS връзката (context.routeWebSocket) или офлайн режим на браузъра. Само
 * LiveKit адаптерът е тестова подмяна (scripts/fixtures/fakeLiveKitVoiceAdapter.ts,
 * без мрежа) — гласовият контролер, voice_presence/lease, токенът и сървърът
 * са истинските. Режим „Само админ“.
 *
 *   [E1] кратко прекъсване в чакалнята на гласова маса (mobile и desktop):
 *        компактна лента, без цял екран и без reload; след възстановяване —
 *        същата страница, мястото е запазено, гласовата сесия е същата
 *        (без нова „стая“, без край), voice_presence от новата връзка е приет;
 *   [E2] чатът: нов абонамент + история (съобщение по време на прекъсването
 *        се появява); изпращане след възстановяването стига до другия;
 *   [E3] продължително прекъсване (сървърът е недостъпен, ~20 s, desktop):
 *        цял екран след 15 s „Връзката със сървъра е прекъсната“ + текст;
 *        после тихо възстановяване, екранът се скрива, гласът остава;
 *   [E4] офлайн браузър (~17 s, mobile): „Няма връзка с интернет“; онлайн ->
 *        тихо възстановяване;
 *   [E5] многократни прекъсвания: всяко тихо, без reload, един и същ глас;
 *   [E6] играта започва през прекъсването: съществуващият прозорец
 *        session_in_game („Върни ме в играта“) -> влизане в играта; без
 *        „Масата вече не е налична“ и без reload;
 *   [E7] загубено място през прекъсването (kick): авторитетният списък ->
 *        изход от чакалнята със съобщение, без reload;
 *   [E8] прекъснато търсене на случайна маса: спира, съобщение, не се
 *        подновява автоматично (без join_matchmaking), без reload;
 *   [E9] сменена/невалидна сесия (logout от друго място): reload via=session,
 *        точно един, без цикъл;
 *   [E10] рестарт на backend: reload via=restart (desktop и mobile), точно един,
 *        без цикъл; лобито работи след него;
 *   [E11] health: без застъпващи се заявки; при работещ WS ~30 s интервал;
 *        без грешки в конзолата.
 *
 *   node server/node_modules/tsx/dist/cli.mjs scripts/checkLobbySoftReconnectE2E.ts
 */

import { randomUUID } from 'node:crypto'
import { createServer as createHttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import type { BrowserContext, Page, WebSocketRoute } from 'playwright'
import { assert, check, finishAndExit, sleep, startGiftBackHarness, type TestProfile } from './giftBackTestHarness'

console.log('\ncheckLobbySoftReconnectE2E\n')

// LiveKit не участва: локален фалшив Twirp API (само loopback, минимални
// отговори на RoomService) и изхвърляеми фиктивни ключове само за изолирания
// сървърен процес на теста — не истински ключове.
const fakeTwirp = createHttpServer((req, res) => {
  let raw = ''
  req.on('data', (chunk) => { raw += chunk })
  req.on('end', () => {
    const method = (req.url ?? '').split('/').pop() ?? ''
    let body: any = {}
    try { body = raw ? JSON.parse(raw) : {} } catch { body = {} }
    const reply = method === 'CreateRoom' ? { name: body.name ?? '', sid: 'RM_e2e' }
      : method === 'ListRooms' ? { rooms: [] }
        : method === 'ListParticipants' ? { participants: [] }
          : {}
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(reply))
  })
})
await new Promise<void>((done) => fakeTwirp.listen(0, '127.0.0.1', () => done()))
const fakeTwirpPort = (fakeTwirp.address() as AddressInfo).port
process.env.LIVEKIT_API_URL = `http://127.0.0.1:${fakeTwirpPort}`
process.env.LIVEKIT_WS_URL = 'ws://127.0.0.1:9'
process.env.LIVEKIT_API_KEY = 'e2e-test-only'
process.env.LIVEKIT_API_SECRET = 'e2e-test-only-not-a-real-secret-0000000000'
process.env.VOICE_ROOM_NAMESPACE = 'e2etest'
delete process.env.VOICE_CHAT_ENABLED

const FAKE_ADAPTER = join(process.cwd(), 'scripts', 'fixtures', 'fakeLiveKitVoiceAdapter.ts')
const h = await startGiftBackHarness({
  vitePlugins: [{
    name: 'e2e-fake-livekit-adapter',
    enforce: 'pre',
    resolveId(source, importer) {
      if (source === './liveKitVoiceAdapter' && importer !== undefined && /voiceRuntime\.ts$/.test(importer.split('?')[0]!)) return FAKE_ADAPTER
      return null
    },
  }],
})

const DESKTOP = { width: 1280, height: 850 }
const MOBILE = { width: 390, height: 844 }
const LOBBY_READY = '[data-lobby-private-rooms-card="1"]'
const WAITING = '[data-private-room-waiting-screen="1"]'
const BANNER = '[data-connection-recovering-banner="1"]'
const OVERLAY = '[data-offline-overlay="1"]'
const PROMPT = '[data-voice-prompt-layer="1"] [data-voice-prompt-offer]'

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

type Frame = { at: number; type: string; data: any }
type Controlled = {
  label: string
  page: Page
  context: BrowserContext
  received: Frame[]
  sent: Frame[]
  wsOpened: () => number
  offlineReloads: string[]
  health: { started: number; maxConcurrent: number; inFlight: number; at: number[] }
  errors: string[]
  disconnect: () => void
  reconnect: () => void
}

/** Страница с WebSocket през route — реално затваряне/възстановяване на връзката. */
async function openControlled(label: string, profile: TestProfile, viewport: { width: number; height: number }): Promise<Controlled> {
  const context = await h.browser.newContext(viewport === MOBILE
    ? { viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }
    : { viewport })
  await context.addCookies([{ name: 'belot_session', value: profile.cookie, url: h.backendOrigin }])
  await context.addInitScript(`try { localStorage.setItem('pika-consent-v2', JSON.stringify({ version: 2, necessary: true, analytics: false, marketing: false, updatedAt: new Date().toISOString() })) } catch {}`)
  const received: Frame[] = []
  const sent: Frame[] = []
  let opened = 0
  let blocked = false
  let current: { page: WebSocketRoute; server: WebSocketRoute } | null = null
  const parse = (m: string | Buffer): Frame | null => {
    try {
      const data = JSON.parse(typeof m === 'string' ? m : m.toString('utf8'))
      return { at: Date.now(), type: String(data?.type ?? ''), data }
    } catch {
      return null
    }
  }
  await context.routeWebSocket(/\/ws(\?.*)?$/, (ws) => {
    if (blocked) {
      ws.close({ code: 4000, reason: 'e2e offline' })
      return
    }
    opened += 1
    const server = ws.connectToServer()
    ws.onMessage((m) => { const f = parse(m); if (f) sent.push(f); server.send(m) })
    server.onMessage((m) => { const f = parse(m); if (f) received.push(f); ws.send(m) })
    ws.onClose(() => server.close())
    server.onClose(() => ws.close())
    current = { page: ws, server }
  })
  const page = await context.newPage()
  const offlineReloads: string[] = []
  const health = { started: 0, maxConcurrent: 0, inFlight: 0, at: [] as number[] }
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('request', (req) => {
    const url = req.url()
    if (url.includes('offlineReload=')) offlineReloads.push(url)
    if (/\/health(\?|$)/.test(url)) {
      health.started += 1
      health.inFlight += 1
      health.at.push(Date.now())
      health.maxConcurrent = Math.max(health.maxConcurrent, health.inFlight)
    }
  })
  const endHealth = (req: { url: () => string }) => { if (/\/health(\?|$)/.test(req.url())) health.inFlight = Math.max(0, health.inFlight - 1) }
  page.on('requestfinished', endHealth)
  page.on('requestfailed', endHealth)
  await page.goto(`${h.appOrigin}/lobby`)
  await page.locator(LOBBY_READY).first().waitFor({ state: 'attached', timeout: 25_000 })
  await page.waitForTimeout(800)
  return {
    label, page, context, received, sent, offlineReloads, health, errors,
    wsOpened: () => opened,
    disconnect() {
      blocked = true
      const c = current
      current = null
      c?.server.close()
      c?.page.close({ code: 4001, reason: 'e2e drop' })
    },
    reconnect() { blocked = false },
  }
}

// Скриптовете в браузъра са низове: tsx/esbuild добавя __name(...) към именуваните функции.
const setMarker = (p: Page) => p.evaluate(`window.__e2ePageMarker = 'kept-${randomUUID()}'; window.__e2ePageMarker`) as Promise<string>
const getMarker = (p: Page) => p.evaluate(`window.__e2ePageMarker || null`) as Promise<string | null>
const fakeLiveKit = (p: Page) => p.evaluate(`window.__fakeLiveKit || null`) as Promise<{ prepares: number; connects: number; disconnects: number; activeRooms: number } | null>
const voiceStripText = (p: Page) => p.evaluate(`(() => { const el = document.querySelector('[data-voice-waiting-strip="1"] .pvs-sub'); return el ? el.textContent : null })()`) as Promise<string | null>
const isVisible = (p: Page, selector: string) => p.evaluate(`!!document.querySelector('${selector}')`) as Promise<boolean>
const overlayTitle = (p: Page) => p.evaluate(`(() => { const el = document.querySelector('${OVERLAY} [data-offline-title="1"]'); return el ? el.textContent : null })()`) as Promise<string | null>
const overlayText = (p: Page) => p.evaluate(`(() => { const el = document.querySelector('${OVERLAY} p'); return el ? el.textContent.trim() : null })()`) as Promise<string | null>
const chatText = (p: Page) => p.evaluate(`(() => { const el = document.querySelector('[data-private-waiting-chat-scroll="1"]'); return el ? el.textContent : '' })()`) as Promise<string>

async function waitFor(p: Page, expression: string, timeoutMs: number): Promise<boolean> {
  try {
    await p.waitForFunction(expression, null, { timeout: timeoutMs })
    return true
  } catch {
    return false
  }
}
async function joinRoom(page: Page, roomId: string): Promise<void> {
  await page.locator(LOBBY_READY).first().click()
  const plus = page.locator(`[data-private-room-list-slot-join^="${roomId}:"]`).first()
  await plus.waitFor({ state: 'visible', timeout: 15_000 })
  await plus.click()
  await page.locator('[data-private-room-join-popup-confirm="1"]').waitFor({ state: 'visible', timeout: 5_000 })
  await page.locator('[data-private-room-join-popup-confirm="1"]').click()
  await page.locator(WAITING).waitFor({ state: 'visible', timeout: 15_000 })
}
async function joinVoiceAsListener(page: Page): Promise<boolean> {
  await page.locator(PROMPT).waitFor({ state: 'visible', timeout: 25_000 })
  await page.locator('[data-voice-prompt-layer="1"] [data-voice-action="join-listen"]').first().click()
  return waitFor(page, `(() => { const el = document.querySelector('[data-voice-waiting-strip="1"] .pvs-sub'); return !!el && el.textContent === 'Слушате' })()`, 20_000)
}
async function createVoiceRoom(page: Page, manualStart: boolean): Promise<void> {
  await page.locator(LOBBY_READY).first().click()
  await page.locator('[data-private-rooms-create-open="1"]').first().click()
  const voiceCheckbox = page.locator('[data-private-room-create-form="1"] [data-private-room-voice-checkbox="1"]')
  await voiceCheckbox.waitFor({ state: 'visible', timeout: 15_000 })
  await voiceCheckbox.check()
  if (manualStart) await page.locator('[data-private-room-create-form="1"] input[name="manualStart"]').check()
  await page.locator('[data-private-room-create-form="1"] button[type="submit"]').click()
  await page.locator(WAITING).waitFor({ state: 'visible', timeout: 20_000 })
}
const lastRoomId = (frames: Frame[]) => [...frames].reverse().find((f) => f.type === 'private_room_updated' && f.data?.room?.id)?.data?.room?.id as string | undefined
const seated = (frames: Frame[], profileId: string) => {
  const room = [...frames].reverse().find((f) => f.type === 'private_room_updated')?.data?.room
  return !!room && room.slots.some((s: any) => s.occupant?.profileId === profileId)
}

/** Кратко прекъсване: проверки по време на него и след възстановяването. */
async function shortDrop(c: Controlled, ms: number, during?: () => Promise<void>) {
  const sentBefore = c.sent.length
  const receivedBefore = c.received.length
  c.disconnect()
  await sleep(400)
  const banner = await isVisible(c.page, BANNER)
  if (during) await during()
  await sleep(Math.max(0, ms - 400))
  const overlayDuring = await isVisible(c.page, OVERLAY)
  const waitingDuring = await isVisible(c.page, WAITING)
  const voiceDuring = await voiceStripText(c.page)
  c.reconnect()
  const recovered = await waitFor(c.page, `!document.querySelector('${BANNER}') && !document.querySelector('${OVERLAY}')`, 15_000)
  await sleep(600)
  return { banner, overlayDuring, waitingDuring, voiceDuring, recovered, sent: c.sent.slice(sentBefore), received: c.received.slice(receivedBefore) }
}

let exitCode = 0
const all: Controlled[] = []
try {
  const creator = await h.register('sra')
  const guest = await h.register('srb')
  const third = await h.register('src')
  const fourth = await h.register('srd')
  const kickHost = await h.register('sre')
  const kicked = await h.register('srf')
  const searcher = await h.register('srg')
  const loggedOut = await h.register('srh')
  const restartDesk = await h.register('sri')
  const restartMob = await h.register('srj')
  for (const p of [creator, guest, third, fourth, kickHost, kicked, searcher, loggedOut, restartDesk, restartMob]) h.setBalance(p.profileId, 50_000_000)
  makeFullAdmin(creator.profileId)
  makeFullAdmin(kickHost.profileId)
  setVip(creator.profileId, 30)
  setVip(guest.profileId, 30)
  setVip(kickHost.profileId, 30)
  setVoiceModeAdminOnly(creator.profileId)

  // ─── Гласова маса: A (desktop, създател) + B (mobile) ──────────────────
  const a = await openControlled('desktop', creator, DESKTOP)
  const b = await openControlled('mobile', guest, MOBILE)
  all.push(a, b)
  await createVoiceRoom(a.page, true)
  const roomId = lastRoomId(a.received)
  assert(roomId, 'гласова маса')
  const aVoice = await joinVoiceAsListener(a.page)
  await joinRoom(b.page, roomId)
  const bVoice = await joinVoiceAsListener(b.page)
  const aMarker = await setMarker(a.page)
  const bMarker = await setMarker(b.page)

  // ─── [E1]+[E2] Кратко прекъсване (mobile), съобщение по време на него ──
  const duringMessage = `докато-B-е-офлайн-${Date.now()}`
  const bDrop = await shortDrop(b, 3_000, async () => {
    await a.page.locator('[data-private-waiting-chat-input="1"]').fill(duringMessage)
    await a.page.locator('[data-private-waiting-chat-form="1"] button[type="submit"]').click()
  })
  const bLiveKit = await fakeLiveKit(b.page)
  const historyShown = await waitFor(b.page, `(() => { const el = document.querySelector('[data-private-waiting-chat-scroll="1"]'); return !!el && el.textContent.includes('${duringMessage}') })()`, 8_000)
  const afterMessage = `след-възстановяване-${Date.now()}`
  await b.page.locator('[data-private-waiting-chat-input="1"]').fill(afterMessage)
  await b.page.locator('[data-private-waiting-chat-form="1"] button[type="submit"]').click()
  const deliveredToA = await waitFor(a.page, `(() => { const el = document.querySelector('[data-private-waiting-chat-scroll="1"]'); return !!el && el.textContent.includes('${afterMessage}') })()`, 8_000)

  await check('[E1] [mobile] Кратко прекъсване в чакалнята: лента, без цял екран и reload; същата страница, мястото и гласовата сесия са запазени', async () => {
    assert(aVoice && bVoice, `гласът е включен: A=${aVoice} B=${bVoice}`)
    assert(bDrop.banner && !bDrop.overlayDuring && bDrop.waitingDuring, `по време: ${JSON.stringify({ banner: bDrop.banner, overlay: bDrop.overlayDuring, waiting: bDrop.waitingDuring })}`)
    assert(bDrop.voiceDuring === 'Слушате', `гласът по време на прекъсването: ${bDrop.voiceDuring}`)
    assert(bDrop.recovered, 'лентата не изчезна')
    assert((await getMarker(b.page)) === bMarker && b.offlineReloads.length === 0, `reload: ${b.offlineReloads.join(', ')}`)
    assert(await isVisible(b.page, WAITING), 'чакалнята е на екрана')
    assert(seated(bDrop.received, guest.profileId), 'private_room_updated след възстановяването — B е на мястото')
    assert(bLiveKit !== null && bLiveKit.connects === 1 && bLiveKit.disconnects === 0 && bLiveKit.activeRooms === 1, `LiveKit: ${JSON.stringify(bLiveKit)}`)
    assert((await voiceStripText(b.page)) === 'Слушате', 'гласът след възстановяването')
    const roomsListIdx = bDrop.received.findIndex((f) => f.type === 'private_room_updated')
    const presenceIdx = bDrop.sent.findIndex((f) => f.type === 'voice_presence')
    assert(presenceIdx >= 0, 'voice_presence по новата връзка')
    assert(bDrop.received.some((f) => f.type === 'voice_presence_result' && f.data.ok === true && f.data.onTableScreen === true), `presence result: ${JSON.stringify(bDrop.received.filter((f) => f.type === 'voice_presence_result').map((f) => f.data))}`)
    assert(!bDrop.received.some((f) => f.type === 'voice_access_ended'), 'voice_access_ended')
    assert(roomsListIdx >= 0, 'синхронизация')
  })

  await check('[E2] [mobile] Чатът: нов абонамент + история (съобщението по време на прекъсването), изпращането след това стига до другия', async () => {
    assert(bDrop.sent.some((f) => f.type === 'subscribe_private_room_chat' && f.data.privateRoomId === roomId), 'subscribe_private_room_chat')
    assert(bDrop.received.some((f) => f.type === 'private_room_chat_history'), 'история')
    assert(historyShown, `съобщението липсва: ${(await chatText(b.page)).slice(-200)}`)
    assert(deliveredToA, 'съобщението на B не стигна до A')
  })

  // ─── [E1] desktop: създателят (домакин) ────────────────────────────────
  const aDrop = await shortDrop(a, 3_000)
  const aLiveKit = await fakeLiveKit(a.page)
  await check('[E1] [desktop] Кратко прекъсване при домакина: лента, без reload; мястото, гласът и бутонът СТАРТ са на място', async () => {
    assert(aDrop.banner && !aDrop.overlayDuring && aDrop.recovered, JSON.stringify({ banner: aDrop.banner, overlay: aDrop.overlayDuring, recovered: aDrop.recovered }))
    assert((await getMarker(a.page)) === aMarker && a.offlineReloads.length === 0, 'reload')
    assert(seated(aDrop.received, creator.profileId), 'A е на мястото')
    assert(aLiveKit !== null && aLiveKit.connects === 1 && aLiveKit.disconnects === 0, `LiveKit: ${JSON.stringify(aLiveKit)}`)
    assert(aDrop.received.some((f) => f.type === 'voice_presence_result' && f.data.ok === true), 'presence')
    assert(await isVisible(a.page, '[data-private-room-manual-start="1"]'), 'СТАРТ')
  })

  // ─── [E5] Многократни прекъсвания (mobile) ────────────────────────────
  const openedBefore = b.wsOpened()
  const cycles: boolean[] = []
  for (let i = 0; i < 4; i += 1) {
    const r = await shortDrop(b, 1_500)
    cycles.push(r.banner && r.recovered && !r.overlayDuring)
    await sleep(1_500)
  }
  const bLiveKitAfterCycles = await fakeLiveKit(b.page)
  await check('[E5] [mobile] 4 поредни прекъсвания: всяко тихо, без reload и без нова гласова сесия; връзките са точно 4 нови', async () => {
    assert(cycles.every(Boolean), JSON.stringify(cycles))
    assert((await getMarker(b.page)) === bMarker && b.offlineReloads.length === 0, 'reload')
    assert(b.wsOpened() - openedBefore === 4, `нови връзки: ${b.wsOpened() - openedBefore}`)
    assert(bLiveKitAfterCycles !== null && bLiveKitAfterCycles.connects === 1 && bLiveKitAfterCycles.disconnects === 0, JSON.stringify(bLiveKitAfterCycles))
    assert(await isVisible(b.page, WAITING) && (await voiceStripText(b.page)) === 'Слушате', 'чакалня и глас')
  })

  // ─── [E3] Продължително прекъсване ~20 s (desktop) ─────────────────────
  a.disconnect()
  await sleep(13_000)
  const overlayAt13 = await isVisible(a.page, OVERLAY)
  await sleep(4_000)
  const overlayAt17 = await isVisible(a.page, OVERLAY)
  const titleAt17 = await overlayTitle(a.page)
  const textAt17 = await overlayText(a.page)
  await sleep(3_000)
  a.reconnect()
  const aRecoveredLong = await waitFor(a.page, `!document.querySelector('${BANNER}') && !document.querySelector('${OVERLAY}')`, 15_000)
  await sleep(600)
  const aLiveKitLong = await fakeLiveKit(a.page)
  await check('[E3] [desktop] Продължително прекъсване: цял екран след 15 s („Връзката със сървъра е прекъсната“), после тихо възстановяване без reload, гласът остава', async () => {
    assert(!overlayAt13 && overlayAt17, `цял екран: 13s=${overlayAt13} 17s=${overlayAt17}`)
    assert(titleAt17 === 'Връзката със сървъра е прекъсната' && textAt17 === 'Опитваме се да възстановим връзката автоматично.', `${titleAt17} / ${textAt17}`)
    assert(aRecoveredLong, 'екранът не се скри')
    assert((await getMarker(a.page)) === aMarker && a.offlineReloads.length === 0, 'reload')
    assert(aLiveKitLong !== null && aLiveKitLong.connects === 1 && aLiveKitLong.disconnects === 0, JSON.stringify(aLiveKitLong))
    assert(await isVisible(a.page, WAITING), 'чакалнята')
  })

  // ─── [E4] Офлайн браузър ~17 s (mobile) ────────────────────────────────
  await b.context.setOffline(true)
  await sleep(1_000)
  const bannerOffline = await isVisible(b.page, BANNER)
  await sleep(16_000)
  const titleOffline = await overlayTitle(b.page)
  await b.context.setOffline(false)
  const bRecoveredOffline = await waitFor(b.page, `!document.querySelector('${BANNER}') && !document.querySelector('${OVERLAY}')`, 20_000)
  await sleep(600)
  await check('[E4] [mobile] Офлайн браузър: лента, после „Няма връзка с интернет“; онлайн -> тихо възстановяване без reload', async () => {
    assert(bannerOffline, 'лента')
    assert(titleOffline === 'Няма връзка с интернет', `заглавие: ${titleOffline}`)
    assert(bRecoveredOffline, 'не се възстанови')
    assert((await getMarker(b.page)) === bMarker && b.offlineReloads.length === 0, 'reload')
    assert(await isVisible(b.page, WAITING), 'чакалнята')
  })

  // ─── [E6] Играта започва през прекъсването ─────────────────────────────
  const c3 = await h.openPage(third, DESKTOP, '/lobby', LOBBY_READY)
  const c4 = await h.openPage(fourth, DESKTOP, '/lobby', LOBBY_READY)
  await joinRoom(c3.page, roomId)
  await joinRoom(c4.page, roomId)
  b.disconnect()
  await sleep(800)
  await a.page.waitForFunction(`(() => { const b = document.querySelector('[data-private-room-manual-start="1"]'); return b !== null && !b.disabled })()`, null, { timeout: 15_000 })
  await a.page.locator('[data-private-room-manual-start="1"]').click()
  await sleep(2_500)
  b.reconnect()
  const sessionInGameShown = await waitFor(b.page, `!!document.querySelector('[data-session-rejoin="1"]')`, 20_000)
  const goneToastShown = await b.page.evaluate(`document.body.textContent.includes('Масата вече не е налична.')`) as boolean
  const bannerGoneAfterGame = await waitFor(b.page, `!document.querySelector('${BANNER}')`, 10_000)
  if (sessionInGameShown) await b.page.locator('[data-session-rejoin="1"]').click()
  const enteredGame = await waitFor(b.page, `!document.querySelector('${WAITING}') && !document.querySelector('[data-session-rejoin="1"]')`, 15_000)
  await sleep(1_500)
  await check('[E6] [mobile] Играта започна през прекъсването: съществуващият „Върни ме в играта“ -> играта; без „Масата вече не е налична“ и без reload', async () => {
    assert(sessionInGameShown, 'прозорецът session_in_game липсва')
    assert(!goneToastShown, '„Масата вече не е налична“ не трябва да се показва')
    assert(bannerGoneAfterGame, 'лентата остана')
    assert(enteredGame, 'влизане в играта')
    assert(b.received.some((f) => f.type === 'room_resumed'), 'room_resumed')
    assert((await getMarker(b.page)) === bMarker && b.offlineReloads.length === 0, 'reload')
  })

  // ─── [E7] Kick през прекъсването (mobile) ──────────────────────────────
  const host = await openControlled('desktop', kickHost, DESKTOP)
  const k = await openControlled('mobile', kicked, MOBILE)
  all.push(host, k)
  await createVoiceRoom(host.page, true)
  const kickRoomId = lastRoomId(host.received)
  assert(kickRoomId, 'втора маса')
  await host.page.locator('[data-voice-prompt-layer="1"] [data-voice-action="not-now"]').first().click().catch(() => {})
  await joinRoom(k.page, kickRoomId)
  await k.page.locator('[data-voice-prompt-layer="1"] [data-voice-action="not-now"]').first().click({ timeout: 10_000 }).catch(() => {})
  const kMarker = await setMarker(k.page)
  k.disconnect()
  await sleep(600)
  await host.page.locator('[data-private-room-kick-slot]').first().click()
  await host.page.locator('[data-private-room-kick-popup-confirm="1"]').click()
  await sleep(1_000)
  k.reconnect()
  const leftWaiting = await waitFor(k.page, `!document.querySelector('${WAITING}')`, 15_000)
  const goneToast = await waitFor(k.page, `document.body.textContent.includes('Масата вече не е налична.')`, 5_000)
  await check('[E7] [mobile] Загубено място през прекъсването (kick): изход от чакалнята по авторитетния списък, съобщение, без reload', async () => {
    assert(leftWaiting, 'остана в чакалнята')
    assert(goneToast, 'съобщение „Масата вече не е налична.“')
    assert(k.received.some((f) => f.type === 'private_rooms_list'), 'авторитетният списък')
    assert((await getMarker(k.page)) === kMarker && k.offlineReloads.length === 0, 'reload')
    assert(!(await isVisible(k.page, BANNER)), 'лентата')
  })

  // ─── [E8] Прекъснато търсене (desktop) ─────────────────────────────────
  const s = await openControlled('desktop', searcher, DESKTOP)
  all.push(s)
  const sMarker = await setMarker(s.page)
  await s.page.locator('[data-lobby-stake-card="5000"]').first().click()
  await sleep(1_000)
  const sentJoin = s.sent.filter((f) => f.type === 'join_matchmaking').length
  const sSentBefore = s.sent.length
  s.disconnect()
  await sleep(1_500)
  const searchMsgDuring = await s.page.evaluate(`document.body.textContent.includes('Търсенето на маса беше прекъснато. Можете да опитате отново.')`) as boolean
  s.reconnect()
  const sRecovered = await waitFor(s.page, `!document.querySelector('${BANNER}')`, 15_000)
  await sleep(1_500)
  const searchMsgAfter = await s.page.evaluate(`document.body.textContent.includes('Търсенето на маса беше прекъснато. Можете да опитате отново.')`) as boolean
  await check('[E8] [desktop] Прекъснато търсене: спира със съобщение, не се подновява автоматично, без reload', async () => {
    assert(sentJoin === 1, `join_matchmaking: ${sentJoin}`)
    assert(searchMsgDuring && searchMsgAfter, `съобщение: по време=${searchMsgDuring} след=${searchMsgAfter}`)
    assert(sRecovered, 'възстановяване')
    assert(!s.sent.slice(sSentBefore).some((f) => f.type === 'join_matchmaking'), 'автоматично подновяване')
    assert(await isVisible(s.page, '[data-lobby-stake-card="5000"]'), 'лобито със залозите')
    assert((await getMarker(s.page)) === sMarker && s.offlineReloads.length === 0, 'reload')
  })

  // ─── [E11] health: интервал при работещ WS ─────────────────────────────
  const sHealthBefore = s.health.at.length
  await sleep(31_500)
  const sHealthIdle = s.health.at.length - sHealthBefore

  // ─── [E9] Сменена сесия (logout от друго място) ────────────────────────
  const lo = await openControlled('desktop', loggedOut, DESKTOP)
  all.push(lo)
  const logoutRes = await fetch(`${h.backendOrigin}/api/auth/logout`, { method: 'POST', headers: { Cookie: `belot_session=${loggedOut.cookie}` } })
  const loReloaded = await waitFor(lo.page, `location.search === '' && document.readyState === 'complete' && !window.__e2ePageMarker`, 20_000)
  await sleep(12_000)
  await check('[E9] [desktop] Невалидна сесия след прекъсването (logout от друго място): reload via=session, точно един, без цикъл', async () => {
    assert(logoutRes.ok, `logout: ${logoutRes.status}`)
    assert(lo.offlineReloads.length === 1 && lo.offlineReloads[0]!.includes('via=session'), `reload-и: ${lo.offlineReloads.join(', ')}`)
    assert(loReloaded, 'страницата не се презареди')
    assert(await isVisible(lo.page, LOBBY_READY), 'лобито след reload')
  })

  // ─── [E10] Рестарт на backend (desktop + mobile) ───────────────────────
  const rd = await openControlled('desktop', restartDesk, DESKTOP)
  const rm = await openControlled('mobile', restartMob, MOBILE)
  all.push(rd, rm)
  await h.restartServer()
  const rdReloaded = await waitFor(rd.page, `document.readyState === 'complete' && !!document.querySelector('${LOBBY_READY}')`, 30_000)
  await sleep(15_000)
  const bootstrapRecoveries = [rd, rm].map((p) => p.offlineReloads.filter((url) => url.includes('recoveryReload=')).length)
  if (bootstrapRecoveries.some((n) => n > 0)) console.log(`  INFO  [E10] еднократна защита при зареждане (index.html, #app празен 5 s) след reload-а: desktop=${bootstrapRecoveries[0]} mobile=${bootstrapRecoveries[1]}`)
  await check('[E10] Рестарт на backend: reload via=restart (desktop и mobile), точно един от reconnect логиката, без цикъл; лобито работи', async () => {
    for (const p of [rd, rm]) {
      const reconnectReloads = p.offlineReloads.filter((url) => !url.includes('recoveryReload='))
      const recoveries = p.offlineReloads.filter((url) => url.includes('recoveryReload='))
      assert(reconnectReloads.length === 1 && reconnectReloads[0]!.includes('via=restart'), `${p.label}: ${p.offlineReloads.join(', ')}`)
      assert(recoveries.length <= 1, `${p.label}: повече от една защита при зареждане: ${recoveries.join(', ')}`)
      assert(await isVisible(p.page, LOBBY_READY), `${p.label}: лобито`)
      assert(!(await isVisible(p.page, OVERLAY)) && !(await isVisible(p.page, BANNER)), `${p.label}: екран/лента остана`)
    }
    assert(rdReloaded, 'desktop reload')
  })

  await check('[E11] Health: без застъпващи се заявки; при работещ WS ~30 s интервал; без грешки в конзолата', async () => {
    for (const p of all) assert(p.health.maxConcurrent <= 1, `${p.label}: едновременно ${p.health.maxConcurrent}`)
    assert(sHealthIdle >= 1 && sHealthIdle <= 2, `за 31.5 s при работещ WS: ${sHealthIdle}`)
    const errors = all.flatMap((p) => p.errors.map((e) => `${p.label}: ${e}`))
    assert(errors.length === 0, errors.join(' | '))
  })

  void c3
  void c4
} catch (error) {
  console.error('  FAIL  setup:', error instanceof Error ? error.stack ?? error.message : String(error))
  console.error(h.serverOutput().slice(-1500))
  exitCode = 1
} finally {
  await h.close()
  fakeTwirp.close()
}
if (exitCode !== 0) process.exit(exitCode)
finishAndExit()
