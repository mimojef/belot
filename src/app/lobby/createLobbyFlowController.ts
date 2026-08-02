import { formatGiftLimitError } from './formatGiftLimitError'
import type { TournamentEconomyNoticeReason } from '../../ui/notifications/tournamentEconomyNotificationQueue.js'
import type { AdminPaymentPeriod, AdminPaymentListRow, AdminPaymentDetailRow } from '../adminPayments/adminPaymentsTypes.js'
import { isAdminPaymentPeriod } from '../adminPayments/adminPaymentsTypes.js'
import type { AdminTournamentDetailRow, AdminTournamentFilters, AdminTournamentSummaryRow } from '../adminTournaments/adminTournamentTypes.js'
import type { GiftLimitErrorPayload } from './formatGiftLimitError'
import { applyRouteSeo } from '../seo/applyRouteSeo'
import {
  renderMatchmakingRoomScreen,
  type MatchmakingRoomPlayer,
} from './renderMatchmakingRoomScreen'
import {
  renderPrivateRoomWaitingScreen,
  formatPrivateRoomCountdown,
  getPrivateRoomCountdownState,
} from './renderPrivateRoomWaitingScreen'
import { formatTournamentStartCountdown, formatTournamentFillExpiryCountdown } from './renderTournamentsScreen'
import { showStakeDeductionEffect } from '../activeRoom/renderStakeDeductionEffect'
import {
  renderLobbyScreen,
  syncProfilePopup,
  clearProfileEditorPendingState,
  type AvatarCropSelection,
  type GuestContactFormInput,
  type LobbyAuthModalMode,
  type LobbyScreenState,
  type ProfilePopupCallbacks,
} from './renderLobbyScreen'
import type { GuestTrialPopupState } from './renderGuestTrialPopup'
import type { GuestLockedStakePopupState } from './renderGuestLockedStakePopup'
import type { LevelLockedStakePopupState } from './renderLevelLockedStakePopup'
import {
  computeShopResumeConfirmOpen,
  computeShopPurchaseConfirmDispatch,
} from './shopResumeConfirmState'
import { createDebouncedPlayerSearch } from './createDebouncedPlayerSearch'
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
  LobbyChatMessageSnapshot,
  MatchFoundMessage,
  MatchRoomSnapshot,
  MatchStake,
  MissionTemplateInput,
  MissionTemplateSnapshot,
  PlayerMissionProgressSnapshot,
  PlayerPublicProfileSnapshot,
  PrivateRoomChatMessageSnapshot,
  PrivateRoomSnapshot,
  RoomSeatSnapshot,
  ServerMessage,
  GuestContactMessageListItem,
  SupportMessageSnapshot,
  SupportConversationSnapshot,
  TournamentCreateInput,
  TournamentDetailSnapshot,
  TournamentPartnerCandidateSnapshot,
  TournamentPartnerInviteSnapshot,
  TournamentSummarySnapshot,
} from '../network/createGameServerClient'

export type LobbyFlowScreen =
  | 'lobby'
  | 'players'
  | 'leaderboards'
  | 'shop'
  | 'admin'
  | 'admin-info'
  | 'admin-server'
  | 'admin-visitors'
  | 'admin-payments'
  | 'admin-payment-detail'
  | 'admin-tournaments'
  | 'admin-tournament-detail'
  | 'tournaments'
  | 'tournament-detail'
  | 'tournament-how-it-works'
  | 'terms'
  | 'privacy'
  | 'contact'
  | 'matchmaking-room'
  | 'private-rooms'
  | 'private-room-waiting'
  | 'support'
  | 'guest-contact-messages'
  | 'rules'
  | 'strategy'
  | 'learn'
  | 'faq'
  | 'about'
  | 'fair-play'
export type LobbySocialScreen = LobbyFlowScreen | 'friends' | 'chat'

export type LobbyAuthSession = {
  account: {
    role: string
  }
  profile: PlayerPublicProfileSnapshot
}

/** Пълен администратор — единствената роля с достъп до "Настройки", редакция на профили, чат с поддръжката, управление на роли. */
function isFullAdminAuthSession(session: LobbyAuthSession | null): boolean {
  return session !== null && session.account.role === 'admin'
}

/** Read-only административен достъп ("Информация" / "Сървър") — субадмин ИЛИ пълен администратор. */
function isAdminOrSubadminAuthSession(session: LobbyAuthSession | null): boolean {
  return session !== null && (session.account.role === 'admin' || session.account.role === 'subadmin')
}

/**
 * Единственото право на chat_admin: показва бутона "(×)" за изтриване на
 * съобщения от общия лайв чат. Само UX — сървърът презаверява това право на
 * всяко DELETE през isLobbyChatModeratorSession (виж authStore.ts).
 */
function isLobbyChatModeratorAuthSession(session: LobbyAuthSession | null): boolean {
  return session !== null && (
    session.account.role === 'admin'
    || session.account.role === 'subadmin'
    || session.account.role === 'chat_admin'
  )
}

