/**
 * checkBelotSpectatorWatchVipFlow.ts
 *
 * Real browser (Playwright), real production code (createLobbyFlowController
 * + renderLobbyScreen + renderVipRequiredPopup), stubbed network — UI/flow
 * regression за Belot Spectator Mode "Гледай" бутон + VIP UX + client
 * protocol/session (Phase 3A). Server push съобщенията се подават директно
 * през controller.handleServerMessage(...), mirror на
 * checkPrivateGamesLobbyTabs.ts конвенцията (виж privateGamesLobbyHarness.ts) —
 * самият screen/DOM/CSS под тест е 100% production код.
 *
 * A. Button/capability
 *   [A1] feature OFF -> няма "Гледай" бутон
 *   [A2] feature ON -> всяка playing private Belot маса има "Гледай"
 *   [A3] бутонът е видим и преди VIP статусът да е известен (non-VIP also sees it)
 *
 * B. VIP UX
 *   [B1] active VIP click -> watch_belot_room веднага, без popup
 *   [B2] no VIP + launch gift unclaimed -> existing free-VIP popup (gift variant)
 *   [B3] самото отваряне на popup-а НЕ claim-ва free VIP
 *   [B4] successful claim -> automatic watch към същия roomId, popup затворен
 *   [B5] cancel popup -> no watch; pending room изчистен
 *   [B6] no VIP + gift already claimed -> "Вземи VIP" popup variant
 *   [B7] "Вземи VIP" -> Shop се отваря на VIP tab
 *   [B8] server vip_required race (след user click) -> popup се отваря/обновява, pending се пази
 *   [B9] vip_required след claim fail (already_claimed race) -> refresh, без popup spam ако вече active
 *
 * C. Protocol/session
 *   [C1] watch ACK (belot_spectate_started) -> spectatingBelotRoomId се установява
 *   [C2] spectator snapshot за ДРУГА стая се discard-ва; за текущата се приема
 *   [C3] explicit unwatch -> unwatch_belot_room protocol call + state cleanup
 *   [C4] belot_spectate_ended -> state cleanup (spectating/pending/snapshot)
 *   [C5] reconnect ('connected' push) с active spectating room -> re-watch (watch_belot_room отново)
 *   [C6] reconnect denial (vip_required, без matching pending) -> тих cleanup, БЕЗ popup
 *   [C7] source review: Belot spectator кодът никога не вика resume_room/leave_active_room/join_room
 *
 * E. Phase 3B.2 (D1 VIP popup flash, D8 blank root, D10 echo, R7)
 *   [E1/V1] fresh client + active VIP + бавен status -> 0 popup вмъквания, един watch
 *   [E2/V2+V3] inactive VIP + неизползван gift -> free popup едва след load; click не claim-ва
 *   [E3/V5] използван gift -> „Вземи VIP“ след load
 *   [E4] status load failure -> без client догадки/popup; watch се праща (server решава)
 *   [E5/R7] background re-watch vip_required -> чист state, Частни маси -> Играещи, без popup
 *   [E6/C2] belot_spectate_ended рендерира стабилния Играещи shell веднага
 *   [E7/D10] explicit unwatch навигира веднъж; server echo-то ended се игнорира
 *   [E8/C6] re-entry с „Гледай“ след exit
 *
 * D. Regression (пуснати отделно в cull regression пас, не тук):
 *   checkTopicsComposerVipGate.ts, checkPrivateGamesLobbyTabs.ts
 */

