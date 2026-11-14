/**
 * checkReplayParticipationGuardE2E.ts — „Едно Белот участие“ при екрана за
 * край на мача: докато играчът е прикрепен към приключилата стая и може да
 * избере „Преиграй“, не може да търси или да заеме друга маса; след нормално
 * напускане ограничението отпада; непосредствено преди повторния мач се
 * проверява за друго участие. Нормалното преиграване остава непроменено.
 *
 * Реален сървър (изолирано копие + празна SQLite база), реален Chromium. За да
 * не се играе мач до 151, в ИЗОЛИРАНОТО копие случайната маса е до 1 точка
 * (мачът свършва след първия рунд; ходовете на човека ги поема ботът).
 *
 *   Фаза A (без други промени):
 *   [F1] прикрепен към приключил мач: създаване / сядане на частна маса /
 *        търсене -> отказ;
 *   [F2] нормално „Преиграй“ -> повторният мач стартира, удържан е един залог;
 *   [F3] след нормално напускане (leave_active_room) -> създаването работи.
 *   Фаза B (fault injection: изключена входната защита на join_private_room,
 *   за да има вече възникнал конфликт):
 *   [F4] участник седи на чакаща частна маса -> „Преиграй“ НЕ стартира,
 *        гласът му става „изход“, без нов залог;
 *   [F5] след като освободи мястото -> „Преиграй“ стартира нормално.
 *
 *   node server/node_modules/tsx/dist/cli.mjs scripts/checkReplayParticipationGuardE2E.ts
 */

import type { BrowserContext, Page, WebSocketRoute } from 'playwright'
import { assert, check, finishAndExit, sleep, startGiftBackHarness, type GiftBackHarness, type ServerSourcePatch, type TestProfile } from './giftBackTestHarness'

console.log('\ncheckReplayParticipationGuardE2E\n')

const STAKE = 5000
const BALANCE = 50_000_000
const LOBBY_READY = '[data-lobby-private-rooms-card="1"]'
const FINISHED_TEXT = 'Първо излезте от приключилата игра.'

const SHORT_MATCH_PATCH: ServerSourcePatch = {
  file: 'index.ts',
  find: "activityCounters.incrementRooms('matchmakingMatchFound')\n\n    const initializedRoom = initializeRoomAuthoritativeGameState(result.room)",
  replace: "activityCounters.incrementRooms('matchmakingMatchFound')\n\n    const initializedRoom = initializeRoomAuthoritativeGameState({ ...result.room, config: { ...result.room.config, targetScore: 1 } })",
}
const BYPASS_PRIVATE_JOIN_GUARD: ServerSourcePatch = {
  file: 'index.ts',
  find: "if (sendBelotParticipationBlockedIfNeeded(connection.id, latestConnection.profileId, 'private_room', message.privateRoomId)) {",
  replace: "if (false && sendBelotParticipationBlockedIfNeeded(connection.id, latestConnection.profileId, 'private_room', message.privateRoomId)) {",
}

type Frame = { at: number; type: string; data: any }
type Party = { label: string; profile: TestProfile; page: Page; context: BrowserContext; received: Frame[]; inject: (m: unknown) => void }

async function startHarness(patches: ServerSourcePatch[]): Promise<GiftBackHarness> {
  const h = await startGiftBackHarness({ patchServerSource: patches })
  h.db.prepare(`INSERT INTO admin_settings (setting_key, setting_value) VALUES ('belot_random_table_wait_seconds', '20') ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value`).run()
  await h.restartServer()
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try { if ((await fetch(`${h.backendOrigin}/health`)).ok) break } catch { /* стара keep-alive връзка */ }
    await sleep(300)
  }
  return h
}
async function openParty(h: GiftBackHarness, label: string, profile: TestProfile): Promise<Party> {
  const context = await h.browser.newContext({ viewport: { width: 1280, height: 850 } })
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
  await page.goto(`${h.appOrigin}/lobby`)
  await page.locator(LOBBY_READY).first().waitFor({ state: 'attached', timeout: 25_000 })
  await page.waitForTimeout(800)
  return { label, profile, page, context, received, inject: (m) => current?.send(JSON.stringify(m)) }
}
async function register(h: GiftBackHarness, tag: string): Promise<TestProfile> {
  const p = await h.register(tag)
  h.setBalance(p.profileId, BALANCE)
  return p
}
async function waitFrame(p: Party, predicate: (f: Frame) => boolean, from: number, timeoutMs: number): Promise<Frame | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const f = p.received.slice(from).find(predicate)
    if (f) return f
    await sleep(250)
  }
  return null
}
async function injectAndCollect(p: Party, messages: unknown[], ms = 1500): Promise<Frame[]> {
  const from = p.received.length
  for (const m of messages) p.inject(m)
  await sleep(ms)
  return p.received.slice(from)
}
const errorsOf = (frames: Frame[]) => frames.filter((f) => f.type === 'error').map((f) => String(f.data.message))
const lastSnapshot = (p: Party, roomId: string) => [...p.received].reverse().find((f) => f.type === 'room_snapshot' && f.data?.roomId === roomId)?.data
// roomStatus 'finished' = авторитетна фаза match-ended (точкуването преди нея
// вече носи matchEnded, но мачът още се води активен).
const isMatchEnded = (f: Frame, roomId: string) => f.type === 'room_snapshot' && f.data?.roomId === roomId && f.data?.roomStatus === 'finished'

