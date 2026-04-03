import { SEAT_ORDER, type Seat } from '../../data/constants/seatOrder'
import type { BottomHandViewState } from '../../core/state/getBottomHandViewState'

type ViewCard = BottomHandViewState['cards'][number]

type SortedHandCard = {
  card: ViewCard
  originalIndex: number
}

const DEAL_PACKET_START_DELAY = 220
const DEAL_PACKET_DELAY_STEP = 420
const DEAL_PACKET_DURATION = 860

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function escapeJsString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

function readCardRank(card: ViewCard): string {
  const rawRank = (card as { rank?: unknown }).rank
  return rawRank === null || rawRank === undefined ? '' : String(rawRank).toUpperCase()
}

function readCardSuit(card: ViewCard): string {
  const rawSuit = (card as { suit?: unknown }).suit
  return rawSuit === null || rawSuit === undefined ? '' : String(rawSuit)
}

function readCardId(card: ViewCard, index: number): string {
  const rawId = (card as { id?: unknown }).id

  if (typeof rawId === 'string' && rawId.trim().length > 0) {
    return rawId
  }

  return `${readCardSuit(card)}-${readCardRank(card)}-${index}`
}

function readCardPlayable(card: ViewCard): boolean {
  return (card as { isPlayable?: boolean }).isPlayable === true
}

function getSuitSymbol(suit: string): string {
  if (suit === 'spades') return '♠'
  if (suit === 'hearts') return '♥'
  if (suit === 'diamonds') return '♦'
  if (suit === 'clubs') return '♣'
  return '?'
}

function isRedSuit(suit: string): boolean {
  return suit === 'hearts' || suit === 'diamonds'
}

function getSuitSortOrder(suit: string): number {
  if (suit === 'clubs') return 0
  if (suit === 'diamonds') return 1
  if (suit === 'spades') return 2
  if (suit === 'hearts') return 3
  return 99
}

function getAllTrumpsRankSortOrder(rank: string): number {
  if (rank === '7') return 0
  if (rank === '8') return 1
  if (rank === 'Q') return 2
  if (rank === 'K') return 3
  if (rank === '10') return 4
  if (rank === 'A') return 5
  if (rank === '9') return 6
  if (rank === 'J') return 7
  return 99
}

function getNoTrumpsRankSortOrder(rank: string): number {
  if (rank === '7') return 0
  if (rank === '8') return 1
  if (rank === '9') return 2
  if (rank === 'J') return 3
  if (rank === 'Q') return 4
  if (rank === 'K') return 5
  if (rank === '10') return 6
  if (rank === 'A') return 7
  return 99
}

function getRankSortOrder(card: ViewCard, viewState: BottomHandViewState): number {
  const rank = readCardRank(card)
  const suit = readCardSuit(card)
  const contract = viewState.sortMode?.contract ?? 'unknown'
  const trumpSuit = viewState.sortMode?.trumpSuit ?? null

  if (contract === 'all-trumps') {
    return getAllTrumpsRankSortOrder(rank)
  }

  if (contract === 'no-trumps') {
    return getNoTrumpsRankSortOrder(rank)
  }

  if (contract === 'suit') {
    if (trumpSuit && suit === trumpSuit) {
      return getAllTrumpsRankSortOrder(rank)
    }

    return getNoTrumpsRankSortOrder(rank)
  }

  return getAllTrumpsRankSortOrder(rank)
}

function getSortedCards(
  cards: ViewCard[],
  viewState: BottomHandViewState
): SortedHandCard[] {
  return cards
    .map((card, originalIndex) => ({
      card,
      originalIndex,
    }))
    .sort((left, right) => {
      const suitOrderDiff =
        getSuitSortOrder(readCardSuit(left.card)) - getSuitSortOrder(readCardSuit(right.card))

      if (suitOrderDiff !== 0) {
        return suitOrderDiff
      }

      const rankOrderDiff =
        getRankSortOrder(left.card, viewState) - getRankSortOrder(right.card, viewState)

      if (rankOrderDiff !== 0) {
        return rankOrderDiff
      }

      return left.originalIndex - right.originalIndex
    })
}

function getFanDistance(index: number, visibleCount: number): number {
  return index - (visibleCount - 1) / 2
}

function getBottomCardTransform(distance: number): string {
  const distanceAbs = Math.abs(distance)

  return `translateX(calc(-50% + ${distance * 58}px)) translateY(${distanceAbs * 5}px) rotate(${distance * 7}deg)`
}

function getHoveredBottomCardTransform(distance: number): string {
  const distanceAbs = Math.abs(distance)

  return `translateX(calc(-50% + ${distance * 58}px)) translateY(${distanceAbs * 5 - 16}px) rotate(${distance * 7}deg)`
}

