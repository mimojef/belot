/**
 * checkTournamentBelotParticipationE2E.ts — Едно Белот участие при турнир
 * (Вариант Б): играч, зает в друг Belot мач, се счита за неявил се;
 * съществуващото известие по време на другата игра; новото „Започнал турнир“
 * след края ѝ; блокиран „Преиграй“; предимство на турнира пред опашката и
 * чакащите частни маси; второ устройство.
 *
 * Реален сървър (изолирано копие, local tournament test mode — реален
 * coordinator/scheduler/runtime, ускорени tick-ове/срокове/ботове, отделна
 * временна база), реален Vite frontend, реален Chromium. Само в ИЗОЛИРАНОТО
 * копие: случайната маса е до 40 т. (фаза A) / 1 т. (фаза B), турнирният мач
 * във фаза B е до 1 т., а dev endpoint-ът за тестов турнир записва
 * съществуващи профили.
 *
 *   node server/node_modules/tsx/dist/cli.mjs scripts/checkTournamentBelotParticipationE2E.ts
 */

import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import type { BrowserContext, Page, WebSocketRoute } from 'playwright'
import { assert, check, finishAndExit, sleep, startGiftBackHarness, type GiftBackHarness, type ServerSourcePatch, type TestProfile } from './giftBackTestHarness'

console.log('\ncheckTournamentBelotParticipationE2E\n')

const { WebSocket } = createRequire(join(process.cwd(), 'server', 'package.json'))('ws') as typeof import('ws')
type RawWs = InstanceType<typeof WebSocket>

const STAKE = 5000
const QUEUE_STAKE = 8000
const BALANCE = 50_000_000
const LOBBY_READY = '[data-lobby-private-rooms-card="1"]'
const TOURNAMENT_CONFLICT = 'Имате активен турнирен мач.'
const ACTIVE_MATCH_CONFLICT = 'Вече участвате в активна игра.'
const PROMPT_TITLE = 'Започнал турнир'
const PROMPT_TEXT = 'В момента се провежда турнирен мач с Ваше участие. Желаете ли да се включите?'
const TEST_DB = 'belot-v2-tournament-test.sqlite'
const screenshotsDir = join(tmpdir(), 'tournament-belot-participation-e2e')

const randomTableTarget = (points: number): ServerSourcePatch => ({
  file: 'index.ts',
  find: "activityCounters.incrementRooms('matchmakingMatchFound')\n\n    const initializedRoom = initializeRoomAuthoritativeGameState(result.room)",
  replace: `activityCounters.incrementRooms('matchmakingMatchFound')\n\n    const initializedRoom = initializeRoomAuthoritativeGameState({ ...result.room, config: { ...result.room.config, targetScore: ${points} } })`,
})
const TOURNAMENT_ONE_POINT: ServerSourcePatch = {
  file: 'tournament/tournamentCoordinator.ts',
  find: 'targetScore: 151,',
  replace: 'targetScore: 1,',
}
// Dev endpoint-ът записва подадените съществуващи профили вместо нови тестови акаунти.
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

type Frame = { at: number; type: string; data: any }
type Party = {
  label: string; profile: TestProfile; page: Page; context: BrowserContext
  received: Frame[]; sent: Frame[]; requests: Array<{ at: number; url: string }>; inject: (m: unknown) => void
}

