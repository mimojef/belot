// "Персонализация на профила", Етап 3 — ЕДИН общ визуален преглед (не по
// отделен блок за Лафче/Теми/лични чатове). Ползва се в прозореца
// "Персонализация" и в попъпа след успешно плащане:
//
//        🦋 МоятНик 🦋
//     Цвят на текст за писане
//    Здравейте на всички! 😊
//
// Комбинира ВСИЧКИ подадени стойности (активните + избраното в момента).
// Цвят на ника: служебният #F72585 (pika_team/marketing) има приоритет, после
// закупеният, иначе стандартният за интерфейса (бял на тъмния десктоп, черен
// на светлия мобилен). Текстът: закупеният цвят или стандартният на
// интерфейса. Всичко е escape-нато; цветовете се валидират.

import { DEFAULT_NICKNAME_COLOR_DARK, DEFAULT_NICKNAME_COLOR_LIGHT } from './customizationDisplay'

export const UNIFIED_PREVIEW_TEXT_LABEL = 'Цвят на текст за писане'
export const UNIFIED_PREVIEW_SAMPLE_MESSAGE = 'Здравейте на всички! 😊'

/** Стандартният цвят на текста в Лафче/Теми за съответния интерфейс. */
const DEFAULT_MESSAGE_COLOR_DARK = '#e2e8f0'
const DEFAULT_MESSAGE_COLOR_LIGHT = '#111827'

export type UnifiedPreviewValues = {
  displayName: string
  theme: 'dark' | 'light'
  /** Служебен цвят (pika_team/marketing) — приоритет пред закупения. */
  staffNicknameColor: string | null
  nicknameColor: string | null
  messageColor: string | null
  emojiBefore: string | null
  emojiAfter: string | null
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function safeHex(value: string | null): string | null {
  return value !== null && /^#[0-9A-Fa-f]{6}$/.test(value) ? value : null
}

export function renderUnifiedCustomizationPreview(values: UnifiedPreviewValues): string {
  const light = values.theme === 'light'
  const nameColor = safeHex(values.staffNicknameColor)
    ?? safeHex(values.nicknameColor)
    ?? (light ? DEFAULT_NICKNAME_COLOR_LIGHT : DEFAULT_NICKNAME_COLOR_DARK)
  const messageColor = safeHex(values.messageColor) ?? (light ? DEFAULT_MESSAGE_COLOR_LIGHT : DEFAULT_MESSAGE_COLOR_DARK)
  const background = light ? '#FFFFFF' : '#121212'
  const border = light ? '#EAECF0' : 'rgba(255,255,255,0.12)'
  const labelColor = light ? '#667085' : 'rgba(226,232,240,0.6)'
  const before = values.emojiBefore !== null ? `<span data-pc-preview-before="1" aria-hidden="true">${escapeHtml(values.emojiBefore)}</span> ` : ''
  const after = values.emojiAfter !== null ? ` <span data-pc-preview-after="1" aria-hidden="true">${escapeHtml(values.emojiAfter)}</span>` : ''
  return `
    <div data-pc-unified-preview="1" data-pc-preview-theme="${values.theme}" style="border-radius:10px;border:1px solid ${border};background:${background};padding:16px 14px;text-align:center;">
      <div style="font-size:20px;font-weight:900;line-height:1.3;overflow-wrap:anywhere;">${before}<span data-pc-preview-name="1" style="color:${nameColor};">${escapeHtml(values.displayName)}</span>${after}</div>
      <div data-pc-preview-label="1" style="margin-top:10px;font-size:11px;letter-spacing:0.05em;text-transform:uppercase;color:${labelColor};">${escapeHtml(UNIFIED_PREVIEW_TEXT_LABEL)}</div>
      <div data-pc-preview-message="1" style="margin-top:4px;font-size:16px;line-height:1.45;color:${messageColor};overflow-wrap:anywhere;">${escapeHtml(UNIFIED_PREVIEW_SAMPLE_MESSAGE)}</div>
    </div>`
}