function getDealOrder(dealerSeat: Seat | null): Seat[] {
  if (!dealerSeat) {
    return ['right', 'top', 'left', 'bottom']
  }

  const dealerIndex = SEAT_ORDER.indexOf(dealerSeat)

  if (dealerIndex === -1) {
    return ['right', 'top', 'left', 'bottom']
  }

  return [
    SEAT_ORDER[(dealerIndex + 1) % SEAT_ORDER.length],
    SEAT_ORDER[(dealerIndex + 2) % SEAT_ORDER.length],
    SEAT_ORDER[(dealerIndex + 3) % SEAT_ORDER.length],
    SEAT_ORDER[(dealerIndex + 4) % SEAT_ORDER.length],
  ]
}

function getBottomRevealDelayMs(dealerSeat: Seat | null): number {
  const dealOrder = getDealOrder(dealerSeat)
  const seatIndex = dealOrder.indexOf('bottom')

  if (seatIndex === -1) {
    return DEAL_PACKET_START_DELAY + DEAL_PACKET_DURATION
  }

  return DEAL_PACKET_START_DELAY + seatIndex * DEAL_PACKET_DELAY_STEP + DEAL_PACKET_DURATION
}

function isDealPhase(viewState: BottomHandViewState): boolean {
  return (
    viewState.phase === 'deal-first-3' ||
    viewState.phase === 'deal-next-2' ||
    viewState.phase === 'deal-last-3'
  )
}

function getStableVisibleCountBeforeCurrentPacket(viewState: BottomHandViewState): number {
  if (viewState.phase === 'deal-first-3') {
    return 0
  }

  if (viewState.phase === 'deal-next-2') {
    return 3
  }

  if (viewState.phase === 'deal-last-3') {
    return 5
  }

  return viewState.cards?.length ?? 0
}

function isExistingCardBeforeCurrentPacket(
  viewState: BottomHandViewState,
  originalIndex: number
): boolean {
  return originalIndex < getStableVisibleCountBeforeCurrentPacket(viewState)
}

function shouldAnimateCardReveal(
  viewState: BottomHandViewState,
  originalIndex: number
): boolean {
  if (viewState.phase === 'deal-first-3') {
    return originalIndex < 3
  }

  if (viewState.phase === 'deal-next-2') {
    return originalIndex >= 3
  }

  if (viewState.phase === 'deal-last-3') {
    return originalIndex >= 5
  }

  return false
}

function getCardRevealAnimationStyle(
  viewState: BottomHandViewState,
  originalIndex: number
): string {
  if (!shouldAnimateCardReveal(viewState, originalIndex)) {
    return ''
  }

  const revealDelayMs = getBottomRevealDelayMs(viewState.dealerSeat)

  return `opacity:0; animation: belot-bottom-hand-reveal 120ms ease ${revealDelayMs}ms forwards;`
}

function getStableDisplayIndexMap(
  sortedCards: SortedHandCard[],
  viewState: BottomHandViewState
): Map<string, number> {
  const stableCards = sortedCards.filter((sortedCard) =>
    isExistingCardBeforeCurrentPacket(viewState, sortedCard.originalIndex)
  )

  const result = new Map<string, number>()

  stableCards.forEach((sortedCard, stableIndex) => {
    result.set(readCardId(sortedCard.card, sortedCard.originalIndex), stableIndex)
  })

  return result
}

function getInitialBottomCardTransform(
  sortedCard: SortedHandCard,
  displayIndex: number,
  visibleCount: number,
  viewState: BottomHandViewState,
  stableDisplayIndexMap: Map<string, number>
): string {
  const finalDistance = getFanDistance(displayIndex, visibleCount)
  const finalTransform = getBottomCardTransform(finalDistance)

  if (!isDealPhase(viewState)) {
    return finalTransform
  }

  if (!isExistingCardBeforeCurrentPacket(viewState, sortedCard.originalIndex)) {
    return finalTransform
  }

  const stableVisibleCount = getStableVisibleCountBeforeCurrentPacket(viewState)

  if (stableVisibleCount <= 0) {
    return finalTransform
  }

  const cardId = readCardId(sortedCard.card, sortedCard.originalIndex)
  const stableDisplayIndex = stableDisplayIndexMap.get(cardId)

  if (stableDisplayIndex === undefined) {
    return finalTransform
  }

  const stableDistance = getFanDistance(stableDisplayIndex, stableVisibleCount)
  return getBottomCardTransform(stableDistance)
}

