import type { MatchStake, RoomSeatSnapshot } from './createGameServerClient'

type Seat = 'bottom' | 'right' | 'top' | 'left'

const MATCH_STAKE_OPTIONS: MatchStake[] = [5000, 8000, 10000, 15000, 20000]

export type ServerDebugPanelState = {
  isConnected: boolean
  clientId: string | null
  roomId: string | null
  yourSeat: Seat | null
  seats: RoomSeatSnapshot[]
  lastError: string | null
  isSearchingMatchmaking: boolean
  matchmakingStake: MatchStake | null
  queuedPlayers: number
  requiredPlayers: number
  remainingMs: number | null
}

type CreateServerDebugPanelOptions = {
  mountTarget?: HTMLElement
  onConnect: () => void
  onDisconnect: () => void
  onPing: () => void
  onJoinMatchmaking: (stake: MatchStake, displayName?: string) => void
  onLeaveMatchmaking: () => void
}

export type ServerDebugPanelController = {
  render: (state: ServerDebugPanelState) => void
  destroy: () => void
}

function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function formatSeatLabel(seat: Seat | null): string {
  if (seat === 'bottom') return 'bottom'
  if (seat === 'right') return 'right'
  if (seat === 'top') return 'top'
  if (seat === 'left') return 'left'
  return '—'
}

function formatStakeLabel(stake: MatchStake | null): string {
  if (stake === null) {
    return '—'
  }

  return `${stake}`
}

function formatRemainingTime(remainingMs: number | null): string {
  if (remainingMs === null) {
    return '—'
  }

  return `${Math.max(0, Math.ceil(remainingMs / 1000))} сек`
}

function renderSeatList(seats: RoomSeatSnapshot[]): string {
  if (seats.length === 0) {
    return `
      <div style="font-size:12px; color:#cbd5e1;">
        Няма room snapshot още.
      </div>
    `
  }

  return seats
    .map((seat) => {
      const statusText = seat.isOccupied
        ? seat.isBot
          ? 'bot'
          : seat.isConnected
            ? 'online'
            : 'offline'
        : 'empty'

      const background = seat.isOccupied
        ? seat.isBot
          ? 'rgba(250, 204, 21, 0.16)'
          : seat.isConnected
            ? 'rgba(34, 197, 94, 0.16)'
            : 'rgba(239, 68, 68, 0.16)'
        : 'rgba(148, 163, 184, 0.12)'

      return `
        <div
          style="
            display:flex;
            align-items:center;
            justify-content:space-between;
            gap:10px;
            padding:8px 10px;
            border-radius:10px;
            background:${background};
            border:1px solid rgba(148,163,184,0.18);
          "
        >
          <div style="display:flex; flex-direction:column; gap:2px; min-width:0;">
            <div style="font-size:12px; font-weight:800; color:#f8fafc;">
              ${escapeHtml(seat.seat)}
            </div>
            <div
              style="
                font-size:12px;
                color:#cbd5e1;
                white-space:nowrap;
                overflow:hidden;
                text-overflow:ellipsis;
                max-width:180px;
              "
            >
              ${escapeHtml(seat.displayName)}
            </div>
          </div>

          <div
            style="
              flex-shrink:0;
              font-size:11px;
              font-weight:800;
              color:#f8fafc;
              text-transform:uppercase;
              letter-spacing:0.03em;
            "
          >
            ${escapeHtml(statusText)}
          </div>
        </div>
      `
    })
    .join('')
}

