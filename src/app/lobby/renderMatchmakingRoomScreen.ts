import { getViewportStageMetrics } from '../../ui/layout/viewportStage'

export type MatchmakingRoomPlayer = {
  id: string
  name: string
  avatarUrl?: string | null
  isBot?: boolean
}

export type RenderMatchmakingRoomScreenParams = {
  prizeAmount: number
  entryAmount: number
  localPlayer: MatchmakingRoomPlayer
  joinedPlayers?: MatchmakingRoomPlayer[]
  countdownRemainingMs: number
  countdownTotalMs?: number
  statusText?: string
  titleText?: string
  subtitleText?: string
  canLeave?: boolean
}

type MatchmakingRoomSlot = {
  kind: 'local' | 'player' | 'bot' | 'empty'
  name: string
  avatarUrl: string | null
}

type MatchmakingRoomSlotPosition = 'top' | 'right' | 'bottom' | 'left'

type PositionedMatchmakingRoomSlot = {
  position: MatchmakingRoomSlotPosition
  slot: MatchmakingRoomSlot
}

const DEFAULT_COUNTDOWN_TOTAL_MS = 15000
const ROOM_SIZE = 4

const BACKGROUND_IMAGE_SRC = '/assets/lobby/matchmaking-room-bg.webp'
const COIN_ICON_SRC = '/assets/lobby/icon-coin.png'

const BASE_STAGE_WIDTH = 1671
const BASE_STAGE_HEIGHT = 855
const MAX_STAGE_SCALE = 1
const MIN_STAGE_SCALE = 0.32
const VIEWPORT_HORIZONTAL_PADDING = 0
const VIEWPORT_VERTICAL_PADDING = 0

const SLOT_LAYOUT: Record<
  MatchmakingRoomSlotPosition,
  { left: number; top: number; width: number; height: number }
> = {
  top: { left: 630, top: 169, width: 332, height: 97 },
  right: { left: 951, top: 326, width: 314, height: 92 },
  bottom: { left: 642, top: 481, width: 332, height: 97 },
  left: { left: 326, top: 326, width: 314, height: 92 },
}

function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function formatAmount(value: number): string {
  return new Intl.NumberFormat('bg-BG').format(value)
}

function createEmptySlot(): MatchmakingRoomSlot {
  return {
    kind: 'empty',
    name: 'Чакаме...',
    avatarUrl: null,
  }
}

function createPositionedSlots(
  params: RenderMatchmakingRoomScreenParams,
): PositionedMatchmakingRoomSlot[] {
  const joinedPlayers = (params.joinedPlayers ?? [])
    .filter((player) => player.id !== params.localPlayer.id)
    .slice(0, ROOM_SIZE - 1)

  const otherSlots = joinedPlayers.map<MatchmakingRoomSlot>((player) => ({
    kind: player.isBot ? 'bot' : 'player',
    name: player.name,
    avatarUrl: player.avatarUrl ?? null,
  }))

  const localSlot: MatchmakingRoomSlot = {
    kind: 'local',
    name: params.localPlayer.name,
    avatarUrl: params.localPlayer.avatarUrl ?? null,
  }

  return [
    { position: 'top', slot: otherSlots[0] ?? createEmptySlot() },
    { position: 'right', slot: otherSlots[1] ?? createEmptySlot() },
    { position: 'bottom', slot: localSlot },
    { position: 'left', slot: otherSlots[2] ?? createEmptySlot() },
  ]
}

function renderSlotIcon(slot: MatchmakingRoomSlot): string {
  if (slot.kind === 'empty') {
    return '<span class="mm-spinner" aria-hidden="true"></span>'
  }

  if (slot.avatarUrl) {
    return `
      <img
        src="${escapeHtml(slot.avatarUrl)}"
        alt="${escapeHtml(slot.name)}"
        draggable="false"
        class="mm-avatar-image"
      />
    `
  }

  if (slot.kind === 'bot') {
    return `
      <span class="mm-bot-icon" aria-hidden="true">
        <span class="mm-bot-antenna"></span>
        <span class="mm-bot-head">
          <span></span>
          <span></span>
        </span>
        <span class="mm-bot-mouth"></span>
      </span>
    `
  }

  if (slot.kind === 'local') {
    return '<span class="mm-spade-icon" aria-hidden="true">♠</span>'
  }

  return `
    <span class="mm-person-icon" aria-hidden="true">
      <span></span>
      <span></span>
    </span>
  `
}

