// "Персонализация на профила", Етап 2 — прозорецът "Персонализация" от
// собствения профил (десктоп: тъмна тема; телефон: светлата мобилна тема).
//
//   * Четири разгъващи се секции (само една отворена): цвят на ника, цвят на
//     текста на съобщенията, емоджи пред и след ника.
//   * Цветове — малки квадратчета; емоджита — компактен каталог с лента за
//     категориите и вътрешно превъртане (≈13 на ред на десктоп, 9 на телефон).
//   * ЕДИН общ преглед на живо (renderUnifiedCustomizationPreview) в темата на
//     активния интерфейс — комбинира всички активни екстри с избраното.
//   * Срок 30..180 дни от падащо меню; крайната цена е от сървъра
//     (priceTable, изчислена от админ настройката) — клиентът не подава цена.
//   * Активна покупка: текущата екстра, дата на изтичане, оставащи дни и
//     "Удължи". Замяна на активна екстра изисква изрично потвърждение (и
//     сървърът го изисква — 409 replace_confirmation_required).
//   * "Плати" отваря Stripe Checkout. Активирането е единствено от webhook-а;
//     след връщане прозорецът само следи състоянието на поръчката.
//
// Всички данни идват от GET /api/profile-customization и се показват като
// текст (escape). Нищо не се записва в браузъра.

import { renderUnifiedCustomizationPreview } from './renderUnifiedCustomizationPreview'
import { getRoleNicknameColor } from '../lobby/roleNicknameColor'

type Kind = 'nickname_color' | 'message_color' | 'emoji_before' | 'emoji_after'

type KindInfo = {
  kind: Kind
  label: string
  itemType: 'color' | 'emoji'
  salesEnabled: boolean
  /** Може ли зрителят да я купи сега (публична продажба или тестов режим на admin). */
  purchasable?: boolean
  basePrice30DaysCents: number
  priceTable: Array<{ days: number; priceCents: number }>
}

type ColorItem = { colorId: string; hex: string; label: string; groupKey: string }
type EmojiItem = { emojiId: string; emoji: string; categoryKey: string }

type ActiveItem = {
  kind: Kind
  itemId: string
  value: string
  label: string | null
  activeUntil: string
  remainingDays: number
}

type ReturnPurchase = {
  purchaseId: string
  kind: Kind
  itemValue: string
  days: number
  status: string
  grantEffect: 'new' | 'extend' | 'replace' | null
  grantedUntil: string | null
}

type Snapshot = {
  kinds: KindInfo[]
  colors: ColorItem[]
  emojis: EmojiItem[]
  colorGroups: Array<{ key: string; label: string }>
  emojiCategories: Array<{ key: string; label: string; icon: string }>
  durations: number[]
  active: Record<Kind, ActiveItem | null>
  serverNow: string
  returnPurchase: ReturnPurchase | null
  /** Режим "Само админ" + пълен admin: тест на реалния поток (реални плащания). */
  adminTestMode?: boolean
}

export type ProfileCustomizationWindowDeps = {
  getApiBaseUrl: () => string
  displayName: string
  /** Темата на АКТИВНИЯ интерфейс (светлата мобилна рамка или десктоп), не размерът на екрана. */
  theme: 'dark' | 'light'
  /** Текущата служебна роля на зрителя — #F72585 има приоритет в прегледа. */
  nameHighlightRole?: string | null
  /** След връщане от Stripe: session id-то на поръчката ('success') или 'cancel'. */
  stripeReturn?: { status: 'success'; checkoutSessionId: string } | { status: 'cancel' } | null
  navigateToCheckout: (url: string) => void
}

type Selection = { itemId: string | null; days: number; acknowledgeReplace: boolean }

const HOST_ID = 'profile-customization-window'
const RETURN_POLL_INTERVAL_MS = 2_000
const RETURN_POLL_MAX_ATTEMPTS = 20

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Само за показване — цената е авторитетна на сървъра (в центове). */
function formatEuro(cents: number): string {
  return new Intl.NumberFormat('bg-BG', { style: 'currency', currency: 'EUR' }).format(cents / 100)
}

function formatDate(iso: string | null): string {
  if (iso === null) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('bg-BG', { timeZone: 'Europe/Sofia', day: '2-digit', month: '2-digit', year: 'numeric' }).format(date)
}

function formatDays(days: number): string {
  return `${days} ${days === 1 ? 'ден' : 'дни'}`
}

function isHexColor(value: string): boolean {
  return /^#[0-9A-F]{6}$/i.test(value)
}

