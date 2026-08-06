// Браузърна тестова "сглобка" за checkPlayedCardStacking.ts — рендира
// реалния production код (renderPlayingScreen + createCuttingSeatPanelsHtml)
// в истински браузър (Playwright), без jsdom, без mock на DOM/CSS stacking
// поведение. Replicira самата "seat-panels-host" DOM-insertion логика от
// createActiveRoomFlowController.ts (host е вътрешна closure функция там,
// не е exported) — само insertion частта (host creation + insertBefore),
// не incremental-update оптимизацията, тъй като тестът винаги рендира на
// чиста страница (host е null при първо извикване, incremental клонът
// никога не се стига).
import { renderPlayingScreen } from '/src/app/activeRoom/renderPlayingScreen.ts'
import {
  createCuttingSeatPanelsHtml,
  type SeatBidBubble,
  type SeatDeclarationBubble,
} from '/src/app/activeRoom/cutting/renderCuttingSeatPanels.ts'
import { escapeHtml, getActiveRoomStageMetrics } from '/src/app/activeRoom/activeRoomShared.ts'
import type {
  RoomGameSnapshot,
  RoomSeatSnapshot,
  RoomPlayCardSnapshot,
  RoomCardSnapshot,
  Seat,
} from '/src/app/network/createGameServerClient.ts'
import type { PlayingUiCache } from '/src/app/activeRoom/activeRoomTypes.ts'

// renderPlayingScreen's `root` IS #app directly (mirrors main.ts: `root:
// rootElement` where rootElement === document.querySelector('#app')) — not
// a child appended into it. #app's own CSS (position:relative, no z-index —
// src/style.css) is exactly the stacking context this test exercises.
const root = document.getElementById('app') as unknown as HTMLDivElement

// Replicates createActiveRoomFlowController.ts's syncSeatBubblesLayer +
// syncSeatPanels (both internal closures there, not exported) — including
// the bubble/panel HOST SPLIT: bubble markup (data-seat-bubbles-layer) is
// extracted from the combined html string into its own body-level host,
// separate from the seat-panels-host, exactly like production. Using the
// OLD single-host behaviour here would hide the real bug this harness is
// meant to catch (bubbles trapped under the panels host, unable to stack
// above trick cards).
function syncSeatBubblesLayer(html: string): void {
  const temp = document.createElement('div')
  temp.innerHTML = html
  const incomingLayer = temp.querySelector<HTMLElement>('[data-seat-bubbles-layer="1"]')
  let bubblesHost = document.body.querySelector<HTMLDivElement>('[data-seat-bubbles-host="1"]')
  if (!incomingLayer) {
    bubblesHost?.remove()
    return
  }
  if (!bubblesHost) {
    bubblesHost = document.createElement('div')
    bubblesHost.setAttribute('data-seat-bubbles-host', '1')
    document.body.appendChild(bubblesHost)
  }
  bubblesHost.innerHTML = incomingLayer.outerHTML
}

function syncSeatPanels(html: string): void {
  syncSeatBubblesLayer(html)

  const temp = document.createElement('div')
  temp.innerHTML = html
  temp.querySelector('[data-seat-bubbles-layer="1"]')?.remove()

  let host = document.body.querySelector<HTMLDivElement>('[data-seat-panels-host="1"]')
  if (host) {
    host.innerHTML = temp.innerHTML
    return
  }
  const el = document.createElement('div')
  el.setAttribute('data-seat-panels-host', '1')
  el.style.position = 'relative'
  document.body.insertBefore(el, document.getElementById('app')!)
  el.innerHTML = temp.innerHTML
  host = el
}

function buildSeats(): RoomSeatSnapshot[] {
  const base = (seat: Seat, displayName: string, isBot: boolean): RoomSeatSnapshot => ({
    seat,
    displayName,
    isOccupied: true,
    isBot,
    isControlledByBot: false,
    isConnected: true,
    avatarUrl: null,
    level: 7,
    rankTitle: null,
    skillRating: 1000,
    gender: null,
  })
  return [
    base('bottom', 'Mimo', false),
    base('right', 'Деница', true),
    base('top', 'Александър', true),
    base('left', 'Калин', true),
  ]
}

function card(id: string, suit: RoomCardSnapshot['suit'], rank: RoomCardSnapshot['rank']): RoomCardSnapshot {
  return { id, suit, rank }
}

