// Real createLobbyFlowController() (not a mock), loaded through the Vite dev
// server — see checkOwnVipStatusAsyncPopupSync.ts. Regression for the own
// profile VIP popup NOT updating immediately once /api/vip/status resolves
// (asynchronously, after the popup was opened): the fix at
// ensureOwnVipStatusLoaded()'s success callback replaced generic render()
// with renderPopupOnly(), mirroring commit 899e1af's identical fix for
// profilePopupTargetRole. This harness controls onGetOwnVipStatus()'s
// resolution timing explicitly (a manually-resolved promise queue) so the
// test driver can assert the popup DOM updates the INSTANT the promise
// resolves, with zero unrelated render in between.
import { createLobbyFlowController } from '/src/app/lobby/createLobbyFlowController.ts'

const root = document.createElement('div')
document.body.appendChild(root)

type VipStatusResult = { ok: true; activeUntil: string | null } | { ok: false }

// FIFO queue of pending onGetOwnVipStatus() resolvers — a real fetch race
// can have MORE THAN ONE in flight at once (e.g. the stale pre-switch
// fetch and the fresh post-switch fetch both pending simultaneously, see
// scenario F) — a single shared resolver variable would silently drop the
// older one.
const pendingVipResolvers: Array<(result: VipStatusResult) => void> = []

let currentAuthSession: any = {
  account: { role: 'player' },
  profile: { profileId: 'me', displayName: 'Me', likesCount: 0 },
}

const controller = createLobbyFlowController({
  root,
  joinMatchmaking: () => {},
  leaveMatchmaking: () => {},
  onMatchFound: () => {},
  getAuthSession: () => currentAuthSession,
  onGetOwnVipStatus: () =>
    new Promise<VipStatusResult>((resolve) => {
      pendingVipResolvers.push(resolve)
    }),
})

controller.render()

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

function isPopupOpen(): boolean {
  return document.querySelector('[data-player-profile-popup-root="1"]') !== null
}

function getOwnVipRowEl(): HTMLElement | null {
  return document.querySelector('[data-player-profile-own-vip-days="1"]')
}

function getVipDaysText(): string | null {
  const row = getOwnVipRowEl()
  if (row === null) return null
  const spans = row.querySelectorAll('span')
  const valueSpan = spans[1] ?? null
  return valueSpan?.textContent ?? null
}

function getVipLoadingMarker(): string | null {
  return getOwnVipRowEl()?.getAttribute('data-vip-status-loading') ?? null
}

;(window as any).__lobbyOwnVipStatusAsyncSyncHarness = {
  isPopupOpen: (): boolean => isPopupOpen(),
  getVipDaysText: (): string | null => getVipDaysText(),
  getVipLoadingMarker: (): string | null => getVipLoadingMarker(),
  isOwnSummaryPresent: (): boolean => document.querySelector('[data-player-profile-own-summary="1"]') !== null,
  isForeignVipRowPresent: (): boolean => document.querySelector('[data-player-profile-foreign-vip-days="1"]') !== null,
  pendingVipStatusCount: (): number => pendingVipResolvers.length,

  openOwnProfileAndFlush: async (): Promise<void> => {
    const buttons = root.querySelectorAll<HTMLElement>('[data-lobby-profile-button="1"]')
    ;(buttons[0] ?? null)?.click()
    await flush()
  },
  closePopupAndFlush: async (): Promise<void> => {
    (document.querySelector('[data-player-profile-popup-close="1"]') as HTMLElement | null)?.click()
    await flush()
  },
  // Resolves the OLDEST still-pending onGetOwnVipStatus() call — matches
  // real fetch ordering (first call started = first call to resolve in
  // these test scenarios). Returns false (no-op) if none is pending, so
  // the test driver can assert "nothing to resolve" explicitly.
  resolveOldestVipStatus: async (activeUntil: string | null): Promise<boolean> => {
    const resolve = pendingVipResolvers.shift()
    if (resolve === undefined) return false
    resolve({ ok: true, activeUntil })
    await flush()
    return true
  },
  // Simulates the real logout->login lifecycle boundary (main.ts calls
  // lobby.resetToLobby() from both paths, see resetToLobby()'s own
  // comment) — swaps the mocked auth session to a different profile and
  // runs the exact same reset the production controller runs.
  switchAccountAndReset: async (newProfileId: string): Promise<void> => {
    currentAuthSession = {
      account: { role: 'player' },
      profile: { profileId: newProfileId, displayName: newProfileId, likesCount: 0 },
    }
    controller.resetToLobby()
    await flush()
  },
}
