import {
  type RoomAuthoritativePhaseSnapshot,
  type RoomCuttingSnapshot,
  type Seat,
} from '../network/createGameServerClient'

type RenderCuttingScreenOptions = {
  cuttingSnapshot: RoomCuttingSnapshot
  authoritativePhase: RoomAuthoritativePhaseSnapshot | null
  seatLabels: Record<Seat, string>
  escapeHtml: (value: string) => string
  cutterLabel: string
  headingText: string
  infoText: string
  isInteractive: boolean
}

const VISUAL_CARD_COUNT = 32
const CARD_WIDTH = 78
const CARD_HEIGHT = 116
const CARD_STEP = 22

function renderCardFace(index: number): string {
  const accent = index % 2 === 0 ? 'rgba(96,165,250,0.22)' : 'rgba(244,114,182,0.18)'

  return `
    <span
      style="
        position:absolute;
        inset:0;
        border-radius:14px;
        background:
          linear-gradient(180deg, rgba(248,250,252,0.98) 0%, rgba(226,232,240,0.98) 100%);
      "
    ></span>

    <span
      style="
        position:absolute;
        inset:7px;
        border-radius:11px;
        border:1px solid rgba(15,23,42,0.10);
        background:
          radial-gradient(circle at top, ${accent}, transparent 38%),
          linear-gradient(180deg, rgba(255,255,255,0.94) 0%, rgba(241,245,249,0.94) 100%);
      "
    ></span>

    <span
      style="
        position:absolute;
        left:10px;
        top:9px;
        font-size:11px;
        font-weight:900;
        color:#0f172a;
        letter-spacing:0.08em;
      "
    >
      B
    </span>

    <span
      style="
        position:absolute;
        right:10px;
        bottom:9px;
        font-size:11px;
        font-weight:900;
        color:#0f172a;
        letter-spacing:0.08em;
        transform:rotate(180deg);
      "
    >
      B
    </span>

    <span
      style="
        position:absolute;
        left:50%;
        top:50%;
        width:28px;
        height:28px;
        transform:translate(-50%, -50%) rotate(45deg);
        border-radius:7px;
        border:1px solid rgba(30,41,59,0.12);
        background:rgba(255,255,255,0.58);
        box-shadow:0 6px 16px rgba(15,23,42,0.08);
      "
    ></span>
  `
}

function renderVisualDeck(cuttingSnapshot: RoomCuttingSnapshot, isInteractive: boolean): string {
  const validCutCount = Math.max(0, cuttingSnapshot.deckCount - 1)
  const selectedCutIndex = cuttingSnapshot.selectedCutIndex

  const cardsHtml = Array.from({ length: VISUAL_CARD_COUNT }, (_, index) => {
    const cardNumber = index + 1
    const isClickable = isInteractive && cardNumber <= validCutCount
    const isSelected = selectedCutIndex === cardNumber
    const isAfterSelected = selectedCutIndex !== null && cardNumber > selectedCutIndex
    const left = index * CARD_STEP + (isAfterSelected ? 18 : 0)
    const zIndex = index + 1
    const translateY = isSelected ? -10 : 0
    const borderColor = isSelected ? 'rgba(251,191,36,0.78)' : 'rgba(255,255,255,0.42)'
    const shadow = isSelected
      ? '0 18px 36px rgba(15,23,42,0.28)'
      : '0 10px 22px rgba(15,23,42,0.22)'

    if (isClickable) {
      return `
        <button
          type="button"
          data-active-room-cut-index="${cardNumber}"
          aria-label="Избери място за цепене ${cardNumber}"
          style="
            position:absolute;
            left:${left}px;
            top:24px;
            width:${CARD_WIDTH}px;
            height:${CARD_HEIGHT}px;
            padding:0;
            border:1px solid ${borderColor};
            border-radius:16px;
            background:transparent;
            cursor:pointer;
            overflow:hidden;
            z-index:${zIndex};
            transform:translateY(${translateY}px) rotate(${(index - 15.5) * 0.22}deg);
            transform-origin:center bottom;
            box-shadow:${shadow};
            transition:transform 160ms ease, box-shadow 160ms ease, filter 160ms ease, border-color 160ms ease;
          "
          onmouseenter="this.style.transform='translateY(${translateY - 8}px) rotate(${(index - 15.5) * 0.22}deg)';this.style.boxShadow='0 22px 40px rgba(15,23,42,0.30)';this.style.filter='brightness(1.03)';"
          onmouseleave="this.style.transform='translateY(${translateY}px) rotate(${(index - 15.5) * 0.22}deg)';this.style.boxShadow='${shadow}';this.style.filter='brightness(1)';"
        >
          ${renderCardFace(index)}
        </button>
      `
    }

    return `
      <div
        style="
          position:absolute;
          left:${left}px;
          top:24px;
          width:${CARD_WIDTH}px;
          height:${CARD_HEIGHT}px;
          border:1px solid ${borderColor};
          border-radius:16px;
          overflow:hidden;
          z-index:${zIndex};
          transform:translateY(${translateY}px) rotate(${(index - 15.5) * 0.22}deg);
          transform-origin:center bottom;
          box-shadow:${shadow};
        "
      >
        ${renderCardFace(index)}
      </div>
    `
  }).join('')

  const tableWidth = (VISUAL_CARD_COUNT - 1) * CARD_STEP + CARD_WIDTH + 18

  return `
    <section
      style="
        border-radius:28px;
        padding:22px 18px 26px;
        background:
          radial-gradient(circle at center, rgba(74, 222, 128, 0.24) 0%, rgba(22, 101, 52, 0.18) 34%, rgba(6, 78, 59, 0.92) 100%),
          linear-gradient(180deg, rgba(20, 83, 45, 0.96) 0%, rgba(5, 46, 22, 0.98) 100%);
        border:1px solid rgba(134,239,172,0.14);
        box-shadow:
          inset 0 1px 0 rgba(255,255,255,0.05),
          0 24px 60px rgba(2,6,23,0.24);
        overflow-x:auto;
      "
    >
      <div
        style="
          min-width:${tableWidth}px;
          height:${CARD_HEIGHT + 48}px;
          position:relative;
        "
      >
        ${cardsHtml}
      </div>
    </section>
  `
}

export function renderCuttingScreen(options: RenderCuttingScreenOptions): string {
  const { cuttingSnapshot, isInteractive } = options

  return renderVisualDeck(cuttingSnapshot, isInteractive)
}