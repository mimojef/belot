import { escapeHtml } from './renderLobbyScreen.js'

// Единен modal за целия VIP Stripe success-redirect UX преход:
// 'loading' (веднага при redirect landing, докато чакаме webhook) ->
// 'success' (САМО след server-confirmed paid — days/activeUntilLabel идват
// от РЕАЛНИЯ покупен пакет и РЕАЛНИЯ обновен /api/vip/status отговор,
// никога client-side изчислени) ИЛИ 'delayed' (polling timeout изтече без
// paid — НЕ грешка, webhook просто закъснява). Една state transition в
// СЪЩИЯ popup instance — никога два stacked popup-а (виж
// handleStripePaymentSuccessReturn в main.ts).
export type VipPurchaseSuccessPopupPhase = 'loading' | 'success' | 'delayed'

export type VipPurchaseSuccessPopupState = {
  isOpen: boolean
  phase: VipPurchaseSuccessPopupPhase
  days: number
  activeUntilLabel: string | null
}

export type VipPurchaseSuccessPopupOptions = {
  onClose: () => void
}

const SPINNER_KEYFRAMES_STYLE_ID = 'vip-purchase-success-popup-spinner-style'

function renderSpinnerStyleTagOnce(): string {
  // Лек CSS-only spinner (без нов dependency) — inline <style> с уникален id,
  // за да не се дублира при повторни render() извиквания на root.innerHTML.
  return `
    <style id="${SPINNER_KEYFRAMES_STYLE_ID}">
      @keyframes vipPurchaseSuccessPopupSpin { to { transform: rotate(360deg); } }
    </style>
  `
}

function renderSpinner(): string {
  return `
    <div aria-hidden="true" style="
      width:44px;height:44px;margin:0 auto;
      border:4px solid rgba(212,165,32,0.24);
      border-top-color:#d4a520;
      border-radius:50%;
      animation:vipPurchaseSuccessPopupSpin 0.9s linear infinite;
    "></div>
  `
}

function renderModalShell(bodyHtml: string): string {
  return `
    ${renderSpinnerStyleTagOnce()}
    <div data-vip-purchase-success-popup-root="1" style="position:fixed;inset:0;z-index:13000;display:flex;align-items:center;justify-content:center;padding:24px;">
      <div data-vip-purchase-success-popup-backdrop="1" style="position:absolute;inset:0;background:rgba(0,0,0,0.45);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);"></div>
      <div role="dialog" aria-modal="true" style="position:relative;width:min(92vw,440px);border-radius:8px;border:2px solid rgba(212,165,32,0.72);background:linear-gradient(180deg,rgba(32,32,32,0.98) 0%,rgba(8,8,8,0.99) 100%);box-shadow:0 34px 80px rgba(0,0,0,0.48);padding:24px;">
        <div style="display:grid;gap:16px;text-align:center;">
          ${bodyHtml}
        </div>
      </div>
    </div>
  `
}

export function renderVipPurchaseSuccessPopup(state: VipPurchaseSuccessPopupState): string {
  if (!state.isOpen) {
    return ''
  }

  if (state.phase === 'loading') {
    return renderModalShell(`
      ${renderSpinner()}
      <div style="font-size:22px;line-height:1.2;font-weight:900;color:#f8fafc;">Плащането се обработва</div>
      <div style="font-size:15px;line-height:1.5;color:rgba(255,255,255,0.85);font-weight:800;">Изчакваме потвърждение на плащането...</div>
      <div style="font-size:13px;line-height:1.5;color:rgba(255,255,255,0.56);font-weight:700;">Не затваряйте страницата.</div>
    `)
  }

  if (state.phase === 'delayed') {
    return renderModalShell(`
      <div style="font-size:22px;line-height:1.2;font-weight:900;color:#f8fafc;">Плащането се обработва</div>
      <div style="font-size:15px;line-height:1.5;color:rgba(255,255,255,0.85);font-weight:800;">Потвърждението от платежната система се забавя. VIP ще бъде активиран автоматично след потвърждението.</div>
      <div style="display:flex;justify-content:center;margin-top:6px;">
        <button type="button" data-vip-purchase-success-popup-ok="1" style="height:46px;min-width:130px;border:0;border-radius:8px;background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;font-size:15px;font-weight:900;cursor:pointer;">OK</button>
      </div>
    `)
  }

  const daysWord = state.days === 1 ? 'ден' : 'дни'
  const activeUntilLine = state.activeUntilLabel
    ? `<div style="font-size:14px;line-height:1.5;color:rgba(255,255,255,0.72);font-weight:700;">Вашият VIP е активен до ${escapeHtml(state.activeUntilLabel)} г.</div>`
    : ''

  return renderModalShell(`
    <div style="font-size:22px;line-height:1.2;font-weight:900;color:#f8fafc;">Успешно плащане</div>
    <div style="font-size:15px;line-height:1.5;color:rgba(255,255,255,0.85);font-weight:800;">Вие успешно закупихте VIP за ${state.days} ${daysWord}.</div>
    ${activeUntilLine}
    <div style="display:flex;justify-content:center;margin-top:6px;">
      <button type="button" data-vip-purchase-success-popup-ok="1" style="height:46px;min-width:130px;border:0;border-radius:8px;background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;font-size:15px;font-weight:900;cursor:pointer;">OK</button>
    </div>
  `)
}

export function attachVipPurchaseSuccessPopupEventListeners(
  root: ParentNode,
  options: VipPurchaseSuccessPopupOptions,
): void {
  root.querySelector('[data-vip-purchase-success-popup-backdrop="1"]')?.addEventListener('click', () => {
    options.onClose()
  })
  root.querySelector('[data-vip-purchase-success-popup-ok="1"]')?.addEventListener('click', () => {
    options.onClose()
  })
}
