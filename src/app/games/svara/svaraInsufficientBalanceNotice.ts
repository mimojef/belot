// „Свара“ — недостатъчно жълтици за входа (сървърен код
// 'insufficient_entry_balance': отказ при създаване/сядане или освободено
// място при опит за старт). Сървърът е единственият източник на истината:
// прозорецът само показва отказа и предлага зареждане.
//
//   „Зареди“ — onTopUp() (магазинът, секция „Жълтици“), после затваряне;
//   „Отказ“  — само затваряне (също Escape и клик извън картата).
//
// Темата е по шаблона на showCoPlayRestrictedNotice: светлата мобилна рамка
// → светла карта с виолетовия 3D бутон; иначе тъмно-златният desktop вид.
// Едно копие наведнъж — ново известие замества предишното.

import { isPhoneLayoutViewport } from '../../../ui/layout/viewportStage'
import { getMobileLightUiContext, MOBILE_LIGHT_FONT_FAMILY } from '../../../ui/layout/mobileLightUi'
import { ensureViolet3dButtonStyles, VIOLET_3D_BUTTON_CLASS } from '../../../ui/layout/violet3dButton'

export const SVARA_INSUFFICIENT_ENTRY_BALANCE_CODE = 'insufficient_entry_balance'
export const SVARA_INSUFFICIENT_ENTRY_BALANCE_TEXT = 'Нямаш достатъчно жълтици за входа на тази маса.'

const HOST_ATTRIBUTE = 'data-svara-insufficient-balance-notice'

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

export function resolveSvaraInsufficientBalanceNoticeTheme(): 'desktop' | 'mobile' {
  if (getMobileLightUiContext() !== null) return 'mobile'
  if (isPhoneLayoutViewport() && document.querySelector('[data-lobby-member-mobile-light="1"], [data-mobile-layout="1"]') !== null) return 'mobile'
  return 'desktop'
}

function renderDesktopCard(text: string): string {
  return `
    <div data-svara-insufficient-balance-backdrop="1" style="position:absolute;inset:0;background:rgba(0,0,0,0.72);-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);"></div>
    <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:16px;pointer-events:none;overflow-y:auto;">
      <div data-svara-insufficient-balance-card="1" style="position:relative;pointer-events:auto;width:min(100%,440px);box-sizing:border-box;border-radius:8px;background:linear-gradient(180deg,rgba(32,32,32,0.98) 0%,rgba(8,8,8,0.99) 100%);border:2px solid rgba(212,165,32,0.72);box-shadow:0 34px 80px rgba(0,0,0,0.42);padding:24px 22px 22px;text-align:center;">
        <div aria-hidden="true" style="font-size:34px;line-height:1;margin-bottom:12px;">🪙</div>
        <div id="svara-insufficient-balance-title" style="font-size:19px;font-weight:900;color:#f4c95b;line-height:1.3;margin-bottom:12px;">Недостатъчно жълтици</div>
        <div data-svara-insufficient-balance-text="1" style="font-size:15px;font-weight:700;color:#f8fafc;line-height:1.55;margin-bottom:22px;">${escapeHtml(text)}</div>
        <div style="display:flex;justify-content:center;gap:12px;flex-wrap:wrap;">
          <button type="button" data-svara-insufficient-balance-cancel="1" style="min-height:44px;min-width:130px;padding:0 22px;border:1px solid rgba(212,165,32,0.62);border-radius:8px;background:#080808;color:#f8fafc;font-size:15px;font-weight:900;cursor:pointer;font-family:inherit;">Отказ</button>
          <button type="button" data-svara-insufficient-balance-topup="1" style="min-height:44px;min-width:130px;padding:0 22px;border:0;border-radius:8px;background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;font-size:15px;font-weight:900;cursor:pointer;font-family:inherit;">Зареди</button>
        </div>
      </div>
    </div>
  `
}

