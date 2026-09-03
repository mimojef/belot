import './style.css'

import {
  initPwa,
  isRunningAsStandalone,
  canInstallPwa,
  triggerPwaInstall,
  requestPwaUpdateCheck,
  CURRENT_BUILD_ID,
} from './pwa'
import {
  setPendingPwaUpdate,
  tryApplyPendingPwaUpdate,
  type PwaUpdateSafetyState,
} from './pwaUpdateCoordinator'
import {
  markPendingChatRefresh,
  clearPendingChatRefresh,
  attemptPendingChatRefresh as attemptPendingChatRefreshTracker,
} from './pendingChatRefreshTracker'
import { createActiveRoomFlowController } from './app/activeRoom/createActiveRoomFlowController'
import {
  isMatchEndedPreviewRequest,
  renderMatchEndedPreview,
} from './app/activeRoom/previewMatchEndedScreen'
import { createGameAudioController } from './app/audio/createGameAudioController'
import {
  createLobbyFlowController,
  GUEST_TRIAL_STAKE,
  type LobbyFlowController,
} from './app/lobby/createLobbyFlowController'
import { validateProfileDisplayName } from './app/lobby/profileDisplayNameValidation'
import { readProfileImageFileAsDataUrl } from './app/profileImages/profileImageUploadHelpers'
import type { GiftLimitErrorPayload } from './app/lobby/formatGiftLimitError'
import type { AvatarCropSelection, GuestContactFormInput } from './app/lobby/renderLobbyScreen'
import { formatTopicsSectionMuteErrorText } from './app/lobby/renderTopicsScreen'
import type { PlayerAccountRole, ActiveProfileBanSnapshot } from './ui/overlays/renderPlayerProfilePopup'
import type { MonitoringSnapshot, MonitoringHistoryResult, HistoryWindow, WsConnectionsResult, CpuIncidentSummary, CpuIncidentDetail } from './app/adminServer/adminServerTypes'
import { isValidHistoryWindow } from './app/adminServer/adminServerTypes'
import type { AdminTournamentDetailRow, AdminTournamentFilters, AdminTournamentSummaryRow } from './app/adminTournaments/adminTournamentTypes'
import {
  createGameServerClient,
  type ConnectedMessage,
  type AdminSettingsSnapshot,
  type AdminStatsSnapshot,
  type DailyRewardTierSnapshot,
  type ChatConversationSnapshot,
  type ChatMessageSnapshot,
  type CoinCheckoutResponse,
  type CoinResumeCheckoutResponse,
  type CoinHidePurchaseResponse,
  type CoinPackageInput,
  type CoinPackageSnapshot,
  type VipPackageSnapshot,
  type VipPurchaseSnapshot,
  type CoinPackageStatus,
  type CoinPurchaseSnapshot,
  type FriendshipsSnapshot,
  type GameServerClient,
  type LeaderboardsSnapshot,
  type MissionTemplateInput,
  type MissionTemplateSnapshot,
  type MatchRoomSnapshot,
  type PlayerMissionProgressSnapshot,
  type PlayerPublicProfileSnapshot,
  type GuestContactMessageListItem,
  type SupportMessageSnapshot,
  type SupportConversationSnapshot,
  type AdminVisitorListResult,
  type AdminVisitorSourcesResult,
  type VisitorListPeriod,
  type VisitorListType,
  type VisitorDeviceFilter,
  type VisitorOsFilter,
  type TournamentSummarySnapshot,
  type TournamentDetailSnapshot,
  type TournamentCreateInput,
  type TopicSnapshot,
  type TopicMessageSnapshot,
  type TopicReplySnapshot,
  type TournamentPartnerCandidateSnapshot,
  type TournamentPartnerInviteSnapshot,
  type TournamentMatchAssignmentSnapshot,
  type AdminRegisteredProfileRow,
  type AdminProfileLinkedProfileRow,
  type AdCampaignManagementDto,
} from './app/network/createGameServerClient'
import { createViewportResizeHandler, isPhoneLayoutViewport } from './ui/layout/viewportStage'
import { createProfileLikeNotification } from './ui/notifications/profileLikeNotification'
import { createFriendRequestNotification } from './ui/notifications/friendRequestNotification'
import { createPartnerRatingNotification } from './ui/notifications/partnerRatingNotification'
import { createChatMessageNotification } from './ui/notifications/chatMessageNotification'
import { createPrivateRoomCreatedNotification } from './ui/notifications/privateRoomCreatedNotification'
import { createTournamentEconomyNotification } from './ui/notifications/tournamentEconomyNotification'
import type { TournamentEconomyNoticeReason } from './ui/notifications/tournamentEconomyNotificationQueue'
import { createTournamentPartnerInvitePopup } from './ui/notifications/tournamentPartnerInvitePopup'
import { createTournamentMatchStartPopup } from './ui/notifications/tournamentMatchStartPopup'
import { createTournamentReclaimModal } from './ui/notifications/tournamentReclaimModal'
import { isTournamentForceReturnRequired, resolveTournamentReturnDestination } from './app/lobby/resolveTournamentReturnDestination'
import { createTournamentFeederWaitingStrip, type TournamentFeederWaitingState } from './ui/notifications/tournamentFeederWaitingStrip'
import { createVisitorPageViewTracker } from './app/visitors/createVisitorPageViewTracker'
import { mountConsentUi } from './app/consent/consentUi'
import { initializeAnalytics } from './app/analytics/initializeAnalytics'
import { trackCompleteRegistration } from './app/analytics/metaPixel'
import {
  extractAndClearResetToken,
  renderResetPasswordScreen,
  type ResetPasswordScreenState,
} from './app/passwordReset/renderResetPasswordScreen'

const rootElementCandidate = document.querySelector<HTMLDivElement>('#app')

if (!rootElementCandidate) {
  throw new Error('Root element #app was not found.')
}

const rootElement: HTMLDivElement = rootElementCandidate

// Определя се веднага — преди lobby/client bootstrap — за да guard-ва всички async callbacks.
const _isResetPasswordPath = window.location.pathname === '/reset-password'

// Extract-нато (не само inline в onMessage) конкретно за да е тествано
// изолирано — виж checkInitialNavUrlSync.ts. lobby.handleServerMessage(message)
// е ЕДИНСТВЕНОТО място, което reset-ва вътрешния _pendingInitialNav флаг и
// извиква navigateFromPath(_loadPath) (createLobbyFlowController.ts) — ако
// navigateInitialPath() е стартирал преди state.isConnected===true (нормален
// race при WS handshake на fresh load), _pendingInitialNav остава true, и
// syncUrlPath() (URL sync при всяка нормална navigation, викана накрая на
// всеки render()) вечно early-return-ва, докато флагът не бъде reset-нат тук.
// Без forward-а: DOM се сменя коректно при клик по nav бутоните (render()
// работи независимо), но window.location.pathname никога не се обновява —
// URL остава "залепен" за route-а от последния page load/refresh, докато
// refresh накрая не прочете stale-ия pathname (production regression,
// потвърден чрез live browser инструментация — виж bug report).
export function handleConnectedServerMessage(
  lobby: LobbyFlowController,
  message: ConnectedMessage,
  onServerStateResolved: () => void,
): void {
  lobby.handleServerMessage(message)
  // Сървърът праща 'connected' синхронно ПЪРВО в connection handler-а си, а
  // евентуално 'session_in_game' (ако профилът има активна игра) веднага
  // след него в СЪЩИЯ handler — двете пристигат в тази подредба през WS
  // message опашката. Изчакваме един tick, за да може 'session_in_game' (ако
  // предстои) да бъде обработено първо, преди да маркираме bootstrap-а за
  // завършен — сурово onOpen не е достатъчен сигнал, защото не гарантира, че
  // сървърът вече е казал дали има resume-able сесия.
  window.setTimeout(onServerStateResolved, 0)
}

if (isMatchEndedPreviewRequest()) {
  const renderPreview = (): void => {
    renderMatchEndedPreview(rootElement)
  }

  const disposeViewportResizeHandler = createViewportResizeHandler(renderPreview)

  window.addEventListener('beforeunload', () => {
    disposeViewportResizeHandler()
  })

  renderPreview()
} else {
let client: GameServerClient
let lobby: LobbyFlowController
const gameAudio = createGameAudioController()

const PRIVATE_ROOM_IN_GAME_NOTIFICATIONS_KEY = 'pika.privateRoomInGameNotificationsEnabled'

function loadPrivateRoomInGameNotificationsEnabled(): boolean {
  try {
    return localStorage.getItem(PRIVATE_ROOM_IN_GAME_NOTIFICATIONS_KEY) !== 'false'
  } catch {
    return true
  }
}

let privateRoomInGameNotificationsEnabled = loadPrivateRoomInGameNotificationsEnabled()

function setPrivateRoomInGameNotificationsEnabled(enabled: boolean): void {
  privateRoomInGameNotificationsEnabled = enabled
  try {
    localStorage.setItem(PRIVATE_ROOM_IN_GAME_NOTIFICATIONS_KEY, enabled ? 'true' : 'false')
  } catch {
    // Ignore storage failures; the in-memory setting still applies for this tab.
  }
  lobby?.setPrivateRoomInGameNotificationsEnabled(enabled)
  privateRoomCreatedNotification?.syncPreferences()
}

const PRIVATE_ROOM_CREATED_SOUND_KEY = 'pika.privateRoomCreatedSoundEnabled'

function loadPrivateRoomCreatedSoundEnabled(): boolean {
  try {
    return localStorage.getItem(PRIVATE_ROOM_CREATED_SOUND_KEY) !== 'false'
  } catch {
    return true
  }
}

let privateRoomCreatedSoundEnabled = loadPrivateRoomCreatedSoundEnabled()

function setPrivateRoomCreatedSoundEnabled(enabled: boolean): void {
  privateRoomCreatedSoundEnabled = enabled
  try {
    localStorage.setItem(PRIVATE_ROOM_CREATED_SOUND_KEY, enabled ? 'true' : 'false')
  } catch {
    // Ignore storage failures; the in-memory setting still applies for this tab.
  }
  lobby?.setPrivateRoomCreatedSoundEnabled(enabled)
}

const likeNotifContainer = document.createElement('div')
likeNotifContainer.id = 'global-like-notifications'
document.body.appendChild(likeNotifContainer)

const likeNotification = createProfileLikeNotification({
  container: likeNotifContainer,
  onLike: async (profileId) => {
    await submitProfileLike(profileId)
  },
})

const friendReqNotifContainer = document.createElement('div')
friendReqNotifContainer.id = 'global-friend-request-notifications'
document.body.appendChild(friendReqNotifContainer)

const friendRequestNotification = createFriendRequestNotification({
  container: friendReqNotifContainer,
  onAccept: async (friendshipId) => {
    const result = await submitFriendAction(friendshipId, 'accept')
    if (!result.ok) return result
    lobby?.setFriendships(result.friendships)
    lobby?.removePendingFriendRequest(friendshipId)
    return result
  },
  onReject: async (friendshipId) => {
    const result = await submitFriendAction(friendshipId, 'reject')
    if (!result.ok) return result
    lobby?.setFriendships(result.friendships)
    lobby?.removePendingFriendRequest(friendshipId)
    return result
  },
})

const partnerRatingNotifContainer = document.createElement('div')
partnerRatingNotifContainer.id = 'global-partner-rating-notifications'
document.body.appendChild(partnerRatingNotifContainer)

const partnerRatingNotification = createPartnerRatingNotification({
  container: partnerRatingNotifContainer,
})

const chatMessageNotifContainer = document.createElement('div')
chatMessageNotifContainer.id = 'global-chat-message-notifications'
document.body.appendChild(chatMessageNotifContainer)

const chatMessageNotification = createChatMessageNotification({
  container: chatMessageNotifContainer,
  isInGame: () => activeRoom.hasActiveRoom(),
  onView: (friendshipId) => {
    lobby?.openChatWithFriend(friendshipId)
  },
})

const privateRoomCreatedNotifContainer = document.createElement('div')
privateRoomCreatedNotifContainer.id = 'global-private-room-created-notifications'
document.body.appendChild(privateRoomCreatedNotifContainer)

const privateRoomCreatedNotification = createPrivateRoomCreatedNotification({
  container: privateRoomCreatedNotifContainer,
  isInActiveGame: () => activeRoom.hasActiveRoom(),
  areInGameNotificationsEnabled: () => privateRoomInGameNotificationsEnabled,
  isSoundEnabled: () => privateRoomCreatedSoundEnabled,
  onDisableInGameNotifications: () => {
    setPrivateRoomInGameNotificationsEnabled(false)
  },
  onEnterPrivateRooms: () => {
    lobby?.navigateToPrivateRooms()
  },
})

window.addEventListener('storage', (event) => {
  if (event.key === PRIVATE_ROOM_IN_GAME_NOTIFICATIONS_KEY) {
    const enabled = event.newValue !== 'false'
    privateRoomInGameNotificationsEnabled = enabled
    lobby?.setPrivateRoomInGameNotificationsEnabled(enabled)
    privateRoomCreatedNotification.syncPreferences()
    return
  }
  if (event.key === PRIVATE_ROOM_CREATED_SOUND_KEY) {
    const enabled = event.newValue !== 'false'
    privateRoomCreatedSoundEnabled = enabled
    lobby?.setPrivateRoomCreatedSoundEnabled(enabled)
  }
})

const tournamentEconomyNotifContainer = document.createElement('div')
tournamentEconomyNotifContainer.id = 'global-tournament-economy-notifications'
document.body.appendChild(tournamentEconomyNotifContainer)

const tournamentEconomyNotification = createTournamentEconomyNotification({
  container: tournamentEconomyNotifContainer,
})

const tournamentPartnerInviteNotifContainer = document.createElement('div')
tournamentPartnerInviteNotifContainer.id = 'global-tournament-partner-invite-notifications'
document.body.appendChild(tournamentPartnerInviteNotifContainer)

const tournamentPartnerInvitePopup = createTournamentPartnerInvitePopup({
  container: tournamentPartnerInviteNotifContainer,
  onDismiss: (inviteId) => dismissTournamentPartnerInvitePopupRequest(inviteId),
  onView: async (inviteId) => {
    const result = await viewTournamentPartnerInviteNotificationRequest(inviteId)
    if (result.ok) {
      lobby?.navigateToTournamentDetail(result.tournamentId)
      void lobby?.refreshPendingTournamentPartnerInvites()
    }
    return result
  },
  onExpiredRefresh: async (inviteId) => {
    const result = await loadPendingTournamentPartnerInvites()
    if (result.ok) {
      void lobby?.refreshPendingTournamentPartnerInvites()
      return result.invites.some((invite) => invite.inviteId === inviteId && invite.popupDismissedAt === null)
    }
    return true
  },
})

const SERVER_RESTART_WAIT_MESSAGE = 'Изчаква се рестарт на сървъра.'
const SERVER_RESUME_WAIT_MESSAGE = 'Възстановяване на играта...'
const SERVER_CONNECTION_ERROR_MESSAGE = 'Възникна грешка при връзката със сървъра.'
const SERVER_RECONNECT_DELAY_MS = 1_000
const SERVER_RECONNECT_MAX_DELAY_MS = 5_000
const MAX_PROFILE_GALLERY_IMAGES = 6

let reconnectTimerId: number | null = null
let connectionErrorTimerId: number | null = null
let reconnectAttempt = 0
let pendingTournamentEntryAfterLeave: TournamentMatchAssignmentSnapshot | null = null
// STATE B silent attach idempotency guard (§ "SILENT ATTACH") — resume_room
// itself is idempotent server-side, but this avoids re-sending it (and
// re-arming activeRoom's watch) on every fetchTournamentDetail refresh while
// the same round-transition room is already attached.
let silentAttachedRoundTransitionRoomId: string | null = null
let isPageUnloading = false
let isRefreshingAuthConnection = false
let isSessionDisplaced = false
/**
 * True докато showModerationForcedExitPopup (BAN/DELETE forced-exit, round 4
 * §8) стои на екрана — сетва се веднага при session_banned/session_deleted,
 * нулира се ЕДИНСТВЕНО вътре в onForcedLogout callback-а (OK или 20-сек
 * countdown expiry), огледално на isSessionDisplaced/isPageUnloading guard-а
 * на onClose по-долу. Без този флаг: сървърът затваря socket-а веднага след
 * session_banned/session_deleted, onClose() задейства нормалния reconnect
 * flow, клиентът се reconnect-ва след няколко секунди, onOpen() вижда
 * shouldReloadLobbyOnReconnect===true и вика forceOfflineLobbyReload() ->
 * window.location.replace(...) — пълна page navigation, която маха popup-а
 * (и неговия interval) много преди 20-те секунди да изтекат. НЕ добавя нов
 * timer/forced-logout път — само пропуска reload/reconnect side effects-ите
 * в onClose, докато popup-ът реално стои.
 */
let isModerationForcedExitPending = false
let shouldReloadLobbyOnReconnect = false
let offlineLobbyReloadScheduled = false
let pwaBootstrapAuthSessionLoaded = false
let pwaBootstrapGuestStatusLoaded = false
let pwaBootstrapServerStateResolved = false
let pwaIsReconnectingActiveRoom = false
// Scoped за forceReconnectForZombieConnection (bid-response watchdog
// fallback, createActiveRoomFlowController.ts) — единственият тригер, който
// го сеща на true. Без него, onOpen()'s shouldReloadLobbyOnReconnect клон
// (сетнат безусловно от showOfflineConnectionOverlay() на всеки onClose,
// виж initOfflineOverlay по-долу) би пренасочил играча към
// forceOfflineLobbyReload() -> /lobby при ВСЯКО reconnect, включително
// точно този explicit "bid response изгубен, socket е zombie" случай —
// вместо тих resume_room round-trip в СЪЩАТА активна стая. НЕ променя
// поведението за нормален connection loss (реален close извън тази
// callback) — shouldReloadLobbyOnReconnect/forceOfflineLobbyReload остават
// непокътнати за lobby и всеки друг reconnect сценарий.
let isZombieBidReconnectInFlight = false
let showOfflineConnectionOverlay: () => void = () => {
  shouldReloadLobbyOnReconnect = true
}
let currentAuthSession: AuthSession | null = null

const SESSION_CACHE_KEY = 'pika_session_cache'

function forceOfflineLobbyReload(): void {
  if (offlineLobbyReloadScheduled || isPageUnloading) return
  offlineLobbyReloadScheduled = true

  const navigateToFreshLobby = (): void => {
    window.setTimeout(() => {
      window.location.replace(`/lobby?offlineReload=${Date.now()}`)
    }, 300)
  }

  if ('caches' in window) {
    caches.delete('navigation-cache').finally(navigateToFreshLobby)
  } else {
    navigateToFreshLobby()
  }
}

function saveSessionCache(session: AuthSession): void {
  try {
    localStorage.setItem(SESSION_CACHE_KEY, JSON.stringify(session))
  } catch { /* ignore */ }
}

function loadSessionCache(): AuthSession | null {
  try {
    const raw = localStorage.getItem(SESSION_CACHE_KEY)
    return raw ? (JSON.parse(raw) as AuthSession) : null
  } catch {
    return null
  }
}

function clearSessionCache(): void {
  try { localStorage.removeItem(SESSION_CACHE_KEY) } catch { /* ignore */ }
}
let supportUnreadIntervalId: ReturnType<typeof setInterval> | null = null
let publicSignupBonusYellowCoins = 100000
let publicProfileNameChangePrice = 50000
let publicOnlinePlayersCount = 0

type AuthSession = {
  sessionId: string
  account: {
    accountId: string
    email: string
    role: string
    status: string
  }
  profile: PlayerPublicProfileSnapshot
  /** Derived UI-only сигнал от сървъра — non-null само за pika_team gift bypass profile-а (server: withPikaTeamGiftBypassFlag). Authoritative проверката остава сървърна (yellowCoinGiftStore.sendGift); това поле само казва на gift modal-а какъв max/text да покаже. */
  pikaTeamGiftMaxAmount?: number | null
  /** Informational UI сигнал — non-null само за role==='pika_team' (server: withPikaTeamGiftBypassFlag). Authoritative проверката остава сървърна (yellowCoinGiftStore.sendGiftCore §4.5). */
  pikaTeamDailyGiftLimitStatus?: { limit: number; used: number; remaining: number } | null
}

type AuthResponse = {
  ok: boolean
  session?: AuthSession | null
  message?: string
  code?: string
  bannedUntil?: string
  reason?: string
  remainingDays?: number
}

type AdminProfileResponse = {
  ok: boolean
  profile?: PlayerPublicProfileSnapshot
  message?: string
  code?: string
}

type PlayersResponse = {
  ok: boolean
  players?: PlayerPublicProfileSnapshot[]
  message?: string
  page?: number
  pageSize?: number
  totalCount?: number
  totalPages?: number
  snapshot?: string
  snapshotReset?: boolean
}

type LeaderboardsResponse = {
  ok: boolean
  leaderboards?: LeaderboardsSnapshot
  message?: string
}

type PublicSettingsResponse = {
  ok: boolean
  onlinePlayersCount?: number
  settings?: {
    signupBonusYellowCoins?: number
    profileNameChangePrice?: number
  }
  message?: string
}

type AdminSettingsResponse = {
  ok: boolean
  settings?: AdminSettingsSnapshot
  message?: string
}

type CoinPackagesResponse = {
  ok: boolean
  packages?: CoinPackageSnapshot[]
  package?: CoinPackageSnapshot
  message?: string
}

type VipPackagesResponse = {
  ok: boolean
  packages?: VipPackageSnapshot[]
  message?: string
}

type VipCheckoutResponse = {
  ok: boolean
  checkoutUrl?: string
  checkoutSessionId?: string
  message?: string
}

type VipPurchasesResponse = {
  ok: boolean
  purchases?: VipPurchaseSnapshot[]
  message?: string
}

type CoinPurchasesResponse = {
  ok: boolean
  purchases?: CoinPurchaseSnapshot[]
  purchase?: CoinPurchaseSnapshot
  message?: string
}

type FriendshipsResponse = {
  ok: boolean
  friendships?: FriendshipsSnapshot
  message?: string
}

type ChatConversationsResponse = {
  ok: boolean
  conversations?: ChatConversationSnapshot[]
  message?: string
}

type ChatMessagesResponse = {
  ok: boolean
  messages?: ChatMessageSnapshot[]
  conversation?: ChatConversationSnapshot
  newMessage?: ChatMessageSnapshot
  message?: string
  code?: 'blocked' | 'vip_required' | 'vip_counterpart_required' | 'self' | 'recipient_not_found' | 'conversation_not_found' | 'invalid_conversation_kind' | 'message_required' | 'topic_muted'
  /** Само при code==='topic_muted' — GLOBAL TOPICS MUTE брифа §1.D/E (vip_dm е част от "Теми" enforcement scope-а). */
  mutedUntil?: string
  reason?: string
}

function formatPersonalChatError(data: { code?: ChatMessagesResponse['code']; message?: string; mutedUntil?: string; reason?: string }): string {
  switch (data.code) {
    case 'blocked':
      return 'Не можете да изпращате съобщения в този разговор.'
    case 'vip_required':
      return 'Личните съобщения към потребители извън приятелите са достъпни само за VIP.'
    case 'vip_counterpart_required':
      return 'Този потребител в момента не е активен VIP.'
    case 'self':
      return 'Не можете да изпратите лично съобщение до себе си.'
    case 'recipient_not_found':
      return 'Потребителят не беше намерен.'
    case 'conversation_not_found':
      return 'Разговорът не беше намерен.'
    case 'invalid_conversation_kind':
      return 'Този разговор не е достъпен тук.'
    case 'message_required':
      return 'Изпрати съобщение, за да започнеш този разговор.'
    case 'topic_muted':
      // GLOBAL TOPICS MUTE брифа §10 — exact сървърен mutedUntil/reason,
      // Теми → Лични (vip_dm) е част от Topics-section enforcement scope-а.
      // Reuse на единствения formatter (FINAL PRE-COMMIT CHECK §1/§2) —
      // никакво локално дублиране на текста/expiry форматирането тук.
      return formatTopicsSectionMuteErrorText(data.mutedUntil, data.reason)
    default:
      return data.message ?? 'Съобщението не беше изпратено.'
  }
}

type GiftCoinsResponse = {
  ok: boolean
  senderProfile?: PlayerPublicProfileSnapshot
  recipientProfile?: PlayerPublicProfileSnapshot
  message?: string
  code?: 'RECIPIENT_WINDOW_LIMIT_PARTIAL' | 'RECIPIENT_WINDOW_LIMIT_FULL' | 'PIKA_TEAM_DAILY_GIFT_LIMIT_EXCEEDED'
  receivedInWindow?: number
  remainingAllowance?: number
  attemptedAmount?: number
  nextReleaseAt?: string | null
  nextReleaseAmount?: number
  limit?: number
  used?: number
  remaining?: number
  // Informational UI refresh след успешен pika_team gift (виж
  // notifyGiftRecipientAndRespond в index.ts) — undefined за нормални
  // sender-и, не се показва нищо в UI.
  pikaTeamDailyGiftLimitStatus?: { limit: number; used: number; remaining: number }
}

type DailyMissionsApiResponse = {
  ok: boolean
  missions?: PlayerMissionProgressSnapshot[]
  unclaimedCount?: number
  date?: string
  rewardYellowCoins?: number
  message?: string
}

type AdminMissionsApiResponse = {
  ok: boolean
  activeMissions?: MissionTemplateSnapshot[]
  stagedMissions?: MissionTemplateSnapshot[]
  mission?: MissionTemplateSnapshot
  message?: string
}

function getApiBaseUrl(): string {
  const hostname = window.location.hostname
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:'
    return `${protocol}//${hostname}:3001`
  }
  return ''
}

async function readAuthResponse(response: Response): Promise<AuthResponse> {
  try {
    return (await response.json()) as AuthResponse
  } catch {
    return {
      ok: false,
      message: 'Невалиден отговор от сървъра.',
    }
  }
}

function startSupportUnreadPolling(): void {
  if (supportUnreadIntervalId !== null) return
  supportUnreadIntervalId = setInterval(() => {
    if (currentAuthSession !== null && !activeRoom.hasActiveRoom()) {
      lobby.refreshSupportUnread()
    }
  }, 30_000)
}

function stopSupportUnreadPolling(): void {
  if (supportUnreadIntervalId === null) return
  clearInterval(supportUnreadIntervalId)
  supportUnreadIntervalId = null
}

function syncLobbyWithAuthSession(): void {
  if (currentAuthSession === null) {
    lobby.setFriendships(null)
    lobby.setChatConversations([])
    lobby.clearTopicsDirectoryMetadata()
    return
  }

  saveSessionCache(currentAuthSession)
  lobby.setDisplayName(currentAuthSession.profile.displayName)
  lobby.setLocalAvatarUrl(currentAuthSession.profile.avatarUrl)
}

async function syncLobbyFriendships(): Promise<void> {
  if (currentAuthSession === null) {
    lobby.setFriendships(null)
    return
  }

  const result = await loadFriendships()

  if (result.ok) {
    lobby.setFriendships(result.friendships)
  }
}

// Единствената точка, която реално дърпа /api/chat/conversations и прилага
// резултата в lobby state-а. Изчиства pendingChatRefreshAfterGame при успех,
// независимо кой я е извикал — loadAuthSession() я вика безусловно при всяко
// връщане в лоби; attemptPendingChatRefresh() я вика условно, само докато
// маркерът е активен. Ако едната вече е синхронизирала успешно, другата няма
// какво да върши (маркерът вече е false) — така се избягва дублирана заявка.
async function syncLobbyChatConversations(): Promise<boolean> {
  if (currentAuthSession === null) {
    lobby.setChatConversations([])
    return true
  }

  const result = await loadChatConversations()

  if (result.ok) {
    lobby.setChatConversations(result.conversations)
    clearPendingChatRefresh()
    return true
  }

  return false
}

async function syncLobbyTopicsDirectoryMetadata(): Promise<boolean> {
  if (currentAuthSession === null) {
    lobby.clearTopicsDirectoryMetadata()
    return true
  }

  return lobby.refreshTopicsDirectoryMetadata()
}

// Извиква се на всеки сигурен lifecycle момент (връщане в лоби, PWA resume),
// докато pendingChatRefreshTracker веднъж успее. canAttemptNow е локалната ни
// преценка (не сме в игра, имаме сесия) — самата успешност на заявката пак
// зависи от сървъра (виж коментара в pendingChatRefreshTracker.ts).
async function attemptPendingChatRefresh(): Promise<void> {
  const canAttemptNow = !activeRoom.hasActiveRoom() && currentAuthSession !== null
  await attemptPendingChatRefreshTracker(canAttemptNow, syncLobbyChatConversations)
}

function refreshGameServerConnectionForAuth(): void {
  isRefreshingAuthConnection = true
  clearReconnectTimer()
  client.disconnect()
  lobby.setConnected(false)

  window.setTimeout(() => {
    if (!isRefreshingAuthConnection) {
      return
    }

    isRefreshingAuthConnection = false
    client.connect()
  }, 80)
}

async function loadAuthSession(): Promise<void> {
  const cached = loadSessionCache()
  if (cached !== null) {
    currentAuthSession = cached
    syncLobbyWithAuthSession()
    void syncLobbyTopicsDirectoryMetadata()
    lobby.refreshDailyRewardsStatus()
    if (!activeRoom.hasActiveRoom() && !_isResetPasswordPath) {
      lobby.render()
    }
  }

  try {
    const response = await fetch(`${getApiBaseUrl()}/api/auth/me`, {
      method: 'GET',
      credentials: 'include',
    })
    const data = await readAuthResponse(response)
    currentAuthSession = data.ok ? data.session ?? null : null
    if (currentAuthSession !== null) {
      saveSessionCache(currentAuthSession)
    } else {
      clearSessionCache()
    }
    syncLobbyWithAuthSession()
    if (currentAuthSession !== null) {
      lobby.refreshMissionsCount()
      lobby.refreshDailyRewardsStatus()
      lobby.refreshSupportUnread()
      startSupportUnreadPolling()
    } else {
      lobby.refreshDailyRewardsStatus()
      stopSupportUnreadPolling()
      stopMonitoringPolling()
      stopAdminInfoAccessPolling()
    }
    await syncLobbyFriendships()
    await syncLobbyChatConversations()
    await syncLobbyTopicsDirectoryMetadata()
    if (!activeRoom.hasActiveRoom() && !_isResetPasswordPath) {
      lobby.render()
    }
  } catch {
    if (currentAuthSession === null) currentAuthSession = null
  }
}

async function submitAuthRequest(
  endpoint: 'login' | 'register',
  body: Record<string, string>,
): Promise<{ errorText: string | null; bannedInfo?: { bannedUntil: string; reason: string; remainingDays: number } | null }> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/auth/${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'include',
      body: JSON.stringify(body),
    })
    const data = await readAuthResponse(response)

    if (!response.ok || !data.ok || !data.session) {
      // Структуриран PROFILE_BANNED отговор (spec §5A) — само login endpoint-ът
      // може реално да го върне (authStore.login ban gate), но проверката е
      // тук (не в отделна login-only функция), за да няма дублиран fetch/
      // error-handling код между login и register.
      if (data.code === 'PROFILE_BANNED' && data.bannedUntil && data.reason && typeof data.remainingDays === 'number') {
        return {
          errorText: data.message ?? 'Профилът е баннат.',
          bannedInfo: { bannedUntil: data.bannedUntil, reason: data.reason, remainingDays: data.remainingDays },
        }
      }
      return { errorText: data.message ?? 'Заявката не беше успешна.' }
    }

    currentAuthSession = data.session
    saveSessionCache(currentAuthSession)
    // Маркерът е module-level state, не е обвързан с конкретен профил —
    // нова сесия (login/register) не трябва да наследи "pending" от преди
    // (напр. предишен профил в същия таб/PWA runtime, или guest сесия).
    clearPendingChatRefresh()
    syncLobbyWithAuthSession()
    lobby.clearTopicsDirectoryMetadata()
    lobby.resetToLobby()
    lobby.refreshDailyRewardsStatus()
    lobby.refreshSupportUnread()
    startSupportUnreadPolling()
    await syncLobbyFriendships()
    await syncLobbyChatConversations()
    await syncLobbyTopicsDirectoryMetadata()
    refreshGameServerConnectionForAuth()
    // Meta CompleteRegistration — само за успешен register, никога login.
    // eventId е стабилен спрямо accountId (веднъж заделен от сървъра при
    // успешен INSERT), не случаен UUID — идемпотентен дори при бъдещо CAPI.
    if (endpoint === 'register') {
      trackCompleteRegistration(`complete-registration-${currentAuthSession.account.accountId}`)
    }
    return { errorText: null }
  } catch {
    return { errorText: 'Няма връзка със сървъра за профили.' }
  }
}

async function submitLogout(): Promise<void> {
  try {
    await fetch(`${getApiBaseUrl()}/api/auth/logout`, {
      method: 'POST',
      credentials: 'include',
    })
  } catch {
    // ignore network errors — proceed with local logout
  }
  currentAuthSession = null
  clearSessionCache()
  clearPendingChatRefresh()
  stopSupportUnreadPolling()
  stopMonitoringPolling()
  stopAdminInfoAccessPolling()
  syncLobbyWithAuthSession()
  lobby.resetToLobby()
  lobby.refreshDailyRewardsStatus()
}

