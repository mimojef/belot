import type { MatchStake } from '../network/createGameServerClient'

export type PrivateRoomWaitingMemberSnapshot = {
  profileId: string | null
  displayName: string
  avatarUrl: string | null
  level: number | null
  rankTitle: string | null
  isHost: boolean
}

export type PrivateRoomWaitingChatMessageSnapshot = {
  seq: number
  messageId: string
  senderProfileId: string | null
  senderDisplayName: string
  body: string
  createdAt: number
}

export type RenderPrivateRoomWaitingScreenParams = {
  isLocked: boolean
  stake: MatchStake
  members: PrivateRoomWaitingMemberSnapshot[]
  localProfileId: string | null
  isHost: boolean
  canFillWithBots: boolean
  fillBotsLoading: boolean
  fillBotsConfirmOpen: boolean
  leaveConfirmOpen: boolean
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
      <span class="prw-countdown-label">Оставащо време</span>
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

function renderSeatCard(member: PrivateRoomWaitingMemberSnapshot | null, localProfileId: string | null): string {
  if (member === null) {
    return `
      <div class="prw-seat prw-seat-empty">
        <div class="prw-seat-avatar prw-seat-avatar-empty"></div>
        <div class="prw-seat-name prw-seat-name-empty">Свободно място</div>
      </div>
    `
  }

  const isLocal = member.profileId !== null && member.profileId === localProfileId

  return `
    <div class="prw-seat${isLocal ? ' prw-seat-local' : ''}">
      <div class="prw-seat-avatar">
        ${member.avatarUrl ? `<img src="${escapeHtml(member.avatarUrl)}" alt="" draggable="false">` : escapeHtml(getInitialLetter(member.displayName))}
      </div>
      <div class="prw-seat-copy">
        <div class="prw-seat-name">
          ${escapeHtml(member.displayName)}${isLocal ? ' <span class="prw-you-tag">ТИ</span>' : ''}
        </div>
        <div class="prw-seat-sub">
          ${member.isHost ? '<span class="prw-host-badge">ДОМАКИН</span>' : (member.rankTitle ? escapeHtml(member.rankTitle) : 'Играч')}
        </div>
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
  const seats: Array<PrivateRoomWaitingMemberSnapshot | null> = Array.from({ length: 4 }, (_, i) => params.members[i] ?? null)
  const humanCount = params.members.length

  return `
    <section data-private-room-waiting-screen="1" class="prw-screen">
      <style>
        .prw-screen {
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

        .prw-leave-button {
          height:38px;
          padding:0 16px;
          border-radius:8px;
          border:1px solid rgba(239,68,68,0.5);
          background:rgba(239,68,68,0.10);
          color:#f87171;
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

        .prw-countdown-mobile-row {
          display:none;
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

        .prw-seats {
          display:grid;
          grid-template-columns:1fr 1fr;
          gap:10px;
        }

        .prw-seat {
          display:flex;
          align-items:center;
          gap:12px;
          padding:12px 14px;
          border-radius:12px;
          background:rgba(255,255,255,0.05);
          border:1px solid rgba(255,255,255,0.10);
        }

        .prw-seat-local {
          border-color:rgba(212,165,32,0.55);
          background:rgba(212,165,32,0.08);
        }

        .prw-seat-empty {
          border:1px dashed rgba(255,255,255,0.16);
          background:rgba(255,255,255,0.02);
        }

        .prw-seat-avatar {
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
          overflow:hidden;
        }

        .prw-seat-avatar img {
          width:100%;
          height:100%;
          object-fit:cover;
        }

        .prw-seat-avatar-empty {
          background:rgba(255,255,255,0.04);
          border-color:rgba(255,255,255,0.14);
        }

        .prw-seat-copy {
          min-width:0;
          flex:1 1 auto;
        }

        .prw-seat-name {
          font-size:14px;
          font-weight:800;
          color:#f8fafc;
          overflow:hidden;
          text-overflow:ellipsis;
          white-space:nowrap;
        }

        .prw-seat-name-empty {
          font-style:italic;
          color:rgba(255,255,255,0.34);
          font-weight:600;
        }

        .prw-seat-sub {
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

        .prw-fillbots-row {
          display:flex;
          justify-content:center;
        }

        .prw-fillbots-button {
          width:100%;
          height:46px;
          border-radius:10px;
          border:0;
          background:linear-gradient(180deg, #f4c95b 0%, #c98f13 100%);
          color:#101010;
          font-size:14px;
          font-weight:900;
          cursor:pointer;
        }

        .prw-fillbots-button:disabled {
          opacity:0.55;
          cursor:not-allowed;
        }

        .prw-confirm-box {
          padding:14px;
          border-radius:12px;
          background:rgba(0,0,0,0.55);
          border:1px solid rgba(212,165,32,0.35);
          display:grid;
          gap:10px;
        }

        .prw-confirm-text {
          font-size:13px;
          font-weight:700;
          color:#f8fafc;
        }

        .prw-confirm-actions {
          display:flex;
          gap:10px;
        }

        .prw-confirm-yes,
        .prw-confirm-cancel {
          flex:1;
          height:40px;
          border-radius:8px;
          font-size:13px;
          font-weight:900;
          cursor:pointer;
        }

        .prw-confirm-yes {
          border:0;
          background:linear-gradient(180deg, #f4c95b 0%, #c98f13 100%);
          color:#101010;
        }

        .prw-confirm-cancel {
          border:1px solid rgba(255,255,255,0.18);
          background:transparent;
          color:rgba(255,255,255,0.75);
        }

        .prw-confirm-yes.prw-confirm-danger {
          background:#ef4444;
          color:#fff;
        }

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
          .prw-seats {
            grid-template-columns:1fr;
          }
          .prw-chat-panel {
            height:320px;
          }
          .prw-header .prw-countdown {
            display:none;
          }
          .prw-countdown-mobile-row {
            display:flex;
          }
        }
      </style>

      <div class="prw-shell">
        <div class="prw-header">
          <div>
            <h1 class="prw-title">Чакалня — частна маса</h1>
            <div class="prw-subtitle">
              ${params.isLocked ? 'Заключена' : 'Отворена'} · Залог ${formatStake(params.stake)} · ${humanCount}/4 играчи
            </div>
          </div>
          <div class="prw-header-actions">
            ${renderCountdownBadge(params.expiresAt)}
            <button type="button" data-private-waiting-leave-button="1" class="prw-leave-button">Напусни</button>
          </div>
        </div>

        <div class="prw-countdown-mobile-row">${renderCountdownBadge(params.expiresAt)}</div>

        ${params.infoText ? `<div class="prw-info-banner">${escapeHtml(params.infoText)}</div>` : ''}

        ${params.leaveConfirmOpen ? `
          <div class="prw-confirm-box">
            <div class="prw-confirm-text">Ако напуснеш чакалнята, мястото ти ще бъде освободено. Сигурен ли си?</div>
            <div class="prw-confirm-actions">
              <button type="button" data-private-waiting-leave-confirm-yes="1" class="prw-confirm-yes prw-confirm-danger">Да, напусни</button>
              <button type="button" data-private-waiting-leave-confirm-cancel="1" class="prw-confirm-cancel">Откажи</button>
            </div>
          </div>
        ` : ''}

        <div class="prw-seats">
          ${seats.map((seat) => renderSeatCard(seat, params.localProfileId)).join('')}
        </div>

        ${params.isHost ? `
          <div class="prw-fillbots-row">
            <button
              type="button"
              data-private-waiting-fillbots-button="1"
              class="prw-fillbots-button"
              ${params.canFillWithBots && !params.fillBotsLoading ? '' : 'disabled'}
            >${params.fillBotsLoading ? 'Стартиране...' : 'Запълни с ботове'}</button>
          </div>
        ` : ''}

        ${params.fillBotsConfirmOpen ? `
          <div class="prw-confirm-box">
            <div class="prw-confirm-text">Свободните места ще бъдат запълнени с ботове и играта ще започне. Продължи?</div>
            <div class="prw-confirm-actions">
              <button type="button" data-private-waiting-fillbots-confirm-yes="1" class="prw-confirm-yes">Да, продължи</button>
              <button type="button" data-private-waiting-fillbots-confirm-cancel="1" class="prw-confirm-cancel">Откажи</button>
            </div>
          </div>
        ` : ''}

        <div class="prw-chat-panel">
          <div class="prw-chat-header">Чат на чакалнята</div>
          <div data-private-waiting-chat-scroll="1" class="prw-chat-scroll">
            ${params.chatMessages.length === 0
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
              ${params.chatSending ? 'disabled' : ''}
            >
            <button type="submit" class="prw-chat-send" ${params.chatSending ? 'disabled' : ''}>Изпрати</button>
          </form>
        </div>
      </div>
    </section>
  `
}
