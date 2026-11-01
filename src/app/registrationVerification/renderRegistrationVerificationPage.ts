// Dedicated /verify-registration page (§"EMAIL → DIRECT REGISTRATION
// VERIFICATION PAGE") — mirror на renderResetPasswordScreen.ts's pattern:
// self-contained, full-screen overlay, own local phase-based state machine,
// driven by direct fetch() calls to the server, NO dependency on
// state.registrationVerification (the old in-tab popup's in-memory state) —
// точно целта на задачата: "затворен стар tab -> email app -> click link ->
// нов browser tab -> page възстановява необходимия pending verification
// context ОТ SERVER-SIDE data", not from a tab that no longer exists.
//
// §"PUBLIC LOCATOR" (revised design) — encrypted opaque verificationLocator
// (НИКОГА raw pendingRegistrationId) пътува в URL-а, като normal QUERY
// параметър (?verification=...), НЕ fragment — query е по-устойчив при email
// click-tracking redirect chains (Brevo и подобни услуги често не запазват
// #fragment през собствен redirect). Това вече е безопасно, защото
// locator-ът е ПУБЛИЧЕН identifier, не bearer capability — possession alone
// не верифицира/create-ва сесия/update-ва display name/resend-ва код (виж
// registrationVerificationLinkToken.ts doc коментара за пълния security
// model). Locator-ът decrypt-ва се само server-side; клиентът никога не
// научава raw pendingRegistrationId — само server-resolved данни
// (maskedEmail/expiresAt/status), подадени обратно през response body-та.
// Query-то се scrub-ва от address bar-а веднага (hygiene — виж
// extractAndClearVerificationLocator() doc коментара по-долу за защо
// security НЕ зависи от това).
import { applyRouteSeo } from '../seo/applyRouteSeo'
import { isPhoneLayoutViewport } from '../../ui/layout/viewportStage'

// ─── Locator extraction ─────────────────────────────────────────────────────────

/**
 * Hygiene-only scrub — locator-ът вече е ПУБЛИЧЕН (не capability), затова
 * оставането му видим в address bar-а/history за кратко НЕ е security риск
 * (за разлика от старото fragment-based token design). Изчистваме го все
 * пак веднага, за да не се trail-ва без нужда в browser history/screenshots.
 */
export function extractAndClearVerificationLocator(): string | null {
  const params = new URLSearchParams(window.location.search)
  const locator = params.get('verification')

  history.replaceState(null, '', window.location.pathname)

  return locator && locator.length > 0 ? locator : null
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
  /**
   * PUBLIC LOCATOR модел — locator alone вече НЕ е достатъчен за resend (би
   * rotate-нал кода без authorization proof). Преди реалния resend request,
   * искаме потвърждение на регистрационния имейл — server-ът сравнява
   * normalized submitted email срещу normalized email-а на pending реда.
   */
  | {
      phase: 'resendConfirmEmail'
      maskedEmail: string
      expiresAt: string
      emailDraft: string
      errorText: string | null
      submitting: boolean
      /** Съхранено, за да се върнем в 'form' с непроменен контекст при "Назад". */
      code: string
      rememberMe: boolean
      resendAvailableAtMs: number
    }
  | { phase: 'expired' }
  /**
   * "MISSING ROW BEFORE EXPIRY" — валиден (authenticated, non-expired)
   * locator, НО pending редът вече липсва в DB-то. Може да значи "вече
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
  /** "Изпрати нов код" клик — transitions към email-confirmation стъпката, НЕ resend-ва directno (locator alone не е достатъчен, виж 'resendConfirmEmail' phase doc коментара). */
  onResend: () => void
  onGoToLogin: (prefillEmail: string | null) => void
  onGoToRegister: () => void
  onDisplayNameDraftChange: (displayName: string) => void
  onSubmitDisplayName: (displayName: string) => void
  onCancelDisplayNameChange: () => void
  onResendEmailDraftChange: (email: string) => void
  onSubmitResendEmail: (email: string) => void
  onCancelResendConfirm: () => void
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
  title: '#f8fafc',
  text: 'rgba(255,255,255,0.72)',
  accent: '#d4a520',
  hint: 'rgba(255,255,255,0.5)',
  check: 'rgba(255,255,255,0.78)',
  helper: '#ffffff',
  codeInput: 'width:100%;box-sizing:border-box;height:52px;border-radius:8px;border:1px solid rgba(212,165,32,0.34);background:#050505;color:#ffffff;padding:0 12px;font-size:28px;font-weight:900;letter-spacing:10px;text-align:center;outline:none;',
  textInput: 'width:100%;box-sizing:border-box;height:42px;border-radius:8px;border:1px solid rgba(212,165,32,0.34);background:#050505;color:#ffffff;padding:0 12px;font-size:15px;font-weight:700;outline:none;',
  primary: 'width:100%;height:46px;border:0;border-radius:8px;background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;font-size:15px;font-weight:900;cursor:pointer;margin-top:4px;',
  disabled: 'width:100%;height:46px;border:0;border-radius:8px;background:rgba(100,80,0,0.4);color:rgba(255,255,255,0.4);font-size:15px;font-weight:900;cursor:not-allowed;margin-top:4px;',
  secondary: 'width:100%;height:34px;border:0;background:transparent;color:rgba(255,255,255,0.72);font-size:13px;font-weight:800;cursor:pointer;',
  error: 'border-radius:8px;border:1px solid rgba(248,113,113,0.28);background:rgba(127,29,29,0.42);padding:10px 12px;color:#fecaca;font-size:13px;font-weight:800;text-align:center;',
  resend: 'rgba(212,165,32,0.85)',
  resendDisabled: 'rgba(255,255,255,0.4)',
}