/**
 * Локален logout БЕЗ /api/auth/logout round-trip (spec §5B) — сървърът вече
 * знае за bana/delete-а (той самият е причината socket-ът да получи
 * 'session_banned'/'session_deleted'), затова допълнителна logout заявка би
 * била просто излишен network round-trip. Reuse-ва СЪЩОТО local cleanup като
 * submitLogout, само без fetch-а.
 */
function performLocalLogoutAfterBanOrDelete(): void {
  currentAuthSession = null
  clearSessionCache()
  clearPendingChatRefresh()
  stopSupportUnreadPolling()
  stopMonitoringPolling()
  stopAdminInfoAccessPolling()
  syncLobbyWithAuthSession()
  lobby.resetToLobby()
  lobby.refreshDailyRewardsStatus()
}

async function loadPlayersDirectory(
  page: number,
  snapshotToken: string | null,
): Promise<
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
> {
  try {
    const params = new URLSearchParams({ page: String(page) })
    if (snapshotToken) params.set('snapshot', snapshotToken)

    const response = await fetch(`${getApiBaseUrl()}/api/players?${params.toString()}`, {
      method: 'GET',
      credentials: 'include',
    })
    const data = (await response.json()) as PlayersResponse

    if (
      !response.ok ||
      !data.ok ||
      !Array.isArray(data.players) ||
      typeof data.page !== 'number' ||
      typeof data.pageSize !== 'number' ||
      typeof data.totalCount !== 'number' ||
      typeof data.totalPages !== 'number' ||
      typeof data.snapshot !== 'string'
    ) {
      return {
        ok: false,
        message: data.message ?? 'Списъкът с играчи не беше зареден.',
      }
    }

    return {
      ok: true,
      players: data.players,
      page: data.page,
      pageSize: data.pageSize,
      totalCount: data.totalCount,
      totalPages: data.totalPages,
      snapshot: data.snapshot,
      snapshotReset: data.snapshotReset === true,
    }
  } catch {
    return {
      ok: false,
      message: 'Няма връзка със сървъра за играчи.',
    }
  }
}

async function searchPlayersDirectory(
  query: string,
  signal: AbortSignal,
): Promise<
  | { ok: true; players: PlayerPublicProfileSnapshot[] }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(
      `${getApiBaseUrl()}/api/players/search?q=${encodeURIComponent(query)}`,
      {
        method: 'GET',
        credentials: 'include',
        signal,
      },
    )
    const data = (await response.json()) as PlayersResponse

    if (!response.ok || !data.ok || !Array.isArray(data.players)) {
      return { ok: false, message: data.message ?? 'Търсенето не беше успешно.' }
    }

    return { ok: true, players: data.players }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error
    }
    return { ok: false, message: 'Няма връзка със сървъра за играчи.' }
  }
}

async function loadGuestTrialStatus(): Promise<
  | { ok: true; gamesUsed: number; remaining: number; maxGames: number; stake: number }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/guest/trial-status`, {
      method: 'GET',
      credentials: 'include',
    })
    const data = (await response.json()) as {
      ok: boolean
      gamesUsed?: number
      remaining?: number
      maxGames?: number
      stake?: number
      message?: string
    }

    if (!response.ok || !data.ok || data.remaining === undefined) {
      return {
        ok: false,
        message: data.message ?? 'Пробният статус не беше зареден.',
      }
    }

    return {
      ok: true,
      gamesUsed: data.gamesUsed ?? 0,
      remaining: data.remaining,
      maxGames: data.maxGames ?? 3,
      stake: data.stake ?? 5000,
    }
  } catch {
    return {
      ok: false,
      message: 'Няма връзка със сървъра.',
    }
  }
}

async function loadLeaderboards(): Promise<
  | { ok: true; leaderboards: LeaderboardsSnapshot }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/leaderboards`, {
      method: 'GET',
      credentials: 'include',
    })
    const data = (await response.json()) as LeaderboardsResponse

    if (!response.ok || !data.ok || !data.leaderboards) {
      return {
        ok: false,
        message: data.message ?? 'Класациите не бяха заредени.',
      }
    }

    return {
      ok: true,
      leaderboards: data.leaderboards,
    }
  } catch {
    return {
      ok: false,
      message: 'Няма връзка със сървъра за класации.',
    }
  }
}

async function loadShopPackages(): Promise<
  | { ok: true; packages: CoinPackageSnapshot[] }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/shop/packages`, {
      method: 'GET',
      credentials: 'include',
    })
    const data = (await response.json()) as CoinPackagesResponse

    if (!response.ok || !data.ok || !Array.isArray(data.packages)) {
      return {
        ok: false,
        message: data.message ?? 'Магазинът не беше зареден.',
      }
    }

    return {
      ok: true,
      packages: data.packages,
    }
  } catch {
    return {
      ok: false,
      message: 'Няма връзка със сървъра за магазина.',
    }
  }
}

async function loadShopPurchases(): Promise<
  | { ok: true; purchases: CoinPurchaseSnapshot[] }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/shop/purchases`, {
      method: 'GET',
      credentials: 'include',
    })
    const data = (await response.json()) as CoinPurchasesResponse

    if (!response.ok || !data.ok || !Array.isArray(data.purchases)) {
      return {
        ok: false,
        message: data.message ?? 'Историята на покупки не беше заредена.',
      }
    }

    return {
      ok: true,
      purchases: data.purchases,
    }
  } catch {
    return {
      ok: false,
      message: 'Няма връзка със сървъра за покупки.',
    }
  }
}

async function startShopPurchase(packageId: string): Promise<
  | { ok: true; purchases: CoinPurchaseSnapshot[]; message: string }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/shop/checkout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'include',
      body: JSON.stringify({ packageId }),
    })
    const data = (await response.json()) as CoinCheckoutResponse

    if (!response.ok) {
      return {
        ok: false,
        message: data.ok ? 'Stripe плащането не беше стартирано.' : data.message,
      }
    }

    if (!data.ok) {
      return {
        ok: false,
        message: data.message,
      }
    }

    window.location.assign(data.checkoutUrl)

    const purchasesResult = await loadShopPurchases()

    return {
      ok: true,
      purchases: purchasesResult.ok ? purchasesResult.purchases : [data.purchase],
      message: 'Пренасочване към Stripe Checkout...',
    }
  } catch {
    return {
      ok: false,
      message: 'Няма връзка със сървъра за Stripe плащане.',
    }
  }
}

async function loadVipPackages(): Promise<
  | { ok: true; packages: VipPackageSnapshot[] }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/vip/packages`, {
      method: 'GET',
      credentials: 'include',
    })
    const data = (await response.json()) as VipPackagesResponse

    if (!response.ok || !data.ok || !Array.isArray(data.packages)) {
      return {
        ok: false,
        message: data.message ?? 'VIP офертите не бяха заредени.',
      }
    }

    return {
      ok: true,
      packages: data.packages,
    }
  } catch {
    return {
      ok: false,
      message: 'Няма връзка със сървъра за VIP офертите.',
    }
  }
}

async function loadVipPurchases(): Promise<
  | { ok: true; purchases: VipPurchaseSnapshot[] }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/vip/purchases`, {
      method: 'GET',
      credentials: 'include',
    })
    const data = (await response.json()) as VipPurchasesResponse

    if (!response.ok || !data.ok || !Array.isArray(data.purchases)) {
      return {
        ok: false,
        message: data.message ?? 'Историята на VIP покупки не беше заредена.',
      }
    }

    return {
      ok: true,
      purchases: data.purchases,
    }
  } catch {
    return {
      ok: false,
      message: 'Няма връзка със сървъра за VIP покупки.',
    }
  }
}

async function startVipPurchase(packageId: string): Promise<
  | { ok: true; message: string }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/vip/checkout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'include',
      body: JSON.stringify({ packageId }),
    })
    const data = (await response.json()) as VipCheckoutResponse

    if (!response.ok || !data.ok || !data.checkoutUrl) {
      return {
        ok: false,
        message: data.message ?? 'Stripe плащането не беше стартирано.',
      }
    }

    window.location.assign(data.checkoutUrl)

    return {
      ok: true,
      message: 'Пренасочване към Stripe Checkout...',
    }
  } catch {
    return {
      ok: false,
      message: 'Няма връзка със сървъра за Stripe плащане.',
    }
  }
}

async function resumeShopPurchase(purchaseId: string): Promise<
  | { ok: true; checkoutUrl: string }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(
      `${getApiBaseUrl()}/api/shop/purchases/${encodeURIComponent(purchaseId)}/resume-checkout`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      },
    )
    const data = (await response.json()) as CoinResumeCheckoutResponse

    if (!response.ok || !data.ok) {
      return {
        ok: false,
        message: data.ok ? 'Checkout не беше стартиран.' : data.message,
      }
    }

    return { ok: true, checkoutUrl: data.checkoutUrl }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function hideShopPurchase(purchaseId: string): Promise<
  | { ok: true; purchases: CoinPurchaseSnapshot[] }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(
      `${getApiBaseUrl()}/api/shop/purchases/${encodeURIComponent(purchaseId)}/hide`,
      {
        method: 'PATCH',
        credentials: 'include',
      },
    )
    const data = (await response.json()) as CoinHidePurchaseResponse

    if (!response.ok || !data.ok) {
      return {
        ok: false,
        message: data.ok ? 'Скриването не беше успешно.' : data.message,
      }
    }

    return { ok: true, purchases: data.purchases }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

function formatRewardAmount(value: number): string {
  return new Intl.NumberFormat('bg-BG').format(Math.max(0, Math.trunc(value)))
}

function playStripeRewardSound(): void {
  try {
    const audio = new Audio('/audio/game-sounds/coins.mp3')
    audio.volume = 0.75
    void audio.play().catch(() => {})
  } catch {
    // Browser audio policies can block playback after a redirect.
  }
}

function showStripeCoinRewardOverlay(amount: number): void {
  const safeAmount = Math.max(0, Math.trunc(amount))
  if (safeAmount <= 0) return

  document.getElementById('stripe-coin-reward-overlay')?.remove()

  const overlay = document.createElement('div')
  overlay.id = 'stripe-coin-reward-overlay'
  overlay.style.cssText = [
    'position:fixed',
    'inset:0',
    'z-index:1000000',
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'pointer-events:none',
    'font-family:Arial, Helvetica, sans-serif',
  ].join(';')

  const numberEl = document.createElement('div')
  numberEl.textContent = '+0'
  numberEl.style.cssText = [
    'font-size:clamp(58px, 11vw, 138px)',
    'line-height:1',
    'font-weight:900',
    'letter-spacing:0',
    'color:#22c55e',
    'text-shadow:0 0 18px rgba(34,197,94,0.7),0 0 46px rgba(34,197,94,0.42),0 10px 24px rgba(0,0,0,0.78)',
    'transform:scale(0.72)',
    'opacity:0',
    'filter:drop-shadow(0 0 18px rgba(34,197,94,0.58))',
    'will-change:transform,opacity',
  ].join(';')

  overlay.appendChild(numberEl)
  document.body.appendChild(overlay)
  playStripeRewardSound()

  const durationMs = 1500
  const start = performance.now()

  const tick = (now: number): void => {
    const progress = Math.min(1, (now - start) / durationMs)
    const eased = 1 - Math.pow(1 - progress, 3)
    const currentAmount = Math.round(safeAmount * eased)
    const introProgress = Math.min(1, progress / 0.22)
    const pulse = Math.sin(progress * Math.PI) * 0.08

    numberEl.textContent = `+${formatRewardAmount(currentAmount)}`
    numberEl.style.opacity = String(introProgress)
    numberEl.style.transform = `scale(${0.72 + introProgress * 0.28 + pulse})`

    if (progress < 1) {
      requestAnimationFrame(tick)
      return
    }

    numberEl.textContent = `+${formatRewardAmount(safeAmount)}`
    numberEl.style.transform = 'scale(1.03)'

    window.setTimeout(() => {
      overlay.style.transition = 'opacity 0.45s ease, transform 0.45s ease'
      overlay.style.opacity = '0'
      overlay.style.transform = 'scale(1.03)'
      window.setTimeout(() => overlay.remove(), 480)
    }, 850)
  }

  requestAnimationFrame(tick)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms)
  })
}

async function waitForPaidStripePurchase(
  checkoutSessionId: string,
): Promise<CoinPurchaseSnapshot | null> {
  const normalizedSessionId = checkoutSessionId.trim()
  if (!normalizedSessionId) return null

  const startedAt = Date.now()
  const timeoutMs = 8500

  while (Date.now() - startedAt <= timeoutMs) {
    const result = await loadShopPurchases()

    if (result.ok) {
      const purchase = result.purchases.find((item) => {
        return item.providerCheckoutSessionId === normalizedSessionId
      })

      if (purchase?.status === 'paid') {
        return purchase
      }
    }

    await delay(700)
  }

  return null
}

// Mirror на waitForPaidStripePurchase (coins), но полира /api/vip/purchases —
// success redirect URL-ът е СПОДЕЛЕН template за coins/VIP/resume checkout
// (виж STRIPE_SUCCESS_URL fallback-а в server/src/index.ts), значи клиентът
// НЕ знае от URL-а самия дали sesion_id принадлежи на coin или VIP покупка.
// Webhook-ът остава единственият source of truth за settlement — това е
// само polling за "вече ли webhook-ът пристигна", никога fake-success само
// от redirect параметъра.
async function waitForPaidVipPurchase(
  checkoutSessionId: string,
): Promise<VipPurchaseSnapshot | null> {
  const normalizedSessionId = checkoutSessionId.trim()
  if (!normalizedSessionId) return null

  const startedAt = Date.now()
  const timeoutMs = 8500

  while (Date.now() - startedAt <= timeoutMs) {
    const result = await loadVipPurchases()

    if (result.ok) {
      const purchase = result.purchases.find((item) => {
        return item.providerCheckoutSessionId === normalizedSessionId
      })

      if (purchase?.status === 'paid') {
        return purchase
      }
    }

    await delay(700)
  }

  return null
}

function formatVipActiveUntilLabel(activeUntilIso: string): string | null {
  const parsed = new Date(activeUntilIso)
  if (!Number.isFinite(parsed.getTime())) return null
  return parsed.toLocaleDateString('bg-BG', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

// Пуска се ТОЧНО веднъж, само на прехода loading -> server-confirmed paid
// (виж handleStripePaymentSuccessReturn). Established fire-and-forget pattern
// (mirror на playStripeRewardSound) — playback failure никога не блокира
// popup-а/payment flow-а.
function playVipPurchaseConfirmedSound(): void {
  try {
    const audio = new Audio('/audio/Notifications/notification-3.mp3')
    audio.volume = 0.75
    void audio.play().catch(() => {})
  } catch {
    // Browser audio policies can block playback after a redirect.
  }
}

async function showVipPurchaseSuccessMessage(purchase: VipPurchaseSnapshot): Promise<void> {
  lobby.invalidateOwnVipStatus()

  // Датата на popup-а идва от ОБНОВЕНИЯ server VIP status (не от client-side
  // изчисление "днес + days") — webhook settlement-ът вече е приложил
  // extend-not-overwrite логиката (27+30=57 и т.н.) сървърно, значи само
  // сървърът знае реалния краен active_until.
  const statusResult = await loadOwnVipStatus()
  const activeUntilLabel =
    statusResult.ok && statusResult.activeUntil ? formatVipActiveUntilLabel(statusResult.activeUntil) : null

  // Звукът се пуска ТОЧНО тук — единственото място, където loading фазата
  // transition-ва в confirmed paid success. Никога при първоначалния loading
  // popup, никога при delayed/timeout, никога повторно при re-render (тази
  // функция се извиква само веднъж на успешен redirect, guard-нато от
  // sessionStorage seenKey в handleStripePaymentSuccessReturn).
  playVipPurchaseConfirmedSound()

  lobby.showVipPurchaseSuccessPopup(purchase.days, activeUntilLabel)
}

async function handleStripePaymentSuccessReturn(checkoutSessionId: string | null): Promise<void> {
  const normalizedSessionId = checkoutSessionId?.trim() ?? ''
  if (!normalizedSessionId || currentAuthSession === null) return

  const seenKey = `stripe_reward_seen_${normalizedSessionId}`
  try {
    if (sessionStorage.getItem(seenKey) === '1') return
  } catch {
    // Ignore storage failures; the backend remains the source of truth.
  }

  // UX fix: показва loading modal ВЕДНАГА при redirect landing, преди exact
  // session correlation-ът по-долу да е резолвнат — потребителят вижда
  // незабавна обратна връзка вместо "нищо не се случва" между Stripe
  // redirect-а и webhook потвърждението. Same popup instance transition-ва
  // към success/delayed по-долу — никога отделен втори stacked popup.
  lobby.showVipPurchaseProcessingPopup()

  // Success redirect URL е СПОДЕЛЕН template за coins/VIP (виж коментара
  // до waitForPaidVipPurchase) — не знаем от URL-а сам по себе си кой тип
  // покупка е session_id-то, затова стартираме и двата lookup-а паралелно.
  // ВАЖНО: session_id принадлежи ТОЧНО на един purchase type — другият
  // poller никога няма да намери match и ще изчерпи целия си 8.5s timeout
  // напразно. Promise.all() тук би блокирал success прехода до по-бавния от
  // двата (напр. VIP paid за 1-2s, но UI чака цели 8.5s заради coin poller-а,
  // който гарантирано ще върне null). Затова reагираме на ПЪРВИЯ non-null
  // резултат веднага, докато другият poller продължава в background-а
  // (fire-and-forget — резултатът му вече е ирелевантен, session_id вече е
  // разрешен еднозначно). Само ако И ДВАТА резултата дойдат null, значи
  // нито едно потвърждение не пристигна до края на съответния timeout →
  // delayed. Exact providerCheckoutSessionId correlation (вътре в самите
  // poller функции) остава непроменена — само orchestration-ът на резултата
  // тук е по-бърз.
  type ResolvedPurchase =
    | { kind: 'coin'; purchase: CoinPurchaseSnapshot }
    | { kind: 'vip'; purchase: VipPurchaseSnapshot }

  const resolved = await new Promise<ResolvedPurchase | null>((resolvePromise) => {
    let settled = false
    let nullCount = 0

    const settleOnce = (value: ResolvedPurchase | null): void => {
      if (settled) return
      settled = true
      resolvePromise(value)
    }

    waitForPaidStripePurchase(normalizedSessionId).then((purchase) => {
      if (purchase !== null) {
        settleOnce({ kind: 'coin', purchase })
        return
      }
      nullCount += 1
      if (nullCount === 2) settleOnce(null)
    })

    waitForPaidVipPurchase(normalizedSessionId).then((purchase) => {
      if (purchase !== null) {
        settleOnce({ kind: 'vip', purchase })
        return
      }
      nullCount += 1
      if (nullCount === 2) settleOnce(null)
    })
  })

  if (resolved === null) {
    // И двата poller-а изчерпаха собствения си timeout без нито едно
    // потвърдено плащане. Coins flow-ът остава напълно непроменен (без
    // delayed UX за него — извън обхвата на тази задача) — само VIP loading
    // popup-ът се превключва в 'delayed', за да НЕ остане завинаги на
    // "Изчакваме потвърждение" без изход.
    lobby.showVipPurchaseDelayedPopup()
    return
  }

  try {
    sessionStorage.setItem(seenKey, '1')
  } catch {
    // Ignore storage failures.
  }

  await loadAuthSession()
  lobby.resetToLobby()

  if (resolved.kind === 'coin') {
    showStripeCoinRewardOverlay(resolved.purchase.yellowCoinsAmount)
    return
  }

  await showVipPurchaseSuccessMessage(resolved.purchase)
}

async function loadPublicSettings(): Promise<void> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/settings/public`, {
      method: 'GET',
      credentials: 'include',
    })
    const data = (await response.json()) as PublicSettingsResponse
    const signupBonus = data.settings?.signupBonusYellowCoins
    const nameChangePrice = data.settings?.profileNameChangePrice

    if (response.ok && data.ok && typeof signupBonus === 'number' && Number.isInteger(signupBonus)) {
      publicSignupBonusYellowCoins = Math.max(0, signupBonus)
    }

    if (
      response.ok &&
      data.ok &&
      typeof nameChangePrice === 'number' &&
      Number.isInteger(nameChangePrice)
    ) {
      publicProfileNameChangePrice = Math.max(0, nameChangePrice)
    }

    if (response.ok && data.ok) {
      if (typeof data.onlinePlayersCount === 'number') {
        publicOnlinePlayersCount = data.onlinePlayersCount
      }
      if (!activeRoom.hasActiveRoom()) lobby.render()
    }
  } catch {
    // Keep the local fallback.
  }
}

type DailyRewardsApiResponse = {
  ok: boolean
  activeTiers?: DailyRewardTierSnapshot[]
  stagedTiers?: DailyRewardTierSnapshot[]
  tiers?: DailyRewardTierSnapshot[]
  yellowCoinsAwarded?: number
  newBalance?: number | null
  message?: string
}

async function loadAdminDailyRewards(): Promise<
  | { ok: true; activeTiers: DailyRewardTierSnapshot[]; stagedTiers: DailyRewardTierSnapshot[] }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/admin/daily-rewards`, {
      method: 'GET',
      credentials: 'include',
    })
    const data = (await response.json()) as DailyRewardsApiResponse
    if (!response.ok || !data.ok || !Array.isArray(data.activeTiers) || !Array.isArray(data.stagedTiers)) {
      return { ok: false, message: data.message ?? 'Наградите не бяха заредени.' }
    }
    return { ok: true, activeTiers: data.activeTiers, stagedTiers: data.stagedTiers }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function addAdminDailyReward(yellowCoinsAmount: number): Promise<
  | { ok: true; activeTiers: DailyRewardTierSnapshot[]; stagedTiers: DailyRewardTierSnapshot[] }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/admin/daily-rewards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ yellowCoinsAmount }),
    })
    const data = (await response.json()) as DailyRewardsApiResponse
    if (!response.ok || !data.ok || !Array.isArray(data.activeTiers) || !Array.isArray(data.stagedTiers)) {
      return { ok: false, message: data.message ?? 'Наградата не беше добавена.' }
    }
    return { ok: true, activeTiers: data.activeTiers, stagedTiers: data.stagedTiers }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function removeAdminDailyReward(tierId: string): Promise<
  | { ok: true; activeTiers: DailyRewardTierSnapshot[]; stagedTiers: DailyRewardTierSnapshot[] }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(
      `${getApiBaseUrl()}/api/admin/daily-rewards/${encodeURIComponent(tierId)}`,
      { method: 'DELETE', credentials: 'include' },
    )
    const data = (await response.json()) as DailyRewardsApiResponse
    if (!response.ok || !data.ok || !Array.isArray(data.activeTiers) || !Array.isArray(data.stagedTiers)) {
      return { ok: false, message: data.message ?? 'Наградата не беше премахната.' }
    }
    return { ok: true, activeTiers: data.activeTiers, stagedTiers: data.stagedTiers }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function loadDailyRewards(): Promise<
  | { ok: true; tiers: DailyRewardTierSnapshot[] }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/daily-rewards`, {
      method: 'GET',
      credentials: 'include',
    })
    const data = (await response.json()) as DailyRewardsApiResponse
    if (!response.ok || !data.ok || !Array.isArray(data.tiers)) {
      return { ok: false, message: data.message ?? 'Наградите не бяха заредени.' }
    }
    return { ok: true, tiers: data.tiers }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function claimDailyReward(tierId: string): Promise<
  | { ok: true; yellowCoinsAwarded: number; newBalance: number | null; tiers: DailyRewardTierSnapshot[] }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/daily-rewards/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ tierId }),
    })
    const data = (await response.json()) as DailyRewardsApiResponse
    if (!response.ok || !data.ok || !Array.isArray(data.tiers)) {
      return { ok: false, message: data.message ?? 'Наградата не беше взета.' }
    }
    const awarded = data.yellowCoinsAwarded ?? 0
    if (currentAuthSession !== null && typeof data.newBalance === 'number') {
      currentAuthSession = {
        ...currentAuthSession,
        profile: {
          ...currentAuthSession.profile,
          yellowCoinsBalance: data.newBalance,
        },
      }
      syncLobbyWithAuthSession()
    }
    return { ok: true, yellowCoinsAwarded: awarded, newBalance: data.newBalance ?? null, tiers: data.tiers }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function loadAdminStats(): Promise<
  | { ok: true; stats: AdminStatsSnapshot }
  | { ok: false; message: string; forbidden?: boolean }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/admin/stats`, {
      method: 'GET',
      credentials: 'include',
    })
    if (response.status === 403) {
      return { ok: false, message: 'Нямаш достъп до статистиките.', forbidden: true }
    }
    const data = (await response.json()) as { ok: boolean; stats?: AdminStatsSnapshot; message?: string }
    if (!response.ok || !data.ok || !data.stats) {
      return { ok: false, message: data.message ?? 'Грешка при зареждане на статистиките.' }
    }
    return { ok: true, stats: data.stats }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function loadAdminVisitors(params: {
  period: VisitorListPeriod
  type: VisitorListType
  device: VisitorDeviceFilter
  os: VisitorOsFilter
  limit: number
  offset: number
}): Promise<{ ok: true } & AdminVisitorListResult | { ok: false; message: string; forbidden?: boolean }> {
  try {
    const qs = new URLSearchParams({
      period: params.period,
      type: params.type,
      device: params.device,
      os: params.os,
      limit: String(params.limit),
      offset: String(params.offset),
    })
    const response = await fetch(`${getApiBaseUrl()}/api/admin/visitors?${qs}`, {
      method: 'GET',
      credentials: 'include',
    })
    if (response.status === 403) {
      return { ok: false, message: 'Нямаш достъп до посетителите.', forbidden: true }
    }
    const data = (await response.json()) as { ok: boolean; rows?: AdminVisitorListResult['rows']; total?: number; message?: string }
    if (!response.ok || !data.ok || !Array.isArray(data.rows) || typeof data.total !== 'number') {
      return { ok: false, message: data.message ?? 'Грешка при зареждане на посетителите.' }
    }
    return { ok: true, rows: data.rows, total: data.total }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function loadAdminVisitorSources(params: {
  period: VisitorListPeriod
  type: VisitorListType
  device: VisitorDeviceFilter
  os: VisitorOsFilter
}): Promise<{ ok: true } & AdminVisitorSourcesResult | { ok: false; message: string; forbidden?: boolean }> {
  try {
    const qs = new URLSearchParams({ period: params.period, type: params.type, device: params.device, os: params.os })
    const response = await fetch(`${getApiBaseUrl()}/api/admin/visitor-sources?${qs}`, {
      method: 'GET',
      credentials: 'include',
    })
    if (response.status === 403) {
      return { ok: false, message: 'Нямаш достъп до източниците.', forbidden: true }
    }
    const data = (await response.json()) as { ok: boolean; rows?: AdminVisitorSourcesResult['rows']; total?: number; message?: string }
    if (!response.ok || !data.ok || !Array.isArray(data.rows) || typeof data.total !== 'number') {
      return { ok: false, message: data.message ?? 'Грешка при зареждане на източници.' }
    }
    return { ok: true, rows: data.rows, total: data.total }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function loadAdminPayments(params: {
  period: string
  limit: number
  offset: number
}): Promise<
  | {
      ok: true
      purchases: import('./app/adminPayments/adminPaymentsTypes').AdminPaymentListRow[]
      pagination: { limit: number; offset: number; total: number; hasMore: boolean }
      summary: { totalsByCurrency: Record<string, number> }
    }
  | { ok: false; message: string; forbidden?: boolean }
> {
  try {
    const qs = new URLSearchParams({
      period: params.period,
      limit: String(params.limit),
      offset: String(params.offset),
    })
    const response = await fetch(`${getApiBaseUrl()}/api/admin/payments?${qs}`, {
      method: 'GET',
      credentials: 'include',
    })
    if (response.status === 403) {
      return { ok: false, message: 'Нямаш достъп до плащанията.', forbidden: true }
    }
    type PaymentsResponse = {
      ok: boolean
      purchases?: import('./app/adminPayments/adminPaymentsTypes').AdminPaymentListRow[]
      pagination?: { limit: number; offset: number; total: number; hasMore: boolean }
      summary?: { totalsByCurrency: Record<string, number> }
      message?: string
    }
    const data = (await response.json()) as PaymentsResponse
    if (!response.ok || !data.ok || !Array.isArray(data.purchases) || !data.pagination || !data.summary) {
      return { ok: false, message: data.message ?? 'Грешка при зареждане на плащанията.' }
    }
    return { ok: true, purchases: data.purchases, pagination: data.pagination, summary: data.summary }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function loadAdminPaymentDetail(purchaseId: string): Promise<
  | { ok: true; purchase: import('./app/adminPayments/adminPaymentsTypes').AdminPaymentDetailRow }
  | { ok: false; message: string; forbidden?: boolean }
> {
  try {
    const response = await fetch(
      `${getApiBaseUrl()}/api/admin/payments/${encodeURIComponent(purchaseId)}`,
      { method: 'GET', credentials: 'include' },
    )
    if (response.status === 403) {
      return { ok: false, message: 'Нямаш достъп до това плащане.', forbidden: true }
    }
    type DetailResponse = {
      ok: boolean
      purchase?: import('./app/adminPayments/adminPaymentsTypes').AdminPaymentDetailRow
      message?: string
    }
    const data = (await response.json()) as DetailResponse
    if (!response.ok || !data.ok || !data.purchase) {
      return { ok: false, message: data.message ?? 'Грешка при зареждане на плащането.' }
    }
    return { ok: true, purchase: data.purchase }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function loadAdminTournaments(filters: AdminTournamentFilters): Promise<
  | { ok: true; tournaments: AdminTournamentSummaryRow[]; page: number; limit: number; totalCount: number; canWrite: boolean }
  | { ok: false; message: string; forbidden?: boolean }
> {
  try {
    const qs = new URLSearchParams({
      page: String(filters.page),
      limit: String(filters.limit),
    })
    for (const key of ['status', 'settlementState', 'visibility', 'startMode', 'integrityState', 'search'] as const) {
      const value = filters[key]
      if (value) qs.set(key, value)
    }
    const response = await fetch(`${getApiBaseUrl()}/api/admin/tournaments?${qs}`, {
      method: 'GET',
      credentials: 'include',
    })
    if (response.status === 403) {
      return { ok: false, message: 'Нямаш достъп до admin турнири.', forbidden: true }
    }
    const data = (await response.json()) as {
      ok: boolean
      tournaments?: AdminTournamentSummaryRow[]
      page?: number
      limit?: number
      totalCount?: number
      canWrite?: boolean
      message?: string
    }
    if (!response.ok || !data.ok || !Array.isArray(data.tournaments) || typeof data.totalCount !== 'number') {
      return { ok: false, message: data.message ?? 'Грешка при зареждане на турнирите.' }
    }
    return {
      ok: true,
      tournaments: data.tournaments,
      page: data.page ?? filters.page,
      limit: data.limit ?? filters.limit,
      totalCount: data.totalCount,
      canWrite: data.canWrite === true,
    }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function loadAdminTournamentDetail(tournamentId: string): Promise<
  | { ok: true; tournament: AdminTournamentDetailRow; canWrite: boolean }
  | { ok: false; message: string; forbidden?: boolean }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/admin/tournaments/${encodeURIComponent(tournamentId)}`, {
      method: 'GET',
      credentials: 'include',
    })
    if (response.status === 403) {
      return { ok: false, message: 'Нямаш достъп до този admin турнир.', forbidden: true }
    }
    const data = (await response.json()) as {
      ok: boolean
      tournament?: AdminTournamentDetailRow
      canWrite?: boolean
      message?: string
    }
    if (!response.ok || !data.ok || !data.tournament) {
      return { ok: false, message: data.message ?? 'Грешка при зареждане на турнира.' }
    }
    return { ok: true, tournament: data.tournament, canWrite: data.canWrite === true }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function postAdminTournamentAction(
  tournamentId: string,
  action: 'reconcile' | 'cancel-open',
): Promise<
  | { ok: true; status?: string; alreadyCancelled?: boolean; refundedEntries?: number; totalRefunded?: number }
  | { ok: false; message: string; forbidden?: boolean }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/admin/tournaments/${encodeURIComponent(tournamentId)}/${action}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    if (response.status === 403) {
      return { ok: false, message: 'Нямаш право за тази операция.', forbidden: true }
    }
    const data = (await response.json()) as {
      ok: boolean
      status?: string
      alreadyCancelled?: boolean
      refundedEntries?: number
      totalRefunded?: number
      message?: string
    }
    if (!response.ok || !data.ok) {
      return { ok: false, message: data.message ?? 'Операцията не беше успешна.' }
    }
    return {
      ok: true,
      status: data.status,
      alreadyCancelled: data.alreadyCancelled,
      refundedEntries: data.refundedEntries,
      totalRefunded: data.totalRefunded,
    }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function loadAdCampaignManagement(): Promise<
  | { ok: true; campaigns: AdCampaignManagementDto[] }
  | { ok: false; message: string; forbidden?: boolean }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/admin/ad-campaigns`, {
      method: 'GET',
      credentials: 'include',
    })
    if (response.status === 403) {
      return { ok: false, message: 'Нямаш достъп до рекламните кампании.', forbidden: true }
    }
    const data = (await response.json()) as {
      ok: boolean
      campaigns?: AdCampaignManagementDto[]
      message?: string
    }
    if (!response.ok || !data.ok || !Array.isArray(data.campaigns)) {
      return { ok: false, message: data.message ?? 'Грешка при зареждане на рекламите.' }
    }
    return { ok: true, campaigns: data.campaigns }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function createAdCampaignSubmit(input: { imageDataUrl: string; targetUrl: string }): Promise<
  | { ok: true; campaign: AdCampaignManagementDto }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/admin/ad-campaigns`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    const data = (await response.json()) as {
      ok: boolean
      campaign?: AdCampaignManagementDto
      message?: string
    }
    if (!response.ok || !data.ok || !data.campaign) {
      return { ok: false, message: data.message ?? 'Кампанията не можа да бъде създадена.' }
    }
    return { ok: true, campaign: data.campaign }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function sendAdCampaignSubmit(campaignId: string): Promise<
  | { ok: true; campaign: AdCampaignManagementDto }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/admin/ad-campaigns/${encodeURIComponent(campaignId)}/send`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    const data = (await response.json()) as {
      ok: boolean
      campaign?: AdCampaignManagementDto
      message?: string
    }
    if (!response.ok || !data.ok || !data.campaign) {
      return { ok: false, message: data.message ?? 'Кампанията не можа да бъде изпратена.' }
    }
    return { ok: true, campaign: data.campaign }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function deleteAdCampaignSubmit(campaignId: string): Promise<
  | { ok: true }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/admin/ad-campaigns/${encodeURIComponent(campaignId)}`, {
      method: 'DELETE',
      credentials: 'include',
    })
    const data = (await response.json()) as { ok: boolean; message?: string }
    if (!response.ok || !data.ok) {
      return { ok: false, message: data.message ?? 'Кампанията не можа да бъде изтрита.' }
    }
    return { ok: true }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function loadAdminSettings(): Promise<
  | { ok: true; settings: AdminSettingsSnapshot }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/admin/settings`, {
      method: 'GET',
      credentials: 'include',
    })
    const data = (await response.json()) as AdminSettingsResponse

    if (!response.ok || !data.ok || !data.settings) {
      return {
        ok: false,
        message: data.message ?? 'Админ настройките не бяха заредени.',
      }
    }

    publicSignupBonusYellowCoins = data.settings.signupBonusYellowCoins
    publicProfileNameChangePrice = data.settings.profileNameChangePrice
    return {
      ok: true,
      settings: data.settings,
    }
  } catch {
    return {
      ok: false,
      message: 'Няма връзка със сървъра за админ настройки.',
    }
  }
}

async function submitAdminSettings(
  settings: AdminSettingsSnapshot,
): Promise<
  | { ok: true; settings: AdminSettingsSnapshot }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/admin/settings`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'include',
      body: JSON.stringify(settings),
    })
    const data = (await response.json()) as AdminSettingsResponse

    if (!response.ok || !data.ok || !data.settings) {
      return {
        ok: false,
        message: data.message ?? 'Админ настройките не бяха записани.',
      }
    }

    publicSignupBonusYellowCoins = data.settings.signupBonusYellowCoins
    publicProfileNameChangePrice = data.settings.profileNameChangePrice
    return {
      ok: true,
      settings: data.settings,
    }
  } catch {
    return {
      ok: false,
      message: 'Няма връзка със сървъра за админ настройки.',
    }
  }
}

async function loadAdminCoinPackages(): Promise<
  | { ok: true; packages: CoinPackageSnapshot[] }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/admin/coin-packages`, {
      method: 'GET',
      credentials: 'include',
    })
    const data = (await response.json()) as CoinPackagesResponse

    if (!response.ok || !data.ok || !Array.isArray(data.packages)) {
      return {
        ok: false,
        message: data.message ?? 'Админ пакетите не бяха заредени.',
      }
    }

    return {
      ok: true,
      packages: data.packages,
    }
  } catch {
    return {
      ok: false,
      message: 'Няма връзка със сървъра за админ пакетите.',
    }
  }
}

async function submitAdminCoinPackage(
  input: CoinPackageInput,
): Promise<
  | { ok: true; packages: CoinPackageSnapshot[] }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/admin/coin-packages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'include',
      body: JSON.stringify(input),
    })
    const data = (await response.json()) as CoinPackagesResponse

    if (!response.ok || !data.ok || !Array.isArray(data.packages)) {
      return {
        ok: false,
        message: data.message ?? 'Пакетът не беше записан.',
      }
    }

    return {
      ok: true,
      packages: data.packages,
    }
  } catch {
    return {
      ok: false,
      message: 'Няма връзка със сървъра за запис на пакет.',
    }
  }
}