const THEMES = {
  dark: {
    overlay: 'rgba(0,0,0,0.82)',
    bg: '#111111',
    border: 'rgba(212,165,32,0.35)',
    text: '#f1f5f9',
    muted: 'rgba(226,232,240,0.66)',
    accent: '#d4a520',
    card: 'rgba(255,255,255,0.03)',
    cardBorder: 'rgba(255,255,255,0.1)',
    input: '#1a1a1a',
    inputBorder: 'rgba(255,255,255,0.22)',
    primaryBg: 'linear-gradient(180deg,#f4c95b 0%,#c98f13 100%)',
    primaryText: '#080808',
    selected: '#f4c95b',
    warnBg: 'rgba(251,191,36,0.1)',
    warnBorder: 'rgba(251,191,36,0.45)',
    warnText: '#fde68a',
    okBg: 'rgba(134,239,172,0.08)',
    okBorder: 'rgba(134,239,172,0.35)',
    okText: '#dcfce7',
    errBg: 'rgba(248,113,113,0.08)',
    errBorder: 'rgba(248,113,113,0.45)',
    errText: '#fecaca',
  },
  light: {
    overlay: 'rgba(16,24,40,0.55)',
    bg: '#FFFFFF',
    border: '#EAECF0',
    text: '#101828',
    muted: '#667085',
    accent: '#6941C6',
    card: '#F9FAFB',
    cardBorder: '#EAECF0',
    input: '#FFFFFF',
    inputBorder: '#D0D5DD',
    primaryBg: 'linear-gradient(180deg,#7F56D9 0%,#6941C6 100%)',
    primaryText: '#FFFFFF',
    selected: '#6941C6',
    warnBg: '#FFFAEB',
    warnBorder: '#FEC84B',
    warnText: '#93370D',
    okBg: '#ECFDF3',
    okBorder: '#A6F4C5',
    okText: '#05603A',
    errBg: '#FEF3F2',
    errBorder: '#FECDCA',
    errText: '#B42318',
  },
} as const

