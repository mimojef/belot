import type { RoomCardSnapshot, RoomSeatSnapshot, Seat } from '../../network/createGameServerClient'
import { CARD_BACK_IMAGE_PATH, getCardFaceImagePath } from '../cardImageAssets'
import {
  CUTTING_VISUAL_SEAT_INITIALS,
  CUTTING_VISUAL_SEAT_LABELS,
  SEAT_ORDER,
  createEmptySeatSnapshot,
  getCuttingSeatPanelAnchorStyle,
  getVisualSeatForLocalPerspective,
} from './cuttingSeatLayout'
import { CUTTING_COUNTDOWN_MS } from './cuttingVisualCountdown'

type EscapeHtml = (value: string) => string

function renderLevelBadge(level: number | null | undefined): string {
  if (typeof level !== 'number' || !Number.isFinite(level) || level < 1) return ''
  return `<div style="position:absolute;right:4px;bottom:4px;min-width:20px;height:20px;border-radius:999px;background:#000000;display:flex;align-items:center;justify-content:center;padding:0 3px;line-height:1;z-index:10;color:#ffffff;font-size:11px;font-weight:700;">${Math.trunc(level)}</div>`
}

export type DealtHandsData = {
  handCounts: Record<Seat, number>
  ownHand: RoomCardSnapshot[]
  previousOwnHand: RoomCardSnapshot[] | null
  localSeat: Seat
  seatAnimDelays: Partial<Record<Seat, number>> | null
  hideNewCardsUntilAnimDelaySeats?: Partial<Record<Seat, boolean>>
  replaceLocalHandAtRevealSeats?: Partial<Record<Seat, boolean>>
  maxCardsPerSeat: number
  animStartIndex: number
}

export type SeatBidBubble = {
  label: string
  elapsedMs: number
}

export type SeatDeclarationBubble = {
  lines: string[]
}

export type SeatEmojiBubble = {
  emojiId: string
  elapsedMs: number
}

