// "Персонализация на профила", Етап 3 — обща логика за показване на
// закупените екстри в "Лафче", "Теми" (публикации + отговори) и личните
// чатове, на десктоп (тъмен фон) и в новия мобилен интерфейс (светъл фон).
//
// Данните идват от сървъра като ТЕКУЩАТА активна персонализация на автора
// (senderCustomization / friendCustomization / viewerCustomization) —
// derived при четене, не копие в съобщението. Полето ЛИПСВА, когато
// PROFILE_CUSTOMIZATION_ENABLED е изключен: тогава всичко се показва
// постарому (вкл. досегашното оцветяване на никовете).
//
// Правила:
//   * Цвят на ника: служебният цвят (pika_team/marketing, #F72585) има
//     приоритет; после закупеният; иначе стандартният — #FFFFFF на тъмния
//     десктоп фон, #000000 на светлия мобилен.
//   * Емоджи пред/след ника — само визуална украса около името (името,
//     кликът и атрибутите остават същите).
//   * Цвят на текста — само текстът на съобщенията на автора; при липса —
//     досегашният цвят на съответния интерфейс.
//   * Изтичане по време на сесията: всяка екстра носи *Until; изтеклата не се
//     показва. Един таймер (не polling) пренарисува в момента на най-ранното
//     изтичане сред показаните (setProfileCustomizationExpiryHandler).
//
// Всички стойности се валидират отново тук (hex / кратко емоджи без HTML) и
// се escape-ват — сървърът е източникът, но в HTML/CSS не влиза нищо
// непроверено.

export type ProfileCustomizationDisplay = {
  nicknameColor: string | null
  nicknameColorUntil: string | null
  messageColor: string | null
  messageColorUntil: string | null
  emojiBefore: string | null
  emojiBeforeUntil: string | null
  emojiAfter: string | null
  emojiAfterUntil: string | null
  /**
   * true (или липсва) = пълен изглед: без закупен цвят никът е стандартният
   * бял/черен. false = ограничен изглед (режим "Само админ" за обикновен
   * зрител): досегашното оцветяване + само изрично закупените стойности.
   */
  standardDefaults?: boolean
}

export type ActiveProfileCustomization = {
  nicknameColor: string | null
  messageColor: string | null
  emojiBefore: string | null
  emojiAfter: string | null
}

/** Стандартен цвят на ника при включена персонализация. */
export const DEFAULT_NICKNAME_COLOR_DARK = '#FFFFFF'
export const DEFAULT_NICKNAME_COLOR_LIGHT = '#000000'

const HEX_COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/
const MAX_TIMEOUT_MS = 2_147_483_647

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function isSafeEmoji(value: string): boolean {
  return value.length > 0 && value.length <= 16 && !/[<>&"'\s]/.test(value)
}

// ─── Изтичане по време на сесията ─────────────────────────────────────────

let expiryHandler: (() => void) | null = null
let expiryTimer: ReturnType<typeof setTimeout> | null = null
let expiryTimerAt: number | null = null

/**
 * Callback, който пренарисува екрана, когато изтече поне една от показаните
 * екстри (контролерът на лобито подава своя render).
 */
export function setProfileCustomizationExpiryHandler(handler: (() => void) | null): void {
  expiryHandler = handler
}

function noteUpcomingExpiry(untilMs: number, nowMs: number): void {
  if (untilMs <= nowMs) return
  if (expiryTimerAt !== null && expiryTimerAt <= untilMs) return
  if (expiryTimer !== null) clearTimeout(expiryTimer)
  expiryTimerAt = untilMs
  expiryTimer = setTimeout(() => {
    expiryTimer = null
    expiryTimerAt = null
    expiryHandler?.()
  }, Math.min(untilMs - nowMs + 250, MAX_TIMEOUT_MS))
}

function activeValue(value: string | null | undefined, until: string | null | undefined, nowMs: number, isValid: (v: string) => boolean): string | null {
  if (typeof value !== 'string' || !isValid(value)) return null
  // Без срок (стар клиент/сървър) — показва се; със срок — само до него.
  if (typeof until === 'string') {
    const untilMs = Date.parse(until)
    if (!Number.isFinite(untilMs) || untilMs <= nowMs) return null
    noteUpcomingExpiry(untilMs, nowMs)
  }
  return value
}

/** null = персонализацията е изключена (полето липсва) → досегашният вид. */
export function resolveActiveCustomization(
  display: ProfileCustomizationDisplay | null | undefined,
  nowMs: number = Date.now(),
): ActiveProfileCustomization | null {
  if (display === null || display === undefined || typeof display !== 'object') return null
  return {
    nicknameColor: activeValue(display.nicknameColor, display.nicknameColorUntil, nowMs, (v) => HEX_COLOR_PATTERN.test(v)),
    messageColor: activeValue(display.messageColor, display.messageColorUntil, nowMs, (v) => HEX_COLOR_PATTERN.test(v)),
    emojiBefore: activeValue(display.emojiBefore, display.emojiBeforeUntil, nowMs, isSafeEmoji),
    emojiAfter: activeValue(display.emojiAfter, display.emojiAfterUntil, nowMs, isSafeEmoji),
  }
}

/**
 * Цвят на ника. При изключена персонализация: ролевият или досегашният
 * (legacyColor) — без промяна. При включена: ролевият → закупеният →
 * стандартният за интерфейса (бял/черен).
 */
export function resolveNicknameColor(
  display: ProfileCustomizationDisplay | null | undefined,
  roleColor: string | null,
  light: boolean,
  legacyColor: string,
): string
export function resolveNicknameColor(
  display: ProfileCustomizationDisplay | null | undefined,
  roleColor: string | null,
  light: boolean,
  legacyColor: null,
): string | null
export function resolveNicknameColor(
  display: ProfileCustomizationDisplay | null | undefined,
  roleColor: string | null,
  light: boolean,
  legacyColor: string | null,
): string | null {
  const active = resolveActiveCustomization(display)
  if (active === null) return roleColor ?? legacyColor
  if (display?.standardDefaults === false) return roleColor ?? active.nicknameColor ?? legacyColor
  return roleColor ?? active.nicknameColor ?? (light ? DEFAULT_NICKNAME_COLOR_LIGHT : DEFAULT_NICKNAME_COLOR_DARK)
}

/** Цвят на текста на съобщение на автора — закупеният или досегашният. */
export function resolveMessageColor(display: ProfileCustomizationDisplay | null | undefined, fallbackColor: string): string {
  return resolveActiveCustomization(display)?.messageColor ?? fallbackColor
}

/**
 * Името (escape-нато) с активните емоджита пред/след него. Емоджитата са
 * aria-hidden украса — достъпното име остава самият ник.
 */
export function renderDecoratedNickname(displayName: string, display: ProfileCustomizationDisplay | null | undefined): string {
  const active = resolveActiveCustomization(display)
  const name = escapeHtml(displayName)
  if (active === null) return name
  const before = active.emojiBefore !== null ? `<span data-pc-name-emoji="before" aria-hidden="true">${escapeHtml(active.emojiBefore)}</span> ` : ''
  const after = active.emojiAfter !== null ? ` <span data-pc-name-emoji="after" aria-hidden="true">${escapeHtml(active.emojiAfter)}</span>` : ''
  return `${before}${name}${after}`
}
