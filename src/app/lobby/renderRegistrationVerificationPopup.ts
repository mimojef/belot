import { escapeHtml } from './renderLobbyScreen.js'

export type RegistrationVerificationPopupState = {
  isOpen: boolean
  pendingRegistrationId: string
  maskedEmail: string
  /** ISO string — 24-часовият pending registration прозорец, НИКОГА удължаван от resend (виж authStore.ts's register() doc коментар). Само за UI информация тук, самото enforcement е server-side. */
  expiresAt: string
  /**
   * Локално ехо на code input-а, синхронизирано от input event-а (виж
   * attachRegistrationVerificationPopupEventListeners). Държим го в state и
   * го bind-ваме обратно в template-а (value="...") — защита срещу КОЙТО И
   * ДА Е full re-render на popup-а (не само countdown tick-а, виж
   * patchRegistrationVerificationCountdown по-долу): дори ако друг,
   * несвързан full render презапише root.innerHTML, вече въведените цифри
   * оцеляват, защото са baked в самия HTML string, не само в DOM-а.
   */
  code: string
  rememberMe: boolean
  errorText: string | null
  isSubmitting: boolean
  isResending: boolean
  /** epoch ms — кога resend бутонът отново става наличен (60s cooldown, production report-а "RESEND CODE"). */
  resendAvailableAtMs: number
  /** "Живо" clock tick (секунди), само за да render-не countdown текста — актуализира се от периодичен interval в контролера. */
  nowMs: number
  /**
   * Display-name-taken recovery (hardening pass §1) — 'displayName' режим
   * показва инлайн форма за избор на ново име, вместо dead-end грешка.
   * pendingRegistrationId/код/24-часов прозорец остават непроменени —
   * потребителят само сменя display_name-а и се връща към code режима.
   */
  mode: 'code' | 'displayName'
  isChangingDisplayName: boolean
  /**
   * Typing-stability fix (mirror на `code` doc коментара по-горе, СЪЩИЯТ
   * production bug клас като commit 67914e3 "fix: preserve verification code
   * during countdown" — само в display-name-change input-а вместо code
   * input-а). Локално ехо на display-name-change input-а, синхронизирано от
   * input event-а (виж attachRegistrationVerificationPopupEventListeners).
   * Bind-нато обратно в template-а (value="...") — защита срещу пълен
   * re-render на popup-а ПОКА потребителят пише: submitRegistrationVerificationDisplayNameChange()
   * вика render() при ВСЕКИ resubmit resultат (вкл. втори неуспешен опит,
   * докато mode остава 'displayName') — без този state mirror, freshly
   * пресъздаденият input изгубваше вече написаното.
   */
  displayNameDraft: string
}

export type RegistrationVerificationPopupOptions = {
  onSubmitCode: (code: string) => void
  onCodeChange: (code: string) => void
  onResend: () => void
  onChangeEmail: () => void
  onRememberMeChange: (checked: boolean) => void
  onClose: () => void
  onSubmitDisplayName: (displayName: string) => void
  onDisplayNameDraftChange: (displayName: string) => void
  onCancelDisplayNameChange: () => void
}

function formatSecondsRemaining(resendAvailableAtMs: number, nowMs: number): number {
  return Math.max(0, Math.ceil((resendAvailableAtMs - nowMs) / 1000))
}