function getSlotTitle(slot: MatchmakingRoomSlot): string {
  if (slot.kind === 'local') {
    return 'Ти (Играч)'
  }

  if (slot.kind === 'bot' && slot.name.trim() === 'Чакаме...') {
    return 'Бот-Белот'
  }

  return slot.name
}

function getSlotSubtitle(slot: MatchmakingRoomSlot): string {
  return slot.kind === 'empty' ? 'Търсим играч' : 'Готов'
}

function renderSlot(positionedSlot: PositionedMatchmakingRoomSlot): string {
  const { position, slot } = positionedSlot
  const layout = SLOT_LAYOUT[position]
  const isEmpty = slot.kind === 'empty'
  const title = getSlotTitle(slot)
  const subtitle = getSlotSubtitle(slot)

  return `
    <article
      data-matchmaking-room-slot="${position}"
      data-matchmaking-room-slot-kind="${slot.kind}"
      class="mm-slot mm-slot-${position}${isEmpty ? ' is-empty' : ''}"
      style="
        left:${layout.left}px;
        top:${layout.top}px;
        width:${layout.width}px;
        height:${layout.height}px;
      "
    >
      <div class="mm-slot-icon">
        ${renderSlotIcon(slot)}
      </div>

      <div class="mm-slot-copy">
        <div class="mm-slot-title" title="${escapeHtml(title)}">${escapeHtml(title)}</div>
        <div class="mm-slot-subtitle">${escapeHtml(subtitle)}</div>
      </div>

      ${isEmpty ? '' : '<div class="mm-ready-shield" aria-hidden="true">♦</div>'}
    </article>
  `
}

