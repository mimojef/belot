import { SEAT_ORDER, type Seat } from '../../data/constants/seatOrder'

type DealAnimationPhase = 'deal-first-3' | 'deal-next-2' | 'deal-last-3'

function getPacketCount(phase: DealAnimationPhase): number {
  if (phase === 'deal-next-2') return 2
  return 3
}

function getPhaseLabel(phase: DealAnimationPhase): string {
  if (phase === 'deal-first-3') return 'Раздаване по 3 карти'
  if (phase === 'deal-next-2') return 'Раздаване по 2 карти'
  return 'Последни 3 карти'
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

function renderDealAnimationStyles(): string {
  return `
    <style>
      @keyframes belot-deal-center-stack-in {
        0% {
          opacity: 0;
          transform: translate(-50%, -50%) translateY(10px) scale(0.94);
        }
        100% {
          opacity: 1;
          transform: translate(-50%, -50%) translateY(0) scale(1);
        }
      }

      @keyframes belot-deal-packet-fly {
        0% {
          opacity: 0;
          transform: translate(-50%, -50%) translate(0px, 0px) rotate(0deg) scale(0.96);
          filter: brightness(1);
        }
        8% {
          opacity: 1;
          transform: translate(-50%, -50%) translate(0px, 0px) rotate(0deg) scale(1);
          filter: brightness(1.02);
        }
        100% {
          opacity: 1;
          transform: translate(-50%, -50%) translate(var(--deal-x), var(--deal-y)) rotate(var(--deal-rotate)) scale(1);
          filter: brightness(1);
        }
      }
    </style>
  `
}

function getPacketTarget(
  seat: Seat,
  packetCount: number
): { x: number; y: number; rotate: string } {
  if (seat === 'bottom') {
    return {
      x: 0,
      y: 258,
      rotate: packetCount === 3 ? '-4deg' : '-2deg',
    }
  }

  if (seat === 'top') {
    return {
      x: 0,
      y: -258,
      rotate: packetCount === 3 ? '4deg' : '2deg',
    }
  }

  if (seat === 'left') {
    return {
      x: -372,
      y: 0,
      rotate: packetCount === 3 ? '-90deg' : '-88deg',
    }
  }

  return {
    x: 372,
    y: 0,
    rotate: packetCount === 3 ? '90deg' : '88deg',
  }
}

function getInnerCardTransform(
  seat: Seat,
  index: number,
  packetCount: number
): string {
  const centered = index - (packetCount - 1) / 2

  if (seat === 'bottom' || seat === 'top') {
    return `translate(${centered * 14}px, ${Math.abs(centered) * 3}px) rotate(${centered * 3}deg)`
  }

  return `translate(${Math.abs(centered) * 3}px, ${centered * 14}px) rotate(${centered * 3}deg)`
}

function renderPacket(
  seat: Seat,
  packetCount: number,
  delay: number,
  zIndex: number
): string {
  const motion = getPacketTarget(seat, packetCount)

  const cards = Array.from({ length: packetCount }, (_, index) => {
    return `
      <div
        style="
          position:absolute;
          left:50%;
          top:50%;
          width:90px;
          height:130px;
          border-radius:14px;
          transform:translate(-50%, -50%) ${getInnerCardTransform(seat, index, packetCount)};
          background:
            linear-gradient(135deg, rgba(255,255,255,0.14) 0%, rgba(255,255,255,0.05) 18%, rgba(255,255,255,0.02) 100%),
            linear-gradient(180deg, #21476e 0%, #173454 100%);
          border:1px solid rgba(255,255,255,0.24);
          box-shadow: 0 14px 24px rgba(0,0,0,0.18);
          overflow:hidden;
        "
      >
        <span
          style="
            position:absolute;
            inset:9px;
            border-radius:10px;
            border:1px solid rgba(255,255,255,0.16);
            background:
              radial-gradient(circle at center, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.03) 28%, rgba(255,255,255,0.02) 100%);
          "
        ></span>

        <span
          style="
            position:absolute;
            left:50%;
            top:50%;
            width:34px;
            height:34px;
            transform:translate(-50%, -50%) rotate(45deg);
            border:1px solid rgba(245, 187, 55, 0.42);
            background: rgba(245, 187, 55, 0.08);
            border-radius:8px;
          "
        ></span>
      </div>
    `
  }).join('')

  return `
    <div
      style="
        position:absolute;
        left:50%;
        top:50%;
        width:156px;
        height:156px;
        opacity:0;
        pointer-events:none;
        --deal-x:${motion.x}px;
        --deal-y:${motion.y}px;
        --deal-rotate:${motion.rotate};
        animation: belot-deal-packet-fly 760ms cubic-bezier(0.18, 0.82, 0.22, 1) ${delay}ms forwards;
        z-index:${zIndex};
      "
    >
      ${cards}
    </div>
  `
}

export function renderDealAnimationScreen(
  phase: DealAnimationPhase,
  dealerSeat: Seat | null
): string {
  const packetCount = getPacketCount(phase)
  const dealOrder = getDealOrder(dealerSeat)

  const packetStartDelay = 180
  const packetDelayStep = phase === 'deal-next-2' ? 430 : 520

  const packets = dealOrder
    .map((seat, index) =>
      renderPacket(
        seat,
        packetCount,
        packetStartDelay + index * packetDelayStep,
        100 + index
      )
    )
    .join('')

  return `
    <div
      style="
        width:min(96vw, 980px);
        margin:0 auto;
        display:flex;
        flex-direction:column;
        align-items:center;
        gap:12px;
      "
    >
      ${renderDealAnimationStyles()}

      <div
        style="
          font-size:22px;
          line-height:1;
          font-weight:900;
          letter-spacing:0.12em;
          color:#f5bb37;
          text-transform:uppercase;
        "
      >
        ${getPhaseLabel(phase)}
      </div>

      <div
        style="
          font-size:13px;
          font-weight:700;
          color:rgba(239,245,255,0.82);
          text-align:center;
        "
      >
        Раздаване на пакет към всеки играч по ред след дилъра.
      </div>

      <div
        style="
          position:relative;
          width:min(92vw, 920px);
          height:390px;
          margin-top:10px;
          user-select:none;
        "
      >
        <div
          style="
            position:absolute;
            left:50%;
            top:50%;
            width:118px;
            height:156px;
            transform:translate(-50%, -50%);
            pointer-events:none;
            animation: belot-deal-center-stack-in 220ms ease forwards;
            z-index:90;
          "
        >
          <div
            style="
              position:absolute;
              inset:10px 0 0 0;
              margin:auto;
              width:96px;
              height:136px;
              border-radius:14px;
              background: rgba(16, 41, 66, 0.30);
              border:1px solid rgba(255,255,255,0.18);
              transform: rotate(-5deg);
            "
          ></div>

          <div
            style="
              position:absolute;
              inset:4px 0 0 0;
              margin:auto;
              width:96px;
              height:136px;
              border-radius:14px;
              background: rgba(16, 41, 66, 0.40);
              border:1px solid rgba(255,255,255,0.22);
              transform: rotate(4deg);
            "
          ></div>

          <div
            style="
              position:absolute;
              inset:0;
              margin:auto;
              width:98px;
              height:138px;
              border-radius:14px;
              background:
                linear-gradient(135deg, rgba(255,255,255,0.12) 0%, rgba(255,255,255,0.04) 18%, rgba(255,255,255,0.02) 100%),
                linear-gradient(180deg, #21476e 0%, #173454 100%);
              border:2px solid rgba(245, 187, 55, 0.42);
              box-shadow: 0 18px 28px rgba(0,0,0,0.18);
            "
          ></div>
        </div>

        ${packets}
      </div>
    </div>
  `
}