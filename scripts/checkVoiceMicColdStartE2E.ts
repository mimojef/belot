/**
 * checkVoiceMicColdStartE2E.ts — първоначално включване на микрофона в
 * гласова маса при НОВООТВОРЕНА страница (cold start: нов браузърен контекст,
 * lazy зареждане на гласовия модул), desktop и mobile:
 *
 *   [C1] desktop: създаване на гласова маса + „Включи микрофона“ при вече
 *        дадено разрешение, а пълен LiveKit SDK reconnect отменя ПЪРВОТО
 *        публикуване (наблюдаваното „Слушате“ + „Микрофонът не е достъпен“)
 *        -> микрофонът се включва след възстановяването, без съобщение,
 *        без втори getUserMedia, един capture, един публикуван микрофон;
 *   [C2] mobile: присъединяване чрез покана + „Включи микрофона“ при забавено
 *        разрешение (3 s), докато LiveKit връзката пада -> микрофонът се
 *        включва в новата сесия, без съобщение и без незатворен capture;
 *   [C3a] напускане на масата -> гласът спира, няма активен capture и
 *        публикуван микрофон.
 *
 * Реален сървър (изолирано копие), реален Vite + Chromium; само LiveKit
 * адаптерът е тестова подмяна (scripts/fixtures/fakeLiveKitVoiceAdapter.ts,
 * window.__fakeLiveKitControl). Режим „Само админ“.
 *
 *   node server/node_modules/tsx/dist/cli.mjs scripts/checkVoiceMicColdStartE2E.ts
 */

import { randomUUID } from 'node:crypto'
import { createServer as createHttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import type { Page, WebSocketRoute } from 'playwright'
import { assert, check, finishAndExit, sleep, startGiftBackHarness, type TestProfile } from './giftBackTestHarness'

console.log('\ncheckVoiceMicColdStartE2E\n')

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
process.env.LIVEKIT_API_URL = `http://127.0.0.1:${(fakeTwirp.address() as AddressInfo).port}`
process.env.LIVEKIT_WS_URL = 'ws://127.0.0.1:9'
process.env.LIVEKIT_API_KEY = 'e2e-test-only'
process.env.LIVEKIT_API_SECRET = 'e2e-test-only-not-a-real-secret-0000000000'
process.env.VOICE_ROOM_NAMESPACE = 'e2etest'
delete process.env.VOICE_CHAT_ENABLED

const FAKE_ADAPTER = join(process.cwd(), 'scripts', 'fixtures', 'fakeLiveKitVoiceAdapter.ts')
const h = await startGiftBackHarness({
  databaseFileName: 'belot-v2-tournament-test.sqlite',
  env: {
    NODE_ENV: 'development',
    BELOT_LOCAL_TOURNAMENT_TEST_MODE: '1',
  },
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

type Frame = { at: number; type: string; data: any }
type Party = { label: string; profile: TestProfile; page: Page; received: Frame[]; inject: (m: unknown) => void }
type Control = { gumDelayMs?: number; dropDuringGum?: boolean; cancelFirstPublish?: boolean }
type VoiceState = {
  status: string
  microphone: string
  uiError: string | null
  trace: string[]
  stats: { connects: number; disconnects: number; activeRooms: number; getUserMediaCalls: number; publishes: number; cancelledPublishes: number; liveCaptures: number; publishedMics: number } | null
}

async function register(tag: string): Promise<TestProfile> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const p = await h.register(attempt === 0 ? tag : `${tag}${attempt}`)
      h.setBalance(p.profileId, 50_000_000)
      return p
    } catch (error) {
      if (attempt >= 3 || !(error instanceof Error) || !error.message.includes('fetch failed')) throw error
      await sleep(500)
    }
  }
}

function befriend(a: TestProfile, b: TestProfile): void {
  const [lower, higher] = a.profileId < b.profileId ? [a.profileId, b.profileId] : [b.profileId, a.profileId]
  h.db.prepare(`INSERT INTO profile_friendships (friendship_id, requester_profile_id, addressee_profile_id, lower_profile_id, higher_profile_id, status, responded_at) VALUES (?, ?, ?, ?, ?, 'accepted', CURRENT_TIMESTAMP)`).run(randomUUID(), a.profileId, b.profileId, lower, higher)
}

