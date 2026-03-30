import type { Seat } from '../../data/constants/seatOrder'

function formatSeatLabel(seat: Seat): string {
  if (seat === 'bottom') return 'ТИ'
  if (seat === 'right') return 'ДЯСНО'
  if (seat === 'top') return 'ГОРЕ'
  if (seat === 'left') return 'ЛЯВО'
  return '—'
}

function renderCuttingAnimationStyles(): string {
  return `
    <style>
      @keyframes belot-cut-left {
        0% {
          transform: var(--cut-from-transform);
          box-shadow: 0 14px 24px rgba(0,0,0,0.18);
        }
        38% {
          transform: var(--cut-split-transform);
          box-shadow: 0 24px 34px rgba(0,0,0,0.24);
        }
        100% {
          transform: var(--cut-final-transform);
          box-shadow: 0 16px 28px rgba(0,0,0,0.22);
        }
      }

      @keyframes belot-cut-right {
        0% {
          transform: var(--cut-from-transform);
          box-shadow: 0 14px 24px rgba(0,0,0,0.18);
        }
        38% {
          transform: var(--cut-split-transform);
          box-shadow: 0 24px 34px rgba(0,0,0,0.24);
        }
        100% {
          transform: var(--cut-final-transform);
          box-shadow: 0 16px 28px rgba(0,0,0,0.22);
        }
      }

      @keyframes belot-cut-center-glow {
        0% {
          opacity: 0;
          transform: translateY(18px) scale(0.88);
        }
        45% {
          opacity: 0;
          transform: translateY(18px) scale(0.88);
        }
        100% {
          opacity: 1;
          transform: translateY(0) scale(1);
        }
      }
    </style>
  `
}

