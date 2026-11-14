/**
 * checkVoiceSpeakPreviewE2E.ts — Гласов чат: сървърното решение за говорене
 * ПРЕДИ включване стига до прозореца през съществуващите WS snapshot-и.
 *
 * Реален сървър (изолирано копие + празна SQLite база, никога реалната), реален
 * Vite dev server с истинския src/main.ts, реален Chromium, реални кликове
 * (scripts/giftBackTestHarness.ts). Режим „Само админ“, „Ръчен старт“.
 * Никой не се включва в гласа (без presence/токен) — проверява се само
 * решението преди включване.
 *
 *   [P1] private_room_updated към седнал играч носи voiceSpeak само със
 *        canSpeak/blockedReason/mutedUntil (без други лични данни);
 *   [P2] изтекъл VIP + придобито при сядането право -> след refresh и връщане
 *        на същата маса прозорецът е „Включи микрофона“ (а /api/vip/status
 *        казва „без VIP“);
 *   [P3] административен мют на живо (преди включване) -> прозорецът става
 *        „само слушай“ без „Вземи VIP“; махане на мюта -> обратно; известие
 *        само до наказания;
 *   [P4] мют, наложен докато връзката е прекъсната -> след тихо reconnect (без reload, същата маса)
 *        прозорецът показва мюта (решението идва с resync snapshot-а);
 *   [P5] в играта room_snapshot носи собственото решение на всеки играч;
 *   [P6] без включване и без нови заявки: 0 voice_presence, 0 /api/voice/*.
 *
 *   node server/node_modules/tsx/dist/cli.mjs scripts/checkVoiceSpeakPreviewE2E.ts
 */

import { randomUUID } from 'node:crypto'
import type { BrowserContext, Page, WebSocketRoute } from 'playwright'
import { assert, check, finishAndExit, sleep, startGiftBackHarness, type OpenedPage, type TestProfile } from './giftBackTestHarness'

