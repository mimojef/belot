/**
 * checkTournamentParticipationCorrectionsE2E.ts — целеви проверки на
 * последните корекции към „Едно Белот участие“ при турнир:
 *
 *  [K1] край на обикновения мач при активен турнирен мач: „Преиграй“ и
 *       „Нова игра“ са скрити, „Към лобито“ остава (desktop и mobile);
 *  [K2] след „Отказ“ в „Започнал турнир“ -> в лобито няма автоматичен
 *       блокиращ modal / автоматичен вход за същия мач; ръчното влизане
 *       („Продължи играта“ в екрана на турнира) работи;
 *  [K3] административна отмяна -> tournament_participation_ended към
 *       записаните; отвореното турнирно известие се затваря;
 *  [K4] защитата по profileId при временно прекъсната връзка и при временно
 *       управление от бот в обикновения мач; доброволното напускане е
 *       непроменено (глоба) и след него входът в турнира е позволен.
 *
 * Реален сървър (изолирано копие, local tournament test mode), реален Vite и
 * Chromium. Само в ИЗОЛИРАНОТО копие: случайната маса е до 60 т. и dev
 * endpoint-ът за тестов турнир записва съществуващи профили.
 *
 *   node server/node_modules/tsx/dist/cli.mjs scripts/checkTournamentParticipationCorrectionsE2E.ts
 */

import { join } from 'node:path'
import { createRequire } from 'node:module'
import type { BrowserContext, Page, WebSocketRoute } from 'playwright'
import { assert, check, finishAndExit, sleep, startGiftBackHarness, type GiftBackHarness, type ServerSourcePatch, type TestProfile } from './giftBackTestHarness'

console.log('\ncheckTournamentParticipationCorrectionsE2E\n')

const { WebSocket } = createRequire(join(process.cwd(), 'server', 'package.json'))('ws') as typeof import('ws')
type RawWs = InstanceType<typeof WebSocket>

const BALANCE = 50_000_000
const LOBBY_READY = '[data-lobby-private-rooms-card="1"]'
const ACTIVE_MATCH_CONFLICT = 'Вече участвате в активна игра.'
const PROMPT = '[data-tournament-join-prompt="1"]'

const PATCHES: ServerSourcePatch[] = [
  {
    file: 'index.ts',
    find: "activityCounters.incrementRooms('matchmakingMatchFound')\n\n    const initializedRoom = initializeRoomAuthoritativeGameState(result.room)",
    replace: "activityCounters.incrementRooms('matchmakingMatchFound')\n\n    const initializedRoom = initializeRoomAuthoritativeGameState({ ...result.room, config: { ...result.room.config, targetScore: 60 } })",
  },
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

type Frame = { at: number; type: string; data: any }
type Party = {
  profile: TestProfile; page: Page; context: BrowserContext
  received: Frame[]; sent: Frame[]; requests: Array<{ at: number; url: string }>
  inject: (m: unknown) => void
  /** Синтетично „сървърно“ съобщение към страницата (само за тест). */
  pushToPage: (m: unknown) => void
}

async function waitFor<T>(label: string, fn: () => T | null | undefined | false | Promise<T | null | undefined | false>, timeoutMs: number, intervalMs = 250): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value as T
    await sleep(intervalMs)
  }
  throw new Error(`timeout: ${label}`)
}
async function visible(page: Page, selector: string): Promise<boolean> {
  return page.locator(selector).first().isVisible().catch(() => false)
}
async function rawConnect(h: GiftBackHarness, profile: TestProfile): Promise<{ ws: RawWs; frames: any[] }> {
  const ws = new WebSocket(`${h.backendOrigin.replace('http', 'ws')}/ws`, { headers: { Cookie: `belot_session=${profile.cookie}`, Origin: h.appOrigin } })
  const frames: any[] = []
  ws.on('message', (data) => { try { frames.push(JSON.parse(data.toString())) } catch { /* ignore */ } })
  await new Promise<void>((done, reject) => { ws.once('open', () => done()); ws.once('error', reject) })
  await waitFor('raw connected', () => frames.some((f) => f.type === 'connected'), 10_000)
  return { ws, frames }
}
async function closeRaw(raw: { ws: RawWs }): Promise<void> {
  await new Promise<void>((done) => { raw.ws.once('close', () => done()); raw.ws.close() })
  await sleep(500)
}