export type RenderCuttingSeatPanelsOptions = {
  seats: RoomSeatSnapshot[]
  localSeat: Seat
  dealerSeat: Seat | null
  cutterSeat: Seat | null
  cuttingCountdownRemainingMs: number | null
  countdownSeat?: Seat | null
  countdownRemainingMs?: number | null
  countdownTotalMs?: number
  countdownKey?: string | null
  highlightSeat?: Seat | null
  highlightBadgeLabel?: string | null
  panelScale: number
  escapeHtml: EscapeHtml
  dealtHands: DealtHandsData | null
  bidBubbles: Partial<Record<Seat, SeatBidBubble>> | null
  declarationBubbles?: Partial<Record<Seat, SeatDeclarationBubble>> | null
  emojiBubbles?: Partial<Record<Seat, SeatEmojiBubble>> | null
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function renderCuttingCountdownFillStyle(
  shouldShowCuttingCountdown: boolean,
  cuttingCountdownRemainingMs: number | null,
  countdownTotalMs: number,
): string {
  if (!shouldShowCuttingCountdown || cuttingCountdownRemainingMs === null) {
    return 'opacity:0; transform:scaleX(0);'
  }

  const remainingMs = clamp(cuttingCountdownRemainingMs, 0, countdownTotalMs)
  const elapsedMs = countdownTotalMs - remainingMs

  return `
    opacity:1;
    animation: belot-active-room-cutting-countdown ${countdownTotalMs}ms linear forwards;
    animation-delay:-${elapsedMs}ms;
    animation-fill-mode:both;
  `
}

function getCountdownActiveFlag(
  shouldShowCuttingCountdown: boolean,
  cuttingCountdownRemainingMs: number | null,
): string {
  return shouldShowCuttingCountdown && cuttingCountdownRemainingMs !== null ? '1' : '0'
}

export function renderCuttingDealerBadge(
  visualSeat: Seat,
  dealerSeat: Seat | null,
  actualSeat: Seat,
): string {
  if (dealerSeat !== actualSeat) {
    return ''
  }

  const horizontalAnchor =
    visualSeat === 'right'
      ? 'left:-12px;'
      : 'right:-12px;'
  const bottomOffset = visualSeat === 'bottom' ? '0;' : '-12px;'

  return `
    <div
      style="
        position:absolute;
        ${horizontalAnchor}
        bottom:${bottomOffset}
        width:28px;
        height:28px;
        display:inline-flex;
        align-items:center;
        justify-content:center;
        border-radius:999px;
        background:rgba(245, 187, 55, 0.98);
        color:#13253d;
        font-size:14px;
        font-weight:900;
        box-shadow:0 6px 14px rgba(0,0,0,0.22);
        z-index:25;
        pointer-events:none;
      "
    >
      D
    </div>
  `
}

export function renderBottomCuttingCountdownBar(
  shouldShowCuttingCountdown: boolean,
  cuttingCountdownRemainingMs: number | null,
  countdownTotalMs: number,
  seatId: Seat,
  countdownKey: string,
): string {
  return `
    <div
      style="
        position:absolute;
        left:148px;
        right:18px;
        bottom:10px;
        height:18px;
        border-radius:6px;
        overflow:hidden;
        background:rgba(10,10,10,0.94);
        box-shadow:
          inset 0 1px 0 rgba(255,255,255,0.08),
          0 4px 10px rgba(0,0,0,0.18);
      "
    >
      <div
        data-seat-countdown-fill="${seatId}"
        data-countdown-key="${countdownKey}"
        data-countdown-active="${getCountdownActiveFlag(
          shouldShowCuttingCountdown,
          cuttingCountdownRemainingMs,
        )}"
        style="
          position:absolute;
          inset:0;
          border-radius:6px;
          background:linear-gradient(90deg, rgba(245, 187, 55, 0.98) 0%, rgba(255, 166, 0, 0.98) 100%);
          box-shadow:
            inset 0 1px 0 rgba(255,255,255,0.22),
            0 0 10px rgba(245, 187, 55, 0.26);
          transform-origin:left center;
          ${renderCuttingCountdownFillStyle(
            shouldShowCuttingCountdown,
            cuttingCountdownRemainingMs,
            countdownTotalMs,
          )}
        "
      ></div>
    </div>
  `
}

export function renderSideCuttingCountdownFooter(
  labelText: string,
  shouldShowCuttingCountdown: boolean,
  cuttingCountdownRemainingMs: number | null,
  countdownTotalMs: number,
  seatId: Seat,
  escapeHtml: EscapeHtml,
  countdownKey: string,
): string {
  return `
    <div
      style="
        position:absolute;
        left:0;
        right:0;
        bottom:0;
        min-height:52px;
        background:rgba(10,10,10,0.94);
        border-top:1px solid rgba(220,163,58,0.36);
        overflow:hidden;
      "
    >
      <div
        data-seat-countdown-fill="${seatId}"
        data-countdown-key="${countdownKey}"
        data-countdown-active="${getCountdownActiveFlag(
          shouldShowCuttingCountdown,
          cuttingCountdownRemainingMs,
        )}"
        style="
          position:absolute;
          inset:0;
          background:linear-gradient(90deg, rgba(245, 187, 55, 0.98) 0%, rgba(255, 166, 0, 0.98) 100%);
          box-shadow:
            inset 0 1px 0 rgba(255,255,255,0.18),
            0 0 12px rgba(245, 187, 55, 0.24);
          transform-origin:left center;
          ${renderCuttingCountdownFillStyle(
            shouldShowCuttingCountdown,
            cuttingCountdownRemainingMs,
            countdownTotalMs,
          )}
        "
      ></div>

      <div
        style="
          position:relative;
          z-index:2;
          min-height:52px;
          padding:13px 14px 14px;
          color:#f4f8ff;
          text-align:center;
          font-size:18px;
          font-weight:900;
          letter-spacing:0.03em;
          line-height:1.1;
          text-shadow:0 1px 4px rgba(0,0,0,0.35);
          white-space:nowrap;
          overflow:hidden;
          text-overflow:ellipsis;
        "
      >
        ${escapeHtml(labelText)}
      </div>
    </div>
  `
}

export function getCuttingSeatAvatarFallback(
  seat: RoomSeatSnapshot,
  visualSeat: Seat,
  escapeHtml: EscapeHtml,
): string {
  const trimmedName = seat.displayName.trim()

  if (trimmedName.length > 0) {
    return escapeHtml(trimmedName.charAt(0).toUpperCase())
  }

  return CUTTING_VISUAL_SEAT_INITIALS[visualSeat]
}

export function renderCuttingSeatAvatar(
  seat: RoomSeatSnapshot,
  visualSeat: Seat,
  imageBorderRadiusPx: number,
  escapeHtml: EscapeHtml,
): string {
  const displayName =
    seat.isOccupied && seat.displayName.trim().length > 0
      ? seat.displayName
      : CUTTING_VISUAL_SEAT_LABELS[visualSeat]

  if (seat.avatarUrl) {
    return `
      <img
        src="${escapeHtml(seat.avatarUrl)}"
        alt="${escapeHtml(displayName)}"
        style="
          width:100%;
          height:100%;
          object-fit:cover;
          border-radius:${imageBorderRadiusPx}px;
          display:block;
        "
      />
    `
  }

  return getCuttingSeatAvatarFallback(seat, visualSeat, escapeHtml)
}

const PANEL_CARD_WIDTH = 195
const PANEL_CARD_HEIGHT = 284
const PANEL_CARD_REVEAL_MS = 120
const PANEL_CARD_REPOSITION_MS = 150
const PANEL_CARD_REVEAL_EASING = 'ease'
const PANEL_CARD_REPOSITION_EASING = 'cubic-bezier(0.22,1,0.36,1)'

function renderPanelCardBack(): string {
  return `
    <span style="position:absolute;inset:0;border-radius:16px;background:linear-gradient(180deg,rgba(255,255,255,0.98) 0%,rgba(241,245,249,0.98) 100%);"></span>
    <span style="position:absolute;inset:11px;border-radius:12px;border:1px solid rgba(15,23,42,0.10);background-image:url('${CARD_BACK_IMAGE_PATH}');background-size:cover;background-position:center;background-repeat:no-repeat;"></span>
  `
}

function renderPanelCardFront(card: RoomCardSnapshot): string {
  return `
    <img
      src="${getCardFaceImagePath(card)}"
      alt=""
      draggable="false"
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
  `
}

function renderPanelDealtCard(
  card: RoomCardSnapshot | null,
  index: number,
  offsetX: number,
  offsetY: number,
  rotate: number,
  animStyle: string,
): string {
  const content = card !== null ? renderPanelCardFront(card) : renderPanelCardBack()
  return `
    <div style="
      position:absolute;
      left:50%;
      top:50%;
      width:${PANEL_CARD_WIDTH}px;
      height:${PANEL_CARD_HEIGHT}px;
      border-radius:16px;
      border:1px solid rgba(255,255,255,0.24);
      box-shadow:0 8px 18px rgba(0,0,0,0.22);
      overflow:hidden;
      transform:translate(-50%,-50%) translate(${offsetX}px,${offsetY}px) rotate(${rotate}deg);
      will-change:transform, opacity;
      backface-visibility:hidden;
      transform-style:preserve-3d;
      z-index:${index + 1};
      pointer-events:none;
      ${animStyle}
    ">
      ${content}
    </div>
  `
}

function getFanOffset(
  index: number,
  count: number,
): { x: number; y: number; rotate: number } {
  const centered = index - (count - 1) / 2
  const maxCentered = Math.max(1, (count - 1) / 2)
  const edgeProgress = Math.abs(centered) / maxCentered
  const countProgress = Math.min(1, Math.max(0, (count - 1) / 7))
  const edgeDrop = edgeProgress * edgeProgress * 34 * countProgress
  return {
    x: centered * 62,
    y: edgeDrop,
    rotate: centered * 5,
  }
}

function renderPanelCardFanWrapper(
  actualSeat: Seat,
  visualSeat: Seat,
  cardElements: string,
): string {
  let fanCenterX: number
  let fanCenterY: number

  let fanRotateDeg = 0

  if (visualSeat === 'bottom') {
    fanCenterX = 180
    fanCenterY = 50
    fanRotateDeg = 0
  } else if (visualSeat === 'top') {
    fanCenterX = 93
    fanCenterY = 234 + PANEL_CARD_HEIGHT / 2 + 8 - 300
    fanRotateDeg = 180
  } else if (visualSeat === 'left') {
    fanCenterX = 186 + PANEL_CARD_WIDTH / 2 + 12 - 200
    fanCenterY = 117
    fanRotateDeg = 90
  } else {
    fanCenterX = -(PANEL_CARD_WIDTH / 2 + 12) + 200
    fanCenterY = 117
    fanRotateDeg = -90
  }

  const rotateStyle = fanRotateDeg !== 0 ? `rotate: ${fanRotateDeg}deg;` : ''

  return `
    <div
      data-active-room-seat-card-fan="${actualSeat}"
      style="
      position:absolute;
      left:${fanCenterX}px;
      top:${fanCenterY}px;
      width:1px;
      height:1px;
      pointer-events:none;
      z-index:1;
      ${rotateStyle}
    ">
      ${cardElements}
    </div>
  `
}

function renderDealtCardFanInPanel(
  actualSeat: Seat,
  visualSeat: Seat,
  dealtHands: DealtHandsData,
): string {
  const count = Math.min(dealtHands.maxCardsPerSeat, Math.max(0, dealtHands.handCounts[actualSeat] ?? 0))
  if (count === 0) return ''

  const isLocalSeat = actualSeat === dealtHands.localSeat
  const cards = isLocalSeat ? dealtHands.ownHand.slice(0, count) : []

  const animDelay = dealtHands.seatAnimDelays?.[actualSeat] ?? null
  const shouldHardHideNewCardsUntilDelay =
    dealtHands.hideNewCardsUntilAnimDelaySeats?.[actualSeat] === true
  const shouldReplaceLocalHandAtReveal =
    dealtHands.replaceLocalHandAtRevealSeats?.[actualSeat] === true

  const previousCards = isLocalSeat && dealtHands.previousOwnHand ? dealtHands.previousOwnHand : []
  const previousIndexById = new Map(previousCards.map((c, idx) => [c.id, idx]))

  if (
    isLocalSeat &&
    animDelay !== null &&
    shouldReplaceLocalHandAtReveal &&
    previousCards.length > 0
  ) {
    const previousCardElements = previousCards.map((card, i) => {
      const fan = getFanOffset(i, previousCards.length)
      const animStyle = `animation: belot-panel-card-hide-at-reveal 1ms linear ${animDelay}ms both;`
      return renderPanelDealtCard(card, i, fan.x, fan.y, fan.rotate, animStyle)
    }).join('')
    const finalCardElements = cards.map((card, i) => {
      const fan = getFanOffset(i, count)
      const isNewCard = !previousIndexById.has(card.id)
      const animStyle = isNewCard
        ? `opacity:0; visibility:hidden; animation: belot-panel-card-hidden-appear ${PANEL_CARD_REVEAL_MS}ms ${PANEL_CARD_REVEAL_EASING} ${animDelay}ms both;`
        : `opacity:0; visibility:hidden; animation: belot-panel-card-show-at-reveal 1ms linear ${animDelay}ms both;`
      return renderPanelDealtCard(card, i, fan.x, fan.y, fan.rotate, animStyle)
    }).join('')

    return renderPanelCardFanWrapper(
      actualSeat,
      visualSeat,
      `${previousCardElements}${finalCardElements}`,
    )
  }

  const cardElements = Array.from({ length: count }, (_, i) => {
    const fanTo = getFanOffset(i, count)
    const card = isLocalSeat ? (cards[i] ?? null) : null

    let animStyle = ''
    if (animDelay !== null) {
      if (isLocalSeat && card !== null) {
        const prevIdx = previousIndexById.get(card.id)
        if (prevIdx === undefined) {
          // New card — appears at its sorted position when packet arrives
          animStyle = shouldHardHideNewCardsUntilDelay
            ? `opacity:0; visibility:hidden; animation: belot-panel-card-hidden-appear ${PANEL_CARD_REVEAL_MS}ms ${PANEL_CARD_REVEAL_EASING} ${animDelay}ms both;`
            : `animation: belot-panel-card-appear ${PANEL_CARD_REVEAL_MS}ms ${PANEL_CARD_REVEAL_EASING} ${animDelay}ms both;`
        } else {
          // Existing card — repositions from its old sorted position to its new sorted position
          const fanFrom = getFanOffset(prevIdx, previousCards.length)
          animStyle = `
            --px-from:${fanFrom.x}px; --py-from:${fanFrom.y}px; --pr-from:${fanFrom.rotate}deg;
            --px-to:${fanTo.x}px; --py-to:${fanTo.y}px; --pr-to:${fanTo.rotate}deg;
            animation: belot-panel-card-reposition ${PANEL_CARD_REPOSITION_MS}ms ${PANEL_CARD_REPOSITION_EASING} ${animDelay}ms both;
          `
        }
      } else if (!isLocalSeat) {
        // Non-local seat: index-based logic (card backs, no face data)
        if (i >= dealtHands.animStartIndex) {
          animStyle = shouldHardHideNewCardsUntilDelay
            ? `opacity:0; visibility:hidden; animation: belot-panel-card-hidden-appear ${PANEL_CARD_REVEAL_MS}ms ${PANEL_CARD_REVEAL_EASING} ${animDelay}ms both;`
            : `animation: belot-panel-card-appear ${PANEL_CARD_REVEAL_MS}ms ${PANEL_CARD_REVEAL_EASING} ${animDelay}ms both;`
        } else {
          const fanFrom = getFanOffset(i, dealtHands.animStartIndex)
          animStyle = `
            --px-from:${fanFrom.x}px; --py-from:${fanFrom.y}px; --pr-from:${fanFrom.rotate}deg;
            --px-to:${fanTo.x}px; --py-to:${fanTo.y}px; --pr-to:${fanTo.rotate}deg;
            animation: belot-panel-card-reposition ${PANEL_CARD_REPOSITION_MS}ms ${PANEL_CARD_REPOSITION_EASING} ${animDelay}ms both;
          `
        }
      }
    }

    return renderPanelDealtCard(card, i, fanTo.x, fanTo.y, fanTo.rotate, animStyle)
  }).join('')

  // Fan center relative to each panel's anchor point (in unscaled panel coords)
  // Bottom panel: 360×138, center cards at right portion (x=248) above panel center (y=-60 from panel top = above panel)
  // Side panels: 186×234, cards float above panel top (y=-60)
  // Top panel: same as side but mirror
  let fanCenterX: number
  let fanCenterY: number

  let fanRotateDeg = 0

  if (visualSeat === 'bottom') {
    fanCenterX = 180
    fanCenterY = -PANEL_CARD_HEIGHT / 2 - 8 + 200
    fanRotateDeg = 0
  } else if (visualSeat === 'top') {
    fanCenterX = 93
    fanCenterY = 234 + PANEL_CARD_HEIGHT / 2 + 8 - 300
    fanRotateDeg = 180
  } else if (visualSeat === 'left') {
    fanCenterX = 186 + PANEL_CARD_WIDTH / 2 + 12 - 200
    fanCenterY = 117
    fanRotateDeg = 90
  } else {
    fanCenterX = -(PANEL_CARD_WIDTH / 2 + 12) + 200
    fanCenterY = 117
    fanRotateDeg = -90
  }

  const rotateStyle = fanRotateDeg !== 0 ? `rotate: ${fanRotateDeg}deg;` : ''

  return `
    <div
      data-active-room-seat-card-fan="${actualSeat}"
      style="
      position:absolute;
      left:${fanCenterX}px;
      top:${fanCenterY}px;
      width:1px;
      height:1px;
      pointer-events:none;
      z-index:1;
      ${rotateStyle}
    ">
      ${cardElements}
    </div>
  `
}

const BID_BUBBLE_TOTAL_MS = 1500

function getBubblePlacement(
  visualSeat: Seat,
  offsetIndex: number,
): {
  wrapperStyle: string
  tailStyle: string
} {
  if (visualSeat === 'bottom') {
    const bottomPx = 156 + offsetIndex * 86
    return {
      wrapperStyle: `bottom:${bottomPx}px;left:50%;transform:translateX(-50%);`,
      tailStyle: `
        left:50%;
        bottom:0;
        width:24px;
        height:14px;
        clip-path:polygon(50% 100%, 0 0, 100% 0);
        transform:translate(-50%, 90%);
      `,
    }
  }

  if (visualSeat === 'top') {
    const topPx = 170 + offsetIndex * 72
    return {
      wrapperStyle: `left:202px;top:${topPx}px;transform:none;`,
      tailStyle: `
        left:0;
        top:50%;
        width:16px;
        height:24px;
        clip-path:polygon(0 50%, 100% 0, 100% 100%);
        transform:translate(-88%, -50%);
      `,
    }
  }

  if (visualSeat === 'left') {
    const topPx = 84 + offsetIndex * 72
    return {
      wrapperStyle: `left:202px;top:${topPx}px;transform:none;`,
      tailStyle: `
        left:0;
        top:50%;
        width:16px;
        height:24px;
        clip-path:polygon(0 50%, 100% 0, 100% 100%);
        transform:translate(-88%, -50%);
      `,
    }
  }

  const topPx = 84 + offsetIndex * 72
  return {
    wrapperStyle: `right:202px;top:${topPx}px;transform:none;`,
    tailStyle: `
      right:0;
      top:50%;
      width:16px;
      height:24px;
      clip-path:polygon(100% 50%, 0 0, 0 100%);
      transform:translate(88%, -50%);
    `,
  }
}

function renderBidBubble(
  visualSeat: Seat,
  bubble: SeatBidBubble,
  escapeHtml: EscapeHtml,
): string {
  const totalMs = BID_BUBBLE_TOTAL_MS
  const fadeInEnd = Math.round((160 / totalMs) * 100)
  const fadeOutStart = Math.round(((totalMs - 220) / totalMs) * 100)
  const keyframes = `@keyframes bbb-${visualSeat}{0%{opacity:0}${fadeInEnd}%{opacity:1}${fadeOutStart}%{opacity:1}100%{opacity:0}}`

  const { wrapperStyle, tailStyle } = getBubblePlacement(visualSeat, 0)

  const elapsed = Math.min(bubble.elapsedMs, totalMs)
  const bubbleBackground =
    'linear-gradient(180deg, rgba(255,255,255,0.99) 0%, rgba(246,248,252,0.97) 100%)'

  return `
    <style>${keyframes}</style>
    <div style="
      position:absolute;
      ${wrapperStyle}
      pointer-events:none;
      z-index:10;
      animation:bbb-${visualSeat} ${totalMs}ms ease-out forwards;
      animation-delay:-${elapsed}ms;
      animation-fill-mode:both;
    ">
      <div style="
        position:relative;
        border:1px solid rgba(15,23,42,0.10);
        border-radius:18px;
        padding:12px 20px;
        background:${bubbleBackground};
        color:#1e293b;
        font-size:26px;
        font-weight:800;
        line-height:1.1;
        white-space:nowrap;
        box-shadow:
          0 10px 22px rgba(15,23,42,0.16),
          0 3px 10px rgba(15,23,42,0.10);
      ">
        <div style="
          position:absolute;
          background:${bubbleBackground};
          box-shadow:0 4px 10px rgba(15,23,42,0.06);
          ${tailStyle}
        "></div>
        ${escapeHtml(bubble.label)}
      </div>
    </div>
  `
}

function renderDeclarationBubble(
  visualSeat: Seat,
  bubble: SeatDeclarationBubble,
  hasBidBubble: boolean,
  escapeHtml: EscapeHtml,
): string {
  if (bubble.lines.length === 0) {
    return ''
  }

  const { wrapperStyle, tailStyle } = getBubblePlacement(visualSeat, hasBidBubble ? 1 : 0)
  const bubbleBackground =
    'linear-gradient(180deg, rgba(255,255,255,0.99) 0%, rgba(246,248,252,0.97) 100%)'

  return `
    <div style="
      position:absolute;
      ${wrapperStyle}
      pointer-events:none;
      z-index:11;
    ">
      <div style="
        position:relative;
        min-width:124px;
        max-width:240px;
        border:1px solid rgba(15,23,42,0.10);
        border-radius:18px;
        padding:10px 16px;
        background:${bubbleBackground};
        color:#1e293b;
        font-size:22px;
        font-weight:850;
        line-height:1.14;
        text-align:center;
        white-space:normal;
        box-shadow:
          0 10px 22px rgba(15,23,42,0.16),
          0 3px 10px rgba(15,23,42,0.10);
      ">
        <div style="
          position:absolute;
          background:${bubbleBackground};
          box-shadow:0 4px 10px rgba(15,23,42,0.06);
          ${tailStyle}
        "></div>
        <div style="
          position:relative;
          z-index:2;
          display:flex;
          flex-direction:column;
          align-items:center;
          gap:4px;
        ">
          ${bubble.lines.map((line) => `<div>${escapeHtml(line)}</div>`).join('')}
        </div>
      </div>
    </div>
  `
}

const EMOJI_BUBBLE_TOTAL_MS = 4000

function renderEmojiBubble(
  visualSeat: Seat,
  bubble: SeatEmojiBubble,
  offsetIndex: number,
): string {
  const totalMs = EMOJI_BUBBLE_TOTAL_MS
  const fadeInEnd = Math.round((200 / totalMs) * 100)
  const fadeOutStart = Math.round(((totalMs - 400) / totalMs) * 100)
  const keyframes = `@keyframes emb-${visualSeat}-${offsetIndex}{0%{opacity:0}${fadeInEnd}%{opacity:1}${fadeOutStart}%{opacity:1}100%{opacity:0}}`

  const { wrapperStyle, tailStyle } = getBubblePlacement(visualSeat, offsetIndex)
  const elapsed = Math.min(bubble.elapsedMs, totalMs)
  const delay = -elapsed / 1000

  return `
    <style>${keyframes}</style>
    <div
      style="
        position:absolute;
        ${wrapperStyle}
        z-index:30;
        pointer-events:none;
        animation:emb-${visualSeat}-${offsetIndex} ${totalMs}ms linear both;
        animation-delay:${delay}s;
      "
    >
      <div
        style="
          position:relative;
          width:90px;
          height:90px;
          border-radius:50%;
          background:rgba(255,255,255,0.95);
          box-shadow:0 4px 16px rgba(0,0,0,0.22);
          display:flex;
          align-items:center;
          justify-content:center;
        "
      >
        <img
          src="/assets/animated-emoji/emoji-${bubble.emojiId}.webp"
          alt=""
          style="width:85px;height:85px;object-fit:contain;"
        >
        <div style="
          position:absolute;
          background:rgba(255,255,255,0.95);
          box-shadow:0 4px 10px rgba(15,23,42,0.06);
          ${tailStyle}
        "></div>
      </div>
    </div>
  `
}

export function createCuttingSeatPanelHtml(
  seat: RoomSeatSnapshot,
  visualSeat: Seat,
  dealerSeat: Seat | null,
  countdownSeat: Seat | null,
  countdownRemainingMs: number | null,
  countdownTotalMs: number,
  highlightSeat: Seat | null,
  highlightBadgeLabel: string | null,
  panelScale: number,
  escapeHtml: EscapeHtml,
  dealtHands: DealtHandsData | null,
  bidBubbles: Partial<Record<Seat, SeatBidBubble>> | null,
  declarationBubbles: Partial<Record<Seat, SeatDeclarationBubble>> | null,
  countdownKey: string,
  emojiBubbles: Partial<Record<Seat, SeatEmojiBubble>> | null,
): string {
  const isBottomSeat = visualSeat === 'bottom'
  const isCountdownSeat = seat.seat === countdownSeat
  const isHighlightedSeat = seat.seat === highlightSeat
  const shouldShowCuttingCountdown = isCountdownSeat
  const displayCountdownRemainingMs = countdownRemainingMs
  const displayName =
    seat.isOccupied && seat.displayName.trim().length > 0
      ? seat.displayName
      : 'Свободно място'
  const footerLabel =
    seat.isOccupied && displayName.trim().length > 0
      ? displayName
      : CUTTING_VISUAL_SEAT_LABELS[visualSeat]
  const borderColor = isHighlightedSeat ? 'rgba(245, 187, 55, 0.96)' : 'rgba(220,163,58,0.62)'
  const borderWidthPx = 2
  const shadow = isHighlightedSeat
    ? '0 0 0 2px rgba(245, 187, 55, 0.96), 0 0 24px rgba(245, 187, 55, 0.36), 0 16px 28px rgba(0,0,0,0.24)'
    : '0 14px 28px rgba(0,0,0,0.24)'
  const cutterBadgeHtml = isHighlightedSeat && highlightBadgeLabel
    ? `
        <div
          style="
            position:absolute;
            right:${isBottomSeat ? '10px' : '8px'};
            top:${isBottomSeat ? '10px' : '8px'};
            padding:${isBottomSeat ? '6px 10px' : '5px 9px'};
            border-radius:999px;
            background:rgba(245, 187, 55, 0.98);
            color:#13253d;
            font-size:${isBottomSeat ? '11px' : '10px'};
            font-weight:900;
            letter-spacing:0.08em;
            text-transform:uppercase;
            box-shadow:0 8px 16px rgba(0,0,0,0.18);
          "
        >
          ${escapeHtml(highlightBadgeLabel)}
        </div>
      `
    : ''

  const hasBidBubble = Boolean(bidBubbles?.[seat.seat])
  const bubbleHtml = bidBubbles?.[seat.seat]
    ? renderBidBubble(visualSeat, bidBubbles[seat.seat]!, escapeHtml)
    : ''
  const hasDeclarationBubble = Boolean(declarationBubbles?.[seat.seat]?.lines.length)
  const declarationBubbleHtml = declarationBubbles?.[seat.seat]
    ? renderDeclarationBubble(
        visualSeat,
        declarationBubbles[seat.seat]!,
        hasBidBubble,
        escapeHtml,
      )
    : ''
  const emojiOffsetIndex = (hasBidBubble ? 1 : 0) + (hasDeclarationBubble ? 1 : 0)
  const emojiBubbleHtml = emojiBubbles?.[seat.seat]
    ? renderEmojiBubble(visualSeat, emojiBubbles[seat.seat]!, emojiOffsetIndex)
    : ''

  if (isBottomSeat) {
    return `
      <div
        data-active-room-seat-anchor="${seat.seat}"
        data-seat-avatar-url="${escapeHtml(seat.avatarUrl ?? '')}"
        data-seat-highlighted="${isHighlightedSeat}"
        style="
          position:absolute;
          ${getCuttingSeatPanelAnchorStyle(visualSeat, panelScale)}
          z-index:4;
          pointer-events:none;
        "
      >
        <div data-seat-bid-bubble="${seat.seat}">${bubbleHtml}</div>
        <div data-seat-declaration-bubble="${seat.seat}">${declarationBubbleHtml}</div>
        <div data-seat-emoji-bubble="${seat.seat}">${emojiBubbleHtml}</div>
        ${dealtHands ? renderDealtCardFanInPanel(seat.seat, visualSeat, dealtHands) : ''}
        <div
          style="
            position:relative;
            width:360px;
            height:138px;
            box-sizing:border-box;
            border-radius:20px;
            border:${borderWidthPx}px solid ${borderColor};
            background:
              radial-gradient(circle at 22% 22%, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.025) 18%, rgba(255,255,255,0.0) 40%),
              linear-gradient(180deg, rgba(34,34,34,0.97) 0%, rgba(18,18,18,0.98) 54%, rgba(8,8,8,0.99) 100%);
            box-shadow:${shadow};
            overflow:hidden;
            z-index:${dealtHands ? 20 : 2};
            transform:scale(0.8);
            transform-origin:bottom center;
          "
        >
          <div
            data-profile-seat-btn="${seat.seat}"
            style="
              position:absolute;
              left:4px;
              top:4px;
              bottom:4px;
              width:122px;
              border-radius:18px;
              background:
                linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(232,240,248,0.98) 100%);
              box-shadow:
                inset 0 1px 0 rgba(255,255,255,0.8),
                0 10px 18px rgba(0,0,0,0.18);
              display:flex;
              align-items:center;
              justify-content:center;
              color:#16314f;
              font-size:45px;
              font-weight:900;
              letter-spacing:0.04em;
              cursor:pointer;
              pointer-events:auto;
            "
          >
            ${renderCuttingSeatAvatar(seat, visualSeat, 18, escapeHtml)}
            ${renderLevelBadge(seat.level)}
          </div>

          <div
            style="
              position:absolute;
              left:148px;
              top:17px;
              color:#f4f8ff;
              font-size:25px;
              font-weight:900;
              letter-spacing:0.03em;
              line-height:1;
              text-transform:uppercase;
              text-shadow:0 2px 8px rgba(0,0,0,0.22);
            "
          >
            ${CUTTING_VISUAL_SEAT_LABELS[visualSeat]}
          </div>

          <div
            style="
              position:absolute;
              left:148px;
              right:18px;
              top:58px;
              color:#f8fafc;
              font-size:22px;
              font-weight:800;
              line-height:1.1;
              white-space:nowrap;
              overflow:hidden;
              text-overflow:ellipsis;
            "
          >
            ${escapeHtml(displayName)}
          </div>

          ${renderBottomCuttingCountdownBar(
            shouldShowCuttingCountdown,
            displayCountdownRemainingMs,
            countdownTotalMs,
            seat.seat,
            countdownKey,
          )}
          ${cutterBadgeHtml}
        </div>
        ${renderCuttingDealerBadge(visualSeat, dealerSeat, seat.seat)}
      </div>
    `
  }

  return `
    <div
      data-active-room-seat-anchor="${seat.seat}"
      data-seat-avatar-url="${escapeHtml(seat.avatarUrl ?? '')}"
      data-seat-highlighted="${isHighlightedSeat}"
      style="
        position:absolute;
        ${getCuttingSeatPanelAnchorStyle(visualSeat, panelScale)}
        z-index:4;
        pointer-events:none;
      "
    >
      <div data-seat-bid-bubble="${seat.seat}">${bubbleHtml}</div>
      <div data-seat-declaration-bubble="${seat.seat}">${declarationBubbleHtml}</div>
      <div data-seat-emoji-bubble="${seat.seat}">${emojiBubbleHtml}</div>
      ${dealtHands ? renderDealtCardFanInPanel(seat.seat, visualSeat, dealtHands) : ''}
      <div
        style="
          position:relative;
          width:186px;
          height:234px;
          border-radius:18px;
          border:${borderWidthPx}px solid ${borderColor};
          background:
            radial-gradient(circle at 35% 30%, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.025) 18%, rgba(255,255,255,0.0) 40%),
            linear-gradient(180deg, rgba(34,34,34,0.97) 0%, rgba(18,18,18,0.98) 52%, rgba(8,8,8,0.99) 100%);
          box-shadow:${shadow};
          overflow:hidden;
          z-index:2;
          transform:scale(0.9);
          transform-origin:${visualSeat === 'top' ? 'top center' : visualSeat === 'left' ? 'left center' : 'right center'};
        "
      >
        <div
          data-profile-seat-btn="${seat.seat}"
          style="
            position:absolute;
            top:8px;
            left:8px;
            right:8px;
            bottom:64px;
            border-radius:16px;
            background:
              linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(232,240,248,0.98) 100%);
            box-shadow:
              inset 0 1px 0 rgba(255,255,255,0.8),
              0 10px 18px rgba(0,0,0,0.18);
            display:flex;
            align-items:center;
            justify-content:center;
            color:#16314f;
            font-size:56px;
            font-weight:900;
            letter-spacing:0.04em;
            cursor:pointer;
            pointer-events:auto;
          "
        >
          ${renderCuttingSeatAvatar(seat, visualSeat, 16, escapeHtml)}
          ${renderLevelBadge(seat.level)}
        </div>

        ${renderSideCuttingCountdownFooter(
          footerLabel,
          shouldShowCuttingCountdown,
          displayCountdownRemainingMs,
          countdownTotalMs,
          seat.seat,
          escapeHtml,
          countdownKey,
        )}

        ${cutterBadgeHtml}
      </div>
      ${renderCuttingDealerBadge(visualSeat, dealerSeat, seat.seat)}
    </div>
  `
}

export function createCuttingSeatPanelsHtml(
  options: RenderCuttingSeatPanelsOptions,
): string {
  const {
    seats,
    localSeat,
    dealerSeat,
    cutterSeat,
    cuttingCountdownRemainingMs,
    countdownSeat,
    countdownRemainingMs,
    countdownTotalMs,
    countdownKey,
    highlightSeat,
    highlightBadgeLabel,
    panelScale,
    escapeHtml,
    dealtHands,
    bidBubbles,
    declarationBubbles,
    emojiBubbles,
  } = options
  const effectiveCountdownSeat =
    countdownSeat === undefined ? cutterSeat : countdownSeat
  const effectiveCountdownRemainingMs =
    countdownRemainingMs === undefined
      ? cuttingCountdownRemainingMs
      : countdownRemainingMs
  const effectiveCountdownTotalMs =
    countdownTotalMs === undefined ? CUTTING_COUNTDOWN_MS : countdownTotalMs
  const effectiveHighlightSeat =
    highlightSeat === undefined ? cutterSeat : highlightSeat
  const effectiveHighlightBadgeLabel =
    effectiveHighlightSeat !== null
      ? highlightBadgeLabel === undefined
        ? 'Цепи'
        : highlightBadgeLabel
      : null
  const seatMap = new Map(seats.map((seat) => [seat.seat, seat]))
  const visualOrder: readonly Seat[] = ['top', 'left', 'right', 'bottom']

  const panels = SEAT_ORDER.map((actualSeat) => {
    const seatSnapshot = seatMap.get(actualSeat) ?? createEmptySeatSnapshot(actualSeat)
    const visualSeat = getVisualSeatForLocalPerspective(actualSeat, localSeat)

    return {
      seatSnapshot,
      visualSeat,
    }
  })
    .sort((first, second) => {
      return visualOrder.indexOf(first.visualSeat) - visualOrder.indexOf(second.visualSeat)
    })
    .map(({ seatSnapshot, visualSeat }) => {
      return createCuttingSeatPanelHtml(
        seatSnapshot,
        visualSeat,
        dealerSeat,
        effectiveCountdownSeat,
        effectiveCountdownRemainingMs,
        effectiveCountdownTotalMs,
        effectiveHighlightSeat,
        effectiveHighlightBadgeLabel,
        panelScale,
        escapeHtml,
        dealtHands,
        bidBubbles ?? null,
        declarationBubbles ?? null,
        countdownKey ?? '',
        emojiBubbles ?? null,
      )
    })
    .join('')

  return `
    <style>
      @keyframes belot-active-room-cutting-countdown {
        0% { transform:scaleX(1); }
        100% { transform:scaleX(0); }
      }
      @keyframes belot-panel-card-appear {
        0% { opacity:0; scale:0.97; }
        100% { opacity:1; scale:1; }
      }
      @keyframes belot-panel-card-hidden-appear {
        0% { visibility:hidden; opacity:0; scale:0.97; }
        1% { visibility:visible; opacity:0; scale:0.97; }
        100% { visibility:visible; opacity:1; scale:1; }
      }
      @keyframes belot-panel-card-hide-at-reveal {
        0% { visibility:visible; opacity:1; }
        99% { visibility:visible; opacity:1; }
        100% { visibility:hidden; opacity:0; }
      }
      @keyframes belot-panel-card-show-at-reveal {
        0% { visibility:hidden; opacity:0; }
        99% { visibility:hidden; opacity:0; }
        100% { visibility:visible; opacity:1; }
      }
      @keyframes belot-panel-card-reposition {
        0% { transform:translate(-50%,-50%) translate(var(--px-from),var(--py-from)) rotate(var(--pr-from)); }
        100% { transform:translate(-50%,-50%) translate(var(--px-to),var(--py-to)) rotate(var(--pr-to)); }
      }
    </style>

    <div
      style="
        position:fixed;
        inset:0;
        z-index:3;
        pointer-events:none;
      "
    >
      ${panels}
    </div>
  `
}
