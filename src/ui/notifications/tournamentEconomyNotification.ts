import {
  createTournamentEconomyNotificationQueue,
  type TournamentEconomyNotice,
} from './tournamentEconomyNotificationQueue'

type NotificationController = {
  handleIncoming: (notice: TournamentEconomyNotice) => void
  destroy: () => void
}

const AUTO_DISMISS_MS = 8_000

function formatAmount(value: number): string {
  if (!Number.isFinite(value)) return '0'
  return new Intl.NumberFormat('bg-BG').format(Math.max(0, Math.round(value)))
}

type NoticeContent = {
  /** Текст ПРЕДИ сумата — точно както е зададен в task spec-а (§4). */
  prefix: string
  /** "−10 000 жълтици" или "+10 000 жълтици" — математически минус за debit. */
  amountText: string
  isPositive: boolean
  icon: string
  /** Второ изречение СЛЕД сумата (§ "КОГАТО ЕДИНИЯТ PARTNER СЕ ОТПИШЕ") —
   * опционално, само partner_left го ползва към момента. Останалите reason-и
   * остават с непроменения prefix+amount+"." формат. */
  suffix?: string
}

// Готовите текстове идват директно от task spec-а (§4), разделени на
// prefix + сума само за да оцветим сумата отделно — не се преформулират.
function buildNoticeContent(notice: TournamentEconomyNotice): NoticeContent {
  const formatted = formatAmount(notice.amount)
  switch (notice.reason) {
    case 'entry_fee_paid':
      return { prefix: 'Платихте входна такса за турнира: ', amountText: `−${formatted} жълтици`, isPositive: false, icon: '🎟️' }
    case 'participant_withdrawal':
      return { prefix: 'Отписахте се от турнира. Възстановени: ', amountText: `+${formatted} жълтици`, isPositive: true, icon: '↩️' }
    case 'creator_cancelled':
      return { prefix: 'Турнирът, в който участвахте, беше затворен. Възстановени: ', amountText: `+${formatted} жълтици`, isPositive: true, icon: '↩️' }
    case 'fill_expired':
      return { prefix: 'Турнирът не се запълни навреме. Възстановени: ', amountText: `+${formatted} жълтици`, isPositive: true, icon: '↩️' }
    case 'partner_left':
      return {
        prefix: 'Партньорът ти се отписа от отбора. Входът ти от ',
        amountText: `+${formatted} жълтици`,
        isPositive: true,
        icon: '↩️',
        suffix: ' е възстановен. Покани го отново или намери друг партньор.',
      }
  }
}

export function createTournamentEconomyNotification(options: {
  container: HTMLElement
}): NotificationController {
  const queue = createTournamentEconomyNotificationQueue()
  let current: TournamentEconomyNotice | null = null
  let dismissTimer: ReturnType<typeof setTimeout> | null = null

  function clearDismissTimer(): void {
    if (dismissTimer !== null) {
      clearTimeout(dismissTimer)
      dismissTimer = null
    }
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
      presentAndSchedule(decision.notice)
    }
  }

  function presentAndSchedule(notice: TournamentEconomyNotice): void {
    current = notice
    clearDismissTimer()
    render()
    dismissTimer = setTimeout(dismiss, AUTO_DISMISS_MS)
  }

  function render(): void {
    if (current === null) {
      options.container.innerHTML = ''
      return
    }

    const notice = current
    const { prefix, amountText, isPositive, icon, suffix } = buildNoticeContent(notice)
    const accentColor = isPositive ? '#4ade80' : '#f87171'
    const accentBorder = isPositive ? 'rgba(74,222,128,0.4)' : 'rgba(248,113,113,0.4)'
    const accentGlow = isPositive ? 'rgba(74,222,128,0.10)' : 'rgba(248,113,113,0.10)'

    options.container.innerHTML = `
      <style>
        @keyframes tournamentEconomyNotifSlideIn {
          from { opacity:0; transform:translateX(-50%) translateY(-20px); }
          to   { opacity:1; transform:translateX(-50%) translateY(0); }
        }
        #tournament-economy-notif-progress {
          animation: tournamentEconomyNotifProgress ${AUTO_DISMISS_MS}ms linear forwards;
        }
        @keyframes tournamentEconomyNotifProgress {
          from { width:100%; }
          to   { width:0%; }
        }
        #tournament-economy-notif-close-btn:hover { filter:brightness(1.3); }
        #tournament-economy-notif-close-btn:focus-visible {
          outline:2px solid #ffffff;
          outline-offset:2px;
        }
      </style>
      <div
        role="status"
        aria-live="polite"
        style="
          position:fixed;top:calc(12px + env(safe-area-inset-top, 0px));left:50%;transform:translateX(-50%);
          z-index:99999;
          box-sizing:border-box;
          max-width:min(420px, calc(100vw - 24px));
          background:linear-gradient(135deg,rgba(16,16,18,0.98),rgba(8,8,9,0.98));
          border:1px solid ${accentBorder};
          border-radius:14px;
          padding:11px 12px 13px 12px;
          display:flex;align-items:flex-start;gap:10px;
          box-shadow:0 8px 34px rgba(0,0,0,0.8),0 0 20px ${accentGlow};
          animation:tournamentEconomyNotifSlideIn 0.25s ease;
          overflow:hidden;
        "
      >
        <span aria-hidden="true" style="font-size:18px;line-height:1;flex-shrink:0;margin-top:1px;">${icon}</span>
        <div style="flex:1;min-width:0;font-size:13.5px;line-height:1.45;color:rgba(255,255,255,0.88);">
          ${prefix}<strong style="color:${accentColor};font-weight:900;">${amountText}</strong>${suffix ?? '.'}
        </div>
        <button id="tournament-economy-notif-close-btn" type="button" aria-label="Затвори известието" style="
          width:32px;height:32px;min-width:32px;border-radius:50%;border:1px solid rgba(255,255,255,0.15);
          background:rgba(255,255,255,0.07);color:#fff;
          font-size:14px;font-weight:700;line-height:1;cursor:pointer;
          display:flex;align-items:center;justify-content:center;
          padding:0;flex-shrink:0;margin-top:-1px;
          transition:filter 0.15s;
        ">✕</button>

        <div style="
          position:absolute;bottom:0;left:0;height:3px;
          background:${accentColor};
          border-radius:0 0 0 14px;
        " id="tournament-economy-notif-progress"></div>
      </div>
    `

    options.container.querySelector('#tournament-economy-notif-close-btn')?.addEventListener('click', dismiss)
  }

  function handleIncoming(notice: TournamentEconomyNotice): void {
    const decision = queue.handleIncoming(notice)
    if (decision.action === 'show') {
      presentAndSchedule(decision.notice)
    }
    // 'queue' и 'skip' не пипат UI — известието или чака на реда си, или е дубликат.
  }

  function destroy(): void {
    clearDismissTimer()
    options.container.innerHTML = ''
  }

  return { handleIncoming, destroy }
}
