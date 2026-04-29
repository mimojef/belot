import type { RoomCardSnapshot, Seat } from "../network/createGameServerClient";
import { CARD_BACK_IMAGE_PATH } from './cardImageAssets';
import { getVisualSeatForLocalPerspective } from "./cutting/cuttingSeatLayout";

type RenderDealingScreenOptions = {
  firstDealSeat: Seat | null;
  selectedCutIndex: number | null;
  localSeat: Seat;
  handCounts: Record<Seat, number>;
  ownHand: RoomCardSnapshot[];
  stageScale: number;
  dealAnimation: RenderDealingAnimationState | null;
  showPackets: boolean;
  dealPhase: 'deal-first-3' | 'deal-next-2' | 'deal-last-3';
};

export type RenderDealingAnimationState = {
  elapsedMs: number;
  totalDurationMs: number;
};

const SERVER_DEAL_ORDER: Seat[] = ["bottom", "right", "top", "left"];

const DEAL_STAGE_WIDTH = 1600;
const DEAL_STAGE_HEIGHT = 900;

const PILE_CENTER_X = DEAL_STAGE_WIDTH / 2;
const PILE_CENTER_Y = DEAL_STAGE_HEIGHT / 2 + 6;

const DEAL_CARD_WIDTH = 195;
const DEAL_CARD_HEIGHT = 284;
const PILE_VISIBLE_CARDS = 10;
const TOTAL_DECK_SIZE = 32;

function getVisiblePileCardCountFromDeckRemaining(deckRemaining: number): number {
  if (deckRemaining <= 0) {
    return 0;
  }

  return Math.max(1, Math.round((deckRemaining / TOTAL_DECK_SIZE) * PILE_VISIBLE_CARDS));
}

export function getPileVisibleCards(handCounts: Record<Seat, number>): number {
  const totalDealt = handCounts.bottom + handCounts.right + handCounts.top + handCounts.left
  const deckRemaining = TOTAL_DECK_SIZE - totalDealt
  return getVisiblePileCardCountFromDeckRemaining(deckRemaining)
}

const DEAL_FIRST_THREE_PACKET_SIZE = 3;
const DEAL_NEXT_TWO_PACKET_SIZE = 2;
const DEAL_LAST_THREE_PACKET_SIZE = 3;
export const DEAL_PACKET_START_DELAY_MS = 120;
export const DEAL_PACKET_DELAY_STEP_MS = 300;
export const DEAL_PACKET_DURATION_MS = 560;

export const DEAL_FIRST_THREE_VISUAL_TOTAL_MS =
  DEAL_PACKET_START_DELAY_MS +
  DEAL_PACKET_DELAY_STEP_MS * 3 +
  DEAL_PACKET_DURATION_MS +
  160;

export const DEAL_NEXT_TWO_VISUAL_TOTAL_MS = DEAL_FIRST_THREE_VISUAL_TOTAL_MS;
export const DEAL_LAST_THREE_VISUAL_TOTAL_MS = DEAL_FIRST_THREE_VISUAL_TOTAL_MS;


function getDealOrder(firstDealSeat: Seat | null): Seat[] {
  if (!firstDealSeat) {
    return [...SERVER_DEAL_ORDER];
  }

  const firstDealIndex = SERVER_DEAL_ORDER.indexOf(firstDealSeat);

  if (firstDealIndex === -1) {
    return [...SERVER_DEAL_ORDER];
  }

  return [
    SERVER_DEAL_ORDER[firstDealIndex],
    SERVER_DEAL_ORDER[(firstDealIndex + 1) % SERVER_DEAL_ORDER.length],
    SERVER_DEAL_ORDER[(firstDealIndex + 2) % SERVER_DEAL_ORDER.length],
    SERVER_DEAL_ORDER[(firstDealIndex + 3) % SERVER_DEAL_ORDER.length],
  ];
}

function getSeatTarget(
  seat: Seat,
  localSeat: Seat,
): { x: number; y: number; rotate: number } {
  const visualSeat = getVisualSeatForLocalPerspective(seat, localSeat);

  if (visualSeat === "bottom") {
    return { x: 800, y: 840, rotate: 0 };
  }

  if (visualSeat === "top") {
    return { x: 800, y: 95, rotate: 0 };
  }

  if (visualSeat === "left") {
    return { x: 95, y: 450, rotate: -90 };
  }

  return { x: 1505, y: 450, rotate: 90 };
}

