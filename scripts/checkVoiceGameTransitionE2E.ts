/**
 * checkVoiceGameTransitionE2E.ts — гласовият разговор не се прекъсва при
 * преходите на една и съща гласова маса:
 *
 *   [G1] чакалня -> активна игра (desktop V с включен микрофон, mobile W само
 *        слуша; V е заглушил W локално): LiveKit сесията е същата (без нов
 *        connect/disconnect), микрофонът на V е включен, на W — изключен,
 *        локалното заглушаване е запазено, без voice_access_ended;
 *   [G2] активна игра -> край на мача: същото;
 *   [G3] край на мача -> преиграване: същото;
 *   [G4] реално напускане на масата (W): гласовата връзка на W се прекратява,
 *        V остава в гласа (след съществуващата ротация на гласовата стая).
 *   Досегашно поведение при „Изчакай в лоби“ (U с включен микрофон):
 *   [L1] гласовата връзка се прекратява, микрофонът се изключва, мястото и
 *        правото за говорене се запазват;
 *   [L2] при връщане в чакалнята микрофонът не се включва автоматично;
 *   [L3] масата стартира, докато U чака в лобито — микрофонът му не се
 *        активира автоматично; гласът на домакина продължава.
 *
 * Реален сървър (изолирано копие; частната маса е до 1 т. само там), реален
 * Vite + Chromium; само LiveKit адаптерът е тестова подмяна
 * (scripts/fixtures/fakeLiveKitVoiceAdapter.ts). Режим „Само админ“.
 *
 *   node server/node_modules/tsx/dist/cli.mjs scripts/checkVoiceGameTransitionE2E.ts
 */

