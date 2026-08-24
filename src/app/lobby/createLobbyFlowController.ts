import { formatGiftLimitError } from './formatGiftLimitError'
import { OFFICIAL_PIKA_PROFILE_ID } from './profileDisplayNameValidation'
import { decideOpenImageViewer, decideRequestImageViewerClose, decideHandlePopstate, type ImageViewerAction, type ImageViewerHistoryState } from './imageViewerHistoryState'
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
import type { PrivateRoomInviteEligibleFriend } from './privateRoomPopupMarkup'
import { formatTournamentStartCountdown, formatTournamentFillExpiryCountdown } from './renderTournamentsScreen'
import { showStakeDeductionEffect } from '../activeRoom/renderStakeDeductionEffect'
import {
  renderLobbyScreen,
  formatNotificationBadgeCount,
  releaseLobbyChatBodyScrollLock,
  resolveLobbyChatSenderRole,
  syncProfilePopup,
  clearProfileEditorPendingState,
  appendTopicMessageNode,
  refreshTopicsUnreadDom,
  refreshTopicMessageLikeDom,
  refreshTopicMessageContentDom,
  removeTopicMessageDom,
  type TopicMessageNodeCallbacks,
  type AvatarCropSelection,
  type GuestContactFormInput,
  type LobbyAuthModalMode,
  type LobbyScreenState,
  type ProfilePopupCallbacks,
} from './renderLobbyScreen'
import type { PlayerAccountRole } from '../../ui/overlays/renderPlayerProfilePopup'
import type { GuestTrialPopupState } from './renderGuestTrialPopup'
import type { VipPurchaseSuccessPopupState } from './renderVipPurchaseSuccessPopup'
import type { GuestLockedStakePopupState } from './renderGuestLockedStakePopup'
import type { LevelLockedStakePopupState } from './renderLevelLockedStakePopup'
import {
  computeShopResumeConfirmOpen,
  computeShopPurchaseConfirmDispatch,
} from './shopResumeConfirmState'
import { createDebouncedPlayerSearch } from './createDebouncedPlayerSearch'
import { formatTopicsSectionMuteErrorText, LAFCHE_TOPIC_ID, LAFCHE_MESSAGE_HISTORY_LIMIT } from './renderTopicsScreen'
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
  VipPackageSnapshot,
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
  PrivateRoomMatchSnapshot,
  RoomSeatSnapshot,
  ServerMessage,
  Team,
  GuestContactMessageListItem,
  SupportMessageSnapshot,
  SupportConversationSnapshot,
  TournamentCreateInput,
  TournamentDetailSnapshot,
  TournamentPartnerCandidateSnapshot,
  TournamentPartnerInviteSnapshot,
  TournamentSummarySnapshot,
  TopicSnapshot,
  TopicMessageSnapshot,
  TopicReplySnapshot,
  TopicLockSnapshot,
  TopicMuteSnapshot,
  TopicReportSnapshot,
  TopicReportStatus,
  TopicMuteEvidenceSelfEntry,
  TopicMuteEvidenceModeratorEntry,
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
  | 'topics'
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

export type ProfileAccessBlockCode = 'profile_blocked_by_viewer' | 'profile_blocked_viewer'
type ProfilePopupContext = 'topics' | 'other'

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
 * "Публикации от Pika.bg" — показва бутона "(×)" за изтриване на публикации.
 * Само UX — сървърът презаверява това право на всяко DELETE през
 * isPikaAnnouncementAuthorSession (виж authStore.ts). Умишлено по-тесен от
 * старото поведение (admin/subadmin/chat_admin/pika_team/top_chat_admin) —
 * виж §3 в "Публикации от Pika.bg" брифа.
 */
function isPikaAnnouncementAuthorAuthSession(session: LobbyAuthSession | null): boolean {
  return session !== null && (
    session.account.role === 'admin'
    || session.account.role === 'pika_team'
  )
}

/**
 * Individual message/reply moderation UI достъп (delete на ОТДЕЛНО root
 * съобщение или reply) — само UX, сървърът презаверява на всяко HTTP
 * moderation действие през isTopicMessageModeratorSession (authStore.ts).
 * Различен role set от isTopicModeratorAuthSession (той е за whole-topic
 * mute/reports/audit, 4 роли, БЕЗ chat_admin) — умишлено собствен predicate,
 * не reuse на isPikaAnnouncementAuthorAuthSession или друг lobby-chat
 * predicate (individual-message-moderation брифа §4).
 */
function isTopicMessageModeratorAuthSession(session: LobbyAuthSession | null): boolean {
  return session !== null && (
    session.account.role === 'admin'
    || session.account.role === 'subadmin'
    || session.account.role === 'top_chat_admin'
    || session.account.role === 'pika_team'
    || session.account.role === 'chat_admin'
  )
}

/**
 * Topics moderation UI достъп (mute/unmute/reports/audit) — само UX,
 * сървърът презаверява на всяко HTTP moderation действие през
 * isTopicModeratorSession (authStore.ts). Изрично БЕЗ chat_admin — Topics
 * moderation е отделен permission set от lobby chat moderation. НЕ ползвай
 * за whole-topic lock/unlock/delete контролите — виж
 * isTopicWholeTopicModeratorAuthSession по-долу (по-тесен permission set,
 * corrective pass брифа §A1/§A2).
 */
function isTopicModeratorAuthSession(session: LobbyAuthSession | null): boolean {
  return session !== null && (
    session.account.role === 'admin'
    || session.account.role === 'subadmin'
    || session.account.role === 'pika_team'
    || session.account.role === 'top_chat_admin'
  )
}

/**
 * "Лафче" (system Topics поток, topic_id='topic-lafche') delete+mute UI
 * достъп — само UX, сървърът презаверява през isLafcheModeratorSession
 * (authStore.ts) на всяко HTTP действие, branch-нат само за topic-lafche.
 * САМО admin/pika_team/top_chat_admin, изрично БЕЗ subadmin (за разлика от
 * isTopicModeratorAuthSession по-горе, който важи за General/user теми) —
 * "Лафче" брифа §6.
 */
function isLafcheModeratorAuthSession(session: LobbyAuthSession | null): boolean {
  return session !== null && (
    session.account.role === 'admin'
    || session.account.role === 'pika_team'
    || session.account.role === 'top_chat_admin'
  )
}

/**
 * "Лафче" individual-post delete UI достъп — само UX, сървърът презаверява
 * през isLafcheMessageDeleteModeratorSession (authStore.ts) на HTTP delete
 * действието. isLafcheModeratorAuthSession (mute+report, 3 роли) + chat_admin,
 * за delete parity с normal Topics individual-message moderation
 * (isTopicMessageModeratorAuthSession, вкл. chat_admin). Умишлено разделен
 * predicate — НЕ разширява isLafcheModeratorAuthSession самата, за да не
 * покаже mute/report контроли на chat_admin в Лафче.
 */
function isLafcheMessageDeleteModeratorAuthSession(session: LobbyAuthSession | null): boolean {
  return isLafcheModeratorAuthSession(session) || session?.account.role === 'chat_admin'
}

/**
 * Whole-topic destructive/control UI достъп (Lock/Unlock/Delete бутони) —
 * само UX, сървърът презаверява през isTopicWholeTopicModeratorSession
 * (authStore.ts). По-тесен от isTopicModeratorAuthSession — pika_team и
 * chat_admin виждат mute/report контроли, но НЕ тези.
 */
