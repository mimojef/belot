import { registerSW } from 'virtual:pwa-register'

export type PwaUpdateCallback = () => void

let pendingUpdate: PwaUpdateCallback | null = null
let onUpdateAvailableCallback: ((applyFn: PwaUpdateCallback) => void) | null = null

export function initPwa(onUpdateAvailable: (applyFn: PwaUpdateCallback) => void): void {
  onUpdateAvailableCallback = onUpdateAvailable

  registerSW({
    onNeedRefresh() {
      const updateSW = registerSW({ immediate: false })
      pendingUpdate = () => updateSW(true)
      onUpdateAvailableCallback?.(pendingUpdate)
    },
    onOfflineReady() {
      // service worker кеширал всичко — не показваме нищо
    },
  })
}

export function hasPendingUpdate(): boolean {
  return pendingUpdate !== null
}

export function applyPendingUpdate(): void {
  pendingUpdate?.()
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
