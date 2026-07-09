import { escapeHtml } from './renderLobbyScreen.js'

export type GuestLockedStakePopupState = {
  isOpen: boolean
}

export type GuestLockedStakePopupOptions = {
  onPlay5000Click: () => void
  onRegisterClick: () => void
  onLoginClick: () => void
  onClose: () => void
}

export function renderGuestLockedStakePopup(state: GuestLockedStakePopupState): string {
  if (!state.isOpen) {
    return ''
  }

  return `
    <div data-guest-locked-stake-modal-root="1" style="position:fixed;inset:0;z-index:13000;display:flex;align-items:center;justify-content:center;padding:24px;">
      <div data-guest-locked-stake-modal-backdrop="1" style="position:absolute;inset:0;background:rgba(0,0,0,0.45);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);"></div>
      <div role="dialog" aria-modal="true" style="position:relative;width:min(92vw,480px);border-radius:8px;border:2px solid rgba(212,165,32,0.72);background:linear-gradient(180deg,rgba(32,32,32,0.98) 0%,rgba(8,8,8,0.99) 100%);box-shadow:0 34px 80px rgba(0,0,0,0.48);padding:24px;">
        <button type="button" data-guest-locked-stake-modal-close="1" aria-label="Затвори" style="position:absolute;right:4px;top:4px;width:36px;height:36px;border:0;border-radius:999px;background:rgba(255,255,255,0.08);color:#ffffff;font-size:22px;font-weight:900;cursor:pointer;">×</button>
        <div style="display:grid;gap:14px;">
          <div style="display:grid;gap:16px;text-align:center;">
            <div style="font-size:22px;line-height:1.3;font-weight:900;color:#f8fafc;">${escapeHtml('Като гост не можете да играете на маса с този залог.')}</div>
            <div style="font-size:15px;line-height:1.5;color:rgba(255,255,255,0.72);font-weight:700;">${escapeHtml('Пробвайте маса със залог 5 000 или влезте в профила си.')}</div>
            <div style="display:flex;flex-direction:column;align-items:center;gap:12px;margin-top:6px;">
              <button type="button" data-guest-locked-stake-play-5000-button="1" style="height:46px;min-width:200px;border:0;border-radius:8px;background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;font-size:15px;font-weight:900;cursor:pointer;">Играй на 5 000</button>
              <div style="display:flex;align-items:center;gap:8px;font-size:14px;font-weight:800;">
                <button type="button" data-guest-locked-stake-login-button="1" style="background:none;border:0;padding:0;color:#f8fafc;cursor:pointer;text-decoration:underline;text-underline-offset:2px;">Вход</button>
                <span style="color:rgba(255,255,255,0.35);">|</span>
                <button type="button" data-guest-locked-stake-register-button="1" style="background:none;border:0;padding:0;color:#f8fafc;cursor:pointer;text-decoration:underline;text-underline-offset:2px;">Създай профил</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `
}

export function attachGuestLockedStakePopupEventListeners(
  root: ParentNode,
  options: GuestLockedStakePopupOptions,
): void {
  root.querySelector('[data-guest-locked-stake-modal-backdrop="1"]')?.addEventListener('click', () => {
    options.onClose()
  })
  root.querySelector('[data-guest-locked-stake-modal-close="1"]')?.addEventListener('click', () => {
    options.onClose()
  })
  root.querySelector('[data-guest-locked-stake-play-5000-button="1"]')?.addEventListener('click', () => {
    options.onPlay5000Click()
  })
  root.querySelector('[data-guest-locked-stake-register-button="1"]')?.addEventListener('click', () => {
    options.onRegisterClick()
  })
  root.querySelector('[data-guest-locked-stake-login-button="1"]')?.addEventListener('click', () => {
    options.onLoginClick()
  })
}
