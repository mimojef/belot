import { SEAT_ORDER, type Seat } from '../../data/constants/seatOrder'

const DEAL_PACKET_START_DELAY = 220
const DEAL_PACKET_DELAY_STEP = 420
const DEAL_PACKET_DURATION = 860

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
    return `
      <div
        style="
          position:absolute;
          inset:0;
          border-radius:8px;
          background:
            linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(240,244,250,0.98) 100%);
          box-shadow:
            inset 0 1px 0 rgba(255,255,255,0.95),
            inset 0 -1px 0 rgba(0,0,0,0.05);
        "
      ></div>

      <div
        style="
          position:absolute;
          inset:4px;
          border-radius:6px;
          border:1px solid rgba(20, 49, 84, 0.16);
          background:
            linear-gradient(180deg, rgba(255,255,255,0.92) 0%, rgba(248,250,253,0.92) 100%);
        "
      ></div>

      <div
        style="
          position:absolute;
          left:8px;
          top:6px;
          font-size:12px;
          font-weight:900;
          color:#b3261e;
          letter-spacing:0.02em;
          line-height:1;
        "
      >
        A
      </div>

      <div
        style="
          position:absolute;
          right:8px;
          bottom:6px;
          font-size:12px;
          font-weight:900;
          color:#b3261e;
          letter-spacing:0.02em;
          line-height:1;
          transform:rotate(180deg);
        "
      >
        A
      </div>

      <div
        style="
          position:absolute;
          left:50%;
          top:50%;
          width:18px;
          height:18px;
          transform:translate(-50%, -50%) rotate(45deg);
          border-radius:4px;
          background:rgba(179, 38, 30, 0.16);
          border:1px solid rgba(179, 38, 30, 0.28);
        "
      ></div>
    `
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

  if (!isDealFirstThreeReveal && !isDealNextTwoReveal) {
    return ''
  }

  return `opacity:0; animation: belot-seat-reveal 120ms ease ${revealDelayMs}ms forwards;`
}

function renderSeatCards(
  seat: Seat,
  handCount: number,
  dealerSeat: Seat | null,
  currentPhase?: string
): string {
  const visibleCount = Math.max(0, Math.min(handCount, 8))

  if (visibleCount === 0) {
    return ''
  }

  const revealDelayMs = getSeatRevealDelayMs(seat, dealerSeat)

  const cards = Array.from({ length: visibleCount }, (_, index) => {
    const offset = index * 22
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
      border:1px solid ${seat === 'bottom' ? 'rgba(20,49,84,0.14)' : 'rgba(255,255,255,0.20)'};
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
        transform:translateX(calc(-50% + ${offset - ((visibleCount - 1) * 7)}px)) rotate(${((visibleCount - 1) / 2 - index) * 8}deg);
        transform-origin:center 10%;
      "
    >
      ${renderCardBackOrFront(seat)}
    </div>
  `
}

    if (seat === 'bottom') {
  return `
    <div
      style="
        ${commonStyles}
        left:50%;
        top:-80px;
        transform:translateX(calc(-50% + ${offset - ((visibleCount - 1) * 7)}px)) rotate(${(index - (visibleCount - 1) / 2) * 8}deg);
        transform-origin:center 90%;
        box-shadow: 0 8px 14px rgba(0,0,0,0.18);
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
        transform:translateY(calc(-50% + ${offset - ((visibleCount - 1) * 7)}px)) rotate(${90 + ((index - (visibleCount - 1) / 2) * 8)}deg);
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
      transform:translateY(calc(-50% + ${offset - ((visibleCount - 1) * 7)}px)) rotate(${-90 + (((visibleCount - 1) / 2 - index) * 8)}deg);
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

export function renderSeatPanel(
  seat: Seat,
  handCount: number,
  dealerSeat: Seat | null,
  _cutterSeat: Seat | null,
  activeSeat: Seat | null,
  currentPhase?: string
): string {
  const isActive = seat === activeSeat

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
        width:138px;
        height:176px;
        overflow:visible;
        filter:${isActive ? 'drop-shadow(0 0 22px rgba(245, 187, 55, 0.30))' : 'drop-shadow(0 12px 22px rgba(0,0,0,0.22))'};
      "
    >
      ${renderSeatCards(seat, handCount, dealerSeat, currentPhase)}

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
            top:18px;
            left:50%;
            transform:translateX(-50%);
            width:76px;
            height:76px;
            border-radius:20px;
            background:
              linear-gradient(180deg, rgba(255,255,255,0.96) 0%, rgba(232,240,248,0.96) 100%);
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
    </div>
  `
}