import {
  type MatchFoundMessage,
  type MatchStake,
  type RoomGameSnapshot,
  type RoomSeatSnapshot,
  type RoomSnapshotMessage,
  type RoomStatus,
  type Seat,
  type ServerMessage,
} from '../network/createGameServerClient'
import { createCuttingSeatPanelsHtml } from './cutting/renderCuttingSeatPanels'
import { createCuttingVisualCountdownTracker } from './cutting/cuttingVisualCountdown'
import { renderCuttingScreen } from './renderCuttingScreen'
import { getViewportStageMetrics } from '../../ui/layout/viewportStage'

type ActiveRoomState = {
  roomId: string
  seat: Seat
  stake: MatchStake
  humanPlayers: number
  botPlayers: number
  shouldStartImmediately: boolean
  roomStatus: RoomStatus | null
  reconnectToken: string | null
  seats: RoomSeatSnapshot[]
  game: RoomGameSnapshot | null
  isConnected: boolean
  errorText: string | null
}

type CreateActiveRoomFlowControllerOptions = {
  root: HTMLDivElement
  isConnected: () => boolean
  leaveActiveRoom: (roomId: string) => void
  submitCutIndex: (roomId: string, cutIndex: number) => void
  showLobby: (errorText?: string | null) => void
}

type ActiveRoomFlowController = {
  render: () => void
  enterActiveRoom: (message: MatchFoundMessage) => void
  handleServerMessage: (message: ServerMessage) => boolean
  setConnected: (value: boolean) => void
  setConnectionError: (message: string | null) => void
  setConnectionState: (isConnected: boolean, message: string | null) => void
  leaveActiveRoom: () => void
  hasActiveRoom: () => boolean
}

const SEAT_LABELS: Record<Seat, string> = {
  bottom: 'Долу',
  right: 'Дясно',
  top: 'Горе',
  left: 'Ляво',
}

const ACTIVE_ROOM_STAGE_WIDTH = 1600
const ACTIVE_ROOM_STAGE_HEIGHT = 900
const ACTIVE_ROOM_MAX_STAGE_SCALE = 1.06
const ACTIVE_ROOM_MIN_STAGE_SCALE = 0.46
const ACTIVE_ROOM_VIEWPORT_HORIZONTAL_PADDING = 20
const ACTIVE_ROOM_VIEWPORT_VERTICAL_PADDING = 20