/** Нов браузърен контекст = новоотворена страница (cold start на гласовия модул). */
async function openParty(label: string, profile: TestProfile, viewport: { width: number; height: number }, control: Control): Promise<Party> {
  const context = await h.browser.newContext(viewport === MOBILE ? { viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : { viewport })
  await context.addCookies([{ name: 'belot_session', value: profile.cookie, url: h.backendOrigin }])
  await context.addInitScript(`try { localStorage.setItem('pika-consent-v2', JSON.stringify({ version: 2, necessary: true, analytics: false, marketing: false, updatedAt: new Date().toISOString() })) } catch {}`)
  await context.addInitScript(`window.__fakeLiveKitControl = ${JSON.stringify(control)}`)
  // Проследяване на статуса (за „Възстановяване…“) без polling на страницата.
  await context.addInitScript(`(() => {
    window.__voiceTrace = [];
    const hook = () => {
      const v = window.__pikaVoice;
      if (!v) return setTimeout(hook, 50);
      let last = '';
      v.subscribe((s) => { const k = s.status + '/' + s.microphone; if (k !== last) { last = k; window.__voiceTrace.push(k) } });
    };
    hook();
  })()`)
  const received: Frame[] = []
  let current: WebSocketRoute | null = null
  await context.routeWebSocket(/\/ws(\?.*)?$/, (ws) => {
    const server = ws.connectToServer()
    ws.onMessage((m) => server.send(m))
    server.onMessage((m) => {
      try { const d = JSON.parse(typeof m === 'string' ? m : m.toString('utf8')); received.push({ at: Date.now(), type: String(d?.type ?? ''), data: d }) } catch { /* not JSON */ }
      ws.send(m)
    })
    ws.onClose(() => server.close())
    server.onClose(() => ws.close())
    current = server
  })
  const page = await context.newPage()
  page.on('pageerror', (error) => console.error(`    [pageerror ${label}] ${error.message}`))
  await page.goto(`${h.appOrigin}/lobby`)
  await page.locator(LOBBY_READY).first().waitFor({ state: 'attached', timeout: 25_000 })
  await page.waitForTimeout(800)
  return { label, profile, page, received, inject: (m) => current?.send(JSON.stringify(m)) }
}

const voiceState = (p: Page) => p.evaluate(`(() => {
  const v = window.__pikaVoice; const s = v ? v.getSnapshot() : null
  const f = window.__fakeLiveKit || null
  return {
    status: s ? s.status : 'none', microphone: s ? s.microphone : 'none',
    uiError: s && s.uiError ? s.uiError.code : null,
    trace: [...(window.__voiceTrace || [])],
    stats: f ? { connects: f.connects, disconnects: f.disconnects, activeRooms: f.activeRooms, getUserMediaCalls: f.getUserMediaCalls, publishes: f.publishes, cancelledPublishes: f.cancelledPublishes, liveCaptures: f.liveCaptures, publishedMics: f.publishedMics } : null,
  }
})()`) as Promise<VoiceState>

/** Свежи броячи на адаптера (liveCaptures/publishedMics се преизчисляват при четене). */
const refreshStats = (p: Page) => p.evaluate(`(() => { const v = window.__pikaVoice; if (v) v.getSnapshot(); return true })()`)

async function waitUntil<T>(label: string, fn: () => T | null | undefined | false | Promise<T | null | undefined | false>, timeoutMs: number, intervalMs = 250): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value as T
    await sleep(intervalMs)
  }
  throw new Error(`timeout: ${label}`)
}

async function createVoiceTable(p: Party, options: { locked?: boolean } = {}): Promise<string> {
  await p.page.locator(LOBBY_READY).first().click()
  await p.page.locator('[data-private-rooms-create-open="1"]').first().click()
  const voiceCheckbox = p.page.locator('[data-private-room-create-form="1"] [data-private-room-voice-checkbox="1"]')
  await voiceCheckbox.waitFor({ state: 'visible', timeout: 15_000 })
  await voiceCheckbox.check()
  await p.page.locator('[data-private-room-create-form="1"] input[name="manualStart"]').check()
  // Заключена маса — само с покана (поканите работят само там).
  if (options.locked === true) await p.page.locator('[data-private-room-create-form="1"] input[name="isLocked"]').check()
  await p.page.locator('[data-private-room-create-form="1"] button[type="submit"]').click()
  await p.page.locator(WAITING).waitFor({ state: 'visible', timeout: 20_000 })
  return [...p.received].reverse().find((f) => f.type === 'private_room_updated')?.data.room.id as string
}

function assertCleanLive(label: string, v: VoiceState): void {
  assert(v.microphone === 'live', `${label}: микрофонът е ${v.microphone} (trace ${v.trace.join(' -> ')})`)
  assert(v.uiError === null, `${label}: съобщение ${v.uiError}`)
  assert(v.stats !== null, `${label}: няма броячи на адаптера`)
  assert(v.stats!.getUserMediaCalls === 1, `${label}: getUserMedia ${v.stats!.getUserMediaCalls}`)
  assert(v.stats!.liveCaptures === 1, `${label}: активни capture-и ${v.stats!.liveCaptures}`)
  assert(v.stats!.publishedMics === 1, `${label}: публикувани микрофони ${v.stats!.publishedMics}`)
  assert(v.stats!.activeRooms === 1, `${label}: активни стаи ${v.stats!.activeRooms}`)
}

