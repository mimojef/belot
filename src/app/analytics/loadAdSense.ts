// Централен, consent-gated Google AdSense loader. Единственото място в
// приложението, което инжектира adsbygoogle.js — index.html вече не го
// зарежда статично (виж CLAUDE/GDPR consent задачата).

import { hasMarketingConsent } from '../consent/consentState'

const ADSENSE_PUBLISHER_ID = 'ca-pub-4005564019331779'
const ADSENSE_SCRIPT_SRC = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ADSENSE_PUBLISHER_ID}`
const ADSENSE_SCRIPT_ATTRIBUTE = 'data-pika-adsense-loader'

let injected = false

function isScriptAlreadyPresent(): boolean {
  return document.querySelector(`script[${ADSENSE_SCRIPT_ATTRIBUTE}="1"]`) !== null
}

/**
 * Инжектира AdSense script-а, само ако е налице marketing consent. Идемпотентна
 * — безопасна за повторни извиквания (при consent промени, PWA reload и т.н.).
 * Ad blocker или мрежова грешка не трябва да чупят приложението — грешката се
 * поглъща тихо, без технически съобщения към потребителя.
 */
export function enableAdSenseIfConsented(): void {
  if (!hasMarketingConsent()) return
  if (injected || isScriptAlreadyPresent()) return

  try {
    const script = document.createElement('script')
    script.async = true
    script.src = ADSENSE_SCRIPT_SRC
    script.crossOrigin = 'anonymous'
    script.setAttribute(ADSENSE_SCRIPT_ATTRIBUTE, '1')
    script.onerror = () => {
      // Ad blocker или мрежова грешка — не е критично за приложението.
    }
    document.head.appendChild(script)
    injected = true
  } catch {
    // Инжектирането на script елемент не трябва никога да чупи приложението.
  }
}

/** Test-only: нулира idempotency флага. Никога не се вика от production кода. */
export function __resetAdSenseLoaderForTests(): void {
  injected = false
}
