type LikeNotification = {
  fromProfileId: string
  fromDisplayName: string
  fromAvatarUrl: string | null
}

type NotificationController = {
  show: (notification: LikeNotification) => void
  destroy: () => void
}

const AUTO_DISMISS_MS = 12_000
const CONFIRMATION_DISMISS_MS = 4_000

// Телефон (тесен екран или нисък хоризонтален тъч екран): картата заема
// ширината на екрана, „Харесай“ минава под текста, а X остава до името.
// Desktop изгледът не се променя.
const PHONE_MEDIA_QUERY = '(max-width: 640px), (hover: none) and (pointer: coarse) and (max-height: 500px)'
const PHONE_CARD_WIDTH_CSS = `
  @media ${PHONE_MEDIA_QUERY} {
    .like-notif-card { width:calc(100vw - 24px) !important; min-width:0 !important; max-width:420px !important; }
  }
`

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

export function createProfileLikeNotification(options: {
  container: HTMLElement
  onLike: (profileId: string) => Promise<void>
}): NotificationController {
  let current: LikeNotification | null = null
  let confirmationName: string | null = null
  let dismissTimer: ReturnType<typeof setTimeout> | null = null
  let confirmationTimer: ReturnType<typeof setTimeout> | null = null

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

  function dismiss(): void {
    clearDismissTimer()
    fadeOutAndClear(() => {
      current = null
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
        <style>${PHONE_CARD_WIDTH_CSS}</style>
        <div class="like-notif-card" style="
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
          <div style="font-size:28px;line-height:1;color:#e53e3e;flex-shrink:0;">♥</div>
          <div style="flex:1;min-width:0;font-size:15px;font-weight:700;color:#fff;overflow-wrap:anywhere;">
            Вие харесахте профила на <span style="color:#d4af37;">${escapeHtml(name)}</span>
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
      ? `<img src="${escapeHtml(notif.fromAvatarUrl)}" style="width:80px;height:80px;object-fit:cover;border-radius:10px;display:block;border:2px solid rgba(212,175,55,0.4);">`
      : `<div style="width:80px;height:80px;border-radius:10px;background:rgba(212,175,55,0.12);border:2px solid rgba(212,175,55,0.3);display:flex;align-items:center;justify-content:center;font-size:32px;flex-shrink:0;">👤</div>`

    options.container.innerHTML = `
      <style>
        @keyframes likeNotifSlideIn {
          from { opacity:0; transform:translateX(-50%) translateY(-20px); }
          to   { opacity:1; transform:translateX(-50%) translateY(0); }
        }
        #like-notif-progress {
          animation: likeNotifProgress ${AUTO_DISMISS_MS}ms linear forwards;
        }
        @keyframes likeNotifProgress {
          from { width:100%; }
          to   { width:0%; }
        }
        #like-notif-like-btn:hover { filter:brightness(1.15); transform:translateY(-1px); }
        #like-notif-close-btn:hover { filter:brightness(1.3); color:rgba(255,255,255,0.9) !important; }
        ${PHONE_CARD_WIDTH_CSS}
        @media ${PHONE_MEDIA_QUERY} {
          .like-notif-card--notice { display:grid !important; grid-template-columns:80px minmax(0,1fr) auto; align-content:center; row-gap:8px; }
          .like-notif-card--notice > .like-notif-avatar { grid-row:1 / span 2; align-self:start; }
          .like-notif-card--notice > .like-notif-text { grid-column:2; grid-row:1; padding-top:4px; }
          .like-notif-card--notice > .like-notif-actions { display:contents !important; }
          .like-notif-card--notice #like-notif-close-btn { grid-column:3; grid-row:1; align-self:start; margin-top:4px; }
          .like-notif-card--notice #like-notif-like-btn { grid-column:2 / span 2; grid-row:2; margin-bottom:3px; }
        }
      </style>
      <div class="like-notif-card like-notif-card--notice" style="
        position:fixed;top:16px;left:50%;transform:translateX(-50%);
        z-index:99999;
        background:linear-gradient(135deg,rgba(18,14,6,0.98),rgba(10,8,3,0.98));
        border:1px solid rgba(212,175,55,0.45);
        border-radius:16px;
        padding:3px 10px 6px 3px;
        display:flex;align-items:center;gap:12px;
        box-shadow:0 8px 40px rgba(0,0,0,0.85),0 0 24px rgba(212,175,55,0.08);
        min-width:320px;max-width:90vw;
        animation:likeNotifSlideIn 0.3s ease;
        overflow:hidden;
      ">
        <div class="like-notif-avatar" style="flex-shrink:0;">${avatarHtml}</div>

        <div class="like-notif-text" style="flex:1;min-width:0;">
          <div style="font-size:15px;font-weight:800;color:#fff;line-height:1.25;overflow-wrap:anywhere;">
            ${escapeHtml(notif.fromDisplayName)}
          </div>
          <div style="font-size:13px;color:rgba(255,255,255,0.55);margin-top:2px;">хареса твоя профил</div>
        </div>

        <div class="like-notif-actions" style="display:flex;flex-direction:row;align-items:center;gap:8px;flex-shrink:0;">
          <button id="like-notif-like-btn" type="button" style="
            padding:7px 14px;border:none;
            background:linear-gradient(135deg,#b8960c,#d4af37,#f0c040);
            border-radius:8px;color:#1a1200;font-size:13px;font-weight:800;cursor:pointer;
            white-space:nowrap;
            transition:filter 0.15s,transform 0.15s;
            box-shadow:0 2px 8px rgba(212,175,55,0.3);
          "><span style="color:#e53e3e;font-size:16px;">♥</span> Харесай</button>
          <button id="like-notif-close-btn" type="button" style="
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
        " id="like-notif-progress"></div>
      </div>
    `

    options.container.querySelector('#like-notif-close-btn')?.addEventListener('click', dismiss)

    options.container.querySelector('#like-notif-like-btn')?.addEventListener('click', () => {
      const profileId = notif.fromProfileId
      const displayName = notif.fromDisplayName
      dismiss()
      void options.onLike(profileId).then(() => {
        confirmationName = displayName
        render()
        playSound()
        clearConfirmationTimer()
        confirmationTimer = setTimeout(dismissConfirmation, CONFIRMATION_DISMISS_MS)
      }).catch(() => {
        // ignore — rate limit or network error
      })
    })
  }

  function playSound(): void {
    const audio = new Audio('/audio/Notifications/notification-2.mp3')
    audio.volume = 0.6
    void audio.play().catch(() => {/* autoplay policy */})
  }

  function show(notification: LikeNotification): void {
    current = notification
    clearDismissTimer()
    render()
    playSound()
    dismissTimer = setTimeout(dismiss, AUTO_DISMISS_MS)
  }

  function destroy(): void {
    clearDismissTimer()
    clearConfirmationTimer()
    options.container.innerHTML = ''
  }

  return { show, destroy }
}
