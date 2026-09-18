// Постоянна долна контролна зона — Изход / Емоджита / Фрази. Работи еднакво
// на desktop и mobile (виж двата референта); засега бутоните отварят
// mock popup-и без реална логика.

import { LUDO_MODAL_BACKDROP_LOCAL_Z_INDEX } from './ludoLayerHierarchy'

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

      <div style="flex:1;"></div>

      <button type="button" data-ludo-bottom-bar-button="1" data-ludo-emoji-button="1" style="${bottomBarButtonStyle()}">
        <span style="font-size:18px;">&#128512;</span>
        <span>Емоджита</span>
      </button>

      <button type="button" data-ludo-bottom-bar-button="1" data-ludo-phrase-button="1" style="${bottomBarButtonStyle()}">
        <span style="font-size:18px;">&#128172;</span>
        <span>Фрази</span>
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

// Mock popup за "Емоджита"/"Фрази" — минимален placeholder, консистентен с
// popup стила в лобито (тъмна card + gold border), без реална мрежова
// логика или споделено съдържание.
export function renderLudoMockPopup(title: string, items: string[]): string {
  const rows = items.map((item) => `
    <button type="button" data-ludo-mock-popup-item="1" style="
      padding:10px 14px;
      background:rgba(255,255,255,0.04);
      border:1px solid rgba(212,165,32,0.25);
      border-radius:8px;
      color:#fff; font-size:14px; text-align:left;
      cursor:pointer;
    ">${item}</button>
  `).join('')

  return `
    <div data-ludo-mock-popup-backdrop="1" style="
      position:fixed; inset:0;
      background:rgba(0,0,0,0.6);
      display:flex; align-items:flex-end; justify-content:center;
      z-index:${LUDO_MODAL_BACKDROP_LOCAL_Z_INDEX};
    ">
      <div style="
        width:min(420px, 100%);
        max-height:70vh;
        overflow-y:auto;
        background:#12161d;
        border:1px solid rgba(212,165,32,0.4);
        border-radius:16px 16px 0 0;
        padding:16px;
        box-sizing:border-box;
      ">
        <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:12px;">
          <span style="font-size:16px; font-weight:800; color:#d4a520;">${title}</span>
          <button type="button" data-ludo-mock-popup-close="1" style="
            background:none; border:none; color:rgba(255,255,255,0.6); font-size:18px; cursor:pointer;
          ">&times;</button>
        </div>
        <div style="display:grid; grid-template-columns:repeat(2, 1fr); gap:8px;">
          ${rows}
        </div>
      </div>
    </div>
  `
}
