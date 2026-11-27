// Мобилен избор на вход (светлият мобилен дизайн) — общ за формите „Нова
// маса“ / „Създай игра“ на Белот, „Не се сърди човече“ и „Свара“.
//
// Отваря се като отделен екран В СЪЩИЯ модален прозорец (не втори popup):
// картата на прозореца носи data-entry-picker-card, а екранът е неин пряк
// наследник. Докато екранът е отворен, останалото съдържание на картата е
// скрито с CSS.
//
// Стойността остава в съществуващия <select name="…"> (скрит) — FormData,
// submit обработчиците, черновите и валидациите на всяка игра не се
// променят. „Потвърди“ сменя стойността на select-а и праща обичайното
// събитие change; затваряне без потвърждение пази предишния избор.
//
// Наградите се подават от извикващия (сървърни стойности или общата
// сървърна формула) — компонентът не изчислява и не предполага нищо.

/** Ред в списъка: награда по вариант (напр. брой играчи; '' — без вариант). */
export type MobileEntryPickerRow = {
  value: number
  prizes: Record<string, number | null>
  /** Причина вариантът да е недостъпен независимо от варианта (баланс, ниво). */
  unavailableReason: string | null
}

export type MobileEntryPickerConfig = {
  /** name на съществуващия select във формата (stake / entryFee). */
  fieldName: string
  iconUrl: string
  rows: MobileEntryPickerRow[]
  /** Потвърденият избор (стойността на select-а). */
  selected: number | null
  /** Текущият вариант ('' — без вариант). */
  variant: string
  /** name на полето във формата, от което зависи наградата (напр. брой играчи). */
  variantFieldName?: string
  /** Текст за ред без награда при текущия вариант; {n} → вариантът. */
  variantUnavailableText?: string
  /** Отворен ли е екранът (за контролери, които прерисуват целия диалог). */
  open?: boolean
  /** Временно избраният (непотвърден) ред при отворен екран. */
  pending?: number | null
}

export type MobileEntryPickerState = { open: boolean; pending: number | null }

const STYLE_ID = 'mobile-entry-picker-style'
const COIN_ICON_URL = '/assets/lobby/icon-coin.png'
const COIN_STACK_URL = '/assets/lobby/coins-1000.png'
const FALLBACK_UNAVAILABLE = 'Недостъпен вход'