const LIGHT_THEME: typeof DARK_THEME = {
  title: '#17233C',
  text: '#667085',
  accent: '#7950E8',
  hint: '#98A2B3',
  check: '#344054',
  helper: '#667085',
  codeInput: "width:100%;box-sizing:border-box;height:56px;border-radius:8px;border:1px solid #D0D5DD;background:#FFFFFF;color:#17233C;padding:0 12px;font-family:inherit;font-size:28px;font-weight:800;letter-spacing:10px;text-align:center;outline:none;",
  textInput: 'width:100%;box-sizing:border-box;height:46px;border-radius:8px;border:1px solid #D0D5DD;background:#FFFFFF;color:#17233C;padding:0 12px;font-size:16px;font-weight:500;outline:none;font-family:inherit;',
  primary: 'width:100%;height:46px;border:0;border-radius:8px;background:linear-gradient(180deg,#8961F0 0%,#7950E8 55%,#6C43DD 100%);box-shadow:inset 0 1px 0 rgba(255,255,255,0.3),0 6px 14px rgba(121,80,232,0.28);color:#FFFFFF;font-family:inherit;font-size:15px;font-weight:800;cursor:pointer;margin-top:4px;',
  disabled: 'width:100%;height:46px;border:0;border-radius:8px;background:#E4E7EC;color:#98A2B3;font-family:inherit;font-size:15px;font-weight:800;cursor:not-allowed;margin-top:4px;',
  secondary: 'width:100%;height:40px;border:0;background:transparent;color:#475467;font-family:inherit;font-size:14px;font-weight:700;cursor:pointer;',
  error: 'border-radius:8px;border:1px solid #FECDCA;background:#FEF3F2;padding:10px 12px;color:#B42318;font-size:13px;font-weight:700;text-align:center;',
  resend: '#7950E8',
  resendDisabled: '#98A2B3',
}

