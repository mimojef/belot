import type { TournamentPartnerInviteSnapshot } from '../../app/network/createGameServerClient.js'

type TournamentPartnerInvitePopupController = {
  enqueue: (invite: TournamentPartnerInviteSnapshot) => void
  remove: (inviteId: string) => void
  clear: () => void
  destroy: () => void
}

type ActionResult =
  | { ok: true; tournamentId: string }
  | { ok: false; message: string }

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function formatAmount(amount: number | undefined): string {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return '0'
  return new Intl.NumberFormat('bg-BG').format(Math.max(0, Math.round(amount)))
}

function formatStart(invite: TournamentPartnerInviteSnapshot): string {
  if (invite.startMode === 'scheduled' && invite.scheduledStartAt) {
    return new Intl.DateTimeFormat('bg-BG', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(invite.scheduledStartAt))
  }
  return 'при запълване'
}

function formatRemaining(expiresAt: string): string {
  const remainingMs = new Date(expiresAt).getTime() - Date.now()
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return '00:00'
  const totalSeconds = Math.ceil(remainingMs / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

export function createTournamentPartnerInvitePopup(options: {
  container: HTMLElement
  onDismiss: (inviteId: string) => Promise<ActionResult>
  onView: (inviteId: string) => Promise<ActionResult>
  onExpiredRefresh: (inviteId: string) => Promise<boolean>
}): TournamentPartnerInvitePopupController {
  const queue = new Map<string, TournamentPartnerInviteSnapshot>()
  const expiredRefreshInFlight = new Set<string>()
  let currentInviteId: string | null = null
  let isProcessing = false
  let errorText: string | null = null
  let countdownTimer: ReturnType<typeof setInterval> | null = null

  function clearCountdownTimer(): void {
    if (countdownTimer !== null) {
      clearInterval(countdownTimer)
      countdownTimer = null
    }
  }

  function getOrderedInvites(): TournamentPartnerInviteSnapshot[] {
    return Array.from(queue.values())
      .filter((invite) => invite.status === 'pending' && invite.popupDismissedAt === null)
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
  }

  function selectCurrentInvite(): TournamentPartnerInviteSnapshot | null {
    if (currentInviteId !== null) {
      const current = queue.get(currentInviteId) ?? null
      if (current !== null && current.status === 'pending' && current.popupDismissedAt === null) {
        return current
      }
    }
    const next = getOrderedInvites()[0] ?? null
    currentInviteId = next?.inviteId ?? null
    return next
  }

  function playSound(): void {
    const audio = new Audio('/audio/Notifications/notification-1.mp3')
    audio.volume = 0.55
    void audio.play().catch(() => {/* autoplay policy */})
  }

  function removeLocal(inviteId: string): void {
    queue.delete(inviteId)
    expiredRefreshInFlight.delete(inviteId)
    if (currentInviteId === inviteId) {
      currentInviteId = null
      isProcessing = false
      errorText = null
    }
    render()
  }

  function refreshIfExpired(invite: TournamentPartnerInviteSnapshot): void {
    if (new Date(invite.expiresAt).getTime() > Date.now()) return
    if (expiredRefreshInFlight.has(invite.inviteId)) return
    expiredRefreshInFlight.add(invite.inviteId)
    void options.onExpiredRefresh(invite.inviteId)
      .then((stillPending) => {
        expiredRefreshInFlight.delete(invite.inviteId)
        if (!stillPending) {
          removeLocal(invite.inviteId)
          return
        }
        render()
      })
      .catch(() => {
        expiredRefreshInFlight.delete(invite.inviteId)
      })
  }

  function render(): void {
    const invite = selectCurrentInvite()
    clearCountdownTimer()

    if (invite === null) {
      options.container.innerHTML = ''
      return
    }

    refreshIfExpired(invite)
    countdownTimer = setInterval(() => {
      const active = selectCurrentInvite()
      if (active === null) {
        render()
        return
      }
      const countdown = options.container.querySelector<HTMLElement>('[data-tournament-partner-countdown]')
      if (countdown !== null) countdown.textContent = formatRemaining(active.expiresAt)
      refreshIfExpired(active)
    }, 1000)

    const avatarHtml = invite.inviter.avatarUrl
      ? `<img src="${escapeHtml(invite.inviter.avatarUrl)}" alt="" style="width:56px;height:56px;border-radius:8px;object-fit:cover;border:1px solid rgba(34,197,94,0.35);flex:0 0 auto;">`
      : `<div style="width:56px;height:56px;border-radius:8px;background:#17231d;border:1px solid rgba(34,197,94,0.30);display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:900;color:#86efac;flex:0 0 auto;">${escapeHtml(invite.inviter.displayName.slice(0, 1).toUpperCase() || '?')}</div>`
    const disabled = isProcessing ? 'disabled' : ''
    const cursor = isProcessing ? 'not-allowed' : 'pointer'

    options.container.innerHTML = `
      <style>
        @keyframes tournamentPartnerInviteIn {
          from { opacity:0; transform:translateY(-8px); }
          to { opacity:1; transform:translateY(0); }
        }
        #tpi-popup button:not([disabled]):hover { filter:brightness(1.08); }
        @media (max-width: 560px) {
          #tpi-popup {
            top:10px !important;
            right:10px !important;
            left:10px !important;
            width:auto !important;
          }
        }
      </style>
      <div id="tpi-popup" role="dialog" aria-live="polite" style="
        position:fixed;top:18px;right:18px;z-index:100000;
        width:min(420px, calc(100vw - 32px));
        box-sizing:border-box;border:1px solid rgba(34,197,94,0.42);
        border-radius:8px;background:#101611;color:#f8fafc;
        box-shadow:0 18px 54px rgba(0,0,0,0.55);
        padding:14px 14px 12px 14px;font-family:Inter,system-ui,sans-serif;
        animation:tournamentPartnerInviteIn 0.18s ease;
      ">
        <button type="button" data-tpi-dismiss="${escapeHtml(invite.inviteId)}" aria-label="Затвори" ${disabled} style="
          position:absolute;top:8px;right:8px;width:30px;height:30px;border:1px solid rgba(255,255,255,0.16);
          border-radius:8px;background:#182018;color:#d1fae5;font-size:16px;font-weight:900;cursor:${cursor};
        ">X</button>
        <div style="display:flex;gap:12px;align-items:flex-start;padding-right:34px;">
          ${avatarHtml}
          <div style="min-width:0;flex:1;">
            <div style="font-size:13px;font-weight:900;color:#86efac;margin-bottom:4px;">Покана за партньор</div>
            <div style="font-size:15px;font-weight:900;line-height:1.25;overflow-wrap:anywhere;">
              ${escapeHtml(invite.inviter.displayName)} те кани в ${escapeHtml(invite.tournamentName ?? 'турнир')}
            </div>
            <div style="margin-top:8px;font-size:12px;line-height:1.45;color:rgba(248,250,252,0.72);">
              Вход: <strong style="color:#facc15;">${formatAmount(invite.entryFee)} жълтици</strong>.
              Старт: ${escapeHtml(formatStart(invite))}.
              Остава: <strong data-tournament-partner-countdown style="color:#86efac;">${formatRemaining(invite.expiresAt)}</strong>.
            </div>
            <div style="margin-top:7px;font-size:12px;line-height:1.45;color:rgba(248,250,252,0.62);">
              Поканата остава в „Покани към теб“, докато я приемеш, откажеш или изтече.
            </div>
            ${errorText !== null ? `<div style="margin-top:8px;font-size:12px;color:#fecaca;font-weight:800;">${escapeHtml(errorText)}</div>` : ''}
          </div>
        </div>
        <div style="display:flex;justify-content:flex-end;margin-top:12px;">
          <button type="button" data-tpi-view="${escapeHtml(invite.inviteId)}" ${disabled} style="
            height:38px;padding:0 14px;border:0;border-radius:8px;background:#22c55e;
            color:#052e16;font-size:13px;font-weight:900;cursor:${cursor};
          ">Виж турнира</button>
        </div>
      </div>
    `

    options.container.querySelector('[data-tpi-dismiss]')?.addEventListener('click', () => {
      if (isProcessing) return
      isProcessing = true
      errorText = null
      render()
      void options.onDismiss(invite.inviteId).then((result) => {
        if (!result.ok) {
          isProcessing = false
          errorText = result.message
          render()
          return
        }
        removeLocal(invite.inviteId)
      }).catch(() => {
        isProcessing = false
        errorText = 'Няма връзка със сървъра.'
        render()
      })
    })

    options.container.querySelector('[data-tpi-view]')?.addEventListener('click', () => {
      if (isProcessing) return
      isProcessing = true
      errorText = null
      render()
      void options.onView(invite.inviteId).then((result) => {
        if (!result.ok) {
          isProcessing = false
          errorText = result.message
          render()
          return
        }
        removeLocal(invite.inviteId)
      }).catch(() => {
        isProcessing = false
        errorText = 'Няма връзка със сървъра.'
        render()
      })
    })
  }

  return {
    enqueue(invite) {
      if (invite.status !== 'pending' || invite.popupDismissedAt !== null) return
      const hadInvite = queue.has(invite.inviteId)
      queue.set(invite.inviteId, invite)
      render()
      if (!hadInvite) playSound()
    },
    remove: removeLocal,
    clear() {
      queue.clear()
      expiredRefreshInFlight.clear()
      currentInviteId = null
      isProcessing = false
      errorText = null
      render()
    },
    destroy() {
      clearCountdownTimer()
      options.container.innerHTML = ''
      queue.clear()
      expiredRefreshInFlight.clear()
    },
  }
}