try {
  const [pA, pB] = [await register('mca'), await register('mcb')]
  const vipUntil = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 19).replace('T', ' ')
  for (const p of [pA, pB]) {
    h.db.prepare(`UPDATE accounts SET role = 'admin' WHERE account_id = (SELECT account_id FROM profiles WHERE profile_id = ?)`).run(p.profileId)
    h.db.prepare(`INSERT INTO vip_status (profile_id, active_until, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(profile_id) DO UPDATE SET active_until = excluded.active_until`).run(p.profileId, vipUntil)
  }
  h.db.prepare(`INSERT INTO voice_chat_admin_changes (change_id, setting, new_value, previous_value, changed_by_profile_id, changed_at) VALUES (?, 'mode', 'admin_only', 'off', ?, ?)`)
    .run(randomUUID(), pA.profileId, new Date().toISOString())
  befriend(pA, pB)

  // ─── [C1] desktop, cold start, вече дадено разрешение, отменено първо публикуване ──
  const A = await openParty('A', pA, DESKTOP, { gumDelayMs: 0, cancelFirstPublish: true })
  const roomId = await createVoiceTable(A, { locked: true })
  await A.page.locator('[data-voice-prompt-layer="1"] [data-voice-action="join-mic"]').first().click({ timeout: 25_000 })
  await waitUntil('A mic live', async () => (await voiceState(A.page)).microphone === 'live', 20_000).catch(() => undefined)
  await sleep(800)
  await refreshStats(A.page)
  await check('[C1] desktop cold start + вече дадено разрешение + SDK reconnect отменя първото публикуване -> микрофонът е включен, без „Микрофонът не е достъпен“, един capture', async () => {
    const a = await voiceState(A.page)
    assertCleanLive('C1', a)
    assert(a.stats!.cancelledPublishes === 1, `C1: отменени публикувания ${a.stats!.cancelledPublishes}`)
    assert(a.trace.some((t) => t.startsWith('reconnecting/')), `C1: няма „Възстановяване…“ в ${a.trace.join(' -> ')}`)
    assert(a.stats!.connects === 1 && a.stats!.disconnects === 0, `C1: LiveKit сесии ${JSON.stringify(a.stats)}`)
  })

  // ─── [C2] mobile, покана, забавено разрешение + загубена връзка ───────────
  const B = await openParty('B', pB, MOBILE, { gumDelayMs: 3_000, dropDuringGum: true })
  const bFrom = B.received.length
  A.inject({ type: 'invite_to_private_room', toProfiles: [{ profileId: pB.profileId, displayName: 'mcb' }] })
  await waitUntil('invite received', () => B.received.slice(bFrom).some((f) => f.type === 'private_room_invite_received'), 10_000)
  await B.page.locator('[data-private-room-invite-accept]').first().click({ timeout: 10_000 })
  const room = [...A.received].reverse().find((f) => f.type === 'private_room_updated' && f.data.room?.id === roomId)?.data.room
  const aTeam = room?.slots?.find((s: any) => s.occupant?.profileId === pA.profileId)?.team === 'B' ? 'B' : 'A'
  const otherTeam = aTeam === 'A' ? 'B' : 'A'
  const slot = B.page.locator(`[data-private-room-slot-join^="${otherTeam}:"]`).first()
  await slot.waitFor({ state: 'visible', timeout: 15_000 })
  await slot.click()
  await B.page.locator('[data-private-room-join-popup-confirm="1"]').click({ timeout: 5_000 })
  await B.page.locator(WAITING).waitFor({ state: 'visible', timeout: 15_000 })
  await B.page.locator('[data-voice-prompt-layer="1"] [data-voice-action="join-mic"]').first().click({ timeout: 25_000 })
  await waitUntil('B mic live', async () => (await voiceState(B.page)).microphone === 'live', 30_000).catch(() => undefined)
  await sleep(800)
  await refreshStats(B.page)
  await check('[C2] mobile: покана + забавено разрешение + загубена LiveKit връзка по време на разрешението -> микрофонът е включен в новата сесия, един capture', async () => {
    const b = await voiceState(B.page)
    assertCleanLive('C2', b)
    assert(b.stats!.connects === 2 && b.stats!.disconnects === 1, `C2: очаквана нова сесия ${JSON.stringify(b.stats)}`)
  })

  // ─── [C3] същият таб (warm): напускане + ново създаване -> веднага включен ──
  const aFrom = A.received.length
  A.inject({ type: 'leave_private_room' })
  await waitUntil('A left', () => A.received.slice(aFrom).some((f) => f.type === 'private_room_left' || (f.type === 'private_room_updated' && f.data.room?.id === roomId && !f.data.room.slots?.some((s: any) => s.occupant?.profileId === pA.profileId))), 10_000).catch(() => undefined)
  await waitUntil('A voice stopped', async () => (await voiceState(A.page)).stats?.activeRooms === 0, 15_000).catch(() => undefined)
  await refreshStats(A.page)
  const afterLeave = await voiceState(A.page)
  await check('[C3a] след напускане на масата: гласът е спрян, няма активен capture и публикуван микрофон', async () => {
    assert(afterLeave.stats !== null && afterLeave.stats.liveCaptures === 0 && afterLeave.stats.publishedMics === 0 && afterLeave.stats.activeRooms === 0, `C3a: ${JSON.stringify(afterLeave.stats)}`)
  })
} catch (error) {
  console.error('  FAIL  неочаквана грешка:', error instanceof Error ? error.stack : error)
  await check('без неочаквани грешки', () => { throw error })
} finally {
  await h.close()
  fakeTwirp.close()
}

finishAndExit()
