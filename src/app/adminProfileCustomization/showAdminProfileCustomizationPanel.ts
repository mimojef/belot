// "Персонализация на профила" — Admin → Персонализация (само пълен admin;
// сървърът проверява ролята при всяка заявка — /api/admin/profile-customization).
// Работи и при изключен PROFILE_CUSTOMIZATION_ENABLED: администраторът
// подготвя каталога и цените, преди функцията да стане публична.
//
// Лек самостоятелен overlay (mirror на showAdminProfileDeletionsPanel):
//   * Цени и продажба — базова цена за 30 дни и продажба вкл./изкл. по вид,
//     автоматичната таблица с цени и кратка статистика;
//   * Цветове — каталог по групи, контраст на черен/бял фон, добавяне,
//     преименуване, скриване от продажба;
//   * Емоджита — каталог по категории (компактна лента), добавяне, скриване,
//     смяна на категория;
//   * Покупки — история с филтър по статус.
// Тук няма бизнес правила — цените се въвеждат като текст ("1.99") и се
// разбират до центове на сървъра. Скриването не засяга вече закупените.

type Kind = 'nickname_color' | 'message_color' | 'emoji_before' | 'emoji_after'

type KindSettings = {
  kind: Kind
  label: string
  itemType: 'color' | 'emoji'
  basePrice30DaysCents: number
  salesEnabled: boolean
  priceTable: Array<{ days: number; priceCents: number }>
  updatedAt: string
}

type ColorEntry = {
  colorId: string
  hex: string
  label: string
  groupKey: string
  sortOrder: number
  isActive: boolean
  contrast: { onBlack: number; onWhite: number; meetsMinimum: boolean }
}

type EmojiEntry = { emojiId: string; emoji: string; categoryKey: string; sortOrder: number; isActive: boolean }

type KindStats = { kind: Kind; paidCount: number; paidTotalCents: number; refundedCount: number; refundedTotalCents: number; activeNowCount: number }

type AdminSnapshot = {
  kinds: KindSettings[]
  colors: ColorEntry[]
  emojis: EmojiEntry[]
  stats: KindStats[]
  durations: number[]
  colorGroups: Array<{ key: string; label: string }>
  emojiCategories: Array<{ key: string; label: string; icon: string }>
  reservedStaffColor: string
  minContrastRatio: number
  /** Режим на достъп (SQLite, управляван оттук) + авариен стоп от env. */
  access: {
    mode: 'admin_only' | 'public'
    changedAt: string | null
    changedByDisplayName: string | null
    emergencyStop: boolean
    history: Array<{ changeId: string; mode: 'admin_only' | 'public'; previousMode: string; changedByDisplayName: string | null; changedAt: string }>
  }
  /** Само по префикса на ключа — ключът никога не идва до клиента. */
  stripeMode: 'live' | 'test' | 'not_configured' | 'unknown'
  pendingRefundReviews: number
}

type PurchaseRow = {
  purchaseId: string
  kind: Kind
  itemValue: string
  itemLabel: string | null
  days: number
  priceCents: number
  currency: string
  status: string
  creditedAt: string | null
  grantEffect: 'new' | 'extend' | 'replace' | null
  grantedUntil: string | null
  replacedItemValue: string | null
  refundedAt: string | null
  refundedAmountCents: number | null
  refundReviewStatus: 'pending' | 'reviewed' | null
  refundReviewReason?: 'partial_refund' | 'refund_failed' | null
  refundReviewedAt?: string | null
  refundReviewedByDisplayName?: string | null
  createdAt: string
  profileId: string | null
  displayName: string | null
  email: string | null
}

type ApiResult = { ok: true; data: Record<string, unknown> } | { ok: false; status: number; code: string | null; message: string }

export type AdminProfileCustomizationPanelDeps = {
  getApiBaseUrl: () => string
}

type Tab = 'pricing' | 'colors' | 'emojis' | 'purchases'

const HOST_ID = 'admin-profile-customization-panel'
const PURCHASES_PAGE_SIZE = 50

const STATUS_LABELS: Record<string, string> = {
  pending: 'Чака плащане',
  paid: 'Платена',
  canceled: 'Отказана',
  failed: 'Неуспешна',
  refunded: 'Възстановена',
  review_pending: 'Чака преглед (refund)',
}

const EFFECT_LABELS: Record<string, string> = {
  new: 'Нова',
  extend: 'Удължаване',
  replace: 'Замяна',
}

const BTN_PRIMARY = 'min-height:36px;padding:0 14px;border:0;border-radius:8px;background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;font-size:13px;font-weight:900;cursor:pointer;font-family:inherit;'
const BTN_SECONDARY = 'min-height:36px;padding:0 14px;border:1px solid rgba(255,255,255,0.22);border-radius:8px;background:transparent;color:#f8fafc;font-size:13px;font-weight:800;cursor:pointer;font-family:inherit;'
const INPUT_STYLE = 'min-height:36px;padding:0 10px;border-radius:8px;border:1px solid rgba(255,255,255,0.22);background:#1a1a1a;color:#f8fafc;font-size:14px;font-family:inherit;box-sizing:border-box;max-width:100%;'
const CARD_STYLE = 'margin:0 0 10px;padding:12px 14px;border-radius:8px;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.03);'
const MUTED = 'color:rgba(226,232,240,0.6);'

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

