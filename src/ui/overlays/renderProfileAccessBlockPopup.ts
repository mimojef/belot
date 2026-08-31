// Общ denied-profile popup за server-side profile access denial (block в
// която и да е посока) — споделен между lobby (renderLobbyScreen.ts, вграден
// inline в root HTML-а) и in-game/private-room seat popup
// (createActiveRoomFlowController.ts, mount-нат самостоятелно на
// document.body чрез mountProfileAccessBlockPopup по-долу, тъй като active
// room-ът няма lobby root DOM). Една имплементация, за да не се копира block
// UI логика по отделните screens — виж task brief-а.

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export type ProfileAccessBlockCode = 'profile_blocked_by_viewer' | 'profile_blocked_viewer'

export type ProfileAccessBlockPopupState = {
  profileId: string
  code: ProfileAccessBlockCode
  /** authoritative "Блокирай" заявката лети — виж onBlock callback-а. */
  blockSubmitting?: boolean
  blockErrorText?: string | null
  /** Кратко inline потвърждение преди auto-close — виж onBlock caller-а. */
  blockSuccess?: boolean
} | null

export function renderProfileAccessBlockPopup(popup: ProfileAccessBlockPopupState): string {
  if (popup === null) return ''

  const viewerIsBlocker = popup.code === 'profile_blocked_by_viewer'
  const message = viewerIsBlocker
    ? 'Този потребител е блокиран от Вас.'
    : 'Този потребител ви е блокирал.'

  // target blocked viewer, viewer още НЕ е блокирал target: UX gap fix —
  // "Затвори" беше единствената опция, макар профилът да е недостъпен и
  // viewer-ът да няма начин да блокира обратно. Затваря се автоматично
  // след success (viewer -> target block вече Е записан server-side преди
  // showcase-ването на blockSuccess — виж caller-а), затова тук няма race
  // към "фалшив success".
  const showBlockAction = !viewerIsBlocker

  const bodyHtml = popup.blockSuccess
    ? `<div style="font-size:17px;font-weight:900;color:#4ade80;line-height:1.45;">Потребителят е блокиран.</div>`
    : `
      <div style="font-size:17px;font-weight:900;color:#f8fafc;line-height:1.45;">${escapeHtml(message)}</div>
      ${popup.blockErrorText ? `<div style="font-size:13px;font-weight:800;color:#fca5a5;line-height:1.4;">${escapeHtml(popup.blockErrorText)}</div>` : ''}
      <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;">
        ${viewerIsBlocker ? `<button type="button" data-profile-access-block-unblock="${escapeHtml(popup.profileId)}" style="min-height:40px;padding:0 18px;border:1px solid rgba(212,165,32,0.55);border-radius:8px;background:linear-gradient(180deg,rgba(244,201,91,0.96) 0%,rgba(201,143,19,0.96) 100%);color:#080808;font-size:13px;font-weight:900;cursor:pointer;">Отблокирай</button>` : ''}
        ${showBlockAction ? `
          <button
            type="button"
            data-profile-access-block-block="${escapeHtml(popup.profileId)}"
            ${popup.blockSubmitting ? 'disabled' : ''}
            style="
              min-height:40px;padding:0 18px;border:1px solid rgba(248,113,113,0.60);border-radius:8px;
              background:${popup.blockSubmitting ? 'rgba(255,255,255,0.07)' : 'linear-gradient(180deg, rgba(220,38,38,0.88) 0%, rgba(185,28,28,0.92) 100%)'};
              color:${popup.blockSubmitting ? 'rgba(255,255,255,0.55)' : '#fff1f2'};
              font-size:13px;font-weight:900;cursor:${popup.blockSubmitting ? 'default' : 'pointer'};
            "
          >${popup.blockSubmitting ? 'Изпращане...' : 'Блокирай'}</button>
        ` : ''}
        <button type="button" data-profile-access-block-close="1" style="min-height:40px;padding:0 18px;border:1px solid rgba(255,255,255,0.18);border-radius:8px;background:rgba(255,255,255,0.07);color:rgba(255,255,255,0.86);font-size:13px;font-weight:900;cursor:pointer;">Затвори</button>
      </div>
    `

  return `
    <div data-profile-access-block-popup-root="1" style="position:fixed;inset:0;z-index:13600;display:flex;align-items:center;justify-content:center;padding:24px;">
      <button type="button" data-profile-access-block-close="1" aria-label="Затвори" style="position:absolute;inset:0;border:0;background:rgba(0,0,0,0.76);-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);cursor:pointer;"></button>
      <div role="dialog" aria-modal="true" style="position:relative;width:min(92vw,430px);border-radius:8px;background:linear-gradient(180deg,rgba(32,32,32,0.98) 0%,rgba(8,8,8,0.99) 100%);border:1px solid rgba(212,165,32,0.50);box-shadow:0 34px 80px rgba(0,0,0,0.48);padding:26px 22px;text-align:center;display:grid;gap:18px;">
        ${bodyHtml}
      </div>
    </div>
  `
}

export function attachProfileAccessBlockPopupListeners(
  root: ParentNode,
  callbacks: {
    onClose: () => void
    onUnblock: (profileId: string) => void
    onBlock: (profileId: string) => void
  },
): void {
  root.querySelectorAll<HTMLButtonElement>('[data-profile-access-block-close="1"]').forEach((btn) => {
    btn.addEventListener('click', callbacks.onClose)
  })

  root.querySelectorAll<HTMLButtonElement>('[data-profile-access-block-unblock]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const profileId = btn.dataset.profileAccessBlockUnblock?.trim() ?? ''
      if (profileId) callbacks.onUnblock(profileId)
    })
  })

  root.querySelectorAll<HTMLButtonElement>('[data-profile-access-block-block]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const profileId = btn.dataset.profileAccessBlockBlock?.trim() ?? ''
      if (profileId) callbacks.onBlock(profileId)
    })
  })
}

const STANDALONE_HOST_ID = 'profile-access-block-popup-standalone-host'

/**
 * Самостоятелен mount за screens без lobby root DOM (in-game seat popup,
 * private-room waiting screen извън lobby root-а). Appended директно на
 * document.body — не зависи от никой друг screen's render tree.
 */
export function mountStandaloneProfileAccessBlockPopup(
  popup: ProfileAccessBlockPopupState,
  callbacks: {
    onClose: () => void
    onUnblock: (profileId: string) => void
    onBlock: (profileId: string) => void
  },
): void {
  if (popup === null) {
    unmountStandaloneProfileAccessBlockPopup()
    return
  }

  let host = document.getElementById(STANDALONE_HOST_ID) as HTMLDivElement | null
  if (!host) {
    host = document.createElement('div')
    host.id = STANDALONE_HOST_ID
    document.body.appendChild(host)
  }

  host.innerHTML = renderProfileAccessBlockPopup(popup)
  attachProfileAccessBlockPopupListeners(host, callbacks)
}

export function unmountStandaloneProfileAccessBlockPopup(): void {
  document.getElementById(STANDALONE_HOST_ID)?.remove()
}
