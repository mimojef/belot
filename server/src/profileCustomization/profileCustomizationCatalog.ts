// "Персонализация на профила" — чисти (без база) константи и правила:
// видовете екстри, разрешените срокове, точното изчисление на цената в
// центове, групите цветове, категориите емоджита, запазеният служебен цвят и
// валидацията на нови цветове/емоджита от админ панела.
//
// Единственият източник на истината за тези правила на сървъра. Клиентът
// никога не подава цена — тя винаги се изчислява тук от админ настройката.

export const PROFILE_CUSTOMIZATION_KINDS = ['nickname_color', 'message_color', 'emoji_before', 'emoji_after'] as const

export type ProfileCustomizationKind = typeof PROFILE_CUSTOMIZATION_KINDS[number]

export type ProfileCustomizationItemType = 'color' | 'emoji'

export const PROFILE_CUSTOMIZATION_KIND_LABELS: Record<ProfileCustomizationKind, string> = {
  nickname_color: 'Цвят на никнейма',
  message_color: 'Цвят на текста на съобщенията',
  emoji_before: 'Емоджи пред никнейма',
  emoji_after: 'Емоджи след никнейма',
}

export function isProfileCustomizationKind(value: unknown): value is ProfileCustomizationKind {
  return typeof value === 'string' && (PROFILE_CUSTOMIZATION_KINDS as readonly string[]).includes(value)
}

export function getProfileCustomizationItemType(kind: ProfileCustomizationKind): ProfileCustomizationItemType {
  return kind === 'nickname_color' || kind === 'message_color' ? 'color' : 'emoji'
}

// ─── Срокове и цена ──────────────────────────────────────────────────────

export const PROFILE_CUSTOMIZATION_DURATION_DAYS = [30, 60, 90, 120, 150, 180] as const

export type ProfileCustomizationDurationDays = typeof PROFILE_CUSTOMIZATION_DURATION_DAYS[number]

export function isProfileCustomizationDurationDays(value: unknown): value is ProfileCustomizationDurationDays {
  return typeof value === 'number' && (PROFILE_CUSTOMIZATION_DURATION_DAYS as readonly number[]).includes(value)
}

/** Минималната сума за Stripe плащане в EUR е 0.50 €. */
export const PROFILE_CUSTOMIZATION_MIN_BASE_PRICE_CENTS = 50
export const PROFILE_CUSTOMIZATION_MAX_BASE_PRICE_CENTS = 100_000

export function isValidProfileCustomizationBasePriceCents(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= PROFILE_CUSTOMIZATION_MIN_BASE_PRICE_CENTS
    && value <= PROFILE_CUSTOMIZATION_MAX_BASE_PRICE_CENTS
}

/**
 * Цена = базова цена за 30 дни × (дни / 30), в цели центове. Дните са
 * кратни на 30, така че множителят е цяло число 1..6 — без деление на
 * центове, без закръгляне, без floating-point. Без отстъпки за по-дълъг срок.
 */
export function computeProfileCustomizationPriceCents(basePrice30DaysCents: number, days: ProfileCustomizationDurationDays): number {
  if (!isValidProfileCustomizationBasePriceCents(basePrice30DaysCents)) {
    throw new Error('profile_customization_invalid_base_price')
  }
  if (!isProfileCustomizationDurationDays(days)) {
    throw new Error('profile_customization_invalid_duration')
  }
  return basePrice30DaysCents * (days / 30)
}

/**
 * "1.99" / "1,99" / "12" / "0.5" -> цели центове, чрез разбор на низа (без
 * floating-point). null при невалиден формат (до 2 знака след запетаята).
 */
export function parseEuroAmountToCents(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const match = /^(\d{1,6})(?:[.,](\d{1,2}))?$/.exec(value.trim())
  if (match === null) return null
  const euros = Number.parseInt(match[1] as string, 10)
  const cents = Number.parseInt((match[2] ?? '').padEnd(2, '0'), 10)
  return euros * 100 + cents
}

export function buildProfileCustomizationPriceTable(basePrice30DaysCents: number): Array<{ days: ProfileCustomizationDurationDays; priceCents: number }> {
  return PROFILE_CUSTOMIZATION_DURATION_DAYS.map((days) => ({
    days,
    priceCents: computeProfileCustomizationPriceCents(basePrice30DaysCents, days),
  }))
}

export const PROFILE_CUSTOMIZATION_DAY_MS = 86_400_000

