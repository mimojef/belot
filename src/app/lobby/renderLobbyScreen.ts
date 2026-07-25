import type {
  AdminSettingsSnapshot,
  AdminStatsSnapshot,
  DailyRewardTierSnapshot,
  ChatConversationSnapshot,
  ChatMessageSnapshot,
  CoinPackageInput,
  CoinPackageSnapshot,
  CoinPackageStatus,
  CoinPurchaseSnapshot,
  FriendRelationshipSnapshot,
  FriendshipsSnapshot,
  LeaderboardCategory,
  LeaderboardsSnapshot,
  MatchStake,
  MissionTemplateInput,
  MatchRoomSnapshot,
  MissionTemplateSnapshot,
  PlayerMissionProgressSnapshot,
  PlayerPublicProfileSnapshot,
  PrivateRoomSnapshot,
  GuestContactMessageListItem,
  SupportMessageSnapshot,
  SupportConversationSnapshot,
} from '../network/createGameServerClient'
import type { MonitoringSnapshot, MonitoringHistoryResult, HistoryWindow, WsConnectionsResult } from '../adminServer/adminServerTypes'
import { renderPeakCards, renderPeakMoments, renderHistoryInfoRow, getWindowLabel } from '../adminServer/renderAdminHistory'
import type { PlayerProfileFriendshipAction } from '../../ui/overlays/renderPlayerProfilePopup'
import { renderPlayerProfilePopup } from '../../ui/overlays/renderPlayerProfilePopup'
import { isPhoneLayoutViewport } from '../../ui/layout/viewportStage'
import { PUBLIC_LEGAL_PAGES, type PublicLegalPageKey } from './publicLegalPages'
import { renderRulesPage } from './renderRulesPage'
import { renderStrategyPage } from './renderStrategyPage'
import { renderLearnPage } from './renderLearnPage'
import { renderFaqPage } from './renderFaqPage'
import { renderAboutPage } from './renderAboutPage'
import { renderFairPlayPage } from './renderFairPlayPage'
import { orderPlayersForViewer } from './orderPlayersForViewer'
import {
  getProfileDisplayNameAvailabilityQuery,
  validateProfileDisplayName,
} from './profileDisplayNameValidation'
import type { AdminPaymentPeriod, AdminPaymentListRow, AdminPaymentDetailRow } from '../adminPayments/adminPaymentsTypes'
import { renderAdminPaymentsPanel, attachAdminPaymentsPanelHandlers } from '../adminPayments/renderAdminPaymentsPanel'
import { renderAdminPaymentDetailPanel, attachAdminPaymentDetailHandlers } from '../adminPayments/renderAdminPaymentDetailPanel'
import { renderGuestTrialPopup, attachGuestTrialPopupEventListeners, type GuestTrialPopupState } from './renderGuestTrialPopup'
import { renderGuestLockedStakePopup, attachGuestLockedStakePopupEventListeners, type GuestLockedStakePopupState } from './renderGuestLockedStakePopup'
import { renderLevelLockedStakePopup, attachLevelLockedStakePopupEventListeners, type LevelLockedStakePopupState } from './renderLevelLockedStakePopup'

const MISSION_TYPE_LABELS: Record<string, string> = {
  win_games: 'Спечели N игри',
  win_capot_games: 'Спечели N игри с капо',
  win_contra_games: 'Спечели N игри с контра',
  play_games: 'Изиграй N игри',
  announce_tersa: 'Обяви N терци',
  announce_50: 'Обяви N 50-ки',
  announce_100: 'Обяви N 100-ки',
  announce_kare: 'Обяви N карета',
  announce_belot: 'Обяви N белота',
}

export type LobbyAuthModalMode = 'closed' | 'cta' | 'login' | 'register' | 'forgot-password'

let _persistentAvatarInput: HTMLInputElement | null = null
let _persistentGalleryInput: HTMLInputElement | null = null
let _pendingGalleryItems: Array<{ file: File; crop: AvatarCropSelection; dataUrl: string }> = []
let _pendingAvatarFile: File | null = null

export function clearProfileEditorPendingState(): void {
  _pendingGalleryItems = []
  _pendingAvatarFile = null
  if (_persistentAvatarInput) _persistentAvatarInput.value = ''
  if (_persistentGalleryInput) _persistentGalleryInput.value = ''
}

function ensurePersistentAvatarInput(): HTMLInputElement {
  if (!_persistentAvatarInput || !document.body.contains(_persistentAvatarInput)) {
    _persistentAvatarInput = document.createElement('input')
    _persistentAvatarInput.type = 'file'
    _persistentAvatarInput.name = 'avatarFile'
    _persistentAvatarInput.accept = 'image/*'
    _persistentAvatarInput.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0;pointer-events:none;'
    document.body.appendChild(_persistentAvatarInput)
  }
  return _persistentAvatarInput
}

function ensurePersistentGalleryInput(): HTMLInputElement {
  if (!_persistentGalleryInput || !document.body.contains(_persistentGalleryInput)) {
    _persistentGalleryInput = document.createElement('input')
    _persistentGalleryInput.type = 'file'
    _persistentGalleryInput.accept = 'image/*'
    _persistentGalleryInput.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0;pointer-events:none;'
    document.body.appendChild(_persistentGalleryInput)
  }
  return _persistentGalleryInput
}

export type AvatarCropSelection = {
  x: number
  y: number
  size: number
}

export type GuestContactFormInput = {
  name: string
  email: string
  subject: string
  message: string
  website: string
}

export type LobbyScreenState = {
  view: 'tables' | 'players' | 'friends' | 'chat' | 'leaderboards' | 'shop' | 'admin' | 'admin-info' | 'admin-server' | 'admin-visitors' | 'admin-payments' | 'admin-payment-detail' | 'guest-contact-messages' | 'private-rooms' | 'support' | PublicLegalPageKey | 'rules' | 'strategy' | 'learn' | 'faq' | 'about' | 'fair-play'
  blockedPlayersPopupOpen: boolean
  blockedPlayers: PlayerPublicProfileSnapshot[] | null
  blockedPlayersLoading: boolean
  blockedPlayersErrorText: string | null
  blockedPlayersLimit: number
  blockLimitPopupOpen: boolean
  noPlayersModalOpen: boolean
  isInGame: boolean
  displayName: string
  selectedStake: MatchStake
  isConnected: boolean
  isSearching: boolean
  queuedPlayers: number
  requiredPlayers: number
  remainingMs: number | null
  statusText: string
  errorText: string | null
  profilePopupOpen: boolean
  profile: PlayerPublicProfileSnapshot
  profilePopupProfile: PlayerPublicProfileSnapshot | null
  profilePopupCanEdit: boolean
  players: PlayerPublicProfileSnapshot[]
  playersSearchQuery: string
  playersSearchDraft: string
  playersSearchResults: PlayerPublicProfileSnapshot[] | null
  playersSearchLoading: boolean
  playersLoading: boolean
  playersErrorText: string | null
  leaderboards: LeaderboardsSnapshot | null
  leaderboardsLoading: boolean
  leaderboardsErrorText: string | null
  activeLeaderboardCategory: LeaderboardCategory
  lobbyPackages: CoinPackageSnapshot[]
  shopPackages: CoinPackageSnapshot[]
  shopPackagesLoading: boolean
  shopPackagesErrorText: string | null
  shopPurchases: CoinPurchaseSnapshot[]
  shopPurchasesVisible: boolean
  shopPurchasesLoading: boolean
  shopPurchaseConfirmPackageId: string | null
  shopPurchaseActionPackageId: string | null
  shopPurchaseMessageText: string | null
  shopPurchaseResumeId: string | null
  shopPurchaseHideConfirmId: string | null
  shopPurchaseActionPurchaseId: string | null
  isAdmin: boolean
  adminStats: AdminStatsSnapshot | null
  adminStatsLoading: boolean
  adminStatsErrorText: string | null
  adminActiveDailyRewardTiers: DailyRewardTierSnapshot[]
  adminStagedDailyRewardTiers: DailyRewardTierSnapshot[]
  adminDailyRewardsLoading: boolean
  adminDailyRewardsErrorText: string | null
  adminDailyRewardAddLoading: boolean
  adminDailyRewardAddErrorText: string | null
  dailyRewardTiers: DailyRewardTierSnapshot[]
  dailyRewardsPopupOpen: boolean
  dailyRewardsLoading: boolean
  dailyRewardsErrorText: string | null
  dailyRewardClaimingId: string | null
  dailyRewardClaimErrorText: string | null
  dailyRewardLastAwarded: number | null
  adminSettings: AdminSettingsSnapshot | null
  adminSettingsLoading: boolean
  adminSettingsErrorText: string | null
  adminCoinPackages: CoinPackageSnapshot[]
  adminCoinPackagesLoading: boolean
  adminCoinPackagesErrorText: string | null
  adminCoinPackageEditId: string | null
  friendships: FriendshipsSnapshot | null
  friendsLoading: boolean
  friendsErrorText: string | null
  friendshipAction: PlayerProfileFriendshipAction | null
  giftModalFriendshipId: string | null
  giftModalFriendName: string
  giftModalErrorText: string | null
  giftSuccessModal: { amount: number; friendName: string } | null
  giftReceivedModal: { amount: number; fromDisplayName: string } | null
  pendingGiftNotifications: Array<{ giftId: string; amount: number; fromDisplayName: string }>
  acceptanceNotifications: Array<{ friendshipId: string; fromProfileId: string; fromDisplayName: string; fromAvatarUrl: string | null }>
  acceptanceErrorText: string | null
  chatConversations: ChatConversationSnapshot[]
  activeChatFriendshipId: string | null
  chatMessages: ChatMessageSnapshot[]
  chatLoading: boolean
  chatMessagesLoading: boolean
  chatErrorText: string | null
  authModalMode: LobbyAuthModalMode
  authErrorText: string | null
  guestTrialPopup: GuestTrialPopupState
  guestLockedStakePopup: GuestLockedStakePopupState
  levelLockedStakePopup: LevelLockedStakePopupState
  lowCoinsModalOpen: boolean
  onlinePlayersCount: number
  signupBonusYellowCoins: number
  profileNameChangePrice: number
  profileEditorOpen: boolean
  profileEditorTargetProfileId: string | null
  profileEditorTargetProfile: PlayerPublicProfileSnapshot | null
  profileEditorErrorText: string | null
  profileNameChangeErrorText: string | null
  profileNameChangeSuccessAmount: number | null
  changePasswordPopupOpen: boolean
  changePasswordErrorText: string | null
  notificationsOpen: boolean
  pendingFriendRequests: Array<{ friendshipId: string; fromProfileId: string; fromDisplayName: string; fromAvatarUrl: string | null }>
  missionsPopupOpen: boolean
  dailyMissions: PlayerMissionProgressSnapshot[]
  dailyMissionsLoading: boolean
  dailyMissionsErrorText: string | null
  dailyMissionsUnclaimedCount: number
  missionClaimingId: string | null
  missionClaimErrorText: string | null
  adminActiveMissions: MissionTemplateSnapshot[]
  adminStagedMissions: MissionTemplateSnapshot[]
  adminMissionsLoading: boolean
  adminMissionsErrorText: string | null
  adminMissionEditId: string | null
  adminMissionEditIsStaged: boolean
  matchRooms: MatchRoomSnapshot[]
  matchRoomsLoading: boolean
  matchRoomsErrorText: string | null
  adminMatchRoomEdit: { stakeAmount: number; minLevel: number; prizeAmount: number; isEnabled: boolean } | 'new' | null
  privateRoomsCreatePopupOpen: boolean
  privateRoomsTab: 'all' | 'mine'
  privateRooms: PrivateRoomSnapshot[]
  myPrivateRoom: PrivateRoomSnapshot | null
  privateRoomInvite: {
    inviteId: string
    fromProfileId: string
    fromDisplayName: string
    fromAvatarUrl: string | null
    privateRoomId: string
    stake: MatchStake
    expiresAt: number
  } | null
  privateRoomInviteQueue: Array<{ inviteId: string }>
  privateRoomInfoText: string | null
  leavePrivateRoomForMatchmakingOpen: boolean
  leavePrivateRoomForMatchmakingIsHost: boolean
  inviteFriendsPopupOpen: boolean
  supportPopupOpen: boolean
  supportMessages: SupportMessageSnapshot[]
  supportUnreadCount: number
  supportLoading: boolean
  supportSendingLoading: boolean
  supportErrorText: string | null
  supportAccountTooNewMinutes: number | null
  guestContactPopupOpen: boolean
  guestContactSending: boolean
  guestContactErrorText: string | null
  guestContactSuccessText: string | null
  adminSupportConversations: SupportConversationSnapshot[]
  adminSupportConversationsLoading: boolean
  adminSupportSelectedProfileId: string | null
  adminSupportMessages: SupportMessageSnapshot[]
  adminSupportMessagesLoading: boolean
  adminSupportReplyLoading: boolean
  adminSupportDeleteConfirmProfileId: string | null
  adminSupportDeleteLoading: boolean
  adminGuestContactMessages: GuestContactMessageListItem[]
  adminGuestContactMessagesLoading: boolean
  adminGuestContactMessagesErrorText: string | null
  adminGuestContactUnreadCount: number
  supportDeleteConfirm: boolean
  supportDeleteLoading: boolean
  adminMonitoringSnapshot: MonitoringSnapshot | null
  adminMonitoringErrorText: string | null
  adminHistoryWindow: HistoryWindow
  adminHistoryResult: MonitoringHistoryResult | null
  adminHistoryLoading: boolean
  adminHistoryErrorText: string | null
  adminWsConnections: WsConnectionsResult | null
  adminVisitorsLoading: boolean
  adminVisitorsRows: import('../network/createGameServerClient').AdminVisitorRow[]
  adminVisitorsTotal: number
  adminVisitorsErrorText: string | null
  adminVisitorsPeriod: import('../network/createGameServerClient').VisitorListPeriod
  adminVisitorsType: import('../network/createGameServerClient').VisitorListType
  adminVisitorsDevice: import('../network/createGameServerClient').VisitorDeviceFilter
  adminVisitorsOs: import('../network/createGameServerClient').VisitorOsFilter
  adminVisitorsOffset: number
  adminVisitorsLimit: number
  adminVisitorsView: import('../network/createGameServerClient').AdminVisitorsView
  adminVisitorsSourcesLoading: boolean
  adminVisitorsSourcesRows: import('../network/createGameServerClient').AdminVisitorSourceRow[]
  adminVisitorsSourcesTotal: number
  adminVisitorsSourcesErrorText: string | null
  adminPaymentsPeriod: AdminPaymentPeriod
  adminPaymentsLoading: boolean
  adminPaymentsRows: AdminPaymentListRow[]
  adminPaymentsTotal: number
  adminPaymentsTotalsByCurrency: Record<string, number>
  adminPaymentsErrorText: string | null
  adminPaymentsOffset: number
  adminPaymentsLimit: number
  adminPaymentDetailPurchaseId: string | null
  adminPaymentDetailLoading: boolean
  adminPaymentDetailPurchase: AdminPaymentDetailRow | null
  adminPaymentDetailErrorText: string | null
}

export type RenderLobbyScreenOptions = {
  state: LobbyScreenState
  apiBaseUrl: string
  onDisplayNameChange: (value: string) => void
  onStakeChange: (stake: MatchStake) => void
  onSearchClick: () => void
  onCancelClick: () => void
  onProfileClick: () => void
  onProfileClose: () => void
  onProfileEditClick: () => void
  onProfileEditClose: () => void
  onProfileEditSubmit: (
    avatarFile: File | null,
    avatarCrop: AvatarCropSelection | null,
    galleryFiles: File[],
  ) => void
  onProfileEditorFileError: (message: string) => void
  onPresetAvatarApply: (avatarUrl: string) => void
  onProfileGalleryDelete: (imageId: string) => void
  onProfileNameChangeSubmit: (displayName: string) => void
  onChangePasswordOpen: () => void
  onChangePasswordClose: () => void
  onChangePasswordSubmit: (currentPassword: string, newPassword: string, confirmPassword: string) => void
  onLobbyClick: () => void
  onPlayersClick: () => void
  onShopClick: () => void
  onShopPurchaseClick: (packageId: string) => void
  onShopPurchaseConfirm: () => void
  onShopPurchaseCancel: () => void
  onShopPurchaseResumePay: (purchaseId: string) => void
  onShopPurchaseHideRequest: (purchaseId: string) => void
  onShopPurchaseHideConfirm: () => void
  onShopPurchaseHideCancel: () => void
  onShopHistoryToggle: () => void
  onLeaderboardsClick: () => void
  onLeaderboardCategoryClick: (category: LeaderboardCategory) => void
  onAdminClick: () => void
  onAdminInfoClick: () => void
  onAdminServerClick: () => void
  onAdminGuestContactMessagesClick: () => void
  onAdminDailyRewardAdd: (amount: number) => void
  onAdminDailyRewardRemove: (tierId: string) => void
  onDailyRewardsOpen: () => void
  onDailyRewardsClose: () => void
  onDailyRewardClaim: (tierId: string) => void
  onAdminSettingsSubmit: (settings: AdminSettingsSnapshot) => void
  onAdminCoinPackageSubmit: (input: CoinPackageInput) => void
  onAdminCoinPackageStatusChange: (
    packageId: string,
    status: CoinPackageStatus,
  ) => void
  onAdminCoinPackageEdit: (packageId: string) => void
  onAdminCoinPackageDelete: (packageId: string) => void
  onAdminCoinPackageLobbyToggle: (packageId: string, showInLobby: boolean) => void
  onFriendsClick: () => void
  onBlockedPlayersClick: () => void
  onBlockedPlayersClose: () => void
  onUnblockClick: (profileId: string) => void
  onBlockLimitPopupClose: () => void
  onNoPlayersModalClose: () => void
  onChatClick: () => void
  onChatConversationClick: (friendshipId: string) => void
  onChatMarkRead: (friendshipId: string) => void
  onChatSubmit: (friendshipId: string, body: string) => void
  onPlayerCardClick: (profile: PlayerPublicProfileSnapshot) => void
  onPlayersSearchChange: (query: string) => void
  onPlayersSearchDraftChange: (draft: string) => void
  onPlayersSearchSubmit: (query: string) => void
  onLeaderboardPlayerClick: (profile: PlayerPublicProfileSnapshot) => void
  onFriendProfileClick: (profile: PlayerPublicProfileSnapshot) => void
  onFriendRequestClick: (profileId: string) => void
  onBlockClick: (profileId: string) => void
  onFriendAcceptClick: (friendshipId: string) => void
  onFriendRejectClick: (friendshipId: string) => void
  onFriendCancelClick: (friendshipId: string) => void
  onFriendRemoveClick: (friendshipId: string) => void
  onGiftCoinsClick: (friendshipId: string) => void
  onLikeClick: (profileId: string) => void
  onGiftCoinsClose: () => void
  onGiftCoinsSubmit: (friendshipId: string, amount: number) => void
  onGiftSuccessClose: () => void
  onGiftReceivedClose: () => void
  onLowCoinsModalClose: () => void
  onLowCoinsShopClick: () => void
  onAuthModalClose: () => void
  onAuthModeChange: (mode: Exclude<LobbyAuthModalMode, 'closed'>) => void
  onAuthError: (message: string) => void
  onGuestTrialPlayClick: () => void
  onGuestTrialRegisterClick: () => void
  onGuestTrialLoginClick: () => void
  onGuestTrialClose: () => void
  onGuestLockedStakePlay5000Click: () => void
  onGuestLockedStakeRegisterClick: () => void
  onGuestLockedStakeLoginClick: () => void
  onGuestLockedStakeClose: () => void
  onLevelLockedStakeViewProfileClick: () => void
  onLevelLockedStakeClose: () => void
  onLoginSubmit: (email: string, password: string) => void
  onRegisterSubmit: (displayName: string, email: string, password: string, gender: 'male' | 'female' | null) => void
  onForgotPasswordSubmit?: (email: string) => void
  onLogoutClick: () => void
  onBellClick: () => void
  onNotificationMissionsClick: () => void
  onNotifFriendRequestClick: (friendshipId: string) => void
  onNotifGiftClick: (giftId: string, amount: number, fromDisplayName: string) => void
  onNotifAcceptanceClick: (friendshipId: string) => void
  onMissionsCardClick: () => void
  onMissionsPopupClose: () => void
  onMissionClaimClick: (missionId: string) => void
  onAdminMissionSubmit: (input: MissionTemplateInput) => void
  onAdminMissionActiveToggle: (missionId: string, isActive: boolean) => void
  onAdminMissionDelete: (missionId: string) => void
  onAdminMissionEdit: (missionId: string, isStaged?: boolean) => void
  onAdminMatchRoomEditStart: (room: { stakeAmount: number; minLevel: number; prizeAmount: number; isEnabled: boolean } | null) => void
  onAdminMatchRoomEditCancel: () => void
  onAdminMatchRoomSubmit: (room: { stakeAmount: number; minLevel: number; prizeAmount: number; isEnabled: boolean }) => void
  onAdminMatchRoomDelete: (stakeAmount: number) => void
  onPrivateRoomsOpen: () => void
  onPrivateRoomsClose: () => void
  onPrivateRoomsTabChange: (tab: 'all' | 'mine') => void
  onPrivateRoomsCreateOpen: () => void
  onPrivateRoomsCreateClose: () => void
  onPrivateRoomCreate: (stake: MatchStake, isLocked: boolean) => void
  onPrivateRoomJoin: (privateRoomId: string) => void
  onPrivateRoomLeave: () => void
  onPrivateRoomInvite: (toProfiles: Array<{ profileId: string; displayName: string }>) => void
  onCancelPrivateRoomInvite: (inviteId: string) => void
  onInviteFriendsOpen: () => void
  onInviteFriendsClose: () => void
  onPrivateRoomInviteAccept: (inviteId: string) => void
  onPrivateRoomInviteDecline: (inviteId: string) => void
  onPrivateRoomInfoDismiss: () => void
  onLeavePrivateRoomAndMatchmakeConfirm: () => void
  onLeavePrivateRoomAndMatchmakeCancel: () => void
  onSupportClick: () => void
  onSupportClose: () => void
  onSupportSend: (body: string) => void
  onGuestContactClick: () => void
  onGuestContactClose: () => void
  onGuestContactSubmit: (input: GuestContactFormInput) => void
  onAdminSupportConversationClick: (profileId: string) => void
  onAdminSupportReply: (profileId: string, body: string) => void
  onAdminSupportDeleteClick: (profileId: string) => void
  onAdminSupportDeleteCancel: () => void
  onAdminSupportDeleteConfirm: (profileId: string) => void
  onAdminGuestContactMessageRead: (messageId: string) => void
  onSupportDeleteClick: () => void
  onSupportDeleteCancel: () => void
  onSupportDeleteConfirm: () => void
  onAdminHistoryWindowChange: (window: import('../adminServer/adminServerTypes.js').HistoryWindow) => void
  onAdminVisitorsPeriodClick?: (period: string) => void
  onAdminVisitorsBackClick?: () => void
  onAdminVisitorsTypeChange?: (type: import('../network/createGameServerClient').VisitorListType) => void
  onAdminVisitorsDeviceChange?: (device: import('../network/createGameServerClient').VisitorDeviceFilter) => void
  onAdminVisitorsOsChange?: (os: import('../network/createGameServerClient').VisitorOsFilter) => void
  onAdminVisitorsPageChange?: (offset: number) => void
  onAdminVisitorsViewChange?: (view: import('../network/createGameServerClient').AdminVisitorsView) => void
  onAdminPaymentsOpen?: (period: AdminPaymentPeriod) => void
  onAdminPaymentsPeriodChange?: (period: AdminPaymentPeriod) => void
  onAdminPaymentsPageChange?: (offset: number) => void
  onAdminPaymentsBackClick?: () => void
  onAdminPaymentsDetailOpen?: (purchaseId: string) => void
  onAdminPaymentDetailBack?: () => void
  onRulesOpen: () => void
  onStrategyOpen: () => void
}



const MAX_PROFILE_GALLERY_IMAGES = 6

let popupRootEl: HTMLElement | null = null
let privateRoomInfoDismissTimer: ReturnType<typeof setTimeout> | null = null
let mobileMenuOpen = false
let mobileMenuCloseTimer: ReturnType<typeof setTimeout> | null = null
let stakesFirstCardIndex = -1
let stakesAnimFrame = 0
let inviteCountdownTimer: ReturnType<typeof setInterval> | null = null

export type ProfilePopupCallbacks = {
  onClose: () => void
  onEditClick: (profileId: string | null) => void
  onFriendRequestClick: (profileId: string) => void
  onBlockClick: (profileId: string) => void
  onFriendAcceptClick: (friendshipId: string) => void
  onFriendRejectClick: (friendshipId: string) => void
  onFriendCancelClick: (friendshipId: string) => void
  onFriendRemoveClick: (friendshipId: string) => void
  onGiftCoinsClick: (friendshipId: string) => void
  onLikeClick: (profileId: string) => void
}

function attachPopupListeners(el: HTMLElement, cb: ProfilePopupCallbacks, profileId: string | null): void {
  el.querySelector<HTMLButtonElement>('[data-player-profile-popup-close="1"]')
    ?.addEventListener('click', cb.onClose)
  el.querySelector<HTMLElement>('[data-player-profile-popup-backdrop="1"]')
    ?.addEventListener('click', cb.onClose)
  const editEl = el.querySelector<HTMLElement>('[data-player-profile-edit="1"]')
  if (editEl) {
    editEl.addEventListener('click', () => {
      cb.onEditClick(profileId)
    })
    editEl.addEventListener('mouseenter', () => { editEl.style.textDecoration = 'underline' })
    editEl.addEventListener('mouseleave', () => { editEl.style.textDecoration = 'none' })
  }
  el.querySelector<HTMLButtonElement>('[data-player-profile-like]')
    ?.addEventListener('click', (e) => {
      const profileId = (e.currentTarget as HTMLButtonElement).dataset.playerProfileLike?.trim() ?? ''
      if (profileId) cb.onLikeClick(profileId)
    })
  el.querySelector<HTMLButtonElement>('[data-player-profile-friend-request]')
    ?.addEventListener('click', (e) => {
      const profileId = (e.currentTarget as HTMLButtonElement).dataset.playerProfileFriendRequest?.trim() ?? ''
      if (profileId) cb.onFriendRequestClick(profileId)
    })
  el.querySelector<HTMLButtonElement>('[data-player-profile-block]')
    ?.addEventListener('click', (e) => {
      const profileId = (e.currentTarget as HTMLButtonElement).dataset.playerProfileBlock?.trim() ?? ''
      if (profileId) cb.onBlockClick(profileId)
    })
  el.querySelector<HTMLButtonElement>('[data-player-profile-gift-coins]')
    ?.addEventListener('click', (e) => {
      const friendshipId = (e.currentTarget as HTMLButtonElement).dataset.playerProfileGiftCoins?.trim() ?? ''
      if (friendshipId) cb.onGiftCoinsClick(friendshipId)
    })
  el.querySelectorAll<HTMLButtonElement>('[data-player-profile-friend-accept]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.playerProfileFriendAccept?.trim() ?? ''
      if (id) cb.onFriendAcceptClick(id)
    })
  })
  el.querySelectorAll<HTMLButtonElement>('[data-player-profile-friend-reject]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.playerProfileFriendReject?.trim() ?? ''
      if (id) cb.onFriendRejectClick(id)
    })
  })
  el.querySelectorAll<HTMLButtonElement>('[data-player-profile-friend-cancel]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.playerProfileFriendCancel?.trim() ?? ''
      if (id) cb.onFriendCancelClick(id)
    })
  })
  el.querySelectorAll<HTMLButtonElement>('[data-player-profile-friend-remove]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.playerProfileFriendRemove?.trim() ?? ''
      if (id) cb.onFriendRemoveClick(id)
    })
  })
  el.querySelectorAll<HTMLElement>('[data-gallery-image-url]').forEach((imgEl) => {
    imgEl.addEventListener('click', () => {
      const url = imgEl.getAttribute('data-gallery-image-url') ?? ''
      if (!url) return
      const overlay = document.createElement('div')
      overlay.style.cssText = 'position:fixed;inset:0;z-index:20000;background:rgba(0,0,0,0.92);display:flex;align-items:center;justify-content:center;cursor:zoom-out;'
      const img = document.createElement('img')
      img.src = url
      img.alt = 'Снимка'
      img.style.cssText = 'max-width:90vw;max-height:90vh;object-fit:contain;border-radius:12px;box-shadow:0 8px 40px rgba(0,0,0,0.7);'
      overlay.appendChild(img)
      overlay.addEventListener('click', () => overlay.remove())
      document.body.appendChild(overlay)
    })
  })
}

export function syncProfilePopup(
  popupState: {
    isOpen: boolean
    profile: PlayerPublicProfileSnapshot | null
    canEdit: boolean
    isAdmin?: boolean
    friendshipAction: PlayerProfileFriendshipAction | null
  },
  cb: ProfilePopupCallbacks,
): void {
  if (!popupState.isOpen) {
    popupRootEl?.remove()
    popupRootEl = null
    return
  }
  const isFirstOpen = !popupRootEl
  if (isFirstOpen) {
    popupRootEl = document.createElement('div')
    document.body.appendChild(popupRootEl)
  }
  const el = popupRootEl!
  el.innerHTML = renderPlayerProfilePopup({
    isOpen: true,
    seat: 'bottom',
    profile: popupState.profile,
    canEdit: popupState.canEdit,
    isAdmin: popupState.isAdmin ?? false,
    friendshipAction: popupState.friendshipAction,
    skipAnimation: !isFirstOpen,
  })
  attachPopupListeners(el, cb, popupState.profile?.profileId ?? null)
}

export function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function formatAmount(value: number): string {
  return new Intl.NumberFormat('bg-BG').format(value)
}

function renderLevelBadge(level: number | null | undefined, size: 'sm' | 'md' = 'md'): string {
  if (typeof level !== 'number' || !Number.isFinite(level) || level < 1) return ''
  const sz = size === 'sm' ? '16px' : '20px'
  const fs = size === 'sm' ? '9px' : '11px'
  return `<div style="position:absolute;right:4px;bottom:4px;min-width:${sz};height:${sz};border-radius:999px;background:#000000;display:flex;align-items:center;justify-content:center;padding:0 3px;line-height:1;z-index:1;color:#ffffff;font-size:${fs};font-weight:700;">${Math.trunc(level)}</div>`
}

function formatPackagePrice(priceCents: number, currency: string): string {
  return new Intl.NumberFormat('bg-BG', {
    style: 'currency',
    currency,
  }).format(priceCents / 100)
}

const EUR_TO_BGN = 1.95583

function formatPackagePriceBgn(priceCents: number): string {
  const bgn = Math.round((priceCents / 100) * EUR_TO_BGN * 100) / 100
  return new Intl.NumberFormat('bg-BG', {
    style: 'currency',
    currency: 'BGN',
  }).format(bgn)
}

function renderPublicLegalBodyHtml(pageKey: PublicLegalPageKey, isMobile = false): string {
  const page = PUBLIC_LEGAL_PAGES[pageKey]
  const blocks = page.body
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0)

  return blocks.map((block, index) => {
    const isDocumentTitle = index === 0
    const isSectionTitle = /^\d+\.\s/.test(block)
    const style = isDocumentTitle
      ? `margin:0 0 18px;color:#f8fafc;font-size:${isMobile ? '18px' : '22px'};line-height:1.22;font-weight:900;`
      : isSectionTitle
        ? `margin:${isMobile ? '22px' : '28px'} 0 8px;color:#d4a520;font-size:${isMobile ? '15px' : '17px'};line-height:1.35;font-weight:900;`
        : `margin:0 0 12px;color:rgba(255,255,255,0.72);font-size:${isMobile ? '13px' : '15px'};line-height:${isMobile ? '1.58' : '1.68'};font-weight:600;`

    return `<p style="${style}">${escapeHtml(block).replace(/\n/g, '<br>')}</p>`
  }).join('')
}

function renderShopPurchaseLegalPreview(pageKey: 'terms' | 'privacy'): string {
  const page = PUBLIC_LEGAL_PAGES[pageKey]

  return `
    <div data-shop-purchase-legal-preview="${pageKey}" style="display:none;position:fixed;inset:0;z-index:13800;align-items:center;justify-content:center;padding:18px;">
      <div data-shop-purchase-legal-backdrop="1" style="position:absolute;inset:0;background:rgba(0,0,0,0.72);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);"></div>
      <div role="dialog" aria-modal="true" aria-label="${escapeHtml(page.title)}" class="gold-scrollbar" style="position:relative;width:min(94vw,720px);max-height:88vh;overflow:hidden;border-radius:10px;border:2px solid rgba(212,165,32,0.78);background:linear-gradient(180deg,rgba(20,20,20,0.99) 0%,rgba(5,5,5,0.99) 100%);box-shadow:0 28px 80px rgba(0,0,0,0.60);padding:18px;display:grid;grid-template-rows:auto minmax(0,1fr);gap:12px;">
        <button type="button" data-shop-purchase-legal-close="1" aria-label="Затвори" style="position:absolute;right:10px;top:8px;width:36px;height:36px;border:0;border-radius:999px;background:rgba(255,255,255,0.08);color:#ffffff;font-size:22px;font-weight:900;cursor:pointer;">×</button>
        <div style="border-bottom:1px solid rgba(212,165,32,0.28);padding:0 44px 12px 0;">
          <div style="font-size:22px;line-height:1.15;font-weight:900;color:#f8fafc;">${escapeHtml(page.title)}</div>
          <div style="margin-top:4px;font-size:12px;font-weight:800;color:rgba(255,255,255,0.48);">Преглед в прозореца за покупка</div>
        </div>
        <div class="gold-scrollbar" style="min-height:0;overflow-y:auto;padding-right:8px;">
          ${renderPublicLegalBodyHtml(pageKey, true)}
        </div>
      </div>
    </div>
  `
}

export function renderShopPurchaseConfirmModal(state: LobbyScreenState): string {
  const packageId = state.shopPurchaseConfirmPackageId
  if (packageId === null) return ''

  const coinPackage =
    state.shopPackages.find((item) => item.packageId === packageId) ??
    state.lobbyPackages.find((item) => item.packageId === packageId)
  if (!coinPackage) return ''

  const isProcessing = state.shopPurchaseActionPackageId === packageId
  const priceLabel = formatPackagePrice(coinPackage.priceCents, coinPackage.currency)
  const priceBgnLabel = formatPackagePriceBgn(coinPackage.priceCents)

  return `
    <div data-shop-purchase-confirm-root="1" style="position:fixed;inset:0;z-index:13700;display:flex;align-items:center;justify-content:center;padding:18px;">
      <div data-shop-purchase-confirm-backdrop="1" style="position:absolute;inset:0;background:rgba(0,0,0,0.78);-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);"></div>
      <div role="dialog" aria-modal="true" aria-labelledby="shop-purchase-confirm-title" class="gold-scrollbar" style="position:relative;width:min(94vw,500px);max-height:92vh;overflow-y:auto;border-radius:10px;border:2px solid rgba(212,165,32,0.72);background:linear-gradient(180deg,rgba(32,32,32,0.99) 0%,rgba(8,8,8,0.99) 100%);box-shadow:0 34px 90px rgba(0,0,0,0.56);padding:22px;">
        <button type="button" data-shop-purchase-confirm-close="1" aria-label="Затвори" ${isProcessing ? 'disabled' : ''} style="position:absolute;right:10px;top:8px;width:36px;height:36px;border:0;border-radius:999px;background:rgba(255,255,255,0.08);color:#ffffff;font-size:22px;font-weight:900;cursor:${isProcessing ? 'default' : 'pointer'};opacity:${isProcessing ? '0.45' : '1'};">×</button>

        <div style="display:grid;gap:16px;">
          <div>
            <div id="shop-purchase-confirm-title" style="font-size:24px;line-height:1.1;font-weight:900;color:#f8fafc;">Потвърждение на покупка</div>
            <div style="margin-top:7px;font-size:13px;line-height:1.45;color:rgba(255,255,255,0.60);font-weight:700;">Прегледайте избрания пакет преди продължаване към Stripe Checkout.</div>
          </div>

          <div style="display:grid;grid-template-columns:84px minmax(0,1fr);gap:14px;align-items:center;border:1px solid rgba(212,165,32,0.34);border-radius:10px;background:#080808;padding:14px;">
            <img src="${getCoinPackageImage(coinPackage.sortOrder)}" alt="" style="width:82px;height:82px;object-fit:contain;">
            <div style="display:grid;gap:7px;min-width:0;">
              <div style="font-size:12px;font-weight:900;color:rgba(255,255,255,0.48);text-transform:uppercase;letter-spacing:0.08em;">${escapeHtml(coinPackage.title)}</div>
              <div style="font-size:24px;font-weight:900;color:#d4a520;line-height:1;">${formatAmount(coinPackage.yellowCoinsAmount)} жълтици</div>
              <div style="font-size:16px;font-weight:900;color:#ffffff;">Крайна цена: ${escapeHtml(priceLabel)}</div>
              <div style="font-size:12px;font-weight:800;color:rgba(255,255,255,0.48);">Приблизително ${escapeHtml(priceBgnLabel)}</div>
            </div>
          </div>

          <div style="display:grid;gap:8px;border:1px solid rgba(255,255,255,0.10);border-radius:10px;background:rgba(255,255,255,0.035);padding:13px 14px;">
            <div style="font-size:13px;line-height:1.45;font-weight:800;color:rgba(255,255,255,0.78);">Жълтиците са виртуална игрова валута и не могат да се обменят за реални пари.</div>
            <div style="font-size:13px;line-height:1.45;font-weight:800;color:rgba(255,255,255,0.78);">След успешно плащане жълтиците ще бъдат добавени автоматично към профила ви.</div>
          </div>

          <div style="display:grid;grid-template-columns:auto minmax(0,1fr);gap:10px;align-items:start;border:1px solid rgba(212,165,32,0.28);border-radius:10px;background:rgba(212,165,32,0.08);padding:12px;">
            <input type="checkbox" data-shop-purchase-confirm-check="1" ${isProcessing ? 'disabled' : ''} style="width:18px;height:18px;margin-top:2px;accent-color:#d4a520;cursor:${isProcessing ? 'default' : 'pointer'};flex-shrink:0;">
            <div style="font-size:13px;line-height:1.45;font-weight:800;color:rgba(255,255,255,0.82);">
              Декларирам, че съм запознат и съм съгласен с
              <a data-shop-confirm-legal-link="terms" href="/terms" style="color:#f4c95b;text-decoration:underline;text-underline-offset:3px;">Общите условия</a>
              и
              <a data-shop-confirm-legal-link="privacy" href="/privacy" style="color:#f4c95b;text-decoration:underline;text-underline-offset:3px;">Политиката за поверителност</a>
              на Pika.bg.
            </div>
          </div>

          <div style="display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap;">
            <button type="button" data-shop-purchase-confirm-cancel="1" ${isProcessing ? 'disabled' : ''} style="height:42px;padding:0 16px;border:1px solid rgba(255,255,255,0.14);border-radius:8px;background:#080808;color:#f8fafc;font-size:14px;font-weight:900;cursor:${isProcessing ? 'default' : 'pointer'};opacity:${isProcessing ? '0.5' : '1'};">Отказ</button>
            <button type="button" data-shop-purchase-confirm-submit="1" disabled style="height:42px;padding:0 18px;border:0;border-radius:8px;background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;font-size:14px;font-weight:900;cursor:not-allowed;opacity:0.55;">${isProcessing ? 'Пренасочване...' : 'Продължи към плащане'}</button>
          </div>
        </div>
        ${renderShopPurchaseLegalPreview('terms')}
        ${renderShopPurchaseLegalPreview('privacy')}
      </div>
    </div>
  `
}

function getCoinPackageImage(sortOrder: number): string {
  if (sortOrder <= 20) return '/assets/lobby/coins-1000.png'
  if (sortOrder <= 40) return '/assets/lobby/coins-5000.png'
  if (sortOrder <= 60) return '/assets/lobby/coins-10000.png'
  if (sortOrder <= 80) return '/assets/lobby/coins-25000.png'
  return '/assets/lobby/coins-50000.png'
}

function parseUtcString(value: string): Date {
  // SQLite CURRENT_TIMESTAMP gives '2026-05-18 09:39:00' — UTC but no 'Z' suffix.
  // Without normalization, browsers parse it as local time.
  const hasOffset = value.endsWith('Z') || value.includes('+') || /\d-\d{2}:\d{2}$/.test(value)
  const normalized = hasOffset ? value : value.replace(' ', 'T') + 'Z'
  return new Date(normalized)
}

function formatCompactDateTime(value: string): string {
  const date = parseUtcString(value)

  if (Number.isNaN(date.getTime())) {
    return value
  }

  return new Intl.DateTimeFormat('bg-BG', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function formatPurchaseStatusLabel(status: CoinPurchaseSnapshot['status']): string {
  switch (status) {
    case 'pending':
      return 'Изчаква плащане'
    case 'paid':
      return 'Платена'
    case 'canceled':
      return 'Отказана'
    case 'failed':
      return 'Неуспешна'
    default:
      return status
  }
}

function getPurchaseStatusColor(status: CoinPurchaseSnapshot['status']): string {
  switch (status) {
    case 'paid':
      return '#86efac'
    case 'pending':
      return '#d4a520'
    case 'failed':
      return '#fecaca'
    case 'canceled':
    default:
      return 'rgba(255,255,255,0.48)'
  }
}

function renderAuthModal(state: LobbyScreenState): string {
  if (state.authModalMode === 'closed') {
    return ''
  }

  const bonusText = formatAmount(state.signupBonusYellowCoins)
  const isLogin = state.authModalMode === 'login'
  const isRegister = state.authModalMode === 'register'
  const isForgotPassword = state.authModalMode === 'forgot-password'

  const body = isForgotPassword
    ? `
      <form data-lobby-forgot-form="1" style="display:grid;gap:12px;" novalidate>
        <div style="font-size:25px;line-height:1.1;font-weight:900;color:#f8fafc;text-align:center;">Забравена парола</div>
        <div style="font-size:14px;line-height:1.55;color:rgba(255,255,255,0.72);text-align:center;">
          Въведете имейл адреса, с който сте регистрирани.
        </div>
        <label style="display:grid;gap:6px;font-size:12px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#d4a520;">
          Имейл адрес
          <input name="email" type="email" autocomplete="email" style="height:42px;border-radius:8px;border:1px solid rgba(212,165,32,0.34);background:#050505;color:#ffffff;padding:0 12px;font-size:15px;font-weight:700;outline:none;">
        </label>
        <div data-lobby-forgot-message="1" style="display:none;border-radius:8px;padding:10px 12px;font-size:13px;font-weight:800;text-align:center;"></div>
        <button type="submit" data-lobby-forgot-submit="1" style="height:46px;border:0;border-radius:8px;background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;font-size:15px;font-weight:900;cursor:pointer;margin-top:4px;">
          Изпрати линк
        </button>
        <button type="button" data-lobby-auth-mode="login" style="height:34px;border:0;background:transparent;color:rgba(255,255,255,0.72);font-size:13px;font-weight:800;cursor:pointer;">
          Назад към вход
        </button>
      </form>
    `
    : state.authModalMode === 'cta'
    ? `
      <div style="display:grid;gap:16px;text-align:center;">
        <div style="font-size:28px;line-height:1.12;font-weight:900;color:#f8fafc;">
          Регистрирай се и вземи <span style="white-space:nowrap"><img src="/assets/lobby/icon-coin.png" alt="" style="width:28px;height:28px;vertical-align:middle;margin:0 2px 3px 0;"><span style="color:#d4a520;">${escapeHtml(bonusText)}</span></span> жълтици
        </div>
        <div style="font-size:15px;line-height:1.5;color:rgba(255,255,255,0.72);font-weight:700;">
          Създай профил, избери име и отключи всички маси. Използвай чат с приятели, изпращай подаръци, печели жълтици и трупай рейтинг.
        </div>
        <div style="display:flex;justify-content:center;gap:12px;flex-wrap:wrap;margin-top:6px;">
          <button type="button" data-lobby-auth-register-button="1" style="height:46px;min-width:150px;border:0;border-radius:8px;background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;font-size:15px;font-weight:900;cursor:pointer;">Регистрация</button>
          <button type="button" data-lobby-auth-login-button="1" style="height:46px;min-width:130px;border:1px solid rgba(212,165,32,0.62);border-radius:8px;background:#080808;color:#f8fafc;font-size:15px;font-weight:900;cursor:pointer;">Вход</button>
        </div>
      </div>
    `
    : `
      <form data-lobby-auth-form="${isLogin ? 'login' : 'register'}" style="display:grid;gap:12px;">
        <div style="font-size:25px;line-height:1.1;font-weight:900;color:#f8fafc;text-align:center;">
          ${isLogin ? 'Вход в профила' : 'Създай профил'}
        </div>
        ${isRegister ? `
          <label style="display:grid;gap:6px;font-size:12px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#d4a520;">
            Име в играта
            <span style="position:relative;display:block;">
              <input name="displayName" autocomplete="nickname" data-name-check-input="register" style="width:100%;box-sizing:border-box;height:42px;border-radius:8px;border:1px solid rgba(212,165,32,0.34);background:#050505;color:#ffffff;padding:0 90px 0 12px;font-size:15px;font-weight:700;outline:none;">
              <span data-name-hint="register" style="position:absolute;right:10px;top:50%;transform:translateY(-50%);max-width:68%;overflow:hidden;text-overflow:ellipsis;font-size:11px;font-weight:800;letter-spacing:0;text-transform:none;pointer-events:none;white-space:nowrap;"></span>
            </span>
            <span style="font-size:11px;font-weight:400;letter-spacing:0;text-transform:none;color:#ffffff;">Мин. 3 символа. Букви на кирилица или латиница, цифри и по един интервал между думите.</span>
          </label>
          <div style="display:grid;gap:6px;">
            <div style="font-size:12px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#d4a520;">Пол</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
              <label style="cursor:pointer;">
                <input type="radio" name="gender" value="male" style="display:none;" class="belot-gender-radio">
                <div data-gender-option="male" style="display:flex;align-items:center;gap:8px;height:42px;border-radius:8px;border:1px solid rgba(212,165,32,0.34);background:#050505;padding:0 14px;font-size:14px;font-weight:700;color:rgba(255,255,255,0.72);transition:border-color 0.15s,background 0.15s;">
                  <span style="font-size:18px;">♂</span> Мъж
                </div>
              </label>
              <label style="cursor:pointer;">
                <input type="radio" name="gender" value="female" style="display:none;" class="belot-gender-radio">
                <div data-gender-option="female" style="display:flex;align-items:center;gap:8px;height:42px;border-radius:8px;border:1px solid rgba(212,165,32,0.34);background:#050505;padding:0 14px;font-size:14px;font-weight:700;color:rgba(255,255,255,0.72);transition:border-color 0.15s,background 0.15s;">
                  <span style="font-size:18px;">♀</span> Жена
                </div>
              </label>
            </div>
          </div>
        ` : ''}
        <label style="display:grid;gap:6px;font-size:12px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#d4a520;">
          Email
          <input name="email" type="email" autocomplete="email" placeholder="Реален e-mail" style="height:42px;border-radius:8px;border:1px solid rgba(212,165,32,0.34);background:#050505;color:#ffffff;padding:0 12px;font-size:15px;font-weight:700;outline:none;" placeholder-color="rgba(255,255,255,0.35)">
        </label>
        <label style="display:grid;gap:6px;font-size:12px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#d4a520;">
          <span style="display:flex;align-items:baseline;gap:6px;">
            Парола
            ${isRegister ? `<span style="font-size:11px;font-weight:400;letter-spacing:0;text-transform:none;color:#ffffff;">Мин. 6 символа</span>` : ''}
          </span>
          <span style="position:relative;display:block;">
            <input name="password" type="password" autocomplete="${isLogin ? 'current-password' : 'new-password'}" style="width:100%;box-sizing:border-box;height:42px;border-radius:8px;border:1px solid rgba(212,165,32,0.34);background:#050505;color:#ffffff;padding:0 44px 0 12px;font-size:15px;font-weight:700;outline:none;">
            <button type="button" data-toggle-password="password" style="position:absolute;right:10px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;color:rgba(255,255,255,0.4);padding:4px;display:flex;align-items:center;justify-content:center;">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            </button>
          </span>
        </label>
        ${isRegister ? `
        <label style="display:grid;gap:6px;font-size:12px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#d4a520;">
          Повтори паролата
          <span style="position:relative;display:block;">
            <input name="confirmPassword" type="password" autocomplete="new-password" style="width:100%;box-sizing:border-box;height:42px;border-radius:8px;border:1px solid rgba(212,165,32,0.34);background:#050505;color:#ffffff;padding:0 44px 0 12px;font-size:15px;font-weight:700;outline:none;">
            <button type="button" data-toggle-password="confirmPassword" style="position:absolute;right:10px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;color:rgba(255,255,255,0.4);padding:4px;display:flex;align-items:center;justify-content:center;">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            </button>
          </span>
        </label>
        ` : ''}
        <button type="submit" style="height:46px;border:0;border-radius:8px;background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;font-size:15px;font-weight:900;cursor:pointer;margin-top:4px;">
          ${isLogin ? 'Влез' : 'Регистрирай се'}
        </button>
        ${isLogin ? `
        <button type="button" data-lobby-auth-mode="forgot-password" style="height:28px;border:0;background:transparent;color:rgba(212,165,32,0.72);font-size:12px;font-weight:700;cursor:pointer;text-decoration:underline;text-underline-offset:2px;">
          Забравена парола?
        </button>
        ` : ''}
        <button type="button" data-lobby-auth-mode="${isLogin ? 'register' : 'login'}" style="height:34px;border:0;background:transparent;color:rgba(255,255,255,0.72);font-size:13px;font-weight:800;cursor:pointer;">
          ${isLogin ? 'Нямаш профил? Регистрирай се' : 'Имаш профил? Влез'}
        </button>
      </form>
    `

  return `
    <div data-lobby-auth-modal-root="1" style="position:fixed;inset:0;z-index:13000;display:flex;align-items:center;justify-content:center;padding:24px;">
      <div data-lobby-auth-modal-backdrop="1" style="position:absolute;inset:0;background:rgba(0,0,0,0.45);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);"></div>
      <div role="dialog" aria-modal="true" style="position:relative;width:min(92vw,480px);border-radius:8px;border:2px solid rgba(212,165,32,0.72);background:linear-gradient(180deg,rgba(32,32,32,0.98) 0%,rgba(8,8,8,0.99) 100%);box-shadow:0 34px 80px rgba(0,0,0,0.48);padding:24px;">
        <button type="button" data-lobby-auth-modal-close="1" aria-label="Затвори" style="position:absolute;right:4px;top:4px;width:36px;height:36px;border:0;border-radius:999px;background:rgba(255,255,255,0.08);color:#ffffff;font-size:22px;font-weight:900;cursor:pointer;">×</button>
        <div style="display:grid;gap:14px;">
          ${body}
          <div data-lobby-auth-error="1" style="border-radius:8px;border:1px solid rgba(248,113,113,0.28);background:rgba(127,29,29,0.42);padding:10px 12px;color:#fecaca;font-size:13px;font-weight:800;text-align:center;${state.authErrorText ? '' : 'display:none;'}">${state.authErrorText ? escapeHtml(state.authErrorText) : ''}</div>
        </div>
      </div>
    </div>
  `
}

function renderProfileEditModal(state: LobbyScreenState): string {
  if (!state.profileEditorOpen) {
    return ''
  }
  if (state.profileEditorTargetProfileId !== null && !state.isAdmin) {
    return ''
  }
  if (state.profileEditorTargetProfileId !== null && state.profileEditorTargetProfile === null) {
    return ''
  }

  const isAdminTargetEdit = state.profileEditorTargetProfileId !== null && state.isAdmin
  const editorProfile = isAdminTargetEdit
    ? (state.profileEditorTargetProfile ?? state.profile)
    : state.profile
  const galleryImages = [...editorProfile.galleryImages].sort(
    (left, right) => left.sortOrder - right.sortOrder,
  )
  const gallerySlotsLeft = Math.max(
    0,
    isAdminTargetEdit ? 0 : MAX_PROFILE_GALLERY_IMAGES - galleryImages.length,
  )
  const nameChangePrice = state.profileNameChangePrice
  const isPhoneLayout = isPhoneLayoutViewport()
  const nameChangeCardStyle = isPhoneLayout
    ? 'display:grid;gap:6px;border:1px solid rgba(212,165,32,0.22);border-radius:8px;background:rgba(255,255,255,0.035);padding:8px;'
    : 'display:grid;gap:8px;border:1px solid rgba(212,165,32,0.22);border-radius:8px;background:rgba(255,255,255,0.035);padding:12px;'
  const nameChangeHeaderStyle = isPhoneLayout
    ? 'display:flex;align-items:center;justify-content:space-between;gap:6px;flex-wrap:wrap;'
    : 'display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;'
  const nameChangeInputStyle = `width:100%;box-sizing:border-box;height:${isPhoneLayout ? '36px' : '42px'};border-radius:8px;border:1px solid ${state.profileNameChangeErrorText ? 'rgba(248,113,113,0.60)' : 'rgba(212,165,32,0.34)'};background:#050505;color:#ffffff;padding:0 90px 0 12px;font-size:${isPhoneLayout ? '14px' : '15px'};font-weight:700;outline:none;`
  const nameChangeHelpStyle = isPhoneLayout
    ? 'font-size:10px;font-weight:400;line-height:1.2;color:#ffffff;'
    : 'font-size:11px;font-weight:400;color:#ffffff;'
  const nameChangeButtonWrapStyle = isPhoneLayout
    ? 'display:flex;justify-content:flex-end;margin-top:2px;'
    : 'display:flex;justify-content:flex-end;'
  const nameChangeButtonStyle = isPhoneLayout
    ? 'height:34px;padding:0 12px;border:1px solid rgba(212,165,32,0.58);border-radius:8px;background:#080808;color:#f8fafc;font-size:12px;font-weight:900;cursor:pointer;'
    : 'height:38px;padding:0 14px;border:1px solid rgba(212,165,32,0.58);border-radius:8px;background:#080808;color:#f8fafc;font-size:13px;font-weight:900;cursor:pointer;'

  return `
    <div data-lobby-profile-editor-root="1" style="position:fixed;inset:0;z-index:13500;display:flex;align-items:center;justify-content:center;padding:24px;">
      <div data-lobby-profile-editor-backdrop="1" style="position:absolute;inset:0;background:rgba(0,0,0,0.76);-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);"></div>
      <div role="dialog" aria-modal="true" class="gold-scrollbar" style="position:relative;width:min(92vw,560px);max-height:90vh;overflow-y:auto;border-radius:8px;border:2px solid rgba(212,165,32,0.72);background:linear-gradient(180deg,rgba(32,32,32,0.98) 0%,rgba(8,8,8,0.99) 100%);box-shadow:0 34px 80px rgba(0,0,0,0.48);padding:24px;">
        <button type="button" data-lobby-profile-editor-close="1" aria-label="Затвори" style="position:absolute;right:12px;top:10px;width:36px;height:36px;border:0;border-radius:999px;background:rgba(255,255,255,0.08);color:#ffffff;font-size:22px;font-weight:900;cursor:pointer;">×</button>
        <form data-lobby-profile-editor-form="1" style="display:grid;gap:16px;">
          <div style="font-size:25px;line-height:1.1;font-weight:900;color:#f8fafc;">Редакция на профил</div>

          <div style="display:grid;grid-template-columns:1fr auto;align-items:end;gap:10px;">
            <label style="display:grid;gap:6px;font-size:12px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#d4a520;">
              Ime в играта
              <input value="${escapeHtml(editorProfile.displayName)}" disabled style="height:42px;border-radius:8px;border:1px solid rgba(255,255,255,0.10);background:#101010;color:rgba(255,255,255,0.58);padding:0 12px;font-size:15px;font-weight:700;outline:none;width:100%;box-sizing:border-box;">
            </label>
            ${isAdminTargetEdit ? '' : `<button
              type="button"
              data-change-password-open="1"
              style="height:42px;padding:0 14px;white-space:nowrap;border:1px solid rgba(212,165,32,0.58);border-radius:8px;background:#080808;color:#f8fafc;font-size:13px;font-weight:900;cursor:pointer;flex-shrink:0;"
            >Смяна на парола</button>`}
          </div>
          ${!isAdminTargetEdit && state.profileNameChangeSuccessAmount !== null ? `
            <div style="font-size:13px;font-weight:800;color:#4ade80;">
              Успешно сменихте името на профила.
              <span data-name-change-cost="1" style="color:#4ade80;">-0</span> жълтици
            </div>
          ` : ''}

          <div style="${nameChangeCardStyle}">
            <div style="${nameChangeHeaderStyle}">
              <div style="font-size:12px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#d4a520;">Смяна на име</div>
              ${isAdminTargetEdit ? '' : `<div style="font-size:12px;font-weight:800;color:rgba(255,255,255,0.62);">
                <strong style="color:#d4a520;">${formatAmount(nameChangePrice)}</strong> жълтици
              </div>`}
            </div>
            <label style="display:grid;gap:6px;">
              <span style="position:relative;display:block;">
                <input name="paidDisplayName" autocomplete="nickname" placeholder="Въведи ново име" value="${isAdminTargetEdit ? escapeHtml(editorProfile.displayName) : ''}" data-name-check-input="namechange" style="${nameChangeInputStyle}">
                <span data-name-hint="namechange" style="position:absolute;right:10px;top:50%;transform:translateY(-50%);max-width:68%;overflow:hidden;text-overflow:ellipsis;font-size:11px;font-weight:800;pointer-events:none;white-space:nowrap;"></span>
              </span>
              <span style="${nameChangeHelpStyle}">Мин. 3 символа. Букви на кирилица или латиница, цифри и по един интервал между думите.</span>
            </label>
            ${state.profileNameChangeErrorText ? `<div style="border-radius:6px;border:1px solid rgba(248,113,113,0.28);background:rgba(127,29,29,0.42);padding:8px 10px;color:#fecaca;font-size:12px;font-weight:800;">${escapeHtml(state.profileNameChangeErrorText)}</div>` : ''}
            <div style="${nameChangeButtonWrapStyle}">
              <button type="button" data-lobby-profile-name-change-submit="1" style="${nameChangeButtonStyle}">
                Смени име
              </button>
            </div>
          </div>

          <div style="display:grid;gap:8px;">
            <div style="font-size:12px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#d4a520;">Аватар</div>
            <div style="display:flex;align-items:center;gap:16px;">
              <div
                data-avatar-preview="1"
                style="width:80px;height:80px;border-radius:8px;border:1px solid rgba(212,165,32,0.35);background:#101010;flex:0 0 auto;overflow:hidden;display:flex;align-items:center;justify-content:center;color:#facc15;font-size:28px;font-weight:900;position:relative;"
              >
                ${editorProfile.avatarUrl
                  ? `<img src="${escapeHtml(editorProfile.avatarUrl)}" alt="" style="width:100%;height:100%;object-fit:cover;display:block;">`
                  : `<span style="opacity:0.4;">?</span>`}
              </div>
              <input name="avatarFile" type="file" accept="image/png,image/jpeg,image/webp" style="display:none;">
              <div style="display:flex;flex-direction:column;gap:8px;flex:1;">
                <button
                  type="button"
                  data-avatar-from-device-btn="1"
                  class="avatar-source-btn"
                  style="height:38px;padding:0 14px;border:1px solid rgba(212,165,32,0.50);border-radius:8px;background:#101010;color:#f8fafc;font-size:13px;font-weight:900;cursor:pointer;text-align:left;"
                >
                  От устройството
                </button>
                <button
                  type="button"
                  data-avatar-preset-btn="1"
                  class="avatar-source-btn"
                  style="height:38px;padding:0 14px;border:1px solid rgba(212,165,32,0.50);border-radius:8px;background:#101010;color:#f8fafc;font-size:13px;font-weight:900;cursor:pointer;text-align:left;"
                >
                  Наши предложения
                </button>
              </div>
            </div>
          </div>

          <div style="display:grid;gap:8px;">
            <div style="font-size:12px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#d4a520;">Галерия</div>
            <div data-gallery-grid="1" style="display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:8px;">
              ${galleryImages.map((image) => `
                <div style="position:relative;aspect-ratio:1/1;border-radius:8px;overflow:hidden;border:1px solid rgba(255,255,255,0.10);background:#101010;">
                  <img src="${escapeHtml(image.imageUrl)}" alt="" style="width:100%;height:100%;object-fit:cover;display:block;">
                  <button
                    type="button"
                    data-lobby-gallery-delete="${escapeHtml(image.imageId)}"
                    aria-label="Изтрий снимката"
                    style="position:absolute;top:4px;right:4px;width:26px;height:26px;border:1px solid rgba(248,113,113,0.56);border-radius:999px;background:rgba(12,12,12,0.86);color:#fecaca;font-size:16px;font-weight:900;line-height:1;cursor:pointer;"
                  >×</button>
                </div>
              `).join('')}
              ${isAdminTargetEdit ? '' : Array.from({ length: gallerySlotsLeft }, () => `
                <div
                  data-gallery-add-slot="1"
                  role="button"
                  tabindex="0"
                  style="aspect-ratio:1/1;border-radius:8px;border:2px dashed rgba(255,255,255,0.20);background:#101010;display:flex;align-items:center;justify-content:center;cursor:pointer;"
                >
                  <span style="color:rgba(255,255,255,0.40);font-size:28px;font-weight:300;line-height:1;">+</span>
                </div>
              `).join('')}
            </div>
            <input data-gallery-file-input="1" type="file" accept="image/png,image/jpeg,image/webp" style="display:none;">
          </div>

          ${state.profileEditorErrorText ? `<div style="border-radius:8px;border:1px solid rgba(248,113,113,0.28);background:rgba(127,29,29,0.42);padding:10px 12px;color:#fecaca;font-size:13px;font-weight:800;text-align:center;">${escapeHtml(state.profileEditorErrorText)}</div>` : ''}

          <div style="display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap;">
            <button type="button" data-lobby-profile-editor-cancel="1" style="height:42px;padding:0 16px;border:1px solid rgba(255,255,255,0.14);border-radius:8px;background:#080808;color:#f8fafc;font-size:14px;font-weight:900;cursor:pointer;">Откажи</button>
            <button type="submit" style="height:42px;padding:0 18px;border:0;border-radius:8px;background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;font-size:14px;font-weight:900;cursor:pointer;">Запази</button>
          </div>
        </form>
      </div>
    </div>
  `
}

function renderPasswordField(name: string, label: string): string {
  return `
    <label style="display:grid;gap:6px;font-size:12px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#d4a520;">
      ${label}
      <span style="position:relative;display:block;">
        <input
          type="password"
          name="${name}"
          autocomplete="${name === 'currentPassword' ? 'current-password' : 'new-password'}"
          style="width:100%;box-sizing:border-box;height:42px;border-radius:8px;border:1px solid rgba(212,165,32,0.34);background:#050505;color:#ffffff;padding:0 44px 0 12px;font-size:15px;outline:none;"
        >
        <button
          type="button"
          data-toggle-password="${name}"
          style="position:absolute;right:10px;top:50%;transform:translateY(-50%);border:0;background:none;padding:4px;cursor:pointer;color:rgba(255,255,255,0.4);line-height:1;"
          aria-label="Покажи/скрий парола"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
            <circle cx="12" cy="12" r="3"/>
          </svg>
        </button>
      </span>
    </label>
  `
}

function renderChangePasswordModal(state: LobbyScreenState): string {
  if (!state.changePasswordPopupOpen) {
    return ''
  }

  return `
    <div data-change-password-modal-root="1" style="position:fixed;inset:0;z-index:14000;display:flex;align-items:center;justify-content:center;padding:24px;">
      <div data-change-password-backdrop="1" style="position:absolute;inset:0;background:rgba(0,0,0,0.72);-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);"></div>
      <div role="dialog" aria-modal="true" style="position:relative;width:min(92vw,400px);border-radius:12px;border:2px solid rgba(212,165,32,0.65);background:linear-gradient(180deg,rgba(32,32,32,0.99) 0%,rgba(8,8,8,0.99) 100%);box-shadow:0 34px 80px rgba(0,0,0,0.52);padding:24px;">
        <button type="button" data-change-password-close="1" aria-label="Затвори" style="position:absolute;right:12px;top:10px;width:36px;height:36px;border:0;border-radius:999px;background:rgba(255,255,255,0.08);color:#ffffff;font-size:22px;font-weight:900;cursor:pointer;">×</button>
        <div style="font-size:20px;font-weight:900;color:#f8fafc;margin-bottom:18px;">Смяна на парола</div>
        <form data-change-password-form="1" style="display:grid;gap:14px;">
          ${renderPasswordField('currentPassword', 'Текуща парола')}
          ${renderPasswordField('newPassword', 'Нова парола')}
          ${renderPasswordField('confirmPassword', 'Повтори новата парола')}
          ${state.changePasswordErrorText ? `<div style="border-radius:6px;border:1px solid rgba(248,113,113,0.28);background:rgba(127,29,29,0.42);padding:8px 10px;color:#fecaca;font-size:13px;font-weight:800;">${escapeHtml(state.changePasswordErrorText)}</div>` : ''}
          <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:4px;">
            <button type="button" data-change-password-close="1" style="height:40px;padding:0 16px;border:1px solid rgba(255,255,255,0.14);border-radius:8px;background:#080808;color:#f8fafc;font-size:14px;font-weight:900;cursor:pointer;">Откажи</button>
            <button type="submit" style="height:40px;padding:0 18px;border:0;border-radius:8px;background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;font-size:14px;font-weight:900;cursor:pointer;">Смени</button>
          </div>
        </form>
      </div>
    </div>
  `
}

function renderLowCoinsModal(state: LobbyScreenState): string {
  if (!state.lowCoinsModalOpen) {
    return ''
  }

  return `
    <div data-lobby-low-coins-modal-root="1" style="position:fixed;inset:0;z-index:13700;display:flex;align-items:center;justify-content:center;padding:24px;">
      <div data-lobby-low-coins-backdrop="1" style="position:absolute;inset:0;background:rgba(0,0,0,0.80);-webkit-backdrop-filter:blur(5px);backdrop-filter:blur(5px);"></div>
      <div role="dialog" aria-modal="true" style="position:relative;width:min(92vw,460px);border-radius:12px;border:2px solid rgba(212,165,32,0.65);background:linear-gradient(180deg,rgba(28,28,28,0.99) 0%,rgba(8,8,8,0.99) 100%);box-shadow:0 40px 90px rgba(0,0,0,0.55);padding:32px 28px 26px;">
        <button type="button" data-lobby-low-coins-close="1" aria-label="Затвори" style="position:absolute;right:12px;top:10px;width:36px;height:36px;border:0;border-radius:999px;background:rgba(255,255,255,0.08);color:#ffffff;font-size:22px;font-weight:900;cursor:pointer;">×</button>
        <div style="text-align:center;margin-bottom:16px;"><img src="/assets/lobby/coins-popup.png" alt="" style="width:80px;height:80px;object-fit:contain;display:inline-block;"></div>
        <div style="font-size:22px;font-weight:900;color:#f8fafc;text-align:center;line-height:1.2;">Нямаш достатъчно жълтици за тази стая</div>
        <div style="margin-top:14px;font-size:15px;line-height:1.6;color:rgba(255,255,255,0.65);font-weight:500;text-align:center;">
          Купи жълтици и се върни да им покажеш колко си добър.
        </div>
        <div style="display:flex;flex-direction:column;gap:10px;margin-top:24px;">
          <button type="button" data-lobby-low-coins-shop="1" style="height:48px;border:0;border-radius:10px;background:linear-gradient(135deg,#f4c95b 0%,#c98f13 100%);color:#080808;font-size:15px;font-weight:900;cursor:pointer;letter-spacing:0.02em;">
            Купи жълтици
          </button>
          <button type="button" data-lobby-low-coins-close="1" style="height:44px;border:1px solid rgba(255,255,255,0.14);border-radius:10px;background:transparent;color:rgba(255,255,255,0.65);font-size:14px;font-weight:800;cursor:pointer;">
            Затвори
          </button>
        </div>
      </div>
    </div>
  `
}

function renderGiftCoinsModal(state: LobbyScreenState): string {
  if (state.giftModalFriendshipId === null) {
    return ''
  }

  return `
    <div data-lobby-gift-modal-root="1" style="position:fixed;inset:0;z-index:13600;display:flex;align-items:center;justify-content:center;padding:24px;">
      <div data-lobby-gift-modal-backdrop="1" style="position:absolute;inset:0;background:rgba(0,0,0,0.76);-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);"></div>
      <div role="dialog" aria-modal="true" style="position:relative;width:min(92vw,430px);border-radius:8px;border:2px solid rgba(212,165,32,0.72);background:linear-gradient(180deg,rgba(32,32,32,0.98) 0%,rgba(8,8,8,0.99) 100%);box-shadow:0 34px 80px rgba(0,0,0,0.48);padding:24px;">
        <button type="button" data-lobby-gift-modal-close="1" aria-label="Затвори" style="position:absolute;right:12px;top:10px;width:36px;height:36px;border:0;border-radius:999px;background:rgba(255,255,255,0.08);color:#ffffff;font-size:22px;font-weight:900;cursor:pointer;">×</button>
        <form data-lobby-gift-form="${escapeHtml(state.giftModalFriendshipId)}" style="display:grid;gap:14px;">
          <div>
            <div style="font-size:24px;line-height:1.1;font-weight:900;color:#f8fafc;">Подари жълтици</div>
            <div style="margin-top:7px;font-size:13px;line-height:1.45;color:rgba(255,255,255,0.62);font-weight:700;">Към ${escapeHtml(state.giftModalFriendName || 'приятел')}. Сумата трябва да е между 1 000 и 30 000 жълтици.</div>
          </div>
          <label style="display:grid;gap:6px;font-size:12px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#d4a520;">
            Сума
            <input name="amount" type="number" min="1000" max="30000" step="1000" value="1000" style="height:42px;border-radius:8px;border:1px solid rgba(212,165,32,0.34);background:#050505;color:#ffffff;padding:0 12px;font-size:15px;font-weight:800;outline:none;">
          </label>
          ${state.giftModalErrorText ? `<div style="border-radius:8px;border:1px solid rgba(248,113,113,0.28);background:rgba(127,29,29,0.42);padding:10px 12px;color:#fecaca;font-size:13px;font-weight:800;text-align:center;">${escapeHtml(state.giftModalErrorText)}</div>` : ''}
          <div style="display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap;">
            <button type="button" data-lobby-gift-modal-cancel="1" style="height:42px;padding:0 16px;border:1px solid rgba(255,255,255,0.14);border-radius:8px;background:#080808;color:#f8fafc;font-size:14px;font-weight:900;cursor:pointer;">Откажи</button>
            <button type="submit" style="height:42px;padding:0 18px;border:0;border-radius:8px;background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;font-size:14px;font-weight:900;cursor:pointer;">Изпрати</button>
          </div>
        </form>
      </div>
    </div>
  `
}

function renderGiftSuccessModal(state: LobbyScreenState): string {
  if (!state.giftSuccessModal) return ''
  const { amount, friendName } = state.giftSuccessModal
  return `
    <div data-lobby-gift-success-root="1" style="position:fixed;inset:0;z-index:13600;display:flex;align-items:center;justify-content:center;padding:24px;">
      <div style="position:absolute;inset:0;background:rgba(0,0,0,0.76);-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);"></div>
      <div role="dialog" aria-modal="true" style="position:relative;width:min(92vw,400px);border-radius:12px;border:2px solid rgba(212,165,32,0.72);background:linear-gradient(180deg,rgba(32,32,32,0.98) 0%,rgba(8,8,8,0.99) 100%);box-shadow:0 34px 80px rgba(0,0,0,0.48);padding:32px 28px;display:flex;flex-direction:column;align-items:center;gap:18px;text-align:center;">
        <div style="width:56px;height:56px;border-radius:999px;background:linear-gradient(180deg,rgba(212,165,32,0.18) 0%,rgba(212,165,32,0.08) 100%);border:2px solid rgba(212,165,32,0.50);display:flex;align-items:center;justify-content:center;font-size:28px;">🪙</div>
        <div>
          <div style="font-size:20px;font-weight:900;color:#f8fafc;line-height:1.2;">Подарихте ${escapeHtml(String(amount.toLocaleString('bg-BG')))} жълтици</div>
          <div style="margin-top:8px;font-size:14px;font-weight:700;color:rgba(255,255,255,0.62);">на ${escapeHtml(friendName)}</div>
        </div>
        <button
          type="button"
          data-lobby-gift-success-ok="1"
          style="
            width:100%;
            height:44px;
            border:0;
            border-radius:8px;
            background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);
            color:#080808;
            font-size:15px;
            font-weight:900;
            cursor:pointer;
          "
        >OK</button>
      </div>
    </div>
  `
}

function renderGiftReceivedModal(state: LobbyScreenState): string {
  if (!state.giftReceivedModal) return ''
  const { amount, fromDisplayName } = state.giftReceivedModal
  return `
    <div data-lobby-gift-received-root="1" style="position:fixed;inset:0;z-index:13600;display:flex;align-items:center;justify-content:center;padding:24px;">
      <div style="position:absolute;inset:0;background:rgba(0,0,0,0.76);-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);"></div>
      <div role="dialog" aria-modal="true" style="position:relative;width:min(92vw,400px);border-radius:12px;border:2px solid rgba(212,165,32,0.72);background:linear-gradient(180deg,rgba(32,32,32,0.98) 0%,rgba(8,8,8,0.99) 100%);box-shadow:0 34px 80px rgba(0,0,0,0.48);padding:32px 28px;display:flex;flex-direction:column;align-items:center;gap:18px;text-align:center;">
        <div style="width:56px;height:56px;border-radius:999px;background:linear-gradient(180deg,rgba(212,165,32,0.18) 0%,rgba(212,165,32,0.08) 100%);border:2px solid rgba(212,165,32,0.50);display:flex;align-items:center;justify-content:center;font-size:28px;">🎁</div>
        <div>
          <div style="font-size:20px;font-weight:900;color:#f8fafc;line-height:1.2;">${escapeHtml(fromDisplayName)} ви подари</div>
          <div style="margin-top:8px;font-size:14px;font-weight:700;color:rgba(255,255,255,0.62);">${escapeHtml(String(amount.toLocaleString('bg-BG')))} жълтици</div>
        </div>
        <button
          type="button"
          data-lobby-gift-received-ok="1"
          style="
            width:100%;
            height:44px;
            border:0;
            border-radius:8px;
            background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);
            color:#080808;
            font-size:15px;
            font-weight:900;
            cursor:pointer;
          "
        >OK</button>
      </div>
    </div>
  `
}

function renderNav(state: LobbyScreenState): string {
  const activeView = state.view
  const playersActive = activeView === 'players'
  const friendsActive = activeView === 'friends'
  const chatActive = activeView === 'chat'
  const leaderboardsActive = activeView === 'leaderboards'
  const shopActive = activeView === 'shop'
  const adminActive = activeView === 'admin' || activeView === 'admin-info' || activeView === 'admin-server' || activeView === 'guest-contact-messages'
  const lobbyActive = activeView === 'tables'
  const mailUnreadCount = state.supportUnreadCount + (state.isAdmin ? state.adminGuestContactUnreadCount : 0)
  const notificationsBadgeCount = getNotificationsBadgeCount(state)
  const incomingFriendRequestsCount =
    state.friendships?.incomingPending.length ?? 0

  return `
    <style>
      .lobby-nav-btn:not([data-active]):hover {
        border-bottom-color: rgba(212,165,32,0.50) !important;
        color: rgba(255,255,255,0.95) !important;
        background: rgba(212,165,32,0.04) !important;
      }
    </style>
    <nav style="
      background: #0a0a0a;
      border-bottom: 1px solid rgba(255,255,255,0.10);
      max-width: 1640px;
      margin: 0 auto;
      box-sizing: border-box;
      padding: 0 5px;
      display: flex;
      align-items: center;
      gap: 0;
      height: 72px;
      position: sticky;
      top: 0;
      z-index: 100;
    ">
      <a href="/lobby" data-lobby-nav-lobby="1" style="display:flex; align-items:center; gap:8px; text-decoration:none; margin-right:16px;">
        <img src="/assets/lobby/logo.png" alt="Pika.bg" style="width:192px; height:52px; display:block; object-fit:contain;">
      </a>

      <div style="display:flex; align-items:stretch; gap:0; height:100%; flex:1;">
        <a href="/lobby" data-lobby-nav-lobby="1" ${lobbyActive ? 'data-active="1"' : ''} class="lobby-nav-btn" style="
          display:flex; align-items:center; gap:10px;
          padding:0 18px;
          text-decoration:none;
          font-size:13px; font-weight:700; letter-spacing:0.04em; text-transform:uppercase;
          color:${lobbyActive ? '#d4a520' : 'rgba(255,255,255,0.70)'};
          border-bottom:2px solid ${lobbyActive ? '#d4a520' : 'transparent'};
          background:${lobbyActive ? 'rgba(212,165,32,0.06)' : 'transparent'};
        ">
          <svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;">
            <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
            <polyline points="9 22 9 12 15 12 15 22"/>
          </svg>
          Лоби
        </a>
        <button type="button" data-lobby-nav-shop="1" ${shopActive ? 'data-active="1"' : ''} class="lobby-nav-btn" style="
          display:flex; align-items:center; gap:10px;
          padding:0 18px;
          border:0;
          background:${shopActive ? 'rgba(212,165,32,0.06)' : 'transparent'};
          font-size:13px; font-weight:700; letter-spacing:0.04em; text-transform:uppercase;
          color:${shopActive ? '#d4a520' : 'rgba(255,255,255,0.70)'};
          border-bottom:2px solid ${shopActive ? '#d4a520' : 'transparent'};
          cursor:pointer;
          height:100%;
        ">
          <svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;">
            <circle cx="9" cy="21" r="1"/>
            <circle cx="20" cy="21" r="1"/>
            <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>
          </svg>
          Магазин
        </button>
        <button type="button" data-lobby-nav-friends="1" ${friendsActive ? 'data-active="1"' : ''} class="lobby-nav-btn" style="
          display:flex; align-items:center; gap:10px;
          padding:0 18px;
          border:0;
          background:${friendsActive ? 'rgba(212,165,32,0.06)' : 'transparent'};
          font-size:13px; font-weight:700; letter-spacing:0.04em; text-transform:uppercase;
          color:${friendsActive ? '#d4a520' : 'rgba(255,255,255,0.70)'};
          border-bottom:2px solid ${friendsActive ? '#d4a520' : 'transparent'};
          cursor:pointer;
          height:100%;
        ">
          <svg xmlns="http://www.w3.org/2000/svg" width="26" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;">
            <path d="m11 17 2 2a1 1 0 1 0 3-3"/>
            <path d="m14 14 2.5 2.5a1 1 0 1 0 3-3l-3.88-3.88a3 3 0 0 0-4.24 0l-.88.88a1 1 0 1 1-3-3l2.81-2.81a5.79 5.79 0 0 1 7.06-.87l.47.28a2 2 0 0 0 1.42.25L21 4"/>
            <path d="m21 3 1 11h-1"/>
            <path d="M3 3 2 14l6.5 6.5a1 1 0 1 0 3-3"/>
            <path d="M3 4h8"/>
          </svg>
          Приятели
          ${incomingFriendRequestsCount > 0 ? `
            <span style="min-width:20px;height:20px;border-radius:999px;background:#d4a520;color:#080808;display:inline-flex;align-items:center;justify-content:center;padding:0 6px;font-size:11px;font-weight:900;line-height:1;">
              ${formatAmount(incomingFriendRequestsCount)}
            </span>
          ` : ''}
        </button>
        <button type="button" data-lobby-nav-blocked-players="1" class="lobby-nav-btn" style="
          display:flex; align-items:center; gap:10px;
          padding:0 18px;
          border:0;
          background:transparent;
          font-size:13px; font-weight:700; letter-spacing:0.04em; text-transform:uppercase;
          color:rgba(255,255,255,0.70);
          border-bottom:2px solid transparent;
          cursor:pointer;
          height:100%;
        ">
          <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;">
            <circle cx="12" cy="12" r="10"/>
            <line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>
          </svg>
          Блокирани
        </button>
        <a href="/ranking" data-lobby-nav-leaderboards="1" ${leaderboardsActive ? 'data-active="1"' : ''} class="lobby-nav-btn" style="
          display:flex; align-items:center; gap:10px;
          padding:0 18px;
          background:${leaderboardsActive ? 'rgba(212,165,32,0.06)' : 'transparent'};
          font-size:13px; font-weight:700; letter-spacing:0.04em; text-transform:uppercase;
          color:${leaderboardsActive ? '#d4a520' : 'rgba(255,255,255,0.70)'};
          border-bottom:2px solid ${leaderboardsActive ? '#d4a520' : 'transparent'};
          text-decoration:none; height:100%;
        ">
          <svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;">
            <line x1="18" y1="20" x2="18" y2="10"/>
            <line x1="12" y1="20" x2="12" y2="4"/>
            <line x1="6" y1="20" x2="6" y2="14"/>
          </svg>
          Класация
        </a>
        <a href="/players" data-lobby-nav-players="1" ${playersActive ? 'data-active="1"' : ''} class="lobby-nav-btn" style="
          display:flex; align-items:center; gap:10px;
          padding:0 18px;
          background:${playersActive ? 'rgba(212,165,32,0.06)' : 'transparent'};
          font-size:13px; font-weight:700; letter-spacing:0.04em; text-transform:uppercase;
          color:${playersActive ? '#d4a520' : 'rgba(255,255,255,0.70)'};
          border-bottom:2px solid ${playersActive ? '#d4a520' : 'transparent'};
          text-decoration:none; height:100%;
        ">
          <svg xmlns="http://www.w3.org/2000/svg" width="26" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
            <circle cx="9" cy="7" r="4"/>
            <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
            <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
          </svg>
          Играчи
        </a>
        ${state.profile.profileId !== null ? `
          <button type="button" data-lobby-nav-chat="1" ${chatActive ? 'data-active="1"' : ''} class="lobby-nav-btn" style="
            display:flex; align-items:center; gap:10px;
            padding:0 18px;
            border:0;
            background:${chatActive ? 'rgba(212,165,32,0.06)' : 'transparent'};
            font-size:13px; font-weight:700; letter-spacing:0.04em; text-transform:uppercase;
            color:${chatActive ? '#d4a520' : 'rgba(255,255,255,0.70)'};
            border-bottom:2px solid ${chatActive ? '#d4a520' : 'transparent'};
            cursor:pointer;
            height:100%;
          ">
            <span style="position:relative;display:flex;align-items:center;flex-shrink:0;">
              <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
              ${(() => { const unread = state.chatConversations.filter(c => c.unreadCount > 0).length; return unread > 0 ? `<span style="position:absolute;top:-6px;right:-8px;min-width:16px;height:16px;border-radius:8px;background:#ef4444;color:#fff;font-size:10px;font-weight:900;display:flex;align-items:center;justify-content:center;padding:0 3px;line-height:1;">${unread}</span>` : '' })()}
            </span>
            Чат
          </button>
        ` : ''}
      </div>

      <div style="display:flex; align-items:center; gap:4px; margin-left:auto;">
        ${state.profile.profileId !== null ? `
          ${state.isAdmin ? `
            <div style="position:relative; height:100%; display:flex; align-items:center;" data-admin-dropdown-wrap="1">
              <button type="button" data-lobby-nav-admin-toggle="1" class="lobby-nav-btn" style="
                display:flex; align-items:center; gap:8px;
                background:${adminActive ? 'rgba(212,165,32,0.06)' : 'none'};
                border:0;
                padding:0 14px;
                cursor:pointer;
                font-size:13px; font-weight:700; letter-spacing:0.04em; text-transform:uppercase;
                color:${adminActive ? '#d4a520' : 'rgba(255,255,255,0.70)'};
                border-bottom:2px solid ${adminActive ? '#d4a520' : 'transparent'};
                height:100%;
              ">
                <span style="font-size:22px;line-height:1;color:currentColor;">⚙</span>
                Админ
                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
              </button>
              <div data-admin-dropdown="1" style="
                display:none;
                position:absolute; top:100%; right:0;
                min-width:180px;
                background:#111111;
                border:1px solid rgba(212,165,32,0.35);
                border-radius:8px;
                box-shadow:0 8px 32px rgba(0,0,0,0.7);
                z-index:999;
                overflow:hidden;
              ">
                <button type="button" data-lobby-nav-admin="1" style="
                  display:flex; align-items:center; gap:10px;
                  width:100%; background:none; border:none;
                  padding:13px 18px; cursor:pointer; text-align:left;
                  font-size:13px; font-weight:700; letter-spacing:0.04em; text-transform:uppercase;
                  color:rgba(255,255,255,0.82);
                  transition:background 0.12s, color 0.12s;
                "
                onmouseenter="this.style.background='rgba(212,165,32,0.09)';this.style.color='#d4a520'"
                onmouseleave="this.style.background='none';this.style.color='rgba(255,255,255,0.82)'"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14"/><path d="M1 12h2M21 12h2M12 1v2M12 21v2"/></svg>
                  Настройки
                </button>
                <button type="button" data-lobby-nav-admin-info="1" style="
                  display:flex; align-items:center; gap:10px;
                  width:100%; background:none; border:none;
                  padding:13px 18px; cursor:pointer; text-align:left;
                  font-size:13px; font-weight:700; letter-spacing:0.04em; text-transform:uppercase;
                  color:rgba(255,255,255,0.82);
                  transition:background 0.12s, color 0.12s;
                "
                onmouseenter="this.style.background='rgba(212,165,32,0.09)';this.style.color='#d4a520'"
                onmouseleave="this.style.background='none';this.style.color='rgba(255,255,255,0.82)'"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>
                  Информация
                </button>
                <button type="button" data-lobby-nav-admin-server="1" style="
                  display:flex; align-items:center; gap:10px;
                  width:100%; background:none; border:none;
                  padding:13px 18px; cursor:pointer; text-align:left;
                  font-size:13px; font-weight:700; letter-spacing:0.04em; text-transform:uppercase;
                  color:rgba(255,255,255,0.82);
                  transition:background 0.12s, color 0.12s;
                "
                onmouseenter="this.style.background='rgba(212,165,32,0.09)';this.style.color='#d4a520'"
                onmouseleave="this.style.background='none';this.style.color='rgba(255,255,255,0.82)'"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>
                  Сървър
                </button>
              </div>
            </div>
          ` : ''}
          <div style="position:relative;display:flex;align-items:center;" data-admin-mail-wrap="1">
            <button data-lobby-nav-support="1" title="Връзка с екипа на Pika.bg" style="
              background:none; border:none; cursor:pointer; padding:6px;
              color:rgba(255,255,255,0.65); position:relative;
            ">
              <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>
              <span data-support-unread-badge="1" style="
                position:absolute; top:2px; right:0px;
                min-width:18px; height:18px; border-radius:9px;
                background:#ef4444; border:1.5px solid #0a0a0a;
                display:${mailUnreadCount > 0 ? 'flex' : 'none'}; align-items:center; justify-content:center;
                font-size:10px; font-weight:800; color:#fff;
                padding:0 4px; box-sizing:border-box;
                font-family:Inter,system-ui,sans-serif;
                pointer-events:none;
              ">${mailUnreadCount > 0 ? mailUnreadCount : ''}</span>
            </button>
            ${state.isAdmin ? `
              <div data-admin-mail-dropdown="1" style="
                display:none;position:absolute;top:100%;right:0;min-width:250px;
                background:#111111;border:1px solid rgba(212,165,32,0.35);
                border-radius:8px;box-shadow:0 8px 32px rgba(0,0,0,0.72);
                z-index:1000;overflow:hidden;
              ">
                <button type="button" data-lobby-nav-support-users="1" style="
                  width:100%;display:flex;align-items:center;justify-content:space-between;gap:14px;
                  border:0;background:none;color:rgba(255,255,255,0.84);padding:13px 14px;
                  cursor:pointer;text-align:left;font-size:13px;font-weight:800;
                " onmouseenter="this.style.background='rgba(212,165,32,0.09)';this.style.color='#d4a520'" onmouseleave="this.style.background='none';this.style.color='rgba(255,255,255,0.84)'">
                  <span>Съобщения от потребители</span>
                  <span style="min-width:22px;height:22px;border-radius:999px;background:${state.supportUnreadCount > 0 ? '#ef4444' : 'rgba(255,255,255,0.10)'};color:#fff;display:inline-flex;align-items:center;justify-content:center;padding:0 7px;font-size:11px;font-weight:900;">${state.supportUnreadCount}</span>
                </button>
                <div style="height:1px;background:rgba(212,165,32,0.18);margin:0 10px;"></div>
                <button type="button" data-lobby-nav-admin-guest-contact="1" style="
                  width:100%;display:flex;align-items:center;justify-content:space-between;gap:14px;
                  border:0;background:none;color:rgba(255,255,255,0.84);padding:13px 14px;
                  cursor:pointer;text-align:left;font-size:13px;font-weight:800;
                " onmouseenter="this.style.background='rgba(212,165,32,0.09)';this.style.color='#d4a520'" onmouseleave="this.style.background='none';this.style.color='rgba(255,255,255,0.84)'">
                  <span>Съобщения от гости</span>
                  <span style="min-width:22px;height:22px;border-radius:999px;background:${state.adminGuestContactUnreadCount > 0 ? '#ef4444' : 'rgba(255,255,255,0.10)'};color:#fff;display:inline-flex;align-items:center;justify-content:center;padding:0 7px;font-size:11px;font-weight:900;">${state.adminGuestContactUnreadCount}</span>
                </button>
              </div>
            ` : ''}
          </div>
          <button data-lobby-nav-bell="1" style="
            background:none; border:none; cursor:pointer; padding:6px;
            color:rgba(255,255,255,0.65); position:relative;
          ">
            <img src="/assets/lobby/nav-icon-preview/nav-notifications-white.png" alt="" style="width:28px; height:31px; display:block; object-fit:contain;">
            ${notificationsBadgeCount > 0 ? `<span style="
              position:absolute; top:2px; right:0px;
              min-width:18px; height:18px; border-radius:9px;
              background:#ef4444; border:1.5px solid #0a0a0a;
              display:flex; align-items:center; justify-content:center;
              font-size:10px; font-weight:800; color:#fff;
              padding:0 4px; box-sizing:border-box;
              font-family:Inter,system-ui,sans-serif;
              pointer-events:none;
            ">${notificationsBadgeCount}</span>` : ''}
          </button>
          <button data-lobby-nav-logout="1" style="
            display:flex; align-items:center; gap:8px;
            background: none; border: none; border-radius:8px;
            padding:9px 14px;
            cursor:pointer;
            font-size:13px; font-weight:700; letter-spacing:0.04em; text-transform:uppercase;
            color:rgba(255,255,255,0.75);
          ">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
              <polyline points="16 17 21 12 16 7"/>
              <line x1="21" y1="12" x2="9" y2="12"/>
            </svg>
            Изход
          </button>
        ` : `
          <button data-lobby-nav-guest-contact="1" title="Връзка с екипа на Pika.bg" style="
            background:none; border:none; cursor:pointer; padding:6px;
            color:rgba(255,255,255,0.65); position:relative;
            display:flex;align-items:center;justify-content:center;
          "
          onmouseenter="this.style.color='#d4a520'"
          onmouseleave="this.style.color='rgba(255,255,255,0.65)'"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>
          </button>
          <button data-lobby-auth-login="1" style="
            display:flex; align-items:center; gap:8px;
            background: transparent;
            border: 1px solid rgba(212,165,32,0.55); border-radius:8px;
            padding:9px 20px;
            cursor:pointer;
            font-size:13px; font-weight:800; letter-spacing:0.05em; text-transform:uppercase;
            color:#d4a520;
          ">
            Вход
          </button>
          <button data-lobby-auth-register="1" style="
            display:flex; align-items:center; gap:8px;
            background: linear-gradient(135deg, #d4a520 0%, #b8891a 100%);
            border: none; border-radius:8px;
            padding:9px 20px;
            cursor:pointer;
            font-size:13px; font-weight:800; letter-spacing:0.05em; text-transform:uppercase;
            color:#000000;
            box-shadow: 0 2px 12px rgba(212,165,32,0.35);
          ">
            Регистрация
          </button>
        `}
      </div>
    </nav>
  `
}

function renderGuestHeroCard(signupBonus: number, useMobileLayout = false): string {
  const bonusText = formatAmount(signupBonus)
  const heroBannerHtml = useMobileLayout
    ? ''
    : `
      <div style="flex:0 1 985px; min-width:0; border:2px solid rgba(212,165,32,0.88); border-radius:14px; overflow:hidden; position:relative; box-sizing:border-box;">
        <img src="/assets/lobby/hero-banner.png" alt="Добре дошъл в лобито"
          style="width:100%; height:254px; max-width:100%; display:block; object-fit:contain;">
      </div>
    `
  return `
    <div style="display:flex; gap:16px; align-items:stretch; margin-bottom:16px;">
      ${heroBannerHtml}

      <div style="
        flex:1 1 620px; min-width:580px; height:258px;
        background: linear-gradient(160deg, #050505 0%, #0d0d0d 100%);
        border: 2px solid rgba(212,165,32,0.88);
        border-radius:14px;
        padding:16px 28px;
        box-sizing:border-box;
      ">
        <!-- top row: avatar + name/online + divider + bonus -->
        <div style="display:flex; align-items:center; gap:24px; height:120px;">
          <div style="position:relative; width:120px; height:120px; flex-shrink:0;">
            <div style="
              width:120px; height:120px; border-radius:12px;
              border:3px solid rgba(212,165,32,0.55);
              overflow:hidden; background:#111111;
              box-shadow:0 0 0 2px rgba(0,0,0,0.65), 0 0 22px rgba(212,165,32,0.10);
              box-sizing:border-box;
              display:flex; align-items:center; justify-content:center;
            ">
              <span style="font-size:48px;font-weight:900;color:#d4a520;">Г</span>
            </div>
          </div>

          <div style="flex:1; min-width:0;">
            <div style="font-size:30px; line-height:1; font-weight:800; color:#ffffff;">Гост</div>
            <div style="display:flex; align-items:center; gap:8px; margin-top:12px;">
              <div style="width:14px; height:14px; border-radius:50%; background:#22c55e;"></div>
              <span style="font-size:16px; color:rgba(255,255,255,0.88); font-weight:600;">Онлайн</span>
            </div>
          </div>

          <div style="width:1px; height:92px; background:rgba(212,165,32,0.35);"></div>

          <div style="width:210px;">
            <div style="
              display:flex; align-items:center; gap:10px;
              background:rgba(212,165,32,0.07);
              border:1px solid rgba(212,165,32,0.35);
              border-radius:10px;
              padding:14px 16px;
            ">
              <img src="/assets/lobby/icon-coin.png" alt="" style="width:28px;height:28px;object-fit:contain;flex-shrink:0;">
              <div style="font-size:15px;font-weight:400;color:rgba(255,255,255,0.80);line-height:1.4;">
                Създай профил и започни със <span style="color:#d4a520;font-weight:700;">${bonusText} жълтици</span>
              </div>
            </div>
          </div>
        </div>

        <!-- divider -->
        <div style="
          height:1px;
          background:linear-gradient(90deg, transparent 0%, rgba(212,165,32,0.55) 12%, rgba(212,165,32,0.55) 88%, transparent 100%);
          margin:10px 0 12px;
        "></div>

        <!-- bottom: cta text -->
        <div style="display:flex; align-items:center; justify-content:center; height:52px;">
          <div style="font-size:14px;font-weight:600;color:rgba(255,255,255,0.50);line-height:1.5;text-align:center;">
            <button data-lobby-auth-login="1" style="background:none;border:none;padding:0;cursor:pointer;color:#d4a520;font-size:20px;font-weight:400;">Влез</button>
            <span style="color:#ffffff;font-size:20px;font-weight:400;"> или се </span>
            <button data-lobby-auth-register="1" style="background:none;border:none;padding:0;cursor:pointer;color:#d4a520;font-size:20px;font-weight:400;">Регистрирай</button>
            <span style="color:#ffffff;font-size:20px;font-weight:400;">, за да започнеш преживяването.</span>
          </div>
        </div>
      </div>
    </div>
  `
}

function renderHeroSection(
  profileName: string,
  avatarUrl: string | null,
  yellowCoinsBalance: number | null,
  wonGamesCount: number | null,
  completedGamesCount: number | null,
  rankTitle: string | null,
  level: number | null,
  useMobileLayout = false,
): string {
  const winRate =
    wonGamesCount !== null && completedGamesCount !== null && completedGamesCount > 0
      ? Math.round((wonGamesCount / completedGamesCount) * 100)
      : null
  const heroBannerHtml = useMobileLayout
    ? ''
    : `
      <div style="flex:0 1 985px; min-width:0; border:2px solid rgba(212,165,32,0.88); border-radius:14px; overflow:hidden; position:relative; box-sizing:border-box;">
        <img src="/assets/lobby/hero-banner.png" alt="Добре дошъл в лобито"
          style="width:100%; height:254px; max-width:100%; display:block; object-fit:contain;">
      </div>
    `
  return `
    <div style="display:flex; gap:16px; align-items:stretch; margin-bottom:16px;">
      ${heroBannerHtml}

      <div style="
        flex:1 1 620px; min-width:580px; height:258px;
        background: linear-gradient(160deg, #050505 0%, #0d0d0d 100%);
        border: 2px solid rgba(212,165,32,0.88);
        border-radius:14px;
        padding:16px 28px;
        box-sizing:border-box;
      ">
        <div style="display:flex; align-items:center; gap:24px; height:120px;">
          <div style="position:relative; width:120px; height:120px; flex-shrink:0;">
            <button
              type="button"
              data-lobby-profile-button="1"
              style="
                display:block; width:120px; height:120px; border-radius:12px;
                border:3px solid #d4a520;
                overflow:hidden;
                background:#111111;
                box-shadow:0 0 0 2px rgba(0,0,0,0.65), 0 0 22px rgba(212,165,32,0.18);
                box-sizing:border-box;
                cursor:pointer; padding:0;
                transition:filter 0.15s, box-shadow 0.15s;
              "
              onmouseenter="this.style.filter='brightness(1.2)';this.style.boxShadow='0 0 0 2px rgba(0,0,0,0.65), 0 0 28px rgba(212,165,32,0.45)'"
              onmouseleave="this.style.filter='';this.style.boxShadow='0 0 0 2px rgba(0,0,0,0.65), 0 0 22px rgba(212,165,32,0.18)'"
            >
              ${avatarUrl
                ? `<img src="${escapeHtml(avatarUrl)}" alt="${escapeHtml(profileName)}" style="width:100%; height:100%; object-fit:cover; object-position:center;">`
                : `<span style="font-size:48px;font-weight:900;color:#d4a520;display:flex;align-items:center;justify-content:center;width:100%;height:100%;">${escapeHtml(profileName.charAt(0).toUpperCase() || '?')}</span>`}
            </button>
            ${renderLevelBadge(level, 'md')}
          </div>
          <div style="flex:1; min-width:0;">
            <div style="font-size:30px; line-height:1; font-weight:800; color:#22c55e; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${escapeHtml(profileName)}</div>
            <button
              type="button"
              data-lobby-profile-button="1"
              class="lobby-profile-link-btn"
              style="
                display:inline-flex; align-items:center; gap:7px;
                margin-top:10px;
                background:none; border:none; border-radius:6px;
                padding:4px 2px;
                cursor:pointer;
                font-size:13px; font-weight:700; letter-spacing:0.04em; text-transform:uppercase;
                color:rgba(255,255,255,0.75);
                transition:color 0.15s;
              "
              onmouseenter="this.style.color='#d4a520'"
              onmouseleave="this.style.color='rgba(255,255,255,0.75)'"
            >
              <img src="/assets/lobby/nav-icon-preview/nav-profile-gold.png" alt="" style="width:18px; height:20px; display:block; object-fit:contain;">
              Профил
            </button>
          </div>
          <div style="width:1px; height:92px; background:rgba(212,165,32,0.35);"></div>
          <div style="width:210px;">
            <div style="font-size:17px; color:rgba(255,255,255,0.78); font-weight:500;">Баланс</div>
            <div style="display:flex; align-items:center; gap:8px; margin-top:8px;">
              <span style="font-size:clamp(18px, 2.2vw, 34px); line-height:1; font-weight:900; color:#d4a520; white-space:nowrap;">${yellowCoinsBalance !== null ? formatAmount(yellowCoinsBalance) : '—'}</span>
              <img src="/assets/lobby/icon-coin.png" alt="" style="width:33px; height:32px; display:block; object-fit:contain;">
            </div>
            <div style="font-size:16px; color:rgba(255,255,255,0.72); margin-top:8px;">жълтици</div>
          </div>
        </div>

        <div style="
          height:1px;
          background:linear-gradient(90deg, transparent 0%, rgba(212,165,32,0.55) 12%, rgba(212,165,32,0.55) 88%, transparent 100%);
          margin:10px 0 8px;
        "></div>

        <div style="
          display:grid; grid-template-columns:0.82fr 1fr 1.18fr 1.42fr;
          align-items:center;
          height:76px;
        ">
          <div style="display:flex; align-items:center; gap:8px; min-width:0; padding-right:10px;">
            <img src="/assets/lobby/icon-victories.png" alt="" style="width:36px; height:36px; display:block; object-fit:contain; flex-shrink:0;">
            <div style="min-width:0;">
              <div style="font-size:15px; color:rgba(255,255,255,0.82); font-weight:600;">Победи</div>
              <div style="font-size:22px; line-height:1.1; font-weight:800; color:#ffffff; margin-top:6px;">${wonGamesCount !== null ? formatAmount(wonGamesCount) : '—'}</div>
            </div>
          </div>
          <div style="display:flex; align-items:center; gap:8px; min-width:0; padding:0 10px; border-left:1px solid rgba(212,165,32,0.35);">
            <img src="/assets/lobby/icon-games-played.png" alt="" style="width:36px; height:38px; display:block; object-fit:contain; flex-shrink:0;">
            <div style="min-width:0;">
              <div style="font-size:14px; line-height:1.1; color:rgba(255,255,255,0.82); font-weight:600;">Изиграни игри</div>
              <div style="font-size:22px; line-height:1.1; font-weight:800; color:#ffffff; margin-top:6px;">${completedGamesCount !== null ? formatAmount(completedGamesCount) : '—'}</div>
            </div>
          </div>
          <div style="display:flex; align-items:center; gap:8px; min-width:0; padding:0 10px; border-left:1px solid rgba(212,165,32,0.35);">
            <img src="/assets/lobby/icon-success-rate.png" alt="" style="width:36px; height:38px; display:block; object-fit:contain; flex-shrink:0;">
            <div style="min-width:0;">
              <div style="font-size:14px; line-height:1.1; color:rgba(255,255,255,0.82); font-weight:600;">Успеваемост</div>
              <div style="font-size:22px; line-height:1.1; font-weight:800; color:#ffffff; margin-top:6px;">${winRate !== null ? `${winRate}%` : '—'}</div>
            </div>
          </div>
          <div style="display:flex; align-items:center; gap:10px; min-width:0; padding-left:10px; border-left:1px solid rgba(212,165,32,0.35);">
            <img src="/assets/lobby/icon-rank.png" alt="" style="width:48px; height:62px; display:block; object-fit:contain; flex-shrink:0;">
            <div style="min-width:0;">
              <div style="font-size:15px; color:#d4a520; font-weight:700;">Ранг</div>
              <div style="font-size:18px; line-height:1.15; font-weight:800; color:#ffffff; margin-top:7px;">${rankTitle ? escapeHtml(rankTitle) : '—'}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `
}

function renderStakeSection(
  selectedStake: MatchStake,
  canStartSearch: boolean,
  isSearching: boolean,
  matchRooms: MatchRoomSnapshot[],
  playerLevel: number,
  matchRoomsLoading: boolean,
  useMobileLayout = false,
  isGuestSession = false,
  guestTrialStake: MatchStake = 5000,
): string {
  const rooms = matchRooms.filter((r) => r.isEnabled)

  if (matchRoomsLoading) {
    return `
      <div style="margin-bottom:16px;text-align:center;color:rgba(255,255,255,0.35);font-size:14px;padding:32px 0;">
        Зареждане на масите...
      </div>
    `
  }

  if (rooms.length === 0) {
    return `
      <div style="margin-bottom:16px;text-align:center;color:rgba(255,255,255,0.35);font-size:14px;padding:32px 0;">
        Няма активни стаи в момента.
      </div>
    `
  }

  const stakeCards = rooms.map((room) => {
    const isLockedForGuest = isGuestSession && room.stakeAmount !== guestTrialStake
    const isLevelLockedForRegistered = !isGuestSession && playerLevel < room.minLevel
    const isLocked = playerLevel < room.minLevel || isLockedForGuest
    const isSelected = isSearching && room.stakeAmount === selectedStake
    // Guest-locked и level-locked карти остават кликаеми (не HTML disabled), за да могат да
    // отворят съответния popup при клик, вместо директно да стартират matchmaking.
    const isDisabled = !canStartSearch || (isLocked && !isLockedForGuest && !isLevelLockedForRegistered)

    return `
      <button
        type="button"
        data-lobby-stake-card="${room.stakeAmount}"
        ${isLockedForGuest ? `data-lobby-stake-card-guest-locked="1"` : ''}
        ${isLevelLockedForRegistered ? `data-lobby-stake-card-level-locked="1" data-lobby-stake-card-required-level="${room.minLevel}"` : ''}
        ${isDisabled ? 'disabled' : ''}
        style="
          flex: 0 0 calc(20% - 10px);
          min-width:180px;
          position:relative;
          background:#000000;
          border: 2px solid ${isSelected ? '#d4a520' : isLocked ? 'rgba(255,255,255,0.35)' : 'rgba(212,165,32,0.88)'};
          border-radius:12px;
          padding:16px 14px 14px;
          cursor:${isDisabled ? 'default' : 'pointer'};
          text-align:left;
          overflow:hidden;
          transition:border-color 160ms ease, background 160ms ease, box-shadow 160ms ease;
          opacity:${isLocked ? '0.72' : isDisabled && !isSelected ? '0.7' : '1'};
        "
      >
        ${!isLocked && !useMobileLayout ? `
          <img src="/assets/lobby/spade-watermark.png" alt=""
            style="
              position:absolute; bottom:8px; right:18px;
              width:82px; height:97px; display:block; object-fit:contain;
              opacity:1; pointer-events:none;
            ">
        ` : ''}

        ${isSelected ? `
          <div style="
            position:absolute; top:10px; right:10px;
            background:linear-gradient(135deg, #d4a520 0%, #a07010 100%);
            border-radius:20px; padding:3px 9px;
            font-size:9px; font-weight:900; text-transform:uppercase; letter-spacing:0.06em;
            color:#000000;
          ">ИЗБРАНО ★</div>
        ` : isLocked ? `
          <div style="position:absolute; top:10px; right:10px; font-size:20px; pointer-events:none; z-index:2; line-height:1;">🔒</div>
          <div style="
            position:absolute; bottom:10px; right:10px;
            background:linear-gradient(135deg, #d4a520 0%, #a07010 100%);
            border-radius:8px; padding:8px 14px;
            text-align:center; pointer-events:none; z-index:2;
          ">
            ${isLockedForGuest ? `
              <div style="font-size:10px; font-weight:900; text-transform:uppercase; letter-spacing:0.06em; color:rgba(0,0,0,0.72); max-width:110px;">Влез в профила си</div>
            ` : `
              <div style="font-size:9px; font-weight:900; text-transform:uppercase; letter-spacing:0.1em; color:rgba(0,0,0,0.65); margin-bottom:3px;">Ниво за вход</div>
              <div style="font-size:22px; font-weight:900; color:#000000; line-height:1;">${room.minLevel}</div>
            `}
          </div>
        ` : ''}

        <div style="display:flex; align-items:center; justify-content:flex-start; gap:16px; position:relative; z-index:1;">
          <div>
            <div style="font-size:10px; font-weight:700; color:rgba(255,255,255,0.5); text-transform:uppercase; letter-spacing:0.08em; margin-bottom:5px;">Награда</div>
            <div style="display:flex; align-items:center; gap:5px; margin-bottom:12px;">
              <span style="font-size:22px; font-weight:900; color:${isLocked ? 'rgba(255,255,255,0.55)' : '#d4a520'}; line-height:1;">${formatAmount(room.prizeAmount)}</span>
              <img src="/assets/lobby/icon-coin.png" alt="" style="height:18px;${isLocked ? 'filter:grayscale(1);opacity:0.55;' : ''}">
            </div>

            <div style="font-size:10px; font-weight:700; color:rgba(255,255,255,0.5); text-transform:uppercase; letter-spacing:0.08em; margin-bottom:5px;">Вход</div>
            <div style="display:flex; align-items:center; gap:5px;">
              <span style="font-size:18px; font-weight:400; color:${isLocked ? 'rgba(255,255,255,0.55)' : '#ffffff'}; line-height:1;">${formatAmount(room.stakeAmount)}</span>
              <img src="/assets/lobby/icon-coin.png" alt="" style="height:15px;${isLocked ? 'filter:grayscale(1);opacity:0.55;' : ''}">
            </div>
          </div>

          ${!isLocked ? `
            <div style="
              flex-shrink:0; width:58px; height:58px; border-radius:10px;
              background:linear-gradient(135deg, #f4c95b 0%, #c98f13 100%);
              display:flex; align-items:center; justify-content:center;
              font-size:11px; font-weight:900; color:#000000;
              text-transform:uppercase; letter-spacing:0.05em; pointer-events:none;
            ">Играй</div>
          ` : ''}
        </div>

      </button>
    `
  }).join('')

  return `
    <div style="margin-bottom:16px;">
      <div style="
        display:flex; align-items:center; justify-content:center; gap:12px;
        margin-bottom:14px;
      ">
        <div style="flex:1; height:2px; background:linear-gradient(90deg, #000000 0%, #d4a520 100%);"></div>
        <div style="display:flex; align-items:center; gap:8px;">
          <span style="color:#d4a520; font-size:16px;">◆</span>
          <span style="font-size:16px; font-weight:800; letter-spacing:0.12em; text-transform:uppercase; color:#d4a520;">Избери маса</span>
          <span style="color:#d4a520; font-size:16px;">◆</span>
        </div>
        <div style="flex:1; height:2px; background:linear-gradient(90deg, #d4a520 0%, #000000 100%);"></div>
      </div>

      <div data-lobby-stakes-scroll="1" style="
        display:flex;
        flex-wrap:nowrap;
        gap:12px;
        overflow-x:scroll;
        position:relative;
      ">
        ${stakeCards}
      </div>

      <div style="display:flex; align-items:stretch; height:30px; margin-top:6px; gap:6px;">
        <button data-stakes-prev="1" style="
          flex:0 0 42px; background:linear-gradient(180deg, rgba(65,44,6,0.98) 0%, rgba(18,12,2,0.98) 100%);
          border:1px solid rgba(244,201,91,0.76);
          border-radius:7px; color:#ffd45a; font-size:28px; line-height:1;
          text-shadow:0 0 10px rgba(244,201,91,0.45);
          box-shadow:inset 0 1px 0 rgba(255,255,255,0.12), 0 0 12px rgba(212,165,32,0.10);
          cursor:pointer; display:flex; align-items:center; justify-content:center; padding:0;
          transition:background 0.15s, color 0.15s, box-shadow 0.15s, transform 0.12s;
        ">&#8249;</button>
        <div data-stakes-track="1" style="
          flex:1; position:relative;
          background:rgba(255,255,255,0.07);
          border:1px solid rgba(212,165,32,0.45);
          border-radius:7px;
          overflow:hidden;
        ">
          <div data-stakes-thumb="1" style="
            position:absolute; top:4px; bottom:4px; left:4px;
            background:rgba(212,165,32,0.72); border-radius:4px;
            cursor:grab; min-width:24px; transition:background 0.15s;
          "></div>
        </div>
        <button data-stakes-next="1" style="
          flex:0 0 42px; background:linear-gradient(180deg, rgba(65,44,6,0.98) 0%, rgba(18,12,2,0.98) 100%);
          border:1px solid rgba(244,201,91,0.76);
          border-radius:7px; color:#ffd45a; font-size:28px; line-height:1;
          text-shadow:0 0 10px rgba(244,201,91,0.45);
          box-shadow:inset 0 1px 0 rgba(255,255,255,0.12), 0 0 12px rgba(212,165,32,0.10);
          cursor:pointer; display:flex; align-items:center; justify-content:center; padding:0;
          transition:background 0.15s, color 0.15s, box-shadow 0.15s, transform 0.12s;
        ">&#8250;</button>
      </div>

      <style>
        [data-lobby-stake-card]:not(:disabled):hover {
          border-color:rgba(212,165,32,0.96) !important;
          background:rgba(212,165,32,0.06) !important;
          box-shadow:inset 0 0 0 1px rgba(212,165,32,0.96) !important;
        }
        [data-stakes-prev]:hover, [data-stakes-next]:hover {
          background:linear-gradient(180deg, rgba(112,76,10,1) 0%, rgba(42,29,5,1) 100%) !important;
          color:#fff2a8 !important;
          box-shadow:inset 0 1px 0 rgba(255,255,255,0.18), 0 0 18px rgba(212,165,32,0.28) !important;
        }
        [data-stakes-prev]:active, [data-stakes-next]:active {
          transform:translateY(1px);
        }
        [data-stakes-thumb]:hover { background:rgba(212,165,32,0.95) !important; }
      </style>
    </div>
  `
}

function renderMissionsPopup(state: LobbyScreenState): string {
  if (!state.missionsPopupOpen) return ''

  const missions = state.dailyMissions
  const isLoggedIn = state.profile.profileId !== null

  const missionsHtml = state.dailyMissionsLoading
    ? `<div style="color:rgba(255,255,255,0.55);font-size:14px;padding:20px 0;text-align:center;">Зареждане...</div>`
    : state.dailyMissionsErrorText
      ? `<div style="color:#fecaca;font-size:13px;padding:16px 0;text-align:center;">${escapeHtml(state.dailyMissionsErrorText)}</div>`
      : !isLoggedIn
        ? `<div style="color:rgba(255,255,255,0.55);font-size:14px;padding:20px 0;text-align:center;">Влез в профила си, за да виждаш мисиите.</div>`
        : missions.length === 0
          ? `<div style="color:rgba(255,255,255,0.55);font-size:14px;padding:20px 0;text-align:center;">Няма активни мисии за днес.</div>`
          : missions.map((mission) => {
              const progressRatio = Math.min(1, mission.targetCount > 0 ? mission.progressCount / mission.targetCount : 0)
              const progressPct = Math.round(progressRatio * 100)
              const isComplete = mission.isCompleted
              const isClaiming = state.missionClaimingId === mission.missionId
              const isClaimed = mission.isClaimed

              return `
                <div style="
                  border-radius:10px;
                  border:1px solid ${isComplete && !isClaimed ? 'rgba(74,222,128,0.5)' : 'rgba(255,255,255,0.10)'};
                  background:${isComplete && !isClaimed ? 'rgba(20,60,30,0.5)' : 'rgba(255,255,255,0.04)'};
                  padding:14px 16px;
                  display:grid; gap:10px;
                ">
                  <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:12px;">
                    <div style="flex:1;min-width:0;">
                      <div style="font-size:14px; font-weight:800; color:${isClaimed ? 'rgba(255,255,255,0.4)' : '#f8fafc'}; ${isClaimed ? 'text-decoration:line-through;' : ''}">${escapeHtml(mission.title)}</div>
                      <div style="font-size:12px; color:rgba(255,255,255,0.5); margin-top:2px;">
                        ${mission.progressCount} / ${mission.targetCount}
                      </div>
                    </div>
                    <div style="display:flex;align-items:center;gap:10px;flex-shrink:0;">
                      <div style="display:flex;align-items:center;gap:4px;">
                        <img src="/assets/lobby/coins-1000.png" alt="" style="width:20px;height:20px;object-fit:contain;">
                        <span style="font-size:13px;font-weight:800;color:#d4a520;">${formatAmount(mission.rewardYellowCoins)}</span>
                      </div>
                      ${isClaimed
                        ? `<div style="height:30px;padding:0 12px;border-radius:6px;border:1px solid rgba(74,222,128,0.3);background:rgba(20,50,20,0.5);display:flex;align-items:center;font-size:12px;font-weight:800;color:#4ade80;">Взето ✓</div>`
                        : isComplete
                          ? `<button data-mission-claim="${escapeHtml(mission.missionId)}" ${isClaiming ? 'disabled' : ''} style="
                              height:30px;padding:0 12px;border:none;border-radius:6px;
                              background:linear-gradient(135deg,#22c55e 0%,#16a34a 100%);
                              color:#ffffff;font-size:12px;font-weight:800;cursor:${isClaiming ? 'not-allowed' : 'pointer'};
                              opacity:${isClaiming ? '0.6' : '1'};
                            ">${isClaiming ? 'Зареждане...' : 'Вземи награда'}</button>`
                          : `<div style="height:30px;padding:0 12px;border-radius:6px;border:1px solid rgba(255,255,255,0.12);background:transparent;display:flex;align-items:center;font-size:12px;font-weight:700;color:rgba(255,255,255,0.35);">В прогрес</div>`
                      }
                    </div>
                  </div>
                  <div style="height:6px;border-radius:99px;background:rgba(255,255,255,0.10);overflow:hidden;">
                    <div style="height:100%;width:${progressPct}%;border-radius:99px;background:${isClaimed ? '#4ade80' : isComplete ? '#22c55e' : 'linear-gradient(90deg,#d4a520 0%,#f4c95b 100%)'};transition:width 0.4s ease;"></div>
                  </div>
                </div>
              `
            }).join('')

  const claimError = state.missionClaimErrorText
    ? `<div style="border-radius:8px;border:1px solid rgba(248,113,113,0.28);background:rgba(127,29,29,0.42);padding:10px 12px;color:#fecaca;font-size:13px;font-weight:800;margin-bottom:12px;">${escapeHtml(state.missionClaimErrorText)}</div>`
    : ''

  return `
    <div data-missions-popup-root="1" style="position:fixed;inset:0;z-index:14000;display:flex;align-items:center;justify-content:center;padding:24px;">
      <div data-missions-popup-backdrop="1" style="position:absolute;inset:0;background:rgba(0,0,0,0.76);-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);"></div>
      <div role="dialog" aria-modal="true" class="gold-scrollbar" style="position:relative;width:min(92vw,520px);max-height:80vh;overflow-y:auto;border-radius:12px;border:2px solid rgba(96,165,250,0.6);background:linear-gradient(180deg,rgba(20,20,32,0.99) 0%,rgba(8,8,16,0.99) 100%);box-shadow:0 34px 80px rgba(0,0,0,0.6);padding:24px;">
        <button type="button" data-missions-popup-close="1" aria-label="Затвори" style="position:absolute;right:10px;top:10px;width:36px;height:36px;border:0;border-radius:999px;background:rgba(255,255,255,0.08);color:#ffffff;font-size:22px;font-weight:900;cursor:pointer;">×</button>
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px;">
          <img src="/assets/lobby/icon-missions.png" alt="" style="width:36px;height:36px;object-fit:contain;flex-shrink:0;">
          <div style="font-size:22px;font-weight:900;color:#60a5fa;">Дневни мисии</div>
        </div>
        ${claimError}
        <div style="display:grid;gap:10px;">
          ${missionsHtml}
        </div>
      </div>
    </div>
  `
}

let notificationsDropdownRootEl: HTMLElement | null = null

function getUnclaimedDailyRewardsBadgeCount(state: LobbyScreenState): number {
  return state.dailyRewardTiers.some((tier) => tier.claimedToday !== true) ? 1 : 0
}

function getPendingFriendRequestNotifications(state: LobbyScreenState): LobbyScreenState['pendingFriendRequests'] {
  const byId = new Map<string, LobbyScreenState['pendingFriendRequests'][number]>()

  for (const request of state.pendingFriendRequests) {
    byId.set(request.friendshipId, request)
  }

  for (const relationship of state.friendships?.incomingPending ?? []) {
    if (byId.has(relationship.friendshipId)) {
      continue
    }

    byId.set(relationship.friendshipId, {
      friendshipId: relationship.friendshipId,
      fromProfileId: relationship.profile.profileId ?? '',
      fromDisplayName: relationship.profile.displayName,
      fromAvatarUrl: relationship.profile.avatarUrl,
    })
  }

  return Array.from(byId.values())
}

function getPendingFriendRequestBadgeCount(state: LobbyScreenState): number {
  return getPendingFriendRequestNotifications(state).length
}

function getNotificationsBadgeCount(state: LobbyScreenState): number {
  return (
    state.dailyMissionsUnclaimedCount +
    getPendingFriendRequestBadgeCount(state) +
    getUnclaimedDailyRewardsBadgeCount(state) +
    state.pendingGiftNotifications.length +
    state.acceptanceNotifications.length
  )
}

function renderNotificationsDropdown(state: LobbyScreenState): string {
  const hasMissions = state.dailyMissionsUnclaimedCount > 0
  const pendingFriendRequests = getPendingFriendRequestNotifications(state)
  const hasFriendRequests = pendingFriendRequests.length > 0
  const hasDailyRewards = getUnclaimedDailyRewardsBadgeCount(state) > 0
  const hasGiftNotifications = state.pendingGiftNotifications.length > 0
  const hasAcceptanceNotifications = state.acceptanceNotifications.length > 0
  const hasAny = hasMissions || hasFriendRequests || hasDailyRewards || hasGiftNotifications || hasAcceptanceNotifications
  return `
    <div data-notifications-backdrop="1" style="position:fixed;inset:0;z-index:11000;" aria-hidden="true"></div>
    <div style="
      position:fixed; top:56px; right:12px; z-index:11001;
      background:#111111; border:1px solid rgba(255,255,255,0.12);
      border-radius:12px; min-width:280px; max-width:340px;
      box-shadow:0 8px 32px rgba(0,0,0,0.6);
      font-family:Inter,system-ui,sans-serif;
      overflow:hidden;
    ">
      <div style="padding:12px 16px; border-bottom:1px solid rgba(255,255,255,0.08); font-size:12px; font-weight:700; letter-spacing:0.06em; text-transform:uppercase; color:rgba(255,255,255,0.45);">
        Известия
      </div>
      ${hasMissions ? `
        <button data-notifications-missions="1" style="
          width:100%; background:none; border:none; cursor:pointer;
          display:flex; align-items:flex-start; gap:12px;
          padding:14px 16px; text-align:left;
          border-bottom:1px solid rgba(255,255,255,0.06);
          transition:background 0.15s;
        " onmouseover="this.style.background='rgba(255,255,255,0.05)'" onmouseout="this.style.background='none'">
          <div style="
            width:36px; height:36px; border-radius:50%; flex-shrink:0;
            background:rgba(239,68,68,0.15); border:1.5px solid rgba(239,68,68,0.4);
            display:flex; align-items:center; justify-content:center;
            font-size:16px;
          ">🎯</div>
          <div>
            <div style="font-size:13px; font-weight:700; color:#f8fafc; margin-bottom:2px;">Дневни мисии</div>
            <div style="font-size:12px; color:rgba(255,255,255,0.55); line-height:1.4;">
              ${state.dailyMissionsUnclaimedCount === 1 ? 'Имате 1 изпълнена мисия с неприбрана награда.' : `Имате ${state.dailyMissionsUnclaimedCount} изпълнени мисии с неприбрани награди.`}
            </div>
          </div>
        </button>
      ` : ''}
      ${hasDailyRewards ? `
        <button data-notifications-daily-rewards="1" style="
          width:100%; background:none; border:none; cursor:pointer;
          display:flex; align-items:flex-start; gap:12px;
          padding:14px 16px; text-align:left;
          border-bottom:1px solid rgba(255,255,255,0.06);
          transition:background 0.15s;
        " onmouseover="this.style.background='rgba(255,255,255,0.05)'" onmouseout="this.style.background='none'">
          <div style="
            width:36px; height:36px; border-radius:50%; flex-shrink:0;
            background:rgba(239,68,68,0.15); border:1.5px solid rgba(239,68,68,0.4);
            display:flex; align-items:center; justify-content:center;
          ">
            <img src="/assets/lobby/icon-daily-rewards.png" alt="" style="width:24px;height:24px;object-fit:contain;">
          </div>
          <div>
            <div style="font-size:13px; font-weight:700; color:#f8fafc; margin-bottom:2px;">Ежедневни награди</div>
            <div style="font-size:12px; color:rgba(255,255,255,0.55); line-height:1.4;">
              Имате неприбрана ежедневна награда.
            </div>
          </div>
        </button>
      ` : ''}
      ${hasFriendRequests ? pendingFriendRequests.map((req) => `
        <button data-notif-friend-request="${req.friendshipId}" type="button" style="
          width:100%; background:none; border:none; cursor:pointer;
          display:flex; align-items:center; gap:12px;
          padding:14px 16px; text-align:left;
          border-bottom:1px solid rgba(255,255,255,0.06);
          transition:background 0.15s;
        " onmouseover="this.style.background='rgba(255,255,255,0.05)'" onmouseout="this.style.background='none'">
          <div style="
            width:36px; height:36px; border-radius:50%; flex-shrink:0;
            background:rgba(212,175,55,0.12); border:1.5px solid rgba(212,175,55,0.35);
            display:flex; align-items:center; justify-content:center;
            font-size:16px;
          ">🤝</div>
          <div>
            <div style="font-size:13px; font-weight:700; color:#f8fafc; margin-bottom:2px;">Имате покана за приятелство</div>
            <div style="font-size:12px; color:rgba(255,255,255,0.55); line-height:1.4;">${req.fromDisplayName}</div>
          </div>
        </button>
      `).join('') : ''}
      ${hasAcceptanceNotifications ? state.acceptanceNotifications.map((n) => `
        <button data-notif-acceptance="${escapeHtml(n.friendshipId)}" type="button" style="
          width:100%; background:none; border:none; cursor:pointer;
          display:flex; align-items:center; gap:12px;
          padding:14px 16px; text-align:left;
          border-bottom:1px solid rgba(255,255,255,0.06);
          transition:background 0.15s;
        " onmouseover="this.style.background='rgba(255,255,255,0.05)'" onmouseout="this.style.background='none'">
          <div style="
            width:36px; height:36px; border-radius:50%; flex-shrink:0;
            background:rgba(34,197,94,0.12); border:1.5px solid rgba(34,197,94,0.35);
            display:flex; align-items:center; justify-content:center;
            font-size:16px;
          ">✅</div>
          <div>
            <div style="font-size:13px; font-weight:700; color:#f8fafc; margin-bottom:2px;">Поканата ви беше приета</div>
            <div style="font-size:12px; color:rgba(255,255,255,0.55); line-height:1.4;">${escapeHtml(n.fromDisplayName)} прие поканата ви за приятелство</div>
          </div>
        </button>
      `).join('') : ''}
      ${hasGiftNotifications ? state.pendingGiftNotifications.map((g) => `
        <button data-notif-gift="${escapeHtml(g.giftId)}" type="button" style="
          width:100%; background:none; border:none; cursor:pointer;
          display:flex; align-items:center; gap:12px;
          padding:14px 16px; text-align:left;
          border-bottom:1px solid rgba(255,255,255,0.06);
          transition:background 0.15s;
        " onmouseover="this.style.background='rgba(255,255,255,0.05)'" onmouseout="this.style.background='none'">
          <div style="
            width:36px; height:36px; border-radius:50%; flex-shrink:0;
            background:rgba(212,165,32,0.12); border:1.5px solid rgba(212,165,32,0.35);
            display:flex; align-items:center; justify-content:center;
            font-size:18px;
          ">🪙</div>
          <div>
            <div style="font-size:13px; font-weight:700; color:#f8fafc; margin-bottom:2px;">Имате подарени жълтици</div>
            <div style="font-size:12px; color:rgba(255,255,255,0.55); line-height:1.4;">${escapeHtml(g.fromDisplayName)} ви подари ${g.amount.toLocaleString('bg-BG')} жълтици</div>
          </div>
        </button>
      `).join('') : ''}
      ${state.acceptanceErrorText ? `
        <div style="
          margin:10px 12px; padding:10px 12px;
          border-radius:8px; border:1px solid rgba(248,113,113,0.28);
          background:rgba(127,29,29,0.42); color:#fecaca;
          font-size:13px; font-weight:600; text-align:center;
        ">${escapeHtml(state.acceptanceErrorText)}</div>
      ` : ''}
      ${!hasAny ? `
        <div style="padding:24px 16px; text-align:center; color:rgba(255,255,255,0.35); font-size:13px;">
          Няма нови известия
        </div>
      ` : ''}
    </div>
  `
}

function syncNotificationsDropdown(
  state: LobbyScreenState,
  callbacks: {
    onClose: () => void
    onMissionsClick: () => void
    onDailyRewardsClick: () => void
    onFriendRequestClick: (friendshipId: string) => void
    onGiftNotificationClick: (giftId: string, amount: number, fromDisplayName: string) => void
    onAcceptanceNotificationClick: (friendshipId: string) => void
  },
): void {
  if (!state.notificationsOpen) {
    notificationsDropdownRootEl?.remove()
    notificationsDropdownRootEl = null
    return
  }

  if (!notificationsDropdownRootEl) {
    notificationsDropdownRootEl = document.createElement('div')
    document.body.appendChild(notificationsDropdownRootEl)
  }

  notificationsDropdownRootEl.innerHTML = renderNotificationsDropdown(state)

  notificationsDropdownRootEl
    .querySelector('[data-notifications-backdrop="1"]')
    ?.addEventListener('click', callbacks.onClose)

  notificationsDropdownRootEl
    .querySelector('[data-notifications-missions="1"]')
    ?.addEventListener('click', callbacks.onMissionsClick)
  notificationsDropdownRootEl
    .querySelector('[data-notifications-daily-rewards="1"]')
    ?.addEventListener('click', callbacks.onDailyRewardsClick)

  for (const btn of Array.from(notificationsDropdownRootEl.querySelectorAll<HTMLButtonElement>('[data-notif-friend-request]'))) {
    const id = btn.getAttribute('data-notif-friend-request')!
    btn.addEventListener('click', () => { callbacks.onFriendRequestClick(id); callbacks.onClose() })
  }

  for (const btn of Array.from(notificationsDropdownRootEl.querySelectorAll<HTMLButtonElement>('[data-notif-gift]'))) {
    const giftId = btn.getAttribute('data-notif-gift')!
    const gift = state.pendingGiftNotifications.find((g) => g.giftId === giftId)
    if (gift) {
      btn.addEventListener('click', () => {
        callbacks.onClose()
        callbacks.onGiftNotificationClick(gift.giftId, gift.amount, gift.fromDisplayName)
      })
    }
  }

  for (const btn of Array.from(notificationsDropdownRootEl.querySelectorAll<HTMLButtonElement>('[data-notif-acceptance]'))) {
    const friendshipId = btn.getAttribute('data-notif-acceptance')!
    btn.addEventListener('click', () => {
      callbacks.onClose()
      callbacks.onAcceptanceNotificationClick(friendshipId)
    })
  }
}

let missionsPopupRootEl: HTMLElement | null = null

function syncMissionsPopup(
  state: LobbyScreenState,
  callbacks: {
    onClose: () => void
    onMissionClaim: (missionId: string) => void
  },
): void {
  if (!state.missionsPopupOpen) {
    missionsPopupRootEl?.remove()
    missionsPopupRootEl = null
    return
  }

  if (!missionsPopupRootEl) {
    missionsPopupRootEl = document.createElement('div')
    document.body.appendChild(missionsPopupRootEl)
  }

  missionsPopupRootEl.innerHTML = renderMissionsPopup(state)

  missionsPopupRootEl.querySelector('[data-missions-popup-close="1"]')
    ?.addEventListener('click', callbacks.onClose)
  missionsPopupRootEl.querySelector('[data-missions-popup-backdrop="1"]')
    ?.addEventListener('click', callbacks.onClose)

  missionsPopupRootEl.querySelectorAll<HTMLButtonElement>('[data-mission-claim]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const missionId = btn.dataset.missionClaim?.trim() ?? ''
      if (missionId) callbacks.onMissionClaim(missionId)
    })
  })
}

function renderBottomSection(
  lobbyPackages: CoinPackageSnapshot[],
  isLoggedIn: boolean,
  unclaimedMissionsCount: number,
  hasUnclaimedDailyReward = false,
  useMobileLayout = false,
): string {
  const footerDecorHtml = useMobileLayout
    ? ''
    : '<img src="/assets/lobby/footer-decor.png" alt="" style="width:332px; height:137px; display:block; object-fit:contain;">'
  const coinPackages = lobbyPackages.map((pkg, pkgIndex) => {
    const imgSrc = getCoinPackageImage(pkg.sortOrder)
    const isFirstPkg = pkgIndex === 0

    return `
    <div style="
      background:#000000;
      border:2px solid rgba(212,165,32,0.84);
      border-radius:12px;
      padding:10px 12px;
      display:grid; grid-template-columns:80px minmax(0, 1fr); align-items:center; gap:10px;
      flex:1; min-width:0;
      overflow:hidden;
      ${isFirstPkg ? 'position:relative; z-index:2;' : ''}
    ">
      <div style="height:98px; display:flex; align-items:center; justify-content:center;">
        <img src="${imgSrc}" alt="${formatAmount(pkg.yellowCoinsAmount)} жълтици"
          style="width:80px; height:80px; display:block; object-fit:contain;">
      </div>
      <div style="display:flex; flex-direction:column; justify-content:center; align-items:flex-start; min-width:0;">
        <div style="font-size:21px; line-height:1; font-weight:800; color:#d4a520; white-space:nowrap; display:flex; align-items:center; gap:5px;">
          <img src="/assets/lobby/icon-coin.png" alt="" style="width:20px; height:20px; object-fit:contain; display:block;">
          ${formatAmount(pkg.yellowCoinsAmount)}
        </div>
        <div style="font-size:16px; line-height:1; font-weight:400; color:#ffffff; margin-top:6px; margin-bottom:7px; white-space:nowrap;">
          ${escapeHtml(formatPackagePrice(pkg.priceCents, pkg.currency))}<span style="font-size:12px; font-weight:400; color:rgba(255,255,255,0.45);"> / ${escapeHtml(formatPackagePriceBgn(pkg.priceCents))}</span>
        </div>
        <button data-lobby-buy-coins-button="1" data-lobby-buy-coins-package="${escapeHtml(pkg.packageId)}" data-lobby-buy-coins-logged="${isLoggedIn ? '1' : '0'}" style="
          background:linear-gradient(135deg, #f4c95b 0%, #c98f13 100%);
          border:none; border-radius:6px;
          padding:0 14px;
          height:28px;
          font-size:12px; font-weight:800; text-transform:uppercase; letter-spacing:0.03em;
          color:#000000; cursor:pointer;
          min-width:84px;
          transition:transform 0.14s ease, box-shadow 0.14s ease, filter 0.14s ease;
        ">${isLoggedIn ? 'Купи' : 'Влез и купи'}</button>
      </div>
    </div>
  `
  }).join('')

  const packagesSection = lobbyPackages.length === 0 ? '' : `
    <div style="
      display:grid;
      grid-template-columns:326px repeat(${lobbyPackages.length}, minmax(0, 1fr));
      gap:8px;
      align-items:stretch;
      margin-bottom:16px;
    ">
      <div style="
        background:#000000;
        border:2px solid rgba(212,165,32,0.84);
        border-radius:12px;
        padding:15px 20px;
        display:flex; flex-direction:column; justify-content:center;
        position:relative; overflow:visible; z-index:1;
      ">
        <div style="
          position:absolute; top:-2px; bottom:-2px;
          right:calc(-8px - 50%);
          left:0;
          background:#000000;
          border:2px solid rgba(212,165,32,0.84);
          border-right:0;
          border-radius:12px 0 0 12px;
          pointer-events:none; z-index:-1;
        "></div>
        <div style="display:flex; align-items:flex-start; gap:10px;">
          <div style="
            width:45px; height:43px; border-radius:12px;
            background:#000000;
            display:flex; align-items:center; justify-content:center;
            flex-shrink:0;
          ">
            <img src="/assets/lobby/icon-shop-cart.png" alt="" style="width:45px; height:43px; display:block; object-fit:contain;">
          </div>
          <div style="min-width:0;">
            <div style="font-size:13px; font-weight:800; color:#d4a520; text-transform:uppercase; letter-spacing:0.05em;">Магазин за жълтици</div>
            <div style="font-size:11px; color:rgba(255,255,255,0.5); font-weight:400; line-height:1.35; margin-top:5px;">
              Купи жълтици и се върни в играта
            </div>
            <button data-lobby-nav-shop="1" class="lobby-bottom-shop-btn" style="
              margin-top:9px;
              height:32px;
              padding:0 16px;
              border:none;
              border-radius:6px;
              background:linear-gradient(135deg, #f4c95b 0%, #c98f13 100%);
              color:#000000;
              font-size:13px;
              font-weight:800;
              text-transform:uppercase;
              letter-spacing:0.03em;
              cursor:pointer;
              min-width:132px;
              transition:transform 0.14s ease, box-shadow 0.14s ease, filter 0.14s ease;
            ">Виж всички оферти</button>
          </div>
        </div>
      </div>

      ${coinPackages}

      <style>
        [data-lobby-buy-coins-button="1"]:hover,
        .lobby-bottom-shop-btn:hover {
          filter:brightness(1.12);
          transform:translateY(-1px);
          box-shadow:0 4px 12px rgba(212,165,32,0.26);
        }

        [data-lobby-buy-coins-button="1"]:active,
        .lobby-bottom-shop-btn:active {
          filter:brightness(0.98);
          transform:translateY(0);
        }
      </style>
    </div>
  `

  return `
    ${packagesSection}

    <div style="
      display:grid;
      grid-template-columns:repeat(3, minmax(0, 1fr)) 332px;
      gap:12px;
      align-items:stretch;
    ">
      <div data-lobby-private-rooms-card="1" style="
        background:#000000;
        border:2px solid rgba(167,139,250,0.78);
        border-radius:12px;
        padding:16px;
        display:flex; align-items:center; gap:14px;
        cursor:pointer;
        min-height:137px;
        transition:border-color 160ms ease, box-shadow 160ms ease, background 160ms ease;
      "
      onmouseenter="this.style.borderColor='rgba(167,139,250,0.96)';this.style.boxShadow='inset 0 0 0 1px rgba(167,139,250,0.96)';this.style.background='rgba(167,139,250,0.05)'"
      onmouseleave="this.style.borderColor='rgba(167,139,250,0.78)';this.style.boxShadow='none';this.style.background='#000000'"
      >
        <img src="/assets/lobby/icon-private-table.png" alt="" style="width:76px; height:75px; display:block; object-fit:contain; flex-shrink:0;">
        <div style="flex:1; min-width:0;">
          <div style="font-size:15px; font-weight:800; color:#a78bfa; text-transform:uppercase; letter-spacing:0.05em;">Частни маси</div>
          <div style="font-size:13px; color:rgba(255,255,255,0.5); margin-top:4px; font-weight:400;">Създай маса и играй с приятели.</div>
        </div>
      </div>

      <div data-lobby-daily-rewards-card="1" style="
        background:#000000;
        border:2px solid rgba(212,165,32,0.84);
        border-radius:12px;
        padding:16px;
        display:flex; align-items:center; gap:14px;
        cursor:pointer;
        position:relative;
        min-height:137px;
        transition:border-color 160ms ease, box-shadow 160ms ease, background 160ms ease;
      "
      onmouseenter="this.style.borderColor='rgba(212,165,32,0.96)';this.style.boxShadow='inset 0 0 0 1px rgba(212,165,32,0.96)';this.style.background='rgba(212,165,32,0.05)'"
      onmouseleave="this.style.borderColor='rgba(212,165,32,0.84)';this.style.boxShadow='none';this.style.background='#000000'"
      >
        ${renderQuickActionBadge(hasUnclaimedDailyReward ? 1 : 0)}
        <img src="/assets/lobby/icon-daily-rewards.png" alt="" style="width:74px; height:75px; display:block; object-fit:contain; flex-shrink:0;">
        <div style="flex:1; min-width:0;">
          <div style="font-size:15px; font-weight:800; color:#d4a520; text-transform:uppercase; letter-spacing:0.05em;">Ежедневни награди</div>
          <div style="font-size:13px; color:rgba(255,255,255,0.5); margin-top:4px; font-weight:400;">Влизай всеки ден и вземи своите награди.</div>
        </div>
      </div>

      <div data-lobby-missions-card="1" style="
        background:#000000;
        border:2px solid rgba(96,165,250,0.78);
        border-radius:12px;
        padding:16px;
        display:flex; align-items:center; gap:14px;
        cursor:pointer;
        min-height:137px;
        position:relative;
        transition:border-color 160ms ease, box-shadow 160ms ease, background 160ms ease;
      "
      onmouseenter="this.style.borderColor='rgba(96,165,250,0.96)';this.style.boxShadow='inset 0 0 0 1px rgba(96,165,250,0.96)';this.style.background='rgba(96,165,250,0.05)'"
      onmouseleave="this.style.borderColor='rgba(96,165,250,0.78)';this.style.boxShadow='none';this.style.background='#000000'"
      >
        ${renderQuickActionBadge(unclaimedMissionsCount)}
        <img src="/assets/lobby/icon-missions.png" alt="" style="width:73px; height:76px; display:block; object-fit:contain; flex-shrink:0;">
        <div style="flex:1; min-width:0;">
          <div style="font-size:15px; font-weight:800; color:#60a5fa; text-transform:uppercase; letter-spacing:0.05em;">Дневни мисии</div>
          <div style="font-size:13px; color:rgba(255,255,255,0.5); margin-top:4px; font-weight:400;">Изпълнявай дневни мисии и печели жълтици.</div>
        </div>
      </div>

      <div style="
        min-height:137px;
        display:flex;
        align-items:flex-end;
        justify-content:flex-end;
        overflow:hidden;
      ">
        ${footerDecorHtml}
      </div>
    </div>

    <div style="
      display:grid;
      grid-template-columns:repeat(2, minmax(0, 1fr));
      gap:12px;
      margin-top:12px;
    ">
      <a href="/rules" data-lobby-rules-card="1" style="
        background:#000000;
        border:2px solid rgba(212,165,32,0.78);
        border-radius:12px;
        padding:16px;
        display:flex; align-items:center; gap:14px;
        cursor:pointer;
        min-height:80px;
        transition:border-color 160ms ease, box-shadow 160ms ease, background 160ms ease;
        text-decoration:none; color:inherit;
      "
      onmouseenter="this.style.borderColor='rgba(212,165,32,0.96)';this.style.boxShadow='inset 0 0 0 1px rgba(212,165,32,0.96)';this.style.background='rgba(212,165,32,0.05)'"
      onmouseleave="this.style.borderColor='rgba(212,165,32,0.78)';this.style.boxShadow='none';this.style.background='#000000'"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="rgba(212,165,32,0.90)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="flex:0 0 auto;"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/><line x1="9" y1="7" x2="15" y2="7"/><line x1="9" y1="11" x2="15" y2="11"/><line x1="9" y1="15" x2="12" y2="15"/></svg>
        <div style="flex:1; min-width:0;">
          <div style="font-size:15px; font-weight:800; color:#d4a520; text-transform:uppercase; letter-spacing:0.05em;">Правила на белота</div>
          <div style="font-size:13px; color:rgba(255,255,255,0.5); margin-top:4px; font-weight:400;">Виж правилата, анонсите и точкуването.</div>
        </div>
      </a>

      <a href="/strategy" data-lobby-strategy-card="1" style="
        background:#000000;
        border:2px solid rgba(212,165,32,0.78);
        border-radius:12px;
        padding:16px;
        display:flex; align-items:center; gap:14px;
        cursor:pointer;
        min-height:80px;
        transition:border-color 160ms ease, box-shadow 160ms ease, background 160ms ease;
        text-decoration:none; color:inherit;
      "
      onmouseenter="this.style.borderColor='rgba(212,165,32,0.96)';this.style.boxShadow='inset 0 0 0 1px rgba(212,165,32,0.96)';this.style.background='rgba(212,165,32,0.05)'"
      onmouseleave="this.style.borderColor='rgba(212,165,32,0.78)';this.style.boxShadow='none';this.style.background='#000000'"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="rgba(212,165,32,0.90)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="flex:0 0 auto;"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        <div style="flex:1; min-width:0;">
          <div style="font-size:15px; font-weight:800; color:#d4a520; text-transform:uppercase; letter-spacing:0.05em;">Съвети и стратегии</div>
          <div style="font-size:13px; color:rgba(255,255,255,0.5); margin-top:4px; font-weight:400;">Научи полезни тактики и стани по-добър.</div>
        </div>
      </a>
    </div>

    <div style="
      display:grid;
      grid-template-columns:repeat(3, minmax(0, 1fr));
      gap:12px;
      margin-top:12px;
    ">
      <a href="/learn" data-lobby-learn-card="1" style="
        background:#000000;
        border:2px solid rgba(212,165,32,0.78);
        border-radius:12px;
        padding:16px;
        display:flex; align-items:center; gap:14px;
        cursor:pointer;
        min-height:80px;
        transition:border-color 160ms ease, box-shadow 160ms ease, background 160ms ease;
        text-decoration:none; color:inherit;
      "
      onmouseenter="this.style.borderColor='rgba(212,165,32,0.96)';this.style.boxShadow='inset 0 0 0 1px rgba(212,165,32,0.96)';this.style.background='rgba(212,165,32,0.05)'"
      onmouseleave="this.style.borderColor='rgba(212,165,32,0.78)';this.style.boxShadow='none';this.style.background='#000000'"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="rgba(212,165,32,0.90)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="flex:0 0 auto;"><path d="M22 10v6M2 10l10-5 10 5-10 5-10-5z"/><path d="M6 12v5c0 1.66 2.69 3 6 3s6-1.34 6-3v-5"/></svg>
        <div style="flex:1; min-width:0;">
          <div style="font-size:15px; font-weight:800; color:#d4a520; text-transform:uppercase; letter-spacing:0.05em;">Научи белот</div>
          <div style="font-size:13px; color:rgba(255,255,255,0.5); margin-top:4px; font-weight:400;">Основите на играта за нови играчи.</div>
        </div>
      </a>

      <a href="/fair-play" data-lobby-fair-play-card="1" style="
        background:#000000;
        border:2px solid rgba(212,165,32,0.78);
        border-radius:12px;
        padding:16px;
        display:flex; align-items:center; gap:14px;
        cursor:pointer;
        min-height:80px;
        transition:border-color 160ms ease, box-shadow 160ms ease, background 160ms ease;
        text-decoration:none; color:inherit;
      "
      onmouseenter="this.style.borderColor='rgba(212,165,32,0.96)';this.style.boxShadow='inset 0 0 0 1px rgba(212,165,32,0.96)';this.style.background='rgba(212,165,32,0.05)'"
      onmouseleave="this.style.borderColor='rgba(212,165,32,0.78)';this.style.boxShadow='none';this.style.background='#000000'"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="rgba(212,165,32,0.90)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="flex:0 0 auto;"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>
        <div style="flex:1; min-width:0;">
          <div style="font-size:15px; font-weight:800; color:#d4a520; text-transform:uppercase; letter-spacing:0.05em;">Честна игра</div>
          <div style="font-size:13px; color:rgba(255,255,255,0.5); margin-top:4px; font-weight:400;">Случайно раздаване и роля на ботовете.</div>
        </div>
      </a>

      <a href="/faq" data-lobby-faq-card="1" style="
        background:#000000;
        border:2px solid rgba(212,165,32,0.78);
        border-radius:12px;
        padding:16px;
        display:flex; align-items:center; gap:14px;
        cursor:pointer;
        min-height:80px;
        transition:border-color 160ms ease, box-shadow 160ms ease, background 160ms ease;
        text-decoration:none; color:inherit;
      "
      onmouseenter="this.style.borderColor='rgba(212,165,32,0.96)';this.style.boxShadow='inset 0 0 0 1px rgba(212,165,32,0.96)';this.style.background='rgba(212,165,32,0.05)'"
      onmouseleave="this.style.borderColor='rgba(212,165,32,0.78)';this.style.boxShadow='none';this.style.background='#000000'"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="rgba(212,165,32,0.90)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="flex:0 0 auto;"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        <div style="flex:1; min-width:0;">
          <div style="font-size:15px; font-weight:800; color:#d4a520; text-transform:uppercase; letter-spacing:0.05em;">Често задавани въпроси</div>
          <div style="font-size:13px; color:rgba(255,255,255,0.5); margin-top:4px; font-weight:400;">Отговори на чести въпроси за играта.</div>
        </div>
      </a>
    </div>
  `
}

function renderQuickActionBadge(count: number): string {
  if (count <= 0) {
    return ''
  }

  return `<span aria-hidden="true" style="position:absolute;top:10px;right:12px;min-width:20px;height:20px;border-radius:999px;background:#ef4444;color:#ffffff;border:2px solid #000000;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:900;line-height:1;box-shadow:0 0 0 2px rgba(239,68,68,0.22),0 0 14px rgba(239,68,68,0.72);">${count}</span>`
}

function renderMobileMenu(state: LobbyScreenState): string {
  const pendingCount = getNotificationsBadgeCount(state)
  const unreadChatCount = state.chatConversations.filter((conversation) => conversation.unreadCount > 0).length
  const mailUnreadCount = state.supportUnreadCount + (state.isAdmin ? state.adminGuestContactUnreadCount : 0)
  const mobileMenuBadgeCount = (state.friendships?.incomingPending.length ?? 0) + unreadChatCount + mailUnreadCount

  return `
    <header style="
      position:sticky;top:0;z-index:120;
      background:#050505;border-bottom:1px solid rgba(212,165,32,0.28);
      padding:10px 12px;display:flex;align-items:center;gap:10px;
    ">
      <style>
        @keyframes mobile-menu-backdrop-in { from { opacity:0; } to { opacity:1; } }
        @keyframes mobile-menu-backdrop-out { from { opacity:1; } to { opacity:0; } }
        @keyframes mobile-menu-shade-in {
          from { opacity:0; transform:translateY(-8px) scaleY(0.88); }
          to { opacity:1; transform:translateY(0) scaleY(1); }
        }
        @keyframes mobile-menu-shade-out {
          from { opacity:1; transform:translateY(0) scaleY(1); }
          to { opacity:0; transform:translateY(-8px) scaleY(0.88); }
        }
      </style>
      <a href="/lobby" data-lobby-nav-lobby="1" style="border:0;background:transparent;padding:0;display:flex;align-items:center;text-decoration:none;">
        <img src="/assets/lobby/logo.png" alt="Pika.bg" style="width:142px;height:38px;display:block;object-fit:contain;">
      </a>

      <div style="margin-left:auto;display:flex;align-items:center;gap:8px;">
        ${state.profile.profileId !== null ? `
          <button data-lobby-nav-bell="1" aria-label="Известия" style="
            width:42px;height:42px;border:1px solid rgba(212,165,32,0.34);border-radius:8px;
            background:#0b0b0b;color:#ffffff;position:relative;display:flex;align-items:center;justify-content:center;
          ">
            <img src="/assets/lobby/nav-icon-preview/nav-notifications-white.png" alt="" style="width:22px;height:24px;display:block;object-fit:contain;">
            ${pendingCount > 0 ? `<span style="position:absolute;right:4px;top:4px;min-width:16px;height:16px;border-radius:8px;background:#ef4444;color:#fff;font-size:10px;font-weight:900;display:flex;align-items:center;justify-content:center;padding:0 3px;">${pendingCount}</span>` : ''}
          </button>
        ` : `
          <button data-lobby-nav-guest-contact="1" aria-label="Контакти" style="
            width:42px;height:42px;border:1px solid rgba(212,165,32,0.34);border-radius:8px;
            background:#0b0b0b;color:rgba(255,255,255,0.78);position:relative;display:flex;align-items:center;justify-content:center;
          ">
            <svg xmlns="http://www.w3.org/2000/svg" width="23" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>
          </button>
        `}

        <details data-lobby-mobile-menu="1" ${mobileMenuOpen ? 'open' : ''} style="position:relative;z-index:160;">
          <summary data-lobby-mobile-menu-summary="1" style="
            list-style:none;height:42px;min-width:92px;padding:0 12px;
            border:1px solid rgba(212,165,32,0.54);border-radius:8px;
            background:linear-gradient(180deg,#151008 0%,#070707 100%);
            color:#d4a520;font-size:13px;font-weight:900;letter-spacing:0.04em;
            display:flex;align-items:center;justify-content:center;gap:8px;cursor:pointer;
            position:relative;z-index:3;
          ">
            Меню
            ${mobileMenuBadgeCount > 0 ? `<span style="position:absolute;right:-6px;top:-6px;min-width:18px;height:18px;border-radius:999px;background:#ef4444;color:#fff;border:2px solid #050505;font-size:10px;font-weight:900;line-height:1;display:flex;align-items:center;justify-content:center;padding:0 4px;box-sizing:border-box;">${mobileMenuBadgeCount}</span>` : ''}
          </summary>
          <button type="button" data-lobby-mobile-menu-backdrop="1" aria-label="Затвори менюто" style="
            position:fixed;inset:0;z-index:1;border:0;background:rgba(0,0,0,0.01);
            padding:0;margin:0;cursor:default;animation:mobile-menu-backdrop-in 120ms ease both;
          "></button>
          <div data-lobby-mobile-menu-panel="1" style="
            position:absolute;right:0;top:50px;width:min(82vw,280px);
            background:#090909;border:1px solid rgba(212,165,32,0.38);border-radius:8px;
            box-shadow:0 18px 44px rgba(0,0,0,0.68);padding:8px;display:grid;gap:6px;
            z-index:2;transform-origin:top right;animation:mobile-menu-shade-in 150ms cubic-bezier(0.2,0.8,0.2,1) both;
          ">
            <button type="button" data-lobby-nav-lobby="1" style="${mobileMenuButtonStyle()}">${mobileMenuSvgItemContent('lobby', 'Лоби')}</button>
            <button type="button" data-lobby-nav-shop="1" style="${mobileMenuButtonStyle()}">${mobileMenuSvgItemContent('shop', 'Магазин')}</button>
            <button type="button" data-lobby-nav-players="1" style="${mobileMenuButtonStyle()}">${mobileMenuSvgItemContent('players', 'Играчите')}</button>
            <button type="button" data-lobby-nav-leaderboards="1" style="${mobileMenuButtonStyle()}">${mobileMenuSvgItemContent('leaderboards', 'Класация')}</button>
            ${state.profile.profileId !== null ? `
              <button type="button" data-lobby-nav-friends="1" style="${mobileMenuButtonStyle()}">${mobileMenuSvgItemContent('friends', `Приятели${(state.friendships?.incomingPending.length ?? 0) > 0 ? ` (${state.friendships?.incomingPending.length ?? 0})` : ''}`)}</button>
              <button type="button" data-lobby-nav-chat="1" style="${mobileMenuButtonStyle()}">${mobileMenuSvgItemContent('chat', `Чат${unreadChatCount > 0 ? ` (${unreadChatCount})` : ''}`)}</button>
              <button type="button" data-lobby-nav-blocked-players="1" style="${mobileMenuButtonStyle()}">${mobileMenuSvgItemContent('blocked', 'Блокирани')}</button>
              <button type="button" data-lobby-nav-support="1" style="${mobileMenuButtonStyle()}">${mobileMenuSvgItemContent('support', `Поддръжка${mailUnreadCount > 0 ? ` (${mailUnreadCount})` : ''}`)}</button>
              ${state.isAdmin ? `
                <button type="button" data-lobby-nav-admin="1" style="${mobileMenuButtonStyle()}">${mobileMenuSvgItemContent('admin', 'Админ настройки')}</button>
                <button type="button" data-lobby-nav-admin-info="1" style="${mobileMenuButtonStyle()}">${mobileMenuSvgItemContent('admin', 'Админ информация')}</button>
                <button type="button" data-lobby-nav-admin-server="1" style="${mobileMenuButtonStyle()}">${mobileMenuSvgItemContent('admin', 'Сървър')}</button>
              ` : ''}
              <button type="button" data-lobby-nav-logout="1" style="${mobileMenuButtonStyle('rgba(248,113,113,0.16)', '#fecaca')}">${mobileMenuSvgItemContent('logout', 'Изход')}</button>
            ` : `
              <button type="button" data-lobby-nav-guest-contact="1" style="${mobileMenuButtonStyle()}">${mobileMenuSvgItemContent('support', 'Контакти')}</button>
              <button type="button" data-lobby-auth-login="1" style="${mobileMenuButtonStyle()}">${mobileMenuSvgItemContent('login', 'Вход')}</button>
              <button type="button" data-lobby-auth-register="1" style="${mobileMenuButtonStyle('linear-gradient(180deg,#f4c95b 0%,#c98f13 100%)', '#080808')}">${mobileMenuSvgItemContent('login', 'Регистрация')}</button>
            `}
          </div>
        </details>
      </div>
    </header>
  `
}

function mobileMenuButtonStyle(background = 'rgba(255,255,255,0.055)', color = '#f8fafc'): string {
  return `
    width:100%;min-height:42px;border:1px solid rgba(255,255,255,0.09);border-radius:7px;
    background:${background};color:${color};font-size:14px;font-weight:800;text-align:left;
    padding:0 12px;cursor:pointer;display:flex;align-items:center;gap:10px;
  `
}

function mobileMenuSvgItemContent(
  icon: 'admin' | 'blocked' | 'chat' | 'friends' | 'leaderboards' | 'lobby' | 'login' | 'logout' | 'players' | 'shop' | 'support',
  label: string,
): string {
  const stroke = icon === 'logout' ? '#fecaca' : '#d4a520'
  const path = icon === 'support'
    ? '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>'
    : icon === 'admin'
      ? '<path d="M12 3l7 4v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V7l7-4z"/><path d="M9 12l2 2 4-4"/>'
      : icon === 'blocked'
        ? '<circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>'
      : icon === 'chat'
        ? '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'
      : icon === 'friends'
        ? '<path d="m11 17 2 2a1 1 0 1 0 3-3"/><path d="m14 14 2.5 2.5a1 1 0 1 0 3-3l-3.88-3.88a3 3 0 0 0-4.24 0l-.88.88a1 1 0 1 1-3-3l2.81-2.81a5.79 5.79 0 0 1 7.06-.87l.47.28a2 2 0 0 0 1.42.25L21 4"/><path d="m21 3 1 11h-1"/><path d="M3 3 2 14l6.5 6.5a1 1 0 1 0 3-3"/><path d="M3 4h8"/>'
      : icon === 'leaderboards'
        ? '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>'
      : icon === 'lobby'
        ? '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>'
      : icon === 'players'
        ? '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'
      : icon === 'shop'
        ? '<circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>'
      : icon === 'logout'
        ? '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>'
        : '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="M10 17l5-5-5-5"/><path d="M15 12H3"/>'

  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block;flex:0 0 auto;">${path}</svg>
    <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${label}</span>
  `
}

function renderMobileProfileCard(state: LobbyScreenState, profileName: string): string {
  const yellowCoinsBalance = state.profile.yellowCoinsBalance
  const avatarUrl = state.profile.avatarUrl

  return `
    <section style="
      margin:12px;border:2px solid rgba(212,165,32,0.84);border-radius:8px;
      background:#080808;padding:12px;display:flex;align-items:center;gap:12px;
    ">
      <button type="button" data-lobby-profile-button="1" style="
        width:68px;height:68px;border-radius:8px;border:1px solid rgba(212,165,32,0.44);
        background:#101010;overflow:hidden;display:flex;align-items:center;justify-content:center;
        color:#d4a520;font-size:28px;font-weight:900;flex:0 0 auto;padding:0;cursor:pointer;
      ">
        ${avatarUrl ? `<img src="${escapeHtml(avatarUrl)}" alt="" style="width:100%;height:100%;object-fit:cover;display:block;">` : escapeHtml(profileName.slice(0, 1).toUpperCase())}
      </button>
      <div style="min-width:0;flex:1;">
        <div style="font-size:18px;font-weight:900;color:#22c55e;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(profileName)}</div>
        <div style="margin-top:4px;font-size:12px;font-weight:800;color:rgba(255,255,255,0.54);">Ниво - ${state.profile.level ?? 1}</div>
        <button type="button" data-lobby-profile-button="1" style="
          margin-top:6px;border:0;background:transparent;color:#d4a520;
          font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;
          padding:0;cursor:pointer;display:inline-flex;align-items:center;gap:7px;
        ">
          <img src="/assets/lobby/nav-icon-preview/nav-profile-gold.png" alt="" style="width:18px;height:20px;display:block;object-fit:contain;">
          Профил
        </button>
      </div>
      ${yellowCoinsBalance !== null ? `
        <div style="display:grid;gap:4px;justify-items:end;flex:0 0 auto;">
          <div style="font-size:11px;font-weight:900;color:rgba(255,255,255,0.48);text-transform:uppercase;letter-spacing:0.08em;">Баланс</div>
          <div style="display:flex;align-items:center;gap:6px;color:#d4a520;font-size:20px;font-weight:900;">
            <img src="/assets/lobby/icon-coin.png" alt="" style="width:22px;height:22px;object-fit:contain;">
            ${formatAmount(yellowCoinsBalance)}
          </div>
        </div>
      ` : ''}
    </section>
  `
}

function renderMobileGuestCard(signupBonus: number): string {
  return `
    <section style="
      margin:12px;border:2px solid rgba(212,165,32,0.84);border-radius:8px;
      background:#080808;padding:14px;display:grid;gap:12px;
    ">
      <div style="font-size:20px;font-weight:900;color:#ffffff;">Pika.bg</div>
      <div style="font-size:14px;line-height:1.45;color:rgba(255,255,255,0.66);font-weight:700;">
        Влез или създай профил и започни със <span style="color:#d4a520;">${formatAmount(signupBonus)} жълтици</span>.
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
        <button type="button" data-lobby-auth-login="1" style="height:44px;border:1px solid rgba(212,165,32,0.54);border-radius:8px;background:#050505;color:#d4a520;font-size:14px;font-weight:900;">Вход</button>
        <button type="button" data-lobby-auth-register="1" style="height:44px;border:0;border-radius:8px;background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;font-size:14px;font-weight:900;">Регистрация</button>
      </div>
    </section>
  `
}

function renderMobileStakeSection(
  selectedStake: MatchStake,
  canStartSearch: boolean,
  isSearching: boolean,
  matchRooms: MatchRoomSnapshot[],
  playerLevel: number,
  matchRoomsLoading: boolean,
  isGuestSession = false,
  guestTrialStake: MatchStake = 5000,
): string {
  const rooms = matchRooms.filter((room) => room.isEnabled)

  if (matchRoomsLoading) {
    return `<section style="padding:18px 12px;color:rgba(255,255,255,0.52);font-size:14px;font-weight:800;">Зареждане на масите...</section>`
  }

  const cards = rooms.map((room, index) => {
    const isLockedForGuest = isGuestSession && room.stakeAmount !== guestTrialStake
    const isLevelLockedForRegistered = !isGuestSession && playerLevel < room.minLevel
    const isLocked = playerLevel < room.minLevel || isLockedForGuest
    const isSelected = isSearching && room.stakeAmount === selectedStake
    const isDisabled = !canStartSearch || (isLocked && !isLockedForGuest && !isLevelLockedForRegistered)
    const snapAlign = index === 0
      ? 'start'
      : index === rooms.length - 1
        ? 'end'
        : 'center'
    const snapMargin = index === rooms.length - 1 ? 'scroll-margin-right:4px;' : ''

    return `
      <article style="
        flex:0 0 calc(100vw - 128px);max-width:none;min-height:136px;border-radius:8px;
        border:2px solid ${isSelected ? '#f4c95b' : isLocked ? 'rgba(255,255,255,0.28)' : 'rgba(212,165,32,0.88)'};
        background:#080808;color:#ffffff;padding:12px;text-align:left;position:relative;
        opacity:${isDisabled && !isSelected ? '0.68' : '1'};scroll-snap-align:${snapAlign};${snapMargin}box-sizing:border-box;
        overflow:hidden;
      ">
        <img src="/assets/lobby/spade-watermark.png" alt="" style="
          position:absolute;right:8px;top:calc(50% - 30px);transform:translateY(-50%);
          width:55px;height:55px;object-fit:contain;opacity:0.65;pointer-events:none;
        ">
        <div style="position:relative;z-index:1;">
          <div style="font-size:12px;font-weight:900;color:rgba(255,255,255,0.48);text-transform:uppercase;letter-spacing:0.08em;">Награда</div>
          <div style="margin-top:6px;font-size:26px;font-weight:900;color:#d4a520;display:flex;align-items:center;gap:7px;">
            ${formatAmount(room.prizeAmount)}
            <img src="/assets/lobby/icon-coin.png" alt="" style="width:24px;height:24px;object-fit:contain;">
          </div>
        </div>
        <div style="position:relative;z-index:1;margin-top:9px;display:flex;align-items:center;justify-content:space-between;gap:12px;">
          <div>
            <div style="font-size:11px;font-weight:900;color:rgba(255,255,255,0.46);text-transform:uppercase;">Вход</div>
            <div style="margin-top:4px;font-size:18px;font-weight:400;color:#ffffff;">${formatAmount(room.stakeAmount)}</div>
          </div>
          ${isLockedForGuest ? `
            <button type="button" data-lobby-stake-card="${room.stakeAmount}" data-lobby-stake-card-guest-locked="1" style="
              height:44px;padding:0 14px;border:1px solid rgba(212,165,32,0.55);border-radius:8px;
              background:#0a0a0a;color:#f6d36b;font-size:12px;font-weight:900;display:flex;align-items:center;justify-content:center;
              cursor:pointer;
            ">Влез в профила си</button>
          ` : isLevelLockedForRegistered ? `
            <button type="button" data-lobby-stake-card="${room.stakeAmount}" data-lobby-stake-card-level-locked="1" data-lobby-stake-card-required-level="${room.minLevel}" style="
              height:44px;padding:0 14px;border:1px solid rgba(212,165,32,0.55);border-radius:8px;
              background:#0a0a0a;color:#fca5a5;font-size:12px;font-weight:900;display:flex;align-items:center;justify-content:center;
              cursor:pointer;
            ">Ниво ${room.minLevel}</button>
          ` : isLocked ? `
            <div style="font-size:12px;font-weight:900;color:#fca5a5;text-align:right;">Ниво ${room.minLevel}</div>
          ` : `
            <button type="button" data-lobby-stake-card="${room.stakeAmount}" ${isDisabled ? 'disabled' : ''} style="
              height:44px;padding:0 16px;border:0;border-radius:8px;
              background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);
              color:#080808;font-size:13px;font-weight:900;display:flex;align-items:center;justify-content:center;
              opacity:${isDisabled ? '0.62' : '1'};cursor:${isDisabled ? 'default' : 'pointer'};
            ">Играй</button>
          `}
        </div>
      </article>
    `
  }).join('')

  return `
    <section style="margin-top:14px;">
      ${renderMobileSectionTitle('Избери игра')}
      <div data-lobby-stakes-scroll="1" style="
        display:flex;gap:10px;overflow-x:auto;scroll-snap-type:x mandatory;
        padding:0 12px 8px;scroll-padding-left:12px;scroll-padding-right:12px;-webkit-overflow-scrolling:touch;
      ">
        ${cards || `<div style="color:rgba(255,255,255,0.52);font-size:14px;font-weight:800;padding:12px;">Няма активни маси в момента.</div>`}
      </div>
    </section>
  `
}

function renderMobileOffersSection(lobbyPackages: CoinPackageSnapshot[], isLoggedIn: boolean): string {
  if (lobbyPackages.length === 0) return ''

  const cards = lobbyPackages.map((pkg, index) => {
    const imgSrc = getCoinPackageImage(pkg.sortOrder)
    const snapAlign = index === 0
      ? 'start'
      : index === lobbyPackages.length - 1
        ? 'end'
        : 'center'
    const snapMargin = index === lobbyPackages.length - 1 ? 'scroll-margin-right:4px;' : ''

    return `
      <article style="
        flex:0 0 calc(100vw - 128px);max-width:none;min-height:136px;border-radius:8px;
        border:2px solid rgba(212,165,32,0.84);background:#080808;padding:12px;
        display:grid;grid-template-columns:82px minmax(0,1fr);gap:10px;align-items:center;scroll-snap-align:${snapAlign};${snapMargin}box-sizing:border-box;
      ">
        <img src="${imgSrc}" alt="${formatAmount(pkg.yellowCoinsAmount)} жълтици" style="width:78px;height:78px;display:block;object-fit:contain;">
        <div style="min-width:0;">
          <div style="font-size:21px;font-weight:900;color:#d4a520;white-space:nowrap;display:flex;align-items:center;gap:6px;">
            <img src="/assets/lobby/icon-coin.png" alt="" style="width:20px;height:20px;display:block;object-fit:contain;flex:0 0 auto;">
            ${formatAmount(pkg.yellowCoinsAmount)}
          </div>
          <div style="margin-top:5px;font-size:14px;font-weight:800;color:#ffffff;white-space:nowrap;">
            ${escapeHtml(formatPackagePrice(pkg.priceCents, pkg.currency))}<span style="font-size:11px;font-weight:700;color:rgba(255,255,255,0.48);"> / ${escapeHtml(formatPackagePriceBgn(pkg.priceCents))}</span>
          </div>
          <button type="button" data-lobby-buy-coins-package="${escapeHtml(pkg.packageId)}" data-lobby-buy-coins-logged="${isLoggedIn ? '1' : '0'}" style="
            margin-top:10px;height:34px;padding:0 12px;border:0;border-radius:7px;
            background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);
            color:#080808;font-size:12px;font-weight:900;
          ">${isLoggedIn ? 'Купи' : 'Влез и купи'}</button>
        </div>
      </article>
    `
  }).join('')

  return `
    <section style="margin-top:14px;">
      <div style="padding:0 12px 9px;display:flex;align-items:center;justify-content:flex-start;gap:10px;">
        <h2 style="margin:0;color:#d4a520;font-size:15px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;">Оферти</h2>
        <button type="button" data-lobby-nav-shop="1" style="
          border:0;background:transparent;color:#d4a520;font-size:12px;font-weight:900;
          text-decoration:underline;text-underline-offset:3px;padding:4px 0;cursor:pointer;
        ">всички оферти</button>
      </div>
      <div style="display:flex;gap:10px;overflow-x:auto;scroll-snap-type:x mandatory;padding:0 12px 8px;scroll-padding-left:12px;scroll-padding-right:12px;-webkit-overflow-scrolling:touch;">
        ${cards}
      </div>
    </section>
  `
}

function renderMobileQuickActions(unclaimedMissionsCount: number, hasUnclaimedDailyReward: boolean): string {
  return `
    <style>
      [data-lobby-private-rooms-card]:hover { border-color:rgba(167,139,250,0.96) !important; box-shadow:inset 0 0 0 1px rgba(167,139,250,0.96) !important; background:rgba(167,139,250,0.05) !important; }
      [data-lobby-daily-rewards-card]:hover { border-color:rgba(212,165,32,0.96) !important; box-shadow:inset 0 0 0 1px rgba(212,165,32,0.96) !important; background:rgba(212,165,32,0.05) !important; }
      [data-lobby-missions-card]:hover { border-color:rgba(96,165,250,0.96) !important; box-shadow:inset 0 0 0 1px rgba(96,165,250,0.96) !important; background:rgba(96,165,250,0.05) !important; }
      [data-lobby-rules-card]:hover { border-color:rgba(212,165,32,0.96) !important; box-shadow:inset 0 0 0 1px rgba(212,165,32,0.96) !important; background:rgba(212,165,32,0.05) !important; }
      [data-lobby-strategy-card]:hover { border-color:rgba(212,165,32,0.96) !important; box-shadow:inset 0 0 0 1px rgba(212,165,32,0.96) !important; background:rgba(212,165,32,0.05) !important; }
      [data-lobby-learn-card]:hover { border-color:rgba(212,165,32,0.96) !important; box-shadow:inset 0 0 0 1px rgba(212,165,32,0.96) !important; background:rgba(212,165,32,0.05) !important; }
      [data-lobby-fair-play-card]:hover { border-color:rgba(212,165,32,0.96) !important; box-shadow:inset 0 0 0 1px rgba(212,165,32,0.96) !important; background:rgba(212,165,32,0.05) !important; }
      [data-lobby-faq-card]:hover { border-color:rgba(212,165,32,0.96) !important; box-shadow:inset 0 0 0 1px rgba(212,165,32,0.96) !important; background:rgba(212,165,32,0.05) !important; }
    </style>
    <section style="margin:14px 12px 22px;display:grid;gap:10px;">
      <button type="button" data-lobby-private-rooms-card="1" style="${mobileActionCardStyle('#a78bfa', 'rgba(167,139,250,0.78)')}">
        <img src="/assets/lobby/icon-private-table.png" alt="" style="${mobileActionIconStyle()}">
        <span style="min-width:0;display:grid;gap:3px;">
          <span>Частни маси</span>
          <span style="${mobileActionSubtitleStyle()}">Създай маса и играй с приятели.</span>
        </span>
      </button>
      <button type="button" data-lobby-daily-rewards-card="1" style="${mobileActionCardStyle('#d4a520', 'rgba(212,165,32,0.84)')}">
        ${renderQuickActionBadge(hasUnclaimedDailyReward ? 1 : 0)}
        <img src="/assets/lobby/icon-daily-rewards.png" alt="" style="${mobileActionIconStyle()}">
        <span style="min-width:0;display:grid;gap:3px;">
          <span>Ежедневни награди</span>
          <span style="${mobileActionSubtitleStyle()}">Влизай всеки ден и вземи своите награди.</span>
        </span>
      </button>
      <button type="button" data-lobby-missions-card="1" style="${mobileActionCardStyle('#60a5fa', 'rgba(96,165,250,0.78)')}">
        ${renderQuickActionBadge(unclaimedMissionsCount)}
        <img src="/assets/lobby/icon-missions.png" alt="" style="${mobileActionIconStyle()}">
        <span style="min-width:0;display:grid;gap:3px;">
          <span>Дневни мисии</span>
          <span style="${mobileActionSubtitleStyle()}">Изпълнявай дневни мисии и печели жълтици.</span>
        </span>
      </button>
      <a href="/rules" data-lobby-rules-card="1" style="${mobileActionCardStyle('#d4a520', 'rgba(212,165,32,0.78)')}text-decoration:none;">
        <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="flex:0 0 auto;"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/><line x1="9" y1="7" x2="15" y2="7"/><line x1="9" y1="11" x2="15" y2="11"/><line x1="9" y1="15" x2="12" y2="15"/></svg>
        <span style="min-width:0;display:grid;gap:3px;">
          <span>Правила на белота</span>
          <span style="${mobileActionSubtitleStyle()}">Виж правилата, анонсите и точкуването.</span>
        </span>
      </a>
      <a href="/strategy" data-lobby-strategy-card="1" style="${mobileActionCardStyle('#d4a520', 'rgba(212,165,32,0.78)')}text-decoration:none;">
        <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="flex:0 0 auto;"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        <span style="min-width:0;display:grid;gap:3px;">
          <span>Съвети и стратегии</span>
          <span style="${mobileActionSubtitleStyle()}">Научи полезни тактики и стани по-добър.</span>
        </span>
      </a>
      <a href="/learn" data-lobby-learn-card="1" style="${mobileActionCardStyle('#d4a520', 'rgba(212,165,32,0.78)')}text-decoration:none;">
        <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="flex:0 0 auto;"><path d="M22 10v6M2 10l10-5 10 5-10 5-10-5z"/><path d="M6 12v5c0 1.66 2.69 3 6 3s6-1.34 6-3v-5"/></svg>
        <span style="min-width:0;display:grid;gap:3px;">
          <span>Научи белот</span>
          <span style="${mobileActionSubtitleStyle()}">Основите на играта за нови играчи.</span>
        </span>
      </a>
      <a href="/fair-play" data-lobby-fair-play-card="1" style="${mobileActionCardStyle('#d4a520', 'rgba(212,165,32,0.78)')}text-decoration:none;">
        <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="flex:0 0 auto;"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>
        <span style="min-width:0;display:grid;gap:3px;">
          <span>Честна игра</span>
          <span style="${mobileActionSubtitleStyle()}">Случайно раздаване и роля на ботовете.</span>
        </span>
      </a>
      <a href="/faq" data-lobby-faq-card="1" style="${mobileActionCardStyle('#d4a520', 'rgba(212,165,32,0.78)')}text-decoration:none;">
        <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="flex:0 0 auto;"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        <span style="min-width:0;display:grid;gap:3px;">
          <span>Често задавани въпроси</span>
          <span style="${mobileActionSubtitleStyle()}">Отговори на чести въпроси за играта.</span>
        </span>
      </a>
    </section>
  `
}

function mobileActionCardStyle(color: string, borderColor: string): string {
  return `
    min-height:72px;border:2px solid ${borderColor};border-radius:8px;background:#000000;
    color:${color};font-size:15px;font-weight:900;text-align:left;padding:10px 14px;cursor:pointer;
    display:flex;align-items:center;gap:12px;position:relative;
    transition:border-color 160ms ease, box-shadow 160ms ease, background 160ms ease;
  `
}

function mobileActionIconStyle(): string {
  return 'width:38px;height:38px;display:block;object-fit:contain;flex:0 0 auto;'
}

function mobileActionSubtitleStyle(): string {
  return 'font-size:12px;line-height:1.25;color:rgba(255,255,255,0.50);font-weight:400;'
}

function renderMobileSectionTitle(label: string): string {
  return `
    <div style="padding:0 12px 9px;display:flex;align-items:center;justify-content:space-between;">
      <h2 style="margin:0;color:#d4a520;font-size:15px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;">${label}</h2>
    </div>
  `
}

function renderMobilePageTitle(title: string, subtitle = ''): string {
  return `
    <section style="padding:14px 12px 10px;border-bottom:1px solid rgba(212,165,32,0.20);">
      <h1 style="margin:0;color:#ffffff;font-size:22px;font-weight:900;line-height:1.05;">${escapeHtml(title)}</h1>
      ${subtitle ? `<div style="margin-top:6px;color:rgba(255,255,255,0.58);font-size:13px;font-weight:700;line-height:1.4;">${escapeHtml(subtitle)}</div>` : ''}
    </section>
  `
}

function renderMobileStateMessage(text: string, tone: 'normal' | 'error' = 'normal'): string {
  return `
    <div style="
      margin:12px;border:1px ${tone === 'error' ? 'solid rgba(248,113,113,0.34)' : 'dashed rgba(255,255,255,0.14)'};
      border-radius:8px;background:${tone === 'error' ? 'rgba(127,29,29,0.28)' : '#080808'};
      color:${tone === 'error' ? '#fecaca' : 'rgba(255,255,255,0.62)'};
      min-height:132px;display:flex;align-items:center;justify-content:center;
      text-align:center;padding:18px;font-size:14px;font-weight:800;line-height:1.45;
    ">${escapeHtml(text)}</div>
  `
}

function renderMobilePlayerListCard(player: PlayerPublicProfileSnapshot, attrName: string): string {
  const displayName = player.displayName?.trim() || 'Играч'
  const avatarUrl = player.avatarUrl?.trim() ?? ''
  const profileId = player.profileId ?? ''

  return `
    <button type="button" ${attrName}="${escapeHtml(profileId)}" style="
      width:100%;border:1px solid rgba(212,165,32,0.30);border-radius:8px;background:#080808;
      padding:10px;display:flex;align-items:center;gap:11px;color:#ffffff;text-align:left;cursor:pointer;
    ">
      <div style="position:relative;width:58px;height:58px;flex:0 0 auto;">
        <div style="width:100%;height:100%;border-radius:8px;border:1px solid rgba(212,165,32,0.48);background:#101010;overflow:hidden;display:flex;align-items:center;justify-content:center;color:#d4a520;font-size:22px;font-weight:900;">
          ${avatarUrl ? `<img src="${escapeHtml(avatarUrl)}" alt="" style="width:100%;height:100%;object-fit:cover;display:block;">` : escapeHtml(displayName.charAt(0).toUpperCase() || '?')}
        </div>
        ${renderLevelBadge(player.level, 'sm')}
      </div>
      <div style="min-width:0;flex:1;">
        <div style="font-size:15px;font-weight:900;color:#f8fafc;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(displayName)}</div>
        <div style="margin-top:4px;color:#d4a520;font-size:12px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(player.rankTitle ?? 'Ранг 1')}</div>
        <div style="margin-top:7px;display:flex;gap:12px;color:rgba(255,255,255,0.58);font-size:11px;font-weight:800;">
          <span>Игри ${formatAmount(player.completedGamesCount ?? 0)}</span>
          <span>Оценка ${typeof player.averageRating === 'number' ? player.averageRating.toFixed(2) : '-'}</span>
        </div>
      </div>
      ${player.isOnline !== undefined ? `<div style="color:${player.isOnline ? '#4ade80' : '#f87171'};font-size:11px;font-weight:900;flex:0 0 auto;">${player.isOnline ? 'Онлайн' : 'Офлайн'}</div>` : ''}
    </button>
  `
}

/**
 * Общ helper за desktop/mobile players directory рендиране.
 * `allPlayers` винаги е базиран на state.players (непроменено поведение
 * на стандартния списък) — не се влияе от search резултатите. `players`
 * предпочита сървърните search резултати (покриват всички допустими
 * профили, не само първите 500), докато те не са налични — пада обратно
 * към мигновения локален substring filter, за да няма flicker/празен
 * екран, докато debounce/мрежовата заявка е в процес.
 */
function computePlayersDirectoryLists(
  state: LobbyScreenState,
  opts: { isAdmin: boolean; ownProfileId: string | null },
): { allPlayers: PlayerPublicProfileSnapshot[]; players: PlayerPublicProfileSnapshot[] } {
  const allPlayers = orderPlayersForViewer(state.players, opts)
  const query = state.playersSearchQuery.trim()

  if (query !== '' && state.playersSearchResults !== null) {
    return { allPlayers, players: orderPlayersForViewer(state.playersSearchResults, opts) }
  }

  const normalizedQuery = query.toLocaleLowerCase()
  const players = query
    ? allPlayers.filter((p) => (p.displayName ?? '').toLocaleLowerCase().includes(normalizedQuery))
    : allPlayers

  return { allPlayers, players }
}

function renderMobilePlayersDirectory(state: LobbyScreenState): string {
  if (state.playersLoading) return `${renderMobilePageTitle('Играчите')}${renderMobileStateMessage('Зареждане на играчи...')}`
  if (state.playersErrorText) return `${renderMobilePageTitle('Играчите')}${renderMobileStateMessage(state.playersErrorText, 'error')}`

  const { allPlayers, players } = computePlayersDirectoryLists(state, {
    isAdmin: state.isAdmin,
    ownProfileId: state.profile.profileId,
  })
  const applied = state.playersSearchQuery.trim()

  return `
    ${renderMobilePageTitle('Играчите', `${formatAmount(allPlayers.length)} профила`)}
    <div style="padding:12px 12px 8px;">
      <form data-lobby-players-search-form="1" style="display:grid;gap:8px;">
        <label style="display:flex;align-items:center;gap:10px;background:#0d0d0d;border:1px solid rgba(212,165,32,0.44);border-radius:8px;padding:0 14px;height:46px;">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#d4a520" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input
            data-lobby-players-search-mobile="1"
            type="search"
            placeholder="Намери играч"
            aria-label="Намери играч"
            value="${escapeHtml(state.playersSearchDraft)}"
            autocomplete="off"
            spellcheck="false"
            enterkeyhint="search"
            style="flex:1;min-width:0;background:transparent;border:0;outline:none;color:#f8fafc;font-size:15px;font-weight:700;font-family:inherit;"
          >
        </label>
        <button
          type="submit"
          style="width:100%;height:46px;border:0;border-radius:8px;background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;font-size:16px;font-weight:900;cursor:pointer;letter-spacing:0.01em;"
        >Намери</button>
      </form>
    </div>
    <section style="padding:4px 12px 12px;display:grid;gap:9px;">
      ${allPlayers.length === 0
        ? renderMobileStateMessage('Все още няма регистрирани играчи.')
        : players.length === 0 && applied !== ''
          ? renderMobileStateMessage('Няма намерени играчи.')
          : players.map((player) => renderMobilePlayerListCard(player, 'data-lobby-player-card')).join('')}
    </section>
  `
}

function renderMobileLeaderboardsDirectory(state: LobbyScreenState): string {
  if (state.leaderboardsLoading) return `${renderMobilePageTitle('Класация')}${renderMobileStateMessage('Зареждане на класации...')}`
  if (state.leaderboardsErrorText) return `${renderMobilePageTitle('Класация')}${renderMobileStateMessage(state.leaderboardsErrorText, 'error')}`

  const category = state.activeLeaderboardCategory
  const activeTab = LEADERBOARD_TABS.find((tab) => tab.category === category) ?? LEADERBOARD_TABS[0]
  const players = state.leaderboards?.[category] ?? []

  return `
    ${renderMobilePageTitle('Класация', 'Топ играчи по баланс, ранг, победи и оценка')}
    <div style="display:flex;gap:8px;overflow-x:auto;padding:12px;-webkit-overflow-scrolling:touch;">
      ${LEADERBOARD_TABS.map((tab) => {
        const isActive = tab.category === category
        return `<button type="button" data-lobby-leaderboard-tab="${tab.category}" style="height:40px;padding:0 14px;border:1px solid ${isActive ? 'rgba(212,165,32,0.76)' : 'rgba(255,255,255,0.12)'};border-radius:8px;background:${isActive ? 'linear-gradient(180deg,#f4c95b 0%,#c98f13 100%)' : '#080808'};color:${isActive ? '#080808' : '#f8fafc'};font-size:13px;font-weight:900;white-space:nowrap;">${escapeHtml(tab.label)}</button>`
      }).join('')}
    </div>
    <section style="padding:0 12px 14px;display:grid;gap:9px;">
      ${players.length === 0 ? renderMobileStateMessage('Все още няма данни за тази класация.') : players.map((player, index) => {
        const position = index + 1
        const displayName = player.displayName?.trim() || 'Играч'
        const avatarUrl = player.avatarUrl?.trim() ?? ''
        const medalColor = position === 1 ? '#d4a520' : position === 2 ? '#d4d4d8' : position === 3 ? '#c08457' : 'rgba(255,255,255,0.54)'

        return `
          <button type="button" data-lobby-leaderboard-player="${escapeHtml(player.profileId ?? '')}" style="
            width:100%;border:1px solid rgba(212,165,32,0.28);border-radius:8px;background:#080808;
            padding:10px;display:grid;grid-template-columns:44px 52px minmax(0,1fr) auto;align-items:center;gap:9px;color:#ffffff;text-align:left;
          ">
            <div style="font-size:20px;font-weight:900;color:${medalColor};text-align:center;">#${position}</div>
            <div style="width:52px;height:52px;border-radius:8px;border:1px solid rgba(212,165,32,0.46);background:#101010;overflow:hidden;display:flex;align-items:center;justify-content:center;color:#d4a520;font-size:20px;font-weight:900;">
              ${avatarUrl ? `<img src="${escapeHtml(avatarUrl)}" alt="" style="width:100%;height:100%;object-fit:cover;display:block;">` : escapeHtml(displayName.charAt(0).toUpperCase() || '?')}
            </div>
            <div style="min-width:0;">
              <div style="font-size:14px;font-weight:900;color:#f8fafc;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(displayName)}</div>
              <div style="margin-top:3px;font-size:11px;font-weight:800;color:#d4a520;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(player.rankTitle ?? 'Ранг 1')}</div>
            </div>
            <div style="text-align:right;">
              <div style="font-size:10px;font-weight:900;text-transform:uppercase;color:rgba(255,255,255,0.44);">${escapeHtml(activeTab.metricLabel)}</div>
              <div style="margin-top:3px;font-size:15px;font-weight:900;color:#ffffff;">${escapeHtml(getLeaderboardMetric(category, player))}</div>
            </div>
          </button>
        `
      }).join('')}
    </section>
  `
}

function renderMobileShopPanel(state: LobbyScreenState): string {
  if (state.shopPackagesLoading) return `${renderMobilePageTitle('Магазин')}${renderMobileStateMessage('Зареждане на магазина...')}`
  if (state.shopPackagesErrorText) return `${renderMobilePageTitle('Магазин')}${renderMobileStateMessage(state.shopPackagesErrorText, 'error')}`

  const isLoggedIn = state.profile.profileId !== null

  return `
    ${renderMobilePageTitle('Магазин', `Баланс: ${formatAmount(state.profile.yellowCoinsBalance ?? 0)} жълтици`)}
    ${state.shopPurchaseMessageText ? `<div style="margin:12px;border:1px solid rgba(212,165,32,0.30);border-radius:8px;background:rgba(212,165,32,0.08);padding:10px;color:#f8fafc;font-size:13px;font-weight:800;">${escapeHtml(state.shopPurchaseMessageText)}</div>` : ''}
    <section style="padding:12px;display:grid;gap:10px;">
      ${state.shopPackages.length === 0 ? renderMobileStateMessage('Няма активни пакети в магазина.') : state.shopPackages.map((coinPackage) => {
        const isPurchasing = state.shopPurchaseActionPackageId === coinPackage.packageId
        return `
          <article style="border:1px solid rgba(212,165,32,0.46);border-radius:8px;background:#080808;padding:12px;display:grid;grid-template-columns:84px minmax(0,1fr);gap:10px;align-items:center;">
            <img src="${getCoinPackageImage(coinPackage.sortOrder)}" alt="" style="width:82px;height:82px;object-fit:contain;">
            <div style="min-width:0;">
              <div style="font-size:12px;font-weight:900;color:rgba(255,255,255,0.48);text-transform:uppercase;">${escapeHtml(coinPackage.title)}</div>
              <div style="margin-top:4px;font-size:22px;font-weight:900;color:#d4a520;">${formatAmount(coinPackage.yellowCoinsAmount)}</div>
              <div style="margin-top:4px;font-size:14px;font-weight:900;color:#ffffff;white-space:nowrap;">
                ${escapeHtml(formatPackagePrice(coinPackage.priceCents, coinPackage.currency))}<span style="font-size:11px;font-weight:700;color:rgba(255,255,255,0.48);"> / ${escapeHtml(formatPackagePriceBgn(coinPackage.priceCents))}</span>
              </div>
              <button type="button" data-lobby-shop-package="${escapeHtml(coinPackage.packageId)}" ${isPurchasing ? 'disabled' : ''} style="margin-top:10px;height:38px;width:100%;border:0;border-radius:8px;background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;font-size:13px;font-weight:900;opacity:${isPurchasing ? '0.62' : '1'};">${isPurchasing ? 'Зарежда...' : isLoggedIn ? 'Купи пакет' : 'Влез за покупка'}</button>
            </div>
          </article>
        `
      }).join('')}
    </section>
    ${isLoggedIn ? `
      <section style="margin:0 12px 16px;border-top:1px solid rgba(212,165,32,0.20);padding-top:12px;">
        <button type="button" data-shop-history-toggle="1" style="height:40px;width:100%;border:1px solid rgba(255,255,255,0.14);border-radius:8px;background:#080808;color:#f8fafc;font-size:13px;font-weight:900;">${state.shopPurchasesVisible ? 'Скрий историята' : 'Покажи историята'}</button>
        ${state.shopPurchasesVisible ? `<div style="margin-top:10px;display:grid;gap:8px;">${state.shopPurchases.length === 0 ? renderMobileStateMessage('Още няма покупки.') : state.shopPurchases.map((purchase) => {
          const isActionPurchase = state.shopPurchaseActionPurchaseId === purchase.purchaseId
          const isHideConfirm = state.shopPurchaseHideConfirmId === purchase.purchaseId
          const canPay = purchase.status === 'pending'
          const disableButtons = isActionPurchase || state.shopPurchaseActionPurchaseId !== null
          return `<div style="border:1px solid rgba(255,255,255,0.10);border-radius:8px;background:#080808;padding:10px;"><div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;"><div style="min-width:0;"><div style="font-size:13px;font-weight:900;color:#ffffff;">${escapeHtml(purchase.title)}</div><div style="margin-top:4px;font-size:12px;font-weight:800;color:${getPurchaseStatusColor(purchase.status)};">${formatAmount(purchase.yellowCoinsAmount)} · ${escapeHtml(formatPurchaseStatusLabel(purchase.status))}</div></div><div style="display:flex;align-items:center;gap:5px;flex-shrink:0;">${canPay ? `<button type="button" data-shop-purchase-resume="${escapeHtml(purchase.purchaseId)}" ${disableButtons ? 'disabled' : ''} style="height:28px;padding:0 8px;border:0;border-radius:5px;background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;font-size:11px;font-weight:900;cursor:${disableButtons ? 'wait' : 'pointer'};opacity:${disableButtons ? '0.6' : '1'};">${isActionPurchase ? '...' : 'Плати'}</button>` : ''}${isHideConfirm ? `<span style="font-size:10px;font-weight:800;color:rgba(255,255,255,0.65);">${purchase.status === 'pending' ? 'Отмени плащането?' : 'Премахни от историята?'}</span><button type="button" data-shop-purchase-hide-confirm="${escapeHtml(purchase.purchaseId)}" style="height:26px;padding:0 7px;border:1px solid rgba(255,80,80,0.5);border-radius:5px;background:rgba(255,80,80,0.12);color:#fca5a5;font-size:11px;font-weight:900;cursor:pointer;">Да</button><button type="button" data-shop-purchase-hide-cancel="1" style="height:26px;padding:0 7px;border:1px solid rgba(255,255,255,0.14);border-radius:5px;background:transparent;color:rgba(255,255,255,0.45);font-size:11px;font-weight:900;cursor:pointer;">Не</button>` : `<button type="button" data-shop-purchase-hide="${escapeHtml(purchase.purchaseId)}" ${disableButtons ? 'disabled' : ''} style="width:26px;height:26px;border:1px solid rgba(255,255,255,0.14);border-radius:5px;background:transparent;color:rgba(255,255,255,0.38);font-size:14px;font-weight:700;cursor:${disableButtons ? 'default' : 'pointer'};display:flex;align-items:center;justify-content:center;line-height:1;opacity:${disableButtons ? '0.4' : '1'};" title="Скрий от историята">×</button>`}</div></div></div>`
        }).join('')}</div>` : ''}
      </section>
    ` : ''}
  `
}

function renderMobileFriendsDirectory(state: LobbyScreenState): string {
  if (state.friendsLoading) return `${renderMobilePageTitle('Приятели')}${renderMobileStateMessage('Зареждане на приятели...')}`
  if (state.friendsErrorText) return `${renderMobilePageTitle('Приятели')}${renderMobileStateMessage(state.friendsErrorText, 'error')}`

  const friendships = state.friendships ?? { incomingPending: [], outgoingPending: [], friends: [] }

  return `
    ${renderMobilePageTitle('Приятели', `${formatAmount(friendships.friends.length)} приятели`)}
    <section style="padding:12px;display:grid;gap:14px;">
      ${renderMobileFriendSection('Покани към теб', 'Няма нови покани.', friendships.incomingPending, 'incoming')}
      ${renderMobileFriendSection('Изпратени покани', 'Няма изпратени покани.', friendships.outgoingPending, 'outgoing')}
      ${renderMobileFriendSection('Списък приятели', 'Все още нямаш добавени приятели.', friendships.friends, 'friend')}
    </section>
  `
}

function renderMobileFriendSection(
  title: string,
  emptyText: string,
  relationships: FriendRelationshipSnapshot[],
  variant: 'incoming' | 'outgoing' | 'friend',
): string {
  return `
    <section style="display:grid;gap:9px;">
      <div style="display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid rgba(212,165,32,0.18);padding-bottom:7px;">
        <div style="font-size:16px;font-weight:900;color:#f8fafc;">${escapeHtml(title)}</div>
        <div style="font-size:12px;font-weight:900;color:#d4a520;">${formatAmount(relationships.length)}</div>
      </div>
      ${relationships.length === 0 ? `<div style="border:1px dashed rgba(255,255,255,0.14);border-radius:8px;background:#080808;padding:14px;color:rgba(255,255,255,0.58);font-size:13px;font-weight:800;text-align:center;">${escapeHtml(emptyText)}</div>` : relationships.map((relationship) => renderMobileFriendCard(relationship, variant)).join('')}
    </section>
  `
}

function renderMobileFriendCard(
  relationship: FriendRelationshipSnapshot,
  variant: 'incoming' | 'outgoing' | 'friend',
): string {
  const profile = relationship.profile
  const displayName = profile.displayName?.trim() || 'Играч'
  const profileId = profile.profileId ?? ''

  return `
    <div style="border:1px solid rgba(212,165,32,0.26);border-radius:8px;background:#080808;padding:10px;display:grid;gap:10px;">
      <button type="button" data-lobby-friend-profile="${escapeHtml(profileId)}" style="display:flex;align-items:center;gap:10px;border:0;background:transparent;color:#ffffff;text-align:left;padding:0;min-width:0;">
        <div style="position:relative;width:52px;height:52px;flex:0 0 auto;">
          <div style="width:100%;height:100%;border-radius:8px;border:1px solid rgba(212,165,32,0.48);background:#101010;overflow:hidden;display:flex;align-items:center;justify-content:center;color:#d4a520;font-size:20px;font-weight:900;">${renderFriendAvatar(profile)}</div>
          ${renderLevelBadge(profile.level, 'sm')}
        </div>
        <div style="min-width:0;flex:1;">
          <div style="font-size:15px;font-weight:900;color:#f8fafc;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(displayName)}</div>
          <div style="margin-top:4px;font-size:12px;font-weight:800;color:rgba(255,255,255,0.54);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(profile.rankTitle ?? 'Ранг 1')}</div>
        </div>
      </button>
      ${variant === 'incoming' ? `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
          <button type="button" data-lobby-friend-accept="${escapeHtml(relationship.friendshipId)}" style="height:38px;border:0;border-radius:8px;background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;font-size:13px;font-weight:900;">Приеми</button>
          <button type="button" data-lobby-friend-reject="${escapeHtml(relationship.friendshipId)}" style="height:38px;border:1px solid rgba(255,255,255,0.14);border-radius:8px;background:#050505;color:#f8fafc;font-size:13px;font-weight:900;">Откажи</button>
        </div>
      ` : variant === 'friend' ? `
        <button type="button" data-lobby-friend-remove="${escapeHtml(relationship.friendshipId)}" style="height:36px;border:1px solid rgba(248,113,113,0.36);border-radius:8px;background:rgba(127,29,29,0.22);color:#fecaca;font-size:12px;font-weight:900;">Премахни</button>
      ` : `<div style="font-size:12px;font-weight:900;color:rgba(255,255,255,0.54);">Изчаква отговор</div>`}
      ${variant === 'outgoing' ? `
        <button type="button" data-lobby-friend-cancel="${escapeHtml(relationship.friendshipId)}" style="height:36px;border:1px solid rgba(248,113,113,0.36);border-radius:8px;background:rgba(127,29,29,0.22);color:#fecaca;font-size:12px;font-weight:900;">Отмени покана</button>
      ` : ''}
    </div>
  `
}

function renderMobileChatPanel(state: LobbyScreenState): string {
  if (state.chatLoading) return `${renderMobilePageTitle('Чат')}${renderMobileStateMessage('Зареждане на чат...')}`

  const sortedConversations = [...state.chatConversations].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  )
  const activeConversation = sortedConversations.find(
    (conversation) => conversation.friendshipId === state.activeChatFriendshipId,
  ) ?? sortedConversations[0] ?? null

  return `
    ${renderMobilePageTitle('Чат', 'Само между приятели')}
    <section style="padding:12px;display:grid;gap:10px;">
      <div style="display:flex;gap:8px;overflow-x:auto;-webkit-overflow-scrolling:touch;">
        ${sortedConversations.length === 0 ? `<div style="color:rgba(255,255,255,0.58);font-size:13px;font-weight:800;padding:8px;">Добави приятели, за да започнеш чат.</div>` : sortedConversations.map((conversation) => {
          const isActive = activeConversation?.friendshipId === conversation.friendshipId
          const displayName = conversation.friend.displayName?.trim() || 'Играч'
          const avatarUrl = conversation.friend.avatarUrl?.trim() ?? ''
          return `<button type="button" data-lobby-chat-conversation="${escapeHtml(conversation.friendshipId)}" style="flex:0 0 88px;border:1px solid ${isActive ? 'rgba(212,165,32,0.72)' : 'rgba(255,255,255,0.12)'};border-radius:8px;background:#080808;color:#ffffff;padding:8px;display:grid;gap:6px;justify-items:center;"><div style="width:44px;height:44px;border-radius:8px;background:#101010;overflow:hidden;display:flex;align-items:center;justify-content:center;color:#d4a520;font-weight:900;">${avatarUrl ? `<img src="${escapeHtml(avatarUrl)}" alt="" style="width:100%;height:100%;object-fit:cover;">` : escapeHtml(displayName.charAt(0).toUpperCase() || '?')}</div><div style="max-width:72px;font-size:11px;font-weight:900;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(displayName)}</div>${conversation.unreadCount > 0 ? `<div style="font-size:10px;font-weight:900;color:#fca5a5;">${conversation.unreadCount} нови</div>` : ''}</button>`
        }).join('')}
      </div>

      <div style="border:1px solid rgba(212,165,32,0.28);border-radius:8px;background:#080808;overflow:hidden;">
        ${activeConversation === null ? `<div style="min-height:240px;display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,0.58);font-size:14px;font-weight:800;text-align:center;padding:18px;">Избери приятел от списъка.</div>` : `
          <div style="padding:10px 12px;border-bottom:1px solid rgba(212,165,32,0.20);font-size:15px;font-weight:900;color:#ffffff;">${escapeHtml(activeConversation.friend.displayName ?? 'Играч')}</div>
          <div data-chat-messages-scroll="1" style="height:360px;overflow-y:auto;padding:10px;display:flex;flex-direction:column;gap:6px;">
            ${state.chatMessagesLoading ? `<div style="margin:auto;color:#d4a520;font-size:14px;font-weight:900;">Зареждане...</div>` : state.chatMessages.length === 0 ? `<div style="margin:auto;color:rgba(255,255,255,0.58);font-size:14px;font-weight:800;text-align:center;">Няма съобщения.</div>` : state.chatMessages.map((message) => `<div style="align-self:${message.isOwnMessage ? 'flex-end' : 'flex-start'};max-width:82%;"><div style="border-radius:8px;background:${message.isOwnMessage ? 'linear-gradient(180deg,#f4c95b 0%,#c98f13 100%)' : 'rgba(255,255,255,0.08)'};color:${message.isOwnMessage ? '#080808' : '#f8fafc'};padding:7px 9px;font-size:13px;font-weight:800;line-height:1.35;word-break:break-word;">${renderMessageBody(message.body)}</div><div style="margin-top:2px;font-size:10px;font-weight:800;color:rgba(255,255,255,0.38);text-align:${message.isOwnMessage ? 'right' : 'left'};">${escapeHtml(formatChatTime(message.createdAt))}</div></div>`).join('')}
          </div>
          <form data-lobby-chat-form="${escapeHtml(activeConversation.friendshipId)}" style="display:flex;gap:8px;padding:10px;border-top:1px solid rgba(212,165,32,0.20);">
            <input name="message" maxlength="1000" autocomplete="off" placeholder="Съобщение..." style="height:40px;flex:1;min-width:0;border-radius:8px;border:1px solid rgba(212,165,32,0.34);background:#050505;color:#ffffff;padding:0 10px;font-size:14px;font-weight:700;outline:none;">
            <button type="submit" style="height:40px;padding:0 12px;border:0;border-radius:8px;background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;font-size:13px;font-weight:900;">Изпрати</button>
          </form>
        `}
      </div>
    </section>
  `
}

function renderPublicLegalPage(pageKey: PublicLegalPageKey, isMobile = false): string {
  const page = PUBLIC_LEGAL_PAGES[pageKey]
  const contentHtml = renderPublicLegalBodyHtml(pageKey, isMobile)
  const contactActionHtml = pageKey === 'contact'
    ? `
      <button type="button" data-public-contact-mail="1" style="
        margin-top:${isMobile ? '12px' : '18px'};
        min-height:${isMobile ? '44px' : '48px'};
        padding:0 ${isMobile ? '16px' : '20px'};
        border:1px solid rgba(244,201,91,0.72);
        border-radius:8px;
        background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);
        color:#080808;
        font-size:${isMobile ? '13px' : '14px'};
        font-weight:900;
        cursor:pointer;
        display:inline-flex;
        align-items:center;
        justify-content:center;
        gap:10px;
        box-shadow:0 8px 22px rgba(212,165,32,0.16);
      ">
        <svg xmlns="http://www.w3.org/2000/svg" width="${isMobile ? '19' : '21'}" height="${isMobile ? '19' : '21'}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" style="flex:0 0 auto;"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>
        Пиши на екипа
      </button>
      <style>
        [data-public-contact-mail="1"]:hover {
          border-color:#ffe08a !important;
          background:linear-gradient(180deg,#ffe08a 0%,#d9a11d 100%) !important;
          box-shadow:0 10px 28px rgba(244,201,91,0.26) !important;
          transform:translateY(-1px);
        }
        [data-public-contact-mail="1"]:active {
          transform:translateY(0);
        }
      </style>
    `
    : ''

  return `
    <section style="
      min-height:${isMobile ? 'auto' : '560px'};
      border:1px solid rgba(212,165,32,0.26);
      border-radius:8px;
      background:linear-gradient(180deg,#0b0b0b 0%,#050505 100%);
      padding:${isMobile ? '18px 14px' : '34px 42px'};
      box-sizing:border-box;
    ">
      <div style="max-width:980px;margin:0 auto;">
        <div style="border-bottom:1px solid rgba(212,165,32,0.22);padding-bottom:${isMobile ? '14px' : '18px'};margin-bottom:${isMobile ? '18px' : '26px'};">
          <h1 style="margin:0;color:#ffffff;font-size:${isMobile ? '24px' : '34px'};line-height:1.05;font-weight:900;">${escapeHtml(page.title)}</h1>
          <div style="margin-top:8px;color:rgba(255,255,255,0.48);font-size:${isMobile ? '12px' : '13px'};font-weight:800;">Pika.bg</div>
        </div>
        <article style="overflow-wrap:anywhere;">
          ${contentHtml}
        </article>
        ${contactActionHtml}
      </div>
    </section>
  `
}

function renderMobileLobbyScreenContent(
  state: LobbyScreenState,
  profileName: string,
  canStartSearch: boolean,
): string {
  if (state.view !== 'tables') {
    return `
      <main style="padding:12px;">
        ${state.view === 'support'
          ? renderAdminSupportPage(state)
          : state.view === 'guest-contact-messages'
          ? renderAdminGuestContactMessagesPage(state, true)
          : state.view === 'private-rooms'
          ? renderPrivateRoomsPage(state)
          : state.view === 'players'
          ? renderMobilePlayersDirectory(state)
          : state.view === 'leaderboards'
            ? renderMobileLeaderboardsDirectory(state)
          : state.view === 'shop'
            ? renderMobileShopPanel(state)
          : state.view === 'admin'
            ? renderAdminPanel(state, true)
          : state.view === 'admin-info'
            ? renderAdminInfoPanel(state)
          : state.view === 'admin-server'
            ? renderAdminServerPanel(state)
          : state.view === 'admin-visitors'
            ? renderAdminVisitorsPanel(state)
          : state.view === 'admin-payments'
            ? renderAdminPaymentsPanel(
                {
                  isAdmin: state.isAdmin,
                  period: state.adminPaymentsPeriod,
                  loading: state.adminPaymentsLoading,
                  errorText: state.adminPaymentsErrorText,
                  rows: state.adminPaymentsRows,
                  total: state.adminPaymentsTotal,
                  totalsByCurrency: state.adminPaymentsTotalsByCurrency,
                  offset: state.adminPaymentsOffset,
                  limit: state.adminPaymentsLimit,
                },
                { onBack: () => {}, onPeriodChange: () => {}, onPageChange: () => {}, onDetailOpen: () => {} },
              )
          : state.view === 'admin-payment-detail'
            ? renderAdminPaymentDetailPanel(
                {
                  isAdmin: state.isAdmin,
                  loading: state.adminPaymentDetailLoading,
                  errorText: state.adminPaymentDetailErrorText,
                  purchase: state.adminPaymentDetailPurchase,
                },
                { onBack: () => {} },
              )
          : state.view === 'friends'
            ? renderMobileFriendsDirectory(state)
          : state.view === 'chat'
            ? renderMobileChatPanel(state)
          : state.view === 'terms' || state.view === 'privacy' || state.view === 'contact'
            ? renderPublicLegalPage(state.view, true)
          : state.view === 'rules'
            ? renderRulesPage(true)
          : state.view === 'strategy'
            ? renderStrategyPage(true)
          : state.view === 'learn'
            ? renderLearnPage(true)
          : state.view === 'faq'
            ? renderFaqPage(true)
          : state.view === 'about'
            ? renderAboutPage(true)
          : state.view === 'fair-play'
            ? renderFairPlayPage(true)
          : ''}
      </main>
    `
  }

  return `
    <main>
      ${state.profile.profileId !== null
        ? renderMobileProfileCard(state, profileName)
        : renderMobileGuestCard(state.signupBonusYellowCoins ?? 0)}
      ${renderMobileStakeSection(state.selectedStake, canStartSearch, state.isSearching, state.matchRooms, state.profile.level ?? 1, state.matchRoomsLoading, state.profile.profileId === null)}
      ${renderMobileOffersSection(state.lobbyPackages, state.profile.profileId !== null)}
      ${renderMobileQuickActions(state.dailyMissionsUnclaimedCount, getUnclaimedDailyRewardsBadgeCount(state) > 0)}
    </main>
  `
}

function renderFooter(): string {
  return `
    <footer style="
      margin-top:16px;
      border-top:1px solid rgba(255,255,255,0.07);
      padding:16px 0;
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:18px;
    ">
      <style>
        [data-lobby-footer-legal-link="1"]:hover {
          color:#f4c95b !important;
          text-decoration:underline !important;
          text-underline-offset:3px;
        }
      </style>
      <nav aria-label="Правни връзки" style="display:flex;align-items:center;justify-content:center;gap:0;flex-wrap:wrap;text-align:center;">
        <a data-lobby-footer-legal-link="1" href="/rules" style="color:rgba(255,255,255,0.52);font-size:11px;font-weight:700;text-decoration:none;padding:0 12px;transition:color 0.15s ease,text-decoration-color 0.15s ease;">Правила</a>
        <span aria-hidden="true" style="width:1px;height:13px;background:rgba(212,165,32,0.72);display:block;"></span>
        <a data-lobby-footer-legal-link="1" href="/strategy" style="color:rgba(255,255,255,0.52);font-size:11px;font-weight:700;text-decoration:none;padding:0 12px;transition:color 0.15s ease,text-decoration-color 0.15s ease;">Съвети и стратегии</a>
        <span aria-hidden="true" style="width:1px;height:13px;background:rgba(212,165,32,0.72);display:block;"></span>
        <a data-lobby-footer-legal-link="1" href="/learn" style="color:rgba(255,255,255,0.52);font-size:11px;font-weight:700;text-decoration:none;padding:0 12px;transition:color 0.15s ease,text-decoration-color 0.15s ease;">Научи белот</a>
        <span aria-hidden="true" style="width:1px;height:13px;background:rgba(212,165,32,0.72);display:block;"></span>
        <a data-lobby-footer-legal-link="1" href="/fair-play" style="color:rgba(255,255,255,0.52);font-size:11px;font-weight:700;text-decoration:none;padding:0 12px;transition:color 0.15s ease,text-decoration-color 0.15s ease;">Честна игра</a>
        <span aria-hidden="true" style="width:1px;height:13px;background:rgba(212,165,32,0.72);display:block;"></span>
        <a data-lobby-footer-legal-link="1" href="/faq" style="color:rgba(255,255,255,0.52);font-size:11px;font-weight:700;text-decoration:none;padding:0 12px;transition:color 0.15s ease,text-decoration-color 0.15s ease;">Често задавани въпроси</a>
        <span aria-hidden="true" style="width:1px;height:13px;background:rgba(212,165,32,0.72);display:block;"></span>
        <a data-lobby-footer-legal-link="1" href="/about" style="color:rgba(255,255,255,0.52);font-size:11px;font-weight:700;text-decoration:none;padding:0 12px;transition:color 0.15s ease,text-decoration-color 0.15s ease;">За Pika.bg</a>
        <span aria-hidden="true" style="width:1px;height:13px;background:rgba(212,165,32,0.72);display:block;"></span>
        <a data-lobby-footer-legal-link="1" href="/terms" style="color:rgba(255,255,255,0.52);font-size:11px;font-weight:700;text-decoration:none;padding:0 12px;transition:color 0.15s ease,text-decoration-color 0.15s ease;">Общи условия</a>
        <span aria-hidden="true" style="width:1px;height:13px;background:rgba(212,165,32,0.72);display:block;"></span>
        <a data-lobby-footer-legal-link="1" href="/privacy" style="color:rgba(255,255,255,0.52);font-size:11px;font-weight:700;text-decoration:none;padding:0 12px;transition:color 0.15s ease,text-decoration-color 0.15s ease;">Политика за поверителност</a>
        <span aria-hidden="true" style="width:1px;height:13px;background:rgba(212,165,32,0.72);display:block;"></span>
        <a data-lobby-footer-legal-link="1" href="/contact" style="color:rgba(255,255,255,0.52);font-size:11px;font-weight:700;text-decoration:none;padding:0 12px;transition:color 0.15s ease,text-decoration-color 0.15s ease;">Контакти</a>
      </nav>
      <div style="color:rgba(255,255,255,0.52);font-size:13px;font-weight:700;white-space:nowrap;">
        © Pika.bg 2026 · Всички права запазени
      </div>
    </footer>
  `
}

function renderMobileFooter(): string {
  return `
    <footer style="
      margin:18px 12px 24px;
      border-top:1px solid rgba(255,255,255,0.07);
      padding-top:14px;
      display:flex;
      align-items:center;
      justify-content:center;
      text-align:center;
    ">
      <style>
        [data-lobby-mobile-footer-legal-link="1"]:hover {
          color:#f4c95b !important;
          text-decoration:underline !important;
          text-underline-offset:3px;
        }
      </style>
      <nav aria-label="Правни връзки" style="display:flex;align-items:center;justify-content:center;gap:0;flex-wrap:wrap;">
        <a data-lobby-mobile-footer-legal-link="1" href="/rules" style="color:rgba(255,255,255,0.52);font-size:11px;font-weight:700;text-decoration:none;padding:0 12px;transition:color 0.15s ease,text-decoration-color 0.15s ease;">Правила</a>
        <span aria-hidden="true" style="width:1px;height:13px;background:rgba(212,165,32,0.72);display:block;"></span>
        <a data-lobby-mobile-footer-legal-link="1" href="/strategy" style="color:rgba(255,255,255,0.52);font-size:11px;font-weight:700;text-decoration:none;padding:0 12px;transition:color 0.15s ease,text-decoration-color 0.15s ease;">Съвети и стратегии</a>
        <span aria-hidden="true" style="width:1px;height:13px;background:rgba(212,165,32,0.72);display:block;"></span>
        <a data-lobby-mobile-footer-legal-link="1" href="/learn" style="color:rgba(255,255,255,0.52);font-size:11px;font-weight:700;text-decoration:none;padding:0 12px;transition:color 0.15s ease,text-decoration-color 0.15s ease;">Научи белот</a>
        <span aria-hidden="true" style="width:1px;height:13px;background:rgba(212,165,32,0.72);display:block;"></span>
        <a data-lobby-mobile-footer-legal-link="1" href="/fair-play" style="color:rgba(255,255,255,0.52);font-size:11px;font-weight:700;text-decoration:none;padding:0 12px;transition:color 0.15s ease,text-decoration-color 0.15s ease;">Честна игра</a>
        <span aria-hidden="true" style="width:1px;height:13px;background:rgba(212,165,32,0.72);display:block;"></span>
        <a data-lobby-mobile-footer-legal-link="1" href="/faq" style="color:rgba(255,255,255,0.52);font-size:11px;font-weight:700;text-decoration:none;padding:0 12px;transition:color 0.15s ease,text-decoration-color 0.15s ease;">Често задавани въпроси</a>
        <span aria-hidden="true" style="width:1px;height:13px;background:rgba(212,165,32,0.72);display:block;"></span>
        <a data-lobby-mobile-footer-legal-link="1" href="/about" style="color:rgba(255,255,255,0.52);font-size:11px;font-weight:700;text-decoration:none;padding:0 12px;transition:color 0.15s ease,text-decoration-color 0.15s ease;">За Pika.bg</a>
        <span aria-hidden="true" style="width:1px;height:13px;background:rgba(212,165,32,0.72);display:block;"></span>
        <a data-lobby-mobile-footer-legal-link="1" href="/terms" style="color:rgba(255,255,255,0.52);font-size:11px;font-weight:700;text-decoration:none;padding:0 12px;transition:color 0.15s ease,text-decoration-color 0.15s ease;">Общи условия</a>
        <span aria-hidden="true" style="width:1px;height:13px;background:rgba(212,165,32,0.72);display:block;"></span>
        <a data-lobby-mobile-footer-legal-link="1" href="/privacy" style="color:rgba(255,255,255,0.52);font-size:11px;font-weight:700;text-decoration:none;padding:0 12px;transition:color 0.15s ease,text-decoration-color 0.15s ease;">Политика за поверителност</a>
        <span aria-hidden="true" style="width:1px;height:13px;background:rgba(212,165,32,0.72);display:block;"></span>
        <a data-lobby-mobile-footer-legal-link="1" href="/contact" style="color:rgba(255,255,255,0.52);font-size:11px;font-weight:700;text-decoration:none;padding:0 12px;transition:color 0.15s ease,text-decoration-color 0.15s ease;">Контакти</a>
      </nav>
    </footer>
  `
}

function renderFriendAvatar(profile: PlayerPublicProfileSnapshot): string {
  const displayName = profile.displayName?.trim() || 'Играч'
  const avatarUrl = profile.avatarUrl?.trim() ?? ''
  const fallbackLetter = escapeHtml(displayName.charAt(0).toUpperCase() || '?')

  if (avatarUrl) {
    return `<img src="${escapeHtml(avatarUrl)}" alt="" style="width:100%;height:100%;object-fit:cover;display:block;">`
  }

  return fallbackLetter
}

function renderFriendRelationshipCard(
  relationship: FriendRelationshipSnapshot,
  variant: 'incoming' | 'outgoing' | 'friend',
): string {
  const profile = relationship.profile
  const displayName = profile.displayName?.trim() || 'Играч'
  const profileId = profile.profileId ?? ''

  return `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;border:1px solid rgba(212,165,32,0.26);border-radius:8px;background:linear-gradient(180deg,#141414 0%,#050505 100%);padding:12px;">
      <button type="button" data-lobby-friend-profile="${escapeHtml(profileId)}" style="display:flex;align-items:center;gap:12px;min-width:0;border:0;background:transparent;color:#ffffff;text-align:left;cursor:pointer;padding:0;flex:1;">
        <div style="position:relative;width:52px;height:52px;flex:0 0 auto;">
          <div style="width:100%;height:100%;border-radius:8px;border:1px solid rgba(212,165,32,0.54);background:#101010;overflow:hidden;display:flex;align-items:center;justify-content:center;color:#d4a520;font-size:21px;font-weight:900;">
            ${renderFriendAvatar(profile)}
          </div>
          ${renderLevelBadge(profile.level, 'sm')}
        </div>
        <div style="min-width:0;">
          <div style="font-size:15px;font-weight:900;color:#f8fafc;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(displayName)}</div>
          <div style="margin-top:4px;font-size:12px;font-weight:800;color:rgba(255,255,255,0.54);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(profile.rankTitle ?? 'Ранг 1')}</div>
        </div>
      </button>
      ${variant === 'incoming' ? `
        <div style="display:flex;align-items:center;gap:8px;flex:0 0 auto;">
          <button type="button" data-lobby-friend-accept="${escapeHtml(relationship.friendshipId)}" style="height:36px;padding:0 12px;border:0;border-radius:8px;background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;font-size:13px;font-weight:900;cursor:pointer;">Приеми</button>
          <button type="button" data-lobby-friend-reject="${escapeHtml(relationship.friendshipId)}" style="height:36px;padding:0 12px;border:1px solid rgba(255,255,255,0.14);border-radius:8px;background:#080808;color:#f8fafc;font-size:13px;font-weight:900;cursor:pointer;">Откажи</button>
        </div>
      ` : `
        <div style="font-size:12px;font-weight:900;color:${variant === 'friend' ? '#fde68a' : 'rgba(255,255,255,0.54)'};white-space:nowrap;">
          ${variant === 'friend' ? 'Приятел' : 'Изчаква отговор'}
        </div>
      `}
      ${variant === 'friend' ? `
        <button type="button" data-lobby-friend-remove="${escapeHtml(relationship.friendshipId)}" style="height:34px;padding:0 10px;border:1px solid rgba(248,113,113,0.36);border-radius:8px;background:rgba(127,29,29,0.22);color:#fecaca;font-size:12px;font-weight:900;cursor:pointer;flex:0 0 auto;">Премахни</button>
      ` : ''}
      ${variant === 'outgoing' ? `
        <button type="button" data-lobby-friend-cancel="${escapeHtml(relationship.friendshipId)}" style="height:34px;padding:0 10px;border:1px solid rgba(248,113,113,0.36);border-radius:8px;background:rgba(127,29,29,0.22);color:#fecaca;font-size:12px;font-weight:900;cursor:pointer;flex:0 0 auto;">Отмени покана</button>
      ` : ''}
    </div>
  `
}

function renderFriendSection(
  title: string,
  emptyText: string,
  relationships: FriendRelationshipSnapshot[],
  variant: 'incoming' | 'outgoing' | 'friend',
): string {
  return `
    <section style="display:grid;gap:10px;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;border-bottom:1px solid rgba(212,165,32,0.20);padding-bottom:8px;">
        <div style="font-size:17px;font-weight:900;color:#f8fafc;">${escapeHtml(title)}</div>
        <div style="font-size:12px;font-weight:900;color:#d4a520;">${formatAmount(relationships.length)}</div>
      </div>
      ${relationships.length === 0 ? `
        <div style="border:1px dashed rgba(255,255,255,0.14);border-radius:8px;background:rgba(255,255,255,0.03);padding:18px;color:rgba(255,255,255,0.58);font-size:13px;font-weight:800;text-align:center;">
          ${escapeHtml(emptyText)}
        </div>
      ` : `
        <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;">
          ${relationships.map((relationship) => renderFriendRelationshipCard(relationship, variant)).join('')}
        </div>
      `}
    </section>
  `
}

function renderFriendsDirectory(state: LobbyScreenState): string {
  if (state.friendsLoading) {
    return `
      <div style="min-height:520px;display:flex;align-items:center;justify-content:center;border:1px solid rgba(212,165,32,0.34);background:#050505;border-radius:8px;color:#d4a520;font-size:18px;font-weight:900;">
        Зареждане на приятели...
      </div>
    `
  }

  if (state.friendsErrorText) {
    return `
      <div style="min-height:520px;display:flex;align-items:center;justify-content:center;border:1px solid rgba(248,113,113,0.34);background:rgba(127,29,29,0.28);border-radius:8px;color:#fecaca;font-size:15px;font-weight:800;text-align:center;padding:20px;">
        ${escapeHtml(state.friendsErrorText)}
      </div>
    `
  }

  const friendships = state.friendships ?? {
    incomingPending: [],
    outgoingPending: [],
    friends: [],
  }

  return `
    <section style="min-height:520px;display:grid;gap:18px;align-content:start;">
      <div style="display:flex;align-items:end;justify-content:space-between;gap:16px;border-bottom:1px solid rgba(212,165,32,0.28);padding-bottom:12px;">
        <div>
          <div style="font-size:26px;line-height:1.05;font-weight:900;color:#f8fafc;">Приятели</div>
          <div style="margin-top:6px;font-size:13px;font-weight:700;color:rgba(255,255,255,0.56);">Покани, чакащи отговори и приети приятелства.</div>
        </div>
        <div style="font-size:13px;font-weight:900;color:#d4a520;">${formatAmount(friendships.friends.length)} приятели</div>
      </div>

      ${renderFriendSection('Покани към теб', 'Няма нови покани.', friendships.incomingPending, 'incoming')}
      ${renderFriendSection('Изпратени покани', 'Няма изпратени покани.', friendships.outgoingPending, 'outgoing')}
      ${renderFriendSection('Списък приятели', 'Все още нямаш добавени приятели.', friendships.friends, 'friend')}
    </section>
  `
}

const CHAT_EMOJIS = Array.from({ length: 24 }, (_, i) => {
  const n = String(i + 1).padStart(2, '0')
  return {
    code: `[e:${n}]`,
    preview: `/assets/animated-emoji/preview/preview-emoji-${n}.png`,
    animated: `/assets/animated-emoji/emoji-${n}.webp`,
  }
})

function renderMessageBody(body: string): string {
  return body.split(/(\[e:\d{2}\])/).map((part) => {
    const match = /^\[e:(\d{2})\]$/.exec(part)
    if (match) {
      return `<img src="/assets/animated-emoji/emoji-${match[1]}.webp" alt="" style="width:28px;height:28px;vertical-align:middle;display:inline-block;">`
    }
    return escapeHtml(part)
  }).join('')
}

function formatChatTime(value: string): string {
  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return ''
  }

  return new Intl.DateTimeFormat('bg-BG', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function renderChatPanel(state: LobbyScreenState): string {
  if (state.chatLoading) {
    return `
      <div style="min-height:520px;display:flex;align-items:center;justify-content:center;border:1px solid rgba(212,165,32,0.34);background:#050505;border-radius:8px;color:#d4a520;font-size:18px;font-weight:900;">
        Зареждане на чат...
      </div>
    `
  }

  const sortedConversations = [...state.chatConversations].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  )

  const activeConversation = sortedConversations.find(
    (conversation) => conversation.friendshipId === state.activeChatFriendshipId,
  ) ?? sortedConversations[0] ?? null

  return `
    <section style="min-height:520px;display:grid;grid-template-columns:300px minmax(0,1fr) 250px;gap:14px;align-content:start;">
      <div style="border:1px solid rgba(212,165,32,0.30);border-radius:8px;background:#050505;overflow:hidden;display:flex;flex-direction:column;max-height:560px;">
        <div style="padding:14px 16px;border-bottom:1px solid rgba(212,165,32,0.24);flex-shrink:0;">
          <div style="font-size:22px;font-weight:900;color:#f8fafc;">Чат</div>
          <div style="margin-top:5px;font-size:12px;font-weight:800;color:rgba(255,255,255,0.54);">Само между приятели. Недостъпен по време на игра.</div>
        </div>
        ${sortedConversations.length === 0 ? `
          <div style="padding:24px 16px;color:rgba(255,255,255,0.62);font-size:14px;font-weight:800;text-align:center;">
            Добави приятели, за да започнеш чат.
          </div>
        ` : `
          <div style="overflow-y:auto;flex:1;scrollbar-width:thin;scrollbar-color:#d4a520 #111111;">
            ${sortedConversations.map((conversation) => {
              const isActive = activeConversation?.friendshipId === conversation.friendshipId
              const displayName = conversation.friend.displayName?.trim() || 'Играч'
              const avatarUrl = conversation.friend.avatarUrl?.trim() ?? ''
              const preview = conversation.lastMessage?.body ?? 'Няма съобщения'
              const isOnline = conversation.friend.isOnline

              return `
                <button type="button" data-lobby-chat-conversation="${escapeHtml(conversation.friendshipId)}" style="display:flex;align-items:center;gap:12px;width:100%;border:0;border-bottom:1px solid rgba(255,255,255,0.06);background:${isActive ? 'rgba(212,165,32,0.12)' : 'transparent'};color:#ffffff;text-align:left;padding:12px 14px;cursor:pointer;min-width:0;box-sizing:border-box;">
                  <div style="position:relative;width:46px;height:46px;flex:0 0 auto;">
                    <div style="width:46px;height:46px;border-radius:8px;border:1px solid rgba(212,165,32,0.48);background:#101010;overflow:hidden;display:flex;align-items:center;justify-content:center;color:#d4a520;font-size:19px;font-weight:900;">
                      ${avatarUrl ? `<img src="${escapeHtml(avatarUrl)}" alt="" style="width:100%;height:100%;object-fit:cover;display:block;">` : escapeHtml(displayName.charAt(0).toUpperCase() || '?')}
                    </div>
                    ${isOnline !== undefined ? `<div style="position:absolute;bottom:-2px;right:-2px;width:11px;height:11px;border-radius:50%;background:${isOnline ? '#22c55e' : '#ef4444'};border:2px solid #050505;"></div>` : ''}
                  </div>
                  <div style="min-width:0;flex:1;">
                    <div style="display:flex;align-items:center;gap:6px;">
                      <div style="font-size:14px;font-weight:900;color:#f8fafc;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;">${escapeHtml(displayName)}</div>
                      ${isOnline !== undefined ? '' : ''}
                      ${conversation.unreadCount > 0 ? `<span style="min-width:18px;height:18px;border-radius:9px;background:#ef4444;color:#fff;font-size:10px;font-weight:900;display:flex;align-items:center;justify-content:center;padding:0 4px;flex-shrink:0;">${conversation.unreadCount}</span>` : ''}
                    </div>
                    <div style="margin-top:4px;font-size:12px;font-weight:700;color:${conversation.unreadCount > 0 ? '#ffffff' : 'rgba(255,255,255,0.54)'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(preview)}</div>
                  </div>
                </button>
              `
            }).join('')}
          </div>
        `}
      </div>

      <div style="border:1px solid rgba(212,165,32,0.30);border-radius:8px;background:linear-gradient(180deg,#111 0%,#050505 100%);min-width:0;overflow:hidden;">
        ${activeConversation === null ? `
          <div style="min-height:520px;display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,0.62);font-size:15px;font-weight:800;text-align:center;padding:20px;">
            Избери приятел от списъка.
          </div>
        ` : `
          <div style="display:flex;align-items:center;gap:12px;padding:14px 16px;border-bottom:1px solid rgba(212,165,32,0.24);">
            <div style="font-size:19px;font-weight:900;color:#f8fafc;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(activeConversation.friend.displayName ?? 'Играч')}</div>
            ${state.chatErrorText ? `<div style="margin-left:auto;color:#fecaca;font-size:12px;font-weight:800;">${escapeHtml(state.chatErrorText)}</div>` : ''}
          </div>
          <div data-chat-messages-scroll="1" style="height:350px;overflow-y:auto;padding:12px 14px;display:flex;flex-direction:column;gap:6px;scrollbar-width:thin;scrollbar-color:#d4a520 #111111;">
            ${state.chatMessagesLoading ? `
              <div style="margin:auto;color:#d4a520;font-size:15px;font-weight:900;">Зареждане...</div>
            ` : state.chatMessages.length === 0 ? `
              <div style="margin:auto;color:rgba(255,255,255,0.58);font-size:14px;font-weight:800;text-align:center;">Няма съобщения. Започни разговора.</div>
            ` : state.chatMessages.map((message) => {
              const isEmojiOnly = /^(\[e:\d{2}\])+$/.test(message.body.trim())
              return `
              <div style="align-self:${message.isOwnMessage ? 'flex-end' : 'flex-start'};max-width:min(72%,620px);display:grid;gap:3px;">
                <div style="${isEmojiOnly
                  ? 'padding:2px;line-height:1;'
                  : `border-radius:8px;background:${message.isOwnMessage ? 'linear-gradient(180deg,#f4c95b 0%,#c98f13 100%)' : 'rgba(255,255,255,0.08)'};color:${message.isOwnMessage ? '#080808' : '#f8fafc'};padding:7px 10px;font-size:14px;font-weight:800;line-height:1.35;word-break:break-word;`}">
                  ${isEmojiOnly
                    ? message.body.trim().replace(/\[e:(\d{2})\]/g, (_, n) => `<img src="/assets/animated-emoji/emoji-${n}.webp" alt="" style="width:52px;height:52px;object-fit:contain;display:inline-block;">`)
                    : renderMessageBody(message.body)}
                </div>
                <div style="font-size:10px;font-weight:800;color:rgba(255,255,255,0.42);text-align:${message.isOwnMessage ? 'right' : 'left'};">${escapeHtml(formatChatTime(message.createdAt))}</div>
              </div>
            `}).join('')}
          </div>
          <form data-lobby-chat-form="${escapeHtml(activeConversation.friendshipId)}" style="display:flex;gap:10px;padding:14px 16px;border-top:1px solid rgba(212,165,32,0.20);">
            <input name="message" maxlength="1000" autocomplete="off" placeholder="Напиши съобщение..." style="height:42px;flex:1;min-width:0;border-radius:8px;border:1px solid rgba(212,165,32,0.34);background:#050505;color:#ffffff;padding:0 12px;font-size:14px;font-weight:700;outline:none;">
            <button type="submit" style="height:42px;padding:0 16px;border:0;border-radius:8px;background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;font-size:14px;font-weight:900;cursor:pointer;">Изпрати</button>
          </form>
        `}
      </div>

      <div style="border:1px solid rgba(212,165,32,0.30);border-radius:8px;background:#050505;overflow-y:auto;padding:6px;scrollbar-width:thin;scrollbar-color:#d4a520 #111111;">
        <div style="display:grid;grid-template-columns:repeat(3,1fr);grid-template-rows:repeat(8,1fr);gap:2px;">
          ${CHAT_EMOJIS.map((emoji) => `
            <button type="button" data-chat-emoji="${escapeHtml(emoji.code)}" style="border:0;background:#0a0a0a;padding:2px;cursor:pointer;border-radius:6px;display:flex;align-items:center;justify-content:center;" onmouseenter="this.style.background='rgba(212,165,32,0.15)'" onmouseleave="this.style.background='#0a0a0a'">
              <img src="${escapeHtml(emoji.preview)}" alt="" style="width:58px;height:58px;object-fit:contain;display:block;">
            </button>
          `).join('')}
        </div>
      </div>
    </section>
  `
}

function renderPlayersDirectory(state: LobbyScreenState): string {
  const { allPlayers, players } = computePlayersDirectoryLists(state, {
    isAdmin: state.isAdmin,
    ownProfileId: state.profile.profileId,
  })

  if (state.playersLoading) {
    return `
      <div style="min-height:520px;display:flex;align-items:center;justify-content:center;border:1px solid rgba(212,165,32,0.34);background:#050505;border-radius:8px;color:#d4a520;font-size:18px;font-weight:900;">
        Зареждане на играчи...
      </div>
    `
  }

  if (state.playersErrorText) {
    return `
      <div style="min-height:520px;display:flex;align-items:center;justify-content:center;border:1px solid rgba(248,113,113,0.34);background:rgba(127,29,29,0.28);border-radius:8px;color:#fecaca;font-size:15px;font-weight:800;text-align:center;padding:20px;">
        ${escapeHtml(state.playersErrorText)}
      </div>
    `
  }

  return `
    <section style="min-height:520px;display:grid;gap:14px;align-content:start;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:16px;border-bottom:1px solid rgba(212,165,32,0.28);padding-bottom:12px;flex-wrap:wrap;">
        <div>
          <div style="font-size:26px;line-height:1.05;font-weight:900;color:#f8fafc;">Всички играчи</div>
          <div style="margin-top:6px;font-size:13px;font-weight:700;color:rgba(255,255,255,0.56);">Профили, ранг, рейтинг и галерия.</div>
        </div>
        <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;">
          <label style="display:flex;align-items:center;gap:10px;background:#0d0d0d;border:1px solid rgba(212,165,32,0.44);border-radius:8px;padding:0 14px;height:44px;min-width:240px;max-width:340px;flex:1 1 240px;">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#d4a520" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input
              data-lobby-players-search="1"
              type="text"
              placeholder="Намери играч"
              value="${escapeHtml(state.playersSearchQuery)}"
              autocomplete="off"
              style="flex:1;min-width:0;background:transparent;border:0;outline:none;color:#f8fafc;font-size:15px;font-weight:700;font-family:inherit;"
            >
          </label>
          <div style="font-size:13px;font-weight:900;color:#d4a520;white-space:nowrap;">${formatAmount(allPlayers.length)} играчи</div>
        </div>
      </div>

      ${allPlayers.length === 0 ? `
        <div style="min-height:360px;display:flex;align-items:center;justify-content:center;border:1px dashed rgba(255,255,255,0.16);background:rgba(255,255,255,0.03);border-radius:8px;color:rgba(255,255,255,0.62);font-size:15px;font-weight:800;">
          Все още няма регистрирани играчи.
        </div>
      ` : players.length === 0 ? `
        <div style="min-height:360px;display:flex;align-items:center;justify-content:center;border:1px dashed rgba(255,255,255,0.16);background:rgba(255,255,255,0.03);border-radius:8px;color:rgba(255,255,255,0.62);font-size:15px;font-weight:800;">
          Няма намерени играчи.
        </div>
      ` : `
        <div style="display:grid;grid-template-columns:repeat(5, minmax(0, 1fr));gap:12px;">
          ${players.map((player) => {
            const displayName = player.displayName?.trim() || 'Играч'
            const avatarUrl = player.avatarUrl?.trim() ?? ''
            const fallbackLetter = escapeHtml(displayName.charAt(0).toUpperCase() || '?')

            return `
              <button type="button" data-lobby-player-card="${escapeHtml(player.profileId ?? '')}" style="display:flex;flex-direction:column;gap:10px;text-align:left;border:1px solid rgba(212,165,32,0.32);border-radius:8px;background:linear-gradient(180deg,#141414 0%,#050505 100%);padding:12px;color:#ffffff;cursor:pointer;min-width:0;">
                <div style="display:flex;align-items:center;gap:10px;min-width:0;">
                  <div style="position:relative;width:100px;height:100px;flex:0 0 auto;">
                    <div style="width:100%;height:100%;border-radius:10px;border:1px solid rgba(212,165,32,0.56);background:#101010;overflow:hidden;display:flex;align-items:center;justify-content:center;color:#d4a520;font-size:38px;font-weight:900;">
                      ${avatarUrl ? `<img src="${escapeHtml(avatarUrl)}" alt="" style="width:100%;height:100%;object-fit:cover;display:block;">` : fallbackLetter}
                    </div>
                    ${renderLevelBadge(player.level, 'sm')}
                  </div>
                  <div style="min-width:0;flex:1;">
                    <div style="font-size:15px;font-weight:900;color:#f8fafc;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(displayName)}</div>
                    <div style="margin-top:3px;display:flex;align-items:center;gap:6px;min-width:0;">
                      <div style="font-size:12px;font-weight:800;color:#d4a520;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(player.rankTitle ?? 'Ранг 1')}</div>
                      ${player.isOnline !== undefined ? `<div style="font-size:11px;font-weight:800;color:${player.isOnline ? '#4ade80' : '#f87171'};white-space:nowrap;flex-shrink:0;">${player.isOnline ? 'Онлайн' : 'Офлайн'}</div>` : ''}
                    </div>
                    <div style="margin-top:8px;display:flex;align-items:center;gap:12px;">
                      <div>
                        <div style="font-size:10px;font-weight:900;text-transform:uppercase;color:rgba(255,255,255,0.44);">Оценка</div>
                        <div style="font-size:14px;font-weight:900;color:#f8fafc;">${typeof player.averageRating === 'number' ? player.averageRating.toFixed(2) : '-'}</div>
                      </div>
                      <div style="width:1px;height:28px;background:rgba(255,255,255,0.10);"></div>
                      <div>
                        <div style="font-size:10px;font-weight:900;text-transform:uppercase;color:rgba(255,255,255,0.44);">Игри</div>
                        <div style="font-size:14px;font-weight:900;color:#f8fafc;">${formatAmount(player.completedGamesCount ?? 0)}</div>
                      </div>
                    </div>
                  </div>
                </div>
              </button>
            `
          }).join('')}
        </div>
      `}
    </section>
  `
}

const LEADERBOARD_TABS: Array<{
  category: LeaderboardCategory
  label: string
  metricLabel: string
}> = [
  { category: 'balance', label: 'Баланс', metricLabel: 'жълтици' },
  { category: 'rank', label: 'Ранг', metricLabel: 'игри' },
  { category: 'wins', label: 'Победи', metricLabel: 'победи' },
  { category: 'rating', label: 'Рейтинг', metricLabel: 'оценка' },
]

function getLeaderboardMetric(
  category: LeaderboardCategory,
  player: PlayerPublicProfileSnapshot,
): string {
  if (category === 'balance') {
    return formatAmount(player.yellowCoinsBalance ?? 0)
  }

  if (category === 'rank') {
    return formatAmount(player.completedGamesCount ?? 0)
  }

  if (category === 'wins') {
    return formatAmount(player.wonGamesCount ?? 0)
  }

  return typeof player.averageRating === 'number'
    ? player.averageRating.toFixed(2)
    : '-'
}

function renderLeaderboardsDirectory(state: LobbyScreenState): string {
  if (state.leaderboardsLoading) {
    return `
      <div style="min-height:520px;display:flex;align-items:center;justify-content:center;border:1px solid rgba(212,165,32,0.34);background:#050505;border-radius:8px;color:#d4a520;font-size:18px;font-weight:900;">
        Зареждане на класации...
      </div>
    `
  }

  if (state.leaderboardsErrorText) {
    return `
      <div style="min-height:520px;display:flex;align-items:center;justify-content:center;border:1px solid rgba(248,113,113,0.34);background:rgba(127,29,29,0.28);border-radius:8px;color:#fecaca;font-size:15px;font-weight:800;text-align:center;padding:20px;">
        ${escapeHtml(state.leaderboardsErrorText)}
      </div>
    `
  }

  const category = state.activeLeaderboardCategory
  const players = state.leaderboards?.[category] ?? []
  const activeTab = LEADERBOARD_TABS.find((tab) => tab.category === category) ?? LEADERBOARD_TABS[0]

  return `
    <section style="min-height:520px;display:grid;gap:14px;align-content:start;">
      <div style="display:flex;align-items:end;justify-content:space-between;gap:16px;border-bottom:1px solid rgba(212,165,32,0.28);padding-bottom:12px;">
        <div>
          <div style="font-size:26px;line-height:1.05;font-weight:900;color:#f8fafc;">Класации</div>
          <div style="margin-top:6px;font-size:13px;font-weight:700;color:rgba(255,255,255,0.56);">Топ играчи по баланс, ранг, победи и партньорска оценка.</div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;">
          ${LEADERBOARD_TABS.map((tab) => {
            const isActive = tab.category === category

            return `
              <button type="button" data-lobby-leaderboard-tab="${tab.category}" style="height:38px;padding:0 14px;border:1px solid ${isActive ? 'rgba(212,165,32,0.78)' : 'rgba(255,255,255,0.12)'};border-radius:8px;background:${isActive ? 'linear-gradient(180deg,#f4c95b 0%,#c98f13 100%)' : '#080808'};color:${isActive ? '#080808' : '#f8fafc'};font-size:13px;font-weight:900;cursor:pointer;">
                ${escapeHtml(tab.label)}
              </button>
            `
          }).join('')}
        </div>
      </div>

      ${players.length === 0 ? `
        <div style="min-height:360px;display:flex;align-items:center;justify-content:center;border:1px dashed rgba(255,255,255,0.16);background:rgba(255,255,255,0.03);border-radius:8px;color:rgba(255,255,255,0.62);font-size:15px;font-weight:800;">
          Все още няма данни за тази класация.
        </div>
      ` : `
        <div style="display:grid;gap:8px;">
          ${players.map((player, index) => {
            const displayName = player.displayName?.trim() || 'Играч'
            const avatarUrl = player.avatarUrl?.trim() ?? ''
            const fallbackLetter = escapeHtml(displayName.charAt(0).toUpperCase() || '?')
            const position = index + 1
            const medalColor =
              position === 1 ? '#f4c95b' : position === 2 ? '#d4d4d8' : position === 3 ? '#c08457' : 'rgba(255,255,255,0.50)'

            return `
              <button type="button" data-lobby-leaderboard-player="${escapeHtml(player.profileId ?? '')}" style="display:grid;grid-template-columns:64px minmax(0,1fr) 150px 130px 130px;align-items:center;gap:14px;text-align:left;border:1px solid rgba(212,165,32,0.24);border-radius:8px;background:linear-gradient(180deg,#141414 0%,#050505 100%);padding:12px 14px;color:#ffffff;cursor:pointer;min-width:0;">
                <div style="font-size:26px;font-weight:900;color:${medalColor};text-align:center;">#${position}</div>
                <div style="display:flex;align-items:center;gap:12px;min-width:0;">
                  <div style="position:relative;width:72px;height:72px;flex:0 0 auto;">
                    <div style="width:100%;height:100%;border-radius:10px;border:1px solid rgba(212,165,32,0.56);background:#101010;overflow:hidden;display:flex;align-items:center;justify-content:center;color:#d4a520;font-size:30px;font-weight:900;">
                      ${avatarUrl ? `<img src="${escapeHtml(avatarUrl)}" alt="" style="width:100%;height:100%;object-fit:cover;display:block;">` : fallbackLetter}
                    </div>
                    ${renderLevelBadge(player.level, 'sm')}
                  </div>
                  <div style="min-width:0;">
                    <div style="font-size:15px;font-weight:900;color:#f8fafc;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(displayName)}</div>
                    <div style="margin-top:4px;font-size:12px;font-weight:800;color:#d4a520;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(player.rankTitle ?? 'Ранг 1')}</div>
                  </div>
                </div>
                <div>
                  <div style="font-size:10px;font-weight:900;text-transform:uppercase;color:rgba(255,255,255,0.44);">${escapeHtml(activeTab.metricLabel)}</div>
                  <div style="margin-top:4px;font-size:18px;font-weight:900;color:#f8fafc;">${escapeHtml(getLeaderboardMetric(category, player))}</div>
                </div>
                <div>
                  <div style="font-size:10px;font-weight:900;text-transform:uppercase;color:rgba(255,255,255,0.44);">игри</div>
                  <div style="margin-top:4px;font-size:15px;font-weight:900;color:#f8fafc;">${formatAmount(player.completedGamesCount ?? 0)}</div>
                </div>
                <div>
                  <div style="font-size:10px;font-weight:900;text-transform:uppercase;color:rgba(255,255,255,0.44);">оценка</div>
                  <div style="margin-top:4px;font-size:15px;font-weight:900;color:#f8fafc;">${typeof player.averageRating === 'number' ? player.averageRating.toFixed(2) : '-'}</div>
                </div>
              </button>
            `
          }).join('')}
        </div>
      `}
    </section>
  `
}

function renderShopPanel(state: LobbyScreenState): string {
  if (state.shopPackagesLoading) {
    return `
      <div style="min-height:520px;display:flex;align-items:center;justify-content:center;border:1px solid rgba(212,165,32,0.34);background:#050505;border-radius:8px;color:#d4a520;font-size:18px;font-weight:900;">
        Зареждане на магазина...
      </div>
    `
  }

  if (state.shopPackagesErrorText) {
    return `
      <div style="min-height:520px;display:flex;align-items:center;justify-content:center;border:1px solid rgba(248,113,113,0.34);background:rgba(127,29,29,0.28);border-radius:8px;color:#fecaca;font-size:15px;font-weight:800;text-align:center;padding:20px;">
        ${escapeHtml(state.shopPackagesErrorText)}
      </div>
    `
  }

  const packages = state.shopPackages
  const isLoggedIn = state.profile.profileId !== null
  const isAdmin = state.isAdmin
  const purchaseHistory = `
    ${state.shopPurchaseMessageText ? `
      <div style="border:1px solid rgba(212,165,32,0.30);border-radius:8px;background:rgba(212,165,32,0.08);padding:12px 14px;color:#f8fafc;font-size:13px;font-weight:800;">
        ${escapeHtml(state.shopPurchaseMessageText)}
      </div>
    ` : ''}

    ${isLoggedIn ? `
      <div style="display:grid;gap:10px;border-top:1px solid rgba(212,165,32,0.22);padding-top:14px;">
        <div style="display:flex;align-items:center;gap:12px;">
          <div style="font-size:18px;font-weight:900;color:#f8fafc;">История на покупки</div>
          <button data-shop-history-toggle="1" style="
            background:none; border:1px solid rgba(255,255,255,0.15); border-radius:6px;
            padding:5px 10px; cursor:pointer;
            font-size:11px; font-weight:700; color:rgba(255,255,255,0.45);
            letter-spacing:0.03em;
          ">${state.shopPurchasesVisible ? 'Скрий' : 'Покажи'}</button>
          ${state.shopPurchasesLoading ? `<div style="font-size:12px;font-weight:900;color:#d4a520;">Зареждане...</div>` : ''}
        </div>
        ${state.shopPurchasesVisible ? `
          ${state.shopPurchases.length === 0 ? `
            <div style="border:1px solid rgba(255,255,255,0.10);border-radius:8px;background:#080808;padding:14px;color:rgba(255,255,255,0.58);font-size:13px;font-weight:800;">Още няма покупки.</div>
          ` : `
            <div style="display:grid;gap:8px;">
              ${state.shopPurchases.map((purchase) => {
                const isActionPurchase = state.shopPurchaseActionPurchaseId === purchase.purchaseId
                const isHideConfirm = state.shopPurchaseHideConfirmId === purchase.purchaseId
                const canPay = purchase.status === 'pending'
                const disableButtons = isActionPurchase || state.shopPurchaseActionPurchaseId !== null

                return `
                <div style="display:grid;grid-template-columns:1.2fr 0.8fr 0.8fr 0.7fr auto;gap:10px;align-items:center;border:1px solid rgba(255,255,255,0.10);border-radius:8px;background:#080808;padding:12px;">
                  <div>
                    <div style="font-size:14px;font-weight:900;color:#f8fafc;">${escapeHtml(purchase.title)}</div>
                    <div style="margin-top:3px;font-size:11px;font-weight:800;color:rgba(255,255,255,0.42);">${escapeHtml(formatCompactDateTime(purchase.createdAt))}</div>
                  </div>
                  <div style="font-size:14px;font-weight:900;color:#d4a520;">${formatAmount(purchase.yellowCoinsAmount)}</div>
                  <div style="font-size:14px;font-weight:900;color:#f8fafc;">${escapeHtml(formatPackagePrice(purchase.priceCents, purchase.currency))}</div>
                  <div style="font-size:12px;font-weight:900;color:${getPurchaseStatusColor(purchase.status)};">${escapeHtml(formatPurchaseStatusLabel(purchase.status))}</div>
                  <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
                    ${canPay ? `
                      <button
                        type="button"
                        data-shop-purchase-resume="${escapeHtml(purchase.purchaseId)}"
                        ${disableButtons ? 'disabled' : ''}
                        style="height:30px;padding:0 10px;border:0;border-radius:6px;background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;font-size:11px;font-weight:900;cursor:${disableButtons ? 'wait' : 'pointer'};opacity:${disableButtons ? '0.6' : '1'};white-space:nowrap;"
                      >${isActionPurchase ? 'Зареждане...' : 'Плати'}</button>
                    ` : ''}
                    ${isHideConfirm ? `
                      <span style="font-size:11px;font-weight:800;color:rgba(255,255,255,0.65);">${purchase.status === 'pending' ? 'Да отменя незавършеното плащане и да го премахна от списъка?' : 'Да премахна покупката от историята?'}</span>
                      <button type="button" data-shop-purchase-hide-confirm="${escapeHtml(purchase.purchaseId)}" style="height:26px;padding:0 8px;border:1px solid rgba(255,80,80,0.5);border-radius:5px;background:rgba(255,80,80,0.12);color:#fca5a5;font-size:11px;font-weight:900;cursor:pointer;">Да</button>
                      <button type="button" data-shop-purchase-hide-cancel="1" style="height:26px;padding:0 8px;border:1px solid rgba(255,255,255,0.14);border-radius:5px;background:transparent;color:rgba(255,255,255,0.45);font-size:11px;font-weight:900;cursor:pointer;">Не</button>
                    ` : `
                      <button
                        type="button"
                        data-shop-purchase-hide="${escapeHtml(purchase.purchaseId)}"
                        ${disableButtons ? 'disabled' : ''}
                        style="width:26px;height:26px;border:1px solid rgba(255,255,255,0.14);border-radius:5px;background:transparent;color:rgba(255,255,255,0.38);font-size:14px;font-weight:700;cursor:${disableButtons ? 'default' : 'pointer'};display:flex;align-items:center;justify-content:center;line-height:1;opacity:${disableButtons ? '0.4' : '1'};"
                        title="Скрий от историята"
                      >×</button>
                    `}
                  </div>
                </div>
                `
              }).join('')}
            </div>
          `}
        ` : ''}
      </div>
    ` : ''}
  `

  return `
    <section style="min-height:520px;display:grid;gap:18px;align-content:start;">
      <div style="display:flex;align-items:end;justify-content:space-between;gap:16px;border-bottom:1px solid rgba(212,165,32,0.28);padding-bottom:12px;">
        <div>
          <div style="font-size:26px;line-height:1.05;font-weight:900;color:#f8fafc;">Магазин</div>
          <div style="margin-top:6px;font-size:13px;font-weight:700;color:rgba(255,255,255,0.56);">Избери пакет и завърши плащането през Stripe. Жълтиците се добавят след потвърждение.</div>
        </div>
        <div style="border:1px solid rgba(212,165,32,0.28);border-radius:8px;background:#0a0a0a;padding:10px 12px;color:#d4a520;font-size:13px;font-weight:900;">
          Баланс: ${formatAmount(state.profile.yellowCoinsBalance ?? 0)}
        </div>
      </div>

      ${packages.length === 0 ? `
        <div style="min-height:260px;display:flex;align-items:center;justify-content:center;border:1px solid rgba(255,255,255,0.10);background:#080808;border-radius:8px;color:rgba(255,255,255,0.64);font-size:15px;font-weight:800;text-align:center;padding:20px;">
          Няма активни пакети в магазина.
        </div>
      ` : `
        <div style="display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px;">
          ${packages.map((coinPackage) => {
            const isPurchasing = state.shopPurchaseActionPackageId === coinPackage.packageId
            return `
            <article style="
              position:relative;
              background:#000000;
              border:1px solid rgba(212,165,32,0.72);
              border-radius:12px;
              padding:16px 14px 14px;
              overflow:hidden;
              box-shadow:0 4px 16px rgba(0,0,0,0.3);
            ">
              <img src="${getCoinPackageImage(coinPackage.sortOrder)}" alt="" style="position:absolute;bottom:10px;right:10px;width:76px;height:76px;object-fit:contain;opacity:0.88;pointer-events:none;">

              <button type="button" data-lobby-shop-package="${escapeHtml(coinPackage.packageId)}" ${isPurchasing ? 'disabled' : ''} style="position:absolute;top:14px;right:14px;height:34px;padding:0 14px;border:0;border-radius:8px;background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;font-size:12px;font-weight:900;cursor:${isPurchasing ? 'wait' : 'pointer'};transition:filter 0.15s,transform 0.1s;">
                ${isPurchasing ? 'Зарежда...' : isLoggedIn ? 'Купи пакет' : 'Влез за покупка'}
              </button>

              <div style="font-size:10px;font-weight:700;color:rgba(255,255,255,0.5);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:5px;">Жълтици</div>
              <div style="font-size:22px;font-weight:900;color:#d4a520;line-height:1;margin-bottom:12px;">${formatAmount(coinPackage.yellowCoinsAmount)}</div>

              <div style="font-size:10px;font-weight:700;color:rgba(255,255,255,0.5);text-transform:uppercase;letter-spacing:0.08em;margin-bottom:4px;">Пакет</div>
              <div style="font-size:15px;font-weight:900;color:#ffffff;margin-bottom:14px;">${escapeHtml(coinPackage.title)}</div>

              <div style="font-size:17px;font-weight:900;color:#ffffff;">${escapeHtml(formatPackagePrice(coinPackage.priceCents, coinPackage.currency))}</div>
              <div style="font-size:11px;font-weight:700;color:rgba(255,255,255,0.5);margin-top:2px;">${escapeHtml(formatPackagePriceBgn(coinPackage.priceCents))}</div>

              ${isAdmin ? `
                <label style="display:flex;align-items:center;gap:7px;margin-top:12px;padding-top:10px;border-top:1px solid rgba(212,165,32,0.22);cursor:pointer;user-select:none;">
                  <input type="checkbox"
                    data-lobby-shop-package-lobby="${escapeHtml(coinPackage.packageId)}"
                    ${coinPackage.showInLobby ? 'checked' : ''}
                    style="width:15px;height:15px;accent-color:#d4a520;cursor:pointer;flex-shrink:0;">
                  <span style="font-size:11px;font-weight:800;color:rgba(212,165,32,0.85);text-transform:uppercase;letter-spacing:0.05em;">Видима в лобито</span>
                </label>
              ` : ''}
            </article>
          `}).join('')}
        </div>
        <style>
          [data-lobby-shop-package]:not(:disabled):hover {
            filter:brightness(1.15);
            transform:scale(1.06);
          }
        </style>
      `}

      ${purchaseHistory}
    </section>
  `
}

function renderAdminInfoPanel(state: LobbyScreenState): string {
  if (!state.isAdmin) {
    return `<div style="min-height:520px;display:flex;align-items:center;justify-content:center;color:#fecaca;font-size:15px;font-weight:800;">Нямаш достъп.</div>`
  }

  if (state.adminStatsLoading) {
    return `<div style="min-height:520px;display:flex;align-items:center;justify-content:center;color:#d4a520;font-size:18px;font-weight:900;">Зареждане...</div>`
  }

  if (state.adminStatsErrorText) {
    return `<div style="min-height:520px;display:flex;align-items:center;justify-content:center;color:#fecaca;font-size:14px;font-weight:800;">${escapeHtml(state.adminStatsErrorText)}</div>`
  }

  const stats = state.adminStats
  if (!stats) return ''

  function fmtMoney(cents: number): string {
    return (cents / 100).toFixed(2)
  }

  function visitorCard(label: string, count: number, period: string): string {
    return `
      <button type="button" data-admin-visitors-period="${escapeHtml(period)}" style="
        display:flex; flex-direction:column; gap:8px; text-align:left;
        background:#0d0d0d; border:1px solid rgba(96,165,250,0.25); border-radius:12px;
        padding:16px 18px; cursor:pointer; width:100%;
        transition:border-color 0.15s;
      " onmouseover="this.style.borderColor='rgba(96,165,250,0.55)'" onmouseout="this.style.borderColor='rgba(96,165,250,0.25)'">
        <div style="font-size:10px;font-weight:800;letter-spacing:0.12em;text-transform:uppercase;color:rgba(255,255,255,0.45);">${escapeHtml(label)}</div>
        <div style="display:flex;align-items:baseline;gap:6px;">
          <span style="font-size:30px;font-weight:900;color:#60a5fa;">${count.toLocaleString('bg-BG')}</span>
          <span style="font-size:12px;color:rgba(96,165,250,0.6);">посетители</span>
        </div>
      </button>
    `
  }

  function statCard(label: string, count: number, cents: number, period: string): string {
    return `
      <button type="button" data-admin-payments-open="${escapeHtml(period)}"
        aria-label="Виж плащания: ${escapeHtml(label)}"
        style="
          background:#0d0d0d; border:1px solid rgba(212,165,32,0.28); border-radius:12px;
          padding:18px 22px; display:flex; flex-direction:column; gap:10px;
          cursor:pointer; width:100%; text-align:left;
          transition:border-color 0.15s;
        "
        onmouseover="this.style.borderColor='rgba(212,165,32,0.6)'"
        onmouseout="this.style.borderColor='rgba(212,165,32,0.28)'"
        onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();this.click()}"
      >
        <div style="font-size:11px;font-weight:800;letter-spacing:0.12em;text-transform:uppercase;color:rgba(255,255,255,0.5);">
          ${escapeHtml(label)}
          <span style="font-size:10px;color:rgba(212,165,32,0.45);margin-left:6px;">↗ Детайли</span>
        </div>
        <div style="display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;">
          <div>
            <span style="font-size:28px;font-weight:900;color:#ffffff;">${count}</span>
            <span style="font-size:12px;color:rgba(255,255,255,0.45);margin-left:4px;">плащания</span>
          </div>
          <div>
            <span style="font-size:22px;font-weight:800;color:#d4a520;">${fmtMoney(cents)}</span>
            <span style="font-size:12px;color:rgba(212,165,32,0.6);margin-left:4px;">EUR</span>
          </div>
        </div>
      </button>
    `
  }

  return `
    <section style="padding:0 4px;">
      <h2 style="font-size:18px;font-weight:800;color:#d4a520;margin:0 0 20px;letter-spacing:0.04em;text-transform:uppercase;">Информация</h2>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:24px;">
        <div style="background:#0d0d0d;border:1px solid rgba(212,165,32,0.28);border-radius:12px;padding:18px 22px;">
          <div style="font-size:11px;font-weight:800;letter-spacing:0.12em;text-transform:uppercase;color:rgba(255,255,255,0.5);margin-bottom:10px;">Онлайн сега</div>
          <div style="display:flex;align-items:center;gap:10px;">
            <div style="width:10px;height:10px;border-radius:50%;background:#22c55e;flex-shrink:0;"></div>
            <span style="font-size:32px;font-weight:900;color:#ffffff;">${stats.onlineCount}</span>
            <span style="font-size:13px;color:rgba(255,255,255,0.45);">потребители</span>
          </div>
        </div>
        <div style="background:#0d0d0d;border:1px solid rgba(212,165,32,0.28);border-radius:12px;padding:18px 22px;">
          <div style="font-size:11px;font-weight:800;letter-spacing:0.12em;text-transform:uppercase;color:rgba(255,255,255,0.5);margin-bottom:10px;">Регистрирани профили</div>
          <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;row-gap:4px;">
            <div>
              <span style="font-size:13px;color:rgba(255,255,255,0.45);margin-right:4px;">общо</span>
              <span style="font-size:32px;font-weight:900;color:#ffffff;">${(stats.registeredProfiles?.total ?? 0).toLocaleString('bg-BG')}</span>
            </div>
            <span style="font-size:16px;color:rgba(255,255,255,0.25);">|</span>
            <div>
              <span style="font-size:11px;color:rgba(212,165,32,0.6);margin-right:3px;">днес</span>
              <span style="font-size:16px;font-weight:800;color:#d4a520;">${(stats.registeredProfiles?.today ?? 0).toLocaleString('bg-BG')}</span>
            </div>
            <span style="font-size:16px;color:rgba(255,255,255,0.25);">|</span>
            <div>
              <span style="font-size:11px;color:rgba(212,165,32,0.6);margin-right:3px;">вчера</span>
              <span style="font-size:16px;font-weight:800;color:#d4a520;">${(stats.registeredProfiles?.yesterday ?? 0).toLocaleString('bg-BG')}</span>
            </div>
          </div>
        </div>
      </div>

      <h3 style="font-size:13px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;color:rgba(255,255,255,0.5);margin:0 0 12px;">Посетители</h3>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;margin-bottom:24px;">
        ${visitorCard('Днес', stats.visitors.today, 'today')}
        ${visitorCard('Вчера', stats.visitors.yesterday, 'yesterday')}
        ${visitorCard('Последните 7 дни', stats.visitors.last7days, '7d')}
        ${visitorCard('Последните 30 дни', stats.visitors.last30days, '30d')}
        <div style="
          display:flex; flex-direction:column; gap:8px; text-align:left;
          background:#0d0d0d; border:1px solid rgba(96,165,250,0.25); border-radius:12px;
          padding:16px 18px; width:100%;
        ">
          <div style="font-size:10px;font-weight:800;letter-spacing:0.12em;text-transform:uppercase;color:rgba(255,255,255,0.45);">Нови посетители днес</div>
          <div style="display:flex;align-items:baseline;gap:6px;">
            <span style="font-size:30px;font-weight:900;color:#60a5fa;">${(stats.visitors.newToday ?? 0).toLocaleString('bg-BG')}</span>
            <span style="font-size:12px;color:rgba(96,165,250,0.6);">посетители</span>
          </div>
        </div>
        <div style="
          display:flex; flex-direction:column; gap:8px; text-align:left;
          background:#0d0d0d; border:1px solid rgba(96,165,250,0.25); border-radius:12px;
          padding:16px 18px; width:100%;
        ">
          <div style="font-size:10px;font-weight:800;letter-spacing:0.12em;text-transform:uppercase;color:rgba(255,255,255,0.45);">Нови посетители вчера</div>
          <div style="display:flex;align-items:baseline;gap:6px;">
            <span style="font-size:30px;font-weight:900;color:#60a5fa;">${(stats.visitors.newYesterday ?? 0).toLocaleString('bg-BG')}</span>
            <span style="font-size:12px;color:rgba(96,165,250,0.6);">посетители</span>
          </div>
        </div>
      </div>

      <h3 style="font-size:13px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;color:rgba(255,255,255,0.5);margin:0 0 12px;">Изиграни игри</h3>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;margin-bottom:24px;">
        <div style="background:#0d0d0d;border:1px solid rgba(212,165,32,0.28);border-radius:12px;padding:16px 18px;">
          <div style="font-size:10px;font-weight:800;letter-spacing:0.12em;text-transform:uppercase;color:rgba(255,255,255,0.45);margin-bottom:10px;">Игри от потребители</div>
          <div style="display:flex;flex-direction:column;gap:6px;">
            <div style="display:flex;align-items:center;gap:8px;">
              <span style="font-size:11px;color:rgba(255,255,255,0.45);width:56px;">Днес</span>
              <span style="font-size:20px;font-weight:900;color:#d4a520;">${(stats.gamesPlayed?.userGamesToday ?? 0).toLocaleString('bg-BG')}</span>
            </div>
            <div style="display:flex;align-items:center;gap:8px;">
              <span style="font-size:11px;color:rgba(255,255,255,0.45);width:56px;">Вчера</span>
              <span style="font-size:20px;font-weight:900;color:#d4a520;">${(stats.gamesPlayed?.userGamesYesterday ?? 0).toLocaleString('bg-BG')}</span>
            </div>
          </div>
        </div>
        <div style="background:#0d0d0d;border:1px solid rgba(96,165,250,0.25);border-radius:12px;padding:16px 18px;">
          <div style="font-size:10px;font-weight:800;letter-spacing:0.12em;text-transform:uppercase;color:rgba(255,255,255,0.45);margin-bottom:10px;">Пробни игри</div>
          <div style="display:flex;flex-direction:column;gap:6px;">
            <div style="display:flex;align-items:center;gap:8px;">
              <span style="font-size:11px;color:rgba(255,255,255,0.45);width:56px;">Днес</span>
              <span style="font-size:20px;font-weight:900;color:#60a5fa;">${(stats.gamesPlayed?.guestTrialGamesToday ?? 0).toLocaleString('bg-BG')}</span>
            </div>
            <div style="display:flex;align-items:center;gap:8px;">
              <span style="font-size:11px;color:rgba(255,255,255,0.45);width:56px;">Вчера</span>
              <span style="font-size:20px;font-weight:900;color:#60a5fa;">${(stats.gamesPlayed?.guestTrialGamesYesterday ?? 0).toLocaleString('bg-BG')}</span>
            </div>
          </div>
        </div>
      </div>

      <h3 style="font-size:13px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;color:rgba(255,255,255,0.5);margin:0 0 12px;">Влизания по версия</h3>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px;margin-bottom:24px;">
        ${(['today', 'yesterday', 'last7days', 'last30days'] as const).map((period) => {
          const labels: Record<string, string> = { today: 'Днес', yesterday: 'Вчера', last7days: 'Последните 7 дни', last30days: 'Последните 30 дни' }
          const counts = stats.viewLayout[period]
          return `
            <div style="background:#0d0d0d;border:1px solid rgba(212,165,32,0.2);border-radius:12px;padding:14px 18px;">
              <div style="font-size:10px;font-weight:800;letter-spacing:0.12em;text-transform:uppercase;color:rgba(255,255,255,0.45);margin-bottom:10px;">${escapeHtml(labels[period]!)}</div>
              <div style="display:flex;flex-direction:column;gap:6px;">
                <div style="display:flex;align-items:center;gap:8px;">
                  <span style="font-size:11px;color:rgba(255,255,255,0.45);width:60px;">Мобилна</span>
                  <span style="font-size:20px;font-weight:900;color:#d4a520;">${counts.mobile.toLocaleString('bg-BG')}</span>
                </div>
                <div style="display:flex;align-items:center;gap:8px;">
                  <span style="font-size:11px;color:rgba(255,255,255,0.45);width:60px;">Десктоп</span>
                  <span style="font-size:20px;font-weight:900;color:#d4a520;">${counts.desktop.toLocaleString('bg-BG')}</span>
                </div>
              </div>
            </div>
          `
        }).join('')}
      </div>

      <h3 style="font-size:13px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;color:rgba(255,255,255,0.5);margin:0 0 12px;">Плащания</h3>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;">
        ${statCard('Днес', stats.payments.today.count, stats.payments.today.totalCents, 'today')}
        ${statCard('Вчера', stats.payments.yesterday.count, stats.payments.yesterday.totalCents, 'yesterday')}
        ${statCard('Последните 7 дни', stats.payments.last7days.count, stats.payments.last7days.totalCents, 'last7days')}
        ${statCard('Този месец', stats.payments.thisMonth.count, stats.payments.thisMonth.totalCents, 'thisMonth')}
      </div>
      <div style="display:grid;grid-template-columns:1fr;gap:12px;">
        ${statCard('Общо (всички времена)', stats.payments.allTime.count, stats.payments.allTime.totalCents, 'allTime')}
      </div>
    </section>
  `
}


function renderAdminVisitorsPanel(state: LobbyScreenState): string {
  if (!state.isAdmin) {
    return `<div style="min-height:520px;display:flex;align-items:center;justify-content:center;color:#fecaca;font-size:15px;font-weight:800;">Нямаш достъп.</div>`
  }

  const period = state.adminVisitorsPeriod
  const activeView = state.adminVisitorsView

  const periodBtn = (p: string, label: string) => {
    const active = p === period
    return `<button type="button" data-admin-visitors-period="${escapeHtml(p)}" style="
      height:32px;padding:0 14px;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer;letter-spacing:0.03em;
      border:1px solid ${active ? 'rgba(212,165,32,0.6)' : 'rgba(255,255,255,0.15)'};
      background:${active ? 'rgba(212,165,32,0.12)' : 'transparent'};
      color:${active ? '#d4a520' : 'rgba(255,255,255,0.6)'};
    ">${label}</button>`
  }

  const viewBtn = (v: string, label: string) => {
    const active = v === activeView
    return `<button type="button" data-admin-visitors-view="${escapeHtml(v)}" style="
      height:34px;padding:0 18px;border-radius:6px;font-size:13px;font-weight:700;cursor:pointer;letter-spacing:0.03em;
      border:1px solid ${active ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.15)'};
      background:${active ? 'rgba(255,255,255,0.1)' : 'transparent'};
      color:${active ? '#fff' : 'rgba(255,255,255,0.5)'};
    ">${label}</button>`
  }

  const periodControls = `
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:20px;">
      ${periodBtn('today', 'Днес')}
      ${periodBtn('yesterday', 'Вчера')}
      ${periodBtn('7d', '7 дни')}
      ${periodBtn('30d', '30 дни')}
    </div>
  `

  const viewSwitcher = `
    <div style="display:flex;gap:6px;margin-bottom:20px;">
      ${viewBtn('visitors', 'Посетители')}
      ${viewBtn('sources', 'Източници')}
    </div>
  `

  let bodyHtml: string
  let paginationHtml = ''

  if (activeView === 'sources') {
    bodyHtml = renderSourcesBody(state)
  } else {
    const result = renderVisitorsBody(state)
    bodyHtml = result.body
    paginationHtml = result.pagination
  }

  return `
    <section style="padding:0 4px;">
      <style>
        @media(max-width:700px){.admin-visitors-desktop{display:none!important;}}
        @media(min-width:701px){.admin-visitors-mobile{display:none!important;}}
      </style>
      <div style="display:flex;align-items:center;gap:14px;margin-bottom:20px;flex-wrap:wrap;">
        <h2 style="font-size:18px;font-weight:800;color:#d4a520;margin:0;letter-spacing:0.04em;text-transform:uppercase;">Посетители</h2>
      </div>

      ${periodControls}
      ${viewSwitcher}
      ${bodyHtml}

      <div style="display:flex;align-items:center;gap:16px;margin-top:16px;flex-wrap:wrap;">
        ${paginationHtml}
        <button type="button" data-admin-visitors-back="1" style="
          height:34px;padding:0 16px;border:1px solid rgba(212,165,32,0.45);border-radius:6px;
          background:rgba(212,165,32,0.08);color:#d4a520;font-size:12px;font-weight:800;
          cursor:pointer;letter-spacing:0.04em;margin-left:auto;
        ">← Назад към Информация</button>
      </div>
    </section>
  `
}

function deviceLabel(d: string | null): string {
  if (d === 'mobile')  return 'Мобилно'
  if (d === 'desktop') return 'Десктоп'
  if (d === 'tablet')  return 'Таблет'
  return 'Неизвестно'
}

function osLabel(o: string | null): string {
  if (o === 'android')  return 'Android'
  if (o === 'ios')      return 'iOS'
  if (o === 'windows')  return 'Windows'
  if (o === 'macos')    return 'macOS'
  if (o === 'linux')    return 'Linux'
  if (o === 'chromeos') return 'ChromeOS'
  return 'Неизвестна'
}

function renderVisitorsBody(state: LobbyScreenState): { body: string; pagination: string } {
  const type = state.adminVisitorsType
  const device = state.adminVisitorsDevice
  const os = state.adminVisitorsOs
  const offset = state.adminVisitorsOffset
  const limit = state.adminVisitorsLimit
  const rows = state.adminVisitorsRows
  const total = state.adminVisitorsTotal
  const loading = state.adminVisitorsLoading
  const errorText = state.adminVisitorsErrorText

  const typeBtn = (t: string, label: string) => {
    const active = t === type
    return `<button type="button" data-admin-visitors-type="${escapeHtml(t)}" style="
      height:32px;padding:0 14px;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer;letter-spacing:0.03em;
      border:1px solid ${active ? 'rgba(96,165,250,0.5)' : 'rgba(255,255,255,0.15)'};
      background:${active ? 'rgba(96,165,250,0.1)' : 'transparent'};
      color:${active ? 'rgba(96,165,250,0.9)' : 'rgba(255,255,255,0.6)'};
    ">${label}</button>`
  }

  const deviceBtn = (d: string, label: string) => {
    const active = d === device
    return `<button type="button" data-admin-visitors-device="${escapeHtml(d)}" style="
      height:32px;padding:0 14px;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer;letter-spacing:0.03em;
      border:1px solid ${active ? 'rgba(167,139,250,0.5)' : 'rgba(255,255,255,0.15)'};
      background:${active ? 'rgba(167,139,250,0.1)' : 'transparent'};
      color:${active ? 'rgba(167,139,250,0.9)' : 'rgba(255,255,255,0.6)'};
    ">${label}</button>`
  }

  const osBtn = (o: string, label: string) => {
    const active = o === os
    return `<button type="button" data-admin-visitors-os="${escapeHtml(o)}" style="
      height:32px;padding:0 14px;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer;letter-spacing:0.03em;
      border:1px solid ${active ? 'rgba(52,211,153,0.5)' : 'rgba(255,255,255,0.15)'};
      background:${active ? 'rgba(52,211,153,0.1)' : 'transparent'};
      color:${active ? 'rgba(52,211,153,0.9)' : 'rgba(255,255,255,0.6)'};
    ">${label}</button>`
  }

  const fmtDate = (s: string) => {
    const d = new Date(s.includes('T') ? s : s + 'Z')
    return isNaN(d.getTime()) ? s : d.toLocaleString('bg-BG', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' })
  }

  const truncate = (s: string | null, n: number) =>
    s ? (s.length > n ? escapeHtml(s.slice(0, n)) + '…' : escapeHtml(s)) : '—'

  let bodyHtml: string
  if (loading) {
    bodyHtml = `<div style="padding:40px;text-align:center;color:rgba(255,255,255,0.4);font-size:14px;">Зареждане…</div>`
  } else if (errorText) {
    bodyHtml = `<div style="padding:24px;color:#fecaca;font-size:14px;">${escapeHtml(errorText)}</div>`
  } else if (rows.length === 0) {
    bodyHtml = `<div style="padding:40px;text-align:center;color:rgba(255,255,255,0.35);font-size:14px;">Няма посетители за избрания период.</div>`
  } else {
    const tableRows = rows.map((r) => `
      <tr style="border-bottom:1px solid rgba(255,255,255,0.06);">
        <td style="padding:8px 10px;white-space:nowrap;">
          ${r.isRegistered
            ? `<span style="font-size:10px;font-weight:800;color:rgba(96,165,250,0.85);background:rgba(96,165,250,0.1);border:1px solid rgba(96,165,250,0.25);border-radius:4px;padding:1px 6px;">РЕГ</span>`
            : `<span style="font-size:10px;font-weight:800;color:rgba(255,255,255,0.4);background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:4px;padding:1px 6px;">ГОСТ</span>`}
        </td>
        <td style="padding:8px 10px;max-width:160px;">
          ${r.displayName ? `<div style="font-size:13px;color:#fff;font-weight:700;">${truncate(r.displayName, 24)}</div>` : ''}
          ${r.email ? `<div style="font-size:11px;color:rgba(255,255,255,0.45);">${truncate(r.email, 32)}</div>` : '<div style="font-size:11px;color:rgba(255,255,255,0.25);">—</div>'}
        </td>
        <td style="padding:8px 10px;font-size:12px;color:rgba(255,255,255,0.5);font-family:monospace;">${truncate(r.lastIpAddress, 20)}</td>
        <td style="padding:8px 10px;font-size:12px;color:rgba(255,255,255,0.5);max-width:140px;">${truncate(r.firstSource ?? r.firstReferrer, 28)}</td>
        <td style="padding:8px 10px;font-size:11px;color:rgba(167,139,250,0.8);white-space:nowrap;">${escapeHtml(deviceLabel(r.lastDeviceType))}</td>
        <td style="padding:8px 10px;font-size:11px;color:rgba(52,211,153,0.8);white-space:nowrap;">${escapeHtml(osLabel(r.lastOsType))}</td>
        <td style="padding:8px 10px;font-size:11px;color:rgba(255,255,255,0.45);white-space:nowrap;">${fmtDate(r.firstSeenAt)}</td>
        <td style="padding:8px 10px;font-size:11px;color:rgba(255,255,255,0.7);white-space:nowrap;">${fmtDate(r.lastSeenAt)}</td>
        <td style="padding:8px 10px;text-align:center;font-size:13px;color:rgba(96,165,250,0.85);font-weight:700;">${r.pageViews}</td>
      </tr>
    `).join('')

    const desktopTable = `
      <div class="admin-visitors-desktop" style="overflow-x:auto;">
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead>
            <tr style="border-bottom:1px solid rgba(255,255,255,0.12);">
              <th style="padding:8px 10px;text-align:left;font-size:10px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;color:rgba(255,255,255,0.4);">Тип</th>
              <th style="padding:8px 10px;text-align:left;font-size:10px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;color:rgba(255,255,255,0.4);">Потребител</th>
              <th style="padding:8px 10px;text-align:left;font-size:10px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;color:rgba(255,255,255,0.4);">IP</th>
              <th style="padding:8px 10px;text-align:left;font-size:10px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;color:rgba(255,255,255,0.4);">Източник</th>
              <th style="padding:8px 10px;text-align:left;font-size:10px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;color:rgba(167,139,250,0.6);">Устройство</th>
              <th style="padding:8px 10px;text-align:left;font-size:10px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;color:rgba(52,211,153,0.6);">Система</th>
              <th style="padding:8px 10px;text-align:left;font-size:10px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;color:rgba(255,255,255,0.4);">Първо посещение</th>
              <th style="padding:8px 10px;text-align:left;font-size:10px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;color:rgba(255,255,255,0.4);">Последно посещение</th>
              <th style="padding:8px 10px;text-align:center;font-size:10px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;color:rgba(255,255,255,0.4);">Отваряния</th>
            </tr>
          </thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>
    `

    const mobileCards = rows.map((r) => `
      <div style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:12px 14px;margin-bottom:8px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
          ${r.isRegistered
            ? `<span style="font-size:10px;font-weight:800;color:rgba(96,165,250,0.85);background:rgba(96,165,250,0.1);border:1px solid rgba(96,165,250,0.25);border-radius:4px;padding:1px 6px;">РЕГ</span>`
            : `<span style="font-size:10px;font-weight:800;color:rgba(255,255,255,0.4);background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:4px;padding:1px 6px;">ГОСТ</span>`}
          <span style="font-size:11px;color:rgba(255,255,255,0.35);">${fmtDate(r.lastSeenAt)}</span>
        </div>
        ${r.displayName ? `<div style="font-size:14px;font-weight:700;color:#fff;margin-bottom:2px;">${truncate(r.displayName, 30)}</div>` : ''}
        ${r.email ? `<div style="font-size:11px;color:rgba(255,255,255,0.45);margin-bottom:4px;">${truncate(r.email, 36)}</div>` : ''}
        <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:6px;">
          ${r.lastIpAddress ? `<span style="font-size:11px;color:rgba(255,255,255,0.4);font-family:monospace;">${truncate(r.lastIpAddress, 20)}</span>` : ''}
          ${(r.firstSource ?? r.firstReferrer) ? `<span style="font-size:11px;color:rgba(255,255,255,0.4);">src: ${truncate(r.firstSource ?? r.firstReferrer, 24)}</span>` : ''}
          <span style="font-size:11px;color:rgba(167,139,250,0.75);">${escapeHtml(deviceLabel(r.lastDeviceType))}</span>
          <span style="font-size:11px;color:rgba(52,211,153,0.75);">${escapeHtml(osLabel(r.lastOsType))}</span>
          <span style="font-size:11px;color:rgba(96,165,250,0.75);">Отваряния: ${r.pageViews}</span>
        </div>
      </div>
    `).join('')

    bodyHtml = desktopTable + `<div class="admin-visitors-mobile">${mobileCards}</div>`
  }

  const hasPrev = offset > 0
  const hasNext = offset + limit < total
  const pageInfo = total > 0
    ? `<span style="font-size:12px;color:rgba(255,255,255,0.4);">${offset + 1}–${Math.min(offset + limit, total)} от ${total}</span>`
    : ''
  const pagination = `
    ${pageInfo}
    ${hasPrev ? `<button type="button" data-admin-visitors-page="${offset - limit}" style="height:34px;padding:0 16px;border-radius:6px;border:1px solid rgba(255,255,255,0.2);background:transparent;color:rgba(255,255,255,0.7);font-size:12px;font-weight:700;cursor:pointer;">← Назад</button>` : ''}
    ${hasNext ? `<button type="button" data-admin-visitors-page="${offset + limit}" style="height:34px;padding:0 16px;border-radius:6px;border:1px solid rgba(255,255,255,0.2);background:transparent;color:rgba(255,255,255,0.7);font-size:12px;font-weight:700;cursor:pointer;">Напред →</button>` : ''}
  `

  return {
    body: `
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;">
        ${typeBtn('all', 'Всички')}
        ${typeBtn('guest', 'Гости')}
        ${typeBtn('registered', 'Регистрирани')}
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;">
        ${deviceBtn('all', 'Всички устройства')}
        ${deviceBtn('mobile', 'Мобилни')}
        ${deviceBtn('desktop', 'Десктоп')}
        ${deviceBtn('tablet', 'Таблети')}
        ${deviceBtn('unknown', 'Неизвестни')}
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;">
        ${osBtn('all', 'Всички системи')}
        ${osBtn('android', 'Android')}
        ${osBtn('ios', 'iOS')}
        ${osBtn('windows', 'Windows')}
        ${osBtn('macos', 'macOS')}
        ${osBtn('linux', 'Linux')}
        ${osBtn('chromeos', 'ChromeOS')}
        ${osBtn('unknown', 'Неизвестна')}
      </div>
      ${bodyHtml}
    `,
    pagination,
  }
}

function renderSourcesBody(state: LobbyScreenState): string {
  const device = state.adminVisitorsDevice
  const loading = state.adminVisitorsSourcesLoading
  const errorText = state.adminVisitorsSourcesErrorText
  const rows = state.adminVisitorsSourcesRows
  const total = state.adminVisitorsSourcesTotal

  const deviceBtn = (d: string, label: string) => {
    const active = d === device
    return `<button type="button" data-admin-visitors-device="${escapeHtml(d)}" style="
      height:32px;padding:0 14px;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer;letter-spacing:0.03em;
      border:1px solid ${active ? 'rgba(167,139,250,0.5)' : 'rgba(255,255,255,0.15)'};
      background:${active ? 'rgba(167,139,250,0.1)' : 'transparent'};
      color:${active ? 'rgba(167,139,250,0.9)' : 'rgba(255,255,255,0.6)'};
    ">${label}</button>`
  }

  const deviceFilterHtml = `
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;">
      ${deviceBtn('all', 'Всички устройства')}
      ${deviceBtn('mobile', 'Мобилни')}
      ${deviceBtn('desktop', 'Десктоп')}
      ${deviceBtn('tablet', 'Таблети')}
      ${deviceBtn('unknown', 'Неизвестни')}
    </div>
  `

  if (loading) {
    return deviceFilterHtml + `<div style="padding:40px;text-align:center;color:rgba(255,255,255,0.4);font-size:14px;">Зареждане…</div>`
  }
  if (errorText) {
    return deviceFilterHtml + `<div style="padding:24px;color:#fecaca;font-size:14px;">${escapeHtml(errorText)}</div>`
  }

  const dataRows = [...rows, { label: '__total__', visitors: total, percent: 100 }]

  const tableRows = dataRows.map((r) => {
    const isTotal = r.label === '__total__'
    const label = isTotal ? 'Общо' : r.label
    const barWidth = r.percent
    return `
      <tr style="border-bottom:1px solid rgba(255,255,255,${isTotal ? '0.15' : '0.06'});">
        <td style="padding:10px 12px;font-size:13px;font-weight:${isTotal ? '800' : '600'};color:${isTotal ? '#fff' : 'rgba(255,255,255,0.8)'};">${label}</td>
        <td style="padding:10px 12px;text-align:right;font-size:13px;font-weight:${isTotal ? '800' : '600'};color:rgba(96,165,250,0.9);white-space:nowrap;">${r.visitors}</td>
        <td style="padding:10px 12px;text-align:right;font-size:12px;color:rgba(255,255,255,0.45);white-space:nowrap;">${isTotal ? '' : r.percent + '%'}</td>
        <td style="padding:10px 12px;width:160px;">
          ${!isTotal && barWidth > 0 ? `<div style="height:6px;border-radius:3px;background:rgba(96,165,250,0.25);overflow:hidden;"><div style="height:100%;width:${barWidth}%;background:rgba(96,165,250,0.7);border-radius:3px;"></div></div>` : ''}
        </td>
      </tr>
    `
  }).join('')

  return deviceFilterHtml + `
    <div style="overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead>
          <tr style="border-bottom:1px solid rgba(255,255,255,0.12);">
            <th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;color:rgba(255,255,255,0.4);">Източник</th>
            <th style="padding:8px 12px;text-align:right;font-size:10px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;color:rgba(255,255,255,0.4);">Посетители</th>
            <th style="padding:8px 12px;text-align:right;font-size:10px;font-weight:800;letter-spacing:0.1em;text-transform:uppercase;color:rgba(255,255,255,0.4);">%</th>
            <th style="padding:8px 12px;width:160px;"></th>
          </tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>
  `
}

function renderAdminServerPanel(state: LobbyScreenState): string {
  if (!state.isAdmin) {
    return `<div style="min-height:520px;display:flex;align-items:center;justify-content:center;color:#fecaca;font-size:15px;font-weight:800;">Нямаш достъп.</div>`
  }

  const snap = state.adminMonitoringSnapshot
  const errorText = state.adminMonitoringErrorText

  const PHASE_LABELS: Record<string, string> = {
    'cutting': 'Разрязване',
    'deal-first-3': 'Раздаване 1-3',
    'deal-next-2': 'Раздаване 4-5',
    'bidding': 'Обявяване',
    'deal-last-3': 'Раздаване 6-8',
    'playing': 'Игра',
    'scoring': 'Резултати',
  }

  const WORKER_STATE_LABELS: Record<string, string> = {
    ready: 'Работи',
    starting: 'Стартира',
    failed: 'Грешка',
    stopped: 'Спрян',
    shutting_down: 'Спира',
  }
  const fmtWorkerState = (s: string): string => WORKER_STATE_LABELS[s] ?? s

  const sectionLabel = (text: string) =>
    `<div style="font-size:10px;font-weight:800;letter-spacing:0.12em;text-transform:uppercase;color:rgba(255,255,255,0.45);margin-bottom:10px;">${text}</div>`

  if (!snap) {
    return `
      <section style="padding:0 4px;">
        <h2 style="font-size:18px;font-weight:800;color:#d4a520;margin:0 0 6px;letter-spacing:0.04em;text-transform:uppercase;">Сървър</h2>
        <p style="font-size:12px;color:rgba(255,255,255,0.4);margin:0 0 24px;">Наблюдение в реално време</p>
        ${errorText ? `
          <div style="background:rgba(127,29,29,0.3);border:1px solid rgba(248,113,113,0.3);border-radius:8px;padding:12px 16px;color:#fca5a5;font-size:13px;font-weight:700;">${escapeHtml(errorText)}</div>
        ` : `
          <div style="min-height:200px;display:flex;align-items:center;justify-content:center;color:#d4a520;font-size:16px;font-weight:800;">Зареждане...</div>
        `}
      </section>
    `
  }

  const statusLabel = snap.samplerStatus === 'running' ? 'Работи'
    : snap.samplerStatus === 'warming_up' ? 'Загрява'
    : 'Проблем'
  const statusColor = snap.samplerStatus === 'running' ? '#22c55e'
    : snap.samplerStatus === 'warming_up' ? '#f59e0b'
    : '#ef4444'

  const fmt1 = (n: number) => n.toFixed(1)
  const fmt0 = (n: number) => n.toFixed(0)

  // ── RAM: над 1024 MB → GB ──
  const fmtMb = (mb: number): { value: string; unit: string } => {
    if (mb >= 1024) return { value: (mb / 1024).toFixed(1), unit: 'GB' }
    return { value: fmt0(mb), unit: 'MB' }
  }
  const ramUsed = fmtMb(snap.ramUsedMb)
  const ramTotal = fmtMb(snap.ramTotalMb)
  const ramUnit = ramUsed.unit === ramTotal.unit ? ramUsed.unit : `${ramUsed.unit}/${ramTotal.unit}`
  const rssFormatted = fmtMb(snap.processRssMb)

  // ── Uptime ──
  const fmtUptime = (sec: number): string => {
    const d = Math.floor(sec / 86400)
    const h = Math.floor((sec % 86400) / 3600)
    const m = Math.floor((sec % 3600) / 60)
    if (d > 0) return `${d}д ${h}ч ${m}мин`
    if (h > 0) return `${h}ч ${m}мин`
    return `${m}мин`
  }

  // ── Форматиране на час/дата ──
  const fmtLocalTime = (iso: string): string => {
    try {
      return new Date(iso).toLocaleTimeString('bg-BG', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    } catch { return iso }
  }
  const fmtLocalDateTime = (iso: string): string => {
    try {
      return new Date(iso).toLocaleString('bg-BG', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    } catch { return iso }
  }

  const sampledAgo = Math.max(0, Math.round((Date.now() - snap.sampledAtMs) / 1000))
  const sampleWindowSec = (snap.sampleWindowMs / 1000).toFixed(1)

  // ── Метрична карта (стандартна — 1 ред стойност) ──
  const card = (label: string, value: string, unit: string) => `
    <div style="background:#0d0d0d;border:1px solid rgba(212,165,32,0.28);border-radius:10px;padding:14px 16px;min-height:76px;box-sizing:border-box;display:flex;flex-direction:column;justify-content:space-between;">
      <div style="font-size:10px;font-weight:800;letter-spacing:0.12em;text-transform:uppercase;color:rgba(255,255,255,0.45);margin-bottom:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${label}</div>
      <div style="display:flex;align-items:baseline;gap:4px;min-width:0;">
        <span style="font-size:22px;font-weight:900;color:#ffffff;white-space:nowrap;">${value}</span>
        ${unit ? `<span style="font-size:11px;color:rgba(255,255,255,0.38);white-space:nowrap;">${unit}</span>` : ''}
      </div>
    </div>
  `

  // ── RAM карта (2 реда: стойност + процент) ──
  const ramCard = () => `
    <div style="background:#0d0d0d;border:1px solid rgba(212,165,32,0.28);border-radius:10px;padding:14px 16px;min-height:76px;box-sizing:border-box;display:flex;flex-direction:column;justify-content:space-between;">
      <div style="font-size:10px;font-weight:800;letter-spacing:0.12em;text-transform:uppercase;color:rgba(255,255,255,0.45);margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">RAM</div>
      <div style="font-size:18px;font-weight:900;color:#ffffff;line-height:1.2;word-break:break-word;">${ramUsed.value} / ${ramTotal.value} <span style="font-size:11px;color:rgba(255,255,255,0.38);font-weight:700;">${ramUnit}</span></div>
      <div style="font-size:12px;font-weight:700;color:rgba(255,255,255,0.5);margin-top:2px;">${fmt1(snap.ramPercent)}%</div>
    </div>
  `

  const matchmakingRows = Object.entries(snap.matchmakingWaitersByStake)
    .filter(([, count]) => count > 0)
    .map(([stake, count]) => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.06);">
        <span style="font-size:12px;color:rgba(255,255,255,0.65);font-weight:700;">${escapeHtml(stake)}</span>
        <span style="font-size:13px;color:#ffffff;font-weight:800;">${count}</span>
      </div>
    `).join('')

  const phaseRows = Object.entries(snap.roomsByPhase)
    .filter(([, count]) => count > 0)
    .map(([phase, count]) => {
      const label = PHASE_LABELS[phase] ?? phase
      return `<span style="display:inline-flex;align-items:center;gap:5px;background:rgba(212,165,32,0.12);border:1px solid rgba(212,165,32,0.28);border-radius:20px;padding:3px 10px;font-size:11px;font-weight:800;color:#d4a520;">${escapeHtml(label)}<span style="color:rgba(255,255,255,0.8);">${count}</span></span>`
    }).join('')

  // ── Worker pool ──
  let workerPoolHtml = ''
  if (snap.workerPool === null) {
    workerPoolHtml = `<p style="color:rgba(255,255,255,0.45);font-size:13px;font-style:italic;margin:0;">Worker pool не е активен в текущия режим.</p>`
  } else {
    const wp = snap.workerPool
    const poolOk = wp.failedWorkers === 0
    const poolColor = poolOk ? '#22c55e' : '#ef4444'
    const totalCapacity = wp.workerCount * wp.maxRoomsPerWorker
    const capacityPct = totalCapacity > 0 ? Math.round((wp.totalAssignedRooms / totalCapacity) * 100) : 0

    const workerCards = wp.workers.map((w) => {
      const hasPending = w.shadow.pendingOperations > 0
      const hasError = w.lastError !== null || w.shadow.lastError !== null
      const inconsistent = !w.shadow.isConsistent
      const rowColor = hasError || inconsistent ? '#ef4444' : hasPending ? '#f59e0b' : '#22c55e'
      const errMsg = w.lastError ?? w.shadow.lastError
      const wCapPct = w.maxRooms > 0 ? Math.round((w.assignedRooms / w.maxRooms) * 100) : 0
      const desiredMatch = w.shadow.desiredRooms === w.shadow.confirmedRooms
      const borderColor = hasError || inconsistent ? 'rgba(239,68,68,0.35)' : hasPending ? 'rgba(245,158,11,0.3)' : 'rgba(255,255,255,0.08)'

      return `
        <div style="background:#111111;border:1px solid ${borderColor};border-radius:8px;padding:12px 14px;min-width:0;">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
            <div style="width:8px;height:8px;border-radius:50%;background:${rowColor};flex-shrink:0;"></div>
            <span style="font-size:12px;font-weight:800;color:#ffffff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(w.workerId)}</span>
            <span style="margin-left:auto;font-size:12px;font-weight:700;color:rgba(255,255,255,0.55);white-space:nowrap;">${fmtWorkerState(w.state)}${w.shadow.isShuttingDown ? ' · Спира' : ''}</span>
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:5px 14px;line-height:1.5;">
            <span style="font-size:12px;color:rgba(255,255,255,0.65);">Стаи: <strong style="color:#fff;">${w.assignedRooms}/${w.maxRooms}</strong> <span style="color:rgba(255,255,255,0.4);">(${wCapPct}%)</span></span>
            <span style="font-size:12px;color:rgba(255,255,255,0.65);">Жел./Потв.: <strong style="color:${desiredMatch ? 'rgba(255,255,255,0.75)' : '#f59e0b'};">${w.shadow.desiredRooms}/${w.shadow.confirmedRooms}</strong></span>
            ${hasPending ? `<span style="font-size:12px;color:#f59e0b;font-weight:700;">Чакащи: ${w.shadow.pendingOperations}</span>` : ''}
            <span style="font-size:12px;color:${w.shadow.isConsistent ? 'rgba(255,255,255,0.4)' : '#ef4444'};font-weight:${w.shadow.isConsistent ? '400' : '700'};">${w.shadow.isConsistent ? 'Синхронизиран' : 'Несинхронизиран'}</span>
          </div>
          ${errMsg ? `<div style="margin-top:7px;font-size:11px;color:#fca5a5;border-top:1px solid rgba(239,68,68,0.2);padding-top:6px;line-height:1.4;">${escapeHtml(errMsg)}</div>` : ''}
        </div>
      `
    }).join('')

    workerPoolHtml = `
      <div style="display:flex;flex-wrap:wrap;align-items:center;gap:8px 20px;margin-bottom:14px;padding-bottom:12px;border-bottom:1px solid rgba(255,255,255,0.07);">
        <div style="display:flex;align-items:center;gap:7px;">
          <div style="width:10px;height:10px;border-radius:50%;background:${poolColor};flex-shrink:0;"></div>
          <span style="font-size:14px;font-weight:800;color:#ffffff;">${wp.readyWorkers} / ${wp.workerCount} работят</span>
          ${wp.failedWorkers > 0 ? `<span style="font-size:12px;color:#ef4444;font-weight:700;">· ${wp.failedWorkers} неуспешни</span>` : ''}
        </div>
        <span style="font-size:12px;color:rgba(255,255,255,0.5);">${fmtWorkerState(wp.state)}</span>
        <span style="font-size:12px;color:rgba(255,255,255,0.5);">Стаи: ${wp.totalAssignedRooms} / ${totalCapacity} <span style="color:rgba(255,255,255,0.35);">(${capacityPct}%)</span></span>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:8px;">${workerCards}</div>
    `
  }

  // ── История section ──
  const historyResult = state.adminHistoryResult
  const historyLoading = state.adminHistoryLoading
  const historyErrorText = state.adminHistoryErrorText
  const activeWindow = state.adminHistoryWindow

  const windowBtn = (w: HistoryWindow) => {
    const isActive = w === activeWindow
    return `<button type="button" data-history-window="${w}" style="height:30px;padding:0 12px;border:1px solid ${isActive ? 'rgba(212,165,32,0.7)' : 'rgba(255,255,255,0.14)'};border-radius:6px;background:${isActive ? 'rgba(212,165,32,0.14)' : 'transparent'};color:${isActive ? '#d4a520' : 'rgba(255,255,255,0.55)'};font-size:12px;font-weight:800;cursor:${isActive ? 'default' : 'pointer'};white-space:nowrap;">${getWindowLabel(w)}</button>`
  }

  let historyHtml = ''
  if (historyLoading) {
    historyHtml = `<div style="height:60px;display:flex;align-items:center;justify-content:center;color:#d4a520;font-size:13px;font-weight:800;">Зареждане...</div>`
  } else if (historyErrorText) {
    historyHtml = `<div style="background:rgba(127,29,29,0.3);border:1px solid rgba(248,113,113,0.3);border-radius:8px;padding:10px 14px;color:#fca5a5;font-size:12px;font-weight:700;">${escapeHtml(historyErrorText)}</div>`
  } else if (historyResult) {
    const hasData = historyResult.points.length > 0
    const emptyMsg = !hasData ? `<p style="color:rgba(255,255,255,0.35);font-size:12px;font-style:italic;margin:0 0 12px;">Още няма записи за избрания период.</p>` : ''
    historyHtml = `
      ${emptyMsg}
      <div style="margin-bottom:14px;">
        ${sectionLabel('Пикови стойности за периода')}
        ${renderPeakCards(historyResult.peaks, escapeHtml)}
      </div>
      <div style="margin-bottom:6px;">
        ${sectionLabel('Пикова активност')}
        ${renderPeakMoments(historyResult.peakMoments, activeWindow, escapeHtml)}
      </div>
      ${renderHistoryInfoRow(historyResult, activeWindow, escapeHtml)}
    `
  }

  // ── WS Connections section ──
  const wsConns = state.adminWsConnections
  let wsConnectionsHtml = ''
  if (wsConns === null) {
    wsConnectionsHtml = `<div style="height:40px;display:flex;align-items:center;color:rgba(255,255,255,0.35);font-size:12px;font-style:italic;">Зареждане...</div>`
  } else {
    const sm = wsConns.summary

    const smChip = (label: string, value: number, warn = false) => {
      const color = warn && value > 0 ? '#f59e0b' : 'rgba(255,255,255,0.75)'
      return `<span style="display:inline-flex;align-items:center;gap:5px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:20px;padding:3px 10px;font-size:11px;font-weight:700;color:rgba(255,255,255,0.45);">${escapeHtml(label)}<span style="color:${color};font-weight:900;">${value}</span></span>`
    }

    const fmtAgo = (ms: number): string => {
      if (ms === 0) return '—'
      const sec = Math.max(0, Math.round((Date.now() - ms) / 1000))
      if (sec < 60) return `${sec} сек.`
      const min = Math.floor(sec / 60)
      if (min < 60) return `${min} мин.`
      return `${Math.floor(min / 60)} ч.`
    }

    const connTypeLabel = (e: WsConnectionsResult['entries'][number]): string => {
      if (e.profileId === null) return 'Гост'
      if (e.currentRoomId !== null) return 'Игрова'
      if (e.probablePendingSessionInGame) return 'Чака поемане'
      return 'Обикновена'
    }

    const connTypeColor = (e: WsConnectionsResult['entries'][number]): string => {
      if (e.profileId === null) return 'rgba(255,255,255,0.4)'
      if (e.currentRoomId !== null) return '#22c55e'
      if (e.probablePendingSessionInGame) return '#f59e0b'
      return 'rgba(255,255,255,0.65)'
    }

    const rsColor = (label: string): string => {
      if (label === 'OPEN') return '#22c55e'
      if (label === 'CONNECTING') return '#f59e0b'
      if (label === 'CLOSING') return '#f59e0b'
      return 'rgba(255,255,255,0.28)'
    }

    const rows = wsConns.entries.map((e) => {
      const rsLabel = escapeHtml(e.readyStateLabel ?? (e.isOpen ? 'OPEN' : 'CLOSED'))
      const rsDotColor = rsColor(e.readyStateLabel ?? (e.isOpen ? 'OPEN' : 'CLOSED'))
      const dot = `<div style="width:7px;height:7px;border-radius:50%;background:${rsDotColor};flex-shrink:0;"></div>`
      const name = escapeHtml(e.displayName ?? (e.profileId === null ? 'Гост' : e.profileId.slice(0, 8)))
      const connIdShort = escapeHtml(e.connectionId.slice(0, 8))
      const connIdFull = escapeHtml(e.connectionId)
      const roomShort = e.currentRoomId ? escapeHtml(e.currentRoomId.slice(0, 8)) : '—'
      const typeLabel = connTypeLabel(e)
      const typeColor = connTypeColor(e)
      return `
        <tr>
          <td style="padding:7px 10px 7px 0;white-space:nowrap;">
            <div style="display:flex;align-items:center;gap:6px;">${dot}<span style="font-size:12px;font-weight:700;color:#fff;">${name}</span></div>
          </td>
          <td style="padding:7px 10px;white-space:nowrap;">
            <span title="${connIdFull}" style="font-size:11px;font-weight:700;color:rgba(255,255,255,0.45);font-family:monospace;cursor:default;">${connIdShort}</span>
            <span style="font-size:10px;color:${rsDotColor};font-weight:800;margin-left:4px;">${rsLabel}</span>
          </td>
          <td style="padding:7px 10px;white-space:nowrap;">
            <span style="font-size:11px;font-weight:800;color:${typeColor};">${escapeHtml(typeLabel)}</span>
          </td>
          <td style="padding:7px 10px;white-space:nowrap;font-size:11px;color:rgba(255,255,255,0.5);">${roomShort}</td>
          <td style="padding:7px 10px;white-space:nowrap;font-size:11px;color:rgba(255,255,255,0.4);font-family:monospace;">${escapeHtml(e.maskedIp ?? '—')}</td>
          <td style="padding:7px 10px;white-space:nowrap;font-size:11px;color:rgba(255,255,255,0.4);">${fmtAgo(e.connectedAtMs)}</td>
          <td style="padding:7px 0 7px 10px;white-space:nowrap;font-size:11px;color:rgba(255,255,255,0.4);">${fmtAgo(e.lastSeenAtMs)}</td>
        </tr>
      `
    }).join('')

    const tableHtml = wsConns.entries.length === 0
      ? `<p style="font-size:12px;color:rgba(255,255,255,0.35);font-style:italic;margin:8px 0 0;">Няма активни WS връзки.</p>`
      : `<div style="overflow-x:auto;margin-top:10px;">
          <table style="width:100%;border-collapse:collapse;font-size:12px;">
            <thead>
              <tr style="border-bottom:1px solid rgba(255,255,255,0.08);">
                <th style="text-align:left;padding:5px 10px 5px 0;font-size:10px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.3);">Профил</th>
                <th style="text-align:left;padding:5px 10px;font-size:10px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.3);">ID / Стат.</th>
                <th style="text-align:left;padding:5px 10px;font-size:10px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.3);">Тип</th>
                <th style="text-align:left;padding:5px 10px;font-size:10px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.3);">Стая</th>
                <th style="text-align:left;padding:5px 10px;font-size:10px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.3);">IP</th>
                <th style="text-align:left;padding:5px 10px;font-size:10px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.3);">Свързан</th>
                <th style="text-align:left;padding:5px 0 5px 10px;font-size:10px;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.3);">Последна акт.</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`

    wsConnectionsHtml = `
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px;">
        ${smChip('OPEN', sm.openSocketCount)}
        ${smChip('Авт.', sm.authenticatedOpenSockets)}
        ${smChip('Гости', sm.guestOpenSockets)}
        ${smChip('>1 връзка', sm.profilesWithMultipleOpenSockets, true)}
        ${smChip('Registry', sm.registrySize)}
      </div>
      ${tableHtml}
    `
  }

  return `
    <section style="padding:0 4px;">

      <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;">
        <h2 style="font-size:18px;font-weight:800;color:#d4a520;margin:0;letter-spacing:0.04em;text-transform:uppercase;">Сървър</h2>
        <div style="display:flex;align-items:center;gap:6px;">
          <div style="width:8px;height:8px;border-radius:50%;background:${statusColor};flex-shrink:0;"></div>
          <span style="font-size:13px;font-weight:800;color:${statusColor};">${statusLabel}</span>
        </div>
        <span style="font-size:11px;color:rgba(255,255,255,0.3);margin-left:4px;">Наблюдение в реално време</span>
      </div>

      <div style="background:#0a0a0a;border:1px solid rgba(212,165,32,0.18);border-radius:10px;padding:12px 16px;margin-bottom:20px;display:flex;flex-wrap:wrap;gap:6px 28px;">
        <div style="display:flex;align-items:center;gap:6px;">
          <span style="font-size:11px;color:rgba(255,255,255,0.38);text-transform:uppercase;letter-spacing:0.08em;">Последна проба</span>
          <span style="font-size:12px;font-weight:700;color:rgba(255,255,255,0.75);">${fmtLocalTime(snap.sampledAtIso)}</span>
          <span style="font-size:11px;color:rgba(255,255,255,0.3);">· преди ${sampledAgo} сек.</span>
        </div>
        <div style="display:flex;align-items:center;gap:6px;">
          <span style="font-size:11px;color:rgba(255,255,255,0.38);text-transform:uppercase;letter-spacing:0.08em;">Интервал</span>
          <span style="font-size:12px;font-weight:700;color:rgba(255,255,255,0.75);">${sampleWindowSec} сек.</span>
        </div>
        <div style="display:flex;align-items:center;gap:6px;">
          <span style="font-size:11px;color:rgba(255,255,255,0.38);text-transform:uppercase;letter-spacing:0.08em;">Работи от</span>
          <span style="font-size:12px;font-weight:700;color:rgba(255,255,255,0.75);">${fmtLocalDateTime(snap.backendStartedAtIso)}</span>
        </div>
        <div style="display:flex;align-items:center;gap:6px;">
          <span style="font-size:11px;color:rgba(255,255,255,0.38);text-transform:uppercase;letter-spacing:0.08em;">Uptime</span>
          <span style="font-size:12px;font-weight:700;color:rgba(255,255,255,0.75);">${fmtUptime(snap.processUptimeSec)}</span>
        </div>
      </div>

      ${errorText ? `
        <div style="background:rgba(127,29,29,0.3);border:1px solid rgba(248,113,113,0.3);border-radius:8px;padding:10px 14px;color:#fca5a5;font-size:12px;font-weight:700;margin-bottom:16px;">${escapeHtml(errorText)}</div>
      ` : ''}

      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;margin-bottom:20px;">
        ${card('VPS CPU', snap.serverCpuNowPercent !== null ? fmt1(snap.serverCpuNowPercent) : '—', '%')}
        ${card('Node CPU', snap.nodeCpuNowPercent !== null ? fmt1(snap.nodeCpuNowPercent) : '—', '%')}
        ${ramCard()}
        ${card('RSS процес', rssFormatted.value, rssFormatted.unit)}
        ${card('WS връзки', String(snap.activeWsConnections), '')}
        ${card('Играчи онлайн', String(snap.uniqueOnlineRealPlayers), '')}
        ${card('Активни стаи', String(snap.activeRooms), '')}
        ${card('Опашка', String(snap.totalMatchmakingWaiters), '')}
      </div>

      ${snap.totalMatchmakingWaiters > 0 ? `
        <div style="background:#0d0d0d;border:1px solid rgba(212,165,32,0.28);border-radius:10px;padding:14px 18px;margin-bottom:20px;">
          ${sectionLabel('Опашка по залог')}
          ${matchmakingRows}
        </div>
      ` : ''}

      ${phaseRows ? `
        <div style="background:#0d0d0d;border:1px solid rgba(212,165,32,0.28);border-radius:10px;padding:14px 18px;margin-bottom:20px;">
          ${sectionLabel('Стаи по фаза')}
          <div style="display:flex;flex-wrap:wrap;gap:6px;">${phaseRows}</div>
        </div>
      ` : ''}

      <div style="background:#0d0d0d;border:1px solid rgba(212,165,32,0.28);border-radius:10px;padding:14px 18px;">
        ${sectionLabel('Worker pool')}
        ${workerPoolHtml}
      </div>

      <div style="background:#0d0d0d;border:1px solid rgba(212,165,32,0.28);border-radius:10px;padding:14px 18px;margin-top:20px;">
        ${sectionLabel('WEB SOCKET ВРЪЗКИ')}
        ${wsConnectionsHtml}
      </div>

      <div style="margin-top:28px;">
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:14px;">
          <h3 style="font-size:14px;font-weight:800;color:#d4a520;margin:0;letter-spacing:0.06em;text-transform:uppercase;">История</h3>
          <div style="display:flex;gap:6px;">
            ${windowBtn('1h')}
            ${windowBtn('24h')}
            ${windowBtn('7d')}
          </div>
        </div>
        ${historyHtml}
      </div>

    </section>
  `
}

function renderAdminPanel(state: LobbyScreenState, isMobile = false): string {
  if (!state.isAdmin) {
    return `
      <div style="min-height:520px;display:flex;align-items:center;justify-content:center;border:1px solid rgba(248,113,113,0.34);background:rgba(127,29,29,0.28);border-radius:8px;color:#fecaca;font-size:15px;font-weight:800;text-align:center;padding:20px;">
        Нямаш достъп до админ панела.
      </div>
    `
  }

  if (state.adminSettingsLoading) {
    return `
      <div style="min-height:520px;display:flex;align-items:center;justify-content:center;border:1px solid rgba(212,165,32,0.34);background:#050505;border-radius:8px;color:#d4a520;font-size:18px;font-weight:900;">
        Зареждане на настройки...
      </div>
    `
  }

  const settings = state.adminSettings ?? {
    signupBonusYellowCoins: state.signupBonusYellowCoins,
    profileNameChangePrice: 50_000,
  }
  const adminPackages = state.adminCoinPackages
  const settingsGridStyle = isMobile
    ? 'display:grid;grid-template-columns:minmax(0,1fr);gap:14px;'
    : 'display:grid;grid-template-columns:1fr 1fr;gap:14px;'
  const adminPackageListStyle = isMobile
    ? 'width:100%;display:grid;gap:8px;box-sizing:border-box;'
    : 'width:min(100%,980px);display:grid;gap:8px;'
  const adminPackageRowStyle = (isEditing: boolean) => isMobile
    ? `display:grid;grid-template-columns:minmax(0,1fr);gap:10px;align-items:start;border:1px solid ${isEditing ? 'rgba(212,165,32,0.55)' : 'rgba(255,255,255,0.10)'};border-radius:8px;background:${isEditing ? 'rgba(212,165,32,0.06)' : '#090909'};padding:12px;box-sizing:border-box;`
    : `display:grid;grid-template-columns:1.2fr 0.9fr 0.8fr 0.7fr auto;gap:10px;align-items:center;border:1px solid ${isEditing ? 'rgba(212,165,32,0.55)' : 'rgba(255,255,255,0.10)'};border-radius:8px;background:${isEditing ? 'rgba(212,165,32,0.06)' : '#090909'};padding:12px;`
  const adminPackageActionsStyle = isMobile
    ? 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;'
    : 'display:flex;align-items:center;gap:10px;'
  const adminPackageFormStyle = (isEditing: boolean) => isMobile
    ? `width:100%;box-sizing:border-box;display:grid;grid-template-columns:minmax(0,1fr);gap:12px;border:1px solid ${isEditing ? 'rgba(212,165,32,0.55)' : 'rgba(212,165,32,0.30)'};border-radius:8px;background:linear-gradient(180deg,#141414 0%,#050505 100%);padding:14px;`
    : `width:min(100%,980px);display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;border:1px solid ${isEditing ? 'rgba(212,165,32,0.55)' : 'rgba(212,165,32,0.30)'};border-radius:8px;background:linear-gradient(180deg,#141414 0%,#050505 100%);padding:18px;`
  const adminDailyRewardsGridStyle = isMobile
    ? 'display:grid;grid-template-columns:minmax(0,1fr);gap:16px;align-items:start;'
    : 'display:grid;grid-template-columns:1fr 1fr;gap:20px;align-items:start;'
  const adminDailyRewardsFormStyle = isMobile
    ? 'display:grid;grid-template-columns:minmax(0,1fr);gap:8px;align-items:stretch;'
    : 'display:flex;gap:8px;align-items:flex-end;'
  const adminRoomsListStyle = isMobile
    ? 'display:grid;gap:8px;margin-bottom:14px;width:100%;box-sizing:border-box;'
    : 'display:grid;gap:8px;margin-bottom:14px;max-width:720px;'
  const adminRoomRowStyle = (isEnabled: boolean) => isMobile
    ? `display:grid;grid-template-columns:minmax(0,1fr);gap:10px;border:1px solid rgba(52,211,153,${isEnabled ? '0.4' : '0.12'});border-radius:8px;background:rgba(10,30,20,${isEnabled ? '0.5' : '0.2'});padding:10px 14px;box-sizing:border-box;`
    : `display:flex;align-items:center;gap:10px;border:1px solid rgba(52,211,153,${isEnabled ? '0.4' : '0.12'});border-radius:8px;background:rgba(10,30,20,${isEnabled ? '0.5' : '0.2'});padding:10px 14px;`
  const adminRoomActionsStyle = isMobile
    ? 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;'
    : 'display:contents;'
  const adminRoomFormStyle = isMobile
    ? 'border:1px solid rgba(52,211,153,0.30);border-radius:8px;background:#050505;padding:14px;display:grid;gap:12px;width:100%;box-sizing:border-box;'
    : 'border:1px solid rgba(52,211,153,0.30);border-radius:8px;background:#050505;padding:16px;display:grid;gap:12px;max-width:720px;'
  const adminRoomFormGridStyle = isMobile
    ? 'display:grid;grid-template-columns:minmax(0,1fr);gap:10px;'
    : 'display:grid;grid-template-columns:1fr 1fr;gap:10px;'
  const adminRoomFormActionsStyle = isMobile
    ? 'display:flex;gap:10px;flex-wrap:wrap;'
    : 'display:flex;gap:10px;'
  const adminMissionRowStyle = (borderColor: string, backgroundColor: string) => isMobile
    ? `display:grid;grid-template-columns:minmax(0,1fr);gap:10px;border:1px solid ${borderColor};border-radius:8px;background:${backgroundColor};padding:10px 14px;box-sizing:border-box;`
    : `display:flex;align-items:center;gap:10px;border:1px solid ${borderColor};border-radius:8px;background:${backgroundColor};padding:10px 14px;`
  const adminMissionActionsStyle = isMobile
    ? 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;'
    : 'display:contents;'
  const adminMissionFormStyle = (borderColor: string) => isMobile
    ? `border:1px solid ${borderColor};border-radius:8px;background:#050505;padding:14px;display:grid;gap:12px;width:100%;box-sizing:border-box;`
    : `border:1px solid ${borderColor};border-radius:8px;background:#050505;padding:16px;display:grid;gap:12px;`
  const adminMissionFormGridStyle = isMobile
    ? 'display:grid;grid-template-columns:minmax(0,1fr);gap:10px;'
    : 'display:grid;grid-template-columns:1fr 1fr;gap:10px;'
  const adminMissionFormActionsStyle = isMobile
    ? 'display:flex;gap:10px;flex-wrap:wrap;'
    : 'display:flex;gap:10px;'

  return `
    <section style="min-height:520px;display:grid;gap:14px;align-content:start;">
      <div style="display:flex;align-items:end;justify-content:space-between;gap:16px;border-bottom:1px solid rgba(212,165,32,0.28);padding-bottom:12px;">
        <div>
          <div style="font-size:26px;line-height:1.05;font-weight:900;color:#f8fafc;">Админ панел</div>
          <div style="margin-top:6px;font-size:13px;font-weight:700;color:rgba(255,255,255,0.56);">Настройки за икономика и профили.</div>
        </div>
      </div>

      <form data-lobby-admin-settings-form="1" style="display:grid;gap:14px;border:1px solid rgba(212,165,32,0.30);border-radius:8px;background:linear-gradient(180deg,#141414 0%,#050505 100%);padding:${isMobile ? '14px' : '18px'};box-sizing:border-box;max-width:100%;">
        <div style="${settingsGridStyle}">
          <label style="display:grid;gap:7px;font-size:12px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#d4a520;">
            Signup bonus жълтици
            <input name="signupBonusYellowCoins" type="number" min="0" max="10000000" step="1000" value="${settings.signupBonusYellowCoins}" style="width:100%;box-sizing:border-box;height:44px;border-radius:8px;border:1px solid rgba(212,165,32,0.34);background:#050505;color:#ffffff;padding:0 12px;font-size:15px;font-weight:800;outline:none;">
          </label>

          <label style="display:grid;gap:7px;font-size:12px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#d4a520;">
            Цена за смяна на име
            <input name="profileNameChangePrice" type="number" min="0" max="10000000" step="1000" value="${settings.profileNameChangePrice}" style="width:100%;box-sizing:border-box;height:44px;border-radius:8px;border:1px solid rgba(212,165,32,0.34);background:#050505;color:#ffffff;padding:0 12px;font-size:15px;font-weight:800;outline:none;">
          </label>
        </div>

        ${state.adminSettingsErrorText ? `
          <div style="border-radius:8px;border:1px solid rgba(248,113,113,0.28);background:rgba(127,29,29,0.42);padding:10px 12px;color:#fecaca;font-size:13px;font-weight:800;">
            ${escapeHtml(state.adminSettingsErrorText)}
          </div>
        ` : ''}

        <div style="display:flex;justify-content:flex-end;">
          <button type="submit" style="height:44px;padding:0 18px;border:0;border-radius:8px;background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;font-size:14px;font-weight:900;cursor:pointer;">
            Запази
          </button>
        </div>
      </form>

      <div style="display:grid;gap:12px;margin-top:8px;">
        <div style="display:flex;align-items:end;justify-content:space-between;gap:12px;">
          <div>
            <div style="font-size:20px;line-height:1.1;font-weight:900;color:#f8fafc;">Пакети жълтици</div>
            <div style="margin-top:5px;font-size:12px;font-weight:700;color:rgba(255,255,255,0.54);">Активните пакети се показват в магазина.</div>
          </div>
          ${state.adminCoinPackagesLoading ? `
            <div style="font-size:12px;font-weight:900;color:#d4a520;">Зареждане...</div>
          ` : ''}
        </div>

        ${state.adminCoinPackagesErrorText ? `
          <div style="width:min(100%,980px);border-radius:8px;border:1px solid rgba(248,113,113,0.28);background:rgba(127,29,29,0.42);padding:10px 12px;color:#fecaca;font-size:13px;font-weight:800;">
            ${escapeHtml(state.adminCoinPackagesErrorText)}
          </div>
        ` : ''}

        <div style="${adminPackageListStyle}">
          ${adminPackages.length === 0 ? `
            <div style="border:1px solid rgba(255,255,255,0.10);border-radius:8px;background:#080808;padding:14px;color:rgba(255,255,255,0.58);font-size:13px;font-weight:800;">Няма създадени пакети.</div>
          ` : adminPackages.map((coinPackage) => {
            const isEditing = state.adminCoinPackageEditId === coinPackage.packageId
            return `
            <div style="${adminPackageRowStyle(isEditing)}">
              <div>
                <div style="font-size:14px;font-weight:900;color:#f8fafc;">${escapeHtml(coinPackage.title)}</div>
                <div style="margin-top:3px;font-size:11px;font-weight:800;color:rgba(255,255,255,0.44);">${escapeHtml(coinPackage.packageKey)}</div>
              </div>
              <div style="font-size:14px;font-weight:900;color:#d4a520;">${formatAmount(coinPackage.yellowCoinsAmount)}</div>
              <div style="font-size:14px;font-weight:900;color:#f8fafc;">${escapeHtml(formatPackagePrice(coinPackage.priceCents, coinPackage.currency))}</div>
              <div style="font-size:12px;font-weight:900;color:${coinPackage.status === 'active' ? '#86efac' : 'rgba(255,255,255,0.46)'};">${coinPackage.status}</div>
              <div style="${adminPackageActionsStyle}">
                <label style="display:flex;align-items:center;gap:5px;cursor:pointer;user-select:none;white-space:nowrap;" title="Видима в лобито">
                  <input type="checkbox"
                    data-lobby-admin-package-lobby="${escapeHtml(coinPackage.packageId)}"
                    ${coinPackage.showInLobby ? 'checked' : ''}
                    style="width:15px;height:15px;accent-color:#d4a520;cursor:pointer;flex-shrink:0;">
                  <span style="font-size:10px;font-weight:800;color:rgba(212,165,32,0.85);text-transform:uppercase;letter-spacing:0.05em;">Лоби</span>
                </label>
                <button type="button" data-lobby-admin-package-edit="${escapeHtml(coinPackage.packageId)}" style="height:36px;padding:0 12px;border:1px solid rgba(212,165,32,0.28);border-radius:8px;background:${isEditing ? 'rgba(212,165,32,0.18)' : '#111111'};color:#d4a520;font-size:12px;font-weight:900;cursor:pointer;">
                  ${isEditing ? 'Редактира се' : 'Редактирай'}
                </button>
                <button type="button" data-lobby-admin-package-status="${escapeHtml(coinPackage.packageId)}" data-lobby-admin-package-next-status="${coinPackage.status === 'active' ? 'inactive' : 'active'}" style="height:36px;padding:0 12px;border:1px solid rgba(255,255,255,0.14);border-radius:8px;background:#111111;color:rgba(255,255,255,0.65);font-size:12px;font-weight:900;cursor:pointer;">
                  ${coinPackage.status === 'active' ? 'Скрий' : 'Активирай'}
                </button>
                <button type="button" data-lobby-admin-package-delete="${escapeHtml(coinPackage.packageId)}" style="height:36px;padding:0 10px;border:1px solid rgba(248,113,113,0.28);border-radius:8px;background:#111111;color:#f87171;font-size:12px;font-weight:900;cursor:pointer;">
                  Изтрий
                </button>
              </div>
            </div>
          `}).join('')}
        </div>

        ${(() => {
          const editPackage = state.adminCoinPackageEditId
            ? adminPackages.find((p) => p.packageId === state.adminCoinPackageEditId) ?? null
            : null
          return `
        <form data-lobby-admin-coin-package-form="1" style="${adminPackageFormStyle(Boolean(editPackage))}">
          <input type="hidden" name="packageId" value="${escapeHtml(editPackage?.packageId ?? '')}">
          <input type="hidden" name="packageKey" value="${escapeHtml(editPackage?.packageKey ?? '')}">
          <div style="grid-column:1 / -1;font-size:15px;font-weight:900;color:${editPackage ? '#d4a520' : '#f8fafc'};">
            ${editPackage ? `Редактирай: ${escapeHtml(editPackage.title)}` : 'Нова оферта'}
          </div>
          <label style="display:grid;gap:7px;font-size:11px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#d4a520;">
            Име
            <input name="title" type="text" maxlength="80" placeholder="Starter" value="${escapeHtml(editPackage?.title ?? '')}" style="width:100%;box-sizing:border-box;height:42px;border-radius:8px;border:1px solid rgba(212,165,32,0.34);background:#050505;color:#ffffff;padding:0 12px;font-size:14px;font-weight:800;outline:none;">
          </label>
          <label style="display:grid;gap:7px;font-size:11px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#d4a520;">
            Жълтици
            <input name="yellowCoinsAmount" type="number" min="1" max="100000000" step="1" value="${editPackage?.yellowCoinsAmount ?? 100000}" style="width:100%;box-sizing:border-box;height:42px;border-radius:8px;border:1px solid rgba(212,165,32,0.34);background:#050505;color:#ffffff;padding:0 12px;font-size:14px;font-weight:800;outline:none;">
          </label>
          <label style="display:grid;gap:7px;font-size:11px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#d4a520;">
            Цена в центове
            <input name="priceCents" type="number" min="0" max="10000000" step="1" value="${editPackage?.priceCents ?? 499}" style="width:100%;box-sizing:border-box;height:42px;border-radius:8px;border:1px solid rgba(212,165,32,0.34);background:#050505;color:#ffffff;padding:0 12px;font-size:14px;font-weight:800;outline:none;">
          </label>
          <label style="display:grid;gap:7px;font-size:11px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#d4a520;">
            Валута
            <input name="currency" type="text" maxlength="3" value="${escapeHtml(editPackage?.currency ?? 'EUR')}" style="width:100%;box-sizing:border-box;height:42px;border-radius:8px;border:1px solid rgba(212,165,32,0.34);background:#050505;color:#ffffff;padding:0 12px;font-size:14px;font-weight:800;outline:none;text-transform:uppercase;">
          </label>
          <label style="display:grid;gap:7px;font-size:11px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#d4a520;">
            Подредба
            <input name="sortOrder" type="number" min="0" max="1000000" step="1" value="${editPackage?.sortOrder ?? 50}" style="width:100%;box-sizing:border-box;height:42px;border-radius:8px;border:1px solid rgba(212,165,32,0.34);background:#050505;color:#ffffff;padding:0 12px;font-size:14px;font-weight:800;outline:none;">
          </label>
          <label style="display:grid;gap:7px;font-size:11px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#d4a520;">
            Статус
            <select name="status" style="width:100%;box-sizing:border-box;height:42px;border-radius:8px;border:1px solid rgba(212,165,32,0.34);background:#050505;color:#ffffff;padding:0 12px;font-size:14px;font-weight:800;outline:none;">
              <option value="active" ${(editPackage?.status ?? 'active') === 'active' ? 'selected' : ''}>active</option>
              <option value="inactive" ${editPackage?.status === 'inactive' ? 'selected' : ''}>inactive</option>
            </select>
          </label>
          <label style="grid-column:1 / -1;display:grid;gap:7px;font-size:11px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#d4a520;">
            Описание
            <input name="description" type="text" maxlength="220" placeholder="Описание за магазина" value="${escapeHtml(editPackage?.description ?? '')}" style="width:100%;box-sizing:border-box;height:42px;border-radius:8px;border:1px solid rgba(212,165,32,0.34);background:#050505;color:#ffffff;padding:0 12px;font-size:14px;font-weight:800;outline:none;">
          </label>
          <label style="grid-column:1 / -1;display:flex;align-items:center;gap:10px;font-size:11px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#d4a520;cursor:pointer;">
            <input name="showInLobby" type="checkbox" ${editPackage?.showInLobby ? 'checked' : ''} style="width:16px;height:16px;accent-color:#d4a520;cursor:pointer;flex-shrink:0;">
            Видима в лобито
          </label>
          <div style="grid-column:1 / -1;display:flex;justify-content:flex-end;gap:8px;">
            ${editPackage ? `
              <button type="button" data-lobby-admin-package-edit-cancel="1" style="height:42px;padding:0 16px;border:1px solid rgba(255,255,255,0.18);border-radius:8px;background:transparent;color:rgba(255,255,255,0.65);font-size:13px;font-weight:900;cursor:pointer;">
                Отказ
              </button>
            ` : ''}
            <button type="submit" style="height:42px;padding:0 16px;border:0;border-radius:8px;background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;font-size:13px;font-weight:900;cursor:pointer;">
              ${editPackage ? 'Запази промените' : 'Добави оферта'}
            </button>
          </div>
        </form>
          `
        })()}
      </div>

      <div style="display:grid;gap:20px;margin-top:8px;">
        <div style="display:grid;gap:12px;">
          <div style="font-size:18px;font-weight:900;color:#60a5fa;border-bottom:1px solid rgba(96,165,250,0.22);padding-bottom:10px;">Текущи мисии</div>

          ${state.adminMissionsLoading ? `
            <div style="color:#60a5fa;font-size:13px;font-weight:800;">Зареждане на мисии...</div>
          ` : state.adminMissionsErrorText ? `
            <div style="border-radius:8px;border:1px solid rgba(248,113,113,0.28);background:rgba(127,29,29,0.42);padding:10px 12px;color:#fecaca;font-size:13px;font-weight:800;">${escapeHtml(state.adminMissionsErrorText)}</div>
          ` : ''}

          <div style="display:grid;gap:8px;">
            ${state.adminActiveMissions.length === 0 ? `
              <div style="color:rgba(255,255,255,0.35);font-size:13px;font-weight:700;padding:8px 0;">Няма текущи мисии.</div>
            ` : state.adminActiveMissions.map((mission) => `
              <div style="${adminMissionRowStyle('rgba(96,165,250,0.4)', 'rgba(10,20,40,0.5)')}">
                <div style="flex:1;min-width:0;">
                  <div style="font-size:13px;font-weight:800;color:#f8fafc;">${escapeHtml(mission.title)}</div>
                  <div style="font-size:11px;color:rgba(255,255,255,0.45);">Цел: ${mission.targetCount} · Награда: ${formatAmount(mission.rewardYellowCoins)} жълтици · <span style="color:rgba(255,255,255,0.35);">${mission.missionType}</span></div>
                </div>
                <button type="button" data-admin-mission-delete="${escapeHtml(mission.missionId)}" style="height:30px;padding:0 10px;border:1px solid rgba(248,113,113,0.28);border-radius:6px;background:rgba(127,29,29,0.28);color:#fca5a5;font-size:11px;font-weight:800;cursor:pointer;">Изтрий</button>
              </div>
            `).join('')}
          </div>

          ${(() => {
            const editId = state.adminMissionEditId
            const isEditingToday = editId !== null && !state.adminMissionEditIsStaged

            if (!isEditingToday) {
              return `
                <div>
                  <button type="button" data-admin-mission-edit-start="today" style="height:38px;padding:0 14px;border:1px solid rgba(96,165,250,0.48);border-radius:8px;background:#050505;color:#60a5fa;font-size:13px;font-weight:900;cursor:pointer;">+ Добави мисия за днес</button>
                </div>
              `
            }

            return `
              <form data-admin-mission-form="1" style="${adminMissionFormStyle('rgba(96,165,250,0.30)')}">
                <div style="font-size:15px;font-weight:900;color:#60a5fa;">Нова мисия за днес</div>
                <input type="hidden" name="missionId" value="">
                <input type="hidden" name="isStaged" value="false">

                <label style="display:grid;gap:5px;font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:0.06em;color:rgba(96,165,250,0.8);">
                  Тип
                  <select name="missionType" style="width:100%;box-sizing:border-box;height:40px;border-radius:8px;border:1px solid rgba(96,165,250,0.24);background:#050505;color:#ffffff;padding:0 10px;font-size:13px;font-weight:700;outline:none;">
                    ${Object.entries(MISSION_TYPE_LABELS).map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}
                  </select>
                </label>

                <div style="${adminMissionFormGridStyle}">
                  <label style="display:grid;gap:5px;font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:0.06em;color:rgba(96,165,250,0.8);">
                    Цел
                    <input name="targetCount" type="number" min="1" value="5" style="width:100%;box-sizing:border-box;height:40px;border-radius:8px;border:1px solid rgba(96,165,250,0.24);background:#050505;color:#ffffff;padding:0 10px;font-size:13px;font-weight:700;outline:none;">
                  </label>
                  <label style="display:grid;gap:5px;font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:0.06em;color:rgba(96,165,250,0.8);">
                    Награда (жълтици)
                    <input name="rewardYellowCoins" type="number" min="1" value="5000" style="width:100%;box-sizing:border-box;height:40px;border-radius:8px;border:1px solid rgba(96,165,250,0.24);background:#050505;color:#ffffff;padding:0 10px;font-size:13px;font-weight:700;outline:none;">
                  </label>
                </div>

                <div style="${adminMissionFormActionsStyle}">
                  <button type="submit" style="height:40px;padding:0 16px;border:0;border-radius:8px;background:linear-gradient(180deg,#60a5fa 0%,#2563eb 100%);color:#ffffff;font-size:13px;font-weight:900;cursor:pointer;">Запази</button>
                  <button type="button" data-admin-mission-form-cancel="1" style="height:40px;padding:0 14px;border:1px solid rgba(255,255,255,0.18);border-radius:8px;background:transparent;color:rgba(255,255,255,0.72);font-size:13px;font-weight:800;cursor:pointer;">Откажи</button>
                </div>
              </form>
            `
          })()}
        </div>

        <div style="display:grid;gap:12px;">
          <div style="font-size:18px;font-weight:900;color:#a78bfa;border-bottom:1px solid rgba(167,139,250,0.22);padding-bottom:10px;">Мисии за утре</div>

          <div style="display:grid;gap:8px;">
            ${state.adminStagedMissions.length === 0 && state.adminMissionEditId === null ? `
              <div style="color:rgba(255,255,255,0.35);font-size:13px;font-weight:700;padding:8px 0;">Няма зададени мисии за утре.</div>
            ` : state.adminStagedMissions.map((mission) => `
              <div style="${adminMissionRowStyle('rgba(167,139,250,0.4)', 'rgba(20,10,40,0.5)')}">
                <div style="flex:1;min-width:0;">
                  <div style="font-size:13px;font-weight:800;color:#f8fafc;">${escapeHtml(mission.title)}</div>
                  <div style="font-size:11px;color:rgba(255,255,255,0.45);">Цел: ${mission.targetCount} · Награда: ${formatAmount(mission.rewardYellowCoins)} жълтици · <span style="color:rgba(255,255,255,0.35);">${mission.missionType}</span></div>
                </div>
                <div style="${adminMissionActionsStyle}">
                  <button type="button" data-admin-mission-edit="${escapeHtml(mission.missionId)}" data-admin-mission-edit-staged="1" style="height:30px;padding:0 10px;border:1px solid rgba(167,139,250,0.35);border-radius:6px;background:transparent;color:rgba(167,139,250,0.9);font-size:11px;font-weight:800;cursor:pointer;">Редакция</button>
                  <button type="button" data-admin-mission-delete="${escapeHtml(mission.missionId)}" style="height:30px;padding:0 10px;border:1px solid rgba(248,113,113,0.28);border-radius:6px;background:rgba(127,29,29,0.28);color:#fca5a5;font-size:11px;font-weight:800;cursor:pointer;">Изтрий</button>
                </div>
              </div>
            `).join('')}
          </div>

          ${(() => {
            const editId = state.adminMissionEditId
            const isStaged = state.adminMissionEditIsStaged
            if (editId === null || !isStaged) {
              return `
                <div>
                  <button type="button" data-admin-mission-edit-start="1" data-admin-mission-edit-start-staged="1" style="height:38px;padding:0 14px;border:1px solid rgba(167,139,250,0.48);border-radius:8px;background:#050505;color:#a78bfa;font-size:13px;font-weight:900;cursor:pointer;">+ Добави мисия за утре</button>
                </div>
              `
            }

            const editing = editId !== 'new' ? state.adminStagedMissions.find((m) => m.missionId === editId) ?? null : null

            return `
              <form data-admin-mission-form="1" style="${adminMissionFormStyle('rgba(167,139,250,0.30)')}">
                <div style="font-size:15px;font-weight:900;color:#a78bfa;">${editing ? 'Редакция на утрешна мисия' : 'Нова мисия за утре'}</div>
                <input type="hidden" name="missionId" value="${editing ? escapeHtml(editing.missionId) : ''}">
                <input type="hidden" name="isStaged" value="true">

                <label style="display:grid;gap:5px;font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:0.06em;color:rgba(167,139,250,0.8);">
                  Тип
                  <select name="missionType" style="width:100%;box-sizing:border-box;height:40px;border-radius:8px;border:1px solid rgba(167,139,250,0.24);background:#050505;color:#ffffff;padding:0 10px;font-size:13px;font-weight:700;outline:none;">
                    ${Object.entries(MISSION_TYPE_LABELS).map(([value, label]) => `<option value="${value}" ${editing?.missionType === value ? 'selected' : ''}>${label}</option>`).join('')}
                  </select>
                </label>

                <div style="${adminMissionFormGridStyle}">
                  <label style="display:grid;gap:5px;font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:0.06em;color:rgba(167,139,250,0.8);">
                    Цел
                    <input name="targetCount" type="number" min="1" value="${editing?.targetCount ?? 5}" style="width:100%;box-sizing:border-box;height:40px;border-radius:8px;border:1px solid rgba(167,139,250,0.24);background:#050505;color:#ffffff;padding:0 10px;font-size:13px;font-weight:700;outline:none;">
                  </label>
                  <label style="display:grid;gap:5px;font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:0.06em;color:rgba(167,139,250,0.8);">
                    Награда (жълтици)
                    <input name="rewardYellowCoins" type="number" min="1" value="${editing?.rewardYellowCoins ?? 5000}" style="width:100%;box-sizing:border-box;height:40px;border-radius:8px;border:1px solid rgba(167,139,250,0.24);background:#050505;color:#ffffff;padding:0 10px;font-size:13px;font-weight:700;outline:none;">
                  </label>
                </div>

                <div style="${adminMissionFormActionsStyle}">
                  <button type="submit" style="height:40px;padding:0 16px;border:0;border-radius:8px;background:linear-gradient(180deg,#a78bfa 0%,#7c3aed 100%);color:#ffffff;font-size:13px;font-weight:900;cursor:pointer;">Запази</button>
                  <button type="button" data-admin-mission-form-cancel="1" style="height:40px;padding:0 14px;border:1px solid rgba(255,255,255,0.18);border-radius:8px;background:transparent;color:rgba(255,255,255,0.72);font-size:13px;font-weight:800;cursor:pointer;">Откажи</button>
                </div>
              </form>
            `
          })()}
        </div>
      </div>
    </section>

    <section style="margin-top:28px;">
      <div style="display:flex;align-items:center;gap:12px;border-bottom:1px solid rgba(52,211,153,0.2);padding-bottom:10px;margin-bottom:20px;">
        <div style="font-size:16px;font-weight:900;color:#34d399;letter-spacing:0.04em;text-transform:uppercase;">Стаи за мач</div>
        <div style="font-size:12px;color:rgba(255,255,255,0.45);font-weight:500;">Вход, награда и минимално ниво за влизане.</div>
      </div>

      ${state.matchRoomsLoading ? `
        <div style="color:#34d399;font-size:13px;font-weight:800;margin-bottom:16px;">Зареждане...</div>
      ` : state.matchRoomsErrorText ? `
        <div style="border-radius:8px;border:1px solid rgba(248,113,113,0.28);background:rgba(127,29,29,0.42);padding:10px 12px;color:#fecaca;font-size:13px;font-weight:800;margin-bottom:14px;">${escapeHtml(state.matchRoomsErrorText)}</div>
      ` : ''}

      <div style="${adminRoomsListStyle}">
        ${state.matchRooms.length === 0 && !state.matchRoomsLoading ? `
          <div style="color:rgba(255,255,255,0.35);font-size:13px;font-weight:700;padding:8px 0;">Няма създадени стаи.</div>
        ` : state.matchRooms.map((room) => `
          <div style="${adminRoomRowStyle(room.isEnabled)}">
            <div style="flex:1;min-width:0;display:flex;align-items:center;gap:20px;flex-wrap:wrap;">
              <div style="font-size:13px;font-weight:800;color:${room.isEnabled ? '#f8fafc' : 'rgba(255,255,255,0.45)'};">
                Вход: ${formatAmount(room.stakeAmount)}
              </div>
              <div style="font-size:12px;color:rgba(255,255,255,0.6);">Награда: ${formatAmount(room.prizeAmount)}</div>
              <div style="font-size:12px;color:rgba(255,255,255,0.6);">Мин. ниво: ${room.minLevel}</div>
              ${!room.isEnabled ? `<span style="font-size:10px;font-weight:900;color:rgba(255,255,255,0.35);background:rgba(255,255,255,0.06);border-radius:4px;padding:2px 7px;letter-spacing:0.06em;">ИЗКЛЮЧЕНА</span>` : ''}
            </div>
            <div style="${adminRoomActionsStyle}">
              <button type="button" data-admin-room-edit="${room.stakeAmount}" style="height:30px;padding:0 10px;border:1px solid rgba(52,211,153,0.35);border-radius:6px;background:transparent;color:rgba(52,211,153,0.9);font-size:11px;font-weight:800;cursor:pointer;">Редакция</button>
              <button type="button" data-admin-room-delete="${room.stakeAmount}" style="height:30px;padding:0 10px;border:1px solid rgba(248,113,113,0.28);border-radius:6px;background:rgba(127,29,29,0.28);color:#fca5a5;font-size:11px;font-weight:800;cursor:pointer;">Изтрий</button>
            </div>
          </div>
        `).join('')}
      </div>

      ${state.adminMatchRoomEdit === null ? `
        <div>
          <button type="button" data-admin-room-new="1" style="height:38px;padding:0 14px;border:1px solid rgba(52,211,153,0.48);border-radius:8px;background:#050505;color:#34d399;font-size:13px;font-weight:900;cursor:pointer;">+ Добави стая</button>
        </div>
      ` : (() => {
        const edit = state.adminMatchRoomEdit
        const isNew = edit === 'new'
        const room = isNew ? null : edit
        return `
          <form data-admin-room-form="1" style="${adminRoomFormStyle}">
            <div style="font-size:15px;font-weight:900;color:#34d399;">${isNew ? 'Нова стая' : `Редакция — вход: ${formatAmount(room!.stakeAmount)}`}</div>

            <div style="${adminRoomFormGridStyle}">
              <label style="display:grid;gap:5px;font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:0.06em;color:rgba(52,211,153,0.8);">
                Вход (жълтици)
                <input name="stakeAmount" type="number" min="1" value="${room?.stakeAmount ?? ''}" ${!isNew ? 'readonly' : 'data-admin-room-stake-input="1"'} style="width:100%;box-sizing:border-box;height:40px;border-radius:8px;border:1px solid rgba(52,211,153,0.24);background:#050505;color:#ffffff;padding:0 10px;font-size:13px;font-weight:700;outline:none;${!isNew ? 'opacity:0.55;cursor:not-allowed;' : ''}">
              </label>
              <label style="display:grid;gap:5px;font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:0.06em;color:rgba(52,211,153,0.8);">
                Награда (жълтици)
                <input name="prizeAmount" type="number" min="1" value="${room?.prizeAmount ?? ''}" ${isNew ? 'data-admin-room-prize-input="1"' : ''} style="width:100%;box-sizing:border-box;height:40px;border-radius:8px;border:1px solid rgba(52,211,153,0.24);background:#050505;color:#ffffff;padding:0 10px;font-size:13px;font-weight:700;outline:none;">
              </label>
              <label style="display:grid;gap:5px;font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:0.06em;color:rgba(52,211,153,0.8);">
                Мин. ниво
                <input name="minLevel" type="number" min="1" max="100" value="${room?.minLevel ?? 1}" style="width:100%;box-sizing:border-box;height:40px;border-radius:8px;border:1px solid rgba(52,211,153,0.24);background:#050505;color:#ffffff;padding:0 10px;font-size:13px;font-weight:700;outline:none;">
              </label>
              <label style="display:grid;gap:5px;font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:0.06em;color:rgba(52,211,153,0.8);">
                Активна
                <select name="isEnabled" style="width:100%;box-sizing:border-box;height:40px;border-radius:8px;border:1px solid rgba(52,211,153,0.24);background:#050505;color:#ffffff;padding:0 10px;font-size:13px;font-weight:700;outline:none;">
                  <option value="1" ${(room?.isEnabled ?? true) ? 'selected' : ''}>Да</option>
                  <option value="0" ${!(room?.isEnabled ?? true) ? 'selected' : ''}>Не</option>
                </select>
              </label>
            </div>

            <div style="${adminRoomFormActionsStyle}">
              <button type="submit" style="height:40px;padding:0 16px;border:0;border-radius:8px;background:linear-gradient(180deg,#34d399 0%,#059669 100%);color:#000000;font-size:13px;font-weight:900;cursor:pointer;">Запази</button>
              <button type="button" data-admin-room-form-cancel="1" style="height:40px;padding:0 14px;border:1px solid rgba(255,255,255,0.18);border-radius:8px;background:transparent;color:rgba(255,255,255,0.72);font-size:13px;font-weight:800;cursor:pointer;">Откажи</button>
            </div>
          </form>
        `
      })()}
    </section>

    <section style="margin-top:28px;">
      <div style="display:flex;align-items:center;gap:12px;border-bottom:1px solid rgba(212,165,32,0.2);padding-bottom:10px;margin-bottom:20px;">
        <div style="font-size:16px;font-weight:900;color:#d4a520;letter-spacing:0.04em;text-transform:uppercase;">Ежедневни награди</div>
        <div style="font-size:12px;color:rgba(255,255,255,0.45);font-weight:500;">Играчите вземат по 1 на ден · рестартира в 00:00</div>
      </div>

      ${state.adminDailyRewardsLoading ? `
        <div style="color:#d4a520;font-size:13px;font-weight:800;margin-bottom:16px;">Зареждане...</div>
      ` : state.adminDailyRewardsErrorText ? `
        <div style="color:#fecaca;font-size:13px;font-weight:800;margin-bottom:16px;">${escapeHtml(state.adminDailyRewardsErrorText)}</div>
      ` : `
        <div style="${adminDailyRewardsGridStyle}">

          <!-- Активни днес (само четене) -->
          <div>
            <div style="font-size:12px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.5);margin-bottom:10px;">
              Активни днес
            </div>
            ${state.adminActiveDailyRewardTiers.length === 0 ? `
              <div style="color:rgba(255,255,255,0.3);font-size:13px;padding:10px 0;">Няма активни награди.</div>
            ` : `
              <div style="display:grid;gap:7px;">
                ${state.adminActiveDailyRewardTiers.map((tier, i) => `
                  <div style="display:flex;align-items:center;gap:10px;background:#0a0a0a;border:1px solid rgba(212,165,32,0.15);border-radius:8px;padding:9px 12px;opacity:0.75;">
                    <div style="width:20px;height:20px;border-radius:50%;background:rgba(212,165,32,0.12);border:1px solid rgba(212,165,32,0.3);display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:900;color:#d4a520;flex-shrink:0;">${i + 1}</div>
                    <img src="/assets/lobby/icon-coin.png" alt="" style="width:18px;height:18px;object-fit:contain;flex-shrink:0;">
                    <span style="font-size:14px;font-weight:800;color:rgba(255,255,255,0.7);flex:1;">${formatAmount(tier.yellowCoinsAmount)} жълтици</span>
                  </div>
                `).join('')}
              </div>
            `}
          </div>

          <!-- Промени за утре (редактируеми) -->
          <div>
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
              <div style="font-size:12px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.5);">
                Промени за утре
              </div>
              ${state.adminStagedDailyRewardTiers.length > 0 ? `
                <div style="font-size:10px;font-weight:800;color:#d4a520;background:rgba(212,165,32,0.12);border:1px solid rgba(212,165,32,0.3);border-radius:4px;padding:2px 7px;white-space:nowrap;">
                  влизат в сила в 00:00
                </div>
              ` : ''}
            </div>

            ${state.adminStagedDailyRewardTiers.length === 0 ? `
              <div style="border:1px dashed rgba(255,255,255,0.12);border-radius:8px;padding:12px;margin-bottom:10px;">
                <div style="font-size:12px;color:rgba(255,255,255,0.35);">Без зададени промени — днешните ще се повторят утре.</div>
              </div>
            ` : `
              <div style="display:grid;gap:7px;margin-bottom:10px;">
                ${state.adminStagedDailyRewardTiers.map((tier, i) => `
                  <div style="display:flex;align-items:center;gap:10px;background:#0d0d0d;border:1px solid rgba(212,165,32,0.28);border-radius:8px;padding:9px 12px;">
                    <div style="width:20px;height:20px;border-radius:50%;background:rgba(212,165,32,0.15);border:1px solid rgba(212,165,32,0.4);display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:900;color:#d4a520;flex-shrink:0;">${i + 1}</div>
                    <img src="/assets/lobby/icon-coin.png" alt="" style="width:18px;height:18px;object-fit:contain;flex-shrink:0;">
                    <span style="font-size:14px;font-weight:800;color:#ffffff;flex:1;">${formatAmount(tier.yellowCoinsAmount)} жълтици</span>
                    <button type="button" data-admin-daily-reward-remove="${escapeHtml(tier.tierId)}" style="
                      background:rgba(239,68,68,0.10);border:1px solid rgba(239,68,68,0.3);border-radius:6px;
                      padding:4px 10px;cursor:pointer;font-size:11px;font-weight:800;color:#fca5a5;flex-shrink:0;
                    ">×</button>
                  </div>
                `).join('')}
              </div>
            `}

            <form data-admin-daily-reward-form="1" style="${adminDailyRewardsFormStyle}">
              <label style="display:grid;gap:4px;font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:0.06em;color:rgba(212,165,32,0.7);flex:1;">
                Жълтици
                <input
                  name="amount"
                  type="number"
                  min="1"
                  placeholder="напр. 5000"
                  style="width:100%;box-sizing:border-box;height:38px;border-radius:8px;border:1px solid rgba(212,165,32,0.24);background:#050505;color:#ffffff;padding:0 10px;font-size:13px;font-weight:700;outline:none;"
                >
              </label>
              <button type="submit" ${state.adminDailyRewardAddLoading ? 'disabled' : ''} style="
                height:38px;padding:0 14px;border:0;border-radius:8px;
                background:linear-gradient(180deg,#d4a520 0%,#92700e 100%);
                color:#000000;font-size:12px;font-weight:900;cursor:pointer;white-space:nowrap;
                opacity:${state.adminDailyRewardAddLoading ? '0.6' : '1'};flex-shrink:0;${isMobile ? 'width:100%;' : ''}
              ">${state.adminDailyRewardAddLoading ? '...' : '+ Добави'}</button>
            </form>
            ${state.adminDailyRewardAddErrorText ? `
              <div style="margin-top:6px;color:#fca5a5;font-size:11px;font-weight:800;">${escapeHtml(state.adminDailyRewardAddErrorText)}</div>
            ` : ''}
          </div>

        </div>
      `}
    </section>
  `
}

function formatStake(stake: MatchStake): string {
  return stake.toLocaleString('bg-BG')
}

function renderMyRoomPanel(room: PrivateRoomSnapshot): string {
  const timeLeft = Math.max(0, room.expiresAt - Date.now())
  const minutesLeft = Math.ceil(timeLeft / 60000)
  const isLocked = room.kind === 'locked'
  const membersHtml = Array.from({ length: 4 }, (_, i) => {
    const member = room.members[i]
    if (member) {
      return `
        <div style="display:flex;align-items:center;gap:10px;padding:10px 14px;background:rgba(255,255,255,0.05);border-radius:10px;">
          <div style="width:36px;height:36px;border-radius:50%;background:rgba(167,139,250,0.2);border:2px solid rgba(167,139,250,0.5);display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0;overflow:hidden;">
            ${member.avatarUrl ? `<img src="${member.avatarUrl}" style="width:100%;height:100%;object-fit:cover;">` : '👤'}
          </div>
          <div style="flex:1;min-width:0;">
            <div style="font-size:14px;font-weight:700;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
              ${member.displayName}${member.isHost ? ' <span style="font-size:10px;color:#a78bfa;font-weight:600;">ДОМАКИН</span>' : ''}
            </div>
            ${member.rankTitle ? `<div style="font-size:11px;color:rgba(255,255,255,0.4);">${member.rankTitle}</div>` : ''}
          </div>
        </div>
      `
    }
    return `
      <div style="display:flex;align-items:center;gap:10px;padding:10px 14px;background:rgba(255,255,255,0.03);border-radius:10px;border:1px dashed rgba(255,255,255,0.1);">
        <div style="width:36px;height:36px;border-radius:50%;background:rgba(255,255,255,0.05);flex-shrink:0;"></div>
        <div style="font-size:13px;color:rgba(255,255,255,0.25);font-style:italic;">Чака играч...</div>
      </div>
    `
  }).join('')

  return `
    <div style="background:rgba(167,139,250,0.06);border:1px solid rgba(167,139,250,0.25);border-radius:14px;padding:20px 24px;margin-bottom:24px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">
        <div>
          <div style="font-size:15px;font-weight:800;color:#a78bfa;">Моята маса</div>
          <div style="font-size:12px;color:rgba(255,255,255,0.4);margin-top:2px;">
            ${isLocked ? 'Заключена' : 'Отворена'} · Залог ${formatStake(room.stake)} · ~${minutesLeft} мин. оставащи
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;">
          ${isLocked && room.members.length < 4 ? `
            <button type="button" id="invite-friends-open" style="
              padding:6px 14px;border:1px solid rgba(167,139,250,0.5);background:rgba(167,139,250,0.15);
              border-radius:8px;color:#a78bfa;font-size:13px;font-weight:700;cursor:pointer;
            ">+ Покани</button>
          ` : ''}
          <button type="button" data-private-room-leave="1" style="
            padding:6px 14px;border:1px solid rgba(239,68,68,0.5);background:rgba(239,68,68,0.1);
            border-radius:8px;color:#f87171;font-size:13px;font-weight:700;cursor:pointer;
          ">Напусни</button>
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:8px;">${membersHtml}</div>
    </div>
  `
}

function formatSupportTime(isoString: string): string {
  try {
    const d = new Date(isoString)
    const now = new Date()
    const diffMs = now.getTime() - d.getTime()
    const diffMin = Math.floor(diffMs / 60000)
    if (diffMin < 1) return 'Сега'
    if (diffMin < 60) return `${diffMin} мин`
    const diffH = Math.floor(diffMin / 60)
    if (diffH < 24) return `${diffH} ч`
    return d.toLocaleDateString('bg-BG', { day: '2-digit', month: '2-digit' })
  } catch {
    return ''
  }
}

function renderSupportMessagesBubbles(messages: SupportMessageSnapshot[], loading: boolean): string {
  if (loading) {
    return `<div style="flex:1;display:flex;align-items:center;justify-content:center;color:#d4a520;font-size:14px;font-weight:800;">Зареждане...</div>`
  }
  if (messages.length === 0) {
    return `<div style="flex:1;display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,0.38);font-size:14px;font-weight:700;text-align:center;padding:24px;">Все още няма съобщения.<br>Изпрати ни запитване.</div>`
  }
  return messages.map((msg) => `
    <div style="display:flex;flex-direction:column;align-items:${msg.isFromAdmin ? 'flex-start' : 'flex-end'};gap:3px;">
      <div style="
        max-width:75%;padding:10px 14px;
        border-radius:${msg.isFromAdmin ? '4px 14px 14px 14px' : '14px 4px 14px 14px'};
        background:${msg.isFromAdmin ? 'rgba(212,165,32,0.14)' : '#1e1e1e'};
        border:1px solid ${msg.isFromAdmin ? 'rgba(212,165,32,0.30)' : 'rgba(255,255,255,0.10)'};
        color:#f8fafc;font-size:14px;font-weight:600;line-height:1.55;word-break:break-word;
      ">${escapeHtml(msg.body)}</div>
      <div style="font-size:11px;color:rgba(255,255,255,0.35);font-weight:600;padding:0 4px;">
        ${msg.isFromAdmin ? '<span style="color:rgba(212,165,32,0.7);">Екип Pika.bg</span> · ' : ''}${formatSupportTime(msg.createdAt)}
      </div>
    </div>
  `).join('')
}

function renderSupportPopup(state: LobbyScreenState): string {
  if (!state.supportPopupOpen) return ''
  return `
    <div data-support-popup-backdrop="1" style="
      position:fixed;inset:0;z-index:12000;
      background:rgba(0,0,0,0.72);
      display:flex;align-items:center;justify-content:center;
      padding:20px;box-sizing:border-box;
    ">
      <div style="
        width:520px;max-width:100%;max-height:80vh;
        background:#0d0d0d;border:1px solid rgba(212,165,32,0.35);border-radius:16px;
        display:flex;flex-direction:column;overflow:hidden;
        box-shadow:0 16px 64px rgba(0,0,0,0.8);
      " onclick="event.stopPropagation()">
        <div style="
          display:flex;align-items:center;justify-content:space-between;
          padding:16px 20px;border-bottom:1px solid rgba(255,255,255,0.10);
          flex-shrink:0;
        ">
          <div>
            <div style="font-size:15px;font-weight:900;color:#f8fafc;">Връзка с екипа на Pika.bg</div>
            <div style="font-size:12px;color:rgba(255,255,255,0.45);font-weight:600;margin-top:2px;">Запитвания · Предложения · Докладване на проблеми</div>
          </div>
          <button data-support-popup-close="1" style="
            background:none;border:none;cursor:pointer;padding:6px;
            color:rgba(255,255,255,0.5);border-radius:6px;
            display:flex;align-items:center;justify-content:center;
          ">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        <div style="
          display:flex;align-items:center;gap:8px;
          padding:8px 16px;background:rgba(212,165,32,0.08);
          border-bottom:1px solid rgba(212,165,32,0.15);flex-shrink:0;
        ">
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#d4a520" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          <span style="font-size:11px;font-weight:700;color:rgba(212,165,32,0.85);">Чатовете с отговор от екипа се изтриват автоматично след 5 дни неактивност.</span>
        </div>

        <div id="support-popup-messages-scroll" style="
          flex:1;overflow-y:auto;padding:20px;
          display:flex;flex-direction:column;gap:12px;
          min-height:220px;max-height:400px;
        ">
          ${renderSupportMessagesBubbles(state.supportMessages, state.supportLoading)}
        </div>

        ${state.supportErrorText ? `
          <div style="padding:8px 16px;background:rgba(127,29,29,0.42);border-top:1px solid rgba(248,113,113,0.22);color:#fecaca;font-size:12px;font-weight:800;flex-shrink:0;">
            ${escapeHtml(state.supportErrorText)}
          </div>
        ` : ''}

        ${state.supportDeleteConfirm ? `
          <div style="
            padding:14px 16px;flex-shrink:0;
            background:rgba(239,68,68,0.10);
            border-top:1px solid rgba(239,68,68,0.30);
          ">
            <div style="font-size:13px;font-weight:700;color:#ef4444;margin-bottom:10px;">Сигурни ли сте, че искате да изтриете целия чат? Това действие е необратимо.</div>
            <div style="display:flex;gap:8px;">
              <button data-support-delete-confirm="1"
                ${state.supportDeleteLoading ? 'disabled' : ''}
                style="
                  height:34px;padding:0 16px;border:0;border-radius:7px;
                  background:#ef4444;color:#fff;font-size:13px;font-weight:900;cursor:pointer;
                  opacity:${state.supportDeleteLoading ? '0.6' : '1'};
                ">${state.supportDeleteLoading ? 'Изтриване...' : 'Да, изтрий'}</button>
              <button data-support-delete-cancel="1" style="
                height:34px;padding:0 16px;border:1px solid rgba(255,255,255,0.15);border-radius:7px;
                background:transparent;color:rgba(255,255,255,0.70);font-size:13px;font-weight:800;cursor:pointer;
              ">Откажи</button>
            </div>
          </div>
        ` : state.supportMessages.length > 0 ? `
          <div style="padding:8px 16px;border-top:1px solid rgba(255,255,255,0.07);flex-shrink:0;display:flex;justify-content:flex-end;">
            <button data-support-delete-click="1" style="
              display:flex;align-items:center;gap:5px;
              background:none;border:none;cursor:pointer;
              color:rgba(255,255,255,0.35);font-size:11px;font-weight:700;padding:4px 6px;
            ">
              <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
              Изтрий чата
            </button>
          </div>
        ` : ''}

        ${state.supportAccountTooNewMinutes !== null ? `
          <div style="
            display:flex;align-items:center;gap:8px;
            padding:12px 16px;border-top:1px solid rgba(255,255,255,0.10);
            background:#080808;flex-shrink:0;
          ">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#d4a520" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            <span style="font-size:12px;font-weight:700;color:rgba(212,165,32,0.9);">За защита от злонамерени съобщения ще можете да пишете след ${state.supportAccountTooNewMinutes} ${state.supportAccountTooNewMinutes === 1 ? 'минута' : 'минути'}.</span>
          </div>
        ` : `
        <form data-support-send-form="1" style="
          display:flex;gap:10px;padding:14px 16px;
          border-top:1px solid rgba(255,255,255,0.10);
          background:#080808;flex-shrink:0;
        ">
          <input name="website" tabindex="-1" autocomplete="off" style="display:none;position:absolute;left:-9999px;">
          <textarea name="body" placeholder="Напиши съобщение..." rows="2" maxlength="2000" style="
            flex:1;border-radius:8px;border:1px solid rgba(255,255,255,0.15);
            background:#141414;color:#f8fafc;
            padding:10px 12px;font-size:14px;font-weight:600;
            outline:none;resize:none;font-family:inherit;line-height:1.4;
          "></textarea>
          <button type="submit" ${state.supportSendingLoading ? 'disabled' : ''} style="
            align-self:flex-end;height:44px;padding:0 20px;border:0;border-radius:8px;
            background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);
            color:#080808;font-size:14px;font-weight:900;cursor:pointer;white-space:nowrap;
            opacity:${state.supportSendingLoading ? '0.6' : '1'};
          ">Изпрати</button>
        </form>
        `}
      </div>
    </div>
  `
}

function renderGuestContactPopup(state: LobbyScreenState): string {
  if (!state.guestContactPopupOpen) return ''

  const inputStyle = `
    width:100%;box-sizing:border-box;border-radius:8px;border:1px solid rgba(255,255,255,0.14);
    background:#141414;color:#f8fafc;padding:10px 12px;font-size:14px;font-weight:700;
    outline:none;font-family:inherit;
  `

  const labelStyle = 'display:grid;gap:6px;font-size:12px;font-weight:900;color:rgba(212,165,32,0.92);letter-spacing:0.04em;text-transform:uppercase;'

  return `
    <div data-guest-contact-popup-backdrop="1" style="
      position:fixed;inset:0;z-index:12000;
      background:rgba(0,0,0,0.72);
      display:flex;align-items:center;justify-content:center;
      padding:20px;box-sizing:border-box;
    ">
      <div style="
        width:520px;max-width:100%;
        background:#0d0d0d;border:1px solid rgba(212,165,32,0.35);border-radius:16px;
        display:flex;flex-direction:column;overflow:hidden;
        box-shadow:0 16px 64px rgba(0,0,0,0.8);
      " onclick="event.stopPropagation()">
        <div style="
          display:flex;align-items:center;justify-content:space-between;
          padding:16px 20px;border-bottom:1px solid rgba(255,255,255,0.10);
          flex-shrink:0;
        ">
          <div>
            <div style="font-size:15px;font-weight:900;color:#f8fafc;">Контакти</div>
            <div style="font-size:12px;color:rgba(255,255,255,0.45);font-weight:600;margin-top:2px;">Пиши до екипа на Pika.bg</div>
          </div>
          <button type="button" data-guest-contact-popup-close="1" style="
            background:none;border:none;cursor:pointer;padding:6px;
            color:rgba(255,255,255,0.5);border-radius:6px;
            display:flex;align-items:center;justify-content:center;
          ">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        <div style="padding:18px 20px;display:grid;gap:14px;">
          ${state.guestContactSuccessText ? `
            <div style="border:1px solid rgba(34,197,94,0.34);border-radius:10px;background:rgba(20,83,45,0.30);padding:14px;color:#bbf7d0;font-size:14px;font-weight:800;line-height:1.45;text-align:center;">
              ${escapeHtml(state.guestContactSuccessText)}
            </div>
            <button type="button" data-guest-contact-popup-close="1" style="
              height:44px;border:0;border-radius:8px;
              background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);
              color:#080808;font-size:14px;font-weight:900;cursor:pointer;
            ">Затвори</button>
          ` : `
            <div style="font-size:13px;line-height:1.45;color:rgba(255,255,255,0.58);font-weight:700;">
              Опиши накратко въпроса или проблема. Ще използваме имейла само за обратна връзка.
            </div>

            ${state.guestContactErrorText ? `
              <div style="border:1px solid rgba(248,113,113,0.34);border-radius:8px;background:rgba(127,29,29,0.34);padding:10px 12px;color:#fecaca;font-size:13px;font-weight:800;">
                ${escapeHtml(state.guestContactErrorText)}
              </div>
            ` : ''}

            <form data-guest-contact-form="1" style="display:grid;gap:12px;">
              <input name="website" tabindex="-1" autocomplete="off" style="display:none;position:absolute;left:-9999px;">
              <label style="${labelStyle}">
                Име
                <input name="name" type="text" maxlength="80" required autocomplete="name" style="${inputStyle}">
              </label>
              <label style="${labelStyle}">
                Имейл за отговор
                <input name="email" type="email" maxlength="160" required autocomplete="email" style="${inputStyle}">
              </label>
              <label style="${labelStyle}">
                Тема
                <input name="subject" type="text" maxlength="120" autocomplete="off" style="${inputStyle}">
              </label>
              <label style="${labelStyle}">
                Съобщение
                <textarea name="message" rows="5" minlength="10" maxlength="3000" required style="${inputStyle}resize:vertical;min-height:118px;line-height:1.45;"></textarea>
              </label>
              <button type="submit" ${state.guestContactSending ? 'disabled' : ''} style="
                height:46px;border:0;border-radius:8px;
                background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);
                color:#080808;font-size:14px;font-weight:900;cursor:pointer;
                opacity:${state.guestContactSending ? '0.62' : '1'};
              ">${state.guestContactSending ? 'Изпращане...' : 'Изпрати съобщение'}</button>
            </form>
          `}
        </div>
      </div>
    </div>
  `
}

function renderAdminSupportPage(state: LobbyScreenState): string {
  const sorted = [...state.adminSupportConversations].sort((a, b) => {
    if (a.unreadByAdmin > 0 && b.unreadByAdmin === 0) return -1
    if (a.unreadByAdmin === 0 && b.unreadByAdmin > 0) return 1
    return b.updatedAt.localeCompare(a.updatedAt)
  })

  const convListHtml = state.adminSupportConversationsLoading ? `
    <div style="padding:20px;color:#d4a520;font-size:13px;font-weight:800;text-align:center;">Зареждане...</div>
  ` : sorted.length === 0 ? `
    <div style="padding:20px;color:rgba(255,255,255,0.35);font-size:13px;font-weight:700;text-align:center;">Няма разговори</div>
  ` : sorted.map((conv) => {
    const isSelected = state.adminSupportSelectedProfileId === conv.profileId
    const statusColor = conv.unreadByAdmin > 0
      ? '#ef4444'
      : conv.lastMessageIsFromAdmin
        ? '#22c55e'
        : '#3b82f6'
    const avatarHtml = conv.avatarUrl
      ? `<img src="${conv.avatarUrl}" style="width:40px;height:40px;border-radius:50%;object-fit:cover;flex-shrink:0;">`
      : `<div style="width:40px;height:40px;border-radius:50%;background:rgba(212,165,32,0.15);display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;">👤</div>`
    return `
      <button type="button" data-admin-support-conv="${escapeHtml(conv.profileId)}" style="
        display:flex;align-items:center;gap:10px;padding:10px 12px;
        border-radius:0;border:none;border-bottom:1px solid rgba(255,255,255,0.06);
        cursor:pointer;text-align:left;width:100%;
        background:${isSelected ? 'rgba(212,165,32,0.10)' : 'transparent'};
        border-left:3px solid ${isSelected ? '#d4a520' : 'transparent'};
        transition:background 0.1s;
      ">
        <div style="position:relative;flex-shrink:0;">
          ${avatarHtml}
          ${conv.unreadByAdmin > 0 ? `<span style="
            position:absolute;top:-3px;right:-4px;
            min-width:16px;height:16px;border-radius:8px;
            background:#ef4444;border:1.5px solid #0d0d0d;
            display:flex;align-items:center;justify-content:center;
            font-size:9px;font-weight:900;color:#fff;
            padding:0 3px;box-sizing:border-box;
          ">${conv.unreadByAdmin}</span>` : ''}
        </div>
        <div style="flex:1;min-width:0;">
          <div style="
            font-size:16px;font-weight:${conv.unreadByAdmin > 0 ? '900' : '700'};
            color:${conv.unreadByAdmin > 0 ? '#ffffff' : 'rgba(255,255,255,0.72)'};
            overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
          ">${escapeHtml(conv.displayName)}</div>
          <div style="
            font-size:11px;color:rgba(255,255,255,0.38);
            overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
            margin-top:2px;font-style:${conv.lastMessageIsFromAdmin ? 'italic' : 'normal'};
          ">${conv.lastMessageIsFromAdmin ? '↩ ' : ''}${escapeHtml(conv.lastMessageBody)}</div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex-shrink:0;">
          <div style="font-size:10px;color:rgba(255,255,255,0.30);">${formatSupportTime(conv.updatedAt)}</div>
          <span style="width:10px;height:10px;border-radius:50%;background:${statusColor};box-shadow:0 0 4px ${statusColor};flex-shrink:0;"></span>
        </div>
      </button>
    `
  }).join('')

  const selectedConv = state.adminSupportConversations.find(c => c.profileId === state.adminSupportSelectedProfileId) ?? null
  const isDeleteConfirming = state.adminSupportDeleteConfirmProfileId === state.adminSupportSelectedProfileId && state.adminSupportSelectedProfileId !== null
  const deleteWarning = isDeleteConfirming && selectedConv !== null && !selectedConv.lastMessageIsFromAdmin

  const rightPanelHtml = state.adminSupportSelectedProfileId === null ? `
    <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;color:rgba(255,255,255,0.28);">
      <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.4;"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>
      <div style="font-size:14px;font-weight:700;">Избери разговор</div>
    </div>
  ` : `
    <div style="
      display:flex;align-items:center;justify-content:space-between;
      padding:10px 16px;border-bottom:1px solid rgba(255,255,255,0.08);
      flex-shrink:0;background:#0a0a0a;
    ">
      <div style="font-size:14px;font-weight:800;color:#f8fafc;">
        ${escapeHtml(selectedConv?.displayName ?? '')}
      </div>
      <button data-admin-support-delete="${escapeHtml(state.adminSupportSelectedProfileId)}" style="
        display:flex;align-items:center;gap:6px;
        background:rgba(212,165,32,0.10);border:1px solid rgba(212,165,32,0.30);
        border-radius:7px;padding:6px 12px;cursor:pointer;
        color:#d4a520;font-size:12px;font-weight:800;
      ">
        <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8v13H3V8"/><path d="M1 3h22v5H1z"/><path d="M10 12h4"/></svg>
        Архивирай
      </button>
    </div>

    ${isDeleteConfirming ? `
    <div style="
      flex-shrink:0;padding:14px 18px;
      background:${deleteWarning ? 'rgba(239,68,68,0.10)' : 'rgba(255,255,255,0.05)'};
      border-bottom:1px solid ${deleteWarning ? 'rgba(239,68,68,0.30)' : 'rgba(255,255,255,0.10)'};
    ">
      ${deleteWarning ? `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        <span style="font-size:13px;font-weight:700;color:#ef4444;">Още не сте отговорили на този потребител. Сигурни ли сте, че искате да архивирате чата?</span>
      </div>
      ` : `
      <div style="font-size:13px;font-weight:700;color:rgba(255,255,255,0.70);margin-bottom:10px;">Разговорът ще бъде скрит от списъка. Ако потребителят изпрати ново съобщение, ще се появи отново.</div>
      `}
      <div style="display:flex;gap:8px;">
        <button data-admin-support-delete-confirm="${escapeHtml(state.adminSupportSelectedProfileId)}"
          ${state.adminSupportDeleteLoading ? 'disabled' : ''}
          style="
            height:34px;padding:0 16px;border:0;border-radius:7px;
            background:#d4a520;color:#000;font-size:13px;font-weight:900;cursor:pointer;
            opacity:${state.adminSupportDeleteLoading ? '0.6' : '1'};
          ">${state.adminSupportDeleteLoading ? 'Архивиране...' : 'Да, архивирай'}</button>
        <button data-admin-support-delete-cancel="1" style="
          height:34px;padding:0 16px;border:1px solid rgba(255,255,255,0.15);border-radius:7px;
          background:transparent;color:rgba(255,255,255,0.70);font-size:13px;font-weight:800;cursor:pointer;
        ">Откажи</button>
      </div>
    </div>
    ` : ''}

    <div id="support-admin-messages-scroll" style="
      flex:1;min-height:0;overflow-y:auto;padding:20px;
      display:flex;flex-direction:column;gap:10px;
    ">
      ${renderSupportMessagesBubbles(state.adminSupportMessages, state.adminSupportMessagesLoading)}
    </div>
    <form data-admin-support-reply-form="${escapeHtml(state.adminSupportSelectedProfileId)}" style="
      display:flex;gap:10px;padding:14px 16px;
      border-top:1px solid rgba(255,255,255,0.10);
      background:#080808;flex-shrink:0;
    ">
      <textarea name="body" placeholder="Отговор от екипа..." rows="2" maxlength="2000" style="
        flex:1;border-radius:8px;border:1px solid rgba(255,255,255,0.15);
        background:#141414;color:#f8fafc;
        padding:10px 12px;font-size:14px;font-weight:600;
        outline:none;resize:none;font-family:inherit;line-height:1.4;
      "></textarea>
      <button type="submit" ${state.adminSupportReplyLoading ? 'disabled' : ''} style="
        align-self:flex-end;height:44px;padding:0 20px;border:0;border-radius:8px;
        background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);
        color:#080808;font-size:14px;font-weight:900;cursor:pointer;white-space:nowrap;
        opacity:${state.adminSupportReplyLoading ? '0.6' : '1'};
      ">Изпрати</button>
    </form>
  `

  const totalUnread = state.adminSupportConversations.reduce((s, c) => s + c.unreadByAdmin, 0)

  return `
    <section style="height:calc(100vh - 160px);display:flex;flex-direction:column;gap:0;min-height:500px;">
      <div style="
        display:flex;align-items:center;gap:12px;
        border-bottom:1px solid rgba(212,165,32,0.28);
        padding-bottom:14px;margin-bottom:20px;flex-shrink:0;
      ">
        <button data-lobby-nav-back="1" style="
          display:flex;align-items:center;gap:6px;background:none;border:none;
          cursor:pointer;padding:8px 12px;border-radius:8px;
          color:rgba(255,255,255,0.72);font-size:13px;font-weight:800;letter-spacing:0.03em;
        ">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          Назад
        </button>
        <div>
          <div style="display:flex;align-items:center;gap:10px;">
            <div style="font-size:22px;font-weight:900;color:#f8fafc;line-height:1.1;">Поддръжка</div>
            ${totalUnread > 0 ? `<span style="
              min-width:22px;height:22px;border-radius:11px;
              background:#ef4444;
              display:flex;align-items:center;justify-content:center;
              font-size:11px;font-weight:900;color:#fff;padding:0 6px;box-sizing:border-box;
            ">${totalUnread}</span>` : ''}
          </div>
          <div style="font-size:12px;color:rgba(255,255,255,0.45);font-weight:700;margin-top:3px;">Запитвания от потребители</div>
        </div>
      </div>

      <div style="
        flex:1;min-height:0;display:grid;grid-template-columns:300px 1fr;gap:0;
        background:#080808;border:1px solid rgba(255,255,255,0.10);
        border-radius:12px;overflow:hidden;
      ">
        <div style="
          display:flex;flex-direction:column;
          border-right:1px solid rgba(255,255,255,0.10);
          overflow-y:auto;
          min-height:0;
        ">
          ${convListHtml}
        </div>

        <div style="display:flex;flex-direction:column;min-height:0;overflow:hidden;">
          ${rightPanelHtml}
        </div>
      </div>
    </section>
  `
}

function renderAdminGuestContactMessagesPage(state: LobbyScreenState, isMobile = false): string {
  if (!state.isAdmin) {
    return `<div style="min-height:520px;display:flex;align-items:center;justify-content:center;color:#fecaca;font-size:15px;font-weight:800;">Нямаш достъп.</div>`
  }

  const messagesHtml = state.adminGuestContactMessagesLoading ? `
    <div style="padding:24px;color:#d4a520;font-size:14px;font-weight:900;text-align:center;">Зареждане...</div>
  ` : state.adminGuestContactMessages.length === 0 ? `
    <div style="padding:24px;color:rgba(255,255,255,0.56);font-size:14px;font-weight:800;text-align:center;">Няма съобщения от гости.</div>
  ` : state.adminGuestContactMessages.map((message) => {
    const subject = message.subject.trim()
    const statusText = message.readByAdmin ? 'Прочетено' : 'Непрочетено'
    const statusColor = message.readByAdmin ? '#22c55e' : '#ef4444'
    return `
      <article style="
        display:grid;gap:8px;padding:${isMobile ? '12px' : '14px 16px'};
        border:1px solid ${message.readByAdmin ? 'rgba(255,255,255,0.08)' : 'rgba(239,68,68,0.34)'};
        border-radius:8px;background:${message.readByAdmin ? 'rgba(255,255,255,0.035)' : 'rgba(239,68,68,0.075)'};
      ">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;">
          <div style="display:grid;gap:3px;min-width:0;">
            <div style="font-size:15px;font-weight:900;color:#f8fafc;word-break:break-word;">${escapeHtml(message.name)}</div>
            <div style="font-size:12px;font-weight:800;color:rgba(212,165,32,0.90);word-break:break-all;">${escapeHtml(message.email)}</div>
          </div>
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end;">
            <span style="font-size:11px;font-weight:900;color:${statusColor};border:1px solid ${statusColor};border-radius:999px;padding:4px 8px;">${statusText}</span>
            <span style="font-size:12px;font-weight:800;color:rgba(255,255,255,0.48);">${formatSupportTime(message.createdAt)}</span>
            ${message.readByAdmin ? '' : `
              <button type="button" data-admin-guest-contact-read="${escapeHtml(message.messageId)}" style="
                height:28px;border:1px solid rgba(212,165,32,0.42);border-radius:999px;
                background:rgba(212,165,32,0.10);color:#d4a520;
                padding:0 10px;font-size:11px;font-weight:900;cursor:pointer;
              ">Маркирай като прочетено</button>
            `}
          </div>
        </div>
        ${subject ? `<div style="font-size:13px;font-weight:900;color:#ffffff;word-break:break-word;">${escapeHtml(subject)}</div>` : ''}
        <div style="font-size:13px;font-weight:700;line-height:1.45;color:rgba(255,255,255,0.72);word-break:break-word;">${escapeHtml(message.preview)}</div>
      </article>
    `
  }).join('')

  return `
    <section style="min-height:520px;display:grid;gap:14px;align-content:start;">
      <div style="display:flex;align-items:end;justify-content:space-between;gap:16px;border-bottom:1px solid rgba(212,165,32,0.28);padding-bottom:12px;">
        <div>
          <div style="font-size:${isMobile ? '22px' : '26px'};line-height:1.05;font-weight:900;color:#f8fafc;">Съобщения от гости</div>
          <div style="margin-top:6px;font-size:13px;font-weight:700;color:rgba(255,255,255,0.56);">Съобщения, изпратени през публичната контактна форма.</div>
        </div>
      </div>

      ${state.adminGuestContactMessagesErrorText ? `
        <div style="border:1px solid rgba(248,113,113,0.28);background:rgba(127,29,29,0.22);border-radius:8px;padding:12px;color:#fecaca;font-size:13px;font-weight:800;">
          ${escapeHtml(state.adminGuestContactMessagesErrorText)}
        </div>
      ` : ''}

      <div style="display:grid;gap:10px;">
        ${messagesHtml}
      </div>
    </section>
  `
}

function renderPrivateRoomsPage(state: LobbyScreenState): string {
  const hasMyRoom = state.myPrivateRoom !== null

  const roomRowHtml = (room: PrivateRoomSnapshot): string => {
    const timeLeft = Math.max(0, room.expiresAt - Date.now())
    const minutesLeft = Math.ceil(timeLeft / 60000)
    const isLocked = room.kind === 'locked'

    const memberSlotsHtml = Array.from({ length: 4 }, (_, i) => {
      const member = room.members[i]
      if (member) {
        const avatarInner = member.avatarUrl
          ? `<img src="${member.avatarUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:10px;" />`
          : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:22px;color:rgba(255,255,255,0.5);">👤</div>`
        const hostBadge = member.isHost
          ? `<div style="position:absolute;top:-5px;right:-5px;background:#f59e0b;border-radius:50%;width:16px;height:16px;display:flex;align-items:center;justify-content:center;font-size:9px;">★</div>`
          : ''
        return `
          <div style="display:flex;flex-direction:column;align-items:center;gap:5px;min-width:0;">
            <div style="position:relative;width:84px;height:84px;border-radius:10px;overflow:visible;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);">
              <div style="width:84px;height:84px;border-radius:10px;overflow:hidden;">${avatarInner}</div>
              ${hostBadge}
            </div>
            <div style="font-size:10px;color:rgba(255,255,255,0.6);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:92px;text-align:center;">
              ${member.displayName}
            </div>
          </div>`
      }
      return `
        <div style="display:flex;flex-direction:column;align-items:center;gap:5px;">
          <div style="width:84px;height:84px;border-radius:10px;background:rgba(255,255,255,0.04);border:1px dashed rgba(255,255,255,0.12);"></div>
          <div style="height:14px;"></div>
        </div>`
    }).join('')

    return `
      <div style="padding:12px 16px;background:rgba(255,255,255,0.04);border-radius:12px;border:1px solid rgba(255,255,255,0.08);">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;">
          <div style="flex:1;min-width:0;">
            <div style="font-size:14px;font-weight:700;color:#fff;">
              ${room.members[0]?.displayName ?? 'Неизвестен'}
            </div>
            <div style="font-size:12px;color:rgba(255,255,255,0.4);margin-top:3px;">
              Вход ${formatStake(room.stake)} жълт. · ${room.members.length}/4 играча · ~${minutesLeft} мин.
              ${isLocked ? ' · <span style="color:rgba(239,68,68,0.8);">Заключена</span>' : ''}
            </div>
          </div>
          ${isLocked
            ? (state.myPrivateRoom?.id === room.id && room.members.length < 4
                ? `<button type="button" id="invite-friends-open" style="
                    padding:7px 16px;border:1px solid rgba(167,139,250,0.5);background:rgba(167,139,250,0.15);
                    border-radius:9px;color:#a78bfa;font-size:13px;font-weight:700;cursor:pointer;white-space:nowrap;
                  ">+ Покани приятели</button>`
                : `<div style="font-size:12px;color:rgba(239,68,68,0.7);font-weight:600;padding:5px 12px;border:1px solid rgba(239,68,68,0.25);border-radius:8px;">Заключена</div>`)
            : `<button type="button" data-private-room-join="${room.id}" style="
                padding:7px 16px;border:1px solid rgba(167,139,250,0.5);background:rgba(167,139,250,0.12);
                border-radius:9px;color:#a78bfa;font-size:13px;font-weight:700;cursor:pointer;white-space:nowrap;
              ">Влез в масата</button>`
          }
        </div>
        <div style="display:flex;gap:12px;">
          ${memberSlotsHtml}
        </div>
      </div>
    `
  }

  const myRoomId = state.myPrivateRoom?.id ?? null
  const allRooms = [
    ...state.privateRooms.filter(r => r.id === myRoomId),
    ...state.privateRooms.filter(r => r.id !== myRoomId && r.kind === 'open'),
    ...state.privateRooms.filter(r => r.id !== myRoomId && r.kind === 'locked'),
  ]
  const allRoomsHtml = allRooms.map(roomRowHtml).join('')

  const createBtnHtml = hasMyRoom
    ? `
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
        <div style="font-size:13px;color:rgba(255,165,0,0.9);font-weight:600;">Вече имате създадена маса</div>
        <button type="button" data-private-rooms-tab="mine" style="
          padding:7px 14px;background:rgba(167,139,250,0.15);border:1px solid rgba(167,139,250,0.4);
          border-radius:9px;color:#a78bfa;font-size:13px;font-weight:700;cursor:pointer;white-space:nowrap;
        ">Виж масата</button>
      </div>
    `
    : `
      <button type="button" data-private-rooms-create-open="1" style="
        padding:8px 20px;background:rgba(167,139,250,0.18);border:1px solid rgba(167,139,250,0.55);
        border-radius:10px;color:#a78bfa;font-size:14px;font-weight:700;cursor:pointer;white-space:nowrap;
      ">+ Създай маса</button>
    `

  const activeTab = state.privateRoomsTab
  const tabStyle = (tab: 'all' | 'mine'): string => {
    const isActive = activeTab === tab
    return `
      padding:8px 20px;font-size:13px;font-weight:700;cursor:pointer;border:none;border-radius:9px;
      background:${isActive ? 'rgba(167,139,250,0.25)' : 'transparent'};
      color:${isActive ? '#a78bfa' : 'rgba(255,255,255,0.4)'};
    `
  }

  const mineTabContent = state.myPrivateRoom
    ? renderMyRoomPanel(state.myPrivateRoom)
    : `<div style="text-align:center;color:rgba(255,255,255,0.3);font-size:14px;padding:40px 0;">Нямате създадена маса.</div>`

  const allTabContent = allRooms.length > 0
    ? `<div style="display:flex;flex-direction:column;gap:8px;">${allRoomsHtml}</div>`
    : `<div style="text-align:center;color:rgba(255,255,255,0.3);font-size:14px;padding:40px 0;">Няма активни маси в момента.</div>`

  return `
    <div style="max-width:760px;margin:0 auto;padding:24px 0 40px;">
      <!-- Хедър -->
      <div style="display:flex;align-items:center;margin-bottom:24px;gap:16px;flex-wrap:wrap;">
        <button type="button" data-private-rooms-close="1" style="
          display:flex;align-items:center;gap:6px;
          padding:7px 14px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);
          border-radius:9px;color:rgba(255,255,255,0.7);font-size:13px;font-weight:600;cursor:pointer;flex-shrink:0;
        ">← Назад</button>
        <div style="font-size:22px;font-weight:900;color:#a78bfa;flex-shrink:0;">Частни маси</div>
        ${createBtnHtml}
      </div>

      <!-- Табове -->
      <div style="display:flex;gap:4px;margin-bottom:20px;background:rgba(255,255,255,0.05);border-radius:11px;padding:4px;width:fit-content;">
        <button type="button" data-private-rooms-tab="all" style="${tabStyle('all')}">Всички маси</button>
        <button type="button" data-private-rooms-tab="mine" style="${tabStyle('mine')}">Моята маса</button>
      </div>

      <!-- Съдържание -->
      ${activeTab === 'mine' ? mineTabContent : allTabContent}
    </div>

    ${renderPrivateRoomsCreatePopup(state)}
  `
}

function renderPrivateRoomsCreatePopup(state: LobbyScreenState): string {
  if (!state.privateRoomsCreatePopupOpen) return ''

  const SUPPORTED_STAKES: MatchStake[] = [5000, 8000, 10000, 15000, 20000]

  return `
    <div data-private-rooms-create-backdrop="1" style="
      position:fixed;inset:0;z-index:9500;
      background:rgba(0,0,0,0.7);
      display:flex;align-items:center;justify-content:center;
      padding:16px;
    ">
      <div style="
        background:#1a1a2e;
        border:1px solid rgba(167,139,250,0.4);
        border-radius:16px;
        width:380px;
        max-width:100%;
        padding:28px;
        box-shadow:0 8px 40px rgba(0,0,0,0.7);
      ">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
          <div style="font-size:17px;font-weight:900;color:#a78bfa;">Нова маса</div>
          <button type="button" data-private-rooms-create-close="1" style="
            width:30px;height:30px;border:none;background:rgba(255,255,255,0.08);
            border-radius:7px;color:rgba(255,255,255,0.6);font-size:18px;font-weight:700;
            cursor:pointer;display:flex;align-items:center;justify-content:center;
          ">×</button>
        </div>
        <form data-private-room-create-form="1" style="display:flex;flex-direction:column;gap:14px;">
          <div>
            <div style="font-size:12px;color:rgba(255,255,255,0.5);margin-bottom:6px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;">Вход</div>
            <select name="stake" style="
              width:100%;padding:10px 12px;background:#2a2a3e;
              border:1px solid rgba(255,255,255,0.2);border-radius:9px;color:#fff;font-size:14px;
              color-scheme:dark;
            ">
              ${SUPPORTED_STAKES.map((s) => `<option value="${s}">${formatStake(s)} жълтици</option>`).join('')}
            </select>
          </div>
          <label style="display:flex;align-items:center;gap:10px;cursor:pointer;user-select:none;">
            <input type="checkbox" name="isLocked" style="width:17px;height:17px;cursor:pointer;accent-color:#a78bfa;">
            <span style="font-size:13px;color:rgba(255,255,255,0.7);">Заключена маса <span style="color:rgba(255,255,255,0.4);">(само с покана)</span></span>
          </label>
          <button type="submit" style="
            padding:11px;background:rgba(167,139,250,0.2);
            border:1px solid rgba(167,139,250,0.5);border-radius:10px;
            color:#a78bfa;font-size:15px;font-weight:700;cursor:pointer;margin-top:4px;
          ">Създай маса</button>
        </form>
      </div>
    </div>
  `
}


function renderPrivateRoomInvitePopup(state: LobbyScreenState): string {
  if (!state.privateRoomInvite) return ''
  const inv = state.privateRoomInvite
  const secondsLeft = Math.max(0, Math.ceil((inv.expiresAt - Date.now()) / 1000))
  const progressPct = Math.round((secondsLeft / 60) * 100)
  const avatarHtml = inv.fromAvatarUrl
    ? `<img src="${inv.fromAvatarUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`
    : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:28px;">👤</div>`
  const queueCount = state.privateRoomInviteQueue.length

  return `
    <div style="
      position:fixed;inset:0;z-index:9000;
      display:flex;align-items:center;justify-content:center;
      background:rgba(0,0,0,0.65);
    ">
      <div style="
        background:linear-gradient(160deg,#1a1a2e,#13132a);
        border:1px solid rgba(167,139,250,0.45);
        border-radius:20px;
        width:340px;
        max-width:calc(100vw - 32px);
        padding:28px 24px 22px;
        text-align:center;
        box-shadow:0 12px 48px rgba(0,0,0,0.8);
      ">
        <div style="font-size:12px;font-weight:700;color:rgba(167,139,250,0.7);letter-spacing:0.08em;text-transform:uppercase;margin-bottom:18px;">
          Покана за частна маса
        </div>

        <div style="display:flex;flex-direction:column;align-items:center;gap:10px;margin-bottom:18px;">
          <div style="width:64px;height:64px;border-radius:50%;border:2px solid rgba(167,139,250,0.6);overflow:hidden;flex-shrink:0;">
            ${avatarHtml}
          </div>
          <div style="font-size:17px;font-weight:800;color:#fff;">${inv.fromDisplayName}</div>
          <div style="font-size:13px;color:rgba(255,255,255,0.5);">Залог: <span style="color:#fde68a;font-weight:700;">${formatStake(inv.stake)} жълтици</span></div>
        </div>

        <div style="margin-bottom:20px;">
          <div style="display:flex;justify-content:flex-end;margin-bottom:5px;">
            <span id="pr-invite-countdown" style="font-size:12px;color:rgba(255,255,255,0.4);">${secondsLeft}с</span>
          </div>
          <div style="height:4px;background:rgba(255,255,255,0.08);border-radius:2px;overflow:hidden;">
            <div id="pr-invite-progress" style="
              height:100%;width:${progressPct}%;
              background:linear-gradient(90deg,#7c3aed,#a78bfa);
              border-radius:2px;
              transition:width 1s linear;
            "></div>
          </div>
        </div>

        <div style="display:flex;gap:10px;margin-bottom:${queueCount > 0 ? '14px' : '0'};">
          <button type="button" data-private-room-invite-decline="${inv.inviteId}" style="
            flex:1;padding:11px;border:1px solid rgba(239,68,68,0.4);background:rgba(239,68,68,0.1);
            border-radius:10px;color:#f87171;font-size:14px;font-weight:700;cursor:pointer;
          ">Откажи</button>
          <button type="button" data-private-room-invite-accept="${inv.inviteId}" style="
            flex:1;padding:11px;border:none;
            background:linear-gradient(135deg,#7c3aed,#a78bfa);
            border-radius:10px;color:#fff;font-size:14px;font-weight:700;cursor:pointer;
          ">Приеми</button>
        </div>

        ${queueCount > 0 ? `<div style="font-size:11px;color:rgba(255,255,255,0.3);">+${queueCount} ${queueCount === 1 ? 'още покана' : 'още покани'} чакат</div>` : ''}
      </div>
    </div>
  `
}

function renderInviteFriendsPopup(state: LobbyScreenState, _options: RenderLobbyScreenOptions): string {
  if (!state.inviteFriendsPopupOpen || !state.myPrivateRoom) return ''

  const room = state.myPrivateRoom
  const freeSeats = 4 - room.members.length
  if (freeSeats <= 0) return ''

  const onlineFriends = state.friendships?.friends.filter((f) => f.isOnline) ?? null

  return `
    <div style="
      position:fixed;inset:0;z-index:9100;
      display:flex;align-items:center;justify-content:center;
      background:rgba(0,0,0,0.65);
    " id="invite-friends-overlay">
      <div style="
        background:linear-gradient(160deg,#1a1a2e,#13132a);
        border:1px solid rgba(167,139,250,0.35);
        border-radius:20px;
        width:400px;
        max-width:calc(100vw - 32px);
        max-height:80vh;
        display:flex;flex-direction:column;
        box-shadow:0 12px 48px rgba(0,0,0,0.8);
        overflow:hidden;
      ">
        <div style="padding:20px 20px 14px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid rgba(255,255,255,0.07);">
          <div>
            <div style="font-size:15px;font-weight:800;color:#fff;">Покани приятели</div>
            <div style="font-size:12px;color:rgba(255,255,255,0.4);margin-top:2px;">Свободни места: ${freeSeats}</div>
          </div>
          <button type="button" id="invite-friends-close" style="
            width:30px;height:30px;border-radius:50%;border:none;
            background:rgba(255,255,255,0.07);color:rgba(255,255,255,0.6);
            font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;
          ">✕</button>
        </div>

        <div style="flex:1;overflow-y:auto;padding:12px 16px;" id="invite-friends-list">
          ${
            onlineFriends === null
              ? `<div style="text-align:center;padding:32px 0;color:rgba(255,255,255,0.4);font-size:14px;">Зарежда...</div>`
              : onlineFriends.length === 0
                ? `<div style="text-align:center;padding:32px 0;color:rgba(255,255,255,0.4);font-size:14px;">Нямаш онлайн приятели в момента.</div>`
                : onlineFriends
                    .map((f) => {
                      const profileId = f.profile.profileId ?? ''
                      const displayName = f.profile.displayName
                      const avatarUrl = f.profile.avatarUrl
                      const isInGame = f.isInGame === true
                      const avatarHtml = avatarUrl
                        ? `<img src="${avatarUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">`
                        : `<div style="font-size:20px;line-height:42px;text-align:center;">👤</div>`
                      return `
                        <label style="
                          display:flex;align-items:center;gap:12px;
                          padding:10px;border-radius:12px;cursor:${isInGame ? 'not-allowed' : 'pointer'};
                          opacity:${isInGame ? '0.5' : '1'};
                          background:rgba(255,255,255,0.03);
                          margin-bottom:6px;
                        ">
                          <div style="width:42px;height:42px;border-radius:50%;border:1.5px solid rgba(167,139,250,0.4);overflow:hidden;flex-shrink:0;">
                            ${avatarHtml}
                          </div>
                          <div style="flex:1;min-width:0;">
                            <div style="font-size:14px;font-weight:700;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${displayName}</div>
                            <div style="font-size:11px;color:${isInGame ? '#f87171' : '#4ade80'};margin-top:1px;">${isInGame ? 'В игра' : 'Онлайн'}</div>
                          </div>
                          <input type="checkbox"
                            data-invite-friend-id="${profileId}"
                            data-invite-friend-name="${displayName}"
                            ${isInGame ? 'disabled' : ''}
                            style="width:18px;height:18px;accent-color:#a78bfa;flex-shrink:0;"
                          >
                        </label>
                      `
                    })
                    .join('')
          }
        </div>

        <div style="padding:14px 16px;border-top:1px solid rgba(255,255,255,0.07);">
          <button type="button" id="invite-friends-submit" style="
            width:100%;padding:12px;border:none;
            background:linear-gradient(135deg,#7c3aed,#a78bfa);
            border-radius:12px;color:#fff;font-size:14px;font-weight:800;cursor:pointer;
          ">Покани избраните</button>
        </div>
      </div>
    </div>
  `
}

function renderLeavePrivateRoomConfirmPopup(state: LobbyScreenState): string {
  if (!state.leavePrivateRoomForMatchmakingOpen) return ''
  const message = state.leavePrivateRoomForMatchmakingIsHost
    ? 'Ти си домакин на частна маса. Ако продължиш, масата ще бъде затворена и всички участници ще бъдат изхвърлени.'
    : 'Участваш в изчакване на частна маса. Ако продължиш, ще напуснеш масата.'
  return `
    <div style="
      position:fixed;inset:0;z-index:9600;
      display:flex;align-items:center;justify-content:center;
      background:rgba(0,0,0,0.7);
    ">
      <div style="
        background:#1a1a2e;border:1px solid rgba(255,255,255,0.12);
        border-radius:16px;padding:28px 28px 24px;max-width:380px;width:90%;
        box-shadow:0 20px 60px rgba(0,0,0,0.6);
      ">
        <div style="font-size:18px;font-weight:900;color:#fff;margin-bottom:14px;">⚠️ Напускане на маса</div>
        <div style="font-size:14px;color:rgba(255,255,255,0.7);line-height:1.5;margin-bottom:24px;">${message}</div>
        <div style="display:flex;gap:12px;">
          <button type="button" data-leave-pr-cancel="1" style="
            flex:1;padding:11px;border:1px solid rgba(255,255,255,0.2);background:rgba(255,255,255,0.07);
            border-radius:10px;color:rgba(255,255,255,0.7);font-size:14px;font-weight:700;cursor:pointer;
          ">Отказ</button>
          <button type="button" data-leave-pr-confirm="1" style="
            flex:1;padding:11px;border:1px solid rgba(239,68,68,0.5);background:rgba(239,68,68,0.15);
            border-radius:10px;color:#f87171;font-size:14px;font-weight:700;cursor:pointer;
          ">Продължи</button>
        </div>
      </div>
    </div>
  `
}

function renderPrivateRoomInfoPopup(state: LobbyScreenState): string {
  if (!state.privateRoomInfoText) return ''
  return `
    <div data-private-room-info-toast="1" style="
      position:fixed;inset:0;z-index:9500;
      display:flex;align-items:center;justify-content:center;
      pointer-events:none;
    ">
      <div style="
        pointer-events:auto;
        background:#1a1a2e;
        border:1px solid rgba(167,139,250,0.5);
        border-radius:16px;
        padding:22px 36px;
        text-align:center;
        box-shadow:0 8px 48px rgba(0,0,0,0.8);
        min-width:260px;
        max-width:calc(100vw - 48px);
        animation:prInfoIn 0.18s ease both;
      ">
        <style>
          @keyframes prInfoIn {
            from { opacity:0; transform:scale(0.92); }
            to   { opacity:1; transform:scale(1); }
          }
        </style>
        <div style="font-size:15px;font-weight:600;color:rgba(255,255,255,0.9);">${state.privateRoomInfoText}</div>
      </div>
    </div>
  `
}

function renderDailyRewardsPopup(state: LobbyScreenState): string {
  if (!state.dailyRewardsPopupOpen) return ''

  const tiers = state.dailyRewardTiers

  return `
    <div data-daily-rewards-backdrop="1" style="
      position:fixed;inset:0;z-index:8000;
      background:rgba(0,0,0,0.75);
      display:flex;align-items:center;justify-content:center;
    ">
      <div style="
        background:linear-gradient(180deg,#141414 0%,#080808 100%);
        border:1px solid rgba(212,165,32,0.4);
        border-radius:16px;
        width:420px;max-width:calc(100vw - 32px);
        max-height:80vh;
        display:flex;flex-direction:column;
        box-shadow:0 24px 64px rgba(0,0,0,0.7);
        font-family:Arial,Helvetica,sans-serif;
        overflow:hidden;
      ">
        <div style="
          display:flex;align-items:center;justify-content:space-between;
          padding:18px 20px 14px;
          border-bottom:1px solid rgba(212,165,32,0.2);
          flex-shrink:0;
        ">
          <div>
            <div style="font-size:18px;font-weight:900;color:#d4a520;letter-spacing:0.04em;">Ежедневни награди</div>
            <div style="font-size:12px;color:rgba(255,255,255,0.45);margin-top:3px;">Рестартира се в полунощ.</div>
          </div>
          <button type="button" data-daily-rewards-close="1" style="
            width:32px;height:32px;border:none;background:rgba(255,255,255,0.08);
            border-radius:8px;color:rgba(255,255,255,0.6);font-size:18px;font-weight:700;
            cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;
          ">×</button>
        </div>

        <div style="overflow-y:auto;padding:16px 20px;display:flex;flex-direction:column;gap:10px;">
          ${state.dailyRewardsLoading ? `
            <div style="text-align:center;padding:32px 0;color:#d4a520;font-size:14px;font-weight:800;">Зареждане...</div>
          ` : state.dailyRewardsErrorText ? `
            <div style="border-radius:8px;border:1px solid rgba(248,113,113,0.28);background:rgba(127,29,29,0.42);padding:12px;color:#fecaca;font-size:13px;font-weight:800;">${escapeHtml(state.dailyRewardsErrorText)}</div>
          ` : tiers.length === 0 ? `
            <div style="text-align:center;padding:32px 0;color:rgba(255,255,255,0.4);font-size:14px;">Все още няма добавени награди.</div>
          ` : tiers.map((tier) => {
            const claimed = tier.claimedToday === true
            const isClaiming = state.dailyRewardClaimingId === tier.tierId
            return `
              <div style="
                display:flex;align-items:center;gap:12px;
                background:#0d0d0d;border:1px solid ${claimed ? 'rgba(255,255,255,0.10)' : 'rgba(212,165,32,0.25)'};
                border-radius:10px;padding:12px 14px;
                opacity:${claimed ? '0.55' : '1'};
              ">
                <img src="/assets/lobby/icon-coin.png" alt="" style="width:36px;height:36px;object-fit:contain;flex-shrink:0;${claimed ? 'filter:grayscale(1);' : ''}">
                <div style="flex:1;min-width:0;">
                  <div style="font-size:17px;font-weight:900;color:${claimed ? 'rgba(255,255,255,0.45)' : '#d4a520'};">${formatAmount(tier.yellowCoinsAmount)}</div>
                  <div style="font-size:11px;color:rgba(255,255,255,0.4);margin-top:2px;">жълтици</div>
                </div>
                ${claimed ? `
                  <div style="font-size:12px;font-weight:800;color:rgba(255,255,255,0.35);letter-spacing:0.05em;">✓ Взета</div>
                ` : `
                  <button type="button" data-daily-reward-claim="${escapeHtml(tier.tierId)}" ${isClaiming ? 'disabled' : ''} style="
                    height:38px;padding:0 18px;border:0;border-radius:8px;
                    background:${isClaiming ? 'rgba(212,165,32,0.4)' : 'linear-gradient(180deg,#f4c95b 0%,#c98f13 100%)'};
                    color:#000000;font-size:13px;font-weight:900;cursor:${isClaiming ? 'default' : 'pointer'};
                    white-space:nowrap;flex-shrink:0;
                  ">${isClaiming ? 'Вземане...' : 'Вземи'}</button>
                `}
              </div>
            `
          }).join('')}

          ${state.dailyRewardLastAwarded !== null ? `
            <div style="
              margin-top:4px;border-radius:10px;
              border:1px solid rgba(74,222,128,0.3);background:rgba(21,128,61,0.18);
              padding:12px 14px;display:flex;align-items:center;gap:10px;
            ">
              <span style="font-size:20px;">🎉</span>
              <div>
                <div style="font-size:14px;font-weight:900;color:#4ade80;">Получихте наградата!</div>
                <div style="font-size:12px;color:rgba(255,255,255,0.55);margin-top:2px;">+${formatAmount(state.dailyRewardLastAwarded)} жълтици са добавени към вашия портфейл.</div>
              </div>
            </div>
          ` : ''}

          ${state.dailyRewardClaimErrorText ? `
            <div style="border-radius:8px;border:1px solid rgba(248,113,113,0.28);background:rgba(127,29,29,0.42);padding:10px 12px;color:#fecaca;font-size:13px;font-weight:800;">${escapeHtml(state.dailyRewardClaimErrorText)}</div>
          ` : ''}
        </div>
      </div>
    </div>
  `
}

function renderBlockedPlayersPopup(state: LobbyScreenState): string {
  if (!state.blockedPlayersPopupOpen) return ''

  const count = state.blockedPlayers?.length ?? 0
  const limit = state.blockedPlayersLimit

  const listHtml = state.blockedPlayersLoading
    ? `<div style="display:flex;align-items:center;justify-content:center;min-height:120px;color:rgba(255,255,255,0.56);font-size:14px;font-weight:700;">Зареждане...</div>`
    : state.blockedPlayersErrorText
      ? `<div style="display:flex;align-items:center;justify-content:center;min-height:120px;color:#fca5a5;font-size:14px;font-weight:700;">${escapeHtml(state.blockedPlayersErrorText)}</div>`
      : count === 0
        ? `<div style="display:flex;align-items:center;justify-content:center;min-height:120px;color:rgba(255,255,255,0.42);font-size:14px;font-weight:700;">Нямаш блокирани играчи.</div>`
        : (state.blockedPlayers ?? []).map((p) => {
            const name = escapeHtml(p.displayName?.trim() || '—')
            const avatar = p.avatarUrl?.trim() ?? ''
            const profileId = escapeHtml(p.profileId ?? '')
            const avatarHtml = avatar
              ? `<img src="${escapeHtml(avatar)}" alt="" style="width:100%;height:100%;object-fit:cover;display:block;border-radius:12px;">`
              : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;border-radius:12px;background:rgba(255,255,255,0.08);color:#f8fafc;font-size:22px;font-weight:900;">${escapeHtml(name.charAt(0).toUpperCase())}</div>`

            return `
              <div style="display:flex;align-items:center;gap:14px;padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.06);">
                <div style="flex:0 0 48px;height:48px;border-radius:12px;overflow:hidden;border:1px solid rgba(255,255,255,0.10);">
                  ${avatarHtml}
                </div>
                <div style="flex:1;min-width:0;font-size:15px;font-weight:800;color:#f8fafc;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                  ${name}
                </div>
                <button
                  type="button"
                  data-unblock-profile="${profileId}"
                  style="
                    flex:0 0 auto;
                    min-height:34px;
                    padding:0 14px;
                    border:1px solid rgba(212,165,32,0.50);
                    border-radius:8px;
                    background:rgba(212,165,32,0.10);
                    color:#fde68a;
                    font-size:12px;
                    font-weight:900;
                    cursor:pointer;
                    white-space:nowrap;
                    transition:background 120ms,filter 120ms;
                  "
                  onmouseenter="this.style.background='rgba(212,165,32,0.22)'"
                  onmouseleave="this.style.background='rgba(212,165,32,0.10)'"
                >
                  Смъкни блокадата
                </button>
              </div>
            `
          }).join('')

  return `
    <div
      data-blocked-players-popup-root="1"
      style="position:fixed;inset:0;z-index:12000;pointer-events:auto;"
    >
      <div
        data-blocked-players-popup-backdrop="1"
        style="position:absolute;inset:0;background:rgba(0,0,0,0.72);-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);"
      ></div>
      <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;">
        <div
          class="gold-scrollbar"
          style="
            position:relative;
            width:min(92vw,560px);
            max-height:min(88vh,680px);
            overflow:auto;
            border-radius:8px;
            background:linear-gradient(180deg,rgba(32,32,32,0.98) 0%,rgba(8,8,8,0.99) 100%);
            border:2px solid rgba(212,165,32,0.72);
            box-shadow:0 34px 80px rgba(0,0,0,0.42);
            padding:24px;
          "
        >
          <div style="display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:20px;">
            <div>
              <div style="font-size:13px;font-weight:800;letter-spacing:0.14em;text-transform:uppercase;color:rgba(148,163,184,0.92);">Списък</div>
              <div style="font-size:22px;font-weight:900;color:#f8fafc;margin-top:4px;">Блокирани играчи</div>
              <div style="margin-top:6px;font-size:13px;font-weight:700;color:rgba(255,255,255,0.50);">
                ${count} от ${limit} места заети
              </div>
            </div>
            <button
              type="button"
              data-blocked-players-popup-close="1"
              aria-label="Затвори"
              style="width:42px;height:42px;border:none;border-radius:999px;background:rgba(255,255,255,0.08);color:#f8fafc;font-size:22px;font-weight:900;cursor:pointer;flex:0 0 auto;"
            >×</button>
          </div>

          <div style="height:6px;border-radius:999px;background:#050505;border:1px solid rgba(255,255,255,0.08);overflow:hidden;margin-bottom:20px;">
            <div style="
              width:${limit > 0 ? ((count / limit) * 100).toFixed(1) : 0}%;
              height:100%;
              border-radius:999px;
              background:${count >= limit ? 'linear-gradient(90deg,#dc2626,#ef4444)' : 'linear-gradient(90deg,#d4a520,#f4c95b)'};
            "></div>
          </div>

          <div>${listHtml}</div>
        </div>
      </div>
    </div>
  `
}

function renderBlockLimitPopup(state: LobbyScreenState): string {
  if (!state.blockLimitPopupOpen) return ''

  return `
    <div
      data-block-limit-popup-root="1"
      style="position:fixed;inset:0;z-index:13000;pointer-events:auto;"
    >
      <div
        data-block-limit-popup-backdrop="1"
        style="position:absolute;inset:0;background:rgba(0,0,0,0.72);-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);"
      ></div>
      <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;">
        <div style="
          position:relative;
          width:min(92vw,440px);
          border-radius:8px;
          background:linear-gradient(180deg,rgba(32,32,32,0.98) 0%,rgba(8,8,8,0.99) 100%);
          border:2px solid rgba(239,68,68,0.72);
          box-shadow:0 34px 80px rgba(0,0,0,0.42);
          padding:28px 24px;
          text-align:center;
        ">
          <div style="font-size:36px;margin-bottom:12px;">🚫</div>
          <div style="font-size:18px;font-weight:900;color:#f8fafc;margin-bottom:10px;">Достигнат лимит</div>
          <div style="font-size:14px;font-weight:700;color:rgba(255,255,255,0.65);line-height:1.55;margin-bottom:22px;">
            Достигнахте лимита си за блокиране от 50 играча.<br>Освободете място от списъка с блокирани, за да блокирате нов играч.
          </div>
          <div style="display:flex;gap:10px;justify-content:center;">
            <button
              type="button"
              data-block-limit-popup-close="1"
              style="
                min-height:40px;padding:0 18px;
                border:1px solid rgba(255,255,255,0.18);border-radius:8px;
                background:rgba(255,255,255,0.07);color:rgba(255,255,255,0.80);
                font-size:13px;font-weight:900;cursor:pointer;
              "
            >Затвори</button>
            ${!state.isInGame ? `
            <button
              type="button"
              data-block-limit-open-list="1"
              style="
                min-height:40px;padding:0 18px;
                border:1px solid rgba(212,165,32,0.55);border-radius:8px;
                background:linear-gradient(180deg,rgba(244,201,91,0.96) 0%,rgba(201,143,19,0.96) 100%);
                color:#080808;font-size:13px;font-weight:900;cursor:pointer;
              "
            >Виж блокираните</button>
            ` : ''}</div>
        </div>
      </div>
    </div>
  `
}

function renderNoPlayersModal(state: LobbyScreenState): string {
  if (!state.noPlayersModalOpen) return ''

  return `
    <div
      data-no-players-modal-root="1"
      style="position:fixed;inset:0;z-index:13800;display:flex;align-items:center;justify-content:center;padding:24px;"
    >
      <div
        data-no-players-modal-backdrop="1"
        style="position:absolute;inset:0;background:rgba(0,0,0,0.80);-webkit-backdrop-filter:blur(5px);backdrop-filter:blur(5px);"
      ></div>
      <div role="dialog" aria-modal="true" style="
        position:relative;
        width:min(92vw,440px);
        border-radius:12px;
        border:2px solid rgba(255,255,255,0.12);
        background:linear-gradient(180deg,rgba(28,28,28,0.99) 0%,rgba(8,8,8,0.99) 100%);
        box-shadow:0 40px 90px rgba(0,0,0,0.55);
        padding:32px 28px 26px;
        text-align:center;
      ">
        <div style="font-size:42px;margin-bottom:16px;">⏳</div>
        <div style="font-size:20px;font-weight:900;color:#f8fafc;line-height:1.2;margin-bottom:12px;">
          Няма достатъчно свободни играчи
        </div>
        <div style="font-size:14px;line-height:1.65;color:rgba(255,255,255,0.60);font-weight:500;margin-bottom:24px;">
          В момента няма достатъчно играчи за тази маса.<br>Пробвай отново малко по-късно.
        </div>
        <button
          type="button"
          data-no-players-modal-close="1"
          style="
            width:100%;height:46px;
            border:0;border-radius:10px;
            background:linear-gradient(135deg,rgba(255,255,255,0.14) 0%,rgba(255,255,255,0.06) 100%);
            border:1px solid rgba(255,255,255,0.14);
            color:#f8fafc;font-size:15px;font-weight:900;cursor:pointer;
          "
        >Към лобито</button>
      </div>
    </div>
  `
}

function shouldHandleSpaLinkClick(event: MouseEvent): boolean {
  return (
    event.button === 0 &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey &&
    !event.metaKey
  )
}

export function renderLobbyScreen(
  root: HTMLElement,
  options: RenderLobbyScreenOptions,
): void {
  const { state } = options
  const canStartSearch = state.isConnected && !state.isSearching
  const isPhoneLayout = isPhoneLayoutViewport()
  const mobileLayoutAttribute = isPhoneLayout ? 'data-mobile-layout="1"' : ''
  const profileName = state.displayName.trim() || 'Играч'

  const savedScrollTop = root.querySelector<HTMLElement>('[data-lobby-screen-root="1"]')?.scrollTop ?? 0
  // stakesFirstCardIndex се пази като модулна променлива — не се чете от scrollLeft
  const prevSearchEl = root.querySelector<HTMLInputElement>('[data-lobby-players-search="1"]')
  const wasSearchFocused = prevSearchEl !== null && document.activeElement === prevSearchEl
  const savedSearchCaret = wasSearchFocused ? prevSearchEl.selectionStart : null

  root.innerHTML = isPhoneLayout ? `
    <div
      ${mobileLayoutAttribute}
      data-lobby-screen-root="1"
      style="
        position:fixed;inset:0;
        background:#000000;color:#ffffff;
        font-family:Arial, Helvetica, sans-serif;
        overflow-y:auto;overflow-x:hidden;
        z-index:50;
        -webkit-overflow-scrolling:touch;
      "
    >
      ${renderMobileMenu(state)}
      ${renderMobileLobbyScreenContent(state, profileName, canStartSearch)}
      ${renderMobileFooter()}

      ${state.isSearching ? `
        <div style="
          position:fixed;left:12px;right:12px;bottom:12px;z-index:200;
          background:#080808;border:1px solid rgba(212,165,32,0.44);border-radius:8px;
          padding:10px;display:flex;align-items:center;gap:10px;box-shadow:0 12px 36px rgba(0,0,0,0.62);
        ">
          <div style="width:10px;height:10px;border-radius:50%;background:#d4a520;animation:pulse 1.2s ease-in-out infinite;flex:0 0 auto;"></div>
          <div style="min-width:0;flex:1;color:#d4a520;font-size:13px;font-weight:900;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(state.statusText)}</div>
          <button type="button" data-lobby-cancel-button="1" style="height:36px;padding:0 12px;border:0;border-radius:7px;background:#2b174f;color:#f5f3ff;font-size:12px;font-weight:900;">Откажи</button>
        </div>
        <style>@keyframes pulse { 0%, 100% { opacity:1; transform:scale(1); } 50% { opacity:0.5; transform:scale(0.8); } }</style>
      ` : ''}

      ${state.errorText ? `
        <div style="
          position:fixed;left:12px;right:12px;bottom:12px;z-index:210;
          background:rgba(127,29,29,0.96);border:1px solid rgba(248,113,113,0.34);
          border-radius:8px;padding:10px;color:#fecaca;font-size:13px;font-weight:800;text-align:center;
        ">${escapeHtml(state.errorText)}</div>
      ` : ''}

      ${renderLowCoinsModal(state)}
      ${renderProfileEditModal(state)}
      ${renderChangePasswordModal(state)}
      ${renderAuthModal(state)}
      ${renderGuestTrialPopup(state.guestTrialPopup)}
      ${renderGuestLockedStakePopup(state.guestLockedStakePopup)}
      ${renderLevelLockedStakePopup(state.levelLockedStakePopup)}
      ${renderShopPurchaseConfirmModal(state)}
      ${renderDailyRewardsPopup(state)}
      ${renderPrivateRoomInvitePopup(state)}
      ${renderInviteFriendsPopup(state, options)}
      ${renderPrivateRoomInfoPopup(state)}
      ${renderLeavePrivateRoomConfirmPopup(state)}
      ${renderBlockedPlayersPopup(state)}
      ${renderBlockLimitPopup(state)}
      ${renderNoPlayersModal(state)}
      ${renderSupportPopup(state)}
      ${renderGuestContactPopup(state)}
    </div>
    ${renderGiftCoinsModal(state)}
    ${renderGiftSuccessModal(state)}
    ${renderGiftReceivedModal(state)}
  ` : `
    <div
      ${mobileLayoutAttribute}
      data-lobby-screen-root="1"
      style="
        position: fixed;
        inset: 0;
        background: #242424;
        color: #ffffff;
        font-family: Arial, Helvetica, sans-serif;
        overflow-y: auto;
        overflow-x: hidden;
        z-index: 50;
      "
    >
      <style>
        [data-lobby-screen-root="1"] {
          --lobby-scale: 1;
        }

        @media (min-width: 2200px) {
          [data-lobby-screen-root="1"] { --lobby-scale: 1.08; }
        }

        @media (min-width: 1920px) and (max-width: 2199px) {
          [data-lobby-screen-root="1"] { --lobby-scale: 1.02; }
        }

        @media (max-width: 1700px) {
          [data-lobby-screen-root="1"] { --lobby-scale: 0.96; }
        }

        @media (max-width: 1600px) {
          [data-lobby-screen-root="1"] { --lobby-scale: 0.91; }
        }

        @media (max-width: 1500px) {
          [data-lobby-screen-root="1"] { --lobby-scale: 0.86; }
        }

        @media (max-width: 1400px) {
          [data-lobby-screen-root="1"] { --lobby-scale: 0.80; }
        }

        @media (max-width: 1280px) {
          [data-lobby-screen-root="1"] { --lobby-scale: 0.73; }
        }

        @media (max-width: 1120px) {
          [data-lobby-screen-root="1"] { --lobby-scale: 0.64; }
        }

        @media (max-width: 960px) {
          [data-lobby-screen-root="1"] { --lobby-scale: 0.55; }
        }

        @media (max-width: 768px) {
          [data-lobby-screen-root="1"] { --lobby-scale: 0.45; }
        }
      </style>

      <div data-lobby-scale-stage="1" style="width:1640px; margin:0 auto; zoom:var(--lobby-scale);">
        ${renderNav(state)}

        <div style="max-width: 1640px; margin: 0 auto; padding: 16px 20px; background:#000000; box-sizing:border-box;">
          ${state.view === 'support'
            ? renderAdminSupportPage(state)
            : state.view === 'guest-contact-messages'
            ? renderAdminGuestContactMessagesPage(state)
            : state.view === 'private-rooms'
            ? renderPrivateRoomsPage(state)
            : state.view === 'players'
            ? renderPlayersDirectory(state)
            : state.view === 'leaderboards'
              ? renderLeaderboardsDirectory(state)
              : state.view === 'shop'
                ? renderShopPanel(state)
              : state.view === 'admin'
                ? renderAdminPanel(state)
              : state.view === 'admin-info'
                ? renderAdminInfoPanel(state)
              : state.view === 'admin-server'
                ? renderAdminServerPanel(state)
              : state.view === 'admin-visitors'
                ? renderAdminVisitorsPanel(state)
              : state.view === 'admin-payments'
                ? renderAdminPaymentsPanel(
                    {
                      isAdmin: state.isAdmin,
                      period: state.adminPaymentsPeriod,
                      loading: state.adminPaymentsLoading,
                      errorText: state.adminPaymentsErrorText,
                      rows: state.adminPaymentsRows,
                      total: state.adminPaymentsTotal,
                      totalsByCurrency: state.adminPaymentsTotalsByCurrency,
                      offset: state.adminPaymentsOffset,
                      limit: state.adminPaymentsLimit,
                    },
                    { onBack: () => {}, onPeriodChange: () => {}, onPageChange: () => {}, onDetailOpen: () => {} },
                  )
              : state.view === 'admin-payment-detail'
                ? renderAdminPaymentDetailPanel(
                    {
                      isAdmin: state.isAdmin,
                      loading: state.adminPaymentDetailLoading,
                      errorText: state.adminPaymentDetailErrorText,
                      purchase: state.adminPaymentDetailPurchase,
                    },
                    { onBack: () => {} },
                  )
            : state.view === 'friends'
              ? renderFriendsDirectory(state)
            : state.view === 'chat'
                ? renderChatPanel(state)
              : state.view === 'terms' || state.view === 'privacy' || state.view === 'contact'
                ? renderPublicLegalPage(state.view)
              : state.view === 'rules'
                ? renderRulesPage()
              : state.view === 'strategy'
                ? renderStrategyPage()
              : state.view === 'learn'
                ? renderLearnPage()
              : state.view === 'faq'
                ? renderFaqPage()
              : state.view === 'about'
                ? renderAboutPage()
              : state.view === 'fair-play'
                ? renderFairPlayPage()
              : `
              ${state.profile.profileId !== null
                ? renderHeroSection(profileName, state.profile.avatarUrl, state.profile.yellowCoinsBalance, state.profile.wonGamesCount, state.profile.completedGamesCount, state.profile.rankTitle, state.profile.level, isPhoneLayout)
                : renderGuestHeroCard(state.signupBonusYellowCoins ?? 0, isPhoneLayout)}
              ${renderStakeSection(state.selectedStake, canStartSearch, state.isSearching, state.matchRooms, state.profile.level ?? 1, state.matchRoomsLoading, isPhoneLayout, state.profile.profileId === null)}
              ${renderBottomSection(
                state.lobbyPackages,
                state.profile.profileId !== null,
                state.dailyMissionsUnclaimedCount,
                getUnclaimedDailyRewardsBadgeCount(state) > 0,
                isPhoneLayout,
              )}
            `}
          ${renderFooter()}
        </div>
      </div>

      ${state.isSearching ? `
        <div style="
          position:fixed; bottom:24px; left:50%; transform:translateX(-50%);
          z-index:200;
          background:linear-gradient(135deg, #111111 0%, #080808 100%);
          border:1px solid rgba(212,165,32,0.4);
          border-radius:16px;
          padding:14px 24px;
          display:flex; align-items:center; gap:16px;
          box-shadow:0 8px 32px rgba(0,0,0,0.5);
          min-width:360px;
        ">
          <div style="
            width:12px; height:12px; border-radius:50%;
            background:#d4a520;
            animation:pulse 1.2s ease-in-out infinite;
            flex-shrink:0;
          "></div>
          <div style="flex:1;">
            <div style="font-size:14px; font-weight:800; color:#d4a520;">${escapeHtml(state.statusText)}</div>
            <div style="font-size:12px; color:rgba(255,255,255,0.55); margin-top:2px; font-weight:600;">Търсенето е активно. Играта ще стартира автоматично.</div>
          </div>
          <button
            type="button"
            data-lobby-cancel-button="1"
            style="
              background:linear-gradient(135deg, #7c3aed 0%, #5b21b6 100%);
              border:none; border-radius:10px;
              padding:9px 16px;
              font-size:13px; font-weight:800;
              color:#f5f3ff; cursor:pointer;
              white-space:nowrap;
            "
          >Откажи</button>
        </div>

        <style>
          @keyframes pulse {
            0%, 100% { opacity:1; transform:scale(1); }
            50% { opacity:0.5; transform:scale(0.8); }
          }
        </style>
      ` : ''}

      ${state.errorText ? `
        <div style="
          position:fixed; bottom:24px; left:50%; transform:translateX(-50%);
          z-index:200;
          background:rgba(127,29,29,0.95);
          border:1px solid rgba(248,113,113,0.3);
          border-radius:12px;
          padding:12px 20px;
          font-size:13px; font-weight:700; color:#fecaca;
          box-shadow:0 8px 24px rgba(0,0,0,0.4);
          max-width:480px;
          text-align:center;
        ">
          ${escapeHtml(state.errorText)}
        </div>
      ` : ''}

      ${renderLowCoinsModal(state)}
      ${renderProfileEditModal(state)}
      ${renderChangePasswordModal(state)}
      ${renderAuthModal(state)}
      ${renderGuestTrialPopup(state.guestTrialPopup)}
      ${renderGuestLockedStakePopup(state.guestLockedStakePopup)}
      ${renderLevelLockedStakePopup(state.levelLockedStakePopup)}
      ${renderShopPurchaseConfirmModal(state)}
      ${renderDailyRewardsPopup(state)}
      ${renderPrivateRoomInvitePopup(state)}
      ${renderInviteFriendsPopup(state, options)}
      ${renderPrivateRoomInfoPopup(state)}
      ${renderLeavePrivateRoomConfirmPopup(state)}
      ${renderBlockedPlayersPopup(state)}
      ${renderBlockLimitPopup(state)}
      ${renderNoPlayersModal(state)}
      ${renderSupportPopup(state)}
      ${renderGuestContactPopup(state)}
    </div>
    ${renderGiftCoinsModal(state)}
    ${renderGiftSuccessModal(state)}
    ${renderGiftReceivedModal(state)}
  `

  const mobileMenuEl = root.querySelector<HTMLDetailsElement>('[data-lobby-mobile-menu="1"]')
  const clearMobileMenuCloseTimer = () => {
    if (mobileMenuCloseTimer === null) return
    clearTimeout(mobileMenuCloseTimer)
    mobileMenuCloseTimer = null
  }

  const closeMobileMenuAnimated = () => {
    if (!mobileMenuEl?.open) return
    clearMobileMenuCloseTimer()
    const panel = mobileMenuEl.querySelector<HTMLElement>('[data-lobby-mobile-menu-panel="1"]')
    const backdrop = mobileMenuEl.querySelector<HTMLElement>('[data-lobby-mobile-menu-backdrop="1"]')
    mobileMenuOpen = false
    if (panel) panel.style.animation = 'mobile-menu-shade-out 120ms ease both'
    if (backdrop) backdrop.style.animation = 'mobile-menu-backdrop-out 120ms ease both'
    mobileMenuCloseTimer = window.setTimeout(() => {
      mobileMenuCloseTimer = null
      mobileMenuEl.open = false
    }, 120)
  }

  const openMobileMenu = () => {
    if (!mobileMenuEl) return
    clearMobileMenuCloseTimer()
    mobileMenuOpen = true
    mobileMenuEl.open = true
    const panel = mobileMenuEl.querySelector<HTMLElement>('[data-lobby-mobile-menu-panel="1"]')
    const backdrop = mobileMenuEl.querySelector<HTMLElement>('[data-lobby-mobile-menu-backdrop="1"]')
    if (panel) panel.style.animation = 'mobile-menu-shade-in 150ms cubic-bezier(0.2,0.8,0.2,1) both'
    if (backdrop) backdrop.style.animation = 'mobile-menu-backdrop-in 120ms ease both'
  }

  root.querySelector<HTMLElement>('[data-lobby-mobile-menu-summary="1"]')?.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    if (mobileMenuEl?.open) {
      closeMobileMenuAnimated()
      return
    }
    openMobileMenu()
  })

  root.querySelector<HTMLButtonElement>('[data-lobby-mobile-menu-backdrop="1"]')?.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    closeMobileMenuAnimated()
  })

  root.querySelectorAll<HTMLButtonElement>('[data-lobby-mobile-menu="1"] button').forEach((button) => {
    if (button.dataset.lobbyMobileMenuBackdrop === '1') return
    button.addEventListener('click', () => {
      clearMobileMenuCloseTimer()
      mobileMenuOpen = false
      if (mobileMenuEl) mobileMenuEl.open = false
    })
  })

  const scrollEl = root.querySelector<HTMLElement>('[data-lobby-stakes-scroll="1"]')
  const track = root.querySelector<HTMLElement>('[data-stakes-track="1"]')
  const thumb = root.querySelector<HTMLElement>('[data-stakes-thumb="1"]')

  if (scrollEl && track && thumb) {
    const getTrackPadding = () => 4

    const syncThumb = () => {
      const maxScroll = scrollEl.scrollWidth - scrollEl.clientWidth
      if (maxScroll <= 0) { thumb.style.display = 'none'; return }
      thumb.style.display = 'block'
      const trackW = track.clientWidth
      const trackPadding = getTrackPadding()
      const usableTrackW = Math.max(0, trackW - trackPadding * 2)
      const thumbW = Math.max(28, (scrollEl.clientWidth / scrollEl.scrollWidth) * usableTrackW)
      const thumbLeft = trackPadding + (scrollEl.scrollLeft / maxScroll) * (usableTrackW - thumbW)
      thumb.style.width = thumbW + 'px'
      thumb.style.left = thumbLeft + 'px'
    }

    const animateTo = (targetLeft: number) => {
      cancelAnimationFrame(stakesAnimFrame)
      const startLeft = scrollEl.scrollLeft
      const diff = targetLeft - startLeft
      if (Math.abs(diff) < 1) return
      const duration = 320
      const startTime = performance.now()
      const ease = (t: number) => t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t
      const step = (now: number) => {
        const t = Math.min((now - startTime) / duration, 1)
        scrollEl.scrollLeft = startLeft + diff * ease(t)
        if (t < 1) stakesAnimFrame = requestAnimationFrame(step)
        else scrollEl.scrollLeft = targetLeft
      }
      stakesAnimFrame = requestAnimationFrame(step)
    }

    scrollEl.addEventListener('scroll', syncThumb)
    syncThumb()

    const getCards = () => Array.from(scrollEl.querySelectorAll<HTMLElement>('[data-lobby-stake-card]'))

    const clampStakeScrollLeft = (value: number): number => {
      const maxScroll = Math.max(0, scrollEl.scrollWidth - scrollEl.clientWidth)
      return Math.max(0, Math.min(value, maxScroll))
    }

    const getCardScrollLeft = (card: HTMLElement): number => {
      return clampStakeScrollLeft(card.offsetLeft - 2)
    }

    const getNearestCardIndex = (cards: HTMLElement[]): number => {
      if (cards.length === 0) return 0

      let nearestIndex = 0
      let nearestDistance = Number.POSITIVE_INFINITY

      cards.forEach((card, index) => {
        const distance = Math.abs(getCardScrollLeft(card) - scrollEl.scrollLeft)
        if (distance < nearestDistance) {
          nearestDistance = distance
          nearestIndex = index
        }
      })

      return nearestIndex
    }

    root.querySelector('[data-stakes-prev="1"]')?.addEventListener('click', () => {
      const cards = getCards()
      stakesFirstCardIndex = Math.max(0, getNearestCardIndex(cards) - 1)
      const target = cards[stakesFirstCardIndex]
      if (target) animateTo(getCardScrollLeft(target))
    })
    root.querySelector('[data-stakes-next="1"]')?.addEventListener('click', () => {
      const cards = getCards()
      stakesFirstCardIndex = Math.min(cards.length - 1, getNearestCardIndex(cards) + 1)
      const target = cards[stakesFirstCardIndex]
      if (target) animateTo(getCardScrollLeft(target))
    })

    // Drag на плъзгача
    thumb.addEventListener('mousedown', (e) => {
      const startX = e.clientX
      const startScroll = scrollEl.scrollLeft
      const maxScroll = scrollEl.scrollWidth - scrollEl.clientWidth
      const trackW = track.clientWidth
      const thumbW = thumb.offsetWidth
      const trackPadding = getTrackPadding()
      const usableTrackW = Math.max(1, trackW - trackPadding * 2)
      thumb.style.cursor = 'grabbing'
      const onMove = (ev: MouseEvent) => {
        const dx = ev.clientX - startX
        const scrollRange = Math.max(1, usableTrackW - thumbW)
        scrollEl.scrollLeft = startScroll + (dx / scrollRange) * maxScroll
      }
      const onUp = () => {
        thumb.style.cursor = 'grab'
        stakesFirstCardIndex = getNearestCardIndex(getCards())
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
      e.preventDefault()
    })

    track.addEventListener('mousedown', (e) => {
      if (e.target === thumb) {
        return
      }

      const maxScroll = scrollEl.scrollWidth - scrollEl.clientWidth
      if (maxScroll <= 0) {
        return
      }

      const trackRect = track.getBoundingClientRect()
      const trackPadding = getTrackPadding()
      const usableTrackW = Math.max(1, track.clientWidth - trackPadding * 2)
      const thumbW = thumb.offsetWidth
      const scrollRange = Math.max(1, usableTrackW - thumbW)
      const clickX = e.clientX - trackRect.left
      const targetRatio = Math.max(0, Math.min(1, (clickX - trackPadding - thumbW / 2) / scrollRange))

      animateTo(targetRatio * maxScroll)
      e.preventDefault()
    })
  }

  const stakeButtons = root.querySelectorAll<HTMLButtonElement>('[data-lobby-stake-card]')

  stakeButtons.forEach((button) => {
    button.addEventListener('click', () => {
      if (!canStartSearch) {
        return
      }

      const rawStake = Number(button.dataset.lobbyStakeCard)
      if (!rawStake || rawStake <= 0) return

      options.onStakeChange(rawStake)
      options.onSearchClick()
    })
  })

  const cancelButton = root.querySelector<HTMLButtonElement>('[data-lobby-cancel-button="1"]')

  cancelButton?.addEventListener('click', () => {
    options.onCancelClick()
  })

  root
    .querySelectorAll<HTMLButtonElement>('[data-lobby-profile-button="1"]')
    .forEach((el) => {
      el.addEventListener('click', (event) => {
        event.preventDefault()
        options.onProfileClick()
      })
    })

  root.querySelectorAll<HTMLElement>('[data-lobby-nav-lobby="1"]').forEach((el) => {
    el.addEventListener('click', (event) => {
      if (shouldHandleSpaLinkClick(event as MouseEvent)) {
        event.preventDefault()
        options.onLobbyClick()
      }
    })
  })

  root
    .querySelectorAll<HTMLElement>('[data-lobby-nav-players="1"]')
    .forEach((element) => {
      element.addEventListener('click', (e) => {
        if (!shouldHandleSpaLinkClick(e as MouseEvent)) return
        e.preventDefault()
        options.onPlayersClick()
      })
    })

  root
    .querySelector<HTMLButtonElement>('[data-lobby-nav-blocked-players="1"]')
    ?.addEventListener('click', options.onBlockedPlayersClick)

  root
    .querySelector<HTMLButtonElement>('[data-blocked-players-popup-close="1"]')
    ?.addEventListener('click', options.onBlockedPlayersClose)

  root
    .querySelector<HTMLElement>('[data-blocked-players-popup-backdrop="1"]')
    ?.addEventListener('click', options.onBlockedPlayersClose)

  root.querySelectorAll<HTMLButtonElement>('[data-unblock-profile]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const profileId = btn.dataset.unblockProfile?.trim() ?? ''
      if (profileId) options.onUnblockClick(profileId)
    })
  })

  root
    .querySelector<HTMLButtonElement>('[data-block-limit-popup-close="1"]')
    ?.addEventListener('click', options.onBlockLimitPopupClose)

  root
    .querySelector<HTMLElement>('[data-block-limit-popup-backdrop="1"]')
    ?.addEventListener('click', options.onBlockLimitPopupClose)

  root
    .querySelector<HTMLButtonElement>('[data-no-players-modal-close="1"]')
    ?.addEventListener('click', options.onNoPlayersModalClose)

  root
    .querySelector<HTMLElement>('[data-no-players-modal-backdrop="1"]')
    ?.addEventListener('click', options.onNoPlayersModalClose)

  root
    .querySelector<HTMLButtonElement>('[data-block-limit-open-list="1"]')
    ?.addEventListener('click', () => {
      options.onBlockLimitPopupClose()
      options.onBlockedPlayersClick()
    })

  root
    .querySelectorAll<HTMLElement>('[data-lobby-nav-leaderboards="1"]')
    .forEach((element) => {
      element.addEventListener('click', (e) => {
        if (!shouldHandleSpaLinkClick(e as MouseEvent)) return
        e.preventDefault()
        options.onLeaderboardsClick()
      })
    })

  root
    .querySelectorAll<HTMLButtonElement>('[data-lobby-nav-shop="1"]')
    .forEach((btn) => btn.addEventListener('click', options.onShopClick))

  root.querySelectorAll<HTMLButtonElement>('[data-lobby-shop-package]').forEach((button) => {
    button.addEventListener('click', () => {
      const packageId = button.dataset.lobbyShopPackage?.trim() ?? ''

      if (packageId.length > 0) {
        options.onShopPurchaseClick(packageId)
      }
    })
  })

  root.querySelectorAll<HTMLElement>('[data-shop-purchase-confirm-close="1"], [data-shop-purchase-confirm-cancel="1"]')
    .forEach((element) => {
      element.addEventListener('click', options.onShopPurchaseCancel)
    })

  root.querySelector<HTMLElement>('[data-shop-purchase-confirm-backdrop="1"]')
    ?.addEventListener('click', options.onShopPurchaseCancel)

  const hideShopPurchaseLegalPreviews = () => {
    root.querySelectorAll<HTMLElement>('[data-shop-purchase-legal-preview]').forEach((preview) => {
      preview.style.display = 'none'
    })
  }

  root.querySelectorAll<HTMLAnchorElement>('[data-shop-confirm-legal-link]').forEach((link) => {
    link.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      const pageKey = link.dataset.shopConfirmLegalLink
      const preview = pageKey === 'terms' || pageKey === 'privacy'
        ? root.querySelector<HTMLElement>(`[data-shop-purchase-legal-preview="${pageKey}"]`)
        : null

      hideShopPurchaseLegalPreviews()
      if (preview) preview.style.display = 'flex'
    })
  })

  root.querySelectorAll<HTMLElement>('[data-shop-purchase-legal-close="1"], [data-shop-purchase-legal-backdrop="1"]').forEach((element) => {
    element.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      hideShopPurchaseLegalPreviews()
    })
  })

  const shopConfirmCheck = root.querySelector<HTMLInputElement>('[data-shop-purchase-confirm-check="1"]')
  const shopConfirmSubmit = root.querySelector<HTMLButtonElement>('[data-shop-purchase-confirm-submit="1"]')
  if (shopConfirmCheck && shopConfirmSubmit && state.shopPurchaseActionPackageId === null) {
    shopConfirmCheck.addEventListener('change', () => {
      const enabled = shopConfirmCheck.checked
      shopConfirmSubmit.disabled = !enabled
      shopConfirmSubmit.style.cursor = enabled ? 'pointer' : 'not-allowed'
      shopConfirmSubmit.style.opacity = enabled ? '1' : '0.55'
    })
  }

  shopConfirmSubmit?.addEventListener('click', () => {
    if (shopConfirmSubmit.disabled) return
    shopConfirmSubmit.disabled = true
    shopConfirmSubmit.style.cursor = 'wait'
    shopConfirmSubmit.style.opacity = '0.72'
    options.onShopPurchaseConfirm()
  })

  root.querySelectorAll<HTMLInputElement>('[data-lobby-shop-package-lobby]').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      const packageId = checkbox.dataset.lobbyShopPackageLobby?.trim() ?? ''

      if (packageId.length > 0) {
        options.onAdminCoinPackageLobbyToggle(packageId, checkbox.checked)
      }
    })
  })

  root.querySelectorAll<HTMLInputElement>('[data-lobby-admin-package-lobby]').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      const packageId = checkbox.dataset.lobbyAdminPackageLobby?.trim() ?? ''

      if (packageId.length > 0) {
        options.onAdminCoinPackageLobbyToggle(packageId, checkbox.checked)
      }
    })
  })

  root.querySelectorAll<HTMLButtonElement>('[data-lobby-buy-coins-package]').forEach((button) => {
    button.addEventListener('click', () => {
      const packageId = button.dataset.lobbyBuyCoinsPackage?.trim() ?? ''
      const isLoggedIn = button.dataset.lobbyBuyCoinsLogged === '1'

      if (packageId.length === 0) {
        return
      }

      if (isLoggedIn) {
        options.onShopPurchaseClick(packageId)
      } else {
        options.onAuthModeChange('login')
      }
    })
  })

  root
    .querySelector<HTMLButtonElement>('[data-lobby-nav-logout="1"]')
    ?.addEventListener('click', options.onLogoutClick)

  const adminDropdown = root.querySelector<HTMLElement>('[data-admin-dropdown="1"]')
  const adminToggle = root.querySelector<HTMLButtonElement>('[data-lobby-nav-admin-toggle="1"]')
  const adminMailDropdown = root.querySelector<HTMLElement>('[data-admin-mail-dropdown="1"]')

  if (adminToggle && adminDropdown) {
    adminToggle.addEventListener('click', (e) => {
      e.stopPropagation()
      const isOpen = adminDropdown.style.display !== 'none'
      adminDropdown.style.display = isOpen ? 'none' : 'block'
    })
    document.addEventListener('click', () => {
      adminDropdown.style.display = 'none'
    }, { once: false, capture: true })
  }

  root
    .querySelector<HTMLButtonElement>('[data-lobby-nav-admin="1"]')
    ?.addEventListener('click', () => {
      if (adminDropdown) adminDropdown.style.display = 'none'
      options.onAdminClick()
    })

  root
    .querySelector<HTMLButtonElement>('[data-lobby-nav-admin-info="1"]')
    ?.addEventListener('click', () => {
      if (adminDropdown) adminDropdown.style.display = 'none'
      options.onAdminInfoClick()
    })

  root
    .querySelector<HTMLButtonElement>('[data-lobby-nav-admin-server="1"]')
    ?.addEventListener('click', () => {
      if (adminDropdown) adminDropdown.style.display = 'none'
      options.onAdminServerClick()
    })

  root
    .querySelectorAll<HTMLButtonElement>('[data-lobby-nav-admin-guest-contact="1"]')
    .forEach((button) => button.addEventListener('click', () => {
      if (adminDropdown) adminDropdown.style.display = 'none'
      if (adminMailDropdown) adminMailDropdown.style.display = 'none'
      options.onAdminGuestContactMessagesClick()
    }))

  root
    .querySelectorAll<HTMLButtonElement>('[data-lobby-nav-support-users="1"]')
    .forEach((button) => button.addEventListener('click', () => {
      if (adminMailDropdown) adminMailDropdown.style.display = 'none'
      options.onSupportClick()
    }))

  if (adminMailDropdown) {
    root
      .querySelector<HTMLButtonElement>('[data-lobby-nav-support="1"]')
      ?.addEventListener('click', (event) => {
        event.stopPropagation()
        const isOpen = adminMailDropdown.style.display !== 'none'
        adminMailDropdown.style.display = isOpen ? 'none' : 'block'
      })
    document.addEventListener('click', () => {
      adminMailDropdown.style.display = 'none'
    }, { once: false, capture: true })
  } else {
    root.querySelector<HTMLElement>('[data-lobby-nav-support="1"]')
      ?.addEventListener('click', options.onSupportClick)
  }

  root
    .querySelector<HTMLButtonElement>('[data-lobby-nav-friends="1"]')
    ?.addEventListener('click', options.onFriendsClick)

  root
    .querySelector<HTMLButtonElement>('[data-lobby-nav-chat="1"]')
    ?.addEventListener('click', options.onChatClick)

  root.querySelectorAll<HTMLButtonElement>('[data-lobby-chat-conversation]').forEach((button) => {
    button.addEventListener('click', () => {
      const friendshipId = button.dataset.lobbyChatConversation?.trim() ?? ''

      if (friendshipId.length > 0) {
        options.onChatConversationClick(friendshipId)
        options.onChatMarkRead(friendshipId)
      }
    })
  })

  root.querySelectorAll<HTMLFormElement>('[data-lobby-chat-form]').forEach((form) => {
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      const friendshipId = form.dataset.lobbyChatForm?.trim() ?? ''
      const data = new FormData(form)
      const body = String(data.get('message') ?? '').trim()

      if (friendshipId.length > 0 && body.length > 0) {
        options.onChatSubmit(friendshipId, body)
        form.reset()
        form.querySelector<HTMLInputElement>('input[name="message"]')?.focus()
      }
    })
  })

  root.querySelectorAll<HTMLButtonElement>('[data-chat-emoji]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const code = btn.dataset.chatEmoji ?? ''
      const form = root.querySelector<HTMLFormElement>('[data-lobby-chat-form]')
      const friendshipId = form?.dataset.lobbyChatForm?.trim() ?? ''
      if (!code || !friendshipId) return
      options.onChatSubmit(friendshipId, code)
    })
  })

  root.querySelectorAll<HTMLButtonElement>('[data-lobby-player-card]').forEach((button) => {
    button.addEventListener('click', () => {
      const profileId = button.dataset.lobbyPlayerCard ?? ''
      // Профил намерен само чрез server-side search (извън първите 500 в
      // state.players) не е в базовия списък — fallback към search резултатите.
      const profile =
        state.players.find((player) => player.profileId === profileId) ??
        state.playersSearchResults?.find((player) => player.profileId === profileId)

      if (profile) {
        options.onPlayerCardClick(profile)
      }
    })
  })

  // Desktop: live filter на всяка буква
  root.querySelector<HTMLInputElement>('[data-lobby-players-search="1"]')
    ?.addEventListener('input', (event) => {
      options.onPlayersSearchChange((event.currentTarget as HTMLInputElement).value)
    })

  // Mobile: само обновява draft при писане — без render
  root.querySelector<HTMLInputElement>('[data-lobby-players-search-mobile="1"]')
    ?.addEventListener('input', (event) => {
      options.onPlayersSearchDraftChange((event.currentTarget as HTMLInputElement).value)
    })

  // Mobile: submit при бутон или Enter/Search от клавиатурата
  root.querySelector<HTMLFormElement>('[data-lobby-players-search-form="1"]')
    ?.addEventListener('submit', (event) => {
      event.preventDefault()
      const form = event.currentTarget as HTMLFormElement
      const input = form.querySelector<HTMLInputElement>('[data-lobby-players-search-mobile="1"]')
      options.onPlayersSearchSubmit(input?.value ?? '')
    })

  root.querySelectorAll<HTMLButtonElement>('[data-lobby-leaderboard-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      const category = button.dataset.lobbyLeaderboardTab as LeaderboardCategory | undefined

      if (
        category === 'balance' ||
        category === 'rank' ||
        category === 'wins' ||
        category === 'rating'
      ) {
        options.onLeaderboardCategoryClick(category)
      }
    })
  })

  root.querySelectorAll<HTMLButtonElement>('[data-lobby-leaderboard-player]').forEach((button) => {
    button.addEventListener('click', () => {
      const profileId = button.dataset.lobbyLeaderboardPlayer ?? ''
      const leaderboards = state.leaderboards
      const profile = leaderboards
        ? [
            ...leaderboards.balance,
            ...leaderboards.rank,
            ...leaderboards.wins,
            ...leaderboards.rating,
          ].find((player) => player.profileId === profileId)
        : null

      if (profile) {
        options.onLeaderboardPlayerClick(profile)
      }
    })
  })

  root
    .querySelector<HTMLFormElement>('[data-lobby-admin-settings-form="1"]')
    ?.addEventListener('submit', (event) => {
      event.preventDefault()
      const form = event.currentTarget as HTMLFormElement
      const data = new FormData(form)
      const signupBonusYellowCoins = Number(data.get('signupBonusYellowCoins'))
      const profileNameChangePrice = Number(data.get('profileNameChangePrice'))

      options.onAdminSettingsSubmit({
        signupBonusYellowCoins,
        profileNameChangePrice,
      })
    })

  root
    .querySelector<HTMLFormElement>('[data-lobby-admin-coin-package-form="1"]')
    ?.addEventListener('submit', (event) => {
      event.preventDefault()
      const form = event.currentTarget as HTMLFormElement
      const data = new FormData(form)
      const status = String(data.get('status') ?? '')

      if (status !== 'active' && status !== 'inactive') {
        return
      }

      const title = String(data.get('title') ?? '').trim()
      const existingKey = String(data.get('packageKey') ?? '').trim()
      const packageKey = existingKey ||
        title.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)

      options.onAdminCoinPackageSubmit({
        packageId: String(data.get('packageId') ?? '').trim() || null,
        packageKey,
        title,
        description: String(data.get('description') ?? '').trim(),
        yellowCoinsAmount: Number(data.get('yellowCoinsAmount')),
        priceCents: Number(data.get('priceCents')),
        currency: String(data.get('currency') ?? 'EUR').trim().toUpperCase(),
        status,
        sortOrder: Number(data.get('sortOrder')),
        showInLobby: data.get('showInLobby') === 'on',
      })
    })

  root.querySelectorAll<HTMLButtonElement>('[data-lobby-admin-package-status]').forEach((button) => {
    button.addEventListener('click', () => {
      const packageId = button.dataset.lobbyAdminPackageStatus?.trim() ?? ''
      const status = button.dataset.lobbyAdminPackageNextStatus ?? ''

      if (packageId.length > 0 && (status === 'active' || status === 'inactive')) {
        options.onAdminCoinPackageStatusChange(packageId, status)
      }
    })
  })

  root.querySelectorAll<HTMLButtonElement>('[data-lobby-admin-package-edit]').forEach((button) => {
    button.addEventListener('click', () => {
      const packageId = button.dataset.lobbyAdminPackageEdit?.trim() ?? ''
      if (packageId.length > 0) {
        options.onAdminCoinPackageEdit(packageId)
      }
    })
  })

  root.querySelector<HTMLButtonElement>('[data-lobby-admin-package-edit-cancel="1"]')
    ?.addEventListener('click', () => {
      options.onAdminCoinPackageEdit('')
    })

  root.querySelectorAll<HTMLButtonElement>('[data-admin-mission-edit]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const missionId = btn.dataset.adminMissionEdit?.trim() ?? ''
      const isStaged = btn.dataset.adminMissionEditStaged === '1'
      if (missionId) options.onAdminMissionEdit(missionId, isStaged)
    })
  })

  root.querySelector<HTMLButtonElement>('[data-admin-mission-edit-start="today"]')
    ?.addEventListener('click', () => {
      options.onAdminMissionEdit('new', false)
    })

  root.querySelector<HTMLButtonElement>('[data-admin-mission-edit-start][data-admin-mission-edit-start-staged]')
    ?.addEventListener('click', () => {
      options.onAdminMissionEdit('new', true)
    })

  root.querySelector<HTMLButtonElement>('[data-admin-mission-form-cancel="1"]')
    ?.addEventListener('click', () => {
      options.onAdminMissionEdit('')
    })

  root.querySelectorAll<HTMLButtonElement>('[data-admin-mission-delete]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const missionId = btn.dataset.adminMissionDelete?.trim() ?? ''
      if (missionId && confirm('Сигурен ли си, че искаш да изтриеш тази мисия?')) {
        options.onAdminMissionDelete(missionId)
      }
    })
  })

  root.querySelector<HTMLFormElement>('[data-admin-mission-form="1"]')
    ?.addEventListener('submit', (event) => {
      event.preventDefault()
      const form = event.currentTarget as HTMLFormElement
      const data = new FormData(form)
      const missionType = String(data.get('missionType') ?? '').trim()
      const targetCount = Number(data.get('targetCount') ?? 1)
      const rewardYellowCoins = Number(data.get('rewardYellowCoins') ?? 1000)
      const missionId = String(data.get('missionId') ?? '').trim() || null
      const isStaged = String(data.get('isStaged') ?? '') === 'true'
      const title = (MISSION_TYPE_LABELS[missionType] ?? missionType).replace('N', String(targetCount))

      if (!missionType || !title || targetCount < 1 || rewardYellowCoins < 1) return

      options.onAdminMissionSubmit({
        missionId,
        missionType: missionType as import('../network/createGameServerClient').MissionType,
        title,
        targetCount,
        rewardYellowCoins,
        isStaged,
      })
    })

  root.querySelectorAll<HTMLButtonElement>('[data-admin-room-edit]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const stakeAmount = Number(btn.dataset.adminRoomEdit ?? 0)
      const room = state.matchRooms.find((r) => r.stakeAmount === stakeAmount)
      if (room) options.onAdminMatchRoomEditStart({ stakeAmount: room.stakeAmount, minLevel: room.minLevel, prizeAmount: room.prizeAmount, isEnabled: room.isEnabled })
    })
  })

  root.querySelector<HTMLButtonElement>('[data-admin-room-new="1"]')
    ?.addEventListener('click', () => {
      options.onAdminMatchRoomEditStart(null)
    })

  root.querySelector<HTMLButtonElement>('[data-admin-room-form-cancel="1"]')
    ?.addEventListener('click', () => {
      options.onAdminMatchRoomEditCancel()
    })

  root.querySelector<HTMLInputElement>('[data-admin-room-stake-input="1"]')
    ?.addEventListener('input', (e) => {
      const stake = Number((e.currentTarget as HTMLInputElement).value)
      const prizeInput = root.querySelector<HTMLInputElement>('[data-admin-room-prize-input="1"]')
      if (!prizeInput || stake <= 0) return
      const multiplier = stake >= 100_000 ? 1.8 : stake >= 50_000 ? 1.7 : 1.6
      prizeInput.value = String(Math.round((stake * multiplier) / 1000) * 1000)
    })

  root.querySelectorAll<HTMLButtonElement>('[data-admin-room-delete]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const stakeAmount = Number(btn.dataset.adminRoomDelete ?? 0)
      if (stakeAmount > 0 && confirm(`Сигурен ли си, че искаш да изтриеш стаята с вход ${formatAmount(stakeAmount)}?`)) {
        options.onAdminMatchRoomDelete(stakeAmount)
      }
    })
  })

  root.querySelector<HTMLFormElement>('[data-admin-room-form="1"]')
    ?.addEventListener('submit', (event) => {
      event.preventDefault()
      const form = event.currentTarget as HTMLFormElement
      const data = new FormData(form)
      const stakeAmount = Number(data.get('stakeAmount') ?? 0)
      const prizeAmount = Number(data.get('prizeAmount') ?? 0)
      const minLevel = Number(data.get('minLevel') ?? 1)
      const isEnabled = String(data.get('isEnabled') ?? '1') === '1'
      if (stakeAmount <= 0 || prizeAmount <= 0 || minLevel < 1) return
      options.onAdminMatchRoomSubmit({ stakeAmount, minLevel, prizeAmount, isEnabled })
    })

  root.querySelectorAll<HTMLButtonElement>('[data-lobby-admin-package-delete]').forEach((button) => {
    button.addEventListener('click', () => {
      const packageId = button.dataset.lobbyAdminPackageDelete?.trim() ?? ''
      if (packageId.length > 0 && confirm('Сигурен ли си, че искаш да изтриеш тази оферта?')) {
        options.onAdminCoinPackageDelete(packageId)
      }
    })
  })

  root.querySelectorAll<HTMLButtonElement>('[data-lobby-friend-profile]').forEach((button) => {
    button.addEventListener('click', () => {
      const profileId = button.dataset.lobbyFriendProfile ?? ''
      const friendshipGroups = state.friendships
        ? [
            ...state.friendships.incomingPending,
            ...state.friendships.outgoingPending,
            ...state.friendships.friends,
          ]
        : []
      const relationship = friendshipGroups.find(
        (item) => item.profile.profileId === profileId,
      )

      if (relationship) {
        options.onFriendProfileClick(relationship.profile)
      }
    })
  })

  root.querySelectorAll<HTMLButtonElement>('[data-lobby-friend-accept]').forEach((button) => {
    button.addEventListener('click', () => {
      const friendshipId = button.dataset.lobbyFriendAccept?.trim() ?? ''

      if (friendshipId.length > 0) {
        options.onFriendAcceptClick(friendshipId)
      }
    })
  })

  root.querySelectorAll<HTMLButtonElement>('[data-lobby-friend-reject]').forEach((button) => {
    button.addEventListener('click', () => {
      const friendshipId = button.dataset.lobbyFriendReject?.trim() ?? ''

      if (friendshipId.length > 0) {
        options.onFriendRejectClick(friendshipId)
      }
    })
  })

  root.querySelectorAll<HTMLButtonElement>('[data-lobby-friend-cancel]').forEach((button) => {
    button.addEventListener('click', () => {
      const friendshipId = button.dataset.lobbyFriendCancel?.trim() ?? ''

      if (friendshipId.length > 0) {
        options.onFriendCancelClick(friendshipId)
      }
    })
  })

  root.querySelectorAll<HTMLButtonElement>('[data-lobby-friend-remove]').forEach((button) => {
    button.addEventListener('click', () => {
      const friendshipId = button.dataset.lobbyFriendRemove?.trim() ?? ''

      if (friendshipId.length > 0) {
        options.onFriendRemoveClick(friendshipId)
      }
    })
  })

  root.querySelectorAll<HTMLElement>('[data-lobby-nav-guest-contact="1"]')
    .forEach((el) => el.addEventListener('click', options.onGuestContactClick))

  root.querySelectorAll<HTMLButtonElement>('[data-public-contact-mail="1"]')
    .forEach((button) => {
      button.addEventListener('click', () => {
        if (state.profile.profileId !== null) {
          options.onSupportClick()
          return
        }

        options.onGuestContactClick()
      })
    })

  root.querySelector<HTMLButtonElement>('[data-support-popup-close="1"]')
    ?.addEventListener('click', options.onSupportClose)

  root.querySelector<HTMLElement>('[data-support-popup-backdrop="1"]')
    ?.addEventListener('click', options.onSupportClose)

  root.querySelectorAll<HTMLButtonElement>('[data-guest-contact-popup-close="1"]')
    .forEach((btn) => btn.addEventListener('click', options.onGuestContactClose))

  root.querySelector<HTMLElement>('[data-guest-contact-popup-backdrop="1"]')
    ?.addEventListener('click', options.onGuestContactClose)

  root.querySelector<HTMLButtonElement>('[data-lobby-nav-back="1"]')
    ?.addEventListener('click', options.onLobbyClick)

  root.querySelector<HTMLElement>('[data-lobby-nav-bell="1"]')
    ?.addEventListener('click', options.onBellClick)

  root.querySelector<HTMLElement>('[data-lobby-missions-card="1"]')
    ?.addEventListener('click', options.onMissionsCardClick)

  root.querySelectorAll<HTMLButtonElement>('[data-shop-history-toggle="1"]')
    .forEach((btn) => btn.addEventListener('click', options.onShopHistoryToggle))

  root.querySelectorAll<HTMLButtonElement>('[data-shop-purchase-resume]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const purchaseId = btn.dataset.shopPurchaseResume?.trim() ?? ''
      if (purchaseId.length > 0) {
        options.onShopPurchaseResumePay(purchaseId)
      }
    })
  })

  root.querySelectorAll<HTMLButtonElement>('[data-shop-purchase-hide]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const purchaseId = btn.dataset.shopPurchaseHide?.trim() ?? ''
      if (purchaseId.length > 0) {
        options.onShopPurchaseHideRequest(purchaseId)
      }
    })
  })

  root.querySelectorAll<HTMLButtonElement>('[data-shop-purchase-hide-confirm]').forEach((btn) => {
    btn.addEventListener('click', () => {
      options.onShopPurchaseHideConfirm()
    })
  })

  root.querySelectorAll<HTMLButtonElement>('[data-shop-purchase-hide-cancel]').forEach((btn) => {
    btn.addEventListener('click', () => {
      options.onShopPurchaseHideCancel()
    })
  })

  syncNotificationsDropdown(state, {
    onClose: options.onBellClick,
    onMissionsClick: options.onNotificationMissionsClick,
    onDailyRewardsClick: () => {
      options.onBellClick()
      options.onDailyRewardsOpen()
    },
    onFriendRequestClick: options.onNotifFriendRequestClick,
    onGiftNotificationClick: options.onNotifGiftClick,
    onAcceptanceNotificationClick: options.onNotifAcceptanceClick,
  })

  syncMissionsPopup(state, {
    onClose: options.onMissionsPopupClose,
    onMissionClaim: options.onMissionClaimClick,
  })

  // Управление на профил попъпа директно на document.body (без участие в root.innerHTML)
  syncProfilePopup(
    {
      isOpen: state.profilePopupOpen,
      profile: state.profilePopupProfile ?? state.profile,
      canEdit: state.profilePopupCanEdit,
      isAdmin: state.isAdmin,
      friendshipAction: state.friendshipAction,
    },
    {
      onClose: options.onProfileClose,
      onEditClick: options.onProfileEditClick,
      onFriendRequestClick: options.onFriendRequestClick,
      onBlockClick: options.onBlockClick,
      onFriendAcceptClick: options.onFriendAcceptClick,
      onFriendRejectClick: options.onFriendRejectClick,
      onFriendCancelClick: options.onFriendCancelClick,
      onFriendRemoveClick: options.onFriendRemoveClick,
      onGiftCoinsClick: options.onGiftCoinsClick,
      onLikeClick: options.onLikeClick,
    },
  )

  root.querySelectorAll<HTMLButtonElement>('[data-lobby-low-coins-close="1"]').forEach((btn) => {
    btn.addEventListener('click', options.onLowCoinsModalClose)
  })

  root
    .querySelector<HTMLButtonElement>('[data-lobby-low-coins-shop="1"]')
    ?.addEventListener('click', options.onLowCoinsShopClick)

  root
    .querySelector<HTMLElement>('[data-lobby-low-coins-backdrop="1"]')
    ?.addEventListener('click', options.onLowCoinsModalClose)

  root
    .querySelector<HTMLButtonElement>('[data-lobby-gift-modal-close="1"]')
    ?.addEventListener('click', options.onGiftCoinsClose)

  root
    .querySelector<HTMLButtonElement>('[data-lobby-gift-modal-cancel="1"]')
    ?.addEventListener('click', options.onGiftCoinsClose)

  root
    .querySelector<HTMLElement>('[data-lobby-gift-modal-backdrop="1"]')
    ?.addEventListener('click', options.onGiftCoinsClose)

  root.querySelectorAll<HTMLFormElement>('[data-lobby-gift-form]').forEach((form) => {
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      const friendshipId = form.dataset.lobbyGiftForm?.trim() ?? ''
      const data = new FormData(form)
      const amount = Number(data.get('amount') ?? 0)

      if (friendshipId.length > 0) {
        options.onGiftCoinsSubmit(friendshipId, amount)
      }
    })
  })

  root
    .querySelector<HTMLButtonElement>('[data-lobby-gift-success-ok="1"]')
    ?.addEventListener('click', options.onGiftSuccessClose)

  root
    .querySelector<HTMLButtonElement>('[data-lobby-gift-received-ok="1"]')
    ?.addEventListener('click', options.onGiftReceivedClose)

  root
    .querySelector<HTMLButtonElement>('[data-lobby-profile-editor-close="1"]')
    ?.addEventListener('click', options.onProfileEditClose)

  root
    .querySelector<HTMLButtonElement>('[data-lobby-profile-editor-cancel="1"]')
    ?.addEventListener('click', options.onProfileEditClose)

  root
    .querySelector<HTMLElement>('[data-lobby-profile-editor-backdrop="1"]')
    ?.addEventListener('click', options.onProfileEditClose)

  root
    .querySelector<HTMLButtonElement>('[data-change-password-open="1"]')
    ?.addEventListener('click', options.onChangePasswordOpen)

  root.querySelectorAll<HTMLButtonElement>('[data-change-password-close="1"]').forEach((btn) => {
    btn.addEventListener('click', options.onChangePasswordClose)
  })

  root
    .querySelector<HTMLElement>('[data-change-password-backdrop="1"]')
    ?.addEventListener('click', options.onChangePasswordClose)

  const changePasswordForm = root.querySelector<HTMLFormElement>('[data-change-password-form="1"]')
  if (changePasswordForm) {
    changePasswordForm.querySelectorAll<HTMLButtonElement>('[data-toggle-password]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const fieldName = btn.dataset.togglePassword ?? ''
        const input = changePasswordForm.querySelector<HTMLInputElement>(`input[name="${fieldName}"]`)
        if (!input) return
        const isHidden = input.type === 'password'
        input.type = isHidden ? 'text' : 'password'
        btn.style.color = isHidden ? 'rgba(212,165,32,0.8)' : 'rgba(255,255,255,0.4)'
      })
    })

    changePasswordForm.addEventListener('submit', (event) => {
      event.preventDefault()
      const data = new FormData(changePasswordForm)
      const currentPassword = String(data.get('currentPassword') ?? '')
      const newPassword = String(data.get('newPassword') ?? '')
      const confirmPassword = String(data.get('confirmPassword') ?? '')
      options.onChangePasswordSubmit(currentPassword, newPassword, confirmPassword)
    })
  }

  const avatarInput = ensurePersistentAvatarInput()

  root.querySelectorAll<HTMLButtonElement>('.avatar-source-btn').forEach((btn) => {
    btn.addEventListener('mouseenter', () => { btn.style.borderWidth = '2px' })
    btn.addEventListener('mouseleave', () => { btn.style.borderWidth = '1px' })
  })

  root.querySelector<HTMLButtonElement>('[data-avatar-from-device-btn="1"]')?.addEventListener('click', () => {
    avatarInput?.click()
  })

  const editorProfile = options.state.profileEditorTargetProfileId !== null && options.state.isAdmin
    ? (options.state.profileEditorTargetProfile ?? options.state.profile)
    : options.state.profile
  const avatarGender = editorProfile.gender ?? 'male'
  const avatarFolder = avatarGender === 'female' ? 'female' : 'male'
  const avatarPrefix = avatarGender === 'female' ? 'female-avatar' : 'male-avatar'
  const PRESET_AVATAR_COUNT = 30

  function openPresetAvatarGallery(): void {
    let selectedUrl: string | null = null

    const overlay = document.createElement('div')
    overlay.style.cssText = 'position:fixed;inset:0;z-index:14500;background:rgba(0,0,0,0.88);display:flex;flex-direction:column;font-family:Inter,system-ui,sans-serif;'

    overlay.innerHTML = `
      <div style="flex:0 0 auto;padding:16px 20px;background:#0a0a0a;border-bottom:1px solid rgba(255,255,255,0.10);display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;">
        <div style="font-size:16px;font-weight:900;color:#f8fafc;">Избери аватар</div>
        <div style="display:flex;gap:10px;flex-shrink:0;">
          <button type="button" data-preset-cancel="1" style="height:40px;padding:0 16px;border:1px solid rgba(255,255,255,0.18);border-radius:8px;background:#080808;color:#f8fafc;font-size:13px;font-weight:900;cursor:pointer;">Откажи</button>
          <button type="button" data-preset-apply="1" style="height:40px;padding:0 18px;border:0;border-radius:8px;background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;font-size:13px;font-weight:900;cursor:pointer;opacity:0.45;pointer-events:none;">Приложи</button>
        </div>
      </div>
      <div style="flex:1;overflow-y:auto;padding:24px;" class="gold-scrollbar">
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:12px;max-width:900px;margin:0 auto;">
          ${Array.from({ length: PRESET_AVATAR_COUNT }, (_, i) => {
            const num = String(i + 1).padStart(2, '0')
            const url = `/assets/avatars/${avatarFolder}/${avatarPrefix}-${num}.webp`
            return `<div data-preset-avatar="${url}" style="aspect-ratio:1/1;border-radius:10px;overflow:hidden;border:2px solid rgba(255,255,255,0.10);cursor:pointer;transition:border-color 0.15s;background:#101010;">
              <img src="${url}" alt="" draggable="false" style="width:100%;height:100%;object-fit:cover;display:block;pointer-events:none;">
            </div>`
          }).join('')}
        </div>
      </div>
    `

    document.body.appendChild(overlay)

    const applyBtn = overlay.querySelector<HTMLButtonElement>('[data-preset-apply="1"]')!

    overlay.querySelectorAll<HTMLElement>('[data-preset-avatar]').forEach((tile) => {
      tile.addEventListener('click', () => {
        overlay.querySelectorAll<HTMLElement>('[data-preset-avatar]').forEach((t) => {
          t.style.borderColor = 'rgba(255,255,255,0.10)'
        })
        tile.style.borderColor = '#f4c95b'
        selectedUrl = tile.dataset.presetAvatar ?? null
        applyBtn.style.opacity = '1'
        applyBtn.style.pointerEvents = 'auto'
      })
    })

    overlay.querySelector('[data-preset-cancel="1"]')?.addEventListener('click', () => {
      overlay.remove()
    })

    applyBtn.addEventListener('click', () => {
      if (selectedUrl === null) return
      overlay.remove()
      options.onPresetAvatarApply(selectedUrl)
    })
  }

  root.querySelector<HTMLButtonElement>('[data-avatar-preset-btn="1"]')?.addEventListener('click', () => {
    openPresetAvatarGallery()
  })

  let currentCrop: AvatarCropSelection | null = null

  function openCropOverlay(file: File): void {
    const overlay = document.createElement('div')
    overlay.setAttribute('data-avatar-crop-overlay', '1')
    overlay.style.cssText = [
      'position:fixed;inset:0;z-index:14000;',
      'background:#0a0a0a;',
      'display:flex;flex-direction:column;',
      'font-family:Arial,Helvetica,sans-serif;',
    ].join('')

    overlay.innerHTML = `
      <div style="flex:0 0 auto;padding:14px 20px;background:#0a0a0a;border-bottom:1px solid rgba(255,255,255,0.10);display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;">
        <div style="font-size:14px;font-weight:700;color:rgba(255,255,255,0.80);line-height:1.4;">
          Очертайте с мишката зона от снимката която искате да използвате за аватар.
        </div>
        <div style="display:flex;gap:10px;flex-shrink:0;">
          <button type="button" data-crop-cancel="1" style="height:40px;padding:0 16px;border:1px solid rgba(255,255,255,0.18);border-radius:8px;background:#080808;color:#f8fafc;font-size:13px;font-weight:900;cursor:pointer;">Откажи</button>
          <button type="button" data-crop-confirm="1" style="height:40px;padding:0 16px;border:0;border-radius:8px;background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;font-size:13px;font-weight:900;cursor:pointer;">Потвърди избора</button>
        </div>
      </div>
      <div data-crop-box="1" style="flex:1;position:relative;overflow:hidden;user-select:none;touch-action:none;display:flex;align-items:center;justify-content:center;background:#111;cursor:crosshair;">
        <img data-crop-image="1" alt="" style="max-width:100%;max-height:100%;display:block;object-fit:contain;pointer-events:none;">
        <div data-crop-selection="1" style="position:absolute;display:none;border:2px solid #f4c95b;background:rgba(212,165,32,0.10);box-shadow:0 0 0 9999px rgba(0,0,0,0.54);pointer-events:none;"></div>
      </div>
    `

    document.body.appendChild(overlay)

    const overlayImage = overlay.querySelector<HTMLImageElement>('[data-crop-image="1"]')!
    const overlayBox = overlay.querySelector<HTMLElement>('[data-crop-box="1"]')!
    const overlaySelection = overlay.querySelector<HTMLElement>('[data-crop-selection="1"]')!

    overlayImage.src = URL.createObjectURL(file)

    let startX = 0
    let startY = 0
    let pendingCrop: AvatarCropSelection | null = null

    function clearOverlayCrop(): void {
      pendingCrop = null
      overlaySelection.style.display = 'none'
    }

    function getOverlayPoint(event: PointerEvent): { x: number; y: number } | null {
      const rect = overlayImage.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return null
      const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left))
      const y = Math.max(0, Math.min(rect.height, event.clientY - rect.top))
      return { x, y }
    }

    function drawOverlayCrop(currentX: number, currentY: number): void {
      const rect = overlayImage.getBoundingClientRect()
      const boxRect = overlayBox.getBoundingClientRect()
      const deltaX = currentX - startX
      const deltaY = currentY - startY
      const size = Math.min(Math.abs(deltaX), Math.abs(deltaY))
      if (size < 4) { clearOverlayCrop(); return }
      const dirX = deltaX >= 0 ? 1 : -1
      const dirY = deltaY >= 0 ? 1 : -1
      const displayX = dirX > 0 ? startX : startX - size
      const displayY = dirY > 0 ? startY : startY - size
      const boundedX = Math.max(0, Math.min(rect.width - size, displayX))
      const boundedY = Math.max(0, Math.min(rect.height - size, displayY))
      overlaySelection.style.display = 'block'
      overlaySelection.style.left = `${rect.left - boxRect.left + boundedX}px`
      overlaySelection.style.top = `${rect.top - boxRect.top + boundedY}px`
      overlaySelection.style.width = `${size}px`
      overlaySelection.style.height = `${size}px`
      pendingCrop = {
        x: (boundedX / rect.width) * overlayImage.naturalWidth,
        y: (boundedY / rect.height) * overlayImage.naturalHeight,
        size: (size / rect.width) * overlayImage.naturalWidth,
      }
    }

    overlayBox.addEventListener('pointerdown', (event) => {
      const point = getOverlayPoint(event)
      if (point === null) return
      event.preventDefault()
      overlayBox.setPointerCapture(event.pointerId)
      startX = point.x
      startY = point.y
      drawOverlayCrop(point.x, point.y)
    })

    overlayBox.addEventListener('pointermove', (event) => {
      if (!overlayBox.hasPointerCapture(event.pointerId)) return
      const point = getOverlayPoint(event)
      if (point === null) return
      event.preventDefault()
      drawOverlayCrop(point.x, point.y)
    })

    overlayBox.addEventListener('pointerup', (event) => {
      if (overlayBox.hasPointerCapture(event.pointerId)) {
        overlayBox.releasePointerCapture(event.pointerId)
      }
    })

    overlay.querySelector('[data-crop-confirm="1"]')?.addEventListener('click', () => {
      currentCrop = pendingCrop
      overlay.remove()

      if (currentCrop !== null) {
        _pendingAvatarFile = file
        const crop = currentCrop
        const canvas = document.createElement('canvas')
        canvas.width = 250
        canvas.height = 250
        const ctx = canvas.getContext('2d')
        if (ctx) {
          const img = new Image()
          const objectUrl = URL.createObjectURL(file)
          img.onload = () => {
            ctx.drawImage(img, crop.x, crop.y, crop.size, crop.size, 0, 0, 250, 250)
            const preview = root.querySelector<HTMLElement>('[data-avatar-preview="1"]')
            if (preview) {
              const dataUrl = canvas.toDataURL('image/webp')
              preview.innerHTML = `<img src="${dataUrl}" alt="" style="width:100%;height:100%;object-fit:cover;display:block;">`
            }
            URL.revokeObjectURL(objectUrl)
          }
          img.src = objectUrl
        }
      }
    })

    overlay.querySelector('[data-crop-cancel="1"]')?.addEventListener('click', () => {
      currentCrop = null
      _pendingAvatarFile = null
      avatarInput.value = ''
      const preview = root.querySelector<HTMLElement>('[data-avatar-preview="1"]')
      if (preview) {
        preview.innerHTML = state.profile.avatarUrl
          ? `<img src="${escapeHtml(state.profile.avatarUrl)}" alt="" style="width:100%;height:100%;object-fit:cover;display:block;">`
          : `<span style="opacity:0.4;">?</span>`
      }
      overlay.remove()
    })
  }

  avatarInput.onchange = () => {
    const file = avatarInput.files?.[0] ?? null
    currentCrop = null
    if (!file) return
    if (file.size > 10_000_000) {
      avatarInput.value = ''
      options.onProfileEditorFileError('Снимката трябва да е до 10 МБ.')
      return
    }
    openCropOverlay(file)
  }

  const galleryFileInput = ensurePersistentGalleryInput()

  function getGalleryGrid(): HTMLElement | null {
    return root.querySelector<HTMLElement>('[data-gallery-grid="1"]')
  }

  function addGalleryEmptySlot(): void {
    const grid = getGalleryGrid()
    if (!grid) return
    const slot = document.createElement('div')
    slot.setAttribute('data-gallery-add-slot', '1')
    slot.setAttribute('role', 'button')
    slot.setAttribute('tabindex', '0')
    slot.style.cssText = 'aspect-ratio:1/1;border-radius:8px;border:2px dashed rgba(255,255,255,0.20);background:#101010;display:flex;align-items:center;justify-content:center;cursor:pointer;'
    slot.innerHTML = '<span style="color:rgba(255,255,255,0.40);font-size:28px;font-weight:300;line-height:1;">+</span>'
    slot.addEventListener('click', () => galleryFileInput.click())
    grid.appendChild(slot)
  }

  function openGalleryCropOverlay(file: File): void {
    const overlay = document.createElement('div')
    overlay.style.cssText = 'position:fixed;inset:0;z-index:14000;background:#0a0a0a;display:flex;flex-direction:column;font-family:Arial,Helvetica,sans-serif;'
    overlay.innerHTML = `
      <div style="flex:0 0 auto;padding:14px 20px;background:#0a0a0a;border-bottom:1px solid rgba(255,255,255,0.10);display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;">
        <div style="font-size:14px;font-weight:700;color:rgba(255,255,255,0.80);line-height:1.4;">
          Очертайте с мишката зона от снимката която искате да добавите в галерията.
        </div>
        <div style="display:flex;gap:10px;flex-shrink:0;">
          <button type="button" data-gallery-crop-cancel="1" style="height:40px;padding:0 16px;border:1px solid rgba(255,255,255,0.18);border-radius:8px;background:#080808;color:#f8fafc;font-size:13px;font-weight:900;cursor:pointer;">Откажи</button>
          <button type="button" data-gallery-crop-confirm="1" style="height:40px;padding:0 16px;border:0;border-radius:8px;background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;font-size:13px;font-weight:900;cursor:pointer;">Добави в галерията</button>
        </div>
      </div>
      <div data-gallery-crop-box="1" style="flex:1;position:relative;overflow:hidden;user-select:none;touch-action:none;display:flex;align-items:center;justify-content:center;background:#111;cursor:crosshair;">
        <img data-gallery-crop-image="1" alt="" style="max-width:100%;max-height:100%;display:block;object-fit:contain;pointer-events:none;">
        <div data-gallery-crop-selection="1" style="position:absolute;display:none;border:2px solid #f4c95b;background:rgba(212,165,32,0.10);box-shadow:0 0 0 9999px rgba(0,0,0,0.54);pointer-events:none;"></div>
      </div>
    `
    document.body.appendChild(overlay)

    const overlayImage = overlay.querySelector<HTMLImageElement>('[data-gallery-crop-image="1"]')!
    const overlayBox = overlay.querySelector<HTMLElement>('[data-gallery-crop-box="1"]')!
    const overlaySelection = overlay.querySelector<HTMLElement>('[data-gallery-crop-selection="1"]')!
    overlayImage.src = URL.createObjectURL(file)

    let startX = 0
    let startY = 0
    let pendingCrop: AvatarCropSelection | null = null

    function clearGalleryCrop(): void {
      pendingCrop = null
      overlaySelection.style.display = 'none'
    }

    function getGalleryPoint(event: PointerEvent): { x: number; y: number } | null {
      const rect = overlayImage.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return null
      const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left))
      const y = Math.max(0, Math.min(rect.height, event.clientY - rect.top))
      return { x, y }
    }

    function drawGalleryCrop(currentX: number, currentY: number): void {
      const rect = overlayImage.getBoundingClientRect()
      const boxRect = overlayBox.getBoundingClientRect()
      const deltaX = currentX - startX
      const deltaY = currentY - startY
      const size = Math.min(Math.abs(deltaX), Math.abs(deltaY))
      if (size < 4) { clearGalleryCrop(); return }
      const dirX = deltaX >= 0 ? 1 : -1
      const dirY = deltaY >= 0 ? 1 : -1
      const displayX = dirX > 0 ? startX : startX - size
      const displayY = dirY > 0 ? startY : startY - size
      const boundedX = Math.max(0, Math.min(rect.width - size, displayX))
      const boundedY = Math.max(0, Math.min(rect.height - size, displayY))
      overlaySelection.style.display = 'block'
      overlaySelection.style.left = `${rect.left - boxRect.left + boundedX}px`
      overlaySelection.style.top = `${rect.top - boxRect.top + boundedY}px`
      overlaySelection.style.width = `${size}px`
      overlaySelection.style.height = `${size}px`
      pendingCrop = {
        x: (boundedX / rect.width) * overlayImage.naturalWidth,
        y: (boundedY / rect.height) * overlayImage.naturalHeight,
        size: (size / rect.width) * overlayImage.naturalWidth,
      }
    }

    overlayBox.addEventListener('pointerdown', (event) => {
      const point = getGalleryPoint(event)
      if (point === null) return
      event.preventDefault()
      overlayBox.setPointerCapture(event.pointerId)
      startX = point.x
      startY = point.y
      drawGalleryCrop(point.x, point.y)
    })

    overlayBox.addEventListener('pointermove', (event) => {
      if (!overlayBox.hasPointerCapture(event.pointerId)) return
      const point = getGalleryPoint(event)
      if (point === null) return
      event.preventDefault()
      drawGalleryCrop(point.x, point.y)
    })

    overlayBox.addEventListener('pointerup', (event) => {
      if (overlayBox.hasPointerCapture(event.pointerId)) overlayBox.releasePointerCapture(event.pointerId)
    })

    overlay.querySelector('[data-gallery-crop-confirm="1"]')?.addEventListener('click', () => {
      if (pendingCrop === null) { overlay.remove(); return }
      const crop = pendingCrop
      const canvas = document.createElement('canvas')
      canvas.width = 800
      canvas.height = 800
      const ctx = canvas.getContext('2d')
      if (!ctx) { overlay.remove(); return }
      const img = new Image()
      const objectUrl = URL.createObjectURL(file)
      img.onload = () => {
        ctx.drawImage(img, crop.x, crop.y, crop.size, crop.size, 0, 0, 800, 800)
        const dataUrl = canvas.toDataURL('image/webp', 0.92)
        URL.revokeObjectURL(objectUrl)
        const item = { file, crop, dataUrl }
        _pendingGalleryItems.push(item)
        const grid = getGalleryGrid()
        if (grid) {
          const div = document.createElement('div')
          div.style.cssText = 'position:relative;aspect-ratio:1/1;border-radius:8px;overflow:hidden;border:1px solid rgba(212,165,32,0.30);background:#101010;'
          const previewImg = document.createElement('img')
          previewImg.src = dataUrl
          previewImg.alt = ''
          previewImg.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;'
          const removeBtn = document.createElement('button')
          removeBtn.type = 'button'
          removeBtn.style.cssText = 'position:absolute;top:4px;right:4px;width:26px;height:26px;border:1px solid rgba(248,113,113,0.56);border-radius:999px;background:rgba(12,12,12,0.86);color:#fecaca;font-size:16px;font-weight:900;line-height:1;cursor:pointer;'
          removeBtn.textContent = '×'
          removeBtn.addEventListener('click', () => {
            const idx = _pendingGalleryItems.indexOf(item)
            if (idx !== -1) _pendingGalleryItems.splice(idx, 1)
            div.remove()
            addGalleryEmptySlot()
          })
          div.appendChild(previewImg)
          div.appendChild(removeBtn)
          const firstSlot = grid.querySelector<HTMLElement>('[data-gallery-add-slot]')
          if (firstSlot) {
            grid.insertBefore(div, firstSlot)
            firstSlot.remove()
          } else {
            grid.appendChild(div)
          }
        }
        overlay.remove()
      }
      img.src = objectUrl
    })

    overlay.querySelector('[data-gallery-crop-cancel="1"]')?.addEventListener('click', () => {
      overlay.remove()
    })
  }

  root.querySelectorAll<HTMLElement>('[data-gallery-add-slot]').forEach((slot) => {
    slot.addEventListener('click', () => galleryFileInput.click())
  })

  galleryFileInput.onchange = () => {
    const file = galleryFileInput.files?.[0] ?? null
    if (!file) return
    galleryFileInput.value = ''
    if (file.size > 10_000_000) {
      options.onProfileEditorFileError('Снимката трябва да е до 10 МБ.')
      return
    }
    openGalleryCropOverlay(file)
  }

  // Repopulate gallery previews from module-level state after re-render
  if (_pendingGalleryItems.length > 0) {
    const grid = getGalleryGrid()
    if (grid) {
      grid.querySelectorAll<HTMLElement>('[data-gallery-add-slot]').forEach((s) => s.remove())
      for (const item of _pendingGalleryItems) {
        const div = document.createElement('div')
        div.style.cssText = 'position:relative;aspect-ratio:1/1;border-radius:8px;overflow:hidden;border:1px solid rgba(212,165,32,0.30);background:#101010;'
        const previewImg = document.createElement('img')
        previewImg.src = item.dataUrl
        previewImg.alt = ''
        previewImg.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;'
        const removeBtn = document.createElement('button')
        removeBtn.type = 'button'
        removeBtn.style.cssText = 'position:absolute;top:4px;right:4px;width:26px;height:26px;border:1px solid rgba(248,113,113,0.56);border-radius:999px;background:rgba(12,12,12,0.86);color:#fecaca;font-size:16px;font-weight:900;line-height:1;cursor:pointer;'
        removeBtn.textContent = '×'
        const capturedItem = item
        removeBtn.addEventListener('click', () => {
          const idx = _pendingGalleryItems.indexOf(capturedItem)
          if (idx !== -1) _pendingGalleryItems.splice(idx, 1)
          div.remove()
          addGalleryEmptySlot()
        })
        div.appendChild(previewImg)
        div.appendChild(removeBtn)
        grid.appendChild(div)
      }
      addGalleryEmptySlot()
    }
  }

  function dataUrlToFile(dataUrl: string, filename: string): File {
    const parts = dataUrl.split(',')
    const mime = parts[0].match(/:(.*?);/)![1]
    const binaryStr = atob(parts[1])
    const bytes = new Uint8Array(binaryStr.length)
    for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i)
    return new File([bytes], filename, { type: mime })
  }

  root
    .querySelector<HTMLFormElement>('[data-lobby-profile-editor-form="1"]')
    ?.addEventListener('submit', (event) => {
      event.preventDefault()
      const galleryFiles = _pendingGalleryItems.map((item, i) => dataUrlToFile(item.dataUrl, `gallery-${i}.webp`))
      options.onProfileEditSubmit(
        _pendingAvatarFile ?? null,
        currentCrop,
        galleryFiles,
      )
    })

  root
    .querySelector<HTMLButtonElement>('[data-lobby-profile-name-change-submit="1"]')
    ?.addEventListener('click', () => {
      const input = root.querySelector<HTMLInputElement>('input[name="paidDisplayName"]')
      const validation = validateProfileDisplayName(input?.value ?? '')
      const hint = root.querySelector<HTMLElement>('[data-name-hint="namechange"]')
      if (!validation.ok) {
        if (hint) {
          hint.textContent = validation.message
          hint.style.color = '#f87171'
        }
        return
      }
      if (input) input.value = validation.canonicalDisplayName
      options.onProfileNameChangeSubmit(validation.canonicalDisplayName)
    })

  const costEl = root.querySelector<HTMLElement>('[data-name-change-cost="1"]')
  if (costEl !== null && state.profileNameChangeSuccessAmount !== null) {
    const target = state.profileNameChangeSuccessAmount
    const duration = 900
    const startTime = performance.now()
    const el = costEl
    function tickNameChangeCost(now: number): void {
      const t = Math.min((now - startTime) / duration, 1)
      const eased = 1 - Math.pow(1 - t, 3)
      el.textContent = `-${Math.round(eased * target).toLocaleString('bg-BG')}`
      if (t < 1) requestAnimationFrame(tickNameChangeCost)
    }
    requestAnimationFrame(tickNameChangeCost)
  }

  root.querySelectorAll<HTMLButtonElement>('[data-lobby-gallery-delete]').forEach((button) => {
    button.addEventListener('click', () => {
      const imageId = button.dataset.lobbyGalleryDelete?.trim() ?? ''

      if (imageId.length > 0) {
        options.onProfileGalleryDelete(imageId)
      }
    })
  })

  function attachNameAvailabilityCheck(
    input: HTMLInputElement,
    hintEl: HTMLElement,
  ): void {
    let timer: ReturnType<typeof setTimeout> | null = null
    let lastChecked = ''

    const setHint = (text: string, color = ''): void => {
      hintEl.textContent = text
      hintEl.title = text
      hintEl.style.color = color
    }

    input.addEventListener('blur', () => {
      const validation = validateProfileDisplayName(input.value)
      if (validation.ok) {
        input.value = validation.canonicalDisplayName
      }
    })

    input.addEventListener('input', () => {
      const validation = validateProfileDisplayName(input.value)

      if (timer !== null) clearTimeout(timer)

      if (!validation.ok) {
        if (validation.reason === 'length' && validation.canonicalCandidate.length < 3) {
          setHint('')
        } else {
          setHint(validation.message, '#f87171')
        }
        lastChecked = ''
        return
      }

      const value = getProfileDisplayNameAvailabilityQuery(input.value)
      if (value === null) {
        lastChecked = ''
        return
      }

      if (value === lastChecked) return

      timer = setTimeout(async () => {
        lastChecked = value
        try {
          const res = await fetch(
            `${options.apiBaseUrl}/api/profile/check-name?name=${encodeURIComponent(value)}`,
          )
          const data = await res.json() as { available: boolean }
          const currentValidation = validateProfileDisplayName(input.value)
          if (!currentValidation.ok || currentValidation.canonicalDisplayName !== value) return
          if (data.available) {
            setHint('✓ Свободно', '#4ade80')
          } else {
            setHint('✕ Заето', '#f87171')
          }
        } catch {
          // ignore network errors silently
        }
      }, 200)
    })
  }

  function showAuthError(message: string): void {
    const el = root.querySelector<HTMLElement>('[data-lobby-auth-error="1"]')
    if (el) {
      el.textContent = message
      el.style.display = ''
    }
  }

  ;(['register', 'namechange'] as const).forEach((key) => {
    const input = root.querySelector<HTMLInputElement>(`[data-name-check-input="${key}"]`)
    const hint = root.querySelector<HTMLElement>(`[data-name-hint="${key}"]`)
    if (input && hint) attachNameAvailabilityCheck(input, hint)
  })

  root
    .querySelector<HTMLButtonElement>('[data-lobby-auth-modal-close="1"]')
    ?.addEventListener('click', options.onAuthModalClose)

  root
    .querySelector<HTMLElement>('[data-lobby-auth-modal-backdrop="1"]')
    ?.addEventListener('click', options.onAuthModalClose)

  // Click anywhere outside the dialog panel closes the modal.
  // stopPropagation on the dialog prevents clicks inside it from bubbling up.
  root
    .querySelector<HTMLElement>('[data-lobby-auth-modal-root="1"]')
    ?.addEventListener('click', options.onAuthModalClose)
  root
    .querySelector<HTMLElement>('[data-lobby-auth-modal-root="1"] [role="dialog"]')
    ?.addEventListener('click', (e) => e.stopPropagation())

  root
    .querySelector<HTMLElement>('[data-guest-trial-modal-root="1"] [role="dialog"]')
    ?.addEventListener('click', (e) => e.stopPropagation())

  attachGuestTrialPopupEventListeners(root, {
    onPlayClick: options.onGuestTrialPlayClick,
    onRegisterClick: options.onGuestTrialRegisterClick,
    onLoginClick: options.onGuestTrialLoginClick,
    onClose: options.onGuestTrialClose,
  })

  root
    .querySelector<HTMLElement>('[data-guest-locked-stake-modal-root="1"] [role="dialog"]')
    ?.addEventListener('click', (e) => e.stopPropagation())

  attachGuestLockedStakePopupEventListeners(root, {
    onPlay5000Click: options.onGuestLockedStakePlay5000Click,
    onRegisterClick: options.onGuestLockedStakeRegisterClick,
    onLoginClick: options.onGuestLockedStakeLoginClick,
    onClose: options.onGuestLockedStakeClose,
  })

  root
    .querySelector<HTMLElement>('[data-level-locked-stake-modal-root="1"] [role="dialog"]')
    ?.addEventListener('click', (e) => e.stopPropagation())

  attachLevelLockedStakePopupEventListeners(root, {
    onViewProfileClick: options.onLevelLockedStakeViewProfileClick,
    onClose: options.onLevelLockedStakeClose,
  })

  root
    .querySelector<HTMLButtonElement>('[data-lobby-auth-register-button="1"]')
    ?.addEventListener('click', () => options.onAuthModeChange('register'))

  root
    .querySelector<HTMLButtonElement>('[data-lobby-auth-login-button="1"]')
    ?.addEventListener('click', () => options.onAuthModeChange('login'))

  root.querySelectorAll<HTMLButtonElement>('[data-lobby-auth-login="1"]')
    .forEach((btn) => btn.addEventListener('click', () => options.onAuthModeChange('login')))

  root.querySelectorAll<HTMLButtonElement>('[data-lobby-auth-register="1"]')
    .forEach((btn) => btn.addEventListener('click', () => options.onAuthModeChange('register')))

  root.querySelectorAll<HTMLButtonElement>('[data-lobby-auth-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      const mode = button.dataset.lobbyAuthMode
      if (mode === 'login' || mode === 'register' || mode === 'forgot-password') {
        options.onAuthModeChange(mode)
      }
    })
  })

  root.querySelectorAll<HTMLFormElement>('[data-lobby-auth-form]').forEach((form) => {
    const emailInput = form.querySelector<HTMLInputElement>('input[type="email"]')
    if (emailInput) {
      emailInput.addEventListener('invalid', () => {
        emailInput.setCustomValidity('Моля въведете валиден e-mail.')
      })
      emailInput.addEventListener('input', () => {
        emailInput.setCustomValidity('')
      })
    }

    form.querySelectorAll<HTMLButtonElement>('[data-toggle-password]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const fieldName = btn.dataset.togglePassword ?? ''
        const input = form.querySelector<HTMLInputElement>(`input[name="${fieldName}"]`)
        if (!input) return
        const isHidden = input.type === 'password'
        input.type = isHidden ? 'text' : 'password'
        btn.style.color = isHidden ? 'rgba(212,165,32,0.8)' : 'rgba(255,255,255,0.4)'
      })
    })

    form.querySelectorAll<HTMLInputElement>('.belot-gender-radio').forEach((radio) => {
      radio.addEventListener('change', () => {
        form.querySelectorAll<HTMLElement>('[data-gender-option]').forEach((opt) => {
          const isSelected = opt.dataset.genderOption === radio.value && radio.checked
          opt.style.borderColor = isSelected ? '#d4a520' : 'rgba(212,165,32,0.34)'
          opt.style.background = isSelected ? 'rgba(212,165,32,0.10)' : '#050505'
          opt.style.color = isSelected ? '#f8fafc' : 'rgba(255,255,255,0.72)'
        })
      })
    })

    form.addEventListener('submit', (event) => {
      event.preventDefault()
      const data = new FormData(form)
      const email = String(data.get('email') ?? '')
      const password = String(data.get('password') ?? '')

      if (form.dataset.lobbyAuthForm === 'register') {
        const displayNameInput = form.querySelector<HTMLInputElement>('input[name="displayName"]')
        const displayNameValidation = validateProfileDisplayName(displayNameInput?.value ?? '')
        if (!displayNameValidation.ok) {
          showAuthError(displayNameValidation.message)
          return
        }
        if (displayNameInput) displayNameInput.value = displayNameValidation.canonicalDisplayName

        const confirmPassword = String(data.get('confirmPassword') ?? '')
        if (password !== confirmPassword) {
          showAuthError('Паролите не съвпадат.')
          return
        }
        const rawGender = String(data.get('gender') ?? '')
        const gender = rawGender === 'male' || rawGender === 'female' ? rawGender : null
        if (gender === null) {
          showAuthError('Моля избери пол.')
          return
        }
        options.onRegisterSubmit(displayNameValidation.canonicalDisplayName, email, password, gender)
        return
      }

      options.onLoginSubmit(email, password)
    })
  })

  // ─── Forgot-password form ───────────────────────────────────────────────────
  const forgotForm = root.querySelector<HTMLFormElement>('[data-lobby-forgot-form="1"]')
  if (forgotForm) {
    forgotForm.addEventListener('submit', (e) => {
      e.preventDefault()
      const data = new FormData(forgotForm)
      const email = String(data.get('email') ?? '').trim()
      options.onForgotPasswordSubmit?.(email)
    })
  }

  root.querySelector<HTMLElement>('[data-lobby-daily-rewards-card="1"]')
    ?.addEventListener('click', options.onDailyRewardsOpen)

  root.querySelector<HTMLButtonElement>('[data-daily-rewards-close="1"]')
    ?.addEventListener('click', options.onDailyRewardsClose)

  root.querySelector<HTMLElement>('[data-daily-rewards-backdrop="1"]')
    ?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) options.onDailyRewardsClose()
    })

  root.querySelectorAll<HTMLButtonElement>('[data-daily-reward-claim]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tierId = btn.dataset.dailyRewardClaim?.trim() ?? ''
      if (tierId) options.onDailyRewardClaim(tierId)
    })
  })

  root.querySelector<HTMLFormElement>('[data-admin-daily-reward-form="1"]')
    ?.addEventListener('submit', (event) => {
      event.preventDefault()
      const form = event.currentTarget as HTMLFormElement
      const data = new FormData(form)
      const amount = Number(data.get('amount') ?? 0)
      if (amount > 0) {
        form.reset()
        options.onAdminDailyRewardAdd(amount)
      }
    })

  root.querySelectorAll<HTMLButtonElement>('[data-admin-daily-reward-remove]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tierId = btn.dataset.adminDailyRewardRemove?.trim() ?? ''
      if (tierId) options.onAdminDailyRewardRemove(tierId)
    })
  })

  root.querySelector<HTMLElement>('[data-lobby-private-rooms-card="1"]')
    ?.addEventListener('click', options.onPrivateRoomsOpen)

  root.querySelector<HTMLElement>('[data-lobby-rules-card="1"]')
    ?.addEventListener('click', (e) => {
      if (shouldHandleSpaLinkClick(e as MouseEvent)) {
        e.preventDefault()
        options.onRulesOpen()
      }
    })

  root.querySelector<HTMLElement>('[data-lobby-strategy-card="1"]')
    ?.addEventListener('click', (e) => {
      if (shouldHandleSpaLinkClick(e as MouseEvent)) {
        e.preventDefault()
        options.onStrategyOpen()
      }
    })

  root.querySelector<HTMLButtonElement>('[data-private-rooms-close="1"]')
    ?.addEventListener('click', options.onPrivateRoomsClose)

  root.querySelector<HTMLButtonElement>('[data-private-rooms-create-open="1"]')
    ?.addEventListener('click', options.onPrivateRoomsCreateOpen)

  root.querySelector<HTMLButtonElement>('[data-private-rooms-create-close="1"]')
    ?.addEventListener('click', options.onPrivateRoomsCreateClose)

  root.querySelector<HTMLElement>('[data-private-rooms-create-backdrop="1"]')
    ?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) options.onPrivateRoomsCreateClose()
    })

  root.querySelectorAll<HTMLButtonElement>('[data-private-rooms-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.privateRoomsTab as 'all' | 'mine'
      if (tab === 'all' || tab === 'mine') options.onPrivateRoomsTabChange(tab)
    })
  })

  root.querySelector<HTMLFormElement>('[data-private-room-create-form="1"]')
    ?.addEventListener('submit', (e) => {
      e.preventDefault()
      const form = e.currentTarget as HTMLFormElement
      const data = new FormData(form)
      const stake = Number(data.get('stake') ?? 5000) as MatchStake
      const isLocked = (data.get('isLocked') ?? null) !== null
      options.onPrivateRoomCreate(stake, isLocked)
    })

  root.querySelectorAll<HTMLButtonElement>('[data-private-room-join]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.privateRoomJoin?.trim() ?? ''
      if (id) options.onPrivateRoomJoin(id)
    })
  })

  root.querySelector<HTMLButtonElement>('[data-private-room-leave="1"]')
    ?.addEventListener('click', options.onPrivateRoomLeave)

  root.querySelector<HTMLButtonElement>('#invite-friends-open')
    ?.addEventListener('click', options.onInviteFriendsOpen)

  root.querySelector<HTMLButtonElement>('#invite-friends-close')
    ?.addEventListener('click', options.onInviteFriendsClose)

  root.querySelector<HTMLButtonElement>('#invite-friends-overlay')
    ?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) options.onInviteFriendsClose()
    })

  root.querySelector<HTMLButtonElement>('#invite-friends-submit')
    ?.addEventListener('click', () => {
      const checkboxes = root.querySelectorAll<HTMLInputElement>('[data-invite-friend-id]:checked')
      const toProfiles: Array<{ profileId: string; displayName: string }> = []
      checkboxes.forEach((cb) => {
        const profileId = cb.dataset.inviteFriendId?.trim() ?? ''
        const displayName = cb.dataset.inviteFriendName?.trim() ?? ''
        if (profileId && displayName) toProfiles.push({ profileId, displayName })
      })
      if (toProfiles.length > 0) {
        options.onPrivateRoomInvite(toProfiles)
        options.onInviteFriendsClose()
      }
    })

  root.querySelectorAll<HTMLButtonElement>('[data-private-room-invite-accept]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const inviteId = btn.dataset.privateRoomInviteAccept?.trim() ?? ''
      if (inviteId) options.onPrivateRoomInviteAccept(inviteId)
    })
  })

  root.querySelectorAll<HTMLButtonElement>('[data-private-room-invite-decline]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const inviteId = btn.dataset.privateRoomInviteDecline?.trim() ?? ''
      if (inviteId) options.onPrivateRoomInviteDecline(inviteId)
    })
  })

  root.querySelector<HTMLButtonElement>('[data-leave-pr-confirm="1"]')
    ?.addEventListener('click', options.onLeavePrivateRoomAndMatchmakeConfirm)

  root.querySelector<HTMLButtonElement>('[data-leave-pr-cancel="1"]')
    ?.addEventListener('click', options.onLeavePrivateRoomAndMatchmakeCancel)

  if (root.querySelector('[data-private-room-info-toast="1"]')) {
    if (privateRoomInfoDismissTimer !== null) clearTimeout(privateRoomInfoDismissTimer)
    privateRoomInfoDismissTimer = setTimeout(() => {
      privateRoomInfoDismissTimer = null
      options.onPrivateRoomInfoDismiss()
    }, 3000)
  } else {
    if (privateRoomInfoDismissTimer !== null) {
      clearTimeout(privateRoomInfoDismissTimer)
      privateRoomInfoDismissTimer = null
    }
  }

  if (inviteCountdownTimer !== null) {
    clearInterval(inviteCountdownTimer)
    inviteCountdownTimer = null
  }
  if (state.privateRoomInvite) {
    inviteCountdownTimer = setInterval(() => {
      const countdownEl = document.getElementById('pr-invite-countdown')
      const progressEl = document.getElementById('pr-invite-progress')
      if (!countdownEl || !progressEl || !state.privateRoomInvite) {
        if (inviteCountdownTimer !== null) {
          clearInterval(inviteCountdownTimer)
          inviteCountdownTimer = null
        }
        return
      }
      const secs = Math.max(0, Math.ceil((state.privateRoomInvite.expiresAt - Date.now()) / 1000))
      countdownEl.textContent = `${secs}с`
      progressEl.style.width = `${Math.round((secs / 60) * 100)}%`
    }, 1000)
  }

  const newScrollEl = root.querySelector<HTMLElement>('[data-lobby-screen-root="1"]')
  if (newScrollEl && savedScrollTop > 0) {
    newScrollEl.scrollTop = savedScrollTop
  }

  if (wasSearchFocused) {
    const newSearchEl = root.querySelector<HTMLInputElement>('[data-lobby-players-search="1"]')
    if (newSearchEl) {
      newSearchEl.focus()
      if (savedSearchCaret !== null) {
        newSearchEl.setSelectionRange(savedSearchCaret, savedSearchCaret)
      }
    }
  }

  cancelAnimationFrame(stakesAnimFrame)

  const stakesScrollEl = root.querySelector<HTMLElement>('[data-lobby-stakes-scroll="1"]')
  if (stakesScrollEl) {
    const allStakeCards = Array.from(stakesScrollEl.querySelectorAll<HTMLElement>('[data-lobby-stake-card]'))
    if (allStakeCards.length > 0) {
      if (isPhoneLayout) {
        stakesScrollEl.scrollLeft = 0
      } else {
        const playerLevel = state.profile.level ?? 1
        const enabledRooms = state.matchRooms.filter((r) => r.isEnabled)
        const highestUnlockedIndex = enabledRooms.reduce((best, room, i) => {
          if (playerLevel < room.minLevel) {
            return best
          }

          return best < 0 || room.stakeAmount > enabledRooms[best].stakeAmount ? i : best
        }, -1)
        stakesFirstCardIndex = highestUnlockedIndex >= 4 ? highestUnlockedIndex - 4 : 0
        const idx = Math.max(0, Math.min(stakesFirstCardIndex, allStakeCards.length - 1))
        const maxScroll = Math.max(0, stakesScrollEl.scrollWidth - stakesScrollEl.clientWidth)
        stakesScrollEl.scrollLeft = Math.max(0, Math.min(allStakeCards[idx].offsetLeft - 2, maxScroll))
      }
    }
  }

  root.querySelector<HTMLFormElement>('[data-support-send-form="1"]')
    ?.addEventListener('submit', (e) => {
      e.preventDefault()
      const form = e.currentTarget as HTMLFormElement
      const data = new FormData(form)
      const body = String(data.get('body') ?? '').trim()
      if (body.length > 0) {
        options.onSupportSend(body)
        form.reset()
      }
    })

  root.querySelector<HTMLFormElement>('[data-guest-contact-form="1"]')
    ?.addEventListener('submit', (e) => {
      e.preventDefault()
      const form = e.currentTarget as HTMLFormElement
      const data = new FormData(form)

      options.onGuestContactSubmit({
        name: String(data.get('name') ?? '').trim(),
        email: String(data.get('email') ?? '').trim(),
        subject: String(data.get('subject') ?? '').trim(),
        message: String(data.get('message') ?? '').trim(),
        website: String(data.get('website') ?? '').trim(),
      })
    })

  root.querySelectorAll<HTMLButtonElement>('[data-admin-support-conv]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const profileId = btn.dataset.adminSupportConv?.trim() ?? ''
      if (profileId) options.onAdminSupportConversationClick(profileId)
    })
  })

  root.querySelectorAll<HTMLFormElement>('[data-admin-support-reply-form]').forEach((form) => {
    form.addEventListener('submit', (e) => {
      e.preventDefault()
      const profileId = form.dataset.adminSupportReplyForm?.trim() ?? ''
      const data = new FormData(form)
      const body = String(data.get('body') ?? '').trim()
      if (profileId && body.length > 0) {
        options.onAdminSupportReply(profileId, body)
        form.reset()
      }
    })
  })

  root.querySelectorAll<HTMLButtonElement>('[data-admin-support-delete]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const profileId = btn.dataset.adminSupportDelete?.trim() ?? ''
      if (profileId) options.onAdminSupportDeleteClick(profileId)
    })
  })

  root.querySelectorAll<HTMLButtonElement>('[data-admin-support-delete-confirm]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const profileId = btn.dataset.adminSupportDeleteConfirm?.trim() ?? ''
      if (profileId) options.onAdminSupportDeleteConfirm(profileId)
    })
  })

  root.querySelectorAll<HTMLButtonElement>('[data-admin-guest-contact-read]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const messageId = btn.dataset.adminGuestContactRead?.trim() ?? ''
      if (messageId) options.onAdminGuestContactMessageRead(messageId)
    })
  })

  root.querySelector<HTMLButtonElement>('[data-admin-support-delete-cancel="1"]')
    ?.addEventListener('click', () => options.onAdminSupportDeleteCancel())

  root.querySelector<HTMLButtonElement>('[data-support-delete-click="1"]')
    ?.addEventListener('click', () => options.onSupportDeleteClick())

  root.querySelector<HTMLButtonElement>('[data-support-delete-confirm="1"]')
    ?.addEventListener('click', () => options.onSupportDeleteConfirm())

  root.querySelector<HTMLButtonElement>('[data-support-delete-cancel="1"]')
    ?.addEventListener('click', () => options.onSupportDeleteCancel())

  root.querySelectorAll<HTMLButtonElement>('[data-history-window]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const w = btn.dataset.historyWindow
      if (w === '1h' || w === '24h' || w === '7d') {
        options.onAdminHistoryWindowChange(w)
      }
    })
  })

  root.querySelectorAll<HTMLButtonElement>('[data-admin-visitors-period]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const period = btn.dataset.adminVisitorsPeriod ?? ''
      history.pushState(null, '', `/admin/visitors?period=${encodeURIComponent(period)}`)
      options.onAdminVisitorsPeriodClick?.(period)
    })
  })

  root.querySelector<HTMLButtonElement>('[data-admin-visitors-back="1"]')?.addEventListener('click', () => {
    options.onAdminVisitorsBackClick?.()
  })

  root.querySelectorAll<HTMLButtonElement>('[data-admin-visitors-type]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const t = btn.dataset.adminVisitorsType ?? 'all'
      options.onAdminVisitorsTypeChange?.(t as import('../network/createGameServerClient').VisitorListType)
    })
  })

  root.querySelectorAll<HTMLButtonElement>('[data-admin-visitors-device]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const d = btn.dataset.adminVisitorsDevice ?? 'all'
      options.onAdminVisitorsDeviceChange?.(d as import('../network/createGameServerClient').VisitorDeviceFilter)
    })
  })

  root.querySelectorAll<HTMLButtonElement>('[data-admin-visitors-os]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const o = btn.dataset.adminVisitorsOs ?? 'all'
      options.onAdminVisitorsOsChange?.(o as import('../network/createGameServerClient').VisitorOsFilter)
    })
  })

  root.querySelectorAll<HTMLButtonElement>('[data-admin-visitors-page]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const pg = parseInt(btn.dataset.adminVisitorsPage ?? '0', 10)
      options.onAdminVisitorsPageChange?.(isNaN(pg) ? 0 : pg)
    })
  })

  root.querySelectorAll<HTMLButtonElement>('[data-admin-visitors-view]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const v = btn.dataset.adminVisitorsView ?? 'visitors'
      options.onAdminVisitorsViewChange?.(v as import('../network/createGameServerClient').AdminVisitorsView)
    })
  })

  attachAdminPaymentsPanelHandlers(root, {
    onBack: () => { options.onAdminPaymentsBackClick?.() },
    onPeriodChange: (period) => { options.onAdminPaymentsPeriodChange?.(period) },
    onPageChange: (offset) => { options.onAdminPaymentsPageChange?.(offset) },
    onDetailOpen: (purchaseId) => { options.onAdminPaymentsDetailOpen?.(purchaseId) },
  })

  attachAdminPaymentDetailHandlers(root, {
    onBack: () => { options.onAdminPaymentDetailBack?.() },
  })

  root.querySelectorAll<HTMLButtonElement>('[data-admin-payments-open]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const p = btn.dataset.adminPaymentsOpen ?? 'today'
      options.onAdminPaymentsOpen?.(p as AdminPaymentPeriod)
    })
  })

  for (const id of ['support-popup-messages-scroll', 'support-admin-messages-scroll']) {
    const el = document.getElementById(id)
    if (el) el.scrollTop = el.scrollHeight
  }

  const chatScroll = root.querySelector<HTMLElement>('[data-chat-messages-scroll="1"]')
  if (chatScroll) chatScroll.scrollTop = chatScroll.scrollHeight
}
