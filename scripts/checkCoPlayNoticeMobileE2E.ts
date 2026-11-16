/**
 * checkCoPlayNoticeMobileE2E.ts — „Забрана за съвместна игра“, Етап 5:
 * целева визуална проверка на прозореца „Административно ограничение“ в
 * мобилния интерфейс (светлата тема) при 390px и 320px, плюс контрола, че
 * desktop остава тъмно-златен. Реалният клиент (Vite + Chromium) срещу реален
 * изолиран сървър (giftBackTestHarness, отделна временна база).
 *
 * За всяка ширина: случайна маса (отказ), друг залог (мобилната чакалня),
 * премахване от случайна чакалня, частна маса (отказ), премахване от частна
 * чакалня, турнир, повторен мач (мобилната маса).
 *
 *   node server/node_modules/tsx/dist/cli.mjs scripts/checkCoPlayNoticeMobileE2E.ts
 *
 * Скрийншоти: <tmp>/belot-v2-co-play-notice-mobile/<ширина>/*.png
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

console.log('\ncheckCoPlayNoticeMobileE2E\n')

const BALANCE = 50_000_000
const MM_TEXT = 'В тази чакалня има играч, с когото нямате право да участвате на обща маса поради наложено административно наказание.'
const ROOM_TEXT = 'На тази маса има играч, с когото нямате право да участвате на обща маса поради наложено административно наказание.'
const TOURNAMENT_TEXT = 'В този турнир има играч, с когото нямате право да участвате поради наложено административно наказание.'
const REPLAY_TEXT = 'Не можете да участвате в повторен мач с играч, спрямо когото имате наложено административно ограничение.'
const OUT = join(tmpdir(), 'belot-v2-co-play-notice-mobile')
const SHORT_PRIVATE_MATCH: ServerSourcePatch = {
  file: 'index.ts',
  find: 'const initializedRoom = initializeRoomAuthoritativeGameState(currentRoom)',
  replace: 'const initializedRoom = initializeRoomAuthoritativeGameState({ ...currentRoom, config: { ...currentRoom.config, targetScore: 1 } })',
}

type Frame = { at: number; type: string; data: any }
type Client = { frames: Frame[]; send: (m: unknown) => void; close: () => Promise<void> }
type UiPage = { page: Page; close: () => Promise<void> }
type Viewport = { label: string; width: number; height: number; mobile: boolean }

const h = await startGiftBackHarness({ patchServerSource: [SHORT_PRIVATE_MATCH] })
const wsOrigin = h.backendOrigin.replace(/^http/, 'ws')
const opened: Array<{ close: () => Promise<void> }> = []

try {
  h.db.prepare(`INSERT INTO admin_settings (setting_key, setting_value) VALUES ('belot_random_table_wait_seconds', '300') ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value`).run()
  const stakes = (h.db.prepare(`SELECT stake_amount FROM match_rooms WHERE is_enabled = 1 AND min_level <= 1 ORDER BY stake_amount`).all() as Array<{ stake_amount: number }>).map((r) => r.stake_amount)
  const [S1, S2] = [stakes[0]!, stakes[1]!]
  let tag = 0
  async function register(): Promise<TestProfile> {
    h.db.prepare('DELETE FROM registration_rate_limit_events').run()
    tag += 1
    const p = await h.register(`m${tag}`)
    h.setBalance(p.profileId, BALANCE)
    return p
  }
  const accountOf = (profileId: string) => (h.db.prepare('SELECT account_id FROM profiles WHERE profile_id = ?').get(profileId) as { account_id: string }).account_id
  const admin = await register()
  h.db.prepare(`UPDATE accounts SET role = 'admin' WHERE account_id = ?`).run(accountOf(admin.profileId))
  async function api(profile: TestProfile, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(`${h.backendOrigin}${path}`, { method, headers: { 'Content-Type': 'application/json', Cookie: `belot_session=${profile.cookie}` }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: res.status, body: await res.json().catch(() => null) }
  }
  async function impose(a: string, b: string): Promise<void> {
    const r = await api(admin, 'POST', '/api/admin/co-play-restrictions', { firstProfileId: a, secondProfileId: b, reason: 'E2E мобилен', durationDays: 30 })
    assert(r.status === 201, `(setup) налагане: ${JSON.stringify(r.body)}`)
    await sleep(600)
  }
  const flag = await api(admin, 'PUT', '/api/admin/co-play-restrictions/settings', { enabled: true })
  assert(flag.status === 200, '(setup) флаг')

  async function connect(profile: TestProfile): Promise<Client> {
    const socket = new WebSocket(`${wsOrigin}/ws`, { headers: { Cookie: `belot_session=${profile.cookie}` } })
    const frames: Frame[] = []
    socket.on('message', (raw: unknown) => { try { const data = JSON.parse(String(raw)); frames.push({ at: Date.now(), type: String(data?.type ?? ''), data }) } catch { /* ignore */ } })
    await new Promise<void>((done, reject) => { socket.once('open', () => done()); socket.once('error', reject) })
    await sleep(300)
    const client: Client = { frames, send: (m) => socket.send(JSON.stringify(m)), close: () => new Promise<void>((done) => { if (socket.readyState === WebSocket.CLOSED) { done(); return } socket.once('close', () => done()); socket.close() }) }
    opened.push(client)
    return client
  }
  async function waitFrame(frames: Frame[], predicate: (f: Frame) => boolean, from = 0, timeoutMs = 8000): Promise<Frame | null> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) { const found = frames.slice(from).find(predicate); if (found) return found; await sleep(100) }
    return null
  }
  async function openUi(profile: TestProfile, vp: Viewport): Promise<UiPage> {
    const context = await h.browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: vp.mobile, hasTouch: vp.mobile, deviceScaleFactor: vp.mobile ? 2 : 1 })
    await context.addCookies([{ name: 'belot_session', value: profile.cookie, url: h.backendOrigin }])
    await context.addInitScript(() => {
      try { localStorage.setItem('pika-consent-v2', JSON.stringify({ version: 2, necessary: true, analytics: false, marketing: false, updatedAt: new Date().toISOString() })) } catch { /* ignore */ }
      const Original = window.WebSocket
      ;(window as any).__testSockets = []
      ;(window as any).WebSocket = class extends Original {
        constructor(url: string | URL, protocols?: string | string[]) { super(url, protocols); (window as any).__testSockets.push(this) }
      }
    })
    const page = await context.newPage()
    page.on('pageerror', (error) => console.error(`    pageerror: ${error.message}`))
    await page.goto(`${h.appOrigin}/lobby`)
    await page.locator('[data-lobby-stake-card]').first().waitFor({ state: 'attached', timeout: 30_000 })
    await page.waitForTimeout(900)
    const ui = { page, close: () => context.close() }
    opened.push(ui)
    return ui
  }
  /** Команда през WebSocket-а на страницата (същата връзка/сесия като клиента). */
  const sendFromPage = (page: Page, message: unknown) => page.evaluate((m) => {
    const socket = ((window as any).__testSockets as WebSocket[]).filter((s) => s.readyState === WebSocket.OPEN).pop()!
    socket.send(JSON.stringify(m))
  }, message)
  const closeAll = async () => { for (const item of opened.splice(0)) await item.close().catch(() => undefined); await sleep(800) }

  async function expectTheme(page: Page, theme: 'mobile' | 'desktop', text: string | null, file: string): Promise<void> {
    const host = page.locator('[data-co-play-restricted-notice="1"]')
    await host.waitFor({ timeout: 10_000 })
    assert((await host.getAttribute('data-co-play-restricted-theme')) === theme, `тема ${await host.getAttribute('data-co-play-restricted-theme')}`)
    assert((await page.locator('[data-co-play-restricted-notice-title="1"]').innerText()).trim() === 'Административно ограничение', 'заглавие')
    const shown = (await page.locator('[data-co-play-restricted-notice-text="1"]').innerText()).trim()
    assert(text === null ? shown.length > 0 : shown === text, `текст: ${shown}`)
    const look = await page.evaluate(() => {
      const button = document.querySelector('[data-co-play-restricted-notice-ok="1"]') as HTMLElement
      const card = button.parentElement as HTMLElement
      const cs = getComputedStyle(card)
      const bs = getComputedStyle(button)
      const title = getComputedStyle(document.querySelector('[data-co-play-restricted-notice-title="1"]') as HTMLElement)
      const r = card.getBoundingClientRect()
      return {
        cardBg: cs.backgroundColor, cardRadius: cs.borderTopLeftRadius, titleColor: title.color,
        buttonClass: button.className, buttonBgImage: bs.backgroundImage, buttonText: button.innerText.trim(),
        shield: (card.innerText.includes('🛡')), left: r.left, right: window.innerWidth - r.right,
      }
    })
    assert(look.buttonText === 'Разбрах' && look.shield, `бутон/щит: ${JSON.stringify(look)}`)
    assert(look.left >= 0 && look.right >= 0, `картата излиза от екрана: ${JSON.stringify(look)}`)
    if (theme === 'mobile') {
      assert(look.cardBg === 'rgb(255, 255, 255)' && look.cardRadius === '16px', `карта: ${JSON.stringify(look)}`)
      assert(look.titleColor === 'rgb(23, 35, 60)', `тъмен текст: ${look.titleColor}`)
      assert(look.buttonClass.includes('lobby-violet-btn') && look.buttonClass.includes('violet-3d-btn') && look.buttonBgImage.includes('rgb(121, 80, 232)'), `виолетов бутон: ${JSON.stringify(look)}`)
    } else {
      assert(look.cardBg === 'rgba(0, 0, 0, 0)' && look.titleColor === 'rgb(244, 201, 91)' && !look.buttonClass.includes('lobby-violet-btn'), `desktop темата е променена: ${JSON.stringify(look)}`)
    }
    await page.screenshot({ path: file })
    await page.click('[data-co-play-restricted-notice-ok="1"]')
    assert((await host.count()) === 0, 'не се затвори')
  }

  /** Сядане през истинския мобилен интерфейс: „Частни маси“ -> „+“ -> потвърждение -> светлата чакалня. */
  async function sitViaMobileUi(page: Page, roomId: string): Promise<void> {
    await page.locator('[data-lobby-private-rooms-card="1"]:visible').first().click()
    const slot = page.locator(`[data-private-room-list-slot-join="${roomId}:B:0"]:visible`).first()
    await slot.waitFor({ timeout: 15_000 })
    await slot.click()
    await page.locator('[data-private-room-join-popup-confirm]:visible').first().click()
    await page.locator('[data-private-room-waiting-screen="1"]').waitFor({ timeout: 10_000 })
  }

  async function createRoom(host: Client, manualStart = true): Promise<string> {
    const from = host.frames.length
    host.send({ type: 'create_private_room', stake: S1, isLocked: false, waitMinutes: 15, manualStart })
    const created = await waitFrame(host.frames, (f) => f.type === 'private_room_updated', from)
    assert(created !== null, '(setup) маса')
    return created.data.room.id as string
  }

  // ─── Desktop контрола: тъмната тема е непроменена ───────────────────
  {
    const [pA, pB] = [await register(), await register()]
    await impose(pA.profileId, pB.profileId)
    const A = await connect(pA)
    A.send({ type: 'join_matchmaking', stake: S1 })
    await waitFrame(A.frames, (f) => f.type === 'matchmaking_joined')
    const ui = await openUi(pB, { label: 'desktop', width: 1280, height: 850, mobile: false })
    await mkdir(join(OUT, 'desktop'), { recursive: true })
    await check('[D] desktop: тъмно-златният прозорец (непроменен)', async () => {
      await ui.page.locator(`[data-lobby-stake-card="${S1}"]`).first().click()
      await expectTheme(ui.page, 'desktop', MM_TEXT, join(OUT, 'desktop', 'matchmaking.png'))
    })
    await closeAll()
  }

  const dbPath = (h.db as unknown as { location: () => string }).location()
  const tournamentStore = await createTournamentStore(dbPath)
  let tournamentSeq = 0

  for (const vp of [{ label: 'mobile-390x844', width: 390, height: 844, mobile: true }, { label: 'mobile-320x568', width: 320, height: 568, mobile: true }] as Viewport[]) {
    const dir = join(OUT, vp.label)
    await mkdir(dir, { recursive: true })

    // Случайна маса — отказ (светлата рамка на лобито).
    {
      const [pA, pB] = [await register(), await register()]
      await impose(pA.profileId, pB.profileId)
      const A = await connect(pA)
      A.send({ type: 'join_matchmaking', stake: S1 })
      await waitFrame(A.frames, (f) => f.type === 'matchmaking_joined')
      const ui = await openUi(pB, vp)
      await check(`[M1] ${vp.label}: случайна маса — отказ`, async () => {
        await ui.page.locator(`[data-lobby-stake-card="${S1}"]`).first().click()
        await expectTheme(ui.page, 'mobile', MM_TEXT, join(dir, '1-matchmaking-refused.png'))
      })
      await closeAll()
    }
    // Друг залог — мобилната чакалня.
    {
      const [pA, pB] = [await register(), await register()]
      await impose(pA.profileId, pB.profileId)
      const ui = await openUi(pB, vp)
      await ui.page.locator(`[data-lobby-stake-card="${S2}"]`).first().click()
      await ui.page.locator('[data-matchmaking-room-screen="1"]').waitFor({ timeout: 10_000 })
      const A = await connect(pA)
      A.send({ type: 'join_matchmaking', stake: S1 })
      await waitFrame(A.frames, (f) => f.type === 'matchmaking_joined')
      await check(`[M2] ${vp.label}: друг залог — в мобилната чакалня`, async () => {
        await sendFromPage(ui.page, { type: 'join_matchmaking', stake: S1 })
        await expectTheme(ui.page, 'mobile', MM_TEXT, join(dir, '2-matchmaking-other-stake.png'))
        assert((await ui.page.locator('[data-matchmaking-room-screen="1"]').count()) === 1, 'напусна чакалнята')
      })
      await closeAll()
    }
    // Премахване от случайна чакалня.
    {
      const [pA, pB] = [await register(), await register()]
      const A = await connect(pA)
      A.send({ type: 'join_matchmaking', stake: S1 })
      await waitFrame(A.frames, (f) => f.type === 'matchmaking_joined')
      const ui = await openUi(pB, vp)
      await ui.page.locator(`[data-lobby-stake-card="${S1}"]`).first().click()
      await ui.page.locator('[data-matchmaking-room-screen="1"]').waitFor({ timeout: 10_000 })
      await ui.page.waitForTimeout(800)
      await impose(pA.profileId, pB.profileId)
      await check(`[M3] ${vp.label}: премахване от случайна чакалня`, async () => {
        await expectTheme(ui.page, 'mobile', null, join(dir, '3-matchmaking-removed.png'))
      })
      await closeAll()
    }
    // Частна маса — отказ.
    {
      const [pA, pB] = [await register(), await register()]
      await impose(pA.profileId, pB.profileId)
      const A = await connect(pA)
      const roomId = await createRoom(A)
      const ui = await openUi(pB, vp)
      await check(`[M4] ${vp.label}: частна маса — отказ`, async () => {
        await sendFromPage(ui.page, { type: 'join_private_room', privateRoomId: roomId, team: 'B', slotIndex: 0 })
        await expectTheme(ui.page, 'mobile', ROOM_TEXT, join(dir, '4-private-room-refused.png'))
      })
      await closeAll()
    }
    // Премахване от частна чакалня (светлата чакалня на масата).
    {
      const [pA, pB] = [await register(), await register()]
      const A = await connect(pA)
      const roomId = await createRoom(A)
      const ui = await openUi(pB, vp)
      await sitViaMobileUi(ui.page, roomId)
      await ui.page.waitForTimeout(600)
      await impose(pA.profileId, pB.profileId)
      await check(`[M5] ${vp.label}: премахване от частна чакалня`, async () => {
        await expectTheme(ui.page, 'mobile', null, join(dir, '5-private-room-removed.png'))
      })
      await closeAll()
    }
    // Турнир.
    {
      const [pA, pB, owner] = [await register(), await register(), await register()]
      tournamentSeq += 1
      const created = tournamentStore.createTournament({
        name: `Мобилен турнир ${tournamentSeq}`, creatorProfileId: owner.profileId, visibility: 'public', entryFee: 5000,
        startMode: 'scheduled', scheduledStartAt: new Date(Date.now() + (30 + tournamentSeq * 3) * 3600_000).toISOString(), playerCapacity: 8,
      })
      assert(created.ok, '(setup) турнир')
      const tournamentId = created.tournament.tournamentId
      await impose(pA.profileId, pB.profileId)
      const joinA = await api(pA, 'POST', `/api/tournaments/${tournamentId}/join`, {})
      assert(joinA.status === 200, '(setup) A в турнира')
      const ui = await openUi(pB, vp)
      await ui.page.evaluate((id) => { history.pushState(null, '', '/tournaments/' + id); window.dispatchEvent(new PopStateEvent('popstate')) }, tournamentId)
      await check(`[M6] ${vp.label}: турнир`, async () => {
        await ui.page.locator('[data-tournament-join-open="1"]:visible').first().click()
        await ui.page.locator('[data-tournament-join-submit="1"]:visible').first().click()
        await expectTheme(ui.page, 'mobile', TOURNAMENT_TEXT, join(dir, '6-tournament.png'))
      })
      await closeAll()
    }
    // Повторен мач (мобилната маса).
    {
      const [pA, pB] = [await register(), await register()]
      const A = await connect(pA)
      const roomId = await createRoom(A, false)
      const ui = await openUi(pB, vp)
      await sitViaMobileUi(ui.page, roomId)
      const aFrom = A.frames.length
      A.send({ type: 'add_bot_to_private_room_team', team: 'A' })
      await sleep(500)
      await sendFromPage(ui.page, { type: 'add_bot_to_private_room_team', team: 'B' })
      const full = await waitFrame(A.frames, (f) => f.type === 'private_room_full', aFrom, 10_000)
      assert(full !== null, '(setup) мачът не стартира')
      const gameId = full.data.roomId as string
      await impose(pA.profileId, pB.profileId)
      const ended = await waitFrame(A.frames, (f) => f.type === 'room_snapshot' && f.data?.roomId === gameId && f.data?.roomStatus === 'finished', 0, 300_000)
      assert(ended !== null, '(setup) мачът не стигна до края')
      await sleep(1500)
      A.send({ type: 'request_replay', roomId: gameId })
      await sleep(700)
      await check(`[M7] ${vp.label}: повторен мач (мобилната маса)`, async () => {
        await ui.page.locator('[data-match-ended-replay-button="1"]:visible').first().waitFor({ timeout: 30_000 })
        await ui.page.locator('[data-match-ended-replay-button="1"]:visible').first().evaluate((el) => (el as HTMLButtonElement).click())
        await expectTheme(ui.page, 'mobile', REPLAY_TEXT, join(dir, '7-replay.png'))
      })
      await closeAll()
    }
  }
  ;(tournamentStore as unknown as { close?: () => void }).close?.()
} catch (error) {
  console.error('FATAL', error)
  console.error('--- server output (tail) ---\n' + h.serverOutput().slice(-3000))
  await check('(без фатална грешка)', () => { throw error })
} finally {
  for (const item of opened.splice(0)) await item.close().catch(() => undefined)
  console.log(`Скрийншоти: ${OUT}`)
  await h.close()
}
finishAndExit()
