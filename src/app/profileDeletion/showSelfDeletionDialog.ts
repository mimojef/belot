// Самоизтриване, Етап 4I — прозорец "Изтриване на профила" от собствения
// профил. Подаването минава САМО през съществуващия сървърен API
// (POST /api/account/deletion-request: собствената сесия + настоящата парола
// + изрично потвърждение). Сървърът решава всичко (флаг, роля, бан, активна
// игра, вече подадена заявка); тук няма бизнес правила и крайният срок не се
// пресмята — показва се scheduledFor от отговора.
//
// Паролата живее само в полето на формата и в тялото на заявката: не се
// записва никъде (без localStorage/sessionStorage) и полето се изчиства след
// всеки опит.

import { formatPendingDeletionDeadline } from './showPendingDeletionPrompt'
import { VOLUNTARY_PROFILE_DELETION_TERMS_PATH } from '../lobby/publicLegalPages'

export type SelfDeletionSubmitResult =
  | { ok: true; scheduledFor: string | null; gracePeriodDays: number | null }
  | { ok: false; code: string | null; message: string | null }

export type SelfDeletionDialogCallbacks = {
  /** Реалната заявка към сървъра. */
  submit: (password: string) => Promise<SelfDeletionSubmitResult>
  /** Преди изпращането — напр. guard срещу reconnect/reload на WS слоя. */
  onSubmitStart?: () => void
  /** Сървърът НЕ е приел заявката (или няма отговор) — достъпът остава. */
  onSubmitFailed?: () => void
  /** Сървърът е приел заявката — нормалният достъп вече е прекратен. */
  onAccepted: () => void
  /** "Разбрах" след приета заявка — чисто презареждане към началото. */
  onAcceptedClose: () => void
}

const HOST_ID = 'self-deletion-dialog'

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// Етап 4K — отказ заради незавършен ангажимент: конкретната причина, какво
// да направи потребителят и че нищо не е променено.
const PARTICIPATION_REFUSAL_SUFFIX = ' Профилът не е изтрит и заявка за изтриване не е приета.'
const PARTICIPATION_REFUSAL_MESSAGES: Record<string, string> = {
  ACTIVE_GAME: 'Не можете да подадете заявка за изтриване, докато участвате в активна игра. Изчакайте играта да приключи и опитайте отново.',
  BELOT_PRIVATE_TABLE: 'Имате заето място на частна маса в Белот. Напуснете масата, преди да подадете заявка за изтриване на профила.',
  LUDO_PRIVATE_TABLE: 'Имате заето място на частна маса в „Не се сърди човече“. Напуснете масата, преди да подадете заявка за изтриване на профила.',
  BELOT_MATCHMAKING: 'В момента търсите игра в Белот. Спрете търсенето, преди да подадете заявка за изтриване на профила.',
  TOURNAMENT_REGISTRATION: 'Не можете да подадете заявка за изтриване на профила, защото сте записан за участие в турнир. Напуснете турнира или изчакайте той да приключи, след което опитайте отново.',
  TOURNAMENT_ORGANIZER: 'Не можете да подадете заявка за изтриване на профила, защото сте организатор на турнир, който още не е приключил. Изчакайте турнирът да приключи или го отменете, ако това все още е възможно, след което опитайте отново.',
}

