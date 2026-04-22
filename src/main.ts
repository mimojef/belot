import './style.css'

import { createLobbyFlowController } from './app/lobby/createLobbyFlowController'
import {
  createGameServerClient,
  type GameServerClient,
  type MatchFoundMessage,
  type MatchStake,
  type RoomGameSnapshot,
  type RoomSeatSnapshot,
  type RoomStatus,
  type Seat,
  type ServerMessage,
} from './app/network/createGameServerClient'

const rootElementCandidate = document.querySelector<HTMLDivElement>('#app')

if (!rootElementCandidate) {
  throw new Error('Root element #app was not found.')
}

const rootElement: HTMLDivElement = rootElementCandidate

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

const SEAT_LABELS: Record<Seat, string> = {
  bottom: 'Долу',
  right: 'Дясно',
  top: 'Горе',
  left: 'Ляво',
}

let client: GameServerClient
let activeRoomState: ActiveRoomState | null = null

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

function renderActiveRoomScreen(): void {
  if (!activeRoomState) {
    return
  }

  const cuttingSnapshot = activeRoomState.game?.cutting ?? null
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

  rootElement.innerHTML = `
    <div
      style="
        min-height:100vh;
        box-sizing:border-box;
        padding:28px;
        background:
          radial-gradient(circle at top, rgba(59,130,246,0.18), transparent 34%),
          linear-gradient(180deg, #081120 0%, #0f172a 100%);
        color:#e2e8f0;
        font-family:Inter, system-ui, sans-serif;
      "
    >
      <div
        style="
          max-width:1180px;
          margin:0 auto;
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
                Server-authoritative room placeholder
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
            grid-template-columns:repeat(auto-fit, minmax(220px, 1fr));
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
            <div><strong style="color:#f8fafc;">Room status:</strong> ${activeRoomState.roomStatus ?? 'няма още'}</div>
            <div><strong style="color:#f8fafc;">Start flag:</strong> ${
              activeRoomState.shouldStartImmediately ? 'immediate' : 'normal'
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

        ${
          cuttingSnapshot
            ? `
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
                    font-size:12px;
                    font-weight:900;
                    letter-spacing:0.08em;
                    text-transform:uppercase;
                    color:#93c5fd;
                    margin-bottom:16px;
                  "
                >
                  Cutting debug placeholder
                </div>

                <div
                  style="
                    display:grid;
                    grid-template-columns:repeat(auto-fit, minmax(220px, 1fr));
                    gap:12px;
                    font-size:14px;
                    color:#cbd5e1;
                  "
                >
                  <div><strong style="color:#f8fafc;">Authoritative phase:</strong> ${escapeHtml(activeRoomState.game?.authoritativePhase ?? '—')}</div>
                  <div><strong style="color:#f8fafc;">Cutter seat:</strong> ${
                    cuttingSnapshot.cutterSeat
                      ? SEAT_LABELS[cuttingSnapshot.cutterSeat]
                      : '—'
                  }</div>
                  <div><strong style="color:#f8fafc;">Selected cut index:</strong> ${
                    cuttingSnapshot.selectedCutIndex ?? '—'
                  }</div>
                  <div><strong style="color:#f8fafc;">Deck count:</strong> ${cuttingSnapshot.deckCount}</div>
                  <div><strong style="color:#f8fafc;">Can submit cut:</strong> ${
                    cuttingSnapshot.canSubmitCut ? 'yes' : 'no'
                  }</div>
                </div>

                ${
                  cuttingSnapshot.canSubmitCut
                    ? `
                      <div
                        style="
                          margin-top:18px;
                          font-size:13px;
                          color:#cbd5e1;
                        "
                      >
                        Избери временен cut index:
                      </div>

                      <div
                        style="
                          margin-top:14px;
                          display:grid;
                          grid-template-columns:repeat(auto-fit, minmax(72px, 1fr));
                          gap:10px;
                        "
                      >
                        ${Array.from(
                          { length: Math.max(0, cuttingSnapshot.deckCount - 1) },
                          (_, index) => index + 1,
                        )
                          .map(
                            (cutIndex) => `
                              <button
                                type="button"
                                data-active-room-cut-index="${cutIndex}"
                                style="
                                  border:1px solid rgba(96,165,250,0.24);
                                  border-radius:14px;
                                  padding:12px 10px;
                                  background:rgba(30,41,59,0.88);
                                  color:#f8fafc;
                                  font-size:14px;
                                  font-weight:800;
                                  cursor:pointer;
                                "
                              >
                                ${cutIndex}
                              </button>
                            `,
                          )
                          .join('')}
                      </div>
                    `
                    : `
                      <div
                        style="
                          margin-top:18px;
                          font-size:13px;
                          color:#cbd5e1;
                        "
                      >
                        В момента този играч не може да подаде cut index.
                      </div>
                    `
                }
              </div>
            `
            : ''
        }

        <div
          style="
            display:grid;
            grid-template-columns:repeat(auto-fit, minmax(220px, 1fr));
            gap:16px;
          "
        >
          ${seatsHtml}
        </div>
      </div>
    </div>
  `

  const leaveButton = rootElement.querySelector<HTMLButtonElement>(
    '[data-active-room-leave-button="1"]',
  )

  leaveButton?.addEventListener('click', () => {
    if (!activeRoomState) {
      return
    }

    if (!client.isConnected()) {
      activeRoomState.errorText = 'Няма връзка със сървъра.'
      renderActiveRoomScreen()
      return
    }

    client.leaveActiveRoom(activeRoomState.roomId)
  })

  rootElement
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

        if (!client.isConnected()) {
          activeRoomState.errorText = 'Няма връзка със сървъра.'
          renderActiveRoomScreen()
          return
        }

        client.submitCutIndex(activeRoomState.roomId, cutIndex)
      })
    })
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
    isConnected: client.isConnected(),
    errorText: null,
  }

  renderActiveRoomScreen()
}