async function setAdminCoinPackageStatus(
  packageId: string,
  status: CoinPackageStatus,
): Promise<
  | { ok: true; packages: CoinPackageSnapshot[] }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(
      `${getApiBaseUrl()}/api/admin/coin-packages/${encodeURIComponent(packageId)}/status`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({ status }),
      },
    )
    const data = (await response.json()) as CoinPackagesResponse

    if (!response.ok || !data.ok || !Array.isArray(data.packages)) {
      return {
        ok: false,
        message: data.message ?? 'Статусът на пакета не беше променен.',
      }
    }

    return {
      ok: true,
      packages: data.packages,
    }
  } catch {
    return {
      ok: false,
      message: 'Няма връзка със сървъра за промяна на пакет.',
    }
  }
}

async function deleteAdminCoinPackage(packageId: string): Promise<
  | { ok: true; packages: CoinPackageSnapshot[] }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(
      `${getApiBaseUrl()}/api/admin/coin-packages/${encodeURIComponent(packageId)}`,
      {
        method: 'DELETE',
        credentials: 'include',
      },
    )
    const data = (await response.json()) as CoinPackagesResponse

    if (!response.ok || !data.ok || !Array.isArray(data.packages)) {
      return {
        ok: false,
        message: data.message ?? 'Пакетът не беше изтрит.',
      }
    }

    return {
      ok: true,
      packages: data.packages,
    }
  } catch {
    return {
      ok: false,
      message: 'Няма връзка със сървъра за изтриване на пакет.',
    }
  }
}

async function loadLobbyPackages(): Promise<
  | { ok: true; packages: CoinPackageSnapshot[] }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/lobby/packages`, {
      method: 'GET',
    })
    const data = (await response.json()) as CoinPackagesResponse

    if (!response.ok || !data.ok || !Array.isArray(data.packages)) {
      return {
        ok: false,
        message: data.message ?? 'Лоби офертите не бяха заредени.',
      }
    }

    return {
      ok: true,
      packages: data.packages,
    }
  } catch {
    return {
      ok: false,
      message: 'Няма връзка със сървъра за лоби оферти.',
    }
  }
}

async function setAdminCoinPackageLobbyVisibility(
  packageId: string,
  showInLobby: boolean,
): Promise<
  | { ok: true; packages: CoinPackageSnapshot[] }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(
      `${getApiBaseUrl()}/api/admin/coin-packages/${encodeURIComponent(packageId)}/lobby`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({ showInLobby }),
      },
    )
    const data = (await response.json()) as CoinPackagesResponse

    if (!response.ok || !data.ok || !Array.isArray(data.packages)) {
      return {
        ok: false,
        message: data.message ?? 'Лоби видимостта не беше променена.',
      }
    }

    return {
      ok: true,
      packages: data.packages,
    }
  } catch {
    return {
      ok: false,
      message: 'Няма връзка със сървъра за промяна на лоби видимост.',
    }
  }
}

async function setAdminCoinPackageTopOffer(
  packageId: string,
  isTopOffer: boolean,
): Promise<
  | { ok: true; packages: CoinPackageSnapshot[] }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(
      `${getApiBaseUrl()}/api/admin/coin-packages/${encodeURIComponent(packageId)}/top-offer`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({ isTopOffer }),
      },
    )
    const data = (await response.json()) as CoinPackagesResponse

    if (!response.ok || !data.ok || !Array.isArray(data.packages)) {
      return {
        ok: false,
        message: data.message ?? 'Топ офертата не беше променена.',
      }
    }

    return {
      ok: true,
      packages: data.packages,
    }
  } catch {
    return {
      ok: false,
      message: 'Няма връзка със сървъра за промяна на топ оферта.',
    }
  }
}

async function readFriendshipsResponse(response: Response): Promise<FriendshipsResponse> {
  try {
    return (await response.json()) as FriendshipsResponse
  } catch {
    return {
      ok: false,
      message: 'Невалиден отговор от сървъра.',
    }
  }
}

async function loadFriendships(): Promise<
  | { ok: true; friendships: FriendshipsSnapshot }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/friends`, {
      method: 'GET',
      credentials: 'include',
    })
    const data = await readFriendshipsResponse(response)

    if (!response.ok || !data.ok || !data.friendships) {
      return {
        ok: false,
        message: data.message ?? 'Приятелите не бяха заредени.',
      }
    }

    return {
      ok: true,
      friendships: data.friendships,
    }
  } catch {
    return {
      ok: false,
      message: 'Няма връзка със сървъра за приятели.',
    }
  }
}

async function submitFriendRequest(profileId: string): Promise<
  | { ok: true; friendships: FriendshipsSnapshot }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/friends/request`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'include',
      body: JSON.stringify({ profileId }),
    })
    const data = await readFriendshipsResponse(response)

    if (!response.ok || !data.ok || !data.friendships) {
      return {
        ok: false,
        message: data.message ?? 'Поканата не беше изпратена.',
      }
    }

    return {
      ok: true,
      friendships: data.friendships,
    }
  } catch {
    return {
      ok: false,
      message: 'Няма връзка със сървъра за приятели.',
    }
  }
}

async function submitFriendAction(
  friendshipId: string,
  action: 'accept' | 'reject' | 'cancel' | 'remove',
): Promise<
  | { ok: true; friendships: FriendshipsSnapshot }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(
      `${getApiBaseUrl()}/api/friends/${encodeURIComponent(friendshipId)}/${action}`,
      {
        method: 'POST',
        credentials: 'include',
      },
    )
    const data = await readFriendshipsResponse(response)

    if (!response.ok || !data.ok || !data.friendships) {
      return {
        ok: false,
        message: data.message ?? 'Поканата не беше обработена.',
      }
    }

    return {
      ok: true,
      friendships: data.friendships,
    }
  } catch {
    return {
      ok: false,
      message: 'Няма връзка със сървъра за приятели.',
    }
  }
}

async function submitProfileBlock(
  profileId: string,
): Promise<{ blocked: boolean } | { ok: false; message: string; limitReached?: true }> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/profiles/${encodeURIComponent(profileId)}/block`, {
      method: 'POST',
      credentials: 'include',
    })
    const data = await response.json() as {
      ok?: boolean
      blocked?: boolean
      message?: string
      limitReached?: boolean
    }

    if (!response.ok || !data.ok) {
      return {
        ok: false,
        message: data.message ?? 'Операцията не успя.',
        ...(data.limitReached ? { limitReached: true as const } : {}),
      }
    }

    return { blocked: data.blocked ?? false }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function readChatConversationsResponse(
  response: Response,
): Promise<ChatConversationsResponse> {
  try {
    return (await response.json()) as ChatConversationsResponse
  } catch {
    return {
      ok: false,
      message: 'Невалиден отговор от сървъра.',
    }
  }
}

async function readChatMessagesResponse(
  response: Response,
): Promise<ChatMessagesResponse> {
  try {
    return (await response.json()) as ChatMessagesResponse
  } catch {
    return {
      ok: false,
      message: 'Невалиден отговор от сървъра.',
    }
  }
}

async function loadChatConversations(includeArchived = false): Promise<
  | { ok: true; conversations: ChatConversationSnapshot[] }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(
      `${getApiBaseUrl()}/api/chat/conversations${includeArchived ? '?archived=1' : ''}`,
      {
        method: 'GET',
        credentials: 'include',
      },
    )
    const data = await readChatConversationsResponse(response)

    if (!response.ok || !data.ok || !Array.isArray(data.conversations)) {
      return {
        ok: false,
        message: data.message ?? 'Разговорите не бяха заредени.',
      }
    }

    return {
      ok: true,
      conversations: data.conversations,
    }
  } catch {
    return {
      ok: false,
      message: 'Няма връзка със сървъра за чат.',
    }
  }
}

async function startPikaSupportChat(recipientProfileId: string): Promise<
  | { ok: true; friendshipId: string }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/chat/pika-support/start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'include',
      body: JSON.stringify({ recipientProfileId }),
    })
    const data = await response.json().catch(() => ({})) as {
      ok?: boolean
      message?: string
      friendshipId?: string
    }

    if (!response.ok || !data.ok || typeof data.friendshipId !== 'string') {
      return {
        ok: false,
        message: data.message ?? 'Разговорът не беше започнат.',
      }
    }

    return {
      ok: true,
      friendshipId: data.friendshipId,
    }
  } catch {
    return {
      ok: false,
      message: 'Няма връзка със сървъра за чат.',
    }
  }
}

// Атомарен start+send за ПЪРВОТО vip_dm съобщение (виж §4/§9 в task
// spec-а) — заменя старото startVipDmChat (create-only, без съобщение).
// Server-side get-or-create vip_dm + insert съобщение стават в 1 SQLite
// транзакция (chatStore.startVipDmConversationWithMessage); ако insert-ът
// се провали, нов vip_dm ред не остава persistent.
async function startVipDmFirstMessage(
  recipientProfileId: string,
  body: string,
  imageDataUrl?: string | null,
): Promise<
  | { ok: true; conversation: ChatConversationSnapshot; messages: ChatMessageSnapshot[]; newMessage?: ChatMessageSnapshot }
  | { ok: false; message: string; code?: ChatMessagesResponse['code']; mutedUntil?: string; reason?: string }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/chat/vip-dm/start-with-message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'include',
      body: JSON.stringify(
        imageDataUrl ? { recipientProfileId, body, imageDataUrl } : { recipientProfileId, body },
      ),
    })
    const data = await readChatMessagesResponse(response)

    if (
      !response.ok ||
      !data.ok ||
      !data.conversation ||
      !Array.isArray(data.messages)
    ) {
      return {
        ok: false,
        message: formatPersonalChatError(data),
        code: data.code,
        mutedUntil: data.mutedUntil,
        reason: data.reason,
      }
    }

    return {
      ok: true,
      conversation: data.conversation,
      messages: data.messages,
      newMessage: data.newMessage,
    }
  } catch {
    return {
      ok: false,
      message: 'Няма връзка със сървъра за чат.',
    }
  }
}

async function loadChatMessages(friendshipId: string): Promise<
  | { ok: true; messages: ChatMessageSnapshot[] }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(
      `${getApiBaseUrl()}/api/chat/${encodeURIComponent(friendshipId)}/messages`,
      {
        method: 'GET',
        credentials: 'include',
      },
    )
    const data = await readChatMessagesResponse(response)

    if (!response.ok || !data.ok || !Array.isArray(data.messages)) {
      return {
        ok: false,
        message: data.message ?? 'Съобщенията не бяха заредени.',
      }
    }

    return {
      ok: true,
      messages: data.messages,
    }
  } catch {
    return {
      ok: false,
      message: 'Няма връзка със сървъра за чат.',
    }
  }
}

// Модерация на общия лайв чат в лобито — само пълен admin (сървърът проверява
// ролята НА МОМЕНТА, виж handleLobbyChatDeleteRequest в server/src/index.ts).
// UI обновяването идва по WS (lobby_chat_message_deleted broadcast до всички
// абонирани, вкл. самия admin), затова тук не правим оптимистично премахване.
async function deleteLobbyChatMessage(messageId: string): Promise<void> {
  try {
    await fetch(
      `${getApiBaseUrl()}/api/lobby-chat/messages/${encodeURIComponent(messageId)}`,
      {
        method: 'DELETE',
        credentials: 'include',
      },
    )
  } catch {
    // Мълчаливо: липса на връзка тук не е критична — admin може да опита пак.
  }
}

/**
 * Единственият path, който маркира разговор като прочетен — и на сървъра
 * (source of truth за shouldNotify при бъдещи съобщения), и локално в
 * chat popup опашката. Реда е строго: сървърна заявка ПЪРВО; локалният
 * queue reset (chatMessageNotification.markRead) се извиква САМО при
 * потвърден успех — иначе клиентът би "забравил" за непрочетена поредица,
 * докато сървърът все още я смята за непрочетена, и следващо съобщение от
 * същия подател грешно би получило shouldNotify=false (защото сървърът вече
 * знае, че получателят реално е видял разговора).
 *
 * Reuse-ва се от: явния "маркирай прочетено" клик в чат списъка
 * (onChatMarkRead) И от chat_message_received handler-а, когато съобщението
 * пристига докато разговорът с подателя вече е отворен и видим.
 */
async function markChatConversationRead(friendshipId: string): Promise<boolean> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/chat/${encodeURIComponent(friendshipId)}/read`, {
      method: 'POST',
      credentials: 'include',
    })

    if (!response.ok) {
      return false
    }

    chatMessageNotification.markRead(friendshipId)
    return true
  } catch {
    return false
  }
}

async function sendChatMessage(
  friendshipId: string,
  body: string,
  imageDataUrl?: string | null,
): Promise<
  | {
      ok: true
      conversation: ChatConversationSnapshot
      messages: ChatMessageSnapshot[]
      newMessage?: ChatMessageSnapshot
    }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(
      `${getApiBaseUrl()}/api/chat/${encodeURIComponent(friendshipId)}/messages`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify(
          imageDataUrl ? { body, imageDataUrl } : { body },
        ),
      },
    )
    const data = await readChatMessagesResponse(response)

    if (
      !response.ok ||
      !data.ok ||
      !data.conversation ||
      !Array.isArray(data.messages)
    ) {
      if (data.code) {
        return {
          ok: false,
          message: formatPersonalChatError(data),
        }
      }
      return {
        ok: false,
        message: data.message ?? 'Съобщението не беше изпратено.',
      }
    }

    return {
      ok: true,
      conversation: data.conversation,
      messages: data.messages,
      newMessage: data.newMessage,
    }
  } catch {
    return {
      ok: false,
      message: 'Няма връзка със сървъра за чат.',
    }
  }
}

type SupportMessagesApiResponse = {
  ok: boolean
  messages?: SupportMessageSnapshot[]
  unreadCount?: number
  message?: string
}

type SupportConversationsApiResponse = {
  ok: boolean
  conversations?: SupportConversationSnapshot[]
  message?: string
}

type AdminGuestContactMessagesApiResponse = {
  ok: boolean
  messages?: GuestContactMessageListItem[]
  message?: string
}

type GuestContactApiResponse = {
  ok: boolean
  message?: string
}

async function loadSupportMessages(): Promise<
  | { ok: true; messages: SupportMessageSnapshot[] }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/support/messages`, {
      method: 'GET',
      credentials: 'include',
    })
    const data = (await response.json()) as SupportMessagesApiResponse
    if (!response.ok || !data.ok || !Array.isArray(data.messages)) {
      return { ok: false, message: data.message ?? 'Грешка при зареждане.' }
    }
    return { ok: true, messages: data.messages }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function sendSupportMessage(body: string, imageDataUrl?: string | null): Promise<
  | { ok: true; messages: SupportMessageSnapshot[] }
  | { ok: false; code?: string; remainingMinutes?: number; message?: string }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/support/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ body, website: '', ...(imageDataUrl ? { imageDataUrl } : {}) }),
    })
    const data = (await response.json()) as SupportMessagesApiResponse & { code?: string; remainingMinutes?: number }
    if (!response.ok || !data.ok) {
      return { ok: false, code: data.code, remainingMinutes: data.remainingMinutes, message: data.message }
    }
    if (!Array.isArray(data.messages)) {
      return { ok: false, message: 'Грешка при изпращане.' }
    }
    return { ok: true, messages: data.messages }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function sendGuestContactMessage(input: GuestContactFormInput): Promise<
  | { ok: true; message: string }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/contact/guest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    const data = (await response.json()) as GuestContactApiResponse

    if (!response.ok || !data.ok) {
      return { ok: false, message: data.message ?? 'Съобщението не беше изпратено.' }
    }

    return { ok: true, message: data.message ?? 'Благодарим! Съобщението беше изпратено.' }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function loadAdminSupportConversations(): Promise<
  | { ok: true; conversations: SupportConversationSnapshot[] }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/support/admin/conversations`, {
      method: 'GET',
      credentials: 'include',
    })
    const data = (await response.json()) as SupportConversationsApiResponse
    if (!response.ok || !data.ok || !Array.isArray(data.conversations)) {
      return { ok: false, message: data.message ?? 'Грешка при зареждане.' }
    }
    return { ok: true, conversations: data.conversations }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function loadAdminGuestContactMessages(): Promise<
  | { ok: true; messages: GuestContactMessageListItem[] }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/admin/guest-contact/messages`, {
      method: 'GET',
      credentials: 'include',
    })
    const data = (await response.json()) as AdminGuestContactMessagesApiResponse
    if (!response.ok || !data.ok || !Array.isArray(data.messages)) {
      return { ok: false, message: data.message ?? 'Грешка при зареждане.' }
    }
    return { ok: true, messages: data.messages }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

type AdminMonitoringApiResponse = {
  ok: boolean
  snapshot?: MonitoringSnapshot
  message?: string
}

async function loadAdminMonitoring(): Promise<
  | { ok: true; snapshot: MonitoringSnapshot }
  | { ok: false; message: string; forbidden?: boolean }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/admin/monitoring/current`, {
      method: 'GET',
      credentials: 'include',
    })
    if (response.status === 403) {
      return { ok: false, message: 'Нямаш достъп до мониторинга.', forbidden: true }
    }
    if (response.status === 503) {
      return { ok: false, message: 'Мониторингът временно не е наличен.' }
    }
    const data = (await response.json()) as AdminMonitoringApiResponse
    if (!response.ok || !data.ok || !data.snapshot) {
      return { ok: false, message: data.message ?? 'Грешка при зареждане на мониторинга.' }
    }
    return { ok: true, snapshot: data.snapshot }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

function isWsConnectionsResult(data: unknown): data is WsConnectionsResult {
  if (data === null || typeof data !== 'object') return false
  const d = data as Record<string, unknown>
  if (!Array.isArray(d['entries'])) return false
  const sm = d['summary']
  if (sm === null || typeof sm !== 'object') return false
  const s = sm as Record<string, unknown>
  return (
    typeof s['registrySize'] === 'number' &&
    typeof s['openSocketCount'] === 'number' &&
    typeof s['connectedStateCount'] === 'number' &&
    typeof s['uniqueOnlineProfiles'] === 'number' &&
    typeof s['guestOpenSockets'] === 'number' &&
    typeof s['authenticatedOpenSockets'] === 'number' &&
    typeof s['profilesWithMultipleOpenSockets'] === 'number'
  )
}

async function loadAdminConnections(): Promise<
  | { ok: true; result: WsConnectionsResult }
  | { ok: false; message: string; forbidden?: boolean }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/admin/monitoring/connections`, {
      method: 'GET',
      credentials: 'include',
    })
    if (response.status === 403) {
      return { ok: false, message: 'Нямаш достъп.', forbidden: true }
    }
    const data = await response.json() as { ok?: boolean; message?: string } & Record<string, unknown>
    if (!response.ok || data['ok'] !== true) {
      return { ok: false, message: (data['message'] as string | undefined) ?? 'Грешка при зареждане на връзките.' }
    }
    if (!isWsConnectionsResult(data)) {
      return { ok: false, message: 'Невалиден формат на отговора за WS връзки.' }
    }
    return { ok: true, result: data }
  } catch {
    return { ok: false, message: 'Няма връзка.' }
  }
}

async function loadAdminRegisteredProfiles(period: 'today' | 'yesterday' | 'all', page?: number): Promise<
  | { ok: true; rows: AdminRegisteredProfileRow[]; totalCount?: number; page?: number }
  | { ok: false; message: string; forbidden?: boolean }
> {
  try {
    const pageQuery = period === 'all' ? `&page=${encodeURIComponent(String(page ?? 1))}` : ''
    const response = await fetch(
      `${getApiBaseUrl()}/api/admin/registered-profiles?period=${encodeURIComponent(period)}${pageQuery}`,
      { method: 'GET', credentials: 'include' },
    )
    if (response.status === 403) {
      return { ok: false, message: 'Нямаш достъп.', forbidden: true }
    }
    const data = (await response.json()) as { ok?: boolean; message?: string; rows?: unknown; totalCount?: number; page?: number }
    if (!response.ok || data.ok !== true || !Array.isArray(data.rows)) {
      return { ok: false, message: data.message ?? 'Грешка при зареждане на регистрираните профили.' }
    }
    return { ok: true, rows: data.rows as AdminRegisteredProfileRow[], totalCount: data.totalCount, page: data.page }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

/** Detailed "Свързани профили" за profile popup risk секцията (само пълен admin). */
async function loadAdminProfileRiskDetail(profileId: string): Promise<
  | { ok: true; linkedProfiles: AdminProfileLinkedProfileRow[] }
  | { ok: false; message: string; forbidden?: boolean }
> {
  try {
    const response = await fetch(
      `${getApiBaseUrl()}/api/admin/profiles/${encodeURIComponent(profileId)}/risk-detail`,
      { method: 'GET', credentials: 'include' },
    )
    if (response.status === 403) {
      return { ok: false, message: 'Нямаш достъп.', forbidden: true }
    }
    const data = (await response.json()) as { ok?: boolean; message?: string; linkedProfiles?: unknown }
    if (!response.ok || data.ok !== true || !Array.isArray(data.linkedProfiles)) {
      return { ok: false, message: data.message ?? 'Грешка при зареждане на свързаните профили.' }
    }
    return { ok: true, linkedProfiles: data.linkedProfiles as AdminProfileLinkedProfileRow[] }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

/** "Провери отново" — forced recheck (само пълен admin). */
async function submitAdminProfileRiskRecheck(profileId: string): Promise<
  | { ok: true; riskDetected: boolean; linkedProfilesCount: number }
  | { ok: false; message: string; forbidden?: boolean }
> {
  try {
    const response = await fetch(
      `${getApiBaseUrl()}/api/admin/profiles/${encodeURIComponent(profileId)}/risk-recheck`,
      { method: 'POST', credentials: 'include' },
    )
    if (response.status === 403) {
      return { ok: false, message: 'Нямаш достъп.', forbidden: true }
    }
    const data = (await response.json()) as { ok?: boolean; message?: string; riskDetected?: boolean; linkedProfilesCount?: number }
    if (!response.ok || data.ok !== true) {
      return { ok: false, message: data.message ?? 'Грешка при повторната проверка.' }
    }
    return { ok: true, riskDetected: data.riskDetected ?? false, linkedProfilesCount: data.linkedProfilesCount ?? 0 }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function loadAdminCpuIncidents(): Promise<
  | { ok: true; incidents: CpuIncidentSummary[] }
  | { ok: false; message: string; forbidden?: boolean }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/admin/monitoring/cpu-incidents`, {
      method: 'GET',
      credentials: 'include',
    })
    if (response.status === 403) {
      return { ok: false, message: 'Нямаш достъп.', forbidden: true }
    }
    if (response.status === 503) {
      return { ok: false, message: 'CPU инцидентите временно не са налични.' }
    }
    const data = (await response.json()) as { ok?: boolean; message?: string; incidents?: unknown }
    if (!response.ok || data.ok !== true || !Array.isArray(data.incidents)) {
      return { ok: false, message: data.message ?? 'Грешка при зареждане на CPU инцидентите.' }
    }
    return { ok: true, incidents: data.incidents as CpuIncidentSummary[] }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function loadAdminCpuIncidentDetail(incidentId: number): Promise<
  | { ok: true; detail: CpuIncidentDetail }
  | { ok: false; message: string; forbidden?: boolean }
> {
  try {
    const response = await fetch(
      `${getApiBaseUrl()}/api/admin/monitoring/cpu-incidents/${encodeURIComponent(String(incidentId))}`,
      { method: 'GET', credentials: 'include' },
    )
    if (response.status === 403) {
      return { ok: false, message: 'Нямаш достъп.', forbidden: true }
    }
    if (response.status === 404) {
      return { ok: false, message: 'Инцидентът не беше намерен.' }
    }
    const data = (await response.json()) as {
      ok?: boolean
      message?: string
      summary?: unknown
      timeline?: unknown
      spikeSamples?: unknown
    }
    if (!response.ok || data.ok !== true || !data.summary || !Array.isArray(data.timeline)) {
      return { ok: false, message: data.message ?? 'Грешка при зареждане на детайлите.' }
    }
    return {
      ok: true,
      detail: {
        summary: data.summary as CpuIncidentDetail['summary'],
        timeline: data.timeline as CpuIncidentDetail['timeline'],
        spikeSamples: Array.isArray(data.spikeSamples) ? (data.spikeSamples as CpuIncidentDetail['spikeSamples']) : [],
      },
    }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

let monitoringIntervalId: ReturnType<typeof setInterval> | null = null
let monitoringGeneration = 0
let monitoringFetchInFlightGeneration: number | null = null

function startMonitoringPolling(): void {
  if (monitoringIntervalId !== null) return
  const runOnePoll = (gen: number): void => {
    if (monitoringFetchInFlightGeneration === gen) return
    monitoringFetchInFlightGeneration = gen
    void (async () => {
      try {
        const [monResult, connResult] = await Promise.all([
          loadAdminMonitoring(),
          loadAdminConnections(),
        ])
        if (gen !== monitoringGeneration) return
        if (!monResult.ok && monResult.forbidden) {
          // Ролята е отнета междувременно (напр. subadmin revoke-нат, докато
          // е бил на "Сървър") — backend вече отказва; безопасно връщаме UI.
          lobby.forceLeaveAdminScreenForbidden('Достъпът до администраторския панел беше отнет.')
          return
        }
        if (monResult.ok) {
          lobby.setAdminMonitoringSnapshot(monResult.snapshot)
        } else {
          lobby.setAdminMonitoringError(monResult.message)
        }
        if (connResult.ok) {
          lobby.setAdminWsConnections(connResult.result)
        }
      } finally {
        if (monitoringFetchInFlightGeneration === gen) {
          monitoringFetchInFlightGeneration = null
        }
      }
    })()
  }
  runOnePoll(monitoringGeneration)
  monitoringIntervalId = setInterval(() => {
    runOnePoll(monitoringGeneration)
  }, 5_000)
}

function stopMonitoringPolling(): void {
  if (monitoringIntervalId === null) return
  clearInterval(monitoringIntervalId)
  monitoringIntervalId = null
  monitoringGeneration++
  monitoringFetchInFlightGeneration = null
}

// ─── "Информация" family — лек role-check polling (без monitoring/stats заявки) ──
//
// За разлика от "Сървър" (чиито 5s tick-ове и без друго дърпат реални данни,
// така че forbidden се засича като страничен ефект), екраните "Информация"
// (stats/visitors/visitor-sources/payments/payment-detail) нямат собствен
// polling — веднъж заредени, си стоят статично. За да засечем subadmin
// revoke, докато потребителят просто седи на "Информация" без действие,
// пускаме единствено /api/auth/me (вече съществуващ, лек endpoint — само
// session lookup, без stats/monitoring агрегации) на същия 5s интервал.

async function loadCurrentAccountRole(): Promise<{ ok: true; role: string | null } | { ok: false }> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/auth/me`, {
      method: 'GET',
      credentials: 'include',
    })
    const data = await readAuthResponse(response)
    if (!data.ok) return { ok: false }
    return { ok: true, role: data.session?.account.role ?? null }
  } catch {
    return { ok: false }
  }
}

let adminInfoAccessIntervalId: ReturnType<typeof setInterval> | null = null
let adminInfoAccessGeneration = 0
let adminInfoAccessFetchInFlightGeneration: number | null = null

function startAdminInfoAccessPolling(): void {
  if (adminInfoAccessIntervalId !== null) return
  const runOnePoll = (gen: number): void => {
    if (adminInfoAccessFetchInFlightGeneration === gen) return
    adminInfoAccessFetchInFlightGeneration = gen
    void (async () => {
      try {
        const result = await loadCurrentAccountRole()
        // Ако polling-ът е бил спрян/рестартиран междувременно (напр.
        // потребителят вече е напуснал "Информация"), generation-ът вече не
        // съвпада — резултатът е stale, изхвърляме го без да пренасочваме.
        if (gen !== adminInfoAccessGeneration) return
        if (!result.ok) return // мрежова грешка — не е доказателство за отнет достъп
        if (result.role !== 'admin' && result.role !== 'subadmin') {
          lobby.forceLeaveAdminScreenForbidden('Достъпът до администраторския панел беше отнет.')
        }
      } finally {
        if (adminInfoAccessFetchInFlightGeneration === gen) {
          adminInfoAccessFetchInFlightGeneration = null
        }
      }
    })()
  }
  runOnePoll(adminInfoAccessGeneration)
  adminInfoAccessIntervalId = setInterval(() => {
    runOnePoll(adminInfoAccessGeneration)
  }, 5_000)
}

function stopAdminInfoAccessPolling(): void {
  if (adminInfoAccessIntervalId === null) return
  clearInterval(adminInfoAccessIntervalId)
  adminInfoAccessIntervalId = null
  adminInfoAccessGeneration++
  adminInfoAccessFetchInFlightGeneration = null
}

function isFiniteNonNegative(v: unknown): v is number {
  return typeof v === 'number' && isFinite(v) && v >= 0
}

function isFinitePositive(v: unknown): v is number {
  return typeof v === 'number' && isFinite(v) && v > 0
}

function isFiniteNumberOrNull(v: unknown): v is number | null {
  return v === null || (typeof v === 'number' && isFinite(v))
}

function validateHistoryPoint(p: unknown): p is MonitoringHistoryResult['points'][number] {
  if (p === null || typeof p !== 'object') return false
  const r = p as Record<string, unknown>
  return (
    isFinitePositive(r.t) &&
    isFiniteNumberOrNull(r.serverCpu) &&
    isFiniteNumberOrNull(r.nodeCpu) &&
    isFiniteNonNegative(r.ramUsedMb) &&
    isFiniteNonNegative(r.ramPercent) &&
    isFiniteNonNegative(r.rssMb) &&
    isFiniteNonNegative(r.wsConns) &&
    isFiniteNonNegative(r.onlinePlayers) &&
    isFiniteNonNegative(r.activeRooms) &&
    isFiniteNonNegative(r.mmWaiters)
  )
}

function validateHistoryPeaks(pk: unknown): pk is MonitoringHistoryResult['peaks'] {
  if (pk === null || typeof pk !== 'object') return false
  const r = pk as Record<string, unknown>
  return (
    isFiniteNumberOrNull(r.serverCpu) &&
    isFiniteNumberOrNull(r.nodeCpu) &&
    isFiniteNonNegative(r.ramUsedMb) &&
    isFiniteNonNegative(r.ramPercent) &&
    isFiniteNonNegative(r.rssMb) &&
    isFiniteNonNegative(r.wsConns) &&
    isFiniteNonNegative(r.onlinePlayers) &&
    isFiniteNonNegative(r.activeRooms) &&
    isFiniteNonNegative(r.mmWaiters)
  )
}

function validatePeakMoment(m: unknown): m is MonitoringHistoryResult['peakMoments']['wsConns'] {
  if (m === null || typeof m !== 'object') return false
  const r = m as Record<string, unknown>
  return (
    isFiniteNonNegative(r.value) &&
    (r.sampledAt === null || isFinitePositive(r.sampledAt))
  )
}

function validatePeakMoments(pm: unknown): pm is MonitoringHistoryResult['peakMoments'] {
  if (pm === null || typeof pm !== 'object') return false
  const r = pm as Record<string, unknown>
  return (
    validatePeakMoment(r.wsConns) &&
    validatePeakMoment(r.onlinePlayers) &&
    validatePeakMoment(r.activeRooms) &&
    validatePeakMoment(r.mmWaiters)
  )
}

async function loadAdminMonitoringHistory(
  window: HistoryWindow,
  signal: AbortSignal,
): Promise<{ ok: true; result: MonitoringHistoryResult } | { ok: false; message: string }> {
  try {
    const response = await fetch(
      `${getApiBaseUrl()}/api/admin/monitoring/history?window=${encodeURIComponent(window)}`,
      { method: 'GET', credentials: 'include', signal },
    )
    if (response.status === 403) {
      return { ok: false, message: 'Нямаш достъп до мониторинга.' }
    }
    if (response.status === 503) {
      return { ok: false, message: 'Историята временно не е налична.' }
    }
    const data = (await response.json()) as Record<string, unknown>
    if (!response.ok || data.ok !== true) {
      const msg = typeof data.message === 'string' ? data.message : 'Грешка при зареждане на историята.'
      return { ok: false, message: msg }
    }
    if (!isValidHistoryWindow(data.window)) {
      return { ok: false, message: 'Невалиден формат на историята.' }
    }
    if (!Array.isArray(data.points)) {
      return { ok: false, message: 'Невалиден формат на историята.' }
    }
    for (const pt of data.points) {
      if (!validateHistoryPoint(pt)) {
        return { ok: false, message: 'Невалиден формат на историята.' }
      }
    }
    if (!validateHistoryPeaks(data.peaks)) {
      return { ok: false, message: 'Невалиден формат на историята.' }
    }
    if (!validatePeakMoments(data.peakMoments)) {
      return { ok: false, message: 'Невалиден формат на историята.' }
    }
    const result: MonitoringHistoryResult = {
      window: data.window,
      points: data.points,
      peaks: data.peaks as MonitoringHistoryResult['peaks'],
      peakMoments: data.peakMoments as MonitoringHistoryResult['peakMoments'],
    }
    return { ok: true, result }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { ok: false, message: '__aborted__' }
    }
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

let historyGeneration = 0
let historyAbortController: AbortController | null = null

function fetchAdminHistory(window: HistoryWindow): void {
  const gen = historyGeneration
  // set loading synchronously before the first render — no blank intermediate frame
  lobby.setAdminHistoryLoading(true)
  const controller = new AbortController()
  historyAbortController = controller
  void (async () => {
    try {
      const result = await loadAdminMonitoringHistory(window, controller.signal)
      if (gen !== historyGeneration) return
      if (!result.ok && result.message === '__aborted__') return
      if (result.ok) {
        lobby.setAdminHistoryResult(result.result)
      } else {
        lobby.setAdminHistoryError(result.message)
      }
    } finally {
      if (historyAbortController === controller) {
        historyAbortController = null
      }
    }
  })()
}

function invalidateHistoryGeneration(): void {
  historyGeneration++
  if (historyAbortController !== null) {
    historyAbortController.abort()
    historyAbortController = null
  }
}

async function markAdminGuestContactMessageRead(messageId: string): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const response = await fetch(
      `${getApiBaseUrl()}/api/admin/guest-contact/messages/${encodeURIComponent(messageId)}/read`,
      { method: 'PATCH', credentials: 'include' },
    )
    const data = (await response.json()) as { ok: boolean; message?: string }
    if (!response.ok || !data.ok) {
      return { ok: false, message: data.message ?? 'Съобщението не беше маркирано като прочетено.' }
    }
    return { ok: true }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function loadAdminSupportMessages(profileId: string): Promise<
  | { ok: true; messages: SupportMessageSnapshot[] }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(
      `${getApiBaseUrl()}/api/support/admin/messages/${encodeURIComponent(profileId)}`,
      { method: 'GET', credentials: 'include' },
    )
    const data = (await response.json()) as SupportMessagesApiResponse
    if (!response.ok || !data.ok || !Array.isArray(data.messages)) {
      return { ok: false, message: data.message ?? 'Грешка при зареждане.' }
    }
    return { ok: true, messages: data.messages }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function sendAdminSupportReply(profileId: string, body: string, imageDataUrl?: string | null): Promise<
  | { ok: true; messages: SupportMessageSnapshot[] }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/support/admin/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ profileId, body, ...(imageDataUrl ? { imageDataUrl } : {}) }),
    })
    const data = (await response.json()) as SupportMessagesApiResponse
    if (!response.ok || !data.ok || !Array.isArray(data.messages)) {
      return { ok: false, message: data.message ?? 'Грешка при изпращане.' }
    }
    return { ok: true, messages: data.messages }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function deleteUserSupportConversation(): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/support/messages`, {
      method: 'DELETE',
      credentials: 'include',
    })
    const data = (await response.json()) as { ok: boolean; message?: string }
    if (!response.ok || !data.ok) {
      return { ok: false, message: data.message ?? 'Грешка при изтриване.' }
    }
    return { ok: true }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function archiveAdminSupportConversation(profileId: string): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const response = await fetch(
      `${getApiBaseUrl()}/api/support/admin/conversations/${encodeURIComponent(profileId)}/archive`,
      { method: 'POST', credentials: 'include' },
    )
    const data = (await response.json()) as { ok: boolean; message?: string }
    if (!response.ok || !data.ok) {
      return { ok: false, message: data.message ?? 'Грешка при архивиране.' }
    }
    return { ok: true }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function submitProfileLike(
  profileId: string,
): Promise<{ ok: true; liked: boolean; likesCount: number } | { ok: false }> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/profiles/${encodeURIComponent(profileId)}/like`, {
      method: 'POST',
      credentials: 'include',
    })
    const data = (await response.json()) as { ok: boolean; liked?: boolean; likesCount?: number }
    if (data.ok && typeof data.liked === 'boolean' && typeof data.likesCount === 'number') {
      return { ok: true, liked: data.liked, likesCount: data.likesCount }
    }
    return { ok: false }
  } catch {
    return { ok: false }
  }
}

