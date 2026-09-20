// Постоянна долна контролна зона — Изход / Емоджита. Работи еднакво на
// desktop и mobile. Емоджитата reuse-ват реалния Belot animated-emoji
// каталог/asset URL-и (виж src/app/animatedEmoji/animatedEmojiAssets.ts) —
// същият picker UX (grid от preview изображения) като активна игра Белот
// (createActiveRoomFlowController.ts::renderEmojiPickerHtml), само
// позиционирането/grid колоните са адаптирани към Ludo bottom bar-а
// (Ludo няма Белотовия "stage scale" concept). "Фрази" бутонът е премахнат
// изцяло — Ludo няма измислени игрови фрази.
//
// "Емоджита" triggер-ът е ЧИСТО изображение (preview-emoji-08.png), не
// стандартен бутон с рамка/фон/надпис (виж task-а — button-frame styling-ът
// изрично премахнат) — самото <img> Е click target-ът (data-ludo-emoji-
// button="1" остава недокоснат, wiring-ът в createLudoFlowController.ts не
// е пипан). Лек hover/active scale (виж ludoAnimationStyles.ts) вместо
// bottomBarButtonStyle()-овия gold background hover, който другите bottom
// bar бутони пазят.

import { getAnimatedEmojiPreviewUrl, ANIMATED_EMOJI_COUNT } from '../../animatedEmoji/animatedEmojiAssets'
import { isPhoneLayoutViewport } from '../../../ui/layout/viewportStage'

export function renderLudoBottomBar(): string {
  return `
    <div data-ludo-bottom-bar="1" style="
      position:sticky;
      bottom:0;
      left:0; right:0;
      display:flex;
      align-items:center;
      gap:10px;
      padding:10px max(10px, env(safe-area-inset-left)) calc(10px + env(safe-area-inset-bottom)) max(10px, env(safe-area-inset-right));
      background:rgba(8,11,16,0.96);
      border-top:1px solid rgba(212,165,32,0.25);
      box-sizing:border-box;
    ">
      <button type="button" data-ludo-bottom-bar-button="1" data-ludo-exit-button="1" style="${bottomBarButtonStyle()}">
        <span style="font-size:18px;">&#8618;</span>
        <span>Изход</span>
      </button>

      <button
        type="button"
        data-ludo-bottom-bar-button="1"
        data-ludo-settings-button="1"
        title="Настройки"
        aria-label="Настройки"
        style="
          width:44px; height:44px; flex-shrink:0;
          display:flex; align-items:center; justify-content:center;
          border:1px solid rgba(212,165,32,0.35);
          border-radius:10px;
          background:rgba(212,165,32,0.08);
          color:#f0e6cf;
          cursor:pointer;
          transition:background 140ms ease;
        "
      >
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="3"></circle>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
        </svg>
      </button>

      <div style="flex:1;"></div>

      <button type="button" data-ludo-emoji-button="1" data-ludo-emoji-image-button="1" style="
        width:44px; height:44px; flex-shrink:0;
        border:0; outline:0; background:transparent; padding:0; margin:0;
        cursor:pointer;
        display:flex; align-items:center; justify-content:center;
        -webkit-tap-highlight-color:transparent;
      ">
        <img
          src="${getAnimatedEmojiPreviewUrl('08')}"
          alt="Емоджита"
          style="width:100%; height:100%; object-fit:contain; display:block; pointer-events:none;"
        >
      </button>
    </div>
  `
}

function bottomBarButtonStyle(): string {
  return `
    display:flex; align-items:center; gap:6px;
    padding:10px 16px;
    border:1px solid rgba(212,165,32,0.35);
    border-radius:10px;
    background:rgba(212,165,32,0.08);
    color:#f0e6cf;
    font-size:13px; font-weight:700;
    cursor:pointer;
    white-space:nowrap;
    transition:background 140ms ease;
  `.replace(/\s+/g, ' ').trim()
}

// Реалният emoji picker — reuse-ва СЪЩИЯ animated-emoji каталог/preview
// asset URL-и като активна игра Белот (getAnimatedEmojiPreviewUrl), СЪЩИЯ
// "01".."NN" zero-padded id scheme (ANIMATED_EMOJI_COUNT), огледално на
// createActiveRoomFlowController.ts::renderEmojiPickerHtml. НЕ full-screen
// backdrop (за разлика от старите mock popup-и/exit-confirm) — лек floating
// panel до бутона, не блокира dice/board кликове извън себе си (виж
// wireEvents()/mountEmojiPicker() в createLudoFlowController.ts, които
// explicit НЕ минават през syncModalLayerInteractivity() за тази цел).
export function renderLudoEmojiPickerHtml(): string {
  const isPhoneLayout = isPhoneLayoutViewport()
  const columns = isPhoneLayout ? 4 : 6
  const buttons: string[] = []
  for (let i = 1; i <= ANIMATED_EMOJI_COUNT; i++) {
    const id = String(i).padStart(2, '0')
    buttons.push(`
      <button
        type="button"
        data-ludo-emoji-pick="${id}"
        style="
          width:48px;height:48px;border:0;background:transparent;cursor:pointer;
          border-radius:10px;padding:2px;
          display:flex;align-items:center;justify-content:center;
          transition:background 0.12s;
        "
        onmouseenter="this.style.background='rgba(255,255,255,0.15)'"
        onmouseleave="this.style.background='transparent'"
      >
        <img src="${getAnimatedEmojiPreviewUrl(id)}" alt="" style="width:40px;height:40px;object-fit:contain;">
      </button>
    `)
  }
  return `
    <div
      data-ludo-emoji-picker="1"
      style="
        position:fixed;
        bottom:76px;
        right:max(14px, env(safe-area-inset-right));
        max-height:min(60vh, 360px);
        z-index:1;
        background:rgba(20,20,24,0.96);
        border:1px solid rgba(255,255,255,0.12);
        border-radius:16px;
        padding:12px;
        box-shadow:0 8px 32px rgba(0,0,0,0.5);
        -webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);
        overflow-y:auto;
        box-sizing:border-box;
      "
    >
      <div style="
        display:grid;
        grid-template-columns:repeat(${columns}, 48px);
        gap:4px;
        justify-content:center;
      ">
        ${buttons.join('')}
      </div>
    </div>
  `
}
