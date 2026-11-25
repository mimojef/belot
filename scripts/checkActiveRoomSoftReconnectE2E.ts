/**
 * checkActiveRoomSoftReconnectE2E.ts — Етап 2: тихо възстановяване на
 * игровия WS по време на активен Belot мач (без презареждане).
 *
 * Реален сървър (изолирано копие, local tournament test mode — само по-бързи
 * ботове/срокове), реален Vite + src/main.ts, реален Chromium. Прекъсването е
 * реално затваряне на WS (context.routeWebSocket). Само LiveKit адаптерът е
 * тестова подмяна (scripts/fixtures/fakeLiveKitVoiceAdapter.ts). Играчът
 * играе реално през UI (цепене, „Пас“, карта). Само в изолираното копие:
 * случайната маса е до 60 т. (фаза 1) / 1 т. (фаза 2) и dev endpoint-ът за
 * тестов турнир записва съществуващи профили.
 *
 *   Фаза 1 (desktop P, mobile M):
 *   [R1] прекъсване веднага след обява „Пас“: без повторно изпращане, обявата
 *        е приета точно веднъж, без reload/цял екран, масата видима;
 *   [R2] прекъсване веднага след изиграна карта: без повторно изпращане,
 *        картата не е в ръката, без reload;
 *   [R3] по-дълго прекъсване (ход изтича -> бот; ново раздаване): актуалното
 *        състояние, „Върни се“ връща управлението;
 *   [R4] mobile: 4 поредни кратки прекъсвания — без reload, 4 нови връзки;
 *   Фаза 2:
 *   [R5] гласова маса в игра: LiveKit не се прекъсва, presence след
 *        room_resumed по новата връзка;
 *   [R6] мачът приключва през прекъсването -> екранът за край; [R7] повторен
 *        мач работи нормално след това;
 *   [R8] друго устройство: без изместване; досегашният изричен избор;
 *   [R9] започнал турнир + заместващ бот през прекъсването: тихо в
 *        обикновения мач, session_in_game погълнат, съществуващото известие;
 *   [R10] mobile: турнирен мач — тихо възстановяване в турнирната стая.
 *
 *   node server/node_modules/tsx/dist/cli.mjs scripts/checkActiveRoomSoftReconnectE2E.ts
 */

import { randomUUID } from 'node:crypto'
import { createServer as createHttpServer } from 'node:http'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserContext, Page, WebSocketRoute } from 'playwright'
import { assert, check, finishAndExit, sleep, startGiftBackHarness, type GiftBackHarness, type ServerSourcePatch, type TestProfile } from './giftBackTestHarness'

console.log('\ncheckActiveRoomSoftReconnectE2E\n')

const { WebSocket } = createRequire(join(process.cwd(), 'server', 'package.json'))('ws') as typeof import('ws')
type RawWs = InstanceType<typeof WebSocket>

// Локален фалшив LiveKit Twirp (само loopback) + изхвърляеми фиктивни ключове.
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
const DESKTOP = { width: 1366, height: 900 }
const MOBILE = { width: 390, height: 844 }
const LOBBY_READY = '[data-lobby-private-rooms-card="1"]'
const ROOM_BANNER = '[data-active-room-connection-banner="1"]'
const OVERLAY = '[data-offline-overlay="1"]'
const SESSION_OVERLAY = '[data-session-rejoin="1"]'
const screenshotsDir = join(tmpdir(), 'active-room-soft-reconnect-e2e')

const randomTableTarget = (points: number): ServerSourcePatch => ({
  file: 'index.ts',
  find: "activityCounters.incrementRooms('matchmakingMatchFound')\n\n    const initializedRoom = initializeRoomAuthoritativeGameState(result.room)",
  replace: `activityCounters.incrementRooms('matchmakingMatchFound')\n\n    const initializedRoom = initializeRoomAuthoritativeGameState({ ...result.room, config: { ...result.room.config, targetScore: ${points} } })`,
})
const EXISTING_HUMANS_PATCHES: ServerSourcePatch[] = [
  {
    file: 'localTournamentTest/localTournamentTestService.ts',
    find: "const humanSlotCount = input.mode === 'all_bots' ? 0 : input.mode === 'two_humans' ? 2 : 1",
    replace: "const existingHumanProfileIds: string[] = (input as { existingHumanProfileIds?: string[] }).existingHumanProfileIds ?? []\n    const humanSlotCount = input.mode === 'all_bots' ? 0 : input.mode === 'two_humans' ? 2 : Math.max(1, existingHumanProfileIds.length)",
  },
  {
    file: 'localTournamentTest/localTournamentTestService.ts',
    find: 'humanCredentials.push(ensureTestHumanAccount(runId, String(i + 1)))',
    replace: "humanCredentials.push(existingHumanProfileIds[i] !== undefined ? { email: '', password: '', displayName: '', profileId: existingHumanProfileIds[i]! } : ensureTestHumanAccount(runId, String(i + 1)))",
  },
  {
    file: 'localTournamentTest/handleLocalTournamentTestRequest.ts',
    find: 'const input = parseCreateInput(rawBody)',
    replace: 'const input = parseCreateInput(rawBody)\n    if (input !== null) (input as { existingHumanProfileIds?: unknown }).existingHumanProfileIds = (rawBody as { existingHumanProfileIds?: unknown } | null)?.existingHumanProfileIds',
  },
]