export function renderMatchmakingRoomScreen(
  params: RenderMatchmakingRoomScreenParams,
): string {
  const countdownTotalMs = Math.max(1, params.countdownTotalMs ?? DEFAULT_COUNTDOWN_TOTAL_MS)
  const countdownRemainingMs = Math.max(
    0,
    Math.min(params.countdownRemainingMs, countdownTotalMs),
  )
  const countdownSeconds = Math.ceil(countdownRemainingMs / 1000)
  const progressDegrees = (countdownRemainingMs / countdownTotalMs) * 360
  const positionedSlots = createPositionedSlots(params)
  const occupiedSlots = positionedSlots.filter(({ slot }) => slot.kind !== 'empty').length
  const { stageScale, scaledStageWidth, scaledStageHeight } =
    getViewportStageMetrics({
      baseWidth: BASE_STAGE_WIDTH,
      baseHeight: BASE_STAGE_HEIGHT,
      minScale: MIN_STAGE_SCALE,
      maxScale: MAX_STAGE_SCALE,
      viewportHorizontalPadding: VIEWPORT_HORIZONTAL_PADDING,
      viewportVerticalPadding: VIEWPORT_VERTICAL_PADDING,
    })

  return `
    <section
      data-matchmaking-room-screen="1"
      data-matchmaking-room-stage-scale="${stageScale.toFixed(4)}"
      class="mm-screen"
    >
      <style>
        [data-matchmaking-room-screen="1"] {
          --mm-gold:#f4c432;
          --mm-gold-soft:#d69b16;
          --mm-green:#20d77a;
          --mm-text:#f7f7f7;
          --mm-muted:rgba(255,255,255,0.72);
        }

        .mm-screen {
          width:100%;
          min-height:100%;
          height:100%;
          display:flex;
          align-items:center;
          justify-content:center;
          background:#000;
          overflow:hidden;
          font-family:Arial, Helvetica, sans-serif;
        }

        .mm-stage-shell {
          position:relative;
          width:${scaledStageWidth}px;
          height:${scaledStageHeight}px;
          flex:0 0 auto;
          overflow:visible;
        }

        .mm-stage {
          position:absolute;
          left:50%;
          top:50%;
          width:${BASE_STAGE_WIDTH}px;
          height:${BASE_STAGE_HEIGHT}px;
          transform:translate(-50%, -50%) scale(${stageScale});
          transform-origin:center center;
          overflow:hidden;
          background:#000 url('${BACKGROUND_IMAGE_SRC}') center / 100% 100% no-repeat;
          color:var(--mm-text);
        }

        .mm-slot {
          position:absolute;
          display:flex;
          align-items:center;
          gap:18px;
          padding:12px 18px;
          border:2px solid rgba(244,196,50,0.94);
          border-radius:14px;
          background:
            linear-gradient(180deg, rgba(255,255,255,0.055), rgba(255,255,255,0.015)),
            rgba(7,8,10,0.91);
          box-shadow:
            0 14px 28px rgba(0,0,0,0.44),
            inset 0 0 26px rgba(255,255,255,0.035),
            0 0 18px rgba(214,155,22,0.14);
        }

        .mm-slot-icon {
          width:74px;
          height:74px;
          flex:0 0 74px;
          display:flex;
          align-items:center;
          justify-content:center;
          border:2px solid var(--mm-gold);
          border-radius:50%;
          background:
            radial-gradient(circle at 34% 28%, rgba(255,231,143,0.32), transparent 30%),
            linear-gradient(180deg, rgba(255,204,58,0.12), rgba(255,204,58,0.02)),
            rgba(14,14,14,0.88);
          color:var(--mm-gold);
          box-shadow:inset 0 0 20px rgba(244,196,50,0.09);
          overflow:hidden;
        }

        .mm-avatar-image {
          width:100%;
          height:100%;
          display:block;
          object-fit:cover;
          border-radius:50%;
          user-select:none;
          -webkit-user-drag:none;
        }

        .mm-slot-copy {
          min-width:0;
          flex:1 1 auto;
        }

        .mm-slot-title {
          color:#ffffff;
          font-size:22px;
          line-height:1.05;
          font-weight:900;
          overflow:hidden;
          text-overflow:ellipsis;
          white-space:nowrap;
          text-shadow:0 2px 2px rgba(0,0,0,0.5);
        }

        .mm-slot-subtitle {
          margin-top:9px;
          color:var(--mm-green);
          font-size:16px;
          line-height:1;
          font-weight:800;
          white-space:nowrap;
          overflow:hidden;
          text-overflow:ellipsis;
        }

        .mm-ready-shield {
          position:absolute;
          right:13px;
          bottom:12px;
          width:30px;
          height:30px;
          display:flex;
          align-items:center;
          justify-content:center;
          border:2px solid var(--mm-gold);
          border-radius:50%;
          color:var(--mm-gold);
          font-size:14px;
          line-height:1;
          box-shadow:inset 0 0 12px rgba(244,196,50,0.10);
        }

        .mm-slot-bottom {
          padding-right:60px;
        }

        .mm-slot-right,
        .mm-slot-top {
          padding-right:58px;
        }

        .mm-slot-left.is-empty {
          padding-right:18px;
        }

        .mm-spinner {
          width:40px;
          height:40px;
          border-radius:50%;
          background:
            repeating-conic-gradient(from 0deg, var(--mm-gold) 0deg 18deg, transparent 18deg 38deg);
          mask:radial-gradient(farthest-side, transparent calc(100% - 8px), #000 0);
          -webkit-mask:radial-gradient(farthest-side, transparent calc(100% - 8px), #000 0);
          animation:mm-spin 1.05s linear infinite;
        }

        .mm-bot-icon {
          position:relative;
          width:46px;
          height:42px;
          display:block;
        }

        .mm-bot-antenna {
          position:absolute;
          left:50%;
          top:0;
          width:8px;
          height:8px;
          border-radius:50%;
          background:linear-gradient(180deg, #ffe78f, #d49a14);
          transform:translateX(-50%);
        }

        .mm-bot-antenna::after {
          content:'';
          position:absolute;
          left:3px;
          top:7px;
          width:2px;
          height:10px;
          background:#d49a14;
        }

        .mm-bot-head {
          position:absolute;
          left:0;
          right:0;
          bottom:0;
          height:31px;
          display:flex;
          align-items:center;
          justify-content:center;
          gap:10px;
          border-radius:9px;
          background:linear-gradient(180deg, #f1c65a, #b98416);
        }

        .mm-bot-head span {
          width:6px;
          height:6px;
          border-radius:50%;
          background:#171717;
        }

        .mm-bot-mouth {
          position:absolute;
          left:18px;
          bottom:7px;
          width:10px;
          height:2px;
          border-radius:999px;
          background:#171717;
        }

        .mm-person-icon {
          position:relative;
          width:48px;
          height:48px;
          display:block;
        }

        .mm-person-icon span:first-child {
          position:absolute;
          left:50%;
          top:2px;
          width:24px;
          height:24px;
          border-radius:50%;
          background:linear-gradient(180deg, #ffe08c, #c9951d);
          transform:translateX(-50%);
        }

        .mm-person-icon span:last-child {
          position:absolute;
          left:5px;
          right:5px;
          bottom:0;
          height:24px;
          border-radius:22px 22px 8px 8px;
          background:linear-gradient(180deg, #e4b442, #a97813);
        }

        .mm-spade-icon {
          display:block;
          color:var(--mm-gold);
          font-size:58px;
          line-height:1;
          transform:translateY(3px);
          text-shadow:0 2px 10px rgba(244,196,50,0.28);
        }

        .mm-countdown-card {
          position:absolute;
          left:1375px;
          top:187px;
          width:177px;
          height:68px;
          display:flex;
          align-items:center;
          justify-content:center;
        }

        .mm-side-countdown {
          position:relative;
          z-index:1;
          text-align:center;
          color:var(--mm-gold);
          font-variant-numeric:tabular-nums;
        }

        .mm-countdown-number {
          display:inline-block;
          font-size:80px;
          line-height:0.88;
          font-weight:900;
          letter-spacing:0;
          text-shadow:0 4px 10px rgba(0,0,0,0.50);
        }

        .mm-countdown-unit {
          display:inline-block;
          margin-left:8px;
          font-size:28px;
          line-height:1;
          font-weight:900;
        }

        .mm-stake-section {
          position:absolute;
          left:1316px;
          top:439px;
          width:282px;
          height:73px;
          display:grid;
          grid-template-rows:22px 1fr;
          color:#ffffff;
          background:rgba(0,0,0,0.58);
          border-radius:4px;
        }

        .mm-stake-title {
          align-self:start;
          justify-self:center;
          color:rgba(255,255,255,0.50);
          font-size:15px;
          line-height:1;
          font-weight:900;
          letter-spacing:0.06em;
          text-transform:uppercase;
        }

        .mm-stake-values {
          position:relative;
          display:grid;
          grid-template-columns:1fr 1fr;
          align-items:start;
        }

        .mm-stake-values::before {
          content:'';
          position:absolute;
          left:50%;
          top:13px;
          bottom:5px;
          width:1px;
          background:rgba(214,155,22,0.52);
          transform:translateX(-50%);
        }

        .mm-stake-item {
          min-width:0;
          display:flex;
          flex-direction:column;
          align-items:center;
          gap:7px;
          text-align:center;
        }

        .mm-stake-label {
          color:rgba(255,255,255,0.58);
          font-size:13px;
          line-height:1;
          font-weight:900;
          letter-spacing:0.04em;
          text-transform:uppercase;
        }

        .mm-stake-amount {
          display:inline-flex;
          align-items:center;
          justify-content:center;
          gap:8px;
          color:#ffffff;
          font-size:23px;
          line-height:1;
          font-weight:400;
          font-variant-numeric:tabular-nums;
          text-shadow:0 2px 4px rgba(0,0,0,0.75);
          white-space:nowrap;
        }

        .mm-stake-amount img {
          width:24px;
          height:24px;
          object-fit:contain;
        }

        .mm-players-section {
          position:absolute;
          left:1371px;
          top:538px;
          width:192px;
          height:38px;
          display:flex;
          align-items:center;
          justify-content:space-between;
          color:#ffffff;
          font-variant-numeric:tabular-nums;
        }

        .mm-players-label {
          color:rgba(255,255,255,0.74);
          font-size:18px;
          line-height:1;
          font-weight:800;
        }

        .mm-players-count {
          color:#ffffff;
          font-size:22px;
          line-height:1;
          font-weight:700;
          text-align:right;
          white-space:nowrap;
        }

        .mm-buttons {
          position:absolute;
          left:642px;
          top:731px;
          display:flex;
        }

        .mm-action-button {
          width:366px;
          height:58px;
          border-radius:9px;
          font-size:18px;
          line-height:1;
          font-weight:900;
          letter-spacing:0.05em;
          text-transform:uppercase;
          cursor:pointer;
          transition:transform 120ms ease, filter 120ms ease, box-shadow 120ms ease;
        }

        .mm-action-button:hover {
          transform:translateY(-1px);
          filter:brightness(1.06);
        }

        .mm-action-button:active {
          transform:translateY(1px);
        }

        .mm-button-cancel {
          border:2px solid var(--mm-gold-soft);
          background:rgba(0,0,0,0.78);
          color:var(--mm-gold);
          box-shadow:0 0 20px rgba(214,155,22,0.10);
        }

        .mm-button-cancel.is-disabled {
          opacity:0.35;
          cursor:not-allowed;
          pointer-events:none;
        }

        .mm-button-lobby {
          border:0;
          background:linear-gradient(180deg, #f3c64a 0%, #d99b1c 100%);
          color:#111111;
          box-shadow:0 12px 24px rgba(214,155,22,0.20);
        }

        @keyframes mm-spin {
          to {
            transform:rotate(360deg);
          }
        }
      </style>

      <div class="mm-stage-shell">
        <div class="mm-stage">
          ${positionedSlots.map((slot) => renderSlot(slot)).join('')}

          <div class="mm-countdown-card">
            <div
              data-matchmaking-progress-bar="1"
              style="display:none; --matchmaking-progress:${progressDegrees}deg;"
              aria-hidden="true"
            ></div>

            <div data-matchmaking-countdown-text="1" class="mm-side-countdown">
              <span class="mm-countdown-number">${countdownSeconds}</span>
              <span class="mm-countdown-unit">сек</span>
            </div>
          </div>

          <div class="mm-stake-section">
            <div class="mm-stake-title">Залог</div>
            <div class="mm-stake-values">
              <div class="mm-stake-item">
                <div class="mm-stake-label">Вход</div>
                <div class="mm-stake-amount">
                  <span>${escapeHtml(formatAmount(params.entryAmount))}</span>
                  <img src="${COIN_ICON_SRC}" alt="" draggable="false" />
                </div>
              </div>
              <div class="mm-stake-item">
                <div class="mm-stake-label">Награда</div>
                <div class="mm-stake-amount">
                  <span>${escapeHtml(formatAmount(params.prizeAmount))}</span>
                  <img src="${COIN_ICON_SRC}" alt="" draggable="false" />
                </div>
              </div>
            </div>
          </div>

          <div class="mm-players-section">
            <div class="mm-players-label">Играчи</div>
            <div class="mm-players-count">${occupiedSlots} / ${ROOM_SIZE}</div>
          </div>

          <div class="mm-buttons">
            <button
              type="button"
              data-matchmaking-room-cancel-button="1"
              class="mm-action-button mm-button-cancel${params.canLeave === false ? ' is-disabled' : ''}"
              ${params.canLeave === false ? 'disabled' : ''}
            >
              Отказ
            </button>
          </div>
        </div>
      </div>
    </section>
  `
}
