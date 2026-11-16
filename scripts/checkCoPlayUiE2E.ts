/**
 * checkCoPlayUiE2E.ts — „Забрана за съвместна игра“, Етап 5: реалният клиент
 * (Vite + Chromium) срещу реален изолиран сървър (giftBackTestHarness, отделна
 * временна база). Другите участници са сурови WS връзки или HTTP заявки.
 *
 *   [U1]  достъп: секцията е само за пълен admin (не за играч и subadmin);
 *         истинският панел срещу истинския API: налагане и отмяна през UI;
 *   [U2]  случайна маса: отказ -> прозорецът (desktop и mobile), без общото съобщение;
 *   [U3]  чакащ на друг залог: отказ -> остава в своята чакалня (залог, таймер, бройка);
 *   [U4]  премахване от случайна чакалня при ново налагане -> прозорец, обратно в лобито;
 *   [U5]  частна маса: отказ при сядане -> прозорецът, без банера на масата;
 *   [U6]  премахване от частна чакалня при ново налагане -> прозорец; вече не е член
 *         (съществуващото поведение: остава наблюдател на същата маса, ако тя още съществува);
 *   [U7]  турнир: отказ при записване -> прозорецът, без inline грешката (desktop и mobile);
 *   [U8]  повторен мач: по-късно гласувалият получава прозореца (context 'replay'),
 *         другият — не; повторният мач не стартира.
 *
 *   node server/node_modules/tsx/dist/cli.mjs scripts/checkCoPlayUiE2E.ts
 *
 * Скрийншоти: <tmp>/belot-v2-co-play-ui-screenshots/*.png
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import type { Page } from 'playwright'
import { createTournamentStore } from '../server/src/db/tournamentStore.js'
import { assert, check, finishAndExit, sleep, startGiftBackHarness, type ServerSourcePatch, type TestProfile } from './giftBackTestHarness'

// ws е само в server/node_modules (основният checkout няма отделна зависимост).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const WebSocket = createRequire(new URL('../server/package.json', import.meta.url))('ws') as any

console.log('\ncheckCoPlayUiE2E\n')

const BALANCE = 50_000_000
const TITLE = 'Административно ограничение'
const MM_TEXT = 'В тази чакалня има играч, с когото нямате право да участвате на обща маса поради наложено административно наказание.'
const ROOM_TEXT = 'На тази маса има играч, с когото нямате право да участвате на обща маса поради наложено административно наказание.'
const TOURNAMENT_TEXT = 'В този турнир има играч, с когото нямате право да участвате поради наложено административно наказание.'
const REPLAY_TEXT = 'Не можете да участвате в повторен мач с играч, спрямо когото имате наложено административно ограничение.'
const OUT = join(tmpdir(), 'belot-v2-co-play-ui-screenshots')
const DESKTOP = { width: 1280, height: 850 }
const MOBILE = { width: 390, height: 844 }

// Частният мач е до 1 точка, за да стигне до края (същото като в Етап 3).
const SHORT_PRIVATE_MATCH: ServerSourcePatch = {
  file: 'index.ts',
  find: 'const initializedRoom = initializeRoomAuthoritativeGameState(currentRoom)',
  replace: 'const initializedRoom = initializeRoomAuthoritativeGameState({ ...currentRoom, config: { ...currentRoom.config, targetScore: 1 } })',
}

type Frame = { at: number; type: string; data: any }
type Client = { profile: TestProfile; frames: Frame[]; send: (m: unknown) => void; close: () => Promise<void> }
type UiPage = { page: Page; received: Frame[]; close: () => Promise<void> }

await mkdir(OUT, { recursive: true })
const h = await startGiftBackHarness({ patchServerSource: [SHORT_PRIVATE_MATCH] })
const wsOrigin = h.backendOrigin.replace(/^http/, 'ws')
const opened: Array<{ close: () => Promise<void> }> = []

try {
  h.db.prepare(`INSERT INTO admin_settings (setting_key, setting_value) VALUES ('belot_random_table_wait_seconds', '300') ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value`).run()
  const stakes = (h.db.prepare(`SELECT stake_amount FROM match_rooms WHERE is_enabled = 1 AND min_level <= 1 ORDER BY stake_amount`).all() as Array<{ stake_amount: number }>).map((r) => r.stake_amount)
  assert(stakes.length >= 2, `(setup) залози: ${JSON.stringify(stakes)}`)
  const [S1, S2] = [stakes[0]!, stakes[1]!]

  async function register(tag: string): Promise<TestProfile> {
    h.db.prepare('DELETE FROM registration_rate_limit_events').run()
    const p = await h.register(tag)
    h.setBalance(p.profileId, BALANCE)
    return p
  }
  const accountOf = (profileId: string) => (h.db.prepare('SELECT account_id FROM profiles WHERE profile_id = ?').get(profileId) as { account_id: string }).account_id
  const admin = await register('admin')
  h.db.prepare(`UPDATE accounts SET role = 'admin' WHERE account_id = ?`).run(accountOf(admin.profileId))

  async function api(profile: TestProfile, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(`${h.backendOrigin}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: `belot_session=${profile.cookie}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: res.status, body: await res.json().catch(() => null) }
  }
  const adminApi = (method: string, path: string, body?: unknown) => api(admin, method, `/api/admin/co-play-restrictions${path}`, body)
  async function impose(a: string, b: string): Promise<string> {
    const r = await adminApi('POST', '', { firstProfileId: a, secondProfileId: b, reason: 'E2E UI', durationDays: 30 })
    assert(r.status === 201, `(setup) налагане: ${JSON.stringify(r.body)}`)
    await sleep(600)
    return r.body.restriction.restrictionId as string
  }
  const flag = await adminApi('PUT', '/settings', { enabled: true })
  assert(flag.status === 200 && flag.body.settings.enabled === true, `(setup) флаг: ${JSON.stringify(flag.body)}`)

  async function connect(profile: TestProfile): Promise<Client> {
    const socket = new WebSocket(`${wsOrigin}/ws`, { headers: { Cookie: `belot_session=${profile.cookie}` } })
    const frames: Frame[] = []
    socket.on('message', (raw) => {
      try { const data = JSON.parse(String(raw)); frames.push({ at: Date.now(), type: String(data?.type ?? ''), data }) } catch { /* not JSON */ }
    })
    await new Promise<void>((done, reject) => { socket.once('open', () => done()); socket.once('error', reject) })
    await sleep(300)
    const client: Client = {
      profile, frames,
      send: (m) => socket.send(JSON.stringify(m)),
      close: () => new Promise<void>((done) => { if (socket.readyState === WebSocket.CLOSED) { done(); return } socket.once('close', () => done()); socket.close() }),
    }
    opened.push(client)
    return client
  }
  async function waitFrame(frames: Frame[], predicate: (f: Frame) => boolean, from = 0, timeoutMs = 6000): Promise<Frame | null> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const found = frames.slice(from).find(predicate)
      if (found) return found
      await sleep(100)
    }
    return null
  }

  /** Истинският клиент; WebSocket-ът на страницата е достъпен за инжектиране на команда (само U3). */
  async function openUi(profile: TestProfile, viewport: { width: number; height: number }, path: string, readySelector: string, mobile = false): Promise<UiPage> {
    const context = await h.browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 })
    await context.addCookies([{ name: 'belot_session', value: profile.cookie, url: h.backendOrigin }])
    await context.addInitScript(() => {
      try { localStorage.setItem('pika-consent-v2', JSON.stringify({ version: 2, necessary: true, analytics: false, marketing: false, updatedAt: new Date().toISOString() })) } catch { /* ignore */ }
      const Original = window.WebSocket
      ;(window as any).__testSockets = []
      ;(window as any).WebSocket = class extends Original {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols)
          ;(window as any).__testSockets.push(this)
        }
      }
    })
    const page = await context.newPage()
    page.on('pageerror', (error) => console.error(`    pageerror: ${error.message}`))
    const received: Frame[] = []
    page.on('websocket', (ws) => {
      ws.on('framereceived', (frame) => {
        try { const data = JSON.parse(String(frame.payload)); received.push({ at: Date.now(), type: String(data?.type ?? ''), data }) } catch { /* ignore */ }
      })
    })
    await page.goto(`${h.appOrigin}${path}`)
    await page.locator(readySelector).first().waitFor({ state: 'attached', timeout: 30_000 })
    await page.waitForTimeout(900)
    const ui = { page, received, close: () => context.close() }
    opened.push(ui)
    return ui
  }
  const notice = (page: Page) => page.locator('[data-co-play-restricted-notice="1"]')
  async function expectNotice(page: Page, text: string, context: string): Promise<void> {
    await notice(page).waitFor({ timeout: 8000 })
    assert((await page.locator('[data-co-play-restricted-notice-title="1"]').innerText()).trim() === TITLE, 'заглавие')
    assert((await page.locator('[data-co-play-restricted-notice-text="1"]').innerText()).trim() === text, `текст: ${await page.locator('[data-co-play-restricted-notice-text="1"]').innerText()}`)
    assert((await page.locator('[data-co-play-restricted-notice-ok="1"]').innerText()).trim() === 'Разбрах', 'бутон')
    assert((await notice(page).getAttribute('data-co-play-restricted-context')) === context, `контекст ${await notice(page).getAttribute('data-co-play-restricted-context')}`)
    // Без общо съобщение за грешка: текстът е на страницата само веднъж (в прозореца).
    const occurrences = await page.evaluate((needle) => document.body.innerText.split(needle).length - 1, text)
    assert(occurrences === 1, `текстът се вижда ${occurrences} пъти (общо съобщение + прозорец?)`)
  }
  async function dismiss(page: Page): Promise<void> {
    await page.click('[data-co-play-restricted-notice-ok="1"]')
    assert((await notice(page).count()) === 0, 'прозорецът не се затвори')
  }
  const lobbyReady = '[data-lobby-stake-card]'
  const closeAll = async () => {
    for (const item of opened.splice(0)) await item.close().catch(() => undefined)
    await sleep(800)
  }

  // ─── U1: достъп и истинският панел ──────────────────────────────────
  {
    const player = await register('player')
    const sub = await register('subadm')
    h.db.prepare(`UPDATE accounts SET role = 'subadmin' WHERE account_id = ?`).run(accountOf(sub.profileId))
    const [x, y] = [await register('ux'), await register('uy')]
    for (const [profile, label] of [[player, 'играч'], [sub, 'subadmin']] as const) {
      const ui = await openUi(profile, DESKTOP, '/lobby', lobbyReady)
      await check(`[U1] ${label}: няма „Забрани за съвместна игра“ в менюто; API -> 403`, async () => {
        assert((await ui.page.locator('[data-lobby-nav-admin-co-play-restrictions="1"]').count()) === 0, 'бутонът е в менюто')
        const r = await api(profile, 'GET', '/api/admin/co-play-restrictions?status=all')
        assert(r.status === 403, `статус ${r.status}`)
      })
      await ui.close()
    }
    const adminUi = await openUi(admin, DESKTOP, '/lobby', lobbyReady)
    await check('[U1] пълен admin: бутонът е в менюто и отваря секцията с истинските данни', async () => {
      assert((await adminUi.page.locator('[data-lobby-nav-admin-co-play-restrictions="1"]').count()) >= 1, 'няма бутон')
      await adminUi.page.locator('[data-lobby-nav-admin-co-play-restrictions="1"]').first().evaluate((el) => (el as HTMLButtonElement).click())
      await adminUi.page.locator('[data-co-play-flag-state="on"]').waitFor({ timeout: 10_000 })
    })
    await check('[U1] налагане и отмяна през интерфейса срещу истинския API (Origin, тяло, отговор)', async () => {
      const page = adminUi.page
      await page.click('[data-co-play-tab="create"]')
      for (const [slot, profile] of [[0, x], [1, y]] as const) {
        await page.fill(`[data-co-play-pick-search="${slot}"]`, profile.displayName)
        await page.locator(`[data-co-play-pick-option="${profile.profileId}"]`).waitFor({ timeout: 8000 })
        await page.click(`[data-co-play-pick-option="${profile.profileId}"]`)
      }
      await page.fill('[data-co-play-duration="1"]', '45')
      await page.fill('[data-co-play-reason="1"]', 'E2E през интерфейса')
      await page.click('[data-co-play-submit="1"]')
      await page.locator('[data-co-play-dialog-confirm="1"]').dblclick()
      await page.locator('[data-co-play-imposed="active"]').waitFor({ timeout: 8000 })
      const rows = h.db.prepare(`SELECT restriction_id, duration_days, reason, ended_at FROM co_play_restrictions WHERE reason = 'E2E през интерфейса'`).all() as Array<{ restriction_id: string; duration_days: number; ended_at: string | null }>
      assert(rows.length === 1 && rows[0]!.duration_days === 45 && rows[0]!.ended_at === null, JSON.stringify(rows))
      const id = rows[0]!.restriction_id
      await page.locator(`[data-co-play-row="${id}"]`).waitFor({ timeout: 8000 })
      await page.screenshot({ path: join(OUT, 'admin-real-api-list.png') })
      await page.click(`[data-co-play-row="${id}"] [data-co-play-lift-open]`)
      await page.fill('[data-co-play-dialog-reason="1"]', 'E2E отмяна')
      await page.click('[data-co-play-dialog-confirm="1"]')
      await page.locator(`[data-co-play-row="${id}"][data-co-play-row-status="lifted"]`).waitFor({ timeout: 8000 })
      const after = h.db.prepare('SELECT end_kind, lift_reason FROM co_play_restrictions WHERE restriction_id = ?').get(id) as { end_kind: string; lift_reason: string }
      assert(after.end_kind === 'lifted' && after.lift_reason === 'E2E отмяна', JSON.stringify(after))
      await page.click('[data-co-play-tab="audit"]')
      await page.locator('[data-co-play-audit-entry="lift"]').first().waitFor({ timeout: 8000 })
    })
    await closeAll()
  }

  // ─── U2: отказ в случайна маса (desktop и mobile) ───────────────────
  for (const [viewport, mobile, label] of [[DESKTOP, false, 'desktop'], [MOBILE, true, 'mobile']] as const) {
    const [pA, pB] = [await register(`a2${label[0]}`), await register(`b2${label[0]}`)]
    await impose(pA.profileId, pB.profileId)
    const A = await connect(pA)
    A.send({ type: 'join_matchmaking', stake: S1 })
    assert((await waitFrame(A.frames, (f) => f.type === 'matchmaking_joined')) !== null, '(setup) A не чака')
    const ui = await openUi(pB, viewport, '/lobby', lobbyReady, mobile)
    await check(`[U2] ${label}: отказ в случайна маса -> „Административно ограничение“, без общото съобщение; обратно в лобито`, async () => {
      await ui.page.locator(`[data-lobby-stake-card="${S1}"]`).first().click()
      await expectNotice(ui.page, MM_TEXT, 'matchmaking')
      await ui.page.screenshot({ path: join(OUT, `notice-matchmaking-${label}.png`) })
      await dismiss(ui.page)
      assert((await ui.page.locator('[data-matchmaking-room-screen="1"]').count()) === 0, 'остана в чакалнята')
      assert((await ui.page.locator(lobbyReady).count()) > 0, 'не е в лобито')
    })
    await closeAll()
  }

  // ─── U3: чакащ на друг залог запазва чакалнята си ───────────────────
  {
    const [pA, pB] = [await register('a3'), await register('b3')]
    await impose(pA.profileId, pB.profileId)
    const ui = await openUi(pB, DESKTOP, '/lobby', lobbyReady)
    await ui.page.locator(`[data-lobby-stake-card="${S2}"]`).first().click()
    await ui.page.locator('[data-matchmaking-room-screen="1"]').waitFor({ timeout: 8000 })
    await ui.page.waitForTimeout(1500)
    const A = await connect(pA)
    A.send({ type: 'join_matchmaking', stake: S1 })
    assert((await waitFrame(A.frames, (f) => f.type === 'matchmaking_joined')) !== null, '(setup) A не чака')
    const before = await ui.page.locator('[data-matchmaking-countdown-text="1"]').first().innerText()
    const lastStatusBefore = [...ui.received].reverse().find((f) => f.type === 'matchmaking_status' || f.type === 'matchmaking_joined')!
    const mark = ui.received.length
    await ui.page.evaluate((stake) => {
      const socket = ((window as any).__testSockets as WebSocket[]).filter((s) => s.readyState === WebSocket.OPEN).pop()!
      socket.send(JSON.stringify({ type: 'join_matchmaking', stake }))
    }, S1)
    await check('[U3] отказ за друг залог: прозорецът; остава в чакалнята си (залог, таймер, бройка); без matchmaking_left', async () => {
      await expectNotice(ui.page, MM_TEXT, 'matchmaking')
      await ui.page.waitForTimeout(600)
      assert(!ui.received.slice(mark).some((f) => f.type === 'matchmaking_left'), 'matchmaking_left')
      const status = ui.received.slice(mark).find((f) => f.type === 'matchmaking_status')
      assert(status !== undefined && status.data.stake === S2 && status.data.queuedPlayers === lastStatusBefore.data.queuedPlayers, JSON.stringify(status?.data))
      assert(Math.abs(status.data.countdownEndsAt - (lastStatusBefore.data.countdownEndsAt ?? status.data.countdownEndsAt)) < 1500, 'таймерът е преместен')
      await ui.page.screenshot({ path: join(OUT, 'notice-matchmaking-other-stake-desktop.png') })
      await dismiss(ui.page)
      assert((await ui.page.locator('[data-matchmaking-room-screen="1"]').count()) === 1, 'напусна чакалнята')
      const after = await ui.page.locator('[data-matchmaking-countdown-text="1"]').first().innerText()
      assert(after !== '--:--' && before !== '--:--', `таймер ${before} -> ${after}`)
      const html = await ui.page.locator('[data-matchmaking-room-screen="1"]').innerText()
      assert(html.replace(/\s/g, '').includes(String(S2)) || html.includes(S2.toLocaleString('bg-BG')), 'залогът не е показан')
    })
    await closeAll()
  }

  // ─── U4: премахване от случайна чакалня ─────────────────────────────
  {
    const [pA, pB] = [await register('a4'), await register('b4')]
    const A = await connect(pA)
    A.send({ type: 'join_matchmaking', stake: S1 })
    assert((await waitFrame(A.frames, (f) => f.type === 'matchmaking_joined')) !== null, '(setup) A не чака')
    const ui = await openUi(pB, DESKTOP, '/lobby', lobbyReady)
    await ui.page.locator(`[data-lobby-stake-card="${S1}"]`).first().click()
    await ui.page.locator('[data-matchmaking-room-screen="1"]').waitFor({ timeout: 8000 })
    await ui.page.waitForTimeout(800)
    await impose(pA.profileId, pB.profileId)
    await check('[U4] ново налагане при общо чакане: по-късно влезлият получава прозореца и е в лобито', async () => {
      await notice(ui.page).waitFor({ timeout: 8000 })
      const text = (await ui.page.locator('[data-co-play-restricted-notice-text="1"]').innerText()).trim()
      assert(text.startsWith('Участието ви в чакалнята беше прекратено') && !text.includes(pA.displayName), text)
      assert((await notice(ui.page).getAttribute('data-co-play-restricted-context')) === 'matchmaking', 'контекст')
      await ui.page.screenshot({ path: join(OUT, 'notice-matchmaking-removed-desktop.png') })
      await dismiss(ui.page)
      assert((await ui.page.locator('[data-matchmaking-room-screen="1"]').count()) === 0, 'остана в несъществуваща чакалня')
    })
    await closeAll()
  }

  // ─── U5 / U6: частни маси ──────────────────────────────────────────
  async function createRoom(host: Client): Promise<string> {
    const from = host.frames.length
    host.send({ type: 'create_private_room', stake: S1, isLocked: false, waitMinutes: 15, manualStart: true })
    const created = await waitFrame(host.frames, (f) => f.type === 'private_room_updated', from)
    assert(created !== null, '(setup) масата не е създадена')
    return created.data.room.id as string
  }
  async function openPrivateRooms(ui: UiPage): Promise<void> {
    await ui.page.locator('[data-lobby-private-rooms-card="1"]').first().click()
    await ui.page.locator('[data-private-room-list-slot-join]').first().waitFor({ timeout: 10_000 })
  }
  async function sitViaUi(ui: UiPage, roomId: string): Promise<void> {
    await ui.page.locator(`[data-private-room-list-slot-join="${roomId}:B:0"]`).first().click()
    await ui.page.locator('[data-private-room-join-popup-confirm]').first().click()
  }
  {
    const [pA, pB] = [await register('a5'), await register('b5')]
    await impose(pA.profileId, pB.profileId)
    const A = await connect(pA)
    const roomId = await createRoom(A)
    const ui = await openUi(pB, DESKTOP, '/lobby', lobbyReady)
    await openPrivateRooms(ui)
    await check('[U5] частна маса: отказ при сядане -> прозорецът, без банера на масата; масата е непроменена', async () => {
      await sitViaUi(ui, roomId)
      await expectNotice(ui.page, ROOM_TEXT, 'private_room')
      await ui.page.screenshot({ path: join(OUT, 'notice-private-room-desktop.png') })
      await dismiss(ui.page)
      assert((await ui.page.locator('[data-private-room-waiting-screen="1"]').count()) === 0, 'влезе в чакалнята')
    })
    await closeAll()
  }
  {
    const [pA, pB] = [await register('a6'), await register('b6')]
    const A = await connect(pA)
    const roomId = await createRoom(A)
    const ui = await openUi(pB, DESKTOP, '/lobby', lobbyReady)
    await openPrivateRooms(ui)
    await sitViaUi(ui, roomId)
    await ui.page.locator('[data-private-room-waiting-screen="1"]').waitFor({ timeout: 10_000 })
    await impose(pA.profileId, pB.profileId)
    await check('[U6] ново налагане при обща частна чакалня: прозорец; по-късно седналият вече не е член (наблюдател на същата маса)', async () => {
      await notice(ui.page).waitFor({ timeout: 8000 })
      const text = (await ui.page.locator('[data-co-play-restricted-notice-text="1"]').innerText()).trim()
      assert(text.startsWith('Мястото ви на частната маса беше освободено') && !text.includes(pA.displayName), text)
      await ui.page.screenshot({ path: join(OUT, 'notice-private-room-removed-desktop.png') })
      await dismiss(ui.page)
      await ui.page.waitForTimeout(800)
      const room = [...A.frames].reverse().find((f) => f.type === 'private_room_updated' && f.data.room.id === roomId)?.data.room
      assert(room !== undefined && !room.slots.some((slot: any) => slot.occupant?.profileId === pB.profileId), 'Б е още на масата (сървър)')
      assert(ui.received.some((f) => f.type === 'private_room_left' && f.data.privateRoomId === roomId), 'няма private_room_left')
      // Клиентът: или списъкът, или наблюдател на същата (съществуваща) маса — свободните места са активни, Б не е седнал.
      const waiting = ui.page.locator('[data-private-room-waiting-screen="1"]')
      if ((await waiting.count()) > 0) {
        assert((await waiting.locator('[data-private-room-slot-join]:not([disabled])').count()) > 0, 'не е наблюдател (местата са неактивни)')
        assert(!(await waiting.innerText()).includes(pB.displayName), 'Б се вижда седнал')
      }
      await ui.page.screenshot({ path: join(OUT, 'private-room-after-removal-desktop.png') })
    })
    await closeAll()
  }

  // ─── U7: турнир (desktop и mobile) ─────────────────────────────────
  {
    const dbPath = (h.db as unknown as { location: () => string }).location()
    const tournamentStore = await createTournamentStore(dbPath)
    let seq = 0
    for (const [viewport, mobile, label] of [[DESKTOP, false, 'desktop'], [MOBILE, true, 'mobile']] as const) {
      const [pA, pB, owner] = [await register(`a7${label[0]}`), await register(`b7${label[0]}`), await register(`o7${label[0]}`)]
      seq += 1
      const created = tournamentStore.createTournament({
        name: `UI турнир ${seq}`, creatorProfileId: owner.profileId, visibility: 'public', entryFee: 5000,
        startMode: 'scheduled', scheduledStartAt: new Date(Date.now() + (30 + seq * 3) * 3600_000).toISOString(), playerCapacity: 8,
      })
      assert(created.ok, '(setup) турнир')
      const tournamentId = created.tournament.tournamentId
      await impose(pA.profileId, pB.profileId)
      const joinA = await api(pA, 'POST', `/api/tournaments/${tournamentId}/join`, {})
      assert(joinA.status === 200, `(setup) A: ${JSON.stringify(joinA.body)}`)
      // Директният адрес показва началната страница (landing) — влизане през лобито и навигация в приложението.
      const ui = await openUi(pB, viewport, '/lobby', lobbyReady, mobile)
      await ui.page.evaluate((id) => { history.pushState(null, '', '/tournaments/' + id); window.dispatchEvent(new PopStateEvent('popstate')) }, tournamentId)
      await ui.page.locator('[data-tournament-join-open="1"]:visible').first().waitFor({ timeout: 15_000 })
      await check(`[U7] ${label}: отказ при записване в турнир -> прозорецът, без inline грешка; без такса`, async () => {
        await ui.page.screenshot({ path: join(OUT, `tournament-detail-before-${label}.png`) })
        await ui.page.locator('[data-tournament-join-open="1"]:visible').first().click()
        await ui.page.locator('[data-tournament-join-submit="1"]:visible').first().click()
        await expectNotice(ui.page, TOURNAMENT_TEXT, 'tournament')
        await ui.page.screenshot({ path: join(OUT, `notice-tournament-${label}.png`) })
        await dismiss(ui.page)
        assert(h.getBalance(pB.profileId) === BALANCE, 'удържана такса')
      })
      await closeAll()
    }
    ;(tournamentStore as unknown as { close?: () => void }).close?.()
  }

  // ─── U8: повторен мач ──────────────────────────────────────────────
  {
    const [pA, pB] = [await register('a8'), await register('b8')]
    const A = await connect(pA)
    const from = A.frames.length
    A.send({ type: 'create_private_room', stake: S1, isLocked: false, waitMinutes: 15, manualStart: false })
    const created = await waitFrame(A.frames, (f) => f.type === 'private_room_updated', from)
    assert(created !== null, '(setup) маса')
    const roomId = created.data.room.id as string
    // Б играе в истинския клиент от самото начало (сяда през интерфейса).
    const ui = await openUi(pB, DESKTOP, '/lobby', lobbyReady)
    await openPrivateRooms(ui)
    await sitViaUi(ui, roomId)
    await ui.page.locator('[data-private-room-waiting-screen="1"]').waitFor({ timeout: 10_000 })
    const aFrom = A.frames.length
    A.send({ type: 'add_bot_to_private_room_team', team: 'A' })
    await sleep(500)
    await ui.page.evaluate(() => {
      const socket = ((window as any).__testSockets as WebSocket[]).filter((s) => s.readyState === WebSocket.OPEN).pop()!
      socket.send(JSON.stringify({ type: 'add_bot_to_private_room_team', team: 'B' }))
    })
    const full = await waitFrame(A.frames, (f) => f.type === 'private_room_full', aFrom, 10_000)
    assert(full !== null, '(setup) мачът не стартира')
    const gameId = full.data.roomId as string
    await impose(pA.profileId, pB.profileId)
    const ended = await waitFrame(A.frames, (f) => f.type === 'room_snapshot' && f.data?.roomId === gameId && f.data?.roomStatus === 'finished', 0, 300_000)
    assert(ended !== null, '(setup) мачът не стигна до края')
    await sleep(1500)
    A.send({ type: 'request_replay', roomId: gameId })
    await sleep(700)
    const aMark = A.frames.length
    await ui.page.locator('[data-match-ended-replay-button="1"]:visible').first().waitFor({ timeout: 30_000 })
    // Евентуален прозорец „поето от робот“ над екрана не е предмет на теста.
    await ui.page.locator('[data-match-ended-replay-button="1"]:visible').first().evaluate((el) => (el as HTMLButtonElement).click())
    await check('[U8] повторен мач: по-късно гласувалият (Б) получава прозореца; другият — не; без нов мач', async () => {
      await expectNotice(ui.page, REPLAY_TEXT, 'replay')
      const frame = ui.received.find((f) => f.type === 'error' && f.data.code === 'co_play_restricted')
      assert(frame !== undefined && frame.data.context === 'replay' && frame.data.message === REPLAY_TEXT, JSON.stringify(frame?.data))
      await sleep(800)
      assert(!A.frames.slice(aMark).some((f) => f.type === 'error' && f.data.code === 'co_play_restricted'), 'A получи известие')
      const restarted = A.frames.slice(aMark).some((f) => f.type === 'room_snapshot' && f.data?.roomId === gameId && f.data?.roomStatus !== 'finished' && f.data?.game?.matchEnded == null)
      assert(!restarted, 'повторният мач стартира')
      await ui.page.screenshot({ path: join(OUT, 'notice-replay-desktop.png') })
      await dismiss(ui.page)
    })
    await closeAll()
  }
} catch (error) {
  console.error('FATAL', error)
  console.error('--- server output (tail) ---\n' + h.serverOutput().slice(-4000))
  await check('(без фатална грешка)', () => { throw error })
} finally {
  for (const item of opened.splice(0)) await item.close().catch(() => undefined)
  console.log(`Скрийншоти: ${OUT}`)
  await h.close()
}
finishAndExit()
