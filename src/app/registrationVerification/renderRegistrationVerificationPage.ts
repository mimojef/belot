// Dedicated /verify-registration page (§"EMAIL → DIRECT REGISTRATION
// VERIFICATION PAGE") — mirror на renderResetPasswordScreen.ts's pattern:
// self-contained, full-screen overlay, own local phase-based state machine,
// driven by direct fetch() calls to the server, NO dependency on
// state.registrationVerification (the old in-tab popup's in-memory state) —
// точно целта на задачата: "затворен стар tab -> email app -> click link ->
// нов browser tab -> page възстановява необходимия pending verification
// context ОТ SERVER-SIDE data", not from a tab that no longer exists.
//
// §"PREFERRED TOKEN DESIGN"/§"URL FORMAT" — само encrypted opaque
// verificationToken (НИКОГА raw pendingRegistrationId) пътува в URL-а, и то
// във FRAGMENT-а (#token=...), НЕ query string — mirror на
// renderResetPasswordScreen.ts's extractAndClearResetToken() pattern.
// Token-ът decrypt-ва се само server-side; клиентът никога не научава raw
// pendingRegistrationId — само server-resolved данни (maskedEmail/
// expiresAt/status), подадени обратно през response body-та.
import { applyRouteSeo } from '../seo/applyRouteSeo'

// ─── Token extraction ─────────────────────────────────────────────────────────

