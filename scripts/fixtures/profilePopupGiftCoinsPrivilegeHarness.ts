// Real createLobbyFlowController() (not a mock), loaded through the Vite dev
// server — see checkProfilePopupGiftCoinsPrivilege.ts. Regression for the
// "Подари жълтици" (gift-coins) button in the profile popup appearing for
// NON-privileged viewers (role==='player') on an accepted-friend profile.
//
// ROOT CAUSE: the accepted-friendship giftFriendshipId overlay existed in TWO
// independent places — buildLobbyScreenState() (gated on viewer role being
// pika_team/admin, mirroring the backend isPikaTeamGiftMaxAmountSession ||
// isAdminGiftUnlimitedSession authorization in server/src/index.ts) and
// buildPopupFriendshipAction() (used by renderPopupOnly(), the actual path
// taken every time a foreign profile popup opens via openProtectedProfileById).
// The second copy had NO role gate at all — any viewer, including a plain
// 'player', saw "Подари жълтици" for any accepted friend.
//
// FIX: both call sites now share one helper,
// applyPrivilegedGiftCoinsFriendshipOverlay() (+ its
// isPrivilegedGiftCoinsSenderAuthSession() predicate), so they cannot diverge
// again.
import { createLobbyFlowController } from '/src/app/lobby/createLobbyFlowController.ts'
import type {
  PlayerPublicProfileSnapshot,
  FriendshipsSnapshot,
} from '/src/app/network/createGameServerClient.ts'

const root = document.createElement('div')
document.body.appendChild(root)

const SELF_PROFILE_ID = 'viewer-me'
const FRIEND_PROFILE_ID = 'friend-1'
const STRANGER_PROFILE_ID = 'stranger-1'

function makePlayer(profileId: string, displayName: string): PlayerPublicProfileSnapshot {
  return {
    profileId,
    displayName,
    avatarUrl: null,
    likesCount: 0,
  } as any
}

type ViewerRole = 'player' | 'pika_team' | 'admin'
let viewerRole: ViewerRole = 'player'

const friendships: FriendshipsSnapshot = {
  incomingPending: [],
  outgoingPending: [],
  friends: [
    {
      friendshipId: 'friendship-1',
      status: 'accepted',
      direction: 'outgoing',
      profile: makePlayer(FRIEND_PROFILE_ID, 'Friend One'),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as any,
  ],
}

const controller = createLobbyFlowController({
  root,
  joinMatchmaking: () => {},
  leaveMatchmaking: () => {},
  onMatchFound: () => {},
  getAuthSession: () => ({
    account: { role: viewerRole },
    profile: { profileId: SELF_PROFILE_ID, displayName: 'Viewer' } as any,
  }),
  onPlayersLoad: async (page) => ({
    ok: true,
    players: [
      makePlayer(FRIEND_PROFILE_ID, 'Friend One'),
      makePlayer(STRANGER_PROFILE_ID, 'Stranger One'),
    ],
    page,
    pageSize: 20,
    totalCount: 2,
    totalPages: 1,
    snapshot: 'snap-1',
    snapshotReset: false,
  }),
  onProfileByIdLoad: async (profileId) => ({
    ok: true,
    profile: makePlayer(profileId, profileId === FRIEND_PROFILE_ID ? 'Friend One' : 'Stranger One'),
  }),
  onFriendshipsLoad: async () => ({ ok: true, friendships }),
  // Needed so the "Жълтици" shop tab (default) renders its normal content
  // (incl. the "Подари на ..." gift-mode header) instead of the
  // shopPackagesErrorText fallback branch, which short-circuits before the
  // gift header entirely — see renderShopPanel()'s early-return branches.
  onShopPackagesLoad: async () => ({ ok: true, packages: [] }),
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

function clickNavLobby(): void {
  (root.querySelector('[data-lobby-nav-lobby="1"]') as HTMLElement | null)?.click()
}

function clickOwnProfileButton(): void {
  (root.querySelector('[data-lobby-profile-button="1"]') as HTMLElement | null)?.click()
}

function hasMarker(selector: string): boolean {
  return document.querySelector(selector) !== null
}

;(window as any).__profilePopupGiftCoinsPrivilegeHarness = {
  setViewerRole: (role: ViewerRole): void => {
    viewerRole = role
  },
  openTargetProfileAndFlush: async (profileId: string): Promise<void> => {
    clickNavPlayers()
    await flush()
    clickPlayerCard(profileId)
    await flush()
  },
  openOwnProfileAndFlush: async (): Promise<void> => {
    // The "ПРОФИЛ" avatar/button only exists on the lobby screen's hero
    // section (desktop) / profile card (mobile) — navigate back there first,
    // since earlier steps may have left the controller on 'players'/'shop'.
    clickNavLobby()
    await flush()
    clickOwnProfileButton()
    await flush()
  },
  closePopupAndFlush: async (): Promise<void> => {
    (document.querySelector('[data-player-profile-popup-close="1"]') as HTMLElement | null)?.click()
    await flush()
  },
  isPopupOpen: (): boolean => hasMarker('[data-player-profile-popup-root="1"]'),
  hasAcceptedFriendGiftCoinsAction: (): boolean => hasMarker('[data-player-profile-gift-coins]'),
  hasBypassGiftCoinsAction: (): boolean => hasMarker('[data-player-profile-gift-coins-bypass]'),
  hasAnyGiftCoinsAction: (): boolean =>
    hasMarker('[data-player-profile-gift-coins]') || hasMarker('[data-player-profile-gift-coins-bypass]'),
  hasGiftShopAction: (): boolean => hasMarker('[data-player-profile-gift-shop]'),
  getGiftShopRecipientProfileId: (): string | null =>
    (document.querySelector('[data-player-profile-gift-shop]') as HTMLElement | null)?.dataset
      .playerProfileGiftShop ?? null,
  clickGiftShopActionAndFlush: async (): Promise<void> => {
    (document.querySelector('[data-player-profile-gift-shop]') as HTMLElement | null)?.click()
    await flush()
  },
}
