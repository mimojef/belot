// "Персонализация на профила" — ЕДИН попъп след връщане от Stripe Checkout
// за цялата поръчка (1..4 екстри с едно плащане), не отделен попъп за всяка.
//
// Сигурност: redirect-ът от Stripe НЕ доказва плащане. Попъпът знае само
// checkout session id-то; всичко останало (артикули, срокове, обща платена
// сума, статус, крайни дати, ефекти) идва от сървъра — GET
// /api/profile-customization?sessionId=… връща САМО собствена поръчка. Успех
// се показва единствено при статус 'paid' (кредитирано от webhook-а). Докато webhook-ът не е обработен:
// "Проверяваме плащането..." + ограничена автоматична проверка и бутон
// "Провери отново" (без ново плащане). Без фалшив успех/отказ.
//
// Еднократност и устойчивост (само удобство в браузъра; истината е на
// сървъра): чакащата поръчка се помни (localStorage), за да не се загуби при
// забавен webhook/презареждане; показаният окончателен резултат се отбелязва
// и не се показва отново при обикновено презареждане.

import { renderUnifiedCustomizationPreview } from './renderUnifiedCustomizationPreview'
import { getRoleNicknameColor } from '../lobby/roleNicknameColor'

type Kind = 'nickname_color' | 'message_color' | 'emoji_before' | 'emoji_after'

type ReturnOrderItem = {
  purchaseId: string
  kind: Kind
  kindLabel: string
  itemType: 'color' | 'emoji'
  itemValue: string
  itemLabel: string | null
  days: number
  priceCents: number
  status: string
  grantEffect: 'new' | 'extend' | 'replace' | null
  grantedUntil: string | null
}

type ReturnOrder = {
  orderId: string
  status: 'pending' | 'paid' | 'canceled' | 'failed' | 'refunded'
  totalCents: number
  currency: string
  items: ReturnOrderItem[]
}

type ActiveItem = { value: string; activeUntil: string } | null

type Snapshot = {
  active: Record<Kind, ActiveItem>
  returnOrder: ReturnOrder | null
}

export type ProfileCustomizationPurchasePopupDeps = {
  getApiBaseUrl: () => string
  /** null = връщане с "cancel" (без поръчка за проверка). */
  checkoutSessionId: string | null
  displayName: string
  nameHighlightRole: string | null
  theme: 'dark' | 'light'
}

const HOST_ID = 'profile-customization-purchase-popup'
const AUTO_CHECK_INTERVAL_MS = 2_000
const AUTO_CHECK_MAX_ATTEMPTS = 15
const PENDING_STORAGE_KEY = 'pika.profileCustomization.pendingCheckout'
const SEEN_STORAGE_PREFIX = 'pika.profileCustomization.resultShown.'

// ─── Локално удобство (try/catch — частни прозорци/блокиран storage) ──────

function storageGet(key: string): string | null {
  try { return window.localStorage.getItem(key) } catch { return null }
}
function storageSet(key: string, value: string): void {
  try { window.localStorage.setItem(key, value) } catch { /* без storage — само без запомняне */ }
}
function storageRemove(key: string): void {
  try { window.localStorage.removeItem(key) } catch { /* без storage */ }
}

/** Запомня поръчката при връщане от Stripe (преди потвърждението на webhook-а). */
export function rememberPendingProfileCustomizationCheckout(checkoutSessionId: string): void {
  if (storageGet(SEEN_STORAGE_PREFIX + checkoutSessionId) === null) storageSet(PENDING_STORAGE_KEY, checkoutSessionId)
}

/** Чакаща (непотвърдена/непоказана) поръчка от предишно посещение, ако има. */
export function getPendingProfileCustomizationCheckout(): string | null {
  const sessionId = storageGet(PENDING_STORAGE_KEY)
  if (sessionId === null || sessionId.trim() === '') return null
  if (storageGet(SEEN_STORAGE_PREFIX + sessionId) !== null) {
    storageRemove(PENDING_STORAGE_KEY)
    return null
  }
  return sessionId
}