import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { chromium, type Browser, type Page } from 'playwright'
import { createServer as createNetServer } from 'node:net'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

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
  pushGamesList: (playing: unknown[], finished: unknown[], belotSpectatingEnabled?: boolean) => void
  clickLifecycleTab: (tab: 'waiting' | 'playing' | 'finished') => void
  hasWatchButton: (roomId: string) => boolean
  clickWatchBelotRoom: (roomId: string) => void
  setVipGateStatusResponse: (response: { ok: true; isActive: boolean; hasClaimedLaunchGift: boolean; launchGiftDays: number } | { ok: false }) => void
  setClaimLaunchGiftResponse: (response: { ok: true; isActive: boolean; activeUntil?: string | null } | { ok: false; alreadyClaimed: boolean; giftDisabled: boolean }) => void
  isBelotSpectatorVipPopupOpen: () => boolean
  getBelotSpectatorVipPopupCardText: () => string | null
  clickBelotSpectatorVipPopupClaim: () => void
  clickBelotSpectatorVipPopupGoToShop: () => void
  clickBelotSpectatorVipPopupClose: () => void
  pushBelotSpectateStarted: (roomId: string) => void
  pushBelotSpectateDenied: (roomId: string, code: string, message: string) => void
  pushBelotSpectateEnded: (roomId: string, reason: string) => void
  pushBelotSpectatorSnapshot: (roomId: string) => void
  pushConnected: () => void
  getSpectatingBelotRoomId: () => string | null
  getPendingBelotSpectatorRoomId: () => string | null
  getBelotSpectatorSnapshotRoomId: () => string | null
  unwatchBelotSpectatorRoom: () => void
  getShopActiveTab: () => string
  getCurrentScreen: () => string
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

console.log('\ncheckBelotSpectatorWatchVipFlow\n')

let vite: ViteDevServer | null = null
let browser: Browser | null = null

