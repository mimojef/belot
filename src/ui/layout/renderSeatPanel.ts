import { SEAT_ORDER, type Seat } from '../../data/constants/seatOrder'

const DEAL_PACKET_START_DELAY = 220
const DEAL_PACKET_DELAY_STEP = 420
const DEAL_PACKET_DURATION = 860

const FAN_SPREAD_STEP = 38
const FAN_ROTATE_STEP = 6
const FAN_CURVE_STEP = 7

function formatSeatShort(seat: Seat): string {
  if (seat === 'bottom') return 'ТИ'
  if (seat === 'right') return 'ДЯСНО'
  if (seat === 'top') return 'ГОРЕ'
  if (seat === 'left') return 'ЛЯВО'
  return '—'
}

function formatSeatAvatarLabel(seat: Seat): string {
  if (seat === 'bottom') return 'Т'
  if (seat === 'right') return 'Д'
  if (seat === 'top') return 'Г'
  if (seat === 'left') return 'Л'
  return '—'
}

function renderDealerBadge(seat: Seat, dealerSeat: Seat | null): string {
  if (seat !== dealerSeat) {
    return ''
  }

  if (seat === 'bottom') {
    return `
      <div
        style="
          position:absolute;
          right:8px;
          top:50%;
          transform:translateY(-50%);
          width:28px;
          height:28px;
          display:inline-flex;
          align-items:center;
          justify-content:center;
          border-radius:10px;
          background: rgba(245, 187, 55, 0.98);
          color:#13253d;
          font-size:14px;
          font-weight:900;
          box-shadow: 0 6px 14px rgba(0,0,0,0.22);
          z-index:5;
        "
      >
        D
      </div>
    `
  }

  return `
    <div
      style="
        position:absolute;
        left:10px;
        bottom:44px;
        width:28px;
        height:28px;
        display:inline-flex;
        align-items:center;
        justify-content:center;
        border-radius:8px;
        background: rgba(245, 187, 55, 0.98);
        color:#13253d;
        font-size:14px;
        font-weight:900;
        box-shadow: 0 6px 14px rgba(0,0,0,0.22);
        z-index:4;
      "
    >
      D
    </div>
  `
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

function getSeatRevealDelayMs(seat: Seat, dealerSeat: Seat | null): number {
  const dealOrder = getDealOrder(dealerSeat)
  const seatIndex = dealOrder.indexOf(seat)

  if (seatIndex === -1) {
    return DEAL_PACKET_START_DELAY + DEAL_PACKET_DURATION
  }

  return DEAL_PACKET_START_DELAY + seatIndex * DEAL_PACKET_DELAY_STEP + DEAL_PACKET_DURATION
}

function renderCardBackOrFront(seat: Seat): string {
  if (seat === 'bottom') {
    return ''
  }

  return `
    <div
      style="
        position:absolute;
        inset:0;
        border-radius:8px;
        background:
          linear-gradient(180deg, rgba(20, 49, 84, 0.98) 0%, rgba(11, 27, 49, 0.98) 100%);
        box-shadow:
          inset 0 1px 0 rgba(255,255,255,0.14),
          0 8px 14px rgba(0,0,0,0.22);
      "
    ></div>

    <div
      style="
        position:absolute;
        inset:5px;
        border-radius:6px;
        border:1px solid rgba(255,255,255,0.12);
        background:
          radial-gradient(circle at center, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.03) 30%, rgba(255,255,255,0.02) 100%);
      "
    ></div>
  `
}

function getCardAnimationStyle(
  currentPhase: string | undefined,
  visibleCount: number,
  cardIndex: number,
  revealDelayMs: number
): string {
  const isDealFirstThreeReveal =
    currentPhase === 'deal-first-3' && visibleCount === 3

  const isDealNextTwoReveal =
    currentPhase === 'deal-next-2' && visibleCount >= 5 && cardIndex >= 3

  const isDealLastThreeReveal =
    currentPhase === 'deal-last-3' && visibleCount >= 8 && cardIndex >= 5

  if (!isDealFirstThreeReveal && !isDealNextTwoReveal && !isDealLastThreeReveal) {
    return ''
  }

  return `opacity:0; animation: belot-seat-reveal 120ms ease ${revealDelayMs}ms forwards;`
}

function getFanDistance(index: number, visibleCount: number): number {
  return index - (visibleCount - 1) / 2
}

function getTopFanTransform(distance: number): string {
  const distanceAbs = Math.abs(distance)

  return `
    translateX(calc(-50% + ${distance * FAN_SPREAD_STEP}px))
    translateY(${-distanceAbs * FAN_CURVE_STEP}px)
    rotate(${-distance * FAN_ROTATE_STEP}deg)
  `
}

function getLeftFanTransform(distance: number): string {
  const distanceAbs = Math.abs(distance)

  return `
    translateY(calc(-50% + ${distance * FAN_SPREAD_STEP}px))
    translateX(${-distanceAbs * FAN_CURVE_STEP}px)
    rotate(${90 + distance * FAN_ROTATE_STEP}deg)
  `
}

function getRightFanTransform(distance: number): string {
  const distanceAbs = Math.abs(distance)

  return `
    translateY(calc(-50% + ${distance * FAN_SPREAD_STEP}px))
    translateX(${distanceAbs * FAN_CURVE_STEP}px)
    rotate(${-90 - distance * FAN_ROTATE_STEP}deg)
  `
}

function renderSeatCards(
  seat: Seat,
  handCount: number,
  dealerSeat: Seat | null,
  currentPhase?: string
): string {
  if (seat === 'bottom') {
    return ''
  }

  const visibleCount = Math.max(0, Math.min(handCount, 8))

  if (visibleCount === 0) {
    return ''
  }

  const revealDelayMs = getSeatRevealDelayMs(seat, dealerSeat)

  const cards = Array.from({ length: visibleCount }, (_, index) => {
    const distance = getFanDistance(index, visibleCount)
    const animationStyle = getCardAnimationStyle(
      currentPhase,
      visibleCount,
      index,
      revealDelayMs
    )

    const commonStyles = `
      position:absolute;
      width:170px;
      height:250px;
      border-radius:8px;
      border:1px solid rgba(255,255,255,0.20);
      z-index:${index + 1};
      ${animationStyle}
    `

    if (seat === 'top') {
      return `
        <div
          style="
            ${commonStyles}
            left:50%;
            bottom:-50px;
            transform:${getTopFanTransform(distance)};
            transform-origin:center 10%;
          "
        >
          ${renderCardBackOrFront(seat)}
        </div>
      `
    }

    if (seat === 'left') {
      return `
        <div
          style="
            ${commonStyles}
            top:19%;
            right:-80px;
            transform:${getLeftFanTransform(distance)};
            transform-origin:10% center;
          "
        >
          ${renderCardBackOrFront(seat)}
        </div>
      `
    }

    return `
      <div
        style="
          ${commonStyles}
          top:19%;
          left:-80px;
          transform:${getRightFanTransform(distance)};
          transform-origin:90% center;
        "
      >
        ${renderCardBackOrFront(seat)}
      </div>
    `
  }).join('')

  return `
    <div
      style="
        position:absolute;
        inset:0;
        overflow:visible;
        pointer-events:none;
        z-index:2;
      "
    >
      ${cards}
    </div>
  `
}

function renderBottomSeatFace(isActive: boolean, dealerSeat: Seat | null): string {
  return `
    <div
      style="
        position:absolute;
        inset:0;
        border-radius:14px;
        overflow:hidden;
        z-index:3;
        border:2px solid ${isActive ? 'rgba(245, 187, 55, 0.96)' : 'rgba(255,255,255,0.18)'};
        background:
          radial-gradient(circle at 30% 28%, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0.05) 18%, rgba(18, 79, 118, 0.0) 40%),
          linear-gradient(180deg, rgba(16, 145, 151, 0.96) 0%, rgba(17, 95, 118, 0.96) 54%, rgba(10, 44, 70, 0.98) 100%);
        box-shadow:
          inset 0 1px 0 rgba(255,255,255,0.14),
          0 14px 28px rgba(0,0,0,0.22);
      "
    >
      <div
        style="
          position:absolute;
          left:5px;
          top:5px;
          width:84px;
          height:84px;
          border-radius:14px;
          background:
            linear-gradient(180deg, rgba(255,255,255,0.97) 0%, rgba(232,240,248,0.97) 100%);
          box-shadow:
            inset 0 1px 0 rgba(255,255,255,0.8),
            0 10px 18px rgba(0,0,0,0.18);
          display:flex;
          align-items:center;
          justify-content:center;
          color:#16314f;
          font-size:30px;
          font-weight:900;
          letter-spacing:0.04em;
        "
      >
        ${formatSeatAvatarLabel('bottom')}
      </div>

      <div
        style="
          position:absolute;
          left:99px;
          right:40px;
          top:14px;
          height:26px;
          display:flex;
          align-items:center;
          color:#f4f8ff;
          font-size:18px;
          font-weight:800;
          letter-spacing:0.02em;
          line-height:1;
          text-transform:uppercase;
          text-shadow:0 2px 8px rgba(0,0,0,0.20);
        "
      >
        ${formatSeatShort('bottom')}
      </div>

      <div
        style="
          position:absolute;
          left:101px;
          right:5px;
          bottom:5px;
          height:18px;
          border-radius:6px;
          background:rgba(245, 187, 55, 0.96);
          box-shadow:0 4px 10px rgba(0,0,0,0.18);
        "
      ></div>

      ${renderDealerBadge('bottom', dealerSeat)}
    </div>
  `
}

function renderDefaultSeatFace(
  seat: Seat,
  isActive: boolean,
  dealerSeat: Seat | null
): string {
  return `
    <div
      style="
        position:absolute;
        inset:0;
        border-radius:12px;
        overflow:hidden;
        z-index:3;
        border:2px solid ${isActive ? 'rgba(245, 187, 55, 0.96)' : 'rgba(255,255,255,0.18)'};
        background:
          radial-gradient(circle at 35% 30%, rgba(255,255,255,0.22) 0%, rgba(255,255,255,0.06) 18%, rgba(18, 79, 118, 0.0) 40%),
          linear-gradient(180deg, rgba(18, 154, 160, 0.95) 0%, rgba(19, 104, 121, 0.95) 52%, rgba(12, 55, 82, 0.96) 100%);
        box-shadow:
          inset 0 1px 0 rgba(255,255,255,0.14),
          0 14px 28px rgba(0,0,0,0.22);
      "
    >
      <div
        style="
          position:absolute;
          top:5px;
          left:5px;
          right:5px;
          bottom:43px;
          border-radius:12px;
          background:
            linear-gradient(180deg, rgba(255,255,255,0.96) 0%, rgba(232,240,248,0.96) 100%);
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
        "
      >
        ${formatSeatAvatarLabel(seat)}
      </div>

      ${renderDealerBadge(seat, dealerSeat)}

      <div
        style="
          position:absolute;
          left:0;
          right:0;
          bottom:0;
          min-height:38px;
          padding:10px 12px 11px 12px;
          background: rgba(6, 22, 40, 0.94);
          border-top:1px solid rgba(255,255,255,0.12);
          color:#f4f8ff;
          text-align:center;
          font-size:14px;
          font-weight:800;
          letter-spacing:0.04em;
          line-height:1.1;
          text-transform:uppercase;
        "
      >
        ${formatSeatShort(seat)}
      </div>
    </div>
  `
}

export function renderSeatPanel(
  seat: Seat,
  handCount: number,
  dealerSeat: Seat | null,
  _cutterSeat: Seat | null,
  activeSeat: Seat | null,
  currentPhase?: string
): string {
  const isActive = seat === activeSeat
  const panelWidth = seat === 'bottom' ? 260 : 138
  const panelHeight = seat === 'bottom' ? 98 : 176

  return `
    <style>
      @keyframes belot-seat-reveal {
        0% {
          opacity: 0;
        }
        100% {
          opacity: 1;
        }
      }
    </style>

    <div
      style="
        position:relative;
        width:${panelWidth}px;
        height:${panelHeight}px;
        overflow:visible;
        filter:${isActive ? 'drop-shadow(0 0 22px rgba(245, 187, 55, 0.30))' : 'drop-shadow(0 12px 22px rgba(0,0,0,0.22))'};
      "
    >
      ${renderSeatCards(seat, handCount, dealerSeat, currentPhase)}

      ${
        seat === 'bottom'
          ? renderBottomSeatFace(isActive, dealerSeat)
          : renderDefaultSeatFace(seat, isActive, dealerSeat)
      }
    </div>
  `
}