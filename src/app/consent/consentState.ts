// Централен, версиран source of truth за GDPR consent избора на потребителя.
// Съхранява се в localStorage — читаем е синхронно навсякъде (banner, modal,
// analytics wrapper-и), без нужда от React/сигнал библиотека.
//
// v2: три отделни категории вместо предишните две (само necessary/analytics):
//   - necessary  — винаги true, не е избираема (сесия, вход, сигурност,
//     consent state, PWA, основна работа на сайта).
//   - analytics  — измерване на използването на сайта. Към момента НЕ
//     задейства никаква реална интеграция (виж initializeAnalytics.ts) —
//     запазена е като отделна категория за бъдеща аналитична интеграция.
//   - marketing  — управлява Google AdSense и Meta Pixel (PageView,
//     CompleteRegistration).
//
// Ключът се смени от pika-consent-v1 на pika-consent-v2 умишлено — стар v1
// запис просто не се разпознава под новия ключ (isValidConsentShape така или
// иначе би отхвърлил старата двукатегорийна форма заради version mismatch),
// така че потребителят винаги вижда banner-а отново и прави нов, explicit
// избор и за двете нови категории, вместо старото analytics:true да се приеме
// автоматично и за marketing.

export const CONSENT_STORAGE_KEY = 'pika-consent-v2'
export const CONSENT_VERSION = 2

export type ConsentState = {
  version: typeof CONSENT_VERSION
  necessary: true
  analytics: boolean
  marketing: boolean
  updatedAt: string
}

type ConsentListener = (consent: ConsentState | null) => void

const listeners = new Set<ConsentListener>()

function isValidConsentShape(value: unknown): value is ConsentState {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    record.version === CONSENT_VERSION &&
    record.necessary === true &&
    typeof record.analytics === 'boolean' &&
    typeof record.marketing === 'boolean' &&
    typeof record.updatedAt === 'string'
  )
}

// Невалиден JSON, грешна структура или стара версия на политиката → null,
// което кара UI слоя да покаже началния banner отново.
function parseStoredConsent(raw: string | null): ConsentState | null {
  if (raw === null) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  return isValidConsentShape(parsed) ? parsed : null
}

function readRawConsent(): string | null {
  try {
    return localStorage.getItem(CONSENT_STORAGE_KEY)
  } catch {
    return null
  }
}

function writeConsent(consent: ConsentState): void {
  try {
    localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify(consent))
  } catch {
    // localStorage недостъпен (private mode/quota) — consent просто не
    // персистира между презареждания; текущата сесия все пак работи с
    // in-memory стойността, за да не блокира приложението.
  }
  cachedConsent = consent
  notifyListeners()
}

let cachedConsent: ConsentState | null = parseStoredConsent(readRawConsent())

function notifyListeners(): void {
  for (const listener of listeners) {
    listener(cachedConsent)
  }
}

/** Текущият валиден consent запис, или null ако липсва/невалиден/остарял. */
export function getConsent(): ConsentState | null {
  return cachedConsent
}

/**
 * Guard за analytics-only код (измерване на използването на сайта). Към
 * момента няма реална интеграция, закачена за тази категория — виж
 * src/app/analytics/initializeAnalytics.ts.
 */
export function hasAnalyticsConsent(): boolean {
  return getConsent()?.analytics === true
}

/** Guard за marketing-gated код (Google AdSense, Meta Pixel). */
export function hasMarketingConsent(): boolean {
  return getConsent()?.marketing === true
}

/** true само ако вече има валиден, записан избор (banner не трябва да се показва). */
export function hasRecordedChoice(): boolean {
  return getConsent() !== null
}

function saveConsent(analytics: boolean, marketing: boolean): ConsentState {
  const consent: ConsentState = {
    version: CONSENT_VERSION,
    necessary: true,
    analytics,
    marketing,
    updatedAt: new Date().toISOString(),
  }
  writeConsent(consent)
  return consent
}

/** „Приеми всички“ — necessary (винаги true) + analytics: true + marketing: true. */
export function acceptAllConsent(): ConsentState {
  return saveConsent(true, true)
}

/** „Запази избора“ от modal-а — записва двете категории независимо, точно както са отметнати. */
export function saveConsentChoice(analytics: boolean, marketing: boolean): ConsentState {
  return saveConsent(analytics, marketing)
}

/** Абонамент за промени в consent състоянието. Връща unsubscribe функция. */
export function subscribeToConsentChanges(listener: ConsentListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Test-only: препрочита localStorage в in-memory кеша, симулирайки повторно
 * зареждане на страницата без нужда от нова module instance. Никога не се
 * вика от production кода.
 */
export function __resetConsentStateForTests(): void {
  cachedConsent = parseStoredConsent(readRawConsent())
}
