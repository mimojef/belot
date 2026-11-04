import { applyRouteSeo } from '../seo/applyRouteSeo'
import { isPhoneLayoutViewport } from '../../ui/layout/viewportStage'
import { VIOLET_3D_BUTTON_CLASS } from '../../ui/layout/violet3dButton'
import { MOBILE_LIGHT_PAGE_BACKGROUND } from '../../ui/layout/mobileLightPageBackground'

// ─── Types ────────────────────────────────────────────────────────────────────

export type ResetPasswordScreenState =
  | { phase: 'no-token' }
  | { phase: 'form'; token: string; errorText: string | null; submitting: boolean }
  | { phase: 'success' }

export type ResetPasswordScreenCallbacks = {
  onGoToLogin: () => void
  onSubmit: (token: string, newPassword: string) => void
}

// ─── Token extraction ─────────────────────────────────────────────────────────

export function extractAndClearResetToken(): string | null {
  const hash = window.location.hash
  if (!hash || hash.length < 2) return null

  // URLSearchParams на fragment съдържанието (без водещия #).
  const params = new URLSearchParams(hash.slice(1))
  const token = params.get('token')

  // Веднага изчистваме fragment-а — token не трябва да стои в address bar.
  history.replaceState(null, '', window.location.pathname)

  return token && token.length > 0 ? token : null
}

// ─── Escape ───────────────────────────────────────────────────────────────────

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// ─── Render helpers ───────────────────────────────────────────────────────────

// Тъмната палитра (desktop/таблет) — непроменена. Светлата — телефон, в
// стила на новото мобилно лоби; избира се при всеки render (isPhoneLayoutViewport).
const DARK_THEME = {
  pageBg: '#0a0a0a',
  title: '#f8fafc',
  text: 'rgba(255,255,255,0.72)',
  input: 'width:100%;box-sizing:border-box;height:42px;border-radius:8px;border:1px solid rgba(212,165,32,0.34);background:#050505;color:#ffffff;padding:0 12px;font-size:15px;font-weight:700;outline:none;',
  label: 'display:grid;gap:6px;font-size:12px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#d4a520;',
  // Класът на основния бутон: тъмната тема — без; светлата — общия 3D стил.
  primaryClass: '',
  primary: 'width:100%;height:46px;border:0;border-radius:8px;background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;font-size:15px;font-weight:900;cursor:pointer;margin-top:4px;',
  secondary: 'width:100%;height:34px;border:0;background:transparent;color:rgba(255,255,255,0.72);font-size:13px;font-weight:800;cursor:pointer;',
  disabled: 'width:100%;height:46px;border:0;border-radius:8px;background:rgba(100,80,0,0.4);color:rgba(255,255,255,0.4);font-size:15px;font-weight:900;cursor:not-allowed;margin-top:4px;',
  error: 'border-radius:8px;border:1px solid rgba(248,113,113,0.28);background:rgba(127,29,29,0.42);padding:10px 12px;color:#fecaca;font-size:13px;font-weight:800;text-align:center;',
}

const LIGHT_THEME: typeof DARK_THEME = {
  pageBg: MOBILE_LIGHT_PAGE_BACKGROUND,
  title: '#17233C',
  text: '#667085',
  label: 'display:grid;gap:6px;font-size:13px;font-weight:700;color:#344054;',
  input: 'width:100%;box-sizing:border-box;height:46px;border-radius:8px;border:1px solid #D0D5DD;background:#FFFFFF;color:#17233C;padding:0 12px;font-size:16px;font-weight:500;outline:none;font-family:inherit;',
  primaryClass: `class="lobby-violet-btn ${VIOLET_3D_BUTTON_CLASS}"`,
  primary: 'width:100%;height:46px;border:0;border-radius:8px;color:#FFFFFF;font-family:inherit;font-size:15px;font-weight:800;cursor:pointer;margin-top:4px;',
  disabled: 'width:100%;height:46px;border:0;border-radius:8px;background:#E4E7EC;color:#98A2B3;font-family:inherit;font-size:15px;font-weight:800;cursor:not-allowed;margin-top:4px;',
  secondary: 'width:100%;height:40px;border:0;background:transparent;color:#475467;font-family:inherit;font-size:14px;font-weight:700;cursor:pointer;',
  error: 'border-radius:8px;border:1px solid #FECDCA;background:#FEF3F2;padding:10px 12px;color:#B42318;font-size:13px;font-weight:700;text-align:center;',
}

let T = DARK_THEME

function buildNoTokenHtml(): string {
  return `
    <div style="text-align:center;display:grid;gap:16px;">
      <div style="font-size:25px;line-height:1.1;font-weight:900;color:${T.title};">Забравена парола</div>
      <div style="font-size:14px;line-height:1.55;color:${T.text};">
        Линкът е невалиден или липсва. Отворете отново линка от имейла.
      </div>
      <button type="button" data-reset-go-to-login="1" ${T.primaryClass} style="${T.primary}">Към вход</button>
    </div>
  `
}