function renderCodeForm(state: RegistrationVerificationPopupState): string {
  const secondsRemaining = formatSecondsRemaining(state.resendAvailableAtMs, state.nowMs)
  const resendDisabled = state.isResending || secondsRemaining > 0
  const resendLabel = state.isResending
    ? 'Изпращане...'
    : secondsRemaining > 0
    ? `Изпрати отново (${secondsRemaining}с)`
    : 'Изпрати отново'

  return `
    <form data-registration-verification-form="1" style="display:grid;gap:14px;">
      <div style="font-size:22px;line-height:1.25;font-weight:900;color:#f8fafc;text-align:center;">
        Потвърдете имейла си
      </div>
      <div style="font-size:14px;line-height:1.55;color:rgba(255,255,255,0.72);font-weight:600;text-align:center;">
        Изпратихме 6-цифрен код за потвърждение на посочения от вас имейл адрес.<br><br>
        Отворете имейла си, намерете съобщението от Pika.bg и въведете получения код в полето по-долу.<br><br>
        Ако не виждате писмото, проверете и папките Спам или Нежелана поща.
      </div>
      <div style="text-align:center;font-size:14px;font-weight:800;color:#d4a520;">
        ${escapeHtml(state.maskedEmail)}
      </div>
      <label style="display:grid;gap:6px;font-size:12px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#d4a520;text-align:center;">
        Код за потвърждение
        <input
          name="code"
          data-registration-verification-code-input="1"
          type="text"
          inputmode="numeric"
          pattern="[0-9]*"
          autocomplete="one-time-code"
          maxlength="6"
          value="${escapeHtml(state.code)}"
          style="width:100%;box-sizing:border-box;height:52px;border-radius:8px;border:1px solid rgba(212,165,32,0.34);background:#050505;color:#ffffff;padding:0 12px;font-size:28px;font-weight:900;letter-spacing:10px;text-align:center;outline:none;"
        >
      </label>
      <div style="text-align:center;font-size:12px;font-weight:600;color:rgba(255,255,255,0.5);margin-top:-6px;">
        Кодът е валиден 24 часа.
      </div>
      <label style="display:flex;align-items:center;gap:8px;font-size:13px;font-weight:700;color:rgba(255,255,255,0.78);cursor:pointer;justify-content:center;">
        <input type="checkbox" name="rememberMe" data-registration-verification-remember-me="1" ${state.rememberMe ? 'checked' : ''} style="width:16px;height:16px;cursor:pointer;">
        Запомни ме на това устройство
      </label>
      <button type="submit" data-registration-verification-submit="1" ${state.isSubmitting ? 'disabled' : ''} style="height:46px;border:0;border-radius:8px;background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;font-size:15px;font-weight:900;cursor:${state.isSubmitting ? 'default' : 'pointer'};opacity:${state.isSubmitting ? '0.7' : '1'};">
        ${state.isSubmitting ? 'Проверка...' : 'Потвърди'}
      </button>
      <div style="display:flex;justify-content:center;gap:16px;flex-wrap:wrap;">
        <button type="button" data-registration-verification-resend="1" ${resendDisabled ? 'disabled' : ''} style="border:0;background:transparent;color:${resendDisabled ? 'rgba(255,255,255,0.4)' : 'rgba(212,165,32,0.85)'};font-size:13px;font-weight:800;cursor:${resendDisabled ? 'default' : 'pointer'};text-decoration:${resendDisabled ? 'none' : 'underline'};text-underline-offset:2px;">
          Не получихте код? ${escapeHtml(resendLabel)}
        </button>
        <button type="button" data-registration-verification-change-email="1" style="border:0;background:transparent;color:rgba(255,255,255,0.72);font-size:13px;font-weight:800;cursor:pointer;text-decoration:underline;text-underline-offset:2px;">
          Смени имейла
        </button>
      </div>
      <div data-registration-verification-error="1" style="border-radius:8px;border:1px solid rgba(248,113,113,0.28);background:rgba(127,29,29,0.42);padding:10px 12px;color:#fecaca;font-size:13px;font-weight:800;text-align:center;${state.errorText ? '' : 'display:none;'}">${state.errorText ? escapeHtml(state.errorText) : ''}</div>
    </form>
  `
}

