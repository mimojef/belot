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
}

type MatchmakingRoomSlot = {
  kind: 'local' | 'player' | 'bot' | 'empty'
  name: string
  avatarUrl: string | null
  badgeText: string
}

const DEFAULT_COUNTDOWN_TOTAL_MS = 15000
const ROOM_SIZE = 4

const BASE_STAGE_WIDTH = 900
const BASE_STAGE_HEIGHT = 430
const MAX_STAGE_SCALE = 1.08
const MIN_STAGE_SCALE = 0.58
const VIEWPORT_HORIZONTAL_PADDING = 28
const VIEWPORT_VERTICAL_PADDING = 28
const RESERVED_TOP_SPACE = 54

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

function getInitials(name: string): string {
  const parts = String(name)
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)

  if (parts.length === 0) {
    return '?'
  }

  return parts
    .map((part) => part.charAt(0).toUpperCase())
    .join('')
}

function createSlots(params: RenderMatchmakingRoomScreenParams): MatchmakingRoomSlot[] {
  const joinedPlayers = (params.joinedPlayers ?? []).filter(
    (player) => player.id !== params.localPlayer.id,
  )

  const slots: MatchmakingRoomSlot[] = [
    {
      kind: 'local',
      name: params.localPlayer.name,
      avatarUrl: params.localPlayer.avatarUrl ?? null,
      badgeText: 'ТИ',
    },
  ]

  for (const player of joinedPlayers) {
    if (slots.length >= ROOM_SIZE) {
      break
    }

    slots.push({
      kind: player.isBot ? 'bot' : 'player',
      name: player.name,
      avatarUrl: player.avatarUrl ?? null,
      badgeText: 'ИГРАЧ',
    })
  }

  while (slots.length < ROOM_SIZE) {
    slots.push({
      kind: 'empty',
      name: 'Свободно място',
      avatarUrl: null,
      badgeText: 'ЧАКА',
    })
  }

  return slots
}

function renderAvatar(slot: MatchmakingRoomSlot): string {
  if (slot.kind === 'empty') {
    return `
      <div
        style="
          width:100%;
          height:100%;
          display:flex;
          align-items:center;
          justify-content:center;
          border-radius:12px;
          border:2px dashed rgba(255,255,255,0.13);
          background:
            linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.02));
          color:rgba(255,255,255,0.20);
          font-size:28px;
          font-weight:900;
        "
      >
        ?
      </div>
    `
  }

  if (slot.avatarUrl) {
    return `
      <img
        src="${escapeHtml(slot.avatarUrl)}"
        alt="${escapeHtml(slot.name)}"
        draggable="false"
        style="
          width:100%;
          height:100%;
          display:block;
          object-fit:cover;
          border-radius:12px;
          user-select:none;
          -webkit-user-drag:none;
          background:#173a70;
        "
      />
    `
  }

  return `
    <div
      style="
        width:100%;
        height:100%;
        display:flex;
        align-items:center;
        justify-content:center;
        border-radius:12px;
        background:
          radial-gradient(circle at 30% 25%, rgba(255,196,64,0.20), transparent 36%),
          linear-gradient(180deg, rgba(255,255,255,0.10), rgba(255,255,255,0.04)),
          #173a70;
        color:#ffffff;
        font-size:22px;
        font-weight:900;
        letter-spacing:0.04em;
      "
    >
      ${escapeHtml(getInitials(slot.name))}
    </div>
  `
}