export function extractAndClearVerificationToken(): string | null {
  const hash = window.location.hash
  if (!hash || hash.length < 2) return null

  // URLSearchParams на fragment съдържанието (без водещия #).
  const params = new URLSearchParams(hash.slice(1))
  const token = params.get('token')

  // Веднага изчистваме fragment-а — token не трябва да стои в address bar
  // (виж caller-а в main.ts — това се вика на най-ранната възможна точка,
  // ПРЕДИ mountConsentUi()/initializeAnalytics()).
  history.replaceState(null, '', window.location.pathname)

  return token && token.length > 0 ? token : null
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type RegistrationVerificationPageState =
  | { phase: 'invalid' }
  | { phase: 'loading' }
  | {
      phase: 'form'
      maskedEmail: string
      expiresAt: string
      resendAvailableAtMs: number
      nowMs: number
      code: string
      rememberMe: boolean
      errorText: string | null
      submitting: boolean
      resending: boolean
    }
  | {
      phase: 'displayName'
      maskedEmail: string
      expiresAt: string
      displayNameDraft: string
      errorText: string | null
      submitting: boolean
      /** Съхранено, за да се върнем в 'form' с непроменен code/rememberMe контекст при "Назад". */
      code: string
      rememberMe: boolean
      resendAvailableAtMs: number
    }
  | { phase: 'expired' }
  /**
   * §10 "MISSING ROW BEFORE EXPIRY" — валиден (authenticated, non-expired)
   * token, НО pending редът вече липсва в DB-то. Може да значи "вече
   * потвърдена" ИЛИ "cancelled" (cancel-pending-registration) — не можем
   * надеждно да различим без нова DB persistence (tombstone), затова
   * умишлено НЕУТРАЛНО копие, НЕ категорично "вече потвърдена".
   */
  | { phase: 'inactive' }
  | {
      phase: 'success'
      /** true ако follow-up /api/auth/me потвърди, че session cookie-то реално се "хвана" в ТОЗИ browser — виж caller-а (main.ts) за пълния rationale. false -> покажи "Вход" бутон вместо auto-redirect. Това НЕ е device distinction — само session-establishment fallback (§11). */
      autoLoginConfirmed: boolean
      maskedEmail: string | null
    }

export type RegistrationVerificationPageCallbacks = {
  onCodeChange: (code: string) => void
  onRememberMeChange: (checked: boolean) => void
  onSubmitCode: (code: string) => void
  onResend: () => void
  onGoToLogin: (prefillEmail: string | null) => void
  onGoToRegister: () => void
  onDisplayNameDraftChange: (displayName: string) => void
  onSubmitDisplayName: (displayName: string) => void
  onCancelDisplayNameChange: () => void
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
  'width:100%;box-sizing:border-box;height:52px;border-radius:8px;border:1px solid rgba(212,165,32,0.34);background:#050505;color:#ffffff;padding:0 12px;font-size:28px;font-weight:900;letter-spacing:10px;text-align:center;outline:none;'

const TEXT_INPUT_STYLE =
  'width:100%;box-sizing:border-box;height:42px;border-radius:8px;border:1px solid rgba(212,165,32,0.34);background:#050505;color:#ffffff;padding:0 12px;font-size:15px;font-weight:700;outline:none;'

const PRIMARY_BTN_STYLE =
  'width:100%;height:46px;border:0;border-radius:8px;background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;font-size:15px;font-weight:900;cursor:pointer;margin-top:4px;'

const DISABLED_BTN_STYLE =
  'width:100%;height:46px;border:0;border-radius:8px;background:rgba(100,80,0,0.4);color:rgba(255,255,255,0.4);font-size:15px;font-weight:900;cursor:not-allowed;margin-top:4px;'

const SECONDARY_BTN_STYLE =
  'width:100%;height:34px;border:0;background:transparent;color:rgba(255,255,255,0.72);font-size:13px;font-weight:800;cursor:pointer;'

function formatSecondsRemaining(resendAvailableAtMs: number, nowMs: number): number {
  return Math.max(0, Math.ceil((resendAvailableAtMs - nowMs) / 1000))
}

function formatExpiresAtLabel(expiresAt: string): string {
  const date = new Date(expiresAt)
  if (Number.isNaN(date.getTime())) return expiresAt
  return new Intl.DateTimeFormat('bg-BG', {
    timeZone: 'Europe/Sofia',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function buildLoadingHtml(): string {
  return `
    <div style="text-align:center;display:grid;gap:16px;">
      <div style="font-size:25px;line-height:1.1;font-weight:900;color:#f8fafc;">Зареждане...</div>
    </div>
  `
}

function buildInvalidHtml(): string {
  return `
    <div style="text-align:center;display:grid;gap:16px;">
      <div style="font-size:25px;line-height:1.1;font-weight:900;color:#f8fafc;">Невалиден линк</div>
      <div style="font-size:14px;line-height:1.55;color:rgba(255,255,255,0.72);">
        Този линк за потвърждение не е валиден.
      </div>
      <button type="button" data-verify-page-go-to-login="1" style="${PRIMARY_BTN_STYLE}">Към вход</button>
      <button type="button" data-verify-page-go-to-register="1" style="${SECONDARY_BTN_STYLE}">Нова регистрация</button>
    </div>
  `
}

function buildExpiredHtml(): string {
  return `
    <div style="text-align:center;display:grid;gap:16px;">
      <div style="font-size:40px;">⏳</div>
      <div style="font-size:22px;line-height:1.25;font-weight:900;color:#f8fafc;">
        Времето за потвърждение на регистрацията е изтекло
      </div>
      <div style="font-size:14px;line-height:1.55;color:rgba(255,255,255,0.72);">
        Регистрацията не е била потвърдена в рамките на 24 часа и вече не е активна.<br><br>
        Можете да създадете нова регистрация.<br><br>
        <strong style="color:#f8fafc;">Важно:</strong> можете да използвате същия имейл адрес, който сте използвали преди. След изтичането на регистрацията той вече е освободен и може да бъде използван отново.
      </div>
      <button type="button" data-verify-page-go-to-register="1" style="${PRIMARY_BTN_STYLE}">Създай нова регистрация</button>
    </div>
  `
}

function buildInactiveHtml(): string {
  // §10 — умишлено неутрално копие, НЕ категорично "вече потвърдена" (виж
  // 'inactive' phase doc коментара по-горе за пълния rationale).
  return `
    <div style="text-align:center;display:grid;gap:16px;">
      <div style="font-size:22px;line-height:1.25;font-weight:900;color:#f8fafc;">
        Тази заявка за регистрация вече не е активна.
      </div>
      <div style="font-size:14px;line-height:1.55;color:rgba(255,255,255,0.72);">
        Ако вече сте потвърдили регистрацията си, можете да влезете в профила си.
      </div>
      <button type="button" data-verify-page-go-to-login="1" style="${PRIMARY_BTN_STYLE}">Вход</button>
      <button type="button" data-verify-page-go-to-register="1" style="${SECONDARY_BTN_STYLE}">Нова регистрация</button>
    </div>
  `
}

function buildFormHtml(state: Extract<RegistrationVerificationPageState, { phase: 'form' }>): string {
  const secondsRemaining = formatSecondsRemaining(state.resendAvailableAtMs, state.nowMs)
  const resendDisabled = state.resending || secondsRemaining > 0
  const resendLabel = state.resending
    ? 'Изпращане...'
    : secondsRemaining > 0
    ? `Изпрати отново (${secondsRemaining}с)`
    : 'Изпрати отново'

  const errorBlock = state.errorText
    ? `<div data-verify-page-error="1" style="border-radius:8px;border:1px solid rgba(248,113,113,0.28);background:rgba(127,29,29,0.42);padding:10px 12px;color:#fecaca;font-size:13px;font-weight:800;text-align:center;">${escapeHtml(state.errorText)}</div>`
    : `<div data-verify-page-error="1" style="display:none;border-radius:8px;border:1px solid rgba(248,113,113,0.28);background:rgba(127,29,29,0.42);padding:10px 12px;color:#fecaca;font-size:13px;font-weight:800;text-align:center;"></div>`

  return `
    <form data-verify-page-form="1" style="display:grid;gap:14px;" novalidate>
      <div style="font-size:22px;line-height:1.25;font-weight:900;color:#f8fafc;text-align:center;">
        Потвърдете регистрацията си
      </div>
      <div style="font-size:14px;line-height:1.55;color:rgba(255,255,255,0.72);font-weight:600;text-align:center;">
        Въведете кода, който изпратихме на вашия имейл.
      </div>
      <div style="text-align:center;font-size:14px;font-weight:800;color:#d4a520;">
        ${escapeHtml(state.maskedEmail)}
      </div>
      <label style="display:grid;gap:6px;font-size:12px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#d4a520;text-align:center;">
        Код за потвърждение
        <input
          name="code"
          data-verify-page-code-input="1"
          type="text"
          inputmode="numeric"
          pattern="[0-9]*"
          autocomplete="one-time-code"
          maxlength="6"
          value="${escapeHtml(state.code)}"
          style="${SHARED_INPUT_STYLE}"
          ${state.submitting ? 'disabled' : ''}
        >
      </label>
      <div style="text-align:center;font-size:12px;font-weight:600;color:rgba(255,255,255,0.5);margin-top:-6px;">
        Кодът е валиден до ${escapeHtml(formatExpiresAtLabel(state.expiresAt))}.
      </div>
      <label style="display:flex;align-items:center;gap:8px;font-size:13px;font-weight:700;color:rgba(255,255,255,0.78);cursor:pointer;justify-content:center;">
        <input type="checkbox" name="rememberMe" data-verify-page-remember-me="1" ${state.rememberMe ? 'checked' : ''} style="width:16px;height:16px;cursor:pointer;">
        Запомни ме на това устройство
      </label>
      ${errorBlock}
      <button type="submit" data-verify-page-submit="1" style="${state.submitting ? DISABLED_BTN_STYLE : PRIMARY_BTN_STYLE}" ${state.submitting ? 'disabled' : ''}>
        ${state.submitting ? 'Проверка...' : 'Потвърди'}
      </button>
      <div style="display:flex;justify-content:center;gap:16px;flex-wrap:wrap;">
        <button type="button" data-verify-page-resend="1" ${resendDisabled ? 'disabled' : ''} style="border:0;background:transparent;color:${resendDisabled ? 'rgba(255,255,255,0.4)' : 'rgba(212,165,32,0.85)'};font-size:13px;font-weight:800;cursor:${resendDisabled ? 'default' : 'pointer'};text-decoration:${resendDisabled ? 'none' : 'underline'};text-underline-offset:2px;">
          Не получихте код? ${escapeHtml(resendLabel)}
        </button>
      </div>
    </form>
  `
}

function buildDisplayNameHtml(state: Extract<RegistrationVerificationPageState, { phase: 'displayName' }>): string {
  const errorBlock = state.errorText
    ? `<div data-verify-page-error="1" style="border-radius:8px;border:1px solid rgba(248,113,113,0.28);background:rgba(127,29,29,0.42);padding:10px 12px;color:#fecaca;font-size:13px;font-weight:800;text-align:center;">${escapeHtml(state.errorText)}</div>`
    : `<div data-verify-page-error="1" style="display:none;border-radius:8px;border:1px solid rgba(248,113,113,0.28);background:rgba(127,29,29,0.42);padding:10px 12px;color:#fecaca;font-size:13px;font-weight:800;text-align:center;"></div>`

  return `
    <form data-verify-page-display-name-form="1" style="display:grid;gap:14px;" novalidate>
      <div style="font-size:22px;line-height:1.25;font-weight:900;color:#f8fafc;text-align:center;">
        Изберете друго име
      </div>
      <div style="font-size:14px;line-height:1.55;color:rgba(255,255,255,0.72);font-weight:600;text-align:center;">
        Избраното от вас потребителско име вече е заето.<br>
        Изберете друго — имейлът, паролата и кодът за потвърждение остават непроменени.
      </div>
      <label style="display:grid;gap:6px;font-size:12px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#d4a520;">
        Ново потребителско име
        <input
          name="displayName"
          data-verify-page-display-name-input="1"
          type="text"
          autocomplete="nickname"
          value="${escapeHtml(state.displayNameDraft)}"
          style="${TEXT_INPUT_STYLE}"
          ${state.submitting ? 'disabled' : ''}
        >
        <span style="font-size:11px;font-weight:400;letter-spacing:0;text-transform:none;color:#ffffff;">Мин. 3 символа. Букви на кирилица или латиница, цифри и по един интервал между думите.</span>
      </label>
      ${errorBlock}
      <button type="submit" data-verify-page-display-name-submit="1" style="${state.submitting ? DISABLED_BTN_STYLE : PRIMARY_BTN_STYLE}" ${state.submitting ? 'disabled' : ''}>
        ${state.submitting ? 'Запазване...' : 'Запази и продължи'}
      </button>
      <button type="button" data-verify-page-display-name-cancel="1" style="${SECONDARY_BTN_STYLE}">
        Назад към кода за потвърждение
      </button>
    </form>
  `
}

function buildSuccessHtml(state: Extract<RegistrationVerificationPageState, { phase: 'success' }>): string {
  const loginButton = state.autoLoginConfirmed
    ? ''
    : `<button type="button" data-verify-page-go-to-login="1" style="${PRIMARY_BTN_STYLE}">Вход</button>`
  const message = state.autoLoginConfirmed
    ? 'Регистрацията е активирана успешно. Влизате в профила си...'
    : 'Регистрацията е активирана успешно.<br>Можете да влезете в профила си.'

  return `
    <div style="text-align:center;display:grid;gap:16px;">
      <div style="font-size:40px;">✅</div>
      <div style="font-size:22px;line-height:1.25;font-weight:900;color:#f8fafc;">
        ${message}
      </div>
      ${loginButton}
    </div>
  `
}

// ─── Main render + wire-up ────────────────────────────────────────────────────

export function renderRegistrationVerificationPage(
  root: HTMLElement,
  state: RegistrationVerificationPageState,
  callbacks: RegistrationVerificationPageCallbacks,
): void {
  applyRouteSeo('/verify-registration')

  const body =
    state.phase === 'loading'
      ? buildLoadingHtml()
      : state.phase === 'invalid'
        ? buildInvalidHtml()
        : state.phase === 'expired'
          ? buildExpiredHtml()
          : state.phase === 'inactive'
            ? buildInactiveHtml()
            : state.phase === 'success'
              ? buildSuccessHtml(state)
              : state.phase === 'displayName'
                ? buildDisplayNameHtml(state)
                : buildFormHtml(state)

  root.innerHTML = `
    <div style="
      position:fixed;inset:0;
      background:#0a0a0a;
      display:flex;align-items:center;justify-content:center;
      padding:24px;
      font-family:system-ui,-apple-system,sans-serif;
      overflow-y:auto;
    ">
      <div style="
        width:min(92vw,440px);
        border-radius:8px;
        border:2px solid rgba(212,165,32,0.72);
        background:linear-gradient(180deg,rgba(32,32,32,0.98) 0%,rgba(8,8,8,0.99) 100%);
        box-shadow:0 34px 80px rgba(0,0,0,0.48);
        padding:28px 24px;
        margin:auto;
      ">
        ${body}
      </div>
    </div>
  `

  root.querySelectorAll<HTMLButtonElement>('[data-verify-page-go-to-login="1"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const prefillEmail = state.phase === 'success' ? state.maskedEmail : null
      callbacks.onGoToLogin(prefillEmail)
    })
  })

  root.querySelectorAll<HTMLButtonElement>('[data-verify-page-go-to-register="1"]').forEach((btn) => {
    btn.addEventListener('click', callbacks.onGoToRegister)
  })

  if (state.phase === 'displayName') {
    const displayNameInput = root.querySelector<HTMLInputElement>('[data-verify-page-display-name-input="1"]')
    if (displayNameInput) {
      // Typing-stability — mirror на code input-а долу / popup-а pattern-а
      // (виж renderRegistrationVerificationPopup.ts displayNameDraft doc
      // коментара за пълния rationale).
      displayNameInput.focus()
      displayNameInput.setSelectionRange(displayNameInput.value.length, displayNameInput.value.length)
      displayNameInput.addEventListener('input', () => {
        callbacks.onDisplayNameDraftChange(displayNameInput.value)
      })
    }

    const displayNameForm = root.querySelector<HTMLFormElement>('[data-verify-page-display-name-form="1"]')
    displayNameForm?.addEventListener('submit', (event) => {
      event.preventDefault()
      const displayName = displayNameInput?.value.trim() ?? ''
      if (displayName.length === 0) return
      callbacks.onSubmitDisplayName(displayName)
    })

    root.querySelector('[data-verify-page-display-name-cancel="1"]')?.addEventListener('click', () => {
      callbacks.onCancelDisplayNameChange()
    })
    return
  }

  if (state.phase !== 'form') return

  const codeInput = root.querySelector<HTMLInputElement>('[data-verify-page-code-input="1"]')
  if (codeInput) {
    // Typing-stability — mirror на 67914e3/aaef05e pattern-а (виж
    // renderRegistrationVerificationPopup.ts's code/displayNameDraft doc
    // коментарите за пълния rationale): focus + caret at end на
    // baked-натата value, input event mirror-ва в state БЕЗ render() на
    // всеки keystroke.
    codeInput.focus()
    codeInput.setSelectionRange(codeInput.value.length, codeInput.value.length)
    codeInput.addEventListener('input', () => {
      const digitsOnly = codeInput.value.replace(/[^0-9]/g, '').slice(0, 6)
      if (digitsOnly !== codeInput.value) {
        codeInput.value = digitsOnly
      }
      callbacks.onCodeChange(codeInput.value)
    })
  }

  const rememberMeInput = root.querySelector<HTMLInputElement>('[data-verify-page-remember-me="1"]')
  rememberMeInput?.addEventListener('change', () => {
    callbacks.onRememberMeChange(rememberMeInput.checked)
  })

  const form = root.querySelector<HTMLFormElement>('[data-verify-page-form="1"]')
  form?.addEventListener('submit', (event) => {
    event.preventDefault()
    const code = codeInput?.value.trim() ?? ''
    if (code.length !== 6) return
    callbacks.onSubmitCode(code)
  })

  root.querySelector('[data-verify-page-resend="1"]')?.addEventListener('click', () => {
    callbacks.onResend()
  })
}