function getPacketFanOffset(
  index: number,
  packetSize: number,
): { x: number; y: number; rotate: number } {
  const centered = index - (packetSize - 1) / 2;

  return {
    x: centered * 18,
    y: Math.abs(centered) * 4,
    rotate: centered * 5,
  };
}


function renderCardBack(): string {
  return `
    <span
      style="
        position:absolute;
        inset:0;
        border-radius:16px;
        background:linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(241,245,249,0.98) 100%);
      "
    ></span>

    <span
      style="
        position:absolute;
        inset:11px;
        border-radius:12px;
        border:1px solid rgba(15,23,42,0.10);
        background-image:url('${CARD_BACK_IMAGE_PATH}');
        background-size:cover;
        background-position:center;
        background-repeat:no-repeat;
      "
    ></span>
  `;
}


function renderLargeCardShell(content: string, extraStyle = ""): string {
  return `
    <div
      style="
        position:absolute;
        left:50%;
        top:50%;
        width:${DEAL_CARD_WIDTH}px;
        height:${DEAL_CARD_HEIGHT}px;
        border-radius:16px;
        border:1px solid rgba(255,255,255,0.24);
        box-shadow:0 8px 14px rgba(0,0,0,0.12);
        overflow:hidden;
        ${extraStyle}
      "
    >
      ${content}
    </div>
  `;
}

function renderDealingStyles(): string {
  return `
    <style>
      @keyframes belot-deal-packet-fly {
        0% {
          opacity:0;
          transform:translate(-50%, -50%) translate(var(--from-x), var(--from-y)) rotate(0deg);
        }
        14% {
          opacity:1;
          transform:translate(-50%, -50%) translate(var(--from-x), calc(var(--from-y) - 18px)) rotate(-1.2deg);
        }
        82% {
          opacity:1;
          transform:translate(-50%, -50%) translate(var(--to-x), var(--to-y)) rotate(var(--to-r));
        }
        100% {
          opacity:0;
          transform:translate(-50%, -50%) translate(var(--to-x), var(--to-y)) rotate(var(--to-r));
        }
      }

      @keyframes belot-deal-fan-reveal {
        0% {
          opacity:0;
          transform:translate(-50%, -50%) translate(var(--fan-x), var(--fan-y)) rotate(var(--fan-r)) scale(0.985);
        }
        100% {
          opacity:1;
          transform:translate(-50%, -50%) translate(var(--fan-x), var(--fan-y)) rotate(var(--fan-r)) scale(1);
        }
      }

      @keyframes belot-deal-pile-hide {
        0% {
          opacity:1;
        }
        100% {
          opacity:0;
        }
      }
    </style>
  `;
}

export function syncDealingScreenTargets(
  _container: ParentNode,
  _stageScale: number,
): void {
  // Deal positions are rendered in the fixed 1600x900 table coordinate system.
}

// Returns standalone HTML for the deal-first-3 flying packets (styles + packet divs).
// Intended for use with the deal packet overlay, which lives outside root so that
// server snapshot re-renders cannot reset the CSS animations.
export function renderDealFirstThreePacketsHtml(
  firstDealSeat: Seat | null,
  localSeat: Seat,
): string {
  const dealOrder = getDealOrder(firstDealSeat)
  const packets = dealOrder
    .map((seat, index) =>
      renderFlyingPacket(seat, index, localSeat, true, DEAL_FIRST_THREE_PACKET_SIZE),
    )
    .join('')
  return `${renderDealingStyles()}${packets}`
}