export type CreateLobbyFlowControllerOptions = {
  root: HTMLElement
  joinMatchmaking: (stake: MatchStake, displayName?: string) => void
  joinGuestTrial?: (stake: MatchStake) => void
  leaveMatchmaking: () => void
  onMatchFound: (message: MatchFoundMessage, stakeAlreadyShown: boolean) => void
  onGuestTrialStatusLoad?: () => Promise<
    | { ok: true; gamesUsed: number; remaining: number; maxGames: number; stake: MatchStake }
    | { ok: false; message: string }
  >
  onGuestTrialRegisterClick?: () => void
  onGuestTrialLoginClick?: () => void
  tryUnlockDocumentAudio?: () => void
  getAuthSession?: () => LobbyAuthSession | null
  getSignupBonusYellowCoins?: () => number
  getProfileNameChangePrice?: () => number
  getOnlinePlayersCount?: () => number
  getApiBaseUrl?: () => string
  getIsInGame?: () => boolean
  onLobbyChatSubscribe?: () => void
  onLobbyChatUnsubscribe?: () => void
  onLobbyChatSend?: (body: string, requestId: string) => void
  onLobbyChatDeleteMessage?: (messageId: string) => void
  suppressRendering?: boolean
  onLoginSubmit?: (email: string, password: string) => Promise<string | null>
  onRegisterSubmit?: (
    displayName: string,
    email: string,
    password: string,
    gender: 'male' | 'female' | null,
  ) => Promise<string | null>
  onProfileEditSubmit?: (
    targetProfileId: string | null,
    avatarFile: File | null,
    avatarCrop: AvatarCropSelection | null,
    galleryFiles: File[],
  ) => Promise<string | null>
  onPresetAvatarApply?: (targetProfileId: string | null, avatarUrl: string) => Promise<string | null>
  onProfileGalleryDelete?: (targetProfileId: string | null, imageId: string) => Promise<string | null>
  onProfileNameChangeSubmit?: (targetProfileId: string | null, displayName: string) => Promise<string | null>
  onChangePasswordSubmit?: (currentPassword: string, newPassword: string) => Promise<string | null>
  onPlayersLoad?: (
    page: number,
    snapshotToken: string | null,
  ) => Promise<
    | {
        ok: true
        players: PlayerPublicProfileSnapshot[]
        page: number
        pageSize: number
        totalCount: number
        totalPages: number
        snapshot: string
        snapshotReset: boolean
      }
    | { ok: false; message: string }
  >
  onPlayersSearch?: (
    query: string,
    signal: AbortSignal,
  ) => Promise<
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
  onShopPurchaseResume?: (purchaseId: string) => Promise<
    | { ok: true; checkoutUrl: string }
    | { ok: false; message: string }
  >
  onShopPurchaseHide?: (purchaseId: string) => Promise<
    | { ok: true; purchases: CoinPurchaseSnapshot[] }
    | { ok: false; message: string }
  >
  onAdminStatsLoad?: () => Promise<
    | { ok: true; stats: AdminStatsSnapshot }
    | { ok: false; message: string; forbidden?: boolean }
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
  onAdminCoinPackageTopOfferToggle?: (
    packageId: string,
    isTopOffer: boolean,
  ) => Promise<
    | { ok: true; packages: CoinPackageSnapshot[] }
    | { ok: false; message: string }
  >
  onNotifFriendRequestClick?: (friendshipId: string) => void
  onMarkGiftNotificationRead?: (giftId: string) => Promise<void>
  onMarkAcceptanceNotificationRead?: (friendshipId: string) => Promise<void>
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
  onFriendCancel?: (friendshipId: string) => Promise<
    | { ok: true; friendships: FriendshipsSnapshot }
    | { ok: false; message: string }
  >
  onFriendRemove?: (friendshipId: string) => Promise<
    | { ok: true; friendships: FriendshipsSnapshot }
    | { ok: false; message: string }
  >
  onBlockProfile?: (profileId: string) => Promise<{ blocked: boolean } | { ok: false; message: string; limitReached?: true }>
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
    | ({ ok: false; message: string } & GiftLimitErrorPayload)
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
  onChatSend?: (friendshipId: string, body: string, imageDataUrl?: string | null) => Promise<
    | {
        ok: true
        conversation: ChatConversationSnapshot
        messages: ChatMessageSnapshot[]
        newMessage?: ChatMessageSnapshot
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
  onPrivateRoomCreate?: (stake: MatchStake, isLocked: boolean, waitMinutes: 5 | 10 | 15 | 30) => void
  onPrivateRoomJoin?: (privateRoomId: string) => void
  onPrivateRoomLeave?: () => void
  onPrivateRoomInvite?: (toProfiles: Array<{ profileId: string; displayName: string }>) => void
  onCancelPrivateRoomInvite?: (inviteId: string) => void
  onPrivateRoomInviteRespond?: (inviteId: string, accept: boolean) => void
  onPrivateRoomFillWithBots?: () => void
  onPrivateRoomChatSubscribe?: (privateRoomId: string) => void
  onPrivateRoomChatUnsubscribe?: (privateRoomId: string) => void
  onPrivateRoomChatSend?: (privateRoomId: string, body: string, requestId?: string) => void
  onSupportMessagesLoad?: () => Promise<
    | { ok: true; messages: SupportMessageSnapshot[] }
    | { ok: false; message: string }
  >
  onSupportSend?: (body: string) => Promise<
    | { ok: true; messages: SupportMessageSnapshot[] }
    | { ok: false; code?: string; remainingMinutes?: number; message?: string }
  >
  onGuestContactSend?: (input: GuestContactFormInput) => Promise<
    | { ok: true; message: string }
    | { ok: false; message: string }
  >
  onSupportUnreadLoad?: () => Promise<{
    ok: true
    unreadCount: number
    supportUnreadCount?: number
    guestUnreadCount?: number
  } | { ok: false }>
  onAdminSupportConversationsLoad?: () => Promise<
    | { ok: true; conversations: SupportConversationSnapshot[] }
    | { ok: false; message: string }
  >
  onAdminGuestContactMessagesLoad?: () => Promise<
    | { ok: true; messages: GuestContactMessageListItem[] }
    | { ok: false; message: string }
  >
  onAdminGuestContactMessageRead?: (messageId: string) => Promise<{ ok: true } | { ok: false; message: string }>
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
  onAdminServerScreenEnter?: () => void
  onAdminServerScreenLeave?: () => void
  /** GET текуща роля на профил (само за пълен admin viewer) — за "Субадмин"/"Чат админ" бадж в профилния попъп. */
  onAdminGetTargetRole?: (
    profileId: string,
  ) => Promise<{ ok: true; role: 'player' | 'chat_admin' | 'subadmin' | 'admin' | null } | { ok: false; message: string }>
  onAdminGrantSubadmin?: (profileId: string) => Promise<{ ok: true } | { ok: false; message: string }>
  onAdminRevokeSubadmin?: (profileId: string) => Promise<{ ok: true } | { ok: false; message: string }>
  onAdminGrantChatAdmin?: (profileId: string) => Promise<{ ok: true } | { ok: false; message: string }>
  onAdminRevokeChatAdmin?: (profileId: string) => Promise<{ ok: true } | { ok: false; message: string }>
  onAdminHistoryWindowChange?: (window: import('../adminServer/adminServerTypes.js').HistoryWindow) => void
  onAdminVisitorsPeriodClick?: (period: string) => void
  onAdminVisitorsBackClick?: () => void
  onAdminVisitorsTypeChange?: (type: import('../network/createGameServerClient.js').VisitorListType) => void
  onAdminVisitorsDeviceChange?: (device: import('../network/createGameServerClient.js').VisitorDeviceFilter) => void
  onAdminVisitorsOsChange?: (os: import('../network/createGameServerClient.js').VisitorOsFilter) => void
  onAdminVisitorsPageChange?: (offset: number) => void
  onAdminVisitorsViewChange?: (view: import('../network/createGameServerClient.js').AdminVisitorsView) => void
  onAdminVisitorsLoad?: (params: {
    period: import('../network/createGameServerClient.js').VisitorListPeriod
    type: import('../network/createGameServerClient.js').VisitorListType
    device: import('../network/createGameServerClient.js').VisitorDeviceFilter
    os: import('../network/createGameServerClient.js').VisitorOsFilter
    limit: number
    offset: number
  }) => Promise<
    | { ok: true; rows: import('../network/createGameServerClient.js').AdminVisitorRow[]; total: number }
    | { ok: false; message: string; forbidden?: boolean }
  >
  onAdminVisitorSourcesLoad?: (params: {
    period: import('../network/createGameServerClient.js').VisitorListPeriod
    type: import('../network/createGameServerClient.js').VisitorListType
    device: import('../network/createGameServerClient.js').VisitorDeviceFilter
    os: import('../network/createGameServerClient.js').VisitorOsFilter
  }) => Promise<
    | { ok: true; rows: import('../network/createGameServerClient.js').AdminVisitorSourceRow[]; total: number }
    | { ok: false; message: string; forbidden?: boolean }
  >
  onAdminPaymentsLoad?: (params: {
    period: AdminPaymentPeriod
    limit: number
    offset: number
  }) => Promise<
    | {
        ok: true
        purchases: AdminPaymentListRow[]
        pagination: { limit: number; offset: number; total: number; hasMore: boolean }
        summary: { totalsByCurrency: Record<string, number> }
      }
    | { ok: false; message: string; forbidden?: boolean }
  >
  onAdminPaymentDetailLoad?: (purchaseId: string) => Promise<
    | { ok: true; purchase: AdminPaymentDetailRow }
    | { ok: false; message: string; forbidden?: boolean }
  >
  onAdminTournamentsLoad?: (filters: AdminTournamentFilters) => Promise<
    | { ok: true; tournaments: AdminTournamentSummaryRow[]; page: number; limit: number; totalCount: number; canWrite: boolean }
    | { ok: false; message: string; forbidden?: boolean }
  >
  onAdminTournamentDetailLoad?: (tournamentId: string) => Promise<
    | { ok: true; tournament: AdminTournamentDetailRow; canWrite: boolean }
    | { ok: false; message: string; forbidden?: boolean }
  >
  onAdminTournamentReconcile?: (tournamentId: string) => Promise<
    | { ok: true; status: string }
    | { ok: false; message: string; forbidden?: boolean }
  >
  onAdminTournamentCancelOpen?: (tournamentId: string) => Promise<
    | { ok: true; alreadyCancelled: boolean; refundedEntries: number; totalRefunded: number }
    | { ok: false; message: string; forbidden?: boolean }
  >
  /** Пуска се при вход в екран от фамилията "Информация" (stats/visitors/payments/detail) — лек role-check polling, за да засече отнет достъп докато потребителят е неактивен. */
  onAdminInfoFamilyScreenEnter?: () => void
  onAdminInfoFamilyScreenLeave?: () => void
  onTournamentsLoad?: (params: { mine: boolean; page: number }) => Promise<
    | { ok: true; tournaments: TournamentSummarySnapshot[]; page: number; limit: number; totalCount: number }
    | { ok: false; message: string }
  >
  onTournamentCreate?: (input: TournamentCreateInput) => Promise<
    | { ok: true; tournament: TournamentSummarySnapshot }
    | { ok: false; message: string }
  >
  onTournamentDetailLoad?: (tournamentId: string) => Promise<
    | { ok: true; tournament: TournamentDetailSnapshot }
    | { ok: false; message: string; requiresPassword?: boolean }
  >
  onTournamentUnlock?: (tournamentId: string, password: string) => Promise<
    | { ok: true; tournament: TournamentDetailSnapshot }
    | { ok: false; message: string; requiresPassword?: boolean }
  >
  onTournamentJoin?: (tournamentId: string, password: string | null) => Promise<
    | { ok: true; alreadyJoined: boolean; debitedAmount?: number; walletBalance: number; tournament: TournamentSummarySnapshot }
    | { ok: false; message: string; reason?: string; requiresPassword?: boolean }
  >
  onTournamentLeave?: (tournamentId: string) => Promise<
    | {
        ok: true
        alreadyRefunded: boolean
        refundedAmount: number
        walletBalance: number
        tournament: TournamentSummarySnapshot
      }
    | { ok: false; message: string }
  >
  onTournamentCancel?: (tournamentId: string) => Promise<
    | {
        ok: true
        alreadyCancelled: boolean
        refundedEntries: number
        totalRefunded: number
        walletBalance: number
        tournament: TournamentSummarySnapshot
      }
    | { ok: false; message: string }
  >
  onTournamentPartnerCandidatesLoad?: (tournamentId: string) => Promise<
    | { ok: true; candidates: TournamentPartnerCandidateSnapshot[] }
    | { ok: false; message: string }
  >
  onPendingTournamentPartnerInvitesLoad?: () => Promise<
    | { ok: true; invites: TournamentPartnerInviteSnapshot[] }
    | { ok: false; message: string }
  >
  onTournamentPartnerInviteCreate?: (
    tournamentId: string,
    inviteeProfileId: string,
    password: string | null,
  ) => Promise<
    | { ok: true; debitedAmount?: number; invite: TournamentPartnerInviteSnapshot; walletBalance: number; tournament: TournamentSummarySnapshot }
    | { ok: false; message: string; reason?: string; requiresPassword?: boolean }
  >
  onTournamentPartnerInviteRespond?: (
    tournamentId: string,
    inviteId: string,
    action: 'accept' | 'decline' | 'cancel',
  ) => Promise<
    | { ok: true; alreadyResolved?: boolean; debitedAmount?: number; invite: TournamentPartnerInviteSnapshot; walletBalance: number; tournament: TournamentSummarySnapshot }
    | { ok: false; message: string; reason?: string }
  >
  onTournamentEnterActiveMatch?: (roomId: string, reconnectToken: string) => void
  /** Server-authoritative debit/refund toast (§3-§7 в task spec-а) — извиква
   * се САМО след потвърден нов debit/refund от authoritative HTTP response
   * (join / partner invite create-debit / accept-debit / withdrawal).
   * Creator cancellation и fill-expiry идват отделно, directно през WS
   * (виж tournament_economy_notice в createGameServerClient.ts), за да няма
   * двойно известие за създателя, ако той самият е бил refund-нат. */
  onTournamentEconomyNotice?: (notice: { reason: TournamentEconomyNoticeReason; amount: number }) => void
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
  openAuthModal: (mode: Exclude<import('./renderLobbyScreen').LobbyAuthModalMode, 'closed'>) => void
  suspendLobbyChatForActiveRoom: () => void
  forceLobbyChatResubscribeIfOnLobbyScreen: () => void
  resyncPrivateRoomMembershipIfWaiting: () => void
  updateLobbyChatDraft: (value: string) => void
  submitLobbyChatMessage: () => void
  refreshMissionsCount: () => void
  refreshDailyRewardsStatus: () => void
  refreshSupportUnread: () => void
  removePendingFriendRequest: (friendshipId: string) => void
  getPendingFriendRequest: (friendshipId: string) => { friendshipId: string; fromProfileId: string; fromDisplayName: string; fromAvatarUrl: string | null } | undefined
  isConversationOpen: (friendshipId: string) => boolean
  openChatWithFriend: (friendshipId: string) => void
  getFriendshipActionForProfile: (profileId: string) => import('../../ui/overlays/renderPlayerProfilePopup').PlayerProfileFriendshipAction | null
  handleServerMessage: (message: ServerMessage) => boolean
  navigateToShop: (noticeText: string | null) => void
  navigateToPrivateRooms: () => void
  navigateToTournamentDetail: (tournamentId: string) => void
  refreshPendingTournamentPartnerInvites: () => Promise<void>
  getPwaUpdateSafetySnapshot: () => {
    isSearching: boolean
    hasPrivateRoomInvite: boolean
    hasQueuedPrivateRoomInvites: boolean
    isInPrivateRoomsScreen: boolean
    isConnected: boolean
  }
  setAdminMonitoringSnapshot: (snapshot: import('../adminServer/adminServerTypes.js').MonitoringSnapshot) => void
  setAdminMonitoringError: (message: string) => void
  forceLeaveAdminScreenForbidden: (message: string) => void
  setAdminHistoryLoading: (loading: boolean) => void
  setAdminHistoryResult: (result: import('../adminServer/adminServerTypes.js').MonitoringHistoryResult) => void
  setAdminHistoryError: (message: string) => void
  setAdminWsConnections: (result: import('../adminServer/adminServerTypes.js').WsConnectionsResult) => void
  navigateInitialPath: () => void
  navigateAdminVisitors: (period?: string) => void
  navigateAdminInfo: () => void
  navigateAdminPayments: (period?: string) => void
  navigateAdminPaymentDetail: (purchaseId: string) => void
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
  /** Роля на разглеждания акаунт (само заредена/показана за пълен admin viewer). */
  profilePopupTargetRole: 'player' | 'chat_admin' | 'subadmin' | 'admin' | null
  /** profileId, за който profilePopupTargetRole вече е (или се) зарежда — memoization guard. */
  profilePopupTargetRoleProfileId: string | null
  subadminActionConfirm: { profileId: string; displayName: string; action: 'grant' | 'revoke'; previousRole?: 'chat_admin' | null } | null
  subadminActionBusy: boolean
  subadminActionToast: { text: string; ok: boolean } | null
  chatAdminActionConfirm: { profileId: string; displayName: string; action: 'grant' | 'revoke'; previousRole?: 'subadmin' | null } | null
  chatAdminActionBusy: boolean
  chatAdminActionToast: { text: string; ok: boolean } | null
  profileEditorOpen: boolean
  profileEditorTargetProfileId: string | null
  profileEditorTargetProfile: PlayerPublicProfileSnapshot | null
  profileEditorErrorText: string | null
  profileEditorSubmitting: boolean
  profileNameChangeErrorText: string | null
  profileNameChangeSuccessAmount: number | null
  changePasswordPopupOpen: boolean
  changePasswordErrorText: string | null
  ownLikesCount: number | null
  authModalMode: LobbyAuthModalMode
  authErrorText: string | null
  authSubmitInFlight: boolean
  guestTrialPopup: GuestTrialPopupState
  guestLockedStakePopup: GuestLockedStakePopupState
  levelLockedStakePopup: LevelLockedStakePopupState
  lowCoinsModalOpen: boolean
  serverRoomSeats: RoomSeatSnapshot[] | null
  serverYourSeat: RoomSeatSnapshot['seat'] | null
  serverQueuedPlayerPreviews: MatchmakingRoomPlayer[]
  serverPreviewBotDisplayNames: string[]
  players: PlayerPublicProfileSnapshot[]
  playersPage: number
  playersSnapshotToken: string | null
  playersTotalCount: number
  playersTotalPages: number
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
  giftReceivedModal: { amount: number; fromDisplayName: string } | null
  pendingGiftNotifications: Array<{ giftId: string; amount: number; fromDisplayName: string }>
  acceptanceNotifications: Array<{ friendshipId: string; fromProfileId: string; fromDisplayName: string; fromAvatarUrl: string | null }>
  acceptanceProcessingIds: Set<string>
  acceptanceErrorText: string | null
  chatConversations: ChatConversationSnapshot[]
  activeChatFriendshipId: string | null
  chatMessages: ChatMessageSnapshot[]
  chatLoading: boolean
  chatMessagesLoading: boolean
  chatErrorText: string | null
  chatDraftByFriendshipId: Record<string, string>
  // Избрана-но-неизпратена снимка per разговор (за да оцелее при
  // превключване между разговори, по модела на chatDraftByFriendshipId).
  // previewUrl е обект-URL (URL.createObjectURL) — освобождава се explicit
  // при премахване/успешно изпращане (виж onChatImageRemove/sendChatMessage).
  chatPendingImageByFriendshipId: Record<string, { file: File; previewUrl: string } | undefined>
  chatUploadingFriendshipIds: Set<string>
  // Общ лайв чат в лобито (отделен от chatConversations/chatMessages по-горе —
  // тези са за 1:1 личния чат от раздел "ЧАТ"; виж CLAUDE.md/задачата).
  lobbyChatMessages: LobbyChatMessageSnapshot[]
  lobbyChatSubscribed: boolean
  lobbyChatDraft: string
  lobbyChatSending: boolean
  lobbyChatPendingRequestId: string | null
  lobbyChatErrorText: string | null
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
  privateRoomWaitingChatMessages: PrivateRoomChatMessageSnapshot[]
  privateRoomWaitingChatSubscribedRoomId: string | null
  privateRoomWaitingChatDraft: string
  privateRoomWaitingChatSending: boolean
  privateRoomWaitingChatPendingRequestId: string | null
  privateRoomWaitingChatErrorText: string | null
  privateRoomWaitingLeaveConfirmOpen: boolean
  privateRoomWaitingFillBotsConfirmOpen: boolean
  privateRoomWaitingFillBotsLoading: boolean
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
  adminSupportMobileConversationOpen: boolean
  adminGuestContactMessages: GuestContactMessageListItem[]
  adminGuestContactMessagesLoading: boolean
  adminGuestContactMessagesErrorText: string | null
  adminGuestContactUnreadCount: number
  supportDeleteConfirm: boolean
  supportDeleteLoading: boolean
  supportAccountTooNewMinutes: number | null
  adminMonitoringSnapshot: import('../adminServer/adminServerTypes.js').MonitoringSnapshot | null
  adminMonitoringErrorText: string | null
  adminHistoryWindow: import('../adminServer/adminServerTypes.js').HistoryWindow
  adminHistoryResult: import('../adminServer/adminServerTypes.js').MonitoringHistoryResult | null
  adminHistoryLoading: boolean
  adminHistoryErrorText: string | null
  adminWsConnections: import('../adminServer/adminServerTypes.js').WsConnectionsResult | null
  adminVisitorsLoading: boolean
  adminVisitorsRows: import('../network/createGameServerClient.js').AdminVisitorRow[]
  adminVisitorsTotal: number
  adminVisitorsErrorText: string | null
  adminVisitorsPeriod: import('../network/createGameServerClient.js').VisitorListPeriod
  adminVisitorsType: import('../network/createGameServerClient.js').VisitorListType
  adminVisitorsDevice: import('../network/createGameServerClient.js').VisitorDeviceFilter
  adminVisitorsOs: import('../network/createGameServerClient.js').VisitorOsFilter
  adminVisitorsOffset: number
  adminVisitorsLimit: number
  adminVisitorsView: import('../network/createGameServerClient.js').AdminVisitorsView
  adminVisitorsSourcesLoading: boolean
  adminVisitorsSourcesRows: import('../network/createGameServerClient.js').AdminVisitorSourceRow[]
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
  adminPaymentDetailFromPeriod: string | null
  adminTournamentsLoading: boolean
  adminTournamentsRows: AdminTournamentSummaryRow[]
  adminTournamentsTotal: number
  adminTournamentsErrorText: string | null
  adminTournamentsCanWrite: boolean
  adminTournamentsFilters: AdminTournamentFilters
  adminTournamentDetailId: string | null
  adminTournamentDetailLoading: boolean
  adminTournamentDetail: AdminTournamentDetailRow | null
  adminTournamentDetailErrorText: string | null
  adminTournamentActionBusy: boolean
  adminTournamentActionErrorText: string | null
  adminTournamentActionInfoText: string | null
  adminTournamentCancelConfirmOpen: boolean
  tournaments: TournamentSummarySnapshot[]
  tournamentsLoading: boolean
  tournamentsErrorText: string | null
  tournamentsFilter: 'all' | 'mine'
  tournamentCreatePopupOpen: boolean
  tournamentCreateBusy: boolean
  tournamentCreateErrorText: string | null
  tournamentDetailId: string | null
  tournamentDetailLoading: boolean
  tournamentDetailErrorText: string | null
  tournamentDetail: TournamentDetailSnapshot | null
  tournamentDetailRequiresPassword: boolean
  tournamentDetailPasswordDraft: string
  /**
   * Паролата, с която потребителят успешно отключи детайлния изглед на
   * защитен турнир — пази се само в паметта на тази сесия (никога в
   * персистентен state, DTO или лог), за да не се налага повторното ѝ
   * въвеждане при "Запиши се сам" / "Участвай с партньор" веднага след
   * отключването. За създателя и за вече записан участник остава null,
   * тъй като сървърът не изисква парола в тези случаи.
   */
  tournamentDetailVerifiedPassword: string | null
  tournamentDetailUnlockBusy: boolean
  tournamentDetailUnlockErrorText: string | null
  tournamentJoinConfirmOpen: boolean
  tournamentJoinBusy: boolean
  tournamentJoinErrorText: string | null
  tournamentPartnerInvites: TournamentPartnerInviteSnapshot[]
  tournamentPartnerCandidates: TournamentPartnerCandidateSnapshot[]
  tournamentPartnerPickerOpen: boolean
  tournamentPartnerPickerLoading: boolean
  tournamentPartnerPickerErrorText: string | null
  tournamentPartnerInviteBusy: boolean
  tournamentPartnerInviteErrorText: string | null
  tournamentPartnerInviteQuery: string
  tournamentLeaveConfirmOpen: boolean
  tournamentLeaveBusy: boolean
  tournamentLeaveErrorText: string | null
  tournamentCancelConfirmOpen: boolean
  tournamentCancelBusy: boolean
  tournamentCancelErrorText: string | null
}

const DEFAULT_REQUIRED_PLAYERS = 4
const DEFAULT_COUNTDOWN_MS = 20000
const LOBBY_CHAT_CLIENT_MAX_MESSAGES = 80
const GUEST_TRIAL_MAX_GAMES = 3
export const GUEST_TRIAL_STAKE: MatchStake = 5000
const FINAL_FILL_START_REMAINING_MS = 3000
const FINAL_FILL_STAGGER_OFFSETS_MS = [0, 720, 1120] as const
const FINAL_FILL_MATCH_START_DELAY_MS = 1000

const WAITING_CLOCK_AUDIO_SRC = '/audio/ui/waiting-clock.mp3'
const WAITING_CLOCK_AUDIO_VOLUME = 0.75

const SEAT_FILL_AUDIO_SRC = '/audio/ui/player-seat-fill.mp3'
const SEAT_FILL_AUDIO_VOLUME = 0.9
const SEAT_FILL_SOUND_STAGGER_MS = 120


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
    profilePopupTargetRole: null,
    profilePopupTargetRoleProfileId: null,
    subadminActionConfirm: null,
    subadminActionBusy: false,
    subadminActionToast: null,
    chatAdminActionConfirm: null,
    chatAdminActionBusy: false,
    chatAdminActionToast: null,
    profileEditorOpen: false,
    profileEditorTargetProfileId: null,
    profileEditorTargetProfile: null,
    profileEditorErrorText: null,
    profileEditorSubmitting: false,
    profileNameChangeErrorText: null,
    profileNameChangeSuccessAmount: null,
    changePasswordPopupOpen: false,
    changePasswordErrorText: null,
    ownLikesCount: null,
    authModalMode: 'closed',
    authErrorText: null,
    authSubmitInFlight: false,
    guestTrialPopup: {
      isOpen: false,
      gamesUsed: 0,
      remaining: GUEST_TRIAL_MAX_GAMES,
      maxGames: GUEST_TRIAL_MAX_GAMES,
      errorText: null,
      isSubmitting: false,
      hasConfirmedStatus: false,
    },
    guestLockedStakePopup: {
      isOpen: false,
    },
    levelLockedStakePopup: {
      isOpen: false,
      requiredLevel: 1,
      currentLevel: 1,
    },
    lowCoinsModalOpen: false,
    serverRoomSeats: null,
    serverYourSeat: null,
    serverQueuedPlayerPreviews: [],
    serverPreviewBotDisplayNames: [],
    players: [],
    playersPage: 1,
    playersSnapshotToken: null,
    playersTotalCount: 0,
    playersTotalPages: 1,
    playersSearchQuery: '',
    playersSearchDraft: '',
    playersSearchResults: null,
    playersSearchLoading: false,
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
    shopPurchaseConfirmPackageId: null,
    shopPurchaseActionPackageId: null,
    shopPurchaseMessageText: null,
    shopPurchaseResumeId: null,
    shopPurchaseHideConfirmId: null,
    shopPurchaseActionPurchaseId: null,
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
    giftReceivedModal: null,
    pendingGiftNotifications: [],
    acceptanceNotifications: [],
    acceptanceProcessingIds: new Set<string>(),
    acceptanceErrorText: null,
    chatConversations: [],
    activeChatFriendshipId: null,
    chatMessages: [],
    chatLoading: false,
    chatMessagesLoading: false,
    chatErrorText: null,
    chatDraftByFriendshipId: {},
    chatPendingImageByFriendshipId: {},
    chatUploadingFriendshipIds: new Set<string>(),
    lobbyChatMessages: [],
    lobbyChatSubscribed: false,
    lobbyChatDraft: '',
    lobbyChatSending: false,
    lobbyChatPendingRequestId: null,
    lobbyChatErrorText: null,
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
    privateRoomWaitingChatMessages: [],
    privateRoomWaitingChatSubscribedRoomId: null,
    privateRoomWaitingChatDraft: '',
    privateRoomWaitingChatSending: false,
    privateRoomWaitingChatPendingRequestId: null,
    privateRoomWaitingChatErrorText: null,
    privateRoomWaitingLeaveConfirmOpen: false,
    privateRoomWaitingFillBotsConfirmOpen: false,
    privateRoomWaitingFillBotsLoading: false,
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
    guestContactPopupOpen: false,
    guestContactSending: false,
    guestContactErrorText: null,
    guestContactSuccessText: null,
    adminSupportConversations: [],
    adminSupportConversationsLoading: false,
    adminSupportSelectedProfileId: null,
    adminSupportMessages: [],
    adminSupportMessagesLoading: false,
    adminSupportReplyLoading: false,
    adminSupportDeleteConfirmProfileId: null,
    adminSupportDeleteLoading: false,
    adminSupportMobileConversationOpen: false,
    adminGuestContactMessages: [],
    adminGuestContactMessagesLoading: false,
    adminGuestContactMessagesErrorText: null,
    adminGuestContactUnreadCount: 0,
    supportDeleteConfirm: false,
    supportDeleteLoading: false,
    supportAccountTooNewMinutes: null,
    adminMonitoringSnapshot: null,
    adminMonitoringErrorText: null,
    adminHistoryWindow: '1h',
    adminHistoryResult: null,
    adminHistoryLoading: false,
    adminHistoryErrorText: null,
    adminWsConnections: null,
    adminVisitorsLoading: false,
    adminVisitorsRows: [],
    adminVisitorsTotal: 0,
    adminVisitorsErrorText: null,
    adminVisitorsPeriod: 'today',
    adminVisitorsType: 'all',
    adminVisitorsDevice: 'all',
    adminVisitorsOs: 'all',
    adminVisitorsOffset: 0,
    adminVisitorsLimit: 50,
    adminVisitorsView: 'visitors',
    adminVisitorsSourcesLoading: false,
    adminVisitorsSourcesRows: [],
    adminVisitorsSourcesTotal: 0,
    adminVisitorsSourcesErrorText: null,
    adminPaymentsPeriod: 'today',
    adminPaymentsLoading: false,
    adminPaymentsRows: [],
    adminPaymentsTotal: 0,
    adminPaymentsTotalsByCurrency: {},
    adminPaymentsErrorText: null,
    adminPaymentsOffset: 0,
    adminPaymentsLimit: 50,
    adminPaymentDetailPurchaseId: null,
    adminPaymentDetailLoading: false,
    adminPaymentDetailPurchase: null,
    adminPaymentDetailErrorText: null,
    adminPaymentDetailFromPeriod: null,
    adminTournamentsLoading: false,
    adminTournamentsRows: [],
    adminTournamentsTotal: 0,
    adminTournamentsErrorText: null,
    adminTournamentsCanWrite: false,
    adminTournamentsFilters: {
      page: 1,
      limit: 25,
      status: '',
      settlementState: '',
      visibility: '',
      startMode: '',
      integrityState: '',
      search: '',
    },
    adminTournamentDetailId: null,
    adminTournamentDetailLoading: false,
    adminTournamentDetail: null,
    adminTournamentDetailErrorText: null,
    adminTournamentActionBusy: false,
    adminTournamentActionErrorText: null,
    adminTournamentActionInfoText: null,
    adminTournamentCancelConfirmOpen: false,
    tournaments: [],
    tournamentsLoading: false,
    tournamentsErrorText: null,
    tournamentsFilter: 'all',
    tournamentCreatePopupOpen: false,
    tournamentCreateBusy: false,
    tournamentCreateErrorText: null,
    tournamentDetailId: null,
    tournamentDetailLoading: false,
    tournamentDetailErrorText: null,
    tournamentDetail: null,
    tournamentDetailRequiresPassword: false,
    tournamentDetailPasswordDraft: '',
    tournamentDetailVerifiedPassword: null,
    tournamentDetailUnlockBusy: false,
    tournamentDetailUnlockErrorText: null,
    tournamentJoinConfirmOpen: false,
    tournamentJoinBusy: false,
    tournamentJoinErrorText: null,
    tournamentPartnerInvites: [],
    tournamentPartnerCandidates: [],
    tournamentPartnerPickerOpen: false,
    tournamentPartnerPickerLoading: false,
    tournamentPartnerPickerErrorText: null,
    tournamentPartnerInviteBusy: false,
    tournamentPartnerInviteErrorText: null,
    tournamentPartnerInviteQuery: '',
    tournamentLeaveConfirmOpen: false,
    tournamentLeaveBusy: false,
    tournamentLeaveErrorText: null,
    tournamentCancelConfirmOpen: false,
    tournamentCancelBusy: false,
    tournamentCancelErrorText: null,
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

function normalizeQueuedPlayerPreviews(
  previews: Array<{ id: string; name: string; avatarUrl?: string | null; isBot?: boolean }> | undefined,
): MatchmakingRoomPlayer[] {
  return (previews ?? []).map((player, index) => ({
    id: player.id.trim() || `queued-player-${index + 1}`,
    name: player.name.trim() || WAITING_PLAYER_DISPLAY_NAME,
    avatarUrl: player.avatarUrl ?? null,
    isBot: player.isBot === true,
  }))
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
  '/admin/guest-contact': 'guest-contact-messages',
  '/admin/visitors': 'admin-visitors',
  '/admin/payments': 'admin-payments',
  '/admin/tournaments': 'admin-tournaments',
  '/friends': 'friends',
  '/chat': 'chat',
  '/terms': 'terms',
  '/privacy': 'privacy',
  '/contact': 'contact',
  '/rules': 'rules',
  '/strategy': 'strategy',
  '/learn': 'learn',
  '/faq': 'faq',
  '/about': 'about',
  '/fair-play': 'fair-play',
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
  let _privateRoomWaitingViewportListenerAttached = false

  function shouldSuppressLobbyRender(): boolean {
    return (options.suppressRendering === true) || (options.getIsInGame?.() ?? false)
  }

  function scheduleRender(): void {
    if (shouldSuppressLobbyRender()) return
    if (_renderTimerId !== null) clearTimeout(_renderTimerId)
    _renderTimerId = setTimeout(() => {
      _renderTimerId = null
      render()
    }, 50)
  }

  // --- Players directory server-side search (debounced, latest-wins) ---
  const PLAYERS_SEARCH_MIN_QUERY_LENGTH = 2

  const playersSearchRunner = createDebouncedPlayerSearch<PlayerPublicProfileSnapshot[]>({
    run: (query, signal) => {
      if (!options.onPlayersSearch) {
        return Promise.reject(new Error('Търсенето временно не е налично.'))
      }
      return options.onPlayersSearch(query, signal).then((result) => {
        if (!result.ok) {
          throw new Error(result.message)
        }
        return result.players
      })
    },
    onResult: (result) => {
      // Игнорирай, ако вече не сме на страница "Играчи" или полето вече
      // не съдържа точно този query (напр. потребителят е продължил да
      // пише/изчисти междувременно) — защита срещу stale отговор.
      if (state.currentScreen !== 'players') return
      if (state.playersSearchQuery.trim() !== result.query) return
      state.playersSearchLoading = false
      if (result.ok) {
        state.playersSearchResults = result.value
      }
      // При грешка (различна от отменена заявка) запазваме сегашния
      // playersSearchResults/локален filter непроменен — без flicker.
      render()
    },
    delayMs: 300,
  })

  function triggerPlayersSearch(query: string): void {
    const trimmed = query.trim()
    if (trimmed.length < PLAYERS_SEARCH_MIN_QUERY_LENGTH) {
      playersSearchRunner.cancel()
      state.playersSearchResults = null
      state.playersSearchLoading = false
      return
    }
    state.playersSearchLoading = true
    playersSearchRunner.schedule(trimmed)
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

  // Отделен tick loop за брояча в чакалнята на частна маса — независим от
  // matchmaking countdown-а по-горе (никога не са активни едновременно, но
  // логически не са свързани). Обновява само текста/класовете на
  // [data-private-room-countdown="1"] елементите чрез DOM мутация, БЕЗ пълен
  // render() — чакалнята съдържа чат с draft/focus/caret/scroll състояние,
  // което пълен render всяка секунда би застрашил.
  let privateRoomCountdownIntervalId: ReturnType<typeof setInterval> | null = null
  let privateRoomCountdownRoomId: string | null = null
  let privateRoomCountdownExpiresAt: number | null = null

  // Tick loop за scheduled-start / fill-expiry countdown-а в tournament detail
  // "Старт" картата. Същия DOM-only patch подход като частните стаи по-горе —
  // секундният tick само пренаписва secondary/tertiary текста в картата, без
  // пълен render(). Единичен interval, разграничен по (tournamentId, deadline)
  // двойка — работи и за двата start mode-а (scheduled патчва secondary,
  // fill патчва tertiary), никога и двата едновременно за един турнир.
  let tournamentStartCountdownIntervalId: ReturnType<typeof setInterval> | null = null
  let tournamentStartCountdownTournamentId: string | null = null
  let tournamentStartCountdownDeadline: string | null = null

  // Единичен споделен interval за ВСИЧКИ fill-expiry countdown badge-ове в
  // списъчния изглед "Турнири" (§13 в task spec-а) — обхожда всички
  // [data-tournament-card-fill-expiry] node-ове на всеки tick, вместо по
  // един timer на карта. DOM-only patch, никакъв server polling.
  let tournamentListFillExpiryIntervalId: ReturnType<typeof setInterval> | null = null

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

    const previewPlayers = state.serverQueuedPlayerPreviews.slice(0, actualOtherPlayers)
    const placeholderCount = Math.max(0, actualOtherPlayers - previewPlayers.length)
    const placeholderPlayers = Array.from({ length: placeholderCount }, (_, index) => ({
      id: `queued-preview-${index + 1}`,
      name: WAITING_PLAYER_DISPLAY_NAME,
      avatarUrl: null,
      isBot: false,
    }))

    return [...previewPlayers, ...placeholderPlayers, ...autoFillPreviewPlayers.slice(0, autoFillCount)]
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

  function updatePrivateRoomCountdownDom(expiresAt: number): void {
    const remainingMs = Math.max(0, expiresAt - Date.now())
    const text = formatPrivateRoomCountdown(remainingMs)
    const countdownState = getPrivateRoomCountdownState(remainingMs)

    const badges = options.root.querySelectorAll<HTMLElement>('[data-private-room-countdown="1"]')
    badges.forEach((badge) => {
      badge.classList.remove('prw-countdown-normal', 'prw-countdown-warning', 'prw-countdown-critical')
      badge.classList.add(`prw-countdown-${countdownState}`)
      const valueEl = badge.querySelector<HTMLElement>('[data-private-room-countdown-value="1"]')
      if (valueEl !== null) {
        valueEl.textContent = text
      }
    })
  }

  function clearPrivateRoomCountdownLoop(): void {
    if (privateRoomCountdownIntervalId !== null) {
      window.clearInterval(privateRoomCountdownIntervalId)
      privateRoomCountdownIntervalId = null
    }
    privateRoomCountdownRoomId = null
    privateRoomCountdownExpiresAt = null
  }

  // Idempotent: called after every renderPrivateRoomWaitingRoom() re-render
  // (chat message, member join/leave, etc.), which happens far more often
  // than the room id or expiresAt actually change. Only tears down and
  // restarts the interval when the (roomId, expiresAt) pair changes; a
  // same-room/same-expiresAt re-render just re-syncs the freshly rendered
  // DOM node (its innerHTML replace means the DOM element from the previous
  // render no longer exists) without touching the interval itself.
  function startPrivateRoomCountdownLoop(roomId: string, expiresAt: number): void {
    if (privateRoomCountdownIntervalId !== null &&
      privateRoomCountdownRoomId === roomId &&
      privateRoomCountdownExpiresAt === expiresAt
    ) {
      updatePrivateRoomCountdownDom(expiresAt)
      return
    }

    clearPrivateRoomCountdownLoop()
    privateRoomCountdownRoomId = roomId
    privateRoomCountdownExpiresAt = expiresAt

    updatePrivateRoomCountdownDom(expiresAt)

    privateRoomCountdownIntervalId = window.setInterval(() => {
      const currentRoom = state.myPrivateRoom
      if (state.currentScreen !== 'private-room-waiting' || currentRoom === null) {
        clearPrivateRoomCountdownLoop()
        return
      }
      // Recompute from the server-authoritative expiresAt every tick rather
      // than counting down a locally-held remaining value — avoids drift and
      // matches the "client never decides closure" contract: reaching 00:00
      // here only changes displayed text, it never removes the room locally.
      updatePrivateRoomCountdownDom(currentRoom.expiresAt)
    }, 1000)
  }

  function updateTournamentStartCountdownDom(mode: 'scheduled' | 'fill', deadline: string): void {
    const card = options.root.querySelector<HTMLElement>('[data-tournament-start-card="1"]')
    const targetEl = mode === 'scheduled'
      ? card?.querySelector<HTMLElement>('[data-tournament-start-secondary="1"]')
      : card?.querySelector<HTMLElement>('[data-tournament-start-tertiary="1"]')
    if (targetEl === null || targetEl === undefined) return
    const remainingMs = new Date(deadline).getTime() - Date.now()
    const text = mode === 'scheduled'
      ? (Number.isFinite(remainingMs) && remainingMs > 0
          ? formatTournamentStartCountdown(remainingMs)
          : 'Очаква се започване...')
      : (Number.isFinite(remainingMs) && remainingMs > 0
          ? formatTournamentFillExpiryCountdown(remainingMs)
          : 'Срокът изтече. Изчаква се автоматична отмяна...')
    targetEl.textContent = text
    targetEl.style.display = ''
  }

  function clearTournamentStartCountdownLoop(): void {
    if (tournamentStartCountdownIntervalId !== null) {
      window.clearInterval(tournamentStartCountdownIntervalId)
      tournamentStartCountdownIntervalId = null
    }
    tournamentStartCountdownTournamentId = null
    tournamentStartCountdownDeadline = null
  }

  // Idempotent — извиква се след всеки renderLobby() докато сме на detail
  // екрана. Рестартира interval-а само когато турнирът или deadline-ът
  // реално се сменят; иначе просто пресинхронизира DOM-а на прясно рендерания
  // node (innerHTML replace означава старият node вече не съществува).
  // mode определя кой DOM node (secondary за scheduled, tertiary за fill) и
  // кой safe post-deadline текст се ползва — двата start mode-а никога не
  // са едновременно активни за един турнир (start_mode се фиксира при
  // създаване), затова един interval стига.
  function startTournamentStartCountdownLoop(
    tournamentId: string,
    mode: 'scheduled' | 'fill',
    deadline: string,
  ): void {
    if (tournamentStartCountdownIntervalId !== null &&
      tournamentStartCountdownTournamentId === tournamentId &&
      tournamentStartCountdownDeadline === deadline
    ) {
      updateTournamentStartCountdownDom(mode, deadline)
      return
    }

    clearTournamentStartCountdownLoop()
    tournamentStartCountdownTournamentId = tournamentId
    tournamentStartCountdownDeadline = deadline

    updateTournamentStartCountdownDom(mode, deadline)

    tournamentStartCountdownIntervalId = window.setInterval(() => {
      const currentDeadline = mode === 'scheduled'
        ? state.tournamentDetail?.scheduledStartAt
        : state.tournamentDetail?.fillExpiresAt
      if (
        state.currentScreen !== 'tournament-detail' ||
        state.tournamentDetailId !== tournamentId ||
        currentDeadline !== deadline
      ) {
        clearTournamentStartCountdownLoop()
        return
      }
      updateTournamentStartCountdownDom(mode, deadline)
    }, 1000)
  }

  function updateTournamentListFillExpiryBadges(): void {
    const badges = options.root.querySelectorAll<HTMLElement>('[data-tournament-card-fill-expiry="1"]')
    if (badges.length === 0) return
    const nowMs = Date.now()
    badges.forEach((badge) => {
      const expiresAt = badge.dataset.fillExpiresAt
      if (!expiresAt) return
      const remainingMs = new Date(expiresAt).getTime() - nowMs
      badge.textContent = Number.isFinite(remainingMs) && remainingMs > 0
        ? formatTournamentFillExpiryCountdown(remainingMs)
        : 'Срокът изтече. Изчаква се автоматична отмяна...'
    })
  }

  function clearTournamentListFillExpiryLoop(): void {
    if (tournamentListFillExpiryIntervalId !== null) {
      window.clearInterval(tournamentListFillExpiryIntervalId)
      tournamentListFillExpiryIntervalId = null
    }
  }

  // Idempotent — извиква се след всеки renderLobby() докато сме на списъчния
  // "Турнири" екран. Един interval обхожда ВСИЧКИ carded fill-expiry badge-ове
  // наведнъж (виж renderTournamentCardFillExpiryBadge) — не създава нов timer
  // per карта, работи еднакво добре за 1 или N активни fill турнира.
  function startTournamentListFillExpiryLoop(): void {
    if (tournamentListFillExpiryIntervalId !== null) {
      updateTournamentListFillExpiryBadges()
      return
    }
    updateTournamentListFillExpiryBadges()
    tournamentListFillExpiryIntervalId = window.setInterval(() => {
      if (state.currentScreen !== 'tournaments') {
        clearTournamentListFillExpiryLoop()
        return
      }
      updateTournamentListFillExpiryBadges()
    }, 1000)
  }

  /** "Информация" family — screens with read-only subadmin+admin access (виж isAdminOrSubadminAuthSession). */
  function isAdminInfoFamilyScreen(screen: LobbySocialScreen): boolean {
    return screen === 'admin-info' || screen === 'admin-visitors' ||
      screen === 'admin-payments' || screen === 'admin-payment-detail' ||
      screen === 'admin-tournaments' || screen === 'admin-tournament-detail'
  }

  /**
   * Спира ВСИЧКИ admin-screen polling цикли, ако в момента сме на такъв
   * екран — "Сървър" (monitoring/connections polling) и "Информация"
   * family (лек role-check polling, виж onAdminInfoFamilyScreenEnter/Leave).
   * Извиква се в началото на практически всяка навигационна функция, за да
   * не остане polling активен след напускане на съответния екран.
   */
  function leaveAdminServerIfActive(): void {
    if (state.currentScreen === 'admin-server') {
      options.onAdminServerScreenLeave?.()
    }
    if (isAdminInfoFamilyScreen(state.currentScreen)) {
      options.onAdminInfoFamilyScreenLeave?.()
    }
  }

  /**
   * Ролята е отнета докато потребителят е бил на административен екран
   * (напр. subadmin revoke-нат междувременно, докато е на "Сървър" с
   * активен polling, или на "Информация" — idle или при 403 от реална
   * заявка). Backend вече отказва заявките — това само връща UI безопасно
   * към лобито вместо да остави счупен/празен екран. Проверява текущия
   * екран В МОМЕНТА НА ИЗВИКВАНЕ — ако потребителят вече е навигирал към
   * друг (не-admin) екран междувременно, не прави нищо (без stale redirect).
   */
  function forceLeaveAdminScreenForbidden(message: string): void {
    if (state.currentScreen !== 'admin' && state.currentScreen !== 'admin-info' &&
      state.currentScreen !== 'admin-server' && state.currentScreen !== 'admin-visitors' &&
      state.currentScreen !== 'admin-payments' && state.currentScreen !== 'admin-payment-detail' &&
      state.currentScreen !== 'admin-tournaments' && state.currentScreen !== 'admin-tournament-detail') {
      return
    }
    switchToLobby()
    state.errorText = message
    render()
  }

  function switchToLobby(): void {
    leaveAdminServerIfActive()
    const wasOnDifferentScreen = state.currentScreen !== 'lobby'
    state.currentScreen = 'lobby'
    state.isSearching = false
    state.queuedPlayers = 0
    state.requiredPlayers = DEFAULT_REQUIRED_PLAYERS
    state.remainingMs = null
    state.countdownEndsAt = null
    state.totalCountdownMs = DEFAULT_COUNTDOWN_MS
    state.serverPreviewBotDisplayNames = []
    state.serverQueuedPlayerPreviews = []
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
    ensureProfilePopupTargetRoleLoaded()
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
            : state.currentScreen === 'admin-server'
              ? 'admin-server'
            : state.currentScreen === 'admin-visitors'
              ? 'admin-visitors'
            : state.currentScreen === 'admin-payments'
              ? 'admin-payments'
            : state.currentScreen === 'admin-payment-detail'
              ? 'admin-payment-detail'
            : state.currentScreen === 'admin-tournaments'
              ? 'admin-tournaments'
            : state.currentScreen === 'admin-tournament-detail'
              ? 'admin-tournament-detail'
            : state.currentScreen === 'tournaments'
              ? 'tournaments'
            : state.currentScreen === 'tournament-detail'
              ? 'tournament-detail'
            : state.currentScreen === 'tournament-how-it-works'
              ? 'tournament-how-it-works'
            : state.currentScreen === 'guest-contact-messages'
              ? 'guest-contact-messages'
            : state.currentScreen === 'terms'
              ? 'terms'
            : state.currentScreen === 'privacy'
              ? 'privacy'
            : state.currentScreen === 'contact'
              ? 'contact'
            : state.currentScreen === 'rules'
              ? 'rules'
            : state.currentScreen === 'strategy'
              ? 'strategy'
            : state.currentScreen === 'learn'
              ? 'learn'
            : state.currentScreen === 'faq'
              ? 'faq'
            : state.currentScreen === 'about'
              ? 'about'
            : state.currentScreen === 'fair-play'
              ? 'fair-play'
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
      profilePopupTargetRole: state.profilePopupTargetRole,
      subadminActionConfirm: state.subadminActionConfirm,
      subadminActionBusy: state.subadminActionBusy,
      subadminActionToast: state.subadminActionToast,
      chatAdminActionConfirm: state.chatAdminActionConfirm,
      chatAdminActionBusy: state.chatAdminActionBusy,
      chatAdminActionToast: state.chatAdminActionToast,
      players: state.players,
      playersPage: state.playersPage,
      playersTotalCount: state.playersTotalCount,
      playersTotalPages: state.playersTotalPages,
      playersSearchQuery: state.playersSearchQuery,
      playersSearchDraft: state.playersSearchDraft,
      playersSearchResults: state.playersSearchResults,
      playersSearchLoading: state.playersSearchLoading,
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
      shopPurchaseConfirmPackageId: state.shopPurchaseConfirmPackageId,
      shopPurchaseActionPackageId: state.shopPurchaseActionPackageId,
      shopPurchaseMessageText: state.shopPurchaseMessageText,
      isAdmin: isFullAdminAuthSession(authSession),
      isAdminOrSubadmin: isAdminOrSubadminAuthSession(authSession),
      canDeleteLobbyChat: isLobbyChatModeratorAuthSession(authSession),
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
      giftReceivedModal: state.giftReceivedModal,
      pendingGiftNotifications: state.pendingGiftNotifications,
      acceptanceNotifications: state.acceptanceNotifications,
      acceptanceErrorText: state.acceptanceErrorText,
      chatConversations: state.chatConversations,
      activeChatFriendshipId: state.activeChatFriendshipId,
      chatMessages: state.chatMessages,
      chatLoading: state.chatLoading,
      chatMessagesLoading: state.chatMessagesLoading,
      chatErrorText: state.chatErrorText,
      chatDraftByFriendshipId: state.chatDraftByFriendshipId,
      chatPendingImageByFriendshipId: state.chatPendingImageByFriendshipId,
      chatUploadingFriendshipIds: state.chatUploadingFriendshipIds,
      lobbyChatMessages: state.lobbyChatMessages,
      lobbyChatSubscribed: state.lobbyChatSubscribed,
      lobbyChatDraft: state.lobbyChatDraft,
      lobbyChatSending: state.lobbyChatSending,
      lobbyChatErrorText: state.lobbyChatErrorText,
      authModalMode: state.authModalMode,
      authErrorText: state.authErrorText,
      guestTrialPopup: state.guestTrialPopup,
      guestLockedStakePopup: state.guestLockedStakePopup,
      levelLockedStakePopup: state.levelLockedStakePopup,
      lowCoinsModalOpen: state.lowCoinsModalOpen,
      onlinePlayersCount: options.getOnlinePlayersCount?.() ?? 0,
      signupBonusYellowCoins: options.getSignupBonusYellowCoins?.() ?? 100000,
      profileNameChangePrice:
        state.adminSettings?.profileNameChangePrice ??
        options.getProfileNameChangePrice?.() ??
        50000,
      profileEditorOpen: state.profileEditorOpen,
      profileEditorTargetProfileId: state.profileEditorTargetProfileId,
      profileEditorTargetProfile: state.profileEditorTargetProfile,
      profileEditorErrorText: state.profileEditorErrorText,
      profileEditorSubmitting: state.profileEditorSubmitting,
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
      guestContactPopupOpen: state.guestContactPopupOpen,
      guestContactSending: state.guestContactSending,
      guestContactErrorText: state.guestContactErrorText,
      guestContactSuccessText: state.guestContactSuccessText,
      adminSupportConversations: state.adminSupportConversations,
      adminSupportConversationsLoading: state.adminSupportConversationsLoading,
      adminSupportSelectedProfileId: state.adminSupportSelectedProfileId,
      adminSupportMessages: state.adminSupportMessages,
      adminSupportMessagesLoading: state.adminSupportMessagesLoading,
      adminSupportReplyLoading: state.adminSupportReplyLoading,
      adminSupportDeleteConfirmProfileId: state.adminSupportDeleteConfirmProfileId,
      adminSupportDeleteLoading: state.adminSupportDeleteLoading,
      adminSupportMobileConversationOpen: state.adminSupportMobileConversationOpen,
      adminGuestContactMessages: state.adminGuestContactMessages,
      adminGuestContactMessagesLoading: state.adminGuestContactMessagesLoading,
      adminGuestContactMessagesErrorText: state.adminGuestContactMessagesErrorText,
      adminGuestContactUnreadCount: state.adminGuestContactUnreadCount,
      supportDeleteConfirm: state.supportDeleteConfirm,
      supportDeleteLoading: state.supportDeleteLoading,
      supportAccountTooNewMinutes: state.supportAccountTooNewMinutes,
      adminMonitoringSnapshot: state.adminMonitoringSnapshot,
      adminMonitoringErrorText: state.adminMonitoringErrorText,
      adminHistoryWindow: state.adminHistoryWindow,
      adminHistoryResult: state.adminHistoryResult,
      adminHistoryLoading: state.adminHistoryLoading,
      adminHistoryErrorText: state.adminHistoryErrorText,
      adminWsConnections: state.adminWsConnections,
      adminVisitorsLoading: state.adminVisitorsLoading,
      adminVisitorsRows: state.adminVisitorsRows,
      adminVisitorsTotal: state.adminVisitorsTotal,
      adminVisitorsErrorText: state.adminVisitorsErrorText,
      adminVisitorsPeriod: state.adminVisitorsPeriod,
      adminVisitorsType: state.adminVisitorsType,
      adminVisitorsDevice: state.adminVisitorsDevice,
      adminVisitorsOs: state.adminVisitorsOs,
      adminVisitorsOffset: state.adminVisitorsOffset,
      adminVisitorsLimit: state.adminVisitorsLimit,
      adminVisitorsView: state.adminVisitorsView,
      adminVisitorsSourcesLoading: state.adminVisitorsSourcesLoading,
      adminVisitorsSourcesRows: state.adminVisitorsSourcesRows,
      adminVisitorsSourcesTotal: state.adminVisitorsSourcesTotal,
      adminVisitorsSourcesErrorText: state.adminVisitorsSourcesErrorText,
      adminPaymentsPeriod: state.adminPaymentsPeriod,
      adminPaymentsLoading: state.adminPaymentsLoading,
      adminPaymentsRows: state.adminPaymentsRows,
      adminPaymentsTotal: state.adminPaymentsTotal,
      adminPaymentsTotalsByCurrency: state.adminPaymentsTotalsByCurrency,
      adminPaymentsErrorText: state.adminPaymentsErrorText,
      adminPaymentsOffset: state.adminPaymentsOffset,
      adminPaymentsLimit: state.adminPaymentsLimit,
      adminPaymentDetailPurchaseId: state.adminPaymentDetailPurchaseId,
      adminPaymentDetailLoading: state.adminPaymentDetailLoading,
      adminPaymentDetailPurchase: state.adminPaymentDetailPurchase,
      adminPaymentDetailErrorText: state.adminPaymentDetailErrorText,
      adminTournamentsLoading: state.adminTournamentsLoading,
      adminTournamentsRows: state.adminTournamentsRows,
      adminTournamentsTotal: state.adminTournamentsTotal,
      adminTournamentsErrorText: state.adminTournamentsErrorText,
      adminTournamentsCanWrite: state.adminTournamentsCanWrite,
      adminTournamentsFilters: state.adminTournamentsFilters,
      adminTournamentDetailId: state.adminTournamentDetailId,
      adminTournamentDetailLoading: state.adminTournamentDetailLoading,
      adminTournamentDetail: state.adminTournamentDetail,
      adminTournamentDetailErrorText: state.adminTournamentDetailErrorText,
      adminTournamentActionBusy: state.adminTournamentActionBusy,
      adminTournamentActionErrorText: state.adminTournamentActionErrorText,
      adminTournamentActionInfoText: state.adminTournamentActionInfoText,
      adminTournamentCancelConfirmOpen: state.adminTournamentCancelConfirmOpen,
      tournaments: state.tournaments,
      tournamentsLoading: state.tournamentsLoading,
      tournamentsErrorText: state.tournamentsErrorText,
      tournamentsFilter: state.tournamentsFilter,
      tournamentCreatePopupOpen: state.tournamentCreatePopupOpen,
      tournamentCreateBusy: state.tournamentCreateBusy,
      tournamentCreateErrorText: state.tournamentCreateErrorText,
      tournamentDetailId: state.tournamentDetailId,
      tournamentDetailLoading: state.tournamentDetailLoading,
      tournamentDetailErrorText: state.tournamentDetailErrorText,
      tournamentDetail: state.tournamentDetail,
      tournamentDetailRequiresPassword: state.tournamentDetailRequiresPassword,
      tournamentDetailPasswordDraft: state.tournamentDetailPasswordDraft,
      tournamentDetailUnlockBusy: state.tournamentDetailUnlockBusy,
      tournamentDetailUnlockErrorText: state.tournamentDetailUnlockErrorText,
      tournamentJoinConfirmOpen: state.tournamentJoinConfirmOpen,
      tournamentJoinBusy: state.tournamentJoinBusy,
      tournamentJoinErrorText: state.tournamentJoinErrorText,
      tournamentPartnerInvites: state.tournamentPartnerInvites,
      tournamentPartnerCandidates: state.tournamentPartnerCandidates,
      tournamentPartnerPickerOpen: state.tournamentPartnerPickerOpen,
      tournamentPartnerPickerLoading: state.tournamentPartnerPickerLoading,
      tournamentPartnerPickerErrorText: state.tournamentPartnerPickerErrorText,
      tournamentPartnerInviteBusy: state.tournamentPartnerInviteBusy,
      tournamentPartnerInviteErrorText: state.tournamentPartnerInviteErrorText,
      tournamentPartnerInviteQuery: state.tournamentPartnerInviteQuery,
      tournamentLeaveConfirmOpen: state.tournamentLeaveConfirmOpen,
      tournamentLeaveBusy: state.tournamentLeaveBusy,
      tournamentLeaveErrorText: state.tournamentLeaveErrorText,
      tournamentCancelConfirmOpen: state.tournamentCancelConfirmOpen,
      tournamentCancelBusy: state.tournamentCancelBusy,
      tournamentCancelErrorText: state.tournamentCancelErrorText,
      shopPurchaseResumeId: state.shopPurchaseResumeId,
      shopPurchaseHideConfirmId: state.shopPurchaseHideConfirmId,
      shopPurchaseActionPurchaseId: state.shopPurchaseActionPurchaseId,
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
      // ВАЖНО: трябва да приема profileId и да делегира към същия
      // openProfileEditorForTarget(), който ползва getPopupCallbacks().onEditClick
      // — този callback е закачен от renderLobbyScreen() (главния full-render
      // path, ред ~9170), който презаписва popup DOM-а при ВСЯКО WS събитие
      // (chat, presence, countdown...), не само при явна потребителска
      // навигация. Преди този фикс тук се игнорираше подаденият profileId и
      // винаги се отваряше собственият профил на admin-а — ако между
      // отварянето на попъпа за чужд играч и клика на "Редакция" минеше
      // дори един такъв фонов re-render (почти сигурно на практика), бутонът
      // мълчаливо пренасочваше редакцията към самия admin.
      onProfileEditClick: (profileId) => {
        getPopupCallbacks().onEditClick(profileId)
      },
      onProfileGrantSubadminClick: (profileId) => {
        getPopupCallbacks().onGrantSubadminClick(profileId)
      },
      onProfileRevokeSubadminClick: (profileId) => {
        getPopupCallbacks().onRevokeSubadminClick(profileId)
      },
      onSubadminActionCancel: () => {
        cancelSubadminAction()
      },
      onSubadminActionConfirm: () => {
        void confirmSubadminAction()
      },
      onProfileGrantChatAdminClick: (profileId) => {
        getPopupCallbacks().onGrantChatAdminClick(profileId)
      },
      onProfileRevokeChatAdminClick: (profileId) => {
        getPopupCallbacks().onRevokeChatAdminClick(profileId)
      },
      onChatAdminActionCancel: () => {
        cancelChatAdminAction()
      },
      onChatAdminActionConfirm: () => {
        void confirmChatAdminAction()
      },
      onProfileEditClose: () => {
        if (state.profileEditorSubmitting) return
        state.profileEditorOpen = false
        state.profileEditorTargetProfileId = null
        state.profileEditorTargetProfile = null
        state.profileEditorErrorText = null
        state.profileNameChangeErrorText = null
        state.profileNameChangeSuccessAmount = null
        clearProfileEditorPendingState()
        render()
      },
      onProfileEditorFileError: (message) => {
        state.profileEditorErrorText = message
        state.profileEditorSubmitting = false
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
        openShopPurchaseConfirm(packageId)
      },
      onShopPurchaseConfirm: () => {
        const dispatch = computeShopPurchaseConfirmDispatch(
          state.shopPurchaseResumeId,
          state.shopPurchaseConfirmPackageId,
        )
        if (dispatch.action === 'resume') void resumeShopPurchase(dispatch.purchaseId)
        else if (dispatch.action === 'new-purchase') void startShopPurchase(dispatch.packageId)
      },
      onShopPurchaseCancel: () => {
        if (state.shopPurchaseActionPackageId !== null) return
        if (state.shopPurchaseActionPurchaseId !== null) return
        state.shopPurchaseConfirmPackageId = null
        state.shopPurchaseResumeId = null
        render()
      },
      onShopPurchaseResumePay: (purchaseId: string) => {
        void openShopResumeConfirm(purchaseId)
      },
      onShopPurchaseHideRequest: (purchaseId: string) => {
        state.shopPurchaseHideConfirmId = purchaseId
        render()
      },
      onShopPurchaseHideConfirm: () => {
        const purchaseId = state.shopPurchaseHideConfirmId
        if (purchaseId !== null) {
          state.shopPurchaseHideConfirmId = null
          void hideShopPurchase(purchaseId)
        }
      },
      onShopPurchaseHideCancel: () => {
        state.shopPurchaseHideConfirmId = null
        render()
      },
      onShopHistoryToggle: () => {
        state.shopPurchasesVisible = !state.shopPurchasesVisible
        render()
      },
      onLeaderboardsClick: () => {
        void showLeaderboardsDirectory()
      },
      onTournamentsClick: () => {
        void showTournamentsList()
      },
      onTournamentHowItWorksOpen: () => {
        showTournamentHowItWorksPage()
      },
      onTournamentsFilterChange: (filter) => {
        setTournamentsFilter(filter)
      },
      onTournamentCreatePopupOpen: () => {
        openTournamentCreatePopup()
      },
      onTournamentCreatePopupClose: () => {
        closeTournamentCreatePopup()
      },
      onTournamentCreateSubmit: (input) => {
        void submitTournamentCreate(input)
      },
      onTournamentCardClick: (tournamentId) => {
        showTournamentDetail(tournamentId)
      },
      onTournamentDetailPasswordDraftChange: (value) => {
        setTournamentDetailPasswordDraft(value)
      },
      onTournamentUnlockSubmit: () => {
        void submitTournamentUnlock()
      },
      onTournamentJoinConfirmOpen: () => {
        openTournamentJoinConfirm()
      },
      onTournamentJoinConfirmClose: () => {
        closeTournamentJoinConfirm()
      },
      onTournamentJoinSubmit: () => {
        void submitTournamentJoin()
      },
      onTournamentPartnerPickerOpen: () => {
        void openTournamentPartnerPicker()
      },
      onTournamentPartnerPickerClose: () => {
        closeTournamentPartnerPicker()
      },
      onTournamentPartnerInviteSubmit: (profileId) => {
        void submitTournamentPartnerInvite(profileId)
      },
      onTournamentPartnerInviteQueryChange: (value) => {
        state.tournamentPartnerInviteQuery = value
        render()
      },
      onTournamentPartnerInviteAccept: (tournamentId, inviteId) => {
        void respondTournamentPartnerInvite(tournamentId, inviteId, 'accept')
      },
      onTournamentPartnerInviteDecline: (tournamentId, inviteId) => {
        void respondTournamentPartnerInvite(tournamentId, inviteId, 'decline')
      },
      onTournamentPartnerInviteCancel: (tournamentId, inviteId) => {
        void respondTournamentPartnerInvite(tournamentId, inviteId, 'cancel')
      },
      onTournamentEnterActiveMatch: (roomId, reconnectToken) => {
        options.onTournamentEnterActiveMatch?.(roomId, reconnectToken)
      },
      onTournamentLeaveConfirmOpen: () => {
        openTournamentLeaveConfirm()
      },
      onTournamentLeaveConfirmClose: () => {
        closeTournamentLeaveConfirm()
      },
      onTournamentLeaveSubmit: () => {
        void submitTournamentLeave()
      },
      onTournamentCancelConfirmOpen: () => {
        openTournamentCancelConfirm()
      },
      onTournamentCancelConfirmClose: () => {
        closeTournamentCancelConfirm()
      },
      onTournamentCancelSubmit: () => {
        void submitTournamentCancel()
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
      onAdminServerClick: () => {
        showAdminServerPanel()
      },
      onAdminGuestContactMessagesClick: () => {
        void showAdminGuestContactMessages()
      },
      onAdminGuestContactMessageRead: (messageId) => {
        void markAdminGuestContactMessageRead(messageId)
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
      onAdminCoinPackageTopOfferToggle: (packageId, isTopOffer) => {
        void toggleAdminCoinPackageTopOffer(packageId, isTopOffer)
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
      onChatDraftChange: (friendshipId, draft) => {
        // Нарочно без render(): чист локален state update, докато потребителят пише.
        // Браузърът пази фокуса/каретата в живия <input> без нужда от re-render;
        // state само служи като "чернова backup", ползван при следващ фонов re-render.
        state.chatDraftByFriendshipId = { ...state.chatDraftByFriendshipId, [friendshipId]: draft }
      },
      onChatImageSelect: (friendshipId, file) => {
        selectChatImage(friendshipId, file)
      },
      onChatImageRemove: (friendshipId) => {
        clearChatPendingImage(friendshipId)
        render()
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
      onPlayersSearchChange: (query) => {
        // Desktop: обновява и draft, и applied → мигновен локален filter,
        // плюс debounced server-side search за резултати извън заредените.
        state.playersSearchDraft = query
        state.playersSearchQuery = query
        triggerPlayersSearch(query)
        render()
      },
      onPlayersSearchDraftChange: (draft) => {
        // Mobile: само draft — без render, браузърът пази input стойността
        state.playersSearchDraft = draft
      },
      onPlayersSearchSubmit: (query) => {
        // Mobile: използва реалната DOM стойност — надеждно при composition и гласово въвеждане
        state.playersSearchDraft = query
        state.playersSearchQuery = query
        triggerPlayersSearch(query)
        render()
      },
      onPlayersPageChange: (page) => { void goToPlayersPage(page) },
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
      onFriendCancelClick: (friendshipId) => {
        void cancelFriendRequest(friendshipId)
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
      onGiftReceivedClose: () => {
        state.giftReceivedModal = null
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
      onLobbyChatDraftChange: (value) => {
        updateLobbyChatDraft(value)
      },
      onLobbyChatSubmit: () => {
        submitLobbyChatMessage()
      },
      onLobbyChatDelete: (messageId) => {
        options.onLobbyChatDeleteMessage?.(messageId)
      },
      onGuestTrialPlayClick: () => {
        handleGuestTrialPlayClick()
      },
      onGuestTrialRegisterClick: () => {
        closeGuestTrialPopup()
        if (options.onGuestTrialRegisterClick) {
          options.onGuestTrialRegisterClick()
        } else {
          state.authModalMode = 'register'
          state.authErrorText = null
          render()
        }
      },
      onGuestTrialLoginClick: () => {
        closeGuestTrialPopup()
        if (options.onGuestTrialLoginClick) {
          options.onGuestTrialLoginClick()
        } else {
          state.authModalMode = 'login'
          state.authErrorText = null
          render()
        }
      },
      onGuestTrialClose: () => {
        closeGuestTrialPopup()
      },
      onGuestLockedStakePlay5000Click: () => {
        closeGuestLockedStakePopup()
        void openGuestTrialPopup()
      },
      onGuestLockedStakeRegisterClick: () => {
        closeGuestLockedStakePopup()
        if (options.onGuestTrialRegisterClick) {
          options.onGuestTrialRegisterClick()
        } else {
          state.authModalMode = 'register'
          state.authErrorText = null
          render()
        }
      },
      onGuestLockedStakeLoginClick: () => {
        closeGuestLockedStakePopup()
        if (options.onGuestTrialLoginClick) {
          options.onGuestTrialLoginClick()
        } else {
          state.authModalMode = 'login'
          state.authErrorText = null
          render()
        }
      },
      onGuestLockedStakeClose: () => {
        closeGuestLockedStakePopup()
      },
      onLevelLockedStakeViewProfileClick: () => {
        closeLevelLockedStakePopup()
        state.profilePopupProfile = null
        state.profilePopupCanEdit = true
        state.profilePopupOpen = true
        render()
        void fetchOwnLikesCount()
      },
      onLevelLockedStakeClose: () => {
        closeLevelLockedStakePopup()
      },
      onLoginSubmit: (email, password) => {
        void submitLogin(email, password)
      },
      onRegisterSubmit: (displayName, email, password, gender) => {
        void submitRegister(displayName, email, password, gender)
      },
      onForgotPasswordSubmit: (email) => {
        void submitForgotPassword(email)
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
        state.giftReceivedModal = { amount, fromDisplayName }
        void options.onMarkGiftNotificationRead?.(giftId)
        render()
      },
      onNotifAcceptanceClick: (friendshipId) => {
        void handleAcceptanceNotificationClick(friendshipId)
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
      onRulesOpen: () => {
        showRulesPage()
      },
      onStrategyOpen: () => {
        showStrategyPage()
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
      onPrivateRoomCreate: (stake, isLocked, waitMinutes) => {
        state.privateRoomsCreatePopupOpen = false
        options.onPrivateRoomCreate?.(stake, isLocked, waitMinutes)
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
        leaveAdminServerIfActive()
        // Чат с поддръжката (admin inbox) — само пълен admin; subadmin вижда обичайния свой чат.
        if (isFullAdminAuthSession(authSession)) {
          state.currentScreen = 'support'
          state.adminSupportSelectedProfileId = null
          state.adminSupportConversations = []
          state.adminSupportConversationsLoading = true
          state.adminSupportMobileConversationOpen = false
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
      onGuestContactClick: () => {
        state.guestContactPopupOpen = true
        state.guestContactErrorText = null
        state.guestContactSuccessText = null
        render()
      },
      onGuestContactClose: () => {
        state.guestContactPopupOpen = false
        state.guestContactSending = false
        state.guestContactErrorText = null
        state.guestContactSuccessText = null
        render()
      },
      onGuestContactSubmit: (input) => {
        if (state.guestContactSending) return
        state.guestContactSending = true
        state.guestContactErrorText = null
        state.guestContactSuccessText = null
        render()
        void (async () => {
          const result = await options.onGuestContactSend?.(input)
          state.guestContactSending = false

          if (result?.ok) {
            state.guestContactSuccessText = result.message || 'Благодарим! Съобщението беше изпратено.'
            state.guestContactErrorText = null
          } else {
            state.guestContactErrorText = result?.message ?? 'Съобщението не беше изпратено. Моля, опитайте по-късно.'
          }

          render()
        })()
      },
      onAdminSupportConversationClick: (profileId) => {
        state.adminSupportSelectedProfileId = profileId
        state.adminSupportMessages = []
        state.adminSupportMessagesLoading = true
        state.adminSupportMobileConversationOpen = true
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
      onAdminSupportMobileBack: () => {
        state.adminSupportMobileConversationOpen = false
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
      onAdminHistoryWindowChange: (window) => {
        state.adminHistoryWindow = window
        state.adminHistoryResult = null
        state.adminHistoryLoading = true
        state.adminHistoryErrorText = null
        render()
        options.onAdminHistoryWindowChange?.(window)
      },
      onAdminVisitorsPeriodClick: (period) => {
        if (period === 'today' || period === 'yesterday' || period === '7d' || period === '30d') {
          state.adminVisitorsPeriod = period
          syncAdminVisitorsUrl()
          if (state.adminVisitorsView === 'sources') {
            state.adminVisitorsSourcesRows = []
            state.adminVisitorsSourcesLoading = true
            render()
            void fetchAdminVisitorSources()
          } else {
            state.adminVisitorsOffset = 0
            state.adminVisitorsRows = []
            state.adminVisitorsLoading = true
            render()
            void fetchAdminVisitors()
          }
        }
        options.onAdminVisitorsPeriodClick?.(period)
      },
      onAdminVisitorsBackClick: () => {
        options.onAdminVisitorsBackClick?.()
      },
      onAdminVisitorsTypeChange: (type) => {
        state.adminVisitorsType = type
        state.adminVisitorsOffset = 0
        syncAdminVisitorsUrl()
        if (state.adminVisitorsView === 'sources') {
          state.adminVisitorsSourcesRows = []
          state.adminVisitorsSourcesLoading = true
          render()
          void fetchAdminVisitorSources()
        } else {
          state.adminVisitorsRows = []
          state.adminVisitorsLoading = true
          render()
          void fetchAdminVisitors()
        }
        options.onAdminVisitorsTypeChange?.(type)
      },
      onAdminVisitorsDeviceChange: (device) => {
        state.adminVisitorsDevice = device
        state.adminVisitorsOffset = 0
        syncAdminVisitorsUrl()
        if (state.adminVisitorsView === 'sources') {
          state.adminVisitorsSourcesRows = []
          state.adminVisitorsSourcesLoading = true
          render()
          void fetchAdminVisitorSources()
        } else {
          state.adminVisitorsRows = []
          state.adminVisitorsLoading = true
          render()
          void fetchAdminVisitors()
        }
      },
      onAdminVisitorsOsChange: (os) => {
        state.adminVisitorsOs = os
        state.adminVisitorsOffset = 0
        syncAdminVisitorsUrl()
        if (state.adminVisitorsView === 'sources') {
          state.adminVisitorsSourcesRows = []
          state.adminVisitorsSourcesLoading = true
          render()
          void fetchAdminVisitorSources()
        } else {
          state.adminVisitorsRows = []
          state.adminVisitorsLoading = true
          render()
          void fetchAdminVisitors()
        }
      },
      onAdminVisitorsPageChange: (offset) => {
        state.adminVisitorsOffset = offset
        state.adminVisitorsRows = []
        state.adminVisitorsLoading = true
        render()
        void fetchAdminVisitors()
      },
      onAdminVisitorsViewChange: (view) => {
        state.adminVisitorsView = view
        syncAdminVisitorsUrl()
        if (view === 'sources') {
          state.adminVisitorsSourcesRows = []
          state.adminVisitorsSourcesLoading = true
          render()
          void fetchAdminVisitorSources()
        } else {
          render()
        }
      },
      onAdminPaymentsOpen: (period) => {
        showAdminPaymentsPanel(period)
      },
      onAdminPaymentsPeriodChange: (period) => {
        state.adminPaymentsPeriod = period
        state.adminPaymentsOffset = 0
        state.adminPaymentsRows = []
        state.adminPaymentsLoading = true
        syncAdminPaymentsUrl()
        render()
        void fetchAdminPayments()
      },
      onAdminPaymentsPageChange: (offset) => {
        state.adminPaymentsOffset = offset
        state.adminPaymentsRows = []
        state.adminPaymentsLoading = true
        render()
        void fetchAdminPayments()
      },
      onAdminPaymentsBackClick: () => {
        void showAdminInfoPanel()
      },
      onAdminPaymentsDetailOpen: (purchaseId) => {
        showAdminPaymentDetailPanel(purchaseId)
      },
      onAdminPaymentDetailBack: () => {
        // Return to payments list preserving the period without adding another history entry.
        const period = state.adminPaymentDetailFromPeriod ?? state.adminPaymentsPeriod
        showAdminPaymentsPanel(period, 'replace')
      },
      onAdminTournamentsOpen: () => {
        showAdminTournamentsPanel()
      },
      onAdminTournamentsBack: () => {
        void showAdminInfoPanel()
      },
      onAdminTournamentsFilter: (filters) => {
        state.adminTournamentsFilters = { ...state.adminTournamentsFilters, ...filters, page: filters.page ?? 1 }
        state.adminTournamentsRows = []
        state.adminTournamentsLoading = true
        syncAdminTournamentsUrl()
        render()
        void fetchAdminTournaments()
      },
      onAdminTournamentsPage: (page) => {
        state.adminTournamentsFilters = { ...state.adminTournamentsFilters, page }
        state.adminTournamentsRows = []
        state.adminTournamentsLoading = true
        syncAdminTournamentsUrl()
        render()
        void fetchAdminTournaments()
      },
      onAdminTournamentOpen: (tournamentId) => {
        if (tournamentId) showAdminTournamentDetailPanel(tournamentId)
      },
      onAdminTournamentReconcile: () => {
        void submitAdminTournamentReconcile()
      },
      onAdminTournamentCancelOpen: () => {
        state.adminTournamentCancelConfirmOpen = true
        render()
      },
      onAdminTournamentCancelConfirm: () => {
        void submitAdminTournamentCancelOpen()
      },
      onAdminTournamentCancelDismiss: () => {
        if (!state.adminTournamentCancelConfirmOpen) return
        state.adminTournamentCancelConfirmOpen = false
        render()
      },
    })

    if (
      state.currentScreen === 'tournament-detail' &&
      state.tournamentDetail !== null &&
      state.tournamentDetail.status === 'open' &&
      state.tournamentDetail.startMode === 'scheduled' &&
      state.tournamentDetail.scheduledStartAt !== null
    ) {
      startTournamentStartCountdownLoop(state.tournamentDetail.tournamentId, 'scheduled', state.tournamentDetail.scheduledStartAt)
    } else if (
      state.currentScreen === 'tournament-detail' &&
      state.tournamentDetail !== null &&
      state.tournamentDetail.status === 'open' &&
      state.tournamentDetail.startMode === 'fill' &&
      state.tournamentDetail.fillExpiresAt !== null
    ) {
      startTournamentStartCountdownLoop(state.tournamentDetail.tournamentId, 'fill', state.tournamentDetail.fillExpiresAt)
    } else {
      clearTournamentStartCountdownLoop()
    }

    if (state.currentScreen === 'tournaments') {
      startTournamentListFillExpiryLoop()
    } else {
      clearTournamentListFillExpiryLoop()
    }
  }

  async function submitPresetAvatar(avatarUrl: string): Promise<void> {
    const targetProfileId = state.profileEditorTargetProfileId
    const errorText = options.onPresetAvatarApply
      ? await options.onPresetAvatarApply(targetProfileId, avatarUrl)
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

    await refreshEditedTargetProfile(targetProfileId)
    state.profileEditorErrorText = null
    render()
  }

  async function submitProfileEdit(
    avatarFile: File | null,
    avatarCrop: AvatarCropSelection | null,
    galleryFiles: File[],
  ): Promise<void> {
    if (state.profileEditorSubmitting) return
    state.profileEditorSubmitting = true
    state.profileEditorErrorText = null
    render()

    const targetProfileId = state.profileEditorTargetProfileId
    const errorText = await (async () => {
      try {
        return options.onProfileEditSubmit
          ? await options.onProfileEditSubmit(targetProfileId, avatarFile, avatarCrop, galleryFiles)
          : 'Редакцията временно не е налична.'
      } catch {
        return 'Няма връзка със сървъра за профили.'
      }
    })()

    if (errorText !== null) {
      state.profileEditorErrorText = errorText
      state.profileEditorSubmitting = false
      render()
      return
    }

    const authSession = options.getAuthSession?.() ?? null
    if (authSession !== null) {
      state.displayName = authSession.profile.displayName
      state.localAvatarUrl = authSession.profile.avatarUrl
    }

    await refreshEditedTargetProfile(targetProfileId)
    state.profileEditorOpen = false
    state.profileEditorErrorText = null
    state.profileEditorSubmitting = false
    state.profilePopupOpen = true
    clearProfileEditorPendingState()
    render()
  }

  async function submitProfileNameChange(displayName: string): Promise<void> {
    const targetProfileId = state.profileEditorTargetProfileId
    const errorText = options.onProfileNameChangeSubmit
      ? await options.onProfileNameChangeSubmit(targetProfileId, displayName)
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

    await refreshEditedTargetProfile(targetProfileId, displayName)
    state.profileNameChangeErrorText = null
    state.profileNameChangeSuccessAmount = targetProfileId === null
      ? state.adminSettings?.profileNameChangePrice ??
        options.getProfileNameChangePrice?.() ??
        50000
      : null
    if (targetProfileId === null) {
      void new Audio('/audio/game-sounds/coins.mp3').play().catch(() => undefined)
    }
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
    const targetProfileId = state.profileEditorTargetProfileId
    const errorText = options.onProfileGalleryDelete
      ? await options.onProfileGalleryDelete(targetProfileId, imageId)
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

  function applySuccessfulPlayersPage(result: {
    players: PlayerPublicProfileSnapshot[]
    page: number
    totalCount: number
    totalPages: number
    snapshot: string
  }): void {
    state.players = result.players
    state.playersPage = result.page
    state.playersSnapshotToken = result.snapshot
    state.playersTotalCount = result.totalCount
    state.playersTotalPages = result.totalPages
  }

  async function showPlayersDirectory(): Promise<void> {
    leaveAdminServerIfActive()
    state.currentScreen = 'players'
    state.isSearching = false
    state.errorText = null
    state.profilePopupOpen = false
    state.profilePopupProfile = null
    state.profilePopupCanEdit = true
    playersSearchRunner.cancel()
    state.playersSearchQuery = ''
    state.playersSearchDraft = ''
    state.playersSearchResults = null
    state.playersSearchLoading = false
    // Прясно зареждане → нов snapshot (нов случаен ред), не пренасяме стар token.
    state.playersPage = 1
    state.playersSnapshotToken = null
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

    const result = await options.onPlayersLoad(1, null)

    if (state.currentScreen !== 'players') {
      return
    }

    state.playersLoading = false

    if (!result.ok) {
      state.playersErrorText = result.message
      render()
      return
    }

    applySuccessfulPlayersPage(result)
    state.playersErrorText = null
    render()
  }

  async function showTournamentsList(): Promise<void> {
    leaveAdminServerIfActive()
    state.currentScreen = 'tournaments'
    state.tournamentCreatePopupOpen = false
    state.tournamentCreateErrorText = null
    stopWaitingRoomActivity()
    resetFinalFillSequence()

    if (!options.onTournamentsLoad) {
      state.tournamentsErrorText = 'Списъкът с турнири временно не е наличен.'
      render()
      return
    }

    state.tournamentsLoading = true
    state.tournamentsErrorText = null
    render()

    const mine = state.tournamentsFilter === 'mine'
    const result = await options.onTournamentsLoad({ mine, page: 1 })

    if (state.currentScreen !== 'tournaments') {
      return
    }

    state.tournamentsLoading = false

    if (!result.ok) {
      state.tournamentsErrorText = result.message
      render()
      return
    }

    state.tournaments = result.tournaments
    state.tournamentsErrorText = null
    void refetchPendingTournamentPartnerInvites()
    render()
  }

  async function refetchPendingTournamentPartnerInvites(): Promise<void> {
    if (!options.onPendingTournamentPartnerInvitesLoad) return
    const result = await options.onPendingTournamentPartnerInvitesLoad()
    if (result.ok) {
      state.tournamentPartnerInvites = result.invites
      if (state.currentScreen === 'tournaments') render()
    }
  }

  async function refetchTournamentsList(): Promise<void> {
    if (!options.onTournamentsLoad || state.currentScreen !== 'tournaments') return
    state.tournamentsLoading = true
    render()
    const mine = state.tournamentsFilter === 'mine'
    const result = await options.onTournamentsLoad({ mine, page: 1 })
    if (state.currentScreen !== 'tournaments') return
    state.tournamentsLoading = false
    if (!result.ok) {
      state.tournamentsErrorText = result.message
      render()
      return
    }
    state.tournaments = result.tournaments
    state.tournamentsErrorText = null
    void refetchPendingTournamentPartnerInvites()
    render()
  }

  function setTournamentsFilter(filter: 'all' | 'mine'): void {
    if (state.tournamentsFilter === filter) return
    state.tournamentsFilter = filter
    void refetchTournamentsList()
  }

  function openTournamentCreatePopup(): void {
    state.tournamentCreatePopupOpen = true
    state.tournamentCreateErrorText = null
    render()
  }

  function closeTournamentCreatePopup(): void {
    if (state.tournamentCreateBusy) return
    state.tournamentCreatePopupOpen = false
    state.tournamentCreateErrorText = null
    render()
  }

  async function submitTournamentCreate(input: TournamentCreateInput): Promise<void> {
    if (!options.onTournamentCreate || state.tournamentCreateBusy) return

    state.tournamentCreateBusy = true
    state.tournamentCreateErrorText = null
    render()

    const result = await options.onTournamentCreate(input)

    state.tournamentCreateBusy = false

    if (!result.ok) {
      state.tournamentCreateErrorText = result.message
      render()
      return
    }

    state.tournamentCreatePopupOpen = false
    state.tournamentCreateErrorText = null
    showTournamentDetailFromCreatedTournament(result.tournament.tournamentId)
  }

  function showTournamentDetailFromCreatedTournament(tournamentId: string): void {
    state.currentScreen = 'tournament-detail'
    state.tournamentDetailId = tournamentId
    state.tournamentDetailLoading = false
    state.tournamentDetailErrorText = null
    state.tournamentDetailRequiresPassword = false
    state.tournamentDetailPasswordDraft = ''
    state.tournamentDetailVerifiedPassword = null
    state.tournamentDetailUnlockErrorText = null
    void refetchTournamentsList()
    const targetUrl = `/tournaments/${encodeURIComponent(tournamentId)}`
    if (window.location.pathname !== targetUrl) {
      history.pushState(null, '', targetUrl)
    }
    render()
    void fetchTournamentDetail(tournamentId)
  }

  function showTournamentDetail(tournamentId: string): void {
    leaveAdminServerIfActive()
    stopWaitingRoomActivity()
    resetFinalFillSequence()
    state.currentScreen = 'tournament-detail'
    state.tournamentDetailId = tournamentId
    state.tournamentDetail = null
    state.tournamentDetailLoading = true
    state.tournamentDetailErrorText = null
    state.tournamentDetailRequiresPassword = false
    state.tournamentDetailPasswordDraft = ''
    state.tournamentDetailVerifiedPassword = null
    state.tournamentDetailUnlockErrorText = null
    const targetUrl = `/tournaments/${encodeURIComponent(tournamentId)}`
    if (window.location.pathname !== targetUrl) {
      history.pushState(null, '', targetUrl)
    }
    render()
    void fetchTournamentDetail(tournamentId)
  }

  async function fetchTournamentDetail(tournamentId: string): Promise<void> {
    if (!options.onTournamentDetailLoad) {
      state.tournamentDetailLoading = false
      state.tournamentDetailErrorText = 'Турнирът временно не е наличен.'
      render()
      return
    }

    const result = await options.onTournamentDetailLoad(tournamentId)

    if (state.currentScreen !== 'tournament-detail' || state.tournamentDetailId !== tournamentId) {
      return
    }

    state.tournamentDetailLoading = false

    if (!result.ok) {
      if (result.requiresPassword) {
        state.tournamentDetailRequiresPassword = true
        state.tournamentDetailErrorText = null
      } else {
        state.tournamentDetailErrorText = result.message
      }
      render()
      return
    }

    state.tournamentDetail = result.tournament
    state.tournamentDetailRequiresPassword = false
    state.tournamentDetailErrorText = null
    render()
  }

  function setTournamentDetailPasswordDraft(value: string): void {
    state.tournamentDetailPasswordDraft = value
  }

  async function submitTournamentUnlock(): Promise<void> {
    if (!options.onTournamentUnlock || state.tournamentDetailId === null || state.tournamentDetailUnlockBusy) {
      return
    }
    const tournamentId = state.tournamentDetailId

    state.tournamentDetailUnlockBusy = true
    state.tournamentDetailUnlockErrorText = null
    render()

    const passwordAttempt = state.tournamentDetailPasswordDraft
    const result = await options.onTournamentUnlock(tournamentId, passwordAttempt)

    if (state.currentScreen !== 'tournament-detail' || state.tournamentDetailId !== tournamentId) {
      return
    }

    state.tournamentDetailUnlockBusy = false

    if (!result.ok) {
      state.tournamentDetailUnlockErrorText = result.message
      render()
      return
    }

    state.tournamentDetail = result.tournament
    state.tournamentDetailRequiresPassword = false
    state.tournamentDetailUnlockErrorText = null
    state.tournamentDetailPasswordDraft = ''
    // Паролата вече е потвърдена от сървъра за тази заявка — пазим я само в
    // паметта на тази сесия, за да не караме потребителя да я въвежда втори
    // път при директния "Запиши се сам" / първата покана "Участвай с
    // партньор" веднага след отключването (виж joinTournamentSoloAtomically /
    // createPartnerInviteAtomically, които я проверяват отново на сървъра).
    state.tournamentDetailVerifiedPassword = passwordAttempt
    render()
  }

  // Join/leave/cancel връщат TournamentSummarySnapshot (не Detail) — мержваме
  // върху текущия state.tournamentDetail, за да запазим cancelReason/
  // startedAt/finishedAt (detail-only полета, непроменени от тия действия).
  function mergeTournamentSummaryIntoDetail(summary: TournamentSummarySnapshot): void {
    if (state.tournamentDetail === null) return
    state.tournamentDetail = { ...state.tournamentDetail, ...summary }
  }

  function openTournamentJoinConfirm(): void {
    state.tournamentJoinConfirmOpen = true
    state.tournamentJoinErrorText = null
    render()
  }

  function closeTournamentJoinConfirm(): void {
    if (state.tournamentJoinBusy) return
    state.tournamentJoinConfirmOpen = false
    state.tournamentJoinErrorText = null
    render()
  }

  async function submitTournamentJoin(): Promise<void> {
    if (!options.onTournamentJoin || state.tournamentDetailId === null || state.tournamentJoinBusy) {
      return
    }
    const tournamentId = state.tournamentDetailId

    state.tournamentJoinBusy = true
    state.tournamentJoinErrorText = null
    render()

    const result = await options.onTournamentJoin(tournamentId, state.tournamentDetailVerifiedPassword)

    // Известието е server-authoritative и независимо от текущия екран —
    // отговорът вече потвърждава реален нов debit (alreadyJoined: false),
    // затова се показва дори ако потребителят е напуснал detail екрана
    // междувременно (виж по-долу screen-guard-а, който пази само local state).
    if (result.ok && !result.alreadyJoined && typeof result.debitedAmount === 'number') {
      options.onTournamentEconomyNotice?.({ reason: 'entry_fee_paid', amount: result.debitedAmount })
    }

    if (state.currentScreen !== 'tournament-detail' || state.tournamentDetailId !== tournamentId) {
      return
    }

    state.tournamentJoinBusy = false

    if (!result.ok) {
      state.tournamentJoinErrorText = result.message
      render()
      return
    }

    state.tournamentJoinConfirmOpen = false
    state.tournamentJoinErrorText = null
    mergeTournamentSummaryIntoDetail(result.tournament)
    void refetchTournamentsList()
    render()
  }

  async function openTournamentPartnerPicker(): Promise<void> {
    if (!options.onTournamentPartnerCandidatesLoad || state.tournamentDetailId === null) return
    const tournamentId = state.tournamentDetailId
    state.tournamentPartnerPickerOpen = true
    state.tournamentPartnerPickerLoading = true
    state.tournamentPartnerPickerErrorText = null
    state.tournamentPartnerInviteErrorText = null
    state.tournamentPartnerInviteQuery = ''
    render()
    const result = await options.onTournamentPartnerCandidatesLoad(tournamentId)
    if (state.currentScreen !== 'tournament-detail' || state.tournamentDetailId !== tournamentId) return
    state.tournamentPartnerPickerLoading = false
    if (!result.ok) {
      state.tournamentPartnerPickerErrorText = result.message
      render()
      return
    }
    state.tournamentPartnerCandidates = result.candidates
    render()
  }

  function closeTournamentPartnerPicker(): void {
    if (state.tournamentPartnerInviteBusy) return
    state.tournamentPartnerPickerOpen = false
    state.tournamentPartnerPickerErrorText = null
    state.tournamentPartnerInviteErrorText = null
    render()
  }

  async function submitTournamentPartnerInvite(profileId: string): Promise<void> {
    if (!options.onTournamentPartnerInviteCreate || state.tournamentDetailId === null || state.tournamentPartnerInviteBusy) {
      return
    }
    const tournamentId = state.tournamentDetailId
    state.tournamentPartnerInviteBusy = true
    state.tournamentPartnerInviteErrorText = null
    render()
    const result = await options.onTournamentPartnerInviteCreate(tournamentId, profileId, state.tournamentDetailVerifiedPassword)
    if (result.ok && typeof result.debitedAmount === 'number') {
      options.onTournamentEconomyNotice?.({ reason: 'entry_fee_paid', amount: result.debitedAmount })
    }
    if (state.currentScreen !== 'tournament-detail' || state.tournamentDetailId !== tournamentId) return
    state.tournamentPartnerInviteBusy = false
    if (!result.ok) {
      state.tournamentPartnerInviteErrorText = result.message
      render()
      return
    }
    state.tournamentPartnerPickerOpen = false
    state.tournamentPartnerInviteErrorText = null
    mergeTournamentSummaryIntoDetail(result.tournament)
    void fetchTournamentDetail(tournamentId)
    void refetchTournamentsList()
    render()
  }

  async function respondTournamentPartnerInvite(
    tournamentId: string,
    inviteId: string,
    action: 'accept' | 'decline' | 'cancel',
  ): Promise<void> {
    if (!options.onTournamentPartnerInviteRespond || state.tournamentPartnerInviteBusy) return
    state.tournamentPartnerInviteBusy = true
    state.tournamentPartnerInviteErrorText = null
    render()
    const result = await options.onTournamentPartnerInviteRespond(tournamentId, inviteId, action)
    state.tournamentPartnerInviteBusy = false
    if (!result.ok) {
      state.tournamentPartnerInviteErrorText = result.message
      render()
      return
    }
    if (action === 'accept' && !result.alreadyResolved && typeof result.debitedAmount === 'number') {
      options.onTournamentEconomyNotice?.({ reason: 'entry_fee_paid', amount: result.debitedAmount })
    }
    if (state.currentScreen === 'tournament-detail' && state.tournamentDetailId === tournamentId) {
      mergeTournamentSummaryIntoDetail(result.tournament)
      void fetchTournamentDetail(tournamentId)
    }
    void refetchTournamentsList()
    void refetchPendingTournamentPartnerInvites()
    render()
  }

  function openTournamentLeaveConfirm(): void {
    state.tournamentLeaveConfirmOpen = true
    state.tournamentLeaveErrorText = null
    render()
  }

  function closeTournamentLeaveConfirm(): void {
    if (state.tournamentLeaveBusy) return
    state.tournamentLeaveConfirmOpen = false
    state.tournamentLeaveErrorText = null
    render()
  }

  async function submitTournamentLeave(): Promise<void> {
    if (!options.onTournamentLeave || state.tournamentDetailId === null || state.tournamentLeaveBusy) {
      return
    }
    const tournamentId = state.tournamentDetailId

    state.tournamentLeaveBusy = true
    state.tournamentLeaveErrorText = null
    render()

    const result = await options.onTournamentLeave(tournamentId)

    if (result.ok && !result.alreadyRefunded) {
      options.onTournamentEconomyNotice?.({ reason: 'participant_withdrawal', amount: result.refundedAmount })
    }

    if (state.currentScreen !== 'tournament-detail' || state.tournamentDetailId !== tournamentId) {
      return
    }

    state.tournamentLeaveBusy = false

    if (!result.ok) {
      state.tournamentLeaveErrorText = result.message
      render()
      return
    }

    state.tournamentLeaveConfirmOpen = false
    state.tournamentLeaveErrorText = null
    mergeTournamentSummaryIntoDetail(result.tournament)
    void refetchTournamentsList()
    render()
  }

  function openTournamentCancelConfirm(): void {
    state.tournamentCancelConfirmOpen = true
    state.tournamentCancelErrorText = null
    render()
  }

  function closeTournamentCancelConfirm(): void {
    if (state.tournamentCancelBusy) return
    state.tournamentCancelConfirmOpen = false
    state.tournamentCancelErrorText = null
    render()
  }

  async function submitTournamentCancel(): Promise<void> {
    if (!options.onTournamentCancel || state.tournamentDetailId === null || state.tournamentCancelBusy) {
      return
    }
    const tournamentId = state.tournamentDetailId

    state.tournamentCancelBusy = true
    state.tournamentCancelErrorText = null
    render()

    const result = await options.onTournamentCancel(tournamentId)

    if (state.currentScreen !== 'tournament-detail' || state.tournamentDetailId !== tournamentId) {
      return
    }

    state.tournamentCancelBusy = false

    if (!result.ok) {
      state.tournamentCancelErrorText = result.message
      render()
      return
    }

    state.tournamentCancelConfirmOpen = false
    state.tournamentCancelErrorText = null
    mergeTournamentSummaryIntoDetail(result.tournament)
    void refetchTournamentsList()
    render()
  }

  async function goToPlayersPage(targetPage: number): Promise<void> {
    if (!options.onPlayersLoad || state.playersLoading) return

    const clamped = Math.min(Math.max(1, Math.trunc(targetPage)), Math.max(1, state.playersTotalPages))
    if (clamped === state.playersPage) return

    state.playersLoading = true
    state.playersErrorText = null
    render()

    const result = await options.onPlayersLoad(clamped, state.playersSnapshotToken)

    if (state.currentScreen !== 'players') {
      return
    }

    state.playersLoading = false

    if (!result.ok) {
      state.playersErrorText = result.message
      render()
      return
    }

    applySuccessfulPlayersPage(result)
    state.playersErrorText = null
    render()
  }

  async function showLeaderboardsDirectory(): Promise<void> {
    leaveAdminServerIfActive()
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
    leaveAdminServerIfActive()
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

  function openShopPurchaseConfirm(packageId: string): void {
    const authSession = options.getAuthSession?.() ?? null

    if (authSession === null) {
      state.authModalMode = 'cta'
      state.authErrorText = null
      render()
      return
    }

    if (state.shopPurchaseActionPackageId !== null) {
      return
    }

    const coinPackage =
      state.shopPackages.find((item) => item.packageId === packageId) ??
      state.lobbyPackages.find((item) => item.packageId === packageId)
    if (!coinPackage) {
      state.shopPurchaseMessageText = 'Избраният пакет не е наличен.'
      render()
      return
    }

    state.shopPurchaseConfirmPackageId = packageId
    state.shopPurchaseMessageText = null
    render()
  }

  async function startShopPurchase(packageId: string): Promise<void> {
    const authSession = options.getAuthSession?.() ?? null

    if (state.shopPurchaseActionPackageId !== null) {
      return
    }

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
    state.shopPurchaseConfirmPackageId = null

    if (!result.ok) {
      state.shopPurchaseMessageText = result.message
      render()
      return
    }

    state.shopPurchases = result.purchases
    state.shopPurchaseMessageText = result.message
    render()
  }

  async function openShopResumeConfirm(purchaseId: string): Promise<void> {
    const result = computeShopResumeConfirmOpen(purchaseId, {
      purchases: state.shopPurchases,
      shopPackages: state.shopPackages,
      lobbyPackages: state.lobbyPackages,
    })

    if (!result.ok) {
      if (result.reason === 'no-package-id' || result.reason === 'package-unavailable') {
        state.shopPurchaseMessageText =
          result.reason === 'package-unavailable' ? 'Пакетът не е наличен.' : 'Не може да се продължи тази покупка.'
        render()
      }
      return
    }

    state.shopPurchaseResumeId = result.resumeId
    state.shopPurchaseConfirmPackageId = result.packageId
    state.shopPurchaseMessageText = null
    render()
  }

  async function resumeShopPurchase(purchaseId: string): Promise<void> {
    if (state.shopPurchaseActionPurchaseId !== null) return

    if (!options.onShopPurchaseResume) {
      state.shopPurchaseMessageText = 'Продължаването на покупки временно не е налично.'
      state.shopPurchaseResumeId = null
      state.shopPurchaseConfirmPackageId = null
      render()
      return
    }

    state.shopPurchaseActionPurchaseId = purchaseId
    state.shopPurchaseMessageText = null
    render()

    const result = await options.onShopPurchaseResume(purchaseId)

    state.shopPurchaseActionPurchaseId = null
    state.shopPurchaseResumeId = null
    state.shopPurchaseConfirmPackageId = null

    if (!result.ok) {
      state.shopPurchaseMessageText = result.message
      render()
      return
    }

    // Пренасочване към Stripe — render не е нужен
    window.location.assign(result.checkoutUrl)
  }

  async function hideShopPurchase(purchaseId: string): Promise<void> {
    if (state.shopPurchaseActionPurchaseId !== null) return

    if (!options.onShopPurchaseHide) {
      state.shopPurchaseMessageText = 'Скриването на покупки временно не е налично.'
      render()
      return
    }

    state.shopPurchaseActionPurchaseId = purchaseId
    state.shopPurchaseMessageText = null
    render()

    const result = await options.onShopPurchaseHide(purchaseId)

    state.shopPurchaseActionPurchaseId = null

    if (!result.ok) {
      state.shopPurchaseMessageText = result.message
      render()
      return
    }

    state.shopPurchases = result.purchases
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

  async function showAdminGuestContactMessages(): Promise<void> {
    const authSession = options.getAuthSession?.() ?? null

    // Съобщения от гости — третираме като "поддръжка", само пълен admin.
    if (!isFullAdminAuthSession(authSession)) {
      state.currentScreen = 'lobby'
      state.errorText = 'Нямаш достъп до admin панела.'
      render()
      return
    }

    state.currentScreen = 'guest-contact-messages'
    state.adminGuestContactMessages = []
    state.adminGuestContactMessagesLoading = true
    state.adminGuestContactMessagesErrorText = null
    render()

    const result = await options.onAdminGuestContactMessagesLoad?.()

    if (state.currentScreen !== 'guest-contact-messages') return

    state.adminGuestContactMessagesLoading = false
    if (result?.ok) {
      state.adminGuestContactMessages = result.messages
    } else {
      state.adminGuestContactMessagesErrorText = result?.message ?? 'Съобщенията от гости временно не са налични.'
    }
    render()
  }

  async function markAdminGuestContactMessageRead(messageId: string): Promise<void> {
    const message = state.adminGuestContactMessages.find((item) => item.messageId === messageId)
    if (!message || message.readByAdmin) return

    const result = await options.onAdminGuestContactMessageRead?.(messageId)
    if (!result?.ok) {
      state.adminGuestContactMessagesErrorText = result?.message ?? 'Съобщението не беше маркирано като прочетено.'
      render()
      return
    }

    message.readByAdmin = true
    state.adminGuestContactUnreadCount = Math.max(0, state.adminGuestContactUnreadCount - 1)
    state.adminGuestContactMessagesErrorText = null
    render()
  }

  async function showAdminInfoPanel(): Promise<void> {
    leaveAdminServerIfActive()
    const authSession = options.getAuthSession?.() ?? null

    // "Информация" — read-only, достъпно за admin И subadmin.
    if (!isAdminOrSubadminAuthSession(authSession)) {
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
    options.onAdminInfoFamilyScreenEnter?.()

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
      if (result.forbidden) {
        forceLeaveAdminScreenForbidden(result.message)
        return
      }
      state.adminStatsErrorText = result.message
      render()
      return
    }

    state.adminStats = result.stats
    render()
  }

  function showAdminVisitorsPanel(overridePeriod?: string, overrideView?: string, overrideDevice?: string, overrideType?: string, overrideOs?: string): void {
    const authSession = options.getAuthSession?.() ?? null

    // "Информация" (посетители) — read-only, достъпно за admin И subadmin.
    if (!isAdminOrSubadminAuthSession(authSession)) {
      state.currentScreen = 'lobby'
      state.errorText = 'Нямаш достъп до admin панела.'
      render()
      return
    }

    leaveAdminServerIfActive()
    state.currentScreen = 'admin-visitors'
    state.isSearching = false
    state.errorText = null
    state.profilePopupOpen = false
    state.profilePopupProfile = null
    stopWaitingRoomActivity()
    resetFinalFillSequence()
    options.onAdminInfoFamilyScreenEnter?.()

    if (overridePeriod && (overridePeriod === 'today' || overridePeriod === 'yesterday' || overridePeriod === '7d' || overridePeriod === '30d')) {
      state.adminVisitorsPeriod = overridePeriod
    }
    state.adminVisitorsView = (overrideView === 'sources') ? 'sources' : 'visitors'
    if (overrideType && (overrideType === 'all' || overrideType === 'guest' || overrideType === 'registered')) {
      state.adminVisitorsType = overrideType as import('../network/createGameServerClient.js').VisitorListType
    }
    if (overrideDevice && (overrideDevice === 'all' || overrideDevice === 'mobile' || overrideDevice === 'desktop' || overrideDevice === 'tablet' || overrideDevice === 'unknown')) {
      state.adminVisitorsDevice = overrideDevice as import('../network/createGameServerClient.js').VisitorDeviceFilter
    }
    if (overrideOs && (overrideOs === 'all' || overrideOs === 'android' || overrideOs === 'ios' || overrideOs === 'windows' || overrideOs === 'macos' || overrideOs === 'linux' || overrideOs === 'chromeos' || overrideOs === 'unknown')) {
      state.adminVisitorsOs = overrideOs as import('../network/createGameServerClient.js').VisitorOsFilter
    }
    state.adminVisitorsOffset = 0
    state.adminVisitorsRows = []
    state.adminVisitorsTotal = 0
    state.adminVisitorsErrorText = null
    state.adminVisitorsSourcesRows = []
    state.adminVisitorsSourcesTotal = 0
    state.adminVisitorsSourcesErrorText = null

    if (state.adminVisitorsView === 'sources') {
      state.adminVisitorsSourcesLoading = true
      state.adminVisitorsLoading = false
      render()
      void fetchAdminVisitorSources()
    } else {
      state.adminVisitorsLoading = true
      state.adminVisitorsSourcesLoading = false
      render()
      void fetchAdminVisitors()
    }
  }

  async function fetchAdminVisitors(): Promise<void> {
    if (!options.onAdminVisitorsLoad) {
      state.adminVisitorsLoading = false
      state.adminVisitorsErrorText = 'Зареждането не е конфигурирано.'
      render()
      return
    }
    const result = await options.onAdminVisitorsLoad({
      period: state.adminVisitorsPeriod,
      type: state.adminVisitorsType,
      device: state.adminVisitorsDevice,
      os: state.adminVisitorsOs,
      limit: state.adminVisitorsLimit,
      offset: state.adminVisitorsOffset,
    })
    // Потребителят вече е напуснал "Информация/Посетители" — stale response, игнорирай.
    if (state.currentScreen !== 'admin-visitors') return
    state.adminVisitorsLoading = false
    if (!result.ok) {
      if (result.forbidden) {
        forceLeaveAdminScreenForbidden(result.message)
        return
      }
      state.adminVisitorsErrorText = result.message
    } else {
      state.adminVisitorsRows = result.rows
      state.adminVisitorsTotal = result.total
      state.adminVisitorsErrorText = null
    }
    render()
  }

  async function fetchAdminVisitorSources(): Promise<void> {
    if (!options.onAdminVisitorSourcesLoad) {
      state.adminVisitorsSourcesLoading = false
      state.adminVisitorsSourcesErrorText = 'Зареждането не е конфигурирано.'
      render()
      return
    }
    const result = await options.onAdminVisitorSourcesLoad({ period: state.adminVisitorsPeriod, type: state.adminVisitorsType, device: state.adminVisitorsDevice, os: state.adminVisitorsOs })
    // Потребителят вече е напуснал "Информация/Посетители" — stale response, игнорирай.
    if (state.currentScreen !== 'admin-visitors') return
    state.adminVisitorsSourcesLoading = false
    if (!result.ok) {
      if (result.forbidden) {
        forceLeaveAdminScreenForbidden(result.message)
        return
      }
      state.adminVisitorsSourcesErrorText = result.message
    } else {
      state.adminVisitorsSourcesRows = result.rows
      state.adminVisitorsSourcesTotal = result.total
      state.adminVisitorsSourcesErrorText = null
    }
    render()
  }

  // Incremented on every new fetch; checked after await to discard stale responses.
  let _adminPaymentsGen = 0

  function showAdminPaymentsPanel(overridePeriod?: string, historyMode: 'push' | 'replace' = 'push'): void {
    const authSession = options.getAuthSession?.() ?? null
    // "Информация" (плащания) — read-only, достъпно за admin И subadmin.
    if (!isAdminOrSubadminAuthSession(authSession)) {
      state.currentScreen = 'lobby'
      state.errorText = 'Нямаш достъп до admin панела.'
      render()
      return
    }
    leaveAdminServerIfActive()
    state.currentScreen = 'admin-payments'
    state.isSearching = false
    state.errorText = null
    state.profilePopupOpen = false
    state.profilePopupProfile = null
    stopWaitingRoomActivity()
    resetFinalFillSequence()
    options.onAdminInfoFamilyScreenEnter?.()
    const p = overridePeriod && isAdminPaymentPeriod(overridePeriod) ? overridePeriod : 'today'
    state.adminPaymentsPeriod = p
    state.adminPaymentsOffset = 0
    state.adminPaymentsRows = []
    state.adminPaymentsTotal = 0
    state.adminPaymentsTotalsByCurrency = {}
    state.adminPaymentsErrorText = null
    state.adminPaymentsLoading = true
    // pushState creates a Back entry so the browser can return to the previous screen.
    // syncAdminPaymentsUrl (replaceState) is used only for in-screen period/offset changes.
    const targetUrl = `/admin/payments?period=${encodeURIComponent(p)}`
    if (window.location.pathname + window.location.search !== targetUrl) {
      if (historyMode === 'replace') {
        history.replaceState(null, '', targetUrl)
      } else {
        history.pushState(null, '', targetUrl)
      }
    }
    render()
    void fetchAdminPayments()
  }

  async function fetchAdminPayments(): Promise<void> {
    // Capture the current period/offset and generation at the time of the request.
    // If these change before the response arrives, the response is discarded.
    const gen = ++_adminPaymentsGen
    const snapshotPeriod = state.adminPaymentsPeriod
    const snapshotOffset = state.adminPaymentsOffset

    if (!options.onAdminPaymentsLoad) {
      if (gen !== _adminPaymentsGen) return
      state.adminPaymentsLoading = false
      state.adminPaymentsErrorText = 'Зареждането не е конфигурирано.'
      if (state.currentScreen === 'admin-payments') render()
      return
    }
    const result = await options.onAdminPaymentsLoad({
      period: snapshotPeriod,
      limit: state.adminPaymentsLimit,
      offset: snapshotOffset,
    })
    // Discard if a newer request superseded this one or screen was left
    if (gen !== _adminPaymentsGen) return
    if (state.currentScreen !== 'admin-payments') return
    state.adminPaymentsLoading = false
    if (!result.ok) {
      if (result.forbidden) {
        forceLeaveAdminScreenForbidden(result.message)
        return
      }
      state.adminPaymentsErrorText = result.message
    } else {
      state.adminPaymentsRows = result.purchases
      state.adminPaymentsTotal = result.pagination.total
      state.adminPaymentsTotalsByCurrency = result.summary.totalsByCurrency
      state.adminPaymentsErrorText = null
    }
    render()
  }

  function showAdminPaymentDetailPanel(purchaseId: string): void {
    const authSession = options.getAuthSession?.() ?? null
    // "Информация" (детайли на плащане) — read-only, достъпно за admin И subadmin.
    if (!isAdminOrSubadminAuthSession(authSession)) {
      state.currentScreen = 'lobby'
      state.errorText = 'Нямаш достъп до admin панела.'
      render()
      return
    }
    leaveAdminServerIfActive()
    // Remember which period we came from so Back can return there
    state.adminPaymentDetailFromPeriod = state.adminPaymentsPeriod
    state.currentScreen = 'admin-payment-detail'
    state.isSearching = false
    state.errorText = null
    state.profilePopupOpen = false
    state.profilePopupProfile = null
    stopWaitingRoomActivity()
    resetFinalFillSequence()
    options.onAdminInfoFamilyScreenEnter?.()
    state.adminPaymentDetailPurchaseId = purchaseId
    state.adminPaymentDetailLoading = true
    state.adminPaymentDetailPurchase = null
    state.adminPaymentDetailErrorText = null
    const targetUrl = `/admin/payments/${encodeURIComponent(purchaseId)}`
    if (window.location.pathname !== targetUrl) {
      history.pushState(null, '', targetUrl)
    }
    render()
    void fetchAdminPaymentDetail(purchaseId)
  }

  async function fetchAdminPaymentDetail(purchaseId: string): Promise<void> {
    if (!options.onAdminPaymentDetailLoad) {
      state.adminPaymentDetailLoading = false
      state.adminPaymentDetailErrorText = 'Зареждането не е конфигурирано.'
      if (state.currentScreen === 'admin-payment-detail') render()
      return
    }
    const result = await options.onAdminPaymentDetailLoad(purchaseId)
    if (state.currentScreen !== 'admin-payment-detail') return
    if (state.adminPaymentDetailPurchaseId !== purchaseId) return
    state.adminPaymentDetailLoading = false
    if (!result.ok) {
      if (result.forbidden) {
        forceLeaveAdminScreenForbidden(result.message)
        return
      }
      state.adminPaymentDetailErrorText = result.message
    } else {
      state.adminPaymentDetailPurchase = result.purchase
      state.adminPaymentDetailErrorText = null
    }
    render()
  }

  let _adminTournamentsGen = 0

  function syncAdminTournamentsUrl(): void {
    if (state.currentScreen !== 'admin-tournaments') return
    const qs = new URLSearchParams()
    const filters = state.adminTournamentsFilters
    for (const [key, value] of Object.entries(filters)) {
      if (value !== '' && !(key === 'page' && value === 1) && !(key === 'limit' && value === 25)) {
        qs.set(key, String(value))
      }
    }
    const target = `/admin/tournaments${qs.toString() ? `?${qs.toString()}` : ''}`
    if (window.location.pathname + window.location.search !== target) {
      history.replaceState(null, '', target)
    }
  }

  function showAdminTournamentsPanel(historyMode: 'push' | 'replace' = 'push'): void {
    const authSession = options.getAuthSession?.() ?? null
    if (!isAdminOrSubadminAuthSession(authSession)) {
      state.currentScreen = 'lobby'
      state.errorText = 'Нямаш достъп до admin панела.'
      render()
      return
    }
    leaveAdminServerIfActive()
    state.currentScreen = 'admin-tournaments'
    state.isSearching = false
    state.errorText = null
    state.profilePopupOpen = false
    state.profilePopupProfile = null
    stopWaitingRoomActivity()
    resetFinalFillSequence()
    options.onAdminInfoFamilyScreenEnter?.()
    state.adminTournamentsLoading = true
    state.adminTournamentsErrorText = null
    state.adminTournamentsRows = []
    const target = '/admin/tournaments'
    if (window.location.pathname !== target) {
      if (historyMode === 'replace') history.replaceState(null, '', target)
      else history.pushState(null, '', target)
    }
    syncAdminTournamentsUrl()
    render()
    void fetchAdminTournaments()
  }

  async function fetchAdminTournaments(): Promise<void> {
    const gen = ++_adminTournamentsGen
    if (!options.onAdminTournamentsLoad) {
      state.adminTournamentsLoading = false
      state.adminTournamentsErrorText = 'Зареждането не е конфигурирано.'
      if (state.currentScreen === 'admin-tournaments') render()
      return
    }
    const result = await options.onAdminTournamentsLoad(state.adminTournamentsFilters)
    if (gen !== _adminTournamentsGen || state.currentScreen !== 'admin-tournaments') return
    state.adminTournamentsLoading = false
    if (!result.ok) {
      if (result.forbidden) {
        forceLeaveAdminScreenForbidden(result.message)
        return
      }
      state.adminTournamentsErrorText = result.message
      render()
      return
    }
    state.adminTournamentsRows = result.tournaments
    state.adminTournamentsTotal = result.totalCount
    state.adminTournamentsCanWrite = result.canWrite
    state.adminTournamentsErrorText = null
    render()
  }

  function showAdminTournamentDetailPanel(tournamentId: string, historyMode: 'push' | 'replace' = 'push'): void {
    const authSession = options.getAuthSession?.() ?? null
    if (!isAdminOrSubadminAuthSession(authSession)) {
      state.currentScreen = 'lobby'
      state.errorText = 'Нямаш достъп до admin панела.'
      render()
      return
    }
    leaveAdminServerIfActive()
    state.currentScreen = 'admin-tournament-detail'
    state.isSearching = false
    state.errorText = null
    state.profilePopupOpen = false
    state.profilePopupProfile = null
    stopWaitingRoomActivity()
    resetFinalFillSequence()
    options.onAdminInfoFamilyScreenEnter?.()
    state.adminTournamentDetailId = tournamentId
    state.adminTournamentDetailLoading = true
    state.adminTournamentDetail = null
    state.adminTournamentDetailErrorText = null
    state.adminTournamentActionErrorText = null
    state.adminTournamentActionInfoText = null
    state.adminTournamentCancelConfirmOpen = false
    const target = `/admin/tournaments/${encodeURIComponent(tournamentId)}`
    if (window.location.pathname !== target) {
      if (historyMode === 'replace') history.replaceState(null, '', target)
      else history.pushState(null, '', target)
    }
    render()
    void fetchAdminTournamentDetail(tournamentId)
  }

  async function fetchAdminTournamentDetail(tournamentId: string): Promise<void> {
    if (!options.onAdminTournamentDetailLoad) {
      state.adminTournamentDetailLoading = false
      state.adminTournamentDetailErrorText = 'Зареждането не е конфигурирано.'
      if (state.currentScreen === 'admin-tournament-detail') render()
      return
    }
    const result = await options.onAdminTournamentDetailLoad(tournamentId)
    if (state.currentScreen !== 'admin-tournament-detail' || state.adminTournamentDetailId !== tournamentId) return
    state.adminTournamentDetailLoading = false
    if (!result.ok) {
      if (result.forbidden) {
        forceLeaveAdminScreenForbidden(result.message)
        return
      }
      state.adminTournamentDetailErrorText = result.message
      render()
      return
    }
    state.adminTournamentDetail = result.tournament
    state.adminTournamentsCanWrite = result.canWrite
    state.adminTournamentDetailErrorText = null
    render()
  }

  async function submitAdminTournamentReconcile(): Promise<void> {
    const tournamentId = state.adminTournamentDetailId
    if (!tournamentId || !options.onAdminTournamentReconcile || state.adminTournamentActionBusy) return
    state.adminTournamentActionBusy = true
    state.adminTournamentActionErrorText = null
    state.adminTournamentActionInfoText = null
    render()
    const result = await options.onAdminTournamentReconcile(tournamentId)
    state.adminTournamentActionBusy = false
    if (!result.ok) {
      if (result.forbidden) forceLeaveAdminScreenForbidden(result.message)
      else state.adminTournamentActionErrorText = result.message
      render()
      return
    }
    state.adminTournamentActionInfoText =
      result.status === 'already_consistent'
        ? 'Турнирът вече е в консистентно състояние.'
        : result.status === 'no_safe_action'
          ? 'Няма безопасно автоматично действие.'
          : 'Турнирът е синхронизиран.'
    render()
    await fetchAdminTournamentDetail(tournamentId)
  }

  async function submitAdminTournamentCancelOpen(): Promise<void> {
    const tournamentId = state.adminTournamentDetailId
    if (!tournamentId || !options.onAdminTournamentCancelOpen || state.adminTournamentActionBusy) return
    state.adminTournamentActionBusy = true
    state.adminTournamentCancelConfirmOpen = false
    state.adminTournamentActionErrorText = null
    state.adminTournamentActionInfoText = null
    render()
    const result = await options.onAdminTournamentCancelOpen(tournamentId)
    state.adminTournamentActionBusy = false
    if (!result.ok) {
      if (result.forbidden) forceLeaveAdminScreenForbidden(result.message)
      else state.adminTournamentActionErrorText = result.message
      render()
      return
    }
    state.adminTournamentActionInfoText = 'Турнирът е отменен. Входните такси са възстановени.'
    render()
    await fetchAdminTournamentDetail(tournamentId)
  }

  function showAdminServerPanel(): void {
    const authSession = options.getAuthSession?.() ?? null

    // "Сървър" — read-only, достъпно за admin И subadmin.
    if (!isAdminOrSubadminAuthSession(authSession)) {
      state.currentScreen = 'lobby'
      state.errorText = 'Нямаш достъп до admin панела.'
      render()
      return
    }

    state.currentScreen = 'admin-server'
    state.isSearching = false
    state.errorText = null
    state.profilePopupOpen = false
    state.profilePopupProfile = null
    state.profilePopupCanEdit = true
    state.adminMonitoringSnapshot = null
    state.adminMonitoringErrorText = null
    state.adminHistoryWindow = '1h'
    state.adminHistoryResult = null
    state.adminHistoryLoading = false
    state.adminHistoryErrorText = null
    stopWaitingRoomActivity()
    resetFinalFillSequence()
    render()
    options.onAdminServerScreenEnter?.()
  }

  async function showAdminPanel(): Promise<void> {
    leaveAdminServerIfActive()
    const authSession = options.getAuthSession?.() ?? null

    // "Настройки" — само пълен admin.
    if (!isFullAdminAuthSession(authSession)) {
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

  async function toggleAdminCoinPackageTopOffer(
    packageId: string,
    isTopOffer: boolean,
  ): Promise<void> {
    // Optimistic update using adminCoinPackages as source of truth
    state.adminCoinPackages = state.adminCoinPackages.map((p) =>
      p.packageId === packageId ? { ...p, isTopOffer } : p
    )
    state.lobbyPackages = state.lobbyPackages.map((p) =>
      p.packageId === packageId ? { ...p, isTopOffer } : p
    )
    state.shopPackages = state.shopPackages.map((p) =>
      p.packageId === packageId ? { ...p, isTopOffer } : p
    )
    state.adminCoinPackagesErrorText = null
    render()

    if (!options.onAdminCoinPackageTopOfferToggle) {
      // Revert optimistic update
      state.adminCoinPackages = state.adminCoinPackages.map((p) =>
        p.packageId === packageId ? { ...p, isTopOffer: !isTopOffer } : p
      )
      state.lobbyPackages = state.lobbyPackages.map((p) =>
        p.packageId === packageId ? { ...p, isTopOffer: !isTopOffer } : p
      )
      state.shopPackages = state.shopPackages.map((p) =>
        p.packageId === packageId ? { ...p, isTopOffer: !isTopOffer } : p
      )
      state.adminCoinPackagesErrorText = 'Промяната на топ офертата временно не е налична.'
      render()
      return
    }

    const result = await options.onAdminCoinPackageTopOfferToggle(packageId, isTopOffer)

    if (!result.ok) {
      // Revert optimistic update on API error
      state.adminCoinPackages = state.adminCoinPackages.map((p) =>
        p.packageId === packageId ? { ...p, isTopOffer: !isTopOffer } : p
      )
      state.lobbyPackages = state.lobbyPackages.map((p) =>
        p.packageId === packageId ? { ...p, isTopOffer: !isTopOffer } : p
      )
      state.shopPackages = state.shopPackages.map((p) =>
        p.packageId === packageId ? { ...p, isTopOffer: !isTopOffer } : p
      )
      state.adminCoinPackagesErrorText = result.message
      render()
      return
    }

    state.adminCoinPackages = result.packages
    state.lobbyPackages = state.lobbyPackages.map((p) => {
      const updated = result.packages.find((r) => r.packageId === p.packageId)
      return updated !== undefined ? { ...p, isTopOffer: updated.isTopOffer } : p
    })
    state.shopPackages = state.shopPackages.map((p) => {
      const updated = result.packages.find((r) => r.packageId === p.packageId)
      return updated !== undefined ? { ...p, isTopOffer: updated.isTopOffer } : p
    })
    state.adminCoinPackagesErrorText = null
    render()
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
    leaveAdminServerIfActive()
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

  async function handleAcceptanceNotificationClick(friendshipId: string): Promise<void> {
    if (state.acceptanceProcessingIds.has(friendshipId)) return
    state.acceptanceProcessingIds = new Set([...state.acceptanceProcessingIds, friendshipId])
    state.acceptanceErrorText = null
    render()

    if (!options.onMarkAcceptanceNotificationRead) {
      state.acceptanceProcessingIds = new Set(
        [...state.acceptanceProcessingIds].filter((id) => id !== friendshipId),
      )
      render()
      return
    }

    try {
      await options.onMarkAcceptanceNotificationRead(friendshipId)
    } catch {
      state.acceptanceProcessingIds = new Set(
        [...state.acceptanceProcessingIds].filter((id) => id !== friendshipId),
      )
      state.acceptanceErrorText = 'Неуспешно отбелязване. Опитай отново.'
      render()
      return
    }

    // Success — now remove from local state and navigate.
    state.acceptanceNotifications = state.acceptanceNotifications.filter(
      (n) => n.friendshipId !== friendshipId,
    )
    state.acceptanceProcessingIds = new Set(
      [...state.acceptanceProcessingIds].filter((id) => id !== friendshipId),
    )
    state.acceptanceErrorText = null
    render()

    await showFriendsDirectory()
  }

  async function likeProfile(profileId: string): Promise<void> {
    const result = await options.onLikeProfile?.(profileId)
    if (!result?.ok) return

    const applyLike = (p: PlayerPublicProfileSnapshot): PlayerPublicProfileSnapshot =>
      p.profileId === profileId
        ? { ...p, hasLikedByMe: result.liked, likesCount: result.likesCount }
        : p

    state.players = state.players.map(applyLike)
    state.playersSearchResults = state.playersSearchResults?.map(applyLike) ?? null

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
    state.pendingFriendRequests = state.pendingFriendRequests.filter((request) => request.friendshipId !== friendshipId)
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
    state.pendingFriendRequests = state.pendingFriendRequests.filter((request) => request.friendshipId !== friendshipId)
    state.friendsErrorText = null
    render()
  }

  async function cancelFriendRequest(friendshipId: string): Promise<void> {
    const result = options.onFriendCancel
      ? await options.onFriendCancel(friendshipId)
      : { ok: false as const, message: 'Отмяната на поканата временно не е налична.' }

    if (!result.ok) {
      const isAlreadyProcessed =
        result.message.includes('не беше намерена') || result.message.includes('вече е обработена')
      if (isAlreadyProcessed && state.friendships !== null) {
        state.friendships = {
          ...state.friendships,
          outgoingPending: state.friendships.outgoingPending.filter((r) => r.friendshipId !== friendshipId),
        }
        state.friendsErrorText = null
        render()
        return
      }
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
      if (result.limitReached) {
        state.blockLimitPopupOpen = true
        render()
        return
      }
      state.friendActionMessageProfileId = profileId
      state.friendActionMessage = result.message
      render()
      return
    }

    const { blocked } = result as { blocked: boolean }

    const updateProfile = (p: PlayerPublicProfileSnapshot) =>
      p.profileId === profileId ? { ...p, isBlockedByMe: blocked } : p

    state.players = state.players.map(updateProfile)
    state.playersSearchResults = state.playersSearchResults?.map(updateProfile) ?? null
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
    state.playersSearchResults = state.playersSearchResults?.map(updateProfile) ?? null
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
      if ('code' in result) {
        state.giftModalErrorText = formatGiftLimitError(result)
      } else {
        state.giftModalErrorText = result.message
      }
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
    leaveAdminServerIfActive()
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

  function showPublicLegalPage(screen: 'terms' | 'privacy' | 'contact'): void {
    leaveAdminServerIfActive()
    state.currentScreen = screen
    state.isSearching = false
    state.errorText = null
    state.profilePopupOpen = false
    state.profilePopupProfile = null
    state.profilePopupCanEdit = true
    stopWaitingRoomActivity()
    resetFinalFillSequence()
    render()
  }

  function scrollLobbyRootToTop(): void {
    const el = options.root.querySelector<HTMLElement>('[data-lobby-screen-root="1"]')
    if (el) el.scrollTop = 0
  }

  function showRulesPage(): void {
    leaveAdminServerIfActive()
    state.currentScreen = 'rules'
    state.isSearching = false
    state.errorText = null
    state.profilePopupOpen = false
    state.profilePopupProfile = null
    state.profilePopupCanEdit = true
    stopWaitingRoomActivity()
    resetFinalFillSequence()
    render()
    scrollLobbyRootToTop()
  }

  function showStrategyPage(): void {
    leaveAdminServerIfActive()
    state.currentScreen = 'strategy'
    state.isSearching = false
    state.errorText = null
    state.profilePopupOpen = false
    state.profilePopupProfile = null
    state.profilePopupCanEdit = true
    stopWaitingRoomActivity()
    resetFinalFillSequence()
    render()
    scrollLobbyRootToTop()
  }

  function showLearnPage(): void {
    leaveAdminServerIfActive()
    state.currentScreen = 'learn'
    state.isSearching = false
    state.errorText = null
    state.profilePopupOpen = false
    state.profilePopupProfile = null
    state.profilePopupCanEdit = true
    stopWaitingRoomActivity()
    resetFinalFillSequence()
    render()
    scrollLobbyRootToTop()
  }

  function showFaqPage(): void {
    leaveAdminServerIfActive()
    state.currentScreen = 'faq'
    state.isSearching = false
    state.errorText = null
    state.profilePopupOpen = false
    state.profilePopupProfile = null
    state.profilePopupCanEdit = true
    stopWaitingRoomActivity()
    resetFinalFillSequence()
    render()
    scrollLobbyRootToTop()
  }

  function showAboutPage(): void {
    leaveAdminServerIfActive()
    state.currentScreen = 'about'
    state.isSearching = false
    state.errorText = null
    state.profilePopupOpen = false
    state.profilePopupProfile = null
    state.profilePopupCanEdit = true
    stopWaitingRoomActivity()
    resetFinalFillSequence()
    render()
    scrollLobbyRootToTop()
  }

  function showFairPlayPage(): void {
    leaveAdminServerIfActive()
    state.currentScreen = 'fair-play'
    state.isSearching = false
    state.errorText = null
    state.profilePopupOpen = false
    state.profilePopupProfile = null
    state.profilePopupCanEdit = true
    stopWaitingRoomActivity()
    resetFinalFillSequence()
    render()
    scrollLobbyRootToTop()
  }

  // Статична страница, но с nested route /tournaments/how-it-works (не flat
  // top-level path като rules/faq/fair-play) — затова управлява собствен
  // URL през pushState, огледално на showTournamentDetail, вместо да мине
  // през LOBBY_PATH_TO_SCREEN/SCREEN_TO_PATH/PATH_TO_SCREEN картите.
  function showTournamentHowItWorksPage(): void {
    leaveAdminServerIfActive()
    state.currentScreen = 'tournament-how-it-works'
    state.isSearching = false
    state.errorText = null
    state.profilePopupOpen = false
    state.profilePopupProfile = null
    state.profilePopupCanEdit = true
    stopWaitingRoomActivity()
    resetFinalFillSequence()
    const targetUrl = '/tournaments/how-it-works'
    if (window.location.pathname !== targetUrl) {
      history.pushState(null, '', targetUrl)
    }
    render()
    scrollLobbyRootToTop()
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

  const CHAT_IMAGE_ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp'])
  // Трябва да съвпада точно със сървърния MAX_ORIGINAL_IMAGE_BYTES
  // (server/src/index.ts) — 10 000 000 байта (decimal 10 MB), НЕ
  // 10 * 1024 * 1024 (10 MiB = 10 485 760). Разминаване тук би означавало
  // файл между двете стойности минава клиентската проверка, но сървърът
  // пак го отхвърля — подвеждащ UX въпреки коректния краен резултат.
  const CHAT_IMAGE_MAX_BYTES = 10_000_000

  // Клиентска проверка — бърза UX обратна връзка, НЕ заменя сървърната
  // проверка (реалният формат/размер се валидира отново на сървъра чрез
  // sharp metadata, виж createChatAttachmentWebp в index.ts).
  function validateChatImageFile(file: File): string | null {
    if (!CHAT_IMAGE_ALLOWED_MIME_TYPES.has(file.type)) {
      return 'Поддържат се само JPEG, PNG и WebP снимки.'
    }
    if (file.size > CHAT_IMAGE_MAX_BYTES) {
      return 'Снимката трябва да бъде до 10 MB.'
    }
    return null
  }

  function clearChatPendingImage(friendshipId: string): void {
    const pending = state.chatPendingImageByFriendshipId[friendshipId]
    if (pending) {
      URL.revokeObjectURL(pending.previewUrl)
    }
    const next = { ...state.chatPendingImageByFriendshipId }
    delete next[friendshipId]
    state.chatPendingImageByFriendshipId = next
  }

  function selectChatImage(friendshipId: string, file: File): void {
    const validationError = validateChatImageFile(file)

    if (validationError !== null) {
      state.chatErrorText = validationError
      render()
      return
    }

    // Замяна на предишен избор (ако имаше) — освобождаваме стария object URL
    // преди да създадем нов, за да не изтичат ресурси.
    clearChatPendingImage(friendshipId)
    const previewUrl = URL.createObjectURL(file)
    state.chatPendingImageByFriendshipId = {
      ...state.chatPendingImageByFriendshipId,
      [friendshipId]: { file, previewUrl },
    }
    state.chatErrorText = null
    render()
  }

  function readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolvePromise, rejectPromise) => {
      const reader = new FileReader()
      reader.onload = () => resolvePromise(String(reader.result))
      reader.onerror = () => rejectPromise(reader.error ?? new Error('FileReader error'))
      reader.readAsDataURL(file)
    })
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

    // Защита от двойно изпращане — блокира повторен submit, докато чака
    // сървърния отговор (виж chatUploadingFriendshipIds — рендер слоят
    // disable-ва input/бутон/файл-бутон, докато friendshipId е в this Set).
    if (state.chatUploadingFriendshipIds.has(friendshipId)) {
      return
    }

    const pendingImage = state.chatPendingImageByFriendshipId[friendshipId] ?? null

    if (body.trim().length === 0 && pendingImage === null) {
      return
    }

    state.chatUploadingFriendshipIds = new Set(state.chatUploadingFriendshipIds).add(friendshipId)
    state.chatErrorText = null
    render()

    let imageDataUrl: string | null = null

    if (pendingImage !== null) {
      try {
        imageDataUrl = await readFileAsDataUrl(pendingImage.file)
      } catch {
        const nextUploading = new Set(state.chatUploadingFriendshipIds)
        nextUploading.delete(friendshipId)
        state.chatUploadingFriendshipIds = nextUploading
        state.chatErrorText = 'Качването на снимката не бе успешно. Опитайте отново.'
        render()
        return
      }
    }

    const result = await options.onChatSend(friendshipId, body, imageDataUrl)

    const nextUploading = new Set(state.chatUploadingFriendshipIds)
    nextUploading.delete(friendshipId)
    state.chatUploadingFriendshipIds = nextUploading

    if (!result.ok) {
      // Изпращането е неуспешно — черновата и избраната снимка НЕ се пипат,
      // за да не ги изгуби потребителят и да може да опита отново.
      state.chatErrorText = result.message
      render()
      return
    }

    // Изчистваме черновата и избраната снимка едва тук — след потвърден
    // успех от сървъра.
    state.chatDraftByFriendshipId = { ...state.chatDraftByFriendshipId, [friendshipId]: '' }
    clearChatPendingImage(friendshipId)
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
      ? await options.onRegisterSubmit(displayName, email.trim(), password, gender)
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

  async function submitForgotPassword(email: string): Promise<void> {
    if (state.authSubmitInFlight) return

    state.authSubmitInFlight = true

    const submitBtn = options.root.querySelector<HTMLButtonElement>('[data-lobby-forgot-submit="1"]')
    if (submitBtn) {
      submitBtn.disabled = true
      submitBtn.textContent = 'Изпращане...'
    }

    const msgEl = options.root.querySelector<HTMLElement>('[data-lobby-forgot-message="1"]')

    let responseBody: { ok: boolean; code?: string; message?: string } | null = null
    try {
      const response = await fetch(`${options.getApiBaseUrl?.() ?? ''}/api/auth/forgot-password`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      responseBody = (await response.json()) as typeof responseBody
    } catch {
      responseBody = null
    }

    state.authSubmitInFlight = false

    const KNOWN_CODES = new Set(['INVALID_EMAIL', 'ACCOUNT_NOT_FOUND', 'RATE_LIMITED', 'EMAIL_DELIVERY_FAILED', 'EMAIL_SENT'])
    const rb = responseBody as { ok: boolean; code?: string; message?: string } | null
    const message =
      rb !== null && rb.message && KNOWN_CODES.has(rb.code ?? '')
        ? rb.message
        : 'Възникна грешка при изпращането. Моля, опитайте отново.'

    const isSuccess = rb?.code === 'EMAIL_SENT'

    if (msgEl) {
      msgEl.textContent = message
      msgEl.style.display = ''
      if (isSuccess) {
        msgEl.style.cssText = msgEl.style.cssText.replace(/border:[^;]+;?/g, '')
        msgEl.style.border = '1px solid rgba(74,222,128,0.28)'
        msgEl.style.background = 'rgba(20,83,45,0.42)'
        msgEl.style.color = '#86efac'
      } else {
        msgEl.style.border = '1px solid rgba(248,113,113,0.28)'
        msgEl.style.background = 'rgba(127,29,29,0.42)'
        msgEl.style.color = '#fecaca'
      }
    }

    if (submitBtn) {
      // При успех — оставяме бутона disabled (не изпращаме втори линк автоматично).
      if (!isSuccess) {
        submitBtn.disabled = false
        submitBtn.textContent = 'Изпрати линк'
      } else {
        submitBtn.textContent = 'Линкът е изпратен'
      }
    }
  }

  async function openGuestTrialPopup(): Promise<void> {
    // hasConfirmedStatus остава false, докато нямаме fresh server отговор — попречва на
    // showing stale/default remaining (напр. "Имате 3 пробни игри" за guest, който вече
    // е изчерпал лимита си в предишна сесия). renderGuestTrialPopup показва loading state,
    // докато полето е false.
    state.guestTrialPopup = {
      ...state.guestTrialPopup,
      isOpen: true,
      errorText: null,
      isSubmitting: false,
      hasConfirmedStatus: false,
    }
    render()

    const result = await options.onGuestTrialStatusLoad?.()

    if (!result || !state.guestTrialPopup.isOpen) {
      return
    }

    if (result.ok) {
      state.guestTrialPopup = {
        ...state.guestTrialPopup,
        gamesUsed: result.gamesUsed,
        remaining: result.remaining,
        maxGames: result.maxGames,
        hasConfirmedStatus: true,
      }
    } else {
      state.guestTrialPopup = {
        ...state.guestTrialPopup,
        errorText: result.message,
        hasConfirmedStatus: true,
      }
    }

    render()
  }

  function closeGuestTrialPopup(): void {
    state.guestTrialPopup = {
      ...state.guestTrialPopup,
      isOpen: false,
      errorText: null,
      isSubmitting: false,
    }
    render()
  }

  function openGuestLockedStakePopup(): void {
    state.guestLockedStakePopup = { isOpen: true }
    render()
  }

  function closeGuestLockedStakePopup(): void {
    state.guestLockedStakePopup = { isOpen: false }
    render()
  }

  function openLevelLockedStakePopup(requiredLevel: number, currentLevel: number): void {
    state.levelLockedStakePopup = { isOpen: true, requiredLevel, currentLevel }
    render()
  }

  function closeLevelLockedStakePopup(): void {
    state.levelLockedStakePopup = { ...state.levelLockedStakePopup, isOpen: false }
    render()
  }

  function handleGuestTrialPlayClick(): void {
    if (!state.guestTrialPopup.hasConfirmedStatus || state.guestTrialPopup.isSubmitting || state.guestTrialPopup.remaining <= 0) {
      return
    }

    if (!state.isConnected) {
      state.guestTrialPopup = {
        ...state.guestTrialPopup,
        errorText: 'Няма връзка със сървъра.',
      }
      render()
      return
    }

    state.guestTrialPopup = {
      ...state.guestTrialPopup,
      isSubmitting: true,
      errorText: null,
    }
    render()

    options.joinGuestTrial?.(GUEST_TRIAL_STAKE)
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

      if (stake === GUEST_TRIAL_STAKE) {
        void openGuestTrialPopup()
        render()
        return
      }

      openGuestLockedStakePopup()
      return
    }

    state.displayName = authSession.profile.displayName

    const stakeRoomForLevelCheck = state.matchRooms.find((r) => r.stakeAmount === stake)
    const requiredLevel = stakeRoomForLevelCheck?.minLevel ?? 1
    const currentLevel = authSession.profile.level ?? 1
    if (currentLevel < requiredLevel) {
      openLevelLockedStakePopup(requiredLevel, currentLevel)
      return
    }

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
    state.serverQueuedPlayerPreviews = []
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

    const selectedMatchRoom = state.matchRooms.find((r) => r.stakeAmount === state.selectedStake)
    options.root.innerHTML = renderMatchmakingRoomScreen({
      prizeAmount: selectedMatchRoom?.prizeAmount ?? null,
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
    'admin-server': '/admin/server',
    'guest-contact-messages': '/admin/guest-contact',
    'admin-visitors': '/admin/visitors',
    'admin-payments': '/admin/payments',
    'admin-tournaments': '/admin/tournaments',
    tournaments: '/tournaments',
    friends: '/friends',
    chat: '/chat',
    terms: '/terms',
    privacy: '/privacy',
    contact: '/contact',
    rules: '/rules',
    strategy: '/strategy',
    learn: '/learn',
    faq: '/faq',
    about: '/about',
    'fair-play': '/fair-play',
  }

  const PATH_TO_SCREEN: Record<string, LobbySocialScreen> = {
    '/lobby': 'lobby',
    '/players': 'players',
    '/ranking': 'leaderboards',
    '/shop': 'shop',
    '/admin': 'admin',
    '/admin/server': 'admin-server',
    '/admin/guest-contact': 'guest-contact-messages',
    '/admin/visitors': 'admin-visitors',
    '/admin/payments': 'admin-payments',
    '/admin/tournaments': 'admin-tournaments',
    '/tournaments': 'tournaments',
    '/friends': 'friends',
    '/chat': 'chat',
    '/terms': 'terms',
    '/privacy': 'privacy',
    '/contact': 'contact',
    '/rules': 'rules',
    '/strategy': 'strategy',
    '/learn': 'learn',
    '/faq': 'faq',
    '/about': 'about',
    '/fair-play': 'fair-play',
  }

  const _loadPath = window.location.pathname
  let _pendingInitialNav = false
  let _navigationReady = false

  function syncAdminVisitorsUrl(): void {
    if (state.currentScreen !== 'admin-visitors') return
    const qs = new URLSearchParams()
    qs.set('period', state.adminVisitorsPeriod)
    if (state.adminVisitorsView !== 'visitors') qs.set('view', state.adminVisitorsView)
    if (state.adminVisitorsType !== 'all') qs.set('type', state.adminVisitorsType)
    if (state.adminVisitorsDevice !== 'all') qs.set('device', state.adminVisitorsDevice)
    if (state.adminVisitorsOs !== 'all') qs.set('os', state.adminVisitorsOs)
    history.replaceState(null, '', `/admin/visitors?${qs}`)
  }

  function syncAdminPaymentsUrl(): void {
    if (state.currentScreen !== 'admin-payments') return
    const qs = new URLSearchParams()
    qs.set('period', state.adminPaymentsPeriod)
    history.replaceState(null, '', `/admin/payments?${qs}`)
  }

  function syncUrlPath(): void {
    if (!_navigationReady || _pendingInitialNav) return
    if (document.getElementById('pwa-landing-overlay') !== null) return
    // Dynamic screens manage their own URL via pushState — skip syncUrlPath for them
    if (state.currentScreen === 'admin-payment-detail') return
    if (state.currentScreen === 'tournament-detail') return
    if (state.currentScreen === 'tournament-how-it-works') return
    const path = SCREEN_TO_PATH[state.currentScreen] ?? '/lobby'
    if (path !== window.location.pathname) {
      history.pushState(null, '', path)
      applyRouteSeo(path)
    }
  }

  function navigateFromPath(path: string): void {
    // Dynamic route: /admin/payments/:purchaseId
    const detailMatch = /^\/admin\/payments\/([^/]+)$/.exec(path)
    if (detailMatch) {
      showAdminPaymentDetailPanel(decodeURIComponent(detailMatch[1] ?? ''))
      return
    }

    const adminTournamentDetailMatch = /^\/admin\/tournaments\/([^/]+)$/.exec(path)
    if (adminTournamentDetailMatch) {
      showAdminTournamentDetailPanel(decodeURIComponent(adminTournamentDetailMatch[1] ?? ''))
      return
    }

    // Fixed route /tournaments/how-it-works — трябва да е ПРЕДИ динамичния
    // /tournaments/:tournamentId regex по-долу, иначе "how-it-works" би се
    // тълкувал погрешно като tournamentId.
    if (path === '/tournaments/how-it-works') {
      showTournamentHowItWorksPage()
      return
    }

    // Dynamic route: /tournaments/:tournamentId
    const tournamentDetailMatch = /^\/tournaments\/([^/]+)$/.exec(path)
    if (tournamentDetailMatch) {
      showTournamentDetail(decodeURIComponent(tournamentDetailMatch[1] ?? ''))
      return
    }

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
      case 'guest-contact-messages': void showAdminGuestContactMessages(); break
      case 'admin-info': void showAdminInfoPanel(); break
      case 'admin-server': showAdminServerPanel(); break
      case 'admin-visitors': {
        const _qs = new URLSearchParams(window.location.search)
        showAdminVisitorsPanel(_qs.get('period') ?? undefined, _qs.get('view') ?? undefined, _qs.get('device') ?? undefined, _qs.get('type') ?? undefined, _qs.get('os') ?? undefined)
        break
      }
      case 'admin-payments': {
        const _qs = new URLSearchParams(window.location.search)
        showAdminPaymentsPanel(_qs.get('period') ?? undefined)
        break
      }
      case 'admin-tournaments': {
        const _qs = new URLSearchParams(window.location.search)
        state.adminTournamentsFilters = {
          ...state.adminTournamentsFilters,
          page: Number(_qs.get('page') ?? '1') || 1,
          status: _qs.get('status') ?? '',
          settlementState: _qs.get('settlementState') ?? '',
          visibility: _qs.get('visibility') ?? '',
          startMode: _qs.get('startMode') ?? '',
          integrityState: _qs.get('integrityState') ?? '',
          search: _qs.get('search') ?? '',
        }
        showAdminTournamentsPanel()
        break
      }
      case 'tournaments': void showTournamentsList(); break
      case 'friends': void showFriendsDirectory(); break
      case 'chat': void showChatPanel(); break
      case 'terms': showPublicLegalPage('terms'); break
      case 'privacy': showPublicLegalPage('privacy'); break
      case 'contact': showPublicLegalPage('contact'); break
      case 'rules': showRulesPage(); break
      case 'strategy': showStrategyPage(); break
      case 'learn': showLearnPage(); break
      case 'faq': showFaqPage(); break
      case 'about': showAboutPage(); break
      case 'fair-play': showFairPlayPage(); break
    }
  }

  function renderMatchmakingRoom(): void {
    paintMatchmakingRoom()
    startLiveCountdownLoop()
  }

  // Чат subscription lifecycle за чакалнята на частна маса — огледало на
  // reconcileLobbyChatSubscription(), но key-нато по room id вместо по
  // фиксиран екран, защото местната чакалня може да смени room id-то си
  // (напр. re-join в друга маса без пълен logout).
  function reconcilePrivateRoomWaitingChatSubscription(): void {
    const targetRoomId = state.currentScreen === 'private-room-waiting' ? (state.myPrivateRoom?.id ?? null) : null

    if (targetRoomId === state.privateRoomWaitingChatSubscribedRoomId) {
      return
    }

    if (state.privateRoomWaitingChatSubscribedRoomId !== null) {
      options.onPrivateRoomChatUnsubscribe?.(state.privateRoomWaitingChatSubscribedRoomId)
    }

    state.privateRoomWaitingChatSubscribedRoomId = targetRoomId

    if (targetRoomId !== null) {
      options.onPrivateRoomChatSubscribe?.(targetRoomId)
    }
  }

  function renderPrivateRoomWaitingRoom(): void {
    reconcilePrivateRoomWaitingChatSubscription()

    const room = state.myPrivateRoom

    if (room === null) {
      state.currentScreen = 'private-rooms'
      renderLobby()
      return
    }

    const authSession = options.getAuthSession?.() ?? null
    const localProfileId = authSession?.profile.profileId ?? null
    const localMember = room.members.find((m) => m.profileId !== null && m.profileId === localProfileId) ?? null
    const isHost = localMember?.isHost ?? false
    const humanCount = room.members.length
    const canFillWithBots = isHost && humanCount >= 2 && humanCount <= 3

    const previousInput = options.root.querySelector<HTMLInputElement>('[data-private-waiting-chat-input="1"]')
    const wasInputFocused = previousInput !== null && document.activeElement === previousInput
    const caretStart = previousInput?.selectionStart ?? null
    const caretEnd = previousInput?.selectionEnd ?? null

    const previousScroll = options.root.querySelector<HTMLElement>('[data-private-waiting-chat-scroll="1"]')
    const wasNearBottom = previousScroll === null
      ? true
      : previousScroll.scrollHeight - previousScroll.scrollTop - previousScroll.clientHeight < 48
    const previousScrollTop = previousScroll?.scrollTop ?? 0

    options.root.innerHTML = renderPrivateRoomWaitingScreen({
      isLocked: room.kind === 'locked',
      stake: room.stake,
      members: room.members,
      localProfileId,
      isHost,
      canFillWithBots,
      fillBotsLoading: state.privateRoomWaitingFillBotsLoading,
      fillBotsConfirmOpen: state.privateRoomWaitingFillBotsConfirmOpen,
      leaveConfirmOpen: state.privateRoomWaitingLeaveConfirmOpen,
      chatMessages: state.privateRoomWaitingChatMessages,
      chatDraft: state.privateRoomWaitingChatDraft,
      chatSending: state.privateRoomWaitingChatSending,
      chatErrorText: state.privateRoomWaitingChatErrorText,
      infoText: state.privateRoomInfoText,
      expiresAt: room.expiresAt,
    })

    startPrivateRoomCountdownLoop(room.id, room.expiresAt)

    options.root.querySelector<HTMLButtonElement>('[data-private-waiting-leave-button="1"]')
      ?.addEventListener('click', () => {
        state.privateRoomWaitingLeaveConfirmOpen = true
        render()
      })

    options.root.querySelector<HTMLButtonElement>('[data-private-waiting-leave-confirm-yes="1"]')
      ?.addEventListener('click', () => {
        state.privateRoomWaitingLeaveConfirmOpen = false
        options.onPrivateRoomLeave?.()
        render()
      })

    options.root.querySelector<HTMLButtonElement>('[data-private-waiting-leave-confirm-cancel="1"]')
      ?.addEventListener('click', () => {
        state.privateRoomWaitingLeaveConfirmOpen = false
        render()
      })

    options.root.querySelector<HTMLButtonElement>('[data-private-waiting-fillbots-button="1"]')
      ?.addEventListener('click', () => {
        if (!canFillWithBots || state.privateRoomWaitingFillBotsLoading) return
        state.privateRoomWaitingFillBotsConfirmOpen = true
        render()
      })

    options.root.querySelector<HTMLButtonElement>('[data-private-waiting-fillbots-confirm-yes="1"]')
      ?.addEventListener('click', () => {
        if (state.privateRoomWaitingFillBotsLoading) return
        state.privateRoomWaitingFillBotsConfirmOpen = false
        state.privateRoomWaitingFillBotsLoading = true
        options.onPrivateRoomFillWithBots?.()
        render()
      })

    options.root.querySelector<HTMLButtonElement>('[data-private-waiting-fillbots-confirm-cancel="1"]')
      ?.addEventListener('click', () => {
        state.privateRoomWaitingFillBotsConfirmOpen = false
        render()
      })

    const chatForm = options.root.querySelector<HTMLFormElement>('[data-private-waiting-chat-form="1"]')
    const chatInput = options.root.querySelector<HTMLInputElement>('[data-private-waiting-chat-input="1"]')

    chatInput?.addEventListener('input', () => {
      state.privateRoomWaitingChatDraft = chatInput.value
    })

    // Мобилна клавиатура: при focus и при промяна на visualViewport (напр.
    // отваряне/затваряне на клавиатурата), държим полето за писане видимо.
    // Native browser "scroll focused element into view" поведение не винаги
    // се задейства надеждно само от resize-а — затова е изрично тук.
    chatInput?.addEventListener('focus', () => {
      chatInput.scrollIntoView({ block: 'nearest' })
    })

    if (typeof window !== 'undefined' && window.visualViewport && !_privateRoomWaitingViewportListenerAttached) {
      _privateRoomWaitingViewportListenerAttached = true
      window.visualViewport.addEventListener('resize', () => {
        const activeInput = options.root.querySelector<HTMLInputElement>('[data-private-waiting-chat-input="1"]')
        if (activeInput !== null && document.activeElement === activeInput) {
          activeInput.scrollIntoView({ block: 'nearest' })
        }
      })
    }

    chatForm?.addEventListener('submit', (event) => {
      event.preventDefault()

      if (state.privateRoomWaitingChatSending) {
        return
      }

      const body = state.privateRoomWaitingChatDraft.trim()
      const currentRoom = state.myPrivateRoom

      if (body.length === 0 || currentRoom === null) {
        return
      }

      const requestId = `prwc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      state.privateRoomWaitingChatSending = true
      state.privateRoomWaitingChatPendingRequestId = requestId
      state.privateRoomWaitingChatErrorText = null
      options.onPrivateRoomChatSend?.(currentRoom.id, body, requestId)
      render()
    })

    if (wasInputFocused) {
      const nextInput = options.root.querySelector<HTMLInputElement>('[data-private-waiting-chat-input="1"]')
      if (nextInput !== null) {
        nextInput.focus()
        if (caretStart !== null && caretEnd !== null) {
          nextInput.setSelectionRange(caretStart, caretEnd)
        }
      }
    }

    const nextScroll = options.root.querySelector<HTMLElement>('[data-private-waiting-chat-scroll="1"]')
    if (nextScroll !== null) {
      nextScroll.scrollTop = wasNearBottom ? nextScroll.scrollHeight : previousScrollTop
    }
  }

  // Общ лайв чат в лобито — subscribe/unsubscribe lifecycle.
  //
  // reconcileLobbyChatSubscription() се вика на всеки render() и покрива
  // цялата ВЪТРЕШНА навигация в лобито (players/friends/chat/admin/...) чрез
  // единствения източник на истина state.currentScreen — субектите на
  // навигационни функции не се докосват едно по едно.
  //
  // Влизане/възстановяване на игра НЕ минава през state.currentScreen (лобито
  // просто спира да се рендира, докато activeRoom държи екрана) — затова
  // suspendLobbyChatForActiveRoom() се вика ИЗРИЧНО от main.ts на точните
  // 2 места, където това реално се случва (match_found, room_resumed).
  //
  // forceLobbyChatResubscribeIfOnLobbyScreen() се вика от main.ts на всяко
  // WS 'open' (нова връзка = нов connection.id на сървъра => старият
  // subscribe за тази връзка вече не важи там), но само ресетва bookkeeping-а
  // и оставя reconcile/директния fetch да свърши същинската работа, ако
  // клиентът наистина Е на началния екран в момента на reconnect-а.
  function reconcileLobbyChatSubscription(): void {
    const shouldBeSubscribed = state.currentScreen === 'lobby'

    if (!shouldBeSubscribed) {
      if (state.lobbyChatSubscribed) {
        options.onLobbyChatUnsubscribe?.()
      }
      state.lobbyChatSubscribed = false
      state.lobbyChatMessages = []
      return
    }

    if (!state.lobbyChatSubscribed) {
      options.onLobbyChatSubscribe?.()
      state.lobbyChatSubscribed = true
    }
  }

  function suspendLobbyChatForActiveRoom(): void {
    if (state.lobbyChatSubscribed) {
      options.onLobbyChatUnsubscribe?.()
    }
    state.lobbyChatSubscribed = false
    state.lobbyChatMessages = []
  }

  function forceLobbyChatResubscribeIfOnLobbyScreen(): void {
    state.lobbyChatSubscribed = false
    reconcileLobbyChatSubscription()
  }

  // Нова WS връзка = нов connection.id на сървъра => server-side членството в
  // privateRoomsStore (заключено по стария connection.id) вече не сочи към
  // тази връзка. request_private_rooms_list е единственият тригер за
  // server-side reconnectMember() — normalно се вика само при отваряне на
  // таба „Частни маси“ (onPrivateRoomsOpen), затова тук го форсираме и при WS
  // reconnect, но само ако потребителят реално е член на чакаща частна маса
  // (state.myPrivateRoom), за да не гърми при чист lobby/guest/reconnect към
  // вече активна игра — виж main.ts WS onOpen.
  function resyncPrivateRoomMembershipIfWaiting(): void {
    if (state.myPrivateRoom !== null) {
      options.onPrivateRoomsOpen?.()
    }
  }

  function updateLobbyChatDraft(value: string): void {
    state.lobbyChatDraft = value
  }

  function submitLobbyChatMessage(): void {
    const trimmed = state.lobbyChatDraft.trim()

    if (trimmed === '' || state.lobbyChatSending) {
      return
    }

    const requestId = `lc-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    state.lobbyChatSending = true
    state.lobbyChatErrorText = null
    state.lobbyChatPendingRequestId = requestId
    options.onLobbyChatSend?.(trimmed, requestId)
    render()
  }

  function render(): void {
    if (_renderTimerId !== null) {
      clearTimeout(_renderTimerId)
      _renderTimerId = null
    }
    if (shouldSuppressLobbyRender()) {
      return
    }
    reconcileLobbyChatSubscription()
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
    if (state.currentScreen !== 'tournament-detail') {
      clearTournamentStartCountdownLoop()
    }
    if (state.currentScreen !== 'tournaments') {
      clearTournamentListFillExpiryLoop()
    }

    if (state.currentScreen === 'matchmaking-room') {
      renderMatchmakingRoom()
      return
    }

    if (state.currentScreen === 'private-room-waiting') {
      renderPrivateRoomWaitingRoom()
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

  function isAdminTargetEdit(): boolean {
    return state.profileEditorTargetProfileId !== null &&
      isFullAdminAuthSession(options.getAuthSession?.() ?? null)
  }

  function updateEditedTargetProfile(profile: PlayerPublicProfileSnapshot): void {
    state.players = state.players.map((player) =>
      player.profileId === profile.profileId ? profile : player,
    )
    state.playersSearchResults = state.playersSearchResults?.map((player) =>
      player.profileId === profile.profileId ? profile : player,
    ) ?? null
    if (state.profilePopupProfile?.profileId === profile.profileId) {
      state.profilePopupProfile = profile
    }
    if (state.profileEditorTargetProfileId === profile.profileId) {
      state.profileEditorTargetProfile = profile
    }
  }

  async function refreshEditedTargetProfile(
    profileId: string | null,
    knownDisplayNameHint?: string | null,
  ): Promise<void> {
    if (profileId === null || !isAdminTargetEdit()) return
    const result = await options.onPlayersLoad?.(state.playersPage, state.playersSnapshotToken)
    if (!result?.ok) return
    applySuccessfulPlayersPage(result)
    let profile = result.players.find((player) => player.profileId === profileId) ?? null

    // Целевият профил може да е извън капнатия bulk списък (напр. намерен
    // само чрез server-side search) — fallback търсене по известното
    // display name, за да получим актуализираните данни след admin edit.
    if (profile === null && options.onPlayersSearch) {
      const searchTerm =
        knownDisplayNameHint ??
        state.profileEditorTargetProfile?.displayName ??
        state.profilePopupProfile?.displayName ??
        null
      if (searchTerm && searchTerm.trim().length >= 2) {
        const abortController = new AbortController()
        const searchResult = await options
          .onPlayersSearch(searchTerm, abortController.signal)
          .catch(() => null)
        if (searchResult?.ok) {
          profile = searchResult.players.find((player) => player.profileId === profileId) ?? null
        }
      }
    }

    if (profile !== null) {
      updateEditedTargetProfile(profile)
    }
  }

  function openProfileEditorForTarget(profileId: string | null): void {
    const authSession = options.getAuthSession?.() ?? null
    const ownProfileId = authSession?.profile.profileId ?? null
    const targetProfile = profileId
      ? (state.profilePopupProfile?.profileId === profileId
          ? state.profilePopupProfile
          : state.players.find((player) => player.profileId === profileId) ??
            state.playersSearchResults?.find((player) => player.profileId === profileId) ??
            null)
      : null
    const isOwn = profileId === null || (ownProfileId !== null && profileId === ownProfileId)

    if (!isOwn && !isFullAdminAuthSession(authSession)) {
      state.profileEditorOpen = false
      state.profileEditorTargetProfileId = null
      state.profileEditorTargetProfile = null
      return
    }

    state.profileEditorTargetProfileId = isOwn ? null : profileId
    state.profileEditorTargetProfile = isOwn ? null : targetProfile
    state.profileEditorOpen = true
    state.profileEditorErrorText = null
    state.profileNameChangeErrorText = null
    state.profileNameChangeSuccessAmount = null
    state.profilePopupOpen = false
  }

  function getPopupCallbacks(): ProfilePopupCallbacks {
    return {
      onClose: () => {
        state.profilePopupOpen = false
        state.profilePopupProfile = null
        state.profilePopupCanEdit = true
        syncProfilePopup({ isOpen: false, profile: null, canEdit: false, friendshipAction: null }, getPopupCallbacks())
      },
      onEditClick: (profileId) => {
        openProfileEditorForTarget(profileId)
        state.profilePopupOpen = false
        syncProfilePopup({ isOpen: false, profile: null, canEdit: false, friendshipAction: null }, getPopupCallbacks())
        render()
      },
      onFriendRequestClick: (profileId) => { void submitFriendRequest(profileId) },
      onBlockClick: (profileId) => { void blockProfile(profileId) },
      onFriendAcceptClick: (friendshipId) => { void acceptFriendRequest(friendshipId) },
      onFriendRejectClick: (friendshipId) => { void rejectFriendRequest(friendshipId) },
      onFriendCancelClick: (friendshipId) => { void cancelFriendRequest(friendshipId) },
      onFriendRemoveClick: (friendshipId) => { void removeFriendRelationship(friendshipId) },
      onGiftCoinsClick: (friendshipId) => { openGiftModal(friendshipId) },
      onLikeClick: (profileId) => { void likeProfile(profileId) },
      onGrantSubadminClick: (profileId) => {
        if (!profileId) return
        const displayName = state.profilePopupProfile?.displayName ?? 'потребителя'
        const previousRole = state.profilePopupTargetRole === 'chat_admin' ? 'chat_admin' : null
        state.subadminActionConfirm = { profileId, displayName, action: 'grant', previousRole }
        state.profilePopupOpen = false
        syncProfilePopup({ isOpen: false, profile: null, canEdit: false, friendshipAction: null }, getPopupCallbacks())
        render()
      },
      onRevokeSubadminClick: (profileId) => {
        if (!profileId) return
        const displayName = state.profilePopupProfile?.displayName ?? 'потребителя'
        state.subadminActionConfirm = { profileId, displayName, action: 'revoke' }
        state.profilePopupOpen = false
        syncProfilePopup({ isOpen: false, profile: null, canEdit: false, friendshipAction: null }, getPopupCallbacks())
        render()
      },
      onGrantChatAdminClick: (profileId) => {
        if (!profileId) return
        const displayName = state.profilePopupProfile?.displayName ?? 'потребителя'
        const previousRole = state.profilePopupTargetRole === 'subadmin' ? 'subadmin' : null
        state.chatAdminActionConfirm = { profileId, displayName, action: 'grant', previousRole }
        state.profilePopupOpen = false
        syncProfilePopup({ isOpen: false, profile: null, canEdit: false, friendshipAction: null }, getPopupCallbacks())
        render()
      },
      onRevokeChatAdminClick: (profileId) => {
        if (!profileId) return
        const displayName = state.profilePopupProfile?.displayName ?? 'потребителя'
        state.chatAdminActionConfirm = { profileId, displayName, action: 'revoke' }
        state.profilePopupOpen = false
        syncProfilePopup({ isOpen: false, profile: null, canEdit: false, friendshipAction: null }, getPopupCallbacks())
        render()
      },
    }
  }

  /**
   * Заявява текущата роля на разгледания в попъпа профил — само когато
   * viewer-ът е ПЪЛЕН admin, профилът не е собственият, и все още не сме
   * заредили ролята именно за този profileId (memoization guard чрез
   * profilePopupTargetRoleProfileId, за да не се спами при всеки render()).
   * Вика се от renderLobby() и renderPopupOnly() — покрива всички входни
   * точки за отваряне на попъпа без да ги дублира на всяко място.
   */
  function ensureProfilePopupTargetRoleLoaded(): void {
    const authSession = options.getAuthSession?.() ?? null
    const profile = state.profilePopupProfile

    if (!state.profilePopupOpen || profile === null || profile.profileId === null) {
      return
    }
    if (!isFullAdminAuthSession(authSession)) {
      return
    }
    const ownProfileId = authSession?.profile.profileId ?? null
    if (profile.profileId === ownProfileId) {
      return
    }
    if (state.profilePopupTargetRoleProfileId === profile.profileId) {
      return
    }

    const targetProfileId = profile.profileId
    state.profilePopupTargetRoleProfileId = targetProfileId
    state.profilePopupTargetRole = null

    void (async () => {
      const result = await options.onAdminGetTargetRole?.(targetProfileId)
      // Ако попъпът вече сочи към друг профил (или е затворен) междувременно,
      // резултатът е stale — не го прилагаме.
      if (!result || state.profilePopupTargetRoleProfileId !== targetProfileId) {
        return
      }
      if (result.ok) {
        state.profilePopupTargetRole = result.role
        render()
      }
    })()
  }

  function cancelSubadminAction(): void {
    if (state.subadminActionBusy) return
    state.subadminActionConfirm = null
    render()
  }

  let subadminActionToastGeneration = 0

  async function confirmSubadminAction(): Promise<void> {
    const pending = state.subadminActionConfirm
    if (!pending || state.subadminActionBusy) return

    state.subadminActionBusy = true
    render()

    const caller = pending.action === 'grant' ? options.onAdminGrantSubadmin : options.onAdminRevokeSubadmin
    const result = await caller?.(pending.profileId)

    state.subadminActionBusy = false
    state.subadminActionConfirm = null

    if (result?.ok) {
      state.subadminActionToast = {
        text: pending.action === 'grant' ? 'Потребителят вече е субадмин.' : 'Ролята субадмин е премахната.',
        ok: true,
      }
      // Инвалидираме кеша на баджа — ако попъпът за същия профил се отвори пак, ще презареди свежата роля.
      if (state.profilePopupTargetRoleProfileId === pending.profileId) {
        state.profilePopupTargetRoleProfileId = null
        state.profilePopupTargetRole = null
      }
    } else {
      state.subadminActionToast = {
        text: result?.message ?? 'Действието не бе завършено.',
        ok: false,
      }
    }
    render()

    // Токенизирано спрямо конкретния toast — по-стар таймер не бива да
    // изтрие по-нов toast, ако confirmSubadminAction се извика отново
    // (напр. второ действие) в рамките на същите 3.5с.
    const toastGeneration = ++subadminActionToastGeneration
    setTimeout(() => {
      if (toastGeneration !== subadminActionToastGeneration) return
      state.subadminActionToast = null
      render()
    }, 3500)
  }

  /** Огледално на cancelSubadminAction/confirmSubadminAction, за chat_admin роля. */
  function cancelChatAdminAction(): void {
    if (state.chatAdminActionBusy) return
    state.chatAdminActionConfirm = null
    render()
  }

  let chatAdminActionToastGeneration = 0

  async function confirmChatAdminAction(): Promise<void> {
    const pending = state.chatAdminActionConfirm
    if (!pending || state.chatAdminActionBusy) return

    state.chatAdminActionBusy = true
    render()

    const caller = pending.action === 'grant' ? options.onAdminGrantChatAdmin : options.onAdminRevokeChatAdmin
    const result = await caller?.(pending.profileId)

    state.chatAdminActionBusy = false
    state.chatAdminActionConfirm = null

    if (result?.ok) {
      state.chatAdminActionToast = {
        text: pending.action === 'grant' ? 'Потребителят вече е чат админ.' : 'Ролята чат админ е премахната.',
        ok: true,
      }
      if (state.profilePopupTargetRoleProfileId === pending.profileId) {
        state.profilePopupTargetRoleProfileId = null
        state.profilePopupTargetRole = null
      }
    } else {
      state.chatAdminActionToast = {
        text: result?.message ?? 'Действието не бе завършено.',
        ok: false,
      }
    }
    render()

    const toastGeneration = ++chatAdminActionToastGeneration
    setTimeout(() => {
      if (toastGeneration !== chatAdminActionToastGeneration) return
      state.chatAdminActionToast = null
      render()
    }, 3500)
  }

  function renderPopupOnly(): void {
    const authSession = options.getAuthSession?.() ?? null
    ensureProfilePopupTargetRoleLoaded()
    syncProfilePopup(
      {
        isOpen: state.profilePopupOpen,
        profile: state.profilePopupProfile ?? createLocalProfilePreview(state, authSession),
        canEdit: state.profilePopupCanEdit,
        isAdmin: isFullAdminAuthSession(authSession),
        friendshipAction: buildPopupFriendshipAction(),
        viewerIsFullAdmin: isFullAdminAuthSession(authSession),
        targetAccountRole: state.profilePopupTargetRole,
      },
      getPopupCallbacks(),
    )
  }

  function resetToLobby(): void {
    switchToLobby()
    render()
    void loadPlayerUnclaimedCount()
  }

  function openAuthModal(mode: Exclude<import('./renderLobbyScreen').LobbyAuthModalMode, 'closed'>): void {
    state.authModalMode = mode
    state.authErrorText = null
    render()
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

    if (message.type === 'pending_acceptance_notifications') {
      // Bootstrap on reconnect: replace entire list, dedup by friendshipId.
      const byId = new Map<string, typeof state.acceptanceNotifications[number]>()
      for (const n of message.notifications) {
        byId.set(n.friendshipId, n)
      }
      state.acceptanceNotifications = Array.from(byId.values())
      render()
      return true
    }

    if (message.type === 'friend_acceptance_notification_read') {
      // Multi-tab sync: another tab (or same tab) already marked this read — remove idempotently.
      state.acceptanceNotifications = state.acceptanceNotifications.filter(
        (n) => n.friendshipId !== message.friendshipId,
      )
      render()
      return true
    }

    if (message.type === 'friend_request_accepted') {
      // Live accept while online: add persistent notification and refresh friendships.
      const alreadyExists = state.acceptanceNotifications.some(
        (n) => n.friendshipId === message.friendshipId,
      )
      if (!alreadyExists) {
        state.acceptanceNotifications = [
          ...state.acceptanceNotifications,
          {
            friendshipId: message.friendshipId,
            fromProfileId: message.fromProfileId,
            fromDisplayName: message.fromDisplayName,
            fromAvatarUrl: message.fromAvatarUrl,
          },
        ]
      }
      // Update outgoingPending -> friends in local state without a full reload.
      if (state.friendships !== null) {
        const movedRelationship = state.friendships.outgoingPending.find(
          (r) => r.friendshipId === message.friendshipId,
        )
        if (movedRelationship) {
          state.friendships = {
            ...state.friendships,
            outgoingPending: state.friendships.outgoingPending.filter(
              (r) => r.friendshipId !== message.friendshipId,
            ),
            friends: [
              ...state.friendships.friends,
              { ...movedRelationship, status: 'accepted' as const, direction: 'accepted' as const },
            ],
          }
        }
      }
      render()
      return false // let main.ts also show the 4-second live popup
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

    if (message.type === 'friend_request_cancelled') {
      state.pendingFriendRequests = state.pendingFriendRequests.filter((r) => r.friendshipId !== message.friendshipId)
      if (state.friendships !== null) {
        state.friendships = {
          ...state.friendships,
          incomingPending: state.friendships.incomingPending.filter((r) => r.friendshipId !== message.friendshipId),
        }
      }
      render()
      return true
    }

    if (message.type === 'friend_request_rejected') {
      if (state.friendships !== null) {
        state.friendships = {
          ...state.friendships,
          outgoingPending: state.friendships.outgoingPending.filter(
            (r) => r.friendshipId !== message.friendshipId,
          ),
        }
      }
      render()
      return true
    }

    if (message.type === 'tournament_partner_invite_received') {
      const invite = message.invite
      const existingIndex = state.tournamentPartnerInvites.findIndex((i) => i.inviteId === invite.inviteId)
      if (existingIndex >= 0) {
        state.tournamentPartnerInvites = state.tournamentPartnerInvites.map((i) =>
          i.inviteId === invite.inviteId ? invite : i,
        )
      } else {
        state.tournamentPartnerInvites = [...state.tournamentPartnerInvites, invite]
      }
      state.tournamentPartnerInvites.sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      )
      render()
      return false
    }

    if (message.type === 'tournament_partner_invite_popup_dismissed') {
      state.tournamentPartnerInvites = state.tournamentPartnerInvites.map((invite) =>
        invite.inviteId === message.inviteId
          ? {
              ...invite,
              popupDismissedAt: message.popupDismissedAt,
              notificationReadAt: message.notificationReadAt,
            }
          : invite,
      )
      render()
      return false
    }

    if (message.type === 'tournament_partner_invite_resolved') {
      state.tournamentPartnerInvites = state.tournamentPartnerInvites.filter((invite) => invite.inviteId !== message.inviteId)
      if (state.currentScreen === 'tournament-detail' && state.tournamentDetailId === message.tournamentId) {
        void fetchTournamentDetail(message.tournamentId)
      }
      if (state.currentScreen === 'tournaments') {
        void refetchTournamentsList()
      }
      render()
      return false
    }

    if (message.type === 'tournament_match_assigned') {
      if (
        state.currentScreen === 'tournament-detail' &&
        state.tournamentDetailId === message.assignment.tournamentId
      ) {
        void fetchTournamentDetail(message.assignment.tournamentId)
      }
      if (state.currentScreen === 'tournaments') {
        void refetchTournamentsList()
      }
      return false
    }

    if (message.type === 'guest_trial_error') {
      // guest_trial_limit_reached е нормален state (лимитът е изчерпан), не unexpected
      // грешка — popup-ът трябва directно да превключи на exhausted state (heading +
      // "Създай профил"/"Вход"), без червен warning text. Другите reason-и
      // (invalid_stake, unavailable) остават реални грешки, показани в error лентата.
      const isNormalLimitReached = message.reason === 'guest_trial_limit_reached'
      state.guestTrialPopup = {
        ...state.guestTrialPopup,
        isSubmitting: false,
        errorText: isNormalLimitReached ? null : message.message,
        remaining: message.remaining,
        hasConfirmedStatus: true,
      }
      render()
      return true
    }

    if (message.type === 'guest_trial_status') {
      state.guestTrialPopup = {
        ...state.guestTrialPopup,
        gamesUsed: message.gamesUsed,
        remaining: message.remaining,
        maxGames: message.maxGames,
        hasConfirmedStatus: true,
      }
      render()
      return true
    }

    if (message.type === 'error') {
      if (state.currentScreen === 'private-rooms' || state.currentScreen === 'private-room-waiting') {
        // The waiting room bypasses normal lobby chrome (same as
        // matchmaking-room), so it never displays the generic
        // state.errorText toast — without this branch, a server-side
        // rejection (e.g. a race-lost "Запълни с ботове" attempt) would be
        // silently swallowed instead of shown in the waiting room's own
        // info banner.
        if (state.currentScreen === 'private-room-waiting') {
          state.privateRoomWaitingFillBotsLoading = false
        }
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
      state.serverQueuedPlayerPreviews = normalizeQueuedPlayerPreviews(message.queuedPlayerPreviews)
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
      if (message.queuedPlayerPreviews !== undefined) {
        state.serverQueuedPlayerPreviews = normalizeQueuedPlayerPreviews(message.queuedPlayerPreviews)
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
      state.serverQueuedPlayerPreviews = []

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

      if (state.guestTrialPopup.isOpen) {
        state.guestTrialPopup = {
          ...state.guestTrialPopup,
          isOpen: false,
          isSubmitting: false,
          errorText: null,
        }
      }

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

    if (message.type === 'lobby_chat_history') {
      // Merge с дедупликация по messageId — живо съобщение може вече да е
      // пристигнало (напр. през cross-instance poll-а) преди историята,
      // ако subscribe/insert са паднали в много тясен race прозорец.
      const freshIds = new Set(message.messages.map((m) => m.messageId))
      const minFreshSeq = message.messages.length > 0
        ? Math.min(...message.messages.map((m) => m.seq))
        : null

      // Reconnect/re-subscribe reconciliation: ако клиентско съобщение пада в
      // обхвата на свежата история (seq >= минималния в нея), но вече го НЯМА
      // там — значи е било изтрито от admin, докато сме били offline/не
      // абонирани. Без това то би останало "залепено" в изгледа завинаги
      // (само lobby_chat_message_deleted, пропуснат докато сме офлайн, не би
      // го премахнал). Съобщения ПРЕДИ обхвата на историята не се пипат —
      // за тях няма информация дали още съществуват.
      const keptExisting = minFreshSeq === null
        ? state.lobbyChatMessages
        : state.lobbyChatMessages.filter((m) => m.seq < minFreshSeq || freshIds.has(m.messageId))

      const keptExistingIds = new Set(keptExisting.map((m) => m.messageId))
      const newFromHistory = message.messages.filter((m) => !keptExistingIds.has(m.messageId))

      state.lobbyChatMessages = [...keptExisting, ...newFromHistory]
        .sort((a, b) => a.seq - b.seq)
        .slice(-LOBBY_CHAT_CLIENT_MAX_MESSAGES)
      render()
      return true
    }

    if (message.type === 'lobby_chat_message') {
      const alreadyHave = state.lobbyChatMessages.some((m) => m.messageId === message.messageId)
      if (!alreadyHave) {
        state.lobbyChatMessages = [
          ...state.lobbyChatMessages,
          {
            seq: message.seq,
            messageId: message.messageId,
            senderProfileId: message.senderProfileId,
            senderDisplayName: message.senderDisplayName,
            senderIsChatAdmin: message.senderIsChatAdmin,
            body: message.body,
            createdAt: message.createdAt,
          },
        ]
          .sort((a, b) => a.seq - b.seq)
          .slice(-LOBBY_CHAT_CLIENT_MAX_MESSAGES)
      }

      if (message.requestId !== undefined && message.requestId === state.lobbyChatPendingRequestId) {
        state.lobbyChatDraft = ''
        state.lobbyChatSending = false
        state.lobbyChatPendingRequestId = null
        state.lobbyChatErrorText = null
      }

      render()
      return true
    }

    if (message.type === 'lobby_chat_message_deleted') {
      state.lobbyChatMessages = state.lobbyChatMessages.filter((m) => m.messageId !== message.messageId)
      render()
      return true
    }

    if (message.type === 'lobby_chat_error') {
      if (message.requestId !== undefined && message.requestId === state.lobbyChatPendingRequestId) {
        state.lobbyChatSending = false
        state.lobbyChatPendingRequestId = null
      }
      state.lobbyChatErrorText = message.message
      render()
      return true
    }

    if (message.type === 'private_rooms_list') {
      state.privateRooms = message.rooms
      render()
      return true
    }

    if (message.type === 'private_room_updated') {
      const isNewRoom = state.myPrivateRoom?.id !== message.room.id
      state.myPrivateRoom = message.room
      state.currentScreen = 'private-room-waiting'
      if (isNewRoom) {
        state.privateRoomWaitingChatMessages = []
        state.privateRoomWaitingChatSubscribedRoomId = null
        state.privateRoomWaitingChatErrorText = null
        state.privateRoomWaitingFillBotsConfirmOpen = false
        state.privateRoomWaitingLeaveConfirmOpen = false
        // Avoid carrying a stale banner (e.g. "Домакинът затвори масата.")
        // from a previous room into a freshly (re)joined one.
        state.privateRoomInfoText = null
      }
      render()
      return true
    }

    if (message.type === 'private_room_left') {
      leavePrivateRoomWaitingScreen()
      state.myPrivateRoom = null
      state.currentScreen = 'private-rooms'
      render()
      return true
    }

    if (message.type === 'private_room_expired') {
      if (state.myPrivateRoom?.id === message.privateRoomId) {
        leavePrivateRoomWaitingScreen()
        state.myPrivateRoom = null
        state.currentScreen = 'private-rooms'
        state.privateRoomInfoText = 'Частната маса беше затворена, защото времето за изчакване изтече.'
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
        leavePrivateRoomWaitingScreen()
        state.myPrivateRoom = null
        state.currentScreen = 'private-rooms'
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
      leavePrivateRoomWaitingScreen()
      state.myPrivateRoom = null
      state.currentScreen = 'lobby'
      state.privateRoomsCreatePopupOpen = false
      state.privateRoomWaitingFillBotsLoading = false
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

    if (message.type === 'private_room_chat_history') {
      if (state.myPrivateRoom?.id === message.privateRoomId) {
        state.privateRoomWaitingChatMessages = message.messages
        render()
      }
      return true
    }

    if (message.type === 'private_room_chat_message') {
      if (state.myPrivateRoom?.id === message.privateRoomId) {
        const alreadyPresent = state.privateRoomWaitingChatMessages.some((m) => m.messageId === message.messageId)
        if (!alreadyPresent) {
          state.privateRoomWaitingChatMessages = [...state.privateRoomWaitingChatMessages, message]
        }
        if (message.requestId !== undefined && message.requestId === state.privateRoomWaitingChatPendingRequestId) {
          state.privateRoomWaitingChatSending = false
          state.privateRoomWaitingChatPendingRequestId = null
          state.privateRoomWaitingChatDraft = ''
        }
        render()
      }
      return true
    }

    if (message.type === 'private_room_chat_error') {
      if (message.requestId !== undefined && message.requestId === state.privateRoomWaitingChatPendingRequestId) {
        state.privateRoomWaitingChatSending = false
        state.privateRoomWaitingChatPendingRequestId = null
      }
      state.privateRoomWaitingChatErrorText = message.message
      render()
      return true
    }

    return false
  }

  function leavePrivateRoomWaitingScreen(): void {
    clearPrivateRoomCountdownLoop()
    if (state.myPrivateRoom !== null) {
      options.onPrivateRoomChatUnsubscribe?.(state.myPrivateRoom.id)
    }
    state.privateRoomWaitingChatMessages = []
    state.privateRoomWaitingChatSubscribedRoomId = null
    state.privateRoomWaitingChatDraft = ''
    state.privateRoomWaitingChatSending = false
    state.privateRoomWaitingChatPendingRequestId = null
    state.privateRoomWaitingChatErrorText = null
    state.privateRoomWaitingLeaveConfirmOpen = false
    state.privateRoomWaitingFillBotsConfirmOpen = false
    state.privateRoomWaitingFillBotsLoading = false
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
    const path = window.location.pathname
    applyRouteSeo(path)
    navigateFromPath(path)
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
      leaveAdminServerIfActive()
      stopWaitingRoomActivity()
      clearPrivateRoomCountdownLoop()
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
      } else {
        // Ако връзката падне между изпращане на съобщение в лайв чата и
        // получаване на потвърждение/грешка, lobbyChatSending би останал
        // "заклещен" true завинаги (никой lobby_chat_message/lobby_chat_error
        // не би пристигнал вече по тази връзка) — бутонът "изпрати" би
        // останал disabled дори след успешен reconnect. Нулираме тук, за да
        // може потребителят да опита пак; чернова текста НЕ се губи.
        state.lobbyChatSending = false
        state.lobbyChatPendingRequestId = null
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
    openAuthModal,
    suspendLobbyChatForActiveRoom,
    forceLobbyChatResubscribeIfOnLobbyScreen,
    resyncPrivateRoomMembershipIfWaiting,
    updateLobbyChatDraft,
    submitLobbyChatMessage,
    refreshMissionsCount: () => { void loadPlayerUnclaimedCount() },
    refreshDailyRewardsStatus: () => { void loadDailyRewardsStatus() },
    removePendingFriendRequest: (friendshipId: string) => {
      state.pendingFriendRequests = state.pendingFriendRequests.filter((r) => r.friendshipId !== friendshipId)
      render()
    },
    getPendingFriendRequest: (friendshipId: string) => {
      const pendingRequest = state.pendingFriendRequests.find((r) => r.friendshipId === friendshipId)
      if (pendingRequest) {
        return pendingRequest
      }

      const incomingRelationship = state.friendships?.incomingPending.find((r) => r.friendshipId === friendshipId)
      if (!incomingRelationship) {
        return undefined
      }

      return {
        friendshipId: incomingRelationship.friendshipId,
        fromProfileId: incomingRelationship.profile.profileId ?? '',
        fromDisplayName: incomingRelationship.profile.displayName,
        fromAvatarUrl: incomingRelationship.profile.avatarUrl,
      }
    },
    isConversationOpen: (friendshipId: string) => {
      return state.currentScreen === 'chat' && state.activeChatFriendshipId === friendshipId
    },
    openChatWithFriend: (friendshipId: string) => {
      void showChatPanel().then(() => {
        void openChatConversation(friendshipId)
        void options.onChatMarkRead?.(friendshipId)
      })
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
          state.supportUnreadCount = result.supportUnreadCount ?? result.unreadCount
          state.adminGuestContactUnreadCount = result.guestUnreadCount ?? 0
          const totalUnread = state.supportUnreadCount + state.adminGuestContactUnreadCount
          const badge = options.root.querySelector<HTMLElement>('[data-support-unread-badge="1"]')
          if (badge) {
            badge.style.display = totalUnread > 0 ? 'flex' : 'none'
            badge.textContent = totalUnread > 0 ? String(totalUnread) : ''
          } else {
            render()
          }
        }
      })()
    },
    handleServerMessage,
    getPwaUpdateSafetySnapshot: () => ({
      isSearching: state.isSearching,
      hasPrivateRoomInvite: state.privateRoomInvite !== null,
      hasQueuedPrivateRoomInvites: state.privateRoomInviteQueue.length > 0,
      isInPrivateRoomsScreen: state.currentScreen === 'private-rooms',
      isConnected: state.isConnected,
    }),
    setAdminMonitoringSnapshot: (snapshot) => {
      state.adminMonitoringSnapshot = snapshot
      state.adminMonitoringErrorText = null
      if (state.currentScreen === 'admin-server') render()
    },
    setAdminMonitoringError: (message) => {
      state.adminMonitoringErrorText = message
      if (state.currentScreen === 'admin-server') render()
    },
    forceLeaveAdminScreenForbidden,
    setAdminHistoryLoading: (loading) => {
      state.adminHistoryLoading = loading
      if (state.currentScreen === 'admin-server') render()
    },
    setAdminHistoryResult: (result) => {
      state.adminHistoryWindow = result.window
      state.adminHistoryResult = result
      state.adminHistoryLoading = false
      state.adminHistoryErrorText = null
      if (state.currentScreen === 'admin-server') render()
    },
    setAdminHistoryError: (message) => {
      state.adminHistoryErrorText = message
      state.adminHistoryLoading = false
      if (state.currentScreen === 'admin-server') render()
    },
    setAdminWsConnections: (result) => {
      state.adminWsConnections = result
      if (state.currentScreen === 'admin-server') render()
    },
    navigateInitialPath: () => {
      _navigationReady = true
      applyRouteSeo(_loadPath || '/lobby')
      const isKnownPath = !!PATH_TO_SCREEN[_loadPath] || /^\/admin\/payments\/[^/]+$/.test(_loadPath) || /^\/admin\/tournaments\/[^/]+$/.test(_loadPath) || /^\/tournaments\/[^/]+$/.test(_loadPath)
      if (!_loadPath || !isKnownPath) return
      if (state.isConnected) {
        navigateFromPath(_loadPath)
      } else {
        _pendingInitialNav = true
      }
    },
    navigateAdminVisitors: (period?: string) => {
      const qs = new URLSearchParams(window.location.search)
      const p = period ?? qs.get('period') ?? undefined
      const v = qs.get('view') ?? undefined
      const d = qs.get('device') ?? undefined
      const t = qs.get('type') ?? undefined
      const o = qs.get('os') ?? undefined
      showAdminVisitorsPanel(p, v, d, t, o)
    },
    navigateAdminInfo: () => {
      void showAdminInfoPanel()
    },
    navigateAdminPayments: (period?: string) => {
      const qs = new URLSearchParams(window.location.search)
      const p = period ?? qs.get('period') ?? undefined
      showAdminPaymentsPanel(p)
    },
    navigateAdminPaymentDetail: (purchaseId: string) => {
      showAdminPaymentDetailPanel(purchaseId)
    },
    navigateToPrivateRooms: () => {
      state.currentScreen = 'private-rooms'
      state.privateRoomInfoText = null
      state.privateRoomsTab = 'all'
      options.onPrivateRoomsOpen?.()
      render()
    },
    navigateToTournamentDetail: (tournamentId: string) => {
      showTournamentDetail(tournamentId)
    },
    refreshPendingTournamentPartnerInvites: () => refetchPendingTournamentPartnerInvites(),
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
