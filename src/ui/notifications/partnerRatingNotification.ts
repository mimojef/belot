type PartnerRatingNotification = {
  raterDisplayName: string
  ratingValue: number
}

type PartnerRatingNotificationController = {
  show: (notification: PartnerRatingNotification) => void
  destroy: () => void
}

const AUTO_DISMISS_MS = 6_000

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

export function createPartnerRatingNotification(options: {
  container: HTMLElement
}): PartnerRatingNotificationController {
  let dismissTimer: ReturnType<typeof setTimeout> | null = null

  function clearDismissTimer(): void {
    if (dismissTimer !== null) {
      clearTimeout(dismissTimer)
      dismissTimer = null
    }
  }

  function dismiss(): void {
    clearDismissTimer()
    options.container.innerHTML = ''
  }

  function playSound(): void {
    const audio = new Audio('/audio/ui/player-seat-fill.mp3')
    audio.volume = 0.6
    void audio.play().catch(() => {/* autoplay policy */})
  }

  function show(notification: PartnerRatingNotification): void {
    dismiss()

    options.container.innerHTML = `
      <style>
        @keyframes partnerRatingNotifSlideIn {
          from { opacity:0; transform:translateY(-10px); }
          to { opacity:1; transform:translateY(0); }
        }
        #partner-rating-notif-close:hover {
          filter:brightness(1.25);
          color:#ffffff !important;
        }
      </style>
      <div
        style="
          position:fixed;
          top:86px;
          right:24px;
          z-index:99999;
          width:min(360px, calc(100vw - 32px));
          border:1px solid rgba(251,191,36,0.72);
          border-radius:12px;
          background:linear-gradient(135deg, rgba(10,10,10,0.98), rgba(24,18,8,0.98));
          box-shadow:0 18px 48px rgba(0,0,0,0.55), 0 0 20px rgba(251,191,36,0.18);
          padding:14px 42px 14px 16px;
          color:#f8fafc;
          font-family:Inter, system-ui, sans-serif;
          font-size:14px;
          font-weight:800;
          line-height:1.35;
          animation:partnerRatingNotifSlideIn 0.22s ease;
        "
      >
        <button
          id="partner-rating-notif-close"
          type="button"
          aria-label="Затвори"
          style="
            position:absolute;
            top:8px;
            right:8px;
            width:26px;
            height:26px;
            border:1px solid rgba(251,191,36,0.38);
            border-radius:999px;
            background:rgba(0,0,0,0.52);
            color:#facc15;
            font-size:14px;
            font-weight:900;
            cursor:pointer;
          "
        >X</button>
        <span style="color:#facc15;">${escapeHtml(notification.raterDisplayName)}</span>
        оцени твоята игра с
        <span style="color:#facc15;">${notification.ratingValue}</span>.
      </div>
    `

    options.container.querySelector('#partner-rating-notif-close')?.addEventListener('click', dismiss)
    playSound()
    dismissTimer = setTimeout(dismiss, AUTO_DISMISS_MS)
  }

  function destroy(): void {
    dismiss()
  }

  return { show, destroy }
}
