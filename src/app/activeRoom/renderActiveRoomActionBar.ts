// Долни action бутони на активната Белот маса: "Изход" + ⚙️ "Настройки"
// икона вдясно от него (mobile лента и desktop долу вляво), и компактният
// "Настройки" panel, който ⚙️ отваря. ⚙️ е само икона — без фон/рамка, с
// невидима tap зона със същата височина като "Изход".
// Mobile: Изход (16..104px) + ⚙️ tap зона (112..152px) — далеч от
// фразите/емоджитата вдясно (right:64px/18px), включително при 360px.

import { ACTIVE_ROOM_MOBILE_BOTTOM_NAV_HEIGHT } from './activeRoomShared'

const MOBILE_ACTION_BUTTON_HEIGHT_PX = 40
const MOBILE_LEAVE_BUTTON_LEFT_PX = 16
const MOBILE_LEAVE_BUTTON_WIDTH_PX = 88
const MOBILE_ACTION_BUTTON_GAP_PX = 8
const MOBILE_SETTINGS_BUTTON_LEFT_PX =
  MOBILE_LEAVE_BUTTON_LEFT_PX + MOBILE_LEAVE_BUTTON_WIDTH_PX + MOBILE_ACTION_BUTTON_GAP_PX

// Desktop: височината на "Изход" е фиксирана на естествената ѝ досегашна
// стойност (padding 14px + 15px текст + border ≈ 52px); невидимата tap зона
// на ⚙️ е със същата височина, така че иконата е центрирана спрямо "Изход".
const DESKTOP_ACTION_BUTTON_HEIGHT_PX = 52
const DESKTOP_ACTION_LEFT_PX = 18
const DESKTOP_ACTION_BOTTOM_PX = 24
const DESKTOP_ACTION_BUTTON_GAP_PX = 6

export type ActiveRoomSettingsPanelPlacement = 'mobile' | 'desktop'

const MOBILE_SETTINGS_ICON_SIZE_PX = 22
const DESKTOP_SETTINGS_ICON_SIZE_PX = 26

// Hover/active/focus feedback само върху самата икона (scale + по-светъл
// цвят + мек glow) — бутонът няма фон, рамка или сянка в никое състояние.
const SETTINGS_ICON_BUTTON_STYLE = `
  <style data-active-room-settings-icon-style="1">
    [data-active-room-settings-button="1"] svg {
      display:block;
      transition:transform 140ms ease, color 140ms ease, filter 140ms ease;
    }
    @media (hover:hover) {
      [data-active-room-settings-button="1"]:hover svg {
        color:#ffe08a;
        transform:scale(1.1);
      }
    }
    [data-active-room-settings-button="1"]:active svg,
    [data-active-room-settings-button="1"][aria-expanded="true"] svg {
      color:#ffe08a;
      transform:scale(0.94);
    }
    [data-active-room-settings-button="1"]:focus-visible svg {
      filter:drop-shadow(0 0 4px rgba(246,211,107,0.85));
    }
  </style>
`

function renderSettingsIconButtonStyle(hitAreaPx: number): string {
  return `
    width:${hitAreaPx}px;
    height:${hitAreaPx}px;
    box-sizing:border-box;
    border:0;
    outline:0;
    border-radius:0;
    padding:0;
    margin:0;
    display:flex;
    align-items:center;
    justify-content:center;
    background:transparent;
    box-shadow:none;
    color:#f6d36b;
    cursor:pointer;
    -webkit-tap-highlight-color:transparent;
    -webkit-appearance:none;
    appearance:none;
  `
}

function renderGearIconSvg(sizePx: number): string {
  return GEAR_ICON_SVG.replace('width="20" height="20"', `width="${sizePx}" height="${sizePx}"`)
}

const GEAR_ICON_SVG = `
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="3"></circle>
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
  </svg>
`

export function renderActiveRoomMobileActionBar(): string {
  return `
    <div
      data-active-room-mobile-action-bar="1"
      style="
        position:fixed;
        left:0;
        right:0;
        bottom:0;
        z-index:9399;
        height:${ACTIVE_ROOM_MOBILE_BOTTOM_NAV_HEIGHT}px;
        background:#000000;
        pointer-events:none;
      "
    >
      <button
        type="button"
        data-active-room-leave-button="1"
        title="Напусни масата"
        style="
          position:absolute;
          left:${MOBILE_LEAVE_BUTTON_LEFT_PX}px;
          top:50%;
          transform:translateY(-50%);
          height:${MOBILE_ACTION_BUTTON_HEIGHT_PX}px;
          width:${MOBILE_LEAVE_BUTTON_WIDTH_PX}px;
          border:0;
          border-radius:8px;
          padding:0 12px;
          background:linear-gradient(180deg, #f6d36b 0%, #c98b1a 100%);
          color:#171717;
          font-size:14px;
          font-weight:900;
          cursor:pointer;
          box-shadow:0 10px 22px rgba(0,0,0,0.30);
          pointer-events:auto;
        "
      >
        Изход
      </button>
      <button
        type="button"
        data-active-room-settings-button="1"
        title="Настройки"
        aria-label="Настройки"
        aria-haspopup="dialog"
        aria-expanded="false"
        style="
          position:absolute;
          left:${MOBILE_SETTINGS_BUTTON_LEFT_PX}px;
          top:50%;
          transform:translateY(-50%);
          ${renderSettingsIconButtonStyle(MOBILE_ACTION_BUTTON_HEIGHT_PX)}
          pointer-events:auto;
        "
      >
        ${renderGearIconSvg(MOBILE_SETTINGS_ICON_SIZE_PX)}
      </button>
      ${SETTINGS_ICON_BUTTON_STYLE}
    </div>
  `
}

