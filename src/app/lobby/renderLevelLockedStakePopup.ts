import { escapeHtml } from './renderLobbyScreen.js'

export type LevelLockedStakePopupState = {
  isOpen: boolean
  requiredLevel: number
  currentLevel: number
}

export type LevelLockedStakePopupOptions = {
  onViewProfileClick: () => void
  onClose: () => void
}

export function renderLevelLockedStakePopup(state: LevelLockedStakePopupState): string {
  if (!state.isOpen) {
    return ''
  }

  const heading = `Тази маса изисква ниво ${state.requiredLevel} за вход, а вашето ниво е ${state.currentLevel}.`
  const body = 'Можете да видите нивото си върху профилната снимка в лобито или в профила си, където може да следите и прогреса на нивото.'

  return `
    <div data-level-locked-stake-modal-root="1" style="position:fixed;inset:0;z-index:13000;display:flex;align-items:center;justify-content:center;padding:24px;">
      <div data-level-locked-stake-modal-backdrop="1" style="position:absolute;inset:0;background:rgba(0,0,0,0.45);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);"></div>
      <div role="dialog" aria-modal="true" style="position:relative;width:min(92vw,480px);border-radius:8px;border:2px solid rgba(212,165,32,0.72);background:linear-gradient(180deg,rgba(32,32,32,0.98) 0%,rgba(8,8,8,0.99) 100%);box-shadow:0 34px 80px rgba(0,0,0,0.48);padding:24px;">
        <button type="button" data-level-locked-stake-modal-close="1" aria-label="Затвори" style="position:absolute;right:4px;top:4px;width:36px;height:36px;border:0;border-radius:999px;background:rgba(255,255,255,0.08);color:#ffffff;font-size:22px;font-weight:900;cursor:pointer;">×</button>
        <div style="display:grid;gap:14px;">
          <div style="display:grid;gap:16px;text-align:center;">
            <div style="font-size:20px;line-height:1.35;font-weight:900;color:#f8fafc;">${escapeHtml(heading)}</div>
            <div style="font-size:15px;line-height:1.5;color:rgba(255,255,255,0.72);font-weight:700;">${escapeHtml(body)}</div>
            <div style="display:flex;justify-content:center;gap:12px;flex-wrap:wrap;margin-top:6px;">
              <button type="button" data-level-locked-stake-ok-button="1" style="height:46px;min-width:130px;border:0;border-radius:8px;background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;font-size:15px;font-weight:900;cursor:pointer;">Разбрах</button>
              <button type="button" data-level-locked-stake-view-profile-button="1" style="height:46px;min-width:150px;border:1px solid rgba(212,165,32,0.62);border-radius:8px;background:#080808;color:#f8fafc;font-size:15px;font-weight:900;cursor:pointer;">Виж профила</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `
}

export function attachLevelLockedStakePopupEventListeners(
  root: ParentNode,
  options: LevelLockedStakePopupOptions,
): void {
  root.querySelector('[data-level-locked-stake-modal-backdrop="1"]')?.addEventListener('click', () => {
    options.onClose()
  })
  root.querySelector('[data-level-locked-stake-modal-close="1"]')?.addEventListener('click', () => {
    options.onClose()
  })
  root.querySelector('[data-level-locked-stake-ok-button="1"]')?.addEventListener('click', () => {
    options.onClose()
  })
  root.querySelector('[data-level-locked-stake-view-profile-button="1"]')?.addEventListener('click', () => {
    options.onViewProfileClick()
  })
}
