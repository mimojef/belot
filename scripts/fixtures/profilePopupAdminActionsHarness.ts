// Real createLobbyFlowController() (not a mock), loaded through the Vite dev
// server — see checkProfilePopupAdminActions.ts. Regression for admin-only
// profile popup actions (Направи субадмин / чат админ / TOP чат админ / Pika
// team) being missing on the FIRST open after a fresh page load, only
// appearing once some unrelated render happened (or the admin clicked
// "Дай VIP", which called renderPopupOnly() directly and incidentally
// "caught up" the already-updated-but-never-DOM-synced target role).
//
// ROOT CAUSE: ensureProfilePopupTargetRoleLoaded() (createLobbyFlowController.ts)
// asynchronously fetches the target profile's account role via
// onAdminGetTargetRole, then called the generic render() when the result
// arrived. Profile popup markup lives on document.body (outside
// root.innerHTML, via syncProfilePopup/renderPopupOnly) — the generic
// render() -> renderLobbyScreen() has a skip-if-unchanged guard on
// root.innerHTML, and profilePopupTargetRole never affects that string, so
// the guard's early return meant syncProfilePopup() (also called only from
// inside renderLobbyScreen(), after the guard) was never reached with the
// freshly loaded role — admin action buttons gated on targetAccountRole
// (renderSubadminRoleControls et al. explicitly hide when role === null)
// stayed hidden until some OTHER render happened to produce different HTML.
//
// FIX: the async role-load callback now calls renderPopupOnly() directly
// (same document.body-targeted sync path already used elsewhere for the
// profile popup), bypassing the root.innerHTML guard entirely.
import { createLobbyFlowController } from '/src/app/lobby/createLobbyFlowController.ts'
import type { PlayerPublicProfileSnapshot } from '/src/app/network/createGameServerClient.ts'

const root = document.createElement('div')
document.body.appendChild(root)

const TARGET_PROFILE_ID = 'target-1'
const SECOND_TARGET_PROFILE_ID = 'target-2'

function makePlayer(profileId: string, displayName: string): PlayerPublicProfileSnapshot {
  return {
    profileId,
    displayName,
    avatarUrl: null,
    likesCount: 0,
  } as any
}

// Resolved lazily by each test step so the harness can simulate "the role
// fetch is still in flight" vs. "it has resolved" without a real network delay.
let targetRoleResolvers: Record<string, (value: { ok: true; role: 'player' | 'subadmin' | 'chat_admin' | 'top_chat_admin' | 'pika_team' | 'admin' | null }) => void> = {}
let roleCallCountByProfileId: Record<string, number> = {}

const controller = createLobbyFlowController({
  root,
  joinMatchmaking: () => {},
  leaveMatchmaking: () => {},
  onMatchFound: () => {},
  getAuthSession: () => ({
    account: { role: 'admin' },
    profile: { profileId: 'admin-me', displayName: 'Admin' } as any,
  }),
  onPlayersLoad: async (page) => ({
    ok: true,
    players: [makePlayer(TARGET_PROFILE_ID, 'Target One'), makePlayer(SECOND_TARGET_PROFILE_ID, 'Target Two')],
    page,
    pageSize: 20,
    totalCount: 2,
    totalPages: 1,
    snapshot: 'snap-1',
    snapshotReset: false,
  }),
  onProfileByIdLoad: async (profileId) => ({
    ok: true,
    profile: makePlayer(profileId, profileId === TARGET_PROFILE_ID ? 'Target One' : 'Target Two'),
  }),
  onAdminGetTargetRole: (profileId) => {
    roleCallCountByProfileId[profileId] = (roleCallCountByProfileId[profileId] ?? 0) + 1
    return new Promise((resolve) => {
      targetRoleResolvers[profileId] = resolve
    })
  },
})

controller.render()

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

function clickNavPlayers(): void {
  (root.querySelector('[data-lobby-nav-players="1"]') as HTMLElement | null)?.click()
}

function clickPlayerCard(profileId: string): void {
  (root.querySelector(`[data-lobby-player-card="${profileId}"]`) as HTMLElement | null)?.click()
}

function getPopupRoot(): HTMLElement | null {
  return document.querySelector('[data-player-profile-popup-root="1"]')
    ?? document.querySelector('[data-player-profile-vip-grant-open="1"]')?.closest('div') as HTMLElement | null
}

function hasMarker(selector: string): boolean {
  return document.querySelector(selector) !== null
}

;(window as any).__profilePopupAdminActionsHarness = {
  openPlayersDirectoryAndFlush: async (): Promise<void> => {
    clickNavPlayers()
    await flush()
  },
  openTargetProfileAndFlush: async (profileId: string = TARGET_PROFILE_ID): Promise<void> => {
    clickPlayerCard(profileId)
    await flush()
  },
  resolvePendingRoleFetch: async (
    profileId: string,
    role: 'player' | 'subadmin' | 'chat_admin' | 'top_chat_admin' | 'pika_team' | 'admin' | null,
  ): Promise<void> => {
    const resolver = targetRoleResolvers[profileId]
    if (!resolver) throw new Error(`no pending role fetch for ${profileId}`)
    delete targetRoleResolvers[profileId]
    resolver({ ok: true, role })
    await flush()
  },
  hasPendingRoleFetch: (profileId: string): boolean => targetRoleResolvers[profileId] !== undefined,
  getRoleFetchCallCount: (profileId: string): number => roleCallCountByProfileId[profileId] ?? 0,
  isPopupOpen: (): boolean => hasMarker('[data-player-profile-vip-grant-open="1"]'),
  hasVipAction: (): boolean => hasMarker('[data-player-profile-vip-grant-open="1"]'),
  hasGrantSubadminAction: (): boolean => hasMarker('[data-player-profile-grant-subadmin="1"]'),
  hasGrantChatAdminAction: (): boolean => hasMarker('[data-player-profile-grant-chat-admin="1"]'),
  hasGrantTopChatAdminAction: (): boolean => hasMarker('[data-player-profile-grant-top-chat-admin="1"]'),
  hasGrantPikaTeamAction: (): boolean => hasMarker('[data-player-profile-grant-pika-team="1"]'),
  clickVipGrantOpenAndFlush: async (): Promise<void> => {
    (document.querySelector('[data-player-profile-vip-grant-open="1"]') as HTMLElement | null)?.click()
    await flush()
  },
  closePopupAndFlush: async (): Promise<void> => {
    (document.querySelector('[data-player-profile-popup-close="1"]') as HTMLElement | null)?.click()
    await flush()
  },
}