type GiftCoinsSubmitResult =
  | {
      ok: true
      senderProfile: PlayerPublicProfileSnapshot
      recipientProfile: PlayerPublicProfileSnapshot
      pikaTeamDailyGiftLimitStatus?: { limit: number; used: number; remaining: number }
    }
  | ({ ok: false; message: string } & GiftLimitErrorPayload)
  | {
      ok: false
      message: string
      code: 'PIKA_TEAM_DAILY_GIFT_LIMIT_EXCEEDED'
      limit: number
      used: number
      remaining: number
    }
  | { ok: false; message: string }

// Общо ядро за submitGiftCoins/submitGiftCoinsBypass по-долу — идентична
// fetch/response обработка и за двата gift endpoint-а (нормален friend gift
// и pika_team direct bypass), различава се само URL-ът и request body-то.
async function submitGiftCoinsToUrl(url: string, requestBody: Record<string, unknown>, amount: number): Promise<GiftCoinsSubmitResult> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'include',
      body: JSON.stringify(requestBody),
    })
    const data = (await response.json()) as GiftCoinsResponse

    if (!response.ok || !data.ok || !data.senderProfile || !data.recipientProfile) {
      if (
        data.code === 'RECIPIENT_WINDOW_LIMIT_PARTIAL' ||
        data.code === 'RECIPIENT_WINDOW_LIMIT_FULL'
      ) {
        return {
          ok: false,
          message: data.message ?? 'Лимитът е достигнат.',
          code: data.code,
          receivedInWindow: data.receivedInWindow ?? 0,
          remainingAllowance: data.remainingAllowance ?? 0,
          attemptedAmount: data.attemptedAmount ?? amount,
          nextReleaseAt: data.nextReleaseAt ?? null,
          nextReleaseAmount: data.nextReleaseAmount ?? 0,
        }
      }
      if (data.code === 'PIKA_TEAM_DAILY_GIFT_LIMIT_EXCEEDED') {
        // Синхронизира stale modal informational status (limit/used/
        // remaining) от fresh server error payload — server е authoritative
        // gate за самия enforcement, а cached remaining в client state никога
        // не е блокирал request-а (виж gift form submit handler-а,
        // renderLobbyScreen.ts); тук само обновяваме показаните на
        // потребителя стойности след отказ, за да не остане stale след
        // Admin decrease. saveSessionCache directly (не syncLobbyWithAuthSession)
        // — избягва двоен render() в рамките на един gift attempt:
        // syncLobbyWithAuthSession() вика setDisplayName/setLocalAvatarUrl,
        // които ВИНАГИ render-ват вътрешно (createLobbyFlowController.ts),
        // а submitGiftCoinsCore вече ще извика render() веднага след като
        // получи този резултат обратно — displayName/avatarUrl не се
        // променят от gift response-а, значи няма нужда от техния sync тук.
        if (currentAuthSession !== null) {
          currentAuthSession = {
            ...currentAuthSession,
            pikaTeamDailyGiftLimitStatus: {
              limit: data.limit ?? 0,
              used: data.used ?? 0,
              remaining: data.remaining ?? 0,
            },
          }
          saveSessionCache(currentAuthSession)
        }

        return {
          ok: false,
          message: data.message ?? 'Достигнат е дневният лимит за подаряване на жълтици.',
          code: data.code,
          limit: data.limit ?? 0,
          used: data.used ?? 0,
          remaining: data.remaining ?? 0,
        }
      }
      return {
        ok: false,
        message: data.message ?? 'Подаръкът не беше изпратен.',
      }
    }

    if (currentAuthSession !== null) {
      currentAuthSession = {
        ...currentAuthSession,
        profile: data.senderProfile,
        // Informational refresh (limit/used/remaining) без глобален
        // rerender/session reload — виж CLAUDE.md "Profile gift UI".
        // undefined (не pika_team sender) оставя предишната стойност
        // непроменена, вместо да я изтрие.
        ...(data.pikaTeamDailyGiftLimitStatus !== undefined
          ? { pikaTeamDailyGiftLimitStatus: data.pikaTeamDailyGiftLimitStatus }
          : {}),
      }
      // saveSessionCache directly (не syncLobbyWithAuthSession) — избягва
      // двоен render() в рамките на един gift attempt (виж коментара на
      // PIKA_TEAM_DAILY_GIFT_LIMIT_EXCEEDED error branch-а по-горе за
      // пълния rationale). submitGiftCoinsCore вика render() веднага след
      // като получи този резултат обратно.
      saveSessionCache(currentAuthSession)
    }

    return {
      ok: true,
      senderProfile: data.senderProfile,
      recipientProfile: data.recipientProfile,
      pikaTeamDailyGiftLimitStatus: data.pikaTeamDailyGiftLimitStatus,
    }
  } catch {
    return {
      ok: false,
      message: 'Няма връзка със сървъра за подарък.',
    }
  }
}

async function submitGiftCoins(friendshipId: string, amount: number): Promise<GiftCoinsSubmitResult> {
  return submitGiftCoinsToUrl(
    `${getApiBaseUrl()}/api/friends/${encodeURIComponent(friendshipId)}/gift-coins`,
    { amount },
    amount,
  )
}

// pika_team friendship-gate bypass — mirror на submitGiftCoins по-горе,
// единствената разлика е endpoint-ът (/direct, адресиран по profileId
// вместо friendshipId) и че getSession auth-ва вместо friendship row.
// Server-side authoritative gate: isPikaTeamGiftFriendshipBypassSession
// (server/src/db/authStore.ts) — 403 за всеки session, който не е
// role='pika_team'.
async function submitGiftCoinsBypass(recipientProfileId: string, amount: number): Promise<GiftCoinsSubmitResult> {
  return submitGiftCoinsToUrl(
    `${getApiBaseUrl()}/api/friends/gift-coins/direct`,
    { recipientProfileId, amount },
    amount,
  )
}

async function fileToDataUrl(file: File): Promise<string> {
  return await readProfileImageFileAsDataUrl(file)
}

async function resizeImageToDataUrl(
  file: File,
  maxSize: number,
  quality: number,
): Promise<{ dataUrl: string; scale: number }> {
  const rawDataUrl = await fileToDataUrl(file)

  return await new Promise((resolve, reject) => {
    const img = new Image()
    img.addEventListener('error', () => reject(new Error('Снимката не можа да бъде заредена.')))
    img.addEventListener('load', () => {
      const scale = Math.min(1, maxSize / Math.max(img.naturalWidth, img.naturalHeight))
      const w = Math.round(img.naturalWidth * scale)
      const h = Math.round(img.naturalHeight * scale)

      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        resolve({ dataUrl: rawDataUrl, scale: 1 })
        return
      }
      ctx.drawImage(img, 0, 0, w, h)
      resolve({ dataUrl: canvas.toDataURL('image/jpeg', quality), scale })
    })
    img.src = rawDataUrl
  })
}

async function imageFileToServerUploadDataUrl(
  file: File,
  _options: { mode: 'gallery' },
): Promise<string> {
  const { dataUrl } = await resizeImageToDataUrl(file, 1600, 0.85)
  return dataUrl
}

async function submitProfileImageData(
  targetProfileId: string | null,
  endpoint: 'avatar' | 'gallery',
  imageDataUrl: string,
  crop?: AvatarCropSelection,
): Promise<AuthResponse> {
  const path = targetProfileId === null
    ? `/api/profile/me/${endpoint}`
    : `/api/admin/profiles/${encodeURIComponent(targetProfileId)}/${endpoint}`
  const response = await fetch(`${getApiBaseUrl()}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'include',
    body: JSON.stringify({
      imageDataUrl,
      ...(crop
        ? {
            cropX: crop.x,
            cropY: crop.y,
            cropSize: crop.size,
          }
        : {}),
    }),
  })
  const data = targetProfileId === null
    ? await readAuthResponse(response)
    : ((await response.json().catch(() => ({ ok: false, message: 'Невалиден отговор от сървъра.' }))) as AdminProfileResponse)

  if (!response.ok || !data.ok || (targetProfileId === null && !(data as AuthResponse).session)) {
    throw new Error(data.message ?? 'Профилът не беше обновен.')
  }

  return data as AuthResponse
}

async function deleteProfileGalleryImage(targetProfileId: string | null, imageId: string): Promise<string | null> {
  try {
    const path = targetProfileId === null
      ? `/api/profile/me/gallery/${encodeURIComponent(imageId)}`
      : `/api/admin/profiles/${encodeURIComponent(targetProfileId)}/gallery/${encodeURIComponent(imageId)}`
    const response = await fetch(
      `${getApiBaseUrl()}${path}`,
      {
        method: 'DELETE',
        credentials: 'include',
      },
    )
    const data = targetProfileId === null
      ? await readAuthResponse(response)
      : ((await response.json().catch(() => ({ ok: false, message: 'Невалиден отговор от сървъра.' }))) as AdminProfileResponse)

    if (!response.ok || !data.ok || (targetProfileId === null && !(data as AuthResponse).session)) {
      return data.message ?? 'Снимката не беше изтрита.'
    }

    if (targetProfileId === null) {
      currentAuthSession = (data as AuthResponse).session ?? currentAuthSession
      syncLobbyWithAuthSession()
    }
    return null
  } catch {
    return 'Няма връзка със сървъра за профили.'
  }
}

async function submitPresetAvatarUrl(targetProfileId: string | null, avatarUrl: string): Promise<string | null> {
  try {
    const path = targetProfileId === null
      ? '/api/profile/me'
      : `/api/admin/profiles/${encodeURIComponent(targetProfileId)}/avatar`
    const response = await fetch(`${getApiBaseUrl()}${path}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ avatarUrl }),
    })
    const data = targetProfileId === null
      ? await readAuthResponse(response)
      : ((await response.json().catch(() => ({ ok: false, message: 'Невалиден отговор от сървъра.' }))) as AdminProfileResponse)

    if (!response.ok || !data.ok || (targetProfileId === null && !(data as AuthResponse).session)) {
      return data.message ?? 'Аватарът не беше обновен.'
    }

    if (targetProfileId === null) {
      currentAuthSession = (data as AuthResponse).session ?? currentAuthSession
      syncLobbyWithAuthSession()
    }
    return null
  } catch {
    return 'Няма връзка със сървъра.'
  }
}

async function submitProfileNameChange(targetProfileId: string | null, displayName: string): Promise<string | null> {
  const validation = validateProfileDisplayName(displayName, {
    profileId: targetProfileId ?? currentAuthSession?.profile.profileId ?? null,
  })
  if (!validation.ok) {
    return validation.message
  }

  try {
    const path = targetProfileId === null
      ? '/api/profile/me/display-name'
      : `/api/admin/profiles/${encodeURIComponent(targetProfileId)}/display-name`
    const response = await fetch(`${getApiBaseUrl()}${path}`, {
      method: targetProfileId === null ? 'POST' : 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'include',
      body: JSON.stringify({ displayName: validation.canonicalDisplayName }),
    })
    const data = targetProfileId === null
      ? await readAuthResponse(response)
      : ((await response.json().catch(() => ({ ok: false, message: 'Невалиден отговор от сървъра.' }))) as AdminProfileResponse)

    if (!response.ok || !data.ok || (targetProfileId === null && !(data as AuthResponse).session)) {
      return data.message ?? 'Името не беше сменено.'
    }

    if (targetProfileId === null) {
      currentAuthSession = (data as AuthResponse).session ?? currentAuthSession
      syncLobbyWithAuthSession()
    }
    return null
  } catch {
    return 'Няма връзка със сървъра за смяна на име.'
  }
}

async function loadAdminTargetRole(
  profileId: string,
): Promise<{ ok: true; role: PlayerAccountRole | null } | { ok: false; message: string }> {
  try {
    const response = await fetch(
      `${getApiBaseUrl()}/api/admin/profiles/${encodeURIComponent(profileId)}/subadmin`,
      { method: 'GET', credentials: 'include' },
    )
    if (response.status === 403) {
      return { ok: false, message: 'Нямаш достъп.' }
    }
    const data = (await response.json().catch(() => ({}))) as { ok?: boolean; role?: PlayerAccountRole | null; message?: string }
    if (!response.ok || !data.ok) {
      return { ok: false, message: data.message ?? 'Ролята не можа да бъде заредена.' }
    }
    return { ok: true, role: data.role ?? null }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function adminGrantVip(
  targetProfileId: string,
  days: number,
): Promise<{ ok: true; profile: PlayerPublicProfileSnapshot } | { ok: false; message: string }> {
  try {
    const response = await fetch(
      `${getApiBaseUrl()}/api/admin/profiles/${encodeURIComponent(targetProfileId)}/vip-grant`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ days }),
      },
    )
    const data = (await response.json().catch(() => ({ ok: false, message: 'Невалиден отговор от сървъра.' }))) as AdminProfileResponse
    if (!response.ok || !data.ok || !data.profile) {
      return { ok: false, message: data.message ?? 'VIP не беше даден.' }
    }
    return { ok: true, profile: data.profile }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function adminGetActiveBan(
  targetProfileId: string,
): Promise<{ ok: true; activeBan: ActiveProfileBanSnapshot | null } | { ok: false; message: string }> {
  try {
    const response = await fetch(
      `${getApiBaseUrl()}/api/admin/profiles/${encodeURIComponent(targetProfileId)}/ban`,
      { method: 'GET', credentials: 'include' },
    )
    const data = (await response.json().catch(() => ({}))) as { ok?: boolean; activeBan?: ActiveProfileBanSnapshot | null; message?: string }
    if (!response.ok || !data.ok) {
      return { ok: false, message: data.message ?? 'Не успяхме да заредим бан статуса.' }
    }
    return { ok: true, activeBan: data.activeBan ?? null }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function adminBanProfile(
  targetProfileId: string,
  days: number,
  reason: string,
): Promise<{ ok: true; ban: ActiveProfileBanSnapshot } | { ok: false; message: string }> {
  try {
    const response = await fetch(
      `${getApiBaseUrl()}/api/admin/profiles/${encodeURIComponent(targetProfileId)}/ban`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ days, reason }),
      },
    )
    const data = (await response.json().catch(() => ({}))) as { ok?: boolean; ban?: ActiveProfileBanSnapshot; message?: string }
    if (!response.ok || !data.ok || !data.ban) {
      return { ok: false, message: data.message ?? 'Банът не беше приложен.' }
    }
    return { ok: true, ban: data.ban }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function adminUnbanProfile(
  targetProfileId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const response = await fetch(
      `${getApiBaseUrl()}/api/admin/profiles/${encodeURIComponent(targetProfileId)}/ban`,
      { method: 'DELETE', credentials: 'include' },
    )
    const data = (await response.json().catch(() => ({}))) as { ok?: boolean; message?: string }
    if (!response.ok || !data.ok) {
      return { ok: false, message: data.message ?? 'Банът не беше премахнат.' }
    }
    return { ok: true }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function adminHardDeleteProfile(
  targetProfileId: string,
  reason: string,
  supportRequestMessageId?: string | null,
): Promise<{ ok: true } | { ok: false; message: string; code?: string }> {
  try {
    const response = await fetch(
      `${getApiBaseUrl()}/api/admin/profiles/${encodeURIComponent(targetProfileId)}`,
      {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(
          supportRequestMessageId ? { reason, supportRequestMessageId } : { reason },
        ),
      },
    )
    const data = (await response.json().catch(() => ({}))) as { ok?: boolean; message?: string; code?: string }
    if (!response.ok || !data.ok) {
      return { ok: false, message: data.message ?? 'Профилът не беше изтрит.', code: data.code }
    }
    return { ok: true }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function loadOwnVipStatus(): Promise<{ ok: true; activeUntil: string | null } | { ok: false }> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/vip/status`, {
      method: 'GET',
      credentials: 'include',
    })
    const data = (await response.json().catch(() => ({}))) as {
      ok?: boolean
      status?: { isActive?: boolean; activeUntil?: string | null }
    }
    if (!response.ok || !data.ok) {
      return { ok: false }
    }
    return { ok: true, activeUntil: data.status?.activeUntil ?? null }
  } catch {
    return { ok: false }
  }
}

async function submitSubadminRoleChange(
  profileId: string,
  action: 'grant' | 'revoke',
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const response = await fetch(
      `${getApiBaseUrl()}/api/admin/profiles/${encodeURIComponent(profileId)}/subadmin`,
      { method: action === 'grant' ? 'POST' : 'DELETE', credentials: 'include' },
    )
    const data = (await response.json().catch(() => ({}))) as { ok?: boolean; message?: string }
    if (!response.ok || !data.ok) {
      return { ok: false, message: data.message ?? 'Действието не бе завършено.' }
    }
    return { ok: true }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

/** Огледално на submitSubadminRoleChange, за chat_admin роля. */
async function submitChatAdminRoleChange(
  profileId: string,
  action: 'grant' | 'revoke',
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const response = await fetch(
      `${getApiBaseUrl()}/api/admin/profiles/${encodeURIComponent(profileId)}/chat-admin`,
      { method: action === 'grant' ? 'POST' : 'DELETE', credentials: 'include' },
    )
    const data = (await response.json().catch(() => ({}))) as { ok?: boolean; message?: string }
    if (!response.ok || !data.ok) {
      return { ok: false, message: data.message ?? 'Действието не бе завършено.' }
    }
    return { ok: true }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function submitPikaTeamRoleChange(
  profileId: string,
  action: 'grant' | 'revoke',
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const response = await fetch(
      `${getApiBaseUrl()}/api/admin/profiles/${encodeURIComponent(profileId)}/pika-team`,
      { method: action === 'grant' ? 'POST' : 'DELETE', credentials: 'include' },
    )
    const data = (await response.json().catch(() => ({}))) as { ok?: boolean; message?: string }
    if (!response.ok || !data.ok) {
      return { ok: false, message: data.message ?? 'Действието не бе завършено.' }
    }
    return { ok: true }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function submitTopChatAdminRoleChange(
  profileId: string,
  action: 'grant' | 'revoke',
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const response = await fetch(
      `${getApiBaseUrl()}/api/admin/profiles/${encodeURIComponent(profileId)}/top-chat-admin`,
      { method: action === 'grant' ? 'POST' : 'DELETE', credentials: 'include' },
    )
    const data = (await response.json().catch(() => ({}))) as { ok?: boolean; message?: string }
    if (!response.ok || !data.ok) {
      return { ok: false, message: data.message ?? 'Действието не бе завършено.' }
    }
    return { ok: true }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function submitChangePassword(
  currentPassword: string,
  newPassword: string,
): Promise<string | null> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/account/change-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ currentPassword, newPassword }),
    })
    const data = (await response.json().catch(() => ({}))) as { ok?: boolean; message?: string }
    if (!response.ok || !data.ok) {
      return data.message ?? 'Паролата не беше сменена.'
    }
    return null
  } catch {
    return 'Няма връзка със сървъра.'
  }
}

async function submitProfileUpdate(
  targetProfileId: string | null,
  avatarFile: File | null,
  avatarCrop: AvatarCropSelection | null,
  galleryFiles: File[],
): Promise<string | null> {
  if (avatarFile === null && galleryFiles.length === 0) {
    return null
  }

  try {
    const currentGalleryCount = targetProfileId === null
      ? currentAuthSession?.profile.galleryImages.length ?? 0
      : 0
    const remainingGallerySlots = Math.max(
      0,
      MAX_PROFILE_GALLERY_IMAGES - currentGalleryCount,
    )

    if (targetProfileId !== null && galleryFiles.length > 0) {
      return 'Администраторската редакция позволява само изтриване на снимки от галерията.'
    }

    if (galleryFiles.length > remainingGallerySlots) {
      return `Галерията може да има най-много ${MAX_PROFILE_GALLERY_IMAGES} снимки.`
    }

    if (avatarFile !== null) {
      if (avatarCrop === null) {
        return 'Очертай квадрат върху снимката за аватар.'
      }

      const { dataUrl: avatarDataUrl, scale: avatarScale } = await resizeImageToDataUrl(avatarFile, 1200, 0.88)
      const scaledCrop: AvatarCropSelection = {
        x: Math.round(avatarCrop.x * avatarScale),
        y: Math.round(avatarCrop.y * avatarScale),
        size: Math.round(avatarCrop.size * avatarScale),
      }
      const data = await submitProfileImageData(targetProfileId, 'avatar', avatarDataUrl, scaledCrop)
      if (targetProfileId === null) currentAuthSession = data.session ?? currentAuthSession
    }

    for (const galleryFile of galleryFiles.slice(0, remainingGallerySlots)) {
      const imageDataUrl = await imageFileToServerUploadDataUrl(galleryFile, {
        mode: 'gallery',
      })
      const data = await submitProfileImageData(null, 'gallery', imageDataUrl)
      currentAuthSession = data.session ?? currentAuthSession
    }

    if (targetProfileId === null) syncLobbyWithAuthSession()
    return null
  } catch (error) {
    return error instanceof Error
      ? error.message
      : 'Няма връзка със сървъра за профили.'
  }
}

async function loadDailyMissions(): Promise<
  | { ok: true; missions: PlayerMissionProgressSnapshot[]; unclaimedCount: number; date: string }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/missions/daily`, {
      method: 'GET',
      credentials: 'include',
    })
    const data = (await response.json()) as DailyMissionsApiResponse

    if (!response.ok || !data.ok || !Array.isArray(data.missions)) {
      return { ok: false, message: data.message ?? 'Мисиите не бяха заредени.' }
    }

    return { ok: true, missions: data.missions, unclaimedCount: data.unclaimedCount ?? 0, date: data.date ?? '' }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра за мисии.' }
  }
}

async function claimMissionReward(missionId: string): Promise<
  | { ok: true; rewardYellowCoins: number; missions: PlayerMissionProgressSnapshot[]; unclaimedCount: number }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(
      `${getApiBaseUrl()}/api/missions/${encodeURIComponent(missionId)}/claim`,
      { method: 'POST', credentials: 'include' },
    )
    const data = (await response.json()) as DailyMissionsApiResponse

    if (!response.ok || !data.ok || !Array.isArray(data.missions)) {
      return { ok: false, message: data.message ?? 'Наградата не беше взета.' }
    }

    if (currentAuthSession !== null && typeof data.rewardYellowCoins === 'number') {
      currentAuthSession = {
        ...currentAuthSession,
        profile: {
          ...currentAuthSession.profile,
          yellowCoinsBalance:
            (currentAuthSession.profile.yellowCoinsBalance ?? 0) + data.rewardYellowCoins,
        },
      }
      syncLobbyWithAuthSession()
    }

    return {
      ok: true,
      rewardYellowCoins: data.rewardYellowCoins ?? 0,
      missions: data.missions,
      unclaimedCount: data.unclaimedCount ?? 0,
    }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра за вземане на награда.' }
  }
}

type AdminMissionsBothLists = { activeMissions: MissionTemplateSnapshot[]; stagedMissions: MissionTemplateSnapshot[] }

async function loadAdminMissions(): Promise<
  | ({ ok: true } & AdminMissionsBothLists)
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/admin/missions`, {
      method: 'GET',
      credentials: 'include',
    })
    const data = (await response.json()) as AdminMissionsApiResponse

    if (!response.ok || !data.ok || !Array.isArray(data.activeMissions) || !Array.isArray(data.stagedMissions)) {
      return { ok: false, message: data.message ?? 'Мисиите не бяха заредени.' }
    }

    return { ok: true, activeMissions: data.activeMissions, stagedMissions: data.stagedMissions }
  } catch {
    return { ok: false, message: 'Няма връзка.' }
  }
}

async function submitAdminMission(
  input: MissionTemplateInput,
): Promise<({ ok: true } & AdminMissionsBothLists) | { ok: false; message: string }> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/admin/missions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(input),
    })
    const data = (await response.json()) as AdminMissionsApiResponse

    if (!response.ok || !data.ok || !Array.isArray(data.activeMissions) || !Array.isArray(data.stagedMissions)) {
      return { ok: false, message: data.message ?? 'Мисията не беше записана.' }
    }

    return { ok: true, activeMissions: data.activeMissions, stagedMissions: data.stagedMissions }
  } catch {
    return { ok: false, message: 'Няма връзка.' }
  }
}

async function setAdminMissionActive(
  missionId: string,
  isActive: boolean,
): Promise<({ ok: true } & AdminMissionsBothLists) | { ok: false; message: string }> {
  try {
    const response = await fetch(
      `${getApiBaseUrl()}/api/admin/missions/${encodeURIComponent(missionId)}/active`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ isActive }),
      },
    )
    const data = (await response.json()) as AdminMissionsApiResponse

    if (!response.ok || !data.ok || !Array.isArray(data.activeMissions) || !Array.isArray(data.stagedMissions)) {
      return { ok: false, message: data.message ?? 'Активността не беше променена.' }
    }

    return { ok: true, activeMissions: data.activeMissions, stagedMissions: data.stagedMissions }
  } catch {
    return { ok: false, message: 'Няма връзка.' }
  }
}

async function deleteAdminMission(
  missionId: string,
): Promise<({ ok: true } & AdminMissionsBothLists) | { ok: false; message: string }> {
  try {
    const response = await fetch(
      `${getApiBaseUrl()}/api/admin/missions/${encodeURIComponent(missionId)}`,
      { method: 'DELETE', credentials: 'include' },
    )
    const data = (await response.json()) as AdminMissionsApiResponse

    if (!response.ok || !data.ok || !Array.isArray(data.activeMissions) || !Array.isArray(data.stagedMissions)) {
      return { ok: false, message: data.message ?? 'Мисията не беше изтрита.' }
    }

    return { ok: true, activeMissions: data.activeMissions, stagedMissions: data.stagedMissions }
  } catch {
    return { ok: false, message: 'Няма връзка.' }
  }
}

type MatchRoomsApiResponse = { ok: boolean; rooms?: MatchRoomSnapshot[]; message?: string }

async function loadMatchRooms(): Promise<{ ok: true; rooms: MatchRoomSnapshot[] } | { ok: false; message: string }> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/rooms`, { credentials: 'include' })
    const data = (await response.json()) as MatchRoomsApiResponse
    if (!response.ok || !data.ok || !Array.isArray(data.rooms)) {
      return { ok: false, message: data.message ?? 'Стаите не бяха заредени.' }
    }
    return { ok: true, rooms: data.rooms }
  } catch {
    return { ok: false, message: 'Няма връзка.' }
  }
}