export function renderActiveRoomDesktopActionBar(): string {
  return `
    <div
      data-active-room-desktop-action-bar="1"
      style="
        position:fixed;
        left:${DESKTOP_ACTION_LEFT_PX}px;
        bottom:${DESKTOP_ACTION_BOTTOM_PX}px;
        z-index:9400;
        display:flex;
        align-items:center;
        gap:${DESKTOP_ACTION_BUTTON_GAP_PX}px;
      "
    >
      <button
        type="button"
        data-active-room-leave-button="1"
        title="Напусни масата"
        style="
          height:${DESKTOP_ACTION_BUTTON_HEIGHT_PX}px;
          box-sizing:border-box;
          border:1px solid rgba(251,191,36,0.45);
          border-radius:12px;
          padding:0 22px;
          background:linear-gradient(180deg, #f6d36b 0%, #c98b1a 100%);
          color:#171717;
          font-size:15px;
          font-weight:900;
          cursor:pointer;
          box-shadow:0 16px 34px rgba(0,0,0,0.28);
        "
      >
        Изход
      </button>
      <button
        type="button"
        data-active-room-settings-button="1"
        title="Настройки"
        aria-label="Настройки"
        aria-haspopup="dialog"
        aria-expanded="false"
        style="
          ${renderSettingsIconButtonStyle(DESKTOP_ACTION_BUTTON_HEIGHT_PX)}
        "
      >
        ${renderGearIconSvg(DESKTOP_SETTINGS_ICON_SIZE_PX)}
      </button>
      ${SETTINGS_ICON_BUTTON_STYLE}
    </div>
  `
}

export function renderGameSoundsToggleState(enabled: boolean): {
  label: string
  background: string
  borderColor: string
  color: string
} {
  return enabled
    ? { label: 'Вкл.', background: 'rgba(34,197,94,0.16)', borderColor: '#22c55e', color: '#22c55e' }
    : { label: 'Изкл.', background: 'rgba(239,68,68,0.16)', borderColor: '#ef4444', color: '#ef4444' }
}

// Компактен panel над лентата, подравнен вляво с бутоните. Прозрачният
// backdrop само хваща клик извън panel-а за затваряне.
export function renderActiveRoomSettingsPanel(
  gameSoundsEnabled: boolean,
  placement: ActiveRoomSettingsPanelPlacement = 'mobile',
): string {
  const toggle = renderGameSoundsToggleState(gameSoundsEnabled)
  const panelLeftPx = placement === 'desktop' ? DESKTOP_ACTION_LEFT_PX : MOBILE_LEAVE_BUTTON_LEFT_PX
  const panelBottomPx = placement === 'desktop'
    ? DESKTOP_ACTION_BOTTOM_PX + DESKTOP_ACTION_BUTTON_HEIGHT_PX + 10
    : ACTIVE_ROOM_MOBILE_BOTTOM_NAV_HEIGHT + 8

  return `
    <div
      data-active-room-settings-backdrop="1"
      style="position:fixed;inset:0;z-index:9401;background:transparent;"
    >
      <div
        data-active-room-settings-panel="1"
        role="dialog"
        aria-label="Настройки"
        style="
          position:absolute;
          left:${panelLeftPx}px;
          bottom:${panelBottomPx}px;
          width:min(280px, calc(100vw - ${panelLeftPx * 2}px));
          box-sizing:border-box;
          padding:12px 14px 14px;
          background:rgba(15,23,42,0.98);
          border:1px solid rgba(212,165,32,0.45);
          border-radius:14px;
          box-shadow:0 16px 40px rgba(0,0,0,0.55);
          color:#f4f8ff;
          font-family:inherit;
        "
      >
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
          <div style="font-size:16px;font-weight:900;color:#f6d36b;">Настройки</div>
          <button
            type="button"
            data-active-room-settings-close="1"
            aria-label="Затвори"
            style="
              width:28px;height:28px;border:0;border-radius:8px;
              background:rgba(255,255,255,0.06);color:rgba(255,255,255,0.75);
              font-size:18px;font-weight:700;line-height:1;cursor:pointer;
            "
          >&times;</button>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
          <span style="font-size:14px;font-weight:700;line-height:1.3;">Звуци по време на игра</span>
          <button
            type="button"
            role="switch"
            data-active-room-game-sounds-toggle="1"
            aria-checked="${gameSoundsEnabled ? 'true' : 'false'}"
            style="
              flex-shrink:0;
              min-width:64px;height:34px;padding:0 10px;
              border-radius:8px;
              border:2px solid ${toggle.borderColor};
              background:${toggle.background};
              color:${toggle.color};
              font-size:14px;font-weight:900;
              cursor:pointer;
            "
          >${toggle.label}</button>
        </div>
      </div>
    </div>
  `
}
