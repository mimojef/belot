// Централен Meta Pixel wrapper. Единственото място в приложението, което
// докосва window.fbq — никой друг модул не трябва да вика fbq директно.
//
// Pixel ID идва от VITE_META_PIXEL_ID (Vite env variable, виж .env.example).
// Липсващ ID → приложението работи нормално, без мрежова заявка към Meta и
// без fbq инициализация.

import { hasMarketingConsent } from '../consent/consentState'

type FbqFunction = {
  (...args: unknown[]): void
  callMethod?: (...args: unknown[]) => void
  queue: unknown[][]
  loaded: boolean
  version: string
}

declare global {
  interface Window {
    fbq?: FbqFunction
    _fbq?: FbqFunction
  }
}

const FBEVENTS_SCRIPT_SRC = 'https://connect.facebook.net/en_US/fbevents.js'
const FBEVENTS_SCRIPT_ATTRIBUTE = 'data-pika-meta-pixel-loader'

let pixelInitialized = false
let pageViewSent = false
let completeRegistrationSent = false
// Test-only override — undefined означава "чети реалния import.meta.env"
// (production поведение, непроменено). Виж __setMetaPixelIdOverrideForTests.
let pixelIdOverrideForTests: string | null | undefined

function getConfiguredPixelId(): string | null {
  if (pixelIdOverrideForTests !== undefined) return pixelIdOverrideForTests

  try {
    // import.meta.env съществува само под Vite (dev server/build). Извън
    // Vite (напр. tsx test runner) достъпът може да хвърли — тогава Pixel-ът
    // просто остава изключен, без runtime грешка в приложението.
    const pixelId = import.meta.env.VITE_META_PIXEL_ID
    return typeof pixelId === 'string' && pixelId.trim().length > 0 ? pixelId.trim() : null
  } catch {
    return null
  }
}

function ensureFbqStub(): FbqFunction {
  if (window.fbq) return window.fbq

  const stub = function fbqStub(...args: unknown[]): void {
    if (stub.callMethod) {
      stub.callMethod(...args)
    } else {
      stub.queue.push(args)
    }
  } as FbqFunction
  stub.queue = []
  stub.loaded = false
  stub.version = '2.0'

  window.fbq = stub
  window._fbq = stub
  return stub
}

function injectFbEventsScript(): void {
  if (document.querySelector(`script[${FBEVENTS_SCRIPT_ATTRIBUTE}="1"]`)) return

  try {
    const script = document.createElement('script')
    script.async = true
    script.src = FBEVENTS_SCRIPT_SRC
    script.setAttribute(FBEVENTS_SCRIPT_ATTRIBUTE, '1')
    script.onerror = () => {
      // Ad blocker или мрежова грешка — не е критично за приложението.
    }
    document.head.appendChild(script)
  } catch {
    // Инжектирането на script елемент не трябва никога да чупи приложението.
  }
}

function sendPageViewOnce(): void {
  if (pageViewSent) return
  if (!hasMarketingConsent() || !pixelInitialized || !window.fbq) return
  window.fbq('track', 'PageView')
  pageViewSent = true
}

/**
 * Инициализира Meta Pixel, само ако едновременно: consent-ът е валиден,
 * marketing === true, и VITE_META_PIXEL_ID е конфигуриран. Идемпотентна —
 * не дублира script, fbq queue, autoConfig, init или PageView. Ако
 * потребителят приеме marketing по-късно в същата сесия, извикването отново
 * тук зарежда Pixel и изпраща PageView (само ако още не е изпратен в
 * текущото app зареждане). analytics:true САМО (без marketing:true) НЕ
 * зарежда Pixel-а.
 *
 * fbq('set','autoConfig',false,pixelId) се вика точно преди fbq('init', ...),
 * за да изключи Meta-то автоматично улавяне на "automatic events" (напр.
 * SubscribedButtonClick), които не са explicit добавени тук.
 */
export function initMetaPixelIfConsented(): void {
  if (pixelInitialized) return
  if (!hasMarketingConsent()) return

  const pixelId = getConfiguredPixelId()
  if (pixelId === null) return

  const fbq = ensureFbqStub()
  injectFbEventsScript()
  // Изключва Meta-то "automatic events" (напр. SubscribedButtonClick) —
  // трябва да е точно преди init, докато Pixel Helper/Events Manager все
  // още не е видял init повикването за този pixelId.
  fbq('set', 'autoConfig', false, pixelId)
  fbq('init', pixelId)
  pixelInitialized = true

  sendPageViewOnce()
}

/**
 * Стандартното Meta събитие CompleteRegistration — извиква се само от
 * register success пътя в src/main.ts, никога от login/session-restore.
 * Idempotency guard: максимум едно изпращане за целия lifetime на модула
 * (== едно app зареждане). Зависи ИЗКЛЮЧИТЕЛНО от marketing consent (не от
 * analytics) — ако marketing е false в момента на извикването, събитието се
 * пропуска мълчаливо и НЕ се изпраща по-късно ретроактивно (няма опашка/retry
 * механизъм в модула).
 */
export function trackCompleteRegistration(eventId: string): void {
  if (completeRegistrationSent) return
  if (!hasMarketingConsent() || !pixelInitialized || !window.fbq) return

  window.fbq('track', 'CompleteRegistration', {}, { eventID: eventId })
  completeRegistrationSent = true
}

/** Test-only: override за Pixel ID (bypasses import.meta.env). Никога не се вика от production кода. */
export function __setMetaPixelIdOverrideForTests(id: string | null | undefined): void {
  pixelIdOverrideForTests = id
}

/** Test-only: нулира всички idempotency флагове. Никога не се вика от production кода. */
export function __resetMetaPixelForTests(): void {
  pixelInitialized = false
  pageViewSent = false
  completeRegistrationSent = false
  pixelIdOverrideForTests = undefined
}
