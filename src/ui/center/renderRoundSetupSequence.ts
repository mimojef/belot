import { SEAT_ORDER, type Seat } from '../../data/constants/seatOrder'

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
  dealerSeat?: Seat | null
}

const CUT_CARD_WIDTH = 130
const CUT_CARD_HEIGHT = 190
const CUT_CARD_TOP = 28
const DEAL_PILE_CENTER_TOP = CUT_CARD_TOP + CUT_CARD_HEIGHT / 2
const DEAL_BASE_VISIBLE_CARDS = 10

const DEAL_PACKET_START_DELAY = 220
const DEAL_PACKET_DELAY_STEP = 420
const DEAL_PACKET_DURATION = 860
const DEAL_PACKET_LIFT_OFFSET = Math.round(DEAL_PACKET_DURATION * 0.16)
const DEAL_LAST_PACKET_TAKEOFF_DELAY =
  DEAL_PACKET_START_DELAY + DEAL_PACKET_DELAY_STEP * 3 + DEAL_PACKET_LIFT_OFFSET

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

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

function getDealOrder(dealerSeat: Seat | null | undefined): Seat[] {
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

      @keyframes belot-seq-deal-packet {
        0% {
          opacity: 1;
          transform: var(--deal-from-transform);
          filter: brightness(1);
        }
        8% {
          opacity: 1;
          transform: var(--deal-from-transform);
          filter: brightness(1.01);
        }
        16% {
          opacity: 1;
          transform: var(--deal-lift-transform);
          filter: brightness(1.05);
        }
        82% {
          opacity: 1;
          transform: var(--deal-to-transform);
          filter: brightness(1);
        }
        100% {
          opacity: 0;
          transform: var(--deal-to-transform);
          filter: brightness(1);
        }
      }

      @keyframes belot-seq-packet-spread {
        0% {
          transform:
            translate(-50%, -50%)
            translate(var(--stack-x), var(--stack-y))
            rotate(var(--stack-r));
          box-shadow: 0 8px 14px rgba(0,0,0,0.12);
        }
        12% {
          transform:
            translate(-50%, -50%)
            translate(var(--stack-x), var(--stack-y))
            rotate(var(--stack-r));
          box-shadow: 0 8px 14px rgba(0,0,0,0.12);
        }
        24% {
          transform:
            translate(-50%, -50%)
            translate(var(--fan-x), var(--fan-y))
            rotate(var(--fan-r));
          box-shadow: 0 12px 20px rgba(0,0,0,0.16);
        }
        82% {
          transform:
            translate(-50%, -50%)
            translate(var(--fan-x), var(--fan-y))
            rotate(var(--fan-r));
          box-shadow: 0 12px 20px rgba(0,0,0,0.16);
        }
        100% {
          transform:
            translate(-50%, -50%)
            translate(var(--fan-x), var(--fan-y))
            rotate(var(--fan-r));
          box-shadow: 0 12px 20px rgba(0,0,0,0.16);
        }
      }

      @keyframes belot-seq-pile-disappear {
        0% {
          opacity: 1;
          transform: translateY(0px) scale(1);
          filter: brightness(1);
        }
        100% {
          opacity: 0;
          transform: translateY(-10px) scale(0.94);
          filter: brightness(1.02);
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

function renderStaticGatheredCards(_selectedCutIndex: number): string {
  const visibleCount = 10

  const cards = Array.from({ length: visibleCount }, (_, index) => {
    const layerIndex = visibleCount - index - 1
    const x = layerIndex * 1.5
    const y = 12 - layerIndex * 1.5
    const rotate = -2.8 + layerIndex * 0.14

    return `
      <div
        style="
          position:absolute;
          left:50%;
          top:${CUT_CARD_TOP}px;
          width:${CUT_CARD_WIDTH}px;
          height:${CUT_CARD_HEIGHT}px;
          transform:translateX(-50%) translate(${x.toFixed(2)}px, ${y.toFixed(2)}px) rotate(${rotate.toFixed(2)}deg);
          transform-origin:center bottom;
          border-radius:15px;
          background:
            linear-gradient(135deg, rgba(255,255,255,0.12) 0%, rgba(255,255,255,0.04) 18%, rgba(255,255,255,0.02) 100%),
            linear-gradient(180deg, #21476e 0%, #173454 100%);
          border:1px solid rgba(255,255,255,0.24);
          box-shadow: 0 1px 2px rgba(0,0,0,0.06);
          overflow:hidden;
          pointer-events:none;
          z-index:${20 + index};
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
        overflow:visible;
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

function getFallbackDealTarget(seat: Seat): { x: number; y: number; rotate: number } {
  if (seat === 'top') {
    return { x: 0, y: -330, rotate: 0 }
  }

  if (seat === 'bottom') {
    return { x: 0, y: 345, rotate: 0 }
  }

  if (seat === 'left') {
    return { x: -710, y: 8, rotate: -90 }
  }

  return { x: 710, y: 8, rotate: 90 }
}

function buildDealDeckCardTransform(layerIndex: number): string {
  const x = layerIndex * 0.28
  const y = 18 - layerIndex * 0.55
  const rotate = -2.8 + layerIndex * 0.16

  return `
    translate(-50%, -50%)
    translate(${x.toFixed(2)}px, ${y.toFixed(2)}px)
    rotate(${rotate.toFixed(2)}deg)
  `
    .replace(/\s+/g, ' ')
    .trim()
}

function getDealVisibleCardCount(cardCount: number): number {
  return Math.max(1, Math.min(DEAL_BASE_VISIBLE_CARDS, cardCount))
}

function getPacketFanTransform(
  index: number,
  packetSize: number
): { x: number; y: number; rotate: number } {
  const centered = index - (packetSize - 1) / 2

  return {
    x: centered * 18,
    y: Math.abs(centered) * 4,
    rotate: centered * 5,
  }
}

function buildDealTargetSyncHandler(): string {
  return `
(function() {
  const root = this.closest('[data-round-setup-sequence]');
  const stageElement = document.querySelector('[data-game-stage="1"]');

  if (!root || !stageElement) {
    return;
  }

  const run = () => {
    const stageScale = Number(stageElement.getAttribute('data-stage-scale') || '1') || 1;
    const packetNodes = root.querySelectorAll('[data-deal-packet-seat]');

    packetNodes.forEach((packetNode) => {
      const seat = packetNode.getAttribute('data-deal-packet-seat');
      const rotate = Number(packetNode.getAttribute('data-deal-rotate') || '0');

      if (!seat) {
        return;
      }

      const anchor = document.querySelector('[data-seat-anchor="' + seat + '"]');

      if (!anchor) {
        return;
      }

      const packetRect = packetNode.getBoundingClientRect();
      const anchorRect = anchor.getBoundingClientRect();

      const sourceX = packetRect.left + packetRect.width / 2;
      const sourceY = packetRect.top + packetRect.height / 2;

      let targetX = anchorRect.left + anchorRect.width / 2;
      let targetY = anchorRect.top + anchorRect.height / 2;

      if (seat === 'top') {
        targetY = anchorRect.bottom - anchorRect.height * 0.22;
      } else if (seat === 'bottom') {
        targetY = anchorRect.top + anchorRect.height * 0.22;
      } else if (seat === 'left') {
        targetX = anchorRect.right - anchorRect.width * 0.22;
      } else if (seat === 'right') {
        targetX = anchorRect.left + anchorRect.width * 0.22;
      }

      const dx = (targetX - sourceX) / stageScale;
      const dy = (targetY - sourceY) / stageScale;

      packetNode.style.setProperty(
        '--deal-to-transform',
        'translate(-50%, -50%) translate(' + dx.toFixed(2) + 'px, ' + dy.toFixed(2) + 'px) rotate(' + rotate + 'deg)'
      );
    });
  };

  requestAnimationFrame(() => {
    requestAnimationFrame(run);
  });
}).call(this)
  `.trim()
}

function renderDealingPile(cardCount: number, shouldDisappear = false): string {
  const visibleCount = getDealVisibleCardCount(cardCount)

  const cards = Array.from({ length: visibleCount }, (_, index) => {
    const layerIndex = visibleCount - index - 1
    const transform = buildDealDeckCardTransform(layerIndex)

    return `
      <div
        style="
          position:absolute;
          left:50%;
          top:${DEAL_PILE_CENTER_TOP}px;
          width:${CUT_CARD_WIDTH}px;
          height:${CUT_CARD_HEIGHT}px;
          transform:${transform};
          transform-origin:center bottom;
          border-radius:15px;
          background:
            linear-gradient(135deg, rgba(255,255,255,0.12) 0%, rgba(255,255,255,0.04) 18%, rgba(255,255,255,0.02) 100%),
            linear-gradient(180deg, #21476e 0%, #173454 100%);
          border:1px solid rgba(255,255,255,0.24);
          box-shadow: 0 1px 2px rgba(0,0,0,0.06);
          overflow:hidden;
          pointer-events:none;
          z-index:${20 + index};
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
        height:330px;
        overflow:visible;
        ${shouldDisappear ? `animation: belot-seq-pile-disappear 180ms ease ${DEAL_LAST_PACKET_TAKEOFF_DELAY}ms forwards;` : ''}
      "
    >
      <div
        style="
          position:absolute;
          left:50%;
          top:${DEAL_PILE_CENTER_TOP}px;
          width:132px;
          height:178px;
          transform:translate(-50%, -50%) translate(8px, 20px) rotate(-3deg);
          border-radius:18px;
          background:rgba(0,0,0,0.16);
          filter:blur(12px);
          pointer-events:none;
        "
      ></div>

      ${cards}
    </div>
  `
}

function renderPacketCards(
  packetSize: number,
  visibleBaseCards: number,
  delay: number
): string {
  return Array.from({ length: packetSize }, (_, index) => {
    const stackLayer = visibleBaseCards + index
    const stackX = `${(stackLayer * 0.28).toFixed(2)}px`
    const stackY = `${(18 - stackLayer * 0.55).toFixed(2)}px`
    const stackR = `${(-2.8 + stackLayer * 0.16).toFixed(2)}deg`

    const fan = getPacketFanTransform(index, packetSize)

    return `
      <div
        style="
          position:absolute;
          left:50%;
          top:50%;
          width:${CUT_CARD_WIDTH}px;
          height:${CUT_CARD_HEIGHT}px;
          --stack-x:${stackX};
          --stack-y:${stackY};
          --stack-r:${stackR};
          --fan-x:${fan.x}px;
          --fan-y:${fan.y}px;
          --fan-r:${fan.rotate}deg;
          transform:
            translate(-50%, -50%)
            translate(var(--stack-x), var(--stack-y))
            rotate(var(--stack-r));
          transform-origin:center bottom;
          border-radius:15px;
          background:
            linear-gradient(135deg, rgba(255,255,255,0.12) 0%, rgba(255,255,255,0.04) 18%, rgba(255,255,255,0.02) 100%),
            linear-gradient(180deg, #21476e 0%, #173454 100%);
          border:1px solid rgba(255,255,255,0.24);
          box-shadow: 0 8px 14px rgba(0,0,0,0.12);
          overflow:hidden;
          animation: belot-seq-packet-spread ${DEAL_PACKET_DURATION}ms cubic-bezier(0.2, 0.82, 0.22, 1) ${delay}ms forwards;
        "
      >
        ${renderCardBack()}
      </div>
    `
  }).join('')
}

function renderDealPackets(
  dealerSeat: Seat | null | undefined,
  packetSize: number,
  remainingCardsInPile: number,
  sequenceName: 'deal-first-3' | 'deal-next-2' | 'deal-last-3'
): string {
  const dealOrder = getDealOrder(dealerSeat)
  const syncTargetsHandler = buildDealTargetSyncHandler()
  const safeSyncTargetsHandler = escapeHtmlAttribute(syncTargetsHandler)
  const shouldDisappearPile = sequenceName === 'deal-last-3'
  const visibleBaseCards = getDealVisibleCardCount(remainingCardsInPile)

  const packets = dealOrder.map((seat, index) => {
    const target = getFallbackDealTarget(seat)
    const delay = DEAL_PACKET_START_DELAY + index * DEAL_PACKET_DELAY_STEP
    const fromTransform =
      'translate(-50%, -50%) translate(0px, 0px) rotate(-2.6deg)'
    const liftTransform =
      'translate(-50%, -50%) translate(0px, -18px) rotate(-4deg)'
    const toTransform = `
      translate(-50%, -50%)
      translate(${target.x}px, ${target.y}px)
      rotate(${target.rotate}deg)
    `
      .replace(/\s+/g, ' ')
      .trim()

    return `
      <div
        data-deal-packet-seat="${seat}"
        data-deal-rotate="${target.rotate}"
        style="
          position:absolute;
          left:50%;
          top:${DEAL_PILE_CENTER_TOP}px;
          width:${CUT_CARD_WIDTH + 50}px;
          height:${CUT_CARD_HEIGHT + 50}px;
          transform-origin:center center;
          pointer-events:none;
          z-index:${140 + index};
          opacity:0;
          transform:${fromTransform};
          --deal-from-transform:${fromTransform};
          --deal-lift-transform:${liftTransform};
          --deal-to-transform:${toTransform};
          animation: belot-seq-deal-packet ${DEAL_PACKET_DURATION}ms cubic-bezier(0.18, 0.82, 0.22, 1) ${delay}ms forwards;
        "
      >
        ${renderPacketCards(packetSize, visibleBaseCards, delay)}
      </div>
    `
  }).join('')

  return `
    <div
      data-round-setup-sequence="${sequenceName}"
      style="
        position:relative;
        width:100%;
        height:330px;
        overflow:visible;
      "
    >
      <img
        alt=""
        src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="
        style="display:none"
        onload="${safeSyncTargetsHandler}"
      />

      ${renderDealingPile(remainingCardsInPile, shouldDisappearPile)}
      ${packets}
    </div>
  `
}

function renderDealFirstThreePackets(dealerSeat: Seat | null | undefined): string {
  return renderDealPackets(dealerSeat, 3, 20, 'deal-first-3')
}

function renderDealNextTwoPackets(dealerSeat: Seat | null | undefined): string {
  return renderDealPackets(dealerSeat, 2, 12, 'deal-next-2')
}

function renderDealLastThreePackets(dealerSeat: Seat | null | undefined): string {
  return renderDealPackets(dealerSeat, 3, 12, 'deal-last-3')
}

export function renderRoundSetupSequence({
  phase,
  cutterSeat,
  selectedCutIndex,
  dealerSeat = null,
}: RoundSetupSequenceParams): string {
  const isHumanCutting = cutterSeat === 'bottom'
  const isCuttingPhase = phase === 'cutting'
  const isCutResolvePhase = phase === 'cut-resolve'
  const isDealFirstThreePhase = phase === 'deal-first-3'
  const isDealNextTwoPhase = phase === 'deal-next-2'
  const isDealLastThreePhase = phase === 'deal-last-3'

  const isDealPhase =
    isDealFirstThreePhase || isDealNextTwoPhase || isDealLastThreePhase

  const shouldRenderCutSequence = isCuttingPhase || isCutResolvePhase

  if (
    !shouldRenderCutSequence &&
    !isDealFirstThreePhase &&
    !isDealNextTwoPhase &&
    !isDealLastThreePhase
  ) {
    return ''
  }

  const normalizedCutIndex = clampCutIndex(selectedCutIndex)
  const shouldAnimateCut =
    isCuttingPhase && selectedCutIndex !== null && selectedCutIndex !== undefined

  let heading = isHumanCutting ? 'ТИ ЦЕПИШ' : `ЦЕПИ ${formatSeatLabel(cutterSeat ?? 'top')}`
  let subText = isCutResolvePhase
    ? 'Тестето е събрано.'
    : shouldAnimateCut
      ? 'Цепене...'
      : isHumanCutting
        ? 'Посочи карта с мишката и щракни там, откъдето искаш да цепиш.'
        : 'Изчаква се автоматично цепене.'

  let contentHeight = 290
  let cards = isCutResolvePhase
    ? renderStaticGatheredCards(normalizedCutIndex)
    : Array.from({ length: 32 }, (_, index) =>
        renderCutCard(index, shouldAnimateCut, normalizedCutIndex, isHumanCutting)
      ).join('')

  if (isDealFirstThreePhase) {
    contentHeight = 330
    cards = renderDealFirstThreePackets(dealerSeat)
  }

  if (isDealNextTwoPhase) {
    contentHeight = 330
    cards = renderDealNextTwoPackets(dealerSeat)
  }

  if (isDealLastThreePhase) {
    contentHeight = 330
    cards = renderDealLastThreePackets(dealerSeat)
  }

  return `
    <div
      style="
        width:980px;
        margin:0 auto;
        display:flex;
        flex-direction:column;
        align-items:center;
        gap:12px;
      "
    >
      ${renderSequenceStyles()}

      ${
        isDealPhase
          ? `
      <div
        style="
          font-size:24px;
          line-height:1;
          font-weight:900;
          letter-spacing:0.12em;
          color:#f5bb37;
          text-transform:uppercase;
          visibility:hidden;
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
          visibility:hidden;
        "
      >
        ${subText}
      </div>
      `
          : `
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
      `
      }

      <div
        style="
          position:relative;
          width:900px;
          height:${contentHeight}px;
          margin-top:8px;
          user-select:none;
          overflow:visible;
        "
      >
        ${cards}
      </div>
    </div>
  `
}