let T = DARK_THEME

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
      <div style="font-size:25px;line-height:1.1;font-weight:900;color:${T.title};">Зареждане...</div>
    </div>
  `
}

function buildInvalidHtml(): string {
  return `
    <div style="text-align:center;display:grid;gap:16px;">
      <div style="font-size:25px;line-height:1.1;font-weight:900;color:${T.title};">Невалиден линк</div>
      <div style="font-size:14px;line-height:1.55;color:${T.text};">
        Този линк за потвърждение не е валиден.
      </div>
      <button type="button" data-verify-page-go-to-login="1" style="${T.primary}">Към вход</button>
      <button type="button" data-verify-page-go-to-register="1" style="${T.secondary}">Нова регистрация</button>
    </div>
  `
}

function buildExpiredHtml(): string {
  return `
    <div style="text-align:center;display:grid;gap:16px;">
      <div style="font-size:40px;">⏳</div>
      <div style="font-size:22px;line-height:1.25;font-weight:900;color:${T.title};">
        Времето за потвърждение на регистрацията е изтекло
      </div>
      <div style="font-size:14px;line-height:1.55;color:${T.text};">
        Регистрацията не е била потвърдена в рамките на 24 часа и вече не е активна.<br><br>
        Можете да създадете нова регистрация.<br><br>
        <strong style="color:${T.title};">Важно:</strong> можете да използвате същия имейл адрес, който сте използвали преди. След изтичането на регистрацията той вече е освободен и може да бъде използван отново.
      </div>
      <button type="button" data-verify-page-go-to-register="1" style="${T.primary}">Създай нова регистрация</button>
    </div>
  `
}

function buildInactiveHtml(): string {
  // §10 — умишлено неутрално копие, НЕ категорично "вече потвърдена" (виж
  // 'inactive' phase doc коментара по-горе за пълния rationale).
  return `
    <div style="text-align:center;display:grid;gap:16px;">
      <div style="font-size:22px;line-height:1.25;font-weight:900;color:${T.title};">
        Тази заявка за регистрация вече не е активна.
      </div>
      <div style="font-size:14px;line-height:1.55;color:${T.text};">
        Ако вече сте потвърдили регистрацията си, можете да влезете в профила си.
      </div>
      <button type="button" data-verify-page-go-to-login="1" style="${T.primary}">Вход</button>
      <button type="button" data-verify-page-go-to-register="1" style="${T.secondary}">Нова регистрация</button>
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
    ? `<div data-verify-page-error="1" style="${T.error}">${escapeHtml(state.errorText)}</div>`
    : `<div data-verify-page-error="1" style="display:none;${T.error}"></div>`

  return `
    <form data-verify-page-form="1" style="display:grid;gap:14px;" novalidate>
      <div style="font-size:22px;line-height:1.25;font-weight:900;color:${T.title};text-align:center;">
        Потвърдете регистрацията си
      </div>
      <div style="font-size:14px;line-height:1.55;color:${T.text};font-weight:600;text-align:center;">
        Въведете кода, който изпратихме на вашия имейл.
      </div>
      <div style="text-align:center;font-size:14px;font-weight:800;color:${T.accent};">
        ${escapeHtml(state.maskedEmail)}
      </div>
      <label style="display:grid;gap:6px;font-size:12px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:${T.accent};text-align:center;">
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
          style="${T.codeInput}"
          ${state.submitting ? 'disabled' : ''}
        >
      </label>
      <div style="text-align:center;font-size:12px;font-weight:600;color:${T.hint};margin-top:-6px;">
        Кодът е валиден до ${escapeHtml(formatExpiresAtLabel(state.expiresAt))}.
      </div>
      <label style="display:flex;align-items:center;gap:8px;font-size:13px;font-weight:700;color:${T.check};cursor:pointer;justify-content:center;">
        <input type="checkbox" name="rememberMe" data-verify-page-remember-me="1" ${state.rememberMe ? 'checked' : ''} style="width:16px;height:16px;cursor:pointer;accent-color:${T.accent};">
        Запомни ме на това устройство
      </label>
      ${errorBlock}
      <button type="submit" data-verify-page-submit="1" style="${state.submitting ? T.disabled : T.primary}" ${state.submitting ? 'disabled' : ''}>
        ${state.submitting ? 'Проверка...' : 'Потвърди'}
      </button>
      <div style="display:flex;justify-content:center;gap:16px;flex-wrap:wrap;">
        <button type="button" data-verify-page-resend="1" ${resendDisabled ? 'disabled' : ''} style="border:0;background:transparent;color:${resendDisabled ? T.resendDisabled : T.resend};font-size:13px;font-weight:800;cursor:${resendDisabled ? 'default' : 'pointer'};text-decoration:${resendDisabled ? 'none' : 'underline'};text-underline-offset:2px;">
          Не получихте код? ${escapeHtml(resendLabel)}
        </button>
      </div>
    </form>
  `
}

function buildDisplayNameHtml(state: Extract<RegistrationVerificationPageState, { phase: 'displayName' }>): string {
  const errorBlock = state.errorText
    ? `<div data-verify-page-error="1" style="${T.error}">${escapeHtml(state.errorText)}</div>`
    : `<div data-verify-page-error="1" style="display:none;${T.error}"></div>`

  return `
    <form data-verify-page-display-name-form="1" style="display:grid;gap:14px;" novalidate>
      <div style="font-size:22px;line-height:1.25;font-weight:900;color:${T.title};text-align:center;">
        Изберете друго име
      </div>
      <div style="font-size:14px;line-height:1.55;color:${T.text};font-weight:600;text-align:center;">
        Избраното от вас потребителско име вече е заето.<br>
        Изберете друго — имейлът, паролата и кодът за потвърждение остават непроменени.
      </div>
      <label style="display:grid;gap:6px;font-size:12px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:${T.accent};">
        Ново потребителско име
        <input
          name="displayName"
          data-verify-page-display-name-input="1"
          type="text"
          autocomplete="nickname"
          value="${escapeHtml(state.displayNameDraft)}"
          style="${T.textInput}"
          ${state.submitting ? 'disabled' : ''}
        >
        <span style="font-size:11px;font-weight:400;letter-spacing:0;text-transform:none;color:${T.helper};">Мин. 3 символа. Букви на кирилица или латиница, цифри и по един интервал между думите.</span>
      </label>
      ${errorBlock}
      <button type="submit" data-verify-page-display-name-submit="1" style="${state.submitting ? T.disabled : T.primary}" ${state.submitting ? 'disabled' : ''}>
        ${state.submitting ? 'Запазване...' : 'Запази и продължи'}
      </button>
      <button type="button" data-verify-page-display-name-cancel="1" style="${T.secondary}">
        Назад към кода за потвърждение
      </button>
    </form>
  `
}

