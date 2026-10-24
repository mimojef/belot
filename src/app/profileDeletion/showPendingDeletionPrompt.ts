// Самоизтриване, Етап 4H — минимален ограничен екран за профил с активна
// заявка за изтриване (след вход с вярна парола, вкл. новата парола след
// "Забравена парола"). Сървърът НЕ издава сесия: връща само краткосрочен
// еднократен токен за отмяна и индивидуалния краен срок на заявката.
// Тук няма игри, чатове, теми или лични съобщения — само изричният избор:
//   "Запази профила ми"       -> POST /api/account/deletion-request/cancel
//   "Остави заявката активна" -> POST /api/account/deletion-request/keep
// Токенът живее само в паметта на този екран (не се записва и не се логва).
//
// Етап 4J1 — отмяната е двуфазна: сървърът я ПРИЕМА веднага (профилът вече
// няма да бъде изтрит), но окончателна е едва след записа в защитения
// регистър и offsite потвърждението. Докато чака, екранът показва междинно
// съобщение, а не окончателен успех.

export type PendingDeletionLoginResponse = {
  restoreAvailable?: boolean
  restoreToken?: string
  scheduledFor?: string
  gracePeriodDays?: number
  isBanned?: boolean
  /** Етап 4J1 — отмяната вече е приета и се потвърждава (без токен). */
  cancellationPending?: boolean
  cancellationMessage?: string
}

export type PendingDeletionActionResult =
  | { ok: true; state?: 'cancelled' | 'pending_confirmation'; message?: string | null }
  | { ok: false; code: string | null; message: string | null }

const CANCELLATION_PENDING_TEXT =
  'Отмяната е приета и профилът няма да бъде изтрит. Потвърждаваме я в защитения регистър — след няколко минути ще можете да влезете нормално.'

export type PendingDeletionPromptCallbacks = {
  cancelRequest: (restoreToken: string) => Promise<PendingDeletionActionResult>
  keepRequest: (restoreToken: string) => Promise<PendingDeletionActionResult>
  /** След успешно запазване — обичайният вход (нормален достъп или съобщение за бан). */
  onGoToLogin: () => void
}

