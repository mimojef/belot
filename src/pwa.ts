import { registerSW } from 'virtual:pwa-register'
import { CURRENT_BUILD_ID } from './buildId'

export { CURRENT_BUILD_ID }

export type PwaUpdateCallback = () => void | Promise<void>

let swRegistration: ServiceWorkerRegistration | null = null
let lastRegistrationUpdateCheckAt = 0

const REGISTRATION_UPDATE_CHECK_THROTTLE_MS = 45_000

export function initPwa(onUpdateAvailable: (applyFn: PwaUpdateCallback) => void): void {
  const updateSW = registerSW({
    onRegisteredSW(_swScriptUrl, registration) {
      swRegistration = registration ?? null
    },
    onNeedRefresh() {
      onUpdateAvailable(async () => {
        await clearRuntimeNavigationCache()
        // await-ваме, за да могат евентуални rejection-и да стигнат до
        // coordinator-a try/catch, вместо да станат unhandled rejection.
        // updateSW(true) само изпраща SKIP_WAITING и НЕ чака
        // controllerchange/reload — виж pwaUpdateCoordinator.ts за пълния
        // watchdog/retry lifecycle.
        await updateSW(true)
      })
    },
    onOfflineReady() {
      // service worker кеширал всичко — не показваме нищо
    },
  })
}

async function clearRuntimeNavigationCache(): Promise<void> {
  if (!('caches' in window)) {
    return
  }

  await caches.delete('navigation-cache')
}

/**
 * Explicit проверка за нова версия (визуален update check, без apply/reload).
 * Throttled — многократни бързи извиквания (напр. visibilitychange +
 * pageshow в бърза последователност) не пращат повече от една мрежова
 * заявка на REGISTRATION_UPDATE_CHECK_THROTTLE_MS.
 */
export function requestPwaUpdateCheck(): void {
  if (swRegistration === null) return

  const now = Date.now()
  if (now - lastRegistrationUpdateCheckAt < REGISTRATION_UPDATE_CHECK_THROTTLE_MS) return
  lastRegistrationUpdateCheckAt = now

  swRegistration.update().catch((error: unknown) => {
    console.warn('[pwa] registration.update() failed', error)
  })
}

export function isRunningAsStandalone(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches
    || ('standalone' in window.navigator && (window.navigator as { standalone?: boolean }).standalone === true)
}

let deferredInstallPrompt: Event | null = null

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault()
  deferredInstallPrompt = e
})

export function canInstallPwa(): boolean {
  return deferredInstallPrompt !== null
}

export async function triggerPwaInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  if (!deferredInstallPrompt) return 'unavailable'

  const prompt = deferredInstallPrompt as Event & {
    prompt: () => Promise<void>
    userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
  }

  deferredInstallPrompt = null
  await prompt.prompt()
  const { outcome } = await prompt.userChoice
  return outcome
}