async function startHarness(patches: ServerSourcePatch[], attendanceMs: number, transitionMs: number): Promise<GiftBackHarness> {
  const h = await startGiftBackHarness({
    patchServerSource: [...patches, ...EXISTING_HUMANS_PATCHES],
    databaseFileName: TEST_DB,
    env: {
      NODE_ENV: 'development',
      BELOT_LOCAL_TOURNAMENT_TEST_MODE: '1',
      BELOT_LOCAL_TOURNAMENT_ATTENDANCE_MS: String(attendanceMs),
      BELOT_LOCAL_TOURNAMENT_TRANSITION_MS: String(transitionMs),
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
  return h
}

async function openParty(h: GiftBackHarness, label: string, profile: TestProfile, mobile = false): Promise<Party> {
  const context = await h.browser.newContext(mobile
    ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
    : { viewport: { width: 1366, height: 900 } })
  await context.addCookies([{ name: 'belot_session', value: profile.cookie, url: h.backendOrigin }])
  await context.addInitScript(`try { localStorage.setItem('pika-consent-v2', JSON.stringify({ version: 2, necessary: true, analytics: false, marketing: false, updatedAt: new Date().toISOString() })) } catch {}`)
  const received: Frame[] = []
  const sent: Frame[] = []
  const requests: Party['requests'] = []
  let current: WebSocketRoute | null = null
  const parse = (m: string | Buffer): any => { try { return JSON.parse(typeof m === 'string' ? m : m.toString('utf8')) } catch { return null } }
  await context.routeWebSocket(/\/ws(\?.*)?$/, (ws) => {
    const server = ws.connectToServer()
    ws.onMessage((m) => { const d = parse(m); if (d) sent.push({ at: Date.now(), type: String(d.type ?? ''), data: d }); server.send(m) })
    server.onMessage((m) => { const d = parse(m); if (d) received.push({ at: Date.now(), type: String(d.type ?? ''), data: d }); ws.send(m) })
    ws.onClose(() => server.close())
    server.onClose(() => ws.close())
    current = server
  })
  const page = await context.newPage()
  page.on('request', (req) => requests.push({ at: Date.now(), url: req.url() }))
  page.on('pageerror', (error) => console.error(`    [pageerror ${label}] ${error.message}`))
  await page.goto(`${h.appOrigin}/lobby`)
  await page.locator(LOBBY_READY).first().waitFor({ state: 'attached', timeout: 25_000 })
  await page.waitForTimeout(800)
  return { label, profile, page, context, received, sent, requests, inject: (m) => current?.send(JSON.stringify(m)) }
}

async function register(h: GiftBackHarness, tag: string): Promise<TestProfile> {
  const p = await h.register(tag)
  h.setBalance(p.profileId, BALANCE)
  return p
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
const frameAfter = (p: Party, from: number, predicate: (f: Frame) => boolean) => p.received.slice(from).find(predicate) ?? null
const errorsOf = (frames: Frame[]) => frames.filter((f) => f.type === 'error').map((f) => String(f.data.message))
const isMatchEnded = (f: Frame, roomId: string) => f.type === 'room_snapshot' && f.data?.roomId === roomId && f.data?.roomStatus === 'finished'
async function injectAndCollect(p: Party, messages: unknown[], ms = 1500): Promise<Frame[]> {
  const from = p.received.length
  for (const m of messages) p.inject(m)
  await sleep(ms)
  return p.received.slice(from)
}
async function visible(page: Page, selector: string): Promise<boolean> {
  return page.locator(selector).first().isVisible().catch(() => false)
}
async function insideViewport(page: Page, selector: string): Promise<{ ok: boolean; detail: string }> {
  return page.evaluate((sel) => {
    const el = document.querySelector<HTMLElement>(sel)
    if (!el) return { ok: false, detail: 'missing' }
    const r = el.getBoundingClientRect()
    const ok = r.left >= -1 && r.right <= window.innerWidth + 1 && r.top >= -1 && r.bottom <= window.innerHeight + 1 &&
      document.documentElement.scrollWidth <= window.innerWidth + 1
    return { ok, detail: `${Math.round(r.left)}-${Math.round(r.right)}x${Math.round(r.top)}-${Math.round(r.bottom)} vw=${window.innerWidth} sw=${document.documentElement.scrollWidth}` }
  }, selector)
}

type TechMatch = { matchId: string; roomId: string | null; roundType: string; status: string; teamAId: string; teamBId: string; winnerTeamId: string | null }
type TechState = { tournament: { status: string }; entries: Array<{ profileId: string; teamId: string | null; status: string }>; matches: TechMatch[] }
async function techState(h: GiftBackHarness, tournamentId: string): Promise<TechState> {
  const res = await fetch(`${h.backendOrigin}/dev/tournament-test/api/state?tournamentId=${encodeURIComponent(tournamentId)}`)
  const body: any = await res.json()
  return (body.state ?? body) as TechState
}
async function createTournament(h: GiftBackHarness, humans: string[]): Promise<string> {
  const res = await fetch(`${h.backendOrigin}/dev/tournament-test/api/create`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamCapacity: 4, mode: 'one_human', existingHumanProfileIds: humans }),
  })
  const body: any = await res.json()
  assert(res.status === 200 && body.ok === true, `create tournament: ${JSON.stringify(body).slice(0, 300)}`)
  return body.tournamentId as string
}
function matchOf(state: TechState, profileId: string): TechMatch | null {
  const teamId = state.entries.find((e) => e.profileId === profileId)?.teamId ?? null
  const candidates = state.matches.filter((m) => m.teamAId === teamId || m.teamBId === teamId)
  return candidates.find((m) => m.status !== 'completed') ?? candidates[candidates.length - 1] ?? null
}
const replacementRows = (h: GiftBackHarness, profileId: string) =>
  h.db.prepare(`SELECT match_id AS matchId, status FROM tournament_match_no_show_replacements WHERE assigned_profile_id = ?`).all(profileId) as Array<{ matchId: string; status: string }>
const queueLedger = (h: GiftBackHarness, profileId: string, entryType: string) =>
  (h.db.prepare(`SELECT COUNT(*) AS n FROM match_economy_ledger WHERE profile_id = ? AND entry_type = ? AND room_id LIKE 'queue:%'`).get(profileId, entryType) as { n: number }).n

async function rawConnect(h: GiftBackHarness, profile: TestProfile): Promise<{ ws: RawWs; frames: any[] }> {
  const ws = new WebSocket(`${h.backendOrigin.replace('http', 'ws')}/ws`, { headers: { Cookie: `belot_session=${profile.cookie}`, Origin: h.appOrigin } })
  const frames: any[] = []
  ws.on('message', (data) => { try { frames.push(JSON.parse(data.toString())) } catch { /* ignore */ } })
  await new Promise<void>((done, reject) => { ws.once('open', () => done()); ws.once('error', reject) })
  await waitFor('raw connected', () => frames.some((f) => f.type === 'connected'), 10_000)
  return { ws, frames }
}
/** Случайна маса (сам + ботове след 20 s). */
async function joinRandomTable(p: Party, stake = STAKE): Promise<string> {
  const from = p.received.length
  p.inject({ type: 'join_matchmaking', stake })
  const found = await waitFor(`${p.label}: match_found`, () => frameAfter(p, from, (f) => f.type === 'match_found'), 50_000)
  return found.data.roomId as string
}

await mkdir(screenshotsDir, { recursive: true })

// ═══ Фаза A — зает в друг мач; опашка; частна маса; второ устройство ════════
{
  const h = await startHarness([randomTableTarget(40)], 30_000, 8_000)
  try {
    const [pP, pQ, pS, pR, pZ] = [await register(h, 'p'), await register(h, 'q'), await register(h, 's'), await register(h, 'r'), await register(h, 'z')]
    const P = await openParty(h, 'P', pP)
    const Q = await openParty(h, 'Q', pQ)
    const S = await openParty(h, 'S', pS)
    const R = await openParty(h, 'R', pR)
    const Z = await openParty(h, 'Z', pZ)

    R.inject({ type: 'create_private_room', stake: STAKE, isLocked: false, waitMinutes: 15, manualStart: true })
    const rRoom = await waitFor('R private room', () => frameAfter(R, 0, (f) => f.type === 'private_room_updated'), 10_000)
    const privateRoomId = rRoom.data.room.id as string
    await injectAndCollect(S, [{ type: 'join_private_room', privateRoomId, team: 'B', slotIndex: 0 }], 1200)
    const sSeated = [...S.received].reverse().find((f) => f.type === 'private_room_updated')?.data.room.slots.some((s: any) => s.occupant?.profileId === pS.profileId)

    const nRoom = await joinRandomTable(P)
    const qBalanceBefore = h.getBalance(pQ.profileId)
    // Залогът се удържа, когато на същия залог търсят поне двама (Z е извън турнира).
    await injectAndCollect(Z, [{ type: 'join_matchmaking', stake: QUEUE_STAKE }], 800)
    const qJoin = await injectAndCollect(Q, [{ type: 'join_matchmaking', stake: QUEUE_STAKE }], 1200)
    const qQueued = qJoin.some((f) => f.type === 'matchmaking_joined')
    const qPaidBeforeTournament = queueLedger(h, pQ.profileId, 'stake_debit') === 1 && h.getBalance(pQ.profileId) === qBalanceBefore - QUEUE_STAKE
    const qFrom = Q.received.length
    const sFrom = S.received.length

    const tournamentId = await createTournament(h, [pP.profileId, pQ.profileId, pS.profileId])
    const state0 = await waitFor('tournament rooms', async () => {
      const s = await techState(h, tournamentId)
      return s.matches.length === 2 && s.matches.every((m) => m.roomId !== null) ? s : null
    }, 20_000)
    const pMatch0 = matchOf(state0, pP.profileId)!
    await sleep(1500)

    await check('[A1] турнирната стая е построена -> Q излиза от опашката; залогът е върнат точно веднъж', async () => {
      assert(qQueued, '(setup) Q не влезе в опашката')
      assert(qPaidBeforeTournament, '(setup) залогът на Q не беше удържан преди турнира')
      assert(frameAfter(Q, qFrom, (f) => f.type === 'matchmaking_left' && f.data.removed === true) !== null, 'няма matchmaking_left')
      assert(queueLedger(h, pQ.profileId, 'stake_debit') === 1 && queueLedger(h, pQ.profileId, 'stake_refund') === 1, `ledger debit=${queueLedger(h, pQ.profileId, 'stake_debit')} refund=${queueLedger(h, pQ.profileId, 'stake_refund')}`)
      // Таксата за турнира е отделна (tournament_economy_ledger) — залогът за опашката е възстановен изцяло.
      const entryFee = (h.db.prepare("SELECT COALESCE(SUM(amount), 0) AS a FROM tournament_economy_ledger WHERE profile_id = ? AND entry_type = 'entry_fee_debit'").get(pQ.profileId) as { a: number }).a
      assert(h.getBalance(pQ.profileId) === qBalanceBefore - Math.abs(entryFee), `баланс ${qBalanceBefore} -> ${h.getBalance(pQ.profileId)} (такса ${entryFee})`)
    })
    await check('[A2] мястото на S на чакаща частна маса е освободено', async () => {
      assert(sSeated === true, '(setup) S не седна')
      assert(frameAfter(S, sFrom, (f) => f.type === 'private_room_left' && f.data.privateRoomId === privateRoomId) !== null, 'няма private_room_left')
      const rLast = [...R.received].reverse().find((f) => f.type === 'private_room_updated' && f.data.room.id === privateRoomId)?.data.room
      assert(rLast && !rLast.slots.some((s: any) => s.occupant?.profileId === pS.profileId), 'S още е на масата')
    })
    await check('[A3] P е зает в друг мач -> мачът му чака, без бот преди срока', async () => {
      const s = await techState(h, tournamentId)
      const m = s.matches.find((x) => x.matchId === pMatch0.matchId)!
      assert(m.status === 'awaiting_players', `status=${m.status}`)
      assert(replacementRows(h, pP.profileId).length === 0, 'бот преди срока')
    })

    await check('[A4] съществуващото известие по време на другата игра (вариант „конфликт“)', async () => {
      await P.page.locator('#tms-popup').waitFor({ state: 'visible', timeout: 10_000 })
      const text = await P.page.locator('#tms-popup').innerText()
      assert(text.includes('В момента участваш в друг мач.'), text)
      assert(text.includes('Остани в текущия мач') && text.includes('Напусни мача и влез в турнира'), text)
      await P.page.screenshot({ path: join(screenshotsDir, 'A4-desktop-existing-popup.png') })
    })

    const spamFrom = Date.now()
    await sleep(6000)
    await check('[A5] без повтарящи се HTTP заявки и resume_room опити по време на другата игра', async () => {
      const pushes = P.received.filter((f) => f.at >= spamFrom && f.type === 'tournament_match_assigned').length
      const detailRequests = P.requests.filter((r) => r.at >= spamFrom && r.url.includes('/api/tournaments')).length
      const resumes = P.sent.filter((f) => f.at >= spamFrom && f.type === 'resume_room').length
      assert(pushes >= 3, `pushes=${pushes}`)
      assert(detailRequests === 0, `HTTP заявки: ${detailRequests}`)
      assert(resumes === 0, `resume_room: ${resumes}`)
    })

    await check('[A6] „Остани в текущия мач“ -> известието не се показва отново през мача', async () => {
      await P.page.locator('[data-tms-stay="1"]').click()
      await P.page.locator('#tms-popup-mini').waitFor({ state: 'visible', timeout: 5000 })
      await sleep(4000)
      assert(!(await visible(P.page, '#tms-popup')), 'пълното известие се появи отново')
    })

    await check('[A7] второ устройство: вход в турнира се отказва, докато P играе другия мач (без затваряне на връзката)', async () => {
      const raw = await rawConnect(h, pP)
      try {
        await waitFor('raw session/assignment', () => raw.frames.some((f) => f.type === 'tournament_match_assigned'), 10_000)
        assert(raw.frames.some((f) => f.type === 'session_in_game'), 'няма session_in_game')
        const assignment = [...raw.frames].reverse().find((f) => f.type === 'tournament_match_assigned').assignment
        const displacedBefore = P.received.filter((f) => f.type === 'session_displaced').length
        raw.ws.send(JSON.stringify({ type: 'resume_room', roomId: assignment.roomId, reconnectToken: assignment.reconnectToken }))
        const failed = await waitFor('room_resume_failed', () => raw.frames.find((f) => f.type === 'room_resume_failed'), 8000)
        assert(failed.message === ACTIVE_MATCH_CONFLICT, failed.message)
        await sleep(800)
        assert(P.received.filter((f) => f.type === 'session_displaced').length === displacedBefore, 'първото устройство беше изместено')
        assert(!raw.frames.some((f) => f.type === 'room_resumed'), 'room_resumed')
      } finally {
        raw.ws.close()
      }
    })

    await check('[A8] срокът изтече, докато P е зает -> бот „вместо P“ (съществуващият механизъм)', async () => {
      await waitFor('replacement for P', () => replacementRows(h, pP.profileId).some((r) => r.status === 'active'), 45_000)
      assert(!P.received.some((f) => isMatchEnded(f, nRoom)), '(тайминг) обикновеният мач вече е приключил')
    })

    await check('[A9] нормално турнирно участие (Q, свободен): влиза автоматично в турнирния си мач', async () => {
      const qMatch = matchOf(await techState(h, tournamentId), pQ.profileId)!
      await waitFor('Q room_resumed', () => frameAfter(Q, qFrom, (f) => f.type === 'room_resumed' && f.data.roomId === qMatch.roomId), 20_000)
    })
    const qJoinAfter = await injectAndCollect(Q, [{ type: 'join_matchmaking', stake: QUEUE_STAKE }], 1500)
    await check('[A9b] участник в турнир не може да започне случайна маса', async () => {
      assert(!qJoinAfter.some((f) => f.type === 'matchmaking_joined'), 'matchmaking_joined')
    })

    // ── Край на обикновения мач ──
    await waitFor('N match-ended', () => P.received.some((f) => isMatchEnded(f, nRoom)), 240_000, 500)
    await sleep(2000)
    await check('[A10] край на мача: „Преиграй“ е скрит, показва се „Започнал турнир“ (без старото известие)', async () => {
      await P.page.locator('[data-tournament-join-prompt="1"]').waitFor({ state: 'visible', timeout: 10_000 })
      const text = await P.page.locator('[data-tournament-join-prompt="1"]').innerText()
      assert(text.includes(PROMPT_TITLE) && text.includes(PROMPT_TEXT), text)
      assert(text.includes('Включи се в турнира') && text.includes('Отказ'), text)
      assert(await P.page.locator('[data-match-ended-replay-button="1"]').count() === 0, '„Преиграй“ е видим')
      assert(await P.page.locator('[data-match-ended-lobby-button="1"]').count() > 0, '(екран) няма „Към лобито“')
      assert(!(await visible(P.page, '#tms-popup')) && !(await visible(P.page, '#tms-popup-mini')), 'старото известие е видимо')
      await P.page.screenshot({ path: join(screenshotsDir, 'A10-desktop-join-prompt.png') })
    })

    const balanceBeforeReplay = h.getBalance(pP.profileId)
    const replayFrames = await injectAndCollect(P, [{ type: 'request_replay', roomId: nRoom }], 3000)
    await check('[A11] „Преиграй“ (директно по WS) -> сървърен отказ, без залог', async () => {
      assert(errorsOf(replayFrames).includes(TOURNAMENT_CONFLICT), JSON.stringify(errorsOf(replayFrames)))
      const snap = [...P.received].reverse().find((f) => f.type === 'room_snapshot' && f.data.roomId === nRoom)?.data
      assert(snap?.roomStatus === 'finished', 'повторен мач стартира')
      assert(h.getBalance(pP.profileId) === balanceBeforeReplay, `баланс ${balanceBeforeReplay} -> ${h.getBalance(pP.profileId)}`)
    })

    await sleep(6000)
    await check('[A12] без автоматично скриване (няколко обновявания по-късно)', async () => {
      assert(await visible(P.page, '[data-tournament-join-prompt="1"]'), 'изчезна')
    })

    await check('[A13] „Отказ“ затваря известието и то не се показва отново за същия мач', async () => {
      await P.page.locator('[data-tournament-join-dismiss="1"]').click()
      await sleep(5000)
      assert(!(await visible(P.page, '[data-tournament-join-prompt="1"]')), 'видимо след отказ')
      assert(!(await visible(P.page, '#tms-popup')), 'старото известие се върна')
      assert(replacementRows(h, pP.profileId).some((r) => r.status === 'active'), 'отказът затвори заместването')
    })

    const balanceBeforeLobby = h.getBalance(pP.profileId)
    await check('[A14] след отказ — нормалният начин: лоби -> „Поеми играта“ -> поемане от бота', async () => {
      await P.page.locator('[data-match-ended-lobby-button="1"]').first().click()
      await P.page.locator('[data-tournament-reclaim-button="1"]').waitFor({ state: 'visible', timeout: 15_000 })
      const from = P.received.length
      await P.page.locator('[data-tournament-reclaim-button="1"]').click()
      const pMatch = matchOf(await techState(h, tournamentId), pP.profileId)!
      await waitFor('P room_resumed T', () => frameAfter(P, from, (f) => f.type === 'room_resumed' && f.data.roomId === pMatch.roomId), 15_000)
      await waitFor('replacement completed', () => replacementRows(h, pP.profileId).every((r) => r.status === 'completed'), 10_000)
      const snap = await waitFor('T snapshot', () => [...P.received].reverse().find((f) => f.type === 'room_snapshot' && f.data.roomId === pMatch.roomId)?.data, 10_000)
      const mySeat = snap.yourSeat ?? snap.seat
      const seatInfo = (snap.seats ?? []).find((s: any) => s.seat === mySeat)
      assert(seatInfo === undefined || seatInfo.participant?.kind !== 'bot', `мястото е още бот: ${JSON.stringify(seatInfo)}`)
      assert(h.getBalance(pP.profileId) === balanceBeforeLobby, 'глоба/залог при напускане на приключилия мач')
    })

    await check('[A15] второ устройство: нормално връщане към СЪЩИЯ мач не се блокира', async () => {
      const raw = await rawConnect(h, pP)
      try {
        const session = await waitFor('session_in_game', () => raw.frames.find((f) => f.type === 'session_in_game'), 10_000)
        raw.ws.send(JSON.stringify({ type: 'resume_room', roomId: session.roomId, reconnectToken: session.reconnectToken }))
        await waitFor('room_resumed', () => raw.frames.find((f) => f.type === 'room_resumed' && f.roomId === session.roomId), 8000)
      } finally {
        raw.ws.close()
      }
    })
  } catch (error) {
    console.error('  FAIL  неочаквана грешка (фаза A):', error instanceof Error ? error.stack : error)
    await check('фаза A без неочаквани грешки', () => { throw error })
  } finally {
    await h.close()
  }
}

// ═══ Фаза B — „Напусни мача и влез“, mobile, елиминиране / финал ═══════════
{
  const h = await startHarness([randomTableTarget(1), TOURNAMENT_ONE_POINT], 40_000, 8_000)
  try {
    const [pM, pU] = [await register(h, 'm'), await register(h, 'u')]
    const M = await openParty(h, 'M', pM, true)
    const U = await openParty(h, 'U', pU)
    M.inject({ type: 'join_matchmaking', stake: STAKE })
    const nRoom = await joinRandomTable(U)
    await waitFor('M match_found', () => frameAfter(M, 0, (f) => f.type === 'match_found' && f.data.roomId === nRoom), 10_000)
    const tournamentId = await createTournament(h, [pM.profileId, pU.profileId])
    await waitFor('tournament rooms', async () => {
      const s = await techState(h, tournamentId)
      return s.matches.length === 2 && s.matches.every((m) => m.roomId !== null) ? s : null
    }, 20_000)

    await check('[B1] mobile: съществуващото известие по време на другата игра е в екрана', async () => {
      await M.page.locator('#tms-popup').waitFor({ state: 'visible', timeout: 10_000 })
      const geo = await insideViewport(M.page, '#tms-popup')
      assert(geo.ok, geo.detail)
      await M.page.screenshot({ path: join(screenshotsDir, 'B1-mobile-existing-popup.png') })
    })

    await check('[B2] „Напусни мача и влез в турнира“ (съществуващият избор): напуска с глобата и влиза в турнира', async () => {
      await U.page.locator('#tms-popup').waitFor({ state: 'visible', timeout: 10_000 })
      const from = U.received.length
      await U.page.locator('[data-tms-leave="1"]').click()
      const left = await waitFor('U left_active_room', () => frameAfter(U, from, (f) => f.type === 'left_active_room' && f.data.roomId === nRoom), 10_000)
      assert(left.data.penalty !== undefined && left.data.penalty.penaltyAmount > 0, `глоба: ${JSON.stringify(left.data.penalty)}`)
      const uMatch = matchOf(await techState(h, tournamentId), pU.profileId)!
      await waitFor('U room_resumed T', () => frameAfter(U, from, (f) => f.type === 'room_resumed' && f.data.roomId === uMatch.roomId), 15_000)
    })

    await M.page.locator('[data-tms-stay="1"]').click().catch(() => undefined)
    await waitFor('M N match-ended', () => M.received.some((f) => isMatchEnded(f, nRoom)), 240_000, 500)
    await sleep(2000)
    {
      const status = M.received.find((f) => f.type === 'belot_match_ended_tournament_status')
      const s = await techState(h, tournamentId)
      console.log(`    (край на мача на M: assignment=${status?.data.assignment ? status.data.assignment.matchStatus : 'null'}; срещи: ${s.matches.map((m) => m.roundType + ':' + m.status).join(', ')})`)
    }
    await check('[B3] mobile: „Започнал турнир“ след края на мача, в екрана, без „Преиграй“', async () => {
      await M.page.locator('[data-tournament-join-prompt="1"]').waitFor({ state: 'visible', timeout: 10_000 })
      const geo = await insideViewport(M.page, '[data-tournament-join-prompt="1"]')
      assert(geo.ok, geo.detail)
      assert(await M.page.locator('[data-match-ended-replay-button="1"]').count() === 0, '„Преиграй“ е видим')
      await M.page.screenshot({ path: join(screenshotsDir, 'B3-mobile-join-prompt.png') })
    })

    const mFirstMatch = matchOf(await techState(h, tournamentId), pM.profileId)!
    const afterSemi = await waitFor('M semifinal completed', async () => {
      const s = await techState(h, tournamentId)
      const m = s.matches.find((x) => x.matchId === mFirstMatch.matchId)
      return m?.status === 'completed' ? s : null
    }, 180_000, 1000)
    const mEntry = afterSemi.entries.find((e) => e.profileId === pM.profileId)!
    const semi = afterSemi.matches.find((x) => x.matchId === mFirstMatch.matchId)!
    const eliminated = semi.winnerTeamId !== mEntry.teamId
    console.log(`    (полуфиналът на M: ${eliminated ? 'загуба -> елиминиран' : 'победа -> финал'})`)
    if (eliminated) {
      await check('[B4] елиминиран (ботът загуби полуфинала) -> „Започнал турнир“ се затваря', async () => {
        await waitFor('prompt hidden', async () => !(await visible(M.page, '[data-tournament-join-prompt="1"]')), 10_000)
      })
      await check('[B5] елиминиран -> веднага може да играе: „Преиграй“ не се отказва по турнирна причина', async () => {
        const frames = await injectAndCollect(M, [{ type: 'request_replay', roomId: nRoom }], 2000)
        assert(!errorsOf(frames).includes(TOURNAMENT_CONFLICT), JSON.stringify(errorsOf(frames)))
      })
    } else {
      await check('[B4] отборът стигна финала -> известието остава', async () => {
        await sleep(2500)
        assert(await visible(M.page, '[data-tournament-join-prompt="1"]'), 'изчезна')
      })
      const finalMatch = await waitFor('final room', async () => {
        const s = await techState(h, tournamentId)
        const f = s.matches.find((x) => x.roundType === 'final' && x.roomId !== null && x.status !== 'completed')
        return f ?? null
      }, 30_000)
      await check('[B5] „Включи се в турнира“ води към актуалния мач (финала)', async () => {
        const from = M.received.length
        await M.page.locator('[data-tournament-join-accept="1"]').click()
        await waitFor('M left N', () => frameAfter(M, from, (f) => f.type === 'left_active_room' && f.data.roomId === nRoom), 10_000)
        await waitFor('M room_resumed final', () => frameAfter(M, from, (f) => f.type === 'room_resumed' && f.data.roomId === finalMatch.roomId), 15_000)
        assert(!(await visible(M.page, '[data-tournament-join-prompt="1"]')), 'известието е още видимо')
      })
    }
  } catch (error) {
    console.error('  FAIL  неочаквана грешка (фаза B):', error instanceof Error ? error.stack : error)
    await check('фаза B без неочаквани грешки', () => { throw error })
  } finally {
    await h.close()
  }
}

console.log(`\n  screenshots: ${screenshotsDir}`)
finishAndExit()