function isTopicWholeTopicModeratorAuthSession(session: LobbyAuthSession | null): boolean {
  return session !== null && (
    session.account.role === 'admin'
    || session.account.role === 'subadmin'
    || session.account.role === 'top_chat_admin'
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
  /**
   * Само за пълен admin — server-side проверката е authoritative (виж
   * handleAdminVipGrantRequest в server/src/index.ts); тук е само UI trigger.
   * Връща пълния, прясно enriched профил (не само activeUntil), за да може
   * updateEditedTargetProfile да презапише popup-а веднага, без reload.
   */
  onAdminGrantVip?: (
    targetProfileId: string,
    days: number,
  ) => Promise<{ ok: true; profile: PlayerPublicProfileSnapshot } | { ok: false; message: string }>
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
  onVipPackagesLoad?: () => Promise<
    | { ok: true; packages: VipPackageSnapshot[] }
    | { ok: false; message: string }
  >
  onVipPurchaseStart?: (packageId: string) => Promise<
    | { ok: true; message: string }
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
  onPikaSupportChatStart?: (recipientProfileId: string) => Promise<
    | { ok: true; friendshipId: string }
    | { ok: false; message: string }
  >
  // Атомарен start+send за ПЪРВОТО vip_dm съобщение (виж §4/§9 в task
  // spec-а) — заменя старото onVipDmChatStart (create-only, без съобщение),
  // за да не се създава vip_dm ред без изпратено съобщение.
  onVipDmFirstMessageSend?: (recipientProfileId: string, body: string, imageDataUrl: string | null) => Promise<
    | { ok: true; conversation: ChatConversationSnapshot; messages: ChatMessageSnapshot[]; newMessage?: ChatMessageSnapshot }
    | { ok: false; message: string; code?: 'blocked' | 'vip_required' | 'vip_counterpart_required' | 'self' | 'recipient_not_found' | 'conversation_not_found' | 'invalid_conversation_kind' | 'message_required' | 'topic_muted'; mutedUntil?: string; reason?: string }
  >
  onChatConversationsLoad?: (includeArchived?: boolean) => Promise<
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
  /** "Играещи"/"Приключили" табове — извиква се веднъж при first-open на всеки от двата (lazy load, не при "Чакащи"). */
  onPrivateGamesOpen?: () => void
  onPrivateRoomCreate?: (stake: MatchStake, isLocked: boolean, waitMinutes: 5 | 10 | 15 | 30) => void
  onPrivateRoomJoinSlot?: (privateRoomId: string, team: Team, slotIndex: 0 | 1) => void
  onPrivateRoomLeave?: () => void
  onPrivateRoomInvite?: (toProfiles: Array<{ profileId: string; displayName: string }>) => void
  onCancelPrivateRoomInvite?: (inviteId: string) => void
  onPrivateRoomInviteRespond?: (inviteId: string, accept: boolean) => void
  onPrivateRoomAddBot?: (team: Team) => void
  onPrivateRoomRemoveBot?: (team: Team) => void
  onPrivateRoomChatSubscribe?: (privateRoomId: string) => void
  onPrivateRoomChatUnsubscribe?: (privateRoomId: string) => void
  onPrivateRoomChatSend?: (privateRoomId: string, body: string, requestId?: string) => void
  onSupportMessagesLoad?: () => Promise<
    | { ok: true; messages: SupportMessageSnapshot[] }
    | { ok: false; message: string }
  >
  onSupportSend?: (body: string, imageDataUrl?: string | null) => Promise<
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
  onAdminSupportReply?: (profileId: string, body: string, imageDataUrl?: string | null) => Promise<
    | { ok: true; messages: SupportMessageSnapshot[] }
    | { ok: false; message: string }
  >
  onAdminSupportDeleteConversation?: (profileId: string) => Promise<{ ok: true } | { ok: false; message: string }>
  onSupportDeleteConversation?: () => Promise<{ ok: true } | { ok: false; message: string }>
  onAdminServerScreenEnter?: () => void
  onAdminServerScreenLeave?: () => void
  initialPrivateRoomInGameNotificationsEnabled?: boolean
  onPrivateRoomInGameNotificationsChange?: (enabled: boolean) => void
  initialPrivateRoomCreatedSoundEnabled?: boolean
  onPrivateRoomCreatedSoundChange?: (enabled: boolean) => void
  /** GET текуща роля на профил (само за пълен admin viewer) — за "Субадмин"/"Чат админ" бадж в профилния попъп. */
  onAdminGetTargetRole?: (
    profileId: string,
  ) => Promise<{ ok: true; role: PlayerAccountRole | null } | { ok: false; message: string }>
  /** GET VIP статус на СОБСТВЕНИЯ логнат профил — за "VIP до [дата]" в профилния попъп, само когато е own profile. */
  onGetOwnVipStatus?: () => Promise<{ ok: true; activeUntil: string | null } | { ok: false }>
  onAdminGrantSubadmin?: (profileId: string) => Promise<{ ok: true } | { ok: false; message: string }>
  onAdminRevokeSubadmin?: (profileId: string) => Promise<{ ok: true } | { ok: false; message: string }>
  onAdminGrantChatAdmin?: (profileId: string) => Promise<{ ok: true } | { ok: false; message: string }>
  onAdminRevokeChatAdmin?: (profileId: string) => Promise<{ ok: true } | { ok: false; message: string }>
  onAdminGrantPikaTeam?: (profileId: string) => Promise<{ ok: true } | { ok: false; message: string }>
  onAdminRevokePikaTeam?: (profileId: string) => Promise<{ ok: true } | { ok: false; message: string }>
  onAdminGrantTopChatAdmin?: (profileId: string) => Promise<{ ok: true } | { ok: false; message: string }>
  onAdminRevokeTopChatAdmin?: (profileId: string) => Promise<{ ok: true } | { ok: false; message: string }>
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
  onTopicsLoad?: () => Promise<
    | { ok: true; topics: TopicSnapshot[]; viewerSectionMute: { isMuted: boolean; mutedUntil: string | null; reason: string | null } | null }
    | { ok: false; message: string }
  >
  onTopicMarkSeen?: (topicId: string) => Promise<
    | { ok: true; lastSeenSeq: number; unreadCount: number }
    | { ok: false; message: string }
  >
  onTopicThreadMarkSeen?: (topicId: string, rootMessageId: string) => Promise<
    | { ok: true; lastSeenSeq: number; unreadCount: number; topicUnreadCount: number }
    | { ok: false; message: string }
  >
  /** Canonical single-profile fetch по id — за profile popup, когато профилът не е (или може да е остарял) в state.players кеша. */
  onProfileByIdLoad?: (profileId: string) => Promise<
    | { ok: true; profile: PlayerPublicProfileSnapshot }
    | { ok: false; message: string; code?: ProfileAccessBlockCode }
  >
  /** beforeSeq=null → последните N съобщения; иначе → по-стари от beforeSeq (cursor pagination). */
  onTopicMessagesLoad?: (topicId: string, beforeSeq: number | null) => Promise<
    | { ok: true; messages: TopicMessageSnapshot[]; hasMore: boolean; oldestSeq: number | null }
    | { ok: false; message: string }
  >
  /**
   * Gap-closing WS subscribe (Етап 2 корекция т.1) — извиква се ЕДИНСТВЕНО
   * след успешен REST load, с afterSeq = последния познат seq за тази тема
   * (0 за тема без позната история). Никога subscribe без cursor.
   */
  onTopicMessagesSubscribe?: (topicId: string, afterSeq: number) => void
  onTopicMessagesUnsubscribe?: (topicId: string) => void
  /** requestId се генерира от контролера (не от викащия) — служи само за ack correlation, виж Етап 2 брифа т.7. imageDataUrl опционален — Attachment feature, reuse на СЪЩИЯ data-URL pipeline като friend chat. */
  onTopicMessageSend?: (topicId: string, body: string, requestId: string, imageDataUrl?: string) => void
  /** afterSeq=null → първите N replies; иначе → следващи от afterSeq (forward cursor, "Покажи още"). Етап 3. */
  onTopicRepliesLoad?: (topicId: string, rootMessageId: string, afterSeq: number | null) => Promise<
    | { ok: true; replies: TopicReplySnapshot[]; hasMore: boolean; oldestSeq: number | null; deletedMessageIds?: string[] }
    | { ok: false; message: string }
  >
  onTopicReplySend?: (topicId: string, parentMessageId: string, body: string, requestId: string, imageDataUrl?: string) => void
  onTopicMessageLikeToggle?: (messageId: string, requestId: string) => void
  /** requestId се генерира от контролера — fire-and-forget correlation (mirror на onTopicMessageSend), popup lifecycle-ът се управлява от matching topic_created/topic_create_error push, не Promise resolution. */
  onTopicCreateSubmit?: (title: string, requestId: string) => void
  /** Directory-wide "нова тема се появи" interest — subscribe при вход в Topics директорията, unsubscribe при напускане (mirror на onLobbyChatSubscribe/onLobbyChatUnsubscribe). */
  onTopicsDirectorySubscribe?: () => void
  onTopicsDirectoryUnsubscribe?: () => void
  // ─── Moderation (Етап 4) ─────────────────────────────────────────────────
  onTopicLock?: (topicId: string, reason: string, durationMs: number) => Promise<
    | { ok: true; lock: TopicLockSnapshot }
    | { ok: false; message: string }
  >
  onTopicUnlock?: (topicId: string) => Promise<
    | { ok: true; lock: TopicLockSnapshot }
    | { ok: false; message: string }
  >
  onTopicMuteStatusLoad?: (topicId: string, profileId: string) => Promise<
    | { ok: true; mute: TopicMuteSnapshot }
    | { ok: false; message: string }
  >
  /** Собствената "моята история" на потребителя (mute-evidence брифа §6) — profileId идва от сесията server-side, никога параметър тук. */
  onTopicMuteHistoryLoad?: () => Promise<
    | { ok: true; entries: TopicMuteEvidenceSelfEntry[] }
    | { ok: false; message: string }
  >
  /** Internal/moderator история на конкретен профил (mute-evidence брифа §7) — носи moderator identity, reuse-ва isTopicModeratorSession достъпа. */
  onTopicMuteHistoryLoadForProfile?: (profileId: string) => Promise<
    | { ok: true; entries: TopicMuteEvidenceModeratorEntry[] }
    | { ok: false; message: string }
  >
  onTopicMuteProfile?: (
    topicId: string,
    profileId: string,
    reason: string,
    durationMs: number,
    sourceMessageId: string | null,
    sourceKind: 'lafche_post' | 'topic_root' | 'topic_reply' | 'unspecified',
    reasonCategory: 'insults' | 'provocation' | 'spam' | 'inappropriate_content' | 'other' | null,
  ) => Promise<
    | { ok: true; mute: TopicMuteSnapshot }
    | { ok: false; message: string }
  >
  onTopicUnmuteProfile?: (topicId: string, profileId: string) => Promise<
    | { ok: true }
    | { ok: false; message: string }
  >
  onTopicDelete?: (topicId: string, reason: string) => Promise<
    | { ok: true }
    | { ok: false; message: string }
  >
  onTopicMessageDelete?: (topicId: string, messageId: string) => Promise<
    | { ok: true }
    | { ok: false; message: string }
  >
  onTopicMessageEdit?: (topicId: string, messageId: string, body: string) => Promise<
    | { ok: true; body: string; editedAt: string | null; changed: boolean; parentMessageId: string | null }
    | { ok: false; code?: string; message: string }
  >
  onTopicReport?: (topicId: string, reason: string) => Promise<
    | { ok: true }
    | { ok: false; code?: string; message: string }
  >
  onTopicReportsLoad?: (status: TopicReportStatus | null) => Promise<
    | { ok: true; reports: TopicReportSnapshot[]; pendingCount: number }
    | { ok: false; message: string }
  >
  onTopicReportReview?: (reportId: string, status: 'reviewed' | 'dismissed') => Promise<
    | { ok: true; report: TopicReportSnapshot }
    | { ok: false; message: string }
  >
  /** GET VIP gate статус (isActive + hasClaimedLaunchGift) за composer gating в "Теми" — отделно от onGetOwnVipStatus (profile popup use case). */
  onGetTopicsVipGateStatus?: () => Promise<
    | { ok: true; isActive: boolean; hasClaimedLaunchGift: boolean }
    | { ok: false }
  >
  onClaimTopicsLaunchGift?: () => Promise<
    | { ok: true; isActive: boolean; activeUntil?: string | null }
    | { ok: false; alreadyClaimed: boolean }
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
  setPrivateRoomInGameNotificationsEnabled: (value: boolean) => void
  setPrivateRoomCreatedSoundEnabled: (value: boolean) => void
  setFriendships: (value: FriendshipsSnapshot | null) => void
  setChatConversations: (value: ChatConversationSnapshot[]) => void
  refreshTopicsDirectoryMetadata: () => Promise<boolean>
  clearTopicsDirectoryMetadata: () => void
  startMatchmaking: (stake: MatchStake, displayName?: string) => void
  resetToLobby: () => void
  openAuthModal: (mode: Exclude<import('./renderLobbyScreen').LobbyAuthModalMode, 'closed'>) => void
  suspendLobbyChatForActiveRoom: () => void
  forceLobbyChatResubscribeIfOnLobbyScreen: () => void
  forceTopicMessagesResubscribeIfOnTopicsScreen: () => void
  forceTopicsDirectoryResubscribeIfOnTopicsScreen: () => void
  resyncPrivateRoomMembership: () => void
  joinPrivateRoom: (privateRoomId: string) => void
  updateLobbyChatDraft: (value: string) => void
  submitLobbyChatMessage: () => void
  refreshMissionsCount: () => void
  refreshDailyRewardsStatus: () => void
  refreshSupportUnread: () => void
  invalidateOwnVipStatus: () => void
  showVipPurchaseProcessingPopup: () => void
  showVipPurchaseSuccessPopup: (days: number, activeUntilLabel: string | null) => void
  showVipPurchaseDelayedPopup: () => void
  removePendingFriendRequest: (friendshipId: string) => void
  getPendingFriendRequest: (friendshipId: string) => { friendshipId: string; fromProfileId: string; fromDisplayName: string; fromAvatarUrl: string | null } | undefined
  isConversationOpen: (friendshipId: string) => boolean
  openChatWithFriend: (friendshipId: string) => void
  getFriendshipActionForProfile: (profileId: string) => import('../../ui/overlays/renderPlayerProfilePopup').PlayerProfileFriendshipAction | null
  handleServerMessage: (message: ServerMessage) => boolean
  navigateToShop: (noticeText: string | null) => void
  navigateToPrivateRooms: () => void
  navigateToTournamentDetail: (tournamentId: string) => void
  navigateToTopics: () => void
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
  profilePopupContext: ProfilePopupContext
  /** VIP изтичане на СОБСТВЕНИЯ профил на viewer-а — lazy-load само когато popup-ът показва own profile. null = все още не е зареден. */
  ownVipActiveUntil: string | null
  /** profileId, за който ownVipActiveUntil вече е (или се) зарежда — memoization guard, аналогично на profilePopupTargetRoleProfileId. */
  ownVipActiveUntilLoadedForProfileId: string | null
  topicsLoading: boolean
  topicsErrorText: string | null
  topics: TopicSnapshot[] | null
  topicsLoadedForProfileId: string | null
  activeTopicId: string | null
  topicsMode: 'topics' | 'thread' | 'personal'
  topicsPersonalView: 'list' | 'conversation'
  topicSeenInFlightByTopicId: Record<string, boolean | undefined>
  topicSeenQueuedByTopicId: Record<string, boolean | undefined>
  topicThreadSeenInFlightByRootId: Record<string, boolean | undefined>
  topicThreadSeenQueuedByRootId: Record<string, boolean | undefined>
  topicMessagesLoading: boolean
  topicMessagesErrorText: string | null
  topicMessages: TopicMessageSnapshot[] | null
  topicMessagesHasMore: boolean
  topicMessagesOldestSeq: number | null
  topicOlderMessagesLoading: boolean
  /**
   * Инкрементира се при ВСЯКО ново зареждане на message history (initial
   * open/topic switch/load older) — monotonic generation token. Само
   * topicId сравнение НЕ е достатъчно при rapid A→B→A превключване: третата
   * заявка (пак за A) може да resolve-не преди първата (също за A), която
   * все още виси — topicId guard-ът сам не би хванал това, защото и двете
   * заявки са "за текущата тема". Generation token различава кой отговор е
   * НАЙ-НОВИЯТ поискан, независимо от коя тема е.
   */
  topicMessagesRequestGeneration: number
  /** Последният ПОЗНАТ seq за темата (от REST load + WS live push) — gap-closing cursor за subscribe (Етап 2 корекция т.1/т.8), keyed по topicId, НЕ единичен scalar. */
  topicMessagesLatestKnownSeqByTopicId: Record<string, number>
  /** topicId, за който в момента ИМА активна WS subscription — null = никаква. Скалар (не Set), защото Topics UX показва точно една активна тема наведнъж. */
  topicMessagesSubscribedTopicId: string | null
  /**
   * Transient hint за renderLobbyScreen.ts кой scroll стратегия да ползва при
   * следващия render на message stream-а — консумира се и се нулира веднага
   * след render. 'initial' = jump to bottom; 'prepend' = запази distance-from-
   * bottom (load older); 'live-append'/'reconnect-refresh' = near-bottom
   * threshold (96px) преди насилствен scroll, огледално на lobby chat модела.
   */
  topicMessagesRenderReason: 'initial' | 'prepend' | 'live-append' | 'reconnect-refresh' | 'own-message' | 'reorder' | null
  topicMessagesScrollAnchor: { messageId: string; top: number } | null
  topicThreadRootMessageId: string | null
  topicThreadReturnScrollAnchor: { messageId: string; top: number } | null
  topicThreadRenderReason: 'initial' | 'live-append' | 'own-reply' | null
  /** Draft текст per тема — потвърдено отклонение от flat-field конвенцията (lobbyChatDraft), защото Topics е genuinely multi-channel. */
  topicComposerDraftByTopicId: Record<string, string>
  /** pending requestId per тема, докато чакаме sever ack (echo/error) — null = нищо не се изпраща в момента за тази тема. */
  topicComposerPendingRequestIdByTopicId: Record<string, string | null>
  topicComposerErrorTextByTopicId: Record<string, string | null>
  /** Избрана (все още неизпратена) снимка за root composer-а, keyed по topicId — Attachment feature, reuse на СЪЩИЯ { file, previewUrl } shape като chatPendingImageByFriendshipId. */
  topicComposerPendingImageByTopicId: Record<string, { file: File; previewUrl: string } | undefined>

  // ─── Replies (Етап 3) ───────────────────────────────────────────────────
  /** Кои root съобщения имат отворен ("expanded") reply thread в момента. */
  topicExpandedReplyRootIds: string[]
  /** null = не е зареждано още за този root; [] = зареден, но празен списък. */
  topicRepliesByRootId: Record<string, TopicReplySnapshot[] | null>
  topicRepliesHasMoreByRootId: Record<string, boolean>
  topicRepliesLoadingByRootId: Record<string, boolean>
  /** Draft текст, keyed по rootMessageId (НЕ topicId) — изолира drafts на различни едновременно отворени reply composers. */
  topicReplyComposerDraftByRootId: Record<string, string>
  topicReplyComposerPendingRequestIdByRootId: Record<string, string | null>
  topicReplyComposerErrorTextByRootId: Record<string, string | null>
  /** Само ЕДИН inline reply composer отворен наведнъж — продуктово решение за опростен UX. */
  topicReplyComposerOpenRootId: string | null
  /** Избрана снимка за reply composer-а, keyed по rootMessageId — изолирана от root composer-a и от други едновременно отворени reply threads. */
  topicReplyComposerPendingImageByRootId: Record<string, { file: File; previewUrl: string } | undefined>

  // ─── Reusable in-app image viewer (lightbox) ────────────────────────────
  // Generален, feature-agnostic — reuse-ван и от Topics attachments, и от
  // friend chat (виж т.13 от Attachment брифа). null = затворен. Полетата
  // огледални на ImageViewerHistoryState (imageViewerHistoryState.ts) —
  // viewUrl/downloadUrl са display данни, historyPushed/closePending са
  // decision-logic state (виж пълния rationale там).
  imageViewer: { viewUrl: string; downloadUrl: string; historyPushed: boolean; closePending: boolean } | null

  // ─── Likes (Етап 3) ──────────────────────────────────────────────────────
  /** Override-натите likeCount/viewerHasLiked стойности — попълва се от WS/REST отговори, overwrite-ва каквото носи самия TopicMessageSnapshot/TopicReplySnapshot при render. */
  topicMessageLikeCountById: Record<string, number>
  topicMessageViewerHasLikedById: Record<string, boolean>
  /** pending requestId за optimistic toggle reconciliation — виж т.13 от Етап 3 плана. */
  topicMessageLikePendingRequestIdById: Record<string, string | null>
  /** VIP gate статус за "Теми" composer — null = все още не е зареден. */
  topicsVipGate: { isActive: boolean; hasClaimedLaunchGift: boolean } | null
  topicsVipGateLoading: boolean
  topicsVipPopupOpen: boolean
  topicsVipClaimSubmitting: boolean
  topicsVipClaimErrorText: string | null
  /** "Виж VIP плановете" inert съобщение (Етап 2 корекция т.5) — показва се inline в popup-а, без checkout/навигация. */
  topicsVipSeePlansMessageVisible: boolean
  /** UI polish pass — кратък "ще бъде налично скоро" toast за create-topic/like/reply (все още неимплементирани), огледално на subadminActionToast моделa. */
  topicsInfoToast: { text: string } | null
  topicsPersonalMessagePendingProfileId: string | null
  // Pending compose context за нов vip_dm БЕЗ persistent friendshipId —
  // виж §7 в task spec-а. Click на "Лично" вече НЕ вика backend веднага;
  // вместо това отваря detail/composer с recipient в този state. Само
  // първият успешен SEND (startVipDmFirstMessage) създава реален
  // friendshipId атомарно заедно със самото съобщение. Back/close просто
  // нулира това поле — 0 backend write, 0 DB row.
  topicsPersonalPendingRecipient: { profileId: string; displayName: string } | null

  // ─── Create Topic popup (Custom Topic Creation) ─────────────────────────
  /** Mirror на tournamentCreatePopupOpen lifecycle-а. */
  topicCreatePopupOpen: boolean
  topicCreateBusy: boolean
  topicCreateErrorText: string | null
  topicCreateTitleDraft: string
  /** requestId на текущата чакаща create_topic заявка — null = нищо не се чака. Fire-and-forget correlation (не Promise), виж submitTopicCreate. */
  topicCreatePendingRequestId: string | null
  /** true докато има активна WS subscription за topics directory (нова тема broadcast) — subscribe/unsubscribe lifecycle-ът е symmetric на topicMessagesSubscribedTopicId по-горе. */
  topicsDirectorySubscribed: boolean
  // ─── Topics Moderation (Етап 4) ──────────────────────────────────────────
  /** Текущ lock snapshot за активната тема — обновен от REST load-а И от realtime topic_lock_state_changed push. null докато не е зареден. */
  activeTopicLock: TopicLockSnapshot | null
  /** Текущ mute snapshot за viewer-а В активната тема — обновен от realtime topic_mute_state_changed push (target-only). null = не е muted (или все още не е известно). */
  activeTopicViewerMute: TopicMuteSnapshot | null
  /** Popup за активен section-wide mute (заменя стария постоянен inline композер текст) — виж evaluateTopicsSectionMutePopup/acknowledgeTopicsSectionMutePopup. Acknowledgement tracking-ът е чист closure-local, не е част от state-а (не се нуждае render layer-ът от него). */
  topicsSectionMutePopupOpen: boolean
  /** Discriminated popup state за lock/mute/unmute action — избор на duration + reason + потвърждение, огледално на subadminActionConfirm модела. 'unmute' е прост confirm (без duration/reason), отворен САМО след lazy-fetch потвърди active mute (виж openTopicMuteMenuForAuthor). */
  topicModerationActionPopup:
    | { kind: 'lock'; topicId: string; topicTitle: string }
    | {
        kind: 'mute'
        topicId: string
        targetProfileId: string
        targetDisplayName: string
        /** Post-ът, чийто mute бутон е бил натиснат — snapshot evidence context (Лафче mute-evidence брифа §1/§3). null = mute инициирано без конкретен пост (напр. бъдещ profile-popup entry point). */
        sourceMessageId: string | null
        sourceKind: 'lafche_post' | 'topic_root' | 'topic_reply' | 'unspecified'
      }
    | { kind: 'unmute'; topicId: string; targetProfileId: string; targetDisplayName: string; mutedUntil: string | null; reason: string | null }
    | null
  topicModerationActionDurationMs: number | null
  topicModerationActionReason: string
  /** Кратка reason category (опционален taxonomy, mute-evidence брифа §10) — reuse-ва reason free-text полето, не заменя го. */
  topicModerationActionReasonCategory: 'insults' | 'provocation' | 'spam' | 'inappropriate_content' | 'other' | null
  topicModerationActionBusy: boolean
  topicModerationActionErrorText: string | null
  /** Lazy mute-status fetch в прогрес (виж openTopicMuteMenuForAuthor) — disable-ва gear иконата, докато чакаме отговор. */
  topicMuteStatusLoadingProfileId: string | null
  /** "Моята история" popup (mute-evidence брифа §6) — виждан САМО от собствения профил на viewer-а, без moderator identity. */
  topicMuteHistoryPopupOpen: boolean
  topicMuteHistoryEntries: TopicMuteEvidenceSelfEntry[] | null
  topicMuteHistoryLoading: boolean
  topicMuteHistoryErrorText: string | null
  /** Internal/moderator "история на този профил" (mute-evidence брифа §7) — носи moderator identity, отваря се от mute/unmute popup-а на модератор. */
  topicMuteHistoryModeratorTargetProfileId: string | null
  topicMuteHistoryModeratorEntries: TopicMuteEvidenceModeratorEntry[] | null
  topicMuteHistoryModeratorLoading: boolean
  topicMuteHistoryModeratorErrorText: string | null
  /** Delete confirmation — отделен popup (различна форма от lock/mute: само reason, без duration), с explicit "потвърди" крачка срещу accidental single-click deletion. */
  topicDeleteConfirm: { topicId: string; topicTitle: string; step: 'reason' | 'confirm' } | null
  topicDeleteReason: string
  topicDeleteBusy: boolean
  topicDeleteErrorText: string | null
  /** Individual root съобщение/reply moderation delete confirm — single-step (без reason поле). */
  topicMessageDeleteConfirm: { topicId: string; messageId: string; isRoot: boolean; isModeratorAction: boolean } | null
  topicMessageDeleteBusy: boolean
  topicMessageDeleteErrorText: string | null
  topicMessageEdit: { topicId: string; messageId: string; draft: string } | null
  topicMessageEditBusy: boolean
  topicMessageEditErrorText: string | null
  /** Report popup — обикновен потребител докладва тема. */
  topicReportPopupOpen: boolean
  topicReportReason: string
  topicReportBusy: boolean
  topicReportErrorText: string | null
  topicReportSuccessToast: boolean
  /** Admin reports queue — компактен popup panel (не отделен screen/route), отворен от mail dropdown-a, виж renderAdminTopicReportsPanel. */
  adminTopicReportsPopupOpen: boolean
  adminTopicReportsLoading: boolean
  adminTopicReportsErrorText: string | null
  adminTopicReports: TopicReportSnapshot[] | null
  adminTopicReportsPendingCount: number
  adminTopicReportsFilter: TopicReportStatus | null
  adminTopicReportActionBusyId: string | null
  /**
   * Инкрементира се при всяко отваряне на profile popup чрез profileId (виж
   * onTopicMessageAuthorClick) — stale-response guard: ако потребителят
   * кликне бързо на профил A, после профил B, закъснелият canonical fetch
   * за A сравнява своя token срещу текущия и не прилага резултата, ако не
   * съвпада (потребителят вече гледа B).
   */
  profilePopupRequestToken: number
  /** Роля на разглеждания акаунт (само заредена/показана за пълен admin viewer). */
  profilePopupTargetRole: PlayerAccountRole | null
  /** profileId, за който profilePopupTargetRole вече е (или се) зарежда — memoization guard. */
  profilePopupTargetRoleProfileId: string | null
  subadminActionConfirm: { profileId: string; displayName: string; action: 'grant' | 'revoke'; previousRole?: 'chat_admin' | 'pika_team' | 'top_chat_admin' | null } | null
  subadminActionBusy: boolean
  subadminActionToast: { text: string; ok: boolean } | null
  chatAdminActionConfirm: { profileId: string; displayName: string; action: 'grant' | 'revoke'; previousRole?: 'subadmin' | 'pika_team' | 'top_chat_admin' | null } | null
  chatAdminActionBusy: boolean
  chatAdminActionToast: { text: string; ok: boolean } | null
  pikaTeamActionConfirm: { profileId: string; displayName: string; action: 'grant' | 'revoke'; previousRole?: 'subadmin' | 'chat_admin' | 'top_chat_admin' | null } | null
  pikaTeamActionBusy: boolean
  pikaTeamActionToast: { text: string; ok: boolean } | null
  topChatAdminActionConfirm: { profileId: string; displayName: string; action: 'grant' | 'revoke'; previousRole?: 'subadmin' | 'chat_admin' | 'pika_team' | null } | null
  topChatAdminActionBusy: boolean
  topChatAdminActionToast: { text: string; ok: boolean } | null
  /** "Дай VIP" inline grant форма в чужд profile popup — само за пълен admin. */
  vipGrantOpen: boolean
  vipGrantSubmitting: boolean
  vipGrantErrorText: string | null
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
  vipPurchaseSuccessPopup: VipPurchaseSuccessPopupState
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
  shopActiveTab: 'coins' | 'vip'
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
  vipPackages: VipPackageSnapshot[]
  vipPackagesLoading: boolean
  vipPackagesErrorText: string | null
  vipPurchaseActionPackageId: string | null
  vipPurchaseMessageText: string | null
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
  adminSettingsSuccessText: string | null
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
  // "Архивирани" — разговори без ново съобщение >12 месеца (виж
  // chatStore.isConversationArchived). Зареждат се lazy, само при клик на
  // ненатрапчивата "Архивирани" опция (toggleChatArchivedView) — не се
  // теглят автоматично с основния списък, за да не бави обичайното
  // зареждане на чат панела.
  chatShowArchived: boolean
  chatArchivedConversations: ChatConversationSnapshot[]
  chatArchivedLoading: boolean
  activeChatFriendshipId: string | null
  // Monotonic race guard за entry points, които правят pre-flight мрежов
  // hop ПРЕДИ да извикат openChatConversation (startPikaSupportChatAndOpen,
  // showTopicsPersonalChat, openChatWithFriend) — огледално на
  // topicMessagesRequestGeneration. Без него, по-бавен по-РАНО кликнат flow
  // може да resolve-не СЛЕД по-бърз по-КЪСНО кликнат flow и мълчаливо да
  // презапише activeChatFriendshipId с грешния разговор точно преди/по
  // време на съставяне на съобщение (production PIKABG X→Y cross-delivery).
  activeChatRequestGeneration: number
  chatMessages: ChatMessageSnapshot[]
  chatMessagesFriendshipId: string | null
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
  // "Публикации от Pika.bg" в лобито (отделен от chatConversations/
  // chatMessages по-горе — тези са за 1:1 личния чат от раздел "ЧАТ";
  // виж CLAUDE.md/задачата).
  lobbyChatMessages: LobbyChatMessageSnapshot[]
  lobbyChatSubscribed: boolean
  lobbyChatDraft: string
  lobbyChatSending: boolean
  lobbyChatPendingRequestId: string | null
  lobbyChatErrorText: string | null
  lobbyChatFullscreen: boolean
  lobbyChatWriteLockedPopupOpen: boolean
  notificationsOpen: boolean
  privateRoomInGameNotificationsEnabled: boolean
  privateRoomCreatedSoundEnabled: boolean
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
  // Чакащи/Играещи/Приключили — независим tab от privateRoomsTab (all/mine
  // филтъра вътре в "Чакащи"). Local UI state, persist-ва докато потребителят
  // стои на страницата, НЕ се reset-ва от realtime updates (виж §7 брифа).
  privateRoomsLifecycleTab: 'waiting' | 'playing' | 'finished'
  privateGamesPlaying: PrivateRoomMatchSnapshot[]
  privateGamesFinished: PrivateRoomMatchSnapshot[]
  privateGamesLoaded: boolean
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
  // Стаята, която текущо се преглежда — сетва се при клик на ред в списъка,
  // при invite-accept-confirmed, и при успешен join/reconnect-restore (за да
  // може leave→preview flow-ът винаги да знае коя стая да показва). Docs:
  // виж "Leave поведение (точка 6)" в плана за частните маси.
  previewedPrivateRoomId: string | null
  privateRoomJoinSlotPopup: { privateRoomId: string; team: Team; slotIndex: 0 | 1 } | null
  privateRoomLeaveSlotConfirmOpen: boolean
  privateRoomBlockedPopupText: string | null
  privateRoomBotActionLoadingTeam: Team | null
  // true за периода между "потребителят натисна create/join/приеми покана"
  // и сървърният отговор — вижте private_room_updated handler-а: force-
  // навигацията към чакалнята трябва да се случи само за ТОЗИ явен flow,
  // не и когато private_room_updated пристига пасивно (напр. reconnect
  // resync след reload, докато потребителят е избрал "Изчакай в лоби").
  privateRoomJoinInFlight: boolean
  privateRoomConflictPromptOpen: boolean
  // 'list-join' — потребителят натисна конкретен "+" на ДРУГА маса, докато
  // вече е седнал/има запазено място в своя собствена (openPrivateRoomListSlotJoinPopup)
  // — показва bespoke UX ("Вече сте седнал на друга маса" / "Виж масата").
  // 'generic' — трите други конфликтни точки (matchmaking search, create,
  // invite-accept) — непроменен споделен текст ("Вече чакаш в частна маса.").
  privateRoomConflictPromptVariant: 'generic' | 'list-join'
  inviteFriendsPopupOpen: boolean
  // Профили, поканени в ТЕКУЩАТА стая по време на тази сесия — client-side
  // optimistic tracking (сървърът не излага pendingInvites в
  // PrivateRoomSnapshot), само за "Изпратена" UI индикация. Нулира се при
  // всяка смяна на стаята (виж isNewRoom/leave/expired/closed handler-ите).
  // Сървърът си остава единствен authority срещу реален duplicate spam.
  privateRoomInvitedProfileIds: Set<string>
  blockedPlayersPopupOpen: boolean
  blockedPlayers: PlayerPublicProfileSnapshot[] | null
  blockedPlayersLoading: boolean
  blockedPlayersErrorText: string | null
  blockedPlayersLimit: number
  blockLimitPopupOpen: boolean
  profileAccessBlockPopup: { profileId: string; code: ProfileAccessBlockCode } | null
  noPlayersModalOpen: boolean
  supportPopupOpen: boolean
  supportMessages: SupportMessageSnapshot[]
  supportUnreadCount: number
  supportLoading: boolean
  supportSendingLoading: boolean
  supportErrorText: string | null
  supportDraft: string
  supportPendingImage: { file: File; previewUrl: string } | null
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
  adminSupportReplyErrorText: string | null
  adminSupportReplyDraftByProfileId: Record<string, string>
  adminSupportPendingImageByProfileId: Record<string, { file: File; previewUrl: string } | undefined>
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
// Синтетичен ключ за chatUploadingFriendshipIds/chatDraftByFriendshipId,
// докато pending vip_dm compose context (§7 в task spec-а) все още няма
// реален friendshipId — не може да се сблъска с истински UUID friendshipId.
const PENDING_VIP_DM_UPLOAD_KEY = '__pending_vip_dm__'

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
    profilePopupContext: 'other',
    ownVipActiveUntil: null,
    ownVipActiveUntilLoadedForProfileId: null,
    topicsLoading: false,
    topicsErrorText: null,
    topics: null,
    topicsLoadedForProfileId: null,
    activeTopicId: null,
    topicsMode: 'topics',
    topicsPersonalView: 'list',
    topicSeenInFlightByTopicId: {},
    topicSeenQueuedByTopicId: {},
    topicThreadSeenInFlightByRootId: {},
    topicThreadSeenQueuedByRootId: {},
    topicMessagesLoading: false,
    topicMessagesErrorText: null,
    topicMessages: null,
    topicMessagesHasMore: false,
    topicMessagesOldestSeq: null,
    topicOlderMessagesLoading: false,
    topicMessagesRequestGeneration: 0,
    topicMessagesLatestKnownSeqByTopicId: {},
    topicMessagesSubscribedTopicId: null,
    topicMessagesRenderReason: null,
    topicMessagesScrollAnchor: null,
    topicThreadRootMessageId: null,
    topicThreadReturnScrollAnchor: null,
    topicThreadRenderReason: null,
    topicComposerDraftByTopicId: {},
    topicComposerPendingRequestIdByTopicId: {},
    topicComposerErrorTextByTopicId: {},
    topicComposerPendingImageByTopicId: {},
    topicExpandedReplyRootIds: [],
    topicRepliesByRootId: {},
    topicRepliesHasMoreByRootId: {},
    topicRepliesLoadingByRootId: {},
    topicReplyComposerDraftByRootId: {},
    topicReplyComposerPendingRequestIdByRootId: {},
    topicReplyComposerErrorTextByRootId: {},
    topicReplyComposerOpenRootId: null,
    topicReplyComposerPendingImageByRootId: {},
    imageViewer: null,
    topicMessageLikeCountById: {},
    topicMessageViewerHasLikedById: {},
    topicMessageLikePendingRequestIdById: {},
    topicsVipGate: null,
    topicsVipGateLoading: false,
    topicsVipPopupOpen: false,
    topicsVipClaimSubmitting: false,
    topicsVipClaimErrorText: null,
    topicsVipSeePlansMessageVisible: false,
    topicsInfoToast: null,
    topicsPersonalMessagePendingProfileId: null,
    topicsPersonalPendingRecipient: null,
    topicCreatePopupOpen: false,
    topicCreateBusy: false,
    topicCreateErrorText: null,
    topicCreateTitleDraft: '',
    topicCreatePendingRequestId: null,
    topicsDirectorySubscribed: false,
    activeTopicLock: null,
    activeTopicViewerMute: null,
    topicsSectionMutePopupOpen: false,
    topicModerationActionPopup: null,
    topicModerationActionDurationMs: null,
    topicModerationActionReason: '',
    topicModerationActionReasonCategory: null,
    topicModerationActionBusy: false,
    topicModerationActionErrorText: null,
    topicMuteStatusLoadingProfileId: null,
    topicMuteHistoryPopupOpen: false,
    topicMuteHistoryEntries: null,
    topicMuteHistoryLoading: false,
    topicMuteHistoryErrorText: null,
    topicMuteHistoryModeratorTargetProfileId: null,
    topicMuteHistoryModeratorEntries: null,
    topicMuteHistoryModeratorLoading: false,
    topicMuteHistoryModeratorErrorText: null,
    topicDeleteConfirm: null,
    topicDeleteReason: '',
    topicDeleteBusy: false,
    topicDeleteErrorText: null,
    topicMessageDeleteConfirm: null,
    topicMessageDeleteBusy: false,
    topicMessageDeleteErrorText: null,
    topicMessageEdit: null,
    topicMessageEditBusy: false,
    topicMessageEditErrorText: null,
    topicReportPopupOpen: false,
    topicReportReason: '',
    topicReportBusy: false,
    topicReportErrorText: null,
    topicReportSuccessToast: false,
    adminTopicReportsPopupOpen: false,
    adminTopicReportsLoading: false,
    adminTopicReportsErrorText: null,
    adminTopicReports: null,
    adminTopicReportsPendingCount: 0,
    adminTopicReportsFilter: 'pending',
    adminTopicReportActionBusyId: null,
    profilePopupRequestToken: 0,
    profilePopupTargetRole: null,
    profilePopupTargetRoleProfileId: null,
    subadminActionConfirm: null,
    subadminActionBusy: false,
    subadminActionToast: null,
    chatAdminActionConfirm: null,
    chatAdminActionBusy: false,
    chatAdminActionToast: null,
    pikaTeamActionConfirm: null,
    pikaTeamActionBusy: false,
    pikaTeamActionToast: null,
    topChatAdminActionConfirm: null,
    topChatAdminActionBusy: false,
    topChatAdminActionToast: null,
    vipGrantOpen: false,
    vipGrantSubmitting: false,
    vipGrantErrorText: null,
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
    vipPurchaseSuccessPopup: {
      isOpen: false,
      phase: 'loading',
      days: 0,
      activeUntilLabel: null,
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
    shopActiveTab: 'coins',
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
    vipPackages: [],
    vipPackagesLoading: false,
    vipPackagesErrorText: null,
    vipPurchaseActionPackageId: null,
    vipPurchaseMessageText: null,
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
    adminSettingsSuccessText: null,
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
    chatShowArchived: false,
    chatArchivedConversations: [],
    chatArchivedLoading: false,
    activeChatFriendshipId: null,
    activeChatRequestGeneration: 0,
    chatMessages: [],
    chatMessagesFriendshipId: null,
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
    lobbyChatFullscreen: false,
    lobbyChatWriteLockedPopupOpen: false,
    notificationsOpen: false,
    privateRoomInGameNotificationsEnabled: true,
    privateRoomCreatedSoundEnabled: true,
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
    privateRoomsLifecycleTab: 'waiting',
    privateGamesPlaying: [],
    privateGamesFinished: [],
    privateGamesLoaded: false,
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
    previewedPrivateRoomId: null,
    privateRoomJoinSlotPopup: null,
    privateRoomLeaveSlotConfirmOpen: false,
    privateRoomBlockedPopupText: null,
    privateRoomBotActionLoadingTeam: null,
    privateRoomJoinInFlight: false,
    privateRoomConflictPromptOpen: false,
    privateRoomConflictPromptVariant: 'generic',
    inviteFriendsPopupOpen: false,
    privateRoomInvitedProfileIds: new Set(),
    blockedPlayersPopupOpen: false,
    blockedPlayers: null,
    blockedPlayersLoading: false,
    blockedPlayersErrorText: null,
    blockedPlayersLimit: 50,
    blockLimitPopupOpen: false,
    profileAccessBlockPopup: null,
    noPlayersModalOpen: false,
    supportPopupOpen: false,
    supportMessages: [],
    supportUnreadCount: 0,
    supportLoading: false,
    supportSendingLoading: false,
    supportErrorText: null,
    supportDraft: '',
    supportPendingImage: null,
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
    adminSupportReplyErrorText: null,
    adminSupportReplyDraftByProfileId: {},
    adminSupportPendingImageByProfileId: {},
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
    isVip: null,
    vipActiveUntil: null,
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
  state.privateRoomInGameNotificationsEnabled = options.initialPrivateRoomInGameNotificationsEnabled ?? true
  state.privateRoomCreatedSoundEnabled = options.initialPrivateRoomCreatedSoundEnabled ?? true
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

  // UI-само видимост на бутона "Чат" в profile popup-а — истинската защита
  // е server-side (chatStore.getOrCreatePikaSupportConversation отказва
  // всеки profileId, различен от configured official Pika.bg profileId).
  // Тук показваме бутона само когато ТЕКУЩИЯТ логнат профил е точно
  // OFFICIAL_PIKA_PROFILE_ID, popup-ът разглежда ЧУЖД регистриран профил
  // (не own, не guest — targetProfileId===null означава гост), и не сме в
  // "canEdit" (own-profile edit) режим.
  function shouldShowPikaSupportChatButton(authSession: LobbyAuthSession | null): boolean {
    const targetProfileId = state.profilePopupProfile?.profileId ?? null

    return (
      state.profilePopupOpen &&
      !state.profilePopupCanEdit &&
      authSession !== null &&
      authSession.profile.profileId === OFFICIAL_PIKA_PROFILE_ID &&
      targetProfileId !== null &&
      targetProfileId !== authSession.profile.profileId
    )
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

  // Pure snapshot builder — извлечена от renderLobby() (виж call site-а там)
  // за reuse и от targeted-patch пътищата (appendTopicMessageNode/
  // refreshTopicsUnreadDom, viж handleServerMessage topic_* handlers), които
  // се нуждаят от актуален LobbyScreenState snapshot, БЕЗ да предизвикват
  // страничните ефекти на renderLobby() (ensureProfilePopupTargetRoleLoaded/
  // ensureOwnVipStatusLoaded остават САМО в renderLobby(), не тук — targeted
  // patch не трябва да тригерва нови network заявки).
  function buildLobbyScreenState(): LobbyScreenState {
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
      // Established API origin resolver (main.ts getApiBaseUrl) — local dev
      // frontend :5173 + backend :3001 split origin, same-origin/proxy в
      // production (празен string). Reuse-ва СЪЩИЯ helper като options.apiBaseUrl
      // по-долу (renderLobbyScreen options), но тук е на state-а самия, защото
      // renderTopicsScreen(state)/renderChatAttachmentBubble(attachment) не
      // получават options — attachment view/download/viewer URL-ите трябва да
      // минат през него, за да не се resolve-ват спрямо Vite dev origin-а.
      apiBaseUrl: options.getApiBaseUrl?.() ?? '',
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
            : state.currentScreen === 'topics'
              ? 'topics'
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
      ownVipActiveUntil: state.ownVipActiveUntil,
      profilePopupTargetRole: state.profilePopupTargetRole,
      vipGrantOpen: state.vipGrantOpen,
      vipGrantSubmitting: state.vipGrantSubmitting,
      vipGrantErrorText: state.vipGrantErrorText,
      subadminActionConfirm: state.subadminActionConfirm,
      subadminActionBusy: state.subadminActionBusy,
      subadminActionToast: state.subadminActionToast,
      chatAdminActionConfirm: state.chatAdminActionConfirm,
      chatAdminActionBusy: state.chatAdminActionBusy,
      chatAdminActionToast: state.chatAdminActionToast,
      pikaTeamActionConfirm: state.pikaTeamActionConfirm,
      pikaTeamActionBusy: state.pikaTeamActionBusy,
      pikaTeamActionToast: state.pikaTeamActionToast,
      topChatAdminActionConfirm: state.topChatAdminActionConfirm,
      topChatAdminActionBusy: state.topChatAdminActionBusy,
      topChatAdminActionToast: state.topChatAdminActionToast,
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
      shopActiveTab: state.shopActiveTab,
      shopPackages: state.shopPackages,
      shopPackagesLoading: state.shopPackagesLoading,
      shopPackagesErrorText: state.shopPackagesErrorText,
      shopPurchases: state.shopPurchases,
      shopPurchasesVisible: state.shopPurchasesVisible,
      shopPurchasesLoading: state.shopPurchasesLoading,
      shopPurchaseConfirmPackageId: state.shopPurchaseConfirmPackageId,
      shopPurchaseActionPackageId: state.shopPurchaseActionPackageId,
      shopPurchaseMessageText: state.shopPurchaseMessageText,
      vipPackages: state.vipPackages,
      vipPackagesLoading: state.vipPackagesLoading,
      vipPackagesErrorText: state.vipPackagesErrorText,
      vipPurchaseActionPackageId: state.vipPurchaseActionPackageId,
      vipPurchaseMessageText: state.vipPurchaseMessageText,
      isAdmin: isFullAdminAuthSession(authSession),
      isAdminOrSubadmin: isAdminOrSubadminAuthSession(authSession),
      canDeleteLobbyChat: isPikaAnnouncementAuthorAuthSession(authSession),
      canWriteLobbyChat: isPikaAnnouncementAuthorAuthSession(authSession),
      lobbyChatWriteLockedPopupOpen: state.lobbyChatWriteLockedPopupOpen,
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
      adminSettingsSuccessText: state.adminSettingsSuccessText,
      adminCoinPackages: state.adminCoinPackages,
      adminCoinPackagesLoading: state.adminCoinPackagesLoading,
      adminCoinPackagesErrorText: state.adminCoinPackagesErrorText,
      adminCoinPackageEditId: state.adminCoinPackageEditId,
      friendships: state.friendships,
      friendsLoading: state.friendsLoading,
      friendsErrorText: state.friendsErrorText,
      friendshipAction,
      showPikaSupportChatButton: shouldShowPikaSupportChatButton(authSession),
      giftModalFriendshipId: state.giftModalFriendshipId,
      giftModalFriendName: state.giftModalFriendName,
      giftModalErrorText: state.giftModalErrorText,
      giftSuccessModal: state.giftSuccessModal,
      giftReceivedModal: state.giftReceivedModal,
      pendingGiftNotifications: state.pendingGiftNotifications,
      acceptanceNotifications: state.acceptanceNotifications,
      acceptanceErrorText: state.acceptanceErrorText,
      chatConversations: state.chatConversations,
      chatShowArchived: state.chatShowArchived,
      chatArchivedConversations: state.chatArchivedConversations,
      chatArchivedLoading: state.chatArchivedLoading,
      activeChatFriendshipId: state.activeChatFriendshipId,
      chatMessages: state.chatMessages,
      chatMessagesFriendshipId: state.chatMessagesFriendshipId,
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
      lobbyChatFullscreen: state.lobbyChatFullscreen,
      authModalMode: state.authModalMode,
      authErrorText: state.authErrorText,
      guestTrialPopup: state.guestTrialPopup,
      vipPurchaseSuccessPopup: state.vipPurchaseSuccessPopup,
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
      privateRoomInGameNotificationsEnabled: state.privateRoomInGameNotificationsEnabled,
      privateRoomCreatedSoundEnabled: state.privateRoomCreatedSoundEnabled,
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
      privateRoomsLifecycleTab: state.privateRoomsLifecycleTab,
      privateGamesPlaying: state.privateGamesPlaying,
      privateGamesFinished: state.privateGamesFinished,
      privateRoomInvite: state.privateRoomInvite,
      privateRoomInviteQueue: state.privateRoomInviteQueue,
      privateRoomInfoText: state.privateRoomInfoText,
      privateRoomConflictPromptOpen: state.privateRoomConflictPromptOpen,
      privateRoomConflictPromptVariant: state.privateRoomConflictPromptVariant,
      privateRoomJoinSlotPopup: state.privateRoomJoinSlotPopup,
      privateRoomBlockedPopupText: state.privateRoomBlockedPopupText,
      inviteFriendsPopupOpen: state.inviteFriendsPopupOpen,
      inviteFriends: resolveInviteEligibleFriends(),
      blockedPlayersPopupOpen: state.blockedPlayersPopupOpen,
      blockedPlayers: state.blockedPlayers,
      blockedPlayersLoading: state.blockedPlayersLoading,
      blockedPlayersErrorText: state.blockedPlayersErrorText,
      blockedPlayersLimit: state.blockedPlayersLimit,
      blockLimitPopupOpen: state.blockLimitPopupOpen,
      profileAccessBlockPopup: state.profileAccessBlockPopup,
      noPlayersModalOpen: state.noPlayersModalOpen,
      isInGame: options.getIsInGame?.() ?? false,
      supportPopupOpen: state.supportPopupOpen,
      supportMessages: state.supportMessages,
      supportUnreadCount: state.supportUnreadCount,
      supportLoading: state.supportLoading,
      supportSendingLoading: state.supportSendingLoading,
      supportErrorText: state.supportErrorText,
      supportDraft: state.supportDraft,
      supportPendingImage: state.supportPendingImage,
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
      adminSupportReplyErrorText: state.adminSupportReplyErrorText,
      adminSupportReplyDraftByProfileId: state.adminSupportReplyDraftByProfileId,
      adminSupportPendingImageByProfileId: state.adminSupportPendingImageByProfileId,
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
      topicsLoading: state.topicsLoading,
      topicsErrorText: state.topicsErrorText,
      topics: state.topics,
      activeTopicId: state.activeTopicId,
      topicsMode: state.topicsMode,
      topicsPersonalView: state.topicsPersonalView,
      topicMessagesLoading: state.topicMessagesLoading,
      topicMessagesErrorText: state.topicMessagesErrorText,
      topicMessages: state.topicMessages,
      topicMessagesHasMore: state.topicMessagesHasMore,
      topicMessagesOldestSeq: state.topicMessagesOldestSeq,
      topicOlderMessagesLoading: state.topicOlderMessagesLoading,
      topicMessagesRenderReason: state.topicMessagesRenderReason,
      topicMessagesScrollAnchor: state.topicMessagesScrollAnchor,
      topicThreadRootMessageId: state.topicThreadRootMessageId,
      topicThreadReturnScrollAnchor: state.topicThreadReturnScrollAnchor,
      topicThreadRenderReason: state.topicThreadRenderReason,
      topicComposerDraftByTopicId: state.topicComposerDraftByTopicId,
      topicComposerPendingRequestIdByTopicId: state.topicComposerPendingRequestIdByTopicId,
      topicComposerErrorTextByTopicId: state.topicComposerErrorTextByTopicId,
      topicComposerPendingImageByTopicId: state.topicComposerPendingImageByTopicId,
      topicExpandedReplyRootIds: state.topicExpandedReplyRootIds,
      topicRepliesByRootId: state.topicRepliesByRootId,
      topicRepliesHasMoreByRootId: state.topicRepliesHasMoreByRootId,
      topicRepliesLoadingByRootId: state.topicRepliesLoadingByRootId,
      topicReplyComposerDraftByRootId: state.topicReplyComposerDraftByRootId,
      topicReplyComposerPendingRequestIdByRootId: state.topicReplyComposerPendingRequestIdByRootId,
      topicReplyComposerErrorTextByRootId: state.topicReplyComposerErrorTextByRootId,
      topicReplyComposerOpenRootId: state.topicReplyComposerOpenRootId,
      topicReplyComposerPendingImageByRootId: state.topicReplyComposerPendingImageByRootId,
      imageViewer: state.imageViewer,
      topicMessageLikeCountById: state.topicMessageLikeCountById,
      topicMessageViewerHasLikedById: state.topicMessageViewerHasLikedById,
      topicMessageLikePendingRequestIdById: state.topicMessageLikePendingRequestIdById,
      topicsVipGate: state.topicsVipGate,
      topicsVipGateLoading: state.topicsVipGateLoading,
      topicsVipPopupOpen: state.topicsVipPopupOpen,
      topicsVipClaimSubmitting: state.topicsVipClaimSubmitting,
      topicsVipClaimErrorText: state.topicsVipClaimErrorText,
      topicsVipSeePlansMessageVisible: state.topicsVipSeePlansMessageVisible,
      topicsInfoToast: state.topicsInfoToast,
      topicsPersonalMessagePendingProfileId: state.topicsPersonalMessagePendingProfileId,
      topicsPersonalPendingRecipient: state.topicsPersonalPendingRecipient,
      topicCreatePopupOpen: state.topicCreatePopupOpen,
      topicCreateBusy: state.topicCreateBusy,
      topicCreateErrorText: state.topicCreateErrorText,
      topicCreateTitleDraft: state.topicCreateTitleDraft,
      activeTopicLock: state.activeTopicLock,
      activeTopicViewerMute: state.activeTopicViewerMute,
      topicsSectionMutePopupOpen: state.topicsSectionMutePopupOpen,
      topicModerationActionPopup: state.topicModerationActionPopup,
      topicModerationActionDurationMs: state.topicModerationActionDurationMs,
      topicModerationActionReason: state.topicModerationActionReason,
      topicModerationActionReasonCategory: state.topicModerationActionReasonCategory,
      topicModerationActionBusy: state.topicModerationActionBusy,
      topicModerationActionErrorText: state.topicModerationActionErrorText,
      topicMuteStatusLoadingProfileId: state.topicMuteStatusLoadingProfileId,
      topicMuteHistoryPopupOpen: state.topicMuteHistoryPopupOpen,
      topicMuteHistoryEntries: state.topicMuteHistoryEntries,
      topicMuteHistoryLoading: state.topicMuteHistoryLoading,
      topicMuteHistoryErrorText: state.topicMuteHistoryErrorText,
      topicMuteHistoryModeratorTargetProfileId: state.topicMuteHistoryModeratorTargetProfileId,
      topicMuteHistoryModeratorEntries: state.topicMuteHistoryModeratorEntries,
      topicMuteHistoryModeratorLoading: state.topicMuteHistoryModeratorLoading,
      topicMuteHistoryModeratorErrorText: state.topicMuteHistoryModeratorErrorText,
      topicDeleteConfirm: state.topicDeleteConfirm,
      topicDeleteReason: state.topicDeleteReason,
      topicDeleteBusy: state.topicDeleteBusy,
      topicDeleteErrorText: state.topicDeleteErrorText,
      topicMessageDeleteConfirm: state.topicMessageDeleteConfirm,
      topicMessageDeleteBusy: state.topicMessageDeleteBusy,
      topicMessageDeleteErrorText: state.topicMessageDeleteErrorText,
      topicMessageEdit: state.topicMessageEdit,
      topicMessageEditBusy: state.topicMessageEditBusy,
      topicMessageEditErrorText: state.topicMessageEditErrorText,
      topicReportPopupOpen: state.topicReportPopupOpen,
      topicReportReason: state.topicReportReason,
      topicReportBusy: state.topicReportBusy,
      topicReportErrorText: state.topicReportErrorText,
      topicReportSuccessToast: state.topicReportSuccessToast,
      adminTopicReportsPopupOpen: state.adminTopicReportsPopupOpen,
      adminTopicReportsLoading: state.adminTopicReportsLoading,
      adminTopicReportsErrorText: state.adminTopicReportsErrorText,
      adminTopicReports: state.adminTopicReports,
      adminTopicReportsPendingCount: state.adminTopicReportsPendingCount,
      adminTopicReportsFilter: state.adminTopicReportsFilter,
      adminTopicReportActionBusyId: state.adminTopicReportActionBusyId,
      isTopicModerator: isTopicModeratorAuthSession(options.getAuthSession?.() ?? null),
      isWholeTopicModerator: isTopicWholeTopicModeratorAuthSession(options.getAuthSession?.() ?? null),
      isTopicMessageModerator: isTopicMessageModeratorAuthSession(options.getAuthSession?.() ?? null),
      isLafcheModerator: isLafcheModeratorAuthSession(options.getAuthSession?.() ?? null),
      isLafcheMessageDeleteModerator: isLafcheMessageDeleteModeratorAuthSession(options.getAuthSession?.() ?? null),
    }

    return lobbyState
  }

  // Тесен callback subset за targeted per-message DOM wiring (виж
  // TopicMessageNodeCallbacks/wireTopicMessageNode в renderLobbyScreen.ts) —
  // 1:1 mapping към СЪЩИТЕ controller функции, извиквани от пълния
  // renderLobby() options обект по-долу, без да build-ваме целия масивен
  // options обект само за targeted single-node wiring.
  function topicMessageNodeCallbacks(): TopicMessageNodeCallbacks {
    return {
      onTopicMessageAuthorClick: (profileId, displayName) => {
        void openProtectedProfileById(profileId, displayName, 'topics')
      },
      onTopicMessagePersonalClick: (profileId, displayName) => {
        void openTopicsPersonalMessageFromPost(profileId, displayName)
      },
      onTopicMessageLikeToggleClick: (messageId) => {
        submitTopicMessageLikeToggle(messageId)
      },
      onTopicReplyClick: (rootMessageId, scrollAnchor) => {
        openTopicThread(rootMessageId, scrollAnchor ?? null)
      },
      onTopicThreadOpen: (rootMessageId, scrollAnchor) => {
        openTopicThread(rootMessageId, scrollAnchor ?? null)
      },
      onTopicMuteClick: (topicId, targetProfileId, targetDisplayName, sourceMessageId, sourceKind) => {
        void openTopicMuteMenuForAuthor(topicId, targetProfileId, targetDisplayName, sourceMessageId ?? null, sourceKind ?? 'unspecified')
      },
      onTopicMessageDeleteClick: (topicId, messageId, isRoot, isModeratorAction) => {
        openTopicMessageDeleteConfirm(topicId, messageId, isRoot, isModeratorAction)
      },
      onTopicMessageEditClick: (topicId, messageId) => {
        openTopicMessageEditor(topicId, messageId)
      },
      onTopicMessageEditSubmit: (messageId) => {
        void submitTopicMessageEdit(messageId)
      },
      onTopicMessageEditInput: (messageId, value) => {
        updateTopicMessageEditDraft(messageId, value)
      },
      onTopicMessageEditCancel: (messageId) => {
        closeTopicMessageEditor(messageId)
      },
      onTopicsInfoToast: (text) => {
        showTopicsInfoToast(text)
      },
    }
  }

  function renderLobby(): void {
    stopWaitingRoomActivity()
    resetFinalFillSequence()
    clearServerRoomSnapshot()

    ensureProfilePopupTargetRoleLoaded()
    // Покрива входни точки, които отварят own profile popup-а само чрез
    // plain render() (напр. onProfileClick), не renderPopupOnly() — иначе
    // VIP статусът никога не се зарежда за own profile при тях (същия
    // "покрий всички входни точки" pattern като ensureProfilePopupTargetRoleLoaded).
    ensureOwnVipStatusLoaded()

    const lobbyState = buildLobbyScreenState()

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
          openPrivateRoomConflictPrompt()
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
        state.vipGrantOpen = false
        state.vipGrantSubmitting = false
        state.vipGrantErrorText = null
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
      onProfileGrantPikaTeamClick: (profileId) => {
        getPopupCallbacks().onGrantPikaTeamClick(profileId)
      },
      onProfileRevokePikaTeamClick: (profileId) => {
        getPopupCallbacks().onRevokePikaTeamClick(profileId)
      },
      onPikaTeamActionCancel: () => {
        cancelPikaTeamAction()
      },
      onPikaTeamActionConfirm: () => {
        void confirmPikaTeamAction()
      },
      onProfileGrantTopChatAdminClick: (profileId) => {
        getPopupCallbacks().onGrantTopChatAdminClick(profileId)
      },
      onProfileRevokeTopChatAdminClick: (profileId) => {
        getPopupCallbacks().onRevokeTopChatAdminClick(profileId)
      },
      onTopChatAdminActionCancel: () => {
        cancelTopChatAdminAction()
      },
      onTopChatAdminActionConfirm: () => {
        void confirmTopChatAdminAction()
      },
      onProfileVipGrantOpen: (profileId) => {
        getPopupCallbacks().onVipGrantOpen(profileId)
      },
      onProfileVipGrantCancel: () => {
        getPopupCallbacks().onVipGrantCancel()
      },
      onProfileVipGrantSubmit: (profileId, rawDays) => {
        getPopupCallbacks().onVipGrantSubmit(profileId, rawDays)
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
        // Edit-екранът се отваря САМО от отворен profile popup (виж
        // onEditClick по-долу) — при Cancel/X връщаме popup-а обратно
        // видим (state.profilePopupProfile не е пипан по време на edit,
        // значи показва старите данни), вместо да оставяме потребителя
        // да пада обратно към Lobby зад затворения popup.
        //
        // ВАЖНО: НЕ минаваме през генеричния render() тук — той rebuild-ва
        // ЦЕЛИЯ root.innerHTML (пълния Lobby екран), което разкрива голия,
        // недимнат Lobby за момента между премахването на edit overlay-я и
        // повторното append-ване на popup DOM възела. Вместо това премахваме
        // директно само edit overlay възела (евтина, targeted DOM операция)
        // и връщаме popup-а през renderPopupOnly() — същия overlay-only
        // render механизъм, ползван вече от admin players-search профил
        // флоу-а (виж openOtherProfilePopup по-долу) — така никога не се
        // rebuild-ва/показва Lobby между двата overlay екрана.
        // skipAnimation:true, защото popup DOM възелът е бил унищожен, докато
        // edit overlay-ят е стоял отгоре му (isFirstOpen би бил true) — без
        // това, entrance fade-in анимацията (140-160ms) би разкрила same Lobby.
        options.root.querySelector('[data-lobby-profile-editor-root="1"]')?.remove()
        state.profilePopupOpen = true
        renderPopupOnly({ skipAnimation: true })
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
      onShopTabClick: (tab) => {
        switchShopTab(tab)
      },
      onVipPurchaseClick: (packageId) => {
        void startVipPurchase(packageId)
      },
      onLeaderboardsClick: () => {
        void showLeaderboardsDirectory()
      },
      onTournamentsClick: () => {
        void showTournamentsList()
      },
      onTopicsClick: () => {
        void showTopicsDirectory()
      },
      onTopicChipClick: (topicId) => {
        openTopic(topicId)
      },
      onTopicCreateClick: () => {
        handleTopicCreateClick()
      },
      onTopicCreatePopupClose: () => {
        closeTopicCreatePopup()
      },
      onTopicCreateTitleInput: (value) => {
        updateTopicCreateTitleDraft(value)
      },
      onTopicCreateSubmit: () => {
        submitTopicCreate()
      },
      onTopicsBackToGeneral: () => {
        backToGeneralTopic()
      },
      onTopicMessagesLoadOlder: () => {
        void loadOlderTopicMessages()
      },
      onTopicRepliesLoadMore: (rootMessageId) => {
        void loadMoreReplies(rootMessageId)
      },
      onTopicThreadOpen: (rootMessageId, scrollAnchor) => {
        openTopicThread(rootMessageId, scrollAnchor ?? null)
      },
      onTopicThreadBack: () => {
        closeTopicThreadToGeneral()
      },
      onTopicMessageLikeToggleClick: (messageId) => {
        submitTopicMessageLikeToggle(messageId)
      },
      onTopicReplyClick: (rootMessageId, scrollAnchor) => {
        openTopicThread(rootMessageId, scrollAnchor ?? null)
      },
      onTopicReplyComposerNonVipTap: () => {
        handleTopicReplyComposerNonVipTap()
      },
      onTopicReplyComposerCancel: (rootMessageId) => {
        closeInlineReplyComposer(rootMessageId)
      },
      onTopicReplyComposerInput: (rootMessageId, value) => {
        updateTopicReplyComposerDraft(rootMessageId, value)
      },
      onTopicReplyComposerSubmit: (rootMessageId) => {
        submitTopicReplyComposerMessage(rootMessageId)
      },
      onTopicComposerInput: (topicId, value) => {
        updateTopicComposerDraft(topicId, value)
      },
      onTopicComposerSubmit: (topicId) => {
        submitTopicComposerMessage(topicId)
      },
      onTopicComposerNonVipTap: () => {
        handleTopicComposerNonVipTap()
      },
      onTopicComposerMutedTap: () => {
        openTopicsSectionMutePopupForAttempt()
        render()
      },
      onTopicComposerImageSelect: (topicId, file) => {
        selectTopicComposerImage(topicId, file)
      },
      onTopicComposerImageRemove: (topicId) => {
        clearTopicComposerPendingImage(topicId)
        render()
      },
      onTopicReplyComposerImageSelect: (rootMessageId, file) => {
        selectTopicReplyComposerImage(rootMessageId, file)
      },
      onTopicReplyComposerImageRemove: (rootMessageId) => {
        clearTopicReplyComposerPendingImage(rootMessageId)
        render()
      },
      onImageViewerOpen: (attachment) => {
        openImageViewer(attachment)
      },
      onImageViewerClose: () => {
        requestImageViewerClose()
      },
      onTopicsVipPopupClose: () => {
        closeTopicsVipPopup()
      },
      onTopicsVipPopupClaimLaunchGift: () => {
        void claimTopicsLaunchGift()
      },
      onTopicsVipPopupSeePlans: () => {
        showTopicsVipPlansInertMessage()
      },
      // ─── Topics Moderation (Етап 4) ────────────────────────────────────
      onTopicMuteHistoryOpen: () => {
        void openTopicMuteHistoryPopup()
      },
      onTopicMuteHistoryClose: () => {
        closeTopicMuteHistoryPopup()
      },
      onTopicsSectionMutePopupAcknowledge: () => {
        acknowledgeTopicsSectionMutePopup()
      },
      onTopicsSectionMutePopupHistoryOpen: () => {
        state.topicsSectionMutePopupOpen = false
        resetActiveTopicsComposerDraft()
        void openTopicMuteHistoryPopup()
      },
      onTopicMuteHistoryOpenForProfile: (targetProfileId) => {
        void openTopicMuteHistoryModeratorPopup(targetProfileId)
      },
      onTopicMuteHistoryCloseForProfile: () => {
        closeTopicMuteHistoryModeratorPopup()
      },
      onTopicLockClick: (topicId, topicTitle) => {
        openTopicLockPopup(topicId, topicTitle)
      },
      onTopicUnlockClick: (topicId) => {
        void unlockActiveTopic(topicId)
      },
      onTopicMuteClick: (topicId, targetProfileId, targetDisplayName, sourceMessageId, sourceKind) => {
        void openTopicMuteMenuForAuthor(topicId, targetProfileId, targetDisplayName, sourceMessageId ?? null, sourceKind ?? 'unspecified')
      },
      onTopicUnmuteClick: (topicId, targetProfileId) => {
        void unmuteProfileInActiveTopic(topicId, targetProfileId)
      },
      onTopicModerationActionPopupClose: () => {
        closeTopicModerationActionPopup()
      },
      onTopicModerationActionDurationChange: (durationMs) => {
        updateTopicModerationActionDuration(durationMs)
      },
      onTopicModerationActionReasonChange: (reason) => {
        updateTopicModerationActionReason(reason)
      },
      onTopicModerationActionReasonCategoryChange: (category) => {
        updateTopicModerationActionReasonCategory(category)
      },
      onTopicModerationActionSubmit: () => {
        void submitTopicModerationAction()
      },
      onTopicDeleteClick: (topicId, topicTitle) => {
        openTopicDeleteConfirm(topicId, topicTitle)
      },
      onTopicDeleteConfirmClose: () => {
        closeTopicDeleteConfirm()
      },
      onTopicDeleteReasonChange: (reason) => {
        updateTopicDeleteReason(reason)
      },
      onTopicDeleteAdvance: () => {
        advanceTopicDeleteConfirm()
      },
      onTopicDeleteConfirmSubmit: () => {
        void confirmTopicDelete()
      },
      onTopicMessageDeleteClick: (topicId, messageId, isRoot, isModeratorAction) => {
        openTopicMessageDeleteConfirm(topicId, messageId, isRoot, isModeratorAction)
      },
      onTopicMessageDeleteConfirmClose: () => {
        closeTopicMessageDeleteConfirm()
      },
      onTopicMessageDeleteConfirmSubmit: () => {
        void confirmTopicMessageDelete()
      },
      onTopicMessageEditClick: (topicId, messageId) => {
        openTopicMessageEditor(topicId, messageId)
      },
      onTopicsInfoToast: (text) => {
        showTopicsInfoToast(text)
      },
      onTopicMessageEditInput: (messageId, value) => {
        updateTopicMessageEditDraft(messageId, value)
      },
      onTopicMessageEditCancel: (messageId) => {
        closeTopicMessageEditor(messageId)
      },
      onTopicMessageEditSubmit: (messageId) => {
        void submitTopicMessageEdit(messageId)
      },
      onTopicReportClick: () => {
        openTopicReportPopup()
      },
      onTopicReportPopupClose: () => {
        closeTopicReportPopup()
      },
      onTopicReportReasonChange: (reason) => {
        updateTopicReportReason(reason)
      },
      onTopicReportSubmit: () => {
        void submitTopicReport()
      },
      onAdminTopicReportsFilterChange: (status) => {
        void loadAdminTopicReports(status)
      },
      onAdminTopicReportReview: (reportId, status) => {
        void reviewAdminTopicReport(reportId, status)
      },
      onAdminTopicReportsOpen: () => {
        state.adminTopicReportsPopupOpen = true
        render()
        void loadAdminTopicReports('pending')
      },
      onAdminTopicReportsClose: () => {
        state.adminTopicReportsPopupOpen = false
        render()
      },
      onTopicMessageAuthorClick: (profileId, displayName) => {
        void openProtectedProfileById(profileId, displayName, 'topics')
      },
      onTopicMessagePersonalClick: (profileId, displayName) => {
        void openTopicsPersonalMessageFromPost(profileId, displayName)
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
      onProfileAccessBlockClose: () => {
        state.profileAccessBlockPopup = null
        render()
      },
      onProfileAccessBlockUnblock: (profileId) => {
        void (async () => {
          const unblocked = await unblockPlayer(profileId)
          if (!unblocked) return
          // Не отваряме профила optimistically — само след потвърден успешен
          // unblock. Reuse-ва стандартния authoritative profile-open flow
          // (fresh onProfileByIdLoad заявка), за да не дублираме profile
          // rendering логика и да не показваме stale/cached denial state.
          await openProtectedProfileById(profileId)
        })()
      },
      onNoPlayersModalClose: () => {
        state.noPlayersModalOpen = false
        render()
      },
      onChatClick: () => {
        void showChatPanel()
      },
      onTopicsLafcheOpen: () => {
        openTopic(LAFCHE_TOPIC_ID)
      },
      onTopicsPersonalOpen: () => {
        void showTopicsPersonalChat()
      },
      onTopicsPersonalBack: () => {
        closeTopicsPersonalChat()
      },
      onTopicsPersonalConversationBack: () => {
        backToTopicsPersonalList()
      },
      onChatConversationClick: (friendshipId) => {
        void openChatConversation(friendshipId)
      },
      onChatMarkRead: (friendshipId) => {
        markChatConversationReadLocally(friendshipId)
        render()
        void options.onChatMarkRead?.(friendshipId)
      },
      onChatToggleArchived: () => {
        void toggleChatArchivedView()
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
        if (profile.profileId === null) return
        void openProtectedProfileById(profile.profileId, profile.displayName)
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
        if (profile.profileId === null) return
        void openProtectedProfileById(profile.profileId, profile.displayName)
      },
      onFriendProfileClick: (profile) => {
        if (profile.profileId === null) return
        void openProtectedProfileById(profile.profileId, profile.displayName)
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
      onPikaSupportChatClick: (profileId) => { void startPikaSupportChatAndOpen(profileId) },
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
      onLobbyChatFullscreenChange: (isFullscreen) => {
        setLobbyChatFullscreen(isFullscreen)
      },
      onLobbyChatWriteLockedTap: () => {
        openLobbyChatWriteLockedPopup()
      },
      onLobbyChatWriteLockedPopupClose: () => {
        closeLobbyChatWriteLockedPopup()
      },
      onLobbyChatWriteLockedGotoTopics: () => {
        closeLobbyChatWriteLockedPopup()
        void showTopicsDirectory()
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
      onVipPurchaseSuccessClose: () => {
        state.vipPurchaseSuccessPopup = { isOpen: false, phase: 'loading', days: 0, activeUntilLabel: null }
        render()
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
      onPrivateRoomInGameNotificationsChange: (enabled) => {
        state.privateRoomInGameNotificationsEnabled = enabled
        options.onPrivateRoomInGameNotificationsChange?.(enabled)
        render()
      },
      onPrivateRoomCreatedSoundChange: (enabled) => {
        state.privateRoomCreatedSoundEnabled = enabled
        options.onPrivateRoomCreatedSoundChange?.(enabled)
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
      onPrivateRoomsOpen: () => navigateToPrivateRooms(),
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
      onPrivateRoomsLifecycleTabChange: (tab) => {
        state.privateRoomsLifecycleTab = tab
        if ((tab === 'playing' || tab === 'finished') && !state.privateGamesLoaded) {
          state.privateGamesLoaded = true
          options.onPrivateGamesOpen?.()
        }
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
        if (state.myPrivateRoom !== null) {
          state.privateRoomsCreatePopupOpen = false
          openPrivateRoomConflictPrompt()
          return
        }

        const stakeRoom = state.matchRooms.find((r) => r.stakeAmount === stake)
        if (!stakeRoom || !stakeRoom.isEnabled) {
          state.privateRoomsCreatePopupOpen = false
          state.privateRoomInfoText = 'Този залог вече не е наличен. Изберете друг залог.'
          render()
          return
        }

        const authSession = options.getAuthSession?.() ?? null
        const currentLevel = authSession?.profile.level ?? 1
        if (currentLevel < stakeRoom.minLevel) {
          state.privateRoomsCreatePopupOpen = false
          openLevelLockedStakePopup(stakeRoom.minLevel, currentLevel)
          return
        }

        const balance = authSession?.profile.yellowCoinsBalance ?? 0
        if (balance < stake) {
          state.privateRoomsCreatePopupOpen = false
          state.lowCoinsModalOpen = true
          render()
          return
        }

        state.privateRoomsCreatePopupOpen = false
        state.privateRoomJoinInFlight = true
        options.onPrivateRoomCreate?.(stake, isLocked, waitMinutes)
      },
      onPrivateRoomJoin: handlePrivateRoomJoin,
      onPrivateRoomMemberClick: (profileId, displayName) => {
        void openProtectedProfileById(profileId, displayName, 'other')
      },
      onPrivateRoomListSlotJoinOpen: openPrivateRoomListSlotJoinPopup,
      onPrivateRoomJoinSlotPopupConfirm: confirmPrivateRoomJoinSlotPopup,
      onPrivateRoomJoinSlotPopupCancel: cancelPrivateRoomJoinSlotPopup,
      onPrivateRoomBlockedPopupClose: () => {
        state.privateRoomBlockedPopupText = null
        render()
      },
      onPrivateRoomListEnter: handlePrivateRoomListEnter,
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
      // Per-friend "Покани" клик — изпраща еднолична покана веднага и
      // маркира профила optimistically като "sent" (бутонът им става
      // disabled "Изпратена"), БЕЗ да затваря popup-а — потребителят може
      // да покани няколко приятели последователно. Сървърът си остава
      // финалният authority срещу реален duplicate spam (inviteFriend
      // отхвърля повторна покана към същия профил за същата стая).
      onPrivateRoomInviteSend: (profileId, displayName) => {
        state.privateRoomInvitedProfileIds.add(profileId)
        state.privateRoomInfoText = null
        options.onPrivateRoomInvite?.([{ profileId, displayName }])
        render()
      },
      onPrivateRoomInviteAccept: (inviteId) => {
        if (state.myPrivateRoom !== null) {
          openPrivateRoomConflictPrompt()
          return
        }
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
      onPrivateRoomConflictReturnClick: () => {
        state.privateRoomConflictPromptOpen = false
        returnToPrivateRoomWaiting()
      },
      onPrivateRoomConflictDismiss: () => {
        state.privateRoomConflictPromptOpen = false
        render()
      },
      onSupportClick: () => {
        openSupportInbox()
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
            state.supportDraft = ''
            clearSupportPendingImage()
            state.supportDeleteConfirm = false
            state.supportPopupOpen = false
          }
          render()
        })()
      },
      onSupportDraftChange: (draft) => {
        state.supportDraft = draft
      },
      onSupportImageSelect: (file) => {
        selectSupportImage(file)
      },
      onSupportImageRemove: () => {
        clearSupportPendingImage()
        render()
      },
      onSupportSend: (body) => {
        if (state.supportSendingLoading) return
        const pendingImage = state.supportPendingImage
        if (body.trim().length === 0 && pendingImage === null) return
        const previousInput = options.root.querySelector<HTMLTextAreaElement>('[data-support-send-form="1"] textarea[name="body"]')
        const shouldRefocus = previousInput !== null && document.activeElement === previousInput
        const previousSelectionStart = previousInput?.selectionStart ?? 0
        const previousSelectionEnd = previousInput?.selectionEnd ?? previousSelectionStart
        const previousSelectionDirection = previousInput?.selectionDirection ?? 'none'
        state.supportSendingLoading = true
        state.supportErrorText = null
        render()
        void (async () => {
          let imageDataUrl: string | null = null
          if (pendingImage !== null) {
            try {
              imageDataUrl = await readFileAsDataUrl(pendingImage.file)
            } catch {
              state.supportSendingLoading = false
              state.supportErrorText = 'Качването на снимката не бе успешно. Опитайте отново.'
              const restoreFocus = canRestoreComposerFocus(shouldRefocus)
              render()
              if (restoreFocus) {
                refocusSupportComposer(previousSelectionStart, previousSelectionEnd, previousSelectionDirection)
              }
              return
            }
          }

          const result = await options.onSupportSend?.(body, imageDataUrl)
          state.supportSendingLoading = false
          if (result?.ok) {
            state.supportMessages = result.messages
            state.supportAccountTooNewMinutes = null
            state.supportDraft = ''
            clearSupportPendingImage()
          } else if (result?.code === 'account_too_new' && result.remainingMinutes) {
            state.supportAccountTooNewMinutes = result.remainingMinutes
          } else {
            state.supportErrorText = result?.message ?? 'Грешка при изпращане.'
          }
          const restoreFocus = canRestoreComposerFocus(shouldRefocus)
          render()
          if (restoreFocus) {
            if (result?.ok) {
              refocusSupportComposer(0)
            } else {
              refocusSupportComposer(previousSelectionStart, previousSelectionEnd, previousSelectionDirection)
            }
          }
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
          state.adminSupportReplyErrorText = null
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
      onAdminSupportReplyDraftChange: (profileId, draft) => {
        state.adminSupportReplyDraftByProfileId = {
          ...state.adminSupportReplyDraftByProfileId,
          [profileId]: draft,
        }
      },
      onAdminSupportImageSelect: (profileId, file) => {
        selectAdminSupportImage(profileId, file)
      },
      onAdminSupportImageRemove: (profileId) => {
        clearAdminSupportPendingImage(profileId)
        render()
      },
      onAdminSupportReply: (profileId, body) => {
        if (state.adminSupportReplyLoading) return
        const pendingImage = state.adminSupportPendingImageByProfileId[profileId] ?? null
        if (body.trim().length === 0 && pendingImage === null) return
        const previousInput = options.root.querySelector<HTMLTextAreaElement>(
          `[data-admin-support-reply-form="${selectorEscape(profileId)}"] textarea[name="body"]`,
        )
        const shouldRefocus = previousInput !== null && document.activeElement === previousInput
        const previousSelectionStart = previousInput?.selectionStart ?? 0
        const previousSelectionEnd = previousInput?.selectionEnd ?? previousSelectionStart
        const previousSelectionDirection = previousInput?.selectionDirection ?? 'none'
        state.adminSupportReplyLoading = true
        state.adminSupportReplyErrorText = null
        render()
        void (async () => {
          let imageDataUrl: string | null = null
          if (pendingImage !== null) {
            try {
              imageDataUrl = await readFileAsDataUrl(pendingImage.file)
            } catch {
              state.adminSupportReplyLoading = false
              state.adminSupportReplyErrorText = 'Качването на снимката не бе успешно. Опитайте отново.'
              const restoreFocus = canRestoreComposerFocus(shouldRefocus)
              render()
              if (restoreFocus) {
                refocusAdminSupportComposer(profileId, previousSelectionStart, previousSelectionEnd, previousSelectionDirection)
              }
              return
            }
          }

          const result = await options.onAdminSupportReply?.(profileId, body, imageDataUrl)
          state.adminSupportReplyLoading = false
          if (result?.ok) {
            state.adminSupportMessages = result.messages
            state.adminSupportReplyDraftByProfileId = {
              ...state.adminSupportReplyDraftByProfileId,
              [profileId]: '',
            }
            clearAdminSupportPendingImage(profileId)
            const conv = state.adminSupportConversations.find(c => c.profileId === profileId)
            if (conv) {
              conv.lastMessageIsFromAdmin = true
              conv.lastMessageBody = body.trim().length > 0 ? body : '[Снимка]'
              conv.updatedAt = new Date().toISOString()
            }
          } else {
            state.adminSupportReplyErrorText = result?.message ?? 'Грешка при изпращане.'
          }
          const restoreFocus = canRestoreComposerFocus(shouldRefocus)
          render()
          if (restoreFocus) {
            if (result?.ok) {
              refocusAdminSupportComposer(profileId, 0)
            } else {
              refocusAdminSupportComposer(profileId, previousSelectionStart, previousSelectionEnd, previousSelectionDirection)
            }
          }
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
            clearAdminSupportPendingImage(profileId)
            const nextDrafts = { ...state.adminSupportReplyDraftByProfileId }
            delete nextDrafts[profileId]
            state.adminSupportReplyDraftByProfileId = nextDrafts
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
    // Същият overlay-only преход като при Cancel/X (виж onProfileEditClose) —
    // директно премахваме edit overlay-я и връщаме popup-а през
    // renderPopupOnly({skipAnimation:true}), вместо пълен Lobby render(), за
    // да няма нито един frame с разкрит гол Lobby между двата overlay екрана.
    options.root.querySelector('[data-lobby-profile-editor-root="1"]')?.remove()
    renderPopupOnly({ skipAnimation: true })
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

  /**
   * "Дай VIP" — само админско действие върху ЧУЖД profile popup, извикано
   * от onVipGrantSubmit. Клиентската валидация тук е за instant feedback
   * (без round-trip за очевидно грешен вход) — server-side проверката
   * (handleAdminVipGrantRequest) е authoritative и се прави независимо.
   * Успешен grant презаписва profile popup-а веднага (updateEditedTargetProfile
   * + renderPopupOnly(), НЕ render()) — same overlay-only принцип като
   * Edit↔Profile, за да няма Lobby flicker. При грешка popup-ът и формата
   * остават отворени, локалният VIP статус НЕ се променя.
   */
  async function submitAdminVipGrant(profileId: string | null, rawDays: string): Promise<void> {
    if (state.vipGrantSubmitting) return
    if (!profileId) return

    const trimmed = rawDays.trim()
    const days = Number(trimmed)
    if (trimmed === '' || !Number.isInteger(days) || days <= 0) {
      state.vipGrantErrorText = 'Въведи цяло положително число дни.'
      renderPopupOnly()
      return
    }

    state.vipGrantSubmitting = true
    state.vipGrantErrorText = null
    renderPopupOnly()

    const result = options.onAdminGrantVip
      ? await options.onAdminGrantVip(profileId, days).catch(
          () => ({ ok: false as const, message: 'Няма връзка със сървъра.' }),
        )
      : { ok: false as const, message: 'Функцията временно не е налична.' }

    if (!result.ok) {
      state.vipGrantSubmitting = false
      state.vipGrantErrorText = result.message
      renderPopupOnly()
      return
    }

    updateEditedTargetProfile(result.profile)
    state.vipGrantOpen = false
    state.vipGrantSubmitting = false
    state.vipGrantErrorText = null
    renderPopupOnly()
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

  // Realtime subscription helpers (Етап 2) — виж corrected flow в брифа т.1:
  // 1) unsubscribe от старата тема; 2) REST load; 3) subscribe с afterSeq =
  // gap-closing cursor. Скалар (не Set) — Topics UX показва точно ЕДНА
  // активна тема наведнъж.
  function unsubscribeFromCurrentTopicMessages(): void {
    if (state.topicMessagesSubscribedTopicId !== null) {
      options.onTopicMessagesUnsubscribe?.(state.topicMessagesSubscribedTopicId)
      state.topicMessagesSubscribedTopicId = null
    }
  }

  function subscribeToTopicMessagesGapClosing(topicId: string): void {
    const afterSeq = state.topicMessagesLatestKnownSeqByTopicId[topicId] ?? 0
    options.onTopicMessagesSubscribe?.(topicId, afterSeq)
    state.topicMessagesSubscribedTopicId = topicId
  }

  function computeLatestSeq(messages: readonly TopicMessageSnapshot[]): number {
    return messages.reduce((max, m) => Math.max(max, m.seq), 0)
  }

  function normalizeTopicUnreadCount(count: number): number {
    if (!Number.isFinite(count)) return 0
    return Math.max(0, Math.floor(count))
  }

  function updateTopicUnreadCount(topicId: string, unreadCount: number): boolean {
    if (state.topics === null) return false
    const normalized = normalizeTopicUnreadCount(unreadCount)
    let changed = false
    state.topics = state.topics.map((topic) => {
      if (topic.topicId !== topicId) return topic
      if (topic.unreadCount === normalized) return topic
      changed = true
      return { ...topic, unreadCount: normalized }
    })
    return changed
  }

  function updateTopicThreadUnreadCount(rootMessageId: string, unreadCount: number): boolean {
    if (state.topicMessages === null) return false
    const normalized = normalizeTopicUnreadCount(unreadCount)
    let changed = false
    state.topicMessages = state.topicMessages.map((message) => {
      if (message.messageId !== rootMessageId) return message
      if (message.unreadCount === normalized) return message
      changed = true
      return { ...message, unreadCount: normalized }
    })
    return changed
  }

  let topicsDirectoryMetadataRequestGeneration = 0

  function clearTopicsDirectoryMetadata(): void {
    topicsDirectoryMetadataRequestGeneration++
    state.topics = null
    state.topicsLoadedForProfileId = null
    state.topicsErrorText = null
    unsubscribeFromTopicsDirectory()
    render()
  }

  async function refreshTopicsDirectoryMetadata(): Promise<boolean> {
    const authSession = options.getAuthSession?.() ?? null
    const profileId = authSession?.profile.profileId ?? null
    const requestGeneration = ++topicsDirectoryMetadataRequestGeneration

    if (profileId === null || !options.onTopicsLoad) {
      if (state.topics !== null || state.topicsLoadedForProfileId !== null) {
        state.topics = null
        state.topicsLoadedForProfileId = null
        state.topicsErrorText = null
        unsubscribeFromTopicsDirectory()
        render()
      }
      return false
    }

    if (state.topicsLoadedForProfileId !== null && state.topicsLoadedForProfileId !== profileId) {
      state.topics = null
      state.topicsLoadedForProfileId = null
      state.topicsErrorText = null
      unsubscribeFromTopicsDirectory()
      render()
    }

    const result = await options.onTopicsLoad()
    const latestAuthSession = options.getAuthSession?.() ?? null
    if (
      requestGeneration !== topicsDirectoryMetadataRequestGeneration ||
      latestAuthSession?.profile.profileId !== profileId
    ) {
      return false
    }

    if (!result.ok) {
      if (state.currentScreen === 'topics') {
        state.topicsErrorText = result.message
        render()
      }
      return false
    }

    state.topics = result.topics
    state.topicsLoadedForProfileId = profileId
    state.topicsErrorText = null
    subscribeToTopicsDirectory()
    render()
    return true
  }

  async function reconcileTopicsDirectoryFromServer(): Promise<void> {
    if (state.currentScreen !== 'topics' || !options.onTopicsLoad) return
    const activeTopicId = state.activeTopicId
    const result = await options.onTopicsLoad()
    if (state.currentScreen !== 'topics') return
    if (!result.ok) return

    state.topics = result.topics
    state.topicsLoadedForProfileId = (options.getAuthSession?.() ?? null)?.profile.profileId ?? state.topicsLoadedForProfileId
    const activeTopic = activeTopicId !== null
      ? result.topics.find((topic) => topic.topicId === activeTopicId) ?? null
      : null
    if (activeTopic !== null) {
      state.activeTopicLock = deriveTopicLockSnapshot(activeTopic)
      if (!activeTopic.isGeneral) {
        void markActiveTopicSeen(activeTopic.topicId)
      }
    }
    // WS reconnect (regression fix, брифа §6) — same viewerSectionMute
    // reconciliation като showTopicsDirectory, за да не остане composer-ът
    // "отключен" за вече muted viewer след reconnect (dropped connection
    // means dropped realtime topic_mute_state_changed push too).
    state.activeTopicViewerMute = result.viewerSectionMute
      ? { isMuted: result.viewerSectionMute.isMuted, mutedUntil: result.viewerSectionMute.mutedUntil, mutedByAccountId: null, reason: result.viewerSectionMute.reason }
      : null
    evaluateTopicsSectionMutePopup()
    render()
  }

  function isGeneralTopicId(topicId: string): boolean {
    const topic = (state.topics ?? []).find((candidate) => candidate.topicId === topicId) ?? null
    return Boolean(topic?.isGeneral || topic?.topicId === 'topic-general' || topic?.slug === 'general')
  }

  async function markActiveTopicSeen(topicId: string): Promise<void> {
    if (isGeneralTopicId(topicId)) return
    const changed = updateTopicUnreadCount(topicId, 0)
    if (changed && state.currentScreen === 'topics') {
      render()
    }

    if (!options.onTopicMarkSeen) return
    if (state.topicSeenInFlightByTopicId[topicId]) {
      state.topicSeenQueuedByTopicId[topicId] = true
      return
    }

    state.topicSeenInFlightByTopicId[topicId] = true
    state.topicSeenQueuedByTopicId[topicId] = false
    const result = await options.onTopicMarkSeen(topicId)
    state.topicSeenInFlightByTopicId[topicId] = false

    if (state.currentScreen !== 'topics') return
    if (result.ok) {
      if (updateTopicUnreadCount(topicId, result.unreadCount)) {
        render()
      }
    } else {
      void reconcileTopicsDirectoryFromServer()
    }

    if (state.topicSeenQueuedByTopicId[topicId] && state.activeTopicId === topicId) {
      state.topicSeenQueuedByTopicId[topicId] = false
      void markActiveTopicSeen(topicId)
    }
  }

  async function markTopicThreadSeen(rootMessageId: string): Promise<void> {
    const topicId = state.activeTopicId
    if (topicId === null || !options.onTopicThreadMarkSeen) return

    const changedThread = updateTopicThreadUnreadCount(rootMessageId, 0)
    if (changedThread && state.currentScreen === 'topics') {
      render()
    }

    if (state.topicThreadSeenInFlightByRootId[rootMessageId]) {
      state.topicThreadSeenQueuedByRootId[rootMessageId] = true
      return
    }

    state.topicThreadSeenInFlightByRootId[rootMessageId] = true
    state.topicThreadSeenQueuedByRootId[rootMessageId] = false
    const result = await options.onTopicThreadMarkSeen(topicId, rootMessageId)
    state.topicThreadSeenInFlightByRootId[rootMessageId] = false

    if (state.currentScreen !== 'topics') return
    if (result.ok) {
      const changedTopic = updateTopicUnreadCount(topicId, result.topicUnreadCount)
      const changedRoot = updateTopicThreadUnreadCount(rootMessageId, result.unreadCount)
      if (changedTopic || changedRoot) {
        render()
      }
    } else {
      void reconcileTopicsDirectoryFromServer()
    }

    if (
      state.topicThreadSeenQueuedByRootId[rootMessageId] &&
      state.activeTopicId === topicId &&
      state.topicsMode === 'thread' &&
      state.topicThreadRootMessageId === rootMessageId
    ) {
      state.topicThreadSeenQueuedByRootId[rootMessageId] = false
      void markTopicThreadSeen(rootMessageId)
    }
  }

  // ─── Topics Moderation (Етап 4) ──────────────────────────────────────────
  //
  // isLocked е computed CLIENT-SIDE тук САМО за display purposes (banner
  // text/composer disabled look) — реалната authoritative проверка е винаги
  // server-side (topicModerationStore.getTopicLockSnapshot в index.ts).
  // Client timer НЕ управлява реалното право на писане (брифа т.2) — ако
  // client clock-ът е разминат, composer-ът може накратко да изглежда
  // грешно, но submit винаги минава през server проверка.
  function deriveTopicLockSnapshot(topic: TopicSnapshot): TopicLockSnapshot | null {
    if (topic.lockedUntil === null) {
      return { isLocked: false, lockedUntil: null, lockedByAccountId: null, lockedReason: null }
    }
    return {
      isLocked: new Date(topic.lockedUntil).getTime() > Date.now(),
      lockedUntil: topic.lockedUntil,
      lockedByAccountId: null,
      lockedReason: topic.lockedReason,
    }
  }

  function openTopicLockPopup(topicId: string, topicTitle: string): void {
    state.topicModerationActionPopup = { kind: 'lock', topicId, topicTitle }
    state.topicModerationActionDurationMs = null
    state.topicModerationActionReason = ''
    state.topicModerationActionErrorText = null
    render()
  }

  // Lazy-fetch (не batch-hydrate-нат в message list-а, виж коментара в
  // renderTopicsScreen.ts data-topic-mute-toggle) — модераторският "⚙" клик
  // до автор първо проверява active mute статус, после решава дали да
  // отвори Mute (duration+reason) или Unmute (прост confirm) popup-а.
  // sourceMessageId/sourceKind — постът, до чийто автор е бил натиснат "⚙"
  // (mute-evidence брифа §1/§3) — пренася се в mute popup state-a, за да
  // стигне до server-side snapshot-a при submit (submitTopicModerationAction).
  async function openTopicMuteHistoryPopup(): Promise<void> {
    state.topicMuteHistoryPopupOpen = true
    state.topicMuteHistoryLoading = true
    state.topicMuteHistoryErrorText = null
    render()

    const result = await options.onTopicMuteHistoryLoad?.()
    state.topicMuteHistoryLoading = false
    if (!result || !result.ok) {
      state.topicMuteHistoryErrorText = result?.message ?? 'Грешка при зареждане на историята.'
      render()
      return
    }
    state.topicMuteHistoryEntries = result.entries
    render()
  }

  function closeTopicMuteHistoryPopup(): void {
    state.topicMuteHistoryPopupOpen = false
    render()
  }

  async function openTopicMuteHistoryModeratorPopup(targetProfileId: string): Promise<void> {
    state.topicMuteHistoryModeratorTargetProfileId = targetProfileId
    state.topicMuteHistoryModeratorLoading = true
    state.topicMuteHistoryModeratorErrorText = null
    render()

    const result = await options.onTopicMuteHistoryLoadForProfile?.(targetProfileId)
    state.topicMuteHistoryModeratorLoading = false
    if (!result || !result.ok) {
      state.topicMuteHistoryModeratorErrorText = result?.message ?? 'Грешка при зареждане на историята.'
      render()
      return
    }
    state.topicMuteHistoryModeratorEntries = result.entries
    render()
  }

  function closeTopicMuteHistoryModeratorPopup(): void {
    state.topicMuteHistoryModeratorTargetProfileId = null
    state.topicMuteHistoryModeratorEntries = null
    render()
  }

  async function openTopicMuteMenuForAuthor(
    topicId: string,
    targetProfileId: string,
    targetDisplayName: string,
    sourceMessageId: string | null = null,
    sourceKind: 'lafche_post' | 'topic_root' | 'topic_reply' | 'unspecified' = 'unspecified',
  ): Promise<void> {
    if (state.topicMuteStatusLoadingProfileId !== null) return
    state.topicMuteStatusLoadingProfileId = targetProfileId
    render()

    const result = await options.onTopicMuteStatusLoad?.(topicId, targetProfileId)
    state.topicMuteStatusLoadingProfileId = null

    if (!result || !result.ok) {
      render()
      return
    }

    if (result.mute.isMuted) {
      state.topicModerationActionPopup = { kind: 'unmute', topicId, targetProfileId, targetDisplayName, mutedUntil: result.mute.mutedUntil, reason: result.mute.reason }
    } else {
      state.topicModerationActionPopup = { kind: 'mute', topicId, targetProfileId, targetDisplayName, sourceMessageId, sourceKind }
      state.topicModerationActionDurationMs = null
      state.topicModerationActionReason = ''
      state.topicModerationActionReasonCategory = null
      state.topicModerationActionErrorText = null
    }
    render()
  }

  function closeTopicModerationActionPopup(): void {
    if (state.topicModerationActionBusy) return
    state.topicModerationActionPopup = null
    render()
  }

  function updateTopicModerationActionDuration(durationMs: number): void {
    state.topicModerationActionDurationMs = durationMs
    render()
  }

  function updateTopicModerationActionReason(reason: string): void {
    state.topicModerationActionReason = reason
  }

  function updateTopicModerationActionReasonCategory(
    category: 'insults' | 'provocation' | 'spam' | 'inappropriate_content' | 'other' | null,
  ): void {
    state.topicModerationActionReasonCategory = category
  }

  async function submitTopicModerationAction(): Promise<void> {
    const pending = state.topicModerationActionPopup
    if (!pending || state.topicModerationActionBusy) return

    if (pending.kind === 'unmute') {
      state.topicModerationActionBusy = true
      render()
      const result = await options.onTopicUnmuteProfile?.(pending.topicId, pending.targetProfileId)
      state.topicModerationActionBusy = false
      if (!result || !result.ok) {
        state.topicModerationActionErrorText = result?.message ?? 'Грешка при отглушаване.'
        render()
        return
      }
      state.topicModerationActionPopup = null
      render()
      return
    }

    const reason = state.topicModerationActionReason.trim()
    if (reason.length === 0) {
      state.topicModerationActionErrorText = 'Моля, въведи причина.'
      render()
      return
    }
    const durationMs = state.topicModerationActionDurationMs
    if (durationMs === null) {
      state.topicModerationActionErrorText = 'Моля, избери продължителност.'
      render()
      return
    }

    state.topicModerationActionBusy = true
    state.topicModerationActionErrorText = null
    render()

    if (pending.kind === 'lock') {
      const result = await options.onTopicLock?.(pending.topicId, reason, durationMs)
      state.topicModerationActionBusy = false
      if (!result || !result.ok) {
        state.topicModerationActionErrorText = result?.message ?? 'Грешка при заключване.'
        render()
        return
      }
      if (state.activeTopicId === pending.topicId) {
        state.activeTopicLock = result.lock
      }
      state.topicModerationActionPopup = null
      render()
      return
    }

    // kind === 'mute'
    const result = await options.onTopicMuteProfile?.(
      pending.topicId,
      pending.targetProfileId,
      reason,
      durationMs,
      pending.sourceMessageId,
      pending.sourceKind,
      state.topicModerationActionReasonCategory,
    )
    state.topicModerationActionBusy = false
    if (!result || !result.ok) {
      state.topicModerationActionErrorText = result?.message ?? 'Грешка при заглушаване.'
      render()
      return
    }
    state.topicModerationActionPopup = null
    render()
  }

  async function unlockActiveTopic(topicId: string): Promise<void> {
    const result = await options.onTopicUnlock?.(topicId)
    if (result && result.ok && state.activeTopicId === topicId) {
      state.activeTopicLock = result.lock
      render()
    }
  }

  async function unmuteProfileInActiveTopic(topicId: string, profileId: string): Promise<void> {
    await options.onTopicUnmuteProfile?.(topicId, profileId)
    // Realtime topic_mute_state_changed push (target-only) обновява
    // state.activeTopicViewerMute за самия заглушен потребител — модераторът,
    // който изпълнява unmute-а, няма нужда от локален state тук (той не е
    // muted), само действието трябва да достигне до сървъра.
  }

  function openTopicDeleteConfirm(topicId: string, topicTitle: string): void {
    state.topicDeleteConfirm = { topicId, topicTitle, step: 'reason' }
    state.topicDeleteReason = ''
    state.topicDeleteErrorText = null
    render()
  }

  function closeTopicDeleteConfirm(): void {
    if (state.topicDeleteBusy) return
    state.topicDeleteConfirm = null
    render()
  }

  function updateTopicDeleteReason(reason: string): void {
    state.topicDeleteReason = reason
  }

  // Двустъпков confirm (защита от accidental single-click deletion, брифа
  // т.5) — 'reason' стъпката пази причината и минава към 'confirm', 'confirm'
  // стъпката реално изпраща DELETE заявката.
  function advanceTopicDeleteConfirm(): void {
    const pending = state.topicDeleteConfirm
    if (!pending) return
    const reason = state.topicDeleteReason.trim()
    if (reason.length === 0) {
      state.topicDeleteErrorText = 'Моля, въведи причина.'
      render()
      return
    }
    state.topicDeleteErrorText = null
    state.topicDeleteConfirm = { ...pending, step: 'confirm' }
    render()
  }

  async function confirmTopicDelete(): Promise<void> {
    const pending = state.topicDeleteConfirm
    if (!pending || state.topicDeleteBusy) return

    state.topicDeleteBusy = true
    state.topicDeleteErrorText = null
    render()

    const result = await options.onTopicDelete?.(pending.topicId, state.topicDeleteReason.trim())
    state.topicDeleteBusy = false

    if (!result || !result.ok) {
      state.topicDeleteErrorText = result?.message ?? 'Грешка при изтриване на темата.'
      render()
      return
    }

    state.topicDeleteConfirm = null
    render()
    // Realtime topic_deleted push (публичен broadcast) ще прибере ВСИЧКИ
    // subscribers (вкл. самия actor, ако е subscribed) обратно в Topics
    // directory — виж handleServerMessage. Не дублираме навигацията тук.
  }

  // Single-step confirm (за разлика от двустъпковия topicDeleteConfirm по-горе
  // — individual-message delete няма reason field, брифа §19). isRoot +
  // isModeratorAction заедно определят confirmation текста: moderator root
  // delete предупреждава за "и всички отговори" (established, thread-wide),
  // ordinary own-root delete НЕ споменава replies (по дефиниция е 0-replies
  // — own-delete-own-content брифа §24). Server-side поведението вече е
  // determined от action capability-то (isModeratorAction), не от UI текста.
  function openTopicMessageDeleteConfirm(topicId: string, messageId: string, isRoot: boolean, isModeratorAction: boolean): void {
    state.topicMessageDeleteConfirm = { topicId, messageId, isRoot, isModeratorAction }
    state.topicMessageDeleteErrorText = null
    render()
  }

  function closeTopicMessageDeleteConfirm(): void {
    if (state.topicMessageDeleteBusy) return
    state.topicMessageDeleteConfirm = null
    render()
  }

  function showTopicsInfoToast(text: string): void {
    state.topicsInfoToast = { text }
    render()
    window.setTimeout(() => {
      if (state.topicsInfoToast?.text === text) {
        state.topicsInfoToast = null
        render()
      }
    }, 3000)
  }

  async function confirmTopicMessageDelete(): Promise<void> {
    const pending = state.topicMessageDeleteConfirm
    if (!pending || state.topicMessageDeleteBusy) return

    state.topicMessageDeleteBusy = true
    state.topicMessageDeleteErrorText = null
    render()

    const result = await options.onTopicMessageDelete?.(pending.topicId, pending.messageId)
    state.topicMessageDeleteBusy = false

    if (!result || !result.ok) {
      state.topicMessageDeleteErrorText = result?.message ?? 'Грешка при изтриване на съобщението.'
      render()
      return
    }

    state.topicMessageDeleteConfirm = null
    render()
    // Realtime topic_message_deleted push (публичен broadcast) ще махне
    // съобщението/thread-а за ВСИЧКИ subscribers (вкл. самия actor) — виж
    // handleServerMessage. Не дублираме local state mutation тук (same-instance
    // broadcast стига и до самия originator, mirror на confirmTopicDelete).
  }

  function findLoadedTopicMessage(messageId: string): TopicMessageSnapshot | TopicReplySnapshot | null {
    const rootMessage = state.topicMessages?.find((m) => m.messageId === messageId) ?? null
    if (rootMessage) return rootMessage

    for (const replies of Object.values(state.topicRepliesByRootId)) {
      const reply = replies?.find((r) => r.messageId === messageId) ?? null
      if (reply) return reply
    }
    return null
  }

  function applyTopicMessageEdit(messageId: string, parentMessageId: string | null, body: string, editedAt: string): boolean {
    let changed = false
    if (parentMessageId === null) {
      if (state.topicMessages) {
        state.topicMessages = state.topicMessages.map((message) => {
          if (message.messageId !== messageId) return message
          changed = true
          return { ...message, body, editedAt }
        })
      }
      return changed
    }

    const replies = state.topicRepliesByRootId[parentMessageId]
    if (!replies) return false
    state.topicRepliesByRootId[parentMessageId] = replies.map((reply) => {
      if (reply.messageId !== messageId) return reply
      changed = true
      return { ...reply, body, editedAt }
    })
    return changed
  }

  // Realtime mute indicator icon (mute indicator брифа §7) — обновява
  // isTopicsSectionMuted за ВСИЧКИ locally-loaded съобщения/replies на
  // profileId-я, независимо от кой root thread идват (потребителят може да
  // има няколко expanded thread-а едновременно). НЕ пипа
  // activeTopicViewerMute/topicsSectionMutePopupOpen (viewer-own mute state,
  // напълно отделен от чужд author indicator, виж topic_mute_state_changed
  // handler-а).
  function applyTopicsSectionMuteIndicatorChange(profileId: string, isTopicsSectionMuted: boolean): boolean {
    let changed = false
    if (state.topicMessages) {
      state.topicMessages = state.topicMessages.map((message) => {
        if (message.senderProfileId !== profileId || message.isTopicsSectionMuted === isTopicsSectionMuted) return message
        changed = true
        return { ...message, isTopicsSectionMuted }
      })
    }
    for (const rootMessageId of Object.keys(state.topicRepliesByRootId)) {
      const replies = state.topicRepliesByRootId[rootMessageId]
      if (!replies) continue
      state.topicRepliesByRootId[rootMessageId] = replies.map((reply) => {
        if (reply.senderProfileId !== profileId || reply.isTopicsSectionMuted === isTopicsSectionMuted) return reply
        changed = true
        return { ...reply, isTopicsSectionMuted }
      })
    }
    return changed
  }

  function openTopicMessageEditor(topicId: string, messageId: string): void {
    if (state.topicMessageEditBusy) return
    const message = findLoadedTopicMessage(messageId)
    if (message === null) return
    state.topicMessageEdit = { topicId, messageId, draft: message.body }
    state.topicMessageEditErrorText = null
    render()
  }

  function updateTopicMessageEditDraft(messageId: string, value: string): void {
    if (state.topicMessageEdit?.messageId !== messageId) return
    state.topicMessageEdit = { ...state.topicMessageEdit, draft: value }
  }

  function closeTopicMessageEditor(messageId: string): void {
    if (state.topicMessageEditBusy || state.topicMessageEdit?.messageId !== messageId) return
    state.topicMessageEdit = null
    state.topicMessageEditErrorText = null
    render()
  }

  async function submitTopicMessageEdit(messageId: string): Promise<void> {
    const edit = state.topicMessageEdit
    if (edit === null || edit.messageId !== messageId || state.topicMessageEditBusy) return

    state.topicMessageEditBusy = true
    state.topicMessageEditErrorText = null
    render()

    const result = await options.onTopicMessageEdit?.(edit.topicId, edit.messageId, edit.draft)
    state.topicMessageEditBusy = false

    if (!result || !result.ok) {
      state.topicMessageEditErrorText = result?.message ?? 'Грешка при редактиране на съобщението.'
      render()
      return
    }

    if (result.editedAt !== null) {
      applyTopicMessageEdit(edit.messageId, result.parentMessageId, result.body, result.editedAt)
    }
    state.topicMessageEdit = null
    state.topicMessageEditErrorText = null
    render()
  }

  function openTopicReportPopup(): void {
    state.topicReportPopupOpen = true
    state.topicReportReason = ''
    state.topicReportErrorText = null
    render()
  }

  function closeTopicReportPopup(): void {
    if (state.topicReportBusy) return
    state.topicReportPopupOpen = false
    render()
  }

  function updateTopicReportReason(reason: string): void {
    state.topicReportReason = reason
  }

  async function submitTopicReport(): Promise<void> {
    const topicId = state.activeTopicId
    if (topicId === null || state.topicReportBusy) return

    const reason = state.topicReportReason.trim()
    if (reason.length === 0) {
      state.topicReportErrorText = 'Моля, въведи причина.'
      render()
      return
    }

    state.topicReportBusy = true
    state.topicReportErrorText = null
    render()

    const result = await options.onTopicReport?.(topicId, reason)
    state.topicReportBusy = false

    if (!result || !result.ok) {
      state.topicReportErrorText = result?.code === 'topic_report_duplicate'
        ? 'Вече докладва тази тема наскоро.'
        : (result?.message ?? 'Грешка при докладването.')
      render()
      return
    }

    state.topicReportPopupOpen = false
    state.topicReportSuccessToast = true
    render()
    setTimeout(() => {
      state.topicReportSuccessToast = false
      render()
    }, 3000)
  }

  async function loadAdminTopicReports(status: TopicReportStatus | null): Promise<void> {
    state.adminTopicReportsLoading = true
    state.adminTopicReportsErrorText = null
    state.adminTopicReportsFilter = status
    render()

    const result = await options.onTopicReportsLoad?.(status)

    state.adminTopicReportsLoading = false
    if (!result || !result.ok) {
      state.adminTopicReportsErrorText = result?.message ?? 'Грешка при зареждане на докладите.'
      render()
      return
    }

    state.adminTopicReports = result.reports
    state.adminTopicReportsPendingCount = result.pendingCount
    render()
  }

  async function reviewAdminTopicReport(reportId: string, status: 'reviewed' | 'dismissed'): Promise<void> {
    if (state.adminTopicReportActionBusyId !== null) return
    state.adminTopicReportActionBusyId = reportId
    render()

    const result = await options.onTopicReportReview?.(reportId, status)
    state.adminTopicReportActionBusyId = null

    if (!result || !result.ok) {
      render()
      return
    }

    // Обновяваме локалния списък inline (не re-fetch) — reviewed report
    // излиза от 'pending' филтъра, ако е активен.
    if (state.adminTopicReports) {
      if (state.adminTopicReportsFilter === 'pending') {
        state.adminTopicReports = state.adminTopicReports.filter((r) => r.reportId !== reportId)
      } else {
        state.adminTopicReports = state.adminTopicReports.map((r) => (r.reportId === reportId ? result.report : r))
      }
    }
    state.adminTopicReportsPendingCount = Math.max(0, state.adminTopicReportsPendingCount - (result.report.status !== 'pending' ? 1 : 0))
    render()
  }

  // A) Initial open / topic switch — НЕ reuse-ва стар scroll anchor, зарежда
  // history за новата тема, viewport отива до дъното (последните съобщения)
  // след успешен load. Вика се от showTopicsDirectory() и openTopic().
  //
  // Gap-closing subscribe (Етап 2 корекция т.1): subscribe-ваме СЛЕД REST
  // load-а да е приключил успешно, с afterSeq = seq-а на най-новото
  // съобщение, което REST snapshot-ът току-що ни показа — така всяко
  // съобщение, изпратено В ПРОЗОРЕЦА между snapshot-а и subscribe-а, се
  // доставя чрез topic_message_catchup, никога не се губи.
  async function loadTopicMessagesForActiveTopic(topicId: string): Promise<void> {
    const requestGeneration = ++state.topicMessagesRequestGeneration

    if (!options.onTopicMessagesLoad) {
      state.topicMessagesErrorText = 'Съобщенията временно не са налични.'
      state.topicMessagesLoading = false
      render()
      return
    }

    state.topicMessagesLoading = true
    state.topicMessagesErrorText = null
    render()

    const result = await options.onTopicMessagesLoad(topicId, null)

    // C) Rapid topic switching guard — generation token е monotonic номер на
    // ВСЯКО ново зареждане (не само сравнение по topicId): ако потребителят
    // отвори A→B→A бързо, response за първата (сега "остаряла") заявка за A
    // никога не презаписва по-новата, дори топикId да съвпада отново.
    if (
      state.currentScreen !== 'topics' ||
      state.topicsMode !== 'topics' ||
      state.topicMessagesRequestGeneration !== requestGeneration
    ) {
      return
    }

    state.topicMessagesLoading = false

    if (!result.ok) {
      state.topicMessagesErrorText = result.message
      render()
      return
    }

    state.topicMessages = capLafcheMessagesIfNeeded(topicId, sortTopicMessagesByActivity(result.messages))
    state.topicMessagesHasMore = result.hasMore
    state.topicMessagesOldestSeq = result.oldestSeq
    state.topicMessagesErrorText = null
    state.topicMessagesLatestKnownSeqByTopicId[topicId] = computeLatestSeq(result.messages)
    seedLikeStateFromMessages(result.messages)
    // Viewport към последните съобщения — render() тук е последван от
    // scroll-to-bottom логиката в renderLobbyScreen.ts (виж
    // savedTopicMessagesDistanceFromBottom === null клона).
    state.topicMessagesRenderReason = 'initial'
    render()

    // Все още на СЪЩАТА тема (generation guard-ът по-горе вече потвърди) —
    // едва СЕГА regisтрираме WS interest, с прясно изчисления gap-closing cursor.
    subscribeToTopicMessagesGapClosing(topicId)
    void markActiveTopicSeen(topicId)
  }

  async function showTopicsDirectory(): Promise<void> {
    leaveAdminServerIfActive()
    unsubscribeFromCurrentTopicMessages()
    state.currentScreen = 'topics'
    state.topicsMode = 'topics'
    state.topicsPersonalView = 'list'
    state.topicThreadRootMessageId = null
    state.topicThreadReturnScrollAnchor = null
    state.topicThreadRenderReason = null
    clearTopicsPersonalTransientState()
    state.topicsInfoToast = null
    state.profilePopupOpen = false
    state.profilePopupProfile = null
    state.profilePopupCanEdit = true
    stopWaitingRoomActivity()
    resetFinalFillSequence()
    // Force-refresh (НЕ lazy-guard-нат ensureTopicsVipGateLoaded) — всяко
    // влизане в "Теми" трябва да вижда СВЕЖ VIP статус, огледално на
    // onTopicsLoad по-долу (той също не е lazy-cached). Без това, ако VIP
    // статусът се промени между две посещения на екрана в СЪЩАТА сесия (claim
    // от друг таб, expiry), composer gating-ът би останал заклещен на
    // остарялата стойност до hard reload.
    void refreshTopicsVipGateStatus()
    if ((options.getAuthSession?.() ?? null) !== null && options.onChatConversationsLoad) {
      void loadChatConversations().then(() => {
        if (state.currentScreen === 'topics') {
          render()
        }
      })
    }

    if (!options.onTopicsLoad) {
      state.topicsErrorText = 'Списъкът с теми временно не е наличен.'
      render()
      return
    }

    state.topicsLoading = true
    state.topicsErrorText = null
    render()

    const result = await options.onTopicsLoad()

    if (state.currentScreen !== 'topics') {
      return
    }

    state.topicsLoading = false

    if (!result.ok) {
      state.topicsErrorText = result.message
      render()
      return
    }

    state.topics = result.topics
    state.topicsLoadedForProfileId = (options.getAuthSession?.() ?? null)?.profile.profileId ?? state.topicsLoadedForProfileId
    state.topicsErrorText = null

    // Directory-wide realtime interest — subscribe-ваме СЛЕД REST loadTopics()
    // да е приключил успешно (established gap-closing convention, mirror на
    // subscribeToTopicMessagesGapClosing по-долу), за да не пропуснем
    // теми създадени В прозореца между snapshot-а и subscribe-а — те просто
    // ще пристигнат и през REST snapshot-а (ако insert-нати преди loadTopics
    // отговори), и през WS broadcast (ако insert-нати след), upsert-ът в
    // handleTopicCreatedBroadcast е idempotent за двата случая.
    subscribeToTopicsDirectory()

    // При вход в "Теми" отваряме "Общ чат" по подразбиране (т.2/8 от брифа).
    const generalTopic = result.topics.find((t) => t.isGeneral) ?? result.topics[0] ?? null
    state.activeTopicId = generalTopic?.topicId ?? null
    if (state.activeTopicId !== null && !isGeneralTopicId(state.activeTopicId)) {
      updateTopicUnreadCount(state.activeTopicId, 0)
    }
    state.topicMessages = null
    state.topicMessagesHasMore = false
    state.topicMessagesOldestSeq = null
    // Lock state derive-нат directno от TopicSnapshot (вече носи
    // lockedUntil/lockedReason от REST list-а) — не отделен REST call.
    // Mute state (section-wide, НЕ per-topic) — populate-нато ТУК от
    // result.viewerSectionMute (REST, /api/topics), за да покрие "entering
    // Topics с вече активен mute"/refresh/reconnect (regression fix, брифа
    // §6) — преди тази корекция activeTopicViewerMute се populate-ваше
    // ИЗКЛЮЧИТЕЛНО от realtime topic_mute_state_changed push (target-only),
    // докато viewer-ът е вече свързан, значи вече активен mute от ПРЕДИ
    // текущата сесия/refresh никога не се виждаше от composer-а. Realtime
    // push-ът (виж handleServerMessage) продължава да важи за НОВ mute,
    // наложен докато потребителят вече е в "Теми".
    state.activeTopicLock = generalTopic ? deriveTopicLockSnapshot(generalTopic) : null
    state.activeTopicViewerMute = result.viewerSectionMute
      ? { isMuted: result.viewerSectionMute.isMuted, mutedUntil: result.viewerSectionMute.mutedUntil, mutedByAccountId: null, reason: result.viewerSectionMute.reason }
      : null
    // Trigger B (mute popup брифа): entering "Теми" с вече активен mute →
    // popup веднага, не само composer readonly (evaluateTopicsSectionMutePopup
    // е ack-gated — няма да се отвори повторно, ако вече е било "Разбрах"-нато
    // за ТОЗИ конкретен mutedUntil).
    evaluateTopicsSectionMutePopup()
    render()

    if (state.activeTopicId) {
      void loadTopicMessagesForActiveTopic(state.activeTopicId)
    }
  }

  function openTopic(topicId: string): void {
    state.topicsMode = 'topics'
    state.topicsPersonalView = 'list'
    state.topicThreadRootMessageId = null
    state.topicThreadReturnScrollAnchor = null
    state.topicThreadRenderReason = null
    clearTopicsPersonalTransientState()
    state.topicsInfoToast = null
    if (state.activeTopicId === topicId) return
    // Стъпка 1 от gap-closing flow-а (Етап 2 корекция т.1): unsubscribe от
    // старата тема ПРЕДИ каквото и да е друго — иначе push-ове за вече
    // напуснатата тема биха продължили да пристигат.
    unsubscribeFromCurrentTopicMessages()
    state.activeTopicId = topicId
    if (!isGeneralTopicId(topicId)) {
      updateTopicUnreadCount(topicId, 0)
    }
    state.topicMessages = null
    state.topicMessagesHasMore = false
    state.topicMessagesOldestSeq = null
    state.topicMessagesErrorText = null
    state.topicOlderMessagesLoading = false
    const switchedTopic = (state.topics ?? []).find((t) => t.topicId === topicId) ?? null
    state.activeTopicLock = switchedTopic ? deriveTopicLockSnapshot(switchedTopic) : null
    // activeTopicViewerMute НЕ се reset-ва тук (regression fix, брифа §6
    // adjacent gap) — section-wide mute важи независимо от коя тема е
    // активна, затова вече известният snapshot (populate-нат при вход в
    // "Теми", виж showTopicsDirectory) остава валиден и след превключване
    // на тема, вместо да се губи до следващия realtime push.
    render()
    // loadTopicMessagesForActiveTopic инкрементира generation token-а
    // СИНХРОННО (преди първия await) — това "убива" всяка still-pending
    // load-older заявка от старата тема веднага, без нужда от отделен
    // increment тук.
    void loadTopicMessagesForActiveTopic(topicId)
  }

  function backToGeneralTopic(): void {
    if (state.topicsMode === 'thread') {
      closeTopicThreadToGeneral()
      return
    }
    const generalTopic = (state.topics ?? []).find((t) => t.isGeneral) ?? null
    if (generalTopic) openTopic(generalTopic.topicId)
  }

  function captureTopicMessagesScrollAnchor(): { messageId: string; top: number } | null {
    const scrollEl = options.root.querySelector<HTMLElement>('[data-topic-messages-scroll="1"]')
    if (scrollEl === null) return null
    const scrollRect = scrollEl.getBoundingClientRect()
    const anchorEl = Array.from(scrollEl.querySelectorAll<HTMLElement>('[data-topic-message]'))
      .find((el) => el.getBoundingClientRect().bottom >= scrollRect.top)
    return anchorEl
      ? { messageId: anchorEl.dataset.topicMessage ?? '', top: anchorEl.getBoundingClientRect().top }
      : null
  }

  function captureTopicMessagesDistanceFromBottom(): number | null {
    const scrollEl = options.root.querySelector<HTMLElement>('[data-topic-messages-scroll="1"]')
    return scrollEl === null ? null : scrollEl.scrollHeight - scrollEl.scrollTop
  }

  function restoreTopicMessagesScrollAnchor(anchor: { messageId: string; top: number } | null): boolean {
    if (anchor === null || anchor.messageId.length === 0) return false
    const scrollEl = options.root.querySelector<HTMLElement>('[data-topic-messages-scroll="1"]')
    if (scrollEl === null) return false
    const anchorEl = Array.from(scrollEl.querySelectorAll<HTMLElement>('[data-topic-message]'))
      .find((el) => el.dataset.topicMessage === anchor.messageId) ?? null
    if (anchorEl === null) return false
    scrollEl.scrollTop += anchorEl.getBoundingClientRect().top - anchor.top
    return true
  }

  function restoreTopicMessagesDistanceFromBottom(distanceFromBottom: number | null): void {
    if (distanceFromBottom === null) return
    const scrollEl = options.root.querySelector<HTMLElement>('[data-topic-messages-scroll="1"]')
    if (scrollEl === null) return
    scrollEl.scrollTop = scrollEl.scrollHeight - distanceFromBottom
  }

  let topicThreadHistoryPushed = false

  function findLoadedTopicRootMessage(rootMessageId: string): TopicMessageSnapshot | null {
    return (state.topicMessages ?? []).find((m) => m.messageId === rootMessageId) ?? null
  }

  function pushTopicThreadHistory(): void {
    try {
      if (topicThreadHistoryPushed) return
      history.pushState({ ...(history.state ?? {}), pikaTopicsThread: true }, '')
      topicThreadHistoryPushed = true
    } catch {
      topicThreadHistoryPushed = false
    }
  }

  function openTopicThread(rootMessageId: string, scrollAnchor: { messageId: string; top: number } | null = null): void {
    if (findLoadedTopicRootMessage(rootMessageId) === null) return

    const currentAnchor = scrollAnchor ?? captureTopicMessagesScrollAnchor()
    state.currentScreen = 'topics'
    state.topicsMode = 'thread'
    state.topicsPersonalView = 'list'
    clearTopicsPersonalTransientState()
    state.topicThreadRootMessageId = rootMessageId
    state.topicThreadReturnScrollAnchor = currentAnchor
    state.topicThreadRenderReason = 'initial'
    state.topicReplyComposerOpenRootId = rootMessageId
    if (!state.topicExpandedReplyRootIds.includes(rootMessageId)) {
      state.topicExpandedReplyRootIds = [...state.topicExpandedReplyRootIds, rootMessageId]
    }
    pushTopicThreadHistory()
    render()
    void markTopicThreadSeen(rootMessageId)
    void expandReplyThread(rootMessageId)
  }

  function closeTopicThreadToGeneral(): void {
    const returnAnchor = state.topicThreadReturnScrollAnchor
    state.topicsMode = 'topics'
    state.topicsPersonalView = 'list'
    state.topicThreadRootMessageId = null
    state.topicThreadReturnScrollAnchor = null
    state.topicThreadRenderReason = null
    state.topicReplyComposerOpenRootId = null
    state.topicMessagesScrollAnchor = returnAnchor
    render()
  }

  function handleTopicThreadPopstate(): boolean {
    if (state.currentScreen !== 'topics' || state.topicsMode !== 'thread') return false
    topicThreadHistoryPushed = false
    closeTopicThreadToGeneral()
    return true
  }

  function isTopicMessagesNearTop(thresholdPx = 96): boolean {
    const scrollEl = options.root.querySelector<HTMLElement>('[data-topic-messages-scroll="1"]')
    return scrollEl === null || scrollEl.scrollTop <= thresholdPx
  }

  // B) Load older в СЪЩАТА тема — НЕ инкрементира generation token-а (не е
  // "нов switch", а продължение на текущия), но капсулира текущата стойност
  // при старт, за да засече дали потребителят е превключил тема междувременно
  // (openTopic/showTopicsDirectory инкрементират generation-а при switch).
  async function loadOlderTopicMessages(): Promise<void> {
    const topicId = state.activeTopicId
    const requestGeneration = state.topicMessagesRequestGeneration
    // "Лафче" НЯМА older pagination by design, независимо от hasMore/DB
    // history (production hotfix — root cause audit-а) — structural guard
    // ТУК, на самото action ниво, не само на scroll-trigger-а по-горе, за
    // да остане валиден дори ако бъде добавен бъдещ друг call site.
    if (
      topicId === null ||
      topicId === LAFCHE_TOPIC_ID ||
      state.topicOlderMessagesLoading ||
      !state.topicMessagesHasMore ||
      state.topicMessagesOldestSeq === null ||
      !options.onTopicMessagesLoad
    ) {
      return
    }

    const scrollAnchor = captureTopicMessagesScrollAnchor()
    const scrollDistanceFromBottom = captureTopicMessagesDistanceFromBottom()
    state.topicOlderMessagesLoading = true
    render()

    const result = await options.onTopicMessagesLoad(topicId, state.topicMessagesOldestSeq)

    // Ако потребителят е превключил тема междувременно (generation token се
    // е сменил), изхвърляме резултата — той принадлежи на вече напусната
    // тема (т.3B/C от брифа).
    if (
      state.currentScreen !== 'topics' ||
      state.topicsMode !== 'topics' ||
      state.topicMessagesRequestGeneration !== requestGeneration
    ) {
      return
    }

    state.topicOlderMessagesLoading = false

    if (!result.ok) {
      render()
      return
    }

    // Prepend по-старите съобщения пред вече заредените (старо→ново ред).
    // (topicId тук никога не е Lafche — guard-нато в началото на функцията —
    // но capLafcheMessagesIfNeeded е no-op за не-Lafche, пазим defense-in-depth.)
    state.topicMessages = capLafcheMessagesIfNeeded(topicId, mergeTopicMessages(state.topicMessages ?? [], result.messages))
    state.topicMessagesHasMore = result.hasMore
    state.topicMessagesOldestSeq = result.oldestSeq ?? state.topicMessagesOldestSeq
    seedLikeStateFromMessages(result.messages)
    state.topicMessagesScrollAnchor = scrollAnchor
    state.topicMessagesRenderReason = 'prepend'
    render()
    restoreTopicMessagesDistanceFromBottom(scrollDistanceFromBottom)
    restoreTopicMessagesScrollAnchor(scrollAnchor)
  }

  // ─── Replies expand/collapse/pagination (Етап 3) ────────────────────────
  // Toggle behavior-ът живее директно в onTopicReplyClick bridge-а по-горе
  // (collapse при повторен click на VIP viewer) — тук само примитивите.

  async function expandReplyThread(rootMessageId: string): Promise<void> {
    state.topicExpandedReplyRootIds = [...state.topicExpandedReplyRootIds, rootMessageId]

    // Кешираните replies (ако има) се показват веднага — но кеш presence
    // само по себе си НЕ означава свежест (виж bug report: потребител не е
    // бил subscribed за темата докато е стоял extra replies, badge-only WS
    // push никога не пипа topicRepliesByRootId). Затова reconcile-ваме с
    // REST при ВСЯКО отваряне/reopen, а не само при cold load.
    const cachedReplies = state.topicRepliesByRootId[rootMessageId]
    const hasCachedReplies = cachedReplies !== undefined && cachedReplies !== null
    render()

    const topicId = state.activeTopicId
    if (topicId === null || !options.onTopicRepliesLoad) return

    // Gap-closing fetch: ако вече има кеш, искаме само replies СЛЕД най-новия
    // познат seq (forward cursor, mirror на loadMoreReplies) — не пълен
    // re-fetch от началото, за да не разваляме вече заредена по-стара
    // история/hasMore pagination state. Без кеш → cold-load (afterSeq=null).
    const afterSeq = hasCachedReplies && cachedReplies.length > 0
      ? cachedReplies[cachedReplies.length - 1]!.seq
      : null

    state.topicRepliesLoadingByRootId[rootMessageId] = true
    render()

    const result = await options.onTopicRepliesLoad(topicId, rootMessageId, afterSeq)

    // Stale-response guard — потребителят може вече да е превключил тема
    // или collapse-нал thread-а, докато заявката е висяла.
    const isCurrentThread = state.topicsMode === 'thread' && state.topicThreadRootMessageId === rootMessageId
    if (state.activeTopicId !== topicId || (!state.topicExpandedReplyRootIds.includes(rootMessageId) && !isCurrentThread)) {
      state.topicRepliesLoadingByRootId[rootMessageId] = false
      return
    }

    state.topicRepliesLoadingByRootId[rootMessageId] = false

    if (!result.ok) {
      render()
      return
    }

    // Merge по messageId (dedup) — server response е authoritative за
    // съдържанието на всеки reply, но не изхвърляме вече заредени по-стари
    // replies (напр. от предишен loadMoreReplies) извън тази страница.
    const existing = state.topicRepliesByRootId[rootMessageId] ?? []
    const byId = new Map<string, TopicReplySnapshot>()
    for (const r of existing) byId.set(r.messageId, r)
    for (const r of result.replies) byId.set(r.messageId, r)
    // Tombstone reconciliation — getRepliesAfter само добавя НОВИ seq-ове,
    // никога не "маха" вече кеширани replies, изтрити СЛЕД като клиентът ги
    // е кеширал (виж deletedMessageIds коментара в handleTopicRepliesRequest).
    // Само gap-closing reconcile носи tombstone списък (cold load го праща
    // празен, защото няма съществуващ кеш за reconcile).
    for (const deletedId of result.deletedMessageIds ?? []) {
      byId.delete(deletedId)
    }
    state.topicRepliesByRootId[rootMessageId] = [...byId.values()].sort((a, b) => a.seq - b.seq)
    // hasMore/oldestSeq отразяват само "load more назад" пагинацията — при
    // gap-closing (afterSeq !== null) не презаписваме вече установен hasMore
    // с резултат от различна (forward) заявка.
    if (afterSeq === null) {
      state.topicRepliesHasMoreByRootId[rootMessageId] = result.hasMore
    }
    // Seed-ва like state за replies от load-а (виж т.13 — likeCount/
    // viewerHasLiked overrides идват от WS/REST, отделно от самия snapshot).
    for (const reply of result.replies) {
      state.topicMessageLikeCountById[reply.messageId] = reply.likeCount
      state.topicMessageViewerHasLikedById[reply.messageId] = reply.viewerHasLiked
    }
    if (isCurrentThread) {
      state.topicThreadRenderReason = hasCachedReplies ? (state.topicThreadRenderReason ?? 'live-append') : 'initial'
    }
    render()
  }

  async function loadMoreReplies(rootMessageId: string): Promise<void> {
    const topicId = state.activeTopicId
    const existing = state.topicRepliesByRootId[rootMessageId]
    if (
      topicId === null ||
      !options.onTopicRepliesLoad ||
      existing === undefined ||
      existing === null ||
      state.topicRepliesLoadingByRootId[rootMessageId] ||
      !state.topicRepliesHasMoreByRootId[rootMessageId]
    ) {
      return
    }

    const lastKnownSeq = existing.length > 0 ? existing[existing.length - 1]!.seq : null
    if (lastKnownSeq === null) return

    state.topicRepliesLoadingByRootId[rootMessageId] = true
    render()

    const result = await options.onTopicRepliesLoad(topicId, rootMessageId, lastKnownSeq)

    const isCurrentThread = state.topicsMode === 'thread' && state.topicThreadRootMessageId === rootMessageId
    if (state.activeTopicId !== topicId || (!state.topicExpandedReplyRootIds.includes(rootMessageId) && !isCurrentThread)) {
      state.topicRepliesLoadingByRootId[rootMessageId] = false
      return
    }

    state.topicRepliesLoadingByRootId[rootMessageId] = false

    if (!result.ok) {
      render()
      return
    }

    const currentReplies = state.topicRepliesByRootId[rootMessageId] ?? []
    const byId = new Map<string, TopicReplySnapshot>()
    for (const r of currentReplies) byId.set(r.messageId, r)
    for (const r of result.replies) byId.set(r.messageId, r)
    state.topicRepliesByRootId[rootMessageId] = [...byId.values()].sort((a, b) => a.seq - b.seq)
    state.topicRepliesHasMoreByRootId[rootMessageId] = result.hasMore
    for (const reply of result.replies) {
      state.topicMessageLikeCountById[reply.messageId] = reply.likeCount
      state.topicMessageViewerHasLikedById[reply.messageId] = reply.viewerHasLiked
    }
    render()
  }

  // ─── Likes (Етап 3) ──────────────────────────────────────────────────────

  const TOPIC_MESSAGE_LIKE_ACK_TIMEOUT_MS = 5000

  /**
   * Optimistic toggle (т.13 от плана): flip-ва локално веднага при click,
   * задава pending requestId, и разчита на topic_message_like_changed_self
   * (виж WS message handler-а по-горе) да reconcile-не с authoritative
   * сървърен отговор. Ако ack не пристигне в TOPIC_MESSAGE_LIKE_ACK_TIMEOUT_MS
   * (network issue / dropped message), revert-ваме към ПОСЛЕДНОТО ПОЗНАТО
   * сървърно състояние (capture-нато ПРЕДИ optimistic flip-а) — НЕ towards
   * противоположния на optimistic guess-а, защото друг realtime update може
   * вече легитимно да е изместил count-а междувременно.
   */
  function submitTopicMessageLikeToggle(messageId: string): void {
    if (!options.onTopicMessageLikeToggle) return
    if (state.topicMessageLikePendingRequestIdById[messageId]) return // вече чакаме ack за този message

    const requestId = `topic-like-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    const priorCount = state.topicMessageLikeCountById[messageId] ?? 0
    const priorViewerHasLiked = state.topicMessageViewerHasLikedById[messageId] ?? false

    state.topicMessageLikeCountById[messageId] = priorViewerHasLiked ? priorCount - 1 : priorCount + 1
    state.topicMessageViewerHasLikedById[messageId] = !priorViewerHasLiked
    state.topicMessageLikePendingRequestIdById[messageId] = requestId
    render()

    options.onTopicMessageLikeToggle(messageId, requestId)

    setTimeout(() => {
      if (state.topicMessageLikePendingRequestIdById[messageId] !== requestId) return // вече reconciled от ack/error
      state.topicMessageLikePendingRequestIdById[messageId] = null
      state.topicMessageLikeCountById[messageId] = priorCount
      state.topicMessageViewerHasLikedById[messageId] = priorViewerHasLiked
      render()
    }, TOPIC_MESSAGE_LIKE_ACK_TIMEOUT_MS)
  }

  // ─── Reply composer (Етап 3) — огледално на root composer (submitTopicComposerMessage) ──

  function updateTopicReplyComposerDraft(rootMessageId: string, value: string): void {
    state.topicReplyComposerDraftByRootId[rootMessageId] = value
  }

  function closeInlineReplyComposer(rootMessageId: string): void {
    if (state.topicReplyComposerOpenRootId === rootMessageId) {
      state.topicReplyComposerOpenRootId = null
      render()
    }
  }

  function handleTopicReplyComposerNonVipTap(): void {
    openTopicsVipPopup()
  }

  function submitTopicReplyComposerMessage(rootMessageId: string): void {
    const topicId = state.activeTopicId
    if (topicId === null) return

    const draft = state.topicReplyComposerDraftByRootId[rootMessageId] ?? ''
    const trimmed = draft.trim()
    const pendingImage = state.topicReplyComposerPendingImageByRootId[rootMessageId] ?? null
    if (trimmed.length === 0 && pendingImage === null) return
    if (state.topicReplyComposerPendingRequestIdByRootId[rootMessageId]) return

    if (!(state.topicsVipGate?.isActive ?? false)) {
      openTopicsVipPopup()
      return
    }

    // GLOBAL TOPICS MUTE брифа §11 — виж isLocallyKnownTopicsSectionMuted коментара.
    if (isLocallyKnownTopicsSectionMuted()) {
      state.topicReplyComposerErrorTextByRootId[rootMessageId] = formatTopicsSectionMuteErrorText(
        state.activeTopicViewerMute?.mutedUntil ?? null,
        state.activeTopicViewerMute?.reason ?? null,
      )
      render()
      return
    }

    const requestId = `topic-reply-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    state.topicReplyComposerPendingRequestIdByRootId[rootMessageId] = requestId
    state.topicReplyComposerErrorTextByRootId[rootMessageId] = null
    render()

    if (pendingImage === null) {
      options.onTopicReplySend?.(topicId, rootMessageId, trimmed, requestId)
      return
    }

    void readFileAsDataUrl(pendingImage.file)
      .then((imageDataUrl) => {
        options.onTopicReplySend?.(topicId, rootMessageId, trimmed, requestId, imageDataUrl)
      })
      .catch(() => {
        state.topicReplyComposerPendingRequestIdByRootId[rootMessageId] = null
        state.topicReplyComposerErrorTextByRootId[rootMessageId] = 'Снимката не можа да бъде прочетена. Опитайте отново.'
        render()
      })
  }

  // ─── Realtime merge/dedupe (Етап 2) ─────────────────────────────────────

  /** Dedupe по messageId, ordering по seq — единна merge функция за REST history / live WS push / catch-up (Етап 2 корекция т.8). */
  function getTopicMessageActivityMs(message: TopicMessageSnapshot): number {
    const activityMs = Date.parse(message.lastActivityAt)
    if (Number.isFinite(activityMs)) return activityMs
    const createdMs = Date.parse(message.createdAt)
    return Number.isFinite(createdMs) ? createdMs : 0
  }

  function sortTopicMessagesByActivity(messages: readonly TopicMessageSnapshot[]): TopicMessageSnapshot[] {
    return [...messages].sort((a, b) => {
      const activityDelta = getTopicMessageActivityMs(b) - getTopicMessageActivityMs(a)
      if (activityDelta !== 0) return activityDelta
      return b.seq - a.seq
    })
  }

  function mergeTopicMessages(
    existing: readonly TopicMessageSnapshot[],
    incoming: readonly TopicMessageSnapshot[],
  ): TopicMessageSnapshot[] {
    if (incoming.length === 0) return [...existing]
    const byId = new Map<string, TopicMessageSnapshot>()
    for (const m of existing) byId.set(m.messageId, m)
    for (const m of incoming) byId.set(m.messageId, m)
    return sortTopicMessagesByActivity([...byId.values()])
  }

  // Lafche state defense-in-depth cap (EMERGENCY production hotfix — root
  // cause audit-а: unbounded merge growth през spontaneously re-triggered
  // "load older", viж loadOlderTopicMessages guard-а по-горе). Lafche по
  // design НЯМА history отвъд последните LAFCHE_MESSAGE_HISTORY_LIMIT (в
  // момента 200, emergency-намалено от 300 — viж renderTopicsScreen.ts
  // коментара) — прилага се СЛЕД sortTopicMessagesByActivity/
  // mergeTopicMessages (вече newest-first, потвърдено в audit-а), затова
  // `.slice(0, LIMIT)` пази именно canonical newest N, реже само
  // по-старите опашка елементи. Server initial REST load все още може
  // временно да върне до 300 (server-side retention е отделен, still-
  // unfinished etap) — този cap прилага client-side hard ceiling НЕЗАВИСИМО
  // от server batch размера. Normal Topics (различен topicId) минават
  // непроменени — техният pagination/"load older" разчита на пълния
  // зареден range.
  function capLafcheMessagesIfNeeded(
    topicId: string,
    messages: readonly TopicMessageSnapshot[],
  ): TopicMessageSnapshot[] {
    if (topicId !== LAFCHE_TOPIC_ID || messages.length <= LAFCHE_MESSAGE_HISTORY_LIMIT) {
      return [...messages]
    }
    return messages.slice(0, LAFCHE_MESSAGE_HISTORY_LIMIT)
  }

  // Етап 3 — likeCount/viewerHasLiked "override" state-ът се захранва от
  // ВСЯКО място, откъдето root TopicMessageSnapshot[]/единично съобщение
  // влиза в state.topicMessages (initial load, load older, live-append,
  // catch-up, reconnect refresh) — единна точка, за да не забравим някой от
  // множеството call sites. Overwrite безусловно (не merge/max) — REST/WS
  // винаги носи canonical snapshot към момента на fetch-а.
  function seedLikeStateFromMessages(messages: readonly { messageId: string; likeCount: number; viewerHasLiked: boolean }[]): void {
    for (const m of messages) {
      state.topicMessageLikeCountById[m.messageId] = m.likeCount
      state.topicMessageViewerHasLikedById[m.messageId] = m.viewerHasLiked
    }
  }

  function updateLatestKnownSeqFromMessages(topicId: string, messages: readonly TopicMessageSnapshot[]): void {
    const incomingMax = computeLatestSeq(messages)
    const current = state.topicMessagesLatestKnownSeqByTopicId[topicId] ?? 0
    if (incomingMax > current) {
      state.topicMessagesLatestKnownSeqByTopicId[topicId] = incomingMax
    }
  }

  // Truncated catch-up (Етап 2 корекция т.1/т.8) — падаме обратно на обикновен
  // REST recent refresh (същата функция като initial load), merge-нат по
  // messageId. НЕ форсираме scroll до дъното — 'reconnect-refresh' се третира
  // като live-append (near-bottom threshold) в renderLobbyScreen.ts, за да не
  // издърпаме насила потребител, който в момента чете стари съобщения.
  async function refreshTopicMessagesAfterTruncatedCatchup(topicId: string): Promise<void> {
    if (!options.onTopicMessagesLoad || state.activeTopicId !== topicId) return
    const scrollAnchor = captureTopicMessagesScrollAnchor()
    const result = await options.onTopicMessagesLoad(topicId, null)
    if (state.currentScreen !== 'topics' || state.activeTopicId !== topicId) return
    if (!result.ok) return
    state.topicMessages = capLafcheMessagesIfNeeded(topicId, mergeTopicMessages(state.topicMessages ?? [], result.messages))
    state.topicMessagesHasMore = result.hasMore
    state.topicMessagesOldestSeq = result.oldestSeq
    updateLatestKnownSeqFromMessages(topicId, result.messages)
    seedLikeStateFromMessages(result.messages)
    state.topicMessagesScrollAnchor = scrollAnchor
    state.topicMessagesRenderReason = 'reconnect-refresh'
    render()
  }

  async function refreshTopicMessagesAfterActivityChange(topicId: string): Promise<void> {
    if (!options.onTopicMessagesLoad || state.activeTopicId !== topicId) return
    const scrollAnchor = captureTopicMessagesScrollAnchor()
    const result = await options.onTopicMessagesLoad(topicId, null)
    if (state.currentScreen !== 'topics' || state.activeTopicId !== topicId) return
    if (!result.ok) return
    state.topicMessages = capLafcheMessagesIfNeeded(topicId, mergeTopicMessages(state.topicMessages ?? [], result.messages))
    state.topicMessagesHasMore = result.hasMore
    state.topicMessagesOldestSeq = result.oldestSeq
    updateLatestKnownSeqFromMessages(topicId, result.messages)
    seedLikeStateFromMessages(result.messages)
    state.topicMessagesScrollAnchor = scrollAnchor
    state.topicMessagesRenderReason = 'reorder'
    render()
  }

  /** WS reconnect hook (аналог на forceLobbyChatResubscribeIfOnLobbyScreen) — извиква се от main.ts на всяко WS onOpen. */
  function forceTopicMessagesResubscribeIfOnTopicsScreen(): void {
    if (state.currentScreen !== 'topics' || state.activeTopicId === null) return
    subscribeToTopicMessagesGapClosing(state.activeTopicId)
  }

  /** WS reconnect hook за directory-wide subscription-а (Custom Topic Creation) — mirror на forceTopicMessagesResubscribeIfOnTopicsScreen, извиква се от main.ts на всяко WS onOpen. */
  function forceTopicsDirectoryResubscribeIfOnTopicsScreen(): void {
    if (state.currentScreen !== 'topics' && state.topics === null) return
    // Нова WS connection = server-side subscriber set-ът (keyed по
    // connection.id) вече не съдържа тази връзка — reset локалния флаг, за
    // да не блокира subscribeToTopicsDirectory guard-а ("вече subscribed").
    state.topicsDirectorySubscribed = false
    subscribeToTopicsDirectory()
    if (state.currentScreen === 'topics') {
      void reconcileTopicsDirectoryFromServer()
    } else {
      void refreshTopicsDirectoryMetadata()
    }
  }

  // ─── VIP gate + launch gift (Етап 2) ────────────────────────────────────

  async function ensureTopicsVipGateLoaded(): Promise<void> {
    if (state.topicsVipGate !== null || state.topicsVipGateLoading || !options.onGetTopicsVipGateStatus) {
      return
    }
    state.topicsVipGateLoading = true
    render()
    const result = await options.onGetTopicsVipGateStatus()
    state.topicsVipGateLoading = false
    if (state.currentScreen !== 'topics') {
      return
    }
    if (result.ok) {
      state.topicsVipGate = { isActive: result.isActive, hasClaimedLaunchGift: result.hasClaimedLaunchGift }
    }
    render()
  }

  /** Force re-fetch (не lazy-guard-нат) — ползва се след claim, след vip_required error от сървъра, и след launch-gift race от друг таб (Етап 2 корекция т.5). */
  async function refreshTopicsVipGateStatus(): Promise<void> {
    if (!options.onGetTopicsVipGateStatus) return
    const result = await options.onGetTopicsVipGateStatus()
    if (result.ok) {
      state.topicsVipGate = { isActive: result.isActive, hasClaimedLaunchGift: result.hasClaimedLaunchGift }
    }
    render()
  }

  function openTopicsVipPopup(): void {
    state.topicsVipPopupOpen = true
    state.topicsVipClaimErrorText = null
    state.topicsVipSeePlansMessageVisible = false
    void ensureTopicsVipGateLoaded()
    render()
  }

  function clearTopicsPersonalTransientState(): void {
    state.chatErrorText = null
    state.chatLoading = false
    state.chatMessagesLoading = false
    state.topicsPersonalMessagePendingProfileId = null
    clearPendingVipDmComposeContext()
  }

  // Back/close без SEND (§7/§8/§9/§15.A-D в task spec-а): само локален
  // state reset — 0 backend write, никакъв vip_dm ред е бил създаден, защото
  // create+send стават атомарно едва при действителен SEND.
  function clearPendingVipDmComposeContext(): void {
    state.topicsPersonalPendingRecipient = null
    state.chatDraftByFriendshipId = { ...state.chatDraftByFriendshipId, [PENDING_VIP_DM_UPLOAD_KEY]: '' }
    clearChatPendingImage(PENDING_VIP_DM_UPLOAD_KEY)
  }

  function closeTopicsVipPopup(): void {
    state.topicsVipPopupOpen = false
    state.topicsVipClaimErrorText = null
    state.topicsVipSeePlansMessageVisible = false
    render()
  }

  // ─── Create Topic popup (Custom Topic Creation) ──────────────────────────
  // Lifecycle mirror на tournament create popup-а (openTournamentCreatePopup/
  // closeTournamentCreatePopup/submitTournamentCreate), но fire-and-forget
  // (WS push-driven success/error, не await-нат Promise) — mirror на
  // submitTopicComposerMessage flow-а вместо HTTP request/response стила.

  function openTopicCreatePopup(): void {
    if (state.topicCreateBusy) return
    state.topicCreatePopupOpen = true
    state.topicCreateErrorText = null
    state.topicCreateTitleDraft = ''
    render()
  }

  function closeTopicCreatePopup(): void {
    if (state.topicCreateBusy) return
    state.topicCreatePopupOpen = false
    state.topicCreateErrorText = null
    render()
  }

  function updateTopicCreateTitleDraft(value: string): void {
    state.topicCreateTitleDraft = value
    // Грешката изчезва при следваща промяна (established UX convention,
    // mirror на topicComposerErrorTextByTopicId clearing-a при input).
    state.topicCreateErrorText = null
    render()
  }

  function submitTopicCreate(): void {
    const trimmed = state.topicCreateTitleDraft.trim()
    if (trimmed.length === 0) return
    if (state.topicCreateBusy) return // established idempotency guard

    // GLOBAL TOPICS MUTE брифа §11 — виж isLocallyKnownTopicsSectionMuted коментара.
    if (isLocallyKnownTopicsSectionMuted()) {
      state.topicCreateErrorText = formatTopicsSectionMuteErrorText(
        state.activeTopicViewerMute?.mutedUntil ?? null,
        state.activeTopicViewerMute?.reason ?? null,
      )
      render()
      return
    }

    const requestId = `topic-create-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    state.topicCreatePendingRequestId = requestId
    state.topicCreateBusy = true
    state.topicCreateErrorText = null
    render()

    // Fire-and-forget — БЕЗ await. Резултатът пристига през WS
    // topic_created/topic_create_error push, dispatch-нат в
    // handleServerMessage (виж handleTopicCreateSuccess/handleTopicCreateError).
    options.onTopicCreateSubmit?.(trimmed, requestId)
  }

  function upsertTopicIntoDirectoryState(topic: TopicSnapshot): void {
    if (state.topics === null) {
      state.topics = [topic]
      return
    }
    // Idempotent upsert по topicId — гарантира, че success-response
    // (originator) и directory broadcast (edge-case near-simultaneous
    // timing) никога не създават duplicate chip (spec изисква точно това).
    if (state.topics.some((t) => t.topicId === topic.topicId)) {
      return
    }
    // Append в края — сървърът вече праща в established created_at
    // ascending ред, новата тема е винаги "най-новата" (виж
    // topicStore.listActiveTopics ordering-а), клиентът не пре-сортира локално.
    state.topics = [...state.topics, topic]
  }

  function handleTopicCreateSuccess(topic: TopicSnapshot): void {
    state.topicCreateBusy = false
    state.topicCreatePendingRequestId = null
    state.topicCreatePopupOpen = false
    state.topicCreateErrorText = null
    state.topicCreateTitleDraft = ''
    upsertTopicIntoDirectoryState(topic)
    // Auto-open новата тема (spec т.11 — предпочитано поведение, безопасно
    // тук защото сме гарантирано в Topics директорията в момента на submit).
    openTopic(topic.topicId)
  }

  function handleTopicCreateError(message: string): void {
    state.topicCreateBusy = false
    state.topicCreatePendingRequestId = null
    // Draft НЕ се чисти при грешка (established convention, mirror на topic
    // composer error handling) — popup остава отворен.
    state.topicCreateErrorText = message
    render()
  }

  function handleTopicCreatedBroadcast(topic: TopicSnapshot): void {
    upsertTopicIntoDirectoryState(topic)
    render()
  }

  function subscribeToTopicsDirectory(): void {
    if (state.topicsDirectorySubscribed) return
    state.topicsDirectorySubscribed = true
    options.onTopicsDirectorySubscribe?.()
  }

  function unsubscribeFromTopicsDirectory(): void {
    if (!state.topicsDirectorySubscribed) return
    state.topicsDirectorySubscribed = false
    options.onTopicsDirectoryUnsubscribe?.()
  }

  function handleTopicCreateClick(): void {
    // Reuse на established composer non-VIP tap логиката (виж
    // handleTopicComposerNonVipTap) — server е source of truth, "+" клик е
    // само UX gating, не security boundary.
    if (!(state.topicsVipGate?.isActive ?? false)) {
      openTopicsVipPopup()
      return
    }
    openTopicCreatePopup()
  }

  function showTopicsVipPlansInertMessage(): void {
    // Етап 2 корекция т.5 — НЕ Stripe, НЕ навигация. Само кратко inline съобщение.
    state.topicsVipSeePlansMessageVisible = true
    render()
  }

  async function claimTopicsLaunchGift(): Promise<void> {
    if (state.topicsVipClaimSubmitting || !options.onClaimTopicsLaunchGift) return
    state.topicsVipClaimSubmitting = true
    state.topicsVipClaimErrorText = null
    render()

    const result = await options.onClaimTopicsLaunchGift()
    state.topicsVipClaimSubmitting = false

    if (result.ok) {
      state.topicsVipGate = { isActive: result.isActive, hasClaimedLaunchGift: true }
      if (result.activeUntil !== undefined) {
        state.ownVipActiveUntil = result.activeUntil
        state.ownVipActiveUntilLoadedForProfileId = options.getAuthSession?.()?.profile.profileId ?? state.ownVipActiveUntilLoadedForProfileId
      }
      state.topicsVipPopupOpen = false
      render()
      return
    }

    // already_claimed race (напр. друг таб го е взел междувременно) —
    // re-fetch-ваме canonical статус вместо да покажем статичен error, за да
    // unlock-нем composer-а веднага ако VIP всъщност вече е active (Етап 2 корекция т.5).
    if (result.alreadyClaimed) {
      await refreshTopicsVipGateStatus()
      if (!(state.topicsVipGate?.isActive ?? false)) {
        state.topicsVipClaimErrorText = 'Безплатният VIP подарък вече е използван за този профил.'
      } else {
        state.topicsVipPopupOpen = false
      }
      render()
      return
    }

    state.topicsVipClaimErrorText = 'Възникна грешка. Опитай отново.'
    render()
  }

  // ─── Reusable in-app image viewer (lightbox) ────────────────────────────
  // Feature-agnostic — извиква се от Topics attachment click (и по-късно
  // friend chat, виж т.13 от Attachment брифа). Замества target="_blank"
  // (проблемно за PWA Back button, виж т.11/12) с fullscreen overlay, ВЪТРЕ
  // в приложението. Отварянето push-ва ЕДИН виртуален history entry — пълния
  // decision-logic rationale (вкл. критичния race-condition bug fix между
  // explicit close/history.back()/popstate) е в imageViewerHistoryState.ts.
  //
  // Side-effect executor за ImageViewerAction[] — единственото място, което
  // реално пипа history API/render за viewer-a. `attachment` носи display
  // данните (viewUrl/downloadUrl) само при open; `nextState` носи decision-logic
  // полетата (historyPushed/closePending), computed от imageViewerHistoryState.ts
  // — тук просто ги записваме в state.imageViewer, без да ги преизчисляваме.
  function runImageViewerActions(
    actions: ImageViewerAction[],
    nextState: ImageViewerHistoryState,
    attachment: { viewUrl: string; downloadUrl: string } | null,
  ): void {
    for (const action of actions) {
      switch (action.type) {
        case 'push-history-state':
          state.imageViewer = attachment
            ? { viewUrl: attachment.viewUrl, downloadUrl: attachment.downloadUrl, historyPushed: nextState.historyPushed, closePending: nextState.closePending }
            : state.imageViewer
          history.pushState({ pikaImageViewer: true }, '')
          render()
          break
        case 'call-history-back':
          if (state.imageViewer) {
            state.imageViewer = { ...state.imageViewer, historyPushed: nextState.historyPushed, closePending: nextState.closePending }
          }
          history.back()
          break
        case 'finalize-close':
          state.imageViewer = null
          render()
          break
        case 'noop':
          break
      }
    }
  }

  function readImageViewerHistoryState(): ImageViewerHistoryState {
    const viewer = state.imageViewer
    return {
      isOpen: viewer !== null,
      historyPushed: viewer?.historyPushed ?? false,
      closePending: viewer?.closePending ?? false,
    }
  }

  function openImageViewer(attachment: { viewUrl: string; downloadUrl: string }): void {
    const { nextState, actions } = decideOpenImageViewer()
    runImageViewerActions(actions, nextState, attachment)
  }

  // X / Esc / backdrop click извикват ТОВА — единна decision точка (виж
  // decideRequestImageViewerClose в imageViewerHistoryState.ts). Никога не
  // маха state.imageViewer синхронно тук при нормален flow — финализацията
  // идва през handleWindowPopstate, за да не пропусне popstate consumption
  // (виж критичния invariant коментар в imageViewerHistoryState.ts).
  // closePending guard-ът (записан от call-history-back action-а по-горе)
  // предпазва от двоен history.back() при бърз double X/Esc/backdrop click
  // преди асинхронния popstate да пристигне.
  function requestImageViewerClose(): void {
    if (state.imageViewer === null) return
    const { nextState, actions } = decideRequestImageViewerClose(readImageViewerHistoryState())
    runImageViewerActions(actions, nextState, null)
  }

  // System/browser Back (popstate) — consume-ва СЪЩОТО popstate събитие,
  // независимо дали е причинено от requestImageViewerClose() (виж по-горе)
  // или от реален потребителски Back tap, докато viewer-ът е отворен.
  // Връща true → повикващият (window 'popstate' listener) НЕ delegate-ва
  // към navigateFromPath за това събитие.
  function handleWindowPopstate(): boolean {
    const { nextState, actions, consumed } = decideHandlePopstate(readImageViewerHistoryState())
    runImageViewerActions(actions, nextState, null)
    return consumed
  }

  // ─── Composer (Етап 2) ───────────────────────────────────────────────────

  function updateTopicComposerDraft(topicId: string, value: string): void {
    state.topicComposerDraftByTopicId[topicId] = value
  }

  function handleTopicComposerNonVipTap(): void {
    openTopicsVipPopup()
  }

  function isCurrentViewerVipForPersonalComposer(): boolean {
    if (state.topicsVipGate !== null) return state.topicsVipGate.isActive
    return options.getAuthSession?.()?.profile.isVip === true
  }

  // GLOBAL TOPICS MUTE брифа §11 — precheck е ЧИСТО UX optimization, НИКОГА
  // authority. Връща true самò когато локалният snapshot доказано показва
  // АКТИВЕН mute С бъдеще mutedUntil (isMuted===true И mutedUntil > now) —
  // само в този случай instant UX denial е позволен, без network round-trip.
  // Ако snapshot липсва (null), е неясен, или mutedUntil вече е изтекъл
  // локално (stale push/error state, който сървърът вече не би потвърдил) —
  // винаги връща false, request-ът се изпраща и сървърът решава authoritative
  // (никога stale local state не блокира потребител след реален expiry).
  function isLocallyKnownTopicsSectionMuted(): boolean {
    const snapshot = state.activeTopicViewerMute
    if (!snapshot || !snapshot.isMuted || !snapshot.mutedUntil) return false
    return new Date(snapshot.mutedUntil).getTime() > Date.now()
  }

  // Persistent inline композер текст/banner → popup (заменя стария постоянен
  // червен текст под Topics composer-а И горния жълт banner). Acknowledgement
  // tracking-ът е нарочно чист closure-local string (не state поле) — "не
  // изграждай сложна persistence система само за acknowledgement" — пази
  // КОЙ конкретен mute (по mutedUntil) вече е "Разбрах"-нат.
  //
  // ДВА отделни entry points, нарочно разделени (UX corrective fix):
  //  - evaluateTopicsSectionMutePopup(): ack-gated, само за ПАСИВНИ пътища
  //    (realtime topic_mute_state_changed push, докато потребителят не
  //    взаимодейства активно с composer-а) — НЕ отваря повторно popup-а за
  //    СЪЩИЯ вече потвърден mute при всеки generic render.
  //  - openTopicsSectionMutePopupForAttempt(): БЕЗ ack-dedup, за ВСЕКИ
  //    user-initiated опит (click/tap върху composer/send/image-picker) —
  //    отваря popup-а безусловно, дори ако СЪЩИЯТ mute вече е бил "Разбрах"-
  //    нат преди. Acknowledgement блокира само автоматичното повторно
  //    отваряне, никога user-initiated опитите.
  let topicsSectionMuteAcknowledgedMutedUntil: string | null = null

  function evaluateTopicsSectionMutePopup(): void {
    const snapshot = state.activeTopicViewerMute
    const isActive = snapshot?.isMuted === true
      && snapshot.mutedUntil !== null
      && new Date(snapshot.mutedUntil).getTime() > Date.now()
    if (!isActive) {
      state.topicsSectionMutePopupOpen = false
      return
    }
    if (snapshot!.mutedUntil !== topicsSectionMuteAcknowledgedMutedUntil) {
      state.topicsSectionMutePopupOpen = true
    }
  }

  function openTopicsSectionMutePopupForAttempt(): void {
    if (!isLocallyKnownTopicsSectionMuted()) return
    state.topicsSectionMutePopupOpen = true
  }

  // Composer draft/pending-image reset при "Разбрах" — потребителят не
  // трябва да остане с "залепнал" незапазен draft, написан ПРЕДИ mute-а да е
  // бил detect-нат (readonly/click-intercept пази от НОВО писане, но не
  // изчиства текст, въведен по-рано). Идемпотентно/безопасно да се вика дори
  // ако draft-ът вече е празен (напр. popup, отворен от passive realtime push).
  // Общ reset helper — text draft + pending image/attachment (client state,
  // не само DOM) за текущата активна Topics тема. Reuse-ван от ВСЕКИ изход
  // от mute popup-а към друго действие ("Разбрах" И "История на
  // ограниченията") — потребител с "залепнал" muted draft не трябва да го
  // вижда обратно след връщане от историята. Идемпотентно/безопасно дори
  // при вече празен draft.
  function resetActiveTopicsComposerDraft(): void {
    const topicId = state.activeTopicId
    if (topicId === null) return
    state.topicComposerDraftByTopicId[topicId] = ''
    clearTopicComposerPendingImage(topicId)
  }

  function acknowledgeTopicsSectionMutePopup(): void {
    topicsSectionMuteAcknowledgedMutedUntil = state.activeTopicViewerMute?.mutedUntil ?? null
    state.topicsSectionMutePopupOpen = false
    resetActiveTopicsComposerDraft()
    render()
  }

  function submitTopicComposerMessage(topicId: string): void {
    const draft = state.topicComposerDraftByTopicId[topicId] ?? ''
    const trimmed = draft.trim()
    const pendingImage = state.topicComposerPendingImageByTopicId[topicId] ?? null
    // Text-or-image (Attachment feature) — reject само ако И двете липсват;
    // image-only (trimmed='', pendingImage!==null) е валидно съобщение.
    if (trimmed.length === 0 && pendingImage === null) return
    if (state.topicComposerPendingRequestIdByTopicId[topicId]) return // вече чакаме ack за тази тема

    // Client-side gate е само UX (избягва излишен round-trip) — реалният
    // guard е server-side (Етап 2 брифа: "Frontend скриването НЕ е security boundary").
    // Снимка е писане (Attachment брифа т.3) — СЪЩИЯТ VIP gate важи за нея.
    if (!(state.topicsVipGate?.isActive ?? false)) {
      openTopicsVipPopup()
      return
    }

    // GLOBAL TOPICS MUTE брифа §11 — instant UX denial само при доказано
    // активен local snapshot, server остава authority при следващ опит.
    // Опит за публикуване (SEND click) при активен mute показва popup-а
    // БЕЗУСЛОВНО (не изпраща съдържание, не задава отделен inline композер
    // текст) — user-initiated опит, значи openTopicsSectionMutePopupForAttempt
    // (без ack-dedup), НЕ evaluateTopicsSectionMutePopup.
    if (isLocallyKnownTopicsSectionMuted()) {
      openTopicsSectionMutePopupForAttempt()
      render()
      return
    }

    const requestId = `topic-msg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    state.topicComposerPendingRequestIdByTopicId[topicId] = requestId
    state.topicComposerErrorTextByTopicId[topicId] = null
    render()

    if (pendingImage === null) {
      options.onTopicMessageSend?.(topicId, trimmed, requestId)
      return
    }

    // FileReader encode е async — draft/pendingImage/pending-request state
    // остават непокътнати докато чакаме, точно както root chat flow-а
    // (виж sendChatMessage) — при неуспех на самия encode (рядко, но
    // технически възможно), освобождаваме pending state-а и показваме грешка.
    void readFileAsDataUrl(pendingImage.file)
      .then((imageDataUrl) => {
        options.onTopicMessageSend?.(topicId, trimmed, requestId, imageDataUrl)
      })
      .catch(() => {
        state.topicComposerPendingRequestIdByTopicId[topicId] = null
        state.topicComposerErrorTextByTopicId[topicId] = 'Снимката не можа да бъде прочетена. Опитайте отново.'
        render()
      })
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
      await Promise.all([loadShopPurchases(), loadVipPackages(true)])
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

    await Promise.all([loadShopPurchases(), loadVipPackages(true)])
  }

  // ВАЖНО: за разлика от loadShopPackages/loadShopPurchases (coin пакети),
  // VIP цените се редактират от Admin панела в СЪЩАТА клиентска сесия —
  // "reuse ако вече е заредено" guard тук би показвал stale цена след admin
  // Save, докато потребителят не презареди страницата. Затова VIP каталогът
  // се refetch-ва при всяко влизане в Shop screen (viж showShopPanel) вместо
  // да се кешира за целия lifetime на сесията. forceRefresh позволява explicit
  // re-fetch (напр. веднага след admin Save) дори ако вече има кеширани данни.
  async function loadVipPackages(forceRefresh = false): Promise<void> {
    if (!options.onVipPackagesLoad) {
      state.vipPackagesErrorText = 'VIP офертите временно не са налични.'
      render()
      return
    }

    if (!forceRefresh && state.vipPackages.length > 0 && state.vipPackagesErrorText === null) {
      return
    }

    state.vipPackagesLoading = true
    state.vipPackagesErrorText = null
    render()

    const result = await options.onVipPackagesLoad()

    if (state.currentScreen !== 'shop') {
      return
    }

    state.vipPackagesLoading = false

    if (!result.ok) {
      state.vipPackagesErrorText = result.message
      render()
      return
    }

    state.vipPackages = result.packages
    state.vipPackagesErrorText = null
    render()
  }

  function switchShopTab(tab: 'coins' | 'vip'): void {
    if (state.shopActiveTab === tab) {
      return
    }
    state.shopActiveTab = tab
    render()
    if (tab === 'vip' && state.vipPackages.length === 0 && !state.vipPackagesLoading) {
      void loadVipPackages()
    }
  }

  async function startVipPurchase(packageId: string): Promise<void> {
    if (state.vipPurchaseActionPackageId !== null) {
      return
    }

    if (!options.onVipPurchaseStart) {
      state.vipPurchaseMessageText = 'VIP покупките временно не са налични.'
      render()
      return
    }

    state.vipPurchaseActionPackageId = packageId
    state.vipPurchaseMessageText = null
    render()

    const result = await options.onVipPurchaseStart(packageId)

    state.vipPurchaseActionPackageId = null

    if (!result.ok) {
      state.vipPurchaseMessageText = result.message
      render()
      return
    }

    state.vipPurchaseMessageText = result.message
    render()
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
    state.adminSettingsSuccessText = null
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
      state.adminSettingsSuccessText = null
      render()
      return
    }

    state.adminSettingsErrorText = null
    state.adminSettingsSuccessText = null
    render()

    const result = await options.onAdminSettingsSubmit(settings)

    if (!result.ok) {
      state.adminSettingsErrorText = result.message
      state.adminSettingsSuccessText = null
      render()
      return
    }

    state.adminSettings = result.settings
    state.adminSettingsErrorText = null
    state.adminSettingsSuccessText = 'Настройките са запазени.'
    // VIP цените може да са част от тази заявка — инвалидираме локалния VIP
    // package snapshot, за да не остане stale ако администраторът отвори
    // Shop -> VIP без пълен showShopPanel refresh cycle (viж loadVipPackages
    // за детайлния reasoning защо VIP каталогът не се кешира за сесията).
    state.vipPackages = []
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

  async function unblockPlayer(profileId: string): Promise<boolean> {
    if (!options.onBlockProfile) return false

    const result = await options.onBlockProfile(profileId)
    if ('ok' in result && !result.ok) return false

    state.blockedPlayers = (state.blockedPlayers ?? []).filter((p) => p.profileId !== profileId)

    const updateProfile = (p: PlayerPublicProfileSnapshot) =>
      p.profileId === profileId ? { ...p, isBlockedByMe: false } : p
    state.players = state.players.map(updateProfile)
    state.playersSearchResults = state.playersSearchResults?.map(updateProfile) ?? null
    if (state.profilePopupProfile?.profileId === profileId) {
      state.profilePopupProfile = { ...state.profilePopupProfile, isBlockedByMe: false }
    }
    render()
    return true
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

  // Каноничното "отвори моя/нашия pika_support поток" действие — вика се
  // от бутона "Поддръжка" (onSupportClick) И от openChatWithFriend, когато
  // разпознае kind='pika_support' известие (production hotfix: legacy Chat
  // филтрира списъка си само до kind='friend' — renderChatPanel — там
  // pika_support разговор би показал грешна/празна активна беседа, затова
  // не може да бъде legacy Chat destination). Извлечена извън onSupportClick
  // непроменена (чист code-motion), за да няма два независими копия на
  // admin-inbox/support-popup branching логиката, които могат да се разминат.
  function openSupportInbox(): void {
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
  }

  // Единствен client-side entry point за СЪЗДАВАНЕ/намиране на служебен
  // pika_support разговор — вика се само от бутона "Чат" в profile popup-а,
  // видим само когато state.showPikaSupportChatButton е true (виж
  // buildPopupFriendshipAction/renderPopupOnly). Реалната authoritative
  // проверка (initiator === official Pika.bg profileId) е server-side в
  // chatStore.getOrCreatePikaSupportConversation — тук само консумираме
  // резултата и отваряме чата, ако е успешен.
  async function startPikaSupportChatAndOpen(recipientProfileId: string): Promise<void> {
    if (!options.onPikaSupportChatStart) {
      state.errorText = 'Служебният чат временно не е наличен.'
      render()
      return
    }

    // Прочетено ПРЕДИ мрежовия hop по-долу — ако друг chat-open flow (нов
    // PIKABG start, чат ред, notification "Виж") сработи междувременно,
    // openChatConversation ще е bump-нал generation-а и проверката след await-а
    // ще хване тази заявка като остаряла (виж activeChatRequestGeneration).
    const requestGeneration = state.activeChatRequestGeneration

    const result = await options.onPikaSupportChatStart(recipientProfileId)

    if (!result.ok) {
      state.errorText = result.message
      render()
      return
    }

    if (state.activeChatRequestGeneration !== requestGeneration) {
      // Друг разговор вече е станал активен, докато чакахме create-or-find
      // round trip-а — тази заявка е остаряла, НЕ презаписвай активния чат
      // с нея (production race guard, виж коментара при state полето).
      return
    }

    state.profilePopupOpen = false
    state.profilePopupProfile = null
    syncProfilePopup({ isOpen: false, profile: null, canEdit: false, friendshipAction: null }, getPopupCallbacks())

    void showChatPanel(true).then(() => {
      if (state.activeChatRequestGeneration !== requestGeneration) return
      void openChatConversation(result.friendshipId)
    })
  }

  function mergeCanonicalChatConversation(conversation: ChatConversationSnapshot): void {
    const existingConversation = state.chatConversations.find(
      (c) => c.friendshipId === conversation.friendshipId,
    )
    const updatedConversation = existingConversation?.friend.isOnline !== undefined
      ? { ...conversation, friend: { ...conversation.friend, isOnline: existingConversation.friend.isOnline } }
      : conversation
    state.chatConversations = [
      updatedConversation,
      ...state.chatConversations.filter((c) => c.friendshipId !== conversation.friendshipId),
    ]
  }

  function findTopicsPersonalConversationByProfileId(profileId: string): ChatConversationSnapshot | null {
    return state.chatConversations.find((conversation) =>
      conversation.friend.profileId === profileId &&
      conversation.kind === 'vip_dm'
    ) ?? null
  }

  async function authorizeTopicsPersonalMessageTarget(recipientProfileId: string): Promise<boolean> {
    if (!options.onProfileByIdLoad) return true

    const result = await options.onProfileByIdLoad(recipientProfileId)
    if (result.ok) return true

    if (result.code === 'profile_blocked_by_viewer' || result.code === 'profile_blocked_viewer') {
      state.profilePopupOpen = false
      state.profilePopupProfile = null
      state.profilePopupContext = 'other'
      state.profileAccessBlockPopup = { profileId: recipientProfileId, code: result.code }
      render()
      return false
    }

    state.topicsInfoToast = { text: result.message || 'Профилът не беше зареден.' }
    render()
    return false
  }

  // Click "Лично" вече НЕ вика backend create веднага (виж §2/§7 в task
  // spec-а — предотвратява empty vip_dm ghost rows). Ако вече има canonical
  // conversation, отваря го. Ако не — само отваря pending compose context
  // (без friendshipId, без backend write); реалният vip_dm ред се създава
  // атомарно едва при първия успешен SEND, виж startVipDmFirstMessage.
  async function openTopicsPersonalMessageFromPost(recipientProfileId: string, recipientDisplayName: string): Promise<void> {
    if (recipientProfileId.trim().length === 0) return
    const authSession = options.getAuthSession?.() ?? null
    if (authSession?.profile.profileId === recipientProfileId) return
    if (state.topicsPersonalMessagePendingProfileId !== null) return

    state.chatErrorText = null
    state.topicsInfoToast = null
    state.topicsPersonalMessagePendingProfileId = recipientProfileId
    render()

    try {
      const authorized = await authorizeTopicsPersonalMessageTarget(recipientProfileId)
      if (!authorized) return

      await loadChatConversations()

      const existingConversation = findTopicsPersonalConversationByProfileId(recipientProfileId)
      if (existingConversation !== null) {
        state.profilePopupOpen = false
        state.profilePopupProfile = null
        state.profilePopupContext = 'other'
        syncProfilePopup({ isOpen: false, profile: null, canEdit: false, friendshipAction: null }, getPopupCallbacks())
        await showTopicsPersonalChat(existingConversation.friendshipId)
        return
      }

      if (state.topicsVipGate !== null && !state.topicsVipGate.isActive) {
        openTopicsVipPopup()
        return
      }

      if (!options.onVipDmFirstMessageSend) {
        state.topicsInfoToast = { text: 'Личните съобщения временно не са налични.' }
        render()
        return
      }

      // Няма съществуващ разговор — отваряме pending compose context.
      // Server-side проверките (VIP/block/self) се преповтарят authoritative
      // при действителния send (startVipDmFirstMessage), тук е само UX preview.
      state.currentScreen = 'topics'
      state.topicsMode = 'personal'
      state.topicsPersonalView = 'conversation'
      state.topicsPersonalPendingRecipient = { profileId: recipientProfileId, displayName: recipientDisplayName }
      state.activeChatFriendshipId = null
      state.chatMessages = []
      state.chatMessagesFriendshipId = null
      state.chatErrorText = null
      state.profilePopupOpen = false
      state.profilePopupProfile = null
      state.profilePopupContext = 'other'
      syncProfilePopup({ isOpen: false, profile: null, canEdit: false, friendshipAction: null }, getPopupCallbacks())
      render()
    } finally {
      state.topicsPersonalMessagePendingProfileId = null
      render()
    }
  }

  // Изпраща ПЪРВОТО съобщение на pending compose context — атомарно създава
  // vip_dm + съобщение в 1 server request (виж §4/§5/§9 в task spec-а).
  // Back/close без SEND никога не вика тази функция, значи 0 backend write.
  async function sendVipDmFirstMessage(body: string, imageDataUrl: string | null): Promise<void> {
    const pendingRecipient = state.topicsPersonalPendingRecipient

    if (pendingRecipient === null) return
    if (!options.onVipDmFirstMessageSend) {
      state.chatErrorText = 'Личните съобщения временно не са налични.'
      render()
      return
    }
    if (state.chatUploadingFriendshipIds.has(PENDING_VIP_DM_UPLOAD_KEY)) return
    if (body.trim().length === 0 && imageDataUrl === null) return

    // GLOBAL TOPICS MUTE брифа §1.D/§11 — vip_dm е част от Topics
    // enforcement scope-а; виж isLocallyKnownTopicsSectionMuted коментара.
    if (isLocallyKnownTopicsSectionMuted()) {
      state.chatErrorText = formatTopicsSectionMuteErrorText(
        state.activeTopicViewerMute?.mutedUntil ?? null,
        state.activeTopicViewerMute?.reason ?? null,
      )
      render()
      return
    }

    state.chatUploadingFriendshipIds = new Set(state.chatUploadingFriendshipIds).add(PENDING_VIP_DM_UPLOAD_KEY)
    state.chatErrorText = null
    render()

    const result = await options.onVipDmFirstMessageSend(pendingRecipient.profileId, body, imageDataUrl)

    const nextUploading = new Set(state.chatUploadingFriendshipIds)
    nextUploading.delete(PENDING_VIP_DM_UPLOAD_KEY)
    state.chatUploadingFriendshipIds = nextUploading

    // Pending context е бил изоставен (Back/close) междувременно — не
    // прилагай отговор върху вече неактуален UI state.
    if (state.topicsPersonalPendingRecipient?.profileId !== pendingRecipient.profileId) {
      return
    }

    if (!result.ok) {
      if (result.code === 'vip_required') {
        if (state.topicsVipGate) {
          state.topicsVipGate = { ...state.topicsVipGate, isActive: false }
        }
        void refreshTopicsVipGateStatus()
        openTopicsVipPopup()
        return
      }
      if (result.code === 'blocked') {
        const blockAuthorization = await options.onProfileByIdLoad?.(pendingRecipient.profileId)
        if (blockAuthorization && !blockAuthorization.ok && (blockAuthorization.code === 'profile_blocked_by_viewer' || blockAuthorization.code === 'profile_blocked_viewer')) {
          state.profileAccessBlockPopup = { profileId: pendingRecipient.profileId, code: blockAuthorization.code }
          render()
          return
        }
      }
      // GLOBAL TOPICS MUTE брифа §1.D — vip_dm е част от Topics enforcement
      // scope-а; синхронизираме global mute state-а веднага, за да отразят
      // и другите write composer-и (root/reply/create-topic) restriction-а
      // без да чакат отделен push.
      if (result.code === 'topic_muted') {
        state.activeTopicViewerMute = { isMuted: true, mutedUntil: result.mutedUntil ?? null, mutedByAccountId: null, reason: result.reason ?? null }
      }
      // Draft/снимка НЕ се пипат при неуспех — established UX (виж sendChatMessage) — потребителят може да retry-не.
      state.chatErrorText = result.message
      render()
      return
    }

    mergeCanonicalChatConversation(result.conversation)
    await loadChatConversations()
    if (!state.chatConversations.some((conversation) => conversation.friendshipId === result.conversation.friendshipId)) {
      mergeCanonicalChatConversation(result.conversation)
    }

    clearPendingVipDmComposeContext()
    await showTopicsPersonalChat(result.conversation.friendshipId)
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

    reconcileActiveChatConversation()

    return true
  }

  function getFriendChatConversations(): ChatConversationSnapshot[] {
    return state.chatConversations.filter((conversation) => conversation.kind === 'friend')
  }

  function getTopicsPersonalChatConversations(): ChatConversationSnapshot[] {
    return state.chatConversations.filter((conversation) => conversation.kind === 'vip_dm')
  }

  function isChatConversationValidForCurrentSurface(conversation: ChatConversationSnapshot): boolean {
    // 'pika_support' е валиден и на 'chat' екрана (виж renderChatPanel filter
    // fix) — без това, reconcileActiveChatConversation() би изчистил активния
    // pika_support разговор при всяко loadChatConversations() (напр. фоново
    // презареждане), докато потребителят реално го гледа.
    if (state.currentScreen === 'chat') return conversation.kind === 'friend' || conversation.kind === 'pika_support'
    if (state.currentScreen === 'topics' && state.topicsMode === 'personal') return conversation.kind === 'vip_dm'
    return true
  }

  function clearActiveChatConversation(): void {
    state.activeChatFriendshipId = null
    state.chatMessages = []
    state.chatMessagesFriendshipId = null
    state.chatMessagesLoading = false
  }

  function reconcileActiveChatConversation(): void {
    if (state.activeChatFriendshipId === null) return
    const activeConversation = state.chatConversations.find((conversation) => {
      return conversation.friendshipId === state.activeChatFriendshipId
    }) ?? null
    if (activeConversation === null || !isChatConversationValidForCurrentSurface(activeConversation)) {
      clearActiveChatConversation()
    }
  }

  function isActivePersonalChatConversation(friendshipId: string): boolean {
    return (
      state.activeChatFriendshipId === friendshipId &&
      (
        state.currentScreen === 'chat' ||
        (
          state.currentScreen === 'topics' &&
          state.topicsMode === 'personal' &&
          state.topicsPersonalView === 'conversation'
        )
      )
    )
  }

  function markChatConversationReadLocally(friendshipId: string): void {
    state.chatConversations = state.chatConversations.map((c) =>
      c.friendshipId === friendshipId ? { ...c, unreadCount: 0 } : c,
    )
  }

  async function showTopicsPersonalChat(targetFriendshipId: string | null = null): Promise<void> {
    const authSession = options.getAuthSession?.() ?? null

    if (authSession === null) {
      state.authModalMode = 'cta'
      state.authErrorText = null
      render()
      return
    }

    state.currentScreen = 'topics'
    state.topicsMode = 'personal'
    state.topicsPersonalView = targetFriendshipId === null ? 'list' : 'conversation'
    state.topicThreadRootMessageId = null
    state.topicThreadReturnScrollAnchor = null
    state.topicThreadRenderReason = null
    state.topicReplyComposerOpenRootId = null
    state.chatShowArchived = false
    state.chatErrorText = null
    state.profilePopupOpen = false
    state.profilePopupProfile = null
    state.profilePopupCanEdit = true
    unsubscribeFromCurrentTopicMessages()

    // Прочетено ПРЕДИ loadChatConversations по-долу — race guard срещу друг
    // по-нов chat-open flow (напр. PIKABG start или друг ред в списъка),
    // който сработва междувременно, виж activeChatRequestGeneration.
    const requestGeneration = state.activeChatRequestGeneration

    state.chatLoading = true
    render()

    const loaded = await loadChatConversations()

    if (state.currentScreen !== 'topics' || state.topicsMode !== 'personal') {
      return
    }

    if (state.activeChatRequestGeneration !== requestGeneration) {
      return
    }

    state.chatLoading = false

    if (!loaded) {
      render()
      return
    }

    const friendConversations = getTopicsPersonalChatConversations()
    const targetConversation = targetFriendshipId !== null
      ? friendConversations.find((conversation) => conversation.friendshipId === targetFriendshipId) ?? null
      : null

    if (targetConversation !== null) {
      state.topicsPersonalView = 'conversation'
      await openChatConversation(targetConversation.friendshipId, false)
      markChatConversationReadLocally(targetConversation.friendshipId)
      render()
      void options.onChatMarkRead?.(targetConversation.friendshipId)
      return
    }

    state.topicsPersonalView = 'list'
    render()
  }

  function closeTopicsPersonalChat(): void {
    if (state.currentScreen !== 'topics') return
    state.topicsMode = 'topics'
    state.topicsPersonalView = 'list'
    clearTopicsPersonalTransientState()
    render()

    if (state.activeTopicId !== null) {
      void loadTopicMessagesForActiveTopic(state.activeTopicId)
    }
  }

  function backToTopicsPersonalList(): void {
    if (state.currentScreen !== 'topics' || state.topicsMode !== 'personal') return
    state.topicsPersonalView = 'list'
    clearPendingVipDmComposeContext()
    render()
  }

  // Ненатрапчив toggle между активен/архивиран изглед на списъка с
  // разговори — сървърът вече прилага 12-месечния праг (виж
  // chatStore.listConversations/isConversationArchived), тук само
  // презареждаме съответния списък lazy при първо превключване.
  async function toggleChatArchivedView(): Promise<void> {
    state.chatShowArchived = !state.chatShowArchived

    if (state.chatShowArchived && state.chatArchivedConversations.length === 0 && !state.chatArchivedLoading) {
      state.chatArchivedLoading = true
      render()

      const result = await options.onChatConversationsLoad?.(true)

      state.chatArchivedLoading = false

      if (result?.ok) {
        state.chatArchivedConversations = result.conversations.filter((c) => c.isArchived)
      }
    }

    render()
  }

  // skipAutoSelectFallback: подадено от caller-и, които ВЕЧЕ имат конкретна
  // цел, готова да я приложат веднага след showChatPanel() (startPikaSupportChatAndOpen,
  // openChatWithFriend) — без него, auto-select-fallback-ът по-долу временно
  // bind-ва разговора към "първия приятел" (нищо общо с реалната цел),
  // самò той извиква openChatConversation() и по този начин bump-ва
  // activeChatRequestGeneration — карайки race guard-а на caller-а погрешно
  // да разпознае СОБСТВЕНИЯ СИ throwaway междинен избор като "друг, по-нов
  // flow ме е superseded-нал" и да изостави реалната си, вярна цел
  // (production regression, открит от checkPikaSupportChatRouting.ts [A3]).
  async function showChatPanel(skipAutoSelectFallback = false): Promise<void> {
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

    if (!skipAutoSelectFallback) {
      const friendConversations = getFriendChatConversations()
      const firstConversation = friendConversations[0] ?? null
      const activeFriendConversation = state.activeChatFriendshipId !== null
        ? friendConversations.find((conversation) => conversation.friendshipId === state.activeChatFriendshipId) ?? null
        : null

      if (firstConversation !== null && activeFriendConversation === null) {
        state.activeChatFriendshipId = firstConversation.friendshipId
        await openChatConversation(firstConversation.friendshipId, false)
        return
      }
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

    // Bump-ваме generation-а тук, ЗАЩОТО тази функция е единственото място,
    // което реално пише activeChatFriendshipId — всеки pre-flight caller
    // (startPikaSupportChatAndOpen/showTopicsPersonalChat/openChatWithFriend)
    // прочита стойността ПРЕДИ собствения си мрежов hop и я сверява точно
    // преди да стигне дотук, за да не презапише по-нов разговор с остаряла заявка.
    state.activeChatRequestGeneration += 1
    state.activeChatFriendshipId = friendshipId
    if (state.currentScreen === 'topics' && state.topicsMode === 'personal') {
      state.topicsPersonalView = 'conversation'
    }
    state.chatMessagesLoading = true
    state.chatMessages = []
    state.chatMessagesFriendshipId = null
    state.chatErrorText = null

    if (shouldRenderLoading) {
      render()
    }

    const result = await options.onChatMessagesLoad(friendshipId)

    if (!isActivePersonalChatConversation(friendshipId)) {
      return
    }

    state.chatMessagesLoading = false

    if (!result.ok) {
      state.chatErrorText = result.message
      render()
      return
    }

    state.chatMessages = result.messages
    state.chatMessagesFriendshipId = friendshipId
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

  function clearSupportPendingImage(): void {
    if (state.supportPendingImage !== null) {
      URL.revokeObjectURL(state.supportPendingImage.previewUrl)
    }
    state.supportPendingImage = null
  }

  function selectSupportImage(file: File): void {
    const validationError = validateChatImageFile(file)

    if (validationError !== null) {
      state.supportErrorText = validationError
      render()
      return
    }

    clearSupportPendingImage()
    state.supportPendingImage = { file, previewUrl: URL.createObjectURL(file) }
    state.supportErrorText = null
    render()
  }

  function clearAdminSupportPendingImage(profileId: string): void {
    const pending = state.adminSupportPendingImageByProfileId[profileId]
    if (pending) {
      URL.revokeObjectURL(pending.previewUrl)
    }
    const next = { ...state.adminSupportPendingImageByProfileId }
    delete next[profileId]
    state.adminSupportPendingImageByProfileId = next
  }

  function selectAdminSupportImage(profileId: string, file: File): void {
    const validationError = validateChatImageFile(file)

    if (validationError !== null) {
      state.adminSupportReplyErrorText = validationError
      render()
      return
    }

    clearAdminSupportPendingImage(profileId)
    state.adminSupportPendingImageByProfileId = {
      ...state.adminSupportPendingImageByProfileId,
      [profileId]: { file, previewUrl: URL.createObjectURL(file) },
    }
    state.adminSupportReplyErrorText = null
    render()
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

  // ─── Topics attachment (root composer) — reuse на СЪЩИЯ validateChatImageFile ──

  function clearTopicComposerPendingImage(topicId: string): void {
    const pending = state.topicComposerPendingImageByTopicId[topicId]
    if (pending) {
      URL.revokeObjectURL(pending.previewUrl)
    }
    const next = { ...state.topicComposerPendingImageByTopicId }
    delete next[topicId]
    state.topicComposerPendingImageByTopicId = next
  }

  function selectTopicComposerImage(topicId: string, file: File): void {
    const validationError = validateChatImageFile(file)
    if (validationError !== null) {
      state.topicComposerErrorTextByTopicId[topicId] = validationError
      render()
      return
    }
    clearTopicComposerPendingImage(topicId)
    const previewUrl = URL.createObjectURL(file)
    state.topicComposerPendingImageByTopicId = {
      ...state.topicComposerPendingImageByTopicId,
      [topicId]: { file, previewUrl },
    }
    state.topicComposerErrorTextByTopicId[topicId] = null
    render()
  }

  // ─── Topics attachment (reply composer) ─────────────────────────────────

  function clearTopicReplyComposerPendingImage(rootMessageId: string): void {
    const pending = state.topicReplyComposerPendingImageByRootId[rootMessageId]
    if (pending) {
      URL.revokeObjectURL(pending.previewUrl)
    }
    const next = { ...state.topicReplyComposerPendingImageByRootId }
    delete next[rootMessageId]
    state.topicReplyComposerPendingImageByRootId = next
  }

  function selectTopicReplyComposerImage(rootMessageId: string, file: File): void {
    const validationError = validateChatImageFile(file)
    if (validationError !== null) {
      state.topicReplyComposerErrorTextByRootId[rootMessageId] = validationError
      render()
      return
    }
    clearTopicReplyComposerPendingImage(rootMessageId)
    const previewUrl = URL.createObjectURL(file)
    state.topicReplyComposerPendingImageByRootId = {
      ...state.topicReplyComposerPendingImageByRootId,
      [rootMessageId]: { file, previewUrl },
    }
    state.topicReplyComposerErrorTextByRootId[rootMessageId] = null
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

  function canRestoreComposerFocus(wasComposerFocused: boolean): boolean {
    if (!wasComposerFocused) return false
    const active = document.activeElement
    return active === null || active === document.body || active === options.root
  }

  function selectorEscape(value: string): string {
    return globalThis.CSS?.escape ? globalThis.CSS.escape(value) : value.replace(/["\\]/g, '\\$&')
  }

  function refocusTextControl(
    input: HTMLInputElement | HTMLTextAreaElement | null,
    selectionStart: number,
    selectionEnd: number,
    selectionDirection: 'forward' | 'backward' | 'none' | null = 'none',
  ): void {
    if (input === null || input.disabled || input.offsetParent === null) return
    input.focus()
    input.setSelectionRange(selectionStart, selectionEnd, selectionDirection ?? 'none')
  }

  function refocusPersonalChatComposer(friendshipId: string, selectionStart: number, selectionEnd = selectionStart, selectionDirection: 'forward' | 'backward' | 'none' | null = 'none'): void {
    if (!isActivePersonalChatConversation(friendshipId)) return
    const input = options.root.querySelector<HTMLInputElement>(
      `[data-lobby-chat-form="${selectorEscape(friendshipId)}"] [data-lobby-chat-message-input="1"]`,
    )
    refocusTextControl(input, selectionStart, selectionEnd, selectionDirection)
  }

  function refocusSupportComposer(selectionStart: number, selectionEnd = selectionStart, selectionDirection: 'forward' | 'backward' | 'none' | null = 'none'): void {
    if (!state.supportPopupOpen) return
    const input = options.root.querySelector<HTMLTextAreaElement>('[data-support-send-form="1"] textarea[name="body"]')
    refocusTextControl(input, selectionStart, selectionEnd, selectionDirection)
  }

  function refocusAdminSupportComposer(profileId: string, selectionStart: number, selectionEnd = selectionStart, selectionDirection: 'forward' | 'backward' | 'none' | null = 'none'): void {
    if (state.currentScreen !== 'support' || state.adminSupportSelectedProfileId !== profileId) return
    const input = options.root.querySelector<HTMLTextAreaElement>(
      `[data-admin-support-reply-form="${selectorEscape(profileId)}"] textarea[name="body"]`,
    )
    refocusTextControl(input, selectionStart, selectionEnd, selectionDirection)
  }

  async function sendChatMessage(
    friendshipId: string,
    body: string,
  ): Promise<void> {
    // Pending vip_dm compose context (§7/§9 в task spec-а) — още няма
    // персистиран friendshipId, delegира на атомарния start+send path.
    if (friendshipId === PENDING_VIP_DM_UPLOAD_KEY) {
      const pendingImage = state.chatPendingImageByFriendshipId[PENDING_VIP_DM_UPLOAD_KEY] ?? null
      let imageDataUrl: string | null = null
      if (pendingImage !== null) {
        try {
          imageDataUrl = await readFileAsDataUrl(pendingImage.file)
        } catch {
          state.chatErrorText = 'Качването на снимката не бе успешно. Опитайте отново.'
          render()
          return
        }
      }
      await sendVipDmFirstMessage(body, imageDataUrl)
      return
    }

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

    const activeConversation = state.chatConversations.find((conversation) => conversation.friendshipId === friendshipId) ?? null
    if (activeConversation?.kind === 'vip_dm') {
      const viewerIsVip = isCurrentViewerVipForPersonalComposer()
      const disabledReason = !viewerIsVip
        ? 'За да изпращате лични съобщения тук, е необходим активен VIP.'
        : activeConversation.friend.isVip === false
          ? 'Този потребител в момента не е активен VIP.'
          : activeConversation.friend.isBlockedByMe === true
            ? 'Вие сте блокирали този потребител.'
            // GLOBAL TOPICS MUTE брифа §1.E/§11 — vip_dm е част от Topics
            // enforcement scope-а; виж isLocallyKnownTopicsSectionMuted коментара.
            : isLocallyKnownTopicsSectionMuted()
              ? formatTopicsSectionMuteErrorText(state.activeTopicViewerMute?.mutedUntil ?? null, state.activeTopicViewerMute?.reason ?? null)
              : null
      if (disabledReason !== null) {
        state.chatErrorText = disabledReason
        render()
        return
      }
    }

    const previousInput = options.root.querySelector<HTMLInputElement>(
      `[data-lobby-chat-form="${selectorEscape(friendshipId)}"] [data-lobby-chat-message-input="1"]`,
    )
    const shouldRefocus = previousInput !== null && document.activeElement === previousInput
    const previousSelectionStart = previousInput?.selectionStart ?? 0
    const previousSelectionEnd = previousInput?.selectionEnd ?? previousSelectionStart
    const previousSelectionDirection = previousInput?.selectionDirection ?? 'none'

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
        const restoreFocus = canRestoreComposerFocus(shouldRefocus)
        render()
        if (restoreFocus) {
          refocusPersonalChatComposer(friendshipId, previousSelectionStart, previousSelectionEnd, previousSelectionDirection)
        }
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
      const restoreFocus = canRestoreComposerFocus(shouldRefocus)
      render()
      if (restoreFocus) {
        refocusPersonalChatComposer(friendshipId, previousSelectionStart, previousSelectionEnd, previousSelectionDirection)
      }
      return
    }

    // Изчистваме черновата и избраната снимка едва тук — след потвърден
    // успех от сървъра.
    state.chatDraftByFriendshipId = { ...state.chatDraftByFriendshipId, [friendshipId]: '' }
    clearChatPendingImage(friendshipId)
    const isStillActiveChatConversation = isActivePersonalChatConversation(friendshipId)
    if (isStillActiveChatConversation) {
      state.chatMessages = result.messages
      state.chatMessagesFriendshipId = friendshipId
      state.chatErrorText = null
    }
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
    const restoreFocus = canRestoreComposerFocus(shouldRefocus)
    render()
    if (restoreFocus) {
      refocusPersonalChatComposer(friendshipId, 0)
    }
  }

  async function refreshChatAfterNotification(friendshipId: string): Promise<void> {
    await loadChatConversations()

    if (
      isActivePersonalChatConversation(friendshipId) &&
      options.onChatMessagesLoad
    ) {
      const result = await options.onChatMessagesLoad(friendshipId)

      if (!isActivePersonalChatConversation(friendshipId)) {
        return
      }

      if (result.ok) {
        state.chatMessages = result.messages
        state.chatMessagesFriendshipId = friendshipId
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
    topics: '/topics',
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
    '/topics': 'topics',
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
      case 'topics': void showTopicsDirectory(); break
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
    // Previewer-ите (не са зели слот в тази стая) никога не се абонират за
    // чата на чакалнята — само реални членове.
    const isMember = state.currentScreen === 'private-room-waiting' && state.myPrivateRoom !== null
    const targetRoomId = isMember ? state.myPrivateRoom!.id : null

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

  // Стаята и ролята на текущия зрител: 'member' ако вече е зает слот
  // (state.myPrivateRoom), иначе 'previewer' на стаята, посочена от
  // previewedPrivateRoomId, ако тя още съществува в живия private_rooms_list
  // поток (state.privateRooms се push-ва на всяка сървърна мутация,
  // независимо дали зрителят е член — currentRoomId остава null докато
  // играта не старира).
  function resolvePrivateRoomWaitingRoomView(): { room: PrivateRoomSnapshot; viewerRole: 'member' | 'previewer' } | null {
    if (state.myPrivateRoom !== null) {
      return { room: state.myPrivateRoom, viewerRole: 'member' }
    }
    const previewed = state.previewedPrivateRoomId !== null
      ? state.privateRooms.find((r) => r.id === state.previewedPrivateRoomId) ?? null
      : null
    if (previewed !== null) {
      return { room: previewed, viewerRole: 'previewer' }
    }
    return null
  }

  function renderPrivateRoomWaitingRoom(): void {
    reconcilePrivateRoomWaitingChatSubscription()

    const resolved = resolvePrivateRoomWaitingRoomView()

    if (resolved === null) {
      state.currentScreen = 'private-rooms'
      renderLobby()
      return
    }

    const { room, viewerRole } = resolved

    const authSession = options.getAuthSession?.() ?? null
    const localProfileId = authSession?.profile.profileId ?? null

    const previousInput = options.root.querySelector<HTMLInputElement>('[data-private-waiting-chat-input="1"]')
    const wasInputFocused = previousInput !== null && document.activeElement === previousInput
    const caretStart = previousInput?.selectionStart ?? null
    const caretEnd = previousInput?.selectionEnd ?? null
    const selectionDirection = previousInput?.selectionDirection ?? null

    const previousScroll = options.root.querySelector<HTMLElement>('[data-private-waiting-chat-scroll="1"]')
    const wasNearBottom = previousScroll === null
      ? true
      : previousScroll.scrollHeight - previousScroll.scrollTop - previousScroll.clientHeight < 48
    const previousScrollTop = previousScroll?.scrollTop ?? 0

    options.root.innerHTML = renderPrivateRoomWaitingScreen({
      isLocked: room.kind === 'locked',
      stake: room.stake,
      slots: room.slots,
      localProfileId,
      viewerRole,
      joinSlotPopup: state.privateRoomJoinSlotPopup,
      leaveConfirmOpen: state.privateRoomLeaveSlotConfirmOpen,
      blockedPopupText: state.privateRoomBlockedPopupText,
      botActionLoadingTeam: state.privateRoomBotActionLoadingTeam,
      inviteFriendsPopupOpen: state.inviteFriendsPopupOpen,
      inviteFriends: resolveInviteEligibleFriends(),
      chatMessages: state.privateRoomWaitingChatMessages,
      chatDraft: state.privateRoomWaitingChatDraft,
      chatSending: state.privateRoomWaitingChatSending,
      chatErrorText: state.privateRoomWaitingChatErrorText,
      infoText: state.privateRoomInfoText,
      expiresAt: room.expiresAt,
    })

    startPrivateRoomCountdownLoop(room.id, room.expiresAt)

    options.root.querySelector<HTMLButtonElement>('[data-private-waiting-wait-in-lobby-button="1"]')
      ?.addEventListener('click', () => {
        // Чисто клиентски screen transition — НЕ изпраща leave/cancel
        // команда, membership-ът в privateRoomsStore остава непроменен.
        // leavePrivateRoomWaitingScreen() спира countdown loop-а и chat
        // subscription-а на чакалнята (те са tied to тази renderPass), но не
        // пипа state.myPrivateRoom.
        leavePrivateRoomWaitingScreen()
        state.currentScreen = 'lobby'
        render()
      })

    options.root.querySelector<HTMLButtonElement>('[data-private-room-invite-open="1"]')
      ?.addEventListener('click', () => {
        state.inviteFriendsPopupOpen = true
        state.friendships = null
        render()
        void ensureFriendshipsLoaded()
      })

    options.root.querySelector<HTMLButtonElement>('[data-private-room-invite-close="1"]')
      ?.addEventListener('click', () => {
        state.inviteFriendsPopupOpen = false
        render()
      })

    options.root.querySelector<HTMLElement>('[data-private-room-invite-backdrop="1"]')
      ?.addEventListener('click', (event) => {
        if (event.target === event.currentTarget) {
          state.inviteFriendsPopupOpen = false
          render()
        }
      })

    options.root.querySelectorAll<HTMLButtonElement>('[data-private-room-invite-send]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const raw = btn.getAttribute('data-private-room-invite-send')
        if (!raw) return
        const [profileId, ...nameParts] = raw.split(':')
        const displayName = nameParts.join(':')
        if (!profileId || !displayName) return
        state.privateRoomInvitedProfileIds.add(profileId)
        state.privateRoomInfoText = null
        options.onPrivateRoomInvite?.([{ profileId, displayName }])
        render()
      })
    })

    // "+" клик (само previewer-и получават enabled бутон — виж
    // renderSlotCard's disabled атрибут — но пазим guard и тук defensively).
    options.root.querySelectorAll<HTMLButtonElement>('[data-private-room-slot-join]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (viewerRole !== 'previewer') return
        const raw = btn.getAttribute('data-private-room-slot-join')
        if (raw === null) return
        const [teamRaw, slotIndexRaw] = raw.split(':')
        if (teamRaw !== 'A' && teamRaw !== 'B') return
        const slotIndex = slotIndexRaw === '0' ? 0 : slotIndexRaw === '1' ? 1 : null
        if (slotIndex === null) return
        state.privateRoomJoinSlotPopup = { privateRoomId: room.id, team: teamRaw, slotIndex }
        render()
      })
    })

    options.root.querySelector<HTMLButtonElement>('[data-private-room-join-popup-confirm="1"]')
      ?.addEventListener('click', () => confirmPrivateRoomJoinSlotPopup())

    options.root.querySelector<HTMLButtonElement>('[data-private-room-join-popup-cancel="1"]')
      ?.addEventListener('click', () => cancelPrivateRoomJoinSlotPopup())

    options.root.querySelector<HTMLElement>('[data-private-room-join-popup-backdrop="1"]')
      ?.addEventListener('click', (event) => {
        if (event.target === event.currentTarget) cancelPrivateRoomJoinSlotPopup()
      })

    // Собствен червен "−" — stopPropagation за да не отваря едновременно
    // profile popup на същата карта (собствената карта не е wrap-ната в
    // data-private-room-member button, но пазим stopPropagation defensively).
    options.root.querySelector<HTMLButtonElement>('[data-private-room-leave-slot="1"]')
      ?.addEventListener('click', (event) => {
        event.stopPropagation()
        state.privateRoomLeaveSlotConfirmOpen = true
        render()
      })

    options.root.querySelector<HTMLButtonElement>('[data-private-room-leave-popup-confirm="1"]')
      ?.addEventListener('click', () => {
        state.privateRoomLeaveSlotConfirmOpen = false
        options.onPrivateRoomLeave?.()
        render()
      })

    options.root.querySelector<HTMLButtonElement>('[data-private-room-leave-popup-cancel="1"]')
      ?.addEventListener('click', () => {
        state.privateRoomLeaveSlotConfirmOpen = false
        render()
      })

    options.root.querySelector<HTMLElement>('[data-private-room-leave-popup-backdrop="1"]')
      ?.addEventListener('click', (event) => {
        if (event.target === event.currentTarget) {
          state.privateRoomLeaveSlotConfirmOpen = false
          render()
        }
      })

    options.root.querySelector<HTMLButtonElement>('[data-private-room-blocked-popup-close="1"]')
      ?.addEventListener('click', () => {
        state.privateRoomBlockedPopupText = null
        render()
      })

    options.root.querySelector<HTMLElement>('[data-private-room-blocked-popup-backdrop="1"]')
      ?.addEventListener('click', (event) => {
        if (event.target === event.currentTarget) {
          state.privateRoomBlockedPopupText = null
          render()
        }
      })

    // Bot бутони по отбор — enabled/disabled state вече е решен от render
    // функцията (computeTeamBotControlState); тук просто действаме, ако
    // бутонът не е disabled.
    options.root.querySelectorAll<HTMLButtonElement>('[data-private-room-bot-team]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.disabled || state.privateRoomBotActionLoadingTeam !== null) return
        const team = btn.getAttribute('data-private-room-bot-team')
        const mode = btn.getAttribute('data-private-room-bot-mode')
        if (team !== 'A' && team !== 'B') return
        state.privateRoomBotActionLoadingTeam = team
        if (mode === 'remove') {
          options.onPrivateRoomRemoveBot?.(team)
        } else {
          options.onPrivateRoomAddBot?.(team)
        }
        render()
      })
    })

    // Клик върху зает слот с реален чужд играч — отваря съществуващия
    // profile popup flow (не влиза в масата, не е "+").
    options.root.querySelectorAll<HTMLButtonElement>('[data-private-room-member]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const profileId = btn.getAttribute('data-private-room-member')
        const displayName = btn.getAttribute('data-private-room-member-name')
        if (profileId === null || profileId === '') return
        void openProtectedProfileById(profileId, displayName, 'other')
      })
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
          nextInput.setSelectionRange(caretStart, caretEnd, selectionDirection ?? 'none')
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
      state.lobbyChatFullscreen = false
      releaseLobbyChatBodyScrollLock()
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
    state.lobbyChatFullscreen = false
    releaseLobbyChatBodyScrollLock()
  }

  function forceLobbyChatResubscribeIfOnLobbyScreen(): void {
    state.lobbyChatSubscribed = false
    reconcileLobbyChatSubscription()
  }

  // Нова WS връзка = нов connection.id на сървъра => server-side членството в
  // privateRoomsStore (заключено по стария connection.id) вече не сочи към
  // тази връзка. request_private_rooms_list е единственият тригер за
  // server-side reconnectMember() — вика се и при всяко WS connect/reconnect
  // (вкл. пресен page load), не само при отваряне на таба „Частни маси“ —
  // виж main.ts WS onOpen. БЕЗ условие върху state.myPrivateRoom: след hard
  // refresh това поле винаги е null in-memory, независимо дали
  // потребителят реално е (все още) член на чакаща частна маса
  // server-side — единственият начин да разберем е да питаме. За
  // потребител, който никога не е използвал частни маси, това е просто
  // един безобиден допълнителен списък; ако сървърът потвърди членство,
  // private_room_updated ще го възстанови без да прехвърля насила екрана
  // (виж handler-а по-долу).
  function resyncPrivateRoomMembership(): void {
    options.onPrivateRoomsOpen?.()
  }

  function updateLobbyChatDraft(value: string): void {
    state.lobbyChatDraft = value
  }

  function setLobbyChatFullscreen(value: boolean): void {
    state.lobbyChatFullscreen = value
    render()
  }

  function openLobbyChatWriteLockedPopup(): void {
    state.lobbyChatWriteLockedPopupOpen = true
    render()
  }

  function closeLobbyChatWriteLockedPopup(): void {
    state.lobbyChatWriteLockedPopupOpen = false
    render()
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
    // Teardown-only reconcile за Topics realtime subscription — setup
    // (subscribe) се прави ИЗРИЧНО и последователно от openTopic/
    // loadTopicMessagesForActiveTopic (Етап 2 корекция т.1 gap-closing flow),
    // но напускане на "Теми" екрана изцяло (навигация другаде) трябва винаги
    // да unsubscribe-ва, независимо кой път е довел дотам.
    if (state.currentScreen !== 'topics') {
      unsubscribeFromCurrentTopicMessages()
      // Directory-wide subscription вече служи и за lightweight Lobby badge
      // metadata. Държим я жива извън Topics, докато има зареден directory
      // snapshot за логнат профил; без snapshot/auth няма какво да reconcile-ваме.
      if ((options.getAuthSession?.() ?? null) === null || state.topics === null) {
        unsubscribeFromTopicsDirectory()
      }
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
    // Transient "защо се променят Topics съобщенията" hint — консумиран
    // синхронно от renderLobbyScreen вътре в renderLobby() по-горе, нулира
    // се веднага след употреба (виж topicMessagesRenderReason в типа).
    state.topicMessagesRenderReason = null
    state.topicMessagesScrollAnchor = null
    state.topicThreadRenderReason = null
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
        state.profilePopupRequestToken += 1
        state.profilePopupOpen = false
        state.profilePopupProfile = null
        state.profilePopupCanEdit = true
        state.profilePopupContext = 'other'
        state.vipGrantOpen = false
        state.vipGrantSubmitting = false
        state.vipGrantErrorText = null
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
      onPikaSupportChatClick: (profileId) => { void startPikaSupportChatAndOpen(profileId) },
      onTopicsPersonalMessageClick: () => {},
      onLikeClick: (profileId) => { void likeProfile(profileId) },
      onGrantSubadminClick: (profileId) => {
        if (!profileId) return
        const displayName = state.profilePopupProfile?.displayName ?? 'потребителя'
        const previousRole = state.profilePopupTargetRole === 'chat_admin' || state.profilePopupTargetRole === 'pika_team' || state.profilePopupTargetRole === 'top_chat_admin'
          ? state.profilePopupTargetRole
          : null
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
        const previousRole = state.profilePopupTargetRole === 'subadmin' || state.profilePopupTargetRole === 'pika_team' || state.profilePopupTargetRole === 'top_chat_admin'
          ? state.profilePopupTargetRole
          : null
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
      onGrantPikaTeamClick: (profileId) => {
        if (!profileId) return
        const displayName = state.profilePopupProfile?.displayName ?? 'потребителя'
        const previousRole = state.profilePopupTargetRole === 'subadmin' || state.profilePopupTargetRole === 'chat_admin' || state.profilePopupTargetRole === 'top_chat_admin'
          ? state.profilePopupTargetRole
          : null
        state.pikaTeamActionConfirm = { profileId, displayName, action: 'grant', previousRole }
        state.profilePopupOpen = false
        syncProfilePopup({ isOpen: false, profile: null, canEdit: false, friendshipAction: null }, getPopupCallbacks())
        render()
      },
      onRevokePikaTeamClick: (profileId) => {
        if (!profileId) return
        const displayName = state.profilePopupProfile?.displayName ?? 'потребителя'
        state.pikaTeamActionConfirm = { profileId, displayName, action: 'revoke' }
        state.profilePopupOpen = false
        syncProfilePopup({ isOpen: false, profile: null, canEdit: false, friendshipAction: null }, getPopupCallbacks())
        render()
      },
      onGrantTopChatAdminClick: (profileId) => {
        if (!profileId) return
        const displayName = state.profilePopupProfile?.displayName ?? 'потребителя'
        const previousRole = state.profilePopupTargetRole === 'subadmin' || state.profilePopupTargetRole === 'chat_admin' || state.profilePopupTargetRole === 'pika_team'
          ? state.profilePopupTargetRole
          : null
        state.topChatAdminActionConfirm = { profileId, displayName, action: 'grant', previousRole }
        state.profilePopupOpen = false
        syncProfilePopup({ isOpen: false, profile: null, canEdit: false, friendshipAction: null }, getPopupCallbacks())
        render()
      },
      onRevokeTopChatAdminClick: (profileId) => {
        if (!profileId) return
        const displayName = state.profilePopupProfile?.displayName ?? 'потребителя'
        state.topChatAdminActionConfirm = { profileId, displayName, action: 'revoke' }
        state.profilePopupOpen = false
        syncProfilePopup({ isOpen: false, profile: null, canEdit: false, friendshipAction: null }, getPopupCallbacks())
        render()
      },
      // За разлика от subadmin/chat-admin/pika-team/top-chat-admin grant-овете
      // по-горе, "Дай VIP" НЕ затваря popup-а и НЕ отваря отделен confirm
      // overlay — компактна inline форма В САМИЯ popup (виж task brief-а).
      // Всички преходи минават през renderPopupOnly(), не render(), за да
      // няма Lobby flicker (същия overlay-only принцип като Edit↔Profile).
      onVipGrantOpen: (profileId) => {
        if (!profileId) return
        state.vipGrantOpen = true
        state.vipGrantErrorText = null
        renderPopupOnly()
      },
      onVipGrantCancel: () => {
        state.vipGrantOpen = false
        state.vipGrantErrorText = null
        state.vipGrantSubmitting = false
        renderPopupOnly()
      },
      onVipGrantSubmit: (profileId, rawDays) => {
        void submitAdminVipGrant(profileId, rawDays)
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

  function ensureOwnVipStatusLoaded(): void {
    const authSession = options.getAuthSession?.() ?? null
    // За own profile state.profilePopupProfile си остава null (виж
    // openProtectedProfileById/onProfileClick — never populate-ват го за
    // собствения профил), затова използваме СЪЩИЯ fallback като
    // renderPopupOnly() (createLocalProfilePreview), иначе тази проверка
    // винаги early-return-ва и VIP статусът никога не се зарежда за own
    // profile (production data-flow bug, фиксиран тук).
    const profile = state.profilePopupProfile ?? createLocalProfilePreview(state, authSession)
    const ownProfileId = authSession?.profile.profileId ?? null

    if (!state.profilePopupOpen || profile === null || profile.profileId === null || ownProfileId === null) {
      // Popup затворен (или все още няма профил) — нулираме guard-а, за да
      // може следващото отваряне на own profile да refetch-не свеж статус
      // (напр. ако потребителят междувременно е взел launch gift).
      state.ownVipActiveUntilLoadedForProfileId = null
      return
    }
    if (profile.profileId !== ownProfileId) {
      return
    }
    if (state.ownVipActiveUntilLoadedForProfileId === ownProfileId) {
      return
    }

    state.ownVipActiveUntilLoadedForProfileId = ownProfileId

    void (async () => {
      const result = await options.onGetOwnVipStatus?.()
      // Ако попъпът вече е затворен (или memoization guard е нулиран) междувременно,
      // резултатът е stale — не го прилагаме.
      if (!result || state.ownVipActiveUntilLoadedForProfileId !== ownProfileId) {
        return
      }
      if (result.ok) {
        state.ownVipActiveUntil = result.activeUntil
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

  function cancelPikaTeamAction(): void {
    if (state.pikaTeamActionBusy) return
    state.pikaTeamActionConfirm = null
    render()
  }

  let pikaTeamActionToastGeneration = 0

  async function confirmPikaTeamAction(): Promise<void> {
    const pending = state.pikaTeamActionConfirm
    if (!pending || state.pikaTeamActionBusy) return

    state.pikaTeamActionBusy = true
    render()

    const caller = pending.action === 'grant' ? options.onAdminGrantPikaTeam : options.onAdminRevokePikaTeam
    const result = await caller?.(pending.profileId)

    state.pikaTeamActionBusy = false
    state.pikaTeamActionConfirm = null

    if (result?.ok) {
      state.pikaTeamActionToast = {
        text: pending.action === 'grant' ? 'Потребителят вече е Екип Pika.bg.' : 'Ролята Екип Pika.bg е премахната.',
        ok: true,
      }
      if (state.profilePopupTargetRoleProfileId === pending.profileId) {
        state.profilePopupTargetRoleProfileId = null
        state.profilePopupTargetRole = null
      }
    } else {
      state.pikaTeamActionToast = {
        text: result?.message ?? 'Действието не бе завършено.',
        ok: false,
      }
    }
    render()

    const toastGeneration = ++pikaTeamActionToastGeneration
    setTimeout(() => {
      if (toastGeneration !== pikaTeamActionToastGeneration) return
      state.pikaTeamActionToast = null
      render()
    }, 3500)
  }

  function cancelTopChatAdminAction(): void {
    if (state.topChatAdminActionBusy) return
    state.topChatAdminActionConfirm = null
    render()
  }

  let topChatAdminActionToastGeneration = 0

  async function confirmTopChatAdminAction(): Promise<void> {
    const pending = state.topChatAdminActionConfirm
    if (!pending || state.topChatAdminActionBusy) return

    state.topChatAdminActionBusy = true
    render()

    const caller = pending.action === 'grant' ? options.onAdminGrantTopChatAdmin : options.onAdminRevokeTopChatAdmin
    const result = await caller?.(pending.profileId)

    state.topChatAdminActionBusy = false
    state.topChatAdminActionConfirm = null

    if (result?.ok) {
      state.topChatAdminActionToast = {
        text: pending.action === 'grant' ? 'Потребителят вече е TOP чат админ.' : 'Ролята TOP чат админ е премахната.',
        ok: true,
      }
      if (state.profilePopupTargetRoleProfileId === pending.profileId) {
        state.profilePopupTargetRoleProfileId = null
        state.profilePopupTargetRole = null
      }
    } else {
      state.topChatAdminActionToast = {
        text: result?.message ?? 'Действието не бе завършено.',
        ok: false,
      }
    }
    render()

    const toastGeneration = ++topChatAdminActionToastGeneration
    setTimeout(() => {
      if (toastGeneration !== topChatAdminActionToastGeneration) return
      state.topChatAdminActionToast = null
      render()
    }, 3500)
  }

  async function openProtectedProfileById(profileId: string, displayNameHint: string | null = null, context: ProfilePopupContext = 'other'): Promise<void> {
    const authSession = options.getAuthSession?.() ?? null
    const ownProfileId = authSession?.profile.profileId ?? null
    const isOwn = ownProfileId !== null && profileId === ownProfileId
    const requestToken = ++state.profilePopupRequestToken

    state.profileAccessBlockPopup = null
    state.profilePopupOpen = false
    state.profilePopupProfile = null
    state.profilePopupCanEdit = isOwn
    state.profilePopupContext = context

    if (isOwn) {
      state.profilePopupOpen = true
      renderPopupOnly()
      void fetchOwnLikesCount()
      return
    }

    render()
    void ensureFriendshipsLoaded()

    if (!options.onProfileByIdLoad) return
    const result = await options.onProfileByIdLoad(profileId)

    if (state.profilePopupRequestToken !== requestToken) return

    if (!result.ok) {
      if (result.code === 'profile_blocked_by_viewer' || result.code === 'profile_blocked_viewer') {
      state.profilePopupOpen = false
      state.profilePopupProfile = null
      state.profilePopupContext = 'other'
      state.profileAccessBlockPopup = { profileId, code: result.code }
        render()
        return
      }
      state.friendActionMessageProfileId = profileId
      state.friendActionMessage = result.message || `Профилът на ${displayNameHint ?? 'потребителя'} не беше зареден.`
      render()
      return
    }

    state.profilePopupProfile = result.profile
    state.profilePopupCanEdit = false
    state.profilePopupContext = context
    state.profilePopupOpen = true
    renderPopupOnly()
  }

  function renderPopupOnly(renderOptions?: { skipAnimation?: boolean }): void {
    const authSession = options.getAuthSession?.() ?? null
    ensureProfilePopupTargetRoleLoaded()
    ensureOwnVipStatusLoaded()
    const popupProfile = state.profilePopupProfile ?? createLocalProfilePreview(state, authSession)
    const isOwnProfile = authSession !== null
      && popupProfile.profileId !== null
      && popupProfile.profileId === authSession.profile.profileId
    const showTopicsPersonalMessageButton = false
    syncProfilePopup(
      {
        isOpen: state.profilePopupOpen,
        profile: popupProfile,
        canEdit: state.profilePopupCanEdit,
        isAdmin: isFullAdminAuthSession(authSession),
        isOwnProfile,
        friendshipAction: buildPopupFriendshipAction(),
        viewerIsFullAdmin: isFullAdminAuthSession(authSession),
        targetAccountRole: state.profilePopupTargetRole,
        showPikaSupportChatButton: shouldShowPikaSupportChatButton(authSession),
        showTopicsPersonalMessageButton,
        ownVipActiveUntil: isOwnProfile ? state.ownVipActiveUntil : null,
        vipGrantOpen: state.vipGrantOpen,
        vipGrantSubmitting: state.vipGrantSubmitting,
        vipGrantErrorText: state.vipGrantErrorText,
        skipAnimation: renderOptions?.skipAnimation,
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
      // Defensive reset — never leaves an in-flight create/join marked as
      // "in flight" forever if the server rejects it (e.g. stake no longer
      // available, room full, race with another joiner).
      state.privateRoomJoinInFlight = false
      if (state.currentScreen === 'private-rooms' || state.currentScreen === 'private-room-waiting') {
        // The waiting room bypasses normal lobby chrome (same as
        // matchmaking-room), so it never displays the generic
        // state.errorText toast — without this branch, a server-side
        // rejection (e.g. a race-lost bot-add attempt) would be silently
        // swallowed instead of shown in the waiting room's own info banner.
        // privateRoomJoinSlotPopup is cleared on EITHER screen — a rejected
        // join (e.g. private_room_slot_taken race) must not leave a stale
        // confirm popup open, whether it was triggered from the list's
        // direct "+" or the waiting room's previewer "+".
        if (state.currentScreen === 'private-room-waiting') {
          state.privateRoomBotActionLoadingTeam = null
        }
        state.privateRoomJoinSlotPopup = null
        if (
          message.code === 'private_room_partner_blocked' ||
          message.code === 'private_room_partner_blocked_by_viewer'
        ) {
          // Отделен X-only popup вместо generic info banner — виж
          // спецификацията за "Не можете да влезете в този отбор".
          state.privateRoomBlockedPopupText = message.message
        } else {
          state.privateRoomInfoText = message.message
        }
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
      const isActiveConversation = isActivePersonalChatConversation(message.friendshipId)
      const existingConversation = state.chatConversations.find((c) => c.friendshipId === message.friendshipId) ?? null
      if (existingConversation !== null) {
        const updatedConversation = {
          ...existingConversation,
          updatedAt: new Date().toISOString(),
          unreadCount: isActiveConversation
            ? 0
            : existingConversation.unreadCount + 1,
        }
        state.chatConversations = [
          updatedConversation,
          ...state.chatConversations.filter((c) => c.friendshipId !== message.friendshipId),
        ]
        render()
      } else if (!isActiveConversation) {
        render()
      }
      void refreshChatAfterNotification(message.friendshipId)
      return true
    }

    if (message.type === 'lobby_chat_history') {
      // Merge с дедупликация по messageId — живо съобщение може вече да е
      // пристигнало (напр. през cross-instance poll-а) преди историята,
      // ако subscribe/insert са паднали в много тясен race прозорец.
      const normalizedMessages = message.messages.map((m) => ({
        ...m,
        senderRole: resolveLobbyChatSenderRole(m),
      }))
      const freshIds = new Set(normalizedMessages.map((m) => m.messageId))
      const minFreshSeq = normalizedMessages.length > 0
        ? Math.min(...normalizedMessages.map((m) => m.seq))
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
      const newFromHistory = normalizedMessages.filter((m) => !keptExistingIds.has(m.messageId))

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
            senderRole: resolveLobbyChatSenderRole(message),
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

    // Production flicker fix (§7 от брифа) — badge-only push-ове опитват
    // targeted textContent patch (refreshTopicsUnreadDom) вместо unconditional
    // пълен render(). Ако presence/absence на конкретен badge span трябва да
    // се промени (0→>0 create / >0→0 remove), helper-ът връща false и
    // fallback-ваме към scheduleRender() (debounce-нат coalescing, не
    // synchronous render() — high-frequency badge push-ове не трябва да
    // тригерват незабавен пълен remount дори във fallback пътя).
    if (message.type === 'topic_unread_count_changed') {
      // FIX: state.activeTopicId се задава при openTopic/openTopicThread, но
      // НИКОГА не се reset-ва на null при напускане на Topics screen (виж
      // switchToLobby/resetToLobby) — остава stale ("бил съм там веднъж
      // тая сесия"), не отразява дали потребителят РЕАЛНО гледа темата сега.
      // Старият guard third-ваше самò activeTopicId match, значи Lafche push
      // винаги минаваше през markActiveTopicSeen (force count->0, DOM никога
      // не вижда >0) дори когато потребителят отдавна е напуснал Topics.
      // Добавен isReallyViewingThisTopic — mirror на established pattern-a в
      // markActiveTopicSeen самата (`changed && state.currentScreen ===
      // 'topics'`), за да third-ва "реално гледам сега", не само "последно
      // отворена тема".
      const isReallyViewingThisTopic = state.currentScreen === 'topics'
        && state.topicsMode === 'topics'
        && message.topicId === state.activeTopicId
      if (isReallyViewingThisTopic && !isGeneralTopicId(message.topicId)) {
        void markActiveTopicSeen(message.topicId)
        return true
      }
      const changed = updateTopicUnreadCount(message.topicId, message.unreadCount)
      if (changed) {
        const patched = refreshTopicsUnreadDom(options.root, buildLobbyScreenState())
        if (!patched) {
          scheduleRender()
        }
      }
      return true
    }

    if (message.type === 'topic_seen_updated') {
      const changed = updateTopicUnreadCount(message.topicId, message.unreadCount)
      if (changed) {
        if (!refreshTopicsUnreadDom(options.root, buildLobbyScreenState())) {
          scheduleRender()
        }
      }
      return true
    }

    if (message.type === 'topic_thread_unread_count_changed') {
      const isCurrentThread = state.topicsMode === 'thread' && state.topicThreadRootMessageId === message.rootMessageId
      const changedRoot = updateTopicThreadUnreadCount(
        message.rootMessageId,
        isCurrentThread ? 0 : message.unreadCount,
      )
      const changedTopic = updateTopicUnreadCount(message.topicId, message.topicUnreadCount)
      if (isCurrentThread) {
        void markTopicThreadSeen(message.rootMessageId)
      }
      if (changedRoot || changedTopic) {
        if (!refreshTopicsUnreadDom(options.root, buildLobbyScreenState())) {
          scheduleRender()
        }
      }
      return true
    }

    if (message.type === 'topic_thread_seen_updated') {
      const changedRoot = updateTopicThreadUnreadCount(message.rootMessageId, message.unreadCount)
      const changedTopic = updateTopicUnreadCount(message.topicId, message.topicUnreadCount)
      if (changedRoot || changedTopic) {
        if (!refreshTopicsUnreadDom(options.root, buildLobbyScreenState())) {
          scheduleRender()
        }
      }
      return true
    }

    if (message.type === 'topic_message_catchup') {
      // Stale-response guard — потребителят може вече да е превключил темата
      // докато catch-up отговорът е висял (rapid switch race).
      if (message.topicId !== state.activeTopicId) {
        return true
      }
      if (message.messages.length > 0) {
        const scrollAnchor = isTopicMessagesNearTop() ? null : captureTopicMessagesScrollAnchor()
        state.topicMessages = capLafcheMessagesIfNeeded(message.topicId, mergeTopicMessages(state.topicMessages ?? [], message.messages))
        updateLatestKnownSeqFromMessages(message.topicId, message.messages)
        seedLikeStateFromMessages(message.messages)
        // reconnect-refresh поведение (near-bottom threshold, НЕ форсиран
        // bottom) — catch-up batch-ът може да съдържа съобщения, докато
        // потребителят чете стари, скролнал нагоре.
        state.topicMessagesScrollAnchor = scrollAnchor
        state.topicMessagesRenderReason = 'reconnect-refresh'
        render()
      }
      void markActiveTopicSeen(message.topicId)
      if (message.truncated) {
        // Gap-ът е по-голям от cap-а — падаме обратно на обикновен REST
        // recent refresh (Етап 2 брифа т.1/т.8), без да форсираме bottom.
        void refreshTopicMessagesAfterTruncatedCatchup(message.topicId)
      }
      return true
    }

    if (message.type === 'topic_message') {
      // Defense-in-depth guard — subscription-ът вече би трябвало да
      // гарантира това (сървърът broadcast-ва само към subscribers на
      // точно тази тема), но rapid switch race по мрежата е възможен.
      if (message.topicId !== state.activeTopicId) {
        return true
      }

      const { type: _msgType, requestId, ...incomingMessage } = message
      const isOwnRootMessageAck = requestId !== undefined && requestId === state.topicComposerPendingRequestIdByTopicId[message.topicId]
      const scrollAnchor = isOwnRootMessageAck || isTopicMessagesNearTop() ? null : captureTopicMessagesScrollAnchor()
      state.topicMessages = capLafcheMessagesIfNeeded(message.topicId, mergeTopicMessages(state.topicMessages ?? [], [incomingMessage]))
      updateLatestKnownSeqFromMessages(message.topicId, [incomingMessage])
      seedLikeStateFromMessages([incomingMessage])

      // Ack по requestId (НЕ по body matching — Етап 2 корекция т.4): само
      // ТОЧНО съвпадащ pending requestId за тази тема чисти draft-а/pending state-а.
      if (isOwnRootMessageAck) {
        state.topicComposerDraftByTopicId[message.topicId] = ''
        state.topicComposerPendingRequestIdByTopicId[message.topicId] = null
        state.topicComposerErrorTextByTopicId[message.topicId] = null
        // Успешен send — изчиства избраната снимка (Attachment брифа т.6:
        // "При успешен send: clear text; clear attachment selection").
        clearTopicComposerPendingImage(message.topicId)
      }

      void markActiveTopicSeen(message.topicId)

      // Production flicker fix — high-frequency Lafche/Topics push (§2 от
      // брифа): чужда own-message live-append при активна stream view опитва
      // targeted single-node DOM insert (appendTopicMessageNode) вместо
      // unconditional пълен render() (root.innerHTML remount). Own-message
      // ack path (composer draft clear) и всеки edge case, който targeted
      // append не покрива (thread view, различна тема, липсващи containers),
      // fallback-ва безопасно към пълен render() със established scroll-
      // preservation логика (topicMessagesScrollAnchor/RenderReason).
      if (!isOwnRootMessageAck) {
        const patched = appendTopicMessageNode(options.root, buildLobbyScreenState(), topicMessageNodeCallbacks(), incomingMessage)
        if (patched) {
          return true
        }
      }

      state.topicMessagesScrollAnchor = scrollAnchor
      state.topicMessagesRenderReason = isOwnRootMessageAck ? 'own-message' : 'live-append'
      render()
      return true
    }

    if (message.type === 'topic_message_error') {
      const pendingTopicId = Object.keys(state.topicComposerPendingRequestIdByTopicId).find(
        (topicId) => state.topicComposerPendingRequestIdByTopicId[topicId] === message.requestId,
      )
      if (pendingTopicId !== undefined) {
        state.topicComposerPendingRequestIdByTopicId[pendingTopicId] = null
        // Draft НЕ се чисти при грешка — потребителят не губи текста (Етап 2 корекция т.4).
        // topic_muted вече НЕ пише в inline композер текста — показва се
        // popup-ът вместо това (виж evaluateTopicsSectionMutePopup по-долу).
        if (message.code !== 'topic_muted') {
          state.topicComposerErrorTextByTopicId[pendingTopicId] = message.message
        }
      }

      if (message.code === 'vip_required') {
        // Server е source of truth — VIP може да е изтекъл между отваряне на
        // composer-а и send-а. Re-fetch canonical статус и отвори VIP flow-а
        // веднага, БЕЗ page reload (Етап 2 корекция т.5).
        if (state.topicsVipGate) {
          state.topicsVipGate = { ...state.topicsVipGate, isActive: false }
        }
        void refreshTopicsVipGateStatus()
        state.topicsVipPopupOpen = true
      }

      // Пропуснат mute realtime push (напр. mute-нат докато композер-ът е
      // бил отворен, но преди target-only WS push-а да пристигне) — send
      // опитът самия открива restriction-a. Обновяваме state-а веднага от
      // error response-а, не чакаме отделен push. GLOBAL TOPICS MUTE брифа
      // §9: state-ът е global — важи независимо от активната тема, значи НЕ
      // е условен на message.topicId === state.activeTopicId. Директен
      // резултат от user SEND click → force-open (без ack-dedup), огледално
      // на client-side pre-check-а в submitTopicComposerMessage.
      if (message.code === 'topic_muted') {
        state.activeTopicViewerMute = { isMuted: true, mutedUntil: message.mutedUntil ?? null, mutedByAccountId: null, reason: message.reason ?? null }
        openTopicsSectionMutePopupForAttempt()
      }

      render()
      return true
    }

    if (message.type === 'topic_reply') {
      // Reply push идва към ВСИЧКИ subscribers на темата (сървърът не следи
      // expanded state client-side, виж коментара при
      // broadcastTopicReplyToLocalSubscribers/index.ts) — клиентът решава
      // append vs. counter-only update.
      if (message.topicId !== state.activeTopicId) {
        return true
      }

      const { type: _msgType, requestId, ...incomingReply } = message
      const rootMessageId = incomingReply.parentMessageId

      // Root replyCount винаги се увеличава, независимо от expanded state
      // (Етап 3 брифа: "ако collapsed → само counter се обновява").
      const rootMessage = (state.topicMessages ?? []).find((m) => m.messageId === rootMessageId)
      const scrollAnchor = captureTopicMessagesScrollAnchor()
      if (rootMessage) {
        rootMessage.replyCount += 1
        if (Date.parse(incomingReply.createdAt) >= getTopicMessageActivityMs(rootMessage)) {
          rootMessage.lastActivityAt = incomingReply.createdAt
        }
      }

      const isCurrentThread = state.topicsMode === 'thread' && state.topicThreadRootMessageId === rootMessageId
      const isExpanded = state.topicExpandedReplyRootIds.includes(rootMessageId)
      const alreadyLoaded = state.topicRepliesByRootId[rootMessageId] !== undefined && state.topicRepliesByRootId[rootMessageId] !== null
      if ((isExpanded || isCurrentThread) && alreadyLoaded) {
        const existing = state.topicRepliesByRootId[rootMessageId] ?? []
        const byId = new Map<string, TopicReplySnapshot>()
        for (const r of existing) byId.set(r.messageId, r)
        byId.set(incomingReply.messageId, incomingReply)
        state.topicRepliesByRootId[rootMessageId] = [...byId.values()].sort((a, b) => a.seq - b.seq)
        seedLikeStateFromMessages([incomingReply])
      }

      // Ack по requestId — reply composer draft/pending clearing (keyed по
      // rootMessageId, не topicId — виж т.13).
      if (requestId !== undefined && requestId === state.topicReplyComposerPendingRequestIdByRootId[rootMessageId]) {
        state.topicReplyComposerDraftByRootId[rootMessageId] = ''
        state.topicReplyComposerPendingRequestIdByRootId[rootMessageId] = null
        state.topicReplyComposerErrorTextByRootId[rootMessageId] = null
        clearTopicReplyComposerPendingImage(rootMessageId)
        state.topicThreadRenderReason = isCurrentThread ? 'own-reply' : state.topicThreadRenderReason
      }

      if (rootMessage) {
        state.topicMessages = sortTopicMessagesByActivity(state.topicMessages ?? [])
        if (isCurrentThread) {
          state.topicThreadRenderReason = state.topicThreadRenderReason ?? 'live-append'
        } else {
          state.topicMessagesScrollAnchor = scrollAnchor
          state.topicMessagesRenderReason = 'reorder'
        }
      } else {
        void refreshTopicMessagesAfterActivityChange(message.topicId)
      }

      if (isCurrentThread) {
        void markTopicThreadSeen(rootMessageId)
      } else {
        void markActiveTopicSeen(message.topicId)
      }
      render()
      return true
    }

    if (message.type === 'topic_reply_error') {
      const pendingRootId = Object.keys(state.topicReplyComposerPendingRequestIdByRootId).find(
        (rootId) => state.topicReplyComposerPendingRequestIdByRootId[rootId] === message.requestId,
      )
      if (pendingRootId !== undefined) {
        state.topicReplyComposerPendingRequestIdByRootId[pendingRootId] = null
        // GLOBAL TOPICS MUTE брифа §10 — exact сървърен mutedUntil/reason.
        state.topicReplyComposerErrorTextByRootId[pendingRootId] = message.code === 'topic_muted'
          ? formatTopicsSectionMuteErrorText(message.mutedUntil, message.reason)
          : message.message
      }

      if (message.code === 'vip_required') {
        if (state.topicsVipGate) {
          state.topicsVipGate = { ...state.topicsVipGate, isActive: false }
        }
        void refreshTopicsVipGateStatus()
        state.topicsVipPopupOpen = true
      }

      if (message.code === 'topic_muted') {
        state.activeTopicViewerMute = { isMuted: true, mutedUntil: message.mutedUntil ?? null, mutedByAccountId: null, reason: message.reason ?? null }
      }

      render()
      return true
    }

    // Production flicker fix (§5 от брифа) — like push-ове patch-ват САМО
    // конкретния бутон (refreshTopicMessageLikeDom, outerHTML replace на
    // [data-topic-message-like], не целия message node/root) вместо
    // unconditional пълен render(). Node липсва (thread switch race) →
    // безопасен fallback към render() (rare path).
    if (message.type === 'topic_message_like_changed') {
      // PUBLIC broadcast — само count, viewer-agnostic. НИКОГА не пипа
      // topicMessageViewerHasLikedById (private state, само _self вариантът
      // го update-ва, виж т.13 — reconciliation, не merge).
      state.topicMessageLikeCountById[message.messageId] = message.likeCount
      // Синхронизираме и самия snapshot обект (root/reply), ако е зареден в
      // момента — за да не изостане derived render-а от override map-а.
      const rootMatch = (state.topicMessages ?? []).find((m) => m.messageId === message.messageId)
      if (rootMatch) rootMatch.likeCount = message.likeCount
      for (const replies of Object.values(state.topicRepliesByRootId)) {
        const replyMatch = replies?.find((r) => r.messageId === message.messageId)
        if (replyMatch) replyMatch.likeCount = message.likeCount
      }
      const viewerHasLiked = state.topicMessageViewerHasLikedById[message.messageId] ?? (rootMatch?.viewerHasLiked ?? false)
      const patched = refreshTopicMessageLikeDom(
        options.root,
        buildLobbyScreenState(),
        topicMessageNodeCallbacks(),
        message.messageId,
        message.likeCount,
        viewerHasLiked,
      )
      if (!patched) render()
      return true
    }

    if (message.type === 'topic_message_like_changed_self') {
      // PRIVATE ack към toggle-ващия connection — authoritative reconciliation
      // на optimistic UI (виж т.13, т.7 от плана): сървърният отговор ВИНАГИ
      // побеждава локалния optimistic guess, независимо от pending timing.
      if (state.topicMessageLikePendingRequestIdById[message.messageId] === message.requestId) {
        state.topicMessageLikePendingRequestIdById[message.messageId] = null
      }
      state.topicMessageLikeCountById[message.messageId] = message.likeCount
      state.topicMessageViewerHasLikedById[message.messageId] = message.viewerHasLiked
      const rootMatch = (state.topicMessages ?? []).find((m) => m.messageId === message.messageId)
      if (rootMatch) {
        rootMatch.likeCount = message.likeCount
        rootMatch.viewerHasLiked = message.viewerHasLiked
      }
      for (const replies of Object.values(state.topicRepliesByRootId)) {
        const replyMatch = replies?.find((r) => r.messageId === message.messageId)
        if (replyMatch) {
          replyMatch.likeCount = message.likeCount
          replyMatch.viewerHasLiked = message.viewerHasLiked
        }
      }
      const patched = refreshTopicMessageLikeDom(
        options.root,
        buildLobbyScreenState(),
        topicMessageNodeCallbacks(),
        message.messageId,
        message.likeCount,
        message.viewerHasLiked,
      )
      if (!patched) render()
      return true
    }

    if (message.type === 'topic_message_like_error') {
      // Само revert-ва pending state-а, ако все още е pending за ТОЗИ requestId
      // — timeout-driven revert (виж submitTopicMessageLikeToggle в Етап 3e)
      // може вече да е изчистил pending-а преди error-ът да пристигне.
      for (const [messageId, pendingRequestId] of Object.entries(state.topicMessageLikePendingRequestIdById)) {
        if (pendingRequestId === message.requestId) {
          state.topicMessageLikePendingRequestIdById[messageId] = null
        }
      }
      render()
      return true
    }

    if (message.type === 'topic_created') {
      if (message.requestId !== undefined && message.requestId === state.topicCreatePendingRequestId) {
        handleTopicCreateSuccess(message.topic)
        return true
      }
      // Directory broadcast от друг user (или от собствения ни create, ако
      // near-simultaneous broadcast+success timing — виж index.ts коментара,
      // на практика не се случва защото originator-ът е skip-нат от
      // broadcast-а, но upsert-ът тук е idempotent defense-in-depth).
      handleTopicCreatedBroadcast(message.topic)
      return true
    }

    if (message.type === 'topic_create_error') {
      if (message.requestId === state.topicCreatePendingRequestId) {
        // GLOBAL TOPICS MUTE брифа §10 — exact сървърен mutedUntil/reason,
        // форматирани в пълния Bulgarian error текст, не generic съобщение.
        const errorText = message.code === 'topic_muted'
          ? formatTopicsSectionMuteErrorText(message.mutedUntil, message.reason)
          : message.message
        handleTopicCreateError(errorText)
        if (message.code === 'topic_muted') {
          state.activeTopicViewerMute = { isMuted: true, mutedUntil: message.mutedUntil ?? null, mutedByAccountId: null, reason: message.reason ?? null }
        }
      }
      // requestId mismatch → stale/foreign response, игнорирай мълчаливо
      // (established convention, mirror на topic_message_error handling-а).
      return true
    }

    // ─── Topics Moderation realtime (Етап 4) ───────────────────────────────

    if (message.type === 'topic_lock_state_changed') {
      // Public broadcast към ВСИЧКИ subscribers — composer/banner state се
      // обновява без refresh (брифа т.10), независимо кой е задействал lock/
      // unlock-а. Обновяваме и topics list snapshot-а (за случая, в който
      // потребителят се върне в directory-то, без re-fetch).
      if (state.topics) {
        state.topics = state.topics.map((t) => t.topicId === message.topicId
          ? { ...t, status: message.isLocked ? 'locked' : t.status === 'locked' ? 'active' : t.status, lockedUntil: message.lockedUntil, lockedReason: message.lockedReason }
          : t)
      }
      if (message.topicId === state.activeTopicId) {
        state.activeTopicLock = { isLocked: message.isLocked, lockedUntil: message.lockedUntil, lockedByAccountId: null, lockedReason: message.lockedReason }
      }
      render()
      return true
    }

    if (message.type === 'topic_mute_state_changed') {
      // Target-only push (виж index.ts notifyProfileOfTopicMuteStateChange)
      // — само СОБСТВЕНИЯТ browser на заглушения/отглушения потребител
      // получава това съобщение, значи винаги важи за viewer-а самия.
      // scope='topics_section' (GLOBAL TOPICS MUTE брифа §12) — state-ът
      // важи за ЦЯЛАТА секция "Теми", НЕ само за message.topicId, затова
      // винаги се прилага, независимо от активната тема (multi-tab: всеки
      // отворен таб на същия потребител получава own connection push и
      // прилага state-а идентично).
      state.activeTopicViewerMute = { isMuted: message.isMuted, mutedUntil: message.mutedUntil, mutedByAccountId: null, reason: message.reason }
      // Нов realtime mute докато потребителят е в "Теми" → popup веднага
      // (unmute: isMuted=false → evaluateTopicsSectionMutePopup затваря
      // popup-а, ако е бил отворен).
      evaluateTopicsSectionMutePopup()
      render()
      return true
    }

    if (message.type === 'topic_deleted') {
      // Public broadcast — subscribed клиенти се прибират безопасно в Topics
      // directory (брифа т.10: "без crash/stale subscription"). Маха темата
      // от локалния списък directno (сървърът вече не я връща от
      // listActiveTopics, но re-fetch не е нужен тук).
      if (state.topics) {
        state.topics = state.topics.filter((t) => t.topicId !== message.topicId)
      }
      if (message.topicId === state.activeTopicId) {
        state.activeTopicId = null
        state.topicMessages = null
        state.activeTopicLock = null
        state.activeTopicViewerMute = null
        state.topicsErrorText = 'Темата беше премахната от модератор.'
        // subscription cleanup-ът вече е направен server-side (виж
        // broadcastTopicDeletedToLocalSubscribers) — тук само local state.
        const fallbackTopic = (state.topics ?? []).find((t) => t.isGeneral) ?? state.topics?.[0] ?? null
        if (fallbackTopic) {
          openTopic(fallbackTopic.topicId)
        }
      }
      render()
      return true
    }

    // Production flicker fix (§6 от брифа) — edit push patch-ва САМО
    // конкретния message/reply node (refreshTopicMessageContentDom, outerHTML
    // replace + re-wire, не целия root) вместо unconditional пълен render().
    if (message.type === 'topic_message_edited') {
      if (message.topicId === state.activeTopicId) {
        const changed = applyTopicMessageEdit(message.messageId, message.parentMessageId, message.body, message.editedAt)
        if (changed) {
          const patched = refreshTopicMessageContentDom(
            options.root,
            buildLobbyScreenState(),
            topicMessageNodeCallbacks(),
            message.messageId,
            message.parentMessageId,
          )
          if (!patched) render()
        }
      }
      return true
    }

    if (message.type === 'topic_profile_mute_state_changed') {
      // Public, boolean-only broadcast (mute indicator icon брифа §7) — не е
      // topic-scoped (section-wide mute важи навсякъде), затова се прилага
      // независимо от активната тема, стига авторът да има locally-loaded
      // съобщения/replies в момента.
      const changed = applyTopicsSectionMuteIndicatorChange(message.profileId, message.isTopicsSectionMuted)
      if (changed) {
        render()
      }
      return true
    }

    if (message.type === 'topic_message_deleted') {
      // Public broadcast при moderator delete на ОТДЕЛНО root съобщение или
      // reply (individual-message moderation, различно от topic_deleted
      // по-горе). No-op ако local state изобщо не съдържа messageId-а (block
      // filtering/viewer never loaded it — брифа §28). Никакъв tombstone
      // текст — пълно премахване от локалния state, mirror на established
      // lobby_chat_message_deleted handling.
      if (message.parentMessageId === null) {
        // ROOT target — маха root-а И всички locally-loaded replies към него,
        // затваря pending reply composer state (draft/pending/error) за този
        // root, за да не остане невидим dangling UI state (брифа §20).
        if (state.topicMessages) {
          state.topicMessages = state.topicMessages.filter((m) => m.messageId !== message.messageId)
        }
        delete state.topicRepliesByRootId[message.messageId]
        state.topicExpandedReplyRootIds = state.topicExpandedReplyRootIds.filter((id) => id !== message.messageId)
        delete state.topicReplyComposerDraftByRootId[message.messageId]
        delete state.topicReplyComposerPendingRequestIdByRootId[message.messageId]
        delete state.topicReplyComposerErrorTextByRootId[message.messageId]
        delete state.topicReplyComposerPendingImageByRootId[message.messageId]
        if (state.topicReplyComposerOpenRootId === message.messageId) {
          state.topicReplyComposerOpenRootId = null
        }
        if (state.topicsMode === 'thread' && state.topicThreadRootMessageId === message.messageId) {
          state.topicsMode = 'topics'
          state.topicThreadRootMessageId = null
          state.topicMessagesScrollAnchor = state.topicThreadReturnScrollAnchor
          state.topicThreadReturnScrollAnchor = null
          state.topicThreadRenderReason = null
        }
        if (state.topicMessageEdit !== null && findLoadedTopicMessage(state.topicMessageEdit.messageId) === null) {
          state.topicMessageEdit = null
          state.topicMessageEditErrorText = null
          state.topicMessageEditBusy = false
        }
        render()
      } else {
        // REPLY target — маха само него от родителския replies списък. Root
        // и sibling replies остават непокътнати; replyCount на root-а се
        // reconcile-ва естествено от canonical aggregate mechanism (следваща
        // REST/poll refresh), mirror на established deleted_at IS NULL
        // read-path семантика — не пипаме локален counter directno тук.
        const siblingReplies = state.topicRepliesByRootId[message.parentMessageId]
        if (siblingReplies) {
          state.topicRepliesByRootId[message.parentMessageId] = siblingReplies.filter((r) => r.messageId !== message.messageId)
        }
        if (state.topicMessageEdit?.messageId === message.messageId) {
          state.topicMessageEdit = null
          state.topicMessageEditErrorText = null
          state.topicMessageEditBusy = false
        }
        if (message.topicId === state.activeTopicId) {
          void refreshTopicMessagesAfterActivityChange(message.topicId)
        }
        // Production flicker fix (§6 от брифа) — reply removal е чист
        // structural DOM removal (element.remove()), без mode-навигационни
        // side effects (за разлика от root-delete branch-а по-горе, който
        // остава на пълен render — може да превключи topicsMode/thread view).
        const patched = removeTopicMessageDom(options.root, message.messageId, message.parentMessageId)
        if (!patched) render()
      }
      return true
    }

    if (message.type === 'private_rooms_list') {
      state.privateRooms = message.rooms
      render()
      return true
    }

    if (message.type === 'private_games_list') {
      state.privateGamesPlaying = message.playing
      state.privateGamesFinished = message.finished
      // §7 брифа: избраният lifecycle tab НЕ трябва да reset-не при realtime
      // push. render() тук е safe — currentScreen/privateRoomsLifecycleTab
      // остават непроменени, значи re-render просто препродуцира СЪЩИЯ tab
      // (mirror на established private_rooms_list поведението по-горе, което
      // също прави пълен render() без tab-reset оплаквания). Пропускаме
      // render() изцяло, ако потребителят дори не е на "Частни маси" screen-а
      // — избягва ненужен reflow docато push-ът реално е ирелевантен визуално.
      if (state.currentScreen === 'private-rooms') {
        render()
      }
      return true
    }

    if (message.type === 'private_game_score_updated') {
      // Targeted score-only DOM patch — БЕЗ render(), за да не прекъсва
      // scroll/popup/tab state докато "Играещи" таб е отворен (§7 брифа).
      // Обновяваме и state (за консистентност при следващ пълен render), и
      // directно DOM текстовите nodes, ако вече са рендерирани.
      const idx = state.privateGamesPlaying.findIndex((g) => g.roomId === message.roomId)
      if (idx !== -1) {
        state.privateGamesPlaying = state.privateGamesPlaying.map((g, i) =>
          i === idx ? { ...g, teamAScore: message.teamAScore, teamBScore: message.teamBScore } : g,
        )
      }
      if (state.currentScreen === 'private-rooms' && state.privateRoomsLifecycleTab === 'playing') {
        // querySelectorAll + manual match (не CSS attribute-selector string
        // interpolation) — избягва нужда от CSS.escape за roomId стойността.
        // Двата отбора имат ОТДЕЛНИ score редове (под съответния отбор,
        // виж matchTeamScoreRowHtml в renderLobbyScreen.ts) — обновяваме
        // всеки поотделно по data-private-game-score-team ('a'/'b').
        const scoreEls = options.root.querySelectorAll<HTMLElement>('[data-private-game-score]')
        for (const el of scoreEls) {
          if (el.dataset.privateGameScore !== message.roomId) continue
          if (el.dataset.privateGameScoreTeam === 'a') {
            el.textContent = String(message.teamAScore)
          } else if (el.dataset.privateGameScoreTeam === 'b') {
            el.textContent = String(message.teamBScore)
          }
        }
      }
      return true
    }

    if (message.type === 'private_room_updated') {
      const isNewRoom = state.myPrivateRoom?.id !== message.room.id
      // Force-navigate to the waiting screen only for an EXPLICIT
      // create/join/invite-accept this session (privateRoomJoinInFlight).
      // The same isNewRoom branch also fires passively — e.g. the
      // reconnect/reload resync (resyncPrivateRoomMembership) discovering
      // an existing waiting-room membership the client didn't know about
      // yet — and that path must only restore state.myPrivateRoom (so the
      // "Чакаш в частна маса" strip can appear) without yanking the user
      // off whatever screen they're currently on.
      const shouldForceWaitingScreen = isNewRoom && state.privateRoomJoinInFlight
      state.myPrivateRoom = message.room
      // Пази коя стая да покаже leave→preview fallback-ът (виж
      // private_room_left по-долу) — сетва се при всяко установяване на
      // членство, независимо от начина (list-row preview join,
      // invite-accept-confirmed navigation, или reconnect-restore).
      state.previewedPrivateRoomId = message.room.id
      if (isNewRoom) {
        state.privateRoomJoinInFlight = false
        state.privateRoomWaitingChatMessages = []
        state.privateRoomWaitingChatSubscribedRoomId = null
        state.privateRoomWaitingChatErrorText = null
        state.privateRoomJoinSlotPopup = null
        state.privateRoomLeaveSlotConfirmOpen = false
        state.privateRoomBlockedPopupText = null
        state.privateRoomBotActionLoadingTeam = null
        state.privateRoomInvitedProfileIds = new Set()
        // Avoid carrying a stale banner (e.g. "Домакинът затвори масата.")
        // from a previous room into a freshly (re)joined one.
        state.privateRoomInfoText = null
      }
      if (shouldForceWaitingScreen) {
        state.currentScreen = 'private-room-waiting'
      }
      render()
      return true
    }

    if (message.type === 'private_room_left') {
      leavePrivateRoomWaitingScreen()
      state.myPrivateRoom = null
      state.privateRoomInvitedProfileIds = new Set()
      // Точка 6: ако стаята още съществува (свободни слотове от други хора),
      // оставаме на same-screen като previewer — НЕ редиректваме към
      // списъка. state.privateRooms вече е актуален по това време (сървърът
      // праща private_rooms_list ПРЕДИ private_room_left в рамките на
      // синхронния leave_private_room handler).
      const previewedRoomStillExists = state.previewedPrivateRoomId !== null
        && state.privateRooms.some((r) => r.id === state.previewedPrivateRoomId)
      if (!previewedRoomStillExists) {
        state.previewedPrivateRoomId = null
        state.currentScreen = 'private-rooms'
      }
      render()
      return true
    }

    if (message.type === 'private_room_expired') {
      const isMineOrPreviewed = state.myPrivateRoom?.id === message.privateRoomId
        || state.previewedPrivateRoomId === message.privateRoomId
      if (isMineOrPreviewed) {
        leavePrivateRoomWaitingScreen()
        state.myPrivateRoom = null
        state.previewedPrivateRoomId = null
        state.privateRoomJoinSlotPopup = null
        state.privateRoomLeaveSlotConfirmOpen = false
        state.privateRoomBlockedPopupText = null
        state.privateRoomBotActionLoadingTeam = null
        state.privateRoomInvitedProfileIds = new Set()
        // Отива в ОСНОВНОТО Lobby, не в списъка "Частни маси" — ако
        // потребителят вече е бил в Lobby (напр. през "Изчакай в лоби"),
        // това просто презаписва currentScreen със същата стойност (no-op
        // navigation-wise), точно каквото изисква сценарият "не го
        // навигирай никъде". private_rooms_list/badge вече идват от
        // canonical server broadcast-а — не се пипат тук.
        state.currentScreen = 'lobby'
        state.privateRoomInfoText = 'Времето за чакане изтече. Частната маса беше затворена.'
        render()
      }
      return true
    }

    if (message.type === 'private_room_invite_accept_confirmed') {
      // Приемане на покана вече не сяда автоматично — само дава room-lifetime
      // authorization. Навигираме към preview на стаята; реалният seat claim
      // минава през същия join-slot popup flow, както при отворените маси.
      state.previewedPrivateRoomId = message.privateRoomId
      state.currentScreen = 'private-room-waiting'
      render()
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
        state.privateRoomInvitedProfileIds = new Set()
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
      state.previewedPrivateRoomId = null
      state.privateRoomInvitedProfileIds = new Set()
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
    state.privateRoomJoinSlotPopup = null
    state.privateRoomLeaveSlotConfirmOpen = false
    state.privateRoomBlockedPopupText = null
    state.privateRoomBotActionLoadingTeam = null
  }

  // Reopens the SAME waiting room the user is already a member of — no new
  // join_private_room, no dublirano membership. Server-authoritative
  // membership (privateRoomsStore) never changed; this is purely a client
  // screen transition mirroring "Изчакай в лоби"'s inverse.
  function returnToPrivateRoomWaiting(): void {
    if (state.myPrivateRoom === null) {
      render()
      return
    }
    state.currentScreen = 'private-room-waiting'
    render()
  }

  // ЕДИНСТВЕНИЯТ navigation handler за "Частни маси" — извикван от ВСЕКИ
  // вход (desktop lobby картата, mobile quick action бутона —
  // data-lobby-private-rooms-card, споделен между двата render клона; плюс
  // всеки external caller като "влез в частните маси" от
  // privateRoomCreatedNotification в main.ts). Винаги отваря списъка —
  // ако потребителят вече е член на маса (state.myPrivateRoom !== null),
  // тя е pinned най-отгоре в списъка с бутон "ВЛЕЗ" (виж roomRowHtml в
  // renderLobbyScreen.ts / handlePrivateRoomListEnter по-долу), вместо
  // директно да прескача екрана — потребителят сам избира дали да влезе
  // обратно в чакалнята или само да разгледа другите маси.
  function navigateToPrivateRooms(): void {
    state.currentScreen = 'private-rooms'
    state.privateRoomInfoText = null
    state.privateRoomsTab = 'all'
    // Изискване: при отваряне на страницата по подразбиране ВИНАГИ "Чакащи",
    // независимо от кой tab е бил избран при предишно посещение.
    state.privateRoomsLifecycleTab = 'waiting'
    // Играещи/Приключили count-овете трябва да са коректни ВЕДНАГА при
    // отваряне на екрана (включително след browser refresh), не чак при
    // първи клик на съответния таб — затова fetch-ваме тук, не lazy при
    // onPrivateRoomsLifecycleTabChange. privateGamesLoaded=true СЕГА (не
    // false) предотвратява дублирано request при последващ клик на
    // "Играещи"/"Приключили" (виж onPrivateRoomsLifecycleTabChange guard-а).
    state.privateGamesLoaded = true
    options.onPrivateRoomsOpen?.()
    options.onPrivateGamesOpen?.()
    render()
  }

  // Общ helper за конфликтните точки (matchmaking search, създаване на нова
  // частна маса, приемане на покана, и — с variant='list-join' — конкретния
  // "+" клик на ДРУГА маса от списъка) — вижте task spec §10: "не напускай
  // автоматично текущата маса", само блокирай и покажи път назад.
  // variant='generic' (по подразбиране) пази непроменения споделен текст;
  // 'list-join' показва bespoke UX копие, договорено специално за "+"-на-
  // друга-маса сценария (виж renderPrivateRoomConflictPopup).
  function openPrivateRoomConflictPrompt(variant: 'generic' | 'list-join' = 'generic'): void {
    state.privateRoomConflictPromptOpen = true
    state.privateRoomConflictPromptVariant = variant
    render()
  }

  // Извлечена в именувана функция (не само inline options callback), за да
  // може да се извиква и публично (виж return statement-а по-долу) —
  // огледално на startMatchmaking, което е публично по същата причина:
  // external caller-и (тук: браузърни тестове, огледално на реален "Присъедини"
  // клик) трябва да могат да го тригернат директно, не само през DOM click.
  function handlePrivateRoomJoin(privateRoomId: string): void {
    if (state.myPrivateRoom !== null) {
      openPrivateRoomConflictPrompt()
      return
    }
    // Чист client-side preview navigation — НЕ изпраща join_private_room.
    // Реалният seat claim минава само през конкретния "+" (join-slot popup
    // confirm), никога само от отваряне на preview-а.
    state.previewedPrivateRoomId = privateRoomId
    state.currentScreen = 'private-room-waiting'
    render()
  }

  // Реконсилиран membership check срещу canonical private_rooms_list — вижте
  // идентичната логика в renderPrivateRoomsPage (renderLobbyScreen.ts) за
  // "ВЛЕЗ"/ordering. Използва се тук за "already seated elsewhere" guard-а,
  // за да не блокира join към нова маса заради stale state.myPrivateRoom,
  // сочещ вече изтекла/затворена/стартирала маса (task spec §10).
  function hasActiveOwnPrivateRoomMembership(): boolean {
    return state.myPrivateRoom !== null && state.privateRooms.some((r) => r.id === state.myPrivateRoom!.id)
  }

  // Списък с покания-eligible приятели за текущата (заключена) собствена
  // маса — споделен между списъчния екран и waiting room-а (виж
  // renderPrivateRoomInviteFriendsPopup в privateRoomPopupMarkup.ts).
  //
  // Policy, потвърдена от реалния server код (не предположение):
  // invite_to_private_room/inviteFriend НЕ изискват target-ът да е online —
  // единствената сървърна проверка е isProfileInActiveGame (виж index.ts).
  // Затова тук НЕ филтрираме до online — offline приятели остават в списъка,
  // само с "Офлайн" индикация (informational, не gating).
  function resolveInviteEligibleFriends(): PrivateRoomInviteEligibleFriend[] | null {
    if (state.friendships === null) return null
    if (state.myPrivateRoom === null) return []

    const localProfileId = options.getAuthSession?.()?.profile.profileId ?? null
    const seatedProfileIds = new Set(
      state.myPrivateRoom.slots
        .map((s) => s.occupant?.profileId)
        .filter((id): id is string => id !== null && id !== undefined),
    )

    return state.friendships.friends
      .filter((f) => f.profile.profileId !== null)
      .filter((f) => f.profile.profileId !== localProfileId)
      .filter((f) => !seatedProfileIds.has(f.profile.profileId as string))
      .map((f) => ({
        profileId: f.profile.profileId as string,
        displayName: f.profile.displayName,
        avatarUrl: f.profile.avatarUrl,
        isOnline: f.isOnline === true,
        isInGame: f.isInGame === true,
        status: state.privateRoomInvitedProfileIds.has(f.profile.profileId as string) ? 'sent' as const : 'invitable' as const,
      }))
  }

  // Директен "+" клик на конкретен слот в списъка "Частни маси" (не
  // собствената маса — тези бутони изобщо не се рендират за own room, виж
  // roomRowHtml). Ако потребителят вече седи на друга (реално активна) маса,
  // показва conflict popup-а вместо join popup — не пипа server state.
  function openPrivateRoomListSlotJoinPopup(privateRoomId: string, team: Team, slotIndex: 0 | 1): void {
    if (hasActiveOwnPrivateRoomMembership()) {
      openPrivateRoomConflictPrompt('list-join')
      return
    }
    state.privateRoomJoinSlotPopup = { privateRoomId, team, slotIndex }
    render()
  }

  // Споделено между списъка ("+" директно от картата) и waiting room екрана
  // (previewer "+") — reads вече отворения popup от state, изпраща реалния
  // join_private_room, и маркира privateRoomJoinInFlight, за да може
  // private_room_updated handler-ът (виж по-долу) да force-навигира към
  // 'private-room-waiting' след success, независимо дали confirm-ът е дошъл
  // от списъка (потребителят е на 'private-rooms') или от чакалнята
  // (вече е на 'private-room-waiting' — reassignment-ът е no-op там).
  function confirmPrivateRoomJoinSlotPopup(): void {
    const popup = state.privateRoomJoinSlotPopup
    if (popup === null) return
    state.privateRoomJoinSlotPopup = null
    state.privateRoomJoinInFlight = true
    options.onPrivateRoomJoinSlot?.(popup.privateRoomId, popup.team, popup.slotIndex)
    render()
  }

  function cancelPrivateRoomJoinSlotPopup(): void {
    state.privateRoomJoinSlotPopup = null
    render()
  }

  // "ВЛЕЗ" на собствената маса в списъка — чиста навигация към вече
  // съществуващата чакалня (reuse на returnToPrivateRoomWaiting()), никакъв
  // нов join_private_room, никаква промяна на team/slot/bot (task spec §7).
  function handlePrivateRoomListEnter(privateRoomId: string): void {
    if (state.myPrivateRoom?.id !== privateRoomId) return
    returnToPrivateRoomWaiting()
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
    // Image viewer-ът (ако е отворен) консумира popstate събитието първо —
    // виж коментара при openImageViewer/handleWindowPopstate по-горе.
    if (handleWindowPopstate()) return
    if (handleTopicThreadPopstate()) return
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
      state.lobbyChatFullscreen = false
      releaseLobbyChatBodyScrollLock()
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
        // Огледално за Topics composer (Етап 2 корекция т.4/т.7): ack за
        // pending send никога няма да пристигне по мъртва връзка — освобождаваме
        // pending state-а по всички теми, БЕЗ auto-resend и БЕЗ да чистим draft-а
        // (потребителят не губи текста; ако съобщението реално е било записано
        // server-side преди disconnect-а, catch-up/reconnect-refresh го открива
        // чрез messageId dedupe, не чрез този pending флаг).
        for (const topicId of Object.keys(state.topicComposerPendingRequestIdByTopicId)) {
          state.topicComposerPendingRequestIdByTopicId[topicId] = null
        }
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
    setPrivateRoomInGameNotificationsEnabled: (value) => {
      state.privateRoomInGameNotificationsEnabled = value
      if (state.notificationsOpen) {
        render()
      }
    },
    setPrivateRoomCreatedSoundEnabled: (value) => {
      state.privateRoomCreatedSoundEnabled = value
      if (state.notificationsOpen) {
        render()
      }
    },
    setFriendships: (value) => {
      state.friendships = value
      state.friendsErrorText = null
      render()
    },
    setChatConversations: (value) => {
      state.chatConversations = value
      state.chatErrorText = null
      reconcileActiveChatConversation()
      render()
    },
    refreshTopicsDirectoryMetadata,
    clearTopicsDirectoryMetadata,
    startMatchmaking,
    resetToLobby,
    openAuthModal,
    suspendLobbyChatForActiveRoom,
    forceLobbyChatResubscribeIfOnLobbyScreen,
    forceTopicMessagesResubscribeIfOnTopicsScreen,
    forceTopicsDirectoryResubscribeIfOnTopicsScreen,
    resyncPrivateRoomMembership,
    joinPrivateRoom: handlePrivateRoomJoin,
    updateLobbyChatDraft,
    submitLobbyChatMessage,
    refreshMissionsCount: () => { void loadPlayerUnclaimedCount() },
    refreshDailyRewardsStatus: () => { void loadDailyRewardsStatus() },
    invalidateOwnVipStatus: () => {
      // След успешна VIP покупка (Stripe webhook settlement потвърден) —
      // нулира memoization guard-а на ensureOwnVipStatusLoaded, за да
      // следващото отваряне на own profile popup-а refetch-не свеж
      // active_until, вместо да покаже stale стойност от преди покупката.
      state.ownVipActiveUntilLoadedForProfileId = null
      state.vipPackages = []
    },
    showVipPurchaseProcessingPopup: () => {
      // Извиква се ВЕДНАГА при landing на success redirect (payment=success&
      // session_id=...), преди exact session correlation-a да е резолвнат —
      // само loading UX, никога success/VIP grant claim. Same popup instance
      // ще transition-не към 'success' или 'delayed' фаза по-долу (никога
      // отделен втори popup stacked върху тоя).
      state.currentScreen = 'shop'
      state.shopActiveTab = 'vip'
      state.vipPurchaseSuccessPopup = { isOpen: true, phase: 'loading', days: 0, activeUntilLabel: null }
      render()
    },
    showVipPurchaseSuccessPopup: (days, activeUntilLabel) => {
      // Success redirect landing — Stripe webhook вече е settle-нал точно
      // тази checkout сесия преди тази функция да се извика (виж
      // waitForPaidVipPurchase в main.ts, exact providerCheckoutSessionId
      // match) — никакъв fake success не се показва само от URL параметъра.
      // days идва от реално закупения пакет (VipPurchaseSnapshot.days),
      // activeUntilLabel от обновения /api/vip/status отговор — нито едното
      // не е client-side изчислено.
      state.currentScreen = 'shop'
      state.shopActiveTab = 'vip'
      state.vipPurchaseSuccessPopup = { isOpen: true, phase: 'success', days, activeUntilLabel }
      render()
    },
    showVipPurchaseDelayedPopup: () => {
      // Polling timeout изтече без server-confirmed paid — webhook просто
      // може да закъснява (async забавяне, не failure). НЕ съобщение за
      // грешка — VIP ще се активира автоматично, когато webhook пристигне.
      state.currentScreen = 'shop'
      state.shopActiveTab = 'vip'
      state.vipPurchaseSuccessPopup = { isOpen: true, phase: 'delayed', days: 0, activeUntilLabel: null }
      render()
    },
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
      return isActivePersonalChatConversation(friendshipId)
    },
    openChatWithFriend: (friendshipId: string) => {
      // Единствен caller е "Виж" от глобалния chat notification popup
      // (main.ts) — popup-ът носи само friendshipId, без kind, защото
      // сървърът излъчва chat_message_received по един общ поток за
      // 'friend'/'vip_dm'/'pika_support' (един sendMessage endpoint, виж
      // server/src/index.ts handleChatRequest). Route-ваме по canonical
      // kind от вече заредения state.chatConversations (keyed по
      // friendshipId), НЕ по state.currentScreen — currentScreen е UI
      // context на VIEWER-a в момента на клика, няма отношение към това
      // към кой продукт принадлежи ТОЗИ конкретен разговор, и една и съща
      // двойка профили може да има едновременно 'friend' И 'vip_dm'
      // разговор с различна история (production regression fix).
      const routeByConversation = (conversation: ChatConversationSnapshot | undefined): void => {
        if (conversation?.kind === 'vip_dm') {
          void showTopicsPersonalChat(friendshipId)
          return
        }
        if (conversation?.kind === 'pika_support') {
          // Legacy Chat филтрира списъка си само до kind='friend'
          // (renderChatPanel) — pika_support разговор там би показал
          // грешна/празна активна беседа. Каноничното място е СЪЩОТО,
          // което бутонът "Поддръжка" отваря (admin inbox за пълен admin,
          // иначе support попъп-а за всеки друг, вкл. subadmin).
          openSupportInbox()
          return
        }
        if (conversation?.kind === 'friend') {
          // Race guard срещу друг по-нов chat-open flow, който сработва,
          // докато showChatPanel() зарежда (напр. PIKABG start), виж
          // activeChatRequestGeneration.
          const requestGeneration = state.activeChatRequestGeneration
          void showChatPanel(true).then(() => {
            if (state.activeChatRequestGeneration !== requestGeneration) return
            void openChatConversation(friendshipId)
            markChatConversationReadLocally(friendshipId)
            render()
            void options.onChatMarkRead?.(friendshipId)
          })
          return
        }

        // Непознат/липсващ разговор в кеша (напр. WS известието е
        // изпреварило първоначалното зареждане на chatConversations) —
        // НИКОГА не гадаем kind по подразбиране (точно грешно предположение
        // причини production регресията, която оправяме тук). Опресняваме
        // веднъж canonical списъка (същия pattern като
        // openTopicsPersonalMessageFromPost) и решаваме отново; ако
        // разговорът реално не съществува/не е достъпен, показваме честно
        // съобщение вместо да отворим произволен грешен продукт.
        void loadChatConversations().then(() => {
          const refreshed = state.chatConversations.find((c) => c.friendshipId === friendshipId)
          if (refreshed !== undefined) {
            routeByConversation(refreshed)
            return
          }
          state.errorText = 'Разговорът вече не е наличен.'
          render()
        })
      }

      routeByConversation(state.chatConversations.find((c) => c.friendshipId === friendshipId))
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
          const displayUnread = formatNotificationBadgeCount(totalUnread)

          // Production flicker fix — background support-unread poll (30s
          // interval, viж startSupportUnreadPolling в main.ts) не трябва да
          // предизвика unconditional пълен render(), особено докато mobile
          // menu е отворено (root.innerHTML remount унищожава/пресъздава
          // <details> subtree-a → visible flicker). Desktop badge
          // ([data-support-unread-badge]) съществува само в desktop
          // renderNav() template — mobile menu total badge
          // ([data-mobile-menu-total-badge]) е СЕПАРАТЕН persistent node
          // (виж renderMobileMenu), патч-нат отделно чрез refreshTopicsUnreadDom
          // (reuse на established Lafche-fix helper — тя вече агрегира
          // support+topics+friendChat+friends в getMobileMenuNotificationRaw).
          const desktopBadge = options.root.querySelector<HTMLElement>('[data-support-unread-badge="1"]')
          let desktopPatched = false
          if (desktopBadge) {
            desktopBadge.style.display = displayUnread !== null ? 'flex' : 'none'
            desktopBadge.textContent = displayUnread ?? ''
            desktopPatched = true
          }

          // ВАЖНО: НЕ разчитаме на aggregate return value-то на
          // refreshTopicsUnreadDom() тук — тя patch-ва и Topics-specific
          // badges (general/lafche), чиито success/failure е НЕСВЪРЗАН с
          // support unread targets. Ако utre Topics badge-ове structural
          // fail-нат (напр. потребителят не е на Topics screen — layout-aware
          // ok, но все пак различен branch), aggregate-ът не трябва да
          // потиска support-specific success detection. Проверяваме
          // mobile targets directно, СЛЕД като refreshTopicsUnreadDom вече
          // ги е patch-нала (side effect), вместо да gate-ваме на нейния
          // общ boolean.
          refreshTopicsUnreadDom(options.root, buildLobbyScreenState())
          const mobileTotalBadgeFound = options.root.querySelector('[data-mobile-menu-total-badge="1"]') !== null
          const mobileItemBadgeFound = options.root.querySelector('[data-mobile-menu-item-badge="support"]') !== null
          const mobilePatched = mobileTotalBadgeFound && mobileItemBadgeFound

          // Layout-aware success (брифа §4): desktop badge липсва на mobile
          // viewport по design (renderNav е desktop-only template) — това
          // НЕ е failure. Fallback render() само ако буквално НИТО ЕДИН
          // target (desktop ИЛИ mobile) не е бил намерен — истинска
          // structural inconsistency (напр. lobby DOM изобщо не е mounted).
          if (!desktopPatched && !mobilePatched) {
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
    navigateToPrivateRooms,
    navigateToTournamentDetail: (tournamentId: string) => {
      showTournamentDetail(tournamentId)
    },
    navigateToTopics: () => {
      void showTopicsDirectory()
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