const HOST_ID = 'pending-deletion-prompt'

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Крайният срок идва от сървъра (UTC ISO) — тук само се показва в часовата зона на България. */
export function formatPendingDeletionDeadline(scheduledForIso: string | undefined): string | null {
  if (typeof scheduledForIso !== 'string') return null
  const parsed = new Date(scheduledForIso)
  if (!Number.isFinite(parsed.getTime())) return null
  return parsed.toLocaleString('bg-BG', {
    timeZone: 'Europe/Sofia',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

const BUTTON_PRIMARY = 'width:100%;min-height:44px;border:0;border-radius:8px;background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;font-size:15px;font-weight:900;cursor:pointer;font-family:inherit;'
const BUTTON_SECONDARY = 'width:100%;min-height:44px;border:1px solid rgba(255,255,255,0.22);border-radius:8px;background:transparent;color:#f8fafc;font-size:14px;font-weight:800;cursor:pointer;font-family:inherit;'

export function showPendingDeletionPrompt(
  response: PendingDeletionLoginResponse,
  callbacks: PendingDeletionPromptCallbacks,
): void {
  document.getElementById(HOST_ID)?.remove()

  const host = document.createElement('div')
  host.id = HOST_ID
  host.style.cssText = 'position:fixed;inset:0;z-index:210000;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,0.82);font-family:Arial,Helvetica,sans-serif;'
  document.body.appendChild(host)

  const restoreToken = response.restoreAvailable === true && typeof response.restoreToken === 'string' ? response.restoreToken : null
  const deadlineText = formatPendingDeletionDeadline(response.scheduledFor)
  let busy = false

  const close = () => host.remove()

  const renderCard = (bodyHtml: string, actionsHtml: string) => {
    host.innerHTML = `
      <div role="dialog" aria-modal="true" aria-labelledby="pending-deletion-title" style="width:min(100%,440px);box-sizing:border-box;border-radius:8px;border:2px solid rgba(212,165,32,0.55);background:linear-gradient(180deg,rgba(32,32,32,0.98) 0%,rgba(8,8,8,0.99) 100%);box-shadow:0 34px 80px rgba(0,0,0,0.48);padding:24px;">
        <div id="pending-deletion-title" style="font-size:21px;font-weight:900;color:#f8fafc;margin-bottom:14px;">Профилът е подаден за изтриване</div>
        ${bodyHtml}
        <div data-pending-deletion-error="1" style="display:none;font-size:13px;line-height:1.5;color:#fca5a5;margin:0 0 12px;"></div>
        <div style="display:flex;flex-direction:column;gap:10px;">${actionsHtml}</div>
      </div>
    `
  }

  const showError = (text: string) => {
    const el = host.querySelector<HTMLElement>('[data-pending-deletion-error="1"]')
    if (el) { el.textContent = text; el.style.display = '' }
  }

  const paragraph = (text: string, color = 'rgba(226,232,240,0.88)') =>
    `<div style="font-size:15px;line-height:1.55;color:${color};margin-bottom:12px;">${escapeHtml(text)}</div>`

  const deadlineLine = deadlineText !== null
    ? `<div style="font-size:14px;line-height:1.5;color:rgba(226,232,240,0.78);margin-bottom:12px;">Окончателно изтриване: <strong style="color:#fde68a;">${escapeHtml(deadlineText)}</strong></div>`
    : ''
  const banLine = response.isBanned === true
    ? paragraph('Профилът има активен бан. Запазването на профила не премахва бана.', 'rgba(252,165,165,0.92)')
    : ''

  const renderFinal = (bodyHtml: string, withLogin: boolean) => {
    renderCard(bodyHtml, withLogin
      ? `<button type="button" data-pending-deletion-login="1" style="${BUTTON_PRIMARY}">Към вход</button>`
      : `<button type="button" data-pending-deletion-close="1" style="${BUTTON_PRIMARY}">Затвори</button>`)
    host.querySelector('[data-pending-deletion-login="1"]')?.addEventListener('click', () => { close(); callbacks.onGoToLogin() })
    host.querySelector('[data-pending-deletion-close="1"]')?.addEventListener('click', close)
  }

  if (response.cancellationPending === true) {
    renderFinal(
      `<div data-pending-deletion-cancellation-pending="1">${paragraph(response.cancellationMessage ?? CANCELLATION_PENDING_TEXT)}</div>`
        + (response.isBanned === true ? paragraph('Банът остава активен до изтичането или премахването му.', 'rgba(252,165,165,0.92)') : ''),
      false,
    )
    return
  }

  if (restoreToken === null) {
    // Срокът за отмяна е изтекъл или заявката вече се обработва.
    renderFinal(
      paragraph('Срокът за отмяна на заявката е изтекъл и профилът не може да бъде запазен.') + deadlineLine,
      false,
    )
    return
  }

  renderCard(
    paragraph('Достъпът до профила е спрян, докато заявката е активна. Можете да запазите профила си до крайния срок или да оставите заявката активна.')
      + deadlineLine
      + banLine,
    `
      <button type="button" data-pending-deletion-cancel="1" style="${BUTTON_PRIMARY}">Запази профила ми</button>
      <button type="button" data-pending-deletion-keep="1" style="${BUTTON_SECONDARY}">Остави заявката активна</button>
    `,
  )

  const setBusy = (value: boolean) => {
    busy = value
    host.querySelectorAll<HTMLButtonElement>('button').forEach((button) => { button.disabled = value })
  }

  host.querySelector('[data-pending-deletion-cancel="1"]')?.addEventListener('click', () => {
    if (busy) return
    setBusy(true)
    void callbacks.cancelRequest(restoreToken).then((result) => {
      if (result.ok && result.state === 'pending_confirmation') {
        // Приета, но още не окончателна — без "Към вход" (входът ще покаже същото).
        renderFinal(
          `<div data-pending-deletion-cancellation-pending="1">${paragraph(result.message ?? CANCELLATION_PENDING_TEXT)}</div>`
            + (response.isBanned === true ? paragraph('Банът остава активен до изтичането или премахването му.', 'rgba(252,165,165,0.92)') : ''),
          false,
        )
        return
      }
      if (result.ok) {
        renderFinal(
          paragraph('Заявката за изтриване е отменена и профилът е запазен. Влезте отново с паролата си.')
            + (response.isBanned === true ? paragraph('Банът остава активен до изтичането или премахването му.', 'rgba(252,165,165,0.92)') : ''),
          true,
        )
        return
      }
      if (result.code === 'DELETION_WINDOW_CLOSED') {
        renderFinal(paragraph(result.message ?? 'Срокът за отмяна на заявката за изтриване е изтекъл.') + deadlineLine, false)
        return
      }
      if (result.code === 'INVALID_RESTORE_TOKEN') {
        renderFinal(paragraph(result.message ?? 'Връзката за възстановяване е невалидна или изтекла. Влезте отново с имейла и паролата си.'), true)
        return
      }
      setBusy(false)
      showError(result.message ?? 'Няма връзка със сървъра. Опитайте отново.')
    })
  })

  host.querySelector('[data-pending-deletion-keep="1"]')?.addEventListener('click', () => {
    if (busy) return
    setBusy(true)
    // "Остави заявката активна" не променя заявката; токенът само се обезсилва.
    void callbacks.keepRequest(restoreToken).finally(() => {
      renderFinal(
        paragraph('Заявката остава активна.') + deadlineLine,
        false,
      )
    })
  })
}