/** Оставащи дни за показване: закръглени нагоре (остават 3 ч. -> "1 ден"); 0 ако е изтекло. */
export function computeProfileCustomizationRemainingDays(activeUntilIso: string, now: Date): number {
  const remainingMs = Date.parse(activeUntilIso) - now.getTime()
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return 0
  return Math.ceil(remainingMs / PROFILE_CUSTOMIZATION_DAY_MS)
}

// ─── Цветове ─────────────────────────────────────────────────────────────

export const PROFILE_CUSTOMIZATION_COLOR_GROUPS = ['red', 'orange', 'gold', 'green', 'teal', 'blue', 'purple'] as const

export type ProfileCustomizationColorGroup = typeof PROFILE_CUSTOMIZATION_COLOR_GROUPS[number]

export const PROFILE_CUSTOMIZATION_COLOR_GROUP_LABELS: Record<ProfileCustomizationColorGroup, string> = {
  red: 'Червени',
  orange: 'Оранжеви',
  gold: 'Златисти и жълти',
  green: 'Зелени',
  teal: 'Тюркоазени',
  blue: 'Сини',
  purple: 'Лилави',
}

export function isProfileCustomizationColorGroup(value: unknown): value is ProfileCustomizationColorGroup {
  return typeof value === 'string' && (PROFILE_CUSTOMIZATION_COLOR_GROUPS as readonly string[]).includes(value)
}

/**
 * Служебният цвят на никовете на pika_team и marketing
 * (src/app/lobby/roleNicknameColor.ts). Не може да бъде платен цвят.
 */
export const PROFILE_CUSTOMIZATION_RESERVED_STAFF_COLOR = '#F72585'

/**
 * Под този праг (CIE76 ΔE) цветът се счита за визуално неразличим от
 * служебния и се отказва — иначе #F82686 или #FF1493 биха заобиколили
 * забраната. За сравнение: най-близкият цвят от началната палитра
 * (#F14E59) е на ΔE ≈ 33.
 */
export const PROFILE_CUSTOMIZATION_RESERVED_COLOR_MIN_DELTA_E = 20

/**
 * Изрично одобрени от собственика цветове под прага на ΔE (2026-11-08):
 * Розов #DC408E (ΔE ≈ 16 от служебния, контраст 5.17 на черно / 4.06 на
 * бяло). Изключението важи само за точно тези стойности — прагът остава за
 * всички останали, а самият служебен цвят никога не е изключение.
 */
export const PROFILE_CUSTOMIZATION_APPROVED_NEAR_RESERVED_COLORS: readonly string[] = ['#DC408E']

/**
 * Минимален контраст и на черен, и на бял фон (WCAG 2.x, 3:1 = AA за
 * удебелен/едър текст). Цвят под прага се приема от админа, но се маркира
 * с предупреждение в админ панела.
 */
export const PROFILE_CUSTOMIZATION_MIN_CONTRAST_RATIO = 3

/** '#abc' / 'abcdef' / '#AbCdEf' -> '#ABCDEF'; null ако не е валиден hex. */
export function normalizeProfileCustomizationHex(value: unknown): string | null {
  if (typeof value !== 'string') return null
  let hex = value.trim().replace(/^#/, '').toUpperCase()
  if (/^[0-9A-F]{3}$/.test(hex)) hex = hex.split('').map((c) => c + c).join('')
  return /^[0-9A-F]{6}$/.test(hex) ? `#${hex}` : null
}

function hexToRgb(hex: string): [number, number, number] {
  return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)) as [number, number, number]
}

