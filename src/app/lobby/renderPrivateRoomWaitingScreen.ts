import type { MatchStake, Team } from '../network/createGameServerClient'
import {
  PRIVATE_ROOM_POPUP_STYLES,
  renderPrivateRoomBlockedPopup,
  renderPrivateRoomInviteFriendsPopup,
  renderPrivateRoomJoinConfirmPopup,
  type PrivateRoomInviteEligibleFriend,
} from './privateRoomPopupMarkup'

export type PrivateRoomWaitingOccupantSnapshot = {
  profileId: string | null
  displayName: string
  avatarUrl: string | null
  level: number | null
  rankTitle: string | null
  isHost: boolean
  isBot: boolean
}

export type PrivateRoomWaitingSlotSnapshot = {
  team: Team
  slotIndex: 0 | 1
  occupant: PrivateRoomWaitingOccupantSnapshot | null
}

export type PrivateRoomWaitingChatMessageSnapshot = {
  seq: number
  messageId: string
  senderProfileId: string | null
  senderDisplayName: string
  body: string
  createdAt: number
}

// 'member' = локалният играч вече е зает слот в тази стая (вижда собствения
// си "−", chat-ът е функционален). 'previewer' = разглежда стаята преди да
// избере отбор (вижда кликаеми "+", chat-ът не е достъпен).
export type PrivateRoomWaitingViewerRole = 'member' | 'previewer'

export type RenderPrivateRoomWaitingScreenParams = {
  isLocked: boolean
  stake: MatchStake
  slots: PrivateRoomWaitingSlotSnapshot[]
  localProfileId: string | null
  viewerRole: PrivateRoomWaitingViewerRole
  joinSlotPopup: { team: Team; slotIndex: 0 | 1 } | null
  leaveConfirmOpen: boolean
  blockedPopupText: string | null
  botActionLoadingTeam: Team | null
  inviteFriendsPopupOpen: boolean
  inviteFriends: PrivateRoomInviteEligibleFriend[] | null
  chatMessages: PrivateRoomWaitingChatMessageSnapshot[]
  chatDraft: string
  chatSending: boolean
  chatErrorText: string | null
  infoText: string | null
  expiresAt: number
}

// Pure formatter — exported so it can be unit-tested and reused by the
// controller's tick loop without re-rendering the whole screen.
export function formatPrivateRoomCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  }

  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

export function getPrivateRoomCountdownState(remainingMs: number): 'normal' | 'warning' | 'critical' {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000))
  if (totalSeconds <= 30) return 'critical'
  if (totalSeconds <= 60) return 'warning'
  return 'normal'
}

function renderCountdownBadge(expiresAt: number): string {
  const remainingMs = Math.max(0, expiresAt - Date.now())
  const text = formatPrivateRoomCountdown(remainingMs)
  const countdownState = getPrivateRoomCountdownState(remainingMs)

  return `
    <div
      data-private-room-countdown="1"
      data-expires-at="${expiresAt}"
      class="prw-countdown prw-countdown-${countdownState}"
    >
      <span class="prw-countdown-label prw-countdown-label-full">Оставащо време</span>
      <span class="prw-countdown-label prw-countdown-label-short">Остава</span>
      <span data-private-room-countdown-value="1" class="prw-countdown-value">${text}</span>
    </div>
  `
}

function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function formatStake(stake: MatchStake): string {
  return new Intl.NumberFormat('bg-BG').format(stake)
}

function getInitialLetter(value: string): string {
  return value.trim().charAt(0).toUpperCase() || '?'
}

