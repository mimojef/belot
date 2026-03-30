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
        z-index:3;
      "
    >
      D
    </div>
  `
}

export function renderSeatPanel(
  seat: Seat,
  _handCount: number,
  dealerSeat: Seat | null,
  _cutterSeat: Seat | null,
  activeSeat: Seat | null
): string {
  const isActive = seat === activeSeat

  return `
    <div
      style="
        width:138px;
        display:flex;
        flex-direction:column;
        align-items:center;
        gap:0;
        filter:${isActive ? 'drop-shadow(0 0 22px rgba(245, 187, 55, 0.30))' : 'drop-shadow(0 12px 22px rgba(0,0,0,0.22))'};
      "
    >
      <div
        style="
          position:relative;
          width:138px;
          height:176px;
          border-radius:12px;
          overflow:hidden;
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