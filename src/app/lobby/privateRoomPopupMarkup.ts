// Споделена popup markup/CSS между renderPrivateRoomWaitingScreen.ts (member
// waiting room) и renderLobbyScreen.ts (списъка "Частни маси" — директен "+"
// join). И двата екрана трябва да показват идентичния join-confirm и
// X-only blocked-partner popup, но никога не са монтирани едновременно
// (само едно currentScreen наведнъж), затова споделянето на markup/CSS тук
// е безопасно — еднакви data-* атрибути, wiring-ът се прави отделно във
// всеки от двата файла (различни render/wire дървета).
import type { Team } from '../network/createGameServerClient'

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export const PRIVATE_ROOM_POPUP_STYLES = `
  .prw-popup-backdrop {
    position:fixed;
    inset:0;
    z-index:9400;
    background:rgba(0,0,0,0.7);
    display:flex;
    align-items:center;
    justify-content:center;
    padding:20px;
  }

  .prw-popup-box {
    position:relative;
    width:min(100%, 380px);
    background:#1a1a2e;
    border:1px solid rgba(212,165,32,0.35);
    border-radius:14px;
    padding:20px;
    display:grid;
    gap:12px;
  }

  .prw-popup-title {
    font-size:15px;
    font-weight:900;
    color:#f4c95b;
  }

  .prw-popup-text {
    font-size:13px;
    font-weight:600;
    color:#f8fafc;
    line-height:1.5;
  }

  .prw-popup-actions {
    display:flex;
    gap:10px;
  }

  .prw-popup-close-x {
    position:absolute;
    top:10px;
    right:10px;
    width:28px;
    height:28px;
    border-radius:50%;
    border:1px solid rgba(255,255,255,0.18);
    background:rgba(255,255,255,0.06);
    color:#f8fafc;
    font-size:14px;
    cursor:pointer;
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

  .prw-invite-box {
    width:min(100%, 420px);
    max-height:80vh;
  }

  .prw-invite-list {
    overflow-y:auto;
    max-height:min(60vh, 420px);
    display:grid;
    gap:8px;
  }

  .prw-invite-empty {
    text-align:center;
    padding:28px 0;
    color:rgba(248,250,252,0.5);
    font-size:13px;
  }

  .prw-invite-row {
    display:flex;
    align-items:center;
    gap:10px;
    padding:8px;
    border-radius:10px;
    background:rgba(255,255,255,0.03);
  }

  .prw-invite-avatar {
    width:40px;
    height:40px;
    border-radius:50%;
    overflow:hidden;
    flex-shrink:0;
    border:1.5px solid rgba(212,165,32,0.4);
  }

  .prw-invite-avatar-img {
    width:100%;
    height:100%;
    object-fit:cover;
  }

  .prw-invite-avatar-fallback {
    width:100%;
    height:100%;
    display:flex;
    align-items:center;
    justify-content:center;
    font-size:18px;
  }

  .prw-invite-info {
    flex:1;
    min-width:0;
  }

  .prw-invite-name {
    font-size:13px;
    font-weight:700;
    color:#f8fafc;
    overflow:hidden;
    text-overflow:ellipsis;
    white-space:nowrap;
  }

  .prw-invite-status {
    font-size:11px;
    margin-top:1px;
  }

  .prw-invite-status-online {
    color:#4ade80;
  }

  .prw-invite-status-offline {
    color:rgba(248,250,252,0.45);
  }

  .prw-invite-status-busy {
    color:#f87171;
  }

  .prw-invite-send-btn {
    flex-shrink:0;
    height:32px;
    padding:0 14px;
    border-radius:8px;
    border:0;
    background:linear-gradient(180deg, #f4c95b 0%, #c98f13 100%);
    color:#101010;
    font-size:12px;
    font-weight:800;
    cursor:pointer;
  }

  .prw-invite-send-btn:disabled {
    background:rgba(255,255,255,0.10);
    color:rgba(248,250,252,0.4);
    cursor:not-allowed;
  }
`

export function renderPrivateRoomJoinConfirmPopup(popup: { team: Team } | null): string {
  if (!popup) return ''
  return `
    <div class="prw-popup-backdrop" data-private-room-join-popup-backdrop="1">
      <div class="prw-popup-box">
        <div class="prw-popup-title">Влизане в частна маса</div>
        <div class="prw-popup-text">Вие ще седнете на тази маса в Отбор ${popup.team === 'A' ? 'А' : 'Б'}.</div>
        <div class="prw-popup-actions">
          <button type="button" data-private-room-join-popup-confirm="1" class="prw-confirm-yes">Влез</button>
          <button type="button" data-private-room-join-popup-cancel="1" class="prw-confirm-cancel">Отказ</button>
        </div>
      </div>
    </div>
  `
}

