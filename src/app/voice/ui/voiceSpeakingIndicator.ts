// Гласов чат — индикатор „говори“ (Етап 4, мобилно).
//
// Малко зелено микрофонче до аватара, видимо САМО докато участникът говори
// (задържането ~400 ms идва от controller-а). Без рамки, glow и постоянни
// индикатори. Без прерисуване: екраните рендерират празен slot
// `[data-voice-speaking-profile="<profileId>"]` (невидим), а видимостта се
// управлява от ЕДИН <style> елемент, чието съдържание се сменя при промяна на
// говорещите — нов innerHTML на екрана автоматично „наследява“ състоянието.

import { voiceIcon } from './voiceUiIcons'

const BASE_STYLE_ID = 'pika-voice-speaking-base'
const STATE_STYLE_ID = 'pika-voice-speaking-state'

let slotsEnabled = false

/** Слотовете се рендерират само на гласова маса (main.ts го задава синхронно от room_snapshot). */
export function setVoiceSpeakingSlotsEnabled(enabled: boolean): void {
  slotsEnabled = enabled
}

export function isVoiceSpeakingSlotsEnabled(): boolean {
  return slotsEnabled
}

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/**
 * Празен slot за индикатора. sizePx/insetPx са в координатите на родителя
 * (подайте вече компенсирани стойности при transform:scale на родителя).
 */
export function renderVoiceSpeakingSlot(
  profileId: string | null,
  options: { sizePx: number; insetPx: number; corner: 'top-left' | 'top-right'; zIndex?: number; iconRatio?: number; force?: boolean },
): string {
  if (profileId === null || (!slotsEnabled && options.force !== true)) return ''
  const iconSize = Math.round(options.sizePx * (options.iconRatio ?? 0.62) * 10) / 10
  const side = options.corner === 'top-left' ? 'left' : 'right'
  return `<span class="pika-voice-speaking" data-voice-speaking-profile="${escapeAttribute(profileId)}" aria-hidden="true" style="top:${options.insetPx}px;${side}:${options.insetPx}px;width:${options.sizePx}px;height:${options.sizePx}px;z-index:${options.zIndex ?? 7};">${voiceIcon.speakingMic(iconSize)}</span>`
}

export function ensureVoiceSpeakingStyles(doc: Document = document): void {
  if (doc.getElementById(BASE_STYLE_ID) !== null) return
  const style = doc.createElement('style')
  style.id = BASE_STYLE_ID
  style.textContent = `
    .pika-voice-speaking {
      position:absolute;
      display:flex;
      align-items:center;
      justify-content:center;
      box-sizing:border-box;
      border-radius:999px;
      background:#22C55E;
      color:#FFFFFF;
      opacity:0;
      transform:scale(0.8);
      transition:opacity 120ms ease, transform 120ms ease;
      pointer-events:none;
    }
    .pika-voice-speaking svg { display:block; }
  `
  doc.head.appendChild(style)
}

/** Единствената DOM промяна при смяна на говорещите — текстът на един <style>. */
export function applyVoiceSpeakingProfiles(profileIds: readonly string[], doc: Document = document): void {
  let style = doc.getElementById(STATE_STYLE_ID)
  if (style === null) {
    style = doc.createElement('style')
    style.id = STATE_STYLE_ID
    doc.head.appendChild(style)
  }
  const css = profileIds.length === 0
    ? ''
    : `${profileIds.map((id) => `.pika-voice-speaking[data-voice-speaking-profile="${id.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"]`).join(',')}{opacity:1;transform:none;}`
  if (style.textContent !== css) style.textContent = css
}
