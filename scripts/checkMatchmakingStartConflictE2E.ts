/**
 * checkMatchmakingStartConflictE2E.ts — „Едно Белот участие“, проверката
 * НЕПОСРЕДСТВЕНО ПРЕДИ старт на случайна маса при ВЕЧЕ ВЪЗНИКНАЛ конфликт.
 *
 * След поправката конфликтът не може да се получи през входните пътища
 * (те го отказват), затова се инжектира: в ИЗОЛИРАНОТО копие на сървъра
 * (giftBackTestHarness.patchServerSource) са изключени само входните защити
 * на join_private_room и join_matchmaking. Проверката преди старт и
 * икономиката са реалният код. Реален сървър, реален Chromium.
 *
 *   P — в опашката (залогът е удържан), после сяда на чакаща частна маса;
 *   R — в активна случайна игра, после влиза в опашката (залогът е удържан);
 *   Q, S — нормални играчи в същата опашка.
 *
 *   [M0] R е изваден още при ВЕДНАГА формираната пълна група (4 души), P —
 *        при изтичане на таймера (и двата момента на старт);
 *   [M1] групата НЕ включва P и R; Q и S стартират (групата е преизчислена);
 *   [M2] P: matchmaking_left + съобщението за частната маса, остава седнал;
 *        R: matchmaking_left, активната му игра не е прекратена;
 *   [M3] залогът от опашката е върнат ТОЧНО веднъж (баланс + ledger), а
 *        по-късното затваряне на връзките не връща нищо допълнително;
 *   [M4] Q и S: удържан е точно един залог; P и R не са в новата игра.
 *
 *   node server/node_modules/tsx/dist/cli.mjs scripts/checkMatchmakingStartConflictE2E.ts
 */

import type { BrowserContext, Page, WebSocketRoute } from 'playwright'
import { assert, check, finishAndExit, sleep, startGiftBackHarness, type TestProfile } from './giftBackTestHarness'

console.log('\ncheckMatchmakingStartConflictE2E\n')

const h = await startGiftBackHarness({
  patchServerSource: [
    // P: сядане на частна маса въпреки записа в опашката.
    {
      file: 'index.ts',
      find: "if (sendBelotParticipationBlockedIfNeeded(connection.id, latestConnection.profileId, 'private_room', message.privateRoomId)) {",
      replace: "if (false && sendBelotParticipationBlockedIfNeeded(connection.id, latestConnection.profileId, 'private_room', message.privateRoomId)) {",
    },
    // R: влизане в опашката въпреки активната игра (трите входни проверки на join_matchmaking).
    {
      file: 'index.ts',
      find: "        if (latestConnection.currentRoomId !== null) {\n          safeSendToConnection(connection.id, {\n            type: 'error',\n            message: 'Вече си в активна игра.',\n          })\n          return\n        }\n\n        if (latestConnection.profileId === null) {",
      replace: "        if (false && latestConnection.currentRoomId !== null) {\n          return\n        }\n\n        if (latestConnection.profileId === null) {",
    },
    {
      file: 'index.ts',
      find: 'const profileId = publicProfile.profileId ?? latestConnection.profileId\n        if (sendSessionInGameIfNeeded(connection.id, profileId)) {',
      replace: 'const profileId = publicProfile.profileId ?? latestConnection.profileId\n        if (false && sendSessionInGameIfNeeded(connection.id, profileId)) {',
    },
    {
      file: 'index.ts',
      find: "if (sendBelotParticipationBlockedIfNeeded(connection.id, profileId, 'matchmaking')) {",
      replace: "if (false && sendBelotParticipationBlockedIfNeeded(connection.id, profileId, 'matchmaking')) {",
    },
  ],
})
h.db.prepare(`INSERT INTO admin_settings (setting_key, setting_value) VALUES ('belot_random_table_wait_seconds', '20') ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value`).run()
await h.restartServer()
for (let attempt = 0; attempt < 10; attempt += 1) {
  try { if ((await fetch(`${h.backendOrigin}/health`)).ok) break } catch { /* стара keep-alive връзка */ }
  await sleep(300)
}

const STAKE = 5000
const BALANCE = 50_000_000
const LOBBY_READY = '[data-lobby-private-rooms-card="1"]'
const SEAT_TEXT = 'Имате място на чакаща частна маса. Напуснете го, преди да търсите случайна маса.'

type Frame = { at: number; type: string; data: any }
type Party = { label: string; profile: TestProfile; page: Page; context: BrowserContext; received: Frame[]; inject: (m: unknown) => void }

