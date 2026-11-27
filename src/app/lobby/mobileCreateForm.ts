// Мобилната форма „Нова маса“ / „Създай игра“ (светлият мобилен дизайн) —
// общ вид за Белот, „Не се сърди човече“ и „Свара“. Само представяне:
// полетата (name/value/checked/selected), data-* атрибутите и обработчиците
// на всяка игра остават същите. Визуалната линия е тази на екрана
// „Избери вход“ (mobileEntryPicker.ts).
//
// Отметките са истински <input type="checkbox"> с вид на превключвател
// (appearance:none) — FormData, черновите и тестовете не се променят.

const STYLE_ID = 'mobile-create-form-style'

/** Фонът зад прозореца — покрива и долната навигация; отстъп за safe area (PWA). */
export const MOBILE_CREATE_BACKDROP_STYLE = 'position:fixed;inset:0;z-index:9500;background:rgba(30,14,78,0.55);display:flex;align-items:center;justify-content:center;padding:max(12px,env(safe-area-inset-top)) 12px max(12px,env(safe-area-inset-bottom));box-sizing:border-box;overflow-y:auto;font-family:inherit;'

/** Картата на прозореца (ширина — от извикващия). */
export const MOBILE_CREATE_CARD_STYLE = 'position:relative;max-width:100%;max-height:calc(100dvh - 24px - env(safe-area-inset-top) - env(safe-area-inset-bottom));overflow-y:auto;overscroll-behavior:contain;box-sizing:border-box;margin:auto;padding:16px 14px 16px;border-radius:24px;border:1.5px solid rgba(214,170,56,0.75);background:radial-gradient(120% 60% at 50% 0%,#FFFFFF 0%,rgba(255,255,255,0) 60%),linear-gradient(180deg,#F6F1FF 0%,#EEE6FE 50%,#E6DBFC 100%);box-shadow:inset 0 0 0 1px rgba(255,255,255,0.75),0 24px 56px rgba(30,10,90,0.38),0 0 0 4px rgba(214,170,56,0.12);color:#1C1442;'

/**
 * Десктоп вариантът (тъмна тема): атрибут на картата + фон и карта на прозореца.
 * Височината се дели на --lobby-scale: прозорецът на Белот/Ludo е под zoom на
 * десктоп обвивката (извън нея — диалогът на Свара в body — мащабът е 1).
 */
export const DESKTOP_CREATE_THEME_ATTRIBUTE = 'data-create-theme="dark"'
export const DESKTOP_CREATE_BACKDROP_STYLE = 'position:fixed;inset:0;z-index:9500;background:rgba(4,2,10,0.74);display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;overflow-y:auto;font-family:inherit;'
export const DESKTOP_CREATE_CARD_STYLE = 'position:relative;width:min(100%,600px);max-width:100%;max-height:calc((100dvh - 48px) / var(--lobby-scale, 1));overflow-y:auto;overscroll-behavior:contain;box-sizing:border-box;margin:auto;padding:24px 26px 26px;border-radius:24px;border:1.5px solid rgba(239,194,90,0.6);background:radial-gradient(120% 40% at 50% 0%,rgba(124,58,237,0.30) 0%,rgba(124,58,237,0) 65%),linear-gradient(180deg,#1E1438 0%,#150E2A 100%);box-shadow:inset 0 0 0 1px rgba(167,139,250,0.16),0 30px 80px rgba(0,0,0,0.65),0 0 44px rgba(124,58,237,0.20);color:#F3EEFF;scrollbar-color:rgba(167,139,250,0.45) transparent;'