const h = await startGiftBackHarness({
  patchServerSource: PATCHES,
  databaseFileName: 'belot-v2-tournament-test.sqlite',
  env: {
    NODE_ENV: 'development',
    BELOT_LOCAL_TOURNAMENT_TEST_MODE: '1',
    BELOT_LOCAL_TOURNAMENT_ATTENDANCE_MS: '30000',
    BELOT_LOCAL_TOURNAMENT_TRANSITION_MS: '8000',
    BELOT_LOCAL_BOT_ACTION_MIN_MS: '60',
    BELOT_LOCAL_BOT_ACTION_MAX_MS: '120',
  },
})
h.db.prepare(`INSERT INTO admin_settings (setting_key, setting_value) VALUES ('belot_random_table_wait_seconds', '20') ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value`).run()
await h.restartServer()
for (let attempt = 0; attempt < 10; attempt += 1) {
  try { if ((await fetch(`${h.backendOrigin}/health`)).ok) break } catch { /* стара keep-alive връзка */ }
  await sleep(300)
}

async function register(tag: string): Promise<TestProfile> {
  // Стара keep-alive връзка след рестарта може да даде еднократно „fetch failed“.
  for (let attempt = 0; ; attempt += 1) {
    try {
      const p = await h.register(tag)
      h.setBalance(p.profileId, BALANCE)
      return p
    } catch (error) {
      if (attempt >= 3 || !(error instanceof Error) || !error.message.includes('fetch failed')) throw error
      await sleep(500)
    }
  }
}
async function openParty(profile: TestProfile): Promise<Party> {
  const context = await h.browser.newContext({ viewport: { width: 1366, height: 900 } })
  await context.addCookies([{ name: 'belot_session', value: profile.cookie, url: h.backendOrigin }])
  await context.addInitScript(`try { localStorage.setItem('pika-consent-v2', JSON.stringify({ version: 2, necessary: true, analytics: false, marketing: false, updatedAt: new Date().toISOString() })) } catch {}`)
  const received: Frame[] = []
  const sent: Frame[] = []
  const requests: Party['requests'] = []
  let server: WebSocketRoute | null = null
  let pageSide: WebSocketRoute | null = null
  const parse = (m: string | Buffer): any => { try { return JSON.parse(typeof m === 'string' ? m : m.toString('utf8')) } catch { return null } }
  await context.routeWebSocket(/\/ws(\?.*)?$/, (ws) => {
    const s = ws.connectToServer()
    ws.onMessage((m) => { const d = parse(m); if (d) sent.push({ at: Date.now(), type: String(d.type ?? ''), data: d }); s.send(m) })
    s.onMessage((m) => { const d = parse(m); if (d) received.push({ at: Date.now(), type: String(d.type ?? ''), data: d }); ws.send(m) })
    ws.onClose(() => s.close())
    s.onClose(() => ws.close())
    server = s
    pageSide = ws
  })
  const page = await context.newPage()
  page.on('request', (req) => requests.push({ at: Date.now(), url: req.url() }))
  page.on('pageerror', (error) => console.error(`    [pageerror] ${error.message}`))
  await page.goto(`${h.appOrigin}/lobby`)
  await page.locator(LOBBY_READY).first().waitFor({ state: 'attached', timeout: 25_000 })
  await page.waitForTimeout(800)
  return {
    profile, page, context, received, sent, requests,
    inject: (m) => server?.send(JSON.stringify(m)),
    pushToPage: (m) => pageSide?.send(JSON.stringify(m)),
  }
}
async function techState(tournamentId: string): Promise<any> {
  const body: any = await (await fetch(`${h.backendOrigin}/dev/tournament-test/api/state?tournamentId=${encodeURIComponent(tournamentId)}`)).json()
  return body.state ?? body
}
function matchOf(state: any, profileId: string): any {
  const teamId = state.entries.find((e: any) => e.profileId === profileId)?.teamId ?? null
  return state.matches.find((m: any) => (m.teamAId === teamId || m.teamBId === teamId) && m.status !== 'completed') ?? null
}
const replacementRows = (profileId: string) =>
  h.db.prepare(`SELECT status FROM tournament_match_no_show_replacements WHERE assigned_profile_id = ?`).all(profileId) as Array<{ status: string }>

