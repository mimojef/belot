import { escapeHtml, GUEST_MOBILE_LOBBY_FONT_FAMILY } from './renderLobbyScreen.js'

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

// Сумата е бонусът при регистрация от админ настройките
// (signup_bonus_yellow_coins → /api/settings/public →
// state.signupBonusYellowCoins), не твърдо зададена стойност.
const CTA_BODY_BEFORE_AMOUNT = 'За по-силно изживяване създай профил, вземи '
const CTA_BODY_AFTER_AMOUNT = ' жълтици, сприятелявай се с други играчи, играй с приятели, печели игри и трупай жълтици.'

function formatSignupBonus(value: number): string {
  return new Intl.NumberFormat('bg-BG').format(value)
}

function buildHeadingText(remaining: number): string {
  if (remaining <= 0) {
    return 'Изиграхте своите пробни игри като гост.'
  }

  const gameWord = remaining === 1 ? 'пробна игра' : 'пробни игри'

  return `Имате ${remaining} ${gameWord} като гост с виртуални играчи.`
}

function renderCtaBodyHtml(signupBonus: number, amountColor = '#d4a520'): string {
  return `${escapeHtml(CTA_BODY_BEFORE_AMOUNT)}<span style="color:${amountColor};font-weight:900;">${escapeHtml(formatSignupBonus(signupBonus))}</span>${escapeHtml(CTA_BODY_AFTER_AMOUNT)}`
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

// Светлата версия — само в новото мобилно лоби за гости (същият стил като
// светлите auth/заключена маса popup-и). Същите текстове, състояния (loading,
// оставащи игри, изчерпан лимит, грешка) и data-* атрибути → същите действия.
function renderGuestTrialPopupLight(state: GuestTrialPopupState, signupBonus: number): string {
  const shell = (bodyHtml: string, errorHtml = '') => `
    <div data-guest-trial-modal-root="1" data-guest-trial-modal-light="1" style="position:fixed;inset:0;z-index:13000;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;font-family:${GUEST_MOBILE_LOBBY_FONT_FAMILY};">
      <div data-guest-trial-modal-backdrop="1" style="position:absolute;inset:0;background:rgba(20,20,43,0.45);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);"></div>
      <div role="dialog" aria-modal="true" style="position:relative;width:min(100%,400px);box-sizing:border-box;max-height:calc(100dvh - 32px);overflow-y:auto;overscroll-behavior:contain;border-radius:12px;border:1px solid #E4E7EC;background:#FFFFFF;box-shadow:0 20px 48px rgba(23,35,60,0.18);padding:28px 20px 20px;">
        <button type="button" data-guest-trial-modal-close="1" aria-label="Затвори" style="position:absolute;right:8px;top:8px;width:36px;height:36px;border:0;border-radius:8px;background:#F2F4F7;color:#475467;cursor:pointer;padding:0;display:flex;align-items:center;justify-content:center;"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true" style="display:block;"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>
        <div style="display:grid;gap:14px;text-align:center;">
          ${bodyHtml}
          ${errorHtml}
        </div>
      </div>
    </div>
  `

  if (!state.hasConfirmedStatus) {
    return shell(`<div style="font-size:17px;line-height:1.4;font-weight:800;color:#667085;padding:12px 0;">Проверяваме пробните игри…</div>`)
  }

  const limitReached = state.remaining <= 0
  const buttonBase = 'height:46px;min-width:0;border-radius:8px;font-family:inherit;font-size:15px;font-weight:900;'
  const actions = limitReached
    ? `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:6px;">
        <button type="button" class="lobby-violet-btn" data-guest-trial-register-button="1" style="${buttonBase}border:0;color:#FFFFFF;cursor:pointer;">Създай профил</button>
        <button type="button" data-guest-trial-login-button="1" style="${buttonBase}border:1px solid #D0D5DD;background:#FFFFFF;color:#17233C;cursor:pointer;">Вход</button>
      </div>
    `
    : `
      <div style="display:flex;justify-content:center;margin-top:6px;">
        <button type="button" class="lobby-violet-btn" data-guest-trial-play-button="1" ${state.isSubmitting ? 'disabled' : ''} style="${buttonBase}min-width:200px;padding:0 24px;border:0;color:#FFFFFF;cursor:${state.isSubmitting ? 'default' : 'pointer'};">${state.isSubmitting ? 'Зареждане…' : 'Играй'}</button>
      </div>
    `

  return shell(
    `
      <div style="font-size:22px;line-height:1.3;font-weight:900;color:#17233C;padding:0 22px;">${escapeHtml(buildHeadingText(state.remaining))}</div>
      <div style="font-size:15px;line-height:1.5;color:#667085;font-weight:600;">${renderCtaBodyHtml(signupBonus, '#7950E8')}</div>
      ${actions}
    `,
    `<div data-guest-trial-error="1" style="border-radius:8px;border:1px solid #FECDCA;background:#FEF3F2;padding:10px 12px;color:#B42318;font-size:13px;font-weight:700;text-align:center;${state.errorText ? '' : 'display:none;'}">${state.errorText ? escapeHtml(state.errorText) : ''}</div>`,
  )
}

export function renderGuestTrialPopup(state: GuestTrialPopupState, signupBonus: number, isGuestMobileLobby = false): string {
  if (!state.isOpen) {
    return ''
  }
  if (isGuestMobileLobby) {
    return renderGuestTrialPopupLight(state, signupBonus)
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

  const bodyParagraphs = `<div style="font-size:15px;line-height:1.5;color:rgba(255,255,255,0.72);font-weight:700;">${renderCtaBodyHtml(signupBonus)}</div>`

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