const CSS = `
  .mcf-head { position:relative; display:flex; align-items:center; justify-content:center; min-height:40px; padding:0 44px; }
  .mcf-title { margin:0; font-size:26px; font-weight:900; line-height:1.15; color:#1C1442; letter-spacing:0; text-align:center; }
  .mcf-close {
    position:absolute; right:0; top:0; width:38px; height:38px; display:flex; align-items:center; justify-content:center;
    padding:0; border:1px solid rgba(121,80,232,0.22); border-radius:11px; background:rgba(255,255,255,0.75); color:#2A1F5C;
    box-shadow:0 2px 6px rgba(76,52,160,0.14); cursor:pointer; font-family:inherit;
  }
  .mcf-divider { display:flex; align-items:center; gap:10px; margin:6px 24px 14px; color:#C99A1E; }
  .mcf-divider::before, .mcf-divider::after { content:""; flex:1 1 auto; height:1.5px; border-radius:2px; }
  .mcf-divider::before { background:linear-gradient(90deg,rgba(214,170,56,0) 0%,#D6AA38 100%); }
  .mcf-divider::after { background:linear-gradient(90deg,#D6AA38 0%,rgba(214,170,56,0) 100%); }
  .mcf-form { display:flex; flex-direction:column; gap:10px; margin:0; }
  .mcf-row {
    display:grid; grid-template-columns:38px minmax(0,1fr) auto; align-items:center; column-gap:10px;
    min-height:64px; padding:10px 12px; box-sizing:border-box; border-radius:16px; cursor:pointer; user-select:none;
    background:rgba(255,255,255,0.72); border:1px solid rgba(255,255,255,0.9);
    box-shadow:0 2px 8px rgba(76,52,160,0.10),0 1px 1px rgba(76,52,160,0.05);
    -webkit-tap-highlight-color:transparent; text-align:left; width:100%; font-family:inherit; color:inherit;
  }
  .mcf-row-icon {
    width:38px; height:38px; border-radius:12px; display:flex; align-items:center; justify-content:center;
    background:linear-gradient(160deg,#F1EAFF 0%,#E2D6FD 100%); color:#5B2BC4; box-shadow:inset 0 1px 0 rgba(255,255,255,0.8);
  }
  .mcf-row-text { min-width:0; display:grid; gap:2px; }
  .mcf-row-title { font-size:14.5px; font-weight:800; line-height:1.25; color:#1C1442; display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
  .mcf-row-hint { font-size:12.5px; font-weight:500; line-height:1.35; color:#5E5880; }
  .mcf-switch {
    -webkit-appearance:none; appearance:none; position:relative; flex:0 0 auto; width:52px; height:30px; margin:0; border-radius:999px; cursor:pointer;
    background:linear-gradient(180deg,#CFC8E2 0%,#BDB5D6 100%); box-shadow:inset 0 1px 3px rgba(40,20,100,0.25);
    transition:background 0.18s ease, box-shadow 0.18s ease;
  }
  .mcf-switch::after {
    content:""; position:absolute; top:3px; left:3px; width:24px; height:24px; border-radius:999px; background:#FFFFFF;
    box-shadow:0 2px 4px rgba(20,10,60,0.3); transition:transform 0.18s ease;
  }
  .mcf-switch:checked { background:linear-gradient(180deg,#34D058 0%,#16A34A 100%); box-shadow:inset 0 1px 2px rgba(0,60,20,0.25),0 0 10px rgba(34,197,94,0.45); }
  .mcf-switch:checked::after { transform:translateX(22px); }
  .mcf-switch:focus-visible { outline:2px solid #7950E8; outline-offset:2px; }
  .mcf-row-lock { color:#8F89A8; display:flex; }
  .mcf-field { display:grid; gap:6px; min-width:0; margin:2px 0 0; }
  .mcf-field-label { font-size:14px; font-weight:800; line-height:1.2; color:#1C1442; padding:0 2px; }
  .mcf-select {
    position:relative; display:flex; align-items:center; min-width:0; height:50px; box-sizing:border-box; border-radius:14px;
    background:rgba(255,255,255,0.78); border:1.5px solid rgba(214,170,56,0.55); box-shadow:0 2px 6px rgba(76,52,160,0.08);
  }
  .mcf-select-icon { position:absolute; left:14px; top:50%; transform:translateY(-50%); color:#5B2BC4; display:flex; pointer-events:none; }
  .mcf-select-chevron { position:absolute; right:14px; top:50%; transform:translateY(-50%); color:#1C1442; display:flex; pointer-events:none; }
  .mcf-select select {
    -webkit-appearance:none; appearance:none; width:100%; height:100%; min-width:0; box-sizing:border-box; margin:0;
    padding:0 42px 0 48px; border:0; border-radius:14px; background:transparent; color:#1C1442; color-scheme:light;
    font-family:inherit; font-size:16px; font-weight:700; cursor:pointer;
  }
  .mcf-select select:focus-visible { outline:2px solid #7950E8; outline-offset:2px; }
  .mcf-seg { border:0; padding:0; margin:2px 0 0; min-width:0; display:grid; gap:6px; }
  .mcf-seg legend { padding:0 2px; margin-bottom:6px; font-size:14px; font-weight:800; color:#1C1442; }
  .mcf-seg-track {
    display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:4px; padding:4px; border-radius:14px;
    background:rgba(255,255,255,0.6); border:1.5px solid rgba(214,170,56,0.45); box-shadow:inset 0 1px 3px rgba(76,52,160,0.10);
  }
  .mcf-seg-option { position:relative; display:flex; align-items:center; justify-content:center; gap:6px; min-height:42px; padding:0 8px; border-radius:10px; cursor:pointer; font-size:14px; font-weight:800; color:#5E5880; text-align:center; }
  .mcf-seg-option input { position:absolute; inset:0; width:100%; height:100%; margin:0; opacity:0; cursor:pointer; }
  .mcf-seg-option:has(input:checked) { background:linear-gradient(180deg,#34D058 0%,#16A34A 100%); color:#FFFFFF; box-shadow:0 2px 8px rgba(22,163,74,0.35); text-shadow:0 1px 1px rgba(0,60,20,0.3); }
  .mcf-seg-option:has(input:focus-visible) { outline:2px solid #7950E8; outline-offset:2px; }
  .mcf-info {
    display:grid; gap:4px; padding:10px 12px; border-radius:14px; background:rgba(255,255,255,0.6); border:1px solid rgba(255,255,255,0.9);
    font-size:13px; font-weight:700; line-height:1.4; color:#3A3355; box-shadow:0 1px 4px rgba(76,52,160,0.08);
  }
  .mcf-actions { display:grid; gap:8px; margin-top:6px; }
  .mcf-cta {
    width:100%; height:56px; display:flex; align-items:center; justify-content:center; gap:10px;
    border:1.5px solid rgba(232,190,80,0.95) !important; border-radius:16px; color:#FFFFFF; font-family:inherit;
    font-size:20px; font-weight:900; letter-spacing:0; cursor:pointer; white-space:nowrap;
    /* Резервен фон; в приложението .lobby-violet-btn.violet-3d-btn (по-специфичен) дава 3D вида. */
    background:linear-gradient(180deg,#9473F2 0%,#7950E8 52%,#5B2BC4 100%);
  }
  .mcf-cta svg { color:#F6C744; flex:0 0 auto; }
  .mcf-secondary {
    width:100%; height:42px; border:1px solid rgba(121,80,232,0.25); border-radius:12px; background:rgba(255,255,255,0.65);
    color:#4A3A86; font-family:inherit; font-size:14px; font-weight:800; cursor:pointer;
  }
  .mcf-message { font-size:14px; font-weight:600; line-height:1.45; color:#5E5880; text-align:center; padding:6px 4px 2px; margin:0; }
  @media (max-width: 359px) {
    .mcf-title { font-size:22px; }
    .mcf-row { grid-template-columns:34px minmax(0,1fr) auto; column-gap:9px; padding:9px 10px; }
    .mcf-row-icon { width:34px; height:34px; border-radius:10px; }
    .mcf-row-title { font-size:14px; }
    .mcf-switch { width:46px; height:27px; }
    .mcf-switch::after { width:21px; height:21px; }
    .mcf-switch:checked::after { transform:translateX(19px); }
    .mcf-cta { font-size:18px; height:52px; }
    .mcf-seg-option { font-size:13px; }
  }
  @media (max-height: 600px) {
    .mcf-title { font-size:22px; }
    .mcf-divider { margin-bottom:8px; }
    .mcf-row { min-height:54px; padding-top:7px; padding-bottom:7px; }
    .mcf-select { height:44px; }
    .mcf-cta { height:48px; font-size:18px; }
  }

  /* ─── Десктоп (тъмна тема): data-create-theme="dark" на картата ─── */
  [data-create-theme="dark"] .mcf-head { min-height:46px; padding:0 54px; }
  [data-create-theme="dark"] .mcf-title {
    font-size:32px; color:#F6D27A;
    background:linear-gradient(180deg,#FFF3CF 0%,#F4CB62 55%,#D99A1C 100%); -webkit-background-clip:text; background-clip:text; -webkit-text-fill-color:transparent;
  }
  [data-create-theme="dark"] .mcf-close {
    width:42px; height:42px; background:rgba(255,255,255,0.08); color:#FFFFFF; border:1px solid rgba(255,255,255,0.14); box-shadow:none;
    transition:background 0.15s ease, border-color 0.15s ease;
  }
  [data-create-theme="dark"] .mcf-close:hover { background:rgba(255,255,255,0.15); border-color:rgba(239,194,90,0.5); }
  [data-create-theme="dark"] .mcf-divider { margin:8px 60px 20px; color:#E9B949; }
  [data-create-theme="dark"] .mcf-form { gap:12px; }
  [data-create-theme="dark"] .mcf-row {
    grid-template-columns:44px minmax(0,1fr) auto; column-gap:14px; min-height:70px; padding:12px 18px 12px 14px;
    background:linear-gradient(180deg,rgba(46,32,84,0.88) 0%,rgba(29,20,55,0.88) 100%); border:1px solid rgba(167,139,250,0.26);
    box-shadow:inset 0 1px 0 rgba(255,255,255,0.05),0 4px 12px rgba(0,0,0,0.25);
    transition:border-color 0.15s ease, box-shadow 0.15s ease;
  }
  [data-create-theme="dark"] .mcf-row:hover { border-color:rgba(239,194,90,0.45); box-shadow:inset 0 1px 0 rgba(255,255,255,0.06),0 6px 16px rgba(0,0,0,0.32); }
  [data-create-theme="dark"] .mcf-row-icon { width:44px; height:44px; background:rgba(167,139,250,0.14); color:#C4B5FD; box-shadow:inset 0 0 0 1px rgba(167,139,250,0.25); }
  [data-create-theme="dark"] .mcf-row-title { font-size:16px; color:#FFFFFF; }
  [data-create-theme="dark"] .mcf-row-hint { font-size:13.5px; color:rgba(237,233,254,0.62); }
  [data-create-theme="dark"] .mcf-row-lock { color:rgba(255,255,255,0.5); }
  [data-create-theme="dark"] .mcf-switch {
    width:54px; height:30px; background:#2B2542; box-shadow:inset 0 0 0 1px rgba(255,255,255,0.14),inset 0 2px 4px rgba(0,0,0,0.45);
  }
  [data-create-theme="dark"] .mcf-switch::after { background:linear-gradient(180deg,#DDD7EE 0%,#ACA4C6 100%); }
  [data-create-theme="dark"] .mcf-switch:checked { background:linear-gradient(180deg,#34D058 0%,#16A34A 100%); box-shadow:0 0 14px rgba(34,197,94,0.55),inset 0 1px 2px rgba(0,60,20,0.3); }
  [data-create-theme="dark"] .mcf-switch:checked::after { background:#FFFFFF; transform:translateX(24px); }
  [data-create-theme="dark"] .mcf-field-label, [data-create-theme="dark"] .mcf-seg legend { font-size:15px; color:#EDE9FE; }
  [data-create-theme="dark"] .mcf-select {
    height:52px; background:rgba(10,6,22,0.55); border:1px solid rgba(239,194,90,0.45); box-shadow:inset 0 1px 0 rgba(255,255,255,0.04);
    transition:border-color 0.15s ease;
  }
  [data-create-theme="dark"] .mcf-select:hover { border-color:rgba(239,194,90,0.75); }
  [data-create-theme="dark"] .mcf-select-icon { color:#C4B5FD; }
  [data-create-theme="dark"] .mcf-select-chevron { color:#E9B949; }
  [data-create-theme="dark"] .mcf-select select { color:#FFFFFF; color-scheme:dark; }
  [data-create-theme="dark"] .mcf-select select option { background:#1A1233; color:#FFFFFF; }
  [data-create-theme="dark"] .mcf-seg-track { background:rgba(10,6,22,0.55); border:1px solid rgba(239,194,90,0.4); box-shadow:none; }
  [data-create-theme="dark"] .mcf-seg-option { min-height:44px; color:rgba(237,233,254,0.72); }
  [data-create-theme="dark"] .mcf-seg-option:hover:not(:has(input:checked)) { background:rgba(255,255,255,0.05); }
  [data-create-theme="dark"] .mcf-info { background:rgba(255,255,255,0.04); border:1px solid rgba(167,139,250,0.22); color:rgba(237,233,254,0.86); box-shadow:none; }
  [data-create-theme="dark"] .mcf-actions { margin-top:10px; }
  [data-create-theme="dark"] .mcf-cta {
    height:58px; border:1px solid rgba(255,236,170,0.9) !important; border-radius:14px; color:#1A1200; font-size:21px;
    background:linear-gradient(180deg,#FDE59A 0%,#F2C14E 45%,#D69417 100%);
    box-shadow:inset 0 1px 0 rgba(255,255,255,0.6),0 4px 0 #8F620A,0 12px 26px rgba(217,154,28,0.32);
    transition:filter 0.15s ease, transform 0.1s ease;
  }
  [data-create-theme="dark"] .mcf-cta svg { color:#3B2600; }
  [data-create-theme="dark"] .mcf-cta:hover { filter:brightness(1.06); }
  [data-create-theme="dark"] .mcf-cta:active { transform:translateY(2px); box-shadow:inset 0 1px 0 rgba(255,255,255,0.5),0 2px 0 #8F620A; }
  [data-create-theme="dark"] .mcf-secondary { background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.16); color:#EDE9FE; }
  [data-create-theme="dark"] .mcf-message { color:rgba(237,233,254,0.72); }
`

