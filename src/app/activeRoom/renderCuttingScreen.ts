import {
  type RoomCuttingSnapshot,
} from '../network/createGameServerClient'

type RenderCuttingScreenOptions = {
  cuttingSnapshot: RoomCuttingSnapshot
  cutterDisplayName: string
  isInteractive: boolean
}

const VISUAL_CARD_COUNT = 32
const CARD_WIDTH = 144
const CARD_HEIGHT = 208
const CARD_STEP = 26
const CARD_TOP = 20
const DECK_PADDING_X = 30
const CUT_HOTSPOT_WIDTH = 24
const SELECTED_GAP = 30

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

function renderVisualDeck(
  cuttingSnapshot: RoomCuttingSnapshot,
  cutterDisplayName: string,
  isInteractive: boolean,
): string {
  const validCutCount = Math.max(0, cuttingSnapshot.deckCount - 1)
  const selectedCutIndex = cuttingSnapshot.selectedCutIndex

  const cardsHtml = Array.from({ length: VISUAL_CARD_COUNT }, (_, index) => {
    const cardNumber = index + 1
    const left = getCardLeft(cardNumber, selectedCutIndex)
    const isAdjacentToSelected =
      selectedCutIndex !== null &&
      (cardNumber === selectedCutIndex || cardNumber === selectedCutIndex + 1)
    const borderColor = isAdjacentToSelected
      ? 'rgba(252,211,77,0.58)'
      : 'rgba(255,255,255,0.18)'
    const shadow = isAdjacentToSelected
      ? '0 14px 28px rgba(2,6,23,0.24)'
      : '0 10px 22px rgba(2,6,23,0.22)'

    return `
      <div
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
          box-shadow:${shadow};
          transition:border-color 140ms ease, box-shadow 140ms ease;
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
            onmouseenter="const line=this.firstElementChild;const glow=this.lastElementChild;if(line){line.style.opacity='0.94';line.style.transform='translateX(-50%) scaleY(1)';line.style.boxShadow='0 0 0 1px rgba(254,240,138,0.14), 0 0 10px rgba(250,204,21,0.18)';}if(glow){glow.style.opacity='0.62';glow.style.transform='translate(-50%, -50%) scale(1)';}"
            onmouseleave="const line=this.firstElementChild;const glow=this.lastElementChild;if(line){line.style.opacity='0';line.style.transform='translateX(-50%) scaleY(0.72)';line.style.boxShadow='none';}if(glow){glow.style.opacity='0';glow.style.transform='translate(-50%, -50%) scale(0.9)';}"
            onfocus="const line=this.firstElementChild;const glow=this.lastElementChild;if(line){line.style.opacity='0.94';line.style.transform='translateX(-50%) scaleY(1)';line.style.boxShadow='0 0 0 1px rgba(254,240,138,0.14), 0 0 10px rgba(250,204,21,0.18)';}if(glow){glow.style.opacity='0.62';glow.style.transform='translate(-50%, -50%) scale(1)';}"
            onblur="const line=this.firstElementChild;const glow=this.lastElementChild;if(line){line.style.opacity='0';line.style.transform='translateX(-50%) scaleY(0.72)';line.style.boxShadow='none';}if(glow){glow.style.opacity='0';glow.style.transform='translate(-50%, -50%) scale(0.9)';}"
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
              z-index:${VISUAL_CARD_COUNT + 8};
            "
          ></div>
        `
      : ''

  const deckTrackWidth = (VISUAL_CARD_COUNT - 1) * CARD_STEP + CARD_WIDTH + SELECTED_GAP
  const tableWidth = DECK_PADDING_X * 2 + deckTrackWidth

  return `
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
                radial-gradient(circle at center, rgba(2,6,23,0.22) 0%, rgba(2,6,23,0.10) 48%, rgba(2,6,23,0.00) 78%);
              filter:blur(4px);
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
  const { cuttingSnapshot, cutterDisplayName, isInteractive } = options

  return renderVisualDeck(cuttingSnapshot, cutterDisplayName, isInteractive)
}