function formatChatTime(createdAtMs: number): string {
  try {
    return new Date(createdAtMs).toLocaleTimeString('bg-BG', { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

function getTeamSlots(slots: PrivateRoomWaitingSlotSnapshot[], team: Team): [PrivateRoomWaitingSlotSnapshot, PrivateRoomWaitingSlotSnapshot] {
  const teamSlots = slots.filter((s) => s.team === team)
  return [teamSlots[0]!, teamSlots[1]!]
}

function getLocalTeam(slots: PrivateRoomWaitingSlotSnapshot[], localProfileId: string | null): Team | null {
  if (localProfileId === null) return null
  const ownSlot = slots.find((s) => s.occupant !== null && !s.occupant.isBot && s.occupant.profileId === localProfileId)
  return ownSlot?.team ?? null
}

type TeamBotControlState = {
  label: string
  mode: 'fill' | 'remove' | null
  enabled: boolean
}

function computeTeamBotControlState(
  slots: PrivateRoomWaitingSlotSnapshot[],
  team: Team,
  localTeam: Team | null,
): TeamBotControlState {
  const [slotA, slotB] = getTeamSlots(slots, team)
  const occupants = [slotA.occupant, slotB.occupant]
  const humanCount = occupants.filter((o) => o !== null && !o.isBot).length
  const botCount = occupants.filter((o) => o !== null && o.isBot).length
  const isOwnTeam = localTeam === team

  if (!isOwnTeam) {
    // Винаги видим, никога скрит — просто disabled за противниковия отбор /
    // spectator-и, показва реалното състояние на този отбор.
    if (botCount > 0) return { label: 'Махни бот', mode: 'remove', enabled: false }
    if (humanCount === 2) return { label: 'Отборът е пълен', mode: null, enabled: false }
    return { label: 'Запълни с бот', mode: 'fill', enabled: false }
  }

  if (humanCount === 1 && botCount === 0) return { label: 'Запълни с бот', mode: 'fill', enabled: true }
  if (humanCount === 1 && botCount === 1) return { label: 'Махни бот', mode: 'remove', enabled: true }
  if (humanCount === 2) return { label: 'Отборът е пълен', mode: null, enabled: false }
  return { label: 'Запълни с бот', mode: 'fill', enabled: false }
}

function renderSlotCard(
  slot: PrivateRoomWaitingSlotSnapshot,
  localProfileId: string | null,
  viewerRole: PrivateRoomWaitingViewerRole,
): string {
  const occupant = slot.occupant
  const slotKey = `${slot.team}:${slot.slotIndex}`

  if (occupant === null) {
    const clickable = viewerRole === 'previewer'
    return `
      <button
        type="button"
        data-private-room-slot-join="${slotKey}"
        class="prw-slot prw-slot-empty"
        ${clickable ? '' : 'disabled'}
      >
        <span class="prw-slot-plus" aria-hidden="true">+</span>
        <span class="prw-slot-name-empty">Свободно място</span>
      </button>
    `
  }

  const isLocal = viewerRole === 'member' && !occupant.isBot && occupant.profileId !== null && occupant.profileId === localProfileId
  const isClickableProfile = !occupant.isBot && !isLocal && occupant.profileId !== null

  const subLine = occupant.isBot
    ? '<span class="prw-bot-badge">БОТ</span>'
    : occupant.isHost
      ? '<span class="prw-host-badge">ДОМАКИН</span>'
      : (occupant.rankTitle ? escapeHtml(occupant.rankTitle) : 'Играч')

  const innerHtml = `
    <div class="prw-slot-avatar${occupant.isBot ? ' prw-slot-avatar-bot' : ''}">
      ${occupant.avatarUrl ? `<img src="${escapeHtml(occupant.avatarUrl)}" alt="" draggable="false">` : escapeHtml(occupant.isBot ? '🤖' : getInitialLetter(occupant.displayName))}
      ${isLocal ? `
        <button type="button" data-private-room-leave-slot="1" class="prw-leave-badge" aria-label="Напусни мястото си">
          <span aria-hidden="true">−</span>
        </button>
      ` : ''}
    </div>
    <div class="prw-slot-copy">
      <div class="prw-slot-name">
        ${escapeHtml(occupant.displayName)}${isLocal ? ' <span class="prw-you-tag">ТИ</span>' : ''}
      </div>
      <div class="prw-slot-sub">${subLine}</div>
    </div>
  `

  if (isClickableProfile) {
    return `
      <button
        type="button"
        data-private-room-member="${escapeHtml(occupant.profileId ?? '')}"
        data-private-room-member-name="${escapeHtml(occupant.displayName)}"
        class="prw-slot${isLocal ? ' prw-slot-local' : ''}"
      >${innerHtml}</button>
    `
  }

  return `<div class="prw-slot${isLocal ? ' prw-slot-local' : ''}">${innerHtml}</div>`
}

function renderTeamColumn(
  slots: PrivateRoomWaitingSlotSnapshot[],
  team: Team,
  localProfileId: string | null,
  viewerRole: PrivateRoomWaitingViewerRole,
  localTeam: Team | null,
  botActionLoadingTeam: Team | null,
): string {
  const [slotA, slotB] = getTeamSlots(slots, team)
  const control = computeTeamBotControlState(slots, team, localTeam)
  const isLoading = botActionLoadingTeam === team
  const teamLabel = team === 'A' ? 'Отбор А' : 'Отбор Б'

  return `
    <div class="prw-team">
      <div class="prw-team-header">${teamLabel}</div>
      <div class="prw-team-slots">
        ${renderSlotCard(slotA, localProfileId, viewerRole)}
        ${renderSlotCard(slotB, localProfileId, viewerRole)}
      </div>
      <div class="prw-bot-row">
        <button
          type="button"
          data-private-room-bot-team="${team}"
          data-private-room-bot-mode="${control.mode ?? ''}"
          class="prw-bot-button"
          ${control.enabled && !isLoading ? '' : 'disabled'}
        >${isLoading ? '...' : control.label}</button>
      </div>
    </div>
  `
}

function renderChatMessage(message: PrivateRoomWaitingChatMessageSnapshot, localProfileId: string | null): string {
  const isOwn = message.senderProfileId !== null && message.senderProfileId === localProfileId

  return `
    <div class="prw-chat-row${isOwn ? ' prw-chat-row-own' : ''}">
      <div class="prw-chat-bubble">
        ${isOwn ? '' : `<div class="prw-chat-sender">${escapeHtml(message.senderDisplayName)}</div>`}
        <div class="prw-chat-body">${escapeHtml(message.body)}</div>
        <div class="prw-chat-time">${formatChatTime(message.createdAt)}</div>
      </div>
    </div>
  `
}

export function renderPrivateRoomWaitingScreen(params: RenderPrivateRoomWaitingScreenParams): string {
  const occupiedCount = params.slots.filter((s) => s.occupant !== null).length
  const localTeam = getLocalTeam(params.slots, params.localProfileId)
  const isMember = params.viewerRole === 'member'

  return `
    <section data-private-room-waiting-screen="1" class="prw-screen">
      <style>
        .prw-screen {
          min-height:100vh;
          min-height:100dvh;
          width:100%;
          box-sizing:border-box;
          display:flex;
          align-items:flex-start;
          justify-content:center;
          padding:24px 16px 40px;
          background:radial-gradient(circle at 50% 0%, rgba(212,165,32,0.10), transparent 40%), #000000;
          color:#f8fafc;
          font-family:Inter, Arial, sans-serif;
          overflow-y:auto;
          overscroll-behavior-y:contain;
        }

        .prw-shell {
          width:min(100%, 760px);
          display:grid;
          gap:16px;
        }

        .prw-header {
          display:flex;
          align-items:center;
          justify-content:space-between;
          gap:12px;
          flex-wrap:wrap;
        }

        .prw-title {
          margin:0;
          font-size:22px;
          font-weight:900;
          color:#d4a520;
          letter-spacing:0.02em;
        }

        .prw-subtitle {
          margin-top:4px;
          font-size:13px;
          font-weight:700;
          color:rgba(248,250,252,0.56);
        }

        .prw-waiting-actions {
          display:flex;
          gap:10px;
          flex-wrap:wrap;
        }

        .prw-wait-in-lobby-button {
          height:38px;
          padding:0 16px;
          border-radius:8px;
          border:1px solid rgba(255,255,255,0.18);
          background:rgba(255,255,255,0.06);
          color:rgba(255,255,255,0.85);
          font-size:13px;
          font-weight:800;
          cursor:pointer;
        }

        .prw-header-actions {
          display:flex;
          align-items:center;
          gap:10px;
          flex-wrap:wrap;
        }

        .prw-countdown {
          display:flex;
          align-items:baseline;
          gap:6px;
          padding:8px 14px;
          border-radius:8px;
          background:rgba(255,255,255,0.06);
          border:1px solid rgba(255,255,255,0.14);
          white-space:nowrap;
        }

        .prw-countdown-label {
          font-size:11px;
          font-weight:700;
          color:rgba(248,250,252,0.56);
          text-transform:uppercase;
          letter-spacing:0.03em;
        }

        .prw-countdown-label-short {
          display:none;
        }

        .prw-countdown-value {
          font-size:15px;
          font-weight:900;
          color:#f8fafc;
          font-variant-numeric:tabular-nums;
        }

        .prw-countdown-warning {
          border-color:rgba(239,68,68,0.45);
          background:rgba(239,68,68,0.08);
        }

        .prw-countdown-warning .prw-countdown-value {
          color:#f87171;
        }

        .prw-countdown-critical {
          border-color:rgba(239,68,68,0.6);
          background:rgba(239,68,68,0.12);
        }

        .prw-countdown-critical .prw-countdown-value {
          color:#f87171;
          animation:prw-countdown-pulse 1s ease-in-out infinite;
        }

        @keyframes prw-countdown-pulse {
          0%, 100% { opacity:1; }
          50% { opacity:0.55; }
        }

        @media (prefers-reduced-motion: reduce) {
          .prw-countdown-critical .prw-countdown-value {
            animation:none;
          }
        }

        .prw-info-banner {
          padding:10px 14px;
          border-radius:10px;
          background:rgba(212,165,32,0.10);
          border:1px solid rgba(212,165,32,0.30);
          color:#f4c95b;
          font-size:13px;
          font-weight:700;
        }

        /* ─── Team columns ─────────────────────────────────────────────── */

        .prw-teams {
          display:grid;
          grid-template-columns:1fr auto 1fr;
          gap:clamp(8px, 3vw, 16px);
          align-items:start;
        }

        .prw-team {
          display:grid;
          gap:8px;
          min-width:0;
        }

        .prw-team-divider {
          align-self:stretch;
          width:1px;
          background:rgba(255,255,255,0.14);
        }

        .prw-team-header {
          text-align:center;
          font-size:13px;
          font-weight:900;
          letter-spacing:0.04em;
          text-transform:uppercase;
          color:#d4a520;
        }

        .prw-team-slots {
          display:grid;
          gap:8px;
        }

        .prw-slot {
          display:flex;
          align-items:center;
          gap:10px;
          padding:10px 12px;
          border-radius:12px;
          background:rgba(255,255,255,0.05);
          border:1px solid rgba(255,255,255,0.10);
          min-width:0;
          width:100%;
          box-sizing:border-box;
          text-align:left;
          font-family:inherit;
          color:inherit;
        }

        button.prw-slot {
          cursor:pointer;
        }

        div.prw-slot {
          cursor:default;
        }

        .prw-slot-local {
          border-color:rgba(212,165,32,0.55);
          background:rgba(212,165,32,0.08);
        }

        .prw-slot-empty {
          border:1px dashed rgba(255,255,255,0.16);
          background:rgba(255,255,255,0.02);
          justify-content:center;
          flex-direction:column;
          gap:2px;
          cursor:pointer;
        }

        .prw-slot-empty:disabled {
          cursor:default;
          opacity:0.7;
        }

        .prw-slot-plus {
          font-size:26px;
          line-height:1;
          font-weight:900;
          color:#f4c95b;
        }

        .prw-slot-empty:disabled .prw-slot-plus {
          color:rgba(244,201,91,0.35);
        }

        .prw-slot-name-empty {
          font-size:11px;
          font-style:italic;
          color:rgba(255,255,255,0.34);
          font-weight:600;
        }

        .prw-slot-avatar {
          position:relative;
          width:42px;
          height:42px;
          flex:0 0 42px;
          border-radius:50%;
          background:rgba(212,165,32,0.16);
          border:2px solid rgba(212,165,32,0.45);
          display:flex;
          align-items:center;
          justify-content:center;
          font-size:17px;
          font-weight:900;
          color:#f4c95b;
          overflow:visible;
        }

        .prw-slot-avatar img {
          width:100%;
          height:100%;
          border-radius:50%;
          object-fit:cover;
        }

        .prw-slot-avatar-bot {
          background:rgba(148,163,184,0.16);
          border-color:rgba(148,163,184,0.5);
          color:#cbd5e1;
        }

        .prw-leave-badge {
          position:absolute;
          top:-6px;
          right:-6px;
          width:24px;
          height:24px;
          border-radius:50%;
          background:#ef4444;
          border:2px solid #000;
          color:#fff;
          font-size:15px;
          font-weight:900;
          line-height:1;
          display:flex;
          align-items:center;
          justify-content:center;
          cursor:pointer;
          padding:0;
        }

        .prw-slot-copy {
          min-width:0;
          flex:1 1 auto;
        }

        .prw-slot-name {
          font-size:14px;
          font-weight:800;
          color:#f8fafc;
          overflow:hidden;
          text-overflow:ellipsis;
          white-space:nowrap;
        }

        .prw-slot-sub {
          margin-top:2px;
          font-size:11px;
          font-weight:700;
          color:rgba(255,255,255,0.42);
        }

        .prw-you-tag {
          font-size:10px;
          font-weight:900;
          color:#d4a520;
        }

        .prw-host-badge {
          color:#a78bfa;
          font-weight:900;
        }

        .prw-bot-badge {
          color:#94a3b8;
          font-weight:900;
        }

        .prw-bot-row {
          display:flex;
        }

        .prw-bot-button {
          width:100%;
          height:40px;
          border-radius:10px;
          border:0;
          background:linear-gradient(180deg, #f4c95b 0%, #c98f13 100%);
          color:#101010;
          font-size:13px;
          font-weight:900;
          cursor:pointer;
        }

        .prw-bot-button:disabled {
          opacity:0.5;
          cursor:not-allowed;
          background:rgba(255,255,255,0.10);
          color:rgba(255,255,255,0.5);
        }

        /* ─── Popups (join-confirm / leave-confirm / blocked-partner) ────── */

        ${PRIVATE_ROOM_POPUP_STYLES}

        .prw-chat-panel {
          border-radius:12px;
          border:1px solid rgba(255,255,255,0.10);
          background:rgba(255,255,255,0.03);
          display:grid;
          grid-template-rows:auto 1fr auto;
          height:360px;
          overflow:hidden;
        }

        .prw-chat-header {
          padding:10px 14px;
          font-size:12px;
          font-weight:900;
          letter-spacing:0.05em;
          text-transform:uppercase;
          color:rgba(255,255,255,0.5);
          border-bottom:1px solid rgba(255,255,255,0.08);
        }

        .prw-chat-scroll {
          overflow-y:auto;
          padding:12px 14px;
          display:flex;
          flex-direction:column;
          gap:8px;
        }

        .prw-chat-empty {
          margin:auto;
          color:rgba(255,255,255,0.32);
          font-size:13px;
          font-weight:700;
          text-align:center;
        }

        .prw-chat-row {
          display:flex;
        }

        .prw-chat-row-own {
          justify-content:flex-end;
        }

        .prw-chat-bubble {
          max-width:78%;
          padding:8px 12px;
          border-radius:12px 12px 12px 4px;
          background:#1e1e1e;
          border:1px solid rgba(255,255,255,0.10);
        }

        .prw-chat-row-own .prw-chat-bubble {
          border-radius:12px 12px 4px 12px;
          background:rgba(212,165,32,0.16);
          border-color:rgba(212,165,32,0.32);
        }

        .prw-chat-sender {
          font-size:11px;
          font-weight:900;
          color:#d4a520;
          margin-bottom:2px;
        }

        .prw-chat-body {
          font-size:13px;
          font-weight:600;
          color:#f8fafc;
          word-break:break-word;
          white-space:pre-wrap;
        }

        .prw-chat-time {
          margin-top:3px;
          font-size:10px;
          font-weight:700;
          color:rgba(255,255,255,0.35);
        }

        .prw-chat-form {
          display:flex;
          gap:8px;
          padding:10px;
          border-top:1px solid rgba(255,255,255,0.08);
        }

        .prw-chat-input {
          flex:1;
          min-width:0;
          height:40px;
          border-radius:8px;
          border:1px solid rgba(255,255,255,0.16);
          background:#141414;
          color:#f8fafc;
          padding:0 12px;
          font-size:13px;
          font-weight:600;
          outline:none;
        }

        .prw-chat-send {
          height:40px;
          padding:0 16px;
          border-radius:8px;
          border:0;
          background:linear-gradient(180deg, #f4c95b 0%, #c98f13 100%);
          color:#101010;
          font-size:13px;
          font-weight:900;
          cursor:pointer;
        }

        .prw-chat-send:disabled {
          opacity:0.55;
          cursor:not-allowed;
        }

        .prw-chat-error {
          padding:6px 14px;
          font-size:11px;
          font-weight:800;
          color:#fca5a5;
        }

        @media (max-width: 640px) {
          .prw-screen {
            padding:14px 10px calc(14px + env(safe-area-inset-bottom, 0px));
            display:block;
          }

          .prw-shell {
            width:100%;
            display:flex;
            flex-direction:column;
            gap:10px;
            min-height:calc(100vh - 28px);
            min-height:calc(100dvh - 28px);
          }

          .prw-header {
            flex-direction:column;
            align-items:stretch;
            gap:6px;
          }

          .prw-title {
            font-size:17px;
          }

          .prw-subtitle {
            font-size:12px;
          }

          .prw-header-actions {
            width:100%;
            justify-content:space-between;
            flex-wrap:nowrap;
          }

          .prw-header-actions .prw-countdown {
            flex:0 1 auto;
            min-width:0;
            padding:7px 10px;
          }

          .prw-header-actions .prw-countdown-label {
            overflow:hidden;
            text-overflow:ellipsis;
            white-space:nowrap;
          }

          .prw-waiting-actions {
            width:100%;
            gap:8px;
            flex-wrap:nowrap;
          }

          .prw-waiting-actions .prw-wait-in-lobby-button {
            flex:1 1 0;
            min-width:0;
            height:36px;
            padding:0 10px;
            overflow:hidden;
            text-overflow:ellipsis;
            white-space:nowrap;
          }

          @media (max-width: 340px) {
            .prw-header-actions .prw-countdown-label-full {
              display:none;
            }

            .prw-header-actions .prw-countdown-label-short {
              display:inline;
              overflow:visible;
              text-overflow:clip;
              white-space:nowrap;
            }
          }

          /* Точка 2: отборите остават side-by-side и на mobile — НЕ се
             stack-ват вертикално. Само отстъпите/шрифтовете се смаляват,
             за да се съберат в тесен viewport без хоризонтален overflow. */
          .prw-teams {
            gap:6px;
          }

          .prw-team-header {
            font-size:11px;
          }

          .prw-team-slots {
            gap:6px;
          }

          .prw-slot {
            padding:7px 8px;
            gap:6px;
          }

          .prw-slot-avatar {
            width:32px;
            height:32px;
            flex:0 0 32px;
            font-size:13px;
          }

          .prw-leave-badge {
            width:22px;
            height:22px;
            font-size:13px;
            top:-5px;
            right:-5px;
          }

          .prw-slot-plus {
            font-size:20px;
          }

          .prw-slot-name {
            font-size:11px;
          }

          .prw-slot-sub {
            font-size:9px;
          }

          .prw-slot-name-empty {
            font-size:10px;
          }

          .prw-host-badge,
          .prw-bot-badge {
            display:inline-flex;
            align-items:center;
            padding:1px 5px;
            border-radius:999px;
            font-size:8px;
            letter-spacing:0.02em;
            white-space:nowrap;
          }

          .prw-host-badge {
            background:rgba(167,139,250,0.16);
            border:1px solid rgba(167,139,250,0.4);
          }

          .prw-bot-badge {
            background:rgba(148,163,184,0.14);
            border:1px solid rgba(148,163,184,0.4);
          }

          .prw-bot-button {
            height:36px;
            font-size:11px;
          }

          .prw-chat-panel {
            flex:1 1 260px;
            min-height:220px;
            display:flex;
            flex-direction:column;
          }

          .prw-chat-header {
            flex:0 0 auto;
          }

          .prw-chat-scroll {
            flex:1 1 auto;
            min-height:0;
            overflow-y:auto;
            overscroll-behavior-y:contain;
          }

          .prw-chat-form {
            flex:0 0 auto;
            padding:8px;
            padding-bottom:calc(8px + env(safe-area-inset-bottom, 0px));
          }

          .prw-chat-input,
          .prw-chat-send {
            height:38px;
          }
        }
      </style>

      <div class="prw-shell">
        <div class="prw-header">
          <div>
            <h1 class="prw-title">Чакалня — частна маса</h1>
            <div class="prw-subtitle">
              ${params.isLocked ? 'Заключена' : 'Отворена'} · Залог ${formatStake(params.stake)} · ${occupiedCount}/4 заети места
            </div>
          </div>
          <div class="prw-header-actions">
            ${renderCountdownBadge(params.expiresAt)}
          </div>
        </div>

        <div class="prw-waiting-actions">
          <button type="button" data-private-waiting-wait-in-lobby-button="1" class="prw-wait-in-lobby-button">Изчакай в лоби</button>
          ${params.isLocked && isMember && occupiedCount < 4
            ? `<button type="button" data-private-room-invite-open="1" class="prw-wait-in-lobby-button">+ Покани приятели</button>`
            : ''}
        </div>

        ${params.infoText ? `<div class="prw-info-banner">${escapeHtml(params.infoText)}</div>` : ''}

        <div class="prw-teams">
          ${renderTeamColumn(params.slots, 'A', params.localProfileId, params.viewerRole, localTeam, params.botActionLoadingTeam)}
          <div class="prw-team-divider" aria-hidden="true"></div>
          ${renderTeamColumn(params.slots, 'B', params.localProfileId, params.viewerRole, localTeam, params.botActionLoadingTeam)}
        </div>

        <div class="prw-chat-panel">
          <div class="prw-chat-header">Чат на чакалнята</div>
          <div data-private-waiting-chat-scroll="1" class="prw-chat-scroll">
            ${!isMember
              ? '<div class="prw-chat-empty">Чатът е достъпен, след като заемете място на масата.</div>'
              : params.chatMessages.length === 0
                ? '<div class="prw-chat-empty">Все още няма съобщения.<br>Напиши нещо на другите играчи.</div>'
                : params.chatMessages.map((m) => renderChatMessage(m, params.localProfileId)).join('')}
          </div>
          ${params.chatErrorText ? `<div class="prw-chat-error">${escapeHtml(params.chatErrorText)}</div>` : ''}
          <form data-private-waiting-chat-form="1" class="prw-chat-form">
            <input
              data-private-waiting-chat-input="1"
              class="prw-chat-input"
              type="text"
              maxlength="300"
              autocomplete="off"
              placeholder="Напиши съобщение..."
              value="${escapeHtml(params.chatDraft)}"
              ${params.chatSending || !isMember ? 'disabled' : ''}
            >
            <button type="submit" class="prw-chat-send" ${params.chatSending || !isMember ? 'disabled' : ''}>Изпрати</button>
          </form>
        </div>
      </div>

      ${renderPrivateRoomJoinConfirmPopup(params.joinSlotPopup)}

      ${renderPrivateRoomInviteFriendsPopup({
        isOpen: params.inviteFriendsPopupOpen,
        freeSeats: 4 - occupiedCount,
        friends: params.inviteFriends,
      })}

      ${params.leaveConfirmOpen ? `
        <div class="prw-popup-backdrop" data-private-room-leave-popup-backdrop="1">
          <div class="prw-popup-box">
            <div class="prw-popup-title">Напускане на масата</div>
            <div class="prw-popup-text">Сигурни ли сте, че искате да освободите мястото си в тази частна маса?</div>
            <div class="prw-popup-actions">
              <button type="button" data-private-room-leave-popup-confirm="1" class="prw-confirm-yes prw-confirm-danger">Напусни</button>
              <button type="button" data-private-room-leave-popup-cancel="1" class="prw-confirm-cancel">Отказ</button>
            </div>
          </div>
        </div>
      ` : ''}

      ${renderPrivateRoomBlockedPopup(params.blockedPopupText)}
    </section>
  `
}