function buildResendConfirmHtml(state: Extract<RegistrationVerificationPageState, { phase: 'resendConfirmEmail' }>): string {
  const errorBlock = state.errorText
    ? `<div data-verify-page-error="1" style="${T.error}">${escapeHtml(state.errorText)}</div>`
    : `<div data-verify-page-error="1" style="display:none;${T.error}"></div>`

  return `
    <form data-verify-page-resend-confirm-form="1" style="display:grid;gap:14px;" novalidate>
      <div style="font-size:22px;line-height:1.25;font-weight:900;color:${T.title};text-align:center;">
        Изпращане на нов код
      </div>
      <div style="font-size:14px;line-height:1.55;color:${T.text};font-weight:600;text-align:center;">
        За да изпратим нов код, потвърдете имейла, с който сте се регистрирали.
      </div>
      <label style="display:grid;gap:6px;font-size:12px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:${T.accent};">
        Имейл
        <input
          name="email"
          data-verify-page-resend-email-input="1"
          type="text"
          inputmode="email"
          autocomplete="email"
          value="${escapeHtml(state.emailDraft)}"
          style="${T.textInput}"
          ${state.submitting ? 'disabled' : ''}
        >
      </label>
      ${errorBlock}
      <button type="submit" data-verify-page-resend-confirm-submit="1" style="${state.submitting ? T.disabled : T.primary}" ${state.submitting ? 'disabled' : ''}>
        ${state.submitting ? 'Изпращане...' : 'Изпрати нов код'}
      </button>
      <button type="button" data-verify-page-resend-confirm-cancel="1" style="${T.secondary}">
        Назад към кода за потвърждение
      </button>
    </form>
  `
}

function buildSuccessHtml(state: Extract<RegistrationVerificationPageState, { phase: 'success' }>): string {
  const loginButton = state.autoLoginConfirmed
    ? ''
    : `<button type="button" data-verify-page-go-to-login="1" style="${T.primary}">Вход</button>`
  const message = state.autoLoginConfirmed
    ? 'Регистрацията е активирана успешно. Влизате в профила си...'
    : 'Регистрацията е активирана успешно.<br>Можете да влезете в профила си.'

  return `
    <div style="text-align:center;display:grid;gap:16px;">
      <div style="font-size:40px;">✅</div>
      <div style="font-size:22px;line-height:1.25;font-weight:900;color:${T.title};">
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
  const isPhone = isPhoneLayoutViewport()
  T = isPhone ? LIGHT_THEME : DARK_THEME

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
                : state.phase === 'resendConfirmEmail'
                  ? buildResendConfirmHtml(state)
                  : buildFormHtml(state)

  root.innerHTML = isPhone ? `
    <div data-standalone-light="1" style="
      position:fixed;inset:0;
      background:#F5F7FC;color:#17233C;
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

  if (state.phase === 'resendConfirmEmail') {
    const emailInput = root.querySelector<HTMLInputElement>('[data-verify-page-resend-email-input="1"]')
    if (emailInput) {
      emailInput.focus()
      emailInput.setSelectionRange(emailInput.value.length, emailInput.value.length)
      emailInput.addEventListener('input', () => {
        callbacks.onResendEmailDraftChange(emailInput.value)
      })
    }

    const resendConfirmForm = root.querySelector<HTMLFormElement>('[data-verify-page-resend-confirm-form="1"]')
    resendConfirmForm?.addEventListener('submit', (event) => {
      event.preventDefault()
      const email = emailInput?.value.trim() ?? ''
      if (email.length === 0) return
      callbacks.onSubmitResendEmail(email)
    })

    root.querySelector('[data-verify-page-resend-confirm-cancel="1"]')?.addEventListener('click', () => {
      callbacks.onCancelResendConfirm()
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