export function ensureMobileCreateFormStyles(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  document.head.appendChild(style)
}

const svg = (body: string, size = 20, width = 2.2): string => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`

export const MOBILE_CREATE_ICONS = {
  lock: svg('<rect width="16" height="11" x="4" y="11" rx="2.5"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/><circle cx="12" cy="16" r="1.2"/>'),
  play: svg('<path d="M7 4.5v15l12-7.5z"/>'),
  users: svg('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><circle cx="17" cy="9" r="2.8"/><path d="M16 14.2a5.5 5.5 0 0 1 5.5 5.8"/>'),
  mic: svg('<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/>'),
  clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  bolt: svg('<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>'),
  players: svg('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'),
  chevron: svg('<path d="M6 9l6 6 6-6"/>', 20, 2.6),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>', 18, 2.8),
  spade: '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><path d="M12 2.5c-2.6 3.3-8 6.6-8 10.6 0 2.4 1.9 4.2 4.2 4.2 1.2 0 2.3-.5 3-1.3-.2 1.8-.9 3.3-2.2 4.5h6c-1.3-1.2-2-2.7-2.2-4.5.7.8 1.8 1.3 3 1.3 2.3 0 4.2-1.8 4.2-4.2 0-4-5.4-7.3-8-10.6z"/></svg>',
} as const

/** Заглавие + бутон за затваряне + златен разделител с пика. closeAttribute — съществуващият data-* на бутона. */
export function renderMobileCreateHeader(title: string, closeAttribute: string, titleId?: string): string {
  return `<div class="mcf-head">
      <h2 class="mcf-title"${titleId ? ` id="${titleId}"` : ''}>${title}</h2>
      <button type="button" class="mcf-close" ${closeAttribute} aria-label="Затвори">${MOBILE_CREATE_ICONS.close}</button>
    </div>
    <div class="mcf-divider" aria-hidden="true">${MOBILE_CREATE_ICONS.spade}</div>`
}

/** Ред с превключвател (истински checkbox). inputAttributes — name/checked/data-* на полето. */
export function renderMobileCreateToggleRow(inputAttributes: string, icon: string, title: string, hint: string): string {
  return `<label class="mcf-row">
      <span class="mcf-row-icon">${icon}</span>
      <span class="mcf-row-text"><span class="mcf-row-title">${title}</span><span class="mcf-row-hint">${hint}</span></span>
      <input type="checkbox" class="mcf-switch" role="switch" ${inputAttributes}>
    </label>`
}

/** Падащо меню с иконка; selectAttributes — name/data-* на select-а. */
export function renderMobileCreateSelect(label: string, icon: string, selectAttributes: string, optionsHtml: string): string {
  return `<label class="mcf-field">
      <span class="mcf-field-label">${label}</span>
      <span class="mcf-select"><span class="mcf-select-icon">${icon}</span><select ${selectAttributes}>${optionsHtml}</select><span class="mcf-select-chevron">${MOBILE_CREATE_ICONS.chevron}</span></span>
    </label>`
}

/** Избор между две стойности (радио бутони) като сегментиран превключвател. */
export function renderMobileCreateSegmented(legend: string, name: string, options: Array<{ value: string; label: string; checked: boolean }>): string {
  return `<fieldset class="mcf-seg"><legend>${legend}</legend><div class="mcf-seg-track">${options.map((option) => `<label class="mcf-seg-option"><input type="radio" name="${name}" value="${option.value}"${option.checked ? ' checked' : ''}><span>${option.label}</span></label>`).join('')}</div></fieldset>`
}

/** Основният бутон за създаване (submit); класът на виолетовия бутон идва от извикващия. */
export function renderMobileCreateSubmit(label: string, violetClass: string): string {
  return `<button type="submit" class="mcf-cta ${violetClass}">${MOBILE_CREATE_ICONS.spade}<span>${label}</span></button>`
}
