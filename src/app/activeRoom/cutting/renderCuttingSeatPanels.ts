import type { RoomSeatSnapshot, Seat } from '../../network/createGameServerClient'
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

export type RenderCuttingSeatPanelsOptions = {
  seats: RoomSeatSnapshot[]
  localSeat: Seat
  dealerSeat: Seat | null
  cutterSeat: Seat | null
  cuttingCountdownRemainingMs: number | null
  panelScale: number
  escapeHtml: EscapeHtml
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
        left:112px;
        right:14px;
        bottom:8px;
        height:16px;
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
        min-height:44px;
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
          min-height:44px;
          padding:10px 12px 11px;
          color:#f4f8ff;
          text-align:center;
          font-size:14px;
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

export function createCuttingSeatPanelHtml(
  seat: RoomSeatSnapshot,
  visualSeat: Seat,
  dealerSeat: Seat | null,
  cutterSeat: Seat | null,
  cuttingCountdownRemainingMs: number | null,
  panelScale: number,
  escapeHtml: EscapeHtml,
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

  if (isBottomSeat) {
    return `
      <div
        style="
          position:absolute;
          ${getCuttingSeatPanelAnchorStyle(visualSeat, panelScale)}
          z-index:4;
          pointer-events:none;
        "
      >
        <div
          style="
            position:relative;
            width:280px;
            height:106px;
            border-radius:16px;
            border:2px solid ${borderColor};
            background:
              radial-gradient(circle at 22% 22%, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0.05) 18%, rgba(18, 79, 118, 0.0) 40%),
              linear-gradient(180deg, rgba(16, 145, 151, 0.96) 0%, rgba(17, 95, 118, 0.96) 54%, rgba(10, 44, 70, 0.98) 100%);
            box-shadow:${shadow};
            overflow:hidden;
          "
        >
          <div
            style="
              position:absolute;
              left:6px;
              top:6px;
              width:92px;
              height:92px;
              border-radius:14px;
              background:
                linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(232,240,248,0.98) 100%);
              box-shadow:
                inset 0 1px 0 rgba(255,255,255,0.8),
                0 10px 18px rgba(0,0,0,0.18);
              display:flex;
              align-items:center;
              justify-content:center;
              color:#16314f;
              font-size:34px;
              font-weight:900;
              letter-spacing:0.04em;
              overflow:hidden;
            "
          >
            ${renderCuttingSeatAvatar(seat, visualSeat, 14, escapeHtml)}
          </div>

          <div
            style="
              position:absolute;
              left:112px;
              top:14px;
              color:#f4f8ff;
              font-size:20px;
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
              left:112px;
              right:14px;
              top:46px;
              color:#f8fafc;
              font-size:17px;
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
      style="
        position:absolute;
        ${getCuttingSeatPanelAnchorStyle(visualSeat, panelScale)}
        z-index:4;
        pointer-events:none;
      "
    >
      <div
        style="
          position:relative;
          width:146px;
          height:184px;
          border-radius:14px;
          border:2px solid ${borderColor};
          background:
            radial-gradient(circle at 35% 30%, rgba(255,255,255,0.22) 0%, rgba(255,255,255,0.06) 18%, rgba(18, 79, 118, 0.0) 40%),
            linear-gradient(180deg, rgba(18, 154, 160, 0.95) 0%, rgba(19, 104, 121, 0.95) 52%, rgba(12, 55, 82, 0.96) 100%);
          box-shadow:${shadow};
          overflow:hidden;
        "
      >
        <div
          style="
            position:absolute;
            top:6px;
            left:6px;
            right:6px;
            bottom:50px;
            border-radius:12px;
            background:
              linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(232,240,248,0.98) 100%);
            box-shadow:
              inset 0 1px 0 rgba(255,255,255,0.8),
              0 10px 18px rgba(0,0,0,0.18);
            display:flex;
            align-items:center;
            justify-content:center;
            color:#16314f;
            font-size:42px;
            font-weight:900;
            letter-spacing:0.04em;
            overflow:hidden;
          "
        >
          ${renderCuttingSeatAvatar(seat, visualSeat, 12, escapeHtml)}
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
                    min-height:44px;
                    padding:10px 12px 11px;
                    background:rgba(6, 22, 40, 0.94);
                    border-top:1px solid rgba(255,255,255,0.12);
                    color:#f4f8ff;
                    text-align:center;
                    font-size:14px;
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
      )
    })
    .join('')

  return `
    <style>
      @keyframes belot-active-room-cutting-countdown {
        0% {
          transform:scaleX(1);
        }
        100% {
          transform:scaleX(0);
        }
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
