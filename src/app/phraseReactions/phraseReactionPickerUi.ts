// Общ визуален markup за системата с готови фрази — споделен 1:1 между
// активна игра Белот (createActiveRoomFlowController.ts) и „Не се сърди
// човече“ (renderLudoBottomBar.ts / createLudoFlowController.ts). Белот е
// оригиналът: стойностите тук са извадени буквално от неговия
// renderPhrasePickerHtml/phrase toggle бутон, без промяна. Всяка игра подава
// само собствените си data-атрибути (за да не се смесват DOM query-тата на
// двата контролера), собствения си каталог с фрази и долния offset на
// панела на телефон (над собствената си долна лента).

import { escapeHtml } from '../activeRoom/activeRoomShared'

export type PhraseReactionOption = {
  id: string
  text: string
}

export type PhrasePickerPanelOptions = {
  phrases: readonly PhraseReactionOption[]
  isPhoneLayout: boolean
  // Desktop: stage scale-ът на активната маса; phone: винаги 1.
  uiScale: number
  uiScaleKey: string
  // Разстоянието от долния ръб на viewport-а до панела на телефон —
  // 8px над долната контролна лента на съответната игра.
  phoneBottomPx: number
  panelAttribute: string
  pickAttribute: string
}

export function renderPhrasePickerPanelHtml(options: PhrasePickerPanelOptions): string {
  const { phrases, isPhoneLayout, uiScale, uiScaleKey, phoneBottomPx, panelAttribute, pickAttribute } = options
  const rows = phrases.map((phrase) => `
      <button
        type="button"
        ${pickAttribute}="${escapeHtml(phrase.id)}"
        style="
          border:1px solid rgba(212,165,32,0.36);
          background:rgba(255,255,255,0.055);
          color:#ffffff;
          border-radius:10px;
          padding:10px 12px;
          cursor:pointer;
          font:${isPhoneLayout ? '800' : '400'} ${isPhoneLayout ? '13px' : '14px'}/1.15 Arial, Helvetica, sans-serif;
          text-align:left;
          min-height:42px;
          transition:background 0.12s,border-color 0.12s,color 0.12s;
          display:flex;
          align-items:center;
          justify-content:center;
        "
        onmouseenter="this.style.background='rgba(212,165,32,0.16)';this.style.borderColor='rgba(212,165,32,0.72)'"
        onmouseleave="this.style.background='rgba(255,255,255,0.055)';this.style.borderColor='rgba(212,165,32,0.36)'"
      >
        ${escapeHtml(phrase.text)}
      </button>
    `)

  return `
      <div
        ${panelAttribute}="1"
        data-reaction-ui-scale="${uiScaleKey}"
        style="
          position:fixed;
          bottom:${isPhoneLayout ? `${phoneBottomPx}px` : '76px'};
          right:${isPhoneLayout ? '14px' : '16px'};
          transform:scale(${uiScale});
          transform-origin:bottom right;
          z-index:9999;
          width:${isPhoneLayout ? 'min(360px, calc(100vw - 28px))' : '420px'};
          max-height:${isPhoneLayout ? '52vh' : 'none'};
          overflow:${isPhoneLayout ? 'auto' : 'visible'};
          background:rgba(20,20,24,0.96);
          border:1px solid rgba(255,255,255,0.12);
          border-radius:16px;
          padding:12px;
          display:grid;
          grid-template-columns:${isPhoneLayout ? '1fr' : '1fr 1fr'};
          gap:7px;
          box-shadow:0 8px 32px rgba(0,0,0,0.5);
          -webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);
        "
      >
        ${rows.join('')}
      </div>
    `
}

// Кръглата повърхност на бутона „Фрази“ (без позиция/размер — те зависят от
// мястото, където всяка игра го поставя).
export function renderPhraseToggleSurfaceStyle(isPhoneLayout: boolean): string {
  return `
            border:0;border-radius:50%;
            background:rgba(20,20,24,0.92);
            border:2px solid rgba(212,165,32,0.80);
            box-shadow:0 0 12px rgba(212,165,32,0.25), 0 6px 20px rgba(0,0,0,0.50);
            cursor:pointer;
            display:flex;align-items:center;justify-content:center;
            -webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);
            color:#f4c432;
            font-size:${isPhoneLayout ? '22px' : '42px'};
            font-weight:900;
            line-height:1;
  `
}

// Иконата (златно балонче с три точки) спрямо 80px бутон. unit=1 е Белот
// desktop (80px бутон), unit=0.5 е Белот phone (40px бутон) — всички
// phone стойности на Белот са точно половината от desktop-ските.
export function renderPhraseToggleIconHtml(unit: number): string {
  const px = (value: number) => `${value * unit}px`
  const dot = `<span style="width:${px(8)};height:${px(8)};border-radius:50%;background:#2a2018;z-index:1;"></span>`
  return `
          <span
            aria-hidden="true"
            style="
              position:relative;
              width:${px(50)};
              height:${px(36)};
              display:flex;
              align-items:center;
              justify-content:center;
              gap:${px(8)};
              border-radius:50%;
              background:#d4a520;
            "
          >
            <span
              style="
                position:absolute;
                left:0px;
                bottom:${px(-8)};
                width:${px(26)};
                height:${px(20)};
                background:#d4a520;
                clip-path:polygon(0 100%, 42% 0, 100% 18%);
              "
            ></span>
            ${dot}
            ${dot}
            ${dot}
          </span>
  `
}