/** Случайна маса сам + ботове, до края на мача (1 точка). Връща roomId. */
async function playShortMatch(p: Party): Promise<string> {
  const from = p.received.length
  p.inject({ type: 'join_matchmaking', stake: STAKE })
  const found = await waitFrame(p, (f) => f.type === 'match_found', from, 45_000)
  assert(found !== null, `${p.label}: случайната маса не стартира`)
  return found.data.roomId as string
}
async function waitMatchEnded(p: Party, roomId: string): Promise<void> {
  const ended = await waitFrame(p, (f) => isMatchEnded(f, roomId), 0, 240_000)
  assert(ended !== null, `${p.label}: мачът не стигна до края`)
  await sleep(1000)
}
/** „Преиграй“ от човека; ботовете гласуват сами (по 1 s). */
async function voteReplay(p: Party, roomId: string): Promise<Frame[]> {
  return injectAndCollect(p, [{ type: 'request_replay', roomId }], 5000)
}
const replayStarted = (frames: Frame[], roomId: string) =>
  frames.some((f) => f.type === 'room_snapshot' && f.data?.roomId === roomId && f.data?.roomStatus !== 'finished' && f.data?.game?.matchEnded == null)

// ═══ Фаза A ═════════════════════════════════════════════════════════════════
{
  const h = await startHarness([SHORT_MATCH_PATCH])
  try {
    const [pU, pV, pW] = [await register(h, 'u'), await register(h, 'v'), await register(h, 'w')]
    const U = await openParty(h, 'U', pU)
    const V = await openParty(h, 'V', pV)
    const W = await openParty(h, 'W', pW)
    // Отворена частна маса на W (ръчен старт) — цел за сядане.
    W.inject({ type: 'create_private_room', stake: STAKE, isLocked: false, waitMinutes: 15, manualStart: true })
    const wRoom = await waitFrame(W, (f) => f.type === 'private_room_updated', 0, 10_000)
    assert(wRoom !== null, '(setup) масата на W')
    const privateRoomId = wRoom.data.room.id as string

    const uRoom = await playShortMatch(U)
    const vRoom = await playShortMatch(V)
    await waitMatchEnded(U, uRoom)
    await waitMatchEnded(V, vRoom)

    const f1create = await injectAndCollect(U, [{ type: 'create_private_room', stake: STAKE, isLocked: false, waitMinutes: 15 }])
    const f1join = await injectAndCollect(U, [{ type: 'join_private_room', privateRoomId, team: 'B', slotIndex: 0 }])
    const f1search = await injectAndCollect(U, [{ type: 'join_matchmaking', stake: STAKE }])
    await check('[F1] прикрепен към приключил мач: създаване / сядане / търсене -> отказ', async () => {
      assert(errorsOf(f1create).includes(FINISHED_TEXT) && !f1create.some((f) => f.type === 'private_room_updated'), `създаване: ${JSON.stringify(errorsOf(f1create))}`)
      assert(errorsOf(f1join).includes(FINISHED_TEXT) && !f1join.some((f) => f.type === 'private_room_updated'), `сядане: ${JSON.stringify(errorsOf(f1join))}`)
      assert(errorsOf(f1search).length > 0 && !f1search.some((f) => f.type === 'matchmaking_joined'), `търсене: ${JSON.stringify(f1search.map((f) => f.type))}`)
    })

    const uBalanceBefore = h.getBalance(pU.profileId)
    const f2 = await voteReplay(U, uRoom)
    const uBalanceAfter = h.getBalance(pU.profileId)
    await check('[F2] нормално „Преиграй“ -> повторният мач стартира; удържан е един залог', async () => {
      // Наградата от първия мач (ако е спечелен) вече е в баланса — сравнява се спрямо момента преди гласуването.
      assert(replayStarted(f2, uRoom), `повторният мач не стартира: ${JSON.stringify(lastSnapshot(U, uRoom)?.game?.matchEnded)}`)
      assert(uBalanceAfter === uBalanceBefore - STAKE, `баланс: ${uBalanceBefore} -> ${uBalanceAfter}`)
    })

    await injectAndCollect(V, [{ type: 'leave_active_room', roomId: vRoom }], 1500)
    const f3 = await injectAndCollect(V, [{ type: 'create_private_room', stake: STAKE, isLocked: false, waitMinutes: 15 }])
    await check('[F3] след нормално напускане ограничението отпада -> създаването работи', async () => {
      assert(f3.some((f) => f.type === 'private_room_updated'), `създаване: ${JSON.stringify(errorsOf(f3))}`)
    })
  } catch (error) {
    console.error('  FAIL  неочаквана грешка (фаза A):', error instanceof Error ? error.stack : error)
    await check('фаза A без неочаквани грешки', () => { throw error })
  } finally {
    await h.close()
  }
}

