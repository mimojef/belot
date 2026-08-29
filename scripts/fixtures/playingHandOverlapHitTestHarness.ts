// Browser fixture за regression проверка на mobile/desktop card play
// hit-testing (§"Mobile Card Interaction Bug" forensic report + fix).
// Мачва РЕАЛНИЯ renderPlayingScreen() (не мокап) — реалният production
// hand-fan layout, z-index/overlap/pointer-events/opacity модел, real click
// wiring. Позволява да се конструира ръка от произволен брой suit-групи
// (всяка маркирана valid/invalid) на произволен viewport, за да можем да
// установим чрез document.elementFromPoint() кой DOM елемент реално получава
// touch/click в overlap зоните между карти, и какво реално се подава като
// played cardId при реален click/tap (driven от Playwright mouse/touchscreen
// API-та в driver-а, не от ръчно dispatch-нати synthetic събития тук).
import { renderPlayingScreen, removeBottomHandOverlay } from '/src/app/activeRoom/renderPlayingScreen.ts'
import { createPlayingUiCache, resetPlayingUiCache } from '/src/app/activeRoom/activeRoomShared.ts'
import type {
  RoomCardSnapshot,
  RoomGameSnapshot,
  RoomSeatSnapshot,
  Seat,
} from '/src/app/network/createGameServerClient.ts'

// Нарочно НЕ последователни рангове (прескача съседни стойности) — реалният
// sequence-declaration detector разпознава 3+ последователни ранга в СЪЩАТА
// боя; ако построим ръка с истински run (7,8,9,10...), handleHandCardChoice
// щеше да отвори declaration prompt вместо directно да извика submitPlayCard,
// объркувайки този тест (проверяваме hit-testing/click routing, не
// declaration UI). Този списък е безопасен за групи до 4 карти.
const NON_SEQUENTIAL_RANKS: RoomCardSnapshot['rank'][] = ['7', '9', 'J', 'A']

export type HandGroup = {
  suit: RoomCardSnapshot['suit']
  count: number
  valid: boolean
}

// Строи ръка от произволен брой suit-групи (в реда, в който са подадени).
// sortLocalHandForDisplay (реалната production sort функция, вика се вътре
// в renderPlayingScreen) групира по боя — щом всяка група тук ползва своя
// собствена боя, групите остават contiguous и в РЕНДНАТИЯ ред точно в реда,
// в който SUIT_ORDER ги сортира (не непременно реда, в който са подадени тук
// — driver-ът чете реалния DOM ред чрез getCardInfo(), не разчита на index).
function buildHand(groups: HandGroup[]): { hand: RoomCardSnapshot[]; validCardIds: string[] } {
  const hand: RoomCardSnapshot[] = []
  const validCardIds: string[] = []
  let globalIndex = 0
  for (const group of groups) {
    for (let i = 0; i < group.count; i++) {
      const rank = NON_SEQUENTIAL_RANKS[i % NON_SEQUENTIAL_RANKS.length]!
      const card: RoomCardSnapshot = { id: `${group.suit}-${rank}-${globalIndex}`, suit: group.suit, rank }
      hand.push(card)
      if (group.valid) {
        validCardIds.push(card.id)
      }
      globalIndex += 1
    }
  }
  return { hand, validCardIds }
}

function buildSeats(): RoomSeatSnapshot[] {
  const seats: Seat[] = ['bottom', 'right', 'top', 'left']
  return seats.map((seat) => ({
    seat,
    displayName: seat,
    isOccupied: true,
    isBot: false,
    isControlledByBot: false,
    isConnected: true,
    avatarUrl: null,
    level: null,
    rankTitle: null,
    skillRating: null,
    gender: null,
  }))
}

const root = document.getElementById('root') as HTMLDivElement
const cache = createPlayingUiCache()
const submittedPlays: Array<{ roomId: string; cardId: string }> = []