async function startHarness(targetPoints: number): Promise<GiftBackHarness> {
  const h = await startGiftBackHarness({
    patchServerSource: [randomTableTarget(targetPoints), ...EXISTING_HUMANS_PATCHES],
    databaseFileName: 'belot-v2-tournament-test.sqlite',
    env: {
      NODE_ENV: 'development',
      BELOT_LOCAL_TOURNAMENT_TEST_MODE: '1',
      BELOT_LOCAL_TOURNAMENT_ATTENDANCE_MS: '8000',
      BELOT_LOCAL_TOURNAMENT_TRANSITION_MS: '8000',
      BELOT_LOCAL_BOT_ACTION_MIN_MS: '60',
      BELOT_LOCAL_BOT_ACTION_MAX_MS: '120',
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
  h.db.prepare(`INSERT INTO admin_settings (setting_key, setting_value) VALUES ('belot_random_table_wait_seconds', '20') ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value`).run()
  await h.restartServer()
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try { if ((await fetch(`${h.backendOrigin}/health`)).ok) break } catch { /* стара keep-alive връзка */ }
    await sleep(300)
  }
  return h
}

async function register(h: GiftBackHarness, tag: string): Promise<TestProfile> {
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

type Frame = { at: number; type: string; data: any }
type Controlled = {
  label: string
  profile: TestProfile
  page: Page
  context: BrowserContext
  received: Frame[]
  sent: Frame[]
  offlineReloads: string[]
  errors: string[]
  wsOpened: () => number
  inject: (m: unknown) => void
  disconnect: () => void
  reconnect: () => void
  /** Еднократно: затваря връзката веднага след изпращане на съобщение от този тип. */
  armDropAfter: (type: string, reconnectAfterMs: number) => void
  /** Еднократно: задържа следващото съобщение от този тип към сървъра с ms (Етап 2). */
  delayNext: (type: string, ms: number) => void
  /**
   * Етапи 3–4: еднократно „поглъща“ следващото съобщение от този тип (не стига
   * до сървъра); когато страницата изостави тази връзка, сървърната ѝ страна
   * остава отворена (полуотворена, неприкрепена връзка за сървъра).
   */
  swallowNext: (type: string, count?: number) => void
  /**
   * Етап 4: следващото съобщение от този тип стига до сървъра, но отговорите
   * не стигат до страницата; след 400 ms връзката пада само откъм страницата
   * (сървърът я държи жива — полуотворена и прикрепена).
   */
  halfOpenAfterNext: (type: string) => void
  /** Етап 2: /api/auth/me заявки на страницата (започнати / завършени). */
  authMeStarted: () => number
  authMeFinished: () => number
}

async function openControlled(h: GiftBackHarness, label: string, profile: TestProfile, viewport: { width: number; height: number }): Promise<Controlled> {
  const context = await h.browser.newContext(viewport === MOBILE
    ? { viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }
    : { viewport })
  await context.addCookies([{ name: 'belot_session', value: profile.cookie, url: h.backendOrigin }])
  await context.addInitScript(`try { localStorage.setItem('pika-consent-v2', JSON.stringify({ version: 2, necessary: true, analytics: false, marketing: false, updatedAt: new Date().toISOString() })) } catch {}`)
  const received: Frame[] = []
  const sent: Frame[] = []
  let opened = 0
  let blocked = false
  let armed: { type: string; reconnectAfterMs: number } | null = null
  let delayed: { type: string; ms: number } | null = null
  let swallow: { type: string; count: number } | null = null
  let halfOpenAfterType: string | null = null
  let current: { page: WebSocketRoute; server: WebSocketRoute } | null = null
  const parse = (m: string | Buffer): Frame | null => {
    try {
      const data = JSON.parse(typeof m === 'string' ? m : m.toString('utf8'))
      return { at: Date.now(), type: String(data?.type ?? ''), data }
    } catch {
      return null
    }
  }
  const disconnect = (): void => {
    blocked = true
    const c = current
    current = null
    c?.server.close()
    c?.page.close({ code: 4001, reason: 'e2e drop' })
  }
  await context.routeWebSocket(/\/ws(\?.*)?$/, (ws) => {
    if (blocked) {
      ws.close({ code: 4000, reason: 'e2e offline' })
      return
    }
    opened += 1
    const server = ws.connectToServer()
    // Етапи 3–4: keepUpstream — при затваряне откъм страницата сървърната
    // връзка остава (полуотворена); blackhole — отговорите не стигат до страницата.
    const conn = { keepUpstream: false, blackhole: false, pageClosed: false }
    ws.onMessage((m) => {
      const f = parse(m)
      if (f) sent.push(f)
      if (f && swallow !== null && f.type === swallow.type) {
        swallow.count -= 1
        if (swallow.count <= 0) swallow = null
        conn.keepUpstream = true
        return
      }
      if (f && halfOpenAfterType !== null && f.type === halfOpenAfterType) {
        halfOpenAfterType = null
        conn.keepUpstream = true
        server.send(m)
        conn.blackhole = true
        setTimeout(() => { try { ws.close({ code: 4002, reason: 'e2e half-open' }) } catch { /* вече затворена */ } }, 400)
        return
      }
      if (f && delayed !== null && f.type === delayed.type) {
        const ms = delayed.ms
        delayed = null
        setTimeout(() => { try { server.send(m) } catch { /* затворена */ } }, ms)
        return
      }
      server.send(m)
      if (f && armed !== null && f.type === armed.type) {
        const reconnectAfterMs = armed.reconnectAfterMs
        armed = null
        // Съобщението вече е предадено; връзката пада веднага след него.
        setTimeout(() => {
          disconnect()
          setTimeout(() => { blocked = false }, reconnectAfterMs)
        }, 0)
      }
    })
    server.onMessage((m) => {
      if (conn.blackhole || conn.pageClosed) return
      const f = parse(m)
      if (f) received.push(f)
      try { ws.send(m) } catch { /* страницата е затворена */ }
    })
    ws.onClose(() => { conn.pageClosed = true; if (!conn.keepUpstream) server.close() })
    server.onClose(() => { try { ws.close() } catch { /* вече затворена */ } })
    current = { page: ws, server }
  })
  const page = await context.newPage()
  const offlineReloads: string[] = []
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('request', (req) => { if (req.url().includes('offlineReload=')) offlineReloads.push(req.url()) })
  let authMeStarted = 0
  let authMeFinished = 0
  page.on('request', (req) => { if (req.url().includes('/api/auth/me')) authMeStarted += 1 })
  page.on('requestfinished', (req) => { if (req.url().includes('/api/auth/me')) authMeFinished += 1 })
  await page.goto(`${h.appOrigin}/lobby`)
  await page.locator(LOBBY_READY).first().waitFor({ state: 'attached', timeout: 25_000 })
  await page.waitForTimeout(800)
  return {
    label, profile, page, context, received, sent, offlineReloads, errors,
    wsOpened: () => opened,
    inject: (m) => current?.server.send(JSON.stringify(m)),
    disconnect,
    reconnect() { blocked = false },
    armDropAfter(type, reconnectAfterMs) { armed = { type, reconnectAfterMs } },
    delayNext(type, ms) { delayed = { type, ms } },
    swallowNext(type, count = 1) { swallow = { type, count } },
    halfOpenAfterNext(type) { halfOpenAfterType = type },
    authMeStarted: () => authMeStarted,
    authMeFinished: () => authMeFinished,
  }
}

const setMarker = (p: Page) => p.evaluate(`window.__e2eMarker = 'kept-${randomUUID()}'; window.__e2eMarker`) as Promise<string>
const getMarker = (p: Page) => p.evaluate(`window.__e2eMarker || null`) as Promise<string | null>
const isVisible = (p: Page, selector: string) => p.evaluate(`!!document.querySelector('${selector}')`) as Promise<boolean>
const fakeLiveKit = (p: Page) => p.evaluate(`window.__fakeLiveKit || null`) as Promise<{ connects: number; disconnects: number; activeRooms: number } | null>
async function waitForExpr(p: Page, expression: string, timeoutMs: number): Promise<boolean> {
  try {
    await p.waitForFunction(expression, null, { timeout: timeoutMs })
    return true
  } catch {
    return false
  }
}
async function waitUntil<T>(label: string, fn: () => T | null | undefined | false | Promise<T | null | undefined | false>, timeoutMs: number, intervalMs = 250): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value as T
    await sleep(intervalMs)
  }
  throw new Error(`timeout: ${label}`)
}
const lastSnapshot = (c: Controlled, roomId: string) => [...c.received].reverse().find((f) => f.type === 'room_snapshot' && f.data.roomId === roomId)?.data ?? null
const mySeatOf = (snap: any) => snap?.yourSeat ?? null
const isMeBotControlled = (snap: any) => snap?.seats?.find((s: any) => s.seat === mySeatOf(snap))?.isControlledByBot === true

/**
 * Реална игра през UI: цепене, „Пас“, първа допустима карта (+ „Продължи“ при
 * обяви). paused=true спира автопилота.
 */
function startAutopilot(c: Controlled, roomId: string): { paused: boolean; stop: () => void } {
  const state = { paused: false, stop: () => { stopped = true } }
  let stopped = false
  let busy = false
  const tick = async (): Promise<void> => {
    if (stopped) return
    if (!busy && !state.paused) {
      busy = true
      try {
        const snap = lastSnapshot(c, roomId)
        const game = snap?.game
        if (game && !isMeBotControlled(snap)) {
          if (await isVisible(c.page, '[data-declaration-continue]')) {
            await c.page.locator('[data-declaration-continue]').first().click({ timeout: 800 }).catch(() => undefined)
          } else if (game.cutting?.canSubmitCut) {
            await c.page.locator('[data-active-room-cut-index]').first().click({ timeout: 800 }).catch(() => undefined)
          } else if (game.bidding?.canSubmitBid) {
            await c.page.locator('[data-bid-action="pass"]').first().click({ timeout: 800 }).catch(() => undefined)
          } else if (Array.isArray(game.playing?.validCardIds) && game.playing.validCardIds.length > 0) {
            await c.page.locator(`.play-hand-card--active[data-card-id="${game.playing.validCardIds[0]}"]`).first().dispatchEvent('click').catch(() => undefined)
          }
        }
      } catch {
        // страницата е затворена/презаредена — следващият tick
      } finally {
        busy = false
      }
    }
    if (!stopped) setTimeout(() => { void tick() }, 400)
  }
  void tick()
  return state
}

async function joinRandom(c: Controlled, stake: number): Promise<string> {
  const from = c.received.length
  c.inject({ type: 'join_matchmaking', stake })
  const found = await waitUntil(`${c.label} match_found`, () => c.received.slice(from).find((f) => f.type === 'match_found'), 50_000)
  return found.data.roomId as string
}
async function waitGame(c: Controlled, roomId: string): Promise<void> {
  await waitUntil(`${c.label} game snapshot`, () => lastSnapshot(c, roomId)?.game, 20_000)
  await c.page.locator('[data-active-room-cut-index], [data-bid-action], .play-hand-card, [data-seat-panel]').first().waitFor({ state: 'attached', timeout: 20_000 }).catch(() => undefined)
}

/** Резултат от едно тихо възстановяване. */
type DropOutcome = {
  roomBannerDuring: boolean
  overlayDuring: boolean
  recovered: boolean
  sentAfter: Frame[]
  receivedAfter: Frame[]
}
async function dropFor(c: Controlled, ms: number): Promise<DropOutcome> {
  const sentFrom = c.sent.length
  const receivedFrom = c.received.length
  c.disconnect()
  await sleep(Math.min(600, ms))
  const roomBannerDuring = await isVisible(c.page, ROOM_BANNER)
  await sleep(Math.max(0, ms - 600))
  const overlayDuring = await isVisible(c.page, OVERLAY)
  c.reconnect()
  const recovered = await waitForExpr(c.page, `!document.querySelector('${ROOM_BANNER}')`, 20_000)
  await sleep(500)
  return { roomBannerDuring, overlayDuring, recovered, sentAfter: c.sent.slice(sentFrom), receivedAfter: c.received.slice(receivedFrom) }
}
async function waitRecovered(c: Controlled, sentFrom: number): Promise<boolean> {
  const ok = await waitForExpr(c.page, `!document.querySelector('${ROOM_BANNER}')`, 25_000)
  return ok && c.sent.slice(sentFrom).some((f) => f.type === 'resume_room' && typeof f.data.reconnectOf === 'string')
}

await (await import('node:fs/promises')).mkdir(screenshotsDir, { recursive: true })

// ═══ Фаза 1 ═══════════════════════════════════════════════════════════════
// (SOFT_RECONNECT_E2E_PHASE=2 — само фаза 2, при отстраняване на грешки)
if (process.env.SOFT_RECONNECT_E2E_PHASE !== '2') {
  const h = await startHarness(60)
  try {
    const [pP, pM] = [await register(h, 'p'), await register(h, 'm')]
    const P = await openControlled(h, 'P', pP, DESKTOP)
    const M = await openControlled(h, 'M', pM, MOBILE)
    const [roomP, roomM] = await Promise.all([joinRandom(P, 5000), joinRandom(M, 8000)])
    await Promise.all([waitGame(P, roomP), waitGame(M, roomM)])
    const markerP = await setMarker(P.page)
    const markerM = await setMarker(M.page)
    const autoP = startAutopilot(P, roomP)
    const autoM = startAutopilot(M, roomM)

    // Етап 2: от тук до края на [R2] /api/auth/me на P НИКОГА не отговаря —
    // тихото възстановяване трябва да мине само по WS.
    await P.page.route('**/api/auth/me', () => { /* блокирана: без отговор */ })
    const authFinishedBeforeR1 = P.authMeFinished()
    const authStartedBeforeR1 = P.authMeStarted()

    // ── [R1] прекъсване веднага след „Пас“ ──
    await waitUntil('P bidding turn', () => lastSnapshot(P, roomP)?.game?.bidding?.canSubmitBid === true && !isMeBotControlled(lastSnapshot(P, roomP)), 90_000, 100)
    autoP.paused = true
    const r1SentFrom = P.sent.length
    P.armDropAfter('submit_bid_action', 2500)
    await P.page.locator('[data-bid-action="pass"]').first().click({ timeout: 5000 })
    await sleep(700)
    const r1BannerDuring = await isVisible(P.page, ROOM_BANNER)
    const r1OverlayDuring = await isVisible(P.page, OVERLAY)
    const r1Recovered = await waitRecovered(P, r1SentFrom)
    await sleep(500)
    await check('[R1] прекъсване веднага след обява: без повторно изпращане, обявата приета веднъж, без reload/цял екран', async () => {
      assert(r1BannerDuring && !r1OverlayDuring, `по време: банер=${r1BannerDuring} цял екран=${r1OverlayDuring}`)
      assert(r1Recovered, 'тихото възстановяване не завърши (resume_room с reconnectOf)')
      const bids = P.sent.slice(r1SentFrom).filter((f) => f.type === 'submit_bid_action').length
      assert(bids === 1, `submit_bid_action: ${bids}`)
      const snap = lastSnapshot(P, roomP)
      const mine = (snap?.game?.bidding?.entries ?? []).filter((e: any) => e.seat === mySeatOf(snap)).length
      assert(snap?.game?.authoritativePhase !== 'bidding' || mine <= 1, `обявите на P: ${mine}`)
      assert((await getMarker(P.page)) === markerP && P.offlineReloads.length === 0, `reload: ${P.offlineReloads.join(',')}`)
      assert(!(await isVisible(P.page, SESSION_OVERLAY)), 'прозорецът session_in_game се показа')
    })
    autoP.paused = false

    // ── [R2] прекъсване веднага след изиграна карта ──
    await waitUntil('P play turn', () => {
      const snap = lastSnapshot(P, roomP)
      return !isMeBotControlled(snap) && Array.isArray(snap?.game?.playing?.validCardIds) && snap.game.playing.validCardIds.length > 0
    }, 120_000, 100)
    autoP.paused = true
    await sleep(300)
    const r2SentFrom = P.sent.length
    P.armDropAfter('submit_play_card', 2500)
    const validCardId = lastSnapshot(P, roomP)?.game?.playing?.validCardIds?.[0] as string
    await P.page.locator(`.play-hand-card--active[data-card-id="${validCardId}"]`).first().waitFor({ state: 'attached', timeout: 5000 })
    await P.page.locator(`.play-hand-card--active[data-card-id="${validCardId}"]`).first().dispatchEvent('click')
    if (await waitForExpr(P.page, `!!document.querySelector('[data-declaration-continue]')`, 600)) {
      await P.page.locator('[data-declaration-continue]').first().click({ timeout: 2000 })
    }
    const playedFrame = await waitUntil('submit_play_card sent', () => P.sent.slice(r2SentFrom).find((f) => f.type === 'submit_play_card'), 5000)
    const r2Recovered = await waitRecovered(P, r2SentFrom)
    await sleep(800)
    await check('[R2] прекъсване веднага след карта: без повторно изпращане, картата не е в ръката, без reload', async () => {
      assert(r2Recovered, 'тихото възстановяване не завърши')
      const plays = P.sent.slice(r2SentFrom).filter((f) => f.type === 'submit_play_card').length
      assert(plays === 1, `submit_play_card: ${plays}`)
      const snap = lastSnapshot(P, roomP)
      assert(!(snap?.game?.ownHand ?? []).some((card: any) => card.id === playedFrame.data.cardId), 'картата е още в ръката')
      assert((await getMarker(P.page)) === markerP && P.offlineReloads.length === 0, 'reload')
      await P.page.screenshot({ path: join(screenshotsDir, 'R2-desktop-after-card-drop.png') })
    })
    await check('[R1-R2] Етап 2: възстановяване без отговор от /api/auth/me (блокирана); фоновата заявка се изпраща след него', async () => {
      assert(P.authMeFinished() === authFinishedBeforeR1, `/api/auth/me е завършила: ${P.authMeFinished() - authFinishedBeforeR1}`)
      assert(P.authMeStarted() > authStartedBeforeR1, 'фоновото /api/auth/me след възстановяването не е изпратено')
      assert(P.offlineReloads.length === 0, `reload: ${P.offlineReloads.join(',')}`)
    })
    await P.page.unroute('**/api/auth/me')

    // ── [R3] по-дълго прекъсване: ходът изтича -> бот; ново раздаване ──
    const before = lastSnapshot(P, roomP)
    const beforeKey = `${before?.game?.dealerSeat}|${JSON.stringify(before?.game?.score)}`
    const r3 = await dropFor(P, 40_000)
    const after = lastSnapshot(P, roomP)
    const afterKey = `${after?.game?.dealerSeat}|${JSON.stringify(after?.game?.score)}`
    await check('[R3] по-дълго прекъсване (ход изтича, ново раздаване): масата видима, актуално състояние, без reload', async () => {
      assert(r3.roomBannerDuring && !r3.overlayDuring && r3.recovered, JSON.stringify({ banner: r3.roomBannerDuring, overlay: r3.overlayDuring, recovered: r3.recovered }))
      assert(afterKey !== beforeKey, `раздаването не е сменено: ${beforeKey}`)
      assert(isMeBotControlled(after) || after?.roomStatus === 'finished', 'ботът не е поел управлението')
      assert((await getMarker(P.page)) === markerP && P.offlineReloads.length === 0, 'reload')
      assert(!(await isVisible(P.page, SESSION_OVERLAY)), 'session_in_game прозорец')
    })
    await check('[R3] поемане от бот: „Върни се“ след възстановяването връща управлението', async () => {
      if (after?.roomStatus === 'finished') return
      await P.page.locator('[data-bot-takeover-dismiss="1"]').waitFor({ state: 'visible', timeout: 10_000 })
      await P.page.locator('[data-bot-takeover-dismiss="1"]').click()
      await waitUntil('control returned', () => !isMeBotControlled(lastSnapshot(P, roomP)), 10_000)
    })
    autoP.paused = false

    // ── [R4] mobile: поредни кратки прекъсвания ──
    const openedBefore = M.wsOpened()
    const cycles: DropOutcome[] = []
    for (let i = 0; i < 4; i += 1) {
      cycles.push(await dropFor(M, 1_500))
      await sleep(1_500)
    }
    await check('[R4] mobile: 4 поредни кратки прекъсвания — всяко тихо, без reload, 4 нови връзки', async () => {
      assert(cycles.every((c) => c.roomBannerDuring && !c.overlayDuring && c.recovered), JSON.stringify(cycles.map((c) => [c.roomBannerDuring, c.overlayDuring, c.recovered])))
      assert(M.wsOpened() - openedBefore === 4, `нови връзки: ${M.wsOpened() - openedBefore}`)
      assert((await getMarker(M.page)) === markerM && M.offlineReloads.length === 0, 'reload')
      assert(cycles.every((c) => c.sentAfter.some((f) => f.type === 'resume_room' && typeof f.data.reconnectOf === 'string')), 'resume_room с reconnectOf')
      assert(!(await isVisible(M.page, SESSION_OVERLAY)), 'session_in_game прозорец')
      await M.page.screenshot({ path: join(screenshotsDir, 'R4-mobile-after-drops.png') })
    })
    // ── [R4b] Етап 1: без Ludo проба при тихо възстановяване; двата текста на банера ──
    await check('[R4b] тихо възстановяване на Белот: без ludo_game_state_request и без Ludo грешка; банерът — две състояния', async () => {
      // Контрола: в лобито (без маса) пробата се праща както досега.
      assert(M.sent.some((f) => f.type === 'ludo_game_state_request'), 'пробата липсва и при свързване в лобито')
      const probes = cycles.flatMap((c) => c.sentAfter).filter((f) => f.type === 'ludo_game_state_request').length
      assert(probes === 0, `Ludo проба при активна Белот маса: ${probes}`)
      const ludoErrors = cycles.flatMap((c) => c.receivedAfter).filter((f) => f.type === 'error' && f.data.code === 'ludo_match_not_found').length
      assert(ludoErrors === 0, `Ludo грешки към масата: ${ludoErrors}`)
      // Задържан resume_room -> видим прозорец „транспорт отворен, играта не е
      // синхронизирана“ (Етап 2: сесията вече не се чака по HTTP).
      M.disconnect()
      await sleep(600)
      const textDown = await M.page.evaluate(`document.querySelector('${ROOM_BANNER}')?.textContent ?? null`)
      assert(textDown === 'Връзката със сървъра се възстановява...', `затворен транспорт: ${textDown}`)
      M.delayNext('resume_room', 2_500)
      M.reconnect()
      const resyncing = await waitForExpr(M.page, `document.querySelector('${ROOM_BANNER}')?.textContent === 'Възстановяване на играта...'`, 10_000)
      assert(resyncing, 'банерът не показа „Възстановяване на играта...“ при отворен транспорт')
      assert(await waitForExpr(M.page, `!document.querySelector('${ROOM_BANNER}')`, 20_000), 'банерът не изчезна след синхронизацията')
      assert(M.offlineReloads.length === 0, `reload: ${M.offlineReloads.join(',')}`)
    })
    // ── [R12]–[R14] Етапи 3–4 (M, mobile) ──
    const resumeLinesFor = (profileId: string) => h.serverOutput().split('\n')
      .filter((l) => l.includes('[resume] '))
      .map((l) => JSON.parse(l.slice(l.indexOf('[resume] ') + 9)))
      .filter((e: any) => e.profileId === profileId)
    await check('[R12] room_resumed/snapshot изгубени, връзката остава полуотворена и прикрепена -> следващият опит възстановява с доказателство, без reload', async () => {
      const sentFrom = M.sent.length
      const resumeBefore = resumeLinesFor(M.profile.profileId).length
      M.halfOpenAfterNext('resume_room')
      M.disconnect()
      await sleep(600)
      M.reconnect()
      assert(await waitForExpr(M.page, `!document.querySelector('${ROOM_BANNER}')`, 30_000), 'не се възстанови')
      const resumes = M.sent.slice(sentFrom).filter((f) => f.type === 'resume_room')
      assert(resumes.length === 2, `resume_room: ${resumes.length}`)
      assert(Array.isArray(resumes[1]!.data.priorAttempts) && resumes[1]!.data.priorAttempts.length >= 1, `priorAttempts: ${JSON.stringify(resumes[1]!.data.priorAttempts)}`)
      assert(!JSON.stringify(resumes[1]!.data.priorAttempts).includes('reconnectToken'), 'priorAttempts')
      const entries = resumeLinesFor(M.profile.profileId).slice(resumeBefore)
      const last = entries[entries.length - 1]
      assert(entries.length === 2 && entries[0].result === 'attached' && last.result === 'attached' && (last.provenOwnConnectionIds?.length ?? 0) === 1, JSON.stringify(entries))
      assert(M.offlineReloads.length === 0, `reload: ${M.offlineReloads.join(',')}`)
    })
    await check('[R13] resume_room не стига до сървъра -> 10 s, после нов тих опит (Етап 3) с доказателство за полуотворения неприкрепен опит, без reload', async () => {
      const sentFrom = M.sent.length
      const openedBefore = M.wsOpened()
      const resumeBefore = resumeLinesFor(M.profile.profileId).length
      M.swallowNext('resume_room')
      const startedAt = Date.now()
      M.disconnect()
      await sleep(600)
      M.reconnect()
      assert(await waitForExpr(M.page, `!document.querySelector('${ROOM_BANNER}')`, 40_000), 'не се възстанови')
      const tookMs = Date.now() - startedAt
      assert(tookMs >= 10_000 && tookMs < 30_000, `продължителност ${tookMs} ms`)
      assert(M.wsOpened() - openedBefore === 2, `нови връзки: ${M.wsOpened() - openedBefore}`)
      const resumes = M.sent.slice(sentFrom).filter((f) => f.type === 'resume_room')
      assert(resumes.length === 2 && resumes[1]!.data.reconnectAttempt === 2, JSON.stringify(resumes.map((f) => f.data.reconnectAttempt)))
      const last = resumeLinesFor(M.profile.profileId).slice(resumeBefore).pop()
      assert(last?.result === 'attached' && (last.provenOwnConnectionIds?.length ?? 0) === 1, JSON.stringify(last))
      assert(M.offlineReloads.length === 0, `reload: ${M.offlineReloads.join(',')}`)
    })
    await check('[R14] два поредни временни неуспеха -> възстановяване от третия опит, без reload; паузата расте', async () => {
      const sentFrom = M.sent.length
      M.swallowNext('resume_room', 2)
      M.disconnect()
      await sleep(600)
      M.reconnect()
      assert(await waitForExpr(M.page, `!document.querySelector('${ROOM_BANNER}')`, 60_000), 'не се възстанови')
      const resumes = M.sent.slice(sentFrom).filter((f) => f.type === 'resume_room')
      assert(resumes.length === 3 && resumes.map((f) => f.data.reconnectAttempt).join(',') === '1,2,3', JSON.stringify(resumes.map((f) => f.data.reconnectAttempt)))
      assert((resumes[2]!.data.priorAttempts?.length ?? 0) >= 2, `priorAttempts: ${resumes[2]!.data.priorAttempts?.length}`)
      assert(M.offlineReloads.length === 0, `reload: ${M.offlineReloads.join(',')}`)
    })
    autoP.stop()
    autoM.stop()
    await check('[R1-R4] без грешки в конзолата на страниците', () => {
      assert(P.errors.length === 0 && M.errors.length === 0, JSON.stringify([...P.errors, ...M.errors].slice(0, 3)))
    })
    // ── [R11] Етап 2: сесията е оттеглена по време на прекъсването ──
    await check('[R11] оттеглена сесия по време на прекъсването -> без resume_room, досегашният reload via=session (authCheck=ws)', async () => {
      const sentFrom = P.sent.length
      P.disconnect()
      await sleep(500)
      const res = await fetch(`${h.backendOrigin}/api/auth/logout`, { method: 'POST', headers: { Cookie: `belot_session=${P.profile.cookie}` } })
      assert(res.status < 500, `logout ${res.status}`)
      P.reconnect()
      await waitUntil('reload via=session', () => P.offlineReloads.find((u) => u.includes('via=session')), 20_000)
      const url = P.offlineReloads.find((u) => u.includes('via=session'))!
      assert(url.includes('authCheck=ws') && url.includes('reason=session_changed') && url.includes('code=ws_session_missing'), url)
      assert(!P.sent.slice(sentFrom).some((f) => f.type === 'resume_room' && typeof f.data.reconnectOf === 'string'), 'resume_room с оттеглена сесия')
    })
  } catch (error) {
    console.error('  FAIL  неочаквана грешка (фаза 1):', error instanceof Error ? error.stack : error)
    await check('фаза 1 без неочаквани грешки', () => { throw error })
  } finally {
    await h.close()
  }
}

// ═══ Фаза 2 ═══════════════════════════════════════════════════════════════
async function rawConnect(h: GiftBackHarness, profile: TestProfile): Promise<{ ws: RawWs; frames: any[] }> {
  const ws = new WebSocket(`${h.backendOrigin.replace('http', 'ws')}/ws`, { headers: { Cookie: `belot_session=${profile.cookie}`, Origin: h.appOrigin } })
  const frames: any[] = []
  ws.on('message', (data) => { try { frames.push(JSON.parse(data.toString())) } catch { /* ignore */ } })
  await new Promise<void>((done, reject) => { ws.once('open', () => done()); ws.once('error', reject) })
  await waitUntil('raw connected', () => frames.some((f) => f.type === 'connected'), 10_000)
  return { ws, frames }
}
{
  const h = await startHarness(1)
  try {
    const [pV, pX, pQ, pR, pT1, pT2] = [
      await register(h, 'v'), await register(h, 'x'), await register(h, 'q'),
      await register(h, 'r'), await register(h, 't1'), await register(h, 't2'),
    ]
    // Гласова маса: V (desktop, админ, VIP) + X (raw) + ботове.
    h.db.prepare(`UPDATE accounts SET role = 'admin' WHERE account_id = (SELECT account_id FROM profiles WHERE profile_id = ?)`).run(pV.profileId)
    h.db.prepare(`INSERT INTO vip_status (profile_id, active_until, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(profile_id) DO UPDATE SET active_until = excluded.active_until`)
      .run(pV.profileId, new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 19).replace('T', ' '))
    h.db.prepare(`INSERT INTO voice_chat_admin_changes (change_id, setting, new_value, previous_value, changed_by_profile_id, changed_at) VALUES (?, 'mode', 'admin_only', 'off', ?, ?)`)
      .run(randomUUID(), pV.profileId, new Date().toISOString())

    const V = await openControlled(h, 'V', pV, DESKTOP)
    await V.page.locator(LOBBY_READY).first().click()
    await V.page.locator('[data-private-rooms-create-open="1"]').first().click()
    const voiceCheckbox = V.page.locator('[data-private-room-create-form="1"] [data-private-room-voice-checkbox="1"]')
    await voiceCheckbox.waitFor({ state: 'visible', timeout: 15_000 })
    await voiceCheckbox.check()
    await V.page.locator('[data-private-room-create-form="1"] input[name="manualStart"]').check()
    await V.page.locator('[data-private-room-create-form="1"] button[type="submit"]').click()
    await V.page.locator('[data-private-room-waiting-screen="1"]').waitFor({ state: 'visible', timeout: 20_000 })
    const privateRoom = [...V.received].reverse().find((f) => f.type === 'private_room_updated')?.data.room
    await V.page.locator('[data-voice-prompt-layer="1"] [data-voice-action="join-listen"]').first().click({ timeout: 25_000 })
    const listening = await waitForExpr(V.page, `(() => { const el = document.querySelector('[data-voice-waiting-strip="1"] .pvs-sub'); return !!el && el.textContent === 'Микрофон изключен' })()`, 20_000)
    const X = await rawConnect(h, pX)
    const freeB = privateRoom.slots.find((s: any) => s.occupant === null && s.team === 'B')
    X.ws.send(JSON.stringify({ type: 'join_private_room', privateRoomId: privateRoom.id, team: 'B', slotIndex: freeB.slotIndex }))
    await sleep(1200)
    X.ws.send(JSON.stringify({ type: 'add_bot_to_private_room_team', team: 'B' }))
    await sleep(800)
    V.inject({ type: 'add_bot_to_private_room_team', team: 'A' })
    await sleep(1200)
    await V.page.waitForFunction(`(() => { const b = document.querySelector('[data-private-room-manual-start="1"]'); return b !== null && !b.disabled })()`, null, { timeout: 15_000 })
    await V.page.locator('[data-private-room-manual-start="1"]').click()
    const voiceRoomId = await waitUntil('V game', () => [...V.received].reverse().find((f) => f.type === 'room_snapshot' && f.data.game)?.data.roomId, 30_000)
    await sleep(3000)
    // Гласът от чакалнята продължава в играта без ново включване.
    const markerV = await setMarker(V.page)
    const liveKitBeforeDrop = await fakeLiveKit(V.page)
    const r5 = await dropFor(V, 3_000)
    await sleep(1500)
    const liveKit = await fakeLiveKit(V.page)
    await check('[R5] гласова маса в игра: тихо възстановяване, LiveKit не е прекъснат, presence след room_resumed', async () => {
      assert(listening, '(setup) гласът не беше включен')
      assert(r5.roomBannerDuring && !r5.overlayDuring && r5.recovered, JSON.stringify({ banner: r5.roomBannerDuring, overlay: r5.overlayDuring, recovered: r5.recovered }))
      assert(liveKitBeforeDrop !== null && liveKitBeforeDrop.connects === 1 && liveKitBeforeDrop.disconnects === 0 && liveKitBeforeDrop.activeRooms === 1, `гласът от чакалнята не продължи в играта: ${JSON.stringify(liveKitBeforeDrop)}`)
      assert(liveKit !== null && liveKit.connects === 1 && liveKit.disconnects === 0 && liveKit.activeRooms === 1, `LiveKit: преди ${JSON.stringify(liveKitBeforeDrop)} след ${JSON.stringify(liveKit)}`)
      const resumedIdx = r5.receivedAfter.findIndex((f) => f.type === 'room_resumed' && f.data.roomId === voiceRoomId)
      const presenceAt = r5.sentAfter.find((f) => f.type === 'voice_presence')?.at ?? null
      const resumedAt = resumedIdx >= 0 ? r5.receivedAfter[resumedIdx]!.at : null
      assert(resumedAt !== null && presenceAt !== null && presenceAt >= resumedAt, `presence ${presenceAt} / resumed ${resumedAt}`)
      assert(V.received.some((f) => f.type === 'voice_presence_result' && f.data.ok === true && f.at >= (resumedAt ?? 0)), 'voice_presence_result ok')
      assert(!r5.receivedAfter.some((f) => f.type === 'voice_access_ended'), 'voice_access_ended')
      assert((await getMarker(V.page)) === markerV && V.offlineReloads.length === 0, 'reload')
    })
    X.ws.close()

    // ── [R6]/[R7] мачът приключва през прекъсването; повторен мач ──
    const Q = await openControlled(h, 'Q', pQ, DESKTOP)
    const roomQ = await joinRandom(Q, 5000)
    await waitGame(Q, roomQ)
    const markerQ = await setMarker(Q.page)
    // Рундът трябва да е в игра на карти (иначе всички „Пас“ -> ново раздаване).
    const autoQ = startAutopilot(Q, roomQ)
    await waitUntil('Q playing phase', () => lastSnapshot(Q, roomQ)?.game?.authoritativePhase === 'playing', 150_000, 200)
    autoQ.stop()
    Q.disconnect()
    const qDropAt = Date.now()
    // Възстановяване веднага щом сървърът отчете края на мача (под 120 s).
    await waitUntil('Q match finished server-side', () => {
      const row = h.db.prepare('SELECT room_status AS s, game_phase AS p, state_version AS v FROM active_room_snapshots WHERE room_id = ?').get(roomQ) as { s: string; p: string; v: number } | undefined
      if (Math.round((Date.now() - qDropAt) / 1000) % 10 === 0) console.log(`    (Q сървър: ${JSON.stringify(row ?? null)})`)
      // Точкуването на последния рунд (мачът е до 1 т.) — възстановяване преди
      // 30-секундния grace на приключила стая без свързани хора.
      return row !== undefined && (row.s === 'finished' || row.p === 'scoring')
    }, 90_000, 1000).catch(() => undefined)
    console.log(`    (мачът на Q: прекъсване ${Math.round((Date.now() - qDropAt) / 1000)} s)`)
    const qSentFrom = Q.sent.length
    Q.reconnect()
    const qRecovered = await waitRecovered(Q, qSentFrom)
    await sleep(1500)
    await check('[R6] мачът приключи през прекъсването: тихо възстановяване до екрана за край, без reload', async () => {
      assert(qRecovered, 'не се възстанови тихо')
      await waitUntil('Q match-ended snapshot', () => lastSnapshot(Q, roomQ)?.roomStatus === 'finished', 15_000).catch(() => undefined)
      const snap = lastSnapshot(Q, roomQ)
      assert(snap?.roomStatus === 'finished', `roomStatus=${snap?.roomStatus} phase=${snap?.game?.authoritativePhase} score=${JSON.stringify(snap?.game?.score)} target=${snap?.game?.matchEnded ?? ''}`)
      await Q.page.locator('[data-match-ended-replay-button="1"]').first().waitFor({ state: 'visible', timeout: 10_000 })
      assert((await getMarker(Q.page)) === markerQ && Q.offlineReloads.length === 0, 'reload')
      await Q.page.screenshot({ path: join(screenshotsDir, 'R6-desktop-match-ended.png') })
    })
    await check('[R7] повторен мач след възстановяването — нормално', async () => {
      const from = Q.received.length
      await Q.page.locator('[data-match-ended-replay-button="1"]').first().click()
      await waitUntil('replay started', () => Q.received.slice(from).some((f) => f.type === 'room_snapshot' && f.data.roomId === roomQ && f.data.roomStatus !== 'finished' && f.data.game?.matchEnded == null), 20_000)
    })

    // ── [R8] друго устройство ──
    const R = await openControlled(h, 'R', pR, DESKTOP)
    const roomR = await joinRandom(R, 8000)
    await waitGame(R, roomR)
    R.disconnect()
    await sleep(1000)
    const otherDevice = await rawConnect(h, pR)
    await sleep(800)
    const rSentFrom = R.sent.length
    const rReceivedFrom = R.received.length
    R.reconnect()
    const sessionOverlayShown = await waitForExpr(R.page, `!!document.querySelector('${SESSION_OVERLAY}')`, 30_000)
    await sleep(800)
    await check('[R8] друго устройство: без изместване; досегашният изричен избор („Върни ме в играта“)', async () => {
      assert(R.sent.slice(rSentFrom).some((f) => f.type === 'resume_room' && typeof f.data.reconnectOf === 'string'), 'опит за тихо възстановяване')
      assert(R.received.slice(rReceivedFrom).some((f) => f.type === 'room_resume_failed' && f.data.code === 'other_session_active'), 'other_session_active')
      assert(!otherDevice.frames.some((f) => f.type === 'session_displaced'), 'другото устройство беше изместено')
      assert(R.offlineReloads.some((u) => u.includes('via=sync')), `reload: ${R.offlineReloads.join(',')}`)
      assert(sessionOverlayShown, 'прозорецът за изричен избор не се показа')
    })
    otherDevice.ws.close()

    // ── [R9]/[R10] турнир ──
    const T1 = await openControlled(h, 'T1', pT1, DESKTOP)
    const T2 = await openControlled(h, 'T2', pT2, MOBILE)
    const roomT1 = await joinRandom(T1, 10000)
    await waitGame(T1, roomT1)
    const markerT1 = await setMarker(T1.page)
    T1.disconnect()
    const createRes = await fetch(`${h.backendOrigin}/dev/tournament-test/api/create`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamCapacity: 4, mode: 'one_human', existingHumanProfileIds: [pT1.profileId, pT2.profileId] }),
    })
    const created: any = await createRes.json()
    await sleep(14_000)
    const t1Replacement = (h.db.prepare(`SELECT COUNT(*) AS n FROM tournament_match_no_show_replacements WHERE assigned_profile_id = ?`).get(pT1.profileId) as { n: number }).n
    const t1SentFrom = T1.sent.length
    T1.reconnect()
    const t1Recovered = await waitRecovered(T1, t1SentFrom)
    await sleep(2500)
    await check('[R9] започнал турнир + заместващ бот през прекъсването: тихо в обикновения мач, без session_in_game прозорец, известието', async () => {
      assert(created.ok === true, `(setup) ${JSON.stringify(created).slice(0, 200)}`)
      assert(t1Replacement > 0, '(setup) няма заместващ бот за T1')
      assert(t1Recovered, 'не се възстанови тихо')
      assert(T1.received.some((f) => f.type === 'session_in_game' && f.data.roomId === roomT1 && f.at >= Date.now() - 30_000), 'session_in_game не сочи обикновения мач')
      assert(!(await isVisible(T1.page, SESSION_OVERLAY)), 'session_in_game прозорецът е видим')
      assert((await getMarker(T1.page)) === markerT1 && T1.offlineReloads.length === 0, 'reload')
      await T1.page.locator('#tms-popup, #tms-popup-mini').first().waitFor({ state: 'visible', timeout: 10_000 })
    })

    const t2Room = await waitUntil('T2 in tournament room', async () => {
      const st: any = await (await fetch(`${h.backendOrigin}/dev/tournament-test/api/state?tournamentId=${encodeURIComponent(created.tournamentId)}`)).json()
      const state = st.state ?? st
      const teamId = state.entries.find((e: any) => e.profileId === pT2.profileId)?.teamId
      const m = state.matches.find((x: any) => (x.teamAId === teamId || x.teamBId === teamId) && x.status === 'in_progress')
      return m && T2.received.some((f) => f.type === 'room_resumed' && f.data.roomId === m.roomId) ? m.roomId as string : null
    }, 60_000, 500)
    await waitUntil('T2 game', () => lastSnapshot(T2, t2Room)?.game?.authoritativePhase, 20_000)
    const markerT2 = await setMarker(T2.page)
    const r10 = await dropFor(T2, 3_000)
    await check('[R10] mobile: турнирен мач — тихо възстановяване в турнирната стая', async () => {
      assert(r10.roomBannerDuring && !r10.overlayDuring && r10.recovered, JSON.stringify({ banner: r10.roomBannerDuring, overlay: r10.overlayDuring, recovered: r10.recovered }))
      assert(r10.receivedAfter.some((f) => f.type === 'room_resumed' && f.data.roomId === t2Room), 'room_resumed за турнирната стая')
      assert((await getMarker(T2.page)) === markerT2 && T2.offlineReloads.length === 0, 'reload')
      await T2.page.screenshot({ path: join(screenshotsDir, 'R10-mobile-tournament.png') })
    })
  } catch (error) {
    console.error('  FAIL  неочаквана грешка (фаза 2):', error instanceof Error ? error.stack : error)
    await check('фаза 2 без неочаквани грешки', () => { throw error })
  } finally {
    await h.close()
  }
}

fakeTwirp.close()
console.log(`\n  screenshots: ${screenshotsDir}`)
finishAndExit()