function renderPileCard(
  layerIndex: number,
  totalCount: number,
  hideAtMs?: number,
  elapsedMs = 0,
): string {
  const x = 0;
  const y = -layerIndex * 0.5 - (PILE_VISIBLE_CARDS - totalCount) * 0.5;
  const rotate = -4.0;
  const hideAnimationStyle =
    hideAtMs === undefined
      ? ""
      : `
        opacity:1;
        animation:belot-deal-pile-hide 1ms linear ${hideAtMs - elapsedMs}ms both;
      `;

  return renderLargeCardShell(
    renderCardBack(),
    `
      transform:translate(-50%, -50%) translate(${x}px, ${y.toFixed(1)}px) rotate(${rotate}deg);
      z-index:${20 + layerIndex};
      box-shadow:0 1px 2px rgba(0,0,0,0.06);
      ${hideAnimationStyle}
    `,
  );
}

export function renderPile(
  visibleCards = PILE_VISIBLE_CARDS,
  options?: {
    layerHideAtMs?: number[];
    shadowHideAtMs?: number;
    elapsedMs?: number;
  },
): string {
  const count = Math.max(0, Math.min(visibleCards, PILE_VISIBLE_CARDS))

  if (count === 0) {
    return "";
  }

  const elapsedMs = options?.elapsedMs ?? 0
  const shadowAnimationStyle =
    options?.shadowHideAtMs === undefined
      ? ""
      : `
        opacity:1;
        animation:belot-deal-pile-hide 1ms linear ${options.shadowHideAtMs - elapsedMs}ms both;
      `

  return `
    <div
      aria-hidden="true"
      style="
        position:absolute;
        left:${PILE_CENTER_X}px;
        top:${PILE_CENTER_Y}px;
        width:1px;
        height:1px;
        pointer-events:none;
        z-index:30;
      "
    >
      <div
        style="
          position:absolute;
          left:50%;
          top:50%;
          width:238px;
          height:332px;
          transform:translate(-50%, -50%) translate(6px, 18px) rotate(-4deg);
          border-radius:26px;
          background:rgba(0,0,0,0.16);
          filter:blur(12px);
          pointer-events:none;
          ${shadowAnimationStyle}
        "
      ></div>

      ${Array.from({ length: count }, (_, index) =>
        renderPileCard(
          count - index - 1,
          count,
          options?.layerHideAtMs?.[index],
          elapsedMs,
        ),
      ).join("")}
    </div>
  `;
}

function renderPacketCard(index: number, packetSize: number): string {
  const fan = getPacketFanOffset(index, packetSize);

  return renderLargeCardShell(
    renderCardBack(),
    `
      --fan-x:${fan.x}px;
      --fan-y:${fan.y}px;
      --fan-r:${fan.rotate}deg;
      transform:translate(-50%, -50%) translate(var(--fan-x), var(--fan-y)) rotate(var(--fan-r));
      box-shadow:0 8px 14px rgba(0,0,0,0.12);
      z-index:${index + 1};
    `,
  );
}

function renderFlyingPacket(
  seat: Seat,
  index: number,
  localSeat: Seat,
  showPackets: boolean,
  packetSize: number,
): string {
  if (!showPackets) {
    return "";
  }

  const target = getSeatTarget(seat, localSeat);
  const delay = DEAL_PACKET_START_DELAY_MS + index * DEAL_PACKET_DELAY_STEP_MS;
  const targetX = target.x - PILE_CENTER_X;
  const targetY = target.y - PILE_CENTER_Y;

  return `
    <div
      data-deal-packet-seat="${seat}"
      style="
        position:absolute;
        left:${PILE_CENTER_X}px;
        top:${PILE_CENTER_Y}px;
        width:1px;
        height:1px;
        pointer-events:none;
        z-index:${120 + index};
        --from-x:0px;
        --from-y:0px;
        --to-x:${targetX}px;
        --to-y:${targetY}px;
        --to-r:${target.rotate}deg;
        animation:belot-deal-packet-fly ${DEAL_PACKET_DURATION_MS}ms cubic-bezier(0.18, 0.82, 0.22, 1) ${delay}ms both;
      "
    >
      ${Array.from({ length: packetSize }, (_, cardIndex) => renderPacketCard(cardIndex, packetSize)).join("")}
    </div>
  `;
}

function renderDealtFan(
  _seat: Seat,
  _orderIndex: number,
  _localSeat: Seat,
  _handCounts: Record<Seat, number>,
  _ownHand: RoomCardSnapshot[],
  _showPackets: boolean,
): string {
  return "";
}

