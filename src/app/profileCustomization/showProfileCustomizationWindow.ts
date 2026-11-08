// "Персонализация на профила" — прозорецът "Персонализация" от собствения
// профил (десктоп: тъмна тема; телефон: светлата мобилна тема).
//
//   * Четири разгъващи се секции (само една отворена): цвят на ника, цвят на
//     текста на съобщенията, емоджи пред и след ника.
//   * Цветове — 5 квадратчета с имена; емоджита — компактен каталог с лента
//     за категориите и вътрешно превъртане (≈13 на ред на десктоп, 9 на телефон).
//   * Инвентар "Моите персонализации": всички закупени и неизтекли варианти
//     (може няколко от вид), всеки със собствен срок; използва се най-много
//     един на вид. "Използвай" / "Премахни" са безплатни и не пипат сроковете.
//   * Каталогът отбелязва закупените: контур + ✓ = закупен (наличен),
//     рамка + ● = използва се. Детайлите (срок, действия) са в панел под
//     каталога при избор — без текст във всяка клетка.
//   * Потребителят избира една или няколко екстри за покупка (всяка със
//     собствен срок 30..180 дни). Притежаван вариант = удължаване (дните се
//     добавят); друг вариант = добавяне в инвентара (нищо не се губи).
//   * ЕДИН общ преглед на живо — използваните екстри + временно избраните за
//     покупка. Непосредствено под него: брой избрани, обобщение, обща цена и
//     ЕДИН бутон "Плати XX,XX €" -> ЕДНО Stripe плащане.
//   * Цените са от сървъра (priceTable от админ настройката); бутонът носи
//     показаната сума и сървърът отказва при разлика (409 price_changed).
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

type OwnedItem = ActiveItem & { equipped: boolean }

type ReturnOrderItem = {
  kind: Kind
  kindLabel: string
  itemValue: string
  days: number
  status: string
  grantEffect: 'new' | 'extend' | 'replace' | null
  grantedUntil: string | null
}

type ReturnOrder = {
  orderId: string
  status: string
  totalCents: number
  items: ReturnOrderItem[]
}

type Snapshot = {
  kinds: KindInfo[]
  colors: ColorItem[]
  emojis: EmojiItem[]
  colorGroups: Array<{ key: string; label: string }>
  emojiCategories: Array<{ key: string; label: string; icon: string }>
  durations: number[]
  /** Използваните в момента (по една на вид). */
  active: Record<Kind, ActiveItem | null>
  /** "Моите персонализации" — всички притежавани неизтекли варианти. */
  owned?: OwnedItem[]
  serverNow: string
  returnOrder: ReturnOrder | null
  /** Режим "Само админ" + пълен admin: тест на реалния поток (реални плащания). */
  adminTestMode?: boolean
  /** Само в административен режим (GET /api/admin/profile-customization/targets/:id). */
  target?: { profileId: string; displayName: string; accountRole: string | null; eligible: boolean; isSelf: boolean }
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
  /**
   * Само пълен admin (сървърът проверява ролята при всяка заявка):
   *   isSelf=true  — собственият профил: "Плати XX,XX €" (реален Stripe) И
   *                  "Приложи безплатно (Админ)";
   *   isSelf=false — чужд профил: само "Приложи безплатно" (без Stripe),
   *                  каталогът/инвентарът/никът са на получателя.
   */
  adminGrant?: { targetProfileId: string; isSelf: boolean } | null
}

/** itemId === null -> видът НЕ е в поръчката. */
type Selection = { itemId: string | null; days: number }

type Effect = 'new' | 'extend'

type CartLine = {
  kind: Kind
  label: string
  value: string
  itemLabel: string | null
  days: number
  priceCents: number
  effect: Effect
}

const HOST_ID = 'profile-customization-window'

/** Стандартен чек ✓ (бял, векторен) за маркера "закупен / наличен". */
const CHECK_ICON_URL = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='white' stroke-width='4' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M5 12.5l4.5 4.5L19 7.5'/%3E%3C/svg%3E")`
const RETURN_POLL_INTERVAL_MS = 2_000
const RETURN_POLL_MAX_ATTEMPTS = 20
const KIND_ORDER: readonly Kind[] = ['nickname_color', 'message_color', 'emoji_before', 'emoji_after']

const EFFECT_SHORT_LABELS: Record<Effect, string> = {
  new: 'Нова',
  extend: 'Удължаване',
}

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

