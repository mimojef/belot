/**
 * checkCampaignThemeActiveRoomRendering.ts
 *
 * Фаза 10 — Real browser (Playwright), REAL production code
 * (createActiveRoomFlowController + renderCuttingScreen/renderCuttingSeatPanels),
 * synthetic room_snapshot / active_campaign_theme messages (mirror на
 * established activeRoomSpectatorHarness.ts подход — client-side
 * rendering safety е под тест, не server protocol-а, вече покрит в
 * checkCampaignThemeAssets.ts server E2E).
 *
 * [1] Baseline (без активна тема): cutting deck pile + card backs ползват
 *     СТАНДАРТНИЯ CARD_BACK_IMAGE_PATH, не themed URL.
 * [2] active_campaign_theme push по време на cutting (без re-enter, без
 *     reload) -> desktop table background И cutting deck pile card-back
 *     веднага стават тематични.
 * [3] bidding фаза: opponent fans (right/top/left) показват тематичен
 *     гръб; own hand (bottom) си остава FACE карти — темата никога не
 *     пипа собствената ръка.
 * [4] playing фаза: table background и opponent card-backs остават
 *     тематични (темата не е phase-specific, persist-ва).
 * [5] Mobile viewport (390×844, isPhoneLayoutViewport=true) -> различен
 *     (mobile) table URL, НЕ desktop URL — доказва desktop/mobile split.
 * [6] active_campaign_theme{theme:null} ПО ВРЕМЕ на playing фаза, СЪЩАТА
 *     стая/ръка/резултат (без enterAsParticipant повторно) -> автоматично
 *     връщане към стандартна визия, без reload, без да се пипа match
 *     state (roomId/handCounts/seats непроменени).
 * [7] Spectator: тематичен гръб се вижда еднакво на всичките 4 ветрила,
 *     но НИКОГА face карта (fanHasAnyFaceCard=false за bottom/right/top/
 *     left) — темата е чисто козметичен слой, не променя hidden-card
 *     invariant-а.
 * [8] Структурна проверка (defense-in-depth отвъд DOM snapshot): третото
 *     card-back call site (renderDealingScreen.ts — packet-flight
 *     анимацията по време на deal-first-3/next-2, твърде timing-states-
 *     зависима за надежден synthetic DOM trigger в тая harness) ползва
 *     СЪЩАТА getActiveRoomCardBackImageValue() функция, вече доказана
 *     коректна в [2]/[3]/[4]/[7]; sweep/dealPacket overlay-ите остават
 *     чисти DOM-clone passthroughs без собствена card-back референция.
 */

import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright'
import { createServer as createNetServer } from 'node:net'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

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
  enterAsParticipant: (roomId: string, seat?: string) => Promise<void>
  applyParticipantSnapshot: (roomId: string, game: unknown, seats?: unknown, yourSeat?: string) => Promise<void>
  enterAsSpectator: (roomId: string, game: unknown, seats?: unknown) => Promise<void>
  applySpectatorSnapshot: (roomId: string, game: unknown, seats?: unknown) => Promise<boolean>
  render: () => Promise<void>
  cuttingGame: (overrides?: unknown) => unknown
  biddingGame: (overrides?: unknown) => unknown
  playingGame: (overrides?: unknown) => unknown
  makeSeats: (occupantsControlledByBot?: Record<string, boolean>) => unknown
  getCurrentRoomIdFn: () => string | null
  fanHasAnyFaceCard: (seat: string) => boolean
  injectServerMessage: (message: unknown) => Promise<boolean>
}

async function call<T>(page: Page, fn: (h: H, arg: any) => T, arg: any = undefined): Promise<T> {
  return page.evaluate(
    ({ fn: fnStr, arg: a }) => {
      const h = (window as any).__activeRoomSpectatorHarness as H
      // eslint-disable-next-line no-eval
      const resolved = (0, eval)(fnStr) as (h: H, arg: any) => T
      return resolved(h, a)
    },
    { fn: fn.toString(), arg },
  )
}

