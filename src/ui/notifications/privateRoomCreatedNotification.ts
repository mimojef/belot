import {
  createPrivateRoomCreatedNotificationQueue,
  type PrivateRoomCreatedNotice,
} from './privateRoomCreatedNotificationQueue'

type NotificationController = {
  handleIncoming: (notice: PrivateRoomCreatedNotice) => void
  syncPreferences: () => void
  destroy: () => void
}

const AUTO_DISMISS_MS = 8_000

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

const FALLBACK_AVATAR_HTML = `<div style="width:80px;height:80px;border-radius:10px;background:rgba(212,175,55,0.12);border:2px solid rgba(212,175,55,0.3);display:flex;align-items:center;justify-content:center;font-size:32px;flex-shrink:0;">👤</div>`

export function createPrivateRoomCreatedNotification(options: {
  container: HTMLElement
  isInActiveGame: () => boolean
  areInGameNotificationsEnabled: () => boolean
  isSoundEnabled: () => boolean
  onDisableInGameNotifications: () => void
  onEnterPrivateRooms: () => void
}): NotificationController {
  const queue = createPrivateRoomCreatedNotificationQueue()
  let current: PrivateRoomCreatedNotice | null = null
  let dismissTimer: ReturnType<typeof setTimeout> | null = null

  function clearDismissTimer(): void {
    if (dismissTimer !== null) {
      clearTimeout(dismissTimer)
      dismissTimer = null
    }
  }

  function playSound(): void {
    const audio = new Audio('/audio/Notifications/notification-1.mp3')
    audio.volume = 0.6
    void audio.play().catch(() => {/* autoplay policy */})
  }

  function dismiss(): void {
    clearDismissTimer()
    current = null
    render()
    advanceQueue()
  }

  function advanceQueue(): void {
    const decision = queue.handleDismissed()
    if (decision.action === 'show') {
      if (decision.notice.recipientInActiveGame && !options.areInGameNotificationsEnabled()) {
        advanceQueue()
        return
      }
      presentAndSchedule(decision.notice)
    }
  }

  function presentAndSchedule(notice: PrivateRoomCreatedNotice): void {
    current = notice
    clearDismissTimer()
    render()
    if (options.isSoundEnabled()) {
      playSound()
    }
    dismissTimer = setTimeout(dismiss, AUTO_DISMISS_MS)
  }

  function render(): void {
    if (current === null) {
      options.container.innerHTML = ''
      return
    }

    const notice = current
    const avatarHtml = notice.creatorAvatarUrl
      ? `<img id="private-room-created-avatar-img" src="${escapeHtml(notice.creatorAvatarUrl)}" style="width:80px;height:80px;object-fit:cover;border-radius:10px;display:block;border:2px solid rgba(212,175,55,0.4);">`
      : FALLBACK_AVATAR_HTML

    const bodyText = notice.recipientInActiveGame
      ? 'Създаде частна маса. Можеш да се присъединиш, след като завършиш играта.'
      : 'Създаде частна маса. Присъедини се, ако искаш.'

    const actionButtonHtml = notice.recipientInActiveGame
      ? `<button id="private-room-created-disable-in-game-btn" type="button" style="
          padding:7px 12px;border:1px solid rgba(212,175,55,0.45);
          background:rgba(212,175,55,0.08);
          border-radius:8px;color:#f6d36b;font-size:12px;font-weight:800;cursor:pointer;
          white-space:nowrap;
          transition:filter 0.15s,transform 0.15s;
        ">Изключи в игра</button>`
      : `<button id="private-room-created-enter-btn" type="button" style="
          padding:7px 14px;border:none;
          background:linear-gradient(135deg,#b8960c,#d4af37,#f0c040);
          border-radius:8px;color:#1a1200;font-size:13px;font-weight:800;cursor:pointer;
          white-space:nowrap;
          transition:filter 0.15s,transform 0.15s;
          box-shadow:0 2px 8px rgba(212,175,55,0.3);
        ">Влез</button>`

    options.container.innerHTML = `
      <style>
        @keyframes privateRoomCreatedNotifSlideIn {
          from { opacity:0; transform:translateX(-50%) translateY(-20px); }
          to   { opacity:1; transform:translateX(-50%) translateY(0); }
        }
        #private-room-created-notif-progress {
          animation: privateRoomCreatedNotifProgress ${AUTO_DISMISS_MS}ms linear forwards;
        }
        @keyframes privateRoomCreatedNotifProgress {
          from { width:100%; }
          to   { width:0%; }
        }
        #private-room-created-enter-btn:hover,
        #private-room-created-disable-in-game-btn:hover { filter:brightness(1.15); transform:translateY(-1px); }
        #private-room-created-close-btn:hover { filter:brightness(1.3); color:rgba(255,255,255,0.9) !important; }
      </style>
      <div style="
        position:fixed;top:calc(16px + env(safe-area-inset-top, 0px));left:50%;transform:translateX(-50%);
        z-index:99999;
        background:linear-gradient(135deg,rgba(18,14,6,0.98),rgba(10,8,3,0.98));
        border:1px solid rgba(212,175,55,0.45);
        border-radius:16px;
        padding:3px 10px 6px 3px;
        display:flex;align-items:center;gap:12px;
        box-shadow:0 8px 40px rgba(0,0,0,0.85),0 0 24px rgba(212,175,55,0.08);
        min-width:320px;max-width:90vw;
        animation:privateRoomCreatedNotifSlideIn 0.3s ease;
        overflow:hidden;
      ">
        <div id="private-room-created-avatar-slot" style="flex-shrink:0;">${avatarHtml}</div>

        <div style="flex:1;min-width:0;">
          <div style="font-size:15px;font-weight:800;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
            ${escapeHtml(notice.creatorDisplayName)}
          </div>
          <div style="font-size:13px;color:rgba(255,255,255,0.75);margin-top:2px;">${bodyText}</div>
        </div>

        <div style="display:flex;flex-direction:row;align-items:center;gap:8px;flex-shrink:0;">
          ${actionButtonHtml}
          <button id="private-room-created-close-btn" type="button" style="
            width:34px;height:34px;border-radius:50%;border:1px solid rgba(255,255,255,0.15);
            background:rgba(255,255,255,0.07);color:#fff;
            font-size:15px;font-weight:700;line-height:1;cursor:pointer;
            display:flex;align-items:center;justify-content:center;
            padding:0;flex-shrink:0;
            transition:filter 0.15s;
          ">✕</button>
        </div>

        <div style="
          position:absolute;bottom:0;left:0;height:3px;
          background:linear-gradient(90deg,#b8960c,#d4af37,#f0c040);
          border-radius:0 0 0 16px;
        " id="private-room-created-notif-progress"></div>
      </div>
    `

    options.container.querySelector('#private-room-created-close-btn')?.addEventListener('click', dismiss)

    options.container.querySelector('#private-room-created-enter-btn')?.addEventListener('click', () => {
      dismiss()
      options.onEnterPrivateRooms()
    })

    options.container.querySelector('#private-room-created-disable-in-game-btn')?.addEventListener('click', () => {
      options.onDisableInGameNotifications()
      dismiss()
    })

    // Ако аватар URL-ът сочи към счупено/невалидно изображение, замества се
    // със стандартния fallback вместо счупена картинка/празно място.
    options.container.querySelector('#private-room-created-avatar-img')?.addEventListener('error', () => {
      const slot = options.container.querySelector('#private-room-created-avatar-slot')
      if (slot) slot.innerHTML = FALLBACK_AVATAR_HTML
    }, { once: true })
  }

  function handleIncoming(notice: PrivateRoomCreatedNotice): void {
    const normalizedNotice: PrivateRoomCreatedNotice = {
      ...notice,
      recipientInActiveGame: options.isInActiveGame(),
    }

    if (normalizedNotice.recipientInActiveGame && !options.areInGameNotificationsEnabled()) {
      return
    }

    const decision = queue.handleIncoming(normalizedNotice)
    if (decision.action === 'show') {
      presentAndSchedule(decision.notice)
    }
    // 'queue' и 'skip' не пипат UI — известието или чака на реда си, или е дубликат.
  }

  function syncPreferences(): void {
    if (current?.recipientInActiveGame && !options.areInGameNotificationsEnabled()) {
      dismiss()
    }
  }

  function destroy(): void {
    clearDismissTimer()
    options.container.innerHTML = ''
  }

  return { handleIncoming, syncPreferences, destroy }
}
