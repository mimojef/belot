/**
 * checkBelotSingleParticipationE2E.ts — „Едно Белот участие“: един профил е
 * в най-много едно от опашка за случайна маса / място на чакаща частна маса /
 * активен Белот мач. Реален сървър (изолирано копие + празна SQLite база),
 * реален Vite dev server с истинския src/main.ts, реален Chromium
 * (scripts/giftBackTestHarness.ts). Таймерът на случайната маса е 20 s.
 * Отказите се проверяват и с директни WS заявки, независимо от интерфейса.
 *
 *   [S1] оригиналният случай (Adelka): търсене -> нова частна маса; известието
 *        с „Влез“ НЕ се показва; директно сядане -> отказ; случайната маса
 *        стартира само с нея, частната — без нея; ходовете ѝ в случайната се
 *        приемат; удържан е точно един залог;
 *   [S2] в активен мач: търсене / създаване / сядане -> отказ;
 *   [S3] седнала на частна маса: бутонът за търсене показва досегашното
 *        предупреждение; директен join_matchmaking -> отказ, без запис в
 *        опашката и без удържане; същото от второ устройство;
 *   [S4] в опашката: създаване / сядане -> отказ; след „Отказ“ от търсенето
 *        създаването работи нормално;
 *   [S5] партньорска покана, приета по време на търсене -> отказ, не сяда;
 *   [S6] едновременни заявки (сядане + търсене в един пакет, и в двата реда)
 *        -> точно едната успява;
 *   [S7] нормален ръчен старт продължава да работи.
 *
 *   node server/node_modules/tsx/dist/cli.mjs scripts/checkBelotSingleParticipationE2E.ts
 */

import { randomUUID } from 'node:crypto'
import type { BrowserContext, Page, WebSocketRoute } from 'playwright'
import { assert, check, finishAndExit, sleep, startGiftBackHarness, type TestProfile } from './giftBackTestHarness'

console.log('\ncheckBelotSingleParticipationE2E\n')

const h = await startGiftBackHarness()
h.db.prepare(`INSERT INTO admin_settings (setting_key, setting_value) VALUES ('belot_random_table_wait_seconds', '20') ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value`).run()
await h.restartServer()
// След рестарта keep-alive връзка към стария процес може да остане в пула на
// fetch -> първата заявка пада с „fetch failed“. Загряване с повторения.
for (let attempt = 0; attempt < 10; attempt += 1) {
  try {
    if ((await fetch(`${h.backendOrigin}/health`)).ok) break
  } catch { /* стара връзка — нов опит */ }
  await sleep(300)
}

const DESKTOP = { width: 1280, height: 850 }
const MOBILE = { width: 390, height: 844 }
const STAKE = 5000
const BALANCE = 50_000_000
const LOBBY_READY = '[data-lobby-private-rooms-card="1"]'
const CREATE_OPEN = '[data-private-rooms-create-open="1"]'
const WAITING = '[data-private-room-waiting-screen="1"]'
const TOAST_ENTER = '#global-private-room-created-notifications button'
const QUEUE_TEXT = 'Първо прекратете търсенето на игра.'
const SEAT_TEXT = 'Имате място на чакаща частна маса. Напуснете го, преди да търсите случайна маса.'

type Frame = { at: number; type: string; data: any }
type Party = { label: string; profile: TestProfile; page: Page; context: BrowserContext; received: Frame[]; sent: Frame[]; inject: (m: unknown) => void }
const parties: Party[] = []