async function openParty(label: string, profile: TestProfile): Promise<Party> {
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
async function register(tag: string): Promise<TestProfile> {
  const p = await h.register(tag)
  h.setBalance(p.profileId, BALANCE)
  return p
}
async function waitFrame(p: Party, predicate: (f: Frame) => boolean, from: number, timeoutMs: number): Promise<Frame | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const f = p.received.slice(from).find(predicate)
    if (f) return f
    await sleep(200)
  }
  return null
}
const ledger = (profileId: string, entryType: 'stake_debit' | 'stake_refund') =>
  (h.db.prepare(`SELECT COUNT(*) AS n FROM match_economy_ledger WHERE profile_id = ? AND entry_type = ? AND room_id LIKE 'queue:%'`).get(profileId, entryType) as { n: number }).n

try {
  const [pP, pQ, pR, pS, pH] = [await register('p'), await register('q'), await register('r'), await register('s'), await register('h')]
  const [P, Q, R, S, H] = [await openParty('P', pP), await openParty('Q', pQ), await openParty('R', pR), await openParty('S', pS), await openParty('H', pH)]

  // R: активна случайна игра (сам + ботове).
  const rFrom = R.received.length
  R.inject({ type: 'join_matchmaking', stake: STAKE })
  const rGame = await waitFrame(R, (f) => f.type === 'match_found', rFrom, 40_000)
  assert(rGame !== null, '(setup) R не влезе в игра')
  const rGameId = rGame.data.roomId as string
  await sleep(1500)

  // Чакаща частна маса (ръчен старт, за да не стартира сама).
  H.inject({ type: 'create_private_room', stake: STAKE, isLocked: false, waitMinutes: 15, manualStart: true })
  const created = await waitFrame(H, (f) => f.type === 'private_room_updated', 0, 10_000)
  assert(created !== null, '(setup) частната маса не е създадена')
  const privateRoomId = created.data.room.id as string

  // Опашката: P, Q, S и R (с изключената входна защита) — залозите се удържат.
  const marks = { P: P.received.length, Q: Q.received.length, R: R.received.length, S: S.received.length }
  for (const p of [P, Q, S, R]) { p.inject({ type: 'join_matchmaking', stake: STAKE }); await sleep(300) }
  // Изчакване на реалните удръжки в опашката (R: втори запис в ledger-а).
  for (let i = 0; i < 40 && !(ledger(pP.profileId, 'stake_debit') === 1 && ledger(pR.profileId, 'stake_debit') === 2); i += 1) await sleep(250)
  const debitedInQueue = { P: h.getBalance(pP.profileId), R: h.getBalance(pR.profileId) }
  const rQueued = R.received.slice(marks.R).some((f) => f.type === 'matchmaking_joined')
  // 4 души в опашката -> пълна група се формира ВЕДНАГА: проверката преди старт
  // вади R още тогава; групата се преизчислява (P, Q, S) и чака таймера.
  const rRefundedAtImmediateStart = ledger(pR.profileId, 'stake_refund') === 1

  // P сяда на частната маса (с изключената входна защита) -> вече възникнал конфликт.
  P.inject({ type: 'join_private_room', privateRoomId, team: 'B', slotIndex: 0 })
  const pSeated = await waitFrame(P, (f) => f.type === 'private_room_updated' && f.data.room.id === privateRoomId, 0, 5_000)

  // Групата се формира при изтичане на таймера (20 s).
  const qFound = await waitFrame(Q, (f) => f.type === 'match_found', marks.Q, 40_000)
  const sFound = await waitFrame(S, (f) => f.type === 'match_found', marks.S, 5_000)
  await sleep(2000)
  const pFrames = P.received.slice(marks.P)
  const rFrames = R.received.slice(marks.R)
  const afterStart = {
    P: h.getBalance(pP.profileId), Q: h.getBalance(pQ.profileId), R: h.getBalance(pR.profileId), S: h.getBalance(pS.profileId),
  }

  await check('[M0] (setup) конфликтът е възникнал: P и R са платили залог в опашката, P седи на частната маса', async () => {
    assert(debitedInQueue.P === BALANCE - STAKE, `P баланс в опашката: ${debitedInQueue.P}`)
    assert(rQueued, 'R не влезе в опашката')
    assert(ledger(pR.profileId, 'stake_debit') === 2, `R: удръжки в опашката ${ledger(pR.profileId, 'stake_debit')} (игра + втори запис)`)
    assert(rRefundedAtImmediateStart && debitedInQueue.R === BALANCE - STAKE, `R: пълната група (4 души) трябваше да го извади веднага с връщане; баланс ${debitedInQueue.R}`)
    assert(pSeated !== null && pSeated.data.room.slots.some((s: any) => s.occupant?.profileId === pP.profileId), 'P не седна')
  })
  await check('[M1] групата не включва P и R; Q и S стартират в една нова игра', async () => {
    assert(qFound !== null && sFound !== null && qFound.data.roomId === sFound.data.roomId, 'Q/S не стартираха заедно')
    assert(!pFrames.some((f) => f.type === 'match_found'), 'P е включен в случайната игра')
    assert(!rFrames.some((f) => f.type === 'match_found'), 'R е включен във втора игра')
    assert(qFound!.data.roomId !== rGameId, 'новата игра е старата игра на R')
  })
  await check('[M2] P: matchmaking_left + съобщение, остава седнал; R: matchmaking_left, активната игра продължава', async () => {
    assert(pFrames.filter((f) => f.type === 'matchmaking_left' && f.data.removed === true).length === 1, `P matchmaking_left: ${pFrames.filter((f) => f.type === 'matchmaking_left').length}`)
    assert(pFrames.filter((f) => f.type === 'error' && f.data.message === SEAT_TEXT).length === 1, 'P: съобщението липсва или е двойно')
    const pRoom = [...P.received].reverse().find((f) => f.type === 'private_room_updated' && f.data.room.id === privateRoomId)
    assert(pRoom?.data.room.slots.some((s: any) => s.occupant?.profileId === pP.profileId), 'P загуби мястото на частната маса')
    assert(rFrames.filter((f) => f.type === 'matchmaking_left' && f.data.removed === true).length === 1, 'R matchmaking_left')
    const probeFrom = R.received.length
    R.inject({ type: 'submit_play_card', roomId: rGameId, cardId: 'probe-invalid-card' })
    await sleep(800)
    const probeErrors = R.received.slice(probeFrom).filter((f) => f.type === 'error').map((f) => f.data.message)
    assert(!probeErrors.includes('You are not attached to this room.') && !probeErrors.includes('Room was not found.'), `R игра: ${JSON.stringify(probeErrors)}`)
  })

  // Затваряне на връзките (close handler вика removeConnectionFromMatchmaking).
  await P.context.close()
  await R.context.close()
  await sleep(2500)
  const afterClose = { P: h.getBalance(pP.profileId), R: h.getBalance(pR.profileId) }
  await check('[M3] залогът от опашката е върнат точно веднъж; затварянето не връща втори път', async () => {
    assert(afterStart.P === BALANCE && afterClose.P === BALANCE, `P: след старта ${afterStart.P}, след затваряне ${afterClose.P}`)
    assert(afterStart.R === BALANCE - STAKE && afterClose.R === BALANCE - STAKE, `R: след старта ${afterStart.R}, след затваряне ${afterClose.R} (очаквано само залогът на активната игра)`)
    assert(ledger(pP.profileId, 'stake_debit') === 1 && ledger(pP.profileId, 'stake_refund') === 1, `P ledger: debit=${ledger(pP.profileId, 'stake_debit')} refund=${ledger(pP.profileId, 'stake_refund')}`)
    assert(ledger(pR.profileId, 'stake_debit') === 2 && ledger(pR.profileId, 'stake_refund') === 1, `R ledger: debit=${ledger(pR.profileId, 'stake_debit')} refund=${ledger(pR.profileId, 'stake_refund')}`)
  })
  await check('[M4] Q и S: удържан е точно един залог, без връщане', async () => {
    for (const [label, profile, balance] of [['Q', pQ, afterStart.Q], ['S', pS, afterStart.S]] as const) {
      assert(balance === BALANCE - STAKE, `${label} баланс: ${balance}`)
      assert(ledger(profile.profileId, 'stake_debit') === 1 && ledger(profile.profileId, 'stake_refund') === 0, `${label} ledger`)
    }
  })
} catch (error) {
  console.error('  FAIL  неочаквана грешка:', error instanceof Error ? error.stack : error)
  console.error(h.serverOutput().split('\n').filter((l) => /error|exception|fatal|unhandled/i.test(l)).slice(-20).join('\n'))
  await check('без неочаквани грешки', () => { throw error })
} finally {
  await h.close()
}
finishAndExit()
