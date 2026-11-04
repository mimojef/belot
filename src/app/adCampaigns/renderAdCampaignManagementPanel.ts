import type { AdCampaignManagementDto } from '../network/createGameServerClient'
import { renderAdCampaignThumbnailPreview, attachAdCampaignThumbnailPreviewHandlers } from './renderAdCampaignThumbnailPreview'
import { VIOLET_3D_BUTTON_CLASS } from '../../ui/layout/violet3dButton'

export type AdCampaignManagementState = {
  isAdCampaignManager: boolean
  loading: boolean
  errorText: string | null
  rows: AdCampaignManagementDto[]
  createBusy: boolean
  createErrorText: string | null
  actionBusy: boolean
  deleteConfirmCampaignId: string | null
  /** Management-only preview (виж renderAdCampaignThumbnailPreview.ts) — само imageUrl, никаква receipt/click семантика. */
  previewImageUrl: string | null
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function fmtDate(value: string | null): string {
  if (value === null) return '-'
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return value
  return date.toLocaleString('bg-BG', { dateStyle: 'short', timeStyle: 'short' })
}

// Светъл мобилен вариант (само телефон, в общата светла рамка на лобито):
// бели карти върху общия фон, виолетов 3D бутон (.lobby-violet-btn) за
// "Създай", светли вторични бутони. Полетата, текстовете и data-* атрибутите
// са същите като в тъмния вариант.
const LIGHT_CARD_STYLE = 'box-sizing:border-box;min-width:0;background:#FFFFFF;border:1px solid #E4E7EC;border-radius:12px;box-shadow:0 6px 18px rgba(34,30,80,0.07);'
const LIGHT_SECONDARY_BUTTON_STYLE = 'min-height:40px;border:1px solid #D0D5DD;border-radius:8px;background:#FFFFFF;color:#6941C6;padding:0 14px;font-family:inherit;font-size:14px;font-weight:800;cursor:pointer;'
const LIGHT_NEUTRAL_BUTTON_STYLE = 'min-height:40px;border:1px solid #D0D5DD;border-radius:8px;background:#FFFFFF;color:#344054;padding:0 14px;font-family:inherit;font-size:14px;font-weight:800;cursor:pointer;'
const LIGHT_DANGER_SECONDARY_BUTTON_STYLE = 'min-height:40px;border:1px solid #FECDCA;border-radius:8px;background:#FFFFFF;color:#B42318;padding:0 14px;font-family:inherit;font-size:14px;font-weight:800;cursor:pointer;'
const LIGHT_DANGER_BUTTON_STYLE = 'min-height:40px;border:0;border-radius:8px;background:#D92D20;color:#FFFFFF;padding:0 14px;font-family:inherit;font-size:14px;font-weight:800;cursor:pointer;'
const LIGHT_ERROR_BOX_STYLE = 'padding:9px 12px;border:1px solid #FECDCA;background:#FEF3F2;border-radius:8px;color:#B42318;font-size:13px;font-weight:700;line-height:1.4;overflow-wrap:anywhere;'
const LIGHT_INPUT_STYLE = 'width:100%;height:44px;box-sizing:border-box;padding:0 12px;background:#FFFFFF;border:1px solid #D0D5DD;border-radius:8px;color:#111827;font-family:inherit;font-size:16px;color-scheme:light;'
const LIGHT_EMPTY_BOX_STYLE = 'padding:18px 12px;border:1px dashed #D0D5DD;border-radius:12px;background:#FFFFFF;text-align:center;font-size:14px;font-weight:600;line-height:1.45;color:#667085;'

function lightShell(body: string): string {
  return `
    <section data-ad-campaigns-light="1" style="color:#17233C;">
      <style>
        [data-ad-campaigns-light="1"] input[type="file"] {
          width:100%;max-width:100%;box-sizing:border-box;padding:6px;border:1px dashed #D0D5DD;border-radius:8px;
          background:#F9FAFB;color:#475467;font-family:inherit;font-size:13px;color-scheme:light;
        }
        [data-ad-campaigns-light="1"] input[type="file"]::file-selector-button {
          margin-right:10px;height:34px;padding:0 12px;border:1px solid #D0D5DD;border-radius:8px;
          background:#FFFFFF;color:#6941C6;font-family:inherit;font-size:13px;font-weight:800;cursor:pointer;
        }
        [data-ad-campaigns-light="1"] button:disabled { opacity:0.6;cursor:default; }
      </style>
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px;">
        <h1 style="font-size:22px;line-height:1.2;margin:0;font-weight:800;color:#17233C;">Реклами</h1>
        <button type="button" data-ad-campaigns-back="1" style="${LIGHT_NEUTRAL_BUTTON_STYLE}">Назад</button>
      </div>
      ${body}
    </section>
  `
}

function renderLightCampaignRow(row: AdCampaignManagementDto, state: AdCampaignManagementState): string {
  const creatorLabel = row.createdByDisplayName ?? '— (изтрит профил)'
  const isConfirmingDelete = state.deleteConfirmCampaignId === row.campaignId

  return `
    <div style="${LIGHT_CARD_STYLE}display:flex;gap:12px;padding:12px;flex-wrap:wrap;">
      <button type="button" data-ad-campaign-thumbnail-preview-open="${escapeHtml(row.imageUrl)}" title="Преглед на изображението" aria-label="Преглед на изображението" style="width:120px;height:80px;flex-shrink:0;border:1px solid #EAECF0;padding:0;background:#F2F4F7;border-radius:8px;cursor:pointer;overflow:hidden;line-height:0;">
        <img src="${escapeHtml(row.imageUrl)}" alt="" style="width:100%;height:100%;object-fit:cover;pointer-events:none;">
      </button>
      <div style="flex:1 1 150px;min-width:0;display:flex;flex-direction:column;gap:4px;">
        <span style="font-size:13px;font-weight:700;color:${row.targetUrl === null ? '#98A2B3' : '#17233C'};overflow-wrap:anywhere;">${row.targetUrl === null ? 'Без линк' : escapeHtml(row.targetUrl)}</span>
        <span style="font-size:12px;line-height:1.4;color:#667085;overflow-wrap:anywhere;">Създадена: ${fmtDate(row.createdAt)} · ${escapeHtml(creatorLabel)} (${escapeHtml(row.createdByRole)})</span>
        <span style="font-size:12px;line-height:1.4;color:#667085;">Изпращания: ${row.dispatchCount}${row.lastDispatchAt ? ` · последно: ${fmtDate(row.lastDispatchAt)}` : ''}</span>
      </div>
      <div style="flex:1 1 100%;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        ${isConfirmingDelete ? `
          <span style="flex:1 1 100%;font-size:13px;line-height:1.4;color:#B42318;font-weight:700;">Сигурни ли сте? Всички чакащи показвания ще бъдат отменени.</span>
          <button type="button" data-ad-campaign-delete-confirm="${escapeHtml(row.campaignId)}" ${state.actionBusy ? 'disabled' : ''} style="${LIGHT_DANGER_BUTTON_STYLE}">Изтрий</button>
          <button type="button" data-ad-campaign-delete-dismiss="1" style="${LIGHT_NEUTRAL_BUTTON_STYLE}">Отказ</button>
        ` : `
          <button type="button" data-ad-campaign-send="${escapeHtml(row.campaignId)}" ${state.actionBusy ? 'disabled' : ''} style="${LIGHT_SECONDARY_BUTTON_STYLE}">Изпрати</button>
          <button type="button" data-ad-campaign-delete-request="${escapeHtml(row.campaignId)}" ${state.actionBusy ? 'disabled' : ''} style="${LIGHT_DANGER_SECONDARY_BUTTON_STYLE}">Изтрий кампания</button>
        `}
      </div>
    </div>
  `
}

function renderLightAdCampaignManagementPanel(state: AdCampaignManagementState): string {
  if (!state.isAdCampaignManager) {
    return lightShell(`<div style="${LIGHT_ERROR_BOX_STYLE}">Нямаш достъп.</div>`)
  }

  const rowsHtml = state.rows.map((row) => renderLightCampaignRow(row, state)).join('')

  return lightShell(`
    <form data-ad-campaign-create-form="1" style="${LIGHT_CARD_STYLE}display:flex;flex-direction:column;gap:12px;padding:14px;margin-bottom:14px;">
      <strong style="font-size:16px;font-weight:800;color:#17233C;">+ Създай реклама</strong>
      <input type="file" accept="image/png,image/jpeg,image/webp" data-ad-campaign-create-image="1">
      <label style="display:flex;flex-direction:column;gap:6px;">
        <span style="font-size:13px;font-weight:700;color:#344054;">Линк (по желание)</span>
        <input type="text" name="targetUrl" placeholder="/tournaments или https://pika.bg/tournaments" maxlength="2048" style="${LIGHT_INPUT_STYLE}">
      </label>
      ${state.createErrorText ? `<div style="${LIGHT_ERROR_BOX_STYLE}">${escapeHtml(state.createErrorText)}</div>` : ''}
      <button type="submit" class="lobby-violet-btn ${VIOLET_3D_BUTTON_CLASS}" ${state.createBusy ? 'disabled' : ''} style="min-height:44px;border:0;border-radius:8px;color:#FFFFFF;font-family:inherit;font-size:15px;font-weight:800;cursor:pointer;align-self:flex-start;padding:0 22px;">${state.createBusy ? 'Качване...' : 'Създай'}</button>
    </form>
    ${state.loading ? '<div style="padding:16px 4px;color:#6941C6;font-size:14px;font-weight:800;">Зареждане...</div>' : ''}
    ${state.errorText ? `<div style="${LIGHT_ERROR_BOX_STYLE}margin-bottom:12px;">${escapeHtml(state.errorText)}</div>` : ''}
    <div style="display:flex;flex-direction:column;gap:10px;">${rowsHtml || `<div style="${LIGHT_EMPTY_BOX_STYLE}">Няма рекламни кампании.</div>`}</div>
    ${renderAdCampaignThumbnailPreview(state.previewImageUrl)}
  `)
}

function shell(body: string): string {
  return `
    <section style="min-height:620px;background:#050505;color:#f5f5f5;padding:20px;border:1px solid rgba(255,255,255,0.08);border-radius:8px;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:18px;">
        <h1 style="font-size:24px;line-height:1.2;margin:0;font-weight:900;">Реклами</h1>
        <button type="button" data-ad-campaigns-back="1" style="min-height:38px;border:1px solid rgba(255,255,255,0.18);background:#111;color:#fff;border-radius:6px;padding:0 12px;font-weight:800;cursor:pointer;">Назад</button>
      </div>
      ${body}
    </section>
  `
}

function renderCampaignRow(row: AdCampaignManagementDto, state: AdCampaignManagementState): string {
  const creatorLabel = row.createdByDisplayName ?? '— (изтрит профил)'
  const isConfirmingDelete = state.deleteConfirmCampaignId === row.campaignId

  return `
    <div style="display:flex;gap:14px;background:#0d0d0d;border:1px solid rgba(255,255,255,0.10);border-radius:8px;padding:12px;flex-wrap:wrap;">
      <button type="button" data-ad-campaign-thumbnail-preview-open="${escapeHtml(row.imageUrl)}" title="Преглед на изображението" aria-label="Преглед на изображението" style="width:120px;height:80px;flex-shrink:0;border:0;padding:0;background:none;border-radius:6px;cursor:pointer;overflow:hidden;line-height:0;"
        onmouseenter="this.style.opacity='0.82'" onmouseleave="this.style.opacity='1'"
      >
        <img src="${escapeHtml(row.imageUrl)}" alt="" style="width:120px;height:80px;object-fit:cover;background:#000;pointer-events:none;">
      </button>
      <div style="flex:1;min-width:220px;display:flex;flex-direction:column;gap:4px;">
        <span style="font-size:13px;color:${row.targetUrl === null ? '#71717a' : '#d4d4d8'};overflow-wrap:anywhere;">${row.targetUrl === null ? 'Без линк' : escapeHtml(row.targetUrl)}</span>
        <span style="font-size:12px;color:#a3a3a3;">Създадена: ${fmtDate(row.createdAt)} · ${escapeHtml(creatorLabel)} (${escapeHtml(row.createdByRole)})</span>
        <span style="font-size:12px;color:#a3a3a3;">Изпращания: ${row.dispatchCount}${row.lastDispatchAt ? ` · последно: ${fmtDate(row.lastDispatchAt)}` : ''}</span>
      </div>
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        ${isConfirmingDelete ? `
          <span style="font-size:12px;color:#fca5a5;font-weight:800;">Сигурни ли сте? Всички чакащи показвания ще бъдат отменени.</span>
          <button type="button" data-ad-campaign-delete-confirm="${escapeHtml(row.campaignId)}" ${state.actionBusy ? 'disabled' : ''} style="min-height:34px;border:0;background:#dc2626;color:#fff;border-radius:6px;padding:0 12px;font-weight:900;cursor:pointer;">Изтрий</button>
          <button type="button" data-ad-campaign-delete-dismiss="1" style="min-height:34px;border:1px solid rgba(255,255,255,.2);background:#181818;color:#fff;border-radius:6px;padding:0 12px;cursor:pointer;">Отказ</button>
        ` : `
          <button type="button" data-ad-campaign-send="${escapeHtml(row.campaignId)}" ${state.actionBusy ? 'disabled' : ''} style="min-height:34px;border:0;background:#d4a520;color:#080808;border-radius:6px;padding:0 12px;font-weight:900;cursor:pointer;">Изпрати</button>
          <button type="button" data-ad-campaign-delete-request="${escapeHtml(row.campaignId)}" ${state.actionBusy ? 'disabled' : ''} style="min-height:34px;border:1px solid rgba(239,68,68,.5);background:#181818;color:#fca5a5;border-radius:6px;padding:0 12px;font-weight:800;cursor:pointer;">Изтрий кампания</button>
        `}
      </div>
    </div>
  `
}

export function renderAdCampaignManagementPanel(state: AdCampaignManagementState, light = false): string {
  if (light) {
    return renderLightAdCampaignManagementPanel(state)
  }
  if (!state.isAdCampaignManager) {
    return shell('<div style="color:#fecaca;font-weight:800;">Нямаш достъп.</div>')
  }

  const rowsHtml = state.rows.map((row) => renderCampaignRow(row, state)).join('')

  return shell(`
    <form data-ad-campaign-create-form="1" style="display:flex;flex-direction:column;gap:10px;background:#0d0d0d;border:1px solid rgba(255,255,255,0.10);border-radius:8px;padding:14px;margin-bottom:18px;">
      <strong style="font-size:15px;">+ Създай реклама</strong>
      <input type="file" accept="image/png,image/jpeg,image/webp" data-ad-campaign-create-image="1" style="color:#d4d4d8;">
      <label style="display:flex;flex-direction:column;gap:4px;">
        <span style="font-size:12px;color:#a3a3a3;">Линк (по желание)</span>
        <input type="text" name="targetUrl" placeholder="/tournaments или https://pika.bg/tournaments" maxlength="2048" style="min-height:38px;background:#090909;border:1px solid rgba(255,255,255,0.14);border-radius:6px;color:#fff;padding:0 10px;">
      </label>
      ${state.createErrorText ? `<div style="color:#fecaca;font-weight:700;font-size:13px;">${escapeHtml(state.createErrorText)}</div>` : ''}
      <button type="submit" ${state.createBusy ? 'disabled' : ''} style="min-height:38px;border:0;background:#d4a520;color:#080808;border-radius:6px;font-weight:900;cursor:pointer;align-self:flex-start;padding:0 16px;">${state.createBusy ? 'Качване...' : 'Създай'}</button>
    </form>
    ${state.loading ? '<div style="padding:24px;color:#d4a520;font-weight:900;">Зареждане...</div>' : ''}
    ${state.errorText ? `<div style="padding:12px;border:1px solid #7f1d1d;color:#fecaca;border-radius:8px;margin-bottom:12px;">${escapeHtml(state.errorText)}</div>` : ''}
    <div style="display:flex;flex-direction:column;gap:8px;">${rowsHtml || '<div style="color:#a3a3a3;">Няма рекламни кампании.</div>'}</div>
    ${renderAdCampaignThumbnailPreview(state.previewImageUrl)}
  `)
}

export function attachAdCampaignManagementPanelHandlers(root: HTMLElement, handlers: {
  onBack: () => void
  onCreate: (input: { imageDataUrl: string; targetUrl: string }) => void
  onSend: (campaignId: string) => void
  onDeleteRequest: (campaignId: string) => void
  onDeleteConfirm: () => void
  onDeleteDismiss: () => void
  onThumbnailPreviewOpen: (imageUrl: string) => void
  onThumbnailPreviewClose: () => void
}): void {
  root.querySelector<HTMLButtonElement>('[data-ad-campaigns-back="1"]')?.addEventListener('click', handlers.onBack)

  root.querySelector<HTMLFormElement>('[data-ad-campaign-create-form="1"]')?.addEventListener('submit', (event) => {
    event.preventDefault()
    const form = event.currentTarget as HTMLFormElement
    const fileInput = form.querySelector<HTMLInputElement>('[data-ad-campaign-create-image="1"]')
    const targetUrl = String(new FormData(form).get('targetUrl') ?? '').trim()
    const file = fileInput?.files?.[0] ?? null

    // targetUrl е optional — само изображението е задължително. Празен string
    // се праща както си е; сървърът (normalizeAdCampaignTargetUrl) го третира
    // като "без target", не като грешка.
    if (!file) {
      return
    }

    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        handlers.onCreate({ imageDataUrl: reader.result, targetUrl })
      }
    }
    reader.readAsDataURL(file)
  })

  root.querySelectorAll<HTMLButtonElement>('[data-ad-campaign-send]').forEach((button) => {
    button.addEventListener('click', () => handlers.onSend(button.dataset.adCampaignSend ?? ''))
  })
  root.querySelectorAll<HTMLButtonElement>('[data-ad-campaign-delete-request]').forEach((button) => {
    button.addEventListener('click', () => handlers.onDeleteRequest(button.dataset.adCampaignDeleteRequest ?? ''))
  })
  root.querySelectorAll<HTMLButtonElement>('[data-ad-campaign-delete-confirm]').forEach((button) => {
    button.addEventListener('click', handlers.onDeleteConfirm)
  })
  root.querySelectorAll<HTMLButtonElement>('[data-ad-campaign-delete-dismiss]').forEach((button) => {
    button.addEventListener('click', handlers.onDeleteDismiss)
  })

  // Thumbnail click -> management-only preview (виж §"КРИТИЧНО" в брифа: НЕ
  // send/dismiss/click receipt, само локален visual toggle).
  root.querySelectorAll<HTMLButtonElement>('[data-ad-campaign-thumbnail-preview-open]').forEach((button) => {
    button.addEventListener('click', () => {
      const imageUrl = button.dataset.adCampaignThumbnailPreviewOpen
      if (imageUrl) handlers.onThumbnailPreviewOpen(imageUrl)
    })
  })

  attachAdCampaignThumbnailPreviewHandlers(root, {
    onClose: handlers.onThumbnailPreviewClose,
  })
}