export function wasProfileCustomizationResultShown(checkoutSessionId: string): boolean {
  return storageGet(SEEN_STORAGE_PREFIX + checkoutSessionId) !== null
}

function markResultShown(checkoutSessionId: string): void {
  storageSet(SEEN_STORAGE_PREFIX + checkoutSessionId, new Date().toISOString())
  if (storageGet(PENDING_STORAGE_KEY) === checkoutSessionId) storageRemove(PENDING_STORAGE_KEY)
}

// ─── Форматиране ──────────────────────────────────────────────────────────

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function formatEuro(cents: number, currency: string): string {
  return new Intl.NumberFormat('bg-BG', { style: 'currency', currency: currency || 'EUR' }).format(cents / 100)
}

function formatDate(iso: string | null): string {
  if (iso === null) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('bg-BG', { timeZone: 'Europe/Sofia', day: '2-digit', month: '2-digit', year: 'numeric' }).format(date)
}

const EFFECT_LABELS: Record<string, string> = {
  new: 'Нова покупка',
  extend: 'Удължаване',
  replace: 'Замяна на предишната персонализация',
}

const THEMES = {
  dark: { overlay: 'rgba(0,0,0,0.82)', bg: '#111111', border: 'rgba(212,165,32,0.35)', text: '#f1f5f9', muted: 'rgba(226,232,240,0.66)', accent: '#d4a520', ok: '#86efac', err: '#fca5a5', primaryBg: 'linear-gradient(180deg,#f4c95b 0%,#c98f13 100%)', primaryText: '#080808', secondaryBorder: 'rgba(255,255,255,0.22)' },
  light: { overlay: 'rgba(16,24,40,0.55)', bg: '#FFFFFF', border: '#EAECF0', text: '#101828', muted: '#667085', accent: '#6941C6', ok: '#067647', err: '#B42318', primaryBg: 'linear-gradient(180deg,#7F56D9 0%,#6941C6 100%)', primaryText: '#FFFFFF', secondaryBorder: '#D0D5DD' },
} as const