const ALL_CARDS: RoomCardSnapshot[] = [
  card('c1', 'diamonds', '8'),
  card('c2', 'hearts', 'A'),
  card('c3', 'spades', 'J'),
  card('c4', 'clubs', 'K'),
]
const PLAY_SEATS: Seat[] = ['top', 'right', 'bottom', 'left']

function buildPlays(count: number): RoomPlayCardSnapshot[] {
  return Array.from({ length: count }, (_, i) => ({
    seat: PLAY_SEATS[i]!,
    card: ALL_CARDS[i]!,
  }))
}

function buildGame(
  playCount: number,
  score: { teamA: number; teamB: number } = { teamA: 0, teamB: 0 },
  winningBid: { seat: Seat; contract: 'suit' | 'no-trumps' | 'all-trumps'; trumpSuit: RoomCardSnapshot['suit'] | null } = {
    seat: 'bottom',
    contract: 'suit',
    trumpSuit: 'spades',
  },
): RoomGameSnapshot {
  return {
    phase: 'playing',
    authoritativePhase: 'playing',
    timerDeadlineAt: null,
    dealerSeat: 'left',
    firstDealSeat: 'bottom',
    cutting: null,
    bidding: null,
    playing: {
      winningBid: {
        seat: winningBid.seat,
        contract: winningBid.contract,
        trumpSuit: winningBid.trumpSuit,
        doubled: false,
        redoubled: false,
      },
      currentTurnSeat: 'bottom',
      currentTrickPlays: buildPlays(playCount),
      completedTricksCount: 0,
      latestCompletedTrick: null,
      validCardIds: null,
    },
    scoring: null,
    matchEnded: null,
    declarations: [],
    score: { match: score },
    handCounts: { bottom: 7, right: 7, top: 7, left: 7 },
    ownHand: [
      card('h1', 'clubs', '7'), card('h2', 'clubs', 'J'), card('h3', 'clubs', 'Q'),
      card('h4', 'hearts', '8'), card('h5', 'hearts', 'K'), card('h6', 'hearts', 'A'),
      card('h7', 'spades', 'A'),
    ],
  } as unknown as RoomGameSnapshot
}

const cache: PlayingUiCache = {
  lastTrickKey: null,
  lastCompletedTricksCount: 0,
  isTrickCollectionAnimating: false,
  pendingCompletedTrickKey: null,
  latestCompletedTrickKey: null,
  bufferedCompletedTrick: null,
  completedTrickEntryKey: null,
  completedTrickEntryStartedAt: 0,
  hasRenderedSnapshot: false,
  animationToken: 0,
  pendingPlayCardSent: false,
  wasMyTurn: false,
  observedPlayKeys: [],
  showBotTakeover: false,
  hasShownBotTakeover: false,
  lastPlayedCardRect: null,
  hoveredHandCardId: null,
  pendingDeclarationPrompt: null,
  submittedDeclarationKeys: [],
  flyingCardPlayKey: null,
  lastSeatPanelKey: null,
}

function paint(playCount: number): void {
  const { stageScale, scaledStageWidth, scaledStageHeight } = getActiveRoomStageMetrics()
  const seats = buildSeats()
  const game = buildGame(playCount)

  // This harness tests static stacking (post-flight handoff state), not
  // the entry-flight animation itself (see [A] in the check script, which
  // covers the flying overlay separately via a source-level check). Presetting
  // lastTrickKey to the CURRENT trick key before rendering short-circuits
  // renderPlayingScreen's `animateNewest` detection (see getTrickKey/
  // animateNewest in renderPlayingScreen.ts), so every paint() call lands
  // the played cards directly in their static, already-visible state —
  // exactly what's on screen once a real flight animation completes.
  cache.lastTrickKey = game.playing!.currentTrickPlays.map((p) => `${p.seat}:${p.card.id}`).join('|')

  renderPlayingScreen({
    root,
    game,
    seats,
    localSeat: 'bottom',
    roomId: 'harness-room',
    winningBid: {
      seat: 'bottom',
      contract: 'suit',
      trumpSuit: 'spades',
      doubled: false,
      redoubled: false,
    } as any,
    stageScale,
    scaledStageWidth,
    scaledStageHeight,
    submitPlayCard: () => {},
    syncSeatPanels,
    cache,
  })
}