/** Разбираемо съобщение по кода на сървъра (иначе — съобщението на сървъра). */
export function describeSelfDeletionError(code: string | null, message: string | null): string {
  if (code !== null && Object.prototype.hasOwnProperty.call(PARTICIPATION_REFUSAL_MESSAGES, code)) {
    return PARTICIPATION_REFUSAL_MESSAGES[code] + PARTICIPATION_REFUSAL_SUFFIX
  }
  switch (code) {
    case 'INVALID_PASSWORD':
      return 'Паролата не е вярна. Опитайте отново.'
    case 'PROFILE_BANNED':
      return 'Профилът има активен бан. Заявка за изтриване може да бъде подадена едва след като банът изтече или бъде премахнат.'
    case 'ALREADY_PENDING':
      return 'Вече има подадена заявка за изтриване на този профил.'
    case 'RATE_LIMITED':
      return 'Направени са твърде много опити. Опитайте отново по-късно.'
    case 'PROFILE_SELF_DELETION_DISABLED':
      return 'Функцията в момента не е налична.'
    case 'CONFIRMATION_REQUIRED':
      return 'Отбележете полето за потвърждение.'
    case null:
      return message ?? 'Няма връзка със сървъра. Профилът не е подаден за изтриване — опитайте отново.'
    default:
      return message ?? 'Заявката не беше приета. Профилът не е подаден за изтриване.'
  }
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'

export function showSelfDeletionDialog(callbacks: SelfDeletionDialogCallbacks): void {
  document.getElementById(HOST_ID)?.remove()
  const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null

  const host = document.createElement('div')
  host.id = HOST_ID
  // Цял екран, превъртане на целия слой: на малък телефон и при отворена
  // клавиатура съдържанието и бутоните остават достъпни.
  host.style.cssText = 'position:fixed;inset:0;z-index:210000;overflow-y:auto;-webkit-overflow-scrolling:touch;background:rgba(0,0,0,0.82);font-family:Arial,Helvetica,sans-serif;'
  document.body.appendChild(host)

  let busy = false
  let accepted = false

  const close = () => {
    if (busy || accepted) return
    document.removeEventListener('keydown', onKeydown, true)
    host.remove()
    previouslyFocused?.focus?.()
  }

  const onKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
      return
    }
    if (event.key === 'Tab') {
      const items = [...host.querySelectorAll<HTMLElement>(FOCUSABLE)]
      if (items.length === 0) return
      const first = items[0]!
      const last = items[items.length - 1]!
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
  }
  document.addEventListener('keydown', onKeydown, true)

  const card = (inner: string) => `
    <div style="min-height:100%;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;">
      <div role="dialog" aria-modal="true" aria-labelledby="self-deletion-title" aria-describedby="self-deletion-description"
        style="width:min(100%,460px);box-sizing:border-box;border-radius:8px;border:2px solid rgba(248,113,113,0.55);background:linear-gradient(180deg,rgba(32,32,32,0.98) 0%,rgba(8,8,8,0.99) 100%);box-shadow:0 34px 80px rgba(0,0,0,0.48);padding:22px;">
        ${inner}
      </div>
    </div>
  `
  const paragraph = (text: string, color = 'rgba(226,232,240,0.88)') =>
    `<p style="margin:0 0 12px;font-size:15px;line-height:1.55;color:${color};">${escapeHtml(text)}</p>`

  host.innerHTML = card(`
    <h2 id="self-deletion-title" style="margin:0 0 14px;font-size:21px;font-weight:900;color:#f8fafc;">Изтриване на профила</h2>
    <div id="self-deletion-description">
      ${paragraph('След потвърждението профилът Ви ще бъде скрит, а всички активни сесии ще бъдат прекратени.')}
      ${paragraph('Разполагате с 30 дни, за да отмените заявката.')}
      ${paragraph('За да отмените заявката за изтриване, трябва да влезете със своя имейл и парола и да изберете „Запази профила ми“.')}
      ${paragraph('След изтичането на 30-дневния срок профилът подлежи на окончателно изтриване и няма да може да бъде възстановен.')}
      <p data-self-deletion-terms="1" style="margin:0 0 14px;font-size:14px;line-height:1.5;color:rgba(226,232,240,0.88);">Подробна информация: <a data-self-deletion-terms-link="1" href="${escapeHtml(VOLUNTARY_PROFILE_DELETION_TERMS_PATH)}" target="_blank" rel="noopener" style="color:#fde68a;font-weight:800;text-decoration:underline;text-underline-offset:3px;">Общи условия, раздел 28</a>.</p>
    </div>
    <form data-self-deletion-form="1" novalidate>
      <label for="self-deletion-password" style="display:block;margin:0 0 6px;font-size:14px;font-weight:800;color:#f8fafc;">Въведете текущата си парола.</label>
      <input id="self-deletion-password" data-self-deletion-password="1" type="password" name="current-password" autocomplete="current-password" required
        style="width:100%;box-sizing:border-box;min-height:46px;padding:0 12px;border-radius:8px;border:1px solid rgba(255,255,255,0.22);background:rgba(255,255,255,0.06);color:#f8fafc;font-size:16px;font-family:inherit;margin-bottom:14px;">
      <label style="display:flex;align-items:flex-start;gap:10px;margin:0 0 14px;cursor:pointer;font-size:14px;line-height:1.5;color:rgba(226,232,240,0.88);">
        <input type="checkbox" data-self-deletion-confirm="1" style="width:20px;height:20px;flex:0 0 auto;margin:2px 0 0;accent-color:#ef4444;">
        <span>Разбирам, че след изтичането на 30-дневния срок няма да мога самостоятелно да отменя заявката.</span>
      </label>
      <div data-self-deletion-error="1" role="alert" aria-live="assertive" style="display:none;margin:0 0 12px;font-size:14px;line-height:1.5;color:#fca5a5;"></div>
      <div style="display:flex;flex-direction:column;gap:10px;">
        <button type="submit" data-self-deletion-submit="1" disabled
          style="width:100%;min-height:46px;border:0;border-radius:8px;background:linear-gradient(180deg,#ef4444 0%,#b91c1c 100%);color:#fff;font-size:15px;font-weight:900;cursor:pointer;font-family:inherit;">Потвърди изтриването</button>
        <button type="button" data-self-deletion-cancel="1"
          style="width:100%;min-height:46px;border:1px solid rgba(255,255,255,0.22);border-radius:8px;background:transparent;color:#f8fafc;font-size:14px;font-weight:800;cursor:pointer;font-family:inherit;">Отказ</button>
      </div>
    </form>
  `)

  // Клик извън прозореца затваря (никога не подава).
  host.addEventListener('click', (event) => {
    if (event.target === host || (event.target as HTMLElement).parentElement === host) close()
  })

  const form = host.querySelector<HTMLFormElement>('[data-self-deletion-form="1"]')!
  const password = host.querySelector<HTMLInputElement>('[data-self-deletion-password="1"]')!
  const confirm = host.querySelector<HTMLInputElement>('[data-self-deletion-confirm="1"]')!
  const submitButton = host.querySelector<HTMLButtonElement>('[data-self-deletion-submit="1"]')!
  const cancelButton = host.querySelector<HTMLButtonElement>('[data-self-deletion-cancel="1"]')!
  const errorEl = host.querySelector<HTMLElement>('[data-self-deletion-error="1"]')!

  const canSubmit = () => !busy && password.value.length > 0 && confirm.checked
  const refresh = () => {
    submitButton.disabled = !canSubmit()
    submitButton.style.opacity = submitButton.disabled ? '0.5' : '1'
    submitButton.style.cursor = submitButton.disabled ? 'not-allowed' : 'pointer'
  }
  const showError = (text: string) => {
    errorEl.textContent = text
    errorEl.style.display = ''
  }
  password.addEventListener('input', refresh)
  confirm.addEventListener('change', refresh)
  cancelButton.addEventListener('click', close)
  refresh()
  password.focus()

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    if (!canSubmit()) return
    busy = true
    const enteredPassword = password.value
    password.value = ''
    password.disabled = true
    confirm.disabled = true
    cancelButton.disabled = true
    submitButton.textContent = 'Изпращане…'
    refresh()
    errorEl.style.display = 'none'
    callbacks.onSubmitStart?.()
    void callbacks.submit(enteredPassword).then((result) => {
      busy = false
      if (!result.ok) {
        callbacks.onSubmitFailed?.()
        password.disabled = false
        confirm.disabled = false
        cancelButton.disabled = false
        submitButton.textContent = 'Потвърди изтриването'
        refresh()
        showError(describeSelfDeletionError(result.code, result.message))
        password.focus()
        return
      }
      accepted = true
      callbacks.onAccepted()
      const deadline = formatPendingDeletionDeadline(result.scheduledFor ?? undefined)
      host.innerHTML = card(`
        <h2 id="self-deletion-title" style="margin:0 0 14px;font-size:21px;font-weight:900;color:#f8fafc;">Заявката е приета</h2>
        <div id="self-deletion-description">
          ${paragraph('Профилът Ви е скрит и достъпът до него е спрян.')}
          ${deadline !== null ? `<p style="margin:0 0 12px;font-size:15px;line-height:1.55;color:rgba(226,232,240,0.88);">Окончателно изтриване: <strong data-self-deletion-deadline="1" style="color:#fde68a;">${escapeHtml(deadline)}</strong></p>` : ''}
          ${paragraph('Ако размислите, влезте отново с имейла и паролата си преди тази дата и изберете „Запази профила ми“.')}
        </div>
        <button type="button" data-self-deletion-done="1"
          style="width:100%;min-height:46px;border:0;border-radius:8px;background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;font-size:15px;font-weight:900;cursor:pointer;font-family:inherit;">Разбрах</button>
      `)
      const done = host.querySelector<HTMLButtonElement>('[data-self-deletion-done="1"]')
      done?.addEventListener('click', () => {
        document.removeEventListener('keydown', onKeydown, true)
        callbacks.onAcceptedClose()
      })
      done?.focus()
    })
  })
}
