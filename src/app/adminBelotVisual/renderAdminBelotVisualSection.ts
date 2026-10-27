import { renderThemeAssetWidget } from '../adminCampaigns/renderThemeAssetWidget'

// "Визия на Белот" (Admin → основен панел) — ръчна приоритетна визия на
// Белот масата. Сървърът е authority (GET/PATCH /api/admin/belot-visual);
// тук е само формата. Приоритетът се разрешава на сървъра (resolveBelotVisual).

export type AdminBelotVisualAssetKind = 'table_bg_desktop' | 'table_bg_mobile' | 'card_back'

export type AdminBelotVisualSnapshot = {
  enabled: boolean
  tableBgDesktopUrl: string | null
  tableBgMobileUrl: string | null
  cardBackUrl: string | null
}

export type AdminBelotVisualResult =
  | { ok: true; visual: AdminBelotVisualSnapshot }
  | { ok: false; message: string }

export type AdminBelotVisualSectionState = {
  adminBelotVisual: AdminBelotVisualSnapshot | null
  adminBelotVisualLoading: boolean
  /** Заявка (превключване/качване/премахване) е в ход — контролите са неактивни. */
  adminBelotVisualBusy: boolean
  adminBelotVisualErrorText: string | null
  adminBelotVisualSuccessText: string | null
}

export type AdminBelotVisualHandlers = {
  onToggle: (enabled: boolean) => void
  onUpload: (kind: AdminBelotVisualAssetKind, imageDataUrl: string) => void
  onRemove: (kind: AdminBelotVisualAssetKind) => void
}

const DATA_PREFIX = 'admin-belot-visual'
const ACCEPT = 'image/png,image/jpeg,image/webp'

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function isAssetKind(value: unknown): value is AdminBelotVisualAssetKind {
  return value === 'table_bg_desktop' || value === 'table_bg_mobile' || value === 'card_back'
}

export function renderAdminBelotVisualSection(state: AdminBelotVisualSectionState, isMobile = false): string {
  const visual = state.adminBelotVisual
  const busy = state.adminBelotVisualBusy

  const body = state.adminBelotVisualLoading || visual === null
    ? `<div style="font-size:12px;font-weight:900;color:#d4a520;">${state.adminBelotVisualLoading ? 'Зареждане...' : ''}</div>`
    : `
      <label style="display:flex;align-items:center;gap:10px;cursor:${busy ? 'default' : 'pointer'};user-select:none;">
        <input type="checkbox" data-admin-belot-visual-toggle="1" ${visual.enabled ? 'checked' : ''} ${busy ? 'disabled' : ''} style="width:20px;height:20px;flex-shrink:0;accent-color:#d4a520;cursor:inherit;">
        <span style="font-size:14px;font-weight:900;color:#f8fafc;">Включи/Изключи приоритетната визия</span>
        <span data-admin-belot-visual-status="1" style="font-size:11px;font-weight:900;padding:2px 8px;border-radius:999px;${visual.enabled ? 'color:#86efac;background:rgba(6,60,40,0.5);border:1px solid rgba(52,211,153,0.35);' : 'color:rgba(255,255,255,0.55);background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.14);'}">${visual.enabled ? 'Включена' : 'Изключена'}</span>
      </label>
      <div style="display:flex;flex-wrap:wrap;gap:16px;${isMobile ? 'justify-content:flex-start;' : ''}">
        ${renderThemeAssetWidget({ dataPrefix: DATA_PREFIX, kind: 'table_bg_desktop', label: 'Маса — Desktop', url: visual.tableBgDesktopUrl, accept: ACCEPT, emptyLabel: 'Не е качена', disabled: busy })}
        ${renderThemeAssetWidget({ dataPrefix: DATA_PREFIX, kind: 'table_bg_mobile', label: 'Маса — Mobile', url: visual.tableBgMobileUrl, accept: ACCEPT, emptyLabel: 'Не е качена', disabled: busy })}
        ${renderThemeAssetWidget({ dataPrefix: DATA_PREFIX, kind: 'card_back', label: 'Гръб на картите', url: visual.cardBackUrl, accept: ACCEPT, emptyLabel: 'Не е качен', disabled: busy })}
      </div>
    `

  return `
    <section data-admin-belot-visual-section="1" style="border:1px solid rgba(212,165,32,0.28);border-radius:8px;background:#050505;padding:16px;display:grid;gap:14px;margin-top:8px;">
      <div>
        <div style="font-size:20px;line-height:1.1;font-weight:900;color:#f8fafc;">Визия на Белот</div>
        <div style="margin-top:6px;font-size:12px;font-weight:700;color:rgba(255,255,255,0.54);line-height:1.5;">
          При включена приоритетна визия качените тук изображения се показват на Белот масата вместо тези на активната кампания. Липсващо изображение се взема от кампанията или от стандартната визия. При изключване изображенията се пазят и се връщат при следващо включване. Промяната важи веднага за всички маси. PNG/JPEG/WebP до 10 MB — автоматично се оптимизират до WebP.
        </div>
      </div>
      ${body}
      ${state.adminBelotVisualErrorText ? `<div data-admin-belot-visual-error="1" style="border-radius:8px;border:1px solid rgba(248,113,113,0.28);background:rgba(127,29,29,0.42);padding:10px 12px;color:#fecaca;font-size:13px;font-weight:800;">${esc(state.adminBelotVisualErrorText)}</div>` : ''}
      ${state.adminBelotVisualSuccessText ? `<div data-admin-belot-visual-success="1" style="border-radius:8px;border:1px solid rgba(52,211,153,0.30);background:rgba(6,60,40,0.42);padding:10px 12px;color:#86efac;font-size:13px;font-weight:800;">${esc(state.adminBelotVisualSuccessText)}</div>` : ''}
    </section>
  `
}

export function attachAdminBelotVisualHandlers(root: HTMLElement, handlers: AdminBelotVisualHandlers): void {
  root.querySelector<HTMLInputElement>('[data-admin-belot-visual-toggle="1"]')?.addEventListener('change', (event) => {
    handlers.onToggle((event.currentTarget as HTMLInputElement).checked)
  })

  root.querySelectorAll<HTMLInputElement>(`[data-${DATA_PREFIX}-upload]`).forEach((input) => {
    input.addEventListener('change', () => {
      const kind = input.getAttribute(`data-${DATA_PREFIX}-upload`)
      const file = input.files?.[0] ?? null
      if (!isAssetKind(kind) || file === null) return
      const reader = new FileReader()
      reader.onload = () => {
        const dataUrl = typeof reader.result === 'string' ? reader.result : ''
        if (dataUrl) handlers.onUpload(kind, dataUrl)
      }
      reader.readAsDataURL(file)
    })
  })

  root.querySelectorAll<HTMLElement>(`[data-${DATA_PREFIX}-remove]`).forEach((button) => {
    button.addEventListener('click', () => {
      const kind = button.getAttribute(`data-${DATA_PREFIX}-remove`)
      if (!isAssetKind(kind)) return
      if (!confirm('Премахване на изображението?')) return
      handlers.onRemove(kind)
    })
  })
}
