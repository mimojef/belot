/**
 * checkPrivateGamesLobbyTabs.ts
 *
 * Real browser (Playwright), real production code (createLobbyFlowController
 * + renderLobbyScreen), stubbed network — UI regression check за новите
 * "Чакащи/Играещи/Приключили" табове на "Частни маси" (виж
 * privateGamesLobbyHarness.ts). Server push съобщенията се подават директно
 * през controller.handleServerMessage(...), mirror на checkPrivateRoomWaitingMobile
 * конвенцията — самият screen/DOM/CSS под тест е 100% production код.
 *
 * [1]  Default tab при отваряне на "Частни маси" е "Чакащи"
 * [2]  Смяна на tab (Играещи) реално сменя активния таб и показва играещото съдържание
 * [3]  Смяна на tab (Приключили) показва финалния резултат + дата/час
 * [4]  Realtime private_games_list push НЕ reset-ва избрания tab (остава "Играещи")
 * [5]  Realtime push, докато потребителят е на "Чакащи", също не сменя tab-а
 * [6]  Score-only push (private_game_score_updated) обновява само числото, tab-ът остава непроменен
 * [7]  Count badges: Чакащи/Играещи/Приключили показват верните бройки
 * [8]  Count badges се обновяват след private_games_list push
 * [9]  Empty state текст за "Чакащи" (без чакащи маси)
 * [10] Empty state текст за "Играещи" (без играещи маси)
 * [11] Empty state текст за "Приключили" (без приключили през последните 2 часа)
 * [12] Повторно отваряне на "Частни маси" (navigateToPrivateRooms) винаги връща на "Чакащи"
 * [13] "Играещи" карта показва Отбор А/Б, аватари/бот икони, резултат, БЕЗ join/"+"/spectate елементи
 * [14] "Приключили" карта показва краен резултат и форматирана дата/час
 * [15] Mobile viewport (390x844): tab бутоните не overflow-ват контейнера
 * [16] Mobile viewport: teams grid в "Играещи" карта остава четим (не се застъпва)
 */

import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { createServer as createNetServer } from 'node:net'

let passed = 0
let failed = 0

