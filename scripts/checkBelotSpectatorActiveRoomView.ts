/**
 * checkBelotSpectatorActiveRoomView.ts
 *
 * Real browser (Playwright), real production code (createActiveRoomFlowController
 * + всички render* модули), synthetic belot_spectator_snapshot/room_snapshot
 * (mirror на established biddingBoardLifecycleHarness.ts подход — client-side
 * viewer-model/rendering safety е под тест, не server protocol-а, вече
 * покрит в Phase 2A/2C/3A server тестовете). Виж activeRoomSpectatorHarness.ts.
 *
 * A. Viewer model
 *   [A1] participant: isActiveRoomParticipant()=true, isSpectatorView()=false
 *   [A2] spectator: isSpectatorView()=true, isActiveRoomParticipant()=false
 *   [A3] spectator: getResumeInfo() остава null (НИКОГА synthesized reconnectToken)
 *
 * B. Hands (playing phase)
 *   [B1] spectator вижда 4 hand fans (bottom/right/top/left), всеки с верен брой карти
 *   [B2] bottom fan НЯМА face карти (ownHand не се ползва за spectator)
 *   [B3] няма bottom hand overlay (floating clickable ръка) за spectator
 *
 * C. Controls — нула interaction surface за spectator
 *   [C1] cutting: няма interactive cut area
 *   [C2] bidding: няма bid popup
 *   [C3] playing: няма sweep offer popup
 *   [C4] bot-controlled "own" seat -> НЯМА bot-takeover popup за spectator
 *   [C5] няма emoji бутон
 *   [C6] няма phrase бутон
 *   [C7] няма gift икона (никъде)
 *   [C8] profile click -> no-op (no popup, no request)
 *   [C9] action bar: само Settings + Изход (leave+settings бутони присъстват, нищо друго)
 *
 * D. Settings
 *   [D1] Settings бутон отваря existing panel
 *   [D2] panel-ът съдържа existing sound toggle
 *
 * E. Exit
 *   [E1] spectator "Изход" click -> onSpectatorExitRequested, НИКОГА leaveActiveRoom
 *   [E2] spectator "Изход" -> няма leave penalty warning
 *
 * F. Lifecycle
 *   [F1] exitSpectatorView() -> hasActiveRoom()=false
 *   [F2] re-enter (нов watch) след exit възстановява view-а коректно
 *
 * G. Game phases (spectator safety per phase)
 *   [G1] cutting: no decision UI
 *   [G2] bidding: no decision UI
 *   [G3] scoring: рендерира без crash
 *   [G4] match-ended: няма partner rating/replay/leave-vote/prize controls
 *
 * H. Regression (participant непроменен)
 *   [H1] participant own hand остава face (bottom hand overlay)
 *   [H2] participant bidding popup работи (canSubmitBid+validActions)
 *   [H3] participant cutting interactive area работи (canSubmitCut)
 *   [H4] participant bot-takeover popup ПРОДЪЛЖАВА да се показва за своя bot-controlled seat
 *   [H5] participant leave click никога не вика onSpectatorExitRequested
 *
 * I. Source review (defense-in-depth отвъд DOM snapshot теста)
 *
 * Phase 3B.2 (viewer/hands D4/D5, sweep D3, cleanup D9):
 *   [3B2-H1] participant: perspectiveSeat == controlledSeat (seated right)
 *   [3B2-H2] spectator: perspectiveSeat bottom, controlledSeat null
 *   [3B2-H3] spectator: няма „ТИ“ върху долния (или който и да е) играч
 *   [3B2-H4] participant own seat: „ТИ“ остава
 *   [3B2-H5] spectator: четирите скрити ръце са гърбове
 *   [3B2-H6] spectator bottom: panel/remote-hand path, не floating own-hand
 *   [3B2-H7] mobile spectator bottom: без own-hand sizing, не е под action bar-а
 *   [3B2-H8] mobile participant bottom: own-hand sizing непроменен
 *   [3B2-S1..S6] spectator sweep, winner bottom: без offer/reveal преди OK;
 *        bottom panel fan е source, затваря се, без дублирани гърбове, без остатък
 *   [3B2-S7] същото с winner non-bottom
 *   [3B2-S8] participant sweep: floating own-hand host остава source
 *   [3B2-C3/C4/C5] Exit по време на летяща карта: без transient карта, без
 *        leave_active_room, без penalty confirmation
 *   [3B2-C3b] Exit по време на sweep: без caption/overlay/късен re-render
 *   [3B2-C6] re-entry след Exit
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

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)) }

// createActiveRoomFlowController.ts reconciles a cold entry directly into a
// mid-game snapshot (full hand counts, authoritativePhase 'playing'/later)
// through its EXISTING "catch-up" deal-first-3/next-2/last-3 visual sequence
// (same mechanism a real reconnect mid-game goes through) — this is
// pre-existing, intentional behavior, identical for participant and
// spectator, NOT something Phase 3B changes. Tests that assert on the final
// settled phase (full 8-card hands, bidding/cutting controls) must poll
// until that multi-second sequence resolves, instead of a fixed short wait.
async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await sleep(150)
  }
  throw new Error('waitUntil: timed out')
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
  enterAsSpectator: (roomId: string, game: unknown, seats?: unknown) => Promise<void>
  applySpectatorSnapshot: (roomId: string, game: unknown, seats?: unknown) => Promise<boolean>
  exitSpectator: () => Promise<void>
  enterAsParticipant: (roomId: string, seat?: string) => Promise<void>
  applyParticipantSnapshot: (roomId: string, game: unknown, seats?: unknown) => Promise<void>
  render: () => Promise<void>
  reset: () => void
  cuttingGame: (overrides?: unknown) => unknown
  biddingGame: (overrides?: unknown) => unknown
  playingGame: (overrides?: unknown) => unknown
  scoringGame: (overrides?: unknown) => unknown
  matchEndedGame: (overrides?: unknown) => unknown
  makeSeats: (occupantsControlledByBot?: Record<string, boolean>) => unknown
  hasActiveRoomFn: () => boolean
  isActiveRoomParticipantFn: () => boolean
  isSpectatorViewFn: () => boolean
  getCurrentRoomIdFn: () => string | null
  countVisibleCardsInFan: (seat: string) => number
  fanHasAnyFaceCard: (seat: string) => boolean
  hasBottomHandOverlay: () => boolean
  bottomHandOverlayCardCount: () => number
  hasCuttingInteractiveArea: () => boolean
  hasBiddingPopup: () => boolean
  hasSweepOfferPopup: () => boolean
  hasBotTakeoverPopup: () => boolean
  hasEmojiToggle: () => boolean
  hasPhraseToggle: () => boolean
  hasGiftIcon: (seat: string) => boolean
  hasAnyGiftIcon: () => boolean
  hasLeaveButton: () => boolean
  hasSettingsButton: () => boolean
  clickLeaveButton: () => boolean
  clickSettingsButton: () => boolean
  hasSettingsPanelOpen: () => boolean
  hasSoundToggle: () => boolean
  clickSeatProfile: (seat: string) => boolean
  hasProfilePopupOpen: () => boolean
  hasMatchEndedActionButtons: () => boolean
  hasPrizeCounter: () => boolean
  seatPanelHasTiLabel: (seat: string) => boolean
  seatPanelText: (seat: string) => string
  lowestSeatPanel: () => string | null
  fanMetrics: (seat: string) => { count: number; visible: number; faces: number; cardW: number; cardH: number; bottomEdge: number } | null
  mobileActionBarTop: () => number | null
  countSweepRevealCards: () => number
  hasSweepThrowDownOverlay: () => boolean
  hasSweepCaption: () => boolean
  hasPlayedCardFlyOverlay: () => boolean
  bottomHandHostVisibilities: () => string[]
  makeSweepHands: (count: number) => Record<string, Array<{ id: string; suit: string; rank: string }>>
  makeSweepResolution: (winnerSeat: string, count: number) => unknown
  getCalls: () => Array<{ name: string; args: unknown[] }>
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

console.log('\ncheckBelotSpectatorActiveRoomView\n')

let vite: ViteDevServer | null = null
let browser: Browser | null = null

try {
  const port = await findFreePort()
  vite = await createViteServer({ root: process.cwd(), server: { port, strictPort: true, host: '127.0.0.1' }, logLevel: 'error' })
  await vite.listen()
  const baseUrl = `http://127.0.0.1:${port}/scripts/fixtures/activeRoomSpectatorHarness.html`

  browser = await chromium.launch()

  async function newPage(): Promise<Page> {
    const context = await browser!.newContext({ viewport: { width: 1280, height: 900 } })
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
    assert(errors.length === 0, `${label}: unexpected page errors: ${errors.join(' | ')}`)
  }

  // ── A. Viewer model ──────────────────────────────────────────────────────
  {
    const page = await newPage()

    await check('[A1] participant: isActiveRoomParticipant=true, isSpectatorView=false', async () => {
      await call(page, (h: H) => h.enterAsParticipant('room-a1', 'bottom'))
      const isParticipant = await call(page, (h: H) => h.isActiveRoomParticipantFn())
      const isSpectator = await call(page, (h: H) => h.isSpectatorViewFn())
      assertEqual(isParticipant, true, 'participant flag')
      assertEqual(isSpectator, false, 'spectator flag')
    })

    await check('[A2] spectator: isSpectatorView=true, isActiveRoomParticipant=false', async () => {
      await call(page, (h: H, g: unknown) => h.enterAsSpectator('room-a2', g), await call(page, (h: H) => h.playingGame()))
      const isParticipant = await call(page, (h: H) => h.isActiveRoomParticipantFn())
      const isSpectator = await call(page, (h: H) => h.isSpectatorViewFn())
      assertEqual(isSpectator, true, 'spectator flag')
      assertEqual(isParticipant, false, 'participant flag')
    })

    await check('[A3] spectator snapshot never produces a synthesized controlled seat (no decision UI even with bot-controlled "bottom")', async () => {
      const seats = await call(page, (h: H) => h.makeSeats({ bottom: true }))
      await call(page, (h: H, args: [unknown, unknown]) => h.enterAsSpectator('room-a3', args[0], args[1]), [await call(page, (h: H) => h.playingGame()), seats])
      const hasTakeover = await call(page, (h: H) => h.hasBotTakeoverPopup())
      assertEqual(hasTakeover, false, 'bot-controlled "bottom" must never trigger spectator bot-takeover UI')
    })

    assertNoPageErrors(page, 'viewer model block')
    await page.close()
  }

  // ── B. Hands ─────────────────────────────────────────────────────────────
  {
    const page = await newPage()
    await call(page, (h: H, g: unknown) => h.enterAsSpectator('room-b', g), await call(page, (h: H) => h.playingGame()))
    // Cold entry directly into a full-hand 'playing' snapshot triggers the
    // EXISTING deal catch-up visual sequence (see waitUntil doc comment
    // above) — wait for it to settle to the real 8-card panels.
    await waitUntil(() => call(page, (h: H) => h.countVisibleCardsInFan('bottom') === 8))

    await check('[B1] spectator sees 4 hand fans with correct card counts', async () => {
      for (const seat of ['bottom', 'right', 'top', 'left']) {
        const count = await call(page, (h: H, s: string) => h.countVisibleCardsInFan(s), seat)
        assertEqual(count, 8, `${seat} fan card count`)
      }
    })

    await check('[B2] bottom fan has no face cards (ownHand never used as spectator hand)', async () => {
      const hasFace = await call(page, (h: H) => h.fanHasAnyFaceCard('bottom'))
      assertEqual(hasFace, false, 'bottom fan must be card-backs only')
    })

    await check('[B3] no floating bottom-hand overlay for spectator', async () => {
      const hasOverlay = await call(page, (h: H) => h.hasBottomHandOverlay())
      assertEqual(hasOverlay, false, 'bottom hand overlay must not exist for spectator')
    })

    assertNoPageErrors(page, 'hands block')
    await page.close()
  }

  // ── C. Controls ──────────────────────────────────────────────────────────
  {
    const page = await newPage()

    await check('[C1] cutting: no interactive cut area for spectator', async () => {
      await call(page, (h: H, g: unknown) => h.enterAsSpectator('room-c', g), await call(page, (h: H) => h.cuttingGame()))
      const has = await call(page, (h: H) => h.hasCuttingInteractiveArea())
      assertEqual(has, false, 'no cut interactive area')
    })

    await check('[C2] bidding: no bid popup for spectator', async () => {
      await call(page, (h: H, g: unknown) => h.applySpectatorSnapshot('room-c', g), await call(page, (h: H) => h.biddingGame()))
      const has = await call(page, (h: H) => h.hasBiddingPopup())
      assertEqual(has, false, 'no bid popup')
    })

    await check('[C3] playing: no sweep offer popup for spectator (sweepOffer is always null pre-acceptance)', async () => {
      await call(page, (h: H, g: unknown) => h.applySpectatorSnapshot('room-c', g), await call(page, (h: H) => h.playingGame()))
      const has = await call(page, (h: H) => h.hasSweepOfferPopup())
      assertEqual(has, false, 'no sweep offer popup')
    })

    await check('[C4] bot-controlled "bottom" seat -> no bot-takeover popup for spectator', async () => {
      const seats = await call(page, (h: H) => h.makeSeats({ bottom: true }))
      await call(page, (h: H, args: [unknown, unknown]) => h.applySpectatorSnapshot('room-c', args[0], args[1]), [await call(page, (h: H) => h.playingGame()), seats])
      const has = await call(page, (h: H) => h.hasBotTakeoverPopup())
      assertEqual(has, false, 'no bot takeover popup')
    })

    await check('[C5] no emoji button', async () => {
      const has = await call(page, (h: H) => h.hasEmojiToggle())
      assertEqual(has, false, 'no emoji toggle')
    })

    await check('[C6] no phrase button', async () => {
      const has = await call(page, (h: H) => h.hasPhraseToggle())
      assertEqual(has, false, 'no phrase toggle')
    })

    await check('[C7] no gift icon anywhere', async () => {
      const has = await call(page, (h: H) => h.hasAnyGiftIcon())
      assertEqual(has, false, 'no gift icon')
    })

    await check('[C8] profile click is a no-op (no popup, no request)', async () => {
      await call(page, (h: H) => h.clickSeatProfile('right'))
      const popupOpen = await call(page, (h: H) => h.hasProfilePopupOpen())
      const calls = await call(page, (h: H) => h.getCalls())
      assertEqual(popupOpen, false, 'no profile popup')
      assert(!calls.some((c) => c.name === 'requestPlayerProfile'), 'no requestPlayerProfile call')
    })

    await check('[C9] action bar has ONLY Settings + Exit buttons', async () => {
      const hasLeave = await call(page, (h: H) => h.hasLeaveButton())
      const hasSettings = await call(page, (h: H) => h.hasSettingsButton())
      assert(hasLeave && hasSettings, 'leave+settings must be present')
      const hasEmoji = await call(page, (h: H) => h.hasEmojiToggle())
      const hasPhrase = await call(page, (h: H) => h.hasPhraseToggle())
      const hasGift = await call(page, (h: H) => h.hasAnyGiftIcon())
      assert(!hasEmoji && !hasPhrase && !hasGift, 'no other action buttons must exist')
    })

    assertNoPageErrors(page, 'controls block')
    await page.close()
  }

  // ── D. Settings ──────────────────────────────────────────────────────────
  {
    const page = await newPage()
    await call(page, (h: H, g: unknown) => h.enterAsSpectator('room-d', g), await call(page, (h: H) => h.playingGame()))

    await check('[D1] Settings button opens the existing panel', async () => {
      const clicked = await call(page, (h: H) => h.clickSettingsButton())
      assert(clicked, 'settings button must be clickable')
      const open = await call(page, (h: H) => h.hasSettingsPanelOpen())
      assertEqual(open, true, 'settings panel must open')
    })

    await check('[D2] panel contains the existing sound toggle', async () => {
      const has = await call(page, (h: H) => h.hasSoundToggle())
      assertEqual(has, true, 'sound toggle must be present')
    })

    assertNoPageErrors(page, 'settings block')
    await page.close()
  }

  // ── E. Exit ──────────────────────────────────────────────────────────────
  {
    const page = await newPage()
    await call(page, (h: H, g: unknown) => h.enterAsSpectator('room-e', g), await call(page, (h: H) => h.playingGame()))

    await check('[E1] spectator Exit click -> onSpectatorExitRequested, never leaveActiveRoom', async () => {
      const clicked = await call(page, (h: H) => h.clickLeaveButton())
      assert(clicked, 'leave button must be clickable')
      const calls = await call(page, (h: H) => h.getCalls())
      assert(calls.some((c) => c.name === 'onSpectatorExitRequested'), 'onSpectatorExitRequested must fire')
      assert(!calls.some((c) => c.name === 'leaveActiveRoom'), 'leaveActiveRoom must never fire for spectator')
    })

    await check('[E2] no leave penalty warning for spectator', async () => {
      const warningVisible = await page.locator('[data-active-room-leave-warning="1"]').count()
      assertEqual(warningVisible, 0, 'no penalty warning popup')
    })

    assertNoPageErrors(page, 'exit block')
    await page.close()
  }

  // ── F. Lifecycle ─────────────────────────────────────────────────────────
  {
    const page = await newPage()
    await call(page, (h: H, g: unknown) => h.enterAsSpectator('room-f', g), await call(page, (h: H) => h.playingGame()))

    await check('[F1] exitSpectatorView() clears hasActiveRoom', async () => {
      await call(page, (h: H) => h.exitSpectator())
      const has = await call(page, (h: H) => h.hasActiveRoomFn())
      assertEqual(has, false, 'hasActiveRoom must be false after exit')
    })

    await check('[F2] re-watch (new enterAsSpectator) restores the view', async () => {
      await call(page, (h: H, g: unknown) => h.enterAsSpectator('room-f2', g), await call(page, (h: H) => h.playingGame()))
      const has = await call(page, (h: H) => h.hasActiveRoomFn())
      const isSpectator = await call(page, (h: H) => h.isSpectatorViewFn())
      const roomId = await call(page, (h: H) => h.getCurrentRoomIdFn())
      assert(has && isSpectator, 'view must be restored as spectator')
      assertEqual(roomId, 'room-f2', 'current room id must match the new watch')
    })

    assertNoPageErrors(page, 'lifecycle block')
    await page.close()
  }

  // ── G. Game phases ───────────────────────────────────────────────────────
  {
    const page = await newPage()

    await check('[G1] cutting phase: no decision UI', async () => {
      await call(page, (h: H, g: unknown) => h.enterAsSpectator('room-g', g), await call(page, (h: H) => h.cuttingGame()))
      const has = await call(page, (h: H) => h.hasCuttingInteractiveArea())
      assertEqual(has, false, 'cutting phase must have no decision UI')
    })

    await check('[G2] bidding phase: no decision UI', async () => {
      await call(page, (h: H, g: unknown) => h.applySpectatorSnapshot('room-g', g), await call(page, (h: H) => h.biddingGame()))
      const has = await call(page, (h: H) => h.hasBiddingPopup())
      assertEqual(has, false, 'bidding phase must have no decision UI')
    })

    await check('[G3] scoring phase: renders without crashing', async () => {
      await call(page, (h: H, g: unknown) => h.applySpectatorSnapshot('room-g', g), await call(page, (h: H) => h.scoringGame()))
      assertNoPageErrors(page, 'scoring phase render')
    })

    await check('[G4] match-ended phase: no partner-rating/replay/leave-vote/prize controls', async () => {
      await call(page, (h: H, g: unknown) => h.applySpectatorSnapshot('room-g', g), await call(page, (h: H) => h.matchEndedGame()))
      const hasActionButtons = await call(page, (h: H) => h.hasMatchEndedActionButtons())
      const hasPrize = await call(page, (h: H) => h.hasPrizeCounter())
      assertEqual(hasActionButtons, false, 'no participant-only match-ended controls')
      assertEqual(hasPrize, false, 'no prize counter for spectator')
      // §13 брифа: spectator action bar остава Settings+Exit дори на match-ended.
      const hasLeave = await call(page, (h: H) => h.hasLeaveButton())
      assertEqual(hasLeave, true, 'floating Exit must remain visible on spectator match-ended')
    })

    assertNoPageErrors(page, 'game phases block')
    await page.close()
  }

  // ── H. Regression (participant) ─────────────────────────────────────────
  // Each sub-test gets a FRESH enterAsParticipant (distinct roomId) — a cold
  // entry straight into a full-hand mid-game snapshot, participant or
  // spectator alike, triggers the existing deal catch-up visual sequence
  // (see waitUntil doc comment above); reusing one entry across phase
  // switches would leave stale catch-up/animation cache state behind.
  await check('[H1] participant own hand stays face (bottom hand overlay)', async () => {
    const page = await newPage()
    await call(page, (h: H) => h.enterAsParticipant('room-h1', 'bottom'))
    await call(page, (h: H, g: unknown) => h.applyParticipantSnapshot('room-h1', g), await call(page, (h: H) => h.playingGame({ ownHand: [{ id: 'c7', suit: 'clubs', rank: '7' }] })))
    await waitUntil(() => call(page, (h: H) => h.hasBottomHandOverlay()))
    const hasOverlay = await call(page, (h: H) => h.hasBottomHandOverlay())
    assertEqual(hasOverlay, true, 'participant bottom hand overlay must exist')
    assertNoPageErrors(page, 'H1')
    await page.close()
  })

  await check('[H2] participant bidding popup works (canSubmitBid+validActions)', async () => {
    const page = await newPage()
    await call(page, (h: H) => h.enterAsParticipant('room-h2', 'bottom'))
    await call(page, (h: H, g: unknown) => h.applyParticipantSnapshot('room-h2', g), await call(page, (h: H) => h.biddingGame({
      bidding: { winningBid: null, currentBidderSeat: 'bottom', entries: [], canSubmitBid: true, validActions: { pass: true, noTrumps: true, allTrumps: true, double: false, redouble: false, suits: { clubs: true, diamonds: true, hearts: true, spades: true } } },
    })))
    await waitUntil(() => call(page, (h: H) => h.hasBiddingPopup()))
    const has = await call(page, (h: H) => h.hasBiddingPopup())
    assertEqual(has, true, 'participant bidding popup must render')
    assertNoPageErrors(page, 'H2')
    await page.close()
  })

  await check('[H3] participant cutting interactive area works (canSubmitCut)', async () => {
    const page = await newPage()
    await call(page, (h: H) => h.enterAsParticipant('room-h3', 'bottom'))
    await call(page, (h: H, g: unknown) => h.applyParticipantSnapshot('room-h3', g), await call(page, (h: H) => h.cuttingGame({
      cutting: { cutterSeat: 'bottom', selectedCutIndex: null, deckCount: 32, canSubmitCut: true },
    })))
    const has = await call(page, (h: H) => h.hasCuttingInteractiveArea())
    assertEqual(has, true, 'participant cutting interactive area must render')
    assertNoPageErrors(page, 'H3')
    await page.close()
  })

  await check('[H4] participant bot-takeover popup still shows for own bot-controlled seat', async () => {
    const page = await newPage()
    await call(page, (h: H) => h.enterAsParticipant('room-h4', 'bottom'))
    const seats = await call(page, (h: H) => h.makeSeats({ bottom: true }))
    await call(page, (h: H, args: [unknown, unknown]) => h.applyParticipantSnapshot('room-h4', args[0], args[1]), [await call(page, (h: H) => h.playingGame()), seats])
    await waitUntil(() => call(page, (h: H) => h.hasBotTakeoverPopup()))
    const has = await call(page, (h: H) => h.hasBotTakeoverPopup())
    assertEqual(has, true, 'participant bot-takeover popup regression')
    assertNoPageErrors(page, 'H4')
    await page.close()
  })

  await check('[H5] participant leave click never calls onSpectatorExitRequested', async () => {
    const page = await newPage()
    await call(page, (h: H) => h.enterAsParticipant('room-h5', 'bottom'))
    await call(page, (h: H) => h.clickLeaveButton())
    const calls = await call(page, (h: H) => h.getCalls())
    assert(!calls.some((c) => c.name === 'onSpectatorExitRequested'), 'participant leave must never use the spectator exit path')
    assertNoPageErrors(page, 'H5')
    await page.close()
  })

  // ── I. Source review ─────────────────────────────────────────────────────
  await check('[I1] source review: getLocalSeatSnapshot/getResumeInfo/syncBiddingUiState use controlledSeat, not perspective seat', async () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const source = (await readFile(join(here, '..', 'src', 'app', 'activeRoom', 'createActiveRoomFlowController.ts'), 'utf8')).replace(/\r\n/g, '\n')
    assert(/activeRoomState!\.controlledSeat\) \?\? null/.test(source) || /seat\.seat === activeRoomState!\.controlledSeat/.test(source), 'getLocalSeatSnapshot must key off controlledSeat')
    assert(/reconnectToken: string \} \| null \{\s*\n\s*if \(!activeRoomState \|\| !activeRoomState\.reconnectToken\)/.test(source), 'getResumeInfo must stay gated purely by reconnectToken (null for spectator)')
    assert(source.includes("syncBiddingUiState(activeRoomState.game?.bidding ?? null, activeRoomState.controlledSeat)"), 'syncBiddingUiState call site must pass controlledSeat')
  })

  await check('[I2] source review: renderPlayingScreen isMyTurn/bottom-hand gating keyed off controlledSeat', async () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const source = (await readFile(join(here, '..', 'src', 'app', 'activeRoom', 'renderPlayingScreen.ts'), 'utf8')).replace(/\r\n/g, '\n')
    assert(source.includes('const isMyTurn = controlledSeat !== null && playing?.currentTurnSeat === controlledSeat'), 'isMyTurn must require a non-null controlledSeat')
    assert(source.includes('controlledSeat === null\n    ? displayedHandCounts'), 'panelHandCounts must not zero the bottom seat for spectator')
    assert(/controlledSeat === null\s*\n\s*\? \(removeBottomHandOverlay\(\), null\)/.test(source), 'bottom hand overlay must be skipped for spectator')
  })

  // ═══ Phase 3B.2 — VIEWER / HANDS (D4/D5) ═════════════════════════════════
  // Viewer модел без public getter: perspectiveSeat = seat-ът, чийто panel е
  // визуално най-долу; controlledSeat = seat-ът с „ТИ“ / own-hand path.
  await check('[3B2-H1] participant: perspectiveSeat == controlledSeat (seated right -> right panel is bottom + "ТИ")', async () => {
    const page = await newPage()
    await call(page, (h: H) => h.enterAsParticipant('room-3b2-h1', 'right'))
    await call(page, (h: H, g: unknown) => (h as any).applyParticipantSnapshot('room-3b2-h1', g, (h as any).makeSeats(), 'right'), await call(page, (h: H) => h.biddingGame()))
    await waitUntil(() => call(page, (h: H) => h.lowestSeatPanel() === 'right'))
    assertEqual(await call(page, (h: H) => h.seatPanelHasTiLabel('right')), true, 'controlled seat "ТИ"')
    for (const seat of ['bottom', 'top', 'left']) {
      assertEqual(await call(page, (h: H, s: string) => h.seatPanelHasTiLabel(s), seat), false, `${seat} has no "ТИ"`)
    }
    assertNoPageErrors(page, '3B2-H1')
    await page.close()
  })

  {
    const page = await newPage()
    await call(page, (h: H, g: unknown) => h.enterAsSpectator('room-3b2-h', g), await call(page, (h: H) => h.playingGame()))
    await waitUntil(() => call(page, (h: H) => h.countVisibleCardsInFan('bottom') === 8))

    await check('[3B2-H2] spectator: perspectiveSeat bottom, controlledSeat null', async () => {
      assertEqual(await call(page, (h: H) => h.lowestSeatPanel()), 'bottom', 'perspective seat')
      assertEqual(await call(page, (h: H) => h.isSpectatorViewFn()), true, 'spectator view')
      assertEqual(await call(page, (h: H) => h.hasBottomHandOverlay()), false, 'no controlled own-hand surface')
    })

    await check('[3B2-H3] spectator: bottom player label has no "ТИ" (nor any seat)', async () => {
      for (const seat of ['bottom', 'right', 'top', 'left']) {
        assertEqual(await call(page, (h: H, s: string) => h.seatPanelHasTiLabel(s), seat), false, `${seat} "ТИ"`)
      }
      const bottomText = await call(page, (h: H) => h.seatPanelText('bottom'))
      assert(bottomText.length > 0, 'bottom panel still renders the real player identity')
    })

    await check('[3B2-H5] spectator: all four hidden hands are card backs', async () => {
      for (const seat of ['bottom', 'right', 'top', 'left']) {
        const m = await call(page, (h: H, s: string) => h.fanMetrics(s), seat)
        assert(m !== null, `${seat} fan exists`)
        assertEqual(m!.count, 8, `${seat} count`)
        assertEqual(m!.faces, 0, `${seat} face cards`)
      }
    })

    await check('[3B2-H6] spectator bottom: panel/remote-hand path, not floating own-hand path', async () => {
      const bottom = await call(page, (h: H) => h.fanMetrics('bottom'))
      const top = await call(page, (h: H) => h.fanMetrics('top'))
      assertEqual(await call(page, (h: H) => h.hasBottomHandOverlay()), false, 'no floating own-hand host')
      assertEqual(bottom!.cardW, top!.cardW, 'bottom panel fan uses the same card size as the remote top fan')
    })

    assertNoPageErrors(page, '3B2 viewer/hands')
    await page.close()
  }

  await check('[3B2-H4] participant own seat: "ТИ" stays as before', async () => {
    const page = await newPage()
    await call(page, (h: H) => h.enterAsParticipant('room-3b2-h4', 'bottom'))
    await call(page, (h: H, g: unknown) => h.applyParticipantSnapshot('room-3b2-h4', g), await call(page, (h: H) => h.biddingGame()))
    await waitUntil(() => call(page, (h: H) => h.seatPanelHasTiLabel('bottom')))
    for (const seat of ['right', 'top', 'left']) {
      assertEqual(await call(page, (h: H, s: string) => h.seatPanelHasTiLabel(s), seat), false, `${seat} has no "ТИ"`)
    }
    assertNoPageErrors(page, '3B2-H4')
    await page.close()
  })

  async function newMobilePage(): Promise<Page> {
    const context = await browser!.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
    const page = await context.newPage()
    const pageErrors: string[] = []
    page.on('pageerror', (e) => pageErrors.push(e.message))
    await page.goto(baseUrl)
    await page.waitForFunction(() => (window as any).__activeRoomSpectatorHarness !== undefined, undefined, { timeout: 10_000 })
    ;(page as any).__pageErrors = pageErrors
    return page
  }

  const ownBiddingHand = [
    { id: 'clubs-A', suit: 'clubs', rank: 'A' },
    { id: 'clubs-K', suit: 'clubs', rank: 'K' },
    { id: 'hearts-Q', suit: 'hearts', rank: 'Q' },
    { id: 'spades-J', suit: 'spades', rank: 'J' },
    { id: 'diamonds-10', suit: 'diamonds', rank: '10' },
  ]

  await check('[3B2-H7] mobile spectator bottom: no own-hand sizing (same size as top), not under the action bar', async () => {
    const page = await newMobilePage()
    await call(page, (h: H, g: unknown) => h.enterAsSpectator('room-3b2-h7', g), await call(page, (h: H) => h.biddingGame()))
    await waitUntil(() => call(page, (h: H) => (h.fanMetrics('bottom')?.count ?? 0) === 5 && (h.fanMetrics('top')?.count ?? 0) === 5))
    const bottom = (await call(page, (h: H) => h.fanMetrics('bottom')))!
    const top = (await call(page, (h: H) => h.fanMetrics('top')))!
    assertEqual(bottom.faces, 0, 'mobile spectator bottom backs only')
    assertEqual(bottom.cardW, top.cardW, 'mobile spectator bottom card size == remote top card size')
    const barTop = await call(page, (h: H) => h.mobileActionBarTop())
    const limit = barTop ?? 844
    assert(bottom.bottomEdge <= limit + 1, `bottom fan (edge ${bottom.bottomEdge}) must not sit under the action bar/viewport (${limit})`)
    assertNoPageErrors(page, '3B2-H7')
    await page.close()
  })

  await check('[3B2-H8] mobile participant bottom: own-hand sizing unchanged (larger than remote top)', async () => {
    const page = await newMobilePage()
    await call(page, (h: H) => h.enterAsParticipant('room-3b2-h8', 'bottom'))
    await call(page, (h: H, g: unknown) => h.applyParticipantSnapshot('room-3b2-h8', g), await call(page, (h: H, own: unknown) => h.biddingGame({ ownHand: own } as any), ownBiddingHand))
    await waitUntil(() => call(page, (h: H) => (h.fanMetrics('bottom')?.faces ?? 0) === 5 && (h.fanMetrics('top')?.count ?? 0) === 5))
    const bottom = (await call(page, (h: H) => h.fanMetrics('bottom')))!
    const top = (await call(page, (h: H) => h.fanMetrics('top')))!
    assert(bottom.cardW > top.cardW, `participant own hand (${bottom.cardW}) must keep own-hand sizing > remote (${top.cardW})`)
    assertNoPageErrors(page, '3B2-H8')
    await page.close()
  })

  // ═══ Phase 3B.2 — SWEEP (D3) ═════════════════════════════════════════════
  // Timeline (animateSweepThrowDown): caption 1.5s → claimant close+fly →
  // 1s beat → others close+fly (~3.0s) → hold 1.5s → collect → done ≈5.8s.
  const SWEEP_REVEAL_PROBE_MS = 3_600
  const SWEEP_DONE_PROBE_MS = 6_800
  // Cold entry директно в mid-hand snapshot пуска existing deal catch-up
  // (3 → 5 → 8 карти, ~4.5s). Sweep/flight тестовете влизат с пълна ръка,
  // изчакват catch-up-а да се успокои и чак тогава подават mid-hand snapshot.
  async function enterSettledSpectator(page: Page, roomId: string): Promise<void> {
    await call(page, (h: H, args: [string, unknown]) => h.enterAsSpectator(args[0], args[1]), [roomId, await call(page, (h: H) => h.playingGame())])
    await waitUntil(() => call(page, (h: H) => ['bottom', 'right', 'top', 'left'].every((s) => h.fanMetrics(s)?.visible === 8)))
  }

  async function runSpectatorSweep(winnerSeat: string, roomId: string): Promise<void> {
    const page = await newPage()
    const pre = await call(page, (h: H) => h.playingGame({
      handCounts: { bottom: 3, right: 3, top: 3, left: 3 },
      playing: {
        winningBid: { seat: 'bottom', contract: 'all-trumps', trumpSuit: null, doubled: false, redoubled: false },
        currentTurnSeat: 'bottom', currentTrickPlays: [], completedTricksCount: 5, latestCompletedTrick: null,
        validCardIds: null, sweepOffer: null, sweepResolution: null,
      },
    } as any))
    await enterSettledSpectator(page, roomId)
    await call(page, (h: H, args: [string, unknown]) => h.applySpectatorSnapshot(args[0], args[1]), [roomId, pre])
    await waitUntil(() => call(page, (h: H) => ['bottom', 'right', 'top', 'left'].every((s) => h.fanMetrics(s)?.count === 3 && h.fanMetrics(s)?.visible === 3)))

    // S1 — преди OK: spectator никога не вижда offer popup / reveal, дори ако
    // snapshot-ът (хипотетично) носи sweepOffer за seat-а на долния играч.
    const withOffer = await call(page, (h: H, g: any) => ({ ...g, playing: { ...g.playing, sweepOffer: { seat: 'bottom', expiresAt: Date.now() + 10_000 } } }), pre)
    await call(page, (h: H, args: [string, unknown]) => h.applySpectatorSnapshot(args[0], args[1]), [roomId, withOffer])
    assertEqual(await call(page, (h: H) => h.hasSweepOfferPopup()), false, 'S1 no sweep offer popup')
    assertEqual(await call(page, (h: H) => h.countSweepRevealCards()), 0, 'S1 no reveal')

    const resolved = await call(page, (h: H, args: [any, string]) => ({
      ...args[0],
      handCounts: { bottom: 0, right: 0, top: 0, left: 0 },
      playing: { ...args[0].playing, sweepOffer: null, sweepResolution: h.makeSweepResolution(args[1], 3) },
    }), [pre, winnerSeat])
    await call(page, (h: H, args: [string, unknown]) => h.applySpectatorSnapshot(args[0], args[1]), [roomId, resolved])
    // По време на caption-а долното ветрило е още там (handsAtResolution counts).
    const atStart = await call(page, (h: H) => h.fanMetrics('bottom'))
    assert(atStart !== null && atStart.count === 3 && atStart.visible === 3, `bottom fan visible at sweep start: ${JSON.stringify(atStart)}`)

    await sleep(SWEEP_REVEAL_PROBE_MS)
    // S2/S3 — bottom panel fan е намерен като source и е затворен (скрит).
    const bottomDuring = await call(page, (h: H) => h.fanMetrics('bottom'))
    assert(bottomDuring !== null && bottomDuring.count === 3, `bottom panel fan still mounted as source: ${JSON.stringify(bottomDuring)}`)
    assertEqual(bottomDuring!.visible, 0, 'S3 bottom fan closed during reveal')
    // S4 — без дублирани гърбове: 12 reveal карти и нула видими panel карти.
    let visiblePanelCards = 0
    for (const seat of ['bottom', 'right', 'top', 'left']) {
      visiblePanelCards += (await call(page, (h: H, s: string) => h.fanMetrics(s), seat))?.visible ?? 0
    }
    assertEqual(visiblePanelCards, 0, 'S4 no visible panel cards alongside the reveal')
    assertEqual(await call(page, (h: H) => h.countSweepRevealCards()), 12, 'S4 exactly 4x3 revealed cards')

    await sleep(SWEEP_DONE_PROBE_MS - SWEEP_REVEAL_PROBE_MS)
    // S5 — след collect: няма остатъчни карти.
    assertEqual(await call(page, (h: H) => h.hasSweepThrowDownOverlay()), false, 'S5 overlay removed')
    assertEqual(await call(page, (h: H) => h.countSweepRevealCards()), 0, 'S5 no reveal cards')
    const bottomAfter = await call(page, (h: H) => h.fanMetrics('bottom'))
    assertEqual(bottomAfter?.visible ?? 0, 0, 'S5 no residual bottom cards')
    assertNoPageErrors(page, `sweep winner ${winnerSeat}`)
    await page.close()
  }

  await check('[3B2-S1..S6] spectator accepted sweep, winner bottom: bottom fan is the source, closes, no duplicates, no residue', async () => {
    await runSpectatorSweep('bottom', 'room-3b2-s6')
  })

  await check('[3B2-S7] spectator accepted sweep, winner non-bottom (right): same guarantees', async () => {
    await runSpectatorSweep('right', 'room-3b2-s7')
  })

  await check('[3B2-S8] participant sweep: floating own-hand host stays the source (existing behavior)', async () => {
    const page = await newPage()
    const hands = await call(page, (h: H) => h.makeSweepHands(3))
    const pre = await call(page, (h: H, own: unknown) => h.playingGame({
      handCounts: { bottom: 3, right: 3, top: 3, left: 3 },
      ownHand: own,
      playing: {
        winningBid: { seat: 'bottom', contract: 'all-trumps', trumpSuit: null, doubled: false, redoubled: false },
        currentTurnSeat: 'right', currentTrickPlays: [], completedTricksCount: 5, latestCompletedTrick: null,
        validCardIds: null, sweepOffer: null, sweepResolution: null,
      },
    } as any), hands.bottom)
    await call(page, (h: H) => h.enterAsParticipant('room-3b2-s8', 'bottom'))
    await call(page, (h: H, g: unknown) => h.applyParticipantSnapshot('room-3b2-s8', g), pre)
    await waitUntil(() => call(page, (h: H) => h.bottomHandOverlayCardCount() === 3))
    const resolved = await call(page, (h: H, g: any) => ({
      ...g,
      ownHand: [],
      handCounts: { bottom: 0, right: 0, top: 0, left: 0 },
      playing: { ...g.playing, sweepResolution: h.makeSweepResolution('bottom', 3) },
    }), pre)
    await call(page, (h: H, g: unknown) => h.applyParticipantSnapshot('room-3b2-s8', g), resolved)
    const atStart = await call(page, (h: H) => h.bottomHandHostVisibilities())
    assertEqual(atStart.length, 3, 'participant own hand still shown (handsAtResolution) at sweep start')
    assertEqual((await call(page, (h: H) => h.fanMetrics('bottom')))?.count ?? 0, 0, 'participant bottom panel fan stays empty (own hand is the host)')
    await sleep(SWEEP_REVEAL_PROBE_MS)
    const during = await call(page, (h: H) => h.bottomHandHostVisibilities())
    assert(during.length === 3 && during.every((v) => v === 'hidden'), `own-hand host cards are the hidden sources: ${JSON.stringify(during)}`)
    assertEqual(await call(page, (h: H) => h.countSweepRevealCards()), 12, '4x3 revealed cards')
    await sleep(SWEEP_DONE_PROBE_MS - SWEEP_REVEAL_PROBE_MS)
    assertEqual(await call(page, (h: H) => h.hasSweepThrowDownOverlay()), false, 'overlay removed')
    assertNoPageErrors(page, '3B2-S8')
    await page.close()
  })

  // ═══ Phase 3B.2 — CLEANUP (D9) ═══════════════════════════════════════════
  await check('[3B2-C3/C4/C5] Exit during a flying-card animation: no transient card, no leave, no penalty', async () => {
    const page = await newPage()
    await enterSettledSpectator(page, 'room-3b2-c3')
    // Deal catch-up completion timer-ът идва малко след като ветрилата са пълни.
    await sleep(1_500)
    const result = await page.evaluate(async () => {
      const h = (window as any).__activeRoomSpectatorHarness
      const next = h.playingGame({
        handCounts: { bottom: 8, right: 7, top: 8, left: 8 },
        playing: {
          winningBid: { seat: 'bottom', contract: 'all-trumps', trumpSuit: null, doubled: false, redoubled: false },
          currentTurnSeat: 'top', currentTrickPlays: [{ seat: 'right', card: { id: 'hearts-A', suit: 'hearts', rank: 'A' } }],
          completedTricksCount: 0, latestCompletedTrick: null, validCardIds: null, sweepOffer: null, sweepResolution: null,
        },
      })
      h.getCalls().length = 0
      await h.applySpectatorSnapshot('room-3b2-c3', next)
      const during = h.hasPlayedCardFlyOverlay()
      h.clickLeaveButton()
      await new Promise((r) => requestAnimationFrame(() => r(null)))
      const afterExit = h.hasPlayedCardFlyOverlay()
      return { during, afterExit }
    })
    assert(result.during, 'precondition: a played-card flight overlay must be in progress')
    // Production Exit path: onSpectatorExitRequested -> main.ts вика
    // exitSpectatorView(); harness-ът го записва, тук го изпълняваме ние.
    await call(page, (h: H) => h.exitSpectator())
    assertEqual(await call(page, (h: H) => h.hasPlayedCardFlyOverlay()), false, 'no flying card right after exit')
    await sleep(600)
    assertEqual(await call(page, (h: H) => h.hasPlayedCardFlyOverlay()), false, 'no flying card after the flight would have landed')
    const calls = await call(page, (h: H) => h.getCalls())
    assert(calls.some((c) => c.name === 'onSpectatorExitRequested'), 'Exit goes through onSpectatorExitRequested')
    assert(!calls.some((c) => c.name === 'leaveActiveRoom'), 'C4 no leave_active_room')
    assertEqual(await page.locator('[data-active-room-leave-warning="1"]').count(), 0, 'C5 no penalty confirmation')
    assertNoPageErrors(page, '3B2-C3')
    await page.close()
  })

  await check('[3B2-C3b] Exit during sweep presentation: no caption/overlay/belote indicator left behind', async () => {
    const page = await newPage()
    const pre = await call(page, (h: H) => h.playingGame({
      handCounts: { bottom: 3, right: 3, top: 3, left: 3 },
      playing: {
        winningBid: { seat: 'bottom', contract: 'all-trumps', trumpSuit: null, doubled: false, redoubled: false },
        currentTurnSeat: 'bottom', currentTrickPlays: [], completedTricksCount: 5, latestCompletedTrick: null,
        validCardIds: null, sweepOffer: null, sweepResolution: null,
      },
    } as any))
    await enterSettledSpectator(page, 'room-3b2-c3b')
    await call(page, (h: H, g: unknown) => h.applySpectatorSnapshot('room-3b2-c3b', g), pre)
    await waitUntil(() => call(page, (h: H) => h.fanMetrics('bottom')?.count === 3))
    const resolved = await call(page, (h: H, g: any) => ({
      ...g,
      handCounts: { bottom: 0, right: 0, top: 0, left: 0 },
      playing: { ...g.playing, sweepResolution: h.makeSweepResolution('top', 3) },
    }), pre)
    await call(page, (h: H, g: unknown) => h.applySpectatorSnapshot('room-3b2-c3b', g), resolved)
    await sleep(400)
    assertEqual(await call(page, (h: H) => h.hasSweepCaption()), true, 'precondition: sweep caption shown')
    await call(page, (h: H) => h.exitSpectator())
    assertEqual(await call(page, (h: H) => h.hasSweepCaption()), false, 'caption removed on exit')
    await sleep(SWEEP_DONE_PROBE_MS)
    assertEqual(await call(page, (h: H) => h.hasSweepCaption()), false, 'no late caption')
    assertEqual(await call(page, (h: H) => h.hasSweepThrowDownOverlay()), false, 'no sweep overlay after exit')
    assertEqual(await call(page, (h: H) => h.countSweepRevealCards()), 0, 'no reveal cards after exit')
    assertEqual(await call(page, (h: H) => h.hasActiveRoomFn()), false, 'late sweep onComplete must not resurrect the view')
    assertNoPageErrors(page, '3B2-C3b')
    await page.close()
  })

  await check('[3B2-C6] re-entry after Exit works (fresh view, correct room, no stale overlays)', async () => {
    const page = await newPage()
    await call(page, (h: H, g: unknown) => h.enterAsSpectator('room-3b2-c6a', g), await call(page, (h: H) => h.playingGame()))
    await call(page, (h: H) => h.clickLeaveButton())
    await call(page, (h: H) => h.exitSpectator())
    await call(page, (h: H, g: unknown) => h.enterAsSpectator('room-3b2-c6b', g), await call(page, (h: H) => h.playingGame()))
    await waitUntil(() => call(page, (h: H) => h.fanMetrics('bottom')?.count === 8))
    assertEqual(await call(page, (h: H) => h.getCurrentRoomIdFn()), 'room-3b2-c6b', 'room id')
    assertEqual(await call(page, (h: H) => h.isSpectatorViewFn()), true, 'spectator view')
    assertEqual(await call(page, (h: H) => h.seatPanelHasTiLabel('bottom')), false, 'still no "ТИ" after re-entry')
    assertEqual(await call(page, (h: H) => h.hasPlayedCardFlyOverlay()), false, 'no stale flight overlay')
    assertNoPageErrors(page, '3B2-C6')
    await page.close()
  })
} finally {
  if (browser) await browser.close()
  if (vite) await vite.close()
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
process.exit(0)
