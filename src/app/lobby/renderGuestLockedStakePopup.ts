import { escapeHtml, GUEST_MOBILE_LOBBY_FONT_FAMILY } from './renderLobbyScreen.js'
import { VIOLET_3D_BUTTON_CLASS } from '../../ui/layout/violet3dButton'

export type GuestLockedStakePopupState = {
  isOpen: boolean
}

export type GuestLockedStakePopupOptions = {
  onPlay5000Click: () => void
  onRegisterClick: () => void
  onLoginClick: () => void
  onClose: () => void
}

export function renderGuestLockedStakePopup(state: GuestLockedStakePopupState, isGuestMobileLobby = false): string {
  if (!state.isOpen) {
    return ''
  }
  if (isGuestMobileLobby) {
    return renderGuestLockedStakePopupLight()
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

// Светлата версия — само в новото мобилно лоби за гости (същият стил като
// светлия auth popup). Същите текстове и data-* атрибути → същите действия
// (attachGuestLockedStakePopupEventListeners) и затваряне.
function renderGuestLockedStakePopupLight(): string {
  const linkStyle = 'background:none;border:0;padding:6px 4px;color:#7950E8;font-family:inherit;font-size:15px;font-weight:800;cursor:pointer;text-decoration:underline;text-underline-offset:3px;'
  return `
    <div data-guest-locked-stake-modal-root="1" data-guest-locked-stake-modal-light="1" style="position:fixed;inset:0;z-index:13000;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;font-family:${GUEST_MOBILE_LOBBY_FONT_FAMILY};">
      <div data-guest-locked-stake-modal-backdrop="1" style="position:absolute;inset:0;background:rgba(20,20,43,0.45);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);"></div>
      <div role="dialog" aria-modal="true" style="position:relative;width:min(100%,400px);box-sizing:border-box;max-height:calc(100dvh - 32px);overflow-y:auto;overscroll-behavior:contain;border-radius:12px;border:1px solid #E4E7EC;background:#FFFFFF;box-shadow:0 20px 48px rgba(23,35,60,0.18);padding:28px 20px 20px;">
        <button type="button" data-guest-locked-stake-modal-close="1" aria-label="Затвори" style="position:absolute;right:8px;top:8px;width:36px;height:36px;border:0;border-radius:8px;background:#F2F4F7;color:#475467;cursor:pointer;padding:0;display:flex;align-items:center;justify-content:center;"><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true" style="display:block;"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>
        <div style="display:grid;gap:14px;text-align:center;">
          <div style="font-size:22px;line-height:1.3;font-weight:900;color:#17233C;padding:0 22px;">${escapeHtml('Като гост не можете да играете на маса с този залог.')}</div>
          <div style="font-size:15px;line-height:1.5;color:#667085;font-weight:600;">${escapeHtml('Пробвайте маса със залог 5 000 или влезте в профила си.')}</div>
          <div style="display:flex;flex-direction:column;align-items:center;gap:10px;margin-top:6px;">
            <button type="button" class="lobby-violet-btn ${VIOLET_3D_BUTTON_CLASS}" data-guest-locked-stake-play-5000-button="1" style="height:46px;min-width:200px;padding:0 24px;border:0;border-radius:8px;color:#FFFFFF;font-family:inherit;font-size:15px;font-weight:900;cursor:pointer;">Играй на 5 000</button>
            <div style="display:flex;align-items:center;justify-content:center;gap:10px;">
              <button type="button" data-guest-locked-stake-login-button="1" style="${linkStyle}">Вход</button>
              <span aria-hidden="true" style="width:1px;height:16px;background:#D0D5DD;"></span>
              <button type="button" data-guest-locked-stake-register-button="1" style="${linkStyle}">Създай профил</button>
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
