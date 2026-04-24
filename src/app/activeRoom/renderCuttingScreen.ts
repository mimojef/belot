import {
  type RoomCuttingSnapshot,
} from '../network/createGameServerClient'

type RenderCuttingScreenOptions = {
  cuttingSnapshot: RoomCuttingSnapshot
  cutterDisplayName: string
  isInteractive: boolean
  cutAnimation: RenderCuttingAnimationState | null
}

export type RenderCuttingAnimationState = {
  elapsedMs: number
  totalDurationMs: number
}

const VISUAL_CARD_COUNT = 32
const CARD_WIDTH = 144
const CARD_HEIGHT = 208
const CARD_STEP = 26
const CARD_TOP = 20
const DECK_PADDING_X = 30
const CUT_HOTSPOT_WIDTH = 24
const SELECTED_GAP = 30
const CARD_HOVER_LIFT_PX = 14
const CUTTING_VISUAL_SPLIT_MS = 140
const CUTTING_VISUAL_HOLD_MS = 18
const CUTTING_VISUAL_GATHER_MS = 290
const CUTTING_VISUAL_PILE_SETTLE_MS = 118
export const CUTTING_VISUAL_ANIMATION_TOTAL_MS =
  CUTTING_VISUAL_SPLIT_MS +
  CUTTING_VISUAL_HOLD_MS +
  CUTTING_VISUAL_GATHER_MS +
  CUTTING_VISUAL_PILE_SETTLE_MS

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function mix(from: number, to: number, progress: number): number {
  return from + (to - from) * progress
}

function easeOutCubic(value: number): number {
  const clampedValue = clamp01(value)

  return 1 - (1 - clampedValue) ** 3
}

function easeInOutCubic(value: number): number {
  const clampedValue = clamp01(value)

  if (clampedValue < 0.5) {
    return 4 * clampedValue ** 3
  }

  return 1 - ((-2 * clampedValue + 2) ** 3) / 2
}