function renderMobileCard(text: string): string {
  return `
    <div data-svara-insufficient-balance-backdrop="1" style="position:absolute;inset:0;background:rgba(16,24,40,0.45);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);"></div>
    <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;pointer-events:none;overflow-y:auto;">
      <div data-svara-insufficient-balance-card="1" style="position:relative;pointer-events:auto;width:min(100%,400px);box-sizing:border-box;max-height:calc(100dvh - 32px);overflow-y:auto;overscroll-behavior:contain;border-radius:16px;border:1px solid #E4E7EC;background:#FFFFFF;box-shadow:0 20px 48px rgba(16,24,40,0.18);padding:24px 20px 20px;text-align:center;">
        <div aria-hidden="true" style="width:60px;height:60px;margin:0 auto 14px;border-radius:999px;background:#F4F0FF;border:1px solid #D9CCFF;display:flex;align-items:center;justify-content:center;font-size:30px;line-height:1;">🪙</div>
        <div id="svara-insufficient-balance-title" style="font-size:20px;font-weight:800;color:#17233C;line-height:1.3;margin-bottom:10px;">Недостатъчно жълтици</div>
        <div data-svara-insufficient-balance-text="1" style="font-size:15px;font-weight:600;color:#475467;line-height:1.5;margin-bottom:20px;overflow-wrap:anywhere;">${escapeHtml(text)}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
          <button type="button" data-svara-insufficient-balance-cancel="1" style="height:46px;padding:0 12px;border:1px solid #D0D5DD;border-radius:8px;background:#FFFFFF;color:#344054;font-family:inherit;font-size:15px;font-weight:800;cursor:pointer;">Отказ</button>
          <button type="button" class="lobby-violet-btn ${VIOLET_3D_BUTTON_CLASS}" data-svara-insufficient-balance-topup="1" style="height:46px;padding:0 12px;border:0;border-radius:8px;color:#FFFFFF;font-family:inherit;font-size:15px;font-weight:900;cursor:pointer;">Зареди</button>
        </div>
      </div>
    </div>
  `
}

export function closeSvaraInsufficientBalanceNotice(): void {
  document.querySelectorAll(`[${HOST_ATTRIBUTE}="1"]`).forEach((element) => element.remove())
}

export function showSvaraInsufficientBalanceNotice(input: { text?: string | null; onTopUp: () => void }): void {
  closeSvaraInsufficientBalanceNotice()
  const text = input.text?.trim() || SVARA_INSUFFICIENT_ENTRY_BALANCE_TEXT
  const theme = resolveSvaraInsufficientBalanceNoticeTheme()
  if (theme === 'mobile') ensureViolet3dButtonStyles()

  const host = document.createElement('div')
  host.setAttribute(HOST_ATTRIBUTE, '1')
  host.setAttribute('data-svara-insufficient-balance-theme', theme)
  host.setAttribute('role', 'alertdialog')
  host.setAttribute('aria-modal', 'true')
  host.setAttribute('aria-labelledby', 'svara-insufficient-balance-title')
  host.style.cssText = `position:fixed;inset:0;z-index:100001;pointer-events:auto;font-family:${theme === 'mobile' ? MOBILE_LIGHT_FONT_FAMILY : 'Arial,Helvetica,sans-serif'};`
  host.innerHTML = theme === 'mobile' ? renderMobileCard(text) : renderDesktopCard(text)

  const onKeydown = (event: KeyboardEvent): void => { if (event.key === 'Escape') close() }
  function close(): void {
    document.removeEventListener('keydown', onKeydown)
    host.remove()
  }
  host.querySelector('[data-svara-insufficient-balance-cancel="1"]')?.addEventListener('click', (event) => { event.stopPropagation(); close() })
  host.querySelector('[data-svara-insufficient-balance-backdrop="1"]')?.addEventListener('click', (event) => { event.stopPropagation(); close() })
  host.querySelector('[data-svara-insufficient-balance-topup="1"]')?.addEventListener('click', (event) => {
    event.stopPropagation()
    close()
    input.onTopUp()
  })
  // Кликовете вътре не стигат до document-level „click outside“ handler-ите отдолу.
  host.addEventListener('click', (event) => event.stopPropagation())
  document.addEventListener('keydown', onKeydown)

  document.body.appendChild(host)
  host.querySelector<HTMLButtonElement>('[data-svara-insufficient-balance-topup="1"]')?.focus()
}