function renderSlot(slot: MatchmakingRoomSlot, index: number): string {
  const isLocal = slot.kind === 'local'
  const isEmpty = slot.kind === 'empty'

  const borderColor = isLocal
    ? 'rgba(255, 171, 23, 0.95)'
    : isEmpty
      ? 'rgba(255,255,255,0.10)'
      : 'rgba(255,255,255,0.16)'

  const badgeBackground =
    slot.kind === 'local'
      ? 'linear-gradient(180deg, #ffc94a 0%, #ff9f0a 100%)'
      : slot.kind === 'player' || slot.kind === 'bot'
        ? 'linear-gradient(180deg, #66c2ff 0%, #2f7ff0 100%)'
        : 'linear-gradient(180deg, rgba(255,255,255,0.20), rgba(255,255,255,0.10))'

  const badgeTextColor = slot.kind === 'empty' ? '#ffffff' : '#0b1e3f'
  const titleColor = isEmpty ? 'rgba(255,255,255,0.56)' : '#ffffff'
  const subLabel = isLocal
    ? 'Твоят профил'
    : slot.kind === 'player' || slot.kind === 'bot'
      ? 'Играч в стаята'
      : 'Очаква се играч'

  const avatarTopSpacing = isEmpty ? 10 : 0

  return `
    <div
      data-matchmaking-room-slot="${index}"
      data-matchmaking-room-slot-kind="${slot.kind}"
      style="
        position:relative;
        min-width:0;
        border-radius:16px;
        padding:6px;
        background:
          linear-gradient(180deg, rgba(255,255,255,0.08), rgba(255,255,255,0.03)),
          linear-gradient(180deg, rgba(8,28,60,0.92), rgba(6,23,48,0.96));
        border:1px solid ${borderColor};
        box-shadow:
          0 10px 24px rgba(0,0,0,0.22),
          ${isLocal ? '0 0 0 1px rgba(255,171,23,0.18)' : '0 0 0 0 transparent'};
      "
    >
      <div
        style="
          position:absolute;
          top:6px;
          left:6px;
          z-index:3;
          min-width:42px;
          height:18px;
          padding:0 8px;
          display:inline-flex;
          align-items:center;
          justify-content:center;
          border-radius:999px;
          background:${badgeBackground};
          color:${badgeTextColor};
          font-size:9px;
          font-weight:900;
          letter-spacing:0.08em;
          text-transform:uppercase;
        "
      >
        ${escapeHtml(slot.badgeText)}
      </div>

      <div
        style="
          width:100%;
          aspect-ratio:1 / 1;
          border-radius:12px;
          overflow:hidden;
          background:#14335f;
          padding-top:${avatarTopSpacing}px;
          box-sizing:border-box;
        "
      >
        ${renderAvatar(slot)}
      </div>

      <div style="padding:6px 3px 1px;">
        <div
          title="${escapeHtml(slot.name)}"
          style="
            color:${titleColor};
            font-size:12px;
            font-weight:800;
            line-height:1.12;
            white-space:nowrap;
            overflow:hidden;
            text-overflow:ellipsis;
          "
        >
          ${escapeHtml(slot.name)}
        </div>

        <div
          style="
            margin-top:3px;
            color:rgba(255,255,255,0.62);
            font-size:10px;
            line-height:1.18;
            font-weight:600;
          "
        >
          ${escapeHtml(subLabel)}
        </div>
      </div>
    </div>
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
  const progressPercent = Math.round((countdownRemainingMs / countdownTotalMs) * 100)

  const slots = createSlots(params)
  const emptyCount = ROOM_SIZE - slots.filter((slot) => slot.kind !== 'empty').length

  const titleText = params.titleText ?? 'Търсене на игра'
  const subtitleText =
    params.subtitleText ??
    'Изчакваме още играчи. Ако времето изтече, свободните места ще бъдат попълнени автоматично.'

  const statusText =
    params.statusText ??
    (emptyCount === 0
      ? 'Масата е пълна. Играта стартира.'
      : emptyCount === 1
        ? 'Чакаме още 1 играч...'
        : `Чакаме още ${emptyCount} играчи...`)

  const { stageScale, scaledStageWidth, scaledStageHeight } =
    getViewportStageMetrics({
      baseWidth: BASE_STAGE_WIDTH,
      baseHeight: BASE_STAGE_HEIGHT,
      minScale: MIN_STAGE_SCALE,
      maxScale: MAX_STAGE_SCALE,
      viewportHorizontalPadding: VIEWPORT_HORIZONTAL_PADDING,
      viewportVerticalPadding: VIEWPORT_VERTICAL_PADDING,
      reservedTopSpace: RESERVED_TOP_SPACE,
    })

  return `
    <section
      data-matchmaking-room-screen="1"
      data-matchmaking-room-stage-scale="${stageScale.toFixed(4)}"
      style="
        width:100%;
        min-height:100%;
        box-sizing:border-box;
        padding:${VIEWPORT_VERTICAL_PADDING / 2}px ${VIEWPORT_HORIZONTAL_PADDING / 2}px;
        display:flex;
        align-items:flex-start;
        justify-content:center;
        background:
          radial-gradient(circle at 50% 18%, rgba(39,104,196,0.26), transparent 34%),
          radial-gradient(circle at 50% 72%, rgba(255,170,0,0.08), transparent 30%),
          linear-gradient(180deg, #0a2247 0%, #0b2857 46%, #0a2147 100%);
        overflow:hidden;
      "
    >
      <div
        style="
          position:relative;
          width:${scaledStageWidth}px;
          height:${scaledStageHeight}px;
          flex:0 0 auto;
        "
      >
        <div
          style="
            position:absolute;
            left:50%;
            top:0;
            width:${BASE_STAGE_WIDTH}px;
            height:${BASE_STAGE_HEIGHT}px;
            transform:translateX(-50%) scale(${stageScale});
            transform-origin:top center;
          "
        >
          <div
            style="
              width:100%;
              height:100%;
              display:flex;
              flex-direction:column;
              gap:12px;
            "
          >
            <div
              style="
                display:flex;
                align-items:flex-start;
                justify-content:space-between;
                gap:10px;
                flex-wrap:wrap;
                padding:14px 16px;
                border-radius:18px;
                border:1px solid rgba(255,255,255,0.12);
                background:
                  linear-gradient(180deg, rgba(255,255,255,0.08), rgba(255,255,255,0.03)),
                  linear-gradient(180deg, rgba(8,28,60,0.88), rgba(6,23,48,0.94));
                box-shadow:0 12px 28px rgba(0,0,0,0.22);
              "
            >
              <div style="min-width:220px; max-width:540px;">
                <div
                  style="
                    color:#ffffff;
                    font-size:22px;
                    line-height:1.02;
                    font-weight:900;
                    letter-spacing:0.01em;
                  "
                >
                  ${escapeHtml(titleText)}
                </div>

                <div
                  style="
                    margin-top:6px;
                    color:rgba(255,255,255,0.74);
                    font-size:11px;
                    line-height:1.4;
                    font-weight:600;
                  "
                >
                  ${escapeHtml(subtitleText)}
                </div>
              </div>

              <div
                style="
                  display:grid;
                  grid-template-columns:repeat(2, minmax(118px, 1fr));
                  gap:8px;
                  min-width:254px;
                "
              >
                <div
                  data-matchmaking-prize-card="1"
                  style="
                    padding:9px 11px;
                    border-radius:14px;
                    border:1px solid rgba(255,193,56,0.26);
                    background:
                      linear-gradient(180deg, rgba(255,191,56,0.16), rgba(255,149,0,0.08)),
                      rgba(11,28,57,0.72);
                  "
                >
                  <div
                    style="
                      color:rgba(255,255,255,0.68);
                      font-size:10px;
                      font-weight:800;
                      letter-spacing:0.10em;
                      text-transform:uppercase;
                    "
                  >
                    Награда
                  </div>

                  <div
                    style="
                      margin-top:6px;
                      color:#ffffff;
                      font-size:20px;
                      line-height:1;
                      font-weight:900;
                    "
                  >
                    ${escapeHtml(formatAmount(params.prizeAmount))}
                  </div>
                </div>

                <div
                  data-matchmaking-entry-card="1"
                  style="
                    padding:9px 11px;
                    border-radius:14px;
                    border:1px solid rgba(255,255,255,0.12);
                    background:
                      linear-gradient(180deg, rgba(255,255,255,0.06), rgba(255,255,255,0.02)),
                      rgba(11,28,57,0.72);
                  "
                >
                  <div
                    style="
                      color:rgba(255,255,255,0.68);
                      font-size:10px;
                      font-weight:800;
                      letter-spacing:0.10em;
                      text-transform:uppercase;
                    "
                  >
                    Вход
                  </div>

                  <div
                    style="
                      margin-top:6px;
                      color:#ffffff;
                      font-size:20px;
                      line-height:1;
                      font-weight:900;
                    "
                  >
                    ${escapeHtml(formatAmount(params.entryAmount))}
                  </div>
                </div>
              </div>
            </div>

            <div
              style="
                display:grid;
                grid-template-columns:repeat(4, minmax(0, 1fr));
                gap:10px;
              "
            >
              ${slots.map((slot, index) => renderSlot(slot, index)).join('')}
            </div>

            <div
              style="
                padding:14px 16px 16px;
                border-radius:18px;
                border:1px solid rgba(255,255,255,0.12);
                background:
                  linear-gradient(180deg, rgba(255,255,255,0.08), rgba(255,255,255,0.03)),
                  linear-gradient(180deg, rgba(8,28,60,0.88), rgba(6,23,48,0.94));
                box-shadow:0 12px 28px rgba(0,0,0,0.22);
              "
            >
              <div
                style="
                  display:flex;
                  align-items:center;
                  justify-content:space-between;
                  gap:12px;
                  flex-wrap:wrap;
                "
              >
                <div>
                  <div
                    style="
                      color:#ffffff;
                      font-size:15px;
                      line-height:1.1;
                      font-weight:900;
                    "
                  >
                    ${escapeHtml(statusText)}
                  </div>

                  <div
                    style="
                      margin-top:4px;
                      color:rgba(255,255,255,0.66);
                      font-size:10px;
                      line-height:1.28;
                      font-weight:600;
                    "
                  >
                    Играта ще започне веднага щом масата се напълни или когато времето изтече.
                  </div>
                </div>

                <div
                  data-matchmaking-countdown-text="1"
                  style="
                    color:#ffbf38;
                    font-size:18px;
                    line-height:1;
                    font-weight:900;
                    letter-spacing:0.02em;
                    font-variant-numeric:tabular-nums;
                    white-space:nowrap;
                  "
                >
                  ${countdownSeconds} сек.
                </div>
              </div>

              <div
                style="
                  margin-top:10px;
                  width:100%;
                  height:10px;
                  border-radius:999px;
                  overflow:hidden;
                  background:
                    linear-gradient(180deg, rgba(255,255,255,0.08), rgba(255,255,255,0.04)),
                    rgba(6,17,37,0.72);
                  box-shadow:inset 0 1px 2px rgba(255,255,255,0.06);
                "
              >
                <div
                  data-matchmaking-progress-bar="1"
                  style="
                    width:${progressPercent}%;
                    height:100%;
                    border-radius:999px;
                    background:
                      linear-gradient(90deg, #ffcf54 0%, #ffb21c 48%, #ff8a00 100%);
                    box-shadow:
                      inset 0 1px 0 rgba(255,255,255,0.25),
                      0 0 14px rgba(255,163,0,0.24);
                    transition:width 180ms linear;
                  "
                ></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  `
}