function getCardShiftAnimationStyle(
  sortedCard: SortedHandCard,
  displayIndex: number,
  visibleCount: number,
  viewState: BottomHandViewState,
  stableDisplayIndexMap: Map<string, number>
): string {
  if (!isDealPhase(viewState)) {
    return ''
  }

  if (!isExistingCardBeforeCurrentPacket(viewState, sortedCard.originalIndex)) {
    return ''
  }

  const stableVisibleCount = getStableVisibleCountBeforeCurrentPacket(viewState)

  if (stableVisibleCount <= 0) {
    return ''
  }

  const cardId = readCardId(sortedCard.card, sortedCard.originalIndex)
  const stableDisplayIndex = stableDisplayIndexMap.get(cardId)

  if (stableDisplayIndex === undefined) {
    return ''
  }

  const fromTransform = getBottomCardTransform(
    getFanDistance(stableDisplayIndex, stableVisibleCount)
  )

  const toTransform = getBottomCardTransform(getFanDistance(displayIndex, visibleCount))

  if (fromTransform === toTransform) {
    return ''
  }

  const revealDelayMs = getBottomRevealDelayMs(viewState.dealerSeat)

  return `
    --belot-hand-from-transform:${fromTransform};
    --belot-hand-to-transform:${toTransform};
    animation: belot-bottom-hand-shift 150ms cubic-bezier(0.22, 1, 0.36, 1) ${revealDelayMs}ms forwards;
  `
}

function buildPlayCardPointerDown(cardId: string, distance: number, isPlayable: boolean): string {
  if (!isPlayable) {
    return ''
  }

  const startRotate = distance * 7
  const safeCardId = escapeJsString(cardId)

  return `
    if (this.dataset.flightLocked === '1') return;
    this.dataset.flightLocked = '1';
    this.dataset.cardId = '${safeCardId}';

    var oldClone = document.querySelector('[data-flying-play-card="bottom"]');
    if (oldClone) oldClone.remove();

    var rect = this.getBoundingClientRect();
    var clone = this.cloneNode(true);
    var target = document.querySelector('[data-play-target-seat="bottom"]');

    clone.setAttribute('data-flying-play-card', 'bottom');
    clone.style.position = 'fixed';
    clone.style.left = rect.left + 'px';
    clone.style.top = rect.top + 'px';
    clone.style.width = rect.width + 'px';
    clone.style.height = rect.height + 'px';
    clone.style.margin = '0';
    clone.style.inset = 'auto';
    clone.style.zIndex = '9999';
    clone.style.pointerEvents = 'none';
    clone.style.transform = 'rotate(${startRotate}deg)';
    clone.style.transformOrigin = 'center center';
    clone.style.transition = 'transform 440ms cubic-bezier(0.22, 1, 0.36, 1), box-shadow 440ms ease, filter 440ms ease, opacity 180ms ease';
    clone.style.boxShadow = '0 20px 36px rgba(0,0,0,0.28)';
    clone.style.filter = 'brightness(1.04)';

    document.body.appendChild(clone);

    this.style.opacity = '0.15';

    var targetLeft = window.innerWidth / 2 - rect.width / 2;
    var targetTop = window.innerHeight / 2 - rect.height / 2 + 18;
    var targetScale = 0.66;

    if (target) {
      var targetRect = target.getBoundingClientRect();
      targetLeft = targetRect.left;
      targetTop = targetRect.top;
      targetScale = targetRect.width / rect.width;
    }

    var deltaX = targetLeft - rect.left;
    var deltaY = targetTop - rect.top;

    requestAnimationFrame(function () {
      clone.style.transform =
        'translate(' + deltaX + 'px, ' + deltaY + 'px) rotate(0deg) scale(' + targetScale + ')';
    });

    setTimeout(function () {
      clone.style.opacity = '0';
    }, 430);

    setTimeout(function () {
      if (clone && clone.parentNode) {
        clone.parentNode.removeChild(clone);
      }
    }, 620);
  `
}