function renderDealRound(
  firstDealSeat: Seat | null,
  localSeat: Seat,
  handCounts: Record<Seat, number>,
  ownHand: RoomCardSnapshot[],
  showPackets: boolean,
  packetSize: number,
  sequenceName: string,
  elapsedMs: number,
): string {
  const dealOrder = getDealOrder(firstDealSeat);

  // For subsequent deal phases the server already added the new cards to hands, but
  // visually those cards still come FROM the pile only while packets are flying.
  // Once the packets are done, show the real post-deal pile count.
  const shouldShowPreDealPileCount =
    showPackets && (sequenceName === 'deal-next-2' || sequenceName === 'deal-last-3')

  const pileHandCounts = shouldShowPreDealPileCount
    ? {
        bottom: Math.max(0, handCounts.bottom - packetSize),
        right: Math.max(0, handCounts.right - packetSize),
        top: Math.max(0, handCounts.top - packetSize),
        left: Math.max(0, handCounts.left - packetSize),
      }
    : handCounts

  let pileVisibleCards = getPileVisibleCards(pileHandCounts)
  let pileRenderOptions:
    | {
        layerHideAtMs?: number[];
        shadowHideAtMs?: number;
        elapsedMs?: number;
      }
    | undefined

  if (sequenceName === 'deal-last-3' && showPackets) {
    const preDealTotalDealt =
      pileHandCounts.bottom +
      pileHandCounts.right +
      pileHandCounts.top +
      pileHandCounts.left
    const preDealDeckRemaining = TOTAL_DECK_SIZE - preDealTotalDealt
    pileVisibleCards = getVisiblePileCardCountFromDeckRemaining(preDealDeckRemaining)
    pileRenderOptions = {
      layerHideAtMs: Array.from(
        { length: pileVisibleCards },
        (_, index) => DEAL_PACKET_START_DELAY_MS + index * DEAL_PACKET_DELAY_STEP_MS,
      ),
      shadowHideAtMs:
        DEAL_PACKET_START_DELAY_MS + (dealOrder.length - 1) * DEAL_PACKET_DELAY_STEP_MS,
      elapsedMs,
    }
  }

  return `
    <div
      data-active-room-dealing-sequence="${sequenceName}"
      style="
        position:absolute;
        inset:0;
        overflow:visible;
      "
    >
      ${renderPile(pileVisibleCards, pileRenderOptions)}

      ${dealOrder
        .map((seat, index) =>
          renderFlyingPacket(seat, index, localSeat, showPackets, packetSize),
        )
        .join("")}

      ${dealOrder
        .map((seat, index) =>
          renderDealtFan(seat, index, localSeat, handCounts, ownHand, showPackets),
        )
        .join("")}
    </div>
  `;
}

export function renderDealingScreen(
  options: RenderDealingScreenOptions,
): string {
  // The current implementation uses CSS animations for packet movement. The animation
  // cache in the controller decides whether packets should be shown or only the
  // persistent dealt hands should remain visible.
  const _elapsedMs = options.dealAnimation?.elapsedMs ?? 0;
  void options.selectedCutIndex;
  void options.stageScale;

  return `
    ${renderDealingStyles()}

    <section
      style="
        position:relative;
        width:100%;
        height:100%;
        background:
          radial-gradient(circle at center, rgba(74,222,128,0.22) 0%, rgba(34,197,94,0.12) 32%, rgba(21,128,61,0.00) 58%),
          linear-gradient(180deg, rgba(22,101,52,0.98) 0%, rgba(17,94,39,0.99) 100%);
        overflow:visible;
      "
    >
      ${renderDealRound(
        options.firstDealSeat,
        options.localSeat,
        options.handCounts,
        options.ownHand,
        options.showPackets,
        options.dealPhase === 'deal-next-2'
          ? DEAL_NEXT_TWO_PACKET_SIZE
          : options.dealPhase === 'deal-last-3'
            ? DEAL_LAST_THREE_PACKET_SIZE
            : DEAL_FIRST_THREE_PACKET_SIZE,
        options.dealPhase,
        _elapsedMs,
      )}
    </section>
  `;
}