async function upsertAdminMatchRoom(
  room: { stakeAmount: number; minLevel: number; prizeAmount: number; isEnabled: boolean },
): Promise<{ ok: true; rooms: MatchRoomSnapshot[] } | { ok: false; message: string }> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/admin/rooms`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(room),
    })
    const data = (await response.json()) as MatchRoomsApiResponse
    if (!response.ok || !data.ok || !Array.isArray(data.rooms)) {
      return { ok: false, message: data.message ?? 'Записът не беше успешен.' }
    }
    return { ok: true, rooms: data.rooms }
  } catch {
    return { ok: false, message: 'Няма връзка.' }
  }
}

async function deleteAdminMatchRoom(
  stakeAmount: number,
): Promise<{ ok: true; rooms: MatchRoomSnapshot[] } | { ok: false; message: string }> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/admin/rooms/${stakeAmount}`, {
      method: 'DELETE',
      credentials: 'include',
    })
    const data = (await response.json()) as MatchRoomsApiResponse
    if (!response.ok || !data.ok || !Array.isArray(data.rooms)) {
      return { ok: false, message: data.message ?? 'Изтриването не беше успешно.' }
    }
    return { ok: true, rooms: data.rooms }
  } catch {
    return { ok: false, message: 'Няма връзка.' }
  }
}

async function loadProfileById(
  profileId: string,
): Promise<
  | { ok: true; profile: PlayerPublicProfileSnapshot }
  | { ok: false; message: string; code?: 'profile_blocked_by_viewer' | 'profile_blocked_viewer' }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/profiles/${encodeURIComponent(profileId)}`, {
      method: 'GET',
      credentials: 'include',
    })
    const data = (await response.json()) as {
      ok: boolean
      message?: string
      profile?: PlayerPublicProfileSnapshot
      code?: 'profile_blocked_by_viewer' | 'profile_blocked_viewer'
    }
    if (!response.ok && (data.code === 'profile_blocked_by_viewer' || data.code === 'profile_blocked_viewer')) {
      return { ok: false, message: data.message ?? 'Профилът не е достъпен.', code: data.code }
    }
    if (!response.ok || !data.ok || !data.profile) {
      return { ok: false, message: data.message ?? 'Профилът не беше зареден.' }
    }
    return { ok: true, profile: data.profile }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function loadTopics(): Promise<
  | { ok: true; topics: TopicSnapshot[]; viewerSectionMute: { isMuted: boolean; mutedUntil: string | null; reason: string | null } | null }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/topics`, {
      method: 'GET',
      credentials: 'include',
    })
    const data = (await response.json()) as {
      ok: boolean
      message?: string
      topics?: TopicSnapshot[]
      viewerSectionMute?: { isMuted: boolean; mutedUntil: string | null; reason: string | null }
    }
    if (!response.ok || !data.ok || !Array.isArray(data.topics)) {
      return { ok: false, message: data.message ?? 'Грешка при зареждане на темите.' }
    }
    return { ok: true, topics: data.topics, viewerSectionMute: data.viewerSectionMute ?? null }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function loadTopicMessages(
  topicId: string,
  beforeSeq: number | null,
): Promise<
  | { ok: true; messages: TopicMessageSnapshot[]; hasMore: boolean; oldestSeq: number | null }
  | { ok: false; message: string }
> {
  try {
    const qs = new URLSearchParams()
    if (beforeSeq !== null) qs.set('before', String(beforeSeq))
    const response = await fetch(
      `${getApiBaseUrl()}/api/topics/${encodeURIComponent(topicId)}/messages?${qs.toString()}`,
      { method: 'GET', credentials: 'include' },
    )
    const data = (await response.json()) as {
      ok: boolean
      message?: string
      messages?: TopicMessageSnapshot[]
      hasMore?: boolean
      oldestSeq?: number | null
    }
    if (!response.ok || !data.ok || !Array.isArray(data.messages)) {
      return { ok: false, message: data.message ?? 'Грешка при зареждане на съобщенията.' }
    }
    return {
      ok: true,
      messages: data.messages,
      hasMore: data.hasMore ?? false,
      oldestSeq: data.oldestSeq ?? null,
    }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function markTopicSeen(
  topicId: string,
): Promise<{ ok: true; lastSeenSeq: number; unreadCount: number } | { ok: false; message: string }> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/topics/${encodeURIComponent(topicId)}/seen`, {
      method: 'POST',
      credentials: 'include',
    })
    const data = (await response.json().catch(() => ({}))) as {
      ok?: boolean
      message?: string
      lastSeenSeq?: number
      unreadCount?: number
    }
    if (!response.ok || !data.ok || typeof data.lastSeenSeq !== 'number') {
      return { ok: false, message: data.message ?? 'Грешка при отбелязване на темата като прочетена.' }
    }
    return { ok: true, lastSeenSeq: data.lastSeenSeq, unreadCount: data.unreadCount ?? 0 }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function markTopicThreadSeen(
  topicId: string,
  rootMessageId: string,
): Promise<
  | { ok: true; lastSeenSeq: number; unreadCount: number; topicUnreadCount: number }
  | { ok: false; message: string }
> {
  try {
    const response = await fetch(
      `${getApiBaseUrl()}/api/topics/${encodeURIComponent(topicId)}/messages/${encodeURIComponent(rootMessageId)}/seen`,
      {
        method: 'POST',
        credentials: 'include',
      },
    )
    const data = (await response.json().catch(() => ({}))) as {
      ok?: boolean
      message?: string
      lastSeenSeq?: number
      unreadCount?: number
      topicUnreadCount?: number
    }
    if (!response.ok || !data.ok || typeof data.lastSeenSeq !== 'number') {
      return { ok: false, message: data.message ?? 'Грешка при отбелязване на разговора като прочетен.' }
    }
    return {
      ok: true,
      lastSeenSeq: data.lastSeenSeq,
      unreadCount: data.unreadCount ?? 0,
      topicUnreadCount: data.topicUnreadCount ?? 0,
    }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function loadTopicReplies(
  topicId: string,
  rootMessageId: string,
  afterSeq: number | null,
): Promise<
  | { ok: true; replies: TopicReplySnapshot[]; hasMore: boolean; oldestSeq: number | null; deletedMessageIds: string[] }
  | { ok: false; message: string }
> {
  try {
    const qs = new URLSearchParams()
    if (afterSeq !== null) qs.set('after', String(afterSeq))
    const response = await fetch(
      `${getApiBaseUrl()}/api/topics/${encodeURIComponent(topicId)}/messages/${encodeURIComponent(rootMessageId)}/replies?${qs.toString()}`,
      { method: 'GET', credentials: 'include' },
    )
    const data = (await response.json()) as {
      ok: boolean
      message?: string
      replies?: TopicReplySnapshot[]
      hasMore?: boolean
      oldestSeq?: number | null
      deletedMessageIds?: string[]
    }
    if (!response.ok || !data.ok || !Array.isArray(data.replies)) {
      return { ok: false, message: data.message ?? 'Грешка при зареждане на отговорите.' }
    }
    return {
      ok: true,
      replies: data.replies,
      hasMore: data.hasMore ?? false,
      oldestSeq: data.oldestSeq ?? null,
      deletedMessageIds: Array.isArray(data.deletedMessageIds) ? data.deletedMessageIds : [],
    }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

// ─── Topics Moderation (Етап 4) ─────────────────────────────────────────
//
// Moderation actions минават през HTTP (established convention — виж
// deleteLobbyChatMessage по-долу за прецедента), НЕ WS — реалният WS канал
// се ползва само за realtime NOTIFY на резултата (topic_lock_state_changed/
// topic_mute_state_changed/topic_deleted WS messages, wire-нати в
// createGameServerClient.ts).

type TopicLockSnapshot = {
  isLocked: boolean
  lockedUntil: string | null
  lockedByAccountId: string | null
  lockedReason: string | null
}

type TopicMuteSnapshot = {
  isMuted: boolean
  mutedUntil: string | null
  mutedByAccountId: string | null
  reason: string | null
}

type TopicMuteEvidenceSelfEntry = {
  muteHistoryId: string
  sourceKind: 'lafche_post' | 'topic_root' | 'topic_reply' | 'unspecified'
  sourceBodySnapshot: string
  sourceAttachment: { viewUrl: string; downloadUrl: string; width: number; height: number } | null
  sourceCreatedAt: string | null
  originalMessagePostDeleted: boolean
  reasonText: string | null
  reasonCategory: 'insults' | 'provocation' | 'spam' | 'inappropriate_content' | 'other' | null
  durationMs: number
  mutedUntil: string
  status: 'active' | 'expired' | 'manually_unmuted'
  unmutedAt: string | null
  createdAt: string
}

async function lockTopic(
  topicId: string,
  reason: string,
  durationMs: number,
): Promise<{ ok: true; lock: TopicLockSnapshot } | { ok: false; message: string }> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/topics/${encodeURIComponent(topicId)}/lock`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason, durationMs }),
    })
    const data = (await response.json().catch(() => ({}))) as { ok?: boolean; message?: string; lock?: TopicLockSnapshot }
    if (!response.ok || !data.ok || !data.lock) {
      return { ok: false, message: data.message ?? 'Грешка при заключване на темата.' }
    }
    return { ok: true, lock: data.lock }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function unlockTopic(
  topicId: string,
): Promise<{ ok: true; lock: TopicLockSnapshot } | { ok: false; message: string }> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/topics/${encodeURIComponent(topicId)}/unlock`, {
      method: 'POST',
      credentials: 'include',
    })
    const data = (await response.json().catch(() => ({}))) as { ok?: boolean; message?: string; lock?: TopicLockSnapshot }
    if (!response.ok || !data.ok || !data.lock) {
      return { ok: false, message: data.message ?? 'Грешка при отключване на темата.' }
    }
    return { ok: true, lock: data.lock }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function loadTopicMuteStatus(
  topicId: string,
  profileId: string,
): Promise<{ ok: true; mute: TopicMuteSnapshot } | { ok: false; message: string }> {
  try {
    const response = await fetch(
      `${getApiBaseUrl()}/api/topics/${encodeURIComponent(topicId)}/mute-status?profileId=${encodeURIComponent(profileId)}`,
      { method: 'GET', credentials: 'include' },
    )
    const data = (await response.json().catch(() => ({}))) as { ok?: boolean; message?: string; mute?: TopicMuteSnapshot }
    if (!response.ok || !data.ok || !data.mute) {
      return { ok: false, message: data.message ?? 'Грешка при зареждане на статуса.' }
    }
    return { ok: true, mute: data.mute }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function loadMyTopicMuteEvidence(): Promise<
  { ok: true; entries: TopicMuteEvidenceSelfEntry[] } | { ok: false; message: string }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/topics/mute-evidence/mine`, {
      method: 'GET',
      credentials: 'include',
    })
    const data = (await response.json().catch(() => ({}))) as { ok?: boolean; message?: string; entries?: TopicMuteEvidenceSelfEntry[] }
    if (!response.ok || !data.ok || !data.entries) {
      return { ok: false, message: data.message ?? 'Грешка при зареждане на историята.' }
    }
    return { ok: true, entries: data.entries }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

type TopicMuteEvidenceModeratorEntry = {
  muteHistoryId: string
  muteAuditLogId: string
  sourceTopicId: string
  sourceMessageId: string | null
  sourceKind: 'lafche_post' | 'topic_root' | 'topic_reply' | 'unspecified'
  sourceBodySnapshot: string
  sourceAttachment: { viewUrl: string; downloadUrl: string; width: number; height: number } | null
  sourceCreatedAt: string | null
  originalMessageDeletedAt: string | null
  mutedByAccountId: string | null
  mutedByRole: 'admin' | 'subadmin' | 'pika_team' | 'top_chat_admin'
  reasonText: string | null
  reasonCategory: 'insults' | 'provocation' | 'spam' | 'inappropriate_content' | 'other' | null
  durationMs: number
  mutedUntil: string
  status: 'active' | 'expired' | 'manually_unmuted'
  unmutedAt: string | null
  unmutedByAccountId: string | null
  createdAt: string
}

async function loadTopicMuteEvidenceForProfile(
  profileId: string,
): Promise<{ ok: true; entries: TopicMuteEvidenceModeratorEntry[] } | { ok: false; message: string }> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/topics/mute-evidence/profile/${encodeURIComponent(profileId)}`, {
      method: 'GET',
      credentials: 'include',
    })
    const data = (await response.json().catch(() => ({}))) as { ok?: boolean; message?: string; entries?: TopicMuteEvidenceModeratorEntry[] }
    if (!response.ok || !data.ok || !data.entries) {
      return { ok: false, message: data.message ?? 'Грешка при зареждане на историята.' }
    }
    return { ok: true, entries: data.entries }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function muteProfileInTopic(
  topicId: string,
  profileId: string,
  reason: string,
  durationMs: number,
  sourceMessageId: string | null,
  sourceKind: 'lafche_post' | 'topic_root' | 'topic_reply' | 'unspecified',
  reasonCategory: 'insults' | 'provocation' | 'spam' | 'inappropriate_content' | 'other' | null,
): Promise<{ ok: true; mute: TopicMuteSnapshot } | { ok: false; message: string }> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/topics/${encodeURIComponent(topicId)}/mute`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId, reason, durationMs, sourceMessageId, sourceKind, reasonCategory }),
    })
    const data = (await response.json().catch(() => ({}))) as { ok?: boolean; message?: string; mute?: TopicMuteSnapshot }
    if (!response.ok || !data.ok || !data.mute) {
      return { ok: false, message: data.message ?? 'Грешка при заглушаване.' }
    }
    return { ok: true, mute: data.mute }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function unmuteProfileInTopic(
  topicId: string,
  profileId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/topics/${encodeURIComponent(topicId)}/unmute`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId }),
    })
    const data = (await response.json().catch(() => ({}))) as { ok?: boolean; message?: string }
    if (!response.ok || !data.ok) {
      return { ok: false, message: data.message ?? 'Грешка при отглушаване.' }
    }
    return { ok: true }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function deleteTopic(
  topicId: string,
  reason: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/topics/${encodeURIComponent(topicId)}`, {
      method: 'DELETE',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    })
    const data = (await response.json().catch(() => ({}))) as { ok?: boolean; message?: string }
    if (!response.ok || !data.ok) {
      return { ok: false, message: data.message ?? 'Грешка при изтриване на темата.' }
    }
    return { ok: true }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function deleteTopicMessage(
  topicId: string,
  messageId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/topics/${encodeURIComponent(topicId)}/messages/${encodeURIComponent(messageId)}`, {
      method: 'DELETE',
      credentials: 'include',
    })
    const data = (await response.json().catch(() => ({}))) as { ok?: boolean; message?: string }
    if (!response.ok || !data.ok) {
      return { ok: false, message: data.message ?? 'Грешка при изтриване на съобщението.' }
    }
    return { ok: true }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function editTopicMessage(
  topicId: string,
  messageId: string,
  body: string,
): Promise<
  | { ok: true; body: string; editedAt: string | null; changed: boolean; parentMessageId: string | null }
  | { ok: false; code?: string; message: string }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/topics/${encodeURIComponent(topicId)}/messages/${encodeURIComponent(messageId)}`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body }),
    })
    const data = (await response.json().catch(() => ({}))) as {
      ok?: boolean
      code?: string
      message?: string
      body?: string
      editedAt?: string | null
      changed?: boolean
      parentMessageId?: string | null
    }
    if (!response.ok || !data.ok || typeof data.body !== 'string') {
      return { ok: false, code: data.code, message: data.message ?? 'Грешка при редактиране на съобщението.' }
    }
    return {
      ok: true,
      body: data.body,
      editedAt: data.editedAt ?? null,
      changed: Boolean(data.changed),
      parentMessageId: data.parentMessageId ?? null,
    }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function reportTopic(
  topicId: string,
  reason: string,
): Promise<{ ok: true } | { ok: false; code?: string; message: string }> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/topics/${encodeURIComponent(topicId)}/report`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    })
    const data = (await response.json().catch(() => ({}))) as { ok?: boolean; code?: string; message?: string }
    if (!response.ok || !data.ok) {
      return { ok: false, code: data.code, message: data.message ?? 'Грешка при докладването.' }
    }
    return { ok: true }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

type TopicReportSnapshot = {
  reportId: string
  topicId: string
  reporterProfileId: string
  reason: string
  status: 'pending' | 'reviewed' | 'dismissed'
  reviewedByAccountId: string | null
  reviewedAt: string | null
  createdAt: string
}

async function loadTopicReports(
  status: 'pending' | 'reviewed' | 'dismissed' | null,
): Promise<{ ok: true; reports: TopicReportSnapshot[]; pendingCount: number } | { ok: false; message: string }> {
  try {
    const qs = status !== null ? `?status=${encodeURIComponent(status)}` : ''
    const response = await fetch(`${getApiBaseUrl()}/api/admin/topic-reports${qs}`, {
      method: 'GET',
      credentials: 'include',
    })
    const data = (await response.json().catch(() => ({}))) as {
      ok?: boolean
      message?: string
      reports?: TopicReportSnapshot[]
      pendingCount?: number
    }
    if (!response.ok || !data.ok || !Array.isArray(data.reports)) {
      return { ok: false, message: data.message ?? 'Грешка при зареждане на докладите.' }
    }
    return { ok: true, reports: data.reports, pendingCount: data.pendingCount ?? 0 }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function reviewTopicReport(
  reportId: string,
  status: 'reviewed' | 'dismissed',
): Promise<{ ok: true; report: TopicReportSnapshot } | { ok: false; message: string }> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/admin/topic-reports/${encodeURIComponent(reportId)}/review`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    })
    const data = (await response.json().catch(() => ({}))) as { ok?: boolean; message?: string; report?: TopicReportSnapshot }
    if (!response.ok || !data.ok || !data.report) {
      return { ok: false, message: data.message ?? 'Грешка при преглед на доклада.' }
    }
    return { ok: true, report: data.report }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

// Отделен от loadOwnVipStatus (profile popup use case, само activeUntil) —
// composer gating в "Теми" се нуждае и от hasClaimedLaunchGift, за да избере
// правилния VIP popup текст ("Вземи 30 дни безплатно" vs "Виж VIP плановете").
async function loadTopicsVipGateStatus(): Promise<
  | { ok: true; isActive: boolean; hasClaimedLaunchGift: boolean }
  | { ok: false }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/vip/status`, {
      method: 'GET',
      credentials: 'include',
    })
    const data = (await response.json().catch(() => ({}))) as {
      ok?: boolean
      status?: { isActive?: boolean }
      hasClaimedLaunchGift?: boolean
    }
    if (!response.ok || !data.ok) {
      return { ok: false }
    }
    return {
      ok: true,
      isActive: data.status?.isActive ?? false,
      hasClaimedLaunchGift: data.hasClaimedLaunchGift ?? false,
    }
  } catch {
    return { ok: false }
  }
}

async function claimTopicsLaunchGiftRequest(): Promise<
  | { ok: true; isActive: boolean; activeUntil: string | null }
  | { ok: false; alreadyClaimed: boolean }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/vip/claim-launch-gift`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    })
    const data = (await response.json().catch(() => ({}))) as {
      ok?: boolean
      code?: string
      status?: { isActive?: boolean; activeUntil?: string | null }
    }
    if (!response.ok || !data.ok) {
      return { ok: false, alreadyClaimed: data.code === 'already_claimed' }
    }
    const isActive = data.status?.isActive ?? true
    const activeUntil = data.status?.activeUntil ?? null
    if (currentAuthSession !== null) {
      currentAuthSession = {
        ...currentAuthSession,
        profile: {
          ...currentAuthSession.profile,
          isVip: isActive,
        },
      }
      saveSessionCache(currentAuthSession)
    }
    return { ok: true, isActive, activeUntil }
  } catch {
    return { ok: false, alreadyClaimed: false }
  }
}

async function loadTournaments(
  params: { mine: boolean; page: number },
): Promise<
  | { ok: true; tournaments: TournamentSummarySnapshot[]; page: number; limit: number; totalCount: number }
  | { ok: false; message: string }
> {
  try {
    const qs = new URLSearchParams()
    if (params.mine) qs.set('mine', 'true')
    qs.set('page', String(params.page))
    const response = await fetch(`${getApiBaseUrl()}/api/tournaments?${qs.toString()}`, {
      method: 'GET',
      credentials: 'include',
    })
    const data = (await response.json()) as {
      ok: boolean
      message?: string
      tournaments?: TournamentSummarySnapshot[]
      page?: number
      limit?: number
      totalCount?: number
    }
    if (!response.ok || !data.ok || !Array.isArray(data.tournaments)) {
      return { ok: false, message: data.message ?? 'Грешка при зареждане на турнирите.' }
    }
    return {
      ok: true,
      tournaments: data.tournaments,
      page: data.page ?? 1,
      limit: data.limit ?? 20,
      totalCount: data.totalCount ?? data.tournaments.length,
    }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function loadTournamentBetaAccessInfo(): Promise<
  { enabled: boolean; hasAccess: boolean } | null
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/tournaments/beta-access`, {
      method: 'GET',
      credentials: 'include',
    })
    const data = (await response.json()) as { ok: boolean; enabled?: boolean; hasAccess?: boolean }
    if (!response.ok || !data.ok || typeof data.enabled !== 'boolean' || typeof data.hasAccess !== 'boolean') {
      return null
    }
    return { enabled: data.enabled, hasAccess: data.hasAccess }
  } catch {
    return null
  }
}

async function submitTournamentBetaAccessPasswordRequest(
  password: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/tournaments/beta-access`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    })
    const data = (await response.json()) as { ok: boolean; message?: string }
    if (!response.ok || !data.ok) {
      return { ok: false, message: data.message ?? 'Невалидна парола за достъп.' }
    }
    return { ok: true }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function createTournamentRequest(
  input: TournamentCreateInput,
): Promise<
  | { ok: true; tournament: TournamentSummarySnapshot }
  | { ok: false; message: string; reason?: string }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/tournaments`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    const data = (await response.json()) as { ok: boolean; message?: string; reason?: string; tournament?: TournamentSummarySnapshot }
    if (!response.ok || !data.ok || !data.tournament) {
      return { ok: false, message: data.message ?? 'Турнирът не беше създаден.', reason: data.reason }
    }
    return { ok: true, tournament: data.tournament }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function loadTournamentDetail(
  tournamentId: string,
): Promise<
  | { ok: true; tournament: TournamentDetailSnapshot }
  | { ok: false; message: string; requiresPassword?: boolean }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/tournaments/${encodeURIComponent(tournamentId)}`, {
      method: 'GET',
      credentials: 'include',
    })
    const data = (await response.json()) as {
      ok: boolean
      message?: string
      requiresPassword?: boolean
      tournament?: TournamentDetailSnapshot
    }
    if (!response.ok || !data.ok || !data.tournament) {
      return { ok: false, message: data.message ?? 'Турнирът не е намерен.', requiresPassword: data.requiresPassword }
    }
    return { ok: true, tournament: data.tournament }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function unlockTournamentDetail(
  tournamentId: string,
  password: string,
): Promise<
  | { ok: true; tournament: TournamentDetailSnapshot }
  | { ok: false; message: string; requiresPassword?: boolean }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/tournaments/${encodeURIComponent(tournamentId)}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    })
    const data = (await response.json()) as {
      ok: boolean
      message?: string
      requiresPassword?: boolean
      tournament?: TournamentDetailSnapshot
    }
    if (!response.ok || !data.ok || !data.tournament) {
      return { ok: false, message: data.message ?? 'Грешна парола.', requiresPassword: data.requiresPassword }
    }
    return { ok: true, tournament: data.tournament }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

type TournamentEntryActionErrorResponse = {
  ok: false
  message?: string
  reason?: string
  requiresPassword?: boolean
}

async function joinTournamentRequest(
  tournamentId: string,
  password: string | null,
): Promise<
  | { ok: true; alreadyJoined: boolean; debitedAmount?: number; walletBalance: number; tournament: TournamentSummarySnapshot }
  | { ok: false; message: string; reason?: string; requiresPassword?: boolean }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/tournaments/${encodeURIComponent(tournamentId)}/join`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(password !== null ? { password } : {}),
    })
    const data = (await response.json()) as
      | { ok: true; alreadyJoined: boolean; debitedAmount?: number; walletBalance: number; tournament: TournamentSummarySnapshot }
      | TournamentEntryActionErrorResponse
    if (!response.ok || !data.ok) {
      return {
        ok: false,
        message: (data as TournamentEntryActionErrorResponse).message ?? 'Записването не бе успешно.',
        reason: (data as TournamentEntryActionErrorResponse).reason,
        requiresPassword: (data as TournamentEntryActionErrorResponse).requiresPassword,
      }
    }
    if (currentAuthSession !== null) {
      currentAuthSession = {
        ...currentAuthSession,
        profile: { ...currentAuthSession.profile, yellowCoinsBalance: data.walletBalance },
      }
      syncLobbyWithAuthSession()
    }
    return {
      ok: true,
      alreadyJoined: data.alreadyJoined,
      debitedAmount: data.debitedAmount,
      walletBalance: data.walletBalance,
      tournament: data.tournament,
    }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function leaveTournamentRequest(
  tournamentId: string,
): Promise<
  | { ok: true; alreadyRefunded: boolean; refundedAmount: number; walletBalance: number; tournament: TournamentSummarySnapshot }
  | { ok: false; message: string; reason?: string }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/tournaments/${encodeURIComponent(tournamentId)}/leave`, {
      method: 'POST',
      credentials: 'include',
    })
    const data = (await response.json()) as
      | {
          ok: true
          alreadyRefunded: boolean
          refundedAmount: number
          walletBalance: number
          tournament: TournamentSummarySnapshot
        }
      | TournamentEntryActionErrorResponse
    if (!response.ok || !data.ok) {
      return {
        ok: false,
        message: (data as TournamentEntryActionErrorResponse).message ?? 'Отказването не бе успешно.',
        reason: (data as TournamentEntryActionErrorResponse).reason,
      }
    }
    if (currentAuthSession !== null) {
      currentAuthSession = {
        ...currentAuthSession,
        profile: { ...currentAuthSession.profile, yellowCoinsBalance: data.walletBalance },
      }
      syncLobbyWithAuthSession()
    }
    return {
      ok: true,
      alreadyRefunded: data.alreadyRefunded,
      refundedAmount: data.refundedAmount,
      walletBalance: data.walletBalance,
      tournament: data.tournament,
    }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function cancelTournamentRequest(
  tournamentId: string,
): Promise<
  | {
      ok: true
      alreadyCancelled: boolean
      refundedEntries: number
      totalRefunded: number
      walletBalance: number
      tournament: TournamentSummarySnapshot
    }
  | { ok: false; message: string; reason?: string }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/tournaments/${encodeURIComponent(tournamentId)}/cancel`, {
      method: 'POST',
      credentials: 'include',
    })
    const data = (await response.json()) as
      | {
          ok: true
          alreadyCancelled: boolean
          refundedEntries: number
          totalRefunded: number
          walletBalance: number
          tournament: TournamentSummarySnapshot
        }
      | TournamentEntryActionErrorResponse
    if (!response.ok || !data.ok) {
      return {
        ok: false,
        message: (data as TournamentEntryActionErrorResponse).message ?? 'Отмяната не бе успешна.',
        reason: (data as TournamentEntryActionErrorResponse).reason,
      }
    }
    if (currentAuthSession !== null) {
      currentAuthSession = {
        ...currentAuthSession,
        profile: { ...currentAuthSession.profile, yellowCoinsBalance: data.walletBalance },
      }
      syncLobbyWithAuthSession()
    }
    return {
      ok: true,
      alreadyCancelled: data.alreadyCancelled,
      refundedEntries: data.refundedEntries,
      totalRefunded: data.totalRefunded,
      walletBalance: data.walletBalance,
      tournament: data.tournament,
    }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

// Creator/admin moderation (§"SERVER API" в task spec-а — тесни dedicated
// endpoints, не generic arbitrary tournament mutation). Връщат пълния
// TournamentDetailSnapshot directно (server-ът вече го build-ва в отговора),
// не само summary — teams[] реално се промени.
async function forceRemoveTournamentTeamRequest(
  tournamentId: string,
  teamId: string,
): Promise<
  | { ok: true; tournament: TournamentDetailSnapshot }
  | { ok: false; message: string; reason?: string }
> {
  try {
    const response = await fetch(
      `${getApiBaseUrl()}/api/tournaments/${encodeURIComponent(tournamentId)}/teams/${encodeURIComponent(teamId)}/remove`,
      { method: 'POST', credentials: 'include' },
    )
    const data = (await response.json()) as
      | { ok: true; tournament: TournamentDetailSnapshot }
      | TournamentEntryActionErrorResponse
    if (!response.ok || !data.ok) {
      return {
        ok: false,
        message: (data as TournamentEntryActionErrorResponse).message ?? 'Отписването не бе успешно.',
        reason: (data as TournamentEntryActionErrorResponse).reason,
      }
    }
    return { ok: true, tournament: data.tournament }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function forceRemoveTournamentEntryRequest(
  tournamentId: string,
  entryId: string,
): Promise<
  | { ok: true; tournament: TournamentDetailSnapshot }
  | { ok: false; message: string; reason?: string }
> {
  try {
    const response = await fetch(
      `${getApiBaseUrl()}/api/tournaments/${encodeURIComponent(tournamentId)}/entries/${encodeURIComponent(entryId)}/remove`,
      { method: 'POST', credentials: 'include' },
    )
    const data = (await response.json()) as
      | { ok: true; tournament: TournamentDetailSnapshot }
      | TournamentEntryActionErrorResponse
    if (!response.ok || !data.ok) {
      return {
        ok: false,
        message: (data as TournamentEntryActionErrorResponse).message ?? 'Отписването не бе успешно.',
        reason: (data as TournamentEntryActionErrorResponse).reason,
      }
    }
    return { ok: true, tournament: data.tournament }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

// Creator-only "Редактирай старт" (§ "EDIT SCHEDULED START" в task spec-а) —
// тесен PATCH, пипа ИЗКЛЮЧИТЕЛНО scheduled_start_at. Не generic tournament
// update endpoint.
async function updateTournamentScheduledStartRequest(
  tournamentId: string,
  scheduledStartAt: string,
): Promise<
  | { ok: true; tournament: TournamentSummarySnapshot }
  | { ok: false; message: string; reason?: string }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/tournaments/${encodeURIComponent(tournamentId)}/scheduled-start`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scheduledStartAt }),
    })
    const data = (await response.json()) as
      | { ok: true; tournament: TournamentSummarySnapshot }
      | TournamentEntryActionErrorResponse
    if (!response.ok || !data.ok) {
      return {
        ok: false,
        message: (data as TournamentEntryActionErrorResponse).message ?? 'Промяната не бе успешна.',
        reason: (data as TournamentEntryActionErrorResponse).reason,
      }
    }
    return { ok: true, tournament: data.tournament }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

type TournamentPartnerInviteActionResponse =
  | {
      ok: true
      alreadyResolved?: boolean
      debitedAmount?: number
      invite: TournamentPartnerInviteSnapshot
      walletBalance: number
      tournament: TournamentSummarySnapshot
    }
  | { ok: false; message: string; reason?: string; requiresPassword?: boolean }

