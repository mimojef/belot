import {
  renderMatchmakingRoomScreen,
  type MatchmakingRoomPlayer,
} from './renderMatchmakingRoomScreen'
import { showStakeDeductionEffect } from '../activeRoom/renderStakeDeductionEffect'
import {
  renderLobbyScreen,
  syncProfilePopup,
  clearProfileEditorPendingState,
  type AvatarCropSelection,
  type LobbyAuthModalMode,
  type LobbyScreenState,
  type ProfilePopupCallbacks,
} from './renderLobbyScreen'
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
  MatchFoundMessage,
  MatchRoomSnapshot,
  MatchStake,
  MissionTemplateInput,
  MissionTemplateSnapshot,
  PlayerMissionProgressSnapshot,
  PlayerPublicProfileSnapshot,
  PrivateRoomSnapshot,
  RoomSeatSnapshot,
  ServerMessage,
  SupportMessageSnapshot,
  SupportConversationSnapshot,
} from '../network/createGameServerClient'

export type LobbyFlowScreen =
  | 'lobby'
  | 'players'
  | 'leaderboards'
  | 'shop'
  | 'admin'
  | 'admin-info'
  | 'matchmaking-room'
  | 'private-rooms'
  | 'support'
export type LobbySocialScreen = LobbyFlowScreen | 'friends' | 'chat'

export type LobbyAuthSession = {
  account: {
    role: string
  }
  profile: PlayerPublicProfileSnapshot
}

export type CreateLobbyFlowControllerOptions = {
  root: HTMLElement
  joinMatchmaking: (stake: MatchStake, displayName?: string) => void
  leaveMatchmaking: () => void
  onMatchFound: (message: MatchFoundMessage, stakeAlreadyShown: boolean) => void
  tryUnlockDocumentAudio?: () => void
  getAuthSession?: () => LobbyAuthSession | null
  getSignupBonusYellowCoins?: () => number
  getProfileNameChangePrice?: () => number
  getOnlinePlayersCount?: () => number
  getApiBaseUrl?: () => string
  getIsInGame?: () => boolean
  onLoginSubmit?: (email: string, password: string) => Promise<string | null>
  onRegisterSubmit?: (
    displayName: string,
    email: string,
    password: string,
    gender: 'male' | 'female' | null,
  ) => Promise<string | null>
  onProfileEditSubmit?: (
    avatarFile: File | null,
    avatarCrop: AvatarCropSelection | null,
    galleryFiles: File[],
  ) => Promise<string | null>
  onPresetAvatarApply?: (avatarUrl: string) => Promise<string | null>
  onProfileGalleryDelete?: (imageId: string) => Promise<string | null>
  onProfileNameChangeSubmit?: (displayName: string) => Promise<string | null>
  onChangePasswordSubmit?: (currentPassword: string, newPassword: string) => Promise<string | null>
  onPlayersLoad?: () => Promise<
    | { ok: true; players: PlayerPublicProfileSnapshot[] }
    | { ok: false; message: string }
  >
  onLeaderboardsLoad?: () => Promise<
    | { ok: true; leaderboards: LeaderboardsSnapshot }
    | { ok: false; message: string }
  >
  onLobbyPackagesLoad?: () => Promise<
    | { ok: true; packages: CoinPackageSnapshot[] }
    | { ok: false; message: string }
  >
  onShopPackagesLoad?: () => Promise<
    | { ok: true; packages: CoinPackageSnapshot[] }
    | { ok: false; message: string }
  >
  onShopPurchasesLoad?: () => Promise<
    | { ok: true; purchases: CoinPurchaseSnapshot[] }
    | { ok: false; message: string }
  >
  onShopPurchaseStart?: (packageId: string) => Promise<
    | { ok: true; purchases: CoinPurchaseSnapshot[]; message: string }
    | { ok: false; message: string }
  >
  onAdminStatsLoad?: () => Promise<
    | { ok: true; stats: AdminStatsSnapshot }
    | { ok: false; message: string }
  >
  onAdminDailyRewardsLoad?: () => Promise<
    | { ok: true; activeTiers: DailyRewardTierSnapshot[]; stagedTiers: DailyRewardTierSnapshot[] }
    | { ok: false; message: string }
  >
  onAdminDailyRewardAdd?: (yellowCoinsAmount: number) => Promise<
    | { ok: true; activeTiers: DailyRewardTierSnapshot[]; stagedTiers: DailyRewardTierSnapshot[] }
    | { ok: false; message: string }
  >
  onAdminDailyRewardRemove?: (tierId: string) => Promise<
    | { ok: true; activeTiers: DailyRewardTierSnapshot[]; stagedTiers: DailyRewardTierSnapshot[] }
    | { ok: false; message: string }
  >
  onDailyRewardsLoad?: () => Promise<
    | { ok: true; tiers: DailyRewardTierSnapshot[] }
    | { ok: false; message: string }
  >
  onDailyRewardClaim?: (tierId: string) => Promise<
    | { ok: true; yellowCoinsAwarded: number; newBalance: number | null; tiers: DailyRewardTierSnapshot[] }
    | { ok: false; message: string }
  >
  onAdminSettingsLoad?: () => Promise<
    | { ok: true; settings: AdminSettingsSnapshot }
    | { ok: false; message: string }
  >
  onAdminSettingsSubmit?: (
    settings: AdminSettingsSnapshot,
  ) => Promise<
    | { ok: true; settings: AdminSettingsSnapshot }
    | { ok: false; message: string }
  >
  onAdminCoinPackagesLoad?: () => Promise<
    | { ok: true; packages: CoinPackageSnapshot[] }
    | { ok: false; message: string }
  >
  onAdminCoinPackageSubmit?: (
    input: CoinPackageInput,
  ) => Promise<
    | { ok: true; packages: CoinPackageSnapshot[] }
    | { ok: false; message: string }
  >
  onAdminCoinPackageStatusChange?: (
    packageId: string,
    status: CoinPackageStatus,
  ) => Promise<
    | { ok: true; packages: CoinPackageSnapshot[] }
    | { ok: false; message: string }
  >
  onAdminCoinPackageDelete?: (packageId: string) => Promise<
    | { ok: true; packages: CoinPackageSnapshot[] }
    | { ok: false; message: string }
  >
  onAdminCoinPackageLobbyToggle?: (
    packageId: string,
    showInLobby: boolean,
  ) => Promise<
    | { ok: true; packages: CoinPackageSnapshot[] }
    | { ok: false; message: string }
  >
  onNotifFriendRequestClick?: (friendshipId: string) => void
  onMarkGiftNotificationRead?: (giftId: string) => Promise<void>
  onFriendshipsLoad?: () => Promise<
    | { ok: true; friendships: FriendshipsSnapshot }
    | { ok: false; message: string }
  >
  onFriendRequestSubmit?: (profileId: string) => Promise<
    | { ok: true; friendships: FriendshipsSnapshot }
    | { ok: false; message: string }
  >
  onFriendAccept?: (friendshipId: string) => Promise<
    | { ok: true; friendships: FriendshipsSnapshot }
    | { ok: false; message: string }
  >
  onFriendReject?: (friendshipId: string) => Promise<
    | { ok: true; friendships: FriendshipsSnapshot }
    | { ok: false; message: string }
  >
  onFriendRemove?: (friendshipId: string) => Promise<
    | { ok: true; friendships: FriendshipsSnapshot }
    | { ok: false; message: string }
  >
  onBlockProfile?: (profileId: string) => Promise<{ blocked: boolean; limitReached?: true } | { ok: false; message: string }>
  onLoadBlockedPlayers?: () => Promise<{ ok: true; profiles: PlayerPublicProfileSnapshot[]; count: number; limit: number } | { ok: false; message: string }>
  onLikeProfile?: (profileId: string) => Promise<
    | { ok: true; liked: boolean; likesCount: number }
    | { ok: false }
  >
  onGiftCoinsSubmit?: (friendshipId: string, amount: number) => Promise<
    | {
        ok: true
        senderProfile: PlayerPublicProfileSnapshot
        recipientProfile: PlayerPublicProfileSnapshot
      }
    | { ok: false; message: string }
  >
  onChatConversationsLoad?: () => Promise<
    | { ok: true; conversations: ChatConversationSnapshot[] }
    | { ok: false; message: string }
  >
  onChatMessagesLoad?: (friendshipId: string) => Promise<
    | { ok: true; messages: ChatMessageSnapshot[] }
    | { ok: false; message: string }
  >
  onChatMarkRead?: (friendshipId: string) => Promise<void>
  onChatSend?: (friendshipId: string, body: string) => Promise<
    | {
        ok: true
        conversation: ChatConversationSnapshot
        messages: ChatMessageSnapshot[]
      }
    | { ok: false; message: string }
  >
  onLogout?: () => Promise<void>
  onDailyMissionsLoad?: () => Promise<
    | { ok: true; missions: PlayerMissionProgressSnapshot[]; unclaimedCount: number; date: string }
    | { ok: false; message: string }
  >
  onMissionClaim?: (missionId: string) => Promise<
    | { ok: true; rewardYellowCoins: number; missions: PlayerMissionProgressSnapshot[]; unclaimedCount: number }
    | { ok: false; message: string }
  >
  onAdminMissionsLoad?: () => Promise<
    | { ok: true; activeMissions: MissionTemplateSnapshot[]; stagedMissions: MissionTemplateSnapshot[] }
    | { ok: false; message: string }
  >
  onAdminMissionSubmit?: (
    input: MissionTemplateInput,
  ) => Promise<{ ok: true; activeMissions: MissionTemplateSnapshot[]; stagedMissions: MissionTemplateSnapshot[] } | { ok: false; message: string }>
  onAdminMissionActiveToggle?: (
    missionId: string,
    isActive: boolean,
  ) => Promise<{ ok: true; activeMissions: MissionTemplateSnapshot[]; stagedMissions: MissionTemplateSnapshot[] } | { ok: false; message: string }>
  onAdminMissionDelete?: (missionId: string) => Promise<
    | { ok: true; activeMissions: MissionTemplateSnapshot[]; stagedMissions: MissionTemplateSnapshot[] }
    | { ok: false; message: string }
  >
  onMatchRoomsLoad?: () => Promise<{ ok: true; rooms: MatchRoomSnapshot[] } | { ok: false; message: string }>
  onAdminMatchRoomUpsert?: (room: {
    stakeAmount: number
    minLevel: number
    prizeAmount: number
    isEnabled: boolean
  }) => Promise<{ ok: true; rooms: MatchRoomSnapshot[] } | { ok: false; message: string }>
  onAdminMatchRoomDelete?: (stakeAmount: number) => Promise<{ ok: true; rooms: MatchRoomSnapshot[] } | { ok: false; message: string }>
  onPrivateRoomsOpen?: () => void
  onPrivateRoomsClose?: () => void
  onPrivateRoomCreate?: (stake: MatchStake, isLocked: boolean) => void
  onPrivateRoomJoin?: (privateRoomId: string) => void
  onPrivateRoomLeave?: () => void
  onPrivateRoomInvite?: (toProfiles: Array<{ profileId: string; displayName: string }>) => void
  onCancelPrivateRoomInvite?: (inviteId: string) => void
  onPrivateRoomInviteRespond?: (inviteId: string, accept: boolean) => void
  onSupportMessagesLoad?: () => Promise<
    | { ok: true; messages: SupportMessageSnapshot[] }
    | { ok: false; message: string }
  >
  onSupportSend?: (body: string) => Promise<
    | { ok: true; messages: SupportMessageSnapshot[] }
    | { ok: false; code?: string; remainingMinutes?: number; message?: string }
  >
  onSupportUnreadLoad?: () => Promise<{ ok: true; unreadCount: number } | { ok: false }>
  onAdminSupportConversationsLoad?: () => Promise<
    | { ok: true; conversations: SupportConversationSnapshot[] }
    | { ok: false; message: string }
  >
  onAdminSupportMessagesLoad?: (profileId: string) => Promise<
    | { ok: true; messages: SupportMessageSnapshot[] }
    | { ok: false; message: string }
  >
  onAdminSupportReply?: (profileId: string, body: string) => Promise<
    | { ok: true; messages: SupportMessageSnapshot[] }
    | { ok: false; message: string }
  >
  onAdminSupportDeleteConversation?: (profileId: string) => Promise<{ ok: true } | { ok: false; message: string }>
  onSupportDeleteConversation?: () => Promise<{ ok: true } | { ok: false; message: string }>
}


export type LobbyFlowController = {
  render: () => void
  destroy: () => void
  getCurrentScreen: () => LobbySocialScreen
  setConnected: (value: boolean) => void
  setDisplayName: (value: string) => void
  setErrorText: (value: string | null) => void
  setLocalAvatarUrl: (value: string | null) => void
  setFriendships: (value: FriendshipsSnapshot | null) => void
  setChatConversations: (value: ChatConversationSnapshot[]) => void
  startMatchmaking: (stake: MatchStake, displayName?: string) => void
  resetToLobby: () => void
  refreshMissionsCount: () => void
  refreshDailyRewardsStatus: () => void
  refreshSupportUnread: () => void
  removePendingFriendRequest: (friendshipId: string) => void
  getPendingFriendRequest: (friendshipId: string) => { friendshipId: string; fromProfileId: string; fromDisplayName: string; fromAvatarUrl: string | null } | undefined
  getFriendshipActionForProfile: (profileId: string) => import('../../ui/overlays/renderPlayerProfilePopup').PlayerProfileFriendshipAction | null
  handleServerMessage: (message: ServerMessage) => boolean
  navigateToShop: (noticeText: string | null) => void
  setPwaUpdatePending: (pending: boolean, applyFn: (() => void) | null) => void
  navigateInitialPath: () => void
}

type InternalLobbyFlowState = {
  currentScreen: LobbySocialScreen
  displayName: string
  localAvatarUrl: string | null
  selectedStake: MatchStake
  isConnected: boolean
  isSearching: boolean
  queuedPlayers: number
  requiredPlayers: number
  remainingMs: number | null
  countdownEndsAt: number | null
  totalCountdownMs: number
  errorText: string | null
  profilePopupOpen: boolean
  profilePopupProfile: PlayerPublicProfileSnapshot | null
  profilePopupCanEdit: boolean
  profileEditorOpen: boolean
  profileEditorErrorText: string | null
  profileNameChangeErrorText: string | null
  profileNameChangeSuccessAmount: number | null
  changePasswordPopupOpen: boolean
  changePasswordErrorText: string | null
  ownLikesCount: number | null
  authModalMode: LobbyAuthModalMode
  authErrorText: string | null
  authSubmitInFlight: boolean
  lowCoinsModalOpen: boolean
  serverRoomSeats: RoomSeatSnapshot[] | null
  serverYourSeat: RoomSeatSnapshot['seat'] | null
  serverPreviewBotDisplayNames: string[]
  players: PlayerPublicProfileSnapshot[]
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
  shopPurchaseActionPackageId: string | null
  shopPurchaseMessageText: string | null
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
  friendActionLoadingProfileId: string | null
  friendActionMessageProfileId: string | null
  friendActionMessage: string | null
  giftModalFriendshipId: string | null
  giftModalFriendName: string
  giftModalErrorText: string | null
  giftSuccessModal: { amount: number; friendName: string } | null
  pendingGiftNotifications: Array<{ giftId: string; amount: number; fromDisplayName: string }>
  chatConversations: ChatConversationSnapshot[]
  activeChatFriendshipId: string | null
  chatMessages: ChatMessageSnapshot[]
  chatLoading: boolean
  chatMessagesLoading: boolean
  chatErrorText: string | null
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
  matchRoomsLoaded: boolean
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
  privateRoomInviteQueue: Array<{
    inviteId: string
    fromProfileId: string
    fromDisplayName: string
    fromAvatarUrl: string | null
    privateRoomId: string
    stake: MatchStake
    expiresAt: number
  }>
  privateRoomInfoText: string | null
  leavePrivateRoomForMatchmakingOpen: boolean
  inviteFriendsPopupOpen: boolean
  blockedPlayersPopupOpen: boolean
  blockedPlayers: PlayerPublicProfileSnapshot[] | null
  blockedPlayersLoading: boolean
  blockedPlayersErrorText: string | null
  blockedPlayersLimit: number
  blockLimitPopupOpen: boolean
  noPlayersModalOpen: boolean
  supportPopupOpen: boolean
  supportMessages: SupportMessageSnapshot[]
  supportUnreadCount: number
  supportLoading: boolean
  supportSendingLoading: boolean
  supportErrorText: string | null
  adminSupportConversations: SupportConversationSnapshot[]
  adminSupportConversationsLoading: boolean
  adminSupportSelectedProfileId: string | null
  adminSupportMessages: SupportMessageSnapshot[]
  adminSupportMessagesLoading: boolean
  adminSupportReplyLoading: boolean
  adminSupportDeleteConfirmProfileId: string | null
  adminSupportDeleteLoading: boolean
  supportDeleteConfirm: boolean
  supportDeleteLoading: boolean
  supportAccountTooNewMinutes: number | null
  pwaUpdatePending: boolean
  pwaUpdateApplyFn: (() => void) | null
}

type StakeCardConfig = {
  stake: MatchStake
  prizeAmount: number
}

const DEFAULT_REQUIRED_PLAYERS = 4
const DEFAULT_COUNTDOWN_MS = 20000
const FINAL_FILL_START_REMAINING_MS = 3000
const FINAL_FILL_STAGGER_OFFSETS_MS = [0, 720, 1120] as const
const FINAL_FILL_MATCH_START_DELAY_MS = 1000

const WAITING_CLOCK_AUDIO_SRC = '/audio/ui/waiting-clock.mp3'
const WAITING_CLOCK_AUDIO_VOLUME = 0.75