function buildFormHtml(state: Extract<ResetPasswordScreenState, { phase: 'form' }>): string {
  const submitBtnStyle = state.submitting ? T.disabled : T.primary
  const errorBlock = state.errorText
    ? `<div data-reset-error="1" style="${T.error}">${escapeHtml(state.errorText)}</div>`
    : `<div data-reset-error="1" style="display:none;${T.error}"></div>`

  return `
    <form data-reset-form="1" style="display:grid;gap:12px;" novalidate>
      <div style="font-size:25px;line-height:1.1;font-weight:900;color:${T.title};text-align:center;">Смяна на парола</div>
      <label style="${T.label}">
        Нова парола
        <input name="newPassword" type="password" autocomplete="new-password" minlength="6" maxlength="256"
          style="${T.input}" ${state.submitting ? 'disabled' : ''}>
      </label>
      <label style="${T.label}">
        Повторете новата парола
        <input name="confirmPassword" type="password" autocomplete="new-password" minlength="6" maxlength="256"
          style="${T.input}" ${state.submitting ? 'disabled' : ''}>
      </label>
      ${errorBlock}
      <button type="submit" data-reset-submit="1" ${state.submitting ? '' : T.primaryClass} style="${submitBtnStyle}" ${state.submitting ? 'disabled' : ''}>
        ${state.submitting ? 'Изпращане...' : 'Смени паролата'}
      </button>
      <button type="button" data-reset-go-to-login="1" style="${T.secondary}">Назад към вход</button>
    </form>
  `
}

function buildSuccessHtml(): string {
  return `
    <div style="text-align:center;display:grid;gap:16px;">
      <div style="font-size:25px;line-height:1.1;font-weight:900;color:${T.title};">Паролата е сменена</div>
      <div style="font-size:14px;line-height:1.55;color:${T.text};">
        Паролата е сменена успешно. Можете да влезете с новата парола.
      </div>
      <button type="button" data-reset-go-to-login="1" ${T.primaryClass} style="${T.primary}">Влез в профила</button>
    </div>
  `
}

// ─── Main render + wire-up ────────────────────────────────────────────────────

export function renderResetPasswordScreen(
  root: HTMLElement,
  state: ResetPasswordScreenState,
  callbacks: ResetPasswordScreenCallbacks,
): void {
  applyRouteSeo('/reset-password')
  const isPhone = isPhoneLayoutViewport()
  T = isPhone ? LIGHT_THEME : DARK_THEME

  const body =
    state.phase === 'no-token'
      ? buildNoTokenHtml()
      : state.phase === 'success'
        ? buildSuccessHtml()
        : buildFormHtml(state)

  root.innerHTML = isPhone ? `
    <div data-standalone-light="1" style="
      position:fixed;inset:0;
      background:${T.pageBg};color:${T.title};
      display:flex;flex-direction:column;align-items:center;
      padding:24px 16px;box-sizing:border-box;overflow-y:auto;
      font-family:system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;
    ">
      <div style="margin:auto 0;width:100%;max-width:440px;display:flex;flex-direction:column;align-items:center;gap:20px;">
        <img src="/assets/lobby-mobile/logo-pika-text.webp" alt="Pika.bg" width="144" height="48" style="width:144px;height:48px;display:block;object-fit:contain;">
        <div style="
          width:100%;box-sizing:border-box;
          border-radius:12px;border:1px solid #E4E7EC;background:#FFFFFF;
          box-shadow:0 12px 32px rgba(23,35,60,0.10);
          padding:24px 18px;
        ">
          ${body}
        </div>
      </div>
    </div>
  ` : `
    <div style="
      position:fixed;inset:0;
      background:#0a0a0a;
      display:flex;align-items:center;justify-content:center;
      padding:24px;
      font-family:system-ui,-apple-system,sans-serif;
    ">
      <div style="
        width:min(92vw,440px);
        border-radius:8px;
        border:2px solid rgba(212,165,32,0.72);
        background:linear-gradient(180deg,rgba(32,32,32,0.98) 0%,rgba(8,8,8,0.99) 100%);
        box-shadow:0 34px 80px rgba(0,0,0,0.48);
        padding:28px 24px;
      ">
        ${body}
      </div>
    </div>
  `

  // Wire up "Към вход" / "Назад към вход" / "Влез в профила"
  root.querySelectorAll<HTMLButtonElement>('[data-reset-go-to-login="1"]').forEach((btn) => {
    btn.addEventListener('click', callbacks.onGoToLogin)
  })

  // Wire up form submit
  const form = root.querySelector<HTMLFormElement>('[data-reset-form="1"]')
  if (form && state.phase === 'form') {
    const { token } = state
    form.addEventListener('submit', (e) => {
      e.preventDefault()
      const data = new FormData(form)
      const newPassword = String(data.get('newPassword') ?? '')
      const confirmPassword = String(data.get('confirmPassword') ?? '')

      if (newPassword !== confirmPassword) {
        const errEl = form.querySelector<HTMLElement>('[data-reset-error="1"]')
        if (errEl) {
          errEl.textContent = 'Двете пароли не съвпадат.'
          errEl.style.display = ''
        }
        return
      }

      callbacks.onSubmit(token, newPassword)
    })
  }
}