function renderDisplayNameForm(state: RegistrationVerificationPopupState): string {
  return `
    <form data-registration-verification-display-name-form="1" style="display:grid;gap:14px;">
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
          data-registration-verification-display-name-input="1"
          type="text"
          autocomplete="nickname"
          value="${escapeHtml(state.displayNameDraft)}"
          style="width:100%;box-sizing:border-box;height:42px;border-radius:8px;border:1px solid rgba(212,165,32,0.34);background:#050505;color:#ffffff;padding:0 12px;font-size:15px;font-weight:700;outline:none;"
        >
        <span style="font-size:11px;font-weight:400;letter-spacing:0;text-transform:none;color:#ffffff;">Мин. 3 символа. Букви на кирилица или латиница, цифри и по един интервал между думите.</span>
      </label>
      <button type="submit" data-registration-verification-display-name-submit="1" ${state.isChangingDisplayName ? 'disabled' : ''} style="height:46px;border:0;border-radius:8px;background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;font-size:15px;font-weight:900;cursor:${state.isChangingDisplayName ? 'default' : 'pointer'};opacity:${state.isChangingDisplayName ? '0.7' : '1'};">
        ${state.isChangingDisplayName ? 'Запазване...' : 'Запази и продължи'}
      </button>
      <button type="button" data-registration-verification-display-name-cancel="1" style="height:34px;border:0;background:transparent;color:rgba(255,255,255,0.72);font-size:13px;font-weight:800;cursor:pointer;">
        Назад към кода за потвърждение
      </button>
      <div data-registration-verification-error="1" style="border-radius:8px;border:1px solid rgba(248,113,113,0.28);background:rgba(127,29,29,0.42);padding:10px 12px;color:#fecaca;font-size:13px;font-weight:800;text-align:center;${state.errorText ? '' : 'display:none;'}">${state.errorText ? escapeHtml(state.errorText) : ''}</div>
    </form>
  `
}

export function renderRegistrationVerificationPopup(state: RegistrationVerificationPopupState): string {
  if (!state.isOpen) {
    return ''
  }

  const body = state.mode === 'displayName' ? renderDisplayNameForm(state) : renderCodeForm(state)

  return `
    <div data-registration-verification-modal-root="1" style="position:fixed;inset:0;z-index:13000;display:flex;align-items:center;justify-content:center;padding:24px;">
      <div data-registration-verification-modal-backdrop="1" style="position:absolute;inset:0;background:rgba(0,0,0,0.45);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);"></div>
      <div role="dialog" aria-modal="true" style="position:relative;width:min(92vw,440px);border-radius:8px;border:2px solid rgba(212,165,32,0.72);background:linear-gradient(180deg,rgba(32,32,32,0.98) 0%,rgba(8,8,8,0.99) 100%);box-shadow:0 34px 80px rgba(0,0,0,0.48);padding:24px;">
        <button type="button" data-registration-verification-modal-close="1" aria-label="Затвори" style="position:absolute;right:4px;top:4px;width:36px;height:36px;border:0;border-radius:999px;background:rgba(255,255,255,0.08);color:#ffffff;font-size:22px;font-weight:900;cursor:pointer;">×</button>
        ${body}
      </div>
    </div>
  `
}

/**
 * Targeted DOM patch за resend countdown-а — НЕ full render() (root cause на
 * production bug-а "въведените цифри веднага изчезват": countdown-ът тик-ваше
 * веднъж в секунда чрез пълен render(), което пресъздаваше ЦЕЛИЯ
 * root.innerHTML, включително code input-а, с празен value). Извиква се от
 * контролера ВМЕСТО render() при всеки interval tick, докато popup-ът е
 * отворен в 'code' режим — пипа само resend бутона, input-ът никога не се
 * докосва (нито се пресъздава, нито губи focus/caret).
 */
export function patchRegistrationVerificationCountdown(
  root: ParentNode,
  state: RegistrationVerificationPopupState,
): void {
  if (!state.isOpen || state.mode !== 'code') return

  const resendButton = root.querySelector<HTMLButtonElement>('[data-registration-verification-resend="1"]')
  if (!resendButton) return

  const secondsRemaining = formatSecondsRemaining(state.resendAvailableAtMs, state.nowMs)
  const resendDisabled = state.isResending || secondsRemaining > 0
  const resendLabel = state.isResending
    ? 'Изпращане...'
    : secondsRemaining > 0
    ? `Изпрати отново (${secondsRemaining}с)`
    : 'Изпрати отново'

  resendButton.disabled = resendDisabled
  resendButton.textContent = `Не получихте код? ${resendLabel}`
  resendButton.style.color = resendDisabled ? 'rgba(255,255,255,0.4)' : 'rgba(212,165,32,0.85)'
  resendButton.style.cursor = resendDisabled ? 'default' : 'pointer'
  resendButton.style.textDecoration = resendDisabled ? 'none' : 'underline'
}

