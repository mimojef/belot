// Фаза 8 (профилен popup "Кампании") — browser harness за visual regression
// (checkCampaignProfilePopupUi.ts). Mirror на ludoGameEndCampaignHarness.ts
// pattern-а, но ползва ДИРЕКТНО реалния syncProfilePopup (не стъклива
// re-implementация) — покрива И render-а (renderPlayerProfilePopup), И
// реалната click-wiring верига (attachPopupListeners, извиквана ВЪТРЕ в
// syncProfilePopup), доказвайки production кода, не mock.
import { syncProfilePopup, type ProfilePopupCallbacks } from '/src/app/lobby/renderLobbyScreen.ts'
import type { PlayerCampaignProfileSummary, PlayerPublicProfileSnapshot } from '/src/app/network/createGameServerClient.ts'

let profile: PlayerPublicProfileSnapshot | null = null
let isOwnProfile = false
let campaignSummary: PlayerCampaignProfileSummary | null = null
let campaignAllRewardsExpanded = false
let campaignHistoryOpen = false

let campaignsNavClickCount = 0
let campaignViewAllRewardsToggleCount = 0

function buildProfile(overrides: Partial<PlayerPublicProfileSnapshot> = {}): PlayerPublicProfileSnapshot {
  return {
    profileId: 'p-test',
    displayName: 'Test Player',
    avatarUrl: null,
    level: 5,
    rankTitle: 'Ранг 5',
    skillRating: 1200,
    completedGamesCount: 40,
    wonGamesCount: 20,
    currentRankGames: 40,
    nextRankGames: 60,
    gamesUntilNextRank: 20,
    rankProgressRatio: 0.66,
    averageRating: 4.5,
    totalRatingsCount: 12,
    yellowCoinsBalance: 15000,
    galleryImages: [],
    gender: null,
    likesCount: 3,
    hasLikedByMe: null,
    isBlockedByMe: null,
    isVip: false,
    vipActiveUntil: null,
    ...overrides,
  }
}

const NOOP_CALLBACKS: ProfilePopupCallbacks = {
  onClose: () => {},
  onEditClick: () => {},
  onFriendRequestClick: () => {},
  onBlockClick: () => {},
  onFriendAcceptClick: () => {},
  onFriendRejectClick: () => {},
  onFriendCancelClick: () => {},
  onFriendRemoveClick: () => {},
  onGiftCoinsClick: () => {},
  onGiftCoinsBypassClick: () => {},
  onGiftItemClick: () => {},
  onGiftShopClick: () => {},
  onPikaSupportChatClick: () => {},
  onTopicsPersonalMessageClick: () => {},
  onLikeClick: () => {},
  onGrantSubadminClick: () => {},
  onRevokeSubadminClick: () => {},
  onGrantChatAdminClick: () => {},
  onRevokeChatAdminClick: () => {},
  onGrantPikaTeamClick: () => {},
  onRevokePikaTeamClick: () => {},
  onGrantTopChatAdminClick: () => {},
  onRevokeTopChatAdminClick: () => {},
  onGrantMarketingClick: () => {},
  onRevokeMarketingClick: () => {},
  onVipGrantOpen: () => {},
  onVipGrantCancel: () => {},
  onVipGrantSubmit: () => {},
  onMuteOverlayClick: () => {},
  onMuteActionClick: () => {},
  onBanOpen: () => {},
  onBanCancel: () => {},
  onBanSubmit: () => {},
  onUnbanOpen: () => {},
  onUnbanCancel: () => {},
  onUnbanConfirm: () => {},
  onDeleteOpen: () => {},
  onDeleteCancel: () => {},
  onDeleteSubmit: () => {},
  onRiskRecheckClick: () => {},
  onRiskLinkedProfileClick: () => {},
  onCampaignsNavClick: () => {},
  onCampaignViewAllRewardsToggle: () => {},
}

function render(): void {
  syncProfilePopup(
    {
      isOpen: true,
      profile,
      canEdit: false,
      isOwnProfile,
      friendshipAction: null,
      campaignSummary,
      campaignAllRewardsExpanded,
      campaignHistoryOpen,
      skipAnimation: true,
    },
    {
      ...NOOP_CALLBACKS,
      onCampaignsNavClick: () => {
        campaignsNavClickCount += 1
        campaignHistoryOpen = !campaignHistoryOpen
        render()
      },
      onCampaignViewAllRewardsToggle: () => {
        campaignViewAllRewardsToggleCount += 1
        campaignAllRewardsExpanded = !campaignAllRewardsExpanded
        render()
      },
    },
  )
}

function mount(opts: {
  own?: boolean
  profileOverrides?: Partial<PlayerPublicProfileSnapshot>
  summary?: PlayerCampaignProfileSummary | null
}): void {
  profile = buildProfile(opts.profileOverrides ?? {})
  isOwnProfile = opts.own ?? false
  campaignSummary = opts.summary ?? null
  campaignAllRewardsExpanded = false
  campaignHistoryOpen = false
  campaignsNavClickCount = 0
  campaignViewAllRewardsToggleCount = 0
  render()
}

function close(): void {
  syncProfilePopup({ isOpen: false, profile: null, canEdit: false, friendshipAction: null }, NOOP_CALLBACKS)
}

function clickCampaignsNav(): void {
  document.querySelector<HTMLButtonElement>('[data-player-profile-campaigns-nav="1"]')?.click()
}

function clickViewAllRewards(): void {
  document.querySelector<HTMLButtonElement>('[data-player-profile-campaign-view-all-rewards="1"]')?.click()
}

;(window as unknown as { __campaignProfilePopupHarness: unknown }).__campaignProfilePopupHarness = {
  mount,
  close,
  clickCampaignsNav,
  clickViewAllRewards,
  getCampaignsNavClickCount: () => campaignsNavClickCount,
  getCampaignViewAllRewardsToggleCount: () => campaignViewAllRewardsToggleCount,
}
