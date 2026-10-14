// Имена на продуктите в Stripe Checkout (line_items.price_data.product_data.name).
// Клиентът вижда точно какво купува — количество жълтици и/или VIP дни.
//
// Всички стойности идват от SNAPSHOT-а на конкретната поръчка (ledger реда),
// никога от текущите настройки на магазина: подновена неплатена поръчка
// показва своите условия, а нова поръчка след промяна на офертата — новите.
// Продуктите са динамични (inline price_data), глобални Stripe продукти не се
// създават/редактират. Цената/сумата не се пипа тук.

// Stripe позволява до 5000 символа; ограничаваме консервативно, за да остане
// четимо в Checkout. Съкращава се само името на пакета — условията остават.
export const CHECKOUT_PRODUCT_NAME_MAX_LENGTH = 250

const SEPARATOR = ' — '

// Същото форматиране като магазина (renderLobbyScreen.formatAmount):
// bg-BG групира хилядите с неразделим интервал, напр. 2 250 000.
const bgIntegerFormat = new Intl.NumberFormat('bg-BG', { maximumFractionDigits: 0 })

export function formatBgInteger(value: number): string {
  return bgIntegerFormat.format(value)
}

function formatCoins(amount: number): string {
  return `${formatBgInteger(amount)} ${amount === 1 ? 'жълтица' : 'жълтици'}`
}

function formatDays(days: number): string {
  return `${formatBgInteger(days)} ${days === 1 ? 'ден' : 'дни'}`
}

function composeProductName(title: string, terms: string): string {
  const cleanTitle = title.trim().replace(/\s+/g, ' ') || 'Пакет'
  const room = CHECKOUT_PRODUCT_NAME_MAX_LENGTH - SEPARATOR.length - terms.length
  // Array.from — по code point, за да не се среже surrogate двойка (emoji).
  const titleChars = Array.from(cleanTitle)
  const shownTitle = titleChars.length > room
    ? `${titleChars.slice(0, Math.max(1, room - 1)).join('').trimEnd()}…`
    : cleanTitle

  return `${shownTitle}${SEPARATOR}${terms}`
}

/** „Елит — 2 250 000 жълтици“ */
export function buildCoinCheckoutProductName(purchase: { title: string; yellowCoinsAmount: number }): string {
  return composeProductName(purchase.title, formatCoins(purchase.yellowCoinsAmount))
}

/** „VIP — 365 дни“ (дните от snapshot-а на поръчката). */
export function buildVipCheckoutProductName(purchase: { days: number }): string {
  return composeProductName('VIP', formatDays(purchase.days))
}

/** „Ултра — 4 500 000 жълтици + 365 дни VIP“ */
export function buildBundleCheckoutProductName(purchase: {
  titleSnapshot: string
  yellowCoinsAmount: number
  vipDays: number
}): string {
  return composeProductName(
    purchase.titleSnapshot,
    `${formatCoins(purchase.yellowCoinsAmount)} + ${formatDays(purchase.vipDays)} VIP`,
  )
}