function pass(label: string): void { passed++; console.log(`  PASS  ${label}`) }
function fail(label: string, reason: unknown): void {
  failed++
  console.error(`  FAIL  ${label}: ${reason instanceof Error ? reason.message : String(reason)}`)
}
async function check(label: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); pass(label) } catch (err) { fail(label, err) }
}
function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}
function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) throw new Error(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`)
}

function findFreePort(): Promise<number> {
  return new Promise((resolveFree, reject) => {
    const srv = createNetServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      if (address === null || typeof address === 'string') { reject(new Error('no port')); return }
      const { port } = address
      srv.close(() => resolveFree(port))
    })
  })
}

type H = {
  navigateToPrivateRooms: () => void
  pushRoomsList: (rooms: unknown[]) => void
  pushGamesList: (playing: unknown[], finished: unknown[]) => void
  pushGameScoreUpdate: (roomId: string, teamAScore: number, teamBScore: number) => void
  clickLifecycleTab: (tab: 'waiting' | 'playing' | 'finished') => void
  getActiveLifecycleTab: () => string | null
  getTabButtonText: (tab: 'waiting' | 'playing' | 'finished') => string | null
  getTeamScoreText: (roomId: string, team: 'a' | 'b') => string | null
  getCurrentScreen: () => string
  getVisibleEmptyStateText: () => string | null
  getCalls: () => Array<{ name: string; args: unknown[] }>
  clearCalls: () => void
}

async function call<T>(page: Page, fn: (h: H, arg: any) => T, arg: any = undefined): Promise<T> {
  return page.evaluate(
    ({ fn: fnStr, arg: a }) => {
      const h = (window as any).__privateGamesLobbyHarness as H
      // eslint-disable-next-line no-eval
      const resolved = (0, eval)(fnStr) as (h: H, arg: any) => T
      return resolved(h, a)
    },
    { fn: fn.toString(), arg },
  )
}

function makeOccupant(displayName: string, isBot = false, profileId: string | null = null) {
  return { profileId: profileId ?? (isBot ? null : `p-${displayName}`), displayName, avatarUrl: null, isBot }
}

function makePlayingGame(roomId: string, teamAScore = 0, teamBScore = 0) {
  return {
    roomId,
    status: 'playing',
    stake: 5000,
    teamA: [makeOccupant('Ани'), makeOccupant('Бот Иван', true)],
    teamB: [makeOccupant('Мария'), makeOccupant('Georgi')],
    teamAScore,
    teamBScore,
    startedAt: Date.now() - 60_000,
    finishedAt: null,
  }
}

function makeFinishedGame(roomId: string, finishedAt: number, teamAScore = 151, teamBScore = 94) {
  return {
    roomId,
    status: 'finished',
    stake: 5000,
    teamA: [makeOccupant('Ани'), makeOccupant('Бот Иван', true)],
    teamB: [makeOccupant('Мария'), makeOccupant('Georgi')],
    teamAScore,
    teamBScore,
    startedAt: finishedAt - 900_000,
    finishedAt,
  }
}

console.log('\ncheckPrivateGamesLobbyTabs\n')

let vite: ViteDevServer | null = null
let browser: Browser | null = null

try {
  const port = await findFreePort()
  vite = await createViteServer({ root: process.cwd(), server: { port, strictPort: true, host: '127.0.0.1' }, logLevel: 'error' })
  await vite.listen()
  const baseUrl = `http://127.0.0.1:${port}/scripts/fixtures/privateGamesLobbyHarness.html`

  browser = await chromium.launch()

  async function newPage(viewport: { width: number; height: number } = { width: 1280, height: 900 }): Promise<{ context: BrowserContext; page: Page }> {
    const context = await browser!.newContext({ viewport })
    const page = await context.newPage()
    const pageErrors: string[] = []
    page.on('pageerror', (e) => pageErrors.push(e.message))
    await page.goto(baseUrl)
    await page.waitForFunction(() => (window as any).__privateGamesLobbyHarness !== undefined, undefined, { timeout: 10_000 })
    if (pageErrors.length > 0) throw new Error(`page errors during setup: ${pageErrors.join(' | ')}`)
    return { context, page }
  }

  {
    const { context, page } = await newPage()

    await check('[1] Default tab при отваряне на "Частни маси" е "Чакащи"', async () => {
      await call(page, (h: H) => h.navigateToPrivateRooms())
      await page.waitForTimeout(50)
      const active = await call(page, (h: H) => h.getActiveLifecycleTab())
      assertEqual(active, 'waiting', 'default tab трябва да е waiting')
    })

    await check('[7] Count badges: Чакащи/Играещи/Приключили показват верните бройки (начално 0/0/0)', async () => {
      const waitingText = await call(page, (h: H) => h.getTabButtonText('waiting'))
      const playingText = await call(page, (h: H) => h.getTabButtonText('playing'))
      const finishedText = await call(page, (h: H) => h.getTabButtonText('finished'))
      assert(waitingText !== null && /Чакащи/.test(waitingText) && /0/.test(waitingText), `waiting tab text: ${waitingText}`)
      assert(playingText !== null && /Играещи/.test(playingText) && /0/.test(playingText), `playing tab text: ${playingText}`)
      assert(finishedText !== null && /Приключили/.test(finishedText) && /0/.test(finishedText), `finished tab text: ${finishedText}`)
    })

    await check('[10] Empty state текст за "Играещи" (без играещи маси)', async () => {
      await call(page, (h: H) => h.clickLifecycleTab('playing'))
      await page.waitForTimeout(50)
      const text = await call(page, (h: H) => h.getVisibleEmptyStateText())
      assertEqual(text, 'В момента няма играещи частни маси.', 'playing empty state text')
    })

    await check('[11] Empty state текст за "Приключили" (без приключили през последните 2 часа)', async () => {
      await call(page, (h: H) => h.clickLifecycleTab('finished'))
      await page.waitForTimeout(50)
      const text = await call(page, (h: H) => h.getVisibleEmptyStateText())
      assertEqual(text, 'Няма приключили частни игри през последните 2 часа.', 'finished empty state text')
    })

    await check('[9] Empty state текст за "Чакащи" (без чакащи маси)', async () => {
      await call(page, (h: H) => h.clickLifecycleTab('waiting'))
      await page.waitForTimeout(50)
      const text = await call(page, (h: H) => h.getVisibleEmptyStateText())
      assertEqual(text, 'В момента няма чакащи частни маси.', 'waiting empty state text')
    })

    await check('[2] Смяна на tab (Играещи) реално сменя активния таб и показва играещото съдържание', async () => {
      await call(page, (h: H, games: unknown) => h.pushGamesList(games as any[], []), [makePlayingGame('room-a', 12, 5)])
      await call(page, (h: H) => h.clickLifecycleTab('playing'))
      await page.waitForTimeout(50)
      const active = await call(page, (h: H) => h.getActiveLifecycleTab())
      assertEqual(active, 'playing', 'active tab трябва да е playing')
      const scoreA = await call(page, (h: H, args: [string, 'a' | 'b']) => h.getTeamScoreText(...args), ['room-a', 'a'])
      const scoreB = await call(page, (h: H, args: [string, 'a' | 'b']) => h.getTeamScoreText(...args), ['room-a', 'b'])
      assertEqual(scoreA, '12', 'резултат под Отбор А')
      assertEqual(scoreB, '5', 'резултат под Отбор Б')
    })

    await check('[13] "Играещи" карта показва Отбор А/Б, БЕЗ join/"+"/spectate елементи', async () => {
      const bodyText = await page.evaluate(() => document.body.textContent ?? '')
      assert(bodyText.includes('ОТБОР А') && bodyText.includes('ОТБОР Б'), 'teams labels трябва да присъстват')
      const plusButtons = await page.locator('[data-private-room-list-slot-join]').count()
      assertEqual(plusButtons, 0, 'играещата карта не трябва да съдържа "+"" join бутони')
      const joinEnterButtons = await page.locator('[data-private-room-list-enter]').count()
      assertEqual(joinEnterButtons, 0, 'играещата карта не трябва да съдържа "ВЛЕЗ" бутон')
    })

    const finishedAtRecent = Date.now() - 5 * 60_000
    await check('[3] Смяна на tab (Приключили) показва финалния резултат + дата/час', async () => {
      // Реалният сървър винаги праща пълен playing+finished snapshot заедно
      // (private_games_list носи и двата масива) — тук пазим playing
      // масива от [2], за да не го изтрием случайно, mirror на реалния
      // server broadcast поведение.
      await call(
        page,
        (h: H, args: [unknown[], unknown[]]) => h.pushGamesList(...args),
        [[makePlayingGame('room-a', 12, 5)], [makeFinishedGame('room-b', finishedAtRecent, 151, 94)]],
      )
      await call(page, (h: H) => h.clickLifecycleTab('finished'))
      await page.waitForTimeout(50)
      const bodyText = await page.evaluate(() => document.body.textContent ?? '')
      assert(bodyText.includes('151') && bodyText.includes('94'), 'крайният резултат (под всеки отбор) трябва да е видим')
      assert(bodyText.includes('Приключила:'), 'дата/час label трябва да е видим')
    })

    await check('[14] "Приключили" карта показва краен резултат и форматирана дата/час (DD.MM.YYYY ... HH:MM)', async () => {
      const bodyText = await page.evaluate(() => document.body.textContent ?? '')
      // bg-BG Intl locale вмъква "г." годинен суфикс между датата и часа
      // (напр. "20.08.2026 г., 13:27") — regex-ът е permissive за
      // произволен текст между датата и часа, не фиксиран разделител.
      assert(/Приключила:\s*\d{2}\.\d{2}\.\d{4}.*?\d{2}:\d{2}/.test(bodyText), `expected formatted date/time, got body containing: ${bodyText.slice(bodyText.indexOf('Приключила'), bodyText.indexOf('Приключила') + 60)}`)
    })

    await check('[8] Count badges се обновяват след private_games_list push (1 играеща, 1 приключила)', async () => {
      const playingText = await call(page, (h: H) => h.getTabButtonText('playing'))
      const finishedText = await call(page, (h: H) => h.getTabButtonText('finished'))
      assert(playingText !== null && /1/.test(playingText), `playing badge: ${playingText}`)
      assert(finishedText !== null && /1/.test(finishedText), `finished badge: ${finishedText}`)
    })

    await check('[4] Realtime private_games_list push НЕ reset-ва избрания tab (остава "Играещи")', async () => {
      await call(page, (h: H) => h.clickLifecycleTab('playing'))
      await page.waitForTimeout(50)
      await call(page, (h: H, games: unknown) => h.pushGamesList(games as any[], []), [makePlayingGame('room-a', 20, 10), makePlayingGame('room-c', 3, 3)])
      await page.waitForTimeout(50)
      const active = await call(page, (h: H) => h.getActiveLifecycleTab())
      assertEqual(active, 'playing', 'realtime push не трябва да reset-не tab-а')
      const playingText = await call(page, (h: H) => h.getTabButtonText('playing'))
      assert(playingText !== null && /2/.test(playingText), `playing badge трябва да е 2, получено: ${playingText}`)
    })

    await check('[5] Realtime push, докато потребителят е на "Чакащи", също не сменя tab-а', async () => {
      await call(page, (h: H) => h.clickLifecycleTab('waiting'))
      await page.waitForTimeout(50)
      await call(page, (h: H, games: unknown) => h.pushGamesList(games as any[], []), [makePlayingGame('room-a', 25, 10)])
      await page.waitForTimeout(50)
      const active = await call(page, (h: H) => h.getActiveLifecycleTab())
      assertEqual(active, 'waiting', 'realtime push не трябва да измести потребителя от Чакащи')
    })

    await check('[6] Score-only push (private_game_score_updated) обновява само числото, tab-ът остава непроменен', async () => {
      await call(page, (h: H) => h.clickLifecycleTab('playing'))
      await page.waitForTimeout(50)
      await call(page, (h: H, args: [string, number, number]) => h.pushGameScoreUpdate(...args), ['room-a', 40, 15])
      await page.waitForTimeout(50)
      const active = await call(page, (h: H) => h.getActiveLifecycleTab())
      assertEqual(active, 'playing', 'score-only push не трябва да смени tab-а')
      const scoreA = await call(page, (h: H, args: [string, 'a' | 'b']) => h.getTeamScoreText(...args), ['room-a', 'a'])
      const scoreB = await call(page, (h: H, args: [string, 'a' | 'b']) => h.getTeamScoreText(...args), ['room-a', 'b'])
      assertEqual(scoreA, '40', 'резултат под Отбор А трябва да е обновен от targeted patch-а')
      assertEqual(scoreB, '15', 'резултат под Отбор Б трябва да е обновен от targeted patch-а')
    })

    await check('[12] Повторно отваряне на "Частни маси" (navigateToPrivateRooms) винаги връща на "Чакащи"', async () => {
      // В момента сме на "playing" (от предишния сценарий) — навигирай "далеч" и обратно.
      await call(page, (h: H) => h.navigateToPrivateRooms())
      await page.waitForTimeout(50)
      const active = await call(page, (h: H) => h.getActiveLifecycleTab())
      assertEqual(active, 'waiting', 'повторно отваряне трябва винаги да върне на Чакащи')
    })

    await context.close()
  }

  // ─── Mobile viewport ────────────────────────────────────────────────────
  {
    const { context, page } = await newPage({ width: 390, height: 844 })

    await call(page, (h: H) => h.navigateToPrivateRooms())
    await call(page, (h: H, games: unknown) => h.pushGamesList(games as any[], []), [makePlayingGame('room-m', 30, 20)])
    await call(page, (h: H) => h.clickLifecycleTab('playing'))
    await page.waitForTimeout(100)

    await check('[15] Mobile viewport (390x844): tab бутоните не overflow-ват контейнера (390px width)', async () => {
      const tabButtons = page.locator('[data-private-rooms-lifecycle-tab]')
      const count = await tabButtons.count()
      assertEqual(count, 3, 'трябва да има 3 tab бутона')
      for (let i = 0; i < count; i++) {
        const box = await tabButtons.nth(i).boundingBox()
        assert(box !== null, `tab button ${i} трябва да има bounding box`)
        assert(box!.x >= 0 && box!.x + box!.width <= 390 + 1, `tab button ${i} overflow-ва viewport-а: x=${box!.x} width=${box!.width}`)
      }
    })

    await check('[16] Mobile viewport: teams grid в "Играещи" карта остава четим (не се застъпва)', async () => {
      const nameEls = page.locator('.prl-slot-name')
      const count = await nameEls.count()
      assert(count >= 4, `трябва да има поне 4 occupant имена видими, получени: ${count}`)
      const boxes: Array<{ x: number; y: number; width: number; height: number }> = []
      for (let i = 0; i < count; i++) {
        const box = await nameEls.nth(i).boundingBox()
        if (box) boxes.push(box)
      }
      // Никакви два occupant-slot имена не трябва да имат идентичен (x,y) —
      // би значело визуално застъпване (същия production bug клас, описан
      // в checkPrivateRoomMobileResponsive.ts).
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const sameSpot = Math.abs(boxes[i]!.x - boxes[j]!.x) < 2 && Math.abs(boxes[i]!.y - boxes[j]!.y) < 2
          assert(!sameSpot, `occupant name slots ${i} и ${j} се застъпват на mobile: ${JSON.stringify(boxes[i])} vs ${JSON.stringify(boxes[j])}`)
        }
      }
    })

    await context.close()
  }
} finally {
  if (browser) await browser.close()
  if (vite) await vite.close()
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
