/**
 * Централен координатор за тихо автоматично прилагане на PWA update-и.
 *
 * updateSW(true) (от virtual:pwa-register) изпраща SKIP_WAITING и resolve-ва
 * веднага след това — НЕ изчаква controllerchange/reload. Реалният reload
 * идва от отделен, вече закачен `controlling` listener вътре в vite-plugin-pwa
 * (виж node_modules/vite-plugin-pwa/dist/client/build/register.js). Затова
 * не можем да третираме resolve-натия updateSW(true) promise като "update
 * завършен" — само watchdog timeout (страницата все още жива след разумен
 * срок) казва надеждно, че reload не е настъпил и трябва да позволим retry.
 */

export type PwaUpdateSafetyState = {
  bootstrapComplete: boolean
  hasActiveRoom: boolean
  isSearching: boolean
  hasPrivateRoomInvite: boolean
  hasQueuedPrivateRoomInvites: boolean
  isInPrivateRoomsScreen: boolean
  isConnected: boolean
  isReconnecting: boolean
}

export type PwaApplyFn = () => void | Promise<void>

const WATCHDOG_MS = 12_000
const RETRY_COOLDOWN_MS = 30_000
const GUARD_KEY_PREFIX = 'pwa-auto-update-attempt:'

let pendingApplyFn: PwaApplyFn | null = null
let updateApplyInProgress = false
let lastFailedAttemptAt: number | null = null
let watchdogTimerId: ReturnType<typeof setTimeout> | null = null

export function hasPendingPwaUpdate(): boolean {
  return pendingApplyFn !== null
}

export function setPendingPwaUpdate(applyFn: PwaApplyFn): void {
  pendingApplyFn = applyFn
}

function isSafeToApply(state: PwaUpdateSafetyState): boolean {
  if (!state.bootstrapComplete) return false
  if (state.hasActiveRoom) return false
  if (state.isSearching) return false
  if (state.hasPrivateRoomInvite) return false
  if (state.hasQueuedPrivateRoomInvites) return false
  if (state.isInPrivateRoomsScreen) return false
  if (!state.isConnected) return false
  if (state.isReconnecting) return false
  return true
}

function withinRetryCooldown(now: number): boolean {
  return lastFailedAttemptAt !== null && now - lastFailedAttemptAt < RETRY_COOLDOWN_MS
}

function clearWatchdog(): void {
  if (watchdogTimerId !== null) {
    clearTimeout(watchdogTimerId)
    watchdogTimerId = null
  }
}

/**
 * Единствената точка, която реално прилага pending update-а. Всички event
 * handlers викат само нея — никой не прилага update директно.
 */
export async function tryApplyPendingPwaUpdate(
  getSafetyState: () => PwaUpdateSafetyState,
  buildId: string,
): Promise<void> {
  if (pendingApplyFn === null) return
  if (updateApplyInProgress) return

  const now = Date.now()
  if (withinRetryCooldown(now)) return

  const guardKey = `${GUARD_KEY_PREFIX}${buildId}`
  const existingAttempt = readGuardAttemptTimestamp(guardKey)
  if (existingAttempt !== null && now - existingAttempt < WATCHDOG_MS) {
    // Опит вече в ход за този build (напр. паралелно събитие) — не дублирай.
    return
  }

  if (!isSafeToApply(getSafetyState())) return

  const applyFn = pendingApplyFn
  updateApplyInProgress = true
  writeGuardAttemptTimestamp(guardKey, now)

  clearWatchdog()
  watchdogTimerId = setTimeout(() => {
    // Страницата е все още жива WATCHDOG_MS след опита → reload не е
    // настъпил (controllerchange никога не дойде, или е бил отхвърлен
    // някъде по веригата). Позволи контролиран бъдещ retry.
    watchdogTimerId = null
    updateApplyInProgress = false
    lastFailedAttemptAt = Date.now()
    clearGuardAttempt(guardKey)
    console.warn('[pwa] update apply watchdog timed out — no reload observed, will retry later')
  }, WATCHDOG_MS)

  try {
    // Само изпраща SKIP_WAITING; НЕ чака controllerchange/reload.
    // Не викаме location.reload() тук — vite-plugin-pwa вече го прави
    // чрез своя вграден `controlling` listener след истинския controllerchange.
    await Promise.resolve(applyFn())
    // Ако страницата все още работи, watchdog-ът по-горе ще прихване
    // липсващ reload. Ако reload наистина настъпи, целият JS контекст
    // (включително този timer) изчезва заедно със старата страница —
    // няма нужда от explicit success/"done" маркиране.
  } catch (error) {
    clearWatchdog()
    updateApplyInProgress = false
    lastFailedAttemptAt = Date.now()
    clearGuardAttempt(guardKey)
    console.warn('[pwa] update apply failed, will retry later', error)
  }
}

function readGuardAttemptTimestamp(guardKey: string): number | null {
  try {
    const raw = sessionStorage.getItem(guardKey)
    if (raw === null) return null
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : null
  } catch {
    return null
  }
}

function writeGuardAttemptTimestamp(guardKey: string, timestamp: number): void {
  try {
    sessionStorage.setItem(guardKey, String(timestamp))
  } catch { /* sessionStorage unavailable — guard degrades to in-memory only */ }
}

function clearGuardAttempt(guardKey: string): void {
  try {
    sessionStorage.removeItem(guardKey)
  } catch { /* ignore */ }
}

// Изложено само за тестове — рестартира вътрешния module state между сценарии.
export function __resetPwaUpdateCoordinatorForTests(): void {
  pendingApplyFn = null
  updateApplyInProgress = false
  lastFailedAttemptAt = null
  clearWatchdog()
}

// Изложено само за тестове — позволява детерминистична симулация "cooldown-ът
// вече е изтекъл", без реални setTimeout изчаквания в теста.
export function __setLastFailedAttemptAtForTests(timestamp: number | null): void {
  lastFailedAttemptAt = timestamp
}

export const __RETRY_COOLDOWN_MS_FOR_TESTS = RETRY_COOLDOWN_MS
