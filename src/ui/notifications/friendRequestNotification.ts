import type { FriendshipsSnapshot } from '../../app/network/createGameServerClient.js'

type FriendRequestNotif = {
  friendshipId: string
  fromProfileId: string
  fromDisplayName: string
  fromAvatarUrl: string | null
}

type AcceptedNotif = {
  fromDisplayName: string
  fromAvatarUrl: string | null
}

type FriendRequestController = {
  showRequest: (notification: FriendRequestNotif) => void
  showAccepted: (notification: AcceptedNotif) => void
  destroy: () => void
}

type ActionResult =
  | { ok: true; friendships: FriendshipsSnapshot }
  | { ok: false; message: string }

const AUTO_DISMISS_MS = 12_000
const CONFIRMATION_DISMISS_MS = 4_000

export function createFriendRequestNotification(options: {
  container: HTMLElement
  onAccept: (friendshipId: string) => Promise<ActionResult>
  onReject: (friendshipId: string) => Promise<ActionResult>
}): FriendRequestController {
  let current: FriendRequestNotif | null = null
  let confirmationName: string | null = null
  let dismissTimer: ReturnType<typeof setTimeout> | null = null
  let confirmationTimer: ReturnType<typeof setTimeout> | null = null
  let isProcessing = false
  let errorText: string | null = null

  function clearDismissTimer(): void {
    if (dismissTimer !== null) {
      clearTimeout(dismissTimer)
      dismissTimer = null
    }
  }

  function clearConfirmationTimer(): void {
    if (confirmationTimer !== null) {
      clearTimeout(confirmationTimer)
      confirmationTimer = null
    }
  }

  function playSound(): void {
    const audio = new Audio('/audio/ui/player-seat-fill.mp3')
    audio.volume = 0.6
    void audio.play().catch(() => {/* autoplay policy */})
  }

  function fadeOutAndClear(afterFade: () => void): void {
    const div = options.container.querySelector<HTMLElement>('div[style*="position:fixed"]')
    if (!div) {
      afterFade()
      return
    }
    div.style.transition = 'opacity 0.4s ease, transform 0.4s ease'
    div.style.opacity = '0'
    div.style.transform = 'translateX(-50%) translateY(-10px)'
    setTimeout(afterFade, 420)
  }

  // Called only by the auto-dismiss timer — no API call, just hide.
  function dismissByTimer(): void {
    clearDismissTimer()
    if (isProcessing) return
    fadeOutAndClear(() => {
      current = null
      errorText = null
      render()
    })
  }

  function dismissConfirmation(): void {
    clearConfirmationTimer()
    fadeOutAndClear(() => {
      confirmationName = null
      render()
    })
  }

  function render(): void {
    if (confirmationName !== null) {
      const name = confirmationName
      options.container.innerHTML = `
        <div style="
          position:fixed;top:16px;left:50%;transform:translateX(-50%);
          z-index:99999;
          background:linear-gradient(135deg,rgba(18,14,6,0.98),rgba(10,8,3,0.98));
          border:1px solid rgba(212,175,55,0.5);
          border-radius:16px;
          padding:16px 24px;
          display:flex;align-items:center;gap:14px;
          box-shadow:0 8px 40px rgba(0,0,0,0.85),0 0 24px rgba(212,175,55,0.08);
          min-width:320px;max-width:90vw;
        ">
          <div style="font-size:28px;line-height:1;">🤝</div>
          <div style="font-size:15px;font-weight:700;color:#fff;">
            Вие станахте приятел на <span style="color:#d4af37;">${name}</span>
          </div>
        </div>
      `
      return
    }

    if (current === null) {
      options.container.innerHTML = ''
      return
    }

    const notif = current
    const avatarHtml = notif.fromAvatarUrl
      ? `<img src="${notif.fromAvatarUrl}" style="width:80px;height:80px;object-fit:cover;border-radius:10px;display:block;border:2px solid rgba(212,175,55,0.4);">`
      : `<div style="width:80px;height:80px;border-radius:10px;background:rgba(212,175,55,0.12);border:2px solid rgba(212,175,55,0.3);display:flex;align-items:center;justify-content:center;font-size:32px;flex-shrink:0;">👤</div>`

    const btnDisabled = isProcessing ? 'disabled' : ''
    const btnCursor = isProcessing ? 'not-allowed' : 'pointer'
    const btnOpacity = isProcessing ? '0.6' : '1'

    options.container.innerHTML = `
      <style>
        @keyframes friendReqSlideIn {
          from { opacity:0; transform:translateX(-50%) translateY(-20px); }
          to   { opacity:1; transform:translateX(-50%) translateY(0); }
        }
        #freq-progress {
          animation: friendReqProgress ${AUTO_DISMISS_MS}ms linear forwards;
        }
        @keyframes friendReqProgress {
          from { width:100%; }
          to   { width:0%; }
        }
        #freq-accept-btn:not([disabled]):hover { filter:brightness(1.15); transform:translateY(-1px); }
        #freq-reject-btn:not([disabled]):hover { filter:brightness(1.15); transform:translateY(-1px); }
      </style>
      <div style="
        position:fixed;top:16px;left:50%;transform:translateX(-50%);
        z-index:99999;
        background:linear-gradient(135deg,rgba(18,14,6,0.98),rgba(10,8,3,0.98));
        border:1px solid rgba(212,175,55,0.45);
        border-radius:16px;
        padding:3px 10px 6px 3px;
        display:flex;align-items:center;gap:12px;
        box-shadow:0 8px 40px rgba(0,0,0,0.85),0 0 24px rgba(212,175,55,0.08);
        min-width:320px;max-width:90vw;
        animation:friendReqSlideIn 0.3s ease;
        overflow:hidden;
      ">
        <div style="flex-shrink:0;">${avatarHtml}</div>

        <div style="flex:1;min-width:0;">
          <div style="font-size:15px;font-weight:800;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
            ${notif.fromDisplayName}
          </div>
          <div style="font-size:13px;color:rgba(255,255,255,0.55);margin-top:2px;">ви кани за приятел</div>
          ${errorText !== null ? `<div style="font-size:12px;color:#ef4444;margin-top:4px;">${errorText}</div>` : ''}
        </div>

        <div style="display:flex;flex-direction:row;align-items:center;gap:8px;flex-shrink:0;">
          <button id="freq-accept-btn" type="button" ${btnDisabled} style="
            padding:7px 14px;border:none;
            background:linear-gradient(135deg,#14532d,#22c55e);
            border-radius:8px;color:#fff;font-size:13px;font-weight:800;cursor:${btnCursor};
            white-space:nowrap;
            opacity:${btnOpacity};
            transition:filter 0.15s,transform 0.15s;
            box-shadow:0 2px 8px rgba(34,197,94,0.3);
          ">Приеми</button>
          <button id="freq-reject-btn" type="button" ${btnDisabled} style="
            padding:7px 14px;border:none;
            background:linear-gradient(135deg,#7f1d1d,#ef4444);
            border-radius:8px;color:#fff;font-size:13px;font-weight:800;cursor:${btnCursor};
            white-space:nowrap;
            opacity:${btnOpacity};
            transition:filter 0.15s,transform 0.15s;
            box-shadow:0 2px 8px rgba(239,68,68,0.3);
          ">Откажи</button>
        </div>

        <div style="
          position:absolute;bottom:0;left:0;height:3px;
          background:linear-gradient(90deg,#b8960c,#d4af37,#f0c040);
          border-radius:0 0 0 16px;
        " id="freq-progress"></div>
      </div>
    `

    options.container.querySelector('#freq-reject-btn')?.addEventListener('click', () => {
      if (isProcessing) return
      const friendshipId = notif.friendshipId
      isProcessing = true
      errorText = null
      render()
      void options.onReject(friendshipId).then((result) => {
        if (!result.ok) {
          isProcessing = false
          errorText = result.message
          render()
          return
        }
        isProcessing = false
        fadeOutAndClear(() => {
          current = null
          errorText = null
          render()
        })
      }).catch(() => {
        isProcessing = false
        errorText = 'Грешка при обработка. Опитай отново.'
        render()
      })
    })

    options.container.querySelector('#freq-accept-btn')?.addEventListener('click', () => {
      if (isProcessing) return
      const friendshipId = notif.friendshipId
      const displayName = notif.fromDisplayName
      isProcessing = true
      errorText = null
      render()
      void options.onAccept(friendshipId).then((result) => {
        if (!result.ok) {
          isProcessing = false
          errorText = result.message
          render()
          return
        }
        isProcessing = false
        clearDismissTimer()
        current = null
        errorText = null
        confirmationName = displayName
        render()
        playSound()
        clearConfirmationTimer()
        confirmationTimer = setTimeout(dismissConfirmation, CONFIRMATION_DISMISS_MS)
      }).catch(() => {
        isProcessing = false
        errorText = 'Грешка при обработка. Опитай отново.'
        render()
      })
    })
  }

  function showRequest(notification: FriendRequestNotif): void {
    clearDismissTimer()
    clearConfirmationTimer()
    confirmationName = null
    isProcessing = false
    errorText = null
    current = notification
    render()
    playSound()
    dismissTimer = setTimeout(dismissByTimer, AUTO_DISMISS_MS)
  }

  function showAccepted(notification: AcceptedNotif): void {
    clearDismissTimer()
    current = null
    isProcessing = false
    errorText = null
    confirmationName = notification.fromDisplayName
    render()
    playSound()
    clearConfirmationTimer()
    confirmationTimer = setTimeout(dismissConfirmation, CONFIRMATION_DISMISS_MS)
  }

  function destroy(): void {
    clearDismissTimer()
    clearConfirmationTimer()
    options.container.innerHTML = ''
  }

  return { showRequest, showAccepted, destroy }
}
