// Информационен popup при опит за блокиране на профил от екипа на Pika.bg
// (server отговор 403 code 'PROTECTED_STAFF_PROFILE').
//
// Server-ът е единственият източник на истината — този popup само визуализира
// отказа. Бутонът "Блокирай" нарочно НЕ се крие предварително (клиентът не
// знае и не трябва да знае ролята на target-а).
//
// Монтира се директно в document.body над всички lobby / in-game profile
// popup-и (in-game seat profile overlay е на 99998), но под системните
// session/reclaim overlay-и (200000+).

export const PROTECTED_STAFF_PROFILE_ERROR_CODE = 'PROTECTED_STAFF_PROFILE'

export const PROTECTED_STAFF_PROFILE_BLOCK_MESSAGE = 'Не можете да блокирате профил от екипа на Pika.bg.'

const HOST_ATTRIBUTE = 'data-protected-staff-block-notice'

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function closeProtectedStaffBlockNotice(): void {
  document.querySelectorAll(`[${HOST_ATTRIBUTE}="1"]`).forEach((element) => element.remove())
}

export function showProtectedStaffBlockNotice(message: string = PROTECTED_STAFF_PROFILE_BLOCK_MESSAGE): void {
  closeProtectedStaffBlockNotice()

  const host = document.createElement('div')
  host.setAttribute(HOST_ATTRIBUTE, '1')
  host.setAttribute('role', 'alertdialog')
  host.setAttribute('aria-modal', 'true')
  host.style.cssText = 'position:fixed;inset:0;z-index:100001;pointer-events:auto;font-family:Arial,Helvetica,sans-serif;'
  host.innerHTML = `
    <div
      data-protected-staff-block-notice-backdrop="1"
      style="position:absolute;inset:0;background:rgba(0,0,0,0.72);-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);"
    ></div>
    <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;pointer-events:none;">
      <div style="
        position:relative;
        pointer-events:auto;
        width:min(92vw,420px);
        border-radius:8px;
        background:linear-gradient(180deg,rgba(32,32,32,0.98) 0%,rgba(8,8,8,0.99) 100%);
        border:2px solid rgba(212,165,32,0.72);
        box-shadow:0 34px 80px rgba(0,0,0,0.42);
        padding:28px 24px;
        text-align:center;
      ">
        <div style="font-size:36px;margin-bottom:12px;">🛡️</div>
        <div
          data-protected-staff-block-notice-text="1"
          style="font-size:15px;font-weight:800;color:#f8fafc;line-height:1.55;margin-bottom:22px;"
        >${escapeHtml(message)}</div>
        <button
          type="button"
          data-protected-staff-block-notice-ok="1"
          style="
            min-height:40px;min-width:110px;padding:0 22px;
            border:1px solid rgba(212,165,32,0.55);border-radius:8px;
            background:linear-gradient(180deg,rgba(244,201,91,0.96) 0%,rgba(201,143,19,0.96) 100%);
            color:#080808;font-size:14px;font-weight:900;cursor:pointer;
          "
        >OK</button>
      </div>
    </div>
  `

  const close = (): void => {
    host.remove()
  }
  host.querySelector('[data-protected-staff-block-notice-ok="1"]')?.addEventListener('click', (event) => {
    event.stopPropagation()
    close()
  })
  host.querySelector('[data-protected-staff-block-notice-backdrop="1"]')?.addEventListener('click', (event) => {
    event.stopPropagation()
    close()
  })
  // Не позволяваме кликове вътре в popup-а да стигнат до document-level
  // "click outside" handler-и на profile popup-ите под него.
  host.addEventListener('click', (event) => event.stopPropagation())

  document.body.appendChild(host)
  host.querySelector<HTMLButtonElement>('[data-protected-staff-block-notice-ok="1"]')?.focus()
}
