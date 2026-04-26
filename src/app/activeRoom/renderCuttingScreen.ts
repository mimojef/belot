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

export const CUTTING_VISUAL_CARD_COUNT = 32
export const CUTTING_CARD_WIDTH = 195
export const CUTTING_CARD_HEIGHT = 284
export const CUTTING_CARD_STEP = 29
export const CUTTING_CARD_TOP = 0
export const CUTTING_DECK_PADDING_X = 30
export const CUTTING_SELECTED_GAP = 30
export const CUTTING_DECK_TRACK_WIDTH =
  (CUTTING_VISUAL_CARD_COUNT - 1) * CUTTING_CARD_STEP +
  CUTTING_CARD_WIDTH +
  CUTTING_SELECTED_GAP
export const CUTTING_TABLE_WIDTH = CUTTING_DECK_PADDING_X * 2 + CUTTING_DECK_TRACK_WIDTH
export const CUTTING_TABLE_HEIGHT = CUTTING_CARD_HEIGHT + 42
export const CUTTING_PILE_LEFT =
  CUTTING_DECK_PADDING_X + (CUTTING_DECK_TRACK_WIDTH - CUTTING_CARD_WIDTH) / 2
export const CUTTING_PILE_TOP = CUTTING_CARD_TOP + 6
const VISUAL_CARD_COUNT = CUTTING_VISUAL_CARD_COUNT
const CARD_WIDTH = CUTTING_CARD_WIDTH
const CARD_HEIGHT = CUTTING_CARD_HEIGHT
const CARD_STEP = CUTTING_CARD_STEP
const CARD_TOP = CUTTING_CARD_TOP
const DECK_PADDING_X = CUTTING_DECK_PADDING_X
const CUT_HOTSPOT_WIDTH = 24
const SELECTED_GAP = CUTTING_SELECTED_GAP
const CARD_HOVER_LIFT_PX = 14
export const CUTTING_VISUAL_ANIMATION_TOTAL_MS = 860

export type CuttingGatheredCardOffset = {
  x: number
  y: number
  rotate: number
}

export function getCuttingGatheredCardOffset(
  cardNumber: number,
  selectedCutIndex: number,
): CuttingGatheredCardOffset {
  const isLeftPile = cardNumber <= selectedCutIndex
  const pileOffset = isLeftPile
    ? selectedCutIndex - cardNumber
    : cardNumber - selectedCutIndex - 1

  return {
    x: isLeftPile ? 3 - pileOffset * 0.24 : 9 + pileOffset * 0.24,
    y: 12 - pileOffset * 0.22,
    rotate: isLeftPile ? -4.4 : -2.2,
  }
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
        border-radius:24px;
        background:
          linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(241,245,249,0.98) 100%);
      "
    ></span>

    <span
      style="
        position:absolute;
        inset:11px;
        border-radius:20px;
        border:1px solid rgba(15,23,42,0.10);
        background-image:url('/images/cards/card-back.png');
        background-size:cover;
        background-position:center;
        background-repeat:no-repeat;
        overflow:hidden;
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
    const scaleX=bounds.width > 0 && this.offsetWidth > 0 ? bounds.width / this.offsetWidth : 1;
    const scaleY=bounds.height > 0 && this.offsetHeight > 0 ? bounds.height / this.offsetHeight : 1;
    const pointerX=typeof event.clientX === 'number' ? (event.clientX - bounds.left) / scaleX : -1;
    const pointerY=typeof event.clientY === 'number' ? (event.clientY - bounds.top) / scaleY : -1;
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