export function createServerDebugPanel(
  options: CreateServerDebugPanelOptions,
): ServerDebugPanelController {
  const mountTarget = options.mountTarget ?? document.body

  const root = document.createElement('div')
  root.setAttribute('data-server-debug-panel-root', '1')
  root.style.position = 'fixed'
  root.style.right = '16px'
  root.style.bottom = '16px'
  root.style.width = '320px'
  root.style.maxWidth = 'calc(100vw - 32px)'
  root.style.zIndex = '9997'
  root.style.pointerEvents = 'auto'
  root.style.fontFamily = 'Arial, Helvetica, sans-serif'

  root.innerHTML = `
    <div
      style="
        border-radius:18px;
        background:rgba(15,23,42,0.96);
        border:1px solid rgba(148,163,184,0.22);
        box-shadow:0 20px 50px rgba(0,0,0,0.35);
        overflow:hidden;
      "
    >
      <div
        style="
          padding:12px 14px;
          border-bottom:1px solid rgba(148,163,184,0.16);
          display:flex;
          align-items:center;
          justify-content:space-between;
          gap:8px;
        "
      >
        <div style="font-size:14px; font-weight:800; color:#f8fafc;">
          Server Debug
        </div>
        <div
          data-server-debug-connection-badge
          style="
            font-size:11px;
            font-weight:800;
            border-radius:999px;
            padding:5px 8px;
            background:rgba(148,163,184,0.16);
            color:#e2e8f0;
          "
        >
          OFFLINE
        </div>
      </div>

      <div style="padding:12px; display:flex; flex-direction:column; gap:12px;">
        <div style="display:flex; flex-direction:column; gap:8px;">
          <div style="font-size:11px; font-weight:800; color:#94a3b8; text-transform:uppercase;">
            Connection
          </div>

          <div style="display:grid; grid-template-columns:1fr 1fr 1fr; gap:8px;">
            <button
              type="button"
              data-server-debug-connect
              style="
                border:0;
                border-radius:10px;
                padding:10px 8px;
                background:#2563eb;
                color:#eff6ff;
                font-size:12px;
                font-weight:800;
                cursor:pointer;
              "
            >
              Connect
            </button>

            <button
              type="button"
              data-server-debug-disconnect
              style="
                border:0;
                border-radius:10px;
                padding:10px 8px;
                background:#475569;
                color:#f8fafc;
                font-size:12px;
                font-weight:800;
                cursor:pointer;
              "
            >
              Disconnect
            </button>

            <button
              type="button"
              data-server-debug-ping
              style="
                border:0;
                border-radius:10px;
                padding:10px 8px;
                background:#0f766e;
                color:#ecfeff;
                font-size:12px;
                font-weight:800;
                cursor:pointer;
              "
            >
              Ping
            </button>
          </div>

          <div
            data-server-debug-connection-meta
            style="
              font-size:12px;
              color:#cbd5e1;
              line-height:1.5;
              background:rgba(255,255,255,0.03);
              border-radius:10px;
              padding:10px;
            "
          ></div>
        </div>

        <div style="display:flex; flex-direction:column; gap:8px;">
          <div style="font-size:11px; font-weight:800; color:#94a3b8; text-transform:uppercase;">
            Matchmaking
          </div>

          <input
            data-server-debug-display-name
            type="text"
            placeholder="Име за тест, напр. Milen"
            style="
              width:100%;
              box-sizing:border-box;
              border:1px solid rgba(148,163,184,0.22);
              border-radius:10px;
              background:rgba(255,255,255,0.04);
              color:#f8fafc;
              padding:10px 12px;
              font-size:13px;
              outline:none;
            "
          />

          <select
            data-server-debug-stake
            style="
              width:100%;
              box-sizing:border-box;
              border:1px solid rgba(148,163,184,0.22);
              border-radius:10px;
              background:rgba(255,255,255,0.04);
              color:#f8fafc;
              padding:10px 12px;
              font-size:13px;
              outline:none;
            "
          >
            ${MATCH_STAKE_OPTIONS.map(
              (stake) => `
                <option value="${stake}" style="color:#0f172a;">
                  ${stake}
                </option>
              `,
            ).join('')}
          </select>

          <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px;">
            <button
              type="button"
              data-server-debug-join-matchmaking
              style="
                border:0;
                border-radius:10px;
                padding:11px 12px;
                background:#16a34a;
                color:#f0fdf4;
                font-size:13px;
                font-weight:800;
                cursor:pointer;
              "
            >
              Join MM
            </button>

            <button
              type="button"
              data-server-debug-leave-matchmaking
              style="
                border:0;
                border-radius:10px;
                padding:11px 12px;
                background:#7c3aed;
                color:#f5f3ff;
                font-size:13px;
                font-weight:800;
                cursor:pointer;
              "
            >
              Leave MM
            </button>
          </div>

          <div
            data-server-debug-matchmaking-meta
            style="
              font-size:12px;
              color:#cbd5e1;
              line-height:1.5;
              background:rgba(255,255,255,0.03);
              border-radius:10px;
              padding:10px;
            "
          ></div>
        </div>

        <div style="display:flex; flex-direction:column; gap:8px;">
          <div style="font-size:11px; font-weight:800; color:#94a3b8; text-transform:uppercase;">
            Room snapshot
          </div>

          <div
            data-server-debug-room-meta
            style="
              font-size:12px;
              color:#cbd5e1;
              line-height:1.5;
              background:rgba(255,255,255,0.03);
              border-radius:10px;
              padding:10px;
            "
          ></div>

          <div
            data-server-debug-seat-list
            style="
              display:flex;
              flex-direction:column;
              gap:8px;
            "
          ></div>
        </div>

        <div
          data-server-debug-error
          style="
            display:none;
            font-size:12px;
            line-height:1.5;
            color:#fecaca;
            background:rgba(127,29,29,0.32);
            border:1px solid rgba(248,113,113,0.25);
            border-radius:10px;
            padding:10px;
          "
        ></div>
      </div>
    </div>
  `

  mountTarget.appendChild(root)

  const connectionBadge = root.querySelector<HTMLElement>(
    '[data-server-debug-connection-badge]',
  )
  const connectionMeta = root.querySelector<HTMLElement>(
    '[data-server-debug-connection-meta]',
  )
  const matchmakingMeta = root.querySelector<HTMLElement>(
    '[data-server-debug-matchmaking-meta]',
  )
  const roomMeta = root.querySelector<HTMLElement>('[data-server-debug-room-meta]')
  const seatList = root.querySelector<HTMLElement>('[data-server-debug-seat-list]')
  const errorBox = root.querySelector<HTMLElement>('[data-server-debug-error]')

  const displayNameInput = root.querySelector<HTMLInputElement>(
    '[data-server-debug-display-name]',
  )
  const stakeSelect = root.querySelector<HTMLSelectElement>('[data-server-debug-stake]')

  const connectButton = root.querySelector<HTMLButtonElement>(
    '[data-server-debug-connect]',
  )
  const disconnectButton = root.querySelector<HTMLButtonElement>(
    '[data-server-debug-disconnect]',
  )
  const pingButton = root.querySelector<HTMLButtonElement>('[data-server-debug-ping]')
  const joinMatchmakingButton = root.querySelector<HTMLButtonElement>(
    '[data-server-debug-join-matchmaking]',
  )
  const leaveMatchmakingButton = root.querySelector<HTMLButtonElement>(
    '[data-server-debug-leave-matchmaking]',
  )

  connectButton?.addEventListener('click', () => {
    options.onConnect()
  })

  disconnectButton?.addEventListener('click', () => {
    options.onDisconnect()
  })

  pingButton?.addEventListener('click', () => {
    options.onPing()
  })

  joinMatchmakingButton?.addEventListener('click', () => {
    const displayName = displayNameInput?.value?.trim() || undefined
    const rawStake = Number(stakeSelect?.value)
    const stake = MATCH_STAKE_OPTIONS.find((value) => value === rawStake)

    if (!stake) {
      return
    }

    options.onJoinMatchmaking(stake, displayName)
  })

  leaveMatchmakingButton?.addEventListener('click', () => {
    options.onLeaveMatchmaking()
  })

  function render(state: ServerDebugPanelState): void {
    if (connectionBadge) {
      connectionBadge.textContent = state.isConnected ? 'ONLINE' : 'OFFLINE'
      connectionBadge.style.background = state.isConnected
        ? 'rgba(34,197,94,0.18)'
        : 'rgba(148,163,184,0.16)'
      connectionBadge.style.color = state.isConnected ? '#dcfce7' : '#e2e8f0'
    }

    if (connectionMeta) {
      connectionMeta.innerHTML = `
        <div><strong>Client ID:</strong> ${escapeHtml(state.clientId ?? '—')}</div>
        <div><strong>Connected:</strong> ${state.isConnected ? 'yes' : 'no'}</div>
      `
    }

    if (matchmakingMeta) {
      matchmakingMeta.innerHTML = `
        <div><strong>Status:</strong> ${state.isSearchingMatchmaking ? 'searching' : 'idle'}</div>
        <div><strong>Stake:</strong> ${escapeHtml(formatStakeLabel(state.matchmakingStake))}</div>
        <div><strong>Queue:</strong> ${state.queuedPlayers} / ${state.requiredPlayers}</div>
        <div><strong>Remaining:</strong> ${escapeHtml(formatRemainingTime(state.remainingMs))}</div>
      `
    }

    if (roomMeta) {
      roomMeta.innerHTML = `
        <div><strong>Room ID:</strong> ${escapeHtml(state.roomId ?? '—')}</div>
        <div><strong>Your seat:</strong> ${escapeHtml(formatSeatLabel(state.yourSeat))}</div>
      `
    }

    if (seatList) {
      seatList.innerHTML = renderSeatList(state.seats)
    }

    if (stakeSelect && !stakeSelect.matches(':focus')) {
      stakeSelect.value = String(state.matchmakingStake ?? MATCH_STAKE_OPTIONS[0])
    }

    if (joinMatchmakingButton) {
      joinMatchmakingButton.disabled = !state.isConnected
      joinMatchmakingButton.style.opacity = state.isConnected ? '1' : '0.55'
      joinMatchmakingButton.style.cursor = state.isConnected ? 'pointer' : 'default'
    }

    if (leaveMatchmakingButton) {
      leaveMatchmakingButton.disabled = !state.isConnected
      leaveMatchmakingButton.style.opacity = state.isConnected ? '1' : '0.55'
      leaveMatchmakingButton.style.cursor = state.isConnected ? 'pointer' : 'default'
    }

    if (errorBox) {
      if (state.lastError) {
        errorBox.style.display = 'block'
        errorBox.textContent = state.lastError
      } else {
        errorBox.style.display = 'none'
        errorBox.textContent = ''
      }
    }
  }

  function destroy(): void {
    root.remove()
  }

  return {
    render,
    destroy,
  }
}