const PICKER_CSS = `
  [data-entry-picker-card][data-entry-picker-open="1"] {
    padding:0 !important;
    overflow:hidden !important;
    display:flex !important;
    flex-direction:column !important;
    background:#EFE9FD !important;
  }
  [data-entry-picker-card][data-entry-picker-open="1"] > :not([data-entry-picker-screen]) { display:none !important; }
  [data-entry-picker-card]:not([data-entry-picker-open="1"]) > [data-entry-picker-screen] { display:none !important; }
  .mep-screen {
    flex:1 1 auto; min-height:0; display:flex; flex-direction:column;
    background:linear-gradient(180deg,#F3EEFF 0%,#ECE5FD 55%,#E6DEFB 100%);
    color:#17123A; font-family:inherit; text-align:left;
  }
  .mep-head { flex:0 0 auto; display:flex; align-items:center; gap:12px; padding:16px 14px 12px 16px; }
  .mep-head-icon {
    width:52px; height:52px; flex:0 0 auto; border-radius:14px; display:flex; align-items:center; justify-content:center;
    background:linear-gradient(160deg,#6E4FE0 0%,#4A2BA6 100%);
    box-shadow:inset 0 1px 0 rgba(255,255,255,0.25),0 4px 10px rgba(74,43,166,0.28);
  }
  .mep-head-icon img { width:40px; height:40px; object-fit:contain; display:block; }
  .mep-head-text { flex:1 1 auto; min-width:0; }
  .mep-title { margin:0; font-size:22px; font-weight:900; line-height:1.15; color:#17123A; letter-spacing:0; }
  .mep-subtitle { margin:3px 0 0; font-size:14px; font-weight:500; line-height:1.3; color:#57527A; }
  .mep-close {
    width:38px; height:38px; flex:0 0 auto; align-self:flex-start; display:flex; align-items:center; justify-content:center;
    border:0; border-radius:10px; background:rgba(121,80,232,0.13); color:#2A1F5C; cursor:pointer; padding:0;
    font-family:inherit;
  }
  .mep-list {
    flex:1 1 auto; min-height:0; overflow-y:auto; overscroll-behavior:contain; -webkit-overflow-scrolling:touch;
    display:grid; gap:8px; align-content:start; padding:4px 12px 10px;
  }
  .mep-row {
    position:relative; display:grid; grid-template-columns:40px minmax(0,1fr) 1px minmax(0,1fr) 30px;
    align-items:center; column-gap:10px; min-height:68px; padding:8px 12px 8px 10px; box-sizing:border-box;
    background:#FFFFFF; border:2px solid transparent; border-radius:16px; cursor:pointer;
    box-shadow:0 2px 6px rgba(76,52,160,0.10),0 1px 1px rgba(76,52,160,0.06);
    -webkit-tap-highlight-color:transparent;
  }
  .mep-row input { position:absolute; opacity:0; width:1px; height:1px; margin:0; pointer-events:none; }
  .mep-row[data-selected="1"] {
    border-color:#F2B705;
    background:linear-gradient(180deg,#FFFBEA 0%,#FFF2C9 100%);
    box-shadow:0 0 0 1px rgba(242,183,5,0.20),0 4px 12px rgba(214,158,0,0.22);
  }
  .mep-row:has(input:focus-visible) { outline:2px solid #7950E8; outline-offset:2px; }
  .mep-row[data-unavailable="1"] { cursor:not-allowed; background:#F7F5FC; box-shadow:none; border-color:#E4DEF5; }
  .mep-row[data-unavailable="1"] .mep-stack,
  .mep-row[data-unavailable="1"] .mep-col { opacity:0.5; }
  .mep-stack { width:40px; height:40px; object-fit:contain; display:block; }
  .mep-col { min-width:0; display:grid; gap:1px; }
  .mep-label { font-size:13px; font-weight:600; line-height:1.2; color:#3A3550; }
  .mep-amount {
    display:flex; align-items:center; gap:5px; min-width:0;
    font-size:clamp(17px,5.2vw,21px); font-weight:900; line-height:1.15; color:#17123A; font-variant-numeric:tabular-nums;
  }
  .mep-amount { flex-wrap:wrap; row-gap:2px; }
  .mep-amount span { white-space:nowrap; }
  .mep-amount.mep-amount-md { font-size:clamp(15px,4.6vw,19px); }
  .mep-amount.mep-amount-sm { font-size:clamp(13px,3.8vw,16px); }
  .mep-amount.mep-amount-xs { font-size:clamp(11px,3.1vw,13px); }
  .mep-amount img { width:17px; height:17px; flex:0 0 auto; object-fit:contain; display:block; }
  .mep-prize { color:#17A32B; }
  .mep-divider { width:1px; height:30px; background:#CFC8E4; }
  .mep-mark {
    width:28px; height:28px; box-sizing:border-box; border-radius:999px; border:2px solid #8F89A8; background:#FFFFFF;
    display:flex; align-items:center; justify-content:center; justify-self:end; color:#FFFFFF;
  }
  .mep-mark .mep-check, .mep-mark .mep-lock { display:none; }
  .mep-row[data-selected="1"] .mep-mark { border:0; background:#17A32B; box-shadow:0 2px 4px rgba(23,163,43,0.35); }
  .mep-row[data-selected="1"]:not([data-unavailable="1"]) .mep-mark .mep-check { display:block; }
  .mep-row[data-unavailable="1"] .mep-mark { border-color:#C9C3DC; background:#F2EFF9; color:#8F89A8; }
  .mep-row[data-unavailable="1"] .mep-mark .mep-lock { display:block; }
  .mep-reason {
    grid-column:2 / 5; margin-top:4px; font-size:12px; font-weight:700; line-height:1.3; color:#B42318;
  }
  .mep-reason[hidden] { display:none; }
  .mep-foot {
    flex:0 0 auto; padding:10px 12px calc(14px + env(safe-area-inset-bottom, 0px));
    background:linear-gradient(180deg,rgba(236,229,253,0) 0%,#ECE5FD 30%);
  }
  .mep-confirm {
    width:100%; height:52px; border:0; border-radius:14px; color:#FFFFFF; font-family:inherit;
    font-size:19px; font-weight:900; letter-spacing:0; cursor:pointer;
  }
  .mep-confirm:disabled { cursor:not-allowed; opacity:0.55; }
  /* Обобщаващата карта на избрания вход във формата: Вход | Награда на един
     ред по цялата ширина, „Промени“ — отделно действие отдолу. */
  .mep-field {
    position:relative; width:100%; box-sizing:border-box; display:grid; gap:10px; padding:12px 12px 10px; text-align:left;
    background:radial-gradient(90% 120% at 15% 0%,rgba(150,110,255,0.55) 0%,rgba(150,110,255,0) 60%),linear-gradient(160deg,#5C30D0 0%,#45209F 55%,#341680 100%);
    border:1.5px solid rgba(232,190,80,0.95); border-radius:20px; cursor:pointer; font-family:inherit; color:#FFFFFF;
    box-shadow:inset 0 1px 0 rgba(255,255,255,0.25),0 8px 20px rgba(52,22,128,0.35),0 0 0 3px rgba(232,190,80,0.15);
    -webkit-tap-highlight-color:transparent;
  }
  .mep-field:focus-visible { outline:2px solid #7950E8; outline-offset:3px; }
  .mep-field-main { display:grid; grid-template-columns:52px minmax(0,1fr) 1px minmax(0,1fr); align-items:center; column-gap:10px; min-width:0; }
  .mep-field .mep-stack { width:52px; height:52px; filter:drop-shadow(0 3px 4px rgba(0,0,0,0.35)); }
  .mep-field-cell { min-width:0; display:grid; gap:2px; justify-self:center; }
  .mep-field-label { font-size:13px; font-weight:700; line-height:1.2; color:rgba(255,255,255,0.85); }
  .mep-field-value {
    display:flex; align-items:center; gap:5px; flex-wrap:wrap; row-gap:2px;
    font-size:clamp(18px,5.6vw,23px); font-weight:900; line-height:1.15; color:#FFFFFF; font-variant-numeric:tabular-nums;
    text-shadow:0 1px 2px rgba(20,6,70,0.45);
  }
  .mep-field-value span { white-space:nowrap; }
  .mep-field-value.mep-amount-md { font-size:clamp(16px,4.8vw,20px); }
  .mep-field-value.mep-amount-sm { font-size:clamp(14px,4vw,17px); }
  .mep-field-value.mep-amount-xs { font-size:clamp(12px,3.3vw,14px); }
  .mep-field-value.mep-field-prize { color:#8CF06B; }
  .mep-field img.mep-coin { width:19px; height:19px; object-fit:contain; flex:0 0 auto; display:block; }
  .mep-field-divider { width:1px; height:40px; background:linear-gradient(180deg,rgba(255,255,255,0) 0%,rgba(255,255,255,0.45) 50%,rgba(255,255,255,0) 100%); }
  .mep-field-action {
    display:flex; align-items:center; justify-content:center; gap:6px; height:38px; border-radius:999px;
    background:linear-gradient(180deg,rgba(255,255,255,0.92) 0%,rgba(232,222,255,0.92) 100%); color:#5326C2;
    font-size:15px; font-weight:900; box-shadow:inset 0 1px 0 #FFFFFF,0 2px 6px rgba(20,6,70,0.25);
  }
  .mep-field-reason { margin-top:6px; font-size:12px; font-weight:700; line-height:1.3; color:#B42318; text-align:center; }
  .mep-field-reason[hidden] { display:none; }
  @media (max-width: 359px) {
    .mep-row { grid-template-columns:28px minmax(0,1fr) 1px minmax(0,1fr) 24px; column-gap:7px; padding:8px 8px 8px 7px; }
    .mep-stack { width:28px; height:28px; }
    .mep-amount { font-size:16px; gap:4px; }
    .mep-amount.mep-amount-md { font-size:14.5px; }
    .mep-amount.mep-amount-sm { font-size:12.5px; }
    .mep-amount.mep-amount-xs { font-size:11px; }
    .mep-amount img { width:14px; height:14px; }
    .mep-label { font-size:12px; }
    .mep-subtitle { font-size:13px; }
    .mep-mark { width:24px; height:24px; }
    .mep-title { font-size:20px; }
    .mep-head-icon { width:46px; height:46px; }
    .mep-head-icon img { width:34px; height:34px; }
    .mep-field-main { grid-template-columns:40px minmax(0,1fr) 1px minmax(0,1fr); column-gap:7px; }
    .mep-field .mep-stack { width:40px; height:40px; }
    .mep-field-value { font-size:17px; gap:4px; }
    .mep-field-value.mep-amount-md { font-size:15px; }
    .mep-field-value.mep-amount-sm { font-size:13px; }
    .mep-field-value.mep-amount-xs { font-size:11px; }
    .mep-field img.mep-coin { width:15px; height:15px; }
  }
  @media (max-height: 560px) {
    .mep-head { padding-top:10px; padding-bottom:8px; }
    .mep-subtitle { display:none; }
    .mep-row { min-height:58px; padding-top:5px; padding-bottom:5px; }
    .mep-confirm { height:46px; font-size:17px; }
  }
`

