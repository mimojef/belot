import type { RoomCardSnapshot, RoomSeatSnapshot, Seat } from '../../network/createGameServerClient'
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

export type DealtHandsData = {
  handCounts: Record<Seat, number>
  ownHand: RoomCardSnapshot[]
  localSeat: Seat
  seatAnimDelays: Partial<Record<Seat, number>> | null
  maxCardsPerSeat: number
  animStartIndex: number
  preserveExistingCardOffsets?: boolean
}

export type SeatBidBubble = {
  label: string
  elapsedMs: number
}

export type RenderCuttingSeatPanelsOptions = {
  seats: RoomSeatSnapshot[]
  localSeat: Seat
  dealerSeat: Seat | null
  cutterSeat: Seat | null
  cuttingCountdownRemainingMs: number | null
  panelScale: number
  escapeHtml: EscapeHtml
  dealtHands: DealtHandsData | null
  bidBubbles: Partial<Record<Seat, SeatBidBubble>> | null
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function renderCuttingCountdownFillStyle(
  shouldShowCuttingCountdown: boolean,
  cuttingCountdownRemainingMs: number | null,
): string {
  if (!shouldShowCuttingCountdown || cuttingCountdownRemainingMs === null) {
    return 'opacity:0; transform:scaleX(0);'
  }

  const remainingMs = clamp(cuttingCountdownRemainingMs, 0, CUTTING_COUNTDOWN_MS)
  const elapsedMs = CUTTING_COUNTDOWN_MS - remainingMs

  return `
    opacity:1;
    transform:scaleX(1);
    animation: belot-active-room-cutting-countdown ${CUTTING_COUNTDOWN_MS}ms linear forwards;
    animation-delay:-${elapsedMs}ms;
    animation-fill-mode:both;
  `
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
        z-index:5;
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
        background:rgba(6, 22, 40, 0.94);
        box-shadow:
          inset 0 1px 0 rgba(255,255,255,0.08),
          0 4px 10px rgba(0,0,0,0.18);
      "
    >
      <div
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
  escapeHtml: EscapeHtml,
): string {
  return `
    <div
      style="
        position:absolute;
        left:0;
        right:0;
        bottom:0;
        min-height:52px;
        background:rgba(6, 22, 40, 0.94);
        border-top:1px solid rgba(255,255,255,0.12);
        overflow:hidden;
      "
    >
      <div
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

function getSuitSymbol(suit: RoomCardSnapshot['suit']): string {
  if (suit === 'clubs') return '♣'
  if (suit === 'diamonds') return '♦'
  if (suit === 'hearts') return '♥'
  return '♠'
}

function isRedSuit(suit: RoomCardSnapshot['suit']): boolean {
  return suit === 'hearts' || suit === 'diamonds'
}

function renderPanelCardBack(): string {
  return `
    <span style="position:absolute;inset:0;border-radius:16px;background:linear-gradient(180deg,rgba(255,255,255,0.98) 0%,rgba(241,245,249,0.98) 100%);"></span>
    <span style="position:absolute;inset:11px;border-radius:12px;border:1px solid rgba(15,23,42,0.10);background-image:url('/images/cards/card-back.png');background-size:cover;background-position:center;background-repeat:no-repeat;"></span>
  `
}

function renderPanelCardFront(card: RoomCardSnapshot): string {
  const symbol = getSuitSymbol(card.suit)
  const color = isRedSuit(card.suit) ? '#b3261e' : '#13253d'
  return `
    <div style="position:relative;width:100%;height:100%;box-sizing:border-box;border-radius:16px;border:1px solid rgba(15,23,42,0.12);background:linear-gradient(180deg,#fff 0%,#f8fafc 100%);color:${color};overflow:hidden;">
      <div style="position:absolute;left:12px;top:12px;font-size:30px;line-height:1;font-weight:900;">${card.rank}</div>
      <div style="position:absolute;left:12px;top:45px;font-size:30px;line-height:1;font-weight:900;">${symbol}</div>
      <div style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);font-size:74px;line-height:1;font-weight:900;">${symbol}</div>
    </div>
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
  return {
    x: centered * 65,
    y: Math.abs(centered) * 6,
    rotate: centered * 6,
  }
}