console.log('\ncheckVoiceSpeakPreviewE2E\n')

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
const PROMPT = '[data-voice-prompt-layer="1"] [data-voice-prompt-offer]'
const LOBBY_READY = '[data-lobby-private-rooms-card="1"]'
const SPEAK_KEYS = '["blockedReason","canSpeak","mutedUntil"]'

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
async function api(p: TestProfile, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${h.backendOrigin}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Cookie: `belot_session=${p.cookie}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return res.json()
}

// Скриптовете в браузъра са низове: tsx/esbuild добавя __name(...) към именуваните функции.
async function promptState(page: Page): Promise<{ offer: string | null; mic: boolean; listen: boolean; vip: boolean }> {
  return page.evaluate(`(() => {
    const el = document.querySelector('[data-voice-prompt-layer="1"] [data-voice-prompt-offer]')
    const q = (a) => !!(el && el.querySelector('[data-voice-action="' + a + '"]'))
    return { offer: el ? el.getAttribute('data-voice-prompt-offer') : null, mic: q('join-mic'), listen: q('join-listen'), vip: q('get-vip') }
  })()`) as Promise<{ offer: string | null; mic: boolean; listen: boolean; vip: boolean }>
}
async function waitOffer(page: Page, offer: string, timeoutMs = 15_000): Promise<void> {
  await page.waitForFunction(`(() => document.querySelector('[data-voice-prompt-layer="1"] [data-voice-prompt-offer="${offer}"]') !== null)()`, null, { timeout: timeoutMs })
}

async function joinRoom(page: Page, roomId: string): Promise<void> {
  await page.locator(LOBBY_READY).first().click()
  const plus = page.locator(`[data-private-room-list-slot-join^="${roomId}:"]`).first()
  await plus.waitFor({ state: 'visible', timeout: 15_000 })
  await plus.click()
  await page.locator('[data-private-room-join-popup-confirm="1"]').waitFor({ state: 'visible', timeout: 5_000 })
  await page.locator('[data-private-room-join-popup-confirm="1"]').click()
}

type Frame = { type: string; data: any }
type WsControlledPage = {
  page: Page
  context: BrowserContext
  received: Frame[]
  sent: Frame[]
  /** Прекъсва връзката и не пуска нови, докато не се извика reconnect(). */
  disconnect: () => void
  reconnect: () => void
}

/** Като harness.openPage, но с WebSocket през route — за реално прекъсване/възстановяване. */
async function openWsControlledPage(profile: TestProfile, viewport: { width: number; height: number }): Promise<WsControlledPage> {
  const context = await h.browser.newContext({ viewport })
  await context.addCookies([{ name: 'belot_session', value: profile.cookie, url: h.backendOrigin }])
  await context.addInitScript(`try { localStorage.setItem('pika-consent-v2', JSON.stringify({ version: 2, necessary: true, analytics: false, marketing: false, updatedAt: new Date().toISOString() })) } catch {}`)
  const received: Frame[] = []
  const sent: Frame[] = []
  let blocked = false
  let current: { page: WebSocketRoute; server: WebSocketRoute } | null = null
  const parse = (m: string | Buffer): Frame | null => {
    try {
      const data = JSON.parse(typeof m === 'string' ? m : m.toString('utf8'))
      return { type: String(data?.type ?? ''), data }
    } catch {
      return null
    }
  }
  await context.routeWebSocket(/\/ws(\?.*)?$/, (ws) => {
    if (blocked) {
      ws.close({ code: 4000, reason: 'e2e offline' })
      return
    }
    const server = ws.connectToServer()
    ws.onMessage((m) => { const f = parse(m); if (f) sent.push(f); server.send(m) })
    server.onMessage((m) => { const f = parse(m); if (f) received.push(f); ws.send(m) })
    ws.onClose(() => server.close())
    server.onClose(() => ws.close())
    current = { page: ws, server }
  })
  const page = await context.newPage()
  await page.goto(`${h.appOrigin}/lobby`)
  await page.locator(LOBBY_READY).first().waitFor({ state: 'attached', timeout: 25_000 })
  await page.waitForTimeout(800)
  return {
    page, context, received, sent,
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

const voiceSpeakFrames = (frames: Frame[], type: 'private_room_updated' | 'room_snapshot') =>
  frames.filter((f) => f.type === type && f.data && 'voiceSpeak' in f.data)

let exitCode = 0
const voiceHttp: string[] = []
try {
  const creator = await h.register('spa')
  const vipExpiring = await h.register('spb')
  const vipMuted = await h.register('spc')
  const plainReconnect = await h.register('spd')
  for (const p of [creator, vipExpiring, vipMuted, plainReconnect]) h.setBalance(p.profileId, 50_000_000)
  makeFullAdmin(creator.profileId)
  setVip(creator.profileId, 30)
  setVip(vipExpiring.profileId, 30)
  setVip(vipMuted.profileId, 30)
  setVoiceModeAdminOnly(creator.profileId)

  // ─── Създател (desktop) ─────────────────────────────────────────────────
  const a = await h.openPage(creator, DESKTOP, '/lobby', LOBBY_READY)
  await a.page.locator(LOBBY_READY).first().click()
  await a.page.locator('[data-private-rooms-create-open="1"]').first().click()
  const voiceCheckbox = a.page.locator('[data-private-room-create-form="1"] [data-private-room-voice-checkbox="1"]')
  await voiceCheckbox.waitFor({ state: 'visible', timeout: 15_000 })
  await voiceCheckbox.check()
  await a.page.locator('[data-private-room-create-form="1"] input[name="manualStart"]').check()
  await a.page.locator('[data-private-room-create-form="1"] button[type="submit"]').click()
  await a.page.locator(PROMPT).waitFor({ state: 'visible', timeout: 25_000 })
  const roomId = a.wsReceived.find((f) => f.type === 'private_room_updated' && f.data?.room?.voiceTableId)?.data?.room?.id as string

  // ─── B: VIP при сядането (mobile) ──────────────────────────────────────
  const b = await h.openPage(vipExpiring, MOBILE, '/lobby', LOBBY_READY)
  for (const o of [a, b]) o.page.on('request', (req) => { if (req.url().includes('/api/voice/')) voiceHttp.push(req.url()) })
  await joinRoom(b.page, roomId)
  await waitOffer(b.page, 'speak', 25_000)

  await check('[P1] private_room_updated към седнал играч носи voiceSpeak само с canSpeak/blockedReason/mutedUntil', async () => {
    assert(roomId, 'гласова маса')
    for (const [label, frames] of [['създател', a.wsReceived], ['поканен', b.wsReceived]] as const) {
      const withSpeak = voiceSpeakFrames(frames as Frame[], 'private_room_updated')
      assert(withSpeak.length > 0, `${label}: voiceSpeak липсва`)
      for (const f of withSpeak) {
        assert(JSON.stringify(Object.keys(f.data.voiceSpeak).sort()) === SPEAK_KEYS, `${label}: ключове ${JSON.stringify(f.data.voiceSpeak)}`)
        assert(f.data.voiceSpeak.canSpeak === true && f.data.voiceSpeak.blockedReason === null, `${label}: решение`)
      }
    }
  })

  // ─── [P2] VIP изтича (придобитото право остава) -> refresh -> връщане ───
  setVip(vipExpiring.profileId, -1)
  const vipNow = await api(vipExpiring, '/api/vip/status')
  const bBefore = b.wsReceived.length
  await b.page.reload()
  await b.page.locator(LOBBY_READY).first().waitFor({ state: 'attached', timeout: 25_000 })
  await b.page.locator(LOBBY_READY).first().click()
  const enter = b.page.locator(`[data-private-room-list-enter="${roomId}"]`)
  await enter.waitFor({ state: 'visible', timeout: 15_000 })
  await enter.click()
  await b.page.locator(PROMPT).waitFor({ state: 'visible', timeout: 25_000 })

  await check('[P2] Изтекъл VIP + придобито право: след refresh и връщане на същата маса -> „Включи микрофона“, без „Вземи VIP“', async () => {
    assert(vipNow?.status?.isActive === false, `VIP статусът е изтекъл: ${JSON.stringify(vipNow?.status)}`)
    const resync = voiceSpeakFrames(b.wsReceived.slice(bBefore) as Frame[], 'private_room_updated')
    assert(resync.some((f) => f.data.voiceSpeak?.canSpeak === true), 'resync snapshot-ът носи canSpeak:true')
    const state = await promptState(b.page)
    assert(state.offer === 'speak' && state.mic && state.listen && !state.vip, JSON.stringify(state))
  })

  // ─── [P3] Мют на живо преди включване (desktop) ─────────────────────────
  const c = await h.openPage(vipMuted, DESKTOP, '/lobby', LOBBY_READY)
  c.page.on('request', (req) => { if (req.url().includes('/api/voice/')) voiceHttp.push(req.url()) })
  await joinRoom(c.page, roomId)
  await waitOffer(c.page, 'speak', 25_000)
  const bBeforeMute = b.wsReceived.length
  const muteRes = await api(creator, '/api/topics/profile-mute', { profileId: vipMuted.profileId, reason: 'e2e voice preview', durationMs: 30 * 60 * 1000 })
  let mutedState: Awaited<ReturnType<typeof promptState>> | null = null
  let mutedOk = true
  try { await waitOffer(c.page, 'muted') } catch { mutedOk = false }
  mutedState = await promptState(c.page)
  const unmuteRes = await api(creator, '/api/topics/unmute', { profileId: vipMuted.profileId })
  let unmutedOk = true
  try { await waitOffer(c.page, 'speak') } catch { unmutedOk = false }

  await check('[P3] Административен мют преди включване: на живо „Само слушай“ без микрофон и без „Вземи VIP“; махането връща микрофона; другите не получават нищо', async () => {
    assert(muteRes?.ok === true, `мют: ${JSON.stringify(muteRes)}`)
    assert(mutedOk && mutedState?.offer === 'muted' && mutedState.listen && !mutedState.mic && !mutedState.vip, `мют: ${JSON.stringify(mutedState)}`)
    const pushes = c.wsReceived.filter((f) => f.type === 'voice_speak_access_updated')
    assert(pushes.some((f) => f.data.speak?.blockedReason === 'muted'), 'voice_speak_access_updated (мют)')
    assert(unmuteRes?.ok === true && unmutedOk, `махане: ${JSON.stringify(unmuteRes)}`)
    assert(!b.wsReceived.slice(bBeforeMute).some((f) => f.type === 'voice_speak_access_updated'), 'известие до друг играч')
  })

  // ─── [P4] Мют докато връзката е прекъсната -> reconnect (mobile) ────────
  const d = await openWsControlledPage(plainReconnect, MOBILE)
  d.page.on('request', (req) => { if (req.url().includes('/api/voice/')) voiceHttp.push(req.url()) })
  await joinRoom(d.page, roomId)
  await waitOffer(d.page, 'listen_vip', 25_000)
  d.disconnect()
  await sleep(1_500)
  const muteD = await api(creator, '/api/topics/profile-mute', { profileId: plainReconnect.profileId, reason: 'e2e voice preview', durationMs: 30 * 60 * 1000 })
  await sleep(1_000)
  const dBeforeReconnect = d.received.length
  await d.page.evaluate(`window.__e2ePageMarker = 'p4-kept'`)
  d.reconnect()
  // Кратко прекъсване в чакалнята -> тихо възстановяване (без reload): играчът
  // остава на същата маса, решението идва с resync snapshot-а.
  let dMutedOk = true
  try {
    const deadlineResync = Date.now() + 25_000
    while (Date.now() < deadlineResync && !voiceSpeakFrames(d.received.slice(dBeforeReconnect), 'private_room_updated').length) await sleep(250)
    await waitOffer(d.page, 'muted', 25_000)
    dMutedOk = (await d.page.evaluate(`window.__e2ePageMarker === 'p4-kept' && !!document.querySelector('[data-private-room-waiting-screen="1"]')`)) === true
  } catch { dMutedOk = false }

  await check('[P4] Мют по време на прекъсната връзка: след тихо reconnect (без reload, същата маса) прозорецът показва мюта (от resync snapshot-а), без „Вземи VIP“', async () => {
    assert(muteD?.ok === true, `мют: ${JSON.stringify(muteD)}`)
    const resync = voiceSpeakFrames(d.received.slice(dBeforeReconnect), 'private_room_updated')
    assert(resync.some((f) => f.data.voiceSpeak?.blockedReason === 'muted'), `resync: ${JSON.stringify(resync.map((f) => f.data.voiceSpeak))}`)
    const state = await promptState(d.page)
    assert(dMutedOk && state.offer === 'muted' && !state.mic && !state.vip, JSON.stringify(state))
  })

  // ─── [P5] Игра: room_snapshot носи собственото решение ──────────────────
  const aBeforeStart = a.wsReceived.length
  const dBeforeStart = d.received.length
  // Прозорецът за включване е модален — създателят първо го затваря („Не сега“).
  await a.page.locator('[data-voice-prompt-layer="1"] [data-voice-action="not-now"]').first().click()
  const start = a.page.locator('[data-private-room-manual-start="1"]')
  await start.waitFor({ state: 'visible', timeout: 15_000 })
  await a.page.waitForFunction(`(() => { const b = document.querySelector('[data-private-room-manual-start="1"]'); return b !== null && !b.disabled })()`, null, { timeout: 15_000 })
  await start.click()
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline && (voiceSpeakFrames(a.wsReceived.slice(aBeforeStart) as Frame[], 'room_snapshot').length === 0
    || voiceSpeakFrames(d.received.slice(dBeforeStart), 'room_snapshot').length === 0)) await sleep(250)

  await check('[P5] В играта room_snapshot носи собственото решение на всеки играч (създател: може; наказан: мют), само трите полета', async () => {
    const aSnaps = voiceSpeakFrames(a.wsReceived.slice(aBeforeStart) as Frame[], 'room_snapshot')
    const dSnaps = voiceSpeakFrames(d.received.slice(dBeforeStart), 'room_snapshot')
    assert(aSnaps.length > 0 && dSnaps.length > 0, `room_snapshot: a=${aSnaps.length} d=${dSnaps.length}`)
    assert(aSnaps.every((f) => f.data.voiceSpeak?.canSpeak === true && JSON.stringify(Object.keys(f.data.voiceSpeak).sort()) === SPEAK_KEYS), 'създател')
    assert(dSnaps.every((f) => f.data.voiceSpeak?.blockedReason === 'muted'), 'наказан')
  })

  await check('[P6] Без включване и без нови заявки: 0 voice_presence от играчите, 0 заявки към /api/voice/*', async () => {
    const presences = [...a.wsSent, ...b.wsSent, ...c.wsSent, ...d.sent].filter((f) => f.type === 'voice_presence')
    assert(presences.length === 0, `voice_presence: ${presences.length}`)
    const tokenLike = voiceHttp.filter((url) => !url.includes('/api/voice/create-option'))
    assert(tokenLike.length === 0, `заявки: ${tokenLike.join(', ')}`)
  })
} catch (error) {
  console.error('  FAIL  setup:', error instanceof Error ? error.message : String(error))
  console.error(h.serverOutput().slice(-1500))
  exitCode = 1
} finally {
  await h.close()
}
if (exitCode !== 0) process.exit(exitCode)
finishAndExit()