export function ensureMobileEntryPickerStyles(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = PICKER_CSS
  document.head.appendChild(style)
}

const CHECK_SVG = '<svg class="mep-check" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>'
const LOCK_SVG = '<svg class="mep-lock" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect width="16" height="11" x="4" y="11" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>'
const CLOSE_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6L6 18"/></svg>'
const CHEVRON_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M9 6l6 6-6 6"/></svg>'

function formatCoins(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
}

/** По-дълги суми — по-малък шрифт (без пренасяне на цифрите). */
function amountSizeClass(value: number | null): string {
  const length = value === null ? 1 : formatCoins(value).length
  return length <= 6 ? '' : length === 7 ? ' mep-amount-md' : length <= 10 ? ' mep-amount-sm' : ' mep-amount-xs'
}

function attr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function coinImg(className = ''): string {
  return `<img src="${COIN_ICON_URL}" alt="" aria-hidden="true"${className ? ` class="${className}"` : ''}>`
}

/** Наличност на ред при даден вариант: null — наличен, иначе причина. */
function resolveRowReason(row: { unavailableReason: string | null; prize: number | null }, variant: string, variantUnavailableText: string | undefined): string | null {
  if (row.unavailableReason) return row.unavailableReason
  if (row.prize === null) return variantUnavailableText ? variantUnavailableText.replace('{n}', variant) : FALLBACK_UNAVAILABLE
  return null
}

