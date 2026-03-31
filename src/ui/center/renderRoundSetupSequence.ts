import type { Seat } from '../../data/constants/seatOrder'

export type RoundSetupSequencePhase =
  | 'new-game'
  | 'choose-first-dealer'
  | 'cutting'
  | 'cut-resolve'
  | 'deal-first-3'
  | 'deal-next-2'
  | 'deal-last-3'

type RoundSetupSequenceParams = {
  phase: RoundSetupSequencePhase | string
  cutterSeat: Seat | null
  selectedCutIndex: number | null | undefined
}

const CUT_CARD_WIDTH = 130
const CUT_CARD_HEIGHT = 190
const CUT_CARD_TOP = 28

function formatSeatLabel(seat: Seat): string {
  if (seat === 'bottom') return 'ТИ'
  if (seat === 'right') return 'ДЯСНО'
  if (seat === 'top') return 'ГОРЕ'
  if (seat === 'left') return 'ЛЯВО'
  return '—'
}

function clampCutIndex(value: number | null | undefined): number {
  if (!Number.isFinite(value)) {
    return 16
  }

  return Math.max(4, Math.min(28, Math.floor(value as number)))
}

function renderSequenceStyles(): string {
  return `
    <style>
      @keyframes belot-seq-cut-left {
        0% {
          transform: var(--cut-from-transform);
          box-shadow: 0 14px 24px rgba(0,0,0,0.18);
        }
        42% {
          transform: var(--cut-split-transform);
          box-shadow: 0 24px 34px rgba(0,0,0,0.24);
        }
        100% {
          transform: var(--cut-final-transform);
          box-shadow: 0 3px 6px rgba(0,0,0,0.08);
        }
      }

      @keyframes belot-seq-cut-right {
        0% {
          transform: var(--cut-from-transform);
          box-shadow: 0 14px 24px rgba(0,0,0,0.18);
        }
        42% {
          transform: var(--cut-split-transform);
          box-shadow: 0 24px 34px rgba(0,0,0,0.24);
        }
        100% {
          transform: var(--cut-final-transform);
          box-shadow: 0 3px 6px rgba(0,0,0,0.08);
        }
      }
    </style>
  `
}

function renderCardBack(): string {
  return `
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
        width:44px;
        height:44px;
        transform:translate(-50%, -50%) rotate(45deg);
        border:1px solid rgba(245, 187, 55, 0.55);
        background: rgba(245, 187, 55, 0.08);
        border-radius:8px;
      "
    ></span>
  `
}

function buildGatheredTransform(cardNumber: number, selectedCutIndex: number): string {
  const isLeftPile = cardNumber <= selectedCutIndex
  const pileOffset = isLeftPile
    ? selectedCutIndex - cardNumber
    : cardNumber - selectedCutIndex - 1

  const baseX = 6
  const baseY = 12

  if (isLeftPile) {
    return `translateX(-50%) translate(${baseX - 3 - pileOffset * 0.24}px, ${baseY - pileOffset * 0.22}px) rotate(-4.4deg)`
  }

  return `translateX(-50%) translate(${baseX + 3 + pileOffset * 0.24}px, ${baseY - pileOffset * 0.22}px) rotate(-2.2deg)`
}

function renderCutCard(
  index: number,
  shouldAnimateCut: boolean,
  selectedCutIndex: number,
  isHumanCutting: boolean
): string {
  const cardNumber = index + 1
  const centered = index - 15.5
  const translateX = centered * 22
  const translateY = 0
  const rotate = 0
  const cutIndex = Math.max(4, Math.min(28, index + 1))

  const baseTransform = `translateX(-50%) translate(${translateX}px, ${translateY}px) rotate(${rotate}deg)`
  const hoverTransform = `translateX(-50%) translate(${translateX}px, ${translateY - 12}px) rotate(${rotate}deg)`

  const isLeftPile = shouldAnimateCut && cardNumber <= selectedCutIndex
  const pileOffset = shouldAnimateCut
    ? isLeftPile
      ? selectedCutIndex - cardNumber
      : cardNumber - selectedCutIndex - 1
    : 0

  const splitTransform = shouldAnimateCut
    ? isLeftPile
      ? `translateX(-50%) translate(${translateX - 118 - pileOffset * 1.8}px, ${translateY - 10 - pileOffset * 0.8}px) rotate(${rotate - 7}deg)`
      : `translateX(-50%) translate(${translateX + 118 + pileOffset * 1.8}px, ${translateY - 10 - pileOffset * 0.8}px) rotate(${rotate + 7}deg)`
    : baseTransform

  const finalTransform = shouldAnimateCut
    ? buildGatheredTransform(cardNumber, selectedCutIndex)
    : baseTransform

  const animationStyle = shouldAnimateCut
    ? `
      --cut-from-transform:${baseTransform};
      --cut-split-transform:${splitTransform};
      --cut-final-transform:${finalTransform};
      animation:${isLeftPile ? 'belot-seq-cut-left' : 'belot-seq-cut-right'} 860ms cubic-bezier(0.25, 0.8, 0.25, 1) forwards;
    `
    : ''

  return `
    <button
      type="button"
      data-action="cut-card"
      data-cut-index="${cutIndex}"
      ${isHumanCutting && !shouldAnimateCut ? '' : 'disabled'}
      style="
        position:absolute;
        left:50%;
        top:${CUT_CARD_TOP}px;
        width:${CUT_CARD_WIDTH}px;
        height:${CUT_CARD_HEIGHT}px;
        transform:${baseTransform};
        transform-origin:center bottom;
        border-radius:15px;
        border:1px solid rgba(255,255,255,0.28);
        background:
          linear-gradient(135deg, rgba(255,255,255,0.12) 0%, rgba(255,255,255,0.04) 18%, rgba(255,255,255,0.02) 100%),
          linear-gradient(180deg, #21476e 0%, #173454 100%);
        box-shadow: 0 14px 24px rgba(0,0,0,0.18);
        cursor:${isHumanCutting && !shouldAnimateCut ? 'pointer' : 'default'};
        opacity:1;
        outline:none;
        padding:0;
        overflow:hidden;
        transition: transform 160ms ease, box-shadow 160ms ease, border-color 160ms ease, filter 160ms ease;
        filter:brightness(1);
        ${animationStyle}
      "
      ${
        isHumanCutting && !shouldAnimateCut
          ? `
      onmouseenter="this.style.transform='${hoverTransform}'; this.style.boxShadow='0 20px 30px rgba(0,0,0,0.22)'; this.style.filter='brightness(1.08)';"
      onmouseleave="this.style.transform='${baseTransform}'; this.style.boxShadow='0 14px 24px rgba(0,0,0,0.18)'; this.style.filter='brightness(1)';"
      `
          : ''
      }
    >
      ${renderCardBack()}
    </button>
  `
}

