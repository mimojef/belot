import { escapeHtml } from './renderLobbyScreen.js'

export type GuestTrialPopupState = {
  isOpen: boolean
  gamesUsed: number
  remaining: number
  maxGames: number
  errorText: string | null
  isSubmitting: boolean
  // true само след server-confirmed /api/guest/trial-status отговор. Докато е false,
  // popup-ът показва loading state вместо потенциално stale/default remaining стойност
  // (предотвратява "Имате 3 пробни игри" flash за guest, който вече е изчерпал лимита си).
  hasConfirmedStatus: boolean
}

export type GuestTrialPopupOptions = {
  onPlayClick: () => void
  onRegisterClick: () => void
  onLoginClick: () => void
  onClose: () => void
}

const CTA_BODY_TEXT = 'За по-силно изживяване създай профил, вземи 100 000 жълтици, сприятелявай се с други играчи, играй с приятели, печели игри и трупай жълтици.'

function buildHeadingText(remaining: number): string {
  if (remaining <= 0) {
    return 'Изиграхте своите пробни игри като гост.'
  }

  const gameWord = remaining === 1 ? 'пробна игра' : 'пробни игри'

  return `Имате ${remaining} ${gameWord} като гост с виртуални играчи.`
}

function renderCtaBodyHtml(): string {
  const [beforeAmount, afterAmount] = CTA_BODY_TEXT.split('100 000')

  return `${escapeHtml(beforeAmount)}<span style="color:#d4a520;font-weight:900;">100 000</span>${escapeHtml(afterAmount)}`
}

function renderLoadingModalShell(bodyHtml: string): string {
  return `
    <div data-guest-trial-modal-root="1" style="position:fixed;inset:0;z-index:13000;display:flex;align-items:center;justify-content:center;padding:24px;">
      <div data-guest-trial-modal-backdrop="1" style="position:absolute;inset:0;background:rgba(0,0,0,0.45);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);"></div>
      <div role="dialog" aria-modal="true" style="position:relative;width:min(92vw,480px);border-radius:8px;border:2px solid rgba(212,165,32,0.72);background:linear-gradient(180deg,rgba(32,32,32,0.98) 0%,rgba(8,8,8,0.99) 100%);box-shadow:0 34px 80px rgba(0,0,0,0.48);padding:24px;">
        <button type="button" data-guest-trial-modal-close="1" aria-label="Затвори" style="position:absolute;right:4px;top:4px;width:36px;height:36px;border:0;border-radius:999px;background:rgba(255,255,255,0.08);color:#ffffff;font-size:22px;font-weight:900;cursor:pointer;">×</button>
        <div style="display:grid;gap:14px;">
          <div style="display:grid;gap:16px;text-align:center;">
            ${bodyHtml}
          </div>
        </div>
      </div>
    </div>
  `
}

export function renderGuestTrialPopup(state: GuestTrialPopupState): string {
  if (!state.isOpen) {
    return ''
  }

  // Докато нямаме server-confirmed status, не рендерираме heading/бутони на база
  // потенциално stale/default state.remaining — показваме кратък loading state вместо това.
  if (!state.hasConfirmedStatus) {
    return renderLoadingModalShell(
      `<div style="font-size:17px;line-height:1.4;font-weight:800;color:rgba(255,255,255,0.85);padding:12px 0;">Проверяваме пробните игри…</div>`,
    )
  }

  const heading = buildHeadingText(state.remaining)
  const limitReached = state.remaining <= 0

  const bodyParagraphs = `<div style="font-size:15px;line-height:1.5;color:rgba(255,255,255,0.72);font-weight:700;">${renderCtaBodyHtml()}</div>`

  const actions = limitReached
    ? `
      <div style="display:flex;justify-content:center;gap:12px;flex-wrap:wrap;margin-top:6px;">
        <button type="button" data-guest-trial-register-button="1" style="height:46px;min-width:150px;border:0;border-radius:8px;background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;font-size:15px;font-weight:900;cursor:pointer;">Създай профил</button>
        <button type="button" data-guest-trial-login-button="1" style="height:46px;min-width:130px;border:1px solid rgba(212,165,32,0.62);border-radius:8px;background:#080808;color:#f8fafc;font-size:15px;font-weight:900;cursor:pointer;">Вход</button>
      </div>
    `
    : `
      <div style="display:flex;justify-content:center;gap:12px;flex-wrap:wrap;margin-top:6px;">
        <button type="button" data-guest-trial-play-button="1" ${state.isSubmitting ? 'disabled' : ''} style="height:46px;min-width:150px;border:0;border-radius:8px;background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;font-size:15px;font-weight:900;cursor:${state.isSubmitting ? 'default' : 'pointer'};opacity:${state.isSubmitting ? '0.7' : '1'};">${state.isSubmitting ? 'Зареждане…' : 'Играй'}</button>
      </div>
    `

  return `
    <div data-guest-trial-modal-root="1" style="position:fixed;inset:0;z-index:13000;display:flex;align-items:center;justify-content:center;padding:24px;">
      <div data-guest-trial-modal-backdrop="1" style="position:absolute;inset:0;background:rgba(0,0,0,0.45);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);"></div>
      <div role="dialog" aria-modal="true" style="position:relative;width:min(92vw,480px);border-radius:8px;border:2px solid rgba(212,165,32,0.72);background:linear-gradient(180deg,rgba(32,32,32,0.98) 0%,rgba(8,8,8,0.99) 100%);box-shadow:0 34px 80px rgba(0,0,0,0.48);padding:24px;">
        <button type="button" data-guest-trial-modal-close="1" aria-label="Затвори" style="position:absolute;right:4px;top:4px;width:36px;height:36px;border:0;border-radius:999px;background:rgba(255,255,255,0.08);color:#ffffff;font-size:22px;font-weight:900;cursor:pointer;">×</button>
        <div style="display:grid;gap:14px;">
          <div style="display:grid;gap:16px;text-align:center;">
            <div style="font-size:24px;line-height:1.2;font-weight:900;color:#f8fafc;">${escapeHtml(heading)}</div>
            ${bodyParagraphs}
            ${actions}
          </div>
          <div data-guest-trial-error="1" style="border-radius:8px;border:1px solid rgba(248,113,113,0.28);background:rgba(127,29,29,0.42);padding:10px 12px;color:#fecaca;font-size:13px;font-weight:800;text-align:center;${state.errorText ? '' : 'display:none;'}">${state.errorText ? escapeHtml(state.errorText) : ''}</div>
        </div>
      </div>
    </div>
  `
}

export function attachGuestTrialPopupEventListeners(
  root: ParentNode,
  options: GuestTrialPopupOptions,
): void {
  root.querySelector('[data-guest-trial-modal-backdrop="1"]')?.addEventListener('click', () => {
    options.onClose()
  })
  root.querySelector('[data-guest-trial-modal-close="1"]')?.addEventListener('click', () => {
    options.onClose()
  })
  root.querySelector('[data-guest-trial-play-button="1"]')?.addEventListener('click', () => {
    options.onPlayClick()
  })
  root.querySelector('[data-guest-trial-register-button="1"]')?.addEventListener('click', () => {
    options.onRegisterClick()
  })
  root.querySelector('[data-guest-trial-login-button="1"]')?.addEventListener('click', () => {
    options.onLoginClick()
  })
}