export function showProfileCustomizationPurchasePopup(deps: ProfileCustomizationPurchasePopupDeps): { close: () => void } {
  document.getElementById(HOST_ID)?.remove()
  const t = THEMES[deps.theme]
  const host = document.createElement('div')
  host.id = HOST_ID
  host.setAttribute('data-pcp-theme', deps.theme)
  host.style.cssText = `position:fixed;inset:0;z-index:210000;overflow-y:auto;-webkit-overflow-scrolling:touch;background:${t.overlay};font-family:${deps.theme === 'light' ? 'inherit' : 'Arial,Helvetica,sans-serif'};`
  document.body.appendChild(host)

  let attempts = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let checking = false

  const frame = (inner: string) => `
    <div style="min-height:100%;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;">
      <section role="dialog" aria-modal="true" aria-labelledby="pcp-title" data-pcp-dialog="1"
        style="width:min(100%,440px);box-sizing:border-box;border-radius:12px;border:1px solid ${t.border};background:${t.bg};color:${t.text};padding:20px;box-shadow:0 34px 80px rgba(0,0,0,0.4);">
        ${inner}
      </section>
    </div>`

  const okButton = `<button type="button" data-pcp-ok="1" style="width:100%;min-height:44px;margin-top:16px;border:0;border-radius:8px;background:${t.primaryBg};color:${t.primaryText};font-size:16px;font-weight:900;cursor:pointer;font-family:inherit;">ОК</button>`

  const renderMessage = (state: string, title: string, text: string, tone: 'muted' | 'err', withRetry: boolean) => {
    host.innerHTML = frame(`
      <h2 id="pcp-title" data-pcp-state="${state}" style="margin:0 0 8px;font-size:20px;font-weight:900;color:${tone === 'err' ? t.err : t.accent};text-align:center;">${escapeHtml(title)}</h2>
      <p style="margin:0;font-size:14px;line-height:1.5;color:${t.muted};text-align:center;">${escapeHtml(text)}</p>
      ${withRetry ? `<button type="button" data-pcp-retry="1" style="width:100%;min-height:42px;margin-top:16px;border:1px solid ${t.secondaryBorder};border-radius:8px;background:transparent;color:${t.text};font-size:15px;font-weight:800;cursor:pointer;font-family:inherit;">Провери отново</button>` : ''}
      ${okButton}`)
    host.querySelector<HTMLButtonElement>('[data-pcp-ok="1"]')?.focus()
  }

  const renderChecking = (stillWaiting: boolean) => {
    renderMessage(
      stillWaiting ? 'waiting' : 'checking',
      'Проверяваме плащането...',
      stillWaiting
        ? 'Stripe още не е потвърдил плащането. Персонализацията ще се активира автоматично веднага щом бъде потвърдено — не плащай повторно. Можеш да провериш отново по всяко време.'
        : 'Изчакваме потвърждението от Stripe. Това обикновено отнема няколко секунди.',
      'muted',
      stillWaiting,
    )
  }

  const itemHtml = (item: ReturnOrderItem): string => item.itemType === 'color'
    ? `<span style="display:inline-block;width:14px;height:14px;border-radius:3px;vertical-align:-2px;background:${/^#[0-9A-Fa-f]{6}$/.test(item.itemValue) ? item.itemValue : 'transparent'};box-shadow:inset 0 0 0 1px rgba(0,0,0,0.2);"></span> ${escapeHtml(item.itemLabel ?? item.itemValue)} (${escapeHtml(item.itemValue)})`
    : `<span style="font-size:18px;">${escapeHtml(item.itemValue)}</span>`

  const renderSuccess = (order: ReturnOrder, snapshot: Snapshot) => {
    const items = order.items
    const allExtended = items.length > 0 && items.every((item) => item.grantEffect === 'extend')
    const single = items.length === 1
    const title = single && allExtended ? 'Персонализацията ти е удължена!' : 'Успешна покупка!'
    const subtitle = single
      ? (allExtended ? 'Новата крайна дата включва и оставащите дни от предишната покупка.' : 'Персонализацията ти е активирана.')
      : `Активирани са ${items.length} персонализации с едно плащане.`
    const value = (kind: Kind) => snapshot.active[kind]?.value ?? null
    const lines = items.map((item) => `
      <li data-pcp-item="${escapeHtml(item.kind)}" data-pcp-item-effect="${escapeHtml(item.grantEffect ?? '')}" style="list-style:none;padding:8px 0;border-top:1px solid ${t.border};font-size:14px;line-height:1.45;">
        <div style="display:flex;justify-content:space-between;gap:12px;">
          <span style="font-weight:900;">${escapeHtml(item.kindLabel)}</span>
          <span style="font-weight:800;text-align:right;overflow-wrap:anywhere;">${itemHtml(item)}</span>
        </div>
        <div style="display:flex;justify-content:space-between;gap:12px;font-size:13px;color:${t.muted};">
          <span>${item.days} дни · ${escapeHtml(EFFECT_LABELS[item.grantEffect ?? ''] ?? '—')}</span>
          <span data-pcp-item-until="1" style="flex:0 0 auto;white-space:nowrap;">активна до <b style="color:${t.text};">${escapeHtml(formatDate(item.grantedUntil))}</b></span>
        </div>
      </li>`).join('')
    host.innerHTML = frame(`
      <h2 id="pcp-title" data-pcp-state="success" data-pcp-count="${items.length}" style="margin:0 0 4px;font-size:22px;font-weight:900;color:${t.accent};text-align:center;">${escapeHtml(title)}</h2>
      <p style="margin:0 0 14px;font-size:14px;color:${t.muted};text-align:center;">${escapeHtml(subtitle)}</p>
      ${renderUnifiedCustomizationPreview({
        displayName: deps.displayName,
        theme: deps.theme,
        staffNicknameColor: getRoleNicknameColor(deps.nameHighlightRole),
        nicknameColor: value('nickname_color'),
        messageColor: value('message_color'),
        emojiBefore: value('emoji_before'),
        emojiAfter: value('emoji_after'),
      })}
      <ul data-pcp-items="1" style="margin:14px 0 0;padding:0;">${lines}</ul>
      <div data-pcp-row="total" style="display:flex;justify-content:space-between;gap:12px;padding:8px 0 0;border-top:1px solid ${t.border};font-size:15px;">
        <span style="color:${t.muted};">Общо платено</span>
        <span data-pcp-total="${order.totalCents}" style="font-weight:900;">${escapeHtml(formatEuro(order.totalCents, order.currency))}</span>
      </div>
      ${okButton}`)
    host.querySelector<HTMLButtonElement>('[data-pcp-ok="1"]')?.focus()
  }

  const finish = () => {
    if (deps.checkoutSessionId !== null) markResultShown(deps.checkoutSessionId)
  }

  async function fetchState(): Promise<{ ok: true; snapshot: Snapshot } | { ok: false; status: number }> {
    try {
      const response = await fetch(`${deps.getApiBaseUrl()}/api/profile-customization?sessionId=${encodeURIComponent(deps.checkoutSessionId ?? '')}`, { credentials: 'include', cache: 'no-store' })
      const data = (await response.json().catch(() => null)) as (Snapshot & { ok?: boolean }) | null
      if (response.ok && data?.ok === true) return { ok: true, snapshot: data }
      return { ok: false, status: response.status }
    } catch {
      return { ok: false, status: 0 }
    }
  }

  const check = async (manual: boolean) => {
    if (checking || deps.checkoutSessionId === null) return
    checking = true
    if (manual) renderChecking(false)
    const result = await fetchState()
    checking = false
    if (!host.isConnected) return
    if (!result.ok) {
      if (result.status === 0 || result.status >= 500) {
        // Временна грешка — поръчката остава запомнена, без извод за плащането.
        renderMessage('error', 'Няма връзка със сървъра', 'Не успяхме да проверим плащането. Опитай отново след малко — нищо не е загубено.', 'muted', true)
        return
      }
      finish()
      renderMessage('unavailable', 'Поръчката не може да бъде проверена', 'Ако си платил, персонализацията ще бъде активирана след потвърждение от Stripe. При въпроси се свържи с поддръжката.', 'muted', false)
      return
    }
    const order = result.snapshot.returnOrder ?? null
    if (order === null) {
      finish()
      renderMessage('not_found', 'Поръчката не е намерена', 'Не открихме поръчка за този профил. Ако си платил, свържи се с поддръжката.', 'err', false)
      return
    }
    if (order.status === 'paid') {
      finish()
      renderSuccess(order, result.snapshot)
      return
    }
    if (order.status === 'pending') {
      attempts += 1
      if (attempts >= AUTO_CHECK_MAX_ATTEMPTS && !manual) {
        renderChecking(true)
        return
      }
      if (manual) {
        renderChecking(true)
        return
      }
      timer = setTimeout(() => { void check(false) }, AUTO_CHECK_INTERVAL_MS)
      return
    }
    finish()
    if (order.status === 'refunded') {
      renderMessage('refunded', 'Плащането е възстановено', 'Сумата е върната и персонализацията не е активирана.', 'err', false)
    } else {
      renderMessage('not_paid', 'Плащането не е завършено', 'Нищо не е таксувано и нищо не е променено.', 'err', false)
    }
  }

  const close = () => {
    if (timer !== null) clearTimeout(timer)
    document.removeEventListener('keydown', onKeydown, true)
    host.remove()
  }
  const onKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); close() }
  }
  document.addEventListener('keydown', onKeydown, true)

  host.addEventListener('click', (event) => {
    const target = event.target as HTMLElement
    if (target.closest('[data-pcp-ok="1"]') !== null) { close(); return }
    if (target.closest('[data-pcp-retry="1"]') !== null) { void check(true) }
  })

  if (deps.checkoutSessionId === null) {
    renderMessage('canceled', 'Плащането е отказано', 'Нищо не е таксувано и нищо не е променено.', 'muted', false)
  } else {
    renderChecking(false)
    void check(false)
  }
  return { close }
}
