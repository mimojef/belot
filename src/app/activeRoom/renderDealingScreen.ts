import type { RoomCardSnapshot, Seat } from "../network/createGameServerClient";
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
  dealPhase: 'deal-first-3' | 'deal-next-2';
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

const DEAL_FIRST_THREE_PACKET_SIZE = 3;
const DEAL_NEXT_TWO_PACKET_SIZE = 2;
export const DEAL_PACKET_START_DELAY_MS = 120;
export const DEAL_PACKET_DELAY_STEP_MS = 300;
const DEAL_PACKET_DURATION_MS = 560;

export const DEAL_FIRST_THREE_VISUAL_TOTAL_MS =
  DEAL_PACKET_START_DELAY_MS +
  DEAL_PACKET_DELAY_STEP_MS * 3 +
  DEAL_PACKET_DURATION_MS +
  160;

export const DEAL_NEXT_TWO_VISUAL_TOTAL_MS = DEAL_FIRST_THREE_VISUAL_TOTAL_MS;


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
        border-radius:24px;
        background:linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(241,245,249,0.98) 100%);
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
        border-radius:24px;
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
          opacity:1;
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
    </style>
  `;
}

export function syncDealingScreenTargets(
  _container: ParentNode,
  _stageScale: number,
): void {
  // Deal positions are rendered in the fixed 1600x900 table coordinate system.
}

function renderPileCard(layerIndex: number): string {
  const x = layerIndex * 0.35;
  const y = 18 - layerIndex * 0.58;
  const rotate = -2.6 + layerIndex * 0.16;

  return renderLargeCardShell(
    renderCardBack(),
    `
      transform:translate(-50%, -50%) translate(${x.toFixed(2)}px, ${y.toFixed(2)}px) rotate(${rotate.toFixed(2)}deg);
      z-index:${20 + layerIndex};
      box-shadow:0 1px 2px rgba(0,0,0,0.06);
    `,
  );
}

function renderPile(): string {
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
          transform:translate(-50%, -50%) translate(8px, 20px) rotate(-3deg);
          border-radius:26px;
          background:rgba(0,0,0,0.16);
          filter:blur(12px);
          pointer-events:none;
        "
      ></div>

      ${Array.from({ length: PILE_VISIBLE_CARDS }, (_, index) =>
        renderPileCard(PILE_VISIBLE_CARDS - index - 1),
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
        animation:belot-deal-packet-fly ${DEAL_PACKET_DURATION_MS}ms cubic-bezier(0.18, 0.82, 0.22, 1) ${delay}ms forwards;
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
): string {
  const dealOrder = getDealOrder(firstDealSeat);

  return `
    <div
      data-active-room-dealing-sequence="${sequenceName}"
      style="
        position:absolute;
        inset:0;
        overflow:visible;
      "
    >
      ${renderPile()}

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
  void _elapsedMs;
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
        options.dealPhase === 'deal-next-2' ? DEAL_NEXT_TWO_PACKET_SIZE : DEAL_FIRST_THREE_PACKET_SIZE,
        options.dealPhase,
      )}
    </section>
  `;
}