try {
  const port = await findFreePort()
  vite = await createViteServer({ root: process.cwd(), server: { port, strictPort: true, host: '127.0.0.1' }, logLevel: 'error' })
  await vite.listen()
  const baseUrl = `http://127.0.0.1:${port}/scripts/fixtures/privateGamesLobbyHarness.html`

  browser = await chromium.launch()

  async function newPage(): Promise<Page> {
    const context = await browser!.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    const pageErrors: string[] = []
    page.on('pageerror', (e) => pageErrors.push(e.message))
    await page.goto(baseUrl)
    await page.waitForFunction(() => (window as any).__privateGamesLobbyHarness !== undefined, undefined, { timeout: 10_000 })
    if (pageErrors.length > 0) throw new Error(`page errors during setup: ${pageErrors.join(' | ')}`)
    return page
  }

  // ── A. Button/capability ──────────────────────────────────────────────
  {
    const page = await newPage()
    await call(page, (h: H) => h.navigateToPrivateRooms())

    await check('[A1] feature OFF -> no "Гледай" button', async () => {
      await call(page, (h: H, games: unknown) => h.pushGamesList(games as any[], [], false), [makePlayingGame('room-off')])
      await call(page, (h: H) => h.clickLifecycleTab('playing'))
      await page.waitForTimeout(50)
      const has = await call(page, (h: H) => h.hasWatchButton('room-off'))
      assertEqual(has, false, 'watch button must be absent when feature flag is OFF')
    })

    await check('[A2] feature ON -> every playing room has "Гледай"', async () => {
      await call(page, (h: H, games: unknown) => h.pushGamesList(games as any[], [], true), [makePlayingGame('room-a'), makePlayingGame('room-b')])
      await page.waitForTimeout(50)
      const hasA = await call(page, (h: H) => h.hasWatchButton('room-a'))
      const hasB = await call(page, (h: H) => h.hasWatchButton('room-b'))
      assert(hasA && hasB, `expected watch buttons for both rooms, got a=${hasA} b=${hasB}`)
    })

    await check('[A3] button visible without any VIP gate response loaded yet (non-VIP also sees it)', async () => {
      await call(page, (h: H) => h.setVipGateStatusResponse({ ok: false }))
      const has = await call(page, (h: H) => h.hasWatchButton('room-a'))
      assert(has, 'watch button must not depend on VIP status to be visible')
    })

    await page.close()
  }

  // ── B. VIP UX ──────────────────────────────────────────────────────────
  // VIP gate-ът (state.topicsVipGate) е lazy-load-once cache (виж
  // ensureTopicsVipGateLoaded) — веднъж resolved в рамките на една page
  // session, следващи click-ове НЕ го refetch-ват автоматично (точно както
  // в production). Затова всеки РАЗЛИЧЕН начален VIP сценарий ползва fresh
  // page/session, а не mutate-ва mock response-а след първия load.

  await check('[B1] active VIP click -> watch_belot_room immediately, no popup', async () => {
    const page = await newPage()
    await call(page, (h: H) => h.navigateToPrivateRooms())
    await call(page, (h: H, games: unknown) => h.pushGamesList(games as any[], [], true), [makePlayingGame('room-vip-1')])
    await call(page, (h: H) => h.clickLifecycleTab('playing'))
    await call(page, (h: H) => h.setVipGateStatusResponse({ ok: true, isActive: true, hasClaimedLaunchGift: true, launchGiftDays: 30 }))
    await call(page, (h: H) => h.clickWatchBelotRoom('room-vip-1'))
    await page.waitForTimeout(80)
    const popupOpen = await call(page, (h: H) => h.isBelotSpectatorVipPopupOpen())
    assertEqual(popupOpen, false, 'no VIP popup for an active-VIP click')
    const calls = await call(page, (h: H) => h.getCalls())
    assert(calls.some((c) => c.name === 'onWatchBelotRoom' && c.args[0] === 'room-vip-1'), 'onWatchBelotRoom must fire immediately')
    await page.close()
  })

  // B2/B3/B5/B4 share one session: open popup (gift variant) -> verify no
  // auto-claim -> cancel (pending cleared) -> reopen -> claim successfully.
  {
    const page = await newPage()
    await call(page, (h: H) => h.navigateToPrivateRooms())
    await call(page, (h: H, games: unknown) => h.pushGamesList(games as any[], [], true), [makePlayingGame('room-vip-2')])
    await call(page, (h: H) => h.clickLifecycleTab('playing'))
    await call(page, (h: H) => h.setVipGateStatusResponse({ ok: true, isActive: false, hasClaimedLaunchGift: false, launchGiftDays: 14 }))

    await check('[B2] no VIP + launch gift unclaimed -> free-VIP gift popup', async () => {
      await call(page, (h: H) => h.clickWatchBelotRoom('room-vip-2'))
      await page.waitForTimeout(80)
      const popupOpen = await call(page, (h: H) => h.isBelotSpectatorVipPopupOpen())
      assert(popupOpen, 'popup must open for a non-VIP click')
      const text = await call(page, (h: H) => h.getBelotSpectatorVipPopupCardText())
      assert(text !== null && /14 дни безплатно/.test(text), `expected free-gift wording, got: ${text}`)
    })

    await check('[B3] opening the popup itself does NOT claim the free VIP', async () => {
      const calls = await call(page, (h: H) => h.getCalls())
      assert(!calls.some((c) => c.name === 'onClaimTopicsLaunchGift'), 'claim must not fire just from opening the popup')
    })

    await check('[B5] cancel popup -> no watch sent; pending room cleared', async () => {
      await call(page, (h: H) => h.clearCalls())
      await call(page, (h: H) => h.clickBelotSpectatorVipPopupClose())
      await page.waitForTimeout(30)
      const calls = await call(page, (h: H) => h.getCalls())
      assert(!calls.some((c) => c.name === 'onWatchBelotRoom'), 'cancel must never trigger a watch call')
      const pending = await call(page, (h: H) => h.getPendingBelotSpectatorRoomId())
      assertEqual(pending, null, 'pending room must be cleared on cancel')
      const popupOpen = await call(page, (h: H) => h.isBelotSpectatorVipPopupOpen())
      assertEqual(popupOpen, false, 'popup must be closed')
    })

    await check('[B4] successful claim -> automatic watch to the SAME pending room, popup closes', async () => {
      await call(page, (h: H) => h.clickWatchBelotRoom('room-vip-2'))
      await page.waitForTimeout(80)
      await call(page, (h: H) => h.setClaimLaunchGiftResponse({ ok: true, isActive: true, activeUntil: '2027-01-01T00:00:00.000Z' }))
      await call(page, (h: H) => h.clearCalls())
      await call(page, (h: H) => h.clickBelotSpectatorVipPopupClaim())
      await page.waitForTimeout(80)
      const popupOpen = await call(page, (h: H) => h.isBelotSpectatorVipPopupOpen())
      assertEqual(popupOpen, false, 'popup must close after a successful claim')
      const calls = await call(page, (h: H) => h.getCalls())
      assert(calls.some((c) => c.name === 'onWatchBelotRoom' && c.args[0] === 'room-vip-2'), 'successful claim must auto-retry watch for the originally selected room')
    })

    await page.close()
  }

  // B6/B7: fresh session, gift already claimed from the start.
  {
    const page = await newPage()
    await call(page, (h: H) => h.navigateToPrivateRooms())
    await call(page, (h: H, games: unknown) => h.pushGamesList(games as any[], [], true), [makePlayingGame('room-vip-3')])
    await call(page, (h: H) => h.clickLifecycleTab('playing'))
    await call(page, (h: H) => h.setVipGateStatusResponse({ ok: true, isActive: false, hasClaimedLaunchGift: true, launchGiftDays: 14 }))

    await check('[B6] no VIP + gift already claimed -> "Вземи VIP" popup variant', async () => {
      await call(page, (h: H) => h.clickWatchBelotRoom('room-vip-3'))
      await page.waitForTimeout(80)
      const text = await call(page, (h: H) => h.getBelotSpectatorVipPopupCardText())
      assert(text !== null && /Вземи VIP/.test(text) && /вече е използван/.test(text), `expected already-claimed "Вземи VIP" wording, got: ${text}`)
    })

    await check('[B7] "Вземи VIP" -> Shop opens on the VIP tab', async () => {
      await call(page, (h: H) => h.clickBelotSpectatorVipPopupGoToShop())
      await page.waitForTimeout(80)
      const screen = await call(page, (h: H) => h.getCurrentScreen())
      const tab = await call(page, (h: H) => h.getShopActiveTab())
      assertEqual(screen, 'shop', 'must navigate to the shop screen')
      assertEqual(tab, 'vip', 'shop must open on the VIP tab')
      const popupOpen = await call(page, (h: H) => h.isBelotSpectatorVipPopupOpen())
      assertEqual(popupOpen, false, 'popup must close when going to shop')
    })

    await page.close()
  }

  // ── B8/B9: server-side VIP race handling ────────────────────────────────
  {
    const page = await newPage()
    await call(page, (h: H) => h.navigateToPrivateRooms())
    await call(page, (h: H, games: unknown) => h.pushGamesList(games as any[], [], true), [makePlayingGame('room-race')])
    await call(page, (h: H) => h.clickLifecycleTab('playing'))
    await page.waitForTimeout(50)

    await check('[B8] server vip_required race after a user click -> popup opens, pending preserved, no infinite retry', async () => {
      // Client thought VIP was active (stale cache); server disagrees.
      await call(page, (h: H) => h.setVipGateStatusResponse({ ok: true, isActive: true, hasClaimedLaunchGift: true, launchGiftDays: 30 }))
      await call(page, (h: H) => h.clickWatchBelotRoom('room-race'))
      await page.waitForTimeout(50)
      await call(page, (h: H) => h.clearCalls())
      // Now the (stale) gate must be force-refreshed to reflect reality.
      await call(page, (h: H) => h.setVipGateStatusResponse({ ok: true, isActive: false, hasClaimedLaunchGift: false, launchGiftDays: 30 }))
      await call(page, (h: H, roomId: string) => h.pushBelotSpectateDenied(roomId, 'vip_required', 'Гледането на тази маса изисква активен VIP.'), 'room-race')
      await page.waitForTimeout(80)
      const popupOpen = await call(page, (h: H) => h.isBelotSpectatorVipPopupOpen())
      assert(popupOpen, 'vip_required denial after a user click must open the VIP popup')
      const pending = await call(page, (h: H) => h.getPendingBelotSpectatorRoomId())
      assertEqual(pending, 'room-race', 'pending room must be preserved through the vip_required race')
      const calls = await call(page, (h: H) => h.getCalls())
      const vipFetches = calls.filter((c) => c.name === 'onGetTopicsVipGateStatus').length
      assert(vipFetches === 1, `expected exactly one re-fetch, got ${vipFetches} (no retry loop)`)
    })

    await page.close()
  }

  // ── C. Protocol/session ─────────────────────────────────────────────────
  {
    const page = await newPage()
    await call(page, (h: H) => h.navigateToPrivateRooms())
    await call(page, (h: H, games: unknown) => h.pushGamesList(games as any[], [], true), [makePlayingGame('room-c')])
    await call(page, (h: H) => h.clickLifecycleTab('playing'))
    await page.waitForTimeout(50)

    await check('[C1] belot_spectate_started -> spectatingBelotRoomId is set', async () => {
      await call(page, (h: H, roomId: string) => h.pushBelotSpectateStarted(roomId), 'room-c')
      const spectating = await call(page, (h: H) => h.getSpectatingBelotRoomId())
      assertEqual(spectating, 'room-c', 'spectating room must match the started ACK')
    })

    await check('[C2] snapshot for a different room is discarded; snapshot for the watched room is accepted', async () => {
      await call(page, (h: H, roomId: string) => h.pushBelotSpectatorSnapshot(roomId), 'room-other')
      const afterOther = await call(page, (h: H) => h.getBelotSpectatorSnapshotRoomId())
      assertEqual(afterOther, null, 'snapshot for a non-watched room must be ignored')
      await call(page, (h: H, roomId: string) => h.pushBelotSpectatorSnapshot(roomId), 'room-c')
      const afterOwn = await call(page, (h: H) => h.getBelotSpectatorSnapshotRoomId())
      assertEqual(afterOwn, 'room-c', 'snapshot for the currently watched room must be accepted')
    })

    await check('[C3] explicit unwatch -> unwatch_belot_room protocol call + state cleanup', async () => {
      await call(page, (h: H) => h.clearCalls())
      await call(page, (h: H) => h.unwatchBelotSpectatorRoom())
      const calls = await call(page, (h: H) => h.getCalls())
      assert(calls.some((c) => c.name === 'onUnwatchBelotRoom' && c.args[0] === 'room-c'), 'explicit unwatch must send unwatch_belot_room')
      const spectating = await call(page, (h: H) => h.getSpectatingBelotRoomId())
      assertEqual(spectating, null, 'spectating state must be cleared after unwatch')
      const snapshotRoom = await call(page, (h: H) => h.getBelotSpectatorSnapshotRoomId())
      assertEqual(snapshotRoom, null, 'snapshot must be cleared after unwatch')
    })

    await check('[C4] belot_spectate_ended -> full state cleanup', async () => {
      await call(page, (h: H, roomId: string) => h.pushBelotSpectateStarted(roomId), 'room-c')
      await call(page, (h: H, roomId: string) => h.pushBelotSpectateEnded(roomId, 'room_removed'), 'room-c')
      const spectating = await call(page, (h: H) => h.getSpectatingBelotRoomId())
      assertEqual(spectating, null, 'spectating must be cleared on ended')
    })

    await check('[C5] reconnect ("connected" push) with an active spectating room -> re-watch sent', async () => {
      await call(page, (h: H, roomId: string) => h.pushBelotSpectateStarted(roomId), 'room-c')
      await call(page, (h: H) => h.clearCalls())
      await call(page, (h: H) => h.pushConnected())
      const calls = await call(page, (h: H) => h.getCalls())
      assert(calls.some((c) => c.name === 'onWatchBelotRoom' && c.args[0] === 'room-c'), 'reconnect must re-send watch_belot_room for the same room, never resume_room')
    })

    await check('[C6] reconnect denial (vip_required, no matching pending) -> silent cleanup, no popup spam', async () => {
      await call(page, (h: H) => h.clearCalls())
      await call(page, (h: H, roomId: string) => h.pushBelotSpectateDenied(roomId, 'vip_required', 'Гледането на тази маса изисква активен VIP.'), 'room-c')
      await page.waitForTimeout(50)
      const popupOpen = await call(page, (h: H) => h.isBelotSpectatorVipPopupOpen())
      assertEqual(popupOpen, false, 'a background reconnect denial must never open the VIP popup')
      const spectating = await call(page, (h: H) => h.getSpectatingBelotRoomId())
      assertEqual(spectating, null, 'spectating state must be cleared silently')
    })

    await page.close()
  }

  // ── E. Phase 3B.2 — VIP decision ordering, termination, re-entry ────────
  async function installPopupInsertionCounter(page: Page): Promise<void> {
    await page.evaluate(() => {
      const w = window as any
      w.__vipPopupInsertions = 0
      new MutationObserver((mutations) => {
        for (const m of mutations) {
          for (const n of m.addedNodes) {
            if (!(n instanceof Element)) continue
            if (n.matches('[data-belot-spectator-vip-popup-backdrop]') || n.querySelector('[data-belot-spectator-vip-popup-backdrop]')) {
              w.__vipPopupInsertions += 1
            }
          }
        }
      }).observe(document.body, { childList: true, subtree: true })
    })
  }
  const popupInsertions = (page: Page) => page.evaluate(() => (window as any).__vipPopupInsertions as number)

  await check('[E1/V1] fresh client + active VIP + slow status load -> 0 popup insertions, status awaited, watch sent once', async () => {
    const page = await newPage()
    await call(page, (h: H) => h.navigateToPrivateRooms())
    await call(page, (h: H, games: unknown) => h.pushGamesList(games as any[], [], true), [makePlayingGame('room-e1')])
    await call(page, (h: H) => h.clickLifecycleTab('playing'))
    await call(page, (h: H) => h.setVipGateStatusResponse({ ok: true, isActive: true, hasClaimedLaunchGift: true, launchGiftDays: 30 }))
    await call(page, (h: any) => h.setVipGateStatusDelayMs(300))
    await installPopupInsertionCounter(page)
    await call(page, (h: H) => h.clearCalls())
    await call(page, (h: H) => h.clickWatchBelotRoom('room-e1'))
    await call(page, (h: H) => h.clickWatchBelotRoom('room-e1')) // double click while status is loading
    await page.waitForTimeout(120)
    const midCalls = await call(page, (h: H) => h.getCalls())
    assert(!midCalls.some((c) => c.name === 'onWatchBelotRoom'), 'watch must wait for the canonical VIP status')
    assertEqual(await popupInsertions(page), 0, 'no popup while VIP status is unknown')
    await page.waitForTimeout(450)
    const calls = await call(page, (h: H) => h.getCalls())
    assertEqual(calls.filter((c) => c.name === 'onGetTopicsVipGateStatus').length, 1, 'single VIP status request')
    assertEqual(calls.filter((c) => c.name === 'onWatchBelotRoom' && c.args[0] === 'room-e1').length, 1, 'exactly one watch after status load')
    assertEqual(await popupInsertions(page), 0, 'active VIP must never insert the VIP popup')
    await page.close()
  })

  await check('[E2/V2+V3] slow status + inactive VIP + unused gift -> free popup only AFTER load; click never claims', async () => {
    const page = await newPage()
    await call(page, (h: H) => h.navigateToPrivateRooms())
    await call(page, (h: H, games: unknown) => h.pushGamesList(games as any[], [], true), [makePlayingGame('room-e2')])
    await call(page, (h: H) => h.clickLifecycleTab('playing'))
    await call(page, (h: H) => h.setVipGateStatusResponse({ ok: true, isActive: false, hasClaimedLaunchGift: false, launchGiftDays: 30 }))
    await call(page, (h: any) => h.setVipGateStatusDelayMs(250))
    await installPopupInsertionCounter(page)
    await call(page, (h: H) => h.clearCalls())
    await call(page, (h: H) => h.clickWatchBelotRoom('room-e2'))
    await page.waitForTimeout(100)
    assertEqual(await popupInsertions(page), 0, 'popup must not appear before the status is known')
    await page.waitForTimeout(350)
    assert(await call(page, (h: H) => h.isBelotSpectatorVipPopupOpen()), 'free-VIP popup after load')
    const text = await call(page, (h: H) => h.getBelotSpectatorVipPopupCardText())
    assert(text !== null && /30 дни безплатно/.test(text), `expected free-gift wording, got: ${text}`)
    const calls = await call(page, (h: H) => h.getCalls())
    assert(!calls.some((c) => c.name === 'onClaimTopicsLaunchGift'), 'the click itself must not claim')
    assert(!calls.some((c) => c.name === 'onWatchBelotRoom'), 'no watch before VIP')
    await page.close()
  })

  await check('[E3/V5] slow status + gift already used -> "Вземи VIP" popup after load', async () => {
    const page = await newPage()
    await call(page, (h: H) => h.navigateToPrivateRooms())
    await call(page, (h: H, games: unknown) => h.pushGamesList(games as any[], [], true), [makePlayingGame('room-e3')])
    await call(page, (h: H) => h.clickLifecycleTab('playing'))
    await call(page, (h: H) => h.setVipGateStatusResponse({ ok: true, isActive: false, hasClaimedLaunchGift: true, launchGiftDays: 30 }))
    await call(page, (h: any) => h.setVipGateStatusDelayMs(200))
    await call(page, (h: H) => h.clickWatchBelotRoom('room-e3'))
    await page.waitForTimeout(400)
    const text = await call(page, (h: H) => h.getBelotSpectatorVipPopupCardText())
    assert(text !== null && /Вземи VIP/.test(text), `expected "Вземи VIP" variant, got: ${text}`)
    await page.close()
  })

  await check('[E4] VIP status load failure -> no client guess/popup; watch sent (server stays authority)', async () => {
    const page = await newPage()
    await call(page, (h: H) => h.navigateToPrivateRooms())
    await call(page, (h: H, games: unknown) => h.pushGamesList(games as any[], [], true), [makePlayingGame('room-e4')])
    await call(page, (h: H) => h.clickLifecycleTab('playing'))
    await call(page, (h: H) => h.setVipGateStatusResponse({ ok: false }))
    await call(page, (h: any) => h.setVipGateStatusDelayMs(100))
    await installPopupInsertionCounter(page)
    await call(page, (h: H) => h.clearCalls())
    await call(page, (h: H) => h.clickWatchBelotRoom('room-e4'))
    await page.waitForTimeout(300)
    assertEqual(await popupInsertions(page), 0, 'no popup on unknown status')
    const calls = await call(page, (h: H) => h.getCalls())
    assert(calls.some((c) => c.name === 'onWatchBelotRoom' && c.args[0] === 'room-e4'), 'watch must still be attempted')
    await page.close()
  })

  {
    const page = await newPage()
    await call(page, (h: H) => h.navigateToPrivateRooms())
    await call(page, (h: H, games: unknown) => h.pushGamesList(games as any[], [], true), [makePlayingGame('room-e5')])
    await call(page, (h: H) => h.clickLifecycleTab('waiting'))

    await check('[E5/R7] background re-watch vip_required while spectating -> clean state, Частни маси -> Играещи, no popup', async () => {
      await call(page, (h: H, roomId: string) => h.pushBelotSpectateStarted(roomId), 'room-e5')
      await call(page, (h: H) => h.clearCalls())
      await call(page, (h: H, roomId: string) => h.pushBelotSpectateDenied(roomId, 'vip_required', 'Гледането на тази маса изисква активен VIP.'), 'room-e5')
      await page.waitForTimeout(30)
      assertEqual(await call(page, (h: H) => h.getSpectatingBelotRoomId()), null, 'spectator state cleared')
      assertEqual(await call(page, (h: H) => h.isBelotSpectatorVipPopupOpen()), false, 'no automatic VIP popup')
      assertEqual(await call(page, (h: H) => h.getCurrentScreen()), 'private-rooms', 'back on Частни маси')
      assertEqual(await call(page, (h: any) => h.getActiveLifecycleTab()), 'playing', 'on the Играещи tab')
    })

    await check('[E6/C2] belot_spectate_ended renders the stable Играещи shell immediately, before any list response', async () => {
      await call(page, (h: H) => h.clickLifecycleTab('waiting'))
      await call(page, (h: H, roomId: string) => h.pushBelotSpectateStarted(roomId), 'room-e5')
      await call(page, (h: H) => h.clearCalls())
      await call(page, (h: H, roomId: string) => h.pushBelotSpectateEnded(roomId, 'room_removed'), 'room-e5')
      // NO pushGamesList here — the shell must already be on screen.
      assertEqual(await call(page, (h: any) => h.getActiveLifecycleTab()), 'playing', 'Играещи tab rendered synchronously')
      assert(await call(page, (h: H) => h.hasWatchButton('room-e5')), 'cached list visible immediately (no blank root)')
      const calls = await call(page, (h: H) => h.getCalls())
      assertEqual(calls.filter((c) => c.name === 'onPrivateGamesOpen').length, 1, 'fresh list requested once')
    })

    await check('[E7/D10] explicit unwatch navigates once; the server echo belot_spectate_ended is ignored', async () => {
      await call(page, (h: H, roomId: string) => h.pushBelotSpectateStarted(roomId), 'room-e5')
      await call(page, (h: H) => h.clearCalls())
      await call(page, (h: H) => h.unwatchBelotSpectatorRoom())
      await call(page, (h: H, roomId: string) => h.pushBelotSpectateEnded(roomId, 'unwatched'), 'room-e5')
      const calls = await call(page, (h: H) => h.getCalls())
      assertEqual(calls.filter((c) => c.name === 'onUnwatchBelotRoom').length, 1, 'single unwatch')
      assertEqual(calls.filter((c) => c.name === 'onPrivateGamesOpen').length, 1, 'games list requested exactly once')
      assertEqual(calls.filter((c) => c.name === 'onPrivateRoomsOpen').length, 1, 'rooms list requested exactly once')
    })

    await check('[E8/C6] re-entry: "Гледай" after exit watches again', async () => {
      await call(page, (h: H) => h.setVipGateStatusResponse({ ok: true, isActive: true, hasClaimedLaunchGift: true, launchGiftDays: 30 }))
      await call(page, (h: H) => h.clearCalls())
      await call(page, (h: H) => h.clickWatchBelotRoom('room-e5'))
      await page.waitForTimeout(80)
      const calls = await call(page, (h: H) => h.getCalls())
      assert(calls.some((c) => c.name === 'onWatchBelotRoom' && c.args[0] === 'room-e5'), 're-watch after exit')
    })

    await page.close()
  }

  // ── C7: source review ───────────────────────────────────────────────────
  await check('[C7] source review: Belot spectator code never calls resume_room/leave_active_room/join_room', async () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const source = await readFile(join(here, '..', 'src', 'app', 'lobby', 'createLobbyFlowController.ts'), 'utf8')
    // Коментари могат легитимно да СПОМЕНАТ тези идентификатори (документирайки
    // точно че не се ползват) — премахваме ги преди да търсим реална употреба
    // (действителен WS send/call), не просто текстово споменаване.
    function stripComments(code: string): string {
      return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    }
    const forbidden = /resume_room|leave_active_room|'join_room'/

    const startMarker = source.indexOf('// ─── Belot Spectator Mode ("Гледай") VIP UX (Phase 3A)')
    assert(startMarker !== -1, 'Belot spectator VIP UX block start marker must be found')
    const endMarker = source.indexOf('// ─── Create Topic popup (Custom Topic Creation)', startMarker)
    assert(endMarker !== -1 && endMarker > startMarker, 'Belot spectator VIP UX block end marker must be found after start')
    const vipBlock = stripComments(source.slice(startMarker, endMarker))
    assert(!forbidden.test(vipBlock), 'Belot spectator VIP UX block must never CALL resume_room/leave_active_room/join_room')

    const messageHandlersStart = source.indexOf('// ─── Belot Spectator Mode ("Гледай", Phase 3A) ──────────────────────')
    assert(messageHandlersStart !== -1, 'Belot spectator message-handler block start marker must be found')
    const messageHandlersEnd = source.indexOf("if (message.type === 'private_game_score_updated')", messageHandlersStart)
    assert(messageHandlersEnd !== -1 && messageHandlersEnd > messageHandlersStart, 'Belot spectator message-handler block end marker must be found after start')
    const handlersBlock = stripComments(source.slice(messageHandlersStart, messageHandlersEnd))
    assert(!forbidden.test(handlersBlock), 'Belot spectator message handlers must never CALL resume_room/leave_active_room/join_room')
  })
} finally {
  if (browser) await browser.close()
  if (vite) await vite.close()
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
process.exit(0)