function befriend(a: TestProfile, b: TestProfile): void {
  const [lower, higher] = a.profileId < b.profileId ? [a.profileId, b.profileId] : [b.profileId, a.profileId]
  h.db.prepare(`INSERT INTO profile_friendships (friendship_id, requester_profile_id, addressee_profile_id, lower_profile_id, higher_profile_id, status, responded_at) VALUES (?, ?, ?, ?, ?, 'accepted', CURRENT_TIMESTAMP)`).run(randomUUID(), a.profileId, b.profileId, lower, higher)
}
async function openParty(label: string, profile: TestProfile, viewport = DESKTOP): Promise<Party> {
  const context = await h.browser.newContext(viewport === MOBILE ? { viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : { viewport })
  await context.addCookies([{ name: 'belot_session', value: profile.cookie, url: h.backendOrigin }])
  await context.addInitScript(`try { localStorage.setItem('pika-consent-v2', JSON.stringify({ version: 2, necessary: true, analytics: false, marketing: false, updatedAt: new Date().toISOString() })) } catch {}`)
  const received: Frame[] = []
  const sent: Frame[] = []
  let current: WebSocketRoute | null = null
  const parse = (m: string | Buffer): Frame | null => { try { const d = JSON.parse(typeof m === 'string' ? m : m.toString('utf8')); return { at: Date.now(), type: String(d?.type ?? ''), data: d } } catch { return null } }
  await context.routeWebSocket(/\/ws(\?.*)?$/, (ws) => {
    const server = ws.connectToServer()
    ws.onMessage((m) => { const f = parse(m); if (f) sent.push(f); server.send(m) })
    server.onMessage((m) => { const f = parse(m); if (f) received.push(f); ws.send(m) })
    ws.onClose(() => server.close())
    server.onClose(() => ws.close())
    current = server
  })
  const page = await context.newPage()
  await page.goto(`${h.appOrigin}/lobby`)
  await page.locator(LOBBY_READY).first().waitFor({ state: 'attached', timeout: 25_000 })
  await page.waitForTimeout(800)
  const party = { label, profile, page, context, received, sent, inject: (m: unknown) => current?.send(JSON.stringify(m)) }
  parties.push(party)
  return party
}
async function register(tag: string): Promise<TestProfile> {
  const p = await h.register(tag)
  h.setBalance(p.profileId, BALANCE)
  return p
}
const lastRoom = (p: Party, roomId?: string) => [...p.received].reverse().find((f) => f.type === 'private_room_updated' && (roomId === undefined || f.data.room.id === roomId))?.data.room
const isSeated = (p: Party, roomId: string) => {
  const room = lastRoom(p, roomId)
  return !!room && room.slots.some((s: any) => s.occupant?.profileId === p.profile.profileId)
}
/** Изпраща и връща всички кадри, получени до timeoutMs след това. */
async function injectAndCollect(p: Party, messages: unknown[], timeoutMs = 1500): Promise<Frame[]> {
  const from = p.received.length
  for (const m of messages) p.inject(m)
  await sleep(timeoutMs)
  return p.received.slice(from)
}
const errorsOf = (frames: Frame[]) => frames.filter((f) => f.type === 'error').map((f) => String(f.data.message))
async function createRoomViaUi(p: Party, opts: { manualStart: boolean; partner?: boolean }): Promise<string> {
  if (!(await p.page.locator(CREATE_OPEN).first().isVisible().catch(() => false))) await p.page.locator(LOBBY_READY).first().click()
  await p.page.locator(CREATE_OPEN).first().click()
  const form = p.page.locator('[data-private-room-create-form="1"]')
  await form.waitFor({ state: 'visible', timeout: 15_000 })
  if (opts.manualStart) await form.locator('input[name="manualStart"]').check()
  if (opts.partner) await form.locator('[data-private-room-invite-partner-checkbox="1"]').check()
  const from = p.received.length
  await form.locator('button[type="submit"]').click()
  await p.page.locator(WAITING).waitFor({ state: 'attached', timeout: 25_000 })
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const f = p.received.slice(from).find((x) => x.type === 'private_room_updated')
    if (f) return f.data.room.id
    await sleep(100)
  }
  throw new Error(`${p.label}: масата не е създадена`)
}
async function startSearchViaUi(p: Party): Promise<void> {
  await p.page.locator(`[data-lobby-stake-card="${STAKE}"]`).first().click()
  await sleep(1200)
}
async function waitFrame(p: Party, type: string, from: number, timeoutMs: number): Promise<Frame | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const f = p.received.slice(from).find((x) => x.type === type)
    if (f) return f
    await sleep(200)
  }
  return null
}
/** Попълва частната маса до 4/4: Y сяда в отбор Б, ботове за останалите (домакинът е в А). */
async function fillPrivateRoom(host: Party, y: Party, roomId: string): Promise<void> {
  const room = lastRoom(host, roomId)
  const free = room.slots.find((s: any) => s.occupant === null && s.team === 'B')
  await injectAndCollect(y, [{ type: 'join_private_room', privateRoomId: roomId, team: free.team, slotIndex: free.slotIndex }], 1200)
  for (let i = 0; i < 3; i += 1) {
    const r = lastRoom(host, roomId)
    const next = r?.slots.find((s: any) => s.occupant === null)
    if (!next) break
    const owner = next.team === free.team ? y : host
    await injectAndCollect(owner, [{ type: 'add_bot_to_private_room_team', team: next.team }], 1000)
  }
}