function formatSelectedCount(count: number): string {
  return count === 1 ? '1 избрана екстра' : `${count} избрани екстри`
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
    selectedBg: 'rgba(212,165,32,0.16)',
    owned: '#86efac',
    ownedBg: 'rgba(134,239,172,0.1)',
    /** Плътен зелен фон на маркера ✓ (бял чек — контрастен и на тъмен фон). */
    ownedBadge: '#16A34A',
    equipped: '#38bdf8',
    equippedBg: 'rgba(56,189,248,0.14)',
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
    selectedBg: '#F4EBFF',
    owned: '#079455',
    ownedBg: '#ECFDF3',
    ownedBadge: '#079455',
    equipped: '#1570EF',
    equippedBg: '#EFF8FF',
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
  /** Притежаван вариант, избран в каталога -> панел с детайли (срок, действия). */
  const detailByKind = new Map<Kind, string>()
  let paying = false
  let equipBusy = false
  /** Административен режим: безплатно предоставяне (собствен или чужд профил). */
  const adminGrant = deps.adminGrant ?? null
  const foreignMode = adminGrant !== null && !adminGrant.isSelf
  let granting = false
  let grantConfirmOpen = false
  let returnPollTimer: ReturnType<typeof setTimeout> | null = null
  let returnPollAttempts = 0
  let returnSessionId: string | null = deps.stripeReturn?.status === 'success' ? deps.stripeReturn.checkoutSessionId : null

  // Маркери в каталога (без надписи в клетките):
  //   [data-pc-owned="available"] — закупен: зелен контур + ✓ в ъгъла;
  //   [data-pc-owned="equipped"]  — използва се: синя рамка + ●;
  //   [aria-pressed="true"]       — избран за покупка (златиста/лилава рамка).
  const css = `
    #${HOST_ID} * { box-sizing:border-box; }
    #${HOST_ID} button { font-family:inherit; }
    #${HOST_ID} [data-pc-swatch] { position:relative;width:34px;height:34px;border-radius:8px;border:2px solid transparent;padding:0;cursor:pointer;outline-offset:2px;box-shadow:inset 0 0 0 1px rgba(0,0,0,0.15); }
    #${HOST_ID} [data-pc-swatch][aria-pressed="true"] { border-color:${t.selected};box-shadow:0 0 0 2px ${t.bg},0 0 0 4px ${t.selected}; }
    #${HOST_ID} [data-pc-emoji-grid] { display:grid;grid-template-columns:repeat(13,minmax(0,1fr));gap:3px;max-height:220px;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:6px; }
    #${HOST_ID} [data-pc-emoji] { position:relative;aspect-ratio:1;display:flex;align-items:center;justify-content:center;font-size:21px;line-height:1;border-radius:7px;border:1px solid transparent;background:transparent;cursor:pointer;padding:0;min-width:0; }
    #${HOST_ID} [data-pc-emoji]:hover { background:${t.card}; }
    #${HOST_ID} [data-pc-emoji][aria-pressed="true"] { border-color:${t.selected};background:${t.selectedBg}; }
    #${HOST_ID} [data-pc-owned="available"][data-pc-emoji] { border:1px dashed ${t.owned};background:${t.ownedBg}; }
    #${HOST_ID} [data-pc-owned="equipped"][data-pc-emoji] { border:2px solid ${t.equipped};background:${t.equippedBg}; }
    #${HOST_ID} [data-pc-owned="available"][data-pc-swatch] { box-shadow:0 0 0 2px ${t.bg},0 0 0 4px ${t.owned}; }
    #${HOST_ID} [data-pc-owned="equipped"][data-pc-swatch] { box-shadow:0 0 0 2px ${t.bg},0 0 0 5px ${t.equipped}; }
    /* Маркерите в ъгъла: "✓" = закупен/наличен (бял чек върху плътно зелено),
       "●" = използва се (бяла точка върху синьо). Рамка в цвета на фона, за
       да се отделят от клетката; чекът е векторен — остър на всякакъв екран. */
    #${HOST_ID} [data-pc-owned]::after, #${HOST_ID} .pc-marker { box-sizing:border-box;width:18px;height:18px;border-radius:999px;border:2px solid ${t.bg};box-shadow:0 1px 2px rgba(0,0,0,0.3);color:#fff;font-family:Arial,Helvetica,sans-serif;font-size:9px;line-height:14px;text-align:center; }
    #${HOST_ID} [data-pc-owned]::after { position:absolute;top:-5px;right:-5px;pointer-events:none; }
    #${HOST_ID} [data-pc-owned="available"]::after, #${HOST_ID} .pc-marker[data-pc-marker="available"] { content:'';background:${t.ownedBadge} ${CHECK_ICON_URL} center / 11px 11px no-repeat; }
    #${HOST_ID} [data-pc-owned="equipped"]::after, #${HOST_ID} .pc-marker[data-pc-marker="equipped"] { content:'●';background:${t.equipped}; }
    #${HOST_ID} .pc-marker { display:inline-block;vertical-align:-4px; }
    #${HOST_ID} [data-pc-category] { flex:0 0 auto;width:38px;height:34px;border-radius:999px;border:1px solid ${t.cardBorder};background:transparent;font-size:18px;line-height:1;cursor:pointer;padding:0; }
    #${HOST_ID} [data-pc-category][aria-pressed="true"] { border-color:${t.selected};background:${t.selectedBg}; }
    #${HOST_ID} [data-pc-inventory-grid] { display:grid;grid-template-columns:repeat(auto-fill,minmax(172px,1fr));gap:6px; }
    #${HOST_ID} .pc-owned-head { display:flex;align-items:center;gap:8px;min-width:0; }
    #${HOST_ID} .pc-owned-text { min-width:0;flex:1 1 auto; }
    #${HOST_ID} .pc-owned-name { font-size:13px;font-weight:900;white-space:nowrap;overflow:hidden;text-overflow:ellipsis; }
    #${HOST_ID} .pc-owned-meta { display:flex;flex-wrap:wrap;column-gap:4px;font-size:11px;color:${t.muted}; }
    #${HOST_ID} .pc-owned-meta > span { white-space:nowrap; }
    #${HOST_ID} .pc-owned-badge-below { margin-top:3px; }
    #${HOST_ID} .pc-owned-badge-side { display:none;flex:0 0 auto; }
    #${HOST_ID} [data-pc-status-badge] { white-space:nowrap; }
    #${HOST_ID} .pc-owned-actions { display:flex;gap:4px;margin-top:6px; }
    #${HOST_ID} .pc-small-btn { min-height:28px;padding:0 8px;border-radius:7px;border:1px solid ${t.inputBorder};background:transparent;color:${t.text};font-size:12px;font-weight:800;cursor:pointer;white-space:nowrap; }
    #${HOST_ID} .pc-small-btn[data-tone="use"] { border-color:${t.equipped};color:${t.equipped}; }
    #${HOST_ID} .pc-small-btn[data-tone="extend"] { border-color:${t.selected};color:${t.selected}; }
    #${HOST_ID} .pc-small-btn:disabled { opacity:0.5;cursor:not-allowed; }
    @media (max-width: 640px) {
      #${HOST_ID} [data-pc-emoji-grid] { grid-template-columns:repeat(9,minmax(0,1fr)); }
      /* Телефон: по ЕДНА карта на ред на цялата ширина. Първи ред — визуал,
         име + срок, компактен статус вдясно; втори ред — двата бутона с
         еднаква ширина. */
      #${HOST_ID} [data-pc-inventory-grid] { grid-template-columns:minmax(0,1fr);gap:8px; }
      #${HOST_ID} [data-pc-owned-card] { padding:10px 12px !important; }
      #${HOST_ID} .pc-owned-head { gap:10px; }
      #${HOST_ID} .pc-owned-name { font-size:14px; }
      #${HOST_ID} .pc-owned-meta { font-size:12px; }
      #${HOST_ID} .pc-owned-badge-below { display:none; }
      #${HOST_ID} .pc-owned-badge-side { display:block; }
      #${HOST_ID} .pc-owned-actions { display:grid;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr);gap:8px;margin-top:8px; }
      #${HOST_ID} .pc-owned-actions .pc-small-btn { width:100%;min-height:36px;font-size:13px;overflow:hidden;text-overflow:ellipsis; }
    }
    @media (max-width: 360px) {
      /* Много тесни телефони (320–360 px): по-малки отстъпи, за да остане картата ниска. */
      #${HOST_ID} [data-pc-owned-card] { padding:8px 10px !important; }
      #${HOST_ID} .pc-owned-head { gap:8px; }
      #${HOST_ID} .pc-owned-actions { gap:6px;margin-top:6px; }
      #${HOST_ID} .pc-owned-actions .pc-small-btn { min-height:34px; }
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
        <div data-pc-cart-host="1"></div>
        <div data-pc-inventory-host="1"></div>
        <div data-pc-body="1"></div>
      </section>
    </div>`

  const bodyEl = host.querySelector<HTMLElement>('[data-pc-body="1"]')!
  const previewEl = host.querySelector<HTMLElement>('[data-pc-preview="1"]')!
  const cartEl = host.querySelector<HTMLElement>('[data-pc-cart-host="1"]')!
  const inventoryEl = host.querySelector<HTMLElement>('[data-pc-inventory-host="1"]')!
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
  // Безплатното предоставяне не зависи от публичната продажба.
  const canBuy = (info: KindInfo): boolean => foreignMode || (info.purchasable ?? info.salesEnabled)
  /** Името/ролята в прегледа — на получателя в чужд профил. */
  const previewName = (): string => (foreignMode ? snapshot?.target?.displayName : null) ?? deps.displayName
  const previewRole = (): string | null => foreignMode ? snapshot?.target?.accountRole ?? null : deps.nameHighlightRole ?? null
  const isLive = (item: { activeUntil: string }): boolean => Date.parse(item.activeUntil) > Date.now()

  /** Използваният в момента вариант на вида (неизтекъл). */
  const equippedFor = (kind: Kind): ActiveItem | null => {
    const active = snapshot?.active[kind] ?? null
    return active !== null && isLive(active) ? active : null
  }

  const ownedList = (kind?: Kind): OwnedItem[] => (snapshot?.owned ?? []).filter((item) => isLive(item) && (kind === undefined || item.kind === kind))
  const ownedFor = (kind: Kind, itemId: string | null): OwnedItem | null => itemId === null ? null : ownedList(kind).find((item) => item.itemId === itemId) ?? null
  const ownedState = (kind: Kind, itemId: string): 'equipped' | 'available' | null => {
    const owned = ownedFor(kind, itemId)
    if (owned === null) return null
    return equippedFor(kind)?.itemId === itemId ? 'equipped' : 'available'
  }

  const selectionFor = (kind: Kind): Selection => {
    let selection = selections.get(kind)
    if (selection === undefined) {
      selection = { itemId: null, days: snapshot?.durations[0] ?? 30 }
      selections.set(kind, selection)
    }
    return selection
  }

  /** Стойност ('#hex' или емоджи) и име по id — от каталога или от притежаван (вкл. спрян от продажба) вариант. */
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
    const owned = ownedFor(kind, itemId)
    if (owned !== null) return { value: owned.value, label: owned.label }
    const active = snapshot.active[kind]
    return active !== null && active.itemId === itemId ? { value: active.value, label: active.label } : null
  }

  /** Притежаван валиден вариант -> удължаване; иначе -> добавяне в инвентара. */
  const effectFor = (kind: Kind, itemId: string | null): Effect => ownedFor(kind, itemId) !== null ? 'extend' : 'new'

  const priceFor = (kind: Kind, days: number): number | null => kindInfo(kind)?.priceTable.find((row) => row.days === days)?.priceCents ?? null

  /** Избраните за покупка (само купуваемите видове с разпознат артикул и цена), подредени по вид. */
  const cartLines = (): CartLine[] => {
    if (snapshot === null) return []
    const lines: CartLine[] = []
    for (const kind of KIND_ORDER) {
      const info = kindInfo(kind)
      const selection = selections.get(kind)
      if (info === undefined || !canBuy(info) || selection === undefined || selection.itemId === null) continue
      const item = resolveItem(kind, selection.itemId)
      const priceCents = priceFor(kind, selection.days)
      if (item === null || priceCents === null) continue
      lines.push({ kind, label: info.label, value: item.value, itemLabel: item.label, days: selection.days, priceCents, effect: effectFor(kind, selection.itemId) })
    }
    return lines
  }

  const itemChip = (kind: Kind, value: string, label: string | null): string => {
    if (kindInfo(kind)?.itemType === 'color' && isHexColor(value)) {
      return `<span style="display:inline-flex;align-items:center;gap:6px;vertical-align:middle;"><span style="display:inline-block;width:16px;height:16px;border-radius:4px;background:${value};box-shadow:inset 0 0 0 1px rgba(0,0,0,0.2);"></span><b>${escapeHtml(label ?? value)}</b></span>`
    }
    return `<span style="font-size:20px;line-height:1;vertical-align:middle;">${escapeHtml(value)}</span>`
  }

  const itemName = (kind: Kind, value: string, label: string | null): string => kindInfo(kind)?.itemType === 'color' ? (label ?? value) : value

  const statusBadge = (state: 'equipped' | 'available'): string => state === 'equipped'
    ? `<span data-pc-status-badge="equipped" style="display:inline-block;padding:1px 7px;border-radius:999px;border:1px solid ${t.equipped};background:${t.equippedBg};color:${t.equipped};font-size:11px;font-weight:900;">Използва се</span>`
    : `<span data-pc-status-badge="available" style="display:inline-block;padding:1px 7px;border-radius:999px;border:1px solid ${t.owned};background:${t.ownedBg};color:${t.owned};font-size:11px;font-weight:900;">Наличен</span>`

  /** Бутоните за притежаван вариант: Използвай/Премахни + Удължи (или "Махни от поръчката"). */
  const ownedActions = (kind: Kind, itemId: string, state: 'equipped' | 'available'): string => {
    const info = kindInfo(kind)
    const inCart = selections.get(kind)?.itemId === itemId
    // Чужд профил: admin вижда състоянието, но смяната е на получателя.
    const useButton = foreignMode ? '' : state === 'equipped'
      ? `<button type="button" class="pc-small-btn" data-pc-unequip="${kind}" ${equipBusy ? 'disabled' : ''}>Премахни</button>`
      : `<button type="button" class="pc-small-btn" data-tone="use" data-pc-equip="${kind}|${escapeHtml(itemId)}" ${equipBusy ? 'disabled' : ''}>Използвай</button>`
    const extendButton = info !== undefined && canBuy(info)
      ? inCart
        ? `<button type="button" class="pc-small-btn" data-pc-remove="${kind}">Махни от поръчката</button>`
        : `<button type="button" class="pc-small-btn" data-tone="extend" data-pc-extend-item="${kind}|${escapeHtml(itemId)}">Удължи</button>`
      : ''
    return `${useButton}${extendButton}`
  }

  // ─── Преглед на живо + обобщение на поръчката ─────────────────────────

  /** Избраното за покупка (ако има), иначе използваното — така прегледът показва крайния резултат. */
  const previewValue = (kind: Kind): string | null => {
    const selection = selections.get(kind)
    const selected = selection !== undefined ? resolveItem(kind, selection.itemId) : null
    if (selected !== null) return selected.value
    return equippedFor(kind)?.value ?? null
  }

  const renderPreview = () => {
    if (snapshot === null) { previewEl.innerHTML = ''; return }
    const recipient = foreignMode && snapshot.target !== undefined
      ? `<div data-pc-recipient="${escapeHtml(snapshot.target.profileId)}" style="margin:0 0 8px;padding:8px 11px;border-radius:8px;border:1px solid ${t.warnBorder};background:${t.warnBg};color:${t.warnText};font-size:13px;line-height:1.45;">Административно предоставяне на: <b>${escapeHtml(snapshot.target.displayName)}</b>${snapshot.target.eligible ? '' : ' — <b>профилът не може да получава персонализации</b>'}</div>`
      : ''
    previewEl.innerHTML = `${recipient}<div style="margin-bottom:10px;">${renderUnifiedCustomizationPreview({
      displayName: previewName(),
      theme: deps.theme,
      staffNicknameColor: getRoleNicknameColor(previewRole()),
      nicknameColor: previewValue('nickname_color'),
      messageColor: previewValue('message_color'),
      emojiBefore: previewValue('emoji_before'),
      emojiAfter: previewValue('emoji_after'),
    })}</div>`
  }

  const renderCart = () => {
    if (snapshot === null) { cartEl.innerHTML = ''; return }
    const lines = cartLines()
    const totalCents = lines.reduce((sum, line) => sum + line.priceCents, 0)
    const canPay = lines.length > 0 && !paying
    const rows = lines.map((line) => `
      <li data-pc-cart-line="${line.kind}" data-pc-cart-effect="${line.effect}" style="list-style:none;display:flex;align-items:center;gap:8px;padding:6px 0;border-top:1px solid ${t.cardBorder};font-size:13px;line-height:1.4;">
        <span style="flex:1 1 auto;min-width:0;overflow-wrap:anywhere;">
          <b>${escapeHtml(line.label)}</b> ${itemChip(line.kind, line.value, line.itemLabel)}
          <span style="color:${t.muted};"> · ${escapeHtml(formatDays(line.days))} · ${escapeHtml(EFFECT_SHORT_LABELS[line.effect])}</span>
        </span>
        <span style="flex:0 0 auto;font-weight:900;">${foreignMode ? 'безплатно' : escapeHtml(formatEuro(line.priceCents))}</span>
        <button type="button" data-pc-cart-remove="${line.kind}" aria-label="Премахни ${escapeHtml(line.label)} от поръчката" title="Премахни" style="flex:0 0 auto;width:28px;height:28px;border-radius:999px;border:1px solid ${t.inputBorder};background:transparent;color:${t.muted};font-size:15px;line-height:1;cursor:pointer;padding:0;">×</button>
      </li>`).join('')
    const hint = foreignMode
      ? 'Административно предоставяне — без плащане, без Stripe и без жълтици. Записва се в одита.'
      : lines.length === 0
        ? 'Избери една или няколко персонализации по-долу — всяка с отделен срок. Нищо не се активира преди плащането.'
        : 'Плащането е през Stripe. Персонализациите се активират след потвърждение на плащането.'
    const recipientName = escapeHtml(previewName())
    const canGrant = adminGrant !== null && lines.length > 0 && !granting && !paying && (snapshot.target?.eligible ?? true)
    const grantButton = adminGrant !== null
      ? `<button type="button" data-pc-grant="1" ${canGrant ? '' : 'disabled'} style="margin-top:8px;width:100%;min-height:42px;border-radius:8px;border:1px solid ${t.equipped};background:${t.equippedBg};color:${t.equipped};font-size:14px;font-weight:900;cursor:${canGrant ? 'pointer' : 'not-allowed'};opacity:${canGrant ? '1' : '0.5'};">${granting ? 'Прилагане…' : foreignMode ? 'Приложи безплатно' : 'Приложи безплатно (Админ)'}</button>`
      : ''
    const grantConfirm = adminGrant !== null && grantConfirmOpen && lines.length > 0
      ? `<div data-pc-grant-confirm="1" role="alertdialog" style="margin-top:8px;padding:9px 11px;border-radius:8px;border:1px solid ${t.warnBorder};background:${t.warnBg};color:${t.warnText};font-size:13px;line-height:1.45;">
          Ще предоставиш безплатно <b>${escapeHtml(formatSelectedCount(lines.length).replace(' избрана', '').replace(' избрани', ''))}</b> на <b>${recipientName}</b>${foreignMode ? '' : ' (твоя профил)'}: ${lines.map((line) => `${escapeHtml(line.label)} ${itemChip(line.kind, line.value, line.itemLabel)} · ${escapeHtml(formatDays(line.days))}`).join('; ')}. Без плащане.
          <div style="display:flex;gap:6px;margin-top:8px;">
            <button type="button" class="pc-small-btn" data-tone="use" data-pc-grant-confirm-yes="1">Потвърди</button>
            <button type="button" class="pc-small-btn" data-pc-grant-confirm-no="1">Отказ</button>
          </div>
        </div>`
      : ''
    cartEl.innerHTML = `
      <div data-pc-cart="1" style="margin:0 0 12px;padding:10px 12px;border-radius:10px;border:1px solid ${lines.length > 0 ? t.selected : t.cardBorder};background:${t.card};">
        <div style="display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:8px;">
          <div data-pc-cart-count="${lines.length}" style="font-size:14px;font-weight:900;">${lines.length === 0 ? 'Няма избрани екстри' : escapeHtml(formatSelectedCount(lines.length))}</div>
          <div style="text-align:right;">
            <span style="font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:${t.muted};">Обща цена </span>
            <span data-pc-cart-total="${foreignMode ? 0 : totalCents}" style="font-size:20px;font-weight:900;">${lines.length === 0 ? '—' : foreignMode ? 'Безплатно' : escapeHtml(formatEuro(totalCents))}</span>
          </div>
        </div>
        ${lines.length > 0 ? `<ul data-pc-cart-lines="1" style="margin:8px 0 0;padding:0;">${rows}</ul>` : ''}
        ${foreignMode ? '' : `<button type="button" data-pc-pay="1" ${canPay ? '' : 'disabled'} style="margin-top:10px;width:100%;min-height:44px;border:0;border-radius:8px;background:${t.primaryBg};color:${t.primaryText};font-size:15px;font-weight:900;cursor:${canPay ? 'pointer' : 'not-allowed'};opacity:${canPay ? '1' : '0.5'};">${paying ? 'Пренасочване към плащане…' : lines.length > 0 ? `Плати ${escapeHtml(formatEuro(totalCents))}` : 'Плати'}</button>`}
        ${grantButton}
        ${grantConfirm}
        <div data-pc-cart-hint="1" style="margin-top:6px;font-size:11px;line-height:1.45;color:${t.muted};text-align:center;">${escapeHtml(hint)}</div>
      </div>`
  }

  // ─── "Моите персонализации" (инвентар) ────────────────────────────────

  const renderInventory = () => {
    if (snapshot === null) { inventoryEl.innerHTML = ''; return }
    const owned = ownedList()
    const groups = KIND_ORDER.map((kind) => {
      const items = owned.filter((item) => item.kind === kind)
      if (items.length === 0) return ''
      const label = kindInfo(kind)?.label ?? kind
      const cards = items.map((item) => {
        const state = equippedFor(kind)?.itemId === item.itemId ? 'equipped' : 'available'
        const visual = kindInfo(kind)?.itemType === 'color' && isHexColor(item.value)
          ? `<span aria-hidden="true" style="flex:0 0 auto;width:26px;height:26px;border-radius:7px;background:${item.value};box-shadow:inset 0 0 0 1px rgba(0,0,0,0.2);"></span>`
          : `<span aria-hidden="true" style="flex:0 0 auto;width:26px;text-align:center;font-size:22px;line-height:26px;">${escapeHtml(item.value)}</span>`
        return `
          <div data-pc-owned-card="${kind}|${escapeHtml(item.itemId)}" data-pc-owned-state="${state}" style="min-width:0;padding:8px;border-radius:9px;border:${state === 'equipped' ? `2px solid ${t.equipped}` : `1px solid ${t.cardBorder}`};background:${state === 'equipped' ? t.equippedBg : t.bg};">
            <div class="pc-owned-head">
              ${visual}
              <div class="pc-owned-text">
                ${kindInfo(kind)?.itemType === 'color' ? `<div class="pc-owned-name">${escapeHtml(itemName(kind, item.value, item.label))}</div>` : ''}
                <div data-pc-owned-until="1" class="pc-owned-meta"><span>до ${escapeHtml(formatDate(item.activeUntil))}</span><span>· ${escapeHtml(formatDays(item.remainingDays))}</span></div>
                <div class="pc-owned-badge-below">${statusBadge(state)}</div>
              </div>
              <div class="pc-owned-badge-side">${statusBadge(state)}</div>
            </div>
            <div class="pc-owned-actions">${ownedActions(kind, item.itemId, state)}</div>
          </div>`
      }).join('')
      return `
        <div data-pc-inventory-kind="${kind}" style="margin-top:8px;">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:${t.muted};margin-bottom:4px;">${escapeHtml(label)} · ${items.length}</div>
          <div data-pc-inventory-grid="1">${cards}</div>
        </div>`
    }).join('')
    inventoryEl.innerHTML = `
      <section data-pc-inventory="1" data-pc-inventory-count="${owned.length}" aria-label="${foreignMode ? 'Персонализации на получателя' : 'Моите персонализации'}" style="margin:0 0 12px;padding:10px 12px;border-radius:10px;border:1px solid ${t.cardBorder};background:${t.card};">
        <div style="display:flex;align-items:baseline;justify-content:space-between;gap:8px;">
          <h3 style="margin:0;font-size:15px;font-weight:900;">${foreignMode ? `Персонализации на ${escapeHtml(previewName())}` : 'Моите персонализации'}</h3>
          <span style="font-size:12px;color:${t.muted};">${owned.length > 0 ? `${owned.length} ${foreignMode ? 'притежавани' : 'закупени'}` : ''}</span>
        </div>
        ${owned.length > 0
          ? `${groups}<div style="margin-top:8px;font-size:11px;line-height:1.45;color:${t.muted};">${foreignMode ? 'Само за преглед — "Използвай"/"Премахни" са на получателя. "Удължи" добавя безплатно удължаване.' : 'Смяната е безплатна — сроковете текат календарно и не се губят дни.'}</div>`
          : `<div data-pc-inventory-empty="1" style="margin-top:6px;font-size:13px;color:${t.muted};">${foreignMode ? 'Получателят още няма персонализации.' : 'Още нямаш закупени персонализации.'}</div>`}
      </section>`
  }

  // ─── Секции ───────────────────────────────────────────────────────────

  const renderStatusLine = (kind: Kind): string => {
    const info = kindInfo(kind)
    const equipped = equippedFor(kind)
    const selection = selections.get(kind)
    const ownedCount = ownedList(kind).length
    const inCart = selection !== undefined && selection.itemId !== null && info !== undefined && canBuy(info)
    const cartBadge = inCart
      ? ` <span data-pc-in-cart="${kind}" style="display:inline-block;margin-left:4px;padding:1px 7px;border-radius:999px;border:1px solid ${t.selected};color:${t.selected};font-size:11px;font-weight:900;">${escapeHtml(EFFECT_SHORT_LABELS[effectFor(kind, selection.itemId)])} · ${escapeHtml(formatDays(selection.days))}</span>`
      : ''
    const ownedNote = ownedCount > 0 ? ` <span style="color:${t.muted};">· закупени: ${ownedCount}</span>` : ''
    if (equipped !== null) {
      return `${itemChip(kind, equipped.value, equipped.label)} <span style="color:${t.muted};">до ${escapeHtml(formatDate(equipped.activeUntil))}</span>${ownedNote}${cartBadge}`
    }
    if (info !== undefined && !canBuy(info)) return `<span style="color:${t.muted};">Не се продава в момента</span>${ownedNote}`
    return `<span style="color:${t.muted};">${ownedCount > 0 ? 'Не се използва' : 'Не е активна'}${info !== undefined && !foreignMode ? ` · от ${escapeHtml(formatEuro(info.basePrice30DaysCents))} за 30 дни` : ''}</span>${ownedNote}${cartBadge}`
  }

  const ownedAttr = (kind: Kind, itemId: string): string => {
    const state = ownedState(kind, itemId)
    if (state === null) return ''
    const owned = ownedFor(kind, itemId)!
    return ` data-pc-owned="${state}" title="${state === 'equipped' ? 'Използва се' : 'Закупен'} · остават ${escapeHtml(formatDays(owned.remainingDays))}"`
  }

  const renderPicker = (kind: Kind): string => {
    if (snapshot === null) return ''
    const info = kindInfo(kind)
    const selection = selectionFor(kind)
    if (info?.itemType === 'color') {
      // Каталогът (до 5 цвята) + притежавани цветове, спрени от продажба (могат да се използват/удължават).
      const catalogIds = new Set(snapshot.colors.map((color) => color.colorId))
      const extraOwned = ownedList(kind).filter((item) => !catalogIds.has(item.itemId)).map((item) => ({ colorId: item.itemId, hex: item.value, label: item.label ?? item.value }))
      const options = [...snapshot.colors, ...extraOwned].map((color) => `
        <div data-pc-color-option="${escapeHtml(color.colorId)}" style="display:flex;flex-direction:column;align-items:center;gap:6px;width:64px;">
          <button type="button" data-pc-swatch="${escapeHtml(color.colorId)}" aria-pressed="${selection.itemId === color.colorId}" aria-label="${escapeHtml(color.label)}"${ownedAttr(kind, color.colorId)} style="background:${color.hex};"></button>
          <span style="font-size:11px;line-height:1.2;color:${t.muted};text-align:center;overflow-wrap:anywhere;">${escapeHtml(color.label)}</span>
        </div>`).join('')
      return `<div data-pc-color-picker="1" style="display:flex;flex-wrap:wrap;gap:12px 8px;margin:6px 0 12px;">${options}</div>${renderItemDetail(kind)}`
    }
    const currentCategory = emojiCategoryByKind.get(kind) ?? snapshot.emojiCategories[0]?.key ?? ''
    const strip = snapshot.emojiCategories.map((category) => `<button type="button" data-pc-category="${escapeHtml(category.key)}" aria-pressed="${category.key === currentCategory}" aria-label="${escapeHtml(category.label)}" title="${escapeHtml(category.label)}">${escapeHtml(category.icon)}</button>`).join('')
    const grid = snapshot.emojis
      .filter((emoji) => emoji.categoryKey === currentCategory)
      .map((emoji) => `<button type="button" data-pc-emoji="${escapeHtml(emoji.emojiId)}" aria-pressed="${selection.itemId === emoji.emojiId}" aria-label="${escapeHtml(emoji.emoji)}"${ownedAttr(kind, emoji.emojiId)}>${escapeHtml(emoji.emoji)}</button>`)
      .join('')
    const categoryLabel = snapshot.emojiCategories.find((category) => category.key === currentCategory)?.label ?? ''
    return `
      <div data-pc-emoji-picker="1" style="margin:4px 0 12px;">
        <div data-pc-category-strip="1" style="display:flex;gap:5px;overflow-x:auto;-webkit-overflow-scrolling:touch;padding-bottom:6px;">${strip}</div>
        <div style="display:flex;flex-wrap:wrap;justify-content:space-between;gap:6px;font-size:12px;color:${t.muted};margin:2px 0 4px;">
          <span>${escapeHtml(categoryLabel)}</span>
          <span data-pc-legend="1" style="display:inline-flex;align-items:center;gap:4px;"><span class="pc-marker" data-pc-marker="available" aria-hidden="true"></span>закупен · <span class="pc-marker" data-pc-marker="equipped" aria-hidden="true">●</span>използва се</span>
        </div>
        <div data-pc-emoji-grid="1" style="border:1px solid ${t.cardBorder};border-radius:8px;">${grid}</div>
      </div>
      ${renderItemDetail(kind)}`
  }

  /** Панел с детайли за притежаван вариант, избран в каталога (статус, срок, действия). */
  const renderItemDetail = (kind: Kind): string => {
    const itemId = detailByKind.get(kind) ?? null
    const owned = ownedFor(kind, itemId)
    if (itemId === null || owned === null) return ''
    const state = ownedState(kind, itemId) ?? 'available'
    return `
      <div data-pc-item-detail="${kind}" data-pc-item-detail-state="${state}" style="display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px;margin:-4px 0 12px;padding:8px 10px;border-radius:8px;border:1px solid ${state === 'equipped' ? t.equipped : t.owned};background:${state === 'equipped' ? t.equippedBg : t.ownedBg};font-size:13px;">
        ${itemChip(kind, owned.value, owned.label)}
        ${statusBadge(state)}
        <span style="color:${t.muted};">${state === 'equipped' ? '' : 'Закупен · '}остават <b style="color:${t.text};">${escapeHtml(formatDays(owned.remainingDays))}</b> (до ${escapeHtml(formatDate(owned.activeUntil))})</span>
        <span style="display:flex;gap:5px;margin-left:auto;">${ownedActions(kind, itemId, state)}</span>
      </div>`
  }

  /** Срок, цена на реда и ефектът (удължаване / добавяне). Без отделен бутон за плащане. */
  const renderSummary = (kind: Kind): string => {
    const info = kindInfo(kind)
    if (info === undefined || !canBuy(info)) return ''
    const selection = selectionFor(kind)
    const options = (snapshot?.durations ?? []).map((days) => {
      const price = priceFor(kind, days)
      return `<option value="${days}" ${days === selection.days ? 'selected' : ''}>${escapeHtml(formatDays(days))}${price !== null && !foreignMode ? ` — ${escapeHtml(formatEuro(price))}` : ''}</option>`
    }).join('')
    const selected = resolveItem(kind, selection.itemId)
    const price = priceFor(kind, selection.days)
    const effect = effectFor(kind, selection.itemId)
    const owned = ownedFor(kind, selection.itemId)
    const equipped = equippedFor(kind)

    let effectHtml = ''
    if (selected === null) {
      effectHtml = `<div data-pc-not-selected="${kind}" style="font-size:13px;color:${t.muted};">${ownedList(kind).length > 0
        ? `Закупените ти варианти не се таксуват повторно. Избери нов ${info.itemType === 'color' ? 'цвят' : 'вариант'} или натисни "Удължи" на закупен, за да го добавиш към поръчката.`
        : `Избери ${info.itemType === 'color' ? 'цвят' : 'емоджи'}, за да го добавиш към поръчката.`}</div>`
    } else if (effect === 'extend' && owned !== null) {
      const until = new Date(Date.parse(owned.activeUntil) + selection.days * 86_400_000).toISOString()
      effectHtml = `<div data-pc-effect="extend" style="font-size:13px;line-height:1.5;">Удължаване с ${escapeHtml(formatDays(selection.days))} — валидно до <b>${escapeHtml(formatDate(until))}</b> (остават ${owned.remainingDays} + ${selection.days} дни).</div>`
    } else {
      const until = new Date(Date.now() + selection.days * 86_400_000).toISOString()
      const keepNote = equipped !== null && equipped.itemId !== selection.itemId
        ? ` След плащането ще се използва новият; ${itemChip(kind, equipped.value, equipped.label)} остава в "Моите персонализации" с оставащите си дни.`
        : ''
      effectHtml = `<div data-pc-effect="new" style="font-size:13px;line-height:1.5;">Добавя се в "Моите персонализации" за ${escapeHtml(formatDays(selection.days))} от потвърждаването на плащането (до ≈ <b>${escapeHtml(formatDate(until))}</b>).${keepNote}</div>`
    }

    return `
      <div style="display:flex;flex-wrap:wrap;align-items:flex-end;gap:10px;margin-bottom:10px;">
        <label style="display:flex;flex-direction:column;gap:4px;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:${t.muted};">Продължителност
          <select data-pc-days="${kind}" style="min-height:38px;padding:0 10px;border-radius:8px;border:1px solid ${t.inputBorder};background:${t.input};color:${t.text};font-size:14px;font-family:inherit;">${options}</select>
        </label>
        <div style="margin-left:auto;text-align:right;">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:${t.muted};">Цена</div>
          <div data-pc-price="${kind}" style="font-size:20px;font-weight:900;color:${t.text};">${selected === null ? '—' : foreignMode ? 'Безплатно' : price !== null ? escapeHtml(formatEuro(price)) : '—'}</div>
        </div>
      </div>
      ${effectHtml}
      ${selected !== null ? `<button type="button" data-pc-remove="${kind}" style="margin-top:10px;min-height:34px;padding:0 12px;border-radius:8px;border:1px solid ${t.inputBorder};background:transparent;color:${t.text};font-size:13px;font-weight:800;cursor:pointer;">Премахни от поръчката</button>` : ''}`
  }

  const renderSectionBody = (kind: Kind): string => {
    const info = kindInfo(kind)
    if (info === undefined) return ''
    const equipped = equippedFor(kind)
    const activeCard = equipped !== null ? `
      <div data-pc-active="${kind}" style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;border-radius:8px;border:1px solid ${t.equipped};background:${t.equippedBg};margin-bottom:12px;">
        <div style="font-size:13px;line-height:1.55;color:${t.text};">
          Използва се: ${itemChip(kind, equipped.value, equipped.label)}<br>
          Изтича на <b>${escapeHtml(formatDate(equipped.activeUntil))}</b> · остават <b data-pc-remaining="${kind}">${escapeHtml(formatDays(equipped.remainingDays))}</b>
        </div>
        <div style="display:flex;gap:6px;">${ownedActions(kind, equipped.itemId, 'equipped')}</div>
      </div>` : ''
    if (!canBuy(info)) {
      return `${activeCard}<div data-pc-picker-host="${kind}">${renderPicker(kind)}</div><div data-pc-sales-disabled="${kind}" style="font-size:13px;color:${t.muted};padding:4px 0 6px;">Тази персонализация в момента не се продава.</div>`
    }
    return `
      ${activeCard}
      <div data-pc-picker-host="${kind}">${renderPicker(kind)}</div>
      <div data-pc-summary="${kind}">${renderSummary(kind)}</div>`
  }

  const render = () => {
    if (loadError !== null) {
      previewEl.innerHTML = ''
      cartEl.innerHTML = ''
      inventoryEl.innerHTML = ''
      bodyEl.innerHTML = `<div data-pc-load-error="1" style="padding:12px 0;font-size:14px;line-height:1.5;color:${t.errText};">${escapeHtml(loadError)}</div>`
      return
    }
    if (snapshot === null) {
      bodyEl.innerHTML = `<div style="padding:12px 0;font-size:14px;color:${t.muted};">Зареждане…</div>`
      return
    }
    renderPreview()
    renderCart()
    renderInventory()
    const adminTestNotice = snapshot.adminTestMode === true && !foreignMode
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
              <span data-pc-status="${info.kind}" style="display:block;font-size:13px;margin-top:3px;">${renderStatusLine(info.kind)}</span>
            </span>
            <span aria-hidden="true" style="flex:0 0 auto;font-size:18px;color:${t.muted};transform:rotate(${isOpen ? '180deg' : '0deg'});transition:transform 0.15s;">▾</span>
          </button>
          ${isOpen ? `<div id="pc-panel-${info.kind}" data-pc-panel="${info.kind}" style="padding:2px 14px 14px;">${renderSectionBody(info.kind)}</div>` : ''}
        </div>`
    }).join('')
  }

  /** Частично обновяване (без да се губи превъртането на каталога): преглед, обобщение, инвентар, секцията. */
  const refreshKind = (kind: Kind) => {
    // Промяна на избора отменя отвореното потвърждение за безплатно предоставяне.
    grantConfirmOpen = false
    renderPreview()
    renderCart()
    renderInventory()
    const panel = bodyEl.querySelector<HTMLElement>(`[data-pc-panel="${kind}"]`)
    if (panel !== null) {
      const gridScroll = panel.querySelector<HTMLElement>('[data-pc-emoji-grid="1"]')?.scrollTop ?? 0
      const stripScroll = panel.querySelector<HTMLElement>('[data-pc-category-strip="1"]')?.scrollLeft ?? 0
      panel.innerHTML = renderSectionBody(kind)
      const grid = panel.querySelector<HTMLElement>('[data-pc-emoji-grid="1"]')
      if (grid !== null) grid.scrollTop = gridScroll
      const strip = panel.querySelector<HTMLElement>('[data-pc-category-strip="1"]')
      if (strip !== null) strip.scrollLeft = stripScroll
    }
    const status = bodyEl.querySelector<HTMLElement>(`[data-pc-status="${kind}"]`)
    if (status !== null) status.innerHTML = renderStatusLine(kind)
  }

  const removeFromCart = (kind: Kind) => {
    selectionFor(kind).itemId = null
    refreshKind(kind)
  }

  // ─── Данни ────────────────────────────────────────────────────────────

  async function fetchSnapshot(): Promise<{ ok: true; data: Snapshot } | { ok: false; message: string }> {
    try {
      const query = returnSessionId !== null ? `?sessionId=${encodeURIComponent(returnSessionId)}` : ''
      // Чужд профил: каталогът и инвентарът на ПОЛУЧАТЕЛЯ (само пълен admin).
      const url = foreignMode
        ? `${deps.getApiBaseUrl()}/api/admin/profile-customization/targets/${encodeURIComponent(adminGrant!.targetProfileId)}`
        : `${deps.getApiBaseUrl()}/api/profile-customization${query}`
      const response = await fetch(url, { credentials: 'include', cache: 'no-store' })
      const data = (await response.json().catch(() => null)) as (Snapshot & { ok?: boolean; message?: string; code?: string }) | null
      if (response.ok && data?.ok === true && Array.isArray(data.kinds)) return { ok: true, data }
      if (data?.code === 'feature_disabled') return { ok: false, message: 'Персонализацията в момента не е налична.' }
      return { ok: false, message: data?.message ?? 'Персонализацията не може да бъде заредена.' }
    } catch {
      return { ok: false, message: 'Няма връзка със сървъра.' }
    }
  }

  const applySnapshot = (data: Snapshot) => {
    snapshot = { ...data, owned: Array.isArray(data.owned) ? data.owned : [] }
    loadError = null
    if (openKind === null) openKind = data.kinds[0]?.kind ?? null
    for (const info of data.kinds) {
      const selection = selectionFor(info.kind)
      if (!data.durations.includes(selection.days)) selection.days = data.durations[0] ?? 30
      // Избор, който вече не е валиден (артикулът е спрян/видът не се продава) -> извън поръчката.
      if (selection.itemId !== null && (!canBuy(info) || resolveItem(info.kind, selection.itemId) === null)) selection.itemId = null
      if (!emojiCategoryByKind.has(info.kind) && info.itemType === 'emoji') {
        const activeItemId = data.active[info.kind]?.itemId ?? null
        const activeEmoji = data.emojis.find((emoji) => emoji.emojiId === activeItemId)
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
    if (result.ok) handleReturnState(result.data.returnOrder ?? null)
  }

  // След връщане от Stripe: webhook-ът може да закъснее — следим поръчката
  // ограничено време, без да активираме нищо от клиента.
  const handleReturnState = (order: ReturnOrder | null) => {
    if (returnSessionId === null) return
    if (order === null || order.status === 'pending') {
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
    if (order.status === 'paid') {
      const count = order.items.length
      showNotice(count === 1
        ? `Плащането е успешно — персонализацията ${order.items[0]?.grantEffect === 'extend' ? 'е удължена' : 'е активирана'} до ${formatDate(order.items[0]?.grantedUntil ?? null)}.`
        : `Плащането е успешно — ${count} персонализации са активирани (общо ${formatEuro(order.totalCents)}).`, 'ok')
    } else if (order.status === 'refunded') {
      showNotice('Плащането е възстановено — персонализацията не е активирана.', 'error')
    } else {
      showNotice('Плащането не е завършено. Нищо не е таксувано и нищо не е променено.', 'error')
    }
  }

  /**
   * "Използвай" / "Премахни" — безплатно. Прегледът се обновява веднага
   * (локално), а сървърът (единственият, който записва) потвърждава и
   * връща актуалния инвентар; при отказ състоянието се презарежда.
   */
  const changeEquipped = async (kind: Kind, itemId: string | null) => {
    if (snapshot === null || equipBusy) return
    const previousActive = snapshot.active[kind]
    const owned = itemId !== null ? ownedFor(kind, itemId) : null
    if (itemId !== null && owned === null) return
    equipBusy = true
    snapshot.active = { ...snapshot.active, [kind]: owned === null ? null : { kind, itemId: owned.itemId, value: owned.value, label: owned.label, activeUntil: owned.activeUntil, remainingDays: owned.remainingDays } }
    refreshKind(kind)
    let failure: string | null = null
    try {
      const response = await fetch(`${deps.getApiBaseUrl()}/api/profile-customization/${itemId === null ? 'unequip' : 'equip'}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(itemId === null ? { kind } : { kind, itemId }),
      })
      const data = (await response.json().catch(() => null)) as { ok?: boolean; message?: string; active?: Snapshot['active']; owned?: OwnedItem[] } | null
      if (response.ok && data?.ok === true && data.active !== undefined && snapshot !== null) {
        snapshot.active = data.active
        snapshot.owned = Array.isArray(data.owned) ? data.owned : snapshot.owned
      } else {
        failure = data?.message ?? 'Смяната не беше записана.'
      }
    } catch {
      failure = 'Няма връзка със сървъра.'
    }
    equipBusy = false
    if (!host.isConnected) return
    if (failure !== null) {
      if (snapshot !== null) snapshot.active = { ...snapshot.active, [kind]: previousActive }
      await load()
      showNotice(failure, 'error')
      return
    }
    refreshKind(kind)
    showNotice(itemId === null ? 'Персонализацията е премахната. Остава в "Моите персонализации" до изтичането си.' : 'Персонализацията се използва.', 'ok')
  }

  /**
   * "Приложи безплатно" — само пълен admin. Без цена/Stripe/жълтици. Сървърът
   * прилага всички избрани редове в една транзакция (или нито един) и ги
   * записва в одита.
   */
  const grant = async () => {
    const lines = cartLines()
    if (adminGrant === null || lines.length === 0 || granting) return
    granting = true
    grantConfirmOpen = false
    showNotice(null)
    renderCart()
    let failureMessage: string | null = null
    let failureKind: Kind | null = null
    try {
      const response = await fetch(`${deps.getApiBaseUrl()}/api/admin/profile-customization/grants`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetProfileId: adminGrant.targetProfileId,
          confirm: true,
          items: lines.map((line) => {
            const selection = selectionFor(line.kind)
            return { kind: line.kind, itemId: selection.itemId, days: selection.days }
          }),
        }),
      })
      const data = (await response.json().catch(() => null)) as { ok?: boolean; message?: string; kind?: Kind | null } | null
      if (!response.ok || data?.ok !== true) {
        failureMessage = data?.message ?? 'Предоставянето не беше записано.'
        failureKind = data?.kind ?? null
      }
    } catch {
      failureMessage = 'Няма връзка със сървъра.'
    }
    granting = false
    if (!host.isConnected) return
    if (failureMessage !== null) {
      if (failureKind !== null) openKind = failureKind
      render()
      showNotice(failureMessage, 'error')
      return
    }
    for (const line of lines) selectionFor(line.kind).itemId = null
    detailByKind.clear()
    await load()
    showNotice(`Предоставено безплатно на ${previewName()}: ${lines.map((line) => `${line.label} (${formatDays(line.days)})`).join(', ')}.`, 'ok')
  }

  const pay = async () => {
    const lines = cartLines()
    if (lines.length === 0 || paying) return
    paying = true
    showNotice(null)
    renderCart()
    let failureMessage: string | null = null
    let failureKind: Kind | null = null
    let reloaded = false
    try {
      const response = await fetch(`${deps.getApiBaseUrl()}/api/profile-customization/checkout`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: lines.map((line) => {
            const selection = selectionFor(line.kind)
            return { kind: line.kind, itemId: selection.itemId, days: selection.days }
          }),
          // Сумата от бутона — сървърът отказва, ако неговата е различна.
          expectedTotalCents: lines.reduce((sum, line) => sum + line.priceCents, 0),
        }),
      })
      const data = (await response.json().catch(() => null)) as { ok?: boolean; checkoutUrl?: string; message?: string; code?: string; kind?: Kind | null } | null
      if (response.ok && data?.ok === true && typeof data.checkoutUrl === 'string') {
        deps.navigateToCheckout(data.checkoutUrl)
        return
      }
      failureMessage = data?.message ?? 'Плащането не може да започне в момента.'
      failureKind = data?.kind ?? null
      if (data?.code === 'price_changed') {
        failureMessage = 'Цената се промени. Провери новата обща сума и натисни "Плати" отново.'
        reloaded = true
      }
    } catch {
      failureMessage = 'Няма връзка със сървъра.'
    }
    paying = false
    if (!host.isConnected) return
    if (failureKind !== null) openKind = failureKind
    if (reloaded) await load()
    else render()
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

  /** Общи действия върху притежаван вариант (инвентар, детайли, текущата карта). */
  const handleOwnedAction = (target: HTMLElement): boolean => {
    const equip = target.closest<HTMLElement>('[data-pc-equip]')
    if (equip !== null) {
      const [kind, itemId] = (equip.getAttribute('data-pc-equip') ?? '').split('|') as [Kind, string]
      void changeEquipped(kind, itemId)
      return true
    }
    const unequip = target.closest<HTMLElement>('[data-pc-unequip]')
    if (unequip !== null) {
      void changeEquipped(unequip.getAttribute('data-pc-unequip') as Kind, null)
      return true
    }
    const extendItem = target.closest<HTMLElement>('[data-pc-extend-item]')
    if (extendItem !== null) {
      const [kind, itemId] = (extendItem.getAttribute('data-pc-extend-item') ?? '').split('|') as [Kind, string]
      if (ownedFor(kind, itemId) === null) return true
      selectionFor(kind).itemId = itemId
      detailByKind.set(kind, itemId)
      const ownedEmoji = snapshot?.emojis.find((candidate) => candidate.emojiId === itemId)
      if (ownedEmoji) emojiCategoryByKind.set(kind, ownedEmoji.categoryKey)
      if (openKind !== kind) {
        openKind = kind
        render()
      } else {
        refreshKind(kind)
      }
      bodyEl.querySelector<HTMLElement>(`[data-pc-days="${kind}"]`)?.focus()
      return true
    }
    const remove = target.closest<HTMLElement>('[data-pc-remove]')
    if (remove !== null) {
      removeFromCart(remove.getAttribute('data-pc-remove') as Kind)
      return true
    }
    return false
  }

  cartEl.addEventListener('click', (event) => {
    const target = event.target as HTMLElement
    const remove = target.closest<HTMLElement>('[data-pc-cart-remove]')
    if (remove !== null) {
      removeFromCart(remove.getAttribute('data-pc-cart-remove') as Kind)
      return
    }
    if (target.closest('[data-pc-pay="1"]') !== null) { void pay(); return }
    if (target.closest('[data-pc-grant="1"]') !== null) {
      grantConfirmOpen = true
      renderCart()
      cartEl.querySelector<HTMLElement>('[data-pc-grant-confirm-yes="1"]')?.focus()
      return
    }
    if (target.closest('[data-pc-grant-confirm-yes="1"]') !== null) { void grant(); return }
    if (target.closest('[data-pc-grant-confirm-no="1"]') !== null) {
      grantConfirmOpen = false
      renderCart()
    }
  })

  inventoryEl.addEventListener('click', (event) => {
    handleOwnedAction(event.target as HTMLElement)
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

    if (handleOwnedAction(target)) return

    const swatch = target.closest<HTMLElement>('[data-pc-swatch]')
    const emoji = target.closest<HTMLElement>('[data-pc-emoji]')
    if ((swatch !== null || emoji !== null) && openKind !== null) {
      const kind = openKind
      const itemId = swatch?.getAttribute('data-pc-swatch') ?? emoji?.getAttribute('data-pc-emoji') ?? null
      if (itemId === null) return
      if (ownedFor(kind, itemId) !== null) {
        // Закупен вариант: само детайли с действията (Използвай/Премахни/Удължи) — не се добавя за покупка.
        detailByKind.set(kind, itemId)
      } else {
        // Незакупен: добавя/маха се от поръчката (повторен клик го маха).
        detailByKind.delete(kind)
        const selection = selectionFor(kind)
        selection.itemId = selection.itemId === itemId ? null : itemId
      }
      refreshKind(kind)
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
    }
  })

  bodyEl.addEventListener('change', (event) => {
    const target = event.target as HTMLElement
    const daysKind = target.getAttribute('data-pc-days') as Kind | null
    if (daysKind !== null) {
      selectionFor(daysKind).days = Number((target as HTMLSelectElement).value)
      refreshKind(daysKind)
      bodyEl.querySelector<HTMLElement>(`[data-pc-days="${daysKind}"]`)?.focus()
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