function renderCuttingAnimationStyles(): string {
  return `
    <style>
      @keyframes belot-active-room-cut-left {
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

      @keyframes belot-active-room-cut-right {
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

function renderVisualDeck(
  cuttingSnapshot: RoomCuttingSnapshot,
  cutterDisplayName: string,
  isInteractive: boolean,
  cutAnimation: RenderCuttingAnimationState | null,
): string {
  const validCutCount = Math.max(0, cuttingSnapshot.deckCount - 1)
  const selectedCutIndex = cuttingSnapshot.selectedCutIndex
  const deckTrackWidth = CUTTING_DECK_TRACK_WIDTH
  const tableWidth = CUTTING_TABLE_WIDTH
  const pileLeft = CUTTING_PILE_LEFT
  const pileTop = CUTTING_PILE_TOP
  const animationElapsedMs =
    cutAnimation !== null
      ? Math.max(0, Math.min(cutAnimation.elapsedMs, cutAnimation.totalDurationMs))
      : null
  const isCutAnimationVisible = animationElapsedMs !== null && selectedCutIndex !== null
  const shouldAnimateCut =
    cutAnimation !== null && isCutAnimationVisible && animationElapsedMs < cutAnimation.totalDurationMs
  const cardPositionSelectedCutIndex =
    selectedCutIndex !== null && !isCutAnimationVisible ? selectedCutIndex : null
  const animationDelayMs = shouldAnimateCut ? -Math.max(0, animationElapsedMs) : 0

  const cardsHtml = Array.from({ length: VISUAL_CARD_COUNT }, (_, index) => {
    const cardNumber = index + 1
    const left = getCardLeft(cardNumber, cardPositionSelectedCutIndex)
    const borderColor = 'rgba(255,255,255,0.28)'
    const hoverShadow = '0 20px 30px rgba(0,0,0,0.22)'
    const shadow = isCutAnimationVisible
      ? '0 3px 6px rgba(0,0,0,0.08)'
      : '0 14px 24px rgba(0,0,0,0.18)'
    const isSplitActive = selectedCutIndex !== null
    const isLeftSplitPile = isSplitActive && cardNumber <= selectedCutIndex
    const splitDistanceFromCut = isSplitActive
      ? isLeftSplitPile
        ? selectedCutIndex - cardNumber
        : cardNumber - selectedCutIndex - 1
      : 0
    const splitDirection = isSplitActive ? (isLeftSplitPile ? -1 : 1) : 0
    const splitX = isSplitActive
      ? splitDirection * (118 + splitDistanceFromCut * 1.8)
      : 0
    const splitY = isSplitActive
      ? -10 + (isLeftSplitPile ? -splitDistanceFromCut * 0.8 : splitDistanceFromCut * 0.8)
      : 0
    const splitRotate = isSplitActive
      ? splitDirection * 7
      : 0
    const pileTarget = getCuttingGatheredCardOffset(cardNumber, selectedCutIndex ?? 16)
    const pileTargetX = pileTarget.x
    const pileTargetY = pileTarget.y
    const pileRotate = pileTarget.rotate
    const finalTranslateX = isSplitActive ? pileLeft - left + pileTargetX : 0
    const finalTranslateY = isSplitActive ? pileTop - CARD_TOP + pileTargetY : 0
    const baseTransform = 'translate(0px, 0px) rotate(0deg)'
    const hoverTransform = `translate(0px, var(--belot-cut-card-hover-y, 0px)) rotate(0deg)`
    const splitTransform = `translate(${splitX.toFixed(2)}px, ${splitY.toFixed(2)}px) rotate(${splitRotate.toFixed(2)}deg)`
    const finalTransform = `translate(${finalTranslateX.toFixed(2)}px, ${finalTranslateY.toFixed(2)}px) rotate(${pileRotate.toFixed(2)}deg)`
    const transform = isCutAnimationVisible ? finalTransform : hoverTransform
    const animationStyle = shouldAnimateCut
      ? `
          --cut-from-transform:${baseTransform};
          --cut-split-transform:${splitTransform};
          --cut-final-transform:${finalTransform};
          animation:${isLeftSplitPile ? 'belot-active-room-cut-left' : 'belot-active-room-cut-right'} ${CUTTING_VISUAL_ANIMATION_TOTAL_MS}ms cubic-bezier(0.25, 0.8, 0.25, 1) ${animationDelayMs.toFixed(2)}ms forwards;
        `
      : ''

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
          border-radius:24px;
          overflow:hidden;
          z-index:${index + 1};
          transform-origin:center bottom;
          --belot-cut-card-base-shadow:${shadow};
          --belot-cut-card-hover-shadow:${hoverShadow};
          transform:${transform};
          box-shadow:var(--belot-cut-card-shadow, var(--belot-cut-card-base-shadow));
          filter:var(--belot-cut-card-filter, brightness(1));
          will-change:transform;
          backface-visibility:hidden;
          transition:
            transform 160ms ease,
            box-shadow 160ms ease,
            border-color 160ms ease,
            filter 160ms ease,
            opacity 160ms ease;
          ${animationStyle}
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

  const selectedMarkerHtml = ''
  const deckHoverMoveHandler = isInteractive
    ? buildCutDeckHoverMoveHandler(selectedCutIndex)
    : ''
  const deckHoverLeaveHandler = isInteractive ? buildCutDeckHoverLeaveHandler() : ''
  const hoverLiftStyles = isInteractive
    ? `
        <style>
          .belot-active-room-cutting-card.is-hover-lifted {
            --belot-cut-card-hover-y:-${CARD_HOVER_LIFT_PX}px;
            --belot-cut-card-filter:brightness(1.08);
            --belot-cut-card-shadow:var(--belot-cut-card-hover-shadow);
          }
        </style>
      `
    : ''

  return `
    ${renderCuttingAnimationStyles()}
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
            font-size:32px;
            font-weight:900;
            letter-spacing:0.02em;
            line-height:1;
            text-align:center;
            white-space:nowrap;
          "
        >
          <span style="color:#f5bb37;text-shadow:0 3px 8px rgba(0,0,0,0.18);">Цепи:</span>
          <span style="color:#020617;text-shadow:0 1px 2px rgba(255,255,255,0.16);">${escapeHtml(cutterDisplayName)}</span>
        </div>

        <div
          style="
            min-width:${tableWidth}px;
            height:${CUTTING_TABLE_HEIGHT}px;
            position:relative;
          "
          ${isInteractive ? `onmousemove="${deckHoverMoveHandler}" onmouseleave="${deckHoverLeaveHandler}"` : ''}
        >
          <div
            aria-hidden="true"
            style="
              position:absolute;
              left:${DECK_PADDING_X + 10}px;
              top:${CARD_TOP + CARD_HEIGHT - 12}px;
              width:${deckTrackWidth - 20}px;
              height:24px;
              border-radius:999px;
              background:
                radial-gradient(circle at center, rgba(2,6,23,0.18) 0%, rgba(2,6,23,0.08) 48%, rgba(2,6,23,0.00) 78%);
              filter:blur(4px);
              opacity:${isCutAnimationVisible ? '0' : '1'};
              transition:opacity 120ms ease;
              transform-origin:center center;
            "
          ></div>

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