export function showProfileCustomizationWindow(deps: ProfileCustomizationWindowDeps): { close: () => void } {
  document.getElementById(HOST_ID)?.remove()
  const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const t = THEMES[deps.theme]
  const isLight = deps.theme === 'light'

  const host = document.createElement('div')
  host.id = HOST_ID
  host.setAttribute('data-pc-theme', deps.theme)
  host.style.cssText = `position:fixed;inset:0;z-index:200000;overflow-y:auto;-webkit-overflow-scrolling:touch;background:${t.overlay};font-family:${isLight ? 'inherit' : 'Arial,Helvetica,sans-serif'};`
  document.body.appendChild(host)

  let snapshot: Snapshot | null = null
  let loadError: string | null = null
  let openKind: Kind | null = null
  const selections = new Map<Kind, Selection>()
  const emojiCategoryByKind = new Map<Kind, string>()
  let busyKind: Kind | null = null
  let returnPollTimer: ReturnType<typeof setTimeout> | null = null
  let returnPollAttempts = 0
  let returnSessionId: string | null = deps.stripeReturn?.status === 'success' ? deps.stripeReturn.checkoutSessionId : null

  const css = `
    #${HOST_ID} * { box-sizing:border-box; }
    #${HOST_ID} button { font-family:inherit; }
    #${HOST_ID} [data-pc-swatch] { width:30px;height:30px;border-radius:7px;border:2px solid transparent;padding:0;cursor:pointer;outline-offset:2px;box-shadow:inset 0 0 0 1px rgba(0,0,0,0.15); }
    #${HOST_ID} [data-pc-swatch][aria-pressed="true"] { border-color:${t.selected};box-shadow:0 0 0 2px ${t.bg},0 0 0 4px ${t.selected}; }
    #${HOST_ID} [data-pc-emoji-grid] { display:grid;grid-template-columns:repeat(13,minmax(0,1fr));gap:3px;max-height:220px;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:2px; }
    #${HOST_ID} [data-pc-emoji] { aspect-ratio:1;display:flex;align-items:center;justify-content:center;font-size:21px;line-height:1;border-radius:7px;border:1px solid transparent;background:transparent;cursor:pointer;padding:0;min-width:0; }
    #${HOST_ID} [data-pc-emoji]:hover { background:${t.card}; }
    #${HOST_ID} [data-pc-emoji][aria-pressed="true"] { border-color:${t.selected};background:${isLight ? '#F4EBFF' : 'rgba(212,165,32,0.16)'}; }
    #${HOST_ID} [data-pc-category] { flex:0 0 auto;width:38px;height:34px;border-radius:999px;border:1px solid ${t.cardBorder};background:transparent;font-size:18px;line-height:1;cursor:pointer;padding:0; }
    #${HOST_ID} [data-pc-category][aria-pressed="true"] { border-color:${t.selected};background:${isLight ? '#F4EBFF' : 'rgba(212,165,32,0.16)'}; }
    @media (max-width: 640px) {
      #${HOST_ID} [data-pc-emoji-grid] { grid-template-columns:repeat(9,minmax(0,1fr)); }
    }
  `

  host.innerHTML = `
    <style>${css}</style>
    <div style="min-height:100%;display:flex;justify-content:center;${isLight ? 'padding:0;' : 'padding:16px;'}">
      <section role="dialog" aria-modal="true" aria-labelledby="profile-customization-title" data-pc-dialog="1"
        style="width:${isLight ? '100%' : 'min(100%,680px)'};${isLight ? 'min-height:100%;' : 'border-radius:10px;align-self:flex-start;box-shadow:0 34px 80px rgba(0,0,0,0.48);'}border:1px solid ${t.border};background:${t.bg};color:${t.text};padding:16px;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:10px;">
          <h2 id="profile-customization-title" style="margin:0;font-size:20px;font-weight:900;color:${t.accent};">Персонализация</h2>
          <button type="button" data-pc-close="1" aria-label="Затвори" style="min-height:36px;padding:0 14px;border-radius:8px;border:1px solid ${t.inputBorder};background:transparent;color:${t.text};font-size:14px;font-weight:800;cursor:pointer;">Затвори</button>
        </div>
        <div data-pc-notice="1" role="status" aria-live="polite" style="display:none;margin:0 0 10px;padding:9px 11px;border-radius:8px;font-size:13px;line-height:1.45;"></div>
        <div data-pc-preview="1"></div>
        <div data-pc-body="1"></div>
      </section>
    </div>`

  const bodyEl = host.querySelector<HTMLElement>('[data-pc-body="1"]')!
  const previewEl = host.querySelector<HTMLElement>('[data-pc-preview="1"]')!
  const noticeEl = host.querySelector<HTMLElement>('[data-pc-notice="1"]')!

  const showNotice = (text: string | null, tone: 'ok' | 'error' | 'info' = 'ok') => {
    if (text === null) { noticeEl.style.display = 'none'; return }
    noticeEl.textContent = text
    noticeEl.style.display = ''
    noticeEl.setAttribute('data-pc-notice-tone', tone)
    const palette = tone === 'ok' ? [t.okBg, t.okBorder, t.okText] : tone === 'error' ? [t.errBg, t.errBorder, t.errText] : [t.warnBg, t.warnBorder, t.warnText]
    noticeEl.style.background = palette[0]
    noticeEl.style.border = `1px solid ${palette[1]}`
    noticeEl.style.color = palette[2]
  }

  // ─── Помощни ──────────────────────────────────────────────────────────

  const kindInfo = (kind: Kind): KindInfo | undefined => snapshot?.kinds.find((info) => info.kind === kind)
  const canBuy = (info: KindInfo): boolean => info.purchasable ?? info.salesEnabled

  const liveActive = (kind: Kind): ActiveItem | null => {
    const active = snapshot?.active[kind] ?? null
    return active !== null && Date.parse(active.activeUntil) > Date.now() ? active : null
  }

  const selectionFor = (kind: Kind): Selection => {
    let selection = selections.get(kind)
    if (selection === undefined) {
      selection = { itemId: null, days: snapshot?.durations[0] ?? 30, acknowledgeReplace: false }
      selections.set(kind, selection)
    }
    return selection
  }

  /** Стойност ('#hex' или емоджи) и име на артикул по id — от каталога или от активната екстра (скрит артикул). */
  const resolveItem = (kind: Kind, itemId: string | null): { value: string; label: string | null } | null => {
    if (itemId === null || snapshot === null) return null
    const info = kindInfo(kind)
    if (info?.itemType === 'color') {
      const color = snapshot.colors.find((candidate) => candidate.colorId === itemId)
      if (color) return { value: color.hex, label: color.label }
    } else {
      const emoji = snapshot.emojis.find((candidate) => candidate.emojiId === itemId)
      if (emoji) return { value: emoji.emoji, label: null }
    }
    const active = snapshot.active[kind]
    return active !== null && active.itemId === itemId ? { value: active.value, label: active.label } : null
  }

  type Effect = 'new' | 'extend' | 'replace'
  const effectFor = (kind: Kind, itemId: string | null): Effect => {
    const active = liveActive(kind)
    if (active === null || itemId === null) return 'new'
    return active.itemId === itemId ? 'extend' : 'replace'
  }

  const priceFor = (kind: Kind, days: number): number | null => kindInfo(kind)?.priceTable.find((row) => row.days === days)?.priceCents ?? null

  const itemChip = (kind: Kind, value: string, label: string | null): string => {
    if (kindInfo(kind)?.itemType === 'color' && isHexColor(value)) {
      return `<span style="display:inline-flex;align-items:center;gap:6px;vertical-align:middle;"><span style="display:inline-block;width:16px;height:16px;border-radius:4px;background:${value};box-shadow:inset 0 0 0 1px rgba(0,0,0,0.2);"></span><b>${escapeHtml(label ?? value)}</b></span>`
    }
    return `<span style="font-size:20px;line-height:1;vertical-align:middle;">${escapeHtml(value)}</span>`
  }

  // ─── Преглед на живо ──────────────────────────────────────────────────

  /** Избраното в отворената секция, иначе активната екстра — така прегледът показва крайния резултат. */
  const previewValue = (kind: Kind): string | null => {
    const selection = selections.get(kind)
    const selected = selection !== undefined ? resolveItem(kind, selection.itemId) : null
    if (selected !== null) return selected.value
    return liveActive(kind)?.value ?? null
  }

  const renderPreview = () => {
    if (snapshot === null) { previewEl.innerHTML = ''; return }
    // ЕДИН общ преглед (Етап 3) — комбинира активните екстри с избраното.
    previewEl.innerHTML = `<div style="margin-bottom:12px;">${renderUnifiedCustomizationPreview({
      displayName: deps.displayName,
      theme: deps.theme,
      staffNicknameColor: getRoleNicknameColor(deps.nameHighlightRole ?? null),
      nicknameColor: previewValue('nickname_color'),
      messageColor: previewValue('message_color'),
      emojiBefore: previewValue('emoji_before'),
      emojiAfter: previewValue('emoji_after'),
    })}</div>`
  }

  // ─── Секции ───────────────────────────────────────────────────────────

  const renderStatusLine = (kind: Kind): string => {
    const info = kindInfo(kind)
    const active = liveActive(kind)
    if (active !== null) {
      return `${itemChip(kind, active.value, active.label)} <span style="color:${t.muted};">до ${escapeHtml(formatDate(active.activeUntil))}</span>`
    }
    if (info !== undefined && !canBuy(info)) return `<span style="color:${t.muted};">Не се продава в момента</span>`
    return `<span style="color:${t.muted};">Не е активна${info !== undefined ? ` · от ${escapeHtml(formatEuro(info.basePrice30DaysCents))} за 30 дни` : ''}</span>`
  }

  const renderPicker = (kind: Kind): string => {
    if (snapshot === null) return ''
    const info = kindInfo(kind)
    const selection = selectionFor(kind)
    if (info?.itemType === 'color') {
      const groups = snapshot.colorGroups.map((group) => {
        const colors = snapshot!.colors.filter((color) => color.groupKey === group.key)
        if (colors.length === 0) return ''
        const swatches = colors.map((color) => `<button type="button" data-pc-swatch="${escapeHtml(color.colorId)}" aria-pressed="${selection.itemId === color.colorId}" aria-label="${escapeHtml(color.label)}" title="${escapeHtml(color.label)}" style="background:${color.hex};"></button>`).join('')
        return `<div style="min-width:0;"><div style="font-size:11px;color:${t.muted};margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(group.label)}</div><div style="display:flex;gap:6px;">${swatches}</div></div>`
      }).join('')
      return `<div data-pc-color-picker="1" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(112px,1fr));gap:10px 12px;margin:4px 0 12px;">${groups}</div>`
    }
    const currentCategory = emojiCategoryByKind.get(kind) ?? snapshot.emojiCategories[0]?.key ?? ''
    const strip = snapshot.emojiCategories.map((category) => `<button type="button" data-pc-category="${escapeHtml(category.key)}" aria-pressed="${category.key === currentCategory}" aria-label="${escapeHtml(category.label)}" title="${escapeHtml(category.label)}">${escapeHtml(category.icon)}</button>`).join('')
    const grid = snapshot.emojis
      .filter((emoji) => emoji.categoryKey === currentCategory)
      .map((emoji) => `<button type="button" data-pc-emoji="${escapeHtml(emoji.emojiId)}" aria-pressed="${selection.itemId === emoji.emojiId}" aria-label="${escapeHtml(emoji.emoji)}">${escapeHtml(emoji.emoji)}</button>`)
      .join('')
    const categoryLabel = snapshot.emojiCategories.find((category) => category.key === currentCategory)?.label ?? ''
    return `
      <div data-pc-emoji-picker="1" style="margin:4px 0 12px;">
        <div data-pc-category-strip="1" style="display:flex;gap:5px;overflow-x:auto;-webkit-overflow-scrolling:touch;padding-bottom:6px;">${strip}</div>
        <div style="font-size:12px;color:${t.muted};margin:2px 0 4px;">${escapeHtml(categoryLabel)}</div>
        <div data-pc-emoji-grid="1" style="border:1px solid ${t.cardBorder};border-radius:8px;">${grid}</div>
      </div>`
  }

  const renderSummary = (kind: Kind): string => {
    const info = kindInfo(kind)
    if (info === undefined || !canBuy(info)) return ''
    const selection = selectionFor(kind)
    const options = (snapshot?.durations ?? []).map((days) => {
      const price = priceFor(kind, days)
      return `<option value="${days}" ${days === selection.days ? 'selected' : ''}>${escapeHtml(formatDays(days))}${price !== null ? ` — ${escapeHtml(formatEuro(price))}` : ''}</option>`
    }).join('')
    const selected = resolveItem(kind, selection.itemId)
    const price = priceFor(kind, selection.days)
    const effect = effectFor(kind, selection.itemId)
    const active = liveActive(kind)

    let effectHtml = ''
    if (selected === null) {
      effectHtml = `<div style="font-size:13px;color:${t.muted};">Избери ${info.itemType === 'color' ? 'цвят' : 'емоджи'}, за да видиш крайната цена.</div>`
    } else if (effect === 'extend' && active !== null) {
      const until = new Date(Date.parse(active.activeUntil) + selection.days * 86_400_000).toISOString()
      effectHtml = `<div data-pc-effect="extend" style="font-size:13px;line-height:1.5;">Удължаване с ${escapeHtml(formatDays(selection.days))} — валидно до <b>${escapeHtml(formatDate(until))}</b> (остават ${active.remainingDays} + ${selection.days} дни).</div>`
    } else if (effect === 'replace' && active !== null) {
      effectHtml = `
        <div data-pc-replace-warning="1" role="alert" style="padding:10px 12px;border-radius:8px;border:1px solid ${t.warnBorder};background:${t.warnBg};color:${t.warnText};font-size:13px;line-height:1.5;">
          <b>Внимание:</b> текущата ти персонализация ${itemChip(kind, active.value, active.label)} ще бъде заменена веднага след успешното плащане. Оставащите <b>${escapeHtml(formatDays(active.remainingDays))}</b> ще бъдат загубени.
          <label style="display:flex;align-items:flex-start;gap:8px;margin-top:8px;cursor:pointer;">
            <input type="checkbox" data-pc-ack="${kind}" ${selection.acknowledgeReplace ? 'checked' : ''} style="width:18px;height:18px;margin:1px 0 0;flex:0 0 auto;">
            <span>Разбирам, че оставащите дни ще бъдат загубени.</span>
          </label>
        </div>`
    } else {
      const until = new Date(Date.now() + selection.days * 86_400_000).toISOString()
      effectHtml = `<div data-pc-effect="new" style="font-size:13px;line-height:1.5;">Валидно ${escapeHtml(formatDays(selection.days))} от потвърждаването на плащането (до ≈ <b>${escapeHtml(formatDate(until))}</b>).</div>`
    }

    const canPay = selected !== null && price !== null && (effect !== 'replace' || selection.acknowledgeReplace) && busyKind === null
    return `
      <div style="display:flex;flex-wrap:wrap;align-items:flex-end;gap:10px;margin-bottom:10px;">
        <label style="display:flex;flex-direction:column;gap:4px;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:${t.muted};">Продължителност
          <select data-pc-days="${kind}" style="min-height:38px;padding:0 10px;border-radius:8px;border:1px solid ${t.inputBorder};background:${t.input};color:${t.text};font-size:14px;font-family:inherit;">${options}</select>
        </label>
        <div style="margin-left:auto;text-align:right;">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:${t.muted};">Крайна цена</div>
          <div data-pc-price="${kind}" style="font-size:22px;font-weight:900;color:${t.text};">${price !== null && selected !== null ? escapeHtml(formatEuro(price)) : '—'}</div>
        </div>
      </div>
      ${effectHtml}
      <button type="button" data-pc-pay="${kind}" ${canPay ? '' : 'disabled'} style="margin-top:12px;width:100%;min-height:44px;border:0;border-radius:8px;background:${t.primaryBg};color:${t.primaryText};font-size:15px;font-weight:900;cursor:${canPay ? 'pointer' : 'not-allowed'};opacity:${canPay ? '1' : '0.5'};">${busyKind === kind ? 'Пренасочване към плащане…' : `Плати${price !== null && selected !== null ? ` ${escapeHtml(formatEuro(price))}` : ''}`}</button>
      <div style="margin-top:6px;font-size:11px;color:${t.muted};text-align:center;">Плащането е през Stripe. Персонализацията се активира след потвърждение на плащането.</div>`
  }

  const renderSectionBody = (kind: Kind): string => {
    const info = kindInfo(kind)
    if (info === undefined) return ''
    const active = liveActive(kind)
    const activeCard = active !== null ? `
      <div data-pc-active="${kind}" style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;border-radius:8px;border:1px solid ${t.okBorder};background:${t.okBg};margin-bottom:12px;">
        <div style="font-size:13px;line-height:1.55;color:${t.text};">
          Текуща: ${itemChip(kind, active.value, active.label)}<br>
          Изтича на <b>${escapeHtml(formatDate(active.activeUntil))}</b> · остават <b data-pc-remaining="${kind}">${escapeHtml(formatDays(active.remainingDays))}</b>
        </div>
        ${canBuy(info) ? `<button type="button" data-pc-extend="${kind}" style="min-height:36px;padding:0 14px;border-radius:8px;border:1px solid ${t.selected};background:transparent;color:${t.selected};font-size:14px;font-weight:900;cursor:pointer;">Удължи</button>` : ''}
      </div>` : ''
    if (!canBuy(info)) {
      return `${activeCard}<div data-pc-sales-disabled="${kind}" style="font-size:13px;color:${t.muted};padding:4px 0 6px;">Тази персонализация в момента не се продава.</div>`
    }
    return `
      ${activeCard}
      <div data-pc-picker-host="${kind}">${renderPicker(kind)}</div>
      <div data-pc-summary="${kind}">${renderSummary(kind)}</div>`
  }

  const render = () => {
    if (loadError !== null) {
      previewEl.innerHTML = ''
      bodyEl.innerHTML = `<div data-pc-load-error="1" style="padding:12px 0;font-size:14px;line-height:1.5;color:${t.errText};">${escapeHtml(loadError)}</div>`
      return
    }
    if (snapshot === null) {
      bodyEl.innerHTML = `<div style="padding:12px 0;font-size:14px;color:${t.muted};">Зареждане…</div>`
      return
    }
    renderPreview()
    const adminTestNotice = snapshot.adminTestMode === true
      ? `<div data-pc-admin-test="1" style="margin:0 0 10px;padding:9px 11px;border-radius:8px;border:1px solid ${t.warnBorder};background:${t.warnBg};color:${t.warnText};font-size:13px;line-height:1.45;">Тестов режим "Само админ": функцията не е публична, но плащанията през Stripe са <b>реални</b>.</div>`
      : ''
    bodyEl.innerHTML = adminTestNotice + snapshot.kinds.map((info) => {
      const isOpen = info.kind === openKind
      return `
        <div data-pc-section="${info.kind}" style="border:1px solid ${isOpen ? t.selected : t.cardBorder};border-radius:10px;background:${t.card};margin-bottom:8px;overflow:hidden;">
          <button type="button" data-pc-toggle="${info.kind}" aria-expanded="${isOpen}" aria-controls="pc-panel-${info.kind}"
            style="width:100%;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 14px;border:0;background:transparent;color:${t.text};cursor:pointer;text-align:left;">
            <span style="min-width:0;">
              <span style="display:block;font-size:15px;font-weight:900;">${escapeHtml(info.label)}</span>
              <span style="display:block;font-size:13px;margin-top:3px;">${renderStatusLine(info.kind)}</span>
            </span>
            <span aria-hidden="true" style="flex:0 0 auto;font-size:18px;color:${t.muted};transform:rotate(${isOpen ? '180deg' : '0deg'});transition:transform 0.15s;">▾</span>
          </button>
          ${isOpen ? `<div id="pc-panel-${info.kind}" data-pc-panel="${info.kind}" style="padding:2px 14px 14px;">${renderSectionBody(info.kind)}</div>` : ''}
        </div>`
    }).join('')
  }

  /** Частично обновяване без да се губи превъртането на каталога. */
  const refreshSelection = (kind: Kind) => {
    renderPreview()
    const selection = selectionFor(kind)
    bodyEl.querySelectorAll<HTMLElement>(`[data-pc-panel="${kind}"] [data-pc-swatch], [data-pc-panel="${kind}"] [data-pc-emoji]`).forEach((element) => {
      const id = element.getAttribute('data-pc-swatch') ?? element.getAttribute('data-pc-emoji')
      element.setAttribute('aria-pressed', String(id === selection.itemId))
    })
    const summary = bodyEl.querySelector<HTMLElement>(`[data-pc-summary="${kind}"]`)
    if (summary !== null) summary.innerHTML = renderSummary(kind)
  }

  // ─── Данни ────────────────────────────────────────────────────────────

  async function fetchSnapshot(): Promise<{ ok: true; data: Snapshot } | { ok: false; message: string }> {
    try {
      const query = returnSessionId !== null ? `?sessionId=${encodeURIComponent(returnSessionId)}` : ''
      const response = await fetch(`${deps.getApiBaseUrl()}/api/profile-customization${query}`, { credentials: 'include', cache: 'no-store' })
      const data = (await response.json().catch(() => null)) as (Snapshot & { ok?: boolean; message?: string; code?: string }) | null
      if (response.ok && data?.ok === true) return { ok: true, data }
      if (data?.code === 'feature_disabled') return { ok: false, message: 'Персонализацията в момента не е налична.' }
      return { ok: false, message: data?.message ?? 'Персонализацията не може да бъде заредена.' }
    } catch {
      return { ok: false, message: 'Няма връзка със сървъра.' }
    }
  }

  const applySnapshot = (data: Snapshot) => {
    snapshot = data
    loadError = null
    if (openKind === null) openKind = data.returnPurchase?.kind ?? data.kinds[0]?.kind ?? null
    for (const info of data.kinds) {
      const selection = selectionFor(info.kind)
      if (selection.itemId === null) selection.itemId = liveActive(info.kind)?.itemId ?? null
      if (!data.durations.includes(selection.days)) selection.days = data.durations[0] ?? 30
      if (!emojiCategoryByKind.has(info.kind) && info.itemType === 'emoji') {
        const activeEmoji = data.emojis.find((emoji) => emoji.emojiId === selection.itemId)
        emojiCategoryByKind.set(info.kind, activeEmoji?.categoryKey ?? data.emojiCategories[0]?.key ?? '')
      }
    }
  }

  const load = async () => {
    const result = await fetchSnapshot()
    if (!host.isConnected) return
    if (result.ok) applySnapshot(result.data)
    else loadError = result.message
    render()
    if (result.ok) handleReturnState(result.data.returnPurchase)
  }

  // След връщане от Stripe: webhook-ът може да закъснее — следим поръчката
  // ограничено време, без да активираме нищо от клиента.
  const handleReturnState = (purchase: ReturnPurchase | null) => {
    if (returnSessionId === null) return
    if (purchase === null || purchase.status === 'pending') {
      if (returnPollAttempts >= RETURN_POLL_MAX_ATTEMPTS) {
        showNotice('Плащането още се потвърждава. Персонализацията ще се активира автоматично веднага щом Stripe го потвърди.', 'info')
        returnSessionId = null
        return
      }
      showNotice('Плащането се потвърждава…', 'info')
      returnPollAttempts += 1
      returnPollTimer = setTimeout(() => { void load() }, RETURN_POLL_INTERVAL_MS)
      return
    }
    returnSessionId = null
    if (purchase.status === 'paid') {
      const verb = purchase.grantEffect === 'extend' ? 'е удължена' : 'е активирана'
      showNotice(`Плащането е успешно — персонализацията ${verb} до ${formatDate(purchase.grantedUntil)}.`, 'ok')
    } else if (purchase.status === 'refunded') {
      showNotice('Плащането е възстановено — персонализацията не е активирана.', 'error')
    } else {
      showNotice('Плащането не е завършено. Нищо не е таксувано и нищо не е променено.', 'error')
    }
  }

  const pay = async (kind: Kind) => {
    const selection = selectionFor(kind)
    if (selection.itemId === null || busyKind !== null) return
    busyKind = kind
    showNotice(null)
    refreshSelection(kind)
    let failureMessage: string | null = null
    try {
      const response = await fetch(`${deps.getApiBaseUrl()}/api/profile-customization/checkout`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, itemId: selection.itemId, days: selection.days, acknowledgeReplace: selection.acknowledgeReplace }),
      })
      const data = (await response.json().catch(() => null)) as { ok?: boolean; checkoutUrl?: string; message?: string; code?: string } | null
      if (response.ok && data?.ok === true && typeof data.checkoutUrl === 'string') {
        deps.navigateToCheckout(data.checkoutUrl)
        return
      }
      failureMessage = data?.message ?? 'Плащането не може да започне в момента.'
      if (data?.code === 'replace_confirmation_required') {
        // Състоянието се е променило (напр. от друг таб) — показваме
        // актуалното предупреждение и искаме ново потвърждение.
        selection.acknowledgeReplace = false
        busyKind = null
        await load()
      }
    } catch {
      failureMessage = 'Няма връзка със сървъра.'
    }
    busyKind = null
    if (!host.isConnected) return
    refreshSelection(kind)
    showNotice(failureMessage, 'error')
  }

  // ─── Събития ──────────────────────────────────────────────────────────

  const close = () => {
    if (returnPollTimer !== null) clearTimeout(returnPollTimer)
    document.removeEventListener('keydown', onKeydown, true)
    host.remove()
    previouslyFocused?.focus?.()
  }

  const onKeydown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    close()
  }
  document.addEventListener('keydown', onKeydown, true)

  host.querySelector<HTMLButtonElement>('[data-pc-close="1"]')!.addEventListener('click', close)
  host.addEventListener('click', (event) => {
    // Клик извън прозореца (само десктоп) затваря.
    if (!isLight && event.target === host.firstElementChild?.nextElementSibling) close()
  })

  bodyEl.addEventListener('click', (event) => {
    const target = event.target as HTMLElement

    const toggle = target.closest<HTMLElement>('[data-pc-toggle]')
    if (toggle !== null) {
      const kind = toggle.getAttribute('data-pc-toggle') as Kind
      openKind = openKind === kind ? null : kind
      render()
      return
    }

    const swatch = target.closest<HTMLElement>('[data-pc-swatch]')
    const emoji = target.closest<HTMLElement>('[data-pc-emoji]')
    if ((swatch !== null || emoji !== null) && openKind !== null) {
      const selection = selectionFor(openKind)
      selection.itemId = swatch?.getAttribute('data-pc-swatch') ?? emoji?.getAttribute('data-pc-emoji') ?? null
      selection.acknowledgeReplace = false
      refreshSelection(openKind)
      return
    }

    const category = target.closest<HTMLElement>('[data-pc-category]')
    if (category !== null && openKind !== null) {
      emojiCategoryByKind.set(openKind, category.getAttribute('data-pc-category') ?? '')
      const pickerHost = bodyEl.querySelector<HTMLElement>(`[data-pc-picker-host="${openKind}"]`)
      if (pickerHost !== null) {
        const stripScroll = pickerHost.querySelector<HTMLElement>('[data-pc-category-strip="1"]')?.scrollLeft ?? 0
        pickerHost.innerHTML = renderPicker(openKind)
        const strip = pickerHost.querySelector<HTMLElement>('[data-pc-category-strip="1"]')
        if (strip !== null) strip.scrollLeft = stripScroll
      }
      return
    }

    const extend = target.closest<HTMLElement>('[data-pc-extend]')
    if (extend !== null) {
      const kind = extend.getAttribute('data-pc-extend') as Kind
      const active = liveActive(kind)
      if (active === null) return
      const selection = selectionFor(kind)
      selection.itemId = active.itemId
      selection.acknowledgeReplace = false
      const activeEmoji = snapshot?.emojis.find((candidate) => candidate.emojiId === active.itemId)
      if (activeEmoji) emojiCategoryByKind.set(kind, activeEmoji.categoryKey)
      render()
      bodyEl.querySelector<HTMLElement>(`[data-pc-days="${kind}"]`)?.focus()
      return
    }

    const payButton = target.closest<HTMLElement>('[data-pc-pay]')
    if (payButton !== null) {
      void pay(payButton.getAttribute('data-pc-pay') as Kind)
    }
  })

  bodyEl.addEventListener('change', (event) => {
    const target = event.target as HTMLElement
    const daysKind = target.getAttribute('data-pc-days') as Kind | null
    if (daysKind !== null) {
      selectionFor(daysKind).days = Number((target as HTMLSelectElement).value)
      refreshSelection(daysKind)
      bodyEl.querySelector<HTMLElement>(`[data-pc-days="${daysKind}"]`)?.focus()
      return
    }
    const ackKind = target.getAttribute('data-pc-ack') as Kind | null
    if (ackKind !== null) {
      selectionFor(ackKind).acknowledgeReplace = (target as HTMLInputElement).checked
      refreshSelection(ackKind)
    }
  })

  if (deps.stripeReturn?.status === 'cancel') {
    showNotice('Плащането е отказано. Нищо не е таксувано и нищо не е променено.', 'info')
  }

  render()
  void load()
  host.querySelector<HTMLButtonElement>('[data-pc-close="1"]')!.focus()
  return { close }
}
