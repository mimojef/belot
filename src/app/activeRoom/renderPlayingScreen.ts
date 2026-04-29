import type {
  RoomCardSnapshot,
  RoomCompletedTrickSnapshot,
  RoomGameSnapshot,
  RoomPlayCardSnapshot,
  RoomSeatSnapshot,
  RoomWinningBidSnapshot,
  Seat,
} from '../network/createGameServerClient'
import { getCardFaceImagePath } from './cardImageAssets'
import {
  ACTIVE_ROOM_STAGE_HEIGHT,
  ACTIVE_ROOM_STAGE_WIDTH,
  escapeHtml,
} from './activeRoomShared'
import {
  createCuttingSeatPanelsHtml,
  type DealtHandsData,
} from './cutting/renderCuttingSeatPanels'
import {
  getCuttingSeatPanelAnchorStyle,
  getVisualSeatForLocalPerspective,
} from './cutting/cuttingSeatLayout'
import { sortLocalHandForDisplay, type SortDisplayOptions } from './sortLocalHand'
import { animateTrickCollection } from './animateTrickCollection'
import type { PlayingUiCache } from './activeRoomTypes'

const TABLE_BACKGROUND = `
  radial-gradient(circle at center, rgba(74,222,128,0.18) 0%, rgba(34,197,94,0.10) 34%, rgba(21,128,61,0.00) 58%),
  linear-gradient(180deg, rgba(22,101,52,0.98) 0%, rgba(17,94,39,0.99) 100%)
`

const COMPLETED_TRICK_PREVIEW_MS = 220
const PLAY_HUMAN_TIMEOUT_MS = 15_000
const PLAY_BOT_DELAY_MS = 1_000

const TRICK_W = 195
const TRICK_H = 284
const HAND_W = 195
const HAND_H = 284
const BOTTOM_PANEL_WIDTH = 360
const BOTTOM_PANEL_HEIGHT = 138
const BOTTOM_HAND_CENTER_X = 180
const BOTTOM_HAND_CENTER_Y = 50

const SEAT_TRICK_OFFSET: Record<Seat, { left: number; top: number; rotate: number }> = {
  top: { left: 0, top: -54, rotate: 0 },
  left: { left: -78, top: 0, rotate: -8 },
  right: { left: 78, top: 0, rotate: 8 },
  bottom: { left: 0, top: 54, rotate: 0 },
}

const ENTRY_OFFSET: Record<Seat, { x: number; y: number }> = {
  top: { x: 0, y: -200 },
  left: { x: -220, y: 0 },
  right: { x: 220, y: 0 },
  bottom: { x: 0, y: 220 },
}

const SUIT_SYMBOL: Record<string, string> = {
  clubs: '♣',
  diamonds: '♦',
  hearts: '♥',
  spades: '♠',
}

const latestRenderOptionsByCache = new WeakMap<PlayingUiCache, RenderPlayingScreenOptions>()