function prizeFor(row: MobileEntryPickerRow, variant: string): number | null {
  const prize = row.prizes[variant]
  return typeof prize === 'number' && Number.isSafeInteger(prize) && prize > 0 ? prize : null
}

/** Атрибути на картата на модалния прозорец (пряк родител на екрана). */
export function mobileEntryPickerCardAttributes(open = false): string {
  return `data-entry-picker-card="1"${open ? ' data-entry-picker-open="1"' : ''}`
}

/**
 * Полето във формата: скритият select + бутон, който отваря екрана.
 * HTML-ът не зависи от избора (освен атрибута selected): сумите се попълват
 * от bindMobileEntryPicker — запазената форма „Нова маса“
 * (data-lobby-keep-form) не се пресъздава заради избрания вход.
 */
export function renderMobileEntryPickerField(config: MobileEntryPickerConfig): string {
  const selectedRow = config.rows.find((row) => row.value === config.selected) ?? config.rows[0] ?? null
  const options = config.rows
    .map((row) => `<option value="${row.value}"${row === selectedRow ? ' selected' : ''}>${formatCoins(row.value)} жълтици</option>`)
    .join('')
  return `<select name="${attr(config.fieldName)}" data-entry-picker-select="1" hidden tabindex="-1" aria-hidden="true">${options}</select>
    <button type="button" class="mep-field" data-entry-picker-open-button="1" aria-haspopup="dialog">
      <span class="mep-field-main">
        <img class="mep-stack" src="${COIN_STACK_URL}" alt="" aria-hidden="true">
        <span class="mep-field-cell"><span class="mep-field-label">Вход</span><span class="mep-field-value"><span data-entry-picker-field-entry="1">—</span>${coinImg('mep-coin')}</span></span>
        <span class="mep-field-divider" aria-hidden="true"></span>
        <span class="mep-field-cell"><span class="mep-field-label">Награда</span><span class="mep-field-value mep-field-prize"><span data-entry-picker-field-prize="1">—</span>${coinImg('mep-coin')}</span></span>
      </span>
      <span class="mep-field-action">Промени ${CHEVRON_SVG}</span>
    </button>
    <div class="mep-field-reason" data-entry-picker-field-reason="1" role="status" hidden></div>`
}