export function renderCuttingScreen(
  cutterSeat: Seat | null,
  selectedCutIndex: number | null | undefined
): string {
  const isHumanCutting = cutterSeat === 'bottom'
  const hasSelectedCut = selectedCutIndex !== null && selectedCutIndex !== undefined
  const heading = isHumanCutting ? 'ТИ ЦЕПИШ' : `ЦЕПИ ${formatSeatLabel(cutterSeat ?? 'top')}`
  const subText = hasSelectedCut
    ? 'Цепене...'
    : isHumanCutting
      ? 'Посочи карта с мишката и щракни там, откъдето искаш да цепиш.'
      : 'Изчаква се автоматично цепене.'

  const cards = Array.from({ length: 32 }, (_, index) => {
    const cardNumber = index + 1
    const centered = index - 15.5
    const translateX = centered * 20
    const translateY = Math.abs(centered) * 1.35
    const rotate = centered * 1.28
    const cutIndex = Math.max(4, Math.min(28, index + 1))
    const isSelected = selectedCutIndex === cutIndex

    const baseTransform = `translateX(${translateX}px) translateY(${translateY}px) rotate(${rotate}deg)`
    const hoverTransform = `translateX(${translateX}px) translateY(${translateY - 12}px) rotate(${rotate}deg)`

    const isLeftPile = hasSelectedCut && selectedCutIndex !== null && cardNumber <= selectedCutIndex
    const pileOffset = hasSelectedCut && selectedCutIndex !== null
      ? isLeftPile
        ? selectedCutIndex - cardNumber
        : cardNumber - selectedCutIndex - 1
      : 0

    const splitTransform = hasSelectedCut
      ? isLeftPile
        ? `translateX(${translateX - 118 - pileOffset * 1.8}px) translateY(${translateY - 10 - pileOffset * 0.8}px) rotate(${rotate - 7}deg)`
        : `translateX(${translateX + 118 + pileOffset * 1.8}px) translateY(${translateY - 10 - pileOffset * 0.8}px) rotate(${rotate + 7}deg)`
      : baseTransform

    const finalTransform = hasSelectedCut
      ? isLeftPile
        ? `translateX(${-8 - pileOffset * 0.9}px) translateY(${14 - pileOffset * 0.55}px) rotate(-2deg)`
        : `translateX(${8 + pileOffset * 0.9}px) translateY(${14 - pileOffset * 0.55}px) rotate(2deg)`
      : baseTransform

    const animationStyle = hasSelectedCut
      ? `
          --cut-from-transform:${baseTransform};
          --cut-split-transform:${splitTransform};
          --cut-final-transform:${finalTransform};
          animation:${isLeftPile ? 'belot-cut-left' : 'belot-cut-right'} 860ms cubic-bezier(0.25, 0.8, 0.25, 1) forwards;
        `
      : ''

    return `
      <button
        type="button"
        data-action="cut-card"
        data-cut-index="${cutIndex}"
        ${isHumanCutting && !hasSelectedCut ? '' : 'disabled'}
        style="
          position:absolute;
          left:50%;
          top:18px;
          width:104px;
          height:148px;
          transform:${baseTransform};
          transform-origin:center bottom;
          border-radius:15px;
          border:${isSelected ? '2px solid rgba(245, 187, 55, 1)' : '1px solid rgba(255,255,255,0.28)'};
          background:
            linear-gradient(135deg, rgba(255,255,255,0.12) 0%, rgba(255,255,255,0.04) 18%, rgba(255,255,255,0.02) 100%),
            linear-gradient(180deg, #21476e 0%, #173454 100%);
          box-shadow:
            ${isSelected ? '0 0 0 3px rgba(245, 187, 55, 0.18),' : ''}
            0 14px 24px rgba(0,0,0,0.18);
          cursor:${isHumanCutting && !hasSelectedCut ? 'pointer' : 'default'};
          opacity:1;
          outline:none;
          padding:0;
          overflow:hidden;
          transition: transform 160ms ease, box-shadow 160ms ease, border-color 160ms ease, filter 160ms ease;
          filter:${isSelected ? 'brightness(1.06)' : 'brightness(1)'};
          ${animationStyle}
        "
        ${
          isHumanCutting && !hasSelectedCut
            ? `
        onmouseenter="this.style.transform='${hoverTransform}'; this.style.boxShadow='0 20px 30px rgba(0,0,0,0.22)'; this.style.filter='brightness(1.08)';"
        onmouseleave="this.style.transform='${baseTransform}'; this.style.boxShadow='${isSelected ? '0 0 0 3px rgba(245, 187, 55, 0.18), ' : ''}0 14px 24px rgba(0,0,0,0.18)'; this.style.filter='${isSelected ? 'brightness(1.06)' : 'brightness(1)'}';"
        `
            : ''
        }
      >
        <span
          style="
            position:absolute;
            inset:10px;
            border-radius:10px;
            border:1px solid rgba(255,255,255,0.18);
            background:
              radial-gradient(circle at center, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.03) 28%, rgba(255,255,255,0.02) 100%);
          "
        ></span>

        <span
          style="
            position:absolute;
            left:50%;
            top:50%;
            width:40px;
            height:40px;
            transform:translate(-50%, -50%) rotate(45deg);
            border:1px solid rgba(245, 187, 55, 0.55);
            background: rgba(245, 187, 55, 0.08);
            border-radius:8px;
          "
        ></span>
      </button>
    `
  }).join('')

  const centerStack = hasSelectedCut
    ? `
      <div
        style="
          position:absolute;
          left:50%;
          top:78px;
          width:124px;
          height:164px;
          transform:translateX(-50%);
          pointer-events:none;
          animation: belot-cut-center-glow 860ms ease forwards;
        "
      >
        <div
          style="
            position:absolute;
            inset:10px 0 0 0;
            margin:auto;
            width:98px;
            height:140px;
            border-radius:15px;
            background: rgba(16, 41, 66, 0.28);
            border:1px solid rgba(255,255,255,0.18);
            transform: rotate(-5deg);
          "
        ></div>

        <div
          style="
            position:absolute;
            inset:4px 0 0 0;
            margin:auto;
            width:98px;
            height:140px;
            border-radius:15px;
            background: rgba(16, 41, 66, 0.38);
            border:1px solid rgba(255,255,255,0.22);
            transform: rotate(4deg);
          "
        ></div>

        <div
          style="
            position:absolute;
            inset:0;
            margin:auto;
            width:100px;
            height:142px;
            border-radius:15px;
            background:
              linear-gradient(135deg, rgba(255,255,255,0.12) 0%, rgba(255,255,255,0.04) 18%, rgba(255,255,255,0.02) 100%),
              linear-gradient(180deg, #21476e 0%, #173454 100%);
            border:2px solid rgba(245, 187, 55, 0.42);
            box-shadow: 0 18px 28px rgba(0,0,0,0.18);
          "
        ></div>
      </div>
    `
    : ''

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
      ${renderCuttingAnimationStyles()}

      <div
        style="
          font-size:24px;
          line-height:1;
          font-weight:900;
          letter-spacing:0.12em;
          color:#f5bb37;
          text-transform:uppercase;
        "
      >
        ${heading}
      </div>

      <div
        style="
          font-size:13px;
          font-weight:700;
          color:rgba(239,245,255,0.82);
          text-align:center;
        "
      >
        ${subText}
      </div>

      <div
        style="
          position:relative;
          width:min(92vw, 900px);
          height:260px;
          margin-top:8px;
          user-select:none;
        "
      >
        ${centerStack}
        ${cards}
      </div>
    </div>
  `
}