// ═══ Фаза B — вече възникнал конфликт ═══════════════════════════════════════
{
  const h = await startHarness([SHORT_MATCH_PATCH, BYPASS_PRIVATE_JOIN_GUARD])
  try {
    const [pX, pH] = [await register(h, 'x'), await register(h, 'hb')]
    const X = await openParty(h, 'X', pX)
    const H = await openParty(h, 'H', pH)
    H.inject({ type: 'create_private_room', stake: STAKE, isLocked: false, waitMinutes: 15, manualStart: true })
    const hRoom = await waitFrame(H, (f) => f.type === 'private_room_updated', 0, 10_000)
    assert(hRoom !== null, '(setup) масата на H')
    const privateRoomId = hRoom.data.room.id as string

    const xRoom = await playShortMatch(X)
    await waitMatchEnded(X, xRoom)
    const xSeat = lastSnapshot(X, xRoom)?.yourSeat
    const seatFrames = await injectAndCollect(X, [{ type: 'join_private_room', privateRoomId, team: 'B', slotIndex: 0 }])
    const seated = seatFrames.some((f) => f.type === 'private_room_updated' && f.data.room.slots.some((s: any) => s.occupant?.profileId === pX.profileId))

    const balanceBefore = h.getBalance(pX.profileId)
    const f4 = await voteReplay(X, xRoom)
    const ended4 = lastSnapshot(X, xRoom)?.game?.matchEnded
    await check('[F4] вече възникнал конфликт -> „Преиграй“ не стартира, гласът става „изход“, без нов залог', async () => {
      assert(seated, `(setup) X не седна на частната маса (fault injection): ${JSON.stringify(seatFrames.map((f) => f.type === 'error' ? `error:${f.data.message}` : f.type))}`)
      assert(!replayStarted(f4, xRoom), 'повторният мач стартира')
      assert(ended4 != null && Array.isArray(ended4.leaveVotes) && ended4.leaveVotes.includes(xSeat), `leaveVotes: ${JSON.stringify(ended4?.leaveVotes)} (място ${xSeat})`)
      assert(!ended4.replayVotes.includes(xSeat), `replayVotes: ${JSON.stringify(ended4.replayVotes)}`)
      assert(h.getBalance(pX.profileId) === balanceBefore, `баланс: ${balanceBefore} -> ${h.getBalance(pX.profileId)}`)
    })

    await injectAndCollect(X, [{ type: 'leave_private_room' }], 1200)
    const f5 = await voteReplay(X, xRoom)
    await check('[F5] след освобождаване на мястото -> „Преиграй“ стартира нормално', async () => {
      assert(replayStarted(f5, xRoom), `не стартира: ${JSON.stringify(lastSnapshot(X, xRoom)?.game?.matchEnded)}`)
      assert(h.getBalance(pX.profileId) === balanceBefore - STAKE, `баланс: ${h.getBalance(pX.profileId)}`)
    })
  } catch (error) {
    console.error('  FAIL  неочаквана грешка (фаза B):', error instanceof Error ? error.stack : error)
    await check('фаза B без неочаквани грешки', () => { throw error })
  } finally {
    await h.close()
  }
}

finishAndExit()
