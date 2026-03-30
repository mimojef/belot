import type { Seat } from '../../data/constants/seatOrder'

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

function clampHandCount(handCount: number): number {
  if (!Number.isFinite(handCount)) return 0
  return Math.max(0, Math.min(8, Math.floor(handCount)))
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

function getFanAnchor(seat: Seat): { x: number; y: number } {
  if (seat === 'bottom') {
    return { x: 69, y: 24 }
  }

  if (seat === 'top') {
    return { x: 69, y: 152 }
  }

  if (seat === 'left') {
    return { x: 114, y: 88 }
  }

  return { x: 24, y: 88 }
}

function getFanCardTransform(seat: Seat, index: number, totalCards: number): string {
  const centered = index - (totalCards - 1) / 2

  if (seat === 'bottom') {
    const x = centered * 16
    const y = Math.abs(centered) * 3
    const rotate = centered * 5.2

    return `translate(-50%, -50%) translate(${x}px, ${y}px) rotate(${rotate}deg)`
  }

  if (seat === 'top') {
    const x = centered * 16
    const y = -Math.abs(centered) * 3
    const rotate = -centered * 5.2

    return `translate(-50%, -50%) translate(${x}px, ${y}px) rotate(${rotate}deg)`
  }

  if (seat === 'left') {
    const x = Math.abs(centered) * 3
    const y = centered * 14
    const rotate = centered * 4.8

    return `translate(-50%, -50%) translate(${x}px, ${y}px) rotate(${rotate}deg)`
  }

  const x = -Math.abs(centered) * 3
  const y = centered * 14
  const rotate = -centered * 4.8

  return `translate(-50%, -50%) translate(${x}px, ${y}px) rotate(${rotate}deg)`
}

function renderCardBack(width: number): string {
  return `
    <div
      style="
        position:absolute;
        inset:0;
        border-radius:12px;
        background:
          linear-gradient(135deg, rgba(255,255,255,0.14) 0%, rgba(255,255,255,0.05) 18%, rgba(255,255,255,0.02) 100%),
          linear-gradient(180deg, #21476e 0%, #173454 100%);
        border:1px solid rgba(255,255,255,0.24);
        box-shadow: 0 10px 18px rgba(0,0,0,0.20);
        overflow:hidden;
      "
    >
      <span
        style="
          position:absolute;
          inset:6px;
          border-radius:9px;
          border:1px solid rgba(255,255,255,0.14);
          background:
            radial-gradient(circle at center, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.03) 28%, rgba(255,255,255,0.02) 100%);
        "
      ></span>

      <span
        style="
          position:absolute;
          left:50%;
          top:50%;
          width:${Math.round(width * 0.32)}px;
          height:${Math.round(width * 0.32)}px;
          transform:translate(-50%, -50%) rotate(45deg);
          border:1px solid rgba(245, 187, 55, 0.40);
          background: rgba(245, 187, 55, 0.08);
          border-radius:8px;
        "
      ></span>
    </div>
  `
}

function renderCardFront(width: number): string {
  return `
    <div
      style="
        position:absolute;
        inset:0;
        border-radius:12px;
        background:
          linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(242,247,252,0.98) 100%);
        border:1px solid rgba(11, 33, 56, 0.18);
        box-shadow: 0 10px 18px rgba(0,0,0,0.20);
        overflow:hidden;
      "
    >
      <span
        style="
          position:absolute;
          inset:6px;
          border-radius:9px;
          border:1px solid rgba(15, 36, 58, 0.10);
          background:
            radial-gradient(circle at 50% 34%, rgba(26, 63, 102, 0.05) 0%, rgba(26, 63, 102, 0.02) 34%, rgba(255,255,255,0) 70%);
        "
      ></span>

      <span
        style="
          position:absolute;
          left:10px;
          top:8px;
          color:#173454;
          font-size:13px;
          font-weight:900;
          line-height:1;
          letter-spacing:0.02em;
        "
      >
        ?
      </span>

      <span
        style="
          position:absolute;
          right:10px;
          bottom:8px;
          color:#173454;
          font-size:13px;
          font-weight:900;
          line-height:1;
          letter-spacing:0.02em;
          transform:rotate(180deg);
        "
      >
        ?
      </span>

      <span
        style="
          position:absolute;
          left:50%;
          top:50%;
          width:${Math.round(width * 0.26)}px;
          height:${Math.round(width * 0.26)}px;
          transform:translate(-50%, -50%) rotate(45deg);
          border-radius:8px;
          background: rgba(21, 55, 90, 0.08);
          border:1px solid rgba(21, 55, 90, 0.16);
        "
      ></span>
    </div>
  `
}

function renderSeatFan(seat: Seat, handCount: number): string {
  const totalCards = clampHandCount(handCount)

  if (totalCards <= 0) {
    return ''
  }

  const anchor = getFanAnchor(seat)
  const isFaceUp = seat === 'bottom'
  const cardWidth = seat === 'left' || seat === 'right' ? 58 : 62
  const cardHeight = seat === 'left' || seat === 'right' ? 84 : 90

  const cards = Array.from({ length: totalCards }, (_, index) => {
    const transform = getFanCardTransform(seat, index, totalCards)

    return `
      <div
        style="
          position:absolute;
          left:${anchor.x}px;
          top:${anchor.y}px;
          width:${cardWidth}px;
          height:${cardHeight}px;
          transform:${transform};
          transform-origin:center center;
          z-index:${10 + index};
          pointer-events:none;
        "
      >
        ${isFaceUp ? renderCardFront(cardWidth) : renderCardBack(cardWidth)}
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
        z-index:1;
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
  activeSeat: Seat | null
): string {
  const isActive = seat === activeSeat

  return `
    <div
      style="
        position:relative;
        width:138px;
        height:176px;
        overflow:visible;
        filter:${isActive ? 'drop-shadow(0 0 22px rgba(245, 187, 55, 0.30))' : 'drop-shadow(0 12px 22px rgba(0,0,0,0.22))'};
      "
    >
      ${renderSeatFan(seat, handCount)}

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