const SEAT_FILL_AUDIO_SRC = '/audio/ui/player-seat-fill.mp3'
const SEAT_FILL_AUDIO_VOLUME = 0.9
const SEAT_FILL_SOUND_STAGGER_MS = 120

const STAKE_CARD_CONFIG: Record<MatchStake, StakeCardConfig> = {
  5000: { stake: 5000, prizeAmount: 8000 },
  8000: { stake: 8000, prizeAmount: 12000 },
  10000: { stake: 10000, prizeAmount: 15000 },
  15000: { stake: 15000, prizeAmount: 22000 },
  20000: { stake: 20000, prizeAmount: 30000 },
}

function getStakePrizeAmount(stake: MatchStake): number {
  return STAKE_CARD_CONFIG[stake]?.prizeAmount ?? stake
}

function createInitialState(): InternalLobbyFlowState {
  return {
    currentScreen: 'lobby',
    displayName: '',
    localAvatarUrl: null,
    selectedStake: 5000,
    isConnected: false,
    isSearching: false,
    queuedPlayers: 0,
    requiredPlayers: DEFAULT_REQUIRED_PLAYERS,
    remainingMs: null,
    countdownEndsAt: null,
    totalCountdownMs: DEFAULT_COUNTDOWN_MS,
    errorText: null,
    profilePopupOpen: false,
    profilePopupProfile: null,
    profilePopupCanEdit: true,
    profileEditorOpen: false,
    profileEditorErrorText: null,
    profileNameChangeErrorText: null,
    profileNameChangeSuccessAmount: null,
    changePasswordPopupOpen: false,
    changePasswordErrorText: null,
    ownLikesCount: null,
    authModalMode: 'closed',
    authErrorText: null,
    authSubmitInFlight: false,
    lowCoinsModalOpen: false,
    serverRoomSeats: null,
    serverYourSeat: null,
    serverPreviewBotDisplayNames: [],
    players: [],
    playersLoading: false,
    playersErrorText: null,
    leaderboards: null,
    leaderboardsLoading: false,
    leaderboardsErrorText: null,
    activeLeaderboardCategory: 'balance',
    lobbyPackages: [],
    shopPackages: [],
    shopPackagesLoading: false,
    shopPackagesErrorText: null,
    shopPurchases: [],
    shopPurchasesVisible: false,
    shopPurchasesLoading: false,
    shopPurchaseActionPackageId: null,
    shopPurchaseMessageText: null,
    adminStats: null,
    adminStatsLoading: false,
    adminStatsErrorText: null,
    adminActiveDailyRewardTiers: [],
    adminStagedDailyRewardTiers: [],
    adminDailyRewardsLoading: false,
    adminDailyRewardsErrorText: null,
    adminDailyRewardAddLoading: false,
    adminDailyRewardAddErrorText: null,
    dailyRewardTiers: [],
    dailyRewardsPopupOpen: false,
    dailyRewardsLoading: false,
    dailyRewardsErrorText: null,
    dailyRewardClaimingId: null,
    dailyRewardClaimErrorText: null,
    dailyRewardLastAwarded: null,
    adminSettings: null,
    adminSettingsLoading: false,
    adminSettingsErrorText: null,
    adminCoinPackages: [],
    adminCoinPackagesLoading: false,
    adminCoinPackagesErrorText: null,
    adminCoinPackageEditId: null,
    friendships: null,
    friendsLoading: false,
    friendsErrorText: null,
    friendActionLoadingProfileId: null,
    friendActionMessageProfileId: null,
    friendActionMessage: null,
    giftModalFriendshipId: null,
    giftModalFriendName: '',
    giftModalErrorText: null,
    giftSuccessModal: null,
    pendingGiftNotifications: [],
    chatConversations: [],
    activeChatFriendshipId: null,
    chatMessages: [],
    chatLoading: false,
    chatMessagesLoading: false,
    chatErrorText: null,
    notificationsOpen: false,
    pendingFriendRequests: [],
    missionsPopupOpen: false,
    dailyMissions: [],
    dailyMissionsLoading: false,
    dailyMissionsErrorText: null,
    dailyMissionsUnclaimedCount: 0,
    missionClaimingId: null,
    missionClaimErrorText: null,
    adminActiveMissions: [],
    adminStagedMissions: [],
    adminMissionsLoading: false,
    adminMissionsErrorText: null,
    adminMissionEditId: null,
    adminMissionEditIsStaged: false,
    matchRooms: [],
    matchRoomsLoaded: false,
    matchRoomsLoading: true,
    matchRoomsErrorText: null,
    adminMatchRoomEdit: null,
    privateRoomsCreatePopupOpen: false,
    privateRoomsTab: 'all',
    privateRooms: [],
    myPrivateRoom: null,
    privateRoomInvite: null,
    privateRoomInviteQueue: [],
    privateRoomInfoText: null,
    leavePrivateRoomForMatchmakingOpen: false,
    inviteFriendsPopupOpen: false,
    blockedPlayersPopupOpen: false,
    blockedPlayers: null,
    blockedPlayersLoading: false,
    blockedPlayersErrorText: null,
    blockedPlayersLimit: 50,
    blockLimitPopupOpen: false,
    noPlayersModalOpen: false,
    supportPopupOpen: false,
    supportMessages: [],
    supportUnreadCount: 0,
    supportLoading: false,
    supportSendingLoading: false,
    supportErrorText: null,
    adminSupportConversations: [],
    adminSupportConversationsLoading: false,
    adminSupportSelectedProfileId: null,
    adminSupportMessages: [],
    adminSupportMessagesLoading: false,
    adminSupportReplyLoading: false,
    adminSupportDeleteConfirmProfileId: null,
    adminSupportDeleteLoading: false,
    supportDeleteConfirm: false,
    supportDeleteLoading: false,
    supportAccountTooNewMinutes: null,
    pwaUpdatePending: false,
    pwaUpdateApplyFn: null,
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function getLobbyRemainingMs(state: InternalLobbyFlowState): number | null {
  if (!state.isSearching) {
    return null
  }

  if (state.countdownEndsAt !== null) {
    return Math.max(0, state.countdownEndsAt - Date.now())
  }

  return state.remainingMs
}

function getLocalCountdownEndsAt(remainingMs: number): number {
  return Date.now() + Math.max(0, remainingMs)
}

function getLobbyStatusText(state: InternalLobbyFlowState): string {
  if (!state.isConnected) {
    return 'Свързване със сървъра...'
  }

  if (state.isSearching) {
    return `Търсиш игра за ${state.selectedStake}.`
  }

  return 'Избери маса и започни търсене на игра.'
}

function getRoomStatusText(
  state: InternalLobbyFlowState,
  displayedQueuedPlayers: number,
): string {
  if (!state.isConnected) {
    return 'Изчакваме връзката със сървъра...'
  }

  const missingPlayers = Math.max(0, state.requiredPlayers - displayedQueuedPlayers)

  if (missingPlayers <= 0) {
    return 'Масата е готова. Играта стартира.'
  }

  if (missingPlayers === 1) {
    return 'Чакаме още 1 играч...'
  }

  return `Чакаме още ${missingPlayers} играчи...`
}

function countOccupiedSeats(seats: RoomSeatSnapshot[]): number {
  return seats.reduce((count, seat) => count + (seat.isOccupied ? 1 : 0), 0)
}

function getLocalSeatSnapshot(
  state: InternalLobbyFlowState,
): RoomSeatSnapshot | null {
  if (!state.serverRoomSeats || !state.serverYourSeat) {
    return null
  }

  return state.serverRoomSeats.find((seat) => seat.seat === state.serverYourSeat) ?? null
}

function getOtherOccupiedSeatSnapshots(
  state: InternalLobbyFlowState,
): RoomSeatSnapshot[] {
  if (!state.serverRoomSeats) {
    return []
  }

  return state.serverRoomSeats.filter(
    (seat) => seat.isOccupied && seat.seat !== state.serverYourSeat,
  )
}

const WAITING_PLAYER_DISPLAY_NAME = 'Чакаме...'
const LOCAL_PLAYER_FALLBACK_DISPLAY_NAME = 'Гост'

function createLocalProfilePreview(
  state: InternalLobbyFlowState,
  authSession: LobbyAuthSession | null,
): PlayerPublicProfileSnapshot {
  if (authSession !== null) {
    return {
      ...authSession.profile,
      likesCount: state.ownLikesCount,
    }
  }

  const localSeatSnapshot = getLocalSeatSnapshot(state)
  const displayName =
    localSeatSnapshot?.displayName.trim() ||
    state.displayName.trim() ||
    LOCAL_PLAYER_FALLBACK_DISPLAY_NAME
  const avatarUrl = localSeatSnapshot?.avatarUrl ?? state.localAvatarUrl

  return {
    profileId: null,
    displayName,
    avatarUrl,
    level: 1,
    rankTitle: 'Ранг 1',
    skillRating: null,
    completedGamesCount: 0,
    wonGamesCount: 0,
    currentRankGames: 0,
    nextRankGames: 5,
    gamesUntilNextRank: 5,
    rankProgressRatio: 0,
    averageRating: 0,
    totalRatingsCount: 0,
    yellowCoinsBalance: 25430,
    gender: null,
    galleryImages: avatarUrl
      ? [
          {
            imageId: 'local-avatar',
            imageUrl: avatarUrl,
            sortOrder: 0,
          },
        ]
      : [],
    likesCount: null,
    hasLikedByMe: null,
    isBlockedByMe: null,
  }
}

function createAutoFillPreviewPlayer(
  index: number,
  displayName: string | null = null,
): MatchmakingRoomPlayer {
  const normalizedDisplayName = displayName?.trim() || WAITING_PLAYER_DISPLAY_NAME

  return {
    id: `autofill-preview-${index + 1}`,
    name: normalizedDisplayName,
    avatarUrl: null,
    isBot: normalizedDisplayName !== WAITING_PLAYER_DISPLAY_NAME,
  }
}

function findRelationshipByProfileId(
  friendships: FriendshipsSnapshot | null,
  profileId: string,
): FriendRelationshipSnapshot | null {
  if (friendships === null) {
    return null
  }

  const relationships = [
    ...friendships.incomingPending,
    ...friendships.outgoingPending,
    ...friendships.friends,
  ]

  return relationships.find((relationship) => {
    return relationship.profile.profileId === profileId
  }) ?? null
}

const LOBBY_PATH_TO_SCREEN: Partial<Record<string, LobbySocialScreen>> = {
  '/lobby': 'lobby',
  '/players': 'players',
  '/ranking': 'leaderboards',
  '/shop': 'shop',
  '/admin': 'admin',
  '/friends': 'friends',
  '/chat': 'chat',
}

export function createLobbyFlowController(
  options: CreateLobbyFlowControllerOptions,
): LobbyFlowController {
  const state = createInitialState()
  const _initialScreen = LOBBY_PATH_TO_SCREEN[window.location.pathname]
  if (_initialScreen) {
    state.currentScreen = _initialScreen
  }

  let _renderTimerId: ReturnType<typeof setTimeout> | null = null

  function shouldSuppressLobbyRender(): boolean {
    return options.getIsInGame?.() ?? false
  }

  function scheduleRender(): void {
    if (shouldSuppressLobbyRender()) return
    if (_renderTimerId !== null) clearTimeout(_renderTimerId)
    _renderTimerId = setTimeout(() => {
      _renderTimerId = null
      render()
    }, 50)
  }

  // --- Initial loading overlay ---
  let _initMatchRoomsDone = !options.onMatchRoomsLoad
  let _initPackagesDone = !options.onLobbyPackagesLoad
  let _initConnected = false
  let _initOverlayEl: HTMLElement | null = null
  let _initBarEl: HTMLElement | null = null
  let _initOverlayHidden = false
  let _initOverlayFallbackId: ReturnType<typeof setTimeout> | null = null

  function createInitialOverlay(): void {
    const overlay = document.createElement('div')
    overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#242424;transition:opacity 0.3s ease;'
    const track = document.createElement('div')
    track.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:350px;height:8px;background:rgba(244,201,91,0.15);border-radius:4px;overflow:hidden;'
    const bar = document.createElement('div')
    bar.style.cssText = 'height:100%;background:linear-gradient(90deg,#f4c95b,#c98f13);width:0%;transition:width 0.6s cubic-bezier(0.4,0,0.2,1);border-radius:4px;'
    track.appendChild(bar)
    overlay.appendChild(track)
    document.body.appendChild(overlay)
    _initOverlayEl = overlay
    _initBarEl = bar
    requestAnimationFrame(() => {
      if (_initBarEl) _initBarEl.style.width = '40%'
      setTimeout(() => { if (_initBarEl && !_initOverlayHidden) _initBarEl.style.width = '72%' }, 700)
    })
    _initOverlayFallbackId = setTimeout(() => {
      _initOverlayFallbackId = null
      doHideInitialOverlay()
    }, 4000)
  }

  function doHideInitialOverlay(): void {
    if (_initOverlayHidden) return
    _initOverlayHidden = true
    if (_initOverlayFallbackId !== null) {
      clearTimeout(_initOverlayFallbackId)
      _initOverlayFallbackId = null
    }
    const bar = _initBarEl
    const overlay = _initOverlayEl
    if (!bar || !overlay) return
    bar.style.transition = 'width 0.2s ease'
    bar.style.width = '100%'
    setTimeout(() => {
      overlay.style.opacity = '0'
      setTimeout(() => { overlay.remove(); _initOverlayEl = null; _initBarEl = null }, 320)
    }, 220)
  }

  function maybeHideInitialOverlay(): void {
    if (_initMatchRoomsDone && _initPackagesDone && _initConnected) {
      doHideInitialOverlay()
    }
  }

  let errorTextTimerId: ReturnType<typeof setTimeout> | null = null

  let countdownAnimationFrameId: number | null = null
  let countdownTextElement: HTMLElement | null = null
  let progressBarElement: HTMLElement | null = null
  let lastRenderedCountdownSecond: number | null = null

  let finalFillSequenceStartedAt: number | null = null
  let finalFillBaseQueuedPlayers: number | null = null
  let finalFillAnimatedQueuedPlayers: number | null = null
  let pendingMatchFoundMessage: MatchFoundMessage | null = null
  let pendingMatchFoundTimeoutId: number | null = null
  let stakeEffectStartedAt: number | null = null
  let pendingStakeEffect = false

  let autoFillPreviewPlayers: MatchmakingRoomPlayer[] = []
  let waitingClockAudio: HTMLAudioElement | null = null
  let lastSoundedDisplayedQueuedPlayers: number | null = null
  let seatFillSoundTimeoutIds: number[] = []

  function getWaitingClockAudio(): HTMLAudioElement {
    if (!waitingClockAudio) {
      waitingClockAudio = new Audio(WAITING_CLOCK_AUDIO_SRC)
      waitingClockAudio.preload = 'auto'
      waitingClockAudio.loop = true
      waitingClockAudio.volume = WAITING_CLOCK_AUDIO_VOLUME
    }

    return waitingClockAudio
  }

  function startWaitingClockAudio(): void {
    if (state.currentScreen !== 'matchmaking-room' || !state.isSearching) {
      return
    }

    const audio = getWaitingClockAudio()
    audio.loop = true
    audio.volume = WAITING_CLOCK_AUDIO_VOLUME

    if (!audio.paused) {
      return
    }

    void audio.play().catch(() => {})
  }

  function stopWaitingClockAudio(resetTime = true): void {
    if (!waitingClockAudio) {
      return
    }

    waitingClockAudio.pause()

    if (resetTime) {
      waitingClockAudio.currentTime = 0
    }
  }

  function clearCountdownAnimationFrame(): void {
    if (countdownAnimationFrameId !== null) {
      window.cancelAnimationFrame(countdownAnimationFrameId)
      countdownAnimationFrameId = null
    }
  }

  function clearPendingMatchFoundTimeout(): void {
    if (pendingMatchFoundTimeoutId !== null) {
      window.clearTimeout(pendingMatchFoundTimeoutId)
      pendingMatchFoundTimeoutId = null
    }
  }

  function clearSeatFillSoundTimeouts(): void {
    for (const timeoutId of seatFillSoundTimeoutIds) {
      window.clearTimeout(timeoutId)
    }

    seatFillSoundTimeoutIds = []
  }

  function playSeatFillSound(): void {
    const audio = new Audio(SEAT_FILL_AUDIO_SRC)
    audio.preload = 'auto'
    audio.volume = SEAT_FILL_AUDIO_VOLUME
    void audio.play().catch(() => {})
  }

  function syncSeatFillSounds(displayedQueuedPlayers: number): void {
    if (lastSoundedDisplayedQueuedPlayers === null) {
      lastSoundedDisplayedQueuedPlayers = displayedQueuedPlayers
      return
    }

    if (displayedQueuedPlayers <= lastSoundedDisplayedQueuedPlayers) {
      lastSoundedDisplayedQueuedPlayers = displayedQueuedPlayers
      return
    }

    const addedPlayers = displayedQueuedPlayers - lastSoundedDisplayedQueuedPlayers
    lastSoundedDisplayedQueuedPlayers = displayedQueuedPlayers

    for (let index = 0; index < addedPlayers; index += 1) {
      const delay = index * SEAT_FILL_SOUND_STAGGER_MS

      const timeoutId = window.setTimeout(() => {
        playSeatFillSound()
      }, delay)

      seatFillSoundTimeoutIds.push(timeoutId)
    }
  }

  function resetLiveCountdownTargets(): void {
    countdownTextElement = null
    progressBarElement = null
    lastRenderedCountdownSecond = null
  }

  function resetAutoFillPreviewPlayers(): void {
    autoFillPreviewPlayers = []
  }

  function resetSeatFillSoundTracking(): void {
    lastSoundedDisplayedQueuedPlayers = null
    clearSeatFillSoundTimeouts()
  }

  function clearServerRoomSnapshot(): void {
    state.serverRoomSeats = null
    state.serverYourSeat = null
  }

  function ensureAutoFillPreviewPlayersCount(count: number): void {
    autoFillPreviewPlayers = Array.from({ length: count }, (_, index) => {
      return createAutoFillPreviewPlayer(
        index,
        state.serverPreviewBotDisplayNames[index] ?? null,
      )
    })
  }

  function clearFinalFillAnimationState(): void {
    finalFillSequenceStartedAt = null
    finalFillBaseQueuedPlayers = null
    finalFillAnimatedQueuedPlayers = null
    pendingStakeEffect = false
    resetAutoFillPreviewPlayers()
    resetSeatFillSoundTracking()
  }

  function resetFinalFillSequence(): void {
    clearFinalFillAnimationState()
    pendingMatchFoundMessage = null
    clearPendingMatchFoundTimeout()
    stakeEffectStartedAt = null
  }

  function syncLiveCountdownTargets(): void {
    countdownTextElement = options.root.querySelector<HTMLElement>(
      '[data-matchmaking-countdown-text="1"]',
    )
    progressBarElement = options.root.querySelector<HTMLElement>(
      '[data-matchmaking-progress-bar="1"]',
    )
    lastRenderedCountdownSecond = null
  }

  function getDisplayedQueuedPlayers(): number {
    if (state.serverRoomSeats) {
      return countOccupiedSeats(state.serverRoomSeats)
    }

    if (finalFillAnimatedQueuedPlayers !== null) {
      return Math.max(state.queuedPlayers, finalFillAnimatedQueuedPlayers)
    }

    return state.queuedPlayers
  }

  function createDisplayedJoinedPlayers(): MatchmakingRoomPlayer[] {
    if (state.serverRoomSeats) {
      return getOtherOccupiedSeatSnapshots(state).map((seat) => ({
        id: `room-seat-${seat.seat}`,
        name: seat.displayName,
        avatarUrl: seat.avatarUrl,
        isBot: seat.isBot,
      }))
    }

    const displayedQueuedPlayers = getDisplayedQueuedPlayers()
    const totalOtherSeats = Math.max(0, displayedQueuedPlayers - 1)
    const actualOtherPlayers = Math.max(0, state.queuedPlayers - 1)
    const autoFillCount = Math.max(0, totalOtherSeats - actualOtherPlayers)

    ensureAutoFillPreviewPlayersCount(autoFillCount)

    const actualPlayers = Array.from({ length: actualOtherPlayers }, (_, index) => ({
      id: `queued-preview-${index + 1}`,
      name: WAITING_PLAYER_DISPLAY_NAME,
      avatarUrl: null,
      isBot: false,
    }))

    return [...actualPlayers, ...autoFillPreviewPlayers.slice(0, autoFillCount)]
  }

  function createDisplayedLocalPlayer(): MatchmakingRoomPlayer {
    const localSeatSnapshot = getLocalSeatSnapshot(state)

    if (localSeatSnapshot?.isOccupied) {
      return {
        id: `room-seat-${localSeatSnapshot.seat}`,
        name: localSeatSnapshot.displayName,
        avatarUrl: localSeatSnapshot.avatarUrl ?? state.localAvatarUrl,
        isBot: localSeatSnapshot.isBot,
      }
    }

    return {
      id: 'local-player',
      name: state.displayName.trim() || LOCAL_PLAYER_FALLBACK_DISPLAY_NAME,
      avatarUrl: state.localAvatarUrl,
      isBot: false,
    }
  }

  function clearUiTickLoop(): void {
    clearCountdownAnimationFrame()
    resetLiveCountdownTargets()
  }

  function stopWaitingRoomActivity(): void {
    clearUiTickLoop()
    stopWaitingClockAudio()
    clearSeatFillSoundTimeouts()
  }

  function switchToLobby(): void {
    const wasOnDifferentScreen = state.currentScreen !== 'lobby'
    state.currentScreen = 'lobby'
    state.isSearching = false
    state.queuedPlayers = 0
    state.requiredPlayers = DEFAULT_REQUIRED_PLAYERS
    state.remainingMs = null
    state.countdownEndsAt = null
    state.totalCountdownMs = DEFAULT_COUNTDOWN_MS
    state.serverPreviewBotDisplayNames = []
    clearServerRoomSnapshot()
    stopWaitingRoomActivity()
    resetFinalFillSequence()
    const shouldLoad = wasOnDifferentScreen || (!state.matchRoomsLoading && !state.matchRoomsLoaded)
    if (shouldLoad) {
      state.matchRoomsLoaded = false
      state.matchRoomsLoading = true
      void loadMatchRooms()
    }
  }

  function updateMatchmakingRoomLiveUi(): boolean {
    if (state.currentScreen !== 'matchmaking-room' || !state.isSearching) {
      return false
    }

    if (!countdownTextElement || !progressBarElement) {
      syncLiveCountdownTargets()
    }

    if (!countdownTextElement || !progressBarElement) {
      return false
    }

    const remainingMs = clamp(
      getLobbyRemainingMs(state) ?? state.totalCountdownMs,
      0,
      state.totalCountdownMs,
    )
    const countdownSeconds = Math.ceil(remainingMs / 1000)
    const progressDegrees = (remainingMs / state.totalCountdownMs) * 360

    if (lastRenderedCountdownSecond !== countdownSeconds) {
      countdownTextElement.innerHTML = `
        <span class="mm-countdown-number">${countdownSeconds}</span>
        <span class="mm-countdown-unit">сек</span>
      `
      lastRenderedCountdownSecond = countdownSeconds
    }

    progressBarElement.style.transition = 'none'
    progressBarElement.style.setProperty('--matchmaking-progress', `${progressDegrees}deg`)

    return true
  }

  function maybeStartFinalFillSequence(): void {
    if (state.serverRoomSeats) {
      return
    }

    if (finalFillSequenceStartedAt !== null) {
      return
    }

    if (state.currentScreen !== 'matchmaking-room' || !state.isSearching) {
      return
    }

    if (state.queuedPlayers >= state.requiredPlayers) {
      return
    }

    if (state.serverPreviewBotDisplayNames.length === 0) {
      return
    }

    const remainingMs = getLobbyRemainingMs(state)

    if (remainingMs === null || remainingMs > FINAL_FILL_START_REMAINING_MS) {
      return
    }

    finalFillSequenceStartedAt = Date.now()
    finalFillBaseQueuedPlayers = state.queuedPlayers
    finalFillAnimatedQueuedPlayers = state.queuedPlayers
  }

  function startFinalFillSequenceNow(): boolean {
    if (state.serverRoomSeats) {
      return false
    }

    if (finalFillSequenceStartedAt !== null) {
      return true
    }

    if (state.currentScreen !== 'matchmaking-room' || !state.isSearching) {
      return false
    }

    if (state.queuedPlayers >= state.requiredPlayers) {
      return false
    }

    if (state.serverPreviewBotDisplayNames.length === 0) {
      return false
    }

    finalFillSequenceStartedAt = Date.now()
    finalFillBaseQueuedPlayers = state.queuedPlayers
    finalFillAnimatedQueuedPlayers = state.queuedPlayers

    return true
  }

  function isFinalFillSequenceComplete(): boolean {
    if (finalFillAnimatedQueuedPlayers !== null) {
      return finalFillAnimatedQueuedPlayers >= state.requiredPlayers
    }

    return getDisplayedQueuedPlayers() >= state.requiredPlayers
  }

  function maybeShowPendingStakeEffect(): void {
    if (
      !pendingStakeEffect ||
      stakeEffectStartedAt !== null ||
      !isFinalFillSequenceComplete()
    ) {
      return
    }

    pendingStakeEffect = false
    stakeEffectStartedAt = Date.now()
    showStakeDeductionEffect(state.selectedStake)
  }

  function flushPendingMatchFound(): boolean {
    const matchFoundMessage = pendingMatchFoundMessage

    if (!matchFoundMessage) {
      return false
    }

    pendingMatchFoundMessage = null
    clearPendingMatchFoundTimeout()

    state.currentScreen = 'lobby'
    state.isSearching = false
    state.queuedPlayers = 0
    state.requiredPlayers = DEFAULT_REQUIRED_PLAYERS
    state.remainingMs = null
    state.countdownEndsAt = null

    clearServerRoomSnapshot()
    stopWaitingRoomActivity()
    clearFinalFillAnimationState()

    const STAKE_EFFECT_VISIBLE_MS = 1500

    if (stakeEffectStartedAt !== null) {
      const elapsed = Date.now() - stakeEffectStartedAt
      const remainingDelay = Math.max(0, STAKE_EFFECT_VISIBLE_MS - elapsed)
      stakeEffectStartedAt = null
      setTimeout(() => options.onMatchFound(matchFoundMessage, true), remainingDelay)
    } else {
      stakeEffectStartedAt = null
      showStakeDeductionEffect(matchFoundMessage.stake)
      setTimeout(() => options.onMatchFound(matchFoundMessage, true), STAKE_EFFECT_VISIBLE_MS)
    }
    return true
  }

  function maybeSchedulePendingMatchFound(): void {
    if (!pendingMatchFoundMessage) {
      return
    }

    if (finalFillSequenceStartedAt === null) {
      return
    }

    if (!isFinalFillSequenceComplete()) {
      return
    }

    if (pendingMatchFoundTimeoutId !== null) {
      return
    }

    pendingMatchFoundTimeoutId = window.setTimeout(() => {
      pendingMatchFoundTimeoutId = null
      flushPendingMatchFound()
    }, FINAL_FILL_MATCH_START_DELAY_MS)
  }

  function updateFinalFillSequenceProgress(): boolean {
    maybeStartFinalFillSequence()

    if (
      finalFillSequenceStartedAt === null ||
      finalFillBaseQueuedPlayers === null ||
      finalFillAnimatedQueuedPlayers === null
    ) {
      return false
    }

    const missingPlayersAtStart = Math.max(
      0,
      state.requiredPlayers - finalFillBaseQueuedPlayers,
    )

    if (missingPlayersAtStart === 0) {
      maybeSchedulePendingMatchFound()
      return false
    }

    const triggerOffsets = FINAL_FILL_STAGGER_OFFSETS_MS.slice(0, missingPlayersAtStart)
    const elapsedMs = Math.max(0, Date.now() - finalFillSequenceStartedAt)

    let fillsApplied = 0

    for (const offset of triggerOffsets) {
      if (elapsedMs >= offset) {
        fillsApplied += 1
      }
    }

    const nextAnimatedQueuedPlayers = clamp(
      finalFillBaseQueuedPlayers + fillsApplied,
      state.queuedPlayers,
      state.requiredPlayers,
    )

    if (nextAnimatedQueuedPlayers !== finalFillAnimatedQueuedPlayers) {
      finalFillAnimatedQueuedPlayers = nextAnimatedQueuedPlayers

      maybeShowPendingStakeEffect()

      maybeSchedulePendingMatchFound()
      return true
    }

    maybeShowPendingStakeEffect()
    maybeSchedulePendingMatchFound()
    return false
  }

  function createProfileFriendshipAction(
    authSession: LobbyAuthSession | null,
  ): LobbyScreenState['friendshipAction'] {
    const profile = state.profilePopupProfile
    const targetProfileId = profile?.profileId ?? null

    if (!state.profilePopupOpen || state.profilePopupCanEdit || targetProfileId === null) {
      return null
    }

    const message =
      state.friendActionMessageProfileId === targetProfileId
        ? state.friendActionMessage
        : null

    if (authSession === null) {
      return {
        profileId: targetProfileId,
        label: 'Влез, за да поканиш',
        disabled: false,
        message,
      }
    }

    if (authSession.profile.profileId === targetProfileId) {
      return null
    }

    if (state.friendActionLoadingProfileId === targetProfileId) {
      return {
        profileId: targetProfileId,
        label: 'Изпращане...',
        disabled: true,
        message,
      }
    }

    const relationship = findRelationshipByProfileId(
      state.friendships,
      targetProfileId,
    )

    if (relationship === null) {
      return {
        profileId: targetProfileId,
        label: 'Покани за приятел',
        disabled: false,
        message,
      }
    }

    if (relationship.status === 'accepted') {
      return {
        profileId: targetProfileId,
        label: 'Вече сте приятели',
        disabled: true,
        message,
      }
    }

    return {
      profileId: targetProfileId,
      label:
        relationship.direction === 'incoming'
          ? 'Има входяща покана'
          : 'Поканата е изпратена',
      disabled: true,
      message,
    }
  }

  function renderLobby(): void {
    stopWaitingRoomActivity()
    resetFinalFillSequence()
    clearServerRoomSnapshot()

    const authSession = options.getAuthSession?.() ?? null
    const friendshipAction = createProfileFriendshipAction(authSession)
    const acceptedRelationship =
      state.profilePopupProfile?.profileId
        ? findRelationshipByProfileId(
            state.friendships,
            state.profilePopupProfile.profileId,
          )
        : null
    if (
      friendshipAction !== null &&
      acceptedRelationship?.status === 'accepted'
    ) {
      friendshipAction.giftFriendshipId = acceptedRelationship.friendshipId
    }
    const lobbyState: LobbyScreenState = {
      view:
        state.currentScreen === 'players'
          ? 'players'
          : state.currentScreen === 'leaderboards'
            ? 'leaderboards'
            : state.currentScreen === 'shop'
              ? 'shop'
            : state.currentScreen === 'admin'
              ? 'admin'
            : state.currentScreen === 'admin-info'
              ? 'admin-info'
          : state.currentScreen === 'friends'
            ? 'friends'
            : state.currentScreen === 'chat'
              ? 'chat'
            : state.currentScreen === 'private-rooms'
              ? 'private-rooms'
            : state.currentScreen === 'support'
              ? 'support'
            : 'tables',
      displayName: state.displayName,
      selectedStake: state.selectedStake,
      isConnected: state.isConnected,
      isSearching: state.isSearching,
      queuedPlayers: state.queuedPlayers,
      requiredPlayers: state.requiredPlayers,
      remainingMs: getLobbyRemainingMs(state),
      statusText: getLobbyStatusText(state),
      errorText: state.errorText,
      profilePopupOpen: state.profilePopupOpen,
      profile: createLocalProfilePreview(state, authSession),
      profilePopupProfile: state.profilePopupProfile,
      profilePopupCanEdit: state.profilePopupCanEdit,
      players: state.players,
      playersLoading: state.playersLoading,
      playersErrorText: state.playersErrorText,
      leaderboards: state.leaderboards,
      leaderboardsLoading: state.leaderboardsLoading,
      leaderboardsErrorText: state.leaderboardsErrorText,
      activeLeaderboardCategory: state.activeLeaderboardCategory,
      lobbyPackages: state.lobbyPackages,
      shopPackages: state.shopPackages,
      shopPackagesLoading: state.shopPackagesLoading,
      shopPackagesErrorText: state.shopPackagesErrorText,
      shopPurchases: state.shopPurchases,
      shopPurchasesVisible: state.shopPurchasesVisible,
      shopPurchasesLoading: state.shopPurchasesLoading,
      shopPurchaseActionPackageId: state.shopPurchaseActionPackageId,
      shopPurchaseMessageText: state.shopPurchaseMessageText,
      isAdmin: authSession?.account.role === 'admin',
      adminStats: state.adminStats,
      adminStatsLoading: state.adminStatsLoading,
      adminStatsErrorText: state.adminStatsErrorText,
      adminActiveDailyRewardTiers: state.adminActiveDailyRewardTiers,
      adminStagedDailyRewardTiers: state.adminStagedDailyRewardTiers,
      adminDailyRewardsLoading: state.adminDailyRewardsLoading,
      adminDailyRewardsErrorText: state.adminDailyRewardsErrorText,
      adminDailyRewardAddLoading: state.adminDailyRewardAddLoading,
      adminDailyRewardAddErrorText: state.adminDailyRewardAddErrorText,
      dailyRewardTiers: state.dailyRewardTiers,
      dailyRewardsPopupOpen: state.dailyRewardsPopupOpen,
      dailyRewardsLoading: state.dailyRewardsLoading,
      dailyRewardsErrorText: state.dailyRewardsErrorText,
      dailyRewardClaimingId: state.dailyRewardClaimingId,
      dailyRewardClaimErrorText: state.dailyRewardClaimErrorText,
      dailyRewardLastAwarded: state.dailyRewardLastAwarded,
      adminSettings: state.adminSettings,
      adminSettingsLoading: state.adminSettingsLoading,
      adminSettingsErrorText: state.adminSettingsErrorText,
      adminCoinPackages: state.adminCoinPackages,
      adminCoinPackagesLoading: state.adminCoinPackagesLoading,
      adminCoinPackagesErrorText: state.adminCoinPackagesErrorText,
      adminCoinPackageEditId: state.adminCoinPackageEditId,
      friendships: state.friendships,
      friendsLoading: state.friendsLoading,
      friendsErrorText: state.friendsErrorText,
      friendshipAction,
      giftModalFriendshipId: state.giftModalFriendshipId,
      giftModalFriendName: state.giftModalFriendName,
      giftModalErrorText: state.giftModalErrorText,
      giftSuccessModal: state.giftSuccessModal,
      pendingGiftNotifications: state.pendingGiftNotifications,
      chatConversations: state.chatConversations,
      activeChatFriendshipId: state.activeChatFriendshipId,
      chatMessages: state.chatMessages,
      chatLoading: state.chatLoading,
      chatMessagesLoading: state.chatMessagesLoading,
      chatErrorText: state.chatErrorText,
      authModalMode: state.authModalMode,
      authErrorText: state.authErrorText,
      lowCoinsModalOpen: state.lowCoinsModalOpen,
      onlinePlayersCount: options.getOnlinePlayersCount?.() ?? 0,
      signupBonusYellowCoins: options.getSignupBonusYellowCoins?.() ?? 100000,
      profileNameChangePrice:
        state.adminSettings?.profileNameChangePrice ??
        options.getProfileNameChangePrice?.() ??
        50000,
      profileEditorOpen: state.profileEditorOpen,
      profileEditorErrorText: state.profileEditorErrorText,
      profileNameChangeErrorText: state.profileNameChangeErrorText,
      profileNameChangeSuccessAmount: state.profileNameChangeSuccessAmount,
      changePasswordPopupOpen: state.changePasswordPopupOpen,
      changePasswordErrorText: state.changePasswordErrorText,
      notificationsOpen: state.notificationsOpen,
      pendingFriendRequests: state.pendingFriendRequests,
      missionsPopupOpen: state.missionsPopupOpen,
      dailyMissions: state.dailyMissions,
      dailyMissionsLoading: state.dailyMissionsLoading,
      dailyMissionsErrorText: state.dailyMissionsErrorText,
      dailyMissionsUnclaimedCount: state.dailyMissionsUnclaimedCount,
      missionClaimingId: state.missionClaimingId,
      missionClaimErrorText: state.missionClaimErrorText,
      adminActiveMissions: state.adminActiveMissions,
      adminStagedMissions: state.adminStagedMissions,
      adminMissionsLoading: state.adminMissionsLoading,
      adminMissionsErrorText: state.adminMissionsErrorText,
      adminMissionEditId: state.adminMissionEditId,
      adminMissionEditIsStaged: state.adminMissionEditIsStaged,
      matchRooms: state.matchRooms,
      matchRoomsLoading: state.matchRoomsLoading,
      matchRoomsErrorText: state.matchRoomsErrorText,
      adminMatchRoomEdit: state.adminMatchRoomEdit,
      privateRoomsCreatePopupOpen: state.privateRoomsCreatePopupOpen,
      privateRoomsTab: state.privateRoomsTab,
      privateRooms: state.privateRooms,
      myPrivateRoom: state.myPrivateRoom,
      privateRoomInvite: state.privateRoomInvite,
      privateRoomInviteQueue: state.privateRoomInviteQueue,
      privateRoomInfoText: state.privateRoomInfoText,
      leavePrivateRoomForMatchmakingOpen: state.leavePrivateRoomForMatchmakingOpen,
      inviteFriendsPopupOpen: state.inviteFriendsPopupOpen,
      leavePrivateRoomForMatchmakingIsHost: state.myPrivateRoom !== null &&
        (authSession?.profile.profileId
          ? (state.myPrivateRoom.members.find(m => m.profileId === authSession.profile.profileId)?.isHost ?? false)
          : false),
      blockedPlayersPopupOpen: state.blockedPlayersPopupOpen,
      blockedPlayers: state.blockedPlayers,
      blockedPlayersLoading: state.blockedPlayersLoading,
      blockedPlayersErrorText: state.blockedPlayersErrorText,
      blockedPlayersLimit: state.blockedPlayersLimit,
      blockLimitPopupOpen: state.blockLimitPopupOpen,
      noPlayersModalOpen: state.noPlayersModalOpen,
      isInGame: options.getIsInGame?.() ?? false,
      supportPopupOpen: state.supportPopupOpen,
      supportMessages: state.supportMessages,
      supportUnreadCount: state.supportUnreadCount,
      supportLoading: state.supportLoading,
      supportSendingLoading: state.supportSendingLoading,
      supportErrorText: state.supportErrorText,
      adminSupportConversations: state.adminSupportConversations,
      adminSupportConversationsLoading: state.adminSupportConversationsLoading,
      adminSupportSelectedProfileId: state.adminSupportSelectedProfileId,
      adminSupportMessages: state.adminSupportMessages,
      adminSupportMessagesLoading: state.adminSupportMessagesLoading,
      adminSupportReplyLoading: state.adminSupportReplyLoading,
      adminSupportDeleteConfirmProfileId: state.adminSupportDeleteConfirmProfileId,
      adminSupportDeleteLoading: state.adminSupportDeleteLoading,
      supportDeleteConfirm: state.supportDeleteConfirm,
      supportDeleteLoading: state.supportDeleteLoading,
      supportAccountTooNewMinutes: state.supportAccountTooNewMinutes,
      pwaUpdatePending: state.pwaUpdatePending,
    }

    renderLobbyScreen(options.root, {
      state: lobbyState,
      apiBaseUrl: options.getApiBaseUrl?.() ?? '',
      onDisplayNameChange: (value) => {
        state.displayName = value
      },
      onStakeChange: (stake) => {
        state.selectedStake = stake
        render()
      },
      onSearchClick: () => {
        options.tryUnlockDocumentAudio?.()
        if (state.myPrivateRoom !== null) {
          state.leavePrivateRoomForMatchmakingOpen = true
          render()
          return
        }
        startMatchmaking(state.selectedStake, state.displayName.trim() || undefined)
      },
      onCancelClick: () => {
        options.tryUnlockDocumentAudio?.()
        state.errorText = null
        switchToLobby()
        options.leaveMatchmaking()
        render()
      },
      onProfileClick: () => {
        state.profilePopupProfile = null
        state.profilePopupCanEdit = true
        state.profilePopupOpen = true
        render()
        void fetchOwnLikesCount()
      },
      onProfileClose: () => {
        state.profilePopupOpen = false
        state.profilePopupProfile = null
        state.profilePopupCanEdit = true
        renderPopupOnly()
      },
      onProfileEditClick: () => {
        state.profileEditorOpen = true
        state.profileEditorErrorText = null
        state.profileNameChangeErrorText = null
        state.profileNameChangeSuccessAmount = null
        state.profilePopupOpen = false
        render()
      },
      onProfileEditClose: () => {
        state.profileEditorOpen = false
        state.profileEditorErrorText = null
        state.profileNameChangeErrorText = null
        state.profileNameChangeSuccessAmount = null
        clearProfileEditorPendingState()
        render()
      },
      onProfileEditorFileError: (message) => {
        state.profileEditorErrorText = message
        render()
      },
      onProfileEditSubmit: (avatarFile, avatarCrop, galleryFiles) => {
        void submitProfileEdit(avatarFile, avatarCrop, galleryFiles)
      },
      onPresetAvatarApply: (avatarUrl) => {
        void submitPresetAvatar(avatarUrl)
      },
      onProfileGalleryDelete: (imageId) => {
        void deleteProfileGalleryImage(imageId)
      },
      onProfileNameChangeSubmit: (displayName) => {
        void submitProfileNameChange(displayName)
      },
      onChangePasswordOpen: () => {
        state.changePasswordPopupOpen = true
        state.changePasswordErrorText = null
        render()
      },
      onChangePasswordClose: () => {
        state.changePasswordPopupOpen = false
        state.changePasswordErrorText = null
        render()
      },
      onChangePasswordSubmit: (currentPassword, newPassword, confirmPassword) => {
        void submitChangePassword(currentPassword, newPassword, confirmPassword)
      },
      onLobbyClick: () => {
        switchToLobby()
        render()
      },
      onPlayersClick: () => {
        void showPlayersDirectory()
      },
      onShopClick: () => {
        void showShopPanel()
      },
      onShopPurchaseClick: (packageId) => {
        void startShopPurchase(packageId)
      },
      onShopHistoryToggle: () => {
        state.shopPurchasesVisible = !state.shopPurchasesVisible
        render()
      },
      onLeaderboardsClick: () => {
        void showLeaderboardsDirectory()
      },
      onLeaderboardCategoryClick: (category) => {
        state.activeLeaderboardCategory = category
        render()
      },
      onAdminClick: () => {
        void showAdminPanel()
      },
      onAdminInfoClick: () => {
        void showAdminInfoPanel()
      },
      onAdminDailyRewardAdd: (amount) => {
        void addAdminDailyReward(amount)
      },
      onAdminDailyRewardRemove: (tierId) => {
        void removeAdminDailyReward(tierId)
      },
      onDailyRewardsOpen: () => {
        void openDailyRewardsPopup()
      },
      onDailyRewardsClose: () => {
        state.dailyRewardsPopupOpen = false
        state.dailyRewardClaimErrorText = null
        state.dailyRewardLastAwarded = null
        render()
      },
      onDailyRewardClaim: (tierId) => {
        void claimDailyReward(tierId)
      },
      onAdminSettingsSubmit: (settings) => {
        void submitAdminSettings(settings)
      },
      onAdminCoinPackageSubmit: (input) => {
        void submitAdminCoinPackage(input)
      },
      onAdminCoinPackageStatusChange: (packageId, status) => {
        void setAdminCoinPackageStatus(packageId, status)
      },
      onAdminCoinPackageEdit: (packageId) => {
        editAdminCoinPackage(packageId)
      },
      onAdminCoinPackageDelete: (packageId) => {
        void deleteAdminCoinPackage(packageId)
      },
      onAdminCoinPackageLobbyToggle: (packageId, showInLobby) => {
        void toggleAdminCoinPackageLobbyVisibility(packageId, showInLobby)
      },
      onFriendsClick: () => {
        void showFriendsDirectory()
      },
      onBlockedPlayersClick: () => {
        void openBlockedPlayersPopup()
      },
      onBlockedPlayersClose: () => {
        state.blockedPlayersPopupOpen = false
        render()
      },
      onUnblockClick: (profileId) => {
        void unblockPlayer(profileId)
      },
      onBlockLimitPopupClose: () => {
        state.blockLimitPopupOpen = false
        render()
      },
      onNoPlayersModalClose: () => {
        state.noPlayersModalOpen = false
        render()
      },
      onChatClick: () => {
        void showChatPanel()
      },
      onChatConversationClick: (friendshipId) => {
        void openChatConversation(friendshipId)
      },
      onChatMarkRead: (friendshipId) => {
        state.chatConversations = state.chatConversations.map((c) =>
          c.friendshipId === friendshipId ? { ...c, unreadCount: 0 } : c,
        )
        render()
        void options.onChatMarkRead?.(friendshipId)
      },
      onChatSubmit: (friendshipId, body) => {
        void sendChatMessage(friendshipId, body)
      },
      onPlayerCardClick: (profile) => {
        const ownProfileId = (options.getAuthSession?.() ?? null)?.profile.profileId
        const isOwn = Boolean(ownProfileId && profile.profileId === ownProfileId)
        state.profilePopupProfile = isOwn ? null : (state.players.find(p => p.profileId === profile.profileId) ?? profile)
        state.profilePopupCanEdit = isOwn
        state.profilePopupOpen = true
        renderPopupOnly()
        if (isOwn) void fetchOwnLikesCount()
        else void ensureFriendshipsLoaded()
      },
      onLeaderboardPlayerClick: (profile) => {
        const ownProfileId = (options.getAuthSession?.() ?? null)?.profile.profileId
        const isOwn = Boolean(ownProfileId && profile.profileId === ownProfileId)
        state.profilePopupProfile = isOwn ? null : (state.players.find(p => p.profileId === profile.profileId) ?? profile)
        state.profilePopupCanEdit = isOwn
        state.profilePopupOpen = true
        renderPopupOnly()
        if (isOwn) void fetchOwnLikesCount()
        else void ensureFriendshipsLoaded()
      },
      onFriendProfileClick: (profile) => {
        const ownProfileId = (options.getAuthSession?.() ?? null)?.profile.profileId
        const isOwn = Boolean(ownProfileId && profile.profileId === ownProfileId)
        state.profilePopupProfile = isOwn ? null : (state.players.find(p => p.profileId === profile.profileId) ?? profile)
        state.profilePopupCanEdit = isOwn
        state.profilePopupOpen = true
        renderPopupOnly()
        if (isOwn) void fetchOwnLikesCount()
      },
      onFriendRequestClick: (profileId) => {
        void submitFriendRequest(profileId)
      },
      onBlockClick: (profileId) => {
        void blockProfile(profileId)
      },
      onFriendAcceptClick: (friendshipId) => {
        void acceptFriendRequest(friendshipId)
      },
      onFriendRejectClick: (friendshipId) => {
        void rejectFriendRequest(friendshipId)
      },
      onFriendRemoveClick: (friendshipId) => {
        void removeFriendRelationship(friendshipId)
      },
      onGiftCoinsClick: (friendshipId) => {
        openGiftModal(friendshipId)
      },
      onLikeClick: (profileId) => { void likeProfile(profileId) },
      onGiftCoinsClose: () => {
        closeGiftModal()
      },
      onGiftCoinsSubmit: (friendshipId, amount) => {
        void submitGiftCoins(friendshipId, amount)
      },
      onGiftSuccessClose: () => {
        state.giftSuccessModal = null
        render()
      },
      onLowCoinsModalClose: () => {
        state.lowCoinsModalOpen = false
        render()
      },
      onLowCoinsShopClick: () => {
        state.lowCoinsModalOpen = false
        void showShopPanel()
      },
      onAuthModalClose: () => {
        state.authModalMode = 'closed'
        state.authErrorText = null
        render()
      },
      onAuthModeChange: (mode) => {
        state.authModalMode = mode
        state.authErrorText = null
        render()
      },
      onAuthError: (message) => {
        const el = options.root.querySelector<HTMLElement>('[data-lobby-auth-error="1"]')
        if (el) {
          el.textContent = message
          el.style.display = ''
        }
      },
      onLoginSubmit: (email, password) => {
        void submitLogin(email, password)
      },
      onRegisterSubmit: (displayName, email, password, gender) => {
        void submitRegister(displayName, email, password, gender)
      },
      onLogoutClick: () => {
        void options.onLogout?.()
      },
      onBellClick: () => {
        state.notificationsOpen = !state.notificationsOpen
        render()
      },
      onNotificationMissionsClick: () => {
        state.notificationsOpen = false
        void openMissionsPopup()
      },
      onNotifFriendRequestClick: (friendshipId) => {
        options.onNotifFriendRequestClick?.(friendshipId)
      },
      onNotifGiftClick: (giftId, amount, fromDisplayName) => {
        state.pendingGiftNotifications = state.pendingGiftNotifications.filter((g) => g.giftId !== giftId)
        state.giftSuccessModal = { amount, friendName: fromDisplayName }
        void options.onMarkGiftNotificationRead?.(giftId)
        render()
      },
      onMissionsCardClick: () => {
        void openMissionsPopup()
      },
      onMissionsPopupClose: () => {
        state.missionsPopupOpen = false
        state.missionClaimErrorText = null
        render()
      },
      onMissionClaimClick: (missionId) => {
        void claimMission(missionId)
      },
      onAdminMissionSubmit: (input) => {
        void submitAdminMission(input)
      },
      onAdminMissionActiveToggle: (missionId, isActive) => {
        void toggleAdminMissionActive(missionId, isActive)
      },
      onAdminMissionDelete: (missionId) => {
        void deleteAdminMission(missionId)
      },
      onAdminMissionEdit: (missionId, isStaged) => {
        state.adminMissionEditId = missionId.length > 0 && missionId !== 'new' ? missionId : missionId === 'new' ? 'new' : null
        state.adminMissionEditIsStaged = isStaged ?? false
        render()
      },
      onAdminMatchRoomEditStart: (room) => {
        state.adminMatchRoomEdit = room ?? 'new'
        render()
      },
      onAdminMatchRoomEditCancel: () => {
        state.adminMatchRoomEdit = null
        render()
      },
      onAdminMatchRoomSubmit: (room) => {
        void (async () => {
          if (!options.onAdminMatchRoomUpsert) return
          const result = await options.onAdminMatchRoomUpsert(room)
          if (!result.ok) {
            state.matchRoomsErrorText = result.message
            render()
            return
          }
          state.matchRooms = result.rooms
          state.adminMatchRoomEdit = null
          state.matchRoomsErrorText = null
          render()
        })()
      },
      onAdminMatchRoomDelete: (stakeAmount) => {
        void (async () => {
          if (!options.onAdminMatchRoomDelete) return
          const result = await options.onAdminMatchRoomDelete(stakeAmount)
          if (!result.ok) {
            state.matchRoomsErrorText = result.message
            render()
            return
          }
          state.matchRooms = result.rooms
          state.matchRoomsErrorText = null
          render()
        })()
      },
      onPrivateRoomsOpen: () => {
        state.currentScreen = 'private-rooms'
        state.privateRoomInfoText = null
        state.privateRoomsTab = 'all'
        options.onPrivateRoomsOpen?.()
        render()
      },
      onPrivateRoomsClose: () => {
        state.currentScreen = 'lobby'
        state.privateRoomInfoText = null
        state.privateRoomsCreatePopupOpen = false
        options.onPrivateRoomsClose?.()
        render()
      },
      onPrivateRoomsTabChange: (tab) => {
        state.privateRoomsTab = tab
        render()
      },
      onPrivateRoomsCreateOpen: () => {
        state.privateRoomsCreatePopupOpen = true
        render()
      },
      onPrivateRoomsCreateClose: () => {
        state.privateRoomsCreatePopupOpen = false
        render()
      },
      onPrivateRoomCreate: (stake, isLocked) => {
        state.privateRoomsCreatePopupOpen = false
        options.onPrivateRoomCreate?.(stake, isLocked)
      },
      onPrivateRoomJoin: (privateRoomId) => {
        options.onPrivateRoomJoin?.(privateRoomId)
      },
      onPrivateRoomLeave: () => {
        state.myPrivateRoom = null
        options.onPrivateRoomLeave?.()
        render()
      },
      onPrivateRoomInvite: (toProfiles) => {
        state.privateRoomInfoText = null
        options.onPrivateRoomInvite?.(toProfiles)
      },
      onCancelPrivateRoomInvite: (inviteId) => {
        options.onCancelPrivateRoomInvite?.(inviteId)
      },
      onInviteFriendsOpen: () => {
        state.inviteFriendsPopupOpen = true
        state.friendships = null
        render()
        void ensureFriendshipsLoaded()
      },
      onInviteFriendsClose: () => {
        state.inviteFriendsPopupOpen = false
        render()
      },
      onPrivateRoomInviteAccept: (inviteId) => {
        state.privateRoomInvite = state.privateRoomInviteQueue[0] ?? null
        state.privateRoomInviteQueue = state.privateRoomInviteQueue.slice(1)
        options.onPrivateRoomInviteRespond?.(inviteId, true)
        render()
      },
      onPrivateRoomInviteDecline: (inviteId) => {
        state.privateRoomInvite = state.privateRoomInviteQueue[0] ?? null
        state.privateRoomInviteQueue = state.privateRoomInviteQueue.slice(1)
        options.onPrivateRoomInviteRespond?.(inviteId, false)
        render()
      },
      onPrivateRoomInfoDismiss: () => {
        state.privateRoomInfoText = null
        render()
      },
      onLeavePrivateRoomAndMatchmakeConfirm: () => {
        state.leavePrivateRoomForMatchmakingOpen = false
        state.myPrivateRoom = null
        options.onPrivateRoomLeave?.()
        startMatchmaking(state.selectedStake, state.displayName.trim() || undefined)
      },
      onLeavePrivateRoomAndMatchmakeCancel: () => {
        state.leavePrivateRoomForMatchmakingOpen = false
        render()
      },
      onSupportClick: () => {
        const authSession = options.getAuthSession?.() ?? null
        if (authSession === null) return
        if (authSession.account.role === 'admin') {
          state.currentScreen = 'support'
          state.adminSupportSelectedProfileId = null
          state.adminSupportConversations = []
          state.adminSupportConversationsLoading = true
          render()
          void loadAdminSupportConversations()
          return
        }
        state.supportPopupOpen = true
        state.supportErrorText = null
        state.supportMessages = []
        state.supportLoading = true
        render()
        void (async () => {
          const result = await options.onSupportMessagesLoad?.()
          state.supportLoading = false
          if (result?.ok) {
            state.supportMessages = result.messages
            state.supportUnreadCount = 0
          } else {
            state.supportErrorText = result?.message ?? 'Грешка при зареждане.'
          }
          render()
        })()
      },
      onSupportClose: () => {
        state.supportPopupOpen = false
        state.supportDeleteConfirm = false
        render()
      },
      onSupportDeleteClick: () => {
        state.supportDeleteConfirm = true
        render()
      },
      onSupportDeleteCancel: () => {
        state.supportDeleteConfirm = false
        render()
      },
      onSupportDeleteConfirm: () => {
        if (state.supportDeleteLoading) return
        state.supportDeleteLoading = true
        render()
        void (async () => {
          const result = await options.onSupportDeleteConversation?.()
          state.supportDeleteLoading = false
          if (result?.ok) {
            state.supportMessages = []
            state.supportUnreadCount = 0
            state.supportDeleteConfirm = false
            state.supportPopupOpen = false
          }
          render()
        })()
      },
      onSupportSend: (body) => {
        if (state.supportSendingLoading) return
        state.supportSendingLoading = true
        state.supportErrorText = null
        render()
        void (async () => {
          const result = await options.onSupportSend?.(body)
          state.supportSendingLoading = false
          if (result?.ok) {
            state.supportMessages = result.messages
            state.supportAccountTooNewMinutes = null
          } else if (result?.code === 'account_too_new' && result.remainingMinutes) {
            state.supportAccountTooNewMinutes = result.remainingMinutes
          } else {
            state.supportErrorText = result?.message ?? 'Грешка при изпращане.'
          }
          render()
        })()
      },
      onAdminSupportConversationClick: (profileId) => {
        state.adminSupportSelectedProfileId = profileId
        state.adminSupportMessages = []
        state.adminSupportMessagesLoading = true
        render()
        void (async () => {
          const result = await options.onAdminSupportMessagesLoad?.(profileId)
          state.adminSupportMessagesLoading = false
          if (result?.ok) {
            state.adminSupportMessages = result.messages
            const conv = state.adminSupportConversations.find(c => c.profileId === profileId)
            if (conv) {
              state.supportUnreadCount = Math.max(0, state.supportUnreadCount - conv.unreadByAdmin)
              conv.unreadByAdmin = 0
            }
          }
          render()
        })()
      },
      onAdminSupportReply: (profileId, body) => {
        if (state.adminSupportReplyLoading) return
        state.adminSupportReplyLoading = true
        render()
        void (async () => {
          const result = await options.onAdminSupportReply?.(profileId, body)
          state.adminSupportReplyLoading = false
          if (result?.ok) {
            state.adminSupportMessages = result.messages
            const conv = state.adminSupportConversations.find(c => c.profileId === profileId)
            if (conv) {
              conv.lastMessageIsFromAdmin = true
              conv.lastMessageBody = body
              conv.updatedAt = new Date().toISOString()
            }
          }
          render()
        })()
      },
      onAdminSupportDeleteClick: (profileId) => {
        state.adminSupportDeleteConfirmProfileId = profileId
        render()
      },
      onAdminSupportDeleteCancel: () => {
        state.adminSupportDeleteConfirmProfileId = null
        render()
      },
      onAdminSupportDeleteConfirm: (profileId) => {
        if (state.adminSupportDeleteLoading) return
        state.adminSupportDeleteLoading = true
        render()
        void (async () => {
          const result = await options.onAdminSupportDeleteConversation?.(profileId)
          state.adminSupportDeleteLoading = false
          if (result?.ok) {
            const conv = state.adminSupportConversations.find(c => c.profileId === profileId)
            if (conv) {
              state.supportUnreadCount = Math.max(0, state.supportUnreadCount - conv.unreadByAdmin)
            }
            state.adminSupportConversations = state.adminSupportConversations.filter(c => c.profileId !== profileId)
            if (state.adminSupportSelectedProfileId === profileId) {
              state.adminSupportSelectedProfileId = null
              state.adminSupportMessages = []
            }
            state.adminSupportDeleteConfirmProfileId = null
          }
          render()
        })()
      },
      onPwaUpdateApply: () => {
        state.pwaUpdateApplyFn?.()
      },
    })
  }

  async function submitPresetAvatar(avatarUrl: string): Promise<void> {
    const errorText = options.onPresetAvatarApply
      ? await options.onPresetAvatarApply(avatarUrl)
      : 'Функцията временно не е налична.'

    if (errorText !== null) {
      state.profileEditorErrorText = errorText
      render()
      return
    }

    const authSession = options.getAuthSession?.() ?? null
    if (authSession !== null) {
      state.displayName = authSession.profile.displayName
      state.localAvatarUrl = authSession.profile.avatarUrl
    }

    state.profileEditorErrorText = null
    render()
  }

  async function submitProfileEdit(
    avatarFile: File | null,
    avatarCrop: AvatarCropSelection | null,
    galleryFiles: File[],
  ): Promise<void> {
    const errorText = options.onProfileEditSubmit
      ? await options.onProfileEditSubmit(avatarFile, avatarCrop, galleryFiles)
      : 'Редакцията временно не е налична.'

    if (errorText !== null) {
      state.profileEditorErrorText = errorText
      render()
      return
    }

    const authSession = options.getAuthSession?.() ?? null
    if (authSession !== null) {
      state.displayName = authSession.profile.displayName
      state.localAvatarUrl = authSession.profile.avatarUrl
    }

    state.profileEditorOpen = false
    state.profileEditorErrorText = null
    state.profilePopupOpen = true
    clearProfileEditorPendingState()
    render()
  }

  async function submitProfileNameChange(displayName: string): Promise<void> {
    const errorText = options.onProfileNameChangeSubmit
      ? await options.onProfileNameChangeSubmit(displayName)
      : 'Смяната на име временно не е налична.'

    if (errorText !== null) {
      state.profileNameChangeErrorText = errorText
      state.profileNameChangeSuccessAmount = null
      render()
      return
    }

    const authSession = options.getAuthSession?.() ?? null
    if (authSession !== null) {
      state.displayName = authSession.profile.displayName
      state.localAvatarUrl = authSession.profile.avatarUrl
    }

    state.profileNameChangeErrorText = null
    state.profileNameChangeSuccessAmount =
      state.adminSettings?.profileNameChangePrice ??
      options.getProfileNameChangePrice?.() ??
      50000
    void new Audio('/audio/game-sounds/coins.mp3').play().catch(() => undefined)
    render()
  }

  async function fetchOwnLikesCount(): Promise<void> {
    const apiBaseUrl = options.getApiBaseUrl?.() ?? ''
    try {
      const response = await fetch(`${apiBaseUrl}/api/profile/me`, {
        method: 'GET',
        credentials: 'include',
      })
      if (!response.ok) return
      const data = (await response.json()) as { ok?: boolean; profile?: { likesCount?: number | null } }
      if (data.ok && typeof data.profile?.likesCount === 'number') {
        state.ownLikesCount = data.profile.likesCount
        if (state.profilePopupOpen && state.profilePopupProfile === null) {
          render()
        }
      }
    } catch {
      // silent
    }
  }

  async function submitChangePassword(
    currentPassword: string,
    newPassword: string,
    confirmPassword: string,
  ): Promise<void> {
    if (newPassword !== confirmPassword) {
      state.changePasswordErrorText = 'Новите пароли не съвпадат.'
      render()
      return
    }

    if (newPassword.length < 6) {
      state.changePasswordErrorText = 'Новата парола трябва да е поне 6 символа.'
      render()
      return
    }

    const errorText = options.onChangePasswordSubmit
      ? await options.onChangePasswordSubmit(currentPassword, newPassword)
      : 'Смяната на парола временно не е налична.'

    if (errorText !== null) {
      state.changePasswordErrorText = errorText
      render()
      return
    }

    state.changePasswordPopupOpen = false
    state.changePasswordErrorText = null
    render()
  }

  async function deleteProfileGalleryImage(imageId: string): Promise<void> {
    const errorText = options.onProfileGalleryDelete
      ? await options.onProfileGalleryDelete(imageId)
      : 'Изтриването на снимки временно не е налично.'

    if (errorText !== null) {
      state.profileEditorErrorText = errorText
      render()
      return
    }

    const authSession = options.getAuthSession?.() ?? null
    if (authSession !== null) {
      state.displayName = authSession.profile.displayName
      state.localAvatarUrl = authSession.profile.avatarUrl
    }

    state.profileEditorErrorText = null
    render()
  }

  async function showPlayersDirectory(): Promise<void> {
    state.currentScreen = 'players'
    state.isSearching = false
    state.errorText = null
    state.profilePopupOpen = false
    state.profilePopupProfile = null
    state.profilePopupCanEdit = true
    stopWaitingRoomActivity()
    resetFinalFillSequence()

    if (!options.onPlayersLoad) {
      state.playersErrorText = 'Списъкът с играчи временно не е наличен.'
      render()
      return
    }

    state.playersLoading = true
    state.playersErrorText = null
    render()

    const result = await options.onPlayersLoad()

    if (state.currentScreen !== 'players') {
      return
    }

    state.playersLoading = false

    if (!result.ok) {
      state.playersErrorText = result.message
      render()
      return
    }

    state.players = result.players
    state.playersErrorText = null
    render()
  }

  async function showLeaderboardsDirectory(): Promise<void> {
    state.currentScreen = 'leaderboards'
    state.isSearching = false
    state.errorText = null
    state.profilePopupOpen = false
    state.profilePopupProfile = null
    state.profilePopupCanEdit = true
    stopWaitingRoomActivity()
    resetFinalFillSequence()

    if (!options.onLeaderboardsLoad) {
      state.leaderboardsErrorText = 'Класациите временно не са налични.'
      render()
      return
    }

    state.leaderboardsLoading = true
    state.leaderboardsErrorText = null
    render()

    const result = await options.onLeaderboardsLoad()

    if (state.currentScreen !== 'leaderboards') {
      return
    }

    state.leaderboardsLoading = false

    if (!result.ok) {
      state.leaderboardsErrorText = result.message
      render()
      return
    }

    state.leaderboards = result.leaderboards
    state.leaderboardsErrorText = null
    render()
  }

  async function showShopPanel(): Promise<void> {
    state.currentScreen = 'shop'
    state.isSearching = false
    state.errorText = null
    state.profilePopupOpen = false
    state.profilePopupProfile = null
    state.profilePopupCanEdit = true
    stopWaitingRoomActivity()
    resetFinalFillSequence()

    if (!options.onShopPackagesLoad) {
      state.shopPackagesErrorText = 'Магазинът временно не е наличен.'
      render()
      return
    }

    if (state.shopPackages.length > 0 && state.shopPackagesErrorText === null) {
      render()
      await loadShopPurchases()
      return
    }

    state.shopPackagesLoading = true
    state.shopPurchasesLoading =
      (options.getAuthSession?.() ?? null) !== null && Boolean(options.onShopPurchasesLoad)
    state.shopPackagesErrorText = null
    state.shopPurchaseMessageText = null
    render()

    const result = await options.onShopPackagesLoad()

    if (state.currentScreen !== 'shop') {
      return
    }

    state.shopPackagesLoading = false

    if (!result.ok) {
      state.shopPackagesErrorText = result.message
      state.shopPurchasesLoading = false
      render()
      return
    }

    state.shopPackages = result.packages
    state.shopPackagesErrorText = null
    render()

    await loadShopPurchases()
  }

  async function loadShopPurchases(): Promise<void> {
    const authSession = options.getAuthSession?.() ?? null

    if (state.currentScreen !== 'shop') {
      return
    }

    if (authSession === null) {
      state.shopPurchases = []
      state.shopPurchasesLoading = false
      render()
      return
    }

    if (!options.onShopPurchasesLoad) {
      state.shopPurchasesLoading = false
      render()
      return
    }

    state.shopPurchasesLoading = true
    render()

    const result = await options.onShopPurchasesLoad()

    if (state.currentScreen !== 'shop') {
      return
    }

    state.shopPurchasesLoading = false

    if (!result.ok) {
      state.shopPurchaseMessageText = result.message
      render()
      return
    }

    state.shopPurchases = result.purchases
    render()
  }

  async function startShopPurchase(packageId: string): Promise<void> {
    const authSession = options.getAuthSession?.() ?? null

    if (authSession === null) {
      state.authModalMode = 'cta'
      state.authErrorText = null
      render()
      return
    }

    if (!options.onShopPurchaseStart) {
      state.shopPurchaseMessageText = 'Покупките временно не са налични.'
      render()
      return
    }

    state.shopPurchaseActionPackageId = packageId
    state.shopPurchaseMessageText = null
    render()

    const result = await options.onShopPurchaseStart(packageId)

    state.shopPurchaseActionPackageId = null

    if (!result.ok) {
      state.shopPurchaseMessageText = result.message
      render()
      return
    }

    state.shopPurchases = result.purchases
    state.shopPurchaseMessageText = result.message
    render()
  }

  async function loadAdminDailyRewards(): Promise<void> {
    if (!options.onAdminDailyRewardsLoad) return
    state.adminDailyRewardsLoading = true
    state.adminDailyRewardsErrorText = null
    render()
    const result = await options.onAdminDailyRewardsLoad()
    state.adminDailyRewardsLoading = false
    if (!result.ok) {
      state.adminDailyRewardsErrorText = result.message
    } else {
      state.adminActiveDailyRewardTiers = result.activeTiers
      state.adminStagedDailyRewardTiers = result.stagedTiers
    }
    render()
  }

  async function addAdminDailyReward(amount: number): Promise<void> {
    if (!options.onAdminDailyRewardAdd) return
    state.adminDailyRewardAddLoading = true
    state.adminDailyRewardAddErrorText = null
    render()
    const result = await options.onAdminDailyRewardAdd(amount)
    state.adminDailyRewardAddLoading = false
    if (!result.ok) {
      state.adminDailyRewardAddErrorText = result.message
    } else {
      state.adminActiveDailyRewardTiers = result.activeTiers
      state.adminStagedDailyRewardTiers = result.stagedTiers
      state.adminDailyRewardAddErrorText = null
    }
    render()
  }

  async function removeAdminDailyReward(tierId: string): Promise<void> {
    if (!options.onAdminDailyRewardRemove) return
    const result = await options.onAdminDailyRewardRemove(tierId)
    if (result.ok) {
      state.adminActiveDailyRewardTiers = result.activeTiers
      state.adminStagedDailyRewardTiers = result.stagedTiers
      render()
    }
  }

  async function openDailyRewardsPopup(): Promise<void> {
    state.dailyRewardsPopupOpen = true
    state.dailyRewardClaimErrorText = null
    state.dailyRewardLastAwarded = null
    state.dailyRewardsLoading = true
    state.dailyRewardsErrorText = null
    render()
    if (!options.onDailyRewardsLoad) {
      state.dailyRewardsLoading = false
      state.dailyRewardsErrorText = 'Системата не е налична.'
      render()
      return
    }
    const result = await options.onDailyRewardsLoad()
    state.dailyRewardsLoading = false
    if (!result.ok) {
      state.dailyRewardsErrorText = result.message
    } else {
      state.dailyRewardTiers = result.tiers
    }
    render()
  }

  async function loadDailyRewardsStatus(): Promise<void> {
    const authSession = options.getAuthSession?.() ?? null
    if (authSession === null || !options.onDailyRewardsLoad) {
      state.dailyRewardTiers = []
      scheduleRender()
      return
    }

    const result = await options.onDailyRewardsLoad()
    if (result.ok) {
      state.dailyRewardTiers = result.tiers
      scheduleRender()
    }
  }

  async function claimDailyReward(tierId: string): Promise<void> {
    if (!options.onDailyRewardClaim) return
    state.dailyRewardClaimingId = tierId
    state.dailyRewardClaimErrorText = null
    render()
    const result = await options.onDailyRewardClaim(tierId)
    state.dailyRewardClaimingId = null
    if (!result.ok) {
      state.dailyRewardClaimErrorText = result.message
    } else {
      state.dailyRewardTiers = result.tiers
      state.dailyRewardLastAwarded = result.yellowCoinsAwarded
    }
    render()
  }

  async function showAdminInfoPanel(): Promise<void> {
    const authSession = options.getAuthSession?.() ?? null

    if (authSession?.account.role !== 'admin') {
      state.currentScreen = 'lobby'
      state.errorText = 'Нямаш достъп до admin панела.'
      render()
      return
    }

    state.currentScreen = 'admin-info'
    state.isSearching = false
    state.errorText = null
    state.profilePopupOpen = false
    state.profilePopupProfile = null
    state.profilePopupCanEdit = true
    stopWaitingRoomActivity()
    resetFinalFillSequence()

    state.adminStats = null
    state.adminStatsLoading = true
    state.adminStatsErrorText = null
    render()

    if (!options.onAdminStatsLoad) {
      state.adminStatsLoading = false
      state.adminStatsErrorText = 'Статистиките не са налични.'
      render()
      return
    }

    const result = await options.onAdminStatsLoad()
    state.adminStatsLoading = false

    if (!result.ok) {
      state.adminStatsErrorText = result.message
      render()
      return
    }

    state.adminStats = result.stats
    render()
  }

  async function showAdminPanel(): Promise<void> {
    const authSession = options.getAuthSession?.() ?? null

    if (authSession?.account.role !== 'admin') {
      state.currentScreen = 'lobby'
      state.errorText = 'Нямаш достъп до админ панела.'
      render()
      return
    }

    state.currentScreen = 'admin'
    state.isSearching = false
    state.errorText = null
    state.profilePopupOpen = false
    state.profilePopupProfile = null
    state.profilePopupCanEdit = true
    stopWaitingRoomActivity()
    resetFinalFillSequence()

    if (!options.onAdminSettingsLoad) {
      state.adminSettingsErrorText = 'Админ настройките временно не са налични.'
      render()
      return
    }

    state.adminSettingsLoading = true
    state.adminSettingsErrorText = null
    state.adminCoinPackagesLoading = Boolean(options.onAdminCoinPackagesLoad)
    state.adminCoinPackagesErrorText = null
    state.adminActiveDailyRewardTiers = []
    state.adminStagedDailyRewardTiers = []
    state.adminDailyRewardsLoading = true
    state.adminDailyRewardsErrorText = null
    render()

    void loadAdminDailyRewards()

    const result = await options.onAdminSettingsLoad()

    if (state.currentScreen !== 'admin') {
      return
    }

    state.adminSettingsLoading = false

    if (!result.ok) {
      state.adminSettingsErrorText = result.message
      state.adminCoinPackagesLoading = false
      render()
      return
    }

    state.adminSettings = result.settings
    state.adminSettingsErrorText = null
    render()

    await Promise.all([loadAdminCoinPackages(), loadAdminMissions(), loadAdminSupportConversations(), loadMatchRooms()])
  }

  async function loadAdminSupportConversations(): Promise<void> {
    if (state.currentScreen !== 'admin' && state.currentScreen !== 'support') return
    if (!options.onAdminSupportConversationsLoad) return
    state.adminSupportConversationsLoading = true
    render()
    const result = await options.onAdminSupportConversationsLoad()
    if (state.currentScreen !== 'admin' && state.currentScreen !== 'support') return
    state.adminSupportConversationsLoading = false
    if (result.ok) {
      state.adminSupportConversations = result.conversations
    }
    render()
  }

  async function submitAdminSettings(settings: AdminSettingsSnapshot): Promise<void> {
    if (!options.onAdminSettingsSubmit) {
      state.adminSettingsErrorText = 'Админ настройките временно не са налични.'
      render()
      return
    }

    state.adminSettingsErrorText = null
    render()

    const result = await options.onAdminSettingsSubmit(settings)

    if (!result.ok) {
      state.adminSettingsErrorText = result.message
      render()
      return
    }

    state.adminSettings = result.settings
    state.adminSettingsErrorText = null
    render()
  }

  async function loadAdminCoinPackages(): Promise<void> {
    if (state.currentScreen !== 'admin') {
      return
    }

    if (!options.onAdminCoinPackagesLoad) {
      state.adminCoinPackagesLoading = false
      state.adminCoinPackagesErrorText = 'Админ пакетите временно не са налични.'
      render()
      return
    }

    state.adminCoinPackagesLoading = true
    state.adminCoinPackagesErrorText = null
    render()

    const result = await options.onAdminCoinPackagesLoad()

    if (state.currentScreen !== 'admin') {
      return
    }

    state.adminCoinPackagesLoading = false

    if (!result.ok) {
      state.adminCoinPackagesErrorText = result.message
      render()
      return
    }

    state.adminCoinPackages = result.packages
    state.adminCoinPackagesErrorText = null
    render()
  }

  async function submitAdminCoinPackage(input: CoinPackageInput): Promise<void> {
    if (!options.onAdminCoinPackageSubmit) {
      state.adminCoinPackagesErrorText = 'Записът на пакети временно не е наличен.'
      render()
      return
    }

    state.adminCoinPackagesErrorText = null
    render()

    const result = await options.onAdminCoinPackageSubmit(input)

    if (!result.ok) {
      state.adminCoinPackagesErrorText = result.message
      render()
      return
    }

    state.adminCoinPackages = result.packages
    state.adminCoinPackagesErrorText = null
    state.adminCoinPackageEditId = null
    render()
  }

  function editAdminCoinPackage(packageId: string): void {
    state.adminCoinPackageEditId = packageId.length > 0 ? packageId : null
    render()
  }

  async function deleteAdminCoinPackage(packageId: string): Promise<void> {
    if (!options.onAdminCoinPackageDelete) {
      state.adminCoinPackagesErrorText = 'Изтриването на пакети временно не е налично.'
      render()
      return
    }

    state.adminCoinPackagesErrorText = null
    render()

    const result = await options.onAdminCoinPackageDelete(packageId)

    if (!result.ok) {
      state.adminCoinPackagesErrorText = result.message
      render()
      return
    }

    state.adminCoinPackages = result.packages
    if (state.adminCoinPackageEditId === packageId) {
      state.adminCoinPackageEditId = null
    }
    state.adminCoinPackagesErrorText = null
    render()
  }

  async function setAdminCoinPackageStatus(
    packageId: string,
    status: CoinPackageStatus,
  ): Promise<void> {
    if (!options.onAdminCoinPackageStatusChange) {
      state.adminCoinPackagesErrorText = 'Промяната на статус временно не е налична.'
      render()
      return
    }

    state.adminCoinPackagesErrorText = null
    render()

    const result = await options.onAdminCoinPackageStatusChange(packageId, status)

    if (!result.ok) {
      state.adminCoinPackagesErrorText = result.message
      render()
      return
    }

    state.adminCoinPackages = result.packages
    state.adminCoinPackagesErrorText = null
    render()
  }

  async function loadLobbyPackages(): Promise<void> {
    if (!options.onLobbyPackagesLoad) {
      _initPackagesDone = true
      maybeHideInitialOverlay()
      return
    }

    const result = await options.onLobbyPackagesLoad()
    _initPackagesDone = true
    maybeHideInitialOverlay()

    if (result.ok) {
      state.lobbyPackages = result.packages
      scheduleRender()
    }
  }

  async function toggleAdminCoinPackageLobbyVisibility(
    packageId: string,
    showInLobby: boolean,
  ): Promise<void> {
    // Optimistic update using adminCoinPackages as source of truth
    state.adminCoinPackages = state.adminCoinPackages.map((p) =>
      p.packageId === packageId ? { ...p, showInLobby } : p
    )
    state.lobbyPackages = state.adminCoinPackages.filter((p) => p.showInLobby && p.status === 'active')
    state.shopPackages = state.shopPackages.map((p) =>
      p.packageId === packageId ? { ...p, showInLobby } : p
    )
    state.adminCoinPackagesErrorText = null
    render()

    if (!options.onAdminCoinPackageLobbyToggle) {
      // Revert optimistic update
      state.adminCoinPackages = state.adminCoinPackages.map((p) =>
        p.packageId === packageId ? { ...p, showInLobby: !showInLobby } : p
      )
      state.lobbyPackages = state.adminCoinPackages.filter((p) => p.showInLobby && p.status === 'active')
      state.shopPackages = state.shopPackages.map((p) =>
        p.packageId === packageId ? { ...p, showInLobby: !showInLobby } : p
      )
      state.adminCoinPackagesErrorText = 'Промяната на лоби видимост временно не е налична.'
      render()
      return
    }

    const result = await options.onAdminCoinPackageLobbyToggle(packageId, showInLobby)

    if (!result.ok) {
      // Revert optimistic update on API error
      state.adminCoinPackages = state.adminCoinPackages.map((p) =>
        p.packageId === packageId ? { ...p, showInLobby: !showInLobby } : p
      )
      state.lobbyPackages = state.adminCoinPackages.filter((p) => p.showInLobby && p.status === 'active')
      state.shopPackages = state.shopPackages.map((p) =>
        p.packageId === packageId ? { ...p, showInLobby: !showInLobby } : p
      )
      state.adminCoinPackagesErrorText = result.message
      render()
      return
    }

    state.adminCoinPackages = result.packages
    state.shopPackages = state.shopPackages.map((p) => {
      const updated = result.packages.find((r) => r.packageId === p.packageId)
      return updated !== undefined ? { ...p, showInLobby: updated.showInLobby } : p
    })
    state.adminCoinPackagesErrorText = null
    render()
    void loadLobbyPackages()
  }

  async function ensureFriendshipsLoaded(): Promise<void> {
    if (state.friendships !== null) {
      return
    }

    const authSession = options.getAuthSession?.() ?? null

    if (authSession === null || !options.onFriendshipsLoad) {
      return
    }

    const result = await options.onFriendshipsLoad()

    if (!result.ok) {
      state.friendsErrorText = result.message
      if (state.profilePopupOpen) {
        renderPopupOnly()
      } else {
        render()
      }
      return
    }

    state.friendships = result.friendships
    state.friendsErrorText = null
    if (state.profilePopupOpen) {
      renderPopupOnly()
    } else {
      render()
    }
  }

  async function showFriendsDirectory(): Promise<void> {
    state.currentScreen = 'friends'
    state.isSearching = false
    state.errorText = null
    state.profilePopupOpen = false
    state.profilePopupProfile = null
    state.profilePopupCanEdit = true
    stopWaitingRoomActivity()
    resetFinalFillSequence()

    const authSession = options.getAuthSession?.() ?? null

    if (authSession === null) {
      state.currentScreen = 'lobby'
      state.authModalMode = 'cta'
      state.authErrorText = null
      render()
      return
    }

    if (!options.onFriendshipsLoad) {
      state.friendsErrorText = 'Панелът с приятели временно не е наличен.'
      render()
      return
    }

    state.friendsLoading = true
    state.friendsErrorText = null
    render()

    const result = await options.onFriendshipsLoad()

    if (state.currentScreen !== 'friends') {
      return
    }

    state.friendsLoading = false

    if (!result.ok) {
      state.friendsErrorText = result.message
      render()
      return
    }

    state.friendships = result.friendships
    state.friendsErrorText = null
    render()
  }

  async function likeProfile(profileId: string): Promise<void> {
    const result = await options.onLikeProfile?.(profileId)
    if (!result?.ok) return

    const applyLike = (p: PlayerPublicProfileSnapshot): PlayerPublicProfileSnapshot =>
      p.profileId === profileId
        ? { ...p, hasLikedByMe: result.liked, likesCount: result.likesCount }
        : p

    state.players = state.players.map(applyLike)

    if (state.leaderboards) {
      const updated: LeaderboardsSnapshot = {} as LeaderboardsSnapshot
      for (const key of Object.keys(state.leaderboards) as (keyof LeaderboardsSnapshot)[]) {
        updated[key] = state.leaderboards[key].map(applyLike)
      }
      state.leaderboards = updated
    }

    if (state.profilePopupProfile?.profileId === profileId) {
      state.profilePopupProfile = applyLike(state.profilePopupProfile)
    }

    renderPopupOnly()
  }

  async function submitFriendRequest(profileId: string): Promise<void> {
    const authSession = options.getAuthSession?.() ?? null

    if (authSession === null) {
      state.authModalMode = 'cta'
      state.authErrorText = null
      state.friendActionMessageProfileId = profileId
      state.friendActionMessage = null
      render()
      return
    }

    if (!options.onFriendRequestSubmit) {
      state.friendActionMessageProfileId = profileId
      state.friendActionMessage = 'Поканите временно не са налични.'
      render()
      return
    }

    const targetIsBot = state.profilePopupProfile?.profileId === profileId && state.profilePopupProfile?.isBot === true

    state.friendActionLoadingProfileId = profileId
    state.friendActionMessageProfileId = profileId
    state.friendActionMessage = targetIsBot ? 'Чака се отговор за покана за приятелство...' : null
    render()

    const [result] = await Promise.all([
      options.onFriendRequestSubmit(profileId),
      targetIsBot ? new Promise<void>((resolve) => setTimeout(resolve, 3000)) : Promise.resolve(),
    ])

    state.friendActionLoadingProfileId = null

    if (!result.ok) {
      state.friendActionMessageProfileId = profileId
      state.friendActionMessage = targetIsBot
        ? 'Поканата беше отхвърлена от играча.'
        : result.message
      render()
      return
    }

    state.friendships = result.friendships
    state.friendActionMessageProfileId = profileId
    state.friendActionMessage = 'Поканата е изпратена.'
    render()
  }

  async function acceptFriendRequest(friendshipId: string): Promise<void> {
    const result = options.onFriendAccept
      ? await options.onFriendAccept(friendshipId)
      : { ok: false as const, message: 'Поканите временно не са налични.' }

    if (!result.ok) {
      state.friendsErrorText = result.message
      render()
      return
    }

    state.friendships = result.friendships
    state.friendsErrorText = null
    render()
  }

  async function rejectFriendRequest(friendshipId: string): Promise<void> {
    const result = options.onFriendReject
      ? await options.onFriendReject(friendshipId)
      : { ok: false as const, message: 'Поканите временно не са налични.' }

    if (!result.ok) {
      state.friendsErrorText = result.message
      render()
      return
    }

    state.friendships = result.friendships
    state.friendsErrorText = null
    render()
  }

  async function removeFriendRelationship(friendshipId: string): Promise<void> {
    const result = options.onFriendRemove
      ? await options.onFriendRemove(friendshipId)
      : { ok: false as const, message: 'Премахването временно не е налично.' }

    if (!result.ok) {
      state.friendsErrorText = result.message
      render()
      return
    }

    state.friendships = result.friendships
    state.friendsErrorText = null
    render()
  }

  async function blockProfile(profileId: string): Promise<void> {
    const authSession = options.getAuthSession?.() ?? null

    if (authSession === null) {
      state.authModalMode = 'cta'
      state.authErrorText = null
      render()
      return
    }

    if (!options.onBlockProfile) return

    const result = await options.onBlockProfile(profileId)

    if ('ok' in result && !result.ok) {
      const asLimitError = result as unknown as { ok: false; limitReached?: true; message: string }
      if (asLimitError.limitReached) {
        state.blockLimitPopupOpen = true
        render()
        return
      }
      state.friendActionMessageProfileId = profileId
      state.friendActionMessage = asLimitError.message
      render()
      return
    }

    const { blocked } = result as { blocked: boolean }

    const updateProfile = (p: PlayerPublicProfileSnapshot) =>
      p.profileId === profileId ? { ...p, isBlockedByMe: blocked } : p

    state.players = state.players.map(updateProfile)
    state.leaderboards = state.leaderboards
      ? {
          balance: state.leaderboards.balance.map(updateProfile),
          rank: state.leaderboards.rank.map(updateProfile),
          wins: state.leaderboards.wins.map(updateProfile),
          rating: state.leaderboards.rating.map(updateProfile),
        }
      : state.leaderboards
    if (state.profilePopupProfile?.profileId === profileId) {
      state.profilePopupProfile = { ...state.profilePopupProfile, isBlockedByMe: blocked }
    }
    if (blocked && state.blockedPlayers !== null) {
      const existing = state.blockedPlayers.find((p) => p.profileId === profileId)
      if (!existing && state.profilePopupProfile) {
        state.blockedPlayers = [state.profilePopupProfile, ...state.blockedPlayers]
      }
    } else if (!blocked && state.blockedPlayers !== null) {
      state.blockedPlayers = state.blockedPlayers.filter((p) => p.profileId !== profileId)
    }

    state.friendActionMessageProfileId = profileId
    state.friendActionMessage = blocked ? 'Играчът е блокиран.' : 'Играчът е деблокиран.'
    renderPopupOnly()
  }

  async function openBlockedPlayersPopup(): Promise<void> {
    const authSession = options.getAuthSession?.() ?? null
    if (authSession === null) {
      state.authModalMode = 'cta'
      state.authErrorText = null
      render()
      return
    }

    state.blockedPlayersPopupOpen = true
    if (state.blockedPlayers === null) {
      state.blockedPlayersLoading = true
      state.blockedPlayersErrorText = null
    }
    render()

    if (!options.onLoadBlockedPlayers) return

    const result = await options.onLoadBlockedPlayers()
    if (!result.ok) {
      state.blockedPlayersLoading = false
      state.blockedPlayersErrorText = result.message
    } else {
      state.blockedPlayers = result.profiles
      state.blockedPlayersLimit = result.limit
      state.blockedPlayersLoading = false
      state.blockedPlayersErrorText = null
    }
    render()
  }

  async function unblockPlayer(profileId: string): Promise<void> {
    if (!options.onBlockProfile) return

    const result = await options.onBlockProfile(profileId)
    if ('ok' in result && !result.ok) return

    state.blockedPlayers = (state.blockedPlayers ?? []).filter((p) => p.profileId !== profileId)

    const updateProfile = (p: PlayerPublicProfileSnapshot) =>
      p.profileId === profileId ? { ...p, isBlockedByMe: false } : p
    state.players = state.players.map(updateProfile)
    if (state.profilePopupProfile?.profileId === profileId) {
      state.profilePopupProfile = { ...state.profilePopupProfile, isBlockedByMe: false }
    }
    render()
  }

  function openGiftModal(friendshipId: string): void {
    const relationships = state.friendships
      ? [
          ...state.friendships.friends,
          ...state.friendships.incomingPending,
          ...state.friendships.outgoingPending,
        ]
      : []
    const relationship = relationships.find((item) => {
      return item.friendshipId === friendshipId
    })

    state.giftModalFriendshipId = friendshipId
    state.giftModalFriendName = relationship?.profile.displayName ?? 'приятел'
    state.giftModalErrorText = null
    render()
  }

  function closeGiftModal(): void {
    state.giftModalFriendshipId = null
    state.giftModalFriendName = ''
    state.giftModalErrorText = null
    render()
  }

  async function submitGiftCoins(
    friendshipId: string,
    amount: number,
  ): Promise<void> {
    if (!options.onGiftCoinsSubmit) {
      state.giftModalErrorText = 'Подаряването временно не е налично.'
      render()
      return
    }

    const result = await options.onGiftCoinsSubmit(friendshipId, amount)

    if (!result.ok) {
      state.giftModalErrorText = result.message
      render()
      return
    }

    const friendName = state.giftModalFriendName
    state.giftModalFriendshipId = null
    state.giftModalFriendName = ''
    state.giftModalErrorText = null
    state.giftSuccessModal = { amount, friendName }
    state.profilePopupProfile = result.recipientProfile
    state.friendActionMessageProfileId = result.recipientProfile.profileId
    state.friendActionMessage = `Подаръкът от ${amount} жълтици е изпратен.`
    render()
  }

  async function loadChatConversations(): Promise<boolean> {
    if (!options.onChatConversationsLoad) {
      state.chatErrorText = 'Чатът временно не е наличен.'
      return false
    }

    const result = await options.onChatConversationsLoad()

    if (!result.ok) {
      state.chatErrorText = result.message
      return false
    }

    state.chatConversations = result.conversations
    state.chatErrorText = null

    if (
      state.activeChatFriendshipId !== null &&
      !state.chatConversations.some((conversation) => {
        return conversation.friendshipId === state.activeChatFriendshipId
      })
    ) {
      state.activeChatFriendshipId = null
      state.chatMessages = []
    }

    return true
  }

  async function showChatPanel(): Promise<void> {
    state.currentScreen = 'chat'
    state.isSearching = false
    state.errorText = null
    state.profilePopupOpen = false
    state.profilePopupProfile = null
    state.profilePopupCanEdit = true
    stopWaitingRoomActivity()
    resetFinalFillSequence()

    const authSession = options.getAuthSession?.() ?? null

    if (authSession === null) {
      state.currentScreen = 'lobby'
      state.authModalMode = 'cta'
      state.authErrorText = null
      render()
      return
    }

    state.chatLoading = true
    state.chatErrorText = null
    render()

    const loaded = await loadChatConversations()

    if (state.currentScreen !== 'chat') {
      return
    }

    state.chatLoading = false

    if (!loaded) {
      render()
      return
    }

    const firstConversation = state.chatConversations[0] ?? null

    if (firstConversation !== null && state.activeChatFriendshipId === null) {
      state.activeChatFriendshipId = firstConversation.friendshipId
      await openChatConversation(firstConversation.friendshipId, false)
      return
    }

    render()
  }

  async function openChatConversation(
    friendshipId: string,
    shouldRenderLoading = true,
  ): Promise<void> {
    if (!options.onChatMessagesLoad) {
      state.chatErrorText = 'Чатът временно не е наличен.'
      render()
      return
    }

    state.activeChatFriendshipId = friendshipId
    state.chatMessagesLoading = true
    state.chatErrorText = null

    if (shouldRenderLoading) {
      render()
    }

    const result = await options.onChatMessagesLoad(friendshipId)

    if (state.activeChatFriendshipId !== friendshipId) {
      return
    }

    state.chatMessagesLoading = false

    if (!result.ok) {
      state.chatErrorText = result.message
      render()
      return
    }

    state.chatMessages = result.messages
    state.chatErrorText = null
    render()
  }

  async function sendChatMessage(
    friendshipId: string,
    body: string,
  ): Promise<void> {
    if (!options.onChatSend) {
      state.chatErrorText = 'Чатът временно не е наличен.'
      render()
      return
    }

    const result = await options.onChatSend(friendshipId, body)

    if (!result.ok) {
      state.chatErrorText = result.message
      render()
      return
    }

    state.chatMessages = result.messages
    state.chatErrorText = null
    state.activeChatFriendshipId = friendshipId
    const existingConversation = state.chatConversations.find(
      (c) => c.friendshipId === result.conversation.friendshipId,
    )
    const updatedConversation = existingConversation?.friend.isOnline !== undefined
      ? { ...result.conversation, friend: { ...result.conversation.friend, isOnline: existingConversation.friend.isOnline } }
      : result.conversation
    state.chatConversations = [
      updatedConversation,
      ...state.chatConversations.filter((conversation) => {
        return conversation.friendshipId !== result.conversation.friendshipId
      }),
    ]
    render()
  }

  async function refreshChatAfterNotification(friendshipId: string): Promise<void> {
    await loadChatConversations()

    if (
      state.currentScreen === 'chat' &&
      state.activeChatFriendshipId === friendshipId &&
      options.onChatMessagesLoad
    ) {
      const result = await options.onChatMessagesLoad(friendshipId)

      if (result.ok) {
        state.chatMessages = result.messages
        state.chatErrorText = null
      } else {
        state.chatErrorText = result.message
      }
    }

    render()
  }

  async function submitLogin(email: string, password: string): Promise<void> {
    if (state.authSubmitInFlight) {
      return
    }

    state.authSubmitInFlight = true
    const errorText = options.onLoginSubmit
      ? await options.onLoginSubmit(email.trim(), password)
      : 'Входът временно не е наличен.'

    if (errorText !== null) {
      state.authSubmitInFlight = false
      const el = options.root.querySelector<HTMLElement>('[data-lobby-auth-error="1"]')
      if (el) { el.textContent = errorText; el.style.display = '' }
      return
    }

    state.authSubmitInFlight = false
    state.authModalMode = 'closed'
    state.authErrorText = null
    const authSession = options.getAuthSession?.() ?? null
    if (authSession !== null) {
      state.displayName = authSession.profile.displayName
      state.localAvatarUrl = authSession.profile.avatarUrl
    }
    render()
  }

  async function submitRegister(
    displayName: string,
    email: string,
    password: string,
    gender: 'male' | 'female' | null,
  ): Promise<void> {
    if (state.authSubmitInFlight) {
      return
    }

    state.authSubmitInFlight = true
    const errorText = options.onRegisterSubmit
      ? await options.onRegisterSubmit(displayName.trim(), email.trim(), password, gender)
      : 'Регистрацията временно не е налична.'

    if (errorText !== null) {
      state.authSubmitInFlight = false
      const el = options.root.querySelector<HTMLElement>('[data-lobby-auth-error="1"]')
      if (el) { el.textContent = errorText; el.style.display = '' }
      return
    }

    state.authSubmitInFlight = false
    state.authModalMode = 'closed'
    state.authErrorText = null
    const authSession = options.getAuthSession?.() ?? null
    if (authSession !== null) {
      state.displayName = authSession.profile.displayName
      state.localAvatarUrl = authSession.profile.avatarUrl
    }
    render()
  }

  function startMatchmaking(stake: MatchStake, displayName?: string): void {
    state.selectedStake = stake

    if (displayName !== undefined) {
      state.displayName = displayName
    }

    const authSession = options.getAuthSession?.() ?? null

    if (authSession === null) {
      state.currentScreen = 'lobby'
      state.isSearching = false
      state.errorText = null
      state.authModalMode = 'cta'
      state.authErrorText = null
      render()
      return
    }

    state.displayName = authSession.profile.displayName

    const balance = authSession.profile.yellowCoinsBalance ?? 0
    if (balance < stake) {
      state.lowCoinsModalOpen = true
      render()
      return
    }

    if (!state.isConnected) {
      state.currentScreen = 'lobby'
      state.isSearching = false
      state.errorText = 'Няма връзка със сървъра.'
      render()
      return
    }

    const stakeRoom = state.matchRooms.find((r) => r.stakeAmount === stake)
    const optimisticCountdownMs = (stakeRoom?.minLevel ?? 1) > 7 ? 60000 : DEFAULT_COUNTDOWN_MS

    state.errorText = null
    state.isSearching = true
    state.currentScreen = 'matchmaking-room'
    state.queuedPlayers = 1
    state.requiredPlayers = DEFAULT_REQUIRED_PLAYERS
    state.remainingMs = optimisticCountdownMs
    state.countdownEndsAt = Date.now() + optimisticCountdownMs
    state.totalCountdownMs = optimisticCountdownMs
    state.serverPreviewBotDisplayNames = []
    clearServerRoomSnapshot()
    resetFinalFillSequence()

    options.joinMatchmaking(stake, state.displayName.trim() || undefined)

    startWaitingClockAudio()
    render()
  }

  function paintMatchmakingRoom(): void {
    const remainingMs = clamp(
      getLobbyRemainingMs(state) ?? state.totalCountdownMs,
      0,
      state.totalCountdownMs,
    )
    const displayedQueuedPlayers = getDisplayedQueuedPlayers()

    options.root.innerHTML = renderMatchmakingRoomScreen({
      prizeAmount: getStakePrizeAmount(state.selectedStake),
      entryAmount: state.selectedStake,
      localPlayer: createDisplayedLocalPlayer(),
      joinedPlayers: createDisplayedJoinedPlayers(),
      countdownRemainingMs: remainingMs,
      countdownTotalMs: state.totalCountdownMs,
      statusText: getRoomStatusText(state, displayedQueuedPlayers),
      canLeave: displayedQueuedPlayers <= 1,
    })

    const cancelButtons = options.root.querySelectorAll<HTMLButtonElement>(
      '[data-matchmaking-room-cancel-button="1"]',
    )

    cancelButtons.forEach((cancelButton) => {
      cancelButton.addEventListener('click', () => {
        if (getDisplayedQueuedPlayers() > 1) return
        options.tryUnlockDocumentAudio?.()
        state.errorText = null
        switchToLobby()
        options.leaveMatchmaking()
        render()
      })
    })

    syncLiveCountdownTargets()
    updateMatchmakingRoomLiveUi()
    syncSeatFillSounds(displayedQueuedPlayers)
  }

  function startLiveCountdownLoop(): void {
    clearUiTickLoop()

    if (state.currentScreen !== 'matchmaking-room' || !state.isSearching) {
      return
    }

    const frameStep = (): void => {
      countdownAnimationFrameId = null

      if (state.currentScreen !== 'matchmaking-room' || !state.isSearching) {
        return
      }

      const fillSequenceChanged = updateFinalFillSequenceProgress()

      if (fillSequenceChanged) {
        paintMatchmakingRoom()
      } else {
        const shouldContinue = updateMatchmakingRoomLiveUi()

        if (!shouldContinue) {
          return
        }
      }

      countdownAnimationFrameId = window.requestAnimationFrame(frameStep)
    }

    countdownAnimationFrameId = window.requestAnimationFrame(frameStep)
  }

  const SCREEN_TO_PATH: Partial<Record<LobbySocialScreen, string>> = {
    lobby: '/lobby',
    players: '/players',
    leaderboards: '/ranking',
    shop: '/shop',
    admin: '/admin',
    friends: '/friends',
    chat: '/chat',
  }

  const PATH_TO_SCREEN: Record<string, LobbySocialScreen> = {
    '/lobby': 'lobby',
    '/players': 'players',
    '/ranking': 'leaderboards',
    '/shop': 'shop',
    '/admin': 'admin',
    '/friends': 'friends',
    '/chat': 'chat',
  }

  const _loadPath = window.location.pathname
  let _pendingInitialNav = false
  let _navigationReady = false

  function syncUrlPath(): void {
    if (!_navigationReady || _pendingInitialNav) return
    if (document.getElementById('pwa-landing-overlay') !== null) return
    const path = SCREEN_TO_PATH[state.currentScreen] ?? '/lobby'
    if (path === window.location.pathname) return
    history.pushState(null, '', path)
  }

  function navigateFromPath(path: string): void {
    const screen = PATH_TO_SCREEN[path] ?? null
    if (screen === null) {
      switchToLobby()
      render()
      return
    }
    switch (screen) {
      case 'lobby': switchToLobby(); render(); break
      case 'players': void showPlayersDirectory(); break
      case 'leaderboards': void showLeaderboardsDirectory(); break
      case 'shop': void showShopPanel(); break
      case 'admin': void showAdminPanel(); break
      case 'admin-info': void showAdminInfoPanel(); break
      case 'friends': void showFriendsDirectory(); break
      case 'chat': void showChatPanel(); break
    }
  }

  function renderMatchmakingRoom(): void {
    paintMatchmakingRoom()
    startLiveCountdownLoop()
  }

  function render(): void {
    if (_renderTimerId !== null) {
      clearTimeout(_renderTimerId)
      _renderTimerId = null
    }
    if (shouldSuppressLobbyRender()) {
      return
    }
    if (state.authModalMode !== 'closed') {
      if (state.authSubmitInFlight) {
        return
      }

      const activeElement = document.activeElement
      const authModal = options.root.querySelector<HTMLElement>('[data-lobby-auth-modal-root="1"]')
      const isTextFieldFocused =
        activeElement instanceof HTMLInputElement ||
        activeElement instanceof HTMLTextAreaElement ||
        activeElement instanceof HTMLSelectElement ||
        (activeElement instanceof HTMLElement && activeElement.isContentEditable)

      if (authModal !== null && activeElement !== null && isTextFieldFocused && authModal.contains(activeElement)) {
        return
      }
    }
    if (state.currentScreen === 'matchmaking-room') {
      renderMatchmakingRoom()
      return
    }

    renderLobby()
    syncUrlPath()
  }

  function buildPopupFriendshipAction() {
    const authSession = options.getAuthSession?.() ?? null
    const friendshipAction = createProfileFriendshipAction(authSession)
    const acceptedRelationship =
      state.profilePopupProfile?.profileId
        ? findRelationshipByProfileId(state.friendships, state.profilePopupProfile.profileId)
        : null
    if (friendshipAction !== null && acceptedRelationship?.status === 'accepted') {
      friendshipAction.giftFriendshipId = acceptedRelationship.friendshipId
    }
    return friendshipAction
  }

  function getPopupCallbacks(): ProfilePopupCallbacks {
    return {
      onClose: () => {
        state.profilePopupOpen = false
        state.profilePopupProfile = null
        state.profilePopupCanEdit = true
        syncProfilePopup({ isOpen: false, profile: null, canEdit: false, friendshipAction: null }, getPopupCallbacks())
      },
      onEditClick: () => {
        state.profileEditorOpen = true
        state.profileEditorErrorText = null
        state.profilePopupOpen = false
        syncProfilePopup({ isOpen: false, profile: null, canEdit: false, friendshipAction: null }, getPopupCallbacks())
        render()
      },
      onFriendRequestClick: (profileId) => { void submitFriendRequest(profileId) },
      onBlockClick: (profileId) => { void blockProfile(profileId) },
      onFriendAcceptClick: (friendshipId) => { void acceptFriendRequest(friendshipId) },
      onFriendRejectClick: (friendshipId) => { void rejectFriendRequest(friendshipId) },
      onFriendRemoveClick: (friendshipId) => { void removeFriendRelationship(friendshipId) },
      onGiftCoinsClick: (friendshipId) => { openGiftModal(friendshipId) },
      onLikeClick: (profileId) => { void likeProfile(profileId) },
    }
  }

  function renderPopupOnly(): void {
    const authSession = options.getAuthSession?.() ?? null
    syncProfilePopup(
      {
        isOpen: state.profilePopupOpen,
        profile: state.profilePopupProfile ?? createLocalProfilePreview(state, authSession),
        canEdit: state.profilePopupCanEdit,
        isAdmin: authSession?.account.role === 'admin',
        friendshipAction: buildPopupFriendshipAction(),
      },
      getPopupCallbacks(),
    )
  }

  function resetToLobby(): void {
    switchToLobby()
    render()
    void loadPlayerUnclaimedCount()
  }

  function handleServerMessage(message: ServerMessage): boolean {
    if (message.type === 'connected') {
      state.errorText = null
      if (_pendingInitialNav) {
        _pendingInitialNav = false
        navigateFromPath(_loadPath)
      } else {
        render()
      }
      return true
    }

    if (message.type === 'pending_friend_requests') {
      state.pendingFriendRequests = message.requests
      render()
      return true
    }

    if (message.type === 'pending_gift_notifications') {
      state.pendingGiftNotifications = message.gifts
      render()
      return true
    }

    if (message.type === 'friend_request_received') {
      const alreadyExists = state.pendingFriendRequests.some((r) => r.friendshipId === message.friendshipId)
      if (!alreadyExists) {
        state.pendingFriendRequests = [...state.pendingFriendRequests, {
          friendshipId: message.friendshipId,
          fromProfileId: message.fromProfileId,
          fromDisplayName: message.fromDisplayName,
          fromAvatarUrl: message.fromAvatarUrl,
        }]
        render()
      }
      return false // let main.ts also handle it (show popup)
    }

    if (message.type === 'error') {
      if (state.currentScreen === 'private-rooms') {
        state.privateRoomInfoText = message.message
      } else {
        state.errorText = message.message
      }
      render()
      return true
    }

    if (message.type === 'matchmaking_joined') {
      state.currentScreen = 'matchmaking-room'
      state.isSearching = true
      state.selectedStake = message.stake
      state.queuedPlayers = message.queuedPlayers
      state.requiredPlayers = message.requiredPlayers
      state.remainingMs = message.remainingMs
      state.countdownEndsAt = getLocalCountdownEndsAt(message.remainingMs)
      state.totalCountdownMs = message.totalDurationMs ?? DEFAULT_COUNTDOWN_MS
      state.errorText = null
      state.serverPreviewBotDisplayNames = message.previewBotDisplayNames ?? []
      startWaitingClockAudio()
      render()
      return true
    }

    if (message.type === 'matchmaking_status') {
      state.currentScreen = 'matchmaking-room'
      state.isSearching = true
      state.selectedStake = message.stake
      state.queuedPlayers = message.queuedPlayers
      state.requiredPlayers = message.requiredPlayers
      state.remainingMs = message.remainingMs
      state.countdownEndsAt = getLocalCountdownEndsAt(message.remainingMs)
      if (message.totalDurationMs !== undefined) {
        state.totalCountdownMs = message.totalDurationMs
      }
      state.errorText = null
      if (message.previewBotDisplayNames !== undefined) {
        state.serverPreviewBotDisplayNames = message.previewBotDisplayNames
      }
      startWaitingClockAudio()

      if (message.localStakeDeducted === true && stakeEffectStartedAt === null) {
        pendingStakeEffect = true
        maybeShowPendingStakeEffect()
      }

      render()
      return true
    }

    if (message.type === 'matchmaking_left') {
      state.errorText = null
      resetToLobby()
      return true
    }

    if (message.type === 'matchmaking_expired') {
      resetToLobby()
      state.noPlayersModalOpen = true
      render()
      return true
    }

    if (message.type === 'room_snapshot') {
      if (message.roomStatus !== 'waiting' || message.game != null) {
        return false
      }

      const occupiedSeatsCount = countOccupiedSeats(message.seats)
      const requiredPlayers = message.seats.length || DEFAULT_REQUIRED_PLAYERS

      state.currentScreen = 'matchmaking-room'
      state.isSearching = true
      state.queuedPlayers = occupiedSeatsCount
      state.requiredPlayers = requiredPlayers
      state.errorText = null
      state.serverRoomSeats = message.seats
      state.serverYourSeat = message.yourSeat

      if (pendingMatchFoundMessage !== null && occupiedSeatsCount >= requiredPlayers) {
        if (finalFillSequenceStartedAt !== null && !isFinalFillSequenceComplete()) {
          state.queuedPlayers = finalFillBaseQueuedPlayers ?? state.queuedPlayers
          state.serverRoomSeats = null
          state.serverYourSeat = null
          maybeSchedulePendingMatchFound()
          return true
        }

        flushPendingMatchFound()
        return true
      }

      clearFinalFillAnimationState()
      clearPendingMatchFoundTimeout()

      if (occupiedSeatsCount >= requiredPlayers) {
        stopWaitingClockAudio()
      } else {
        startWaitingClockAudio()
      }

      render()
      return true
    }

    if (message.type === 'match_found') {
      pendingMatchFoundMessage = message

      if (startFinalFillSequenceNow()) {
        state.remainingMs = 0
        state.countdownEndsAt = Date.now()
        updateFinalFillSequenceProgress()
        paintMatchmakingRoom()
        maybeSchedulePendingMatchFound()
        return true
      }

      if (finalFillSequenceStartedAt !== null) {
        state.remainingMs = 0
        state.countdownEndsAt = Date.now()
        maybeSchedulePendingMatchFound()
        return true
      }

      flushPendingMatchFound()
      return true
    }

    if (message.type === 'chat_message_received') {
      const isActiveConversation = state.currentScreen === 'chat' && state.activeChatFriendshipId === message.friendshipId
      if (!isActiveConversation) {
        state.chatConversations = state.chatConversations.map((c) =>
          c.friendshipId === message.friendshipId ? { ...c, unreadCount: c.unreadCount + 1 } : c,
        )
        render()
      }
      void refreshChatAfterNotification(message.friendshipId)
      return true
    }

    if (message.type === 'private_rooms_list') {
      state.privateRooms = message.rooms
      render()
      return true
    }

    if (message.type === 'private_room_updated') {
      state.myPrivateRoom = message.room
      render()
      return true
    }

    if (message.type === 'private_room_left') {
      state.myPrivateRoom = null
      render()
      return true
    }

    if (message.type === 'private_room_expired') {
      if (state.myPrivateRoom?.id === message.privateRoomId) {
        state.myPrivateRoom = null
        state.privateRoomInfoText = 'Частната маса изтече — не беше напълнена навреме.'
        render()
      }
      return true
    }

    if (message.type === 'private_room_invite_received') {
      const invite = {
        inviteId: message.inviteId,
        fromProfileId: message.fromProfileId,
        fromDisplayName: message.fromDisplayName,
        fromAvatarUrl: message.fromAvatarUrl,
        privateRoomId: message.privateRoomId,
        stake: message.stake,
        expiresAt: message.expiresAt,
      }
      if (state.privateRoomInvite === null) {
        state.privateRoomInvite = invite
      } else {
        state.privateRoomInviteQueue = [...state.privateRoomInviteQueue, invite]
      }
      render()
      return true
    }

    if (message.type === 'private_room_invite_expired') {
      if (state.privateRoomInvite?.inviteId === message.inviteId) {
        state.privateRoomInvite = state.privateRoomInviteQueue[0] ?? null
        state.privateRoomInviteQueue = state.privateRoomInviteQueue.slice(1)
        render()
      } else {
        state.privateRoomInviteQueue = state.privateRoomInviteQueue.filter(
          (i) => i.inviteId !== message.inviteId,
        )
      }
      return true
    }

    if (message.type === 'private_room_invite_cancelled') {
      if (state.privateRoomInvite?.inviteId === message.inviteId) {
        state.privateRoomInvite = state.privateRoomInviteQueue[0] ?? null
        state.privateRoomInviteQueue = state.privateRoomInviteQueue.slice(1)
        render()
      } else {
        state.privateRoomInviteQueue = state.privateRoomInviteQueue.filter(
          (i) => i.inviteId !== message.inviteId,
        )
      }
      return true
    }

    if (message.type === 'private_room_invite_accepted') {
      state.privateRoomInfoText = `${message.toDisplayName} прие поканата и се присъедини към масата.`
      render()
      return true
    }

    if (message.type === 'private_room_invite_declined') {
      state.privateRoomInfoText = `${message.toDisplayName} отказа поканата за частна игра.`
      render()
      return true
    }

    if (message.type === 'private_room_member_left') {
      state.privateRoomInfoText = `${message.displayName} излезе от масата.`
      render()
      return true
    }

    if (message.type === 'private_room_closed') {
      if (state.myPrivateRoom?.id === message.privateRoomId) {
        state.myPrivateRoom = null
        state.privateRoomInfoText = 'Домакинът затвори масата.'
        render()
      }
      return true
    }

    if (message.type === 'private_room_friend_busy') {
      const names = message.busyFriends.map((f) => f.displayName)
      state.privateRoomInfoText =
        names.length === 1
          ? `${names[0]} в момента е в игра — опитай с друг.`
          : `${names.join(' и ')} в момента са в игра — опитай с други.`
      render()
      return true
    }

    if (message.type === 'private_room_full') {
      state.myPrivateRoom = null
      state.currentScreen = 'lobby'
      state.privateRoomsCreatePopupOpen = false
      options.onMatchFound({
        type: 'match_found',
        roomId: message.roomId,
        seat: message.seat,
        stake: message.stake,
        humanPlayers: 4,
        botPlayers: 0,
        shouldStartImmediately: true,
      }, false)
      return true
    }

    return false
  }

  async function openMissionsPopup(): Promise<void> {
    const authSession = options.getAuthSession?.() ?? null
    state.missionsPopupOpen = true
    state.missionClaimErrorText = null

    if (authSession === null || !options.onDailyMissionsLoad) {
      state.dailyMissions = []
      state.dailyMissionsLoading = false
      state.dailyMissionsErrorText = null
      render()
      return
    }

    state.dailyMissionsLoading = true
    state.dailyMissionsErrorText = null
    render()

    const result = await options.onDailyMissionsLoad()

    state.dailyMissionsLoading = false

    if (!result.ok) {
      state.dailyMissionsErrorText = result.message
      render()
      return
    }

    state.dailyMissions = result.missions
    state.dailyMissionsUnclaimedCount = result.unclaimedCount
    state.dailyMissionsErrorText = null
    render()
  }

  async function claimMission(missionId: string): Promise<void> {
    if (!options.onMissionClaim) {
      state.missionClaimErrorText = 'Вземането на награди временно не е налично.'
      render()
      return
    }

    state.missionClaimingId = missionId
    state.missionClaimErrorText = null
    render()

    const result = await options.onMissionClaim(missionId)

    state.missionClaimingId = null

    if (!result.ok) {
      state.missionClaimErrorText = result.message
      render()
      return
    }

    state.dailyMissions = result.missions
    state.dailyMissionsUnclaimedCount = result.unclaimedCount
    state.missionClaimErrorText = null
    render()
  }

  async function loadAdminMissions(): Promise<void> {
    if (state.currentScreen !== 'admin') return
    if (!options.onAdminMissionsLoad) return

    state.adminMissionsLoading = true
    state.adminMissionsErrorText = null
    render()

    const result = await options.onAdminMissionsLoad()

    if (state.currentScreen !== 'admin') return

    state.adminMissionsLoading = false

    if (!result.ok) {
      state.adminMissionsErrorText = result.message
      render()
      return
    }

    state.adminActiveMissions = result.activeMissions
    state.adminStagedMissions = result.stagedMissions
    state.adminMissionsErrorText = null
    render()
  }

  async function loadMatchRooms(): Promise<void> {
    if (!options.onMatchRoomsLoad) return
    state.matchRoomsLoading = true
    state.matchRoomsErrorText = null
    const result = await options.onMatchRoomsLoad()
    state.matchRoomsLoading = false
    state.matchRoomsLoaded = true
    _initMatchRoomsDone = true
    maybeHideInitialOverlay()
    if (!result.ok) {
      state.matchRoomsErrorText = result.message
      scheduleRender()
      return
    }
    state.matchRooms = result.rooms
    state.matchRoomsErrorText = null
    scheduleRender()
  }

  async function submitAdminMission(input: MissionTemplateInput): Promise<void> {
    if (!options.onAdminMissionSubmit) {
      state.adminMissionsErrorText = 'Записът на мисии временно не е наличен.'
      render()
      return
    }

    state.adminMissionsErrorText = null
    render()

    const result = await options.onAdminMissionSubmit(input)

    if (!result.ok) {
      state.adminMissionsErrorText = result.message
      render()
      return
    }

    state.adminActiveMissions = result.activeMissions
    state.adminStagedMissions = result.stagedMissions
    state.adminMissionsErrorText = null
    state.adminMissionEditId = null
    render()
  }

  async function toggleAdminMissionActive(missionId: string, isActive: boolean): Promise<void> {
    if (!options.onAdminMissionActiveToggle) {
      state.adminMissionsErrorText = 'Промяната временно не е налична.'
      render()
      return
    }

    const result = await options.onAdminMissionActiveToggle(missionId, isActive)

    if (!result.ok) {
      state.adminMissionsErrorText = result.message
      render()
      return
    }

    state.adminActiveMissions = result.activeMissions
    state.adminStagedMissions = result.stagedMissions
    state.adminMissionsErrorText = null
    render()
  }

  async function deleteAdminMission(missionId: string): Promise<void> {
    if (!options.onAdminMissionDelete) {
      state.adminMissionsErrorText = 'Изтриването временно не е налично.'
      render()
      return
    }

    const result = await options.onAdminMissionDelete(missionId)

    if (!result.ok) {
      state.adminMissionsErrorText = result.message
      render()
      return
    }

    state.adminActiveMissions = result.activeMissions
    state.adminStagedMissions = result.stagedMissions
    if (state.adminMissionEditId === missionId) state.adminMissionEditId = null
    state.adminMissionsErrorText = null
    render()
  }

  async function loadPlayerUnclaimedCount(): Promise<void> {
    const authSession = options.getAuthSession?.() ?? null
    if (authSession === null || !options.onDailyMissionsLoad) return

    const result = await options.onDailyMissionsLoad()
    if (result.ok) {
      state.dailyMissions = result.missions
      state.dailyMissionsUnclaimedCount = result.unclaimedCount
      scheduleRender()
    }
  }

  createInitialOverlay()
  void loadMatchRooms()
  void loadLobbyPackages()
  void loadPlayerUnclaimedCount()

  window.addEventListener('popstate', () => {
    navigateFromPath(window.location.pathname)
  })

  function msUntilNextSofiaMidnight(): number {
    const now = new Date()
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Europe/Sofia',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(now)
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0')
    const elapsedMs =
      ((get('hour') % 24) * 3600 + get('minute') * 60 + get('second')) * 1000 +
      now.getMilliseconds()
    // +2s buffer so server has time to complete rotation before we reload
    return 24 * 60 * 60 * 1000 - elapsedMs + 2000
  }

  function scheduleMidnightAdminRefresh(): void {
    window.setTimeout(() => {
      void loadAdminMissions()
      scheduleMidnightAdminRefresh()
    }, msUntilNextSofiaMidnight())
  }
  scheduleMidnightAdminRefresh()

  return {
    render,
    destroy: () => {
      stopWaitingRoomActivity()
      clearServerRoomSnapshot()
      resetFinalFillSequence()
      doHideInitialOverlay()
    },
    getCurrentScreen: () => state.currentScreen,
    setConnected: (value) => {
      state.isConnected = value
      if (value) {
        _initConnected = true
        maybeHideInitialOverlay()
      }
      render()
    },
    setDisplayName: (value) => {
      state.displayName = value
      render()
    },
    setErrorText: (value) => {
      if (errorTextTimerId !== null) {
        clearTimeout(errorTextTimerId)
        errorTextTimerId = null
      }
      state.errorText = value
      render()
      if (value !== null) {
        errorTextTimerId = setTimeout(() => {
          errorTextTimerId = null
          state.errorText = null
          render()
        }, 4000)
      }
    },
    setLocalAvatarUrl: (value) => {
      state.localAvatarUrl = value
      render()
    },
    setFriendships: (value) => {
      state.friendships = value
      state.friendsErrorText = null
      render()
    },
    setChatConversations: (value) => {
      state.chatConversations = value
      state.chatErrorText = null
      if (
        state.activeChatFriendshipId !== null &&
        !value.some((conversation) => {
          return conversation.friendshipId === state.activeChatFriendshipId
        })
      ) {
        state.activeChatFriendshipId = null
        state.chatMessages = []
      }
      render()
    },
    startMatchmaking,
    resetToLobby,
    refreshMissionsCount: () => { void loadPlayerUnclaimedCount() },
    refreshDailyRewardsStatus: () => { void loadDailyRewardsStatus() },
    removePendingFriendRequest: (friendshipId: string) => {
      state.pendingFriendRequests = state.pendingFriendRequests.filter((r) => r.friendshipId !== friendshipId)
      render()
    },
    getPendingFriendRequest: (friendshipId: string) => {
      return state.pendingFriendRequests.find((r) => r.friendshipId === friendshipId)
    },
    getFriendshipActionForProfile: (profileId: string) => {
      const authSession = options.getAuthSession?.() ?? null
      if (authSession === null || authSession.profile.profileId === profileId) return null
      const relationship = findRelationshipByProfileId(state.friendships, profileId)
      if (relationship === null) {
        return { profileId, label: 'Покани за приятел', disabled: false, message: null }
      }
      if (relationship.status === 'accepted') {
        return { profileId, label: 'Вече сте приятели', disabled: true, message: null, giftFriendshipId: relationship.friendshipId }
      }
      return {
        profileId,
        label: relationship.direction === 'incoming' ? 'Има входяща покана' : 'Поканата е изпратена',
        disabled: true,
        message: null,
      }
    },
    refreshSupportUnread: () => {
      void (async () => {
        const result = await options.onSupportUnreadLoad?.()
        if (result?.ok) {
          state.supportUnreadCount = result.unreadCount
          const badge = options.root.querySelector<HTMLElement>('[data-support-unread-badge="1"]')
          if (badge) {
            badge.style.display = result.unreadCount > 0 ? 'flex' : 'none'
            badge.textContent = result.unreadCount > 0 ? String(result.unreadCount) : ''
          } else {
            render()
          }
        }
      })()
    },
    handleServerMessage,
    setPwaUpdatePending: (pending: boolean, applyFn: (() => void) | null) => {
      state.pwaUpdatePending = pending
      state.pwaUpdateApplyFn = applyFn
      if (!(options.getIsInGame?.() ?? false)) render()
    },
    navigateInitialPath: () => {
      _navigationReady = true
      if (!_loadPath || !PATH_TO_SCREEN[_loadPath]) return
      if (state.isConnected) {
        navigateFromPath(_loadPath)
      } else {
        _pendingInitialNav = true
      }
    },
    navigateToShop: (noticeText: string | null) => {
      void showShopPanel().then(() => {
        if (noticeText !== null && state.currentScreen === 'shop') {
          state.shopPurchaseMessageText = noticeText
          render()

          window.setTimeout(() => {
            if (state.shopPurchaseMessageText === noticeText) {
              state.shopPurchaseMessageText = null
              render()
            }
          }, 6000)

          window.setTimeout(() => {
            if (state.currentScreen === 'shop') {
              void loadShopPurchases()
            }
          }, 3000)
        }
      })
    },
  }
}