async function loadTournamentPartnerCandidates(
  tournamentId: string,
): Promise<
  | { ok: true; candidates: TournamentPartnerCandidateSnapshot[] }
  | { ok: false; message: string; reason?: string }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/tournaments/${encodeURIComponent(tournamentId)}/partner-candidates`, {
      method: 'GET',
      credentials: 'include',
    })
    const data = (await response.json()) as { ok: boolean; message?: string; reason?: string; candidates?: TournamentPartnerCandidateSnapshot[] }
    if (!response.ok || !data.ok || !Array.isArray(data.candidates)) {
      return { ok: false, message: data.message ?? 'Приятелите не бяха заредени.', reason: data.reason }
    }
    return { ok: true, candidates: data.candidates }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function searchTournamentPartnerCandidates(
  tournamentId: string,
  query: string,
  signal: AbortSignal,
): Promise<
  | { ok: true; candidates: TournamentPartnerCandidateSnapshot[] }
  | { ok: false; message: string; reason?: string }
> {
  try {
    const response = await fetch(
      `${getApiBaseUrl()}/api/tournaments/${encodeURIComponent(tournamentId)}/partner-candidates/search?q=${encodeURIComponent(query)}`,
      {
        method: 'GET',
        credentials: 'include',
        signal,
      },
    )
    const data = (await response.json()) as { ok: boolean; message?: string; reason?: string; candidates?: TournamentPartnerCandidateSnapshot[] }
    if (!response.ok || !data.ok || !Array.isArray(data.candidates)) {
      return { ok: false, message: data.message ?? 'Търсенето не беше успешно.', reason: data.reason }
    }
    return { ok: true, candidates: data.candidates }
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error
    }
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function loadPendingTournamentPartnerInvites(): Promise<
  | { ok: true; invites: TournamentPartnerInviteSnapshot[] }
  | { ok: false; message: string; reason?: string }
> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/tournaments/partner-invites/pending`, {
      method: 'GET',
      credentials: 'include',
    })
    const data = (await response.json()) as { ok: boolean; message?: string; reason?: string; invites?: TournamentPartnerInviteSnapshot[] }
    if (!response.ok || !data.ok || !Array.isArray(data.invites)) {
      return { ok: false, message: data.message ?? 'Поканите не бяха заредени.', reason: data.reason }
    }
    return { ok: true, invites: data.invites }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function dismissTournamentPartnerInvitePopupRequest(
  inviteId: string,
): Promise<{ ok: true; tournamentId: string } | { ok: false; message: string }> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/tournaments/partner-invites/${encodeURIComponent(inviteId)}/dismiss-popup`, {
      method: 'POST',
      credentials: 'include',
    })
    const data = (await response.json()) as { ok: boolean; message?: string; tournamentId?: string }
    if (!response.ok || !data.ok || typeof data.tournamentId !== 'string') {
      return { ok: false, message: data.message ?? 'Поканата не беше затворена.' }
    }
    void lobby?.refreshPendingTournamentPartnerInvites()
    return { ok: true, tournamentId: data.tournamentId }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function viewTournamentPartnerInviteNotificationRequest(
  inviteId: string,
): Promise<{ ok: true; tournamentId: string } | { ok: false; message: string }> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/tournaments/partner-invites/${encodeURIComponent(inviteId)}/view`, {
      method: 'POST',
      credentials: 'include',
    })
    const data = (await response.json()) as { ok: boolean; message?: string; tournamentId?: string }
    if (!response.ok || !data.ok || typeof data.tournamentId !== 'string') {
      return { ok: false, message: data.message ?? 'Поканата не беше отворена.' }
    }
    return { ok: true, tournamentId: data.tournamentId }
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function createTournamentPartnerInviteRequest(
  tournamentId: string,
  inviteeProfileId: string,
  password: string | null,
): Promise<TournamentPartnerInviteActionResponse> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/tournaments/${encodeURIComponent(tournamentId)}/partner-invites`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inviteeProfileId, ...(password !== null ? { password } : {}) }),
    })
    const data = (await response.json()) as TournamentPartnerInviteActionResponse
    if (!response.ok || !data.ok) {
      const errorData = data as Extract<TournamentPartnerInviteActionResponse, { ok: false }>
      return { ok: false, message: errorData.message ?? 'Поканата не бе изпратена.', reason: errorData.reason, requiresPassword: errorData.requiresPassword }
    }
    if (currentAuthSession !== null) {
      currentAuthSession = {
        ...currentAuthSession,
        profile: { ...currentAuthSession.profile, yellowCoinsBalance: data.walletBalance },
      }
      syncLobbyWithAuthSession()
    }
    return data
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

async function respondTournamentPartnerInviteRequest(
  tournamentId: string,
  inviteId: string,
  action: 'accept' | 'decline' | 'cancel',
): Promise<TournamentPartnerInviteActionResponse> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/tournaments/${encodeURIComponent(tournamentId)}/partner-invites/${encodeURIComponent(inviteId)}/${action}`, {
      method: 'POST',
      credentials: 'include',
    })
    const data = (await response.json()) as TournamentPartnerInviteActionResponse
    if (!response.ok || !data.ok) {
      const errorData = data as Extract<TournamentPartnerInviteActionResponse, { ok: false }>
      return { ok: false, message: errorData.message ?? 'Поканата не бе обработена.', reason: errorData.reason }
    }
    if (currentAuthSession !== null) {
      currentAuthSession = {
        ...currentAuthSession,
        profile: { ...currentAuthSession.profile, yellowCoinsBalance: data.walletBalance },
      }
      syncLobbyWithAuthSession()
    }
    return data
  } catch {
    return { ok: false, message: 'Няма връзка със сървъра.' }
  }
}

lobby = createLobbyFlowController({
  root: rootElement,
  suppressRendering: _isResetPasswordPath,
  joinMatchmaking: (stake, displayName) => {
    client.joinMatchmaking(stake, displayName)
  },
  joinGuestTrial: (stake) => {
    client.joinGuestTrial(stake)
  },
  leaveMatchmaking: () => {
    client.leaveMatchmaking()
  },
  onGuestTrialStatusLoad: () => loadGuestTrialStatus(),
  onMatchFound: (message, stakeAlreadyShown) => {
    lobby.suspendLobbyChatForActiveRoom()
    activeRoom.enterActiveRoom(message, stakeAlreadyShown)
  },
  onLobbyChatSubscribe: () => {
    client.subscribeLobbyChat()
  },
  onLobbyChatUnsubscribe: () => {
    client.unsubscribeLobbyChat()
  },
  onLobbyChatSend: (body, requestId) => {
    client.sendLobbyChatMessage(body, requestId)
  },
  onLobbyChatDeleteMessage: (messageId) => {
    void deleteLobbyChatMessage(messageId)
  },
  onTopicMessagesSubscribe: (topicId, afterSeq) => {
    client.subscribeTopicMessages(topicId, afterSeq)
  },
  onTopicMessagesUnsubscribe: (topicId) => {
    client.unsubscribeTopicMessages(topicId)
  },
  onTopicMessageSend: (topicId, body, requestId, imageDataUrl) => {
    client.sendTopicMessage(topicId, body, requestId, imageDataUrl)
  },
  onTopicReplySend: (topicId, parentMessageId, body, requestId, imageDataUrl) => {
    client.sendTopicReply(topicId, parentMessageId, body, requestId, imageDataUrl)
  },
  onTopicMessageLikeToggle: (messageId, requestId) => {
    client.toggleTopicMessageLike(messageId, requestId)
  },
  onTopicCreateSubmit: (title, requestId) => {
    client.createTopic(title, requestId)
  },
  onTopicsDirectorySubscribe: () => {
    client.subscribeTopicsDirectory()
  },
  onTopicsDirectoryUnsubscribe: () => {
    client.unsubscribeTopicsDirectory()
  },
  getAuthSession: () => currentAuthSession,
  getIsInGame: () => activeRoom.hasActiveRoom(),
  onShowModerationForcedExitPopup: (input) => {
    showModerationForcedExitPopup(input)
  },
  onLoginSubmit: (email, password) =>
    submitAuthRequest('login', {
      email,
      password,
    }),
  onRegisterSubmit: (displayName, email, password, gender) =>
    {
      const validation = validateProfileDisplayName(displayName)
      if (!validation.ok) return Promise.resolve(validation.message)
      return submitAuthRequest('register', {
        displayName: validation.canonicalDisplayName,
        email,
        password,
        ...(gender !== null ? { gender } : {}),
      }).then((result) => result.errorText)
    },
  onProfileEditSubmit: (targetProfileId, avatarFile, avatarCrop, galleryFiles) =>
    submitProfileUpdate(targetProfileId, avatarFile, avatarCrop, galleryFiles),
  onPresetAvatarApply: (targetProfileId, avatarUrl) => submitPresetAvatarUrl(targetProfileId, avatarUrl),
  getSignupBonusYellowCoins: () => publicSignupBonusYellowCoins,
  getOnlinePlayersCount: () => publicOnlinePlayersCount,
  getProfileNameChangePrice: () => publicProfileNameChangePrice,
  getApiBaseUrl: () => getApiBaseUrl(),
  onProfileGalleryDelete: (targetProfileId, imageId) => deleteProfileGalleryImage(targetProfileId, imageId),
  onProfileNameChangeSubmit: (targetProfileId, displayName) => submitProfileNameChange(targetProfileId, displayName),
  onAdminGrantVip: (targetProfileId, days) => adminGrantVip(targetProfileId, days),
  onAdminGetActiveBan: (targetProfileId) => adminGetActiveBan(targetProfileId),
  onAdminBanProfile: (targetProfileId, days, reason) => adminBanProfile(targetProfileId, days, reason),
  onAdminUnbanProfile: (targetProfileId) => adminUnbanProfile(targetProfileId),
  onAdminHardDeleteProfile: (targetProfileId, reason, supportRequestMessageId) =>
    adminHardDeleteProfile(targetProfileId, reason, supportRequestMessageId),
  onChangePasswordSubmit: (currentPassword, newPassword) => submitChangePassword(currentPassword, newPassword),
  onPlayersLoad: (page, snapshotToken) => loadPlayersDirectory(page, snapshotToken),
  onPlayersSearch: (query, signal) => searchPlayersDirectory(query, signal),
  onLeaderboardsLoad: () => loadLeaderboards(),
  onLobbyPackagesLoad: () => loadLobbyPackages(),
  onShopPackagesLoad: () => loadShopPackages(),
  onShopPurchasesLoad: () => loadShopPurchases(),
  onShopPurchaseStart: (packageId) => startShopPurchase(packageId),
  onShopPurchaseResume: (purchaseId) => resumeShopPurchase(purchaseId),
  onShopPurchaseHide: (purchaseId) => hideShopPurchase(purchaseId),
  onVipPackagesLoad: () => loadVipPackages(),
  onVipPurchaseStart: (packageId) => startVipPurchase(packageId),
  onAdminDailyRewardsLoad: () => loadAdminDailyRewards(),
  onAdminDailyRewardAdd: (amount) => addAdminDailyReward(amount),
  onAdminDailyRewardRemove: (tierId) => removeAdminDailyReward(tierId),
  onDailyRewardsLoad: () => loadDailyRewards(),
  onDailyRewardClaim: (tierId) => claimDailyReward(tierId),
  onAdminStatsLoad: () => loadAdminStats(),
  onAdminSettingsLoad: () => loadAdminSettings(),
  onAdminSettingsSubmit: (settings) => submitAdminSettings(settings),
  onAdminCoinPackagesLoad: () => loadAdminCoinPackages(),
  onAdminCoinPackageSubmit: (input) => submitAdminCoinPackage(input),
  onAdminCoinPackageStatusChange: (packageId, status) =>
    setAdminCoinPackageStatus(packageId, status),
  onAdminCoinPackageDelete: (packageId) => deleteAdminCoinPackage(packageId),
  onAdminCoinPackageLobbyToggle: (packageId, showInLobby) =>
    setAdminCoinPackageLobbyVisibility(packageId, showInLobby),
  onAdminCoinPackageTopOfferToggle: (packageId, isTopOffer) =>
    setAdminCoinPackageTopOffer(packageId, isTopOffer),
  onFriendshipsLoad: () => loadFriendships(),
  onFriendRequestSubmit: (profileId) => submitFriendRequest(profileId),
  onFriendAccept: (friendshipId) => submitFriendAction(friendshipId, 'accept'),
  onFriendReject: (friendshipId) => submitFriendAction(friendshipId, 'reject'),
  onFriendCancel: (friendshipId) => submitFriendAction(friendshipId, 'cancel'),
  onFriendRemove: (friendshipId) => submitFriendAction(friendshipId, 'remove'),
  onBlockProfile: (profileId) => submitProfileBlock(profileId),
  onLoadBlockedPlayers: async () => {
    try {
      const response = await fetch(`${getApiBaseUrl()}/api/blocks`, { credentials: 'include' })
      const data = await response.json() as { ok?: boolean; profiles?: PlayerPublicProfileSnapshot[]; count?: number; limit?: number; message?: string }
      if (!response.ok || !data.ok) return { ok: false, message: data.message ?? 'Грешка при зареждане.' }
      return { ok: true, profiles: data.profiles ?? [], count: data.count ?? 0, limit: data.limit ?? 50 }
    } catch {
      return { ok: false, message: 'Няма връзка със сървъра.' }
    }
  },
  onLikeProfile: (profileId) => submitProfileLike(profileId),
  onGiftCoinsSubmit: (friendshipId, amount) => submitGiftCoins(friendshipId, amount),
  onGiftCoinsBypassSubmit: (recipientProfileId, amount) => submitGiftCoinsBypass(recipientProfileId, amount),
  onPikaSupportChatStart: (recipientProfileId) => startPikaSupportChat(recipientProfileId),
  onVipDmFirstMessageSend: (recipientProfileId, body, imageDataUrl) => startVipDmFirstMessage(recipientProfileId, body, imageDataUrl),
  onChatConversationsLoad: (includeArchived) => loadChatConversations(includeArchived),
  onChatMessagesLoad: (friendshipId) => loadChatMessages(friendshipId),
  onChatMarkRead: async (friendshipId) => {
    await markChatConversationRead(friendshipId)
  },
  onChatSend: (friendshipId, body, imageDataUrl) => sendChatMessage(friendshipId, body, imageDataUrl),
  onLogout: () => submitLogout(),
  onDailyMissionsLoad: () => loadDailyMissions(),
  onMissionClaim: (missionId) => claimMissionReward(missionId),
  onAdminMissionsLoad: () => loadAdminMissions(),
  onAdminMissionSubmit: (input) => submitAdminMission(input),
  onAdminMissionActiveToggle: (missionId, isActive) => setAdminMissionActive(missionId, isActive),
  onAdminMissionDelete: (missionId) => deleteAdminMission(missionId),
  onMatchRoomsLoad: () => loadMatchRooms(),
  onAdminMatchRoomUpsert: (room) => upsertAdminMatchRoom(room),
  onAdminMatchRoomDelete: (stakeAmount) => deleteAdminMatchRoom(stakeAmount),
  onPrivateRoomsOpen: () => { client.requestPrivateRoomsList() },
  onPrivateRoomsClose: () => {},
  onPrivateGamesOpen: () => { client.requestPrivateGamesList() },
  onPrivateRoomCreate: (stake, isLocked, waitMinutes, manualStart) => { client.createPrivateRoom(stake, isLocked, waitMinutes, manualStart) },
  onPrivateRoomJoinSlot: (privateRoomId, team, slotIndex) => { client.joinPrivateRoomSlot(privateRoomId, team, slotIndex) },
  onPrivateRoomLeave: () => { client.leavePrivateRoom() },
  onPrivateRoomInvite: (toProfiles) => { client.inviteToPrivateRoom(toProfiles) },
  onCancelPrivateRoomInvite: (inviteId) => { client.cancelPrivateRoomInvite(inviteId) },
  onPrivateRoomInviteRespond: (inviteId, accept) => { client.respondPrivateRoomInvite(inviteId, accept) },
  onPrivateRoomAddBot: (team) => { client.addBotToPrivateRoomTeam(team) },
  onPrivateRoomRemoveBot: (team) => { client.removeBotFromPrivateRoomTeam(team) },
  onPrivateRoomStart: () => { client.startPrivateRoom() },
  onPrivateRoomKick: (team, slotIndex) => { client.kickFromPrivateRoom(team, slotIndex) },
  onPrivateRoomChatSubscribe: (privateRoomId) => { client.subscribePrivateRoomChat(privateRoomId) },
  onPrivateRoomChatUnsubscribe: (privateRoomId) => { client.unsubscribePrivateRoomChat(privateRoomId) },
  onPrivateRoomChatSend: (privateRoomId, body, requestId) => { client.sendPrivateRoomChatMessage(privateRoomId, body, requestId) },
  onSupportMessagesLoad: () => loadSupportMessages(),
  onSupportSend: (body, imageDataUrl) => sendSupportMessage(body, imageDataUrl),
  onGuestContactSend: (input) => sendGuestContactMessage(input),
  onSupportUnreadLoad: async () => {
    try {
      const response = await fetch(`${getApiBaseUrl()}/api/support/unread`, {
        method: 'GET',
        credentials: 'include',
      })
      const data = (await response.json()) as { ok: boolean; unreadCount?: number }
      if (response.ok && data.ok && typeof data.unreadCount === 'number') {
        const supportUnreadCount = data.unreadCount
        let guestUnreadCount = 0

        if (currentAuthSession?.account.role === 'admin') {
          try {
            const guestResponse = await fetch(`${getApiBaseUrl()}/api/admin/guest-contact/messages/unread-count`, {
              method: 'GET',
              credentials: 'include',
            })
            const guestData = (await guestResponse.json()) as { ok: boolean; unreadCount?: number }

            if (guestResponse.ok && guestData.ok && typeof guestData.unreadCount === 'number') {
              guestUnreadCount = guestData.unreadCount
            }
          } catch {
            // Keep the existing support unread badge behavior if guest count cannot be loaded.
          }
        }

        return {
          ok: true,
          unreadCount: supportUnreadCount + guestUnreadCount,
          supportUnreadCount,
          guestUnreadCount,
        }
      }
      return { ok: false }
    } catch {
      return { ok: false }
    }
  },
  onAdminSupportConversationsLoad: () => loadAdminSupportConversations(),
  onAdminGuestContactMessagesLoad: () => loadAdminGuestContactMessages(),
  onAdminGuestContactMessageRead: (messageId) => markAdminGuestContactMessageRead(messageId),
  onAdminSupportMessagesLoad: (profileId) => loadAdminSupportMessages(profileId),
  onAdminSupportReply: (profileId, body, imageDataUrl) => sendAdminSupportReply(profileId, body, imageDataUrl),
  onAdminSupportDeleteConversation: (profileId) => archiveAdminSupportConversation(profileId),
  onSupportDeleteConversation: () => deleteUserSupportConversation(),
  initialPrivateRoomInGameNotificationsEnabled: privateRoomInGameNotificationsEnabled,
  onPrivateRoomInGameNotificationsChange: (enabled) => {
    setPrivateRoomInGameNotificationsEnabled(enabled)
  },
  initialPrivateRoomCreatedSoundEnabled: privateRoomCreatedSoundEnabled,
  onPrivateRoomCreatedSoundChange: (enabled) => {
    setPrivateRoomCreatedSoundEnabled(enabled)
  },
  onAdminServerScreenEnter: () => {
    startMonitoringPolling()
    fetchAdminHistory('1h')
  },
  onAdminCpuIncidentsLoad: () => loadAdminCpuIncidents(),
  onAdminCpuIncidentDetailLoad: (incidentId) => loadAdminCpuIncidentDetail(incidentId),
  onAdminRegisteredProfilesLoad: (period, page) => loadAdminRegisteredProfiles(period, page),
  onAdminProfileRiskDetailLoad: (profileId) => loadAdminProfileRiskDetail(profileId),
  onAdminProfileRiskRecheck: (profileId) => submitAdminProfileRiskRecheck(profileId),
  onAdminServerScreenLeave: () => {
    stopMonitoringPolling()
    invalidateHistoryGeneration()
  },
  onAdminInfoFamilyScreenEnter: () => {
    startAdminInfoAccessPolling()
  },
  onAdminInfoFamilyScreenLeave: () => {
    stopAdminInfoAccessPolling()
  },
  onAdminGetTargetRole: (profileId) => loadAdminTargetRole(profileId),
  onGetOwnVipStatus: () => loadOwnVipStatus(),
  onAdminGrantSubadmin: (profileId) => submitSubadminRoleChange(profileId, 'grant'),
  onAdminRevokeSubadmin: (profileId) => submitSubadminRoleChange(profileId, 'revoke'),
  onAdminGrantChatAdmin: (profileId) => submitChatAdminRoleChange(profileId, 'grant'),
  onAdminRevokeChatAdmin: (profileId) => submitChatAdminRoleChange(profileId, 'revoke'),
  onAdminGrantPikaTeam: (profileId) => submitPikaTeamRoleChange(profileId, 'grant'),
  onAdminRevokePikaTeam: (profileId) => submitPikaTeamRoleChange(profileId, 'revoke'),
  onAdminGrantTopChatAdmin: (profileId) => submitTopChatAdminRoleChange(profileId, 'grant'),
  onAdminRevokeTopChatAdmin: (profileId) => submitTopChatAdminRoleChange(profileId, 'revoke'),
  onAdminHistoryWindowChange: (window: HistoryWindow) => {
    invalidateHistoryGeneration()
    fetchAdminHistory(window)
  },
  onAdminVisitorsPeriodClick: (_period: string) => {
    lobby.navigateAdminVisitors()
  },
  onAdminVisitorsBackClick: () => {
    lobby.navigateAdminInfo()
  },
  onAdminVisitorsLoad: (params) => loadAdminVisitors(params),
  onAdminVisitorSourcesLoad: (params) => loadAdminVisitorSources(params),
  onAdminPaymentsLoad: (params) => loadAdminPayments(params),
  onAdminPaymentDetailLoad: (purchaseId) => loadAdminPaymentDetail(purchaseId),
  onAdminTournamentsLoad: (filters) => loadAdminTournaments(filters),
  onAdminTournamentDetailLoad: (tournamentId) => loadAdminTournamentDetail(tournamentId),
  onAdminTournamentReconcile: (tournamentId) => postAdminTournamentAction(tournamentId, 'reconcile') as Promise<
    | { ok: true; status: string }
    | { ok: false; message: string; forbidden?: boolean }
  >,
  onAdminTournamentCancelOpen: (tournamentId) => postAdminTournamentAction(tournamentId, 'cancel-open') as Promise<
    | { ok: true; alreadyCancelled: boolean; refundedEntries: number; totalRefunded: number }
    | { ok: false; message: string; forbidden?: boolean }
  >,
  onAdCampaignsLoad: () => loadAdCampaignManagement(),
  onAdCampaignCreateSubmit: (input) => createAdCampaignSubmit(input),
  onAdCampaignSendSubmit: (campaignId) => sendAdCampaignSubmit(campaignId),
  onAdCampaignDeleteSubmit: (campaignId) => deleteAdCampaignSubmit(campaignId),
  onAdCampaignManagementScreenEnter: () => {
    client.subscribeAdCampaignManagement()
  },
  onAdCampaignManagementScreenLeave: () => {
    client.unsubscribeAdCampaignManagement()
  },
  requestPendingAdCampaigns: () => {
    client.requestPendingAdCampaigns()
  },
  onAdCampaignMarkShown: (dispatchId) => {
    client.markAdCampaignDispatchShown(dispatchId)
  },
  onAdCampaignDismissDispatch: (dispatchId) => {
    client.dismissAdCampaignDispatch(dispatchId)
  },
  onAdCampaignClickDispatch: (dispatchId) => {
    client.clickAdCampaignDispatch(dispatchId)
  },
  onTournamentsLoad: (params) => loadTournaments(params),
  onTournamentBetaAccessInfoLoad: () => loadTournamentBetaAccessInfo(),
  onTournamentBetaAccessSubmit: (password) => submitTournamentBetaAccessPasswordRequest(password),
  onTopicsLoad: () => loadTopics(),
  onTopicMarkSeen: (topicId) => markTopicSeen(topicId),
  onTopicThreadMarkSeen: (topicId, rootMessageId) => markTopicThreadSeen(topicId, rootMessageId),
  onProfileByIdLoad: (profileId) => loadProfileById(profileId),
  onTopicMessagesLoad: (topicId, beforeSeq) => loadTopicMessages(topicId, beforeSeq),
  onTopicRepliesLoad: (topicId, rootMessageId, afterSeq) => loadTopicReplies(topicId, rootMessageId, afterSeq),
  onTopicLock: (topicId, reason, durationMs) => lockTopic(topicId, reason, durationMs),
  onTopicUnlock: (topicId) => unlockTopic(topicId),
  onTopicMuteStatusLoad: (topicId, profileId) => loadTopicMuteStatus(topicId, profileId),
  onTopicMuteHistoryLoad: () => loadMyTopicMuteEvidence(),
  onTopicMuteHistoryLoadForProfile: (profileId) => loadTopicMuteEvidenceForProfile(profileId),
  onTopicMuteProfile: (topicId, profileId, reason, durationMs, sourceMessageId, sourceKind, reasonCategory) =>
    muteProfileInTopic(topicId, profileId, reason, durationMs, sourceMessageId, sourceKind, reasonCategory),
  onTopicUnmuteProfile: (topicId, profileId) => unmuteProfileInTopic(topicId, profileId),
  onTopicDelete: (topicId, reason) => deleteTopic(topicId, reason),
  onTopicMessageDelete: (topicId, messageId) => deleteTopicMessage(topicId, messageId),
  onTopicMessageEdit: (topicId, messageId, body) => editTopicMessage(topicId, messageId, body),
  onTopicReport: (topicId, reason) => reportTopic(topicId, reason),
  onTopicReportsLoad: (status) => loadTopicReports(status),
  onTopicReportReview: (reportId, status) => reviewTopicReport(reportId, status),
  onGetTopicsVipGateStatus: () => loadTopicsVipGateStatus(),
  onClaimTopicsLaunchGift: () => claimTopicsLaunchGiftRequest(),
  onTournamentCreate: (input) => createTournamentRequest(input),
  onTournamentDetailLoad: (tournamentId) => loadTournamentDetail(tournamentId),
  onTournamentActiveMatchRecovered: (assignment) => {
    if (assignment !== null && assignment.reconnectToken !== null) {
      tournamentMatchStartPopup.setAssignment(assignment)
    } else if (assignment === null) {
      tournamentMatchStartPopup.setAssignment(null)
    }
  },
  onTournamentRoundTransitionAssignment: (assignment) => {
    // STATE B (generic across R16->QF/QF->SF/SF->Final) — silently seat-attach
    // via the Phase 1 resume_room {silent:true} protocol so the round starts
    // on time even while the lobby keeps showing the unified inter-round
    // screen, and arm activeRoom's watch so it can enter gameplay itself the
    // instant the room's tournamentAttendance resolves — no visible
    // navigation here, unlike the old direct (non-silent) resumeRoom call.
    tournamentMatchStartPopup.clearAssignmentForRoom(assignment.roomId)
    attemptTournamentRoundTransitionSilentAttach(assignment)
  },
  onTournamentSemifinalResultAckNeeded: (tournamentId, semifinalMatchId) => {
    client.acknowledgeTournamentSemifinalResult(tournamentId, semifinalMatchId)
  },
  onTournamentUnlock: (tournamentId, password) => unlockTournamentDetail(tournamentId, password),
  onTournamentJoin: (tournamentId, password) => joinTournamentRequest(tournamentId, password),
  onTournamentLeave: (tournamentId) => leaveTournamentRequest(tournamentId),
  onTournamentCancel: (tournamentId) => cancelTournamentRequest(tournamentId),
  onTournamentForceRemoveTeam: (tournamentId, teamId) => forceRemoveTournamentTeamRequest(tournamentId, teamId),
  onTournamentForceRemoveEntry: (tournamentId, entryId) => forceRemoveTournamentEntryRequest(tournamentId, entryId),
  onTournamentScheduleUpdate: (tournamentId, scheduledStartAt) => updateTournamentScheduledStartRequest(tournamentId, scheduledStartAt),
  onTournamentPartnerCandidatesLoad: (tournamentId) => loadTournamentPartnerCandidates(tournamentId),
  onTournamentPartnerCandidatesSearch: (tournamentId, query, signal) => searchTournamentPartnerCandidates(tournamentId, query, signal),
  onPendingTournamentPartnerInvitesLoad: () => loadPendingTournamentPartnerInvites(),
  onTournamentPartnerInviteCreate: (tournamentId, inviteeProfileId, password) => createTournamentPartnerInviteRequest(tournamentId, inviteeProfileId, password),
  onTournamentPartnerInviteRespond: (tournamentId, inviteId, action) => respondTournamentPartnerInviteRequest(tournamentId, inviteId, action),
  onTournamentEconomyNotice: (notice: { reason: TournamentEconomyNoticeReason; amount: number }) => {
    tournamentEconomyNotification.handleIncoming({
      eventId: crypto.randomUUID(),
      reason: notice.reason,
      amount: notice.amount,
    })
  },
  onTournamentEnterActiveMatch: (roomId, reconnectToken) => {
    // Директен resume, огледало на tournamentMatchStartPopup.onEnterTournamentMatch
    // по-долу — тук НЕ показваме showSessionInGameOverlay ("В момента се играе
    // игра с този профил"): този бутон се render-ва само когато t.myActiveMatch
    // вече е authoritative-потвърден мач на ТОЗИ профил (виж
    // renderTournamentMatchAssignmentCallout), не сценарий на конфликт с друга
    // активна сесия. Production инцидент root cause: преди тази поправка бутонът
    // оставаше свързан към предишния (pre-tournamentMatchStartPopup) overlay flow
    // и играчите никога не пращаха resume_room, затова attendance/ready
    // оставаше 0 и мачът приключваше служебно на deadline.
    client.resumeRoom(roomId, reconnectToken)
  },
  onNotifFriendRequestClick: (friendshipId) => {
    const req = lobby?.getPendingFriendRequest(friendshipId)
    if (!req) return
    friendRequestNotification.showRequest({
      friendshipId: req.friendshipId,
      fromProfileId: req.fromProfileId,
      fromDisplayName: req.fromDisplayName,
      fromAvatarUrl: req.fromAvatarUrl,
    })
  },
  onMarkGiftNotificationRead: async (giftId) => {
    try {
      await fetch(`${getApiBaseUrl()}/api/gifts/${encodeURIComponent(giftId)}/read-notification`, {
        method: 'POST',
        credentials: 'include',
      })
    } catch {
      // best-effort — notification already removed from UI
    }
  },
  onMarkAcceptanceNotificationRead: async (friendshipId) => {
    const response = await fetch(
      `${getApiBaseUrl()}/api/friends/${encodeURIComponent(friendshipId)}/read-acceptance`,
      { method: 'POST', credentials: 'include' },
    )
    if (!response.ok) {
      throw new Error(`read-acceptance failed: ${response.status}`)
    }
  },
})

const activeRoom = createActiveRoomFlowController({
  root: rootElement,
  gameAudio,
  isConnected: () => client.isConnected(),
  leaveActiveRoom: (roomId, acceptPenalty = false) => {
    client.leaveActiveRoom(roomId, acceptPenalty)
  },
  submitCutIndex: (roomId, cutIndex) => {
    client.submitCutIndex(roomId, cutIndex)
  },
  submitBidAction: (roomId, action) => {
    client.submitBidAction(roomId, action)
  },
  submitPlayCard: (roomId, cardId, declarationKeys) => {
    client.submitPlayCard(roomId, cardId, declarationKeys)
  },
  resumeHumanControl: (roomId) => {
    client.resumeHumanControl(roomId)
  },
  submitPartnerRating: (roomId, ratingValue) => {
    client.submitPartnerRating(roomId, ratingValue)
  },
  sendReplayVote: (roomId) => {
    client.sendReplayVote(roomId)
  },
  sendLeaveMatchVote: (roomId) => {
    client.sendLeaveMatchVote(roomId)
  },
  sendEmojiReaction: (roomId, emojiId) => {
    client.sendEmojiReaction(roomId, emojiId)
  },
  sendPhraseReaction: (roomId, phraseId) => {
    client.sendPhraseReaction(roomId, phraseId)
  },
  requestPlayerProfile: (roomId, seat) => {
    client.requestPlayerProfile(roomId, seat)
  },
  getFriendshipAction: (profileId) => lobby?.getFriendshipActionForProfile(profileId) ?? null,
  onSendFriendRequest: async (profileId) => {
    const result = await submitFriendRequest(profileId)
    if (result.ok) {
      lobby?.setFriendships(result.friendships)
      return { ok: true, newLabel: 'Поканата е изпратена' }
    }
    return { ok: false, message: result.message }
  },
  onLikeProfile: (profileId) => submitProfileLike(profileId),
  onBlockProfile: async (profileId) => {
    const result = await submitProfileBlock(profileId)
    if ('ok' in result && !result.ok) return { message: result.message }
    return { message: 'blocked' in result && result.blocked ? 'Играчът е блокиран.' : 'Операцията не успя.' }
  },
  onBlockProfileFull: (profileId) => submitProfileBlock(profileId),
  showLobby: (errorText = null, leftRoomId = null) => {
    // Ако tournamentMatchStartPopup в момента сочи точно към стаята, която
    // играчът напуска (мач приключил — win/loss/walkover), изчистваме stale
    // assignment-а тук, вместо да оставим countdown-а да замръзне на 00:00
    // и бутонът "Влез в турнира" да сочи към вече затворена/чужда стая.
    if (leftRoomId !== null) {
      tournamentMatchStartPopup.clearAssignmentForRoom(leftRoomId)
    }
    lobby.setConnected(client.isConnected())
    lobby.resetToLobby()
    lobby.setErrorText(errorText)
    void loadAuthSession()
    void attemptPendingChatRefresh()
    requestPwaUpdateApplyAttempt()
  },
  startNewGame: (stake, displayName) => {
    lobby.setConnected(client.isConnected())
    lobby.startMatchmaking(stake, displayName)
    void attemptPendingChatRefresh()
  },
  onGuestTrialReplayRequested: () => {
    lobby.setConnected(client.isConnected())
    lobby.startMatchmaking(GUEST_TRIAL_STAKE)
  },
  fetchTournamentDetail: async (tournamentId) => {
    const result = await loadTournamentDetail(tournamentId)
    return result.ok ? result.tournament : null
  },
  acknowledgeTournamentSemifinalResult: (tournamentId, semifinalMatchId) => {
    client.acknowledgeTournamentSemifinalResult(tournamentId, semifinalMatchId)
  },
  onEnterWaitingForNextTournamentRound: (_feeder, tournamentId, result) => {
    currentFeederWaitingState = null
    tournamentFeederWaitingStrip.setState(null)
    lobby?.showTournamentInterRoundPendingResult(tournamentId, result)
  },
  onTournamentFinalResultContinue: (tournamentId) => {
    currentFeederWaitingState = null
    tournamentFeederWaitingStrip.setState(null)
    tournamentMatchStartPopup.setAssignment(null)
    lobby?.showTournamentDetail(tournamentId)
  },
  requestBidResync: () => {
    // Съществуващият resume_room round-trip е безопасен/идемпотентен дори
    // ако тази връзка вече е коректно attach-ната към стаята (виж
    // tryResumeRoomForConnection на сървъра — при съвпадащ roomId/token
    // връща веднага, БЕЗ state мутация, но пак праща room_resumed + свеж
    // room_snapshot). Не изобретяваме нов resync protocol.
    requestActiveRoomResume()
  },
  forceReconnectForZombieConnection: () => {
    // client.disconnect() затваря socket-а; регистрираният 'close' listener
    // (onClose по-долу) каскадно води до СЪЩЕСТВУВАЩия
    // scheduleServerReconnect() -> onOpen -> requestActiveRoomResume flow —
    // същият механизъм, който вече обработва реален connection loss.
    // isZombieBidReconnectInFlight маркира ТОЗИ конкретен reconnect цикъл,
    // за да не бъде пренасочен от onOpen() към forceOfflineLobbyReload()
    // (виж флага при декларацията му) — само за explicit bid-recovery
    // случая, не за нормален connection loss.
    isZombieBidReconnectInFlight = true
    client.disconnect()
  },
})