function renderStaticGatheredCards(selectedCutIndex: number): string {
  const cards = Array.from({ length: 32 }, (_, index) => {
    const cardNumber = index + 1
    const finalTransform = buildGatheredTransform(cardNumber, selectedCutIndex)

    return `
      <div
        style="
          position:absolute;
          left:50%;
          top:${CUT_CARD_TOP}px;
          width:${CUT_CARD_WIDTH}px;
          height:${CUT_CARD_HEIGHT}px;
          transform:${finalTransform};
          transform-origin:center bottom;
          border-radius:15px;
          background:
            linear-gradient(135deg, rgba(255,255,255,0.12) 0%, rgba(255,255,255,0.04) 18%, rgba(255,255,255,0.02) 100%),
            linear-gradient(180deg, #21476e 0%, #173454 100%);
          border:1px solid rgba(255,255,255,0.24);
          box-shadow: 0 1px 2px rgba(0,0,0,0.05);
          overflow:hidden;
          pointer-events:none;
          z-index:${10 + index};
        "
      >
        ${renderCardBack()}
      </div>
    `
  }).join('')

  return `
    <div
      style="
        position:relative;
        width:100%;
        height:290px;
      "
    >
      <div
        style="
          position:absolute;
          left:50%;
          top:${CUT_CARD_TOP}px;
          width:124px;
          height:176px;
          transform:translateX(-50%) translate(8px, 18px) rotate(-3deg);
          border-radius:18px;
          background:rgba(0,0,0,0.14);
          filter:blur(12px);
          pointer-events:none;
        "
      ></div>

      ${cards}
    </div>
  `
}

export function renderRoundSetupSequence({
  phase,
  cutterSeat,
  selectedCutIndex,
}: RoundSetupSequenceParams): string {
  const isHumanCutting = cutterSeat === 'bottom'
  const isCuttingPhase = phase === 'cutting'
  const isCutResolvePhase = phase === 'cut-resolve'
  const shouldRenderCutSequence = isCuttingPhase || isCutResolvePhase

  if (!shouldRenderCutSequence) {
    return ''
  }

  const normalizedCutIndex = clampCutIndex(selectedCutIndex)
  const shouldAnimateCut =
    isCuttingPhase && selectedCutIndex !== null && selectedCutIndex !== undefined

  const heading = isHumanCutting ? 'ТИ ЦЕПИШ' : `ЦЕПИ ${formatSeatLabel(cutterSeat ?? 'top')}`
  const subText = isCutResolvePhase
    ? 'Тестето е събрано.'
    : shouldAnimateCut
      ? 'Цепене...'
      : isHumanCutting
        ? 'Посочи карта с мишката и щракни там, откъдето искаш да цепиш.'
        : 'Изчаква се автоматично цепене.'

  const cards = isCutResolvePhase
    ? renderStaticGatheredCards(normalizedCutIndex)
    : Array.from({ length: 32 }, (_, index) =>
        renderCutCard(index, shouldAnimateCut, normalizedCutIndex, isHumanCutting)
      ).join('')

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
      ${renderSequenceStyles()}

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
          height:290px;
          margin-top:8px;
          user-select:none;
        "
      >
        ${cards}
      </div>
    </div>
  `
}