import { randomUUID } from 'node:crypto'
import { createServer as createHttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import type { Page, WebSocketRoute } from 'playwright'
import { assert, check, finishAndExit, sleep, startGiftBackHarness, type TestProfile } from './giftBackTestHarness'

console.log('\ncheckVoiceGameTransitionE2E\n')

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
  // Частната маса е до 1 точка само в изолираното копие (бърз край на мача).
  patchServerSource: [{
    file: 'index.ts',
    find: 'const initializedRoom = initializeRoomAuthoritativeGameState(currentRoom)',
    replace: 'const initializedRoom = initializeRoomAuthoritativeGameState({ ...currentRoom, config: { ...currentRoom.config, targetScore: 1 } })',
  }],
  databaseFileName: 'belot-v2-tournament-test.sqlite',
  env: {
    NODE_ENV: 'development',
    BELOT_LOCAL_TOURNAMENT_TEST_MODE: '1',
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

const DESKTOP = { width: 1280, height: 850 }
const MOBILE = { width: 390, height: 844 }
const LOBBY_READY = '[data-lobby-private-rooms-card="1"]'
const WAITING = '[data-private-room-waiting-screen="1"]'

type Frame = { at: number; type: string; data: any }
type Party = { label: string; profile: TestProfile; page: Page; received: Frame[]; inject: (m: unknown) => void }
type VoiceState = { status: string; microphone: string; locallyMuted: string[]; stats: { connects: number; disconnects: number; activeRooms: number } | null }

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
async function openParty(label: string, profile: TestProfile, viewport: { width: number; height: number }): Promise<Party> {
  const context = await h.browser.newContext(viewport === MOBILE ? { viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : { viewport })
  await context.addCookies([{ name: 'belot_session', value: profile.cookie, url: h.backendOrigin }])
  await context.addInitScript(`try { localStorage.setItem('pika-consent-v2', JSON.stringify({ version: 2, necessary: true, analytics: false, marketing: false, updatedAt: new Date().toISOString() })) } catch {}`)
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
  return { status: s ? s.status : 'none', microphone: s ? s.microphone : 'none', locallyMuted: s ? [...s.locallyMutedProfileIds] : [], stats: window.__fakeLiveKit || null }
})()`) as Promise<VoiceState>
async function waitUntil<T>(label: string, fn: () => T | null | undefined | false | Promise<T | null | undefined | false>, timeoutMs: number, intervalMs = 250): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value as T
    await sleep(intervalMs)
  }
  throw new Error(`timeout: ${label}`)
}
const lastSnapshot = (p: Party, roomId: string) => [...p.received].reverse().find((f) => f.type === 'room_snapshot' && f.data.roomId === roomId)?.data ?? null

/** Реална игра през UI (цепене, „Пас“, допустима карта), за да свърши мачът бързо. */
function startAutopilot(p: Party, roomId: string): () => void {
  let stopped = false
  let busy = false
  const tick = async (): Promise<void> => {
    if (stopped) return
    if (!busy) {
      busy = true
      try {
        const snap = lastSnapshot(p, roomId)
        const game = snap?.game
        const me = snap?.seats?.find((s: any) => s.seat === snap.yourSeat)
        if (game && me?.isControlledByBot !== true) {
          if (await p.page.locator('[data-declaration-continue]').count() > 0) {
            await p.page.locator('[data-declaration-continue]').first().click({ timeout: 800 }).catch(() => undefined)
          } else if (game.cutting?.canSubmitCut) {
            await p.page.locator('[data-active-room-cut-index]').first().dispatchEvent('click').catch(() => undefined)
          } else if (game.bidding?.canSubmitBid) {
            await p.page.locator('[data-bid-action="pass"]').first().dispatchEvent('click').catch(() => undefined)
          } else if (Array.isArray(game.playing?.validCardIds) && game.playing.validCardIds.length > 0) {
            await p.page.locator(`.play-hand-card--active[data-card-id="${game.playing.validCardIds[0]}"]`).first().dispatchEvent('click').catch(() => undefined)
          }
        }
      } catch { /* страницата е заета */ } finally {
        busy = false
      }
    }
    if (!stopped) setTimeout(() => { void tick() }, 400)
  }
  void tick()
  return () => { stopped = true }
}

function assertContinuous(label: string, v: VoiceState, w: VoiceState, wProfileId: string): void {
  assert(v.stats !== null && v.stats.connects === 1 && v.stats.disconnects === 0 && v.stats.activeRooms === 1, `${label} V LiveKit: ${JSON.stringify(v.stats)}`)
  assert(w.stats !== null && w.stats.connects === 1 && w.stats.disconnects === 0 && w.stats.activeRooms === 1, `${label} W LiveKit: ${JSON.stringify(w.stats)}`)
  assert(v.microphone === 'live', `${label} микрофонът на V: ${v.microphone}`)
  assert(w.microphone === 'off', `${label} микрофонът на W (беше изключен): ${w.microphone}`)
  assert(v.locallyMuted.includes(wProfileId), `${label} локалното заглушаване на V: ${JSON.stringify(v.locallyMuted)}`)
}

try {
  const [pV, pW] = [await register('gv'), await register('gw')]
  h.db.prepare(`UPDATE accounts SET role = 'admin' WHERE account_id = (SELECT account_id FROM profiles WHERE profile_id = ?)`).run(pV.profileId)
  const vipUntil = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 19).replace('T', ' ')
  for (const p of [pV, pW]) {
    h.db.prepare(`INSERT INTO vip_status (profile_id, active_until, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(profile_id) DO UPDATE SET active_until = excluded.active_until`).run(p.profileId, vipUntil)
  }
  h.db.prepare(`INSERT INTO voice_chat_admin_changes (change_id, setting, new_value, previous_value, changed_by_profile_id, changed_at) VALUES (?, 'mode', 'admin_only', 'off', ?, ?)`)
    .run(randomUUID(), pV.profileId, new Date().toISOString())

  const V = await openParty('V', pV, DESKTOP)
  const W = await openParty('W', pW, MOBILE)

  // Гласова маса (ръчен старт); V — с микрофон, W — само слуша.
  await V.page.locator(LOBBY_READY).first().click()
  await V.page.locator('[data-private-rooms-create-open="1"]').first().click()
  const voiceCheckbox = V.page.locator('[data-private-room-create-form="1"] [data-private-room-voice-checkbox="1"]')
  await voiceCheckbox.waitFor({ state: 'visible', timeout: 15_000 })
  await voiceCheckbox.check()
  await V.page.locator('[data-private-room-create-form="1"] input[name="manualStart"]').check()
  await V.page.locator('[data-private-room-create-form="1"] button[type="submit"]').click()
  await V.page.locator(WAITING).waitFor({ state: 'visible', timeout: 20_000 })
  const privateRoomId = [...V.received].reverse().find((f) => f.type === 'private_room_updated')?.data.room.id as string
  await V.page.locator('[data-voice-prompt-layer="1"] [data-voice-action="join-mic"]').first().click({ timeout: 25_000 })
  await waitUntil('V mic live', async () => (await voiceState(V.page)).microphone === 'live', 20_000)

  await W.page.locator(LOBBY_READY).first().click()
  // W сяда в другия отбор — всеки отбор има човек, който да добави бот.
  const vTeamBefore = ([...V.received].reverse().find((f) => f.type === 'private_room_updated')?.data.room.slots ?? []).find((s: any) => s.occupant?.profileId === pV.profileId)?.team === 'B' ? 'B' : 'A'
  const otherTeam = vTeamBefore === 'A' ? 'B' : 'A'
  const plus = W.page.locator(`[data-private-room-list-slot-join^="${privateRoomId}:${otherTeam}:"]`).first()
  await plus.waitFor({ state: 'visible', timeout: 15_000 })
  await plus.click()
  await W.page.locator('[data-private-room-join-popup-confirm="1"]').click({ timeout: 5_000 })
  await W.page.locator(WAITING).waitFor({ state: 'visible', timeout: 15_000 })
  await W.page.locator('[data-voice-prompt-layer="1"] [data-voice-action="join-listen"]').first().click({ timeout: 25_000 })
  await waitUntil('W listening', async () => (await voiceState(W.page)).stats?.activeRooms === 1, 20_000)

  // Локално заглушаване на W от V (собственият избор на V се пази).
  await V.page.evaluate(`window.__pikaVoice.muteRemoteParticipant('${pW.profileId}')`)
  const room = [...V.received].reverse().find((f) => f.type === 'private_room_updated')?.data.room
  const wTeam = room.slots.find((s: any) => s.occupant?.profileId === pW.profileId)?.team as string
  const vTeam = room.slots.find((s: any) => s.occupant?.profileId === pV.profileId)?.team as string
  V.inject({ type: 'add_bot_to_private_room_team', team: vTeam })
  await sleep(800)
  W.inject({ type: 'add_bot_to_private_room_team', team: wTeam })
  await sleep(1200)
  await V.page.waitForFunction(`(() => { const b = document.querySelector('[data-private-room-manual-start="1"]'); return b !== null && !b.disabled })()`, null, { timeout: 15_000 })
  const startFrom = { v: V.received.length, w: W.received.length }
  await V.page.locator('[data-private-room-manual-start="1"]').click()
  const gameRoomId = await waitUntil('game started', () => V.received.slice(startFrom.v).find((f) => f.type === 'private_room_full')?.data.roomId as string | undefined, 20_000)
  await waitUntil('game snapshots', () => lastSnapshot(V, gameRoomId)?.game && lastSnapshot(W, gameRoomId)?.game, 20_000)
  await sleep(2500)

  await check('[G1] чакалня -> активна игра: същата LiveKit сесия, микрофонът и локалното заглушаване са запазени', async () => {
    assertContinuous('G1', await voiceState(V.page), await voiceState(W.page), pW.profileId)
    assert(![...V.received.slice(startFrom.v), ...W.received.slice(startFrom.w)].some((f) => f.type === 'voice_access_ended'), 'voice_access_ended')
  })

  const stopV = startAutopilot(V, gameRoomId)
  const stopW = startAutopilot(W, gameRoomId)
  await waitUntil('match ended', () => lastSnapshot(V, gameRoomId)?.roomStatus === 'finished', 300_000, 500)
  stopV()
  stopW()
  await sleep(2000)
  await check('[G2] активна игра -> край на мача: същата LiveKit сесия, микрофонът и заглушаването са запазени', async () => {
    assertContinuous('G2', await voiceState(V.page), await voiceState(W.page), pW.profileId)
  })

  const replayFrom = V.received.length
  await V.page.locator('[data-match-ended-replay-button="1"]').first().click({ timeout: 10_000 })
  await W.page.locator('[data-match-ended-replay-button="1"]').first().click({ timeout: 10_000 })
  await waitUntil('replay started', () => V.received.slice(replayFrom).some((f) => f.type === 'room_snapshot' && f.data.roomId === gameRoomId && f.data.roomStatus !== 'finished' && f.data.game?.matchEnded == null), 30_000)
  await sleep(2500)
  await check('[G3] край на мача -> преиграване: същата LiveKit сесия, микрофонът и заглушаването са запазени', async () => {
    assertContinuous('G3', await voiceState(V.page), await voiceState(W.page), pW.profileId)
  })

  W.inject({ type: 'leave_active_room', roomId: gameRoomId, acceptPenalty: true })
  await waitUntil('W voice ended', async () => (await voiceState(W.page)).stats?.activeRooms === 0, 15_000).catch(() => undefined)
  await sleep(1000)
  await check('[G4] реално напускане на масата: гласовата връзка на W се прекратява; V остава в гласа (след съществуващата ротация), заглушаването е запазено', async () => {
    const w = await voiceState(W.page)
    const v = await voiceState(V.page)
    assert(w.stats !== null && w.stats.activeRooms === 0 && w.stats.disconnects === 1, `W LiveKit: ${JSON.stringify(w.stats)}`)
    // При окончателно напускане сървърът ротира гласовата стая (съществуващо
    // правило — токенът на напусналия спира да важи): V остава в гласа през
    // новата стая, със запазено локално заглушаване.
    await waitUntil('V voice after rotation', async () => (await voiceState(V.page)).stats?.activeRooms === 1, 15_000).catch(() => undefined)
    const vAfter = await voiceState(V.page)
    assert(vAfter.stats !== null && vAfter.stats.activeRooms === 1, `V LiveKit: ${JSON.stringify(vAfter.stats)}`)
    // Микрофонът след ротацията зависи от преизползването на capture-а в реалния
    // адаптер (фалшивият не пренася capture) — не се проверява тук.
    assert(vAfter.locallyMuted.includes(pW.profileId), `заглушаването на V: ${JSON.stringify(vAfter.locallyMuted)}`)
    void v
  })

  // ─── „Изчакай в лоби“ от гласова чакалня (досегашно поведение) ─────────
  // H (desktop, домакин) слуша; U (mobile) говори с включен микрофон.
  const [pH, pU] = [await register('gh'), await register('gu')]
  for (const p of [pH, pU]) {
    h.db.prepare(`UPDATE accounts SET role = 'admin' WHERE account_id = (SELECT account_id FROM profiles WHERE profile_id = ?)`).run(p.profileId)
    h.db.prepare(`INSERT INTO vip_status (profile_id, active_until, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(profile_id) DO UPDATE SET active_until = excluded.active_until`).run(p.profileId, vipUntil)
  }
  const H = await openParty('H', pH, DESKTOP)
  const U = await openParty('U', pU, MOBILE)
  await H.page.locator(LOBBY_READY).first().click()
  await H.page.locator('[data-private-rooms-create-open="1"]').first().click()
  const hVoiceCheckbox = H.page.locator('[data-private-room-create-form="1"] [data-private-room-voice-checkbox="1"]')
  await hVoiceCheckbox.waitFor({ state: 'visible', timeout: 15_000 })
  await hVoiceCheckbox.check()
  await H.page.locator('[data-private-room-create-form="1"] input[name="manualStart"]').check()
  await H.page.locator('[data-private-room-create-form="1"] button[type="submit"]').click()
  await H.page.locator(WAITING).waitFor({ state: 'visible', timeout: 20_000 })
  const hRoom = [...H.received].reverse().find((f) => f.type === 'private_room_updated')?.data.room
  const hTeam = hRoom.slots.find((s: any) => s.occupant?.profileId === pH.profileId)?.team === 'B' ? 'B' : 'A'
  const uTeam = hTeam === 'A' ? 'B' : 'A'
  await H.page.locator('[data-voice-prompt-layer="1"] [data-voice-action="join-listen"]').first().click({ timeout: 25_000 })
  await waitUntil('H listening', async () => (await voiceState(H.page)).stats?.activeRooms === 1, 20_000)

  await U.page.locator(LOBBY_READY).first().click()
  await U.page.locator(`[data-private-room-list-slot-join^="${hRoom.id}:${uTeam}:"]`).first().click({ timeout: 15_000 })
  await U.page.locator('[data-private-room-join-popup-confirm="1"]').click({ timeout: 5_000 })
  await U.page.locator(WAITING).waitFor({ state: 'visible', timeout: 15_000 })
  await U.page.locator('[data-voice-prompt-layer="1"] [data-voice-action="join-mic"]').first().click({ timeout: 25_000 })
  await waitUntil('U mic live', async () => (await voiceState(U.page)).microphone === 'live', 20_000)
  const uCanSpeakBefore = await U.page.evaluate(`(() => { const s = window.__pikaVoice.getSnapshot(); return !!(s.speak && s.speak.canSpeak) })()`) as boolean

  const uSeated = (frames: Frame[]) => {
    const room = [...frames].reverse().find((f) => f.type === 'private_room_updated' && f.data.room?.id === hRoom.id)?.data
    return { seated: !!room && room.room.slots.some((s: any) => s.occupant?.profileId === pU.profileId), canSpeak: room?.voiceSpeak?.canSpeak === true }
  }

  // [L1] „Изчакай в лоби“.
  const l1From = U.received.length
  await U.page.locator('[data-private-waiting-wait-in-lobby-button="1"]').first().click({ timeout: 10_000 })
  await waitUntil('U voice stopped', async () => (await voiceState(U.page)).stats?.activeRooms === 0, 15_000).catch(() => undefined)
  await sleep(1500)
  const uAfterLobby = await voiceState(U.page)
  const uCanSpeakInLobby = await U.page.evaluate(`(() => { const s = window.__pikaVoice.getSnapshot(); return !!(s.speak && s.speak.canSpeak) })()`) as boolean
  await check('[L1] „Изчакай в лоби“: гласовата връзка се прекратява, микрофонът се изключва, мястото и правото за говорене се запазват', async () => {
    assert(uCanSpeakBefore, '(setup) U няма право за говорене')
    assert(uAfterLobby.stats !== null && uAfterLobby.stats.activeRooms === 0 && uAfterLobby.stats.disconnects === 1, `LiveKit: ${JSON.stringify(uAfterLobby.stats)}`)
    assert(uAfterLobby.microphone === 'off', `микрофон: ${uAfterLobby.microphone}`)
    assert(!U.received.slice(l1From).some((f) => f.type === 'private_room_left'), 'мястото е освободено')
    const room = [...H.received].reverse().find((f) => f.type === 'private_room_updated' && f.data.room?.id === hRoom.id)?.data.room
    assert(room !== undefined && room.slots.some((s: any) => s.occupant?.profileId === pU.profileId), 'U не е на масата')
    assert(uCanSpeakInLobby, 'правото за говорене се загуби')
  })

  // [L2] Връщане в чакалнята (списъкът с частни маси -> „ВЛЕЗ“).

  await U.page.locator(LOBBY_READY).first().click()
  await U.page.locator(`[data-private-room-list-enter="${hRoom.id}"]`).first().click({ timeout: 15_000 })
  await U.page.locator(WAITING).waitFor({ state: 'visible', timeout: 15_000 })
  await sleep(3000)
  const uBack = await voiceState(U.page)
  await check('[L2] връщане в чакалнята: микрофонът НЕ се включва автоматично (без нова гласова връзка); мястото и правото са запазени', async () => {
    assert(uBack.stats !== null && uBack.stats.connects === 1 && uBack.stats.activeRooms === 0, `LiveKit: ${JSON.stringify(uBack.stats)}`)
    assert(uBack.microphone === 'off', `микрофон: ${uBack.microphone}`)
    const seat = uSeated(U.received)
    assert(seat.seated, 'U не е на масата')
    const canSpeakNow = await U.page.evaluate(`(() => { const s = window.__pikaVoice.getSnapshot(); return !!(s.speak && s.speak.canSpeak) })()`) as boolean
    assert(canSpeakNow, 'правото за говорене се загуби')
  })

  // [L3] Масата стартира, докато U чака в лобито. Прозорецът за включване
  // (показан при връщането) се затваря с „Не сега“ — без включване.
  await U.page.locator('[data-voice-prompt-layer="1"] [data-voice-action="not-now"]').first().click({ timeout: 3000 }).catch(() => undefined)
  await U.page.locator('[data-private-waiting-wait-in-lobby-button="1"]').first().click({ timeout: 10_000 })
  await sleep(1000)
  H.inject({ type: 'add_bot_to_private_room_team', team: hTeam })
  await sleep(800)
  U.inject({ type: 'add_bot_to_private_room_team', team: uTeam })
  await sleep(1200)
  await H.page.waitForFunction(`(() => { const b = document.querySelector('[data-private-room-manual-start="1"]'); return b !== null && !b.disabled })()`, null, { timeout: 15_000 })
  const l3From = U.received.length
  await H.page.locator('[data-private-room-manual-start="1"]').click()
  const l3RoomId = await waitUntil('U game started', () => U.received.slice(l3From).find((f) => f.type === 'private_room_full')?.data.roomId as string | undefined, 20_000)
  await waitUntil('U game snapshot', () => lastSnapshot(U, l3RoomId)?.game, 20_000)
  await sleep(4000)
  const uInGame = await voiceState(U.page)
  const hInGame = await voiceState(H.page)
  await check('[L3] масата стартира, докато U чака в лобито: микрофонът му НЕ се активира автоматично (без нова гласова връзка); гласът на домакина продължава', async () => {
    assert(uInGame.stats !== null && uInGame.stats.connects === 1 && uInGame.stats.activeRooms === 0, `U LiveKit: ${JSON.stringify(uInGame.stats)}`)
    assert(uInGame.microphone === 'off', `U микрофон: ${uInGame.microphone}`)
    assert(hInGame.stats !== null && hInGame.stats.connects === 1 && hInGame.stats.disconnects === 0 && hInGame.stats.activeRooms === 1, `H LiveKit: ${JSON.stringify(hInGame.stats)}`)
  })
} catch (error) {
  console.error('  FAIL  неочаквана грешка:', error instanceof Error ? error.stack : error)
  await check('без неочаквани грешки', () => { throw error })
} finally {
  await h.close()
  fakeTwirp.close()
}

finishAndExit()