// Layers bid/declaration bubbles on top of an already-painted trick (via
// paint()) by calling syncSeatPanels a second time with the SAME seats/
// localSeat/panelScale — createCuttingSeatPanelsHtml is the same production
// function renderPlayingScreen uses internally (via syncSeatPanels) to
// derive bid/declaration bubble markup, so this exercises the exact same
// renderBidBubble/renderDeclarationBubble + createSeatBubbleAnchorHtml path,
// just invoked directly instead of through renderPlayingScreen's internal
// declaration-trigger timers (which are async/transient and not needed here
// — this harness only tests STATIC stacking, same rationale as paint()'s
// lastTrickKey preset above). Geometry (getCuttingSeatPanelAnchorStyle via
// panelScale) is identical to what paint() already used for the trick/fan
// layers, so bubble anchors land in the exact same position a real
// mid-round bubble would.
function paintWithBubbles(
  playCount: number,
  bidBubbleSeats: Seat[],
  declarationBubbleSeats: Seat[],
): void {
  paint(playCount)
  const { stageScale } = getActiveRoomStageMetrics()
  const seats = buildSeats()

  const bidBubbles: Partial<Record<Seat, SeatBidBubble>> = {}
  for (const seat of bidBubbleSeats) {
    bidBubbles[seat] = { label: 'Пика', elapsedMs: 0 }
  }
  const declarationBubbles: Partial<Record<Seat, SeatDeclarationBubble>> = {}
  for (const seat of declarationBubbleSeats) {
    declarationBubbles[seat] = { lines: ['Терца', '20'] }
  }

  // Reuse the exact same hand-count shape renderPlayingScreen builds
  // internally (panelHandCounts: game.handCounts with the local seat zeroed
  // out) so the second syncSeatPanels call doesn't wipe the left/right
  // card-back fans paint() already rendered — a null dealtHands here would
  // make createCuttingSeatPanelsHtml skip fan markup entirely, invalidating
  // the [B]-style overlap checks this harness relies on.
  syncSeatPanels(createCuttingSeatPanelsHtml({
    seats,
    localSeat: 'bottom',
    dealerSeat: 'left',
    cutterSeat: null,
    cuttingCountdownRemainingMs: null,
    panelScale: stageScale,
    escapeHtml,
    dealtHands: {
      handCounts: { bottom: 0, right: 7, top: 7, left: 7 },
      ownHand: [],
      previousOwnHand: null,
      localSeat: 'bottom',
      maxCardsPerSeat: 8,
      animStartIndex: 0,
      seatAnimDelays: null,
    },
    bidBubbles,
    declarationBubbles,
    emojiBubbles: null,
    phraseBubbles: null,
    tournamentBotReplacements: null,
  }))
}

// Repaints with a custom score / winning bid, to exercise HUD content
// variants (0:0, three-digit scores, "no announcement", longer bid-owner
// text) WITHOUT touching the HUD's own content/scoring logic — same
// production renderScoreHud.ts call as paint(), just with different game
// input values.
function paintWithScore(
  playCount: number,
  teamA: number,
  teamB: number,
  winningBid?: { seat: Seat; contract: 'suit' | 'no-trumps' | 'all-trumps'; trumpSuit: RoomCardSnapshot['suit'] | null },
): void {
  const { stageScale, scaledStageWidth, scaledStageHeight } = getActiveRoomStageMetrics()
  const seats = buildSeats()
  const game = buildGame(playCount, { teamA, teamB }, winningBid)
  cache.lastTrickKey = game.playing!.currentTrickPlays.map((p) => `${p.seat}:${p.card.id}`).join('|')

  renderPlayingScreen({
    root,
    game,
    seats,
    localSeat: 'bottom',
    roomId: 'harness-room',
    winningBid: game.playing!.winningBid as any,
    stageScale,
    scaledStageWidth,
    scaledStageHeight,
    submitPlayCard: () => {},
    syncSeatPanels,
    cache,
  })
}

function removeAllSeatPanels(): void {
  document.body.querySelector('[data-seat-panels-host="1"]')?.remove()
  document.body.querySelector('[data-seat-bubbles-host="1"]')?.remove()
}

// Exposes the same stageScale paint()/paintWithBubbles() just used, so
// checkPlayedCardStacking.ts's HUD-Scale1 check can compute the expected
// natural HUD width (318 * stageScale) without re-deriving stage metrics
// separately (which could drift out of sync with what was actually painted).
function getStageScaleForTest(): number {
  return getActiveRoomStageMetrics().stageScale
}

;(window as any).__playedCardStackingHarness = {
  paint,
  paintWithBubbles,
  paintWithScore,
  removeAllSeatPanels,
  escapeHtml,
  createCuttingSeatPanelsHtml,
  getStageScaleForTest,
}