function showLobby(errorText: string | null = null): void {
  activeRoomState = null
  lobby.setConnected(client.isConnected())
  lobby.resetToLobby()
  lobby.setErrorText(errorText)
}

function handleActiveRoomMessage(message: ServerMessage): boolean {
  if (!activeRoomState) {
    return false
  }

  if (message.type === 'room_snapshot' && message.roomId === activeRoomState.roomId) {
    activeRoomState.roomStatus = message.roomStatus
    activeRoomState.reconnectToken = message.reconnectToken
    activeRoomState.seats = message.seats
    activeRoomState.game = message.game ?? null
    activeRoomState.errorText = null
    renderActiveRoomScreen()
    return true
  }

  if (message.type === 'left_active_room' && message.roomId === activeRoomState.roomId) {
    showLobby(null)
    return true
  }

  if (message.type === 'room_resume_failed' && message.roomId === activeRoomState.roomId) {
    showLobby(message.message)
    return true
  }

  if (message.type === 'error') {
    activeRoomState.errorText = message.message
    renderActiveRoomScreen()
    return true
  }

  return false
}

const lobby = createLobbyFlowController({
  root: rootElement,
  joinMatchmaking: (stake, displayName) => {
    client.joinMatchmaking(stake, displayName)
  },
  leaveMatchmaking: () => {
    client.leaveMatchmaking()
  },
  onMatchFound: (message) => {
    enterActiveRoom(message)
  },
})

client = createGameServerClient({
  onOpen: () => {
    if (activeRoomState) {
      activeRoomState.isConnected = true
      activeRoomState.errorText = null
      renderActiveRoomScreen()
      return
    }

    lobby.setConnected(true)
    lobby.setErrorText(null)
  },
  onClose: () => {
    if (activeRoomState) {
      activeRoomState.isConnected = false
      activeRoomState.errorText = 'Връзката със сървъра е прекъсната.'
      renderActiveRoomScreen()
      return
    }

    lobby.setConnected(false)
    lobby.setErrorText('Връзката със сървъра е прекъсната.')
  },
  onError: () => {
    if (activeRoomState) {
      activeRoomState.errorText = 'Възникна грешка при връзката със сървъра.'
      renderActiveRoomScreen()
      return
    }

    lobby.setErrorText('Възникна грешка при връзката със сървъра.')
  },
  onMessage: (message) => {
    if (handleActiveRoomMessage(message)) {
      return
    }

    lobby.handleServerMessage(message)
  },
})

window.addEventListener('beforeunload', () => {
  client.disconnect()
})

lobby.render()
client.connect()