/** Екранът „Избери вход“ — пряк наследник на картата на модалния прозорец. */
export function renderMobileEntryPickerScreen(config: MobileEntryPickerConfig): string {
  const current = config.open && config.pending !== undefined && config.pending !== null ? config.pending : config.selected
  const rowsHtml = config.rows.map((row) => {
    const prize = prizeFor(row, config.variant)
    const reason = resolveRowReason({ unavailableReason: row.unavailableReason, prize }, config.variant, config.variantUnavailableText)
    const isSelected = row.value === current
    const prizesAttr = attr(JSON.stringify(row.prizes))
    return `<label class="mep-row" data-entry-picker-row="${row.value}" data-prizes="${prizesAttr}"${row.unavailableReason ? ` data-base-reason="${attr(row.unavailableReason)}"` : ''} data-unavailable="${reason === null ? '0' : '1'}">
        <input type="radio" name="mep-pick-${attr(config.fieldName)}" value="${row.value}"${isSelected ? ' checked' : ''}${reason === null ? '' : ' disabled'} aria-label="Вход ${formatCoins(row.value)} жълтици">
        <img class="mep-stack" src="${COIN_STACK_URL}" alt="" aria-hidden="true">
        <span class="mep-col"><span class="mep-label">Вход</span><span class="mep-amount${amountSizeClass(row.value)}"><span>${formatCoins(row.value)}</span>${coinImg()}</span></span>
        <span class="mep-divider" aria-hidden="true"></span>
        <span class="mep-col"><span class="mep-label">Награда</span><span class="mep-amount mep-prize${amountSizeClass(prize)}"><span data-entry-picker-row-prize="1">${prize === null ? '—' : formatCoins(prize)}</span>${coinImg()}</span></span>
        <span class="mep-mark" aria-hidden="true">${CHECK_SVG}${LOCK_SVG}</span>
        <span class="mep-reason" data-entry-picker-row-reason="1"${reason === null ? ' hidden' : ''}>${reason === null ? '' : attr(reason)}</span>
      </label>`
  }).join('')
  return `<div class="mep-screen" data-entry-picker-screen="1" role="group" aria-labelledby="mep-title-${attr(config.fieldName)}"${config.variantFieldName ? ` data-variant-field="${attr(config.variantFieldName)}"` : ''}${config.variantUnavailableText ? ` data-variant-unavailable="${attr(config.variantUnavailableText)}"` : ''}>
      <div class="mep-head">
        <span class="mep-head-icon"><img src="${attr(config.iconUrl)}" alt="" aria-hidden="true"></span>
        <div class="mep-head-text">
          <h2 class="mep-title" id="mep-title-${attr(config.fieldName)}">Избери вход</h2>
          <p class="mep-subtitle">Вход и награда за частна маса</p>
        </div>
        <button type="button" class="mep-close" data-entry-picker-close="1" aria-label="Затвори без промяна">${CLOSE_SVG}</button>
      </div>
      <div class="mep-list" role="radiogroup" aria-label="Вход">${rowsHtml}</div>
      <div class="mep-foot">
        <button type="button" class="mep-confirm lobby-violet-btn violet-3d-btn" data-entry-picker-confirm="1">Потвърди</button>
      </div>
    </div>`
}