try {
  const [pP, pD, pW, pA] = [await register('p'), await register('d'), await register('w'), await register('a')]

  // ── K3a: административна отмяна (реален път: турнир „Записване“) ──
  {
    h.db.prepare(`UPDATE accounts SET role = 'admin' WHERE account_id = (SELECT account_id FROM profiles WHERE profile_id = ?)`).run(pA.profileId)
    const createRes = await fetch(`${h.backendOrigin}/api/tournaments`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: `belot_session=${pW.cookie}` },
      body: JSON.stringify({ name: 'Отмяна К3', entryFee: 5000, visibility: 'public', startMode: 'fill' }),
    })
    const created: any = await createRes.json()
    const cancelTournamentId = created?.tournament?.tournamentId as string
    const joinRes = await fetch(`${h.backendOrigin}/api/tournaments/${cancelTournamentId}/join`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: `belot_session=${pW.cookie}` }, body: '{}',
    })
    const rawW = await rawConnect(h, pW)
    const cancelRes = await fetch(`${h.backendOrigin}/api/admin/tournaments/${cancelTournamentId}/cancel-open`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: `belot_session=${pA.cookie}` }, body: '{}',
    })
    const cancelBody: any = await cancelRes.json()
    await check('[K3a] административна отмяна -> записаните получават tournament_participation_ended (еднократно)', async () => {
      assert(createRes.status === 200 && joinRes.status === 200, `(setup) create=${createRes.status} join=${joinRes.status} ${JSON.stringify(created).slice(0, 200)}`)
      assert(cancelRes.status === 200 && cancelBody.ok === true && cancelBody.alreadyCancelled === false, JSON.stringify(cancelBody))
      await waitFor('participation_ended', () => rawW.frames.some((f) => f.type === 'tournament_participation_ended' && f.tournamentId === cancelTournamentId), 5000)
      const again = await fetch(`${h.backendOrigin}/api/admin/tournaments/${cancelTournamentId}/cancel-open`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: `belot_session=${pA.cookie}` }, body: '{}',
      })
      await again.json()
      await sleep(800)
      const count = rawW.frames.filter((f) => f.type === 'tournament_participation_ended').length
      assert(count === 1, `известия: ${count}`)
    })
    await closeRaw(rawW)
  }

  // ── Подготовка: P (браузър) и D (raw) в обикновени мачове, после турнир ──
  const P = await openParty(pP)
  const pFrom = P.received.length
  P.inject({ type: 'join_matchmaking', stake: 5000 })
  const rawD1 = await rawConnect(h, pD)
  rawD1.ws.send(JSON.stringify({ type: 'join_matchmaking', stake: 8000 }))
  const pFound = await waitFor('P match_found', () => P.received.slice(pFrom).find((f) => f.type === 'match_found'), 50_000)
  const dFound = await waitFor('D match_found', () => rawD1.frames.find((f) => f.type === 'match_found'), 50_000)
  const nRoom = pFound.data.roomId as string
  const dRoom = dFound.roomId as string

  const createRes = await fetch(`${h.backendOrigin}/dev/tournament-test/api/create`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamCapacity: 4, mode: 'one_human', existingHumanProfileIds: [pP.profileId, pD.profileId] }),
  })
  const createdT: any = await createRes.json()
  assert(createdT.ok === true, `create tournament: ${JSON.stringify(createdT).slice(0, 300)}`)
  const tournamentId = createdT.tournamentId as string
  await waitFor('tournament rooms', async () => {
    const s = await techState(tournamentId)
    return s.matches.length === 2 && s.matches.every((m: any) => m.roomId !== null)
  }, 20_000)

  // ── K3b (клиент): съществуващото известие се затваря при край на участието ──
  await check('[K3b] съществуващото известие по време на другата игра се затваря при tournament_participation_ended', async () => {
    await P.page.locator('#tms-popup').waitFor({ state: 'visible', timeout: 10_000 })
    P.pushToPage({ type: 'tournament_participation_ended', tournamentId })
    await P.page.waitForFunction(() => document.querySelector('#tms-popup') === null && document.querySelector('#tms-popup-mini') === null, null, { timeout: 900, polling: 50 })
  })

  // ── K4: защитата по profileId — временно прекъсната връзка ──
  await closeRaw(rawD1)
  const rawD2 = await rawConnect(h, pD)
  await check('[K4a] временно прекъсната връзка: връщането (session_in_game) сочи обикновения мач, не турнира', async () => {
    const session = await waitFor('session_in_game', () => rawD2.frames.find((f) => f.type === 'session_in_game'), 8000)
    assert(session.roomId === dRoom, `session -> ${session.roomId} (обикновен ${dRoom})`)
  })
  await check('[K4b] временно прекъсната връзка: вход в турнира се отказва по profileId', async () => {
    const assignment = (await waitFor('assignment', () => [...rawD2.frames].reverse().find((f) => f.type === 'tournament_match_assigned'), 8000)).assignment
    rawD2.ws.send(JSON.stringify({ type: 'resume_room', roomId: assignment.roomId, reconnectToken: assignment.reconnectToken }))
    const failed = await waitFor('room_resume_failed', () => rawD2.frames.find((f) => f.type === 'room_resume_failed'), 8000)
    assert(failed.message === ACTIVE_MATCH_CONFLICT, failed.message)
    assert(!rawD2.frames.some((f) => f.type === 'room_resumed'), 'room_resumed')
  })
  await check('[K4c] онлайн, но с място в обикновения мач (не прикрепен) -> неявил се -> бот „вместо D“ на срока', async () => {
    await waitFor('replacement for D', () => replacementRows(pD.profileId).some((r) => r.status === 'active'), 45_000)
  })

  // ── K4: временно управление от бот (прикрепен, ходовете изтичат) ──
  const session = rawD2.frames.find((f) => f.type === 'session_in_game')
  rawD2.ws.send(JSON.stringify({ type: 'resume_room', roomId: session.roomId, reconnectToken: session.reconnectToken }))
  await waitFor('D room_resumed N', () => rawD2.frames.find((f) => f.type === 'room_resumed' && f.roomId === dRoom), 8000)
  const botControlled = await waitFor('D controlled by bot', () => {
    const snap = [...rawD2.frames].reverse().find((f) => f.type === 'room_snapshot' && f.roomId === dRoom)
    const seat = snap?.seats?.find((s: any) => s.profileId === pD.profileId)
    return seat?.isControlledByBot === true ? snap : null
  }, 60_000, 500).catch(() => null)
  await check('[K4d] временно управление от бот в обикновения мач: вход в турнира от друго устройство се отказва', async () => {
    assert(botControlled !== null, '(setup) мястото на D не мина под бот контрол')
    const rawD3 = await rawConnect(h, pD)
    try {
      const assignment = (await waitFor('assignment', () => [...rawD3.frames].reverse().find((f) => f.type === 'tournament_match_assigned'), 8000)).assignment
      rawD3.ws.send(JSON.stringify({ type: 'resume_room', roomId: assignment.roomId, reconnectToken: assignment.reconnectToken }))
      const failed = await waitFor('room_resume_failed', () => rawD3.frames.find((f) => f.type === 'room_resume_failed'), 8000)
      assert(failed.message === ACTIVE_MATCH_CONFLICT, failed.message)
      assert(!rawD2.frames.some((f) => f.type === 'session_displaced'), 'първото устройство беше изместено')
    } finally {
      await closeRaw(rawD3)
    }
  })

  await check('[K4e] доброволно напускане — непроменено (глоба), след него входът в турнира е позволен', async () => {
    const dStillPlaying = ![...rawD2.frames].some((f) => f.type === 'room_snapshot' && f.roomId === dRoom && f.roomStatus === 'finished')
    const from = rawD2.frames.length
    rawD2.ws.send(JSON.stringify({ type: 'leave_active_room', roomId: dRoom, acceptPenalty: true }))
    const left = await waitFor('left_active_room', () => rawD2.frames.slice(from).find((f) => f.type === 'left_active_room'), 8000)
    if (dStillPlaying) assert(left.penalty !== undefined && left.penalty.penaltyAmount > 0, `глоба: ${JSON.stringify(left.penalty)}`)
    const assignment = [...rawD2.frames].reverse().find((f) => f.type === 'tournament_match_assigned').assignment
    rawD2.ws.send(JSON.stringify({ type: 'resume_room', roomId: assignment.roomId, reconnectToken: assignment.reconnectToken }))
    await waitFor('room_resumed T', () => rawD2.frames.slice(from).find((f) => f.type === 'room_resumed' && f.roomId === assignment.roomId), 8000)
    await waitFor('D replacement completed', () => replacementRows(pD.profileId).every((r) => r.status === 'completed'), 8000)
  })
  await closeRaw(rawD2)

  // ── K1: край на обикновения мач на P ──
  await waitFor('P N match-ended', () => P.received.some((f) => f.type === 'room_snapshot' && f.data.roomId === nRoom && f.data.roomStatus === 'finished'), 400_000, 500)
  await P.page.locator(PROMPT).waitFor({ state: 'visible', timeout: 10_000 })
  await check('[K1] desktop: „Преиграй“ и „Нова игра“ са скрити, „Към лобито“ остава', async () => {
    assert(await P.page.locator('[data-match-ended-replay-button="1"]').count() === 0, '„Преиграй“')
    assert(await P.page.locator('[data-match-ended-new-game-button="1"]').count() === 0, '„Нова игра“')
    assert(await visible(P.page, '[data-match-ended-lobby-button="1"]'), 'няма „Към лобито“')
  })
  await check('[K1] mobile: „Преиграй“ и „Нова игра“ са скрити, „Към лобито“ остава', async () => {
    await P.page.setViewportSize({ width: 390, height: 844 })
    await sleep(1600)
    assert(await P.page.locator('[data-match-ended-replay-button="1"]').count() === 0, '„Преиграй“')
    assert(await P.page.locator('[data-match-ended-new-game-button="1"]').count() === 0, '„Нова игра“')
    assert(await visible(P.page, '[data-match-ended-lobby-button="1"]'), 'няма „Към лобито“')
    await P.page.setViewportSize({ width: 1366, height: 900 })
    await sleep(1200)
  })

  // ── K2: „Отказ“ -> лоби без автоматичен modal; ръчно влизане ──
  await P.page.locator('[data-tournament-join-dismiss="1"]').click()
  await P.page.locator('[data-match-ended-lobby-button="1"]').first().click()
  const lobbyFrom = Date.now()
  await sleep(8000)
  await check('[K2a] след „Отказ“: в лобито няма автоматичен блокиращ modal и автоматичен вход за същия мач', async () => {
    assert(!(await visible(P.page, '[data-tournament-reclaim-button="1"]')), 'блокиращият modal се показа')
    const resumes = P.sent.filter((f) => f.at >= lobbyFrom && f.type === 'resume_room').length
    assert(resumes === 0, `resume_room: ${resumes}`)
    const detailFetches = P.requests.filter((r) => r.at >= lobbyFrom && r.url.includes(`/api/tournaments/${tournamentId}`)).length
    assert(detailFetches === 0, `HTTP заявки: ${detailFetches}`)
    assert(replacementRows(pP.profileId).some((r) => r.status === 'active'), 'ботът вече не пази мястото')
  })
  await check('[K2b] ръчно включване: екран на турнира -> „Продължи играта“ -> поемане от бота', async () => {
    // Като потребител: списъкът с турнири -> картата на турнира.
    await P.page.goto(`${h.appOrigin}/tournaments`)
    const card = P.page.locator(`[data-tournament-card="${tournamentId}"]`).first()
    await card.waitFor({ state: 'visible', timeout: 20_000 })
    await card.click()
    const button = P.page.locator('[data-tournament-enter-active-match="1"]').first()
    await button.waitFor({ state: 'visible', timeout: 20_000 })
    assert(!(await visible(P.page, '[data-tournament-reclaim-button="1"]')), 'блокиращият modal се показа след презареждане')
    const from = P.received.length
    await button.click()
    const pMatch = matchOf(await techState(tournamentId), pP.profileId)
    await waitFor('P room_resumed T', () => P.received.slice(from).find((f) => f.type === 'room_resumed' && f.data.roomId === pMatch.roomId), 15_000)
    await waitFor('P replacement completed', () => replacementRows(pP.profileId).every((r) => r.status === 'completed'), 10_000)
  })

  // ── K3c (клиент): отвореното „Започнал турнир“ се затваря при край на участието ──
  await check('[K3c] отвореното „Започнал турнир“ се затваря при tournament_participation_ended (без polling)', async () => {
    const fakeTournamentId = 'k3c-tournament'
    P.pushToPage({
      type: 'belot_match_ended_tournament_status', roomId: 'k3c-room', replayBlocked: true,
      assignment: { tournamentId: fakeTournamentId, tournamentName: 'К3', matchId: 'k3c-match', roomId: 'k3c-room-t', roundType: 'semifinal', seat: 'bottom', teamId: 't', partnerProfileId: 'x', opponentTeamId: 'y', reconnectToken: 'tok', deadlineKind: 'first_match', attendanceDeadlineAt: null, gameStartAt: null, matchStatus: 'in_progress' },
    })
    await P.page.locator(PROMPT).waitFor({ state: 'visible', timeout: 5000 })
    P.pushToPage({ type: 'tournament_participation_ended', tournamentId: fakeTournamentId })
    await P.page.locator(PROMPT).waitFor({ state: 'hidden', timeout: 3000 })
  })
} catch (error) {
  console.error('  FAIL  неочаквана грешка:', error instanceof Error ? error.stack : error)
  await check('без неочаквани грешки', () => { throw error })
} finally {
  await h.close()
}

finishAndExit()