function easeOutQuart(value: number): number {
  const clampedValue = clamp01(value)

  return 1 - (1 - clampedValue) ** 4
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function renderCardFace(): string {
  return `
    <span
      style="
        position:absolute;
        inset:0;
        border-radius:18px;
        background:
          linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(226,232,240,0.96) 100%);
      "
    ></span>

    <span
      style="
        position:absolute;
        inset:7px;
        border-radius:14px;
        border:1px solid rgba(226,232,240,0.22);
        background:
          radial-gradient(circle at 30% 20%, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0.02) 34%, transparent 52%),
          linear-gradient(145deg, rgba(31,41,55,0.96) 0%, rgba(15,23,42,0.98) 100%);
      "
    ></span>

    <span
      style="
        position:absolute;
        inset:16px;
        border-radius:12px;
        border:1px solid rgba(148,163,184,0.22);
        background:
          linear-gradient(180deg, rgba(148,163,184,0.06) 0%, rgba(148,163,184,0.00) 100%);
        box-shadow:inset 0 0 0 1px rgba(255,255,255,0.04);
      "
    ></span>

    <span
      style="
        position:absolute;
        left:50%;
        top:20px;
        bottom:20px;
        width:1px;
        transform:translateX(-50%);
        background:linear-gradient(180deg, rgba(250,250,249,0.04) 0%, rgba(250,250,249,0.36) 50%, rgba(250,250,249,0.04) 100%);
      "
    ></span>

    <span
      style="
        position:absolute;
        left:20px;
        right:20px;
        top:50%;
        height:1px;
        transform:translateY(-50%);
        background:linear-gradient(90deg, rgba(250,250,249,0.04) 0%, rgba(250,250,249,0.30) 50%, rgba(250,250,249,0.04) 100%);
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
        border-radius:10px;
        border:1px solid rgba(226,232,240,0.28);
        background:
          linear-gradient(145deg, rgba(203,213,225,0.18) 0%, rgba(255,255,255,0.05) 100%);
        box-shadow:
          inset 0 0 0 1px rgba(255,255,255,0.06),
          0 8px 18px rgba(2,6,23,0.18);
      "
    ></span>
  `
}

function getCardLeft(cardNumber: number, selectedCutIndex: number | null): number {
  const afterSelectedShift =
    selectedCutIndex !== null && cardNumber > selectedCutIndex ? SELECTED_GAP : 0

  return DECK_PADDING_X + (cardNumber - 1) * CARD_STEP + afterSelectedShift
}

function getCutSlotCenter(cutIndex: number, selectedCutIndex: number | null): number {
  if (selectedCutIndex === null) {
    return DECK_PADDING_X + cutIndex * CARD_STEP
  }

  if (cutIndex < selectedCutIndex) {
    return DECK_PADDING_X + cutIndex * CARD_STEP
  }

  if (cutIndex === selectedCutIndex) {
    return DECK_PADDING_X + cutIndex * CARD_STEP + SELECTED_GAP / 2
  }

  return DECK_PADDING_X + cutIndex * CARD_STEP + SELECTED_GAP
}

function buildCutHotspotInteractionHandler(isActive: boolean): string {
  const lineOpacity = isActive ? '0.94' : '0'
  const lineScale = isActive ? '1' : '0.72'
  const lineShadow = isActive
    ? '0 0 0 1px rgba(254,240,138,0.14), 0 0 10px rgba(250,204,21,0.18)'
    : 'none'
  const glowOpacity = isActive ? '0.62' : '0'
  const glowScale = isActive ? '1' : '0.9'

  return `
    const line=this.firstElementChild;
    const glow=this.lastElementChild;
    if(line){
      line.style.opacity='${lineOpacity}';
      line.style.transform='translateX(-50%) scaleY(${lineScale})';
      line.style.boxShadow='${lineShadow}';
    }
    if(glow){
      glow.style.opacity='${glowOpacity}';
      glow.style.transform='translate(-50%, -50%) scale(${glowScale})';
    }
  `
    .replace(/\s+/g, ' ')
    .trim()
}

function buildCutDeckHoverMoveHandler(selectedCutIndex: number | null): string {
  const cardLeftPositions = Array.from(
    { length: VISUAL_CARD_COUNT },
    (_, index) => getCardLeft(index + 1, selectedCutIndex),
  )
  const deckMaxX = cardLeftPositions[cardLeftPositions.length - 1] + CARD_WIDTH

  return `
    const bounds=this.getBoundingClientRect();
    const pointerX=typeof event.clientX === 'number' ? event.clientX - bounds.left : -1;
    const pointerY=typeof event.clientY === 'number' ? event.clientY - bounds.top : -1;
    const activeCard=this.querySelector('.belot-active-room-cutting-card.is-hover-lifted');
    if(
      pointerX < ${DECK_PADDING_X} ||
      pointerX > ${deckMaxX} ||
      pointerY < ${CARD_TOP} ||
      pointerY > ${CARD_TOP + CARD_HEIGHT}
    ){
      if(activeCard){
        activeCard.classList.remove('is-hover-lifted');
      }
      return;
    }
    const cardLeftPositions=${JSON.stringify(cardLeftPositions)};
    let hoverCardNumber=1;
    for(let index=0; index<cardLeftPositions.length; index+=1){
      if(pointerX >= cardLeftPositions[index]){
        hoverCardNumber=index + 1;
        continue;
      }
      break;
    }
    const cards=this.querySelectorAll('.belot-active-room-cutting-card');
    const hoverCard=cards[hoverCardNumber - 1];
    if(activeCard && activeCard !== hoverCard){
      activeCard.classList.remove('is-hover-lifted');
    }
    if(hoverCard){
      hoverCard.classList.add('is-hover-lifted');
    }
  `
    .replace(/\s+/g, ' ')
    .trim()
}

function buildCutDeckHoverLeaveHandler(): string {
  return `
    const activeCard=this.querySelector('.belot-active-room-cutting-card.is-hover-lifted');
    if(activeCard){
      activeCard.classList.remove('is-hover-lifted');
    }
  `
    .replace(/\s+/g, ' ')
    .trim()
}

function renderPileOverlay(
  pileLeft: number,
  pileTop: number,
  pileRevealProgress: number,
  pileSettleProgress: number,
): string {
  if (pileRevealProgress <= 0) {
    return ''
  }

  const pileShadowOpacity = 0.08 + pileRevealProgress * 0.16
  const pileShadowScale = mix(0.92, 1.01, pileSettleProgress)
  const pileCardLift = mix(12, 0, pileRevealProgress)
  const pileOpacity = 0.14 + pileRevealProgress * 0.46
  const layerCount = 5
  const pileLayersHtml = Array.from({ length: layerCount }, (_, index) => {
    const depthProgress = index / Math.max(1, layerCount - 1)
    const offsetX = mix(-3.2, 3.2, depthProgress)
    const offsetY = index * 1.45
    const rotate = mix(-0.9, 0.9, depthProgress)
    const layerOpacity = mix(0.14, 0.34, depthProgress) * pileRevealProgress

    return `
      <span
        style="
          position:absolute;
          inset:0;
          border-radius:20px;
          border:1px solid rgba(226,232,240,0.18);
          background:
            radial-gradient(circle at 28% 20%, rgba(255,255,255,0.14) 0%, rgba(255,255,255,0.02) 32%, transparent 54%),
            linear-gradient(145deg, rgba(31,41,55,0.92) 0%, rgba(15,23,42,0.97) 100%);
          box-shadow:0 4px 10px rgba(2,6,23,0.08);
          opacity:${layerOpacity.toFixed(3)};
          transform:translate(${offsetX.toFixed(2)}px, ${offsetY.toFixed(2)}px) rotate(${rotate.toFixed(2)}deg);
        "
      ></span>
    `
  }).join('')

  return `
    <div
      aria-hidden="true"
      style="
        position:absolute;
        left:${pileLeft - 26}px;
        top:${pileTop + CARD_HEIGHT - 2}px;
        width:${CARD_WIDTH + 52}px;
        height:34px;
        border-radius:999px;
        background:radial-gradient(circle at center, rgba(2,6,23,0.24) 0%, rgba(2,6,23,0.10) 44%, rgba(2,6,23,0.00) 78%);
        filter:blur(6px);
        opacity:${pileShadowOpacity.toFixed(3)};
        transform:scale(${pileShadowScale.toFixed(3)});
      "
    ></div>

    <div
      aria-hidden="true"
      style="
        position:absolute;
        left:${pileLeft}px;
        top:${pileTop - pileCardLift}px;
        width:${CARD_WIDTH}px;
        height:${CARD_HEIGHT}px;
        opacity:${pileOpacity.toFixed(3)};
        transform:translateY(${mix(8, 0, pileSettleProgress).toFixed(2)}px) scale(${mix(0.97, 1, pileSettleProgress).toFixed(3)});
        transform-origin:center center;
        pointer-events:none;
        z-index:0;
      "
    >
      ${pileLayersHtml}
    </div>
  `
}

function renderVisualDeck(
  cuttingSnapshot: RoomCuttingSnapshot,
  cutterDisplayName: string,
  isInteractive: boolean,
  cutAnimation: RenderCuttingAnimationState | null,
): string {
  const validCutCount = Math.max(0, cuttingSnapshot.deckCount - 1)
  const selectedCutIndex = cuttingSnapshot.selectedCutIndex
  const deckTrackWidth = (VISUAL_CARD_COUNT - 1) * CARD_STEP + CARD_WIDTH + SELECTED_GAP
  const tableWidth = DECK_PADDING_X * 2 + deckTrackWidth
  const pileLeft = DECK_PADDING_X + (deckTrackWidth - CARD_WIDTH) / 2
  const pileTop = CARD_TOP + 6
  const animationElapsedMs =
    cutAnimation !== null
      ? Math.max(0, Math.min(cutAnimation.elapsedMs, cutAnimation.totalDurationMs))
      : null
  const isCutAnimationVisible = animationElapsedMs !== null && selectedCutIndex !== null
  const splitProgress = isCutAnimationVisible
    ? easeOutCubic(animationElapsedMs / CUTTING_VISUAL_SPLIT_MS)
    : selectedCutIndex !== null
      ? 1
      : 0
  const gatherProgress = isCutAnimationVisible
    ? easeInOutCubic(
        (animationElapsedMs - CUTTING_VISUAL_SPLIT_MS - CUTTING_VISUAL_HOLD_MS) /
          CUTTING_VISUAL_GATHER_MS,
      )
    : 0
  const pileRevealProgress = isCutAnimationVisible
    ? easeInOutCubic(
        (animationElapsedMs - CUTTING_VISUAL_SPLIT_MS - CUTTING_VISUAL_HOLD_MS + 36) /
          (CUTTING_VISUAL_GATHER_MS + CUTTING_VISUAL_PILE_SETTLE_MS + 24),
      )
    : 0
  const pileSettleProgress = isCutAnimationVisible
    ? easeOutQuart(
        (animationElapsedMs -
          CUTTING_VISUAL_SPLIT_MS -
          CUTTING_VISUAL_HOLD_MS -
          CUTTING_VISUAL_GATHER_MS) /
          CUTTING_VISUAL_PILE_SETTLE_MS,
      )
    : 0
  const markerFadeProgress = isCutAnimationVisible
    ? easeInOutCubic(
        (animationElapsedMs - CUTTING_VISUAL_SPLIT_MS + 36) /
          (CUTTING_VISUAL_HOLD_MS + 120),
      )
    : 0

  const cardsHtml = Array.from({ length: VISUAL_CARD_COUNT }, (_, index) => {
    const cardNumber = index + 1
    const left = getCardLeft(cardNumber, selectedCutIndex)
    const isAdjacentToSelected =
      selectedCutIndex !== null &&
      (cardNumber === selectedCutIndex || cardNumber === selectedCutIndex + 1)
    const borderColor = isAdjacentToSelected
      ? 'rgba(252,211,77,0.58)'
      : 'rgba(255,255,255,0.18)'
    const hoverShadow = isAdjacentToSelected
      ? '0 22px 34px rgba(2,6,23,0.26)'
      : '0 18px 30px rgba(2,6,23,0.24)'
    const shadowFadeProgress = Math.max(gatherProgress * 0.92, pileRevealProgress)
    const shadowOpacity = mix(isAdjacentToSelected ? 0.24 : 0.22, 0.035, shadowFadeProgress)
    const shadowOffsetY = mix(isAdjacentToSelected ? 14 : 10, 4, shadowFadeProgress)
    const shadowBlur = mix(isAdjacentToSelected ? 28 : 22, 8, shadowFadeProgress)
    const shadow = `0 ${shadowOffsetY.toFixed(2)}px ${shadowBlur.toFixed(2)}px rgba(2,6,23,${shadowOpacity.toFixed(3)})`
    const isSplitActive = selectedCutIndex !== null
    const isLeftSplitPile = isSplitActive && cardNumber <= selectedCutIndex
    const splitDistanceFromCut = isSplitActive
      ? isLeftSplitPile
        ? selectedCutIndex - cardNumber
        : cardNumber - selectedCutIndex - 1
      : 0
    const splitEmphasis = isSplitActive
      ? Math.max(0, 1 - splitDistanceFromCut / 12)
      : 0
    const splitDirection = isSplitActive ? (isLeftSplitPile ? -1 : 1) : 0
    const splitX = isSplitActive
      ? splitDirection * Math.round(58 + splitEmphasis * 24)
      : 0
    const splitY = isSplitActive
      ? -Math.round(4 + splitEmphasis * 4)
      : 0
    const splitRotate = isSplitActive
      ? splitDirection * (2.1 + splitEmphasis * 2.4)
      : 0
    const fanCurveX = isSplitActive ? splitDirection * Math.max(0, splitDistanceFromCut - 1) * 1.35 : 0
    const fanCurveY = isSplitActive ? Math.max(0, splitDistanceFromCut - 1) * 0.58 : 0
    const fanCurveRotate = isSplitActive ? splitDirection * Math.max(0, splitDistanceFromCut - 1) * 0.18 : 0
    const spreadTranslateX =
      (splitX + fanCurveX) * splitProgress * (1 - gatherProgress)
    const spreadTranslateY =
      (-splitY + fanCurveY) * -1 * splitProgress * (1 - gatherProgress * 0.92)
    const spreadRotate =
      (splitRotate + fanCurveRotate) * splitProgress * (1 - gatherProgress)
    const pileColumnOffset = ((cardNumber - 1) % 5 - 2) * 1.5
    const pileDepthOffset = Math.floor((cardNumber - 1) / 5) * 0.92
    const pileSideBias = splitDirection * 1.2 * (1 - pileSettleProgress * 0.82)
    const pileRotate = (((cardNumber - 1) % 6) - 2.5) * 0.28 * (1 - pileSettleProgress * 0.46)
    const gatherTranslateX =
      (pileLeft - left + pileColumnOffset + pileSideBias) * gatherProgress
    const gatherTranslateY =
      (pileTop - CARD_TOP + pileDepthOffset - 6 * (1 - pileSettleProgress)) * gatherProgress
    const finalTranslateX = spreadTranslateX + gatherTranslateX
    const finalTranslateY = spreadTranslateY + gatherTranslateY
    const finalRotate = spreadRotate + pileRotate * gatherProgress
    const cardScale = isCutAnimationVisible
      ? mix(1, 0.987 + ((cardNumber - 1) % 4) * 0.002, pileRevealProgress)
      : 1
    const transformOrigin =
      isSplitActive && gatherProgress < 0.84
        ? isLeftSplitPile
          ? 'right bottom'
          : 'left bottom'
        : 'center center'
    const transformTransition = isCutAnimationVisible
      ? 'transform 0ms linear'
      : 'transform 220ms cubic-bezier(0.22, 0.8, 0.3, 1)'

    return `
      <div
        class="belot-active-room-cutting-card"
        data-active-room-cut-card="${cardNumber}"
        style="
          position:absolute;
          left:${left}px;
          top:${CARD_TOP}px;
          width:${CARD_WIDTH}px;
          height:${CARD_HEIGHT}px;
          border:1px solid ${borderColor};
          border-radius:20px;
          overflow:hidden;
          z-index:${index + 1};
          transform-origin:${transformOrigin};
          --belot-cut-card-base-shadow:${shadow};
          --belot-cut-card-hover-shadow:${hoverShadow};
          --belot-cut-card-translate-x:${finalTranslateX.toFixed(2)}px;
          --belot-cut-card-translate-y:${finalTranslateY.toFixed(2)}px;
          --belot-cut-card-rotate:${finalRotate.toFixed(2)}deg;
          --belot-cut-card-scale:${cardScale.toFixed(4)};
          transform:
            translate3d(
              var(--belot-cut-card-translate-x, 0px),
              calc(var(--belot-cut-card-hover-y, 0px) + var(--belot-cut-card-translate-y, 0px)),
              0px
            )
            rotate(var(--belot-cut-card-rotate, 0deg))
            scale(var(--belot-cut-card-scale, 1));
          box-shadow:var(--belot-cut-card-shadow, var(--belot-cut-card-base-shadow));
          filter:var(--belot-cut-card-filter, none);
          will-change:transform;
          backface-visibility:hidden;
          transition:
            ${transformTransition},
            filter 160ms ease,
            border-color 140ms ease,
            box-shadow 160ms ease;
        "
      >
        ${renderCardFace()}
      </div>
    `
  }).join('')

  const cutButtonsHtml = isInteractive
    ? Array.from({ length: validCutCount }, (_, index) => {
        const cutIndex = index + 1
        const slotCenter = getCutSlotCenter(cutIndex, selectedCutIndex)
        const activateHoverHandler = buildCutHotspotInteractionHandler(true)
        const deactivateHoverHandler = buildCutHotspotInteractionHandler(false)

        return `
          <button
            type="button"
            data-active-room-cut-index="${cutIndex}"
            aria-label="Избери място за цепене след карта ${cutIndex}"
            style="
              position:absolute;
              left:${slotCenter - CUT_HOTSPOT_WIDTH / 2}px;
              top:${CARD_TOP - 12}px;
              width:${CUT_HOTSPOT_WIDTH}px;
              height:${CARD_HEIGHT + 24}px;
              padding:0;
              border:none;
              background:transparent;
              cursor:pointer;
              z-index:${VISUAL_CARD_COUNT + 12};
            "
            onmouseenter="${activateHoverHandler}"
            onmouseleave="${deactivateHoverHandler}"
            onfocus="${activateHoverHandler}"
            onblur="${deactivateHoverHandler}"
          >
            <span
              aria-hidden="true"
              style="
                position:absolute;
                left:50%;
                top:14px;
                bottom:14px;
                width:3px;
                border-radius:999px;
                transform:translateX(-50%) scaleY(0.72);
                transform-origin:center;
                background:
                  linear-gradient(180deg, rgba(254,240,138,0.00) 0%, rgba(254,240,138,0.90) 22%, rgba(250,204,21,0.90) 78%, rgba(254,240,138,0.00) 100%);
                opacity:0;
                transition:opacity 120ms ease, transform 120ms ease, box-shadow 120ms ease;
              "
            ></span>

            <span
              aria-hidden="true"
              style="
                position:absolute;
                left:50%;
                top:50%;
                width:22px;
                height:${CARD_HEIGHT - 36}px;
                transform:translate(-50%, -50%) scale(0.9);
                border-radius:999px;
                background:radial-gradient(circle, rgba(250,204,21,0.10) 0%, rgba(250,204,21,0.05) 46%, rgba(250,204,21,0.00) 72%);
                opacity:0;
                transition:opacity 120ms ease, transform 120ms ease;
              "
            ></span>
          </button>
        `
      }).join('')
    : ''

  const selectedMarkerHtml =
    selectedCutIndex !== null && selectedCutIndex <= validCutCount
      ? `
          <div
            aria-hidden="true"
            style="
              position:absolute;
              left:${getCutSlotCenter(selectedCutIndex, selectedCutIndex) - 2}px;
              top:${CARD_TOP - 12}px;
              width:5px;
              height:${CARD_HEIGHT + 24}px;
              border-radius:999px;
              background:
                linear-gradient(180deg, rgba(254,240,138,0.00) 0%, rgba(254,240,138,0.94) 20%, rgba(250,204,21,0.94) 80%, rgba(254,240,138,0.00) 100%);
              box-shadow:
                0 0 0 1px rgba(254,240,138,0.12),
                0 0 14px rgba(250,204,21,0.18);
              opacity:${(1 - markerFadeProgress).toFixed(3)};
              transform:translateY(${mix(0, -18, markerFadeProgress).toFixed(2)}px) scaleY(${mix(1, 0.78, markerFadeProgress).toFixed(3)});
              transform-origin:center center;
              z-index:${VISUAL_CARD_COUNT + 8};
            "
          ></div>
        `
      : ''
  const pileOverlayHtml = renderPileOverlay(
    pileLeft,
    pileTop,
    pileRevealProgress,
    pileSettleProgress,
  )
  const deckHoverMoveHandler = isInteractive
    ? buildCutDeckHoverMoveHandler(selectedCutIndex)
    : ''
  const deckHoverLeaveHandler = isInteractive ? buildCutDeckHoverLeaveHandler() : ''
  const hoverLiftStyles = isInteractive
    ? `
        <style>
          .belot-active-room-cutting-card.is-hover-lifted {
            --belot-cut-card-hover-y:-${CARD_HOVER_LIFT_PX}px;
            --belot-cut-card-filter:brightness(1.04);
            --belot-cut-card-shadow:var(--belot-cut-card-hover-shadow);
          }
        </style>
      `
    : ''

  return `
    ${hoverLiftStyles}

    <section
      style="
        width:100%;
        height:100%;
        padding:40px 44px;
        display:flex;
        align-items:center;
        justify-content:center;
        background:
          radial-gradient(circle at center, rgba(74,222,128,0.22) 0%, rgba(34,197,94,0.12) 32%, rgba(21,128,61,0.00) 58%),
          linear-gradient(180deg, rgba(22,101,52,0.98) 0%, rgba(17,94,39,0.99) 100%);
        overflow:hidden;
      "
    >
      <div
        style="
          width:100%;
          height:100%;
          display:flex;
          flex-direction:column;
          align-items:center;
          justify-content:center;
          gap:26px;
        "
      >
        <div
          style="
            color:#f8fafc;
            font-size:26px;
            font-weight:900;
            letter-spacing:0.02em;
            line-height:1;
            text-align:center;
            text-shadow:0 4px 12px rgba(0,0,0,0.24);
            white-space:nowrap;
          "
        >
          Цепи ${escapeHtml(cutterDisplayName)}
        </div>

        <div
          style="
            min-width:${tableWidth}px;
            height:${CARD_HEIGHT + 42}px;
            position:relative;
          "
          ${isInteractive ? `onmousemove="${deckHoverMoveHandler}" onmouseleave="${deckHoverLeaveHandler}"` : ''}
        >
          <div
            aria-hidden="true"
            style="
              position:absolute;
              left:${mix(DECK_PADDING_X + 10, pileLeft - 24, gatherProgress).toFixed(2)}px;
              top:${mix(CARD_TOP + CARD_HEIGHT - 12, pileTop + CARD_HEIGHT - 4, gatherProgress).toFixed(2)}px;
              width:${mix(deckTrackWidth - 20, CARD_WIDTH + 48, gatherProgress).toFixed(2)}px;
              height:24px;
              border-radius:999px;
              background:
                radial-gradient(circle at center, rgba(2,6,23,0.22) 0%, rgba(2,6,23,0.10) 48%, rgba(2,6,23,0.00) 78%);
              filter:blur(${mix(4, 7, pileRevealProgress).toFixed(2)}px);
              opacity:${mix(1, 0.3, pileRevealProgress).toFixed(3)};
              transform:scaleX(${mix(1, 0.74, gatherProgress).toFixed(3)});
              transform-origin:center center;
            "
          ></div>

          ${pileOverlayHtml}
          ${cardsHtml}
          ${selectedMarkerHtml}
          ${cutButtonsHtml}
        </div>
      </div>
    </section>
  `
}

export function renderCuttingScreen(options: RenderCuttingScreenOptions): string {
  const { cuttingSnapshot, cutterDisplayName, isInteractive, cutAnimation } = options

  return renderVisualDeck(cuttingSnapshot, cutterDisplayName, isInteractive, cutAnimation)
}
