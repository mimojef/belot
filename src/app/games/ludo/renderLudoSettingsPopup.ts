// Ludo "Настройки" popup — reuse-ва СЪЩИЯ modal pattern като
// renderLudoExitConfirmPopup.ts (fixed backdrop + centered card, местен
// LUDO_MODAL_BACKDROP_LOCAL_Z_INDEX, внутре в modalLayerRoot). Съдържа
// двете sound preference toggle-и (виж task-а "Ludo sound settings") —
// custom големи квадратни ✓/✕ controls, НЕ browser checkbox-и. Играта
// продължава нормално server-side, докато popup-ът е отворен — тук няма
// никаква turn/dice логика, чисто presentation.

import { LUDO_MODAL_BACKDROP_LOCAL_Z_INDEX } from './ludoLayerHierarchy'
import { isLudoDiceSoundEnabled, isLudoGameSoundsEnabled } from './ludoSoundSettings'

// Голям, ясно видим quadrat toggle — достатъчно голям и за mobile (56px,
// над обичайния ~44px touch-target минимум). ON: зелена рамка/фон + ✓.
// OFF: червена рамка/фон + ✕. Кликваем навсякъде в квадрата (целият бутон
// е click target-а, не само символа).
function renderLudoSettingsToggle(key: 'gameSounds' | 'dice', enabled: boolean): string {
  const onColor = '#22c55e'
  const offColor = '#ef4444'
  const color = enabled ? onColor : offColor
  return `
    <button
      type="button"
      data-ludo-settings-toggle="${key}"
      aria-pressed="${enabled ? 'true' : 'false'}"
      style="
        width:56px; height:56px; flex-shrink:0;
        border-radius:14px;
        border:2px solid ${color};
        background:${enabled ? 'rgba(34,197,94,0.16)' : 'rgba(239,68,68,0.16)'};
        color:${color};
        display:flex; align-items:center; justify-content:center;
        font-size:32px; font-weight:900; line-height:1;
        cursor:pointer;
        transition:background 140ms ease, border-color 140ms ease, color 140ms ease;
      "
    >${enabled ? '&#10003;' : '&#10005;'}</button>
  `
}

function renderLudoSettingsRow(key: 'gameSounds' | 'dice', label: string, enabled: boolean): string {
  return `
    <div data-ludo-settings-row="${key}" style="
      display:flex; align-items:center; justify-content:space-between;
      gap:14px; padding:12px 0;
      border-bottom:1px solid rgba(255,255,255,0.08);
    ">
      <span style="font-size:15px; font-weight:700; color:#f4f8ff; text-align:left;">${label}</span>
      ${renderLudoSettingsToggle(key, enabled)}
    </div>
  `
}

export function renderLudoSettingsPopup(): string {
  return `
    <div data-ludo-settings-backdrop="1" style="
      position:fixed; inset:0; z-index:${LUDO_MODAL_BACKDROP_LOCAL_Z_INDEX};
      background:rgba(2,6,23,0.68);
      display:flex; align-items:center; justify-content:center;
      padding:16px; box-sizing:border-box;
    ">
      <div role="dialog" aria-modal="true" aria-labelledby="ludo-settings-title" style="
        position:relative;
        width:min(360px, 100%);
        background:rgba(15,23,42,0.98);
        border:1px solid rgba(212,165,32,0.4);
        border-radius:20px;
        padding:22px 20px 18px;
        box-shadow:0 20px 60px rgba(0,0,0,0.55);
        box-sizing:border-box;
      ">
        <button type="button" data-ludo-settings-close="1" aria-label="Затвори" style="
          position:absolute; top:12px; right:12px;
          width:32px; height:32px;
          border:0; border-radius:8px;
          background:rgba(255,255,255,0.06);
          color:rgba(255,255,255,0.7);
          font-size:18px; font-weight:700; line-height:1;
          cursor:pointer;
        ">&times;</button>
        <div id="ludo-settings-title" style="color:#f4f8ff; font-size:18px; font-weight:800; margin-bottom:6px; padding-right:32px;">
          Настройки
        </div>
        <div>
          ${renderLudoSettingsRow('gameSounds', 'Звуци в играта', isLudoGameSoundsEnabled())}
          ${renderLudoSettingsRow('dice', 'Звук на зара', isLudoDiceSoundEnabled())}
        </div>
      </div>
    </div>
  `
}