function mount(options: { groups: HandGroup[]; isMyTurn: boolean }): { hand: RoomCardSnapshot[]; validCardIds: string[] | null } {
  resetPlayingUiCache(cache)
  removeBottomHandOverlay()
  submittedPlays.length = 0

  const { hand, validCardIds: builtValidIds } = buildHand(options.groups)
  const validCardIds = options.isMyTurn ? builtValidIds : null

  const game: RoomGameSnapshot = {
    phase: 'playing',
    authoritativePhase: 'playing',
    timerDeadlineAt: options.isMyTurn ? Date.now() + 20_000 : null,
    dealerSeat: 'left',
    firstDealSeat: 'left',
    cutting: null,
    bidding: null,
    playing: {
      // trumpSuit е нарочно 'spades' — нито една тестова suit-група в
      // driver-а не ползва spades — sortLocalHandForDisplay's getRankOrder
      // прилага TRUMP_RANK_ORDER (различен от нормалния ascending ред) само
      // за карти от boята на trumpSuit; ако той съвпаднеше с тестова група,
      // NON_SEQUENTIAL_RANKS редът вътре в тази група би се разбъркал
      // неочаквано спрямо construction реда.
      winningBid: { seat: 'bottom', contract: 'suit', trumpSuit: 'spades', doubled: false, redoubled: false },
      currentTurnSeat: options.isMyTurn ? 'bottom' : 'right',
      currentTrickPlays: [],
      completedTricksCount: 0,
      latestCompletedTrick: null,
      validCardIds,
    },
    scoring: null,
    matchEnded: null,
    declarations: [],
    score: { match: { teamA: 0, teamB: 0 } },
    handCounts: { bottom: hand.length, right: 8, top: 8, left: 8 },
    ownHand: hand,
  }

  renderPlayingScreen({
    root,
    game,
    seats: buildSeats(),
    localSeat: 'bottom',
    roomId: 'room-overlap-test',
    winningBid: game.playing!.winningBid,
    stageScale: 1,
    scaledStageWidth: 1600,
    scaledStageHeight: 900,
    submitPlayCard: (roomId, cardId) => {
      submittedPlays.push({ roomId, cardId })
    },
    cache,
  })

  return { hand, validCardIds }
}

function getOrderedCardButtons(): HTMLButtonElement[] {
  return Array.from(document.body.querySelectorAll<HTMLButtonElement>('[data-playing-bottom-hand-host] [data-card-id]'))
}

type CardInfo = {
  cardId: string
  rect: { x: number; y: number; width: number; height: number; top: number; left: number; right: number; bottom: number }
  zIndex: string
  disabled: boolean
  pointerEvents: string
  opacity: string
}

function getCardInfo(): CardInfo[] {
  return getOrderedCardButtons().map((button) => {
    const rect = button.getBoundingClientRect()
    const computed = getComputedStyle(button)
    return {
      cardId: button.dataset.cardId ?? '',
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom },
      zIndex: computed.zIndex,
      disabled: button.disabled,
      pointerEvents: computed.pointerEvents,
      opacity: computed.opacity,
    }
  })
}

function hitTestAt(x: number, y: number): { cardId: string | null; tag: string; disabled: boolean } {
  const el = document.elementFromPoint(x, y)
  if (el === null) {
    return { cardId: null, tag: 'none', disabled: false }
  }
  const cardButton = el.closest<HTMLButtonElement>('[data-card-id]')
  return {
    cardId: cardButton?.dataset.cardId ?? null,
    tag: el.tagName,
    disabled: cardButton?.disabled ?? false,
  }
}

function getSubmittedPlays(): Array<{ roomId: string; cardId: string }> {
  return [...submittedPlays]
}

function clearSubmittedPlays(): void {
  submittedPlays.length = 0
}

function isPhoneLayout(): boolean {
  const shortSide = Math.min(window.innerWidth, window.innerHeight)
  const longSide = Math.max(window.innerWidth, window.innerHeight)
  const isCoarseTouch = window.matchMedia('(hover: none) and (pointer: coarse)').matches
  const isNarrowPortrait = window.innerHeight > window.innerWidth && shortSide <= 640 && longSide <= 1200
  return (isCoarseTouch && shortSide <= 480 && longSide <= 1050) || isNarrowPortrait
}

;(window as any).__playingHandOverlapHarness = {
  mount,
  getCardInfo,
  hitTestAt,
  getSubmittedPlays,
  clearSubmittedPlays,
  isPhoneLayout,
}
