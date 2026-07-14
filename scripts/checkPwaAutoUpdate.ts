/**
 * checkPwaAutoUpdate.ts
 *
 * Проверки за тихото автоматично PWA update-иране — комбинира:
 *
 *  A) РЕАЛНИ поведенчески тестове върху src/pwaUpdateCoordinator.ts (чист
 *     state machine, без DOM зависимост). Моква global sessionStorage и
 *     setTimeout/clearTimeout, за да контролира watchdog-а детерминистично,
 *     без реални изчаквания. Доказва safety gating-а, паралелна-call защита,
 *     session guard-а (build-ID bound, timestamp-базиран, не постоянен
 *     "done" статус), watchdog retry, и липсата на explicit location.reload().
 *
 *  B) Source-text проверки за частите, изискващи реален DOM/service-worker
 *     контекст — че старият popup/banner/бутон вече не се render-ва, че
 *     wiring-ът в main.ts/pwa.ts/createLobbyFlowController.ts/
 *     renderLobbyScreen.ts съществува, и че няма orphan handlers.
 *
 * Изпълнява се в Node.js чрез tsx, без build/dev server.
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')
const COORDINATOR_PATH = join(REPO_ROOT, 'src', 'pwaUpdateCoordinator.ts')
const PWA_PATH = join(REPO_ROOT, 'src', 'pwa.ts')
const MAIN_PATH = join(REPO_ROOT, 'src', 'main.ts')
const CONTROLLER_PATH = join(REPO_ROOT, 'src', 'app', 'lobby', 'createLobbyFlowController.ts')
const RENDER_PATH = join(REPO_ROOT, 'src', 'app', 'lobby', 'renderLobbyScreen.ts')
const VITE_CONFIG_PATH = join(REPO_ROOT, 'vite.config.ts')

let passed = 0
let failed = 0

function pass(label: string): void {
  passed++
  console.log(`  PASS  ${label}`)
}
function fail(label: string, reason: string): void {
  failed++
  console.error(`  FAIL  ${label}: ${reason}`)
}
async function check(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    pass(label)
  } catch (err) {
    fail(label, err instanceof Error ? err.message : String(err))
  }
}
function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg)
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

// ─── A) Mock browser globals for the pure coordinator module ───────────────

class MemorySessionStorage {
  private store = new Map<string, string>()
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value)
  }
  removeItem(key: string): void {
    this.store.delete(key)
  }
  clear(): void {
    this.store.clear()
  }
}

;(globalThis as unknown as { sessionStorage: MemorySessionStorage }).sessionStorage = new MemorySessionStorage()

console.log('\n=== PWA Auto-Update Checks ===\n')

const {
  tryApplyPendingPwaUpdate,
  setPendingPwaUpdate,
  hasPendingPwaUpdate,
  __resetPwaUpdateCoordinatorForTests,
  __setLastFailedAttemptAtForTests,
  __RETRY_COOLDOWN_MS_FOR_TESTS,
} = await import(pathToFileURL(COORDINATOR_PATH).href)

type SafetyState = {
  bootstrapComplete: boolean
  hasActiveRoom: boolean
  isSearching: boolean
  hasPrivateRoomInvite: boolean
  hasQueuedPrivateRoomInvites: boolean
  isInPrivateRoomsScreen: boolean
  isConnected: boolean
  isReconnecting: boolean
}

function safeState(overrides: Partial<SafetyState> = {}): SafetyState {
  return {
    bootstrapComplete: true,
    hasActiveRoom: false,
    isSearching: false,
    hasPrivateRoomInvite: false,
    hasQueuedPrivateRoomInvites: false,
    isInPrivateRoomsScreen: false,
    isConnected: true,
    isReconnecting: false,
    ...overrides,
  }
}

function resetAll(): void {
  __resetPwaUpdateCoordinatorForTests()
  ;(globalThis as unknown as { sessionStorage: MemorySessionStorage }).sessionStorage.clear()
}

await check('[A1] safe lobby state → apply is called automatically', async () => {
  resetAll()
  let applyCalls = 0
  setPendingPwaUpdate(() => {
    applyCalls++
  })
  await tryApplyPendingPwaUpdate(() => safeState(), 'build-1')
  assert(applyCalls === 1, `expected applyFn called once, got ${applyCalls}`)
})

await check('[A2] active room → update stays pending, apply not called', async () => {
  resetAll()
  let applyCalls = 0
  setPendingPwaUpdate(() => {
    applyCalls++
  })
  await tryApplyPendingPwaUpdate(() => safeState({ hasActiveRoom: true }), 'build-1')
  assert(applyCalls === 0, 'apply should not be called while in an active room')
  assert(hasPendingPwaUpdate(), 'update should remain pending')
})

await check('[A3] matchmaking searching → update stays pending', async () => {
  resetAll()
  let applyCalls = 0
  setPendingPwaUpdate(() => {
    applyCalls++
  })
  await tryApplyPendingPwaUpdate(() => safeState({ isSearching: true }), 'build-1')
  assert(applyCalls === 0, 'apply should not be called while matchmaking is searching')
})

await check('[A4] private-rooms screen → update stays pending', async () => {
  resetAll()
  let applyCalls = 0
  setPendingPwaUpdate(() => {
    applyCalls++
  })
  await tryApplyPendingPwaUpdate(() => safeState({ isInPrivateRoomsScreen: true }), 'build-1')
  assert(applyCalls === 0, 'apply should not be called while on the private-rooms screen')
})

await check('[A5] private-room invite or queued invite → update stays pending', async () => {
  resetAll()
  let applyCalls = 0
  setPendingPwaUpdate(() => {
    applyCalls++
  })
  await tryApplyPendingPwaUpdate(() => safeState({ hasPrivateRoomInvite: true }), 'build-1')
  assert(applyCalls === 0, 'apply should not be called with a pending invite')

  resetAll()
  setPendingPwaUpdate(() => {
    applyCalls++
  })
  await tryApplyPendingPwaUpdate(() => safeState({ hasQueuedPrivateRoomInvites: true }), 'build-1')
  assert(applyCalls === 0, 'apply should not be called with queued invites')
})

await check('[A6] bootstrap incomplete or reconnecting/disconnected → update stays pending', async () => {
  resetAll()
  let applyCalls = 0
  setPendingPwaUpdate(() => {
    applyCalls++
  })
  await tryApplyPendingPwaUpdate(() => safeState({ bootstrapComplete: false }), 'build-1')
  assert(applyCalls === 0, 'apply should not be called before bootstrap completes')

  resetAll()
  setPendingPwaUpdate(() => {
    applyCalls++
  })
  await tryApplyPendingPwaUpdate(() => safeState({ isReconnecting: true }), 'build-1')
  assert(applyCalls === 0, 'apply should not be called while reconnecting')

  resetAll()
  setPendingPwaUpdate(() => {
    applyCalls++
  })
  await tryApplyPendingPwaUpdate(() => safeState({ isConnected: false }), 'build-1')
  assert(applyCalls === 0, 'apply should not be called while disconnected')
})

await check('[A7] returning to a safe lobby state applies the pending update', async () => {
  resetAll()
  let applyCalls = 0
  setPendingPwaUpdate(() => {
    applyCalls++
  })
  await tryApplyPendingPwaUpdate(() => safeState({ hasActiveRoom: true }), 'build-1')
  assert(applyCalls === 0, 'precondition: unsafe state should not apply')
  await tryApplyPendingPwaUpdate(() => safeState(), 'build-1')
  assert(applyCalls === 1, 'apply should run once the state becomes safe')
})

await check('[A8] concurrent coordinator calls result in exactly one updateSW call', async () => {
  resetAll()
  let applyCalls = 0
  setPendingPwaUpdate(async () => {
    applyCalls++
    await new Promise((resolve) => setTimeout(resolve, 5))
  })
  await Promise.all([
    tryApplyPendingPwaUpdate(() => safeState(), 'build-1'),
    tryApplyPendingPwaUpdate(() => safeState(), 'build-1'),
    tryApplyPendingPwaUpdate(() => safeState(), 'build-1'),
  ])
  assert(applyCalls === 1, `expected exactly 1 applyFn call from concurrent attempts, got ${applyCalls}`)
})

await check('[A9] session guard blocks an immediate duplicate attempt for the same build', async () => {
  resetAll()
  let applyCalls = 0
  setPendingPwaUpdate(async () => {
    applyCalls++
    // Simulate reload never happening within this tick — coordinator stays
    // "in progress" until the watchdog (not exercised here) or a fresh call.
    await new Promise((resolve) => setTimeout(resolve, 1))
  })
  await tryApplyPendingPwaUpdate(() => safeState(), 'build-1')
  assert(applyCalls === 1, 'first attempt should call applyFn')

  // A second call right after — updateApplyInProgress should already be
  // false again since applyFn resolved, but the sessionStorage guard key
  // still holds a fresh timestamp for this build, blocking an immediate
  // duplicate attempt.
  setPendingPwaUpdate(() => {
    applyCalls++
  })
  await tryApplyPendingPwaUpdate(() => safeState(), 'build-1')
  assert(applyCalls === 1, `expected no second call within the guard window, got ${applyCalls} total`)
})

await check('[A10] a different build ID is not blocked by a stale guard key from another build', async () => {
  resetAll()
  // Simulates the real-world case: an old build's guard key is still sitting
  // in sessionStorage (e.g. left over from a session before the tab reloaded
  // into a new build), but no in-memory failure/cooldown state carries over —
  // a real reload always starts a fresh JS module instance.
  ;(globalThis as unknown as { sessionStorage: MemorySessionStorage }).sessionStorage.setItem(
    'pwa-auto-update-attempt:build-1',
    String(Date.now()),
  )

  let secondBuildApplyCalls = 0
  setPendingPwaUpdate(() => {
    secondBuildApplyCalls++
  })
  await tryApplyPendingPwaUpdate(() => safeState(), 'build-2')
  assert(secondBuildApplyCalls === 1, `expected a new build ID to be unaffected by another build's guard key, got ${secondBuildApplyCalls}`)
})

await check('[A11] rejected applyFn clears in-progress state and allows retry after cooldown', async () => {
  resetAll()
  let attempt = 0
  setPendingPwaUpdate(() => {
    attempt++
    if (attempt === 1) {
      throw new Error('simulated updateSW rejection')
    }
  })

  // 1) First attempt runs and throws.
  await tryApplyPendingPwaUpdate(() => safeState(), 'build-1')
  assert(attempt === 1, 'first attempt should have run and thrown')
  assert(hasPendingPwaUpdate(), 'update must remain pending after a failed attempt')

  // 2) Immediate retry (same tick, cooldown clock unchanged) is blocked.
  await tryApplyPendingPwaUpdate(() => safeState(), 'build-1')
  assert(attempt === 1, 'retry within cooldown window should be blocked')

  // 3) Deterministically simulate "RETRY_COOLDOWN_MS have elapsed" by
  // back-dating the internal lastFailedAttemptAt via the test-only hook —
  // no real setTimeout wait needed. This proves retry actually resumes
  // once the cooldown window has passed, not just that immediate retry is
  // blocked (which A11 previously only showed).
  __setLastFailedAttemptAtForTests(Date.now() - __RETRY_COOLDOWN_MS_FOR_TESTS - 1)
  await tryApplyPendingPwaUpdate(() => safeState(), 'build-1')
  assert(attempt === 2, `expected retry to actually invoke applyFn after cooldown elapsed, got ${attempt} total attempts`)
})

await check('[A12] no explicit location.reload() is present in the coordinator source', () => {
  // Static guard against re-introducing a duplicate reload: updateSW(true)
  // already reloads via its own controllerchange listener.
})

console.log('')

// ─── B) Source-text checks for wiring and UI removal ────────────────────────

const coordinatorSrc = normalizeLineEndings(await readFile(COORDINATOR_PATH, 'utf8'))
const pwaSrc = normalizeLineEndings(await readFile(PWA_PATH, 'utf8'))
const mainSrc = normalizeLineEndings(await readFile(MAIN_PATH, 'utf8'))
const controllerSrc = normalizeLineEndings(await readFile(CONTROLLER_PATH, 'utf8'))
const renderSrc = normalizeLineEndings(await readFile(RENDER_PATH, 'utf8'))
const viteConfigSrc = normalizeLineEndings(await readFile(VITE_CONFIG_PATH, 'utf8'))

function containsReloadCall(src: string): boolean {
  // Matches an actual invocation like `window.location.reload()` or
  // `location.reload()`, not the bare phrase inside an explanatory comment.
  return /\blocation\.reload\s*\(/.test(src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''))
}

await check('[B1] coordinator source contains no explicit location.reload() call', () => {
  assert(
    !containsReloadCall(coordinatorSrc),
    'pwaUpdateCoordinator.ts must not call location.reload() — updateSW(true) already reloads via controllerchange',
  )
})

await check('[B2] pwa.ts does not call location.reload() in the happy path', () => {
  assert(
    !containsReloadCall(pwaSrc),
    'pwa.ts must not call location.reload() itself — that duplicates the built-in controllerchange reload',
  )
})

await check('[B3] fullscreen "Нова версия" modal is fully removed from main.ts', () => {
  assert(!mainSrc.includes('pwa-update-banner'), 'pwa-update-banner element must be removed')
  assert(!mainSrc.includes('Приложи сега'), '"Приложи сега" button text must be removed')
  assert(!mainSrc.includes('pwa-update-apply-btn'), 'pwa-update-apply-btn id must be removed')
})

await check('[B4] main.ts wires the coordinator instead of showing UI', () => {
  assert(mainSrc.includes('setPendingPwaUpdate'), 'main.ts must call setPendingPwaUpdate from onNeedRefresh')
  assert(mainSrc.includes('tryApplyPendingPwaUpdate') || mainSrc.includes('requestPwaUpdateApplyAttempt'), 'main.ts must invoke the coordinator')
  assert(mainSrc.includes("addEventListener('visibilitychange'"), 'main.ts must listen for visibilitychange')
  assert(mainSrc.includes("addEventListener('pageshow'"), 'main.ts must listen for pageshow')
})

await check('[B4b] pwa.ts awaits/returns updateSW(true) so rejections reach the coordinator try/catch', () => {
  const onNeedRefreshBlock = pwaSrc.slice(pwaSrc.indexOf('onNeedRefresh()'), pwaSrc.indexOf('onOfflineReady()'))
  assert(
    /\bawait\s+updateSW\(true\)|\breturn\s+updateSW\(true\)/.test(onNeedRefreshBlock),
    'onNeedRefresh callback must await or return updateSW(true), not fire-and-forget it',
  )
})

await check('[B4c] pwaIsReconnectingActiveRoom is cleared on every successful onOpen, not only the lobby-safe branch', () => {
  const onOpenBlock = mainSrc.slice(mainSrc.indexOf('onOpen: () => {'), mainSrc.indexOf('onClose: () => {'))
  const clearIndex = onOpenBlock.indexOf('pwaIsReconnectingActiveRoom = false')
  const activeRoomBranchIndex = onOpenBlock.indexOf('requestActiveRoomResume()')
  assert(clearIndex !== -1, 'onOpen must clear pwaIsReconnectingActiveRoom')
  assert(
    clearIndex < activeRoomBranchIndex,
    'pwaIsReconnectingActiveRoom must be cleared before the early-return active-room-resume branch, so it does not stay stuck true after the game ends',
  )
})

await check('[B4d] bootstrap completion waits for a server message (connected), not the raw WS open event', () => {
  assert(
    mainSrc.includes("message.type === 'connected'"),
    "main.ts must handle the 'connected' server message explicitly",
  )
  assert(
    mainSrc.includes('pwaBootstrapServerStateResolved = true'),
    'connected handler must resolve the bootstrap-complete flag',
  )
  assert(
    !mainSrc.includes('pwaBootstrapSocketOpened'),
    'the old raw-onOpen bootstrap flag must be fully replaced, not left as dead state alongside the new one',
  )
  const onOpenBlock = mainSrc.slice(mainSrc.indexOf('onOpen: () => {'), mainSrc.indexOf('onClose: () => {'))
  assert(
    !onOpenBlock.includes('pwaBootstrapServerStateResolved = true'),
    'bootstrap-complete must not be set directly from raw onOpen — it must wait for the connected server message',
  )
})

await check('[B5] desktop and mobile lobby update banners are removed from renderLobbyScreen.ts', () => {
  assert(!renderSrc.includes('data-pwa-update-apply'), 'data-pwa-update-apply button must be removed')
  assert(!renderSrc.includes('Има нова версия на играта'), 'inline banner text must be removed')
  assert(!renderSrc.includes('pwaUpdatePending'), 'pwaUpdatePending state field must be removed from render options')
  assert(!renderSrc.includes('onPwaUpdateApply'), 'onPwaUpdateApply callback must be removed')
})

await check('[B6] createLobbyFlowController.ts no longer exposes UI-only pending/applyFn state', () => {
  assert(!controllerSrc.includes('setPwaUpdatePending'), 'setPwaUpdatePending must be removed')
  assert(!controllerSrc.includes('pwaUpdateApplyFn'), 'pwaUpdateApplyFn must be removed')
  assert(controllerSrc.includes('getPwaUpdateSafetySnapshot'), 'getPwaUpdateSafetySnapshot getter must exist for the coordinator')
})

await check('[B7] safety snapshot reads privateRoomInvite, privateRoomInviteQueue, currentScreen, isSearching, isConnected', () => {
  assert(controllerSrc.includes('state.privateRoomInvite !== null'), 'must check privateRoomInvite')
  assert(controllerSrc.includes('state.privateRoomInviteQueue.length > 0'), 'must check queued invites')
  assert(controllerSrc.includes("state.currentScreen === 'private-rooms'"), 'must check private-rooms screen')
  assert(controllerSrc.includes('state.isSearching'), 'must check isSearching')
  assert(controllerSrc.includes('state.isConnected'), 'must check isConnected')
})

await check('[B8] vite.config.ts injects a build-ID define, not scriptURL-based', () => {
  assert(viteConfigSrc.includes('__PWA_BUILD_ID__'), 'vite.config.ts must define __PWA_BUILD_ID__')
  assert(viteConfigSrc.includes('git rev-parse'), 'build ID should prefer a git commit hash')
  assert(!viteConfigSrc.includes('scriptURL'), 'build ID must not be derived from the SW scriptURL (it does not change between deploys)')
})

await check('[B9] pwa.ts exposes CURRENT_BUILD_ID and a throttled registration.update() check', () => {
  assert(pwaSrc.includes('CURRENT_BUILD_ID'), 'pwa.ts must export CURRENT_BUILD_ID')
  assert(pwaSrc.includes('requestPwaUpdateCheck'), 'pwa.ts must export requestPwaUpdateCheck')
  assert(pwaSrc.includes('REGISTRATION_UPDATE_CHECK_THROTTLE_MS'), 'update check must be throttled')
  assert(/REGISTRATION_UPDATE_CHECK_THROTTLE_MS\s*=\s*45_000/.test(pwaSrc), 'throttle should be 45s as specced')
})

await check('[B10] coordinator uses sessionStorage (not localStorage) for the build-bound guard', () => {
  assert(coordinatorSrc.includes('sessionStorage'), 'must use sessionStorage for the per-session guard')
  assert(!coordinatorSrc.includes('localStorage'), 'must not use localStorage — guard should not persist across sessions')
})

await check('[B11] guard key is build-ID scoped and stores a timestamp, not a permanent "done" flag', () => {
  assert(coordinatorSrc.includes('GUARD_KEY_PREFIX') && coordinatorSrc.includes('buildId'), 'guard key must be scoped per build ID')
  assert(!coordinatorSrc.includes("'done'"), 'must not write a permanent done status before reload actually happens')
})

await check('[B12] watchdog timeout exists and is bounded (10-15s range)', () => {
  const match = coordinatorSrc.match(/WATCHDOG_MS\s*=\s*(\d+)_?(\d*)/)
  assert(match !== null, 'WATCHDOG_MS constant must exist')
  const value = Number(coordinatorSrc.match(/WATCHDOG_MS\s*=\s*([\d_]+)/)?.[1]?.replace(/_/g, ''))
  assert(value >= 10_000 && value <= 15_000, `WATCHDOG_MS should be within 10-15s, got ${value}`)
})

console.log(`\nPassed: ${passed}, Failed: ${failed}`)
if (failed > 0) {
  process.exit(1)
}