function renderHandCard(
  sortedCard: SortedHandCard,
  displayIndex: number,
  visibleCount: number,
  viewState: BottomHandViewState,
  stableDisplayIndexMap: Map<string, number>
): string {
  const card = sortedCard.card
  const rank = escapeHtml(readCardRank(card))
  const suit = readCardSuit(card)
  const suitSymbol = escapeHtml(getSuitSymbol(suit))
  const rawCardId = readCardId(card, sortedCard.originalIndex)
  const cardId = escapeHtml(rawCardId)
  const cardColor = isRedSuit(suit) ? '#b3261e' : '#13253d'
  const distance = getFanDistance(displayIndex, visibleCount)
  const finalTransform = getBottomCardTransform(distance)
  const initialTransform = getInitialBottomCardTransform(
    sortedCard,
    displayIndex,
    visibleCount,
    viewState,
    stableDisplayIndexMap
  )
  const revealAnimationStyle = getCardRevealAnimationStyle(viewState, sortedCard.originalIndex)
  const shiftAnimationStyle = getCardShiftAnimationStyle(
    sortedCard,
    displayIndex,
    visibleCount,
    viewState,
    stableDisplayIndexMap
  )
  const isInteractive = viewState.phase === 'playing'
  const isPlayable = readCardPlayable(card)
  const hoveredTransform = getHoveredBottomCardTransform(distance)

  return `
    <button
      type="button"
      ${isPlayable ? `data-action="play-card" data-card-id="${cardId}"` : ''}
      style="
        position:absolute;
        left:50%;
        top:0;
        width:170px;
        height:250px;
        padding:0;
        border:none;
        outline:none;
        border-radius:12px;
        transform:${initialTransform};
        transform-origin:center 90%;
        background:transparent;
        cursor:${isPlayable ? 'pointer' : 'default'};
        pointer-events:${isInteractive ? 'auto' : 'none'};
        box-shadow:0 12px 24px rgba(0,0,0,0.18);
        overflow:visible;
        z-index:${100 + displayIndex};
        transition:transform 140ms ease, box-shadow 140ms ease, filter 140ms ease, opacity 120ms ease;
        ${revealAnimationStyle}
        ${shiftAnimationStyle}
      "
      onpointerenter="${isPlayable ? `this.style.transform='${hoveredTransform}'; this.style.boxShadow='0 18px 30px rgba(0,0,0,0.24)'; this.style.filter='brightness(1.02)';` : ''}"
      onpointerleave="${isPlayable ? `this.style.transform='${finalTransform}'; this.style.boxShadow='0 12px 24px rgba(0,0,0,0.18)'; this.style.filter='brightness(1)';` : ''}"
      onpointerdown="${buildPlayCardPointerDown(rawCardId, distance, isPlayable)}"
    >
      <div
        style="
          position:absolute;
          inset:0;
          border-radius:12px;
          background:linear-gradient(180deg, rgba(255,255,255,0.99) 0%, rgba(240,244,250,0.99) 100%);
          box-shadow:
            inset 0 1px 0 rgba(255,255,255,0.95),
            inset 0 -1px 0 rgba(0,0,0,0.05);
        "
      ></div>

      <div
        style="
          position:absolute;
          inset:5px;
          border-radius:9px;
          border:1px solid rgba(20,49,84,0.14);
          background:linear-gradient(180deg, rgba(255,255,255,0.94) 0%, rgba(248,250,253,0.94) 100%);
        "
      ></div>

      <div
        style="
          position:absolute;
          left:10px;
          top:8px;
          display:flex;
          flex-direction:column;
          align-items:center;
          gap:2px;
          color:${cardColor};
          line-height:1;
        "
      >
        <span
          style="
            font-size:20px;
            font-weight:900;
            letter-spacing:0.02em;
          "
        >
          ${rank}
        </span>
        <span
          style="
            font-size:18px;
            font-weight:900;
          "
        >
          ${suitSymbol}
        </span>
      </div>

      <div
        style="
          position:absolute;
          right:10px;
          bottom:8px;
          display:flex;
          flex-direction:column;
          align-items:center;
          gap:2px;
          color:${cardColor};
          line-height:1;
          transform:rotate(180deg);
        "
      >
        <span
          style="
            font-size:20px;
            font-weight:900;
            letter-spacing:0.02em;
          "
        >
          ${rank}
        </span>
        <span
          style="
            font-size:18px;
            font-weight:900;
          "
        >
          ${suitSymbol}
        </span>
      </div>

      <div
        style="
          position:absolute;
          left:50%;
          top:50%;
          transform:translate(-50%, -50%);
          color:${cardColor};
          font-size:54px;
          line-height:1;
          font-weight:900;
          text-shadow:0 2px 6px rgba(0,0,0,0.08);
        "
      >
        ${suitSymbol}
      </div>
    </button>
  `
}

export function renderBottomHandPanel(viewState: BottomHandViewState): string {
  const sortedCards = getSortedCards(viewState.cards ?? [], viewState)

  if (sortedCards.length === 0) {
    return ''
  }

  const stableDisplayIndexMap = getStableDisplayIndexMap(sortedCards, viewState)

  return `
    <style>
      @keyframes belot-bottom-hand-reveal {
        0% {
          opacity: 0;
        }
        100% {
          opacity: 1;
        }
      }

      @keyframes belot-bottom-hand-shift {
        0% {
          transform: var(--belot-hand-from-transform);
        }
        100% {
          transform: var(--belot-hand-to-transform);
        }
      }
    </style>

    <div
      data-bottom-hand-root="1"
      style="
        position:relative;
        width:100%;
        height:260px;
        overflow:visible;
        pointer-events:none;
      "
    >
      <div
        style="
          position:absolute;
          inset:0;
          overflow:visible;
          pointer-events:${viewState.phase === 'playing' ? 'auto' : 'none'};
        "
      >
        ${sortedCards
          .map((card, index) =>
            renderHandCard(card, index, sortedCards.length, viewState, stableDisplayIndexMap)
          )
          .join('')}
      </div>
    </div>
  `
}