const tournamentFeederWaitingStripContainer = document.createElement('div')
tournamentFeederWaitingStripContainer.id = 'global-tournament-feeder-waiting-strip'
document.body.appendChild(tournamentFeederWaitingStripContainer)

const tournamentFeederWaitingStrip = createTournamentFeederWaitingStrip({
  container: tournamentFeederWaitingStripContainer,
})
let currentFeederWaitingState: TournamentFeederWaitingState | null = null

const tournamentMatchStartNotifContainer = document.createElement('div')
tournamentMatchStartNotifContainer.id = 'global-tournament-match-start-notifications'
document.body.appendChild(tournamentMatchStartNotifContainer)

const tournamentMatchStartPopup = createTournamentMatchStartPopup({
  container: tournamentMatchStartNotifContainer,
  isInOtherActiveGame: () => activeRoom.getActiveNonTournamentRoomInfo(),
  isViewingAssignedRoom: (roomId) => activeRoom.getCurrentRoomId() === roomId,
  onEnterTournamentMatch: (assignment) => {
    if (assignment.reconnectToken === null) return
    client.resumeRoom(assignment.roomId, assignment.reconnectToken)
  },
  onLeaveAndEnterTournamentMatch: (assignment, conflictRoomId) => {
    pendingTournamentEntryAfterLeave = assignment
    client.leaveActiveRoom(conflictRoomId, true)
  },
})

window.setInterval(() => tournamentMatchStartPopup.tick(), 1000)

const tournamentReclaimModalContainer = document.createElement('div')
tournamentReclaimModalContainer.id = 'global-tournament-reclaim-modal'
document.body.appendChild(tournamentReclaimModalContainer)

// Blocking "Поеми играта" modal (§"BLOCKING MODAL" / "ОСНОВЕН ПРИНЦИП" в
// допълнението) — vezan е към ACTIVE TOURNAMENT PARTICIPATION lifecycle-а
// на профила, НЕ към lifecycle-а на един конкретен match/room. Затова не
// пази assignment/destination state тук — currentTournamentReclaimTournamentId
// пази само КОЙ турнир в момента изисква връщане; конкретният destination
// (attendance/countdown/gameplay/STATE A/STATE B) се re-resolve-ва ИЗЦЯЛО
// наново при всеки re-check (login/reconnect push, match completion push,
// и особено при самия button click — виж resolveAndRouteTournamentReturn
// по-долу), никога от кеширан snapshot.
const tournamentReclaimModal = createTournamentReclaimModal({
  container: tournamentReclaimModalContainer,
  onReclaimClick: () => {
    void resolveAndRouteTournamentReturn(currentTournamentReclaimTournamentId, { fromButtonClick: true })
  },
})
let currentTournamentReclaimTournamentId: string | null = null

// Единствената authoritative проверка "трябва ли да блокирам сайта за този
// турнир" + "къде да route-на при click" (§"НЕ ВРЪЗВАЙ BLOCKING MODAL САМО
// С ACTIVE ROOM" в допълнението) — fetch-va СЪЩИЯ tournament detail endpoint,
// който вече храни tournament-detail екрана, и минава през
// resolveTournamentReturnDestination (myActiveMatch/myInterRoundWaiting).
// null резултат = authoritative "no active participation" (elimination/
// finished/terminal) — единственото легитимно основание да СЕ затвори modal-ът
// автоматично; всякакво друго non-null поддържа/route-ва modal-а нататък.
async function resolveAndRouteTournamentReturn(
  tournamentId: string | null,
  options: { fromButtonClick: boolean } = { fromButtonClick: false },
): Promise<void> {
  if (tournamentId === null) return
  const result = await loadTournamentDetail(tournamentId)
  if (!result.ok) {
    // Detail fetch неуспешен (напр. временна мрежова грешка) — не затваряй
    // modal-а спекулативно на base на нищо, задръж текущото видимо
    // състояние до следващия authoritative re-check.
    return
  }
  // КЛЮЧОВА ПОПРАВКА (§"КРИТИЧНО РАЗГРАНИЧЕНИЕ" в допълнението): "активно
  // tournament participation" (destination !== null) НЕ е доказателство за
  // force-return — нормален participant, който лично е играл, също се
  // вижда в STATE A/B. Единственото authoritative "трябва да покажа
  // blocking modal" условие е isTournamentForceReturnRequired
  // (viewerHasUnresolvedBotReplacement, computed server-side от реални
  // tournament_match_no_show_replacements редове), проверено ПЪРВО.
  if (!isTournamentForceReturnRequired(result.tournament)) {
    if (currentTournamentReclaimTournamentId === tournamentId) {
      currentTournamentReclaimTournamentId = null
      tournamentReclaimModal.hide()
    }
    return
  }
  const destination = resolveTournamentReturnDestination(result.tournament)
  if (destination === null) {
    // Force-return е бил TRUE, но вече няма active destination — team-ът е
    // елиминиран/турнирът е приключил за профила. Authoritative "no active
    // participation" сигнал, единственото друго легитимно основание за
    // auto-close, редом до successful reclaim (виж room_resumed handler-а).
    currentTournamentReclaimTournamentId = null
    tournamentReclaimModal.hide()
    return
  }
  currentTournamentReclaimTournamentId = tournamentId
  tournamentReclaimModal.show(result.tournament.name)
  if (!options.fromButtonClick) return
  // Само реален click route-ва някъде — самото show()/re-resolve при push
  // не трябва да "скача" автоматично никъде, само да update-не modal-а.
  switch (destination.kind) {
    case 'state-a':
    case 'state-b': {
      // §"AUTHORITATIVE RETURN ACTION" във второто допълнение — STATE A/B
      // нямат runnable match/room да swap-нат (за разлика от gameplay по-
      // долу), затова тук е единственото място, където трябва explicit
      // server-side "human се върна" action, за да не остане persisted
      // replacement ред 'active' завинаги само защото играчът е navigate-нал
      // към detail екрана. Ако acknowledge fail-не, НЕ навигираме — modal-ът
      // остава видим и requirement-ът legitimately остава true (виж
      // ACKNOWLEDGE_BOT_RETURN_FAILURE_MESSAGES в index.ts).
      const ack = await acknowledgeTournamentBotReturn(tournamentId)
      if (!ack.ok) {
        if (ack.reason === 'beta_access_required') {
          currentTournamentReclaimTournamentId = null
          tournamentReclaimModal.hide()
          lobby.openTournamentBetaAccessModal()
        }
        return
      }
      currentTournamentReclaimTournamentId = null
      tournamentReclaimModal.hide()
      lobby.navigateToTournamentDetail(destination.tournamentId)
      return
    }
    case 'attendance':
    case 'countdown':
    case 'gameplay': {
      // reuse съществуващия resume_room flow. tryTakeoverNoShowBot на
      // сървъра вече покрива И countdown (бот е седнал на мястото от
      // момента на bot-fill resolution-а, доста преди gameplay да
      // стартира), не само истински in_progress gameplay — виж
      // ensureTournamentBotsInRuntime в tournamentCoordinator.ts.
      const { assignment } = destination
      if (assignment.reconnectToken === null) return
      client.resumeRoom(assignment.roomId, assignment.reconnectToken)
      return
    }
  }
}