function getAppendedFanOffset(
  index: number,
  baseCount: number,
): { x: number; y: number; rotate: number } {
  const lastStable = getFanOffset(baseCount - 1, baseCount)
  const appendedStep = index - (baseCount - 1)

  return {
    x: lastStable.x + appendedStep * 65,
    y: lastStable.y + appendedStep * 6,
    rotate: lastStable.rotate + appendedStep * 6,
  }
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
  const shouldPreserveExistingOffsets =
    isLocalSeat &&
    dealtHands.preserveExistingCardOffsets === true &&
    animDelay !== null &&
    dealtHands.animStartIndex > 0

  const cardElements = Array.from({ length: count }, (_, i) => {
    const fanTo = shouldPreserveExistingOffsets
      ? i < dealtHands.animStartIndex
        ? getFanOffset(i, dealtHands.animStartIndex)
        : getAppendedFanOffset(i, dealtHands.animStartIndex)
      : getFanOffset(i, count)
    const card = isLocalSeat ? (cards[i] ?? null) : null

    let animStyle = ''
    if (animDelay !== null && i >= dealtHands.animStartIndex) {
      // New card — appears when packet arrives
      animStyle = `animation: belot-panel-card-appear 80ms cubic-bezier(0.34,0,0.18,1) ${animDelay}ms both;`
    } else if (
      animDelay !== null &&
      i < dealtHands.animStartIndex &&
      !shouldPreserveExistingOffsets
    ) {
      // Existing card — repositions from the smaller fan to the larger fan when new cards arrive
      const fanFrom = getFanOffset(i, dealtHands.animStartIndex)
      animStyle = `
        --px-from:${fanFrom.x}px; --py-from:${fanFrom.y}px; --pr-from:${fanFrom.rotate}deg;
        --px-to:${fanTo.x}px; --py-to:${fanTo.y}px; --pr-to:${fanTo.rotate}deg;
        animation: belot-panel-card-reposition 110ms cubic-bezier(0.34,0,0.18,1) ${animDelay}ms both;
      `
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
    <div style="
      position:absolute;
      left:${fanCenterX}px;
      top:${fanCenterY}px;
      width:1px;
      height:1px;
      pointer-events:none;
      z-index:0;
      ${rotateStyle}
    ">
      ${cardElements}
    </div>
  `
}

const BID_BUBBLE_TOTAL_MS = 3200


function renderBidBubble(
  visualSeat: Seat,
  bubble: SeatBidBubble,
  escapeHtml: EscapeHtml,
): string {
  const totalMs = BID_BUBBLE_TOTAL_MS
  const fadeInEnd = Math.round((200 / totalMs) * 100)
  const fadeOutStart = Math.round(((totalMs - 280) / totalMs) * 100)
  const keyframes = `@keyframes bbb-${visualSeat}{0%{opacity:0}${fadeInEnd}%{opacity:1}${fadeOutStart}%{opacity:1}100%{opacity:0}}`

  let wrapperStyle: string
  let tailStyle: string
  if (visualSeat === 'bottom') {
    wrapperStyle = 'bottom:156px;left:50%;transform:translateX(-50%);'
    tailStyle = `
      left:50%;
      bottom:0;
      width:20px;
      height:12px;
      clip-path:polygon(50% 100%, 0 0, 100% 0);
      transform:translate(-50%, 90%);
    `
  } else if (visualSeat === 'top') {
    wrapperStyle = 'left:202px;top:38px;transform:none;'
    tailStyle = `
      left:0;
      top:50%;
      width:14px;
      height:20px;
      clip-path:polygon(0 50%, 100% 0, 100% 100%);
      transform:translate(-88%, -50%);
    `
  } else if (visualSeat === 'left') {
    wrapperStyle = 'left:202px;top:84px;transform:none;'
    tailStyle = `
      left:0;
      top:50%;
      width:14px;
      height:20px;
      clip-path:polygon(0 50%, 100% 0, 100% 100%);
      transform:translate(-88%, -50%);
    `
  } else {
    wrapperStyle = 'right:202px;top:84px;transform:none;'
    tailStyle = `
      right:0;
      top:50%;
      width:14px;
      height:20px;
      clip-path:polygon(100% 50%, 0 0, 0 100%);
      transform:translate(88%, -50%);
    `
  }

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
        border-radius:16px;
        padding:10px 16px;
        background:${bubbleBackground};
        color:#1e293b;
        font-size:22px;
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

export function createCuttingSeatPanelHtml(
  seat: RoomSeatSnapshot,
  visualSeat: Seat,
  dealerSeat: Seat | null,
  cutterSeat: Seat | null,
  cuttingCountdownRemainingMs: number | null,
  panelScale: number,
  escapeHtml: EscapeHtml,
  dealtHands: DealtHandsData | null,
  bidBubbles: Partial<Record<Seat, SeatBidBubble>> | null,
): string {
  const isBottomSeat = visualSeat === 'bottom'
  const isCutter = seat.seat === cutterSeat
  const shouldShowCuttingCountdown = isCutter
  const displayName =
    seat.isOccupied && seat.displayName.trim().length > 0
      ? seat.displayName
      : 'Свободно място'
  const footerLabel =
    seat.isOccupied && displayName.trim().length > 0
      ? displayName
      : CUTTING_VISUAL_SEAT_LABELS[visualSeat]
  const borderColor = isCutter ? 'rgba(245, 187, 55, 0.96)' : 'rgba(255,255,255,0.18)'
  const borderWidthPx = isCutter ? 4 : 2
  const shadow = isCutter
    ? '0 0 24px rgba(245, 187, 55, 0.24), 0 16px 28px rgba(0,0,0,0.24)'
    : '0 14px 28px rgba(0,0,0,0.24)'
  const cutterBadgeHtml = isCutter
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
          Цепи
        </div>
      `
    : ''

  const bubbleHtml = bidBubbles?.[seat.seat]
    ? renderBidBubble(visualSeat, bidBubbles[seat.seat]!, escapeHtml)
    : ''

  if (isBottomSeat) {
    return `
      <div
        data-active-room-seat-anchor="${seat.seat}"
        style="
          position:absolute;
          ${getCuttingSeatPanelAnchorStyle(visualSeat, panelScale)}
          z-index:4;
          pointer-events:none;
        "
      >
        ${bubbleHtml}
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
              radial-gradient(circle at 22% 22%, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0.05) 18%, rgba(18, 79, 118, 0.0) 40%),
              linear-gradient(180deg, rgba(16, 145, 151, 0.96) 0%, rgba(17, 95, 118, 0.96) 54%, rgba(10, 44, 70, 0.98) 100%);
            box-shadow:${shadow};
            overflow:hidden;
            transform:scale(0.8);
            transform-origin:bottom center;
          "
        >
          <div
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
              overflow:hidden;
            "
          >
            ${renderCuttingSeatAvatar(seat, visualSeat, 18, escapeHtml)}
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
            cuttingCountdownRemainingMs,
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
      style="
        position:absolute;
        ${getCuttingSeatPanelAnchorStyle(visualSeat, panelScale)}
        z-index:4;
        pointer-events:none;
      "
    >
      ${bubbleHtml}
      ${dealtHands ? renderDealtCardFanInPanel(seat.seat, visualSeat, dealtHands) : ''}
      <div
        style="
          position:relative;
          width:186px;
          height:234px;
          border-radius:18px;
          border:${borderWidthPx}px solid ${borderColor};
          background:
            radial-gradient(circle at 35% 30%, rgba(255,255,255,0.22) 0%, rgba(255,255,255,0.06) 18%, rgba(18, 79, 118, 0.0) 40%),
            linear-gradient(180deg, rgba(18, 154, 160, 0.95) 0%, rgba(19, 104, 121, 0.95) 52%, rgba(12, 55, 82, 0.96) 100%);
          box-shadow:${shadow};
          overflow:hidden;
          transform:scale(0.9);
          transform-origin:${visualSeat === 'top' ? 'top center' : visualSeat === 'left' ? 'left center' : 'right center'};
        "
      >
        <div
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
            overflow:hidden;
          "
        >
          ${renderCuttingSeatAvatar(seat, visualSeat, 16, escapeHtml)}
        </div>

        ${
          shouldShowCuttingCountdown
            ? renderSideCuttingCountdownFooter(
                footerLabel,
                shouldShowCuttingCountdown,
                cuttingCountdownRemainingMs,
                escapeHtml,
              )
            : `
                <div
                  style="
                    position:absolute;
                    left:0;
                    right:0;
                    bottom:0;
                    min-height:52px;
                    padding:13px 14px 14px;
                    background:rgba(6, 22, 40, 0.94);
                    border-top:1px solid rgba(255,255,255,0.12);
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
                  ${escapeHtml(footerLabel)}
                </div>
              `
        }

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
    panelScale,
    escapeHtml,
    dealtHands,
    bidBubbles,
  } = options
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
        cutterSeat,
        cuttingCountdownRemainingMs,
        panelScale,
        escapeHtml,
        dealtHands,
        bidBubbles ?? null,
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