function srgbChannelToLinear(channel: number): number {
  const c = channel / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** WCAG relative luminance (0..1). */
export function computeRelativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map(srgbChannelToLinear) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function roundRatio(value: number): number {
  return Math.round(value * 100) / 100
}

export type ProfileCustomizationColorContrast = {
  onBlack: number
  onWhite: number
  /** И двата >= PROFILE_CUSTOMIZATION_MIN_CONTRAST_RATIO. */
  meetsMinimum: boolean
}

export function computeProfileCustomizationColorContrast(hex: string): ProfileCustomizationColorContrast {
  const luminance = computeRelativeLuminance(hex)
  // Черно: L = 0, бяло: L = 1 -> (L1 + 0.05) / (L2 + 0.05).
  const onBlack = roundRatio((luminance + 0.05) / 0.05)
  const onWhite = roundRatio(1.05 / (luminance + 0.05))
  return {
    onBlack,
    onWhite,
    meetsMinimum: onBlack >= PROFILE_CUSTOMIZATION_MIN_CONTRAST_RATIO && onWhite >= PROFILE_CUSTOMIZATION_MIN_CONTRAST_RATIO,
  }
}

function hexToLab(hex: string): [number, number, number] {
  const [r, g, b] = hexToRgb(hex).map(srgbChannelToLinear) as [number, number, number]
  // sRGB (D65) -> XYZ, нормализиран спрямо референтното бяло.
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116)
  const fx = f(x)
  const fy = f(y)
  const fz = f(z)
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

/** CIE76 ΔE между два цвята (0 = идентични). */
export function computeColorDeltaE(hexA: string, hexB: string): number {
  const a = hexToLab(hexA)
  const b = hexToLab(hexB)
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

/** true ако цветът е служебният или визуално неразличим от него. */
export function isReservedOrNearReservedStaffColor(hex: string): boolean {
  const normalized = normalizeProfileCustomizationHex(hex)
  if (normalized === null) return false
  if (normalized === PROFILE_CUSTOMIZATION_RESERVED_STAFF_COLOR) return true
  if (PROFILE_CUSTOMIZATION_APPROVED_NEAR_RESERVED_COLORS.includes(normalized)) return false
  return computeColorDeltaE(normalized, PROFILE_CUSTOMIZATION_RESERVED_STAFF_COLOR) < PROFILE_CUSTOMIZATION_RESERVED_COLOR_MIN_DELTA_E
}

export const PROFILE_CUSTOMIZATION_COLOR_LABEL_MAX_LENGTH = 40

// ─── Емоджита ────────────────────────────────────────────────────────────

export const PROFILE_CUSTOMIZATION_EMOJI_CATEGORIES = [
  'smileys', 'kisses', 'hearts', 'ghosts', 'animals', 'bugs', 'flowers',
  'fruits', 'stars', 'crowns', 'games', 'gestures', 'food', 'symbols', 'other',
] as const

export type ProfileCustomizationEmojiCategory = typeof PROFILE_CUSTOMIZATION_EMOJI_CATEGORIES[number]

export const PROFILE_CUSTOMIZATION_EMOJI_CATEGORY_LABELS: Record<ProfileCustomizationEmojiCategory, string> = {
  smileys: 'Усмивки',
  kisses: 'Целувки',
  hearts: 'Сърца',
  ghosts: 'Духчета и дяволчета',
  animals: 'Животни',
  bugs: 'Пеперуди и насекоми',
  flowers: 'Цветя и растения',
  fruits: 'Плодове и зеленчуци',
  stars: 'Звезди и небе',
  crowns: 'Корони и блясък',
  games: 'Игри и развлечения',
  gestures: 'Жестове',
  food: 'Храна и напитки',
  symbols: 'Символи',
  other: 'Други',
}

/** Икона на категорията в хоризонталната лента (Етап 2). */
export const PROFILE_CUSTOMIZATION_EMOJI_CATEGORY_ICONS: Record<ProfileCustomizationEmojiCategory, string> = {
  smileys: '😀',
  kisses: '😘',
  hearts: '❤️',
  ghosts: '👻',
  animals: '🐶',
  bugs: '🦋',
  flowers: '🌸',
  fruits: '🍓',
  stars: '⭐',
  crowns: '👑',
  games: '🎲',
  gestures: '👍',
  food: '🍰',
  symbols: '💯',
  other: '🚀',
}

export function isProfileCustomizationEmojiCategory(value: unknown): value is ProfileCustomizationEmojiCategory {
  return typeof value === 'string' && (PROFILE_CUSTOMIZATION_EMOJI_CATEGORIES as readonly string[]).includes(value)
}

// RGI_Emoji (property of strings) изисква флага 'v'; създава се по време на
// изпълнение, за да не зависи от target-а на TypeScript.
const RGI_EMOJI_PATTERN = new RegExp('^\\p{RGI_Emoji}$', 'v')

/**
 * Точно едно препоръчано (RGI) емоджи — без текст, без няколко емоджита,
 * без "текстова" форма без VS16 (напр. U+2764 без U+FE0F не минава).
 * Тоновете на кожата и знамената технически минават — каталогът ги избягва
 * по редакционно решение, админът носи отговорност за ръчно добавените.
 */
export function normalizeProfileCustomizationEmoji(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > 16) return null
  return RGI_EMOJI_PATTERN.test(trimmed) ? trimmed : null
}
