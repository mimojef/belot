import { applyRouteSeo } from '../seo/applyRouteSeo'

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

const SHARED_INPUT_STYLE =
  'width:100%;box-sizing:border-box;height:42px;border-radius:8px;border:1px solid rgba(212,165,32,0.34);background:#050505;color:#ffffff;padding:0 12px;font-size:15px;font-weight:700;outline:none;'

const SHARED_LABEL_STYLE =
  'display:grid;gap:6px;font-size:12px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#d4a520;'

const PRIMARY_BTN_STYLE =
  'width:100%;height:46px;border:0;border-radius:8px;background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;font-size:15px;font-weight:900;cursor:pointer;margin-top:4px;'

const SECONDARY_BTN_STYLE =
  'width:100%;height:34px;border:0;background:transparent;color:rgba(255,255,255,0.72);font-size:13px;font-weight:800;cursor:pointer;'

const DISABLED_BTN_STYLE =
  'width:100%;height:46px;border:0;border-radius:8px;background:rgba(100,80,0,0.4);color:rgba(255,255,255,0.4);font-size:15px;font-weight:900;cursor:not-allowed;margin-top:4px;'

function buildNoTokenHtml(): string {
  return `
    <div style="text-align:center;display:grid;gap:16px;">
      <div style="font-size:25px;line-height:1.1;font-weight:900;color:#f8fafc;">Забравена парола</div>
      <div style="font-size:14px;line-height:1.55;color:rgba(255,255,255,0.72);">
        Линкът е невалиден или липсва. Отворете отново линка от имейла.
      </div>
      <button type="button" data-reset-go-to-login="1" style="${PRIMARY_BTN_STYLE}">Към вход</button>
    </div>
  `
}

function buildFormHtml(state: Extract<ResetPasswordScreenState, { phase: 'form' }>): string {
  const submitBtnStyle = state.submitting ? DISABLED_BTN_STYLE : PRIMARY_BTN_STYLE
  const errorBlock = state.errorText
    ? `<div data-reset-error="1" style="border-radius:8px;border:1px solid rgba(248,113,113,0.28);background:rgba(127,29,29,0.42);padding:10px 12px;color:#fecaca;font-size:13px;font-weight:800;text-align:center;">${escapeHtml(state.errorText)}</div>`
    : `<div data-reset-error="1" style="display:none;border-radius:8px;border:1px solid rgba(248,113,113,0.28);background:rgba(127,29,29,0.42);padding:10px 12px;color:#fecaca;font-size:13px;font-weight:800;text-align:center;"></div>`

  return `
    <form data-reset-form="1" style="display:grid;gap:12px;" novalidate>
      <div style="font-size:25px;line-height:1.1;font-weight:900;color:#f8fafc;text-align:center;">Смяна на парола</div>
      <label style="${SHARED_LABEL_STYLE}">
        Нова парола
        <input name="newPassword" type="password" autocomplete="new-password" minlength="6" maxlength="256"
          style="${SHARED_INPUT_STYLE}" ${state.submitting ? 'disabled' : ''}>
      </label>
      <label style="${SHARED_LABEL_STYLE}">
        Повторете новата парола
        <input name="confirmPassword" type="password" autocomplete="new-password" minlength="6" maxlength="256"
          style="${SHARED_INPUT_STYLE}" ${state.submitting ? 'disabled' : ''}>
      </label>
      ${errorBlock}
      <button type="submit" data-reset-submit="1" style="${submitBtnStyle}" ${state.submitting ? 'disabled' : ''}>
        ${state.submitting ? 'Изпращане...' : 'Смени паролата'}
      </button>
      <button type="button" data-reset-go-to-login="1" style="${SECONDARY_BTN_STYLE}">Назад към вход</button>
    </form>
  `
}

function buildSuccessHtml(): string {
  return `
    <div style="text-align:center;display:grid;gap:16px;">
      <div style="font-size:25px;line-height:1.1;font-weight:900;color:#f8fafc;">Паролата е сменена</div>
      <div style="font-size:14px;line-height:1.55;color:rgba(255,255,255,0.72);">
        Паролата е сменена успешно. Можете да влезете с новата парола.
      </div>
      <button type="button" data-reset-go-to-login="1" style="${PRIMARY_BTN_STYLE}">Влез в профила</button>
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

  const body =
    state.phase === 'no-token'
      ? buildNoTokenHtml()
      : state.phase === 'success'
        ? buildSuccessHtml()
        : buildFormHtml(state)

  root.innerHTML = `
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