export function createActiveRoomFlowController(
  options: CreateActiveRoomFlowControllerOptions,
): ActiveRoomFlowController {
  const pendingRoomSnapshots = new Map<string, RoomSnapshotMessage>()
  let activeRoomState: ActiveRoomState | null = null
  const cuttingVisualCountdown = createCuttingVisualCountdownTracker()

  function escapeHtml(value: string): string {
    return value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;')
  }

  function createSeatCardHtml(seat: RoomSeatSnapshot): string {
    const displayName = seat.isOccupied ? seat.displayName : 'Свободно място'
    const occupancyText = seat.isOccupied
      ? seat.isBot
        ? 'Бот'
        : 'Играч'
      : 'Празно'
    const connectionText = seat.isOccupied
      ? seat.isConnected
        ? 'Свързан'
        : 'Изключен'
      : '—'

    return `
      <div
        style="
          border:1px solid rgba(148,163,184,0.22);
          border-radius:18px;
          padding:16px;
          background:rgba(15,23,42,0.58);
          box-shadow:0 14px 36px rgba(2,6,23,0.28);
        "
      >
        <div
          style="
            display:flex;
            align-items:center;
            justify-content:space-between;
            gap:12px;
            margin-bottom:12px;
          "
        >
          <div
            style="
              font-size:12px;
              font-weight:800;
              letter-spacing:0.08em;
              text-transform:uppercase;
              color:#93c5fd;
            "
          >
            ${SEAT_LABELS[seat.seat]}
          </div>

          <div
            style="
              font-size:11px;
              font-weight:800;
              color:${seat.isOccupied ? '#c4b5fd' : '#94a3b8'};
              text-transform:uppercase;
              letter-spacing:0.06em;
            "
          >
            ${occupancyText}
          </div>
        </div>

        <div
          style="
            display:flex;
            align-items:center;
            gap:12px;
          "
        >
          <div
            style="
              width:56px;
              height:56px;
              border-radius:16px;
              background:linear-gradient(180deg, #1e293b 0%, #0f172a 100%);
              border:1px solid rgba(148,163,184,0.24);
              overflow:hidden;
              flex:0 0 56px;
            "
          >
            ${
              seat.avatarUrl
                ? `<img
                    src="${escapeHtml(seat.avatarUrl)}"
                    alt="${escapeHtml(displayName)}"
                    style="width:100%;height:100%;object-fit:cover;display:block;"
                  />`
                : `<div
                    style="
                      width:100%;
                      height:100%;
                      display:flex;
                      align-items:center;
                      justify-content:center;
                      color:#94a3b8;
                      font-size:11px;
                      font-weight:800;
                      letter-spacing:0.06em;
                      text-transform:uppercase;
                    "
                  >
                    Аватар
                  </div>`
            }
          </div>

          <div style="min-width:0;flex:1 1 auto;">
            <div
              style="
                font-size:16px;
                font-weight:800;
                color:#f8fafc;
                white-space:nowrap;
                overflow:hidden;
                text-overflow:ellipsis;
              "
            >
              ${escapeHtml(displayName)}
            </div>

            <div
              style="
                margin-top:4px;
                font-size:12px;
                color:#cbd5e1;
              "
            >
              ${connectionText}
            </div>
          </div>
        </div>
      </div>
    `
  }

  function getActiveRoomStageMetrics(): {
    stageScale: number
    scaledStageWidth: number
    scaledStageHeight: number
  } {
    return getViewportStageMetrics({
      baseWidth: ACTIVE_ROOM_STAGE_WIDTH,
      baseHeight: ACTIVE_ROOM_STAGE_HEIGHT,
      minScale: ACTIVE_ROOM_MIN_STAGE_SCALE,
      maxScale: ACTIVE_ROOM_MAX_STAGE_SCALE,
      viewportHorizontalPadding: ACTIVE_ROOM_VIEWPORT_HORIZONTAL_PADDING,
      viewportVerticalPadding: ACTIVE_ROOM_VIEWPORT_VERTICAL_PADDING,
    })
  }

  function renderActiveRoomScreen(): void {
    if (!activeRoomState) {
      return
    }

    const cuttingSnapshot = activeRoomState.game?.cutting ?? null
    const dealerSeat = activeRoomState.game?.dealerSeat ?? null
    const cutterSeat = cuttingSnapshot?.cutterSeat ?? null
    const cutterSeatSnapshot =
      cutterSeat !== null
        ? activeRoomState.seats.find((seat) => seat.seat === cutterSeat) ?? null
        : null
    const cutterDisplayName =
      cutterSeatSnapshot?.displayName.trim()
        ? cutterSeatSnapshot.displayName.trim()
        : cutterSeat !== null
          ? SEAT_LABELS[cutterSeat]
          : 'играч'
    const isLocalPlayerCutter = cutterSeat !== null && activeRoomState.seat === cutterSeat
    const { stageScale, scaledStageWidth, scaledStageHeight } = getActiveRoomStageMetrics()

    if (cuttingSnapshot) {
      const cuttingVisualCountdownContext = {
        roomId: activeRoomState.roomId,
        game: activeRoomState.game,
      }

      cuttingVisualCountdown.syncCuttingVisualCountdownState(cuttingVisualCountdownContext)
      const cuttingCountdownRemainingMs =
        cuttingVisualCountdown.getCuttingVisualCountdownRemainingMs(
          cuttingVisualCountdownContext,
        )

      options.root.innerHTML = `
        <div
          style="
            position:relative;
            min-height:100vh;
            width:100%;
            box-sizing:border-box;
            display:flex;
            align-items:center;
            justify-content:center;
            overflow:hidden;
            background:
              radial-gradient(circle at center, rgba(74,222,128,0.18) 0%, rgba(34,197,94,0.10) 34%, rgba(21,128,61,0.00) 58%),
              linear-gradient(180deg, rgba(22,101,52,0.98) 0%, rgba(17,94,39,0.99) 100%);
            font-family:Inter, system-ui, sans-serif;
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
                top:50%;
                width:${ACTIVE_ROOM_STAGE_WIDTH}px;
                height:${ACTIVE_ROOM_STAGE_HEIGHT}px;
                transform:translate(-50%, -50%) scale(${stageScale});
                transform-origin:center center;
              "
            >
              <div
                style="
                  position:relative;
                  width:100%;
                  height:100%;
                  overflow:hidden;
                "
              >
                ${renderCuttingScreen({
                  cuttingSnapshot,
                  cutterDisplayName,
                  isInteractive: cuttingSnapshot.canSubmitCut && isLocalPlayerCutter,
                })}
              </div>
            </div>
          </div>
          ${createCuttingSeatPanelsHtml({
            seats: activeRoomState.seats,
            localSeat: activeRoomState.seat,
            dealerSeat,
            cutterSeat,
            cuttingCountdownRemainingMs,
            panelScale: stageScale,
            escapeHtml,
          })}
        </div>
      `
    } else {
      cuttingVisualCountdown.resetCuttingVisualCountdownState()
      const seatsHtml =
        activeRoomState.seats.length > 0
          ? activeRoomState.seats.map(createSeatCardHtml).join('')
          : `
            <div
              style="
                border:1px dashed rgba(148,163,184,0.28);
                border-radius:18px;
                padding:24px;
                color:#cbd5e1;
                text-align:center;
                background:rgba(15,23,42,0.42);
              "
            >
              Чакаме първия room snapshot от сървъра...
            </div>
          `

      options.root.innerHTML = `
        <div
          style="
            min-height:100vh;
            box-sizing:border-box;
            padding:${ACTIVE_ROOM_VIEWPORT_VERTICAL_PADDING / 2}px ${ACTIVE_ROOM_VIEWPORT_HORIZONTAL_PADDING / 2}px;
            display:flex;
            align-items:center;
            justify-content:center;
            overflow:hidden;
            background:
              radial-gradient(circle at top, rgba(59,130,246,0.18), transparent 34%),
              linear-gradient(180deg, #081120 0%, #0f172a 100%);
            font-family:Inter, system-ui, sans-serif;
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
                top:50%;
                width:${ACTIVE_ROOM_STAGE_WIDTH}px;
                height:${ACTIVE_ROOM_STAGE_HEIGHT}px;
                transform:translate(-50%, -50%) scale(${stageScale});
                transform-origin:center center;
              "
            >
              <div
                style="
                  position:relative;
                  width:100%;
                  height:100%;
                  overflow:hidden;
                  background:
                    radial-gradient(circle at top, rgba(59,130,246,0.18), transparent 34%),
                    linear-gradient(180deg, #081120 0%, #0f172a 100%);
                  color:#e2e8f0;
                "
              >
                <div
                  style="
                    width:1180px;
                    margin:0 auto;
                    padding:34px 0 40px;
                    display:grid;
                    gap:20px;
                  "
                >
                  <div
                    style="
                      border:1px solid rgba(148,163,184,0.18);
                      border-radius:24px;
                      padding:24px;
                      background:rgba(15,23,42,0.72);
                      box-shadow:0 24px 60px rgba(2,6,23,0.34);
                    "
                  >
                    <div
                      style="
                        display:flex;
                        flex-wrap:wrap;
                        align-items:center;
                        justify-content:space-between;
                        gap:16px;
                      "
                    >
                      <div>
                        <div
                          style="
                            font-size:12px;
                            font-weight:900;
                            letter-spacing:0.08em;
                            text-transform:uppercase;
                            color:#93c5fd;
                            margin-bottom:8px;
                          "
                        >
                          Активна стая
                        </div>

                        <h1
                          style="
                            margin:0;
                            font-size:30px;
                            line-height:1.1;
                            font-weight:900;
                            color:#f8fafc;
                          "
                        >
                          Намерена е игра
                        </h1>

                        <div
                          style="
                            margin-top:10px;
                            font-size:15px;
                            color:#cbd5e1;
                          "
                        >
                          Това е временен екран за стаята. Следващата стъпка е върху него
                          да вържем чистото server-authoritative gameplay ядро.
                        </div>
                      </div>

                      <button
                        type="button"
                        data-active-room-leave-button="1"
                        style="
                          border:0;
                          border-radius:16px;
                          padding:14px 18px;
                          background:linear-gradient(180deg, #8b5cf6 0%, #6d28d9 100%);
                          color:#f5f3ff;
                          font-size:14px;
                          font-weight:900;
                          cursor:pointer;
                          box-shadow:0 14px 32px rgba(76,29,149,0.28);
                        "
                      >
                        Напусни активната стая
                      </button>
                    </div>
                  </div>

                  <div
                    style="
                      display:grid;
                      grid-template-columns:repeat(4, minmax(0, 1fr));
                      gap:16px;
                    "
                  >
                    <div
                      style="
                        border:1px solid rgba(148,163,184,0.18);
                        border-radius:20px;
                        padding:18px;
                        background:rgba(15,23,42,0.72);
                      "
                    >
                      <div style="font-size:12px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#93c5fd;">
                        Стая
                      </div>
                      <div style="margin-top:8px;font-size:18px;font-weight:800;color:#f8fafc;">
                        ${escapeHtml(activeRoomState.roomId)}
                      </div>
                    </div>

                    <div
                      style="
                        border:1px solid rgba(148,163,184,0.18);
                        border-radius:20px;
                        padding:18px;
                        background:rgba(15,23,42,0.72);
                      "
                    >
                      <div style="font-size:12px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#93c5fd;">
                        Твоето място
                      </div>
                      <div style="margin-top:8px;font-size:18px;font-weight:800;color:#f8fafc;">
                        ${SEAT_LABELS[activeRoomState.seat]}
                      </div>
                    </div>

                    <div
                      style="
                        border:1px solid rgba(148,163,184,0.18);
                        border-radius:20px;
                        padding:18px;
                        background:rgba(15,23,42,0.72);
                      "
                    >
                      <div style="font-size:12px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#93c5fd;">
                        Залог
                      </div>
                      <div style="margin-top:8px;font-size:18px;font-weight:800;color:#f8fafc;">
                        ${activeRoomState.stake}
                      </div>
                    </div>

                    <div
                      style="
                        border:1px solid rgba(148,163,184,0.18);
                        border-radius:20px;
                        padding:18px;
                        background:rgba(15,23,42,0.72);
                      "
                    >
                      <div style="font-size:12px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#93c5fd;">
                        Статус
                      </div>
                      <div style="margin-top:8px;font-size:18px;font-weight:800;color:#f8fafc;">
                        ${
                          activeRoomState.isConnected
                            ? 'Свързан със сървъра'
                            : 'Връзката е прекъсната'
                        }
                      </div>
                    </div>
                  </div>

                  <div
                    style="
                      border:1px solid rgba(148,163,184,0.18);
                      border-radius:24px;
                      padding:24px;
                      background:rgba(15,23,42,0.72);
                    "
                  >
                    <div
                      style="
                        display:flex;
                        flex-wrap:wrap;
                        gap:10px 18px;
                        font-size:14px;
                        color:#cbd5e1;
                      "
                    >
                      <div><strong style="color:#f8fafc;">Хора:</strong> ${activeRoomState.humanPlayers}</div>
                      <div><strong style="color:#f8fafc;">Ботове:</strong> ${activeRoomState.botPlayers}</div>
                      <div><strong style="color:#f8fafc;">Статус на стаята:</strong> ${activeRoomState.roomStatus ?? 'няма още'}</div>
                      <div><strong style="color:#f8fafc;">Старт:</strong> ${
                        activeRoomState.shouldStartImmediately ? 'веднага' : 'нормален'
                      }</div>
                    </div>

                    ${
                      activeRoomState.errorText
                        ? `
                          <div
                            style="
                              margin-top:16px;
                              border-radius:16px;
                              padding:14px 16px;
                              background:rgba(127,29,29,0.34);
                              border:1px solid rgba(248,113,113,0.24);
                              color:#fecaca;
                              font-size:14px;
                              font-weight:700;
                            "
                          >
                            ${escapeHtml(activeRoomState.errorText)}
                          </div>
                        `
                        : ''
                    }
                  </div>

                  <div
                    style="
                      display:grid;
                      grid-template-columns:repeat(4, minmax(0, 1fr));
                      gap:16px;
                    "
                  >
                    ${seatsHtml}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      `
    }

    const leaveButton = options.root.querySelector<HTMLButtonElement>(
      '[data-active-room-leave-button="1"]',
    )

    leaveButton?.addEventListener('click', () => {
      if (!activeRoomState) {
        return
      }

      if (!options.isConnected()) {
        activeRoomState.errorText = 'Няма връзка със сървъра.'
        renderActiveRoomScreen()
        return
      }

      options.leaveActiveRoom(activeRoomState.roomId)
    })

    options.root
      .querySelectorAll<HTMLButtonElement>('[data-active-room-cut-index]')
      .forEach((button) => {
        button.addEventListener('click', () => {
          if (!activeRoomState) {
            return
          }

          const cutIndex = Number(button.dataset.activeRoomCutIndex)

          if (!Number.isInteger(cutIndex)) {
            return
          }

          if (!options.isConnected()) {
            activeRoomState.errorText = 'Няма връзка със сървъра.'
            renderActiveRoomScreen()
            return
          }

          options.submitCutIndex(activeRoomState.roomId, cutIndex)
        })
      })
  }

  function applyRoomSnapshotToActiveRoom(message: RoomSnapshotMessage): boolean {
    if (!activeRoomState) {
      return false
    }

    if (message.roomId !== activeRoomState.roomId) {
      return false
    }

    activeRoomState.roomStatus = message.roomStatus
    activeRoomState.reconnectToken = message.reconnectToken
    activeRoomState.seats = message.seats
    activeRoomState.game = message.game ?? null
    activeRoomState.errorText = null
    renderActiveRoomScreen()
    return true
  }

  function enterActiveRoom(message: MatchFoundMessage): void {
    activeRoomState = {
      roomId: message.roomId,
      seat: message.seat,
      stake: message.stake,
      humanPlayers: message.humanPlayers,
      botPlayers: message.botPlayers,
      shouldStartImmediately: message.shouldStartImmediately,
      roomStatus: null,
      reconnectToken: null,
      seats: [],
      game: null,
      isConnected: options.isConnected(),
      errorText: null,
    }

    const pendingRoomSnapshot = pendingRoomSnapshots.get(message.roomId)

    if (pendingRoomSnapshot) {
      applyRoomSnapshotToActiveRoom(pendingRoomSnapshot)
      return
    }

    renderActiveRoomScreen()
  }

  function handleServerMessage(message: ServerMessage): boolean {
    if (message.type === 'room_snapshot') {
      pendingRoomSnapshots.set(message.roomId, message)

      if (applyRoomSnapshotToActiveRoom(message)) {
        return true
      }

      return false
    }

    if (!activeRoomState) {
      return false
    }

    if (message.type === 'left_active_room' && message.roomId === activeRoomState.roomId) {
      activeRoomState = null
      options.showLobby(null)
      return true
    }

    if (message.type === 'room_resume_failed' && message.roomId === activeRoomState.roomId) {
      activeRoomState = null
      options.showLobby(message.message)
      return true
    }

    if (message.type === 'error') {
      activeRoomState.errorText = message.message
      renderActiveRoomScreen()
      return true
    }

    return false
  }

  function setConnected(value: boolean): void {
    if (!activeRoomState) {
      return
    }

    activeRoomState.isConnected = value
    renderActiveRoomScreen()
  }

  function setConnectionError(message: string | null): void {
    if (!activeRoomState) {
      return
    }

    activeRoomState.errorText = message
    renderActiveRoomScreen()
  }

  function setConnectionState(isConnected: boolean, message: string | null): void {
    if (!activeRoomState) {
      return
    }

    activeRoomState.isConnected = isConnected
    activeRoomState.errorText = message
    renderActiveRoomScreen()
  }

  function leaveActiveRoom(): void {
    if (!activeRoomState) {
      return
    }

    options.leaveActiveRoom(activeRoomState.roomId)
  }

  function hasActiveRoom(): boolean {
    return activeRoomState !== null
  }

  return {
    render: renderActiveRoomScreen,
    enterActiveRoom,
    handleServerMessage,
    setConnected,
    setConnectionError,
    setConnectionState,
    leaveActiveRoom,
    hasActiveRoom,
  }
}