export function renderPrivateRoomKickConfirmPopup(popup: { displayName: string } | null): string {
  if (!popup) return ''
  return `
    <div class="prw-popup-backdrop" data-private-room-kick-popup-backdrop="1">
      <div class="prw-popup-box">
        <div class="prw-popup-title">Премахване на играч</div>
        <div class="prw-popup-text">Сигурни ли сте, че искате да премахнете ${escapeHtml(popup.displayName)} от масата?</div>
        <div class="prw-popup-actions">
          <button type="button" data-private-room-kick-popup-confirm="1" class="prw-confirm-yes prw-confirm-danger">Премахни</button>
          <button type="button" data-private-room-kick-popup-cancel="1" class="prw-confirm-cancel">Отказ</button>
        </div>
      </div>
    </div>
  `
}

export function renderPrivateRoomBlockedPopup(blockedPopupText: string | null): string {
  if (!blockedPopupText) return ''
  return `
    <div class="prw-popup-backdrop" data-private-room-blocked-popup-backdrop="1">
      <div class="prw-popup-box">
        <button type="button" data-private-room-blocked-popup-close="1" class="prw-popup-close-x" aria-label="Затвори">✕</button>
        <div class="prw-popup-title">Не можете да влезете в този отбор</div>
        <div class="prw-popup-text">${escapeHtml(blockedPopupText)}</div>
      </div>
    </div>
  `
}

// Eligible = вече изключени: самия viewer, вече седнали в масата хора.
// "sent" state се пази client-side (виж createLobbyFlowController.ts's
// privateRoomInvitedProfileIds) — сървърът не излага pendingInvites в
// PrivateRoomSnapshot, затова UI-ът проследява собствените си изпратени
// покани оптимистично; сървърът си остава authority срещу реален spam
// (inviteFriend отхвърля дубликат с 'Вече е изпратена покана до този играч.').
export type PrivateRoomInviteEligibleFriend = {
  profileId: string
  displayName: string
  avatarUrl: string | null
  isOnline: boolean
  isInGame: boolean
  status: 'invitable' | 'sent'
}

export function renderPrivateRoomInviteFriendsPopup(params: {
  isOpen: boolean
  freeSeats: number
  friends: PrivateRoomInviteEligibleFriend[] | null
}): string {
  if (!params.isOpen) return ''

  const listHtml = params.friends === null
    ? `<div class="prw-invite-empty">Зарежда...</div>`
    : params.friends.length === 0
      ? `<div class="prw-invite-empty">Нямаш приятели, които можеш да поканиш в момента.</div>`
      : params.friends.map((f) => {
          const avatarHtml = f.avatarUrl
            ? `<img src="${escapeHtml(f.avatarUrl)}" alt="" class="prw-invite-avatar-img">`
            : `<div class="prw-invite-avatar-fallback">👤</div>`
          const statusText = f.isInGame ? 'В игра' : f.isOnline ? 'Онлайн' : 'Офлайн'
          const statusClass = f.isInGame ? 'prw-invite-status-busy' : f.isOnline ? 'prw-invite-status-online' : 'prw-invite-status-offline'
          const buttonDisabled = f.isInGame || f.status === 'sent'
          const buttonLabel = f.status === 'sent' ? 'Изпратена' : 'Покани'
          return `
            <div class="prw-invite-row">
              <div class="prw-invite-avatar">${avatarHtml}</div>
              <div class="prw-invite-info">
                <div class="prw-invite-name">${escapeHtml(f.displayName)}</div>
                <div class="prw-invite-status ${statusClass}">${statusText}</div>
              </div>
              <button
                type="button"
                data-private-room-invite-send="${escapeHtml(f.profileId)}:${escapeHtml(f.displayName)}"
                class="prw-invite-send-btn"
                ${buttonDisabled ? 'disabled' : ''}
              >${buttonLabel}</button>
            </div>
          `
        }).join('')

  return `
    <div class="prw-popup-backdrop" data-private-room-invite-backdrop="1">
      <div class="prw-popup-box prw-invite-box">
        <button type="button" data-private-room-invite-close="1" class="prw-popup-close-x" aria-label="Затвори">✕</button>
        <div class="prw-popup-title">Покани приятели</div>
        <div class="prw-popup-text">Свободни места: ${params.freeSeats}</div>
        <div class="prw-invite-list">${listHtml}</div>
      </div>
    </div>
  `
}