function sanitizeCodeInput(input: HTMLInputElement): void {
  const digitsOnly = input.value.replace(/[^0-9]/g, '').slice(0, 6)
  if (digitsOnly !== input.value) {
    input.value = digitsOnly
  }
}

export function attachRegistrationVerificationPopupEventListeners(
  root: ParentNode,
  options: RegistrationVerificationPopupOptions,
): void {
  root.querySelector('[data-registration-verification-modal-backdrop="1"]')?.addEventListener('click', () => {
    options.onClose()
  })
  root.querySelector('[data-registration-verification-modal-close="1"]')?.addEventListener('click', () => {
    options.onClose()
  })
  root.querySelector('[data-registration-verification-change-email="1"]')?.addEventListener('click', () => {
    options.onChangeEmail()
  })
  root.querySelector('[data-registration-verification-resend="1"]')?.addEventListener('click', () => {
    options.onResend()
  })

  const codeInput = root.querySelector<HTMLInputElement>('[data-registration-verification-code-input="1"]')
  if (codeInput) {
    // Auto-focus — потребителят обикновено идва право от email клиента,
    // директно готов да въведе кода. Caret отива в края на вече baked-натата
    // value (виж state.code doc коментара) — ако ТОЗИ rebuild е resume след
    // друг legitimate full render с вече въведени цифри, потребителят
    // продължава да пише от там, откъдето е спрял, вместо caret-ът да скочи
    // в началото.
    codeInput.focus()
    codeInput.setSelectionRange(codeInput.value.length, codeInput.value.length)
    codeInput.addEventListener('input', () => {
      sanitizeCodeInput(codeInput)
      options.onCodeChange(codeInput.value)
    })
    // Paste на 6 digits (spec §"UI / UX DETAILS") — 'input' event вече
    // handle-ва paste-натия текст еднакво с типирания (browser paste
    // тригерва 'input'), sanitizeCodeInput вече го подрязва до 6 цифри.
  }

  const rememberMeInput = root.querySelector<HTMLInputElement>('[data-registration-verification-remember-me="1"]')
  rememberMeInput?.addEventListener('change', () => {
    options.onRememberMeChange(rememberMeInput.checked)
  })

  const form = root.querySelector<HTMLFormElement>('[data-registration-verification-form="1"]')
  form?.addEventListener('submit', (event) => {
    event.preventDefault()
    const code = codeInput?.value.trim() ?? ''
    if (code.length !== 6) return
    options.onSubmitCode(code)
  })

  const displayNameInput = root.querySelector<HTMLInputElement>('[data-registration-verification-display-name-input="1"]')
  if (displayNameInput) {
    // Auto-focus, mirror на codeInput-а по-горе (виж doc коментара там за
    // пълния rationale) — caret отива в края на вече baked-натата value
    // (state.displayNameDraft), за да продължи потребителят да пише от
    // там, откъдето е спрял, ако ТОЗИ rebuild е resume след неуспешен
    // resubmit с вече въведено име.
    displayNameInput.focus()
    displayNameInput.setSelectionRange(displayNameInput.value.length, displayNameInput.value.length)
    displayNameInput.addEventListener('input', () => {
      options.onDisplayNameDraftChange(displayNameInput.value)
    })
  }

  const displayNameForm = root.querySelector<HTMLFormElement>('[data-registration-verification-display-name-form="1"]')
  displayNameForm?.addEventListener('submit', (event) => {
    event.preventDefault()
    const displayName = displayNameInput?.value.trim() ?? ''
    if (displayName.length === 0) return
    options.onSubmitDisplayName(displayName)
  })

  root.querySelector('[data-registration-verification-display-name-cancel="1"]')?.addEventListener('click', () => {
    options.onCancelDisplayNameChange()
  })
}