const boundCards = new WeakSet<HTMLElement>()

/**
 * Закача поведението към картата (веднъж на DOM възел). onStateChange — за
 * контролери, които прерисуват целия диалог и трябва да пазят отворения
 * екран и временния избор между прерисуванията.
 */
export function bindMobileEntryPicker(cardOrNull: HTMLElement | null, callbacks: { onStateChange?: (state: MobileEntryPickerState) => void } = {}): void {
  if (!cardOrNull || boundCards.has(cardOrNull)) return
  const card: HTMLElement = cardOrNull
  const screenOrNull = card.querySelector<HTMLElement>(':scope > [data-entry-picker-screen]')
  const selectOrNull = card.querySelector<HTMLSelectElement>('select[data-entry-picker-select]')
  const openButtonOrNull = card.querySelector<HTMLButtonElement>('[data-entry-picker-open-button]')
  if (!screenOrNull || !selectOrNull || !openButtonOrNull) return
  const screen: HTMLElement = screenOrNull
  const select: HTMLSelectElement = selectOrNull
  const openButton: HTMLButtonElement = openButtonOrNull
  boundCards.add(card)
  ensureMobileEntryPickerStyles()

  const rows = Array.from(screen.querySelectorAll<HTMLLabelElement>('[data-entry-picker-row]'))
  const confirm = screen.querySelector<HTMLButtonElement>('[data-entry-picker-confirm]')
  const variantFieldName = screen.dataset.variantField ?? ''
  const variantUnavailableText = screen.dataset.variantUnavailable
  const variantField = variantFieldName
    ? card.querySelector<HTMLSelectElement | HTMLInputElement>(`[name="${CSS.escape(variantFieldName)}"]`)
    : null

  const readVariant = (): string => variantField?.value ?? ''
  const rowReason = (row: HTMLElement): string | null => {
    let prizes: Record<string, number | null> = {}
    try { prizes = JSON.parse(row.dataset.prizes ?? '{}') as Record<string, number | null> } catch { prizes = {} }
    const variant = readVariant()
    const prize = prizes[variant]
    const safePrize = typeof prize === 'number' && Number.isSafeInteger(prize) && prize > 0 ? prize : null
    return resolveRowReason({ unavailableReason: row.dataset.baseReason ?? null, prize: safePrize }, variant, variantUnavailableText)
  }
  const rowPrize = (row: HTMLElement): number | null => {
    try {
      const prize = (JSON.parse(row.dataset.prizes ?? '{}') as Record<string, unknown>)[readVariant()]
      return typeof prize === 'number' && Number.isSafeInteger(prize) && prize > 0 ? prize : null
    } catch { return null }
  }
  const findRow = (value: number | null): HTMLElement | undefined => rows.find((row) => Number(row.dataset.entryPickerRow) === value)

  // Временният избор е в checked на радиото (HTML-ът иначе не зависи от избора).
  const checkedInput = screen.querySelector<HTMLInputElement>('[data-entry-picker-row] input:checked')
  let pending: number | null = Number(checkedInput?.value ?? select.value)

  const isOpen = (): boolean => card.getAttribute('data-entry-picker-open') === '1'
  const notify = (): void => callbacks.onStateChange?.({ open: isOpen(), pending: isOpen() ? pending : null })

  function syncRows(): void {
    for (const row of rows) {
      const reason = rowReason(row)
      const prize = rowPrize(row)
      const isSelected = Number(row.dataset.entryPickerRow) === pending
      row.dataset.selected = isSelected ? '1' : '0'
      row.dataset.unavailable = reason === null ? '0' : '1'
      const input = row.querySelector('input')
      if (input) { input.checked = isSelected; input.disabled = reason !== null }
      const prizeEl = row.querySelector('[data-entry-picker-row-prize]')
      if (prizeEl) {
        prizeEl.textContent = prize === null ? '—' : formatCoins(prize)
        if (prizeEl.parentElement) prizeEl.parentElement.className = `mep-amount mep-prize${amountSizeClass(prize)}`
      }
      const reasonEl = row.querySelector<HTMLElement>('[data-entry-picker-row-reason]')
      if (reasonEl) { reasonEl.textContent = reason ?? ''; reasonEl.hidden = reason === null }
    }
    const current = findRow(pending)
    if (confirm) confirm.disabled = !current || rowReason(current) !== null
  }

  function syncField(): void {
    const row = findRow(Number(select.value))
    const entryEl = openButton.querySelector('[data-entry-picker-field-entry]')
    const prizeEl = openButton.querySelector('[data-entry-picker-field-prize]')
    const reasonEl = card.querySelector<HTMLElement>('[data-entry-picker-field-reason]')
    const prize = row ? rowPrize(row) : null
    const reason = row ? rowReason(row) : null
    const entry = row ? Number(row.dataset.entryPickerRow) : null
    if (entryEl) entryEl.textContent = entry === null ? '—' : formatCoins(entry)
    if (prizeEl) prizeEl.textContent = prize === null ? '—' : formatCoins(prize)
    // По-дългата от двете суми определя размера и на двете (подравнени).
    const sizeClass = amountSizeClass(Math.max(entry ?? 0, prize ?? 0) || null)
    if (entryEl?.parentElement) entryEl.parentElement.className = `mep-field-value${sizeClass}`
    if (prizeEl?.parentElement) prizeEl.parentElement.className = `mep-field-value mep-field-prize${sizeClass}`
    if (reasonEl) { reasonEl.textContent = reason ?? ''; reasonEl.hidden = reason === null }
  }

  function open(): void {
    pending = Number(select.value)
    syncRows()
    card.setAttribute('data-entry-picker-open', '1')
    card.scrollTop = 0
    findRow(pending)?.scrollIntoView({ block: 'nearest' })
    screen.querySelector<HTMLButtonElement>('[data-entry-picker-close]')?.focus({ preventScroll: true })
    notify()
  }

  function close(): void {
    card.removeAttribute('data-entry-picker-open')
    openButton.focus({ preventScroll: true })
    notify()
  }

  openButton.addEventListener('click', open)
  screen.querySelector('[data-entry-picker-close]')?.addEventListener('click', close)
  for (const row of rows) {
    row.querySelector('input')?.addEventListener('change', (event) => {
      event.stopPropagation()
      if (rowReason(row) !== null) { syncRows(); return }
      pending = Number(row.dataset.entryPickerRow)
      syncRows()
      notify()
    })
  }
  confirm?.addEventListener('click', () => {
    const row = findRow(pending)
    if (!row || rowReason(row) !== null) return
    if (select.value !== String(pending)) {
      select.value = String(pending)
      select.dispatchEvent(new Event('change', { bubbles: true }))
    }
    syncField()
    close()
  })
  variantField?.addEventListener('change', () => { syncField(); syncRows() })
  syncRows()
  syncField()
  // Ако диалогът е прерисуван с отворен екран — показваме избрания ред.
  if (isOpen()) findRow(pending)?.scrollIntoView({ block: 'nearest' })
}