async function bodyHtmlIncludes(page: Page, needle: string): Promise<boolean> {
  return page.evaluate((n) => document.body.innerHTML.includes(n), needle)
}

const THEME = {
  unitIconUrl: '/uploads/campaign-themes/camp-1/icons/icon-1.gif',
  tableBgDesktopUrl: '/uploads/campaign-themes/camp-1/tables/desktop-1.webp',
  tableBgMobileUrl: '/uploads/campaign-themes/camp-1/tables/mobile-1.webp',
  cardBackUrl: '/uploads/campaign-themes/camp-1/card-backs/back-1.webp',
}
const DEFAULT_CARD_BACK = '/images/cards/card-back.webp'

console.log('\ncheckCampaignThemeActiveRoomRendering\n')

let vite: ViteDevServer | null = null
let browser: Browser | null = null

try {
  const port = await findFreePort()
  vite = await createViteServer({ root: process.cwd(), server: { port, strictPort: true, host: '127.0.0.1' }, logLevel: 'error' })
  await vite.listen()
  const baseUrl = `http://127.0.0.1:${port}/scripts/fixtures/activeRoomSpectatorHarness.html`

  browser = await chromium.launch()

  async function newPage(viewport = { width: 1280, height: 900 }): Promise<Page> {
    const context = await browser!.newContext({ viewport })
    const page = await context.newPage()
    const pageErrors: string[] = []
    page.on('pageerror', (e) => pageErrors.push(e.message))
    await page.goto(baseUrl)
    await page.waitForFunction(() => (window as any).__activeRoomSpectatorHarness !== undefined, undefined, { timeout: 10_000 })
    if (pageErrors.length > 0) throw new Error(`page errors during setup: ${pageErrors.join(' | ')}`)
    ;(page as any).__pageErrors = pageErrors
    return page
  }
  function assertNoPageErrors(page: Page, label: string): void {
    const errors = (page as any).__pageErrors as string[]
    assert(errors.length === 0, `${label}: errors: ${errors.join(' | ')}`)
  }

  const roomId = 'theme-room-1'
  const page = await newPage()

  await check('[1] Baseline без тема: cutting deck pile ползва DEFAULT card-back, не themed URL', async () => {
    await call(page, (h: H, rid: string) => h.enterAsParticipant(rid, 'bottom'), roomId)
    await call(page, (h: H, g: { rid: string; game: unknown }) => h.applyParticipantSnapshot(g.rid, g.game, h.makeSeats(), 'bottom'),
      { rid: roomId, game: await call(page, (h: H) => h.cuttingGame()) })
    assert(await bodyHtmlIncludes(page, DEFAULT_CARD_BACK), 'трябва да ползва default card-back')
    assert(!(await bodyHtmlIncludes(page, THEME.cardBackUrl)), 'не трябва да има themed URL без активна тема')
    assertNoPageErrors(page, '[1]')
  })

  await check('[2] active_campaign_theme push по време на cutting -> desktop маса + deck pile стават тематични, без re-enter', async () => {
    const before = await call(page, (h: H) => h.getCurrentRoomIdFn())
    assert(before === roomId, 'трябва да е СЪЩАТА стая преди push-а')
    const handled = await call(page, (h: H, theme: unknown) => h.injectServerMessage({ type: 'active_campaign_theme', theme }), THEME)
    assert(handled === false, 'active_campaign_theme връща false (fire-and-forget), очаквано поведение')
    await page.waitForFunction((needle) => document.body.innerHTML.includes(needle), THEME.tableBgDesktopUrl, { timeout: 3_000 })
    assert(await bodyHtmlIncludes(page, THEME.tableBgDesktopUrl), 'desktop table background трябва да е тематичен')
    assert(await bodyHtmlIncludes(page, THEME.cardBackUrl), 'cutting deck pile card-back трябва да е тематичен')
    const after = await call(page, (h: H) => h.getCurrentRoomIdFn())
    assert(after === roomId, 'СЪЩАТА стая след push-а — без re-enter/reload')
  })

  await check('[3] bidding: opponent fans тематични, own hand (bottom) остава FACE карти', async () => {
    const game = await call(page, (h: H) => h.biddingGame({
      handCounts: { bottom: 2, right: 5, top: 5, left: 5 },
      ownHand: [{ id: 'c7', suit: 'clubs', rank: '7' }, { id: 'd8', suit: 'diamonds', rank: '8' }],
    }))
    await call(page, (h: H, g: { rid: string; game: unknown }) => h.applyParticipantSnapshot(g.rid, g.game, h.makeSeats(), 'bottom'), { rid: roomId, game })
    assert(await bodyHtmlIncludes(page, THEME.cardBackUrl), 'opponent card-backs трябва да са тематични по време на bidding')
    const bottomHasFace = await call(page, (h: H) => h.fanHasAnyFaceCard('bottom'))
    assert(bottomHasFace, 'own hand (bottom) трябва да показва FACE карти, не гръб')
  })

  await check('[3b] Теми push, докато bidding е СТАБИЛНА (без друга промяна) -> fast dedup пътят НЕ скрива темата (регресия за biddingStableRenderKey)', async () => {
    await call(page, (h: H) => h.injectServerMessage({ type: 'active_campaign_theme', theme: null }))
    const game = await call(page, (h: H) => h.biddingGame({
      handCounts: { bottom: 2, right: 5, top: 5, left: 5 },
      ownHand: [{ id: 'c7', suit: 'clubs', rank: '7' }, { id: 'd8', suit: 'diamonds', rank: '8' }],
    }))
    await call(page, (h: H, g: { rid: string; game: unknown }) => h.applyParticipantSnapshot(g.rid, g.game, h.makeSeats(), 'bottom'), { rid: roomId, game })
    assert(!(await bodyHtmlIncludes(page, THEME.cardBackUrl)), 'sanity: без тема преди push-а')
    await call(page, (h: H, theme: unknown) => h.injectServerMessage({ type: 'active_campaign_theme', theme }), THEME)
    await page.waitForFunction((needle) => document.body.innerHTML.includes(needle), THEME.cardBackUrl, { timeout: 3_000 })
    assert(await bodyHtmlIncludes(page, THEME.cardBackUrl), 'темата трябва да се приложи дори докато bidding снимката е СТАБИЛНА (same key)')
  })

  await check('[4] playing: table background и opponent card-backs остават тематични (темата не е phase-specific)', async () => {
    const game = await call(page, (h: H) => h.playingGame())
    await call(page, (h: H, g: { rid: string; game: unknown }) => h.applyParticipantSnapshot(g.rid, g.game, h.makeSeats(), 'bottom'), { rid: roomId, game })
    assert(await bodyHtmlIncludes(page, THEME.tableBgDesktopUrl), 'table background трябва да остане тематичен в playing фаза')
    assert(await bodyHtmlIncludes(page, THEME.cardBackUrl), 'opponent card-backs трябва да останат тематични в playing фаза')
  })

  await check('[5] Mobile viewport (390×844) -> mobile table URL, НЕ desktop URL', async () => {
    await page.setViewportSize({ width: 390, height: 844 })
    await call(page, (h: H) => h.render())
    assert(await bodyHtmlIncludes(page, THEME.tableBgMobileUrl), 'mobile viewport трябва да ползва mobile table URL')
    assert(!(await bodyHtmlIncludes(page, THEME.tableBgDesktopUrl)), 'mobile viewport НЕ трябва да съдържа desktop table URL')
    await page.setViewportSize({ width: 1280, height: 900 })
    await call(page, (h: H) => h.render())
    assert(await bodyHtmlIncludes(page, THEME.tableBgDesktopUrl), 'след връщане към desktop viewport -> пак desktop URL')
  })

  await check('[6] active_campaign_theme{theme:null} ПО ВРЕМЕ на playing -> автоматично revert, СЪЩАТА стая (без reload, без match restart)', async () => {
    // Нормализира state-а след [5]-ия ръчен render()/viewport toggle с нов
    // реален room_snapshot (playing), преди revert push-а — изолира дали
    // revert-ът реално работи от production dispatch пътя (handleServerMessage),
    // не от специфика на директния render() extra-а, ползван само за [5].
    const game = await call(page, (h: H) => h.playingGame())
    await call(page, (h: H, g: { rid: string; game: unknown }) => h.applyParticipantSnapshot(g.rid, g.game, h.makeSeats(), 'bottom'), { rid: roomId, game })
    assert(await bodyHtmlIncludes(page, THEME.tableBgDesktopUrl), 'sanity: темата трябва да е активна точно преди revert push-а')

    const roomBefore = await call(page, (h: H) => h.getCurrentRoomIdFn())
    await call(page, (h: H) => h.injectServerMessage({ type: 'active_campaign_theme', theme: null }))
    await page.waitForFunction((needle) => !document.body.innerHTML.includes(needle), THEME.tableBgDesktopUrl, { timeout: 3_000 }).catch(() => {})
    assert(!(await bodyHtmlIncludes(page, THEME.tableBgDesktopUrl)), 'desktop table theme трябва да изчезне')
    assert(!(await bodyHtmlIncludes(page, THEME.cardBackUrl)), 'card-back theme трябва да изчезне')
    assert(await bodyHtmlIncludes(page, DEFAULT_CARD_BACK), 'трябва да се върне DEFAULT card-back')
    const roomAfter = await call(page, (h: H) => h.getCurrentRoomIdFn())
    assert(roomAfter === roomBefore, 'стаята трябва да е СЪЩАТА — revert-ът не пипа match state')
  })

  await check('[7] Spectator: тематичен гръб навсякъде, НИКОГА face карта (hidden-card invariant непроменен от темата)', async () => {
    await call(page, (h: H, theme: unknown) => h.injectServerMessage({ type: 'active_campaign_theme', theme }), THEME)
    const specGame = await call(page, (h: H) => h.playingGame())
    await call(page, (h: H, g: { rid: string; game: unknown }) => h.enterAsSpectator(g.rid, g.game, h.makeSeats()), { rid: 'theme-room-spectator', game: specGame })
    assert(await bodyHtmlIncludes(page, THEME.cardBackUrl), 'spectator трябва да вижда тематичния гръб (чисто козметичен слой)')
    for (const seat of ['bottom', 'right', 'top', 'left']) {
      const hasFace = await call(page, (h: H, s: string) => h.fanHasAnyFaceCard(s), seat)
      assert(!hasFace, `spectator fan "${seat}" НЕ трябва да показва face карта независимо от темата`)
    }
  })

  await check('[8] Структурна защита: третото card-back call site (renderDealingScreen.ts) ползва СЪЩАТА shared функция; sweep overlay-ите нямат собствена card-back референция', () => {
    const srcRoot = resolve(process.cwd(), 'src', 'app', 'activeRoom')
    const dealingScreen = readFileSync(join(srcRoot, 'renderDealingScreen.ts'), 'utf8')
    assert(dealingScreen.includes('getActiveRoomCardBackImageValue'), 'renderDealingScreen.ts трябва да ползва getActiveRoomCardBackImageValue()')
    assert(!dealingScreen.includes('CARD_BACK_IMAGE_PATH'), 'renderDealingScreen.ts не трябва вече да реферира литералния CARD_BACK_IMAGE_PATH директно')
    for (const file of ['animateSweepThrowDown.ts', 'dealPacketOverlay.ts']) {
      const src = readFileSync(join(srcRoot, file), 'utf8')
      assert(!src.includes('CARD_BACK_IMAGE_PATH') && !src.includes('getActiveRoomCardBackImageValue'), `${file} трябва да остане чист DOM-clone passthrough без собствена card-back референция`)
    }
  })
} finally {
  if (browser) await browser.close()
  if (vite) await vite.close()
}

console.log(`\n${'═'.repeat(60)}`)
console.log(`Passed: ${passed}  Failed: ${failed}`)
if (failed > 0) process.exit(1)