async function animatePlayedCardFromHand(options: {
  sourceRect: DOMRect
  targetRect: DOMRect
  cardElement: HTMLElement
}): Promise<void> {
  const { sourceRect, targetRect, cardElement } = options

  const overlay = document.createElement('div')
  overlay.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:9000;overflow:visible'
  document.body.appendChild(overlay)

  const clone = cardElement.cloneNode(true) as HTMLElement
  clone.style.position = 'fixed'
  clone.style.left = `${sourceRect.left}px`
  clone.style.top = `${sourceRect.top}px`
  clone.style.width = `${sourceRect.width}px`
  clone.style.height = `${sourceRect.height}px`
  clone.style.margin = '0'
  clone.style.transform = 'none'
  clone.style.transformOrigin = 'center center'
  clone.style.pointerEvents = 'none'
  clone.style.zIndex = '9001'
  overlay.appendChild(clone)

  cardElement.style.visibility = 'hidden'

  try {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

    const dx = targetRect.left - sourceRect.left
    const dy = targetRect.top - sourceRect.top
    const scale = targetRect.width > 0 ? targetRect.width / sourceRect.width : 1

    const anim = clone.animate(
      [
        { transform: 'translate(0,0) scale(1)', opacity: 1 },
        { transform: `translate(${dx}px,${dy}px) scale(${scale})`, opacity: 1 },
      ],
      { duration: 350, easing: 'cubic-bezier(0.22,1,0.36,1)', fill: 'forwards' },
    )

    await new Promise<void>((resolve) => {
      anim.onfinish = () => resolve()
      anim.oncancel = () => resolve()
    })
  } finally {
    overlay.remove()
    cardElement.style.visibility = ''
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function isRedSuit(suit: string): boolean {
  return suit === 'hearts' || suit === 'diamonds'
}

function getTrickKey(plays: RoomPlayCardSnapshot[]): string {
  return plays.map((play) => `${play.seat}:${play.card.id}`).join('|')
}

function getPlayKey(play: RoomPlayCardSnapshot): string {
  return `${play.seat}:${play.card.id}`
}

function getCompletedTrickKey(trick: RoomCompletedTrickSnapshot): string {
  return `${trick.trickIndex}:${trick.winnerSeat}:${getTrickKey(trick.plays)}`
}

function getSortOptions(
  winningBid: NonNullable<RoomWinningBidSnapshot> | null,
): SortDisplayOptions {
  if (!winningBid) {
    return { contract: 'default' }
  }

  if (winningBid.contract === 'no-trumps') {
    return { contract: 'no-trumps' }
  }

  if (winningBid.contract === 'all-trumps') {
    return { contract: 'all-trumps' }
  }

  if (!winningBid.trumpSuit) {
    return { contract: 'default' }
  }

  return { contract: 'suit', trumpSuit: winningBid.trumpSuit }
}

function getPlayOrderSpread(index: number, count: number): {
  left: number
  top: number
  rotate: number
} {
  const centeredIndex = index - (count - 1) / 2
  return {
    left: centeredIndex * 8,
    top: Math.abs(centeredIndex) * 3,
    rotate: centeredIndex * 2,
  }
}

function getBottomHandOffset(index: number, count: number): {
  x: number
  y: number
  rotate: number
} {
  const centeredIndex = index - (count - 1) / 2
  return {
    x: centeredIndex * 65,
    y: Math.abs(centeredIndex) * 6,
    rotate: centeredIndex * 6,
  }
}

function getPlayingCountdownState(
  game: RoomGameSnapshot,
  seats: RoomSeatSnapshot[],
): {
  countdownSeat: Seat | null
  countdownRemainingMs: number | null
  countdownTotalMs: number
} {
  const countdownSeat = game.playing?.currentTurnSeat ?? null

  if (countdownSeat === null || game.timerDeadlineAt === null) {
    return {
      countdownSeat,
      countdownRemainingMs: null,
      countdownTotalMs: PLAY_HUMAN_TIMEOUT_MS,
    }
  }

  const rawCountdownRemainingMs = Math.max(0, game.timerDeadlineAt - Date.now())
  const currentTurnSeatSnapshot =
    seats.find((seat) => seat.seat === countdownSeat) ?? null

  const countdownRemainingMs = currentTurnSeatSnapshot?.isBot
    ? Math.max(
        0,
        PLAY_HUMAN_TIMEOUT_MS -
          (PLAY_BOT_DELAY_MS - Math.min(PLAY_BOT_DELAY_MS, rawCountdownRemainingMs)),
      )
    : rawCountdownRemainingMs

  return {
    countdownSeat,
    countdownRemainingMs,
    countdownTotalMs: PLAY_HUMAN_TIMEOUT_MS,
  }
}

function renderTrickCard(
  play: RoomPlayCardSnapshot,
  index: number,
  count: number,
  localSeat: Seat,
  animateNewest: boolean,
): string {
  const visualSeat = getVisualSeatForLocalPerspective(play.seat, localSeat)
  const seatOffset = SEAT_TRICK_OFFSET[visualSeat]
  const spreadOffset = getPlayOrderSpread(index, count)
  const finalLeft = seatOffset.left + spreadOffset.left
  const finalTop = seatOffset.top + spreadOffset.top
  const finalRotate = seatOffset.rotate + spreadOffset.rotate
  const isNewest = index === count - 1

  let animationStyle = ''
  if (isNewest && animateNewest) {
    const entryOffset = ENTRY_OFFSET[visualSeat]
    animationStyle = `
      --belot-entry-x:${entryOffset.x}px;
      --belot-entry-y:${entryOffset.y}px;
      --belot-final-rotate:${finalRotate}deg;
      animation:belot-play-card-entry 400ms cubic-bezier(0.22,1,0.36,1) forwards;
    `
  }

  const cardColor = isRedSuit(play.card.suit) ? '#b3261e' : '#13253d'
  const symbol = SUIT_SYMBOL[play.card.suit] ?? ''
  const cardImagePath = getCardFaceImagePath(play.card)

  return `
    <div
      data-current-trick-card="1"
      data-trick-seat="${escapeHtml(play.seat)}"
      data-card-id="${escapeHtml(play.card.id)}"
      style="
        position:absolute;
        left:50%;
        top:50%;
        width:${TRICK_W}px;
        height:${TRICK_H}px;
        margin-left:${-TRICK_W / 2 + finalLeft}px;
        margin-top:${-TRICK_H / 2 + 23 + finalTop}px;
        transform:translate(0,0) rotate(${finalRotate}deg) scale(1);
        transform-origin:center center;
        backface-visibility:hidden;
        will-change:transform;
        z-index:${10 + index};
        pointer-events:none;
        ${animationStyle}
      "
    >
      <div
        style="
          position:absolute;
          inset:0;
          border-radius:14px;
          box-shadow:0 16px 34px rgba(0,0,0,0.24),inset 0 1px 0 rgba(255,255,255,0.95);
          border:1px solid rgba(21,48,82,0.10);
          overflow:hidden;
        "
      >
        <div
          style="
            position:absolute;
            inset:0;
            border-radius:14px;
            background:linear-gradient(180deg,rgba(255,255,255,0.99) 0%,rgba(241,245,250,0.99) 100%);
            z-index:1;
          "
        >
          <div
            style="
              position:absolute;
              left:9px;
              top:10px;
              display:flex;
              flex-direction:column;
              align-items:center;
              gap:1px;
              color:${cardColor};
              line-height:1;
            "
          >
            <span style="font-size:30px;font-weight:900;letter-spacing:0.02em;">${escapeHtml(play.card.rank)}</span>
            <span style="font-size:45px;font-weight:900;">${symbol}</span>
          </div>
          <div
            style="
              position:absolute;
              right:9px;
              bottom:8px;
              display:flex;
              flex-direction:column;
              align-items:center;
              gap:1px;
              color:${cardColor};
              line-height:1;
              transform:rotate(180deg);
            "
          >
            <span style="font-size:30px;font-weight:900;letter-spacing:0.02em;">${escapeHtml(play.card.rank)}</span>
            <span style="font-size:45px;font-weight:900;">${symbol}</span>
          </div>
          <div
            style="
              position:absolute;
              left:50%;
              top:54%;
              transform:translate(-50%,-50%);
              color:${cardColor};
              font-size:54px;
              line-height:1;
              font-weight:900;
            "
          >${symbol}</div>
        </div>
        <img
          src="${escapeHtml(cardImagePath)}"
          alt="${escapeHtml(play.card.rank)} ${escapeHtml(play.card.suit)}"
          onerror="this.style.display='none'"
          style="
            position:absolute;
            inset:0;
            width:100%;
            height:100%;
            display:block;
            object-fit:fill;
            border-radius:14px;
            pointer-events:none;
            user-select:none;
            -webkit-user-drag:none;
            z-index:2;
          "
        />
      </div>
      <div
        style="
          position:absolute;
          inset:4px;
          border-radius:10px;
          border:1px solid rgba(20,49,84,0.12);
          z-index:3;
        "
      ></div>
    </div>
  `
}

function renderTrickArea(
  plays: RoomPlayCardSnapshot[],
  localSeat: Seat,
  animateNewest: boolean,
): string {
  return `
    <style>
      @keyframes belot-play-card-entry {
        0% {
          opacity:1;
          transform:translate(var(--belot-entry-x),var(--belot-entry-y)) rotate(var(--belot-final-rotate)) scale(1.42);
        }
        100% {
          opacity:1;
          transform:translate(0px,0px) rotate(var(--belot-final-rotate)) scale(1);
        }
      }
    </style>
    <div
      data-current-trick="1"
      style="
        position:relative;
        width:420px;
        height:260px;
        margin:0 auto;
        pointer-events:none;
      "
    >
      ${plays.map((play, index) => renderTrickCard(play, index, plays.length, localSeat, animateNewest)).join('')}
    </div>
  `
}

function renderBottomHandOverlay(options: {
  cards: RoomCardSnapshot[]
  validCardIds: string[] | null
  isMyTurn: boolean
  stageScale: number
}): string {
  const { cards, validCardIds, isMyTurn, stageScale } = options

  if (cards.length === 0) {
    return ''
  }

  const cardButtons = cards.map((card, index) => {
    const offset = getBottomHandOffset(index, cards.length)
    const baseTransform = `translate(-50%,-50%) translate(${offset.x}px,${offset.y}px) rotate(${offset.rotate}deg)`
    const isValid = !isMyTurn || validCardIds === null || validCardIds.includes(card.id)
    const canClick = isMyTurn && isValid
    const opacity = isMyTurn && !isValid ? 0.62 : 1
    const filter = isMyTurn && !isValid ? 'saturate(0.68) brightness(0.88)' : 'none'

    return `
      <button
        class="play-hand-card${canClick ? ' play-hand-card--active' : ''}"
        data-card-id="${escapeHtml(card.id)}"
        data-base-transform="${escapeHtml(baseTransform)}"
        data-z="${60 + index}"
        ${!canClick ? 'disabled' : ''}
        style="
          position:absolute;
          left:50%;
          top:50%;
          width:${HAND_W}px;
          height:${HAND_H}px;
          padding:0;
          border:1px solid rgba(255,255,255,0.24);
          border-radius:16px;
          background:none;
          overflow:hidden;
          box-shadow:0 8px 18px rgba(0,0,0,0.22);
          transform:${baseTransform};
          cursor:${canClick ? 'pointer' : 'default'};
          pointer-events:${canClick ? 'auto' : 'none'};
          opacity:${opacity};
          filter:${filter};
          transition:transform 0.12s ease,filter 0.12s ease,opacity 0.15s ease;
          z-index:${60 + index};
        "
      >
        <img
          src="${escapeHtml(getCardFaceImagePath(card))}"
          alt="${escapeHtml(card.rank)} ${escapeHtml(card.suit)}"
          style="
            width:100%;
            height:100%;
            display:block;
            object-fit:fill;
            pointer-events:none;
            user-select:none;
            -webkit-user-drag:none;
          "
        />
        <span
          aria-hidden="true"
          style="
            position:absolute;
            inset:4px;
            border-radius:10px;
            border:1px solid rgba(20,49,84,0.12);
            pointer-events:none;
          "
        ></span>
      </button>
    `
  }).join('')

  const myTurnBadge = isMyTurn
    ? `
      <div
        style="
          position:absolute;
          left:50%;
          top:-132px;
          transform:translateX(-50%);
          z-index:120;
          background:rgba(251,191,36,0.12);
          border:1px solid rgba(251,191,36,0.4);
          border-radius:8px;
          padding:4px 16px;
          color:#fde68a;
          font-size:13px;
          font-weight:700;
          letter-spacing:0.04em;
          pointer-events:none;
        "
      >ВАШ РЕД</div>
    `
    : ''

  return `
    <div
      style="
        position:fixed;
        inset:0;
        z-index:2;
        pointer-events:none;
      "
    >
      <div
        style="
          position:absolute;
          ${getCuttingSeatPanelAnchorStyle('bottom', stageScale)}
          width:${BOTTOM_PANEL_WIDTH}px;
          height:${BOTTOM_PANEL_HEIGHT}px;
          pointer-events:none;
        "
      >
        ${myTurnBadge}
        <div
          style="
            position:absolute;
            left:${BOTTOM_HAND_CENTER_X}px;
            top:${BOTTOM_HAND_CENTER_Y}px;
            width:1px;
            height:1px;
            pointer-events:none;
          "
        >
          ${cardButtons}
        </div>
      </div>
    </div>
  `
}

function renderPlayingStage(options: {
  plays: RoomPlayCardSnapshot[]
  localSeat: Seat
  animateNewest: boolean
}): string {
  const {
    plays,
    localSeat,
    animateNewest,
  } = options

  return `
    <section
      style="
        position:relative;
        width:100%;
        height:100%;
        background:${TABLE_BACKGROUND};
        overflow:visible;
      "
    >
      <div
        style="
          position:absolute;
          left:50%;
          top:50%;
          transform:translate(-50%,-50%);
          z-index:2;
        "
      >
        ${renderTrickArea(plays, localSeat, animateNewest)}
      </div>
    </section>
  `
}

function resetCacheForFreshSnapshot(
  cache: PlayingUiCache,
  currentTrickKey: string,
  completedTricksCount: number,
  latestCompletedTrickKey: string | null,
): void {
  cache.lastTrickKey = currentTrickKey
  cache.lastCompletedTricksCount = completedTricksCount
  cache.isTrickCollectionAnimating = false
  cache.pendingCompletedTrickKey = null
  cache.latestCompletedTrickKey = latestCompletedTrickKey
  cache.bufferedCompletedTrick = null
  cache.hasRenderedSnapshot = true
  cache.animationToken += 1
  cache.pendingPlayCardSent = false
  cache.wasMyTurn = false
  cache.observedPlayKeys = []
  cache.showBotTakeover = false
  cache.hasShownBotTakeover = false
  cache.lastPlayedCardRect = null
}

function scheduleCompletedTrickCollection(
  options: RenderPlayingScreenOptions,
  completedTrick: RoomCompletedTrickSnapshot,
): void {
  const { cache, root, localSeat } = options
  const expectedToken = cache.animationToken + 1
  cache.animationToken = expectedToken
  cache.isTrickCollectionAnimating = true

  void (async () => {
    await wait(COMPLETED_TRICK_PREVIEW_MS)

    if (cache.animationToken !== expectedToken) {
      return
    }

    const cardElements = Array.from(
      root.querySelectorAll<HTMLElement>('[data-current-trick-card]'),
    )
    const visualWinner = getVisualSeatForLocalPerspective(
      completedTrick.winnerSeat,
      localSeat,
    )
    const targetElement = root.querySelector<HTMLElement>(
      `[data-active-room-seat-anchor="${completedTrick.winnerSeat}"]`,
    )

    const animationPromise = animateTrickCollection({
      cards: cardElements.map((element) => ({ element })),
      winnerSeat: visualWinner,
      targetElement,
      overlayZIndex: 9000,
    })

    cache.pendingCompletedTrickKey = null
    cache.bufferedCompletedTrick = null

    await animationPromise
  })()
    .catch(() => {})
    .finally(() => {
      if (cache.animationToken !== expectedToken) {
        return
      }

      cache.isTrickCollectionAnimating = false
      const latestOptions = latestRenderOptionsByCache.get(cache)
      if (latestOptions) {
        renderPlayingScreen(latestOptions)
      }
    })
}

function syncPlayingBotTakeoverState(options: {
  cache: PlayingUiCache
  localSeat: Seat
  isMyTurn: boolean
  snapshotPlays: RoomPlayCardSnapshot[]
  latestCompletedTrick: RoomCompletedTrickSnapshot | null
}): void {
  const {
    cache,
    localSeat,
    isMyTurn,
    snapshotPlays,
    latestCompletedTrick,
  } = options
  const observedKeys = new Set(cache.observedPlayKeys)
  const visiblePlays = latestCompletedTrick === null
    ? snapshotPlays
    : [...snapshotPlays, ...latestCompletedTrick.plays]

  for (const play of visiblePlays) {
    const playKey = getPlayKey(play)
    if (observedKeys.has(playKey)) {
      continue
    }

    if (
      play.seat === localSeat &&
      cache.wasMyTurn &&
      !cache.pendingPlayCardSent &&
      !cache.hasShownBotTakeover
    ) {
      cache.showBotTakeover = true
      cache.hasShownBotTakeover = true
    }

    if (play.seat === localSeat) {
      cache.pendingPlayCardSent = false
    }

    observedKeys.add(playKey)
  }

  cache.observedPlayKeys = [...observedKeys]
  cache.wasMyTurn = isMyTurn
}

export type RenderPlayingScreenOptions = {
  root: HTMLDivElement
  game: RoomGameSnapshot
  seats: RoomSeatSnapshot[]
  localSeat: Seat
  roomId: string
  winningBid: NonNullable<RoomWinningBidSnapshot> | null
  stageScale: number
  scaledStageWidth: number
  scaledStageHeight: number
  submitPlayCard: (roomId: string, cardId: string) => void
  cache: PlayingUiCache
}

export function renderPlayingScreen(options: RenderPlayingScreenOptions): void {
  const {
    root,
    game,
    seats,
    localSeat,
    roomId,
    winningBid,
    stageScale,
    scaledStageWidth,
    scaledStageHeight,
    submitPlayCard,
    cache,
  } = options

  latestRenderOptionsByCache.set(cache, options)

  const playing = game.playing
  const snapshotPlays = playing?.currentTrickPlays ?? []
  const completedCount = playing?.completedTricksCount ?? 0
  const validCardIds = playing?.validCardIds ?? null
  const latestCompletedTrick = playing?.latestCompletedTrick ?? null
  const snapshotTrickKey = getTrickKey(snapshotPlays)
  const latestCompletedTrickKey =
    latestCompletedTrick !== null ? getCompletedTrickKey(latestCompletedTrick) : null

  if (!cache.hasRenderedSnapshot) {
    cache.hasRenderedSnapshot = true
    cache.lastCompletedTricksCount = completedCount
    cache.lastTrickKey = snapshotTrickKey
    cache.latestCompletedTrickKey = latestCompletedTrickKey
  } else if (completedCount < cache.lastCompletedTricksCount) {
    resetCacheForFreshSnapshot(cache, snapshotTrickKey, completedCount, latestCompletedTrickKey)
  }

  const hasNewCompletedTrick = completedCount > cache.lastCompletedTricksCount
  let shouldStartCollection = false

  if (
    hasNewCompletedTrick &&
    !cache.isTrickCollectionAnimating &&
    cache.pendingCompletedTrickKey === null
  ) {
    const canAnimateCompletedTrick =
      latestCompletedTrick !== null &&
      latestCompletedTrick.plays.length === 4 &&
      latestCompletedTrickKey !== null &&
      latestCompletedTrickKey !== cache.latestCompletedTrickKey

    cache.lastCompletedTricksCount = completedCount

    if (canAnimateCompletedTrick) {
      cache.pendingCompletedTrickKey = latestCompletedTrickKey
      cache.latestCompletedTrickKey = latestCompletedTrickKey
      cache.bufferedCompletedTrick = latestCompletedTrick
      shouldStartCollection = true
    } else if (latestCompletedTrickKey !== null) {
      cache.latestCompletedTrickKey = latestCompletedTrickKey
    }
  }

  const isShowingBufferedCompletedTrick =
    cache.pendingCompletedTrickKey !== null &&
    cache.bufferedCompletedTrick !== null &&
    cache.pendingCompletedTrickKey === getCompletedTrickKey(cache.bufferedCompletedTrick)

  const displayedPlays = isShowingBufferedCompletedTrick
    ? cache.bufferedCompletedTrick!.plays
    : snapshotPlays
  const animateNewest =
    !isShowingBufferedCompletedTrick &&
    !cache.isTrickCollectionAnimating &&
    snapshotPlays.length > 0 &&
    snapshotPlays.length < 4 &&
    snapshotTrickKey !== cache.lastTrickKey

  const newestPlay = snapshotPlays[snapshotPlays.length - 1] ?? null
  let pendingPlayedCardRect: DOMRect | null = null
  let shouldAnimateNewestViaOverlay = false
  if (animateNewest && newestPlay?.seat === localSeat) {
    pendingPlayedCardRect = cache.lastPlayedCardRect
    cache.lastPlayedCardRect = null
    if (pendingPlayedCardRect !== null) {
      shouldAnimateNewestViaOverlay = true
    }
  } else if (!animateNewest) {
    cache.lastPlayedCardRect = null
  }

  cache.lastTrickKey = snapshotTrickKey

  const sortedHand = sortLocalHandForDisplay(game.ownHand, getSortOptions(winningBid))
  const isMyTurn = playing?.currentTurnSeat === localSeat
  syncPlayingBotTakeoverState({
    cache,
    localSeat,
    isMyTurn,
    snapshotPlays,
    latestCompletedTrick,
  })
  cache.showBotTakeover = false
  const panelHandCounts = {
    ...game.handCounts,
    [localSeat]: 0,
  }
  const dealtHandsForPanels: DealtHandsData = {
    handCounts: panelHandCounts,
    ownHand: sortedHand,
    previousOwnHand: null,
    localSeat,
    maxCardsPerSeat: 8,
    animStartIndex: 0,
    seatAnimDelays: null,
  }
  const {
    countdownSeat: playingCountdownSeat,
    countdownRemainingMs: playingCountdownRemainingMs,
    countdownTotalMs: playingCountdownTotalMs,
  } = getPlayingCountdownState(game, seats)

  root.innerHTML = `
    <div
      style="
        position:relative;
        min-height:100vh;
        width:100%;
        box-sizing:border-box;
        display:flex;
        align-items:center;
        justify-content:center;
        overflow:hidden;
        background:${TABLE_BACKGROUND};
        font-family:Inter, system-ui, sans-serif;
      "
    >
      <div
        style="
          position:relative;
          width:${scaledStageWidth}px;
          height:${scaledStageHeight}px;
          flex:0 0 auto;
        "
      >
        <div
          style="
            position:absolute;
            left:50%;
            top:50%;
            width:${ACTIVE_ROOM_STAGE_WIDTH}px;
            height:${ACTIVE_ROOM_STAGE_HEIGHT}px;
            transform:translate(-50%, -50%) scale(${stageScale});
            transform-origin:center center;
          "
        >
          <div
            data-active-room-playing-visual="1"
            style="
              position:relative;
              width:100%;
              height:100%;
              overflow:visible;
            "
          >
            ${renderPlayingStage({
              plays: displayedPlays,
              localSeat,
              animateNewest: shouldAnimateNewestViaOverlay ? false : animateNewest,
            })}
          </div>
        </div>
      </div>
      ${createCuttingSeatPanelsHtml({
        seats,
        localSeat,
        dealerSeat: game.dealerSeat ?? null,
        cutterSeat: null,
        cuttingCountdownRemainingMs: null,
        countdownSeat: playingCountdownSeat,
        countdownRemainingMs: playingCountdownRemainingMs,
        countdownTotalMs: playingCountdownTotalMs,
        panelScale: stageScale,
        escapeHtml,
        dealtHands: dealtHandsForPanels,
        bidBubbles: null,
      })}
      ${renderBottomHandOverlay({
        cards: sortedHand,
        validCardIds,
        isMyTurn,
        stageScale,
      })}
    </div>
  `

  root.querySelectorAll<HTMLButtonElement>('.play-hand-card--active').forEach((button) => {
    const cardId = button.dataset.cardId
    if (!cardId) {
      return
    }

    button.addEventListener('click', () => {
      cache.lastPlayedCardRect = button.getBoundingClientRect()
      cache.pendingPlayCardSent = true
      submitPlayCard(roomId, cardId)
    })
  })

  root.querySelectorAll<HTMLButtonElement>('.play-hand-card--active').forEach((button) => {
    const baseTransform = button.dataset.baseTransform ?? ''
    const baseZIndex = Number.parseInt(button.dataset.z ?? '50', 10)

    button.addEventListener('mouseenter', () => {
      button.style.transform = `${baseTransform} translateY(-5px)`
      button.style.filter = 'brightness(1.03) drop-shadow(0 8px 12px rgba(0,0,0,0.18))'
      button.style.zIndex = String(baseZIndex)
    })

    button.addEventListener('mouseleave', () => {
      button.style.transform = baseTransform
      if (button.disabled) {
        button.style.filter = 'saturate(0.68) brightness(0.88)'
      } else {
        button.style.filter = 'none'
      }
      button.style.zIndex = String(baseZIndex)
    })
  })

  if (shouldAnimateNewestViaOverlay && pendingPlayedCardRect !== null) {
    const trickCardEl = root.querySelector<HTMLElement>(
      `[data-current-trick-card][data-trick-seat="${localSeat}"]`,
    )
    if (trickCardEl) {
      const targetRect = trickCardEl.getBoundingClientRect()
      void animatePlayedCardFromHand({
        sourceRect: pendingPlayedCardRect,
        targetRect,
        cardElement: trickCardEl,
      })
    }
  }

  if (shouldStartCollection && cache.bufferedCompletedTrick !== null) {
    scheduleCompletedTrickCollection(options, cache.bufferedCompletedTrick)
  }
}