try {
  // ═══ [S1] Оригиналният случай ═══════════════════════════════════════════
  const adelka = await register('adelka')
  const host1 = await register('h1')
  const y1 = await register('y1')
  const A = await openParty('adelka', adelka)
  const H1 = await openParty('host1', host1)
  const Y1 = await openParty('y1', y1)

  await startSearchViaUi(A)
  const aJoinedAt = A.received.length
  const searching = A.sent.some((f) => f.type === 'join_matchmaking')
  const room1 = await createRoomViaUi(H1, { manualStart: false })
  const toastShown = await A.page.locator(TOAST_ENTER).first().waitFor({ state: 'visible', timeout: 6_000 }).then(() => true).catch(() => false)
  const directSeat = await injectAndCollect(A, [{ type: 'join_private_room', privateRoomId: room1, team: 'B', slotIndex: 0 }])
  const matchFound = await waitFrame(A, 'match_found', aJoinedAt, 40_000)
  const randomRoomId = matchFound?.data.roomId as string | undefined
  await fillPrivateRoom(H1, Y1, room1)
  const privateFull = await waitFrame(H1, 'private_room_full', 0, 10_000)
  await sleep(1500)
  const playProbe = randomRoomId ? await injectAndCollect(A, [{ type: 'submit_play_card', roomId: randomRoomId, cardId: 'probe-invalid-card' }], 800) : []
  const aBalanceAfter = h.getBalance(adelka.profileId)
  await check('[S1] оригиналният случай: известието не се показва, директното сядане е отказано, мачовете не се застъпват', async () => {
    assert(searching, 'търсенето не тръгна')
    assert(!toastShown, 'известието с „Влез“ се показа по време на търсене')
    assert(errorsOf(directSeat).includes(QUEUE_TEXT), `директно сядане: ${JSON.stringify(errorsOf(directSeat))}`)
    assert(!isSeated(A, room1), 'седна на частната маса')
    assert(randomRoomId !== undefined, 'случайната маса не стартира')
    assert(privateFull !== null, 'частната маса не стартира с другите')
    assert(!A.received.some((f) => f.type === 'private_room_full'), 'Adelka е включена в частната игра')
    const privateGameId = privateFull?.data.roomId
    assert(!A.received.some((f) => f.type === 'room_snapshot' && (f.data?.roomId ?? f.data?.room?.id) === privateGameId), 'snapshot от частната игра')
    assert(!errorsOf(playProbe).includes('You are not attached to this room.'), `ход в случайната: ${JSON.stringify(errorsOf(playProbe))}`)
    assert(aBalanceAfter === BALANCE - STAKE, `баланс: ${aBalanceAfter} (очаквано ${BALANCE - STAKE})`)
  })

  // ═══ [S2] В активен мач ═════════════════════════════════════════════════
  const s2 = await injectAndCollect(A, [{ type: 'join_matchmaking', stake: STAKE }], 1000)
  const s2create = await injectAndCollect(A, [{ type: 'create_private_room', stake: STAKE, isLocked: false, waitMinutes: 15 }], 1000)
  const host7 = await register('h7')
  const H7 = await openParty('host7', host7)
  const room7 = await createRoomViaUi(H7, { manualStart: true })
  const s2join = await injectAndCollect(A, [{ type: 'join_private_room', privateRoomId: room7, team: 'B', slotIndex: 0 }], 1000)
  await check('[S2] в активен мач: търсене / създаване / сядане -> отказ (без нова маса и без място)', async () => {
    assert(!s2.some((f) => f.type === 'matchmaking_joined'), 'влезе в опашката')
    assert(errorsOf(s2).length > 0 || s2.some((f) => f.type === 'session_in_game'), `търсене: ${JSON.stringify(s2.map((f) => f.type))}`)
    assert(!s2create.some((f) => f.type === 'private_room_updated'), 'създаде частна маса')
    assert(s2create.some((f) => f.type === 'session_in_game') || errorsOf(s2create).length > 0, 'създаване: без отказ')
    assert(!isSeated(A, room7) && (s2join.some((f) => f.type === 'session_in_game') || errorsOf(s2join).length > 0), 'сядане: без отказ')
    assert(h.getBalance(adelka.profileId) === BALANCE - STAKE, 'балансът се промени')
  })

  // ═══ [S3] Седнал на частна маса ════════════════════════════════════════
  const seated = await register('seated')
  const S = await openParty('seated', seated, MOBILE)
  await injectAndCollect(S, [{ type: 'join_private_room', privateRoomId: room7, team: 'B', slotIndex: 0 }], 1500)
  const sSeated = isSeated(S, room7)
  await S.page.goto(`${h.appOrigin}/lobby`)
  await S.page.locator(LOBBY_READY).first().waitFor({ state: 'attached', timeout: 25_000 })
  await sleep(1500)
  const sSentBefore = S.sent.length
  await S.page.locator(`[data-lobby-stake-card="${STAKE}"]`).first().click()
  await sleep(1000)
  const promptShown = await S.page.evaluate(`document.body.textContent.includes('частна маса')`) as boolean
  const uiSentJoin = S.sent.slice(sSentBefore).some((f) => f.type === 'join_matchmaking')
  const s3 = await injectAndCollect(S, [{ type: 'join_matchmaking', stake: STAKE }], 1500)
  const S2dev = await openParty('seated-2nd-device', seated, DESKTOP)
  const s3b = await injectAndCollect(S2dev, [{ type: 'join_matchmaking', stake: STAKE }], 1500)
  await check('[S3] седнал на частна маса: предупреждение в интерфейса; директен join_matchmaking (и от второ устройство) -> отказ', async () => {
    assert(sSeated, '(setup) не седна')
    assert(promptShown && !uiSentJoin, `интерфейс: prompt=${promptShown}, join=${uiSentJoin}`)
    for (const [label, frames] of [['устройство 1', s3], ['устройство 2', s3b]] as const) {
      assert(!frames.some((f) => f.type === 'matchmaking_joined'), `${label}: влезе в опашката`)
      assert(errorsOf(frames).includes(SEAT_TEXT), `${label}: ${JSON.stringify(errorsOf(frames))}`)
      assert(frames.some((f) => f.type === 'matchmaking_left'), `${label}: клиентът не е върнат от екрана за търсене`)
    }
    assert(h.getBalance(seated.profileId) === BALANCE, 'удържан залог')
  })

  // ═══ [S4] В опашката ════════════════════════════════════════════════════
  const queued = await register('queued')
  const Q = await openParty('queued', queued)
  await startSearchViaUi(Q)
  const s4create = await injectAndCollect(Q, [{ type: 'create_private_room', stake: STAKE, isLocked: false, waitMinutes: 15 }], 1200)
  const s4join = await injectAndCollect(Q, [{ type: 'join_private_room', privateRoomId: room7, team: 'A', slotIndex: 1 }], 1200)
  await Q.page.locator('[data-matchmaking-room-cancel-button="1"]').first().click()
  await sleep(1200)
  const qLeft = Q.sent.some((f) => f.type === 'leave_matchmaking')
  const roomQ = qLeft ? await createRoomViaUi(Q, { manualStart: true }).catch(() => null) : null
  await check('[S4] в опашката: създаване / сядане -> отказ; след „Отказ“ създаването работи', async () => {
    assert(errorsOf(s4create).includes(QUEUE_TEXT) && !s4create.some((f) => f.type === 'private_room_updated'), `създаване: ${JSON.stringify(errorsOf(s4create))}`)
    assert(errorsOf(s4join).includes(QUEUE_TEXT) && !isSeated(Q, room7), `сядане: ${JSON.stringify(errorsOf(s4join))}`)
    assert(qLeft && roomQ !== null, 'нормалното създаване след отказ от търсенето не работи')
    assert(h.getBalance(queued.profileId) === BALANCE, 'удържан залог')
  })

  // ═══ [S5] Партньорска покана, приета по време на търсене ═══════════════
  const host5 = await register('h5')
  const friend5 = await register('f5')
  befriend(host5, friend5)
  const H5 = await openParty('host5', host5)
  const F5 = await openParty('friend5', friend5, MOBILE)
  const room5 = await createRoomViaUi(H5, { manualStart: true, partner: true })
  await startSearchViaUi(F5)
  const f5From = F5.received.length
  await injectAndCollect(H5, [{ type: 'invite_private_room_partner', toProfileId: friend5.profileId }], 1200)
  const inviteFrame = await waitFrame(F5, 'private_room_invite_received', f5From, 5_000)
  const s5 = inviteFrame ? await injectAndCollect(F5, [{ type: 'respond_private_room_invite', inviteId: inviteFrame.data.inviteId, accept: true }], 1500) : []
  await check('[S5] партньорска покана, приета по време на търсене -> отказ, не сяда', async () => {
    assert(inviteFrame !== null, '(setup) поканата не стигна')
    assert(errorsOf(s5).includes(QUEUE_TEXT), JSON.stringify(errorsOf(s5)))
    assert(!isSeated(F5, room5), 'седна')
  })

  // ═══ [S6] Едновременни заявки ═══════════════════════════════════════════
  const r1 = await register('race1')
  const r2 = await register('race2')
  const R1 = await openParty('race1', r1)
  const R2 = await openParty('race2', r2)
  const host6 = await register('h6')
  const H6 = await openParty('host6', host6)
  const room6 = await createRoomViaUi(H6, { manualStart: true })
  const race1 = await injectAndCollect(R1, [
    { type: 'join_private_room', privateRoomId: room6, team: 'B', slotIndex: 0 },
    { type: 'join_matchmaking', stake: STAKE },
  ], 1500)
  const race2 = await injectAndCollect(R2, [
    { type: 'join_matchmaking', stake: STAKE },
    { type: 'join_private_room', privateRoomId: room6, team: 'B', slotIndex: 1 },
  ], 1500)
  await check('[S6] едновременни заявки в един пакет -> точно едната успява (и в двата реда)', async () => {
    assert(isSeated(R1, room6) && !race1.some((f) => f.type === 'matchmaking_joined') && errorsOf(race1).includes(SEAT_TEXT), `сядане+търсене: ${JSON.stringify(race1.map((f) => f.type))}`)
    assert(race2.some((f) => f.type === 'matchmaking_joined') && !isSeated(R2, room6) && errorsOf(race2).includes(QUEUE_TEXT), `търсене+сядане: ${JSON.stringify(race2.map((f) => f.type))}`)
  })
  await injectAndCollect(R2, [{ type: 'leave_matchmaking' }], 800)

  // ═══ [S7] Нормален ръчен старт ═════════════════════════════════════════
  const y7 = await register('y7')
  const Y7 = await openParty('y7', y7)
  const r6Room = lastRoom(H6, room6)
  const free7 = r6Room.slots.find((s: any) => s.occupant === null && s.team === 'A')
  await injectAndCollect(Y7, [{ type: 'join_private_room', privateRoomId: room6, team: 'A', slotIndex: free7.slotIndex }], 1200)
  await injectAndCollect(R1, [{ type: 'add_bot_to_private_room_team', team: 'B' }], 1200)
  const h6From = H6.received.length
  await injectAndCollect(H6, [{ type: 'start_private_room' }], 2500)
  await check('[S7] нормален ръчен старт продължава да работи', async () => {
    assert(H6.received.slice(h6From).some((f) => f.type === 'private_room_full'), `домакин: ${JSON.stringify(errorsOf(H6.received.slice(h6From)))}`)
    assert(R1.received.some((f) => f.type === 'private_room_full'), 'седналият не влезе в играта')
  })
} catch (error) {
  console.error('  FAIL  неочаквана грешка:', error instanceof Error ? error.stack : error)
  console.error(h.serverOutput().split('\n').filter((l) => /error|exception|fatal|crash|unhandled|at .*\.ts:\d+/i.test(l)).slice(-25).join('\n'))
  await check('без неочаквани грешки', () => { throw error })
} finally {
  await h.close()
}
finishAndExit()