function centsToInput(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`
}

function formatDate(iso: string | null): string {
  if (iso === null) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('bg-BG', { timeZone: 'Europe/Sofia', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date)
}

function isHexColor(value: string): boolean {
  return /^#[0-9A-F]{6}$/i.test(value)
}

function itemPreview(kindOrType: Kind | 'color' | 'emoji', value: string): string {
  const isColor = kindOrType === 'color' || kindOrType === 'nickname_color' || kindOrType === 'message_color'
  if (isColor && isHexColor(value)) {
    return `<span style="display:inline-block;width:14px;height:14px;border-radius:3px;background:${value};vertical-align:-2px;border:1px solid rgba(255,255,255,0.3);"></span> <span style="font-family:monospace;">${escapeHtml(value)}</span>`
  }
  return `<span style="font-size:18px;line-height:1;">${escapeHtml(value)}</span>`
}

export function showAdminProfileCustomizationPanel(deps: AdminProfileCustomizationPanelDeps): { close: () => void } {
  document.getElementById(HOST_ID)?.remove()
  const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null

  const host = document.createElement('div')
  host.id = HOST_ID
  host.style.cssText = 'position:fixed;inset:0;z-index:200000;overflow-y:auto;-webkit-overflow-scrolling:touch;background:rgba(0,0,0,0.82);font-family:Arial,Helvetica,sans-serif;'
  document.body.appendChild(host)

  let snapshot: AdminSnapshot | null = null
  let tab: Tab = 'pricing'
  let emojiCategory = 'smileys'
  let selectedEmojiId: string | null = null
  let modeConfirmOpen = false
  let modeBusy = false
  let busy = false
  let loadError: string | null = null
  let purchases: PurchaseRow[] = []
  let purchasesTotal = 0
  let purchasesStatus = ''
  let purchasesLoading = false

  // Същата плътност като бъдещия потребителски каталог: 13 на ред на
  // десктоп, 9 на телефон (медийна заявка — inline стиловете не могат).
  host.innerHTML = `
    <style>
      #${HOST_ID} [data-apc-emoji-grid="1"] { grid-template-columns: repeat(13, minmax(0, 1fr)); }
      @media (max-width: 640px) { #${HOST_ID} [data-apc-emoji-grid="1"] { grid-template-columns: repeat(9, minmax(0, 1fr)); } }
    </style>
    <div style="min-height:100%;display:flex;justify-content:center;padding:16px;box-sizing:border-box;">
      <section role="dialog" aria-modal="true" aria-labelledby="admin-profile-customization-title"
        style="width:min(100%,980px);box-sizing:border-box;border-radius:8px;border:1px solid rgba(212,165,32,0.35);background:#111111;box-shadow:0 34px 80px rgba(0,0,0,0.48);padding:18px;align-self:flex-start;color:#f1f5f9;">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:6px;">
          <h2 id="admin-profile-customization-title" style="margin:0;font-size:20px;font-weight:900;color:#d4a520;letter-spacing:0.02em;">Персонализация</h2>
          <button type="button" data-apc-close="1" aria-label="Затвори" style="${BTN_SECONDARY}">Затвори</button>
        </div>
        <p style="margin:0 0 12px;font-size:13px;line-height:1.5;${MUTED}">Платени екстри за ника и съобщенията (Лафче, Теми, лични чатове). Скриването на цвят или емоджи спира само новите продажби — вече закупените остават до изтичането си.</p>
        <div data-apc-banners="1"></div>
        <div data-apc-tabs="1" role="tablist" style="display:flex;gap:6px;overflow-x:auto;-webkit-overflow-scrolling:touch;margin-bottom:12px;padding-bottom:2px;"></div>
        <div data-apc-notice="1" role="status" aria-live="polite" style="display:none;margin:0 0 10px;padding:8px 10px;border-radius:8px;font-size:13px;line-height:1.45;"></div>
        <div data-apc-body="1"></div>
      </section>
    </div>`

  const tabsEl = host.querySelector<HTMLElement>('[data-apc-tabs="1"]')!
  const bannersEl = host.querySelector<HTMLElement>('[data-apc-banners="1"]')!
  const bodyEl = host.querySelector<HTMLElement>('[data-apc-body="1"]')!
  const noticeEl = host.querySelector<HTMLElement>('[data-apc-notice="1"]')!

  const showNotice = (text: string | null, tone: 'ok' | 'error' = 'ok') => {
    if (text === null) { noticeEl.style.display = 'none'; return }
    noticeEl.textContent = text
    noticeEl.style.display = ''
    noticeEl.style.border = tone === 'ok' ? '1px solid rgba(134,239,172,0.35)' : '1px solid rgba(248,113,113,0.45)'
    noticeEl.style.background = tone === 'ok' ? 'rgba(134,239,172,0.08)' : 'rgba(248,113,113,0.08)'
    noticeEl.style.color = tone === 'ok' ? '#dcfce7' : '#fecaca'
  }

  async function api(method: 'GET' | 'PATCH' | 'POST', path: string, body?: Record<string, unknown>): Promise<ApiResult> {
    try {
      const response = await fetch(`${deps.getApiBaseUrl()}/api/admin/profile-customization${path}`, {
        method,
        credentials: 'include',
        cache: 'no-store',
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
      const data = (await response.json().catch(() => null)) as Record<string, unknown> | null
      if (response.ok && data?.ok === true) return { ok: true, data }
      return {
        ok: false,
        status: response.status,
        code: typeof data?.code === 'string' ? data.code : null,
        message: typeof data?.message === 'string' ? data.message : 'Заявката не беше изпълнена.',
      }
    } catch {
      return { ok: false, status: 0, code: null, message: 'Няма връзка със сървъра.' }
    }
  }

  // ─── Рендиране ────────────────────────────────────────────────────────

  const renderTabs = () => {
    const tabs: Array<[Tab, string]> = [['pricing', 'Цени и продажба'], ['colors', 'Цветове'], ['emojis', 'Емоджита'], ['purchases', 'Покупки']]
    tabsEl.innerHTML = tabs.map(([key, label]) => {
      const active = key === tab
      return `<button type="button" role="tab" aria-selected="${active}" data-apc-tab="${key}" style="flex:0 0 auto;min-height:36px;padding:0 14px;border-radius:999px;border:1px solid ${active ? '#d4a520' : 'rgba(255,255,255,0.18)'};background:${active ? 'rgba(212,165,32,0.16)' : 'transparent'};color:${active ? '#f4c95b' : '#e2e8f0'};font-size:13px;font-weight:800;cursor:pointer;font-family:inherit;white-space:nowrap;">${escapeHtml(label)}</button>`
    }).join('')
  }

  const renderPricing = (data: AdminSnapshot): string => data.kinds.map((kind) => {
    const stats = data.stats.find((row) => row.kind === kind.kind)
    const table = kind.priceTable.map((row) => `<span style="display:inline-block;margin:0 10px 4px 0;white-space:nowrap;"><b>${row.days}</b> дни — ${escapeHtml(formatEuro(row.priceCents))}</span>`).join('')
    return `
      <div data-apc-kind="${kind.kind}" style="${CARD_STYLE}">
        <div style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;">
          <div style="font-size:15px;font-weight:800;">${escapeHtml(kind.label)}</div>
          <span style="padding:3px 8px;border-radius:999px;font-size:12px;font-weight:800;border:1px solid ${kind.salesEnabled ? '#86efac' : 'rgba(226,232,240,0.4)'};color:${kind.salesEnabled ? '#86efac' : 'rgba(226,232,240,0.7)'};">${kind.salesEnabled ? 'Продава се' : 'Не се продава'}</span>
        </div>
        <div style="display:flex;flex-wrap:wrap;align-items:flex-end;gap:10px;margin-bottom:8px;">
          <label style="display:flex;flex-direction:column;gap:4px;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;${MUTED}">Цена за 30 дни (€)
            <input type="text" inputmode="decimal" data-apc-price="${kind.kind}" value="${escapeHtml(centsToInput(kind.basePrice30DaysCents))}" style="${INPUT_STYLE}width:120px;">
          </label>
          <label style="display:flex;align-items:center;gap:8px;min-height:36px;font-size:14px;cursor:pointer;">
            <input type="checkbox" data-apc-sales="${kind.kind}" ${kind.salesEnabled ? 'checked' : ''} style="width:18px;height:18px;"> Продажбата е включена
          </label>
          <button type="button" data-apc-save-kind="${kind.kind}" style="${BTN_PRIMARY}">Запази</button>
        </div>
        <div style="font-size:13px;line-height:1.5;">${table}</div>
        <div style="font-size:12px;margin-top:6px;${MUTED}">Без отстъпки: цена = цена за 30 дни × (дни / 30).${stats !== undefined ? ` · Платени: ${stats.paidCount} (${escapeHtml(formatEuro(stats.paidTotalCents))}) · Възстановени: ${stats.refundedCount} · Активни сега: ${stats.activeNowCount}` : ''}</div>
      </div>`
  }).join('')

  const renderColors = (data: AdminSnapshot): string => {
    const groupOptions = (selected: string) => data.colorGroups.map((group) => `<option value="${escapeHtml(group.key)}" ${group.key === selected ? 'selected' : ''}>${escapeHtml(group.label)}</option>`).join('')
    const groups = data.colorGroups.map((group) => {
      const colors = data.colors.filter((color) => color.groupKey === group.key)
      const items = colors.map((color) => {
        const warn = color.contrast.meetsMinimum ? '' : ` <span title="Под ${data.minContrastRatio}:1 на поне един фон" style="color:#fbbf24;font-weight:900;">⚠ нисък контраст</span>`
        return `
          <div data-apc-color="${escapeHtml(color.colorId)}" style="display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:8px 0;border-top:1px solid rgba(255,255,255,0.06);${color.isActive ? '' : 'opacity:0.55;'}">
            <span style="display:inline-block;width:26px;height:26px;border-radius:5px;background:${color.hex};border:1px solid rgba(255,255,255,0.3);flex:0 0 auto;"></span>
            <span style="display:inline-flex;gap:4px;flex:0 0 auto;">
              <span style="padding:2px 6px;border-radius:4px;background:#000;color:${color.hex};font-weight:800;font-size:13px;">Ник</span>
              <span style="padding:2px 6px;border-radius:4px;background:#fff;color:${color.hex};font-weight:800;font-size:13px;">Ник</span>
            </span>
            <span style="font-family:monospace;font-size:13px;flex:0 0 auto;">${escapeHtml(color.hex)}</span>
            <input type="text" maxlength="40" data-apc-color-label="${escapeHtml(color.colorId)}" value="${escapeHtml(color.label)}" style="${INPUT_STYLE}flex:1 1 140px;min-width:0;">
            <select data-apc-color-group="${escapeHtml(color.colorId)}" style="${INPUT_STYLE}">${groupOptions(color.groupKey)}</select>
            <label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;"><input type="checkbox" data-apc-color-active="${escapeHtml(color.colorId)}" ${color.isActive ? 'checked' : ''}> Продава се</label>
            <button type="button" data-apc-save-color="${escapeHtml(color.colorId)}" style="${BTN_SECONDARY}">Запази</button>
            <span style="flex:1 0 100%;font-size:12px;${MUTED}">Контраст: на черно ${color.contrast.onBlack.toFixed(2)}:1 · на бяло ${color.contrast.onWhite.toFixed(2)}:1${warn}</span>
          </div>`
      }).join('')
      return `<div style="${CARD_STYLE}"><div style="font-size:14px;font-weight:800;margin-bottom:4px;">${escapeHtml(group.label)} <span style="font-weight:600;${MUTED}">(${colors.length})</span></div>${items || `<div style="font-size:13px;${MUTED}">Няма цветове.</div>`}</div>`
    }).join('')
    return `
      <div style="${CARD_STYLE}">
        <div style="font-size:14px;font-weight:800;margin-bottom:8px;">Добави цвят</div>
        <div style="display:flex;flex-wrap:wrap;align-items:flex-end;gap:8px;">
          <input type="color" data-apc-new-color-picker="1" value="#3366CC" aria-label="Избор на цвят" style="width:44px;height:36px;padding:0;border:0;background:none;cursor:pointer;">
          <input type="text" data-apc-new-color-hex="1" value="#3366CC" maxlength="7" aria-label="Hex" style="${INPUT_STYLE}width:100px;font-family:monospace;">
          <input type="text" data-apc-new-color-label="1" maxlength="40" placeholder="Име (напр. Морскосиньо)" style="${INPUT_STYLE}flex:1 1 160px;min-width:0;">
          <select data-apc-new-color-group="1" style="${INPUT_STYLE}">${groupOptions('blue')}</select>
          <button type="button" data-apc-add-color="1" style="${BTN_PRIMARY}">Добави</button>
        </div>
        <div style="font-size:12px;margin-top:6px;${MUTED}">${escapeHtml(data.reservedStaffColor)} и визуално близките до него нюанси са запазени за екипа на Pika.bg и не могат да бъдат добавени. Цветът не може да се променя след добавяне.</div>
      </div>
      ${groups}`
  }

  const renderEmojis = (data: AdminSnapshot): string => {
    const categoryButtons = data.emojiCategories.map((category) => {
      const active = category.key === emojiCategory
      const count = data.emojis.filter((emoji) => emoji.categoryKey === category.key).length
      return `<button type="button" data-apc-emoji-category="${escapeHtml(category.key)}" title="${escapeHtml(category.label)}" aria-pressed="${active}" style="flex:0 0 auto;display:flex;align-items:center;gap:6px;min-height:34px;padding:0 10px;border-radius:999px;border:1px solid ${active ? '#d4a520' : 'rgba(255,255,255,0.16)'};background:${active ? 'rgba(212,165,32,0.16)' : 'transparent'};color:#f1f5f9;font-size:13px;cursor:pointer;font-family:inherit;white-space:nowrap;"><span style="font-size:17px;">${escapeHtml(category.icon)}</span>${escapeHtml(category.label)} <span style="${MUTED}">${count}</span></button>`
    }).join('')
    const emojis = data.emojis.filter((emoji) => emoji.categoryKey === emojiCategory)
    const grid = emojis.map((emoji) => {
      const selected = emoji.emojiId === selectedEmojiId
      return `<button type="button" data-apc-emoji="${escapeHtml(emoji.emojiId)}" title="${emoji.isActive ? 'Продава се' : 'Скрито'}" style="aspect-ratio:1;display:flex;align-items:center;justify-content:center;font-size:22px;line-height:1;border-radius:6px;border:1px solid ${selected ? '#d4a520' : 'rgba(255,255,255,0.08)'};background:${selected ? 'rgba(212,165,32,0.18)' : 'rgba(255,255,255,0.03)'};cursor:pointer;padding:0;${emoji.isActive ? '' : 'opacity:0.3;filter:grayscale(1);'}">${escapeHtml(emoji.emoji)}</button>`
    }).join('')
    const selected = data.emojis.find((emoji) => emoji.emojiId === selectedEmojiId) ?? null
    const categoryOptions = (current: string) => data.emojiCategories.map((category) => `<option value="${escapeHtml(category.key)}" ${category.key === current ? 'selected' : ''}>${escapeHtml(category.label)}</option>`).join('')
    const editor = selected === null
      ? `<div style="font-size:13px;${MUTED}">Избери емоджи, за да го скриеш/покажеш или преместиш в друга категория. Избледнелите са скрити от продажба.</div>`
      : `<div data-apc-emoji-editor="1" style="display:flex;flex-wrap:wrap;align-items:center;gap:8px;">
          <span style="font-size:30px;line-height:1;">${escapeHtml(selected.emoji)}</span>
          <select data-apc-emoji-edit-category="1" style="${INPUT_STYLE}">${categoryOptions(selected.categoryKey)}</select>
          <label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;"><input type="checkbox" data-apc-emoji-edit-active="1" ${selected.isActive ? 'checked' : ''}> Продава се</label>
          <button type="button" data-apc-save-emoji="${escapeHtml(selected.emojiId)}" style="${BTN_PRIMARY}">Запази</button>
        </div>`
    const activeCount = data.emojis.filter((emoji) => emoji.isActive).length
    return `
      <div style="${CARD_STYLE}">
        <div style="font-size:14px;font-weight:800;margin-bottom:8px;">Добави емоджи</div>
        <div style="display:flex;flex-wrap:wrap;align-items:flex-end;gap:8px;">
          <input type="text" data-apc-new-emoji="1" maxlength="16" placeholder="🦄" aria-label="Емоджи" style="${INPUT_STYLE}width:80px;font-size:20px;text-align:center;">
          <select data-apc-new-emoji-category="1" style="${INPUT_STYLE}">${categoryOptions(emojiCategory)}</select>
          <button type="button" data-apc-add-emoji="1" style="${BTN_PRIMARY}">Добави</button>
        </div>
        <div style="font-size:12px;margin-top:6px;${MUTED}">Точно едно емоджи. Избягвай емоджита, по-нови от 2019 г. (Unicode 13+) — Windows 10 ги показва като празно квадратче. Каталог: ${data.emojis.length} общо, ${activeCount} в продажба.</div>
      </div>
      <div style="${CARD_STYLE}">
        <div style="display:flex;gap:6px;overflow-x:auto;-webkit-overflow-scrolling:touch;padding-bottom:6px;margin-bottom:8px;">${categoryButtons}</div>
        <div data-apc-emoji-grid="1" style="max-height:260px;max-width:620px;overflow-y:auto;-webkit-overflow-scrolling:touch;display:grid;gap:4px;margin-bottom:10px;">${grid || `<div style="font-size:13px;${MUTED}">Няма емоджита.</div>`}</div>
        ${editor}
      </div>`
  }

  const renderPurchases = (): string => {
    const statusOptions = ['', 'review_pending', 'paid', 'refunded', 'pending', 'canceled', 'failed']
      .map((status) => `<option value="${status}" ${status === purchasesStatus ? 'selected' : ''}>${escapeHtml(status === '' ? 'Всички' : STATUS_LABELS[status] ?? status)}</option>`).join('')
    const rows = purchases.map((row) => {
      const user = row.displayName !== null
        ? `${escapeHtml(row.displayName)}${row.email ? ` <span style="${MUTED}">(${escapeHtml(row.email)})</span>` : ''}`
        : `<span style="${MUTED}">Изтрит профил</span>`
      const kindLabel = snapshot?.kinds.find((kind) => kind.kind === row.kind)?.label ?? row.kind
      const refund = row.refundedAmountCents !== null && row.refundedAmountCents > 0
        ? ` · <span style="color:#fca5a5;">възстановени ${escapeHtml(formatEuro(row.refundedAmountCents))}${row.status !== 'refunded' ? ' (частично)' : ''}</span>`
        : ''
      const reviewReason = row.refundReviewReason === 'refund_failed'
        ? 'Неуспешно възстановяване: Stripe не е върнал сумата, а правото е анулирано. Нищо не е коригирано автоматично — провери в Stripe и реши ръчно.'
        : 'Частично възстановяване: правата остават активни.'
      const review = row.refundReviewStatus === 'pending'
        ? `<div style="display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:8px;"><span data-apc-review-pending="1" data-apc-review-reason="${escapeHtml(row.refundReviewReason ?? '')}" style="padding:3px 8px;border-radius:999px;border:1px solid #fbbf24;color:#fde68a;font-size:12px;font-weight:800;">Чака преглед</span><span style="font-size:12px;color:#fde68a;flex:1 1 220px;">${escapeHtml(reviewReason)}</span><button type="button" data-apc-mark-reviewed="${escapeHtml(row.purchaseId)}" style="${BTN_SECONDARY}">Маркирай като прегледан</button></div>`
        : row.refundReviewStatus === 'reviewed'
          ? `<div data-apc-reviewed="1" style="font-size:12px;margin-top:6px;${MUTED}">Прегледано${row.refundReviewedByDisplayName ? ` от ${escapeHtml(row.refundReviewedByDisplayName)}` : ''}${row.refundReviewedAt ? ` на ${escapeHtml(formatDate(row.refundReviewedAt))}` : ''} (${row.refundReviewReason === 'refund_failed' ? 'неуспешно възстановяване' : 'частично възстановяване'}).</div>`
          : ''
      const replaced = row.grantEffect === 'replace' && row.replacedItemValue !== null ? ` (замени ${itemPreview(row.kind, row.replacedItemValue)})` : ''
      return `
        <li data-apc-purchase="${escapeHtml(row.purchaseId)}" style="list-style:none;${CARD_STYLE}">
          <div style="display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px;margin-bottom:6px;">
            <div style="font-size:14px;font-weight:800;min-width:0;overflow-wrap:anywhere;">${user}</div>
            <span style="font-size:12px;font-weight:800;">${escapeHtml(STATUS_LABELS[row.status] ?? row.status)}</span>
          </div>
          <div style="font-size:13px;line-height:1.6;">${escapeHtml(kindLabel)}: ${itemPreview(row.kind, row.itemValue)}${row.itemLabel ? ` ${escapeHtml(row.itemLabel)}` : ''} · ${row.days} дни · ${escapeHtml(formatEuro(row.priceCents))}${row.grantEffect !== null ? ` · ${escapeHtml(EFFECT_LABELS[row.grantEffect] ?? row.grantEffect)}${replaced}` : ''}${refund}</div>
          <div style="font-size:12px;${MUTED}">Създадена ${escapeHtml(formatDate(row.createdAt))}${row.creditedAt !== null ? ` · платена ${escapeHtml(formatDate(row.creditedAt))}` : ''}${row.grantedUntil !== null ? ` · валидна до ${escapeHtml(formatDate(row.grantedUntil))}` : ''} · ID ${escapeHtml(row.purchaseId)}</div>
          ${review}
        </li>`
    }).join('')
    const more = purchases.length < purchasesTotal
      ? `<button type="button" data-apc-purchases-more="1" style="${BTN_SECONDARY}" ${purchasesLoading ? 'disabled' : ''}>Покажи още</button>`
      : ''
    return `
      <div style="display:flex;flex-wrap:wrap;align-items:flex-end;gap:8px;margin-bottom:10px;">
        <label style="display:flex;flex-direction:column;gap:4px;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;${MUTED}">Статус
          <select data-apc-purchases-status="1" style="${INPUT_STYLE}">${statusOptions}</select>
        </label>
        <button type="button" data-apc-purchases-refresh="1" style="${BTN_SECONDARY}">Обнови</button>
        <span style="font-size:12px;${MUTED}">${purchasesLoading ? 'Зареждане…' : `Показани ${purchases.length} от ${purchasesTotal}`}</span>
      </div>
      <ul style="margin:0;padding:0;">${rows || (purchasesLoading ? '' : `<li style="list-style:none;font-size:14px;${MUTED}">Няма покупки.</li>`)}</ul>
      ${more}`
  }

  const renderBanners = () => {
    if (snapshot === null) { bannersEl.innerHTML = ''; return }
    const banners: string[] = []
    const access = snapshot.access
    const isPublic = access.mode === 'public'
    const stripeLabel = snapshot.stripeMode === 'live'
      ? '<span data-apc-stripe-mode="live" style="color:#fca5a5;font-weight:900;">LIVE — реални плащания</span>'
      : snapshot.stripeMode === 'test'
        ? '<span data-apc-stripe-mode="test" style="color:#93c5fd;font-weight:900;">TEST</span>'
        : snapshot.stripeMode === 'not_configured'
          ? '<span data-apc-stripe-mode="not_configured" style="color:#fde68a;font-weight:900;">не е конфигуриран</span>'
          : '<span data-apc-stripe-mode="unknown" style="color:#fde68a;font-weight:900;">неизвестен</span>'
    const lastChange = access.changedAt !== null
      ? `Последна промяна: ${escapeHtml(formatDate(access.changedAt))}${access.changedByDisplayName ? ` от ${escapeHtml(access.changedByDisplayName)}` : ''}`
      : 'Режимът не е променян (по подразбиране след внедряване).'
    const confirmText = isPublic
      ? 'Деактивиране: функцията става достъпна само за admin. Новите публични покупки спират веднага. Вече платените екстри НЕ се отнемат и остават видими до изтичането си.'
      : 'Активиране: бутонът "Персонализация" става видим за всички потребители и те могат да купуват екстрите, чиято продажба е включена (таб "Цени и продажба"). Персонализацията се показва на всички в Лафче, Теми и личните чатове.'
    banners.push(`
      <div data-apc-mode-card="1" data-apc-mode="${access.mode}" style="${CARD_STYLE}">
        <div style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;">
          <div style="min-width:0;">
            <div style="font-size:15px;font-weight:900;">Режим: <span data-apc-mode-label="1" style="color:${isPublic ? '#86efac' : '#fde68a'};">${isPublic ? 'Активна за всички' : 'Само админ'}</span></div>
            <div style="font-size:12px;margin-top:4px;${MUTED}">${lastChange}</div>
            ${isPublic ? '' : `<div data-apc-admin-test-note="1" style="font-size:12px;margin-top:2px;${MUTED}">В този режим пълният admin може да тества всички екстри, без да включва публичната им продажба.</div>`}
            <div style="font-size:12px;margin-top:2px;${MUTED}">Stripe: ${stripeLabel}${snapshot.stripeMode === 'live' ? ' — покупките на admin в режим "Само админ" са истински плащания.' : ''}</div>
          </div>
          <button type="button" data-apc-mode-toggle="1" style="${isPublic ? BTN_SECONDARY : BTN_PRIMARY}">${isPublic ? 'Деактивирай' : 'Активирай'}</button>
        </div>
        ${modeConfirmOpen ? `
          <div data-apc-mode-confirm="1" role="alertdialog" style="margin-top:10px;padding:10px 12px;border-radius:8px;border:1px solid rgba(251,191,36,0.45);background:rgba(251,191,36,0.08);color:#fde68a;font-size:13px;line-height:1.5;">
            ${escapeHtml(confirmText)}
            <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;">
              <button type="button" data-apc-mode-confirm-yes="1" style="${BTN_PRIMARY}">${isPublic ? 'Потвърди деактивирането' : 'Потвърди активирането'}</button>
              <button type="button" data-apc-mode-confirm-no="1" style="${BTN_SECONDARY}">Отказ</button>
            </div>
          </div>` : ''}
      </div>`)
    if (access.emergencyStop) {
      banners.push(`<div data-apc-emergency-stop="1" style="margin:0 0 10px;padding:9px 11px;border-radius:8px;border:1px solid rgba(248,113,113,0.45);background:rgba(248,113,113,0.08);color:#fecaca;font-size:13px;line-height:1.45;">Авариен стоп (PROFILE_CUSTOMIZATION_ENABLED=0): новите плащания са спрени за всички, включително admin. Платените екстри остават активни.</div>`)
    }
    if (snapshot.pendingRefundReviews > 0) {
      banners.push(`<div data-apc-review-banner="1" style="margin:0 0 10px;padding:9px 11px;border-radius:8px;border:1px solid rgba(251,191,36,0.45);background:rgba(251,191,36,0.08);color:#fde68a;font-size:13px;line-height:1.45;">Покупки с refund за преглед (частично или неуспешно възстановяване): <b>${snapshot.pendingRefundReviews}</b> — таб "Покупки" → "Чака преглед".</div>`)
    }
    bannersEl.innerHTML = banners.join('')
  }

  const render = () => {
    renderTabs()
    renderBanners()
    if (loadError !== null) {
      bodyEl.innerHTML = `<div data-apc-load-error="1" style="padding:16px 0;font-size:14px;line-height:1.5;color:#fecaca;">${escapeHtml(loadError)}</div>`
      return
    }
    if (snapshot === null) {
      bodyEl.innerHTML = `<div style="padding:16px 0;font-size:14px;${MUTED}">Зареждане…</div>`
      return
    }
    bodyEl.innerHTML = tab === 'pricing' ? renderPricing(snapshot)
      : tab === 'colors' ? renderColors(snapshot)
        : tab === 'emojis' ? renderEmojis(snapshot)
          : renderPurchases()
  }

  // ─── Данни ────────────────────────────────────────────────────────────

  const load = async () => {
    const result = await api('GET', '')
    if (!host.isConnected) return
    if (result.ok) {
      snapshot = result.data as unknown as AdminSnapshot
      loadError = null
    } else {
      loadError = result.message
    }
    render()
  }

  const loadPurchases = async (append: boolean) => {
    purchasesLoading = true
    if (!append) purchases = []
    render()
    const query = new URLSearchParams({ limit: String(PURCHASES_PAGE_SIZE), offset: String(append ? purchases.length : 0) })
    if (purchasesStatus !== '') query.set('status', purchasesStatus)
    const result = await api('GET', `/purchases?${query.toString()}`)
    if (!host.isConnected) return
    purchasesLoading = false
    if (result.ok) {
      const rows = Array.isArray(result.data.rows) ? (result.data.rows as PurchaseRow[]) : []
      purchases = append ? [...purchases, ...rows] : rows
      purchasesTotal = typeof result.data.total === 'number' ? result.data.total : purchases.length
    } else {
      showNotice(result.message, 'error')
    }
    render()
  }

  const mutate = async (method: 'PATCH' | 'POST', path: string, body: Record<string, unknown>, successText: string) => {
    if (busy) return
    busy = true
    showNotice(null)
    const result = await api(method, path, body)
    busy = false
    if (!host.isConnected) return
    if (result.ok) {
      // Първо пресните данни от сървъра, после потвърждението — съобщението
      // никога не изпреварва показаното състояние.
      await load()
      if (host.isConnected) showNotice(successText, 'ok')
    } else {
      showNotice(result.message, 'error')
    }
  }

  // ─── Събития ──────────────────────────────────────────────────────────

  const close = () => {
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

  host.querySelector<HTMLButtonElement>('[data-apc-close="1"]')!.addEventListener('click', close)

  tabsEl.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>('[data-apc-tab]')
    if (button === null) return
    const next = button.getAttribute('data-apc-tab') as Tab
    if (next === tab) return
    tab = next
    showNotice(null)
    render()
    if (tab === 'purchases') void loadPurchases(false)
  })

  bodyEl.addEventListener('input', (event) => {
    const target = event.target as HTMLInputElement
    if (target.matches('[data-apc-new-color-picker="1"]')) {
      const hexInput = bodyEl.querySelector<HTMLInputElement>('[data-apc-new-color-hex="1"]')
      if (hexInput !== null) hexInput.value = target.value.toUpperCase()
    } else if (target.matches('[data-apc-new-color-hex="1"]')) {
      const picker = bodyEl.querySelector<HTMLInputElement>('[data-apc-new-color-picker="1"]')
      if (picker !== null && isHexColor(target.value)) picker.value = target.value
    }
  })

  bodyEl.addEventListener('change', (event) => {
    const target = event.target as HTMLElement
    if (target.matches('[data-apc-purchases-status="1"]')) {
      purchasesStatus = (target as HTMLSelectElement).value
      void loadPurchases(false)
    }
  })

  // "Активирай"/"Деактивирай" — винаги с изрично потвърждение (и сървърът
  // изисква confirm: true). Отговорът носи пресния snapshot.
  bannersEl.addEventListener('click', (event) => {
    const target = event.target as HTMLElement
    if (snapshot === null || modeBusy) return
    if (target.closest('[data-apc-mode-toggle="1"]') !== null) {
      modeConfirmOpen = !modeConfirmOpen
      renderBanners()
      return
    }
    if (target.closest('[data-apc-mode-confirm-no="1"]') !== null) {
      modeConfirmOpen = false
      renderBanners()
      return
    }
    if (target.closest('[data-apc-mode-confirm-yes="1"]') !== null) {
      const nextMode = snapshot.access.mode === 'public' ? 'admin_only' : 'public'
      modeBusy = true
      showNotice(null)
      void api('POST', '/mode', { mode: nextMode, confirm: true }).then((result) => {
        modeBusy = false
        if (!host.isConnected) return
        modeConfirmOpen = false
        if (result.ok) {
          snapshot = result.data as unknown as AdminSnapshot
          render()
          showNotice(nextMode === 'public' ? 'Персонализацията е активирана за всички потребители.' : 'Персонализацията е деактивирана — достъпна е само за admin. Платените екстри остават.', 'ok')
        } else {
          renderBanners()
          showNotice(result.message, 'error')
        }
      })
    }
  })

  bodyEl.addEventListener('click', (event) => {
    const target = event.target as HTMLElement
    const value = (selector: string): string => bodyEl.querySelector<HTMLInputElement | HTMLSelectElement>(selector)?.value ?? ''
    const checked = (selector: string): boolean => bodyEl.querySelector<HTMLInputElement>(selector)?.checked ?? false

    const saveKind = target.closest<HTMLElement>('[data-apc-save-kind]')
    if (saveKind !== null) {
      const kind = saveKind.getAttribute('data-apc-save-kind') ?? ''
      void mutate('PATCH', `/kinds/${encodeURIComponent(kind)}`, {
        basePrice30Days: value(`[data-apc-price="${kind}"]`).trim(),
        salesEnabled: checked(`[data-apc-sales="${kind}"]`),
      }, 'Цената и продажбата са запазени.')
      return
    }

    const saveColor = target.closest<HTMLElement>('[data-apc-save-color]')
    if (saveColor !== null) {
      const colorId = saveColor.getAttribute('data-apc-save-color') ?? ''
      const escaped = CSS.escape(colorId)
      void mutate('PATCH', `/colors/${encodeURIComponent(colorId)}`, {
        label: value(`[data-apc-color-label="${escaped}"]`),
        groupKey: value(`[data-apc-color-group="${escaped}"]`),
        isActive: checked(`[data-apc-color-active="${escaped}"]`),
      }, 'Цветът е запазен.')
      return
    }

    if (target.closest('[data-apc-add-color="1"]') !== null) {
      void mutate('POST', '/colors', {
        hex: value('[data-apc-new-color-hex="1"]').trim(),
        label: value('[data-apc-new-color-label="1"]'),
        groupKey: value('[data-apc-new-color-group="1"]'),
      }, 'Цветът е добавен.')
      return
    }

    const category = target.closest<HTMLElement>('[data-apc-emoji-category]')
    if (category !== null) {
      emojiCategory = category.getAttribute('data-apc-emoji-category') ?? emojiCategory
      selectedEmojiId = null
      render()
      return
    }

    const emoji = target.closest<HTMLElement>('[data-apc-emoji]')
    if (emoji !== null) {
      selectedEmojiId = emoji.getAttribute('data-apc-emoji')
      render()
      return
    }

    const saveEmoji = target.closest<HTMLElement>('[data-apc-save-emoji]')
    if (saveEmoji !== null) {
      const emojiId = saveEmoji.getAttribute('data-apc-save-emoji') ?? ''
      void mutate('PATCH', `/emojis/${encodeURIComponent(emojiId)}`, {
        categoryKey: value('[data-apc-emoji-edit-category="1"]'),
        isActive: checked('[data-apc-emoji-edit-active="1"]'),
      }, 'Емоджито е запазено.')
      return
    }

    if (target.closest('[data-apc-add-emoji="1"]') !== null) {
      void mutate('POST', '/emojis', {
        emoji: value('[data-apc-new-emoji="1"]').trim(),
        categoryKey: value('[data-apc-new-emoji-category="1"]'),
      }, 'Емоджито е добавено.')
      return
    }

    const markReviewed = target.closest<HTMLElement>('[data-apc-mark-reviewed]')
    if (markReviewed !== null) {
      const purchaseId = markReviewed.getAttribute('data-apc-mark-reviewed') ?? ''
      void (async () => {
        await mutate('POST', `/purchases/${encodeURIComponent(purchaseId)}/refund-review`, {}, 'Отбелязано като прегледано.')
        await loadPurchases(false)
      })()
      return
    }

    if (target.closest('[data-apc-purchases-refresh="1"]') !== null) {
      void loadPurchases(false)
      return
    }

    if (target.closest('[data-apc-purchases-more="1"]') !== null) {
      void loadPurchases(true)
    }
  })

  render()
  void load()
  host.querySelector<HTMLButtonElement>('[data-apc-close="1"]')!.focus()
  return { close }
}