// Server-authoritative "human се върна" action ИЗВЪН gameplay (§"AUTHORITATIVE
// RETURN ACTION" във второто допълнение) — reuse на съществуващия
// tournament_match_no_show_replacements lifecycle (markReplacementCompletedStatement),
// идентично на gameplay reclaim пътя, само без room/seat swap. Idempotent
// (двоен click връща alreadyResolved:true, не грешка).
async function acknowledgeTournamentBotReturn(
  tournamentId: string,
): Promise<{ ok: true } | { ok: false; reason?: string }> {
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/tournaments/${encodeURIComponent(tournamentId)}/acknowledge-bot-return`, {
      method: 'POST',
      credentials: 'include',
    })
    const data = (await response.json()) as { ok: boolean; reason?: string }
    return response.ok && data.ok ? { ok: true } : { ok: false, reason: data.reason }
  } catch {
    return { ok: false }
  }
}

function clearReconnectTimer(): void {
  if (reconnectTimerId === null) {
    return
  }

  window.clearTimeout(reconnectTimerId)
  reconnectTimerId = null
}

function scheduleServerReconnect(): void {
  if (isPageUnloading || reconnectTimerId !== null) {
    return
  }

  const delayMs = Math.min(
    SERVER_RECONNECT_DELAY_MS + reconnectAttempt * SERVER_RECONNECT_DELAY_MS,
    SERVER_RECONNECT_MAX_DELAY_MS,
  )

  reconnectAttempt += 1
  reconnectTimerId = window.setTimeout(() => {
    reconnectTimerId = null
    client.connect()
  }, delayMs)
}

// STATE B silent attach (§ "SILENT ATTACH") — shared by the lobby's
// onTournamentRoundTransitionAssignment (first attempt, fired once
// myActiveMatch is round_transition) and the tournament_match_assigned
// handler below (retry vehicle: the coordinator re-sends this message on
// every tick for every runnable match, so a failed first attempt gets
// naturally retried on the next tick once silentAttachedRoundTransitionRoomId
// is cleared — see the room_resume_failed handler — without a new client
// timer/poll). Guarded by silentAttachedRoundTransitionRoomId so a
// successful attach is never re-sent.
function attemptTournamentRoundTransitionSilentAttach(assignment: TournamentMatchAssignmentSnapshot): void {
  if (assignment.reconnectToken === null) return
  if (silentAttachedRoundTransitionRoomId === assignment.roomId) return
  silentAttachedRoundTransitionRoomId = assignment.roomId
  activeRoom.armPendingTournamentSilentEntry({
    roomId: assignment.roomId,
    seat: assignment.seat,
    stake: 5000,
  })
  client.resumeRoom(assignment.roomId, assignment.reconnectToken, true)
}

function requestActiveRoomResume(): boolean {
  const resumeInfo = activeRoom.getResumeInfo()

  if (resumeInfo === null) {
    return false
  }

  client.resumeRoom(resumeInfo.roomId, resumeInfo.reconnectToken)
  return true
}

function showSessionDisplacedOverlay(): void {
  const existing = document.getElementById('session-displaced-overlay')
  if (existing) return

  const overlay = document.createElement('div')
  overlay.id = 'session-displaced-overlay'
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:200000;background:rgba(0,0,0,0.92);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;font-family:Arial,Helvetica,sans-serif;'
  overlay.innerHTML = `
    <div style="font-size:48px;">⚠️</div>
    <div style="font-size:20px;font-weight:900;color:#ffffff;text-align:center;max-width:420px;line-height:1.4;">
      Вече има отворена сесия с този профил на друго устройство или таб.
    </div>
    <div style="font-size:14px;color:rgba(255,255,255,0.55);text-align:center;">
      Тази сесия е деактивирана.
    </div>
  `
  document.body.appendChild(overlay)
}

/**
 * Споделен forced-exit moderation popup (round 4 брифа §8) — ЕДИНСТВЕНАТА
 * имплементация на 20-секундния countdown modal, ползвана И от BAN, И от
 * DELETE enforcement (session_banned/session_deleted WS съобщения), вместо
 * два дублирани countdown механизма. Blocking — няма X/Escape/click-outside
 * close, единствено OK бутон или countdown expiry (00:00) водят до
 * onForcedLogout(), и двата пътя idempotent (guard-нати чрез closed флаг,
 * timer винаги clearInterval-нат преди да extractnе, за да няма multiple
 * intervals дори при (теоретично) повторно извикване).
 */
function showModerationForcedExitPopup(input: {
  title: string
  bodyHtml: string
  onForcedLogout: () => void
}): void {
  const existing = document.getElementById('moderation-forced-exit-popup')
  existing?.remove()

  const COUNTDOWN_START_SECONDS = 20
  let remainingSeconds = COUNTDOWN_START_SECONDS
  let intervalId: ReturnType<typeof setInterval> | null = null
  let closed = false

  const host = document.createElement('div')
  host.id = 'moderation-forced-exit-popup'
  host.style.cssText = 'position:fixed;inset:0;z-index:210000;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,0.82);font-family:Arial,Helvetica,sans-serif;'
  host.innerHTML = `
    <div role="dialog" aria-modal="true" style="position:relative;width:min(92vw,440px);border-radius:8px;border:2px solid rgba(248,113,113,0.55);background:linear-gradient(180deg,rgba(32,32,32,0.98) 0%,rgba(8,8,8,0.99) 100%);box-shadow:0 34px 80px rgba(0,0,0,0.48);padding:24px;">
      <div style="font-size:22px;font-weight:900;color:#f8fafc;margin-bottom:14px;">${escapeHtmlMain(input.title)}</div>
      ${input.bodyHtml}
      <div id="moderation-forced-exit-countdown" style="font-size:13px;color:rgba(148,163,184,0.85);margin:14px 0 18px;">
        Автоматичен изход след: ${COUNTDOWN_START_SECONDS} сек.
      </div>
      <button id="moderation-forced-exit-ok" type="button" style="width:100%;height:44px;border:0;border-radius:8px;background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;font-size:15px;font-weight:900;cursor:pointer;font-family:inherit;">
        OK
      </button>
    </div>
  `
  document.body.appendChild(host)

  const countdownEl = host.querySelector<HTMLElement>('#moderation-forced-exit-countdown')

  const finish = () => {
    if (closed) return
    closed = true
    if (intervalId !== null) {
      clearInterval(intervalId)
      intervalId = null
    }
    host.remove()
    input.onForcedLogout()
  }

  intervalId = setInterval(() => {
    remainingSeconds -= 1
    if (remainingSeconds <= 0) {
      finish()
      return
    }
    if (countdownEl) {
      countdownEl.textContent = `Автоматичен изход след: ${remainingSeconds} сек.`
    }
  }, 1000)

  host.querySelector<HTMLButtonElement>('#moderation-forced-exit-ok')?.addEventListener('click', finish)
}

function removeLandingOverlay(): void {
  document.getElementById('pwa-landing-overlay')?.remove()
  document.body.style.overflow = ''
}

function playPlayerSeatFillSound(): void {
  const audio = new Audio('/audio/ui/player-seat-fill.mp3')
  audio.volume = 0.6
  void audio.play().catch(() => {/* autoplay policy */})
}

function showCoinsGiftedPopup(amount: number, fromDisplayName: string): void {
  const existing = document.getElementById('coins-gifted-popup')
  existing?.remove()
  playPlayerSeatFillSound()

  const host = document.createElement('div')
  host.id = 'coins-gifted-popup'
  host.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,0.72);-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);font-family:Arial,Helvetica,sans-serif;'

  host.innerHTML = `
    <div role="dialog" aria-modal="true" style="position:relative;width:min(92vw,400px);border-radius:12px;border:2px solid rgba(212,165,32,0.72);background:linear-gradient(180deg,rgba(32,32,32,0.98) 0%,rgba(8,8,8,0.99) 100%);box-shadow:0 34px 80px rgba(0,0,0,0.48);padding:32px 28px;display:flex;flex-direction:column;align-items:center;gap:18px;text-align:center;">
      <div style="width:56px;height:56px;border-radius:999px;background:linear-gradient(180deg,rgba(212,165,32,0.18) 0%,rgba(212,165,32,0.08) 100%);border:2px solid rgba(212,165,32,0.50);display:flex;align-items:center;justify-content:center;font-size:28px;">🪙</div>
      <div>
        <div style="font-size:20px;font-weight:900;color:#f8fafc;line-height:1.2;">${escapeHtmlMain(fromDisplayName)} ви подари</div>
        <div style="font-size:26px;font-weight:900;color:#f4c95b;margin-top:6px;">${amount.toLocaleString('bg-BG')} жълтици</div>
      </div>
      <button id="coins-gifted-ok" type="button" style="width:100%;height:44px;border:0;border-radius:8px;background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);color:#080808;font-size:15px;font-weight:900;cursor:pointer;font-family:inherit;">OK</button>
    </div>
  `

  document.body.appendChild(host)
  host.querySelector<HTMLButtonElement>('#coins-gifted-ok')?.addEventListener('click', () => host.remove())
}

function escapeHtmlMain(value: string): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function showSessionInGameOverlay(roomId: string, reconnectToken: string): void {
  const existing = document.getElementById('session-in-game-overlay')
  if (existing) return

  const overlay = document.createElement('div')
  overlay.id = 'session-in-game-overlay'
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:200000;background:rgba(0,0,0,0.92);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;font-family:Arial,Helvetica,sans-serif;'
  overlay.innerHTML = `
    <div style="font-size:48px;">🎮</div>
    <div style="font-size:20px;font-weight:900;color:#ffffff;text-align:center;max-width:420px;line-height:1.4;">
      В момента се играе игра с този профил.
    </div>
    <div style="font-size:14px;color:rgba(255,255,255,0.55);text-align:center;max-width:380px;">
      Можеш да се върнеш в играта от това устройство, но другата сесия ще бъде прекратена.
    </div>
    <button data-session-rejoin="1" style="margin-top:8px;padding:14px 32px;border:0;border-radius:8px;background:#d4a520;color:#000000;font-size:16px;font-weight:900;cursor:pointer;letter-spacing:0.04em;">
      Върни ме в играта
    </button>
  `
  document.body.appendChild(overlay)

  overlay.querySelector('[data-session-rejoin="1"]')?.addEventListener('click', () => {
    removeLandingOverlay()
    overlay.remove()
    client.resumeRoom(roomId, reconnectToken)
  })
}

client = createGameServerClient({
  onOpen: () => {
    clearReconnectTimer()
    reconnectAttempt = 0

    if (connectionErrorTimerId !== null) {
      clearTimeout(connectionErrorTimerId)
      connectionErrorTimerId = null
    }

    // Връзката е успешно възстановена — reconnect-ът вече не е "в ход",
    // независимо дали resume-ваме активна стая или се връщаме в чист lobby.
    // activeRoom.hasActiveRoom() продължава самостоятелно да блокира apply
    // по време на самата игра/resume; този флаг само не бива да остава
    // "заклещен" true завинаги след като играта приключи.
    pwaIsReconnectingActiveRoom = false

    // Silent attach failure/retry (§ "SILENT ATTACH FAILURE / RETRY") — a WS
    // drop between sending resume_room{silent:true} and receiving a response
    // never fires room_resume_failed, so without this the guard would stay
    // permanently stuck (same failure mode as an explicit rejection, just
    // silent). The new connection.id makes any prior silent attach stale
    // server-side anyway (tryResumeRoomForConnection is keyed to
    // connection.id) — resetting here lets the next tournament_match_assigned
    // tick or tournament-detail fetch retry; resume_room is idempotent, so a
    // harmless duplicate if the original attempt actually did succeed. Mirrors
    // the existing lobby private-room resync hook below for the same class of
    // "silently-held state might be stale after reconnect".
    if (silentAttachedRoundTransitionRoomId !== null) {
      activeRoom.clearPendingTournamentSilentEntry(silentAttachedRoundTransitionRoomId)
      silentAttachedRoundTransitionRoomId = null
    }

    // Explicit bid-recovery reconnect (forceReconnectForZombieConnection) —
    // винаги тих resume в СЪЩАТА активна стая, никога forceOfflineLobbyReload
    // navigation, дори shouldReloadLobbyOnReconnect да е сетнат от
    // showOfflineConnectionOverlay() по-рано в същия close/reconnect цикъл.
    // Едностреличен bypass: консумира се веднага, не остава "заклещен".
    if (isZombieBidReconnectInFlight) {
      isZombieBidReconnectInFlight = false
      if (activeRoom.hasActiveRoom()) {
        shouldReloadLobbyOnReconnect = false
        activeRoom.setConnectionState(true, SERVER_RESUME_WAIT_MESSAGE)
        requestActiveRoomResume()
        return
      }
      // Стаята вече не е активна (играчът е напуснал междувременно по друг
      // път) — продължи по нормалния flow по-долу, все едно случаят никога
      // не е бил "zombie bid reconnect".
    }

    if (shouldReloadLobbyOnReconnect) {
      forceOfflineLobbyReload()
      return
    }

    if (activeRoom.hasActiveRoom()) {
      activeRoom.setConnectionState(true, SERVER_RESUME_WAIT_MESSAGE)
      requestActiveRoomResume()
      return
    }

    if (!_isResetPasswordPath) {
      lobby.setConnected(true)
      lobby.setErrorText(null)
      // Нова WS връзка = нов connection.id на сървъра, старият lobby chat
      // subscribe (ако имаше такъв на предишната връзка) вече не важи там.
      // Форсира свеж subscribe_lobby_chat САМО ако клиентът реално е на
      // началния екран в момента на reconnect-а (виж коментара над
      // reconcileLobbyChatSubscription в createLobbyFlowController.ts).
      lobby.forceLobbyChatResubscribeIfOnLobbyScreen()
      // Огледално, но за Topics realtime (Етап 2) — нов connection.id прави
      // старата WS subscription невалидна server-side. Resubscribe-ва с
      // gap-closing afterSeq САМО ако клиентът реално е на "Теми" екрана.
      lobby.forceTopicMessagesResubscribeIfOnTopicsScreen()
      // Огледално, но за directory-wide "нова тема се появи" interest
      // (Custom Topic Creation) — mirror на горното.
      lobby.forceTopicsDirectoryResubscribeIfOnTopicsScreen()
      // Огледално на горното, но за членство в частна маса: ако потребителят
      // е бил в чакалня на частна маса (или е избрал "Изчакай в лоби") към
      // момента на прекъсването/презареждането (кратка мобилна връзка,
      // screen lock, Wi-Fi/4G смяна, F5), server-side членството в
      // privateRoomsStore все още сочи към стария (мъртъв) connection.id.
      // request_private_rooms_list е единственият тригер за server-side
      // reconnectMember() — вика се безусловно (виж коментара в
      // createLobbyFlowController.ts), за да проработи и след hard refresh,
      // когато state.myPrivateRoom вече не помни нищо локално.
      lobby.resyncPrivateRoomMembership()
    }

    requestPwaUpdateApplyAttempt()
  },
  onClose: () => {
    if (isSessionDisplaced || isPageUnloading || isModerationForcedExitPending) {
      return
    }

    if (isRefreshingAuthConnection) {
      isRefreshingAuthConnection = false
      lobby.setConnected(false)
      client.connect()
      return
    }

    showOfflineConnectionOverlay()

    if (activeRoom.hasActiveRoom()) {
      shouldReloadLobbyOnReconnect = true
      pwaIsReconnectingActiveRoom = true
      activeRoom.setConnectionState(false, SERVER_RESTART_WAIT_MESSAGE)
      scheduleServerReconnect()
      return
    }

    shouldReloadLobbyOnReconnect = true
    if (!_isResetPasswordPath) {
      lobby.setConnected(false)
      scheduleServerReconnect()

      connectionErrorTimerId = window.setTimeout(() => {
        connectionErrorTimerId = null
        lobby.setErrorText(SERVER_RESTART_WAIT_MESSAGE)
      }, 1500)
    }
  },
  onError: () => {
    if (activeRoom.hasActiveRoom()) {
      activeRoom.setConnectionError(SERVER_CONNECTION_ERROR_MESSAGE)
      return
    }

    if (!_isResetPasswordPath) {
      lobby.setErrorText(SERVER_CONNECTION_ERROR_MESSAGE)
    }
  },
  onMessage: (message) => {
    if (message.type === 'connected') {
      handleConnectedServerMessage(lobby, message, () => {
        pwaBootstrapServerStateResolved = true
        requestPwaUpdateApplyAttempt()
      })
      return
    }

    if (message.type === 'session_displaced') {
      isSessionDisplaced = true
      showSessionDisplacedOverlay()
      return
    }

    if (message.type === 'session_banned') {
      // Immediate/deferred-then-fired ban enforcement за online профил
      // (round 4 брифа §3/§5) — споделеният 20-сек countdown popup
      // (showModerationForcedExitPopup), НЕ старото login-time PROFILE_BANNED
      // popup (това е за unauthenticated login опит, различен сценарий).
      // Local logout се извършва ЕДИНСТВЕНО при OK/countdown expiry
      // (onForcedLogout), не веднага при получаване на съобщението —
      // потребителят трябва да прочете причината/срока преди да бъде изваден.
      //
      // isModerationForcedExitPending=true ПРЕДИ showModerationForcedExitPopup
      // (round 5 fix) — сървърът затваря socket-а веднага след това съобщение;
      // без флага onClose() би стартирал нормалния reconnect flow, който при
      // успешен reconnect навигира ЦЯЛАТА страница (forceOfflineLobbyReload)
      // и маха popup-а много преди 20-те секунди да изтекат (виж
      // isModerationForcedExitPending декларацията за пълния lifecycle).
      isModerationForcedExitPending = true
      const untilDate = new Date(message.bannedUntil)
      const untilText = Number.isFinite(untilDate.getTime())
        ? untilDate.toLocaleString('bg-BG', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
        : '—'
      const daysWord = message.remainingDays === 1 ? 'ден' : 'дни'
      showModerationForcedExitPopup({
        title: 'Профилът е баннат',
        bodyHtml: `
          <div style="font-size:15px;line-height:1.55;color:rgba(226,232,240,0.88);margin-bottom:10px;">
            Този профил е баннат за ${message.remainingDays} ${daysWord}.
          </div>
          <div style="font-size:14px;line-height:1.5;color:rgba(226,232,240,0.78);margin-bottom:10px;">
            Причина: ${escapeHtmlMain(message.reason)}
          </div>
          <div style="font-size:13px;color:rgba(148,163,184,0.85);">
            Банът изтича на: ${escapeHtmlMain(untilText)}
          </div>
        `,
        onForcedLogout: () => {
          isModerationForcedExitPending = false
          performLocalLogoutAfterBanOrDelete()
        },
      })
      return
    }

    if (message.type === 'session_deleted') {
      // Immediate/deferred-then-fired access cutoff за online профил, тъкмо
      // hard-deleted от admin (round 4 брифа §4/§6) — същият споделен
      // 20-сек countdown popup mechanism. Виж коментара при session_banned
      // по-горе за isModerationForcedExitPending.
      isModerationForcedExitPending = true
      showModerationForcedExitPopup({
        title: 'Профилът е изтрит',
        bodyHtml: `
          <div style="font-size:15px;line-height:1.55;color:rgba(226,232,240,0.88);margin-bottom:10px;">
            Този профил беше изтрит от администратор.
          </div>
          <div style="font-size:14px;line-height:1.5;color:rgba(226,232,240,0.78);margin-bottom:10px;">
            Причина: ${escapeHtmlMain(message.reason)}
          </div>
        `,
        onForcedLogout: () => {
          isModerationForcedExitPending = false
          performLocalLogoutAfterBanOrDelete()
        },
      })
      return
    }

    if (message.type === 'session_in_game') {
      lobby.suspendLobbyChatForActiveRoom()
      showSessionInGameOverlay(message.roomId, message.reconnectToken)
      return
    }

    if (message.type === 'profile_liked') {
      likeNotification.show({
        fromProfileId: message.fromProfileId,
        fromDisplayName: message.fromDisplayName,
        fromAvatarUrl: message.fromAvatarUrl,
      })
      return
    }

    if (message.type === 'partner_rating_submitted') {
      partnerRatingNotification.show({
        raterDisplayName: message.raterDisplayName,
        ratingValue: message.ratingValue,
      })
      return
    }

    if (message.type === 'chat_message_received') {
      const isOwnMessage = currentAuthSession !== null
        && message.senderProfileId === currentAuthSession.profile.profileId
      const isInGameNow = activeRoom.hasActiveRoom()
      const alreadyOpen = !isInGameNow && lobby.isConversationOpen(message.friendshipId)

      if (!isOwnMessage && !alreadyOpen) {
        chatMessageNotification.handleIncoming({
          friendshipId: message.friendshipId,
          messageId: message.messageId,
          fromDisplayName: message.fromDisplayName,
          shouldNotify: message.shouldNotify,
        })
      }

      if (alreadyOpen) {
        // Разговорът е реално отворен и видим — съобщението се смята за
        // веднага прочетено. Маркира се и на СЪРВЪРА (source of truth за
        // shouldNotify при следващи съобщения), не само локално — иначе,
        // ако потребителят излезе от разговора без изричен mark-read клик,
        // следващото съобщение от този подател погрешно пак би получило
        // shouldNotify=false (сървърът все още би виждал стар unread запис).
        void markChatConversationRead(message.friendshipId)
      }

      if (!isInGameNow) {
        lobby.handleServerMessage(message)
      } else if (!isOwnMessage) {
        // Докато сме в игра, chat GET заявки (lobby.handleServerMessage би
        // задействал такава чрез refreshChatAfterNotification) биха 403-нали
        // — виж isProfileInActiveGame на сървъра. Затова тук само отбелязваме,
        // че conversation/unread state е остарял; реалният refresh се случва
        // при следващ сигурен lifecycle момент — виж attemptPendingChatRefresh().
        markPendingChatRefresh()
      }
      return
    }

    if (
      message.type === 'lobby_chat_history' ||
      message.type === 'lobby_chat_message' ||
      message.type === 'lobby_chat_message_deleted' ||
      message.type === 'lobby_chat_error'
    ) {
      // Абонаментът вече се сваля изрично при влизане/възстановяване на игра
      // (suspendLobbyChatForActiveRoom), затова сървърът не би трябвало да
      // праща тези съобщения по време на игра — проверката тук е допълнителна
      // защита, не основният механизъм.
      if (!activeRoom.hasActiveRoom()) {
        lobby.handleServerMessage(message)
      }
      return
    }

    if (message.type === 'pending_friend_requests') {
      lobby.handleServerMessage(message)
      return
    }

    if (message.type === 'friend_request_received') {
      lobby.handleServerMessage(message)
      friendRequestNotification.showRequest({
        friendshipId: message.friendshipId,
        fromProfileId: message.fromProfileId,
        fromDisplayName: message.fromDisplayName,
        fromAvatarUrl: message.fromAvatarUrl,
      })
      return
    }

    if (message.type === 'friend_request_cancelled') {
      lobby.handleServerMessage(message)
      return
    }

    if (message.type === 'friend_request_rejected') {
      lobby.handleServerMessage(message)
      return
    }

    if (message.type === 'pending_acceptance_notifications') {
      lobby.handleServerMessage(message)
      return
    }

    if (message.type === 'tournament_partner_invite_received') {
      lobby.handleServerMessage(message)
      tournamentPartnerInvitePopup.enqueue(message.invite)
      return
    }

    if (message.type === 'tournament_partner_invite_popup_dismissed') {
      lobby.handleServerMessage(message)
      tournamentPartnerInvitePopup.remove(message.inviteId)
      return
    }

    if (message.type === 'tournament_partner_invite_resolved') {
      lobby.handleServerMessage(message)
      tournamentPartnerInvitePopup.remove(message.inviteId)
      return
    }

    if (message.type === 'tournament_match_assigned') {
      activeRoom.completePendingTournamentRoundResultTransition()
      lobby.handleServerMessage(message)
      currentFeederWaitingState = null
      tournamentFeederWaitingStrip.setState(null)
      if (message.assignment.deadlineKind === 'round_transition') {
        // The coordinator re-sends tournament_match_assigned on every tick for
        // every runnable match — this doubles as the retry vehicle for a
        // silent attach that previously failed (guard cleared by
        // room_resume_failed below), independent of which screen is showing,
        // without adding a new client-side poll/timer.
        attemptTournamentRoundTransitionSilentAttach(message.assignment)
        // A → B AUTO NAVIGATION (§ "КЛЮЧОВО: A → B AUTO NAVIGATION") —
        // event-driven auto-return: this push is the authoritative signal
        // that STATE B is ready for this player, regardless of where they
        // currently are in the SPA (lobby home, tournaments list, players,
        // chat, ...). If they're already looking at this exact tournament's
        // detail screen, navigateToTournamentDetail would just re-fetch and
        // flash the loading state for no reason — getCurrentTournamentDetailId()
        // lets us skip that and leave the in-place STATE A→B transition
        // (already working, driven by fetchTournamentDetail re-renders)
        // alone. lobby.navigateToTournamentDetail is the SAME function the
        // tournaments list "Отвори" click uses — no second renderer, no
        // polling: this fires exactly once per assignment, straight from the
        // WS push.
        if (lobby.getCurrentTournamentDetailId() !== message.assignment.tournamentId) {
          lobby.navigateToTournamentDetail(message.assignment.tournamentId)
        }
      }
      // Generic across every round transition (R16->QF/QF->SF/SF->Final, not
      // just the final) — the unified lobby STATE A/B overlay is the single,
      // UNCONDITIONAL owner of this UX for round_transition assignments,
      // regardless of which lobby screen is currently showing. Gating this on
      // lobby?.getCurrentScreen() === 'tournament-detail' used to let the
      // global popup (and its non-silent onEnterTournamentMatch ->
      // client.resumeRoom without silent:true -> room_resumed -> unconditional
      // enterActiveRoomFromResume in the room_resumed handler below) race the
      // silent attach armed above: any WS push landing while the player is on
      // a different lobby screen — e.g. still on the tournaments list, or
      // between screens during fetchTournamentDetail — set the popup's
      // assignment, and tournamentMatchStartPopup's own render() only hides
      // itself once activeRoom.getCurrentRoomId() matches, which stays null
      // during the whole STATE B silent-attach window. Clicking the popup
      // then bypassed isTournamentAttendanceReadyForSilentEntry entirely,
      // producing the raw activeRoom attendance screen alongside STATE B.
      // Only 'first_match' assignments (a real new tournament entry) still use
      // the global popup as a fallback for "navigated away".
      if (message.assignment.deadlineKind === 'round_transition') {
        tournamentMatchStartPopup.clearAssignmentForRoom(message.assignment.roomId)
        return
      }
      // §"КРИТИЧНО РАЗГРАНИЧЕНИЕ" в допълнението — самото "не съм attach-нат
      // към собствената си стая" НЕ доказва bot-replacement (нормален
      // late-но-still-within-attendance играч е точно в това състояние преди
      // да е дошъл replacement). Затова тук НЕ решаваме директно дали да
      // покажем blocking modal-а от самия assignment push — винаги
      // делегираме на resolveAndRouteTournamentReturn, който прави fresh
      // authoritative detail fetch и проверява viewerHasUnresolvedBotReplacement
      // ПЪРВО. Ако force-return не е TRUE (attendance/countdown преди bot
      // insertion — §"ATTENDANCE LOGIN ПРЕДИ DEADLINE"/"COUNTDOWN LOGIN"),
      // функцията просто не показва modal-а — авто-влизането в правилния
      // (attendance/countdown) екран става чрез същия silent resume по-долу,
      // а не чрез blocking UI.
      if (activeRoom.getCurrentRoomId() !== message.assignment.roomId) {
        tournamentMatchStartPopup.clearAssignmentForRoom(message.assignment.roomId)
        void resolveAndRouteTournamentReturn(message.assignment.tournamentId).then(() => {
          // Ако force-return НЕ е бил TRUE (нормален участник, все още преди
          // bot insertion — §"ATTENDANCE LOGIN ПРЕДИ DEADLINE"/"COUNTDOWN
          // LOGIN"), resolveAndRouteTournamentReturn само скри евентуален
          // stale modal и не route-ва (fromButtonClick е false по default) —
          // трябва отделен, безусловен normal resume тук, за да влезе играчът
          // автоматично в attendance/countdown екрана си БЕЗ бутон.
          // tournamentReclaimModal.isVisible() различава двата пътя без
          // повторно пресмятане на force-return тук. Нормален (не-silent)
          // resume — за разлика от STATE B silent attach, тук няма нужда от
          // armPendingTournamentSilentEntry watch, room_resumed вече рендира
          // правилния attendance/countdown екран directno.
          if (!tournamentReclaimModal.isVisible() && message.assignment.reconnectToken !== null) {
            client.resumeRoom(message.assignment.roomId, message.assignment.reconnectToken)
          }
        })
        return
      }
      if (currentTournamentReclaimTournamentId === message.assignment.tournamentId) {
        currentTournamentReclaimTournamentId = null
        tournamentReclaimModal.hide()
      }
      if (message.assignment.reconnectToken !== null) {
        tournamentMatchStartPopup.setAssignment(message.assignment)
      } else {
        tournamentMatchStartPopup.clearAssignmentForRoom(message.assignment.roomId)
      }
      return
    }

    // Login/reconnect докато профилът е между кръгове, без runnable match в
    // момента (STATE A/B — виж коментара на server-side push-а в index.ts).
    if (message.type === 'tournament_active_participation') {
      void resolveAndRouteTournamentReturn(message.tournamentId)
      return
    }

    if (message.type === 'tournament_feeder_match_completed') {
      lobby.handleServerMessage(message)
      // §"CORRECT MATCH-COMPLETION HANDLING" в допълнението — КРИТИЧНА
      // поправка: match completion сам по себе си НЕ доказва elimination
      // (ако bot-controlled team-ът е спечелил, участието продължава към
      // STATE A/STATE B). Затова НИКОГА не затваряме modal-а директно тук —
      // винаги re-resolve-ваме authoritative state (fresh detail fetch);
      // resolveAndRouteTournamentReturn само тогава решава дали да затвори
      // (destination === null, т.е. team наистина елиминиран/tournament
      // приключил за профила) или да update-не modal-а към новия destination
      // (STATE A/STATE B/следващ match), без auto-route (fromButtonClick: false).
      if (currentTournamentReclaimTournamentId === message.tournamentId) {
        void resolveAndRouteTournamentReturn(message.tournamentId)
      }
      if (currentFeederWaitingState !== null) {
        currentFeederWaitingState = {
          ...currentFeederWaitingState,
          status: 'completed',
          scoreA: message.finalScoreTeamA,
          scoreB: message.finalScoreTeamB,
        }
        tournamentFeederWaitingStrip.setState(currentFeederWaitingState)
      }
      activeRoom.handleServerMessage(message)
      return
    }

    // Live feeder резултат, докато чакащият (walkover или нормално спечелил)
    // отбор е обратно в лобито и вижда tournamentFeederWaitingStrip-а (§2/§7
    // в task spec-а: "Live score update-ите се получават без refresh") —
    // без този клон съобщението стигаше само до createActiveRoomFlowController,
    // но там няма активна стая, в която да го рендира (играчът вече е напуснал
    // active-room flow-а), затова лентата никога не се обновяваше на живо.
    if (message.type === 'tournament_feeder_score_progress') {
      lobby.handleServerMessage(message)
      if (currentFeederWaitingState !== null) {
        currentFeederWaitingState = {
          ...currentFeederWaitingState,
          status: 'in_progress',
          scoreA: message.scoreTeamA,
          scoreB: message.scoreTeamB,
        }
        tournamentFeederWaitingStrip.setState(currentFeederWaitingState)
      }
      activeRoom.handleServerMessage(message)
      return
    }

    if (message.type === 'friend_acceptance_notification_read') {
      lobby.handleServerMessage(message)
      return
    }

    if (message.type === 'friend_request_accepted') {
      lobby.handleServerMessage(message)
      // Also show the live 4-second confirmation popup.
      friendRequestNotification.showAccepted({
        fromDisplayName: message.fromDisplayName,
        fromAvatarUrl: message.fromAvatarUrl,
      })
      return
    }

    if (message.type === 'private_room_created_notice') {
      privateRoomCreatedNotification.handleIncoming({
        notificationId: message.notificationId,
        creatorDisplayName: message.creatorDisplayName,
        creatorAvatarUrl: message.creatorAvatarUrl,
        recipientInActiveGame: message.recipientInActiveGame,
      })
      return
    }

    if (message.type === 'tournament_economy_notice') {
      // Defense-in-depth (§"REFUND POPUP СЕ ПОКАЗВА СЛЕД LOGOUT") — ако тази
      // сесия вече няма authenticated profile (напр. logout е приключил, но
      // push-ът е бил in-flight, или е stale по каквато и да е бъдеща причина),
      // popup-ът не трябва да се показва. Известието не се губи — то си остава
      // persistent server-side (tournament_partner_left_notice_log /
      // tournament_economy_notice_log) и се доставя наново при следващия
      // login/reconnect (виж flush блока при connection setup в index.ts).
      // Authoritative fix-ът е server-side (disconnectConnectionsForSession
      // затваря stale socket-а при logout), този guard е само подсигуряване.
      if (currentAuthSession === null) {
        return
      }
      tournamentEconomyNotification.handleIncoming({
        eventId: message.eventId,
        reason: message.reason,
        amount: message.amount,
      })
      // Auto-release realtime update (§ "КОГАТО ЕДИНИЯТ PARTNER СЕ ОТПИШЕ") —
      // ако играчът в момента гледа точно този турнир, освежи detail-а веднага
      // (roster/team state), за да не остане phantom teammate/stale "Чакаме
      // отговор от ..." UI видим след committed auto-release. Не polling —
      // еднократен refetch, задействан от точно този authoritative push,
      // огледално на tournament_feeder_match_completed/tournament_match_assigned.
      if (message.reason === 'partner_left') {
        lobby.handleServerMessage(message)
      }
      return
    }

    if (message.type === 'coins_gifted') {
      if (currentAuthSession !== null) {
        currentAuthSession = {
          ...currentAuthSession,
          profile: {
            ...currentAuthSession.profile,
            yellowCoinsBalance: message.recipientNewBalance,
          },
        }
        syncLobbyWithAuthSession()
      }
      showCoinsGiftedPopup(message.amount, message.fromDisplayName)
      return
    }

    // Defense-in-depth (§3 в task spec-а: "Не изпращай resume_room към
    // приключила или чужда стая") — покрива и рядкия случай, в който
    // tournamentMatchStartPopup вече е показал stale assignment, ПРЕДИ
    // showLobby(..., leftRoomId) да е успял да го изчисти (напр. играчът
    // никога не е влизал в activeRoomState за тази стая — activeRoom.handleServerMessage
    // guard-ва с "if (!activeRoomState) return false" и никога не вижда това
    // съобщение). Идемпотентно — no-op ако popup-ът не сочи към тази стая.
    if (message.type === 'room_resume_failed') {
      tournamentMatchStartPopup.clearAssignmentForRoom(message.roomId)
      // Silent attach failure (§ "SILENT ATTACH FAILURE / RETRY") — without
      // this, silentAttachedRoundTransitionRoomId would stay set forever for
      // this roomId (it's only ever set, never cleared, on the happy path),
      // permanently blocking attemptTournamentRoundTransitionSilentAttach's
      // guard from retrying — leaving the player stuck looking at STATE B
      // with no actual seat attachment while the server counts them absent.
      // Clearing both guards here lets the next tournament_match_assigned
      // tick (or the next tournament-detail fetch) retry cleanly.
      if (silentAttachedRoundTransitionRoomId === message.roomId) {
        silentAttachedRoundTransitionRoomId = null
        activeRoom.clearPendingTournamentSilentEntry(message.roomId)
      }
    }

    // Response to resume_room {silent:true} (STATE B, § "SILENT ATTACH") —
    // seat attachment already happened server-side, identically to
    // room_resumed, but this is intentionally NOT navigation: activeRoom's
    // armPendingTournamentSilentEntry watch (armed alongside the resumeRoom
    // call in onTournamentRoundTransitionAssignment above) picks up the
    // resulting room_snapshot stream and decides when to actually enter.
    if (message.type === 'room_attached_silent') {
      tournamentMatchStartPopup.clearAssignmentForRoom(message.roomId)
      // Same as room_resumed below — silent attach also means the profile is
      // now seated in its own STATE B match, so the blocking requirement no
      // longer applies to it (see the show-condition in
      // tournament_match_assigned above).
      currentTournamentReclaimTournamentId = null
      tournamentReclaimModal.hide()
      return
    }

    if (message.type === 'room_resumed' && !activeRoom.hasActiveRoom()) {
      removeLandingOverlay()
      lobby.suspendLobbyChatForActiveRoom()
      activeRoom.enterActiveRoomFromResume(message.roomId, message.seat, 5000)
      // Reclaim/attach успешен (§"BOT SEAT RECLAIM") — играчът вече Е
      // attach-нат към собствената си стая (attendance/countdown/gameplay),
      // затова "не съм attach-нат" show-условието вече не важи; скрий
      // modal-а веднага вместо да чакаме следващия tournament_match_assigned
      // tick. currentTournamentReclaimTournamentId се nulls тук safe,
      // независимо дали изобщо е бил активен за тази стая.
      currentTournamentReclaimTournamentId = null
      tournamentReclaimModal.hide()
      tournamentMatchStartPopup.clearAssignmentForRoom(message.roomId)
      return
    }

    // "Напусни мача и влез в турнира" (tournamentMatchStartPopup, §4 в task
    // spec-а) праща leave_active_room, после веднага resume_room за
    // турнирната стая на same WS connection — сървърът обработва двете
    // съобщения последователно, затова pending-ът тук просто изчаква
    // left_active_room потвърждение, преди да прати resume_room, вместо
    // client-side race с два fire-and-forget извиквания.
    if (message.type === 'left_active_room' && pendingTournamentEntryAfterLeave !== null) {
      const assignment = pendingTournamentEntryAfterLeave
      pendingTournamentEntryAfterLeave = null
      if (assignment.reconnectToken !== null) {
        client.resumeRoom(assignment.roomId, assignment.reconnectToken)
      }
    }

    if (activeRoom.handleServerMessage(message)) {
      requestPwaUpdateApplyAttempt()
      return
    }

    if (!activeRoom.hasActiveRoom() && !_isResetPasswordPath) {
      lobby.handleServerMessage(message)
    }
    requestPwaUpdateApplyAttempt()
  },
})

const disposeViewportResizeHandler = createViewportResizeHandler(() => {
  const activeElement = document.activeElement
  const isTextInputFocused =
    activeElement instanceof HTMLInputElement ||
    activeElement instanceof HTMLTextAreaElement ||
    activeElement instanceof HTMLSelectElement ||
    activeElement instanceof HTMLElement && activeElement.isContentEditable

  if (isPhoneLayoutViewport() && isTextInputFocused) {
    return
  }

  if (activeRoom.hasActiveRoom()) {
    activeRoom.render()
    return
  }

  if (!_isResetPasswordPath) {
    lobby.render()
  }
})

window.addEventListener('beforeunload', () => {
  isPageUnloading = true
  clearReconnectTimer()
  disposeViewportResizeHandler()
  client.disconnect()
})

const stripeReturnParams = new URLSearchParams(window.location.search)
const stripeReturnScreen = stripeReturnParams.get('screen')
const stripeReturnPayment = stripeReturnParams.get('payment')
const stripeReturnCheckoutSessionId = stripeReturnParams.get('session_id')
const isStripePaymentReturn =
  stripeReturnPayment === 'success' ||
  stripeReturnPayment === 'cancel' ||
  stripeReturnScreen === 'shop'
const offlineReloadParam = stripeReturnParams.get('offlineReload')
const recoveryReloadParam = stripeReturnParams.get('recoveryReload')

// offlineReload е умишлено само /lobby (forceOfflineLobbyReload() винаги
// генерира точно /lobby?offlineReload=...) — непроменен flow.
if (offlineReloadParam !== null && window.location.pathname === '/lobby') {
  history.replaceState(null, '', '/lobby')
}

// recoveryReload (index.html bootstrap recovery) трябва да върне
// потребителя на ТОЧНО пътя, откъдето е тръгнал (/, /lobby, /strategy...),
// не само /lobby — маха се тук, независимо от pathname, без да пипа други
// query параметри или hash.
if (recoveryReloadParam !== null) {
  const cleanedUrl = new URL(window.location.href)
  cleanedUrl.searchParams.delete('recoveryReload')
  history.replaceState(null, '', cleanedUrl.pathname + cleanedUrl.search + cleanedUrl.hash)
}

// main.ts стигна дотук изпълнимо → bootstrap-ът реално успя този път.
// Изчисти auto-retry guard-а от index.html recovery script-а, за да може
// легитимен БЪДЕЩ bootstrap проблем в същата сесия пак да получи един
// автоматичен опит, вместо направо да скача към ръчния бутон.
try {
  sessionStorage.removeItem('pika-bootstrap-recovery-auto-retry')
} catch { /* sessionStorage недостъпен — няма какво да чистим */ }

// Landing страница — показва се само в браузър и без валиден path (не в standalone режим)
// Трябва да е ПРЕДИ lobby.render() за да може syncUrlPath() да я засече
const _initialPath = window.location.pathname
const _VALID_PATHS = new Set([
  '/lobby',
  '/players',
  '/ranking',
  '/tournaments',
  '/topics',
  '/shop',
  '/friends',
  '/chat',
  '/admin',
  '/admin/server',
  '/admin/guest-contact',
  '/admin/visitors',
  '/terms',
  '/privacy',
  '/contact',
  '/rules',
  '/strategy',
  '/learn',
  '/faq',
  '/about',
  '/fair-play',
  '/reset-password',
])
if (!isStripePaymentReturn && !isRunningAsStandalone() && !_VALID_PATHS.has(_initialPath)) {
  showLandingOverlay()
}

if (_isResetPasswordPath) {
  // Читаме token от hash веднага — fragment се изчиства от address bar.
  // Token се пази само в локалната state променлива — никъде другаде.
  const _resetToken = extractAndClearResetToken()

  let _resetState: ResetPasswordScreenState = _resetToken
    ? { phase: 'form', token: _resetToken, errorText: null, submitting: false }
    : { phase: 'no-token' }

  function _renderReset(): void {
    renderResetPasswordScreen(rootElement, _resetState, {
      onGoToLogin: () => {
        window.location.assign('/lobby')
      },
      onSubmit: (token, newPassword) => {
        if (_resetState.phase !== 'form' || _resetState.submitting) return
        _resetState = { phase: 'form', token, errorText: null, submitting: true }
        _renderReset()
        void (async () => {
          const KNOWN_CODES = new Set([
            'INVALID_PASSWORD', 'INVALID_OR_EXPIRED_TOKEN', 'RATE_LIMITED', 'PASSWORD_CHANGED',
          ])
          let responseBody: { ok: boolean; code?: string; message?: string } | null = null
          try {
            const response = await fetch(`${getApiBaseUrl()}/api/auth/reset-password`, {
              method: 'POST',
              credentials: 'include',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ token, newPassword }),
            })
            responseBody = (await response.json()) as typeof responseBody
          } catch {
            responseBody = null
          }
          const rb = responseBody as { ok: boolean; code?: string; message?: string } | null
          if (rb?.code === 'PASSWORD_CHANGED') {
            _resetState = { phase: 'success' }
          } else {
            const errorText =
              rb !== null && rb.message && KNOWN_CODES.has(rb.code ?? '')
                ? rb.message
                : 'Възникна грешка при смяната на паролата. Моля, опитайте отново.'
            _resetState = { phase: 'form', token, errorText, submitting: false }
          }
          _renderReset()
        })()
      },
    })
  }

  _renderReset()
} else if (isStripePaymentReturn) {
  history.replaceState(null, '', '/lobby')
  lobby.resetToLobby()
} else {
  lobby.render()
}

const visitorPageViewTracker = createVisitorPageViewTracker({
  endpointUrl: `${getApiBaseUrl()}/api/visits/page-view`,
  getViewLayout: () => isPhoneLayoutViewport() ? 'mobile' : 'desktop',
})
visitorPageViewTracker.start()

// GDPR consent banner/modal + analytics (AdSense/Meta Pixel) bootstrap —
// самостоятелен от лобито/играта, монтира се директно в document.body и
// работи на всеки екран (виж src/app/consent/consentUi.ts).
mountConsentUi()
initializeAnalytics()

// PWA — тихо автоматично обновяване. Никакъв popup/banner: onNeedRefresh
// само записва pending update-а и моли coordinator-а да прецени дали
// клиентът в момента е в безопасно състояние (виж getPwaSafetyState по-долу
// и pwaUpdateCoordinator.ts за пълния watchdog/retry lifecycle).
initPwa((applyFn) => {
  setPendingPwaUpdate(applyFn)
  requestPwaUpdateApplyAttempt()
})

function getPwaSafetyState(): PwaUpdateSafetyState {
  const pwaSnapshot = lobby.getPwaUpdateSafetySnapshot()
  return {
    bootstrapComplete: pwaBootstrapAuthSessionLoaded && pwaBootstrapGuestStatusLoaded && pwaBootstrapServerStateResolved,
    hasActiveRoom: activeRoom.hasActiveRoom(),
    isSearching: pwaSnapshot.isSearching,
    hasPrivateRoomInvite: pwaSnapshot.hasPrivateRoomInvite,
    hasQueuedPrivateRoomInvites: pwaSnapshot.hasQueuedPrivateRoomInvites,
    isInPrivateRoomsScreen: pwaSnapshot.isInPrivateRoomsScreen,
    isConnected: pwaSnapshot.isConnected,
    isReconnecting: pwaIsReconnectingActiveRoom,
  }
}

function requestPwaUpdateApplyAttempt(): void {
  void tryApplyPendingPwaUpdate(getPwaSafetyState, CURRENT_BUILD_ID)
}

// Явна проверка за нова версия при връщане в сайта — не прилага/reload-ва,
// само моли browser-а да провери /sw.js за промяна (throttled в pwa.ts).
// Ако вече има pending update, опитваме apply веднага след проверката —
// coordinator-ът пак ще прецени safety, така че е безопасно по време на игра.
function requestPwaUpdateCheckAndRetryApply(): void {
  requestPwaUpdateCheck()
  requestPwaUpdateApplyAttempt()
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    requestPwaUpdateCheckAndRetryApply()
    void attemptPendingChatRefresh()
  }
})

window.addEventListener('pageshow', () => {
  requestPwaUpdateCheckAndRetryApply()
  void attemptPendingChatRefresh()
})

window.addEventListener('focus', () => {
  void attemptPendingChatRefresh()
})

void loadPublicSettings()
void loadAuthSession().then(() => {
  if (!_isResetPasswordPath) {
    lobby.navigateInitialPath()
  }
  if (stripeReturnPayment === 'success') {
    void handleStripePaymentSuccessReturn(stripeReturnCheckoutSessionId)
  }
  pwaBootstrapAuthSessionLoaded = true
  requestPwaUpdateApplyAttempt()
})

// Гарантира, че belot_guest_id cookie-то съществува преди WebSocket handshake-а,
// защото сървърът чете guest identity само от cookie-тата на connection request-а.
void loadGuestTrialStatus().finally(() => {
  pwaBootstrapGuestStatusLoaded = true
  requestPwaUpdateApplyAttempt()
  client.connect()
})

// Offline overlay — показва се при реална загуба на интернет връзка
;(function initOfflineOverlay() {
  let overlayEl: HTMLElement | null = null
  let networkMonitorInFlight = false
  let consecutiveNetworkFailures = 0

  function showOfflineOverlay(): void {
    shouldReloadLobbyOnReconnect = true
    if (overlayEl) return
    const el = document.createElement('div')
    el.style.cssText = [
      'position:fixed;inset:0;z-index:99998;',
      'background:#0a0a0a;',
      'color:#f8fafc;',
      'font-family:system-ui,-apple-system,sans-serif;',
      'display:flex;flex-direction:column;align-items:center;justify-content:center;',
      'gap:20px;padding:24px;text-align:center;',
    ].join('')
    el.innerHTML = `
      <div style="font-size:64px;line-height:1;opacity:0.6;">📡</div>
      <h1 style="font-size:22px;font-weight:900;margin:0;">Няма връзка с интернет</h1>
      <p style="font-size:15px;font-weight:600;color:rgba(255,255,255,0.54);max-width:300px;line-height:1.5;margin:0;">
        Белот онлайн изисква активна интернет връзка. Провери свързаността и опитай отново.
      </p>
      <button id="offline-retry-btn" style="
        margin-top:8px;height:48px;padding:0 28px;border:0;border-radius:10px;
        background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);
        color:#080808;font-size:15px;font-weight:900;cursor:pointer;
      ">Опитай отново</button>
    `
    el.querySelector('#offline-retry-btn')?.addEventListener('click', hardReload)
    document.body.appendChild(el)
    overlayEl = el
  }

  showOfflineConnectionOverlay = showOfflineOverlay

  async function checkNetworkHealth(): Promise<void> {
    if (networkMonitorInFlight || offlineLobbyReloadScheduled || isPageUnloading) return
    networkMonitorInFlight = true

    try {
      const response = await fetch(`${getApiBaseUrl()}/health`, {
        method: 'GET',
        cache: 'no-store',
      })

      if (response.ok) {
        consecutiveNetworkFailures = 0
        if (overlayEl !== null && shouldReloadLobbyOnReconnect) {
          forceOfflineLobbyReload()
        }
        return
      }

      consecutiveNetworkFailures += 1
    } catch {
      consecutiveNetworkFailures += 1
    } finally {
      networkMonitorInFlight = false
    }

    if (consecutiveNetworkFailures >= 2) {
      showOfflineOverlay()
    }
  }

  function hardReload(): void {
    forceOfflineLobbyReload()
    // Изчисти navigation кеша на SW за да се вземе свеж index.html от мрежата
  }

  if (!navigator.onLine) showOfflineOverlay()
  window.addEventListener('offline', showOfflineOverlay)
  window.addEventListener('online', hardReload)
  window.setInterval(() => {
    void checkNetworkHealth()
  }, 3000)
})()
}

function showLandingOverlay(): void {
  const overlay = document.createElement('div')
  overlay.id = 'pwa-landing-overlay'
  overlay.style.cssText = [
    'position:fixed;inset:0;z-index:99999;background:#0a0a0a',
    'display:flex;align-items:center;justify-content:center',
    'font-family:system-ui,-apple-system,sans-serif',
    'transition:opacity 0.35s ease',
  ].join(';')

  const isNarrowPortraitLanding =
    window.innerWidth <= 640 &&
    window.innerHeight > window.innerWidth
  const isMobileLanding = isPhoneLayoutViewport() || isNarrowPortraitLanding

  overlay.innerHTML = isMobileLanding ? `
    <section style="
      width:100%;height:100dvh;overflow-y:auto;-webkit-overflow-scrolling:touch;
      background:
        radial-gradient(circle at 50% 0%, rgba(212,165,32,0.18), rgba(0,0,0,0) 34%),
        radial-gradient(circle at 50% 30%, rgba(22,101,52,0.22), rgba(0,0,0,0) 42%),
        #000000;
      color:#ffffff;font-family:Arial, Helvetica, sans-serif;
    ">
      <div style="min-height:100dvh;display:flex;flex-direction:column;">
        <header style="
          height:62px;padding:12px;display:flex;align-items:center;justify-content:space-between;
          border-bottom:1px solid rgba(212,165,32,0.22);
        ">
          <img src="/assets/lobby/logo.png" alt="Pika.bg" style="width:142px;height:38px;display:block;object-fit:contain;">
          <div style="
            height:30px;padding:0 10px;border:1px solid rgba(212,165,32,0.42);border-radius:8px;
            display:flex;align-items:center;color:#d4a520;font-size:11px;font-weight:900;
            letter-spacing:0.08em;text-transform:uppercase;background:#050505;
          ">Белот онлайн</div>
        </header>

        <main style="flex:1;display:flex;flex-direction:column;">
          <section style="padding:18px 12px 12px;text-align:center;display:grid;gap:12px;justify-items:center;">
            <div style="
              color:#d4a520;font-size:12px;font-weight:900;letter-spacing:0.12em;
              text-transform:uppercase;
            ">№1 платформа за белот</div>
            <h1 style="
              margin:0;max-width:330px;color:#ffffff;font-size:34px;line-height:1.04;
              font-weight:900;letter-spacing:0;text-wrap:balance;
            ">Играй Белот Онлайн</h1>
            <p style="
              margin:0;max-width:310px;color:rgba(255,255,255,0.62);
              font-size:14px;line-height:1.45;font-weight:700;
            ">Влез в играта, събери приятели и покажи уменията си на масата.</p>
          </section>

          <section style="position:relative;margin:2px 12px 0;min-height:228px;display:flex;align-items:center;justify-content:center;">
            <div style="
              position:absolute;left:50%;top:52%;width:min(84vw,330px);aspect-ratio:1/0.68;
              transform:translate(-50%,-50%);border:1px solid rgba(212,165,32,0.42);border-radius:8px;
              background:
                radial-gradient(circle at 50% 42%, rgba(212,165,32,0.16), rgba(0,0,0,0) 48%),
                #050505;
              box-shadow:0 18px 50px rgba(0,0,0,0.48);
            "></div>
            <img src="/assets/lobby/hero-cards.png" alt="Белот карти" draggable="false" style="
              position:relative;z-index:1;width:min(94vw,390px);height:auto;display:block;object-fit:contain;
              filter:drop-shadow(0 18px 28px rgba(0,0,0,0.55));
            ">
          </section>

          <section style="margin:8px 12px 0;display:grid;grid-template-columns:1fr 1fr;gap:8px;">
            <article style="border:1px solid rgba(212,165,32,0.38);border-radius:8px;background:#080808;padding:11px;min-height:82px;">
              <img src="/assets/lobby/icon-users.png" alt="" style="width:30px;height:30px;object-fit:contain;display:block;margin-bottom:8px;">
              <div style="color:#ffffff;font-size:14px;font-weight:900;">Общество</div>
              <div style="margin-top:4px;color:rgba(255,255,255,0.48);font-size:12px;line-height:1.25;font-weight:700;">Активни играчи и приятелска среда.</div>
            </article>
            <article style="border:1px solid rgba(212,165,32,0.38);border-radius:8px;background:#080808;padding:11px;min-height:82px;">
              <img src="/assets/lobby/icon-daily-rewards.png" alt="" style="width:30px;height:30px;object-fit:contain;display:block;margin-bottom:8px;">
              <div style="color:#ffffff;font-size:14px;font-weight:900;">Награди</div>
              <div style="margin-top:4px;color:rgba(255,255,255,0.48);font-size:12px;line-height:1.25;font-weight:700;">Бонуси, мисии и класации всеки ден.</div>
            </article>
            <article style="border:1px solid rgba(212,165,32,0.38);border-radius:8px;background:#080808;padding:11px;min-height:82px;">
              <img src="/assets/lobby/icon-fair-play.png" alt="" style="width:30px;height:30px;object-fit:contain;display:block;margin-bottom:8px;">
              <div style="color:#ffffff;font-size:14px;font-weight:900;">Честна игра</div>
              <div style="margin-top:4px;color:rgba(255,255,255,0.48);font-size:12px;line-height:1.25;font-weight:700;">Сигурна и коректна маса за всички.</div>
            </article>
            <article style="border:1px solid rgba(212,165,32,0.38);border-radius:8px;background:#080808;padding:11px;min-height:82px;">
              <img src="/assets/lobby/icon-quick-game.png" alt="" style="width:30px;height:30px;object-fit:contain;display:block;margin-bottom:8px;">
              <div style="color:#ffffff;font-size:14px;font-weight:900;">Бърза игра</div>
              <div style="margin-top:4px;color:rgba(255,255,255,0.48);font-size:12px;line-height:1.25;font-weight:700;">Влизаш и сядаш на маса за секунди.</div>
            </article>
          </section>

          <div style="
            position:sticky;bottom:0;margin-top:auto;padding:14px 12px 12px;
            background:linear-gradient(180deg, rgba(0,0,0,0), #000000 28%);
          ">
            <button id="pwa-install-btn" class="pwa-cta-glow" style="
              width:100%;height:50px;border:0;border-radius:8px;
              background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);
              color:#080808;font-size:15px;font-weight:900;cursor:pointer;
              box-shadow:0 8px 26px rgba(212,165,32,0.32);
              letter-spacing:0.01em;white-space:nowrap;
            ">Играй Белот Сега</button>
          </div>
        </main>
      </div>
    </section>
  ` : `
    <div style="position:relative;width:min(100vw,calc(100vh * (1672/941)));aspect-ratio:1672/941;">
      <img src="/assets/landing-page/landing-page.webp" style="width:100%;height:100%;display:block;">
      <div style="position:absolute;left:22%;top:63%;transform:translate(-50%,-50%);display:flex;flex-direction:column;align-items:center;">
        <div style="
          margin-bottom:2.8%;
          font-size:1.5vw;font-weight:400;
          color:rgba(255,255,255,0.82);
          text-align:center;
          text-shadow:0 2px 8px rgba(0,0,0,0.8);
          max-width:30vw;line-height:1.5;
        ">Влез в играта и изпробвай уменията си срещу най-добрите.</div>
        <button id="pwa-install-btn" style="
          height:3.6vw;padding:0 4vw;border:0;border-radius:0.8vw;
          background:linear-gradient(180deg,#f4c95b 0%,#c98f13 100%);
          color:#080808;font-size:1.5vw;font-weight:900;cursor:pointer;
          box-shadow:0 6px 32px rgba(212,165,32,0.45);
          letter-spacing:0.01em;white-space:nowrap;
        ">Играй Белот Сега</button>
      </div>
    </div>
  `

  document.body.style.overflow = 'hidden'
  document.body.appendChild(overlay)

  const btn = overlay.querySelector<HTMLButtonElement>('#pwa-install-btn')!

  btn.addEventListener('mouseenter', () => {
    btn.style.filter = 'brightness(1.15)'
    btn.style.transform = 'translateY(-2px)'
    btn.style.boxShadow = '0 10px 40px rgba(212,165,32,0.65)'
  })
  btn.addEventListener('mouseleave', () => {
    btn.style.filter = ''
    btn.style.transform = ''
    btn.style.boxShadow = '0 6px 32px rgba(212,165,32,0.45)'
  })

  function dismissOverlay(): void {
    document.body.style.overflow = ''
    overlay.style.opacity = '0'
    setTimeout(() => {
      overlay.remove()
      history.replaceState(null, '', '/lobby')
    }, 360)
  }

  btn.addEventListener('click', async () => {
    if (canInstallPwa()) {
      btn.disabled = true
      btn.textContent = 'Инсталиране...'
      const outcome = await triggerPwaInstall()
      if (outcome === 'accepted') {
        dismissOverlay()
      } else {
        btn.disabled = false
        btn.textContent = 'Играй Белот Сега'
        dismissOverlay()
      }
    } else {
      dismissOverlay()
    }
  })
}
